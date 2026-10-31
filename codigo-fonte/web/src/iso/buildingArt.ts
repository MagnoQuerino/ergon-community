/**
 * Arte dos prédios a partir dos dados (world/buildings.ts): fachada fechada de cada estilo, o andar aberto
 * (piso, paredes do fundo e da esquerda com a decoração, móveis ordenáveis, escada e o vão da escada de
 * baixo) e o corte da frente — paredes, colunas e parapeitos cortados na MESMA altura, com o mesmo
 * acabamento. Os andares de cima do aberto viram um holograma (contorno), para o hover e o clique.
 * Tudo é desenhado uma vez em camadas (canvas) por prédio, andar e tema; o motor só compõe.
 *
 * Estilos: stoa, oikos (casa), ergasterion (oficina), pharmakopoleion (farmácia), didaskaleion (escola),
 * oikia (casa grande), emporion (comércio), bouleuterion (câmara) e genérico (tipos de mod sem arte).
 */
import { FLOOR_H, WALL_T, stairBox, type BuildingSpec, type FloorPlan, type WallDecor } from '../world/buildings.ts';
import type { AABB, Box } from '../world/geom.ts';
import type { BuildingInst } from '../world/town.ts';
import { RES, project, type P2, type Rect } from './projection.ts';
import { backQuad, fillPoly, flatQuad, isoBox, line, projector, sideQuad, type Proj, type Tone } from './raster.ts';
import { blob, plantSprite, type Sprite } from './props.ts';
import { antefixes, entablature, meanderBand, orderFor, roundColumnSprite, wallMap, type Order } from './architecture.ts';
import { halfWallSprite, objectSprite, stepSprite } from './furniture.ts';
import { mix, type Theme } from './theme.ts';
import { Lru } from './lru.ts';

export const SLAB = 0.5; // entablamento/laje entre andares (só na Stoa e nos pórticos clássicos)
export const CUT_H = 0.85; // altura única do corte das paredes, colunas e parapeitos do andar aberto
const IN_H = FLOOR_H - 0.4; // altura das paredes internas do andar aberto
export const CUT_STEPS = 4; // degraus visíveis da escada que sobe para um andar oculto

/** `s`: pixels do canvas por pixel do mundo (1 = resolução cheia; menor = cópia reduzida para zoom afastado). */
export interface Layer { canvas: HTMLCanvasElement; x0: number; y0: number; s?: number }
export interface ArtItem { sprite: Sprite; px: number; py: number; box: AABB; hit?: 'board' | 'shelf' | 'conselho' }
export interface HitPoly { kind: 'board' | 'shelf' | 'conselho'; poly: P2[] }
/** Andar para hover e clique: as faces visíveis (frente e direita; o topo só no último andar). */
export interface Band { level: number; faces: P2[][] }
export interface WinQuad { level: number; poly: P2[] }
export interface ClosedArt { layer: Layer; bands: Band[]; windows: WinQuad[]; rect: Rect; top: number }
export interface OpenArt {
  level: number;
  lower: Layer; back: Layer; front: Layer; ghost: Layer | null;
  items: ArtItem[]; hits: HitPoly[];
  bands: Band[]; // andares de baixo (fechados) e os de cima (holograma), para hover e clique
  hole: P2[] | null; // vão da escada de baixo (pixels do mundo): quem sobe aparece por ele
  stairTop: number | null; // altura acima da qual quem sobe a escada do andar some (degraus cortados)
}

// ---------------------------------------------------------------- estilos
type RoofKind = 'flat' | 'parapet' | 'hip' | 'gable' | 'thatch' | 'steep';
interface StyleLook {
  wall: Tone; base: Tone; trim: string; roofKind: RoofKind; roof: Tone;
  inner: { wall: string; side: string; dado: string; trim: string };
  win: { front: number; side: number; shutter: string | null; arched: boolean };
  porch: null | { order: Order | 'by-floor'; n: number; allFloors: boolean };
  extras: Array<'awning' | 'awnings' | 'balcony' | 'asclepius' | 'tools' | 'owl' | 'band' | 'arcade' | 'banners' | 'shopwin' | 'planters' | 'acroteria'>;
}
function lookOf(style: string, t: Theme): StyleLook {
  const L = greekLook(style, t);
  const sk = t.skin?.arch;
  if (!sk) return L;
  // skin: telhado, janelas e enfeites próprios; os enfeites gregos saem quando a skin não usa colunas clássicas
  if (sk.roof !== 'keep') L.roofKind = sk.roof;
  if (sk.columns !== 'classic') { L.win.arched = false; L.extras = L.extras.filter((x) => x !== 'owl' && x !== 'acroteria' && x !== 'asclepius'); }
  L.win.front = Math.min(6, L.win.front + sk.windows.extra);
  L.win.side = Math.min(4, L.win.side + Math.ceil(sk.windows.extra / 2));
  return L;
}
function greekLook(style: string, t: Theme): StyleLook {
  const S = t.stone; const H = t.houseWall; const wb = t.wallBack;
  const tone = (c: string, k = 0.12): Tone => [mix(c, '#ffffff', 0.18), c, mix(c, t.outline, k + 0.12)];
  const ochre = mix(H[1], t.terracotta[0], 0.38);
  switch (style) {
    case 'stoa': return { wall: [S[0], mix(wb, S[1], 0.4), mix(S[2], t.outline, 0.05)], base: S, trim: t.trim, roofKind: 'hip', roof: t.roof, inner: { wall: wb, side: t.wallSide, dado: t.dado, trim: t.trim }, win: { front: 4, side: 2, shutter: null, arched: true }, porch: { order: 'by-floor', n: 4, allFloors: true }, extras: ['banners'] };
    case 'oikos': return { wall: H, base: S, trim: t.stone[2], roofKind: 'hip', roof: t.roof, inner: { wall: H[0], side: H[1], dado: t.terracotta[1], trim: t.terracotta[2] }, win: { front: 2, side: 1, shutter: t.teal[1], arched: false }, porch: null, extras: ['planters'] };
    case 'ergasterion': return { wall: tone(mix(S[1], H[1], 0.4)), base: S, trim: t.woodDark[1], roofKind: 'hip', roof: [mix(t.roof[0], t.outline, 0.12), mix(t.roof[1], t.outline, 0.12), mix(t.roof[2], t.outline, 0.12)], inner: { wall: mix(S[0], H[0], 0.5), side: S[1], dado: t.woodDark[1], trim: t.wood[0] }, win: { front: 1, side: 1, shutter: t.woodDark[0], arched: false }, porch: null, extras: ['awning', 'tools'] };
    case 'pharmakopoleion': return { wall: H, base: S, trim: t.teal[1], roofKind: 'parapet', roof: t.roof, inner: { wall: H[0], side: H[1], dado: t.teal[1], trim: t.teal[0] }, win: { front: 1, side: 1, shutter: t.teal[1], arched: false }, porch: null, extras: ['band', 'asclepius', 'shopwin', 'planters'] };
    case 'didaskaleion': return { wall: tone(mix(S[1], t.sand[0], 0.45)), base: S, trim: t.stone[2], roofKind: 'gable', roof: t.roof, inner: { wall: mix(t.papyrus[0], wb, 0.4), side: mix(t.papyrus[1], t.wallSide, 0.4), dado: t.wood[1], trim: t.bronze[1] }, win: { front: 3, side: 1, shutter: null, arched: true }, porch: { order: 'ionic', n: 4, allFloors: false }, extras: ['owl'] };
    case 'oikia': return { wall: tone(ochre), base: S, trim: mix(ochre, t.outline, 0.35), roofKind: 'hip', roof: t.roof, inner: { wall: mix(ochre, '#ffffff', 0.45), side: mix(ochre, '#ffffff', 0.3), dado: t.terracotta[2], trim: t.gold }, win: { front: 4, side: 1, shutter: t.olive[1], arched: false }, porch: null, extras: ['balcony', 'planters'] };
    case 'emporion': return { wall: tone(mix(H[1], S[1], 0.5)), base: S, trim: t.terracotta[2], roofKind: 'parapet', roof: t.roof, inner: { wall: mix(H[0], t.papyrus[0], 0.3), side: H[1], dado: t.terracotta[1], trim: t.gold }, win: { front: 4, side: 2, shutter: null, arched: false }, porch: null, extras: ['arcade', 'awnings'] };
    case 'bouleuterion': return { wall: [t.marble[0], t.marble[1], t.marble[2]], base: S, trim: t.stone[2], roofKind: 'gable', roof: t.roof, inner: { wall: t.marble[1], side: t.marble[2], dado: t.banner[1], trim: t.gold }, win: { front: 0, side: 2, shutter: null, arched: true }, porch: { order: 'doric', n: 6, allFloors: false }, extras: ['acroteria', 'banners'] };
    default: return { wall: H, base: S, trim: S[2], roofKind: 'hip', roof: t.roof, inner: { wall: H[0], side: H[1], dado: t.terracotta[1], trim: t.trim }, win: { front: 2, side: 1, shutter: null, arched: false }, porch: null, extras: [] };
  }
}

