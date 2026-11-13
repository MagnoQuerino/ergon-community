import type { Db } from '../db/db.ts';
import { HttpError, clip, id, now } from '../lib/util.ts';
import { applyDecision } from './actions.ts';
import { audit, type Bus } from './bus.ts';
import { decide, interpretRules } from './interpret.ts';

/**
 * Mensagem de canal já normalizada. Hoje só o leitor de WhatsApp por QR (services/whatsapp.ts) manda eventos para
 * cá; o canal antigo de Teams e WhatsApp pelo gateway do motor saiu na rc.29.
 */
export interface InboundEvent {
  platform: 'whatsapp';
  externalId: string;
  eventType: 'message' | 'message_edit';
  version: string;
  actorId: string | null;
  actorName: string | null;
  chatId: string | null;
  chatType: 'dm' | 'group' | 'channel' | null;
  threadId: string | null;
  tenantId: string | null;
  providerTs: string | null;
  text: string;
  isFromBot: boolean;
  /** já passou pelos filtros do usuário (leitor de WhatsApp por QR): sem comandos de quem escreveu */
  preFiltered?: boolean;
  /** pedidos identificados viram card para a triagem da equipe (opção do usuário nos filtros) */
  createDemands?: boolean;
  /** por qual conta chegou (o id da linha em integrations: o número do WhatsApp, quando há mais de um) */
  integracaoId?: string | null;
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  status: string;
  taskId: string | null;
  summary: string;
}

const EXT_ID = /^[\w:.@+=/-]{1,200}$/;

export function validateInbound(e: InboundEvent): void {
  if (!EXT_ID.test(e.externalId)) throw new HttpError(400, 'external_id', 'ID externo inválido');
  if (!/^[\w.-]{1,40}$/.test(e.version)) throw new HttpError(400, 'version', 'versão inválida');
  if (typeof e.text !== 'string' || e.text.length > 8000) throw new HttpError(400, 'text', 'texto inválido');
  if (e.actorId !== null && (typeof e.actorId !== 'string' || e.actorId.length > 200)) throw new HttpError(400, 'actor', 'ator inválido');
}

interface ConnRow { id: string; workspace_id: string; kind: string; mode: string; profile_key: string }

export function findConnection(db: Db, workspaceId: string, kind: string, mode: 'fixture' | 'real'): ConnRow {
  const c = db.get<ConnRow>('SELECT id, workspace_id, kind, mode, profile_key FROM connections WHERE workspace_id = ? AND kind = ? AND mode = ?', workspaceId, kind, mode);
  if (!c) throw new HttpError(404, 'connection', 'conexão não configurada');
  return c;
}

interface Policy { allowed: boolean; observeOnly: boolean; status: string; storeText: boolean; createsDemands?: boolean }

function policyFor(conn: ConnRow, e: InboundEvent): Policy {
  // WhatsApp lido por QR: os filtros do usuário já decidiram; observação apenas (o leitor não envia nada).
  if (e.preFiltered && conn.mode === 'real') return { allowed: true, observeOnly: !e.createDemands, createsDemands: !!e.createDemands, status: 'accepted', storeText: true };
  // qualquer outra entrada (que não passou pelos filtros da pessoa): registrada sem texto e sem ação
  return { allowed: false, observeOnly: true, status: 'ignored_not_monitored', storeText: false };
}

/**
 * Entrada → deduplicação → interpretação → política → ação autorizada → log/SSE.
 * Chave única: conexão + ID externo + tipo + versão. Reentrega devolve a mesma decisão. Nunca responde a ninguém:
 * comando de quem escreveu não vale (a conversa com a equipe é pelo app, pelo Telegram, pelo Discord ou pelo Teams).
 */
