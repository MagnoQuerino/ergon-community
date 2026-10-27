/**
 * Documentos hostis e malformados: bombas de zip com tamanho mentiroso, PDF que
 * descompacta para gigabytes, tabela de fontes gigante, árvore de páginas em ciclo, arquivos cortados e mutação
 * aleatória (fuzzing, semente fixa). A regra: a leitura nunca derruba o servidor, nunca trava, e o que não deu para
 * ler volta como erro dito — nunca como texto vazio fingindo leitura.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { describe, test } from 'node:test';
import { readDocument } from '../src/services/doc-isolated.ts';
import { extractDoc, type DocText } from '../src/services/doc-text.ts';
import { conferenciaLines, conferir, obrigacoesOf, type Lancamento } from '../src/services/fin-parse.ts';
import { buildPptx, slidesFromMarkdown } from '../src/services/pptx.ts';
import { writeZip } from '../src/lib/zip.ts';
import { docx, p, pdf, rawZip, textPdf, xlsx } from './doc-fixtures.ts';

const MB = 1024 * 1024;
const STATUS = new Set(['ok', 'sem_texto', 'nao_suportado', 'erro']);
const timed = (f: () => DocText) => { const t0 = Date.now(); const d = f(); return { d, ms: Date.now() - t0 }; };
const sane = (d: DocText, what: string) => {
  assert.ok(STATUS.has(d.status), `${what}: status ${d.status}`);
  if (d.status === 'erro' || d.status === 'nao_suportado') assert.ok(d.detail, `${what}: erro sempre com o motivo`);
  assert.ok(d.text.length <= 60 * MB, `${what}: texto limitado`);
};

/** gerador determinístico (mulberry32): a mesma semente reproduz a mesma falha */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('acervo hostil', () => {
  test('bomba de zip com tamanho declarado mentiroso ("100 bytes" que viram 64 MB): erro dito, sem estourar memória', () => {
    const bomb = rawZip([{ name: 'word/document.xml', comp: zlib.deflateRawSync(Buffer.alloc(64 * MB, 0x20)), declared: 100 }]);
    assert.ok(bomb.length < 200_000, 'o arquivo é pequeno');
    const { d, ms } = timed(() => extractDoc('bomba.docx', '', bomb));
    assert.equal(d.status, 'erro'); assert.match(d.detail!, /descompacta para mais do que o limite/);
    assert.ok(ms < 5000, `${ms} ms`);
  });

  test('várias entradas mentirosas que juntas passam do teto real (5 abas × 30 MB): erro, não 150 MB na memória', () => {
    const sheet = zlib.deflateRawSync(Buffer.alloc(30 * MB, 0x20));
    const n = 5;
    const zip = rawZip([
      { name: 'xl/workbook.xml', comp: zlib.deflateRawSync(Buffer.from(`<workbook><sheets>${Array.from({ length: n }, (_, i) => `<sheet name="A${i}" sheetId="${i + 1}" r:id="r${i}"/>`).join('')}</sheets></workbook>`)), declared: 300 },
      { name: 'xl/_rels/workbook.xml.rels', comp: zlib.deflateRawSync(Buffer.from(`<Relationships>${Array.from({ length: n }, (_, i) => `<Relationship Id="r${i}" Target="worksheets/s${i}.xml"/>`).join('')}</Relationships>`)), declared: 300 },
      ...Array.from({ length: n }, (_, i) => ({ name: `xl/worksheets/s${i}.xml`, comp: sheet, declared: 100 })),
    ]);
    const { d, ms } = timed(() => extractDoc('bomba.xlsx', '', zip));
    assert.equal(d.status, 'erro'); assert.match(d.detail!, /grande demais/);
    assert.ok(ms < 10_000, `${ms} ms`);
  });

  test('PDF cujos fluxos somados descompactam para mais de 120 MB: erro dito', () => {
    const z = zlib.deflateSync(Buffer.alloc(25 * MB, 0x20));
    const n = 6;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /Contents [${Array.from({ length: n }, (_, i) => `${i + 4} 0 R`).join(' ')}] >>`,
      ...Array.from({ length: n }, () => '<< /Length LEN /Filter /FlateDecode >>')];
    const streams = Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 4, z]));
    const { d, ms } = timed(() => extractDoc('bomba.pdf', 'application/pdf', pdf(objs, streams)));
    assert.equal(d.status, 'erro'); assert.match(d.detail!, /mais de 120 MB/);
    assert.ok(ms < 15_000, `${ms} ms`);
  });

  test('tabela de fontes gigante (2.000 faixas de 5.000 códigos = 10 milhões): fica no teto e termina', () => {
    const ranges = Array.from({ length: 2000 }, (_, i) => `<${(i * 5000).toString(16).padStart(8, '0')}> <${(i * 5000 + 4999).toString(16).padStart(8, '0')}> <0041>`).join('\n');
    const cmap = Buffer.from(`begincmap\n1 begincodespacerange\n<00000000> <FFFFFFFF>\nendcodespacerange\n2000 beginbfrange\n${ranges}\nendbfrange\nendcmap`, 'latin1');
    const buf = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>', '<< /Length LEN >>', '<< /Length LEN >>'],
    { 5: Buffer.from('BT /F1 12 Tf <00000001> Tj ET', 'latin1'), 6: cmap });
    const { d, ms } = timed(() => extractDoc('fontes.pdf', 'application/pdf', buf));
    sane(d, 'cmap'); assert.ok(ms < 5000, `${ms} ms`);
  });

  test('árvore de páginas e herança de fontes em ciclo: termina', () => {
    const buf = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [2 0 R 3 0 R] /Parent 3 0 R /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', '<< /Length LEN >>'], { 4: Buffer.from('BT (Texto num ciclo de paginas) Tj ET', 'latin1') });
    const { d, ms } = timed(() => extractDoc('ciclo.pdf', 'application/pdf', buf));
    sane(d, 'ciclo'); assert.ok(ms < 2000);
  });

  test('XML aninhado a fundo e atributo gigante no Word: termina, sem estourar a pilha', () => {
    const deep = '<w:p>'.repeat(50_000) + p('fundo') + '</w:p>'.repeat(50_000);
    sane(extractDoc('fundo.docx', '', docx(deep)), 'aninhado');
    sane(extractDoc('attr.docx', '', docx(`<w:p a="${'x'.repeat(5 * MB)}"><w:r><w:t>oi</w:t></w:r></w:p>`)), 'atributo');
  });
});

describe('arquivos cortados e mutação aleatória (fuzzing, semente fixa)', () => {
  const samples: Array<{ name: string; mime: string; data: Buffer }> = [
    { name: 'contrato.docx', mime: '', data: docx(p('Contrato de prestação de serviços') + p('Vigência até 31/12/2026')) },
    { name: 'vendas.xlsx', mime: '', data: xlsx([['Mês', 'Valor'], ['jan', 1500], ['fev', 1700], ['data', { date: 46000 }]]) },
    { name: 'resultado.pptx', mime: '', data: buildPptx(slidesFromMarkdown('# Resultado\n- vendas subiram\n- custos caíram')) },
    { name: 'relatorio.pdf', mime: 'application/pdf', data: textPdf(['Relatorio mensal', 'Total de 1.500 reais']) },
    { name: 'dados.csv', mime: 'text/csv', data: Buffer.from('data;valor;descrição\n2026-01-01;10,50;"aluguel; sala"\n2026-02-01;20;luz\n') },
    { name: 'nota.xml', mime: 'application/xml', data: Buffer.from('<?xml version="1.0"?><nfeProc><NFe><infNFe><emit><xNome>Loja &amp; Cia</xNome></emit><total><ICMSTot><vNF>150.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>') },
    { name: 'extrato.ofx', mime: '', data: Buffer.from('OFXHEADER:100\n<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-50.00<MEMO>Padaria</STMTTRN></BANKTRANLIST></OFX>') },
  ];

  test('os exemplos válidos são lidos (o fuzzing parte de arquivos que funcionam)', () => {
    for (const s of samples) { const d = extractDoc(s.name, s.mime, s.data); assert.equal(d.status, 'ok', `${s.name}: ${d.detail}`); }
  });

  test('cortados em 25 pontos cada: nunca lança, sempre diz o que houve', () => {
    for (const s of samples) {
      for (let i = 1; i <= 25; i++) {
        const cut = s.data.subarray(0, Math.floor((s.data.length * i) / 26));
        sane(extractDoc(s.name, s.mime, cut), `${s.name} cortado em ${cut.length}`);
      }
    }
  });

  test('400 mutações por formato (bytes trocados, trechos repetidos e apagados): nunca lança nem trava', () => {
    const r = rng(20261026);
    let slowest = 0;
    for (const s of samples) {
      for (let i = 0; i < 400; i++) {
        let b = Buffer.from(s.data);
        const kind = r();
        if (kind < 0.6) { for (let k = 1 + Math.floor(r() * 16); k > 0; k--) b[Math.floor(r() * b.length)] = Math.floor(r() * 256); }
        else if (kind < 0.8) { const at = Math.floor(r() * b.length); const len = Math.floor(r() * 64); b = Buffer.concat([b.subarray(0, at), b.subarray(at, at + len), b.subarray(at)]); }
        else { const at = Math.floor(r() * b.length); b = Buffer.concat([b.subarray(0, at), b.subarray(at + Math.floor(r() * 64))]); }
        const { d, ms } = timed(() => extractDoc(s.name, s.mime, b));
        sane(d, `${s.name} mutação ${i}`);
        slowest = Math.max(slowest, ms);
      }
    }
    assert.ok(slowest < 3000, `a mais lenta levou ${slowest} ms`);
  });
});

describe('mutação por dentro (XML do Office e fluxo do PDF antes de compactar)', () => {
  // pedaços que confundem os leitores: marcas soltas, referências de célula absurdas, operadores de PDF fora de ordem
  const JUNK = ['<', '>', '"', '&', '&#xFFFFFF;', '&#0;', '/', '<w:t>', '</w:t>', '<w:p>', '<w:tab/>', '<row>', '</row>', '<c r="ZZZZZZ9999999" t="s"><v>99999999</v></c>',
    '<c t="inlineStr"><is><t>', '<v>1e309</v>', '<si>', '\u0000', '(', ')', '\\', '\\777', 'Tj', 'TJ', '[', ']', '<<', '>>', ' 9999999999 ', ' Tf ', ' Td ', ' Tm ', '/F1', '<FFFF', 'BT', 'ET'];
  const mutate = (s: string, r: () => number) => {
    let out = s;
    for (let k = 1 + Math.floor(r() * 8); k > 0; k--) {
      const at = Math.floor(r() * (out.length + 1));
      out = r() < 0.75 ? out.slice(0, at) + JUNK[Math.floor(r() * JUNK.length)] + out.slice(at) : out.slice(0, at) + out.slice(at + Math.floor(r() * 12));
    }
    return out;
  };

  test('300 Word, 300 Excel e 300 PDF mutados por dentro: nunca lança nem trava', () => {
    const r = rng(7041);
    const body = p('Contrato de prestação de serviços') + p('Vigência até 31/12/2026') + '<w:tbl><w:tr><w:tc>' + p('a') + '</w:tc></w:tr></w:tbl>';
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1500</v></c></row><row r="2"><c r="A2" s="1"><v>46000</v></c></row>';
    const content = 'BT /F1 12 Tf 72 720 Td (Relatorio mensal) Tj 0 -14 Td [(Total) -250 (de 1.500)] TJ ET';
    let slowest = 0;
    for (let i = 0; i < 300; i++) {
      const cases: Array<[string, string, Buffer]> = [
        ['m.docx', '', docx(mutate(body, r))],
        ['m.xlsx', '', writeZip([
          { name: 'xl/workbook.xml', data: mutate('<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>', r) },
          { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
          { name: 'xl/sharedStrings.xml', data: mutate('<sst><si><t>Mês</t></si></sst>', r) },
          { name: 'xl/styles.xml', data: mutate('<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>', r) },
          { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${mutate(sheet, r)}</sheetData></worksheet>` },
        ])],
        ['m.pdf', 'application/pdf', pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
          '<< /Type /Font /Subtype /Type1 /Encoding /WinAnsiEncoding >>', '<< /Length LEN /Filter /FlateDecode >>'], { 5: zlib.deflateSync(Buffer.from(mutate(content, r), 'latin1')) })],
      ];
      for (const [name, mime, data] of cases) {
        const { d, ms } = timed(() => extractDoc(name, mime, data));
        sane(d, `${name} mutação ${i}`);
        slowest = Math.max(slowest, ms);
      }
    }
    assert.ok(slowest < 3000, `a mais lenta levou ${slowest} ms`);
  });
});

