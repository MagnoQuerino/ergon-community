/**
 * Primitivas de pixel art sem suavização: polígonos convexos por varredura de linhas e
 * retas de Bresenham, sempre em fillRect inteiro. O fill() do Canvas suaviza bordas;
 * aqui cada pixel é decidido pelo centro, então arestas 2:1 saem em degraus limpos.
 */
import { project, type P2 } from './projection.ts';

export interface PixelCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** Preenche um polígono convexo: pixel entra se o centro dele estiver dentro. */
export function fillPoly(g: PixelCtx, pts: P2[], color: string): void {
  let minY = Infinity; let maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  g.fillStyle = color;
  for (let y = Math.ceil(minY - 0.5); y <= Math.floor(maxY - 0.5); y++) {
    const cy = y + 0.5;
    let xl = Infinity; let xr = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i]; const [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 === y1 || cy < Math.min(y0, y1) || cy > Math.max(y0, y1)) continue;
      const x = x0 + ((x1 - x0) * (cy - y0)) / (y1 - y0);
      if (x < xl) xl = x; if (x > xr) xr = x;
    }
    if (xl > xr) continue;
    const xs = Math.ceil(xl - 0.5); const xe = Math.floor(xr - 0.5);
    if (xe >= xs) g.fillRect(xs, y, xe - xs + 1, 1);
  }
}

/** Reta de Bresenham; `dash` > 0 desenha só os primeiros `dash` de cada 2·dash pixels. */
export function line(g: PixelCtx, a: P2, b: P2, color: string, dash = 0): void {
  let [x0, y0] = a; const [x1, y1] = b;
  const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy; let i = 0;
  g.fillStyle = color;
  for (;;) {
    if (!dash || i % (dash * 2) < dash) g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
    i++;
  }
}

export type Tone = [string, string, string]; // topo (claro), face +z (média), face +x (escura)
export type Proj = (x: number, y: number, z: number) => P2;

/** Projeção deslocada para dentro de uma camada ou sprite. */
export function projector(ox: number, oy: number): Proj {
  return (x, y, z) => { const [sx, sy] = project(x, y, z); return [sx + ox, sy + oy]; };
}

/**
 * Caixa alinhada aos eixos: topo, face voltada para +z (esquerda da tela) e face voltada para +x
 * (direita da tela). `outline` desenha antes a silhueta deslocada 1 px, formando o contorno.
 */
export function isoBox(g: PixelCtx, P: Proj, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: Tone, outline?: string): void {
  if (outline) {
    const sil = [P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1)];
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) fillPoly(g, sil.map(([x, y]) => [x + ox, y + oy] as P2), outline);
  }
  fillPoly(g, [P(x0, y1, z1), P(x1, y1, z1), P(x1, y0, z1), P(x0, y0, z1)], c[1]);
  fillPoly(g, [P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), P(x1, y0, z0)], c[2]);
  fillPoly(g, [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], c[0]);
}

/** Quadrilátero no plano de uma parede do fundo (z constante): x0..x1, alturas y0..y1. */
export function backQuad(g: PixelCtx, P: Proj, z: number, x0: number, x1: number, y0: number, y1: number, color: string): void {
  fillPoly(g, [P(x0, y1, z), P(x1, y1, z), P(x1, y0, z), P(x0, y0, z)], color);
}

/** Quadrilátero no plano da parede esquerda (x constante): z0..z1, alturas y0..y1. */
export function sideQuad(g: PixelCtx, P: Proj, x: number, z0: number, z1: number, y0: number, y1: number, color: string): void {
  fillPoly(g, [P(x, y1, z0), P(x, y1, z1), P(x, y0, z1), P(x, y0, z0)], color);
}

/** Quadrilátero horizontal (piso, tapete, tampo). */
export function flatQuad(g: PixelCtx, P: Proj, y: number, x0: number, z0: number, x1: number, z1: number, color: string): void {
  fillPoly(g, [P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)], color);
}