// ---------------------------------------------------------------- utilidades de camada
function rectOf(points: P2[], pad: number): Rect {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0: Math.floor(x0 - pad), y0: Math.floor(y0 - pad), x1: Math.ceil(x1 + pad), y1: Math.ceil(y1 + pad) };
}
function boxCorners(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): P2[] {
  const out: P2[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push(project(x, y, z));
  return out;
}
function makeLayer(r: Rect, draw: (g: CanvasRenderingContext2D, P: Proj) => void): Layer {
  const c = document.createElement('canvas');
  c.width = Math.max(1, r.x1 - r.x0); c.height = Math.max(1, r.y1 - r.y0);
  const g = c.getContext('2d')!;
  draw(g, projector(-r.x0, -r.y0));
  return { canvas: c, x0: r.x0, y0: r.y0 };
}
/** Faces visíveis de um andar (frente +z e direita +x; com topo se nada estiver em cima). */
export function bandFaces(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, top: boolean): P2[][] {
  const front: P2[] = [project(x0, y1, z1), project(x1, y1, z1), project(x1, y0, z1), project(x0, y0, z1)];
  const right: P2[] = [project(x1, y1, z1), project(x1, y1, z0), project(x1, y0, z0), project(x1, y0, z1)];
  return top ? [front, right, [project(x0, y1, z0), project(x1, y1, z0), project(x1, y1, z1), project(x0, y1, z1)]] : [front, right];
}
/** Silhueta projetada de uma caixa (hexágono). */
export function silhouette(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): P2[] {
  return [project(x0, y1, z0), project(x1, y1, z0), project(x1, y0, z0), project(x1, y0, z1), project(x0, y0, z1), project(x0, y1, z1)];
}
const blit = (g: CanvasRenderingContext2D, s: Sprite, P: Proj, x: number, y: number, z: number) => { const [sx, sy] = P(x, y, z); g.drawImage(s.canvas, sx - s.ax, sy - s.ay); };

// ---------------------------------------------------------------- geometria comum
interface Geo { b: BuildingInst; s: BuildingSpec; L: (P: Proj) => Proj; x0: number; x1: number; z0: number; z1: number; zf: number; floors: number; yTop: number }
function geo(b: BuildingInst): Geo {
  const s = b.spec;
  return {
    b, s, L: (P) => (x, y, z) => P(x + b.ox, y, z + b.oz),
    x0: -s.W / 2, x1: s.W / 2, z0: -s.D / 2, z1: s.D / 2, zf: s.D / 2 + s.porch, floors: b.floors.length,
    yTop: s.base + b.floors.length * FLOOR_H,
  };
}
const floorY = (G: Geo, l: number) => G.s.base + l * FLOOR_H;
const classic = (style: string) => style === 'stoa';

function drawBase(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, look: StyleLook): void {
  const { s } = G; const e = s.plinth;
  if (s.base <= 0) return;
  isoBox(g, P, G.x0 - e, 0, G.z0 - e, G.x1 + e, s.base, Math.max(G.z1 + e, G.zf), look.base, t.outline);
  if (s.base >= 0.4) { // estilóbato em duas fiadas, com juntas
    isoBox(g, P, G.x0 - e * 0.55, s.base * 0.6, G.z0 - e * 0.55, G.x1 + e * 0.55, s.base, Math.max(G.z1 + e * 0.55, G.zf), look.base);
    for (let x = G.x0 - e + 0.6; x < G.x1 + e; x += 1.2) line(g, P(x, 0.02, Math.max(G.z1 + e, G.zf)), P(x, s.base * 0.58, Math.max(G.z1 + e, G.zf)), look.base[2]);
  }
  const st = s.steps;
  if (st) { // degraus da frente
    const zE = Math.max(G.z1 + e, G.zf); const n = Math.max(1, Math.round(s.base / 0.2));
    for (let k = 0; k < n; k++) {
      const za = zE + (k * st.depth) / n; const h = s.base * (1 - k / n);
      isoBox(g, P, st.x0, 0, za, st.x1, h, za + st.depth / n + 0.001, look.base, t.outline);
    }
  }
  const ss = s.sideSteps;
  if (ss) {
    const xE = G.x1 + e; const n = Math.max(1, Math.round(s.base / 0.2));
    for (let k = 0; k < n; k++) { const xa = xE + (k * ss.depth) / n; isoBox(g, P, xa, 0, ss.z0, xa + ss.depth / n + 0.001, s.base * (1 - k / n), ss.z1, look.base, t.outline); }
  }
}

/** Janelas de uma face: posições ao longo da face, evitando a porta. */
function windowSlots(a: number, b: number, n: number, avoid: Array<[number, number]>): number[] {
  if (n <= 0) return [];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const u = a + ((k + 0.5) * (b - a)) / n;
    if (avoid.some(([c, w]) => Math.abs(u - c) < w / 2 + 0.55)) continue;
    out.push(u);
  }
  return out;
}

function drawWindow(g: CanvasRenderingContext2D, P: Proj, t: Theme, look: StyleLook, face: 'front' | 'right', at: number, u: number, y: number, w: number, h: number, out: WinQuad[] | null, level: number): void {
  const Q = (du: number, dh: number): P2 => (face === 'front' ? P(u + du, y + dh, at) : P(at, y + dh, u - du));
  const quad = (a: number, b: number, h0: number, h1: number, c: string) => fillPoly(g, [Q(a, h1), Q(b, h1), Q(b, h0), Q(a, h0)], c);
  const hw = w / 2;
  quad(-hw - 0.07, hw + 0.07, -0.06, h + 0.08, t.outline);
  const glass = t.window;
  if (t.skin?.arch.windows.glow && t.skin.night) quad(-hw - 0.12, hw + 0.12, -0.1, h + 0.12, t.teal[0]);
  quad(-hw, hw, 0, h, glass);
  if (look.win.arched) { quad(-hw, hw, h - 0.14, h, mix(glass, t.outline, 0.3)); }
  line(g, Q(0, 0.02), Q(0, h - 0.02), mix(glass, look.wall[1], 0.45));
  quad(-hw - 0.1, hw + 0.1, -0.1, -0.02, look.base[0]); // peitoril
  quad(-hw - 0.08, hw + 0.08, h + 0.02, h + 0.1, look.trim); // verga
  if (look.win.shutter) { quad(-hw - 0.22, -hw - 0.06, 0, h, look.win.shutter); quad(hw + 0.06, hw + 0.22, 0, h, look.win.shutter); }
  if (out) out.push({ level, poly: [Q(-hw, h), Q(hw, h), Q(hw, 0), Q(-hw, 0)] });
}

function drawDoor(g: CanvasRenderingContext2D, P: Proj, t: Theme, look: StyleLook, face: 'front' | 'right', at: number, u: number, w: number, y: number, big: boolean): void {
  const Q = (du: number, dh: number): P2 => (face === 'front' ? P(u + du, y + dh, at) : P(at, y + dh, u - du));
  const quad = (a: number, b: number, h0: number, h1: number, c: string) => fillPoly(g, [Q(a, h1), Q(b, h1), Q(b, h0), Q(a, h0)], c);
  const hw = w / 2; const h = big ? 2.2 : 1.8;
  quad(-hw - 0.12, hw + 0.12, 0, h + 0.14, look.base[1]); // batente de pedra
  quad(-hw, hw, 0, h, t.woodDark[1]);
  quad(-hw, -0.03, 0.06, h - 0.06, t.woodDark[0]); // folhas
  line(g, Q(0, 0.05), Q(0, h - 0.05), t.outline);
  for (const hh of [0.5, 1.2]) line(g, Q(-hw + 0.06, hh), Q(hw - 0.06, hh), t.woodDark[2]);
  const [kx, ky] = Q(0.12, h * 0.48); g.fillStyle = t.bronze[0]; g.fillRect(kx, ky, RES, RES);
  quad(-hw - 0.16, hw + 0.16, h + 0.14, h + 0.24, look.trim);
}

