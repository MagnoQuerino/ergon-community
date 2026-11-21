/**
 * Editar arquivos do Office que já existem (rc.42, "mãos na massa"), sem dependência nova: o docx e o xlsx são ZIP com XML
 * (lib/zip.ts). Só o que os agentes precisam e dá para fazer sem estragar o arquivo:
 *   - Word: trocar um texto por outro (em todo o documento) e acrescentar parágrafos no fim. O texto de um parágrafo pode
 *     vir partido em vários trechos (w:r/w:t) por causa de formatação; quando o que se procura atravessa trechos, o
 *     parágrafo inteiro passa a ser um trecho só com a formatação do primeiro (o estilo do parágrafo fica).
 *   - Excel: escrever valores em células (texto, número ou fórmula), mantendo estilos, outras abas e o resto do arquivo.
 * Tudo o mais no ZIP vai como estava.
 */
import { readZip, writeZip } from './zip.ts';

export class ErroEdicao extends Error {}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const desesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// só o que o XML 1.0 aceita (o resto quebraria o arquivo)
const limpo = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

function remontar(buf: Buffer, troca: Record<string, Buffer | string>): Buffer {
  const z = readZip(buf);
  return writeZip([...z.values()].map((e) => ({ name: e.name, data: e.name in troca ? troca[e.name] : e.read(), mtime: undefined })));
}

/** Word: troca `de` por `para` em todos os parágrafos. Devolve o arquivo novo e quantas vezes trocou. */
export function trocarNoDocx(buf: Buffer, de: string, para: string): { data: Buffer; vezes: number } {
  if (!de) throw new ErroEdicao('falta o texto a procurar');
  const z = readZip(buf);
  const doc = z.get('word/document.xml');
  if (!doc) throw new ErroEdicao('não é um documento do Word (.docx)');
  let vezes = 0;
  const xml = doc.read().toString('utf8').replace(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g, (p) => {
    const trechos = [...p.matchAll(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
    if (!trechos.length) return p;
    const texto = trechos.map((t) => desesc(t[2])).join('');
    if (!texto.includes(de)) return p;
    vezes += texto.split(de).length - 1;
    // dentro de um trecho só: troca ali, sem mexer na formatação dos outros
    if (trechos.some((t) => desesc(t[2]).includes(de))) {
      return p.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_m, at, c) => `<w:t${/xml:space/.test(at ?? '') ? at : ' xml:space="preserve"'}>${esc(limpo(desesc(c).split(de).join(para)))}</w:t>`);
    }
    // atravessa trechos: o parágrafo vira um trecho só (o primeiro), os outros ficam vazios
    let primeiro = true;
    return p.replace(/<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>/g, () => {
      const c = primeiro ? esc(limpo(texto.split(de).join(para))) : '';
      primeiro = false;
      return `<w:t xml:space="preserve">${c}</w:t>`;
    });
  });
  return { data: vezes ? remontar(buf, { 'word/document.xml': xml }) : buf, vezes };
}

/** Word: parágrafos novos no fim do corpo (antes das configurações da seção). Uma linha = um parágrafo. */
export function acrescentarNoDocx(buf: Buffer, texto: string): Buffer {
  const z = readZip(buf);
  const doc = z.get('word/document.xml');
  if (!doc) throw new ErroEdicao('não é um documento do Word (.docx)');
  const xml = doc.read().toString('utf8');
  const pars = limpo(texto).split(/\r?\n/).map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('');
  const fim = xml.lastIndexOf('<w:sectPr');
  const corpoFim = xml.lastIndexOf('</w:body>');
  if (corpoFim < 0) throw new ErroEdicao('documento do Word sem corpo');
  const onde = fim >= 0 && fim < corpoFim ? fim : corpoFim;
  return remontar(buf, { 'word/document.xml': xml.slice(0, onde) + pars + xml.slice(onde) });
}

/** "B12" → coluna 2, linha 12. */
export function celula(ref: string): { col: number; lin: number } {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref.trim().toUpperCase());
  if (!m) throw new ErroEdicao(`célula inválida: "${ref}" (use como A1 ou B12)`);
  let col = 0; for (const c of m[1]) col = col * 26 + (c.charCodeAt(0) - 64);
  return { col, lin: Number(m[2]) };
}
export const nomeColuna = (n: number): string => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