describe('leitura isolada num worker', () => {
  test('o resultado é o mesmo da leitura direta', async () => {
    const data = docx(p('Contrato de prestação de serviços'));
    assert.deepEqual(await readDocument('c.docx', '', data), extractDoc('c.docx', '', data));
  });

  test('passou do tempo: o worker é encerrado e a leitura volta como erro dito', async () => {
    const big = textPdf(Array.from({ length: 20_000 }, (_, i) => `Linha ${i} do relatorio com bastante texto para ler`));
    const d = await readDocument('grande.pdf', 'application/pdf', big, { timeoutMs: 5 });
    assert.equal(d.status, 'erro'); assert.match(d.detail!, /passou de \d+ s e foi interrompida/);
  });

  test('o leitor estoura a memória aos poucos, ou morre de repente: o servidor segue e a próxima leitura funciona', async () => {
    const data = docx(p('qualquer'));
    const oom = await readDocument('a.docx', '', data, { memMb: 64, timeoutMs: 60_000, workerUrl: new URL('./workers/oom-gradual.ts', import.meta.url) });
    assert.equal(oom.status, 'erro'); assert.match(oom.detail!, /memória demais/);
    const dead = await readDocument('b.docx', '', data, { workerUrl: new URL('./workers/morre.ts', import.meta.url) });
    assert.equal(dead.status, 'erro'); assert.match(dead.detail!, /parou sem resposta \(código 7\)/);
    assert.equal((await readDocument('ok.docx', '', docx(p('de volta')))).status, 'ok');
  });

  test('várias leituras ao mesmo tempo: todas voltam (no máximo duas rodando, as outras esperam a vez)', async () => {
    const all = await Promise.all(Array.from({ length: 6 }, (_, i) => readDocument(`d${i}.docx`, '', docx(p(`documento ${i}`)))));
    assert.deepEqual(all.map((d) => d.status), Array(6).fill('ok'));
    all.forEach((d, i) => assert.match(d.text, new RegExp(`documento ${i}`)));
  });
});

