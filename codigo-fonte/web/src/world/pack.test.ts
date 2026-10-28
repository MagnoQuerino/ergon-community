import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_LOTS, typeOf } from '../../../shared/city.ts';
import { figureGrid, lookFor, lookFromSeed } from '../iso/figures.ts';
import { ALEXANDRIA_DIA as T } from '../iso/theme.ts';
import { GRECIA_CLASSICA, rollFigure, seedOf } from './pack.ts';
import { Town, type StructureIn } from './town.ts';

const base = (): StructureIn[] => Object.entries(DEFAULT_LOTS).map(([kind, [i, j]]) => ({
  id: `s-${kind}`, kind, name: kind, i, j, floors: kind === 'stoa' ? [{ id: 'f0', level: 0, slots: 6 }] : [],
}));

describe('bonecos sorteados do pacote gráfico', () => {
  test('a mesma semente dá sempre o mesmo boneco; sementes diferentes, bonecos variados', () => {
    assert.deepEqual(lookFromSeed(12345, '#2f6f8f', T), lookFromSeed(12345, '#2f6f8f', T));
    const grids = new Set<string>();
    for (let s = 1; s <= 120; s++) grids.add(JSON.stringify(figureGrid(lookFromSeed(seedOf(s, 3), '#2f6f8f', T), 'front', 'stand', 0, T)));
    assert.ok(grids.size >= 110, `bonecos diferentes: ${grids.size} de 120`);
  });

  test('só partes do pacote (Grécia Clássica) e todas aparecem; combinações estranhas ficam raras', () => {
    const f = GRECIA_CLASSICA.figure;
    const seen = { hair: new Set<string>(), beard: new Set<string>(), head: new Set<string>(), outfit: new Set<string>(), item: new Set<string>() };
    let peplosBeard = 0; let peplos = 0;
    for (let s = 1; s <= 2000; s++) {
      const p = rollFigure(seedOf(s, 11), T.skins.length, T.hairs.length);
      seen.hair.add(p.hairStyle); seen.beard.add(p.beard); seen.head.add(p.headwear); seen.outfit.add(p.outfit); seen.item.add(p.item);
      assert.ok(p.skin >= 0 && p.skin < T.skins.length && p.hair >= 0 && p.hair < T.hairs.length);
      if (p.outfit === 'peplos') { peplos++; if (p.beard !== 'none') peplosBeard++; }
    }
    assert.deepEqual([...seen.hair].sort(), f.hairStyles.map(([v]) => v).sort());
    assert.deepEqual([...seen.beard].sort(), f.beards.map(([v]) => v).sort());
    assert.deepEqual([...seen.head].sort(), f.headwear.map(([v]) => v).sort());
    assert.deepEqual([...seen.outfit].sort(), f.outfits.map(([v]) => v).sort());
    assert.deepEqual([...seen.item].sort(), f.items.map(([v]) => v).sort());
    assert.ok(!seen.item.has('spear'), 'a lança é do general (Alexandre), não do sorteio');
    assert.ok(peplosBeard / peplos < 0.1, 'barba com peplo é rara');
  });

  test('roupas e chapéus novos ficam dentro da grade e mudam o desenho; a cor da roupa é a do agente', () => {
    const lk = lookFromSeed(1, '#aa3322', T);
    for (const outfit of ['chiton', 'exomis', 'peplos'] as const) for (const headwear of ['none', 'fillet', 'petasos', 'wreath'] as const) {
      for (const pose of ['stand', 'walk', 'sit', 'perch'] as const) {
        const g = figureGrid({ ...lk, outfit, headwear, hem: true, beard: true, beardShort: true, hairStyle: 'ponytail' }, 'front', pose, 1, T);
        assert.equal(g.length, 50); assert.ok(g.every((row) => row.length === 30));
      }
    }
    const one = (o: object) => JSON.stringify(figureGrid({ ...lk, ...o }, 'front', 'stand', 0, T));
    assert.notEqual(one({ outfit: 'exomis' }), one({ outfit: 'chiton' }));
    assert.notEqual(one({ outfit: 'peplos' }), one({ outfit: 'chiton' }));
    assert.notEqual(one({ headwear: 'petasos' }), one({ headwear: 'none' }));
    assert.equal(lk.drape[0], lookFromSeed(999, '#aa3322', T).drape[0], 'mesma cor de roupa para o mesmo agente');
  });

  test('personagem da equipe mantém a iconografia; com semente, vira o boneco sorteado', () => {
    const ari = { name: 'Aristóteles', color: '#2f4f8f', key: 'aristoteles' };
    assert.equal(lookFor(ari, T).beard, true);
    assert.deepEqual(lookFor({ ...ari, seed: 77 }, T), lookFromSeed(77, ari.color, T));
  });
});

