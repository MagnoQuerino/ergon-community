/**
 * Skin da cidade (pacote .ergon do tipo `skin`): 100% estética. Muda a paleta (dia e noite), a arquitetura (telhado,
 * colunas, acabamento das paredes, o que aparece nos telhados), as roupas, espécies e acessórios que o gerador sorteia
 * para os personagens, a decoração que nasce conforme a cidade cresce e até 10 personagens com nome e bio (o
 * personagem da praça conta nesse limite). Nunca muda função, ferramentas, regras, contas ou dados de ninguém.
 *
 * Tudo é PARÂMETRO sobre um vocabulário fechado (as listas abaixo): uma skin nova, ou uma skin maior, é só dado — pesos
 * e partes —, e o desenho de cada parte fica no código da cidade (web/src/iso). Para crescer o vocabulário, acrescente
 * o valor aqui e o desenho lá; as skins existentes continuam valendo.
 *
 * TypeScript puro: o servidor valida com isto, o gerador dos pacotes oficiais monta com isto e a cidade desenha com isto.
 */
import { PERSONALITY, isPersonality } from './personalities.ts';

export const SKIN_FORMAT_VERSION = 1;
export const SKIN_MAX_CHARACTERS = 10;

export const SKIN_SPECIES = ['human', 'elf', 'orc', 'gnome'] as const;
export const SKIN_HAIR = ['short', 'long', 'bun', 'curly', 'bald', 'ponytail', 'cropped', 'mohawk', 'spiky', 'afro'] as const;
export const SKIN_BEARDS = ['none', 'full', 'short'] as const;
export const SKIN_HEADWEAR = ['none', 'wreath', 'fillet', 'petasos', 'helmet', 'beret', 'cap', 'beanie', 'sunhat', 'wizard', 'hood', 'circlet', 'headphones', 'bandana', 'crown', 'visor'] as const;
export const SKIN_FACES = ['none', 'glasses', 'sunglasses', 'goggles', 'mask', 'implant'] as const;
export const SKIN_ITEMS = ['none', 'scroll', 'tablet', 'abacus', 'compass', 'satchel', 'staff', 'spear', 'lamp', 'briefcase', 'laptop', 'coffee', 'sword', 'shield', 'book', 'potion', 'radio', 'binoculars', 'clipboard', 'surfboard', 'icecream', 'coconut', 'cat', 'datapad'] as const;
export const SKIN_TOPS = ['suit', 'jacket', 'shirt', 'tee', 'tank', 'hoodie', 'sweater', 'robe', 'plate', 'leather', 'uniform', 'swim', 'coat', 'tunic'] as const;
export const SKIN_BOTTOMS = ['pants', 'shorts', 'skirt', 'robe', 'trunks'] as const;
export const SKIN_SLEEVES = ['long', 'short', 'none'] as const;
export const SKIN_SHOES = ['shoes', 'boots', 'sneakers', 'sandals', 'bare'] as const;
export const SKIN_DETAILS = ['none', 'tie', 'camo', 'neon', 'stripes', 'belt', 'cape', 'trim', 'dots', 'apron'] as const;
export const SKIN_DECOR = ['cypress', 'olive', 'pine', 'bush', 'rock', 'brazier', 'palm', 'parasol', 'cactus', 'tent', 'crates', 'sandbags', 'tower', 'lamppost', 'neon', 'mushroom', 'bigtree', 'crystal', 'menhir', 'cottage', 'cherry', 'watchtower'] as const;
/** objetos das áreas (praça, termas…) que a skin pode trocar por um da decoração */
export const SKIN_AREA_PROPS = ['olive', 'cypress', 'herm', 'brazier', 'amphora', 'plant'] as const;
export const SKIN_ROOFS = ['keep', 'hip', 'gable', 'parapet', 'flat', 'thatch', 'steep'] as const;
export const SKIN_COLUMNS = ['classic', 'pillar', 'post'] as const;
export const SKIN_TRIMS = ['none', 'timber', 'neon', 'camo', 'stripes', 'glass'] as const;
export const SKIN_ROOFTOP = ['nada', 'antenna', 'satellite', 'chimney', 'flag', 'solar', 'tank', 'sign', 'lights'] as const;
export const SKIN_PETS = ['gato', 'coruja', 'cao', 'tartaruga'] as const;

