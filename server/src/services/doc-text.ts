/**
 * Texto dos documentos que as rotinas leem, por código e sem dependências: Word (.docx), Excel (.xlsx), PowerPoint
 * (.pptx), PDF com texto, CSV, texto e Markdown, XML (NF-e), OFX (extrato) e legendas (.vtt/.srt). O que não dá para
 * ler é dito com o motivo (PDF digitalizado, protegido, formato antigo) — nunca vira um texto vazio fingindo leitura.
 * Conteúdo de documento é dado de terceiros: aqui só se extrai texto; nada é interpretado ou executado.
 */
import zlib from 'node:zlib';
import { readZip, ZipError } from '../lib/zip.ts';
import { CsvError, parseCsv } from './csv.ts';

export type DocKind = 'texto' | 'planilha' | 'apresentacao' | 'pdf' | 'xml' | 'ofx' | 'imagem' | 'outro';
export type DocStatus = 'ok' | 'sem_texto' | 'nao_suportado' | 'erro';
export interface Sheet { name: string; rows: string[][] }
export interface DocText {
  name: string; kind: DocKind; status: DocStatus; detail?: string;
  /** texto corrido (parágrafos em linhas) */
  text: string;
  /** planilhas: as abas com as linhas (a primeira é o cabeçalho) */
  sheets?: Sheet[];
  /** PDF e apresentação: páginas ou slides */
  pages?: number;
  /** conteúdo bruto (XML da NF-e, OFX) para leitores estruturados */
  raw?: string;
}

const MAX_ROWS = 5000; const MAX_COLS = 60;
/** PDF: teto do que todos os fluxos de um arquivo descompactam juntos (um PDF de texto real fica muito abaixo) */
const PDF_INFLATE_TOTAL = 120 * 1024 * 1024; const PDF_INFLATE_STREAM = 30 * 1024 * 1024;
/** tabela de fontes (ToUnicode): o espaço de códigos tem no máximo 65.536 posições por fonte */
const CMAP_MAX = 70_000;
export class DocLimitError extends Error {}
const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? '';

/** Entidades XML (&amp; &#225; &#xE1;). */
export function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
  });
}

/** Texto legível: sem caracteres de controle, espaços normalizados, linhas vazias em excesso fora. */
const tidy = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  const s = data.toString('utf8');
  // não é UTF-8 válido (planilhas antigas do Windows): latin1
  return s.includes('�') ? data.toString('latin1') : s.replace(/^﻿/, '');
}

export function extractDoc(name: string, mime: string, data: Buffer): DocText {
  const e = ext(name);
  const base = (kind: DocKind, status: DocStatus, text = '', more: Partial<DocText> = {}): DocText => ({ name, kind, status, text, ...more });
  try {
    if (e === 'docx' || mime.includes('wordprocessingml')) return docx(name, data);
    if (e === 'xlsx' || mime.includes('spreadsheetml')) return xlsx(name, data);
    if (e === 'pptx' || mime.includes('presentationml')) return pptx(name, data);
    if (e === 'pdf' || mime === 'application/pdf') return pdf(name, data);
    if (['doc', 'xls', 'ppt'].includes(e)) return base('outro', 'nao_suportado', '', { detail: `formato antigo do Office (.${e}): salve como .${e}x e envie de novo` });
    if (mime.startsWith('image/')) return base('imagem', 'nao_suportado', '', { detail: 'imagem: o Ergon ainda não lê texto de imagens (envie o PDF original ou o texto)' });
    const text = decodeText(data);
    if (e === 'csv' || mime === 'text/csv') {
      try {
        const t = parseCsv(text, { maxBytes: 20 * 1024 * 1024, maxRows: MAX_ROWS, maxCols: MAX_COLS * 4, maxCell: 4000 });
        const rows = [t.headers, ...t.rows].map((r) => r.slice(0, MAX_COLS));
        return base('planilha', rows.length > 1 ? 'ok' : 'sem_texto', text.slice(0, 200_000), { sheets: [{ name: name.replace(/\.csv$/i, ''), rows }] });
      } catch (err) { return base('planilha', 'erro', '', { detail: err instanceof CsvError ? err.message : 'CSV ilegível' }); }
    }
    if (e === 'ofx' || /<OFX>/i.test(text.slice(0, 4000))) return base('ofx', 'ok', '', { raw: text });
    if (e === 'xml' || mime.includes('xml')) {
      const plain = tidy(xmlText(text.replace(/<\?[^>]*\?>/g, '').replace(/<\/[^>]+>/g, '\n').replace(/<[^>]+>/g, ' ')));
      return base('xml', plain ? 'ok' : 'sem_texto', plain, { raw: text });
    }
    if (e === 'vtt' || e === 'srt') {
      // legenda/transcrição: tira os carimbos de tempo e a numeração, fica a fala
      const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l));
      return base('texto', lines.length ? 'ok' : 'sem_texto', tidy(lines.join('\n')));
    }
    if (mime.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(e) || mime === 'application/json') {
      const t = tidy(text);
      return base('texto', t ? 'ok' : 'sem_texto', t);
    }
    return base('outro', 'nao_suportado', '', { detail: `tipo não suportado (${e || mime})` });
  } catch (err) {
    return base('outro', 'erro', '', { detail: err instanceof ZipError ? `arquivo corrompido ou não é ${e}: ${err.message}` : err instanceof DocLimitError ? err.message : err instanceof Error ? err.message.slice(0, 160) : 'erro ao ler' });
  }
}

