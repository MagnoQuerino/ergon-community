/**
 * Arte da cidade: o chão (em blocos de 1024 px, desenhados sob demanda — o mapa pode crescer sem limite),
 * ruas, praças e o chão de cada área (ágora, teatro, termas, ginásio, bairro), os objetos altos das áreas e
 * da decoração gerada (árvores, braseiros, casas) como sprites ordenáveis com caixa, e as áreas clicáveis.
 */
import { theaterRing } from '../world/areas.ts';
import type { AABB, Box } from '../world/geom.ts';
import type { AreaInst, DecorProp, Town } from '../world/town.ts';
import type { Vec2 } from '../world/geom.ts';
import { KX, KY, KZ, RES, project, unproject, type P2, type Rect } from './projection.ts';
import { backQuad, fillPoly, flatQuad, isoBox, line, projector, sideQuad, type Proj } from './raster.ts';
import { amphoraSprite, benchSprite, blob, brazierSprite, bushSprite, cypressSprite, fitSprite, houseSprite, pineSprite, plantSprite, rockSprite, type Sprite } from './props.ts';
import { mix, type Theme } from './theme.ts';
import { skinDecor } from './decorArt.ts';

/** Bloco do chão em pixels do canvas; com zoom aberto, cada bloco cobre mais mundo em resolução menor. */
export const CHUNK = 512;
export interface CityItem { sprite: Sprite; px: number; py: number; box: AABB; id: string; area?: string }
export type AreaHitKind = 'conexoes' | 'atividade' | 'casa' | 'termas' | 'ginasio' | 'agora' | 'lote' | 'teatro';
export interface AreaHit { kind: AreaHitKind; poly: P2[]; ref?: number; areaId?: string; lot?: [number, number] }

function rnd(seed: number): () => number { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const boxPoly = (b: Box, y = 0): P2[] => [project(b.x0, y, b.z0), project(b.x1, y, b.z0), project(b.x1, y, b.z1), project(b.x0, y, b.z1)];
const screenBox = (b: Box, h = 0): Rect => {
  const pts = [project(b.x0, 0, b.z0), project(b.x1, 0, b.z0), project(b.x1, 0, b.z1), project(b.x0, 0, b.z1), project(b.x0, h, b.z0), project(b.x1, h, b.z1)];
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
};
const hitsRect = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// ---------------------------------------------------------------- chão
/** Lajes de uma praça: tons sorteados por laje (não xadrez) e rejunte discreto. */
function paving(g: CanvasRenderingContext2D, P: Proj, b: Box, tile: number, tones: [string, string], grout: string): void {
  const third = mix(tones[0], tones[1], 0.5);
  for (let x = b.x0; x < b.x1 - 1e-6; x += tile) for (let z = b.z0; z < b.z1 - 1e-6; z += tile) {
    const h = hash2(Math.round(x / tile * 3), Math.round(z / tile * 5));
    flatQuad(g, P, 0, x, z, Math.min(b.x1, x + tile), Math.min(b.z1, z + tile), h < 0.4 ? tones[0] : h < 0.8 ? tones[1] : third);
  }
  const soft = mix(grout, tones[0], 0.35);
  for (let x = b.x0 + tile; x < b.x1 - 1e-6; x += tile) line(g, P(x, 0, b.z0), P(x, 0, b.z1), soft);
  for (let z = b.z0 + tile; z < b.z1 - 1e-6; z += tile) line(g, P(b.x0, 0, z), P(b.x1, 0, z), soft);
}

/** Ruído suave e determinístico (o mesmo chão em todo bloco e em toda visita). */
function hash2(i: number, j: number): number {
  let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x: number, z: number): number {
  const i = Math.floor(x); const j = Math.floor(z);
  const sx = x - i; const sz = z - j; const fx = sx * sx * (3 - 2 * sx); const fz = sz * sz * (3 - 2 * sz);
  const a = hash2(i, j); const b = hash2(i + 1, j); const c = hash2(i, j + 1); const d = hash2(i + 1, j + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
/** Umidade do chão num ponto do mundo: manchas grandes e suaves, com um pouco de grão. 0 = verde, 1 = seco. */
export function groundAt(x: number, z: number): number {
  return 0.68 * valueNoise(x / 7.5, z / 7.5) + 0.32 * valueNoise(x / 2.6 + 31.7, z / 2.6 + 17.3);
}

/** Polígono convexo de um círculo no chão (largos, pontas de rua). */
const discPoly = (P: Proj, x: number, z: number, r: number, n = 14): P2[] =>
  Array.from({ length: n }, (_, k) => P(x + r * Math.cos((k / n) * Math.PI * 2), 0, z + r * Math.sin((k / n) * Math.PI * 2)));

/** Faixa de uma polilinha no chão, em quadriláteros convexos + juntas redondas (desenho nítido, sem suavização). */
function band(g: CanvasRenderingContext2D, P: Proj, pts: Vec2[], half: number, color: string): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]; const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az) || 1; const nx = (-(bz - az) / len) * half; const nz = ((bx - ax) / len) * half;
    fillPoly(g, [P(ax + nx, 0, az + nz), P(bx + nx, 0, bz + nz), P(bx - nx, 0, bz - nz), P(ax - nx, 0, az - nz)], color);
    if (i > 0) fillPoly(g, discPoly(P, ax, az, half, 10), color);
  }
}

