/**
 * Aprovações nativas (rc.27). As ações de risco usam o portão de aprovação do próprio Hermes: o motor para o turno e manda
 * `approval.request` no fluxo de eventos da execução (GET /v1/runs/{id}/events); o Ergon mostra o cartão e responde pela
 * API (POST /v1/runs/{id}/approval {choice, request_id}). Provado no motor de verdade (hermes/tests/test_ergon_bridge_rotinas.py).
 *
 * Dois tipos de pedido:
 * - 'motor': um comando perigoso do Terminal (ou outro que o próprio Hermes marque). Vira um cartão novo (kind 'aprovacao'),
 *   no card ou na conversa, com a mesma função de decisão da tela, do Teams, do Telegram e do Discord (decidirProposta).
 * - 'cartao': o cartão do Ergon que o plugin segurou no portão (confirmação de uma ação numa conta; abrir sites ou rodar
 *   programas depois de ler as contas). O cartão é o de sempre (conexoes/servico.ts); aqui só fica o elo com o pedido do
 *   motor, para a decisão voltar à ferramenta no mesmo turno. As regras de "mandar sem me pedir" (por pedido, 24 h, sempre)
 *   continuam decidindo antes: o que elas liberam nem chega a pedir.
 *
 * O motor segura o turno pelo prazo dele (approvals.timeout: PRAZO_DO_MOTOR_MS, migração 9 do cofre). Sem resposta nesse
 * prazo, o motor segue sem a ação e o cartão continua com a pessoa ("Com você"), esperando quanto for preciso: aprovado
 * depois, o comando fica aprovado para a mesma conversa (ou card) por PREVIA_VALE_MS e o agente recebe a continuação para
 * rodar de novo; o pedido seguinte do motor sai aprovado sem outro cartão. Nada do trabalho se perde.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { HttpError, clip, id, notFound, now } from '../lib/util.ts';
import { log } from '../lib/log.ts';
import { audit, type Bus } from './bus.ts';
import type { HermesClient, RunEvent } from './hermes.ts';
import { recordProposals } from './proposals.ts';
import { sessionKeyFor, type RunRow } from './runs.ts';

/** O prazo do motor para uma aprovação (approvals.timeout no cofre, migração 9): até lá o turno fica parado esperando. */
export const PRAZO_DO_MOTOR_MS = 300_000;
/** O comando aprovado depois do prazo vale na mesma conversa (ou card) por este tempo. */
export const PREVIA_VALE_MS = 24 * 3600_000;
export const KIND_APROVACAO = 'aprovacao';
const CARTAO_DO_ERGON = /^plugin_rule:ergon_(apr_[0-9a-f]{32})$/;
const ATIVA = (r: Pick<RunRow, 'status'> | null | undefined) => !!r && (r.status === 'running' || r.status === 'waiting_user');

