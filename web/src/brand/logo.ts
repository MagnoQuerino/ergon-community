/**
 * Marca oficial do Ergon em vetor (fonte única): emblema (cinco pessoas em roda em volta de um centro dourado)
 * e o logotipo ERGON. Redesenhado em geometria a partir da arte oficial (docs/brand/): as medidas abaixo são
 * da arte-mestre (1254 px), com o centro dourado na origem; o viewBox cuida da escala. Fica nítido em qualquer
 * tamanho e cada peça pode ser animada sozinha. Usado pela interface (React), pelos ícones gerados
 * (scripts/brand-assets.mjs) e pela tela de carregamento do index.html.
 */

/** Cores da marca (manual: Deep Navy, Teal, Muted Gold, Off-White/Stone) e as variações da versão escura. */
export const BRAND = {
  navy: '#1D184B', teal: '#1F5B6B', gold: '#B88B5B', stone: '#FDFCF8',
  night: '#140C34', tealOnDark: '#25859A', goldOnDark: '#C39463', black: '#141414',
} as const;

export type Tone = 'navy' | 'teal' | 'gold';
export interface Figure {
  id: 'top' | 'right' | 'left' | 'lowRight' | 'lowLeft';
  /** posição na roda (graus de tela: 0 = direita, 90 = baixo) */
  angle: number;
  tone: Tone;
  head: { cx: number; cy: number; r: number };
  /** braços: faixa curva em volta da cabeça, do lado do centro */
  arc: string;
  /** a mesma faixa em números (para desenhar sem SVG, ex.: os ícones PNG gerados por scripts/brand-assets.mjs) */
  band: Band;
  /** direção para fora (para a animação) */
  ux: number; uy: number;
}

type Pt = [number, number];
/**
 * Faixa entre duas elipses centradas em (cx, cy), com o eixo maior na direção `axis` (graus), cortada nas pontas
 * pelos segmentos `cuts` (ponto externo → ponto interno). `mid` é um ponto no meio da faixa.
 */
export interface Band { cx: number; cy: number; axis: number; ai: number; bi: number; ao: number; bo: number; mid: Pt; cuts: [[Pt, Pt], [Pt, Pt]] }

const f = (n: number) => Math.round(n * 10) / 10;
const rad = (deg: number) => (deg * Math.PI) / 180;

// Cada pessoa: cabeça + faixa entre duas elipses centradas na cabeça (mais grossa no meio, afinando nas pontas),
// com as pontas cortadas em linha reta (o lado de fora termina um pouco antes). Medidas da arte-mestre; a de cima é
// um pouco maior, e as duas de baixo ficam mais perto do centro e com os braços virados uma para a outra.
interface Spec {
  d: number; hr: number;
  ai: number; bi: number; ao: number; bo: number; // elipses interna/externa (eixo maior apontando para o centro)
  rot: number;                                    // giro do eixo da faixa em relação ao centro
  iCw: number; oCw: number; iCcw: number; oCcw: number; // ponta da faixa (graus a partir do centro) por lado
}
const TOP: Spec = { d: 242.8, hr: 47.7, ai: 85.8, bi: 77.9, ao: 146.6, bo: 129, rot: 0, iCw: 84, oCw: 75.7, iCcw: 84, oCcw: 75.7 };
const SIDE: Spec = { d: 245.1, hr: 43.3, ai: 76.5, bi: 70.7, ao: 137, bo: 120.6, rot: -5.25, iCw: 86.5, oCw: 77, iCcw: 89.75, oCcw: 75.15 };
const LOW: Spec = { d: 227.3, hr: 43.3, ai: 68.7, bi: 64.6, ao: 133.5, bo: 121.5, rot: -14.75, iCw: 88.8, oCw: 81.5, iCcw: 85.85, oCcw: 76.5 };
const SIDE_ANGLE = -19.4;
const LOW_ANGLE = 49.3;
export const CORE_R = 72.3;
/** Caixa do emblema (sem margem), em unidades da arte-mestre. */
export const EMBLEM_BOX = { x: -274.5, y: -290.5, w: 549, h: 519.5 } as const;
/** viewBox quadrado com o emblema centrado (para ícones e avatares). */
export const EMBLEM_VIEWBOX = emblemViewBox(0.06);

