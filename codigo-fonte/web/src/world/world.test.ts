import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CATALOG, DEFAULT_LOTS, fitAt, freeCells } from '../../../shared/city.ts';
import { floorBlocks, interior, planFor, specOf, stairBox, stairEnds, type BuildingSpec, type FloorPlan } from './buildings.ts';
import { boxAt, boxesOverlap, inBox, type Box, type P3, type Vec2 } from './geom.ts';
import { NavGrid } from './nav.ts';
import { Town, type StructureIn } from './town.ts';

const WORK = CATALOG.filter((t) => t.category === 'trabalho');

function cityWith(extra: StructureIn[] = []): Town {
  const base: StructureIn[] = Object.entries(DEFAULT_LOTS).map(([kind, [i, j]]) => ({
    id: `s-${kind}`, kind, name: kind, i, j,
    floors: kind === 'stoa' ? [{ id: 'f0', level: 0, slots: 6 }, { id: 'f1', level: 1, slots: 6 }] : [],
  }));
  return new Town([...base, ...extra]);
}

/** Pontos do caminho, a cada 5 cm. */
function samples(path: P3[]): P3[] {
  const out: P3[] = [];
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k]; const b = path[k + 1]; const L = Math.hypot(b[0] - a[0], b[2] - a[2]); const n = Math.max(1, Math.ceil(L / 0.05));
    for (let i = 0; i <= n; i++) { const t = i / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return out;
}
const strictlyIn = (b: Box, x: number, z: number, m = 0.02) => x > b.x0 + m && x < b.x1 - m && z > b.z0 + m && z < b.z1 - m;

function checkFloor(spec: BuildingSpec, plan: FloorPlan, level: number, floors: number): void {
  const I = interior(spec);
  const blocks = floorBlocks(spec, plan, level, floors);
  const nav = new NavGrid(I, 0.25);
  for (const b of blocks) nav.block(b, 0.15);
  const start: Vec2 = level === 0 ? [spec.door.x, spec.D / 2 - 0.3 - 0.45] : stairEnds(spec.stair!).top;
  assert.ok(nav.free(start[0], start[1]), `${spec.kind} ${level}: entrada livre`);
  const targets: Array<[string, Vec2]> = [
    ...plan.desks.flatMap((d, i) => [[`assento ${i}`, d.seat], [`ocioso ${i}`, d.idle]] as Array<[string, Vec2]>),
    ...plan.activities.filter((a) => !a.tour).map((a) => [`atividade ${a.id}`, a.spot] as [string, Vec2]),
    ...plan.chats.flatMap((c, i) => [[`conversa ${i}A`, c], [`conversa ${i}B`, [c[0] + 0.8, c[1] - 0.8]]] as Array<[string, Vec2]>),
    ...plan.meeting.map((m, i) => [`reunião ${i}`, m.spot] as [string, Vec2]),
  ];
  if (spec.stair && level < floors - 1) targets.push(['pé da escada', stairEnds(spec.stair).bottom]);
  for (const [name, p] of targets) {
    assert.ok(inBox(I, p[0], p[1], -0.12), `${spec.kind} ${level}: ${name} dentro das paredes`);
    const path = nav.findPath(start, p);
    assert.ok(path, `${spec.kind} ${level}: ${name} alcançável`);
    const pts = samples(path!.map(([x, z]) => [x, 0, z] as P3));
    // longe das pontas (assento atrás da mesa encosta nela), nenhum ponto atravessa móvel, parede ou escada
    const total = pts.length;
    pts.forEach(([x, , z], k) => {
      if (k < 8 || k > total - 9) return;
      for (const b of blocks) assert.ok(!strictlyIn(b, x, z), `${spec.kind} ${level}: caminho até ${name} atravessa um obstáculo em (${x.toFixed(2)}, ${z.toFixed(2)})`);
    });
  }
  // ninguém senta dentro de um móvel; mesas não se sobrepõem
  for (const d of plan.desks) for (const o of plan.objects.filter((x) => x.blocks)) assert.ok(!strictlyIn(boxAt(o.x, o.z, o.hx, o.hz), d.seat[0], d.seat[1], 0.1), `${spec.kind}: assento dentro de ${o.kind}`);
  const desks = plan.objects.filter((o) => o.blocks);
  for (let i = 0; i < desks.length; i++) for (let j = i + 1; j < desks.length; j++) {
    assert.ok(!boxesOverlap(boxAt(desks[i].x, desks[i].z, desks[i].hx, desks[i].hz), boxAt(desks[j].x, desks[j].z, desks[j].hx, desks[j].hz)), `${spec.kind}: ${desks[i].kind} sobre ${desks[j].kind}`);
  }
  if (spec.stair) for (const o of desks) assert.ok(!boxesOverlap(stairBox(spec.stair), boxAt(o.x, o.z, o.hx, o.hz)), `${spec.kind}: ${o.kind} na escada`);
}

