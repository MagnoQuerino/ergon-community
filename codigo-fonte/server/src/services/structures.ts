/**
 * Estruturas da cidade (tabela `buildings`): onde cada uma fica no mapa, a loja (criar num lote livre),
 * o editor do mapa (mover), remover e adicionar andares. O catálogo e as regras de lote vêm de
 * shared/city.ts, os mesmos que o navegador usa; aqui é a validação de verdade.
 * Versão local: criar estruturas e andares é grátis e sem limite de quantidade (só o máximo de andares
 * de cada tipo). Nada aqui cobra, debita ou simula pagamento.
 */
import { CATALOG, DEFAULT_LOTS, cityExtent, fitAt, freeCells, placeError, typeOf, type Placed, type PlaceError } from '../../../shared/city.ts';
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { runStatusOf } from './team-query.ts';

/** Andar com os agentes ativos e quantos deles estão trabalhando, esperando você ou na fila (janelas, selo e mapa). */
export interface StructureFloor { id: string; level: number; name: string; slots: number; active: number; origin: string; working: number; waiting: number; queued: number }
export interface StructureInfo {
  id: string; kind: string; name: string; i: number; j: number; origin: string;
  floors: StructureFloor[];
}

interface Row { id: string; kind: string; name: string; lot_x: number | null; lot_z: number | null; origin: string }

const CIVIC = ['agora', 'teatro', 'termas', 'ginasio', 'bairro'];
const PLACE_MSG: Record<PlaceError, string> = {
  unknown_kind: 'tipo de estrutura desconhecido',
  outside: 'fora da área de lotes da cidade',
  occupied: 'o lote (ou parte da pegada) já está ocupado',
  unique: 'só pode haver uma desta na cidade',
};

function rows(db: Db, workspaceId: string): Row[] {
  return db.all<Row>('SELECT id, kind, name, lot_x, lot_z, origin FROM buildings WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at, rowid', workspaceId);
}
const placedOf = (rs: Row[]): Placed[] => rs.filter((r) => r.lot_x !== null && r.lot_z !== null).map((r) => ({ id: r.id, kind: r.kind, i: Number(r.lot_x), j: Number(r.lot_z) }));

/**
 * Garante a cidade inicial (idempotente): dá lote às construções sem posição (a Stoa das versões anteriores)
 * e cria as áreas da cidade que faltam — ágora, teatro, termas, ginásio e bairro — nos lugares de sempre.
 */
export function ensureCity(db: Db, bus: Bus | null, workspaceId: string): string[] {
  const changed: string[] = [];
  db.tx(() => {
    const rs = rows(db, workspaceId);
    const placed = placedOf(rs);
    const put = (r: { id: string; kind: string }) => {
      const def = DEFAULT_LOTS[r.kind];
      let at: [number, number] | null = def && placeError(placed, r.kind, def[0], def[1]) === null ? def : null;
      if (!at) for (const [ci, cj] of freeCells(placed)) { at = fitAt(placed, r.kind, ci, cj); if (at) break; }
      if (!at) return;
      db.run('UPDATE buildings SET lot_x = ?, lot_z = ? WHERE id = ?', at[0], at[1], r.id);
      placed.push({ id: r.id, kind: r.kind, i: at[0], j: at[1] });
      changed.push(r.kind);
    };
    for (const r of rs) if (r.lot_x === null || r.lot_z === null) put({ ...r, kind: typeOf(r.kind) ? r.kind : 'stoa' });
    for (const kind of CIVIC) {
      if (rs.some((r) => r.kind === kind)) continue;
      const bid = id('bld');
      db.run("INSERT INTO buildings (id, workspace_id, name, kind, origin, created_at) VALUES (?, ?, ?, ?, 'base', ?)", bid, workspaceId, typeOf(kind)!.name, kind, now());
      put({ id: bid, kind });
    }
    if (changed.length) audit(db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'city.layout', evidence: { placed: changed }, result: 'cidade em lotes' });
  });
  if (changed.length) bus?.publish(workspaceId, 'city.changed', {});
  return changed;
}

