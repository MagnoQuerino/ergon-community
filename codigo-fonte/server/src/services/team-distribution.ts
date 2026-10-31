/**
 * Organização assistida (docs/EQUIPE_VISUAL.md): uma sugestão de endereços calculada por regra local — sem modelo de
 * IA, sem custo — que junta colegas do mesmo setor na construção onde o setor já é maioria, usando só lugares livres.
 * Muda apenas o endereço (nunca o setor, a função ou o trabalho). A pessoa vê antes/depois, quantos mudariam e os
 * impedimentos, e aplica se quiser: tudo numa transação só (ou nada), conferindo que a equipe não mudou desde a
 * prévia. Desfazer é outra transação, recusada inteira se alguém já tiver mudado de lugar depois.
 */
import crypto from 'node:crypto';
import { CATALOG } from '../../../shared/city.ts';
import type { Db } from '../db/db.ts';
import { HttpError, id } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';

const WORK_KINDS = CATALOG.filter((t) => t.category === 'trabalho').map((t) => t.id);
export const LIST_MAX = 200;

export interface PlannedMove { agentId: string; name: string; sector: string; from: string; fromName: string; to: string; toName: string }
export interface Plan {
  planId: string; total: number; moves: PlannedMove[];
  structures: Array<{ id: string; name: string; before: number; after: number; slots: number }>;
  blocked: Array<{ sector: string; home: string; waiting: number }>;
}

interface Snapshot {
  agents: Array<{ id: string; name: string; sector: string; sectorName: string; building: string; floor: string }>;
  buildings: Map<string, { name: string; slots: number; active: number; order: number }>;
}

function snapshot(db: Db, workspaceId: string): Snapshot {
  const kinds = WORK_KINDS.map(() => '?').join(', ');
  const rows = db.all<{ id: string; created_at: string; name: string; slots: number; active: number }>(
    `SELECT b.id, b.created_at, b.name,
            (SELECT COALESCE(SUM(f.slots), 0) FROM floors f WHERE f.building_id = b.id AND f.removed_at IS NULL) AS slots,
            (SELECT COUNT(*) FROM agents a JOIN floors f ON f.id = a.floor_id WHERE f.building_id = b.id AND f.removed_at IS NULL AND a.status = 'active') AS active
       FROM buildings b WHERE b.workspace_id = ? AND b.removed_at IS NULL AND b.lot_x IS NOT NULL AND b.kind IN (${kinds}) ORDER BY b.created_at, b.id`, workspaceId, ...WORK_KINDS);
  const buildings = new Map(rows.map((r, order) => [r.id, { name: r.name, slots: Number(r.slots), active: Number(r.active), order }]));
  const agents = db.all<{ id: string; name: string; sector: string; sectorName: string; building: string; floor: string }>(
    `SELECT a.id, a.name, p.key AS sector, p.name AS sectorName, f.building_id AS building, a.floor_id AS floor
       FROM agents a JOIN profiles p ON p.id = a.profile_id JOIN floors f ON f.id = a.floor_id
      WHERE a.workspace_id = ? AND a.status = 'active' ORDER BY a.coordinator DESC, fold(a.name), a.id`, workspaceId);
  return { agents, buildings };
}

/** O plano (puro sobre o retrato do banco): a casa de cada setor é onde ele já tem mais gente. */
function compute(s: Snapshot): Omit<Plan, 'planId' | 'moves'> & { all: PlannedMove[] } {
  const free = new Map([...s.buildings].map(([k, b]) => [k, b.slots - b.active]));
  const bySector = new Map<string, Map<string, number>>();
  for (const a of s.agents) {
    if (!s.buildings.has(a.building)) continue;
    const m = bySector.get(a.sector) ?? new Map<string, number>(); m.set(a.building, (m.get(a.building) ?? 0) + 1); bySector.set(a.sector, m);
  }
  const home = new Map<string, string>();
  for (const [sector, m] of bySector) {
    const best = [...m].sort((x, y) => y[1] - x[1] || s.buildings.get(x[0])!.order - s.buildings.get(y[0])!.order)[0];
    if (best) home.set(sector, best[0]);
  }
  const all: PlannedMove[] = []; const waiting = new Map<string, number>(); const sectorName = new Map<string, string>();
  for (const a of s.agents) {
    sectorName.set(a.sector, a.sectorName);
    const h = home.get(a.sector);
    if (!h || h === a.building || !s.buildings.has(a.building)) continue;
    if ((free.get(h) ?? 0) <= 0) { waiting.set(a.sector, (waiting.get(a.sector) ?? 0) + 1); continue; }
    free.set(h, (free.get(h) ?? 0) - 1); free.set(a.building, (free.get(a.building) ?? 0) + 1);
    all.push({ agentId: a.id, name: a.name, sector: a.sectorName, from: a.building, fromName: s.buildings.get(a.building)!.name, to: h, toName: s.buildings.get(h)!.name });
  }
  const delta = new Map<string, number>();
  for (const m of all) { delta.set(m.from, (delta.get(m.from) ?? 0) - 1); delta.set(m.to, (delta.get(m.to) ?? 0) + 1); }
  const structures = [...delta.keys()].map((k) => { const b = s.buildings.get(k)!; return { id: k, name: b.name, before: b.active, after: b.active + (delta.get(k) ?? 0), slots: b.slots }; })
    .sort((x, y) => s.buildings.get(x.id)!.order - s.buildings.get(y.id)!.order);
  const blocked = [...waiting].map(([sector, n]) => ({ sector: sectorName.get(sector) ?? sector, home: s.buildings.get(home.get(sector)!)?.name ?? '—', waiting: n }));
  return { total: all.length, all, structures, blocked };
}

