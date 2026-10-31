/**
 * Cidade em grade (plano hipodâmico): lotes quadrados separados por ruas, catálogo de estruturas e regras
 * de ocupação. TypeScript puro, sem dependências, usado pelo servidor (fonte da verdade: valida onde cada
 * estrutura fica) e pelo navegador (desenho, loja e editor de mapa).
 *
 * - Um lote tem CELL × CELL unidades do mundo; as ruas ocupam STREET unidades entre lotes vizinhos.
 * - Toda estrutura ocupa um retângulo de lotes (pegada). Prédios de trabalho têm andares e vagas;
 *   praças e áreas de lazer (ágora, teatro, termas, ginásio) e o bairro de moradias não têm vagas.
 * - O mapa não tem limite: a área de lotes cresce um anel por vez sempre que 80% dos lotes estão ocupados.
 * - Mods: um tipo novo é um objeto StructureType (dados) mais a arte do estilo `style` no navegador.
 */

export const CELL = 8;
export const STREET = 2;
/** A partir desta ocupação, a cidade abre mais um anel de lotes livres. */
export const GROW_AT = 0.8;

export type Category = 'trabalho' | 'praca' | 'lazer' | 'moradia';
export type Size = 'pequena' | 'media' | 'grande';

export interface StructureType {
  id: string;
  /** nome no contexto da Grécia antiga */
  name: string;
  /** equivalente numa cidade de hoje (ajuda quem não conhece o termo) */
  common: string;
  category: Category;
  size: Size;
  /** pegada em lotes: [largura em x, profundidade em z] */
  footprint: [number, number];
  floors: { initial: number; max: number };
  slotsPerFloor: number;
  /** uma por cidade (ágora, teatro…) */
  unique: boolean;
  /** aparece na loja de estruturas */
  store: boolean;
  /** estilo de arte (o navegador desenha; um tipo de mod sem arte própria usa o estilo genérico) */
  style: string;
  description: string;
}