/** O XML de uma célula: fórmula (começa com =), número (só dígitos, com ponto decimal) ou texto em linha. */
function xmlCelula(ref: string, v: string, estilo: string): string {
  const s = estilo ? ` s="${estilo}"` : '';
  if (v === '') return `<c r="${ref}"${s}/>`;
  if (v.startsWith('=')) return `<c r="${ref}"${s}><f>${esc(limpo(v.slice(1)))}</f></c>`;
  if (/^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(limpo(v))}</t></is></c>`;
}

/**
 * Excel: escreve `valores` (linhas × colunas) a partir da célula `inicio` na aba `aba` (nome; vazio = a primeira).
 * Mantém o estilo de cada célula que já existia. Devolve o arquivo novo e o intervalo escrito.
 */
export function escreverNoXlsx(buf: Buffer, aba: string | undefined, inicio: string, valores: string[][]): { data: Buffer; intervalo: string; aba: string } {
  const z = readZip(buf);
  const wb = z.get('xl/workbook.xml')?.read().toString('utf8');
  const rels = z.get('xl/_rels/workbook.xml.rels')?.read().toString('utf8');
  if (!wb || !rels) throw new ErroEdicao('não é uma planilha do Excel (.xlsx)');
  const abas = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]*)"/g)].map((m) => ({ nome: desesc(m[1]), rid: m[2] }));
  const alvo = aba ? abas.find((a) => a.nome.toLowerCase() === aba.toLowerCase()) : abas[0];
  if (!alvo) throw new ErroEdicao(`a aba "${aba}" não existe; as abas são: ${abas.map((a) => a.nome).join(', ')}`);
  const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${alvo.rid}"[^>]*\\bTarget="([^"]*)"`).exec(rels) ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]*)"[^>]*\\bId="${alvo.rid}"`).exec(rels);
  if (!rel) throw new ErroEdicao('planilha sem a ligação da aba');
  const caminho = rel[1].startsWith('/') ? rel[1].slice(1) : `xl/${rel[1].replace(/^\.\//, '')}`;
  let xml = z.get(caminho)?.read().toString('utf8');
  if (xml === undefined) throw new ErroEdicao('a aba não está no arquivo');
  if (!valores.length || valores.length > 10_000 || valores.some((l) => l.length > 500)) throw new ErroEdicao('valores vazios ou grandes demais (até 10.000 linhas e 500 colunas)');
  const ini = celula(inicio);
  if (!/<sheetData\b[^>]*\/>|<sheetData\b[^>]*>/.test(xml)) throw new ErroEdicao('aba sem dados');
  xml = xml.replace(/<sheetData\b([^>]*)\/>/, '<sheetData$1></sheetData>');
  const m = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)!;
  // linhas existentes: número → { abertura, células por coluna }
  const linhas = new Map<number, { abre: string; cels: Map<number, string> }>();
  for (const r of m[1].matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const n = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? 0);
    const cels = new Map<number, string>();
    for (const c of (r[2] ?? '').matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) { const ref = /\br="([A-Z]+\d+)"/.exec(c[0])?.[1]; if (ref) cels.set(celula(ref).col, c[0]); }
    linhas.set(n, { abre: `<row${r[1].replace(/\s*\/$/, '')}>`, cels });
  }
  valores.forEach((l, i) => {
    const n = ini.lin + i;
    const linha = linhas.get(n) ?? { abre: `<row r="${n}">`, cels: new Map<number, string>() };
    l.forEach((v, j) => {
      const col = ini.col + j; const ref = `${nomeColuna(col)}${n}`;
      const estilo = /\bs="(\d+)"/.exec(linha.cels.get(col) ?? '')?.[1] ?? '';
      linha.cels.set(col, xmlCelula(ref, String(v ?? ''), estilo));
    });
    // a abertura antiga pode declarar spans: sem ela, o Excel recalcula
    linha.abre = linha.abre.replace(/\s+spans="[^"]*"/, '');
    linhas.set(n, linha);
  });
  const corpo = [...linhas.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => `${l.abre}${[...l.cels.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join('')}</row>`).join('');
  xml = xml.slice(0, m.index) + xml.slice(m.index).replace(m[0], m[0].replace(m[1], corpo));
  // a dimensão declarada deixa de valer: sai (o Excel aceita sem ela)
  xml = xml.replace(/<dimension\b[^>]*\/>/, '');
  const fim = `${nomeColuna(ini.col + Math.max(...valores.map((l) => l.length)) - 1)}${ini.lin + valores.length - 1}`;
  // fórmulas com resultado guardado: o Excel recalcula ao abrir
  const troca: Record<string, string> = { [caminho]: xml };
  if (z.has('xl/calcChain.xml')) troca['xl/calcChain.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>';
  const wbCalc = /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)\/>/, (_x, a) => `<calcPr${String(a).replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`) : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  troca['xl/workbook.xml'] = wbCalc;
  return { data: remontar(buf, troca), intervalo: `${inicio.toUpperCase()}:${fim}`, aba: alvo.nome };
}

/** CSV: escreve valores a partir de uma célula, crescendo o arquivo quando preciso. Separador: o que o arquivo já usa. */
export function escreverNoCsv(texto: string, inicio: string, valores: string[][]): string {
  const sep = (texto.split('\n')[0].match(/;/g)?.length ?? 0) > (texto.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const linhas = texto.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((l) => (l ? parseLinha(l, sep) : []));
  const ini = celula(inicio);
  valores.forEach((l, i) => {
    const n = ini.lin - 1 + i;
    while (linhas.length <= n) linhas.push([]);
    l.forEach((v, j) => { const c = ini.col - 1 + j; while (linhas[n].length < c) linhas[n].push(''); linhas[n][c] = String(v ?? ''); });
  });
  const q = (v: string) => (v.includes(sep) || v.includes('"') || /[\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${linhas.map((l) => l.map(q).join(sep)).join('\n')}\n`;
}
function parseLinha(l: string, sep: string): string[] {
  const out: string[] = []; let cur = ''; let dentro = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (dentro) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') dentro = false; else cur += ch; }
    else if (ch === '"') dentro = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Os valores como o agente manda: JSON de linhas ([["a",1],["b",2]]) ou texto com linhas e células separadas por | ou tab. */
export function valoresDe(v: unknown): string[][] {
  if (Array.isArray(v)) return v.map((l) => (Array.isArray(l) ? l.map((x) => (x === null || x === undefined ? '' : String(x))) : [String(l ?? '')]));
  const s = String(v ?? '').trim();
  if (!s) throw new ErroEdicao('faltam os valores');
  if (s.startsWith('[')) { try { return valoresDe(JSON.parse(s)); } catch { throw new ErroEdicao('"valores" em JSON inválido: use [["a", 1], ["b", 2]]'); } }
  return s.split(/\r?\n/).map((l) => l.split(/\t|\s*\|\s*/));
}
