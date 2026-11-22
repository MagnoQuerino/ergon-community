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
 * O número da equipe no WhatsApp (canais/whatsapp.ts: um número pareado por QR, usado como canal) segue este mesmo caminho
 * como canal LOCAL, sem motor: um por remetente liberado (`whatsapp:<workspace>:<conta>:<telefone>`). A mensagem entra por
 * `receberLocal` e a fila de saída é entregue aqui mesmo, pelo `entregadorLocal` (a sessão do Baileys do próprio app), em
 * vez de ir ao plugin.
 */
import type { Config } from '../../config.ts';
import type { Db } from '../../db/db.ts';
import { HttpError, id as novoId, now } from '../../lib/util.ts';
import { log } from '../../lib/log.ts';
import { CLOSED_VALUE } from '../../security/fields.ts';
import { audit, type Bus, type BusEvent } from '../bus.ts';
import { createConversation, sendMessage } from '../chat.ts';
import { CANAIS_DE_APP, CANAIS_RC46, CanalErro, NOMES_CANAL, type CanalNoMotor, type CredencialCanal, type HermesControlClient, type LoginQrMotor, type NomeCanal } from '../hermes.ts';
import type { WorkspaceOwners } from '../people.ts';
import { pendingDecisions } from '../proposals.ts';
import { workspaceTz } from '../routine-proposals.ts';
import type { RunExecutor } from '../runs.ts';
import { coordinatorFor } from '../team-query.ts';
import { CanaisExternos, KIND_EXTERNO } from './externo.ts';
import { PREFIXO, validarBloco } from '../../../../shared/visuais/esquema.ts';
import { blocosDe } from '../../../../shared/visuais/cercas.ts';
import { visualParaPng } from '../visuais/png.ts';
import { resumoVisivelDaAprovacao } from '../aprovacao-cartao.ts';
import { avisoDoCard } from '../resumo-tarefa.ts';
import { fmtData, msg } from '../../lib/i18n.ts';
import { readLang } from '../prefs.ts';
import { ABRIR_LONGO, LIMITE_CANAL, cabeNoCanal, dataHora, linhaFinal, partesDoResumo, textoParaTeams } from '../teams-app/cartoes.ts';

const CANAIS: readonly NomeCanal[] = NOMES_CANAL;
const NOME_CANAL: Record<NomeCanal, string> = { telegram: 'Telegram', discord: 'Discord', feishu: 'Feishu/Lark', dingtalk: 'DingTalk', wecom: 'WeCom', weixin: 'WeChat' };
/**
 * rc.45: o Feishu/Lark e o DingTalk entram pelo mesmo caminho, com o aplicativo próprio da pessoa (App ID e App Secret no
 * cofre do motor). Sem botões de verdade pelo gateway: os cartões vão como texto e a decisão é no app do Ergon (como o
 * pedido de risco da camada externo.ts). O DingTalk só responde pela "sessionWebhook" da última mensagem (vale cerca de
 * uma hora e meia): aviso mais tarde, sem mensagem nova da pessoa, não sai, e a imagem dos visuais não vai (o texto já leva
 * os números). O Feishu manda a imagem e edita o cartão.
 */
/**
 * rc.46: o WeCom (企业微信) pelo robô inteligente (Bot ID e Secret, WebSocket de saída) e o WeChat pessoal (微信, iLink,
 * login por QR na tela; experimental, com o consentimento da pessoa). Nos dois, sem botões nem edição; a imagem dos
 * visuais vai só no WeCom (no WeChat pessoal, menos envio é menos risco para a conta).
 */
const SEM_BOTOES: ReadonlySet<CanalId> = new Set<CanalId>([...CANAIS_DE_APP, 'weixin']);
const SEM_IMAGEM: ReadonlySet<CanalId> = new Set<CanalId>(['dingtalk', 'weixin']);
/** O id da conta e da conversa no canal: número (Telegram, Discord) ou texto do Feishu (ou_…, oc_…) e do DingTalk ($:LWCP…, cid…). */
const FORMATO_ID: Record<NomeCanal, RegExp> = {
  telegram: /^[0-9]{3,30}$/, discord: /^[0-9]{3,30}$/,
  feishu: /^[A-Za-z0-9_-]{3,100}$/, dingtalk: /^[A-Za-z0-9_$:+/=.-]{3,120}$/,
  wecom: /^[A-Za-z0-9_@.-]{1,64}$/, weixin: /^[A-Za-z0-9_@.:-]{3,120}$/,
};
const FORMATO_CHAT: Record<NomeCanal, RegExp> = {
  telegram: /^-?[0-9]{3,30}$/, discord: /^-?[0-9]{3,30}$/,
  feishu: /^[A-Za-z0-9_-]{3,100}$/, dingtalk: /^[A-Za-z0-9_$:+/=.-]{3,120}$/,
  wecom: /^[A-Za-z0-9_@.-]{1,64}$/, weixin: /^[A-Za-z0-9_@.:-]{3,120}$/,
};
/** A capacidade do plugin que fala com o Feishu e o DingTalk (rc.45). */
const CAPACIDADE_CANAIS_APP = 'canais_feishu_dingtalk';
/** A do WeCom e do WeChat pessoal (rc.46). */
const CAPACIDADE_CANAIS_RC46 = 'canais_wecom_weixin';
/** O canal pede uma versão do plugin mais nova que a dos canais de sempre? */
const capacidadeDoCanal = (canal: NomeCanal): string | null => (CANAIS_RC46.includes(canal) ? CAPACIDADE_CANAIS_RC46 : CANAIS_DE_APP.includes(canal) ? CAPACIDADE_CANAIS_APP : null);
/** A versão do texto do risco do WeChat pessoal (web: Conexões › WeChat): mudou o texto, pede o consentimento de novo. */
export const WEIXIN_RISCO_VERSAO = 1;
/** O App ID e o App Secret de cada aplicativo (os mesmos formatos do plugin). */
const FORMATO_APP: Partial<Record<NomeCanal, { id: RegExp; segredo: RegExp }>> = {
  feishu: { id: /^cli_[A-Za-z0-9]{8,40}$/, segredo: /^[A-Za-z0-9]{16,64}$/ },
  dingtalk: { id: /^[A-Za-z0-9_-]{8,64}$/, segredo: /^[A-Za-z0-9_-]{16,128}$/ },
  // o Bot ID e o Secret do robô inteligente do WeCom (os mesmos formatos do plugin)
  wecom: { id: /^[A-Za-z0-9_-]{8,64}$/, segredo: /^[A-Za-z0-9_-]{16,128}$/ },
};
/** Canal local (sem motor): um remetente liberado do número da equipe, `whatsapp:<workspace>:<conta>:<telefone>`. */
export type CanalLocal = `whatsapp:${string}`;
export type CanalId = NomeCanal | CanalLocal;
export const ehCanalLocal = (c: string): c is CanalLocal => c.startsWith('whatsapp:');
const nomeDoCanal = (c: CanalId): string => (ehCanalLocal(c) ? 'WhatsApp' : NOME_CANAL[c]);
/** O que sai por um canal local: o entregador manda e diz se saiu (`esperarMs`: limite de envio, tenta depois sem contar falha). */
export interface ItemLocal { id: string; tipo: 'texto' | 'cartao' | 'editar'; texto: string; botoes: Array<[string, string]>; origem?: string }
export interface ResultadoLocal { ok: boolean; message_id?: string; erro?: string; passageiro?: boolean; esperarMs?: number }
export type EntregadorLocal = (v: { userId: string; canal: CanalLocal; workspaceId: string; chatId: string }, item: ItemLocal) => Promise<ResultadoLocal>;
/** O formato do código de cada bot (o mesmo do plugin): o que não tem esse jeito nem vai ao motor. */
const FORMATO_TOKEN: Partial<Record<NomeCanal, RegExp>> = {
  telegram: /^\d{5,14}:[A-Za-z0-9_-]{30,64}$/,
  discord: /^[A-Za-z0-9_-]{18,40}\.[A-Za-z0-9_-]{4,12}\.[A-Za-z0-9_-]{20,90}$/,
};
const CAPACIDADE_CANAIS = 'canais';
/** A instrução do canal para chat.ts (chatHooks.channelNote). */
export const notaCanal = (c: CanalId) => (ehCanalLocal(c)
  ? 'Canal: conversa pelo WhatsApp. Quem escreve, do WhatsApp dele, para o número da equipe (pareado neste Ergon) é um telefone liberado e confirmado por código pela pessoa dona do workspace. A resposta sai do número da equipe para ele: texto simples, sem tabelas largas; confirmações vão como opções numeradas.'
  : `Canal: conversa pelo ${NOME_CANAL[c]}. Quem escreve é a pessoa dona do workspace, pela conta do ${NOME_CANAL[c]} ligada por código. A resposta vai para o ${NOME_CANAL[c]}: texto simples, sem tabelas largas.`);
