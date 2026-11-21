/**
 * Entregáveis (rc.42): a identidade do workspace aplicada às entregas (nome, cores, logo, o emblema do Ergon) e os
 * modelos de documento (os originais "ergon" e "abnt" e os criados pela pessoa). O .md continua Markdown padrão; a tela
 * e o PDF (lib/pdf-documento.ts) aplicam o modelo na hora de mostrar.
 *
 * Segurança do logo: só PNG ou JPEG conferidos pelos bytes (assinatura e dimensões do cabeçalho), até 512 KB e 2000 px.
 * SVG nunca é guardado: a tela o desenha num canvas e manda o PNG (o SVG não roda script como imagem, e o servidor não
 * precisa limpar XML). A imagem volta com o tipo certo, nosniff e uma CSP que não deixa nada rodar.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now, sha256 } from '../lib/util.ts';
import { cor, IDENTIDADE_PADRAO, MODELOS_ORIGINAIS, normalizarModelo, type Identidade, type ModeloDoc } from '../../../shared/entregaveis.ts';
import { audit, type Bus } from './bus.ts';
import { openArtifact } from './artifacts.ts';
import { documentoPdf } from '../lib/pdf-documento.ts';
import { chaveDaCerca, pngsDasCercas } from './visuais/png.ts';
import { tituloDoDocumento } from '../../../shared/entregaveis.ts';
import { getSetting, setSetting } from './sectors.ts';

export const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_MAX_PX = 2000;
const MODELOS_MAX = 30;
const CHAVE_PADRAO = 'entregaveis.modelo';

// ------------------------------------------------------------------------------------------------ logo

/** Confere a imagem pelos bytes: PNG ou JPEG, com largura e altura do próprio arquivo. */
export function conferirLogo(buf: Buffer): { mime: 'image/png' | 'image/jpeg'; w: number; h: number } {
  if (buf.length === 0) throw new HttpError(400, 'logo_vazio', 'A imagem está vazia.');
  if (buf.length > LOGO_MAX_BYTES) throw new HttpError(413, 'logo_grande', 'O logo passa de 512 KB.');
  let r: { mime: 'image/png' | 'image/jpeg'; w: number; h: number } | null = null;
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.toString('latin1', 12, 16) === 'IHDR') {
    r = { mime: 'image/png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } else if (buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: procura o quadro (SOF0..SOF15, menos DHT/JPG/DAC) com a altura e a largura
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const mk = buf[i + 1];
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { r = { mime: 'image/jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; break; }
      i += 2 + len;
    }
  }
  if (!r) throw new HttpError(415, 'logo_tipo', 'Envie o logo em PNG, JPEG ou SVG.');
  if (r.w < 8 || r.h < 8 || r.w > LOGO_MAX_PX || r.h > LOGO_MAX_PX) throw new HttpError(400, 'logo_medida', 'O logo precisa ter entre 8 e 2000 pixels de lado.');
  return r;
}

// ------------------------------------------------------------------------------------------------ identidade

interface IdRow { nome: string; cor_primaria: string; cor_destaque: string; mostrar_ergon: number; logo_w: number | null; logo_h: number | null; logo_sha: string | null }

export function identidade(db: Db, ws: string): Identidade {
  const r = db.get<IdRow>('SELECT nome, cor_primaria, cor_destaque, mostrar_ergon, logo_w, logo_h, logo_sha FROM doc_identidade WHERE workspace_id = ?', ws);
  if (!r) return { ...IDENTIDADE_PADRAO };
  return {
    nome: r.nome, corPrimaria: cor(r.cor_primaria, IDENTIDADE_PADRAO.corPrimaria), corDestaque: cor(r.cor_destaque, IDENTIDADE_PADRAO.corDestaque),
    mostrarErgon: !!Number(r.mostrar_ergon), logo: r.logo_sha ? { w: Number(r.logo_w), h: Number(r.logo_h), versao: r.logo_sha.slice(0, 12) } : null,
  };
}

function garantirLinha(db: Db, ws: string): void {
  db.run('INSERT OR IGNORE INTO doc_identidade (workspace_id, updated_at) VALUES (?, ?)', ws, now());
}

export function salvarIdentidade(db: Db, bus: Bus, ws: string, userId: string, x: { nome?: unknown; corPrimaria?: unknown; corDestaque?: unknown; mostrarErgon?: unknown }): Identidade {
  const atual = identidade(db, ws);
  const nome = typeof x.nome === 'string' ? x.nome.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : atual.nome;
  for (const [k, v] of [['corPrimaria', x.corPrimaria], ['corDestaque', x.corDestaque]] as const) {
    if (v !== undefined && cor(v, '') === '') throw new HttpError(400, 'cor', `cor inválida em ${k} (use #rrggbb)`);
  }
  garantirLinha(db, ws);
  db.run('UPDATE doc_identidade SET nome = ?, cor_primaria = ?, cor_destaque = ?, mostrar_ergon = ?, updated_at = ? WHERE workspace_id = ?',
    nome, cor(x.corPrimaria, atual.corPrimaria), cor(x.corDestaque, atual.corDestaque),
    typeof x.mostrarErgon === 'boolean' ? (x.mostrarErgon ? 1 : 0) : atual.mostrarErgon ? 1 : 0, now(), ws);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'entregaveis.identidade', result: 'identidade das entregas atualizada' });
  bus.publish(ws, 'entregaveis.changed', {});
  return identidade(db, ws);
}