/** Uma camada de parede de um andar (fechado): caixa, faixas, janelas, porta, pórtico e detalhes do estilo. */
function drawFloorShell(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, look: StyleLook, l: number, wins: WinQuad[]): void {
  const { s } = G; const y0 = floorY(G, l); const y1 = y0 + FLOOR_H;
  const isClassic = classic(s.style);
  const wallTop = isClassic ? y1 - SLAB : y1;
  isoBox(g, P, G.x0, y0, G.z0, G.x1, wallTop, G.z1, look.wall, t.outline);
  // rodapé e frisos
  backQuad(g, P, G.z1, G.x0, G.x1, y0, y0 + 0.22, mix(look.wall[1], t.outline, 0.12));
  sideQuad(g, P, G.x1, G.z0, G.z1, y0, y0 + 0.22, mix(look.wall[2], t.outline, 0.12));
  if (!isClassic) { line(g, P(G.x0, wallTop - 0.04, G.z1), P(G.x1, wallTop - 0.04, G.z1), look.trim); line(g, P(G.x1, wallTop - 0.04, G.z1), P(G.x1, wallTop - 0.04, G.z0), look.trim); }
  if (look.extras.includes('band')) { backQuad(g, P, G.z1, G.x0, G.x1, y0 + 0.22, y0 + 0.5, t.teal[1]); sideQuad(g, P, G.x1, G.z0, G.z1, y0 + 0.22, y0 + 0.5, mix(t.teal[1], t.outline, 0.25)); }
  // porta e janelas
  const door = l === 0 ? s.door : null;
  const avoid: Array<[number, number]> = door ? [[door.x, door.w + (look.extras.includes('shopwin') ? 1.6 : 0)]] : [];
  if (look.extras.includes('arcade') && l === 0) {
    // arcada: pilares e arcos na frente do pórtico, lojas atrás
    const n = 5; const span = (G.x1 - G.x0) / n;
    for (let k = 0; k < n; k++) {
      const a = G.x0 + k * span + 0.25; const b2 = a + span - 0.5;
      const shop = mix(t.woodDark[2], t.window, 0.35);
      backQuad(g, P, G.z1, a, b2, y0, y0 + 1.95, shop);
      fillPoly(g, [P(a, y0 + 1.95, G.z1), P(b2, y0 + 1.95, G.z1), P((a + b2) / 2, y0 + 2.35, G.z1)], shop);
      backQuad(g, P, G.z1, a + 0.12, b2 - 0.12, y0 + 0.05, y0 + 0.5, mix(t.wood[1], shop, 0.3)); // balcão da loja
    }
  }
  if (door) drawDoor(g, P, t, look, 'front', G.z1, door.x, door.w, y0, isClassic);
  if (s.sideDoor && l === 0) drawDoor(g, P, t, look, 'right', G.x1, s.sideDoor.z, s.sideDoor.w, y0, false);
  const wy = y0 + 1.0; const wh = isClassic ? 1.15 : 0.95;
  const frontN = l === 0 && look.extras.includes('arcade') ? 0 : look.win.front + (isClassic && l > 0 ? 1 : 0);
  for (const u of windowSlots(G.x0, G.x1, frontN, avoid)) drawWindow(g, P, t, look, 'front', G.z1, u, wy, isClassic ? 0.8 : 0.62, wh, wins, l);
  const sideAvoid: Array<[number, number]> = s.sideDoor && l === 0 ? [[s.sideDoor.z, s.sideDoor.w]] : [];
  for (const u of windowSlots(G.z0, G.z1, look.win.side, sideAvoid)) drawWindow(g, P, t, look, 'right', G.x1, u, wy, 0.6, wh, wins, l);
  skinTrim(g, P, G, t, y0, wallTop, l);
  // vitrine da botica e símbolo de Asclépio; ferramentas da oficina
  if (l === 0 && look.extras.includes('shopwin') && door) {
    const u = door.x + door.w / 2 + 0.9;
    backQuad(g, P, G.z1, u - 0.55, u + 0.55, y0 + 0.75, y0 + 1.75, t.outline);
    backQuad(g, P, G.z1, u - 0.5, u + 0.5, y0 + 0.8, y0 + 1.7, mix(t.window, '#ffffff', 0.15));
    const jars = [t.teal[0], t.terracotta[0], t.gold, t.olive[0]];
    for (let k = 0; k < 4; k++) { const [jx, jy] = P(u - 0.36 + k * 0.24, y0 + 0.86, G.z1); g.fillStyle = jars[k]; g.fillRect(jx, jy - 3 * RES, 2 * RES, 3 * RES); }
  }
  if (l === 0 && look.extras.includes('asclepius') && door) { // bastão com a serpente sobre a porta
    const [cx, cy] = P(door.x, y0 + 2.3, G.z1);
    g.fillStyle = t.outline; g.fillRect(cx - 4 * RES, cy - 7 * RES, 9 * RES, 9 * RES);
    g.fillStyle = mix(t.marble[0], t.teal[0], 0.2); g.fillRect(cx - 3 * RES, cy - 6 * RES, 7 * RES, 7 * RES);
    g.fillStyle = t.woodDark[1]; g.fillRect(cx, cy - 5 * RES, RES, 5 * RES);
    g.fillStyle = t.teal[1]; for (const [dx, dy] of [[-1, -4], [1, -3], [-1, -2], [1, -1]]) g.fillRect(cx + dx * RES, cy + dy * RES, RES, RES);
  }
  if (l === 0 && look.extras.includes('tools')) { // placa com martelo
    const [cx, cy] = P(G.x1 - 0.8, y0 + 2.2, G.z1);
    g.fillStyle = t.outline; g.fillRect(cx - 5 * RES, cy - 4 * RES, 11 * RES, 6 * RES);
    g.fillStyle = t.wood[0]; g.fillRect(cx - 4 * RES, cy - 3 * RES, 9 * RES, 4 * RES);
    g.fillStyle = t.outline; g.fillRect(cx - 2 * RES, cy - 2 * RES, 5 * RES, RES); g.fillRect(cx, cy - RES, RES, 2 * RES);
  }
  if (l === 0 && look.extras.includes('awning') && door) { // toldo listrado sobre a porta
    const a = door.x - door.w / 2 - 0.35; const b2 = door.x + door.w / 2 + 0.35; const yA = y0 + 2.15;
    for (let k = 0; k < 6; k++) {
      const u0 = a + ((b2 - a) * k) / 6; const u1 = a + ((b2 - a) * (k + 1)) / 6;
      fillPoly(g, [P(u0, yA + 0.35, G.z1), P(u1, yA + 0.35, G.z1), P(u1, yA, G.z1 + 0.7), P(u0, yA, G.z1 + 0.7)], k % 2 ? t.papyrus[0] : t.terracotta[1]);
    }
    line(g, P(a, yA, G.z1 + 0.7), P(b2, yA, G.z1 + 0.7), t.outline);
  }
  if (look.extras.includes('awnings') && l > 0) { // toldos coloridos nas janelas do comércio
    const cols = [t.teal[1], t.terracotta[1], t.gold, t.banner[0]];
    windowSlots(G.x0, G.x1, frontN, avoid).forEach((u, k) => {
      const yA = wy + wh + 0.12;
      fillPoly(g, [P(u - 0.45, yA + 0.3, G.z1), P(u + 0.45, yA + 0.3, G.z1), P(u + 0.45, yA, G.z1 + 0.5), P(u - 0.45, yA, G.z1 + 0.5)], cols[(k + l) % cols.length]);
      line(g, P(u - 0.45, yA, G.z1 + 0.5), P(u + 0.45, yA, G.z1 + 0.5), t.outline);
    });
  }
  if (look.extras.includes('banners') && l === 0 && isClassic) {
    for (const u of [-4.4, 4.4]) {
      fillPoly(g, [P(u - 0.32, y0 + 2.45, G.z1), P(u + 0.32, y0 + 2.45, G.z1), P(u + 0.32, y0 + 1.15, G.z1), P(u, y0 + 0.95, G.z1), P(u - 0.32, y0 + 1.15, G.z1)], t.banner[0]);
      line(g, P(u - 0.4, y0 + 2.5, G.z1), P(u + 0.4, y0 + 2.5, G.z1), t.bronze[1]);
    }
  }
  if (look.extras.includes('balcony') && l > 0) { // sacada de madeira
    const a = G.x0 + 1.2; const b2 = G.x1 - 1.2; const yb = y0;
    isoBox(g, P, a, yb - 0.12, G.z1, b2, yb, G.z1 + 0.6, t.wood, t.outline);
    for (let u = a + 0.1; u < b2; u += 0.3) line(g, P(u, yb, G.z1 + 0.58), P(u, yb + 0.7, G.z1 + 0.58), t.woodDark[1]);
    isoBox(g, P, a, yb + 0.68, G.z1 + 0.52, b2, yb + 0.78, G.z1 + 0.62, t.wood, t.outline);
  }
}

function porchColumns(G: Geo, look: StyleLook): number[] {
  const p = look.porch; if (!p) return [];
  if (G.s.style === 'stoa') return [-6.6, -2.2, 2.2, 6.6];
  const n = p.n; const a = G.x0 + 0.45; const b = G.x1 - 0.45;
  return Array.from({ length: n }, (_, k) => a + ((b - a) * k) / (n - 1));
}

/** Pórtico de um andar: colunas (inteiras ou cortadas) e, por cima, entablamento ou viga. */
function drawPorch(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, look: StyleLook, l: number, cut: boolean): void {
  const p = look.porch; if (!p || (!p.allFloors && l > 0) || G.s.porch <= 0) return;
  const y0 = floorY(G, l); const isClassic = classic(G.s.style);
  const order: Order = p.order === 'by-floor' ? orderFor(l) : p.order;
  const colH = isClassic ? FLOOR_H - SLAB : FLOOR_H - 0.45;
  const zc = G.z1 + G.s.porch / 2;
  if (l > 0 && isClassic) { // piso da varanda
    flatQuad(g, P, y0, G.x0, G.z1, G.x1, G.zf, t.stone[0]);
  }
  const sc = t.skin?.arch.columns;
  if (sc && sc !== 'classic') {
    // pilar quadrado (concreto, aço) ou poste de madeira
    const r = sc === 'post' ? 0.13 : 0.2; const tone = sc === 'post' ? t.wood : t.stone; const h = cut ? CUT_H : colH;
    for (const x of porchColumns(G, look)) isoBox(g, P, x - r, y0, zc - r, x + r, y0 + h, zc + r, tone, t.outline);
  } else {
    const col = roundColumnSprite(t, order, colH, cut ? CUT_H : 0);
    for (const x of porchColumns(G, look)) blit(g, col, P, x, y0, zc);
  }
  if (l > 0 && isClassic) { // balaustrada entre as colunas: base, balaústres e corrimão (na altura do corte, se cortada)
    const xs = [G.x0, ...porchColumns(G, look).flatMap((c) => [c - 0.36, c + 0.36]), G.x1];
    const top = cut ? CUT_H : 0.82; const za = G.zf - 0.2; const zb = G.zf - 0.06;
    for (let i = 0; i < xs.length; i += 2) {
      const a = xs[i]; const b = xs[i + 1]; if (b - a < 0.1) continue;
      isoBox(g, P, a, y0, za, b, y0 + 0.08, zb, t.stone);
      for (let u = a + 0.16; u < b - 0.08; u += 0.32) isoBox(g, P, u - 0.04, y0 + 0.08, za + 0.04, u + 0.04, y0 + top - 0.08, zb - 0.04, t.marble);
      isoBox(g, P, a, y0 + top - 0.08, za - 0.02, b, y0 + top, zb + 0.02, t.marble, t.outline);
    }
  }
  if (!cut && !isClassic) { // viga sobre as colunas do pórtico
    const yb = y0 + colH;
    isoBox(g, P, G.x0, yb, G.z1, G.x1, y0 + FLOOR_H, G.zf, t.stone, t.outline);
    if (!t.skin || t.skin.arch.frieze) entablature(g, P, t, order, yb, y0 + FLOOR_H, 'front', [G.x0, G.x1], G.zf);
  }
}

/** Laje com entablamento (Stoa) no alto de um andar. */
function drawSlab(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, l: number): void {
  const y1 = floorY(G, l) + FLOOR_H; const order = orderFor(l);
  isoBox(g, P, G.x0, y1 - SLAB, G.z0, G.x1, y1, G.zf, t.stone, t.outline);
  if (t.skin && !t.skin.arch.frieze) { line(g, P(G.x0, y1 - 0.06, G.zf), P(G.x1, y1 - 0.06, G.zf), t.stone[2]); return; }
  entablature(g, P, t, order, y1 - SLAB, y1, 'front', [G.x0, G.x1], G.zf);
  entablature(g, P, t, order, y1 - SLAB, y1, 'right', [G.z0, G.zf], G.x1);
}

