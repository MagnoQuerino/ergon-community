/**
 * A cidade montada a partir das estruturas do servidor: prédios (com andares, plantas e grades de
 * navegação), áreas (ágora, teatro…), ruas e decoração gerada (braseiros nas esquinas, árvores em volta),
 * lotes livres e o roteador que leva alguém de qualquer ponto a qualquer outro — por corredores, escadas,
 * portas e ruas. TypeScript puro: testável sem navegador.
 */
import { CELL, STREET, cityExtent, freeCells, lotBox, typeOf, type Extent, type Placed } from '../../../shared/city.ts';
import { areaDef, type AreaDef } from './areas.ts';
import { FLOOR_H, WALL_T, floorBlocks, footprintBox, interior, planFor, specOf, stairEnds, stairPath, type BuildingSpec, type FloorPlan } from './buildings.ts';
import { grow, inBox, shiftBox, type Box, type P3, type Vec2 } from './geom.ts';
import { NavGrid } from './nav.ts';
import { GRECIA_CLASSICA, pick, rng, seedOf, type DecorKind, type GraphicPack } from './pack.ts';

export interface StructureIn { id: string; kind: string; name: string; i: number; j: number; floors: Array<{ id: string; level: number; slots: number }> }
export interface FloorInst { id: string; level: number; slots: number; plan: FloorPlan; nav: NavGrid; y: number }
export interface Door { inside: Vec2; threshold: Vec2; edge: Vec2; outside: Vec2 } // mundo
export interface BuildingInst {
  id: string; kind: string; name: string; spec: BuildingSpec; i: number; j: number;
  ox: number; oz: number; base: number;
  floors: FloorInst[];
  lot: Box; foot: Box; walls: Box; // mundo
  doors: Door[];
}
export interface AreaInst { id: string; kind: string; name: string; def: AreaDef; ox: number; oz: number; lot: Box; i: number; j: number }
export interface Loc { b: string | null; level: number }
/** k: tamanho; v: variante (forma da pedra, inclinação do pinheiro) */
export interface DecorProp { kind: DecorKind; x: number; z: number; k: number; v?: number }
/** Trecho de rua entre dois cruzamentos da grade, com o traçado sinuoso já calculado (pontos no mundo) e a largura. */
export interface Road { a: [number, number]; b: [number, number]; pts: Vec2[]; w: number }
/** Cruzamento ou ponta de rua: um largo redondo que junta os trechos sem quina. */
export interface Junction { x: number; z: number; r: number; degree: number }

const AGENT_R = 0.15;
const OUT_R = 0.2;
/** quanto a rua pode serpentear para cada lado (o lote começa a 1 unidade da linha da grade) */
const ROAD_SWAY = 0.62;

const rnd = rng;

export class Town {
  readonly extent: Extent;
  readonly bounds: Box;
  readonly buildings = new Map<string, BuildingInst>();
  readonly areas = new Map<string, AreaInst>();
  /** todas as faixas de rua possíveis da grade (a malha de lotes); as desenhadas são as `roads` */
  readonly streets: Box[] = [];
  /** ruas de verdade: só onde servem (frente das estruturas e o que as liga), com traçado sinuoso */
  readonly roads: Road[] = [];
  readonly junctions: Junction[] = [];
  readonly decor: DecorProp[] = [];
  readonly lots: Array<{ i: number; j: number; box: Box }> = [];
  readonly nav: NavGrid;
  readonly placed: Placed[];
  /** o pacote gráfico de onde sai a paisagem gerada (padrão: Grécia Clássica) */
  readonly pack: GraphicPack;

