import { HttpError } from '../lib/util.ts';
import type { InboundEvent } from '../services/ingest.ts';

const safeVersion = (v: unknown) => String(v ?? '1').replace(/[^\w.-]/g, '-').slice(0, 40) || '1';
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

/**
 * Payload enviado pelo plugin ergon_bridge a partir do hook `post_gateway_admission` do Hermes
 * (após autenticação/allowlist do adapter). Somente campos em allowlist são aceitos.
 */
export interface BridgePayload {
  schema: 'ergon.bridge.v1';
  platform: string;
  message_id: string;
  text: string;
  event_type?: string;
  version?: string;
  source?: Record<string, unknown>;
}

export function normalizeBridge(p: BridgePayload): InboundEvent {
  if (p.schema !== 'ergon.bridge.v1') throw new HttpError(400, 'schema', 'schema de ponte desconhecido');
  if (p.platform !== 'teams' && p.platform !== 'whatsapp') throw new HttpError(400, 'platform', 'plataforma não suportada pela ponte');
  const s = p.source ?? {};
  const ct = String(s.chat_type ?? '').toLowerCase();
  // Conferido em Hermes v0.22.2: Teams põe aad_object_id em user_id e o tenant em scope_id/guild_id;
  // WhatsApp (bridge Baileys) usa JIDs em chat_id/user_id.
  const user = str(s.user_id);
  return {
    platform: p.platform,
    externalId: String(p.message_id ?? ''),
    eventType: p.event_type === 'message_edit' ? 'message_edit' : 'message',
    version: safeVersion(p.version),
    actorId: p.platform === 'whatsapp' && user ? user.split('@')[0].split(':')[0] : user,
    actorName: str(s.user_name, 80),
    chatId: str(s.chat_id),
    chatType: ['dm', 'direct', 'personal', 'private'].includes(ct) ? 'dm' : ct === 'group' ? 'group' : ct === 'channel' || ct === 'thread' ? 'channel' : null,
    threadId: str(s.thread_id),
    tenantId: str(s.tenant_id) ?? str(s.scope_id) ?? str(s.guild_id),
    providerTs: str(s.timestamp, 40),
    text: String(p.text ?? '').slice(0, 8000),
    isFromBot: s.is_bot === true || s.from_me === true,
  };
}

/** Atividade no formato Bot Framework (fixture local). */
export function normalizeTeamsActivity(a: Record<string, any>, botId: string | null): InboundEvent {
  const from = a.from ?? {};
  const conv = a.conversation ?? {};
  const isEdit = a.type === 'messageUpdate';
  const ct = String(conv.conversationType ?? '');
  return {
    platform: 'teams',
    externalId: String(a.id ?? ''),
    eventType: isEdit ? 'message_edit' : 'message',
    version: isEdit ? safeVersion(a.channelData?.eventVersion ?? a.timestamp) : '1',
    actorId: str(from.aadObjectId) ?? str(from.id),
    actorName: str(from.name, 80),
    chatId: str(conv.id),
    chatType: ct === 'personal' ? 'dm' : ct === 'groupChat' ? 'group' : ct === 'channel' ? 'channel' : null,
    threadId: str(a.replyToId),
    tenantId: str(conv.tenantId) ?? str(a.channelData?.tenant?.id),
    providerTs: str(a.timestamp, 40),
    text: String(a.text ?? '').replace(/<at>[^<]*<\/at>/g, '').trim().slice(0, 8000),
    isFromBot: (botId !== null && from.id === botId) || String(from.id ?? '').startsWith('28:') || from.role === 'bot',
  };
}

/** Mensagem no formato Baileys (fixture local). */
export function normalizeWhatsAppMessage(m: Record<string, any>): InboundEvent {
  const key = m.key ?? {};
  const msg = m.message ?? {};
  const edited = msg.editedMessage?.message ?? msg.protocolMessage?.editedMessage;
  const body = edited ?? msg;
  const text = body.conversation ?? body.extendedTextMessage?.text ?? '';
  const remote = String(key.remoteJid ?? '');
  const isGroup = remote.endsWith('@g.us');
  const actorJid = isGroup ? String(key.participant ?? '') : remote;
  return {
    platform: 'whatsapp',
    externalId: String(key.id ?? ''),
    eventType: edited ? 'message_edit' : 'message',
    version: edited ? safeVersion(m.editVersion ?? m.messageTimestamp) : '1',
    actorId: actorJid ? actorJid.split('@')[0] : null,
    actorName: str(m.pushName, 80),
    chatId: remote || null,
    chatType: isGroup ? 'group' : 'dm',
    threadId: null,
    tenantId: null,
    providerTs: typeof m.messageTimestamp === 'number' ? new Date(m.messageTimestamp * 1000).toISOString() : null,
    text: String(text).slice(0, 8000),
    isFromBot: key.fromMe === true,
  };
}
