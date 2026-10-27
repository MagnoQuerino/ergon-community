/**
 * Pacote gráfico: o que o gerador aleatório pode combinar. Os bonecos e os elementos do mapa nascem só das partes do
 * pacote — o padrão é a Grécia Clássica (cabelos, barbas, cobertura de cabeça, roupas e objetos da época; árvores,
 * pedras e ornamentos da paisagem mediterrânea). Um tema novo (outra época, um livro) é outro pacote: as mesmas
 * funções, outras partes. As cores continuam no tema (theme.ts); aqui ficam as formas e as chances.
 *
 * TypeScript puro e determinístico: a mesma semente dá sempre o mesmo boneco (servidor guarda só a semente).
 */
export type HairStyle = 'short' | 'long' | 'bun' | 'curly' | 'bald' | 'ponytail' | 'cropped';
export type Beard = 'none' | 'full' | 'short';
export type Headwear = 'none' | 'wreath' | 'fillet' | 'petasos';
export type Outfit = 'chiton' | 'exomis' | 'peplos';
export type Item = 'scroll' | 'tablet' | 'abacus' | 'compass' | 'satchel' | 'staff' | 'spear' | 'lamp' | 'none';
export type DecorKind = 'cypress' | 'olive' | 'pine' | 'bush' | 'rock' | 'brazier';

/** Escolha ponderada: [valor, peso]. */
export type Weighted<T> = Array<[T, number]>;

export interface GraphicPack {
  id: string;
  name: string;
  figure: {
    hairStyles: Weighted<HairStyle>;
    beards: Weighted<Beard>;
    headwear: Weighted<Headwear>;
    outfits: Weighted<Outfit>;
    items: Weighted<Item>;
    /** chance de barra decorada (meandro) na barra da roupa */
    hem: number;
    /** cores de cabelo além das do tema (ruivo, louro escuro…) */
    extraHairs: string[];
  };
  /** paisagem que nasce sozinha conforme o mapa cresce (borda da cidade e lotes livres) */
  decor: { border: Weighted<DecorKind>; lot: Weighted<DecorKind | 'nada'> };
}

export const GRECIA_CLASSICA: GraphicPack = {
  id: 'grecia-classica',
  name: 'Grécia Clássica',
  figure: {
    hairStyles: [['short', 5], ['curly', 4], ['long', 3], ['bun', 3], ['ponytail', 2], ['cropped', 2], ['bald', 1]],
    beards: [['none', 5], ['full', 3], ['short', 2]],
    headwear: [['none', 12], ['fillet', 3], ['wreath', 2], ['petasos', 2]],
    outfits: [['chiton', 5], ['exomis', 2], ['peplos', 2]],
    items: [['scroll', 4], ['tablet', 3], ['satchel', 2], ['compass', 1], ['abacus', 1], ['staff', 1], ['lamp', 1], ['none', 3]],
    hem: 0.35,
    extraHairs: ['#7a3b23', '#a8783f', '#3a2a22'],
  },
  decor: {
    border: [['cypress', 6], ['olive', 4], ['pine', 2], ['bush', 2], ['rock', 1]],
    lot: [['nada', 18], ['rock', 3], ['bush', 2], ['olive', 1], ['pine', 1]],
  },
};

/** Gerador pseudoaleatório pequeno e determinístico (o mesmo do resto da cidade). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Mistura dois números numa semente (posição de um lote, semente do agente + parte). */
export function seedOf(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; }
  return h >>> 0;
}

export function pick<T>(r: () => number, list: Weighted<T>): T {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of list) { if ((x -= w) < 0) return v; }
  return list[list.length - 1][0];
}

/** As partes de um boneco sorteado (as cores de pele e cabelo são índices no tema; a roupa usa a cor do agente). */
export interface FigureParts {
  skin: number; hair: number; extraHair: string | null; hairStyle: HairStyle; beard: Beard; headwear: Headwear;
  outfit: Outfit; item: Item; hem: boolean;
}

/**
 * Sorteia um boneco do pacote. Combinações que a época torna estranhas ficam raras (barba com peplos; chapéu de
 * viagem com coque alto), não proibidas.
 */
export function rollFigure(seed: number, skins: number, hairs: number, pack: GraphicPack = GRECIA_CLASSICA): FigureParts {
  const r = rng(seedOf(seed, 7));
  const f = pack.figure;
  const outfit = pick(r, f.outfits);
  let beard = pick(r, f.beards);
  if (outfit === 'peplos' && beard !== 'none' && r() < 0.85) beard = 'none';
  let hairStyle = pick(r, f.hairStyles);
  let headwear = pick(r, f.headwear);
  if (headwear === 'petasos' && hairStyle === 'bun') hairStyle = 'short';
  if (hairStyle === 'bald' && headwear === 'fillet') headwear = 'none';
  const extra = r() < 0.12 && f.extraHairs.length ? f.extraHairs[Math.floor(r() * f.extraHairs.length)] : null;
  return {
    skin: Math.floor(r() * skins), hair: Math.floor(r() * hairs), extraHair: extra, hairStyle, beard, headwear, outfit,
    item: pick(r, f.items), hem: r() < f.hem,
  };
}

/** Semente nova para "Redefinir" (31 bits, nunca zero). */
export function newSeed(): number {
  const a = new Uint32Array(1);
  try { crypto.getRandomValues(a); } catch { a[0] = Math.floor(Math.random() * 2 ** 31); }
  return (a[0] % 2147483646) + 1;
}
