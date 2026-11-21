/**
 * A geometria dos gráficos e infográficos (rc.42): cada bloco gráfico vira uma "cena" — retângulos, arcos, linhas,
 * textos e pictogramas com cores de função (nunca cor solta). A tela desenha a cena com elementos SVG do React e as cores
 * do tema (variáveis CSS); o PNG (na tela, para baixar, e no servidor, para o Telegram e o Discord) serializa a mesma
 * cena com a paleta do tema. Um desenho só, dois destinos: o que se baixa é o que se vê.
 *
 * Toda cena traz o texto alternativo e a tabela de dados por trás do gráfico (acessibilidade e fallback).
 */
import type { Bloco, BlocoDe, Formato, Moeda } from './esquema.ts';
import { escalaBonita, fmtValor, fmtVariacao, tomDaVariacao, type Locale } from './formato.ts';
import { caber, medir, quebrar } from './larguras.ts';
import type { Pictograma } from './pictogramas.ts';

export type Cor = 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'bom' | 'ruim' | 'atencao' | 'trilho' | 'tinta' | 'suave' | 'linha' | 'painel' | 'painel2' | 'marca' | 'sobre';
export type Anim = 'cresce-y' | 'cresce-x' | 'traca' | 'surge';
type Comum = { op?: number; anim?: Anim; i?: number };
export type Prim =
  | (Comum & { t: 'rect'; x: number; y: number; w: number; h: number; r?: number; cor: Cor })
  | (Comum & { t: 'circ'; cx: number; cy: number; r: number; cor: Cor | null; traco?: Cor; larg?: number })
  | (Comum & { t: 'path'; d: string; cor?: Cor | null; traco?: Cor; larg?: number; tracejado?: boolean; redondo?: boolean })
  | (Comum & { t: 'text'; x: number; y: number; s: string; tam: number; peso?: 400 | 600 | 700; cor: Cor; ancora?: 'start' | 'middle' | 'end' })
  | (Comum & { t: 'pict'; nome: Pictograma; x: number; y: number; tam: number; cor: Cor; fundo: Cor; corte?: number });
export interface Dados { cab: string[]; linhas: string[][] }
export interface Cena { w: number; h: number; prims: Prim[]; alt: string; dados?: Dados }

export const SERIES: readonly Cor[] = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];
export const FONTE_TAM = { eixo: 11, rotulo: 12, valor: 13, grande: 28 } as const;

const r1 = (n: number) => Math.round(n * 10) / 10;
interface Fmt { formato?: Formato; moeda?: Moeda; locale: Locale }
const fv = (v: number | null, f: Fmt, curto = false) => fmtValor(v, { formato: f.formato, moeda: f.moeda, locale: f.locale, curto });

/** O que os gráficos pedem: largura disponível e o idioma dos números. */
export interface OpcoesCena { largura: number; locale?: Locale; compacto?: boolean }

/** Os blocos desenhados como cena (os outros são texto com estilo na tela, e um cartão próprio no PNG). */
export const GRAFICOS = new Set<Bloco['tipo']>(['barras', 'linhas', 'pizza', 'medidor', 'sparkline', 'icones', 'funil', 'calor', 'matriz']);

