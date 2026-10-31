import type { Db } from '../db/db.ts';
import { HttpError, fold, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting, setSetting } from './sectors.ts';
import { validDue } from './due.ts';

export type TaskOrigin = 'manual' | 'chat' | 'teams' | 'whatsapp' | 'mirror' | 'demo';

export interface TaskRow {
  id: string; number: number; workspace_id: string; board_id: string; column_id: string; agent_id: string | null;
  title: string; description: string; completed: number; completed_at: string | null; completed_by: string | null;
  /** fila da equipe: marcado como prioridade; posição dada por você (null = ordem de chegada) */
  priority: number; queue_pos: number | null;
  origin: TaskOrigin; source_event_id: string | null; is_fixture: number; revision: number; archived: number;
  created_at: string; updated_at: string;
  /** prazo (AAAA-MM-DD) ou null */
  due_on: string | null;
  /** estado real do trabalho (cards da equipe; ver results.ts) */
  work_state: string | null; requires_approval: number;
}

export interface Actor { type: 'user' | 'agent' | 'system' | 'connector'; id: string | null }

export function getTask(db: Db, workspaceId: string, taskId: string): TaskRow {
  const t = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
  if (!t) throw notFound('tarefa');
  return t;
}

export function getTaskByNumber(db: Db, workspaceId: string, n: number): TaskRow | undefined {
  return db.get<TaskRow>('SELECT * FROM tasks WHERE workspace_id = ? AND number = ?', workspaceId, n);
}

/** Quadro da equipe: onde os agentes registram e dão andamento às demandas (você acompanha). */
export function defaultBoard(db: Db, workspaceId: string): { id: string } {
  const b = db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'team' ORDER BY created_at LIMIT 1", workspaceId);
  if (!b) throw notFound('quadro');
  return b;
}

/** Quadro local do usuário ("Minhas tarefas"). */
export function userBoard(db: Db, workspaceId: string): { id: string } {
  const b = db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user' ORDER BY created_at LIMIT 1", workspaceId);
  if (!b) throw notFound('quadro');
  return b;
}

export function boardAudience(db: Db, workspaceId: string, boardId: string): 'team' | 'user' {
  const b = db.get<{ audience: 'team' | 'user' }>('SELECT audience FROM boards WHERE id = ? AND workspace_id = ?', boardId, workspaceId);
  if (!b) throw notFound('quadro');
  return b.audience;
}

/**
 * Atualiza os quadros de workspaces antigos (idempotente): "Quadro Ergon" vira o quadro da equipe, nasce
 * "Minhas tarefas" e, uma vez, os cards de simulação de canal (fixtures) são arquivados — não excluídos.
 */
export function ensureBoards(db: Db, bus: Bus | null, workspaceId: string, userColumns: string[]): void {
  let changed = false;
  db.tx(() => {
    const r = db.run("UPDATE boards SET name = 'Quadro da equipe' WHERE workspace_id = ? AND origin = 'native' AND audience = 'team' AND name = 'Quadro Ergon'", workspaceId);
    if (r.changes) changed = true;
    if (!db.get("SELECT 1 AS x FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user'", workspaceId)) {
      const bid = id('brd');
      db.run("INSERT INTO boards (id, workspace_id, name, origin, audience, created_at) VALUES (?, ?, 'Minhas tarefas', 'native', 'user', ?)", bid, workspaceId, now());
      userColumns.forEach((c, i) => db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', id('col'), workspaceId, bid, c, i));
      changed = true;
    }
    // quadro da equipe: "Com você" (o que espera a sua aprovação), entre Em andamento e Concluído
    for (const b of db.all<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'team'", workspaceId)) {
      if (db.get("SELECT 1 AS x FROM columns WHERE board_id = ? AND name = 'Com você'", b.id)) continue;
      const done = db.get<{ position: number }>("SELECT position FROM columns WHERE board_id = ? AND name = 'Concluído'", b.id);
      if (!done) continue;
      db.run('UPDATE columns SET position = position + 1 WHERE board_id = ? AND position >= ?', b.id, done.position);
      db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', id('col'), workspaceId, b.id, 'Com você', done.position);
      changed = true;
    }
    if (!getSetting(db, workspaceId, 'fixtures.retired')) {
      const sims = db.all<{ id: string; number: number }>('SELECT id, number FROM tasks WHERE workspace_id = ? AND is_fixture = 1 AND archived = 0', workspaceId);
      for (const t of sims) db.run('UPDATE tasks SET archived = 1, revision = revision + 1, updated_at = ? WHERE id = ?', now(), t.id);
      if (sims.length) {
        audit(db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'tasks.retire_fixtures', evidence: { tasks: sims.map((t) => t.number) }, result: 'cards de simulação de canal arquivados (não excluídos)' });
        changed = true;
      }
      setSetting(db, workspaceId, 'fixtures.retired', now());
    }
  });
  if (changed) bus?.publish(workspaceId, 'tasks.changed', {});
}

