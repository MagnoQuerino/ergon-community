/**
 * WhatsApp por QR code (Baileys, código aberto e NÃO oficial; separado da Cloud API). O usuário lê o QR com o
 * celular (Aparelhos conectados) e o Ergon passa a LER as conversas que os filtros permitem. Somente leitura:
 * este módulo não tem caminho de envio (nenhuma chamada a sendMessage), não marca como lido e não fica
 * "online". A sessão fica em /data/secrets (volume de dados), nunca no Git, no OneDrive ou no navegador.
 * As mensagens entram pelo mesmo caminho dos outros canais (ingest.ts: deduplicação → interpretação → card).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { clip, fold, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { findConnection, ingestEvent, type InboundEvent } from './ingest.ts';
import { integrationRow, setIntegration, settingsOf, type Integrations } from './integrations.ts';
import { FieldCipher } from '../security/fields.ts';

export interface WaFilters {
  /** ler conversas individuais */
  direct: boolean;
  /** ler grupos */
  groups: boolean;
  /** só conversas com uma destas etiquetas (WhatsApp Business); vazio = todas */
  labels: string[];
  /** conversas nunca lidas (nome ou número, como aparece no WhatsApp) */
  exceptions: string[];
  /** pedidos identificados viram card para a triagem da equipe */
  cards: boolean;
}
export const DEFAULT_FILTERS: WaFilters = { direct: true, groups: false, labels: [], exceptions: [], cards: true };

/** Versão do texto de informações e riscos (web/src/views/ConexoesView.tsx): mudou o texto, pede o aceite de novo. */
export const WA_RISKS_VERSION = 1;
export const risksAccepted = (raw: Record<string, unknown>): boolean => (raw.riscos as { versao?: unknown } | undefined)?.versao === WA_RISKS_VERSION;

export function filtersOf(raw: Record<string, unknown>): WaFilters {
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 100) : []);
  return {
    direct: raw.direct !== false, groups: raw.groups === true,
    labels: arr(raw.labels), exceptions: arr(raw.exceptions), cards: raw.cards !== false,
  };
}

type Status = 'off' | 'starting' | 'qr' | 'connected' | 'error';
interface Live {
  status: Status; qr: string | null; qrCount: number; me: string | null; error: string | null;
  sock: any; labels: Map<string, string>; chatLabels: Map<string, Set<string>>; names: Map<string, string>;
  seen: number; read: number; stopping: boolean; retries: number;
}

const MAX_QR = 6; // ~2 minutos de QR sem leitura: para (nada fica tentando sozinho)

/** Decide se uma mensagem passa pelos filtros (função pura, testada à parte). */
export function passes(f: WaFilters, m: { chatId: string; isGroup: boolean; chatName: string | null; labels: string[] }): boolean {
  if (m.isGroup ? !f.groups : !f.direct) return false;
  const ids = [m.chatId, m.chatId.split('@')[0], m.chatName ?? ''].map((s) => fold(s));
  if (f.exceptions.some((e) => ids.includes(fold(e)) || (fold(e).length > 3 && ids.some((i) => i.includes(fold(e)))))) return false;
  if (f.labels.length && !m.labels.some((l) => f.labels.some((x) => fold(x) === fold(l)))) return false;
  return true;
}

/** Texto de uma mensagem do Baileys (texto, legenda ou resposta); null para o que não é texto. */
export function textOf(msg: any): string | null {
  const m = msg?.message;
  if (!m) return null;
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m;
  const t = inner.conversation ?? inner.extendedTextMessage?.text ?? inner.imageMessage?.caption ?? inner.videoMessage?.caption ?? inner.documentMessage?.caption ?? null;
  return typeof t === 'string' && t.trim() ? t : null;
}

export class WhatsAppReader {
  private readonly db: Db; private readonly bus: Bus; private readonly cfg: Config; private readonly ints: Integrations;
  private live = new Map<string, Live>();
  /** para testes: troca o carregamento do Baileys */
  loader: () => Promise<any> = () => import('@whiskeysockets/baileys');
  qrLoader: () => Promise<any> = () => import('qrcode');

