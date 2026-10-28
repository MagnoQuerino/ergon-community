/**
 * Prédios como dados: dimensões, embasamento, portas, escada e a planta de cada andar (mesas, assentos,
 * móveis com caixa, meias-paredes, decoração de parede e pontos de atividade). Tudo em coordenadas locais
 * (origem no centro da caixa externa, piso do andar em y = 0). O motor transforma isso em colisão
 * (grades de navegação), ordenação de desenho (caixas 3D) e vida ambiente — um tipo novo de prédio, de um
 * mod ou nosso, só declara estes dados; as regras de sobreposição e colisão já vêm prontas.
 *
 * A Stoa mantém as plantas desenhadas à mão (salão de trabalho e biblioteca, alternando por andar); os
 * outros tipos usam o gerador: fileiras de mesas, escada encostada numa parede, circulação na frente.
 */
import { typeOf } from '../../../shared/city.ts';
import type { Expr, Facing, Gesture } from '../iso/figures.ts';
import { boxAt, type Box, type Vec2 } from './geom.ts';

export const FLOOR_H = 3.2;
export const WALL_T = 0.3;
export const STEP_RISE = FLOOR_H / 10;

export type Bubble = 'talk' | 'think' | 'exclaim' | 'drop' | null;
export interface Activity {
  id: string;
  spot: Vec2;
  facing: Facing; mirror: boolean; // frente sem espelho = olha para +x; com espelho = +z; costas: −z / −x
  gestures: Gesture[];
  expr: Expr;
  bubble: Bubble;
  sit?: boolean;
  perch?: boolean;
  dur: [number, number];
  label?: string;
  tour?: Vec2[];
  fast?: boolean;
  y?: number; // altura dos pés quando não é o chão (degraus do teatro)
}

/** Escada reta: sobe de `hi` (pé, perto da frente/direita) para `lo` (topo), no eixo indicado; atravessa b0..b1. */
export interface StairSpec { axis: 'x' | 'z'; lo: number; hi: number; b0: number; b1: number }

export type ObjKind =
  | 'desk' | 'reading' | 'workbench' | 'counter' | 'lectern' | 'stool' | 'klismos' | 'meet-table' | 'round-table' | 'long-table'
  | 'bench' | 'plant' | 'amphora' | 'basket' | 'shelf' | 'back-shelves' | 'jars' | 'loom' | 'anvil' | 'herbs' | 'chest';
/** Móvel ou objeto do piso: caixa no chão, altura, se bloqueia a passagem e se é clicável. */
export interface PlanObj { kind: ObjKind; x: number; z: number; hx: number; hz: number; h: number; blocks: boolean; variant?: number; hit?: 'board' | 'shelf' | 'conselho' }
/** Meia parede (divisória baixa). */
export interface Wall { x0: number; z0: number; x1: number; z1: number }
/** Decoração pintada nas paredes do fundo (z = iz0) ou da esquerda (x = ix0). */
export interface WallDecor { kind: 'banner' | 'bust' | 'board' | 'lamp' | 'window' | 'map' | 'tablet' | 'sign' | 'shelf-rack' | 'herbs'; wall: 'back' | 'left'; u: number; w?: number; hit?: 'board' | 'shelf' }

export interface Desk { x: number; z: number; seat: Vec2; idle: Vec2; kind: 'desk' | 'reading' | 'workbench' | 'counter' | 'lectern' }

export interface FloorPlan {
  id: string; name: string;
  floor: 'checker' | 'planks' | 'terracotta' | 'mosaic';
  carpets: Box[];
  desks: Desk[];
  objects: PlanObj[];
  walls: Wall[];
  decor: WallDecor[];
  activities: Activity[];
  fetch: Activity | null; // de onde se pega um rolo para entregar a um colega
  chats: Vec2[]; // pontos de conversa: A; B = A + (0,8; −0,8)
  meeting: Array<{ spot: Vec2; facing: Facing; mirror: boolean }>; // três lugares em volta da mesa
}

