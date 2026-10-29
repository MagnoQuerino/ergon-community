/**
 * "Foto" da cidade para as prévias da loja de pacotes: chão, rua, três prédios e três moradores, desenhados pelo
 * mesmo código da cidade com o tema (ou a skin) do pacote. Não é a cidade inteira: é o bastante para ver as cores,
 * a arquitetura e as roupas antes de instalar.
 */
import { CATALOG } from '../../../shared/city.ts';
import { Town } from '../world/town.ts';
import { closedArt } from './buildingArt.ts';
import { figureGrid, lookFor, type Look } from './figures.ts';
import type { Theme } from './theme.ts';

const PREDIOS = ['emporion', 'stoa', 'oikos'];

function building(kind: string, t: Theme): HTMLCanvasElement | null {
  const c = CATALOG.find((x) => x.id === kind);
  if (!c) return null;
  const town = new Town([{ id: kind, kind, name: c.name, i: 0, j: 0, floors: Array.from({ length: Math.max(1, c.floors.initial) }, (_, l) => ({ id: `f${l}`, level: l, slots: c.slotsPerFloor })) }]);
  const b = town.buildings.get(kind);
  return b ? trim(closedArt(b, t).layer.canvas) : null;
}

/** Recorta a margem transparente do desenho (a arte do prédio vem com folga para sombra e telhado). */
function trim(src: HTMLCanvasElement): HTMLCanvasElement {
  const g = src.getContext('2d');
  if (!g || !src.width || !src.height) return src;
  const { data, width, height } = g.getImageData(0, 0, src.width, src.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return src;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d')?.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Desenha a prévia em `c` (tamanho em pixels de tela: w × h). `looks`: moradores a mostrar (até 3). */
export function drawCityThumb(c: HTMLCanvasElement, t: Theme, looks: Look[], w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  const W = c.width; const H = c.height;
  // céu, chão e a rua na frente
  const horizon = Math.round(H * 0.42);
  g.fillStyle = t.sky; g.fillRect(0, 0, W, horizon);
  g.fillStyle = t.bg; g.fillRect(0, horizon, W, H - horizon);
  g.fillStyle = t.ground[0]; g.fillRect(0, horizon, W, Math.round(H * 0.05));
  const roadY = Math.round(H * 0.8);
  g.fillStyle = t.road.edge; g.fillRect(0, roadY - Math.round(2 * dpr), W, Math.round(H * 0.2) + 4);
  g.fillStyle = t.road.fill; g.fillRect(0, roadY, W, H - roadY);
  // três prédios lado a lado, apoiados no chão
  const arts = PREDIOS.map((k) => building(k, t)).filter((x): x is HTMLCanvasElement => !!x);
  const slot = W / Math.max(1, arts.length);
  const base = Math.round(H * 0.82);
  arts.forEach((L, i) => {
    const s = Math.min((slot * 0.96) / L.width, (H * 0.74) / L.height);
    const dw = L.width * s; const dh = L.height * s;
    g.imageSmoothingEnabled = s < 1;
    g.drawImage(L, i * slot + (slot - dw) / 2, base - dh, dw, dh);
  });
  // moradores na rua, em pixel art (ampliados sem borrar até ~40% da altura)
  g.imageSmoothingEnabled = false;
  looks.slice(0, 3).forEach((look, i) => {
    const grid = figureGrid(look, 'front', 'stand', 0, t, 'smile');
    const px = Math.max(1, Math.floor((H * 0.4) / Math.max(1, grid.length)));
    const gw = (grid[0]?.length ?? 0) * px; const gh = grid.length * px;
    const x0 = Math.round(W * (0.22 + i * 0.28) - gw / 2); const y0 = Math.round(H - gh - 2 * dpr);
    grid.forEach((row, y) => row.forEach((col, x) => { if (col) { g.fillStyle = col; g.fillRect(x0 + x * px, y0 + y * px, px, px); } }));
  });
}

/** Moradores de sempre (sem skin): três da equipe grega, para a prévia de um tema. */
export function defaultLooks(t: Theme): Look[] {
  return [
    lookFor({ name: 'Aristóteles', color: '#1d184b', key: 'aristoteles' }, t),
    lookFor({ name: 'Hipátia', color: '#2f6f8f', key: 'hipatia' }, t),
    lookFor({ name: 'Fídias', color: '#a33b4c', key: 'fidias' }, t),
  ];
}
