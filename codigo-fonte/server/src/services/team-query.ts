/**
 * Equipe por partes (docs/EQUIPE_VISUAL.md): a página Equipe não baixa o cadastro inteiro. Cada consulta devolve uma
 * página leve com cursor estável e o total contado no banco; perfil completo, instruções e ferramentas só ao abrir o
 * agente. O tamanho máximo de cada resposta limita o transporte, não quantos agentes ou construções existem.
 * Tudo no escopo do workspace.
 */
import { CATALOG, typeOf } from '../../../shared/city.ts';
import type { Db } from '../db/db.ts';
import { foldText } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';

export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 48;
/** Amostra de um grupo recolhido (setor ou construção): poucos rostos, a contagem diz o resto. */
export const SAMPLE = 4;

const WORK_KINDS = CATALOG.filter((t) => t.category === 'trabalho').map((t) => t.id);
const ACTIVE_RUN = "('queued', 'running', 'waiting_user')";

/** Projeção leve de um agente para listas (sem instruções, ferramentas nem modelo). */
export interface TeamAgent {
  id: string; name: string; role: string; color: string; status: 'active' | 'archived'; demo: boolean; coordinator: boolean;
  char_key: string | null; look_seed: number | null; deactivation_note: string | null;
  sector_key: string; sector_name: string; building_id: string | null; building_name: string | null; floor_name: string | null;
  run_status: string | null;
}
export interface Page<T> { items: T[]; total: number; next: string | null }

// cursor: posição depois do último item (base64url de um JSON), validado na volta
const encode = (v: unknown[]) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(c: string | undefined, arity: number): unknown[] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === arity) return v;
  } catch { /* cai no erro abaixo */ }
  throw new HttpError(400, 'cursor', 'cursor inválido: recomece a lista');
}
const limitOf = (n: number | undefined) => Math.max(1, Math.min(PAGE_MAX, Math.trunc(n ?? PAGE_DEFAULT) || PAGE_DEFAULT));
/** termo de busca para LIKE (sem acento, sem caixa; % e _ literais) */
const like = (q: string) => `%${foldText(q.trim()).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

type AgentRow = Omit<TeamAgent, 'demo' | 'coordinator' | 'look_seed'> & { demo: number; coordinator: number; look_seed: number | null; k: string };
const AGENT_COLS = `a.id, a.name, a.role, a.color, a.status, a.demo, a.coordinator, a.char_key, a.look_seed, a.deactivation_note,
  p.key AS sector_key, p.name AS sector_name, f.building_id, b.name AS building_name, f.name AS floor_name, fold(a.name) AS k,
  (SELECT r.status FROM runs r WHERE r.agent_id = a.id AND r.status IN ${ACTIVE_RUN} ORDER BY r.created_at LIMIT 1) AS run_status`;
const AGENT_FROM = `FROM agents a JOIN profiles p ON p.id = a.profile_id JOIN floors f ON f.id = a.floor_id LEFT JOIN buildings b ON b.id = f.building_id`;
const agentOut = (r: AgentRow): TeamAgent => ({
  id: r.id, name: r.name, role: r.role, color: r.color, status: r.status, demo: Number(r.demo) === 1, coordinator: Number(r.coordinator) === 1,
  char_key: r.char_key, look_seed: r.look_seed === null ? null : Number(r.look_seed), deactivation_note: r.deactivation_note,
  sector_key: r.sector_key, sector_name: r.sector_name, building_id: r.building_id, building_name: r.building_name, floor_name: r.floor_name, run_status: r.run_status,
});

export interface AgentQuery { q?: string; sector?: string; structure?: string; status?: 'active' | 'archived' | 'all'; cursor?: string; limit?: number }

/**
 * Agentes em ordem estável: o Coordenador primeiro, depois pelo nome (sem acento) e pelo id (nomes podem se repetir).
 * Moradores de uma construção são só os ativos (desativado não ocupa lugar).
 */
export function listTeamAgents(db: Db, workspaceId: string, o: AgentQuery = {}): Page<TeamAgent> {
  const where: string[] = ['a.workspace_id = ?']; const args: Array<string | number> = [workspaceId];
  const status = o.structure ? 'active' : o.status ?? 'active';
  if (status !== 'all') { where.push('a.status = ?'); args.push(status); }
  if (o.sector) { where.push('p.key = ?'); args.push(o.sector); }
  if (o.structure) { where.push('f.building_id = ?'); args.push(o.structure); }
  if (o.q?.trim()) { where.push("(fold(a.name) LIKE ? ESCAPE '\\' OR fold(a.role) LIKE ? ESCAPE '\\')"); args.push(like(o.q), like(o.q)); }
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n ${AGENT_FROM} WHERE ${where.join(' AND ')}`, ...args)?.n ?? 0);
  const limit = limitOf(o.limit);
  const after = decode(o.cursor, 3) as [number, string, string] | null;
  const page = [...where]; const pargs = [...args];
  if (after) { page.push('(a.coordinator < ? OR (a.coordinator = ? AND (fold(a.name) > ? OR (fold(a.name) = ? AND a.id > ?))))'); pargs.push(after[0], after[0], after[1], after[1], after[2]); }
  const rows = db.all<AgentRow>(`SELECT ${AGENT_COLS} ${AGENT_FROM} WHERE ${page.join(' AND ')} ORDER BY a.coordinator DESC, fold(a.name), a.id LIMIT ?`, ...pargs, limit + 1);
  const more = rows.length > limit; const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(agentOut), total, next: more && last ? encode([Number(last.coordinator), last.k, last.id]) : null };
}

