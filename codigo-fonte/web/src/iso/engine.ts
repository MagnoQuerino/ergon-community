/**
 * Motor do palco isométrico (Canvas 2D). Compõe a cidade montada em world/ (prédios, áreas, ruas, lotes):
 *  - câmera suave: aproximar/afastar animado (até ver a cidade inteira), arrastar, centralizar quem foi
 *    escolhido levando em conta o painel de conversa; fly-to para uma estrutura;
 *  - prédios fechados por padrão; passar o mouse destaca o andar (holograma), clicar abre o prédio naquele
 *    andar (varredura que dissolve os andares de cima e corta a frente na mesma altura), clicar fora fecha;
 *  - quem está dentro de um prédio fechado não aparece nem é clicável; ninguém é clicado através de parede:
 *    o clique testa os pixels de tudo o que foi desenhado, do mais à frente para o mais ao fundo;
 *  - ordem de desenho por caixas 3D (sort.ts) para prédios, móveis, degraus, árvores e personagens;
 *  - editor do mapa (arrastar estruturas entre lotes), lotes livres clicáveis (loja), montagem holográfica
 *    de estruturas novas ou movidas;
 *  - vida ambiente cosmética e reações a desfechos reais; nomes discretos sob os pés.
 * Desenha sob demanda: parado, nenhum quadro; em movimento, 60 quadros/s (30 se o navegador não acompanhar).
 */
import { CELL, placeError, typeOf } from '../../../shared/city.ts';
import { FLOOR_H, handoffSpot, idleSpotOf, seatOf, stairBox, tarpBox, tarpPlace, visitSpot, type Activity } from '../world/buildings.ts';
import { RESIDENTS_PER_HOUSE, type House } from '../world/areas.ts';
import { Town, type AreaInst, type BuildingInst, type Loc, type StructureIn } from '../world/town.ts';
import type { AABB, P3, Vec2 } from '../world/geom.ts';
import { startMove, stepMove, targetFor, visualFor, type Mover, type Visual } from '../scene/agentState.ts';
import type { SceneAgent, SceneFocus, SceneObject, SceneOps, SceneOpsTarget } from '../scene/types.ts';
import { KY, RES, insidePoly, project, unproject, type P2 } from './projection.ts';
import { regionSize, regionsOf, type Occ } from '../world/regions.ts';
import { figureSprite, hashOf, lookFor, npcLook, type Expr, type Facing, type Gesture, type Look, type Pose, type Sprite } from './figures.ts';
import { bandHighlight, buildingBox, closedArt, closedRect, closedSmall, hasClosed, hasSmall, openArt, reserveClosed, reserveSmall, type ArtItem, type Layer, type OpenArt } from './buildingArt.ts';
import { Lru } from './lru.ts';
import { CHUNK, areaHits, boxPoly, cityItems, drawGroundChunk, type AreaHit, type CityItem } from './areaArt.ts';
import { agentSkinLook, lookFromSkin, skinPack, skinPet, skinTheme, type ActiveSkin } from './skin.ts';
import type { SkinData } from '../../../shared/skin.ts';
import { sortItems, type Sortable } from './sort.ts';
import { THEMES, mix, type Theme, type ThemeId } from './theme.ts';
import { paintFx, paintPet } from './cosmetics.ts';
import { blob } from './props.ts';
import { between, isNightHour, msUntilMorning, pairAt, pickActivity, pickChoice, rng, type Bubble, type LifeChoice } from './life.ts';
import { fillPoly } from './raster.ts';

export interface EngineCallbacks {
  onSelectAgent(id: string): void;
  onObject(kind: SceneObject, text?: string): void;
  onLot(i: number, j: number): void;
  onStructure(id: string | null): void;
  onFocus(f: SceneFocus | null): void;
  onMove(id: string, i: number, j: number): void;
  onLost(): void;
}

type GroupKind = 'chat' | 'debate' | 'visit' | 'handoff' | 'meeting' | 'assembly' | 'wrestle';
interface Plan {
  kind: 'solo' | 'desk' | 'fetch' | 'group' | 'home';
  loc: Loc; spot: Vec2; y: number | null;
  facing: Facing; mirror: boolean; sit: boolean; perch: boolean;
  gestures: Gesture[]; expr: Expr; bubble: Bubble;
  carry: boolean; group: string | null; dur: [number, number]; key: string | null;
  label: string | null; area: string | null; tour: Vec2[] | null; fast: boolean; hide: boolean;
}
interface Life { mode: 'home' | 'going' | 'doing' | 'waiting' | 'returning'; until: number; plan: Plan | null; next: Plan | null; since: number; toured: boolean }
interface Group { id: string; kind: GroupKind; members: string[]; created: number; started: number; until: number; timeout: number }
interface Reaction { gesture: Gesture; expr: Expr; until: number; jump: boolean }
interface Rt {
  a: SceneAgent; look: Look; pos: P3; loc: Loc; mover: Mover | null; seated: boolean; visual: Visual; spotKey: string;
  facing: Facing; mirror: boolean; idleMirror: boolean; walked: number;
  life: Life; react: Reaction | null; afterReact: boolean; outcome: string | null; house: number;
}
interface Npc { pos: P3; mover: Mover | null; until: number; facing: Facing; mirror: boolean; walked: number; think: boolean; spot: number }
interface Anim { kind: 'open' | 'close' | 'switch' | 'build'; t0: number; dur: number; from: number | null; to: number | null }

type Drawn =
  | { kind: 'agent'; id: string; x: number; y: number; s: Sprite }
  | { kind: 'prop'; x: number; y: number; s: Sprite; hit?: ArtItem['hit']; area?: string; building?: string }
  | { kind: 'band'; building: string; level: number; faces: P2[][]; exclude?: P2[] }
  | { kind: 'floor'; building: string; poly: P2[] }
  | { kind: 'objpoly'; building: string; obj: 'board' | 'shelf' | 'conselho'; poly: P2[] }
  | { kind: 'area'; hit: AreaHit };

const NPC_ID = '__npc';
/** Posto da nuvem coberto: mesa sob uma lona branca amarrada (pixels-base; o = contorno, w/s/f = lona, l = pés). */
const TARP_ROWS = [
  '..........oooooo..........',
  '.......ooowwwwwwooo.......',
  '....ooowwwwwwwwwwwwooo....',
  '..oowwwwwwwfwwwwwwwwwwoo..',
  '.owwwwwwwwwwfwwwwwwfwwwwo.',
  'owwwwwwwwwwwwfwwwwwwfwwwwo',
  'orwwwwwwwwwwwwwwwwwwwwwwro',
  'osrwwwwwwwwwwwwwwwwwwwwrso',
  'ossrwwwwwwwwwwwwwwwwwwrsso',
  'osssswwwwwwwwwwwwwwwwsssso',
  'osssssswwwwwwwwwwwwsssssso',
  '.ossssssfsssssssssfssssso.',
  '..oooooooooooooooooooooo..',
  '...l..................l...',
  '...l..................l...',
  '...l..................l...',
];
const WRITE_MS = 380;
const AG = 0.15; const AG_H = 1.8;
const STAND_HEAD = 42; const SIT_HEAD = 39;
// abaixo de 0,2: modo mapa (regiões e contagens), para a cidade grande caber inteira na tela
const ZOOMS = [0.015, 0.025, 0.04, 0.06, 0.09, 0.13, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 1, 2, 3, 4];
const MAP_IN = 0.17; const MAP_OUT = 0.19; // entra e sai com folga (sem piscar no limite)
const NOWHERE = { x0: 1, y0: 1, x1: 0, y1: 0 };
const GROUP_DUR: Record<GroupKind, [number, number]> = {
  chat: [9000, 16000], debate: [8000, 13000], visit: [8000, 14000], handoff: [6000, 9000], meeting: [12000, 20000], assembly: [15000, 24000], wrestle: [8000, 12000],
};
const ANIM_MS = { open: 520, close: 460, switch: 420, build: 1300 };

const MARK_ROWS: Record<'attention' | 'working' | 'waiting', string[]> = {
  attention: ['.ooooo.', 'occgcco', 'occgcco', 'occgcco', 'occccco', 'occgcco', '.ooooo.', '...o...'],
  working: ['.ooooo.', 'occccgo', 'occcgco', 'occgcco', 'ocgccco', 'occccco', '.ooooo.', '...o...'],
  waiting: ['.ooooo.', 'ocgggco', 'occccgo', 'occggco', 'occccco', 'occgcco', '.ooooo.', '...o...'],
};
const BUBBLE_ROWS: Record<Exclude<Bubble, null>, string[]> = {
  talk: ['.ooooooo.', 'owwwwwwwo', 'owdwdwdwo', 'owwwwwwwo', '.oowooooo', '...oo....'],
  think: ['..ooooo..', '.owwwwwo.', 'owwdwdwwo', '.owwwwwo.', '..ooooo..', '..o......', '.o.......'],
  exclaim: ['.ooooo.', 'owwcwwo', 'owwcwwo', 'owwcwwo', 'owwwwwo', 'owwcwwo', '.oowooo', '..oo...'],
  drop: ['.o.', 'obo', 'obo', '.o.'],
};
const ZZZ_ROWS = ['........ooooo', '........owwwo', '........ooowo', '........owwoo', 'ooooooo.owwwo', 'owwwwwo.ooooo', 'ooooowo......',
  '...owwo......', '..owwoo......', '.owwooo......', 'owwwwwo......', 'ooooooo......'];
const RING: Array<[number, number]> = (() => {
  const pts = new Set<string>();
  for (const [rx, ry] of [[7 * RES, 3 * RES], [7 * RES - 1, 3 * RES - 1]]) for (let a = 0; a < 360; a += 2) pts.add(`${Math.round(Math.cos((a * Math.PI) / 180) * rx)},${Math.round(Math.sin((a * Math.PI) / 180) * ry)}`);
  return [...pts].map((s) => s.split(',').map(Number) as [number, number]);
})();

const basePlan = (p: Partial<Plan> & Pick<Plan, 'kind' | 'loc' | 'spot'>): Plan => ({
  y: null, facing: 'front', mirror: false, sit: false, perch: false, gestures: ['none'], expr: 'smile', bubble: null, carry: false,
  group: null, dur: [0, 0], key: null, label: null, area: null, tour: null, fast: false, hide: false, ...p,
});
const OUT: Loc = { b: null, level: 0 };
/** Quem está em cada prédio (por andar) e quem dorme em casa, contado uma vez por quadro. */
interface Occupancy { by: Map<string, { levels: Map<number, { n: number; working: number; waiting: number }>; badge: 'working' | 'waiting' | 'attention' | null }>; asleep: Set<number> }

/** Máscara de pixels opacos de um sprite (clique só onde há desenho), calculada uma vez. */
const masks = new WeakMap<Sprite, Uint8Array>();
function maskOf(s: Sprite): Uint8Array {
  if (s.mask && s.mask.length === s.w * s.h) return s.mask;
  let m = masks.get(s);
  if (!m) {
    m = new Uint8Array(s.canvas.width * s.canvas.height);
    try { const d = s.canvas.getContext('2d')!.getImageData(0, 0, s.canvas.width, s.canvas.height).data; for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0; } catch { m.fill(1); }
    masks.set(s, m);
  }
  return m;
}
const spriteHit = (s: Sprite, lx: number, ly: number) => { const W = s.canvas.width; if (lx < 0 || ly < 0 || lx >= W || ly >= s.canvas.height) return false; return maskOf(s)[Math.floor(ly) * W + Math.floor(lx)] === 1; };

