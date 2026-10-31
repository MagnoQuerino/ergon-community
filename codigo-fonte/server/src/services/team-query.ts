/**
 * Equipe por partes (docs/EQUIPE_VISUAL.md): a página Equipe não baixa o cadastro inteiro. Cada consulta devolve uma
 * página leve com cursor estável e o total contado no banco; perfil completo, instruções e ferramentas só ao abrir o
 * agente. O tamanho máximo de cada resposta limita o transporte, não quantos agentes ou construções existem.
 * Tudo no escopo do workspace.
 */
import { CATALOG, typeOf } from '../../../shared/city.ts';
import type { Db } from '../db/db.ts';
import { foldText } from '../db/db.ts';
import { HttpError, fold } from '../lib/util.ts';

export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 48;
/** Amostra de um grupo recolhido (setor ou construção): poucos rostos, a contagem diz o resto. */
export const SAMPLE = 4;

const WORK_KINDS = CATALOG.filter((t) => t.category === 'trabalho').map((t) => t.id);
export const ACTIVE_RUN = "('queued', 'running', 'waiting_user')";

/**
 * Status de trabalho de um agente (uma definição só: perfil, listas, Cidade e contagens por andar): o da execução
 * ativa mais antiga, por created_at e rowid. `agent` é a expressão SQL com o id do agente (ex.: 'a.id'). Assim o selo,
 * as janelas e o boneco nunca discordam.
 */
export const runStatusOf = (agent: string) =>
  `(SELECT r.status FROM runs r WHERE r.agent_id = ${agent} AND r.status IN ${ACTIVE_RUN} ORDER BY r.created_at, r.rowid LIMIT 1)`;
/** O último desfecho do agente ('status|finished_at'): a cena reage quando ele muda. */
export const lastOutcomeOf = (agent: string) =>
  `(SELECT r.status || '|' || r.finished_at FROM runs r WHERE r.agent_id = ${agent} AND r.status IN ('succeeded', 'failed', 'cancelled')
     AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC, r.rowid DESC LIMIT 1)`;
/** A lista de ferramentas do agente para json_each (texto que não é uma lista JSON vira lista vazia, como no serviço). */
const TOOLS_ARR = "CASE WHEN json_valid(a.tools) THEN CASE WHEN json_type(a.tools) = 'array' THEN a.tools END END";
const hasTool = (tool: string) => `EXISTS (SELECT 1 FROM json_each(${TOOLS_ARR}) j WHERE j.value = '${tool}')`;

