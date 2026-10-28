/**
 * Objetos em pixel art desenhados uma vez em canvases pequenos (sprites) e reutilizados.
 * Tudo em coordenadas do mundo relativas à âncora do objeto; o tamanho do canvas vem da caixa do
 * objeto projetada, então a densidade (RES) muda sem mexer aqui. Sem arquivos de imagem.
 */
import { isoBox, flatQuad, line, projector, fillPoly, type PixelCtx, type Proj } from './raster.ts';
import { RES, project } from './projection.ts';
import { mix, type Theme } from './theme.ts';
import type { Sprite } from './figures.ts';

export type { Sprite };

export function makeSprite(w: number, h: number, ax: number, ay: number, draw: (g: CanvasRenderingContext2D, P: Proj) => void): Sprite {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  draw(g, projector(ax, ay));
  return { canvas: c, ax, ay, w, h, mask: new Uint8Array(0) };
}

/** Sprite do tamanho da caixa do objeto no mundo (x0..x1, y0..y1, z0..z1), com folga em pixels. */
export function fitSprite(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, draw: (g: CanvasRenderingContext2D, P: Proj) => void, pad = 4 * RES): Sprite {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
    const [sx, sy] = project(x, y, z);
    minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
  }
  return makeSprite(maxX - minX + 2 * pad, maxY - minY + 2 * pad, pad - minX, pad - minY, draw);
}

/** Elipse cheia em pixels (folhagem, copas, bojo de vaso). */
export function blob(g: PixelCtx, cx: number, cy: number, rx: number, ry: number, color: string): void {
  g.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const hw = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
    g.fillRect(cx - hw, cy + y, hw * 2 + 1, 1);
  }
}

/** Folhagem com contorno, sombra, luz e alguns brilhos de folha (medidas em pixels-base × RES). */
function foliage(g: PixelCtx, cx: number, cy: number, parts: Array<[number, number, number, number]>, tone: [string, string], outline: string): void {
  const P = parts.map(([x, y, rx, ry]) => [x * RES, y * RES, rx * RES, ry * RES] as const);
  for (const [x, y, rx, ry] of P) blob(g, cx + x, cy + y, rx + 1, ry + 1, outline);
  for (const [x, y, rx, ry] of P) blob(g, cx + x, cy + y, rx, ry, tone[1]);
  for (const [x, y, rx, ry] of P) blob(g, cx + x - RES, cy + y - RES, Math.max(0, rx - 2 * RES), Math.max(0, ry - RES), tone[0]);
  g.fillStyle = outline;
  for (const [x, y, rx] of P) { g.fillRect(cx + x + Math.round(rx / 2), cy + y + 1, 1, 1); g.fillRect(cx + x - Math.round(rx / 3), cy + y + RES + 1, 1, 1); }
}

const cache = new Map<string, Sprite>();
function cached(key: string, make: () => Sprite): Sprite {
  let s = cache.get(key);
  if (!s) { s = make(); cache.set(key, s); }
  return s;
}

