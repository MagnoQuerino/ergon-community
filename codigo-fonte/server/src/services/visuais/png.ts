/**
 * O bloco visual em PNG no servidor (o cartão de shared/visuais/svg.ts, rasterizado em 2x pelo resvg com a Inter e as
 * Noto do chinês e do hindi que vão junto, em server/assets/fontes): o que o Telegram e o Discord recebem e o que o PDF do relatório leva. Sem o resvg (uma
 * plataforma sem o binário pronto), devolve null e os canais seguem só com o texto.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pngRgbDe } from '../../lib/png-opaco.ts';
import type { Bloco } from '../../../../shared/visuais/esquema.ts';
import { blocosDaCerca, cercasDe, ehCercaVisual } from '../../../../shared/visuais/cercas.ts';
import { PALETAS } from '../../../../shared/visuais/paleta.ts';
import { cartaoSvg, type Marca } from '../../../../shared/visuais/svg.ts';
import type { Locale } from '../../../../shared/visuais/formato.ts';
import { log } from '../../lib/log.ts';
import { devanagariEmCurvas } from './curvas.ts';

const FONTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fontes');
type ResvgCtor = new (svg: string, o: unknown) => { render(): { asPng(): Buffer; pixels: Buffer; width: number; height: number } };
let resvg: ResvgCtor | null | undefined;

// síncrono (o pacote é CommonJS com o binário pronto): o PDF do documento (lib/pdf-documento.ts) é montado de uma vez
function carregar(): ResvgCtor | null {
  if (resvg !== undefined) return resvg;
  try {
    resvg = (createRequire(import.meta.url)('@resvg/resvg-js') as { Resvg: ResvgCtor }).Resvg;
  } catch (err) {
    log.warn({ erro: (err as Error).message.slice(0, 120) }, 'visuais: sem o resvg, os canais recebem só o texto');
    resvg = null;
  }
  return resvg;
}

// a Inter (latino) e, desde a rc.44, a Noto Sans SC: o resvg acha sozinho a fonte que tem o caractere (um título em
// chinês não sai em quadradinhos). O hindi vai antes em curvas, já formado pelo fontkit (curvas.ts)
let lista: string[] | null = null;
const arquivosDeFonte = () => {
  if (!lista) { try { lista = fs.readdirSync(FONTES).filter((f) => /\.(otf|ttf)$/.test(f)).sort().map((f) => path.join(FONTES, f)); } catch { return []; } }
  return lista;
};

export interface OpcoesPng { tema?: 'claro' | 'escuro'; marca?: Marca | null; largura?: number; escala?: number; locale?: Locale }

/** SVG → PNG (2x por padrão). */
export function svgParaPngJa(svg: string, escala = 2): Buffer | null {
  const R = carregar();
  if (!R) return null;
  const r = new R(devanagariEmCurvas(svg), { fitTo: { mode: 'zoom', value: escala }, font: { fontFiles: arquivosDeFonte(), loadSystemFonts: false, defaultFontFamily: 'Inter' }, background: 'rgba(0,0,0,0)' });
  return r.render().asPng();
}
export async function svgParaPng(svg: string, escala = 2): Promise<Buffer | null> { return svgParaPngJa(svg, escala); }

/** O cartão do bloco em PNG opaco (fundo branco), já: para o PDF. */
export function visualParaPngOpaco(b: Bloco, o: OpcoesPng = {}): Buffer | null {
  const R = carregar();
  if (!R) return null;
  const c = cartaoSvg(b, { paleta: PALETAS[o.tema ?? 'claro'], largura: o.largura, marca: o.marca, locale: o.locale });
  const r = new R(devanagariEmCurvas(c.svg), { fitTo: { mode: 'zoom', value: o.escala ?? 2 }, font: { fontFiles: arquivosDeFonte(), loadSystemFonts: false, defaultFontFamily: 'Inter' }, background: '#ffffff' }).render();
  return pngRgbDe(r.pixels, r.width, r.height);
}

/** O cartão do bloco em PNG, já (sem esperar). */
export function visualParaPngJa(b: Bloco, o: OpcoesPng = {}): { png: Buffer; w: number; h: number } | null {
  const c = cartaoSvg(b, { paleta: PALETAS[o.tema ?? 'claro'], largura: o.largura, marca: o.marca });
  const png = svgParaPngJa(c.svg, o.escala ?? 2);
  return png ? { png, w: c.w * (o.escala ?? 2), h: c.h * (o.escala ?? 2) } : null;
}

/** O cartão do bloco em PNG. */
export async function visualParaPng(b: Bloco, o: OpcoesPng = {}): Promise<{ png: Buffer; w: number; h: number } | null> { return visualParaPngJa(b, o); }

/** A chave de uma cerca no PDF (a linguagem e o corpo, como o parser do Markdown entrega). */
export const chaveDaCerca = (lang: string, corpo: string): string => `${lang.toLowerCase()}\n${corpo}`;

/**
 * As cercas ```ergon-<tipo> de um documento já em PNG, para o PDF (lib/pdf-documento.ts, que é síncrono): o cartão no
 * tema claro, sem a marca (o documento já leva a identidade). A cerca que não valida fica de fora e o PDF mostra o código.
 */
export function pngsDasCercas(markdown: string, max = 40, locale?: Locale): Map<string, Buffer[]> {
  const out = new Map<string, Buffer[]>();
  for (const c of cercasDe(markdown).filter((x) => x.fechada && ehCercaVisual(x.lang)).slice(0, max)) {
    const chave = chaveDaCerca(c.lang, c.corpo);
    if (out.has(chave)) continue;
    const rs = blocosDaCerca(c.lang, c.corpo);
    if ('erro' in rs) continue;
    const pngs: Buffer[] = [];
    for (const r of rs) {
      if (!r.ok) continue;
      let p: Buffer | null = null;
      try { p = visualParaPngOpaco(r.bloco, { tema: 'claro', marca: null, locale }); } catch { p = null; }
      if (p) pngs.push(p);
    }
    if (pngs.length) out.set(chave, pngs);
  }
  return out;
}
