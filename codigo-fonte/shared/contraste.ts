// Contraste de leitura (WCAG): o texto precisa ser legível em todo tema, inclusive para quem enxerga mal. Aqui ficam a
// conta (luminância, razão) e a regra automática "texto legível sobre este fundo" (readableOn), usada onde a cor vem
// de dados: retrato de letra dos agentes, cores de equipes instaladas, iniciais de marcas, etiquetas da Cidade nas
// skins. Compartilhado: a tela (web/src/lib/contraste.ts) e o validador de pacotes do servidor (shared/legibilidade.ts)
// usam a mesma conta.

export type Rgb = [number, number, number];

/** Texto normal: 4,5:1. Ícones, bordas de controle e contorno de foco: 3:1. */
export const MIN_TEXTO = 4.5;
export const MIN_GRAFICO = 3;
/** As duas tintas da marca para texto sobre cor: a escura (a mesma do botão dourado) e o branco. */
export const TINTA_ESCURA = '#1d1606';
export const TINTA_CLARA = '#ffffff';

/** Lê #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() e rgba(). Devolve canais de 0 a 255 e a opacidade; `null` se não for cor. */
export function parseColor(input: string | null | undefined): { rgb: Rgb; a: number } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const h = s.match(/^#([0-9a-f]{3,8})$/);
  if (h) {
    let x = h[1];
    if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('');
    if (x.length !== 6 && x.length !== 8) return null;
    const n = (i: number) => parseInt(x.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: x.length === 8 ? n(6) / 255 : 1 };
  }
  const f = s.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/);
  if (f) {
    const c = [f[1], f[2], f[3]].map(Number);
    if (c.some((v) => !Number.isFinite(v) || v > 255)) return null;
    const a = f[4] === undefined ? 1 : Number(f[4]) / (f[5] ? 100 : 1);
    return { rgb: c as Rgb, a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}

const clamp = (v: number) => Math.max(0, Math.min(255, v));
export const toHex = (c: Rgb) => `#${c.map((v) => Math.round(clamp(v)).toString(16).padStart(2, '0')).join('')}`;
const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const lumRgb = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const ratioRgb = (a: Rgb, b: Rgb) => { const [x, y] = [lumRgb(a), lumRgb(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const need = (h: string): Rgb => { const c = parseColor(h); if (!c) throw new Error(`cor inválida: ${h}`); return c.rgb; }; // i18n-ok: erro de programação, nunca vai à tela

/** Razão de contraste entre duas cores opacas (1 a 21). Texto normal pede pelo menos 4,5. */
export const contrast = (a: string, b: string) => ratioRgb(need(a), need(b));
/** Uma cor translúcida pintada sobre um fundo opaco: o que o olho vê. */
export const over = (top: { rgb: Rgb; a: number }, base: Rgb): Rgb => top.rgb.map((v, i) => v * top.a + base[i] * (1 - top.a)) as Rgb;

// Tom, saturação e luz (HSL): ajustar o fundo "mantendo o tom" é mexer só na luz.
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}
function fromHsl([h, s, l]: [number, number, number]): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * Garante o contraste entre um texto e um fundo mexendo só no fundo, e só na luz dele (o tom e a saturação ficam):
 * devolve o próprio fundo se já passa; senão, a versão mais próxima (mais escura ou mais clara) que chega a `min`.
 */
export function ensureContrast(fg: string, bg: string, min = MIN_TEXTO): string {
  const F = need(fg); const B = need(bg);
  if (ratioRgb(F, B) >= min) return toHex(B);
  const [h, s, l] = toHsl(B);
  // para onde ir: texto claro pede fundo mais escuro; texto escuro, mais claro
  const alvo = lumRgb(F) > lumRgb(B) ? 0 : 1;
  const passa = (luz: number) => ratioRgb(F, need(toHex(fromHsl([h, s, luz])))) >= min; // já no hex que vai à tela
  const ate = (extremo: number): string | null => {
    if (!passa(extremo)) return null;
    let perto = l; let longe = extremo; // perto: ainda não passa; longe: passa
    for (let i = 0; i < 24; i++) { const meio = (perto + longe) / 2; if (passa(meio)) longe = meio; else perto = meio; }
    return toHex(fromHsl([h, s, longe]));
  };
  // texto de tom médio (um cinza) pode só passar indo para o outro lado: tenta antes de desistir
  return ate(alvo) ?? ate(1 - alvo) ?? toHex(fromHsl([h, s, alvo])); // nem os extremos chegam: o melhor possível
}

export interface Legivel {
  /** o fundo a pintar: o mesmo que entrou, a não ser que nenhuma tinta chegasse ao mínimo (aí, o mesmo tom com outra luz) */
  bg: string;
  /** a tinta do texto: a escura da marca ou o branco */
  fg: string;
  /** contraste final entre os dois */
  ratio: number;
  /** verdadeiro quando o fundo precisou de ajuste */
  adjusted: boolean;
}

/**
 * Texto legível sobre este fundo. Escolhe, entre a tinta escura da marca e o branco, a de maior contraste; se nenhuma
 * chega ao mínimo (faixa estreita de tons médios), ajusta o fundo mantendo o tom, pelo menor passo. Cor com
 * transparência é tratada pela cor cheia (o fundo devolvido é sempre opaco). Devolve `null` se a entrada não é cor.
 */
export function readableOn(bg: string | null | undefined, min = MIN_TEXTO): Legivel | null {
  const c = parseColor(bg);
  if (!c) return null;
  const base = toHex(c.rgb);
  const claro = ratioRgb(need(TINTA_CLARA), c.rgb); const escuro = ratioRgb(need(TINTA_ESCURA), c.rgb);
  const fg = claro >= escuro ? TINTA_CLARA : TINTA_ESCURA;
  if (Math.max(claro, escuro) >= min) return { bg: base, fg, ratio: Math.max(claro, escuro), adjusted: false };
  // nenhuma passa: testa os dois caminhos e fica com o que muda menos a cor
  const luz = toHsl(c.rgb)[2];
  const opcoes = [TINTA_CLARA, TINTA_ESCURA].map((tinta) => { const novo = ensureContrast(tinta, base, min); return { tinta, novo, passo: Math.abs(toHsl(need(novo))[2] - luz) }; });
  const melhor = opcoes[0].passo <= opcoes[1].passo ? opcoes[0] : opcoes[1];
  return { bg: melhor.novo, fg: melhor.tinta, ratio: contrast(melhor.tinta, melhor.novo), adjusted: true };
}

/** A tinta (escura da marca ou branco) que mais contrasta com o fundo, sem mexer nele: para cor que não é nossa (marcas). */
export function inkOn(bg: string | null | undefined): string {
  const c = parseColor(bg);
  if (!c) return TINTA_CLARA;
  return ratioRgb(need(TINTA_CLARA), c.rgb) >= ratioRgb(need(TINTA_ESCURA), c.rgb) ? TINTA_CLARA : TINTA_ESCURA;
}