function drawRoof(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, look: StyleLook): number {
  const y = G.yTop; const e = 0.25; const R = look.roof;
  const outlinePoly = (pts: P2[]) => { for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) fillPoly(g, pts.map(([a, b]) => [a + ox, b + oy] as P2), t.outline); };
  switch (look.roofKind) {
    case 'flat': {
      if (t.skin) { // laje lisa com beiral fino
        flatQuad(g, P, y, G.x0, G.z0, G.x1, G.zf, R[1]);
        isoBox(g, P, G.x0 - 0.06, y, G.z0 - 0.06, G.x1 + 0.06, y + 0.12, G.zf + 0.06, R, t.outline);
        return y + 0.12;
      }
      antefixes(g, P, t, y, 'front', [G.x0, G.x1], G.zf); antefixes(g, P, t, y, 'right', [G.z0, G.zf], G.x1);
      return y + 0.15;
    }
    case 'parapet': {
      const h = 0.45;
      flatQuad(g, P, y, G.x0, G.z0, G.x1, G.zf, mix(t.stone[1], t.terracotta[2], 0.2));
      isoBox(g, P, G.x0, y, G.z0, G.x1, y + h, G.z0 + 0.2, look.wall, t.outline);
      isoBox(g, P, G.x0, y, G.z0, G.x0 + 0.2, y + h, G.zf, look.wall, t.outline);
      isoBox(g, P, G.x1 - 0.2, y, G.z0, G.x1, y + h, G.zf, look.wall, t.outline);
      isoBox(g, P, G.x0, y, G.zf - 0.2, G.x1, y + h, G.zf, look.wall, t.outline);
      line(g, P(G.x0, y + h, G.zf), P(G.x1, y + h, G.zf), look.trim); line(g, P(G.x1, y + h, G.zf), P(G.x1, y + h, G.z0), look.trim);
      if (look.extras.includes('planters')) for (const x of [G.x0 + 0.7, G.x1 - 0.8]) blit(g, plantSprite(t), P, x, y, G.zf - 0.55);
      return y + h;
    }
    case 'thatch':
    case 'hip': {
      const ex0 = G.x0 - e; const ex1 = G.x1 + e; const ez0 = G.z0 - e; const ez1 = G.zf + e;
      const r = (ez1 - ez0) / 2; const zc = (ez0 + ez1) / 2; const yR = y + Math.min(1.5, r * 0.62);
      const back: P2[] = [P(ex0, y, ez0), P(ex1, y, ez0), P(ex1 - r, yR, zc), P(ex0 + r, yR, zc)];
      const left: P2[] = [P(ex0, y, ez0), P(ex0, y, ez1), P(ex0 + r, yR, zc)];
      const right: P2[] = [P(ex1, y, ez1), P(ex1, y, ez0), P(ex1 - r, yR, zc)];
      const front: P2[] = [P(ex0, y, ez1), P(ex1, y, ez1), P(ex1 - r, yR, zc), P(ex0 + r, yR, zc)];
      outlinePoly([...back]); outlinePoly(left); outlinePoly(right); outlinePoly(front);
      fillPoly(g, back, R[0]); fillPoly(g, left, R[0]); fillPoly(g, right, R[2]); fillPoly(g, front, R[1]);
      for (let k = 1; k < 5; k++) {
        const f = k / 5;
        line(g, P(ex0 + r * f, y + (yR - y) * f, ez1 - (ez1 - zc) * f), P(ex1 - r * f, y + (yR - y) * f, ez1 - (ez1 - zc) * f), R[2]);
        line(g, P(ex1 - r * f, y + (yR - y) * f, ez1 - (ez1 - zc) * f), P(ex1 - r * f, y + (yR - y) * f, ez0 + (zc - ez0) * f), mix(R[2], t.outline, 0.3));
      }
      line(g, P(ex0 + r, yR, zc), P(ex1 - r, yR, zc), R[0]);
      line(g, P(ex0, y, ez1), P(ex1, y, ez1), mix(R[1], t.outline, 0.4));
      if (look.roofKind === 'thatch') { // palha: fiapos descendo e franja na beirada
        for (let k = 0; k <= 24; k++) { const u = ex0 + ((ex1 - ex0) * k) / 24; line(g, P(u, y + 0.05, ez1), P(u + (k % 2 ? 0.1 : -0.1), y + 0.32, ez1 - 0.32), mix(R[1], t.outline, 0.25)); }
        for (let k = 0; k < 16; k++) { const u = ex0 + ((ex1 - ex0) * (k + 0.5)) / 16; fillPoly(g, [P(u - 0.14, y, ez1), P(u + 0.14, y, ez1), P(u, y - 0.16, ez1)], R[2]); }
      }
      if (classic(G.s.style) && !t.skin) { antefixes(g, P, t, y, 'front', [ex0, ex1], ez1); antefixes(g, P, t, y, 'right', [ez0, ez1], ex1); }
      return yR;
    }
    case 'steep':
    case 'gable': {
      const ex0 = G.x0 - e; const ex1 = G.x1 + e; const ez0 = G.z0 - e; const ez1 = G.zf + e;
      const yR = y + (G.x1 - G.x0) * (look.roofKind === 'steep' ? 0.36 : 0.2); const xm = 0;
      const left: P2[] = [P(ex0, y, ez0), P(ex0, y, ez1), P(xm, yR, ez1), P(xm, yR, ez0)];
      const right: P2[] = [P(xm, yR, ez0), P(xm, yR, ez1), P(ex1, y, ez1), P(ex1, y, ez0)];
      outlinePoly(left); outlinePoly(right);
      fillPoly(g, left, R[0]); fillPoly(g, right, R[2]);
      for (let k = 1; k < 6; k++) { const f = k / 6; line(g, P(xm + (ex1 - xm) * f, yR - (yR - y) * f, ez0), P(xm + (ex1 - xm) * f, yR - (yR - y) * f, ez1), mix(R[2], t.outline, 0.25)); }
      const zt = G.zf + 0.02;
      if (t.skin && t.skin.arch.columns !== 'classic') {
        // empena de casa: parede no triângulo e, no enxaimel, as vigas aparentes
        const tri: P2[] = [P(G.x0, y, zt), P(G.x1, y, zt), P(xm, yR - 0.12, zt)];
        outlinePoly(tri); fillPoly(g, tri, look.wall[1]);
        if (t.skin.arch.trim === 'timber') { line(g, P(xm, y, zt), P(xm, yR - 0.2, zt), t.woodDark[1]); line(g, P(G.x0 + 0.4, y + 0.05, zt), P(xm, yR - 0.4, zt), t.woodDark[1]); line(g, P(G.x1 - 0.4, y + 0.05, zt), P(xm, yR - 0.4, zt), t.woodDark[1]); }
        const [wx, wy] = P(xm, y + (yR - y) * 0.35, zt); g.fillStyle = t.outline; g.fillRect(wx - 3 * RES, wy - 3 * RES, 6 * RES, 5 * RES); g.fillStyle = t.window; g.fillRect(wx - 2 * RES, wy - 2 * RES, 4 * RES, 3 * RES);
        line(g, P(ex0, y, ez1), P(xm, yR, ez1), R[0]); line(g, P(xm, yR, ez1), P(ex1, y, ez1), R[0]);
        return yR;
      }
      // frontão: tímpano de pedra e cornija inclinada
      const tri: P2[] = [P(G.x0, y, zt), P(G.x1, y, zt), P(xm, yR - 0.12, zt)];
      outlinePoly(tri); fillPoly(g, tri, t.stone[1]);
      fillPoly(g, [P(G.x0 + 0.5, y + 0.12, zt), P(G.x1 - 0.5, y + 0.12, zt), P(xm, yR - 0.4, zt)], mix(t.stone[1], t.outline, 0.12));
      line(g, P(ex0, y, ez1), P(xm, yR, ez1), t.stone[0]); line(g, P(xm, yR, ez1), P(ex1, y, ez1), t.stone[0]);
      line(g, P(G.x0, y, zt), P(G.x1, y, zt), t.stone[2]);
      if (look.extras.includes('owl')) { // coruja de Atena no tímpano
        const [cx, cy] = P(xm, y + (yR - y) * 0.38, zt);
        blob(g, cx, cy, 3 * RES, 3 * RES, t.outline); blob(g, cx, cy, 2 * RES, 2 * RES + 1, t.bronze[1]);
        g.fillStyle = t.papyrus[0]; g.fillRect(cx - RES - 1, cy - RES, RES, RES); g.fillRect(cx + 1, cy - RES, RES, RES);
      }
      if (look.extras.includes('acroteria')) for (const [ax, ay] of [P(xm, yR + 0.05, ez1), P(ex0 + 0.1, y + 0.05, ez1), P(ex1 - 0.1, y + 0.05, ez1)]) {
        g.fillStyle = t.outline; g.fillRect(ax - 2 * RES, ay - 3 * RES, 4 * RES + 1, 3 * RES + 1); g.fillStyle = t.gold; g.fillRect(ax - RES, ay - 2 * RES, 2 * RES + 1, 2 * RES);
      }
      return yR;
    }
  }
}

// ---------------------------------------------------------------- fechado
// arte fechada em resolução cheia: cache com descarte do menos usado; a capacidade acompanha os prédios na tela
const closedCache = new Lru<ClosedArt>(80);
const geoKey = (b: BuildingInst) => `${b.id}|${b.kind}|${b.ox}|${b.oz}|${b.floors.map((f) => `${f.level}:${f.slots}`).join(',')}`;
const keyOf = (b: BuildingInst, t: Theme) => `${t.id}|${geoKey(b)}`;
const rectCache = new Lru<Rect>(4096);
const closedBox = (b: BuildingInst, G: Geo) => rectOf(boxCorners(b.foot.x0 - 1, 0, b.foot.z0 - 1, b.foot.x1 + 1.2, G.yTop + 3, b.foot.z1 + 1.5), 4 * RES);