/** Ruas sinuosas de terra batida: borda, miolo, as marcas das rodas e uma ou outra pedrinha. */
function drawRoads(g: CanvasRenderingContext2D, P: Proj, town: Town, t: Theme, r: Rect): void {
  const near = (pts: Vec2[], pad: number) => {
    const sp = pts.map(([x, z]) => project(x, 0, z));
    return hitsRect({ x0: Math.min(...sp.map((p) => p[0])) - pad, y0: Math.min(...sp.map((p) => p[1])) - pad, x1: Math.max(...sp.map((p) => p[0])) + pad, y1: Math.max(...sp.map((p) => p[1])) + pad }, r);
  };
  const roads = town.roads.filter((rd) => near(rd.pts, 2 * KX));
  const joins = town.junctions.filter((j) => near([[j.x, j.z]], 2 * KX));
  for (const rd of roads) band(g, P, rd.pts, rd.w / 2 + 0.14, t.road.edge);
  for (const j of joins) fillPoly(g, discPoly(P, j.x, j.z, j.r + 0.14), t.road.edge);
  for (const rd of roads) band(g, P, rd.pts, rd.w / 2, t.road.fill);
  for (const j of joins) fillPoly(g, discPoly(P, j.x, j.z, j.r), t.road.fill);
  if (t.skin?.roadLine) {
    const C = mix(t.road.fill, '#f2f0e6', 0.6);
    for (const rd of roads) for (let i = 0; i < rd.pts.length - 1; i++) { const [ax, az] = rd.pts[i]; const [bx, bz] = rd.pts[i + 1]; line(g, P(ax, 0, az), P(bx, 0, bz), C, 3); }
    return;
  }
  for (const rd of roads) {
    // marcas das rodas: duas trilhas paralelas, interrompidas (terra batida, não asfalto)
    for (const side of [-0.3, 0.3]) for (let i = 0; i < rd.pts.length - 1; i++) {
      if (hash2(i * 7 + (side > 0 ? 1 : 0), rd.a[0] * 31 + rd.a[1] * 17 + rd.b[0]) < 0.3) continue;
      const [ax, az] = rd.pts[i]; const [bx, bz] = rd.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1; const nx = (-(bz - az) / len) * side; const nz = ((bx - ax) / len) * side;
      line(g, P(ax + nx, 0, az + nz), P(bx + nx, 0, bz + nz), t.road.rut);
    }
    const R = rnd(rd.a[0] * 97 + rd.a[1] * 89 + rd.b[0] * 83 + rd.b[1] * 79);
    for (let k = 0; k < 6; k++) {
      const i = Math.floor(R() * (rd.pts.length - 1)); const f = R(); const [ax, az] = rd.pts[i]; const [bx, bz] = rd.pts[i + 1];
      const [x, y] = P(ax + (bx - ax) * f + (R() - 0.5) * rd.w * 0.7, 0, az + (bz - az) * f + (R() - 0.5) * rd.w * 0.7);
      g.fillStyle = k % 2 ? t.road.edge : t.pebble; g.fillRect(x, y, RES, 1);
    }
  }
}

function drawAgora(g: CanvasRenderingContext2D, P: Proj, t: Theme): void {
  // mosaico de boas-vindas no centro, borda da praça
  ([[1.3, t.gold], [1.0, t.carpet.field], [0.7, t.teal[1]], [0.42, t.gold], [0.18, t.carpet.field]] as const)
    .forEach(([s, c]) => flatQuad(g, P, 0, -1.0 - s, -4.6 - s, -1.0 + s, -4.6 + s, c));
  const e = 7;
  for (const [a, b] of [[[-e, -e], [e, -e]], [[e, -e], [e, e]], [[e, e], [-e, e]], [[-e, e], [-e, -e]]] as const) line(g, P(a[0], 0, a[1]), P(b[0], 0, b[1]), t.stone[2]);
}

