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
import { clip, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { attrs } from './routine-proposals.ts';
import { instructionsFor, type RunExecutor, type RunRow } from './runs.ts';
import type { ResultRow } from './results.ts';
import { activeTeam, coordinatorOf, findMember, routeTo } from './team.ts';

export interface PlanStep { agent: string; task: string }
export interface Plan { objective: string; steps: PlanStep[] }
export const MAX_STEPS = 8;
/** prefixo das execuções de entrega (a conversa continua; não entra no limite de processos) */
export const DELIVERY_KEY = 'entrega-';

/** Texto sem as linhas de controle ([[...]]). */
const plain = (s: string | null | undefined): string => (s ?? '').replace(/\[\[[^\]]*\]\]\s*/g, '').trim();

/**
 * O plano do coordenador: [[plano objetivo="…"]] e uma linha [[etapa agente="…" faz="…"]] por etapa, em ordem
 * (até 8). Sem objetivo ou sem etapa válida, não há plano.
 */
export function parsePlan(text: string | null): Plan | null {
  const head = (text ?? '').match(/\[\[\s*plano\b([\s\S]{0,1200}?)\]\]/i);
  if (!head) return null;
  const objective = clip((attrs(head[1]).objetivo ?? '').replace(/\s+/g, ' ').trim(), 200);
  const steps: PlanStep[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*etapa\b([\s\S]{0,1500}?)\]\]/gi)) {
    const a = attrs(m[1]);
    const agent = (a.agente ?? '').trim();
    const task = (a.faz ?? a.tarefa ?? a.pedido ?? '').replace(/\s+/g, ' ').trim();
    if (agent && task.length >= 3) steps.push({ agent: clip(agent, 60), task: clip(task, 1000) });
    if (steps.length >= MAX_STEPS) break;
  }
  return objective && steps.length ? { objective, steps } : null;
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
    aguardando_aprovacao: 'esperando a aprovação do usuário', revisao: 'não passou na conferência', falha: 'falhou', concluida: 'concluído',
  };
  const lines = rows.map((r) => {
    const steps = stepsOf(db, r.id);
    const cur = currentStep(steps);
    const where = r.completed ? 'concluído' : `${STATE[r.work_state ?? 'solicitada'] ?? r.work_state}${r.agent ? `, com ${r.agent}` : ''}${steps.length && cur ? `, etapa ${cur.position} de ${steps.length}` : ''}`;
    const result = r.completed ? cardOutput(db, r.id, 500) : '';
    return `- Card #${r.number} “${clip(r.title, 90)}”${r.asked ? ` (pedido a ${r.asked}${r.purpose ? `: “${clip(r.purpose, 160)}”` : ''})` : ''}: ${where}${result ? `. Resultado: ${result.replace(/\s+/g, ' ')}` : ''}`;
  });
  return `Pedidos do usuário à equipe, de todas as conversas (use para responder "como está o que pedi a fulano?"; se já estiver pronto, entregue o resultado):\n${lines.join('\n')}`;
}

/** Card esperando o usuário: o que o cartão da conversa pede (informação, aprovação, decisão ou nova tentativa). */
export type Need = 'info' | 'approval' | 'review' | 'retry';
export interface RequestPayload { taskId: string; number: number; title: string; need: Need; agent: string; question: string | null; excerpt: string | null }

export class Purpose {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor;
  constructor(db: Db, bus: Bus, executor: RunExecutor) { this.db = db; this.bus = bus; this.executor = executor; }

  /** A conversa tem uma resposta em andamento (nada mais entra nela até terminar). */
  busy(conversationId: string): boolean {
    return !!this.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", conversationId);
  }

