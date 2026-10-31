import type { Db } from '../db/db.ts';
import { HttpError, clip, id, notFound, now } from '../lib/util.ts';
import { applyDecision } from './actions.ts';
import type { Bus } from './bus.ts';
import { decide, interpretRules } from './interpret.ts';
import { instructionsFor, isCoordinator, type RunExecutor } from './runs.ts';
import { parseChatCommand, recordProposals } from './proposals.ts';
import { attachToMessage, attachmentLine, attachmentsOf, type AttachmentInfo } from './attachments.ts';
import { forkContext } from './conversation-tools.ts';

export interface ConversationRow {
  id: string; workspace_id: string; agent_id: string; owner_user_id: string; title: string; hermes_session_key: string; created_at: string;
}

/** Conversa pertence a (workspace, participante, agente). Outro usuário não a lê, mesmo com o ID. */
export function getConversation(db: Db, workspaceId: string, userId: string, conversationId: string): ConversationRow {
  const c = db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ? AND workspace_id = ? AND owner_user_id = ?', conversationId, workspaceId, userId);
  if (!c) throw notFound('conversa');
  return c;
}

export function listConversations(db: Db, workspaceId: string, userId: string, agentId?: string) {
  return db.all(
    `SELECT c.id, c.agent_id, c.title, c.created_at, c.purpose, c.read_at, c.archived_at, c.pinned_at,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at
       FROM conversations c WHERE c.workspace_id = ? AND c.owner_user_id = ? ${agentId ? 'AND c.agent_id = ?' : ''}
      ORDER BY COALESCE(last_at, c.created_at) DESC LIMIT 100`,
    ...(agentId ? [workspaceId, userId, agentId] : [workspaceId, userId]));
}