function drawTheater(g: CanvasRenderingContext2D, P: Proj, t: Theme, a: AreaInst): void {
  const T = a.def.theater!;
  const rad = (d: number) => (d * Math.PI) / 180;
  const pt = (r: number, ang: number, y: number) => P(T.x + r * Math.cos(ang), y, T.z + r * Math.sin(ang));
  const ring = (R: number, y: number) => Array.from({ length: 36 }, (_, k) => pt(R, (k / 36) * Math.PI * 2, y));
  fillPoly(g, ring(T.orchestra + 0.12, 0), t.stone[2]); fillPoly(g, ring(T.orchestra, 0.01), t.stone[0]);
  fillPoly(g, ring(0.5, 0.02), mix(t.stone[0], t.stone[1], 0.6));
  const a0 = rad(T.a0); const a1 = rad(T.a1); const step = rad(7.5);
  const edge = mix(t.stone[0], '#ffffff', 0.35);
  for (let i = T.rows - 1; i >= 0; i--) {
    const { inner, outer, top } = theaterRing(T, i);
    for (let ang = a0; ang < a1 - 1e-6; ang += step) { const b = Math.min(a1, ang + step); fillPoly(g, [pt(inner, ang, top), pt(outer, ang, top), pt(outer, b, top), pt(inner, b, top)], t.stone[0]); }
    for (let ang = a0; ang < a1 - 1e-6; ang += step) {
      const b = Math.min(a1, ang + step); const mid = (((ang + b) / 2) * 180) / Math.PI;
      if (mid <= 135 || mid >= 315) continue;
      fillPoly(g, [pt(inner, ang, top), pt(inner, b, top), pt(inner, b, 0), pt(inner, ang, 0)], mid < 225 ? t.stone[2] : t.stone[1]);
      line(g, pt(inner, ang, top), pt(inner, b, top), edge);
    }
  }
  for (const d of [165, 225, 285]) for (let i = 0; i < T.rows; i++) {
    const { inner, outer, top } = theaterRing(T, i);
    for (const f of [0.33, 0.66]) { const r = inner + (outer - inner) * f; line(g, pt(r, rad(d - 2.2), top), pt(r, rad(d + 2.2), top), t.stone[2]); }
  }
  for (const [ang, tone] of [[a0, t.stone[1]], [a1, t.stone[2]]] as const) for (let i = 0; i < T.rows; i++) {
    const { inner, outer, top } = theaterRing(T, i);
    fillPoly(g, [pt(inner, ang, top), pt(outer, ang, top), pt(outer, ang, 0), pt(inner, ang, 0)], tone);
    line(g, pt(inner, ang, top), pt(outer, ang, top), edge);
  }
}

function drawTermas(g: CanvasRenderingContext2D, P: Proj, t: Theme, a: AreaInst): void {
  const p = a.def.pool!; const W = p.water; const r = p.rim; const wy = -0.1; const ry = 0.12;
  paving(g, P, p.deck, 1, [t.stone[0], mix(t.stone[0], t.stone[1], 0.6)], t.stone[1]);
  flatQuad(g, P, wy, W.x0, W.z0, W.x1, W.z1, t.water[1]);
  flatQuad(g, P, wy, W.x0, W.z0, W.x1, W.z0 + 0.5, t.water[2]);
  const S = p.steps; for (let i = 0; i < 3; i++) flatQuad(g, P, wy, S.x0 + i * 0.27, S.z0, S.x0 + i * 0.27 + 0.13, S.z1, t.water[0]);
  for (const z of p.lanes.slice(0, -1).map((v: number, i: number) => (v + p.lanes[i + 1]) / 2)) line(g, P(W.x0 + 0.9, wy, z), P(W.x1 - 0.2, wy, z), mix(t.water[1], t.papyrus[0], 0.35), 2); // cordas das raias
  const R = rnd(11); g.fillStyle = t.water[0];
  for (let i = 0; i < 30; i++) { const [x, yy] = P(W.x0 + 0.3 + R() * (W.x1 - W.x0 - 0.6), wy, W.z0 + 0.6 + R() * (W.z1 - W.z0 - 0.8)); g.fillRect(x, yy, 3 * RES, 1); }
  backQuad(g, P, W.z0, W.x0, W.x1, wy, 0, mix(t.stone[1], t.water[2], 0.3));
  sideQuad(g, P, W.x0, W.z0, W.z1, wy, 0, mix(t.stone[2], t.water[2], 0.3));
  const rim = [t.marble[0], t.marble[1], t.marble[2]] as [string, string, string];
  isoBox(g, P, W.x0 - r, 0, W.z0 - r, W.x1 + r, ry, W.z0, rim, t.outline);
  isoBox(g, P, W.x0 - r, 0, W.z0, W.x0, ry, W.z1, rim, t.outline);
  isoBox(g, P, W.x1, 0, W.z0, W.x1 + r, ry, W.z1, rim, t.outline);
  isoBox(g, P, W.x0 - r, 0, W.z1, W.x1 + r, ry, W.z1 + r, rim, t.outline);
}