export type Species = typeof SKIN_SPECIES[number];
export type SkinHair = typeof SKIN_HAIR[number];
export type SkinBeard = typeof SKIN_BEARDS[number];
export type SkinHeadwear = typeof SKIN_HEADWEAR[number];
export type SkinFace = typeof SKIN_FACES[number];
export type SkinItem = typeof SKIN_ITEMS[number];
export type SkinTop = typeof SKIN_TOPS[number];
export type SkinBottom = typeof SKIN_BOTTOMS[number];
export type SkinDecor = typeof SKIN_DECOR[number];
export type SkinAreaProp = typeof SKIN_AREA_PROPS[number];
export type SkinRooftop = typeof SKIN_ROOFTOP[number];
export type Weighted<T> = Array<[T, number]>;

/** 'agente' = a cor de identidade do agente; senão, #rrggbb */
export type ColorRef = string;
export interface SkinKit {
  top: SkinTop; bottom: SkinBottom; sleeves: typeof SKIN_SLEEVES[number]; shoes: typeof SKIN_SHOES[number]; detail: typeof SKIN_DETAILS[number];
  colors: { top: ColorRef; bottom: ColorRef; accent: ColorRef };
}
export interface SkinOutfit { id: string; weight: number; kit: SkinKit }
export interface SkinLook {
  species: Species; skin: number; hair: string; hairStyle: SkinHair; beard: SkinBeard; headwear: SkinHeadwear; face: SkinFace;
  /** id de uma roupa da skin */
  outfit: string; item: SkinItem;
}
/**
 * Personagem da skin: veste um agente da equipe (pelo charKey) com nome, bio e aparência. Função e regras não mudam.
 * `personality` (opcional): o jeito de falar de fábrica do personagem (shared/personalities.ts); os extremos não valem
 * em skin — só a pessoa escolhe um extremo, com o aviso.
 */
export interface SkinCharacter { charKey: string; name: string; bio: string; look: SkinLook; personality?: string }
export interface SkinNpc { name: string; title: string; text: string; note: string; look: SkinLook }

/** Cores-semente: a paleta inteira da cidade é derivada delas (deriveThemeColors); `colors` acerta o que precisar. */
export interface PaletteSeeds {
  ground: string; ground2: string; grass: string | null; road: string; plaza: string;
  wall: string; wallAlt: string; stone: string; marble: string; roof: string; wood: string;
  accent: string; accent2: string; metal: string; foliage: string; foliage2: string;
  sky: string; water: string; window: string; windowDark: string; cloth: string; flame: string;
  outline: string; shadow: string; flowers: string[];
}
export interface PaletteSpec { seeds: PaletteSeeds; colors?: Record<string, unknown> }

export interface SkinData {
  id: string; name: string; tagline: string;
  /** nome (e o tipo, em palavras comuns) de cada estrutura na loja de construção, pelo id do catálogo (shared/city.ts); só aparência */
  structures?: Record<string, { name: string; common?: string }>;
  palette: { dia: PaletteSpec; noite: PaletteSpec };
  arch: {
    roof: typeof SKIN_ROOFS[number]; columns: typeof SKIN_COLUMNS[number]; frieze: boolean; trim: typeof SKIN_TRIMS[number];
    /** janelas a mais por fachada (0..3) e janelas acesas à noite com a cor de destaque (neon) */
    windows: { extra: number; glow: boolean };
    rooftop: Weighted<SkinRooftop>;
  };
  figures: {
    species: Weighted<Species>;
    /** tons de pele por espécie (claro, sombra); a humana usa os do tema quando não vier */
    speciesSkins: Partial<Record<Species, Array<[string, string]>>>;
    hairStyles: Weighted<SkinHair>; beards: Weighted<SkinBeard>; headwear: Weighted<SkinHeadwear>; faces: Weighted<SkinFace>;
    outfits: SkinOutfit[]; items: Weighted<SkinItem>; extraHairs: string[];
  };
  decor: {
    border: Weighted<SkinDecor>; lot: Weighted<SkinDecor | 'nada'>;
    /** objeto que nasce nos cruzamentos de três ruas (no lugar do braseiro) */
    junction: SkinDecor | 'nada';
    swap: Partial<Record<SkinAreaProp, SkinDecor | 'nada'>>;
  };
  /** água fora da cidade (0 = nenhuma; 0.5 = muita: mar e lagoas) e faixa no meio das ruas */
  ground: { water: number; roadLine: boolean };
  /** pet sorteado por agente (chance 0..1) */
  pets: { chance: number; species: Weighted<typeof SKIN_PETS[number]> };
  characters: SkinCharacter[];
  npc: SkinNpc | null;
}

