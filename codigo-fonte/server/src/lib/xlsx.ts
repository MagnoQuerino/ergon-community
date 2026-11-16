/**
 * Planilha do Excel (.xlsx) e CSV a partir do que os colegas escrevem: as tabelas em Markdown da resposta
 * (| a | b |). Cada tabela vira uma aba (o título acima dela dá o nome); sem tabela, cada linha do texto vira uma linha
 * da coluna A. Números no jeito brasileiro ("R$ 1.250,00", "12,5%") viram números de verdade, e fórmulas ("=SOMA(B2:B9)",
 * "=SOMASE(A:A;\"Aluguel\";B:B)") viram fórmulas do Excel (nomes em português traduzidos, ";" trocado por ","). Sem
 * dependências: o .xlsx é um ZIP com XML (lib/zip.ts). Abre no Excel, no LibreOffice e no Google Planilhas.
 */
import { writeZip } from './zip.ts';

export interface Sheet { name: string; rows: string[][] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Linha de tabela Markdown → células (sem as bordas; "\|" fica como barra). */
function cellsOf(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim().replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`(.*)`$/, '$1'));
}
const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);

/** Nome de aba válido no Excel: até 31 caracteres, sem : \ / ? * [ ], único. */
function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[:\\/?*[\]]/g, ' ').replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Planilha';
  let name = base; let i = 2;
  while (used.has(name.toLowerCase())) { const suf = ` (${i++})`; name = base.slice(0, 31 - suf.length) + suf; }
  used.add(name.toLowerCase());
  return name;
}

/** As tabelas da resposta (cada uma com o título mais próximo acima dela). Sem tabela: o texto, linha a linha. */
export function sheetsFromMarkdown(md: string, fallbackTitle = 'Planilha'): Sheet[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const sheets: Sheet[] = []; const used = new Set<string>();
  let title = ''; let cur: string[][] | null = null;
  const close = () => { if (cur && cur.length) sheets.push({ name: sheetName(title || `${fallbackTitle}${sheets.length ? ` ${sheets.length + 1}` : ''}`, used), rows: cur }); cur = null; };
  for (const line of lines) {
    if (isTableLine(line)) {
      const cells = cellsOf(line);
      if (isSeparator(cells)) continue;
      (cur ??= []).push(cells);
      continue;
    }
    close();
    const h = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/) ?? line.match(/^\s*\*\*(.+?)\*\*:?\s*$/);
    if (h) title = h[1].trim();
  }
  close();
  if (sheets.length) return sheets;
  const rows = lines.map((l) => l.trim()).filter(Boolean).filter((l) => !/^\[\[/.test(l)).map((l) => [l.replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+/, '')]);
  return [{ name: sheetName(fallbackTitle, used), rows: rows.length ? rows : [['']] }];
}

const FUNCOES: Record<string, string> = {
  SOMA: 'SUM', SOMASE: 'SUMIF', SOMASES: 'SUMIFS', MEDIA: 'AVERAGE', 'MÉDIA': 'AVERAGE', MEDIASE: 'AVERAGEIF', 'MÉDIASE': 'AVERAGEIF',
  CONT: 'COUNT', 'CONT.VALORES': 'COUNTA', 'CONT.SE': 'COUNTIF', 'CONT.SES': 'COUNTIFS', CONTSE: 'COUNTIF', MAXIMO: 'MAX', 'MÁXIMO': 'MAX',
  MINIMO: 'MIN', 'MÍNIMO': 'MIN', SE: 'IF', E: 'AND', OU: 'OR', ARRED: 'ROUND', PROCV: 'VLOOKUP', PROCH: 'HLOOKUP', HOJE: 'TODAY',
  SEERRO: 'IFERROR', CONCATENAR: 'CONCATENATE', ABS: 'ABS', ANO: 'YEAR', 'MÊS': 'MONTH', MES: 'MONTH', DIA: 'DAY',
};
/**
 * Funções que buscam fora da planilha ou executam algo: o conteúdo pode ter vindo de fora (um e-mail, uma página) e a
 * fórmula rodaria no computador de quem abre. Ficam como texto.
 */
const PERIGOSAS = new Set(['HYPERLINK', 'HIPERLINK', 'WEBSERVICE', 'SERVICEWEB', 'FILTERXML', 'FILTRARXML', 'IMPORTDATA', 'IMPORTXML', 'IMPORTHTML',
  'IMPORTRANGE', 'IMPORTFEED', 'IMAGE', 'IMAGEM', 'RTD', 'CALL', 'REGISTER', 'REGISTER.ID', 'EXEC', 'DDE', 'INFO', 'INFORMAÇÃO', 'CELL', 'CÉL']);