function firstColumn(db: Db, workspaceId: string, boardId: string): string {
  const c = db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND workspace_id = ? ORDER BY position LIMIT 1', boardId, workspaceId);
  if (!c) throw notFound('coluna');
  return c.id;
}

export interface CreateTaskInput {
  title: string; description?: string; boardId?: string; columnId?: string; agentId?: string | null;
  origin: TaskOrigin; sourceEventId?: string | null; isFixture?: boolean;
  /** prazo AAAA-MM-DD */
  dueOn?: string | null;
}

export function createTask(db: Db, bus: Bus | null, workspaceId: string, actor: Actor, input: CreateTaskInput): TaskRow {
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 200) throw new HttpError(400, 'title', 'título: 1–200 caracteres');
  const description = (input.description ?? '').slice(0, 8000);
  const task = db.tx(() => {
    const boardId = input.boardId ?? defaultBoard(db, workspaceId).id;
    const board = db.get<{ origin: string; audience: string }>('SELECT origin, audience FROM boards WHERE id = ? AND workspace_id = ?', boardId, workspaceId);
    if (!board) throw notFound('quadro');
    if (board.origin === 'mirror' && input.origin !== 'mirror') throw new HttpError(409, 'mirror_readonly', 'Quadro espelhado é somente leitura nesta etapa.');
    const columnId = input.columnId ?? firstColumn(db, workspaceId, boardId);
    const col = db.get('SELECT 1 AS x FROM columns WHERE id = ? AND board_id = ? AND workspace_id = ?', columnId, boardId, workspaceId);
    if (!col) throw notFound('coluna');
    if (input.agentId) {
      const a = db.get('SELECT 1 AS x FROM agents WHERE id = ? AND workspace_id = ?', input.agentId, workspaceId);
      if (!a) throw notFound('agente');
    }
    const n = db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE workspace_id = ?', workspaceId);
    const taskId = id('tsk');
    const ts = now();
    db.run(
      `INSERT INTO tasks (id, number, workspace_id, board_id, column_id, agent_id, title, description, origin, source_event_id, is_fixture, created_at, updated_at, due_on, work_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId, Number(n?.n ?? 1), workspaceId, boardId, columnId, input.agentId ?? null, db.seal(workspaceId, title), db.seal(workspaceId, description), input.origin,
      input.sourceEventId ?? null, input.isFixture ? 1 : 0, ts, ts, validDue(input.dueOn) ? input.dueOn : null,
      board.audience === 'team' && board.origin === 'native' ? 'solicitada' : null);
    audit(db, null, {
      workspaceId, actorType: actor.type, actorId: actor.id, action: 'task.create', targetType: 'task', targetId: taskId,
      evidence: { origin: input.origin, sourceEventId: input.sourceEventId ?? null, fixture: !!input.isFixture }, result: 'ok',
    });
    return getTask(db, workspaceId, taskId);
  });
  bus?.publish(workspaceId, 'tasks.changed', { id: task.id });
  return task;
}

export interface UpdateTaskInput {
  title?: string; description?: string; columnId?: string; agentId?: string | null; completed?: boolean; archived?: boolean;
  /** prazo AAAA-MM-DD; null tira o prazo */
  dueOn?: string | null;
  expectedRevision?: number;
}

/**
 * Atualização humana/agente com controle de revisão. Conclusão humana é registrada como tal e
 * nenhuma importação ou reprocessamento a desfaz depois (ver mirror.ts e ingest.ts).
 */
export function updateTask(db: Db, bus: Bus | null, workspaceId: string, actor: Actor, taskId: string, input: UpdateTaskInput): TaskRow {
  const task = db.tx(() => {
    const t = getTask(db, workspaceId, taskId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== Number(t.revision)) {
      throw new HttpError(409, 'revision_conflict', 'A tarefa mudou desde a última leitura; recarregue antes de salvar.');
    }
    const board = db.get<{ origin: string }>('SELECT origin FROM boards WHERE id = ?', t.board_id);
    const isMirror = board?.origin === 'mirror';
    const changes: Record<string, unknown> = {};
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    const set = (col: string, v: string | number | null, label: string, before: unknown) => {
      sets.push(`${col} = ?`); vals.push(v); changes[label] = { de: before, para: v };
    };
    if (isMirror && (input.title !== undefined || input.description !== undefined || input.columnId !== undefined || input.dueOn !== undefined)) {
      throw new HttpError(409, 'mirror_readonly', 'Título, descrição, coluna e prazo do espelho vêm do aplicativo externo nesta etapa.');
    }
    if (input.dueOn !== undefined && (input.dueOn ?? null) !== (t.due_on ?? null)) {
      if (input.dueOn !== null && !validDue(input.dueOn)) throw new HttpError(400, 'due', 'prazo: uma data válida (AAAA-MM-DD)');
      set('due_on', input.dueOn, 'prazo', t.due_on ?? null);
    }
    if (input.title !== undefined) {
      const title = input.title.trim().replace(/\s+/g, ' ');
      if (!title || title.length > 200) throw new HttpError(400, 'title', 'título: 1–200 caracteres');
      if (title !== t.title) { set('title', db.seal(workspaceId, title), 'titulo', t.title); changes.titulo = { de: t.title, para: title }; }
    }
    if (input.description !== undefined && input.description !== t.description) { set('description', db.seal(workspaceId, input.description.slice(0, 8000)), 'descricao', '(anterior)'); changes.descricao = { de: '(anterior)', para: '(nova)' }; }
    if (input.columnId !== undefined && input.columnId !== t.column_id) {
      const col = db.get('SELECT 1 AS x FROM columns WHERE id = ? AND board_id = ? AND workspace_id = ?', input.columnId, t.board_id, workspaceId);
      if (!col) throw notFound('coluna');
      set('column_id', input.columnId, 'coluna', t.column_id);
    }
    if (input.agentId !== undefined && input.agentId !== t.agent_id) {
      if (input.agentId) {
        const a = db.get('SELECT 1 AS x FROM agents WHERE id = ? AND workspace_id = ?', input.agentId, workspaceId);
        if (!a) throw notFound('agente');
      }
      set('agent_id', input.agentId, 'agente', t.agent_id);
    }
    if (input.completed !== undefined && (input.completed ? 1 : 0) !== Number(t.completed)) {
      if (input.completed) {
        const by = actor.type === 'user' ? 'human' : actor.type === 'connector' ? 'external' : 'agent';
        set('completed', 1, 'concluida', false);
        sets.push('completed_at = ?', 'completed_by = ?', 'completed_by_user_id = ?');
        vals.push(now(), by, actor.type === 'user' ? actor.id : null);
      } else {
        if (actor.type !== 'user') throw new HttpError(409, 'human_completion', 'Somente uma pessoa reabre tarefa concluída.');
        set('completed', 0, 'concluida', true);
        sets.push('completed_at = NULL', 'completed_by = NULL', 'completed_by_user_id = NULL');
      }
    }
    if (input.archived !== undefined && (input.archived ? 1 : 0) !== Number(t.archived)) set('archived', input.archived ? 1 : 0, 'arquivada', !!t.archived);
    if (sets.length === 0) return t;
    sets.push('revision = revision + 1', 'updated_at = ?');
    vals.push(now());
    db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...vals, taskId, workspaceId);
    audit(db, null, { workspaceId, actorType: actor.type, actorId: actor.id, action: 'task.update', targetType: 'task', targetId: taskId, evidence: changes, result: 'ok' });
    return getTask(db, workspaceId, taskId);
  });
  bus?.publish(workspaceId, 'tasks.changed', { id: task.id });
  return task;
}

export function boardView(db: Db, workspaceId: string, boardId: string) {
  const board = db.get<{ audience: string }>('SELECT * FROM boards WHERE id = ? AND workspace_id = ?', boardId, workspaceId);
  if (!board) throw notFound('quadro');
  const columns = db.all('SELECT id, name, position, external_id FROM columns WHERE board_id = ? AND workspace_id = ? ORDER BY position', boardId, workspaceId);
  // no quadro da equipe, cada card mostra também o andamento real: execução ativa, revisão e repasses
  const tasks = db.all(
    `SELECT t.id, t.number, t.column_id, t.agent_id, t.title, t.description, t.completed, t.completed_by, t.completed_at, t.origin,
            t.is_fixture, t.revision, t.updated_at, t.created_at, t.parent_task_id, t.external_assignee, t.due_on, t.work_state, t.requires_approval, t.priority,
            (SELECT COUNT(*) FROM task_artifacts ta WHERE ta.task_id = t.id AND ta.role = 'entrada') AS inputs,
            (SELECT COUNT(*) FROM task_artifacts ta WHERE ta.task_id = t.id AND ta.role = 'entregavel') AS deliverables,
            l.sync_state AS link_state, l.conflict AS link_conflict,
            (SELECT COUNT(*) FROM link_proposals p WHERE p.task_id = t.id AND p.status = 'proposed') AS proposals,
            (SELECT r.status FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user') ORDER BY r.created_at LIMIT 1) AS run_status,
            (SELECT COUNT(*) FROM audit_events e WHERE e.target_type = 'task' AND e.target_id = t.id AND e.action IN ('task.route', 'task.reassign', 'task.delegate', 'task.handoff')) AS handoffs,
            EXISTS (SELECT 1 FROM audit_events e WHERE e.target_type = 'task' AND e.target_id = t.id AND e.action = 'task.handoff') AS is_help,
            -- o card enviado à equipe que ainda está no quadro (cancelado, a etiqueta "equipe #N" some e dá para enviar de novo)
            (SELECT c.number FROM tasks c WHERE c.parent_task_id = t.id AND c.archived = 0 ORDER BY c.created_at, c.rowid LIMIT 1) AS team_number,
            (SELECT c.agent_id FROM tasks c WHERE c.parent_task_id = t.id AND c.archived = 0 ORDER BY c.created_at, c.rowid LIMIT 1) AS team_agent_id,
            (SELECT pb.audience FROM tasks p JOIN boards pb ON pb.id = p.board_id WHERE p.id = t.parent_task_id) AS parent_audience,
            -- nome e cor do responsável e de quem recebeu o card enviado à equipe (desativados também: o card não perde o nome)
            ag.name AS agent_name, ag.color AS agent_color,
            (SELECT x.name FROM tasks c LEFT JOIN agents x ON x.id = c.agent_id WHERE c.parent_task_id = t.id AND c.archived = 0 ORDER BY c.created_at, c.rowid LIMIT 1) AS team_agent_name,
            (SELECT x.color FROM tasks c LEFT JOIN agents x ON x.id = c.agent_id WHERE c.parent_task_id = t.id AND c.archived = 0 ORDER BY c.created_at, c.rowid LIMIT 1) AS team_agent_color
       FROM tasks t LEFT JOIN task_links l ON l.task_id = t.id LEFT JOIN agents ag ON ag.id = t.agent_id
      WHERE t.board_id = ? AND t.workspace_id = ? AND t.archived = 0 ORDER BY COALESCE(t.queue_pos, t.number), t.number`, boardId, workspaceId);
  return { board, columns, tasks };
}

export function taskLog(db: Db, workspaceId: string, taskId: string) {
  getTask(db, workspaceId, taskId);
  return db.all(
    `SELECT id, actor_type, actor_id, action, evidence, result, created_at FROM audit_events
      WHERE workspace_id = ? AND target_type = 'task' AND target_id = ? ORDER BY created_at, rowid`, workspaceId, taskId);
}

// Similaridade --------------------------------------------------------------------------------

const STOP = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'para', 'pra', 'com', 'um', 'uma', 'no', 'na', 'em', 'que', 'por', 'favor', 'preciso', 'precisamos', 'tarefa']);

export function tokens(s: string): Set<string> {
  return new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a); const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Similaridade NUNCA funde: só registra proposta para confirmação/rejeição humana. */
export function proposeSimilarLinks(db: Db, workspaceId: string, task: TaskRow, threshold = 0.5): number {
  const open = db.all<{ id: string; title: string }>(
    'SELECT id, title FROM tasks WHERE workspace_id = ? AND id <> ? AND archived = 0 AND completed = 0', workspaceId, task.id);
  let n = 0;
  for (const o of open) {
    const score = similarity(task.title, o.title);
    if (score >= threshold) {
      db.run(
        `INSERT INTO link_proposals (id, workspace_id, task_id, related_task_id, reason, score, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        id('lnk'), workspaceId, task.id, o.id, 'títulos semelhantes (possível duplicata)', score, now());
      n++;
    }
  }
  return n;
}

export function decideLinkProposal(db: Db, bus: Bus, workspaceId: string, userId: string, proposalId: string, decision: 'confirmed' | 'rejected' | 'proposed'): void {
  db.tx(() => {
    const p = db.get<{ task_id: string; status: string }>('SELECT task_id, status FROM link_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
    if (!p) throw notFound('proposta');
    db.run('UPDATE link_proposals SET status = ?, decided_at = ? WHERE id = ?', decision, decision === 'proposed' ? null : now(), proposalId);
    audit(db, null, {
      workspaceId, actorType: 'user', actorId: userId, action: decision === 'proposed' ? 'link.revert' : `link.${decision}`,
      targetType: 'task', targetId: p.task_id, evidence: { proposalId, before: p.status }, result: 'ok',
    });
  });
  bus.publish(workspaceId, 'tasks.changed', {});
}
