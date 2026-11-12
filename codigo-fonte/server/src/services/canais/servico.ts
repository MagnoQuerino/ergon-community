/**
 * Conversar com a equipe pelo Telegram e pelo Discord. A pessoa cria o próprio bot (o código dele fica no cofre do motor
 * dela, pela ponte de controle, nunca no banco nem no modelo) e liga a conversa direta com o bot ao Ergon pelo código de
 * pareamento do próprio gateway do Hermes. O gateway faz a conexão de saída (sem endereço público, sem servidor nosso) e o
 * plugin do Ergon entrega cada mensagem aqui ANTES de qualquer turno do Hermes (pre_gateway_dispatch, que devolve "skip"):
 * a mensagem entra como mensagem dela na conversa "Telegram" (ou "Discord") com o coordenador e anda pelo MESMO caminho
 * das conversas do app (sendMessage: cards, entrega honesta, regras de confirmação, cartões). A resposta, os cartões de
 * Aprovar/Recusar (botões de verdade nos dois) e os avisos de "Com você" saem por uma fila daqui, que o plugin busca com
 * espera longa e manda pelo adaptador vivo do gateway (canais_saida: sobrevive a reinício).
 * O desenho é o mesmo do Teams (teams-app/servico.ts), sem o serviço intermediário: os textos (cartoes.ts) são os mesmos.
 */
import type { Config } from '../../config.ts';
import type { Db } from '../../db/db.ts';
import { HttpError, id as novoId, now } from '../../lib/util.ts';
import { log } from '../../lib/log.ts';
import { CLOSED_VALUE } from '../../security/fields.ts';
import type { Bus, BusEvent } from '../bus.ts';
import { createConversation, sendMessage } from '../chat.ts';
import { CanalErro, type CanalNoMotor, type HermesControlClient, type NomeCanal } from '../hermes.ts';
import type { WorkspaceOwners } from '../people.ts';
import { pendingDecisions } from '../proposals.ts';
import { workspaceTz } from '../routine-proposals.ts';
import type { RunExecutor } from '../runs.ts';
import { coordinatorFor } from '../team-query.ts';
import { dataHora, linhaFinal, partesDoResumo, textoParaTeams } from '../teams-app/cartoes.ts';

export const CANAIS: readonly NomeCanal[] = ['telegram', 'discord'];
export const NOME_CANAL: Record<NomeCanal, string> = { telegram: 'Telegram', discord: 'Discord' };
/** O formato do código de cada bot (o mesmo do plugin): o que não tem esse jeito nem vai ao motor. */
export const FORMATO_TOKEN: Record<NomeCanal, RegExp> = {
  telegram: /^\d{5,14}:[A-Za-z0-9_-]{30,64}$/,
  discord: /^[A-Za-z0-9_-]{18,40}\.[A-Za-z0-9_-]{4,12}\.[A-Za-z0-9_-]{20,90}$/,
};
export const CAPACIDADE_CANAIS = 'canais';
/** A instrução do canal para chat.ts (chatHooks.channelNote). */
export const notaCanal = (c: NomeCanal) => `Canal: conversa pelo ${NOME_CANAL[c]}. Quem escreve é a pessoa dona do workspace, pela conta do ${NOME_CANAL[c]} ligada por código. A resposta vai para o ${NOME_CANAL[c]}: texto simples, sem tabelas largas.`;
export const notaDeAtrasoCanal = (c: NomeCanal, quando: string) => `Pedido enviado pelo ${NOME_CANAL[c]} em ${quando}, entregue agora com atraso (este Ergon estava fechado). Antes de agir no que depende de data ou hora, confirme com a pessoa.`;
const ATRASO_MS = 10 * 60_000;
/** O que só se responde no Ergon: autorização com senha, pergunta, pedido de chave ou senha (o valor nunca passa pelo canal). */
export const SO_NO_ERGON = ['permission', 'question', 'segredo', 'info_request', 'handoff'];
const DIA = 86_400_000;
/** Textos que o bot manda de imediato (nas duas línguas: a pessoa pode usar o Ergon em qualquer uma). */
export const RESPOSTA = {
  semVinculo: 'Esta conversa não está ligada a ninguém neste Ergon. Para ligar, abra Conexões no Ergon.\nThis chat is not linked to anyone in this Ergon. To link it, open Connections in Ergon.',
  trancado: 'O Ergon está fechado para você agora (falta entrar). Entre no Ergon e mande a mensagem de novo.\nErgon is locked for you right now (you need to sign in). Sign in to Ergon and send the message again.',
  soTexto: 'Por enquanto, só texto chega à equipe por aqui. Mande o pedido escrito.\nFor now, only text reaches the team here. Please write your request.',
  naoDeu: 'A equipe não recebeu esta mensagem: {motivo}\nThe team did not get this message.',
  jaDecidido: 'Já decidido no Ergon.\nAlready decided in Ergon.',
  noErgon: 'Abra o Ergon para responder a este.\nOpen Ergon to answer this one.',
};

interface VinculoRow {
  user_id: string; canal: NomeCanal; workspace_id: string; externo_id: string; chat_id: string; nome: string | null; avisos: number;
  conversation_id: string | null; cursor_rowid: number; aviso_janela: string | null; primeira_em: string | null; created_at: string;
}
interface SaidaRow { id: string; user_id: string; canal: NomeCanal; workspace_id: string; tipo: 'texto' | 'cartao' | 'editar'; payload: string; status: string; tentativas: number; proximo_em: string; message_id: string | null; created_at: string }
export interface ItemSaida { id: string; canal: NomeCanal; tipo: 'texto' | 'cartao' | 'editar' | 'digitando'; chat_id: string; user_id: string; texto?: string; botoes?: Array<[string, string]>; message_id?: string }

