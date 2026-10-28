/**
 * Trabalho em equipe pelo quadro: os agentes se especializam (cada um com as suas ferramentas) e, quando
 * falta algo, pedem ajuda a quem tem — o pedido vira um card no quadro da equipe para esse colega, e o
 * repasse fica visível. O andamento automático (ligado por padrão; você pode desligar) faz os agentes pegarem as
 * tarefas de "A fazer", de cima para baixo, até o limite de trabalhos ao mesmo tempo (concurrency.ts); o resto
 * espera ali, na ordem que você der. Vale o mesmo limite diário de qualquer execução. Nada aqui chama modelo diretamente: só enfileira execuções no executor.
 *
 * Fim de execução não é fim de trabalho: quem decide se o card foi concluído é o contrato de resultado
 * (results.ts), com critérios por tipo de trabalho e evidência. Tarefa de dados com planilha anexada passa antes
 * pela análise determinística do Ergon (operations.ts): o agente recebe os números prontos e só comenta.
 *
 * O card que nasce de uma conversa leva o pedido do usuário até a entrega (purpose.ts): o plano do coordenador anda
 * etapa por etapa, cada uma com o seu agente, e no fim quem recebeu o pedido entrega na conversa.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting } from './sectors.ts';
import { instructionsFor, isCoordinator, type RunExecutor, type RunRow, type RunStatus } from './runs.ts';
import { createTask, defaultBoard, getTask, updateTask } from './tasks.ts';
import { activeTeam, coordinatorOf } from './team.ts';
import { filesBrief, referenceFrom, summaryText, taskFiles, type Operations } from './operations.ts';
import { classifyTask, type ResultRow, type Results } from './results.ts';
import { DELIVERY_KEY, Purpose, currentStep, parsePlan, stepsOf, type StepRow } from './purpose.ts';
import { parseDue } from './due.ts';
import { workspaceTz } from './routine-proposals.ts';

export interface HelpRequest { agent: string; request: string }
/** quantos pedidos de ajuda numa resposta: o coordenador aciona a equipe inteira, os outros pedem a poucos colegas */
export const HELP_MAX = { agent: 3, coordinator: 12 };

/** [[pedir-ajuda agente="Hipátia" pedido="..."]] na resposta de um agente (até `max` por resposta). */
export function parseHelpRequests(text: string | null, max = HELP_MAX.agent): HelpRequest[] {
  const out: HelpRequest[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*pedir-ajuda\b([^\]]{0,1200})\]\]/gi)) {
    const agent = m[1].match(/agente\s*=\s*["“]([^"”]{1,60})["”]/i)?.[1]?.trim();
    const request = m[1].match(/pedido\s*=\s*["“]([^"”]{3,1000})["”]/i)?.[1]?.trim();
    if (agent && request) out.push({ agent, request });
    if (out.length >= max) break;
  }
  return out;
}

export interface ProcessRequest { op: string; file: string | null; referencia: string | null }

/** [[processar operacao="analise-desempenho" arquivo="tarefas.csv" referencia="2026-10-24"]] (no máximo 2 por resposta). */
export function parseProcessRequests(text: string | null): ProcessRequest[] {
  const out: ProcessRequest[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*processar\b([^\]]{0,600})\]\]/gi)) {
    const attr = (k: string) => m[1].match(new RegExp(`${k}\\s*=\\s*["“]([^"”]{1,200})["”]`, 'i'))?.[1]?.trim() ?? null;
    const op = attr('operacao');
    if (op) out.push({ op, file: attr('arquivo'), referencia: attr('referencia') });
    if (out.length >= 2) break;
  }
  return out;
}

/** Tira as linhas de controle ([[...]]) do texto mostrado ao usuário. */
export const stripControl = (s: string): string => s.replace(/\[\[\s*(processar|pedir-ajuda|pedir-permissao|mover|novo-agente|ferramenta|propor-rotina|sugerir-rotina|ajustar-rotina|reapresentar-rotina|configurar-rotina|perguntar|editar-agente|desativar-agente|reativar-agente|editar-setor|novo-setor|propor-tarefa|categoria|plano|etapa|apagar-card|cancelar-card)\b[^\]]*\]\]\s*/gi, '').trim();
const words = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
/** etapa intermediária com menos que isto não passa adiante (vai para a conferência, com o motivo) */
const STEP_MIN_WORDS = 10;

