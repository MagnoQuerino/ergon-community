/**
 * Arquitetura clássica em pixel art: colunas redondas por ordem (dórica no térreo, jônica no 1º andar,
 * coríntia acima — a sobreposição das ordens das stoas helenísticas), frisos (tríglifos e métopas, óvulos e
 * dentículos), meias-paredes em segmentos (intercalam com os personagens), parede lateral com janelas e porta,
 * parapeito das varandas e móveis próprios da biblioteca. Tudo desenhado uma vez em sprites ou camadas.
 */
import { RES, KX, KY, KZ, project, type P2 } from './projection.ts';
import { fillPoly, flatQuad, isoBox, line, sideQuad, backQuad, type Proj, type Tone } from './raster.ts';
import { blob, fitSprite, makeSprite, type Sprite } from './props.ts';
import { mix, shade, type Theme } from './theme.ts';
import type { Wall } from '../world/buildings.ts';

export type Order = 'doric' | 'ionic' | 'corinthian';
export function orderFor(level: number): Order { return level === 0 ? 'doric' : level === 1 ? 'ionic' : 'corinthian'; }
export const ORDER_NAME: Record<Order, string> = { doric: 'dórica', ionic: 'jônica', corinthian: 'coríntia' };

const cache = new Map<string, Sprite>();
function cached(key: string, make: () => Sprite): Sprite { let s = cache.get(key); if (!s) { s = make(); cache.set(key, s); } return s; }

/** Meio eixo horizontal (px) de um círculo de raio r no chão projetado (vertical = metade). */
const semi = (r: number) => r * Math.SQRT2 * KX;

/** Tom de um ponto do fuste: luz do alto à esquerda, sombra à direita (u ∈ [−1, 1]). */
function shaftTone(m: Tone, u: number): string { return u < -0.8 ? m[1] : u < -0.12 ? m[0] : u < 0.48 ? m[1] : m[2]; }
const deeper = (m: Tone, c: string, out: string) => (c === m[0] ? m[1] : c === m[1] ? m[2] : mix(m[2], out, 0.35));

/**
 * Coluna redonda: fuste com caneluras e êntase leve, base (jônica/coríntia), capitel da ordem.
 * `stub` = recorte arquitetônico (base e um toco do fuste com a seção cortada à mostra).
 */