/** Projeção leve de um agente para listas (sem instruções, ferramentas nem modelo). */
export interface TeamAgent {
  id: string; name: string; role: string; color: string; status: 'active' | 'archived'; demo: boolean; coordinator: boolean;
  char_key: string | null; look_seed: number | null; deactivation_note: string | null;
  sector_key: string; sector_name: string; building_id: string | null; building_name: string | null; floor_name: string | null;
  /** andar da mesa (Localizar na cidade abre esse andar) */
  floor_id: string | null; floor_level: number | null;
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
// os mesmos cursores e limites nas outras páginas (perfis completos, moradores da cidade)
export { encode as encodeCursor, decode as decodeCursor, limitOf as pageLimit };
/** termo de busca para LIKE (sem acento, sem caixa; % e _ literais) */
const like = (q: string) => `%${foldText(q.trim()).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

type AgentRow = Omit<TeamAgent, 'demo' | 'coordinator' | 'look_seed'> & { demo: number; coordinator: number; look_seed: number | null; k: string };
const AGENT_COLS = `a.id, a.name, a.role, a.color, a.status, a.demo, a.coordinator, a.char_key, a.look_seed, a.deactivation_note,
  p.key AS sector_key, p.name AS sector_name, f.building_id, b.name AS building_name, f.name AS floor_name, a.floor_id, f.level AS floor_level, fold(a.name) AS k,
  ${runStatusOf('a.id')} AS run_status`;
const AGENT_FROM = `FROM agents a JOIN profiles p ON p.id = a.profile_id JOIN floors f ON f.id = a.floor_id LEFT JOIN buildings b ON b.id = f.building_id`;
const agentOut = (r: AgentRow): TeamAgent => ({
  id: r.id, name: r.name, role: r.role, color: r.color, status: r.status, demo: Number(r.demo) === 1, coordinator: Number(r.coordinator) === 1,
  char_key: r.char_key, look_seed: r.look_seed === null ? null : Number(r.look_seed), deactivation_note: r.deactivation_note,
  sector_key: r.sector_key, sector_name: r.sector_name, building_id: r.building_id, building_name: r.building_name, floor_name: r.floor_name,
  floor_id: r.floor_id, floor_level: r.floor_level === null ? null : Number(r.floor_level), run_status: r.run_status,
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
            (SELECT COUNT(*) FROM agents a WHERE a.workspace_id = p.workspace_id AND a.profile_id = p.id AND a.status = 'active') AS n
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
    coordinatorId: coordinatorFor(db, workspaceId),
  };
}

/**
 * Quem coordena, no banco: a mesma escolha de services/team.ts (coordinatorOf sobre a equipe ativa por created_at,
 * rowid). Com a marca (o caso de sempre), uma linha pelo índice; os outros critérios só valem em dados antigos.
 */
export function coordinatorFor(db: Db, workspaceId: string): string | null {
  const marked = db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", workspaceId);
  if (marked) return marked.id;
  return db.get<{ id: string }>(
    `SELECT a.id FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.status = 'active'
      ORDER BY CASE WHEN ${hasTool('encaminhar')} THEN 0 WHEN p.key = 'coordenacao' THEN 1 WHEN ${hasTool('delegar')} THEN 2 ELSE 3 END, a.created_at, a.rowid
      LIMIT 1`, workspaceId)?.id ?? null;
}

/**
 * Quem faz a revisão crítica, no banco: a mesma regra e a mesma ordem de services/team.ts (reviewerOf). Quem tem a
 * ferramenta de revisão, tirando `exceptId`; de preferência da qualidade e fora da coordenação. É quem a revisão
 * (services/review.ts) chama de fato, e o nome que as telas mostram.
 */
export function reviewerFor(db: Db, workspaceId: string, exceptId: string | null | undefined): { id: string; name: string } | null {
  const coord = coordinatorFor(db, workspaceId);
  return db.get<{ id: string; name: string }>(
    `SELECT a.id, a.name FROM agents a JOIN profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = ? AND a.status = 'active' AND a.id IS NOT ? AND a.tools LIKE '%revisao%' AND ${hasTool('revisao')}
      ORDER BY CASE WHEN a.id IS ? THEN 2 WHEN p.key = 'qualidade' THEN 0 ELSE 1 END, a.created_at, a.rowid LIMIT 1`,
    workspaceId, exceptId ?? null, coord) ?? null;
}

/** Agente leve embutido nas respostas (conversas, cards, itens, busca): o bastante para o retrato e o nome. */
export interface AgentLite { id: string; name: string; role: string; color: string; char_key: string | null; look_seed: number | null; sector_name: string }
export const LITE_COLS = 'a.id, a.name, a.role, a.color, a.char_key, a.look_seed, p.name AS sector_name';
export const liteOut = (r: AgentLite): AgentLite => ({
  id: r.id, name: r.name, role: r.role, color: r.color, char_key: r.char_key, look_seed: r.look_seed === null ? null : Number(r.look_seed), sector_name: r.sector_name,
});

/** Os agentes citados (pelo id), desativados incluídos: uma consulta só, sem a equipe inteira. */
export function agentsLite(db: Db, workspaceId: string, ids: Iterable<string | null | undefined>): Map<string, AgentLite> {
  const want = [...new Set([...ids].filter((x): x is string => !!x))];
  const out = new Map<string, AgentLite>();
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    for (const r of db.all<AgentLite>(`SELECT ${LITE_COLS} FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.id IN (${part.map(() => '?').join(', ')})`, workspaceId, ...part)) out.set(r.id, liteOut(r));
  }
  return out;
}

/** O que as telas precisam saber da equipe sem a lista inteira (vai no /api/state). */
export interface TeamInfo {
  active: number; archived: number; coordinator: TeamAgent | null; reviewer: { id: string; name: string } | null;
  /** os primeiros ativos que não coordenam, na ordem de antes (construção, andar, chegada): dicas e exemplos da Ajuda */
  others: Array<{ id: string; name: string }>;
}
export const OTHERS = 3;

export function teamInfo(db: Db, workspaceId: string): TeamInfo {
  const ag = db.get<{ active: number; archived: number }>("SELECT SUM(status = 'active') AS active, SUM(status = 'archived') AS archived FROM agents WHERE workspace_id = ?", workspaceId);
  const coord = coordinatorFor(db, workspaceId);
  return {
    active: Number(ag?.active ?? 0), archived: Number(ag?.archived ?? 0),
    coordinator: coord ? teamAgent(db, workspaceId, coord) : null,
    reviewer: reviewerFor(db, workspaceId, null),
    // pelos andares em ordem (índice de construção e nível), parando nos três primeiros: sem ordenar a equipe inteira
    others: db.all<{ id: string; name: string }>(
      `SELECT a.id, a.name FROM floors f CROSS JOIN agents a ON a.floor_id = f.id CROSS JOIN profiles p ON p.id = a.profile_id
        WHERE f.workspace_id = ? AND a.status = 'active' AND a.id IS NOT ? ORDER BY f.building_id, f.level, a.created_at, a.rowid LIMIT ?`, workspaceId, coord, OTHERS)
      .map((r) => ({ id: r.id, name: r.name })),
  };
}

/**
 * Nota de um texto na busca rápida (a mesma de web/src/lib/search.ts): todas as palavras precisam aparecer (sem
 * acento, sem caixa). -1 = não serve; 2 = o texto começa com a primeira palavra; 1 = alguma palavra do texto começa
 * com ela; 0 = aparece no meio.
 */
export function rank(q: string, text: string): number {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const t = fold(text);
  if (!words.length || !words.every((w) => t.includes(w))) return -1;
  return t.startsWith(words[0]) ? 2 : t.split(/[^a-z0-9#]+/).some((p) => p.startsWith(words[0])) ? 1 : 0;
}
export const SEARCH_AGENTS = 6;

/**
 * Agentes da busca rápida (Ctrl+K): os ativos com todas as palavras em nome, papel e setor, ordenados pela nota antes
 * de cortar (empate: a ordem de antes, por construção, andar e chegada). O banco filtra; a nota sai daqui.
 */
export function searchAgents(db: Db, workspaceId: string, q: string, max = SEARCH_AGENTS): AgentLite[] {
  const words = foldText(q.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const rows = db.all<AgentLite>(
    `SELECT ${LITE_COLS} FROM agents a JOIN floors f ON f.id = a.floor_id JOIN profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = ? AND a.status = 'active' AND ${words.map(() => "fold(a.name || ' ' || a.role || ' ' || p.name) LIKE ? ESCAPE '\\'").join(' AND ')}
      ORDER BY f.building_id, f.level, a.created_at, a.rowid`, workspaceId, ...words.map((w) => like(w)));
  return rows.map((r) => ({ r, n: rank(q.trim(), `${r.name} ${r.role} ${r.sector_name}`) })).filter((x) => x.n >= 0)
    .sort((x, y) => y.n - x.n).slice(0, max).map((x) => liteOut(x.r));
}

export const HOLDER_SAMPLE = 3;
/**
 * Quem tem cada ferramenta (Configurações): quantos e até 3 nomes, o Coordenador primeiro e depois pelo nome sem
 * acento. Uma consulta para o catálogo inteiro.
 */
export function toolHolders(db: Db, workspaceId: string): Map<string, { count: number; sample: string[] }> {
  const coord = coordinatorFor(db, workspaceId);
  const out = new Map<string, { count: number; sample: string[] }>();
  for (const r of db.all<{ tool: string; name: string; n: number }>(
    `SELECT tool, name, n FROM (
       SELECT x.tool, x.name, COUNT(*) OVER (PARTITION BY x.tool) AS n,
              ROW_NUMBER() OVER (PARTITION BY x.tool ORDER BY CASE WHEN x.id IS ? THEN 0 ELSE 1 END, x.k, x.id) AS rk
         FROM (SELECT DISTINCT a.id, a.name, fold(a.name) AS k, j.value AS tool FROM agents a, json_each(${TOOLS_ARR}) j
                WHERE a.workspace_id = ? AND a.status = 'active' AND j.type = 'text') x)
      WHERE rk <= ? ORDER BY tool, rk`, coord, workspaceId, HOLDER_SAMPLE)) {
    const h = out.get(r.tool) ?? { count: Number(r.n), sample: [] };
    h.sample.push(r.name);
    out.set(r.tool, h);
  }
  return out;
}