export function createConversation(db: Db, workspaceId: string, userId: string, agentId: string, title?: string): ConversationRow {
  const agent = db.get<{ name: string; status: string }>('SELECT name, status FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
  if (!agent) throw notFound('agente');
  if (agent.status !== 'active') throw new HttpError(409, 'agent_archived', 'agente desativado');
  const convId = id('cnv');
  db.run(
    'INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    convId, workspaceId, agentId, userId, clip((title ?? '').trim() || `Conversa com ${agent.name}`, 80),
    `ergon:${workspaceId}:user:${userId}:agent:${agentId}:conv:${convId}`, now());
  return getConversation(db, workspaceId, userId, convId);
}

/** Título a partir de um texto: uma linha, até ~60 caracteres, cortado em palavra, com "…" quando corta. */
export function titleFrom(text: string, max = 60): string {
  const line = text.replace(/\[imagem: [^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const space = line[max] === ' ' ? max : line.lastIndexOf(' ', max);
  // palavra longa demais (um endereço, por exemplo): corta no limite mesmo
  const head = space >= max / 2 ? line.slice(0, space) : line.slice(0, max);
  return `${head.replace(/[\s,;:.!?…–—-]+$/, '')}…`;
}

/**
 * A 1ª mensagem da pessoa dá nome à conversa, para as várias conversas com o mesmo agente se diferenciarem no
 * seletor. Só troca o título padrão ("Conversa com <agente>"): o que a pessoa escolheu fica. Gravado cifrado, como a
 * mensagem de onde saiu; o padrão segue em claro (a troca de nome do agente o procura pelo texto).
 */
function nameAfterFirstMessage(db: Db, workspaceId: string, conv: ConversationRow, content: string): void {
  const title = titleFrom(content);
  if (title) db.run('UPDATE conversations SET title = ? WHERE id = ? AND title = ?', db.seal(workspaceId, title), conv.id, conv.title);
}

function hasDefaultTitle(db: Db, conv: ConversationRow): boolean {
  const name = db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', conv.agent_id)?.name;
  return !!name && (conv.title === `Conversa com ${name}` || conv.title === clip(`Conversa com ${name}`, 80));
}

export function listMessages(db: Db, workspaceId: string, userId: string, conversationId: string) {
  getConversation(db, workspaceId, userId, conversationId);
  const rows = db.all<{ id: string } & Record<string, unknown>>(
    `SELECT m.id, m.role, m.content, m.mode, m.run_id, m.created_at, m.queued, m.reply_to, r.status AS run_status
       FROM messages m LEFT JOIN runs r ON r.id = m.run_id
      WHERE m.conversation_id = ? AND m.workspace_id = ? ORDER BY m.created_at, m.id LIMIT 500`, conversationId, workspaceId);
  const files = attachmentsOf(db, workspaceId, rows.map((r) => r.id));
  // entrega de cards: a mensagem leva os cards dela (estado e rodada), para "Revisar" ali mesmo
  const delivered = new Map<string, Array<{ id: string; number: number; title: string; completed: number; work_state: string | null; review_round: number }>>();
  for (const r of rows) {
    if (r.role !== 'agent' || !r.run_id) continue;
    const key = db.get<{ k: string }>('SELECT idempotency_key AS k FROM runs WHERE id = ?', r.run_id as string)?.k ?? '';
    if (!key.startsWith('entrega-')) continue;
    const origin = key.slice('entrega-'.length).replace(/#r\d+$/, '');
    delivered.set(r.id, db.all('SELECT id, number, title, completed, work_state, review_round FROM tasks WHERE origin_run_id = ? AND workspace_id = ? AND archived = 0 ORDER BY number', origin, workspaceId));
  }
  const marks = new Set(db.all<{ message_id: string }>('SELECT message_id FROM message_marks WHERE user_id = ? AND workspace_id = ?', userId, workspaceId).map((m) => m.message_id));
  return rows.map((r) => ({ ...r, ...(files.has(r.id) ? { attachments: files.get(r.id) } : {}), ...(delivered.get(r.id)?.length ? { cards: delivered.get(r.id) } : {}), ...(marks.has(r.id) ? { marked: 1 } : {}) }));
}

/**
 * A pessoa escreveu na conversa: ela está lida e a marcação de prioridade do agente sai (a pessoa respondeu). A
 * pendência que o colega puxou ("opa, tá online?") conta como respondida quando a mensagem vai ao agente
 * (chatHooks.replyContext, que também traz o cartão para cá).
 */
function onUserMessage(db: Db, _workspaceId: string, conv: ConversationRow): void {
  db.run('UPDATE conversations SET read_at = ?, priority = NULL, priority_reason = NULL, priority_at = NULL WHERE id = ?', now(), conv.id);
}

/**
 * Ganchos de quem monta o servidor: a iniciativa da equipe (o colega que puxou conversa recebe, quando a pessoa
 * responde, o que precisa explicar). Ficam aqui para a conversa não depender da iniciativa.
 */
export const chatHooks: { replyContext?: (workspaceId: string, userId: string, agentId: string, conversationId: string) => string | null } = {};

/** Arquivo sem texto: o colega lê e já devolve algo útil, sem perguntar o que fazer. */
const FILE_ONLY_NOTE = 'A pessoa mandou arquivo(s) sem escrever nada. Leia e já devolva algo útil: o que é, em uma frase, e o que chama atenção (ou faça o óbvio, se a conversa já pedia isso). Termine dizendo o que você pode fazer com ele, em uma frase, sem cardápio de opções.';

const CHANNEL_NOTE = 'Canal: conversa no Ergon. Quem escreve é a pessoa dona do workspace, autenticada.';

/**
 * `note`: instrução extra do canal (ex.: preparo de rotina); `plain`: não interpretar a mensagem por regras (sem tarefa
 * nem regra); `queue`: com uma resposta em andamento, a mensagem entra na fila da conversa (Ctrl+Enter) e vai para o
 * agente quando ele terminar, em vez de ser recusada.
 */
export interface SendOptions { note?: string | null; plain?: boolean; queue?: boolean; /** arquivos já enviados (Documentos) */ attachments?: string[]; /** responde citando esta mensagem (da mesma conversa) */ replyTo?: string | null }

export function sendMessage(db: Db, bus: Bus, executor: RunExecutor, workspaceId: string, userId: string, conversationId: string,
  text: string, clientRequestId: string, maxMessages: number, maxChars: number, opts: SendOptions = {}) {
  const content = text.trim();
  if (!content && !opts.attachments?.length) throw new HttpError(400, 'empty', 'mensagem vazia');
  if (content.length > maxChars) throw new HttpError(400, 'too_long', `mensagem acima de ${maxChars} caracteres`);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) throw new HttpError(400, 'client_request_id', 'identificador de pedido inválido');
  const conv = getConversation(db, workspaceId, userId, conversationId);

  // reenvio do mesmo pedido (resposta perdida) não duplica mensagem, tarefa nem execução
  const dup = db.get<{ id: string; run_id: string | null; queued: number }>('SELECT id, run_id, queued FROM messages WHERE conversation_id = ? AND client_request_id = ?', conversationId, clientRequestId);
  if (dup) return { messageId: dup.id, runId: dup.run_id, summary: null, replayed: true, queued: !!dup.queued };

  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId);
  if (Number(count?.n ?? 0) >= maxMessages) throw new HttpError(409, 'conversation_full', 'Conversa muito longa: inicie uma nova conversa.');
  // conversa que já tem mensagem da pessoa (as antigas, inclusive) não muda de nome
  const naming = !db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND role = 'user' LIMIT 1", conversationId) && hasDefaultTitle(db, conv);

  const busyRun = db.get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", conversationId);
  const waiting = db.get('SELECT 1 AS x FROM messages WHERE conversation_id = ? AND queued = 1 LIMIT 1', conversationId);
  if (busyRun || waiting) {
    if (!opts.queue) throw new HttpError(409, 'busy', 'Ainda há uma resposta em andamento nesta conversa: aguarde, cancele ou use Ctrl+Enter para pôr a mensagem na fila.');
    const messageId = id('msg');
    db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, client_request_id, queued, created_at)
            VALUES (?, ?, ?, 'user', ?, ?, 'local', ?, 1, ?)`, messageId, workspaceId, conversationId, userId, db.seal(workspaceId, content), clientRequestId, now());
    const files = opts.attachments?.length ? attachToMessage(db, workspaceId, userId, messageId, opts.attachments) : [];
    onUserMessage(db, workspaceId, conv);
    if (naming) nameAfterFirstMessage(db, workspaceId, conv, content || files.map((x) => x.filename).join(', '));
    bus.publish(workspaceId, 'messages.changed', { conversationId });
    return { messageId, runId: null, summary: null, replayed: false, queued: true };
  }
  const out = db.tx(() => {
    const messageId = id('msg');
    db.run(
      `INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, client_request_id, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, 'local', ?, ?)`, messageId, workspaceId, conversationId, userId, db.seal(workspaceId, content), clientRequestId, now());
    const files = opts.attachments?.length ? attachToMessage(db, workspaceId, userId, messageId, opts.attachments) : [];
    if (opts.replyTo && db.get('SELECT 1 AS x FROM messages WHERE id = ? AND conversation_id = ?', opts.replyTo, conversationId)) db.run('UPDATE messages SET reply_to = ? WHERE id = ?', opts.replyTo, messageId);
    onUserMessage(db, workspaceId, conv);
    if (naming) nameAfterFirstMessage(db, workspaceId, conv, content || files.map((x) => x.filename).join(', '));
    return handOver(db, bus, executor, workspaceId, userId, conv, messageId, content, opts);
  });
  bus.publish(workspaceId, 'messages.changed', { conversationId });
  return out;
}

/**
 * A mensagem do usuário vai para o agente da conversa. Por regras, só os comandos explícitos agem sozinhos (criar,
 * corrigir ou concluir um card, pendências, regras, reorganizar a equipe); o pedido implícito fica com o agente, que
 * faz, pede ajuda ou — se é o coordenador — planeja (purpose.ts). Card criado aqui leva a conversa: a entrega volta.
 */
function handOver(db: Db, bus: Bus, executor: RunExecutor, workspaceId: string, userId: string, conv: ConversationRow, messageId: string, content: string, opts: SendOptions) {
  const conversationId = conv.id;
  const files = db.all<AttachmentInfo>(
    'SELECT a.id, a.filename, a.mime, a.size FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ? ORDER BY a.created_at', messageId);
  const profile = db.get<{ creates_tasks: 'demands' | 'explicit_only'; char_key: string | null; skey: string; tools: string | null; coordinator: number }>(
    'SELECT p.creates_tasks, a.char_key, p.key AS skey, a.tools, a.coordinator FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.id = ?', conv.agent_id);
  // reorganizar a equipe (ou apagar um card) conversando: com o Coordenador, a frase vira proposta (você aplica)
  const command = !opts.plain && profile && isCoordinator(profile) ? parseChatCommand(content) : null;
  const interp = interpretRules(content);
  const decision = command ? { kind: 'none' as const, reason: 'pedido de mudança na equipe' }
    : opts.plain ? { kind: 'none' as const, reason: 'conversa de preparo' }
    : decide(interp, { profileCreates: profile?.creates_tasks ?? 'explicit_only', canCommand: true, observeOnly: false, implicitDemands: false }, content);
  const result = command
    ? { summary: 'Proposta registrada: aplique ou recuse aqui na conversa.', taskId: null, taskNumber: null, reply: null }
    : applyDecision(db, bus, workspaceId, { type: 'user', id: userId }, decision, { origin: 'chat', messageId, agentId: conv.agent_id });
  if (command) recordProposals(db, bus, workspaceId, { conversationId, runId: null }, [command]);
  const acted = !!command || (decision.kind !== 'none' && decision.kind !== 'clarify');
  const reply = opts.plain ? null : chatHooks.replyContext?.(workspaceId, userId, conv.agent_id, conversationId) ?? null;
  const fork = forkContext(db, conversationId);
  // respondendo a uma mensagem: o colega sabe a qual
  const quoted = db.get<{ content: string; role: string }>('SELECT q.content, q.role FROM messages m JOIN messages q ON q.id = m.reply_to WHERE m.id = ?', messageId);
  const quote = quoted ? `A pessoa está respondendo a esta mensagem ${quoted.role === 'user' ? 'dela' : 'sua'}: “${clip(quoted.content.replace(/\s+/g, ' '), 2000)}”` : null;
  if (!opts.plain && acted) {
    db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)`,
      id('msg'), workspaceId, conversationId, db.seal(workspaceId, `Sistema — ${result.summary}`), now());
  }
  const run = executor.enqueue({
    workspaceId, agentId: conv.agent_id, conversationId, kind: 'chat', input: [content, attachmentLine(files)].filter(Boolean).join('\n'),
    // o agente precisa saber o que o sistema já aplicou, para não "propor" de novo um card já criado
    instructions: instructionsFor(db, workspaceId, conv.agent_id,
      [CHANNEL_NOTE, opts.note ?? '', reply ?? '', fork ?? '', quote ?? '', files.length && !content ? FILE_ONLY_NOTE : '', !opts.plain && acted ? `Ação já aplicada pelo sistema para esta mensagem (fato, não repita como proposta): ${result.summary}` : ''].filter(Boolean).join('\n'),
      { requests: !opts.plain, userId }),
    idempotencyKey: `chat-${messageId}`,
  });
  db.run('UPDATE messages SET run_id = ?, queued = 0 WHERE id = ?', run.id, messageId);
  // card pedido explicitamente na conversa ("/tarefa …"): quando terminar, o agente da conversa entrega aqui
  if (result.taskId && decision.kind === 'create_task') {
    db.run('UPDATE tasks SET conversation_id = ?, purpose = ?, deliver_agent_id = ?, origin_run_id = ? WHERE id = ?',
      conversationId, db.seal(workspaceId, clip(content, 200_000)), conv.agent_id, run.id, result.taskId);
  }
  return { messageId, runId: run.id, summary: acted ? result.summary : null, replayed: false, queued: false };
}

