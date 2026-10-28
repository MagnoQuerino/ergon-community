/**
 * Paisagem das skins (shared/skin.ts → decoração): arranha-céu, poste, letreiro de néon, palmeira, guarda-sol, cacto,
 * barraca, caixotes, sacos de areia, torre de vigia, cogumelo, árvore anciã, cristal, menir, casinha e cerejeira.
 * Todos com as cores do tema (a mesma peça muda de dia para noite e de skin para skin) e caixa no mundo para a ordem
 * de desenho. Desenhados uma vez por tema e variação.
 */
import { RES } from './projection.ts';
import { fillPoly, isoBox, line, type Proj } from './raster.ts';
import { blob, fitSprite, type Sprite } from './props.ts';
import { mix, shade, type Theme } from './theme.ts';

const cache = new Map<string, Sprite>();
function cached(key: string, make: () => Sprite): Sprite { let s = cache.get(key); if (!s) { s = make(); cache.set(key, s); if (cache.size > 400) cache.delete(cache.keys().next().value!); } return s; }
const tone = (c: string): [string, string, string] => [shade(c, 0.14), c, shade(c, -0.24)];
const night = (t: Theme) => !!t.skin?.night;
const px = (g: CanvasRenderingContext2D, P: Proj, x: number, y: number, z: number, c: string, w = 1, h = 1) => { const [a, b] = P(x, y, z); g.fillStyle = c; g.fillRect(a, b, w * RES, h * RES); };

/** Arranha-céu (fundo da cidade grande): altura pela variação, janelas em grade, acesas à noite. */
function tower(t: Theme, k: number, v: number): Sprite {
  const h = Math.round((5 + k * 4 + (v % 3)) * 2) / 2;
  return cached(`${t.id}|tower|${h}|${v % 3}`, () => fitSprite(-0.9, 0, -0.9, 0.9, h + 0.6, 0.9, (g, P) => {
    const wall = [t.wallBack, t.houseWall[1], t.stone[1]][v % 3];
    isoBox(g, P, -0.8, 0, -0.8, 0.8, h, 0.8, tone(wall), t.outline);
    const lit = night(t);
    for (let y = 0.4; y < h - 0.3; y += 0.45) for (let u = -0.6; u <= 0.6; u += 0.4) {
      const on = lit ? (Math.floor(y * 7 + u * 13 + v) % 3 !== 0) : false;
      px(g, P, u, y + 0.3, 0.81, on ? t.window : mix(t.window, t.outline, 0.25));
      px(g, P, 0.81, y + 0.3, -u, on ? mix(t.window, t.outline, 0.15) : mix(t.windowDark, t.outline, 0.2));
    }
    isoBox(g, P, -0.85, h, -0.85, 0.85, h + 0.12, 0.85, tone(t.roof[1]), t.outline);
    if (t.skin?.arch.trim === 'neon') { line(g, P(0.81, 0.2, 0.81), P(0.81, h, 0.81), t.teal[0]); line(g, P(-0.8, h - 0.1, 0.81), P(0.8, h - 0.1, 0.81), t.banner[0]); }
    if (v % 3 === 1) { line(g, P(0, h + 0.12, 0), P(0, h + 0.6, 0), t.outline); px(g, P, 0, h + 0.6, 0, t.terracotta[0]); }
  }));
}

function lamppost(t: Theme): Sprite {
  return cached(`${t.id}|lamppost`, () => fitSprite(-0.3, 0, -0.3, 0.3, 2.6, 0.3, (g, P) => {
    line(g, P(0, 0, 0), P(0, 2.2, 0), t.outline); line(g, P(0.03, 0, 0), P(0.03, 2.2, 0), mix(t.trim, t.outline, 0.4));
    line(g, P(0, 2.2, 0), P(0.3, 2.3, 0), t.outline);
    const [lx, ly] = P(0.3, 2.22, 0);
    if (night(t)) { g.globalAlpha = 0.28; blob(g, lx, ly + 3 * RES, 7 * RES, 4 * RES, t.flame[0]); g.globalAlpha = 1; }
    blob(g, lx, ly, 2 * RES, RES + 1, t.outline); blob(g, lx, ly, 2 * RES - 1, RES, night(t) ? t.flame[0] : mix(t.flame[0], t.marble[0], 0.5));
  }));
}

