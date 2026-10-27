import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, clip, id, now } from '../lib/util.ts';
import { applyDecision } from './actions.ts';
import { audit, type Bus } from './bus.ts';
import { decide, interpretRules } from './interpret.ts';

/** Evento de canal já normalizado (Teams/WhatsApp: leitor por QR, ponte do motor ou simulação de teste). */
export interface InboundEvent {
  platform: 'teams' | 'whatsapp';
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
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  status: string;
  /** devolvido ao gateway: 'handled' consome sem turno do agente; 'continue' deixa o motor responder */
  action: 'handled' | 'continue';
  reply: string | null;
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

export function findConnection(db: Db, workspaceId: string | null, kind: string, mode: 'fixture' | 'real'): ConnRow {
  // Conexão real é única na instalação local: o workspace vem dela, nunca do payload.
  const c = workspaceId
    ? db.get<ConnRow>('SELECT id, workspace_id, kind, mode, profile_key FROM connections WHERE workspace_id = ? AND kind = ? AND mode = ?', workspaceId, kind, mode)
    : db.get<ConnRow>('SELECT id, workspace_id, kind, mode, profile_key FROM connections WHERE kind = ? AND mode = ? ORDER BY created_at LIMIT 1', kind, mode);
  if (!c) throw new HttpError(404, 'connection', 'conexão não configurada');
  return c;
}

interface Policy { allowed: boolean; canCommand: boolean; observeOnly: boolean; status: string; storeText: boolean; createsDemands?: boolean }

function policyFor(db: Db, cfg: Config, conn: ConnRow, e: InboundEvent): Policy {
  const ident = e.actorId
    ? db.get<{ can_command: number }>('SELECT can_command FROM external_identities WHERE connection_id = ? AND external_user_id = ?', conn.id, e.actorId)
    : undefined;
  if (e.platform === 'teams') {
    const expectedTenant = conn.mode === 'real' ? cfg.teams.tenantId : 'fixture-tenant';
    if (expectedTenant && e.tenantId && e.tenantId !== expectedTenant) {
      return { allowed: false, canCommand: false, observeOnly: true, status: 'rejected_tenant', storeText: false };
    }
    if (!ident) return { allowed: false, canCommand: false, observeOnly: true, status: 'rejected_identity', storeText: false };
    return { allowed: true, canCommand: !!ident.can_command, observeOnly: false, status: 'accepted', storeText: true };
  }
  // WhatsApp lido por QR: os filtros do usuário já decidiram; observação apenas (o leitor não envia nada).
  if (e.preFiltered && conn.mode === 'real') return { allowed: true, canCommand: false, observeOnly: !e.createDemands, createsDemands: !!e.createDemands, status: 'accepted', storeText: true };
  // WhatsApp: observação de chats selecionados; comandos só da identidade do proprietário.
  const monitored = conn.mode === 'real'
    ? (e.chatId !== null && cfg.whatsapp.monitoredChats.includes(e.chatId))
    : (e.chatId !== null && FIXTURE_MONITORED.has(e.chatId));
  const isOwner = !!ident?.can_command;
  if (!monitored && !isOwner) return { allowed: false, canCommand: false, observeOnly: true, status: 'ignored_not_monitored', storeText: false };
  const ownerDm = isOwner && e.chatType === 'dm';
  return { allowed: true, canCommand: ownerDm, observeOnly: !ownerDm, status: 'accepted', storeText: true };
}

export const FIXTURE_MONITORED = new Set(['fixture-grupo-projeto@g.us', 'fixture-cliente-a@s.whatsapp.net']);

/**
 * Entrada → normalização → deduplicação → interpretação → política → ação autorizada → log/SSE.
 * Chave única: conexão + ID externo + tipo + versão. Reentrega devolve a mesma decisão.
 */
export function ingestEvent(db: Db, bus: Bus, cfg: Config, conn: ConnRow, e: InboundEvent, isFixture: boolean): IngestResult {
  validateInbound(e);
  if (conn.kind !== e.platform) throw new HttpError(400, 'platform', 'plataforma não corresponde à conexão');
  const workspaceId = conn.workspace_id;

  const existing = db.get<{ id: string; status: string; decision: string | null; task_id: string | null }>(
    'SELECT id, status, decision, task_id FROM source_events WHERE connection_id = ? AND external_id = ? AND event_type = ? AND version = ?',
    conn.id, e.externalId, e.eventType, e.version);
  if (existing) {
    const prev = existing.decision ? JSON.parse(existing.decision) as Partial<IngestResult> : {};
    return {
      eventId: existing.id, duplicate: true, status: existing.status, action: prev.action ?? 'handled', reply: prev.reply ?? null,
      taskId: existing.task_id, summary: 'evento repetido (reentrega): nenhuma nova ação',
    };
  }

  const result = db.tx(() => {
    const eventId = id('evt');
    const pol = e.isFromBot
      ? { allowed: false, canCommand: false, observeOnly: true, status: 'ignored_echo', storeText: false }
      : policyFor(db, cfg, conn, e);
    const status = e.eventType === 'message_edit' && pol.allowed ? 'edit_logged' : pol.status;
    db.run(
      `INSERT INTO source_events (id, workspace_id, connection_id, external_id, event_type, version, actor_external_id, actor_display,
         channel, thread_id, provider_ts, received_at, is_fixture, text_excerpt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId, workspaceId, conn.id, e.externalId, e.eventType, e.version, e.actorId, db.seal(workspaceId, pol.storeText ? clip(e.actorName ?? '', 80) : null),
      e.chatId, e.threadId, e.providerTs, now(), isFixture ? 1 : 0, db.seal(workspaceId, pol.storeText ? clip(e.text, 500) : null), status);

    let out: IngestResult = { eventId, duplicate: false, status, action: 'handled', reply: null, taskId: null, summary: '' };
    if (!pol.allowed) {
      out.summary = { ignored_echo: 'eco do próprio bot ignorado', rejected_identity: 'identidade externa não autorizada', rejected_tenant: 'tenant diferente do configurado', ignored_not_monitored: 'chat não monitorado (texto não armazenado)' }[pol.status] ?? pol.status;
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
      const decision = decide(interp, { profileCreates: profile?.creates_tasks ?? 'explicit_only', canCommand: pol.canCommand, observeOnly: pol.observeOnly, createsDemands: pol.createsDemands }, e.text);
      const r = applyDecision(db, bus, workspaceId, { type: 'connector', id: conn.id }, decision, {
        origin: e.platform, sourceEventId: eventId, isFixture,
      });
      db.run('UPDATE source_events SET interpretation = ?, task_id = ? WHERE id = ?', JSON.stringify({ category: interp.category, action: interp.proposed_action, decision: decision.kind, reason: decision.reason }), r.taskId, eventId);
      out = { ...out, taskId: r.taskId, summary: r.summary };
      if (e.platform === 'teams') {
        // Comandos respondidos pelo Ergon; conversa livre segue para o agente no motor (modo real).
        out.reply = r.reply;
        out.action = r.reply ? 'handled' : (isFixture ? 'handled' : 'continue');
        if (isFixture && !r.reply) out.reply = `[Simulação] Mensagem registrada no Ergon (${interp.category}). ${r.summary}`;
      } else {
        // WhatsApp: nunca responde automaticamente; resposta só a comando do proprietário com envio habilitado.
        out.action = 'handled';
        out.reply = pol.canCommand && r.reply && conn.mode === 'real' && cfg.whatsapp.sendEnabled ? r.reply : null;
        if (pol.canCommand && r.reply && !out.reply) {
          queueOutbox(db, workspaceId, conn.id, eventId, e.chatId ?? '', r.reply, isFixture ? 'simulated' : 'blocked_send_disabled');
        }
      }
    }
    if (out.reply) {
      queueOutbox(db, workspaceId, conn.id, eventId, e.chatId ?? '', out.reply, isFixture ? 'simulated' : 'returned_to_gateway');
    }
    if (!isFixture && pol.allowed) db.run('UPDATE connections SET last_real_event_at = ?, last_error = NULL WHERE id = ?', now(), conn.id);
    db.run('UPDATE source_events SET decision = ? WHERE id = ?', JSON.stringify({ action: out.action, reply: out.reply }), eventId);
    audit(db, null, {
      workspaceId, actorType: 'connector', actorId: conn.id, action: `source.${e.platform}.${status}`, targetType: 'source_event', targetId: eventId,
      evidence: { fixture: isFixture, externalId: e.externalId, summary: out.summary }, result: out.action,
    });
    return out;
  });
  bus.publish(workspaceId, 'events.changed', { id: result.eventId });
  if (result.taskId) bus.publish(workspaceId, 'tasks.changed', { id: result.taskId });
  return result;
}

function queueOutbox(db: Db, workspaceId: string, connectionId: string, eventId: string, target: string, body: string, status: string): void {
  const ts = now();
  db.run(
    `INSERT INTO outbox (id, workspace_id, connection_id, source_event_id, idempotency_key, target, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
    id('out'), workspaceId, connectionId, eventId, `reply:${eventId}`, clip(target, 200), db.seal(workspaceId, clip(body, 4000)), status, ts, ts);
}

/** Identidades externas autorizadas, sempre por ID estável do provedor (nunca nome de exibição). */
export function upsertIdentity(db: Db, conn: ConnRow, externalUserId: string, displayName: string | null, canCommand: boolean): void {
  db.run(
    `INSERT INTO external_identities (id, workspace_id, connection_id, external_user_id, display_name, can_command, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, external_user_id) DO UPDATE SET can_command = excluded.can_command, display_name = excluded.display_name`,
    id('xid'), conn.workspace_id, conn.id, externalUserId, displayName, canCommand ? 1 : 0, now());
}

/** Na inicialização: identidades reais vêm só da configuração local (.env), não do chat. */
export function syncConfiguredIdentities(db: Db, cfg: Config): void {
  const teams = db.all<ConnRow>("SELECT id, workspace_id, kind, mode, profile_key FROM connections WHERE kind = 'teams' AND mode = 'real'");
  for (const c of teams) {
    db.run('UPDATE external_identities SET can_command = 0 WHERE connection_id = ?', c.id);
    for (const u of cfg.teams.allowedUsers) upsertIdentity(db, c, u, null, true);
  }
  const wa = db.all<ConnRow>("SELECT id, workspace_id, kind, mode, profile_key FROM connections WHERE kind = 'whatsapp' AND mode = 'real'");
  for (const c of wa) {
    db.run('UPDATE external_identities SET can_command = 0 WHERE connection_id = ?', c.id);
    for (const u of cfg.whatsapp.ownerIds) upsertIdentity(db, c, u, null, true);
  }
}