/** Mesa de escrita com objetos variados sobre o tampo (papiro e tinteiro, tabuleta, ábaco). */
export function deskSprite(t: Theme, variant: number): Sprite {
  return cached(`${t.id}|desk|${variant % 3}`, () => fitSprite(-0.75, 0, -0.45, 0.75, 1.15, 0.45, (g, P) => {
    const top = 0.64; const y2 = top + 0.09;
    for (const [lx, lz] of [[-0.64, -0.36], [0.56, -0.36], [-0.64, 0.28], [0.56, 0.28]]) isoBox(g, P, lx, 0, lz, lx + 0.08, top, lz + 0.08, t.woodDark, t.outline);
    isoBox(g, P, -0.72, top, -0.42, 0.72, y2, 0.42, t.wood, t.outline);
    line(g, P(-0.72, y2, 0.42), P(0.72, y2, 0.42), t.wood[0]); // quina iluminada
    for (const z of [-0.2, 0.05, 0.3]) line(g, P(-0.68, y2, z), P(0.68, y2, z), t.wood[1]); // veios
    switch (variant % 3) {
      case 0: // folha de papiro, tinteiro e cálamo
        flatQuad(g, P, y2, -0.55, -0.24, -0.02, 0.22, t.papyrus[0]);
        for (const z of [-0.12, -0.02, 0.08]) line(g, P(-0.47, y2, z), P(-0.12, y2, z), t.papyrus[1]);
        isoBox(g, P, 0.18, y2, -0.28, 0.3, y2 + 0.12, -0.16, t.woodDark, t.outline);
        line(g, P(0.24, y2 + 0.12, -0.22), P(0.36, y2 + 0.36, -0.3), t.papyrus[0]);
        isoBox(g, P, 0.3, y2, 0.02, 0.62, y2 + 0.08, 0.12, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline);
        break;
      case 1: // tabuleta de cera com estilete e rolo
        isoBox(g, P, -0.45, y2, -0.2, 0.05, y2 + 0.04, 0.2, t.wood, t.outline);
        flatQuad(g, P, y2 + 0.045, -0.38, -0.13, -0.02, 0.13, t.olive[1]);
        for (const z of [-0.06, 0.04]) line(g, P(-0.32, y2 + 0.046, z), P(-0.1, y2 + 0.046, z), t.olive[0]);
        line(g, P(0.1, y2 + 0.02, -0.15), P(0.3, y2 + 0.02, 0.1), t.bronze[0]);
        isoBox(g, P, 0.2, y2, -0.34, 0.6, y2 + 0.09, -0.24, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline);
        break;
      default: { // ábaco de pedrinhas
        isoBox(g, P, -0.42, y2, -0.18, 0.28, y2 + 0.05, 0.18, t.woodDark, t.outline);
        const beads = [t.teal[0], t.gold, t.terracotta[0], t.papyrus[0]];
        for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) {
          const [x, y] = P(-0.34 + i * 0.13 + (r % 2) * 0.05, y2 + 0.06, -0.1 + r * 0.1);
          g.fillStyle = beads[(r + i) % beads.length]; g.fillRect(x, y, RES, RES);
        }
        flatQuad(g, P, y2, 0.34, -0.3, 0.64, 0.1, t.papyrus[0]);
      }
    }
  }));
}

/** Banco grego dobrável (díphros): assento e pernas em X. */
export function stoolSprite(t: Theme): Sprite {
  return cached(`${t.id}|stool`, () => fitSprite(-0.26, 0, -0.26, 0.26, 0.46, 0.26, (g, P) => {
    for (const z of [-0.16, 0.16]) {
      line(g, P(-0.18, 0.36, z), P(0.18, 0, z), t.woodDark[1]);
      line(g, P(0.18, 0.36, z), P(-0.18, 0, z), t.woodDark[0]);
    }
    isoBox(g, P, -0.24, 0.36, -0.22, 0.24, 0.43, 0.22, t.wood, t.outline);
  }));
}

/** Coluna dórica simplificada; `stub` = recorte arquitetônico (só a base, para não esconder ninguém). */
export function columnSprite(t: Theme, height: number, stub: boolean): Sprite {
  return cached(`${t.id}|col|${height.toFixed(2)}|${stub ? 1 : 0}`, () => fitSprite(-0.47, 0, -0.47, 0.47, height, 0.47, (g, P) => {
    const m = t.marble;
    if (stub) { // recorte: só a base e a seção cortada do fuste, rente ao piso
      isoBox(g, P, -0.42, 0, -0.42, 0.42, 0.14, 0.42, m, t.outline);
      flatQuad(g, P, 0.14, -0.29, -0.29, 0.29, 0.29, m[2]);
      flatQuad(g, P, 0.14, -0.18, -0.18, 0.18, 0.18, m[1]);
      return;
    }
    isoBox(g, P, -0.42, 0, -0.42, 0.42, 0.16, 0.42, m, t.outline);
    const shaftTop = height - 0.32;
    isoBox(g, P, -0.29, 0.16, -0.29, 0.29, shaftTop, 0.29, m, t.outline);
    // caneluras: linhas verticais alternadas nas duas faces visíveis
    for (const f of [-0.19, -0.07, 0.05, 0.17]) {
      line(g, P(f, 0.22, 0.29), P(f, shaftTop - 0.06, 0.29), m[2]);
      line(g, P(0.29, 0.22, f), P(0.29, shaftTop - 0.06, f), t.outline);
    }
    isoBox(g, P, -0.38, height - 0.32, -0.38, 0.38, height - 0.16, 0.38, m, t.outline);
    isoBox(g, P, -0.46, height - 0.16, -0.46, 0.46, height, 0.46, m, t.outline);
  }));
}