/**
 * A próxima mensagem da fila da conversa (Ctrl+Enter), quando a conversa fica livre. true = enviada ao agente.
 */
export function sendQueued(db: Db, bus: Bus, executor: RunExecutor, workspaceId: string, conversationId: string, opts: SendOptions = {}): boolean {
  if (db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", conversationId)) return false;
  const m = db.get<{ id: string; content: string; author_user_id: string | null }>(
    'SELECT id, content, author_user_id FROM messages WHERE conversation_id = ? AND workspace_id = ? AND queued = 1 ORDER BY created_at, rowid LIMIT 1', conversationId, workspaceId);
  if (!m?.author_user_id) return false;
  const conv = getConversation(db, workspaceId, m.author_user_id, conversationId);
  db.tx(() => handOver(db, bus, executor, workspaceId, m.author_user_id!, conv, m.id, m.content, opts));
  bus.publish(workspaceId, 'messages.changed', { conversationId });
  return true;
}

/**
 * Conversas da pessoa, pela última atividade de qualquer um (decisão de 30/10: com o ponto de não lida, o que o colega
 * escreve também sobe), com o que ela ainda não leu, a marca de prioridade, o que espera por ela e a última fala.
 * Conversas de rotina ficam de fora.
 */
export function recentConversations(db: Db, workspaceId: string, userId: string, max = 60) {
  const rows = db.all<{ id: string; agent_id: string; title: string; created_at: string; last_user_at: string | null; last_at: string | null;
    pinned_at: string | null; priority: 'urgente' | 'alta' | null; priority_reason: string | null; unread: number; waiting: number; last_text: string | null; last_role: string | null; last_files: number;
    ag_name: string; ag_role: string; ag_color: string; ag_char_key: string | null; ag_look_seed: number | null; ag_sector_name: string }>(
    `SELECT c.id, c.agent_id, c.title, c.created_at, c.pinned_at, c.priority, c.priority_reason,
            a.name AS ag_name, a.role AS ag_role, a.color AS ag_color, a.char_key AS ag_char_key, a.look_seed AS ag_look_seed, p.name AS ag_sector_name,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'agent' AND m.created_at > COALESCE(c.read_at, '')) AS unread,
            (SELECT COUNT(*) FROM agent_proposals p WHERE p.workspace_id = c.workspace_id AND p.status = 'proposed'
                AND (p.conversation_id = c.id OR p.id IN (SELECT l.proposal_id FROM proposal_links l WHERE l.conversation_id = c.id))) AS waiting,
            (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
            (SELECT m.role FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_role,
            (SELECT COUNT(*) FROM message_attachments ma WHERE ma.message_id = (SELECT m.id FROM messages m WHERE m.conversation_id = c.id AND m.role != 'system' ORDER BY m.created_at DESC, m.id DESC LIMIT 1)) AS last_files
       FROM conversations c JOIN agents a ON a.id = c.agent_id JOIN profiles p ON p.id = a.profile_id
      WHERE c.workspace_id = ? AND c.owner_user_id = ? AND c.purpose IS NULL AND a.status = 'active' AND c.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'agent'))
      ORDER BY COALESCE(last_at, c.created_at) DESC LIMIT ?`, workspaceId, userId, max);
  // a última fala, curta e sem as linhas de controle dos agentes; o colega leve (retrato e nome, sem a lista da equipe)
  return rows.map(({ last_files, ag_name, ag_role, ag_color, ag_char_key, ag_look_seed, ag_sector_name, ...r }) => {
    const said = r.last_text ? clip(r.last_text.replace(/\[\[[^\]]*(?:\][^\]]+)*\]\]/g, ' ').replace(/\[imagem: [^\]]*\]/g, '🖼').replace(/[*#_`>|]/g, '').replace(/\s+/g, ' ').trim(), 90) : '';
    const files = Number(last_files) ? `📎 ${Number(last_files) === 1 ? '1 arquivo' : `${last_files} arquivos`}` : '';
    const agent = { id: r.agent_id, name: ag_name, role: ag_role, color: ag_color, char_key: ag_char_key, look_seed: ag_look_seed === null ? null : Number(ag_look_seed), sector_name: ag_sector_name };
    return { ...r, unread: Number(r.unread), waiting: Number(r.waiting), last_text: said || files || null, agent };
  });
}

