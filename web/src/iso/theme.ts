/**
 * Tema da cena: só cores. Trocar o tema (ou criar outro) é a porta para cosméticos futuros;
 * formas e lógica não dependem dele. Paleta próxima da identidade Alexandria:
 * ameixa/azul escuro, pedra/marfim/papiro, bronze discreto e teal suave.
 */
import type { Tone } from './raster.ts';

export interface Theme {
  id: string;
  name: string;
  bg: string; // chão da cidade (também a cor de fundo do buffer)
  pebble: string; // pontos de textura do chão
  grass: string | null; // tufos de capim no chão
  /** manchas do chão: a mais verde/escura e a mais seca/clara (textura sutil, sem desenho) */
  ground: [string, string];
  /** ruas de terra batida: miolo, borda e as marcas das rodas */
  road: { fill: string; edge: string; rut: string };
  /** florzinhas no capim (de dia; à noite, nenhuma) */
  flowers: string[];
  shadow: string; // sombra sob os personagens (desenhada com transparência)
  outline: string; // contorno de pixel art
  stone: Tone; // pedra clara (estilóbato, lajes, topo das paredes)
  plaza: [string, string]; plazaGrout: string;
  marble: Tone; // colunas
  floor: [string, string]; grout: string; // piso interno em xadrez
  wallBack: string; wallSide: string; dado: string; trim: string;
  wood: Tone; woodDark: Tone;
  papyrus: [string, string];
  bronze: Tone; gold: string;
  teal: [string, string];
  carpet: { field: string; border: string; inner: string };
  carpet2: { field: string; border: string; inner: string }; // biblioteca
  planks: [string, string]; // assoalho da biblioteca
  sky: string; // céu visto pelas janelas
  water: Tone; // piscina das termas (clara, média, funda)
  sand: [string, string]; // ginásio
  earth: string; // lotes livres
  banner: [string, string];
  roof: Tone; houseWall: Tone; window: string; windowDark: string;
  cypress: [string, string]; olive: [string, string]; terracotta: Tone;
  flame: [string, string];
  chiton: [string, string]; sandal: string;
  skins: Array<[string, string]>;
  hairs: string[];
  marks: { attention: string; working: string; waiting: string; select: string };
  cards: string[];
}

export const ALEXANDRIA_NOITE: Theme = {
  id: 'alexandria-noite',
  name: 'Alexandria à noite',
  bg: '#2b2736',
  pebble: '#353041',
  grass: '#3a4640',
  ground: ['#282534', '#312c3c'],
  road: { fill: '#4a4357', edge: '#3a3447', rut: '#423c4e' },
  flowers: [],
  shadow: '#000000',
  outline: '#16111d',
  stone: ['#e3d7c0', '#c8ba9f', '#9e8f77'],
  plaza: ['#4b4256', '#463e51'], plazaGrout: '#3b3446',
  marble: ['#f0e8d6', '#d8cbb2', '#ab9d84'],
  floor: ['#3e344b', '#393045'], grout: '#2f2839',
  wallBack: '#4b3e5d', wallSide: '#3c324c', dado: '#30283e', trim: '#a8823f',
  wood: ['#8d6040', '#6f4a2f', '#523522'],
  woodDark: ['#5c3d2a', '#48301f', '#352318'],
  papyrus: ['#ecdfb9', '#c9b88b'],
  bronze: ['#d1a85c', '#a8823f', '#7c5e2b'], gold: '#d8b766',
  teal: ['#73b6aa', '#4a8a82'],
  carpet: { field: '#2c4767', border: '#c6a45e', inner: '#5f9d95' },
  carpet2: { field: '#27484a', border: '#a8823f', inner: '#c6a45e' },
  planks: ['#5a4434', '#513d2f'],
  sky: '#2b3657',
  water: ['#4f8f9c', '#2f6a7a', '#245563'],
  sand: ['#6e6250', '#625746'],
  earth: '#36303f',
  banner: ['#56427a', '#443463'],
  roof: ['#b9704f', '#9b5940', '#784331'],
  houseWall: ['#d4c7ad', '#b7a98f', '#918470'],
  window: '#e8b85c', windowDark: '#3a3046',
  cypress: ['#33604f', '#25483b'],
  olive: ['#71835c', '#596a49'],
  terracotta: ['#c47a58', '#a46245', '#7f4a35'],
  flame: ['#ffd77e', '#ea8a35'],
  chiton: ['#ebe2ce', '#c4b69b'],
  sandal: '#6b4a2e',
  skins: [['#ecc9a6', '#cc9f7b'], ['#dcaa80', '#b8865f'], ['#bb835c', '#966242'], ['#8f5d3e', '#6e452d']],
  hairs: ['#2a1e19', '#4b3022', '#6f4a2c', '#8a6a3c', '#9b938a'],
  marks: { attention: '#e3b341', working: '#73b6aa', waiting: '#e07b52', select: '#73b6aa' },
  cards: ['#e8c46a', '#73b6aa', '#d98a66', '#ecdfb9', '#a7b98a'],
};

