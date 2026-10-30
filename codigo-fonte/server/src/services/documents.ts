/**
 * Documentos: os arquivos do workspace em pastas, como num explorador. Tudo cifrado (o arquivo no disco com a chave do
 * workspace; o nome da pasta no banco). Pastas automáticas — Cards (uma por card), Conversas (uma por colega) e
 * Rotinas — recebem sozinhas o que chega por esses caminhos; mover um arquivo não quebra o card nem a conversa de
 * onde ele veio. A lixeira guarda até a pessoa restaurar ou esvaziar (só ela esvazia). A coordenação organiza pela
 * conversa ([[pasta]], [[mover-arquivo]], [[renomear-arquivo]], [[renomear-pasta]], [[lixeira]]), sempre com desfazer.
 */
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, notFound, now } from '../lib/util.ts';
import { openArtifact, removeArtifact, safeFilename } from './artifacts.ts';
import { audit, type Bus } from './bus.ts';
import { readDocument } from './doc-isolated.ts';

export interface FolderRow { id: string; parent_id: string | null; name: string; system_key: string | null; created_at: string; deleted_at: string | null }
export interface FileRow { id: string; filename: string; mime: string; size: number; created_at: string; folder_id: string | null; task_id: string | null; deleted_at: string | null }

const SYSTEM_ROOTS: Record<string, string> = { cards: 'Cards', conversas: 'Conversas', rotinas: 'Rotinas' };
/** lixeira: guarda por este tempo; depois a limpeza apaga de vez */
export const TRASH_DAYS = 30;

function folderName(name: string): string {
  const n = name.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'name', 'dê um nome à pasta');
  return n.slice(0, 80);
}

export function folders(db: Db, workspaceId: string, opts: { trash?: boolean } = {}): FolderRow[] {
  return db.all<FolderRow>(`SELECT id, parent_id, name, system_key, created_at, deleted_at FROM folders WHERE workspace_id = ? AND deleted_at IS ${opts.trash ? 'NOT ' : ''}NULL ORDER BY created_at, id`, workspaceId);
}

function folderOf(db: Db, workspaceId: string, folderId: string): FolderRow {
  const f = db.get<FolderRow>('SELECT id, parent_id, name, system_key, created_at, deleted_at FROM folders WHERE id = ? AND workspace_id = ?', folderId, workspaceId);
  if (!f) throw notFound('pasta');
  return f;
}

/** Pasta automática (cria se faltar). */
export function systemFolder(db: Db, workspaceId: string, key: string, name: string, parentKey?: string): string {
  const cur = db.get<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM folders WHERE workspace_id = ? AND system_key = ?', workspaceId, key);
  if (cur) { if (cur.deleted_at) db.run('UPDATE folders SET deleted_at = NULL WHERE id = ?', cur.id); return cur.id; }
  const parent = parentKey ? systemFolder(db, workspaceId, parentKey, SYSTEM_ROOTS[parentKey] ?? parentKey) : null;
  const fid = id('fld');
  db.run('INSERT INTO folders (id, workspace_id, parent_id, name, system_key, created_at) VALUES (?, ?, ?, ?, ?, ?)', fid, workspaceId, parent, db.seal(workspaceId, folderName(name)), key, now());
  return fid;
}