export class IsoEngine {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private cb: EngineCallbacks;
  private theme: Theme;
  private town: Town = new Town([]);
  private townKey = '';
  private structIds = new Set<string>();
  private firstTown = true;
  private items: CityItem[] = [];
  private hitsArea: AreaHit[] = [];
  private chunks = new Lru<HTMLCanvasElement>(90);
  // áreas de clique com o retângulo na tela (recorte por quadro) e lotes livres por posição
  private hitRects: Array<[number, number, number, number]> = [];
  private lotAt = new Map<string, Town['lots'][number]>();
  // casas por agente (prédio, andar, vaga): refeitas só quando esse conjunto muda
  private houseSig = ''; private houseOfId = new Map<string, number>();
  // arte de prédio ainda por desenhar (orçamento por quadro): pede outro quadro
  private artPending = false;
  private chunkPending = false;
  // região em foco (tela + margem) da última atualização; null antes de a tela ter tamanho
  private focusRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** zoom distante: a cidade vira mapa (blocos, ruas e contagens por região), sem arte nem bonecos */
  private mapMode = false;
  private rts = new Map<string, Rt>();
  private groups = new Map<string, Group>();
  private gid = 0;
  private npc: Look;
  private npcSt: Npc;
  private reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private economy = false;
  private frameTimes: number[] = [];
  private selected: string | null = null;
  private editing = false;
  private rightInset = 0;
  // câmera (pixels do mundo; k = pixels do dispositivo por pixel do mundo)
  private cx = 0; private cy = 0; private k = 1;
  private tcx = 0; private tcy = 0; private tk = 1;
  private anchor: { wx: number; wy: number; sx: number; sy: number } | null = null;
  private userCam = false;
  private cssW = 0; private dpr = 1; private W = 1; private H = 1;
  private wheelAcc = 0;
  // prédio aberto e animações
  private focus: SceneFocus | null = null;
  private anims = new Map<string, Anim>();
  private hover: { kind: 'band'; building: string; level: number; faces: P2[][] } | { kind: 'lot'; i: number; j: number } | { kind: 'struct'; id: string } | null = null;
  private drag: { id: string; kind: string; gi: number; gj: number; i: number; j: number; ok: boolean } | null = null;
  private pendingMove = new Map<string, [number, number]>();
  // laço
  private raf = 0; private timer = 0; private last = 0; private dirty = true; private disposed = false;
  // fora da tela (outra área do Ergon): a vida segue num passo leve, sem desenhar
  private bg = 0; private bgLast = 0;
  private rand = rng(20261024);
  private drawn: Drawn[] = [];
  private agentsDrawn: Array<{ id: string; fx: number; fy: number; name: string; sel: boolean }> = [];
  private down: { x: number; y: number; cx: number; cy: number; moved: boolean; onStruct: string | null } | null = null;
  private stats = { frames: 0, lastFrameMs: 0, fps: 0, sprites: 0 };
  /** Força noite/dia na vida ambiente (testes); null = relógio local. */
  nightOverride: boolean | null = null;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks, themeId: ThemeId = 'dia') {
    this.canvas = canvas; this.cb = cb; this.theme = THEMES[themeId];
    this.g = canvas.getContext('2d', { alpha: false })!;
    this.npc = npcLook(this.theme);
    this.npcSt = { pos: [0, 0, 0], mover: null, until: performance.now() + 7000, facing: 'front', mirror: false, walked: 0, think: false, spot: 0 };
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);
    canvas.addEventListener('contextlost', this.onLostCtx);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('keydown', this.onKey);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf); clearTimeout(this.timer); clearInterval(this.bg);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown); c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp); c.removeEventListener('pointercancel', this.onCancel); c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel); c.removeEventListener('dblclick', this.onDbl);
    c.removeEventListener('contextlost', this.onLostCtx);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('keydown', this.onKey);
  }

  // ================================================================ entradas vindas do React
  setTown(structs: StructureIn[]): void {
    const key = JSON.stringify(structs.map((s) => [s.id, s.kind, s.i, s.j, s.floors.map((f) => [f.level, f.slots])]));
    if (key === this.townKey) return;
    const old = this.town;
    this.townKey = key;
    this.lastStructs = structs;
    this.town = new Town(structs, this.skin ? skinPack(this.skin.data) : undefined);
    this.items = cityItems(this.town, this.theme);
    this.hitsArea = areaHits(this.town);
    this.hitRects = this.hitsArea.map((h) => { let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; for (const [x, y] of h.poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; });
    this.lotAt = new Map(this.town.lots.map((l) => [`${l.i},${l.j}`, l]));
    this.chunks.clear();
    this.pendingMove.clear();
    const now = performance.now();
    // estruturas novas ou movidas se montam em holograma
    for (const s of structs) {
      const before = old.buildings.get(s.id) ?? old.areas.get(s.id);
      const isNew = !this.structIds.has(s.id);
      const moved = !!before && (before.i !== s.i || before.j !== s.j);
      if (!this.firstTown && (isNew || moved)) this.anims.set(s.id, { kind: 'build', t0: now, dur: ANIM_MS.build, from: null, to: null });
      // quem está dentro de um prédio movido vai junto
      const ob = old.buildings.get(s.id); const nb = this.town.buildings.get(s.id);
      if (ob && nb && (ob.ox !== nb.ox || ob.oz !== nb.oz)) {
        const dx = nb.ox - ob.ox; const dz = nb.oz - ob.oz;
        for (const rt of this.rts.values()) if (rt.loc.b === s.id) {
          rt.pos = [rt.pos[0] + dx, rt.pos[1], rt.pos[2] + dz];
          if (rt.mover) rt.mover.path = rt.mover.path.map((p) => [p[0] + dx, p[1], p[2] + dz] as P3);
        }
      }
    }
    this.structIds = new Set(structs.map((s) => s.id));
    if (this.focus && !this.town.buildings.get(this.focus.building)) this.setFocus(null);
    // a vida ambiente recomeça a partir da cidade nova (rotas, pontos e casas mudaram)
    // quem já está na própria mesa fica (sem calcular rota): com milhares de agentes, refazer todas as rotas a cada
    // andar novo travava a tela por segundos
    for (const rt of this.rts.values()) {
      this.endLife(rt, now);
      const spot = this.deskSpot(rt.a, rt.seated ? 'seat' : 'idle');
      const atDesk = !rt.mover && rt.loc.b === spot.loc.b && rt.loc.level === spot.loc.level && Math.abs(rt.pos[0] - spot.p[0]) < 1e-6 && Math.abs(rt.pos[2] - spot.p[1]) < 1e-6 && Math.abs(rt.pos[1] - spot.y) < 1e-6;
      if (atDesk) { rt.spotKey = `${spot.loc.b}|${spot.loc.level}|${spot.p.join(',')}`; continue; }
      this.goHome(rt, now, true);
    }
    const ag = this.town.areaOf('agora');
    if (ag) { const s = ag.def.npcSpots[0] ?? [0, 0]; this.npcSt.pos = [s[0] + ag.ox, 0, s[1] + ag.oz]; this.npcSt.mover = null; this.npcSt.spot = 0; }
    if (this.firstTown || !this.userCam) this.frameCity(this.firstTown);
    this.firstTown = false;
    this.invalidate();
  }

  // pacotes .ergon instalados (só dados): skin, cores por cima do tema, efeitos e pets por agente
  private skin: ActiveSkin | null = null;
  private skinKey = '';
  private lastStructs: StructureIn[] = [];
  private themeId: ThemeId = 'dia';
  private themeOverride: { base: ThemeId; colors: Record<string, string> } | null = null;
  private fxOf = new Map<string, Array<{ effect: string; color: string; intensity: number }>>();
  private petOf = new Map<string, { species: string; color: string }>();

  setCosmetics(c: { skin?: { data: SkinData; characters: Array<{ agentId: string; index: number }> } | null; theme: { base: ThemeId; colors: Record<string, string> } | null; effects: Array<{ agentId: string; effect: string; color: string; intensity: number }>; pets: Array<{ agentId: string; species: string; color: string }> }): void {
    this.fxOf = new Map(); for (const e of c.effects) this.fxOf.set(e.agentId, [...(this.fxOf.get(e.agentId) ?? []), e]);
    const skinKey = c.skin ? JSON.stringify([c.skin.data.id, c.skin.data, c.skin.characters]) : '';
    const skinChanged = skinKey !== this.skinKey;
    if (skinChanged) {
      this.skinKey = skinKey;
      this.skin = c.skin ? { data: c.skin.data, characters: new Map(c.skin.characters.map((x) => [x.agentId, x.index])) } : null;
      this.skinPets.clear();
    }
    this.petOf = new Map(c.pets.map((x) => [x.agentId, x]));
    const before = JSON.stringify(this.themeOverride);
    this.themeOverride = c.theme;
    if (skinChanged || JSON.stringify(c.theme) !== before) {
      if (skinChanged && this.lastStructs.length) { this.townKey = ''; this.setTown(this.lastStructs); }
      const id = this.themeId; this.themeId = '' as ThemeId; this.setTheme(id);
    }
    this.invalidate();
  }

  /** Aparência do agente: a da skin ativa (personagem ou sorteada) ou a de sempre. */
  private lookOf(a: SceneAgent, th: Theme): Look { return this.skin ? agentSkinLook(a, this.skin, th) : lookFor(a, th); }
  /** Pet da skin (sorteado uma vez por agente; o pet de um pacote tem prioridade). */
  private skinPets = new Map<string, { species: string; color: string } | null>();
  private skinPetOf(id: string): { species: string; color: string } | null {
    if (!this.skin) return null;
    if (!this.skinPets.has(id)) this.skinPets.set(id, skinPet(id, this.skin.data));
    return this.skinPets.get(id) ?? null;
  }
  /** Com uma skin sem personagem na praça, o anfitrião grego não aparece. */
  private npcVisible(): boolean { return !this.skin || !!this.skin.data.npc; }

  /** Cores do pacote só onde o tema já tem uma cor simples (nada de estrutura nova). */
  private themed(id: ThemeId): Theme {
    const o = this.themeOverride;
    const mode: ThemeId = (o?.base ?? id) === 'noite' ? 'noite' : 'dia';
    const base = this.skin ? skinTheme(THEMES[mode], this.skin.data, mode) : THEMES[mode] ?? THEMES.dia;
    if (!o) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(o.colors)) if (typeof out[k] === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v;
    return out as unknown as Theme;
  }

  setTheme(id: ThemeId): void {
    if (id === this.themeId) return;
    this.themeId = id;
    const th = this.themed(id);
    if (th === this.theme) return;
    this.theme = th; this.npc = this.skin?.data.npc ? lookFromSkin(this.skin.data.npc.look, this.skin.data, '#9b2d30', th) : npcLook(th);
    for (const rt of this.rts.values()) rt.look = this.lookOf(rt.a, th);
    this.items = cityItems(this.town, th);
    this.chunks.clear();
    this.invalidate();
  }

  setEditing(on: boolean): void {
    if (on === this.editing) return;
    this.editing = on; this.drag = null; this.hover = null;
    if (on && this.focus) this.setFocus(null);
    this.canvas.style.cursor = on ? 'default' : 'grab';
    this.invalidate();
  }

  setInsets(right: number): void {
    if (Math.abs(right - this.rightInset) < 1) return;
    this.rightInset = right;
    if (this.selected) this.centerOnSelected(false);
    this.invalidate();
  }

  setAgents(agents: SceneAgent[]): void {
    const now = performance.now();
    // casa de cada agente: ordem estável (prédio, andar, vaga), dois por casa
    const sig = agents.map((a) => `${a.id}|${a.building}|${a.level}|${a.slot}`).join(';');
    if (sig !== this.houseSig) {
      const order = [...agents].sort((a, b) => a.building.localeCompare(b.building) || a.level - b.level || a.slot - b.slot);
      this.houseOfId = new Map(order.map((a, i) => [a.id, Math.floor(i / RESIDENTS_PER_HOUSE)]));
      this.houseSig = sig;
    }
    const houseOfId = this.houseOfId;
    for (const a of agents) {
      const visual = visualFor(a.run);
      const target = targetFor(visual);
      const spot = this.deskSpot(a, target === 'seat' ? 'seat' : 'idle');
      const key = `${spot.loc.b}|${spot.loc.level}|${spot.p.join(',')}`;
      const rt = this.rts.get(a.id);
      if (!rt) {
        this.rts.set(a.id, {
          a, look: this.lookOf(a, this.theme), pos: [spot.p[0], spot.y, spot.p[1]], loc: spot.loc, mover: null, seated: target === 'seat', visual, spotKey: key,
          facing: 'front', mirror: false, idleMirror: (hashOf(a.name) & 1) === 1, walked: 0,
          life: { mode: 'home', until: now + between(this.rand, [800, 7000]), plan: null, next: null, since: now, toured: false },
          react: null, afterReact: false, outcome: a.outcome, house: houseOfId.get(a.id) ?? 0,
        });
        continue;
      }
      rt.house = houseOfId.get(a.id) ?? rt.house;
      if (rt.a.name !== a.name || rt.a.color !== a.color || rt.a.role !== a.role || rt.a.key !== a.key || rt.a.seed !== a.seed) rt.look = this.lookOf(a, this.theme);
      const outcomeChanged = !!a.outcome && a.outcome !== rt.outcome;
      rt.outcome = a.outcome;
      const moved = rt.a.building !== a.building || rt.a.level !== a.level || rt.a.slot !== a.slot;
      rt.a = a; rt.visual = visual; rt.seated = target === 'seat';
      // trabalho real tem prioridade: larga a vida ambiente (acorda, sai da piscina…) e volta para a mesa
      const interrupted = visual !== 'idle' && rt.life.mode !== 'home';
      if (interrupted) this.endLife(rt, now);
      if (outcomeChanged) this.react(rt, a.outcome!, now);
      if (rt.spotKey === key && !interrupted && !moved) continue;
      rt.spotKey = key;
      if (!interrupted) this.endLife(rt, now);
      if (this.reduced) { rt.pos = [spot.p[0], spot.y, spot.p[1]]; rt.loc = spot.loc; rt.mover = null; continue; }
      if (rt.react) { rt.mover = null; rt.afterReact = true; continue; } // reage primeiro, depois sai
      this.go(rt, spot.p, spot.loc);
    }
    const ids = new Set(agents.map((a) => a.id));
    for (const id of [...this.rts.keys()]) {
      if (ids.has(id)) continue;
      const rt = this.rts.get(id)!; this.endLife(rt, now); this.rts.delete(id);
    }
    this.invalidate();
  }

  /** Placas do trabalho da equipe (números do servidor; nada é contado aqui). */
  setOps(o: SceneOps | null): void {
    if (JSON.stringify(o) === JSON.stringify(this.ops)) return;
    this.ops = o; this.invalidate();
  }
  private ops: SceneOps | null = null;
  /** onde as placas ficaram na tela no último quadro (alvo de clique e de cursor) */
  private plaques: Array<{ kind: SceneOpsTarget; x: number; y: number; w: number; h: number }> = [];

  /** Leva a câmera até o agente (abre o andar dele), mesmo que ele já esteja selecionado. */
  focusAgent(id: string): void { this.selected = null; this.setSelected(id); }

  setSelected(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    const rt = id ? this.rts.get(id) : undefined;
    if (rt) {
      // quem está num prédio: abre o prédio no andar dele
      const loc = this.town.locate(rt.pos[0], rt.pos[1], rt.pos[2]);
      if (loc.b && (!this.focus || this.focus.building !== loc.b || this.focus.level !== loc.level)) this.setFocus({ building: loc.b, level: loc.level });
      this.centerOnSelected(true);
    }
    this.invalidate();
  }

  resize(cssW: number, cssH: number): void {
    // oculta (outra área do Ergon): guarda a câmera e a imagem; nada a desenhar até voltar
    if (cssW < 2 || cssH < 2) { this.cssW = 0; return; }
    this.cssW = cssW; this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.round(cssW * this.dpr)); this.H = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.canvas.style.width = `${cssW}px`; this.canvas.style.height = `${cssH}px`;
    if (!this.userCam) this.frameCity(true);
    this.invalidate();
  }

  // ================================================================ prédio aberto
  open(building: string, level: number): void { this.setFocus({ building, level }); }
  close(): void { this.setFocus(null); }

  private setFocus(f: SceneFocus | null): void {
    const prev = this.focus;
    if (prev && f && prev.building === f.building && prev.level === f.level) return;
    if (!prev && !f) return;
    const now = performance.now();
    if (prev && (!f || f.building !== prev.building)) this.anims.set(prev.building, { kind: 'close', t0: now, dur: ANIM_MS.close, from: prev.level, to: null });
    if (f) {
      const same = prev && prev.building === f.building;
      this.anims.set(f.building, same ? { kind: 'switch', t0: now, dur: ANIM_MS.switch, from: prev!.level, to: f.level } : { kind: 'open', t0: now, dur: ANIM_MS.open, from: null, to: f.level });
    }
    this.focus = f;
    this.cb.onFocus(f);
    this.invalidate();
  }

  /** Câmera até uma estrutura (ou a cidade inteira). Não abre o prédio: ele aparece fechado. */
  flyTo(target: string): void {
    if (target === 'cidade') { this.frameCity(false); return; }
    const b = this.town.buildings.get(target); const a = this.town.areas.get(target);
    const box = b ? b.foot : a ? a.lot : null;
    if (!box) return;
    const top = b ? b.base + b.floors.length * FLOOR_H + 1.2 : 1.5;
    const pts = [project(box.x0, 0, box.z1), project(box.x1, 0, box.z0), project(box.x1, 0, box.z1), project(box.x0, top, box.z0)];
    const x0 = Math.min(...pts.map((p) => p[0])); const x1 = Math.max(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1])); const y1 = Math.max(...pts.map((p) => p[1]));
    const availW = this.W - this.rightInset * this.dpr;
    const fit = Math.min((availW * 0.62) / (x1 - x0), (this.H * 0.62) / (y1 - y0));
    this.tk = Math.min(2, this.snapZoom(fit, true)); // perto o bastante para ver o prédio, sem pixels gigantes
    this.tcx = (x0 + x1) / 2 + (this.rightInset * this.dpr) / 2 / this.tk; this.tcy = (y0 + y1) / 2;
    this.anchor = null; this.userCam = true;
    this.jumpIfFar();
    this.cb.onStructure(target);
    this.invalidate();
  }

  // ================================================================ casa, mesa e rotas
  private deskSpot(a: SceneAgent, which: 'seat' | 'idle'): { loc: Loc; p: Vec2; y: number } {
    const b = this.town.buildings.get(a.building);
    const f = b ? this.town.floorOf(b, a.level) ?? b.floors[0] : undefined;
    if (!b || !f) { const e = this.town.bounds; return { loc: OUT, p: [(e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2], y: 0 }; }
    const local = which === 'seat' ? seatOf(f.plan, b.spec, a.slot) : idleSpotOf(f.plan, b.spec, a.slot);
    return { loc: { b: b.id, level: f.level }, p: [local[0] + b.ox, local[1] + b.oz], y: f.y };
  }

  private go(rt: Rt, to: Vec2, loc: Loc, y: number | null = null): void {
    const path = this.town.route(rt.pos, to, loc, y);
    path[0] = [rt.pos[0], rt.pos[1], rt.pos[2]];
    rt.mover = startMove(rt.pos, path);
  }

  private goHome(rt: Rt, now: number, instant = false): void {
    const spot = this.deskSpot(rt.a, rt.seated ? 'seat' : 'idle');
    rt.spotKey = `${spot.loc.b}|${spot.loc.level}|${spot.p.join(',')}`;
    if (!instant) rt.life = { mode: 'returning', until: now + 2000, plan: null, next: null, since: now, toured: false };
    this.go(rt, spot.p, spot.loc);
  }

  // ================================================================ reações a desfechos reais
  private react(rt: Rt, outcome: string, now: number): void {
    const kind = outcome.split('|')[0];
    if (kind === 'succeeded') rt.react = { gesture: 'joy', expr: 'smile', until: now + 2600, jump: true };
    else if (kind === 'failed') rt.react = { gesture: 'angry', expr: 'angry', until: now + 3200, jump: false };
    else if (kind === 'cancelled') rt.react = { gesture: 'worry', expr: 'worried', until: now + 2400, jump: false };
  }

  // ================================================================ vida ambiente
  private lifeOn(): boolean { return !this.reduced; }
  private isNight(): boolean { return this.nightOverride ?? isNightHour(new Date().getHours()); }
  private hidden(rt: Rt): boolean { return rt.life.mode === 'doing' && !!rt.life.plan?.hide && !rt.mover; }

  private startPlan(rt: Rt, plan: Plan, now: number, next: Plan | null = null): void {
    rt.life = { mode: 'going', until: 0, plan, next, since: now, toured: false };
    this.go(rt, plan.spot, plan.loc, plan.y);
  }

  private sendHome(rt: Rt, now: number): void {
    const home = this.deskSpot(rt.a, 'idle');
    rt.life = { mode: 'returning', until: 0, plan: null, next: null, since: now, toured: false };
    if (Math.hypot(rt.pos[0] - home.p[0], rt.pos[2] - home.p[1]) > 0.05 || Math.abs(rt.pos[1] - home.y) > 0.05) this.go(rt, home.p, home.loc);
  }

  private endGroup(id: string, now: number, except: Rt | null = null): void {
    const grp = this.groups.get(id);
    if (!grp) return;
    this.groups.delete(id);
    for (const mid of grp.members) {
      const m = this.rts.get(mid);
      if (!m || m === except || (m.life.plan?.group !== id && m.life.next?.group !== id)) continue;
      if (m.life.plan?.kind === 'desk') { m.life.plan.group = null; continue; }
      if (m.life.mode === 'waiting') { m.life = { mode: 'home', until: now + between(this.rand, [3000, 8000]), plan: null, next: null, since: now, toured: false }; continue; }
      if (m.visual === 'idle') this.sendHome(m, now);
    }
  }

  private endLife(rt: Rt, now: number): void {
    const gidOf = rt.life.plan?.group ?? rt.life.next?.group;
    if (gidOf) this.endGroup(gidOf, now, rt);
    rt.life = { mode: 'home', until: now + between(this.rand, [3000, 9000]), plan: null, next: null, since: now, toured: false };
  }

  private busy(): Set<string> {
    const s = new Set<string>();
    for (const rt of this.rts.values()) { if (rt.life.plan?.key) s.add(rt.life.plan.key); if (rt.life.next?.key) s.add(rt.life.next.key); }
    return s;
  }

  /** Outro agente está (ou vai estar) a menos de 0,6 destes pontos? Evita dois bonecos no mesmo lugar. */
  private crowded(spots: Vec2[], except: Rt[]): boolean {
    for (const o of this.rts.values()) {
      if (except.includes(o)) continue;
      const at: Vec2[] = [];
      if (!this.hidden(o)) at.push([o.pos[0], o.pos[2]]);
      const L = o.life;
      if (L.plan && !(L.mode === 'doing' && L.plan.tour)) at.push(L.plan.spot);
      if (L.next) at.push(L.next.spot);
      if (spots.some((s) => at.some((p) => Math.hypot(p[0] - s[0], p[1] - s[1]) < 0.6))) return true;
    }
    return false;
  }

  /** Quem pode ser chamado: ocioso em casa ou (fromDesk) trabalhando sozinho na mesa há algum tempo. */
  private available(loc: Loc | null, except: Rt, now: number, fromDesk: boolean): Rt[] {
    const c: Rt[] = [];
    for (const o of this.rts.values()) {
      if (o === except || o.visual !== 'idle' || o.react || o.mover || o.afterReact) continue;
      if (loc && !(o.a.building === loc.b && o.a.level === loc.level)) continue;
      const L = o.life;
      if (L.mode === 'home' && now - L.since > 2000) c.push(o);
      else if (fromDesk && L.mode === 'doing' && L.plan?.kind === 'desk' && !L.plan.group && now - L.since > 6000) c.push(o);
    }
    return c;
  }

  private pickOne<T>(list: T[]): T | null { return list.length ? list[Math.floor(this.rand() * list.length)] : null; }
  private newGroup(kind: GroupKind, members: Rt[], now: number, timeout = 25000): string {
    const id = `g${++this.gid}`;
    this.groups.set(id, { id, kind, members: members.map((m) => m.a.id), created: now, started: 0, until: 0, timeout });
    return id;
  }

  private floorCtx(rt: Rt): { b: BuildingInst; loc: Loc; W: (p: Vec2) => Vec2; y: number; f: NonNullable<ReturnType<Town['floorOf']>> } | null {
    const b = this.town.buildings.get(rt.a.building); const f = b ? this.town.floorOf(b, rt.a.level) : undefined;
    if (!b || !f) return null;
    return { b, f, loc: { b: b.id, level: f.level }, y: f.y, W: (p) => [p[0] + b.ox, p[1] + b.oz] };
  }
  private actPlan(a: Activity, loc: Loc, W: (p: Vec2) => Vec2, key: string, area: string | null): Plan {
    return basePlan({
      kind: 'solo', loc, spot: W(a.spot), y: a.y ?? null, facing: a.facing, mirror: a.mirror, sit: !!a.sit, perch: !!a.perch, gestures: a.gestures, expr: a.expr,
      bubble: a.bubble, dur: a.dur, key, label: a.label ?? null, area, tour: a.tour ? a.tour.map(W) : null, fast: !!a.fast,
    });
  }

  private startDesk(rt: Rt, now: number): boolean {
    const c = this.floorCtx(rt); if (!c || rt.a.slot >= c.f.plan.desks.length) return false;
    const spot = c.W(seatOf(c.f.plan, c.b.spec, rt.a.slot));
    this.startPlan(rt, basePlan({ kind: 'desk', loc: c.loc, spot, facing: 'front', mirror: true, sit: true, gestures: ['none', 'none', 'think'], expr: 'neutral', dur: [12000, 26000], key: `${c.b.id}:${c.loc.level}:mesa${rt.a.slot}` }), now);
    return true;
  }

  private startVisit(rt: Rt, now: number, busy: Set<string>): boolean {
    const c = this.floorCtx(rt); if (!c) return false;
    const hosts = [...this.rts.values()].filter((o) => o !== rt && o.a.building === rt.a.building && o.a.level === rt.a.level && o.visual === 'idle' && !o.react
      && o.life.mode === 'doing' && o.life.plan?.kind === 'desk' && !o.life.plan.group && !busy.has(`${c.b.id}:${c.loc.level}:visita${o.a.slot}`)
      && !this.crowded([c.W(visitSpot(c.f.plan, c.b.spec, o.a.slot))], [rt, o]));
    const host = this.pickOne(hosts); if (!host) return false;
    const id = this.newGroup('visit', [rt, host], now);
    host.life.plan!.group = id;
    this.startPlan(rt, basePlan({ kind: 'group', loc: c.loc, spot: c.W(visitSpot(c.f.plan, c.b.spec, host.a.slot)), group: id, key: `${c.b.id}:${c.loc.level}:visita${host.a.slot}` }), now);
    return true;
  }

  private startChat(rt: Rt, now: number, busy: Set<string>): boolean {
    const c = this.floorCtx(rt); if (!c || !c.f.plan.chats.length) return false;
    const partner = this.pickOne(this.available(c.loc, rt, now, true)); if (!partner) return false;
    const free = c.f.plan.chats.map((_, i) => i).filter((i) => !busy.has(`${c.b.id}:${c.loc.level}:chat${i}`));
    const ci = this.pickOne(free); if (ci === null) return false;
    const [A, B] = pairAt(c.f.plan.chats[ci]).map(c.W) as [Vec2, Vec2];
    if (this.crowded([A, B], [rt, partner])) return false;
    const id = this.newGroup(this.rand() < 0.22 ? 'debate' : 'chat', [rt, partner], now);
    this.startPlan(rt, basePlan({ kind: 'group', loc: c.loc, spot: A, group: id, key: `${c.b.id}:${c.loc.level}:chat${ci}` }), now);
    this.startPlan(partner, basePlan({ kind: 'group', loc: c.loc, spot: B, mirror: true, group: id, key: `${c.b.id}:${c.loc.level}:chat${ci}b` }), now);
    return true;
  }

  private startHandoff(rt: Rt, now: number, busy: Set<string>): boolean {
    const c = this.floorCtx(rt); if (!c || !c.f.plan.fetch) return false;
    const shelf = c.f.plan.fetch; const kf = `${c.b.id}:${c.loc.level}:${shelf.id}`;
    if (busy.has(kf)) return false;
    const to = this.pickOne(this.available(c.loc, rt, now, false).filter((o) => o.life.mode === 'home' && o.a.slot < c.f.plan.desks.length
      && !busy.has(`${c.b.id}:${c.loc.level}:entrega${o.a.slot}`) && !this.crowded([c.W(handoffSpot(c.f.plan, c.b.spec, o.a.slot))], [rt, o])));
    if (!to) return false;
    const id = this.newGroup('handoff', [rt, to], now);
    const fetch = basePlan({ kind: 'fetch', loc: c.loc, spot: c.W(shelf.spot), facing: shelf.facing, mirror: shelf.mirror, gestures: ['reach'], expr: 'neutral', group: id, dur: [2400, 3000], key: kf });
    this.startPlan(rt, fetch, now, basePlan({ kind: 'group', loc: c.loc, spot: c.W(handoffSpot(c.f.plan, c.b.spec, to.a.slot)), group: id, key: `${c.b.id}:${c.loc.level}:entrega${to.a.slot}`, carry: true }));
    to.life = { mode: 'waiting', until: 0, plan: basePlan({ kind: 'group', loc: c.loc, spot: c.W(idleSpotOf(c.f.plan, c.b.spec, to.a.slot)), mirror: true, group: id }), next: null, since: now, toured: false };
    return true;
  }

  private startMeeting(rt: Rt, now: number, busy: Set<string>): boolean {
    const c = this.floorCtx(rt); if (!c || c.f.plan.meeting.length < 3) return false;
    const km = `${c.b.id}:${c.loc.level}:reuniao`;
    if (busy.has(`${km}0`)) return false;
    const others = this.available(c.loc, rt, now, true);
    if (others.length < 2) return false;
    const a = this.pickOne(others)!; const b = this.pickOne(others.filter((o) => o !== a))!;
    const members = [rt, a, b];
    const spots = c.f.plan.meeting.map((m) => c.W(m.spot));
    if (this.crowded(spots, members)) return false;
    const id = this.newGroup('meeting', members, now);
    members.forEach((m, i) => { const s = c.f.plan.meeting[i]; this.startPlan(m, basePlan({ kind: 'group', loc: c.loc, spot: spots[i], facing: s.facing, mirror: s.mirror, group: id, key: `${km}${i}` }), now); });
    return true;
  }

  private startSolo(rt: Rt, now: number, busy: Set<string>): boolean {
    const c = this.floorCtx(rt); if (!c) return false;
    const prefix = `${c.b.id}:${c.loc.level}:`;
    const act = pickActivity(this.rand, busy, c.f.plan.activities, prefix);
    if (!act || this.crowded([c.W(act.spot)], [rt])) return false;
    this.startPlan(rt, this.actPlan(act, c.loc, c.W, prefix + act.id, null), now);
    return true;
  }

  // ---- cidade
  private areaW(a: AreaInst) { return (p: Vec2): Vec2 => [p[0] + a.ox, p[1] + a.oz]; }

  private startOutdoorSolo(rt: Rt, now: number, busy: Set<string>, kind: string): boolean {
    const a = this.town.areaOf(kind); if (!a) return false;
    const prefix = `c:${a.id}:`;
    const act = pickActivity(this.rand, busy, a.def.activities, prefix);
    if (!act || (!act.tour && this.crowded([this.areaW(a)(act.spot)], [rt]))) return false;
    this.startPlan(rt, this.actPlan(act, OUT, this.areaW(a), prefix + act.id, kind), now);
    return true;
  }

  private startPairOutdoor(rt: Rt, now: number, busy: Set<string>, kind: 'agora' | 'ginasio'): boolean {
    const a = this.town.areaOf(kind); if (!a) return false;
    const partner = this.pickOne(this.available(null, rt, now, true)); if (!partner) return false;
    const W = this.areaW(a);
    let A: Vec2; let B: Vec2; let key: string; let label: string;
    if (kind === 'ginasio') { if (!a.def.wrestle) return false; [A, B] = a.def.wrestle.map(W) as [Vec2, Vec2]; key = `c:${a.id}:luta`; label = 'lutando'; }
    else {
      const free = a.def.chats.map((_, i) => i).filter((i) => !busy.has(`c:${a.id}:chat${i}`));
      const ci = this.pickOne(free); if (ci === null) return false;
      [A, B] = pairAt(a.def.chats[ci]).map(W) as [Vec2, Vec2]; key = `c:${a.id}:chat${ci}`; label = 'conversando';
    }
    if (busy.has(key) || this.crowded([A, B], [rt, partner])) return false;
    const id = this.newGroup(kind === 'ginasio' ? 'wrestle' : this.rand() < 0.2 ? 'debate' : 'chat', [rt, partner], now, 60000);
    this.startPlan(rt, basePlan({ kind: 'group', loc: OUT, spot: A, group: id, key, area: kind, label }), now);
    this.startPlan(partner, basePlan({ kind: 'group', loc: OUT, spot: B, mirror: true, group: id, key: `${key}b`, area: kind, label }), now);
    return true;
  }

  private startAssembly(rt: Rt, now: number, busy: Set<string>): boolean {
    const a = this.town.areaOf('teatro'); if (!a || !a.def.speaker) return false;
    const kp = `c:${a.id}:palco`;
    if (busy.has(kp)) return false;
    const pool = this.available(null, rt, now, true);
    if (pool.length < 2) return false;
    const n = Math.min(pool.length, 2 + Math.floor(this.rand() * 3));
    const listeners: Rt[] = [];
    while (listeners.length < n) { const o = this.pickOne(pool.filter((p) => !listeners.includes(p)))!; listeners.push(o); }
    const seats = a.def.seats.map((s, i) => ({ s, i })).filter(({ i }) => !busy.has(`c:${a.id}:assento${i}`));
    if (seats.length < n) return false;
    const W = this.areaW(a);
    const id = this.newGroup('assembly', [rt, ...listeners], now, 60000);
    this.startPlan(rt, basePlan({ kind: 'group', loc: OUT, spot: W(a.def.speaker), facing: 'back', group: id, key: kp, area: 'teatro', label: 'falando na assembleia' }), now);
    const chosen = seats.sort(() => this.rand() - 0.5).slice(0, n);
    listeners.forEach((m, k) => {
      const { s, i } = chosen[k];
      this.startPlan(m, basePlan({ kind: 'group', loc: OUT, spot: W(s.spot), y: s.y, mirror: s.mirror, perch: true, group: id, key: `c:${a.id}:assento${i}`, area: 'teatro', label: 'na plateia' }), now);
    });
    return true;
  }

  private houseOf(rt: Rt): { a: AreaInst; h: House } | null {
    const a = this.town.areaOf('bairro'); if (!a || !a.def.houses.length) return null;
    return { a, h: a.def.houses[rt.house % a.def.houses.length] };
  }

  private startHome(rt: Rt, now: number, night: boolean): boolean {
    const hh = this.houseOf(rt); if (!hh) return false;
    const dur: [number, number] = night ? [msUntilMorning(new Date()), msUntilMorning(new Date()) + 60000] : [15000, 30000];
    this.startPlan(rt, basePlan({ kind: 'home', loc: OUT, spot: this.areaW(hh.a)(hh.h.door), facing: 'back', hide: true, dur, label: 'dormindo', area: `casa${hh.h.id}` }), now);
    return true;
  }

  private startChoice(rt: Rt, choice: LifeChoice, now: number, busy: Set<string>): boolean {
    switch (choice) {
      case 'desk': return this.startDesk(rt, now);
      case 'visit': return this.startVisit(rt, now, busy);
      case 'chat': return this.startChat(rt, now, busy);
      case 'handoff': return this.startHandoff(rt, now, busy);
      case 'meeting': return this.startMeeting(rt, now, busy);
      case 'solo': return this.startSolo(rt, now, busy);
      case 'agora': return this.rand() < 0.4 ? this.startPairOutdoor(rt, now, busy, 'agora') : this.startOutdoorSolo(rt, now, busy, 'agora');
      case 'termas': return this.startOutdoorSolo(rt, now, busy, 'termas');
      case 'ginasio': return this.rand() < 0.25 ? this.startPairOutdoor(rt, now, busy, 'ginasio') : this.startOutdoorSolo(rt, now, busy, 'ginasio');
      case 'teatro': return this.rand() < 0.7 ? this.startAssembly(rt, now, busy) : this.startOutdoorSolo(rt, now, busy, 'teatro');
      case 'casa': return this.startHome(rt, now, false);
    }
  }

  private tickLife(now: number): boolean {
    const on = this.lifeOn(); const night = this.isNight();
    let changed = false; let walking = 0;
    for (const rt of this.rts.values()) if (rt.mover && rt.life.mode !== 'doing') walking++;
    const maxWalking = this.economy ? 4 : 6;
    for (const grp of [...this.groups.values()]) {
      const members = grp.members.map((m) => this.rts.get(m)).filter((m): m is Rt => !!m && (m.life.plan?.group === grp.id || m.life.next?.group === grp.id));
      if (members.length < grp.members.length) { this.endGroup(grp.id, now); changed = true; continue; }
      if (!grp.started) {
        const ready = members.every((m) => (m.life.mode === 'doing' || m.life.mode === 'waiting') && m.life.plan?.kind !== 'fetch');
        if (ready) {
          grp.started = now; grp.until = now + between(this.rand, GROUP_DUR[grp.kind]); changed = true;
          for (const m of members) if (m.life.mode === 'waiting') { m.life.mode = 'doing'; m.life.since = now; }
        } else if (now - grp.created > grp.timeout) { this.endGroup(grp.id, now); changed = true; }
      } else if (now >= grp.until) { this.endGroup(grp.id, now); changed = true; }
    }
    for (const rt of this.rts.values()) {
      if (rt.visual !== 'idle' || rt.react || rt.afterReact) continue;
      const L = rt.life;
      if (!on) { if (L.mode !== 'home' && L.mode !== 'returning') { this.endLife(rt, now); this.sendHome(rt, now); changed = true; } continue; }
      if (L.mode === 'home') {
        if (now < L.until || rt.mover || walking >= maxWalking) continue;
        if (this.focusRect && !this.onScreen(rt.pos, this.focusRect)) { L.until = now + 4000; continue; }
        const busy = this.busy();
        const ok = night ? this.startHome(rt, now, true) : (this.startChoice(rt, pickChoice(this.rand), now, busy) || this.startDesk(rt, now));
        if (ok) { walking++; changed = true; } else L.until = now + 4000;
      } else if (L.mode === 'going' && !rt.mover) {
        L.mode = 'doing'; L.since = now; changed = true;
        const p = L.plan;
        if (p && p.tour) { L.toured = true; rt.mover = startMove(rt.pos, p.tour.map(([x, z]) => [x, 0, z] as P3)); rt.mover.path[0] = [...rt.pos]; }
        else if (p && p.kind !== 'group') L.until = now + between(this.rand, p.dur);
      } else if (L.mode === 'doing' && L.plan) {
        const p = L.plan;
        if (p.kind === 'fetch' && now >= L.until && L.next) {
          const next = L.next; rt.life = { mode: 'going', until: 0, plan: next, next: null, since: now, toured: false }; this.go(rt, next.spot, next.loc, next.y); changed = true;
        } else if (p.tour && L.toured && !rt.mover) { this.sendHome(rt, now); changed = true; }
        else if ((p.kind === 'solo' || p.kind === 'desk' || p.kind === 'home') && !p.tour && now >= L.until && !p.group) {
          if (p.kind === 'home' && night) { L.until = now + msUntilMorning(new Date()); continue; }
          this.sendHome(rt, now); changed = true;
        }
      } else if (L.mode === 'returning' && !rt.mover) {
        L.mode = 'home'; L.since = now; L.until = now + between(this.rand, [3000, 9000]); changed = true;
      }
    }
    // Alexandre Magno passeia pela ágora e para para pensar
    const n = this.npcSt; const ag = this.town.areaOf('agora');
    if (ag && !n.mover && on && now >= n.until) {
      if (n.think || this.rand() < 0.5) {
        let next = Math.floor(this.rand() * ag.def.npcSpots.length); if (next === n.spot) next = (next + 1) % ag.def.npcSpots.length;
        n.think = false; n.spot = next;
        const to = this.areaW(ag)(ag.def.npcSpots[next]);
        const path = this.town.route(n.pos, to, OUT); path[0] = [...n.pos]; n.mover = startMove(n.pos, path);
      } else { n.think = true; n.until = now + between(this.rand, [4000, 7000]); }
      changed = true;
    }
    return changed;
  }

  // ================================================================ câmera
  /** Retângulo (pixels do mundo) da cidade inteira, com os prédios. */
  private cityRect() {
    const b = this.town.bounds;
    const pts = [project(b.x0, 0, b.z1), project(b.x1, 0, b.z0), project(b.x1, 0, b.z1), project(b.x0, 6, b.z0)];
    return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
  }
  private snapZoom(k: number, roundDown: boolean): number {
    let best = ZOOMS[0];
    for (const z of ZOOMS) if (roundDown ? z <= k + 1e-6 : Math.abs(z - k) < Math.abs(best - k)) best = z;
    return Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], best));
  }
  /** Zoom que mostra a cidade inteira (quase tudo) na área livre da tela. */
  private cityFit(): number {
    const r = this.cityRect(); const availW = this.W - this.rightInset * this.dpr;
    return Math.min((availW * 1.05) / (r.x1 - r.x0), (this.H * 1.1) / (r.y1 - r.y0));
  }
  /** Menor zoom permitido: a cidade que cabe em 0,2 para em 0,2 (como sempre); a maior afasta até caber inteira. */
  private minZoom(): number { return Math.min(0.2, this.snapZoom(Math.max(this.cityFit(), ZOOMS[0]), true)); }
  /** Enquadra a cidade: a Stoa e as áreas no centro, a maior aproximação que mostra quase tudo. */
  private frameCity(instant: boolean): void {
    if (!this.cssW) return;
    const r = this.cityRect();
    const fit = this.cityFit();
    this.tk = fit < 0.13 ? this.snapZoom(Math.max(fit, ZOOMS[0]), true) : Math.max(0.2, this.snapZoom(fit, true));
    this.tcx = (r.x0 + r.x1) / 2 + (this.rightInset * this.dpr) / 2 / this.tk; this.tcy = (r.y0 + r.y1) / 2;
    this.anchor = null; this.userCam = false;
    if (instant) { this.k = this.tk; this.cx = this.tcx; this.cy = this.tcy; }
    this.invalidate();
  }
  private centerOnSelected(always: boolean): void {
    const rt = this.selected ? this.rts.get(this.selected) : undefined; if (!rt) return;
    const [px, py] = project(rt.pos[0], rt.pos[1] + 0.9, rt.pos[2]);
    const kk = Math.max(this.tk, 2);
    const offX = (this.rightInset * this.dpr) / 2 / kk;
    const sx = (px - this.cx) * this.k + this.W / 2; const sy = (py - this.cy) * this.k + this.H / 2;
    const visW = this.W - this.rightInset * this.dpr; const m = 60 * this.dpr;
    if (!always && sx > m && sx < visW - m && sy > m && sy < this.H - m) return;
    this.tk = kk; this.tcx = px + offX; this.tcy = py; this.anchor = null; this.userCam = true;
    this.jumpIfFar();
    this.invalidate();
  }
  /** Alvo longe (mais de duas telas e meia): a câmera vai direto, sem atravessar o mapa. */
  private jumpIfFar(): void {
    if (this.mapMode || Math.hypot(this.tcx - this.cx, this.tcy - this.cy) * this.k > 2.5 * Math.max(this.W, this.H)) { this.k = this.tk; this.cx = this.tcx; this.cy = this.tcy; }
  }

  /** Avança a câmera em direção ao alvo (suave); true enquanto se move. */
  private stepCamera(dt: number): boolean {
    const f = 1 - Math.exp(-dt * 11);
    const dk = this.tk - this.k;
    if (Math.abs(dk) > 1e-4) this.k += dk * f; else this.k = this.tk;
    if (this.anchor) { // mantém o ponto sob o cursor parado enquanto aproxima
      const a = this.anchor;
      this.cx = a.wx - (a.sx - this.W / 2) / this.k; this.cy = a.wy - (a.sy - this.H / 2) / this.k;
      this.tcx = a.wx - (a.sx - this.W / 2) / this.tk; this.tcy = a.wy - (a.sy - this.H / 2) / this.tk;
      if (this.k === this.tk) this.anchor = null;
    } else {
      const dx = this.tcx - this.cx; const dy = this.tcy - this.cy;
      if (Math.hypot(dx, dy) > 0.05) { this.cx += dx * f; this.cy += dy * f; } else { this.cx = this.tcx; this.cy = this.tcy; }
    }
    this.clampCam();
    return this.k !== this.tk || this.cx !== this.tcx || this.cy !== this.tcy;
  }
  private clampCam(): void {
    const r = this.cityRect(); const m = 160;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    this.cx = clamp(this.cx, r.x0 - m, r.x1 + m); this.cy = clamp(this.cy, r.y0 - m, r.y1 + m);
    this.tcx = clamp(this.tcx, r.x0 - m, r.x1 + m); this.tcy = clamp(this.tcy, r.y0 - m, r.y1 + m);
  }
  private toWorld(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * this.W; const sy = ((e.clientY - r.top) / r.height) * this.H;
    return [(sx - this.W / 2) / this.k + this.cx, (sy - this.H / 2) / this.k + this.cy];
  }
  private toScreen(px: number, py: number): [number, number] { return [(px - this.cx) * this.k + this.W / 2, (py - this.cy) * this.k + this.H / 2]; }

  // ================================================================ em segundo plano
  /**
   * A cidade não para quando você vai para outra área do Ergon: os agentes continuam andando, trabalhando, conversando
   * e indo para casa num passo leve (duas vezes por segundo, sem desenhar). Voltar ao Ambiente só mostra a cena —
   * ninguém volta ao começo.
   */
  setActive(active: boolean): void {
    if (active) {
      if (!this.bg) return;
      clearInterval(this.bg); this.bg = 0;
      this.invalidate();
      return;
    }
    if (this.bg || this.disposed) return;
    cancelAnimationFrame(this.raf); this.raf = 0; clearTimeout(this.timer); this.timer = 0; this.last = 0;
    this.hover = null; this.down = null;
    this.bgLast = performance.now();
    this.bg = window.setInterval(() => {
      const now = performance.now();
      // passos de no máximo 0,1 s (o mesmo da tela); uma aba do navegador em espera pode pular até 5 s de uma vez
      let left = Math.min(5, (now - this.bgLast) / 1000); this.bgLast = now;
      while (left > 0) { const dt = Math.min(0.1, left); left -= dt; this.update(dt, now - left * 1000); }
    }, 500);
  }

  // ================================================================ laço sob demanda
  invalidate(): void { this.dirty = true; this.wake(); }
  private wake(): void { if (this.raf || this.disposed) return; this.raf = requestAnimationFrame(this.frame); }

  private frame = (t: number): void => {
    this.raf = 0;
    if (!this.cssW || this.disposed || this.bg) return;
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    if (this.last) { this.frameTimes.push(t - this.last); if (this.frameTimes.length > 90) this.frameTimes.shift(); }
    this.last = t;
    const cam = this.stepCamera(dt || 1 / 60);
    const { moving, visMoving, animating, changed } = this.update(dt, t);
    const anim = this.anims.size > 0;
    if (visMoving || animating || changed || cam || anim || this.dirty || this.hover) this.draw(t);
    // arte de prédio que ficou para depois (orçamento do quadro): o próximo quadro termina
    this.dirty = this.artPending;
    clearTimeout(this.timer); this.timer = 0;
    if (document.visibilityState !== 'visible') { this.last = 0; return; }
    if (visMoving || cam || anim || this.artPending) {
      this.autoEconomy();
      if (this.economy && !cam && !anim) this.timer = window.setTimeout(() => this.wake(), 33);
      else this.wake();
      return;
    }
    if (moving) { this.frameTimes = []; this.timer = window.setTimeout(() => this.wake(), 100); return; }
    this.last = 0; this.frameTimes = [];
    if (animating || this.hover?.kind === 'band') { this.timer = window.setTimeout(() => this.wake(), this.hover ? 80 : 200); return; }
    const next = this.nextWake();
    if (next !== null) this.timer = window.setTimeout(() => this.wake(), Math.max(120, Math.min(4000, next - performance.now())));
  };

  /** Alto por padrão; cai para 30 quadros/s sozinho se o navegador não sustentar ~60. */
  private autoEconomy(): void {
    if (this.economy || this.frameTimes.length < 90) return;
    const s = [...this.frameTimes].sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)];
    if (med > 21) this.economy = true;
  }

  private nextWake(): number | null {
    let best: number | null = null;
    const take = (v: number) => { if (best === null || v < best) best = v; };
    for (const rt of this.rts.values()) {
      if (rt.react) take(rt.react.until);
      if (this.lifeOn() && rt.visual === 'idle' && (rt.life.mode === 'home' || this.hidden(rt))) take(rt.life.until);
    }
    for (const g of this.groups.values()) take(g.started ? g.until : g.created + g.timeout);
    if (this.lifeOn() && !this.npcSt.mover) take(this.npcSt.until);
    return best;
  }

  /** Retângulo da tela em pixels do mundo, com uma margem (`m` em frações da tela). */
  private viewWorld(m = 0): { x0: number; y0: number; x1: number; y1: number } {
    const k = this.k || 1; const hw = this.W / 2 / k; const hh = this.H / 2 / k;
    return { x0: this.cx - hw * (1 + 2 * m), y0: this.cy - hh * (1 + 2 * m), x1: this.cx + hw * (1 + 2 * m), y1: this.cy + hh * (1 + 2 * m) };
  }
  private onScreen(p: P3, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
    if (r.x1 < r.x0) return false; // NOWHERE (modo mapa)
    const [px, py] = project(p[0], p[1], p[2]);
    return px > r.x0 - 24 && px < r.x1 + 24 && py > r.y0 - 4 && py < r.y1 + 64;
  }

  private update(dt: number, now: number): { moving: boolean; visMoving: boolean; animating: boolean; changed: boolean } {
    let changed = false;
    // a região em foco é a tela e meia tela em volta: só ali a vida ambiente começa coisas novas (fora, cada um fica
    // no seu lugar; o estado real de trabalho vem do servidor e continua valendo em toda a cidade)
    this.focusRect = !this.cssW ? null : this.mapMode ? NOWHERE : this.viewWorld(0.5);
    for (const [id, a] of this.anims) if (now - a.t0 >= a.dur) { this.anims.delete(id); changed = true; }
    for (const rt of this.rts.values()) {
      if (rt.react && now >= rt.react.until) {
        rt.react = null; changed = true;
        if (rt.afterReact) { rt.afterReact = false; const s = this.deskSpot(rt.a, rt.seated ? 'seat' : 'idle'); this.go(rt, s.p, s.loc); }
      }
      if (!rt.mover) continue;
      const prev = rt.pos; const p0 = rt.life.plan;
      const touring = rt.life.mode === 'doing' && !!p0?.tour;
      const inWater = this.inWater(prev[0], prev[2]);
      const speed = touring ? (p0!.fast ? 2.1 : inWater ? 0.55 : 1) : 1;
      const still = stepMove(rt.mover, dt * speed);
      const p = rt.mover.pos; rt.pos = [p[0], p[1], p[2]];
      rt.loc = this.town.locate(p[0], p[1], p[2]);
      const dx = p[0] - prev[0]; const dz = p[2] - prev[2];
      rt.walked += Math.hypot(dx, dz, p[1] - prev[1]) * (touring && p0!.fast ? 0.8 : 1);
      const sdx = dx - dz; const sdy = dx + dz;
      if (Math.abs(sdx) + Math.abs(sdy) > 1e-5) { rt.facing = sdy < -1e-4 ? 'back' : 'front'; rt.mirror = sdx < 0; }
      if (!still) { rt.mover = null; changed = true; }
    }
    const n = this.npcSt;
    if (n.mover) {
      const prev = n.pos; const still = stepMove(n.mover, dt * 0.6);
      n.pos = [...n.mover.pos];
      const dx = n.pos[0] - prev[0]; const dz = n.pos[2] - prev[2];
      n.walked += Math.hypot(dx, dz);
      if (Math.abs(dx - dz) + Math.abs(dx + dz) > 1e-5) { n.facing = dx + dz < -1e-4 ? 'back' : 'front'; n.mirror = dx - dz < 0; }
      if (!still) { n.mover = null; n.until = now + between(this.rand, [7000, 15000]); changed = true; }
    }
    if (this.tickLife(now)) changed = true;
    // o que anda ou anima fora da tela não pede quadro (só a simulação segue, num passo mais lento)
    const vr = this.mapMode ? NOWHERE : this.viewWorld(0);
    const npcVis = !this.mapMode && this.onScreen(n.pos, vr);
    let moving = !!n.mover; let visMoving = !!n.mover && npcVis; let animating = false;
    for (const rt of this.rts.values()) {
      const anim = !!rt.react || (rt.life.mode === 'doing' && !this.hidden(rt)) || (rt.seated && !rt.mover && rt.visual !== 'idle' && !this.reduced);
      if (!rt.mover && !anim) continue;
      if (rt.mover) moving = true;
      if (!this.onScreen(rt.pos, vr)) continue;
      if (rt.mover) visMoving = true;
      if (anim) animating = true;
    }
    if (n.think && this.lifeOn() && npcVis) animating = true;
    if (this.selected && this.rts.get(this.selected)?.mover) this.centerOnSelected(false);
    return { moving, visMoving, animating, changed };
  }

  private inWater(x: number, z: number): boolean {
    const a = this.town.areaOf('termas'); const w = a?.def.pool?.water;
    return !!a && !!w && x > w.x0 + a.ox && x < w.x1 + a.ox && z > w.z0 + a.oz && z < w.z1 + a.oz;
  }

  // ================================================================ desenho
  private draw(now: number): void {
    const t0 = performance.now();
    const g = this.g; const th = this.theme;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = th.bg; g.fillRect(0, 0, this.W, this.H);
    const k = this.k;
    const crisp = Math.abs(k - Math.round(k)) < 1e-3 && k >= 1;
    const tx = this.W / 2 - this.cx * k; const ty = this.H / 2 - this.cy * k;
    g.setTransform(k, 0, 0, k, crisp ? Math.round(tx) : tx, crisp ? Math.round(ty) : ty);
    g.imageSmoothingEnabled = k < 1;
    this.drawn = []; this.agentsDrawn = []; this.stats.sprites = 0;
    const view = { x0: this.cx - this.W / 2 / k, y0: this.cy - this.H / 2 / k, x1: this.cx + this.W / 2 / k, y1: this.cy + this.H / 2 / k };
    const wasMap = this.mapMode;
    this.mapMode = this.mapMode ? k < MAP_OUT : k < MAP_IN;
    this.chunkPending = false;
    if (this.mapMode) {
      this.artPending = false;
      if (!wasMap) { this.hover = null; this.plaques = []; }
      this.drawMap(view); const st = this.stats; st.frames++; st.lastFrameMs = performance.now() - t0; return;
    }
    // orçamento por quadro só na cidade grande (a pequena sai pronta no primeiro quadro, como sempre), e sempre ao
    // menos um bloco de chão e um prédio novos por quadro (progresso garantido mesmo em máquina lenta)
    const big = this.town.buildings.size + this.town.areas.size > 60; let newChunks = 0;

    // chão em blocos: perto, resolução cheia; longe, blocos maiores em resolução menor (memória e desenho estáveis)
    const lod = k >= 0.5 ? 1 : k >= 0.25 ? 0.5 : 0.25; const span = CHUNK / lod;
    const c0 = Math.floor(view.x0 / span); const c1 = Math.floor(view.x1 / span); const r0 = Math.floor(view.y0 / span); const r1 = Math.floor(view.y1 / span);
    this.chunks.reserve((c1 - c0 + 1) * (r1 - r0 + 1) * 1.5);
    for (let cj = r0; cj <= r1; cj++) for (let ci = c0; ci <= c1; ci++) {
      const key = `${lod}|${ci},${cj}`; let c = this.chunks.get(key);
      if (!c && big && newChunks > 0 && performance.now() - t0 > 10) { this.chunkPending = true; continue; }
      if (!c) {
        newChunks++;
        c = document.createElement('canvas'); c.width = CHUNK; c.height = CHUNK;
        drawGroundChunk(c.getContext('2d')!, this.town, th, { x0: ci * span, y0: cj * span, x1: (ci + 1) * span, y1: (cj + 1) * span }, ci, cj, lod);
        this.chunks.set(key, c);
      }
      // 1 pixel de tela a mais em cada bloco: sem emenda entre blocos quando o zoom não é inteiro (aparece no mar)
      const o = 1 / k; g.drawImage(c, ci * span, cj * span, span + o, span + o);
    }
    const inViewR = (r: [number, number, number, number]) => r[2] > view.x0 - 40 && r[0] < view.x1 + 40 && r[3] > view.y0 - 40 && r[1] < view.y1 + 40;
    this.hitsArea.forEach((h, i) => { if (inViewR(this.hitRects[i])) this.drawn.push({ kind: 'area', hit: h }); });
    this.drawGroundOverlays(now, inViewR);

    // objetos ordenáveis: prédios inteiros, objetos das áreas, quem está ao ar livre
    const items: Array<Sortable & { kind: string }> = [];
    const inView = (r: [number, number, number, number]) => r[2] > view.x0 - 40 && r[0] < view.x1 + 40 && r[3] > view.y0 - 40 && r[1] < view.y1 + 40;
    // quem está em cada prédio e andar: uma passada por quadro (antes, cada prédio visível varria todos os agentes)
    const occ = this.occupancy();
    const artS = this.artScale(k);
    const vis: Array<{ b: BuildingInst; rect: [number, number, number, number] }> = [];
    for (const b of this.town.buildings.values()) {
      const r = closedRect(b); const rect: [number, number, number, number] = [r.x0, r.y0, r.x1, r.y1];
      if (inView(rect)) vis.push({ b, rect });
    }
    reserveClosed(artS === 1 ? vis.length * 1.3 + 8 : 80); reserveSmall(artS < 1 ? vis.length * 1.3 + 8 : 0);
    const budget = t0 + 14; this.artPending = this.chunkPending; let newArt = 0;
    for (const { b, rect } of vis) {
      const special = this.focus?.building === b.id || this.anims.has(b.id) || this.pendingMove.has(b.id);
      const ready = special || (artS === 1 ? hasClosed(b, th) : hasSmall(b, th, artS));
      if (!ready) newArt++;
      if (!ready && big && newArt > 1 && performance.now() > budget) { // arte ainda por desenhar: silhueta simples, o resto no próximo quadro
        this.artPending = true;
        items.push({ kind: 'b', box: buildingBox(b, this.scanTop(b) - 3), rect, draw: () => this.drawPlaceholder(b) });
        continue;
      }
      const top = special || artS === 1 ? closedArt(b, th).top : closedSmall(b, th, artS).top;
      items.push({ kind: 'b', box: buildingBox(b, top), rect, draw: () => this.drawBuilding(b, now, artS, occ) });
    }
    for (const it of this.items) {
      const rect: [number, number, number, number] = [it.px - it.sprite.ax, it.py - it.sprite.ay, it.px - it.sprite.ax + it.sprite.w, it.py - it.sprite.ay + it.sprite.h];
      if (!inView(rect)) continue;
      items.push({ kind: 'p', box: it.box, rect, draw: () => { g.drawImage(it.sprite.canvas, it.px - it.sprite.ax, it.py - it.sprite.ay); this.drawn.push({ kind: 'prop', x: it.px - it.sprite.ax, y: it.py - it.sprite.ay, s: it.sprite, area: it.area }); this.stats.sprites++; } });
    }
    for (const rt of this.rts.values()) {
      if (rt.loc.b || this.hidden(rt)) continue;
      const ar = this.agentRect(rt.pos); if (!inView(ar)) continue;
      items.push({ kind: 'a', box: this.agentBox(rt.pos), rect: ar, draw: () => this.drawAgent(rt, now) });
    }
    if (this.town.areaOf('agora') && this.npcVisible()) items.push({ kind: 'n', box: this.agentBox(this.npcSt.pos), rect: this.agentRect(this.npcSt.pos), draw: () => this.drawNpc(now) });
    const lona = this.tarpSpot();
    if (lona) items.push({ kind: 'p', box: lona.box, rect: lona.rect, draw: () => this.drawTarp(lona.px, lona.py) });
    if (this.drag) this.drawDragGhost();
    for (const it of sortItems(items)) it.draw();

    // casas com alguém dormindo
    const bairro = this.town.areaOf('bairro');
    if (bairro) {
      const asleep = new Set([...occ.asleep].map((h) => h % Math.max(1, bairro.def.houses.length)));
      for (const hi of asleep) { const h = bairro.def.houses[hi]; if (!h) continue; const [px, py] = project(bairro.ox + h.x0 + (h.x1 - h.x0) * 0.3, h.h + 0.9, bairro.oz + h.z1); this.drawIcon(ZZZ_ROWS, { o: th.outline, w: '#fbf7ee' }, px, py); }
    }
    this.drawHoverOverlay(now);
    // nomes sob os pés (texto nítido no tamanho do dispositivo)
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNames();
    this.drawPlaques();
    const s = this.stats; s.frames++; s.lastFrameMs = performance.now() - t0;
  }

  /**
   * Modo mapa (zoom distante): chão da cidade, ruas como linhas, cada construção como um bloco simples (cor pelo
   * estado: trabalhando, esperando você) e, por região, um rótulo com construções e agentes. Nada de arte detalhada,
   * bonecos ou ordenação: o custo acompanha o número de construções na tela, não o de agentes.
   */
  private drawMap(view: { x0: number; y0: number; x1: number; y1: number }): void {
    const g = this.g; const th = this.theme; const k = this.k;
    const poly = (pts: P2[], color: string) => { g.fillStyle = color; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill(); };
    const b = this.town.bounds;
    poly([project(b.x0, 0, b.z0), project(b.x1, 0, b.z0), project(b.x1, 0, b.z1), project(b.x0, 0, b.z1)], th.ground[1]);
    g.save(); g.strokeStyle = th.road.fill; g.lineWidth = 2.8 * KY; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath();
    for (const r of this.town.roads) { const p0 = project(r.pts[0][0], 0, r.pts[0][1]); g.moveTo(p0[0], p0[1]); for (let i = 1; i < r.pts.length; i++) { const p = project(r.pts[i][0], 0, r.pts[i][1]); g.lineTo(p[0], p[1]); } }
    g.stroke(); g.restore();
    for (const a of this.town.areas.values()) poly(boxPoly(a.lot), th.plaza[0]);
    // quem é de cada construção (pelo endereço do servidor, não por onde o boneco está agora)
    const occ = new Map<string, Occ>();
    for (const rt of this.rts.values()) {
      const o = occ.get(rt.a.building) ?? { agents: 0, working: 0, waiting: 0 };
      o.agents++; if (rt.visual === 'working') o.working++; if (rt.visual === 'waiting') o.waiting++;
      occ.set(rt.a.building, o);
    }
    const inView = (r: { x0: number; y0: number; x1: number; y1: number }) => r.x1 > view.x0 && r.x0 < view.x1 && r.y1 > view.y0 && r.y0 < view.y1;
    for (const bb of this.town.buildings.values()) {
      if (!inView(closedRect(bb))) continue;
      const f = bb.foot; const h = bb.base + bb.floors.length * FLOOR_H;
      const o = occ.get(bb.id);
      poly([project(f.x0, h, f.z1), project(f.x1, h, f.z1), project(f.x1, 0, f.z1), project(f.x0, 0, f.z1)], th.houseWall[1]);
      poly([project(f.x1, h, f.z0), project(f.x1, h, f.z1), project(f.x1, 0, f.z1), project(f.x1, 0, f.z0)], th.houseWall[2]);
      poly([project(f.x0, h, f.z0), project(f.x1, h, f.z0), project(f.x1, h, f.z1), project(f.x0, h, f.z1)], o?.waiting ? th.marks.waiting : o?.working ? th.teal[0] : th.roof[0]);
    }
    // rótulos por região, em pixels da tela (nítidos)
    const items = [...this.town.buildings.values()].map((x) => ({ id: x.id, i: x.i, j: x.j, w: typeOf(x.kind)?.footprint[0] ?? 1, d: typeOf(x.kind)?.footprint[1] ?? 1 }));
    const regions = regionsOf(items, occ, regionSize(k * (1 / this.dpr)));
    g.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = this.dpr; const fs = Math.round(12 * dpr);
    g.font = `600 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const r of regions) {
      const [wx, wy] = project(r.x, 0, r.z); const [sx, sy] = this.toScreen(wx, wy);
      if (sx < -100 * dpr || sx > this.W + 100 * dpr || sy < -40 * dpr || sy > this.H + 40 * dpr) continue;
      const l1 = `${r.agents} agente${r.agents === 1 ? '' : 's'} · ${r.structures} ${r.structures === 1 ? 'construção' : 'construções'}`;
      const l2 = r.waiting ? `${r.waiting} esperando você` : r.working ? `${r.working} trabalhando` : '';
      const w = Math.max(g.measureText(l1).width, l2 ? g.measureText(l2).width : 0) + 16 * dpr; const hh = (l2 ? 38 : 22) * dpr;
      g.save(); g.globalAlpha = 0.94; g.fillStyle = '#fffdf8'; g.strokeStyle = th.outline; g.lineWidth = dpr;
      g.beginPath(); g.roundRect(sx - w / 2, sy - hh / 2, w, hh, 8 * dpr); g.fill(); g.stroke(); g.restore();
      g.fillStyle = '#1d2a33'; g.fillText(l1, sx, l2 ? sy - 8 * dpr : sy);
      if (l2) { g.fillStyle = r.waiting ? '#744c00' : '#1f5f5a'; g.fillText(l2, sx, sy + 9 * dpr); }
    }
  }

  private agentBox(p: P3): AABB { return { x0: p[0] - AG, y0: p[1], z0: p[2] - AG, x1: p[0] + AG, y1: p[1] + AG_H, z1: p[2] + AG }; }
  private agentRect(p: P3): [number, number, number, number] { const [px, py] = project(p[0], p[1], p[2]); return [px - 16, py - 56, px + 16, py + 4]; }

  /** Estado visual de um prédio agora: fechado, aberto num andar ou em animação. */
  private drawBuilding(b: BuildingInst, now: number, s = 1, occ: Occupancy = this.occupancy()): void {
    const g = this.g; const th = this.theme;
    const anim = this.anims.get(b.id);
    const lvl = this.focus?.building === b.id ? this.focus.level : null;
    // estado estável e fechado em zoom afastado: a cópia reduzida (mesma imagem, menos memória)
    if (s < 1 && !anim && lvl === null && !this.pendingMove.has(b.id)) { this.drawClosed(b, closedSmall(b, th, s), now, true, occ); return; }
    const closed = closedArt(b, th);
    const pend = this.pendingMove.get(b.id);
    if (pend) { // movido no editor: aguardando o servidor, já no lugar novo
      g.save(); g.globalAlpha = 0.6; const [dx, dy] = this.lotShift(b, pend); g.translate(dx, dy); g.drawImage(closed.layer.canvas, closed.layer.x0, closed.layer.y0); g.restore();
      return;
    }
    if (anim && anim.kind === 'build') { this.drawBuild(b, closed.layer, closed.rect, (now - anim.t0) / anim.dur); return; }
    if (anim && (anim.kind === 'open' || anim.kind === 'close' || anim.kind === 'switch')) {
      // varredura: um plano horizontal que desce (ou sobe) pelo prédio. Um estado inteiro fica por baixo e o
      // outro só abaixo do plano — que, na vista isométrica, é o "V" das duas paredes da frente.
      // (abrir: o fechado some de cima até o corte; fechar: o fechado se refaz do corte até o telhado)
      const p = this.ease((now - anim.t0) / anim.dur);
      const r = closed.rect;
      const top = this.scanTop(b);
      const cut = (l: number) => b.base + l * FLOOR_H + 1;
      const at = (h0: number, h1: number) => h0 + (h1 - h0) * p;
      const up = (from: number | null) => { this.drawBuildingState(b, from, now, false, occ); }; // por baixo, sem clique
      let h: number; let under: number | null; let over: number | null;
      if (anim.kind === 'open') { under = anim.to; over = null; h = at(top, cut(anim.to!)); up(under); this.registerState(b, under); }
      else if (anim.kind === 'close') { under = anim.from; over = null; h = at(cut(anim.from!), top); up(under); this.registerState(b, null); }
      else if (anim.to! > anim.from!) { under = anim.from; over = anim.to; h = at(cut(anim.from!), top); up(under); this.registerState(b, anim.to); }
      else { under = anim.to; over = anim.from; h = at(top, cut(anim.to!)); up(under); this.registerState(b, under); }
      const v = this.scanV(b, h);
      this.clipPlane(r, v, 'below', () => this.drawBuildingState(b, over, now, false, occ));
      this.scanLine(b, v, h, Math.min(1, p / 0.12, (1 - p) / 0.12));
      void lvl;
      return;
    }
    this.drawBuildingState(b, lvl, now, true, occ);
  }

  /** Prédio fechado (arte cheia ou reduzida): imagem, janelas acesas, faixas de clique e selo. */
  private drawClosed(b: BuildingInst, art: { layer: Layer; windows: Array<{ level: number; poly: P2[] }>; bands: Array<{ level: number; faces: P2[][] }>; top: number }, now: number, register: boolean, occ: Occupancy): void {
    const L = art.layer; const s = L.s ?? 1;
    if (s === 1) this.g.drawImage(L.canvas, L.x0, L.y0); else this.g.drawImage(L.canvas, L.x0, L.y0, L.canvas.width / s, L.canvas.height / s);
    this.stats.sprites++;
    this.drawWindows(b, art.windows, now, occ);
    if (register) for (const band of art.bands) this.drawn.push({ kind: 'band', building: b.id, level: band.level, faces: band.faces });
    this.drawBadge(b, art.top, now, occ);
  }

  /** Silhueta enquanto a arte do prédio não fica pronta (zoom afastado com muitos prédios novos na tela). */
  private drawPlaceholder(b: BuildingInst): void {
    const g = this.g; const th = this.theme; const f = b.foot; const h = Math.max(1, this.scanTop(b) - 3);
    const sil = [project(f.x0, h, f.z0), project(f.x1, h, f.z0), project(f.x1, 0, f.z0), project(f.x1, 0, f.z1), project(f.x0, 0, f.z1), project(f.x0, h, f.z1)];
    g.save(); g.globalAlpha = 0.85; g.fillStyle = th.stone[1]; g.beginPath(); g.moveTo(sil[0][0], sil[0][1]); for (const [x, y] of sil.slice(1)) g.lineTo(x, y); g.closePath(); g.fill(); g.restore();
  }

  /** Escala da arte dos prédios para o zoom: perto, resolução cheia; longe, cópias reduzidas. */
  private artScale(k: number): number { return k >= 0.6 ? 1 : k >= 0.3 ? 0.5 : 0.25; }

  /** Uma passada por quadro: quem está em cada prédio e andar (janelas e selo) e quem dorme em casa. */
  private occupancy(): Occupancy {
    const by = new Map<string, { levels: Map<number, { n: number; working: number; waiting: number }>; badge: 'working' | 'waiting' | 'attention' | null }>();
    const asleep = new Set<number>();
    for (const rt of this.rts.values()) {
      const hidden = this.hidden(rt);
      if (hidden && rt.life.plan?.kind === 'home') asleep.add(rt.house);
      const bid = rt.loc.b; if (!bid) continue;
      let e = by.get(bid); if (!e) { e = { levels: new Map(), badge: null }; by.set(bid, e); }
      if (rt.visual === 'waiting') e.badge = 'waiting'; else if (rt.visual === 'working' && e.badge !== 'waiting') e.badge = 'working'; else if (rt.visual === 'attention' && !e.badge) e.badge = 'attention';
      if (hidden) continue;
      const s = e.levels.get(rt.loc.level) ?? { n: 0, working: 0, waiting: 0 };
      s.n++; if (rt.visual === 'working') s.working++; if (rt.visual === 'waiting') s.waiting++;
      e.levels.set(rt.loc.level, s);
    }
    return { by, asleep };
  }

  private ease(p: number): number { const x = Math.max(0, Math.min(1, p)); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

  /**
   * Altura de onde a varredura parte: acima do telhado o bastante para que, no começo, o prédio inteiro (com o
   * telhado) fique abaixo do plano — a cumeeira fica sobre a quina da frente, (W+D)/2 · KY/KZ mais acima.
   */
  private scanTop(b: BuildingInst): number {
    const w = b.walls;
    return b.base + b.floors.length * FLOOR_H + 3 + ((w.x1 - w.x0) + (w.z1 - w.z0)) * 5 / 24;
  }

  /** O plano da varredura na altura h visto de cima-frente: quinas esquerda, da frente (a mais baixa) e direita. */
  private scanV(b: BuildingInst, h: number): { L: P2; F: P2; R: P2 } {
    const w = b.walls;
    return { L: project(w.x0, h, w.z1), F: project(w.x1, h, w.z1), R: project(w.x1, h, w.z0) };
  }

  /** Recorta pelo plano: abaixo (ou acima) do "V", com os braços prolongados até as bordas do retângulo. */
  private clipPlane(r: { x0: number; y0: number; x1: number; y1: number }, v: { L: P2; F: P2; R: P2 }, side: 'above' | 'below', draw: () => void): void {
    const g = this.g; const pad = 40;
    const xl = r.x0 - pad; const xr = r.x1 + pad;
    const yl = v.F[1] + (xl - v.F[0]) * 0.5; // braço esquerdo: sobe 1 px a cada 2 px para a esquerda
    const yr = v.F[1] - (xr - v.F[0]) * 0.5; // braço direito: sobe 1 px a cada 2 px para a direita
    const edge = side === 'below' ? r.y1 + pad : r.y0 - pad;
    g.save(); g.beginPath();
    g.moveTo(xl, yl); g.lineTo(v.F[0], v.F[1]); g.lineTo(xr, yr); g.lineTo(xr, edge); g.lineTo(xl, edge); g.closePath();
    g.clip(); const n = this.drawn.length; draw(); this.drawn.length = n; g.restore();
  }

  /**
   * Linha da varredura acompanhando as paredes: o "V" das duas fachadas da frente, em degraus de pixel 2:1
   * (nítido, como o resto da arte), com brilho em volta e um ponto em cada quina. Só aparece enquanto o plano
   * passa pelas paredes (acima delas, no telhado, some aos poucos).
   */
  private scanLine(b: BuildingInst, v: { L: P2; F: P2; R: P2 }, h: number, strength: number): void {
    const g = this.g; const c = this.theme.teal[0]; const hot = mix(c, '#ffffff', 0.55);
    const wallTop = b.base + b.floors.length * FLOOR_H;
    const inWalls = Math.max(0, Math.min(1, (wallTop + 0.6 - h) / 0.6, (h - b.base + 0.2) / 0.4));
    const a = Math.max(0, Math.min(1, strength)) * inWalls;
    if (a <= 0.01) return;
    const stairs = (from: P2, to: P2, w: number, hgt: number) => {
      const n = Math.max(1, Math.round(Math.abs(to[0] - from[0]) / 2));
      for (let i = 0; i <= n; i++) {
        const x = Math.round(from[0] + ((to[0] - from[0]) * i) / n); const y = Math.round(from[1] + ((to[1] - from[1]) * i) / n);
        g.fillRect(x - (w >> 1), y - (hgt >> 1), w, hgt);
      }
    };
    const pass = (alpha: number, color: string, w: number, hgt: number) => {
      g.globalAlpha = alpha * a; g.fillStyle = color; stairs(v.L, v.F, w, hgt); stairs(v.F, v.R, w, hgt);
    };
    g.save();
    g.globalCompositeOperation = 'lighter';
    pass(0.16, c, 2, 10 * RES);  // halo largo
    pass(0.34, c, 2, 4 * RES);   // brilho
    g.globalCompositeOperation = 'source-over';
    pass(0.95, hot, 2, RES);     // a linha
    // quinas: um ponto mais forte em cada canto (a da frente maior)
    g.globalAlpha = a; g.fillStyle = '#ffffff';
    for (const [p, s] of [[v.L, 2], [v.F, 3], [v.R, 2]] as Array<[P2, number]>) g.fillRect(p[0] - s, p[1] - s, s * 2, s * 2);
    g.restore();
  }

  /** Montagem holográfica: contorno, o prédio se formando de baixo para cima pelo plano de varredura e pulso no chão. */
  private drawBuild(b: BuildingInst, layer: Layer, r: { x0: number; y0: number; x1: number; y1: number }, p: number): void {
    const g = this.g; const th = this.theme; const e = this.ease(p);
    const foot = boxPoly(b.foot);
    g.save(); g.globalAlpha = 0.35 * (1 - e) + 0.1; fillPoly(g, foot.map(([x, y]) => [x, y] as P2), th.teal[0]); g.restore();
    const h = this.scanTop(b) * e;
    const v = this.scanV(b, h);
    const n = this.drawn.length;
    this.clipPlane(r, v, 'below', () => g.drawImage(layer.canvas, layer.x0, layer.y0));
    g.save(); g.globalAlpha = 0.35 * (1 - e); g.globalCompositeOperation = 'lighter';
    this.clipPlane(r, v, 'above', () => g.drawImage(layer.canvas, layer.x0, layer.y0)); g.restore();
    this.drawn.length = n;
    this.scanLine(b, v, h, Math.min(1, (1 - e) / 0.1 + 0.2));
  }

  /** Só o teste de clique de um estado (durante as animações). */
  private registerState(b: BuildingInst, lvl: number | null): void {
    const bands = lvl === null ? closedArt(b, this.theme).bands : openArt(b, lvl, this.theme).bands;
    for (const band of bands) this.drawn.push({ kind: 'band', building: b.id, level: band.level, faces: band.faces });
  }

  /** Estado estável: fechado (lvl null) ou aberto no andar lvl. `register` = entra no teste de clique. */
  private drawBuildingState(b: BuildingInst, lvl: number | null, now: number, register: boolean, occ: Occupancy = this.occupancy()): void {
    const g = this.g; const th = this.theme;
    if (lvl === null) { this.drawClosed(b, closedArt(b, th), now, register, occ); return; }
    const art = openArt(b, lvl, th);
    g.drawImage(art.lower.canvas, art.lower.x0, art.lower.y0);
    g.drawImage(art.back.canvas, art.back.x0, art.back.y0);
    if (register) {
      for (const band of art.bands) if (band.level < lvl) this.drawn.push({ kind: 'band', building: b.id, level: band.level, faces: band.faces });
      const y = b.base + lvl * FLOOR_H;
      const floorPoly = [project(b.walls.x0, y + 2.8, b.walls.z0), project(b.walls.x1, y + 2.8, b.walls.z0), project(b.walls.x1, y, b.walls.z0), project(b.walls.x1, y, b.foot.z1), project(b.walls.x0, y, b.foot.z1), project(b.walls.x0, y + 2.8, b.walls.z1)];
      this.drawn.push({ kind: 'floor', building: b.id, poly: floorPoly });
      for (const band of art.bands) if (band.level > lvl) this.drawn.push({ kind: 'band', building: b.id, level: band.level, faces: band.faces, exclude: floorPoly });
      for (const h of art.hits) this.drawn.push({ kind: 'objpoly', building: b.id, obj: h.kind, poly: h.poly });
    }
    // móveis e quem está neste andar, na ordem das caixas
    const items: Sortable[] = art.items.map((it) => ({
      box: it.box, rect: [it.px - it.sprite.ax, it.py - it.sprite.ay, it.px - it.sprite.ax + it.sprite.w, it.py - it.sprite.ay + it.sprite.h] as [number, number, number, number],
      draw: () => { g.drawImage(it.sprite.canvas, it.px - it.sprite.ax, it.py - it.sprite.ay); this.stats.sprites++; if (register) this.drawn.push({ kind: 'prop', x: it.px - it.sprite.ax, y: it.py - it.sprite.ay, s: it.sprite, hit: it.hit, building: b.id }); },
    }));
    const y = b.base + lvl * FLOOR_H;
    const sb = b.spec.stair ? stairBox(b.spec.stair) : null;
    for (const rt of this.rts.values()) {
      if (rt.loc.b !== b.id || this.hidden(rt)) continue;
      const lx = rt.pos[0] - b.ox; const lz = rt.pos[2] - b.oz;
      const onStair = !!sb && lx > sb.x0 - 0.05 && lx < sb.x1 + 0.05 && lz > sb.z0 - 0.05 && lz < sb.z1 + 0.05;
      if (rt.loc.level === lvl) {
        if (onStair && art.stairTop !== null && rt.pos[1] > art.stairTop + 0.6) continue; // subiu além do corte
        const fade = onStair && art.stairTop !== null && rt.pos[1] > art.stairTop ? 1 - (rt.pos[1] - art.stairTop) / 0.6 : 1;
        items.push({ box: this.agentBox(rt.pos), rect: this.agentRect(rt.pos), draw: () => this.drawAgent(rt, now, register, fade) });
      } else if (rt.loc.level === lvl - 1 && onStair && rt.pos[1] > y - 1.4 && art.hole) {
        // subindo pelo vão: só a parte acima do piso, ou o que se vê pelo vão
        items.push({ box: this.agentBox(rt.pos), rect: this.agentRect(rt.pos), draw: () => this.clipAgent(rt, art, y, now, register) });
      }
    }
    for (const it of sortItems(items)) it.draw();
    g.drawImage(art.front.canvas, art.front.x0, art.front.y0);
    // andares de cima: holograma quase invisível; aparece quando o mouse está sobre o prédio (para escolher o andar)
    if (art.ghost) {
      const near = this.hover?.kind === 'band' && this.hover.building === b.id;
      g.save(); g.globalAlpha = near ? 0.7 + 0.12 * Math.sin(now / 420) : 0.16; g.drawImage(art.ghost.canvas, art.ghost.x0, art.ghost.y0); g.restore();
    }
  }

  private clipAgent(rt: Rt, art: OpenArt, floorY: number, now: number, register: boolean): void {
    const g = this.g; const [px, py] = project(rt.pos[0], floorY, rt.pos[2]);
    g.save(); g.beginPath();
    const h = art.hole!; g.moveTo(h[0][0], h[0][1]); for (let i = 1; i < h.length; i++) g.lineTo(h[i][0], h[i][1]); g.closePath();
    g.rect(px - 40, py - 200, 80, 200);
    g.clip('nonzero'); this.drawAgent(rt, now, register); g.restore();
  }

  /** Janelas acesas por andar ocupado; telas tremulando onde alguém trabalha de verdade. */
  private drawWindows(b: BuildingInst, wins: Array<{ level: number; poly: P2[] }>, now: number, occ: Occupancy): void {
    const g = this.g; const th = this.theme; const night = th.id.includes('noite');
    const byLevel = occ.by.get(b.id)?.levels; if (!byLevel) return;
    wins.forEach((w, i) => {
      const s = byLevel.get(w.level); if (!s) return;
      g.save();
      if (s.working) { g.globalAlpha = 0.55 + 0.3 * Math.sin(now / 160 + i * 1.7); fillPoly(g, w.poly, th.teal[0]); }
      else if (s.waiting) { g.globalAlpha = 0.45 + 0.35 * Math.sin(now / 300 + i); fillPoly(g, w.poly, th.marks.waiting); }
      else { g.globalAlpha = night ? 0.75 : 0.32; fillPoly(g, w.poly, th.flame[0]); }
      g.restore();
    });
  }

  /** Selo sobre o prédio fechado: há alguém trabalhando, na fila ou esperando você lá dentro. */
  private drawBadge(b: BuildingInst, top: number, now: number, occ: Occupancy): void {
    const visual = occ.by.get(b.id)?.badge ?? null;
    if (!visual) return;
    const th = this.theme; const [px, py] = project(b.ox, top + 0.6, b.oz + b.spec.D / 2);
    const bob = Math.round(Math.sin(now / 300) * RES);
    this.drawIcon(MARK_ROWS[visual], { o: th.outline, c: th.marks[visual], g: th.outline }, px, py - 10 * RES + bob);
  }

  private drawGroundOverlays(now: number, inViewR: (r: [number, number, number, number]) => boolean): void {
    const g = this.g; const th = this.theme;
    if (this.editing) { // grade de lotes livres (só os que estão na tela)
      g.save(); g.globalAlpha = 0.5;
      for (const l of this.town.lots) {
        const p = boxPoly(l.box);
        if (!inViewR([Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))])) continue;
        for (let i = 0; i < 4; i++) this.dashed(p[i], p[(i + 1) % 4], th.teal[1]);
      }
      g.restore();
    }
    const h = this.hover;
    if (h?.kind === 'lot') {
      const l = this.lotAt.get(`${h.i},${h.j}`);
      if (l) { g.save(); g.globalAlpha = 0.22 + 0.08 * Math.sin(now / 260); fillPoly(g, boxPoly(l.box), th.teal[0]); g.restore(); const p = boxPoly(l.box); g.save(); g.globalAlpha = 0.9; for (let i = 0; i < 4; i++) this.dashed(p[i], p[(i + 1) % 4], mix(th.teal[0], '#ffffff', 0.4)); g.restore(); }
    }
    if (h?.kind === 'struct' && this.editing && !this.drag) {
      const box = this.town.buildings.get(h.id)?.lot ?? this.town.areas.get(h.id)?.lot;
      if (box) { g.save(); g.globalAlpha = 0.25; fillPoly(g, boxPoly(box), th.teal[0]); g.restore(); }
    }
  }

  private dashed(a: P2, b: P2, color: string): void {
    const g = this.g; g.fillStyle = color;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
    for (let i = 0; i < n; i += 2) { const t = i / n; g.fillRect(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), RES, RES); }
  }

  private lotShift(b: { i: number; j: number }, to: [number, number]): [number, number] {
    const [dx, dy] = project((to[0] - b.i) * CELL, 0, (to[1] - b.j) * CELL); const [ox, oy] = project(0, 0, 0); return [dx - ox, dy - oy];
  }

  private drawDragGhost(): void {
    const d = this.drag!; const g = this.g; const th = this.theme;
    const t = typeOf(d.kind); if (!t) return;
    const [w, dd] = t.footprint;
    const box = { x0: d.i * CELL + 1, z0: d.j * CELL + 1, x1: (d.i + w) * CELL - 1, z1: (d.j + dd) * CELL - 1 };
    g.save(); g.globalAlpha = 0.35; fillPoly(g, boxPoly(box), d.ok ? th.teal[0] : th.marks.waiting); g.restore();
    const p = boxPoly(box); for (let i = 0; i < 4; i++) this.dashed(p[i], p[(i + 1) % 4], d.ok ? mix(th.teal[0], '#ffffff', 0.5) : th.marks.waiting);
    const b = this.town.buildings.get(d.id);
    if (b) { const art = closedArt(b, th); const [dx, dy] = this.lotShift(b, [d.i, d.j]); g.save(); g.globalAlpha = 0.45; g.drawImage(art.layer.canvas, art.layer.x0 + dx, art.layer.y0 + dy); g.restore(); }
  }

  private drawHoverOverlay(now: number): void {
    const h = this.hover; if (!h || h.kind !== 'band' || this.editing) return;
    const layer = bandHighlight(h.faces, this.theme, `${h.building}|${h.level}|${this.focus?.building === h.building ? this.focus.level : 'c'}|${h.faces[0][0].join(',')}`);
    const g = this.g; g.save(); g.globalAlpha = 0.42 + 0.14 * Math.sin(now / 220); g.drawImage(layer.canvas, layer.x0, layer.y0); g.restore();
  }

  private shadow(fx: number, fy: number): void {
    const g = this.g; g.save(); g.globalAlpha = 0.2; blob(g, fx, fy, 6 * RES, 2 * RES, this.theme.shadow); g.restore();
  }

  private drawAgent(rt: Rt, now: number, register = true, alpha = 1): void {
    const g = this.g; const th = this.theme;
    const anim = this.reduced ? 0 : Math.floor(now / 260) % 2;
    const writeFrame = this.reduced ? 0 : Math.floor(now / WRITE_MS) % 2;
    const atDesk = rt.seated && !rt.mover && rt.visual !== 'idle';
    const L = rt.life; const plan = L.plan;
    let pose: Pose = 'stand'; let facing: Facing = 'front'; let mirror = rt.idleMirror;
    let gesture: Gesture = 'none'; let expr: Expr = this.exprOf(rt); let frame = 0; let bubble: Bubble = null;
    let lift = 0; let grounded = true; let look = rt.look;
    const swimming = this.inWater(rt.pos[0], rt.pos[2]) && !rt.loc.b;
    if (swimming) { facing = rt.facing; mirror = rt.mirror; expr = 'smile'; frame = anim; gesture = rt.mover && Math.floor(rt.walked / 0.5) % 2 ? 'reach' : 'none'; }
    else if (rt.mover) {
      const running = L.mode === 'doing' && !!plan?.fast;
      pose = 'walk'; facing = rt.facing; mirror = rt.mirror; frame = Math.floor(rt.walked / (running ? 0.22 : 0.32)) % 2; expr = running ? 'focused' : 'neutral';
      if (running && frame === 1) lift = RES;
      if (plan?.carry && L.mode === 'going') look = { ...rt.look, item: 'scroll' };
    } else if (rt.react) {
      gesture = rt.react.gesture; expr = rt.react.expr; frame = anim;
      if (rt.react.jump && anim === 1) lift = 5 * RES;
      if (rt.react.gesture === 'worry') bubble = 'drop';
    } else if (atDesk) {
      pose = 'sit'; mirror = true; grounded = false;
      if (rt.visual === 'working') frame = writeFrame;
      if (rt.visual === 'waiting') { gesture = 'worry'; frame = anim; }
    } else if ((L.mode === 'doing' || L.mode === 'waiting') && plan) {
      facing = plan.facing; mirror = plan.mirror; pose = plan.sit ? 'sit' : plan.perch ? 'perch' : 'stand'; expr = plan.expr; grounded = !plan.sit;
      const grp = plan.group ? this.groups.get(plan.group) : undefined;
      if (grp && grp.started && plan.kind !== 'fetch') {
        const turn = Math.floor((now - grp.started) / 1900) % grp.members.length;
        const speaking = grp.members[turn] === rt.a.id; const isFirst = grp.members[0] === rt.a.id; const t = now - grp.started;
        frame = anim;
        if (grp.kind === 'handoff' && t < 3000) { const passed = t >= 1500; gesture = isFirst === passed ? 'receive' : 'offer'; expr = 'smile'; frame = 0; }
        else if (grp.kind === 'debate') { gesture = speaking ? 'angry' : 'none'; expr = speaking ? 'angry' : 'neutral'; bubble = speaking ? 'exclaim' : null; }
        else if (grp.kind === 'meeting') { gesture = speaking ? (turn % 2 ? 'point' : 'talk') : 'none'; expr = speaking ? 'smile' : 'neutral'; bubble = speaking && gesture === 'talk' ? 'talk' : null; }
        else if (grp.kind === 'assembly') {
          const closing = grp.until - now < 2800;
          if (isFirst) { gesture = closing ? 'joy' : Math.floor(t / 1900) % 3 === 2 ? 'point' : 'talk'; expr = 'smile'; bubble = closing ? null : 'talk'; }
          else { gesture = closing ? 'joy' : 'none'; expr = closing ? 'smile' : (hashOf(rt.a.name) & 1 ? 'smile' : 'neutral'); }
        } else if (grp.kind === 'wrestle') { gesture = Math.floor(t / 700 + (isFirst ? 0 : 1)) % 2 ? 'reach' : 'angry'; expr = 'focused'; }
        else { gesture = speaking ? 'talk' : 'none'; expr = 'smile'; bubble = speaking ? 'talk' : null; }
        if (plan.kind === 'desk' && !speaking) frame = writeFrame;
      } else if (plan.kind === 'desk') {
        gesture = plan.gestures[Math.floor((now - L.since) / 2600) % plan.gestures.length];
        frame = gesture === 'none' ? writeFrame : anim;
        if (gesture === 'think') bubble = 'think';
      } else if (L.mode === 'waiting') expr = 'smile';
      else {
        gesture = plan.gestures[Math.floor((now - L.since) / 1700) % plan.gestures.length]; frame = anim;
        if (gesture === 'think' || (plan.bubble === 'talk' && gesture === 'talk')) bubble = plan.bubble;
        if (gesture === 'joy' && anim === 1 && !plan.perch) lift = 3 * RES;
      }
    }
    const s = figureSprite(look, facing, pose, frame, mirror, th, expr, gesture);
    const [fx, fy] = project(rt.pos[0], rt.pos[1], rt.pos[2]);
    const headTop = fy - lift - (pose === 'sit' ? SIT_HEAD : pose === 'perch' ? STAND_HEAD - 5 : STAND_HEAD);
    this.stats.sprites++;
    if (alpha < 1) { g.save(); g.globalAlpha = Math.max(0, alpha); }
    if (swimming) {
      const clip = s.ay - 21; const wy = fy + 2 * RES;
      g.drawImage(s.canvas, 0, 0, s.w, clip, fx - s.ax, wy - clip, s.w, clip);
      if (register) this.drawn.push({ kind: 'agent', id: rt.a.id, x: fx - s.ax, y: wy - clip, s });
      g.fillStyle = th.water[0]; const off = anim ? RES : 0;
      g.fillRect(fx - 9 * RES - off, wy, 4 * RES, 1); g.fillRect(fx + 5 * RES + off, wy, 4 * RES, 1); g.fillRect(fx - 6 * RES, wy + RES, 12 * RES, 1);
      if (register) this.agentsDrawn.push({ id: rt.a.id, fx, fy: wy + 3 * RES, name: rt.a.name, sel: this.selected === rt.a.id });
      if (alpha < 1) g.restore();
      return;
    }
    this.drawFx(rt, fx, fy, now, !!rt.mover);
    if (grounded) this.shadow(fx, fy);
    if (this.selected === rt.a.id && pose !== 'sit') { g.fillStyle = th.marks.select; for (const [dx, dy] of RING) g.fillRect(fx + dx, fy + dy, 1, 1); }
    g.drawImage(s.canvas, fx - s.ax, fy - s.ay - lift);
    if (register) { this.drawn.push({ kind: 'agent', id: rt.a.id, x: fx - s.ax, y: fy - s.ay - lift, s }); this.agentsDrawn.push({ id: rt.a.id, fx, fy: fy + (pose === 'sit' ? -2 * RES : RES), name: rt.a.name, sel: this.selected === rt.a.id }); }
    this.drawPet(rt, fx, fy, now);
    if (rt.visual !== 'idle' && !rt.react) this.drawIcon(MARK_ROWS[rt.visual], { o: th.outline, c: th.marks[rt.visual], g: th.outline }, fx, headTop - 9 * RES);
    else if (bubble === 'drop') this.drawIcon(BUBBLE_ROWS.drop, { o: th.outline, b: '#7fb3d9' }, fx + 6 * RES, headTop + 5 * RES);
    else if (bubble) this.drawIcon(BUBBLE_ROWS[bubble], { o: th.outline, w: '#fbf7ee', d: th.outline, c: th.marks.waiting, g: th.outline }, fx + (bubble === 'exclaim' ? 0 : 5 * RES), headTop - 8 * RES);
    if (alpha < 1) g.restore();
  }

  /** Efeitos de pacote (cosmetics.ts): pixels transparentes sob/ao redor do boneco; sem animação para quem pede menos movimento. */
  private drawFx(rt: Rt, fx: number, fy: number, now: number, moving: boolean): void {
    const list = this.fxOf.get(rt.a.id);
    if (list) paintFx(this.g, list, fx, fy, this.reduced ? 0 : now, moving, !!rt.mirror);
  }

  /** Pet decorativo (cosmetics.ts): não mexe em nada do agente (nem decisão, nem processo); fica ao lado e pula de leve. */
  private drawPet(rt: Rt, fx: number, fy: number, now: number): void {
    const p = this.petOf.get(rt.a.id) ?? this.skinPetOf(rt.a.id);
    if (p) paintPet(this.g, p, fx, fy, this.reduced ? 0 : (Math.floor(now / 400) % 2) * RES);
  }

  private exprOf(rt: Rt): Expr {
    switch (rt.visual) {
      case 'attention': return 'surprised';
      case 'working': return 'focused';
      case 'waiting': return 'worried';
      default: return (hashOf(rt.a.name) & 2) ? 'smile' : 'neutral';
    }
  }

  private drawNpc(now: number): void {
    const n = this.npcSt; const walking = !!n.mover;
    const gesture: Gesture = !walking && n.think && this.lifeOn() ? 'think' : 'none';
    const s = figureSprite(this.npc, walking ? n.facing : 'front', walking ? 'walk' : 'stand', walking ? Math.floor(n.walked / 0.32) % 2 : 0, walking ? n.mirror : false, this.theme, 'smile', gesture);
    const [fx, fy] = project(n.pos[0], n.pos[1], n.pos[2]);
    this.shadow(fx, fy);
    this.g.drawImage(s.canvas, fx - s.ax, fy - s.ay);
    this.drawn.push({ kind: 'agent', id: NPC_ID, x: fx - s.ax, y: fy - s.ay, s });
    this.agentsDrawn.push({ id: NPC_ID, fx, fy: fy + RES, name: this.skin?.data.npc?.name ?? 'Alexandre Magno', sel: false });
    if (gesture === 'think' && Math.floor(now / 1700) % 2 === 0) this.drawIcon(BUBBLE_ROWS.think, { o: this.theme.outline, w: '#fbf7ee', d: this.theme.outline }, fx + 5 * RES, fy - STAND_HEAD - 8 * RES);
  }

  private drawIcon(rows: string[], col: Record<string, string>, cx: number, top: number): void {
    const g = this.g; const w = rows[0].length;
    rows.forEach((row, j) => [...row].forEach((ch, i) => { const c = col[ch]; if (c) { g.fillStyle = c; g.fillRect(cx + (i - w / 2) * RES, top + j * RES, RES, RES); } }));
  }

  /** Nome de cada um, discreto e legível, logo abaixo dos pés. */
  private drawNames(): void {
    if (this.k < 0.5) return;
    const g = this.g; const dpr = this.dpr;
    const size = Math.round((this.k >= 2 ? 11 : 10) * dpr);
    g.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const a of this.agentsDrawn) {
      const [sx, sy] = this.toScreen(a.fx, a.fy);
      if (sx < -60 || sx > this.W + 60 || sy < -20 || sy > this.H + 20) continue;
      const w = g.measureText(a.name).width + 8 * dpr; const h = size + 4 * dpr; const x = Math.round(sx - w / 2); const y = Math.round(sy + 2 * dpr);
      g.globalAlpha = a.sel ? 0.92 : 0.62;
      g.fillStyle = '#16111d'; g.beginPath(); g.roundRect(x, y, w, h, 4 * dpr); g.fill();
      if (a.sel) { g.strokeStyle = '#c9a227'; g.lineWidth = dpr; g.stroke(); }
      g.globalAlpha = a.sel ? 1 : 0.9; g.fillStyle = '#f3ead6'; g.fillText(a.name, sx, y + 2 * dpr);
    }
    g.globalAlpha = 1;
  }

  /**
   * Prédio da Central de Trabalho: a Stoa (o prédio de trabalho de partida) ou, sem ela, o primeiro prédio de trabalho.
   * Não muda a planta nem as mesas: a placa só se apoia no prédio.
   */
  private centralBuilding(): BuildingInst | null {
    let first: BuildingInst | null = null;
    for (const b of this.town.buildings.values()) {
      if (b.kind === 'stoa') return b;
      if (!first && typeOf(b.kind)?.category === 'trabalho') first = b;
    }
    return first;
  }

  /**
   * Placas operacionais, em pixels de tela (texto nítido, como os nomes), apoiadas na Central e na ágora. Forma e
   * texto dizem tudo (nunca só a cor); poucas linhas, nenhuma por tarefa. Fora do editor e com a cidade perto o
   * bastante para ler.
   */
  private drawPlaques(): void {
    this.plaques = [];
    const o = this.ops;
    if (!o || this.editing) return;
    const g = this.g; const dpr = this.dpr; const th = this.theme;
    const size = Math.round(11 * dpr); const pad = 6 * dpr; const lh = size + 6 * dpr;
    g.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'left';
    const ink = th.outline; const paper = th.papyrus[0]; const edge = mix(th.papyrus[1], th.outline, 0.35);
    type Row = { kind: SceneOpsTarget; text: string; pips?: { on: number; total: number } };
    const panel = (rows: Row[], cx: number, bottom: number) => {
      const pipW = 7 * dpr; const pipGap = 3 * dpr;
      const widths = rows.map((row) => g.measureText(row.text).width + (row.pips ? 8 * dpr + row.pips.total * (pipW + pipGap) : 0));
      const w = Math.ceil(Math.max(...widths) + pad * 2); const h = Math.ceil(rows.length * lh + pad);
      const x = Math.round(Math.min(Math.max(cx - w / 2, 4 * dpr), this.W - w - 4 * dpr)); const y = Math.round(Math.max(bottom - h, 56 * dpr)); // abaixo das ferramentas do palco
      g.globalAlpha = 0.96; g.fillStyle = paper; g.beginPath(); g.roundRect(x, y, w, h, 5 * dpr); g.fill();
      g.globalAlpha = 1; g.strokeStyle = edge; g.lineWidth = Math.max(1, dpr); g.stroke();
      // pé da placa: aponta para o prédio
      g.fillStyle = edge; g.fillRect(Math.round(cx - dpr), y + h, Math.max(2, 2 * dpr), 5 * dpr);
      rows.forEach((row, i) => {
        const ry = y + pad / 2 + i * lh; const my = ry + lh / 2;
        if (i > 0) { g.globalAlpha = 0.35; g.fillStyle = edge; g.fillRect(x + pad, ry, w - pad * 2, Math.max(1, dpr)); g.globalAlpha = 1; }
        g.fillStyle = ink; g.fillText(row.text, x + pad, my);
        if (row.pips) {
          let px = x + pad + g.measureText(row.text).width + 8 * dpr;
          for (let p = 0; p < row.pips.total; p++) {
            const on = p < row.pips.on;
            g.fillStyle = on ? th.gold : paper; g.fillRect(Math.round(px), Math.round(my - pipW / 2), pipW, pipW);
            g.strokeStyle = ink; g.lineWidth = Math.max(1, dpr); g.strokeRect(Math.round(px) + 0.5, Math.round(my - pipW / 2) + 0.5, pipW - 1, pipW - 1);
            px += pipW + pipGap;
          }
        }
        this.plaques.push({ kind: row.kind, x, y: ry, w, h: lh });
      });
    };
    const b = this.centralBuilding();
    if (b) {
      const art = closedArt(b, th);
      // sobre o centro da planta, acima do telhado (paredes + telhado) e do sinal de estado do prédio, em qualquer zoom
      const [sx, roofY] = this.toScreen(...project((b.foot.x0 + b.foot.x1) / 2, art.top + 3.4, (b.foot.z0 + b.foot.z1) / 2));
      const [, badgeY] = this.toScreen(...project(b.ox, art.top + 0.6, b.oz + b.spec.D / 2));
      const sy = Math.min(roofY, badgeY - 12 * RES * this.k);
      const pips = o.limit !== null && o.limit <= 8 ? { on: Math.min(o.busy, o.limit), total: o.limit } : undefined;
      const rows: Row[] = [{ kind: 'central', text: o.limit === null ? `Trabalho · ${o.busy} em andamento` : `Trabalho · ${o.busy}/${o.limit}`, pips }];
      if (o.ready || o.blocked) rows.push({ kind: 'espera', text: [o.ready ? `${o.ready} na espera` : '', o.blocked ? `${o.blocked} parado${o.blocked === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') });
      if (o.deliveries) rows.push({ kind: 'entregas', text: `${o.deliveries} entrega${o.deliveries === 1 ? '' : 's'} recente${o.deliveries === 1 ? '' : 's'}` });
      panel(rows, sx, sy - 6 * this.dpr);
    }
    const ag = this.town.areaOf('agora');
    if (ag && o.decisions > 0) {
      const [sx, sy] = this.toScreen(...project((ag.lot.x0 + ag.lot.x1) / 2, 2.2, (ag.lot.z0 + ag.lot.z1) / 2));
      panel([{ kind: 'decisoes', text: `${o.decisions} ${o.decisions === 1 ? 'decisão espera' : 'decisões esperam'} você` }], sx, sy);
    }
  }

  /**
   * Posto de trabalho reservado à nuvem, coberto com lona branca: aparece ao lado da Central enquanto o trabalho na
   * nuvem não existe nesta instalação. É só cenário (não é vaga, não muda a planta nem os lotes).
   */
  private tarpSpot(): { px: number; py: number; box: AABB; rect: [number, number, number, number] } | null {
    if (!this.ops || this.ops.cloud || this.editing) return null;
    const b = this.centralBuilding();
    if (!b) return null;
    // ao longo da lateral do prédio, fora da escada e da porta dela e longe de outro objeto (banco, planta, braseiro)
    const chave = `${b.id}|${b.foot.x1}|${b.foot.z1}|${this.items.length}`;
    if (this.tarpCache?.chave !== chave) this.tarpCache = { chave, spot: tarpPlace(b.spec, b.oz, b.foot, this.items.map((it) => it.box)) };
    const spot = this.tarpCache.spot;
    if (!spot) return null; // nenhum lugar limpo: melhor não desenhar do que sobrepor
    const [x, z] = spot;
    const c = tarpBox(x, z);
    const caixa: AABB = { x0: c.x0, y0: 0, z0: c.z0, x1: c.x1, y1: 1.1, z1: c.z1 };
    const [px, py] = project(x, 0, z);
    const w = TARP_ROWS[0].length * RES; const h = TARP_ROWS.length * RES;
    this.tarpRect = [px - w / 2, py - h, px + w / 2, py];
    return { px, py, box: caixa, rect: this.tarpRect };
  }
  private tarpRect: [number, number, number, number] | null = null;
  private tarpCache: { chave: string; spot: Vec2 | null } | null = null;
  private drawTarp(px: number, py: number): void {
    const th = this.theme;
    this.drawIcon(TARP_ROWS, { o: th.outline, w: '#f4f1ea', s: '#d5cfc2', f: '#bfb8a9', r: '#8a6a50', l: mix(th.outline, '#8a6a50', 0.5) }, px, py - TARP_ROWS.length * RES);
  }

  /** Placa sob o ponteiro (pixels de tela). */
  private plaqueAt(e: { clientX: number; clientY: number }): SceneOpsTarget | null {
    if (!this.plaques.length) return null;
    const rc = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - rc.left) / rc.width) * this.W; const sy = ((e.clientY - rc.top) / rc.height) * this.H;
    return this.plaques.find((p) => sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h)?.kind ?? null;
  }

  // ================================================================ o que está acontecendo (para o clique nas áreas)
  private statusOf(rt: Rt): string {
    if (rt.visual === 'working') return 'trabalhando';
    if (rt.visual === 'attention') return 'na fila';
    if (rt.visual === 'waiting') return 'aguardando você';
    const p = rt.life.plan;
    if (p?.label && (rt.life.mode === 'doing' || rt.life.mode === 'waiting')) return p.label;
    if (p?.area && rt.life.mode === 'going') return `a caminho (${p.area.startsWith('casa') ? 'casa' : p.area})`;
    return 'no trabalho';
  }

  private areaText(hit: AreaHit): string {
    const list = (area: string) => [...this.rts.values()].filter((rt) => rt.life.plan?.area === area && rt.visual === 'idle' && rt.life.mode !== 'home' && rt.life.mode !== 'returning');
    const who = (rts: Rt[]) => (rts.length ? rts.map((rt) => `${rt.a.name} ${this.statusOf(rt)}`).join(' · ') : 'ninguém agora');
    switch (hit.kind) {
      case 'casa': {
        const a = this.town.areaOf('bairro'); const houses = a?.def.houses ?? []; const id = hit.ref ?? 0;
        const res = [...this.rts.values()].filter((rt) => houses.length && rt.house % houses.length === id);
        return res.length ? `Casa ${id + 1} · ${res.map((rt) => `${rt.a.name} ${this.hidden(rt) ? 'dormindo' : this.statusOf(rt)}`).join(' · ')}` : `Casa ${id + 1} · vazia, pronta para novos agentes`;
      }
      case 'termas': return `Termas · ${who(list('termas'))}`;
      case 'ginasio': return `Ginásio · ${who(list('ginasio'))}`;
      case 'agora': return `Ágora · ${who(list('agora'))} · o mural de avisos abre Conexões`;
      case 'teatro': return `Teatro · ${who(list('teatro'))}`;
      default: return '';
    }
  }

  // ================================================================ clique, hover, arrastar e zoom
  private hitAt(wx: number, wy: number): Drawn | null {
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const d = this.drawn[i];
      switch (d.kind) {
        case 'agent': { const b = d.s.box; const lx = wx - d.x; const ly = wy - d.y; if (b && lx >= b[0] - 1 && lx <= b[2] + 1 && ly >= b[1] && ly <= b[3] && spriteHit(d.s, lx, ly)) return d; break; }
        case 'prop': if (spriteHit(d.s, wx - d.x, wy - d.y)) return d; break;
        case 'band': if (d.faces.some((f) => insidePoly(wx, wy, f)) && !(d.exclude && insidePoly(wx, wy, d.exclude))) return d; break;
        case 'floor': case 'objpoly': if (insidePoly(wx, wy, d.poly)) return d; break;
        case 'area': if (insidePoly(wx, wy, d.hit.poly)) return d; break;
      }
    }
    return null;
  }

  private structOf(d: Drawn | null): string | null {
    if (!d) return null;
    if (d.kind === 'band' || d.kind === 'floor' || d.kind === 'objpoly') return d.building;
    if (d.kind === 'prop') return d.building ?? d.area ?? null;
    if (d.kind === 'area') return d.hit.areaId ?? null;
    return null;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [wx, wy] = this.toWorld(e);
    const hit = this.hitAt(wx, wy);
    const onStruct = this.editing && hit?.kind !== 'agent' ? this.structOf(hit) : null;
    this.down = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false, onStruct };
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* ponteiro sem captura (eventos sintéticos) */ }
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.down;
    if (d) {
      const dx = e.clientX - d.x; const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        if (d.onStruct) { // editor: começa a arrastar a estrutura
          const s = this.town.buildings.get(d.onStruct) ?? this.town.areas.get(d.onStruct);
          if (s) { const [wx0, wy0] = this.toWorld({ clientX: d.x, clientY: d.y }); const [gx, gz] = unproject(wx0, wy0, 0); this.drag = { id: s.id, kind: s.kind, gi: Math.floor(gx / CELL) - s.i, gj: Math.floor(gz / CELL) - s.j, i: s.i, j: s.j, ok: true }; }
        }
      }
      if (d.moved) {
        if (this.drag) {
          const [wx, wy] = this.toWorld(e); const [gx, gz] = unproject(wx, wy, 0);
          const i = Math.floor(gx / CELL) - this.drag.gi; const j = Math.floor(gz / CELL) - this.drag.gj;
          if (i !== this.drag.i || j !== this.drag.j) { this.drag.i = i; this.drag.j = j; this.drag.ok = placeError(this.town.placed, this.drag.kind, i, j, this.drag.id) === null; }
          this.canvas.style.cursor = this.drag.ok ? 'grabbing' : 'not-allowed';
        } else {
          this.cx = d.cx - (dx * this.dpr) / this.k; this.cy = d.cy - (dy * this.dpr) / this.k;
          this.tcx = this.cx; this.tcy = this.cy; this.anchor = null; this.userCam = true;
          this.canvas.style.cursor = 'grabbing';
        }
        this.invalidate();
      }
      return;
    }
    const [wx, wy] = this.toWorld(e);
    const hit = this.hitAt(wx, wy);
    let hover: IsoEngine['hover'] = null;
    if (this.editing) { const s = this.structOf(hit); if (s) hover = { kind: 'struct', id: s }; }
    else if (hit?.kind === 'band') hover = { kind: 'band', building: hit.building, level: hit.level, faces: hit.faces };
    else if (hit?.kind === 'area' && hit.hit.kind === 'lote' && hit.hit.lot) hover = { kind: 'lot', i: hit.hit.lot[0], j: hit.hit.lot[1] };
    const same = JSON.stringify(hover) === JSON.stringify(this.hover);
    this.hover = hover;
    if (!this.editing && this.plaqueAt(e)) { this.canvas.style.cursor = 'pointer'; if (!same) this.invalidate(); return; }
    this.canvas.style.cursor = this.editing ? (hover ? 'grab' : 'default') : hit && (hit.kind !== 'area' || hit.hit.kind !== 'agora') && hit.kind !== 'floor' ? 'pointer' : 'grab';
    if (!same) this.invalidate();
  };

  private onLeave = (): void => { if (this.hover) { this.hover = null; this.invalidate(); } };

  private onUp = (e: PointerEvent): void => {
    const d = this.down; this.down = null;
    try { this.canvas.releasePointerCapture?.(e.pointerId); } catch { /* idem */ }
    if (this.drag) {
      const dr = this.drag; this.drag = null;
      const s = this.town.buildings.get(dr.id) ?? this.town.areas.get(dr.id);
      if (s && dr.ok && (dr.i !== s.i || dr.j !== s.j)) { this.pendingMove.set(dr.id, [dr.i, dr.j]); this.cb.onMove(dr.id, dr.i, dr.j); }
      this.canvas.style.cursor = 'grab'; this.invalidate();
      return;
    }
    if (!d || d.moved) { this.canvas.style.cursor = this.editing ? 'default' : 'grab'; return; }
    if (this.mapMode) { const [mx, my] = this.toWorld(e); this.tk = 0.35; this.tcx = mx; this.tcy = my; this.anchor = null; this.userCam = true; this.invalidate(); return; }
    const plaque = this.editing ? null : this.plaqueAt(e);
    if (plaque) { this.cb.onObject(plaque); return; }
    const [wx, wy] = this.toWorld(e);
    const tr = this.tarpRect;
    if (!this.editing && this.ops && !this.ops.cloud && tr && wx >= tr[0] && wx <= tr[2] && wy >= tr[1] && wy <= tr[3]) {
      this.cb.onObject('info', 'Posto reservado para trabalhos na nuvem: coberto com lona, ainda sem uso nesta versão.');
      return;
    }
    const hit = this.hitAt(wx, wy);
    if (this.editing) { const s = this.structOf(hit); this.cb.onStructure(s); return; }
    if (hit?.kind === 'agent') { if (hit.id === NPC_ID) this.cb.onObject('npc'); else this.cb.onSelectAgent(hit.id); return; }
    if (hit?.kind === 'prop' && hit.hit) { this.objectClick(hit.hit); return; }
    if (hit?.kind === 'objpoly') { this.objectClick(hit.obj); return; }
    if (hit?.kind === 'band') { this.setFocus({ building: hit.building, level: hit.level }); this.cb.onStructure(hit.building); return; }
    if (hit?.kind === 'floor' || (hit?.kind === 'prop' && hit.building)) return; // dentro do andar aberto: nada muda
    // fora do prédio: fecha
    if (this.focus) this.setFocus(null);
    if (hit?.kind === 'area') {
      const a = hit.hit;
      if (a.kind === 'lote' && a.lot) { this.cb.onLot(a.lot[0], a.lot[1]); return; }
      if (a.kind === 'conexoes' || a.kind === 'atividade') { this.cb.onObject(a.kind); return; }
      this.cb.onStructure(a.areaId ?? null);
      const text = this.areaText(a); if (text) this.cb.onObject('info', text);
      return;
    }
    if (hit?.kind === 'prop' && hit.area) { const a = this.hitsArea.find((x) => x.areaId === hit.area && x.kind !== 'conexoes' && x.kind !== 'atividade'); this.cb.onStructure(hit.area); if (a) { const text = this.areaText(a); if (text) this.cb.onObject('info', text); } return; }
    this.cb.onStructure(null);
  };

  private objectClick(k: 'board' | 'shelf' | 'conselho'): void { this.cb.onObject(k === 'conselho' ? 'atividade' : k); }

  private onCancel = (): void => { this.down = null; this.drag = null; this.invalidate(); };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    const step = e.ctrlKey ? 40 : 90; // pinça do trackpad chega com ctrlKey e passos pequenos
    if (Math.abs(this.wheelAcc) < step) return;
    const dir = this.wheelAcc < 0 ? 1 : -1; this.wheelAcc = 0;
    let idx = ZOOMS.findIndex((z) => Math.abs(z - this.tk) < 1e-6);
    if (idx < 0) idx = ZOOMS.findIndex((z) => z > this.tk) - (dir > 0 ? 1 : 0);
    const ni = Math.max(0, Math.min(ZOOMS.length - 1, idx + dir));
    if (ZOOMS[ni] === this.tk) return;
    if (ZOOMS[ni] < this.minZoom() - 1e-6) return;
    const r = this.canvas.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * this.W; const sy = ((e.clientY - r.top) / r.height) * this.H;
    const [wx, wy] = [(sx - this.W / 2) / this.k + this.cx, (sy - this.H / 2) / this.k + this.cy];
    this.anchor = { wx, wy, sx, sy }; this.tk = ZOOMS[ni]; this.userCam = true;
    this.invalidate();
  };

  private onDbl = (): void => { this.frameCity(false); };
  private onKey = (e: KeyboardEvent): void => {
    if (this.bg) return; // em outra área do Ergon, o Esc é dela
    if (e.key !== 'Escape' || (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) return;
    if (this.drag) { this.drag = null; this.invalidate(); return; }
    if (this.focus) this.setFocus(null);
  };
  private onLostCtx = (): void => { this.cb.onLost(); };
  private onVis = (): void => { if (document.visibilityState === 'visible') this.invalidate(); };

  /** Ponto do mundo → posição na janela (px CSS), para testes que clicam na cena. */
  debugClient(x: number, y: number, z: number): [number, number] {
    const [px, py] = project(x, y, z); const [sx, sy] = this.toScreen(px, py); const r = this.canvas.getBoundingClientRect();
    return [r.left + (sx / this.W) * r.width, r.top + (sy / this.H) * r.height];
  }
  /** Agente: posição e onde está (testes visuais). */
  debugAgent(name: string) { const rt = [...this.rts.values()].find((r) => r.a.name === name); return rt ? { id: rt.a.id, pos: rt.pos, loc: rt.loc, mode: rt.life.mode } : null; }

  /** Aproxima num ponto do mundo (testes visuais). */
  debugView(k: number, x: number, y: number, z: number): void { const [px, py] = project(x, y, z); this.tk = k; this.tcx = px; this.tcy = py; this.anchor = null; this.userCam = true; this.invalidate(); }
  /** Prédio e origem (testes visuais). */
  debugBuilding(id: string) { const b = this.town.buildings.get(id); return b ? { ox: b.ox, oz: b.oz, base: b.base, floors: b.floors.length } : null; }

  /** Visão atual (para testes visuais e para medir desempenho; não aparece para quem usa). */
  debug() {
    const life: Record<string, number> = {};
    for (const rt of this.rts.values()) {
      const k = rt.life.plan ? `${rt.life.mode}:${rt.life.plan.kind}${rt.life.plan.area ? '@' + rt.life.plan.area : ''}` : rt.life.mode;
      life[k] = (life[k] ?? 0) + 1;
    }
    const s = [...this.frameTimes].sort((a, b) => a - b);
    return {
      k: this.k, cam: [Math.round(this.cx), Math.round(this.cy)], W: this.W, H: this.H, agents: this.rts.size, drawn: this.drawn.length, life,
      groups: [...this.groups.values()].map((g) => `${g.kind}${g.started ? '' : '(indo)'}`), focus: this.focus, economy: this.economy,
      frameMsMedian: s.length ? s[Math.floor(s.length / 2)] : null, lastFrameMs: this.stats.lastFrameMs, sprites: this.stats.sprites, frames: this.stats.frames,
      lots: this.town.lots.length, extent: this.town.extent,
    };
  }
}