/** Vaso com oliveira baixa. */
export function plantSprite(t: Theme): Sprite {
  return cached(`${t.id}|plant`, () => fitSprite(-0.6, 0, -0.6, 0.6, 1.45, 0.6, (g, P) => {
    isoBox(g, P, -0.24, 0, -0.24, 0.24, 0.38, 0.24, t.terracotta, t.outline);
    line(g, P(-0.24, 0.3, 0.24), P(0.24, 0.3, 0.24), t.terracotta[2]); // friso do vaso
    flatQuad(g, P, 0.38, -0.18, -0.18, 0.18, 0.18, t.woodDark[2]);
    const [cx, cy] = P(0, 0.95, 0);
    line(g, P(0, 0.38, 0), P(0, 0.75, 0), t.woodDark[0]);
    foliage(g, cx, cy, [[-3, 1, 4, 3], [3, 0, 4, 3], [0, -3, 4, 3]], t.olive, t.outline);
  }));
}

export function cypressSprite(t: Theme, tall: number): Sprite {
  const h = Math.round((18 + tall * 8) * RES); const w = 14 * RES; const cx = Math.round(w / 2);
  return cached(`${t.id}|cypress|${h}`, () => makeSprite(w, h + 8 * RES, cx, h + 4 * RES, (g) => {
    g.fillStyle = t.woodDark[0]; g.fillRect(cx - RES, h, 2 * RES, 4 * RES);
    const cy = Math.round(h / 2) + RES; const ry = Math.round(h / 2) - RES;
    blob(g, cx, cy, 4 * RES, ry + 1, t.outline);
    blob(g, cx, cy, 4 * RES - 1, ry, t.cypress[1]);
    blob(g, cx - RES, cy - RES, RES, ry - 2 * RES, t.cypress[0]);
    g.fillStyle = mix(t.cypress[1], '#000000', 0.22);
    for (let y = cy - ry + 3 * RES; y < cy + ry - 2 * RES; y += 3 * RES) g.fillRect(cx + RES, y, RES, 1); // textura da copa
    g.fillStyle = mix(t.cypress[0], '#ffffff', 0.16); // tufos de luz do lado do sol
    for (let y = cy - ry + 4 * RES; y < cy; y += 4 * RES) g.fillRect(cx - 2 * RES, y, RES, 1);
  }));
}

/**
 * Pinheiro-manso (o guarda-chuva mediterrâneo): tronco alto e um pouco inclinado (v = para que lado), copa larga e
 * achatada em camadas. Pacote Grécia Clássica.
 */
export function pineSprite(t: Theme, k: number, v: number): Sprite {
  const h = Math.round((24 + k * 8) * RES); const w = 34 * RES; const cx = Math.round(w / 2);
  return cached(`${t.id}|pine|${h}|${v % 3}`, () => makeSprite(w, h + 6 * RES, cx, h + 3 * RES, (g) => {
    const top = Math.round(h * 0.32); const lean = ((v % 3) - 1) * 3 * RES;
    for (let y = top; y <= h; y++) {
      const x = Math.round(cx + lean * (1 - (y - top) / (h - top)));
      g.fillStyle = t.woodDark[1]; g.fillRect(x - RES, y, 2 * RES, 1);
      g.fillStyle = t.woodDark[0]; g.fillRect(x - RES, y, Math.max(1, RES / 2), 1);
    }
    const ccx = cx + lean; const tone: [string, string] = [mix(t.cypress[0], t.olive[0], 0.35), mix(t.cypress[1], t.olive[1], 0.3)];
    foliage(g, ccx, top, [[-6, 1, 7, 3], [5, 1, 7, 3], [0, -2, 9, 3], [-2, 3, 6, 2]], tone, t.outline);
    g.fillStyle = mix(tone[0], '#ffffff', 0.18); // brilho do sol no alto da copa
    for (let i = 0; i < 7; i++) g.fillRect(ccx + ((i * 29) % 20 - 10) * RES, top - 3 * RES + ((i * 13) % 3) * RES, RES, 1);
  }));
}

/**
 * Pedras soltas do campo (calcário claro), em três arranjos (v): uma grande, duas, ou três pequenas. Baixas: não
 * escondem ninguém.
 */