export interface BuildingSpec {
  kind: string; style: string;
  W: number; D: number; // caixa externa (paredes incluídas), centrada na origem
  base: number; // altura do embasamento = piso do térreo
  plinth: number; // quanto o embasamento passa das paredes
  steps: { x0: number; x1: number; depth: number } | null; // degraus da frente (+z)
  sideSteps: { z0: number; z1: number; depth: number } | null; // degraus da direita (+x)
  door: { x: number; w: number };
  sideDoor: { z: number; w: number } | null;
  stair: StairSpec | null;
  porch: number; // pórtico ou arcada à frente da parede (colunas), 0 = sem
}

export const interior = (s: BuildingSpec): Box => ({ x0: -s.W / 2 + WALL_T, z0: -s.D / 2 + WALL_T, x1: s.W / 2 - WALL_T, z1: s.D / 2 - WALL_T });
/** Caixa ocupada no chão (paredes, embasamento e pórtico), sem os degraus. */
export const footprintBox = (s: BuildingSpec): Box => ({ x0: -s.W / 2 - s.plinth, z0: -s.D / 2 - s.plinth, x1: s.W / 2 + s.plinth, z1: s.D / 2 + Math.max(s.plinth, s.porch) });

// ---------------------------------------------------------------- especificações por tipo
const SPECS: Record<string, BuildingSpec> = {
  stoa: {
    kind: 'stoa', style: 'stoa', W: 16, D: 10, base: 0.6, plinth: 0.9, porch: 0.9,
    steps: { x0: -2.2, x1: 2.2, depth: 0.9 }, sideSteps: { z0: 3.3, z1: 4.5, depth: 0.8 },
    door: { x: 0, w: 1.6 }, sideDoor: { z: 3.9, w: 1.2 },
    stair: { axis: 'z', lo: -3.4, hi: 2.6, b0: 5.2, b1: 7.0 },
  },
  // pequenas (1 lote): escada encostada na parede do fundo, subindo para a esquerda; patamar à esquerda
  oikos: { kind: 'oikos', style: 'oikos', W: 5.4, D: 4.8, base: 0.15, plinth: 0.1, porch: 0, steps: null, sideSteps: null, door: { x: -1.3, w: 0.9 }, sideDoor: null, stair: { axis: 'x', lo: -1.6, hi: 1.6, b0: -2.1, b1: -1.25 } },
  ergasterion: { kind: 'ergasterion', style: 'ergasterion', W: 5.6, D: 4.8, base: 0.15, plinth: 0.1, porch: 0, steps: null, sideSteps: null, door: { x: -1.4, w: 1.1 }, sideDoor: null, stair: { axis: 'x', lo: -1.7, hi: 1.5, b0: -2.1, b1: -1.25 } },
  pharmakopoleion: { kind: 'pharmakopoleion', style: 'pharmakopoleion', W: 5.4, D: 4.9, base: 0.2, plinth: 0.12, porch: 0, steps: { x0: -1.9, x1: -0.7, depth: 0.35 }, sideSteps: null, door: { x: -1.3, w: 0.9 }, sideDoor: null, stair: { axis: 'x', lo: -1.6, hi: 1.6, b0: -2.15, b1: -1.3 } },
  // médias (2 lotes): mesma escada do fundo, à direita; uma fileira de quatro mesas
  didaskaleion: { kind: 'didaskaleion', style: 'didaskaleion', W: 11.2, D: 4.4, base: 0.35, plinth: 0.25, porch: 0.7, steps: { x0: -2.0, x1: 2.0, depth: 0.45 }, sideSteps: null, door: { x: -0.6, w: 1.4 }, sideDoor: null, stair: { axis: 'x', lo: 1.2, hi: 4.4, b0: -1.9, b1: -1.05 } },
  oikia: { kind: 'oikia', style: 'oikia', W: 12, D: 5.0, base: 0.2, plinth: 0.15, porch: 0, steps: { x0: -1.8, x1: 0.6, depth: 0.4 }, sideSteps: null, door: { x: -0.6, w: 1.4 }, sideDoor: null, stair: { axis: 'x', lo: 1.6, hi: 4.8, b0: -2.2, b1: -1.35 } },
  // grandes (4 lotes): escada longa na parede da direita, como a Stoa; duas fileiras de mesas
  emporion: { kind: 'emporion', style: 'emporion', W: 12, D: 9.4, base: 0.3, plinth: 0.2, porch: 1.3, steps: { x0: -1.8, x1: 1.8, depth: 0.4 }, sideSteps: null, door: { x: 0, w: 1.8 }, sideDoor: null, stair: { axis: 'z', lo: -3.3, hi: 2.7, b0: 4.3, b1: 5.6 } },
  bouleuterion: { kind: 'bouleuterion', style: 'bouleuterion', W: 11.4, D: 9.0, base: 0.55, plinth: 0.9, porch: 0.9, steps: { x0: -2.6, x1: 2.6, depth: 0.7 }, sideSteps: null, door: { x: 0, w: 1.8 }, sideDoor: null, stair: { axis: 'z', lo: -3.1, hi: 2.4, b0: 4.15, b1: 5.35 } },
};