  constructor(structs: StructureIn[], pack: GraphicPack = GRECIA_CLASSICA) {
    this.pack = pack;
    this.placed = structs.filter((s) => typeOf(s.kind)).map((s) => ({ id: s.id, kind: s.kind, i: s.i, j: s.j }));
    const e = this.extent = cityExtent(this.placed);
    this.bounds = { x0: e.i0 * CELL - STREET, z0: e.j0 * CELL - STREET, x1: e.i1 * CELL + STREET, z1: e.j1 * CELL + STREET };
    for (const s of structs) {
      const t = typeOf(s.kind); if (!t) continue;
      const [w, d] = t.footprint; const lot = lotBox(s.i, s.j, w, d);
      if (t.category === 'trabalho') this.buildings.set(s.id, this.makeBuilding(s, lot));
      else { const def = areaDef(s.kind); if (def) this.areas.set(s.id, { id: s.id, kind: s.kind, name: s.name, def, ox: (lot.x0 + lot.x1) / 2, oz: (lot.z0 + lot.z1) / 2, lot, i: s.i, j: s.j }); }
    }
    for (const [i, j] of freeCells(this.placed)) this.lots.push({ i, j, box: lotBox(i, j, 1, 1) });
    this.makeStreets();
    this.makeRoads();
    this.makeDecor();
    this.nav = this.makeCityNav();
  }

  // ---------------------------------------------------------------- prédios
  private makeBuilding(s: StructureIn, lot: Box): BuildingInst {
    const spec = specOf(s.kind);
    const back = spec.D / 2 + spec.plinth;
    const frontEdge = spec.D / 2 + Math.max(spec.plinth, spec.porch);
    const front = frontEdge + (spec.steps?.depth ?? 0.3);
    const right = spec.W / 2 + spec.plinth + (spec.sideSteps?.depth ?? 0);
    const left = spec.W / 2 + spec.plinth;
    const ox = (lot.x0 + lot.x1) / 2 + (left - right) / 2;
    const oz = lot.z0 + back + ((lot.z1 - lot.z0) - back - front) / 2;
    const floors = [...s.floors].sort((a, b) => a.level - b.level);
    const n = floors.length;
    const fl: FloorInst[] = floors.map((f) => {
      const plan = planFor(s.kind, f.level, f.slots);
      const I = interior(spec);
      const nav = new NavGrid(I, 0.25);
      for (const b of floorBlocks(spec, plan, f.level, n)) nav.block(b, AGENT_R);
      return { id: f.id, level: f.level, slots: f.slots, plan, nav, y: spec.base + f.level * FLOOR_H };
    });
    const doors: Door[] = [];
    const dz = spec.D / 2; const zEdge = frontEdge; const zOut = front + 0.55;
    doors.push({
      inside: [ox + spec.door.x, oz + dz - WALL_T - 0.45], threshold: [ox + spec.door.x, oz + dz], edge: [ox + spec.door.x, oz + zEdge],
      outside: [ox + spec.door.x, oz + zOut],
    });
    if (spec.sideDoor) {
      const xe = spec.W / 2 + spec.plinth; const xo = xe + (spec.sideSteps?.depth ?? 0.3) + 0.55;
      doors.push({ inside: [ox + spec.W / 2 - WALL_T - 0.45, oz + spec.sideDoor.z], threshold: [ox + spec.W / 2, oz + spec.sideDoor.z], edge: [ox + xe, oz + spec.sideDoor.z], outside: [ox + xo, oz + spec.sideDoor.z] });
    }
    return {
      id: s.id, kind: s.kind, name: s.name, spec, i: s.i, j: s.j, ox, oz, base: spec.base, floors: fl, lot,
      foot: shiftBox(footprintBox(spec), ox, oz), walls: shiftBox({ x0: -spec.W / 2, z0: -spec.D / 2, x1: spec.W / 2, z1: spec.D / 2 }, ox, oz), doors,
    };
  }

  floorOf(b: BuildingInst, level: number): FloorInst | undefined { return b.floors.find((f) => f.level === level); }
  areaOf(kind: string): AreaInst | null { for (const a of this.areas.values()) if (a.kind === kind) return a; return null; }

  // ---------------------------------------------------------------- ruas e decoração gerada
  private ownerOf(i: number, j: number): string | null {
    for (const p of this.placed) { const t = typeOf(p.kind)!; if (i >= p.i && i < p.i + t.footprint[0] && j >= p.j && j < p.j + t.footprint[1]) return p.id; }
    return null;
  }

