/**
 * Vários workspaces por pessoa (uma empresa, um projeto, a vida pessoal): visão geral, criar e renomear. Cada
 * workspace tem a própria equipe, cidade, quadros, conversas e rotinas; a conta de IA e o motor são da pessoa e valem
 * para todos os dela. A troca é pela sessão (/api/session/workspace). Excluir apaga de vez (com confirmação).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
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

/**
 * Excluir um workspace de vez (só a dona; nunca o último dela; o nome digitado tem de conferir): sai a chave dele (o
 * conteúdo fica ilegível na hora), as linhas, os arquivos e os segredos. As sessões que estavam nele passam para outro
 * workspace da pessoa (ou saem, se for de alguém sem outro).
 */
export function deleteWorkspace(db: Db, cfg: Pick<Config, 'filesDir' | 'dataDir'>, userId: string, workspaceId: string, confirmName: string): { name: string; next: string } {
  const m = db.get<{ role: string; name: string }>('SELECT m.role, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?', workspaceId, userId);
  if (!m) throw new HttpError(404, 'not_found', 'workspace não encontrado');
  if (m.role !== 'owner') throw new HttpError(403, 'forbidden', 'só quem é dona do workspace pode excluir');
  if (confirmName.trim() !== m.name) throw new HttpError(400, 'confirm', 'o nome digitado não confere com o do workspace');
  const outros = db.all<{ workspace_id: string }>('SELECT workspace_id FROM memberships WHERE user_id = ? AND workspace_id <> ? ORDER BY created_at', userId, workspaceId);
  if (!outros.length) throw new HttpError(409, 'last', 'este é o seu único workspace: crie outro antes de excluir este');
  const next = outros[0].workspace_id;
  const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  const cols = (t: string) => (db.raw.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as Array<{ name: string }>).map((c) => c.name);
  // sessões abertas nele: para outro workspace de quem está nela (ou saem)
  for (const s of db.all<{ token_hash: string; user_id: string }>('SELECT token_hash, user_id FROM sessions WHERE workspace_id = ?', workspaceId)) {
    const dest = db.get<{ workspace_id: string }>('SELECT workspace_id FROM memberships WHERE user_id = ? AND workspace_id <> ? ORDER BY created_at LIMIT 1', s.user_id, workspaceId);
    if (dest) db.run('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?', dest.workspace_id, s.token_hash);
    else db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
  }
  db.raw.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      for (const t of tables) if (t !== 'sessions' && cols(t).includes('workspace_id')) db.run(`DELETE FROM ${JSON.stringify(t)} WHERE workspace_id = ?`, workspaceId);
      db.run('DELETE FROM workspaces WHERE id = ?', workspaceId);
    });
    const broken = db.raw.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`exclusão deixou ${broken.length} referências soltas`);
  } finally { db.raw.exec('PRAGMA foreign_keys = ON'); }
  db.fieldCipher?.forget(workspaceId);
  const dir = path.join(cfg.filesDir, workspaceId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const sec = path.join(cfg.dataDir, 'secrets');
  if (fs.existsSync(sec)) for (const f of fs.readdirSync(sec).filter((x) => x.startsWith(`${workspaceId}-`))) fs.rmSync(path.join(sec, f), { recursive: true, force: true });
  return { name: m.name, next };
}