export function cenaDe(b: Bloco, o: OpcoesCena): Cena | null {
  const f: Fmt = { formato: 'formato' in b ? (b.formato as Formato | undefined) : undefined, moeda: 'moeda' in b ? (b.moeda as Moeda | undefined) : undefined, locale: o.locale ?? 'pt-BR' };
  switch (b.tipo) {
    case 'barras': return b.horizontal ? barrasH(b, o, f) : barrasV(b, o, f);
    case 'linhas': return linhas(b, o, f);
    case 'pizza': return pizza(b, o, f);
    case 'medidor': return b.estilo === 'termometro' ? termometro(b, o, f) : medidor(b, o, f);
    case 'sparkline': return sparkline(b.serie, o.largura, Math.min(56, Math.round(o.largura / 4)), b.bom ?? 'alta', `${b.rotulo}: ${fv(b.serie.at(-1) ?? 0, f)}`, f);
    case 'icones': return icones(b, o);
    case 'funil': return funil(b, o, f);
    case 'calor': return calor(b, o, f);
    case 'matriz': return matriz(b, o);
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------- barras

function barrasV(b: BlocoDe<'barras'>, o: OpcoesCena, f: Fmt): Cena {
  const W = Math.max(240, o.largura); const H = Math.round(Math.min(300, Math.max(180, W * 0.5)));
  const ss = b.series; const n = b.categorias.length;
  const somas = b.categorias.map((_, i) => ss.reduce((a, s) => a + Math.max(0, s.valores[i] ?? 0), 0));
  const todos = ss.flatMap((s) => s.valores.filter((v): v is number => v !== null));
  const max = Math.max(b.empilhado ? Math.max(...somas) : Math.max(...todos, 0), b.meta ?? 0);
  const min = b.empilhado ? 0 : Math.min(0, ...todos);
  const esc = escalaBonita(min, max, 4);
  const eixoW = Math.max(...esc.marcas.map((m) => medir(fv(m, f, true), FONTE_TAM.eixo))) + 8;
  const legH = ss.length > 1 ? 22 : 0;
  const x0 = eixoW; const y0 = legH + 8; const y1 = H - 26; const pw = W - x0 - 4;
  const y = (v: number) => y1 - ((v - esc.min) / (esc.max - esc.min)) * (y1 - y0);
  const prims: Prim[] = [];
  for (const m of esc.marcas) {
    prims.push({ t: 'path', d: `M${x0} ${r1(y(m))}H${W}`, traco: m === 0 ? 'linha' : 'linha', larg: m === 0 ? 1.2 : 1, op: m === 0 ? 1 : 0.6 });
    prims.push({ t: 'text', x: x0 - 6, y: r1(y(m)) + 4, s: fv(m, f, true), tam: FONTE_TAM.eixo, cor: 'suave', ancora: 'end' });
  }
  const banda = pw / n; const grupoW = Math.min(banda * 0.72, 64 * (b.empilhado ? 1 : ss.length));
  const barW = b.empilhado ? grupoW : grupoW / ss.length;
  b.categorias.forEach((c, i) => {
    const gx = x0 + banda * i + (banda - grupoW) / 2;
    let base = 0;
    ss.forEach((s, k) => {
      const v = s.valores[i];
      if (v === null) return;
      const apagada = b.destaque !== undefined && ss.length === 1 && i !== b.destaque;
      const cor: Cor = SERIES[k % 6];
      const top = b.empilhado ? y(base + v) : y(Math.max(0, v)); const bot = b.empilhado ? y(base) : y(Math.min(0, v));
      const bx = b.empilhado ? gx : gx + barW * k;
      prims.push({ t: 'rect', x: r1(bx + (b.empilhado ? 0 : 1)), y: r1(top), w: r1(Math.max(1, barW - (b.empilhado ? 0 : 2))), h: r1(Math.max(1, bot - top)), r: b.empilhado ? 0 : Math.min(4, barW / 4), cor, op: apagada ? 0.3 : undefined, anim: 'cresce-y', i });
      if (b.empilhado) base += v;
    });
    // o valor em cima quando cabe (uma série ou empilhado: o total)
    if (ss.length === 1 || b.empilhado) {
      const v = b.empilhado ? somas[i] : ss[0].valores[i];
      const s = v === null ? '' : fv(v, f, true);
      if (s && medir(s, FONTE_TAM.eixo, 600) < banda - 2) prims.push({ t: 'text', x: r1(gx + grupoW / 2), y: r1(y(Math.max(0, v ?? 0)) - 6), s, tam: FONTE_TAM.eixo, peso: 600, cor: 'tinta', ancora: 'middle', anim: 'surge', i });
    }
    const rot = caber(c, FONTE_TAM.eixo, banda - 4);
    prims.push({ t: 'text', x: r1(x0 + banda * i + banda / 2), y: H - 8, s: rot, tam: FONTE_TAM.eixo, cor: i === b.destaque ? 'tinta' : 'suave', peso: i === b.destaque ? 600 : 400, ancora: 'middle' });
  });
  if (b.meta !== undefined) metaLinha(prims, x0, W, y(b.meta), fv(b.meta, f, true));
  if (legH) legenda(prims, ss.map((s) => s.nome), 0, 12, W);
  return { w: W, h: H, prims, alt: altSeries(b.titulo, b.categorias, ss, f), dados: dadosSeries(b.categorias, ss, f) };
}

function barrasH(b: BlocoDe<'barras'>, o: OpcoesCena, f: Fmt): Cena {
  const W = Math.max(240, o.largura); const ss = b.series; const n = b.categorias.length;
  const legH = ss.length > 1 ? 22 : 0;
  const linhaH = b.empilhado || ss.length === 1 ? 30 : 14 * ss.length + 14;
  const H = legH + n * linhaH + 8;
  const somas = b.categorias.map((_, i) => ss.reduce((a, s) => a + Math.max(0, s.valores[i] ?? 0), 0));
  const max = Math.max(b.empilhado ? Math.max(...somas) : Math.max(...ss.flatMap((s) => s.valores.map((v) => v ?? 0))), b.meta ?? 0, 1e-9);
  const rotW = Math.min(W * 0.34, Math.max(...b.categorias.map((c) => medir(c, FONTE_TAM.rotulo))) + 10);
  const valW = Math.max(...b.categorias.map((_, i) => medir(fv(b.empilhado ? somas[i] : Math.max(...ss.map((s) => s.valores[i] ?? 0)), f, true), FONTE_TAM.rotulo, 600))) + 10;
  const x0 = rotW; const pw = W - x0 - valW;
  const prims: Prim[] = [];
  b.categorias.forEach((c, i) => {
    const yy = legH + i * linhaH + 4;
    prims.push({ t: 'text', x: 0, y: yy + linhaH / 2 + 2, s: caber(c, FONTE_TAM.rotulo, rotW - 8), tam: FONTE_TAM.rotulo, cor: i === b.destaque ? 'tinta' : 'suave', peso: i === b.destaque ? 600 : 400 });
    prims.push({ t: 'rect', x: x0, y: yy + 6, w: r1(pw), h: linhaH - 16, r: (linhaH - 16) / 2, cor: 'trilho' });
    let base = 0;
    ss.forEach((s, k) => {
      const v = Math.max(0, s.valores[i] ?? 0);
      const cor: Cor = b.destaque !== undefined && ss.length === 1 ? (i === b.destaque ? 'v1' : 'v6') : SERIES[k % 6];
      const bh = b.empilhado || ss.length === 1 ? linhaH - 16 : 10;
      const by = b.empilhado || ss.length === 1 ? yy + 6 : yy + 4 + k * 14;
      const bx = x0 + (b.empilhado ? (base / max) * pw : 0);
      prims.push({ t: 'rect', x: r1(bx), y: r1(by), w: r1(Math.max(2, (v / max) * pw)), h: bh, r: bh / 2, cor, anim: 'cresce-x', i });
      if (b.empilhado) base += v;
    });
    const tv = b.empilhado ? somas[i] : ss.length === 1 ? ss[0].valores[i] ?? 0 : Math.max(...ss.map((s) => s.valores[i] ?? 0));
    prims.push({ t: 'text', x: W, y: yy + linhaH / 2 + 2, s: fv(tv, f, true), tam: FONTE_TAM.rotulo, peso: 600, cor: 'tinta', ancora: 'end', anim: 'surge', i });
  });
  if (b.meta !== undefined) {
    const mx = r1(x0 + (b.meta / max) * pw);
    prims.push({ t: 'path', d: `M${mx} ${legH}V${H - 4}`, traco: 'tinta', larg: 1.2, tracejado: true, op: 0.7 });
  }
  if (legH) legenda(prims, ss.map((s) => s.nome), 0, 12, W);
  return { w: W, h: H, prims, alt: altSeries(b.titulo, b.categorias, ss, f), dados: dadosSeries(b.categorias, ss, f) };
}

function metaLinha(prims: Prim[], x0: number, x1: number, yy: number, rotulo: string) {
  prims.push({ t: 'path', d: `M${x0} ${r1(yy)}H${x1}`, traco: 'tinta', larg: 1.2, tracejado: true, op: 0.75 });
  const s = `meta ${rotulo}`;
  const w = medir(s, 10, 600) + 10;
  prims.push({ t: 'rect', x: r1(x1 - w), y: r1(yy - 9), w: r1(w), h: 16, r: 8, cor: 'painel2' });
  prims.push({ t: 'text', x: r1(x1 - w / 2), y: r1(yy + 3), s, tam: 10, peso: 600, cor: 'tinta', ancora: 'middle' });
}

function legenda(prims: Prim[], nomes: string[], x: number, y: number, W: number) {
  let cx = x;
  nomes.forEach((nome, k) => {
    const s = caber(nome, FONTE_TAM.eixo, 140);
    const w = medir(s, FONTE_TAM.eixo) + 22;
    if (cx + w > W) return;
    prims.push({ t: 'rect', x: cx, y: y - 8, w: 10, h: 10, r: 3, cor: SERIES[k % 6] });
    prims.push({ t: 'text', x: cx + 14, y: y + 1, s, tam: FONTE_TAM.eixo, cor: 'suave' });
    cx += w;
  });
}

const altSeries = (titulo: string | undefined, cats: string[], ss: Array<{ nome: string; valores: Array<number | null> }>, f: Fmt) =>
  `${titulo ? `${titulo}. ` : ''}${ss.map((s) => `${s.nome}: ${cats.map((c, i) => `${c} ${fv(s.valores[i], f)}`).join(', ')}`).join('. ')}.`;
const dadosSeries = (cats: string[], ss: Array<{ nome: string; valores: Array<number | null> }>, f: Fmt): Dados =>
  ({ cab: ['', ...ss.map((s) => s.nome)], linhas: cats.map((c, i) => [c, ...ss.map((s) => fv(s.valores[i], f))]) });

// ------------------------------------------------------------------------------------------- linhas

function linhas(b: BlocoDe<'linhas'>, o: OpcoesCena, f: Fmt): Cena {
  const W = Math.max(240, o.largura); const H = Math.round(Math.min(280, Math.max(170, W * 0.45)));
  const ss = b.series; const n = b.categorias.length;
  const todos = ss.flatMap((s) => s.valores.filter((v): v is number => v !== null));
  const esc = escalaBonita(Math.min(0, ...todos), Math.max(...todos, b.meta ?? -Infinity), 4);
  const eixoW = Math.max(...esc.marcas.map((m) => medir(fv(m, f, true), FONTE_TAM.eixo))) + 8;
  const legH = ss.length > 1 ? 22 : 0;
  const x0 = eixoW; const y0 = legH + 10; const y1 = H - 26; const x1 = W - 8;
  const x = (i: number) => x0 + 6 + (i / Math.max(1, n - 1)) * (x1 - x0 - 12);
  const y = (v: number) => y1 - ((v - esc.min) / (esc.max - esc.min)) * (y1 - y0);
  const prims: Prim[] = [];
  for (const m of esc.marcas) {
    prims.push({ t: 'path', d: `M${x0} ${r1(y(m))}H${W}`, traco: 'linha', larg: 1, op: 0.6 });
    prims.push({ t: 'text', x: x0 - 6, y: r1(y(m)) + 4, s: fv(m, f, true), tam: FONTE_TAM.eixo, cor: 'suave', ancora: 'end' });
  }
  // rótulos do eixo x: no máximo ~1 a cada 56 px
  const passo = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((x1 - x0) / 56))));
  b.categorias.forEach((c, i) => {
    if (i % passo && i !== n - 1) return;
    prims.push({ t: 'text', x: r1(x(i)), y: H - 8, s: caber(c, FONTE_TAM.eixo, 54 * passo), tam: FONTE_TAM.eixo, cor: 'suave', ancora: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' });
  });
  ss.forEach((s, k) => {
    const pts = s.valores.map((v, i) => (v === null ? null : [r1(x(i)), r1(y(v))] as const));
    const d = pts.reduce((a, p, i) => (p ? `${a}${a && pts[i - 1] ? 'L' : 'M'}${p[0]} ${p[1]}` : a), '');
    if (b.area && ss.length <= 2) {
      const ok = pts.filter(Boolean) as Array<readonly [number, number]>;
      if (ok.length > 1) prims.push({ t: 'path', d: `M${ok[0][0]} ${r1(y1)}${ok.map((p) => `L${p[0]} ${p[1]}`).join('')}L${ok.at(-1)![0]} ${r1(y1)}Z`, cor: SERIES[k], op: 0.14, anim: 'surge' });
    }
    prims.push({ t: 'path', d, cor: null, traco: SERIES[k % 6], larg: 2.4, redondo: true, anim: 'traca', i: k });
    const ult = [...pts].reverse().find(Boolean);
    if (ult) prims.push({ t: 'circ', cx: ult[0], cy: ult[1], r: 4, cor: SERIES[k % 6], traco: 'painel', larg: 2, anim: 'surge', i: k });
  });
  if (b.meta !== undefined) metaLinha(prims, x0, W, y(b.meta), fv(b.meta, f, true));
  if (legH) legenda(prims, ss.map((s) => s.nome), 0, 12, W);
  return { w: W, h: H, prims, alt: altSeries(b.titulo, b.categorias, ss, f), dados: dadosSeries(b.categorias, ss, f) };
}

// ------------------------------------------------------------------------------------------- pizza / rosca

const polar = (cx: number, cy: number, r: number, a: number) => [r1(cx + r * Math.cos(a)), r1(cy + r * Math.sin(a))] as const;
/** fatia de anel (ou pizza, com r0 = 0) de a0 a a1 (radianos, 0 = 3 horas, sentido horário) */
export function arco(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const g = a1 - a0 > Math.PI ? 1 : 0;
  const [x1, y1] = polar(cx, cy, r, a0); const [x2, y2] = polar(cx, cy, r, a1);
  if (r0 <= 0) return `M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${g} 1 ${x2} ${y2}Z`;
  const [x3, y3] = polar(cx, cy, r0, a1); const [x4, y4] = polar(cx, cy, r0, a0);
  return `M${x1} ${y1}A${r} ${r} 0 ${g} 1 ${x2} ${y2}L${x3} ${y3}A${r0} ${r0} 0 ${g} 0 ${x4} ${y4}Z`;
}

function pizza(b: BlocoDe<'pizza'>, o: OpcoesCena, f: Fmt): Cena {
  const total = b.fatias.reduce((a, x) => a + x.valor, 0) || 1;
  const pct = (v: number) => fmtValor((v / total) * 100, { formato: 'percentual', locale: f.locale });
  const rosca = b.rosca !== false;
  // ao lado da legenda quando cabe; compacto: só o anel (o resumo vai no "lado")
  const lado = o.largura >= 300 && !o.compacto;
  const D = Math.min(o.compacto ? 132 : 184, lado ? o.largura * 0.45 : o.largura);
  const legW = lado ? o.largura - D - 20 : o.largura;
  const legH = o.compacto ? 0 : b.fatias.length * 22;
  const W = Math.max(D, o.largura); const H = lado || o.compacto ? Math.max(D, legH) : D + 14 + legH;
  const cx = D / 2; const cy = lado || o.compacto ? H / 2 : D / 2; const R = D / 2 - 2; const R0 = rosca ? R * 0.62 : 0;
  const prims: Prim[] = [];
  let a = -Math.PI / 2;
  b.fatias.forEach((x, k) => {
    const a1 = a + (x.valor / total) * Math.PI * 2;
    if (x.valor > 0) prims.push({ t: 'path', d: arco(cx, cy, R, R0, a + (b.fatias.length > 1 ? 0.012 : 0), a1 - (b.fatias.length > 1 ? 0.012 : 0)), cor: SERIES[k % 6], anim: 'surge', i: k });
    a = a1;
  });
  if (rosca) {
    const maior = b.fatias.reduce((m, x) => (x.valor > m.valor ? x : m), b.fatias[0]);
    const cv = b.centro?.valor ?? pct(maior.valor); const cr = b.centro?.rotulo ?? (b.centro ? undefined : maior.rotulo);
    const tam = Math.max(14, Math.min(26, (R0 * 1.5) / Math.max(2, cv.length * 0.6)));
    prims.push({ t: 'text', x: cx, y: r1(cy + (cr ? 2 : tam / 3)), s: cv, tam: r1(tam), peso: 700, cor: 'tinta', ancora: 'middle' });
    if (cr) prims.push({ t: 'text', x: cx, y: r1(cy + 18), s: caber(cr, 11, R0 * 1.85), tam: 11, cor: 'suave', ancora: 'middle' });
  }
  if (!o.compacto) {
    const lx = lado ? D + 20 : 0; const ly = lado ? (H - legH) / 2 : D + 14;
    b.fatias.forEach((x, k) => {
      const yy = ly + k * 22 + 14;
      prims.push({ t: 'rect', x: lx, y: yy - 9, w: 10, h: 10, r: 3, cor: SERIES[k % 6] });
      const val = `${fv(x.valor, f, true)} · ${pct(x.valor)}`;
      const vw = medir(val, FONTE_TAM.rotulo, 600);
      prims.push({ t: 'text', x: lx + 16, y: yy, s: caber(x.rotulo, FONTE_TAM.rotulo, legW - vw - 30), tam: FONTE_TAM.rotulo, cor: 'tinta' });
      prims.push({ t: 'text', x: lx + legW, y: yy, s: val, tam: FONTE_TAM.rotulo, peso: 600, cor: 'tinta', ancora: 'end' });
    });
  }
  const alt = `${b.titulo ? `${b.titulo}. ` : ''}${b.fatias.map((x) => `${x.rotulo}: ${fv(x.valor, f)} (${pct(x.valor)})`).join('; ')}.`;
  return { w: o.compacto ? D : W, h: H, prims, alt, dados: { cab: ['', 'Valor', '%'], linhas: b.fatias.map((x) => [x.rotulo, fv(x.valor, f), pct(x.valor)]) } };
}

// ------------------------------------------------------------------------------------------- medidor / termômetro

const FAIXAS_PADRAO = (min: number, max: number): Array<{ ate: number; tom: 'ruim' | 'ok' | 'bom'; rotulo?: string }> => [
  { ate: min + (max - min) / 3, tom: 'ruim' }, { ate: min + ((max - min) * 2) / 3, tom: 'ok' }, { ate: max, tom: 'bom' },
];
const COR_FAIXA = { ruim: 'ruim', ok: 'atencao', bom: 'bom' } as const;

function medidor(b: BlocoDe<'medidor'>, o: OpcoesCena, f: Fmt): Cena {
  const min = b.min ?? 0; const max = b.max ?? 100;
  const W = Math.min(o.largura, o.compacto ? 180 : 260); const R = W / 2 - 6; const H = R + 44;
  const cx = W / 2; const cy = R + 6; const R0 = R * 0.74;
  const ang = (v: number) => Math.PI + ((v - min) / (max - min)) * Math.PI;
  const faixas = b.faixas ?? FAIXAS_PADRAO(min, max);
  const prims: Prim[] = [];
  let de = min;
  faixas.forEach((fx, k) => {
    prims.push({ t: 'path', d: arco(cx, cy, R, R0, ang(de) + (k ? 0.015 : 0), ang(fx.ate) - (k < faixas.length - 1 ? 0.015 : 0)), cor: COR_FAIXA[fx.tom], op: 0.9, anim: 'surge', i: k });
    de = fx.ate;
  });
  // o ponteiro: um triângulo fino do centro até o anel, e o pino
  const a = ang(b.valor); const [px, py] = polar(cx, cy, R0 - 4, a);
  const [l1x, l1y] = polar(cx, cy, 5, a + Math.PI / 2); const [l2x, l2y] = polar(cx, cy, 5, a - Math.PI / 2);
  prims.push({ t: 'path', d: `M${l1x} ${l1y}L${px} ${py}L${l2x} ${l2y}Z`, cor: 'tinta', anim: 'surge', i: faixas.length });
  prims.push({ t: 'circ', cx, cy, r: 7, cor: 'tinta' });
  prims.push({ t: 'circ', cx, cy, r: 3, cor: 'painel' });
  const valor = fmtValor(b.valor, { formato: b.formato, locale: f.locale });
  prims.push({ t: 'text', x: cx, y: H - 2, s: valor, tam: 20, peso: 700, cor: 'tinta', ancora: 'middle' });
  prims.push({ t: 'text', x: 4, y: cy + 16, s: fmtValor(min, { formato: b.formato, locale: f.locale, curto: true }), tam: 10, cor: 'suave' });
  prims.push({ t: 'text', x: W - 4, y: cy + 16, s: fmtValor(max, { formato: b.formato, locale: f.locale, curto: true }), tam: 10, cor: 'suave', ancora: 'end' });
  const faixa = faixas.find((x) => b.valor <= x.ate) ?? faixas.at(-1)!;
  return { w: W, h: H, prims, alt: `${b.rotulo ?? b.titulo ?? ''}: ${valor} (de ${fmtValor(min, { formato: b.formato, locale: f.locale })} a ${fmtValor(max, { formato: b.formato, locale: f.locale })}), faixa ${faixa.rotulo ?? faixa.tom}${b.tendencia ? `, tendência ${fmtVariacao(b.tendencia, f.locale)}` : ''}.`,
    dados: { cab: ['Faixa', 'Até'], linhas: faixas.map((x) => [x.rotulo ?? x.tom, fmtValor(x.ate, { formato: b.formato, locale: f.locale })]) } };
}

function termometro(b: BlocoDe<'medidor'>, o: OpcoesCena, f: Fmt): Cena {
  const min = b.min ?? 0; const max = b.max ?? 100; const faixas = b.faixas ?? FAIXAS_PADRAO(min, max);
  const H = o.compacto ? 150 : 200; const W = Math.min(o.largura, 150); const tx = 26; const tw = 18; const y0 = 8; const y1 = H - 30;
  const y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);
  const prims: Prim[] = [];
  prims.push({ t: 'rect', x: tx, y: y0, w: tw, h: y1 - y0 + 10, r: tw / 2, cor: 'trilho' });
  prims.push({ t: 'circ', cx: tx + tw / 2, cy: y1 + 12, r: 15, cor: 'trilho' });
  const faixa = faixas.find((x) => b.valor <= x.ate) ?? faixas.at(-1)!;
  const cor = COR_FAIXA[faixa.tom];
  prims.push({ t: 'rect', x: tx + 4, y: r1(y(b.valor)), w: tw - 8, h: r1(y1 - y(b.valor) + 10), r: (tw - 8) / 2, cor, anim: 'cresce-y' });
  prims.push({ t: 'circ', cx: tx + tw / 2, cy: y1 + 12, r: 11, cor });
  let de = min;
  for (const fx of faixas) {
    prims.push({ t: 'rect', x: tx + tw + 6, y: r1(y(fx.ate)), w: 4, h: r1(y(de) - y(fx.ate) - 1), r: 2, cor: COR_FAIXA[fx.tom], op: 0.85 });
    if (fx.rotulo) prims.push({ t: 'text', x: tx + tw + 14, y: r1((y(fx.ate) + y(de)) / 2 + 4), s: caber(fx.rotulo, 10, W - tx - tw - 16), tam: 10, cor: 'suave' });
    de = fx.ate;
  }
  const valor = fmtValor(b.valor, { formato: b.formato, locale: f.locale });
  prims.push({ t: 'text', x: tx + tw + 30, y: H - 10, s: valor, tam: 20, peso: 700, cor: 'tinta' });
  return { w: W, h: H, prims, alt: `${b.rotulo ?? b.titulo ?? ''}: ${valor}, faixa ${faixa.rotulo ?? faixa.tom}.` };
}