describe('financeiro e contratos: provável não é certo', () => {
  let n = 0;
  const L = (data: string, valor: number, descricao = 'lançamento'): Lancamento => ({ n: ++n, data, descricao, valor, documento: 'x', origem: 'planilha', confianca: 'alta' });

  test('entrada numa fonte e saída na outra, do mesmo valor: casa só depois, e fica dito como sinal trocado', () => {
    n = 0;
    const c = conferir('extrato', [L('2026-10-20', 1250, 'recebido de cliente')], 'controle', [L('2026-10-20', -1250, 'pago a fornecedor')]);
    assert.equal(c.casados, 1);
    assert.equal(c.sinalTrocado.length, 1);
    assert.match(conferenciaLines(c).join('\n'), /sinal trocado \(1\).*confira/);
  });

  test('o mesmo sinal tem preferência, mesmo com data mais distante', () => {
    n = 0;
    const c = conferir('A', [L('2026-10-20', -500)], 'B', [L('2026-10-20', 500), L('2026-10-22', -500)]);
    assert.equal(c.sinalTrocado.length, 0);
    assert.deepEqual(c.soB.map((l) => l.valor), [500]);
  });

  test('dois candidatos de mesmo valor na janela: casa um, e o casamento fica marcado como incerto', () => {
    n = 0;
    const c = conferir('A', [L('2026-10-20', -100)], 'B', [L('2026-10-19', -100), L('2026-10-21', -100)]);
    assert.equal(c.casados, 1); assert.equal(c.ambiguos.length, 1); assert.equal(c.soB.length, 1);
    const text = conferenciaLines(c).join('\n');
    assert.match(text, /Casamentos incertos \(1\).*confira qual é qual/);
    assert.match(text, /prováveis, não comprovados/);
    assert.doesNotMatch(text, /Conferidos/, 'casar por valor e data não é "conferir"');
  });

  test('lista longa não some calada: diz quantas ficaram de fora da conversa e onde estão', () => {
    n = 0;
    const A = Array.from({ length: 30 }, (_, i) => L(`2026-09-${String(i + 1).padStart(2, '0')}`, -(i + 1)));
    assert.match(conferenciaLines(conferir('A', A, 'B', [L('2026-01-01', -9999)])).join('\n'), /… e mais 5 \(lista inteira no CSV da conferência\)/);
  });

  test('contrato com 60 parcelas: todas as datas são lidas (antes, as 40 primeiras — as futuras sumiam caladas)', () => {
    const text = Array.from({ length: 60 }, (_, i) => { const d = new Date(Date.UTC(2026, i, 5)); return `A parcela ${i + 1} vence em ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}.`; }).join(' ');
    const ob = obrigacoesOf('Financiamento', 'C1', text);
    assert.equal(ob.length, 60);
    assert.equal(ob.at(-1)!.data, '2030-12-05');
  });
});
