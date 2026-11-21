/**
 * O bloco visual como imagem: um cartão SVG completo (título, o visual, as fontes no rodapé e a marca discreta), bonito
 * sozinho para compartilhar fora do Ergon. A tela o converte em PNG 2x no navegador ("Baixar PNG", no tema da tela); o
 * servidor, com a mesma função, gera o PNG que vai ao Telegram e ao Discord. Só SVG: sem HTML, sem script.
 */
import type { Bloco, Fonte } from './esquema.ts';
import { anel, cenaDe, FONTE_TAM, GRAFICOS, sparkline, type Cena, type Cor, type Prim } from './cena.ts';
import { fmtDataIso, fmtValor, fmtVariacao, tomDaVariacao, type Locale } from './formato.ts';
import { caber, medir, quebrar } from './larguras.ts';
import { DESENHOS } from './pictogramas.ts';
import { lockupLayout, logoSvg } from '../logo-ergon.ts';
import type { Paleta } from './paleta.ts';
import { visualComoTexto } from './texto.ts';

export const FONTE_SVG = "Inter, 'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A marca no canto: `ergon` = a marca oficial do Ergon; senão o nome do cliente (Entregáveis › identidade); `null` tira. */
export interface Marca { texto: string; ergon: boolean }
export interface OpcoesCartao { paleta: Paleta; largura?: number; locale?: Locale; marca?: Marca | null; votos?: number[][] }

let seq = 0;
/** As primitivas da cena em SVG, com as cores da paleta. */
export function primsSvg(prims: Prim[], p: Paleta, dx = 0, dy = 0): string {
  const c = (x: Cor | null | undefined) => (x ? p[x] : 'none');
  const op = (o?: number) => (o !== undefined && o < 1 ? ` opacity="${o}"` : '');
  const out: string[] = [`<g transform="translate(${r1(dx)} ${r1(dy)})">`];
  for (const x of prims) {
    switch (x.t) {
      case 'rect': out.push(`<rect x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}"${x.r ? ` rx="${x.r}"` : ''} fill="${c(x.cor)}"${op(x.op)}/>`); break;
      case 'circ': out.push(`<circle cx="${x.cx}" cy="${x.cy}" r="${x.r}" fill="${c(x.cor)}"${x.traco ? ` stroke="${c(x.traco)}" stroke-width="${x.larg ?? 1}"` : ''}${op(x.op)}/>`); break;
      case 'path': out.push(`<path d="${x.d}" fill="${c(x.cor ?? null)}"${x.traco ? ` stroke="${c(x.traco)}" stroke-width="${x.larg ?? 1}"${x.redondo ? ' stroke-linecap="round" stroke-linejoin="round"' : ''}${x.tracejado ? ' stroke-dasharray="4 4"' : ''}` : ''}${op(x.op)}/>`); break;
      case 'text': out.push(`<text x="${x.x}" y="${x.y}" font-size="${x.tam}" font-weight="${x.peso ?? 400}" fill="${c(x.cor)}"${x.ancora && x.ancora !== 'start' ? ` text-anchor="${x.ancora}"` : ''}${op(x.op)}>${esc(x.s)}</text>`); break;
      case 'pict': {
        const d = DESENHOS[x.nome]; const k = x.tam / 24; const id = `c${++seq}`;
        const clip = x.corte !== undefined ? `<clipPath id="${id}"><rect x="0" y="0" width="${r1(24 * x.corte)}" height="24"/></clipPath>` : '';
        out.push(`<g transform="translate(${x.x} ${x.y}) scale(${r1(k * 1000) / 1000})"${op(x.op)}>${clip}<g${clip ? ` clip-path="url(#${id})"` : ''}><path d="${d.cheio}" fill="${c(x.cor)}"/>${d.recorte ? `<path d="${d.recorte}" fill="${c(x.fundo)}"/>` : ''}</g></g>`);
        break;
      }
    }
  }
  out.push('</g>');
  return out.join('');
}