// ------------------------------------------------------------------------------------------- sparkline

export function sparkline(serie: number[], W: number, H: number, bom: 'alta' | 'baixa', alt: string, _f?: Fmt): Cena {
  const min = Math.min(...serie); const max = Math.max(...serie); const n = serie.length;
  const x = (i: number) => 2 + (i / Math.max(1, n - 1)) * (W - 8); const y = (v: number) => (max === min ? H / 2 : H - 4 - ((v - min) / (max - min)) * (H - 8));
  const d = serie.map((v, i) => `${i ? 'L' : 'M'}${r1(x(i))} ${r1(y(v))}`).join('');
  const tom = tomDaVariacao(serie[n - 1] - serie[0], bom);
  const cor: Cor = tom === 'bom' ? 'bom' : tom === 'ruim' ? 'ruim' : 'v1';
  const prims: Prim[] = [
    { t: 'path', d: `${d}L${r1(x(n - 1))} ${H}L${r1(x(0))} ${H}Z`, cor, op: 0.12, anim: 'surge' },
    { t: 'path', d, cor: null, traco: cor, larg: 2, redondo: true, anim: 'traca' },
    { t: 'circ', cx: r1(x(n - 1)), cy: r1(y(serie[n - 1])), r: 3.2, cor, traco: 'painel', larg: 1.5 },
  ];
  return { w: W, h: H, prims, alt };
}