/** Especificação de um tipo de prédio; tipos de mod sem especificação usam uma casa média genérica. */
export function specOf(kind: string): BuildingSpec {
  const s = SPECS[kind];
  if (s) return s;
  const t = typeOf(kind);
  const [w, d] = t?.footprint ?? [1, 1];
  const W = Math.min(w * 8 - 3, 12); const D = Math.min(d * 8 - 3, 9);
  return { kind, style: t?.style ?? 'generic', W, D, base: 0.2, plinth: 0.15, porch: 0, steps: null, sideSteps: null, door: { x: 0, w: 1.2 }, sideDoor: null, stair: { axis: 'z', lo: -D / 2 + 1.3, hi: -D / 2 + 1.3 + 3.2, b0: W / 2 - 1.4, b1: W / 2 - 0.35 } };
}

/** Caixa da escada no chão (para colisão e para o vão do andar de cima). */
export function stairBox(st: StairSpec): Box {
  return st.axis === 'z' ? { x0: st.b0, z0: st.lo, x1: st.b1, z1: st.hi } : { x0: st.lo, z0: st.b0, x1: st.hi, z1: st.b1 };
}
/** Pé da escada (onde se chega para subir) e chegada no andar de cima. */
export function stairEnds(st: StairSpec): { bottom: Vec2; top: Vec2 } {
  const m = (st.b0 + st.b1) / 2;
  return st.axis === 'z' ? { bottom: [m, st.hi + 0.5], top: [m, st.lo - 0.55] } : { bottom: [st.hi + 0.5, m], top: [st.lo - 0.55, m] };
}
/** Pontos de quem sobe: centro de cada degrau, com a altura do degrau. */
export function stairPath(st: StairSpec): Array<{ p: Vec2; h: number }> {
  const n = 10; const run = (st.hi - st.lo) / n; const m = (st.b0 + st.b1) / 2;
  const out: Array<{ p: Vec2; h: number }> = [];
  for (let k = 0; k < n; k++) { const a = st.hi - (k + 0.5) * run; out.push({ p: st.axis === 'z' ? [m, a] : [a, m], h: (k + 1) * STEP_RISE }); }
  return out;
}

// ---------------------------------------------------------------- planta da Stoa (feita à mão)
export const STOA_DESKS: Vec2[] = [[-5.8, -2.6], [-2.6, -2.6], [0.6, -2.6], [-5.8, 0.8], [-2.6, 0.8], [0.6, 0.8]];
export const MEET_TABLE = { x: 3.75, z: 0.9, hx: 0.62, hz: 0.72 };
const ROOM_WALLS: Wall[] = [
  { x0: 2.3, z0: -4.7, x1: 2.5, z1: -1.3 }, // sala da direita: parede oeste (porta entre z −1,3 e −0,1)
  { x0: 2.3, z0: -0.1, x1: 2.5, z1: 2.5 },
  { x0: 2.5, z0: 2.3, x1: 4.0, z1: 2.5 }, // parede sul (passagem entre x 4,0 e a escada)
];
const seatFor = ([x, z]: Vec2): Vec2 => [x, z - 0.6];
const idleFor = ([x, z]: Vec2): Vec2 => [x + 1.15, z + 0.3];
/** Sentar num banco: pés à frente do assento, olhando para +z (o ponto fica à frente: quem senta é desenhado depois do banco). */
export const benchSeat = ([x, z]: Vec2, side: -1 | 1): Vec2 => [x + side * 0.3, z + 0.45];

const act = (a: Omit<Activity, 'expr' | 'bubble'> & Partial<Pick<Activity, 'expr' | 'bubble'>>): Activity => ({ expr: 'neutral', bubble: null, ...a });

