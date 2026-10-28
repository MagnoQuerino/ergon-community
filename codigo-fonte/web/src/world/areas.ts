/**
 * Áreas da cidade como modelos em coordenadas locais (origem no centro do lote): ágora, teatro, termas,
 * ginásio e bairro. Cada modelo declara o chão pavimentado, os obstáculos (para a navegação), os objetos
 * altos (ordenáveis com quem anda), os pontos de uso da vida ambiente e as casas. Mover a área no editor do
 * mapa só muda a origem; tudo acompanha.
 */
import { boxAt, type Box, type Vec2 } from './geom.ts';
import { benchSeat, type Activity } from './buildings.ts';

export type AreaKind = 'agora' | 'teatro' | 'termas' | 'ginasio' | 'bairro';
export type AreaPropKind = 'olive' | 'cypress' | 'fountain' | 'mural' | 'bench' | 'brazier' | 'house' | 'herm' | 'amphora' | 'plant' | 'bush';
export interface AreaProp { kind: AreaPropKind; x: number; z: number; k?: number; w?: number; d?: number; h?: number; variant?: number }
export interface Seat { spot: Vec2; y: number; mirror: boolean }
export interface House { id: number; x0: number; z0: number; x1: number; z1: number; h: number; door: Vec2; street: Vec2 }
export interface TheaterGeo { x: number; z: number; r0: number; row: number; rows: number; rise: number; a0: number; a1: number; orchestra: number }

export interface AreaDef {
  kind: AreaKind;
  name: string;
  paved: Box[];
  blocks: Box[];
  circles: Array<{ x: number; z: number; r: number }>;
  /** bloqueio por forma (arquibancada): local */
  blockTest?: (x: number, z: number) => boolean;
  props: AreaProp[];
  activities: Activity[];
  chats: Vec2[];
  seats: Seat[];
  speaker: Vec2 | null;
  wrestle: [Vec2, Vec2] | null;
  houses: House[];
  npcSpots: Vec2[];
  // geometria para o desenho
  fountain?: { x: number; z: number; r: number };
  mural?: Box;
  theater?: TheaterGeo;
  pool?: { water: Box; rim: number; steps: Box; deck: Box; lanes: number[] };
  gym?: { track: Box; court: Box; discus: Vec2; ring: Vec2 };
}

const act = (a: Omit<Activity, 'expr' | 'bubble'> & Partial<Pick<Activity, 'expr' | 'bubble'>>): Activity => ({ expr: 'neutral', bubble: null, ...a });
const HALF = 7; // lote 2×2: área útil de 14 × 14

// ---------------------------------------------------------------- ágora
function agora(): AreaDef {
  const fountain = { x: 2.2, z: -1.4, r: 1.0 };
  const mural: Box = { x0: -3.8, z0: 0.6, x1: -0.8, z1: 1.2 };
  const benches: Vec2[] = [[-2.4, 4.6], [3.4, 4.4]];
  return {
    kind: 'agora', name: 'Ágora',
    paved: [{ x0: -HALF, z0: -HALF, x1: HALF, z1: HALF }],
    blocks: [mural, ...benches.map(([x, z]) => boxAt(x, z, 0.9, 0.26))],
    circles: [fountain, { x: -5.6, z: -5.6, r: 0.3 }, { x: 5.6, z: -5.6, r: 0.3 }, { x: -5.8, z: 3.0, r: 0.45 }, { x: 5.9, z: 5.8, r: 0.45 }, { x: -5.9, z: 5.9, r: 0.45 }],
    props: [
      { kind: 'fountain', x: fountain.x, z: fountain.z }, { kind: 'mural', x: (mural.x0 + mural.x1) / 2, z: (mural.z0 + mural.z1) / 2 },
      ...benches.map(([x, z]) => ({ kind: 'bench' as const, x, z })),
      { kind: 'brazier', x: -5.6, z: -5.6 }, { kind: 'brazier', x: 5.6, z: -5.6 },
      { kind: 'olive', x: -5.8, z: 3.0, k: 1 }, { kind: 'olive', x: 5.9, z: 5.8, k: 1 }, { kind: 'cypress', x: -5.9, z: 5.9, k: 0.9 },
    ],
    activities: [
      act({ id: 'fonte-o', spot: [fountain.x - fountain.r - 0.35, fountain.z + 0.1], facing: 'front', mirror: false, gestures: ['reach', 'none'], dur: [4000, 7000], label: 'na fonte', expr: 'smile' }),
      act({ id: 'fonte-n', spot: [fountain.x + 0.1, fountain.z - fountain.r - 0.35], facing: 'front', mirror: true, gestures: ['reach', 'none'], dur: [4000, 7000], label: 'na fonte', expr: 'smile' }),
      act({ id: 'mural-1', spot: [mural.x0 + 0.7, mural.z1 + 0.7], facing: 'back', mirror: false, gestures: ['none', 'think'], dur: [5000, 9000], label: 'lendo os avisos' }),
      act({ id: 'mural-2', spot: [mural.x1 - 0.7, mural.z1 + 0.7], facing: 'back', mirror: false, gestures: ['think', 'point'], dur: [5000, 9000], label: 'lendo os avisos' }),
      act({ id: 'banco', spot: benchSeat(benches[1], 1), facing: 'front', mirror: true, gestures: ['none', 'think'], perch: true, dur: [8000, 14000], label: 'sentado na ágora', expr: 'smile' }),
    ],
    chats: [[-1.8, -2.6], [2.4, 2.6], [-4.4, -1.0]],
    seats: [], speaker: null, wrestle: null, houses: [],
    npcSpots: [[-1.2, -4.0], [4.6, -3.8], [0.8, 3.6], [-4.2, -0.6], [4.4, 1.6]],
    fountain, mural,
  };
}

