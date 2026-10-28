/**
 * Vários workspaces por pessoa (uma empresa, um projeto, a vida pessoal): visão geral, criar e renomear. Cada
 * workspace tem a própria equipe, cidade, quadros, conversas e rotinas; a conta de IA e o motor são da pessoa e valem
 * para todos os dela. A troca é pela sessão (/api/session/workspace).
 */
import type { Db } from '../db/db.ts';
import { HttpError, now } from '../lib/util.ts';
import type { PersonKeySource } from '../security/keys.ts';
import { createWorkspace } from './seed.ts';

export interface WorkspaceSummary {
  id: string; name: string; role: string; createdAt: string; current: boolean;
  agents: number; openTasks: number; working: number; waiting: number;
}

/** Workspaces da pessoa com os números de cada um (contagens: nada cifrado é aberto). */
export function listWorkspaces(db: Db, userId: string, currentId: string): WorkspaceSummary[] {
  return db.all<{ id: string; name: string; role: string; created_at: string; agents: number; open_tasks: number; working: number; waiting: number }>(
    `SELECT w.id, w.name, m.role, w.created_at,
            (SELECT COUNT(*) FROM agents a WHERE a.workspace_id = w.id AND a.status = 'active') AS agents,
            (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.completed = 0 AND t.archived = 0) AS open_tasks,
            (SELECT COUNT(*) FROM runs r WHERE r.workspace_id = w.id AND r.status IN ('queued', 'running')) AS working,
            (SELECT COUNT(*) FROM runs r WHERE r.workspace_id = w.id AND r.status = 'waiting_user') AS waiting
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.created_at`, userId,
  ).map((w) => ({ id: w.id, name: w.name, role: w.role, createdAt: w.created_at, current: w.id === currentId,
    agents: w.agents, openTasks: w.open_tasks, working: w.working, waiting: w.waiting }));
}

const nome = (s: string): string => {
  const n = s.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!n) throw new HttpError(400, 'name', 'dê um nome ao workspace');
  return n;
};

/**
 * Workspace novo da pessoa, com a equipe e a cidade iniciais e o fluxo de boas-vindas (como na conta nova). A chave
 * dele nasce embrulhada pela chave da pessoa, quando a instalação tem chaves por pessoa.
 */
export function createOwnWorkspace(db: Db, keys: PersonKeySource | null, userId: string, name: string, slotsPerFloor: number): string {
  const n = nome(name);
  return db.tx(() => {
    const criar = () => createWorkspace(db, n, { demo: true, slotsPerFloor, welcome: true });
    const seed = keys ? keys.withCreator(userId, criar) : criar();
    db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", seed.workspaceId, userId, now());
    return seed.workspaceId;
  });
}

/** Só quem é dona renomeia. */
export function renameWorkspace(db: Db, userId: string, workspaceId: string, name: string): string {
  const m = db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
  if (!m) throw new HttpError(404, 'not_found', 'workspace não encontrado');
  if (m.role !== 'owner') throw new HttpError(403, 'forbidden', 'só quem é dona do workspace muda o nome');
  const n = nome(name);
  db.run('UPDATE workspaces SET name = ? WHERE id = ?', n, workspaceId);
  return n;
}