export function rockSprite(t: Theme, k: number, v: number): Sprite {
  const s = Math.round(k * 4) / 4;
  return cached(`${t.id}|rock|${s}|${v % 3}`, () => fitSprite(-0.8, 0, -0.8, 0.8, 0.8, 0.8, (g, P) => {
    const tone: [string, string, string] = [mix(t.stone[1], t.bg, 0.2), mix(t.stone[2], t.bg, 0.25), mix(t.stone[2], t.outline, 0.35)];
    const stone = (x: number, z: number, r: number, hgt: number) => {
      const [cx, cy] = P(x, 0, z); const rx = Math.round(r * 2 * 10 * RES * 0.5) + 1; const ry = Math.max(2, Math.round(rx / 2));
      const top = Math.round(hgt * 12 * RES);
      blob(g, cx, cy - top / 2, rx + 1, ry + Math.round(top / 2) + 1, t.outline);
      blob(g, cx, cy - top / 2, rx, ry + Math.round(top / 2), tone[1]);
      blob(g, cx - 1, cy - top / 2 - Math.round(ry / 2), Math.max(1, rx - 2), Math.max(1, Math.round(ry * 0.8)), tone[0]);
      g.fillStyle = tone[2]; g.fillRect(cx + Math.round(rx / 3), cy - Math.round(top / 3), 1, Math.max(1, Math.round(top / 2)));
    };
    const m = v % 3;
    if (m === 0) stone(0, 0, 0.42 * s, 0.32 * s);
    else if (m === 1) { stone(-0.22, -0.1, 0.32 * s, 0.24 * s); stone(0.25, 0.18, 0.22 * s, 0.16 * s); }
    else { stone(-0.25, 0, 0.2 * s, 0.14 * s); stone(0.1, -0.22, 0.24 * s, 0.18 * s); stone(0.22, 0.2, 0.16 * s, 0.1 * s); }
  }));
}

export function bushSprite(t: Theme): Sprite {
  return cached(`${t.id}|bush`, () => makeSprite(18 * RES, 12 * RES, 9 * RES, 9 * RES, (g) => foliage(g, 9 * RES, 6 * RES, [[-2, 0, 4, 2], [3, 0, 3, 2]], t.olive, t.outline)));
}

/** Braseiro de bronze aceso. */
export function brazierSprite(t: Theme): Sprite {
  return cached(`${t.id}|brazier`, () => fitSprite(-0.32, 0, -0.32, 0.32, 1.5, 0.32, (g, P) => {
    line(g, P(0, 0, 0), P(0, 0.8, 0), t.bronze[2]); line(g, P(0.03, 0, 0), P(0.03, 0.8, 0), t.bronze[1]);
    isoBox(g, P, -0.2, 0.0, -0.2, 0.2, 0.05, 0.2, t.bronze, t.outline);
    isoBox(g, P, -0.28, 0.8, -0.28, 0.28, 0.98, 0.28, t.bronze, t.outline);
    const [x, y] = P(0, 0.98, 0); const r = RES;
    g.fillStyle = t.flame[1]; g.fillRect(x - 2 * r, y - 3 * r, 5 * r, 2 * r); g.fillRect(x - r, y - 5 * r, 3 * r, 2 * r);
    g.fillStyle = t.flame[0]; g.fillRect(x - r, y - 3 * r, 3 * r, r); g.fillRect(x, y - 6 * r, r, 3 * r);
  }));
}