/** Tema diurno (padrão): mesma identidade — ameixa, marfim, bronze, teal — sob luz do dia. */
export const ALEXANDRIA_DIA: Theme = {
  id: 'alexandria-dia',
  name: 'Alexandria de dia',
  bg: '#c6b893',
  pebble: '#b8a983',
  grass: '#8c9a62',
  ground: ['#bfb48d', '#ccbf9c'],
  road: { fill: '#dccfb0', edge: '#bba985', rut: '#cbbd9b' },
  flowers: ['#efe3bd', '#d98a66', '#e8c46a'],
  shadow: '#3b2f22',
  outline: '#2a2230',
  stone: ['#f3ebd9', '#dccfb4', '#b6a688'],
  plaza: ['#dfd3b9', '#d7cab0'], plazaGrout: '#c6b898',
  marble: ['#fdf8ee', '#e9dfcb', '#c3b59c'],
  floor: ['#d3c4a4', '#cbbb99'], grout: '#b9a885',
  wallBack: '#ece2ce', wallSide: '#dfd3bb', dado: '#54436b', trim: '#a8823f',
  wood: ['#9a6a45', '#7c5335', '#5d3d27'],
  woodDark: ['#664430', '#523624', '#3d281b'],
  papyrus: ['#f3e7c3', '#d4c294'],
  bronze: ['#d6ad60', '#ae8742', '#82632e'], gold: '#d9b45c',
  teal: ['#6fb3a7', '#468a80'],
  carpet: { field: '#2c4767', border: '#c6a45e', inner: '#5f9d95' },
  carpet2: { field: '#2f5b57', border: '#b48f45', inner: '#d6b468' },
  planks: ['#c49a6c', '#b88d60'],
  sky: '#a9cbd8',
  water: ['#8fd0d6', '#5fb2bf', '#3f8f9f'],
  sand: ['#e2cf9f', '#d6c08c'],
  earth: '#b39f78',
  banner: ['#56427a', '#443463'],
  roof: ['#cc7c58', '#ad6548', '#8b4e38'],
  houseWall: ['#f3eadb', '#dccfb8', '#b9ab92'],
  window: '#3e4f60', windowDark: '#2f3c49',
  cypress: ['#4a8566', '#336650'],
  olive: ['#8ea06c', '#6f8257'],
  terracotta: ['#cf8460', '#ae6a4b', '#8a5139'],
  flame: ['#ffe39a', '#f09a45'],
  chiton: ['#f1e9d6', '#cbbd9f'],
  sandal: '#6b4a2e',
  skins: [['#ecc9a6', '#cc9f7b'], ['#dcaa80', '#b8865f'], ['#bb835c', '#966242'], ['#8f5d3e', '#6e452d']],
  hairs: ['#2a1e19', '#4b3022', '#6f4a2c', '#8a6a3c', '#9b938a'],
  marks: { attention: '#e3b341', working: '#4a9d91', waiting: '#e07b52', select: '#2f7f75' },
  cards: ['#e8c46a', '#73b6aa', '#d98a66', '#f3e7c3', '#a7b98a'],
};

export type ThemeId = 'dia' | 'noite';
export const THEMES: Record<ThemeId, Theme> = { dia: ALEXANDRIA_DIA, noite: ALEXANDRIA_NOITE };

// ---------------- utilidades de cor ----------------
function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function toHex(a: number[]): string { return '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }
export function mix(a: string, b: string, t: number): string { const A = hex(a); const B = hex(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); }
export function shade(c: string, f: number): string { return f >= 0 ? mix(c, '#ffffff', f) : mix(c, '#000000', -f); }

/** Cor de identidade do agente, puxada levemente para a paleta para não destoar. */
export function harmonize(color: string, theme: Theme): [string, string] {
  const safe = /^#[0-9a-f]{6}$/i.test(color) ? color : theme.banner[0];
  const base = mix(safe, theme.wallBack, 0.12);
  return [base, shade(base, -0.28)];
}