function drawGym(g: CanvasRenderingContext2D, P: Proj, t: Theme, a: AreaInst): void {
  const gy = a.def.gym!; const R = rnd(21);
  const sandy = (b: Box, tone: string, speck: string) => {
    flatQuad(g, P, 0, b.x0, b.z0, b.x1, b.z1, tone); g.fillStyle = speck;
    for (let i = 0; i < (b.x1 - b.x0) * (b.z1 - b.z0) * 3; i++) { const [x, y] = P(b.x0 + R() * (b.x1 - b.x0), 0, b.z0 + R() * (b.z1 - b.z0)); g.fillRect(x, y, 1, 1); }
  };
  const T = gy.track; sandy(T, t.sand[1], t.sand[0]);
  line(g, P((T.x0 + T.x1) / 2, 0, T.z0 + 0.4), P((T.x0 + T.x1) / 2, 0, T.z1 - 0.4), t.stone[0], 3);
  for (const z of [T.z0 + 0.6, T.z1 - 0.6]) isoBox(g, P, T.x0 + 0.1, 0, z - 0.1, T.x1 - 0.1, 0.05, z + 0.1, t.stone, t.outline);
  const C = gy.court; sandy(C, t.sand[0], t.sand[1]);
  const c = 0.14; const cy = 0.12;
  isoBox(g, P, C.x0 - c, 0, C.z0 - c, C.x1 + c, cy, C.z0, t.stone, t.outline);
  isoBox(g, P, C.x0 - c, 0, C.z0, C.x0, cy, C.z1, t.stone, t.outline);
  isoBox(g, P, C.x1, 0, C.z0, C.x1 + c, cy, C.z1, t.stone, t.outline);
  isoBox(g, P, C.x0 - c, 0, C.z1, C.x1 + c, cy, C.z1 + c, t.stone, t.outline);
  const [dx, dy] = P(gy.discus[0], 0, gy.discus[1]); blob(g, dx, dy, 4 * RES, 2 * RES, mix(t.sand[0], t.outline, 0.25)); blob(g, dx, dy, 3 * RES, RES + 1, t.sand[0]);
  const [wx, wy] = P(gy.ring[0], 0, gy.ring[1]); blob(g, wx, wy, 11 * RES, 5 * RES + 1, mix(t.sand[0], t.terracotta[1], 0.3)); blob(g, wx, wy, 10 * RES, 5 * RES, t.sand[0]);
}

/**
 * Água fora da cidade (skins com mar ou lagoas): começa longe da borda (a paisagem da borda fica em terra) e cresce
 * com a distância. Devolve a profundidade (0 = terra) para o tom: espuma, raso, fundo.
 */
function waterAt(town: Town, t: Theme, x: number, z: number): number {
  const w = t.skin?.water ?? 0;
  if (w <= 0) return 0;
  const B = town.bounds;
  const d = Math.max(B.x0 - x, x - B.x1, B.z0 - z, z - B.z1);
  // a costa começa a uma distância irregular (3 a 10 unidades), e a água cresce aos poucos: praia e lagos com forma
  const edge = 3 + groundAt(x * 0.19 + 53, z * 0.19 - 41) * 7;
  if (d < edge) return 0;
  const n = groundAt(x * 0.45 + 131, z * 0.45 - 77);
  const level = w * Math.min(1, (d - edge) / 5) + Math.min(0.25, (d - edge) * 0.02) * Math.min(1, w / 0.3);
  return Math.max(0, level - n * 0.6);
}