/** Leu a conversa (aberta, à vista e até o fim). */
export function markRead(db: Db, bus: Bus, workspaceId: string, userId: string, conversationId: string): void {
  getConversation(db, workspaceId, userId, conversationId);
  db.run('UPDATE conversations SET read_at = ? WHERE id = ?', now(), conversationId);
  bus.publish(workspaceId, 'conversations.changed', { id: conversationId });
}

/** Fixa (ou solta) a conversa no topo da lista. */
export function setPinned(db: Db, bus: Bus, workspaceId: string, userId: string, conversationId: string, pinned: boolean): void {
  getConversation(db, workspaceId, userId, conversationId);
  db.run('UPDATE conversations SET pinned_at = ? WHERE id = ?', pinned ? now() : null, conversationId);
  bus.publish(workspaceId, 'conversations.changed', { id: conversationId });
}

/** Mensagem ainda na fila (não foi ao agente): a pessoa edita ou tira. */
function queuedOf(db: Db, workspaceId: string, userId: string, messageId: string) {
  const m = db.get<{ id: string; conversation_id: string }>("SELECT id, conversation_id FROM messages WHERE id = ? AND workspace_id = ? AND author_user_id = ? AND role = 'user' AND queued = 1", messageId, workspaceId, userId);
  if (!m) throw new HttpError(409, 'not_queued', 'essa mensagem já foi para o agente');
  return m;
}
export function editQueued(db: Db, bus: Bus, workspaceId: string, userId: string, messageId: string, text: string, maxChars: number): void {
  const t = text.trim();
  if (!t) throw new HttpError(400, 'empty', 'mensagem vazia');
  if (t.length > maxChars) throw new HttpError(400, 'too_long', `mensagem acima de ${maxChars} caracteres`);
  const m = queuedOf(db, workspaceId, userId, messageId);
  db.run('UPDATE messages SET content = ? WHERE id = ?', db.seal(workspaceId, t), m.id);
  bus.publish(workspaceId, 'messages.changed', { conversationId: m.conversation_id });
}
export function removeQueued(db: Db, bus: Bus, workspaceId: string, userId: string, messageId: string): void {
  const m = queuedOf(db, workspaceId, userId, messageId);
  db.run('DELETE FROM message_attachments WHERE message_id = ?', m.id);
  db.run('DELETE FROM messages WHERE id = ?', m.id);
  bus.publish(workspaceId, 'messages.changed', { conversationId: m.conversation_id });
}

