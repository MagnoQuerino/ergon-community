/**
 * O PDF de um documento entregue (rc.42), montado aqui no servidor com o PDFKit: o mesmo arquivo no computador da
 * pessoa (Docker ou o aplicativo), na nuvem e no celular, sem navegador por trás. Lê a árvore do Markdown
 * (shared/markdown.ts) e aplica a identidade e o modelo (shared/entregaveis.ts): margens, fonte, entrelinha, capa,
 * cabeçalho e rodapé em todas as páginas, número da página, títulos numerados, citação longa e referências ABNT.
 *
 * Fontes padrão do PDF (Helvetica para "sans", Times para "serif" — as mesmas medidas da Arial e da Times New Roman):
 * os acentos do português entram; o que está fora do WinAnsi é trocado por um equivalente (pdfSafe). Chinês e hindi
 * (rc.44): o pedaço com essas escritas vai na Noto Sans SC ou na Noto Sans Devanagari embutidas (lib/pdf-fontes.ts),
 * com a formação do devanágari feita pelo fontkit; a data e a numeração seguem o idioma pedido.
 */
import PDFDocument from 'pdfkit';
import { parseMarkdown, type Block, type Inline } from '../../../shared/markdown.ts';
import { corDeTitulo, ERGON_CORES, numeracao, preencher, REFERENCIAS, type Identidade, type ModeloDoc } from '../../../shared/entregaveis.ts';
import { CORE_R, EMBLEM_BOX, figures, palette } from '../../../shared/logo-ergon.ts';
import { escritaDe, fonteDa, metadado, textoDa, type Escrita } from './pdf-fontes.ts';
import { fmtData, msg, type Idioma } from './i18n.ts';
import { semAlfa } from './png-opaco.ts';

const CM = 28.3465;
type Doc = PDFKit.PDFDocument;

export interface EntradaPdf {
  markdown: string;
  titulo: string;
  identidade: Identidade;
  modelo: ModeloDoc;
  /** o logo do workspace (PNG ou JPEG conferido) */
  logo?: Buffer | null;
  /** imagem de Documentos citada no texto (só PNG/JPEG do próprio workspace) */
  imagem?: (id: string) => Buffer | null;
  /** o bloco visual ```ergon-<tipo> já em PNG (services/visuais/png.ts, pngsDasCercas); sem ele, o código */
  visual?: (lang: string, corpo: string) => Buffer[] | null;
  data?: string;
  /** o idioma da data e da numeração das páginas (rc.44); sem ele, o português */
  idioma?: Idioma | null;
}