// ------------------------------------------------------------------------------------------- corpo dos blocos de texto

type Corpo = { h: number; prims: Prim[] };
const T = (x: number, y: number, s: string, tam: number, cor: Cor, peso: 400 | 600 | 700 = 400, ancora?: 'start' | 'middle' | 'end'): Prim => ({ t: 'text', x, y, s, tam, cor, peso, ancora });
const corDoTom = (t: 'bom' | 'ruim' | 'neutro'): Cor => (t === 'bom' ? 'bom' : t === 'ruim' ? 'ruim' : 'suave');

function linhasDeTexto(linhas: string[], W: number): Corpo {
  const prims: Prim[] = []; let y = 0;
  for (const l of linhas) {
    const limpa = l.replace(/\*\*|_/g, '');
    for (const q of quebrar(limpa, 14, W, 3)) { y += 21; prims.push(T(0, y, q, 14, 'tinta')); }
  }
  return { h: y + 6, prims };
}

function corpoKpi(k: { rotulo: string; valor: number; formato?: string; moeda?: string; unidade?: string; variacao?: number; comparacao?: string; bom?: 'alta' | 'baixa'; meta?: number; serie?: number[] }, W: number, l: Locale): Corpo {
  const fo = { formato: k.formato as never, moeda: k.moeda as never, locale: l };
  const prims: Prim[] = [T(0, 14, caber(k.rotulo.toUpperCase(), 11, W), 11, 'suave', 600)];
  const valor = fmtValor(k.valor, { ...fo, unidade: k.unidade });
  const tam = Math.min(32, Math.max(18, (W * 0.9) / Math.max(4, valor.length * 0.62)));
  prims.push(T(0, 22 + tam, caber(valor, tam, W, 700), r1(tam), 'tinta', 700));
  let y = 22 + tam + 20;
  if (k.variacao !== undefined) {
    const tom = tomDaVariacao(k.variacao, k.bom);
    prims.push(T(0, y, `${k.variacao > 0 ? '▲' : k.variacao < 0 ? '▼' : '•'} ${fmtVariacao(k.variacao, l)}${k.comparacao ? ` ${k.comparacao}` : ''}`, 12, corDoTom(tom), 600));
    y += 18;
  }
  if (k.meta !== undefined) {
    const fr = Math.max(0, Math.min(1, k.valor / (k.meta || 1)));
    prims.push({ t: 'rect', x: 0, y: y - 4, w: W, h: 6, r: 3, cor: 'trilho' }, { t: 'rect', x: 0, y: y - 4, w: r1(Math.max(3, W * fr)), h: 6, r: 3, cor: fr >= 1 ? 'bom' : 'v1' });
    prims.push(T(0, y + 16, `meta ${fmtValor(k.meta, fo)} · ${fmtValor(fr * 100, { formato: 'percentual', locale: l })}`, 11, 'suave'));
    y += 24;
  }
  if (k.serie && k.serie.length > 1) {
    const s = sparkline(k.serie, W, 34, k.bom ?? 'alta', '');
    prims.push(...s.prims.map((p) => desloca(p, 0, y)));
    y += 40;
  }
  return { h: y, prims };
}

function desloca(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'rect': case 'text': case 'pict': return { ...p, x: r1(p.x + dx), y: r1(p.y + dy) };
    case 'circ': return { ...p, cx: r1(p.cx + dx), cy: r1(p.cy + dy) };
    case 'path': return dx || dy ? { ...p, d: p.d.replace(/([MLHVAZ])([^MLHVAZ]*)/gi, (m, cmd: string, args: string) => {
      const ns = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      const U = cmd.toUpperCase();
      if (U === 'H') return `H${r1(ns[0] + dx)}`;
      if (U === 'V') return `V${r1(ns[0] + dy)}`;
      if (U === 'A') return `A${ns[0]} ${ns[1]} ${ns[2]} ${ns[3]} ${ns[4]} ${r1(ns[5] + dx)} ${r1(ns[6] + dy)}`;
      if (U === 'Z') return 'Z';
      return `${U}${ns.map((n, i) => r1(n + (i % 2 ? dy : dx))).join(' ')}`;
    }) } : p;
  }
}
const juntar = (alvo: Prim[], c: { prims: Prim[] }, dx: number, dy: number) => { for (const p of c.prims) alvo.push(desloca(p, dx, dy)); };

