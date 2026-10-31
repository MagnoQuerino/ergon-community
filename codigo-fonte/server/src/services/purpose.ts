/**
 * O fio do pedido: o que o usuário pediu numa conversa não se perde até a entrega.
 *
 * Todo card que nasce de uma conversa — o plano do coordenador ou o pedido de ajuda de um agente — guarda a conversa,
 * o pedido do usuário (cifrado) e quem entrega: o agente com quem o usuário falou. Quando os cards de uma mesma
 * resposta terminam, esse agente continua sozinho na conversa e entrega o que foi pedido, no formato pedido. Antes,
 * a resposta da Hipátia chegava à conversa como nota do sistema e o Aristóteles nunca entregava o resumo.
 *
 * Se o card para esperando o usuário (uma informação, uma aprovação, uma decisão), o agente da conversa repassa o
 * pedido ali, como mensagem dele, com um cartão para responder; a resposta volta ao card e o trabalho segue.
 *
 * Nada aqui chama modelo diretamente: só enfileira execuções no executor.
 */
import type { Db } from '../db/db.ts';
import { clip, fold, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { attrs } from './routine-proposals.ts';
import { instructionsFor, type RunExecutor, type RunRow } from './runs.ts';
import type { ResultRow } from './results.ts';
import { activeTeam, coordinatorOf, findMember, routeTo } from './team.ts';

export interface PlanStep { agent: string; task: string }
/**
 * Plano de uma entrega (um card). review: 'nao' (ação objetiva: entregar conclui), 'leve' (padrão: você aprova a
 * entrega), 'forte' (você pediu revisão: a equipe revisa a fundo antes e você aprova). order: a ordem recomendada no
 * lote; after: os planos (pela ordem) que precisam terminar antes deste começar; due: prazo pedido.
 */
export interface Plan { objective: string; steps: PlanStep[]; review?: 'nao' | 'leve' | 'forte'; order?: number; after?: number[]; due?: string | null }
/** acima disto, o lote espera a sua confirmação ("Abrir todos") */
export const BATCH_CONFIRM = 8;
/** teto de cards numa resposta */
export const BATCH_MAX = 30;
export const MAX_STEPS = 8;
/** prefixo das execuções de entrega (a conversa continua; não entra no limite de processos) */
export const DELIVERY_KEY = 'entrega-';
/** a entrega de cada rodada (a 1ª sem sufixo; ajustes pedidos por você: #r2, #r3…) */
export const deliveryKey = (origin: string, round: number) => `${DELIVERY_KEY}${origin}${round > 1 ? `#r${round}` : ''}`;
/** a mesma chave, em SQL, para o card `t` */
export const DELIVERY_KEY_SQL = (t = 't') => `'${DELIVERY_KEY}' || ${t}.origin_run_id || CASE WHEN ${t}.review_round > 1 THEN '#r' || ${t}.review_round ELSE '' END`;
/** card pronto para entregar: concluído, ou entregue a você e esperando a sua aprovação */
export const READY_SQL = (t = 't') => `(${t}.completed = 1 OR (${t}.work_state = 'aguardando_aprovacao' AND ${t}.delivered_at IS NOT NULL))`;

/** Texto sem as linhas de controle ([[...]]). */
const plain = (s: string | null | undefined): string => (s ?? '').replace(/\[\[(?:[^\]]|\](?!\]))*\]\]\s*/g, '').trim();

/**
 * O plano do coordenador: [[plano objetivo="…"]] e uma linha [[etapa agente="…" faz="…"]] por etapa, em ordem
 * (até 8). Sem objetivo ou sem etapa válida, não há plano.
 */
export function parsePlan(text: string | null): Plan | null {
  return parsePlans(text)[0] ?? null;
}

const reviewOf = (v: string | undefined): Plan['review'] => {
  const x = fold(v ?? '').trim();
  return /^(nao|não|no|0|sem)$/.test(x) ? 'nao' : /^(forte|completa|total)$/.test(x) ? 'forte' : x ? 'leve' : undefined;
};
const numbers = (v: string | undefined) => (v ?? '').split(/[^0-9]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10);