const MIGRACOES: Array<[string, string]> = [
  ['c0001_canais', `
    CREATE TABLE IF NOT EXISTS canais_bots (user_id TEXT NOT NULL, canal TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, canal));
    CREATE TABLE IF NOT EXISTS canais_vinculos (
      user_id TEXT NOT NULL, canal TEXT NOT NULL, workspace_id TEXT NOT NULL, externo_id TEXT NOT NULL, chat_id TEXT NOT NULL, nome TEXT,
      avisos INTEGER NOT NULL DEFAULT 1, conversation_id TEXT, cursor_rowid INTEGER NOT NULL DEFAULT 0, aviso_janela TEXT, primeira_em TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, canal));
    CREATE INDEX IF NOT EXISTS canais_vinculos_externo ON canais_vinculos(canal, externo_id);
    CREATE TABLE IF NOT EXISTS canais_entrada (chave TEXT PRIMARY KEY, user_id TEXT NOT NULL, canal TEXT NOT NULL, tipo TEXT NOT NULL, request_id TEXT,
      sent_at TEXT, atrasada INTEGER NOT NULL DEFAULT 0, recebida_em TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS canais_entrada_request ON canais_entrada(request_id);
    CREATE TABLE IF NOT EXISTS canais_saida (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, canal TEXT NOT NULL, workspace_id TEXT NOT NULL, tipo TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', tentativas INTEGER NOT NULL DEFAULT 0, proximo_em TEXT NOT NULL, message_id TEXT, erro TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS canais_saida_pendente ON canais_saida(status, proximo_em);
    CREATE TABLE IF NOT EXISTS canais_cartoes (proposal_id TEXT NOT NULL, user_id TEXT NOT NULL, canal TEXT NOT NULL, saida_id TEXT, estado TEXT NOT NULL DEFAULT 'open',
      PRIMARY KEY (proposal_id, user_id, canal));
    CREATE TABLE IF NOT EXISTS canais_avisados (user_id TEXT NOT NULL, canal TEXT NOT NULL, item TEXT NOT NULL, at TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, canal, item));
  `],
];
export function migrarCanais(db: Db): void {
  db.raw.exec('CREATE TABLE IF NOT EXISTS canais_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const feitas = new Set(db.all<{ name: string }>('SELECT name FROM canais_migrations').map((r) => r.name));
  for (const [nome, sql] of MIGRACOES) {
    if (feitas.has(nome)) continue;
    db.tx(() => { db.raw.exec(sql); db.run('INSERT INTO canais_migrations (name, applied_at) VALUES (?, ?)', nome, now()); });
  }
}

export interface CanaisDeps {
  db: Db; bus: Bus; cfg: Config; executor: RunExecutor; owners: WorkspaceOwners;
  /** a ponte de controle do motor do workspace (null: motor desligado ou instalação sem motor) */
  control: (ws: string) => HermesControlClient | null;
  /** as capacidades do plugin no motor do workspace (null: não se sabe agora) */
  capacidades: (ws: string) => Promise<string[] | null>;
  /** o motor que chamou a ponte pode agir neste workspace? */
  permite: (motor: string, ws: string) => boolean;
  /** a mesma decisão de POST /api/proposals/:id */
  decidir: (ws: string, userId: string, proposalId: string, decisao: 'apply' | 'reject') => Promise<{ status: string; result: string }>;
}

/** Ajustes de tempo (os testes encurtam). */
export interface AjustesCanais { avisosMs: number; atrasoMs: number; digitandoMs: number; esperaMaxMs: number; arrendamentoMs: number }

export class Canais {
  readonly d: CanaisDeps;
  ajustes: AjustesCanais = { avisosMs: 60_000, atrasoMs: 150, digitandoMs: 6_000, esperaMaxMs: 25_000, arrendamentoMs: 90_000 };
  agora: () => number = Date.now;
  private assinaturas = new Map<string, () => void>();
  private agendados = new Map<string, NodeJS.Timeout>();
  private avisosTimers = new Map<string, NodeJS.Timeout>();
  private esperando = new Set<() => void>();
  private digitar = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ligado = false;
  private decidindo = new Set<string>();

  constructor(d: CanaisDeps) { this.d = d; migrarCanais(d.db); }

  // ------------------------------------------------------------------------------------------------ ciclo de vida
  start(): void {
    this.ligado = true;
    for (const r of this.d.db.all<{ w: string }>('SELECT DISTINCT workspace_id AS w FROM canais_vinculos')) this.assinar(r.w);
    if (!this.timer) {
      this.timer = setInterval(() => { try { this.passo(); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: passo falhou'); } }, this.ajustes.digitandoMs);
      this.timer.unref?.();
    }
    this.rearmarAvisos();
  }
  stop(): void {
    this.ligado = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const t of this.agendados.values()) clearTimeout(t); this.agendados.clear();
    for (const t of this.avisosTimers.values()) clearTimeout(t); this.avisosTimers.clear();
    for (const u of this.assinaturas.values()) u(); this.assinaturas.clear();
    this.acordar();
  }
  /** A pessoa entrou: o que esperava pela parte dela anda, e a fila de saída é entregue. */
  personOpened(userId: string): void {
    for (const ws of new Set(this.vinculosDe(userId).map((v) => v.workspace_id))) this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
    this.acordar();
  }
  pessoaRemovida(userId: string): void {
    for (const t of ['canais_vinculos', 'canais_bots', 'canais_saida', 'canais_cartoes', 'canais_avisados', 'canais_entrada']) this.d.db.run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
  }

  private assinar(ws: string): void {
    if (this.assinaturas.has(ws)) return;
    this.assinaturas.set(ws, this.d.bus.subscribe(ws, (e) => this.aoEvento(ws, e)));
  }
  private aoEvento(ws: string, e: BusEvent): void {
    if (!['messages.changed', 'proposals.changed', 'runs.changed', 'tasks.changed', 'rules.changed', 'conversations.changed'].includes(e.type)) return;
    this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
  }
  private agendar(chave: string, fn: () => void, ms = this.ajustes.atrasoMs): void {
    if (this.agendados.has(chave)) return;
    const t = setTimeout(() => { this.agendados.delete(chave); try { fn(); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: atualização falhou'); } }, ms);
    t.unref?.();
    this.agendados.set(chave, t);
  }
  private avisarTela(userId: string): void { for (const ws of new Set(this.d.owners.owned(userId))) this.d.bus.publish(ws, 'canais.changed', {}); }

  // ------------------------------------------------------------------------------------------------ vínculos e conversa
  private vinculo(userId: string, canal: NomeCanal): VinculoRow | null { return this.d.db.get<VinculoRow>('SELECT * FROM canais_vinculos WHERE user_id = ? AND canal = ?', userId, canal) ?? null; }
  private vinculosDe(userId: string): VinculoRow[] { return this.d.db.all<VinculoRow>('SELECT * FROM canais_vinculos WHERE user_id = ? ORDER BY canal', userId); }
  private doCanal(motor: string, canal: NomeCanal, externo: string): VinculoRow | null {
    return this.d.db.all<VinculoRow>('SELECT * FROM canais_vinculos WHERE canal = ? AND externo_id = ? ORDER BY created_at', canal, externo).find((v) => this.d.permite(motor, v.workspace_id)) ?? null;
  }
  /** A conversa do canal com o coordenador; uma nova se a de antes sumiu, foi arquivada ou encheu. */
  private conversa(v: VinculoRow): string {
    if (v.conversation_id) {
      const c = this.d.db.get<{ id: string; n: number }>(
        `SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c JOIN agents a ON a.id = c.agent_id
          WHERE c.id = ? AND c.workspace_id = ? AND c.owner_user_id = ? AND c.archived_at IS NULL AND a.status = 'active'`, v.conversation_id, v.workspace_id, v.user_id);
      if (c && Number(c.n) < this.d.cfg.maxConversationMessages - 4) return c.id;
    }
    const agente = coordinatorFor(this.d.db, v.workspace_id) ?? this.d.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", v.workspace_id)?.id;
    if (!agente) throw new HttpError(409, 'no_agent', 'sem ninguém ativo na equipe');
    const conv = createConversation(this.d.db, v.workspace_id, v.user_id, agente, NOME_CANAL[v.canal]);
    const cursor = Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0);
    this.d.db.run('UPDATE canais_vinculos SET conversation_id = ?, cursor_rowid = ?, updated_at = ? WHERE user_id = ? AND canal = ?', conv.id, cursor, now(), v.user_id, v.canal);
    v.conversation_id = conv.id; v.cursor_rowid = cursor;
    return conv.id;
  }
  /** É a conversa de um canal? (para a instrução do canal e para os avisos não repetirem o que já foi como cartão) */
  private vinculoDaConversa(conversationId: string): VinculoRow | null { return this.d.db.get<VinculoRow>('SELECT * FROM canais_vinculos WHERE conversation_id = ?', conversationId) ?? null; }
  notaDoCanal(conversationId: string, messageId?: string | null): string | null {
    const v = this.vinculoDaConversa(conversationId);
    if (!v) return null;
    if (!messageId) return notaCanal(v.canal);
    const r = this.d.db.get<{ sent_at: string | null; atrasada: number }>(
      `SELECT e.sent_at, e.atrasada FROM messages m JOIN canais_entrada e ON e.request_id = m.client_request_id WHERE m.id = ? AND m.conversation_id = ? AND e.tipo = 'mensagem'`, messageId, conversationId);
    if (!r || !Number(r.atrasada) || !r.sent_at) return notaCanal(v.canal);
    return `${notaCanal(v.canal)}\n${notaDeAtrasoCanal(v.canal, dataHora(r.sent_at, workspaceTz(this.d.db, v.workspace_id)))}`;
  }
  private notaNaConversa(ws: string, conv: string, texto: string): void {
    this.d.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, run_id, created_at) VALUES (?, ?, ?, 'system', ?, 'local', NULL, ?)`,
      novoId('msg'), ws, conv, this.d.db.seal(ws, texto), now());
    this.d.bus.publish(ws, 'messages.changed', { conversationId: conv });
  }

  // ------------------------------------------------------------------------------------------------ o que chega do motor
  /** POST /internal/bridge/v1/canais/entrada: uma mensagem ou um clique de quem o gateway já confere como pareado. */
  entrada(motor: string, b: { tipo: 'mensagem' | 'clique'; canal: NomeCanal; user_id: string; chat_id: string; user_name?: string; message_id?: string; text?: string; sent_at?: string; anexos?: number; dado?: string; evento?: string }): { ok: boolean; reply?: string; digitando?: boolean } {
    const v = this.doCanal(motor, b.canal, b.user_id);
    if (!v) return { ok: false, reply: RESPOSTA.semVinculo };
    if (!this.d.db.workspaceOpen(v.workspace_id)) return { ok: false, reply: RESPOSTA.trancado };
    if (b.tipo === 'clique') return this.clique(v, String(b.dado ?? ''), String(b.evento ?? b.message_id ?? ''));
    const chave = `${b.canal}:${b.user_id}:${String(b.message_id ?? '')}`.slice(0, 300);
    if (b.message_id && this.d.db.get('SELECT 1 AS x FROM canais_entrada WHERE chave = ?', chave)) return { ok: true }; // entregue de novo: já está na conversa
    const texto = String(b.text ?? '').trim();
    if (!texto) return { ok: true, reply: RESPOSTA.soTexto };
    const conv = this.conversa(v);
    const crid = `canal-${novoId('m').replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 64);
    const quando = b.sent_at && Number.isFinite(Date.parse(b.sent_at)) ? new Date(Date.parse(b.sent_at)).toISOString() : null;
    const atrasada = !!quando && this.agora() - Date.parse(quando) > ATRASO_MS;
    try {
      this.d.db.tx(() => {
        this.d.db.run('INSERT INTO canais_entrada (chave, user_id, canal, tipo, request_id, sent_at, atrasada, recebida_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chave, v.user_id, v.canal, 'mensagem', crid, quando, atrasada ? 1 : 0, now());
        // a primeira mensagem pela conta ligada fica à vista no Ergon: quem não ligou esta conta percebe e desliga
        if (!v.primeira_em) {
          this.d.db.run('UPDATE canais_vinculos SET primeira_em = ? WHERE user_id = ? AND canal = ?', now(), v.user_id, v.canal);
          const nome = v.nome && v.nome !== CLOSED_VALUE ? v.nome : 'sem nome';
          this.notaNaConversa(v.workspace_id, conv, `Sistema — primeira mensagem pela conta do ${NOME_CANAL[v.canal]} "${nome}", ligada em ${dataHora(v.created_at, workspaceTz(this.d.db, v.workspace_id))}. Se não foi você que ligou esta conta, desligue em Conexões › ${NOME_CANAL[v.canal]}.`);
        }
        sendMessage(this.d.db, this.d.bus, this.d.executor, v.workspace_id, v.user_id, conv, texto.slice(0, this.d.cfg.maxInputChars), crid,
          this.d.cfg.maxConversationMessages, this.d.cfg.maxInputChars, { queue: true });
        if (b.chat_id && b.chat_id !== v.chat_id) this.d.db.run('UPDATE canais_vinculos SET chat_id = ? WHERE user_id = ? AND canal = ?', String(b.chat_id).slice(0, 64), v.user_id, v.canal);
      });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return { ok: false, reply: RESPOSTA.naoDeu.replace('{motivo}', err.message) };
      throw err;
    }
    this.digitar.add(`${v.user_id}|${v.canal}`);
    return { ok: true, digitando: true };
  }

  /** Clique em Aprovar/Recusar: decide pela mesma função da tela, fora do pedido (pode chamar outro app e demorar). */
  private clique(v: VinculoRow, dado: string, evento: string): { ok: boolean; reply?: string } {
    const m = /^([ar]):(apr_[a-f0-9]{32})$/.exec(dado);
    if (!m) return { ok: false };
    const pid = m[2]; const decisao = m[1] === 'a' ? 'apply' : 'reject';
    const prop = this.d.db.get<{ status: string; kind: string }>('SELECT status, kind FROM agent_proposals WHERE id = ? AND workspace_id = ?', pid, v.workspace_id);
    if (!prop) return { ok: false, reply: RESPOSTA.jaDecidido };
    if (SO_NO_ERGON.includes(prop.kind)) return { ok: true, reply: RESPOSTA.noErgon };
    if (prop.status !== 'proposed') { this.atualizarCartoes(v.workspace_id); return { ok: true, reply: RESPOSTA.jaDecidido }; }
    const chave = `${v.canal}:${v.user_id}:clique:${evento || pid}`.slice(0, 300);
    if (this.d.db.run('INSERT OR IGNORE INTO canais_entrada (chave, user_id, canal, tipo, request_id, recebida_em) VALUES (?, ?, ?, ?, ?, ?)', chave, v.user_id, v.canal, 'clique', pid, now()).changes === 0) return { ok: true };
    if (this.decidindo.has(pid)) return { ok: true };
    this.decidindo.add(pid);
    void this.d.decidir(v.workspace_id, v.user_id, pid, decisao)
      .catch((err: unknown) => log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: decisão pelo botão falhou'))
      .finally(() => { this.decidindo.delete(pid); this.atualizarCartoes(v.workspace_id); });
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ o que vai ao canal
  private enfileirar(v: VinculoRow, tipo: SaidaRow['tipo'], payload: Record<string, unknown>): string {
    const idSaida = novoId('cso');
    this.d.db.run(`INSERT INTO canais_saida (id, user_id, canal, workspace_id, tipo, payload, proximo_em, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      idSaida, v.user_id, v.canal, v.workspace_id, tipo, this.d.db.seal(v.workspace_id, JSON.stringify(payload)), now(), now());
    this.acordar();
    return idSaida;
  }
  private acordar(): void { const w = [...this.esperando]; this.esperando.clear(); for (const f of w) f(); }

  private atualizarWorkspace(ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    for (const v of this.d.db.all<VinculoRow>('SELECT * FROM canais_vinculos WHERE workspace_id = ?', ws)) {
      this.encaminharRespostas(v);
      this.cartoesDaConversa(v);
      this.varrerAvisos(v);
    }
    this.atualizarCartoes(ws);
  }

  private trabalhando(conversationId: string): boolean {
    if (this.d.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1", conversationId)) return true;
    return !!this.d.db.get('SELECT 1 AS x FROM messages WHERE conversation_id = ? AND queued = 1 LIMIT 1', conversationId)
      && !this.d.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status = 'waiting_user' LIMIT 1", conversationId);
  }

  /** Toda resposta nova da equipe na conversa do canal volta ao canal, com quem fala à frente. */
  private encaminharRespostas(v: VinculoRow): void {
    if (!v.conversation_id) return;
    const msgs = this.d.db.all<{ rid: number; role: string; content: string; run_id: string | null; agente: string | null }>(
      `SELECT m.rowid AS rid, m.role, m.content, m.run_id, COALESCE(ra.name, ca.name) AS agente FROM messages m
         JOIN conversations c ON c.id = m.conversation_id LEFT JOIN agents ca ON ca.id = c.agent_id
         LEFT JOIN runs r ON r.id = m.run_id LEFT JOIN agents ra ON ra.id = r.agent_id
        WHERE m.conversation_id = ? AND m.rowid > ? ORDER BY m.rowid LIMIT 50`, v.conversation_id, Number(v.cursor_rowid));
    let ultimo = Number(v.cursor_rowid);
    for (const m of msgs) {
      if (m.content === CLOSED_VALUE) break;
      ultimo = Number(m.rid);
      if (!(m.role === 'agent' || (m.role === 'system' && m.run_id))) continue;
      const texto = textoParaTeams(m.content, 3500);
      const quem = m.role === 'agent' && m.agente && m.agente !== CLOSED_VALUE ? m.agente.replace(/[*_`[\]\n]/g, '').trim().slice(0, 60) : 'Sistema';
      if (texto) this.enfileirar(v, 'texto', { texto: `**${quem}:** ${texto}` });
    }
    if (ultimo !== Number(v.cursor_rowid)) { this.d.db.run('UPDATE canais_vinculos SET cursor_rowid = ? WHERE user_id = ? AND canal = ?', ultimo, v.user_id, v.canal); v.cursor_rowid = ultimo; }
    if (!this.trabalhando(v.conversation_id)) this.digitar.delete(`${v.user_id}|${v.canal}`);
  }

  private textoDoCartao(titulo: string, summary: string): string {
    const { titulo: t, texto } = partesDoResumo(summary);
    return [titulo, textoParaTeams(t, 300), texto ? textoParaTeams(texto, 2500) : ''].filter(Boolean).join('\n\n');
  }
  private cartao(v: VinculoRow, p: { id: string; kind: string; summary: string }, titulo: string): void {
    const decide = !SO_NO_ERGON.includes(p.kind);
    const texto = this.textoDoCartao(titulo, p.summary) + (decide ? '' : `\n\n${p.kind === 'permission' ? 'Abra o Ergon para autorizar (pede a sua senha).'
      : p.kind === 'segredo' ? 'Abra o Ergon para informar: o valor nunca passa por aqui.' : 'Abra o Ergon para responder.'}`);
    const botoes: Array<[string, string]> = decide ? [['Aprovar', `a:${p.id}`], ['Recusar', `r:${p.id}`]] : [];
    const s = this.enfileirar(v, 'cartao', { texto, botoes });
    this.d.db.run("INSERT OR IGNORE INTO canais_cartoes (proposal_id, user_id, canal, saida_id, estado) VALUES (?, ?, ?, ?, 'open')", p.id, v.user_id, v.canal, s);
  }

  /** As confirmações pedidas na conversa do canal viram cartões com Aprovar/Recusar; espera por resposta vira aviso. */
  private cartoesDaConversa(v: VinculoRow): void {
    if (!v.conversation_id) return;
    const props = this.d.db.all<{ id: string; kind: string; summary: string }>(
      `SELECT id, kind, summary FROM agent_proposals WHERE workspace_id = ? AND status = 'proposed' AND kind NOT IN ('info_request', 'handoff') AND created_at >= ?
          AND (conversation_id = ? OR id IN (SELECT proposal_id FROM proposal_links WHERE conversation_id = ?))
          AND NOT EXISTS (SELECT 1 FROM canais_cartoes c WHERE c.proposal_id = agent_proposals.id AND c.user_id = ? AND c.canal = ?)
        ORDER BY created_at, rowid LIMIT 20`, v.workspace_id, v.created_at, v.conversation_id, v.conversation_id, v.user_id, v.canal);
    for (const p of props) this.cartao(v, p, 'Precisa de você');
    const esperando = this.d.db.all<{ id: string; agente: string }>(
      "SELECT r.id, a.name AS agente FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.conversation_id = ? AND r.status = 'waiting_user' AND r.created_at >= ? ORDER BY r.created_at LIMIT 5",
      v.conversation_id, v.created_at);
    for (const w of esperando) {
      if (!this.d.db.run('INSERT INTO canais_avisados (user_id, canal, item, at, sent) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING', v.user_id, v.canal, `w:${w.id}`, now()).changes) continue;
      this.enfileirar(v, 'texto', { texto: `${w.agente && w.agente !== CLOSED_VALUE ? w.agente : 'A equipe'} espera uma resposta sua: responda aqui mesmo.` });
    }
  }

  /** Decidido em qualquer lugar: o cartão enviado fica com a linha final, sem os botões. */
  private atualizarCartoes(ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    const rows = this.d.db.all<{ proposal_id: string; user_id: string; canal: NomeCanal; saida_id: string | null; status: string | null; result: string | null; decided_at: string | null }>(
      `SELECT c.proposal_id, c.user_id, c.canal, c.saida_id, p.status, p.result, p.decided_at FROM canais_cartoes c JOIN canais_vinculos v ON v.user_id = c.user_id AND v.canal = c.canal
         LEFT JOIN agent_proposals p ON p.id = c.proposal_id
        WHERE c.estado = 'open' AND v.workspace_id = ? AND (p.id IS NULL OR p.status <> 'proposed')`, ws);
    const tz = workspaceTz(this.d.db, ws);
    for (const r of rows) {
      const origem = r.saida_id ? this.d.db.get<SaidaRow>('SELECT * FROM canais_saida WHERE id = ?', r.saida_id) : null;
      const v = this.vinculo(r.user_id, r.canal);
      this.d.db.run("UPDATE canais_cartoes SET estado = 'final' WHERE proposal_id = ? AND user_id = ? AND canal = ?", r.proposal_id, r.user_id, r.canal);
      if (!origem || !v || origem.payload === CLOSED_VALUE) continue;
      const linha = linhaFinal({ status: r.status ?? 'gone', result: r.result, decidedAt: r.decided_at }, tz);
      const texto = String((JSON.parse(origem.payload) as { texto?: string }).texto ?? '');
      if (origem.status === 'pending' || (origem.status === 'em_voo' && !origem.message_id)) {
        // ainda não saiu: sai já com a linha final, sem botões
        this.d.db.run('UPDATE canais_saida SET payload = ? WHERE id = ?', this.d.db.seal(ws, JSON.stringify({ texto: `${texto}\n\n${linha}`, botoes: [] })), origem.id);
        continue;
      }
      if (origem.status === 'sent') this.enfileirar(v, 'editar', { origem: origem.id, texto: `${texto}\n\n${linha}` });
    }
  }

  // ------------------------------------------------------------------------------------------------ avisos de "Com você"
  private comVoce(v: VinculoRow): Array<{ chave: string; texto: string; proposta?: { id: string; kind: string; summary: string } }> {
    const d = pendingDecisions(this.d.db, v.workspace_id);
    // o que nasceu numa conversa de canal já foi como cartão por lá
    const doCanal = new Set(this.d.db.all<{ c: string }>('SELECT conversation_id AS c FROM canais_vinculos WHERE user_id = ? AND conversation_id IS NOT NULL', v.user_id).map((r) => r.c));
    const out: Array<{ chave: string; texto: string; proposta?: { id: string; kind: string; summary: string } }> = [];
    for (const p of d.proposals) { if (!(p.conversation_id && doCanal.has(p.conversation_id))) out.push({ chave: `p:${p.id}`, texto: partesDoResumo(p.summary).titulo, proposta: p }); }
    for (const w of d.waiting) { if (!(w.conversation_id && doCanal.has(w.conversation_id))) out.push({ chave: `w:${w.id}`, texto: `${w.agent_name} espera uma resposta sua` }); }
    const precisa: Record<string, string> = { info: 'precisa de uma informação sua', review: 'está pronto para você revisar', approval: 'espera a sua aprovação' };
    for (const c of d.cards) out.push({ chave: `c:${c.id}:${c.work_state}`, texto: `Card #${c.number}: ${c.title} — ${c.agent_name ? `${c.agent_name}: ` : ''}${precisa[c.need] ?? 'espera você'}${c.question ? ` (${c.question})` : ''}` });
    for (const l of d.linkList) out.push({ chave: `l:${l.id}`, texto: `Ligar o card #${l.number} ao #${l.related_number}?` });
    for (const r of d.ruleList) out.push({ chave: `r:${r.id}`, texto: `Regra sugerida: ${r.text}` });
    return out;
  }
  /** Ao ligar (ou religar os avisos): o que já está em "Com você" conta como visto; só o que surgir depois vai ao canal. */
  private linhaDeBase(v: VinculoRow): void {
    if (!this.d.db.workspaceOpen(v.workspace_id)) return;
    for (const x of this.comVoce(v)) this.d.db.run('INSERT INTO canais_avisados (user_id, canal, item, at, sent) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING', v.user_id, v.canal, x.chave, now());
  }
  private varrerAvisos(v: VinculoRow): void {
    if (!Number(v.avisos)) return;
    let novos = 0;
    for (const x of this.comVoce(v)) novos += this.d.db.run('INSERT INTO canais_avisados (user_id, canal, item, at, sent) VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING', v.user_id, v.canal, x.chave, now()).changes;
    if (novos) this.armarAvisos(v.user_id, v.canal, this.ajustes.avisosMs);
  }
  private rearmarAvisos(): void {
    for (const r of this.d.db.all<{ user_id: string; canal: NomeCanal }>('SELECT DISTINCT user_id, canal FROM canais_avisados WHERE sent = 0')) this.armarAvisos(r.user_id, r.canal, this.ajustes.avisosMs);
  }
  private armarAvisos(userId: string, canal: NomeCanal, ms: number): void {
    const k = `${userId}|${canal}`;
    if (this.avisosTimers.has(k)) return;
    const t = setTimeout(() => { this.avisosTimers.delete(k); try { this.enviarAvisos(userId, canal); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: aviso não saiu'); } }, ms);
    t.unref?.();
    this.avisosTimers.set(k, t);
  }
  /** O que surgiu no último minuto vai junto; no máximo 20 avisos por hora por canal. Decisões vão como cartões. */
  private enviarAvisos(userId: string, canal: NomeCanal): void {
    const v = this.vinculo(userId, canal);
    if (!v || !this.d.db.workspaceOpen(v.workspace_id)) return;
    const pend = this.d.db.all<{ item: string }>('SELECT item FROM canais_avisados WHERE user_id = ? AND canal = ? AND sent = 0', userId, canal).map((r) => r.item);
    if (!pend.length) return;
    const agora = new Map(this.comVoce(v).map((x) => [x.chave, x]));
    for (const k of pend) if (!agora.has(k)) this.d.db.run('UPDATE canais_avisados SET sent = 2 WHERE user_id = ? AND canal = ? AND item = ?', userId, canal, k);
    const vivos = pend.filter((k) => agora.has(k));
    if (!vivos.length || !Number(v.avisos)) return;
    let janela: number[] = [];
    try { janela = (JSON.parse(v.aviso_janela ?? '[]') as number[]).filter((t) => typeof t === 'number' && this.agora() - t < 3600_000); } catch { janela = []; }
    if (janela.length >= 20) { this.armarAvisos(userId, canal, Math.max(1000, 3600_000 - (this.agora() - Math.min(...janela)))); return; }
    const itens = vivos.map((k) => agora.get(k)!);
    const decisoes = itens.filter((x) => x.proposta && !SO_NO_ERGON.includes(x.proposta.kind)).slice(0, 5);
    const resto = itens.filter((x) => !decisoes.includes(x));
    if (resto.length) {
      const linhas = resto.slice(0, 10).map((x) => `• ${textoParaTeams(x.texto, 300)}`);
      if (resto.length > 10) linhas.push(`• E mais ${resto.length - 10} no Ergon.`);
      this.enfileirar(v, 'texto', { texto: `${resto.length === 1 ? 'Precisa de você no Ergon:' : `Precisa de você no Ergon (${resto.length}):`}\n${linhas.join('\n')}` });
    }
    for (const x of decisoes) {
      if (!this.d.db.get('SELECT 1 AS x FROM canais_cartoes WHERE proposal_id = ? AND user_id = ? AND canal = ?', x.proposta!.id, userId, canal)) this.cartao(v, x.proposta!, 'Precisa de você no Ergon');
    }
    for (const k of vivos) this.d.db.run('UPDATE canais_avisados SET sent = 1, at = ? WHERE user_id = ? AND canal = ? AND item = ?', now(), userId, canal, k);
    janela.push(this.agora());
    this.d.db.run('UPDATE canais_vinculos SET aviso_janela = ? WHERE user_id = ? AND canal = ?', JSON.stringify(janela.slice(-40)), userId, canal);
  }

  // ------------------------------------------------------------------------------------------------ a fila de saída
  /**
   * POST /internal/bridge/v1/canais/saida (espera longa): o plugin confirma o que mandou e leva o que há para mandar.
   * Item levado fica "em voo" por um tempo; sem confirmação nesse prazo (o motor caiu no meio), vai de novo.
   */
  async saida(motor: string, canaisVivos: NomeCanal[], acks: Array<{ id?: string; ok?: boolean; message_id?: string; erro?: string; passageiro?: boolean }>, esperaS: number): Promise<{ itens: ItemSaida[] }> {
    for (const a of acks.slice(0, 50)) this.confirmar(motor, a);
    let itens = this.pendentes(motor, canaisVivos);
    if (!itens.length && esperaS > 0 && this.ligado) {
      await new Promise<void>((r) => { const t = setTimeout(() => { this.esperando.delete(f); r(); }, Math.min(esperaS * 1000, this.ajustes.esperaMaxMs)); const f = () => { clearTimeout(t); r(); }; this.esperando.add(f); });
      itens = this.pendentes(motor, canaisVivos);
    }
    return { itens };
  }
  private confirmar(motor: string, a: { id?: string; ok?: boolean; message_id?: string; erro?: string; passageiro?: boolean }): void {
    const row = typeof a.id === 'string' ? this.d.db.get<SaidaRow>('SELECT * FROM canais_saida WHERE id = ?', a.id) : null;
    if (!row || !this.d.permite(motor, row.workspace_id) || row.status === 'sent' || row.status === 'failed') return;
    if (a.ok) {
      this.d.db.run("UPDATE canais_saida SET status = 'sent', message_id = ?, tentativas = tentativas + 1 WHERE id = ?", typeof a.message_id === 'string' ? a.message_id.slice(0, 64) : null, row.id);
      if (row.tipo === 'cartao') this.atualizarCartoes(row.workspace_id); // decidido enquanto o cartão ia
      return;
    }
    if (a.passageiro && row.tentativas < 12) {
      const espera = Math.min(10 * 60_000, 2000 * 2 ** Math.min(row.tentativas, 8));
      this.d.db.run("UPDATE canais_saida SET status = 'pending', tentativas = tentativas + 1, proximo_em = ?, erro = ? WHERE id = ?", new Date(this.agora() + espera).toISOString(), String(a.erro ?? '').slice(0, 80), row.id);
      return;
    }
    this.d.db.run("UPDATE canais_saida SET status = 'failed', tentativas = tentativas + 1, erro = ? WHERE id = ?", String(a.erro ?? 'falhou').slice(0, 80), row.id);
    log.warn({ canal: row.canal, erro: String(a.erro ?? '').slice(0, 80) }, 'canais: uma mensagem não saiu');
  }
  private pendentes(motor: string, canaisVivos: NomeCanal[]): ItemSaida[] {
    const vivos = new Set(canaisVivos.filter((c) => CANAIS.includes(c)));
    const out: ItemSaida[] = [];
    const agoraIso = new Date(this.agora()).toISOString();
    // "digitando": enquanto a equipe trabalha na conversa do canal (não fica gravado)
    for (const k of [...this.digitar]) {
      const [u, c] = k.split('|') as [string, NomeCanal];
      const v = this.vinculo(u, c);
      if (!v || !vivos.has(c) || !this.d.permite(motor, v.workspace_id)) continue;
      out.push({ id: `typ_${novoId('x')}`, canal: c, tipo: 'digitando', chat_id: v.chat_id, user_id: v.externo_id });
    }
    const rows = this.d.db.all<SaidaRow>(
      `SELECT * FROM canais_saida WHERE (status = 'pending' OR (status = 'em_voo' AND message_id IS NULL)) AND proximo_em <= ? ORDER BY created_at, rowid LIMIT 200`, agoraIso);
    const parado = new Set<string>(); // o mais antigo de cada canal vai primeiro: o seguinte não passa à frente
    for (const row of rows) {
      const k = `${row.user_id}|${row.canal}`;
      if (out.length >= 20 || parado.has(k)) continue;
      if (!vivos.has(row.canal) || !this.d.permite(motor, row.workspace_id) || !this.d.db.workspaceOpen(row.workspace_id)) { parado.add(k); continue; }
      const v = this.vinculo(row.user_id, row.canal);
      if (!v || row.payload === CLOSED_VALUE) { this.d.db.run("UPDATE canais_saida SET status = 'failed', erro = 'sem_vinculo' WHERE id = ?", row.id); continue; }
      const pl = JSON.parse(row.payload) as { texto?: string; botoes?: Array<[string, string]>; origem?: string };
      const item: ItemSaida = { id: row.id, canal: row.canal, tipo: row.tipo, chat_id: v.chat_id, user_id: v.externo_id, texto: String(pl.texto ?? '') };
      if (row.tipo === 'cartao') item.botoes = (pl.botoes ?? []).slice(0, 4);
      if (row.tipo === 'editar') {
        const origem = pl.origem ? this.d.db.get<{ message_id: string | null; status: string }>('SELECT message_id, status FROM canais_saida WHERE id = ?', pl.origem) : null;
        if (!origem || origem.status === 'failed') { this.d.db.run("UPDATE canais_saida SET status = 'failed', erro = 'sem_origem' WHERE id = ?", row.id); continue; }
        if (!origem.message_id) { parado.add(k); continue; }
        item.message_id = origem.message_id;
      }
      this.d.db.run("UPDATE canais_saida SET status = 'em_voo', proximo_em = ? WHERE id = ?", new Date(this.agora() + this.ajustes.arrendamentoMs).toISOString(), row.id);
      out.push(item);
    }
    return out;
  }
  /** A cada poucos segundos: o "digitando" de quem ainda espera, e a limpeza do que venceu. */
  private passo(): void {
    for (const k of [...this.digitar]) {
      const [u, c] = k.split('|') as [string, NomeCanal];
      const v = this.vinculo(u, c);
      if (!v?.conversation_id || !this.d.db.workspaceOpen(v.workspace_id) || !this.trabalhando(v.conversation_id)) this.digitar.delete(k);
    }
    if (this.digitar.size) this.acordar();
    const ago = (ms: number) => new Date(this.agora() - ms).toISOString();
    this.d.db.run(`DELETE FROM canais_saida WHERE created_at < ? AND NOT (status = 'sent' AND created_at >= ? AND id IN (SELECT saida_id FROM canais_cartoes WHERE estado = 'open'))`, ago(7 * DIA), ago(30 * DIA));
    this.d.db.run('DELETE FROM canais_cartoes WHERE saida_id IS NOT NULL AND saida_id NOT IN (SELECT id FROM canais_saida)');
    this.d.db.run('DELETE FROM canais_entrada WHERE recebida_em < ?', ago(8 * DIA));
    this.d.db.run('DELETE FROM canais_avisados WHERE sent <> 0 AND at < ?', ago(30 * DIA));
  }

  // ------------------------------------------------------------------------------------------------ tela (rotas)
  private exigirControle(ws: string): HermesControlClient {
    const c = this.d.control(ws);
    if (!c?.canais || !c.setCanal || !c.parearCanal || !c.removerCanal) throw new HttpError(409, 'motor', 'A equipe precisa estar ligada (e atualizada) para isso.');
    return c;
  }
  private erroDaTela(e: unknown): never {
    if (e instanceof CanalErro) throw new HttpError(e.code === 'tentativas' ? 429 : e.code === 'motor' ? 503 : 400, e.code, e.message);
    throw e;
  }
  /** GET /api/canais: a situação de cada canal desta pessoa. */
  async estado(userId: string, ws: string): Promise<Record<NomeCanal, Record<string, unknown>>> {
    const caps = await this.d.capacidades(ws).catch(() => null);
    const c = this.d.control(ws);
    const disponivel = !!caps?.includes(CAPACIDADE_CANAIS) && !!c?.canais;
    let doMotor: Record<NomeCanal, CanalNoMotor> | null = null;
    if (disponivel) { try { doMotor = await c!.canais!(); } catch { doMotor = null; } }
    const out = {} as Record<NomeCanal, Record<string, unknown>>;
    for (const canal of CANAIS) {
      const v = this.vinculo(userId, canal);
      const bot = !!this.d.db.get('SELECT 1 AS x FROM canais_bots WHERE user_id = ? AND canal = ?', userId, canal);
      const m = doMotor?.[canal];
      const configurado = m ? m.configurado : bot;
      // situação da conexão do gateway: conectado, tentando de novo ou sem conexão (sem rede, código recusado)
      const conexao = !m || !m.configurado ? null : m.estado === 'connected' ? 'conectado' : m.estado === 'fatal' ? 'sem_conexao' : 'conectando';
      out[canal] = {
        disponivel, ...(disponivel ? {} : { motivo: caps ? 'versao' : 'motor' }), bot: configurado, conexao,
        ...(m?.erro === 'telegram_token_invalid' || /unauthorized|invalid_token|login/i.test(m?.erro ?? '') ? { codigoRecusado: true } : {}),
        ligado: v ? { nome: v.nome && v.nome !== CLOSED_VALUE ? v.nome : null, desde: v.created_at, avisos: Number(v.avisos) === 1 } : null,
      };
    }
    return out;
  }
  /** Guarda o código do bot no motor (o gateway reinicia). Bot novo: a ligação de antes não vale mais. */
  async guardarBot(userId: string, ws: string, canal: NomeCanal, token: string): Promise<void> {
    const t = token.trim();
    if (!FORMATO_TOKEN[canal].test(t)) throw new HttpError(400, 'formato', 'Esse não parece o código do bot. Copie de novo, inteiro.');
    const c = this.exigirControle(ws);
    try { await c.setCanal!(canal, t); } catch (e) { this.erroDaTela(e); }
    this.d.db.tx(() => {
      this.d.db.run('INSERT INTO canais_bots (user_id, canal, workspace_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, canal) DO UPDATE SET workspace_id = excluded.workspace_id, created_at = excluded.created_at', userId, canal, ws, now());
      this.esquecer(userId, canal);
    });
    this.avisarTela(userId);
  }
  /** Confirma o código que o bot mandou à pessoa (o pareamento do próprio gateway): a conversa fica ligada a ela. */
  async parear(userId: string, ws: string, canal: NomeCanal, codigo: string): Promise<void> {
    const cod = codigo.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(cod)) throw new HttpError(400, 'codigo', 'O código tem 8 letras e números. Confira e tente de novo.');
    const c = this.exigirControle(ws);
    let r: { userId: string; userName: string; chatId: string };
    try { r = await c.parearCanal!(canal, cod); } catch (e) { this.erroDaTela(e); }
    if (!/^[0-9]{3,30}$/.test(r.userId)) throw new HttpError(502, 'motor', 'A equipe não confirmou a conta agora. Tente de novo.');
    const chat = /^-?[0-9]{3,30}$/.test(r.chatId) ? r.chatId : r.userId;
    this.d.db.tx(() => {
      this.esquecer(userId, canal);
      this.d.db.run(`INSERT INTO canais_vinculos (user_id, canal, workspace_id, externo_id, chat_id, nome, avisos, cursor_rowid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        userId, canal, ws, r.userId, chat, this.d.db.seal(ws, r.userName.slice(0, 120)), Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0), now(), now());
      this.d.db.run('INSERT INTO canais_bots (user_id, canal, workspace_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, canal) DO NOTHING', userId, canal, ws, now());
    });
    this.linhaDeBase(this.vinculo(userId, canal)!);
    this.assinar(ws);
    this.avisarTela(userId);
  }
  setAvisos(userId: string, canal: NomeCanal, avisos: boolean): void {
    const v = this.vinculo(userId, canal);
    if (!v) throw new HttpError(404, 'not_found', 'conversa não ligada');
    this.d.db.run('UPDATE canais_vinculos SET avisos = ?, updated_at = ? WHERE user_id = ? AND canal = ?', avisos ? 1 : 0, now(), userId, canal);
    if (avisos) this.linhaDeBase(v);
    this.avisarTela(userId);
  }
  /** Desligar: o motor apaga o código do bot e o pareamento; aqui somem a ligação e o que esperava para sair. */
  async desligar(userId: string, ws: string, canal: NomeCanal): Promise<void> {
    const c = this.exigirControle(ws);
    try { await c.removerCanal!(canal); } catch (e) { this.erroDaTela(e); }
    this.d.db.tx(() => {
      this.esquecer(userId, canal);
      this.d.db.run('DELETE FROM canais_bots WHERE user_id = ? AND canal = ?', userId, canal);
    });
    this.avisarTela(userId);
  }
  private esquecer(userId: string, canal: NomeCanal): void {
    for (const t of ['canais_vinculos', 'canais_saida', 'canais_cartoes', 'canais_avisados']) this.d.db.run(`DELETE FROM ${t} WHERE user_id = ? AND canal = ?`, userId, canal);
    this.digitar.delete(`${userId}|${canal}`);
  }

  /** Para os testes e o diagnóstico. */
  pendentesDeSaida(): number { return Number(this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canais_saida WHERE status IN ('pending', 'em_voo')")?.n ?? 0); }
}