/**
 * "Tentar de novo" depois de uma falha (ou parada): a última mensagem da pessoa volta para o agente numa execução nova,
 * sem duplicar a mensagem nem reaplicar o que o sistema já fez com ela.
 */
export function retryLast(db: Db, bus: Bus, executor: RunExecutor, workspaceId: string, userId: string, conversationId: string) {
  const conv = getConversation(db, workspaceId, userId, conversationId);
  if (db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", conversationId)) {
    throw new HttpError(409, 'busy', 'ainda há uma resposta em andamento nesta conversa');
  }
  const m = db.get<{ id: string; content: string; run_id: string | null }>(
    "SELECT id, content, run_id FROM messages WHERE conversation_id = ? AND role = 'user' AND queued = 0 ORDER BY created_at DESC, id DESC LIMIT 1", conversationId);
  if (!m) throw new HttpError(409, 'nothing', 'não há mensagem sua para repetir');
  const last = m.run_id ? db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', m.run_id)?.status : null;
  if (last === 'succeeded') throw new HttpError(409, 'answered', 'essa mensagem já foi respondida');
  const files = db.all<AttachmentInfo>('SELECT a.id, a.filename, a.mime, a.size FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ?', m.id);
  const n = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE idempotency_key LIKE ?", `chat-${m.id}%`)?.n ?? 0);
  const run = executor.enqueue({
    workspaceId, agentId: conv.agent_id, conversationId, kind: 'chat', input: [m.content, attachmentLine(files)].filter(Boolean).join('\n'),
    instructions: instructionsFor(db, workspaceId, conv.agent_id, [CHANNEL_NOTE, files.length && !m.content ? FILE_ONLY_NOTE : ''].filter(Boolean).join('\n'), { requests: true, userId }),
    idempotencyKey: `chat-${m.id}-de-novo-${n}`,
  });
  db.run('UPDATE messages SET run_id = ? WHERE id = ?', run.id, m.id);
  bus.publish(workspaceId, 'messages.changed', { conversationId });
  return { runId: run.id };
}

/** Cards que saíram desta conversa e ainda estão andando (o "parar também o card"). */
export function activeCardsOf(db: Db, workspaceId: string, userId: string, conversationId: string) {
  getConversation(db, workspaceId, userId, conversationId);
  return db.all<{ id: string; number: number; title: string }>(
    `SELECT t.id, t.number, t.title FROM tasks t WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.archived = 0 AND t.completed = 0
        AND EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
      ORDER BY t.number`, workspaceId, conversationId);
}