/**
 * Os planos de uma resposta: cada [[plano]] com as [[etapa]] que vêm depois dele (até o próximo plano) é uma entrega,
 * um card. Entregas independentes são planos separados; passos de uma mesma entrega são etapas do mesmo plano.
 * Linhas que o modelo às vezes inventa no lugar ([[card titulo="…" responsavel="…" trabalho="…"]], [[tarefa …]])
 * valem como um plano de uma etapa.
 */
export function parsePlans(text: string | null): Plan[] {
  const src = text ?? '';
  const out: Plan[] = [];
  const heads = [...src.matchAll(/\[\[\s*plano\b((?:[^\]]|\](?!\]))*)\]\]/gi)];
  heads.forEach((h, i) => {
    const a = attrs(h[1]);
    const objective = clip((a.objetivo ?? a.titulo ?? '').replace(/\s+/g, ' ').trim(), 200);
    const end = i + 1 < heads.length ? heads[i + 1].index! : src.length;
    // etapas antes do primeiro plano (modelo que escreveu fora de ordem) ficam com o primeiro
    const body = src.slice(i === 0 ? 0 : h.index!, end);
    const steps: PlanStep[] = [];
    for (const m of body.matchAll(/\[\[\s*etapa\b((?:[^\]]|\](?!\]))*)\]\]/gi)) {
      const e = attrs(m[1]);
      const agent = (e.agente ?? e.responsavel ?? '').trim();
      const task = (e.faz ?? e.tarefa ?? e.pedido ?? e.trabalho ?? '').replace(/\s+/g, ' ').trim();
      if (agent && task.length >= 3) steps.push({ agent: clip(agent, 60), task: clip(task, 1000) });
      if (steps.length >= MAX_STEPS) break;
    }
    if (objective && steps.length) out.push({ objective, steps, review: reviewOf(a.revisao), order: numbers(a.ordem)[0], after: numbers(a.depois), due: a.prazo?.trim() || null });
  });
  for (const m of src.matchAll(/\[\[\s*(?:card|tarefa|nova-tarefa|criar-card)\b((?:[^\]]|\](?!\]))*)\]\]/gi)) {
    const a = attrs(m[1]);
    const objective = clip((a.titulo ?? a.objetivo ?? '').replace(/\s+/g, ' ').trim(), 200);
    const agent = (a.responsavel ?? a.agente ?? '').trim();
    const task = (a.trabalho ?? a.faz ?? a.detalhe ?? a.tarefa ?? objective).replace(/\s+/g, ' ').trim();
    if (objective && agent && task.length >= 3) out.push({ objective, steps: [{ agent: clip(agent, 60), task: clip(task, 1000) }], review: reviewOf(a.revisao), order: numbers(a.ordem)[0], after: numbers(a.depois), due: a.prazo?.trim() || null });
  }
  return out.slice(0, BATCH_MAX);
}

/** [[perguntar pergunta="…"]] na resposta de um agente: a pergunta que ele faz ao usuário. */
export function questionIn(text: string | null): string | null {
  const m = (text ?? '').match(/\[\[\s*perguntar\b([\s\S]{0,1500}?)\]\]/i);
  const q = m ? (attrs(m[1]).pergunta ?? '').replace(/\s+/g, ' ').trim() : '';
  return q ? clip(q, 600) : null;
}

export type StepStatus = 'pendente' | 'em_andamento' | 'feita' | 'falhou';
export interface StepRow {
  id: string; task_id: string; position: number; agent_id: string; title: string; status: StepStatus;
  output: string | null; run_id: string | null; done_at: string | null;
}

export function stepsOf(db: Db, taskId: string): StepRow[] {
  return db.all<StepRow>('SELECT id, task_id, position, agent_id, title, status, output, run_id, done_at FROM task_steps WHERE task_id = ? ORDER BY position', taskId);
}

/** A etapa da vez: a que está em andamento, ou a primeira que falta. */
export const currentStep = (steps: StepRow[]): StepRow | undefined =>
  steps.find((s) => s.status === 'em_andamento') ?? steps.find((s) => s.status === 'pendente' || s.status === 'falhou');

/**
 * O pedido do usuário por trás de uma execução da conversa: a mensagem dele que a disparou; numa continuação
 * (entrega, permissão), a última mensagem dele antes dela.
 */
