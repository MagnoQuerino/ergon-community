/**
 * Ambiente operacional (docs/AMBIENTE_OPERACIONAL_PROGRESSO.md): uma LEITURA do trabalho da equipe para a cidade.
 * Não é outra fila, não guarda nada e não muda nada — classifica os mesmos cards e execuções que o quadro, o
 * agendador (teamwork.next) e o executor usam, com as mesmas regras:
 *
 * - vagas locais ocupadas = runningProcesses (processos em execução; conversa e "aguarda você" não ocupam vaga);
 * - "pronto" = exatamente o que o agendador pega (ELIGIBLE_SQL), na ordem dele (QUEUE_ORDER);
 * - bloqueio só por relação gravada (ajuda pedida a um colega, card pai/filho), nunca por palavras do título;
 * - "precisa de você" = os mesmos estados de "Aguardando você" (proposals.pendingDecisions);
 * - entrega = card da equipe concluído pelo contrato de resultado (ou por você), nunca "o modelo terminou".
 *
 * Cada item tem UMA categoria (para contar sem duplicar); a ordem e as ações são as que existem nos painéis atuais.
 * Nenhum modelo é chamado, nenhum conteúdo de conversa vai para cá, e execução ligada à conversa de outra pessoa
 * aparece só como contagem, sem título.
 */
import type { Db } from '../db/db.ts';
import { PROCESS_SQL, isConversationKey, runningProcesses, type ProcessLimit } from './concurrency.ts';
import { pendingCount } from './proposals.ts';
import { defaultBoard } from './tasks.ts';
import { ELIGIBLE_SQL, MAX_ATTEMPTS, QUEUE_ORDER, TODO_COLUMN } from './teamwork.ts';
import { agentsLite, type AgentLite } from './team-query.ts';

export const AMBIENT_VERSION = 1;
export const CATEGORIES = ['ativo', 'pronto', 'bloqueado', 'precisa_de_voce', 'impedido', 'falhou'] as const;
export type Category = typeof CATEGORIES[number];
/** ações que os painéis atuais já fazem (a interface só leva até eles; o servidor valida de novo) */
export type Action = 'abrir' | 'priorizar' | 'responder' | 'parar' | 'cancelar' | 'conversa';

export interface OpsItem {
  /** chave estável: origem e id (o mesmo card não vira dois itens por ter execução, etapa ou revisão) */
  key: string;
  source: 'task' | 'run';
  taskId: string | null; number: number | null; runId: string | null;
  title: string;
  agentId: string | null; agentName: string | null;
  /** o agente do item (retrato), sem a lista da equipe na tela; só nos itens da página */
  agent: AgentLite | null;
  category: Category;
  /** motivo em linguagem do Ergon, com código para teste e para a cena */
  reason: string; reasonCode: string;
  /** posição na fila do agendador (só para "pronto" que a fila automática pega); null fora dela */
  position: number | null;
  /** ocupa vaga de processo agora (a mesma regra de runningProcesses) */
  slot: boolean;
  /** desde quando está nesse estado (início da execução ou última mudança do card) */
  since: string | null;
  priority: boolean;
  simulated: boolean;
  /** de que depende (cards de ajuda abertos), quando há relação gravada */
  dependsOn: Array<{ taskId: string; number: number; agentName: string | null }>;
  actions: Action[];
}
export interface Delivery {
  taskId: string; number: number; title: string; agentName: string | null; completedAt: string;
  by: 'agent' | 'human' | 'external'; resultState: string | null; kind: string | null; deliverables: number; simulated: boolean;
}
export interface AmbientOps {
  version: number; at: string; workspaceId: string;
  local: {
    limit: number | null; choice: ProcessLimit['choice']; cap: number | null;
    /** processos ocupando vaga agora (runningProcesses) */
    busy: number;
    /** processos já admitidos pela fila e esperando o executor abrir vaga */
    waitingExecutor: number;
    /** conversas acontecendo agora (não ocupam vaga) */
    conversations: number;
    autorun: boolean; mode: 'real' | 'simulated';
  };
  totals: Record<Category, number>;
  items: Record<Category, OpsItem[]>;
  /** quantos ficaram fora da página de cada categoria */
  more: Record<Category, number>;
  decisions: { total: number };
  deliveries: { total: number; days: number; items: Delivery[] };
}

