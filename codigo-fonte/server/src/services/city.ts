/**
 * Cidade por região (docs/CIDADE_REGIOES.md): a cidade inteira sem nenhum agente (as construções com as contagens de
 * cada andar) e os moradores por partes — todos, por andar, por construção ou pelo id. A vaga e a casa de cada um
 * saem daqui com a mesma regra que o navegador aplicava sobre a equipe inteira (AmbienteView e o motor da cena),
 * então a cidade pequena fica idêntica e a grande carrega só o que está perto da tela.
 *
 * - Conjunto: o mesmo do perfil completo de antes (agentes ativos com andar e setor; andares removidos não saem).
 * - Vaga: a posição do agente entre os ativos do mesmo par (construção, nível), por chegada (created_at, rowid). A
 *   partição é sempre a inteira, mesmo num pedido por andar ou por id.
 * - Casa: a posição na cidade inteira (construção em ordem binária, nível, vaga), RESIDENTS_PER_HOUSE por casa.
 */
import { RESIDENTS_PER_HOUSE } from '../../../shared/city.ts';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { listStructures, type StructureInfo } from './structures.ts';
import { LITE_COLS, decodeCursor, encodeCursor, lastOutcomeOf, runStatusOf, type AgentLite } from './team-query.ts';

/** Limites de cada pedido (o transporte, não quantos agentes existem: o resto vem por páginas ou noutro pedido). */
export const CITY_LIMITS = { page: 2000, floors: 100, buildings: 64, ids: 200, per: 50 };

export interface CityAgent extends AgentLite {
  building_id: string; floor_id: string; level: number; slot: number; house: number;
  run_status: 'queued' | 'running' | 'waiting_user' | null; last_outcome: string | null;
}
export interface CityAgentsPage { total: number; agents: CityAgent[]; next: string | null }
export type CityQuery =
  | { mode: 'all'; cursor?: string }
  | { mode: 'floors'; floors: string[] }
  | { mode: 'buildings'; buildings: string[]; per?: number }
  | { mode: 'ids'; ids: string[] };

