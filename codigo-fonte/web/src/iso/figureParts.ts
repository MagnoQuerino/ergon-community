/**
 * Partes dos bonecos que vêm das skins (shared/skin.ts): roupa montada por peças (parte de cima, de baixo, mangas,
 * calçado e um detalhe), espécies (orelhas de elfo, presas de orc, nariz de duende), acessórios de rosto, cabelos,
 * chapéus e objetos novos. Desenha na mesma grade de figures.ts (26×46 úteis, cabeça no alto), pelas mesmas funções de
 * pintar; as coordenadas seguem as de lá. Cada parte nova do vocabulário ganha o desenho aqui.
 */
import type { SkinBottom, SkinFace, SkinTop, Species } from '../../../shared/skin.ts';
import { mix, shade } from './theme.ts';

export interface Pen {
  put(x: number, y: number, c: string): void;
  rect(x: number, y: number, w: number, h: number, c: string): void;
  span(y: number, x0: number, x1: number, c: string): void;
}
/** roupa resolvida: cores já escolhidas (a do agente entra onde a skin pediu 'agente') */
export interface Kit {
  top: SkinTop; bottom: SkinBottom; sleeves: 'long' | 'short' | 'none'; shoes: 'shoes' | 'boots' | 'sneakers' | 'sandals' | 'bare';
  detail: 'none' | 'tie' | 'camo' | 'neon' | 'stripes' | 'belt' | 'cape' | 'trim' | 'dots' | 'apron';
  T: [string, string]; B: [string, string]; A: string;
  /** cor do agente num distintivo no peito, quando a roupa não usa a cor dele */
  badge: string | null;
}
export interface Extra { species: Species; face: SkinFace; hat: [string, string] | null; kit: Kit | null }

const DARK = '#2b2b33';
const LEATHER = '#4a3a28';

/** Capa por trás do corpo (detalhe 'cape'). */
export function kitCape(p: Pen, k: Kit, dy: number, perch: boolean): void {
  if (k.detail !== 'cape') return;
  const c = k.A; const c2 = shade(c, -0.25);
  p.rect(3, 22 + dy, 3, perch ? 13 : 18, c); p.rect(3, 22 + dy, 1, perch ? 13 : 18, c2); p.rect(20, 22 + dy, 2, perch ? 10 : 14, c2);
}

/** Pernas e calçado em pé ou andando. Devolve true quando desenhou (a roupa grega fica de fora). */
export function kitLegs(p: Pen, k: Kit, S: string, s: string, step: boolean): void {
  const L = step ? 7 : 8; const R = step ? 16 : 15; const up = step ? 1 : 0;
  const [B, b] = k.B;
  // de onde a perna aparece (abaixo da roupa) e com que cor
  const legTop = k.bottom === 'pants' ? 34 : k.bottom === 'shorts' ? 37 : k.bottom === 'skirt' ? 38 : k.bottom === 'trunks' ? 34 : 43;
  const pants = k.bottom === 'pants';
  if (k.bottom !== 'robe') {
    for (const [x, u] of [[L, up], [R, 0]] as const) {
      const top = (pants ? 34 : legTop) - u;
      const len = 43 - u - top;
      if (len <= 0) continue;
      p.rect(x, top, 3, len, pants ? B : S);
      p.rect(x === L ? x + 2 : x, top, 1, len, pants ? b : s);
    }
  }
  if (k.bottom === 'shorts') for (const [x, u] of [[L, up], [R, 0]] as const) p.rect(x, 34 - u, 3, 3, B);
  // calçado
  for (const [x, u] of [[L, up], [R, 0]] as const) {
    const y = 43 - u;
    switch (k.shoes) {
      case 'boots': p.rect(x - 1, y, 5, 2, LEATHER); p.rect(x, y - 3, 3, 3, LEATHER); p.span(y - 3, x, x + 2, shade(LEATHER, 0.15)); break;
      case 'sneakers': p.rect(x - 1, y, 5, 2, '#f2f2ee'); p.span(y + 1, x - 1, x + 3, k.A === '#ffffff' ? '#9aa4b0' : k.A); break;
      case 'shoes': p.rect(x - 1, y, 5, 2, DARK); p.put(x + 2, y, '#4a4a55'); break;
      case 'bare': p.span(y, x - 1, x + 2, S); p.span(y + 1, x - 1, x + 2, s); break;
      default: p.rect(x - 1, y, 5, 2, '#6b4a2e'); p.put(x + 1, y - 1, '#6b4a2e');
    }
  }
}