/**
 * A cidade inteira sem nenhum agente (GET /api/city/overview e /api/structures): construções na ordem de criação,
 * andares por nível, e por andar os agentes ativos contados pelo status de trabalho de cada um (o mesmo do perfil e
 * da cena: services/team-query.ts runStatusOf). Numa passada: as contagens agrupadas no banco e os andares
 * repartidos por construção num Map (antes, um filtro por construção sobre todos os andares).
 */
export function listStructures(db: Db, workspaceId: string): StructureInfo[] {
  const counts = new Map(db.all<{ floor_id: string; active: number; working: number; waiting: number; queued: number }>(
    `SELECT x.floor_id, COUNT(*) AS active, SUM(x.rs IS 'running') AS working, SUM(x.rs IS 'waiting_user') AS waiting, SUM(x.rs IS 'queued') AS queued
       FROM (SELECT a.floor_id, ${runStatusOf('a.id')} AS rs FROM agents a WHERE a.workspace_id = ? AND a.status = 'active') x
      GROUP BY x.floor_id`, workspaceId).map((c) => [c.floor_id, c]));
  const byBuilding = new Map<string, StructureFloor[]>();
  for (const f of db.all<{ id: string; building_id: string; level: number; name: string; slots: number; origin: string }>(
    'SELECT f.id, f.building_id, f.level, f.name, f.slots, f.origin FROM floors f WHERE f.workspace_id = ? AND f.removed_at IS NULL ORDER BY f.level', workspaceId)) {
    const c = counts.get(f.id);
    const list = byBuilding.get(f.building_id) ?? [];
    if (!list.length) byBuilding.set(f.building_id, list);
    list.push({ id: f.id, level: Number(f.level), name: f.name, slots: Number(f.slots), active: Number(c?.active ?? 0), origin: f.origin,
      working: Number(c?.working ?? 0), waiting: Number(c?.waiting ?? 0), queued: Number(c?.queued ?? 0) });
  }
  return rows(db, workspaceId).filter((r) => r.lot_x !== null).map((r) => ({
    id: r.id, kind: r.kind, name: r.name, i: Number(r.lot_x), j: Number(r.lot_z), origin: r.origin, floors: byBuilding.get(r.id) ?? [],
  }));
}

const floorName = (level: number) => (level === 0 ? 'Térreo' : `${level}º andar`);

/** Loja (versão local): cria a estrutura no lote, com os andares iniciais do tipo. Grátis, sem limite de quantidade. */
export function createStructure(db: Db, bus: Bus, workspaceId: string, actorUserId: string, input: { kind: string; i: number; j: number; name?: string }): string {
  const t = typeOf(input.kind);
  if (!t || !t.store) throw new HttpError(400, 'kind', 'tipo de estrutura indisponível na loja');
  const bid = db.tx(() => {
    const rs = rows(db, workspaceId);
    const err = placeError(placedOf(rs), t.id, input.i, input.j);
    if (err) throw new HttpError(409, err, PLACE_MSG[err]);
    const same = rs.filter((r) => r.kind === t.id).length;
    const name = (input.name ?? '').trim() || (same ? `${t.name} ${same + 1}` : t.name);
    if (name.length > 60) throw new HttpError(400, 'name', 'nome: até 60 caracteres');
    const bid = id('bld'); const ts = now();
    db.run("INSERT INTO buildings (id, workspace_id, name, kind, lot_x, lot_z, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, 'local', ?)",
      bid, workspaceId, name, t.id, input.i, input.j, ts);
    for (let level = 0; level < t.floors.initial; level++) {
      db.run("INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, 'base', ?)",
        id('flr'), workspaceId, bid, level, floorName(level), t.slotsPerFloor, ts);
    }
    audit(db, null, {
      workspaceId, actorType: 'user', actorId: actorUserId, action: 'structure.create', targetType: 'building', targetId: bid,
      evidence: { kind: t.id, name, lot: [input.i, input.j], floors: t.floors.initial, slots: t.floors.initial * t.slotsPerFloor, payment: 'nenhum (versão local)' }, result: 'ok',
    });
    return bid;
  });
  bus.publish(workspaceId, 'city.changed', { id: bid });
  bus.publish(workspaceId, 'agents.changed', { building: bid });
  return bid;
}