export function folderForConversation(db: Db, workspaceId: string, conversationId: string): string | null {
  const a = db.get<{ id: string; name: string }>('SELECT a.id, a.name FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = ? AND c.workspace_id = ?', conversationId, workspaceId);
  return a ? systemFolder(db, workspaceId, `agente:${a.id}`, a.name, 'conversas') : null;
}
export function folderForTask(db: Db, workspaceId: string, taskId: string): string | null {
  const t = db.get<{ number: number; title: string }>('SELECT number, title FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
  return t ? systemFolder(db, workspaceId, `card:${taskId}`, `#${t.number} ${clip(t.title, 60)}`, 'cards') : null;
}

/**
 * Arquivos de antes das pastas (ou gravados por outro caminho) ganham lugar: o do card, o da conversa ou a raiz.
 * Idempotente e barato (só os sem pasta).
 */
export function adoptLoose(db: Db, workspaceId: string): void {
  const loose = db.all<{ id: string; task_id: string | null }>('SELECT id, task_id FROM artifacts WHERE workspace_id = ? AND folder_id IS NULL AND deleted_at IS NULL LIMIT 500', workspaceId);
  for (const a of loose) {
    const task = a.task_id ?? db.get<{ task_id: string }>('SELECT task_id FROM task_artifacts WHERE artifact_id = ? AND workspace_id = ? ORDER BY created_at LIMIT 1', a.id, workspaceId)?.task_id ?? null;
    const conv = task ? null : db.get<{ conversation_id: string }>('SELECT m.conversation_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.artifact_id = ? LIMIT 1', a.id)?.conversation_id ?? null;
    const routine = task || conv ? null : !!db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND target_id = ? AND action = 'artifact.routine' LIMIT 1", workspaceId, a.id);
    const target = task ? folderForTask(db, workspaceId, task) : conv ? folderForConversation(db, workspaceId, conv) : routine ? systemFolder(db, workspaceId, 'rotinas', 'Rotinas') : null;
    // sem lugar: raiz (folder_id fica vazio, mas marcado como visto com a raiz '')
    db.run('UPDATE artifacts SET folder_id = ? WHERE id = ?', target ?? '', a.id);
  }
}

const isRoot = (f: string | null | undefined) => !f || f === 'root';

/** O conteúdo de uma pasta (ou da raiz, ou da lixeira), com o caminho até ela. */
export function listFolder(db: Db, workspaceId: string, folder: string | null) {
  adoptLoose(db, workspaceId);
  const all = folders(db, workspaceId);
  if (folder === 'trash') {
    const tf = folders(db, workspaceId, { trash: true });
    const files = db.all<FileRow>('SELECT id, filename, mime, size, created_at, folder_id, task_id, deleted_at FROM artifacts WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500', workspaceId);
    return { folder: { id: 'trash', name: 'Lixeira', system_key: null }, path: [], folders: tf.filter((f) => !tf.some((p) => p.id === f.parent_id)), files, trashDays: TRASH_DAYS };
  }
  const cur = isRoot(folder) ? null : all.find((f) => f.id === folder) ?? null;
  if (!isRoot(folder) && !cur) throw notFound('pasta');
  const path: Array<{ id: string; name: string }> = [];
  for (let p = cur; p; p = all.find((x) => x.id === p!.parent_id) ?? null) path.unshift({ id: p.id, name: p.name });
  const children = all.filter((f) => (cur ? f.parent_id === cur.id : !f.parent_id));
  const files = db.all<FileRow>(
    `SELECT id, filename, mime, size, created_at, folder_id, task_id, deleted_at FROM artifacts WHERE workspace_id = ? AND deleted_at IS NULL AND ${cur ? 'folder_id = ?' : "(folder_id IS NULL OR folder_id = '')"} ORDER BY created_at DESC LIMIT 1000`,
    ...(cur ? [workspaceId, cur.id] : [workspaceId]));
  const count = (fid: string) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ? AND folder_id = ? AND deleted_at IS NULL', workspaceId, fid)?.n ?? 0)
    + all.filter((x) => x.parent_id === fid).length;
  return { folder: cur ? { id: cur.id, name: cur.name, system_key: cur.system_key } : { id: 'root', name: 'Documentos', system_key: null }, path,
    folders: children.map((f) => ({ ...f, items: count(f.id) })), files };
}

export function tree(db: Db, workspaceId: string) {
  adoptLoose(db, workspaceId);
  return folders(db, workspaceId).map(({ id: fid, parent_id, name, system_key }) => ({ id: fid, parent_id, name, system_key }));
}

export function searchFiles(db: Db, workspaceId: string, q: string) {
  const term = fold(q.trim());
  if (term.length < 2) return [];
  const all = folders(db, workspaceId);
  const pathOf = (fid: string | null) => { const names: string[] = []; for (let p = all.find((x) => x.id === fid); p; p = all.find((x) => x.id === p!.parent_id)) names.unshift(p.name); return names.join(' / '); };
  return db.all<FileRow>('SELECT id, filename, mime, size, created_at, folder_id, task_id, deleted_at FROM artifacts WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3000', workspaceId)
    .filter((f) => fold(f.filename).includes(term)).slice(0, 100).map((f) => ({ ...f, path: pathOf(f.folder_id) }));
}

/** Caminho "Clientes/ACME" → pasta (cria as que faltam se `create`). */
export function folderByPath(db: Db, workspaceId: string, pathText: string, create: boolean): string | null {
  const parts = pathText.split('/').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let parent: string | null = null;
  for (const raw of parts) {
    const name = folderName(raw);
    const all = folders(db, workspaceId);
    const hit = all.find((f) => (f.parent_id ?? null) === parent && fold(f.name) === fold(name));
    if (hit) { parent = hit.id; continue; }
    if (!create) return null;
    const fid = id('fld');
    db.run('INSERT INTO folders (id, workspace_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)', fid, workspaceId, parent, db.seal(workspaceId, name), now());
    parent = fid;
  }
  return parent;
}

function assertNotInside(db: Db, workspaceId: string, folderId: string, target: string | null): void {
  for (let p: string | null = target; p; p = db.get<{ parent_id: string | null }>('SELECT parent_id FROM folders WHERE id = ? AND workspace_id = ?', p, workspaceId)?.parent_id ?? null) {
    if (p === folderId) throw new HttpError(409, 'cycle', 'não dá para pôr uma pasta dentro dela mesma');
  }
}

export interface DocActor { type: 'user' | 'agent'; id: string }
const actorOf = (a: DocActor) => ({ actorType: a.type, actorId: a.id });

/** Registro com o "antes" (para desfazer). Devolve o id do registro. */
function logOp(db: Db, bus: Bus, workspaceId: string, actor: DocActor, op: string, target: string, evidence: Record<string, unknown>, result: string): string {
  const aud = audit(db, bus, { workspaceId, ...actorOf(actor), action: `documents.${op}`, targetType: op.startsWith('folder') ? 'folder' : 'artifact', targetId: target, evidence, result });
  bus.publish(workspaceId, 'artifacts.changed', {});
  return aud;
}

export function createFolder(db: Db, bus: Bus, workspaceId: string, actor: DocActor, name: string, parentId: string | null) {
  const parent = isRoot(parentId) ? null : folderOf(db, workspaceId, parentId!).id;
  const n = folderName(name);
  if (folders(db, workspaceId).some((f) => (f.parent_id ?? null) === parent && fold(f.name) === fold(n))) throw new HttpError(409, 'exists', 'já existe uma pasta com esse nome aqui');
  const fid = id('fld');
  db.run('INSERT INTO folders (id, workspace_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)', fid, workspaceId, parent, db.seal(workspaceId, n), now());
  const undo = logOp(db, bus, workspaceId, actor, 'folder.create', fid, { op: 'folder.create', folderId: fid }, `pasta “${n}” criada`);
  return { id: fid, name: n, undo };
}

export function updateFolder(db: Db, bus: Bus, workspaceId: string, actor: DocActor, folderId: string, ch: { name?: string; parentId?: string | null }) {
  const f = folderOf(db, workspaceId, folderId);
  if (f.system_key && (ch.name !== undefined || ch.parentId !== undefined) && SYSTEM_ROOTS[f.system_key]) throw new HttpError(409, 'system', 'as pastas automáticas ficam onde estão');
  const before = { name: f.name, parentId: f.parent_id };
  if (ch.name !== undefined) db.run('UPDATE folders SET name = ? WHERE id = ?', db.seal(workspaceId, folderName(ch.name)), f.id);
  if (ch.parentId !== undefined) {
    const target = isRoot(ch.parentId) ? null : folderOf(db, workspaceId, ch.parentId!).id;
    assertNotInside(db, workspaceId, f.id, target);
    db.run('UPDATE folders SET parent_id = ? WHERE id = ?', target, f.id);
  }
  const undo = logOp(db, bus, workspaceId, actor, 'folder.update', f.id, { op: 'folder.update', folderId: f.id, before }, `pasta “${ch.name ?? f.name}” ${ch.parentId !== undefined ? 'movida' : 'renomeada'}`);
  return { ok: true, undo };
}

export function updateFile(db: Db, bus: Bus, workspaceId: string, actor: DocActor, artifactId: string, ch: { filename?: string; folderId?: string | null }) {
  const a = db.get<FileRow>('SELECT id, filename, mime, size, created_at, folder_id, task_id, deleted_at FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, workspaceId);
  if (!a) throw notFound('arquivo');
  const before = { filename: a.filename, folderId: a.folder_id };
  if (ch.filename !== undefined) {
    // a extensão fica (renomear não muda o tipo do arquivo)
    const ext = a.filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? '';
    let next = safeFilename(ch.filename);
    if (ext && !next.toLowerCase().endsWith(ext.toLowerCase())) next = safeFilename(`${next}${ext}`);
    db.run('UPDATE artifacts SET filename = ? WHERE id = ?', next, a.id);
  }
  if (ch.folderId !== undefined) db.run('UPDATE artifacts SET folder_id = ? WHERE id = ?', isRoot(ch.folderId) ? '' : folderOf(db, workspaceId, ch.folderId!).id, a.id);
  const undo = logOp(db, bus, workspaceId, actor, 'file.update', a.id, { op: 'file.update', artifactId: a.id, before }, `arquivo “${a.filename}” ${ch.folderId !== undefined ? 'movido' : 'renomeado'}`);
  return { ok: true, undo };
}

/** Para a lixeira (arquivo ou pasta com tudo dentro); restaurar devolve. */
export function trash(db: Db, bus: Bus, workspaceId: string, actor: DocActor, target: { artifactId?: string; folderId?: string }) {
  const t = now();
  if (target.artifactId) {
    const a = db.get<{ id: string; filename: string }>('SELECT id, filename FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', target.artifactId, workspaceId);
    if (!a) throw notFound('arquivo');
    db.run('UPDATE artifacts SET deleted_at = ? WHERE id = ?', t, a.id);
    return { ok: true, undo: logOp(db, bus, workspaceId, actor, 'file.trash', a.id, { op: 'file.trash', artifactId: a.id, at: t }, `“${a.filename}” na lixeira`) };
  }
  const f = folderOf(db, workspaceId, target.folderId!);
  if (f.system_key && SYSTEM_ROOTS[f.system_key]) throw new HttpError(409, 'system', 'as pastas automáticas não vão para a lixeira');
  const all = folders(db, workspaceId);
  const ids = [f.id];
  for (let i = 0; i < ids.length; i++) for (const c of all.filter((x) => x.parent_id === ids[i])) ids.push(c.id);
  for (const fid of ids) {
    db.run('UPDATE folders SET deleted_at = ? WHERE id = ?', t, fid);
    db.run('UPDATE artifacts SET deleted_at = ? WHERE folder_id = ? AND workspace_id = ? AND deleted_at IS NULL', t, fid, workspaceId);
  }
  return { ok: true, undo: logOp(db, bus, workspaceId, actor, 'folder.trash', f.id, { op: 'folder.trash', folderId: f.id, at: t }, `pasta “${f.name}” na lixeira`) };
}

export function restore(db: Db, bus: Bus, workspaceId: string, actor: DocActor, target: { artifactId?: string; folderId?: string }) {
  if (target.artifactId) {
    const a = db.get<{ id: string; filename: string; folder_id: string | null }>('SELECT id, filename, folder_id FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL', target.artifactId, workspaceId);
    if (!a) throw notFound('arquivo na lixeira');
    // a pasta de antes sumiu: volta para a raiz
    const home = a.folder_id && db.get('SELECT 1 AS x FROM folders WHERE id = ? AND deleted_at IS NULL', a.folder_id) ? a.folder_id : '';
    db.run('UPDATE artifacts SET deleted_at = NULL, folder_id = ? WHERE id = ?', home, a.id);
    logOp(db, bus, workspaceId, actor, 'file.restore', a.id, { op: 'file.restore', artifactId: a.id }, `“${a.filename}” restaurado`);
    return { ok: true };
  }
  const f = db.get<FolderRow>('SELECT id, parent_id, name, system_key, created_at, deleted_at FROM folders WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL', target.folderId ?? '', workspaceId);
  if (!f) throw notFound('pasta na lixeira');
  const at = f.deleted_at!;
  // tudo que foi para a lixeira junto com ela volta junto
  const ids = db.all<{ id: string }>('SELECT id FROM folders WHERE workspace_id = ? AND deleted_at = ?', workspaceId, at).map((x) => x.id);
  for (const fid of ids) db.run('UPDATE folders SET deleted_at = NULL WHERE id = ?', fid);
  db.run('UPDATE artifacts SET deleted_at = NULL WHERE workspace_id = ? AND deleted_at = ?', workspaceId, at);
  if (f.parent_id && !db.get('SELECT 1 AS x FROM folders WHERE id = ? AND deleted_at IS NULL', f.parent_id)) db.run('UPDATE folders SET parent_id = NULL WHERE id = ?', f.id);
  logOp(db, bus, workspaceId, actor, 'folder.restore', f.id, { op: 'folder.restore', folderId: f.id }, `pasta “${f.name}” restaurada`);
  return { ok: true };
}

/** Esvazia a lixeira de vez (só a pessoa, com confirmação na tela). `olderThanDays`: a limpeza automática. */
export function emptyTrash(db: Db, bus: Bus, cfg: Pick<Config, 'filesDir'>, workspaceId: string, userId: string | null, olderThanDays = 0): number {
  const limit = new Date(Date.now() - olderThanDays * 86400_000).toISOString();
  const gone = db.all<{ id: string }>('SELECT id FROM artifacts WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?', workspaceId, limit);
  for (const a of gone) removeArtifact(db, cfg.filesDir, workspaceId, a.id);
  db.run('DELETE FROM folders WHERE workspace_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?', workspaceId, limit);
  if (gone.length || userId) {
    audit(db, bus, { workspaceId, actorType: userId ? 'user' : 'system', actorId: userId ?? 'ergon', action: 'documents.trash.empty', evidence: { files: gone.length, olderThanDays }, result: `${gone.length} arquivo(s) apagado(s) de vez` });
    bus.publish(workspaceId, 'artifacts.changed', {});
  }
  return gone.length;
}

/** Desfaz uma ação de Documentos (o registro guarda o "antes"). */
export function undo(db: Db, bus: Bus, workspaceId: string, actor: DocActor, auditId: string) {
  const row = db.get<{ action: string; evidence: string | null }>("SELECT action, evidence FROM audit_events WHERE id = ? AND workspace_id = ? AND action LIKE 'documents.%'", auditId, workspaceId);
  if (!row) throw notFound('ação');
  let ev: { op?: string; folderId?: string; artifactId?: string; before?: { name?: string; parentId?: string | null; filename?: string; folderId?: string | null } } = {};
  try { ev = JSON.parse(row.evidence ?? '{}'); } catch { /* sem o "antes": não dá para desfazer */ }
  switch (ev.op) {
    case 'folder.create': {
      const f = folderOf(db, workspaceId, ev.folderId!);
      if (db.get('SELECT 1 AS x FROM artifacts WHERE folder_id = ? AND deleted_at IS NULL', f.id) || db.get('SELECT 1 AS x FROM folders WHERE parent_id = ? AND deleted_at IS NULL', f.id)) {
        return trash(db, bus, workspaceId, actor, { folderId: f.id });
      }
      db.run('DELETE FROM folders WHERE id = ?', f.id);
      bus.publish(workspaceId, 'artifacts.changed', {});
      return { ok: true };
    }
    case 'folder.update': {
      const f = folderOf(db, workspaceId, ev.folderId!);
      if (ev.before?.name) db.run('UPDATE folders SET name = ? WHERE id = ?', db.seal(workspaceId, ev.before.name), f.id);
      db.run('UPDATE folders SET parent_id = ? WHERE id = ?', ev.before?.parentId ?? null, f.id);
      bus.publish(workspaceId, 'artifacts.changed', {});
      return { ok: true };
    }
    case 'file.update': {
      db.run('UPDATE artifacts SET filename = ?, folder_id = ? WHERE id = ? AND workspace_id = ?', ev.before?.filename ?? '', ev.before?.folderId ?? '', ev.artifactId ?? '', workspaceId);
      bus.publish(workspaceId, 'artifacts.changed', {});
      return { ok: true };
    }
    case 'file.trash': return restore(db, bus, workspaceId, actor, { artifactId: ev.artifactId });
    case 'folder.trash': return restore(db, bus, workspaceId, actor, { folderId: ev.folderId });
    default: throw new HttpError(409, 'undo', 'essa ação não pode ser desfeita');
  }
}

/** Prévia de um documento (texto e primeiras linhas das planilhas). Imagem e PDF a tela mostra direto. */
export async function preview(db: Db, cfg: Pick<Config, 'filesDir'>, workspaceId: string, artifactId: string) {
  const f = openArtifact(db, cfg.filesDir, workspaceId, artifactId);
  if (f.mime.startsWith('image/') || f.mime === 'application/pdf') return { kind: 'inline', mime: f.mime };
  if (f.data.subarray(0, 8192).includes(0) && !/officedocument/.test(f.mime)) return { kind: 'none', mime: f.mime };
  const d = await readDocument(f.filename, f.mime, f.data);
  if (d.status !== 'ok') return { kind: 'none', mime: f.mime, detail: d.detail ?? null };
  return { kind: d.sheets?.length ? 'sheet' : 'text', mime: f.mime, text: clip(d.text, 40_000), pages: d.pages ?? null,
    sheets: (d.sheets ?? []).slice(0, 4).map((s) => ({ name: s.name, rows: s.rows.slice(0, 60).map((r) => r.slice(0, 20).map((c) => clip(c, 200))) })) };
}

// Organização pela coordenação ----------------------------------------------------------------------------------------

const attr = (body: string, k: string) => body.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]?.trim() ?? '';
const TAG = /\[\[\s*(pasta|mover-arquivo|renomear-arquivo|renomear-pasta|lixeira)\b((?:[^\]]|\](?!\]))*)\]\]/gi;