const notaDeAtrasoCanal = (c: CanalId, quando: string) => `Pedido enviado pelo ${nomeDoCanal(c)} em ${quando}, entregue agora com atraso (este Ergon estava fechado). Antes de agir no que depende de data ou hora, confirme com a pessoa.`;
const ATRASO_MS = 10 * 60_000;
/** O que só se responde no Ergon: autorização com senha, pergunta, pedido de chave ou senha (o valor nunca passa pelo canal). */
const SO_NO_ERGON = ['permission', 'question', 'segredo', 'info_request', 'handoff', KIND_EXTERNO];
const DIA = 86_400_000;
/** O relé guarda o pedido até 60 dias, até o Ergon abrir: o id das entregas já recebidas fica um dia a mais (sem repetir). */
const ENTRADA_VALE_MS = 61 * DIA;
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
  user_id: string; canal: CanalId; workspace_id: string; externo_id: string; chat_id: string; nome: string | null; avisos: number;
  conversation_id: string | null; cursor_rowid: number; aviso_janela: string | null; primeira_em: string | null; created_at: string;
}
interface SaidaRow { id: string; user_id: string; canal: CanalId; workspace_id: string; tipo: 'texto' | 'cartao' | 'editar' | 'imagem'; payload: string; status: string; tentativas: number; proximo_em: string; message_id: string | null; created_at: string }
interface ItemSaida { id: string; canal: NomeCanal; tipo: 'texto' | 'cartao' | 'editar' | 'digitando' | 'imagem'; chat_id: string; user_id: string; texto?: string; botoes?: Array<[string, string]>; message_id?: string; png?: string; bloco?: unknown }
/** rc.42: os blocos visuais que também vão como imagem (o Telegram e o Discord mostram o PNG; o texto vai antes) */
const VAI_COMO_IMAGEM = new Set(['kpi', 'kpis', 'nota', 'barras', 'linhas', 'pizza', 'tabela', 'comparativo', 'versus', 'placar', 'linha_do_tempo', 'progresso', 'status', 'semaforo', 'ficha', 'medidor', 'sparkline', 'icones', 'funil', 'calor', 'matriz', 'enquete', 'decisao', 'checklist']);

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
function migrarCanais(db: Db): void {
  db.raw.exec('CREATE TABLE IF NOT EXISTS canais_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const feitas = new Set(db.all<{ name: string }>('SELECT name FROM canais_migrations').map((r) => r.name));
  for (const [nome, sql] of MIGRACOES) {
    if (feitas.has(nome)) continue;
    db.tx(() => { db.raw.exec(sql); db.run('INSERT INTO canais_migrations (name, applied_at) VALUES (?, ?)', nome, now()); });
  }
}

interface CanaisDeps {
  db: Db; bus: Bus; cfg: Config; executor: RunExecutor; owners: WorkspaceOwners;
  /** a ponte de controle do motor do workspace (null: motor desligado ou instalação sem motor) */
  control: (ws: string) => HermesControlClient | null;
  /** as capacidades do plugin no motor do workspace (null: não se sabe agora) */
  capacidades: (ws: string) => Promise<string[] | null>;
  /** o motor que chamou a ponte pode agir neste workspace? */
  permite: (motor: string, ws: string) => boolean;
  /** a mesma decisão de POST /api/proposals/:id */
  decidir: (ws: string, userId: string, proposalId: string, decisao: 'apply' | 'reject') => Promise<{ status: string; result: string }>;
  /** o papel do membro no Ergon World (admin, editor, viewer), quando o workspace é sincronizado; sem ele, 'member' é leitura */
  papelWorld?: (userId: string, ws: string) => string | null;
}

/** Ajustes de tempo (os testes encurtam). */
interface AjustesCanais { avisosMs: number; atrasoMs: number; digitandoMs: number; esperaMaxMs: number; arrendamentoMs: number }

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
  /** quem entrega a fila dos canais locais (o WhatsApp pareado); sem ele, o que é local espera */
  entregadorLocal: EntregadorLocal | null = null;
  private drenando = false;
  private drenarDeNovo = false;
  private drenoTimer: NodeJS.Timeout | null = null;

  /** a camada comum dos canais externos: membro, papel, volume, pedidos de risco e auditoria (externo.ts) */
  readonly externos: CanaisExternos;

  constructor(d: CanaisDeps) {
    this.d = d; migrarCanais(d.db);
    this.externos = new CanaisExternos({ db: d.db, bus: d.bus, papelWorld: d.papelWorld ?? null });
    this.externos.entregarAprovado = (p) => this.entregarAprovado(p);
    this.externos.avisarNoCanal = (p) => { const v = this.vinculo(p.memberId, p.channel as CanalId); if (v) this.enfileirar(v, 'texto', { texto: p.texto }); };
    // saiu do workspace: os canais dele ali somem
    this.externos.aoRemoverMembro((ws, u) => {
      for (const v of this.d.db.all<{ canal: CanalId }>('SELECT canal FROM canais_vinculos WHERE workspace_id = ? AND user_id = ?', ws, u)) this.esquecer(u, v.canal);
      this.avisarTela(u);
    });
  }

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
    if (this.drenoTimer) { clearTimeout(this.drenoTimer); this.drenoTimer = null; }
    for (const u of this.assinaturas.values()) u(); this.assinaturas.clear();
    this.acordar();
  }
  /** A pessoa entrou: o que esperava pela parte dela anda, e a fila de saída é entregue. */
  personOpened(userId: string): void {
    for (const ws of new Set(this.vinculosDe(userId).map((v) => v.workspace_id))) this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
    this.acordar();
  }
  /** o que os canais locais guardam da pessoa (canais/whatsapp.ts) */
  aoRemoverPessoa: ((userId: string) => void) | null = null;
  pessoaRemovida(userId: string): void {
    // a pessoa saiu do Ergon: os canais dela caem agora, com registro em cada workspace em que estavam ligados
    for (const r of this.d.db.all<{ w: string }>('SELECT DISTINCT workspace_id AS w FROM canais_vinculos WHERE user_id = ?', userId)) {
      try { audit(this.d.db, this.d.bus, { workspaceId: r.w, actorType: 'system', actorId: 'ergon', action: 'canal.externo.revogado', targetType: 'user', targetId: userId, evidence: { membro: userId, motivo: 'pessoa removida do Ergon' }, result: 'canais externos revogados: pessoa removida do Ergon' }); } catch { /* o workspace já saiu junto */ }
    }
    this.aoRemoverPessoa?.(userId);
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
  private vinculo(userId: string, canal: CanalId): VinculoRow | null { return this.d.db.get<VinculoRow>('SELECT * FROM canais_vinculos WHERE user_id = ? AND canal = ?', userId, canal) ?? null; }
  private vinculosDe(userId: string): VinculoRow[] { return this.d.db.all<VinculoRow>('SELECT * FROM canais_vinculos WHERE user_id = ? ORDER BY canal', userId); }
  private doCanal(motor: string, canal: NomeCanal, externo: string): VinculoRow | null {
    return this.d.db.all<VinculoRow>('SELECT * FROM canais_vinculos WHERE canal = ? AND externo_id = ? ORDER BY created_at', canal, externo).find((v) => this.d.permite(motor, v.workspace_id)) ?? null;
  }
  /** A conversa do canal com o coordenador; uma nova se a de antes sumiu, foi arquivada ou encheu. */
  private conversa(v: VinculoRow): string {
    if (v.conversation_id) {
      const c = this.d.db.get<{ id: string; n: number }>(
        `SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c JOIN agents a ON a.id = c.agent_id
          WHERE c.id = ? AND c.workspace_id = ? AND c.owner_user_id = ? AND c.sala = 0 AND c.archived_at IS NULL AND a.status = 'active'`, v.conversation_id, v.workspace_id, v.user_id);
      if (c && Number(c.n) < this.d.cfg.maxConversationMessages - 4) return c.id;
    }
    const agente = coordinatorFor(this.d.db, v.workspace_id) ?? this.d.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", v.workspace_id)?.id;
    if (!agente) throw new HttpError(409, 'no_agent', 'sem ninguém ativo na equipe');
    const conv = createConversation(this.d.db, v.workspace_id, v.user_id, agente,
      ehCanalLocal(v.canal) && v.nome && v.nome !== CLOSED_VALUE ? `WhatsApp · ${v.nome}`.slice(0, 120) : nomeDoCanal(v.canal));
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
    const ext = `\n${this.externos.nota(this.externos.papel(v.workspace_id, v.user_id) ?? 'viewer', v.canal)}`;
    if (!messageId) return notaCanal(v.canal) + ext;
    const r = this.d.db.get<{ sent_at: string | null; atrasada: number }>(
      `SELECT e.sent_at, e.atrasada FROM messages m JOIN canais_entrada e ON e.request_id = m.client_request_id WHERE m.id = ? AND m.conversation_id = ? AND e.tipo = 'mensagem'`, messageId, conversationId);
    if (!r || !Number(r.atrasada) || !r.sent_at) return notaCanal(v.canal) + ext;
    return `${notaCanal(v.canal)}${ext}\n${notaDeAtrasoCanal(v.canal, dataHora(r.sent_at, workspaceTz(this.d.db, v.workspace_id)))}`;
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
    return this.receber(v, b);
  }

  /**
   * Mensagem de um canal local (o WhatsApp pareado): quem chama já conferiu que veio da própria pessoa, na conversa
   * consigo mesma, ou de um contato que ela liberou. Daqui em diante é o mesmo caminho do Telegram e do Discord.
   */
  receberLocal(userId: string, canal: CanalLocal, b: { message_id: string; text: string; sent_at?: string | null }): { ok: boolean; reply?: string } {
    const v = this.vinculo(userId, canal);
    if (!v) return { ok: false };
    if (!this.d.db.workspaceOpen(v.workspace_id)) return { ok: false, reply: RESPOSTA.trancado };
    return this.receber(v, { canal, user_id: v.externo_id, chat_id: v.chat_id, message_id: b.message_id, text: b.text, sent_at: b.sent_at ?? undefined });
  }
  /** A resposta numerada a um cartão num canal local: decide pela mesma função do botão (e da tela). */
  decidirLocal(userId: string, canal: CanalLocal, dado: string, evento: string): { ok: boolean; reply?: string } {
    const v = this.vinculo(userId, canal);
    if (!v) return { ok: false };
    if (!this.d.db.workspaceOpen(v.workspace_id)) return { ok: false, reply: RESPOSTA.trancado };
    return this.clique(v, dado, evento);
  }
  /** Um texto do Ergon (não da equipe) para um canal local: o aviso de atraso, a resposta a um número que não confere. */
  avisarLocal(userId: string, canal: CanalLocal, texto: string): void {
    const v = this.vinculo(userId, canal);
    if (v) this.enfileirar(v, 'texto', { texto });
  }

  private receber(v: VinculoRow, b: { canal: CanalId; user_id: string; chat_id: string; message_id?: string; text?: string; sent_at?: string }): { ok: boolean; reply?: string; digitando?: boolean } {
    const chave = `${b.canal}:${b.user_id}:${String(b.message_id ?? '')}`.slice(0, 300);
    if (b.message_id && this.d.db.get('SELECT 1 AS x FROM canais_entrada WHERE chave = ?', chave)) return { ok: true }; // entregue de novo: já está na conversa
    const texto = String(b.text ?? '').trim();
    if (!texto) return { ok: true, reply: RESPOSTA.soTexto };
    // a camada comum dos canais externos (externo.ts): o membro, o papel dele, o volume e os pedidos de risco
    const ext = this.externos.externalRequest({ channel: v.canal, workspaceId: v.workspace_id, memberId: v.user_id, text: texto, conversationId: v.conversation_id });
    if (!ext.ok) {
      this.d.db.run('INSERT OR IGNORE INTO canais_entrada (chave, user_id, canal, tipo, request_id, recebida_em) VALUES (?, ?, ?, ?, ?, ?)', chave, v.user_id, v.canal, `retido:${ext.motivo}`, ext.proposalId ?? null, now());
      return { ok: true, ...(ext.resposta ? { reply: ext.resposta } : {}) };
    }
    const r = this.entregarNaConversa(v, texto, chave, b.sent_at ?? null, b.chat_id);
    if (r) return r;
    if (ehCanalLocal(v.canal)) return { ok: true };
    this.digitar.add(`${v.user_id}|${v.canal}`);
    return { ok: true, digitando: true };
  }

  /** O pedido aprovado no app (externo.ts): vai à conversa do canal como pedido do membro, com a aprovação à vista. */
  private entregarAprovado(p: { channel: string; memberId: string; text: string; proposalId: string; aprovadoPor: string }): void {
    const v = this.vinculo(p.memberId, p.channel as CanalId);
    if (!v || !this.d.db.workspaceOpen(v.workspace_id)) return;
    const conv = this.conversa(v);
    const quem = this.d.db.get<{ nome: string | null; username: string }>('SELECT display_name AS nome, username FROM users WHERE id = ?', p.aprovadoPor);
    this.notaNaConversa(v.workspace_id, conv, `Sistema — o pedido abaixo chegou pelo ${nomeDoCanal(v.canal)} e foi aprovado no app por ${quem ? quem.nome || quem.username : 'quem administra o workspace'}.`);
    if (this.entregarNaConversa(v, p.text, `aprovado:${p.proposalId}`, null, null)) return;
    this.enfileirar(v, 'texto', { texto: msg(readLang(this.d.db, v.user_id), 'canal.aprovado') });
    if (!ehCanalLocal(v.canal)) this.digitar.add(`${v.user_id}|${v.canal}`);
  }

  /** A mensagem vira mensagem do membro na conversa do canal (o mesmo caminho do app). null = entregue; senão, a resposta. */
  private entregarNaConversa(v: VinculoRow, texto: string, chave: string, sentAt: string | null, chatId: string | null | undefined): { ok: boolean; reply?: string } | null {
    const conv = this.conversa(v);
    const crid = `canal-${novoId('m').replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 64);
    const quando = sentAt && Number.isFinite(Date.parse(sentAt)) ? new Date(Date.parse(sentAt)).toISOString() : null;
    const atrasada = !!quando && this.agora() - Date.parse(quando) > ATRASO_MS;
    const b = { chat_id: chatId };
    try {
      this.d.db.tx(() => {
        this.d.db.run('INSERT INTO canais_entrada (chave, user_id, canal, tipo, request_id, sent_at, atrasada, recebida_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          chave, v.user_id, v.canal, 'mensagem', crid, quando, atrasada ? 1 : 0, now());
        // a primeira mensagem pela conta ligada fica à vista no Ergon: quem não ligou esta conta percebe e desliga
        if (!v.primeira_em) {
          this.d.db.run('UPDATE canais_vinculos SET primeira_em = ? WHERE user_id = ? AND canal = ?', now(), v.user_id, v.canal);
          const nome = v.nome && v.nome !== CLOSED_VALUE ? v.nome : 'sem nome';
          this.notaNaConversa(v.workspace_id, conv, ehCanalLocal(v.canal)
            ? `Sistema — primeira mensagem pelo número da equipe no WhatsApp, de ${nome} (liberado em ${dataHora(v.created_at, workspaceTz(this.d.db, v.workspace_id))}). Se não foi você que liberou este telefone, tire em Conexões › WhatsApp.`
            : this.notaPrimeira(v, nome));
        }
        sendMessage(this.d.db, this.d.bus, this.d.executor, v.workspace_id, v.user_id, conv, texto.slice(0, this.d.cfg.maxInputChars), crid,
          this.d.cfg.maxConversationMessages, this.d.cfg.maxInputChars, { queue: true });
        if (b.chat_id && b.chat_id !== v.chat_id) this.d.db.run('UPDATE canais_vinculos SET chat_id = ? WHERE user_id = ? AND canal = ?', String(b.chat_id).slice(0, 128), v.user_id, v.canal);
      });
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) return { ok: false, reply: RESPOSTA.naoDeu.replace('{motivo}', err.message) };
      throw err;
    }
    return null;
  }

  /** A nota da primeira mensagem pela conta ligada: no idioma de quem ligou (rc.45); em português, a de sempre. */
  private notaPrimeira(v: VinculoRow, nome: string): string {
    const tz = workspaceTz(this.d.db, v.workspace_id);
    const canal = NOME_CANAL[v.canal as NomeCanal];
    const lang = readLang(this.d.db, v.user_id);
    if (lang && lang !== 'pt-BR') {
      return msg(lang, 'canal.primeiraMensagem', { canal, nome, quando: fmtData(lang, v.created_at, { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) });
    }
    return `Sistema — primeira mensagem pela conta do ${canal} "${nome}", ligada em ${dataHora(v.created_at, tz)}. Se não foi você que ligou esta conta, desligue em Conexões › ${canal}.`;
  }

  /** Clique em Aprovar/Recusar: decide pela mesma função da tela, fora do pedido (pode chamar outro app e demorar). */
  private clique(v: VinculoRow, dado: string, evento: string): { ok: boolean; reply?: string } {
    const m = /^([ar]):(apr_[a-f0-9]{32})$/.exec(dado);
    if (!m) return { ok: false };
    if (SEM_BOTOES.has(v.canal)) return { ok: true, reply: RESPOSTA.noErgon }; // canal sem botões: nenhum clique decide
    const pid = m[2]; const decisao = m[1] === 'a' ? 'apply' : 'reject';
    const prop = this.d.db.get<{ status: string; kind: string; summary: string }>('SELECT status, kind, summary FROM agent_proposals WHERE id = ? AND workspace_id = ?', pid, v.workspace_id);
    if (!prop) return { ok: false, reply: RESPOSTA.jaDecidido };
    // um botão antigo de um pedido que não cabe inteiro no canal também não decide
    if (SO_NO_ERGON.includes(prop.kind) || !cabeNoCanal(prop.kind, prop.summary, LIMITE_CANAL)) return { ok: true, reply: RESPOSTA.noErgon };
    // por canal externo, só o que é seguro decidir de um celular, e por quem pode (externo.ts)
    if (!this.externos.podeDecidirPeloCanal(v.workspace_id, v.user_id, pid)) return { ok: true, reply: RESPOSTA.noErgon };
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
  private acordar(): void { const w = [...this.esperando]; this.esperando.clear(); for (const f of w) f(); this.drenarLocal(); }

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
      // os blocos visuais vão também como imagem, onde o canal mostra (até 4 por mensagem); o texto já leva os números
      if (texto && m.role === 'agent' && !ehCanalLocal(v.canal) && !SEM_IMAGEM.has(v.canal) && m.content.includes(`\`\`\`${PREFIXO}`)) {
        for (const b of blocosDe(m.content).filter((x) => VAI_COMO_IMAGEM.has(x.tipo)).slice(0, 4)) this.enfileirar(v, 'imagem', { bloco: b, texto: b.titulo ?? '' });
      }
    }
    if (ultimo !== Number(v.cursor_rowid)) { this.d.db.run('UPDATE canais_vinculos SET cursor_rowid = ? WHERE user_id = ? AND canal = ?', ultimo, v.user_id, v.canal); v.cursor_rowid = ultimo; }
    if (!this.trabalhando(v.conversation_id)) this.digitar.delete(`${v.user_id}|${v.canal}`);
  }

  private textoDoCartao(titulo: string, summary: string): string {
    const { titulo: t, texto } = partesDoResumo(summary);
    return [titulo, textoParaTeams(t, 300), texto ? textoParaTeams(texto, LIMITE_CANAL) : ''].filter(Boolean).join('\n\n');
  }
  private cartao(v: VinculoRow, dela: { id: string; kind: string; summary: string }, titulo: string): void {
    // o comando para aprovar vai só com a frase simples (o cartão gravado antes da rc.33 levava o comando no texto)
    const p = dela.kind === 'aprovacao' ? { ...dela, summary: resumoVisivelDaAprovacao(dela.summary) } : dela;
    // a pessoa aprova exatamente o que lê: o pedido que não cabe inteiro no canal se decide no Ergon
    const cabe = cabeNoCanal(p.kind, p.summary, LIMITE_CANAL);
    const decide = !SO_NO_ERGON.includes(p.kind) && cabe && this.externos.podeDecidirPeloCanal(v.workspace_id, v.user_id, p.id);
    // Feishu e DingTalk (rc.45): sem botões, a decisão é no app (no idioma da pessoa)
    const semBotao = decide && SEM_BOTOES.has(v.canal);
    const texto = this.textoDoCartao(titulo, p.summary) + (decide && !semBotao ? '' : `\n\n${semBotao ? msg(readLang(this.d.db, v.user_id), 'canal.decidaNoApp')
      : !cabe ? ABRIR_LONGO : p.kind === 'permission' ? 'Abra o Ergon para autorizar (pede a sua senha).'
      : p.kind === 'segredo' ? 'Abra o Ergon para informar: o valor nunca passa por aqui.' : 'Abra o Ergon para responder.'}`);
    const botoes: Array<[string, string]> = decide && !semBotao ? [['Aprovar', `a:${p.id}`], ['Recusar', `r:${p.id}`]] : [];
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
    const lang = readLang(this.d.db, v.user_id);
    for (const p of props) this.cartao(v, p, msg(lang, 'canal.precisaDeVoce'));
    const esperando = this.d.db.all<{ id: string; agente: string }>(
      "SELECT r.id, a.name AS agente FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.conversation_id = ? AND r.status = 'waiting_user' AND r.created_at >= ? ORDER BY r.created_at LIMIT 5",
      v.conversation_id, v.created_at);
    for (const w of esperando) {
      if (!this.d.db.run('INSERT INTO canais_avisados (user_id, canal, item, at, sent) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING', v.user_id, v.canal, `w:${w.id}`, now()).changes) continue;
      this.enfileirar(v, 'texto', { texto: msg(lang, 'canal.esperaRespostaAqui', { quem: w.agente && w.agente !== CLOSED_VALUE ? w.agente : msg(lang, 'canal.aEquipe') }) });
    }
  }

  /** Decidido em qualquer lugar: o cartão enviado fica com a linha final, sem os botões. */
  private atualizarCartoes(ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    const rows = this.d.db.all<{ proposal_id: string; user_id: string; canal: CanalId; saida_id: string | null; status: string | null; result: string | null; decided_at: string | null }>(
      `SELECT c.proposal_id, c.user_id, c.canal, c.saida_id, p.status, p.result, p.decided_at FROM canais_cartoes c JOIN canais_vinculos v ON v.user_id = c.user_id AND v.canal = c.canal
         LEFT JOIN agent_proposals p ON p.id = c.proposal_id
        WHERE c.estado = 'open' AND v.workspace_id = ? AND (p.id IS NULL OR p.status <> 'proposed')`, ws);
    const tz = workspaceTz(this.d.db, ws);
    for (const r of rows) {
      const origem = r.saida_id ? this.d.db.get<SaidaRow>('SELECT * FROM canais_saida WHERE id = ?', r.saida_id) : null;
      const v = this.vinculo(r.user_id, r.canal);
      this.d.db.run("UPDATE canais_cartoes SET estado = 'final' WHERE proposal_id = ? AND user_id = ? AND canal = ?", r.proposal_id, r.user_id, r.canal);
      if (!origem || !v || origem.payload === CLOSED_VALUE) continue;
      const linha = linhaFinal({ status: r.status ?? 'gone', result: r.result, decidedAt: r.decided_at }, tz, readLang(this.d.db, r.user_id));
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
  private comVoce(v: VinculoRow): Array<{ chave: string; texto: string; bloco?: boolean; proposta?: { id: string; kind: string; summary: string } }> {
    const d = pendingDecisions(this.d.db, v.workspace_id);
    // o que nasceu numa conversa de canal já foi como cartão por lá
    const doCanal = new Set(this.d.db.all<{ c: string }>('SELECT conversation_id AS c FROM canais_vinculos WHERE user_id = ? AND conversation_id IS NOT NULL', v.user_id).map((r) => r.c));
    const out: Array<{ chave: string; texto: string; bloco?: boolean; proposta?: { id: string; kind: string; summary: string } }> = [];
    // os cartões dos canais externos (pausa, pedido de risco) ficam no app: um celular roubado não os vê
    for (const p of d.proposals) { if (p.kind !== KIND_EXTERNO && !(p.conversation_id && doCanal.has(p.conversation_id))) out.push({ chave: `p:${p.id}`, texto: partesDoResumo(p.summary).titulo, proposta: p }); }
    // os avisos no idioma da pessoa (rc.44); sem escolha, o português de sempre
    const lang = readLang(this.d.db, v.user_id);
    for (const w of d.waiting) { if (!(w.conversation_id && doCanal.has(w.conversation_id))) out.push({ chave: `w:${w.id}`, texto: msg(lang, 'canal.esperaResposta', { quem: w.agent_name }) }); }
    const precisa: Record<string, string> = { info: msg(lang, 'canal.card.info'), review: msg(lang, 'canal.card.review'), approval: msg(lang, 'canal.card.approval') };
    for (const c of d.cards) {
      // com a entrega no modelo: o mesmo resumo curto do cartão (o tipo e os itens) e o link dos detalhes no Ergon
      const a = avisoDoCard(this.d.db, v.workspace_id, c.id, this.d.cfg.publicUrl);
      out.push(a
        ? { chave: `c:${c.id}:${c.work_state}`, texto: [msg(lang, 'canal.card.titulo', { numero: c.number, titulo: a.titulo }), ...a.linhas, msg(lang, 'canal.verDetalhes', { link: a.link })].join('\n'), bloco: true }
        : { chave: `c:${c.id}:${c.work_state}`, texto: msg(lang, 'canal.card.linha', { numero: c.number, titulo: c.title, resto: `${c.agent_name ? `${c.agent_name}: ` : ''}${precisa[c.need] ?? msg(lang, 'canal.card.esperaVoce')}${c.question ? ` (${c.question})` : ''}` }) });
    }
    for (const l of d.linkList) out.push({ chave: `l:${l.id}`, texto: msg(lang, 'canal.ligarCards', { a: l.number, b: l.related_number }) });
    for (const r of d.ruleList) out.push({ chave: `r:${r.id}`, texto: msg(lang, 'canal.regraSugerida', { texto: r.text }) });
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
    for (const r of this.d.db.all<{ user_id: string; canal: CanalId }>('SELECT DISTINCT user_id, canal FROM canais_avisados WHERE sent = 0')) this.armarAvisos(r.user_id, r.canal, this.ajustes.avisosMs);
  }
  private armarAvisos(userId: string, canal: CanalId, ms: number): void {
    const k = `${userId}|${canal}`;
    if (this.avisosTimers.has(k)) return;
    const t = setTimeout(() => { this.avisosTimers.delete(k); try { this.enviarAvisos(userId, canal); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: aviso não saiu'); } }, ms);
    t.unref?.();
    this.avisosTimers.set(k, t);
  }
  /** O que surgiu no último minuto vai junto; no máximo 20 avisos por hora por canal. Decisões vão como cartões. */
  private enviarAvisos(userId: string, canal: CanalId): void {
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
    // o card com a entrega no modelo vai numa mensagem própria: o tipo, os itens curtos e o link dos detalhes
    const blocos = itens.filter((x) => x.bloco && !decisoes.includes(x)).slice(0, 5);
    for (const b of blocos) this.enfileirar(v, 'texto', { texto: textoParaTeams(b.texto, 1500) });
    const resto = itens.filter((x) => !decisoes.includes(x) && !blocos.includes(x));
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
    return { itens: await this.comImagens(motor, itens) };
  }
  /** O PNG de cada bloco visual da saída (gerado na hora de mandar); sem imagem, o item sai da fila (o texto já foi). */
  private async comImagens(motor: string, itens: ItemSaida[]): Promise<ItemSaida[]> {
    const out: ItemSaida[] = [];
    for (const it of itens) {
      if (it.tipo !== 'imagem') { out.push(it); continue; }
      const r = validarBloco(it.bloco);
      const png = r.ok ? await visualParaPng(r.bloco).catch(() => null) : null;
      if (!png) { this.confirmar(motor, { id: it.id, ok: true }); continue; }
      out.push({ id: it.id, canal: it.canal, tipo: 'imagem', chat_id: it.chat_id, user_id: it.user_id, texto: (it.texto ?? '').slice(0, 900), png: png.png.toString('base64') });
    }
    return out;
  }
  /** `motor` null: a entrega local (o WhatsApp pareado), aqui mesmo; o plugin nunca confirma um item local. */
  private confirmar(motor: string | null, a: { id?: string; ok?: boolean; message_id?: string; erro?: string; passageiro?: boolean }): void {
    const row = typeof a.id === 'string' ? this.d.db.get<SaidaRow>('SELECT * FROM canais_saida WHERE id = ?', a.id) : null;
    if (!row || (motor !== null ? !this.d.permite(motor, row.workspace_id) || ehCanalLocal(row.canal) : !ehCanalLocal(row.canal)) || row.status === 'sent' || row.status === 'failed') return;
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
      `SELECT * FROM canais_saida WHERE (status = 'pending' OR (status = 'em_voo' AND message_id IS NULL)) AND proximo_em <= ? AND canal NOT LIKE 'whatsapp:%' ORDER BY created_at, rowid LIMIT 200`, agoraIso);
    const parado = new Set<string>(); // o mais antigo de cada canal vai primeiro: o seguinte não passa à frente
    for (const row of rows) {
      const k = `${row.user_id}|${row.canal}`;
      if (out.length >= 20 || parado.has(k)) continue;
      if (ehCanalLocal(row.canal) || !vivos.has(row.canal) || !this.d.permite(motor, row.workspace_id) || !this.d.db.workspaceOpen(row.workspace_id)) { parado.add(k); continue; }
      const v = this.vinculo(row.user_id, row.canal);
      if (!v || row.payload === CLOSED_VALUE) { this.d.db.run("UPDATE canais_saida SET status = 'failed', erro = 'sem_vinculo' WHERE id = ?", row.id); continue; }
      const pl = JSON.parse(row.payload) as { texto?: string; botoes?: Array<[string, string]>; origem?: string; bloco?: unknown };
      const item: ItemSaida = { id: row.id, canal: row.canal as NomeCanal, tipo: row.tipo, chat_id: v.chat_id, user_id: v.externo_id, texto: String(pl.texto ?? '') };
      if (row.tipo === 'cartao') item.botoes = (pl.botoes ?? []).slice(0, 4);
      if (row.tipo === 'imagem') item.bloco = pl.bloco;
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
  /** A fila dos canais locais, entregue aqui mesmo: um por vez, na ordem; o mais antigo de cada canal vai primeiro. */
  private drenarLocal(): void {
    if (!this.entregadorLocal || !this.ligado) return;
    if (this.drenando) { this.drenarDeNovo = true; return; }
    this.drenando = true;
    void this.drenar().catch((err: unknown) => log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canais: entrega local falhou'))
      .finally(() => { this.drenando = false; if (this.drenarDeNovo) { this.drenarDeNovo = false; this.drenarLocal(); } });
  }
  private async drenar(): Promise<void> {
    const entregar = this.entregadorLocal;
    if (!entregar) return;
    const agoraIso = new Date(this.agora()).toISOString();
    const rows = this.d.db.all<SaidaRow>(
      `SELECT * FROM canais_saida WHERE (status = 'pending' OR (status = 'em_voo' AND message_id IS NULL)) AND proximo_em <= ? AND canal LIKE 'whatsapp:%' ORDER BY created_at, rowid LIMIT 50`, agoraIso);
    const parado = new Set<string>();
    for (const row of rows) {
      const k = `${row.user_id}|${row.canal}`;
      if (!this.ligado || parado.has(k)) continue;
      if (!this.d.db.workspaceOpen(row.workspace_id)) { parado.add(k); continue; }
      const v = this.vinculo(row.user_id, row.canal);
      if (!v || row.payload === CLOSED_VALUE) { this.d.db.run("UPDATE canais_saida SET status = 'failed', erro = 'sem_vinculo' WHERE id = ?", row.id); continue; }
      const pl = JSON.parse(row.payload) as { texto?: string; botoes?: Array<[string, string]>; origem?: string };
      const item: ItemLocal = { id: row.id, tipo: row.tipo === 'imagem' ? 'texto' : row.tipo, texto: String(pl.texto ?? ''), botoes: row.tipo === 'cartao' ? (pl.botoes ?? []).slice(0, 4) : [] };
      if (row.tipo === 'editar') {
        const origem = pl.origem ? this.d.db.get<{ status: string }>('SELECT status FROM canais_saida WHERE id = ?', pl.origem) : null;
        if (!origem || origem.status === 'failed') { this.d.db.run("UPDATE canais_saida SET status = 'failed', erro = 'sem_origem' WHERE id = ?", row.id); continue; }
        if (origem.status !== 'sent') { parado.add(k); continue; }
        item.origem = pl.origem;
      }
      this.d.db.run("UPDATE canais_saida SET status = 'em_voo', proximo_em = ? WHERE id = ?", new Date(this.agora() + this.ajustes.arrendamentoMs).toISOString(), row.id);
      const r: ResultadoLocal = await entregar({ userId: v.user_id, canal: v.canal as CanalLocal, workspaceId: v.workspace_id, chatId: v.chat_id }, item)
        .catch((e: unknown) => ({ ok: false, passageiro: true, erro: (e as Error).message.slice(0, 80) }));
      if (!r.ok && r.esperarMs) {
        // limite de envio: volta à fila sem contar como falha
        this.d.db.run("UPDATE canais_saida SET status = 'pending', proximo_em = ? WHERE id = ?", new Date(this.agora() + r.esperarMs).toISOString(), row.id);
        parado.add(k);
        this.armarDreno(r.esperarMs);
        continue;
      }
      this.confirmar(null, { id: row.id, ok: r.ok, message_id: r.message_id, erro: r.erro, passageiro: r.passageiro });
      if (!r.ok) { parado.add(k); this.armarDreno(2000); }
    }
  }
  private armarDreno(ms: number): void {
    if (this.drenoTimer || !this.ligado) return;
    this.drenoTimer = setTimeout(() => { this.drenoTimer = null; this.drenarLocal(); }, Math.max(50, ms));
    this.drenoTimer.unref?.();
  }

  // ------------------------------------------------------------------------------------------------ canais locais (tela)
  /** Liga um canal local à pessoa (a conversa com o coordenador nasce na primeira mensagem). */
  ligarLocal(userId: string, ws: string, canal: CanalLocal, externo: string, chat: string, nome: string): void {
    this.d.db.tx(() => {
      this.esquecer(userId, canal);
      this.d.db.run(`INSERT INTO canais_vinculos (user_id, canal, workspace_id, externo_id, chat_id, nome, avisos, cursor_rowid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        userId, canal, ws, externo.slice(0, 64), chat.slice(0, 64), this.d.db.seal(ws, nome.slice(0, 120)), Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0), now(), now());
    });
    this.linhaDeBase(this.vinculo(userId, canal)!);
    this.assinar(ws);
    this.avisarTela(userId);
  }
  desligarLocal(userId: string, canal: CanalLocal): void { this.esquecer(userId, canal); this.avisarTela(userId); }
  ligadoLocal(userId: string, canal: CanalLocal): { desde: string; avisos: boolean; conversationId: string | null } | null {
    const v = this.vinculo(userId, canal);
    return v ? { desde: v.created_at, avisos: Number(v.avisos) === 1, conversationId: v.conversation_id } : null;
  }

  /** A cada poucos segundos: o "digitando" de quem ainda espera, e a limpeza do que venceu. */
  private passo(): void {
    this.drenarLocal();
    for (const k of [...this.digitar]) {
      const [u, c] = k.split('|') as [string, NomeCanal];
      const v = this.vinculo(u, c);
      if (!v?.conversation_id || !this.d.db.workspaceOpen(v.workspace_id) || !this.trabalhando(v.conversation_id)) this.digitar.delete(k);
    }
    if (this.digitar.size) this.acordar();
    const ago = (ms: number) => new Date(this.agora() - ms).toISOString();
    this.d.db.run(`DELETE FROM canais_saida WHERE created_at < ? AND NOT (status = 'sent' AND created_at >= ? AND id IN (SELECT saida_id FROM canais_cartoes WHERE estado = 'open'))`, ago(7 * DIA), ago(30 * DIA));
    this.d.db.run('DELETE FROM canais_cartoes WHERE saida_id IS NOT NULL AND saida_id NOT IN (SELECT id FROM canais_saida)');
    this.d.db.run('DELETE FROM canais_entrada WHERE recebida_em < ?', ago(ENTRADA_VALE_MS));
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
    const comCanais = !!caps?.includes(CAPACIDADE_CANAIS) && !!c?.canais;
    let doMotor: Record<NomeCanal, CanalNoMotor> | null = null;
    if (comCanais) { try { doMotor = await c!.canais!(); } catch { doMotor = null; } }
    const out = {} as Record<NomeCanal, Record<string, unknown>>;
    for (const canal of CANAIS) {
      // o Feishu e o DingTalk pedem o plugin da rc.45 (com os pacotes deles na imagem); o WeCom e o WeChat, o da rc.46
      const precisa = capacidadeDoCanal(canal);
      const disponivel = comCanais && (!precisa || !!caps?.includes(precisa));
      const v = this.vinculo(userId, canal);
      const bot = !!this.d.db.get('SELECT 1 AS x FROM canais_bots WHERE user_id = ? AND canal = ?', userId, canal);
      const m = doMotor?.[canal];
      const configurado = m ? m.configurado : bot;
      // situação da conexão do gateway: conectado, tentando de novo ou sem conexão (sem rede, código recusado)
      const conexao = !m || !m.configurado ? null : m.estado === 'connected' ? 'conectado' : m.estado === 'fatal' ? 'sem_conexao' : 'conectando';
      out[canal] = {
        disponivel, ...(disponivel ? {} : { motivo: caps ? 'versao' : 'motor' }), bot: configurado, conexao,
        ...(m?.erro === 'telegram_token_invalid' || /unauthorized|invalid_token|login|credential|app_secret|auth/i.test(m?.erro ?? '') ? { codigoRecusado: true } : {}),
        ligado: v ? { nome: v.nome && v.nome !== CLOSED_VALUE ? v.nome : null, desde: v.created_at, avisos: Number(v.avisos) === 1 } : null,
        // o WeChat pessoal é experimental: a tela mostra o risco e pede o consentimento antes do QR
        ...(canal === 'weixin' ? { experimental: true, riscoVersao: WEIXIN_RISCO_VERSAO } : {}),
      };
    }
    return out;
  }
  /**
   * Guarda a credencial no motor (o gateway reinicia): o código do bot (Telegram, Discord) ou o App ID e o App Secret do
   * aplicativo (Feishu/Lark, DingTalk; rc.45). Bot ou aplicativo novo: a ligação de antes não vale mais.
   */
  async guardarBot(userId: string, ws: string, canal: NomeCanal, b: { token?: string; appId?: string; appSecret?: string; dominio?: 'feishu' | 'lark' }): Promise<void> {
    let cred: CredencialCanal;
    if (canal === 'weixin') throw new HttpError(400, 'qr', 'O WeChat pessoal liga pelo QR, não por um código colado.');
    const app = FORMATO_APP[canal];
    if (app) {
      const id = String(b.appId ?? '').trim(); const segredo = String(b.appSecret ?? '').trim();
      if (!app.id.test(id) || !app.segredo.test(segredo)) throw new HttpError(400, 'formato_app', 'O App ID ou o App Secret não têm o formato esperado. Copie de novo, inteiros.');
      cred = { appId: id, appSecret: segredo, ...(canal === 'feishu' ? { dominio: b.dominio === 'lark' ? 'lark' as const : 'feishu' as const } : {}) };
    } else {
      const t = String(b.token ?? '').trim();
      if (!FORMATO_TOKEN[canal]?.test(t)) throw new HttpError(400, 'formato', 'Esse não parece o código do bot. Copie de novo, inteiro.');
      cred = { token: t };
    }
    const c = this.exigirControle(ws);
    const precisa = capacidadeDoCanal(canal);
    if (precisa && !(await this.d.capacidades(ws).catch(() => null))?.includes(precisa)) {
      throw new HttpError(409, 'motor', 'A equipe precisa estar ligada (e atualizada) para isso.');
    }
    try { await c.setCanal!(canal, cred); } catch (e) { this.erroDaTela(e); }
    this.d.db.tx(() => {
      this.d.db.run('INSERT INTO canais_bots (user_id, canal, workspace_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, canal) DO UPDATE SET workspace_id = excluded.workspace_id, created_at = excluded.created_at', userId, canal, ws, now());
      this.esquecer(userId, canal);
    });
    this.avisarTela(userId);
  }
  /**
   * rc.46: o login do WeChat pessoal pelo QR. Começar pede o consentimento explícito (a Tencent pode limitar ou bloquear
   * a conta; a tela mostra o aviso) e fica na auditoria; a ponte pede o QR ao iLink e acompanha. Aqui o endereço do QR
   * vira a imagem (o navegador não fala com a Tencent) e o token da conta nunca passa: fica no cofre do motor.
   */
  async weixinQr(userId: string, ws: string, acao: 'iniciar' | 'estado' | 'cancelar', consentimento?: { aceito: boolean; versao: number }): Promise<{ estado: LoginQrMotor['estado']; qr: string | null; expiraEm: number; erro: string | null }> {
    const c = this.exigirControle(ws);
    if (!c.weixinQr || !(await this.d.capacidades(ws).catch(() => null))?.includes(CAPACIDADE_CANAIS_RC46)) {
      throw new HttpError(409, 'motor', 'A equipe precisa estar ligada (e atualizada) para isso.');
    }
    if (acao === 'iniciar') {
      if (consentimento?.aceito !== true || consentimento.versao !== WEIXIN_RISCO_VERSAO) {
        throw new HttpError(400, 'consentimento', 'Para ligar o WeChat pessoal, confirme que entendeu o risco para a conta.');
      }
      audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'canal.weixin.consentimento', targetType: 'user', targetId: userId,
        evidence: { canal: 'weixin', versao: WEIXIN_RISCO_VERSAO, risco: 'a Tencent pode limitar ou bloquear a conta' }, result: 'consentimento para ligar o WeChat pessoal (experimental)' });
    }
    let r: LoginQrMotor;
    try { r = await c.weixinQr(acao); } catch (e) { this.erroDaTela(e); }
    if (r.estado === 'confirmado') {
      this.d.db.run('INSERT INTO canais_bots (user_id, canal, workspace_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, canal) DO NOTHING', userId, 'weixin', ws, now());
    }
    let qr: string | null = null;
    // só o endereço do QR da própria Tencent (liteapp.weixin.qq.com/…) vira imagem: outro texto não chega à tela
    if (r.qr && (r.estado === 'aguardando' || r.estado === 'escaneado') && /^https:\/\/[A-Za-z0-9.-]+\.qq\.com\/[\x21-\x7e]{1,600}$/.test(r.qr)) {
      const mod: any = await import('qrcode');
      const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
      try { qr = await toDataURL(r.qr, { margin: 1, width: 280, errorCorrectionLevel: 'M' }); } catch { qr = null; }
    }
    return { estado: r.estado, qr, expiraEm: r.expiraEm, erro: r.erro };
  }
  /** Confirma o código que o bot mandou à pessoa (o pareamento do próprio gateway): a conversa fica ligada a ela. */
  async parear(userId: string, ws: string, canal: NomeCanal, codigo: string): Promise<void> {
    const cod = codigo.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(cod)) throw new HttpError(400, 'codigo', 'O código tem 8 letras e números. Confira e tente de novo.');
    const c = this.exigirControle(ws);
    let r: { userId: string; userName: string; chatId: string };
    try { r = await c.parearCanal!(canal, cod); } catch (e) { this.erroDaTela(e); }
    if (!FORMATO_ID[canal].test(r.userId)) throw new HttpError(502, 'motor', 'A equipe não confirmou a conta agora. Tente de novo.');
    const chat = FORMATO_CHAT[canal].test(r.chatId) ? r.chatId : r.userId;
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
  setAvisos(userId: string, canal: CanalId, avisos: boolean): void {
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
  private esquecer(userId: string, canal: CanalId): void {
    for (const t of ['canais_vinculos', 'canais_saida', 'canais_cartoes', 'canais_avisados']) this.d.db.run(`DELETE FROM ${t} WHERE user_id = ? AND canal = ?`, userId, canal);
    this.digitar.delete(`${userId}|${canal}`);
  }
}