// ---------------------------------------------------------------- cores
const HEX = /^#[0-9a-f]{6}$/i;
function rgb(c: string): [number, number, number] { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hex(a: number[]): string { return '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
export function mixHex(a: string, b: string, t: number): string { const A = rgb(a); const B = rgb(b); return hex(A.map((v, i) => v + (B[i] - v) * t)); }
export function shadeHex(c: string, f: number): string { return f >= 0 ? mixHex(c, '#ffffff', f) : mixHex(c, '#000000', -f); }
const tone = (c: string, o: string): [string, string, string] => [shadeHex(c, 0.16), c, mixHex(c, o, 0.32)];

/**
 * Paleta completa do tema da cidade (as chaves de web/src/iso/theme.ts) a partir das cores-semente. Determinística:
 * a mesma semente dá sempre as mesmas cores; `colors` da skin acerta depois o que precisar.
 */
export function deriveThemeColors(s: PaletteSeeds): Record<string, unknown> {
  const o = s.outline;
  return {
    bg: s.ground, pebble: shadeHex(s.ground, -0.07), grass: s.grass,
    ground: [mixHex(s.ground, s.ground2, 0.55), shadeHex(s.ground, 0.06)],
    road: { fill: s.road, edge: mixHex(s.road, o, 0.2), rut: mixHex(s.road, o, 0.09) },
    flowers: s.flowers, shadow: s.shadow, outline: o,
    stone: tone(s.stone, o), plaza: [s.plaza, shadeHex(s.plaza, -0.04)], plazaGrout: mixHex(s.plaza, o, 0.16),
    marble: tone(s.marble, o), floor: [mixHex(s.plaza, s.wall, 0.3), mixHex(s.plaza, s.wall, 0.42)], grout: mixHex(s.plaza, o, 0.24),
    wallBack: s.wall, wallSide: mixHex(s.wall, o, 0.09), dado: mixHex(s.accent2, o, 0.2), trim: s.metal,
    wood: tone(s.wood, o), woodDark: tone(mixHex(s.wood, o, 0.35), o),
    papyrus: [s.cloth, mixHex(s.cloth, o, 0.16)],
    bronze: tone(s.metal, o), gold: shadeHex(s.metal, 0.12),
    teal: [s.accent, mixHex(s.accent, o, 0.22)],
    carpet: { field: s.accent2, border: s.metal, inner: s.accent },
    carpet2: { field: mixHex(s.accent2, s.foliage2, 0.5), border: s.metal, inner: shadeHex(s.metal, 0.12) },
    planks: [s.wood, mixHex(s.wood, o, 0.07)],
    sky: s.sky, water: tone(s.water, o), sand: [mixHex(s.ground, '#ffffff', 0.18), mixHex(s.ground, s.ground2, 0.3)],
    earth: mixHex(s.ground, o, 0.12), banner: [s.accent2, mixHex(s.accent2, o, 0.22)],
    roof: tone(s.roof, o), houseWall: tone(s.wallAlt, o), window: s.window, windowDark: s.windowDark,
    cypress: [s.foliage2, mixHex(s.foliage2, o, 0.25)], olive: [s.foliage, mixHex(s.foliage, o, 0.2)],
    terracotta: tone(mixHex(s.roof, s.accent2, 0.3), o), flame: [s.flame, mixHex(s.flame, s.roof, 0.5)],
    chiton: [s.cloth, mixHex(s.cloth, o, 0.18)], sandal: mixHex(s.wood, o, 0.4),
  };
}

// ---------------------------------------------------------------- validação (lista do que é permitido)
const has = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === 'string' && (list as readonly string[]).includes(v);
const ACTIVE = /<|>|javascript:|on\w+=/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;

function only(o: unknown, keys: string[], p: string, e: string[]): o is Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) { e.push(`${p}: objeto obrigatório`); return false; }
  for (const k of Object.keys(o)) if (!keys.includes(k)) e.push(`${p}: campo ${k} não permitido`);
  return true;
}
function text(v: unknown, max: number, p: string, e: string[], min = 1) {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) e.push(`${p}: texto de ${min} a ${max} caracteres`);
  else if (ACTIVE.test(v)) e.push(`${p}: texto com conteúdo ativo`);
}
function color(v: unknown, p: string, e: string[], agent = false) { if (!(typeof v === 'string' && (HEX.test(v) || (agent && v === 'agente')))) e.push(`${p}: cor inválida`); }
function weighted(v: unknown, ok: (x: unknown) => boolean, p: string, e: string[], max = 30) {
  if (!Array.isArray(v) || !v.length || v.length > max) return void e.push(`${p}: lista de 1 a ${max} [valor, peso]`);
  v.forEach((x, i) => { if (!Array.isArray(x) || x.length !== 2 || !ok(x[0]) || typeof x[1] !== 'number' || !(x[1] > 0) || x[1] > 1000) e.push(`${p}[${i}]: [valor, peso] inválido`); });
}
/** valor de cor do tema: #hex, lista de #hex (tons) ou lista de pares, ou objeto de #hex */
function themeValue(v: unknown, p: string, e: string[]) {
  if (typeof v === 'string') return void color(v, p, e);
  if (v === null) return;
  if (Array.isArray(v)) { if (!v.length || v.length > 8) e.push(`${p}: 1 a 8 cores`); v.forEach((x, i) => (Array.isArray(x) ? (x.length === 2 ? x.forEach((y, j) => color(y, `${p}[${i}][${j}]`, e)) : e.push(`${p}[${i}]: par de cores`)) : color(x, `${p}[${i}]`, e))); return; }
  if (v && typeof v === 'object') { const ks = Object.keys(v); if (!ks.length || ks.length > 8) e.push(`${p}: 1 a 8 cores`); for (const [k, x] of Object.entries(v)) { if (!/^[a-zA-Z][a-zA-Z0-9]{0,20}$/.test(k)) e.push(`${p}: chave ${k}`); color(x, `${p}.${k}`, e); } return; }
  e.push(`${p}: valor inválido`);
}
const SEED_KEYS = ['ground', 'ground2', 'grass', 'road', 'plaza', 'wall', 'wallAlt', 'stone', 'marble', 'roof', 'wood', 'accent', 'accent2', 'metal', 'foliage', 'foliage2', 'sky', 'water', 'window', 'windowDark', 'cloth', 'flame', 'outline', 'shadow', 'flowers'];
function palette(v: unknown, p: string, e: string[]) {
  if (!only(v, ['seeds', 'colors'], p, e)) return;
  const s = v.seeds;
  if (only(s, SEED_KEYS, `${p}.seeds`, e)) {
    for (const k of SEED_KEYS) {
      if (k === 'flowers') { if (!Array.isArray(s.flowers) || s.flowers.length > 6) e.push(`${p}.seeds.flowers: até 6 cores`); else s.flowers.forEach((x, i) => color(x, `${p}.seeds.flowers[${i}]`, e)); }
      else if (k === 'grass' && s.grass === null) continue;
      else color(s[k], `${p}.seeds.${k}`, e);
    }
  }
  if (v.colors !== undefined) {
    if (!v.colors || typeof v.colors !== 'object' || Array.isArray(v.colors)) e.push(`${p}.colors: objeto`);
    else { const ks = Object.keys(v.colors); if (ks.length > 60) e.push(`${p}.colors: até 60 chaves`); for (const k of ks) { if (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(k)) e.push(`${p}.colors: chave ${k}`); else themeValue((v.colors as Record<string, unknown>)[k], `${p}.colors.${k}`, e); } }
  }
}
function look(v: unknown, outfits: Set<string>, p: string, e: string[]) {
  if (!only(v, ['species', 'skin', 'hair', 'hairStyle', 'beard', 'headwear', 'face', 'outfit', 'item'], p, e)) return;
  if (!has(SKIN_SPECIES, v.species)) e.push(`${p}.species`);
  if (!Number.isInteger(v.skin) || (v.skin as number) < 0 || (v.skin as number) > 7) e.push(`${p}.skin: 0 a 7`);
  color(v.hair, `${p}.hair`, e);
  if (!has(SKIN_HAIR, v.hairStyle)) e.push(`${p}.hairStyle`);
  if (!has(SKIN_BEARDS, v.beard)) e.push(`${p}.beard`);
  if (!has(SKIN_HEADWEAR, v.headwear)) e.push(`${p}.headwear`);
  if (!has(SKIN_FACES, v.face)) e.push(`${p}.face`);
  if (typeof v.outfit !== 'string' || !outfits.has(v.outfit)) e.push(`${p}.outfit: roupa que não existe na skin`);
  if (!has(SKIN_ITEMS, v.item)) e.push(`${p}.item`);
}

