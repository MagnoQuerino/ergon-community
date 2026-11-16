/**
 * Arquivos que a pessoa pede (QA de 15/11): "crie uma planilha" terminava num .md, ou travava pedindo um anexo, e o agente
 * prometia o Excel. O Ergon gera xlsx, csv, pptx, pdf e docx a partir do texto do agente — na conversa
 * ([[salvar-documento]]) e na entrega do card (pelo pedido ou pela linha do agente).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setSetting } from '../src/services/sectors.ts';
import { readZip } from '../src/lib/zip.ts';
import { formulaOf, markdownToCsv, markdownToXlsx, numberOf, sheetsFromMarkdown } from '../src/lib/xlsx.ts';
import { markdownToPdf, pdfSafe } from '../src/lib/pdf.ts';
import { formatoDoDocumento, formatosPedidos, pedeParaCriarArquivo } from '../src/services/documents.ts';
import { drain, harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

const PLANILHA = `## Despesas de novembro
| Data | Categoria | Valor |
|---|---|---|
| 01/11 | Aluguel | R$ 2.500,00 |
| 05/11 | Energia | R$ 380,50 |
| 10/11 | Aluguel | 1.000 |
| | **Total** | =SOMA(C2:C4) |
| | Só aluguel | =SOMASE(B2:B4;"Aluguel";C2:C4) |

## Resumo
| Categoria | Total |
|---|---|
| Aluguel | =SOMASE('Despesas de novembro'!B2:B4;"Aluguel";'Despesas de novembro'!C2:C4) |`;

const sheetXml = (buf: Buffer, n = 1) => readZip(buf).get(`xl/worksheets/sheet${n}.xml`)!.read().toString('utf8');

describe('geradores de arquivo (sem Executar código)', () => {
  test('números no jeito brasileiro viram números; códigos e textos ficam texto', () => {
    assert.deepEqual(numberOf('R$ 1.250,00'), { value: 1250, percent: false, money: true });
    assert.deepEqual(numberOf('-R$ 30'), { value: -30, percent: false, money: true });
    assert.equal(numberOf('12,5%')!.value, 0.125);
    assert.equal(numberOf('1250.5')!.value, 1250.5);
    assert.equal(numberOf('01310-100'), null, 'CEP é texto');
    assert.equal(numberOf('0123'), null, 'código com zero à esquerda é texto');
    assert.equal(numberOf('Aluguel'), null);
  });
  test('fórmulas em português viram as do Excel; as que buscam fora ficam texto', () => {
    assert.equal(formulaOf('=SOMA(B2:B9;C2)'), 'SUM(B2:B9,C2)');
    assert.equal(formulaOf('=SOMASE(A:A;"Aluguel; casa";B:B)'), 'SUMIF(A:A,"Aluguel; casa",B:B)', 'o ";" entre aspas fica');
    assert.equal(formulaOf('=MÉDIA(B2:B4)*1,5'), 'AVERAGE(B2:B4)*1.5');
    assert.equal(formulaOf('=HYPERLINK("http://x";"clique")'), null);
    assert.equal(formulaOf('=WEBSERVICE("http://x")'), null);
    assert.equal(formulaOf('=cmd|\' /C calc\'!A0'), null, 'DDE');
  });
  test('cada tabela vira uma aba com o título acima; fórmulas e dinheiro no XML', () => {
    const sheets = sheetsFromMarkdown(PLANILHA, 'Despesas');
    assert.deepEqual(sheets.map((s) => s.name), ['Despesas de novembro', 'Resumo']);
    const buf = markdownToXlsx(PLANILHA, 'Despesas');
    const files = readZip(buf);
    assert.ok(files.has('[Content_Types].xml') && files.has('xl/workbook.xml') && files.has('xl/styles.xml'));
    const xml = sheetXml(buf);
    assert.match(xml, /<c r="C2" s="2"><v>2500<\/v><\/c>/);
    assert.match(xml, /<f>SUM\(C2:C4\)<\/f>/);
    assert.match(xml, /<f>SUMIF\(B2:B4,&quot;Aluguel&quot;,C2:C4\)<\/f>/);
    assert.match(files.get('xl/workbook.xml')!.read().toString(), /fullCalcOnLoad="1"/, 'o Excel recalcula ao abrir');
  });
  test('sem tabela, o texto vira linhas; CSV com ";" e BOM, sem fórmula executável', () => {
    assert.deepEqual(sheetsFromMarkdown('# Lista\n- pão\n- café', 'Compras')[0].rows, [['Lista'], ['pão'], ['café']]);
    const csv = markdownToCsv(PLANILHA, 'x').toString('utf8');
    assert.ok(csv.startsWith('﻿Data;Categoria;Valor\r\n'));
    assert.match(csv, /;Total;'=SOMA\(C2:C4\)/, 'fórmula no CSV vira texto (injeção em planilha)');
  });
  test('PDF: arquivo válido, acentos e caracteres fora da fonte trocados', () => {
    const pdf = markdownToPdf('# Contrato\n\nCláusula **primeira** → prazo de 30 dias 😀\n\n| a | b |\n|---|---|\n| 1 | 2 |', 'Contrato');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.subarray(-8).toString(), /%%EOF/);
    assert.equal(pdfSafe('ação → ok 😀'), 'ação -> ok ');
  });
  test('formato pedido: pelo nome do formato e pelas palavras do pedido', () => {
    assert.equal(formatoDoDocumento('Excel'), 'xlsx'); assert.equal(formatoDoDocumento('apresentação'), 'pptx'); assert.equal(formatoDoDocumento(''), 'docx');
    assert.equal(formatoDoDocumento('xyz'), null);
    assert.deepEqual(formatosPedidos('Crie uma planilha de controle de despesas. Quero o arquivo Excel.'), ['xlsx']);
    assert.deepEqual(formatosPedidos('Monte uma apresentação de 6 slides sobre café'), ['pptx']);
    assert.deepEqual(formatosPedidos('Escreva um contrato e salve como Word e PDF'), ['pdf', 'docx']);
    assert.ok(pedeParaCriarArquivo('Crie uma planilha de despesas'));
    assert.ok(!pedeParaCriarArquivo('Analise esta planilha de tarefas e faça o relatório'), 'ler a planilha da pessoa continua pedindo o anexo');
    assert.ok(!pedeParaCriarArquivo('Qual o total desta planilha?'));
  });
});

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 40)}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `sess-${p.sessionKey.slice(-12)}`, usage: { inputTokens: 900, outputTokens: 120, costUsd: null }, model: 'nous/teste-1' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

describe('a planilha pedida sai como planilha', () => {
  let h: Harness; let s: Session; let motor: Motor;
  const agentId = (key: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, key)!.id;
  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, dir: tmpDir() });
    s = await setupOwner(h);
    setSetting(h.db, s.workspaceId, 'team.persist', '0');
  });
  after(async () => { await h.close(); });

  test('na conversa: [[salvar-documento formato="xlsx"]] guarda um .xlsx de verdade; formato desconhecido é dito', async () => {
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agentId('arquimedes') })).json.id as string;
    motor.reply = () => `Vou salvar a planilha.\n\n${PLANILHA}\n\n[[salvar-documento nome="Controle de despesas" formato="xlsx"]]`;
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Crie uma planilha de despesas, quero o Excel', clientRequestId: 'req-xlsx-0001' });
    await drain(h, 4);
    const art = h.db.get<{ id: string; mime: string }>("SELECT id, mime FROM artifacts WHERE filename = 'Controle de despesas.xlsx'");
    assert.ok(art, 'o .xlsx foi guardado');
    assert.equal(art!.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const dl = await req(h, 'GET', `/api/artifacts/${art!.id}/download`, s);
    assert.match(sheetXml(dl.res.rawPayload), /<f>SUM\(C2:C4\)<\/f>/);
    const ins = motor.started.at(-1)!.instructions;
    assert.match(ins, /xlsx \(Excel: cada tabela Markdown/, 'o agente sabe que o Ergon gera a planilha');
    assert.match(ins, /não peça Executar código nem Terminal para isso/);
    motor.reply = () => 'Pronto. [[salvar-documento nome="x" formato="odt"]]';
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'agora em odt', clientRequestId: 'req-xlsx-0002' });
    await drain(h, 4);
    const notes = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content);
    assert.ok(notes.some((n: string) => /Não sei salvar no formato “odt”/.test(n)), notes.join('\n'));
    assert.equal(h.db.get("SELECT 1 AS x FROM artifacts WHERE filename LIKE 'x.%'"), undefined, 'formato desconhecido não vira Word em silêncio');
  });

  test('planilha anexada na conversa: o agente calcula ali; [[processar]] (só de card) é avisado, não fica na promessa', async () => {
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agentId('arquimedes') })).json.id as string;
    motor.reply = () => 'Vou calcular pelo arquivo.\n\n[[processar operacao="analise-desempenho" arquivo="estoque.csv" referencia="2026-11-16"]]';
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'O que preciso comprar para 7 dias?', clientRequestId: 'req-proc-0001' });
    await drain(h, 4);
    const ins = motor.started.at(-1)!.instructions;
    assert.match(ins, /faça a conta você mesmo, nesta resposta/);
    assert.doesNotMatch(ins, /peça numa linha assim: \[\[processar/, 'na conversa o comando de card não é oferecido');
    const notes = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content);
    assert.ok(notes.some((n: string) => /pediu um cálculo que só roda num card, e ele não foi feito aqui/.test(n)), notes.join('\n'));
  });

  test('conversa direta: "conferência do Euclides" sem o Euclides ter participado é desmentida na conversa', async () => {
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agentId('arquimedes') })).json.id as string;
    motor.reply = () => 'Entradas R$ 10.480,00, saídas R$ 4.850,00, saldo R$ 5.630,00. Confirmei com a conferência do Euclides: tudo certo.';
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Monte a prestação de contas de outubro', clientRequestId: 'req-conf-0001' });
    await drain(h, 4);
    const notes = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content);
    assert.ok(notes.some((n: string) => /Euclides não participou desta resposta/.test(n)), notes.join('\n'));
    assert.match(motor.started.at(-1)!.instructions, /Nunca diga que um colega conferiu, revisou ou validou/);
    const c2 = (await req(h, 'POST', '/api/conversations', s, { agentId: agentId('arquimedes') })).json.id as string;
    motor.reply = () => 'Conferi as somas duas vezes: entradas R$ 10.480,00 e saídas R$ 4.850,00.';
    await req(h, 'POST', `/api/conversations/${c2}/messages`, s, { text: 'Some de novo', clientRequestId: 'req-conf-0002' });
    await drain(h, 4);
    const n2 = (await req(h, 'GET', `/api/conversations/${c2}/messages`, s)).json.filter((m: { role: string; content: string }) => m.role === 'system' && /não participou/.test(m.content));
    assert.equal(n2.length, 0, 'o que o próprio agente conferiu não é desmentido');
  });

  test('no card: "crie uma planilha" não pede anexo e a entrega vem também em .xlsx', async () => {
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Crie uma planilha de controle de despesas mensais com categorias, valores e total por categoria. Quero o arquivo Excel.', description: '', agentId: agentId('arquimedes') })).json;
    motor.reply = () => `Segue a planilha de controle de despesas mensais, com as categorias, os valores lançados e o total por categoria calculado por fórmula.\n\n${PLANILHA}`;
    const r = await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.ok(r.json.runId, 'foi trabalhar (antes: "nada foi anexado ao card")');
    await drain(h, 4);
    const d = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    const xlsx = d.files.deliverables.find((f: { filename: string }) => f.filename.endsWith('.xlsx'));
    assert.ok(xlsx, JSON.stringify(d.files.deliverables.map((f: { filename: string }) => f.filename)));
    const dl = await req(h, 'GET', `/api/artifacts/${xlsx.id}/download`, s);
    assert.match(sheetXml(dl.res.rawPayload), /<c r="C2" s="2"><v>2500<\/v><\/c>/);
    assert.match(motor.started.at(-1)!.instructions, /Arquivos na entrega: quando o pedido é uma planilha/);
  });
});
