/**
 * O que vai dentro do cartão de uma tarefa da pessoa (rc.41): subtarefas, links, pessoas do workspace, comentários (de
 * pessoas e de agentes, até 240 caracteres) e anexos (arquivos que já estão em Documentos; nada é copiado).
 *
 * - Tudo local do Ergon: num quadro espelhado, nada disto é escrito no aplicativo de origem.
 * - Comentar vale em qualquer card (os agentes comentam nos da equipe também); o resto, só nos quadros da pessoa: o
 *   quadro da equipe anda pelo trabalho.
 * - Não muda a revisão da tarefa: quem está editando o título não perde o que digitou porque alguém marcou uma subtarefa.
 * - Apagar um item deixa uma lápide (card_tombstones): o outro aparelho apaga o dele em vez de devolver o item.
 * - Subtarefa é um item do cartão, não um card: tasks.parent_task_id já liga a tarefa enviada à equipe ao card dela.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import type { Bus } from './bus.ts';
import { camposDoQuadro, valoresDe, type Campo, type ValorCampo } from './campos.ts';

export const COMENTARIO_MAX = 240;
export const SUBTAREFAS_MAX = 100;
export const SUBTAREFA_MAX = 200;
export const LINKS_MAX = 30;
export const URL_MAX = 2000;
export const TITULO_LINK_MAX = 120;
export const ANEXOS_MAX = 30;
export const PESSOAS_MAX = 20;
export const COMENTARIOS_MAX = 500;

interface Quem { userId: string; workspaceId: string }
/** quem escreve um comentário: a pessoa da sessão ou um agente (pelas ferramentas da equipe) */
export type Autor = { type: 'user'; id: string } | { type: 'agent'; id: string };

function tarefa(db: Db, ws: string, taskId: string, soDaPessoa = true) {
  const t = db.get<{ id: string; board_id: string; audience: string; origin: string }>(
    'SELECT t.id, t.board_id, b.audience, b.origin FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.workspace_id = ?', taskId, ws);
  if (!t) throw notFound('tarefa');
  if (soDaPessoa && t.audience !== 'user') throw new HttpError(409, 'team_board_readonly', 'O quadro da equipe é automático: para mudar algo, fale com a coordenação.');
  return t;
}
const lapide = (db: Db, ws: string, taskId: string, itemId: string) =>
  db.run('INSERT OR REPLACE INTO card_tombstones (workspace_id, task_id, item_id, deleted_at) VALUES (?, ?, ?, ?)', ws, taskId, itemId, now());
const semLapide = (db: Db, taskId: string, itemId: string) => db.run('DELETE FROM card_tombstones WHERE task_id = ? AND item_id = ?', taskId, itemId);
const avisar = (bus: Bus | null, ws: string, taskId: string) => bus?.publish(ws, 'tasks.changed', { id: taskId });

// ---------------------------------------------------------------- subtarefas
export interface Subtarefa { id: string; title: string; done: boolean; position: number }
const subtarefas = (db: Db, ws: string, taskId: string): Subtarefa[] =>
  db.all<{ id: string; title: string; done: number; position: number }>('SELECT id, title, done, position FROM task_subtasks WHERE task_id = ? AND workspace_id = ? ORDER BY position, rowid', taskId, ws)
    .map((s) => ({ id: s.id, title: s.title, done: !!s.done, position: s.position }));
const tituloSub = (s: string) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > SUBTAREFA_MAX) throw new HttpError(400, 'invalid', `Subtarefa: de 1 a ${SUBTAREFA_MAX} caracteres.`);
  return t;
};

export function criarSubtarefa(db: Db, bus: Bus | null, q: Quem, taskId: string, titulo: string): Subtarefa {
  tarefa(db, q.workspaceId, taskId);
  const title = tituloSub(titulo);
  const n = subtarefas(db, q.workspaceId, taskId).length;
  if (n >= SUBTAREFAS_MAX) throw new HttpError(409, 'limite', `Até ${SUBTAREFAS_MAX} subtarefas por tarefa.`);
  const sid = id('sub'); const ts = now();
  db.run('INSERT INTO task_subtasks (id, workspace_id, task_id, title, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)', sid, q.workspaceId, taskId, db.seal(q.workspaceId, title), n, ts, ts);
  avisar(bus, q.workspaceId, taskId);
  return { id: sid, title, done: false, position: n };
}

