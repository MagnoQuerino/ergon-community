/**
 * WhatsApp por QR code (Baileys, código aberto e NÃO oficial; separado da Cloud API). O usuário lê o QR com o
 * celular (Aparelhos conectados) e o Ergon passa a LER as conversas que os filtros permitem. A leitura não marca
 * como lido e não fica "online". O envio existe só em `enviar`, quando alguém pede (conexoes/acoes/whatsapp.ts, sob
 * conexoes/regra.ts): nunca é automático, e mensagem recebida não dispara resposta.
 * A sessão fica em /data/secrets (volume de dados), nunca no Git, no OneDrive ou no navegador.
 * As mensagens entram pelo mesmo caminho dos outros canais (ingest.ts: deduplicação → interpretação → card).
 * Vários números (rc.29): cada conta do WhatsApp tem o seu pareamento, a sua sessão e os seus filtros; o que chega guarda
 * por qual número veio (source_events.integracao_id).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { clip, fold, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { ErroAcao } from './conexoes/tipos.ts';
import { findConnection, ingestEvent, type InboundEvent } from './ingest.ts';
import { contasDe, integrationRow, setIntegration, settingsOf, type Integrations } from './integrations.ts';
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

/** Versão do texto de informações e riscos (web/src/views/ConexoesView.tsx): mudou o texto, pede o aceite de novo. */
/** 2: o aceite passou a dizer que os agentes podem enviar; quem aceitou o texto de "somente leitura" aceita de novo antes de enviar. */
/** 3: o texto deixou de prometer "nunca sozinhos": com "Liberar tudo" ligado, o envio sai sem cartão. Quem aceitou antes aceita de novo. */
export const WA_RISKS_VERSION = 3;
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
  sock: any; labels: Map<string, string>; chatLabels: Map<string, Set<string>>; names: Map<string, string>; salvos: Set<string>;
  /** os dois endereços da mesma conversa, nos dois sentidos: número ⇄ LID */
  alts: Map<string, string>;
  seen: number; read: number; stopping: boolean; retries: number;
}

const MAX_QR = 6; // ~2 minutos de QR sem leitura: para (nada fica tentando sozinho)
const MAX_ALTS = 4000;

/** O número de um jid, sem aparelho nem servidor ("5511...:12@s.whatsapp.net" → "5511..."). */
const numeroDoJid = (jid: string): string => jid.split('@')[0].split(':')[0];
/** Exceção escrita como número, do jeito que o WhatsApp mostra: "+55 (11) 98888-0000". */
const ehNumero = (s: string): boolean => /^\+?[\d\s().-]{8,}$/.test(s.trim());
/** Brasil: o mesmo celular existe com e sem o nono dígito (conta antiga ficou sem ele no jid). */
const comNono = (n: string): string[] => (/^55\d{2}9\d{8}$/.test(n) ? [n, `${n.slice(0, 4)}${n.slice(5)}`] : /^55\d{10}$/.test(n) ? [n, `${n.slice(0, 4)}9${n.slice(4)}`] : [n]);