export interface DocCommand { op: 'pasta' | 'mover-arquivo' | 'renomear-arquivo' | 'renomear-pasta' | 'lixeira'; caminho: string; arquivo: string; para: string; nome: string; pasta: string }

export function parseDocCommands(text: string | null): DocCommand[] {
  return [...(text ?? '').matchAll(TAG)].slice(0, 30).map((m) => ({
    op: m[1].toLowerCase() as DocCommand['op'], caminho: attr(m[2], 'caminho'), arquivo: attr(m[2], 'arquivo'), para: attr(m[2], 'para'), nome: attr(m[2], 'nome'), pasta: attr(m[2], 'pasta'),
  }));
}

/** O arquivo citado pelo nome (o mais recente com esse nome) ou pelo id. */
function fileByName(db: Db, workspaceId: string, name: string): { id: string; filename: string } | null {
  if (/^art_[a-f0-9]{32}$/.test(name)) return db.get('SELECT id, filename FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', name, workspaceId) ?? null;
  const n = fold(name);
  const all = db.all<{ id: string; filename: string }>('SELECT id, filename FROM artifacts WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3000', workspaceId);
  return all.find((a) => fold(a.filename) === n) ?? all.find((a) => fold(a.filename.replace(/\.[^.]+$/, '')) === n) ?? all.find((a) => fold(a.filename).includes(n)) ?? null;
}

