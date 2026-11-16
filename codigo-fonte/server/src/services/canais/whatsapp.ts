/**
 * "Número da equipe" no WhatsApp, sem conta Business e sem número oficial do Ergon. A pessoa compra um número só para
 * isso, pareia no Ergon pelo QR de sempre (services/whatsapp.ts) e marca "Usar este número como canal da equipe". Daí em
 * diante, do WhatsApp pessoal dela, conversa com esse número como com qualquer contato: o que ela escreve vai ao
 * coordenador como conversa, pelo MESMO caminho do Telegram e do Discord (canais/servico.ts: a conversa, a entrega honesta,
 * as regras de confirmação, os cartões e os avisos de "Com você"), e a resposta sai do número da equipe, como mensagem
 * comum. Confirmações vão como opções numeradas ("1 Aprovar · 2 Recusar"): mensagem comum não tem botões.
 *
 * Quem fala com a equipe:
 * - só o WhatsApp de membros do workspace: cada telefone é de um membro (uma pessoa do Ergon), confirmado por um código de
 *   uso único que o Ergon mostra e que o membro manda DO telefone dele para o número da equipe (10 minutos): ninguém se
 *   passa por um número da lista sem ter o celular. O pedido chega como esse membro, com o papel dele, pela camada comum
 *   dos canais externos (externo.ts: volume, pedidos de risco que esperam o app, auditoria);
 * - de qualquer outro, nada vira pedido. Padrão: silêncio; opcional, uma resposta curta ("Este número atende só a
 *   equipe."), no máximo uma vez por dia para cada contato;
 * - só conversa individual: grupo, status, lista e canal ficam com a leitura de sempre (ou nada).
 * Cada telefone liberado tem a sua conversa com o coordenador, os seus cartões e os seus avisos.
 *
 * Nunca vira pedido o que o próprio número mandou (fromMe, inclusive o eco do envio: o leitor nem chama o gancho), nem o
 * que tem mais de 24 h (com o Ergon fechado, o WhatsApp guarda e entrega na reconexão como 'append'; o que passou da
 * janela fica de fora, e a pessoa fica sabendo, como o atraso no Telegram).
 */
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db/db.ts';
import { S } from '../../lib/schemas.ts';
import { HttpError, clip, fold, now } from '../../lib/util.ts';
import { log } from '../../lib/log.ts';
import { CLOSED_VALUE } from '../../security/fields.ts';
import type { AuthContext } from '../auth.ts';
import { audit, type Bus } from '../bus.ts';
import { integrationRow, settingsOf } from '../integrations.ts';
import { workspaceTz } from '../routine-proposals.ts';
import { dataHora } from '../teams-app/cartoes.ts';
import { comNono, risksAccepted, textOf, type GanchoEquipe, type WhatsAppReader } from '../whatsapp.ts';
import { RESPOSTA, type CanalLocal, type Canais, type ItemLocal, type ResultadoLocal } from './servico.ts';

const MIN = 60_000;
const HORA = 60 * MIN;
/** O que chegou com o Ergon fechado e tem mais que isso fica de fora (a pessoa fica sabendo). */
const JANELA_MS = 24 * HORA;
/** Mais atrasado que isso: quem escreveu recebe o aviso de que chegou agora (o agente recebe a nota de atraso do canal). */
const ATRASO_MS = 10 * MIN;
const CODIGO_MS = 10 * MIN;
const MAX_REMETENTES = 10;
const MAX_TENTATIVAS = 5;
export const SO_A_EQUIPE = 'Este número atende só a equipe.';
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `whatsapp:<workspace>:<conta>:<telefone>`: um canal por telefone liberado (conta '' = o número principal). */
export const canalDoRemetente = (ws: string, conta: string, telefone: string): CanalLocal => `whatsapp:${ws}:${conta}:${telefone}`;
const partesDoCanal = (c: string): { ws: string; conta: string; telefone: string } | null => {
  const m = /^whatsapp:([^:]+):([^:]*):(\d{8,15})$/.exec(c);
  return m ? { ws: m[1], conta: m[2], telefone: m[3] } : null;
};