/** Casa da cidade: paredes claras, telhado de quatro águas em terracota com fiadas de telha, janela acesa. */
export function houseSprite(t: Theme, w: number, h: number, d: number): Sprite {
  // caixa local: x ∈ [0, w], z ∈ [-d, 0]; a âncora é o canto (0, 0, 0)
  return cached(`${t.id}|house|${w}|${h}|${d}`, () => fitSprite(-0.2, 0, -d - 0.2, w + 0.2, h + 1.3, 0.2, (g, P) => {
    const x0 = 0; const x1 = w; const z0 = -d; const z1 = 0;
    isoBox(g, P, x0, 0, z0, x1, h, z1, t.houseWall, t.outline);
    for (const yy of [h * 0.33, h * 0.66]) { line(g, P(x0, yy, z1), P(x1, yy, z1), t.houseWall[2]); line(g, P(x1, yy, z1), P(x1, yy, z0), t.outline); } // fiadas de pedra
    const r = d / 2; const yr = h + Math.min(1.1, d * 0.45); const zc = (z0 + z1) / 2; const e = 0.12;
    // telhado: face +z (trapézio) e face +x (triângulo), com beiral
    const faceZ = [P(x0 - e, h, z1 + e), P(x1 + e, h, z1 + e), P(x1 - r, yr, zc), P(x0 + r, yr, zc)];
    const faceX = [P(x1 + e, h, z1 + e), P(x1 + e, h, z0 - e), P(x1 - r, yr, zc)];
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const sh = (pts: [number, number][]) => pts.map(([x, y]) => [x + ox, y + oy] as [number, number]);
      fillPoly(g, sh(faceZ), t.outline); fillPoly(g, sh(faceX), t.outline);
    }
    fillPoly(g, faceZ, t.roof[1]); fillPoly(g, faceX, t.roof[2]);
    for (let i = 1; i < 5; i++) { // fiadas de telha paralelas ao beiral
      const f = i / 5;
      line(g, P(x0 - e + r * f, h + (yr - h) * f, z1 + e - (z1 + e - zc) * f), P(x1 + e - r * f, h + (yr - h) * f, z1 + e - (z1 + e - zc) * f), t.roof[2]);
    }
    line(g, P(x0 + r, yr, zc), P(x1 - r, yr, zc), t.roof[0]);
    // janela acesa e porta
    const wx = x0 + w * 0.3;
    for (let k = 0; k < 3; k++) line(g, P(wx, h * 0.42 + k * 0.08, z1), P(wx + 0.35, h * 0.42 + k * 0.08, z1), t.window);
    const [px, py] = P(x1, h * 0.5, z0 + d * 0.5); g.fillStyle = t.window; g.fillRect(px, py, RES, 2 * RES);
    const dx = x0 + w * 0.65; flatDoor(g, P, dx, z1, h * 0.5, t.woodDark[1]);
  }));
}

function flatDoor(g: CanvasRenderingContext2D, P: Proj, x: number, z: number, hh: number, color: string): void {
  fillPoly(g, [P(x, hh, z), P(x + 0.28, hh, z), P(x + 0.28, 0.02, z), P(x, 0.02, z)], color);
}

/** Mesa de estratégia com mapa sobre o tampo e castiçal (ponto de encontro dos agentes). */
export function mapTableSprite(t: Theme): Sprite {
  return cached(`${t.id}|maptable`, () => fitSprite(-0.7, 0, -0.8, 0.7, 1.3, 0.8, (g, P) => {
    const top = 0.66; const y2 = top + 0.09;
    for (const [lx, lz] of [[-0.56, -0.66], [0.48, -0.66], [-0.56, 0.58], [0.48, 0.58]]) isoBox(g, P, lx, 0, lz, lx + 0.08, top, lz + 0.08, t.woodDark, t.outline);
    isoBox(g, P, -0.62, top, -0.72, 0.62, y2, 0.72, t.woodDark, t.outline);
    line(g, P(-0.62, y2, 0.72), P(0.62, y2, 0.72), t.woodDark[0]);
    flatQuad(g, P, y2 + 0.002, -0.5, -0.58, 0.5, 0.58, t.papyrus[0]);
    flatQuad(g, P, y2 + 0.003, -0.5, 0.42, 0.5, 0.58, t.papyrus[1]);
    // litoral e rotas do mapa
    line(g, P(-0.45, y2, -0.3), P(-0.1, y2, -0.05), t.teal[1]); line(g, P(-0.1, y2, -0.05), P(0.1, y2, 0.3), t.teal[1]);
    line(g, P(-0.3, y2, 0.2), P(0.35, y2, -0.35), t.terracotta[1], 1);
    for (const [x, z, c] of [[-0.3, 0.2, t.terracotta[1]], [0.35, -0.35, t.terracotta[1]], [0.05, 0.1, t.gold]] as const) {
      const [px, py] = P(x, y2, z); g.fillStyle = c; g.fillRect(px - 1, py - 1, RES + 1, RES);
    }
    // castiçal de bronze aceso
    isoBox(g, P, 0.38, y2, -0.6, 0.48, y2 + 0.06, -0.5, t.bronze, t.outline);
    line(g, P(0.43, y2 + 0.06, -0.55), P(0.43, y2 + 0.3, -0.55), t.bronze[1]);
    const [fx, fy] = P(0.43, y2 + 0.32, -0.55); g.fillStyle = t.flame[1]; g.fillRect(fx - 1, fy - 2 * RES, RES, 2 * RES); g.fillStyle = t.flame[0]; g.fillRect(fx - 1, fy - 2 * RES, RES, RES);
  }));
}