/** Editor do mapa: muda a estrutura de lote (agentes e andares vão junto). */
export function moveStructure(db: Db, bus: Bus, workspaceId: string, actorUserId: string, buildingId: string, i: number, j: number): void {
  db.tx(() => {
    const rs = rows(db, workspaceId);
    const r = rs.find((x) => x.id === buildingId);
    if (!r) throw notFound('estrutura');
    const err = placeError(placedOf(rs), r.kind, i, j, buildingId);
    if (err) throw new HttpError(409, err, PLACE_MSG[err]);
    db.run('UPDATE buildings SET lot_x = ?, lot_z = ? WHERE id = ?', i, j, buildingId);
    audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'structure.move', targetType: 'building', targetId: buildingId, evidence: { from: [r.lot_x, r.lot_z], to: [i, j] }, result: 'ok' });
  });
  bus.publish(workspaceId, 'city.changed', { id: buildingId });
}

export function renameStructure(db: Db, bus: Bus, workspaceId: string, actorUserId: string, buildingId: string, name: string): void {
  const n = name.trim();
  if (!n || n.length > 60) throw new HttpError(400, 'name', 'nome: 1–60 caracteres');
  const r = db.run('UPDATE buildings SET name = ? WHERE id = ? AND workspace_id = ? AND removed_at IS NULL', n, buildingId, workspaceId);
  if (!r.changes) throw notFound('estrutura');
  audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'structure.rename', targetType: 'building', targetId: buildingId, evidence: { name: n }, result: 'ok' });
  bus.publish(workspaceId, 'city.changed', { id: buildingId });
}

/** Remove uma estrutura criada na loja. Exige nenhum agente ativo nela; a cidade inicial não sai. */
export function removeStructure(db: Db, bus: Bus, workspaceId: string, actorUserId: string, buildingId: string): void {
  db.tx(() => {
    const r = db.get<{ origin: string; kind: string }>('SELECT origin, kind FROM buildings WHERE id = ? AND workspace_id = ? AND removed_at IS NULL', buildingId, workspaceId);
    if (!r) throw notFound('estrutura');
    if (r.origin !== 'local') throw new HttpError(409, 'base_structure', 'As estruturas da cidade inicial podem ser movidas, mas não removidas.');
    const busy = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents a JOIN floors f ON f.id = a.floor_id WHERE f.building_id = ? AND a.status = 'active'", buildingId);
    if (Number(busy?.n ?? 0) > 0) throw new HttpError(409, 'structure_occupied', 'Há agentes nesta estrutura: mude-os de andar ou arquive antes de remover.');
    const ts = now();
    db.run('UPDATE floors SET removed_at = ? WHERE building_id = ? AND removed_at IS NULL', ts, buildingId);
    db.run('UPDATE buildings SET removed_at = ? WHERE id = ?', ts, buildingId);
    audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'structure.remove', targetType: 'building', targetId: buildingId, evidence: { kind: r.kind }, result: 'ok' });
  });
  bus.publish(workspaceId, 'city.changed', { id: buildingId });
  bus.publish(workspaceId, 'agents.changed', { building: buildingId });
}