function corpoDe(b: Bloco, W: number, l: Locale, votos?: number[][]): Corpo {
  if (GRAFICOS.has(b.tipo)) {
    const cena = cenaDe(b, { largura: W, locale: l }) as Cena;
    return { h: cena.h, prims: cena.prims };
  }
  const prims: Prim[] = [];
  switch (b.tipo) {
    case 'kpi': return corpoKpi(b, W, l);
    case 'kpis': {
      const n = b.itens.length; const cols = Math.min(n, W < 460 ? 2 : 4); const cw = (W - (cols - 1) * 16) / cols;
      let h = 0; let linhaH = 0; let topoLinha = 0;
      b.itens.forEach((k, i) => {
        const c = corpoKpi(k, cw - 24, l);
        if (i % cols === 0) { topoLinha = h ? h + 16 : 0; linhaH = 0; }
        const x = (i % cols) * (cw + 16); const y = topoLinha;
        prims.push({ t: 'rect', x, y, w: r1(cw), h: c.h + 24, r: 12, cor: 'painel2' });
        juntar(prims, c, x + 12, y + 12);
        linhaH = Math.max(linhaH, c.h + 24);
        h = Math.max(h, y + c.h + 24);
      });
      return { h, prims };
    }
    case 'nota': {
      if (b.rotulo) prims.push(T(0, 14, b.rotulo.toUpperCase(), 11, 'suave', 600));
      const v = `${fmtValor(b.valor, { locale: l })}/${fmtValor(b.escala ?? 10, { locale: l })}`;
      const y = b.rotulo ? 64 : 46;
      prims.push(T(0, y, v, 44, 'tinta', 700));
      if (b.legenda) prims.push(T(medir(v, 44, 700) + 12, y - 4, caber(b.legenda, 14, W - medir(v, 44, 700) - 12), 14, 'suave'));
      return { h: y + 10, prims };
    }
    case 'versus': {
      const f = { formato: b.formato, moeda: b.moeda, locale: l };
      const meio = W / 2; const tot = Math.abs(b.a.valor) + Math.abs(b.b.valor) || 1;
      [[b.a, 0, 'a'], [b.b, meio, 'b']].forEach(([x, dx, k]) => {
        const lado = x as typeof b.a; const px = dx as number;
        prims.push(T(px, 14, caber(lado.rotulo, 13, meio - 12), 13, 'suave'));
        prims.push(T(px, 52, fmtValor(lado.valor, f), 30, b.melhor === k ? 'bom' : 'tinta', 700));
        if (lado.legenda) prims.push(T(px, 80, caber(lado.legenda, 12, meio - 12), 12, 'suave'));
      });
      const wa = r1((Math.abs(b.a.valor) / tot) * W);
      prims.push({ t: 'rect', x: 0, y: 92, w: Math.max(4, wa - 2), h: 10, r: 5, cor: b.melhor === 'a' ? 'bom' : 'v1' }, { t: 'rect', x: wa + 2, y: 92, w: Math.max(4, W - wa - 2), h: 10, r: 5, cor: b.melhor === 'b' ? 'bom' : 'v2' });
      if (b.pontas) prims.push(T(0, 122, b.pontas[0], 12, 'suave'), T(W, 122, b.pontas[1], 12, 'suave', 400, 'end'));
      return { h: b.pontas ? 128 : 106, prims };
    }
    case 'placar': {
      const e = b.escala ?? 10;
      b.itens.forEach((x, i) => {
        const y = i * 42;
        prims.push(T(0, y + 16, caber(x.rotulo, 14, W - 70), 14, 'tinta', 600), T(W, y + 16, `${fmtValor(x.nota, { locale: l })}/${fmtValor(e, { locale: l })}`, 14, 'tinta', 600, 'end'));
        prims.push({ t: 'rect', x: 0, y: y + 24, w: W, h: 7, r: 3.5, cor: 'trilho' }, { t: 'rect', x: 0, y: y + 24, w: r1(Math.max(4, (x.nota / e) * W)), h: 7, r: 3.5, cor: 'v1' });
      });
      return { h: b.itens.length * 42, prims };
    }
    case 'progresso': {
      if (b.estilo === 'anel') {
        const n = b.itens.length; const tam = Math.min(110, (W - (n - 1) * 16) / n);
        b.itens.forEach((x, i) => {
          const fr = x.atual / x.meta; const a = anel(fr, tam, fr >= 1 ? 'bom' : 'v1'); const px = i * (tam + 16);
          juntar(prims, a, px, 0);
          prims.push(T(px + tam / 2, tam / 2 + 6, fmtValor(fr * 100, { formato: 'percentual', locale: l }), 16, 'tinta', 700, 'middle'));
          prims.push(T(px + tam / 2, tam + 18, caber(x.rotulo, 12, tam + 12), 12, 'suave', 400, 'middle'));
        });
        return { h: tam + 24, prims };
      }
      b.itens.forEach((x, i) => {
        const y = i * 46; const fr = x.atual / x.meta; const fo = { formato: x.formato, moeda: x.moeda, locale: l };
        prims.push(T(0, y + 16, caber(x.rotulo, 14, W * 0.55), 14, 'tinta', 600));
        prims.push(T(W, y + 16, `${fmtValor(x.atual, fo)} de ${fmtValor(x.meta, fo)}${x.prazo ? ` · ${fmtDataIso(x.prazo, l, true)}` : ''}`, 12, 'suave', 400, 'end'));
        prims.push({ t: 'rect', x: 0, y: y + 24, w: W, h: 10, r: 5, cor: 'trilho' }, { t: 'rect', x: 0, y: y + 24, w: r1(Math.max(5, Math.min(1, fr) * W)), h: 10, r: 5, cor: fr >= 1 ? 'bom' : 'v1' });
      });
      return { h: b.itens.length * 46, prims };
    }
    case 'tabela': {
      const cols = b.colunas;
      const fmt = (x: string | number | null, j: number) => (typeof x === 'number' || cols[j].formato === 'data' ? fmtValor(x, { formato: cols[j].formato, moeda: cols[j].moeda, locale: l }) : x ?? '—');
      const linhas = b.linhas.slice(0, 14).map((r) => r.map((x, j) => fmt(x, j)));
      let tot: string[] | null = null;
      if (Array.isArray(b.totais)) tot = b.totais.map((x, j) => fmt(x, j));
      else if (b.totais) tot = cols.map((c, j) => (j === 0 ? 'Total' : b.linhas.every((r) => typeof r[j] === 'number' || r[j] === null) && c.formato !== 'data' ? fmt(b.linhas.reduce((a, r) => a + (Number(r[j]) || 0), 0), j) : ''));
      const larg = cols.map((c, j) => Math.max(medir(c.titulo, 12, 600), ...[...linhas, ...(tot ? [tot] : [])].map((r) => medir(r[j] ?? '', 13))) + 18);
      const k = Math.min(1, W / larg.reduce((a, x) => a + x, 0));
      const xs: number[] = []; let acc = 0; for (const w of larg) { xs.push(acc); acc += w * k; }
      const dir = (j: number) => cols[j].alinhar === 'direita' || (cols[j].alinhar !== 'esquerda' && b.linhas.some((r) => typeof r[j] === 'number'));
      const cel = (s: string, j: number, y: number, cor: Cor, peso: 400 | 600 | 700) => T(dir(j) ? r1(xs[j] + larg[j] * k - 9) : xs[j], y, caber(s, 13, larg[j] * k - 12, peso), 13, cor, peso, dir(j) ? 'end' : 'start');
      cols.forEach((c, j) => prims.push(cel(c.titulo, j, 16, 'suave', 600)));
      prims.push({ t: 'path', d: `M0 26H${W}`, traco: 'linha', larg: 1 });
      linhas.forEach((r, i) => {
        const y = 26 + (i + 1) * 30;
        r.forEach((s, j) => {
          const d = b.destaques?.find((x) => x.linha === i && x.coluna === j);
          if (d) prims.push({ t: 'rect', x: xs[j] + 2, y: y - 20, w: r1(larg[j] * k - 4), h: 26, r: 6, cor: d.tom === 'bom' ? 'bom' : d.tom === 'ruim' ? 'ruim' : d.tom === 'atencao' ? 'atencao' : 'v1', op: 0.16 });
          prims.push(cel(s, j, y - 2, 'tinta', b.negrito?.includes(j) ? 600 : 400));
        });
        prims.push({ t: 'path', d: `M0 ${y + 8}H${W}`, traco: 'linha', larg: 1, op: 0.6 });
      });
      let h = 26 + linhas.length * 30 + 10;
      if (tot) { tot.forEach((s, j) => prims.push(cel(s, j, h + 18, 'tinta', 700))); h += 28; }
      if (b.linhas.length > 14) { prims.push(T(0, h + 16, `+ ${b.linhas.length - 14} linhas no Ergon`, 12, 'suave')); h += 24; }
      return { h, prims };
    }
    case 'comparativo': {
      const n = b.opcoes.length; const cw = (W - (n - 1) * 14) / n; let h = 0;
      b.opcoes.forEach((x, i) => {
        const px = i * (cw + 14); const c: Prim[] = []; let y = 22;
        c.push(T(14, y, caber(x.nome, 15, cw - 28, 700), 15, 'tinta', 700));
        if (x.recomendada) { y += 18; c.push(T(14, y, '★ recomendada', 11, 'bom', 600)); }
        if (x.subtitulo) { y += 18; c.push(T(14, y, caber(x.subtitulo, 12, cw - 28), 12, 'suave')); }
        if (x.valor !== undefined) { y += 32; c.push(T(14, y, fmtValor(x.valor, { formato: b.formato, moeda: b.moeda, locale: l }), 24, x.recomendada ? 'bom' : 'tinta', 700)); }
        for (const p of x.pros ?? []) for (const [k, q] of quebrar(`+ ${p}`, 12, cw - 28, 2).entries()) { y += k ? 16 : 20; c.push(T(14, y, q, 12, 'bom')); }
        for (const p of x.contras ?? []) for (const [k, q] of quebrar(`− ${p}`, 12, cw - 28, 2).entries()) { y += k ? 16 : 20; c.push(T(14, y, q, 12, 'ruim')); }
        prims.push({ t: 'rect', x: px, y: 0, w: r1(cw), h: 0, r: 12, cor: x.recomendada ? 'bom' : 'painel2', op: x.recomendada ? 0.1 : 1 });
        for (const p of c) prims.push(desloca(p, px, 0));
        h = Math.max(h, y + 16);
      });
      for (const p of prims) if (p.t === 'rect' && p.h === 0) p.h = h;
      return { h, prims };
    }
    case 'linha_do_tempo': {
      const cor: Record<string, Cor> = { feito: 'bom', em_dia: 'v1', atrasado: 'ruim', risco: 'atencao', previsto: 'trilho' };
      b.marcos.forEach((m, i) => {
        const y = i * 40;
        if (i < b.marcos.length - 1) prims.push({ t: 'rect', x: 6, y: y + 12, w: 2, h: 36, r: 1, cor: 'linha' });
        prims.push({ t: 'circ', cx: 7, cy: y + 10, r: 6, cor: cor[m.estado ?? 'previsto'], traco: 'painel', larg: 2 });
        prims.push(T(22, y + 14, fmtDataIso(m.data, l, true), 12, 'suave', 600), T(80, y + 14, caber(m.titulo, 14, W - 80, 600), 14, 'tinta', 600));
        if (m.detalhe) prims.push(T(80, y + 31, caber(m.detalhe, 12, W - 80), 12, 'suave'));
      });
      return { h: b.marcos.length * 40, prims };
    }
    case 'checklist': case 'status': case 'semaforo': {
      const cor = (x: { estado?: string; cor?: string }): Cor => ({ feito: 'bom', andamento: 'v1', pendente: 'trilho', bloqueado: 'ruim', ok: 'bom', atencao: 'atencao', erro: 'ruim', parado: 'trilho', verde: 'bom', amarelo: 'atencao', vermelho: 'ruim' } as Record<string, Cor>)[x.estado ?? x.cor ?? ''] ?? 'trilho';
      b.itens.forEach((x, i) => {
        const y = i * 30; const it = x as { texto?: string; rotulo?: string; detalhe?: string; estado?: string; cor?: string };
        prims.push({ t: 'circ', cx: 8, cy: y + 10, r: 7, cor: cor(it) });
        if (it.estado === 'feito') prims.push({ t: 'path', d: `M4.5 ${y + 10}L7 ${y + 12.5}L11.5 ${y + 7.5}`, cor: null, traco: 'sobre', larg: 1.8, redondo: true });
        const s = it.texto ?? it.rotulo ?? '';
        prims.push(T(24, y + 15, caber(s, 14, W * 0.6, 600), 14, it.estado === 'feito' ? 'suave' : 'tinta', 600));
        if (it.detalhe) prims.push(T(W, y + 15, caber(it.detalhe, 12, W * 0.38), 12, 'suave', 400, 'end'));
      });
      return { h: b.itens.length * 30, prims };
    }
    case 'aviso': {
      const cor: Cor = ({ info: 'v6', dica: 'v1', alerta: 'atencao', risco: 'ruim', sucesso: 'bom' } as const)[b.tom];
      const ls = b.texto.split('\n').flatMap((p) => quebrar(p, 14, W - 32, 6));
      prims.push({ t: 'rect', x: 0, y: 0, w: W, h: ls.length * 21 + 20, r: 12, cor, op: 0.12 }, { t: 'rect', x: 0, y: 0, w: 4, h: ls.length * 21 + 20, r: 2, cor });
      ls.forEach((q, i) => prims.push(T(18, 26 + i * 21, q, 14, 'tinta')));
      return { h: ls.length * 21 + 20, prims };
    }
    case 'decisao': {
      prims.push({ t: 'rect', x: 0, y: 0, w: W, h: 64, r: 14, cor: 'bom', op: 0.12 }, { t: 'circ', cx: 30, cy: 32, r: 14, cor: 'bom' },
        { t: 'path', d: 'M23.5 32L28 36.5L37 27', cor: null, traco: 'sobre', larg: 2.6, redondo: true },
        T(56, 28, caber(`Decisão: ${b.escolha}`, 17, W - 70, 700), 17, 'tinta', 700));
      if (b.votos !== undefined) prims.push(T(56, 48, `${b.votos}${b.total ? ` de ${b.total}` : ''} votos`, 12, 'suave', 600));
      let y = 64;
      if (b.porque) for (const q of quebrar(b.porque, 13, W, 3)) { y += 20; prims.push(T(0, y, q, 13, 'tinta')); }
      for (const p of b.proximos ?? []) { y += 20; prims.push(T(0, y, caber(`→ ${p}`, 13, W), 13, 'suave')); }
      return { h: y + 6, prims };
    }
    case 'enquete': {
      const porOpcao = votos ?? b.opcoes.map((_, i) => (b.votos ?? []).filter((v) => v.opcao === i).map(() => 1));
      const tot = porOpcao.reduce((a, x) => a + x.length, 0) || 1;
      prims.push(T(0, 18, caber(b.pergunta, 16, W, 700), 16, 'tinta', 700));
      b.opcoes.forEach((x, i) => {
        const y = 34 + i * 40; const n = porOpcao[i]?.length ?? 0; const ganha = b.decisao === i;
        prims.push(T(0, y + 14, caber(x, 13, W - 90, 600), 13, 'tinta', 600), T(W, y + 14, `${n} · ${fmtValor((n / tot) * 100, { formato: 'percentual', locale: l })}`, 12, 'suave', 600, 'end'));
        prims.push({ t: 'rect', x: 0, y: y + 21, w: W, h: 8, r: 4, cor: 'trilho' }, { t: 'rect', x: 0, y: y + 21, w: r1(Math.max(4, (n / tot) * W)), h: 8, r: 4, cor: ganha ? 'bom' : 'v1' });
      });
      return { h: 34 + b.opcoes.length * 40, prims };
    }
    case 'ficha': {
      const cab = b.cabecalho ?? ['Parâmetro', 'Valor'];
      prims.push(T(0, 14, cab[0], 12, 'tinta', 600), T(W * 0.42, 14, cab[1], 12, 'tinta', 600), { t: 'path', d: `M0 24H${W}`, traco: 'linha', larg: 1 });
      b.linhas.forEach((x, i) => {
        const y = 24 + (i + 1) * 32;
        prims.push(T(0, y - 10, caber(x.parametro, 13, W * 0.4), 13, 'tinta'), T(W * 0.42, y - 10, caber(x.valor, 13, W * 0.58, x.destaque ? 700 : 400), 13, 'tinta', x.destaque ? 700 : 400));
        prims.push({ t: 'path', d: `M0 ${y}H${W}`, traco: 'linha', larg: 1, op: 0.6 });
      });
      return { h: 24 + b.linhas.length * 32 + 4, prims };
    }
    case 'relatorio': {
      let h = 0;
      if (b.resumo) { const c = linhasDeTexto([b.resumo], W); juntar(prims, c, 0, 0); h = c.h; }
      for (const d of b.destaques ?? []) { const c = corpoDe(d, W, l); juntar(prims, c, 0, h + 10); h += c.h + 18; }
      const c = linhasDeTexto(b.secoes.map((s) => `• ${s.titulo}`), W); juntar(prims, c, 0, h); h += c.h;
      return { h, prims };
    }
    default: {
      const c = linhasDeTexto(visualComoTexto({ ...b, titulo: undefined, subtitulo: undefined, nota: undefined, fontes: undefined, estimativa: undefined } as Bloco, { locale: l }).split('\n').filter(Boolean), W);
      return c;
    }
  }
}