export function teamAgent(db: Db, workspaceId: string, agentId: string): TeamAgent | null {
  const r = db.get<AgentRow>(`SELECT ${AGENT_COLS} ${AGENT_FROM} WHERE a.workspace_id = ? AND a.id = ?`, workspaceId, agentId);
  return r ? agentOut(r) : null;
}

const sampleOf = (db: Db, workspaceId: string, cond: string, arg: string) =>
  db.all<AgentRow>(`SELECT ${AGENT_COLS} ${AGENT_FROM} WHERE a.workspace_id = ? AND a.status = 'active' AND ${cond} ORDER BY a.coordinator DESC, fold(a.name), a.id LIMIT ?`, workspaceId, arg, SAMPLE).map(agentOut);

export interface TeamSector { key: string; name: string; description: string | null; custom: boolean; count: number; sample: TeamAgent[] }

/** Setores na ordem da equipe (posição), com quantos membros ativos e uma amostra. */
export function listTeamSectors(db: Db, workspaceId: string, o: { q?: string; cursor?: string; limit?: number; sample?: boolean } = {}): Page<TeamSector> {
  const where = ['p.workspace_id = ?']; const args: Array<string | number> = [workspaceId];
  if (o.q?.trim()) { where.push("fold(p.name) LIKE ? ESCAPE '\\'"); args.push(like(o.q)); }
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM profiles p WHERE ${where.join(' AND ')}`, ...args)?.n ?? 0);
  const limit = limitOf(o.limit ?? 24);
  const after = decode(o.cursor, 2) as [number, number] | null;
  if (after) { where.push('(p.position > ? OR (p.position = ? AND p.rowid > ?))'); args.push(after[0], after[0], after[1]); }
  const rows = db.all<{ id: string; key: string; name: string; description: string | null; custom: number; position: number; rid: number; n: number }>(
    `SELECT p.id, p.key, p.name, p.description, p.custom, p.position, p.rowid AS rid,
            (SELECT COUNT(*) FROM agents a WHERE a.profile_id = p.id AND a.status = 'active') AS n
       FROM profiles p WHERE ${where.join(' AND ')} ORDER BY p.position, p.rowid LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit; const items = rows.slice(0, limit); const last = items.at(-1);
  return {
    total, next: more && last ? encode([Number(last.position), Number(last.rid)]) : null,
    items: items.map((r) => ({ key: r.key, name: r.name, description: r.description, custom: Number(r.custom) === 1, count: Number(r.n),
      sample: o.sample === false || !Number(r.n) ? [] : sampleOf(db, workspaceId, 'a.profile_id = ?', r.id) })),
  };
}

export interface TeamStructure {
  id: string; kind: string; kind_name: string; name: string; i: number; j: number;
  floors: number; max_floors: number; slots: number; active: number; free: number; can_grow: boolean; sample: TeamAgent[];
}

/**
 * Construções de trabalho (as que recebem agentes) em ordem de criação, com ocupação contada no banco e uma amostra
 * de moradores. `free`: só as que têm lugar livre (destinos de "Mover para…").
 */
