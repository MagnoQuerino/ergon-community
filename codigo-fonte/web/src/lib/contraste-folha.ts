// Leitura da folha de estilos para o teste de contraste que reprova a publicação (contraste.test.ts).
// Entende blocos dentro de @media/@supports, as variáveis dos três temas (claro, escuro e alto contraste), var() com reserva, color-mix(in srgb, …) e
// transparência; e aponta os defeitos que a conta simples não via: variável inexistente, atalho `font` com `inherit`,
// opacidade baixa em texto, letra pequena em controle, cor solta fora das cores de função e cor com nome de cor fixa.

import { over, parseColor, ratioRgb, type Rgb } from './contraste.ts';

export interface Decl { prop: string; value: string }
export interface Regra {
  /** seletor sem comentários */
  sel: string;
  /** os @ que envolvem a regra, de fora para dentro (ex.: ["@media (max-width: 600px)"]) */
  at: string[];
  /** linha (1…) do "{" da regra */
  line: number;
  decls: Decl[];
}
export type Cor = { rgb: Rgb; a: number };
export type Vars = Record<string, string>;

/** Comentários viram espaços (as linhas continuam batendo). */
const semComentarios = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** Divide no separador de nível de cima (fora de parênteses e aspas). */
export function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0; let q = ''; let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out;
}

/** Todas as regras da folha (também as de dentro de @media, @supports e @keyframes). */
export function regras(css: string): Regra[] {
  const src = semComentarios(css);
  const out: Regra[] = [];
  const stack: Array<{ kind: 'at' | 'rule'; prelude: string; start: number; line: number }> = [];
  let mark = 0; let line = 1; let q = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (q) { if (c === q && src[i - 1] !== '\\') q = ''; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    const top = stack[stack.length - 1];
    if (c === ';' && (!top || top.kind === 'at')) { mark = i + 1; continue; } // @import …; fora de regra
    if (c === '{') {
      const prelude = src.slice(mark, i).trim();
      stack.push({ kind: prelude.startsWith('@') ? 'at' : 'rule', prelude, start: i + 1, line });
      mark = i + 1;
    } else if (c === '}') {
      const ctx = stack.pop();
      if (ctx?.kind === 'rule') {
        const body = src.slice(ctx.start, i);
        const decls = splitTop(body, ';').map((d) => { const k = d.indexOf(':'); return k < 0 ? null : { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() }; })
          .filter((d): d is Decl => !!d && !!d.prop && !d.prop.includes('{'));
        out.push({ sel: ctx.prelude.replace(/\s+/g, ' '), at: stack.filter((s) => s.kind === 'at').map((s) => s.prelude), line: ctx.line, decls });
      }
      mark = i + 1;
    }
  }
  return out;
}

/**
 * Os seletores que têm ajuste próprio no tema escuro, um a um e inteiros: tira o `:root[data-theme="dark"] ` da frente
 * de cada parte e abre os `:is(...)`. Quem decide se uma regra de base já foi ajustada no escuro compara seletor inteiro
 * com este conjunto — nunca pedaço de nome (`.btn` não é `.btn--gold`, nem `.msg` é `.msg--user`).
 */
export function ajustadosNoEscuro(rs: Regra[]): Set<string> {
  const PREFIXO = /^:root\[data-theme="dark"\]\s+/;
  return new Set(rs.filter((r) => r.sel.includes(':root[data-theme="dark"]'))
    .flatMap((r) => splitTop(r.sel, ','))
    .map((s) => s.trim())
    .filter((s) => PREFIXO.test(s))
    .map((s) => s.replace(PREFIXO, ''))
    .flatMap((s) => { const m = s.match(/^:is\((.*)\)$/); return m ? splitTop(m[1], ',').map((x) => x.trim()) : [s]; }));
}

export const emKeyframes = (r: Regra) => r.at.some((a) => /^@(-webkit-)?keyframes/.test(a));
export const valor = (r: Regra, prop: string) => { let v: string | undefined; for (const d of r.decls) if (d.prop === prop) v = d.value; return v; };

/** Os blocos de cores de cada tema: só eles podem ter cor escrita (hex, rgb, nome). */
export const BLOCOS_DE_TEMA = [':root', ':root[data-theme="dark"]', ':root[data-theme="contraste"]'] as const;

/** As variáveis de um bloco de tema, como estão escritas. */
export function varsDoBloco(css: string, sel: string): Vars {
  return Object.fromEntries(regras(css).filter((r) => !r.at.length && r.sel === sel).flatMap((r) => r.decls.filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value])));
}

/** As variáveis dos três temas: o claro (`:root`), o escuro e o alto contraste (cada um: o claro mais o bloco dele). */
export function temas(css: string): { claro: Vars; escuro: Vars; contraste: Vars } {
  const claro = varsDoBloco(css, ':root');
  return { claro, escuro: { ...claro, ...varsDoBloco(css, BLOCOS_DE_TEMA[1]) }, contraste: { ...claro, ...varsDoBloco(css, BLOCOS_DE_TEMA[2]) } };
}

