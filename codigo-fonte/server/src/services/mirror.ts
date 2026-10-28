import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';

/**
 * Contrato comum para espelhar listas e quadros de aplicativos de tarefas (Planner, To Do, Asana, Todoist)
 * no quadro do usuário. Somente leitura dos campos combinados: título, descrição, situação (concluída ou
 * não) e responsável; colunas quando o aplicativo tem (buckets, seções). Os provedores reais ficam em
 * integrations.ts; a fixture "planner-like" existe só para testes.
 */
export interface ExternalBoard { externalId: string; name: string; version: string }
export interface ExternalColumn { externalId: string; name: string; order: number }
export interface ExternalTask {
  externalId: string; columnExternalId: string; title: string; description: string; completed: boolean; version: string;
  /** responsável no aplicativo de origem (nome), quando houver */
  assignee?: string | null;
  /** prazo no aplicativo de origem (AAAA-MM-DD), quando houver */
  due?: string | null;
  extra: Record<string, unknown>;
}
export interface BoardSnapshot { board: ExternalBoard; columns: ExternalColumn[]; tasks: ExternalTask[]; complete: boolean }

export class ProviderError extends Error {
  readonly kind: 'forbidden' | 'unavailable' | 'not_found';
  /** a autorização acabou (renovação recusada ou impossível): só entrando de novo em Conexões */
  readonly reauth: boolean;
  /** código HTTP do serviço, quando houve resposta (401 = acesso invalidado: vale renovar uma vez) */
  readonly status: number | null;
  constructor(kind: 'forbidden' | 'unavailable' | 'not_found', message: string, opts: { reauth?: boolean; status?: number } = {}) { super(message); this.kind = kind; this.reauth = !!opts.reauth; this.status = opts.status ?? null; }
}

export interface TaskProvider {
  readonly name: string;
  readonly isFixture: boolean;
  readonly supports: { title: true; description: boolean; completion: boolean; columns: boolean; writeBack: false };
  listBoards(): Promise<Array<ExternalBoard & { taskCount: number }>>;
  getBoard(externalId: string): Promise<BoardSnapshot>;
}

const FIXTURE_NAME = /^[a-z0-9-]{1,40}$/;

/** Fixture em formato inspirado no Planner (buckets, percentComplete, etag). NÃO é Planner conectado. */
export class FixtureTaskProvider implements TaskProvider {
  readonly name = 'fixture-planner-like';
  readonly isFixture = true;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly data: any;