/** viewBox quadrado em volta do emblema, com margem `pad` (fração do lado) em cada borda. */
export function emblemViewBox(pad: number): string {
  const b = EMBLEM_BOX; const s = Math.max(b.w, b.h) * (1 + 2 * pad);
  return `${f(b.x + b.w / 2 - s / 2)} ${f(b.y + b.h / 2 - s / 2)} ${f(s)} ${f(s)}`;
}

/** Ponto da elipse (semi-eixos a ao longo de `axis`, b perpendicular) na direção polar `th`, a partir do centro. */
function onEllipse(cx: number, cy: number, a: number, b: number, axis: number, th: number): Pt {
  const t = rad(th - axis);
  const r = 1 / Math.sqrt((Math.cos(t) / a) ** 2 + (Math.sin(t) / b) ** 2);
  return [f(cx + r * Math.cos(rad(th))), f(cy + r * Math.sin(rad(th)))];
}

function figure(id: Figure['id'], s: Spec, angle: number, mirror: boolean, tone: Tone): Figure {
  const ux = Math.cos(rad(angle)); const uy = Math.sin(rad(angle));
  const hx = s.d * ux; const hy = s.d * uy;
  const inward = angle + 180;
  const axis = inward + (mirror ? -s.rot : s.rot);
  const [iCw, oCw, iCcw, oCcw] = mirror ? [s.iCcw, s.oCcw, s.iCw, s.oCw] : [s.iCw, s.oCw, s.iCcw, s.oCcw];
  const o1 = onEllipse(hx, hy, s.ao, s.bo, axis, inward - oCcw); const o2 = onEllipse(hx, hy, s.ao, s.bo, axis, inward + oCw);
  const i2 = onEllipse(hx, hy, s.ai, s.bi, axis, inward + iCw); const i1 = onEllipse(hx, hy, s.ai, s.bi, axis, inward - iCcw);
  const arc = `M${o1.join(' ')}A${s.ao} ${s.bo} ${f(axis)} 0 1 ${o2.join(' ')}L${i2.join(' ')}A${s.ai} ${s.bi} ${f(axis)} 0 0 ${i1.join(' ')}Z`;
  const mr = (s.ai + s.ao) / 2;
  const band: Band = { cx: hx, cy: hy, axis, ai: s.ai, bi: s.bi, ao: s.ao, bo: s.bo, mid: [hx + mr * Math.cos(rad(inward)), hy + mr * Math.sin(rad(inward))], cuts: [[o1, i1], [o2, i2]] };
  return { id, angle, tone, head: { cx: f(hx), cy: f(hy), r: s.hr }, arc, band, ux: Math.round(ux * 1000) / 1000, uy: Math.round(uy * 1000) / 1000 };
}

/** As cinco pessoas, no sentido horário a partir da de cima: três em azul-marinho em cima, duas em verde-petróleo embaixo. */
export function figures(): Figure[] {
  return [
    figure('top', TOP, -90, false, 'navy'),
    figure('right', SIDE, SIDE_ANGLE, false, 'navy'),
    figure('lowRight', LOW, LOW_ANGLE, false, 'teal'),
    figure('lowLeft', LOW, 180 - LOW_ANGLE, true, 'teal'),
    figure('left', SIDE, 180 - SIDE_ANGLE, true, 'navy'),
  ];
}

export interface Palette { navy: string; teal: string; gold: string }
/** Cores do emblema: normal (fundo claro), escura (fundo escuro) ou de uma cor só. */
export function palette(opts: { onDark?: boolean; mono?: string } = {}): Palette {
  if (opts.mono) return { navy: opts.mono, teal: opts.mono, gold: opts.mono };
  return opts.onDark
    ? { navy: BRAND.stone, teal: BRAND.tealOnDark, gold: BRAND.goldOnDark }
    : { navy: BRAND.navy, teal: BRAND.teal, gold: BRAND.gold };
}