export function salvarLogo(db: Db, bus: Bus, ws: string, userId: string, buf: Buffer | null): Identidade {
  garantirLinha(db, ws);
  if (!buf) db.run('UPDATE doc_identidade SET logo = NULL, logo_mime = NULL, logo_w = NULL, logo_h = NULL, logo_sha = NULL, updated_at = ? WHERE workspace_id = ?', now(), ws);
  else {
    const c = conferirLogo(buf);
    db.run('UPDATE doc_identidade SET logo = ?, logo_mime = ?, logo_w = ?, logo_h = ?, logo_sha = ?, updated_at = ? WHERE workspace_id = ?', buf, c.mime, c.w, c.h, sha256(buf), now(), ws);
  }
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'entregaveis.logo', result: buf ? 'logo das entregas trocado' : 'logo das entregas removido' });
  bus.publish(ws, 'entregaveis.changed', {});
  return identidade(db, ws);
}

export function logoDe(db: Db, ws: string): { data: Buffer; mime: string } | null {
  const r = db.get<{ logo: Buffer | null; logo_mime: string | null }>('SELECT logo, logo_mime FROM doc_identidade WHERE workspace_id = ?', ws);
  return r?.logo && r.logo_mime ? { data: Buffer.from(r.logo), mime: r.logo_mime } : null;
}

// ------------------------------------------------------------------------------------------------ modelos

export function modelos(db: Db, ws: string): { modelos: ModeloDoc[]; padrao: string } {
  const proprios = db.all<{ id: string; config: string }>('SELECT id, config FROM doc_modelos WHERE workspace_id = ? ORDER BY created_at', ws)
    .map((r) => { try { return normalizarModelo(JSON.parse(r.config) as Record<string, unknown>, r.id); } catch { return null; } })
    .filter((m): m is ModeloDoc => !!m);
  const todos = [...MODELOS_ORIGINAIS, ...proprios];
  const p = getSetting(db, ws, CHAVE_PADRAO);
  return { modelos: todos, padrao: todos.some((m) => m.id === p) ? p! : 'ergon' };
}

/** O modelo pelo id, ou pelo nome ("usa o modelo ABNT"): sem acento e sem caixa. */
export function acharModelo(db: Db, ws: string, ref: string | null | undefined): ModeloDoc | null {
  if (!ref) return null;
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const { modelos: todos } = modelos(db, ws);
  return todos.find((m) => m.id === ref) ?? todos.find((m) => fold(m.nome) === fold(ref)) ?? todos.find((m) => fold(ref).includes(fold(m.nome))) ?? null;
}