export function roundColumnSprite(t: Theme, order: Order, height: number, cut = 0): Sprite {
  const stub = cut > 0;
  return cached(`${t.id}|rcol|${order}|${height.toFixed(2)}|${cut.toFixed(2)}`, () => {
    const m = t.marble; const o = t.outline;
    const rb = order === 'doric' ? 0.34 : 0.28; const rt = rb * 0.84;
    const cap = order === 'doric' ? 0.46 : order === 'ionic' ? 0.4 : 0.42; // meia largura do ábaco
    const w = Math.ceil(2 * cap * KX * 2) + 10; const hh = Math.ceil(height * KZ) + Math.ceil(2 * cap * KY * 2) + 14;
    const ax = Math.floor(w / 2); const ay = hh - Math.ceil(semi(0.42) / 2) - 5;
    return makeSprite(w, hh, ax, ay, (g, P) => {
      const px = (x: number, y: number, c: string) => { g.fillStyle = c; g.fillRect(ax + x, y, 1, 1); };
      // cilindro (ou tronco de cone) com tampa inferior elíptica; y0/y1 em unidades de altura
      const drum = (y0: number, y1: number, r0: number, r1: number, flutes: number, base: Tone, outline = true) => {
        const A0 = semi(r0); const A1 = semi(r1); const Am = Math.max(A0, A1);
        const sy0 = ay - y0 * KZ; const sy1 = ay - y1 * KZ;
        for (let dx = -Math.ceil(Am) - 1; dx <= Math.ceil(Am) + 1; dx++) {
          let top = Infinity; let bot = -Infinity;
          for (let sy = Math.floor(sy1) - 2; sy <= Math.ceil(sy0 + A0 / 2) + 1; sy++) {
            const f = Math.max(0, Math.min(1, (sy0 - sy) / Math.max(1, sy0 - sy1)));
            const a = A0 + (A1 - A0) * f + (order === 'doric' && flutes ? Math.sin(f * Math.PI) * 0.6 : 0);
            if (Math.abs(dx) > a) continue;
            const b = a / 2; const yb = sy0 + b * Math.sqrt(Math.max(0, 1 - (dx * dx) / (a * a)));
            if (sy < sy1 || sy > yb) continue;
            const u = dx / a; let c = shaftTone(base, u);
            if (flutes && Math.abs(u) < 0.92 && ((dx + 300) % flutes === 0)) c = deeper(base, c, o);
            if (flutes === 3 && order !== 'doric' && Math.abs(u) < 0.8 && ((dx + 300) % 3 === 1)) c = c === base[2] ? base[1] : base[0]; // filetes
            px(dx, sy, c); top = Math.min(top, sy); bot = Math.max(bot, sy);
          }
          if (outline && bot > -Infinity) px(dx, bot + 1, o);
        }
        if (outline) for (let sy = Math.floor(sy1); sy <= sy0; sy++) {
          const f = Math.max(0, Math.min(1, (sy0 - sy) / Math.max(1, sy0 - sy1)));
          const a = Math.round(A0 + (A1 - A0) * f + (order === 'doric' && flutes ? Math.sin(f * Math.PI) * 0.6 : 0));
          px(-a - 1, sy, o); px(a + 1, sy, o);
        }
      };
      // elipse cheia (topo de um tambor) — seção cortada, tampa do equino
      const disc = (y: number, r: number, c: string, ring?: string) => {
        const A = semi(r); const B = A / 2; const cy = ay - y * KZ;
        if (ring) blob(g, ax, Math.round(cy), Math.round(A) + 1, Math.round(B) + 1, ring);
        blob(g, ax, Math.round(cy), Math.round(A), Math.round(B), c);
      };
      const hasBase = order !== 'doric';
      const baseTop = hasBase ? 0.2 : 0;
      if (hasBase) { // plinto quadrado e um toro (formas limpas: legíveis em 1×)
        isoBox(g, P, -0.36, 0, -0.36, 0.36, 0.08, 0.36, m, o);
        disc(0.13, rb * 1.3, m[1], o); disc(0.16, rb * 1.18, m[0]);
      }
      if (stub) { // corte: fuste cortado na altura do corte do andar, seção clara à mostra
        const top = Math.max(baseTop + 0.12, cut);
        drum(baseTop, top, rb, rb * 0.98, 3, m);
        disc(top, rb * 0.98, mix(m[0], '#ffffff', 0.3), o);
        disc(top, rb * 0.6, m[0]);
        return;
      }
      const capH = order === 'doric' ? 0.3 : order === 'ionic' ? 0.26 : 0.46;
      const shaftTop = height - capH;
      drum(baseTop, shaftTop, rb, rt, 3, m);
      // colarinho
      for (let dx = -Math.round(semi(rt)); dx <= Math.round(semi(rt)); dx++) px(dx, Math.round(ay - shaftTop * KZ + semi(rt) / 2 * Math.sqrt(Math.max(0, 1 - (dx * dx) / (semi(rt) ** 2)))) - 2, m[2]);
      if (order === 'doric') {
        disc(shaftTop + 0.06, rt * 1.25, m[1], o); disc(shaftTop + 0.13, rt * 1.55, m[1], o); disc(shaftTop + 0.15, rt * 1.5, m[0]); // equino em almofada
        isoBox(g, P, -cap, shaftTop + 0.15, -cap, cap, height, cap, m, o); // ábaco
      } else if (order === 'ionic') {
        disc(shaftTop + 0.05, rt * 1.2, m[1], o);
        // almofada (pulvino) com as duas volutas na face da frente
        isoBox(g, P, -cap, shaftTop + 0.05, -0.2, cap, height - 0.06, 0.2, m, o);
        for (const s of [-1, 1]) {
          const [cx, cy] = P(s * (cap - 0.1), shaftTop + 0.12, 0.2);
          blob(g, cx, cy, 4, 4, o); blob(g, cx, cy, 3, 3, m[0]); blob(g, cx, cy, 1, 1, m[2]); g.fillStyle = o; g.fillRect(cx, cy, 1, 1);
        }
        isoBox(g, P, -cap, height - 0.06, -cap, cap, height, cap, m, o); // ábaco fino
        for (const [vx, vz] of [[-cap, cap], [cap, -cap]]) { // volutas nas quinas laterais, sob o ábaco: a assinatura jônica
          const [cx, cy] = P(vx, height - 0.14, vz);
          blob(g, cx, cy, 4, 4, o); blob(g, cx, cy, 3, 3, m[0]); blob(g, cx + 1, cy, 1, 1, m[2]); g.fillStyle = o; g.fillRect(cx, cy, 1, 1);
        }
      } else {
        // coríntio: cesto em sino com duas fiadas de acanto e pequenas volutas nos cantos
        drum(shaftTop, height - 0.08, rt * 1.0, rt * 1.55, 0, m);
        const y0 = ay - shaftTop * KZ; const y1 = ay - (height - 0.08) * KZ;
        for (let row = 0; row < 2; row++) {
          const yy = Math.round(y0 - (y0 - y1) * (0.18 + row * 0.38)); const a = semi(rt) * (1.05 + row * 0.25);
          for (let k = -2; k <= 2; k++) {
            const lx = ax + Math.round((k / 2.5) * a); const c = row === 0 ? m[1] : m[0];
            g.fillStyle = o; g.fillRect(lx - 2, yy - 4, 5, 6); g.fillStyle = c; g.fillRect(lx - 1, yy - 3, 3, 4);
            g.fillStyle = row === 0 ? m[2] : t.gold; g.fillRect(lx, yy - 4, 1, 1); // ponta da folha
          }
        }
        for (const s of [-1, 1]) { const cx = ax + s * Math.round(semi(rt) * 1.55); const cy = Math.round(y1) + 1; blob(g, cx, cy, 2, 2, o); g.fillStyle = m[0]; g.fillRect(cx - 1, cy - 1, 2, 2); }
        isoBox(g, P, -cap, height - 0.08, -cap, cap, height, cap, m, o);
      }
    });
  });
}