export function mudarSubtarefa(db: Db, bus: Bus | null, q: Quem, subId: string, x: { title?: string; done?: boolean; position?: number }) {
  const s = db.get<{ id: string; task_id: string }>('SELECT id, task_id FROM task_subtasks WHERE id = ? AND workspace_id = ?', subId, q.workspaceId);
  if (!s) throw notFound('subtarefa');
  tarefa(db, q.workspaceId, s.task_id);
  const ts = now();
  db.tx(() => {
    if (x.title !== undefined) db.run('UPDATE task_subtasks SET title = ?, updated_at = ? WHERE id = ?', db.seal(q.workspaceId, tituloSub(x.title)), ts, subId);
    if (x.done !== undefined) db.run('UPDATE task_subtasks SET done = ?, updated_at = ? WHERE id = ?', x.done ? 1 : 0, ts, subId);
    if (x.position !== undefined) {
      const ordem = subtarefas(db, q.workspaceId, s.task_id).map((y) => y.id).filter((y) => y !== subId);
      ordem.splice(Math.max(0, Math.min(ordem.length, Math.trunc(x.position))), 0, subId);
      // só as que mudaram de lugar ganham data nova (entre aparelhos, vale a mais recente de cada item)
      ordem.forEach((y, i) => db.run('UPDATE task_subtasks SET position = ?, updated_at = ? WHERE id = ? AND position <> ?', i, ts, y, i));
    }
  });
  avisar(bus, q.workspaceId, s.task_id);
  return { subtasks: subtarefas(db, q.workspaceId, s.task_id) };
}

export function apagarSubtarefa(db: Db, bus: Bus | null, q: Quem, subId: string) {
  const s = db.get<{ id: string; task_id: string }>('SELECT id, task_id FROM task_subtasks WHERE id = ? AND workspace_id = ?', subId, q.workspaceId);
  if (!s) throw notFound('subtarefa');
  tarefa(db, q.workspaceId, s.task_id);
  db.tx(() => { db.run('DELETE FROM task_subtasks WHERE id = ?', subId); lapide(db, q.workspaceId, s.task_id, subId); });
  avisar(bus, q.workspaceId, s.task_id);
  return { ok: true };
}

// ---------------------------------------------------------------- links
/** Só http e https, bem formados e sem usuário/senha no endereço; devolve o endereço normalizado. */
export function conferirUrl(bruto: unknown): string {
  const s = String(bruto ?? '').trim();
  if (!s || s.length > URL_MAX) throw new HttpError(400, 'invalid', 'Link: um endereço http:// ou https://.');
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, 'invalid', 'Link: um endereço http:// ou https://.'); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) throw new HttpError(400, 'invalid', 'Link: um endereço http:// ou https://.');
  return u.toString();
}
export interface LinkDoCartao { id: string; url: string; title: string }
const links = (db: Db, ws: string, taskId: string) => db.all<LinkDoCartao>('SELECT id, url, title FROM task_urls WHERE task_id = ? AND workspace_id = ? ORDER BY created_at, rowid', taskId, ws);

export function criarLink(db: Db, bus: Bus | null, q: Quem, taskId: string, x: { url: string; title?: string }): LinkDoCartao {
  tarefa(db, q.workspaceId, taskId);
  const url = conferirUrl(x.url);
  const title = String(x.title ?? '').replace(/\s+/g, ' ').trim();
  if (title.length > TITULO_LINK_MAX) throw new HttpError(400, 'invalid', `Nome do link com até ${TITULO_LINK_MAX} letras.`);
  const atuais = links(db, q.workspaceId, taskId);
  if (atuais.length >= LINKS_MAX) throw new HttpError(409, 'limite', `Até ${LINKS_MAX} links por tarefa.`);
  if (atuais.some((l) => l.url === url)) throw new HttpError(409, 'repetido', 'Este link já está na tarefa.');
  const lid = id('url'); const ts = now();
  db.run('INSERT INTO task_urls (id, workspace_id, task_id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', lid, q.workspaceId, taskId, db.seal(q.workspaceId, url), db.seal(q.workspaceId, title), ts, ts);
  avisar(bus, q.workspaceId, taskId);
  return { id: lid, url, title };
}