/** Desenha o chão de um bloco (rect em pixels do mundo) num canvas de CHUNK × CHUNK, na escala `s` (1, 1/2 ou 1/4). */
export function drawGroundChunk(g: CanvasRenderingContext2D, town: Town, t: Theme, r: Rect, ci: number, cj: number, s = 1): void {
  g.setTransform(s, 0, 0, s, 0, 0);
  const P = projector(-r.x0, -r.y0);
  const w = r.x1 - r.x0; const h = r.y1 - r.y0;
  g.fillStyle = t.bg; g.fillRect(0, 0, w, h);
  // manchas do chão (verde, seco) em ladrilhos de meia unidade: bordas em degrau, como o resto da pixel art
  const corners = [unproject(r.x0, r.y0), unproject(r.x1, r.y0), unproject(r.x0, r.y1), unproject(r.x1, r.y1)];
  const TILE = 0.5;
  const xa = Math.floor(Math.min(...corners.map((c) => c[0])) / TILE) * TILE - TILE; const xb = Math.max(...corners.map((c) => c[0])) + TILE;
  const za = Math.floor(Math.min(...corners.map((c) => c[1])) / TILE) * TILE - TILE; const zb = Math.max(...corners.map((c) => c[1])) + TILE;
  for (let x = xa; x < xb; x += TILE) for (let z = za; z < zb; z += TILE) {
    const [px, py] = project(x + TILE / 2, 0, z + TILE / 2);
    if (px < r.x0 - KX || px > r.x1 + KX || py < r.y0 - KY || py > r.y1 + KY) continue;
    const n = groundAt(x + TILE / 2, z + TILE / 2);
    const wet = waterAt(town, t, x + TILE / 2, z + TILE / 2);
    if (wet > 0) { flatQuad(g, P, 0, x - 0.03, z - 0.03, x + TILE + 0.03, z + TILE + 0.03, wet > 0.14 ? mix(t.water[1], t.water[2], 0.45) : wet > 0.04 ? t.water[1] : t.water[0]); continue; }
    if (n < 0.37) flatQuad(g, P, 0, x, z, x + TILE, z + TILE, t.ground[0]);
    else if (n > 0.65) flatQuad(g, P, 0, x, z, x + TILE, z + TILE, t.ground[1]);
  }
  const R = rnd(ci * 7919 + cj * 104729 + 17);
  const at = (sx: number, sy: number) => { const [x, z] = unproject(sx + r.x0, sy + r.y0); return groundAt(x, z); };
  // pedrinhas (às vezes uma maior, com luz em cima)
  for (let i = 0; i < (w * h) / 260; i++) {
    const x = Math.floor(R() * w); const y = Math.floor(R() * h);
    if (i % 9 === 0) { g.fillStyle = t.pebble; g.fillRect(x, y, 2, 1); g.fillStyle = t.ground[1]; g.fillRect(x, y - 1, 1, 1); }
    else { g.fillStyle = t.pebble; g.fillRect(x, y, 1, 1); }
  }
  // capim: mais nas manchas verdes, quase nada nas secas
  if (t.grass) {
    const dark = mix(t.grass, t.outline, 0.25);
    for (let i = 0; i < (w * h) / 520; i++) {
      const x = Math.floor(R() * w); const y = Math.floor(R() * h);
      if (at(x, y) > 0.5 + R() * 0.15) continue;
      g.fillStyle = t.grass; g.fillRect(x, y, 1, 2); g.fillRect(x + 2, y - 1, 1, 3);
      g.fillStyle = dark; g.fillRect(x + 4, y, 1, 2);
    }
  }
  // florzinhas, raras, só nas manchas verdes (de dia)
  if (t.flowers.length) for (let i = 0; i < (w * h) / 4200; i++) {
    const x = Math.floor(R() * w); const y = Math.floor(R() * h);
    if (at(x, y) > 0.4) continue;
    g.fillStyle = t.flowers[Math.floor(R() * t.flowers.length)]; g.fillRect(x, y, RES, RES / 2);
  }
  // sombra das árvores no chão (o sol vem da esquerda)
  g.globalAlpha = 0.16; g.fillStyle = t.shadow;
  const trees: Array<{ x: number; z: number; k: number; big: number }> = [];
  for (const d of town.decor) if (['cypress', 'olive', 'pine', 'palm', 'bigtree', 'cherry'].includes(d.kind)) trees.push({ x: d.x, z: d.z, k: d.k, big: d.kind === 'pine' || d.kind === 'bigtree' ? 1.6 : d.kind === 'cypress' ? 0.7 : 1.2 });
  for (const a of town.areas.values()) for (const p of a.def.props) if (p.kind === 'olive' || p.kind === 'cypress') trees.push({ x: p.x + a.ox, z: p.z + a.oz, k: p.k ?? 1, big: p.kind === 'olive' ? 1.2 : 0.7 });
  for (const tr of trees) {
    const [sx, sy] = P(tr.x + 0.35 * tr.k, 0, tr.z + 0.1);
    if (sx < -60 || sy < -40 || sx > w + 60 || sy > h + 40) continue;
    blob(g, sx + Math.round(6 * RES * tr.big), sy, Math.round(10 * RES * tr.big * tr.k), Math.round(3 * RES * tr.big * tr.k), t.shadow);
  }
  g.globalAlpha = 1;
  drawRoads(g, P, town, t, r);
  for (const a of town.areas.values()) {
    if (!hitsRect(screenBox(a.lot, 1.6), r)) continue;
    const L: Proj = (x, y, z) => P(x + a.ox, y, z + a.oz);
    for (const p of a.def.paved) paving(g, L, p, 2, t.plaza, t.plazaGrout);
    if (a.kind === 'agora') drawAgora(g, L, t);
    else if (a.kind === 'teatro') drawTheater(g, L, t, a);
    else if (a.kind === 'termas') drawTermas(g, L, t, a);
    else if (a.kind === 'ginasio') drawGym(g, L, t, a);
  }
}

// ---------------------------------------------------------------- objetos altos
const cache = new Map<string, Sprite>();
function cached(key: string, make: () => Sprite): Sprite { let s = cache.get(key); if (!s) { s = make(); cache.set(key, s); } return s; }