function neonSign(t: Theme, v: number): Sprite {
  return cached(`${t.id}|neon|${v % 3}`, () => fitSprite(-0.35, 0, -0.2, 0.35, 2.9, 0.2, (g, P) => {
    line(g, P(0, 0, 0), P(0, 1.2, 0), t.outline);
    isoBox(g, P, -0.25, 1.2, -0.06, 0.25, 2.8, 0.06, [t.outline, t.outline, t.outline]);
    const A = v % 2 ? t.banner[0] : t.teal[0]; const B = v % 2 ? t.teal[0] : t.banner[0];
    for (let y = 1.3; y < 2.7; y += 0.08) { px(g, P, -0.22, y, 0.07, A); px(g, P, 0.22, y, 0.07, A); }
    for (let k = 0; k < 4; k++) { const y = 1.45 + k * 0.32; line(g, P(-0.12, y, 0.07), P(0.12, y + (k % 2 ? 0.12 : 0), 0.07), B); }
    if (night(t)) { const [cx, cy] = P(0, 2, 0.07); g.globalAlpha = 0.18; blob(g, cx, cy, 8 * RES, 12 * RES, A); g.globalAlpha = 1; }
  }));
}

function palm(t: Theme, k: number, v: number): Sprite {
  const h = 2.6 + k * 0.8;
  return cached(`${t.id}|palm|${h.toFixed(1)}|${v % 3}`, () => fitSprite(-1.4, 0, -1.4, 1.4, h + 0.6, 1.4, (g, P) => {
    const lean = ((v % 3) - 1) * 0.35;
    let prev = P(0, 0, 0);
    for (let i = 1; i <= 10; i++) { const f = i / 10; const cur = P(lean * f * f, h * f, 0); line(g, prev, cur, i % 2 ? t.wood[1] : t.wood[2]); line(g, [prev[0] + 1, prev[1]], [cur[0] + 1, cur[1]], t.wood[0]); prev = cur; }
    const [cx, cy] = P(lean, h, 0);
    for (const [dx, dy] of [[-12, 4], [12, 4], [-8, -3], [9, -4], [0, -6], [-14, 8], [14, 8]] as const) {
      for (let s = 0; s <= 6; s++) { const f = s / 6; g.fillStyle = s < 3 ? t.olive[0] : t.olive[1]; g.fillRect(cx + Math.round(dx * RES * f), cy + Math.round(dy * RES * f + (f * f) * 4 * RES), 2 * RES, RES); }
    }
    blob(g, cx, cy + RES, 2 * RES, RES + 1, t.woodDark[1]);
  }));
}

function parasol(t: Theme, v: number): Sprite {
  return cached(`${t.id}|parasol|${v % 3}`, () => fitSprite(-1, 0, -1, 1, 2.2, 1, (g, P) => {
    fillPoly(g, [P(-0.5, 0, 0.1), P(0.4, 0, 0.1), P(0.4, 0, 0.6), P(-0.5, 0, 0.6)], v % 2 ? t.teal[0] : t.banner[0]);
    line(g, P(0, 0, 0), P(0, 1.8, 0), t.outline);
    const [cx, cy] = P(0, 1.8, 0);
    const cols = [t.teal[0], t.papyrus[0]];
    for (let i = -9; i <= 9; i++) { const w = Math.round(Math.sqrt(Math.max(0, 81 - i * i)) * 0.45); g.fillStyle = cols[Math.floor((i + 9) / 3) % 2]; g.fillRect(cx + i * RES, cy - w * RES / 2 + 2 * RES, RES, Math.max(1, w * RES / 2)); }
    g.fillStyle = t.outline; g.fillRect(cx - 9 * RES, cy + 2 * RES, 19 * RES, 1);
  }));
}

function cactus(t: Theme, k: number): Sprite {
  const h = 1.3 + k * 0.5;
  return cached(`${t.id}|cactus|${h.toFixed(1)}`, () => fitSprite(-0.6, 0, -0.3, 0.6, h + 0.2, 0.3, (g, P) => {
    const C = tone(mix(t.olive[1], '#3f7a3a', 0.4));
    isoBox(g, P, -0.12, 0, -0.12, 0.12, h, 0.12, C, t.outline);
    isoBox(g, P, -0.42, h * 0.45, -0.08, -0.12, h * 0.55, 0.08, C, t.outline); isoBox(g, P, -0.42, h * 0.45, -0.08, -0.3, h * 0.8, 0.08, C, t.outline);
    isoBox(g, P, 0.12, h * 0.3, -0.08, 0.4, h * 0.4, 0.08, C, t.outline); isoBox(g, P, 0.28, h * 0.3, -0.08, 0.4, h * 0.62, 0.08, C, t.outline);
  }));
}