// ------------------------------------------------------------------------------------------- ícones proporcionais

function icones(b: BlocoDe<'icones'>, o: OpcoesCena): Cena {
  const n = b.total; const tam = Math.max(22, Math.min(40, (o.largura - 4) / Math.min(n, 10) - 6));
  const porLinha = Math.max(1, Math.min(n, Math.floor((o.largura + 6) / (tam + 6))));
  const nl = Math.ceil(n / porLinha);
  const W = porLinha * (tam + 6) - 6; const H = nl * (tam + 6) - 6;
  const prims: Prim[] = [];
  for (let k = 0; k < n; k++) {
    const x = (k % porLinha) * (tam + 6); const y = Math.floor(k / porLinha) * (tam + 6);
    const cheio = Math.max(0, Math.min(1, b.valor - k));
    prims.push({ t: 'pict', nome: b.icone ?? 'pessoa', x, y, tam, cor: 'trilho', fundo: 'painel' });
    if (cheio > 0) prims.push({ t: 'pict', nome: b.icone ?? 'pessoa', x, y, tam, cor: 'v1', fundo: 'painel', corte: cheio < 1 ? cheio : undefined, anim: 'surge', i: k });
  }
  // o rótulo embaixo ("7 de 10 clientes renovariam"): o número em destaque
  const linhas = quebrar(b.rotulo, 14, Math.max(W, Math.min(o.largura, 420)), 2, 600);
  linhas.forEach((l, i) => prims.push({ t: 'text', x: 0, y: H + 24 + i * 19, s: l, tam: 14, peso: 600, cor: 'tinta' }));
  return { w: Math.max(W, ...linhas.map((l) => medir(l, 14, 600))), h: H + 12 + linhas.length * 19, prims, alt: b.rotulo };
}