/** Quadril e o que cobre o meio do corpo (calça, bermuda, saia, manto longo, sunga). */
export function kitBottom(p: Pen, k: Kit, back: boolean, seated: boolean, perch: boolean, dy: number): void {
  const [B, b] = k.B;
  if (seated) { p.rect(5, 31 + dy, 16, 3, B); return; }
  if (perch) { p.rect(5, 31 + dy, 16, 2, B); p.rect(4, 33 + dy, 18, 3, B); p.span(35 + dy, 4, 21, b); return; }
  switch (k.bottom) {
    case 'robe': p.rect(6, 31, 14, 3, B); p.rect(5, 34, 16, 8, B); for (const x of [8, 12, 16]) for (let y = 33; y <= 41; y++) p.put(x, y, b); p.rect(back ? 5 : 19, 34, 2, 8, b); p.span(41, 5, 20, shade(B, -0.12)); break;
    case 'skirt': p.rect(6, 31, 14, 3, B); p.rect(5, 34, 16, 4, B); for (const x of [9, 13, 16]) for (let y = 34; y <= 37; y++) p.put(x, y, b); p.span(37, 5, 20, shade(B, -0.12)); break;
    case 'trunks': p.rect(6, 31, 14, 3, B); p.span(33, 6, 19, b); break;
    case 'shorts': p.rect(6, 31, 14, 3, B); p.put(12, 32, b); p.put(13, 32, b); break;
    default: p.rect(6, 31, 14, 3, B); p.put(12, 32, b); p.put(13, 32, b); p.put(13, 33, b);
  }
}

