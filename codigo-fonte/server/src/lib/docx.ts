/**
 * Documento do Word (.docx) a partir de um texto em Markdown simples — o que os colegas escrevem: títulos (#), listas
 * (-, 1.), negrito (**), itálico (*) e parágrafos. Sem dependências: o .docx é um ZIP com XML (lib/zip.ts). Abre no
 * Word, no LibreOffice e no Google Docs.
 */
import { writeZip } from './zip.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Trechos de uma linha com negrito e itálico. */
function runs(line: string, base: { bold?: boolean; size?: number } = {}): string {
  const out: string[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let at = 0;
  const run = (t: string, b = false, i = false) => {
    if (!t) return;
    const pr = [(b || base.bold) && '<w:b/>', i && '<w:i/>', base.size && `<w:sz w:val="${base.size}"/>`].filter(Boolean).join('');
    out.push(`<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
  };
  for (const m of line.matchAll(re)) {
    run(line.slice(at, m.index));
    if (m[1] !== undefined) run(m[1], true); else if (m[2] !== undefined) run(m[2], false, true); else run(m[3]);
    at = m.index! + m[0].length;
  }
  run(line.slice(at));
  return out.join('');
}

const para = (inner: string, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;

export function markdownToDocx(text: string, title: string): Buffer {
  const body: string[] = [];
  let n = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { n = 0; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { body.push(para(runs(h[2], { bold: true, size: h[1].length === 1 ? 32 : h[1].length === 2 ? 28 : 24 }), '<w:spacing w:before="240" w:after="120"/>')); continue; }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) { body.push(para(`<w:r><w:t xml:space="preserve">•  </w:t></w:r>${runs(ul[1])}`, '<w:ind w:left="360" w:hanging="240"/>')); continue; }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) { n = Number(ol[1]) || n + 1; body.push(para(`<w:r><w:t xml:space="preserve">${n}.  </w:t></w:r>${runs(ol[2])}`, '<w:ind w:left="360" w:hanging="300"/>')); continue; }
    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { body.push(para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>')); continue; }
    if (/^\|.*\|$/.test(line.trim()) && !/^\|?\s*:?-{2,}/.test(line.trim())) { body.push(para(runs(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('   ·   ')))); continue; }
    if (/^\|?\s*:?-{2,}/.test(line.trim())) continue;
    body.push(para(runs(line.replace(/^>\s?/, ''))));
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:creator>Ergon</dc:creator></cp:coreProperties>` },
    { name: 'word/document.xml', data: doc },
  ]);
}