export function purposeOf(db: Db, r: Pick<RunRow, 'id' | 'conversation_id' | 'created_at'>): string {
  if (!r.conversation_id) return '';
  const own = db.get<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'user' LIMIT 1", r.id)?.content;
  if (own) return own;
  return db.get<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND queued = 0 AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    r.conversation_id, r.created_at)?.content ?? '';
}

/** O que um card entregou: as etapas do plano, ou a última resposta conferida do agente. */
export function cardOutput(db: Db, taskId: string, max = 2500): string {
  const steps = stepsOf(db, taskId).filter((s) => s.output);
  if (steps.length) {
    const names = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM agents WHERE id IN (' + steps.map(() => '?').join(', ') + ')', ...steps.map((s) => s.agent_id)).map((a) => [a.id, a.name]));
    const each = Math.max(400, Math.floor(max / steps.length));
    return steps.map((s) => `${s.position}. ${names.get(s.agent_id) ?? 'Agente'} — ${s.title}:\n${clip(plain(s.output), each)}`).join('\n\n');
  }
  const out = db.get<{ output: string | null }>("SELECT output FROM runs WHERE task_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", taskId)?.output;
  return clip(plain(out), max);
}

/**
 * Os pedidos do usuário à equipe, de todas as conversas (abertos e os entregues há até 7 dias), para o agente da
 * conversa responder "como está o que pedi a fulano?" — e entregar o resultado, se já estiver pronto.
 */
export function requestsContext(db: Db, workspaceId: string, max = 8): string {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const rows = db.all<{ id: string; number: number; title: string; purpose: string | null; completed: number; work_state: string | null; agent: string | null; asked: string | null }>(
    `SELECT t.id, t.number, t.title, t.purpose, t.completed, t.work_state, a.name AS agent, ca.name AS asked
       FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN conversations c ON c.id = t.conversation_id LEFT JOIN agents ca ON ca.id = c.agent_id
      WHERE t.workspace_id = ? AND t.conversation_id IS NOT NULL AND t.archived = 0 AND (t.completed = 0 OR t.updated_at > ?)
      ORDER BY t.completed, t.updated_at DESC LIMIT ?`, workspaceId, since, max);
  if (!rows.length) return '';
  const STATE: Record<string, string> = {
    solicitada: 'na fila', processamento: 'em andamento', resultado: 'em andamento', validacao: 'em conferência', aguardando_info: 'esperando uma informação do usuário',
    aguardando_aprovacao: 'entregue, esperando a aprovação do usuário', revisao: 'não passou na conferência', falha: 'falhou', concluida: 'concluído',
  };
  const lines = rows.map((r) => {
    const steps = stepsOf(db, r.id);
    const cur = currentStep(steps);
    const where = r.completed ? 'concluído' : `${STATE[r.work_state ?? 'solicitada'] ?? r.work_state}${r.agent ? `, com ${r.agent}` : ''}${steps.length && cur ? `, etapa ${cur.position} de ${steps.length}` : ''}`;
    // entregue (concluído ou esperando a aprovação): o agente pode repassar o resultado
    const result = r.completed || r.work_state === 'aguardando_aprovacao' ? cardOutput(db, r.id, 500) : '';
    return `- Card #${r.number} “${clip(r.title, 90)}”${r.asked ? ` (pedido a ${r.asked}${r.purpose ? `: “${clip(r.purpose, 160)}”` : ''})` : ''}: ${where}${result ? `. Resultado: ${result.replace(/\s+/g, ' ')}` : ''}`;
  });
  return `Pedidos do usuário à equipe, de todas as conversas (use para responder "como está o que pedi a fulano?"; se já estiver pronto, entregue o resultado):\n${lines.join('\n')}`;
}

/** Card esperando o usuário: o que o cartão da conversa pede (informação, aprovação, decisão ou nova tentativa). */
export type Need = 'info' | 'approval' | 'review' | 'retry';
export interface RequestPayload { taskId: string; number: number; title: string; need: Need; agent: string; question: string | null; excerpt: string | null; /** entrega para a sua aprovação (Aprovar / Pedir ajustes), na rodada round */ review?: boolean; round?: number }