  /** Marca o card como nascido desta resposta da conversa: a entrega volta para lá, pelo agente que recebeu o pedido. */
  attach(workspaceId: string, taskId: string, r: Pick<RunRow, 'id' | 'agent_id' | 'conversation_id' | 'created_at'>): void {
    if (!r.conversation_id) return;
    this.db.run('UPDATE tasks SET conversation_id = ?, purpose = ?, deliver_agent_id = ?, origin_run_id = ? WHERE id = ? AND workspace_id = ?',
      r.conversation_id, this.db.seal(workspaceId, clip(purposeOf(this.db, r), 4000)) || null, r.agent_id, r.id, taskId, workspaceId);
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
  createPlan(r: RunRow, plan: Plan, create: (input: { title: string; description: string; agentId: string; purpose: string }) => { id: string; number: number }):
    { taskId: string; number: number; steps: Array<{ name: string; task: string }> } | null {
    const ws = r.workspace_id;
    const team = activeTeam(this.db, ws);
    const coord = coordinatorOf(team);
    const steps = plan.steps.map((s) => ({ member: findMember(team, s.agent) ?? routeTo(team, s.task)?.member ?? coord, task: s.task }))
      .filter((s): s is { member: NonNullable<typeof s.member>; task: string } => !!s.member);
    if (!steps.length || !r.conversation_id) return null;
    const purpose = purposeOf(this.db, r);
    const deliverer = team.find((m) => m.id === r.agent_id)?.name ?? coord?.name ?? 'a coordenação';
    const description = [
      purpose ? `Pedido na conversa com ${deliverer}: “${clip(purpose, 600)}”` : `Pedido na conversa com ${deliverer}.`, '',
      'Plano:', ...steps.map((s, i) => `${i + 1}. ${s.member.name} — ${s.task}`), `${steps.length + 1}. ${deliverer} — entregar na conversa`,
    ].join('\n');
    const t = create({ title: plan.objective, description, agentId: steps[0].member.id, purpose });
    this.attach(ws, t.id, r);
    const ts = now();
    this.db.tx(() => {
      steps.forEach((s, i) => this.db.run(
        'INSERT INTO task_steps (id, workspace_id, task_id, position, agent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id('stp'), ws, t.id, i + 1, s.member.id, this.db.seal(ws, s.task), i === 0 ? 'em_andamento' : 'pendente', ts));
    });
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.plan', targetType: 'task', targetId: t.id,
      evidence: { conversationId: r.conversation_id, runId: r.id, steps: steps.map((s) => `${s.member.name}: ${clip(s.task, 160)}`) },
      result: `${deliverer} planejou ${steps.length} etapa(s): ${steps.map((s) => s.member.name).join(' → ')} → entrega na conversa` });
    this.note(ws, r.conversation_id, `Sistema — card #${t.number} com o plano em ${steps.length} etapa(s):\n${steps.map((s, i) => `${i + 1}. ${s.member.name}: ${clip(s.task, 140)}`).join('\n')}\nQuando terminar, ${deliverer} entrega aqui.`);
    return { taskId: t.id, number: Number(t.number), steps: steps.map((s) => ({ name: s.member.name, task: s.task })) };
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
      `SELECT DISTINCT origin_run_id FROM tasks t WHERE t.workspace_id = ? AND t.conversation_id = ? AND t.origin_run_id IS NOT NULL AND t.completed = 1 AND t.archived = 0
         AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.idempotency_key = ? || t.origin_run_id)`, workspaceId, conversationId, DELIVERY_KEY);
    for (const g of groups) {
      const cards = this.db.all<{ id: string; number: number; title: string; agent_id: string | null; deliver_agent_id: string | null; purpose: string | null; completed: number }>(
        'SELECT id, number, title, agent_id, deliver_agent_id, purpose, completed FROM tasks WHERE origin_run_id = ? AND archived = 0 ORDER BY number', g.origin_run_id);
      if (!cards.length || cards.some((c) => !Number(c.completed))) continue;
      const conv = this.db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ?', conversationId);
      const team = activeTeam(this.db, workspaceId);
      const deliverer = team.find((m) => m.id === cards[0].deliver_agent_id) ?? team.find((m) => m.id === conv?.agent_id) ?? coordinatorOf(team);
      if (!deliverer) return false;
      const names = new Map(team.map((m) => [m.id, m.name]));
      const purpose = cards.find((c) => c.purpose)?.purpose ?? '';
      const parts = cards.map((c) => {
        const planned = !!this.db.get('SELECT 1 AS x FROM task_steps WHERE task_id = ? LIMIT 1', c.id);
        return planned ? `Card #${c.number} (o seu plano), o que cada etapa entregou:\n${cardOutput(this.db, c.id, 4000)}`
          : `Card #${c.number} — ${names.get(c.agent_id ?? '') ?? 'o colega'} respondeu:\n${cardOutput(this.db, c.id, 2500)}`;
      });
      const input = [
        'A equipe terminou o que você pediu para atender o usuário nesta conversa.',
        purpose ? `Pedido do usuário: “${clip(purpose, 1500)}”` : '',
        '', parts.join('\n\n'), '',
        'Agora entregue ao usuário, aqui, exatamente o que ele pediu — no formato e no tamanho pedidos. Não descreva o processo, não repita os textos dos colegas por inteiro e não peça confirmação para entregar. Se faltar algo essencial, diga o que falta em uma frase.',
      ].filter((x) => x !== '').join('\n');
      try {
        const run = this.executor.enqueue({
          workspaceId, agentId: deliverer.id, conversationId, kind: 'chat', input: clip(input, 12000), maxInput: 12000,
          instructions: instructionsFor(this.db, workspaceId, deliverer.id, 'Canal: chat do Ergon. Entrega de um pedido do usuário: responda com a entrega pronta, em texto.', { requests: true }),
          idempotencyKey: `${DELIVERY_KEY}${g.origin_run_id}`,
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
