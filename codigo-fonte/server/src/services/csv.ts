/**
 * CSV robusto, sem dependências: o que planilhas de verdade exportam. UTF-8 com ou sem BOM; separador vírgula, ponto e
 * vírgula ou tabulação (detectado pelo cabeçalho, fora de aspas); campos entre aspas, com aspas dobradas e quebras de
 * linha dentro; CRLF ou LF; valores vazios; aspas no meio de um valor sem aspas (5" monitor) valem como caractere.
 * Arquivo malformado (aspas sem fechar, texto depois de fechar aspas, linha com colunas a mais) é erro
 * explícito com a linha, nunca um palpite. Na exportação, células que começam com = + - @ (fórmulas) são neutralizadas.
 * Conteúdo de arquivo é dado: nada aqui interpreta ou executa o que está dentro das células.
 */

export interface CsvLimits { maxBytes: number; maxRows: number; maxCols: number; maxCell: number }
export const CSV_LIMITS: CsvLimits = { maxBytes: 20 * 1024 * 1024, maxRows: 200_000, maxCols: 200, maxCell: 10_000 };

export interface CsvTable { headers: string[]; rows: string[][]; delimiter: ',' | ';' | '\t'; bom: boolean; lines: number[] }

export class CsvError extends Error {
  readonly code: 'vazio' | 'grande_demais' | 'malformado' | 'codificacao';
  readonly line: number | null;
  constructor(code: CsvError['code'], message: string, line: number | null = null) { super(message); this.code = code; this.line = line; }
}

/** Separador do arquivo: o que mais aparece na primeira linha lógica, fora de aspas. */
function detectDelimiter(text: string): ',' | ';' | '\t' {
  const count: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (q && text[i + 1] === '"') { i++; continue; } q = !q; continue; }
    if (!q && (ch === '\n' || ch === '\r')) break;
    if (!q && ch in count) count[ch]++;
  }
  const best = (Object.entries(count) as Array<[',' | ';' | '\t', number]>).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** Lê o CSV inteiro (bytes ou texto). `lines`: número da linha física (1 = cabeçalho) onde cada registro começa. */
export function parseCsv(input: Buffer | string, limits: CsvLimits = CSV_LIMITS): CsvTable {
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.length;
  if (size > limits.maxBytes) throw new CsvError('grande_demais', `O arquivo tem ${(size / 1024 / 1024).toFixed(1)} MB; o limite para análise é ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); } // o BOM fica: é tirado (e registrado) abaixo
    catch { throw new CsvError('codificacao', 'O arquivo não está em UTF-8. Salve a planilha como "CSV UTF-8" e envie de novo.'); }
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  if (!text.trim()) throw new CsvError('vazio', 'O arquivo está vazio.');
  const delimiter = detectDelimiter(text);
  const records: string[][] = []; const lines: number[] = [];
  let field = ''; let row: string[] = []; let q = false; let line = 1; let start = 1; let afterQuote = false;
  const pushField = () => {
    if (field.length > limits.maxCell) throw new CsvError('malformado', `Uma célula passa de ${limits.maxCell} caracteres.`, start);
    row.push(field); field = ''; afterQuote = false;
    if (row.length > limits.maxCols) throw new CsvError('grande_demais', `Mais de ${limits.maxCols} colunas.`, start);
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) { records.push(row); lines.push(start); }
    if (records.length > limits.maxRows + 1) throw new CsvError('grande_demais', `Mais de ${limits.maxRows.toLocaleString('pt-BR')} linhas: divida o arquivo.`);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { q = false; afterQuote = true; }
      } else { if (ch === '\n') line++; field += ch; }
      continue;
    }
    if (ch === '"') {
      if (field.trim() === '' && !afterQuote) { field = ''; q = true; continue; }
      if (afterQuote) throw new CsvError('malformado', 'Texto depois de fechar as aspas.', line);
      field += ch; continue; // aspas no meio de um valor sem aspas: caractere comum
    }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; pushRow(); line++; start = line; continue; }
    if (ch === '\n') { pushRow(); line++; start = line; continue; }
    if (afterQuote) { if (ch === ' ' || ch === '\t') continue; throw new CsvError('malformado', 'Texto depois de fechar as aspas.', line); }
    field += ch;
  }
  if (q) throw new CsvError('malformado', 'Aspas abertas e nunca fechadas.', start);
  if (field !== '' || row.length) pushRow();
  if (!records.length) throw new CsvError('vazio', 'O arquivo está vazio.');
  const headers = records[0].map((h) => h.trim());
  if (headers.every((h) => !h)) throw new CsvError('malformado', 'A primeira linha precisa ter os nomes das colunas.', 1);
  const rows = records.slice(1);
  rows.forEach((r, i) => {
    if (r.length > headers.length && r.slice(headers.length).some((x) => x.trim())) throw new CsvError('malformado', `Linha com ${r.length} colunas; o cabeçalho tem ${headers.length}.`, lines[i + 1]);
  });
  return { headers, rows: rows.map((r) => headers.map((_, j) => (r[j] ?? '').trim())), delimiter, bom, lines: lines.slice(1) };
}

/** Número como as planilhas brasileiras e internacionais escrevem: 1.234,56 · 1234.56 · 1,5 · 45% (null = não é número). */
export function parseNumber(s: string): number | null {
  let t = s.trim().replace(/\s/g, '').replace(/^R\$/, '').replace(/%$/, '');
  if (!t || !/^[-+]?[\d.,]+$/.test(t)) return null;
  const lastComma = t.lastIndexOf(','); const lastDot = t.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (lastComma > -1) t = /,\d{3}$/.test(t) && (t.match(/,/g) ?? []).length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
  else if ((t.match(/\./g) ?? []).length > 1) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Data explícita (AAAA-MM-DD) a partir de: AAAA-MM-DD, AAAA-MM-DDThh:mm…, DD/MM/AAAA, DD/MM/AA, DD-MM-AAAA ou
 * DD.MM.AAAA. Formato americano (MM/DD) não é adivinhado. null = vazio; undefined = não é uma data válida.
 */
export function parseDate(s: string): string | null | undefined {
  const t = s.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  let mt = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (mt) { y = Number(mt[1]); m = Number(mt[2]); d = Number(mt[3]); }
  else if ((mt = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) { d = Number(mt[1]); m = Number(mt[2]); y = Number(mt[3].length === 2 ? `20${mt[3]}` : mt[3]); }
  else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Célula segura para abrir em planilha: fórmula (= + - @, tab, CR) vira texto. Números puros passam como estão. */
export function safeCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+([.,]\d+)?$/.test(s)) return `'${s}`;
  return s;
}

/** Monta um CSV (UTF-8 com BOM, separador ; — o que o Excel em português abre direto), com células seguras. */
export function toCsv(rows: Array<Array<string | number | null>>, delimiter: ';' | ',' = ';'): string {
  const enc = (v: string | number | null) => {
    const s = safeCell(v);
    return /["\r\n;,]/.test(s) || s.startsWith(' ') || s.endsWith(' ') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(enc).join(delimiter)).join('\r\n') + '\r\n';
}
