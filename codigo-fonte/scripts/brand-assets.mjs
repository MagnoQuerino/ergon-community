#!/usr/bin/env node
// Arquivos da marca, todos gerados da mesma geometria (web/src/brand/logo.ts):
//   web/public/        favicon.svg, manifest.webmanifest, icons/*.png (aba do navegador, atalho, app instalado)
//   docs/brand/svg/    logo empilhada e horizontal (clara/escura), emblema, uma cor, logotipo, carregamento animado
//   connectors/teams/appPackage/  color.png e outline.png do app do Teams
//   desktop/                       ícone-fonte do aplicativo, faixa lateral do instalador do Windows, tela de abertura
//   node scripts/brand-assets.mjs          gera tudo
//   node scripts/brand-assets.mjs --check  só confere se os arquivos estão em dia (falha se algum mudou)
// Os PNG são desenhados aqui mesmo (amostragem 4×4 por pixel), sem navegador nem dependências.
import fs from 'node:fs';
import path from 'node:path';
import { bmp, png } from './png.mjs';
import { BRAND, CORE_R, EMBLEM_BOX, emblemSvg, emblemViewBox, figures, logoSvg, palette, wordmarkSvg } from '../web/src/brand/logo.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const rad = (d) => (d * Math.PI) / 180;
const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

// --- desenho do emblema em pixels ----------------------------------------------------------------------------
const FIGS = figures().map((g) => {
  const b = g.band; const ca = Math.cos(rad(-b.axis)); const sa = Math.sin(rad(-b.axis));
  // cada corte: lado da reta (ponto externo → interno) em que fica o meio da faixa
  const cuts = b.cuts.map(([o, i]) => { const side = Math.sign((i[0] - o[0]) * (b.mid[1] - o[1]) - (i[1] - o[1]) * (b.mid[0] - o[0])); return { o, i, side }; });
  const inBand = (x, y) => {
    const dx = x - b.cx; const dy = y - b.cy; const u = dx * ca - dy * sa; const w = dx * sa + dy * ca;
    if ((u / b.ao) ** 2 + (w / b.bo) ** 2 > 1 || (u / b.ai) ** 2 + (w / b.bi) ** 2 < 1) return false;
    return cuts.every((c) => Math.sign((c.i[0] - c.o[0]) * (y - c.o[1]) - (c.i[1] - c.o[1]) * (x - c.o[0])) === c.side);
  };
  const inHead = (x, y) => (x - g.head.cx) ** 2 + (y - g.head.cy) ** 2 <= g.head.r ** 2;
  return { tone: g.tone, hit: (x, y) => inHead(x, y) || inBand(x, y) };
});

/** Emblema num quadrado de `size` px (RGBA); `scale` = fração do lado ocupada pelo emblema; fundo opcional (cor sólida). */
function emblemPixels(size, { pal = palette(), bg = null, scale = 1 } = {}) {
  const side = Math.max(EMBLEM_BOX.w, EMBLEM_BOX.h) / scale;
  const x0 = EMBLEM_BOX.x + EMBLEM_BOX.w / 2 - side / 2; const y0 = EMBLEM_BOX.y + EMBLEM_BOX.h / 2 - side / 2;
  const cols = { navy: hex(pal.navy), teal: hex(pal.teal), gold: hex(pal.gold) };
  const back = bg ? hex(bg) : null;
  const px = Buffer.alloc(size * size * 4); const S = 4;
  for (let py = 0; py < size; py++) for (let pxi = 0; pxi < size; pxi++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = x0 + ((pxi + (sx + 0.5) / S) / size) * side; const y = y0 + ((py + (sy + 0.5) / S) / size) * side;
      let tone = x * x + y * y <= CORE_R * CORE_R ? 'gold' : null;
      if (!tone) for (const fg of FIGS) if (fg.hit(x, y)) { tone = fg.tone; break; }
      if (tone) { const c = cols[tone]; r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * size + pxi) * 4; const n = S * S;
    if (back) { // sobre fundo sólido: mistura
      px[i] = Math.round((r + back[0] * (n - a)) / n); px[i + 1] = Math.round((g + back[1] * (n - a)) / n); px[i + 2] = Math.round((b + back[2] * (n - a)) / n); px[i + 3] = 255;
    } else if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); px[i + 3] = Math.round((255 * a) / n); }
  }
  return px;
}
const emblemPng = (size, opts) => png(size, size, emblemPixels(size, opts));

/** Faixa lateral das páginas de boas-vindas e de conclusão do instalador NSIS (164×314): emblema na versão para
 *  fundo escuro sobre o azul da marca, como o ícone do Teams. */
function installerSidebar() {
  const w = 164, h = 314, lado = 124, x0 = (w - lado) / 2, y0 = 58;
  const fundo = hex(BRAND.navy); const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = fundo[0]; px[i * 4 + 1] = fundo[1]; px[i * 4 + 2] = fundo[2]; px[i * 4 + 3] = 255; }
  const em = emblemPixels(lado, { pal: palette({ onDark: true }), bg: BRAND.navy, scale: 0.9 });
  for (let y = 0; y < lado; y++) em.copy(px, ((y0 + y) * w + x0) * 4, y * lado * 4, (y + 1) * lado * 4);
  return bmp(w, h, px);
}