/** Banco de pedra (exedra) para sentar. */
export function benchSprite(t: Theme): Sprite {
  return cached(`${t.id}|bench`, () => fitSprite(-0.95, 0, -0.3, 0.95, 0.5, 0.3, (g, P) => {
    for (const x of [-0.8, 0.6]) isoBox(g, P, x, 0, -0.18, x + 0.2, 0.36, 0.18, t.stone, t.outline);
    isoBox(g, P, -0.9, 0.36, -0.26, 0.9, 0.46, 0.26, t.marble, t.outline);
    line(g, P(-0.9, 0.46, 0.26), P(0.9, 0.46, 0.26), t.marble[0]);
  }));
}

/** Ânfora de terracota com faixa escura e alças. */
export function amphoraSprite(t: Theme, big: boolean): Sprite {
  const k = big ? 1 : 0.7;
  return cached(`${t.id}|amphora|${big ? 1 : 0}`, () => fitSprite(-0.35, 0, -0.35, 0.35, 1.1, 0.35, (g, P) => {
    const [cx, by] = P(0, 0, 0); const r = RES;
    const bodyY = by - Math.round(9 * k * r); const rx = Math.round(4 * k * r); const ry = Math.round(6 * k * r);
    blob(g, cx, bodyY, rx + 1, ry + 1, t.outline);
    g.fillStyle = t.outline; g.fillRect(cx - Math.round(1.5 * k * r) - 1, bodyY - ry - Math.round(4 * k * r) - 1, Math.round(3 * k * r) + 2, Math.round(4 * k * r) + 2);
    g.fillRect(cx - Math.round(2 * k * r) - 1, by - Math.round(2 * k * r), Math.round(4 * k * r) + 2, Math.round(2 * k * r) + 1);
    blob(g, cx, bodyY, rx, ry, t.terracotta[1]);
    blob(g, cx - r, bodyY - r, Math.max(1, rx - 2 * r), Math.max(1, ry - 2 * r), t.terracotta[0]);
    g.fillStyle = t.terracotta[1]; g.fillRect(cx - Math.round(1.5 * k * r), bodyY - ry - Math.round(4 * k * r), Math.round(3 * k * r), Math.round(4 * k * r)); // gargalo
    g.fillRect(cx - Math.round(2 * k * r), by - Math.round(2 * k * r) + 1, Math.round(4 * k * r), Math.round(2 * k * r) - 1); // pé
    g.fillStyle = t.outline; g.fillRect(cx - rx, bodyY - 1, 2 * rx + 1, r); // faixa de figuras negras
    g.fillStyle = t.terracotta[2]; for (let x = cx - rx + 2; x < cx + rx - 1; x += 3) g.fillRect(x, bodyY - 1, 1, r);
    g.fillStyle = t.outline; // alças
    g.fillRect(cx - rx - 1, bodyY - ry - r, r, Math.round(4 * k * r)); g.fillRect(cx + rx, bodyY - ry - r, r, Math.round(4 * k * r));
  }));
}

/** Cesto (capsa) com rolos de papiro em pé. */
export function scrollBasketSprite(t: Theme): Sprite {
  return cached(`${t.id}|capsa`, () => fitSprite(-0.3, 0, -0.3, 0.3, 0.8, 0.3, (g, P) => {
    isoBox(g, P, -0.22, 0, -0.22, 0.22, 0.34, 0.22, t.wood, t.outline);
    line(g, P(-0.22, 0.22, 0.22), P(0.22, 0.22, 0.22), t.woodDark[1]);
    for (const [x, z, h] of [[-0.1, -0.08, 0.62], [0.06, -0.1, 0.55], [-0.04, 0.06, 0.6], [0.1, 0.05, 0.5]] as const) {
      isoBox(g, P, x - 0.045, 0.3, z - 0.045, x + 0.045, h, z + 0.045, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline);
    }
  }));
}