/** Tronco: a peça de cima e o detalhe da roupa. */
export function kitTop(p: Pen, k: Kit, S: string, s: string, back: boolean, seated: boolean, perch: boolean, dy: number, seed: number): void {
  const [T, t] = k.T; const A = k.A;
  const body = (c: string) => { p.span(22 + dy, 7, 18, c); p.rect(6, 23 + dy, 14, 7, c); p.rect(back ? 6 : 18, 23 + dy, 2, 7, t); };
  const standing = !seated && !perch;
  switch (k.top) {
    case 'tank':
      body(T); p.span(22 + dy, 7, 9, S); p.span(22 + dy, 16, 18, S); p.span(22 + dy, 11, 14, S); break;
    case 'swim':
      body(T); for (let y = 22; y <= 24; y++) { p.span(y + dy, 7, 18, S); } p.put(9, 22 + dy, T); p.put(9, 23 + dy, T); p.put(16, 22 + dy, T); p.put(16, 23 + dy, T); p.rect(18, 25 + dy, 2, 5, t); break;
    case 'plate': {
      const L0 = shade(T, 0.18); body(T); p.rect(6, 23 + dy, 4, 7, L0);
      p.rect(4, 21 + dy, 4, 3, L0); p.rect(18, 21 + dy, 4, 3, t); // ombreiras
      if (!back) { p.span(25 + dy, 8, 17, t); p.put(12, 27 + dy, t); p.put(13, 27 + dy, t); }
      p.span(30 + dy, 6, 19, LEATHER); break;
    }
    default: body(T);
  }
  if (back) {
    if (k.top === 'hoodie') p.rect(8, 22 + dy, 10, 3, t);
    if (k.detail === 'stripes') for (const y of [24, 26, 28]) p.span(y + dy, 6, 19, A);
    if (k.detail === 'camo') camo(p, T, A, 22 + dy, 30 + dy, 6, 19, seed);
    return;
  }
  // golas e frentes
  switch (k.top) {
    case 'suit': {
      const shirt = mix('#ffffff', T, 0.08);
      p.span(22 + dy, 11, 14, shirt); p.span(23 + dy, 12, 13, shirt);
      p.put(10, 23 + dy, t); p.put(11, 24 + dy, t); p.put(15, 23 + dy, t); p.put(14, 24 + dy, t);
      p.put(12, 28 + dy, t);
      break;
    }
    case 'jacket': case 'coat': case 'leather':
      p.rect(11, 22 + dy, 4, 8, k.top === 'leather' ? shade(T, 0.12) : A === T ? '#f2efe8' : A);
      p.put(10, 22 + dy, t); p.put(15, 22 + dy, t); p.put(10, 23 + dy, t); p.put(15, 23 + dy, t);
      if (k.top === 'leather') for (let y = 23; y <= 29; y++) p.put(13, y + dy, '#9aa4b0');
      break;
    case 'shirt': p.put(10, 22 + dy, t); p.put(15, 22 + dy, t); for (let y = 24; y <= 29; y += 2) p.put(12, y + dy, t); break;
    case 'tee': p.span(22 + dy, 11, 14, S); break;
    case 'hoodie': p.span(22 + dy, 8, 17, t); p.rect(9, 27 + dy, 8, 2, t); p.put(11, 23 + dy, A); p.put(11, 24 + dy, A); p.put(14, 23 + dy, A); p.put(14, 24 + dy, A); break;
    case 'sweater': p.span(22 + dy, 10, 15, t); p.span(30 + dy, 6, 19, t); break;
    case 'robe': p.put(12, 22 + dy, S); p.put(13, 22 + dy, S); p.put(12, 23 + dy, t); p.put(13, 23 + dy, t); break;
    case 'uniform': p.rect(8, 24 + dy, 3, 2, t); p.rect(15, 24 + dy, 3, 2, t); p.span(22 + dy, 10, 15, t); break;
    case 'tunic': p.put(12, 22 + dy, S); p.put(13, 22 + dy, S); p.put(12, 23 + dy, S); break;
    default: break;
  }
  // abas do casaco e da túnica sobre o quadril (em pé)
  if (standing && (k.top === 'coat' || k.top === 'tunic')) {
    if (k.top === 'coat') { p.rect(5, 31, 4, 7, T); p.rect(17, 31, 4, 7, T); p.rect(19, 31, 2, 7, t); }
    else { p.rect(6, 31, 14, 4, T); p.span(34, 6, 19, t); }
  }
  // detalhe
  switch (k.detail) {
    case 'tie': if (k.top !== 'tank' && k.top !== 'swim') { p.put(12, 22 + dy, A); p.put(13, 22 + dy, A); p.rect(12, 23 + dy, 2, 6, A); p.put(12, 29 + dy, shade(A, -0.2)); p.put(13, 29 + dy, shade(A, -0.2)); } break;
    case 'camo': camo(p, T, A, 22 + dy, 30 + dy, 6, 19, seed); break;
    case 'neon': for (let y = 23; y <= 29; y++) { p.put(7, y + dy, A); p.put(18, y + dy, A); } p.span(30 + dy, 6, 19, A); break;
    case 'stripes': for (const y of [24, 26, 28]) p.span(y + dy, 6, 19, A); break;
    case 'belt': p.span(30 + dy, 6, 19, LEATHER); p.put(12, 30 + dy, A); p.put(13, 30 + dy, A); break;
    case 'trim': for (let y = 23; y <= 30; y++) p.put(12, y + dy, A); p.span(30 + dy, 6, 19, A); if (standing && (k.bottom === 'robe' || k.top === 'coat')) { p.span(41, 5, 20, A); for (let y = 31; y <= 41; y++) p.put(12, y, A); } break;
    case 'dots': for (let y = 24; y <= 29; y += 2) for (let x = 7 + (y % 4 === 0 ? 0 : 1); x <= 18; x += 3) p.put(x, y + dy, A); break;
    case 'apron': p.rect(9, 25 + dy, 8, 6, A); p.put(9, 23 + dy, A); p.put(9, 24 + dy, A); p.put(16, 23 + dy, A); p.put(16, 24 + dy, A); p.put(12, 26 + dy, shade(A, -0.2)); break;
    default: break;
  }
  if (k.badge) { p.rect(7, 24 + dy, 2, 2, k.badge); }
}