export class Purpose {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor;
  constructor(db: Db, bus: Bus, executor: RunExecutor) { this.db = db; this.bus = bus; this.executor = executor; }

  /** A conversa tem uma resposta em andamento (nada mais entra nela até terminar). */
  busy(conversationId: string): boolean {
    return !!this.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", conversationId);
  }

  /** Marca o card como nascido desta resposta da conversa: a entrega volta para lá, pelo agente que recebeu o pedido. */
  attach(workspaceId: string, taskId: string, r: Pick<RunRow, 'id' | 'agent_id' | 'conversation_id' | 'created_at'>, group?: string): void {
    if (!r.conversation_id) return;
    // group: entregas independentes da mesma resposta (lote) — cada card entrega quando fica pronto, sem esperar os outros
    this.db.run('UPDATE tasks SET conversation_id = ?, purpose = ?, deliver_agent_id = ?, origin_run_id = ? WHERE id = ? AND workspace_id = ?',
      r.conversation_id, this.db.seal(workspaceId, clip(purposeOf(this.db, r), 4000)) || null, r.agent_id, group ? `${r.id}:${group}` : r.id, taskId, workspaceId);
    // os arquivos que a pessoa mandou junto do pedido entram no card (cada etapa lê)
    for (const f of this.db.all<{ artifact_id: string }>('SELECT ma.artifact_id FROM messages m JOIN message_attachments ma ON ma.message_id = m.id WHERE m.run_id = ? AND m.workspace_id = ?', r.id, workspaceId)) {
      this.db.run("INSERT OR IGNORE INTO task_artifacts (workspace_id, task_id, artifact_id, role, created_at) VALUES (?, ?, ?, 'entrada', ?)", workspaceId, taskId, f.artifact_id, now());
    }
  }

  /**
   * A conversa de onde o card veio. Card de ajuda de antes desta versão: a conversa estava só na evidência do repasse —
   * fica gravada agora, num grupo só dele.
   */
  link(workspaceId: string, taskId: string, ev?: { conversationId?: string | null } | null): { conversationId: string; speaker: string } | null {
    const t = this.db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
    let conv = t?.conversation_id ?? null;
    if (!conv && ev?.conversationId) {
      const c = this.db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ? AND workspace_id = ?', ev.conversationId, workspaceId);
      if (!c) return null;
      this.db.run('UPDATE tasks SET conversation_id = ?, deliver_agent_id = COALESCE(deliver_agent_id, ?), origin_run_id = COALESCE(origin_run_id, ?) WHERE id = ?',
        ev.conversationId, c.agent_id, `legado-${taskId}`, taskId);
      conv = ev.conversationId;
    }
    if (!conv) return null;
    const speaker = this.db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ?', conv)?.agent_id;
    return speaker ? { conversationId: conv, speaker } : null;
  }

