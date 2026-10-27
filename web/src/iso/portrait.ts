/**
 * Retrato 3x4 de cada agente: o mesmo boneco da cidade, em pixel art, recortado da cabeça aos ombros, de frente e
 * sorrindo. Usado nos atalhos de conversa (círculos) e nas listas. A grade é TypeScript puro (testável); o canvas só
 * nasce no cache, no navegador.
 */
import { FIG_AX, HEAD_BOTTOM, figureGrid, lookFor, type Grid } from './figures.ts';
import { ALEXANDRIA_DIA, mix, type Theme } from './theme.ts';

/** 3 de largura por 4 de altura: 21 × 28 pixels da grade (cabeça inteira e o começo dos ombros). */
export const PORTRAIT_W = 21;
export const PORTRAIT_H = 28;

export interface PortraitAgent { name: string; color: string; role?: string; char_key?: string | null; look_seed?: number | null }

/** Recorte 3x4 da grade do boneco em pé, de frente: do alto da cabeça até logo abaixo dos ombros, centrado no rosto. */
export function portraitGrid(a: PortraitAgent, t: Theme = ALEXANDRIA_DIA): Grid {
  const g = figureGrid(lookFor({ name: a.name, color: a.color, role: a.role, key: a.char_key ?? null, seed: a.look_seed ?? null }, t), 'front', 'stand', 0, t, 'smile');
  const bottom = Math.min(g.length, HEAD_BOTTOM + 6); // ombros
  const top = Math.max(0, bottom - PORTRAIT_H);
  const left = Math.max(0, FIG_AX - Math.floor(PORTRAIT_W / 2) - 1);
  return g.slice(top, bottom).map((row) => row.slice(left, left + PORTRAIT_W));
}

/** Fundo do retrato: a cor do agente bem clara (o boneco aparece inteiro, sem se perder). */
export const portraitBackground = (color: string): string => mix(color, '#f6efe1', 0.78);

const cache = new Map<string, string>();

/** Imagem do retrato (PNG em data URL, ampliada sem borrar): uma por agente e aparência. */
export function portraitUrl(a: PortraitAgent, scale = 4): string {
  const key = `${a.name}|${a.color}|${a.role ?? ''}|${a.char_key ?? ''}|${a.look_seed ?? ''}|${scale}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = portraitGrid(a);
  const c = document.createElement('canvas');
  c.width = PORTRAIT_W * scale; c.height = PORTRAIT_H * scale;
  const g = c.getContext('2d');
  if (!g) return '';
  g.fillStyle = portraitBackground(a.color);
  g.fillRect(0, 0, c.width, c.height);
  grid.forEach((row, y) => row.forEach((col, x) => { if (col) { g.fillStyle = col; g.fillRect(x * scale, y * scale, scale, scale); } }));
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