// ------------------------------------------------------------------------------------------- funil

function funil(b: BlocoDe<'funil'>, o: OpcoesCena, f: Fmt): Cena {
  const W = Math.max(240, o.largura); const eh = 34; const H = b.etapas.length * (eh + 6);
  const max = Math.max(...b.etapas.map((e) => e.valor), 1e-9);
  const rotW = Math.min(W * 0.36, Math.max(...b.etapas.map((e) => medir(e.rotulo, FONTE_TAM.rotulo))) + 12);
  const pw = W - rotW - 66; const cx = rotW + pw / 2;
  const prims: Prim[] = [];
  b.etapas.forEach((e, i) => {
    const w = Math.max(10, (e.valor / max) * pw); const y = i * (eh + 6);
    prims.push({ t: 'rect', x: r1(cx - w / 2), y, w: r1(w), h: eh, r: 7, cor: SERIES[0], op: 1 - i * (0.5 / b.etapas.length), anim: 'cresce-x', i });
    prims.push({ t: 'text', x: 0, y: y + eh / 2 + 4, s: caber(e.rotulo, FONTE_TAM.rotulo, rotW - 10), tam: FONTE_TAM.rotulo, cor: 'tinta' });
    const v = fv(e.valor, f, true);
    if (medir(v, 12, 600) < w - 10) prims.push({ t: 'text', x: r1(cx), y: y + eh / 2 + 4, s: v, tam: 12, peso: 600, cor: 'sobre', ancora: 'middle', anim: 'surge', i });
    else prims.push({ t: 'text', x: r1(cx + w / 2 + 6), y: y + eh / 2 + 4, s: v, tam: 12, peso: 600, cor: 'tinta', anim: 'surge', i });
    if (i > 0) {
      const conv = fmtValor((e.valor / (b.etapas[i - 1].valor || 1)) * 100, { formato: 'percentual', locale: f.locale });
      prims.push({ t: 'text', x: W, y: y + eh / 2 + 4, s: `↓ ${conv}`, tam: 11, cor: 'suave', ancora: 'end' });
    }
  });
  return { w: W, h: H, prims, alt: `${b.titulo ? `${b.titulo}. ` : ''}${b.etapas.map((e) => `${e.rotulo}: ${fv(e.valor, f)}`).join(' → ')}.`,
    dados: { cab: ['Etapa', 'Valor', 'Conversão'], linhas: b.etapas.map((e, i) => [e.rotulo, fv(e.valor, f), i ? fmtValor((e.valor / (b.etapas[i - 1].valor || 1)) * 100, { formato: 'percentual', locale: f.locale }) : '']) } };
}

