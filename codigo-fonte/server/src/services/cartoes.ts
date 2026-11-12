/**
 * Cartões pedidos pelo agente por uma ferramenta do motor (conjunto ergon_cartoes do plugin): perguntar de volta, pedido
 * seguro de chave e senha de administrador. É o que o motor só oferecia no terminal, no aplicativo dele e nos canais.
 *
 * O cartão que a pessoa vê é uma proposta: a pergunta reaproveita o kind 'question' (uma por pergunta), a chave e a senha
 * usam o kind 'segredo'. A ferramenta do motor abre o cartão (POST /internal/bridge/v1/cartao) e consulta o estado até a
 * resposta chegar: assim a resposta volta ao agente NO MESMO trabalho. Se o prazo da ferramenta acabar antes, o cartão
 * continua com a pessoa e a resposta segue como continuação imediata (mensagem na conversa, ou resposta no card).
 *
 * Chave ou senha: o valor que a pessoa digita vai desta chamada direto para a ponte de controle do motor, que grava no
 * cofre dele. Não é gravado no banco, não entra na conversa, no histórico, na auditoria nem nos registros, e o agente
 * recebe só "guardada como NOME". A senha de administrador "só para este trabalho" fica na memória deste processo até a
 * ferramenta buscar (uma vez só, no máximo 15 minutos) e vai para o cache do sudo do motor, no escopo daquela execução.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import type { HermesControlClient } from './hermes.ts';
import { recordProposals } from './proposals.ts';
import { sessionKeyFor, type RunDaSessao, type RunRow } from './runs.ts';

export type TipoCartao = 'pergunta' | 'chave' | 'sudo';
export interface PerguntaDoMotor { qid: string; pergunta: string; opcoes: string[]; varias: boolean }
export interface PedidoCartao { pedido: string; tipo: TipoCartao; perguntas?: PerguntaDoMotor[]; nome?: string; motivo?: string }
/** O que a ferramenta do motor recebe. valor: só a senha de administrador de um trabalho (uma vez; nunca gravada). */
export interface EstadoCartao { estado: 'esperando' | 'respondida' | 'recusada' | 'cancelada' | 'falhou'; respostas?: Record<string, string | string[]>; valor?: string; guardada?: boolean; texto?: string }
export interface SegredoPayload { kind: 'segredo'; tipo: 'chave' | 'sudo'; nome: string; motivo: string; agente: string; pedido: string }

const NOME_CHAVE = /^[A-Z][A-Z0-9_]{2,60}$/;
const SUDO = 'SUDO_PASSWORD';
/** a ferramenta consulta a cada 2 s: sem consulta há mais que isto, ela não está mais esperando */
export const SEM_CONSULTA_MS = 20_000;
/** a senha de um trabalho só espera a ferramenta buscar por, no máximo, este tempo (na memória) */
export const SENHA_ESPERA_MS = 15 * 60_000;
const ATIVA = (r: RunRow | null | undefined): r is RunRow => !!r && (r.status === 'running' || r.status === 'waiting_user');

interface Linha { pedido: string; workspace_id: string; run_id: string; tipo: TipoCartao; estado: 'esperando' | 'desistiu' | 'entregue' | 'continuada'; espera_ms: number; consultado_em: string; created_at: string }
interface Prop { id: string; kind: string; payload: string; status: string; result: string | null }

export class Cartoes {
  private readonly db: Db;
  private readonly bus: Bus;
  /** a ponte de controle do motor do workspace (null = motor sem suporte ou desligado) */
  control: (workspaceId: string) => HermesControlClient | null = () => null;
  /** a resposta chegou depois de a ferramenta parar de esperar: segue como continuação (conversa ou card) */
  continuar: (run: RunRow, userId: string, texto: string) => void = () => undefined;
  /** senhas de administrador de um trabalho só, esperando a ferramenta buscar: só na memória, por sessão do agente */
  private readonly senhas = new Map<string, { valor: string; em: number; pedido: string }>();
  /** as últimas esperas humanas que os ganchos do motor avisaram (sem conteúdo): diagnóstico */
  readonly esperas: Array<{ fase: string; kind: string; outcome: string; em: string }> = [];
  private agora: () => number = () => Date.now();