// ---------------- frisos (face frontal +z ou lateral +x de uma viga/laje) ----------------
/**
 * Entablamento na face de uma laje ou viga: arquitrave, friso e cornija, no estilo da ordem de baixo.
 * Dórico: tríglifos e métopas lisas; jônico: três faixas, óvulos e dentículos; coríntio: idem com rosetas.
 */
export function entablature(g: CanvasRenderingContext2D, P: Proj, t: Theme, order: Order, y0: number, y1: number, face: 'front' | 'right', span: [number, number], at: number): void {
  const Q = (u: number, h: number): P2 => (face === 'front' ? P(u, h, at) : P(at, h, u));
  const quad = (a: number, b: number, h0: number, h1: number, c: string) => fillPoly(g, [Q(a, h1), Q(b, h1), Q(b, h0), Q(a, h0)], c);
  const base = face === 'front' ? t.stone[1] : t.stone[2];
  const dark = mix(base, t.outline, 0.45); const light = face === 'front' ? t.stone[0] : t.stone[1];
  const H = y1 - y0; const [u0, u1] = span;
  const aTop = y0 + H * 0.42; const fTop = y0 + H * 0.84;
  quad(u0, u1, y0, y1, base);
  line(g, Q(u0, aTop), Q(u1, aTop), light); // tênia
  quad(u0, u1, fTop, y1, light); // cornija
  line(g, Q(u0, fTop), Q(u1, fTop), dark);
  line(g, Q(u0, y1), Q(u1, y1), mix(light, '#ffffff', 0.3));
  if (order === 'doric') {
    for (let u = u0 + 0.35; u < u1 - 0.2; u += 0.8) {
      quad(u, u + 0.26, aTop + 0.03, fTop - 0.02, dark); // tríglifo
      for (const k of [0.09, 0.17]) line(g, Q(u + k, aTop + 0.05), Q(u + k, fTop - 0.04), mix(dark, base, 0.55));
      for (const k of [0.04, 0.13, 0.22]) { const [x, y] = Q(u + k, aTop - 0.02); g.fillStyle = dark; g.fillRect(x, y, 1, 1); } // gotas
      const [rx, ry] = Q(u + 0.53, (aTop + fTop) / 2); g.fillStyle = mix(base, t.outline, 0.25); g.fillRect(rx - 1, ry - 1, 2, 2); // relevo da métopa
    }
  } else {
    line(g, Q(u0, y0 + H * 0.14), Q(u1, y0 + H * 0.14), mix(base, light, 0.5)); // faixas da arquitrave
    line(g, Q(u0, y0 + H * 0.28), Q(u1, y0 + H * 0.28), mix(base, light, 0.5));
    for (let u = u0 + 0.1; u < u1 - 0.1; u += 0.22) { const [x, y] = Q(u, (aTop + fTop) / 2); g.fillStyle = light; g.fillRect(x - 1, y - 1, 2, 3); g.fillStyle = dark; g.fillRect(x + 1, y, 1, 2); } // óvulos e dardos
    for (let u = u0 + 0.05; u < u1 - 0.05; u += 0.16) { const [x, y] = Q(u, fTop); g.fillStyle = dark; g.fillRect(x, y + 1, RES, 1); } // dentículos
    if (order === 'corinthian') for (let u = u0 + 0.6; u < u1 - 0.3; u += 1.6) { const [x, y] = Q(u, (aTop + fTop) / 2); g.fillStyle = t.gold; g.fillRect(x - 1, y - 1, 3, 3); }
  }
}