/** Decide se uma mensagem passa pelos filtros (função pura, testada à parte). `chatAlt`: o outro endereço da conversa, o número de quem chega por LID. */
export function passes(f: WaFilters, m: { chatId: string; isGroup: boolean; chatName: string | null; labels: string[]; chatAlt?: string | null }): boolean {
  if (m.isGroup ? !f.groups : !f.direct) return false;
  const jids = m.chatAlt ? [m.chatId, m.chatAlt] : [m.chatId];
  const ids = [...jids, ...jids.map(numeroDoJid), m.chatName ?? ''].map((s) => fold(s));
  // o número do LID não é telefone: só entra o de verdade
  const telefones = jids.filter((j) => !j.endsWith('@lid')).flatMap((j) => comNono(numeroDoJid(j)));
  const bateNumero = (e: string) => ehNumero(e) && comNono(e.replace(/\D/g, '')).some((x) => telefones.some((t) => t.includes(x)));
  if (f.exceptions.some((e) => ids.includes(fold(e)) || (fold(e).length > 3 && ids.some((i) => i.includes(fold(e)))) || bateNumero(e))) return false;
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

/**
 * Conversa ao alcance dos agentes: pessoa (número ou LID) e grupo, sem aparelho no meio (formatos em WABinary/jid-utils
 * do Baileys). Fora: `status@broadcast` publicaria no status da conta; listas de transmissão e canais também.
 */
export const jidDeConversa = (jid: string): boolean => /^(\d{5,32}@(s\.whatsapp\.net|lid)|\d{5,32}(-\d{5,32})?@g\.us)$/.test(jid);

/** Só as exceções de `passes`: valem mesmo com os outros filtros desligados. */
const emExcecao = (f: WaFilters, jid: string, nome: string | null, alt: string | null = null): boolean =>
  !passes({ ...f, direct: true, groups: true, labels: [] }, { chatId: jid, isGroup: jid.endsWith('@g.us'), chatName: nome, labels: [], chatAlt: alt });

const ligarJids = (l: Live, a: string, b: string): void => { if (l.alts.size < MAX_ALTS) { l.alts.set(a, b); l.alts.set(b, a); } };

/**
 * Mensagens guardadas pelo caminho dos canais (ingest.ts): texto cortado em 500 caracteres; só as recebidas. De um número só:
 * o id da conta (as de antes da rc.29 receberam o da principal na migração 0046).
 */
const GUARDADAS = `FROM source_events e JOIN connections c ON c.id = e.connection_id
  WHERE e.workspace_id = ? AND c.kind = 'whatsapp' AND e.is_fixture = 0 AND e.status = 'accepted' AND e.text_excerpt IS NOT NULL AND e.channel IS NOT NULL
    AND (e.integracao_id = ? OR (e.integracao_id IS NULL AND ? = ''))`;
/** A chave de uma sessão: o workspace e o número (conta '' = o principal). */
const chave = (ws: string, conta: string) => `${ws}|${conta}`;

export interface MensagemGuardada { autor: string | null; texto: string; em: string }

export class WhatsAppReader {
  private readonly db: Db; private readonly bus: Bus; private readonly ints: Integrations;
  private live = new Map<string, Live>();
  /** para testes: troca o carregamento do Baileys */
  loader: () => Promise<any> = () => import('@whiskeysockets/baileys');
  qrLoader: () => Promise<any> = () => import('qrcode');

  constructor(db: Db, bus: Bus, ints: Integrations) {
    this.db = db; this.bus = bus; this.ints = ints;
    ints.liveState = (ws, kind, conta) => (kind === 'whatsapp' ? this.state(ws, conta) : null);
    // trocar o número principal troca as pastas das sessões: as duas param antes e voltam depois, cada uma com o seu número
    const pausadas = new Map<string, string[]>();
    ints.antesDeTrocar = async (ws, kind) => {
      if (kind !== 'whatsapp') return;
      const ligadas = [...this.live.entries()].filter(([k, l]) => k.startsWith(`${ws}|`) && l.sock && !l.stopping).map(([k]) => k.slice(ws.length + 1));
      for (const c of ligadas) { await this.stop(ws, null, c); this.live.delete(chave(ws, c)); }
      pausadas.set(ws, ligadas);
    };
    ints.depoisDeTrocar = (ws, kind) => {
      if (kind !== 'whatsapp') return;
      for (const c of pausadas.get(ws) ?? []) void this.start(ws, null, c); // a pasta de cada conta já é a do número que ficou nela
      pausadas.delete(ws);
    };
  }

  /** O id da linha da conta (as mensagens guardadas e o que chega ficam marcados com ele). */
  private idDaConta(workspaceId: string, conta: string): string { return integrationRow(this.db, workspaceId, 'whatsapp', conta).id; }
  /** Os dois parâmetros de GUARDADAS: o id da conta e, para o principal, as mensagens sem marca (de antes, sem a conta na migração). */
  private daConta(workspaceId: string, conta: string): [string, string] { return [this.idDaConta(workspaceId, conta), conta]; }

  state(workspaceId: string, conta = '') {
    const l = this.live.get(chave(workspaceId, conta));
    if (!l) return { status: 'off' as Status, qr: null, me: null, error: null, read: 0, seen: 0 };
    return { status: l.status, qr: l.status === 'qr' ? l.qr : null, me: l.me, error: l.error, read: l.read, seen: l.seen };
  }

  /** Conversas conhecidas nesta sessão (para montar a lista de exceções sem digitar). */
  chats(workspaceId: string, conta = ''): Array<{ id: string; name: string; group: boolean }> {
    const l = this.live.get(chave(workspaceId, conta));
    return l ? [...l.names].map(([id, name]) => ({ id, name, group: id.endsWith('@g.us') })).slice(0, 300) : [];
  }

  labelNames(workspaceId: string, conta = ''): string[] { return [...(this.live.get(chave(workspaceId, conta))?.labels.values() ?? [])]; }

  private filtros(workspaceId: string, conta = ''): WaFilters { return filtersOf(settingsOf(integrationRow(this.db, workspaceId, 'whatsapp', conta))); }

  /**
   * Conversas ao alcance dos agentes, com nome e jid: as que apareceram nesta sessão e as que têm mensagem guardada.
   * Exceção não aparece, nem grupo cujo nome não dá para conferir contra as exceções. Sem o teto de `chats()`, que é da
   * tela: um nome precisa ser comparado com todos para saber se é único.
   */
  conversas(workspaceId: string, conta = ''): Array<{ jid: string; nome: string; salvo: boolean }> {
    const f = this.filtros(workspaceId, conta);
    const viva = this.live.get(chave(workspaceId, conta));
    const alts = viva?.alts;
    const porNumero = f.exceptions.some(ehNumero);
    const nomes = new Map<string, string>();
    const fora = new Set<string>();
    const poe = (jid: string, nome: string | null) => {
      if (emExcecao(f, jid, nome, alts?.get(jid) ?? null)) fora.add(jid);
      if (nome || !nomes.has(jid)) nomes.set(jid, nome ?? '');
    };
    // em grupo, actor_display é quem escreveu, não o nome do grupo
    for (const r of this.db.all<{ jid: string; nome: string | null }>(`SELECT e.channel AS jid, e.actor_display AS nome, MAX(e.received_at) AS em ${GUARDADAS} GROUP BY e.channel LIMIT 2000`, workspaceId, ...this.daConta(workspaceId, conta))) poe(r.jid, r.jid.endsWith('@g.us') ? null : r.nome);
    for (const [jid, nome] of viva?.names ?? []) poe(jid, nome);
    return [...nomes]
      .filter(([jid, nome]) => jidDeConversa(jid) && !fora.has(jid) && (nome || !jid.endsWith('@g.us') || !f.exceptions.length) && !(porNumero && jid.endsWith('@lid') && !alts?.has(jid)))
      .map(([jid, nome]) => ({ jid, nome: nome || jid, salvo: !!viva?.salvos.has(jid) || jid.endsWith('@g.us') }));
  }

  /**
   * O outro endereço da mesma conversa. O Baileys 7 entrega conversa individual por LID, com o número em `remoteJidAlt`
   * (lib/Utils/decode-wa-message.js), e `jid` sozinho não diz qual é o telefone. Depois de reiniciar, quem sabe é o mapa
   * guardado pelo próprio Baileys (lib/Signal/lid-mapping.js, sem rede).
   */
  private async outroJid(workspaceId: string, jid: string, conta = ''): Promise<string | null> {
    const l = this.live.get(chave(workspaceId, conta));
    if (!l || jid.endsWith('@g.us')) return null;
    const sabido = l.alts.get(jid);
    if (sabido || !jid.endsWith('@lid')) return sabido ?? null;
    try {
      const pn = await l.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) { const numero = `${numeroDoJid(String(pn))}@s.whatsapp.net`; ligarJids(l, jid, numero); return numero; }
    } catch { /* sem o mapa: quem chama decide */ }
    return null;
  }

  /** Nome atual da conversa. Grupo ainda sem nome nesta sessão (reiniciou, grupo quieto): pergunta ao WhatsApp, como onMessage. */
  private async nomeVivo(workspaceId: string, jid: string, conta = ''): Promise<string | null> {
    const l = this.live.get(chave(workspaceId, conta));
    const nome = l?.names.get(jid) ?? null;
    if (nome || !jid.endsWith('@g.us') || !l?.sock || l.status !== 'connected') return nome;
    try {
      const g = await l.sock.groupMetadata(jid);
      if (g?.subject) { l.names.set(jid, clip(String(g.subject), 80)); return l.names.get(jid)!; }
    } catch { /* sem nome */ }
    return null;
  }

  /** Conversa nas exceções fica fora do alcance dos agentes; sem saber o nome do grupo não dá para conferir, então também barra. */
  private async barrarExcecao(workspaceId: string, jid: string, conta = ''): Promise<void> {
    const f = this.filtros(workspaceId, conta);
    if (!f.exceptions.length) return;
    const grupo = jid.endsWith('@g.us');
    const vivo = await this.nomeVivo(workspaceId, jid, conta);
    if (grupo && !vivo) throw new ErroAcao('não deu para saber o nome deste grupo agora, então as exceções dos filtros do WhatsApp não puderam ser conferidas. Confira se o WhatsApp está conectado e se a conta participa do grupo');
    const alt = await this.outroJid(workspaceId, jid, conta);
    if (jid.endsWith('@lid') && !alt && f.exceptions.some(ehNumero)) throw new ErroAcao('não deu para saber o número desta conversa agora, então as exceções dos filtros do WhatsApp não puderam ser conferidas. Passe o número (DDI, DDD e número, seguidos de @s.whatsapp.net), ou a pessoa troca a exceção pelo nome em Conexões › WhatsApp');
    // conversa individual: o contato pode ter mudado de nome depois de entrar na lista; a mesma pessoa pode estar guardada pelo número e pelo LID
    const canais = grupo ? [] : alt ? [jid, alt] : [jid];
    const daConta = this.daConta(workspaceId, conta);
    const guardados = canais.flatMap((c) => this.db.all<{ nome: string | null }>(`SELECT e.actor_display AS nome ${GUARDADAS} AND e.channel = ? ORDER BY e.received_at DESC LIMIT 200`, workspaceId, ...daConta, c).map((r) => r.nome));
    const doOutro = alt ? this.live.get(chave(workspaceId, conta))?.names.get(alt) ?? null : null;
    if ([vivo, doOutro, ...guardados].some((n) => emExcecao(f, jid, n, alt))) throw new ErroAcao('esta conversa está nas exceções dos filtros do WhatsApp e fica fora do alcance dos agentes. Só a pessoa pode tirá-la de lá, em Conexões › WhatsApp');
  }

  /** O que está guardado de uma conversa, da mensagem mais nova para a mais antiga, com os filtros de agora (podem ter mudado depois de guardar). */
  async mensagens(workspaceId: string, jid: string, limite: number, conta = ''): Promise<MensagemGuardada[]> {
    if (!jidDeConversa(jid)) throw new ErroAcao(`"${clip(jid, 80)}" não é uma conversa do WhatsApp`);
    await this.barrarExcecao(workspaceId, jid, conta);
    const l = this.live.get(chave(workspaceId, conta));
    const labels = [...(l?.chatLabels.get(jid) ?? [])].map((id) => l!.labels.get(id) ?? id);
    if (!passes(this.filtros(workspaceId, conta), { chatId: jid, isGroup: jid.endsWith('@g.us'), chatName: l?.names.get(jid) ?? null, labels })) throw new ErroAcao('os filtros do WhatsApp não permitem ler esta conversa. A pessoa pode mudar em Conexões › WhatsApp');
    return this.db.all<{ autor: string | null; texto: string; ts: string | null; recebida: string }>(
      `SELECT e.actor_display AS autor, e.text_excerpt AS texto, e.provider_ts AS ts, e.received_at AS recebida ${GUARDADAS} AND e.channel = ? ORDER BY e.received_at DESC, e.rowid DESC LIMIT ?`, workspaceId, ...this.daConta(workspaceId, conta), jid, limite,
    ).map((r) => ({ autor: r.autor || null, texto: r.texto, em: r.ts ?? r.recebida }));
  }

  /**
   * Envia um texto a pedido de quem chama e devolve o id da mensagem. Nada neste módulo chama isto sozinho. `sendMessage`
   * termina quando a mensagem sai pelo socket (lib/Socket/messages-send.js: relayMessage → sendNode), sem esperar
   * confirmação de entrega. Não repete: falhou, a pessoa confere no celular. `linkPreview: null`: sem isso o Baileys
   * tentaria abrir o primeiro endereço do texto daqui do servidor para montar a prévia, e o endereço pode vir do modelo.
   */
  async enviar(workspaceId: string, jid: string, texto: string, conta = ''): Promise<string> {
    if (!jidDeConversa(jid)) throw new ErroAcao(`"${clip(jid, 80)}" não é uma conversa do WhatsApp: só dá para enviar a uma pessoa ou a um grupo (status, listas de transmissão e canais ficam de fora)`);
    const l = this.live.get(chave(workspaceId, conta));
    if (!l?.sock || l.status !== 'connected') throw new ErroAcao(`${conta ? 'este número do WhatsApp' : 'o WhatsApp'} não está conectado agora. A pessoa pode conectar em Conexões › WhatsApp`);
    if (!risksAccepted(settingsOf(integrationRow(this.db, workspaceId, 'whatsapp', conta)))) throw new ErroAcao('antes do primeiro envio, a pessoa precisa aceitar os riscos em Conexões › WhatsApp: nada foi enviado');
    await this.barrarExcecao(workspaceId, jid, conta);
    let enviada: any;
    try { enviada = await l.sock.sendMessage(jid, { text: texto, linkPreview: null }); } catch (e) {
      throw new ErroAcao(`o WhatsApp não aceitou a mensagem (${clip(e instanceof Error ? e.message : String(e), 200)}). Confira no celular se ela saiu antes de tentar de novo`);
    }
    return String(enviada?.key?.id ?? '');
  }

  private emit(workspaceId: string) { this.bus.publish(workspaceId, 'integrations.changed', { kind: 'whatsapp' }); }

  /** Liga o leitor: mostra QR (primeira vez) ou retoma a sessão já pareada pelo usuário. */
  /** `conta`: qual dos números ('' = o principal). Cada um tem a sua pasta de sessão (dirFor) e o seu QR. */
  async start(workspaceId: string, userId: string | null, conta = ''): Promise<void> {
    const k = chave(workspaceId, conta);
    const cur = this.live.get(k);
    if (cur && !cur.stopping && cur.status !== 'off' && cur.status !== 'error') return;
    const l: Live = { status: 'starting', qr: null, qrCount: 0, me: null, error: null, sock: null, salvos: new Set(), labels: new Map(), chatLabels: new Map(), names: new Map(), alts: new Map(), seen: 0, read: 0, stopping: false, retries: cur?.retries ?? 0 };
    this.live.set(k, l);
    this.emit(workspaceId);
    if (userId) setIntegration(this.db, workspaceId, 'whatsapp', { state: 'pending', last_error: null }, conta);
    let mod: any; let qrmod: any;
    try { mod = await this.loader(); qrmod = await this.qrLoader(); } catch (err) {
      l.status = 'error'; l.error = 'componente do WhatsApp não instalado nesta versão';
      setIntegration(this.db, workspaceId, 'whatsapp', { state: 'error', last_error: l.error }, conta);
      this.emit(workspaceId); return;
    }
    const make = mod.makeWASocket ?? mod.default?.makeWASocket ?? mod.default?.default ?? mod.default;
    const useAuth = (dir: string) => sealedAuthState(dir, mod.default?.BufferJSON ? mod.default : mod, this.ints.secrets.cipher(), workspaceId);
    const reasons = mod.DisconnectReason ?? mod.default?.DisconnectReason ?? {};
    const toDataURL = qrmod.toDataURL ?? qrmod.default?.toDataURL;
    const { state, saveCreds } = await useAuth(this.ints.secrets.dirFor(workspaceId, 'whatsapp', conta));
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
        if (l.qrCount > MAX_QR) { await this.stop(workspaceId, 'O QR expirou sem leitura. Clique em "Conectar" para gerar outro.', conta); return; }
        try { l.qr = await toDataURL(u.qr, { margin: 1, width: 280 }); } catch { l.qr = null; }
        l.status = 'qr'; this.emit(workspaceId);
      }
      if (u.connection === 'open') {
        l.status = 'connected'; l.qr = null; l.error = null; l.retries = 0;
        l.me = clip(String(sock.user?.name ?? sock.user?.id ?? 'WhatsApp').split(':')[0], 60);
        // o número de quem pareou: com dois números, é ele que diz qual é qual (o nome costuma ser o mesmo)
        const numero = /^\d{8,15}/.exec(String(sock.user?.id ?? ''))?.[0] ?? null;
        // com um número só, o nome fica como sempre foi; com mais de um, o número vai junto do nome
        const varios = !!conta || contasDe(this.db, workspaceId, 'whatsapp').length > 1;
        const rotulo = varios && numero && !l.me.includes(numero) ? clip(`${l.me} · +${numero}`, 80) : l.me;
        const row = integrationRow(this.db, workspaceId, 'whatsapp', conta);
        if (row.state !== 'connected') {
          // o mesmo número pareado de novo como "outro número": o novo sai, e o de antes continua
          const repetido = conta && numero ? contasDe(this.db, workspaceId, 'whatsapp').find((c) => c.conta !== conta && c.state !== 'off' && (settingsOf(c).numero === numero || (c.account_label ?? '').includes(`+${numero}`))) : null;
          if (repetido) {
            await this.stop(workspaceId, null, conta);
            this.live.delete(k);
            this.ints.secrets.removeDir(workspaceId, 'whatsapp', conta);
            this.db.run("DELETE FROM integrations WHERE workspace_id = ? AND kind = 'whatsapp' AND conta = ?", workspaceId, conta);
            this.emit(workspaceId);
            return;
          }
          setIntegration(this.db, workspaceId, 'whatsapp', { state: 'connected', account_label: rotulo, connected_at: now(), last_error: null, ...(numero ? { settings: { ...settingsOf(row), numero } } : {}) }, conta);
          audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: 'whatsapp', evidence: { account: rotulo, ...(conta ? { conta } : {}) }, result: conta ? 'outro número conectado por QR' : 'conectado por QR' });
        } else if (numero && settingsOf(row).numero !== numero) {
          // sessão retomada de um número pareado antes da rc.29 (sem o número guardado): guarda agora, para o mesmo número
          // não entrar de novo como "outro número"
          setIntegration(this.db, workspaceId, 'whatsapp', { settings: { ...settingsOf(row), numero } }, conta);
        }
        this.emit(workspaceId);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === reasons.loggedOut || code === 401) {
          await this.stop(workspaceId, 'O aparelho foi desconectado no celular. Conecte de novo para voltar a ler.', conta);
          this.ints.secrets.removeDir(workspaceId, 'whatsapp', conta);
          setIntegration(this.db, workspaceId, 'whatsapp', { state: 'off', account_label: null }, conta);
          return;
        }
        // queda de rede/reinício do WhatsApp: tenta de novo algumas vezes, com espera crescente
        l.retries++;
        if (l.retries > 5) { await this.stop(workspaceId, 'Sem conexão com o WhatsApp depois de várias tentativas.', conta); return; }
        l.status = 'starting'; this.emit(workspaceId);
        setTimeout(() => { if (!l.stopping && this.live.get(k) === l) { this.live.delete(k); void this.start(workspaceId, null, conta); } }, Math.min(30_000, 2000 * 2 ** l.retries)).unref?.();
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
    // c.name é o nome salvo na agenda da pessoa; notify e pushName, o que o próprio remetente escolheu
    sock.ev.on('contacts.upsert', (cs: any[]) => { for (const c of cs ?? []) { remember(c.id, c.name ?? c.notify); if (c.id && c.name) l.salvos.add(c.id); } });
    sock.ev.on('groups.upsert', (gs: any[]) => { for (const g of gs ?? []) remember(g.id, g.subject); });
    sock.ev.on('messages.upsert', async (up: any) => {
      if (up?.type !== 'notify') return; // só mensagens novas (nada de histórico)
      for (const msg of up.messages ?? []) {
        try { await this.onMessage(workspaceId, conta, l, msg); } catch { /* uma mensagem ruim não derruba o leitor */ }
      }
    });
  }

  private async onMessage(workspaceId: string, conta: string, l: Live, msg: any): Promise<void> {
    const key = msg?.key ?? {};
    const chatId = String(key.remoteJid ?? '');
    if (!chatId || key.fromMe || chatId === 'status@broadcast' || chatId.endsWith('@newsletter') || chatId.endsWith('@broadcast')) return;
    const text = textOf(msg);
    if (!text) return;
    l.seen++;
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup && !l.salvos.has(chatId)) l.names.set(chatId, clip(String(msg.pushName ?? chatId.split('@')[0]), 80));
    if (!isGroup && key.remoteJidAlt) ligarJids(l, chatId, String(key.remoteJidAlt));
    if (isGroup && !l.names.has(chatId)) {
      try { const g = await l.sock.groupMetadata(chatId); if (g?.subject) l.names.set(chatId, clip(String(g.subject), 80)); } catch { /* sem nome */ }
    }
    const row = integrationRow(this.db, workspaceId, 'whatsapp', conta);
    // número desligado pela pessoa em Conexões: não lê nem guarda (o pareamento continua)
    if (row.ativa === 0) return;
    const f = filtersOf(settingsOf(row));
    const labels = [...(l.chatLabels.get(chatId) ?? [])].map((id) => l.labels.get(id) ?? id);
    const alt = await this.outroJid(workspaceId, chatId, conta);
    // conversa por LID sem o número: com exceção por número não dá para conferir, e "nunca ler" vale mais do que ler
    if (chatId.endsWith('@lid') && !alt && f.exceptions.some(ehNumero)) return;
    if (!passes(f, { chatId, isGroup, chatName: l.names.get(chatId) ?? null, labels, chatAlt: alt })) return;
    const e: InboundEvent = {
      // a mesma mensagem de um grupo chega aos dois números: cada número guarda a sua (o id leva o número, menos no principal)
      platform: 'whatsapp', externalId: `${conta ? `${conta}:` : ''}${String(key.id ?? `${chatId}-${Date.now()}`).replace(/[^\w:.@+=/-]/g, '')}`.slice(0, 200), eventType: 'message', version: '1',
      actorId: String(key.participant ?? chatId).slice(0, 200), actorName: msg.pushName ? clip(String(msg.pushName), 80) : null,
      chatId: chatId.slice(0, 200), chatType: isGroup ? 'group' : 'dm', threadId: null, tenantId: null,
      providerTs: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : null,
      text: text.slice(0, 8000), isFromBot: false, preFiltered: true, createDemands: f.cards, integracaoId: row.id,
    };
    ingestEvent(this.db, this.bus, findConnection(this.db, workspaceId, 'whatsapp', 'real'), e);
    l.read++;
    setIntegration(this.db, workspaceId, 'whatsapp', { last_sync_at: now() }, conta);
  }

  async stop(workspaceId: string, reason: string | null = null, conta = ''): Promise<void> {
    const k = chave(workspaceId, conta);
    const l = this.live.get(k);
    if (!l) return;
    l.stopping = true;
    try { l.sock?.ev?.removeAllListeners?.(); l.sock?.end?.(undefined); l.sock?.ws?.close?.(); } catch { /* já fechado */ }
    this.live.set(k, { ...l, status: reason ? 'error' : 'off', qr: null, error: reason, sock: null });
    if (reason && db_tem(this.db, workspaceId, conta)) setIntegration(this.db, workspaceId, 'whatsapp', { last_error: reason, state: integrationRow(this.db, workspaceId, 'whatsapp', conta).state === 'connected' ? 'error' : 'off' }, conta);
    this.emit(workspaceId);
  }

  /** Desconecta de verdade: sai do aparelho (logout) e apaga a sessão local daquele número. */
  async logout(workspaceId: string, userId: string, conta = ''): Promise<void> {
    const k = chave(workspaceId, conta);
    const l = this.live.get(k);
    try { await l?.sock?.logout?.(); } catch { /* sem conexão: apaga localmente */ }
    await this.stop(workspaceId, null, conta);
    this.live.delete(k);
    await this.ints.disconnect(workspaceId, userId, 'whatsapp', conta);
  }

  /** Na inicialização: retoma as sessões que o usuário já pareou, de cada número (nunca gera QR sozinho). */
  resumeAll(): void {
    for (const r of this.db.all<{ workspace_id: string; conta: string }>("SELECT workspace_id, conta FROM integrations WHERE kind = 'whatsapp' AND state IN ('connected', 'error') AND ws_open(workspace_id)")) {
      if (this.ints.secrets.read(r.workspace_id, 'whatsapp', r.conta) === null && !hasCreds(this.ints.secrets.dirFor(r.workspace_id, 'whatsapp', r.conta))) continue;
      void this.start(r.workspace_id, null, r.conta);
    }
  }

  async stopAll(): Promise<void> { for (const k of [...this.live.keys()]) { const [ws, conta] = k.split('|'); await this.stop(ws, null, conta ?? ''); } }
}

/** A conta ainda existe (um número novo que não terminou de parear pode ter saído da lista). */
const db_tem = (db: Db, ws: string, conta: string): boolean => !conta || !!db.get("SELECT 1 AS x FROM integrations WHERE workspace_id = ? AND kind = 'whatsapp' AND conta = ?", ws, conta);

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