/**
 * Logotipo ERGON (letras desenhadas, não fonte): hastes verticais mais grossas que as horizontais, barra do meio
 * do E e perna do R soltas da haste, G e O levemente largos, N com vértices em ponta. Unidades da arte-mestre:
 * altura das maiúsculas 119, linha de base em y = 119. Cada letra é uma lista de partes (uniões, não furos).
 */
export const WORD_BOX = { x: 0, y: -4, w: 789, h: 129.4 } as const;
export function wordmark(): Array<{ ch: string; parts: string[] }> {
  const ring = (cx: number, cy: number, rx: number, ry: number, ix: number, iy: number) =>
    `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`
    + `M${cx + ix} ${cy}A${ix} ${iy} 0 1 0 ${cx - ix} ${cy}A${ix} ${iy} 0 1 0 ${cx + ix} ${cy}Z`;
  // G: anel do lado direito (0°) dando a volta por baixo até o terminal em cima à direita, mais a barra
  const gx = 370.5, gy = 59.5, gT = rad(-44.5);
  const gArc = `M${gx + 68.5} ${gy}A68.5 63.5 0 1 1 ${f(gx + 68.5 * Math.cos(gT))} ${f(gy + 63.5 * Math.sin(gT))}`
    + `L${f(gx + 50.5 * Math.cos(gT))} ${f(gy + 49.5 * Math.sin(gT))}A50.5 49.5 0 1 0 ${gx + 50.5} ${gy}Z`;
  return [
    { ch: 'E', parts: ['M0 0H109L99 14H18V105H99L109 119H0Z', 'M37 53H88V66H37Z'] },
    { ch: 'R', parts: [
      'M154 0H171V119H154Z',
      'M171 0H221.5A36.5 36.5 0 0 1 221.5 73H191V61H221.5A18.5 24 0 0 0 221.5 13H171Z',
      'M194 68H216L267 119H245Z',
    ] },
    { ch: 'G', parts: [gArc, `M363 54H${f(gx + 68.5 * Math.sqrt(1 - (5.5 / 63.5) ** 2))}V66H363Z`] },
    { ch: 'O', parts: [ring(547.5, 59.5, 72.5, 63.5, 54.5, 49.5)] },
    { ch: 'N', parts: ['M665 -2V119H682V34.7L789 125.4V0H771V87.3Z'] },
  ];
}

/**
 * Conteúdo do emblema (sem o <svg> em volta), com o centro dourado na origem. Cada pessoa é um grupo com a
 * direção para fora em variáveis CSS (--ux, --uy) e a ordem na roda (--i): é isso que a animação de carregamento
 * (brand.css) move. Fora da página (arquivos, ícones) as classes e variáveis não fazem nada.
 */
export function emblemMarkup(p: Palette): string {
  return figures().map((g, i) =>
    `<g class="eg-fig eg-fig--${g.tone}" style="--ux:${g.ux};--uy:${g.uy};--i:${i}" fill="${p[g.tone]}"><g class="eg-fig__move">`
    + `<path class="eg-fig__arms" d="${g.arc}"/><circle class="eg-fig__head" cx="${g.head.cx}" cy="${g.head.cy}" r="${g.head.r}"/></g></g>`,
  ).join('') + `<circle class="eg-core" r="${CORE_R}" fill="${p.gold}"/>`;
}

/** Conteúdo do logotipo: uma letra por grupo (--i para a entrada letra a letra). */
export function wordMarkup(color: string): string {
  return `<g fill="${color}">${wordmark().map((l, i) => `<g class="eg-letter" style="--i:${i}">${l.parts.map((d) => `<path d="${d}"/>`).join('')}</g>`).join('')}</g>`;
}

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

/** SVG completo do emblema (arquivos, favicon). */
export function emblemSvg(opts: { onDark?: boolean; mono?: string; size?: number; viewBox?: string } = {}): string {
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  return `<svg ${XMLNS} viewBox="${opts.viewBox ?? EMBLEM_VIEWBOX}"${size} role="img" aria-label="Ergon">${emblemMarkup(palette(opts))}</svg>`;
}