export const CATALOG: StructureType[] = [
  {
    id: 'stoa', name: 'Stoa', common: 'prédio de escritórios', category: 'trabalho', size: 'grande', footprint: [3, 2],
    floors: { initial: 2, max: 4 }, slotsPerFloor: 6, unique: false, store: true, style: 'stoa',
    description: 'Colunata clássica com salão de trabalho, biblioteca e sala do conselho. Uma ordem de colunas por andar.',
  },
  {
    id: 'oikos', name: 'Oikos', common: 'casa', category: 'trabalho', size: 'pequena', footprint: [1, 1],
    floors: { initial: 1, max: 2 }, slotsPerFloor: 2, unique: false, store: true, style: 'oikos',
    description: 'Casa de reboco caiado e telhado de terracota. Pequena e tranquila: duas mesas por andar.',
  },
  {
    id: 'ergasterion', name: 'Ergastérion', common: 'oficina / ateliê', category: 'trabalho', size: 'pequena', footprint: [1, 1],
    floors: { initial: 1, max: 2 }, slotsPerFloor: 2, unique: false, store: true, style: 'ergasterion',
    description: 'Oficina de pedra e madeira com toldo na porta e bancada de trabalho.',
  },
  {
    id: 'pharmakopoleion', name: 'Pharmakopōleion', common: 'farmácia / botica', category: 'trabalho', size: 'pequena', footprint: [1, 1],
    floors: { initial: 1, max: 2 }, slotsPerFloor: 2, unique: false, store: true, style: 'pharmakopoleion',
    description: 'Botica caiada com faixa verde, prateleiras de jarros e o bastão de Asclépio na fachada.',
  },
  {
    id: 'didaskaleion', name: 'Didaskaleion', common: 'escola', category: 'trabalho', size: 'media', footprint: [2, 1],
    floors: { initial: 1, max: 3 }, slotsPerFloor: 4, unique: false, store: true, style: 'didaskaleion',
    description: 'Escola com pórtico jônico e frontão. Salas de leitura com bancos e tabuletas.',
  },
  {
    id: 'oikia', name: 'Oikia megalē', common: 'casa grande', category: 'trabalho', size: 'media', footprint: [2, 1],
    floors: { initial: 1, max: 2 }, slotsPerFloor: 4, unique: false, store: true, style: 'oikia',
    description: 'Casa senhorial ocre com sacada de madeira, telhado de quatro águas e pátio de entrada.',
  },
  {
    id: 'emporion', name: 'Empórion', common: 'prédio comercial', category: 'trabalho', size: 'grande', footprint: [2, 2],
    floors: { initial: 2, max: 3 }, slotsPerFloor: 6, unique: false, store: true, style: 'emporion',
    description: 'Casa de comércio com arcada, toldos coloridos e terraço. Balcões no térreo, escritórios em cima.',
  },
  {
    id: 'bouleuterion', name: 'Bouleutḗrion', common: 'câmara / sede', category: 'trabalho', size: 'grande', footprint: [2, 2],
    floors: { initial: 1, max: 2 }, slotsPerFloor: 8, unique: false, store: true, style: 'bouleuterion',
    description: 'Sede em forma de templo, colunas dóricas em volta e frontão. Mesa longa do conselho.',
  },
  // áreas da cidade: únicas, sem vagas; podem ser movidas no editor do mapa
  {
    id: 'agora', name: 'Ágora', common: 'praça central', category: 'praca', size: 'grande', footprint: [2, 2],
    floors: { initial: 0, max: 0 }, slotsPerFloor: 0, unique: true, store: false, style: 'agora',
    description: 'Praça com fonte e o mural de avisos (abre Conexões).',
  },
  {
    id: 'teatro', name: 'Teatro', common: 'anfiteatro', category: 'lazer', size: 'grande', footprint: [2, 2],
    floors: { initial: 0, max: 0 }, slotsPerFloor: 0, unique: true, store: false, style: 'teatro',
    description: 'Arquibancada em semicírculo: assembleias da equipe (abre Atividade).',
  },
  {
    id: 'termas', name: 'Termas', common: 'piscina', category: 'lazer', size: 'media', footprint: [2, 1],
    floors: { initial: 0, max: 0 }, slotsPerFloor: 0, unique: true, store: false, style: 'termas',
    description: 'Piscina com raias e espreguiçadeiras.',
  },
  {
    id: 'ginasio', name: 'Ginásio', common: 'centro esportivo', category: 'lazer', size: 'grande', footprint: [2, 2],
    floors: { initial: 0, max: 0 }, slotsPerFloor: 0, unique: true, store: false, style: 'ginasio',
    description: 'Pista de corrida, palestra de luta e marca do arremesso de disco.',
  },
  {
    id: 'bairro', name: 'Bairro', common: 'moradias', category: 'moradia', size: 'grande', footprint: [2, 2],
    floors: { initial: 0, max: 0 }, slotsPerFloor: 0, unique: true, store: false, style: 'bairro',
    description: 'Casas onde a equipe descansa e dorme (dois por casa).',
  },
];

export function typeOf(id: string): StructureType | undefined { return CATALOG.find((t) => t.id === id); }

/** Estrutura posicionada: canto (menor i, menor j) da pegada. */
export interface Placed { id: string; kind: string; i: number; j: number }
export interface Extent { i0: number; j0: number; i1: number; j1: number } // lotes [i0, i1) × [j0, j1)

/** Área de lotes inicial (7 × 6) e posições da cidade de partida. */
export const BASE_EXTENT: Extent = { i0: 0, j0: 0, i1: 7, j1: 6 };
export const DEFAULT_LOTS: Record<string, [number, number]> = {
  stoa: [2, 1], ginasio: [0, 1], teatro: [5, 1], agora: [2, 3], termas: [4, 3], bairro: [0, 3],
};

export function footprintOf(kind: string): [number, number] { return typeOf(kind)?.footprint ?? [1, 1]; }

/** Retângulo de lotes ocupado. */
export function cellsOf(p: Placed): Extent {
  const [w, d] = footprintOf(p.kind);
  return { i0: p.i, j0: p.j, i1: p.i + w, j1: p.j + d };
}

/** Caixa no mundo (x, z) da área útil de uma pegada, sem as ruas em volta. */
export function lotBox(i: number, j: number, w: number, d: number): { x0: number; z0: number; x1: number; z1: number } {
  const m = STREET / 2;
  return { x0: i * CELL + m, z0: j * CELL + m, x1: (i + w) * CELL - m, z1: (j + d) * CELL - m };
}