export function criarModelo(db: Db, bus: Bus, ws: string, userId: string, x: Record<string, unknown>): ModeloDoc {
  const n = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_modelos WHERE workspace_id = ?', ws)?.n ?? 0);
  if (n >= MODELOS_MAX) throw new HttpError(409, 'modelos_max', `Até ${MODELOS_MAX} modelos por workspace.`);
  const mid = id('mod');
  const m = normalizarModelo(x, mid);
  db.run('INSERT INTO doc_modelos (id, workspace_id, nome, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', mid, ws, m.nome, JSON.stringify(m), now(), now());
  if (x.padrao === true) setSetting(db, ws, CHAVE_PADRAO, mid);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'entregaveis.modelo', targetType: 'doc_modelo', targetId: mid, result: `modelo “${m.nome}” criado` });
  bus.publish(ws, 'entregaveis.changed', {});
  return m;
}

export function editarModelo(db: Db, bus: Bus, ws: string, userId: string, mid: string, x: Record<string, unknown>): ModeloDoc {
  if (MODELOS_ORIGINAIS.some((m) => m.id === mid)) {
    // original: só dá para marcar como padrão (o conteúdo fica; para mudar, faça uma cópia)
    if (x.padrao === true) setSetting(db, ws, CHAVE_PADRAO, mid);
    bus.publish(ws, 'entregaveis.changed', {});
    return MODELOS_ORIGINAIS.find((m) => m.id === mid)!;
  }
  if (!db.get('SELECT 1 AS x FROM doc_modelos WHERE id = ? AND workspace_id = ?', mid, ws)) throw notFound('modelo');
  const m = normalizarModelo(x, mid);
  db.run('UPDATE doc_modelos SET nome = ?, config = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', m.nome, JSON.stringify(m), now(), mid, ws);
  if (x.padrao === true) setSetting(db, ws, CHAVE_PADRAO, mid);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'entregaveis.modelo', targetType: 'doc_modelo', targetId: mid, result: `modelo “${m.nome}” alterado` });
  bus.publish(ws, 'entregaveis.changed', {});
  return m;
}

export function apagarModelo(db: Db, bus: Bus, ws: string, userId: string, mid: string): void {
  const r = db.get<{ nome: string }>('SELECT nome FROM doc_modelos WHERE id = ? AND workspace_id = ?', mid, ws);
  if (!r) throw notFound('modelo');
  db.run('DELETE FROM doc_modelos WHERE id = ? AND workspace_id = ?', mid, ws);
  db.run('UPDATE artifacts SET modelo_id = NULL WHERE workspace_id = ? AND modelo_id = ?', ws, mid);
  if (getSetting(db, ws, CHAVE_PADRAO) === mid) setSetting(db, ws, CHAVE_PADRAO, 'ergon');
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'entregaveis.modelo', targetType: 'doc_modelo', targetId: mid, result: `modelo “${r.nome}” apagado` });
  bus.publish(ws, 'entregaveis.changed', {});
}