// --- Office (ZIP + XML) ---------------------------------------------------------------------------------------

function docx(name: string, data: Buffer): DocText {
  const z = readZip(data);
  const doc = z.get('word/document.xml');
  if (!doc) return { name, kind: 'texto', status: 'erro', text: '', detail: 'Word sem o documento principal' };
  const text = tidy(officeText(doc.read().toString('utf8'), 'w'));
  return { name, kind: 'texto', status: text ? 'ok' : 'sem_texto', text };
}

/** Texto de XML do Office: parágrafos em linhas, células separadas por " | ", tabulação e quebra de linha. */
function officeText(xml: string, ns: 'w' | 'a'): string {
  let out = '';
  const re = ns === 'w'
    ? /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>|<\/w:tc>|<\/w:tr>|<w:delText[^>]*>[^<]*<\/w:delText>/g
    : /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\/>|<\/a:p>|<\/a:tc>|<\/a:tr>/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[0];
    if (m[1] !== undefined) out += xmlText(m[1]);
    else if (tag.includes('delText')) continue; // texto apagado (controle de alterações) não conta
    else if (tag.endsWith('tab/>')) out += '\t';
    else if (tag.endsWith('br/>') || tag.endsWith(':p>') || tag.endsWith(':tr>')) out += '\n';
    else if (tag.endsWith(':tc>')) out += ' | ';
  }
  return out;
}

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
/** número de série do Excel (sistema 1900) → AAAA-MM-DD */
const serialDate = (v: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86_400_000)).toISOString().slice(0, 10);
const DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function xlsx(name: string, data: Buffer): DocText {
  const z = readZip(data);
  const read = (p: string) => z.get(p)?.read().toString('utf8') ?? '';
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')));
  // estilos: quais formatos são de data (os padrão e os personalizados com d/m/a)
  const styles = read('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), xmlText(m[2])]));
  const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '').matchAll(/<xf\b[^>]*numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const isDate = (s: number) => { const f = xfs[s]; if (f === undefined) return false; if (DATE_FMT.has(f)) return true; const c = custom.get(f); return !!c && /[dy]/i.test(c.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%]+$/.test(c); };
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2].replace(/^\/?xl\//, '')]));
  const sheets: Sheet[] = [];
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = rels.get(m[2]); if (!target) continue;
    const xml = read(`xl/${target.replace(/^\.\//, '')}`); if (!xml) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (rows.length >= MAX_ROWS) break;
      const row: string[] = [];
      for (const c of (r[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1]; const ref = at.match(/\br="([A-Z]+\d+)"/)?.[1]; const t = at.match(/\bt="(\w+)"/)?.[1]; const s = Number(at.match(/\bs="(\d+)"/)?.[1] ?? -1);
        const idx = ref ? colIndex(ref) : row.length; if (idx >= MAX_COLS) continue;
        const v = c[2]?.match(/<v>([^<]*)<\/v>/)?.[1];
        let val = '';
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = xmlText([...(c[2] ?? '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
        else if (t === 'b') val = v === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (v !== undefined) { const n = Number(v); val = t !== 'str' && t !== 'e' && Number.isFinite(n) && isDate(s) ? serialDate(n) : xmlText(v); }
        while (row.length < idx) row.push('');
        row[idx] = val.trim();
      }
      if (row.some(Boolean)) rows.push(row);
    }
    const width = Math.max(0, ...rows.map((r) => r.length));
    sheets.push({ name: xmlText(m[1]), rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]) });
  }
  const has = sheets.some((s) => s.rows.length > 1);
  return { name, kind: 'planilha', status: has ? 'ok' : 'sem_texto', text: '', sheets, ...(has ? {} : { detail: 'planilha sem linhas de dados' }) };
}

function pptx(name: string, data: Buffer): DocText {
  const z = readZip(data);
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  const parts = slides.map((k, i) => `[Slide ${i + 1}]\n${tidy(officeText(z.get(k)!.read().toString('utf8'), 'a'))}`);
  const text = parts.join('\n\n');
  return { name, kind: 'apresentacao', status: slides.length ? 'ok' : 'sem_texto', text, pages: slides.length };
}

// --- PDF (texto das páginas, com as tabelas ToUnicode das fontes) -------------------------------------------------

interface PdfObj { dict: string; stream: Buffer | null }

function pdf(name: string, data: Buffer): DocText {
  const src = data.toString('latin1');
  if (!src.startsWith('%PDF')) return { name, kind: 'pdf', status: 'erro', text: '', detail: 'não é um PDF' };
  if (/\/Encrypt\s/.test(src)) return { name, kind: 'pdf', status: 'erro', text: '', detail: 'PDF protegido por senha: envie uma versão sem proteção' };
  const objs = pdfObjects(data, src, { left: PDF_INFLATE_TOTAL });
  const pages = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page\b/.test(o.dict)).map(([n]) => n).sort((a, b) => a - b);
  const order = pageOrder(objs) ?? pages;
  const fonts = new Map<number, Map<string, string> & { bytes?: number }>();
  const out: string[] = [];
  for (const p of order) {
    const page = objs.get(p); if (!page) continue;
    const fontRefs = pageFonts(objs, p);
    const cmaps = new Map<string, { map: Map<string, string>; bytes: number } | null>();
    for (const [fname, ref] of fontRefs) {
      if (!fonts.has(ref)) {
        const f = objs.get(ref);
        const tu = f?.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
        const cm = tu ? objs.get(Number(tu[1]))?.stream : null;
        const parsed = cm ? parseCMap(cm.toString('latin1')) : null;
        const m = new Map<string, string>() as Map<string, string> & { bytes?: number };
        if (parsed) { for (const [k, v] of parsed.map) m.set(k, v); m.bytes = parsed.bytes; } else m.bytes = /\/Identity-H|\/Type0/.test(f?.dict ?? '') ? 2 : 1;
        fonts.set(ref, m);
      }
      const m = fonts.get(ref)!;
      cmaps.set(fname, m.size ? { map: m, bytes: m.bytes ?? 1 } : m.bytes === 2 ? { map: m, bytes: 2 } : null);
    }
    const contents = refsOf(page.dict, 'Contents');
    const stream = Buffer.concat(contents.map((r) => { const o = objs.get(r); if (!o) return Buffer.alloc(0); if (o.stream) return o.stream; return Buffer.concat(refsOf(`/C ${o.dict}`, 'C').map((x) => objs.get(x)?.stream ?? Buffer.alloc(0))); }));
    out.push(contentText(stream.toString('latin1'), cmaps));
  }
  const text = tidy(out.map((t, i) => `[Página ${i + 1}]\n${t}`).join('\n\n'));
  const letters = text.replace(/\[Página \d+\]/g, '').replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length;
  if (letters < 20) return { name, kind: 'pdf', status: 'sem_texto', text: '', pages: order.length, detail: 'PDF sem texto (digitalizado ou só imagem): envie o original ou o texto' };
  return { name, kind: 'pdf', status: 'ok', text, pages: order.length };
}