function camo(p: Pen, T: string, A: string, y0: number, y1: number, x0: number, x1: number, seed: number): void {
  const D = shade(T, -0.22);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const h = (x * 7 + y * 13 + seed) % 11;
    if (h < 2) p.put(x, y, A); else if (h === 5) p.put(x, y, D);
  }
}

/** Cor das mangas e se cobrem o antebraço. */
export function kitSleeves(k: Kit, S: string, back: boolean): { left: string; right: string; long: boolean } {
  if (k.sleeves === 'none') return { left: S, right: S, long: false };
  const c = k.top === 'plate' ? shade(k.T[0], 0.1) : k.T[0];
  return { left: c, right: back ? k.T[1] : c, long: k.sleeves === 'long' };
}

// ---------------------------------------------------------------- cabeça
/** Cabelos novos (de frente). Devolve false quando não é um deles (figures.ts desenha os antigos). */
export function hairFront(p: Pen, style: string, H: string, h: string, hl: string, S: string, hy: number): boolean {
  if (style === 'mohawk') {
    p.rect(5, 12 + hy, 2, 3, shade(H, 0.25)); p.rect(19, 12 + hy, 2, 2, shade(H, 0.25));
    p.rect(11, 0 + hy, 4, 10, H); p.rect(11, 0 + hy, 1, 10, hl); p.rect(14, 1 + hy, 1, 8, h);
    return true;
  }
  if (style === 'afro') {
    p.span(1 + hy, 8, 17, H); p.span(2 + hy, 6, 19, H); p.span(3 + hy, 5, 20, H);
    for (let y = 4; y <= 9; y++) p.span(y + hy, 4, 21, H);
    p.rect(3, 9 + hy, 3, 7, H); p.rect(20, 9 + hy, 3, 6, h); p.span(10 + hy, 6, 12, H);
    for (let x = 6; x <= 19; x += 3) { p.put(x, 2 + hy, hl); p.put(x + 1, 6 + hy, h); }
    void S;
    return true;
  }
  if (style === 'spiky') {
    p.span(4 + hy, 9, 16, H); p.span(5 + hy, 7, 18, H); p.span(6 + hy, 6, 19, H);
    for (const y of [7, 8, 9]) p.span(y + hy, 5, 20, H);
    p.span(10 + hy, 6, 12, H); p.rect(5, 10 + hy, 2, 4, H); p.rect(19, 10 + hy, 2, 2, h);
    for (const x of [6, 9, 12, 15, 18]) { p.put(x, 3 + hy, H); p.put(x + 1, 2 + hy, H); p.put(x + 1, 1 + hy, hl); }
    return true;
  }
  return false;
}
export function hairBack(p: Pen, style: string, H: string, h: string, hy: number): void {
  if (style === 'mohawk') { p.rect(11, 0 + hy, 4, 20, H); p.rect(14, 0 + hy, 1, 20, h); }
  if (style === 'afro') { p.span(1 + hy, 8, 17, H); p.span(2 + hy, 6, 19, H); for (let y = 3; y <= 18; y++) p.span(y + hy, 4, 21, H); p.rect(19, 4 + hy, 3, 14, h); }
  if (style === 'spiky') for (const x of [6, 9, 12, 15, 18]) { p.put(x, 3 + hy, H); p.put(x + 1, 2 + hy, H); }
}