/** "1", "2", "1 3", "2 #3", "aprovar 3", "recusar": a resposta a um cartão. `pedido`: o número do pedido, quando veio. */
export function respostaNumerada(texto: string): { opcao: 1 | 2; pedido: number | null } | null {
  const t = fold(texto).trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  const m = /^(1|2|aprovar|aprovo|aprovado|recusar|recuso|recusado)(?:(?: ?[-:,#] ?| )(?:pedido ?)?#?(\d{1,5}))?$/.exec(t);
  if (!m) return null;
  return { opcao: m[1] === '1' || m[1].startsWith('aprov') ? 1 : 2, pedido: m[2] ? Number(m[2]) : null };
}

/** Telefone: só dígitos, com DDI (8 a 15 dígitos). */
export function normalizarTelefone(s: string): string | null {
  const d = String(s ?? '').replace(/\D/g, '');
  return /^\d{8,15}$/.test(d) ? d : null;
}
/** O mesmo celular, com ou sem o nono dígito (Brasil). */
const mesmoTelefone = (a: string, b: string): boolean => comNono(a).some((x) => comNono(b).includes(x));
/** "ERGON K7Q2MX", "k7q2mx", "Ergon: K7Q-2MX": o código de confirmação. */
const codigoNaMensagem = (texto: string): string | null => /^\s*(?:ergon\s*[:-]?\s*)?([A-Za-z0-9]{3})-?([A-Za-z0-9]{3})\s*[.!]?\s*$/i.exec(texto)?.slice(1, 3).join('').toUpperCase() ?? null;

/** O Markdown da equipe no jeito do WhatsApp: **negrito** vira *negrito*. */
const paraWhatsApp = (s: string): string => s.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
const segundos = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof (x as { toNumber?: unknown })?.toNumber === 'function' ? (x as { toNumber(): number }).toNumber() : Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

interface ConfigRow { workspace_id: string; conta: string; user_id: string; responde_desconhecidos: number; created_at: string }
interface RemetenteRow {
  workspace_id: string; conta: string; telefone: string; user_id: string; estado: 'pendente' | 'ok'; codigo: string | null; expira_em: string | null;
  tentativas: number; chat_jid: string | null; desde_ts: number; ultimo_ts: number; created_at: string;
}

const MIGRACAO = `
  CREATE TABLE IF NOT EXISTS canais_whatsapp (workspace_id TEXT NOT NULL, conta TEXT NOT NULL, user_id TEXT NOT NULL,
    responde_desconhecidos INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, conta));
  CREATE TABLE IF NOT EXISTS canais_wa_remetentes (workspace_id TEXT NOT NULL, conta TEXT NOT NULL, telefone TEXT NOT NULL, user_id TEXT NOT NULL,
    estado TEXT NOT NULL, codigo TEXT, expira_em TEXT, tentativas INTEGER NOT NULL DEFAULT 0, chat_jid TEXT, desde_ts INTEGER NOT NULL DEFAULT 0,
    ultimo_ts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, conta, telefone));
  CREATE TABLE IF NOT EXISTS canais_wa_enviadas (id TEXT PRIMARY KEY, canal TEXT NOT NULL, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS canais_wa_cartoes (canal TEXT NOT NULL, numero INTEGER NOT NULL, proposal_id TEXT, saida_id TEXT NOT NULL, message_id TEXT,
    decide INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY (canal, numero));
  CREATE INDEX IF NOT EXISTS canais_wa_cartoes_saida ON canais_wa_cartoes(saida_id);
  CREATE TABLE IF NOT EXISTS canais_wa_desconhecidos (workspace_id TEXT NOT NULL, conta TEXT NOT NULL, jid TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (workspace_id, conta, jid));
`;

interface Deps { db: Db; bus: Bus; canais: Canais; whatsapp: WhatsAppReader }
/** Ajustes (os testes encurtam): limites de envio e de entrada, e a espera para juntar o aviso de atraso. */
interface Ajustes { saidaPorMinuto: number; saidaPorMinutoNumero: number; avisoAtrasoMs: number }

export class WhatsAppEquipe implements GanchoEquipe {
  readonly d: Deps;
  ajustes: Ajustes = { saidaPorMinuto: 20, saidaPorMinutoNumero: 40, avisoAtrasoMs: 3000 };
  agora: () => number = Date.now;
  private saidas = new Map<string, number[]>();
  private atrasos = new Map<CanalLocal, { userId: string; n: number; maisAntiga: number; puladas: number; ws: string; timer: NodeJS.Timeout }>();

  constructor(d: Deps) {
    this.d = d;
    d.db.raw.exec(MIGRACAO);
    this.limpar();
    d.whatsapp.equipe = this;
    d.canais.entregadorLocal = (v, item) => this.entregar(v, item);
    d.canais.aoRemoverPessoa = (u) => this.pessoaRemovida(u);
    // saiu do workspace: os telefones dele no número da equipe somem
    d.canais.externos.aoRemoverMembro((ws, u) => { this.d.db.run('DELETE FROM canais_wa_remetentes WHERE workspace_id = ? AND user_id = ?', ws, u); this.d.bus.publish(ws, 'canais.changed', {}); });
  }

  private config(ws: string, conta: string): ConfigRow | null {
    return this.d.db.get<ConfigRow>('SELECT * FROM canais_whatsapp WHERE workspace_id = ? AND conta = ?', ws, conta) ?? null;
  }
  private remetentes(ws: string, conta: string): RemetenteRow[] {
    return this.d.db.all<RemetenteRow>('SELECT * FROM canais_wa_remetentes WHERE workspace_id = ? AND conta = ? ORDER BY created_at', ws, conta);
  }
  /** O número segue pareado e ligado (a pessoa pode ter desconectado, desligado o número ou tirado a conta). */
  private numeroAtivo(ws: string, conta: string): boolean {
    try { const r = integrationRow(this.d.db, ws, 'whatsapp', conta); return r.state === 'connected' && r.ativa !== 0; } catch { return false; }
  }
  private cabe(mapa: Map<string, number[]>, k: string, limite: number, janelaMs: number): boolean {
    const agora = this.agora();
    const lista = (mapa.get(k) ?? []).filter((t) => agora - t < janelaMs);
    mapa.set(k, lista);
    if (lista.length >= limite) return false;
    lista.push(agora);
    return true;
  }
  /** Cada mensagem do WhatsApp conta uma vez só (o WhatsApp entrega de novo depois de reconectar). */
  private primeiraVez(userId: string, canal: CanalLocal, id: string): boolean {
    return this.d.db.run('INSERT OR IGNORE INTO canais_entrada (chave, user_id, canal, tipo, request_id, recebida_em) VALUES (?, ?, ?, ?, NULL, ?)',
      `wa:${canal}:${id}`.slice(0, 300), userId, canal, 'whatsapp', now()).changes > 0;
  }

  // ------------------------------------------------------------------------------------------------ o que chega
  /** Chamado pelo leitor para o que chega a este número de outra pessoa (o que o próprio número mandou nem chega aqui). */
  async mensagem(ws: string, conta: string, msg: any, tipo: string): Promise<boolean> {
    if (tipo !== 'notify' && tipo !== 'append') return false;
    const c = this.config(ws, conta);
    if (!c || !this.numeroAtivo(ws, conta)) return false; // desligado: nada acontece, a leitura de sempre segue
    const key = msg?.key ?? {};
    const id = String(key.id ?? '');
    const chat = String(key.remoteJid ?? '');
    if (!id || key.fromMe || !/^\d{5,32}@(s\.whatsapp\.net|lid)$/.test(chat)) return false; // só conversa individual
    const telefone = await this.d.whatsapp.telefoneDe(ws, conta, key);
    const lista = this.remetentes(ws, conta);
    const r = lista.find((x) => (telefone && mesmoTelefone(x.telefone, telefone)) || (x.chat_jid && x.chat_jid === chat));
    if (!r) { this.desconhecido(c, chat, tipo); return false; }
    const texto = textOf(msg);
    if (r.estado === 'pendente') { this.confirmar(c, r, chat, msg, texto, tipo); return true; }
    if (!texto) return true;
    this.pedido(c, r, chat, msg, id, texto);
    return true;
  }

  /** Quem não está na lista: nunca é comando. Com a opção ligada, uma resposta curta, uma vez por dia. */
  private desconhecido(c: ConfigRow, chat: string, tipo: string): void {
    if (!Number(c.responde_desconhecidos) || tipo !== 'notify') return;
    const antes = this.d.db.get<{ at: string }>('SELECT at FROM canais_wa_desconhecidos WHERE workspace_id = ? AND conta = ? AND jid = ?', c.workspace_id, c.conta, chat);
    if (antes && this.agora() - Date.parse(antes.at) < 24 * HORA) return;
    if (!this.cabe(this.saidas, `${c.workspace_id}|${c.conta}`, this.ajustes.saidaPorMinutoNumero, MIN)) return;
    this.d.db.run('INSERT INTO canais_wa_desconhecidos (workspace_id, conta, jid, at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, conta, jid) DO UPDATE SET at = excluded.at', c.workspace_id, c.conta, chat, new Date(this.agora()).toISOString());
    void this.d.whatsapp.enviarCanal(c.workspace_id, c.conta, chat, SO_A_EQUIPE, this.d.whatsapp.novoIdProprio())
      .catch((e: unknown) => log.warn({ erro: (e as Error).message.slice(0, 80) }, 'whatsapp equipe: resposta a desconhecido não saiu'));
  }

  /** O telefone liberado manda o código que o Ergon mostrou: daí em diante, o que ele escreve vai à equipe. */
  private confirmar(c: ConfigRow, r: RemetenteRow, chat: string, msg: any, texto: string | null, tipo: string): void {
    if (tipo !== 'notify') return; // o código tem prazo curto: não vale o que estava guardado
    const vencido = !r.expira_em || this.agora() > Date.parse(r.expira_em);
    const codigo = texto ? codigoNaMensagem(texto) : null;
    if (vencido || !codigo || !r.codigo || r.codigo === CLOSED_VALUE) return; // nada a dizer: quem não confirmou ainda não fala com a equipe
    if (codigo !== r.codigo) {
      const n = Number(r.tentativas) + 1;
      if (n >= MAX_TENTATIVAS) this.d.db.run("UPDATE canais_wa_remetentes SET codigo = NULL, expira_em = NULL, tentativas = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?", n, r.workspace_id, r.conta, r.telefone);
      else this.d.db.run('UPDATE canais_wa_remetentes SET tentativas = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?', n, r.workspace_id, r.conta, r.telefone);
      this.d.bus.publish(c.workspace_id, 'canais.changed', {});
      return;
    }
    const ts = segundos(msg?.messageTimestamp) ?? Math.floor(this.agora() / 1000);
    this.d.db.run("UPDATE canais_wa_remetentes SET estado = 'ok', codigo = NULL, expira_em = NULL, chat_jid = ?, desde_ts = ?, ultimo_ts = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?",
      chat, ts, ts, r.workspace_id, r.conta, r.telefone);
    const canal = canalDoRemetente(r.workspace_id, r.conta, r.telefone);
    const nome = msg?.pushName ? `${clip(String(msg.pushName).replace(/[\n"]/g, ' ').trim(), 60)} (+${r.telefone})` : `+${r.telefone}`;
    this.d.canais.ligarLocal(r.user_id, r.workspace_id, canal, r.telefone, chat, nome);
    audit(this.d.db, this.d.bus, { workspaceId: r.workspace_id, actorType: 'user', actorId: r.user_id, action: 'integration.whatsapp.equipe_remetente', targetType: 'integration', targetId: 'whatsapp', evidence: r.conta ? { conta: r.conta } : {}, result: 'telefone confirmado por código no número da equipe' });
    this.d.canais.avisarLocal(r.user_id, canal, 'Pronto: este WhatsApp agora conversa com a equipe. Escreva aqui o que precisar.');
    this.d.bus.publish(c.workspace_id, 'canais.changed', {});
  }

  private pedido(c: ConfigRow, r: RemetenteRow, chat: string, msg: any, id: string, texto: string): void {
    const canal = canalDoRemetente(r.workspace_id, r.conta, r.telefone);
    if (!this.d.canais.ligadoLocal(r.user_id, canal)) return;
    const ts = segundos(msg.messageTimestamp) ?? Math.floor(this.agora() / 1000);
    if (ts < Number(r.desde_ts)) return; // de antes de confirmar
    if (!this.primeiraVez(r.user_id, canal, id)) return;
    const idade = this.agora() - ts * 1000;
    if (idade > JANELA_MS) { this.atraso(r, canal, ts, true); return; }
    // volume, papel, pedidos de risco e auditoria: a camada comum dos canais externos (externo.ts), em receberLocal
    // o WhatsApp do remetente pode ter passado do número ao LID: a resposta vai para onde ele escreveu por último
    if (chat !== r.chat_jid) this.d.db.run('UPDATE canais_wa_remetentes SET chat_jid = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?', chat, r.workspace_id, r.conta, r.telefone);
    const resp = respostaNumerada(texto);
    if (resp && this.responderCartao(r, canal, msg, id, resp)) return;
    const out = this.d.canais.receberLocal(r.user_id, canal, { message_id: id, text: texto, sent_at: new Date(ts * 1000).toISOString() });
    if (out.reply) this.d.canais.avisarLocal(r.user_id, canal, out.reply);
    if (!out.ok) return;
    if (ts > Number(r.ultimo_ts)) this.d.db.run('UPDATE canais_wa_remetentes SET ultimo_ts = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?', ts, r.workspace_id, r.conta, r.telefone);
    if (idade > ATRASO_MS) this.atraso(r, canal, ts, false);
  }

  /** O que chegou com o Ergon fechado: um aviso só, juntando o que veio na reconexão. */
  private atraso(r: RemetenteRow, canal: CanalLocal, ts: number, pulada: boolean): void {
    let a = this.atrasos.get(canal);
    if (!a) {
      const timer = setTimeout(() => this.avisarAtraso(canal), this.ajustes.avisoAtrasoMs);
      timer.unref?.();
      a = { userId: r.user_id, n: 0, maisAntiga: ts, puladas: 0, ws: r.workspace_id, timer };
      this.atrasos.set(canal, a);
    }
    if (pulada) a.puladas++; else { a.n++; a.maisAntiga = Math.min(a.maisAntiga, ts); }
  }
  private avisarAtraso(canal: CanalLocal): void {
    const a = this.atrasos.get(canal);
    this.atrasos.delete(canal);
    if (!a) return;
    const partes: string[] = [];
    if (a.n) {
      const quando = dataHora(new Date(a.maisAntiga * 1000).toISOString(), workspaceTz(this.d.db, a.ws));
      partes.push(a.n === 1
        ? `O Ergon estava fechado: a sua mensagem de ${quando} chegou à equipe só agora.`
        : `O Ergon estava fechado: as suas ${a.n} mensagens desde ${quando} chegaram à equipe só agora.`);
    }
    if (a.puladas) partes.push(a.puladas === 1 ? 'Uma mensagem de mais de 24 h ficou de fora: mande de novo se ainda precisar.' : `${a.puladas} mensagens de mais de 24 h ficaram de fora: mande de novo se ainda precisar.`);
    if (partes.length) this.d.canais.avisarLocal(a.userId, canal, partes.join(' '));
  }
  /** Para os testes: o aviso de atraso sai já. */
  avisarAtrasosAgora(): void { for (const [canal, a] of [...this.atrasos]) { clearTimeout(a.timer); this.avisarAtraso(canal); } }

  /** "1"/"2" (com o número do pedido, ou respondendo à mensagem do cartão): decide; false = não era resposta, vai à equipe. */
  private responderCartao(r: RemetenteRow, canal: CanalLocal, msg: any, id: string, resp: { opcao: 1 | 2; pedido: number | null }): boolean {
    const abertos = this.d.db.all<{ numero: number; proposal_id: string; message_id: string | null }>(
      `SELECT k.numero, k.proposal_id, k.message_id FROM canais_wa_cartoes k JOIN agent_proposals p ON p.id = k.proposal_id
        WHERE k.canal = ? AND k.decide = 1 AND p.status = 'proposed' ORDER BY k.numero`, canal);
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    const citada = ctx?.stanzaId ? String(ctx.stanzaId) : null;
    const alvo = resp.pedido != null ? abertos.find((x) => Number(x.numero) === resp.pedido)
      : citada ? abertos.find((x) => x.message_id === citada)
      : abertos.length === 1 ? abertos[0] : undefined;
    const avisar = (t: string) => this.d.canais.avisarLocal(r.user_id, canal, t);
    if (!alvo) {
      if (resp.pedido != null) { avisar(`O pedido ${resp.pedido} não está aberto: já foi decidido ou não existe.`); return true; }
      if (citada && this.d.db.get('SELECT 1 AS x FROM canais_wa_cartoes WHERE canal = ? AND message_id = ?', canal, citada)) { avisar(RESPOSTA.jaDecidido); return true; }
      if (abertos.length > 1) {
        const n = abertos[0].numero;
        avisar(`Há ${abertos.length} pedidos abertos (${abertos.map((x) => x.numero).join(', ')}). Responda com a opção e o pedido: *1 ${n}* aprova o pedido ${n}, *2 ${n}* recusa.`);
        return true;
      }
      return false; // nada aberto: é uma mensagem comum
    }
    const d = this.d.canais.decidirLocal(r.user_id, canal, `${resp.opcao === 1 ? 'a' : 'r'}:${alvo.proposal_id}`, `wa:${id}`);
    if (d.reply) avisar(d.reply);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ o que sai
  private formatar(item: ItemLocal): string {
    if (item.tipo === 'cartao') {
      const n = Number(this.d.db.get<{ n: number }>('SELECT numero AS n FROM canais_wa_cartoes WHERE saida_id = ?', item.id)?.n ?? 0);
      const opcoes = item.botoes.length ? `\n\n*1* Aprovar · *2* Recusar\nResponda com o número (com mais de um pedido aberto: *1 ${n}* ou *2 ${n}*).` : '';
      return `*Pedido ${n}:* ${paraWhatsApp(item.texto)}${opcoes}`;
    }
    if (item.tipo === 'editar') {
      const n = Number(this.d.db.get<{ n: number }>('SELECT numero AS n FROM canais_wa_cartoes WHERE saida_id = ?', item.origem ?? '')?.n ?? 0);
      return `*Pedido ${n}:* ${paraWhatsApp(item.texto.split(/\n\n/).pop() ?? item.texto)}`;
    }
    const m = /^\*\*([^*\n]{1,80}):\*\* ([\s\S]*)$/.exec(item.texto);
    return m ? `*${m[1]}:* ${paraWhatsApp(m[2])}` : paraWhatsApp(item.texto);
  }

  /** A entrega da fila (canais/servico.ts, drenarLocal): do número da equipe para o telefone liberado, com limite por minuto. */
  private async entregar(v: { userId: string; canal: CanalLocal; workspaceId: string; chatId: string }, item: ItemLocal): Promise<ResultadoLocal> {
    const p = partesDoCanal(v.canal);
    const r = p ? this.d.db.get<RemetenteRow>("SELECT * FROM canais_wa_remetentes WHERE workspace_id = ? AND conta = ? AND telefone = ? AND estado = 'ok'", p.ws, p.conta, p.telefone) : null;
    if (!p || !r || !this.config(p.ws, p.conta)) return { ok: false, erro: 'desligado' };
    if (!this.numeroAtivo(p.ws, p.conta) || !this.d.whatsapp.numeroConectado(p.ws, p.conta)) return { ok: false, passageiro: true, erro: 'sem_conexao' };
    // limite de envio: sem rajada (o que passa espera a vez, sem se perder)
    const agora = this.agora();
    for (const [k, lim] of [[v.canal, this.ajustes.saidaPorMinuto], [`${p.ws}|${p.conta}`, this.ajustes.saidaPorMinutoNumero]] as const) {
      const janela = (this.saidas.get(k) ?? []).filter((t) => agora - t < MIN);
      this.saidas.set(k, janela);
      if (janela.length >= lim) return { ok: false, esperarMs: Math.max(500, MIN - (agora - Math.min(...janela))) };
    }
    if (item.tipo === 'cartao' && !this.d.db.get('SELECT 1 AS x FROM canais_wa_cartoes WHERE saida_id = ?', item.id)) {
      const pid = /^[ar]:(apr_[a-f0-9]{32})$/.exec(item.botoes[0]?.[1] ?? '')?.[1] ?? null;
      const n = Number(this.d.db.get<{ n: number }>('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM canais_wa_cartoes WHERE canal = ?', v.canal)?.n ?? 1);
      this.d.db.run('INSERT INTO canais_wa_cartoes (canal, numero, proposal_id, saida_id, decide, created_at) VALUES (?, ?, ?, ?, ?, ?)', v.canal, n, pid, item.id, pid ? 1 : 0, now());
    }
    const texto = this.formatar(item);
    // o id é escolhido e guardado antes de mandar: o eco nunca vira pedido, nem se chegar antes da resposta do envio
    const id = this.d.whatsapp.novoIdProprio();
    this.d.db.run('INSERT OR IGNORE INTO canais_wa_enviadas (id, canal, at) VALUES (?, ?, ?)', id, v.canal, now());
    this.saidas.get(v.canal)!.push(agora); this.saidas.get(`${p.ws}|${p.conta}`)!.push(agora);
    try {
      const mid = await this.d.whatsapp.enviarCanal(p.ws, p.conta, r.chat_jid || `${r.telefone}@s.whatsapp.net`, texto, id);
      if (item.tipo === 'cartao') this.d.db.run('UPDATE canais_wa_cartoes SET message_id = ? WHERE saida_id = ?', mid, item.id);
      return { ok: true, message_id: mid };
    } catch (e) {
      return { ok: false, passageiro: true, erro: clip((e as Error).message, 80) };
    }
  }

  /** Limpeza (ao ligar o servidor): ids de envio, cartões e respostas a desconhecidos antigos. */
  limpar(): void {
    const ago = (ms: number) => new Date(this.agora() - ms).toISOString();
    this.d.db.run('DELETE FROM canais_wa_enviadas WHERE at < ?', ago(8 * 24 * HORA));
    this.d.db.run('DELETE FROM canais_wa_cartoes WHERE created_at < ?', ago(30 * 24 * HORA));
    this.d.db.run('DELETE FROM canais_wa_desconhecidos WHERE at < ?', ago(2 * 24 * HORA));
  }
  /** A pessoa saiu do Ergon: o que era dela some (os vínculos, canais/servico.ts pessoaRemovida). */
  pessoaRemovida(userId: string): void {
    this.d.db.run('DELETE FROM canais_wa_remetentes WHERE user_id = ?', userId);
    this.d.db.run('DELETE FROM canais_whatsapp WHERE user_id = ?', userId);
  }

  // ------------------------------------------------------------------------------------------------ tela
  estado(ws: string, conta: string): Record<string, unknown> {
    let row;
    try { row = integrationRow(this.d.db, ws, 'whatsapp', conta); } catch { throw new HttpError(404, 'conta', 'esta conta não existe mais neste workspace'); }
    const c = this.config(ws, conta);
    const numero = this.d.whatsapp.numeroConectado(ws, conta) ?? (typeof settingsOf(row).numero === 'string' ? String(settingsOf(row).numero) : null);
    const motivo = row.state !== 'connected' ? 'desconectado' : !risksAccepted(settingsOf(row)) ? 'riscos' : !numero ? 'sem_numero' : null;
    const agora = this.agora();
    // quem saiu do workspace não fala mais com a equipe (os telefones somem)
    const ext = this.d.canais.externos;
    for (const r of this.remetentes(ws, conta)) if (!ext.papel(ws, r.user_id)) ext.removerMembro(ws, r.user_id);
    return {
      disponivel: !motivo, ...(motivo ? { motivo } : {}), ligado: !!c, numero: numero ? `+${numero}` : null,
      respondeDesconhecidos: !!c && Number(c.responde_desconhecidos) === 1,
      membros: c ? ext.membros(ws) : [],
      remetentes: c ? this.remetentes(ws, conta).map((r) => {
        const vale = r.estado === 'pendente' && !!r.codigo && r.codigo !== CLOSED_VALUE && !!r.expira_em && agora < Date.parse(r.expira_em);
        return {
          telefone: `+${r.telefone}`, membro: r.user_id, pausado: ext.pausado(ws, r.user_id, canalDoRemetente(ws, conta, r.telefone)), estado: r.estado === 'ok' ? 'ok' : vale ? 'pendente' : 'vencido', desde: r.created_at,
          ...(vale ? { codigo: `ERGON ${r.codigo}`, expira: r.expira_em, link: numero ? `https://wa.me/${numero}?text=${encodeURIComponent(`ERGON ${r.codigo}`)}` : null } : {}),
          ...(r.estado === 'ok' && Number(r.ultimo_ts) ? { ultimaMensagem: new Date(Number(r.ultimo_ts) * 1000).toISOString() } : {}),
        };
      }) : [],
    };
  }

  /** Liga ou desliga "Usar este número como canal da equipe" (desligar tira todos os telefones liberados). */
  definir(userId: string, ws: string, conta: string, b: { ligado: boolean; respondeDesconhecidos?: boolean }): void {
    const c = this.config(ws, conta);
    if (!b.ligado) {
      if (c) {
        for (const r of this.remetentes(ws, conta)) this.d.canais.desligarLocal(r.user_id, canalDoRemetente(ws, conta, r.telefone));
        this.d.db.run('DELETE FROM canais_wa_remetentes WHERE workspace_id = ? AND conta = ?', ws, conta);
        this.d.db.run('DELETE FROM canais_whatsapp WHERE workspace_id = ? AND conta = ?', ws, conta);
        audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'integration.whatsapp.equipe_off', targetType: 'integration', targetId: 'whatsapp', evidence: conta ? { conta } : {}, result: 'número da equipe desligado' });
      }
      this.d.bus.publish(ws, 'canais.changed', {});
      return;
    }
    const e = this.estado(ws, conta);
    if (!e.disponivel) throw new HttpError(409, String(e.motivo), e.motivo === 'riscos' ? 'Antes, aceite as informações e os riscos do WhatsApp.' : 'Conecte este número do WhatsApp primeiro.');
    const resp = b.respondeDesconhecidos === undefined ? Number(c?.responde_desconhecidos ?? 0) : b.respondeDesconhecidos ? 1 : 0;
    this.d.db.run(`INSERT INTO canais_whatsapp (workspace_id, conta, user_id, responde_desconhecidos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, conta) DO UPDATE SET responde_desconhecidos = excluded.responde_desconhecidos, updated_at = excluded.updated_at`, ws, conta, userId, resp, now(), now());
    if (!c) audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'integration.whatsapp.equipe_on', targetType: 'integration', targetId: 'whatsapp', evidence: conta ? { conta } : {}, result: 'número da equipe ligado' });
    this.d.bus.publish(ws, 'canais.changed', {});
  }

  /**
   * Liga o WhatsApp de um membro do workspace ao número da equipe: o telefone fica pendente até mandar, dele, o código de
   * uso único para o número da equipe (10 minutos). O que ele pedir por aí, pede como esse membro, com o papel dele.
   */
  liberar(userId: string, ws: string, conta: string, telefone: string, memberId: string = userId): void {
    if (!this.config(ws, conta)) throw new HttpError(409, 'desligado', 'Ligue o canal da equipe neste número primeiro.');
    if (!this.d.canais.externos.papel(ws, memberId)) throw new HttpError(400, 'membro', 'Só membros deste workspace podem falar com a equipe.');
    const t = normalizarTelefone(telefone);
    if (!t) throw new HttpError(400, 'telefone', 'Isso não parece um número de telefone. Use o DDI e o DDD, ex.: +55 11 98888-0000.');
    const proprio = this.d.whatsapp.numeroConectado(ws, conta);
    if (proprio && mesmoTelefone(proprio, t)) throw new HttpError(400, 'proprio', 'Esse é o próprio número da equipe: use o seu WhatsApp pessoal.');
    const lista = this.remetentes(ws, conta);
    const ja = lista.find((x) => mesmoTelefone(x.telefone, t));
    if (ja?.estado === 'ok') throw new HttpError(409, 'ja_liberado', 'Esse telefone já conversa com a equipe.');
    if (!ja && lista.length >= MAX_REMETENTES) throw new HttpError(400, 'muitos', `No máximo ${MAX_REMETENTES} telefones por número da equipe.`);
    const codigo = Array.from({ length: 6 }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
    const expira = new Date(this.agora() + CODIGO_MS).toISOString();
    if (ja) this.d.db.run('UPDATE canais_wa_remetentes SET codigo = ?, expira_em = ?, tentativas = 0, user_id = ? WHERE workspace_id = ? AND conta = ? AND telefone = ?', this.d.db.seal(ws, codigo), expira, memberId, ws, conta, ja.telefone);
    else this.d.db.run("INSERT INTO canais_wa_remetentes (workspace_id, conta, telefone, user_id, estado, codigo, expira_em, created_at) VALUES (?, ?, ?, ?, 'pendente', ?, ?, ?)", ws, conta, t, memberId, this.d.db.seal(ws, codigo), expira, now());
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'integration.whatsapp.equipe_liberar', targetType: 'integration', targetId: 'whatsapp', evidence: { membro: memberId, ...(conta ? { conta } : {}) }, result: 'telefone de um membro à espera do código' });
    this.d.bus.publish(ws, 'canais.changed', {});
  }

  /** "Revogar este número": para na hora (o vínculo, a fila e os cartões dele somem). */
  tirar(userId: string, ws: string, conta: string, telefone: string): void {
    const t = normalizarTelefone(telefone);
    const r = t ? this.remetentes(ws, conta).find((x) => mesmoTelefone(x.telefone, t)) : null;
    if (!r) return;
    this.d.canais.desligarLocal(r.user_id, canalDoRemetente(ws, conta, r.telefone));
    this.d.db.run('DELETE FROM canais_wa_remetentes WHERE workspace_id = ? AND conta = ? AND telefone = ?', ws, conta, r.telefone);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'integration.whatsapp.equipe_remetente_off', targetType: 'integration', targetId: 'whatsapp', evidence: conta ? { conta } : {}, result: 'telefone tirado do número da equipe' });
    this.d.bus.publish(ws, 'canais.changed', {});
  }
}

