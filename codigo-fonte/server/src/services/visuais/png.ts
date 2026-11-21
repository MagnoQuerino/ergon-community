/**
 * O bloco visual em PNG no servidor (o cartão de shared/visuais/svg.ts, rasterizado em 2x pelo resvg com a Inter que vai
 * junto, em server/assets/fontes): o que o Telegram e o Discord recebem e o que o PDF do relatório leva. Sem o resvg (uma
 * plataforma sem o binário pronto), devolve null e os canais seguem só com o texto.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bloco } from '../../../../shared/visuais/esquema.ts';
import { PALETAS } from '../../../../shared/visuais/paleta.ts';
import { cartaoSvg, type Marca } from '../../../../shared/visuais/svg.ts';
import { log } from '../../lib/log.ts';

const FONTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fontes');
type ResvgCtor = new (svg: string, o: unknown) => { render(): { asPng(): Buffer; width: number; height: number } };
let resvg: ResvgCtor | null | undefined;

async function carregar(): Promise<ResvgCtor | null> {
  if (resvg !== undefined) return resvg;
  try {
    const m = await import('@resvg/resvg-js') as unknown as { Resvg: ResvgCtor };
    resvg = m.Resvg;
  } catch (err) {
    log.warn({ erro: (err as Error).message.slice(0, 120) }, 'visuais: sem o resvg, os canais recebem só o texto');
    resvg = null;
  }
  return resvg;
}

const arquivosDeFonte = () => { try { return fs.readdirSync(FONTES).filter((f) => f.endsWith('.otf')).map((f) => path.join(FONTES, f)); } catch { return []; } };

export interface OpcoesPng { tema?: 'claro' | 'escuro'; marca?: Marca | null; largura?: number; escala?: number }

/** SVG → PNG (2x por padrão). */
export async function svgParaPng(svg: string, escala = 2): Promise<Buffer | null> {
  const R = await carregar();
  if (!R) return null;
  const r = new R(svg, { fitTo: { mode: 'zoom', value: escala }, font: { fontFiles: arquivosDeFonte(), loadSystemFonts: false, defaultFontFamily: 'Inter' }, background: 'rgba(0,0,0,0)' });
  return r.render().asPng();
}

/** O cartão do bloco em PNG. */
export async function visualParaPng(b: Bloco, o: OpcoesPng = {}): Promise<{ png: Buffer; w: number; h: number } | null> {
  const c = cartaoSvg(b, { paleta: PALETAS[o.tema ?? 'claro'], largura: o.largura ?? 720, marca: o.marca });
  const png = await svgParaPng(c.svg, o.escala ?? 2);
  return png ? { png, w: c.w * (o.escala ?? 2), h: c.h * (o.escala ?? 2) } : null;
}