/** Antefixas (palmetas de terracota) ao longo da beirada do topo. */
export function antefixes(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, face: 'front' | 'right', span: [number, number], at: number): void {
  for (let u = span[0] + 0.4; u < span[1] - 0.2; u += 0.8) {
    const [x, yy] = face === 'front' ? P(u, y, at) : P(at, y, u);
    g.fillStyle = t.outline; g.fillRect(x - 2, yy - 5, 5, 5);
    g.fillStyle = t.terracotta[0]; g.fillRect(x - 1, yy - 4, 3, 3); g.fillStyle = t.terracotta[2]; g.fillRect(x, yy - 2, 1, 2);
  }
}

// ---------------- meias-paredes ----------------
export interface WallPiece { sprite: Sprite; x: number; z: number; depth: number }
/**
 * Meia parede em segmentos de até 1 unidade (cada um ordenado com os personagens): rodapé na cor da sala,
 * faixa clara e capa de mármore. Salão: rodapé ameixa como as paredes; biblioteca: lambri de madeira.
 */
export function halfWallPieces(t: Theme, w: Wall, style: 'stoa' | 'biblioteca'): WallPiece[] {
  const alongX = w.x1 - w.x0 >= w.z1 - w.z0;
  const len = alongX ? w.x1 - w.x0 : w.z1 - w.z0;
  const n = Math.max(1, Math.ceil(len / 1.3)); const step = len / n;
  const H = 0.72; const thick = (alongX ? w.z1 - w.z0 : w.x1 - w.x0) * 0.8; // baixa e fina: separa sem esconder
  const out: WallPiece[] = [];
  for (let i = 0; i < n; i++) {
    const a = (alongX ? w.x0 : w.z0) + i * step; const b = a + step;
    const cx = alongX ? (a + b) / 2 : (w.x0 + w.x1) / 2; const cz = alongX ? (w.z0 + w.z1) / 2 : (a + b) / 2;
    const hx = alongX ? step / 2 : thick / 2; const hz = alongX ? thick / 2 : step / 2;
    const key = `${t.id}|hw|${style}|${hx.toFixed(3)}|${hz.toFixed(3)}`;
    const sprite = cached(key, () => fitSprite(-hx - 0.05, 0, -hz - 0.05, hx + 0.05, H, hz + 0.05, (g, P) => {
      const low: Tone = style === 'stoa' ? [t.dado, mix(t.dado, '#000000', 0.08), mix(t.dado, '#000000', 0.22)] : t.wood;
      isoBox(g, P, -hx, 0, -hz, hx, 0.4, hz, low, t.outline);
      isoBox(g, P, -hx, 0.4, -hz, hx, H - 0.08, hz, [t.wallBack, t.wallBack, t.wallSide], t.outline);
      line(g, P(-hx, 0.4, hz), P(hx, 0.4, hz), style === 'stoa' ? t.trim : t.bronze[1]);
      isoBox(g, P, -hx - 0.03, H - 0.08, -hz - 0.03, hx + 0.03, H, hz + 0.03, t.marble, t.outline);
      if (style === 'biblioteca') for (const f of [-0.5, 0, 0.5]) { // painéis do lambri
        if (alongX) line(g, P(f * hx, 0.06, hz), P(f * hx, 0.34, hz), mix(t.wood[1], '#000000', 0.25));
        else line(g, P(hx, 0.06, f * hz), P(hx, 0.34, f * hz), mix(t.wood[2], '#000000', 0.25));
      }
    }, 3 * RES));
    out.push({ sprite, x: cx, z: cz, depth: cx + cz });
  }
  return out;
}

