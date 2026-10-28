import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now, sha256 } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** o que as rotinas leem (Office, NF-e em XML, extrato OFX, transcrições) e produzem (apresentação) */
const ALLOWED_MIME = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  DOCX, XLSX, PPTX, 'application/xml', 'text/xml', 'application/x-ofx', 'text/vtt']);
/** Tipo pela extensão quando o navegador manda um tipo genérico (o Windows envia CSV como "application/vnd.ms-excel"). */
const BY_EXT: Record<string, string> = { csv: 'text/csv', md: 'text/markdown', txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  docx: DOCX, xlsx: XLSX, pptx: PPTX, xml: 'application/xml', ofx: 'application/x-ofx', vtt: 'text/vtt', srt: 'text/plain' };
const GENERIC = new Set(['', 'application/octet-stream', 'application/vnd.ms-excel', 'text/comma-separated-values', 'application/csv', 'text/x-csv', 'text/x-markdown', 'application/zip', 'application/x-zip-compressed', 'application/x-subrip']);

/** Nome exibido: sem separadores de caminho, controles ou nomes reservados. Nunca usado como caminho. */
export function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim();
  return (base || 'arquivo').slice(0, 120);
}

/** Caminho físico derivado só de IDs do servidor e confinado ao diretório do workspace. */
function storagePath(filesDir: string, workspaceId: string, storageKey: string): string {
  if (!/^ws_[a-f0-9]{32}$/.test(workspaceId) || !/^art_[a-f0-9]{32}$/.test(storageKey)) throw new HttpError(400, 'path', 'caminho inválido');
  const root = path.resolve(filesDir, workspaceId);
  const p = path.resolve(root, storageKey);
  if (!p.startsWith(root + path.sep)) throw new HttpError(400, 'path', 'caminho inválido');
  return p;
}

const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

/**
 * Guarda um arquivo cifrado. `maxBytes`: limite por arquivo. `quotaBytes`: total do workspace (só na nuvem,
 * conforme o plano; 0 = sem limite — no local o total é o disco do usuário).
 */
export function saveArtifact(db: Db, bus: Bus, filesDir: string, maxBytes: number, workspaceId: string, userId: string,
  input: { filename: string; mime: string; data: Buffer; taskId?: string | null; source?: { kind: 'routine' | 'operation'; id: string } }, quotaBytes = 0) {
  const declared = input.mime.split(';')[0].trim().toLowerCase();
  const ext = input.filename.toLowerCase().match(/.([a-z0-9]{1,5})$/)?.[1] ?? '';
  const mime = !ALLOWED_MIME.has(declared) && GENERIC.has(declared) && BY_EXT[ext] ? BY_EXT[ext] : declared;
  if (!ALLOWED_MIME.has(mime)) throw new HttpError(415, 'mime', 'tipo de arquivo não permitido no MVP');
  if (input.data.length === 0) throw new HttpError(400, 'empty', 'O arquivo está vazio.');
  if (input.data.length > maxBytes) throw new HttpError(413, 'size', `O arquivo tem ${mb(input.data.length)}; o limite é ${mb(maxBytes)} por arquivo.`);
  if (quotaBytes > 0) {
    const used = Number(db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM artifacts WHERE workspace_id = ?', workspaceId)?.n ?? 0);
    if (used + input.data.length > quotaBytes) throw new HttpError(413, 'storage_plan', `O espaço do seu plano (${mb(quotaBytes)}) acabou: apague arquivos ou mude de plano.`);
  }
  if (input.taskId) {
    const t = db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND workspace_id = ?', input.taskId, workspaceId);
    if (!t) throw notFound('tarefa');
  }
  const artId = id('art');
  const file = storagePath(filesDir, workspaceId, artId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // cifrado com a chave do workspace (o nome lógico entra no contexto: um arquivo não se passa por outro)
  fs.writeFileSync(file, db.fieldCipher ? db.fieldCipher.sealBytes(workspaceId, input.data, artId) : input.data, { flag: 'wx', mode: 0o600 });
  const filename = safeFilename(input.filename);
  try {
    db.run(
      `INSERT INTO artifacts (id, workspace_id, owner_user_id, task_id, filename, mime, size, sha256, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      artId, workspaceId, userId, input.taskId ?? null, filename, mime, input.data.length, sha256(input.data), artId, now());
    // anexado a um card: é entrada dele (o que os agentes podem processar)
    if (input.taskId) db.run("INSERT OR IGNORE INTO task_artifacts (workspace_id, task_id, artifact_id, role, created_at) VALUES (?, ?, ?, 'entrada', ?)", workspaceId, input.taskId, artId, now());
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  // entregável de rotina ou de operação: quem gravou foi o Ergon, não o usuário
  audit(db, bus, input.source
    ? { workspaceId, actorType: 'system', actorId: `${input.source.kind === 'routine' ? 'rotina' : 'operacao'}:${input.source.id}`, action: input.source.kind === 'routine' ? 'artifact.routine' : 'artifact.deliverable', targetType: 'artifact', targetId: artId, evidence: { filename, mime, size: input.data.length }, result: 'ok' }
    : { workspaceId, actorType: 'user', actorId: userId, action: 'artifact.upload', targetType: 'artifact', targetId: artId, evidence: { filename, mime, size: input.data.length }, result: 'ok' });
  bus.publish(workspaceId, 'artifacts.changed', { id: artId });
  return { id: artId, filename, mime, size: input.data.length };
}

export function listArtifacts(db: Db, workspaceId: string) {
  return db.all('SELECT id, filename, mime, size, task_id, owner_user_id, created_at FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200', workspaceId);
}

export function openArtifact(db: Db, filesDir: string, workspaceId: string, artifactId: string) {
  // ownership: o ID sozinho não basta, precisa pertencer ao workspace da sessão
  const a = db.get<{ id: string; filename: string; mime: string; size: number; storage_key: string }>(
    'SELECT id, filename, mime, size, storage_key FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, workspaceId);
  if (!a) throw notFound('arquivo');
  const file = storagePath(filesDir, workspaceId, a.storage_key);
  if (!fs.existsSync(file)) throw notFound('arquivo');
  const raw = fs.readFileSync(file);
  return { ...a, data: db.fieldCipher ? db.fieldCipher.openBytes(raw, a.storage_key) : raw };
}

/** Remove um arquivo que o próprio Ergon acabou de gravar e não chegou a entregar (operação que falhou no meio). */
export function removeArtifact(db: Db, filesDir: string, workspaceId: string, artifactId: string): void {
  const art = db.get<{ storage_key: string }>('SELECT storage_key FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, workspaceId);
  if (!art) return;
  db.run('DELETE FROM task_artifacts WHERE artifact_id = ? AND workspace_id = ?', artifactId, workspaceId);
  db.run('DELETE FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, workspaceId);
  fs.rmSync(storagePath(filesDir, workspaceId, art.storage_key), { force: true });
}
