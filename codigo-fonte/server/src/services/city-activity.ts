/**
 * Atividade real para a cidade (Cidade Viva; na tela: treino no Ginásio, revisor na mesa do autor, entrega no Teatro): as etiquetas discretas junto dos agentes ("#92") saem só do que está
 * gravado — execuções em andamento, revisões abertas, tarefas esperando aprovação ou informação e treinos em
 * execução. Nada é inventado nem animado por conta própria: sem registro, sem etiqueta; mudou o estado, a etiqueta muda
 * ou some na próxima leitura (os mesmos eventos que já avisam a tela: runs/tasks/agents.changed).
 *
 * Uma etiqueta por atividade (a revisão de dois agentes é uma só, no autor). Só do workspace pedido; sem título nem
 * conteúdo da tarefa (o texto curto diz o que acontece e o número; o card abre com as permissões de sempre).
 */
import type { Db } from '../db/db.ts';

export type ActivityKind = 'executando' | 'na_fila' | 'aguardando_voce' | 'revisando' | 'aguardando_aprovacao' | 'aguardando_info' | 'treinando';

export interface ActivityTag {
  kind: ActivityKind;
  /** agentes envolvidos; `lead` leva a etiqueta (os demais ficam ligados a ela, sem repetir) */
  agents: string[];
  lead: string;
  /** a tarefa (null no treino) e o número dela */
  taskId: string | null;
  number: number | null;
  /** texto da etiqueta e do passar o cursor */
  label: string;
  title: string;
  /** para onde o clique leva (o card no quadro dele); null = abre o agente */
  href: string | null;
}

/** teto por leitura (a cidade mostra as do que está na tela; mais que isso seria ruído) */
export const ACTIVITY_LIMIT = 800;

const TITLES: Record<ActivityKind, (n: number | null) => string> = {
  executando: (n) => `Trabalhando na tarefa #${n}`,
  na_fila: (n) => `Na fila para a tarefa #${n}`,
  aguardando_voce: (n) => `Esperando você na tarefa #${n}`,
  revisando: (n) => `Revisando a tarefa #${n}`,
  aguardando_aprovacao: (n) => `Apresentando a entrega da tarefa #${n}: esperando a sua aprovação`,
  aguardando_info: (n) => `Tarefa #${n} esperando uma informação`,
  treinando: () => 'Treinando uma competência',
};

const hrefOf = (t: { id: string; board_id: string; audience: string }) =>
  t.audience === 'team' ? `#equipe?card=${t.id}` : `#tarefas?board=${t.board_id}&card=${t.id}`;

export function cityActivity(db: Db, workspaceId: string): ActivityTag[] {
  const out: ActivityTag[] = [];
  const busy = new Set<string>();
  const push = (t: ActivityTag) => { if (out.length < ACTIVITY_LIMIT) { out.push(t); for (const a of t.agents) busy.add(a); } };

  // revisões abertas com execução em andamento: autor e revisor juntos, uma etiqueta só
  const reviews = db.all<{ id: string; task_id: string; reviewer_id: string; producer_id: string; number: number; board_id: string; audience: string }>(
    `SELECT DISTINCT r.id, r.task_id, r.reviewer_id, r.producer_id, t.number, t.board_id, b.audience
       FROM reviews r JOIN runs x ON x.review_id = r.id AND x.workspace_id = r.workspace_id AND x.status IN ('queued', 'running', 'waiting_user')
       JOIN tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id JOIN boards b ON b.id = t.board_id
      WHERE r.workspace_id = ? AND r.status = 'open'`, workspaceId);
  for (const r of reviews) {
    push({ kind: 'revisando', agents: [r.producer_id, r.reviewer_id], lead: r.producer_id, taskId: r.task_id, number: r.number,
      label: `#${r.number}`, title: TITLES.revisando(r.number), href: hrefOf({ id: r.task_id, board_id: r.board_id, audience: r.audience }) });
  }

  // execuções em andamento ligadas a uma tarefa (fora das revisões): a mais avançada de cada agente
  const runs = db.all<{ agent_id: string; status: string; task_id: string; number: number; board_id: string; audience: string }>(
    `SELECT x.agent_id, x.status, x.task_id, t.number, t.board_id, b.audience
       FROM runs x JOIN tasks t ON t.id = x.task_id AND t.workspace_id = x.workspace_id JOIN boards b ON b.id = t.board_id
      WHERE x.workspace_id = ? AND x.status IN ('queued', 'running', 'waiting_user') AND x.review_id IS NULL
      ORDER BY CASE x.status WHEN 'running' THEN 0 WHEN 'waiting_user' THEN 1 ELSE 2 END, x.created_at`, workspaceId);
  for (const x of runs) {
    if (busy.has(x.agent_id)) continue;
    const kind: ActivityKind = x.status === 'running' ? 'executando' : x.status === 'waiting_user' ? 'aguardando_voce' : 'na_fila';
    push({ kind, agents: [x.agent_id], lead: x.agent_id, taskId: x.task_id, number: x.number, label: `#${x.number}`, title: TITLES[kind](x.number),
      href: hrefOf({ id: x.task_id, board_id: x.board_id, audience: x.audience }) });
  }

  // tarefas paradas esperando você (aprovação) ou uma informação, com o agente responsável
  const waits = db.all<{ id: string; agent_id: string; work_state: string; number: number; board_id: string; audience: string }>(
    `SELECT t.id, t.agent_id, t.work_state, t.number, t.board_id, b.audience FROM tasks t JOIN boards b ON b.id = t.board_id
      WHERE t.workspace_id = ? AND t.agent_id IS NOT NULL AND t.archived = 0 AND t.completed = 0
        AND t.work_state IN ('aguardando_aprovacao', 'aguardando_info') ORDER BY t.updated_at DESC`, workspaceId);
  for (const t of waits) {
    if (busy.has(t.agent_id)) continue;
    const kind = t.work_state as 'aguardando_aprovacao' | 'aguardando_info';
    push({ kind, agents: [t.agent_id], lead: t.agent_id, taskId: t.id, number: t.number, label: `#${t.number}`, title: TITLES[kind](t.number),
      href: hrefOf({ id: t.id, board_id: t.board_id, audience: t.audience }) });
  }

  // treinos em execução (Treinar): o agente vai ao Ginásio; o clique abre o agente
  const trains = db.all<{ agent_id: string }>(`SELECT DISTINCT agent_id FROM trainings WHERE workspace_id = ? AND status = 'executando'`, workspaceId);
  for (const t of trains) {
    if (busy.has(t.agent_id)) continue; // já aparece por uma tarefa
    push({ kind: 'treinando', agents: [t.agent_id], lead: t.agent_id, taskId: null, number: null, label: 'treino', title: TITLES.treinando(null), href: null });
  }
  return out;
}