/** Retângulo (pixels do mundo) da arte fechada, só pela geometria: dá para recortar pela tela sem desenhar nada. */
export function closedRect(b: BuildingInst): Rect {
  const k = geoKey(b); const hit = rectCache.get(k); if (hit) return hit;
  const r = closedBox(b, geo(b)); rectCache.set(k, r); return r;
}
/** Espaço no cache para pelo menos `n` prédios (os visíveis e uma folga). */
export function reserveClosed(n: number): void { closedCache.reserve(n); }
/** Já está pronta (sem custo de desenho)? */
export function hasClosed(b: BuildingInst, t: Theme): boolean { return closedCache.has(keyOf(b, t)); }

export interface SmallArt { layer: Layer; windows: WinQuad[]; bands: Band[]; top: number }
const smallCache = new Lru<SmallArt>(120);
/** Cópia reduzida da arte fechada (zoom afastado): a mesma imagem com menos memória; janelas e faixas iguais. */
export function closedSmall(b: BuildingInst, t: Theme, s: number): SmallArt {
  const key = `${keyOf(b, t)}|${s}`; const hit = smallCache.get(key); if (hit) return hit;
  const full = closedArt(b, t); const src = full.layer.canvas;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(src.width * s)); c.height = Math.max(1, Math.ceil(src.height * s));
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const art: SmallArt = { layer: { canvas: c, x0: full.layer.x0, y0: full.layer.y0, s: c.width / src.width }, windows: full.windows, bands: full.bands, top: full.top };
  smallCache.set(key, art); return art;
}
export function hasSmall(b: BuildingInst, t: Theme, s: number): boolean { return smallCache.has(`${keyOf(b, t)}|${s}`); }
export function reserveSmall(n: number): void { smallCache.reserve(n); }

export function closedArt(b: BuildingInst, t: Theme): ClosedArt {
  const key = keyOf(b, t);
  const hit = closedCache.get(key); if (hit) return hit;
  const G = geo(b); const look = lookOf(b.spec.style, t);
  const e = b.spec.plinth + 0.6;
  const rect = closedBox(b, G);
  const wins: WinQuad[] = [];
  let top = G.yTop;
  const layer = makeLayer(rect, (g, P0) => {
    const P = G.L(P0);
    drawBase(g, P, G, t, look);
    for (let l = 0; l < G.floors; l++) {
      drawFloorShell(g, P, G, t, look, l, wins);
      drawPorch(g, P, G, t, look, l, false);
      if (classic(b.spec.style)) drawSlab(g, P, G, t, l);
    }
    top = drawRoof(g, P, G, t, look);
    rooftop(g, P, G, t, look, top);
  });
  // janelas em pixels do mundo
  const W = (q: WinQuad): WinQuad => ({ level: q.level, poly: q.poly.map(([x, y]) => [x + rect.x0, y + rect.y0] as P2) });
  const bands: Band[] = [];
  for (let l = 0; l < G.floors; l++) {
    const last = l === G.floors - 1; const p = l === 0 ? b.spec.plinth : 0;
    const y0 = l === 0 ? 0 : floorY(G, l); const y1 = last ? top + 0.1 : floorY(G, l) + FLOOR_H;
    bands.push({ level: l, faces: bandFaces(b.ox + G.x0 - p, y0, b.oz + G.z0 - p, b.ox + G.x1 + p, y1, b.oz + Math.max(G.zf, G.z1 + p), last) });
  }
  void e;
  const art: ClosedArt = { layer, bands, windows: wins.map(W), rect, top };
  closedCache.set(key, art);
  return art;
}

// ---------------------------------------------------------------- aberto (um andar)
function floorSurface(g: CanvasRenderingContext2D, P: Proj, t: Theme, plan: FloorPlan, I: Box, y: number): void {
  const { x0, z0, x1, z1 } = I;
  switch (plan.floor) {
    case 'planks':
      for (let z = z0; z < z1 - 1e-6; z += 0.5) flatQuad(g, P, y, x0, z, x1, Math.min(z1, z + 0.5), (Math.round(z * 2) & 1) ? t.planks[1] : t.planks[0]);
      for (let z = z0 + 0.5; z < z1; z += 0.5) line(g, P(x0, y, z), P(x1, y, z), mix(t.planks[1], t.outline, 0.25));
      for (let z = z0; z < z1 - 1e-6; z += 0.5) for (let x = x0 + 0.3 + ((Math.round(z * 2) % 3) * 0.9); x < x1; x += 2.7) line(g, P(x, y, z), P(x, y, Math.min(z1, z + 0.5)), mix(t.planks[1], t.outline, 0.3));
      break;
    case 'terracotta': {
      const a = mix(t.terracotta[0], t.stone[0], 0.45); const b = mix(t.terracotta[1], t.stone[1], 0.4);
      for (let x = x0; x < x1 - 1e-6; x += 1) for (let z = z0; z < z1 - 1e-6; z += 1) flatQuad(g, P, y, x, z, Math.min(x1, x + 1), Math.min(z1, z + 1), ((Math.floor(x - x0) + Math.floor(z - z0)) & 1) ? b : a);
      for (let x = x0 + 1; x < x1; x += 1) line(g, P(x, y, z0), P(x, y, z1), mix(b, t.outline, 0.2));
      for (let z = z0 + 1; z < z1; z += 1) line(g, P(x0, y, z), P(x1, y, z), mix(b, t.outline, 0.2));
      break;
    }
    case 'mosaic':
      flatQuad(g, P, y, x0, z0, x1, z1, t.floor[0]);
      for (let x = x0 + 0.5; x < x1 - 0.5; x += 1) for (let z = z0 + 0.5; z < z1 - 0.5; z += 1) flatQuad(g, P, y, x, z, x + 0.5, z + 0.5, ((Math.floor(x) + Math.floor(z)) & 1) ? t.floor[1] : mix(t.floor[1], t.terracotta[0], 0.25));
      meanderBand(g, P, y, x0 + 0.15, z0 + 0.15, x1 - 0.15, z1 - 0.15, t.terracotta[2]);
      break;
    default:
      for (let x = Math.floor(x0 / 2) * 2; x < x1; x += 2) for (let z = Math.floor(z0 / 2) * 2; z < z1; z += 2) {
        const qx0 = Math.max(x0, x); const qz0 = Math.max(z0, z); const qx1 = Math.min(x1, x + 2); const qz1 = Math.min(z1, z + 2);
        if (qx1 > qx0 && qz1 > qz0) flatQuad(g, P, y, qx0, qz0, qx1, qz1, ((x + z + 100) / 2) & 1 ? t.floor[1] : t.floor[0]);
      }
      for (let x = Math.ceil(x0 / 2) * 2; x < x1; x += 2) line(g, P(x, y, z0), P(x, y, z1), t.grout);
      for (let z = Math.ceil(z0 / 2) * 2; z < z1; z += 2) line(g, P(x0, y, z), P(x1, y, z), t.grout);
  }
  for (const c of plan.carpets) {
    const carpet = plan.floor === 'planks' ? t.carpet2 : t.carpet;
    flatQuad(g, P, y, c.x0, c.z0, c.x1, c.z1, carpet.border);
    flatQuad(g, P, y, c.x0 + 0.18, c.z0 + 0.18, c.x1 - 0.18, c.z1 - 0.18, carpet.field);
    if (c.x1 - c.x0 > 2 && c.z1 - c.z0 > 2) meanderBand(g, P, y, c.x0 + 0.28, c.z0 + 0.28, c.x1 - 0.28, c.z1 - 0.28, carpet.inner);
  }
}

const TEMPLE = ['......#......', '....#####....', '..#########..', '#############', '.............', '.##.##.##.##.', '.##.##.##.##.', '.##.##.##.##.', '.##.##.##.##.', '.............', '#############'];
const BUST = ['....aaaa.....', '...aaaaab....', '...aaaaabb...', '...abaaabb...', '...aaaaabb...', '....aaaab....', '.....aab.....', '..aaaaaaabb..', '.aaaaaaaabbb.', '.aaaaaaaabbb.', 'ccccccccccccc', '.ccccccccccc.'];
function wallIcon(g: CanvasRenderingContext2D, anchor: P2, rows: string[], colors: Record<string, string>, wall: 'back' | 'left'): void {
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const c = colors[ch]; if (!c) return;
    const sh = wall === 'back' ? Math.floor(i / 2) : -Math.floor(i / 2);
    g.fillStyle = c; g.fillRect(anchor[0] + i, anchor[1] + j + sh, 1, 1);
  }));
}