// ------------------------------------------------------------------------------------------- mapa de calor

function calor(b: BlocoDe<'calor'>, o: OpcoesCena, f: Fmt): Cena {
  const rotW = Math.max(...b.linhas.map((l) => medir(l, FONTE_TAM.eixo))) + 8;
  const nc = b.colunas.length;
  const cel = Math.max(10, Math.min(30, (o.largura - rotW) / nc - 2));
  const W = rotW + nc * (cel + 2); const H = b.linhas.length * (cel + 2) + 18;
  const vs = b.valores.flat(); const min = Math.min(...vs); const max = Math.max(...vs);
  const prims: Prim[] = [];
  b.linhas.forEach((l, i) => {
    prims.push({ t: 'text', x: 0, y: r1(i * (cel + 2) + cel / 2 + 4), s: l, tam: FONTE_TAM.eixo, cor: 'suave' });
    (b.valores[i] ?? []).forEach((v, j) => {
      const t = max === min ? 0.5 : (v - min) / (max - min);
      prims.push({ t: 'rect', x: r1(rotW + j * (cel + 2)), y: r1(i * (cel + 2)), w: r1(cel), h: r1(cel), r: 3, cor: t < 0.08 ? 'trilho' : 'v1', op: t < 0.08 ? 1 : r1(0.18 + t * 0.82), anim: 'surge', i: j });
    });
  });
  const passo = Math.max(1, Math.ceil(nc / Math.max(1, Math.floor((W - rotW) / 30))));
  b.colunas.forEach((c, j) => { if (j % passo === 0) prims.push({ t: 'text', x: r1(rotW + j * (cel + 2) + cel / 2), y: H - 2, s: c, tam: 10, cor: 'suave', ancora: 'middle' }); });
  let pico = { i: 0, j: 0, v: -Infinity };
  b.valores.forEach((l, i) => l.forEach((v, j) => { if (v > pico.v) pico = { i, j, v }; }));
  return { w: W, h: H, prims, alt: `${b.titulo ? `${b.titulo}. ` : ''}Pico em ${b.linhas[pico.i]} ${b.colunas[pico.j]}: ${fv(pico.v, f)}.`,
    dados: { cab: ['', ...b.colunas], linhas: b.linhas.map((l, i) => [l, ...(b.valores[i] ?? []).map((v) => fv(v, f))]) } };
}