// --- arquivos ------------------------------------------------------------------------------------------------
const brandCss = fs.readFileSync(path.join(ROOT, 'web/src/brand/brand.css'), 'utf8');
// favicon: emblema justo; em aba escura, as pessoas de cima ficam claras (como na versão para fundo escuro)
const dark = palette({ onDark: true });
const favicon = emblemSvg({ viewBox: emblemViewBox(0.02) }).replace('aria-label="Ergon">',
  `aria-label="Ergon"><style>@media (prefers-color-scheme: dark){.eg-fig--navy{fill:${dark.navy}}.eg-fig--teal{fill:${dark.teal}}}</style>`);
// carregamento animado (abre no navegador, entra em README/apresentação): o mesmo movimento da tela do app
const loading = emblemSvg({ size: 160 }).replace('<svg ', '<svg class="eg-mark eg-anim" ').replace('aria-label="Ergon">', `aria-label="Ergon"><style>${brandCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')}</style>`);

const manifest = {
  name: 'Ergon', short_name: 'Ergon', description: 'Sua equipe de agentes trabalhando junto, neste computador.',
  start_url: '/', scope: '/', display: 'standalone', background_color: '#F4EFE6', theme_color: BRAND.navy, lang: 'pt-BR',
  icons: [
    { src: '/icons/ergon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/ergon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/ergon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
};

const files = {
  'web/public/favicon.svg': favicon,
  'web/public/manifest.webmanifest': JSON.stringify(manifest, null, 2) + '\n',
  'web/public/icons/ergon-32.png': () => emblemPng(32, { scale: 0.96 }),
  // ícones de app: emblema sobre o off-white da marca (fica legível em qualquer fundo do sistema)
  'web/public/icons/ergon-192.png': () => emblemPng(192, { bg: BRAND.stone, scale: 0.8 }),
  'web/public/icons/ergon-512.png': () => emblemPng(512, { bg: BRAND.stone, scale: 0.8 }),
  'web/public/icons/ergon-maskable-512.png': () => emblemPng(512, { bg: BRAND.stone, scale: 0.56 }), // zona segura: círculo de 80%
  'web/public/icons/apple-touch-icon.png': () => emblemPng(180, { bg: BRAND.stone, scale: 0.76 }),
  'docs/brand/svg/ergon-logo.svg': logoSvg(),
  'docs/brand/svg/ergon-logo-fundo-escuro.svg': logoSvg({ onDark: true }),
  'docs/brand/svg/ergon-horizontal.svg': logoSvg({ kind: 'horizontal' }),
  'docs/brand/svg/ergon-horizontal-fundo-escuro.svg': logoSvg({ kind: 'horizontal', onDark: true }),
  'docs/brand/svg/ergon-emblema.svg': emblemSvg(),
  'docs/brand/svg/ergon-emblema-fundo-escuro.svg': emblemSvg({ onDark: true }),
  'docs/brand/svg/ergon-logo-azul.svg': logoSvg({ mono: BRAND.navy }),
  'docs/brand/svg/ergon-logo-preto.svg': logoSvg({ mono: BRAND.black }),
  'docs/brand/svg/ergon-logo-branco.svg': logoSvg({ mono: '#FFFFFF' }),
  'docs/brand/svg/ergon-logotipo.svg': wordmarkSvg(),
  'docs/brand/svg/ergon-carregando.svg': loading,
  // Teams: ícone colorido 192 (símbolo dentro da área segura de 120 px, fundo = accentColor) e contorno 32 branco
  'connectors/teams/appPackage/color.png': () => emblemPng(192, { pal: dark, bg: BRAND.navy, scale: 0.62 }),
  'connectors/teams/appPackage/outline.png': () => emblemPng(32, { pal: palette({ mono: '#FFFFFF' }), scale: 0.98 }),
  // aplicativo desktop (desktop/): ícone-fonte do Tauri (os tamanhos saem dele com "tauri icon") e a tela de abertura
  'desktop/src-tauri/icons/fonte-1024.png': () => emblemPng(1024, { bg: BRAND.stone, scale: 0.8 }),
  'desktop/src-tauri/icons/instalador-lateral.bmp': installerSidebar,
  'desktop/ui/ergon-carregando.svg': loading,
  'desktop/ui/ergon-horizontal.svg': logoSvg({ kind: 'horizontal' }),
};

const check = process.argv.includes('--check');
const stale = [];
for (const [rel, make] of Object.entries(files)) {
  const data = Buffer.from(typeof make === 'function' ? make() : make);
  const file = path.join(ROOT, rel);
  if (check) { if (!fs.existsSync(file) || !fs.readFileSync(file).equals(data)) stale.push(rel); continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
if (check) {
  if (stale.length) { console.error('Arquivos da marca desatualizados (rode node scripts/brand-assets.mjs):\n- ' + stale.join('\n- ')); process.exit(1); }
  console.log(`Marca em dia (${Object.keys(files).length} arquivos).`);
} else console.log(`Marca: ${Object.keys(files).length} arquivos gerados.`);