// ---------------------------------------------------------------- teatro
export function theaterRing(T: TheaterGeo, i: number): { inner: number; outer: number; top: number } {
  const inner = T.r0 + i * T.row;
  return { inner, outer: inner + T.row, top: T.rise * (i + 1) };
}
const angleOf = (dx: number, dz: number) => { let a = (Math.atan2(dz, dx) * 180) / Math.PI; if (a < 0) a += 360; return a; };
function teatro(): AreaDef {
  const T: TheaterGeo = { x: 0.6, z: 0.6, r0: 2.7, row: 0.85, rows: 4, rise: 0.32, a0: 120, a1: 330, orchestra: 2.4 };
  const outer = theaterRing(T, T.rows - 1).outer;
  const seats: Seat[] = [];
  for (const i of [0, 1]) for (const a of [150, 180, 210, 240, 270, 300]) {
    const t = (a * Math.PI) / 180; const r = theaterRing(T, i).inner - 0.12;
    const dx = -Math.cos(t); const dz = -Math.sin(t);
    seats.push({ spot: [T.x + r * Math.cos(t), T.z + r * Math.sin(t)], y: i > 0 ? theaterRing(T, i - 1).top : 0, mirror: dz > dx });
  }
  // arquibancada e tudo atrás dela fica fora da circulação (ninguém passa por trás dos degraus)
  const blockTest = (x: number, z: number) => {
    const dx = x - T.x; const dz = z - T.z; const r = Math.hypot(dx, dz); const a = angleOf(dx, dz);
    return r >= T.r0 - 0.1 && a >= T.a0 - 6 && a <= T.a1 + 6 && (r <= outer + 0.2 || a > T.a0 + 10 && a < T.a1 - 10);
  };
  return {
    kind: 'teatro', name: 'Teatro',
    paved: [{ x0: T.x - 1.0, z0: T.z + 1.6, x1: T.x + 1.0, z1: HALF }, { x0: T.x + 1.6, z0: T.z - 1.0, x1: HALF, z1: T.z + 1.0 }],
    blocks: [], circles: [{ x: -6.0, z: -6.0, r: 0.45 }, { x: 5.6, z: 5.6, r: 0.45 }], blockTest,
    props: [{ kind: 'cypress', x: -6.0, z: -6.0, k: 1.1 }, { kind: 'olive', x: 5.6, z: 5.6, k: 0.9 }, { kind: 'brazier', x: T.x + 2.9, z: T.z + 2.9 }],
    activities: [act({ id: 'ensaio', spot: [T.x - 0.4, T.z - 0.4], facing: 'back', mirror: false, gestures: ['talk', 'point', 'talk', 'none'], dur: [6000, 10000], label: 'ensaiando um discurso', bubble: 'talk' })],
    chats: [[T.x + 3.2, T.z + 2.4]], seats, speaker: [T.x - 0.4, T.z - 0.4], wrestle: null, houses: [], npcSpots: [], theater: T,
  };
}