describe('ruas onde servem, sinuosas, e paisagem estável quando o mapa cresce', () => {
  const town = new Town(base());
  const nk = (p: [number, number]) => `${p[0]},${p[1]}`;

  test('uma rede só, ligando a frente de toda estrutura; bem menos rua que a malha (sem tabuleiro)', () => {
    assert.ok(town.roads.length > 4);
    assert.ok(town.roads.length < town.streets.length / 2, `ruas ${town.roads.length} × malha ${town.streets.length}`);
    const g = new Map<string, string[]>();
    for (const r of town.roads) { const a = nk(r.a); const b = nk(r.b); (g.get(a) ?? g.set(a, []).get(a)!).push(b); (g.get(b) ?? g.set(b, []).get(b)!).push(a); }
    const start = [...g.keys()][0]; const seen = new Set([start]); const st = [start];
    while (st.length) for (const y of g.get(st.pop()!) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); }
    assert.equal(seen.size, g.size, 'todas as ruas ligadas');
    // a frente (+z, onde ficam as portas) de toda estrutura tem rua — a não ser que outra estrutura encoste ali
    for (const p of town.placed) {
      const [w, d] = typeOf(p.kind)!.footprint;
      const front = (i: number) => town.roads.some((r) => r.a[1] === p.j + d && r.b[1] === p.j + d && r.a[0] === i);
      assert.ok(Array.from({ length: w }, (_, k) => p.i + k).every(front), `${p.kind}: rua em toda a frente`);
    }
  });

  test('cada trecho serpenteia (nunca uma reta) e começa e termina no cruzamento', () => {
    for (const r of town.roads) {
      const [ax, az] = r.pts[0]; const [bx, bz] = r.pts[r.pts.length - 1];
      assert.deepEqual([ax, az], [r.a[0] * 8, r.a[1] * 8]); assert.ok(Math.hypot(bx - r.b[0] * 8, bz - r.b[1] * 8) < 1e-9);
      const mid = r.pts[Math.floor(r.pts.length / 2)];
      const off = r.a[1] === r.b[1] ? Math.abs(mid[1] - r.a[1] * 8) : Math.abs(mid[0] - r.a[0] * 8);
      assert.ok(off > 0.15 && off < 0.9, `desvio ${off.toFixed(2)}`);
    }
  });

  test('a paisagem de um lote não muda quando a cidade cresce em outro lugar', () => {
    const grown = new Town([...base(), { id: 'nova', kind: 'oikos', name: 'Casa', i: 6, j: 0, floors: [{ id: 'fn', level: 0, slots: 2 }] }]);
    const inLot = (t: Town, i: number, j: number) => t.decor.filter((d) => d.kind !== 'brazier' && d.x > i * 8 && d.x < (i + 1) * 8 && d.z > j * 8 && d.z < (j + 1) * 8);
    for (const l of town.lots.filter((x) => !(x.i === 6 && x.j === 0))) assert.deepEqual(inLot(grown, l.i, l.j), inLot(town, l.i, l.j));
    assert.ok(town.decor.every((d) => ['brazier', ...GRECIA_CLASSICA.decor.border.map(([k]) => k), ...GRECIA_CLASSICA.decor.lot.map(([k]) => k)].includes(d.kind)), 'só elementos do pacote');
  });
});