/** Orelhas, presas e nariz das espécies; acessórios de rosto. */
export function speciesAndFace(p: Pen, e: Extra, S: string, s: string, back: boolean, hy: number, accent: string): void {
  if (e.species === 'elf') {
    if (back) { p.put(4, 11 + hy, S); p.put(3, 10 + hy, S); p.put(21, 11 + hy, S); p.put(22, 10 + hy, S); }
    else { p.put(4, 12 + hy, S); p.put(3, 11 + hy, S); p.put(2, 10 + hy, S); p.put(4, 13 + hy, s); p.put(21, 12 + hy, S); p.put(22, 11 + hy, s); }
  }
  if (e.species === 'gnome') {
    if (back) { p.put(4, 12 + hy, S); p.put(21, 12 + hy, S); }
    else { p.put(4, 12 + hy, S); p.put(3, 12 + hy, s); p.rect(13, 15 + hy, 2, 2, s); p.put(13, 15 + hy, S); }
  }
  if (back) return;
  if (e.species === 'orc') { const W = '#f2ecd8'; p.put(11, 17 + hy, W); p.put(15, 17 + hy, W); p.put(11, 16 + hy, W); p.put(15, 16 + hy, W); }
  switch (e.face) {
    case 'glasses': {
      // lentes claras com o olho aparecendo, aro em cima e ponte
      const F = '#3a3a44'; const G = '#d8e6ee';
      for (const x0 of [9, 14]) { p.rect(x0, 13 + hy, 3, 2, G); p.put(x0 + 1, 13 + hy, '#2b2028'); p.put(x0 + 1, 14 + hy, '#2b2028'); p.span(12 + hy, x0, x0 + 2, F); }
      p.span(13 + hy, 12, 13, F); break;
    }
    case 'sunglasses': p.rect(9, 13 + hy, 3, 2, '#1a1a22'); p.rect(14, 13 + hy, 3, 2, '#1a1a22'); p.span(13 + hy, 12, 13, '#1a1a22'); p.put(9, 13 + hy, '#6a7a8a'); p.put(14, 13 + hy, '#6a7a8a'); break;
    case 'goggles': p.span(12 + hy, 5, 20, LEATHER); for (const x0 of [9, 14]) { p.rect(x0, 12 + hy, 3, 3, '#8a7a5a'); p.put(x0 + 1, 13 + hy, '#9fd8e8'); } break;
    case 'mask': p.rect(8, 16 + hy, 10, 4, '#2a2e3e'); p.span(17 + hy, 9, 16, accent); break;
    case 'implant': p.put(16, 13 + hy, accent); p.put(17, 13 + hy, accent); p.put(17, 15 + hy, '#8a9aaa'); p.put(17, 16 + hy, '#8a9aaa'); p.put(18, 14 + hy, '#8a9aaa'); break;
    default: break;
  }
}