const COLS = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluído' };
/** Ordem da fila em "A fazer": a posição que você deu (arrastando ou com Prioridade) ou a de chegada (número do card). */
export const QUEUE_ORDER = 'COALESCE(t.queue_pos, t.number), t.number';
const MAX_ATTEMPTS = 2;
/** O pedido fala de um arquivo que não veio junto: perguntar antes de gastar uma chamada de modelo. */
const MENTIONS_FILE = /(^|[^a-z])(planilh|csv|anexad|em anexo|esta tabela|este arquivo|neste arquivo|nesse arquivo|desse arquivo|deste arquivo)/;
const CLOSING: Record<string, string> = {
  dados: 'Os números acima foram calculados pelo sistema a partir do arquivo e já estão nos entregáveis do card. Escreva um comentário curto (até 150 palavras) para quem pediu: o que se destaca e o que merece atenção. Não recalcule, não estime e não invente números.',
  documental: 'Entregue o documento completo, pronto para usar, em Markdown: ele será salvo como entregável do card. Não diga apenas que terminou — o documento é a entrega.',
  externo: 'Você não executa ações fora do Ergon (enviar, pagar, publicar, agendar). Prepare tudo o que for preciso (rascunho, dados, passos) e diga exatamente o que a pessoa precisa fazer para concluir.',
  informativo: 'Responda com o resultado completo da tarefa, pronto para usar.',
};
/** etapa do meio de um plano: a entrega é para a próxima etapa, não para o usuário */
const STEP_CLOSING = 'Entregue o resultado completo da sua etapa, em texto, pronto para a próxima etapa usar. Não diga apenas que terminou.';

export class Teamwork {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor;
  private readonly results: Results; private readonly ops: Operations; private readonly filesDir: string;
  private timer: NodeJS.Timeout | null = null;
  /** o fio do pedido: conversa de origem, entrega e pedidos repassados (purpose.ts) */
  readonly purpose: Purpose;
  /** conversa livre de novo (o app entrega o que ficou pronto ou manda a próxima mensagem da fila) */
  onIdle: ((workspaceId: string, conversationId: string) => void) | null = null;

  constructor(db: Db, bus: Bus, executor: RunExecutor, results: Results, ops: Operations, filesDir: string) {
    this.db = db; this.bus = bus; this.executor = executor; this.results = results; this.ops = ops; this.filesDir = filesDir;
    this.purpose = new Purpose(db, bus, executor);
    executor.onFinish((r, status, output) => this.finished(r, status, output));
  }

