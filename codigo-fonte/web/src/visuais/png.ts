// "Baixar PNG": o cartão do bloco (shared/visuais/svg.ts, o mesmo do Telegram e do Discord) no tema da tela, desenhado
// num canvas em 2x e baixado. As cores vêm das variáveis CSS já resolvidas do tema atual.
import type { Bloco } from '../../../shared/visuais/esquema.ts';
import { PALETAS, VARIAVEL, type Paleta } from '../../../shared/visuais/paleta.ts';
import { cartaoSvg, type Marca } from '../../../shared/visuais/svg.ts';
import { idiomaAtual } from '../i18n/index.ts';

/** A paleta do tema que está na tela agora. */
export function paletaDaTela(): Paleta {
  const base = document.documentElement.dataset.theme === 'dark' ? PALETAS.escuro : PALETAS.claro;
  const cs = getComputedStyle(document.documentElement);
  const out = { ...base };
  for (const [k, v] of Object.entries(VARIAVEL) as Array<[keyof Paleta, string]>) {
    const x = cs.getPropertyValue(v).trim();
    if (x) out[k] = x;
  }
  return out;
}

const nomeDoArquivo = (b: Bloco) => `${(b.titulo ?? b.tipo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'visual'}.png`;

/** O PNG (2x) do bloco como Blob. */
export async function pngDoBloco(b: Bloco, marca: Marca | null | undefined, votos?: number[][]): Promise<Blob> {
  const c = cartaoSvg(b, { paleta: paletaDaTela(), locale: idiomaAtual(), marca, votos });
  const url = URL.createObjectURL(new Blob([c.svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((ok, falha) => { img.onload = () => ok(); img.onerror = () => falha(new Error('svg')); img.src = url; });
    const k = 2;
    const canvas = document.createElement('canvas');
    canvas.width = c.w * k; canvas.height = c.h * k;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('canvas');
    g.scale(k, k);
    g.drawImage(img, 0, 0, c.w, c.h);
    return await new Promise<Blob>((ok, falha) => canvas.toBlob((x) => (x ? ok(x) : falha(new Error('png'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

export async function baixarPng(b: Bloco, marca: Marca | null | undefined, votos?: number[][]): Promise<void> {
  const blob = await pngDoBloco(b, marca, votos);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nomeDoArquivo(b);
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