export function apagarLink(db: Db, bus: Bus | null, q: Quem, taskId: string, linkId: string) {
  tarefa(db, q.workspaceId, taskId);
  if (!db.run('DELETE FROM task_urls WHERE id = ? AND task_id = ? AND workspace_id = ?', linkId, taskId, q.workspaceId).changes) throw notFound('link');
  lapide(db, q.workspaceId, taskId, linkId);
  avisar(bus, q.workspaceId, taskId);
  return { ok: true };
}

// ---------------------------------------------------------------- pessoas
export interface Pessoa { id: string; name: string; username: string }
/** As pessoas do workspace (quem pode ser atribuído a um cartão). */
export const pessoasDoWorkspace = (db: Db, ws: string) =>
  db.all<Pessoa>('SELECT u.id, u.display_name AS name, u.username FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at, u.username', ws);
const pessoas = (db: Db, ws: string, taskId: string) =>
  db.all<Pessoa>('SELECT u.id, u.display_name AS name, u.username FROM task_people p JOIN users u ON u.id = p.user_id WHERE p.task_id = ? AND p.workspace_id = ? ORDER BY p.created_at, u.username', taskId, ws);

/** Troca as pessoas atribuídas pelo conjunto dado (só membros do workspace). */
export function definirPessoas(db: Db, bus: Bus | null, q: Quem, taskId: string, userIds: string[]) {
  tarefa(db, q.workspaceId, taskId);
  const quer = [...new Set(userIds)];
  if (quer.length > PESSOAS_MAX) throw new HttpError(400, 'invalid', `Até ${PESSOAS_MAX} pessoas por tarefa.`);
  const membros = new Set(pessoasDoWorkspace(db, q.workspaceId).map((p) => p.id));
  if (quer.some((u) => !membros.has(u))) throw new HttpError(400, 'invalid', 'Só pessoas deste workspace podem ser atribuídas.');
  const tem = new Set(pessoas(db, q.workspaceId, taskId).map((p) => p.id));
  db.tx(() => {
    for (const u of quer) if (!tem.has(u)) { db.run('INSERT INTO task_people (workspace_id, task_id, user_id, created_at) VALUES (?, ?, ?, ?)', q.workspaceId, taskId, u, now()); semLapide(db, taskId, `p:${u}`); }
    for (const u of tem) if (!quer.includes(u)) { db.run('DELETE FROM task_people WHERE task_id = ? AND user_id = ?', taskId, u); lapide(db, q.workspaceId, taskId, `p:${u}`); }
  });
  avisar(bus, q.workspaceId, taskId);
  return { people: pessoas(db, q.workspaceId, taskId) };
}

// ---------------------------------------------------------------- comentários
export interface Comentario { id: string; authorType: 'user' | 'agent'; authorName: string; body: string; createdAt: string; mine: boolean }
const comentarios = (db: Db, ws: string, taskId: string, userId: string | null): Comentario[] =>
  db.all<{ id: string; author_type: 'user' | 'agent'; author_user_id: string | null; author_name: string; body: string; created_at: string }>(
    'SELECT id, author_type, author_user_id, author_name, body, created_at FROM task_comments WHERE task_id = ? AND workspace_id = ? ORDER BY created_at, rowid', taskId, ws)
    .map((c) => ({ id: c.id, authorType: c.author_type, authorName: c.author_name, body: c.body, createdAt: c.created_at, mine: c.author_type === 'user' && !!userId && c.author_user_id === userId }));

/** O texto de um comentário: sem espaços nas pontas, de 1 a 240 caracteres (contados como a pessoa vê: por letra). */
export function conferirComentario(bruto: unknown): string {
  const s = String(bruto ?? '').replace(/\r\n/g, '\n').trim();
  const n = [...s].length;
  if (!n) throw new HttpError(400, 'invalid', 'Escreva o comentário.');
  if (n > COMENTARIO_MAX) throw new HttpError(400, 'comentario_longo', `Comentário com até ${COMENTARIO_MAX} caracteres (este tem ${n}).`);
  return s;
}

