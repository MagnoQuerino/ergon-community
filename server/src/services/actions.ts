import type { Db } from '../db/db.ts';
import { clip, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import type { Decision } from './interpret.ts';
import { createTask, getTaskByNumber, proposeSimilarLinks, updateTask, type Actor, type TaskOrigin } from './tasks.ts';
import { activeTeam, coordinatorOf, routeTo } from './team.ts';
import { parseDue } from './due.ts';
import { workspaceTz } from './routine-proposals.ts';

/**
 * Responsável por uma demanda nova: quem recebeu o pedido fica com ele; o que chega a quem coordena (ou de
 * Teams/WhatsApp) é encaminhado ao especialista pelas palavras do pedido comparadas com o papel e os métodos de cada
 * agente hoje — sem modelo, e sem depender de nomes (a equipe pode ter sido renomeada ou trocada).
 */
function assignResponsible(db: Db, workspaceId: string, receiverId: string | null, text: string): { agentId: string; note: string; evidence: Record<string, unknown> } | null {
  const team = activeTeam(db, workspaceId);
  if (!team.length) return null;
  const coord = coordinatorOf(team);
  const receiver = receiverId ? team.find((a) => a.id === receiverId) : undefined;
  if (receiver && receiver.id !== coord?.id) return { agentId: receiver.id, note: `Responsável: ${receiver.name}.`, evidence: { by: 'receiver', to: receiver.name } };
  const route = routeTo(team, text);
  if (route) {
    const who = coord ? `${coord.name} encaminhou` : 'Encaminhada';
    return { agentId: route.member.id, note: `${who} para ${route.member.name} (palavras: ${route.words.join(', ')}).`, evidence: { by: 'rules', to: route.member.name, words: route.words } };
  }
  if (coord) return { agentId: coord.id, note: `${coord.name} fica com a triagem (nenhuma regra de encaminhamento casou).`, evidence: { by: 'fallback', to: coord.name } };
  return null;
}

/** Card novo no quadro da equipe a partir de uma tarefa do usuário ("Enviar à equipe"), encaminhado pela coordenação. */
export function routeTeamTask(db: Db, bus: Bus, workspaceId: string, actor: Actor, input: { title: string; description: string; parentTaskId: string; dueOn?: string | null }) {
  const resp = assignResponsible(db, workspaceId, null, `${input.title} ${input.description}`);
  const t = createTask(db, null, workspaceId, actor, {
    title: input.title, description: input.description ? `${input.description}\n\n(Enviada das suas tarefas.)` : 'Enviada das suas tarefas.',
    origin: 'manual', agentId: resp?.agentId ?? null, dueOn: input.dueOn ?? null,
  });
  db.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', input.parentTaskId, t.id);
  if (resp) audit(db, null, { workspaceId, actorType: 'system', action: 'task.route', targetType: 'task', targetId: t.id, evidence: resp.evidence, result: resp.note });
  bus.publish(workspaceId, 'tasks.changed', { id: t.id });
  return { id: t.id, number: Number(t.number), routed: resp?.note ?? null };
}

export interface ActionResult {
  summary: string;
  taskId: string | null;
  taskNumber: number | null;
  /** texto curto para responder a quem pediu (comandos de canal) */
  reply: string | null;
}

/**
 * Aplica uma decisão já validada pela política. Único caminho de escrita a partir de mensagens:
 * nem o interpretador nem o modelo escrevem no banco.
 */
export function applyDecision(db: Db, bus: Bus, workspaceId: string, actor: Actor, d: Decision,
  ctx: { origin: TaskOrigin; sourceEventId?: string | null; isFixture?: boolean; messageId?: string | null; agentId?: string | null }): ActionResult {
  switch (d.kind) {
    case 'create_task': {
      const resp = assignResponsible(db, workspaceId, ctx.agentId ?? null, d.title);
      const t = createTask(db, null, workspaceId, actor, {
        title: d.title, description: ctx.sourceEventId ? 'Criada a partir de evento de origem registrado no log.' : 'Criada a partir do chat Ergon.',
        origin: ctx.origin, sourceEventId: ctx.sourceEventId ?? null, isFixture: ctx.isFixture, agentId: resp?.agentId ?? null,
        // "até sexta", "até 30/10"…: o card já nasce com o prazo
        dueOn: parseDue(d.title, workspaceTz(db, workspaceId)),
      });
      if (resp) audit(db, null, { workspaceId, actorType: 'system', action: 'task.route', targetType: 'task', targetId: t.id, evidence: resp.evidence, result: resp.note });
      const similar = proposeSimilarLinks(db, workspaceId, t);
      bus.publish(workspaceId, 'tasks.changed', { id: t.id });
      const extra = similar ? ` Possível duplicata de ${similar} tarefa(s): vínculo proposto, não fundido.` : '';
      const routed = resp ? ` ${resp.note}` : '';
      return { summary: `Tarefa #${t.number} criada: ${t.title}.${routed}${extra}`, taskId: t.id, taskNumber: Number(t.number), reply: `Tarefa #${t.number} criada: ${t.title}.${routed}` };
    }
    case 'update_task': {
      const t = getTaskByNumber(db, workspaceId, d.number);
      if (!t) return { summary: `Tarefa #${d.number} não encontrada.`, taskId: null, taskNumber: null, reply: `Não encontrei a tarefa #${d.number}.` };
      updateTask(db, bus, workspaceId, actor, t.id, { title: d.title });
      return { summary: `Card #${d.number} corrigido (só este card; nenhuma regra futura criada).`, taskId: t.id, taskNumber: d.number, reply: `Tarefa #${d.number} atualizada.` };
    }
    case 'complete_task': {
      const t = getTaskByNumber(db, workspaceId, d.number);
      if (!t) return { summary: `Tarefa #${d.number} não encontrada.`, taskId: null, taskNumber: null, reply: null };
      if (d.requiresConfirmation) {
        audit(db, bus, {
          workspaceId, actorType: actor.type, actorId: actor.id, action: 'task.completion_reported', targetType: 'task', targetId: t.id,
          evidence: { sourceEventId: ctx.sourceEventId ?? null }, result: 'aguarda confirmação humana',
        });
        return { summary: `Conclusão de #${d.number} informada; aguarda confirmação humana.`, taskId: t.id, taskNumber: d.number, reply: null };
      }
      updateTask(db, bus, workspaceId, actor, t.id, { completed: true });
      return { summary: `Tarefa #${d.number} marcada como concluída.`, taskId: t.id, taskNumber: d.number, reply: `Tarefa #${d.number} concluída.` };
    }
    case 'list_pending': {
      const open = db.all<{ number: number; title: string }>(
        'SELECT number, title FROM tasks WHERE workspace_id = ? AND completed = 0 AND archived = 0 ORDER BY number LIMIT 15', workspaceId);
      const reply = open.length ? `Pendências (${open.length}):\n` + open.map((t) => `#${t.number} ${clip(t.title, 80)}`).join('\n') : 'Sem pendências abertas.';
      return { summary: `Consulta de pendências (${open.length}).`, taskId: null, taskNumber: null, reply };
    }
    case 'propose_rule': {
      const ruleId = id('rul');
      db.run("INSERT INTO rules (id, workspace_id, text, status, origin_message_id, created_at) VALUES (?, ?, ?, 'proposed', ?, ?)",
        ruleId, workspaceId, db.seal(workspaceId, d.text), ctx.messageId ?? null, now());
      audit(db, bus, { workspaceId, actorType: actor.type, actorId: actor.id, action: 'rule.propose', targetType: 'rule', targetId: ruleId, evidence: { text: clip(d.text, 200) }, result: 'proposta' });
      bus.publish(workspaceId, 'rules.changed', { id: ruleId });
      return { summary: 'Regra futura PROPOSTA (não altera cards existentes; precisa de confirmação em Atividade › Regras).', taskId: null, taskNumber: null, reply: 'Regra proposta; aguarda confirmação no Ergon.' };
    }
    case 'clarify':
      return { summary: `Sem ação automática: ${d.reason}. Para registrar, use "/tarefa <título>".`, taskId: null, taskNumber: null, reply: null };
    case 'none':
    default:
      return { summary: `Sem ação: ${d.reason}.`, taskId: null, taskNumber: null, reply: null };
  }
}
