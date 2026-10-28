/**
 * Ordem de desenho por caixas 3D (o "quem cobre quem" da vista isométrica). Para dois objetos cujas
 * imagens se sobrepõem na tela, a caixa que está inteira atrás em x, em z ou abaixo em y é desenhada antes.
 * Isso vale para qualquer objeto — mesa, parede, degrau, vaso, prédio, árvore, personagem — sem regra
 * especial por cena: um prédio novo herda a ordem certa só por declarar as caixas dos seus objetos.
 * Ordenação topológica (Kahn) com desempate pela profundidade; ciclos (raros) são quebrados pela menor profundidade.
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

export function sortItems<T extends Sortable>(items: T[]): T[] {
  const n = items.length;
  if (n < 2) return items.slice();
  const d = items.map((it) => depth(it.box));
  const after: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Int32Array(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!overlap(items[i], items[j])) continue;
    let c = compareBoxes(items[i].box, items[j].box);
    if (c === 0) c = d[i] < d[j] ? -1 : d[i] > d[j] ? 1 : i < j ? -1 : 1;
    if (c < 0) { after[i].push(j); indeg[j]++; } else { after[j].push(i); indeg[i]++; }
  }
  const done = new Uint8Array(n);
  const out: T[] = [];
  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
  while (out.length < n) {
    let pick = -1;
    if (ready.length) {
      let bi = 0; for (let k = 1; k < ready.length; k++) if (d[ready[k]] < d[ready[bi]]) bi = k;
      pick = ready[bi]; ready.splice(bi, 1);
    } else { // ciclo: o mais ao fundo primeiro
      for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || d[i] < d[pick])) pick = i;
    }
    done[pick] = 1; out.push(items[pick]);
    for (const j of after[pick]) if (!done[j] && --indeg[j] === 0) ready.push(j);
  }
  return out;
}