  /**
   * O plano do coordenador vira um card com as etapas em ordem; a primeira já fica em andamento (quem chama põe para
   * trabalhar). Agente que não existe: a etapa vai a quem as palavras dela apontam, ou à coordenação.
   */
  createPlan(r: RunRow, plan: Plan, create: (input: { title: string; description: string; agentId: string; purpose: string }) => { id: string; number: number },
    opts: { group?: string; quiet?: boolean } = {}):
    { taskId: string; number: number; steps: Array<{ name: string; task: string }> } | null {
    const ws = r.workspace_id;
    const team = activeTeam(this.db, ws);
    const coord = coordinatorOf(team);
    const steps = plan.steps.map((s) => ({ member: findMember(team, s.agent) ?? routeTo(team, s.task)?.member ?? coord, task: s.task }))
      .filter((s): s is { member: NonNullable<typeof s.member>; task: string } => !!s.member);
    // você pediu revisão: a equipe revisa a fundo antes de entregar (se o plano não trouxe quem revisa, entra o revisor)
    if (plan.review === 'forte' && steps.length < MAX_STEPS && !steps.some((s) => team.find((m) => m.id === s.member.id)?.tools.includes('revisao') && s !== steps[0])) {
      const reviewer = team.find((m) => m.tools.includes('revisao') && !m.coordinator && m.id !== steps[steps.length - 1]?.member.id);
      if (reviewer) steps.push({ member: reviewer, task: 'Revisão crítica completa da entrega: aponte cada problema (clareza, coerência, dados, forma) e devolva a versão final já corrigida, inteira.' });
    }
    if (!steps.length || !r.conversation_id) return null;
    const purpose = purposeOf(this.db, r);
    const deliverer = team.find((m) => m.id === r.agent_id)?.name ?? coord?.name ?? 'a coordenação';
    const description = [
      purpose ? `Pedido na conversa com ${deliverer}: “${clip(purpose, 600)}”` : `Pedido na conversa com ${deliverer}.`, '',
      'Plano:', ...steps.map((s, i) => `${i + 1}. ${s.member.name} — ${s.task}`), `${steps.length + 1}. ${deliverer} — entregar na conversa`,
    ].join('\n');
    const t = create({ title: plan.objective, description, agentId: steps[0].member.id, purpose });
    this.attach(ws, t.id, r, opts.group);
    this.db.run('UPDATE tasks SET review = ? WHERE id = ?', plan.review ?? 'leve', t.id);
    const ts = now();
    this.db.tx(() => {
      steps.forEach((s, i) => this.db.run(
        'INSERT INTO task_steps (id, workspace_id, task_id, position, agent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id('stp'), ws, t.id, i + 1, s.member.id, this.db.seal(ws, s.task), i === 0 ? 'em_andamento' : 'pendente', ts));
    });
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.plan', targetType: 'task', targetId: t.id,
      evidence: { conversationId: r.conversation_id, runId: r.id, steps: steps.map((s) => `${s.member.name}: ${clip(s.task, 160)}`) },
      result: `${deliverer} planejou ${steps.length} etapa(s): ${steps.map((s) => s.member.name).join(' → ')} → entrega na conversa` });
    if (!opts.quiet) this.note(ws, r.conversation_id, `Sistema — card #${t.number} com o plano em ${steps.length} etapa(s):\n${steps.map((s, i) => `${i + 1}. ${s.member.name}: ${clip(s.task, 140)}`).join('\n')}\nQuando terminar, ${deliverer} entrega aqui.`);
    return { taskId: t.id, number: Number(t.number), steps: steps.map((s) => ({ name: s.member.name, task: s.task })) };
  }

/**
   * A entrega que espera a sua aprovação chegou na conversa: o cartão com Aprovar e Pedir ajustes (o mesmo pedido em
   * todo lugar; responder em qualquer canto resolve).
   */
  afterDelivery(r: Pick<RunRow, 'workspace_id' | 'conversation_id' | 'idempotency_key' | 'id' | 'agent_id'>): void {
    if (!r.conversation_id) return;
    const origin = r.idempotency_key.slice(DELIVERY_KEY.length).replace(/#r\d+$/, '');
    const cards = this.db.all<{ id: string; number: number; title: string; review_round: number }>(
      "SELECT id, number, title, review_round FROM tasks WHERE origin_run_id = ? AND workspace_id = ? AND archived = 0 AND completed = 0 AND work_state = 'aguardando_aprovacao' AND delivered_at IS NOT NULL ORDER BY number",
      origin, r.workspace_id);
    const who = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? 'A equipe';
    for (const c of cards) {
      this.closeRequests(r.workspace_id, c.id, 'substituído pela entrega nova', 'rejected');
      const payload: RequestPayload = { taskId: c.id, number: Number(c.number), title: c.title, need: 'approval', agent: who, question: null, excerpt: null, review: true, round: Number(c.review_round) || 1 };
      this.db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at) VALUES (?, ?, ?, ?, 'info_request', ?, ?, 'proposed', ?)`,
        id('apr'), r.workspace_id, r.conversation_id, r.id, this.db.seal(r.workspace_id, JSON.stringify(payload)),
        this.db.seal(r.workspace_id, clip(`Aprovar a entrega do card #${c.number} (“${c.title}”)${Number(c.review_round) > 1 ? `, versão ${c.review_round}` : ''}`, 600)), now());
    }
    if (cards.length) this.bus.publish(r.workspace_id, 'proposals.changed', { conversationId: r.conversation_id });
  }