/** Chapéus e coberturas novos. */
export function headwear(p: Pen, hw: string, C: [string, string], back: boolean, hy: number, accent: string): void {
  const [c, c2] = C; const hl = shade(c, 0.18);
  switch (hw) {
    case 'helmet':
      p.span(3 + hy, 8, 17, c); p.span(4 + hy, 6, 19, c); p.span(5 + hy, 5, 20, c); p.rect(5, 6 + hy, 16, 3, c); p.span(9 + hy, 4, 21, c2);
      p.span(4 + hy, 8, 11, hl); if (!back) { p.put(6, 14 + hy, DARK); p.put(6, 15 + hy, DARK); p.put(7, 16 + hy, DARK); }
      break;
    case 'beret': p.span(4 + hy, 7, 17, c); p.span(5 + hy, 6, 19, c); p.span(6 + hy, 6, 19, c2); p.put(18, 4 + hy, c); p.put(19, 5 + hy, c); p.put(12, 3 + hy, c2); break;
    case 'cap': p.span(4 + hy, 8, 17, c); p.rect(6, 5 + hy, 14, 3, c); p.span(5 + hy, 8, 11, hl); if (back) p.span(8 + hy, 6, 19, c2); else p.span(8 + hy, 13, 22, c2); break;
    case 'beanie':
      p.span(2 + hy, 8, 17, c); p.rect(6, 3 + hy, 14, 5, c); p.span(8 + hy, 5, 20, c2);
      for (let x = 7; x <= 18; x += 2) for (let y = 3; y <= 7; y++) p.put(x, y + hy, shade(c, -0.08));
      p.rect(11, 0 + hy, 3, 2, '#f2efe8'); break;
    case 'sunhat': p.span(2 + hy, 9, 16, c); p.span(3 + hy, 8, 17, c); p.span(4 + hy, 7, 18, c); p.span(5 + hy, 7, 18, accent); p.span(6 + hy, 1, 24, c); p.span(7 + hy, 2, 23, c2); break;
    case 'wizard': {
      // cone alto e pontudo, com a ponta caída para o lado, faixa e aba
      const cone: Array<[number, number]> = [[15, 15], [14, 15], [13, 15], [12, 15], [11, 15], [10, 16], [9, 16], [8, 17]];
      cone.forEach(([a, b], k) => p.span(-2 + k + hy, a, b, c)); p.put(15, -2 + hy, c2); p.put(14, 0 + hy, hl);
      p.span(6 + hy, 8, 17, c2); p.span(7 + hy, 4, 21, c); p.span(8 + hy, 5, 20, c2);
      p.put(12, 3 + hy, '#f2e6a1'); p.put(11, 4 + hy, '#f2e6a1'); break;
    }
    case 'hood':
      p.span(3 + hy, 8, 17, c); p.span(4 + hy, 6, 19, c); p.rect(5, 5 + hy, 16, 4, c);
      if (back) { p.rect(4, 9 + hy, 18, 12, c); p.rect(19, 9 + hy, 3, 12, c2); }
      else { p.rect(4, 9 + hy, 2, 11, c); p.rect(20, 9 + hy, 2, 9, c2); p.span(4 + hy, 8, 11, hl); }
      break;
    case 'circlet': p.span(8 + hy, 5, 20, c); if (!back) { p.put(12, 8 + hy, accent); p.put(13, 8 + hy, accent); p.put(12, 7 + hy, c); p.put(13, 7 + hy, c); } break;
    case 'headphones':
      p.span(3 + hy, 9, 16, c); p.put(8, 4 + hy, c); p.put(17, 4 + hy, c); p.put(7, 5 + hy, c); p.put(18, 5 + hy, c);
      p.rect(4, 10 + hy, 3, 5, c); p.rect(19, 10 + hy, 3, 5, c); p.put(5, 12 + hy, accent); p.put(20, 12 + hy, accent); break;
    case 'bandana': p.span(6 + hy, 5, 20, c); p.span(7 + hy, 5, 20, c); p.span(7 + hy, 5, 20, c2); p.put(4, 8 + hy, c); p.put(3, 9 + hy, c2); p.put(4, 10 + hy, c2); break;
    case 'crown':
      p.rect(7, 4 + hy, 12, 3, c); for (const [x, y] of [[7, 3], [10, 2], [13, 3], [16, 2], [18, 3]]) p.put(x, y + hy, c);
      p.span(6 + hy, 7, 18, c2); p.put(10, 5 + hy, accent); p.put(15, 5 + hy, accent); break;
    case 'visor': if (!back) { p.span(13 + hy, 7, 18, c); p.span(14 + hy, 7, 18, c2); p.span(13 + hy, 8, 11, '#ffffff'); } else p.span(13 + hy, 5, 20, c2); break;
    default: break;
  }
}