export function validateSkin(input: unknown): { ok: true; skin: SkinData } | { ok: false; errors: string[] } {
  const e: string[] = [];
  let size = 0;
  try { size = new TextEncoder().encode(JSON.stringify(input) ?? '').length; } catch { return { ok: false, errors: ['skin ilegível'] }; }
  if (size > 200_000) return { ok: false, errors: ['skin grande demais'] };
  const d = input as Record<string, unknown>;
  if (!only(d, ['id', 'name', 'tagline', 'structures', 'palette', 'arch', 'figures', 'decor', 'ground', 'pets', 'characters', 'npc'], 'skin', e)) return { ok: false, errors: e };
  if (d.structures !== undefined) {
    const st = d.structures as Record<string, unknown>;
    if (!st || typeof st !== 'object' || Array.isArray(st) || Object.keys(st).length > 40) e.push('skin.structures: até 40 estruturas');
    else for (const [k, v] of Object.entries(st)) {
      if (!SLUG.test(k)) { e.push(`skin.structures.${k}: id do catálogo`); continue; }
      if (!only(v, ['name', 'common'], `skin.structures.${k}`, e)) continue;
      const o = v as Record<string, unknown>;
      text(o.name, 40, `skin.structures.${k}.name`, e);
      if (o.common !== undefined) text(o.common, 40, `skin.structures.${k}.common`, e);
    }
  }
  if (typeof d.id !== 'string' || !SLUG.test(d.id)) e.push('skin.id: minúsculas, números e hífen');
  text(d.name, 60, 'skin.name', e); text(d.tagline, 200, 'skin.tagline', e);
  if (only(d.palette, ['dia', 'noite'], 'skin.palette', e)) { palette(d.palette.dia, 'skin.palette.dia', e); palette(d.palette.noite, 'skin.palette.noite', e); }
  const a = d.arch;
  if (only(a, ['roof', 'columns', 'frieze', 'trim', 'windows', 'rooftop'], 'skin.arch', e)) {
    if (!has(SKIN_ROOFS, a.roof)) e.push('skin.arch.roof');
    if (!has(SKIN_COLUMNS, a.columns)) e.push('skin.arch.columns');
    if (typeof a.frieze !== 'boolean') e.push('skin.arch.frieze');
    if (!has(SKIN_TRIMS, a.trim)) e.push('skin.arch.trim');
    if (only(a.windows, ['extra', 'glow'], 'skin.arch.windows', e)) { if (!Number.isInteger(a.windows.extra) || (a.windows.extra as number) < 0 || (a.windows.extra as number) > 3) e.push('skin.arch.windows.extra: 0 a 3'); if (typeof a.windows.glow !== 'boolean') e.push('skin.arch.windows.glow'); }
    weighted(a.rooftop, (x) => has(SKIN_ROOFTOP, x), 'skin.arch.rooftop', e);
  }
  const outfits = new Set<string>();
  const f = d.figures;
  if (only(f, ['species', 'speciesSkins', 'hairStyles', 'beards', 'headwear', 'faces', 'outfits', 'items', 'extraHairs'], 'skin.figures', e)) {
    weighted(f.species, (x) => has(SKIN_SPECIES, x), 'skin.figures.species', e);
    if (only(f.speciesSkins, [...SKIN_SPECIES], 'skin.figures.speciesSkins', e)) for (const [k, v] of Object.entries(f.speciesSkins)) {
      if (!Array.isArray(v) || !v.length || v.length > 8) e.push(`skin.figures.speciesSkins.${k}: 1 a 8 pares`);
      else v.forEach((x, i) => (Array.isArray(x) && x.length === 2 ? x.forEach((y, j) => color(y, `skin.figures.speciesSkins.${k}[${i}][${j}]`, e)) : e.push(`skin.figures.speciesSkins.${k}[${i}]: par`)));
    }
    weighted(f.hairStyles, (x) => has(SKIN_HAIR, x), 'skin.figures.hairStyles', e);
    weighted(f.beards, (x) => has(SKIN_BEARDS, x), 'skin.figures.beards', e);
    weighted(f.headwear, (x) => has(SKIN_HEADWEAR, x), 'skin.figures.headwear', e);
    weighted(f.faces, (x) => has(SKIN_FACES, x), 'skin.figures.faces', e);
    weighted(f.items, (x) => has(SKIN_ITEMS, x), 'skin.figures.items', e);
    if (!Array.isArray(f.extraHairs) || f.extraHairs.length > 8) e.push('skin.figures.extraHairs: até 8'); else f.extraHairs.forEach((x, i) => color(x, `skin.figures.extraHairs[${i}]`, e));
    if (!Array.isArray(f.outfits) || !f.outfits.length || f.outfits.length > 24) e.push('skin.figures.outfits: 1 a 24');
    else f.outfits.forEach((o, i) => {
      const p = `skin.figures.outfits[${i}]`;
      if (!only(o, ['id', 'weight', 'kit'], p, e)) return;
      if (typeof o.id !== 'string' || !SLUG.test(o.id)) e.push(`${p}.id`); else if (outfits.has(o.id)) e.push(`${p}.id repetido`); else outfits.add(o.id);
      if (typeof o.weight !== 'number' || !(o.weight >= 0) || o.weight > 1000) e.push(`${p}.weight`);
      const k = o.kit;
      if (!only(k, ['top', 'bottom', 'sleeves', 'shoes', 'detail', 'colors'], `${p}.kit`, e)) return;
      if (!has(SKIN_TOPS, k.top)) e.push(`${p}.kit.top`); if (!has(SKIN_BOTTOMS, k.bottom)) e.push(`${p}.kit.bottom`);
      if (!has(SKIN_SLEEVES, k.sleeves)) e.push(`${p}.kit.sleeves`); if (!has(SKIN_SHOES, k.shoes)) e.push(`${p}.kit.shoes`); if (!has(SKIN_DETAILS, k.detail)) e.push(`${p}.kit.detail`);
      if (only(k.colors, ['top', 'bottom', 'accent'], `${p}.kit.colors`, e)) for (const c of ['top', 'bottom', 'accent']) color(k.colors[c], `${p}.kit.colors.${c}`, e, true);
    });
    if (Array.isArray(f.outfits) && !f.outfits.some((o: { weight?: number }) => (o?.weight ?? 0) > 0)) e.push('skin.figures.outfits: ao menos uma roupa sorteável (peso > 0)');
  }
  const dc = d.decor;
  if (only(dc, ['border', 'lot', 'junction', 'swap'], 'skin.decor', e)) {
    weighted(dc.border, (x) => has(SKIN_DECOR, x), 'skin.decor.border', e);
    weighted(dc.lot, (x) => x === 'nada' || has(SKIN_DECOR, x), 'skin.decor.lot', e);
    if (!(dc.junction === 'nada' || has(SKIN_DECOR, dc.junction))) e.push('skin.decor.junction');
    if (only(dc.swap, [...SKIN_AREA_PROPS], 'skin.decor.swap', e)) for (const [k, v] of Object.entries(dc.swap)) if (!(v === 'nada' || has(SKIN_DECOR, v))) e.push(`skin.decor.swap.${k}`);
  }
  if (only(d.ground, ['water', 'roadLine'], 'skin.ground', e)) {
    if (typeof d.ground.water !== 'number' || d.ground.water < 0 || d.ground.water > 0.6) e.push('skin.ground.water: 0 a 0.6');
    if (typeof d.ground.roadLine !== 'boolean') e.push('skin.ground.roadLine');
  }
  if (only(d.pets, ['chance', 'species'], 'skin.pets', e)) {
    if (typeof d.pets.chance !== 'number' || d.pets.chance < 0 || d.pets.chance > 1) e.push('skin.pets.chance: 0 a 1');
    weighted(d.pets.species, (x) => has(SKIN_PETS, x), 'skin.pets.species', e);
  }
  const chars = Array.isArray(d.characters) ? d.characters : null;
  if (!chars) e.push('skin.characters: lista');
  const total = (chars?.length ?? 0) + (d.npc ? 1 : 0);
  if (total > SKIN_MAX_CHARACTERS) e.push(`skin: até ${SKIN_MAX_CHARACTERS} personagens (contando o da praça)`);
  const keys = new Set<string>(); const names = new Set<string>();
  chars?.forEach((c, i) => {
    const p = `skin.characters[${i}]`;
    if (!only(c, ['charKey', 'name', 'bio', 'look', 'personality'], p, e)) return;
    if (c.personality !== undefined && (!isPersonality(c.personality) || PERSONALITY[c.personality].extreme)) e.push(`${p}.personality`);
    if (typeof c.charKey !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(c.charKey)) e.push(`${p}.charKey`); else if (keys.has(c.charKey)) e.push(`${p}.charKey repetido`); else keys.add(c.charKey);
    text(c.name, 40, `${p}.name`, e); text(c.bio, 300, `${p}.bio`, e);
    if (typeof c.name === 'string') { const n = c.name.trim().toLowerCase(); if (names.has(n)) e.push(`${p}.name repetido`); names.add(n); }
    look(c.look, outfits, `${p}.look`, e);
  });
  if (d.npc !== null) {
    const n = d.npc;
    if (only(n, ['name', 'title', 'text', 'note', 'look'], 'skin.npc', e)) { text(n.name, 40, 'skin.npc.name', e); text(n.title, 80, 'skin.npc.title', e); text(n.text, 400, 'skin.npc.text', e); text(n.note, 160, 'skin.npc.note', e); look(n.look, outfits, 'skin.npc.look', e); }
  }
  return e.length ? { ok: false, errors: e } : { ok: true, skin: d as unknown as SkinData };
}