const contaQuery = { type: 'object', properties: { conta: S.str(40) } };
type Verificar = (req: FastifyRequest, ctx: AuthContext, body: { password?: string; code?: string; key?: string; response?: Record<string, unknown> }) => Promise<void>;

/** Conexões › WhatsApp › "Usar este número como canal da equipe". Liberar um telefone pede a senha (é cadastrar quem manda na equipe). */
export function registerWhatsAppEquipeRoutes(app: FastifyInstance, d: { equipe: WhatsAppEquipe; owner: (req: FastifyRequest) => AuthContext; verify: Verificar }): void {
  const { equipe, owner, verify } = d;
  app.get('/api/integrations/whatsapp/equipe', { schema: { querystring: contaQuery } }, async (req) => {
    const a = owner(req);
    return equipe.estado(a.workspaceId, String((req.query as { conta?: string }).conta ?? ''));
  });
  app.put('/api/integrations/whatsapp/equipe', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ligado'], properties: { conta: S.str(40), ligado: { type: 'boolean' }, respondeDesconhecidos: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { conta?: string; ligado: boolean; respondeDesconhecidos?: boolean };
    equipe.definir(a.userId, a.workspaceId, String(b.conta ?? ''), b);
    return equipe.estado(a.workspaceId, String(b.conta ?? ''));
  });
  app.post('/api/integrations/whatsapp/equipe/remetentes', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['telefone'], properties: {
      conta: S.str(40), telefone: S.str(40, 1), membro: S.str(80, 1), password: S.str(200, 1), code: S.str(10, 6), key: S.str(80, 6), response: { type: 'object' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { conta?: string; telefone: string; membro?: string; password?: string; code?: string; key?: string; response?: Record<string, unknown> };
    await verify(req, a, { password: b.password, code: b.code, key: b.key, response: b.response });
    equipe.liberar(a.userId, a.workspaceId, String(b.conta ?? ''), b.telefone, b.membro ?? a.userId);
    return equipe.estado(a.workspaceId, String(b.conta ?? ''));
  });
  app.post('/api/integrations/whatsapp/equipe/remetentes/tirar', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['telefone'], properties: { conta: S.str(40), telefone: S.str(40, 1) } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { conta?: string; telefone: string };
    equipe.tirar(a.userId, a.workspaceId, String(b.conta ?? ''), b.telefone);
    return equipe.estado(a.workspaceId, String(b.conta ?? ''));
  });
}