/** Aplica o que a coordenação pediu; devolve as linhas para a conversa (cada uma com o desfazer). */
export function applyDocCommands(db: Db, bus: Bus, workspaceId: string, agentId: string, cmds: DocCommand[]): Array<{ text: string; undo: string | null }> {
  const actor: DocActor = { type: 'agent', id: agentId };
  const out: Array<{ text: string; undo: string | null }> = [];
  for (const c of cmds) {
    try {
      if (c.op === 'pasta') {
        const p = c.caminho || c.nome || c.pasta;
        const before = folderByPath(db, workspaceId, p, false);
        if (before) { out.push({ text: `A pasta “${p}” já existia.`, undo: null }); continue; }
        const parts = p.split('/').map((x) => x.trim()).filter(Boolean);
        const parent = parts.length > 1 ? folderByPath(db, workspaceId, parts.slice(0, -1).join('/'), true) : null;
        const r = createFolder(db, bus, workspaceId, actor, parts[parts.length - 1] ?? p, parent);
        out.push({ text: `Pasta “${p}” criada em Documentos.`, undo: r.undo });
      } else if (c.op === 'mover-arquivo') {
        const f = fileByName(db, workspaceId, c.arquivo);
        if (!f) { out.push({ text: `Não achei o arquivo “${c.arquivo}” em Documentos.`, undo: null }); continue; }
        const to = c.para ? folderByPath(db, workspaceId, c.para, true) : null;
        const r = updateFile(db, bus, workspaceId, actor, f.id, { folderId: to });
        out.push({ text: `“${f.filename}” movido para ${c.para ? `“${c.para}”` : 'a raiz de Documentos'}.`, undo: r.undo });
      } else if (c.op === 'renomear-arquivo') {
        const f = fileByName(db, workspaceId, c.arquivo);
        if (!f || !c.nome) { out.push({ text: `Não achei o arquivo “${c.arquivo}” para renomear.`, undo: null }); continue; }
        const r = updateFile(db, bus, workspaceId, actor, f.id, { filename: c.nome });
        out.push({ text: `“${f.filename}” agora se chama “${c.nome}”.`, undo: r.undo });
      } else if (c.op === 'renomear-pasta') {
        const fid = folderByPath(db, workspaceId, c.pasta || c.caminho, false);
        if (!fid || !c.nome) { out.push({ text: `Não achei a pasta “${c.pasta || c.caminho}” para renomear.`, undo: null }); continue; }
        const r = updateFolder(db, bus, workspaceId, actor, fid, { name: c.nome });
        out.push({ text: `Pasta “${c.pasta || c.caminho}” agora se chama “${c.nome}”.`, undo: r.undo });
      } else if (c.op === 'lixeira') {
        if (c.arquivo) {
          const f = fileByName(db, workspaceId, c.arquivo);
          if (!f) { out.push({ text: `Não achei o arquivo “${c.arquivo}”.`, undo: null }); continue; }
          const r = trash(db, bus, workspaceId, actor, { artifactId: f.id });
          out.push({ text: `“${f.filename}” foi para a lixeira (dá para restaurar).`, undo: r.undo });
        } else {
          const fid = folderByPath(db, workspaceId, c.pasta || c.caminho, false);
          if (!fid) { out.push({ text: `Não achei a pasta “${c.pasta || c.caminho}”.`, undo: null }); continue; }
          const r = trash(db, bus, workspaceId, actor, { folderId: fid });
          out.push({ text: `Pasta “${c.pasta || c.caminho}” foi para a lixeira com o que tinha dentro (dá para restaurar).`, undo: r.undo });
        }
      }
    } catch (e) { out.push({ text: `Não deu: ${e instanceof Error ? e.message : 'erro'}.`, undo: null }); }
  }
  return out;
}