const digest = (moves: PlannedMove[]) => crypto.createHash('sha256').update(moves.map((m) => `${m.agentId}:${m.from}>${m.to}`).join('|')).digest('hex').slice(0, 32);

/** Prévia: o que mudaria, sem gravar nada. A lista mostrada é limitada; o total e o plano inteiro valem. */
export function suggestDistribution(db: Db, workspaceId: string): Plan {
  const p = compute(snapshot(db, workspaceId));
  return { planId: digest(p.all), total: p.total, moves: p.all.slice(0, LIST_MAX), structures: p.structures, blocked: p.blocked };
}

function firstFreeFloor(db: Db, buildingId: string): string | null {
  return db.get<{ id: string }>(`SELECT f.id FROM floors f WHERE f.building_id = ? AND f.removed_at IS NULL
      AND (SELECT COUNT(*) FROM agents a WHERE a.floor_id = f.id AND a.status = 'active') < f.slots ORDER BY f.level LIMIT 1`, buildingId)?.id ?? null;
}

/**
 * Aplica o plano visto na prévia: recalcula, confere que é o mesmo (`planId`) e muda todos numa transação. Se a equipe
 * mudou nesse meio-tempo, nada é aplicado e a pessoa vê a sugestão nova.
 */
export function applyDistribution(db: Db, bus: Bus, workspaceId: string, actorUserId: string, planId: string): { batchId: string; moved: number } {
  const out = db.tx(() => {
    const p = compute(snapshot(db, workspaceId));
    if (digest(p.all) !== planId) throw new HttpError(409, 'plan_changed', 'A equipe mudou desde a sugestão: veja a sugestão de novo antes de aplicar.');
    if (!p.all.length) throw new HttpError(409, 'nothing', 'Nada para mudar: a equipe já está distribuída assim.');
    const done: Array<{ agentId: string; fromFloor: string; toFloor: string; from: string; to: string }> = [];
    for (const m of p.all) {
      const cur = db.get<{ floor_id: string }>('SELECT floor_id FROM agents WHERE id = ? AND workspace_id = ?', m.agentId, workspaceId)!;
      const floor = firstFreeFloor(db, m.to);
      if (!floor) throw new HttpError(409, 'plan_changed', 'Faltou lugar ao aplicar: veja a sugestão de novo.');
      db.run('UPDATE agents SET floor_id = ? WHERE id = ? AND workspace_id = ?', floor, m.agentId, workspaceId);
      done.push({ agentId: m.agentId, fromFloor: cur.floor_id, toFloor: floor, from: m.from, to: m.to });
    }
    const batchId = id('aud');
    audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'team.distribution.apply', targetType: 'batch', targetId: batchId,
      evidence: { moves: done }, result: `${done.length} agente(s) mudaram de endereço pela sugestão de distribuição (setores e trabalhos mantidos)` });
    return { batchId, moved: done.length };
  });
  bus.publish(workspaceId, 'agents.changed', {});
  return out;
}

/** Desfaz uma distribuição aplicada: só se todos ainda estiverem onde ela os pôs (senão, nada muda e diz quem saiu). */
export function undoDistribution(db: Db, bus: Bus, workspaceId: string, actorUserId: string, batchId: string): { moved: number } {
  const out = db.tx(() => {
    const ev = db.get<{ evidence: string | null; created_at: string }>("SELECT evidence, created_at FROM audit_events WHERE workspace_id = ? AND target_id = ? AND action = 'team.distribution.apply'", workspaceId, batchId);
    if (!ev?.evidence) throw new HttpError(404, 'not_found', 'distribuição não encontrada');
    if (db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND target_id = ? AND action = 'team.distribution.undo'", workspaceId, batchId)) throw new HttpError(409, 'already_undone', 'Esta distribuição já foi desfeita.');
    const moves = (JSON.parse(ev.evidence) as { moves: Array<{ agentId: string; fromFloor: string; toFloor: string }> }).moves;
    const moved = moves.filter((m) => db.get<{ floor_id: string; status: string }>('SELECT floor_id, status FROM agents WHERE id = ? AND workspace_id = ?', m.agentId, workspaceId)?.floor_id !== m.toFloor);
    if (moved.length) throw new HttpError(409, 'moved_since', `${moved.length} agente(s) já mudaram de lugar depois: nada foi desfeito, para não sobrescrever essas mudanças.`);
    // na ordem inversa: quem entrou no lugar liberado por outro sai primeiro (as mudanças podem encadear)
    for (const m of [...moves].reverse()) {
      const back = db.get<{ ok: number }>(`SELECT (SELECT COUNT(*) FROM agents WHERE floor_id = f.id AND status = 'active') < f.slots AS ok FROM floors f WHERE f.id = ? AND f.removed_at IS NULL`, m.fromFloor);
      if (!back || !Number(back.ok)) throw new HttpError(409, 'no_room', 'O lugar de antes de alguém já foi ocupado: nada foi desfeito.');
      db.run('UPDATE agents SET floor_id = ? WHERE id = ? AND workspace_id = ?', m.fromFloor, m.agentId, workspaceId);
    }
    audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'team.distribution.undo', targetType: 'batch', targetId: batchId, evidence: { moves: moves.length }, result: `distribuição desfeita: ${moves.length} agente(s) voltaram` });
    return { moved: moves.length };
  });
  bus.publish(workspaceId, 'agents.changed', {});
  return out;
}