export function listTeamStructures(db: Db, workspaceId: string, maxFloors: number, o: { q?: string; cursor?: string; limit?: number; free?: boolean; sample?: boolean } = {}): Page<TeamStructure> {
  const where = ['b.workspace_id = ?', 'b.removed_at IS NULL', 'b.lot_x IS NOT NULL', `b.kind IN (${WORK_KINDS.map(() => '?').join(', ')})`];
  const args: Array<string | number> = [workspaceId, ...WORK_KINDS];
  if (o.q?.trim()) { where.push("fold(b.name) LIKE ? ESCAPE '\\'"); args.push(like(o.q)); }
  const OCC = `(SELECT COUNT(*) FROM agents a JOIN floors f ON f.id = a.floor_id WHERE f.building_id = b.id AND f.removed_at IS NULL AND a.status = 'active')`;
  const SLOTS = '(SELECT COALESCE(SUM(f.slots), 0) FROM floors f WHERE f.building_id = b.id AND f.removed_at IS NULL)';
  if (o.free) where.push(`${OCC} < ${SLOTS}`);
  const total = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM buildings b WHERE ${where.join(' AND ')}`, ...args)?.n ?? 0);
  const limit = limitOf(o.limit ?? 24);
  const after = decode(o.cursor, 2) as [string, string] | null;
  if (after) { where.push('(b.created_at > ? OR (b.created_at = ? AND b.id > ?))'); args.push(after[0], after[0], after[1]); }
  const rows = db.all<{ id: string; kind: string; name: string; i: number; j: number; created_at: string; floors: number; slots: number; active: number }>(
    `SELECT b.id, b.kind, b.name, b.lot_x AS i, b.lot_z AS j, b.created_at,
            (SELECT COUNT(*) FROM floors f WHERE f.building_id = b.id AND f.removed_at IS NULL) AS floors, ${SLOTS} AS slots, ${OCC} AS active
       FROM buildings b WHERE ${where.join(' AND ')} ORDER BY b.created_at, b.id LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit; const items = rows.slice(0, limit); const last = items.at(-1);
  return {
    total, next: more && last ? encode([last.created_at, last.id]) : null,
    items: items.map((r) => {
      const t = typeOf(r.kind); const max = Math.min(t?.floors.max ?? maxFloors, maxFloors);
      const slots = Number(r.slots); const active = Number(r.active); const floors = Number(r.floors);
      return { id: r.id, kind: r.kind, kind_name: t?.common ?? r.kind, name: r.name, i: Number(r.i), j: Number(r.j), floors, max_floors: max, slots, active,
        free: Math.max(0, slots - active), can_grow: floors < max,
        sample: o.sample === false || !active ? [] : sampleOf(db, workspaceId, 'f.building_id = ?', r.id) };
    }),
  };
}

export interface TeamSummary {
  agents: { active: number; archived: number }; sectors: number; structures: number;
  capacity: { slots: number; active: number; free: number }; coordinatorId: string | null;
}

/** Totais da equipe contados no banco (não do comprimento de listas paginadas). */
export function teamSummary(db: Db, workspaceId: string): TeamSummary {
  const ag = db.get<{ active: number; archived: number }>("SELECT SUM(status = 'active') AS active, SUM(status = 'archived') AS archived FROM agents WHERE workspace_id = ?", workspaceId);
  const cap = db.get<{ slots: number }>('SELECT COALESCE(SUM(f.slots), 0) AS slots FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.workspace_id = ? AND f.removed_at IS NULL AND b.removed_at IS NULL', workspaceId);
  const active = Number(ag?.active ?? 0); const slots = Number(cap?.slots ?? 0);
  return {
    agents: { active, archived: Number(ag?.archived ?? 0) },
    sectors: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles WHERE workspace_id = ?', workspaceId)?.n ?? 0),
    structures: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM buildings WHERE workspace_id = ? AND removed_at IS NULL AND lot_x IS NOT NULL AND kind IN (${WORK_KINDS.map(() => '?').join(', ')})`, workspaceId, ...WORK_KINDS)?.n ?? 0),
    capacity: { slots, active, free: Math.max(0, slots - active) },
    coordinatorId: db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1', workspaceId)?.id ?? null,
  };
}