  /** O ajuste mais recente que a pessoa pediu nestes cards (vai para a entrega da versão nova). */
  private lastAdjust(taskIds: string[]): string | null {
    for (const t of taskIds) {
      const ev = this.db.get<{ evidence: string }>("SELECT evidence FROM task_results WHERE task_id = ? AND state = 'devolvido' ORDER BY created_at DESC, rowid DESC LIMIT 1", t)?.evidence;
      try { const x = JSON.parse(ev ?? '{}') as { instrucao?: string }; if (x.instrucao) return x.instrucao; } catch { /* sem registro legível */ }
    }
    return null;
  }

  /** Nota do sistema na conversa (bloco tracejado). */
  note(workspaceId: string, conversationId: string, text: string): void {
    this.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)`,
      id('msg'), workspaceId, conversationId, this.db.seal(workspaceId, clip(text, 4000)), now());
    this.bus.publish(workspaceId, 'messages.changed', { conversationId });
  }

  /** Mensagem do agente da conversa (sem modelo): um pedido repassado aparece como dele, nunca como do usuário. */
  say(workspaceId: string, conversationId: string, text: string): void {
    this.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', ?, 'local', ?)`,
      id('msg'), workspaceId, conversationId, this.db.seal(workspaceId, clip(text, 6000)), now());
    this.bus.publish(workspaceId, 'messages.changed', { conversationId });
  }

  /** A resposta do usuário a um pedido do card, registrada na conversa como dele (sem disparar o agente da conversa). */
  userSaid(workspaceId: string, conversationId: string, userId: string, text: string): void {
    this.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'local', ?)`,
      id('msg'), workspaceId, conversationId, userId, this.db.seal(workspaceId, clip(text, 4000)), now());
    this.bus.publish(workspaceId, 'messages.changed', { conversationId });
  }

  /** Fecha os cartões abertos de um card (respondido, aprovado ou apagado por outro caminho). */
  closeRequests(workspaceId: string, taskId: string, result: string, status: 'applied' | 'rejected' = 'applied'): void {
    const open = this.db.all<{ id: string; payload: string; conversation_id: string | null }>("SELECT id, payload, conversation_id FROM agent_proposals WHERE workspace_id = ? AND kind = 'info_request' AND status = 'proposed'", workspaceId)
      .filter((p) => { try { return (JSON.parse(p.payload) as RequestPayload).taskId === taskId; } catch { return false; } });
    for (const p of open) {
      this.db.run('UPDATE agent_proposals SET status = ?, result = ?, decided_at = ? WHERE id = ?', status, this.db.seal(workspaceId, clip(result, 300)), now(), p.id);
      this.bus.publish(workspaceId, 'proposals.changed', { conversationId: p.conversation_id });
    }
  }

  /**
   * O card parou esperando o usuário: o agente da conversa repassa o pedido ali, como mensagem dele, com um cartão
   * para responder, aprovar ou decidir. Uma vez por decisão do card (a anterior é substituída).
   */
  relay(workspaceId: string, taskId: string, res: ResultRow, output: string | null, workerId: string, ev?: { conversationId?: string | null } | null): void {
    const link = this.link(workspaceId, taskId, ev);
    if (!link) return;
    const t = this.db.get<{ number: number; title: string }>('SELECT number, title FROM tasks WHERE id = ?', taskId);
    if (!t) return;
    const who = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', workerId)?.name ?? 'O colega';
    const me = workerId === link.speaker;
    const card = `card #${t.number} (“${clip(t.title, 80)}”)`;
    const excerpt = clip(plain(output), 1200) || null;
    let need: Need; let text: string; let question: string | null = null;
    if (res.state === 'aguardando_info') {
      need = 'info';
      question = questionIn(output) ?? clip(res.justification, 400);
      text = me ? `Preciso de uma informação sua para seguir com o ${card}: ${question}` : `${who} precisa de uma informação sua para seguir com o ${card}: ${question}`;
    } else if (res.state === 'aguardando_aprovacao' && this.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND delivered_at IS NOT NULL', taskId)) {
      // entregue a você: quem recebeu o pedido entrega o trabalho aqui; Aprovar e Pedir ajustes vêm logo depois
      this.closeRequests(workspaceId, taskId, 'entregue para a sua aprovação', 'rejected');
      this.dispatch(workspaceId, link.conversationId);
      return;
    } else if (res.state === 'aguardando_aprovacao' || res.state === 'sem_confirmacao') {
      need = 'approval';
      text = res.state === 'sem_confirmacao'
        ? `O ${card} está preparado, mas é algo a fazer fora do Ergon: confirme aqui quando estiver feito.`
        : `O ${card} está pronto e precisa da sua aprovação.`;
    } else if (res.state === 'reprovado') {
      need = 'review';
      text = `${me ? 'A minha resposta' : `A resposta de ${who}`} para o ${card} não passou na conferência: ${clip(res.justification, 300)} Você pode aprovar assim mesmo ou devolver com uma instrução.`;
    } else if (res.state === 'falha') {
      need = 'retry';
      text = `${me ? 'Não consegui' : `${who} não conseguiu`} terminar o ${card}: ${clip(res.justification, 300)}`;
    } else return;
    this.closeRequests(workspaceId, taskId, 'substituído por um pedido mais novo', 'rejected');
    this.say(workspaceId, link.conversationId, text);
    const payload: RequestPayload = { taskId, number: Number(t.number), title: t.title, need, agent: who, question, excerpt: need === 'info' ? null : excerpt };
    this.db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at) VALUES (?, ?, ?, ?, 'info_request', ?, ?, 'proposed', ?)`,
      id('apr'), workspaceId, link.conversationId, res.run_id, this.db.seal(workspaceId, JSON.stringify(payload)), this.db.seal(workspaceId, clip(question ?? text, 600)), now());
    this.bus.publish(workspaceId, 'proposals.changed', { conversationId: link.conversationId });
  }

  /**
   * Um card da conversa terminou (conferido ou aprovado por você). Se outros cards da mesma resposta ainda trabalham,
   * a conversa recebe só o andamento; quando todos terminam, quem recebeu o pedido entrega (dispatch).
   */
  cardDone(workspaceId: string, taskId: string, ev?: { conversationId?: string | null } | null): void {
    const link = this.link(workspaceId, taskId, ev);
    if (!link) return;
    this.closeRequests(workspaceId, taskId, 'card concluído');
    const t = this.db.get<{ number: number; origin_run_id: string | null; agent_id: string | null }>('SELECT number, origin_run_id, agent_id FROM tasks WHERE id = ?', taskId);
    const rest = t?.origin_run_id ? this.db.all<{ number: number; name: string | null }>(
      'SELECT t.number, a.name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.origin_run_id = ? AND t.completed = 0 AND t.archived = 0 ORDER BY t.number', t.origin_run_id) : [];
    if (t && rest.length) {
      const who = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', t.agent_id ?? '')?.name ?? 'O colega';
      this.note(workspaceId, link.conversationId, `Sistema — ${who} terminou o card #${t.number}. Faltam: ${rest.map((x) => `#${x.number}${x.name ? ` (${x.name})` : ''}`).join(', ')}.`);
    }
    this.dispatch(workspaceId, link.conversationId);
  }

  /**
   * Entrega pendente na conversa: todos os cards nascidos de uma mesma resposta terminaram e ninguém continuou ainda.
   * Conversa livre: quem recebeu o pedido continua agora; ocupada: fica para quando a resposta em andamento terminar
   * (quem termina chama de novo). true = enfileirou.
   */
  dispatch(workspaceId: string, conversationId: string): boolean {
    if (this.busy(conversationId)) return false;
    const groups = this.db.all<{ origin_run_id: string }>(
      `SELECT DISTINCT origin_run_id FROM tasks t WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.origin_run_id IS NOT NULL AND ${READY_SQL()} AND t.archived = 0
         AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.idempotency_key = ${DELIVERY_KEY_SQL()})`, workspaceId, conversationId);
    for (const g of groups) {
      const cards = this.db.all<{ id: string; number: number; title: string; agent_id: string | null; deliver_agent_id: string | null; purpose: string | null; completed: number; work_state: string | null; delivered_at: string | null; review_round: number }>(
        'SELECT id, number, title, agent_id, deliver_agent_id, purpose, completed, work_state, delivered_at, review_round FROM tasks WHERE origin_run_id = ? AND archived = 0 ORDER BY number', g.origin_run_id);
      const ready = (c: (typeof cards)[number]) => !!Number(c.completed) || (c.work_state === 'aguardando_aprovacao' && !!c.delivered_at);
      if (!cards.length || cards.some((c) => !ready(c))) continue;
      const round = Math.max(...cards.map((c) => Number(c.review_round) || 1));
      const forYou = cards.some((c) => !Number(c.completed));
      if (this.db.get('SELECT 1 AS x FROM runs WHERE idempotency_key = ?', deliveryKey(g.origin_run_id, round))) continue;
      const conv = this.db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ?', conversationId);
      const team = activeTeam(this.db, workspaceId);
      const deliverer = team.find((m) => m.id === cards[0].deliver_agent_id) ?? team.find((m) => m.id === conv?.agent_id) ?? coordinatorOf(team);
      if (!deliverer) return false;
      const names = new Map(team.map((m) => [m.id, m.name]));
      const purpose = cards.find((c) => c.purpose)?.purpose ?? '';
      const parts = cards.map((c) => {
        const planned = !!this.db.get('SELECT 1 AS x FROM task_steps WHERE task_id = ? LIMIT 1', c.id);
        return planned ? `Card #${c.number} (o seu plano), o que cada etapa entregou:\n${cardOutput(this.db, c.id, 240_000)}`
          : `Card #${c.number} — ${names.get(c.agent_id ?? '') ?? 'o colega'} respondeu:\n${cardOutput(this.db, c.id, 240_000)}`;
      });
      const input = [
        'A equipe terminou o que você pediu para atender o usuário nesta conversa.',
        purpose ? `Pedido do usuário: “${clip(purpose, 8000)}”` : '',
        '', parts.join('\n\n'), '',
        round > 1 ? `Esta é a versão ${round}, refeita com os ajustes que a pessoa pediu${(() => { const n = this.lastAdjust(cards.map((c) => c.id)); return n ? `: “${clip(n, 2000)}”` : ''; })()}. Entregue a versão nova completa e diga em uma frase o que mudou.` : '',
        forYou ? 'Depois da sua mensagem aparecem para a pessoa os botões Aprovar e Pedir ajustes: diga em uma frase, no seu jeito, que fica esperando a aprovação dela (ou os ajustes) para fechar o card.' : '',
        'Agora entregue ao usuário, aqui, exatamente o que ele pediu — no formato e no tamanho pedidos. Se ele pediu um documento (contrato, texto, relatório), entregue a versão final completa, inteira e pronta para usar, já com as correções das revisões. Não descreva o processo e não peça confirmação para entregar. Campos sem dado ficam como [PREENCHER]; se faltar algo, liste em uma frase no fim.',
      ].filter((x) => x !== '').join('\n');
      try {
        const run = this.executor.enqueue({
          workspaceId, agentId: deliverer.id, conversationId, kind: 'chat', input: clip(input, 400_000), maxInput: 400_000,
          instructions: instructionsFor(this.db, workspaceId, deliverer.id, 'Canal: conversa no Ergon. Entrega de um pedido da pessoa: responda com a entrega pronta, em texto, com uma frase sua antes, no seu jeito (o documento em si sai profissional).', { requests: true, userId: this.db.get<{ u: string }>('SELECT owner_user_id AS u FROM conversations WHERE id = ?', conversationId)?.u ?? null }),
          idempotencyKey: deliveryKey(g.origin_run_id, round),
        });
        for (const c of cards) {
          audit(this.db, null, { workspaceId, actorType: 'agent', actorId: deliverer.id, action: 'task.delivery', targetType: 'task', targetId: c.id,
            evidence: { conversationId, runId: run.id, cards: cards.map((x) => x.number) }, result: `${deliverer.name} entrega na conversa` });
        }
        this.bus.publish(workspaceId, 'tasks.changed', {});
        return true;
      } catch { return false; } // limite diário: tenta de novo na próxima volta
    }
    return false;
  }
}