/**
 * A marca do Ergon no canto: a oficial, em vetor (shared/logo-ergon.ts, a mesma da tela, dos ícones e dos PDFs) — o
 * emblema e o logotipo ERGON, na versão clara ou escura. Nada redesenhado: o SVG é o de logoSvg, só posicionado.
 */
export const marcaErgonSvg = (escuro: boolean): string => logoSvg({ kind: 'horizontal', onDark: escuro });
const MARCA_ALTURA = 16;
function marcaPosicionada(escuro: boolean, xDireita: number, y: number): { svg: string; w: number } {
  const L = lockupLayout('horizontal');
  const w = (L.w / L.h) * MARCA_ALTURA;
  const svg = marcaErgonSvg(escuro).replace(/^<svg /, `<svg x="${r1(xDireita - w)}" y="${r1(y)}" width="${r1(w)}" height="${MARCA_ALTURA}" `);
  return { svg, w };
}
/** o painel é escuro? (a marca vai na versão para fundo escuro) */
const ehEscuro = (hex: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim()); if (!m) return false; const n = parseInt(m[1], 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128; };

function rodapeFontes(fs: Fonte[] | undefined, estimativa: boolean | undefined, W: number): string {
  const partes = (fs ?? []).map((f) => `${f.titulo}${f.periodo ? ` · ${f.periodo}` : ''}`);
  if (estimativa) partes.unshift('Estimativa');
  if (!partes.length) return '';
  let s = `Fonte${partes.length > 1 ? 's' : ''}: ${partes[0]}`;
  for (let i = 1; i < partes.length; i++) {
    const resto = partes.length - i;
    if (medir(`${s} · ${partes[i]}  +${resto - 1}`, 11) > W) return `${caber(s, 11, W - 30)}  +${resto}`;
    s += ` · ${partes[i]}`;
  }
  return caber(s, 11, W);
}

