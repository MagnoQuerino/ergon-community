/**
 * Leitura de documentos pelo Ergon (sem dependências): Word, Excel, PowerPoint, PDF (texto simples e com tabela
 * ToUnicode), NF-e, OFX, CSV; a análise determinística das planilhas; a conferência entre duas fontes; as datas dos
 * contratos; as notícias (RSS/Atom, sem endereços internos); e as conferências novas do contrato de evidência
 * (números, links, trechos, datas sugeridas).
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { describe, test } from 'node:test';
import { readZip, writeZip } from '../src/lib/zip.ts';
import { docx, p, pdf, xlsx } from './doc-fixtures.ts';
import { withoutQuoted } from '../src/services/account-reader.ts';
import { extractDoc } from '../src/services/doc-text.ts';
import { conferir, lancamentosOf, obrigacoesOf, sheetLancamentos } from '../src/services/fin-parse.ts';
import { buildPptx, slidesFromMarkdown } from '../src/services/pptx.ts';
import { parseCategories, parseTaskProposals } from '../src/services/proposals.ts';
import { searchTerms } from '../src/services/routine-sources.ts';
import { checkRun, cleanParams, numbersIn } from '../src/services/routines.ts';
import { templateByKey } from '../src/services/routine-catalog.ts';
import { analyzeSheet, statsCsv, statsLines } from '../src/services/table-stats.ts';
import { checkUrl, parseFeed, privateAddress, readFeeds } from '../src/services/web-feeds.ts';

describe('documentos lidos pelo Ergon', () => {
  test('ZIP: grava e lê de volta; recusa o que não é ZIP', () => {
    const z = readZip(writeZip([{ name: 'a.txt', data: 'olá' }, { name: 'pasta/b.xml', data: '<x/>' }]));
    assert.equal(z.get('a.txt')!.read().toString('utf8'), 'olá');
    assert.equal(z.get('pasta/b.xml')!.read().toString('utf8'), '<x/>');
    assert.throws(() => readZip(Buffer.from('não é zip nenhum, só texto')));
  });

  test('Word: parágrafos, tabela em " | ", entidades; texto apagado no controle de alterações não entra', () => {
    const d = extractDoc('contrato.docx', '', docx(`${p('Cláusula 1 — Objeto &amp; prazo')}${p('Vigência até 31/12/2026.')}<w:p><w:r><w:delText>texto apagado</w:delText></w:r></w:p><w:tbl><w:tr><w:tc>${p('Item')}</w:tc><w:tc>${p('Valor')}</w:tc></w:tr></w:tbl>`));
    assert.equal(d.status, 'ok'); assert.equal(d.kind, 'texto');
    assert.match(d.text, /Cláusula 1 — Objeto & prazo/);
    assert.match(d.text, /Vigência até 31\/12\/2026\./);
    assert.ok(!d.text.includes('texto apagado'));
    assert.match(d.text, /Item[\s|]*Valor/);
  });

  test('Excel: textos compartilhados, números e datas (formato de data vira AAAA-MM-DD)', () => {
    const d = extractDoc('vendas.xlsx', '', xlsx([['Data', 'Cliente', 'Valor'], [{ date: 46000 }, 'Acme', 1500.5], [{ date: 46031 }, 'Beta', 980]]));
    assert.equal(d.status, 'ok'); assert.equal(d.kind, 'planilha');
    assert.equal(d.sheets![0].name, 'Vendas');
    assert.deepEqual(d.sheets![0].rows[0], ['Data', 'Cliente', 'Valor']);
    assert.equal(d.sheets![0].rows[1][0], '2025-12-09');
    assert.equal(d.sheets![0].rows[1][2], '1500.5');
  });

  test('PowerPoint: o que o Ergon gera abre de volta, slide a slide', () => {
    const deck = slidesFromMarkdown('# Resultados\n## Principais números\n- Receita de R$ 10,00\n- Margem 12%\n## Próximos passos\n1. Renegociar');
    assert.equal(deck.title, 'Resultados'); assert.equal(deck.slides.length, 2);
    const buf = buildPptx({ title: deck.title, subtitle: 'Ergon', slides: [...deck.slides, { title: 'Por mês', bullets: [], chart: { title: 'contado pelo Ergon', labels: ['09/26', '10/26'], values: [100, 120] } }] });
    const z = readZip(buf);
    for (const part of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide4.xml']) assert.ok(z.has(part), part);
    const d = extractDoc('apresentacao.pptx', '', buf);
    assert.equal(d.status, 'ok'); assert.equal(d.pages, 4);
    assert.match(d.text, /\[Slide 2\][\s\S]*Principais números[\s\S]*Receita de R\$ 10,00/);
    assert.match(d.text, /Por mês[\s\S]*120/);
  });

  test('PDF: texto de fonte simples (acentos WinAnsi) e de fonte composta com ToUnicode; digitalizado e protegido são ditos', () => {
    const content = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Contrato de presta\\347\\343o de servi\\347os) Tj 0 -14 Td (Vig\\352ncia at\\351 31/12/2026) Tj ET\nBT /F2 12 Tf 72 690 Td <000100020003> Tj ET', 'latin1'));
    const cmap = Buffer.from('/CIDInit /ProcSet findresource begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n2 beginbfchar\n<0001> <004F>\n<0002> <006C>\nendbfchar\n1 beginbfrange\n<0003> <0003> <00E1>\nendbfrange\nendcmap', 'latin1');
    const buf = pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Length LEN /Filter /FlateDecode >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /Calibri /Encoding /Identity-H /ToUnicode 7 0 R >>',
      '<< /Length LEN >>',
    ], { 5: content, 7: cmap });
    const d = extractDoc('contrato.pdf', 'application/pdf', buf);
    assert.equal(d.status, 'ok', d.detail); assert.equal(d.pages, 1);
    assert.match(d.text, /Contrato de prestação de serviços/);
    assert.match(d.text, /Vigência até 31\/12\/2026/);
    assert.match(d.text, /Olá/);
    const scan = pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', '<< /Length LEN >>'], { 4: Buffer.from('q 100 0 0 100 0 0 cm /Im1 Do Q') });
    assert.equal(extractDoc('scan.pdf', 'application/pdf', scan).status, 'sem_texto');
    assert.equal(extractDoc('x.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj')).status, 'erro');
    assert.equal(extractDoc('velho.doc', '', Buffer.from('x')).status, 'nao_suportado');
  });

  test('legenda (.vtt) vira a fala, sem carimbos de tempo', () => {
    const d = extractDoc('reuniao.vtt', 'text/vtt', Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nCarla: vamos fechar com o fornecedor X.\n\n2\n00:00:05.000 --> 00:00:07.000\nHeródoto revisa o contrato até sexta.'));
    assert.equal(d.text, 'Carla: vamos fechar com o fornecedor X.\nHeródoto revisa o contrato até sexta.');
  });
});

describe('análise de planilha pelo Ergon', () => {
  const rows = [['Data', 'Categoria', 'Valor'],
    ...Array.from({ length: 12 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, i % 2 ? 'Serviços' : 'Produtos', '100,00']),
    ['2026-10-01', 'Produtos', '90,00'], ['2026-10-02', 'Serviços', '5.000,00'], ['2026-10-02', 'Serviços', '5.000,00']];
  const st = analyzeSheet({ name: 'vendas', rows });

  test('tipos, totais, mês a mês com variação, categorias, fora da curva e repetidas', () => {
    const v = st.columns.find((c) => c.name === 'Valor')!;
    assert.equal(v.type, 'numero'); assert.equal(v.sum, 11290); assert.equal(v.max, 5000);
    assert.equal(st.columns.find((c) => c.name === 'Data')!.type, 'data');
    assert.deepEqual(st.byPeriod!.periods.map((x) => [x.period, x.total]), [['2026-09', 1200], ['2026-10', 10090]]);
    assert.equal(st.byPeriod!.variation, 740.83);
    assert.equal(st.byCategory!.groups[0].name, 'Serviços');
    assert.deepEqual(v.outliers!.map((o) => o.row), [15, 16]);
    assert.deepEqual(st.duplicates, [16]);
    const lines = statsLines(st).join('\n');
    assert.match(lines, /total 11\.290/); assert.match(lines, /\+740,8%/);
    assert.match(statsCsv([st]), /total;Valor;11290/);
  });
});

describe('financeiro: lançamentos, conferência e contratos', () => {
  const nfe = `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe35"><ide><nNF>1234</nNF><dhEmi>2026-10-20T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000144</CNPJ><xNome>Fornecedor Alfa Ltda</xNome></emit><dest><xNome>Vértice Lab</xNome></dest>
    <det nItem="1"><prod><xProd>Coluna C18</xProd></prod></det><total><ICMSTot><vNF>2500.00</vNF></ICMSTot></total>
    <cobr><dup><nDup>001</nDup><dVenc>2026-11-20</dVenc><vDup>1250.00</vDup></dup><dup><nDup>002</nDup><dVenc>2026-12-20</dVenc><vDup>1250.00</vDup></dup></cobr></infNFe></NFe></nfeProc>`;
  const ofx = 'OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261021120000[-3:BRT]<TRNAMT>-1250.00<FITID>a1<MEMO>PAG BOLETO FORNECEDOR ALFA\n</STMTTRN>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261022<TRNAMT>3400.00<FITID>a2<MEMO>TED CLIENTE BETA\n</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261023<TRNAMT>-35.90<FITID>a3<MEMO>TARIFA\n</STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';

  test('NF-e com parcelas, extrato OFX e planilha viram lançamentos com valor e data do documento', () => {
    const a = lancamentosOf(extractDoc('nfe.xml', 'application/xml', Buffer.from(nfe)));
    assert.equal(a.length, 2);
    assert.deepEqual([a[0].valor, a[0].vencimento, a[0].origem, a[0].confianca], [-1250, '2026-11-20', 'nfe', 'alta']);
    assert.match(a[0].descricao, /NF-e 1234 Fornecedor Alfa Ltda — Coluna C18/);
    const b = lancamentosOf(extractDoc('extrato.ofx', '', Buffer.from(ofx)), 3);
    assert.deepEqual(b.map((l) => [l.n, l.data, l.valor]), [[3, '2026-10-21', -1250], [4, '2026-10-22', 3400], [5, '2026-10-23', -35.9]]);
    const c = sheetLancamentos({ name: 'controle', rows: [['Data', 'Histórico', 'Débito', 'Crédito'], ['21/10/2026', 'Fornecedor Alfa', '1.250,00', ''], ['22/10/2026', 'Cliente Beta', '', '3.040,00']] }, 'controle.csv');
    assert.deepEqual(c.map((l) => [l.data, l.valor, l.descricao]), [['2026-10-21', -1250, 'Fornecedor Alfa'], ['2026-10-22', 3040, 'Cliente Beta']]);
  });

  test('conferência: casa por valor e data (±3 dias), separa o que só existe numa fonte e os valores diferentes', () => {
    const A = lancamentosOf(extractDoc('extrato.ofx', '', Buffer.from(ofx)));
    const B = sheetLancamentos({ name: 'controle', rows: [['Data', 'Histórico', 'Valor'], ['20/10/2026', 'Fornecedor Alfa', '-1.250,00'], ['22/10/2026', 'Cliente Beta', '3.380,00'], ['25/10/2026', 'Aluguel', '-2.000,00']] }, 'controle.csv');
    const r = conferir('extrato.ofx', A, 'controle.csv', B);
    assert.equal(r.casados, 1);
    assert.deepEqual(r.soA.map((l) => l.valor), [-35.9]);
    assert.deepEqual(r.soB.map((l) => l.valor), [-2000]);
    assert.deepEqual(r.valorDiferente.map((d) => d.diff), [20]);
  });

  test('contrato: datas com o tipo pelas palavras em volta, fim pela duração, prazo do aviso prévio e renovação automática', () => {
    const text = 'Assinado em 10/11/2025. O presente contrato terá prazo de 12 (doze) meses a contar da assinatura, com renovação automática por iguais períodos, salvo aviso prévio de 30 (trinta) dias. O valor será reajustado pelo IGP-M em 01 de março de 2026.';
    const ob = obrigacoesOf('Contrato Acme', 'C1', text);
    const by = (t: string) => ob.filter((o) => o.tipo === t).map((o) => o.data);
    assert.deepEqual(by('assinatura'), ['2025-11-10']);
    assert.ok(by('fim').includes('2026-11-10'), JSON.stringify(ob));
    assert.deepEqual(by('aviso'), ['2026-10-11']);
    assert.ok(by('renovacao').includes('2026-11-10'));
    assert.deepEqual(by('reajuste'), ['2026-03-01']);
    assert.ok(ob.every((o, i) => o.code === `C1.${i + 1}`));
  });
});

describe('fontes públicas (radares)', () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Google Notícias</title>
    <item><title>Agilent lança coluna para PFAS - Valor</title><link>https://news.google.com/a1</link><pubDate>${new Date(Date.now() - 3600_000).toUTCString()}</pubDate><source>Valor</source><description>&lt;a&gt;Coluna nova&lt;/a&gt;</description></item>
    <item><title>Antiga demais</title><link>https://news.google.com/a0</link><pubDate>${new Date(Date.now() - 30 * 86_400_000).toUTCString()}</pubDate></item>
    <item><title>Link perigoso</title><link>https://x.com/]]oi</link></item>
    <item><title>Agilent lança coluna para PFAS - Folha</title><link>https://news.google.com/a2</link><pubDate>${new Date().toUTCString()}</pubDate></item>
  </channel></rss>`;
  const atom = '<feed><title>Blog X</title><entry><title>Parceria nova</title><link href="https://x.com/p1"/><published>2026-10-24T10:00:00Z</published><summary>com a Universidade Z</summary></entry></feed>';

  test('RSS e Atom: título, fonte, data e link; links com colchetes não entram', () => {
    const items = parseFeed(rss, 'busca');
    assert.ok(!items.some((i) => i.link.includes(']]')));
    assert.equal(items[0].source, 'Valor'); assert.equal(items[0].summary, 'Coluna nova');
    assert.deepEqual(parseFeed(atom, 'x').map((i) => [i.title, i.link, i.source]), [['Parceria nova', 'https://x.com/p1', 'Blog X']]);
  });

  test('só https e nunca endereços internos (rede local, nuvem, localhost)', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(privateAddress(ip), ip);
    for (const ip of ['8.8.8.8', '142.250.0.1', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
    const lookup = async (h: string) => (h === 'interno.exemplo' ? ['10.0.0.8'] : ['93.184.216.34']);
    await assert.rejects(checkUrl('http://site.com/feed', lookup), /https/);
    await assert.rejects(checkUrl('https://localhost/feed', lookup), /interno/);
    await assert.rejects(checkUrl('https://interno.exemplo/feed', lookup), /interno/);
    await assert.rejects(checkUrl('https://user:pass@site.com/', lookup), /usuário/);
    await assert.rejects(checkUrl('https://site.com:8443/', lookup), /porta/);
    assert.equal((await checkUrl('https://site.com/feed', lookup)).hostname, 'site.com');
  });

  test('leitura: só o que é novo desde a última vez, repetidas uma vez só, cada fonte registrada', async () => {
    const r = await readFeeds([{ label: 'Agilent', url: 'https://news.google.com/rss/search?q=agilent' }, { label: 'quebrado', url: 'https://x.com/feed' }],
      new Date(Date.now() - 7 * 86_400_000).toISOString(), { fetcher: async (u) => { if (u.includes('x.com')) throw new Error('falhou'); return rss; } });
    assert.deepEqual(r.items.map((i) => i.link), ['https://news.google.com/a1'], 'a mesma notícia em outra fonte conta uma vez; a de 30 dias atrás fica de fora');
    assert.deepEqual(r.reads.map((x) => [x.label, x.status]), [['Agilent', 'ok'], ['quebrado', 'erro']]);
  });
});

describe('contrato de evidência: números, links, trechos e datas sugeridas', () => {
  const base = { when: 'segunda, 26/10 às 08:00', mode: 'real' as const, reads: [], warnings: [], panel: '', delivered: true, fileWanted: false, fileOk: true };
  const facts = '- Coluna "Valor" (números, 12): total 11.290 · média 940,83 · máximo 5.000\n- Variação do último mês: +740,8% (de 1.200 para 10.090)\n- N1 · 25/10 · Agilent lança coluna · https://news.google.com/a1\n- §D1.3 A entrega é em 30 dias.';

  test('números: os dos dados (com arredondamento) valem; inventados reprovam; contagens pequenas e anos não contam', () => {
    assert.deepEqual(numbersIn('Em 2026 foram 3 itens; total de R$ 11.290,00 e 740,8%.').map((n) => n.value), [11290, 740.8]);
    const ok = checkRun({ ...base, facts, text: 'Total de 11.290; média 941; subiu 741% (de 1.200 para 10.090). Em 2026, 3 pontos.', extra: ['numeros'] });
    assert.equal(ok.verdict, 'validado', JSON.stringify(ok.criteria));
    const bad = checkRun({ ...base, facts, text: 'Total de 12.500 e margem de 18,5%.', extra: ['numeros'] });
    assert.equal(bad.verdict, 'reprovado');
    assert.match(bad.criteria.find((c) => c.id === 'numeros')!.detail!, /12\.500, 18,5%/);
  });

  test('links e trechos citados têm de existir nas fontes e no documento', () => {
    const k = checkRun({ ...base, facts, text: 'N1 Agilent (https://news.google.com/a1). Ver §D1.3 e §D1.9. Mais em https://inventado.com/x.', extra: ['links', 'trechos'] });
    assert.equal(k.verdict, 'reprovado');
    assert.match(k.criteria.find((c) => c.id === 'links')!.detail!, /inventado/);
    assert.match(k.criteria.find((c) => c.id === 'trechos')!.detail!, /§D1\.9/);
    assert.ok(!k.criteria.find((c) => c.id === 'trechos')!.detail!.includes('D1.3'));
  });

  test('códigos citados (E3, N2, C1.4) existem nos dados; letra que a rotina não usa é ignorada', () => {
    const k = checkRun({ ...base, facts, text: 'N1 e N7 são relevantes; o modelo Q5 não é deste caso.' });
    assert.match(k.criteria.find((c) => c.id === 'referencias')!.detail!, /^não existem: N7$/);
  });

  test('níveis: o que a conferência prova e o que não prova (análise nunca; leitura parcial; revisão humana)', () => {
    const k = checkRun({ ...base, facts, text: 'N1 Agilent.', extra: ['numeros'], humanReview: true,
      reads: [{ account: 'microsoft', what: 'tarefas', status: 'ok', label: 'eu', count: 500, ms: 10, truncated: true }] });
    assert.deepEqual(k.levels, { coleta: 'parcial', citacoes: 'conferidas', numeros: 'conferidos', cobertura: 'nao_se_aplica', analise: 'nao_verificada', humano: 'revisao_necessaria' });
    assert.equal(k.criteria.find((c) => c.id === 'fontes')!.ok, false, 'lida em parte não é lida por inteiro');
    assert.equal(k.verdict, 'parcial');
  });

  test('rotina que planeja: datas novas são sugestões (não reprovam), e isso fica dito', () => {
    const k = checkRun({ ...base, facts, text: 'Marco 1 em 15/11, revisão às 14:00.', freeDates: true });
    assert.equal(k.verdict, 'validado');
    assert.match(k.criteria.find((c) => c.id === 'datas')!.detail!, /15\/11, 14:00/);
    assert.equal(checkRun({ ...base, facts, text: 'Marco 1 em 15/11.' }).verdict, 'reprovado');
  });
});

describe('peças das rotinas', () => {
  test('propostas de tarefa e categorias na resposta; prazos fora do formato caem', () => {
    const t = parseTaskProposals('Plano.\n[[propor-tarefa titulo="Gravar aulas" responsavel="Fídias" prazo="2026-11-21" detalhe="3 aulas" origem="pedido"]]\n[[propor-tarefa titulo="Revisar roteiro" responsavel="você" prazo="sexta"]]\n[[propor-tarefa responsavel="x"]]', 'Planejador');
    assert.deepEqual(t.map((x) => x.kind === 'task' && [x.title, x.assignee, x.due]), [['Gravar aulas', 'Fídias', '2026-11-21'], ['Revisar roteiro', null, null]]);
    const c = parseCategories('[[categoria lancamento="L3" categoria="Fornecedores" centro="Lab"]] [[categoria lancamento="x" categoria="y"]]');
    assert.deepEqual([...c], [[3, { categoria: 'Fornecedores', centro: 'Lab' }]]);
  });

  test('parâmetros limpos: listas, só https, arquivos com id válido', () => {
    const t = templateByKey('radar-noticias');
    assert.deepEqual(cleanParams(t, { termos: 'cromatografia; Agilent ;; ', feeds: ['http://x.com/rss', 'https://y.com/rss', 'javascript:alert(1)'], outro: ['x'] }),
      { termos: ['cromatografia', 'Agilent'], feeds: ['https://y.com/rss'] });
    const g = templateByKey('guardiao-contratos');
    assert.deepEqual(cleanParams(g, { contratos: [{ kind: 'ergon', id: `art_${'a'.repeat(32)}`, name: 'c.pdf' }, { kind: 'ergon', id: '../etc/passwd' }, { kind: 'dropbox', id: 'abcd' }] }).contratos,
      [{ kind: 'ergon', id: `art_${'a'.repeat(32)}`, name: 'c.pdf' }]);
  });

  test('e-mail sem o histórico citado; palavras de busca sem as vazias', () => {
    assert.equal(withoutQuoted('Oi, segue o cronograma.\n\nEm seg., 20 de out. de 2026 às 10:00, Fulano <f@x.com> escreveu:\n> pode mandar?'), 'Oi, segue o cronograma.');
    assert.deepEqual(searchTerms('Quero o histórico do projeto "curso de cromatografia" com a Acme'), ['curso de cromatografia', 'historico', 'acme']);
  });
});