/** Objetos novos, de frente e em pé, sem gesto. */
export function item(p: Pen, it: string, A: string, metal: string): void {
  switch (it) {
    case 'briefcase': p.put(21, 32, DARK); p.put(22, 32, DARK); p.rect(18, 33, 7, 5, '#5a3a24'); p.span(33, 18, 24, '#6e4a30'); p.put(21, 35, metal); break;
    case 'laptop': p.rect(7, 25, 10, 6, '#3a3f4a'); p.span(25, 7, 16, '#5a6070'); p.put(11, 27, '#9aa4b0'); p.put(12, 27, '#9aa4b0'); break;
    case 'coffee': p.rect(20, 31, 3, 4, '#f2efe8'); p.span(32, 20, 22, '#8a5a3a'); p.put(23, 32, '#f2efe8'); p.put(21, 29, '#d8d8d8'); p.put(22, 28, '#d8d8d8'); break;
    case 'sword': for (let y = 14; y <= 32; y++) p.put(23, y, y < 16 ? '#f2f4f6' : '#cfd5dc'); p.put(24, 20, '#9aa4b0'); p.span(33, 21, 25, metal); p.rect(23, 34, 1, 3, '#4a3a28'); p.put(23, 37, metal); break;
    case 'shield': p.rect(0, 25, 6, 8, metal); p.rect(1, 26, 4, 6, '#7a5a3a'); p.rect(2, 27, 2, 4, A); p.span(33, 1, 4, metal); break;
    case 'book': p.rect(8, 25, 8, 6, '#7a3a2a'); p.span(25, 8, 15, '#f2ead8'); p.rect(15, 25, 1, 6, '#f2ead8'); p.put(11, 27, '#d8b866'); p.put(12, 27, '#d8b866'); break;
    case 'potion': p.put(21, 29, '#c8c8d0'); p.put(21, 30, '#c8c8d0'); p.rect(20, 31, 3, 3, A); p.put(20, 31, '#ffffff'); p.span(34, 20, 22, '#c8c8d0'); break;
    case 'radio': p.rect(20, 30, 3, 5, '#2a2a30'); for (let y = 26; y <= 29; y++) p.put(21, y, '#2a2a30'); p.put(21, 31, '#7fe0a0'); break;
    case 'binoculars': p.rect(9, 25, 3, 3, '#2a2a30'); p.rect(14, 25, 3, 3, '#2a2a30'); p.span(26, 12, 13, '#2a2a30'); p.put(10, 25, '#6a7a8a'); p.put(15, 25, '#6a7a8a'); break;
    case 'clipboard': p.rect(8, 24, 7, 8, '#b98a5a'); p.rect(9, 25, 5, 6, '#f2f2ee'); for (const y of [26, 28, 30]) p.span(y, 10, 12, '#9aa4b0'); p.span(24, 10, 12, metal); break;
    case 'surfboard': p.rect(-1, 10, 3, 32, '#f2e6c8'); p.put(0, 9, '#f2e6c8'); p.put(0, 42, '#f2e6c8'); for (let y = 11; y <= 40; y++) p.put(0, y, A); break;
    case 'icecream': for (const y of [31, 32, 33]) p.put(21, y, '#d8a050'); p.put(20, 31, '#d8a050'); p.put(22, 31, '#d8a050'); p.rect(20, 29, 3, 2, '#f6c8d0'); p.put(21, 28, '#fff0f4'); break;
    case 'coconut': p.rect(20, 30, 3, 3, '#6a4a2a'); p.put(20, 30, '#8a6a3a'); p.put(22, 29, '#f2f2f2'); p.put(23, 28, '#f2f2f2'); break;
    case 'cat': {
      const C = '#e8a050'; const c = '#c07a30';
      p.rect(7, 26, 9, 4, C); p.rect(13, 23, 4, 4, C); p.put(13, 22, C); p.put(16, 22, C); p.put(14, 24, DARK); p.put(16, 24, DARK);
      for (const x of [8, 10, 12]) p.put(x, 27, c); p.put(6, 25, C); p.put(5, 24, C); break;
    }
    case 'datapad': p.rect(8, 25, 6, 7, '#1a1d28'); p.rect(9, 26, 4, 5, A); for (const y of [27, 29]) p.span(y, 9, 12, shade(A, -0.35)); break;
    default: break;
  }
}