const WAITING_REASON: Record<string, [string, string]> = {
  aguardando_info: ['info', 'Precisa de uma informação sua'],
  aguardando_aprovacao: ['aprovacao', 'Espera a sua aprovação'],
  revisao: ['revisao', 'Revisão necessária: veja o resultado e decida'],
};
const KEY_KIND: Array<[string, string]> = [['routine-', 'Rotina'], ['review-', 'Revisão'], ['recommend-', 'Análise semanal de rotinas'], ['delegate-', 'Pedido delegado']];
const DELIVERY_DAYS = 7;
const PAGE = 20;

interface TaskRow {
  id: string; number: number; title: string; agent_id: string | null; agent_name: string | null; agent_status: string | null;
  column_name: string; work_state: string | null; sync_origin: string | null; priority: number; updated_at: string;
  run_id: string | null; run_status: string | null; run_key: string | null; run_started: string | null; run_created: string | null; run_mode: string | null;
  attempts: number; last_status: string | null;
}

function emptyBy<T>(f: () => T): Record<Category, T> { return Object.fromEntries(CATEGORIES.map((c) => [c, f()])) as Record<Category, T>; }

/**
 * Lê o trabalho do workspace. Tudo numa passada síncrona da mesma conexão: contadores e itens vêm do mesmo instante.
 * `viewer`: quem pede (execução ligada à conversa de outra pessoa não mostra título). `page`: para ver além dos 20 de
 * uma categoria (offset e limite), sem mudar os totais.
 */
