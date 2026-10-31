/**
 * Ordem de desenho por caixas 3D (o "quem cobre quem" da vista isométrica). Para dois objetos cujas
 * imagens se sobrepõem na tela, a caixa que está inteira atrás em x, em z ou abaixo em y é desenhada antes.
 * Isso vale para qualquer objeto — mesa, parede, degrau, vaso, prédio, árvore, personagem — sem regra
 * especial por cena: um prédio novo herda a ordem certa só por declarar as caixas dos seus objetos.
 * Ordenação topológica (Kahn) com desempate pela profundidade; ciclos (raros) são quebrados pela menor profundidade.
 *
 * Escala: só se comparam objetos que dividem uma célula de uma grade na tela (antes, todos os pares), e a fila dos
 * prontos é um heap. O resultado é o mesmo da versão de pares (teste em sort.test.ts): as listas "depois de" ficam em
 * ordem crescente e o desempate é pela profundidade e, em seguida, por quem entrou primeiro na fila.
 */
import type { AABB } from '../world/geom.ts';

export interface Sortable {
  box: AABB;
  /** retângulo ocupado na tela (pixels do mundo): x0, y0, x1, y1 */
  rect: [number, number, number, number];
  draw(): void;
}

const EPS = 1e-6;
/** −1: `a` atrás de `b` (desenha antes); 1: `a` na frente; 0: não se sabe (caixas se cruzam). */
export function compareBoxes(a: AABB, b: AABB): number {
  if (a.x1 <= b.x0 + EPS) return -1;
  if (b.x1 <= a.x0 + EPS) return 1;
  if (a.z1 <= b.z0 + EPS) return -1;
  if (b.z1 <= a.z0 + EPS) return 1;
  if (a.y1 <= b.y0 + EPS) return -1;
  if (b.y1 <= a.y0 + EPS) return 1;
  return 0;
}
const depth = (b: AABB) => (b.x0 + b.x1) / 2 + (b.z0 + b.z1) / 2 + (b.y0 + b.y1) * 0.001;
const overlap = (a: Sortable, b: Sortable) => a.rect[0] < b.rect[2] && b.rect[0] < a.rect[2] && a.rect[1] < b.rect[3] && b.rect[1] < a.rect[3];

const CELL = 128; // pixels do mundo por célula da grade de sobreposição
const OFF = 32768;

export function sortItems<T extends Sortable>(items: T[]): T[] {
  const n = items.length;
  if (n < 2) return items.slice();
  const d = items.map((it) => depth(it.box));
  const after: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  // grade na tela: cada objeto entra nas células que o retângulo cobre
  const cells = new Map<number, number[]>();
  const span = (i: number) => {
    const r = items[i].rect;
    return [Math.floor(r[0] / CELL), Math.floor(r[1] / CELL), Math.floor(r[2] / CELL), Math.floor(r[3] / CELL)];
  };
  for (let i = 0; i < n; i++) {
    const [cx0, cy0, cx1, cy1] = span(i);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const key = (cx + OFF) * 65536 + (cy + OFF);
      const list = cells.get(key); if (list) list.push(i); else cells.set(key, [i]);
    }
  }
  const mark = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const [cx0, cy0, cx1, cy1] = span(i);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      for (const j of cells.get((cx + OFF) * 65536 + (cy + OFF))!) {
        if (j <= i || mark[j] === i) continue;
        mark[j] = i;
        if (!overlap(items[i], items[j])) continue;
        let c = compareBoxes(items[i].box, items[j].box);
        if (c === 0) c = d[i] < d[j] ? -1 : d[i] > d[j] ? 1 : -1;
        if (c < 0) { after[i].push(j); indeg[j]++; } else { after[j].push(i); indeg[i]++; }
      }
    }
  }
  for (const a of after) if (a.length > 1) a.sort((x, y) => x - y);
  // heap dos prontos: menor profundidade; empate, quem entrou primeiro
  const heap: number[] = []; const seq = new Float64Array(n); let tick = 0;
  const less = (a: number, b: number) => d[a] < d[b] || (d[a] === d[b] && seq[a] < seq[b]);
  const push = (i: number) => {
    seq[i] = tick++; heap.push(i);
    for (let k = heap.length - 1; k > 0;) { const p = (k - 1) >> 1; if (!less(heap[k], heap[p])) break; [heap[k], heap[p]] = [heap[p], heap[k]]; k = p; }
  };
  const pop = (): number => {
    const top = heap[0]; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ;) {
        const l = 2 * k + 1; const r = l + 1; let m = k;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === k) break; [heap[k], heap[m]] = [heap[m], heap[k]]; k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (!indeg[i]) push(i);
  const done = new Uint8Array(n);
  const out: T[] = [];
  while (out.length < n) {
    let pick = -1;
    if (heap.length) pick = pop();
    else { // ciclo: o mais ao fundo primeiro
      for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || d[i] < d[pick])) pick = i;
    }
    done[pick] = 1; out.push(items[pick]);
    for (const j of after[pick]) if (!done[j] && --indeg[j] === 0) push(j);
  }
  return out;
}
