/**
 * Projeção isométrica 2:1 em pixels nativos (antes da ampliação inteira).
 * TypeScript puro: o mesmo mundo do SceneLayout (x, altura, z) vira pixel de tela.
 * Câmera fixa olhando de +x/+z: +x desce para a direita, +z desce para a esquerda.
 */
export const RES = 2; // densidade da pixel art: 2 = o dobro de pixels por unidade (mais detalhe, mesmo tamanho na tela)
export const KX = 10 * RES; // px horizontais por unidade de x ou z
export const KY = 5 * RES; // px verticais por unidade de x ou z (metade de KX: degrau 2:1)
export const KZ = 12 * RES; // px verticais por unidade de altura

export type P2 = [number, number];
export type P3 = [number, number, number];

export function project(x: number, y: number, z: number): P2 {
  // + 1e-6: pontos exatamente no meio de um pixel (ex.: x + z = −6,95) arredondam sempre para o mesmo lado,
  // sem depender do ruído de ponto flutuante — dois bonecos na mesma linha ficam na mesma linha
  return [Math.round((x - z) * KX + 1e-6), Math.round((x + z) * KY - y * KZ + 1e-6)];
}

/** Inverso de project para um plano de altura conhecida (usado em testes e no clique no piso). */
export function unproject(sx: number, sy: number, y = 0): [number, number] {
  const a = sx / KX; // x - z
  const b = (sy + y * KZ) / KY; // x + z
  return [(a + b) / 2, (b - a) / 2];
}

/** Profundidade de desenho: maior = mais perto do observador = desenhado depois. */
export function depthOf(x: number, z: number): number {
  return x + z;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/**
 * Ampliação inteira que faz o retângulo caber na área (em pixels do dispositivo).
 * Pixel art só fica nítida com fator inteiro.
 */
export function fitScale(bounds: Rect, devW: number, devH: number, min = 1, max = 8): number {
  const w = Math.max(1, bounds.x1 - bounds.x0);
  const h = Math.max(1, bounds.y1 - bounds.y0);
  return Math.max(min, Math.min(max, Math.floor(Math.min(devW / w, devH / h))));
}

/** Ponto do polígono? (par-ímpar) — usado no clique de objetos de parede. */
export function insidePoly(px: number, py: number, pts: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
