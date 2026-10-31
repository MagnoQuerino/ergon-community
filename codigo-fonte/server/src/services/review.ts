/**
 * Revisão socrática: Sócrates examina o material de uma tarefa e faz perguntas diretamente ao autor
 * (o responsável pela tarefa); o autor responde; Sócrates decide se a entrega está razoável.
 * Limitada: no máximo N rodadas (ERGON_REVIEW_MAX_ROUNDS, padrão 2) — no pior caso 2N − 1 execuções,
 * todas pela mesma fila, limite de concorrência e limite diário. Começa só quando alguém pede.
 */
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, clip, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { reviewerFor } from './team-query.ts';
import { instructionsFor, type RunExecutor, type RunRow, type RunStatus } from './runs.ts';
import { getTask } from './tasks.ts';

export interface ReviewRow {
  id: string; workspace_id: string; task_id: string; reviewer_id: string; producer_id: string;
  status: 'open' | 'approved' | 'limit' | 'stopped'; round: number; max_rounds: number; verdict: string | null; created_at: string; finished_at: string | null;
}

const CHANNEL = 'Canal: revisão socrática de uma tarefa no Ergon. Responda em português, de forma objetiva.';

/** Último "VEREDITO: pronto|ajustar" do texto (null se não houver). */
export function parseVerdict(text: string | null): 'pronto' | 'ajustar' | null {
  const all = [...(text ?? '').matchAll(/VEREDITO\s*:\s*(pronto|ajustar)/gi)];
  const last = all.at(-1);
  return last ? (last[1].toLowerCase() as 'pronto' | 'ajustar') : null;
}

export class ReviewService {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor; private readonly cfg: Config;
  constructor(db: Db, bus: Bus, executor: RunExecutor, cfg: Config) {
    this.db = db; this.bus = bus; this.executor = executor; this.cfg = cfg;
    executor.onFinish((r, status, output) => this.advance(r, status, output));
  }

  latest(workspaceId: string, taskId: string) {
    return this.db.get<ReviewRow & { reviewer_name: string; producer_name: string }>(
      `SELECT v.*, a.name AS reviewer_name, p.name AS producer_name FROM reviews v JOIN agents a ON a.id = v.reviewer_id JOIN agents p ON p.id = v.producer_id
        WHERE v.workspace_id = ? AND v.task_id = ? ORDER BY v.created_at DESC LIMIT 1`, workspaceId, taskId) ?? null;
  }

  /** O que o autor entregou: o último resultado dele nesta tarefa (fora de revisões), ou a descrição. */
  private material(workspaceId: string, taskId: string, producerId: string, description: string): string {
    const last = this.db.get<{ output: string }>(
      `SELECT output FROM runs WHERE workspace_id = ? AND task_id = ? AND agent_id = ? AND status = 'succeeded' AND review_id IS NULL AND output IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`, workspaceId, taskId, producerId);
    return (last?.output ?? description ?? '').trim();
  }