  start(everyMs = 4000): void { if (!this.timer) { this.timer = setInterval(() => this.tick(), everyMs); this.timer.unref?.(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Andamento automático: ligado por padrão (as automações começam ligadas); só "0" — você desligou — para. */
  autorun(workspaceId: string): boolean { return getSetting(this.db, workspaceId, 'team.autorun') !== '0'; }

  private column(boardId: string, name: string): string | null {
    return this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND name = ? ORDER BY position LIMIT 1', boardId, name)?.id ?? null;
  }

  /** Cria os cards de ajuda pedidos por um agente (o repasse fica no log de cada card). */
  createHelpCards(r: RunRow, requests: HelpRequest[]): Array<{ number: number; to: string }> {
    const ws = r.workspace_id;
    const from = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? 'Agente';
    const team = this.db.all<{ id: string; name: string; char_key: string | null; skey: string }>(
      "SELECT a.id, a.name, a.char_key, p.key AS skey FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.status = 'active'", ws);
    const coordId = coordinatorOf(activeTeam(this.db, ws))?.id;
    const coord = team.find((a) => a.id === coordId);
    const parent = r.task_id ? this.db.get<{ number: number }>('SELECT number FROM tasks WHERE id = ?', r.task_id) : undefined;
    const made: Array<{ number: number; to: string }> = [];
    for (const h of requests) {
      const n = fold(h.agent);
      const helper = team.find((a) => fold(a.name) === n) ?? team.find((a) => fold(a.name).startsWith(n));
      const to = helper && helper.id !== r.agent_id ? helper : coord;
      if (!to || to.id === r.agent_id) continue;
      const t = createTask(this.db, null, ws, { type: 'agent', id: r.agent_id }, {
        title: clip(`Ajuda a ${from}: ${h.request}`, 90),
        description: `${h.request}\n\nPedido por ${from}${parent ? ` (tarefa #${parent.number})` : r.conversation_id ? ' numa conversa' : ''}.${to !== helper ? ` ${h.agent} não está ativo: a coordenação faz a triagem.` : ''}`,
        boardId: defaultBoard(this.db, ws).id, columnId: this.column(defaultBoard(this.db, ws).id, COLS.todo) ?? undefined,
        agentId: to.id, origin: 'chat',
      });
      if (r.task_id) this.db.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', r.task_id, t.id);
      // pedido feito na conversa: a resposta do colega volta para lá, e quem pediu entrega
      else if (r.kind === 'chat' && r.conversation_id) this.purpose.attach(ws, t.id, r);
      audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.handoff', targetType: 'task', targetId: t.id,
        evidence: { from, to: to.name, request: clip(h.request, 400), conversationId: r.conversation_id, parentTaskId: r.task_id }, result: `${from} pediu ajuda a ${to.name}` });
      made.push({ number: Number(t.number), to: to.name });
    }
    if (made.length) {
      if (r.conversation_id) {
        this.purpose.note(ws, r.conversation_id, `Sistema — ${from} pediu ajuda (${made.length}):\n${made.map((m) => `card #${m.number} para ${m.to}`).join('\n')}\nAs respostas voltam aqui e ${from} entrega.`);
      }
      this.bus.publish(ws, 'tasks.changed', {});
    }
    return made;
  }

  private finished(r: RunRow, status: RunStatus, output: string | null): void {
    if (r.idempotency_key.startsWith('training-')) return; // treinamento: quem cuida é o Treinar
    // card cancelado enquanto o agente trabalhava: nada continua (próxima etapa, pedido de ajuda, conferência, entrega)
    if (r.task_id && Number(this.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', r.task_id)?.archived)) return;
    const ws = r.workspace_id;
    const coord = isCoordinator(this.db.get<{ coordinator: number }>('SELECT coordinator FROM agents WHERE id = ?', r.agent_id) ?? { coordinator: 0 });
    const help = status === 'succeeded' ? parseHelpRequests(output, coord ? HELP_MAX.coordinator : HELP_MAX.agent) : [];
    const cards = help.length ? this.createHelpCards(r, help) : [];
    // o coordenador planejou na conversa: o card nasce com as etapas e a primeira já começa
    if (status === 'succeeded' && coord && r.kind === 'chat' && r.conversation_id) {
      const plan = parsePlan(output);
      if (plan) this.startPlan(r, plan);
    }
    if (r.idempotency_key.startsWith(DELIVERY_KEY) && status === 'succeeded') this.bus.publish(ws, 'tasks.changed', {});
    if (!r.idempotency_key.startsWith('queue-') || !r.task_id) return;
    // o agente pediu um processamento ao Ergon: executa (com as permissões conferidas) antes de avaliar
    if (status === 'succeeded') {
      for (const p of parseProcessRequests(output)) {
        try { this.ops.run(ws, { taskId: r.task_id, agentId: r.agent_id, op: p.op, file: p.file, referencia: p.referencia }); }
        catch (err) {
          audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'operation.refused', targetType: 'task', targetId: r.task_id,
            evidence: { op: p.op, file: p.file }, result: err instanceof Error ? err.message : 'recusado' });
        }
      }
    }
    if (status === 'succeeded' && cards.length) { // espera os colegas: o card volta à fila quando a ajuda chegar
      audit(this.db, null, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'task.waiting_help', targetType: 'task', targetId: r.task_id,
        evidence: { runId: r.id, cards: cards.map((c) => c.number) }, result: `aguardando ajuda: ${cards.map((c) => `card #${c.number} (${c.to})`).join(', ')}` });
      return;
    }
    const steps = stepsOf(this.db, r.task_id);
    // plano: a etapa do meio que entregou passa adiante; a última (ou a que parou) vai para a conferência do card
    if (steps.length && this.advance(r, status, output, steps)) return;
    // fim de execução não é fim de trabalho: o contrato de resultado decide, com evidência
    const res = this.results.evaluate(r, status, output, steps.length ? { words: this.planWords(steps) } : null);
    if (!res) return;
    if (steps.length) this.closeStep(r, steps, res, output);
    const ho = this.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.handoff' ORDER BY created_at LIMIT 1", r.task_id);
    const ev = ho ? JSON.parse(ho.evidence) as { from: string; to: string; conversationId: string | null; parentTaskId: string | null } : null;
    const me = this.db.get<{ number: number }>('SELECT number FROM tasks WHERE id = ?', r.task_id);
    if (ev?.parentTaskId) {
      // card de ajuda a outro card: o resultado (ou o motivo de não ter vindo) vai para o card de quem pediu
      if (res.state === 'validado') this.helpToParent(ws, r.agent_id, ev as { from: string; to: string; parentTaskId: string }, me?.number ?? null, clip(stripControl(output ?? ''), 1500));
      else audit(this.db, null, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'task.help_not_done', targetType: 'task', targetId: ev.parentTaskId,
        evidence: { from: ev.to, card: me?.number ?? null, state: res.state }, result: `${ev.to} não respondeu ao pedido de ${ev.from} (${res.state})` });
    }
    // card de uma conversa: concluído, quem recebeu o pedido entrega; parado, o agente da conversa repassa o pedido lá
    if (res.state === 'validado') this.purpose.cardDone(ws, r.task_id, ev);
    else this.purpose.relay(ws, r.task_id, res, output, r.agent_id, ev);
  }

  /** Começa o plano do coordenador: o card nasce com as etapas e a primeira já vai para o agente dela. */
  private startPlan(r: RunRow, plan: NonNullable<ReturnType<typeof parsePlan>>): void {
    const ws = r.workspace_id;
    const board = defaultBoard(this.db, ws).id;
    const made = this.purpose.createPlan(r, plan, (x) => createTask(this.db, null, ws, { type: 'agent', id: r.agent_id }, {
      title: x.title, description: x.description, boardId: board, columnId: this.column(board, COLS.todo) ?? undefined, agentId: x.agentId, origin: 'chat',
      dueOn: parseDue(x.purpose || x.title, workspaceTz(this.db, ws)), // "até sexta" no pedido: o card já nasce com o prazo
    }));
    if (!made) return;
    this.bus.publish(ws, 'tasks.changed', { id: made.taskId });
    try { this.work(ws, made.taskId, null); } catch { /* fica em "A fazer": a fila pega quando puder */ }
  }

  /** Palavras que as etapas já feitas entregaram (a conferência do card soma o plano inteiro). */
  private planWords(steps: StepRow[]): number {
    return steps.filter((s) => s.status === 'feita').reduce((n, s) => n + words(stripControl(s.output ?? '')), 0);
  }

  /**
   * Etapa do meio que entregou: guarda a entrega, passa o card ao agente da próxima etapa e já põe para trabalhar.
   * Pergunta ao usuário, pedido de ajuda, falha ou entrega curta demais não passam adiante (false: a conferência decide).
   */
  private advance(r: RunRow, status: RunStatus, output: string | null, steps: StepRow[]): boolean {
    const cur = currentStep(steps);
    if (!cur || status !== 'succeeded' || cur.position === steps[steps.length - 1].position) return false;
    if (/\[\[\s*perguntar\b/i.test(output ?? '') || words(stripControl(output ?? '')) < STEP_MIN_WORDS) return false;
    const next = steps.find((s) => s.position > cur.position && s.status !== 'feita');
    if (!next) return false;
    const ws = r.workspace_id; const taskId = r.task_id!;
    this.db.tx(() => {
      this.db.run("UPDATE task_steps SET status = 'feita', output = ?, run_id = ?, done_at = ? WHERE id = ?", this.db.seal(ws, clip(output ?? '', 20000)), r.id, now(), cur.id);
      this.db.run("UPDATE task_steps SET status = 'em_andamento' WHERE id = ?", next.id);
    });
    const name = (agentId: string) => this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? 'o agente';
    updateTask(this.db, null, ws, { type: 'system', id: 'ergon' }, taskId, { agentId: next.agent_id });
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.step_done', targetType: 'task', targetId: taskId,
      evidence: { runId: r.id, step: cur.position, of: steps.length, output: clip(stripControl(output ?? ''), 1500) },
      result: `${name(r.agent_id)} entregou a etapa ${cur.position} de ${steps.length}; agora é com ${name(next.agent_id)}` });
    try { this.work(ws, taskId, null); }
    catch { this.results.setWorkState(ws, taskId, 'solicitada', `etapa ${next.position} de ${steps.length}: esperando a vez`); }
    return true;
  }

  /** Última etapa (ou a que parou) depois da conferência: guarda o que veio e marca a situação da etapa. */
  private closeStep(r: RunRow, steps: StepRow[], res: ResultRow, output: string | null): void {
    const cur = currentStep(steps);
    if (!cur) return;
    const done = ['validado', 'aguardando_aprovacao', 'sem_confirmacao'].includes(res.state);
    const status = done ? 'feita' : res.state === 'falha' ? 'falhou' : 'em_andamento';
    this.db.run('UPDATE task_steps SET status = ?, output = COALESCE(?, output), run_id = ?, done_at = ? WHERE id = ?',
      status, output ? this.db.seal(r.workspace_id, clip(output, 20000)) : null, r.id, done ? now() : null, cur.id);
  }

  /** A resposta do colega vai para o card de quem pediu, que volta à fila quando não espera mais nenhuma ajuda. */
  private helpToParent(ws: string, agentId: string, ev: { from: string; to: string; parentTaskId: string }, card: number | null, text: string): void {
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: agentId, action: 'task.help_result', targetType: 'task', targetId: ev.parentTaskId,
      evidence: { from: ev.to, card, output: text }, result: `${ev.to} respondeu ao pedido de ${ev.from}` });
    const open = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', ev.parentTaskId);
    if (Number(open?.n)) return;
    this.results.setWorkState(ws, ev.parentTaskId, 'solicitada', 'a ajuda dos colegas chegou'); // volta à fila de quem pediu
    // card de uma conversa (o plano): segue na hora, sem esperar a fila
    if (this.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND conversation_id IS NOT NULL', ev.parentTaskId)) {
      try { this.work(ws, ev.parentTaskId, null); } catch { /* fica na fila */ }
    }
  }

  /**
   * Card aprovado por você (ele não se validou sozinho: esperava confirmação, aprovação ou foi reprovado). Card de
   * ajuda: o card de quem pediu volta à fila com a resposta — antes, aprovado à mão, ficava "em andamento" para sempre.
   * Card de uma conversa: quem recebeu o pedido entrega.
   */
  helpApproved(ws: string, taskId: string): void {
    const ho = this.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.handoff' ORDER BY created_at LIMIT 1", taskId);
    const ev = ho ? JSON.parse(ho.evidence) as { from: string; to: string; conversationId: string | null; parentTaskId: string | null } : null;
    const steps = stepsOf(this.db, taskId);
    const cur = currentStep(steps);
    if (cur) this.db.run("UPDATE task_steps SET status = 'feita', done_at = ? WHERE id = ?", now(), cur.id); // aprovado: o plano está entregue
    if (ev?.parentTaskId) {
      const last = this.db.get<{ agent_id: string; output: string | null }>("SELECT agent_id, output FROM runs WHERE task_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", taskId);
      const me = this.db.get<{ number: number; agent_id: string }>('SELECT number, agent_id FROM tasks WHERE id = ?', taskId);
      this.helpToParent(ws, last?.agent_id ?? me?.agent_id ?? '', ev as { from: string; to: string; parentTaskId: string }, me?.number ?? null,
        clip(stripControl(last?.output ?? '') || 'aprovado por você, sem texto do colega', 1500));
    }
    this.purpose.cardDone(ws, taskId, ev);
  }

  /**
   * A resposta do usuário a um card que espera por ele — na conversa, em "aguardando você" ou no próprio card:
   * responder à pergunta, aprovar, devolver com instrução, tentar de novo ou deixar como está. O que muda o trabalho já
   * o põe para andar, sem esperar a fila. A resposta escrita aparece na conversa de origem como do usuário.
   */
  respond(ws: string, userId: string, taskId: string, action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss', text: string | null): { result: string; runId: string | null } {
    const t = getTask(this.db, ws, taskId);
    const user = { type: 'user' as const, id: userId };
    if (action === 'dismiss') {
      this.purpose.closeRequests(ws, taskId, 'deixado como está', 'rejected');
      return { result: 'O card fica como está.', runId: null };
    }
    let result: string; let runId: string | null = null;
    if (action === 'approve') {
      result = this.results.decide(ws, user, taskId, 'aprovar', null).justification;
      this.helpApproved(ws, taskId);
    } else if (action === 'retry') {
      runId = this.work(ws, taskId, userId);
      result = runId ? 'Posto para trabalhar de novo.' : this.results.latest(ws, taskId)?.justification ?? 'Não deu para pôr para trabalhar agora.';
    } else {
      result = this.results.decide(ws, user, taskId, action === 'answer' ? 'responder' : 'devolver', text).justification;
      try { runId = this.work(ws, taskId, userId); } catch { /* ocupado ou esperando ajuda: a fila retoma */ }
    }
    this.purpose.closeRequests(ws, taskId, result);
    const conv = this.db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM tasks WHERE id = ?', t.id)?.conversation_id;
    if (conv && text && (action === 'answer' || action === 'return')) this.purpose.userSaid(ws, conv, userId, text.trim());
    return { result, runId };
  }

  /**
   * Põe para trabalhar os próximos cards da fila de cada workspace com andamento automático ligado, até encher as vagas
   * de processo (o limite de trabalhos ao mesmo tempo). O resto espera em "A fazer", na ordem da fila.
   */
  tick(): void {
    const wss = this.db.all<{ workspace_id: string }>(
      "SELECT id AS workspace_id FROM workspaces WHERE ws_open(id) AND id NOT IN (SELECT workspace_id FROM workspace_settings WHERE key = 'team.autorun' AND value = '0')");
    for (const { workspace_id: ws } of wss) {
      try { for (let i = 0; i < 8 && this.next(ws); i++) { /* até 8 por passo; o próximo passo continua */ } }
      catch { /* limite diário, etc.: tenta no próximo passo */ }
    }
    this.sweep();
  }

  /**
   * Conversas com algo esperando que ela fique livre — a entrega de um pedido já pronto ou a próxima mensagem da fila
   * (Ctrl+Enter) — mesmo depois de um reinício ou de um limite diário que passou. Independe do andamento automático:
   * foi o usuário quem pediu.
   */
  private sweep(): void {
    if (!this.onIdle) return;
    const convs = this.db.all<{ ws: string; c: string }>(
      `SELECT DISTINCT m.workspace_id AS ws, m.conversation_id AS c FROM messages m WHERE m.queued = 1 AND ws_open(m.workspace_id)
       UNION SELECT DISTINCT t.workspace_id, t.conversation_id FROM tasks t
        WHERE t.conversation_id IS NOT NULL AND t.origin_run_id IS NOT NULL AND t.completed = 1 AND t.archived = 0 AND ws_open(t.workspace_id)
          AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.idempotency_key = '${DELIVERY_KEY}' || t.origin_run_id) LIMIT 50`);
    for (const x of convs) {
      if (this.purpose.busy(x.c)) continue;
      try { this.onIdle(x.ws, x.c); } catch { /* tenta no próximo passo */ }
    }
  }

  next(workspaceId: string): string | null {
    if (!this.autorun(workspaceId)) return null; // desligado: nada anda sozinho
    if (this.executor.processRoom(workspaceId) <= 0) return null; // sem vaga: o card espera em "A fazer"
    const board = defaultBoard(this.db, workspaceId).id;
    const t = this.db.get<{ id: string; number: number; title: string; description: string; agent_id: string; attempts: number }>(
      `SELECT t.id, t.number, t.title, t.description, t.agent_id,
              (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.idempotency_key LIKE 'queue-%') AS attempts
         FROM tasks t JOIN columns c ON c.id = t.column_id JOIN agents a ON a.id = t.agent_id
        WHERE t.workspace_id = ? AND t.board_id = ? AND t.completed = 0 AND t.archived = 0 AND a.status = 'active'
          AND c.name = ? AND t.sync_origin IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.parent_task_id = t.id AND k.completed = 0 AND k.archived = 0)
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
          AND (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.idempotency_key LIKE 'queue-%'
                 AND r.created_at > COALESCE((SELECT MAX(x.decided_at) FROM task_results x WHERE x.task_id = t.id AND x.state = 'devolvido'), '')) < ?
          AND COALESCE(t.work_state, 'solicitada') IN ('solicitada', 'processamento')
        ORDER BY ${QUEUE_ORDER} LIMIT 1`,
      workspaceId, board, COLS.todo, MAX_ATTEMPTS);
    if (!t) return null;
    return this.work(workspaceId, t.id, null);
  }

  /**
   * Põe um card da equipe para trabalhar: pela fila (andamento automático) ou pelo botão "Pôr para trabalhar" (você,
   * mesmo com o andamento automático desligado). Tarefa de dados: o Ergon roda a análise antes; arquivo ausente ou
   * inválido para aqui, sem gastar chamada de modelo. Devolve a execução criada (null = nada a executar agora).
   */
  work(workspaceId: string, taskId: string, userId: string | null): string | null {
    const task = getTask(this.db, workspaceId, taskId);
    const board = this.db.get<{ audience: string }>('SELECT audience FROM boards WHERE id = ?', task.board_id);
    if (board?.audience !== 'team') throw new HttpError(409, 'not_team', 'Só cards do quadro da equipe vão para a fila dos agentes.');
    if (Number(task.completed) || Number(task.archived)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (this.db.get("SELECT 1 AS x FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user')", taskId)) throw new HttpError(409, 'busy', 'O agente já está trabalhando neste card.');
    if (this.db.get('SELECT 1 AS x FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', taskId)) throw new HttpError(409, 'waiting_help', 'Este card espera a ajuda de um colega (veja os cards ligados).');
    const agent = task.agent_id ? this.db.get<{ id: string; name: string; status: string; tools: string | null }>('SELECT id, name, status, tools FROM agents WHERE id = ?', task.agent_id) : undefined;
    if (!agent || agent.status !== 'active') throw new HttpError(409, 'no_agent', 'Este card não tem um responsável ativo.');
    let agentId = agent.id;
    const actor = userId ? { type: 'user' as const, id: userId } : { type: 'system' as const, id: 'ergon' };
    const text = `${task.title} ${task.description}`;
    const csv = this.ops.csvInput(workspaceId, taskId);
    const kind = classifyTask(text, !!csv);
    // pedido que fala de planilha/arquivo, sem arquivo nenhum: pergunta antes de gastar o modelo. Qualquer anexo conta —
    // antes só o CSV contava, e "revisar a proposta anexada" com um PDF ou Word anexado parava aqui
    const anyFile = taskFiles(this.db, workspaceId, taskId).some((f) => f.role === 'entrada');
    if (!anyFile && MENTIONS_FILE.test(fold(text)) && !this.results.pendingInstruction(workspaceId, taskId)) {
      const res = this.results.needInput(workspaceId, taskId, kind, 'O pedido fala de uma planilha ou arquivo, mas nada foi anexado ao card. Anexe o arquivo no card e ponha para trabalhar.', 'aguardando_info', null, actor.id);
      this.purpose.relay(workspaceId, taskId, res, null, agentId); // card de uma conversa: o pedido do arquivo aparece lá
      return null;
    }
    let opNote = '';
    if (kind === 'dados') {
      // a análise é de quem tem a ferramenta: se o responsável não tem, o Ergon passa a quem tem
      const tools = (() => { try { return JSON.parse(agent.tools ?? '[]') as string[]; } catch { return []; } })();
      if (!tools.includes('dados')) {
        const team = activeTeam(this.db, workspaceId);
        const holder = team.find((m) => m.tools.includes('dados') && !m.coordinator) ?? team.find((m) => m.tools.includes('dados'));
        if (!holder) {
          this.results.needInput(workspaceId, taskId, kind, 'Ninguém na equipe tem a ferramenta "Análise de dados". Dê a ferramenta a um agente (Equipe → editar agente) e ponha para trabalhar.', 'reprovado', null, actor.id);
          return null;
        }
        updateTask(this.db, null, workspaceId, { type: 'system', id: 'ergon' }, taskId, { agentId: holder.id });
        audit(this.db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'task.reassign', targetType: 'task', targetId: taskId,
          evidence: { from: agent.name, to: holder.name, reason: 'dados' }, result: `${holder.name} assume: tem a ferramenta Análise de dados` });
        agentId = holder.id;
      }
      this.results.setWorkState(workspaceId, taskId, 'processamento', 'o sistema está analisando o arquivo');
      const op = this.ops.run(workspaceId, { taskId, agentId, op: 'analise-desempenho', referencia: referenceFrom(text) });
      if (op.status === 'erro') {
        this.results.needInput(workspaceId, taskId, kind, `O arquivo não pôde ser analisado: ${op.error} Corrija a planilha, anexe de novo e ponha para trabalhar.`, 'aguardando_info', op.id, actor.id);
        return null;
      }
      opNote = `\nResultado da análise feita pelo sistema (números já calculados):\n${summaryText(op.result ? JSON.parse(op.result) as Record<string, unknown> : null)}\nEntregáveis já gerados e ligados ao card: relatório (Markdown) e indicadores (CSV).`;
    }
    return this.enqueue(workspaceId, { id: task.id, number: Number(task.number), title: task.title, description: task.description }, agentId, kind, opNote, actor);
  }

  /** Cards esperando a vez em "A fazer" (sem execução ativa), na ordem da fila. */
  queue(workspaceId: string): Array<{ id: string; k: number; priority: number }> {
    const board = defaultBoard(this.db, workspaceId).id;
    return this.db.all<{ id: string; k: number; priority: number }>(
      `SELECT t.id, COALESCE(t.queue_pos, t.number) AS k, t.priority FROM tasks t JOIN columns c ON c.id = t.column_id
        WHERE t.workspace_id = ? AND t.board_id = ? AND c.name = ? AND t.completed = 0 AND t.archived = 0
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
        ORDER BY ${QUEUE_ORDER}`, workspaceId, board, COLS.todo);
  }

  /** Onde o card está na fila (null = não está esperando em "A fazer"). */
  queueInfo(workspaceId: string, taskId: string): { position: number; total: number } | null {
    const q = this.queue(workspaceId);
    const i = q.findIndex((x) => x.id === taskId);
    return i < 0 ? null : { position: i + 1, total: q.length };
  }

  /**
   * Você ordena a fila: "Prioridade" marca o card e o leva ao topo (tirar a marca não o move); arrastar o põe antes
   * de outro card (before) ou no fim (before: null); subir e descer trocam com o vizinho (o mesmo, sem arrastar).
   * Os agentes pegam de cima para baixo.
   */
  arrange(workspaceId: string, taskId: string, userId: string, input: { priority?: boolean; before?: string | null; move?: 'up' | 'down' }): { priority: boolean; position: number | null } {
    const task = getTask(this.db, workspaceId, taskId);
    if (task.board_id !== defaultBoard(this.db, workspaceId).id) throw new HttpError(409, 'not_team', 'Só os cards do quadro da equipe têm fila.');
    if (Number(task.completed)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (input.move) {
      const all = this.queue(workspaceId);
      const i = all.findIndex((q) => q.id === taskId);
      if (i < 0) throw new HttpError(409, 'not_queued', 'Este card não está esperando em "A fazer".');
      const before = input.move === 'up' ? (i > 0 ? all[i - 1].id : undefined) : i < all.length - 1 ? all[i + 2]?.id ?? null : undefined;
      input = { priority: input.priority, before }; // undefined: já está na ponta, nada muda
    }
    const rest = this.queue(workspaceId).filter((q) => q.id !== taskId);
    let pos: number | undefined;
    if (input.priority) pos = rest.length ? rest[0].k - 1 : Number(task.number);
    else if (input.before === null) pos = rest.length ? rest[rest.length - 1].k + 1 : Number(task.number);
    else if (input.before) {
      const i = rest.findIndex((q) => q.id === input.before);
      if (i < 0) throw new HttpError(409, 'not_queued', 'O outro card não está esperando em "A fazer".');
      pos = i === 0 ? rest[0].k - 1 : (rest[i - 1].k + rest[i].k) / 2;
    }
    const priority = input.priority ?? Boolean(Number(task.priority));
    this.db.run('UPDATE tasks SET priority = ?, queue_pos = COALESCE(?, queue_pos), updated_at = ? WHERE id = ?', priority ? 1 : 0, pos ?? null, now(), taskId);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'task.queue', targetType: 'task', targetId: taskId,
      evidence: { priority, moved: pos !== undefined }, result: input.priority ? 'prioridade: topo da fila' : input.priority === false ? 'sem prioridade' : 'ordem da fila mudada' });
    this.bus.publish(workspaceId, 'tasks.changed', { id: taskId });
    const at = this.queue(workspaceId).findIndex((q) => q.id === taskId);
    return { priority, position: at < 0 ? null : at + 1 };
  }