/** Objetos do PDF (inclusive os guardados em fluxos de objetos), com os fluxos já descompactados. */
function pdfObjects(data: Buffer, src: string, budget: { left: number }): Map<number, PdfObj> {
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g; let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const num = Number(m[1]); const start = m.index + m[0].length;
    const end = src.indexOf('endobj', start); if (end < 0) break;
    const body = src.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    let dict = body; let stream: Buffer | null = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      const s0 = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let s1 = lenM ? s0 + Number(lenM[1]) : -1;
      if (s1 < s0 || s1 > end + start) s1 = src.lastIndexOf('endstream', end);
      stream = decodeStream(dict, data.subarray(s0, Math.max(s0, s1)), budget);
    }
    objs.set(num, { dict, stream });
    re.lastIndex = end;
  }
  // fluxos de objetos (PDF 1.5+): os dicionários das fontes e páginas costumam estar aqui dentro
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1] ?? 0); const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    const s = o.stream.toString('latin1'); const head = s.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && i * 2 + 1 < head.length; i++) {
      const num = head[i * 2]; const off = first + head[i * 2 + 1]; const next = i + 1 < n ? first + head[i * 2 + 3] : s.length;
      if (!objs.has(num)) objs.set(num, { dict: s.slice(off, next), stream: null });
    }
  }
  return objs;
}