  start(workspaceId: string, taskId: string, userId: string): { reviewId: string; runId: string } {
    const task = getTask(this.db, workspaceId, taskId);
    // a mesma escolha que as telas mostram (card aberto, Ajuda), feita no banco
    const reviewer = reviewerFor(this.db, workspaceId, task.agent_id);
    if (!reviewer) throw new HttpError(409, 'no_reviewer', 'Ninguém da equipe faz revisão crítica agora: dê a ferramenta "Revisão socrática" a um agente (no perfil dele ou pedindo à coordenação).');
    if (!task.agent_id) throw new HttpError(409, 'no_producer', 'Defina o responsável pela tarefa (quem produziu o material) antes de pedir a revisão.');
    if (task.agent_id === reviewer.id) throw new HttpError(409, 'self_review', `${reviewer.name} não revisa o próprio trabalho: defina outro responsável.`);
    if (this.db.get("SELECT 1 AS x FROM reviews WHERE workspace_id = ? AND task_id = ? AND status = 'open'", workspaceId, taskId)) {
      throw new HttpError(409, 'review_open', 'Já há uma revisão em andamento nesta tarefa.');
    }
    const material = this.material(workspaceId, taskId, task.agent_id, task.description);
    if (!material) throw new HttpError(409, 'no_material', 'Não há material para revisar: peça um resultado ao responsável ou descreva a entrega na tarefa.');
    const reviewId = id('rev');
    return this.db.tx(() => {
      this.db.run(
        `INSERT INTO reviews (id, workspace_id, task_id, reviewer_id, producer_id, status, round, max_rounds, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)`, reviewId, workspaceId, taskId, reviewer.id, task.agent_id, this.cfg.reviewMaxRounds, userId, now());
      const producer = this.db.get<{ name: string; role: string }>('SELECT name, role FROM agents WHERE id = ?', task.agent_id)!;
      const run = this.executor.enqueue({
        workspaceId, agentId: reviewer.id, taskId, kind: 'subtask', reviewId, reviewStep: 'questions',
        input: clip(`Revisão da tarefa #${task.number}: ${task.title}\nAutor: ${producer.name} (${producer.role})\n\nMaterial a revisar:\n${clip(material, 2400)}\n\n` +
          `Rodada 1 de ${this.cfg.reviewMaxRounds}. Faça suas perguntas ao autor e termine com a linha do VEREDITO.`, this.cfg.maxInputChars),
        instructions: instructionsFor(this.db, workspaceId, reviewer.id, CHANNEL),
        idempotencyKey: `review-${reviewId}-q1`,
      });
      audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'review.start', targetType: 'task', targetId: taskId, evidence: { reviewId, producer: producer.name, maxRounds: this.cfg.reviewMaxRounds }, result: 'revisão iniciada' });
      return { reviewId, runId: run.id };
    });
  }

  private nameOf(agentId: string): string { return this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? 'A revisão'; }

  private close(v: ReviewRow, status: ReviewRow['status'], verdict: string | null, result: string, action: string, evidence: Record<string, unknown> = {}): void {
    this.db.run('UPDATE reviews SET status = ?, verdict = ?, finished_at = ? WHERE id = ?', status, verdict, now(), v.id);
    audit(this.db, this.bus, { workspaceId: v.workspace_id, actorType: 'agent', actorId: v.reviewer_id, action, targetType: 'task', targetId: v.task_id, evidence: { reviewId: v.id, round: v.round, ...evidence }, result });
    this.bus.publish(v.workspace_id, 'tasks.changed', { id: v.task_id });
  }

  /** Passo seguinte da revisão quando uma execução dela termina. */
  advance(r: RunRow, status: RunStatus, output: string | null): void {
    if (!r.review_id) return;
    const v = this.db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', r.review_id);
    if (!v || v.status !== 'open') return;
    try { this.step(v, r, status, output); } catch (err) {
      this.close(v, 'stopped', null, `revisão interrompida: ${err instanceof Error ? err.message : String(err)}`, 'review.stopped');
    }
  }

  private step(v: ReviewRow, r: RunRow, status: RunStatus, output: string | null): void {
    if (status !== 'succeeded') return this.close(v, 'stopped', null, `revisão interrompida (${status})`, 'review.stopped');
    const task = getTask(this.db, v.workspace_id, v.task_id);
    if (r.review_step === 'questions') {
      const verdict = parseVerdict(output);
      if (verdict === 'pronto') return this.close(v, 'approved', 'pronto', `${this.nameOf(v.reviewer_id)} considera a entrega razoável`, 'review.approved');
      if (v.round >= v.max_rounds) {
        return this.close(v, 'limit', verdict, `limite de ${v.max_rounds} rodada(s): ainda há pontos a ajustar — a decisão é sua`, 'review.limit');
      }
      const producer = this.db.get<{ status: string }>('SELECT status FROM agents WHERE id = ?', v.producer_id);
      if (producer?.status !== 'active') return this.close(v, 'stopped', verdict, 'o autor foi arquivado', 'review.stopped');
      this.executor.enqueue({
        workspaceId: v.workspace_id, agentId: v.producer_id, taskId: v.task_id, kind: 'subtask', reviewId: v.id, reviewStep: 'answers',
        input: clip(`${this.nameOf(v.reviewer_id)} revisou o seu material da tarefa #${task.number} (${task.title}), rodada ${v.round} de ${v.max_rounds}, e perguntou:\n\n${clip(output ?? '', 2000)}\n\n` +
          'Responda a cada pergunta de forma objetiva e, quando for preciso, apresente a correção do material.', this.cfg.maxInputChars),
        instructions: instructionsFor(this.db, v.workspace_id, v.producer_id, CHANNEL),
        idempotencyKey: `review-${v.id}-a${v.round}`,
      });
      return;
    }
    if (r.review_step === 'answers') {
      const round = v.round + 1;
      this.db.run('UPDATE reviews SET round = ? WHERE id = ?', round, v.id);
      const questions = this.db.get<{ output: string }>(
        "SELECT output FROM runs WHERE review_id = ? AND review_step = 'questions' AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1", v.id);
      const material = this.material(v.workspace_id, v.task_id, v.producer_id, task.description);
      this.executor.enqueue({
        workspaceId: v.workspace_id, agentId: v.reviewer_id, taskId: v.task_id, kind: 'subtask', reviewId: v.id, reviewStep: 'questions',
        input: clip(`Revisão da tarefa #${task.number}: ${task.title} — rodada ${round} de ${v.max_rounds}.\n\nMaterial original (resumo):\n${clip(material, 1200)}\n\n` +
          `Suas perguntas anteriores:\n${clip(questions?.output ?? '', 1000)}\n\nRespostas do autor:\n${clip(output ?? '', 1400)}\n\n` +
          'Se as respostas resolvem o essencial, termine com VEREDITO: pronto. Se não, faça novas perguntas (no máximo cinco) e termine com VEREDITO: ajustar.', this.cfg.maxInputChars),
        instructions: instructionsFor(this.db, v.workspace_id, v.reviewer_id, CHANNEL),
        idempotencyKey: `review-${v.id}-q${round}`,
      });
    }
  }
}