const SET = `FROM agents a JOIN floors f ON f.id = a.floor_id JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.status = 'active'`;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Quantos ativos no workspace: o mesmo conjunto dos moradores (decide entre a cidade inteira e por região). */
export function cityTotal(db: Db, workspaceId: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n ${SET}`, workspaceId)?.n ?? 0);
}

/** GET /api/city/overview: todas as construções com as contagens por andar e o total de ativos. */
export function cityOverview(db: Db, workspaceId: string): { total: number; structures: StructureInfo[] } {
  return { total: cityTotal(db, workspaceId), structures: listStructures(db, workspaceId) };
}

/**
 * Ativos de cada par (construção, nível), na ordem da casa. A base de um par é a soma dos anteriores: a posição do
 * primeiro morador dele na cidade inteira. Conta por andar (índice dos moradores) e junta os andares do mesmo nível.
 */
function bases(db: Db, workspaceId: string): { base: Map<string, number>; count: Map<string, number>; total: number } {
  const base = new Map<string, number>(); const count = new Map<string, number>(); let total = 0;
  for (const r of db.all<{ b: string; l: number; n: number }>(
    `SELECT f.building_id AS b, f.level AS l, COUNT(*) AS n ${SET} GROUP BY f.building_id, f.level ORDER BY f.building_id, f.level`, workspaceId)) {
    const k = `${r.b}|${Number(r.l)}`;
    base.set(k, total); count.set(k, Number(r.n)); total += Number(r.n);
  }
  return { base, count, total };
}

type Row = Omit<CityAgent, 'house'>;

/**
 * Moradores para a cena, num modo por pedido (docs/CIDADE_REGIOES.md): todos (páginas de 2.000), os de alguns andares,
 * os de algumas construções (com `per`, só as primeiras vagas de cada andar) ou alguns pelo id. Ordem: construção
 * (binária), nível, vaga. `total`: quantos o modo tem no banco, sem `per` e sem página.
 */
export function cityAgents(db: Db, workspaceId: string, q: CityQuery): CityAgentsPage {
  const { base, count, total: all } = bases(db, workspaceId);
  // a partição inteira de cada par pedido (a vaga não depende do que foi pedido) e, por fora, o que volta
  let universe = ''; const uargs: string[] = [];
  const pick: string[] = []; const pargs: Array<string | number> = [];
  let limit: number | null = null;
  if (q.mode === 'floors') {
    universe = `AND (f.building_id, f.level) IN (SELECT g.building_id, g.level FROM floors g WHERE g.workspace_id = ? AND g.id IN (${marks(q.floors.length)}))`;
    uargs.push(workspaceId, ...q.floors);
    pick.push(`u.floor_id IN (${marks(q.floors.length)})`); pargs.push(...q.floors);
  } else if (q.mode === 'buildings') {
    universe = `AND f.building_id IN (${marks(q.buildings.length)})`; uargs.push(...q.buildings);
    if (q.per) { pick.push('u.slot < ?'); pargs.push(q.per); }
  } else if (q.mode === 'ids') {
    universe = `AND (f.building_id, f.level) IN (SELECT g.building_id, g.level FROM agents x JOIN floors g ON g.id = x.floor_id
                 WHERE x.workspace_id = ? AND x.status = 'active' AND x.id IN (${marks(q.ids.length)}))`;
    uargs.push(workspaceId, ...q.ids);
    pick.push(`u.id IN (${marks(q.ids.length)})`); pargs.push(...q.ids);
  } else {
    const after = decodeCursor(q.cursor, 3);
    if (after) {
      if (typeof after[0] !== 'string' || !Number.isInteger(after[1]) || !Number.isInteger(after[2])) throw new HttpError(400, 'cursor', 'cursor inválido: recomece a lista');
      pick.push('(u.building_id, u.level, u.slot) > (?, ?, ?)'); pargs.push(after[0] as string, after[1] as number, after[2] as number);
    }
    limit = CITY_LIMITS.page;
  }
  const rows = db.all<Row>(
    `WITH u AS (
       SELECT ${LITE_COLS}, f.building_id, a.floor_id, f.level,
              ROW_NUMBER() OVER (PARTITION BY f.building_id, f.level ORDER BY a.created_at, a.rowid) - 1 AS slot
         ${SET} ${universe})
     SELECT u.*, ${runStatusOf('u.id')} AS run_status, ${lastOutcomeOf('u.id')} AS last_outcome
       FROM u ${pick.length ? `WHERE ${pick.join(' AND ')}` : ''}
      ORDER BY u.building_id, u.level, u.slot ${limit ? 'LIMIT ?' : ''}`,
    workspaceId, ...uargs, ...pargs, ...(limit ? [limit + 1] : []));
  const more = limit !== null && rows.length > limit;
  const page = more ? rows.slice(0, limit!) : rows;
  const agents = page.map((r): CityAgent => {
    const level = Number(r.level); const slot = Number(r.slot);
    return {
      id: r.id, name: r.name, role: r.role, color: r.color, char_key: r.char_key, look_seed: r.look_seed === null ? null : Number(r.look_seed), sector_name: r.sector_name,
      building_id: r.building_id, floor_id: r.floor_id, level, slot,
      house: Math.floor(((base.get(`${r.building_id}|${level}`) ?? 0) + slot) / RESIDENTS_PER_HOUSE),
      run_status: r.run_status, last_outcome: r.last_outcome,
    };
  });
  const last = page.at(-1);
  const asked = q.mode === 'buildings' ? new Set(q.buildings) : null;
  const total = q.mode === 'all' ? all
    : asked ? [...count].reduce((n, [k, c]) => (asked.has(k.slice(0, k.indexOf('|'))) ? n + c : n), 0)
      : agents.length;
  return { total, agents, next: more && last ? encodeCursor([last.building_id, Number(last.level), Number(last.slot)]) : null };
}

/** Lista de ids de um parâmetro ("a,b,c"): sem repetidos, na ordem pedida. */
export function idList(v: string | undefined): string[] {
  return [...new Set((v ?? '').split(',').filter(Boolean))];
}