export function readAmbient(db: Db, input: {
  workspaceId: string; viewer: string; limit: ProcessLimit; autorun: boolean; mode: 'real' | 'simulated';
  page?: { category: Category; offset: number; limit: number };
}): AmbientOps {
  const ws = input.workspaceId;
  const board = defaultBoard(db, ws).id;
  const at = new Date().toISOString();

  // cards abertos do quadro da equipe, com a execução ativa (a mais antiga, como o quadro mostra) e as tentativas
  const tasks = db.all<TaskRow>(
    `SELECT t.id, t.number, t.title, t.agent_id, a.name AS agent_name, a.status AS agent_status, c.name AS column_name, t.work_state,
            t.sync_origin, t.priority, t.updated_at,
            r.id AS run_id, r.status AS run_status, r.idempotency_key AS run_key, r.started_at AS run_started, r.created_at AS run_created, r.mode AS run_mode,
            (SELECT COUNT(*) FROM runs q WHERE q.task_id = t.id AND q.idempotency_key LIKE 'queue-%'
               AND q.created_at > COALESCE((SELECT MAX(x.decided_at) FROM task_results x WHERE x.task_id = t.id AND x.state = 'devolvido'), '')) AS attempts,
            (SELECT z.status FROM runs z WHERE z.task_id = t.id ORDER BY z.created_at DESC, z.id DESC LIMIT 1) AS last_status
       FROM tasks t JOIN columns c ON c.id = t.column_id LEFT JOIN agents a ON a.id = t.agent_id
       LEFT JOIN runs r ON r.id = (SELECT y.id FROM runs y WHERE y.task_id = t.id AND y.status IN ('queued', 'running', 'waiting_user') ORDER BY y.created_at, y.id LIMIT 1)
      WHERE t.workspace_id = ? AND t.board_id = ? AND t.completed = 0 AND t.archived = 0
      ORDER BY ${QUEUE_ORDER}`, ws, board);
  // a ordem real do agendador: só quem ele pegaria
  const eligible = db.all<{ id: string }>(
    `SELECT t.id FROM tasks t JOIN columns c ON c.id = t.column_id JOIN agents a ON a.id = t.agent_id
      WHERE t.workspace_id = ? AND ${ELIGIBLE_SQL} ORDER BY ${QUEUE_ORDER}`, ws, board, TODO_COLUMN, MAX_ATTEMPTS);
  const position = new Map(eligible.map((x, i) => [x.id, i + 1]));
  // ajudas abertas (relação gravada pai → filho)
  const deps = new Map<string, OpsItem['dependsOn']>();
  for (const k of db.all<{ parent: string; id: string; number: number; agent_name: string | null }>(
    `SELECT k.parent_task_id AS parent, k.id, k.number, a.name AS agent_name FROM tasks k LEFT JOIN agents a ON a.id = k.agent_id
      WHERE k.workspace_id = ? AND k.parent_task_id IS NOT NULL AND k.completed = 0 AND k.archived = 0 ORDER BY k.number`, ws)) {
    deps.set(k.parent, [...(deps.get(k.parent) ?? []), { taskId: k.id, number: Number(k.number), agentName: k.agent_name }]);
  }
  const busy = runningProcesses(db, ws);
  const room = input.limit.limit === null ? Infinity : input.limit.limit - Number(db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status IN ('queued', 'running') AND ${PROCESS_SQL}`, ws)?.n ?? 0);

  const all: OpsItem[] = [];
  const base = (t: TaskRow): Omit<OpsItem, 'category' | 'reason' | 'reasonCode' | 'actions' | 'slot' | 'since' | 'position'> => ({
    key: `task:${t.id}`, source: 'task', taskId: t.id, number: Number(t.number), runId: t.run_id, title: t.title,
    agentId: t.agent_id, agentName: t.agent_name, agent: null, priority: Number(t.priority) === 1, simulated: t.run_mode === 'simulated',
    dependsOn: deps.get(t.id) ?? [],
  });
  for (const t of tasks) {
    const b = base(t);
    const push = (category: Category, reasonCode: string, reason: string, actions: Action[], extra: Partial<OpsItem> = {}) =>
      all.push({ ...b, category, reasonCode, reason, actions: ['abrir', ...actions], slot: false, since: t.updated_at, position: null, ...extra });
    if (t.run_status === 'running') {
      const proc = !isConversationKey(t.run_key ?? '');
      push('ativo', proc ? 'trabalhando' : 'entregando', proc ? `${t.agent_name ?? 'O agente'} está trabalhando` : `${t.agent_name ?? 'O agente'} está entregando na conversa`,
        ['parar', 'cancelar'], { slot: proc, since: t.run_started ?? t.run_created });
      continue;
    }
    if (t.run_status === 'queued') {
      push('pronto', 'executor', 'Já na vez: começa assim que abrir uma vaga', ['parar', 'cancelar'], { since: t.run_created });
      continue;
    }
    if (t.run_status === 'waiting_user') { push('precisa_de_voce', 'resposta', 'Espera a sua resposta', ['responder', 'cancelar'], { since: t.run_started ?? t.run_created }); continue; }
    const st = t.work_state ?? 'solicitada';
    if (WAITING_REASON[st]) { const [code, text] = WAITING_REASON[st]; push('precisa_de_voce', code, text, ['responder', 'cancelar']); continue; }
    // parar (o botão do card) grava o card como falha; aqui ele aparece como parado, que é o que aconteceu
    if (st === 'falha' && t.last_status === 'cancelled') { push('impedido', 'parado', 'Parado: dá para tentar de novo no card', ['cancelar']); continue; }
    if (st === 'falha') { push('falhou', 'falha', 'Falhou: o motivo está no card', ['cancelar']); continue; }
    if (st === 'resultado' || st === 'validacao') { push('ativo', 'conferindo', 'O resultado está sendo conferido', []); continue; }
    if (b.dependsOn.length) {
      const d = b.dependsOn[0];
      push('bloqueado', 'ajuda', `Aguarda a ajuda #${d.number}${d.agentName ? ` (${d.agentName})` : ''}${b.dependsOn.length > 1 ? ` e mais ${b.dependsOn.length - 1}` : ''}`, ['cancelar']);
      continue;
    }
    if (!t.agent_id || t.agent_status !== 'active') { push('impedido', 'sem_responsavel', 'Sem responsável ativo: escolha alguém no card', ['cancelar']); continue; }
    if (t.sync_origin) { push('impedido', 'espelhado', 'Veio de outro aplicativo: a equipe não pega sozinha', ['cancelar']); continue; }
    if (t.column_name !== TODO_COLUMN) { push('impedido', 'fora_da_fila', `Em "${t.column_name}" sem ninguém trabalhando: ponha para trabalhar no card`, ['cancelar']); continue; }
    if (Number(t.attempts) >= MAX_ATTEMPTS) { push('falhou', 'tentativas', 'Tentativas esgotadas: ponha para trabalhar de novo no card', ['cancelar']); continue; }
    const pos = position.get(t.id) ?? null;
    if (pos === null) { push('impedido', 'desconhecido', 'Não entra na fila agora: veja o card', ['cancelar']); continue; }
    if (!input.autorun) push('pronto', 'autorun', 'Pronto; andamento automático desligado', ['priorizar', 'cancelar'], { position: pos });
    else if (room > 0 && pos <= room) push('pronto', 'comecando', 'Pronto: começa no próximo passo da equipe', ['priorizar', 'cancelar'], { position: pos });
    // a ordem de quem começa (só os que a fila pega): no quadro, a posição conta também quem espera ajuda
    else push('pronto', 'vaga', pos === 1 ? 'Pronto: é o próximo a começar quando abrir uma vaga' : `Pronto: ${pos}º a começar quando abrir uma vaga`, ['priorizar', 'cancelar'], { position: pos });
  }

  // processos sem card (rotinas, revisões, análises): ocupam vaga como qualquer processo
  const taskRuns = new Set(tasks.map((t) => t.run_id).filter(Boolean));
  for (const r of db.all<{ id: string; status: string; idempotency_key: string; agent_id: string; agent_name: string; started_at: string | null; created_at: string; mode: string; conversation_id: string | null; owner: string | null; task_id: string | null; routine_name: string | null }>(
    `SELECT r.id, r.status, r.idempotency_key, r.agent_id, a.name AS agent_name, r.started_at, r.created_at, r.mode, r.conversation_id, c.owner_user_id AS owner, r.task_id,
            (SELECT o.name FROM routine_runs rr JOIN routines o ON o.id = rr.routine_id WHERE 'routine-' || rr.id = r.idempotency_key) AS routine_name
       FROM runs r JOIN agents a ON a.id = r.agent_id LEFT JOIN conversations c ON c.id = r.conversation_id
      WHERE r.workspace_id = ? AND r.status IN ('queued', 'running', 'waiting_user') AND ${PROCESS_SQL} ORDER BY r.created_at, r.id`, ws)) {
    if (taskRuns.has(r.id)) continue;
    if (r.task_id && tasks.some((t) => t.id === r.task_id)) continue; // segunda execução do mesmo card: o card já está na lista
    const mine = !r.conversation_id || r.owner === input.viewer;
    const kind = KEY_KIND.find(([p]) => r.idempotency_key.startsWith(p))?.[1] ?? 'Processo';
    const title = !mine ? 'Trabalho de outra pessoa do workspace' : r.routine_name ? `${kind}: ${r.routine_name}` : kind;
    const category: Category = r.status === 'running' ? 'ativo' : r.status === 'queued' ? 'pronto' : 'precisa_de_voce';
    all.push({
      key: `run:${r.id}`, source: 'run', taskId: null, number: null, runId: r.id, title, agentId: r.agent_id, agentName: r.agent_name, agent: null,
      category, reasonCode: r.status === 'running' ? 'trabalhando' : r.status === 'queued' ? 'executor' : 'resposta',
      reason: r.status === 'running' ? `${r.agent_name} está trabalhando` : r.status === 'queued' ? 'Já na vez: começa assim que abrir uma vaga' : 'Espera a sua resposta',
      position: null, slot: r.status === 'running', since: r.started_at ?? r.created_at, priority: false, simulated: r.mode === 'simulated', dependsOn: [],
      actions: mine && r.conversation_id ? ['conversa'] : [],
    });
  }

  const totals = emptyBy(() => 0); const items = emptyBy<OpsItem[]>(() => []); const more = emptyBy(() => 0);
  const byCat = emptyBy<OpsItem[]>(() => []);
  for (const it of all) byCat[it.category].push(it);
  // na fila: na ordem do agendador; o resto, o mais antigo primeiro (quem espera há mais tempo aparece antes)
  byCat.pronto.sort((x, y) => (x.position ?? -1) - (y.position ?? -1));
  for (const c of CATEGORIES) {
    const list = byCat[c];
    totals[c] = list.length;
    const pg = input.page?.category === c ? input.page : { offset: 0, limit: PAGE };
    items[c] = list.slice(pg.offset, pg.offset + pg.limit);
    more[c] = Math.max(0, list.length - pg.offset - items[c].length);
  }
  // o retrato de quem aparece na página (uma consulta só; desativado também tem nome e cor)
  const lite = agentsLite(db, ws, CATEGORIES.flatMap((c) => items[c].map((it) => it.agentId)));
  for (const c of CATEGORIES) for (const it of items[c]) it.agent = (it.agentId && lite.get(it.agentId)) || null;

  const since = new Date(Date.now() - DELIVERY_DAYS * 86_400_000).toISOString();
  const deliveries = db.all<{ id: string; number: number; title: string; agent_name: string | null; completed_at: string; completed_by: string | null; state: string | null; kind: string | null; deliverables: number; mode: string | null }>(
    `SELECT t.id, t.number, t.title, a.name AS agent_name, t.completed_at, t.completed_by, x.state, x.kind,
            (SELECT COUNT(*) FROM task_artifacts f WHERE f.task_id = t.id AND f.role = 'entregavel') AS deliverables,
            (SELECT r.mode FROM runs r WHERE r.task_id = t.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS mode
       FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
       LEFT JOIN task_results x ON x.id = (SELECT y.id FROM task_results y WHERE y.task_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)
      WHERE t.workspace_id = ? AND t.board_id = ? AND t.completed = 1 AND t.archived = 0 AND t.completed_at >= ?
      ORDER BY t.completed_at DESC, t.number DESC LIMIT 8`, ws, board, since);
  const deliveryTotal = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND board_id = ? AND completed = 1 AND archived = 0 AND completed_at >= ?', ws, board, since)?.n ?? 0);
  const conversations = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'running' AND NOT (${PROCESS_SQL})`, ws)?.n ?? 0);
  const waitingExecutor = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'queued' AND ${PROCESS_SQL}`, ws)?.n ?? 0);

  return {
    version: AMBIENT_VERSION, at, workspaceId: ws,
    local: { limit: input.limit.limit, choice: input.limit.choice, cap: input.limit.cap, busy, waitingExecutor, conversations, autorun: input.autorun, mode: input.mode },
    totals, items, more,
    decisions: { total: pendingCount(db, ws) },
    deliveries: {
      total: deliveryTotal, days: DELIVERY_DAYS,
      items: deliveries.map((d) => ({
        taskId: d.id, number: Number(d.number), title: d.title, agentName: d.agent_name, completedAt: d.completed_at,
        by: d.completed_by === 'human' ? 'human' : d.completed_by === 'external' ? 'external' : 'agent',
        resultState: d.state, kind: d.kind, deliverables: Number(d.deliverables), simulated: d.mode === 'simulated',
      })),
    },
  };
}