function decodeStream(dict: string, raw: Buffer, budget: { left: number }): Buffer | null {
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) return null; // imagem
  if (!/\/FlateDecode/.test(dict)) return /\/Filter/.test(dict) ? null : raw;
  if (budget.left <= 0) throw new DocLimitError('o PDF descompacta para mais de 120 MB (arquivo malformado ou feito para travar a leitura)');
  const max = Math.min(PDF_INFLATE_STREAM, budget.left);
  const take = (b: Buffer) => { budget.left -= b.length; return b; };
  const big = (e: unknown) => (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
  try { return take(zlib.inflateSync(raw, { maxOutputLength: max })); } catch (e) {
    if (big(e)) { budget.left -= max; return null; } // fluxo enorme: fica de fora e conta no teto
    try { return take(zlib.inflateRawSync(raw.subarray(2), { maxOutputLength: max })); } catch (e2) { if (big(e2)) budget.left -= max; return null; }
  }
}

const refsOf = (dict: string, key: string): number[] => {
  const m = dict.match(new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R)`));
  return m ? [...m[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1])) : [];
};

/** Ordem das páginas pela árvore /Pages /Kids (a ordem dos objetos no arquivo nem sempre é a da leitura). */
function pageOrder(objs: Map<number, PdfObj>): number[] | null {
  const cat = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const root = cat ? refsOf(cat.dict, 'Pages')[0] : undefined;
  if (!root) return null;
  const out: number[] = []; const seen = new Set<number>();
  const walk = (n: number) => {
    if (seen.has(n) || out.length > 2000) return; seen.add(n);
    const o = objs.get(n); if (!o) return;
    if (/\/Type\s*\/Page\b/.test(o.dict)) { out.push(n); return; }
    for (const k of refsOf(o.dict, 'Kids')) walk(k);
  };
  walk(root);
  return out.length ? out : null;
}

/** Fontes da página (/Resources da página ou herdados de /Pages acima). */
function pageFonts(objs: Map<number, PdfObj>, page: number): Map<string, number> {
  let n: number | undefined = page; const seen = new Set<number>();
  while (n !== undefined && !seen.has(n)) {
    seen.add(n);
    const o = objs.get(n); if (!o) break;
    let res = o.dict.match(/\/Resources\s*(\d+)\s+\d+\s+R/) ? objs.get(Number(o.dict.match(/\/Resources\s*(\d+)\s+\d+\s+R/)![1]))?.dict ?? '' : o.dict;
    const fr = res.match(/\/Font\s*(\d+)\s+\d+\s+R/);
    if (fr) res = `/Font ${objs.get(Number(fr[1]))?.dict ?? ''}`;
    const fm = res.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fm) return new Map([...fm[1].matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)].map((x) => [x[1], Number(x[2])]));
    n = refsOf(o.dict, 'Parent')[0];
  }
  return new Map();
}

/** Tabela ToUnicode: código (hex) → texto. */
function parseCMap(s: string): { map: Map<string, string>; bytes: number } {
  const map = new Map<string, string>();
  const hexStr = (h: string) => { let out = ''; for (let i = 0; i + 3 < h.length + 1; i += 4) { const c = parseInt(h.slice(i, i + 4), 16); if (Number.isFinite(c)) out += String.fromCharCode(c); } return out; };
  const span = s.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  const bytes = span ? Math.max(1, span[1].length / 2) : 2;
  for (const b of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { if (map.size >= CMAP_MAX) break; map.set(m[1].toLowerCase(), hexStr(m[2])); }
  for (const b of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16); const hi = parseInt(m[2], 16); const w = m[1].length;
      if (hi - lo > 5000 || map.size >= CMAP_MAX) continue;
      if (m[3].startsWith('[')) { [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, i) => map.set((lo + i).toString(16).padStart(w, '0'), hexStr(x[1]))); continue; }
      const base = m[3].slice(1, -1); const head = base.slice(0, -4); const last = parseInt(base.slice(-4) || '0', 16);
      for (let c = lo; c <= hi; c++) map.set(c.toString(16).padStart(w, '0'), hexStr(head) + String.fromCharCode(last + (c - lo)));
    }
  }
  return { map, bytes };
}

/** Texto de um fluxo de conteúdo: strings dos operadores Tj, TJ, ' e ", com as quebras de linha das posições. */
function contentText(s: string, cmaps: Map<string, { map: Map<string, string>; bytes: number } | null>): string {
  let out = ''; let font: { map: Map<string, string>; bytes: number } | null = null; let lastY: number | null = null;
  const nums: string[] = [];
  const decode = (bytes: number[]) => {
    if (font && font.map.size) {
      let r = '';
      for (let i = 0; i + font.bytes - 1 < bytes.length; i += font.bytes) {
        const k = bytes.slice(i, i + font.bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        r += font.map.get(k) ?? '';
      }
      return r;
    }
    if (font && font.bytes === 2) return ''; // fonte composta sem tabela: o texto não é recuperável
    return bytes.map((b) => WIN[b] ?? String.fromCharCode(b)).join('');
  };
  let i = 0; const n = s.length;
  let pending: string[] = [];
  while (i < n) {
    const ch = s[i];
    if (ch === '(') { // string literal
      const bytes: number[] = []; let depth = 1; i++;
      while (i < n && depth > 0) {
        const c = s[i];
        if (c === '\\') {
          const d = s[i + 1];
          if (/[0-7]/.test(d)) { let o = ''; let j = i + 1; while (j < n && o.length < 3 && /[0-7]/.test(s[j])) o += s[j++]; bytes.push(parseInt(o, 8) & 255); i = j; continue; }
          const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
          if (d === '\r' || d === '\n') { i += d === '\r' && s[i + 2] === '\n' ? 3 : 2; continue; }
          bytes.push(map[d] ?? d.charCodeAt(0)); i += 2; continue;
        }
        if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } }
        bytes.push(c.charCodeAt(0) & 255); i++;
      }
      pending.push(decode(bytes)); continue;
    }
    if (ch === '<' && s[i + 1] !== '<') { // string hexadecimal
      const j = s.indexOf('>', i); const h = s.slice(i + 1, j < 0 ? n : j).replace(/\s/g, '');
      const bytes: number[] = []; for (let k = 0; k < h.length; k += 2) bytes.push(parseInt((h.slice(k, k + 2) + '0').slice(0, 2), 16));
      pending.push(decode(bytes)); i = j < 0 ? n : j + 1; continue;
    }
    if (ch === '[') { i++; continue; }
    if (ch === ']') { // dentro de TJ: deslocamentos grandes viram espaço
      i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    // token
    let j = i; while (j < n && !/[\s()<>[\]/%]/.test(s[j])) j++;
    if (ch === '/') { j = i + 1; while (j < n && !/[\s()<>[\]/%]/.test(s[j])) j++; nums.push(s.slice(i, j)); i = j; continue; }
    const tok = s.slice(i, j || i + 1); i = j > i ? j : i + 1;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      nums.push(tok);
      if (pending.length && Number(tok) < -180) pending.push(' '); // espaço em TJ
      continue;
    }
    switch (tok) {
      case 'Tf': { const fname = [...nums].reverse().find((x) => x.startsWith('/')); font = fname ? cmaps.get(fname.slice(1)) ?? null : null; break; }
      case 'Tj': case 'TJ': out += pending.join(''); break;
      case "'": case '"': out += '\n' + pending.join(''); break;
      case 'T*': out += '\n'; break;
      case 'Td': case 'TD': { const ty = Number(nums[nums.length - 1]); if (Math.abs(ty) > 0.1) out += '\n'; else if (out && !out.endsWith(' ')) out += ' '; break; }
      case 'Tm': { const y = Number(nums[nums.length - 1]); if (lastY !== null && Math.abs(y - lastY) > 0.5) out += '\n'; else if (out && !out.endsWith(' ') && !out.endsWith('\n')) out += ' '; lastY = y; break; }
      case 'ET': out += '\n'; break;
      default: break;
    }
    pending = []; nums.length = 0;
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n /g, '\n');
}

/** WinAnsi (o que fontes simples do Word usam): os acentos coincidem com latin1, menos 0x80–0x9F. */
const WIN: Record<number, string> = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };

/** Uma planilha como texto curto (para documentos que não são analisados como tabela). */
export function sheetText(s: Sheet, maxRows = 40): string {
  return [`[Aba ${s.name}: ${Math.max(0, s.rows.length - 1)} linha(s)]`, ...s.rows.slice(0, maxRows).map((r) => r.join(' | '))].join('\n');
}