  private makeStreets(): void {
    const e = this.extent; const h = STREET / 2;
    for (let j = e.j0; j <= e.j1; j++) for (let i = e.i0; i < e.i1; i++) {
      const a = this.ownerOf(i, j - 1); const b = this.ownerOf(i, j);
      if (a && a === b) continue; // dentro de uma estrutura de vários lotes
      this.streets.push({ x0: i * CELL - h, z0: j * CELL - h, x1: (i + 1) * CELL + h, z1: j * CELL + h });
    }
    for (let i = e.i0; i <= e.i1; i++) for (let j = e.j0; j < e.j1; j++) {
      const a = this.ownerOf(i - 1, j); const b = this.ownerOf(i, j);
      if (a && a === b) continue;
      this.streets.push({ x0: i * CELL - h, z0: j * CELL - h, x1: i * CELL + h, z1: (j + 1) * CELL + h });
    }
  }

  /**
   * Ruas só onde servem: a frente de cada estrutura (onde ficam as portas; nos prédios com porta lateral, também o
   * lado) e o caminho mais curto que liga tudo numa rede só. Lote livre não ganha rua em volta — vira campo — e a
   * cidade deixa de parecer um tabuleiro. Cada trecho serpenteia um pouco (sorteado pela posição, estável quando o
   * mapa cresce); os cruzamentos viram largos redondos.
   */
  private makeRoads(): void {
    const e = this.extent;
    type E = { key: string; a: [number, number]; b: [number, number] };
    const valid = new Map<string, E>();
    const nk = (i: number, j: number) => `${i},${j}`;
    const add = (a: [number, number], b: [number, number]) => { const key = `${nk(...a)}|${nk(...b)}`; valid.set(key, { key, a, b }); };
    for (let j = e.j0; j <= e.j1; j++) for (let i = e.i0; i < e.i1; i++) {
      const p = this.ownerOf(i, j - 1); const q = this.ownerOf(i, j);
      if (!(p && p === q)) add([i, j], [i + 1, j]); // não corta uma estrutura de vários lotes
    }
    for (let i = e.i0; i <= e.i1; i++) for (let j = e.j0; j < e.j1; j++) {
      const p = this.ownerOf(i - 1, j); const q = this.ownerOf(i, j);
      if (!(p && p === q)) add([i, j], [i, j + 1]);
    }
    const keep = new Set<string>();
    const want = (a: [number, number], b: [number, number]) => { const k = `${nk(...a)}|${nk(...b)}`; if (valid.has(k)) keep.add(k); };
    for (const p of this.placed) {
      const [w, d] = typeOf(p.kind)!.footprint;
      for (let i = p.i; i < p.i + w; i++) want([i, p.j + d], [i + 1, p.j + d]); // frente (+z): as portas
      if (this.buildings.get(p.id)?.spec.sideDoor) for (let j = p.j; j < p.j + d; j++) want([p.i + w, j], [p.i + w, j + 1]);
    }
    // liga as partes soltas pelo caminho mais curto na malha (uma rede só, de qualquer porta a qualquer outra)
    const adj = new Map<string, Array<{ to: string; edge: string }>>();
    for (const ed of valid.values()) {
      const A = nk(...ed.a); const B = nk(...ed.b);
      (adj.get(A) ?? adj.set(A, []).get(A)!).push({ to: B, edge: ed.key });
      (adj.get(B) ?? adj.set(B, []).get(B)!).push({ to: A, edge: ed.key });
    }
    const comps = (): string[][] => {
      const nodes = new Set<string>(); const g = new Map<string, string[]>();
      for (const k of keep) { const ed = valid.get(k)!; const A = nk(...ed.a); const B = nk(...ed.b); nodes.add(A); nodes.add(B); (g.get(A) ?? g.set(A, []).get(A)!).push(B); (g.get(B) ?? g.set(B, []).get(B)!).push(A); }
      const seen = new Set<string>(); const out: string[][] = [];
      for (const n of nodes) {
        if (seen.has(n)) continue;
        const c: string[] = []; const st = [n]; seen.add(n);
        while (st.length) { const x = st.pop()!; c.push(x); for (const y of g.get(x) ?? []) if (!seen.has(y)) { seen.add(y); st.push(y); } }
        out.push(c);
      }
      return out.sort((a, b) => b.length - a.length);
    };
    for (let guard = 0; guard < 64; guard++) {
      const cs = comps();
      if (cs.length <= 1) break;
      const main = new Set(cs[0]); const others = new Set(cs.slice(1).flat());
      const prev = new Map<string, { from: string; edge: string }>(); const q = [...main]; const seen = new Set(q);
      let hit: string | null = null;
      while (q.length && !hit) {
        const x = q.shift()!;
        for (const { to, edge } of adj.get(x) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to); prev.set(to, { from: x, edge }); q.push(to);
          if (others.has(to)) { hit = to; break; }
        }
      }
      if (!hit) break;
      for (let n: string = hit; prev.has(n); n = prev.get(n)!.from) keep.add(prev.get(n)!.edge);
    }
    const degree = new Map<string, number>();
    for (const k of keep) {
      const ed = valid.get(k)!;
      for (const n of [nk(...ed.a), nk(...ed.b)]) degree.set(n, (degree.get(n) ?? 0) + 1);
      const r = rnd(seedOf(ed.a[0], ed.a[1], ed.b[0], ed.b[1], 1709));
      const A: Vec2 = [ed.a[0] * CELL, ed.a[1] * CELL]; const B: Vec2 = [ed.b[0] * CELL, ed.b[1] * CELL];
      const nrm: Vec2 = ed.a[1] === ed.b[1] ? [0, 1] : [1, 0]; // perpendicular ao trecho
      // sempre algum desvio (nunca uma reta), para um lado ou para o outro
      const amp = (0.35 + r() * 0.65) * ROAD_SWAY * (r() < 0.5 ? -1 : 1); const amp2 = (r() * 2 - 1) * 0.16; const w = 1.4 + r() * 0.25;
      const pts: Vec2[] = [];
      for (let s = 0; s <= 10; s++) {
        const t = s / 10; const off = amp * Math.sin(Math.PI * t) + amp2 * Math.sin(2 * Math.PI * t);
        pts.push([A[0] + (B[0] - A[0]) * t + nrm[0] * off, A[1] + (B[1] - A[1]) * t + nrm[1] * off]);
      }
      this.roads.push({ a: ed.a, b: ed.b, pts, w });
    }
    for (const [n, deg] of degree) {
      const [i, j] = n.split(',').map(Number);
      this.junctions.push({ x: i * CELL, z: j * CELL, r: deg >= 3 ? 1.05 : 0.78, degree: deg });
    }
  }

  /**
   * Paisagem sorteada do pacote gráfico, estável pela posição (o mapa cresce e o que já existia fica no lugar):
   * braseiros nos largos, a borda de árvores e pedras em volta da cidade (irregular, não um muro de árvores) e, em
   * alguns lotes livres, uma árvore ou umas pedras — sem encher.
   */
  private makeDecor(): void {
    const e = this.extent; const pack = this.pack.decor;
    // braseiros: nos largos onde três ou mais ruas se encontram, num canto de fora da rua
    const jkind = pack.junction ?? 'brazier';
    for (const jn of this.junctions) {
      if (jn.degree < 3 || jkind === 'nada') continue;
      const r = rnd(seedOf(jn.x, jn.z, 31));
      if (r() < 0.35) continue;
      const q = Math.floor(r() * 4); const sx = q & 1 ? 1 : -1; const sz = q & 2 ? 1 : -1;
      this.decor.push({ kind: jkind, x: jn.x + sx * 1.25, z: jn.z + sz * 1.25, k: 1, v: Math.floor(r() * 3) });
    }
    // borda: a cada passo sorteado, um elemento do pacote; às vezes um par de ciprestes
    const x0 = e.i0 * CELL - 3.4; const x1 = e.i1 * CELL + 3.4; const z0 = e.j0 * CELL - 3.4; const z1 = e.j1 * CELL + 3.4;
    const edge = (fx: (u: number) => Vec2, len: number, side: number) => {
      for (let u = 0; u <= len;) {
        const r = rnd(seedOf(Math.round(fx(u)[0] * 10), Math.round(fx(u)[1] * 10), side));
        const [x, z] = fx(u); const out = (r() - 0.4) * 0.9;
        const kind = pick(r, pack.border);
        const at = (dx: number, dz: number) => this.decor.push({ kind, x: x + dx, z: z + dz, k: 0.8 + r() * 0.45, v: Math.floor(r() * 3) });
        const o: Vec2 = side === 0 ? [0, -out] : side === 1 ? [0, out] : side === 2 ? [-out, 0] : [out, 0];
        at(o[0], o[1]);
        if (kind === 'cypress' && r() < 0.3) at(o[0] + 0.7, o[1] + 0.5);
        u += 2.7 + r() * 1.1;
      }
    };
    edge((u) => [x0 + u, z0], x1 - x0, 0); edge((u) => [x0 + u, z1], x1 - x0, 1);
    edge((u) => [x0, z0 + 2.4 + u], z1 - z0 - 4, 2); edge((u) => [x1, z0 + 2.4 + u], z1 - z0 - 4, 3);
    // lotes livres: a maioria fica só com o chão; alguns ganham uma árvore ou umas pedras
    for (const l of this.lots) {
      const r = rnd(seedOf(l.i, l.j, 907));
      const kind = pick(r, pack.lot);
      if (kind === 'nada') continue;
      const n = kind === 'rock' && r() < 0.35 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const x = l.box.x0 + 1.2 + r() * (l.box.x1 - l.box.x0 - 2.4); const z = l.box.z0 + 1.2 + r() * (l.box.z1 - l.box.z0 - 2.4);
        this.decor.push({ kind, x, z, k: 0.75 + r() * 0.4, v: Math.floor(r() * 3) });
      }
    }
  }

  private makeCityNav(): NavGrid {
    const g = new NavGrid(this.bounds, 0.5);
    for (const b of this.buildings.values()) g.block(b.foot, OUT_R);
    for (const a of this.areas.values()) {
      const d = a.def;
      for (const bx of d.blocks) g.block(shiftBox(bx, a.ox, a.oz), OUT_R);
      for (const c of d.circles) g.blockCircle(c.x + a.ox, c.z + a.oz, c.r + OUT_R);
      if (d.blockTest) { const t = d.blockTest; const L = a.lot; g.blockWhere((x, z) => inBox(L, x, z) && t(x - a.ox, z - a.oz)); }
    }
    // braseiros, troncos e pedras não se atravessam (arbusto baixo, sim)
    for (const p of this.decor) if (p.kind !== 'bush') g.blockCircle(p.x, p.z, (p.kind === 'brazier' ? 0.25 : p.kind === 'rock' ? 0.3 * p.k : 0.18) + OUT_R);
    return g;
  }

  // ---------------------------------------------------------------- onde está, por onde ir
  /** Em qual prédio e andar está um ponto (ou na cidade). */
  locate(x: number, y: number, z: number): Loc {
    for (const b of this.buildings.values()) {
      if (!inBox(b.walls, x, z, 1e-6)) continue;
      const level = Math.max(0, Math.min(b.floors.length - 1, Math.floor((y - b.base) / FLOOR_H + 0.02)));
      return { b: b.id, level };
    }
    return { b: null, level: 0 };
  }

  /** Caminho em pontos (x, y, z) de um ponto qualquer até `to` (em `toLoc`); `toY` força a altura final (degraus do teatro). */
  route(from: P3, to: Vec2, toLoc: Loc, toY: number | null = null): P3[] {
    const a = this.locate(from[0], from[1], from[2]);
    const out: P3[] = [[from[0], from[1], from[2]]];
    const tb = toLoc.b ? this.buildings.get(toLoc.b) : undefined;
    const fb = a.b ? this.buildings.get(a.b) : undefined;
    if (fb && tb && fb === tb) this.inside(fb, a.level, [from[0], from[2]], toLoc.level, to, out);
    else {
      let cur: Vec2 = [from[0], from[2]];
      if (fb) { const d = this.bestDoor(fb, tb ? tb.doors[0].outside : to); this.inside(fb, a.level, cur, 0, d.inside, out); this.exitDoor(fb, d, out); cur = d.outside; }
      if (tb) {
        const d = this.bestDoor(tb, cur);
        this.outdoor(cur, d.outside, out);
        this.enterDoor(tb, d, out);
        this.inside(tb, 0, d.inside, toLoc.level, to, out);
      } else this.outdoor(cur, to, out);
    }
    const last = out[out.length - 1];
    if (toY !== null) out.push([to[0], toY, to[1]]);
    else if (Math.hypot(last[0] - to[0], last[2] - to[1]) > 1e-4) out.push([to[0], last[1], to[1]]);
    return dedupe(out);
  }

  private bestDoor(b: BuildingInst, toward: Vec2): Door {
    return b.doors.reduce((best, d) => (Math.hypot(d.outside[0] - toward[0], d.outside[1] - toward[1]) < Math.hypot(best.outside[0] - toward[0], best.outside[1] - toward[1]) ? d : best));
  }
  private exitDoor(b: BuildingInst, d: Door, out: P3[]): void {
    out.push([d.threshold[0], b.base, d.threshold[1]], [d.edge[0], b.base, d.edge[1]], [d.outside[0], 0, d.outside[1]]);
  }
  private enterDoor(b: BuildingInst, d: Door, out: P3[]): void {
    out.push([d.edge[0], b.base, d.edge[1]], [d.threshold[0], b.base, d.threshold[1]], [d.inside[0], b.base, d.inside[1]]);
  }

  private outdoor(a: Vec2, b: Vec2, out: P3[]): void {
    const path = this.nav.findPath(a, b) ?? [a, b];
    for (const p of path.slice(1)) out.push([p[0], 0, p[1]]);
  }

  /** Dentro de um prédio, de um andar a outro (pelas escadas), em coordenadas do mundo. */
  private inside(b: BuildingInst, l0: number, p0: Vec2, l1: number, p1: Vec2, out: P3[]): void {
    const L = (p: Vec2): Vec2 => [p[0] - b.ox, p[1] - b.oz];
    const W = (p: Vec2, l: number, h = 0): P3 => [p[0] + b.ox, b.base + l * FLOOR_H + h, p[1] + b.oz];
    const st = b.spec.stair;
    let level = l0; let cur = L(p0);
    const walk = (to: Vec2) => {
      const f = this.floorOf(b, level);
      const path = f ? f.nav.findPath(cur, to) ?? [cur, to] : [cur, to];
      for (const p of path.slice(1)) out.push(W(p, level));
      cur = to;
    };
    let guard = 0;
    while (level !== l1 && st && guard++ < 40) {
      const ends = stairEnds(st); const steps = stairPath(st);
      if (l1 > level) {
        walk(ends.bottom);
        for (const s of steps) out.push(W(s.p, level, s.h));
        level++; cur = ends.top; out.push(W(cur, level));
      } else {
        walk(ends.top);
        for (const s of [...steps].reverse()) out.push(W(s.p, level - 1, s.h));
        level--; cur = ends.bottom; out.push(W(cur, level));
      }
    }
    walk(L(p1));
  }
}

function dedupe(pts: P3[]): P3[] {
  const out: P3[] = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-4) out.push(p); }
  return out;
}

/** Ponto do mundo a partir de coordenadas locais de uma área. */
export const areaPoint = (a: AreaInst, p: Vec2): Vec2 => [p[0] + a.ox, p[1] + a.oz];
/** Ponto do mundo a partir de coordenadas locais de um prédio. */
export const buildingPoint = (b: BuildingInst, p: Vec2): Vec2 => [p[0] + b.ox, p[1] + b.oz];
export { grow };