interface Linha {
  run_id: string; request_id: string; workspace_id: string; proposal_id: string | null; tipo: 'motor' | 'cartao'; comando: string | null; padrao: string | null;
  estado: 'esperando' | 'respondida' | 'expirou'; espera_ms: number; created_at: string; decided_at: string | null;
}
export interface PedidoDeAprovacao { kind: 'aprovacao'; pedido: string; agente: string; comando: string; descricao: string; resumo: string }

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class Aprovacoes {
  private readonly db: Db; private readonly bus: Bus;
  /** o motor de IA do workspace (a resposta vai pela API dele) */
  hermesOf: (workspaceId: string) => HermesClient | null = () => null;
  /** a pessoa decidiu depois do prazo do motor: a resposta segue como continuação (conversa ou card), como nos cartões */
  continuar: (run: RunRow, userId: string, texto: string) => void = () => undefined;
  private agora: () => number = () => Date.now();

  constructor(db: Db, bus: Bus) { this.db = db; this.bus = bus; }
  /** só para testes: o relógio */
  setClock(fn: (() => number) | null): void { this.agora = fn ?? (() => Date.now()); }

  private run(runId: string): RunRow | undefined { return this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId); }
  private daProposta(proposalId: string): Linha | undefined {
    return this.db.get<Linha>('SELECT * FROM aprovacoes_motor WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1', proposalId);
  }

  /** O motor pediu aprovação nesta execução (approval.request). Repetido (o fluxo recomeça depois de um reinício): nada muda. */
  async pedido(dele: RunRow, e: RunEvent): Promise<void> {
    // a execução como está agora (o id dela no motor é gravado logo depois do começo)
    const run = this.run(dele.id) ?? dele;
    const requestId = clip(e.requestId || `sem-id-${hash(`${e.patternKey ?? ''}|${e.command ?? ''}`).slice(0, 16)}`, 64);
    const cartao = CARTAO_DO_ERGON.exec(e.patternKey ?? '')?.[1] ?? null;
    const comando = clip(e.command ?? '', 4000);
    const ins = this.db.run(`INSERT OR IGNORE INTO aprovacoes_motor (run_id, request_id, workspace_id, proposal_id, tipo, comando, padrao, estado, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'esperando', ?)`, run.id, requestId, run.workspace_id, cartao, cartao ? 'cartao' : 'motor',
      this.db.seal(run.workspace_id, comando || null), clip(e.patternKey ?? '', 200) || null, new Date(this.agora()).toISOString());
    if (!ins.changes) return;
    if (cartao) {
      // o cartão do Ergon que segurou o turno: decidido no instante entre abrir e pedir (uma regra, a pessoa rápida)? responde já
      const p = this.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ? AND workspace_id = ?', cartao, run.workspace_id);
      if (p && p.status !== 'proposed') await this.enviar(run, requestId, p.status !== 'rejected');
      return;
    }
    // o mesmo comando, aprovado pela pessoa depois do prazo de um pedido anterior desta conversa (ou card): sai aprovado
    const previa = this.db.get<{ id: string }>('SELECT id FROM aprovacoes_previas WHERE sessao = ? AND comando_hash = ? AND expires_at > ?',
      sessionKeyFor(run), hash(comando), new Date(this.agora()).toISOString());
    if (previa) {
      audit(this.db, this.bus, { workspaceId: run.workspace_id, actorType: 'system', actorId: 'ergon', action: 'aprovacao.motor.previa', targetType: 'run', targetId: run.id,
        evidence: { run: run.id }, result: 'comando aprovado antes pela pessoa nesta conversa: liberado sem outro cartão' });
      await this.enviar(run, requestId, true);
      return;
    }
    const agente = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', run.agent_id)?.name ?? 'O agente';
    const descricao = clip((e.description ?? '').replace(/\s+/g, ' ').trim(), 300);
    const resumo = `${agente} quer rodar um comando que pede a sua aprovação${descricao ? ` (${descricao})` : ''}:\n${clip(comando || '(sem o texto do comando)', 3000)}`;
    const payload: PedidoDeAprovacao = { kind: 'aprovacao', pedido: requestId, agente, comando, descricao, resumo };
    recordProposals(this.db, this.bus, run.workspace_id, { conversationId: run.conversation_id ?? null, runId: run.id }, [payload]);
    const pid = this.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE workspace_id = ? AND run_id = ? AND kind = 'aprovacao' ORDER BY created_at DESC, rowid DESC LIMIT 1", run.workspace_id, run.id)?.id ?? null;
    this.db.run('UPDATE aprovacoes_motor SET proposal_id = ? WHERE run_id = ? AND request_id = ?', pid, run.id, requestId);
    audit(this.db, this.bus, { workspaceId: run.workspace_id, actorType: 'agent', actorId: run.agent_id, action: 'aprovacao.motor.pedido', targetType: 'run', targetId: run.id,
      evidence: { run: run.id, padrao: e.patternKey ?? null }, result: `${agente} pediu aprovação para um comando${descricao ? ` (${descricao})` : ''}` });
    this.avisar(run);
  }

  /** O motor avisou que o pedido foi resolvido (approval.responded): por nós, ou pelo prazo dele. */
  respondido(run: RunRow, e: RunEvent): void {
    if (!e.requestId) return;
    const l = this.db.get<Linha>('SELECT * FROM aprovacoes_motor WHERE run_id = ? AND request_id = ?', run.id, e.requestId);
    if (!l || l.estado !== 'esperando') return;
    // não fomos nós (o estado seria 'respondida'): o prazo do motor acabou; o cartão continua com a pessoa
    this.fechar(l, 'expirou');
  }

  /** A execução terminou: o que ainda esperava não espera mais (o cartão, se houver, continua com a pessoa). */
  execucaoTerminou(run: RunRow): void {
    for (const l of this.db.all<Linha>("SELECT * FROM aprovacoes_motor WHERE run_id = ? AND estado = 'esperando'", run.id)) this.fechar(l, 'expirou');
  }

  private fechar(l: Linha, estado: 'respondida' | 'expirou'): void {
    const t = this.agora();
    const ms = Math.max(0, Math.min(t - Date.parse(l.created_at), PRAZO_DO_MOTOR_MS + 60_000));
    this.db.run('UPDATE aprovacoes_motor SET estado = ?, espera_ms = ?, decided_at = ? WHERE run_id = ? AND request_id = ? AND estado = ?',
      estado, ms, new Date(t).toISOString(), l.run_id, l.request_id, 'esperando');
  }

  /** Quanto tempo esta execução ficou parada esperando a pessoa no portão de aprovação (não conta no limite de tempo). */
  esperaMs(runId: string): number {
    const t = this.agora();
    let ms = 0;
    for (const l of this.db.all<Linha>('SELECT * FROM aprovacoes_motor WHERE run_id = ?', runId)) {
      ms += l.estado === 'esperando' ? Math.max(0, Math.min(t - Date.parse(l.created_at), PRAZO_DO_MOTOR_MS + 60_000)) : Number(l.espera_ms) || 0;
    }
    return ms;
  }

  /** O turno de quem pediu ainda espera este cartão no portão do motor? (dentro do prazo e com a execução em andamento) */
  aoVivo(workspaceId: string, proposalId: string): boolean {
    const l = this.daProposta(proposalId);
    if (!l || l.workspace_id !== workspaceId || l.estado !== 'esperando') return false;
    if (this.agora() - Date.parse(l.created_at) > PRAZO_DO_MOTOR_MS + 15_000) return false;
    return ATIVA(this.run(l.run_id));
  }

  /** Responde ao motor pelo cartão (aprovar = once; recusar = deny). true = o motor ainda esperava e recebeu. */
  async responder(workspaceId: string, proposalId: string, aprovar: boolean): Promise<boolean> {
    const l = this.daProposta(proposalId);
    if (!l || l.workspace_id !== workspaceId || l.estado !== 'esperando') return false;
    const run = this.run(l.run_id);
    if (!run || !ATIVA(run)) { this.fechar(l, 'expirou'); return false; }
    return this.enviar(run, l.request_id, aprovar);
  }

  private async enviar(dele: RunRow, requestId: string, aprovar: boolean): Promise<boolean> {
    const run = this.run(dele.id) ?? dele;
    const h = this.hermesOf(run.workspace_id);
    const l = this.db.get<Linha>('SELECT * FROM aprovacoes_motor WHERE run_id = ? AND request_id = ?', run.id, requestId);
    if (!h?.approve || !run.hermes_run_id || !l) { if (l) this.fechar(l, 'expirou'); return false; }
    let n = 0;
    try { n = await h.approve(run.hermes_run_id, aprovar ? 'once' : 'deny', requestId.startsWith('sem-id-') ? null : requestId, run.hermes_profile ?? null); }
    catch (err) { log.warn({ runId: run.id, erro: err instanceof Error ? clip(err.message, 160) : 'erro' }, 'aprovação: o motor não recebeu a resposta'); n = 0; }
    this.fechar(l, n > 0 ? 'respondida' : 'expirou');
    return n > 0;
  }

  /** A decisão da pessoa num cartão de comando do motor (kind 'aprovacao'): a tela, o Teams, o Telegram e o Discord. */
  async decidir(workspaceId: string, userId: string, proposalId: string, decisao: 'apply' | 'reject'): Promise<{ status: string; result: string }> {
    const p = this.db.get<{ payload: string; status: string; run_id: string | null; conversation_id: string | null }>('SELECT payload, status, run_id, conversation_id FROM agent_proposals WHERE id = ? AND workspace_id = ? AND kind = ?', proposalId, workspaceId, KIND_APROVACAO);
    if (!p) throw notFound('pedido de aprovação');
    if (p.status !== 'proposed') throw new HttpError(409, 'decided', 'este pedido já foi decidido');
    const x = JSON.parse(p.payload) as PedidoDeAprovacao;
    const ok = decisao === 'apply';
    const result = ok ? 'aprovado' : 'recusado';
    this.db.run('UPDATE agent_proposals SET status = ?, result = ?, decided_at = ? WHERE id = ? AND status = ?', ok ? 'applied' : 'rejected', this.db.seal(workspaceId, result), now(), proposalId, 'proposed');
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: ok ? 'aprovacao.motor.aprovada' : 'aprovacao.motor.recusada', targetType: 'proposal', targetId: proposalId,
      evidence: { run: p.run_id }, result: `${result}: comando de ${x.agente}` });
    this.bus.publish(workspaceId, 'proposals.changed', { conversationId: p.conversation_id });
    const run = p.run_id ? this.run(p.run_id) : undefined;
    if (run) this.avisar(run);
    // o motor ainda segura o turno: a resposta vai direto, e o agente segue no mesmo trabalho
    if (this.aoVivo(workspaceId, proposalId) && await this.responder(workspaceId, proposalId, ok)) return { status: ok ? 'applied' : 'rejected', result };
    // o prazo do motor acabou: aprovado vale para o mesmo comando nesta conversa (ou card); o agente recebe a continuação
    if (!run) return { status: ok ? 'applied' : 'rejected', result };
    if (ok) {
      this.db.run('INSERT INTO aprovacoes_previas (id, workspace_id, sessao, comando_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id('apv'), workspaceId, sessionKeyFor(run), hash(x.comando), new Date(this.agora() + PREVIA_VALE_MS).toISOString(), now());
    }
    const comando = clip(x.comando, 1500);
    this.continuar(run, userId, ok
      ? `Aprovei o comando que esperava a minha aprovação:\n${comando}\nRode-o de novo agora (ele já sai aprovado) e continue de onde parou.`
      : `Recusei o comando que esperava a minha aprovação:\n${comando}\nNão rode esse comando nem outro que faça o mesmo; termine sem ele e diga o que ficou de fora.`);
    return { status: ok ? 'applied' : 'rejected', result };
  }

  private avisar(run: RunRow): void {
    this.bus.publish(run.workspace_id, 'proposals.changed', { conversationId: run.conversation_id });
    if (run.conversation_id) this.bus.publish(run.workspace_id, 'messages.changed', { conversationId: run.conversation_id });
    if (run.task_id) this.bus.publish(run.workspace_id, 'tasks.changed', { id: run.task_id });
  }
}
