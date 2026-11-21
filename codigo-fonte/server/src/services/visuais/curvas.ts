/**
 * O devanágari do PNG em curvas (rc.44). O resvg (2.6) não forma o hindi direito: some o espaço entre as palavras e os
 * conjuntos se desfazem (क्ष vira क्‌ष). O fontkit — o mesmo que monta o PDF pelo PDFKit — aplica as regras da Noto Sans
 * Devanagari (GSUB/GPOS) certinho; então, antes do resvg, cada <text> com devanágari do cartão vira um <path> com os
 * glifos já formados, na mesma posição, tamanho, peso, cor e âncora. O resto do cartão (latino, chinês) segue com o
 * texto do resvg. Sem as fontes ou sem o fontkit, o SVG vai como veio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

interface Glifo { path: { scale(x: number, y: number): Glifo['path']; translate(x: number, y: number): Glifo['path']; toSVG(): string }; advanceWidth: number }
interface Posicao { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }
interface Fonte { unitsPerEm: number; layout(texto: string): { glyphs: Glifo[]; positions: Posicao[] } }

const PASTA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fontes');
const DEVA = /[ऀ-ॿ]/;
let fontes: { r: Fonte; b: Fonte } | null | undefined;

function carregar(): { r: Fonte; b: Fonte } | null {
  if (fontes !== undefined) return fontes;
  try {
    const fk = createRequire(import.meta.url)('fontkit') as { create(b: Buffer): Fonte };
    fontes = { r: fk.create(fs.readFileSync(path.join(PASTA, 'NotoSansDevanagari-Regular.ttf'))), b: fk.create(fs.readFileSync(path.join(PASTA, 'NotoSansDevanagari-Bold.ttf'))) };
  } catch { fontes = null; }
  return fontes;
}

const DESESC: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const desescapar = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => DESESC[m] ?? m);
const attr = (attrs: string, nome: string): string | null => new RegExp(`(?:^|\\s)${nome}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** O <path> com os glifos do texto já formados, ou null (sem fonte). */
export function textoEmCurva(texto: string, x: number, y: number, tamanho: number, negrito: boolean, ancora: string | null): string | null {
  const f = carregar();
  if (!f) return null;
  const fonte = negrito ? f.b : f.r;
  const run = fonte.layout(texto);
  const k = tamanho / fonte.unitsPerEm;
  const largura = run.positions.reduce((a, p) => a + p.xAdvance, 0) * k;
  let cx = x - (ancora === 'middle' ? largura / 2 : ancora === 'end' ? largura : 0);
  const partes: string[] = [];
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    const d = g.path.scale(k, -k).translate(cx + p.xOffset * k, y - p.yOffset * k).toSVG();
    if (d) partes.push(d);
    cx += p.xAdvance * k;
  });
  return partes.join('');
}

/** O SVG do cartão com cada <text> que tem devanágari trocado por curvas (o resto igual). */
export function devanagariEmCurvas(svg: string): string {
  if (!DEVA.test(svg) || !carregar()) return svg;
  return svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (todo, attrs: string, corpo: string) => {
    const texto = desescapar(corpo);
    if (!DEVA.test(texto)) return todo;
    const x = Number(attr(attrs, 'x') ?? 0); const y = Number(attr(attrs, 'y') ?? 0); const tam = Number(attr(attrs, 'font-size') ?? 14);
    if (![x, y, tam].every(Number.isFinite)) return todo;
    const d = textoEmCurva(texto, x, y, tam, Number(attr(attrs, 'font-weight') ?? 400) >= 600, attr(attrs, 'text-anchor'));
    if (!d) return todo;
    const fill = attr(attrs, 'fill'); const op = attr(attrs, 'opacity') ?? attr(attrs, 'fill-opacity');
    return `<path d="${d}"${fill ? ` fill="${fill}"` : ''}${op ? ` opacity="${op}"` : ''}/>`;
  });
}