/** O modelo de um documento: o escolhido para ele, senão o padrão do workspace. */
export function modeloDoArquivo(db: Db, ws: string, artifactId: string): ModeloDoc {
  const escolhido = db.get<{ m: string | null }>('SELECT modelo_id AS m FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, ws)?.m ?? null;
  const { modelos: todos, padrao } = modelos(db, ws);
  return todos.find((m) => m.id === escolhido) ?? todos.find((m) => m.id === padrao) ?? MODELOS_ORIGINAIS[0];
}

export function escolherModelo(db: Db, bus: Bus, ws: string, actor: { type: 'user' | 'agent' | 'system'; id: string }, artifactId: string, ref: string | null): ModeloDoc | null {
  if (!db.get('SELECT 1 AS x FROM artifacts WHERE id = ? AND workspace_id = ?', artifactId, ws)) throw notFound('arquivo');
  const m = ref ? acharModelo(db, ws, ref) : null;
  if (ref && !m) throw new HttpError(404, 'modelo', `Não há modelo “${ref}”.`);
  db.run('UPDATE artifacts SET modelo_id = ? WHERE id = ? AND workspace_id = ?', m?.id ?? null, artifactId, ws);
  audit(db, bus, { workspaceId: ws, actorType: actor.type, actorId: actor.id, action: 'entregaveis.modelo_do_arquivo', targetType: 'artifact', targetId: artifactId, result: m ? `modelo “${m.nome}”` : 'modelo padrão' });
  bus.publish(ws, 'artifacts.changed', { id: artifactId });
  return m;
}

export const nomesDosModelos = (db: Db, ws: string): string => modelos(db, ws).modelos.map((m) => `“${m.nome}”`).join(', ');

/** Imagem de Documentos citada no texto: só PNG/JPEG deste workspace (nunca de fora). */
function imagemDoWorkspace(db: Db, filesDir: string | null, ws: string) {
  return (aid: string): Buffer | null => {
    if (!filesDir) return null;
    try { const f = openArtifact(db, filesDir, ws, aid); return f.mime === 'image/png' || f.mime === 'image/jpeg' ? f.data : null; } catch { return null; }
  };
}

/** PDF de um texto Markdown com a identidade do workspace e o modelo pedido (ou o padrão). */
export function pdfDeTexto(db: Db, ws: string, md: string, titulo: string, modelo: ModeloDoc | null, filesDir: string | null = null, semLogo = false): Buffer {
  const pngs = pngsDasCercas(md);
  const todos = modelos(db, ws);
  const m = modelo ?? todos.modelos.find((x) => x.id === todos.padrao) ?? MODELOS_ORIGINAIS[0];
  const id = identidade(db, ws);
  return documentoPdf({ markdown: md, titulo: tituloDoDocumento(md, titulo), identidade: semLogo ? { ...id, mostrarErgon: false } : id, modelo: m,
    logo: semLogo ? null : logoDe(db, ws)?.data ?? null, imagem: imagemDoWorkspace(db, filesDir, ws), visual: (lang, corpo) => pngs.get(chaveDaCerca(lang, corpo)) ?? null });
}

/** PDF de um .md de Documentos: o modelo dele (ou outro, para a prévia). */
export function pdfDoArquivo(db: Db, filesDir: string, ws: string, artifactId: string, modeloRef?: string | null, semLogo = false): { data: Buffer; filename: string } {
  const f = openArtifact(db, filesDir, ws, artifactId);
  if (!ehMarkdown(f.filename, f.mime)) throw new HttpError(415, 'nao_markdown', 'Só documentos .md viram PDF por aqui.');
  const m = (modeloRef ? acharModelo(db, ws, modeloRef) : null) ?? modeloDoArquivo(db, ws, artifactId);
  const md = f.data.toString('utf8');
  return { data: pdfDeTexto(db, ws, md, f.filename, m, filesDir, semLogo), filename: f.filename.replace(/\.(md|markdown)$/i, '') + '.pdf' };
}

export const ehMarkdown = (filename: string, mime: string): boolean => mime === 'text/markdown' || /\.(md|markdown)$/i.test(filename);

/** A linha para os agentes (vai nas instruções de Documentos): os modelos que existem e como usar. */
export function instrucaoModelos(db: Db, ws: string): string {
  const nomes = modelos(db, ws).modelos.map((m) => `“${m.nome}”`).join(', ');
  return `- documento com modelo (cabeçalho, rodapé, paginação, capa, ABNT): no [[salvar-documento]], acrescente modelo="ABNT" (ou outro: ${nomes}); num arquivo que já existe: [[usar-modelo arquivo="relatorio.md" modelo="ABNT"]]. Escreva o texto em Markdown comum (#, ##, listas, tabelas, > citação, "## Referências" no fim); o modelo cuida da aparência`;
}