  constructor(fixturesDir: string, variant: string) {
    if (!FIXTURE_NAME.test(variant)) throw new HttpError(400, 'fixture', 'fixture inválida');
    const file = path.join(fixturesDir, 'mirror', `${variant}.json`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'fixture', 'fixture inexistente');
    this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  private check(): void {
    if (this.data.error === 'forbidden') throw new ProviderError('forbidden', 'permissão revogada no aplicativo externo (simulado)');
    if (this.data.error === 'unavailable') throw new ProviderError('unavailable', 'serviço externo indisponível (simulado)');
  }

  async listBoards() {
    this.check();
    return (this.data.plans as any[]).map((p) => ({ externalId: p.id, name: p.title, version: p['@odata.etag'], taskCount: p.tasks.length }));
  }

  async getBoard(externalId: string): Promise<BoardSnapshot> {
    this.check();
    const p = (this.data.plans as any[]).find((x) => x.id === externalId);
    if (!p) throw new ProviderError('not_found', 'quadro não encontrado (ou sem acesso)');
    const columns = (p.buckets as any[]).map((b, i) => ({ externalId: b.id, name: b.name, order: i }));
    const tasks = (p.tasks as any[]).map((t) => {
      const { id: tid, bucketId, title, description, percentComplete, '@odata.etag': etag, ...extra } = t;
      return { externalId: tid, columnExternalId: bucketId, title, description: description ?? '', completed: percentComplete === 100, version: etag, extra };
    });
    return { board: { externalId: p.id, name: p.title, version: p['@odata.etag'] }, columns, tasks, complete: p.pageComplete !== false };
  }
}

export interface ImportReport {
  boards: Array<{ externalId: string; boardId: string | null; state: 'ok' | 'error'; error?: string;
    created: number; updated: number; unchanged: number; missing: number; conflicts: number }>;
}

export async function importBoards(db: Db, bus: Bus, workspaceId: string, connectionId: string, userId: string,
  provider: TaskProvider, externalIds: string[]): Promise<ImportReport> {
  // origem: uma integração conectada (integrations) ou a fixture de testes (connections 'mirror_fixture')
  const conn = db.get<{ id: string }>("SELECT id FROM integrations WHERE id = ? AND workspace_id = ? AND state = 'connected'", connectionId, workspaceId)
    ?? db.get<{ id: string }>("SELECT id FROM connections WHERE id = ? AND workspace_id = ? AND kind = 'mirror_fixture'", connectionId, workspaceId);
  if (!conn) throw notFound('conexão');
  const report: ImportReport = { boards: [] };
  for (const extId of externalIds.slice(0, 20)) {
    let snap: BoardSnapshot;
    try {
      snap = await provider.getBoard(extId);
    } catch (err) {
      const msg = err instanceof ProviderError ? `${err.kind}: ${err.message}` : 'falha desconhecida';
      // Falha/perda de acesso não vira quadro vazio nem exclusão: marca erro e preserva tudo.
      const b = db.get<{ id: string }>('SELECT id FROM boards WHERE connection_id = ? AND external_id = ?', connectionId, extId);
      if (b) {
        db.run("UPDATE boards SET sync_state = 'error', last_error = ? WHERE id = ?", msg, b.id);
        audit(db, null, { workspaceId, actorType: 'connector', actorId: connectionId, action: 'mirror.error', targetType: 'board', targetId: b.id, evidence: { error: msg }, result: 'nenhum dado alterado' });
      }
      report.boards.push({ externalId: extId, boardId: b?.id ?? null, state: 'error', error: msg, created: 0, updated: 0, unchanged: 0, missing: 0, conflicts: 0 });
      continue;
    }
    report.boards.push(db.tx(() => applySnapshot(db, workspaceId, connectionId, userId, snap, provider.isFixture)));
  }
  bus.publish(workspaceId, 'tasks.changed', {});
  return report;
}

function applySnapshot(db: Db, workspaceId: string, connectionId: string, userId: string, snap: BoardSnapshot, isFixture: boolean): ImportReport['boards'][number] {
  const ts = now();
  const r = { externalId: snap.board.externalId, boardId: '' as string | null, state: 'ok' as const, created: 0, updated: 0, unchanged: 0, missing: 0, conflicts: 0 };
  let board = db.get<{ id: string; name: string }>('SELECT id, name FROM boards WHERE connection_id = ? AND external_id = ? AND workspace_id = ?', connectionId, snap.board.externalId, workspaceId);
  if (!board) {
    const bid = id('brd');
    db.run(
      `INSERT INTO boards (id, workspace_id, name, origin, audience, connection_id, external_id, external_version, sync_state, last_synced_at, created_at)
       VALUES (?, ?, ?, 'mirror', 'user', ?, ?, ?, 'ok', ?, ?)`, bid, workspaceId, snap.board.name, connectionId, snap.board.externalId, snap.board.version, ts, ts);
    board = { id: bid, name: snap.board.name };
  } else {
    db.run("UPDATE boards SET name = ?, external_version = ?, sync_state = 'ok', last_error = NULL, last_synced_at = ? WHERE id = ?", snap.board.name, snap.board.version, ts, board.id);
  }
  r.boardId = board.id;

  const colIds = new Map<string, string>();
  for (const c of snap.columns) {
    const ex = db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND external_id = ?', board.id, c.externalId);
    if (ex) {
      db.run('UPDATE columns SET name = ?, position = ? WHERE id = ?', c.name, c.order, ex.id);
      colIds.set(c.externalId, ex.id);
    } else {
      const cid = id('col');
      db.run('INSERT INTO columns (id, workspace_id, board_id, name, position, external_id) VALUES (?, ?, ?, ?, ?, ?)', cid, workspaceId, board.id, c.name, c.order, c.externalId);
      colIds.set(c.externalId, cid);
    }
  }

  const seen = new Set<string>();
  for (const t of snap.tasks) {
    seen.add(t.externalId);
    const columnId = colIds.get(t.columnExternalId) ?? colIds.values().next().value;
    if (!columnId) continue;
    const link = db.get<{ id: string; task_id: string; external_version: string | null }>(
      'SELECT id, task_id, external_version FROM task_links WHERE connection_id = ? AND external_id = ? AND workspace_id = ?', connectionId, t.externalId, workspaceId);
    if (!link) {
      const n = db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE workspace_id = ?', workspaceId);
      const taskId = id('tsk');
      db.run(
        `INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, description, completed, completed_at, completed_by, origin, is_fixture, external_assignee, created_at, updated_at, due_on)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mirror', ?, ?, ?, ?, ?)`,
        taskId, Number(n?.n ?? 1), workspaceId, board.id, columnId, db.seal(workspaceId, t.title.slice(0, 200)), db.seal(workspaceId, t.description.slice(0, 8000)),
        t.completed ? 1 : 0, t.completed ? ts : null, t.completed ? 'external' : null, isFixture ? 1 : 0, t.assignee ?? null, ts, ts, t.due ?? null);
      db.run(
        `INSERT INTO task_links (id, workspace_id, task_id, connection_id, external_id, external_version, external_extra, sync_state, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?)`, id('tln'), workspaceId, taskId, connectionId, t.externalId, t.version, JSON.stringify(t.extra), ts);
      audit(db, null, { workspaceId, actorType: 'connector', actorId: connectionId, action: 'mirror.task.import', targetType: 'task', targetId: taskId, evidence: { externalId: t.externalId }, result: 'criada' });
      r.created++;
      continue;
    }
    // versão igual no aplicativo só pula se o prazo calculado também for igual: uma correção na leitura do prazo
    // chega às tarefas já espelhadas na próxima sincronização, e fica registrada como mudança de prazo
    const dueNow = link.external_version === t.version && t.version ? db.get<{ due: string | null }>('SELECT due_on AS due FROM tasks WHERE id = ?', link.task_id)?.due ?? null : null;
    if (link.external_version === t.version && t.version && (t.due ?? null) === dueNow) {
      db.run("UPDATE task_links SET last_seen_at = ?, sync_state = CASE WHEN sync_state = 'missing' THEN 'ok' ELSE sync_state END WHERE id = ?", ts, link.id);
      r.unchanged++;
      continue;
    }
    const cur = db.get<{ title: string; description: string; column_id: string; completed: number; completed_by: string | null }>(
      'SELECT title, description, column_id, completed, completed_by FROM tasks WHERE id = ?', link.task_id);
    if (!cur) continue;
    const changes: Record<string, unknown> = {};
    let completed = Number(cur.completed);
    let completedBy = cur.completed_by;
    let conflict: string | null = null;
    if (t.completed && !completed) { completed = 1; completedBy = 'external'; changes.concluida = true; }
    if (!t.completed && completed) {
      if (cur.completed_by === 'human') {
        conflict = 'concluída por pessoa no Ergon; aberta no aplicativo externo (conclusão humana preservada)';
        r.conflicts++;
      } else { completed = 0; completedBy = null; changes.concluida = false; }
    }
    if (cur.title !== t.title) changes.titulo = { de: cur.title, para: t.title };
    if (cur.column_id !== columnId) changes.coluna = true;
    if (cur.description !== t.description) changes.descricao = true;
    const now2 = db.get<{ a: string | null; due: string | null }>('SELECT external_assignee AS a, due_on AS due FROM tasks WHERE id = ?', link.task_id);
    const assigneeNow = now2?.a ?? null;
    if ((t.assignee ?? null) !== assigneeNow) changes.responsavel = { de: assigneeNow, para: t.assignee ?? null };
    if ((t.due ?? null) !== (now2?.due ?? null)) changes.prazo = { de: now2?.due ?? null, para: t.due ?? null };
    if (!Object.keys(changes).length && !conflict) {
      db.run("UPDATE task_links SET external_version = ?, last_seen_at = ?, sync_state = 'ok' WHERE id = ?", t.version, ts, link.id);
      r.unchanged++;
      continue;
    }
    db.run(
      `UPDATE tasks SET title = ?, description = ?, column_id = ?, completed = ?, completed_by = ?, external_assignee = ?, due_on = ?,
              completed_at = CASE WHEN ? = 1 AND completed = 0 THEN ? WHEN ? = 0 THEN NULL ELSE completed_at END,
              revision = revision + 1, updated_at = ? WHERE id = ?`,
      db.seal(workspaceId, t.title.slice(0, 200)), db.seal(workspaceId, t.description.slice(0, 8000)), columnId, completed, completedBy, t.assignee ?? null, t.due ?? null, completed, ts, completed, ts, link.task_id);
    db.run("UPDATE task_links SET external_version = ?, external_extra = ?, sync_state = 'ok', conflict = ?, last_seen_at = ? WHERE id = ?",
      t.version, JSON.stringify(t.extra), conflict, ts, link.id);
    audit(db, null, { workspaceId, actorType: 'connector', actorId: connectionId, action: 'mirror.task.update', targetType: 'task', targetId: link.task_id, evidence: { externalId: t.externalId, changes, conflict }, result: 'atualizada' });
    r.updated++;
  }

  // Ausência numa consulta não prova exclusão (filtro, paginação, acesso). Só marca, nunca apaga.
  if (snap.complete) {
    const links = db.all<{ id: string; task_id: string; external_id: string; sync_state: string }>(
      `SELECT l.id, l.task_id, l.external_id, l.sync_state FROM task_links l JOIN tasks t ON t.id = l.task_id
        WHERE l.connection_id = ? AND t.board_id = ?`, connectionId, board.id);
    for (const l of links) {
      if (seen.has(l.external_id) || l.sync_state === 'missing') continue;
      db.run("UPDATE task_links SET sync_state = 'missing' WHERE id = ?", l.id);
      audit(db, null, { workspaceId, actorType: 'connector', actorId: connectionId, action: 'mirror.task.missing', targetType: 'task', targetId: l.task_id, evidence: { externalId: l.external_id }, result: 'ausente na última leitura; preservada' });
      r.missing++;
    }
  }
  audit(db, null, { workspaceId, actorType: userId ? 'user' : 'connector', actorId: userId || connectionId, action: 'mirror.import', targetType: 'board', targetId: board.id, evidence: { ...r, fixture: isFixture }, result: 'ok' });
  return r;
}