export function ingestEvent(db: Db, bus: Bus, conn: ConnRow, e: InboundEvent): IngestResult {
  validateInbound(e);
  if (conn.kind !== e.platform) throw new HttpError(400, 'platform', 'plataforma não corresponde à conexão');
  const workspaceId = conn.workspace_id;

  const existing = db.get<{ id: string; status: string; task_id: string | null }>(
    'SELECT id, status, task_id FROM source_events WHERE connection_id = ? AND external_id = ? AND event_type = ? AND version = ?',
    conn.id, e.externalId, e.eventType, e.version);
  if (existing) {
    return { eventId: existing.id, duplicate: true, status: existing.status, taskId: existing.task_id, summary: 'evento repetido (reentrega): nenhuma nova ação' };
  }

  const result = db.tx(() => {
    const eventId = id('evt');
    const pol: Policy = e.isFromBot
      ? { allowed: false, observeOnly: true, status: 'ignored_echo', storeText: false }
      : policyFor(conn, e);
    const status = e.eventType === 'message_edit' && pol.allowed ? 'edit_logged' : pol.status;
    db.run(
      `INSERT INTO source_events (id, workspace_id, connection_id, external_id, event_type, version, actor_external_id, actor_display,
         channel, thread_id, provider_ts, received_at, is_fixture, text_excerpt, status, integracao_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      eventId, workspaceId, conn.id, e.externalId, e.eventType, e.version, e.actorId, db.seal(workspaceId, pol.storeText ? clip(e.actorName ?? '', 80) : null),
      e.chatId, e.threadId, e.providerTs, now(), db.seal(workspaceId, pol.storeText ? clip(e.text, 500) : null), status, e.integracaoId ?? null);

    let out: IngestResult = { eventId, duplicate: false, status, taskId: null, summary: '' };
    if (!pol.allowed) {
      out.summary = { ignored_echo: 'eco do próprio número ignorado', ignored_not_monitored: 'chat não monitorado (texto não armazenado)' }[pol.status] ?? pol.status;
    } else if (e.eventType === 'message_edit') {
      // edição não vira nova demanda; registra no card de origem, sem alterar campos
      const orig = db.get<{ task_id: string | null }>(
        "SELECT task_id FROM source_events WHERE connection_id = ? AND external_id = ? AND event_type = 'message' ORDER BY received_at LIMIT 1", conn.id, e.externalId);
      if (orig?.task_id) {
        db.run('UPDATE source_events SET task_id = ? WHERE id = ?', orig.task_id, eventId);
        audit(db, null, { workspaceId, actorType: 'connector', actorId: conn.id, action: 'source.edited', targetType: 'task', targetId: orig.task_id, evidence: { eventId, excerpt: clip(e.text, 200) }, result: 'registrado; card não alterado' });
      }
      out = { ...out, taskId: orig?.task_id ?? null, summary: 'edição registrada; não cria nova demanda' };
    } else {
      const profile = db.get<{ creates_tasks: 'demands' | 'explicit_only' }>('SELECT creates_tasks FROM profiles WHERE workspace_id = ? AND key = ?', workspaceId, conn.profile_key);
      const interp = interpretRules(e.text);
      const decision = decide(interp, { profileCreates: profile?.creates_tasks ?? 'explicit_only', canCommand: false, observeOnly: pol.observeOnly, createsDemands: pol.createsDemands }, e.text);
      const r = applyDecision(db, bus, workspaceId, { type: 'connector', id: conn.id }, decision, { origin: e.platform, sourceEventId: eventId });
      db.run('UPDATE source_events SET interpretation = ?, task_id = ? WHERE id = ?', JSON.stringify({ category: interp.category, action: interp.proposed_action, decision: decision.kind, reason: decision.reason }), r.taskId, eventId);
      out = { ...out, taskId: r.taskId, summary: r.summary };
    }
    if (pol.allowed) db.run('UPDATE connections SET last_real_event_at = ?, last_error = NULL WHERE id = ?', now(), conn.id);
    db.run('UPDATE source_events SET decision = ? WHERE id = ?', JSON.stringify({ action: 'handled', reply: null }), eventId);
    audit(db, null, {
      workspaceId, actorType: 'connector', actorId: conn.id, action: `source.${e.platform}.${status}`, targetType: 'source_event', targetId: eventId,
      evidence: { externalId: e.externalId, summary: out.summary }, result: 'handled',
    });
    return out;
  });
  bus.publish(workspaceId, 'events.changed', { id: result.eventId });
  if (result.taskId) bus.publish(workspaceId, 'tasks.changed', { id: result.taskId });
  return result;
}