// ---------------------------------------------------------------- termas (2 × 1: 14 × 6)
function termas(): AreaDef {
  const water: Box = { x0: -3.4, z0: -1.1, x1: 2.6, z1: 1.5 }; const rim = 0.3;
  const steps: Box = { x0: -3.4, z0: -0.3, x1: -2.6, z1: 0.7 };
  const lanes = [-0.45, 0.2, 0.85];
  const benches: Vec2[] = [[-1.3, -2.5], [1.3, -2.5], [5.0, 2.3]];
  const swim = (lane: number) => {
    const z = lanes[lane];
    const tour: Vec2[] = [[-3.0, 0.2], [-2.4, z], [2.2, z], [-2.3, z], [2.2, z], [-2.4, z], [-3.0, 0.2], [-4.2, 0.2]];
    return act({ id: `nadar-${lane}`, spot: [-4.2, 0.2], facing: 'front', mirror: false, gestures: ['reach', 'none'], dur: [0, 0], tour, label: 'nadando', expr: 'smile' });
  };
  return {
    kind: 'termas', name: 'Termas',
    paved: [{ x0: -HALF, z0: -3, x1: HALF, z1: 3 }],
    blocks: [{ x0: water.x0 - rim, z0: water.z0 - rim, x1: water.x1 + rim, z1: water.z1 + rim }, ...benches.map(([x, z]) => boxAt(x, z, 0.9, 0.26))],
    circles: [{ x: 6.2, z: -2.3, r: 0.3 }, { x: -6.2, z: -2.3, r: 0.3 }, { x: -5.8, z: -2.4, r: 0.25 }, { x: 6.2, z: 0.4, r: 0.3 }],
    props: [
      ...benches.map(([x, z]) => ({ kind: 'bench' as const, x, z })),
      { kind: 'plant', x: 6.2, z: -2.3 }, { kind: 'plant', x: 6.2, z: 0.4 }, { kind: 'amphora', x: -6.2, z: -2.3, variant: 1 }, { kind: 'amphora', x: -5.8, z: -2.4, variant: 0 },
    ],
    activities: [
      swim(0), swim(1), swim(2),
      ...benches.flatMap((b, i) => ([-1, 1] as const).map((s) => act({ id: `espreguicadeira-${i}${s}`, spot: benchSeat(b, s), facing: 'front', mirror: true, gestures: ['none'], perch: true, dur: [9000, 16000], label: 'descansando', expr: 'smile' }))),
    ],
    chats: [[3.6, 0.9]], seats: [], speaker: null, wrestle: null, houses: [], npcSpots: [],
    pool: { water, rim, steps, deck: { x0: -HALF, z0: -3, x1: HALF, z1: 3 }, lanes },
  };
}

// ---------------------------------------------------------------- ginásio
function ginasio(): AreaDef {
  const track: Box = { x0: -6.9, z0: -6.6, x1: -4.9, z1: 6.6 };
  const court: Box = { x0: -3.4, z0: -3.0, x1: 2.6, z1: 3.4 };
  const bench: Vec2 = [-0.4, -4.0];
  const run: Vec2[] = [[-5.9, 5.8], [-5.9, -5.8], [-5.9, 5.8], [-5.9, -5.8], [-5.9, 4.2]];
  const run2: Vec2[] = [[-5.6, -5.6], [-5.6, 5.6], [-5.6, -5.6], [-5.6, 5.6], [-5.6, -4.0]];
  return {
    kind: 'ginasio', name: 'Ginásio',
    paved: [],
    blocks: [boxAt(bench[0], bench[1], 0.9, 0.26)],
    circles: [{ x: -4.4, z: 6.0, r: 0.3 }, { x: 4.4, z: -6.0, r: 0.45 }, { x: 6.1, z: -5.8, r: 0.45 }, { x: 6.1, z: -2.6, r: 0.45 }, { x: 5.4, z: 5.2, r: 0.45 }],
    props: [
      { kind: 'bench', x: bench[0], z: bench[1] }, { kind: 'herm', x: -4.4, z: 6.0 },
      { kind: 'cypress', x: 4.4, z: -6.0, k: 1 }, { kind: 'cypress', x: 6.1, z: -5.8, k: 1.1 }, { kind: 'cypress', x: 6.1, z: -2.6, k: 0.9 }, { kind: 'olive', x: 5.4, z: 5.2, k: 1 },
    ],
    activities: [
      act({ id: 'correr', spot: [-5.9, 4.2], facing: 'front', mirror: true, gestures: ['none'], dur: [0, 0], tour: run, fast: true, label: 'correndo', expr: 'focused' }),
      act({ id: 'correr-2', spot: [-5.6, -4.0], facing: 'front', mirror: true, gestures: ['none'], dur: [0, 0], tour: run2, fast: true, label: 'correndo', expr: 'focused' }),
      act({ id: 'disco', spot: [-2.2, -1.8], facing: 'front', mirror: false, gestures: ['reach', 'reach', 'point', 'none'], dur: [6000, 10000], label: 'arremessando o disco', expr: 'focused' }),
      act({ id: 'exercicio', spot: [1.6, 2.4], facing: 'front', mirror: true, gestures: ['joy', 'none'], dur: [5000, 8000], label: 'se exercitando', expr: 'focused' }),
      act({ id: 'exercicio-2', spot: [1.8, -1.6], facing: 'front', mirror: false, gestures: ['joy', 'none'], dur: [5000, 8000], label: 'se exercitando', expr: 'focused' }),
      ...([-1, 1] as const).map((s) => act({ id: `arquibancada-${s}`, spot: benchSeat(bench, s), facing: 'front', mirror: true, gestures: ['none', 'talk'], perch: true, dur: [8000, 14000], label: 'assistindo', expr: 'smile' })),
    ],
    chats: [[3.4, 4.4]], seats: [], speaker: null, wrestle: [[-1.0, 0.8], [-0.2, 0.0]], houses: [], npcSpots: [],
    gym: { track, court, discus: [-2.2, -2.0], ring: [-0.6, 0.4] },
  };
}

