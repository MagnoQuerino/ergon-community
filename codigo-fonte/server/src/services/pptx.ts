/**
 * Apresentação editável (.pptx) gerada pelo Ergon, sem dependências: capa, slides de tópicos e gráficos de barras
 * desenhados com formas nativas (o usuário edita texto, cores e tamanhos no PowerPoint, no Keynote ou no Google
 * Apresentações). Os números dos gráficos vêm da análise do Ergon, nunca do texto do modelo.
 */
import { writeZip } from '../lib/zip.ts';
import { fmt } from './table-stats.ts';

export interface Chart { title: string; labels: string[]; values: number[] }
export interface Slide { title: string; bullets: string[]; chart?: Chart; notes?: string }

const W = 12_192_000; const H = 6_858_000; // 16:9
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const INK = '1F2A37'; const GOLD = 'B8862B'; const SOFT = 'E9E2D0'; const MUTED = '5B6573';

/** Divide o texto do agente em slides: "# Título" é a capa, cada "## " abre um slide, "- " são os tópicos. */
export function slidesFromMarkdown(md: string): { title: string; slides: Slide[] } {
  let title = ''; const slides: Slide[] = []; let cur: Slide | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (/^#\s+/.test(l) && !title) { title = l.replace(/^#\s+/, '').trim(); continue; }
    const h = l.match(/^#{2,3}\s+(?:slide\s*\d*\s*[:—-]\s*)?(.+)$/i);
    if (h) { cur = { title: h[1].trim(), bullets: [] }; slides.push(cur); continue; }
    if (/^(notas?|fala)\s*:/i.test(l) && cur) { cur.notes = l.replace(/^(notas?|fala)\s*:\s*/i, ''); continue; }
    const b = l.replace(/^[-*•]\s+|^\d+[.)]\s+/, '');
    if (!cur) { cur = { title: title || 'Resumo', bullets: [] }; slides.push(cur); }
    if (cur.bullets.length < 8) cur.bullets.push(b.replace(/\*\*/g, ''));
  }
  return { title: title || slides[0]?.title || 'Apresentação', slides: slides.slice(0, 30) };
}