// ---------------- parede lateral (+x) e parapeito ----------------
/**
 * Parede lateral direita de um andar (x = 7.7…8): inteira com janelas (e a porta do térreo), ou cortada à
 * meia altura quando o andar está em foco — o corte deixa ver o interior, como numa maquete.
 */
export function sideWall(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, h: number, cut: boolean, door: boolean, style: 'stoa' | 'biblioteca'): void {
  const x0 = 7.7; const x1 = 8.0; const zs: Array<[number, number]> = door ? [[-5, 3.3], [4.5, 5]] : [[-5, 5]];
  const top = cut ? 1.0 : h;
  const tone: Tone = [t.stone[0], t.wallSide, mix(t.wallSide, t.outline, 0.18)];
  for (const [z0, z1] of zs) isoBox(g, P, x0, y, z0, x1, y + top, z1, tone, t.outline);
  // rodapé e friso (como as paredes de dentro, pelo lado de fora)
  for (const [z0, z1] of zs) { sideQuad(g, P, x1, z0, z1, y, y + Math.min(0.35, top), mix(tone[2], t.outline, 0.12)); }
  if (cut) {
    for (const [z0, z1] of zs) isoBox(g, P, x0 - 0.03, y + top, z0, x1 + 0.03, y + top + 0.08, z1, t.marble, t.outline);
  } else {
    // janelas (lintel claro, abertura escura ou céu, peitoril e montante)
    const sky = style === 'biblioteca' ? t.sky : t.windowDark;
    for (const [z0, z1] of [[-3.4, -2.2], [-0.4, 0.8]] as Array<[number, number]>) {
      sideQuad(g, P, x1, z0 - 0.08, z1 + 0.08, y + 1.0, y + 2.15, t.outline);
      sideQuad(g, P, x1, z0, z1, y + 1.05, y + 2.05, sky);
      sideQuad(g, P, x1, z0 - 0.12, z1 + 0.12, y + 2.05, y + 2.2, t.stone[0]);
      sideQuad(g, P, x1, z0 - 0.06, z1 + 0.06, y + 0.95, y + 1.05, t.stone[1]);
      line(g, P(x1, y + 1.05, (z0 + z1) / 2), P(x1, y + 2.05, (z0 + z1) / 2), t.stone[1]);
    }
    if (door) { // vão da porta lateral com verga
      sideQuad(g, P, x1, 3.3, 4.5, y + 2.2, y + 2.4, t.stone[0]);
      isoBox(g, P, x0, y + 2.2, 3.3, x1, y + h, 4.5, tone, t.outline);
      sideQuad(g, P, x1, 3.3, 4.5, y + 2.2, y + 2.38, t.stone[0]);
    }
    line(g, P(x1, y + h - 0.02, -5), P(x1, y + h - 0.02, 5), t.stone[0]);
  }
  if (door) { // soleira
    flatQuad(g, P, y + 0.01, x0, 3.3, x1, 4.5, t.stone[0]);
    if (cut) for (const z of [3.3, 4.5]) isoBox(g, P, x0 - 0.02, y, z - 0.08, x1 + 0.02, y + 1.15, z + 0.08, t.marble, t.outline);
  }
}