  constructor(db: Db, bus: Bus) { this.db = db; this.bus = bus; }
  /** só para testes: o relógio */
  setClock(fn: (() => number) | null): void { this.agora = fn ?? (() => Date.now()); }

  private linha(pedido: string): Linha | undefined { return this.db.get<Linha>('SELECT * FROM cartoes_motor WHERE pedido = ?', pedido); }
  private props(l: Pick<Linha, 'workspace_id' | 'run_id' | 'pedido'>): Prop[] {
    return this.db.all<Prop>("SELECT id, kind, payload, status, result FROM agent_proposals WHERE workspace_id = ? AND run_id = ? AND kind IN ('question', 'segredo') ORDER BY created_at, rowid", l.workspace_id, l.run_id)
      .filter((p) => { try { return (JSON.parse(p.payload) as { pedido?: string }).pedido === l.pedido; } catch { return false; } });
  }
  private agente(run: RunRow): string { return this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', run.agent_id)?.name ?? 'O agente'; }

  /** A ferramenta do motor abre o cartão. `run`: a execução em andamento da sessão que chamou (já conferida pela ponte). */
  abrir(run: RunDaSessao | null, p: PedidoCartao): EstadoCartao {
    if (!ATIVA(run)) return { estado: 'falhou', texto: 'Esta ferramenta só funciona dentro de um trabalho em andamento no Ergon.' };
    if (!run.conversation_id && !run.task_id) return { estado: 'falhou', texto: 'Daqui não há onde mostrar um cartão à pessoa. Siga com o que tem e diga o que ficou faltando.' };
    const ja = this.linha(p.pedido);
    if (ja) return ja.run_id === run.id ? this.estado(run, p.pedido, false) : { estado: 'falhou', texto: 'pedido repetido' };
    const agente = this.agente(run);
    if (p.tipo === 'sudo') {
      // a senha de administrador só serve aos comandos do Terminal: sem ele liberado para este agente, nem pede
      const tools = ((): string[] => { try { return JSON.parse(this.db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', run.agent_id)?.tools ?? '[]') as string[]; } catch { return []; } })();
      if (!tools.includes('terminal')) return { estado: 'falhou', texto: 'O Terminal não está liberado para você no Ergon, então a senha de administrador não serviria: não a peça. Siga sem sudo ou diga à pessoa o que ficou faltando.' };
      // a pessoa já respondeu a um cartão anterior deste mesmo trabalho e a ferramenta tinha parado de esperar: entrega agora
      const guardada = this.pegarSenha(run);
      if (guardada) return { estado: 'respondida', valor: guardada };
    }
    const propostas = p.tipo === 'pergunta'
      ? (p.perguntas ?? []).slice(0, 5).filter((q) => q.pergunta.trim()).map((q) => ({ kind: 'question' as const, question: clip(q.pergunta.trim(), 2000),
        options: q.opcoes.map((o) => clip(o.trim(), 300)).filter(Boolean).slice(0, 4), pedido: p.pedido, qid: clip(q.qid, 20), multi: q.varias && q.opcoes.length > 0 }))
      : [{ kind: 'segredo' as const, tipo: p.tipo, nome: p.tipo === 'sudo' ? SUDO : String(p.nome ?? ''), motivo: clip(String(p.motivo ?? '').trim(), 300), agente, pedido: p.pedido }];
    if (!propostas.length) return { estado: 'falhou', texto: 'Faltou a pergunta.' };
    if (p.tipo === 'chave' && !NOME_CHAVE.test(String(p.nome ?? ''))) return { estado: 'falhou', texto: 'Nome de chave inválido: use maiúsculas, números e _ (por exemplo GITHUB_TOKEN).' };
    if (p.tipo !== 'pergunta' && !this.control(run.workspace_id)?.guardarChave) {
      return { estado: 'falhou', texto: 'O cofre da equipe não está disponível agora para guardar com segurança. Não peça a chave nem a senha no texto da conversa: diga à pessoa que isso fica para depois.' };
    }
    this.db.tx(() => {
      this.db.run("INSERT INTO cartoes_motor (pedido, workspace_id, run_id, tipo, estado, consultado_em, created_at) VALUES (?, ?, ?, ?, 'esperando', ?, ?)",
        p.pedido, run.workspace_id, run.id, p.tipo, new Date(this.agora()).toISOString(), now());
      recordProposals(this.db, this.bus, run.workspace_id, { conversationId: run.conversation_id ?? null, runId: run.id }, propostas);
    });
    // o histórico diz que houve o pedido e de quê (o nome da chave e o motivo que o agente escreveu); nunca um valor
    audit(this.db, this.bus, { workspaceId: run.workspace_id, actorType: 'agent', actorId: run.agent_id, action: `cartao.${p.tipo}.pedido`, targetType: 'run', targetId: run.id,
      evidence: { run: run.id, tipo: p.tipo, ...(p.tipo === 'chave' ? { nome: p.nome } : {}) },
      result: p.tipo === 'pergunta' ? `${agente} fez ${propostas.length === 1 ? 'uma pergunta' : `${propostas.length} perguntas`}`
        : p.tipo === 'chave' ? `${agente} pediu a chave ${p.nome}` : `${agente} pediu a senha de administrador` });
    if (run.task_id) this.bus.publish(run.workspace_id, 'tasks.changed', { id: run.task_id });
    return { estado: 'esperando' };
  }

  /**
   * A ferramenta consulta o estado. desistir: o prazo dela acabou; se a resposta chegou neste instante, ainda a leva; senão,
   * o cartão fica com a pessoa e a resposta seguirá como continuação.
   */
  estado(run: RunDaSessao | null, pedido: string, desistir: boolean): EstadoCartao {
    const l = this.linha(pedido);
    if (!l || !run || l.run_id !== run.id) return { estado: 'falhou', texto: 'cartão desconhecido' };
    const t = this.agora();
    if (l.estado === 'esperando') {
      // o tempo esperando a pessoa não conta no limite da execução (um intervalo longo sem consulta não entra na conta)
      const passo = Math.max(0, Math.min(t - Date.parse(l.consultado_em), SEM_CONSULTA_MS));
      this.db.run('UPDATE cartoes_motor SET espera_ms = espera_ms + ?, consultado_em = ? WHERE pedido = ?', passo, new Date(t).toISOString(), pedido);
    }
    const props = this.props(l);
    if (props.some((p) => p.status === 'rejected' || p.status === 'failed')) { this.marcar(pedido, 'entregue'); return { estado: 'recusada' }; }
    if (props.length && props.every((p) => p.status === 'applied')) {
      if (l.estado === 'continuada') return { estado: 'cancelada' };
      this.marcar(pedido, 'entregue');
      if (l.tipo === 'pergunta') {
        const respostas: Record<string, string | string[]> = {};
        for (const p of props) {
          const q = JSON.parse(p.payload) as { qid?: string; multi?: boolean };
          const r = p.result ?? '';
          respostas[q.qid ?? 'q0'] = q.multi ? r.split('\n').map((x) => x.trim()).filter(Boolean) : r;
        }
        return { estado: 'respondida', respostas };
      }
      if (l.tipo === 'sudo') {
        const valor = this.pegarSenha(run);
        return valor ? { estado: 'respondida', valor } : { estado: 'respondida', guardada: true };
      }
      return { estado: 'respondida' };
    }
    if (!ATIVA(run)) { this.marcar(pedido, 'desistiu'); return { estado: 'cancelada' }; }
    if (desistir) this.marcar(pedido, 'desistiu');
    return { estado: 'esperando' };
  }
  private marcar(pedido: string, estado: Linha['estado']): void { this.db.run('UPDATE cartoes_motor SET estado = ? WHERE pedido = ?', estado, pedido); }

  /** Quanto tempo esta execução ficou parada esperando a pessoa responder a um cartão (não conta no limite de tempo). */
  esperaMs(runId: string): number {
    return Number(this.db.get<{ ms: number | null }>('SELECT SUM(espera_ms) AS ms FROM cartoes_motor WHERE run_id = ?', runId)?.ms ?? 0);
  }

  private chaveSenha(run: Pick<RunRow, 'workspace_id' | 'agent_id' | 'conversation_id' | 'task_id' | 'id'>): string { return sessionKeyFor(run); }
  private pegarSenha(run: RunRow): string | null {
    const k = this.chaveSenha(run);
    const s = this.senhas.get(k);
    if (!s) return null;
    this.senhas.delete(k);
    return this.agora() - s.em <= SENHA_ESPERA_MS ? s.valor : null;
  }
  private limparSenhas(): void {
    for (const [k, s] of this.senhas) if (this.agora() - s.em > SENHA_ESPERA_MS) this.senhas.delete(k);
  }

  /** A ferramenta ainda espera este cartão? (consultou há pouco e a execução segue em andamento) */
  private esperando(l: Linha): boolean {
    if (l.estado !== 'esperando' || this.agora() - Date.parse(l.consultado_em) > SEM_CONSULTA_MS) return false;
    return ATIVA(this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', l.run_id));
  }

  /** É um cartão aberto pelo motor? (a rota de resposta de perguntas decide por aqui) */
  doMotor(workspaceId: string, proposalId: string): boolean {
    const p = this.db.get<{ payload: string; kind: string }>("SELECT payload, kind FROM agent_proposals WHERE id = ? AND workspace_id = ? AND kind IN ('question', 'segredo')", proposalId, workspaceId);
    try { return !!p && typeof (JSON.parse(p.payload) as { pedido?: string }).pedido === 'string'; } catch { return false; }
  }

  private carregar(workspaceId: string, proposalId: string, kind: 'question' | 'segredo'): { p: Prop; l: Linha; run: RunRow } {
    const p = this.db.get<Prop & { run_id: string | null }>('SELECT id, kind, payload, status, result, run_id FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
    if (!p || p.kind !== kind) throw notFound('cartão');
    if (p.status !== 'proposed') throw new HttpError(409, 'decided', kind === 'question' ? 'esta pergunta já foi respondida' : 'este cartão já foi respondido');
    const pedido = (JSON.parse(p.payload) as { pedido?: string }).pedido;
    const l = pedido ? this.linha(pedido) : undefined;
    const run = l ? this.db.get<RunRow>('SELECT * FROM runs WHERE id = ? AND workspace_id = ?', l.run_id, workspaceId) : undefined;
    if (!l || !run) throw notFound('cartão');
    return { p, l, run };
  }

  /** Depois de uma resposta: a ferramenta ainda espera (leva na próxima consulta) ou a resposta segue como continuação. */
  private seguir(l: Linha, run: RunRow, userId: string, texto: () => string): { entregue: 'agora' | 'continuacao' | 'falta' } {
    const props = this.props(l);
    if (props.some((x) => x.status === 'proposed')) return { entregue: 'falta' }; // faltam perguntas da mesma rodada
    if (this.esperando(this.linha(l.pedido)!)) return { entregue: 'agora' };
    this.marcar(l.pedido, 'continuada');
    this.continuar(run, userId, texto());
    return { entregue: 'continuacao' };
  }

  /** A pessoa respondeu a uma pergunta do agente (uma opção, várias, ou texto livre). */
  responderPergunta(workspaceId: string, userId: string, proposalId: string, resposta: string | string[]): { entregue: 'agora' | 'continuacao' | 'falta' } {
    const { p, l, run } = this.carregar(workspaceId, proposalId, 'question');
    const lista = (Array.isArray(resposta) ? resposta : [resposta]).map((x) => clip(String(x).trim(), 300)).filter(Boolean).slice(0, 6);
    if (!lista.length) throw new HttpError(400, 'empty', 'resposta vazia');
    this.db.run("UPDATE agent_proposals SET status = 'applied', result = ?, decided_at = ? WHERE id = ?", this.db.seal(workspaceId, lista.join('\n')), now(), p.id);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'question.answer', targetType: 'proposal', targetId: p.id, result: 'respondida' });
    this.avisar(run);
    return this.seguir(l, run, userId, () => {
      const linhas = this.props(l).map((x) => `- ${(JSON.parse(x.payload) as { question: string }).question} → ${(x.result ?? '').split('\n').join('; ')}`);
      return linhas.length > 1 ? `Minhas respostas:\n${linhas.join('\n')}` : `Minha resposta: ${linhas[0]?.replace(/^- /, '') ?? lista.join('; ')}`;
    });
  }

  /**
   * A pessoa digitou a chave ou a senha no cartão protegido. O valor só passa por aqui: vai à ponte de controle do motor
   * (chave, ou senha "guardar") ou fica na memória até a ferramenta buscar (senha de um trabalho só). Nenhum erro repete o valor.
   */
  async responderSegredo(workspaceId: string, userId: string, proposalId: string, valor: string, guardar: boolean): Promise<{ entregue: 'agora' | 'continuacao' | 'falta'; nome: string }> {
    const { p, l, run } = this.carregar(workspaceId, proposalId, 'segredo');
    const s = JSON.parse(p.payload) as SegredoPayload;
    if (!valor || valor.length > 4000 || /[\u0000-\u001f\u007f]/.test(valor)) throw new HttpError(400, 'valor', 'Valor vazio, longo demais ou com quebra de linha: cole só a chave.');
    const sudo = s.tipo === 'sudo';
    // o cofre do motor só guarda texto sem acentos (o gravador dele os tiraria e escreveria no registro quais eram): recusa
    // antes, com o motivo; a senha "só para este trabalho" não vai ao cofre e pode ter acentos
    if ((!sudo || guardar) && /[^ -~]/.test(valor)) {
      throw new HttpError(400, 'acentos', sudo ? 'Uma senha com acentos ou caracteres especiais não pode ser guardada no cofre da equipe: desmarque "Guardar para a equipe usar de novo" e entregue só para este trabalho.'
        : 'O valor tem acentos ou caracteres especiais, e o cofre da equipe não guarda esse tipo de valor. Confira e cole de novo.');
    }
    const control = this.control(workspaceId);
    let resultado: string;
    if (sudo && !guardar) {
      this.limparSenhas();
      this.senhas.set(this.chaveSenha(run), { valor, em: this.agora(), pedido: l.pedido });
      resultado = 'entregue só para este trabalho';
    } else {
      if (!control?.guardarChave) throw new HttpError(503, 'cofre', 'O cofre da equipe não está disponível agora. Tente de novo em instantes.');
      try {
        await control.guardarChave(sudo ? { nome: SUDO, valor, sudo: true } : { nome: s.nome, valor, motivo: s.motivo, agente: s.agente });
      } catch (e) {
        // só o motivo curto da ponte (ela nunca repete o valor); nada do pedido vai para o registro
        const status = (e as { status?: number }).status;
        throw new HttpError(status === 400 ? 400 : 503, 'cofre', status === 400 ? 'O cofre da equipe não aceitou esse valor. Confira e tente de novo.' : 'O cofre da equipe não respondeu agora. Tente de novo em instantes.');
      }
      resultado = sudo ? 'guardada para a equipe' : `guardada como ${s.nome}`;
    }
    this.db.run("UPDATE agent_proposals SET status = 'applied', result = ?, decided_at = ? WHERE id = ? AND status = 'proposed'", this.db.seal(workspaceId, resultado), now(), p.id);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: sudo ? 'cartao.sudo.resposta' : 'cartao.chave.resposta', targetType: 'proposal', targetId: p.id,
      evidence: sudo ? { guardada: guardar } : { nome: s.nome }, result: sudo ? `senha de administrador ${resultado}` : `chave ${resultado}` });
    this.avisar(run);
    const r = this.seguir(l, run, userId, () => (sudo
      ? (guardar ? 'Guardei a senha de administrador no cofre da equipe. Continue de onde parou: use sudo normalmente no Terminal.'
        : 'Informei a senha de administrador para este trabalho. Chame pedir_senha_admin de novo para recebê-la no Terminal e continue de onde parou.')
      : `Guardei a chave ${s.nome} no cofre da equipe: ela já está na variável de ambiente ${s.nome}. Continue de onde parou.`));
    return { ...r, nome: s.nome };
  }

  /** A pessoa preferiu não responder (recusar o cartão protegido ou dispensar a pergunta). */
  recusar(workspaceId: string, userId: string, proposalId: string): void {
    const p = this.db.get<Prop>('SELECT id, kind, payload, status, result FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
    if (!p || (p.kind !== 'question' && p.kind !== 'segredo')) throw notFound('cartão');
    if (p.status !== 'proposed') throw new HttpError(409, 'decided', 'este cartão já foi respondido');
    const { l, run } = this.carregar(workspaceId, proposalId, p.kind);
    // as outras perguntas da mesma rodada saem junto: a ferramenta recebe uma recusa só
    for (const x of this.props(l)) {
      if (x.status === 'proposed') this.db.run("UPDATE agent_proposals SET status = 'rejected', result = ?, decided_at = ? WHERE id = ?", this.db.seal(workspaceId, 'você preferiu não responder'), now(), x.id);
    }
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: `cartao.${l.tipo}.recusa`, targetType: 'proposal', targetId: p.id, result: 'você preferiu não responder' });
    this.avisar(run);
    if (!this.esperando(l) && l.estado !== 'entregue' && l.estado !== 'continuada') {
      this.marcar(l.pedido, 'continuada');
      this.continuar(run, userId, l.tipo === 'pergunta' ? 'Prefiro não responder a essa pergunta agora. Siga com o que você tem, ou diga o que ficou faltando.'
        : l.tipo === 'chave' ? 'Prefiro não informar essa chave. Siga sem ela, ou diga o que ficou faltando.' : 'Prefiro não informar a senha de administrador. Siga sem ela, ou diga o que ficou faltando.');
    }
  }

  private avisar(run: RunRow): void {
    this.bus.publish(run.workspace_id, 'proposals.changed', { conversationId: run.conversation_id });
    if (run.conversation_id) this.bus.publish(run.workspace_id, 'messages.changed', { conversationId: run.conversation_id });
    if (run.task_id) this.bus.publish(run.workspace_id, 'tasks.changed', { id: run.task_id });
  }

  /**
   * A execução terminou. Cartão respondido que a ferramenta não chegou a levar (ela caiu no meio): a resposta segue como
   * continuação. Cartão ainda sem resposta: fica com a pessoa, e a resposta, quando vier, segue como continuação.
   */
  execucaoTerminou(run: RunRow, quem: (run: RunRow) => string | null): void {
    for (const l of this.db.all<Linha>("SELECT * FROM cartoes_motor WHERE run_id = ? AND estado = 'esperando'", run.id)) {
      const props = this.props(l);
      const respondido = props.length > 0 && props.every((p) => p.status === 'applied');
      if (!respondido) { this.marcar(l.pedido, 'desistiu'); continue; }
      const userId = quem(run);
      if (!userId) { this.marcar(l.pedido, 'desistiu'); continue; }
      this.marcar(l.pedido, 'continuada');
      const linhas = l.tipo === 'pergunta' ? props.map((x) => `- ${(JSON.parse(x.payload) as { question: string }).question} → ${(x.result ?? '').split('\n').join('; ')}`) : [];
      this.continuar(run, userId, l.tipo === 'pergunta' ? `Minhas respostas:\n${linhas.join('\n')}`
        : l.tipo === 'chave' ? 'Guardei a chave que você pediu no cofre da equipe. Continue de onde parou.' : 'Respondi ao pedido da senha de administrador. Chame pedir_senha_admin de novo e continue de onde parou.');
    }
  }

  /** Os ganchos de espera humana do motor avisam toda vez que ele para esperando uma pessoa (sem o que ela digitou). */
  espera(e: { fase?: string; kind?: string; outcome?: string }): void {
    this.esperas.push({ fase: clip(String(e.fase ?? ''), 20), kind: clip(String(e.kind ?? ''), 40), outcome: clip(String(e.outcome ?? ''), 40), em: now() });
    if (this.esperas.length > 50) this.esperas.splice(0, this.esperas.length - 50);
  }

  // ---- Configurações › Segurança › Chaves guardadas para a equipe
  async chaves(workspaceId: string): Promise<{ disponivel: boolean; chaves: Array<{ nome: string; motivo: string; quando: string; agente: string }>; sudo: boolean }> {
    const c = this.control(workspaceId);
    if (!c?.chavesGuardadas) return { disponivel: false, chaves: [], sudo: false };
    try { return { disponivel: true, ...(await c.chavesGuardadas()) }; } catch { return { disponivel: false, chaves: [], sudo: false }; }
  }
  async apagarChave(workspaceId: string, userId: string, nome: string): Promise<{ apagada: boolean }> {
    if (nome !== SUDO && !NOME_CHAVE.test(nome)) throw new HttpError(400, 'nome', 'nome de chave inválido');
    const c = this.control(workspaceId);
    if (!c?.apagarChave) throw new HttpError(503, 'cofre', 'O cofre da equipe não está disponível agora. Tente de novo em instantes.');
    const apagada = await c.apagarChave(nome);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'cartao.chave.apagada', evidence: { nome },
      result: nome === SUDO ? 'senha de administrador apagada do cofre da equipe' : `chave ${nome} apagada do cofre da equipe` });
    return { apagada };
  }
}