describe('plantas dos prédios (todas as regras vêm dos dados)', () => {
  for (const t of WORK) {
    test(`${t.name}: em todos os andares, assentos, atividades e conversas são alcançáveis sem atravessar móveis`, () => {
      const spec = specOf(t.id);
      for (let floors = 1; floors <= t.floors.max; floors++) for (let level = 0; level < floors; level++) {
        const plan = planFor(t.id, level, t.slotsPerFloor);
        assert.ok(plan.desks.length >= t.slotsPerFloor, `${t.id} ${level}: uma mesa por vaga (${plan.desks.length}/${t.slotsPerFloor})`);
        checkFloor(spec, plan, level, floors);
      }
    });
  }

  test('cada prédio cabe no seu lote, com a porta do lado da rua', () => {
    const base = cityWith();
    for (const x of WORK.filter((w) => w.id !== 'stoa')) {
      let at: [number, number] | null = null;
      for (const [ci, cj] of freeCells(base.placed)) { at = fitAt(base.placed, x.id, ci, cj); if (at) break; }
      assert.ok(at, `${x.id}: há lote`);
      const t = cityWith([{ id: 'novo', kind: x.id, name: x.name, i: at![0], j: at![1], floors: Array.from({ length: x.floors.max }, (_, l) => ({ id: `f${l}`, level: l, slots: x.slotsPerFloor })) }]);
      const b = t.buildings.get('novo')!;
      assert.ok(b.foot.x0 >= b.lot.x0 - 1e-6 && b.foot.x1 <= b.lot.x1 + 1e-6 && b.foot.z0 >= b.lot.z0 - 1e-6 && b.foot.z1 <= b.lot.z1 + 1e-6, `${b.kind} cabe no lote`);
      for (const d of b.doors) {
        assert.ok(t.nav.free(d.outside[0], d.outside[1]), `${b.kind}: saída da porta livre na rua`);
        assert.ok(t.nav.findPath(d.outside, t.buildings.get('s-stoa')!.doors[0].outside), `${b.kind}: chega à Stoa pelas ruas`);
      }
      // de fora até a mesa do último andar, pela porta e pelas escadas
      const top = b.floors[b.floors.length - 1]; const seat = top.plan.desks[0].seat;
      const path = t.route([t.buildings.get('s-stoa')!.doors[0].outside[0], 0, t.buildings.get('s-stoa')!.doors[0].outside[1]], [seat[0] + b.ox, seat[1] + b.oz], { b: b.id, level: top.level });
      assert.ok(Math.abs(path[path.length - 1][1] - top.y) < 1e-6, `${b.kind}: chega no andar ${top.level}`);
    }
  });
});