/** Parapeito da varanda (andares de cima): meia parede de mármore entre as colunas da frente. */
export function parapet(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, cols: number[], colR: number): void {
  const xs = [-8, ...cols.flatMap((c) => [c - colR, c + colR]), 8];
  for (let i = 0; i < xs.length; i += 2) {
    const a = xs[i]; const b = xs[i + 1]; if (b - a < 0.1) continue;
    isoBox(g, P, a, y, 4.72, b, y + 0.82, 4.98, [t.stone[0], t.stone[1], t.stone[2]], t.outline);
    line(g, P(a + 0.12, y + 0.18, 4.98), P(b - 0.12, y + 0.18, 4.98), mix(t.stone[1], t.outline, 0.25)); // moldura do painel
    line(g, P(a + 0.12, y + 0.66, 4.98), P(b - 0.12, y + 0.66, 4.98), t.stone[0]);
    isoBox(g, P, a - 0.02, y + 0.82, 4.69, b + 0.02, y + 0.92, 5.01, t.marble, t.outline);
  }
}

// ---------------- móveis da biblioteca ----------------
/** Mesa de leitura com tampo inclinado (atril) e rolos empilhados — distinta das mesas do salão. */
export function readingDeskSprite(t: Theme, variant: number): Sprite {
  return cached(`${t.id}|rdesk|${variant % 2}`, () => fitSprite(-0.75, 0, -0.45, 0.75, 1.2, 0.45, (g, P) => {
    const top = 0.66; const y2 = top + 0.08;
    for (const [lx, lz] of [[-0.62, -0.34], [0.54, -0.34], [-0.62, 0.26], [0.54, 0.26]]) isoBox(g, P, lx, 0, lz, lx + 0.08, top, lz + 0.08, t.woodDark, t.outline);
    line(g, P(-0.58, 0.18, 0.3), P(0.58, 0.18, 0.3), t.woodDark[1]); // travessa
    isoBox(g, P, -0.72, top, -0.42, 0.72, y2, 0.42, t.woodDark, t.outline);
    // atril inclinado com papiro aberto
    fillPoly(g, [P(-0.5, y2 + 0.22, -0.2), P(0.1, y2 + 0.22, -0.2), P(0.1, y2 + 0.02, 0.2), P(-0.5, y2 + 0.02, 0.2)], t.outline);
    fillPoly(g, [P(-0.47, y2 + 0.2, -0.17), P(0.07, y2 + 0.2, -0.17), P(0.07, y2 + 0.04, 0.17), P(-0.47, y2 + 0.04, 0.17)], t.papyrus[0]);
    for (const k of [0.3, 0.55, 0.8]) line(g, P(-0.42, y2 + 0.2 - k * 0.16, -0.17 + k * 0.34), P(0.02, y2 + 0.2 - k * 0.16, -0.17 + k * 0.34), t.papyrus[1]);
    // pilha de rolos
    const rolls = variant % 2 ? [[0.35, -0.2], [0.5, -0.2], [0.42, -0.2]] : [[0.32, 0.05], [0.47, 0.05], [0.4, -0.18]];
    rolls.forEach(([x, z], i) => isoBox(g, P, x - 0.06, y2 + (i === 2 ? 0.08 : 0), z - 0.2, x + 0.06, y2 + (i === 2 ? 0.16 : 0.08), z + 0.2, [t.papyrus[0], t.papyrus[1], t.papyrus[1]], t.outline));
  }));
}