const FONTES = {
  sans: { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', bi: 'Helvetica-BoldOblique' },
  serif: { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' },
} as const;

interface Seg { text: string; b: boolean; i: boolean; code: boolean; link?: string; e?: Escrita }

/**
 * A escrita do documento em montagem (documentoPdf é síncrono: uma por vez). Num documento em chinês ou hindi, o
 * pedaço latino ("18,5%", "₹12,34,567", "1.") também vai na Noto da escrita: a mesma linha de base e o ₹ não some.
 * Num documento em português, só o pedaço com chinês ou hindi muda de fonte.
 */
let escritaBase: Escrita = 'latina';
const efetiva = (t: string): Escrita => { const e = escritaDe(t); return e === 'latina' ? escritaBase : e; };

/** Inline → pedaços de texto com o estilo de cada um (o que o PDF escreve um atrás do outro). */
function segs(c: Inline[], b = false, i = false, link?: string): Seg[] {
  const out: Seg[] = [];
  for (const x of c) {
    switch (x.t) {
      case 'text': out.push({ text: x.v, b, i, code: false, link }); break;
      case 'br': out.push({ text: '\n', b, i, code: false }); break;
      case 'b': out.push(...segs(x.c, true, i, link)); break;
      case 'i': out.push(...segs(x.c, b, true, link)); break;
      case 's': out.push(...segs(x.c, b, i, link)); break;
      case 'code': out.push({ text: x.v, b, i, code: true, link }); break;
      case 'a': out.push(...segs(x.c, b, i, x.href)); break;
      case 'doc': out.push({ text: x.nome, b, i, code: false }); break;
      case 'img': break;
    }
  }
  // cada pedaço já com a escrita dele: latino pelo pdfSafe, chinês e hindi como vieram (lib/pdf-fontes.ts)
  return out.map((s) => { const e = efetiva(s.text); return { ...s, e, text: seguro(s.text, e) }; }).filter((s) => s.text);
}
/** O texto pronto para a fonte da escrita, linha a linha: a quebra de linha fica (pdfSafe tira os controles, e a quebra é um deles). */
const seguro = (t: string, e: Escrita = efetiva(t)) => t.split('\n').map((l) => textoDa(e, l.replace(/\t/g, '    '))).join('\n');
const plain = (c: Inline[]) => segs(c).map((s) => s.text).join('');

/** O emblema do Ergon em vetor (a mesma geometria da tela), com `h` pontos de altura. */
function emblema(doc: Doc, x: number, y: number, h: number): number {
  const s = h / EMBLEM_BOX.h;
  const p = palette();
  doc.save().translate(x, y).scale(s).translate(-EMBLEM_BOX.x, -EMBLEM_BOX.y);
  for (const f of figures()) {
    doc.path(f.arc).fill(p[f.tone]);
    doc.circle(f.head.cx, f.head.cy, f.head.r).fill(p[f.tone]);
  }
  doc.circle(0, 0, CORE_R).fill(p.gold);
  doc.restore();
  return EMBLEM_BOX.w * s;
}

export function documentoPdf(e: EntradaPdf): Buffer {
  escritaBase = escritaDe(`${e.titulo}\n${e.markdown}`);
  try { return montarPdf(e); } finally { escritaBase = 'latina'; }
}

function montarPdf(e: EntradaPdf): Buffer {
  const m = e.modelo;
  const F = FONTES[m.fonte];
  const id = e.identidade;
  const corTitulo = corDeTitulo(id.corPrimaria);
  const margens = { top: m.margens.topo * CM, right: m.margens.direita * CM, bottom: m.margens.base * CM, left: m.margens.esquerda * CM };
  const doc = new PDFDocument({ size: 'A4', margins: margens, bufferPages: true, autoFirstPage: true,
    info: { Title: metadado(e.titulo), Creator: 'Ergon', Author: metadado(id.nome || 'Ergon') } });
  /** Um texto inteiro numa fonte só, a da escrita dele (latino: a fonte padrão pedida); devolve o texto pronto. */
  const em = (t: string, padrao: string, negrito: boolean): string => { const es = efetiva(t); doc.font(fonteDa(doc, es, padrao, negrito)); return seguro(t, es); };
  const W = () => doc.page.width - margens.left - margens.right;
  const fundo = () => doc.page.height - margens.bottom;
  const size = m.tamanho;
  const gap = (sz: number, entre = m.entrelinha) => Math.max(0, sz * 1.15 * (entre - 1));
  const abnt = m.citacaoAbnt;
  const data = e.data ?? fmtData(e.idioma, new Date());
  const vars = { titulo: e.titulo, empresa: id.nome, data };

  // ---------------------------------------------------------------------------------------------- capa (opcional)
  const blocks = parseMarkdown(e.markdown);
  let corpo = blocks;
  if (m.capa.ligada) {
    const h1 = blocks.findIndex((b) => b.t === 'h' && b.level === 1);
    if (h1 === 0) corpo = blocks.slice(1); // o título vai na capa
    const cx = margens.left, w = W();
    let y = margens.top;
    if (e.logo) { try { doc.image(semAlfa(e.logo), cx + w / 2 - 60, y, { fit: [120, 60], align: 'center' }); y += 72; } catch { /* imagem que o PDF não lê: sem logo */ } }
    else if (id.mostrarErgon && m.base !== 'abnt') { emblema(doc, cx + w / 2 - 22, y, 44); y += 60; }
    doc.fillColor(ERGON_CORES.tinta).fontSize(size);
    if (m.capa.instituicao || id.nome) { doc.text(em((m.capa.instituicao || id.nome).toUpperCase(), F.b, true), cx, y, { width: w, align: 'center' }); y = doc.y + size; }
    if (m.capa.autor) doc.text(em(m.capa.autor.toUpperCase(), F.r, false), cx, y + size * 2, { width: w, align: 'center' });
    doc.fontSize(size + 4).fillColor(abnt ? ERGON_CORES.tinta : corTitulo);
    const tituloCapa = em(e.titulo.toUpperCase(), F.b, true);
    const tituloH = doc.heightOfString(tituloCapa, { width: w });
    doc.text(tituloCapa, cx, doc.page.height / 2 - tituloH, { width: w, align: 'center' });
    if (m.capa.subtitulo) { doc.fontSize(size + 1).fillColor(ERGON_CORES.tinta); doc.text(em(m.capa.subtitulo, F.r, false), cx, doc.y + 6, { width: w, align: 'center' }); }
    const fim = [m.capa.local, m.capa.ano || String(new Date().getFullYear())].filter(Boolean).map((x) => x.toUpperCase()).join('\n');
    doc.fontSize(size).fillColor(ERGON_CORES.tinta);
    const fimTexto = em(fim, F.b, true);
    doc.text(fimTexto, cx, fundo() - fimTexto.split('\n').length * size * 1.4, { width: w, align: 'center', lineBreak: true });
    doc.addPage();
  }
  const capas = m.capa.ligada ? 1 : 0;
  doc.x = margens.left; doc.y = margens.top;

  // ---------------------------------------------------------------------------------------------- corpo
  const ensure = (h: number) => { if (doc.y + h > fundo()) doc.addPage(); };
  const rich = (c: Inline[], o: { sz?: number; x?: number; w?: number; align?: 'left' | 'justify' | 'center'; indent?: number; entre?: number; cor?: string; bold?: boolean; italic?: boolean; after?: number } = {}) => {
    const todos = segs(c, !!o.bold, !!o.italic);
    // o espaço do começo de um pedaço vai para o fim do anterior: no justificado, o PDFKit perde o espaço inicial
    for (let k = 1; k < todos.length; k++) {
      const lead = todos[k].text.match(/^ +/)?.[0];
      if (lead && !todos[k - 1].text.endsWith('\n')) { todos[k].text = todos[k].text.slice(lead.length); todos[k - 1].text += ' '; }
    }
    // a quebra de linha sozinha num pedaço some no PDFKit: vai no começo do pedaço seguinte
    for (let k = 0; k < todos.length - 1; k++) if (todos[k].text === '\n') { todos[k + 1].text = `\n${todos[k + 1].text}`; todos[k].text = ''; }
    const list = todos.filter((s) => s.text);
    if (!list.length) return;
    const sz = o.sz ?? size;
    const x = o.x ?? margens.left;
    const lg = gap(sz, o.entre);
    ensure(sz * 1.3);
    list.forEach((s, k) => {
      const padrao = s.code ? 'Courier' : s.b && s.i ? F.bi : s.b ? F.b : s.i ? F.i : F.r;
      doc.font(fonteDa(doc, s.e ?? 'latina', padrao, s.b)).fontSize(s.code ? sz * 0.92 : sz).fillColor(s.link ? '#1F5B6B' : o.cor ?? ERGON_CORES.tinta);
      const opt = { width: o.w ?? W() - (x - margens.left), continued: k < list.length - 1, lineGap: lg, align: o.align ?? 'left', indent: k === 0 ? o.indent ?? 0 : 0, link: s.link ?? null, underline: !!s.link };
      if (k === 0) doc.text(s.text, x, doc.y, opt); else doc.text(s.text, opt);
    });
    doc.x = margens.left;
    doc.y += o.after ?? sz * 0.55;
  };

  const levels = corpo.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h').map((b) => b.level);
  const numeros = m.numerarTitulos ? numeracao(levels) : [];
  let hi = 0;
  let emReferencias = false;

  const heading = (b: Extract<Block, { t: 'h' }>) => {
    const texto = plain(b.c);
    const ref = REFERENCIAS.test(texto.trim());
    emReferencias = ref;
    const n = ref ? '' : numeros[hi] ?? '';
    hi++;
    const sz = b.level === 1 ? size + 7 : b.level === 2 ? size + 3 : b.level === 3 ? size + 1.5 : size;
    ensure(sz * 4); // título nunca sozinho no pé da página
    doc.y += b.level === 1 ? 0 : sz * 0.9;
    const caixa = abnt && (b.level <= 2 || ref);
    const label = `${n ? `${n} ` : ''}${caixa ? texto.toUpperCase() : texto}`;
    const italico = abnt && b.level >= 4;
    doc.fontSize(sz).fillColor(abnt ? ERGON_CORES.tinta : corTitulo)
      .text(em(label, italico ? F.i : F.b, !italico), margens.left, doc.y, { width: W(), align: abnt && (b.level === 1 || ref) ? 'center' : 'left', lineGap: gap(sz, 1.15) });
    if (b.level === 1 && !abnt) {
      const y = doc.y + 4;
      doc.save().moveTo(margens.left, y).lineTo(margens.left + 48, y).lineWidth(2).strokeColor(id.corDestaque).stroke().restore();
      doc.y = y + sz * 0.6;
    } else doc.y += sz * (abnt ? 0.8 : 0.45);
  };

  const list = (b: Extract<Block, { t: 'ul' | 'ol' }>, depth: number) => {
    const ind = margens.left + 14 + depth * 16;
    b.items.forEach((it, k) => {
      ensure(size * 1.4);
      const mark = b.t === 'ol' ? `${b.start + k}.` : depth % 2 ? '–' : '•';
      const y = doc.y;
      // o marcador na fonte do item (a mesma linha de base do texto, também em chinês e hindi)
      doc.font(fonteDa(doc, efetiva(plain(it)), F.r, false)).fontSize(size).fillColor(b.t === 'ul' ? id.corDestaque : ERGON_CORES.tinta).text(mark, ind - 14, y, { width: 14, lineBreak: false });
      doc.y = y;
      rich(it, { x: ind, align: m.justificar ? 'justify' : 'left', after: size * 0.25 });
      const sub = b.subs?.[k];
      if (sub) sub.forEach((x) => block(x, depth + 1));
    });
    doc.y += size * 0.35;
  };

  const quote = (b: Extract<Block, { t: 'quote' }>) => {
    const ps = b.c.filter((x): x is Extract<Block, { t: 'p' }> => x.t === 'p');
    if (abnt) {
      // NBR 10520: citação com mais de três linhas — recuo de 4 cm, letra menor, espaço simples
      for (const p of ps) rich(p.c, { x: margens.left + 4 * CM, sz: size - 2, entre: 1, align: 'justify', after: size * 0.8 });
      return;
    }
    const top = doc.y;
    const page = doc.page;
    for (const p of ps) rich(p.c, { x: margens.left + 14, sz: size, italic: true, cor: '#4a4a44', after: size * 0.3 });
    if (doc.page === page) doc.save().moveTo(margens.left + 3, top).lineTo(margens.left + 3, doc.y - size * 0.3).lineWidth(2.5).strokeColor(id.corDestaque).stroke().restore();
    doc.y += size * 0.5;
  };

  const code = (b: Extract<Block, { t: 'code' }>) => {
    // código com chinês ou hindi: a Noto (sem largura fixa, mas legível); o resto, a Courier de sempre
    const es = escritaDe(b.v); // o código só sai da Courier quando ele mesmo tem chinês ou hindi
    const mono = fonteDa(doc, es, 'Courier', false);
    const txt = seguro(b.v, es);
    doc.font(mono).fontSize(size * 0.82);
    for (const parte of txt.split('\n').reduce<string[][]>((acc, l) => { const cur = acc[acc.length - 1]; if (cur.length >= 40) acc.push([l]); else cur.push(l); return acc; }, [[]])) {
      const t = parte.join('\n') || ' ';
      const h = doc.heightOfString(t, { width: W() - 16 }) + 12;
      ensure(Math.min(h, fundo() - margens.top));
      const y = doc.y;
      doc.save().roundedRect(margens.left, y, W(), h, 4).fill(ERGON_CORES.fundoTabela).restore();
      doc.font(mono).fontSize(size * 0.82).fillColor('#2b2b2b').text(t, margens.left + 8, y + 6, { width: W() - 16 });
      doc.y = y + h + 2;
    }
    doc.x = margens.left; doc.y += size * 0.5;
  };

  const table = (b: Extract<Block, { t: 'table' }>) => {
    const cols = b.head.length;
    const sz = size - 1.5;
    // largura proporcional ao texto de cada coluna (com piso e teto): coluna de número não fica do tamanho da de descrição
    const peso = b.head.map((h, k) => Math.min(40, Math.max(6, ...[h, ...b.rows.map((r) => r[k] ?? [])].map((c) => plain(c).length))));
    const tot = peso.reduce((a, x) => a + x, 0);
    const ws = peso.map((p) => (p / tot) * W());
    const row = (cells: Inline[][], head: boolean) => {
      // cada célula na fonte da escrita dela (a altura da linha mede com a fonte certa)
      doc.fontSize(sz);
      const celulas = cells.map((c) => { const t = plain(c); const es = efetiva(t); return { t: seguro(t, es), f: fonteDa(doc, es, head ? F.b : F.r, head) }; });
      const h = Math.max(...celulas.map((c, k) => doc.font(c.f).heightOfString(c.t || ' ', { width: ws[k] - 10 }))) + 9;
      return { celulas, h };
    };
    const draw = (cells: Inline[][], head: boolean) => {
      const r = row(cells, head);
      if (doc.y + r.h > fundo()) { doc.addPage(); if (!head) draw(b.head, true); }
      const y = doc.y;
      if (head) doc.save().rect(margens.left, y, W(), r.h).fill(ERGON_CORES.fundoTabela).restore();
      let x = margens.left;
      r.celulas.forEach((c, k) => {
        doc.font(c.f).fontSize(sz).fillColor(head ? (abnt ? ERGON_CORES.tinta : corTitulo) : ERGON_CORES.tinta)
          .text(c.t, x + 5, y + 4.5, { width: ws[k] - 10, align: b.align[k] === 'right' ? 'right' : b.align[k] === 'center' ? 'center' : 'left' });
        x += ws[k];
      });
      doc.save().moveTo(margens.left, y + r.h).lineTo(margens.left + W(), y + r.h).lineWidth(head ? 1 : 0.5).strokeColor(head ? id.corDestaque : ERGON_CORES.linha).stroke().restore();
      doc.y = y + r.h;
    };
    ensure(size * 4);
    draw(b.head, true);
    for (const r of b.rows) draw(Array.from({ length: cols }, (_, k) => r[k] ?? []), false);
    doc.x = margens.left; doc.y += size * 0.9;
  };

  const png = (buf: Buffer, escala = 0.75): boolean => {
    try {
      const img = (doc as unknown as { openImage(b: Buffer): { width: number; height: number } }).openImage(buf);
      const w = Math.min(W(), img.width * escala);
      const h = Math.min((img.height / img.width) * w, fundo() - margens.top);
      ensure(h);
      doc.image(buf, margens.left + (W() - w) / 2, doc.y, { fit: [w, h] });
      doc.x = margens.left; doc.y += h + size * 0.6;
      return true;
    } catch { return false; /* formato que o PDF não abre */ }
  };

  const image = (c: Inline[]) => {
    for (const x of c) {
      if (x.t !== 'img') continue;
      const buf = e.imagem?.(x.id);
      if (!buf) continue;
      try {
        const img = (doc as unknown as { openImage(b: Buffer): { width: number; height: number } }).openImage(buf);
        const w = Math.min(W(), img.width * 0.75);
        const h = (img.height / img.width) * w;
        ensure(Math.min(h, fundo() - margens.top));
        doc.image(semAlfa(buf), margens.left + (W() - w) / 2, doc.y, { fit: [w, Math.min(h, fundo() - margens.top)] });
        doc.y += Math.min(h, fundo() - margens.top) + size * 0.6;
      } catch { /* formato que o PDF não abre: fica de fora */ }
    }
  };

  function block(b: Block, depth = 0): void {
    switch (b.t) {
      case 'h': heading(b); break;
      case 'p':
        image(b.c);
        if (b.c.every((x) => x.t === 'img' || (x.t === 'text' && !x.v.trim()))) break;
        if (emReferencias) rich(b.c, { entre: 1, align: 'left', after: size * 1.1 });
        else rich(b.c, { align: m.justificar ? 'justify' : 'left', indent: m.recuo ? 1.25 * CM : 0, after: size * (m.recuo ? 0.2 : 0.7) });
        break;
      case 'ul': case 'ol': list(b, depth); break;
      case 'quote': quote(b); break;
      case 'code': {
        // bloco visual: o cartão em PNG (2x: meia escala dá a nitidez da tela); sem ele, o código como sempre
        const vs = e.visual?.(b.lang, b.v);
        if (!vs?.length || !vs.map((v) => png(v, 0.5)).some(Boolean)) code(b);
        break;
      }
      case 'table': table(b); break;
      case 'hr': { ensure(size * 2); const y = doc.y + size * 0.4; doc.save().moveTo(margens.left, y).lineTo(margens.left + W(), y).lineWidth(0.5).strokeColor(ERGON_CORES.linha).stroke().restore(); doc.y = y + size * 0.8; break; }
    }
  }
  for (const b of corpo) block(b);

  // ---------------------------------------------------------------------------------------------- cabeçalho, rodapé e número em cada página
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = range.start; i < range.start + total; i++) {
    if (i < capas) continue;
    doc.switchToPage(i);
    const salva = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 }; // escrever na margem sem abrir página nova
    const pagina = i + 1;
    const wTotal = doc.page.width - margens.left - margens.right;
    if (m.cabecalho.mostrar) {
      const y = Math.max(18, margens.top - 40);
      let x = margens.left;
      const alto = 18;
      if (m.cabecalho.logo && e.logo) { try { doc.image(semAlfa(e.logo), x, y, { fit: [90, alto] }); x += 98; } catch { /* sem logo */ } }
      else if (m.cabecalho.logo && id.mostrarErgon) x += emblema(doc, x, y, alto) + 8;
      const texto = preencher(m.cabecalho.texto, vars);
      if (texto) { doc.fontSize(8.5).fillColor(corTitulo); doc.text(em(texto, F.b, true), x, y + alto / 2 - 4.5, { width: wTotal - (x - margens.left), lineBreak: false, ellipsis: true }); }
      doc.save().moveTo(margens.left, y + alto + 6).lineTo(margens.left + wTotal, y + alto + 6).lineWidth(0.6).strokeColor(id.corDestaque).stroke().restore();
    }
    const yRod = doc.page.height - margens.bottom + Math.min(26, margens.bottom / 2);
    if (m.rodape.mostrar) {
      const texto = preencher(m.rodape.texto, vars);
      if (texto) { doc.fontSize(8).fillColor(ERGON_CORES.suave); doc.text(em(texto, F.r, false), margens.left, yRod, { width: wTotal * 0.7, lineBreak: false, ellipsis: true }); }
    }
    if (m.paginacao !== 'nenhuma' && pagina >= m.numeroDesde) {
      // ABNT: só o número, no alto à direita, a 2 cm da borda; os outros: "3 / 12" no rodapé à direita
      if (m.paginacao === 'topo') doc.font(F.r).fontSize(10).fillColor(ERGON_CORES.tinta).text(String(pagina), margens.left, 2 * CM - 10, { width: wTotal, align: 'right', lineBreak: false });
      else { doc.fontSize(8).fillColor(ERGON_CORES.suave); doc.text(em(msg(e.idioma, 'pdf.pagina', { pagina, total }), F.r, false), margens.left, yRod, { width: wTotal, align: 'right', lineBreak: false }); }
    }
    doc.page.margins = salva;
  }
  doc.flushPages();
  doc.end();
  const chunks: Buffer[] = [];
  for (let c = doc.read() as Buffer | null; c !== null; c = doc.read() as Buffer | null) chunks.push(c);
  return Buffer.concat(chunks);
}
