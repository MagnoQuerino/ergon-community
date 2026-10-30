import type { Db } from '../db/db.ts';
import { HttpError, clip, id, notFound, now } from '../lib/util.ts';
import { applyDecision } from './actions.ts';
import type { Bus } from './bus.ts';
import { decide, interpretRules } from './interpret.ts';
import { instructionsFor, isCoordinator, type RunExecutor } from './runs.ts';
import { parseChatCommand, recordProposals } from './proposals.ts';

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
    `SELECT c.id, c.agent_id, c.title, c.created_at, c.purpose,
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
  return db.all(
    `SELECT m.id, m.role, m.content, m.mode, m.run_id, m.created_at, m.queued, r.status AS run_status
       FROM messages m LEFT JOIN runs r ON r.id = m.run_id
      WHERE m.conversation_id = ? AND m.workspace_id = ? ORDER BY m.created_at, m.id LIMIT 500`, conversationId, workspaceId);
}

const CHANNEL_NOTE = 'Canal: chat do Ergon. Quem escreve é o proprietário autenticado. Responda em texto curto.';

/**
 * `note`: instrução extra do canal (ex.: preparo de rotina); `plain`: não interpretar a mensagem por regras (sem tarefa
 * nem regra); `queue`: com uma resposta em andamento, a mensagem entra na fila da conversa (Ctrl+Enter) e vai para o
 * agente quando ele terminar, em vez de ser recusada.
 */
export interface SendOptions { note?: string | null; plain?: boolean; queue?: boolean }

export function sendMessage(db: Db, bus: Bus, executor: RunExecutor, workspaceId: string, userId: string, conversationId: string,
  text: string, clientRequestId: string, maxMessages: number, maxChars: number, opts: SendOptions = {}) {
  const content = text.trim();
  if (!content) throw new HttpError(400, 'empty', 'mensagem vazia');
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
    if (naming) nameAfterFirstMessage(db, workspaceId, conv, content);
    bus.publish(workspaceId, 'messages.changed', { conversationId });
    return { messageId, runId: null, summary: null, replayed: false, queued: true };
  }
  const out = db.tx(() => {
    const messageId = id('msg');
    db.run(
      `INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, client_request_id, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, 'local', ?, ?)`, messageId, workspaceId, conversationId, userId, db.seal(workspaceId, content), clientRequestId, now());
    if (naming) nameAfterFirstMessage(db, workspaceId, conv, content);
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
  if (!opts.plain && acted) {
    db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)`,
      id('msg'), workspaceId, conversationId, db.seal(workspaceId, `Sistema — ${result.summary}`), now());
  }
  const run = executor.enqueue({
    workspaceId, agentId: conv.agent_id, conversationId, kind: 'chat', input: content,
    // o agente precisa saber o que o sistema já aplicou, para não "propor" de novo um card já criado
    instructions: instructionsFor(db, workspaceId, conv.agent_id,
      [CHANNEL_NOTE, opts.note ?? '', !opts.plain && acted ? `Ação já aplicada pelo sistema para esta mensagem (fato, não repita como proposta): ${result.summary}` : ''].filter(Boolean).join('\n'),
      { requests: !opts.plain }),
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
 * Conversas da pessoa, da que ela ativou por último para a mais antiga: conta a última mensagem DELA (o que os
 * agentes escrevem sozinhos — entregas, pedidos repassados — não conta). Conversas de rotina ficam de fora.
 */
export function recentConversations(db: Db, workspaceId: string, userId: string, max = 30) {
  return db.all<{ id: string; agent_id: string; title: string; created_at: string; last_user_at: string; last_at: string | null }>(
    `SELECT c.id, c.agent_id, c.title, c.created_at,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS last_user_at,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at
       FROM conversations c JOIN agents a ON a.id = c.agent_id
      WHERE c.workspace_id = ? AND c.owner_user_id = ? AND c.purpose IS NULL AND a.status = 'active'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user')
      ORDER BY last_user_at DESC LIMIT ?`, workspaceId, userId, max);
}
