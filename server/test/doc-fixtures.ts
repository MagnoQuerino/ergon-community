/** Documentos de teste feitos na hora (Word, Excel, PDF e ZIP "mentiroso"), sem arquivos binários no repositório. */
import zlib from 'node:zlib';
import { writeZip } from '../src/lib/zip.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const docx = (body: string) => writeZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
]);
export const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

export function xlsx(rows: Array<Array<string | number | { date: number }>>): Buffer {
  const strings: string[] = [];
  const si = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="1"><v>${v.date}</v></c>`;
  }).join('')}</row>`).join('');
  return writeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Vendas" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>` },
    { name: 'xl/styles.xml', data: '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` },
  ]);
}

/** PDF mínimo com os objetos dados (o primeiro é o catálogo); "LEN" vira o tamanho do fluxo do objeto. */
export function pdf(objs: string[], streams: Record<number, Buffer> = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  objs.forEach((o, i) => {
    const n = i + 1;
    const st = streams[n];
    parts.push(Buffer.from(`${n} 0 obj\n${st ? o.replace('LEN', String(st.length)) : o}\n`, 'latin1'));
    if (st) parts.push(Buffer.from('stream\n', 'latin1'), st, Buffer.from('\nendstream\n', 'latin1'));
    parts.push(Buffer.from('endobj\n', 'latin1'));
  });
  parts.push(Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

/** PDF de uma página com texto (fonte simples), comprimido. */
export function textPdf(lines: string[]): Buffer {
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l}) Tj 0 -14 Td`).join(' ')} ET`, 'latin1'));
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Length LEN /Filter /FlateDecode >>',
  ], { 5: content });
}

/**
 * ZIP com entradas já comprimidas e tamanho declarado à escolha — o jeito de uma bomba de zip mentir ("1 KB")
 * sobre o que descompacta de verdade.
 */
export function rawZip(entries: Array<{ name: string; comp: Buffer; declared: number }>): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(e.comp.length, 18); h.writeUInt32LE(e.declared, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, e.comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(e.comp.length, 20); c.writeUInt32LE(e.declared, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + e.comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