/** Cadeira klismos (encosto curvo) — visível atrás de quem lê na biblioteca. */
export function klismosSprite(t: Theme): Sprite {
  return cached(`${t.id}|klismos`, () => fitSprite(-0.3, 0, -0.3, 0.3, 1.05, 0.3, (g, P) => {
    line(g, P(-0.2, 0, 0.2), P(-0.18, 0.4, 0.16), t.woodDark[0]); line(g, P(0.2, 0, 0.2), P(0.18, 0.4, 0.16), t.woodDark[1]);
    line(g, P(-0.2, 0, -0.22), P(-0.18, 0.4, -0.18), t.woodDark[1]); line(g, P(0.2, 0, -0.22), P(0.18, 0.4, -0.18), t.woodDark[2]);
    isoBox(g, P, -0.24, 0.38, -0.22, 0.24, 0.45, 0.22, t.wood, t.outline);
    isoBox(g, P, -0.24, 0.68, -0.26, 0.24, 0.86, -0.2, t.wood, t.outline); // encosto
    for (const x of [-0.18, 0.18]) line(g, P(x, 0.45, -0.22), P(x, 0.7, -0.24), t.woodDark[0]);
  }));
}

/** Mesa redonda do conselho com coroa de louros pintada no tampo. */
export function roundTableSprite(t: Theme): Sprite {
  return cached(`${t.id}|rtable`, () => fitSprite(-0.8, 0, -0.8, 0.8, 1.0, 0.8, (g, P) => {
    const [cx, cy] = P(0, 0, 0);
    isoBox(g, P, -0.12, 0, -0.12, 0.12, 0.66, 0.12, t.woodDark, t.outline); // pé central
    isoBox(g, P, -0.34, 0, -0.34, 0.34, 0.06, 0.34, t.woodDark, t.outline);
    const A = Math.round(semi(0.74)); const B = Math.round(A / 2); const ty = cy - Math.round(0.72 * KZ);
    blob(g, cx, ty + 2, A + 1, B + 1, t.outline); blob(g, cx, ty + 2, A, B, t.woodDark[2]);
    blob(g, cx, ty, A + 1, B + 1, t.outline); blob(g, cx, ty, A, B, t.wood[0]); blob(g, cx - 2, ty - 1, A - 6, B - 3, mix(t.wood[0], '#ffffff', 0.08));
    for (let a = 0; a < 360; a += 30) { const r = (a * Math.PI) / 180; g.fillStyle = a % 60 ? t.olive[0] : t.gold; g.fillRect(cx + Math.round(Math.cos(r) * A * 0.55), ty + Math.round(Math.sin(r) * B * 0.55), RES, 1); }
  }));
}

/** Estante alta de pergaminhos (parede do fundo da biblioteca): nichos com rolos. */
export function backShelves(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, x0: number, x1: number, zb: number): void {
  const d = 0.42; const h = 2.35;
  isoBox(g, P, x0, y, zb, x1, y + h, zb + d, t.woodDark, t.outline);
  const cols = Math.floor((x1 - x0) / 0.5);
  for (let r = 0; r < 4; r++) for (let c = 0; c < cols; c++) {
    const a = x0 + 0.08 + c * ((x1 - x0 - 0.16) / cols); const b = a + (x1 - x0 - 0.16) / cols - 0.07;
    const h0 = y + 0.14 + r * 0.55; const h1 = h0 + 0.44;
    backQuad(g, P, zb + d, a, b, h0, h1, '#20160f');
    for (const [dx, dh] of [[0.1, 0.1], [0.25, 0.1], [0.17, 0.24], [0.33, 0.24]]) {
      if (((r * 7 + c * 3 + dx * 10) | 0) % 6 === 0 || a + dx > b - 0.04) continue;
      const [px, py] = P(a + dx, h0 + dh, zb + d); g.fillStyle = t.papyrus[0]; g.fillRect(px - RES, py - 1, 2 * RES, RES + 1); g.fillStyle = t.papyrus[1]; g.fillRect(px, py, 1, 1);
    }
  }
  line(g, P(x0, y + h, zb + d), P(x1, y + h, zb + d), t.wood[0]);
}