/** Mais um andar num prédio de trabalho (versão local: grátis), até o máximo do tipo e o teto técnico. */
export function addStructureFloor(db: Db, bus: Bus, workspaceId: string, actorUserId: string, buildingId: string, cap: number): string {
  const fid = db.tx(() => {
    const b = db.get<{ kind: string }>('SELECT kind FROM buildings WHERE id = ? AND workspace_id = ? AND removed_at IS NULL', buildingId, workspaceId);
    if (!b) throw notFound('estrutura');
    const t = typeOf(b.kind);
    if (!t || t.category !== 'trabalho') throw new HttpError(409, 'not_building', 'Esta estrutura não tem andares de trabalho.');
    const info = db.get<{ n: number; top: number | null }>('SELECT COUNT(*) AS n, MAX(level) AS top FROM floors WHERE building_id = ? AND removed_at IS NULL', buildingId);
    const max = Math.min(t.floors.max, cap);
    if (Number(info?.n ?? 0) >= max) throw new HttpError(409, 'max_floors', `${t.name} comporta até ${max} andares.`);
    const level = info?.top === null || info?.top === undefined ? 0 : Number(info.top) + 1;
    const fid = id('flr');
    db.run("INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, 'simulated', ?)",
      fid, workspaceId, buildingId, level, floorName(level), t.slotsPerFloor, now());
    audit(db, null, {
      workspaceId, actorType: 'user', actorId: actorUserId, action: 'floor.add', targetType: 'floor', targetId: fid,
      evidence: { building: buildingId, level, slots: t.slotsPerFloor, payment: 'nenhum (versão local, grátis)' }, result: 'ok',
    });
    return fid;
  });
  bus.publish(workspaceId, 'agents.changed', { floor: fid });
  bus.publish(workspaceId, 'city.changed', { id: buildingId });
  return fid;
}

/**
 * Versão local: sempre cabe mais um agente. Sem vaga, a cidade cresce sozinha — um andar na construção de trabalho
 * mais antiga que ainda pode subir; se nenhuma puder, uma construção nova no lote livre mais perto do centro (a
 * maior que couber). Grátis e registrado no log. Devolve um andar com vaga.
 */
export function growForAgent(db: Db, bus: Bus, workspaceId: string, actorUserId: string, cap: number): string {
  return db.tx(() => {
    const rs = rows(db, workspaceId);
    const note = (what: string) => audit(db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'city.grow', evidence: { what }, result: `mais espaço para um agente novo: ${what} (automático, versão local)` });
    for (const r of rs) {
      const t = typeOf(r.kind);
      if (!t || t.category !== 'trabalho' || r.lot_x === null) continue;
      const n = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM floors WHERE building_id = ? AND removed_at IS NULL', r.id)?.n ?? 0);
      if (n >= Math.min(t.floors.max, cap)) continue;
      const fid = addStructureFloor(db, bus, workspaceId, actorUserId, r.id, cap);
      note(`andar novo em ${r.name}`);
      return fid;
    }
    const placed = placedOf(rs);
    const e = cityExtent(placed);
    const [cx, cj] = [(e.i0 + e.i1) / 2, (e.j0 + e.j1) / 2];
    const cells = freeCells(placed).sort((a, b) => Math.hypot(a[0] - cx, a[1] - cj) - Math.hypot(b[0] - cx, b[1] - cj));
    for (const kind of ['stoa', 'emporion', 'didaskaleion', 'oikos']) {
      for (const [ci, cjj] of cells) {
        const at = fitAt(placed, kind, ci, cjj);
        if (!at) continue;
        const bid = createStructure(db, bus, workspaceId, actorUserId, { kind, i: at[0], j: at[1] });
        note(`${typeOf(kind)!.name} nova`);
        return db.get<{ id: string }>('SELECT id FROM floors WHERE building_id = ? AND removed_at IS NULL ORDER BY level LIMIT 1', bid)!.id;
      }
    }
    throw new HttpError(409, 'capacity_exceeded', 'Não achei lugar na cidade para mais uma construção.');
  });
}

export { CATALOG };