/** "=SOMA(B2:B9;C2)" → "SUM(B2:B9,C2)" (sem o "="), fora do que está entre aspas. null: não vira fórmula (fica texto). */
export function formulaOf(raw: string): string | null {
  const f = raw.trim().replace(/^=/, '');
  if (!f || f.length > 2000 || /[\r\n|\[\]]/.test(f)) return null;
  let out = ''; let inStr = false;
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) { out += ch; continue; }
    if (ch === ';') { out += ','; continue; }
    const m = f.slice(i).match(/^([A-ZÀ-Ú][A-ZÀ-Ú0-9._]*)\s*\(/i);
    if (m) {
      const name = m[1].toUpperCase(); const en = FUNCOES[name] ?? name;
      if (PERIGOSAS.has(name) || PERIGOSAS.has(en)) return null;
      out += en + '('; i += m[0].length - 1; continue;
    }
    // vírgula decimal dentro de número (1,5) → ponto
    if (ch === ',' && /\d/.test(f[i - 1] ?? '') && /\d/.test(f[i + 1] ?? '')) { out += '.'; continue; }
    out += ch;
  }
  return inStr ? null : out;
}

/** "R$ 1.250,00" → 1250; "12,5%" → 0.125; "1250.5" → 1250.5; "-R$ 30" → -30. null: não é número. */
export function numberOf(raw: string): { value: number; percent: boolean; money: boolean } | null {
  let t = raw.trim().replace(/ /g, ' ');
  if (!t || t.length > 40) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  if (t.startsWith('-') || t.startsWith('−')) { neg = !neg; t = t.slice(1).trim(); }
  const money = /^(R\$|US\$|\$|€)\s*/i.test(t);
  t = t.replace(/^(R\$|US\$|\$|€)\s*/i, '');
  if (t.startsWith('-') || t.startsWith('−')) { neg = !neg; t = t.slice(1).trim(); }
  const percent = t.endsWith('%');
  if (percent) t = t.slice(0, -1).trim();
  let n: number;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) || /^\d+,\d+$/.test(t)) n = Number(t.replace(/\./g, '').replace(',', '.'));
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) n = Number(t.replace(/,/g, ''));
  else if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
  else return null;
  if (!Number.isFinite(n)) return null;
  if (/^0\d/.test(t) && !/^0[.,]/.test(t)) return null; // "0123": código, CEP, telefone → texto
  return { value: (neg ? -n : n) / (percent ? 100 : 1), percent, money };
}

const colName = (i: number): string => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** estilos: 0 normal, 1 cabeçalho (negrito), 2 dinheiro, 3 porcentagem, 4 número com casas */
function sheetXml(sheet: Sheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, c) => {
    const len = Math.max(8, ...sheet.rows.map((r) => (r[c] ?? '').length));
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, len + 2)}" customWidth="1"/>`;
  }).join('');
  const header = sheet.rows.length > 1;
  const rows = sheet.rows.map((r, ri) => {
    const cells = r.map((raw, ci) => {
      const ref = `${colName(ci)}${ri + 1}`;
      if (raw === '') return '';
      if (ri === 0 && header) return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`;
      if (raw.trim().startsWith('=')) {
        const f = formulaOf(raw);
        if (f) return `<c r="${ref}"><f>${esc(f)}</f></c>`;
      }
      const n = numberOf(raw);
      if (n) return `<c r="${ref}" s="${n.money ? 2 : n.percent ? 3 : Number.isInteger(n.value) ? 0 : 4}"><v>${n.value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const freeze = header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** O .xlsx das abas dadas (pelo menos uma). As fórmulas são recalculadas ao abrir (fullCalcOnLoad). */
export function buildXlsx(sheets: Sheet[]): Buffer {
  const list = sheets.length ? sheets.slice(0, 50) : [{ name: 'Planilha', rows: [['']] }];
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    list.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  }<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
    list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  return writeZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

export const markdownToXlsx = (md: string, title: string): Buffer => buildXlsx(sheetsFromMarkdown(md, title));

/** CSV (separador ";", como o Excel em português abre direto; com BOM para os acentos) da primeira tabela. */
export function markdownToCsv(md: string, title: string): Buffer {
  const sheet = sheetsFromMarkdown(md, title)[0];
  const q = (c: string) => (/[;"\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  // fórmula vira texto no CSV ("=..." abriria como fórmula: injeção em planilha); o valor calculado não existe aqui
  const safe = (c: string) => (/^[=+\-@]/.test(c) && !numberOf(c) ? `'${c}` : c);
  return Buffer.from('﻿' + sheet.rows.map((r) => r.map((c) => q(safe(c))).join(';')).join('\r\n') + '\r\n', 'utf8');
}