function tent(t: Theme, v: number): Sprite {
  return cached(`${t.id}|tent|${v % 2}`, () => fitSprite(-1.1, 0, -0.9, 1.1, 1.4, 0.9, (g, P) => {
    const C: [string, string, string] = v % 2 ? [t.olive[0], t.olive[1], mix(t.olive[1], t.outline, 0.25)] : [t.sand[0], t.sand[1], mix(t.sand[1], t.outline, 0.25)];
    const L: [number, number, number][] = [[-1, 0, -0.8], [1, 0, -0.8], [1, 1.2, 0], [-1, 1.2, 0]];
    const F: [number, number, number][] = [[-1, 0, 0.8], [1, 0, 0.8], [1, 1.2, 0], [-1, 1.2, 0]];
    fillPoly(g, L.map(([x, y, z]) => P(x, y, z)), C[1]); fillPoly(g, F.map(([x, y, z]) => P(x, y, z)), C[0]);
    fillPoly(g, [P(1, 0, -0.8), P(1, 0, 0.8), P(1, 1.2, 0)], C[2]);
    fillPoly(g, [P(0.75, 0, 0.8), P(1, 0, 0.8), P(1, 0.3, 0.6)], t.outline);
    line(g, P(-1, 1.2, 0), P(1, 1.2, 0), t.outline);
  }));
}

function crates(t: Theme, v: number): Sprite {
  return cached(`${t.id}|crates|${v % 3}`, () => fitSprite(-0.8, 0, -0.6, 0.8, 1.4, 0.6, (g, P) => {
    isoBox(g, P, -0.7, 0, -0.5, 0, 0.6, 0.2, t.wood, t.outline); isoBox(g, P, 0.05, 0, -0.3, 0.7, 0.55, 0.4, t.wood, t.outline);
    if (v % 3 !== 1) isoBox(g, P, -0.5, 0.6, -0.4, 0.1, 1.15, 0.15, t.woodDark, t.outline);
    for (const [x0, x1, y] of [[-0.7, 0, 0.3], [0.05, 0.7, 0.28]] as const) line(g, P(x0, y, 0.2), P(x1, y, 0.2), t.woodDark[2]);
  }));
}

function sandbags(t: Theme): Sprite {
  return cached(`${t.id}|sandbags`, () => fitSprite(-1, 0, -0.4, 1, 0.8, 0.4, (g, P) => {
    const B = [mix(t.sand[0], t.olive[0], 0.25), mix(t.sand[1], t.olive[1], 0.25)];
    for (const [row, n] of [[0, 4], [1, 3]] as const) for (let i = 0; i < n; i++) {
      const [cx, cy] = P(-0.75 + i * 0.5 + row * 0.25, 0.18 + row * 0.3, 0); blob(g, cx, cy, 5 * RES + 1, 2 * RES + 1, t.outline); blob(g, cx, cy, 5 * RES, 2 * RES, B[(i + row) % 2]);
    }
  }));
}

function watchtower(t: Theme): Sprite {
  return cached(`${t.id}|watchtower`, () => fitSprite(-0.9, 0, -0.9, 0.9, 3.8, 0.9, (g, P) => {
    for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) line(g, P(x, 0, z), P(x * 0.8, 2.6, z * 0.8), t.woodDark[1]);
    line(g, P(-0.6, 1.2, 0.6), P(0.6, 1.2, 0.6), t.woodDark[2]); line(g, P(0.6, 1.2, -0.6), P(0.6, 1.2, 0.6), t.woodDark[2]);
    isoBox(g, P, -0.7, 2.6, -0.7, 0.7, 3.1, 0.7, t.wood, t.outline);
    fillPoly(g, [P(-0.8, 3.4, -0.8), P(0.8, 3.4, -0.8), P(0.8, 3.4, 0.8), P(-0.8, 3.4, 0.8)], t.roof[1]);
    for (const [x, z] of [[-0.7, 0.7], [0.7, 0.7], [0.7, -0.7]]) line(g, P(x, 3.1, z), P(x, 3.4, z), t.woodDark[1]);
  }));
}