describe('cidade montada a partir das estruturas', () => {
  const town = cityWith();
  const stoa = town.buildings.get('s-stoa')!;

  test('lotes livres, ruas e decoração gerados; prédio e áreas nos lugares do servidor', () => {
    assert.ok(town.lots.length >= 15);
    assert.ok(town.streets.length > 40);
    assert.ok(town.decor.some((d) => d.kind === 'brazier') && town.decor.some((d) => d.kind === 'cypress'));
    assert.equal(town.areas.size, 5);
    assert.ok(stoa.floors.length === 2);
    // nenhum lote livre encosta numa estrutura
    for (const l of town.lots) for (const b of town.buildings.values()) assert.ok(!boxesOverlap(l.box, b.foot), 'lote livre sobre prédio');
  });

  test('locate: dentro da Stoa (andar pela altura) ou na cidade', () => {
    assert.deepEqual(town.locate(stoa.ox, stoa.base, stoa.oz), { b: stoa.id, level: 0 });
    assert.deepEqual(town.locate(stoa.ox, stoa.base + 3.25, stoa.oz), { b: stoa.id, level: 1 });
    assert.equal(town.locate(stoa.doors[0].outside[0], 0, stoa.doors[0].outside[1]).b, null);
  });

  test('de uma mesa do 1º andar até cada atividade da cidade: pela escada, pela porta e pelas ruas, sem atravessar nada', () => {
    const f1 = stoa.floors[1];
    const seat = f1.plan.desks[2].seat;
    const from: P3 = [seat[0] + stoa.ox, f1.y, seat[1] + stoa.oz];
    for (const a of town.areas.values()) {
      for (const act of a.def.activities) {
        const to: Vec2 = [act.spot[0] + a.ox, act.spot[1] + a.oz];
        const path = town.route(from, to, { b: null, level: 0 });
        assert.ok(path.length > 4, `${a.kind}/${act.id}: caminho`);
        const pts = samples(path);
        const stairUsed = pts.some((p) => p[1] > stoa.base + 0.3 && p[1] < f1.y - 0.3);
        assert.ok(stairUsed, 'desceu pela escada');
        pts.forEach(([x, y, z], k) => {
          if (k < 10 || k > pts.length - 12) return;
          const loc = town.locate(x, y, z);
          if (loc.b) return; // dentro: conferido nas plantas
          for (const b of town.buildings.values()) {
            const onDoor = b.doors.some((d) => Math.abs(x - d.outside[0]) < 0.6 && z > Math.min(d.threshold[1], d.outside[1]) - 0.1 && z < Math.max(d.threshold[1], d.outside[1]) + 0.1)
              || b.doors.some((d) => Math.abs(z - d.outside[1]) < 0.6 && x > Math.min(d.threshold[0], d.outside[0]) - 0.1 && x < Math.max(d.threshold[0], d.outside[0]) + 0.1);
            if (!onDoor) assert.ok(!strictlyIn(b.foot, x, z), `${a.kind}/${act.id}: atravessa ${b.kind} em (${x.toFixed(1)}, ${z.toFixed(1)})`);
          }
          for (const o of town.areas.values()) for (const bx of o.def.blocks) {
            assert.ok(!strictlyIn({ x0: bx.x0 + o.ox, z0: bx.z0 + o.oz, x1: bx.x1 + o.ox, z1: bx.z1 + o.oz }, x, z), `${a.kind}/${act.id}: atravessa obstáculo de ${o.kind}`);
          }
        });
      }
    }
  });

  test('assentos do teatro e casas do bairro alcançáveis da porta da Stoa', () => {
    const door = stoa.doors[0].outside;
    const th = town.areaOf('teatro')!; const ba = town.areaOf('bairro')!;
    for (const s of th.def.seats) assert.ok(town.nav.findPath(door, [s.spot[0] + th.ox, s.spot[1] + th.oz]), 'assento');
    for (const h of ba.def.houses) assert.ok(town.nav.findPath(door, [h.door[0] + ba.ox, h.door[1] + ba.oz]), `casa ${h.id}`);
  });

  test('mover uma área só muda a origem: tudo acompanha', () => {
    const moved = new Town([...[...town.areas.values()].map((a) => ({ id: a.id, kind: a.kind, name: a.name, i: a.kind === 'termas' ? 2 : a.i, j: a.kind === 'termas' ? 5 : a.j, floors: [] })),
      { id: stoa.id, kind: 'stoa', name: 'Stoa', i: stoa.i, j: stoa.j, floors: stoa.floors.map((f) => ({ id: f.id, level: f.level, slots: f.slots })) }]);
    const t0 = town.areaOf('termas')!; const t1 = moved.areaOf('termas')!;
    assert.notEqual(t0.oz, t1.oz);
    const swim = t1.def.activities.find((a) => a.tour)!;
    assert.ok(moved.nav.findPath(moved.buildings.get(stoa.id)!.doors[0].outside, [swim.spot[0] + t1.ox, swim.spot[1] + t1.oz]));
  });
});