const STOA_BENCHES: Vec2[] = [[-4.4, 4.0], [3.6, 4.0]];
const MEETING_AT = (t: { x: number; z: number; hx: number; hz: number }) => [
  { spot: [t.x - t.hx - 0.25, t.z + 0.1] as Vec2, facing: 'front' as Facing, mirror: false },
  { spot: [t.x - 0.25, t.z - t.hz - 0.25] as Vec2, facing: 'front' as Facing, mirror: true },
  { spot: [t.x + 1.0, t.z - 1.0] as Vec2, facing: 'front' as Facing, mirror: true },
];

function stoaPlan(level: number): FloorPlan {
  const lib = level % 2 === 1;
  const ZB = -4.7; const XL = -7.7;
  const desks: Desk[] = STOA_DESKS.map((d) => ({ x: d[0], z: d[1], seat: seatFor(d), idle: idleFor(d), kind: lib ? 'reading' : 'desk' }));
  const objects: PlanObj[] = [];
  desks.forEach((d, i) => {
    objects.push({ kind: d.kind, x: d.x, z: d.z, hx: 0.72, hz: 0.42, h: 0.75, blocks: true, variant: i + level });
    objects.push({ kind: lib ? 'klismos' : 'stool', x: d.seat[0], z: d.seat[1] - (lib ? 0.12 : 0), hx: 0.24, hz: 0.22, h: lib ? 0.86 : 0.43, blocks: false });
  });
  const T = MEET_TABLE;
  if (lib) objects.push({ kind: 'round-table', x: T.x, z: T.z, hx: 0.74, hz: 0.74, h: 0.75, blocks: true, hit: 'conselho' });
  else objects.push({ kind: 'meet-table', x: T.x, z: T.z, hx: T.hx, hz: T.hz, h: 0.78, blocks: true });
  const decor: WallDecor[] = [];
  if (!lib) {
    for (const [x, z] of STOA_BENCHES) objects.push({ kind: 'bench', x, z, hx: 0.9, hz: 0.26, h: 0.46, blocks: true });
    objects.push({ kind: 'shelf', x: (XL - 7.1) / 2, z: 2.9, hx: (-7.1 - XL) / 2, hz: 1.0, h: 2.2, blocks: true, hit: 'shelf' });
    objects.push({ kind: 'plant', x: -7.15, z: -4.2, hx: 0.26, hz: 0.26, h: 1.4, blocks: true });
    objects.push({ kind: 'plant', x: 1.95, z: -4.25, hx: 0.26, hz: 0.26, h: 1.4, blocks: true });
    objects.push({ kind: 'plant', x: -7.15, z: 4.3, hx: 0.26, hz: 0.26, h: 1.4, blocks: true });
    objects.push({ kind: 'amphora', x: -7.32, z: 0.05, hx: 0.2, hz: 0.2, h: 0.95, blocks: true, variant: 1 });
    objects.push({ kind: 'amphora', x: -7.36, z: -0.55, hx: 0.16, hz: 0.16, h: 0.7, blocks: true, variant: 0 });
    objects.push({ kind: 'basket', x: -7.25, z: 1.45, hx: 0.22, hz: 0.22, h: 0.62, blocks: true });
    decor.push({ kind: 'banner', wall: 'back', u: -6.6 }, { kind: 'banner', wall: 'back', u: -1.0 }, { kind: 'banner', wall: 'left', u: -2.4 },
      { kind: 'bust', wall: 'back', u: -3.9 }, { kind: 'lamp', wall: 'back', u: -5.4 }, { kind: 'lamp', wall: 'back', u: -2.4 }, { kind: 'lamp', wall: 'left', u: -0.6 },
      { kind: 'board', wall: 'back', u: 3.85, w: 2.2, hit: 'board' });
  } else {
    objects.push({ kind: 'back-shelves', x: (-7.6 - 1.0) / 2, z: ZB + 0.21, hx: 3.3, hz: 0.21, h: 2.35, blocks: true, hit: 'shelf' });
    objects.push({ kind: 'basket', x: -7.25, z: 3.2, hx: 0.22, hz: 0.22, h: 0.62, blocks: true });
    objects.push({ kind: 'basket', x: -7.3, z: 2.5, hx: 0.22, hz: 0.22, h: 0.62, blocks: true });
    objects.push({ kind: 'plant', x: 1.95, z: -4.25, hx: 0.26, hz: 0.26, h: 1.4, blocks: true });
    objects.push({ kind: 'plant', x: -7.15, z: 4.3, hx: 0.26, hz: 0.26, h: 1.4, blocks: true });
    decor.push({ kind: 'map', wall: 'back', u: 3.85, w: 2.2 }, { kind: 'window', wall: 'left', u: -2.6, w: 1.2 }, { kind: 'window', wall: 'left', u: 0.6, w: 1.2 },
      { kind: 'lamp', wall: 'back', u: 0.4 }, { kind: 'lamp', wall: 'left', u: 2.6 });
  }
  const activities: Activity[] = lib ? [
    act({ id: 'estante-1', spot: [-5.6, -3.9], facing: 'back', mirror: false, gestures: ['reach', 'none'], dur: [5000, 9000] }),
    act({ id: 'estante-2', spot: [-2.4, -3.9], facing: 'back', mirror: false, gestures: ['reach', 'think'], dur: [5000, 9000] }),
    act({ id: 'janela', spot: [-6.9, -1.0], facing: 'back', mirror: true, gestures: ['think', 'none'], bubble: 'think', dur: [6000, 10000] }),
    act({ id: 'mapa-parede', spot: [3.85, -3.65], facing: 'back', mirror: false, gestures: ['point', 'think'], dur: [5000, 9000] }),
    act({ id: 'conselho-oeste', spot: [T.x - T.hx - 0.25, T.z], facing: 'front', mirror: false, gestures: ['think', 'none'], bubble: 'think', dur: [6000, 11000] }),
    act({ id: 'conselho-norte', spot: [T.x, T.z - T.hz - 0.25], facing: 'front', mirror: true, gestures: ['none', 'think'], dur: [6000, 11000] }),
    act({ id: 'varanda-1', spot: [-4.4, 4.0], facing: 'front', mirror: true, gestures: ['think', 'none'], expr: 'smile', dur: [6000, 10000] }),
    act({ id: 'varanda-2', spot: [0.2, 4.0], facing: 'front', mirror: true, gestures: ['none', 'think'], bubble: 'think', dur: [6000, 10000] }),
    act({ id: 'divagar', spot: [4.0, -1.8], facing: 'front', mirror: true, gestures: ['think', 'none'], bubble: 'think', dur: [5000, 9000] }),
  ] : [
    act({ id: 'arquivo', spot: [-6.75, 2.9], facing: 'back', mirror: true, gestures: ['reach', 'none'], dur: [6000, 10000] }),
    act({ id: 'quadro', spot: [3.85, -3.65], facing: 'back', mirror: false, gestures: ['point', 'none'], dur: [5000, 9000] }),
    act({ id: 'mapa-oeste', spot: [T.x - T.hx - 0.25, T.z], facing: 'front', mirror: false, gestures: ['think', 'none'], bubble: 'think', dur: [6000, 11000] }),
    act({ id: 'mapa-norte', spot: [T.x, T.z - T.hz - 0.25], facing: 'front', mirror: true, gestures: ['point', 'none', 'think'], dur: [6000, 11000] }),
    act({ id: 'banco-1', spot: benchSeat(STOA_BENCHES[0], -1), facing: 'front', mirror: true, gestures: ['none'], expr: 'smile', perch: true, dur: [8000, 15000] }),
    act({ id: 'banco-2', spot: benchSeat(STOA_BENCHES[1], 1), facing: 'front', mirror: true, gestures: ['none', 'think'], perch: true, dur: [8000, 15000] }),
    act({ id: 'planta', spot: [-6.5, -3.6], facing: 'back', mirror: true, gestures: ['reach', 'none'], expr: 'smile', dur: [4000, 7000] }),
    act({ id: 'anfora', spot: [-6.6, -0.2], facing: 'back', mirror: true, gestures: ['reach', 'none'], dur: [3500, 6000] }),
    act({ id: 'colunata', spot: [5.3, 4.05], facing: 'front', mirror: false, gestures: ['think', 'none'], bubble: 'think', dur: [6000, 10000] }),
    act({ id: 'divagar', spot: [4.0, -1.8], facing: 'front', mirror: true, gestures: ['think', 'none'], bubble: 'think', dur: [5000, 9000] }),
  ];
  return {
    id: lib ? 'biblioteca' : 'salao', name: lib ? 'Biblioteca e conselho' : 'Salão de trabalho',
    floor: lib ? 'planks' : 'checker',
    carpets: [{ x0: -7.45, z0: -3.75, x1: 1.95, z1: 2.05 }, { x0: 2.7, z0: -0.9, x1: 4.95, z1: 2.1 }],
    desks, objects, walls: lib ? ROOM_WALLS : [{ x0: -6.3, z0: 2.3, x1: 1.3, z1: 2.5 }, ...ROOM_WALLS], decor, activities,
    fetch: activities[0],
    chats: [[-1.4, 3.9], [3.2, -1.7], [-4.7, -0.4]],
    meeting: MEETING_AT(T),
  };
}