function mushroom(t: Theme, k: number, v: number): Sprite {
  const h = 0.7 + k * 0.8;
  return cached(`${t.id}|mushroom|${h.toFixed(1)}|${v % 3}`, () => fitSprite(-0.9, 0, -0.9, 0.9, h + 0.7, 0.9, (g, P) => {
    isoBox(g, P, -0.12, 0, -0.12, 0.12, h, 0.12, t.marble, t.outline);
    const cap = [t.terracotta[0], t.banner[0], t.teal[0]][v % 3];
    const [cx, cy] = P(0, h + 0.15, 0); const r = Math.round((7 + k * 4) * RES);
    blob(g, cx, cy, r + 1, Math.round(r * 0.55) + 1, t.outline); blob(g, cx, cy, r, Math.round(r * 0.55), cap); blob(g, cx - RES, cy - 2 * RES, r - 3 * RES, Math.round(r * 0.3), shade(cap, 0.18));
    g.fillStyle = '#f6f0e4'; for (let i = 0; i < 5; i++) g.fillRect(cx + ((i * 37) % (2 * r) - r) * 0.7, cy - ((i * 19) % Math.max(1, r)) * 0.4, 2 * RES, RES);
    if (night(t) && v % 3 === 2) { g.globalAlpha = 0.2; blob(g, cx, cy, r + 6 * RES, r, cap); g.globalAlpha = 1; }
  }));
}