// ---------------------------------------------------------------- sorteio (o mesmo para servidor, gerador e cidade)
export function skinRng(seed: number): () => number { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
export function pickWeighted<T>(r: () => number, list: Weighted<T>): T {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of list) { if ((x -= w) < 0) return v; }
  return list[list.length - 1][0];
}
export function hashText(s: string): number { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Aparência sorteada da skin para um agente (sem personagem próprio), estável pela semente. */
export function rollSkinLook(skin: SkinData, seed: number): SkinLook {
  const r = skinRng(seed ^ 0x5f3759df);
  const f = skin.figures;
  const species = pickWeighted(r, f.species);
  const outfits = f.outfits.filter((o) => o.weight > 0);
  const outfit = pickWeighted(r, outfits.map((o) => [o.id, o.weight] as [string, number]));
  let beard = pickWeighted(r, f.beards);
  const hairStyle = pickWeighted(r, f.hairStyles);
  let headwear = pickWeighted(r, f.headwear);
  if (hairStyle === 'mohawk' && headwear !== 'none' && headwear !== 'visor' && headwear !== 'headphones') headwear = 'none';
  if (species === 'elf' && beard === 'full' && r() < 0.8) beard = 'none';
  const hairs = f.extraHairs.length ? f.extraHairs : ['#2a1e19'];
  return { species, skin: Math.floor(r() * 4), hair: hairs[Math.floor(r() * hairs.length)], hairStyle, beard, headwear, face: pickWeighted(r, f.faces), outfit, item: pickWeighted(r, f.items) };
}