/** O que a coordenação sabe de Documentos (para organizar conversando). */
export function documentsBrief(db: Db, workspaceId: string): string {
  adoptLoose(db, workspaceId);
  const all = folders(db, workspaceId);
  const pathOf = (f: FolderRow) => { const names: string[] = []; for (let p: FolderRow | undefined = f; p; p = all.find((x) => x.id === p!.parent_id)) names.unshift(p.name); return names.join('/'); };
  const paths = all.filter((f) => !f.system_key?.startsWith('card:')).map(pathOf).sort().slice(0, 80);
  const files = db.all<{ filename: string; folder_id: string | null }>('SELECT filename, folder_id FROM artifacts WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 40', workspaceId);
  const where = (fid: string | null) => { const f = all.find((x) => x.id === fid); return f ? pathOf(f) : '(raiz)'; };
  return [
    'Documentos do workspace (você organiza conversando; aplica na hora e a pessoa pode desfazer):',
    `- criar pasta: [[pasta caminho="Clientes/ACME"]] · mover: [[mover-arquivo arquivo="contrato.pdf" para="Clientes/ACME"]] · renomear: [[renomear-arquivo arquivo="..." nome="..."]] ou [[renomear-pasta pasta="..." nome="..."]] · lixeira: [[lixeira arquivo="..."]] ou [[lixeira pasta="..."]] (nunca apaga de vez).`,
    paths.length ? `Pastas: ${paths.join(' · ')}` : 'Ainda não há pastas criadas pela pessoa.',
    files.length ? `Arquivos recentes: ${files.map((f) => `${clip(f.filename, 80)} (${where(f.folder_id)})`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}