function bigtree(t: Theme, k: number): Sprite {
  const h = 3.6 + k;
  return cached(`${t.id}|bigtree|${h.toFixed(1)}`, () => fitSprite(-1.8, 0, -1.8, 1.8, h + 1, 1.8, (g, P) => {
    isoBox(g, P, -0.3, 0, -0.3, 0.3, h * 0.55, 0.3, t.woodDark, t.outline);
    line(g, P(-0.3, 0, 0.3), P(-0.6, 0, 0.6), t.woodDark[1]); line(g, P(0.3, 0, 0.3), P(0.6, 0, 0.5), t.woodDark[1]);
    const [cx, cy] = P(0, h * 0.75, 0);
    for (const [x, y, rx, ry] of [[-9, 3, 9, 6], [9, 2, 9, 6], [0, -5, 11, 7], [-3, 7, 8, 4]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES + 1, ry * RES + 1, t.outline);
    for (const [x, y, rx, ry] of [[-9, 3, 9, 6], [9, 2, 9, 6], [0, -5, 11, 7], [-3, 7, 8, 4]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES, ry * RES, t.cypress[1]);
    for (const [x, y, rx, ry] of [[-10, 1, 5, 3], [-1, -7, 7, 3]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES, ry * RES, t.cypress[0]);
  }));
}

function crystal(t: Theme, k: number): Sprite {
  const s = 0.8 + k * 0.4;
  return cached(`${t.id}|crystal|${s.toFixed(1)}`, () => fitSprite(-0.6, 0, -0.6, 0.6, 1.6 * s + 0.2, 0.6, (g, P) => {
    for (const [x, z, h, w] of [[0, 0, 1.5, 0.18], [-0.28, 0.1, 0.9, 0.13], [0.26, -0.05, 1.1, 0.14]] as const) {
      const hh = h * s;
      fillPoly(g, [P(x - w, 0, z), P(x + w, 0, z), P(x + w, hh * 0.8, z), P(x, hh, z), P(x - w, hh * 0.8, z)], t.outline);
      fillPoly(g, [P(x - w + 0.03, 0.02, z), P(x, 0.02, z), P(x, hh - 0.05, z), P(x - w + 0.03, hh * 0.8 - 0.02, z)], shade(t.teal[0], 0.2));
      fillPoly(g, [P(x, 0.02, z), P(x + w - 0.03, 0.02, z), P(x + w - 0.03, hh * 0.8 - 0.02, z), P(x, hh - 0.05, z)], t.teal[1]);
    }
    if (night(t)) { const [cx, cy] = P(0, 0.8 * s, 0); g.globalAlpha = 0.18; blob(g, cx, cy, 9 * RES, 9 * RES, t.teal[0]); g.globalAlpha = 1; }
  }));
}

function menhir(t: Theme, k: number): Sprite {
  const h = 1.4 + k * 0.6;
  return cached(`${t.id}|menhir|${h.toFixed(1)}`, () => fitSprite(-0.5, 0, -0.5, 0.5, h + 0.2, 0.5, (g, P) => {
    isoBox(g, P, -0.25, 0, -0.18, 0.25, h, 0.18, t.stone, t.outline);
    for (const y of [0.5, 0.8, 1.1]) if (y < h - 0.1) px(g, P, 0, y, 0.19, night(t) ? t.teal[0] : t.stone[2], 1, 2);
  }));
}

function cottage(t: Theme, v: number): Sprite {
  return cached(`${t.id}|cottage|${v % 3}`, () => fitSprite(-0.9, 0, -0.8, 0.9, 2.1, 0.8, (g, P) => {
    isoBox(g, P, -0.7, 0, -0.6, 0.7, 0.9, 0.6, t.houseWall, t.outline);
    const R = t.roof;
    fillPoly(g, [P(-0.8, 0.9, -0.7), P(-0.8, 0.9, 0.7), P(0, 1.6, 0.7), P(0, 1.6, -0.7)], R[0]);
    fillPoly(g, [P(0, 1.6, -0.7), P(0, 1.6, 0.7), P(0.8, 0.9, 0.7), P(0.8, 0.9, -0.7)], R[2]);
    fillPoly(g, [P(-0.7, 0.9, 0.61), P(0.7, 0.9, 0.61), P(0, 1.55, 0.61)], t.houseWall[1]);
    const lit = night(t) ? t.window : mix(t.window, t.houseWall[0], 0.3);
    px(g, P, -0.35, 0.65, 0.61, t.outline, 3, 3); px(g, P, -0.33, 0.62, 0.62, lit, 2, 2);
    isoBox(g, P, 0.15, 0, 0.55, 0.45, 0.6, 0.61, t.woodDark);
    if (v % 3 !== 2) isoBox(g, P, 0.35, 1.2, -0.3, 0.55, 1.8, -0.1, t.terracotta, t.outline);
  }));
}

function cherry(t: Theme, k: number): Sprite {
  const h = 2.2 + k * 0.6;
  return cached(`${t.id}|cherry|${h.toFixed(1)}`, () => fitSprite(-1.3, 0, -1.3, 1.3, h + 0.8, 1.3, (g, P) => {
    line(g, P(0, 0, 0), P(0.05, h * 0.6, 0), t.woodDark[1]); line(g, P(0.04, 0, 0), P(0.09, h * 0.6, 0), t.woodDark[0]); line(g, P(0.05, h * 0.5, 0), P(-0.4, h * 0.75, 0), t.woodDark[1]);
    const pink = mix('#f2b8c8', t.olive[0], 0.12); const deep = mix('#d88aa0', t.outline, 0.1);
    const [cx, cy] = P(0, h * 0.85, 0);
    for (const [x, y, rx, ry] of [[-6, 1, 7, 4], [6, 0, 7, 4], [0, -4, 8, 5]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES + 1, ry * RES + 1, t.outline);
    for (const [x, y, rx, ry] of [[-6, 1, 7, 4], [6, 0, 7, 4], [0, -4, 8, 5]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES, ry * RES, deep);
    for (const [x, y, rx, ry] of [[-7, -1, 4, 2], [1, -6, 5, 3], [6, -2, 4, 2]] as const) blob(g, cx + x * RES, cy + y * RES, rx * RES, ry * RES, pink);
    g.fillStyle = pink; for (let i = 0; i < 6; i++) g.fillRect(cx + ((i * 23) % 26 - 13) * RES, cy + 9 * RES + (i % 3) * RES, RES, RES);
  }));
}

/** Sprite e altura de um objeto novo da paisagem; null = não é um dos objetos das skins. */
export function skinDecor(kind: string, t: Theme, k: number, v: number): { sprite: Sprite; r: number; h: number } | null {
  switch (kind) {
    case 'tower': { const s = tower(t, k, v); return { sprite: s, r: 0.8, h: 5 + k * 4 + (v % 3) }; }
    case 'lamppost': return { sprite: lamppost(t), r: 0.15, h: 2.4 };
    case 'neon': return { sprite: neonSign(t, v), r: 0.25, h: 2.8 };
    case 'palm': return { sprite: palm(t, k, v), r: 0.25, h: 3 + k };
    case 'parasol': return { sprite: parasol(t, v), r: 0.5, h: 2 };
    case 'cactus': return { sprite: cactus(t, k), r: 0.3, h: 1.6 + k * 0.5 };
    case 'tent': return { sprite: tent(t, v), r: 0.9, h: 1.2 };
    case 'crates': return { sprite: crates(t, v), r: 0.6, h: 1.1 };
    case 'sandbags': return { sprite: sandbags(t), r: 0.8, h: 0.6 };
    case 'watchtower': return { sprite: watchtower(t), r: 0.7, h: 3.4 };
    case 'mushroom': return { sprite: mushroom(t, k, v), r: 0.4, h: 1.2 + k };
    case 'bigtree': return { sprite: bigtree(t, k), r: 0.4, h: 4.5 + k };
    case 'crystal': return { sprite: crystal(t, k), r: 0.35, h: 1.5 };
    case 'menhir': return { sprite: menhir(t, k), r: 0.3, h: 1.6 + k * 0.6 };
    case 'cottage': return { sprite: cottage(t, v), r: 0.75, h: 1.8 };
    case 'cherry': return { sprite: cherry(t, k), r: 0.25, h: 3 + k * 0.6 };
    default: return null;
  }
}