// ------------------------------------------------------------------------------------------- matriz esforço × impacto

export const QUADRANTES_PADRAO: [string, string, string, string] = ['Ganhos rápidos', 'Grandes apostas', 'Tarefas de fundo', 'Evitar'];
function matriz(b: BlocoDe<'matriz'>, o: OpcoesCena): Cena {
  const W = Math.max(260, Math.min(o.largura, 520)); const H = Math.round(W * 0.72);
  const [ex, ey] = b.eixos ?? ['Esforço', 'Impacto'];
  const q = b.quadrantes ?? QUADRANTES_PADRAO;
  const x0 = 18; const y0 = 4; const x1 = W - 4; const y1 = H - 20; const mx = (x0 + x1) / 2; const my = (y0 + y1) / 2;
  const prims: Prim[] = [
    { t: 'rect', x: x0, y: y0, w: mx - x0 - 2, h: my - y0 - 2, r: 8, cor: 'bom', op: 0.1 },
    { t: 'rect', x: mx + 2, y: y0, w: x1 - mx - 2, h: my - y0 - 2, r: 8, cor: 'v2', op: 0.1 },
    { t: 'rect', x: x0, y: my + 2, w: mx - x0 - 2, h: y1 - my - 2, r: 8, cor: 'trilho', op: 0.7 },
    { t: 'rect', x: mx + 2, y: my + 2, w: x1 - mx - 2, h: y1 - my - 2, r: 8, cor: 'ruim', op: 0.08 },
    { t: 'text', x: x0 + 8, y: y0 + 16, s: q[0], tam: 11, peso: 600, cor: 'suave' },
    { t: 'text', x: x1 - 8, y: y0 + 16, s: q[1], tam: 11, peso: 600, cor: 'suave', ancora: 'end' },
    { t: 'text', x: x0 + 8, y: y1 - 8, s: q[2], tam: 11, peso: 600, cor: 'suave' },
    { t: 'text', x: x1 - 8, y: y1 - 8, s: q[3], tam: 11, peso: 600, cor: 'suave', ancora: 'end' },
    { t: 'text', x: mx, y: H - 4, s: `${ex} →`, tam: 11, cor: 'suave', ancora: 'middle' },
    { t: 'text', x: 12, y: my, s: '↑', tam: 12, cor: 'suave', ancora: 'middle' },
  ];
  b.itens.forEach((it, k) => {
    const px = x0 + 14 + (it.x / 10) * (x1 - x0 - 28); const py = y1 - 14 - (it.y / 10) * (y1 - y0 - 28);
    prims.push({ t: 'circ', cx: r1(px), cy: r1(py), r: 7, cor: SERIES[k % 6], traco: 'painel', larg: 2, anim: 'surge', i: k });
    const s = caber(it.rotulo, 11, 120); const w = medir(s, 11, 600);
    const esq = px + 12 + w > x1;
    prims.push({ t: 'text', x: r1(esq ? px - 11 : px + 11), y: r1(py + 4), s, tam: 11, peso: 600, cor: 'tinta', ancora: esq ? 'end' : 'start', anim: 'surge', i: k });
  });
  return { w: W, h: H, prims, alt: `${ey} × ${ex}: ${b.itens.map((it) => `${it.rotulo} (${ex.toLowerCase()} ${it.x}, ${ey.toLowerCase()} ${it.y})`).join('; ')}.`,
    dados: { cab: ['', ex, ey], linhas: b.itens.map((it) => [it.rotulo, String(it.x), String(it.y)]) } };
}

/** O anel de progresso (progresso com estilo "anel"): fração 0..1. */
export function anel(fracao: number, tam: number, cor: Cor = 'v1'): Cena {
  const R = tam / 2 - 2; const R0 = R - Math.max(6, tam * 0.12); const c = tam / 2;
  const fr = Math.max(0, Math.min(1, fracao));
  const prims: Prim[] = [{ t: 'path', d: arco(c, c, R, R0, 0, Math.PI * 2), cor: 'trilho' }];
  if (fr > 0) prims.push({ t: 'path', d: arco(c, c, R, R0, -Math.PI / 2, -Math.PI / 2 + fr * Math.PI * 2), cor, anim: 'surge' });
  return { w: tam, h: tam, prims, alt: '' };
}

/** Texto quebrado em linhas (para o cartão do PNG). */
export { quebrar, caber, medir };