// ---------------------------------------------------------------- gerador para os outros tipos
interface StyleFurniture { desk: Desk['kind']; deskUpper?: Desk['kind']; floor: FloorPlan['floor']; side: ObjKind | null; table: ObjKind | null; decor: WallDecor['kind'][] }
const FURNITURE: Record<string, StyleFurniture> = {
  oikos: { desk: 'desk', floor: 'terracotta', side: 'chest', table: null, decor: ['window', 'lamp', 'tablet'] },
  ergasterion: { desk: 'workbench', floor: 'planks', side: 'anvil', table: null, decor: ['shelf-rack', 'lamp', 'window'] },
  pharmakopoleion: { desk: 'counter', floor: 'checker', side: 'jars', table: null, decor: ['herbs', 'shelf-rack', 'sign'] },
  didaskaleion: { desk: 'lectern', floor: 'planks', side: 'basket', table: null, decor: ['tablet', 'map', 'window', 'lamp'] },
  oikia: { desk: 'desk', floor: 'mosaic', side: 'amphora', table: 'meet-table', decor: ['banner', 'window', 'lamp', 'bust'] },
  emporion: { desk: 'counter', deskUpper: 'desk', floor: 'terracotta', side: 'amphora', table: 'meet-table', decor: ['sign', 'shelf-rack', 'lamp', 'window'] },
  bouleuterion: { desk: 'reading', floor: 'checker', side: 'plant', table: 'long-table', decor: ['banner', 'bust', 'lamp', 'map'] },
};