export function oliveTreeSprite(t: Theme, k: number): Sprite {
  return cached(`${t.id}|olive|${k.toFixed(2)}`, () => fitSprite(-1.1, 0, -1.1, 1.1, 2.6 * k, 1.1, (g, P) => {
    line(g, P(0, 0, 0), P(0.1, 1.0 * k, 0.05), t.woodDark[1]); line(g, P(0.04, 0, 0), P(0.14, 1.0 * k, 0.05), t.woodDark[0]);
    line(g, P(0.1, 0.8 * k, 0.05), P(-0.3, 1.4 * k, 0), t.woodDark[1]);
    const [cx, cy] = P(0, 1.7 * k, 0); const s = RES;
    const parts: Array<[number, number, number, number]> = [[-7, 1, 7, 4], [6, 0, 7, 4], [0, -4, 8, 5], [-2, 4, 6, 3]];
    for (const [x, y, rx, ry] of parts) blob(g, cx + x * s, cy + y * s, rx * s + 1, ry * s + 1, t.outline);
    for (const [x, y, rx, ry] of parts) blob(g, cx + x * s, cy + y * s, rx * s, ry * s, t.olive[1]);
    for (const [x, y, rx, ry] of parts) blob(g, cx + x * s - s, cy + y * s - s, Math.max(1, rx * s - 3 * s), Math.max(1, ry * s - 2 * s), t.olive[0]);
    g.fillStyle = mix(t.olive[0], '#ffffff', 0.25);
    for (let i = 0; i < 9; i++) g.fillRect(cx + ((i * 37) % 22 - 11) * s, cy + ((i * 17) % 8 - 5) * s, s, 1);
  }));
}

function fountainSprite(t: Theme, r: number): Sprite {
  return cached(`${t.id}|fountain|${r}`, () => fitSprite(-r - 0.15, 0, -r - 0.15, r + 0.15, 1.8, r + 0.15, (g, P) => {
    const [cx, cy] = P(0, 0, 0); const A = Math.round(r * Math.SQRT2 * KX); const B = Math.round(A / 2); const h = Math.round(0.38 * KZ);
    blob(g, cx, cy, A + 1, B + 1, t.outline); blob(g, cx, cy, A, B, t.marble[2]);
    for (let k = 0; k < h; k++) blob(g, cx, cy - k, A, B, k < h - 2 ? t.marble[1] : t.marble[0]);
    g.fillStyle = t.marble[2]; for (let x = -A + 2; x <= A - 2; x += 5) g.fillRect(cx + x, cy + Math.round(B * Math.sqrt(Math.max(0, 1 - (x * x) / (A * A)))) - h + 2, 1, h - 3);
    blob(g, cx, cy - h, A - 3, B - 2, t.water[1]); blob(g, cx - 3, cy - h - 1, A - 9, B - 5, t.water[0]);
    isoBox(g, P, -0.16, 0.3, -0.16, 0.16, 1.45, 0.16, t.marble, t.outline);
    isoBox(g, P, -0.22, 1.45, -0.22, 0.22, 1.56, 0.22, t.marble, t.outline);
    const [sx, sy] = P(0.16, 1.1, 0.16); g.fillStyle = t.bronze[0]; g.fillRect(sx - 1, sy - 2, 3, 3);
    g.fillStyle = t.water[0]; for (let i = 0; i < 6; i++) g.fillRect(sx + 2 + Math.round(i * 1.2), sy + i * 2, RES, 2);
  }));
}

function muralSprite(t: Theme, hx: number, hz: number): Sprite {
  return cached(`${t.id}|mural|${hx}|${hz}`, () => fitSprite(-hx - 0.1, 0, -hz - 0.1, hx + 0.1, 2.1, hz + 0.1, (g, P) => {
    isoBox(g, P, -hx, 0, -hz, hx, 0.42, hz, t.stone, t.outline);
    line(g, P(-hx, 0.36, hz), P(hx, 0.36, hz), t.stone[0]);
    for (const u of [-hx + 0.08, -0.48, 0.52]) {
      const a = u; const b = u + 0.92;
      isoBox(g, P, a, 0.42, -0.06, b, 1.7, 0.06, t.woodDark, t.outline);
      backQuad(g, P, 0.06, a + 0.07, b - 0.07, 0.52, 1.6, t.wood[0]);
      for (const [px, py, c] of [[0.12, 1.22, t.papyrus[0]], [0.5, 1.28, t.papyrus[0]], [0.3, 0.8, t.papyrus[0]], [0.62, 0.86, t.papyrus[1]]] as const) {
        backQuad(g, P, 0.061, a + px, a + px + 0.24, py, py + 0.3, c);
        const [lx, ly] = P(a + px + 0.12, py + 0.3, 0.062); g.fillStyle = (px * 10) % 2 ? t.terracotta[1] : t.teal[1]; g.fillRect(lx - 1, ly, RES, RES);
      }
    }
    isoBox(g, P, -hx - 0.06, 1.7, -0.12, hx + 0.06, 1.84, 0.12, t.terracotta, t.outline);
  }));
}

