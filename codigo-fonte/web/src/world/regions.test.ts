import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regionSize, regionsOf, type Occ } from './regions.ts';

test('regiões: somas batem com os totais, chaves estáveis quando a cidade cresce', () => {
  const items = Array.from({ length: 500 }, (_, n) => ({ id: `b${n}`, i: (n * 7) % 60 - 20, j: Math.floor(n / 9) - 10, w: 1 + (n % 3 === 0 ? 1 : 0), d: 1 }));
  const occ = new Map<string, Occ>(items.map((s, n) => [s.id, { agents: n % 5, working: n % 2, waiting: n % 7 === 0 ? 1 : 0 }]));
  for (const R of [4, 8, 16]) {
    const rs = regionsOf(items, occ, R);
    const sum = (f: (o: Occ) => number) => [...occ.values()].reduce((a, o) => a + f(o), 0);
    assert.equal(rs.reduce((a, r) => a + r.structures, 0), items.length);
    assert.equal(rs.reduce((a, r) => a + r.agents, 0), sum((o) => o.agents));
    assert.equal(rs.reduce((a, r) => a + r.waiting, 0), sum((o) => o.waiting));
    assert.equal(new Set(rs.map((r) => r.key)).size, rs.length);
  }
  // cresce: as regiões que já existiam mantêm a chave e a posição
  const before = new Map(regionsOf(items.slice(0, 300), occ, 8).map((r) => [r.key, r]));
  const after = regionsOf(items, occ, 8);
  for (const r of after) if (before.has(r.key)) { assert.equal(before.get(r.key)!.ri, r.ri); assert.equal(before.get(r.key)!.rj, r.rj); }
});

test('tamanho da região acompanha o zoom (rótulos sem se encavalar)', () => {
  assert.ok(regionSize(0.13) <= regionSize(0.06));
  assert.ok(regionSize(0.04) * 320 * 0.04 >= 150);
  assert.equal(regionSize(1), 4);
});