function genericPlan(spec: BuildingSpec, level: number, slots: number): FloorPlan {
  const F = FURNITURE[spec.style] ?? FURNITURE.oikos;
  const I = interior(spec);
  const st = spec.stair ? stairBox(spec.stair) : null;
  const deskKind = level > 0 && F.deskUpper ? F.deskUpper : F.desk;
  // região das mesas: à esquerda da escada lateral (eixo z) ou à frente da escada do fundo (eixo x)
  const xmin = I.x0 + 0.9; const xmax = (st && spec.stair!.axis === 'z' ? st.x0 - 0.35 : I.x1 - 0.25) - 1.15 - 0.2;
  const backZ = st && spec.stair!.axis === 'x' ? st.z1 + 0.25 + 0.6 : I.z0 + 0.95 + 0.6; // assento a ≥0,25 da escada ou da parede
  const frontLimit = I.z1 - 1.5; // circulação junto à parede da frente (porta)
  const rows: number[] = [];
  for (let z = backZ; z + 0.42 <= frontLimit + 1e-6; z += 3.1) rows.push(z);
  const span = Math.max(0, xmax - xmin);
  const perRow = Math.max(1, Math.floor(span / 2.3) + 1);
  const gap = perRow > 1 ? span / (perRow - 1) : 0;
  const desks: Desk[] = [];
  for (const z of rows) for (let c = 0; c < perRow && desks.length < slots; c++) {
    const x = perRow > 1 ? xmin + c * gap : (xmin + xmax) / 2;
    desks.push({ x, z, seat: seatFor([x, z]), idle: idleFor([x, z]), kind: deskKind });
  }
  const objects: PlanObj[] = [];
  desks.forEach((d, i) => {
    objects.push({ kind: d.kind, x: d.x, z: d.z, hx: 0.72, hz: 0.42, h: 0.75, blocks: true, variant: i + level });
    objects.push({ kind: d.kind === 'reading' || d.kind === 'lectern' ? 'klismos' : 'stool', x: d.seat[0], z: d.seat[1] - 0.05, hx: 0.24, hz: 0.22, h: 0.5, blocks: false });
  });
  // canto da frente à esquerda: objeto de ofício; canto do fundo à esquerda (se livre): vaso
  const sideObj: PlanObj | null = F.side ? { kind: F.side, x: I.x0 + 0.32, z: I.z1 - 0.45, hx: 0.24, hz: 0.24, h: F.side === 'plant' ? 1.4 : 0.9, blocks: true } : null;
  if (sideObj) objects.push(sideObj);
  const backFree = !(st && st.x0 < I.x0 + 0.9 && st.z0 < I.z0 + 0.9);
  if (backFree) objects.push({ kind: 'plant', x: I.x0 + 0.3, z: I.z0 + 0.3, hx: 0.24, hz: 0.24, h: 1.4, blocks: true });
  // mesa de reunião nas posições livres da última fileira (duas ou mais), se o estilo tem uma
  let meeting: FloorPlan['meeting'] = [];
  const lastRow = rows.length ? Math.floor((Math.max(1, desks.length) - 1) / perRow) : -1;
  const freeInLast = lastRow >= 0 ? perRow - (desks.length - lastRow * perRow) : 0;
  if (F.table && lastRow >= 0 && freeInLast >= 2 && perRow > 1) {
    const c0 = perRow - freeInLast;
    const t = { x: xmin + (c0 + (freeInLast - 1) / 2) * gap, z: rows[lastRow], hx: F.table === 'long-table' ? 1.0 : 0.62, hz: 0.6 };
    objects.push({ kind: F.table, x: t.x, z: t.z, hx: t.hx, hz: t.hz, h: 0.78, blocks: true, hit: F.table === 'long-table' ? 'conselho' : undefined });
    meeting = MEETING_AT(t);
  }
  // decoração das paredes: distribuída na parede do fundo (se a escada não está nela) e na da esquerda
  const decor: WallDecor[] = [];
  const backSpan: [number, number] = [I.x0 + 0.8, (st && spec.stair!.axis === 'x' ? st.x0 : st ? st.x0 : I.x1) - 0.6];
  const leftSpan: [number, number] = [I.z0 + 0.8, I.z1 - 0.9];
  F.decor.forEach((k, i) => {
    const onBack = !(st && spec.stair!.axis === 'x') && i % 2 === 0;
    const [a, b] = onBack ? backSpan : leftSpan;
    const n = Math.ceil(F.decor.length / (onBack ? 2 : 1)) + 1;
    const u = a + ((b - a) * (Math.floor(i / (onBack ? 2 : 1)) + 1)) / n;
    if (b - a > 0.8) decor.push({ kind: k, wall: onBack ? 'back' : 'left', u, w: k === 'window' || k === 'map' ? 1.1 : undefined });
  });
  // atividades: objeto de ofício, parede da esquerda, divagar na circulação, mesa — só em pontos livres
  const blocks = objects.filter((o) => o.blocks).map((o) => boxAt(o.x, o.z, o.hx + 0.2, o.hz + 0.2));
  if (st) blocks.push({ x0: st.x0 - 0.2, z0: st.z0 - 0.2, x1: st.x1 + 0.2, z1: st.z1 + 0.2 });
  const okSpot = ([x, z]: Vec2) => x > I.x0 + 0.25 && x < I.x1 - 0.25 && z > I.z0 + 0.25 && z < I.z1 - 0.25 && !blocks.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
  const firstOk = (cands: Vec2[]) => cands.find(okSpot) ?? null;
  const activities: Activity[] = [];
  const push = (a: Activity | null) => { if (a && okSpot(a.spot)) activities.push(a); };
  if (sideObj) push(act({ id: 'oficio', spot: [sideObj.x + 0.62, sideObj.z - 0.15], facing: 'back', mirror: true, gestures: ['reach', 'none'], dur: [4000, 8000] }));
  const wallSpot = firstOk([0.9, 0.3, -0.3, -0.9, 1.5].map((f) => [I.x0 + 0.6, (I.z0 + I.z1) / 2 + f] as Vec2));
  if (wallSpot) push(act({ id: 'parede', spot: wallSpot, facing: 'back', mirror: true, gestures: ['think', 'none'], bubble: 'think', dur: [5000, 9000] }));
  const wander = firstOk([0.6, 1.4, -0.6, 2.2].map((f) => [(I.x0 + I.x1) / 2 + f, I.z1 - 0.55] as Vec2));
  if (wander) push(act({ id: 'divagar', spot: wander, facing: 'front', mirror: true, gestures: ['think', 'none'], bubble: 'think', dur: [5000, 9000] }));
  if (meeting.length) push(act({ id: 'mesa', spot: meeting[0].spot, facing: 'front', mirror: false, gestures: ['think', 'point', 'none'], dur: [5000, 9000] }));
  // conversas na circulação da frente, longe da porta
  const chats: Vec2[] = [];
  const cz = I.z1 - 0.5;
  for (let x = I.x0 + 0.9; x < I.x1 - 1.1 && chats.length < 2; x += 0.4) {
    if (Math.abs(x - spec.door.x) < 1.1 || Math.abs(x + 0.4 - spec.door.x) < 1.1) continue;
    if (chats.some(([cx]) => Math.abs(cx - x) < 2.4)) continue;
    if (okSpot([x, cz]) && okSpot([x + 0.8, cz - 0.8])) chats.push([x, cz]);
  }
  const lname = level === 0 ? 'Térreo' : `${level}º andar`;
  return {
    id: `${spec.style}-${level}`, name: lname, floor: F.floor,
    carpets: rows.length ? [{ x0: xmin - 0.9, z0: rows[0] - 1.05, x1: Math.min(I.x1 - 0.2, xmax + 1.6), z1: rows[rows.length - 1] + 0.75 }] : [],
    desks, objects, walls: [], decor, activities, fetch: activities[0] ?? null, chats, meeting,
  };
}