/** Mapa de Eratóstenes pintado na parede (bibliotecário de Alexandria): oikoumene com meridianos. */
export function wallMap(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, x0: number, x1: number, zb: number): void {
  const Q = (u: number, h: number) => P(x0 + (x1 - x0) * u, y + h, zb);
  fillPoly(g, [Q(-0.02, 2.42), Q(1.02, 2.42), Q(1.02, 1.08), Q(-0.02, 1.08)], t.woodDark[1]);
  fillPoly(g, [Q(0, 2.36), Q(1, 2.36), Q(1, 1.14), Q(0, 1.14)], t.papyrus[0]);
  for (const u of [0.2, 0.4, 0.6, 0.8]) line(g, Q(u, 2.32), Q(u, 1.18), t.papyrus[1]);
  for (const h of [1.5, 1.9]) line(g, Q(0.03, h), Q(0.97, h), t.papyrus[1]);
  // terras (manchas) e o mar
  const land = mix(t.olive[0], t.papyrus[0], 0.35);
  for (const [u, h, w, hh] of [[0.12, 1.95, 0.3, 0.25], [0.45, 2.05, 0.35, 0.2], [0.55, 1.45, 0.25, 0.22], [0.2, 1.4, 0.18, 0.18]] as const) {
    fillPoly(g, [Q(u, h + hh), Q(u + w, h + hh), Q(u + w, h), Q(u, h)], land);
  }
  line(g, Q(0.08, 1.72), Q(0.92, 1.8), t.teal[1]);
  const [ax, ay] = Q(0.5, 1.62); g.fillStyle = t.terracotta[1]; g.fillRect(ax - 1, ay - 1, RES + 1, RES + 1); // Alexandria
}

/** Janela na parede esquerda (x constante) da biblioteca. */
export function leftWindow(g: CanvasRenderingContext2D, P: Proj, t: Theme, y: number, x: number, z0: number, z1: number): void {
  sideQuad(g, P, x, z0 - 0.08, z1 + 0.08, y + 1.0, y + 2.15, t.outline);
  sideQuad(g, P, x, z0, z1, y + 1.05, y + 2.05, t.sky);
  line(g, P(x, y + 1.6, z0), P(x, y + 1.6, z1), mix(t.sky, '#ffffff', 0.35)); // horizonte
  sideQuad(g, P, x, z0 - 0.12, z1 + 0.12, y + 2.05, y + 2.2, t.stone[0]);
  sideQuad(g, P, x, z0 - 0.06, z1 + 0.06, y + 0.95, y + 1.05, t.stone[1]);
  line(g, P(x, y + 1.05, (z0 + z1) / 2), P(x, y + 2.05, (z0 + z1) / 2), t.stone[1]);
}

/** Barra em meandro (grega) no piso: tapetes. Desenhada em unidades do piso. */
export function meanderBand(g: CanvasRenderingContext2D, P: Proj, y: number, x0: number, z0: number, x1: number, z1: number, color: string): void {
  const unit = 0.36;
  const along = (a: [number, number], b: [number, number]) => line(g, P(a[0], y, a[1]), P(b[0], y, b[1]), color);
  // ao longo de x (bordas de cima e de baixo)
  for (const [z, s] of [[z0, 1], [z1, -1]] as const) for (let x = x0; x + unit <= x1 + 1e-6; x += unit) {
    const h = 0.16 * s;
    along([x, z], [x, z + h]); along([x, z + h], [x + unit * 0.66, z + h]); along([x + unit * 0.66, z + h], [x + unit * 0.66, z + h * 0.45]);
    along([x + unit * 0.33, z + h * 0.45], [x + unit * 0.66, z + h * 0.45]);
  }
  for (const [x, s] of [[x0, 1], [x1, -1]] as const) for (let z = z0; z + unit <= z1 + 1e-6; z += unit) {
    const h = 0.16 * s;
    along([x, z], [x + h, z]); along([x + h, z], [x + h, z + unit * 0.66]); along([x + h, z + unit * 0.66], [x + h * 0.45, z + unit * 0.66]);
    along([x + h * 0.45, z + unit * 0.33], [x + h * 0.45, z + unit * 0.66]);
  }
}

/** Polígono de clique de uma caixa vertical (silhueta projetada). */
export function boxHit(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): P2[] {
  return [project(x0, y1, z0), project(x1, y1, z0), project(x1, y0, z0), project(x1, y0, z1), project(x0, y0, z1), project(x0, y1, z1)];
}
export { shade };
