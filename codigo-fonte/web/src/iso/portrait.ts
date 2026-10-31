/**
 * Retrato 3x4 de cada agente: o mesmo boneco da cidade, em pixel art, recortado da cabeça aos ombros, de frente e
 * sorrindo. Usado nos atalhos de conversa (círculos) e nas listas. A grade é TypeScript puro (testável); o canvas só
 * nasce no cache, no navegador.
 */
import { FIG_AX, HEAD_BOTTOM, figureGrid, gridBox, lookFor, type Grid, type Look } from './figures.ts';
import { ALEXANDRIA_DIA, mix, type Theme } from './theme.ts';
import { agentSkinLook, type ActiveSkin } from './skin.ts';

/** 3 de largura por 4 de altura: 21 × 28 pixels da grade (cabeça inteira e o começo dos ombros). */
export const PORTRAIT_W = 21;
export const PORTRAIT_H = 28;

export interface PortraitAgent { id?: string; name: string; color: string; role?: string; char_key?: string | null; look_seed?: number | null }

/** Recorte 3x4 da grade do boneco em pé, de frente: do alto da cabeça até logo abaixo dos ombros, centrado no rosto. */
/** A aparência do agente como a cidade desenha: com uma skin ativa, o personagem dela; sem, o do Ergon. */
export function lookOfAgent(a: PortraitAgent, t: Theme = ALEXANDRIA_DIA, skin: ActiveSkin | null = null): Look {
  // o rascunho da criação ainda não tem id: com a semente explícita, a skin sorteia igual ao que vai ser salvo
  return skin && (a.id || a.look_seed) ? agentSkinLook({ id: a.id ?? '', name: a.name, color: a.color, seed: a.look_seed ?? null }, skin, t)
    : lookFor({ name: a.name, color: a.color, role: a.role, key: a.char_key ?? null, seed: a.look_seed ?? null }, t);
}

export function portraitGrid(a: PortraitAgent, t: Theme = ALEXANDRIA_DIA, skin: ActiveSkin | null = null): Grid {
  const g = figureGrid(lookOfAgent(a, t, skin), 'front', 'stand', 0, t, 'smile');
  const bottom = Math.min(g.length, HEAD_BOTTOM + 6); // ombros
  const top = Math.max(0, bottom - PORTRAIT_H);
  const left = Math.max(0, FIG_AX - Math.floor(PORTRAIT_W / 2) - 1);
  return g.slice(top, bottom).map((row) => row.slice(left, left + PORTRAIT_W));
}

/** Fundo do retrato: a cor do agente bem clara (o boneco aparece inteiro, sem se perder). */
export const portraitBackground = (color: string): string => mix(color, '#f6efe1', 0.78);

/**
 * Cache com descarte (o menos usado sai primeiro): uma equipe grande rolando na galeria não faz a memória crescer para
 * sempre. A chave já inclui aparência, skin e escala, então trocar qualquer uma gera outra imagem.
 */
export class Lru<V> {
  private readonly m = new Map<string, V>();
  readonly max: number;
  constructor(max: number) { this.max = max; }
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
  get size(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
}

const cache = new Lru<string>(600);
/** Identidade da skin para o cache: o id e quem veste cada personagem. */
const skinKey = (s: ActiveSkin) => `${s.data.id}:${[...s.characters].map(([k, v]) => `${k}=${v}`).join(',')}`;

/** Imagem do retrato (PNG em data URL, ampliada sem borrar): uma por agente e aparência. */
export function portraitUrl(a: PortraitAgent, scale = 4, skin: ActiveSkin | null = null): string {
  const key = `${a.id ?? ''}|${a.name}|${a.color}|${a.role ?? ''}|${a.char_key ?? ''}|${a.look_seed ?? ''}|${scale}|${skin ? skinKey(skin) : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = portraitGrid(a, ALEXANDRIA_DIA, skin);
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

const bodies = new Lru<{ url: string; w: number; h: number }>(400);
/**
 * O boneco inteiro, de frente e em pé (cards da Equipe): o mesmo desenho da cidade, recortado no que tem pixel, em
 * fundo transparente. Uma imagem por agente/aparência/skin/escala, no cache com descarte.
 */
export function bodyUrl(a: PortraitAgent, scale = 2, skin: ActiveSkin | null = null): { url: string; w: number; h: number } | null {
  const key = `${a.id ?? ''}|${a.name}|${a.color}|${a.role ?? ''}|${a.char_key ?? ''}|${a.look_seed ?? ''}|${scale}|${skin ? skinKey(skin) : ''}`;
  const hit = bodies.get(key);
  if (hit) return hit;
  const grid = figureGrid(lookOfAgent(a, ALEXANDRIA_DIA, skin), 'front', 'stand', 0, ALEXANDRIA_DIA, 'smile');
  const [x0, y0, x1, y1] = gridBox(grid);
  if (x1 < 0) return null;
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = w * scale; c.height = h * scale;
  const g = c.getContext('2d');
  if (!g) return null;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const col = grid[y][x]; if (col) { g.fillStyle = col; g.fillRect((x - x0) * scale, (y - y0) * scale, scale, scale); } }
  const out = { url: c.toDataURL('image/png'), w: c.width, h: c.height };
  bodies.set(key, out);
  return out;
}

/** Quantas imagens estão guardadas (medição de escala: não pode crescer sem limite). */
export const portraitCacheSize = () => ({ portraits: cache.size, bodies: bodies.size, max: cache.max + bodies.max });