const NOMES: Record<string, Cor> = { white: { rgb: [255, 255, 255], a: 1 }, black: { rgb: [0, 0, 0], a: 1 }, transparent: { rgb: [0, 0, 0], a: 0 } };

/**
 * A cor de um valor da folha, no tema dado: hex, rgb(a), nomes básicos, var() (com reserva) e color-mix(in srgb, …).
 * `{ undef }` quando cai numa variável que não existe e sem reserva; `null` quando não é uma cor (gradiente, currentColor…).
 */
export function resolveColor(value: string | undefined, vars: Vars, depth = 0): Cor | { undef: string } | null {
  if (!value || depth > 12) return null;
  const v = value.replace(/\s*!important\s*$/i, '').trim();
  const lower = v.toLowerCase();
  if (NOMES[lower]) return NOMES[lower];
  const vm = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (vm) {
    if (vars[vm[1]] !== undefined) return resolveColor(vars[vm[1]], vars, depth + 1);
    return vm[2] !== undefined ? resolveColor(vm[2], vars, depth + 1) : { undef: vm[1] };
  }
  const mm = v.match(/^color-mix\(\s*in\s+srgb\s*,([\s\S]+)\)$/i);
  if (mm) {
    const parts = splitTop(mm[1], ',').map((p) => p.trim());
    if (parts.length !== 2) return null;
    const pp = parts.map((p) => { const x = p.match(/^([\s\S]*?)\s+([\d.]+)%$/); return x ? { c: x[1], p: Number(x[2]) as number | null } : { c: p, p: null as number | null }; });
    let p1 = pp[0].p; let p2 = pp[1].p;
    if (p1 === null && p2 === null) { p1 = 50; p2 = 50; } else if (p1 === null) p1 = 100 - (p2 as number); else if (p2 === null) p2 = 100 - p1;
    const A = resolveColor(pp[0].c, vars, depth + 1); const B = resolveColor(pp[1].c, vars, depth + 1);
    if (!A || !B) return null;
    if ('undef' in A) return A;
    if ('undef' in B) return B;
    const soma = (p1 as number) + (p2 as number); if (soma <= 0) return null;
    const w1 = (p1 as number) / soma; const w2 = (p2 as number) / soma;
    const a = A.a * w1 + B.a * w2;
    const escala = soma < 100 ? soma / 100 : 1;
    if (a === 0) return { rgb: [0, 0, 0], a: 0 };
    const rgb = [0, 1, 2].map((i) => (A.rgb[i] * A.a * w1 + B.rgb[i] * B.a * w2) / a) as Rgb;
    return { rgb, a: a * escala };
  }
  return parseColor(v);
}

/** A cor de fundo de uma regra (background-color, ou background quando é uma cor só). */
export function fundoDe(r: Regra): string | undefined {
  return valor(r, 'background-color') ?? valor(r, 'background');
}

/** Tamanho da letra de uma regra em px (font-size ou o atalho font), se houver. */
export function letraDe(r: Regra): number | undefined {
  let px: number | undefined;
  for (const d of r.decls) {
    if (d.prop === 'font-size') { const m = d.value.match(/^([\d.]+)px/); if (m) px = Number(m[1]); }
    if (d.prop === 'font') { const m = d.value.match(/(?:^|\s)([\d.]+)px(?=\s|\/|$)/); if (m) px = Number(m[1]); }
  }
  return px;
}

/** Contraste de um texto (talvez translúcido) sobre um fundo (talvez translúcido) pintado sobre `base`. */
export function contrasteSobre(fg: Cor, bg: Cor, base: Rgb, opacidade = 1): number {
  const fundo = over(bg, base);
  const tinta = over({ rgb: fg.rgb, a: fg.a * opacidade }, fundo);
  return ratioRgb(tinta, fundo);
}

// ---------- os defeitos que reprovam ----------

/** var(--x) de variável que não existe em lugar nenhum (nem na folha, nem posta pelo código: `extras`). */
export function variaveisInexistentes(css: string, extras: Iterable<string> = []): string[] {
  const rs = regras(css);
  const declaradas = new Set<string>([...extras]);
  for (const r of rs) for (const d of r.decls) if (d.prop.startsWith('--')) declaradas.add(d.prop);
  const bad: string[] = [];
  for (const r of rs) for (const d of r.decls) for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!declaradas.has(m[1])) bad.push(`linha ${r.line}: ${r.sel.slice(0, 60)} usa ${m[1]}`);
  }
  return bad;
}

/** `font: 700 10px/1 inherit` é inválido inteiro (o navegador joga fora a linha toda): só `font: inherit` sozinho vale. */
export function fontComInherit(css: string): string[] {
  return regras(css).flatMap((r) => r.decls.filter((d) => d.prop === 'font' && /\binherit\b/i.test(d.value) && d.value.replace(/\s*!important/i, '').trim().toLowerCase() !== 'inherit')
    .map((d) => `linha ${r.line}: ${r.sel.slice(0, 60)} { font: ${d.value} }`));
}