const sp = (id: number, name: string, x: number, y: number, w: number, h: number, body: string, fill?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr${fill ? '' : ' txBox="1"'}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" rIns="91440" tIns="45720" bIns="45720" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
const para = (text: string, size: number, color: string, opts: { bold?: boolean; bullet?: boolean; align?: 'l' | 'ctr' | 'r' } = {}) =>
  `<a:p><a:pPr algn="${opts.align ?? 'l'}"${opts.bullet ? ' marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>' : '><a:buNone/></a:pPr>'}<a:r><a:rPr lang="pt-BR" sz="${size}" b="${opts.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`;

function slideXml(s: Slide, n: number, total: number, cover = false): string {
  const shapes: string[] = [];
  let id = 2;
  if (cover) {
    shapes.push(sp(id++, 'Faixa', 0, 0, W, H, '<a:p><a:endParaRPr lang="pt-BR"/></a:p>', INK));
    shapes.push(sp(id++, 'Título', 900_000, 2_200_000, W - 1_800_000, 1_400_000, para(s.title, 4000, 'FFFFFF', { bold: true })));
    if (s.bullets.length) shapes.push(sp(id++, 'Subtítulo', 900_000, 3_700_000, W - 1_800_000, 1_200_000, s.bullets.map((b) => para(b, 2000, SOFT)).join('')));
    shapes.push(sp(id++, 'Linha', 900_000, 2_050_000, 1_600_000, 60_000, '<a:p><a:endParaRPr lang="pt-BR"/></a:p>', GOLD));
  } else {
    shapes.push(sp(id++, 'Barra', 0, 0, W, 120_000, '<a:p><a:endParaRPr lang="pt-BR"/></a:p>', GOLD));
    shapes.push(sp(id++, 'Título', 600_000, 350_000, W - 1_200_000, 900_000, para(s.title, 3000, INK, { bold: true })));
    const top = 1_350_000;
    const chartW = s.chart ? (s.bullets.length ? 6_600_000 : W - 1_200_000) : 0;
    if (s.bullets.length) shapes.push(sp(id++, 'Tópicos', 600_000, top, (s.chart ? W - chartW - 1_500_000 : W - 1_200_000), H - top - 700_000, s.bullets.map((b) => para(b, s.bullets.length > 5 ? 1700 : 2000, INK, { bullet: true })).join('')));
    if (s.chart) {
      const x0 = W - 600_000 - chartW; const y0 = top; const h = H - top - 800_000;
      shapes.push(sp(id++, 'Título do gráfico', x0, y0, chartW, 400_000, para(s.chart.title, 1400, MUTED, { bold: true })));
      const vals = s.chart.values.slice(0, 12); const max = Math.max(...vals.map((v) => Math.abs(v)), 1);
      const n2 = vals.length; const gap = 120_000; const bw = Math.max(150_000, Math.floor((chartW - gap * (n2 + 1)) / Math.max(n2, 1)));
      const base = y0 + h - 450_000; const area = h - 1_000_000;
      vals.forEach((v, i) => {
        const bh = Math.max(20_000, Math.round((Math.abs(v) / max) * area)); const x = x0 + gap + i * (bw + gap);
        shapes.push(sp(id++, `Barra ${i + 1}`, x, base - bh, bw, bh, '<a:p><a:endParaRPr lang="pt-BR"/></a:p>', v < 0 ? 'A2321D' : i === n2 - 1 ? GOLD : '2F5D7C'));
        shapes.push(sp(id++, `Valor ${i + 1}`, x - 60_000, base - bh - 330_000, bw + 120_000, 320_000, para(fmt(v, Math.abs(v) >= 100 ? 0 : 2), 1000, INK, { align: 'ctr' })));
        shapes.push(sp(id++, `Rótulo ${i + 1}`, x - 60_000, base + 30_000, bw + 120_000, 400_000, para(String(s.chart!.labels[i] ?? '').slice(0, 14), 1000, MUTED, { align: 'ctr' })));
      });
    }
    shapes.push(sp(id++, 'Rodapé', 600_000, H - 500_000, W - 1_200_000, 350_000, para(`${n} / ${total}`, 1000, MUTED, { align: 'r' })));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Ergon"><a:themeElements><a:clrScheme name="Ergon"><a:dk1><a:srgbClr val="${INK}"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2F5D7C"/></a:dk2><a:lt2><a:srgbClr val="${SOFT}"/></a:lt2><a:accent1><a:srgbClr val="${GOLD}"/></a:accent1><a:accent2><a:srgbClr val="2F5D7C"/></a:accent2><a:accent3><a:srgbClr val="2F7D4F"/></a:accent3><a:accent4><a:srgbClr val="A2321D"/></a:accent4><a:accent5><a:srgbClr val="8A5A00"/></a:accent5><a:accent6><a:srgbClr val="${MUTED}"/></a:accent6><a:hlink><a:srgbClr val="2F5D7C"/></a:hlink><a:folHlink><a:srgbClr val="5B4B8A"/></a:folHlink></a:clrScheme><a:fontScheme name="Ergon"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Ergon"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Em branco"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const REL = (items: Array<[string, string, string]>) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

/** Monta o .pptx: capa (título e subtítulo) e os slides. */
export function buildPptx(deck: { title: string; subtitle?: string; slides: Slide[] }): Buffer {
  const all: Array<{ s: Slide; cover: boolean }> = [{ s: { title: deck.title, bullets: deck.subtitle ? [deck.subtitle] : [] }, cover: true }, ...deck.slides.map((s) => ({ s, cover: false }))];
  const files: Array<{ name: string; data: string }> = [];
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${all.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: REL([['rId1', 'officeDocument', 'ppt/presentation.xml'], ['rId2', 'extended-properties', 'docProps/app.xml']]).replace('</Relationships>', '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>') });
  files.push({ name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ergon</Application><Slides>${all.length}</Slides></Properties>` });
  files.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(deck.title)}</dc:title><dc:creator>Ergon</dc:creator></cp:coreProperties>` });
  files.push({ name: 'ppt/presentation.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${all.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` });
  files.push({ name: 'ppt/_rels/presentation.xml.rels', data: REL([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'], ...all.map((_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string])]) });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: REL([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: REL([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) });
  files.push({ name: 'ppt/theme/theme1.xml', data: THEME });
  all.forEach(({ s, cover }, i) => {
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(s, i + 1, all.length, cover) });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: REL([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]) });
  });
  return writeZip(files);
}