/** Comenta numa tarefa do workspace (qualquer quadro). O nome do autor fica gravado junto. */
export function comentar(db: Db, bus: Bus | null, ws: string, autor: Autor, taskId: string, texto: unknown): Comentario {
  tarefa(db, ws, taskId, false);
  const body = conferirComentario(texto);
  const nome = autor.type === 'user'
    ? db.get<{ n: string }>('SELECT u.display_name AS n FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND m.workspace_id = ?', autor.id, ws)?.n
    : db.get<{ n: string }>('SELECT name AS n FROM agents WHERE id = ? AND workspace_id = ?', autor.id, ws)?.n;
  if (!nome) throw notFound(autor.type === 'user' ? 'pessoa' : 'agente');
  if (Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?', taskId)?.n ?? 0) >= COMENTARIOS_MAX) throw new HttpError(409, 'limite', `Até ${COMENTARIOS_MAX} comentários por tarefa.`);
  const cid = id('cmt'); const ts = now();
  db.run('INSERT INTO task_comments (id, workspace_id, task_id, author_type, author_user_id, author_agent_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cid, ws, taskId, autor.type, autor.type === 'user' ? autor.id : null, autor.type === 'agent' ? autor.id : null, db.seal(ws, nome), db.seal(ws, body), ts);
  avisar(bus, ws, taskId);
  return { id: cid, authorType: autor.type, authorName: nome, body, createdAt: ts, mine: autor.type === 'user' };
}

/** Cada pessoa apaga só o próprio comentário (o de um agente, quem administra o workspace). */
export function apagarComentario(db: Db, bus: Bus | null, q: Quem & { role?: string }, taskId: string, commentId: string) {
  const c = db.get<{ author_type: string; author_user_id: string | null }>('SELECT author_type, author_user_id FROM task_comments WHERE id = ? AND task_id = ? AND workspace_id = ?', commentId, taskId, q.workspaceId);
  if (!c) throw notFound('comentário');
  const pode = c.author_type === 'user' ? c.author_user_id === q.userId : q.role === 'owner';
  if (!pode) throw new HttpError(403, 'forbidden', 'Cada pessoa apaga só o próprio comentário.');
  db.tx(() => { db.run('DELETE FROM task_comments WHERE id = ?', commentId); lapide(db, q.workspaceId, taskId, commentId); });
  avisar(bus, q.workspaceId, taskId);
  return { ok: true };
}

// ---------------------------------------------------------------- anexos (arquivos de Documentos)
export interface Anexo { id: string; artifactId: string; filename: string; mime: string | null; size: number | null; available: boolean }
const anexos = (db: Db, ws: string, taskId: string): Anexo[] =>
  db.all<{ id: string; artifact_id: string; filename: string; a_name: string | null; mime: string | null; size: number | null; deleted_at: string | null }>(
    `SELECT x.id, x.artifact_id, x.filename, a.filename AS a_name, a.mime, a.size, a.deleted_at FROM task_attachments x
       LEFT JOIN artifacts a ON a.id = x.artifact_id AND a.workspace_id = x.workspace_id WHERE x.task_id = ? AND x.workspace_id = ? ORDER BY x.created_at, x.rowid`, taskId, ws)
    // o arquivo pode não estar neste aparelho (a referência veio de outro) ou ter ido para a lixeira: fica o nome, sem abrir
    .map((r) => ({ id: r.id, artifactId: r.artifact_id, filename: r.a_name ?? r.filename, mime: r.mime, size: r.size, available: r.a_name !== null && !r.deleted_at }));

export function anexar(db: Db, bus: Bus | null, q: Quem, taskId: string, artifactId: string): Anexo {
  tarefa(db, q.workspaceId, taskId);
  const a = db.get<{ filename: string }>('SELECT filename FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', artifactId, q.workspaceId);
  if (!a) throw notFound('arquivo');
  const atuais = anexos(db, q.workspaceId, taskId);
  if (atuais.some((x) => x.artifactId === artifactId)) throw new HttpError(409, 'repetido', 'Este arquivo já está anexado.');
  if (atuais.length >= ANEXOS_MAX) throw new HttpError(409, 'limite', `Até ${ANEXOS_MAX} anexos por tarefa.`);
  const aid = id('anx');
  db.run('INSERT INTO task_attachments (id, workspace_id, task_id, artifact_id, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)', aid, q.workspaceId, taskId, artifactId, db.seal(q.workspaceId, a.filename), now());
  avisar(bus, q.workspaceId, taskId);
  return anexos(db, q.workspaceId, taskId).find((x) => x.id === aid)!;
}

export function desanexar(db: Db, bus: Bus | null, q: Quem, taskId: string, anexoId: string) {
  tarefa(db, q.workspaceId, taskId);
  if (!db.run('DELETE FROM task_attachments WHERE id = ? AND task_id = ? AND workspace_id = ?', anexoId, taskId, q.workspaceId).changes) throw notFound('anexo');
  lapide(db, q.workspaceId, taskId, anexoId);
  avisar(bus, q.workspaceId, taskId);
  return { ok: true };
}

// ---------------------------------------------------------------- o cartão inteiro e o resumo para o quadro
/** Tudo o que o detalhe do cartão mostra (os campos são os do quadro onde a tarefa está). */
export function cartao(db: Db, q: Quem, taskId: string) {
  const t = tarefa(db, q.workspaceId, taskId, false);
  const daPessoa = t.audience === 'user';
  return {
    taskId, editable: daPessoa, mirror: t.origin === 'mirror',
    fields: daPessoa ? camposDoQuadro(db, q.workspaceId, t.board_id) : [] as Campo[],
    values: valoresDe(db, q.workspaceId, [taskId]).get(taskId) ?? {} as Record<string, ValorCampo>,
    subtasks: subtarefas(db, q.workspaceId, taskId), links: links(db, q.workspaceId, taskId), people: pessoas(db, q.workspaceId, taskId),
    comments: comentarios(db, q.workspaceId, taskId, q.userId), attachments: anexos(db, q.workspaceId, taskId),
    members: pessoasDoWorkspace(db, q.workspaceId), limits: { comment: COMENTARIO_MAX },
  };
}

export interface ResumoCartao { sub: [number, number] | null; comments: number; links: number; files: number; people: Array<{ id: string; name: string }>; values: Record<string, ValorCampo> }
/** O que o card do quadro mostra de cada tarefa (contadores, pessoas e valores), em poucas consultas para o quadro todo. */
export function resumosDoQuadro(db: Db, ws: string, boardId: string): Map<string, ResumoCartao> {
  const out = new Map<string, ResumoCartao>();
  const de = (tid: string) => out.get(tid) ?? out.set(tid, { sub: null, comments: 0, links: 0, files: 0, people: [], values: {} }).get(tid)!;
  const onde = 'workspace_id = ? AND task_id IN (SELECT id FROM tasks WHERE board_id = ? AND archived = 0)';
  for (const r of db.all<{ task_id: string; feitas: number; total: number }>(`SELECT task_id, SUM(done) AS feitas, COUNT(*) AS total FROM task_subtasks WHERE ${onde} GROUP BY task_id`, ws, boardId)) de(r.task_id).sub = [Number(r.feitas), Number(r.total)];
  for (const [tabela, chave] of [['task_comments', 'comments'], ['task_urls', 'links'], ['task_attachments', 'files']] as const)
    for (const r of db.all<{ task_id: string; n: number }>(`SELECT task_id, COUNT(*) AS n FROM ${tabela} WHERE ${onde} GROUP BY task_id`, ws, boardId)) de(r.task_id)[chave] = Number(r.n);
  for (const r of db.all<{ task_id: string; id: string; name: string }>(
    `SELECT p.task_id, u.id, u.display_name AS name FROM task_people p JOIN users u ON u.id = p.user_id WHERE p.workspace_id = ? AND p.task_id IN (SELECT id FROM tasks WHERE board_id = ? AND archived = 0) ORDER BY p.created_at`, ws, boardId)) de(r.task_id).people.push({ id: r.id, name: r.name });
  const ids = db.all<{ task_id: string }>(`SELECT DISTINCT task_id FROM task_field_values WHERE ${onde}`, ws, boardId).map((r) => r.task_id);
  for (const [tid, v] of valoresDe(db, ws, ids)) de(tid).values = v;
  return out;
}