/**
 * Opacidade entre 0 e .8 numa regra que pinta texto. Ficam de fora: animações (@keyframes), o 0 (escondido até o
 * foco/passar o mouse), :disabled (o WCAG não pede contraste de controle inativo), ::before/::after (traços) e as
 * exceções dadas (seletor exato, cada uma justificada no teste).
 */
export function opacidadeEmTexto(css: string, excecoes: Iterable<string> = []): string[] {
  const ok = new Set(excecoes);
  const bad: string[] = [];
  for (const r of regras(css)) {
    if (emKeyframes(r)) continue;
    const o = valor(r, 'opacity'); if (o === undefined) continue;
    const n = Number(o.replace(/\s*!important/, '')); if (!Number.isFinite(n) || n <= 0 || n >= 0.8) continue;
    const partes = splitTop(r.sel, ',').map((s) => s.trim()).filter((s) => !/:disabled|::?(before|after)\b/.test(s) && !ok.has(s));
    if (partes.length) bad.push(`linha ${r.line}: ${partes.join(', ').slice(0, 80)} { opacity: ${o} }`);
  }
  return bad;
}

/** O último pedaço do seletor (o elemento que recebe o estilo) é um controle: botão, campo, link-botão, tecla. */
const CONTROLE = /(^|[^\w-])(button|input|select|textarea|kbd)(?![\w-])|\.(btn|linkish|chip--btn|icon-btn|iact)(?![\w-])|kbd|\[role="(button|tab|switch|option|menuitem)"\]/;
const ultimo = (sel: string) => { const p = sel.trim().split(/\s*[>+~]\s*|\s+/); return p[p.length - 1] ?? ''; };

/** Letra abaixo de `min` px num controle (botão, campo, tecla de atalho). */
export function letraPequenaEmControle(css: string, min = 12, excecoes: Iterable<string> = []): string[] {
  const ok = new Set(excecoes);
  const bad: string[] = [];
  for (const r of regras(css)) {
    if (emKeyframes(r)) continue;
    const px = letraDe(r); if (px === undefined || px >= min) continue;
    const partes = splitTop(r.sel, ',').map((s) => s.trim()).filter((s) => !ok.has(s) && CONTROLE.test(ultimo(s)));
    if (partes.length) bad.push(`linha ${r.line}: ${partes.join(', ').slice(0, 80)} (${px}px)`);
  }
  return bad;
}

/** Cor escrita direto: #hex, rgb()/rgba()/hsl() ou um nome de cor (white, black, red…). transparent e currentColor não contam. */
const COR_ESCRITA = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia|gold|pink|brown|beige|ivory)\b/i;
/** o valor sem os nomes de variável (var(--navy) não é a cor "navy") */
const semNomes = (v: string) => v.replace(/--[\w-]+/g, '');
/** Sombras: a cor é só a da sombra (preto ou branco translúcido), não uma cor da tela. */
const SO_SOMBRA = new Set(['box-shadow', 'text-shadow', 'filter', '-webkit-filter']);

/**
 * Cor solta: cor escrita direto numa regra de tela (fora dos blocos de tema), inclusive como reserva de var(). Toda cor
 * da tela vem das cores de função (var(--…)); as sombras ficam de fora. Também reprova as cores com nome de cor fixa
 * (--fx-…), que o tema escuro precisava remendar seletor a seletor.
 */
export function coresSoltas(css: string): string[] {
  const bad: string[] = [];
  for (const r of regras(css)) {
    if (!r.at.length && (BLOCOS_DE_TEMA as readonly string[]).includes(r.sel)) {
      for (const d of r.decls) if (/^--fx-/.test(d.prop)) bad.push(`linha ${r.line}: ${d.prop} (cor com nome de cor fixa)`); // i18n-ok: mensagem do teste de contraste, nunca vai à tela
      continue;
    }
    for (const d of r.decls) {
      if (/var\(\s*--fx-/.test(d.value) || /^--fx-/.test(d.prop)) { bad.push(`linha ${r.line}: ${r.sel.slice(0, 60)} usa --fx-`); continue; }
      if (SO_SOMBRA.has(d.prop)) continue;
      // nomes de propriedade e de animação não são cor (ex.: "animation: gold-pulse"); só o valor das que pintam
      if (/^(animation|transition|font|content|grid|counter|will-change)/.test(d.prop)) continue;
      if (COR_ESCRITA.test(semNomes(d.value))) bad.push(`linha ${r.line}: ${r.sel.slice(0, 60)} { ${d.prop}: ${d.value.slice(0, 60)} }`);
    }
  }
  return bad;
}

/** Seletores com ajuste próprio por tema (`:root[data-theme="…"] .x`): cada tema só redefine as cores de função. */
export function ajustesPorTema(css: string): string[] {
  return regras(css).filter((r) => r.sel.includes('[data-theme=') && !(BLOCOS_DE_TEMA as readonly string[]).includes(r.sel)).map((r) => `linha ${r.line}: ${r.sel.slice(0, 90)}`);
}