const planCache = new Map<string, FloorPlan>();
/** Planta do andar `level` de um prédio do tipo `kind` com `slots` vagas. */
export function planFor(kind: string, level: number, slots: number): FloorPlan {
  const key = `${kind}|${level}|${slots}`;
  let p = planCache.get(key);
  if (!p) { p = kind === 'stoa' ? stoaPlan(level) : genericPlan(specOf(kind), level, slots); planCache.set(key, p); }
  return p;
}

/** Ponto de trabalho de uma vaga: a cadeira atrás da mesa; vagas sem mesa ficam em pé na circulação. */
export function seatOf(plan: FloorPlan, spec: BuildingSpec, slot: number): Vec2 {
  if (slot < plan.desks.length) return plan.desks[slot].seat;
  const I = interior(spec); const extra = slot - plan.desks.length;
  return [I.x0 + 0.8 + (extra % 6) * 1.1, I.z1 - 0.8];
}
export function idleSpotOf(plan: FloorPlan, spec: BuildingSpec, slot: number): Vec2 {
  if (slot < plan.desks.length) return plan.desks[slot].idle;
  const [x, z] = seatOf(plan, spec, slot); return [x + 0.5, z - 0.3];
}
/** Visitante em pé junto à ponta esquerda da mesa do colega; quem entrega um rolo para ao lado do ocioso. */
export function visitSpot(plan: FloorPlan, spec: BuildingSpec, slot: number): Vec2 { const [x, z] = seatOf(plan, spec, slot); return [x - 1.05, z + 0.5]; }
export function handoffSpot(plan: FloorPlan, spec: BuildingSpec, slot: number): Vec2 { const [x, z] = idleSpotOf(plan, spec, slot); return [x - 0.8, z + 0.8]; }

/** Caixas que bloqueiam a passagem num andar (locais): móveis, meias-paredes, escada e o vão da escada de baixo. */
export function floorBlocks(spec: BuildingSpec, plan: FloorPlan, level: number, floors: number): Box[] {
  const out: Box[] = [];
  for (const o of plan.objects) if (o.blocks) out.push(boxAt(o.x, o.z, o.hx, o.hz));
  for (const w of plan.walls) out.push(w);
  if (spec.stair && (level < floors - 1 || level > 0)) out.push(stairBox(spec.stair));
  return out;
}