// ---------------------------------------------------------------- bairro (casas de quem trabalha)
const HOUSE_X: Array<[number, number]> = [[-6.4, -4.0], [-1.2, 1.2], [4.0, 6.4]];
const HOUSE_ROWS = [{ z0: -6.6, z1: -4.4, lane: -3.3 }, { z0: -2.2, z1: 0.0, lane: 1.1 }, { z0: 2.2, z1: 4.4, lane: 5.6 }];
const HEIGHTS = [1.8, 2.1, 1.9, 2.0, 1.7, 2.2, 1.9, 2.0, 1.8];
export const RESIDENTS_PER_HOUSE = 2;
function bairro(): AreaDef {
  const houses: House[] = HOUSE_ROWS.flatMap((row, ri) => HOUSE_X.map(([x0, x1], ci) => {
    const id = ri * 3 + ci; const dx = x0 + (x1 - x0) * 0.65 + 0.14;
    return { id, x0, z0: row.z0, x1, z1: row.z1, h: HEIGHTS[id], door: [dx, row.z1 + 0.35] as Vec2, street: [dx, row.lane] as Vec2 };
  }));
  return {
    kind: 'bairro', name: 'Bairro',
    paved: [...HOUSE_ROWS.map((r) => ({ x0: -HALF, z0: r.lane - 0.6, x1: HALF, z1: r.lane + 0.6 })), { x0: -3.2, z0: -HALF, x1: -2.0, z1: HALF }, { x0: 2.0, z0: -HALF, x1: 3.2, z1: HALF }],
    blocks: houses.map((h) => ({ x0: h.x0, z0: h.z0, x1: h.x1, z1: h.z1 })),
    circles: [],
    props: [
      ...houses.map((h) => ({ kind: 'house' as const, x: h.x0, z: h.z1, w: h.x1 - h.x0, d: h.z1 - h.z0, h: h.h, variant: h.id })),
      ...houses.filter((h) => h.id % 2 === 0).map((h) => ({ kind: 'bush' as const, x: h.x0 + 0.35, z: h.z1 + 0.35 })),
    ],
    activities: [], chats: [[-4.2, 5.6]], seats: [], speaker: null, wrestle: null, houses, npcSpots: [],
  };
}

const MAKERS: Record<AreaKind, () => AreaDef> = { agora, teatro, termas, ginasio, bairro };
const cache = new Map<string, AreaDef>();
export function areaDef(kind: string): AreaDef | null {
  if (!(kind in MAKERS)) return null;
  let d = cache.get(kind);
  if (!d) { d = MAKERS[kind as AreaKind](); cache.set(kind, d); }
  return d;
}
export const isArea = (kind: string): kind is AreaKind => kind in MAKERS;
