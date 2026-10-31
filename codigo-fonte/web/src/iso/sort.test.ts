import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBoxes, sortItems, type Sortable } from './sort.ts';
import type { AABB } from '../world/geom.ts';

// a versão de pares (antes da grade): referência para provar que a ordem não mudou
const depth = (b: AABB) => (b.x0 + b.x1) / 2 + (b.z0 + b.z1) / 2 + (b.y0 + b.y1) * 0.001;
const overlap = (a: Sortable, b: Sortable) => a.rect[0] < b.rect[2] && b.rect[0] < a.rect[2] && a.rect[1] < b.rect[3] && b.rect[1] < a.rect[3];
function sortRef<T extends Sortable>(items: T[]): T[] {
  const n = items.length;
  if (n < 2) return items.slice();
  const d = items.map((it) => depth(it.box));
  const after: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!overlap(items[i], items[j])) continue;
    let c = compareBoxes(items[i].box, items[j].box);
    if (c === 0) c = d[i] < d[j] ? -1 : d[i] > d[j] ? 1 : i < j ? -1 : 1;
    if (c < 0) { after[i].push(j); indeg[j]++; } else { after[j].push(i); indeg[i]++; }
  }
  const done = new Uint8Array(n); const out: T[] = []; const ready: number[] = [];
  for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
  while (out.length < n) {
    let pick = -1;
    if (ready.length) { let bi = 0; for (let k = 1; k < ready.length; k++) if (d[ready[k]] < d[ready[bi]]) bi = k; pick = ready[bi]; ready.splice(bi, 1); }
    else for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || d[i] < d[pick])) pick = i;
    done[pick] = 1; out.push(items[pick]);
    for (const j of after[pick]) if (!done[j] && --indeg[j] === 0) ready.push(j);
  }
  return out;
}

const rng = (s: number) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
type It = Sortable & { id: number };
function scene(seed: number, n: number, spread: number, big: number): It[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, id) => {
    const x = Math.floor(r() * spread); const z = Math.floor(r() * spread); const w = 1 + Math.floor(r() * big); const h = 1 + Math.floor(r() * 4);
    const px = (x - z) * 16; const py = (x + z) * 8;
    return { id, box: { x0: x, y0: 0, z0: z, x1: x + w, y1: h, z1: z + w }, rect: [px - 16 * w, py - 8 * h - 40, px + 16 * w, py + 8 * w + 4] as [number, number, number, number], draw() {} };
  });
}

test('mesma ordem da versão de pares em cenas aleatórias (esparsas, densas, objetos grandes, empates e ciclos)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    for (const [n, spread, big] of [[40, 30, 2], [120, 12, 3], [200, 60, 6], [80, 5, 2]] as const) {
      const items = scene(seed * 7 + n, n, spread, big);
      assert.deepEqual(sortItems(items).map((x) => x.id), sortRef(items).map((x) => x.id), `semente ${seed}, ${n} objetos`);
    }
  }
});

test('retângulos negativos e enormes (prédio inteiro) entram na grade sem perder pares', () => {
  const items: It[] = [
    { id: 0, box: { x0: -50, y0: 0, z0: -50, x1: 50, y1: 30, z1: 50 }, rect: [-4000, -3000, 4000, 2000], draw() {} },
    ...scene(3, 50, 40, 2).map((x) => ({ ...x, id: x.id + 1, rect: x.rect.map((v) => v - 900) as [number, number, number, number] })),
  ];
  assert.deepEqual(sortItems(items).map((x) => x.id), sortRef(items).map((x) => x.id));
});

test('escala: 3.000 objetos espalhados ordenam bem mais rápido que a versão de pares', () => {
  const items = scene(11, 3000, 600, 2);
  let t = performance.now(); const a = sortItems(items); const tNew = performance.now() - t;
  t = performance.now(); const b = sortRef(items); const tRef = performance.now() - t;
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.ok(tNew < tRef, `grade ${tNew.toFixed(1)} ms × pares ${tRef.toFixed(1)} ms`);
});
