/**
 * A arte da página do Ergon World: os bonecos da equipe grega e os prédios da cidade, desenhados pelo mesmo código da
 * Cidade (iso/figures.ts, iso/cityThumb.ts), em imagens pequenas e em cache. Sem canvas (teste, navegador sem suporte),
 * devolve null e a página segue sem a figura.
 */
import { figureGrid, gridBox, lookFor, type Facing, type Gesture } from '../../iso/figures.ts';
import { ALEXANDRIA_DIA } from '../../iso/theme.ts';
import { predioUrl } from '../../iso/cityThumb.ts';
import { Lru } from '../../iso/lru.ts';

/** Os personagens que aparecem na página (as cores são as da equipe inicial, server/src/services/characters.ts). */
export const ELENCO = {
  aristoteles: { name: 'Aristóteles', color: '#2f4f8a' }, // i18n-ok: nome de personagem
  hipatia: { name: 'Hipátia', color: '#2e7d78' }, // i18n-ok: nome de personagem
  arquimedes: { name: 'Arquimedes', color: '#b5482f' }, // i18n-ok: nome de personagem
  fidias: { name: 'Fídias', color: '#c08a2a' }, // i18n-ok: nome de personagem
  aspasia: { name: 'Aspásia', color: '#a3446a' }, // i18n-ok: nome de personagem
  platao: { name: 'Platão', color: '#5b3f8c' }, // i18n-ok: nome de personagem
  hesiodo: { name: 'Hesíodo', color: '#6d7a3a' }, // i18n-ok: nome de personagem
  euclides: { name: 'Euclides', color: '#3f6fa0' }, // i18n-ok: nome de personagem
} as const;
export type Personagem = keyof typeof ELENCO;

export interface Imagem { url: string; w: number; h: number }
const cache = new Lru<Imagem | null>(80);

/** O boneco inteiro de um personagem, em pixel art, recortado no que tem pixel (fundo transparente). */
export function figura(key: Personagem, gesture: Gesture = 'none', facing: Facing = 'front', scale = 3): Imagem | null {
  const k = `${key}|${gesture}|${facing}|${scale}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  let out: Imagem | null = null;
  try {
    const p = ELENCO[key];
    const grid = figureGrid(lookFor({ name: p.name, color: p.color, key }, ALEXANDRIA_DIA), facing, 'stand', 0, ALEXANDRIA_DIA, 'smile', gesture);
    const [x0, y0, x1, y1] = gridBox(grid);
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    const g = c?.getContext('2d');
    if (c && g && x1 >= 0) {
      const w = x1 - x0 + 1; const h = y1 - y0 + 1;
      c.width = w * scale; c.height = h * scale;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const col = grid[y][x]; if (col) { g.fillStyle = col; g.fillRect((x - x0) * scale, (y - y0) * scale, scale, scale); } }
      out = { url: c.toDataURL('image/png'), w: c.width, h: c.height };
    }
  } catch { out = null; }
  cache.set(k, out);
  return out;
}

/** Um prédio da cidade (o mesmo desenho), para o horizonte do mundo novo. */
export function predio(kind: string): Imagem | null {
  try { return typeof document !== 'undefined' ? predioUrl(kind, ALEXANDRIA_DIA) : null; } catch { return null; }
}