function hermSprite(t: Theme): Sprite {
  return cached(`${t.id}|herm`, () => fitSprite(-0.3, 0, -0.3, 0.3, 1.9, 0.3, (g, P) => {
    isoBox(g, P, -0.18, 0, -0.18, 0.18, 1.25, 0.18, t.marble, t.outline);
    const [hx, hy] = P(0, 1.45, 0); blob(g, hx, hy, 4 * RES, 4 * RES, t.outline); blob(g, hx, hy, 4 * RES - 1, 4 * RES - 1, t.marble[1]); blob(g, hx - 2, hy - 2, 2 * RES, 2 * RES, t.marble[0]);
  }));
}

const tall = (kind: string, k: number): number => (kind === 'cypress' ? 3.4 * k : kind === 'olive' ? 2.6 * k : kind === 'pine' ? 3.6 * k : kind === 'rock' ? 0.5 * k : 1.5);

/** Objetos altos das áreas e da decoração gerada, com caixa no mundo. */
export function cityItems(town: Town, t: Theme): CityItem[] {
  const out: CityItem[] = [];
  const put = (sprite: Sprite, x: number, z: number, box: Box, h: number, id: string, area?: string) => {
    const [px, py] = project(x, 0, z);
    out.push({ sprite, px, py, box: { x0: box.x0, y0: 0, z0: box.z0, x1: box.x1, y1: h, z1: box.z1 }, id, area });
  };
  const sq = (x: number, z: number, r: number): Box => ({ x0: x - r, z0: z - r, x1: x + r, z1: z + r });
  const swap = t.skin?.swap as Record<string, string> | undefined;
  for (const a of town.areas.values()) {
    a.def.props.forEach((p, i) => {
      const x = p.x + a.ox; const z = p.z + a.oz; const id = `${a.id}:${i}`;
      const to = swap?.[p.kind];
      if (to === 'nada') return;
      if (to) { const sd = skinDecor(to, t, p.k ?? 1, i % 3) ?? baseDecor(to, t, p.k ?? 1, i % 3); if (sd) { put(sd.sprite, x, z, sq(x, z, sd.r), sd.h, id, a.id); return; } }
      switch (p.kind) {
        case 'olive': put(oliveTreeSprite(t, p.k ?? 1), x, z, sq(x, z, 0.25), tall('olive', p.k ?? 1), id, a.id); break;
        case 'cypress': put(cypressSprite(t, p.k ?? 1), x, z, sq(x, z, 0.25), tall('cypress', p.k ?? 1), id, a.id); break;
        case 'fountain': { const r = a.def.fountain?.r ?? 1; put(fountainSprite(t, r), x, z, sq(x, z, r), 1.6, id, a.id); break; }
        case 'mural': { const M = a.def.mural!; const hx = (M.x1 - M.x0) / 2; const hz = (M.z1 - M.z0) / 2; put(muralSprite(t, hx, hz), x, z, { x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz }, 1.85, id, a.id); break; }
        case 'bench': put(benchSprite(t), x, z, { x0: x - 0.9, z0: z - 0.26, x1: x + 0.9, z1: z + 0.26 }, 0.48, id, a.id); break;
        case 'brazier': put(brazierSprite(t), x, z, sq(x, z, 0.28), 1.5, id, a.id); break;
        case 'herm': put(hermSprite(t), x, z, sq(x, z, 0.2), 1.9, id, a.id); break;
        case 'amphora': put(amphoraSprite(t, (p.variant ?? 0) % 2 === 1), x, z, sq(x, z, 0.2), 1.0, id, a.id); break;
        case 'plant': put(plantSprite(t), x, z, sq(x, z, 0.24), 1.4, id, a.id); break;
        case 'bush': put(bushSprite(t), x, z, sq(x, z, 0.3), 0.6, id, a.id); break;
        case 'house': {
          const w = p.w ?? 2.4; const d = p.d ?? 2.2; const h = p.h ?? 2;
          put(houseSprite(t, w, h, d), x, z, { x0: x, z0: z - d, x1: x + w, z1: z }, h + 1.2, id, a.id);
          break;
        }
      }
    });
  }
  town.decor.forEach((d: DecorProp, i) => {
    const id = `decor:${i}`;
    const sd = skinDecor(d.kind, t, d.k, d.v ?? 0);
    if (sd) { put(sd.sprite, d.x, d.z, sq(d.x, d.z, sd.r), sd.h, id); return; }
    if (d.kind === 'brazier') put(brazierSprite(t), d.x, d.z, sq(d.x, d.z, 0.28), 1.5, id);
    else if (d.kind === 'cypress') put(cypressSprite(t, d.k), d.x, d.z, sq(d.x, d.z, 0.25), tall('cypress', d.k), id);
    else if (d.kind === 'olive') put(oliveTreeSprite(t, Math.round(d.k * 4) / 4), d.x, d.z, sq(d.x, d.z, 0.25), tall('olive', d.k), id);
    else if (d.kind === 'pine') put(pineSprite(t, Math.round(d.k * 4) / 4, d.v ?? 0), d.x, d.z, sq(d.x, d.z, 0.25), tall('pine', d.k), id);
    else if (d.kind === 'rock') put(rockSprite(t, d.k, d.v ?? 0), d.x, d.z, sq(d.x, d.z, 0.4 * d.k), tall('rock', d.k), id);
    else put(bushSprite(t), d.x, d.z, sq(d.x, d.z, 0.3), 0.6, id);
  });
  return out;
}

