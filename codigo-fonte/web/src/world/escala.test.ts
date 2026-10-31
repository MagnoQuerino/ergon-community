/**
 * Cidade em escala (docs/CIDADE_ESCALA.md): lotes livres e "onde estou" por índice dão o mesmo resultado da varredura
 * de antes; a rede de ruas fica inteira mesmo com centenas de ilhas (o teto de 64 rodadas saiu); a busca de rota
 * reaproveitada dá o mesmo caminho em chamadas seguidas.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LOTS, cityExtent, fitAt, freeCells, typeOf, type Placed } from '../../../shared/city.ts';
import { NavGrid } from './nav.ts';
import { Town, type StructureIn } from './town.ts';

const st = (id: string, kind: string, i: number, j: number, floors = 2): StructureIn => ({ id, kind, name: kind, i, j, floors: Array.from({ length: floors }, (_, l) => ({ id: `${id}-f${l}`, level: l, slots: 6 })) });
const base = () => Object.entries(DEFAULT_LOTS).map(([kind, [i, j]], n) => st(`b${n}`, kind, i, j));
const spaced = (n: number) => { const list = base(); let k = 0; for (let j = 8; k < n; j += 2) for (let i = -20; i <= 20 && k < n; i += 2) list.push(st(`c${k++}`, 'oikos', i, j, 1)); return list; };
const placedOf = (s: StructureIn[]): Placed[] => s.map((x) => ({ id: x.id, kind: x.kind, i: x.i, j: x.j }));

// referência: a varredura de antes (cada lote contra todas as estruturas)
function freeRef(placed: Placed[]): Array<[number, number]> {
  const e = cityExtent(placed); const out: Array<[number, number]> = [];
  for (let j = e.j0; j < e.j1; j++) for (let i = e.i0; i < e.i1; i++) {
    if (!placed.some((p) => { const [w, d] = typeOf(p.kind)!.footprint; return i >= p.i && i < p.i + w && j >= p.j && j < p.j + d; })) out.push([i, j]);
  }
  return out;
}

test('lotes livres por índice: mesma lista, na mesma ordem (o servidor depende dela)', () => {
  for (const s of [base(), spaced(40), spaced(300)]) assert.deepEqual(freeCells(placedOf(s)), freeRef(placedOf(s)));
  // cidade que cresce: a cada estrutura nova, igual à referência
  const list = base();
  for (let k = 0; k < 30; k++) {
    const p = placedOf(list); let at: [number, number] | null = null;
    for (const [ci, cj] of freeCells(p)) { at = fitAt(p, ['stoa', 'oikos', 'emporion'][k % 3], ci, cj); if (at) break; }
    if (!at) break;
    list.push(st(`g${k}`, ['stoa', 'oikos', 'emporion'][k % 3], at[0], at[1]));
    assert.deepEqual(freeCells(placedOf(list)), freeRef(placedOf(list)));
  }
});

test('"onde estou" pelos lotes em volta: igual à varredura de todos os prédios', () => {
  for (const s of [base(), spaced(200)]) {
    const t = new Town(s);
    const linear = (x: number, y: number, z: number) => {
      for (const b of t.buildings.values()) if (x >= b.walls.x0 - 1e-6 && x <= b.walls.x1 + 1e-6 && z >= b.walls.z0 - 1e-6 && z <= b.walls.z1 + 1e-6) return b.id;
      return null;
    };
    for (let x = t.bounds.x0; x < t.bounds.x1; x += 0.73) for (let z = t.bounds.z0; z < t.bounds.z1; z += 0.91) assert.equal(t.locate(x, 0.5, z).b, linear(x, 0.5, z), `(${x}, ${z})`);
  }
});

const components = (t: Town) => {
  const g = new Map<string, string[]>();
  for (const r of t.roads) { const A = r.a.join(','); const B = r.b.join(','); (g.get(A) ?? g.set(A, []).get(A)!).push(B); (g.get(B) ?? g.set(B, []).get(B)!).push(A); }
  const seen = new Set<string>(); let n = 0;
  for (const s of g.keys()) { if (seen.has(s)) continue; n++; const st2 = [s]; seen.add(s); while (st2.length) { const x = st2.pop()!; for (const y of g.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st2.push(y); } } }
  return n;
};

test('rede de ruas inteira mesmo com centenas de ilhas (sem o teto de 64 rodadas)', () => {
  for (const n of [120, 600]) {
    const t = new Town(spaced(n));
    assert.equal(components(t), 1, `${n} casas espaçadas: uma rede só`);
    for (const b of t.buildings.values()) {
      const [w, d] = typeOf(b.kind)!.footprint;
      assert.ok(t.roads.some((r) => r.a[1] === b.j + d && r.b[1] === b.j + d && r.a[0] >= b.i && r.b[0] <= b.i + w), `${b.id}: rua na frente`);
    }
  }
});

test('busca de rota com memória reaproveitada: o mesmo caminho em chamadas seguidas e numa grade nova', () => {
  const t = new Town(spaced(60));
  const b = [...t.buildings.values()];
  const ask = (k: number): Array<[number, number]> => [[b[k].doors[0].outside[0], b[k].doors[0].outside[1]], [b[(k * 7 + 3) % b.length].doors[0].outside[0], b[(k * 7 + 3) % b.length].doors[0].outside[1]]];
  const fresh = () => { const g = new NavGrid(t.bounds, 0.5); g.blocked.set(t.nav.blocked); return g; };
  for (let k = 0; k < 20; k++) {
    const [a, c] = ask(k);
    const p1 = t.nav.findPath(a, c); const p2 = t.nav.findPath(a, c);
    assert.deepEqual(p1, p2);
    assert.deepEqual(p1, fresh().findPath(a, c));
  }
});
