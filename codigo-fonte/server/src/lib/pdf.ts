/**
 * PDF a partir do Markdown simples que os colegas escrevem: títulos (#), listas (-, 1.), negrito (**), parágrafos e
 * tabelas (| a | b |). Usa o PDFKit (MIT), com as fontes padrão do PDF (Helvetica): os acentos do português entram;
 * o que a fonte não tem (emoji, setas) é trocado por um equivalente ou sai. Chinês e hindi (rc.44): o pedaço com essas
 * escritas vai na Noto embutida (lib/pdf-fontes.ts) em vez de sumir. Síncrono: o PDFKit grava no buffer do fluxo a
 * cada página, e o texto é lido de lá no fim.
 */
import PDFDocument from 'pdfkit';
import { escritaDe, fonteDa, metadado, textoDa, type Escrita } from './pdf-fontes.ts';

/** Caracteres fora do WinAnsi (o que a Helvetica padrão tem) → equivalente, ou fora. */
const TROCA: Record<string, string> = { '₹': 'Rs ', '→': '->', '←': '<-', '⇒': '=>', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '≥': '>=', '≤': '<=', '≠': '!=', '−': '-', '★': '*', '▪': '•', '■': '•', '●': '•', '◦': '-' };
const WINANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
export function pdfSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9) out += '    ';
    else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255) || WINANSI_EXTRA.has(ch)) out += ch;
    else if (TROCA[ch]) out += TROCA[ch];
  }
  return out;
}

type Seg = { text: string; bold: boolean; italic: boolean; e?: Escrita };
function segments(line: string, ef: (t: string) => Escrita = escritaDe): Seg[] {
  const out: Seg[] = []; let at = 0;
  for (const m of line.matchAll(/\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`/g)) {
    if (m.index! > at) out.push({ text: line.slice(at, m.index), bold: false, italic: false });
    out.push({ text: m[1] ?? m[2] ?? m[3], bold: m[1] !== undefined, italic: m[2] !== undefined });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ text: line.slice(at), bold: false, italic: false });
  return out.map((s) => { const e = ef(s.text); return { ...s, e, text: textoDa(e, s.text) }; }).filter((s) => s.text);
}

const font = (b: boolean, i: boolean) => (b && i ? 'Helvetica-BoldOblique' : b ? 'Helvetica-Bold' : i ? 'Helvetica-Oblique' : 'Helvetica');

export function markdownToPdf(md: string, title: string): Buffer {
  // num texto em chinês ou hindi, o pedaço latino também vai na Noto (a mesma linha de base; o ₹ não some)
  const base = escritaDe(`${title}\n${md}`);
  const ef = (t: string): Escrita => { const e = escritaDe(t); return e === 'latina' ? base : e; };
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: metadado(title), Creator: 'Ergon' }, bufferPages: false });
  const left = doc.page.margins.left;
  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rich = (line: string, opts: { size?: number; bold?: boolean; indent?: number; gap?: number } = {}) => {
    const segs = segments(line, ef);
    if (!segs.length) return;
    doc.fontSize(opts.size ?? 11);
    const x = left + (opts.indent ?? 0);
    segs.forEach((s, i) => {
      doc.font(fonteDa(doc, s.e ?? 'latina', font(opts.bold || s.bold, s.italic), !!(opts.bold || s.bold)));
      const o = { width: width() - (opts.indent ?? 0), continued: i < segs.length - 1, lineGap: 2 };
      if (i === 0) doc.text(s.text, x, doc.y, o); else doc.text(s.text, o);
    });
    doc.moveDown(opts.gap ?? 0.35);
  };
  const table = (rows: string[][]) => {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const w = width() / cols;
    doc.fontSize(9.5);
    rows.forEach((r, ri) => {
      const cells = Array.from({ length: cols }, (_, c) => { const t = (r[c] ?? '').replace(/\*\*/g, ''); const e = ef(t); return { t: textoDa(e, t), f: fonteDa(doc, e, ri === 0 ? 'Helvetica-Bold' : 'Helvetica', ri === 0) }; });
      const h = Math.max(...cells.map((c) => doc.font(c.f).heightOfString(c.t || ' ', { width: w - 8 }))) + 8;
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      if (ri === 0) doc.save().rect(left, y, width(), h).fill('#E8EEF7').restore();
      cells.forEach((cel, c) => { doc.font(cel.f).fillColor('#111111').text(cel.t, left + c * w + 4, y + 4, { width: w - 8 }); });
      doc.save().strokeColor('#C8CED8').lineWidth(0.5).rect(left, y, width(), h).stroke().restore();
      doc.y = y + h;
    });
    doc.x = left; doc.moveDown(0.6);
  };

  // título no topo, salvo quando o texto já começa com um
  if (!/^\s*#\s/.test(md)) rich(`**${title}**`, { size: 18, gap: 0.8 });
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let tbl: string[][] = [];
  const flush = () => { if (tbl.length) table(tbl); tbl = []; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) tbl.push(cells);
      continue;
    }
    flush();
    if (!line.trim()) { doc.moveDown(0.3); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { doc.moveDown(0.5); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { doc.moveDown(0.4); rich(h[2], { size: h[1].length === 1 ? 16 : h[1].length === 2 ? 14 : 12, bold: true, gap: 0.4 }); continue; }
    const ul = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (ul) { rich(`•  ${ul[2]}`, { indent: 12 + Math.min(3, Math.floor(ul[1].length / 2)) * 12, gap: 0.2 }); continue; }
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) { rich(`${ol[2]}.  ${ol[3]}`, { indent: 12 + Math.min(3, Math.floor(ol[1].length / 2)) * 12, gap: 0.2 }); continue; }
    rich(line);
  }
  flush();
  doc.end();
  const chunks: Buffer[] = [];
  for (let c = doc.read() as Buffer | null; c !== null; c = doc.read() as Buffer | null) chunks.push(c);
  return Buffer.concat(chunks);
}