  private enqueue(workspaceId: string, t: { id: string; number: number; title: string; description: string }, agentId: string, kind: string, opNote: string,
    actor: { type: 'user' | 'system'; id: string }): string {
    const attempts = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)?.n ?? 0);
    const results = this.db.all<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.help_result' ORDER BY created_at", t.id)
      .map((e) => { try { const v = JSON.parse(e.evidence) as { from: string; output: string }; return `${v.from}: ${v.output}`; } catch { return ''; } }).filter(Boolean);
    const back = this.results.pendingReturn(workspaceId, t.id);
    const files = filesBrief(this.db, this.filesDir, workspaceId, t.id);
    const plan = this.planBrief(workspaceId, t.id);
    const closing = plan && !plan.last ? STEP_CLOSING : CLOSING[kind] ?? CLOSING.informativo;
    const input = [
      `Tarefa #${t.number}: ${t.title}`, plan ? plan.text : t.description,
      files ? `\n${files}` : '',
      results.length ? `\nAjuda que você recebeu dos colegas:\n${results.join('\n\n')}` : '',
      back ? (back.answer ? `\nA pessoa respondeu à sua pergunta: ${back.text}` : `\nA pessoa devolveu o trabalho com esta instrução (atenda antes de entregar): ${back.text}`) : '',
      opNote,
      `\n${closing} Se faltar uma ferramenta ou um conhecimento que um colega tem, peça ajuda (veja suas instruções) em vez de improvisar. Se faltar uma informação essencial que só a pessoa tem, pergunte numa linha [[perguntar pergunta="..."]] em vez de supor.`,
    ].filter(Boolean).join('\n');
    const run = this.executor.enqueue({
      workspaceId, agentId, taskId: t.id, kind: 'subtask', input: clip(input, plan ? 12000 : 6000),
      instructions: instructionsFor(this.db, workspaceId, agentId, 'Canal: quadro da equipe. Responda com o resultado da tarefa.'),
      idempotencyKey: `queue-${t.id}-${attempts + 1}`,
    });
    if (plan) this.db.run("UPDATE task_steps SET status = 'em_andamento', run_id = ? WHERE id = ?", run.id, plan.stepId);
    this.results.setWorkState(workspaceId, t.id, 'processamento', actor.type === 'user' ? 'posta para trabalhar por você' : 'pegou da fila');
    audit(this.db, this.bus, { workspaceId, actorType: actor.type, actorId: actor.id, action: 'task.queue_start', targetType: 'task', targetId: t.id, evidence: { runId: run.id, kind },
      result: actor.type === 'user' ? 'posta para trabalhar (botão)' : 'pegou da fila (andamento automático)' });
    return run.id;
  }

  /**
   * Card com plano: o que a etapa da vez recebe — o pedido do usuário, o plano inteiro (com a sua etapa marcada) e o
   * que as etapas anteriores entregaram. null = card sem etapas.
   */
  private planBrief(workspaceId: string, taskId: string): { text: string; stepId: string; last: boolean } | null {
    const steps = stepsOf(this.db, taskId);
    const cur = currentStep(steps);
    if (!cur) return null;
    const names = new Map(activeTeam(this.db, workspaceId).map((m) => [m.id, m.name]));
    const name = (id: string) => names.get(id) ?? this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', id)?.name ?? 'Agente';
    const purpose = this.db.get<{ purpose: string | null }>('SELECT purpose FROM tasks WHERE id = ?', taskId)?.purpose;
    const done = steps.filter((s) => s.status === 'feita' && s.output);
    const each = done.length ? Math.floor(6000 / done.length) : 0;
    const last = cur.position === steps[steps.length - 1].position;
    const text = [
      purpose ? `Pedido do usuário (o objetivo de todo o plano): “${clip(purpose, 1500)}”` : '',
      `Plano deste card, em ${steps.length} etapa(s):`,
      ...steps.map((s) => `${s.position}. ${name(s.agent_id)} — ${s.title}${s.id === cur.id ? '   ← a sua etapa' : s.status === 'feita' ? ' (feita)' : ''}`),
      done.length ? `\nO que as etapas anteriores entregaram:\n${done.map((s) => `[${s.position}. ${name(s.agent_id)}]\n${clip(stripControl(s.output ?? ''), each)}`).join('\n\n')}` : '',
      `\nSua etapa (${cur.position} de ${steps.length}): ${cur.title}. Faça só a sua etapa${last ? '; ela é a última antes da entrega ao usuário, que a coordenação faz na conversa.' : ' e entregue o resultado completo dela: a próxima etapa continua a partir do que você entregar.'}`,
    ].filter(Boolean).join('\n');
    return { text, stepId: cur.id, last };
  }
}