  constructor(db: Db, bus: Bus, cfg: Config, ints: Integrations) {
    this.db = db; this.bus = bus; this.cfg = cfg; this.ints = ints;
    ints.liveState = (ws, kind) => (kind === 'whatsapp' ? this.state(ws) : null);
  }

  state(workspaceId: string) {
    const l = this.live.get(workspaceId);
    if (!l) return { status: 'off' as Status, qr: null, me: null, error: null, read: 0, seen: 0 };
    return { status: l.status, qr: l.status === 'qr' ? l.qr : null, me: l.me, error: l.error, read: l.read, seen: l.seen };
  }

  /** Conversas conhecidas nesta sessão (para montar a lista de exceções sem digitar). */
  chats(workspaceId: string): Array<{ id: string; name: string; group: boolean }> {
    const l = this.live.get(workspaceId);
    return l ? [...l.names].map(([id, name]) => ({ id, name, group: id.endsWith('@g.us') })).slice(0, 300) : [];
  }

  labelNames(workspaceId: string): string[] { return [...(this.live.get(workspaceId)?.labels.values() ?? [])]; }

  private emit(workspaceId: string) { this.bus.publish(workspaceId, 'integrations.changed', { kind: 'whatsapp' }); }

  /** Liga o leitor: mostra QR (primeira vez) ou retoma a sessão já pareada pelo usuário. */
  async start(workspaceId: string, userId: string | null): Promise<void> {
    const cur = this.live.get(workspaceId);
    if (cur && !cur.stopping && cur.status !== 'off' && cur.status !== 'error') return;
    const l: Live = { status: 'starting', qr: null, qrCount: 0, me: null, error: null, sock: null, labels: new Map(), chatLabels: new Map(), names: new Map(), seen: 0, read: 0, stopping: false, retries: cur?.retries ?? 0 };
    this.live.set(workspaceId, l);
    this.emit(workspaceId);
    if (userId) setIntegration(this.db, workspaceId, 'whatsapp', { state: 'pending', last_error: null });
    let mod: any; let qrmod: any;
    try { mod = await this.loader(); qrmod = await this.qrLoader(); } catch (err) {
      l.status = 'error'; l.error = 'componente do WhatsApp não instalado nesta versão';
      setIntegration(this.db, workspaceId, 'whatsapp', { state: 'error', last_error: l.error });
      this.emit(workspaceId); return;
    }
    const make = mod.makeWASocket ?? mod.default?.makeWASocket ?? mod.default?.default ?? mod.default;
    const useAuth = (dir: string) => sealedAuthState(dir, mod.default?.BufferJSON ? mod.default : mod, this.ints.secrets.cipher(), workspaceId);
    const reasons = mod.DisconnectReason ?? mod.default?.DisconnectReason ?? {};
    const toDataURL = qrmod.toDataURL ?? qrmod.default?.toDataURL;
    const { state, saveCreds } = await useAuth(this.ints.secrets.dirFor(workspaceId, 'whatsapp'));
    const silent: any = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };
    const sock = make({
      auth: state, logger: silent, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      browser: ['Ergon', 'Chrome', '1.0'], generateHighQualityLinkPreview: false, shouldSyncHistoryMessage: () => false,
    });
    l.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u: any) => {
      if (l.stopping) return;
      if (u.qr) {
        l.qrCount++;
        if (l.qrCount > MAX_QR) { await this.stop(workspaceId, 'O QR expirou sem leitura. Clique em "Conectar" para gerar outro.'); return; }
        try { l.qr = await toDataURL(u.qr, { margin: 1, width: 280 }); } catch { l.qr = null; }
        l.status = 'qr'; this.emit(workspaceId);
      }
      if (u.connection === 'open') {
        l.status = 'connected'; l.qr = null; l.error = null; l.retries = 0;
        l.me = clip(String(sock.user?.name ?? sock.user?.id ?? 'WhatsApp').split(':')[0], 60);
        const row = integrationRow(this.db, workspaceId, 'whatsapp');
        if (row.state !== 'connected') {
          setIntegration(this.db, workspaceId, 'whatsapp', { state: 'connected', account_label: l.me, connected_at: now(), last_error: null });
          audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: 'whatsapp', evidence: { account: l.me }, result: 'conectado por QR (somente leitura)' });
        }
        this.emit(workspaceId);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === reasons.loggedOut || code === 401) {
          await this.stop(workspaceId, 'O aparelho foi desconectado no celular. Conecte de novo para voltar a ler.');
          this.ints.secrets.removeDir(workspaceId, 'whatsapp');
          setIntegration(this.db, workspaceId, 'whatsapp', { state: 'off', account_label: null });
          return;
        }
        // queda de rede/reinício do WhatsApp: tenta de novo algumas vezes, com espera crescente
        l.retries++;
        if (l.retries > 5) { await this.stop(workspaceId, 'Sem conexão com o WhatsApp depois de várias tentativas.'); return; }
        l.status = 'starting'; this.emit(workspaceId);
        setTimeout(() => { if (!l.stopping) { this.live.delete(workspaceId); void this.start(workspaceId, null); } }, Math.min(30_000, 2000 * 2 ** l.retries)).unref?.();
      }
    });
    sock.ev.on('labels.edit', (lab: any) => { if (lab?.id) { if (lab.deleted) l.labels.delete(String(lab.id)); else l.labels.set(String(lab.id), String(lab.name ?? lab.id)); } });
    sock.ev.on('labels.association', (ev: any) => {
      const a = ev?.association; if (!a || a.type !== 'chat') return;
      const set = l.chatLabels.get(a.chatId) ?? new Set<string>();
      if (ev.type === 'remove') set.delete(String(a.labelId)); else set.add(String(a.labelId));
      l.chatLabels.set(a.chatId, set);
    });
    const remember = (jid: string, name: unknown) => { if (jid && typeof name === 'string' && name.trim() && l.names.size < 2000) l.names.set(jid, clip(name.trim(), 80)); };
    sock.ev.on('chats.upsert', (cs: any[]) => { for (const c of cs ?? []) remember(c.id, c.name); });
    sock.ev.on('contacts.upsert', (cs: any[]) => { for (const c of cs ?? []) remember(c.id, c.name ?? c.notify); });
    sock.ev.on('groups.upsert', (gs: any[]) => { for (const g of gs ?? []) remember(g.id, g.subject); });
    sock.ev.on('messages.upsert', async (up: any) => {
      if (up?.type !== 'notify') return; // só mensagens novas (nada de histórico)
      for (const msg of up.messages ?? []) {
        try { await this.onMessage(workspaceId, l, msg); } catch { /* uma mensagem ruim não derruba o leitor */ }
      }
    });
  }

  private async onMessage(workspaceId: string, l: Live, msg: any): Promise<void> {
    const key = msg?.key ?? {};
    const chatId = String(key.remoteJid ?? '');
    if (!chatId || key.fromMe || chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return;
    const text = textOf(msg);
    if (!text) return;
    l.seen++;
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup) l.names.set(chatId, clip(String(msg.pushName ?? chatId.split('@')[0]), 80));
    if (isGroup && !l.names.has(chatId)) {
      try { const g = await l.sock.groupMetadata(chatId); if (g?.subject) l.names.set(chatId, clip(String(g.subject), 80)); } catch { /* sem nome */ }
    }
    const row = integrationRow(this.db, workspaceId, 'whatsapp');
    const f = filtersOf(settingsOf(row));
    const labels = [...(l.chatLabels.get(chatId) ?? [])].map((id) => l.labels.get(id) ?? id);
    if (!passes(f, { chatId, isGroup, chatName: l.names.get(chatId) ?? null, labels })) return;
    const e: InboundEvent = {
      platform: 'whatsapp', externalId: String(key.id ?? `${chatId}-${Date.now()}`).replace(/[^\w:.@+=/-]/g, '').slice(0, 200), eventType: 'message', version: '1',
      actorId: String(key.participant ?? chatId).slice(0, 200), actorName: msg.pushName ? clip(String(msg.pushName), 80) : null,
      chatId: chatId.slice(0, 200), chatType: isGroup ? 'group' : 'dm', threadId: null, tenantId: null,
      providerTs: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : null,
      text: text.slice(0, 8000), isFromBot: false, preFiltered: true, createDemands: f.cards,
    };
    ingestEvent(this.db, this.bus, this.cfg, findConnection(this.db, workspaceId, 'whatsapp', 'real'), e, false);
    l.read++;
    setIntegration(this.db, workspaceId, 'whatsapp', { last_sync_at: now() });
  }

  async stop(workspaceId: string, reason: string | null = null): Promise<void> {
    const l = this.live.get(workspaceId);
    if (!l) return;
    l.stopping = true;
    try { l.sock?.ev?.removeAllListeners?.(); l.sock?.end?.(undefined); l.sock?.ws?.close?.(); } catch { /* já fechado */ }
    this.live.set(workspaceId, { ...l, status: reason ? 'error' : 'off', qr: null, error: reason, sock: null });
    if (reason) setIntegration(this.db, workspaceId, 'whatsapp', { last_error: reason, state: integrationRow(this.db, workspaceId, 'whatsapp').state === 'connected' ? 'error' : 'off' });
    this.emit(workspaceId);
  }

  /** Desconecta de verdade: sai do aparelho (logout) e apaga a sessão local. */
  async logout(workspaceId: string, userId: string): Promise<void> {
    const l = this.live.get(workspaceId);
    try { await l?.sock?.logout?.(); } catch { /* sem conexão: apaga localmente */ }
    await this.stop(workspaceId);
    this.live.delete(workspaceId);
    this.ints.disconnect(workspaceId, userId, 'whatsapp');
  }

  /** Na inicialização: retoma as sessões que o usuário já pareou (nunca gera QR sozinho). */
  resumeAll(): void {
    for (const r of this.db.all<{ workspace_id: string }>("SELECT workspace_id FROM integrations WHERE kind = 'whatsapp' AND state IN ('connected', 'error') AND ws_open(workspace_id)")) {
      if (this.ints.secrets.read(r.workspace_id, 'whatsapp') === null && !hasCreds(this.ints.secrets.dirFor(r.workspace_id, 'whatsapp'))) continue;
      void this.start(r.workspace_id, null);
    }
  }

  async stopAll(): Promise<void> { for (const ws of this.live.keys()) await this.stop(ws); }
}