const overlaps = (a: Extent, b: Extent) => a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1;
const area = (e: Extent) => (e.i1 - e.i0) * (e.j1 - e.j0);

/**
 * Área de lotes da cidade: a inicial, ampliada para conter todas as estruturas e, enquanto 80% ou mais dos
 * lotes estiverem ocupados, mais um anel em volta. Determinística: servidor e navegador chegam ao mesmo mapa.
 */
export function cityExtent(placed: Placed[]): Extent {
  const e: Extent = { ...BASE_EXTENT };
  for (const p of placed) {
    const c = cellsOf(p);
    e.i0 = Math.min(e.i0, c.i0); e.j0 = Math.min(e.j0, c.j0); e.i1 = Math.max(e.i1, c.i1); e.j1 = Math.max(e.j1, c.j1);
  }
  const used = placed.reduce((s, p) => s + area(cellsOf(p)), 0);
  while (used / area(e) >= GROW_AT) { e.i0--; e.j0--; e.i1++; e.j1++; }
  return e;
}

/** Ocupação atual (0..1) da área de lotes. */
export function occupancy(placed: Placed[]): number {
  const e = cityExtent(placed);
  return placed.reduce((s, p) => s + area(cellsOf(p)), 0) / area(e);
}

/** Qual estrutura ocupa cada lote (chave `i,j`): consulta O(1) para lotes livres, ruas e "onde estou". */
export function lotOwners(placed: Placed[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of placed) { const c = cellsOf(p); for (let j = c.j0; j < c.j1; j++) for (let i = c.i0; i < c.i1; i++) if (!m.has(`${i},${j}`)) m.set(`${i},${j}`, p.id); }
  return m;
}

/** Lotes livres (cada célula da área que nenhuma estrutura ocupa), em ordem de linha. */
export function freeCells(placed: Placed[], owners: Map<string, string> = lotOwners(placed)): Array<[number, number]> {
  const e = cityExtent(placed);
  const out: Array<[number, number]> = [];
  for (let j = e.j0; j < e.j1; j++) for (let i = e.i0; i < e.i1; i++) if (!owners.has(`${i},${j}`)) out.push([i, j]);
  return out;
}

export type PlaceError = 'unknown_kind' | 'outside' | 'occupied' | 'unique';

/** Pode pôr (ou mover, com `ignoreId`) uma estrutura deste tipo com o canto no lote (i, j)? */
export function placeError(placed: Placed[], kind: string, i: number, j: number, ignoreId?: string): PlaceError | null {
  const t = typeOf(kind);
  if (!t) return 'unknown_kind';
  if (!Number.isInteger(i) || !Number.isInteger(j)) return 'outside';
  const others = placed.filter((p) => p.id !== ignoreId);
  if (t.unique && !ignoreId && others.some((p) => p.kind === kind)) return 'unique';
  const e = cityExtent(others);
  const c = cellsOf({ id: '', kind, i, j });
  if (c.i0 < e.i0 || c.j0 < e.j0 || c.i1 > e.i1 || c.j1 > e.j1) return 'outside';
  if (others.some((p) => overlaps(cellsOf(p), c))) return 'occupied';
  return null;
}

/**
 * Onde encaixar uma estrutura que inclua o lote clicado: tenta todas as posições da pegada que cobrem
 * (ci, cj), da mais próxima do clique para a mais distante. null = não cabe ali.
 */
export function fitAt(placed: Placed[], kind: string, ci: number, cj: number): [number, number] | null {
  const [w, d] = footprintOf(kind);
  const cands: Array<[number, number]> = [];
  for (let dj = 0; dj < d; dj++) for (let di = 0; di < w; di++) cands.push([ci - di, cj - dj]);
  cands.sort((a, b) => Math.hypot(a[0] + w / 2 - ci - 0.5, a[1] + d / 2 - cj - 0.5) - Math.hypot(b[0] + w / 2 - ci - 0.5, b[1] + d / 2 - cj - 0.5));
  return cands.find(([i, j]) => placeError(placed, kind, i, j) === null) ?? null;
}

/** Capacidade de agentes de um tipo (andares mínimo e máximo × vagas). */
export function capacityRange(t: StructureType): [number, number] { return [t.floors.initial * t.slotsPerFloor, t.floors.max * t.slotsPerFloor]; }