/** Objetos gregos usados como troca pelas skins (árvores, pedras, braseiro). */
function baseDecor(kind: string, t: Theme, k: number, v: number): { sprite: Sprite; r: number; h: number } | null {
  switch (kind) {
    case 'olive': return { sprite: oliveTreeSprite(t, Math.round(k * 4) / 4), r: 0.25, h: tall('olive', k) };
    case 'cypress': return { sprite: cypressSprite(t, k), r: 0.25, h: tall('cypress', k) };
    case 'pine': return { sprite: pineSprite(t, Math.round(k * 4) / 4, v), r: 0.25, h: tall('pine', k) };
    case 'rock': return { sprite: rockSprite(t, k, v), r: 0.4 * k, h: tall('rock', k) };
    case 'bush': return { sprite: bushSprite(t), r: 0.3, h: 0.6 };
    case 'brazier': return { sprite: brazierSprite(t), r: 0.28, h: 1.5 };
    default: return null;
  }
}

/** Áreas clicáveis da cidade (objetos pequenos antes das áreas grandes) e os lotes livres (loja). */
export function areaHits(town: Town): AreaHit[] {
  const hits: AreaHit[] = [];
  for (const a of town.areas.values()) {
    const o = (b: Box): Box => ({ x0: b.x0 + a.ox, z0: b.z0 + a.oz, x1: b.x1 + a.ox, z1: b.z1 + a.oz });
    if (a.kind === 'agora' && a.def.mural) { const M = o(a.def.mural); hits.push({ kind: 'conexoes', areaId: a.id, poly: [project(M.x0, 1.85, M.z0), project(M.x1, 1.85, M.z0), project(M.x1, 0, M.z0), project(M.x1, 0, M.z1), project(M.x0, 0, M.z1), project(M.x0, 1.85, M.z1)] }); }
    if (a.kind === 'bairro') for (const h of a.def.houses) {
      const B = o(h); const top = h.h + 1.1;
      hits.push({ kind: 'casa', ref: h.id, areaId: a.id, poly: [project(B.x0, top, B.z0), project(B.x1, top, B.z0), project(B.x1, 0, B.z0), project(B.x1, 0, B.z1), project(B.x0, 0, B.z1), project(B.x0, top, B.z1)] });
    }
    if (a.kind === 'teatro' && a.def.theater) {
      const T = a.def.theater; const outer = theaterRing(T, T.rows - 1).outer; const H = theaterRing(T, T.rows - 1).top; const arc: P2[] = [];
      for (let d = T.a0; d <= T.a1; d += 15) { const r = (d * Math.PI) / 180; arc.push(project(a.ox + T.x + outer * Math.cos(r), H, a.oz + T.z + outer * Math.sin(r))); }
      for (let d = T.a1 + 30; d < T.a0 + 360; d += 30) { const r = (d * Math.PI) / 180; arc.push(project(a.ox + T.x + T.orchestra * Math.cos(r), 0, a.oz + T.z + T.orchestra * Math.sin(r))); }
      hits.push({ kind: 'atividade', areaId: a.id, poly: arc });
    }
    const kind: AreaHitKind | null = a.kind === 'termas' ? 'termas' : a.kind === 'ginasio' ? 'ginasio' : a.kind === 'agora' ? 'agora' : a.kind === 'bairro' ? 'casa' : a.kind === 'teatro' ? 'teatro' : null;
    if (kind && kind !== 'casa') hits.push({ kind, areaId: a.id, poly: boxPoly(a.lot) });
  }
  for (const l of town.lots) hits.push({ kind: 'lote', lot: [l.i, l.j], poly: boxPoly(l.box) });
  return hits;
}

export { boxPoly, screenBox };