/** SVG do logotipo (só a palavra). */
export function wordmarkSvg(color: string = BRAND.navy): string {
  const b = WORD_BOX;
  return `<svg ${XMLNS} viewBox="${b.x} ${b.y} ${b.w} ${b.h}" role="img" aria-label="ERGON">${wordMarkup(color)}</svg>`;
}

export type LockupKind = 'stacked' | 'horizontal';
/**
 * Emblema + palavra num só desenho: empilhada como na arte oficial (emblema centrado sobre a palavra, folga de 53)
 * ou horizontal como no manual (emblema à esquerda; maiúsculas com 36% da altura do emblema, folga de 30%).
 */
export function lockupLayout(kind: LockupKind): { emblem: { x: number; y: number; w: number; h: number }; word: { x: number; y: number; w: number; h: number }; w: number; h: number } {
  const E = EMBLEM_BOX, Wd = WORD_BOX;
  if (kind === 'stacked') {
    return { emblem: { x: (Wd.w - E.w) / 2, y: 0, w: E.w, h: E.h }, word: { x: 0, y: E.h + 53, w: Wd.w, h: Wd.h }, w: Wd.w, h: E.h + 53 + Wd.h };
  }
  const s = (E.h * 0.36) / 119; const gap = E.h * 0.3;
  const word = { x: E.w + gap, y: (E.h - 119 * s) / 2 + Wd.y * s, w: Wd.w * s, h: Wd.h * s };
  return { emblem: { x: 0, y: 0, w: E.w, h: E.h }, word, w: E.w + gap + word.w, h: E.h };
}

/**
 * Marca completa. Emblema e palavra vão em <svg> aninhados, cada um com seu próprio sistema de coordenadas: no
 * emblema a origem é o centro dourado, de modo que a animação gira e afasta as pessoas em volta dele.
 */
export function logoSvg(opts: { kind?: LockupKind; onDark?: boolean; mono?: string; className?: string } = {}): string {
  const L = lockupLayout(opts.kind ?? 'stacked');
  const p = palette(opts);
  const E = EMBLEM_BOX, Wd = WORD_BOX;
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return `<svg ${XMLNS} viewBox="0 0 ${f(L.w)} ${f(L.h)}"${cls} role="img" aria-label="Ergon">`
    + `<svg x="${f(L.emblem.x)}" y="${f(L.emblem.y)}" width="${f(L.emblem.w)}" height="${f(L.emblem.h)}" viewBox="${E.x} ${E.y} ${E.w} ${E.h}" overflow="visible">${emblemMarkup(p)}</svg>`
    + `<svg x="${f(L.word.x)}" y="${f(L.word.y)}" width="${f(L.word.w)}" height="${f(L.word.h)}" viewBox="${Wd.x} ${Wd.y} ${Wd.w} ${Wd.h}" overflow="visible">${wordMarkup(p.navy)}</svg></svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * Tela de carregamento (a mesma no index.html, antes do app carregar, e no app): o emblema se forma — as cinco
 * pessoas chegam girando de fora até a roda e o centro dourado aparece — e depois uma onda passa de pessoa em
 * pessoa, no sentido horário, enquanto o centro respira. A palavra entra letra a letra.
 */
export function splashHtml(label?: string): string {
  return `<div class="eg-splash" role="status" aria-live="polite">`
    + `<svg class="eg-mark eg-anim" viewBox="${EMBLEM_VIEWBOX}" aria-hidden="true">${emblemMarkup(palette())}</svg>`
    + `<svg class="eg-word eg-anim" viewBox="${WORD_BOX.x} ${WORD_BOX.y} ${WORD_BOX.w} ${WORD_BOX.h}" aria-hidden="true">${wordMarkup(BRAND.navy)}</svg>`
    + `<p class="eg-splash__label">${esc(label ?? 'Carregando…')}</p></div>`;
}