/** O cartão inteiro em SVG: devolve o texto e o tamanho (em px "1x"; o PNG sai em 2x). */
export function cartaoSvg(b: Bloco, o: OpcoesCartao): { svg: string; w: number; h: number } {
  const p = o.paleta; const W = o.largura ?? 720; const pad = 28; const iw = W - pad * 2; const l = o.locale ?? 'pt-BR';
  const topo: Prim[] = []; let y = pad;
  if (b.titulo) { for (const q of quebrar(b.titulo, 20, iw, 2, 700)) { y += 24; topo.push(T(0, y - pad, q, 20, 'tinta', 700)); } y += 4; }
  if (b.subtitulo) { for (const q of quebrar(b.subtitulo, 13, iw, 2)) { y += 18; topo.push(T(0, y - pad, q, 13, 'suave')); } }
  if (b.titulo || b.subtitulo) y += 16;
  const corpo = corpoDe(b, iw, l, o.votos);
  const yCorpo = y; y += corpo.h;
  // o resumo ao lado (mini visual): embaixo no PNG, como uma linha forte
  const extra: Prim[] = [];
  if (b.lado && (b.lado.numero || b.lado.linhas?.length)) {
    y += 14;
    if (b.lado.numero) { y += 30; extra.push(T(0, y, b.lado.numero, 28, 'tinta', 700)); if (b.lado.rotulo) extra.push(T(medir(b.lado.numero, 28, 700) + 10, y - 4, caber(b.lado.rotulo, 13, iw - 120), 13, 'suave')); }
    for (const q of b.lado.linhas ?? []) { y += 20; extra.push(T(0, y, caber(`• ${q}`, 13, iw), 13, 'tinta')); }
  }
  if (b.nota) { for (const q of quebrar(b.nota, 12, iw, 3)) { y += 18; extra.push(T(0, y, q, 12, 'suave')); } }
  y += 22;
  const fontes = rodapeFontes(b.tipo === 'fontes' ? b.itens : b.fontes, b.estimativa, iw - 110);
  const pe: Prim[] = [];
  pe.push({ t: 'path', d: `M0 ${y - 8}H${iw}`, traco: 'linha', larg: 1 });
  if (fontes) pe.push(T(0, y + 12, fontes, 11, 'suave'));
  const marca = o.marca === undefined ? { texto: 'Ergon', ergon: true } : o.marca;
  let marcaSvg = '';
  let reservado = 0;
  if (marca?.ergon) { const m = marcaPosicionada(ehEscuro(p.painel), pad + iw, y); marcaSvg = m.svg; reservado = m.w; }
  else if (marca) { pe.push(T(iw, y + 12, marca.texto, 11, 'suave', 600, 'end')); reservado = medir(marca.texto, 11, 600); }
  if (fontes && medir(fontes, 11) > iw - reservado - 16) {
    const ult = pe[pe.length - (marca && !marca.ergon ? 2 : 1)];
    if (ult && ult.t === 'text' && ult.s === fontes) ult.s = caber(fontes, 11, iw - reservado - 16);
  }
  const H = Math.ceil(y + 20 + pad - 6);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(FONTE_SVG)}">`,
    `<rect width="${W}" height="${H}" rx="18" fill="${p.painel}"/>`,
    primsSvg(topo, p, pad, pad), primsSvg(corpo.prims, p, pad, yCorpo), primsSvg(extra, p, pad, 0), primsSvg(pe, p, pad, 0), marcaSvg,
    '</svg>',
  ].join('');
  return { svg, w: W, h: H };
}

export { FONTE_TAM };
