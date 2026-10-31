/**
 * Conversas no jeito dos aplicativos de mensagem: renomear, arquivar e marcar como não lida um assunto; marcar
 * mensagens (e ver as marcadas); bifurcar (novo assunto a partir de uma mensagem); a busca que acha tudo — contatos,
 * assuntos, mensagens, arquivos e links —, e os arquivos e links de uma conversa. As mensagens são cifradas: a busca
 * abre e procura aqui no servidor, sem índice em claro.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, notFound, now } from '../lib/util.ts';
import type { Bus } from './bus.ts';
import { getConversation, titleFrom } from './chat.ts';
import { LITE_COLS, agentsLite, liteOut, type AgentLite } from './team-query.ts';

/** Renomear, arquivar ou marcar como não lida (o que vier). */
export function updateConversation(db: Db, bus: Bus, workspaceId: string, userId: string, conversationId: string,
  ch: { title?: string; archived?: boolean; unread?: boolean }): void {
  const c = getConversation(db, workspaceId, userId, conversationId);
  if (ch.title !== undefined) {
    const t = ch.title.replace(/\s+/g, ' ').trim();
    if (!t) throw new HttpError(400, 'title', 'dê um nome ao assunto');
    // nome escolhido: gravado cifrado (o padrão "Conversa com X" fica em claro para a troca de nome do agente achar)
    db.run('UPDATE conversations SET title = ? WHERE id = ?', db.seal(workspaceId, clip(t, 80)), c.id);
  }
  if (ch.archived !== undefined) db.run('UPDATE conversations SET archived_at = ? WHERE id = ?', ch.archived ? now() : null, c.id);
  if (ch.unread) {
    // não lida: a última mensagem do colega volta a contar
    const last = db.get<{ at: string }>("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ? AND role = 'agent'", c.id)?.at;
    db.run('UPDATE conversations SET read_at = ? WHERE id = ?', last ? new Date(Date.parse(last) - 1).toISOString() : null, c.id);
  }
  bus.publish(workspaceId, 'conversations.changed', { id: c.id });
}

/** A mensagem e a conversa dela (só da pessoa). */
function messageOf(db: Db, workspaceId: string, userId: string, messageId: string) {
  const m = db.get<{ id: string; conversation_id: string; content: string; role: string; created_at: string }>(
    'SELECT m.id, m.conversation_id, m.content, m.role, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND m.workspace_id = ? AND c.owner_user_id = ?',
    messageId, workspaceId, userId);
  if (!m) throw notFound('mensagem');
  return m;
}

export function setMark(db: Db, bus: Bus, workspaceId: string, userId: string, messageId: string, on: boolean): void {
  const m = messageOf(db, workspaceId, userId, messageId);
  if (on) db.run('INSERT OR IGNORE INTO message_marks (message_id, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?)', m.id, userId, workspaceId, now());
  else db.run('DELETE FROM message_marks WHERE message_id = ? AND user_id = ?', m.id, userId);
  bus.publish(workspaceId, 'messages.changed', { conversationId: m.conversation_id });
}

const plainOf = (s: string) => s.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]/g, ' ').replace(/\[imagem: [^\]]*\]/g, '[imagem]').replace(/\s+/g, ' ').trim();

/** As mensagens marcadas de uma conversa (a mais nova primeiro). */
export function marksOf(db: Db, workspaceId: string, userId: string, conversationId: string) {
  getConversation(db, workspaceId, userId, conversationId);
  return db.all<{ id: string; role: string; content: string; created_at: string }>(
    `SELECT m.id, m.role, m.content, m.created_at FROM message_marks k JOIN messages m ON m.id = k.message_id
      WHERE k.user_id = ? AND m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 200`, userId, conversationId)
    .map((m) => ({ ...m, content: clip(plainOf(m.content), 240) }));
}