/** Decoração nas paredes do fundo (z = zb) ou da esquerda (x = xl), a partir do andar y. */
function drawDecor(g: CanvasRenderingContext2D, P: Proj, t: Theme, d: WallDecor, y: number, zb: number, xl: number, look: StyleLook, hits: HitPoly[], toWorld: (p: P2) => P2): void {
  const Q = (du: number, h: number): P2 => (d.wall === 'back' ? P(d.u + du, y + h, zb) : P(xl, y + h, d.u - du));
  const quad = (a: number, b: number, h0: number, h1: number, c: string) => fillPoly(g, [Q(a, h1), Q(b, h1), Q(b, h0), Q(a, h0)], c);
  const wallCol = d.wall === 'back' ? look.inner.wall : look.inner.side;
  switch (d.kind) {
    case 'banner':
      fillPoly(g, [Q(-0.42, 2.3), Q(0.42, 2.3), Q(0.42, 1.0), Q(0, 0.78), Q(-0.42, 1.0)], t.banner[0]);
      fillPoly(g, [Q(0.25, 2.3), Q(0.42, 2.3), Q(0.42, 1.0), Q(0.25, 0.9)], t.banner[1]);
      line(g, Q(-0.55, 2.36), Q(0.55, 2.36), t.bronze[1]);
      wallIcon(g, Q(-0.33, 1.98), TEMPLE, { '#': t.gold }, d.wall);
      break;
    case 'bust':
      fillPoly(g, [Q(-0.55, 0.9), Q(-0.55, 1.95), Q(-0.3, 2.25), Q(0.3, 2.25), Q(0.55, 1.95), Q(0.55, 0.9)], t.outline);
      quad(-0.4, 0.4, 0.9, 1.45, t.stone[1]);
      wallIcon(g, Q(-0.32, 1.98), BUST, { a: t.marble[0], b: t.marble[2], c: t.stone[2] }, d.wall);
      break;
    case 'lamp': {
      fillPoly(g, [Q(-0.55, 1.85), Q(0, 2.25), Q(0.55, 1.85), Q(0, 1.45)], mix(wallCol, t.flame[0], 0.14));
      fillPoly(g, [Q(-0.32, 1.85), Q(0, 2.08), Q(0.32, 1.85), Q(0, 1.62)], mix(wallCol, t.flame[0], 0.24));
      const [lx, ly] = Q(0, 1.75); const r = RES;
      g.fillStyle = t.bronze[1]; g.fillRect(lx - r, ly, 3 * r, r); g.fillStyle = t.bronze[2]; g.fillRect(lx, ly + r, r, 2 * r);
      g.fillStyle = t.flame[1]; g.fillRect(lx, ly - 2 * r, r, 2 * r); g.fillStyle = t.flame[0]; g.fillRect(lx, ly - 2 * r, r, r);
      break;
    }
    case 'board': {
      const w = (d.w ?? 2.2) / 2;
      quad(-w, w, 1.25, 2.4, t.woodDark[0]); quad(-w + 0.12, w - 0.12, 1.35, 2.3, t.dado);
      for (let c = 0; c < 4; c++) for (let rr = 0; rr < 2; rr++) {
        if ((c + rr) % 5 === 4) continue;
        const a = -w + 0.22 + c * 0.46; const top = 2.2 - rr * 0.46;
        quad(a, a + 0.32, top - 0.34, top, t.cards[(c * 2 + rr) % t.cards.length]);
        const [px, py] = Q(a + 0.16, top); g.fillStyle = t.gold; g.fillRect(px, py, RES, RES);
      }
      line(g, Q(-w + 0.38, 2.04), Q(-w + 1.15, 1.58), t.teal[1]);
      hits.push({ kind: 'board', poly: [Q(-w, 2.4), Q(w, 2.4), Q(w, 1.25), Q(-w, 1.25)].map(toWorld) });
      break;
    }
    case 'map': {
      const w = d.w ?? 2.2;
      if (d.wall === 'back') wallMap(g, P, t, y, d.u - w / 2, d.u + w / 2, zb);
      else { quad(-w / 2, w / 2, 1.1, 2.4, t.woodDark[1]); quad(-w / 2 + 0.06, w / 2 - 0.06, 1.16, 2.34, t.papyrus[0]); line(g, Q(-w / 2 + 0.1, 1.7), Q(w / 2 - 0.1, 1.8), t.teal[1]); }
      break;
    }
    case 'window': {
      const w = (d.w ?? 1.1) / 2;
      quad(-w - 0.08, w + 0.08, 1.0, 2.15, t.outline); quad(-w, w, 1.05, 2.05, t.sky);
      line(g, Q(-w, 1.6), Q(w, 1.6), mix(t.sky, '#ffffff', 0.35));
      quad(-w - 0.12, w + 0.12, 2.05, 2.2, t.stone[0]); quad(-w - 0.06, w + 0.06, 0.95, 1.05, t.stone[1]);
      line(g, Q(0, 1.05), Q(0, 2.05), t.stone[1]);
      break;
    }
    case 'tablet':
      quad(-0.42, 0.42, 1.3, 2.0, t.wood[1]); quad(-0.34, 0.34, 1.37, 1.93, t.olive[1]);
      for (const h of [1.8, 1.65, 1.5]) line(g, Q(-0.26, h), Q(0.2, h), t.olive[0]);
      break;
    case 'sign':
      quad(-0.5, 0.5, 1.5, 2.2, t.outline); quad(-0.44, 0.44, 1.56, 2.14, mix(t.papyrus[0], t.teal[0], 0.15));
      line(g, Q(0, 1.62), Q(0, 2.08), t.woodDark[1]);
      for (const [du, h] of [[-0.08, 2.0], [0.08, 1.9], [-0.08, 1.8], [0.08, 1.7]]) { const [px, py] = Q(du, h); g.fillStyle = t.teal[1]; g.fillRect(px, py, RES, RES); }
      break;
    case 'shelf-rack': {
      for (const h of [1.3, 1.85]) {
        quad(-0.8, 0.8, h - 0.06, h, t.woodDark[1]);
        const cols = [t.terracotta[0], t.teal[0], t.papyrus[0], t.gold, t.olive[0]];
        for (let k = 0; k < 5; k++) { const [px, py] = Q(-0.65 + k * 0.32, h); g.fillStyle = t.outline; g.fillRect(px - 1, py - 3 * RES - 1, 2 * RES + 2, 3 * RES + 1); g.fillStyle = cols[(k + Math.round(h * 10)) % cols.length]; g.fillRect(px, py - 3 * RES, 2 * RES, 3 * RES); }
      }
      break;
    }
    case 'herbs':
      line(g, Q(-0.7, 2.25), Q(0.7, 2.25), t.woodDark[1]);
      for (let k = 0; k < 5; k++) { const [px, py] = Q(-0.56 + k * 0.28, 2.22); g.fillStyle = k % 2 ? t.olive[0] : t.olive[1]; g.fillRect(px - 1, py, 2 * RES, 4 * RES + (k % 2) * RES); }
      break;
  }
}