function hasCreds(dir: string): boolean { try { return fs.existsSync(path.join(dir, 'creds.json')); } catch { return false; } }

/**
 * Sessão do WhatsApp em disco, cifrada (o padrão do Baileys grava as chaves da sessão em JSON aberto).
 * Mesmo formato do useMultiFileAuthState — creds.json + um arquivo por chave —, cada arquivo cifrado com
 * a chave do workspace. Sem a cifra (Ergon sem proteção), grava como o Baileys.
 */
async function sealedAuthState(dir: string, b: any, cipher: FieldCipher | null, workspaceId: string) {
  const fix = (f: string) => f.replace(/\//g, '__').replace(/:/g, '-');
  const write = async (data: unknown, file: string) => {
    const plain = Buffer.from(JSON.stringify(data, b.BufferJSON.replacer), 'utf8');
    const full = path.join(dir, fix(file));
    await fs.promises.writeFile(`${full}.tmp`, cipher ? cipher.sealBytes(workspaceId, plain, `whatsapp/${fix(file)}`) : plain, { mode: 0o600 });
    await fs.promises.rename(`${full}.tmp`, full);
  };
  const read = async (file: string) => {
    try {
      const raw = await fs.promises.readFile(path.join(dir, fix(file)));
      const plain = cipher && FieldCipher.isSealedBytes(raw) ? cipher.openBytes(raw, `whatsapp/${fix(file)}`) : raw;
      return JSON.parse(plain.toString('utf8'), b.BufferJSON.reviver);
    } catch { return null; }
  };
  const remove = async (file: string) => { await fs.promises.rm(path.join(dir, fix(file)), { force: true }); };
  const creds = (await read('creds.json')) ?? b.initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, unknown> = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && v) v = b.proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          const tasks: Promise<void>[] = [];
          for (const cat in data) for (const id in data[cat]) { const v = data[cat][id]; tasks.push(v ? write(v, `${cat}-${id}.json`) : remove(`${cat}-${id}.json`)); }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write(creds, 'creds.json'),
  };
}