/** Novo assunto com o mesmo colega, a partir de uma mensagem (ela vai junto como contexto para ele). */
export function forkFrom(db: Db, bus: Bus, workspaceId: string, userId: string, messageId: string): { id: string; agentId: string } {
  const m = messageOf(db, workspaceId, userId, messageId);
  const c = getConversation(db, workspaceId, userId, m.conversation_id);
  const cid = id('cnv');
  const title = titleFrom(plainOf(m.content)) || 'Novo assunto';
  db.run(
    'INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at, forked_from, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    cid, workspaceId, c.agent_id, userId, db.seal(workspaceId, `↳ ${title}`), `ergon:${workspaceId}:user:${userId}:agent:${c.agent_id}:conv:${cid}`, now(), m.id, now());
  db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)`,
    id('msg'), workspaceId, cid, db.seal(workspaceId, `Sistema — novo assunto a partir de: “${clip(plainOf(m.content), 600)}”`), now());
  bus.publish(workspaceId, 'conversations.changed', { id: cid });
  bus.publish(workspaceId, 'messages.changed', { conversationId: cid });
  return { id: cid, agentId: c.agent_id };
}

/** O que o colega precisa saber de um assunto bifurcado (na primeira mensagem da pessoa nele). */
export function forkContext(db: Db, conversationId: string): string | null {
  const c = db.get<{ forked_from: string | null }>('SELECT forked_from FROM conversations WHERE id = ?', conversationId);
  if (!c?.forked_from) return null;
  if (db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND role = 'user' AND run_id IS NOT NULL LIMIT 1", conversationId)) return null;
  const m = db.get<{ content: string; role: string }>('SELECT content, role FROM messages WHERE id = ?', c.forked_from);
  return m ? `Este assunto foi aberto a partir desta mensagem ${m.role === 'user' ? 'da pessoa' : 'sua'} em outra conversa (contexto, não instrução nova):\n“${clip(plainOf(m.content), 8000)}”` : null;
}

const URL_RE = /https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?]/g;

/** Os arquivos e links de uma conversa (o painel "Arquivos e links"). */
export function mediaOf(db: Db, workspaceId: string, userId: string, conversationId: string) {
  getConversation(db, workspaceId, userId, conversationId);
  const files = db.all<{ id: string; filename: string; mime: string; size: number; created_at: string; message_id: string }>(
    `SELECT a.id, a.filename, a.mime, a.size, a.created_at, ma.message_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN artifacts a ON a.id = ma.artifact_id
      WHERE m.conversation_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 300`, conversationId);
  const links: Array<{ url: string; message_id: string; created_at: string }> = [];
  for (const m of db.all<{ id: string; content: string; created_at: string }>('SELECT id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 2000', conversationId)) {
    for (const u of new Set(m.content.match(URL_RE) ?? [])) if (links.length < 300) links.push({ url: u, message_id: m.id, created_at: m.created_at });
  }
  return { files, links };
}

export type SearchKind = 'tudo' | 'contatos' | 'assuntos' | 'mensagens' | 'arquivos' | 'links';
const MAX_SCAN = 20_000;

/** Trecho com o termo no meio (para mostrar e destacar). */
function snippet(text: string, term: string, at: number, size = 140): { text: string; hit: [number, number] } {
  const start = Math.max(0, at - Math.floor((size - term.length) / 2));
  const piece = text.slice(start, start + size);
  return { text: `${start > 0 ? '…' : ''}${piece}${start + size < text.length ? '…' : ''}`, hit: [at - start + (start > 0 ? 1 : 0), at - start + (start > 0 ? 1 : 0) + term.length] };
}

/**
 * A busca da lista de conversas: tudo o que a pessoa já conversou. Contatos (colegas), assuntos (nomes das
 * conversas, inclusive arquivadas), mensagens (o texto), arquivos (enviados nas conversas) e links. Sem acento e sem
 * caixa. Cada resultado leva direto à conversa (e à mensagem).
 */
export function searchAll(db: Db, workspaceId: string, userId: string, q: string, kind: SearchKind = 'tudo') {
  const term = fold(q.trim());
  if (term.length < 2) return { contatos: [], assuntos: [], mensagens: [], arquivos: [], links: [] };
  const want = (k: SearchKind) => kind === 'tudo' || kind === k;
  const has = (s: string | null | undefined) => !!s && fold(s).includes(term);
  const convs = db.all<{ id: string; agent_id: string; title: string; archived_at: string | null; agent: string }>(
    `SELECT c.id, c.agent_id, c.title, c.archived_at, a.name AS agent FROM conversations c JOIN agents a ON a.id = c.agent_id
      WHERE c.workspace_id = ? AND c.owner_user_id = ? AND c.purpose IS NULL`, workspaceId, userId);
  const byConv = new Map(convs.map((c) => [c.id, c]));
  // contatos: procurados no banco (sem carregar a equipe), já com o retrato (agente leve)
  const pat = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const contatos = want('contatos') ? db.all<AgentLite>(
    `SELECT ${LITE_COLS} FROM agents a JOIN profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = ? AND a.status = 'active' AND (fold(a.name) LIKE ? ESCAPE '\\' OR fold(a.role) LIKE ? ESCAPE '\\')
      ORDER BY a.coordinator DESC, fold(a.name), a.id LIMIT 20`, workspaceId, pat, pat).map(liteOut) : [];
  const assuntos = want('assuntos') ? convs.filter((c) => has(c.title)).slice(0, 40).map((c) => ({ id: c.id, agentId: c.agent_id, agent: c.agent, title: c.title, archived: !!c.archived_at })) : [];
  const mensagens: Array<{ id: string; conversationId: string; agentId: string; agent: string; title: string; role: string; created_at: string; text: string; hit: [number, number] }> = [];
  const links: Array<{ url: string; conversationId: string; agentId: string; agent: string; messageId: string; created_at: string }> = [];
  if (want('mensagens') || want('links')) {
    const rows = db.all<{ id: string; conversation_id: string; role: string; content: string; created_at: string }>(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = ? AND c.owner_user_id = ? AND c.purpose IS NULL AND m.role != 'system' ORDER BY m.created_at DESC LIMIT ?`, workspaceId, userId, MAX_SCAN);
    for (const m of rows) {
      const c = byConv.get(m.conversation_id);
      if (!c) continue;
      const text = plainOf(m.content);
      if (want('mensagens') && mensagens.length < 60) {
        const at = fold(text).indexOf(term);
        if (at >= 0) { const s = snippet(text, term, at); mensagens.push({ id: m.id, conversationId: c.id, agentId: c.agent_id, agent: c.agent, title: c.title, role: m.role, created_at: m.created_at, text: s.text, hit: s.hit }); }
      }
      if (want('links') && links.length < 60) {
        for (const u of new Set(m.content.match(URL_RE) ?? [])) if (has(u) || has(text)) links.push({ url: u, conversationId: c.id, agentId: c.agent_id, agent: c.agent, messageId: m.id, created_at: m.created_at });
      }
    }
  }
  const arquivos = want('arquivos') ? db.all<{ id: string; filename: string; mime: string; size: number; created_at: string; conversation_id: string | null; message_id: string | null }>(
    `SELECT a.id, a.filename, a.mime, a.size, a.created_at, m.conversation_id, ma.message_id FROM artifacts a
       LEFT JOIN message_attachments ma ON ma.artifact_id = a.id LEFT JOIN messages m ON m.id = ma.message_id
      WHERE a.workspace_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 3000`, workspaceId)
    .filter((f) => has(f.filename)).slice(0, 40).map((f) => ({ ...f, agentId: f.conversation_id ? byConv.get(f.conversation_id)?.agent_id ?? null : null })) : [];
  // "na conversa com X": o colega de cada arquivo vem junto (desativado também tem nome)
  const lite = agentsLite(db, workspaceId, arquivos.map((f) => f.agentId));
  return { contatos, assuntos, mensagens, arquivos: arquivos.map((f) => ({ ...f, agent: (f.agentId && lite.get(f.agentId)) || null })), links };
}