const openCache = new Map<string, OpenArt>();
export function openArt(b: BuildingInst, level: number, t: Theme): OpenArt {
  const key = `${keyOf(b, t)}|open|${level}`;
  const hit = openCache.get(key); if (hit) return hit;
  const G = geo(b); const look = lookOf(b.spec.style, t); const s = b.spec;
  const f = b.floors.find((x) => x.level === level) ?? b.floors[0];
  const y = floorY(G, level); const plan = f.plan;
  const zb = G.z0 + WALL_T; const xl = G.x0 + WALL_T;
  const big = rectOf(boxCorners(b.foot.x0 - 1, 0, b.foot.z0 - 1, b.foot.x1 + 1.2, G.yTop + 3, b.foot.z1 + 1.5), 4 * RES);
  const W2 = (r: Rect) => (p: P2): P2 => [p[0] + r.x0, p[1] + r.y0];

  // andares de baixo (fechados) + embasamento
  const lower = makeLayer(big, (g, P0) => {
    const P = G.L(P0);
    drawBase(g, P, G, t, look);
    for (let l = 0; l < level; l++) { drawFloorShell(g, P, G, t, look, l, []); drawPorch(g, P, G, t, look, l, false); if (classic(s.style)) drawSlab(g, P, G, t, l); }
  });

  // fundo do andar aberto: piso, paredes do fundo e da esquerda, decoração, vão da escada de baixo
  const hits: HitPoly[] = [];
  const st = s.stair; const sb = st ? stairBox(st) : null;
  let holeLocal: P2[] | null = null;
  const back = makeLayer(big, (g, P0) => {
    const P = G.L(P0);
    floorSurface(g, P, t, plan, { x0: G.x0 + 0.02, z0: G.z0 + 0.02, x1: G.x1 - 0.02, z1: G.z1 - 0.02 }, y);
    if (level > 0 && sb) {
      // vão: escuro, com os últimos degraus da escada de baixo à mostra
      const hole = [P(sb.x0, y, sb.z0), P(sb.x1, y, sb.z0), P(sb.x1, y, sb.z1), P(sb.x0, y, sb.z1)];
      holeLocal = hole;
      const pit = document.createElement('canvas'); pit.width = g.canvas.width; pit.height = g.canvas.height;
      const pg = pit.getContext('2d')!;
      fillPoly(pg, hole, mix(t.outline, look.inner.wall, 0.12));
      const yL = y - FLOOR_H; const n = 10;
      for (let k = n - 1; k >= n - 5; k--) {
        const top = yL + ((k + 1) * FLOOR_H) / n;
        if (st!.axis === 'z') { const run = (st!.hi - st!.lo) / n; const za = st!.hi - (k + 1) * run; isoBox(pg, P, sb.x0, yL, za, sb.x1, top, za + run, t.stone); }
        else { const run = (st!.hi - st!.lo) / n; const xa = st!.hi - (k + 1) * run; isoBox(pg, P, xa, yL, sb.z0, xa + run, top, sb.z1, t.stone); }
      }
      // máscara num canvas à parte e um único destination-in (cada fillRect sozinho apagaria o resto)
      const mask = document.createElement('canvas'); mask.width = pit.width; mask.height = pit.height;
      fillPoly(mask.getContext('2d')!, hole, '#000');
      pg.globalCompositeOperation = 'destination-in'; pg.drawImage(mask, 0, 0);
      g.drawImage(pit, 0, 0);
      // espessura da laje nas bordas do vão
      if (st!.axis === 'z') { backQuad(g, P, sb.z0, sb.x0, sb.x1, y - 0.3, y, t.stone[1]); sideQuad(g, P, sb.x0, sb.z0, sb.z1, y - 0.3, y, t.stone[2]); }
      else { backQuad(g, P, sb.z0, sb.x0, sb.x1, y - 0.3, y, t.stone[1]); sideQuad(g, P, sb.x0, sb.z0, sb.z1, y - 0.3, y, t.stone[2]); }
    }
    // paredes do fundo e da esquerda (internas), na cor do estilo
    const inner = look.inner;
    isoBox(g, P, G.x0, y, G.z0, G.x1, y + IN_H, zb, [t.stone[0], inner.wall, t.stone[2]], t.outline);
    isoBox(g, P, G.x0, y, zb, xl, y + IN_H, G.z1, [t.stone[0], t.stone[1], inner.side], t.outline);
    backQuad(g, P, zb, xl, G.x1, y, y + 0.85, inner.dado);
    sideQuad(g, P, xl, zb, G.z1, y, y + 0.85, mix(inner.dado, '#000000', 0.12));
    for (const hh of [0.85, IN_H - 0.25]) { line(g, P(xl, y + hh, zb), P(G.x1, y + hh, zb), inner.trim); line(g, P(xl, y + hh, zb), P(xl, y + hh, G.z1), mix(inner.trim, '#000000', 0.2)); }
    for (let x = xl + 0.3; x < G.x1; x += 0.6) { const [px, py] = P(x, y + IN_H - 0.12, zb); g.fillStyle = t.gold; g.fillRect(px, py, RES, RES); }
    for (const d of plan.decor) drawDecor(g, P, t, d, y, zb, xl, look, hits, W2(big));
  });
  const hole = holeLocal ? (holeLocal as P2[]).map(W2(big)) : null;

  // móveis, meias-paredes e degraus: objetos ordenáveis (caixas no mundo)
  const items: ArtItem[] = [];
  const add = (sprite: Sprite, lx: number, lz: number, box: AABB, hitKind?: ArtItem['hit']) => {
    const [px, py] = project(lx + b.ox, y, lz + b.oz);
    items.push({ sprite, px, py, box, hit: hitKind });
  };
  const wbox = (x0: number, z0: number, x1: number, z1: number, h: number, y0 = y): AABB => ({ x0: x0 + b.ox, y0, z0: z0 + b.oz, x1: x1 + b.ox, y1: y0 + h, z1: z1 + b.oz });
  for (const o of plan.objects) add(objectSprite(t, o), o.x, o.z, wbox(o.x - o.hx, o.z - o.hz, o.x + o.hx, o.z + o.hz, o.h), o.hit);
  for (const w of plan.walls) {
    const hx = (w.x1 - w.x0) / 2; const hz = (w.z1 - w.z0) / 2;
    add(halfWallSprite(t, hx, hz, plan.floor === 'planks'), (w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2, wbox(w.x0, w.z0, w.x1, w.z1, 0.72));
  }
  let stairTop: number | null = null;
  if (st && sb && level < G.floors - 1) {
    const n = 10; const run = (st.hi - st.lo) / n;
    for (let k = 0; k < CUT_STEPS; k++) {
      const h = ((k + 1) * FLOOR_H) / n;
      if (st.axis === 'z') {
        const za = st.hi - (k + 1) * run; const hx = (sb.x1 - sb.x0) / 2; const hz = run / 2;
        add(stepSprite(t, hx, hz, h, k % 2 === 0 ? 'x0' : null), (sb.x0 + sb.x1) / 2, za + hz, wbox(sb.x0, za, sb.x1, za + run, h));
      } else {
        const xa = st.hi - (k + 1) * run; const hx = run / 2; const hz = (sb.z1 - sb.z0) / 2;
        add(stepSprite(t, hx, hz, h, k % 2 === 0 ? 'z1' : null), xa + hx, (sb.z0 + sb.z1) / 2, wbox(xa, sb.z0, xa + run, sb.z1, h));
      }
    }
    stairTop = y + (CUT_STEPS * FLOOR_H) / n + 0.05;
  }
  for (const it of items) if (it.hit) hits.push({ kind: it.hit, poly: silhouette(it.box.x0, it.box.y0, it.box.z0, it.box.x1, it.box.y1, it.box.z1) });

  // frente cortada: paredes da frente e da direita, colunas e parapeito, todos em CUT_H, com o mesmo capeamento
  const front = makeLayer(big, (g, P0) => {
    const P = G.L(P0);
    const wall = look.wall; const cap: Tone = t.marble;
    const doorGap = level === 0 ? s.door : null;
    const segsX: Array<[number, number]> = doorGap ? [[G.x0, doorGap.x - doorGap.w / 2], [doorGap.x + doorGap.w / 2, G.x1 - WALL_T]] : [[G.x0, G.x1 - WALL_T]];
    const side = level === 0 ? s.sideDoor : null;
    const segsZ: Array<[number, number]> = side ? [[G.z0, side.z - side.w / 2], [side.z + side.w / 2, G.z1]] : [[G.z0, G.z1]];
    for (const [a, c] of segsZ) if (c - a > 0.05) { isoBox(g, P, G.x1 - WALL_T, y, a, G.x1, y + CUT_H, c, wall, t.outline); isoBox(g, P, G.x1 - WALL_T - 0.03, y + CUT_H, a, G.x1 + 0.03, y + CUT_H + 0.07, c, cap, t.outline); }
    for (const [a, c] of segsX) if (c - a > 0.05) { isoBox(g, P, a, y, G.z1 - WALL_T, c, y + CUT_H, G.z1, wall, t.outline); isoBox(g, P, a, y + CUT_H, G.z1 - WALL_T - 0.03, c, y + CUT_H + 0.07, G.z1 + 0.03, cap, t.outline); }
    if (doorGap) flatQuad(g, P, y + 0.01, doorGap.x - doorGap.w / 2, G.z1 - WALL_T, doorGap.x + doorGap.w / 2, G.z1, t.stone[0]);
    if (side) flatQuad(g, P, y + 0.01, G.x1 - WALL_T, side.z - side.w / 2, G.x1, side.z + side.w / 2, t.stone[0]);
    drawPorch(g, P, G, t, look, level, true);
  });

  // andares de cima viram holograma (contorno) e as bandas para hover/clique
  const bands: Band[] = [];
  for (let l = 0; l < level; l++) bands.push({ level: l, faces: bandFaces(b.ox + G.x0, l === 0 ? 0 : floorY(G, l), b.oz + G.z0, b.ox + G.x1, floorY(G, l) + FLOOR_H, b.oz + Math.max(G.zf, G.z1), false) });
  for (let l = level + 1; l < G.floors; l++) bands.push({ level: l, faces: bandFaces(b.ox + G.x0, floorY(G, l), b.oz + G.z0, b.ox + G.x1, floorY(G, l) + FLOOR_H, b.oz + Math.max(G.zf, G.z1), l === G.floors - 1) });
  let ghost: Layer | null = null;
  if (level < G.floors - 1) {
    ghost = makeLayer(big, (g, P0) => {
      const P = G.L(P0);
      const c = t.teal[0]; const c2 = mix(t.teal[0], '#ffffff', 0.4);
      for (let l = level + 1; l < G.floors; l++) {
        const y0 = floorY(G, l); const y1 = y0 + FLOOR_H;
        const zf = Math.max(G.zf, G.z1);
        fillPoly(g, silhouette(G.x0, y0, G.z0, G.x1, y1, zf).map(([a, bb]) => [a, bb] as P2).map((p) => p), mix(t.teal[1], t.bg, 0.55));
        const E: Array<[[number, number, number], [number, number, number]]> = [
          [[G.x0, y0, zf], [G.x1, y0, zf]], [[G.x1, y0, zf], [G.x1, y0, G.z0]], [[G.x0, y1, zf], [G.x1, y1, zf]], [[G.x1, y1, zf], [G.x1, y1, G.z0]],
          [[G.x0, y1, G.z0], [G.x1, y1, G.z0]], [[G.x0, y1, G.z0], [G.x0, y1, zf]], [[G.x0, y0, zf], [G.x0, y1, zf]], [[G.x1, y0, zf], [G.x1, y1, zf]], [[G.x1, y0, G.z0], [G.x1, y1, G.z0]],
        ];
        for (const [a, bb] of E) line(g, P(...a), P(...bb), c2);
        for (let k = 1; k < 4; k++) { const yy = y0 + (FLOOR_H * k) / 4; line(g, P(G.x0, yy, zf), P(G.x1, yy, zf), c, 2); line(g, P(G.x1, yy, zf), P(G.x1, yy, G.z0), c, 2); }
      }
    });
  }
  const art: OpenArt = { level, lower, back, front, ghost, items, hits, bands, hole, stairTop };
  openCache.set(key, art);
  if (openCache.size > 40) openCache.delete(openCache.keys().next().value!);
  return art;
}

/** Camada com o destaque (holograma) de uma banda de andar: preenchimento leve, contorno e linhas de varredura. */
const bandCache = new Map<string, Layer>();
export function bandHighlight(faces: P2[][], t: Theme, key: string): Layer {
  const k = `${t.id}|${key}`; const hit = bandCache.get(k); if (hit) return hit;
  const r = rectOf(faces.flat(), 2 * RES);
  const c = document.createElement('canvas'); c.width = r.x1 - r.x0; c.height = r.y1 - r.y0;
  const g = c.getContext('2d')!;
  const fs = faces.map((f) => f.map(([x, y]) => [x - r.x0, y - r.y0] as P2));
  for (const f of fs) fillPoly(g, f, t.teal[0]);
  g.globalCompositeOperation = 'destination-out';
  for (let yy = 0; yy < c.height; yy++) if (yy % 3) { g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, yy, c.width, 1); }
  g.globalCompositeOperation = 'source-over';
  for (const pts of fs) for (let i = 0; i < pts.length; i++) line(g, [Math.round(pts[i][0]), Math.round(pts[i][1])], [Math.round(pts[(i + 1) % pts.length][0]), Math.round(pts[(i + 1) % pts.length][1])], mix(t.teal[0], '#ffffff', 0.55));
  const L = { canvas: c, x0: r.x0, y0: r.y0 };
  bandCache.set(k, L);
  if (bandCache.size > 120) bandCache.delete(bandCache.keys().next().value!);
  return L;
}

/** Caixa no mundo de um prédio inteiro (para a ordenação com quem anda lá fora). */
export function buildingBox(b: BuildingInst, top: number): AABB {
  return { x0: b.foot.x0, y0: 0, z0: b.foot.z0, x1: b.foot.x1, y1: top, z1: b.foot.z1 };
}

// ---------------------------------------------------------------- skin: acabamento das paredes e telhados
/** Acabamento da parede de um andar conforme a skin: enxaimel, néon, camuflagem, listras de praia ou pele de vidro. */
function skinTrim(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, y0: number, y1: number, l: number): void {
  const trim = t.skin?.arch.trim;
  if (!trim || trim === 'none') return;
  const F = G.z1; const Rx = G.x1;
  switch (trim) {
    case 'timber': {
      const W = t.woodDark[1];
      line(g, P(G.x0, y0 + 0.24, F), P(G.x1, y0 + 0.24, F), W); line(g, P(G.x0, y1 - 0.08, F), P(G.x1, y1 - 0.08, F), W);
      line(g, P(Rx, y0 + 0.24, G.z0), P(Rx, y0 + 0.24, F), W); line(g, P(Rx, y1 - 0.08, G.z0), P(Rx, y1 - 0.08, F), W);
      for (let x = G.x0 + 0.05; x <= G.x1; x += 1.6) line(g, P(x, y0 + 0.24, F), P(x, y1 - 0.08, F), W);
      for (let x = G.x0 + 0.05; x + 1.6 <= G.x1; x += 3.2) line(g, P(x, y0 + 0.24, F), P(x + 0.8, y0 + 0.9, F), W);
      for (let z = G.z0 + 0.05; z <= F; z += 1.6) line(g, P(Rx, y0 + 0.24, z), P(Rx, y1 - 0.08, z), mix(W, t.outline, 0.2));
      break;
    }
    case 'neon': {
      const A = t.teal[0]; const B = t.banner[0];
      line(g, P(G.x0, y1 - 0.1, F), P(G.x1, y1 - 0.1, F), l % 2 ? B : A); line(g, P(Rx, y1 - 0.1, G.z0), P(Rx, y1 - 0.1, F), l % 2 ? B : A);
      line(g, P(G.x1, y0, F), P(G.x1, y1, F), A);
      break;
    }
    case 'camo': {
      const C = [mix(t.olive[1], t.wallBack, 0.3), mix(t.earth, t.outline, 0.15), mix(t.sand[1], t.olive[0], 0.35)];
      for (let k = 0; k < 9; k++) {
        const u = G.x0 + 0.4 + ((k * 2.3 + l * 1.1) % (G.x1 - G.x0 - 0.8)); const h0 = y0 + 0.4 + ((k * 0.37 + l) % 1.6);
        backQuad(g, P, F, u, Math.min(G.x1 - 0.1, u + 0.7), h0, Math.min(y1 - 0.1, h0 + 0.35), C[k % 3]);
      }
      for (let k = 0; k < 4; k++) { const z = G.z0 + 0.3 + ((k * 1.9 + l) % Math.max(0.5, F - G.z0 - 0.8)); const h0 = y0 + 0.5 + ((k * 0.53) % 1.4); sideQuad(g, P, Rx, z, Math.min(F - 0.1, z + 0.6), h0, Math.min(y1 - 0.1, h0 + 0.3), C[(k + 1) % 3]); }
      break;
    }
    case 'stripes': {
      if (l > 0) break;
      for (let u = G.x0, k = 0; u < G.x1 - 0.01; u += 0.4, k++) backQuad(g, P, F, u, Math.min(G.x1, u + 0.4), y0 + 0.22, y0 + 0.85, k % 2 ? t.papyrus[0] : t.teal[0]);
      for (let z = G.z0, k = 0; z < F - 0.01; z += 0.4, k++) sideQuad(g, P, Rx, z, Math.min(F, z + 0.4), y0 + 0.22, y0 + 0.85, k % 2 ? mix(t.papyrus[0], t.outline, 0.1) : mix(t.teal[0], t.outline, 0.15));
      break;
    }
    case 'glass': {
      const M = mix(t.window, t.outline, 0.35);
      for (let x = G.x0 + 0.5; x < G.x1; x += 0.5) line(g, P(x, y0 + 0.24, F), P(x, y1 - 0.06, F), M);
      for (let z = G.z0 + 0.5; z < F; z += 0.5) line(g, P(Rx, y0 + 0.24, z), P(Rx, y1 - 0.06, z), M);
      line(g, P(G.x0, y1 - 0.04, F), P(G.x1, y1 - 0.04, F), t.trim);
      break;
    }
  }
}

/** O que a skin põe nos telhados (sorteado por prédio, estável): antena, parabólica, chaminé, bandeira e afins. */
function rooftop(g: CanvasRenderingContext2D, P: Proj, G: Geo, t: Theme, look: StyleLook, top: number): void {
  const list = t.skin?.arch.rooftop;
  if (!list) return;
  let h = 2166136261; for (const c of G.b.id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  let x = (h >>> 0) / 4294967296 * list.reduce((a, [, w]) => a + w, 0); let kind = list[0][0];
  for (const [v, w] of list) { if ((x -= w) < 0) { kind = v; break; } }
  if (kind === 'nada') return;
  const flat = look.roofKind === 'flat' || look.roofKind === 'parapet';
  const y = flat ? top : G.yTop; const zc = (G.z0 + G.zf) / 2;
  const cx = flat ? G.x1 - 1.4 : G.x1 - 1.2;
  switch (kind) {
    case 'antenna':
      line(g, P(cx, y, zc), P(cx, y + 1.6, zc), t.outline); line(g, P(cx - 0.3, y + 1.2, zc), P(cx + 0.3, y + 1.2, zc), t.outline); line(g, P(cx - 0.2, y + 1.45, zc), P(cx + 0.2, y + 1.45, zc), t.outline);
      { const [ax, ay] = P(cx, y + 1.6, zc); g.fillStyle = t.terracotta[0]; g.fillRect(ax - 1, ay - 2, 3, 3); }
      break;
    case 'satellite': {
      line(g, P(cx, y, zc), P(cx, y + 0.5, zc), t.outline);
      const [dx, dy] = P(cx, y + 0.75, zc); blob(g, dx, dy, 6 * RES, 4 * RES, t.outline); blob(g, dx, dy, 5 * RES, 3 * RES, t.marble[0]); g.fillStyle = t.outline; g.fillRect(dx, dy - RES, RES, RES);
      break;
    }
    case 'chimney': {
      const yb = flat ? y : G.yTop + 0.3; isoBox(g, P, cx - 0.22, yb, zc - 0.22, cx + 0.22, (flat ? y : top) + 0.5, zc + 0.22, t.terracotta, t.outline);
      const [sx, sy] = P(cx, (flat ? y : top) + 0.75, zc); g.globalAlpha = 0.5; blob(g, sx + 2, sy, 3 * RES, 2 * RES, t.marble[0]); blob(g, sx + 6, sy - 6, 2 * RES, 2 * RES, t.marble[0]); g.globalAlpha = 1;
      break;
    }
    case 'flag': {
      const yb = flat ? y : top; line(g, P(cx, yb, zc), P(cx, yb + 1.5, zc), t.woodDark[1]);
      fillPoly(g, [P(cx, yb + 1.5, zc), P(cx + 0.8, yb + 1.35, zc), P(cx, yb + 1.1, zc)], t.banner[0]);
      break;
    }
    case 'solar': if (flat) for (const dz of [-0.8, 0.2]) { const z0 = zc + dz; isoBox(g, P, G.x0 + 0.8, y, z0, G.x0 + 2.4, y + 0.12, z0 + 0.7, ['#3a5a8a', '#2a4a7a', '#1f3a5a'], t.outline); } break;
    case 'tank': if (flat) { isoBox(g, P, cx - 0.4, y, zc - 0.4, cx + 0.4, y + 0.4, zc + 0.4, t.stone, t.outline); isoBox(g, P, cx - 0.5, y + 0.4, zc - 0.5, cx + 0.5, y + 1.1, zc + 0.5, [t.marble[0], t.marble[1], t.marble[2]], t.outline); } break;
    case 'sign': {
      const yb = flat ? y : top; const a = G.x0 + 1; const b2 = Math.min(G.x1 - 1, a + 3.2);
      isoBox(g, P, a, yb + 0.3, G.zf - 0.15, b2, yb + 1.2, G.zf - 0.05, [t.outline, t.outline, t.outline]);
      backQuad(g, P, G.zf - 0.04, a + 0.08, b2 - 0.08, yb + 0.38, yb + 1.12, t.banner[1]);
      for (let k = 0; k < 6; k++) { const u = a + 0.3 + k * ((b2 - a - 0.6) / 6); backQuad(g, P, G.zf - 0.03, u, u + 0.28, yb + 0.6, yb + 0.9, k % 2 ? t.teal[0] : t.banner[0]); }
      line(g, P(a, yb, G.zf - 0.1), P(a, yb + 0.3, G.zf - 0.1), t.outline); line(g, P(b2, yb, G.zf - 0.1), P(b2, yb + 0.3, G.zf - 0.1), t.outline);
      break;
    }
    case 'lights': {
      const z = G.zf + 0.05; const yl = G.yTop - 0.05;
      for (let k = 0; k <= 14; k++) { const u = G.x0 + ((G.x1 - G.x0) * k) / 14; const sag = Math.sin((k % 7) / 7 * Math.PI) * 0.18; const [lx, ly] = P(u, yl - sag, z); g.fillStyle = k % 2 ? t.flame[0] : t.teal[0]; g.fillRect(lx - 1, ly - 1, 2 * RES, 2 * RES); }
      break;
    }
  }
}
