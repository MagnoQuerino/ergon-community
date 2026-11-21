/**
 * Escritório completo (rc.42): Drive e OneDrive — pasta, mover, renomear, copiar, editar Documento/Word e Planilha/Excel
 * que já existem, comentar, compartilhar (fora do domínio pede aprovação, salvo "Liberar tudo"), lixeira e apagar de vez
 * (sempre-protegida). Contra APIs falsas fiéis ao contrato (o estado muda de verdade e a leitura confere), e o Word/Excel
 * editados aqui abrem no leitor de documentos do Ergon com o texto novo.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { markdownToDocx } from '../src/lib/docx.ts';
import { acrescentarNoDocx, escreverNoCsv, escreverNoXlsx, trocarNoDocx, valoresDe } from '../src/lib/office-editar.ts';
import { markdownToXlsx } from '../src/lib/xlsx.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { extractDoc } from '../src/services/doc-text.ts';
import { ACOES_GOOGLE, ESCOPOS_GOOGLE } from '../src/services/conexoes/acoes/google.ts';
import { ESCOPO_DRIVE_TUDO } from '../src/services/conexoes/acoes/escritorio-google.ts';
import { ACOES_MICROSOFT } from '../src/services/conexoes/acoes/microsoft.ts';
import type { Args, CtxAcao, Http } from '../src/services/conexoes/tipos.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('editar Word, Excel e CSV que já existem', () => {
  test('Word: troca dentro de um trecho, troca que atravessa trechos e parágrafos no fim', () => {
    const doc = markdownToDocx('# Proposta\n\nValor total: R$ 1.000\n\nPrazo: **30** dias', 'Proposta');
    const t1 = trocarNoDocx(doc, 'R$ 1.000', 'R$ 1.250');
    assert.equal(t1.vezes, 1);
    const t2 = trocarNoDocx(t1.data, 'Prazo: 30', 'Prazo: 45'); // "30" está em negrito: outro trecho
    assert.equal(t2.vezes, 1);
    const fim = acrescentarNoDocx(t2.data, 'Assinado por: Ana\nData: 21/11');
    const lido = extractDoc('p.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fim);
    assert.equal(lido.status, 'ok');
    assert.match(lido.text, /R\$ 1\.250/); assert.match(lido.text, /Prazo: 45 dias/); assert.match(lido.text, /Assinado por: Ana[\s\S]*Data: 21\/11/);
    assert.ok(!lido.text.includes('1.000'));
    assert.equal(trocarNoDocx(doc, 'não existe', 'x').vezes, 0);
    assert.match(extractDoc('p.docx', '', acrescentarNoDocx(doc, 'a <b> & "c"')).text, /a <b> & "c"/, 'caracteres do XML escapados');
  });
  test('Excel: escreve números, textos e fórmulas, mantendo o resto da aba', () => {
    const x = markdownToXlsx('| Item | Valor |\n|---|---|\n| Aluguel | 1000 |\n| Luz | 200 |', 'Contas');
    const r = escreverNoXlsx(x, undefined, 'B3', [['250'], ['=B2+B3']]);
    assert.equal(r.intervalo, 'B3:B4');
    const lido = extractDoc('c.xlsx', '', r.data);
    assert.equal(lido.status, 'ok');
    const linhas = lido.sheets![0].rows;
    assert.deepEqual(linhas[0], ['Item', 'Valor']);
    assert.deepEqual(linhas[1], ['Aluguel', '1000']);
    assert.deepEqual(linhas[2].slice(0, 2), ['Luz', '250']);
    const novo = escreverNoXlsx(r.data, undefined, 'D10', [['nota', 'ok']]);
    assert.deepEqual(extractDoc('c.xlsx', '', novo.data).sheets![0].rows.find((l) => l.includes('nota'))?.filter(Boolean), ['nota', 'ok']);
    assert.throws(() => escreverNoXlsx(x, 'Inexistente', 'A1', [['x']]), /não existe/);
    assert.throws(() => escreverNoXlsx(x, undefined, 'A0', [['x']]), /célula inválida/);
  });
  test('CSV e o formato dos valores', () => {
    assert.equal(escreverNoCsv('a;b\n1;2\n', 'B2', [['3']]), 'a;b\n1;3\n');
    assert.equal(escreverNoCsv('a,b\n', 'C3', [['x, y']]), 'a,b\n\n,,"x, y"\n');
    assert.deepEqual(valoresDe('[["a", 1], ["b", null]]'), [['a', '1'], ['b', '']]);
    assert.deepEqual(valoresDe('a | 1\nb\t2'), [['a', '1'], ['b', '2']]);
  });
});

// ------------------------------------------------------------------------------- Google falso (Drive, Docs, Sheets)
interface ArqG { id: string; name: string; mimeType: string; parents: string[]; trashed?: boolean; texto?: string; celulas?: Record<string, string>; comentarios?: string[]; permissoes?: Array<{ role: string; emailAddress: string; aviso: boolean }> }
function googleFalso() {
  const arqs = new Map<string, ArqG>();
  const add = (a: ArqG) => arqs.set(a.id, a);
  const link = (a: ArqG) => `https://docs.google.com/x/${a.id}`;
  const vis = (a: ArqG) => ({ id: a.id, name: a.name, mimeType: a.mimeType, parents: a.parents, webViewLink: link(a) });
  const apagados: string[] = [];
  const http: Http = async (url, init = {}) => {
    const u = new URL(url); const m = init.method ?? 'GET'; const b = init.body as any;
    let x: RegExpExecArray | null;
    if (u.pathname === '/drive/v3/about') return { user: { emailAddress: 'ana@empresa.com.br' } };
    if (u.pathname === '/drive/v3/files' && m === 'POST') { const a: ArqG = { id: `f${arqs.size + 1}`, name: b.name, mimeType: b.mimeType, parents: b.parents }; add(a); return vis(a); }
    if ((x = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
      const a = arqs.get(decodeURIComponent(x[1])); if (!a) throw Object.assign(new Error('não encontrado'), { status: 404 });
      if (m === 'DELETE') { arqs.delete(a.id); apagados.push(a.id); return {}; }
      if (m === 'PATCH') {
        if (b.name) a.name = b.name; if (b.trashed) a.trashed = true;
        const add = u.searchParams.get('addParents'); const rem = u.searchParams.get('removeParents');
        if (add) a.parents = [...a.parents.filter((p) => !rem?.split(',').includes(p)), add];
      }
      return vis(a);
    }
    if ((x = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(u.pathname))) { const o = arqs.get(x[1])!; const c: ArqG = { ...o, id: `f${arqs.size + 1}`, name: b.name ?? `Cópia de ${o.name}`, parents: b.parents ?? o.parents }; add(c); return vis(c); }
    if ((x = /^\/drive\/v3\/files\/([^/]+)\/comments$/.exec(u.pathname))) { (arqs.get(x[1])!.comentarios ??= []).push(b.content); return { id: 'c1' }; }
    if ((x = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(u.pathname))) { (arqs.get(x[1])!.permissoes ??= []).push({ role: b.role, emailAddress: b.emailAddress, aviso: u.searchParams.get('sendNotificationEmail') === 'true' }); return { id: 'p1' }; }
    if ((x = /^\/v1\/documents\/([^/:]+):batchUpdate$/.exec(u.pathname))) {
      const a = arqs.get(x[1])!; let n = 0;
      for (const r of b.requests) {
        if (r.replaceAllText) { const partes = a.texto!.split(r.replaceAllText.containsText.text); n += partes.length - 1; a.texto = partes.join(r.replaceAllText.replaceText); }
        if (r.insertText) a.texto += r.insertText.text;
      }
      return { replies: b.requests.map((r: any) => (r.replaceAllText ? { replaceAllText: { occurrencesChanged: n } } : {})) };
    }
    if ((x = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^:]+)$/.exec(u.pathname))) {
      const a = arqs.get(x[1])!; const faixa = decodeURIComponent(x[2]); const ini = /([A-Z])(\d+)/.exec(faixa.split('!').at(-1)!)!;
      if (m === 'PUT') {
        let n = 0;
        (b.values as unknown[][]).forEach((l, i) => l.forEach((v, j) => { a.celulas![`${String.fromCharCode(ini[1].charCodeAt(0) + j)}${Number(ini[2]) + i}`] = String(v); n++; }));
        return { updatedCells: n, updatedRange: faixa };
      }
      return { range: faixa, values: [[a.celulas![`${ini[1]}${ini[2]}`] ?? '']] };
    }
    throw new Error(`rota falsa desconhecida: ${m} ${u.pathname}`);
  };
  return { arqs, add, http, apagados };
}

describe('Drive: organizar, editar e compartilhar de verdade', () => {
  const acao = (id: string) => ACOES_GOOGLE.find((a) => a.id === id)!;
  let g: ReturnType<typeof googleFalso>; let ctx: CtxAcao;
  beforeEach(() => {
    g = googleFalso(); ctx = { workspaceId: 'w', tz: 'America/Sao_Paulo', http: g.http };
    g.add({ id: 'pasta1', name: 'Clientes', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] });
    g.add({ id: 'doc1', name: 'Proposta ACME', mimeType: 'application/vnd.google-apps.document', parents: ['root'], texto: 'Valor: R$ 1.000. Prazo: 30 dias.' });
    g.add({ id: 'pla1', name: 'Orçamento', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['root'], celulas: { A1: 'Item', B1: 'Valor' } });
  });
  test('a permissão nova é uma só (drive), e todas as ações novas pedem por ela', () => {
    assert.ok(ESCOPOS_GOOGLE.includes(ESCOPO_DRIVE_TUDO));
    const novas = ['arquivos.pasta', 'arquivos.mover', 'arquivos.renomear', 'arquivos.copiar', 'documento.editar', 'planilha.editar', 'arquivos.comentar', 'arquivos.compartilhar', 'arquivos.apagar', 'arquivos.apagar_de_vez'];
    for (const id of novas) assert.deepEqual(acao(id).escopos, [ESCOPO_DRIVE_TUDO], id);
  });
  test('localizar → mexer → conferir: pasta, mover, renomear, copiar, com o link de cada um', async () => {
    const p = await acao('arquivos.pasta').run(ctx, { nome: '2026', dentro: 'pasta1' });
    const nova = [...g.arqs.values()].find((a) => a.name === '2026')!;
    assert.deepEqual(nova.parents, ['pasta1']); assert.equal(p.url, `https://docs.google.com/x/${nova.id}`);
    await acao('arquivos.mover').run(ctx, { id: 'doc1', para: nova.id });
    assert.deepEqual(g.arqs.get('doc1')!.parents, [nova.id], 'sai da pasta de antes');
    await acao('arquivos.renomear').run(ctx, { id: 'doc1', nome: 'Proposta ACME — v2\n' });
    assert.equal(g.arqs.get('doc1')!.name, 'Proposta ACME — v2');
    const c = await acao('arquivos.copiar').run(ctx, { id: 'doc1', nome: 'Modelo' });
    assert.match(c.texto, /Cópia criada: Modelo/); assert.ok(c.url);
    await assert.rejects(() => acao('arquivos.mover').run(ctx, { id: 'doc1', para: 'pla1' }), /não é uma pasta/);
  });
  test('Documento e Planilha: editar o que já existe e ler de novo para conferir', async () => {
    const r = await acao('documento.editar').run(ctx, { id: 'doc1', procurar: 'R$ 1.000', trocar_por: 'R$ 1.250', acrescentar: 'Validade: 15 dias.' });
    assert.match(r.texto, /1 troca/); assert.equal(g.arqs.get('doc1')!.texto, 'Valor: R$ 1.250. Prazo: 30 dias.\nValidade: 15 dias.');
    await assert.rejects(() => acao('documento.editar').run(ctx, { id: 'doc1', procurar: 'não existe' }), /não está no documento/);
    await assert.rejects(() => acao('documento.editar').run(ctx, { id: 'pla1', acrescentar: 'x' }), /não é um Documento/);
    const p = await acao('planilha.editar').run(ctx, { id: 'pla1', intervalo: 'Página1!A2', valores: [['Aluguel', 1000], ['Total', '=B2']] });
    assert.match(p.texto, /4 célula/);
    assert.equal(g.arqs.get('pla1')!.celulas!.B3, '=B2');
    const l = await acao('planilha.ler').run(ctx, { id: 'pla1', intervalo: 'Página1!A2' });
    assert.match(l.texto, /Aluguel/); assert.equal(l.deFora, true);
    await assert.rejects(() => acao('planilha.editar').run(ctx, { id: 'pla1', intervalo: 'A1; DROP', valores: 'x' }), /intervalo/);
  });
  test('compartilhar: dentro do domínio vai pela regra; fora do domínio pede a aprovação; comentar avisa', async () => {
    assert.equal((await acao('arquivos.compartilhar').preparar!(ctx, { id: 'doc1', email: 'joao@empresa.com.br' })).confirmar, undefined);
    assert.match((await acao('arquivos.compartilhar').preparar!(ctx, { id: 'doc1', email: 'x@gmail.com' })).confirmar!, /fora do seu domínio/);
    await acao('arquivos.compartilhar').run(ctx, { id: 'doc1', email: 'joao@empresa.com.br', papel: 'editar' });
    assert.deepEqual(g.arqs.get('doc1')!.permissoes, [{ role: 'writer', emailAddress: 'joao@empresa.com.br', aviso: true }]);
    await assert.rejects(() => acao('arquivos.compartilhar').run(ctx, { id: 'doc1', email: 'x@y.com', papel: 'dono' }), /papel/);
    await acao('arquivos.comentar').run(ctx, { id: 'doc1', texto: 'Revisei os valores' });
    assert.deepEqual(g.arqs.get('doc1')!.comentarios, ['Revisei os valores']);
  });
  test('lixeira é apagar; apagar de vez é sempre-protegida', async () => {
    assert.equal(acao('arquivos.apagar').risco, 'apagar'); assert.ok(!acao('arquivos.apagar').protegida);
    await acao('arquivos.apagar').run(ctx, { id: 'doc1' });
    assert.equal(g.arqs.get('doc1')!.trashed, true);
    assert.match(acao('arquivos.apagar_de_vez').protegida!, /mesmo com "Liberar tudo"/);
    await acao('arquivos.apagar_de_vez').run(ctx, { id: 'pla1' });
    assert.deepEqual(g.apagados, ['pla1']);
  });
});

// ----------------------------------------------------------------------------------------------- Graph falso
describe('OneDrive: organizar, Excel e Word de verdade', () => {
  const acao = (id: string) => ACOES_MICROSOFT.find((a) => a.id === id)!;
  const antes = globalThis.fetch;
  let itens: Map<string, any>; let ctx: CtxAcao; let enviado: Buffer | null; let celulas: Record<string, unknown[][]>;
  beforeEach(() => {
    enviado = null; celulas = {};
    itens = new Map<string, any>([
      ['root', { id: 'root', name: 'root', folder: {} }],
      ['pasta1', { id: 'pasta1', name: 'Financeiro', folder: {}, parentReference: { id: 'root' } }],
      ['w1', { id: 'w1', name: 'Contrato.docx', file: {}, parentReference: { id: 'root' }, bytes: markdownToDocx('Cliente: ACME\n\nValor: R$ 1.000', 'Contrato') }],
      ['x1', { id: 'x1', name: 'Contas.xlsx', file: {}, parentReference: { id: 'root' } }],
    ]);
    const vis = (i: any) => ({ id: i.id, name: i.name, folder: i.folder, file: i.file, parentReference: i.parentReference, webUrl: `https://onedrive.live.com/${i.id}`, ...(i.bytes ? { '@microsoft.graph.downloadUrl': `https://download.falso/${i.id}` } : {}) });
    const http: Http = async (url, init = {}) => {
      const u = new URL(url); const m = init.method ?? 'GET'; const b = init.body as any; const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
      let x: RegExpExecArray | null;
      if (p === '/me') return { mail: 'ana@empresa.com.br' };
      if (p === '/me/drive/root') return { id: 'root' };
      if (p === '/me/drive') return { id: 'drive1' };
      if ((x = /^\/me\/drive\/items\/([^/]+)\/children$/.exec(p)) && m === 'POST') { const n = { id: `i${itens.size}`, name: b.name, folder: {}, parentReference: { id: x[1] } }; itens.set(n.id, n); return vis(n); }
      if ((x = /^\/me\/drive\/items\/([^/]+)\/createUploadSession$/.exec(p))) return { uploadUrl: `https://upload.falso/${x[1]}` };
      if ((x = /^\/me\/drive\/items\/([^/]+)\/workbook\/worksheets$/.exec(p))) return { value: [{ name: 'Plan1' }] };
      if ((x = /^\/me\/drive\/items\/([^/]+)\/workbook\/worksheets\/([^/]+)\/range\(address='([^']+)'\)$/.exec(p))) { if (m === 'PATCH') { celulas[`${x[2]}!${x[3]}`] = b.values; return {}; } return { address: `${x[2]}!${x[3]}`, values: celulas[`${x[2]}!${x[3]}`] ?? [[]] }; }
      if ((x = /^\/me\/drive\/items\/([^/]+)\/invite$/.exec(p))) { itens.get(x[1]).convite = b; return { value: [] }; }
      if ((x = /^\/me\/drive\/items\/([^/]+)\/permanentDelete$/.exec(p))) { itens.delete(x[1]); return {}; }
      if ((x = /^\/me\/drive\/items\/([^/]+)\/copy$/.exec(p))) { itens.get(x[1]).copia = b; return {}; }
      if ((x = /^\/me\/drive\/items\/([^/]+)$/.exec(p))) {
        const i = itens.get(x[1]); if (!i) throw new Error('não encontrado');
        if (m === 'DELETE') { i.lixeira = true; return {}; }
        if (m === 'PATCH') { if (b.name) i.name = b.name; if (b.parentReference) i.parentReference = b.parentReference; }
        return vis(i);
      }
      throw new Error(`rota falsa desconhecida: ${m} ${p}`);
    };
    ctx = { workspaceId: 'w', tz: 'America/Sao_Paulo', http };
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const u = new URL(String(input));
      if (u.host === 'download.falso') return new Response(new Uint8Array(itens.get(u.pathname.slice(1)).bytes));
      if (u.host === 'upload.falso') { enviado = Buffer.from(init.body as Uint8Array); itens.get(u.pathname.slice(1)).bytes = enviado; return new Response(JSON.stringify({ id: u.pathname.slice(1), name: 'Contrato.docx', webUrl: 'https://onedrive.live.com/w1' }), { status: 200 }); }
      return antes(input, init);
    }) as typeof fetch;
  });
  after(() => { globalThis.fetch = antes; });
  test('pasta, mover, renomear e copiar', async () => {
    await acao('arquivos.pasta').run(ctx, { nome: '2026', dentro: 'pasta1' });
    const nova = [...itens.values()].find((i) => i.name === '2026')!;
    assert.equal(nova.parentReference.id, 'pasta1');
    await acao('arquivos.mover').run(ctx, { id: 'w1', para: nova.id });
    assert.equal(itens.get('w1').parentReference.id, nova.id);
    await acao('arquivos.renomear').run(ctx, { id: 'w1', nome: 'Contrato ACME.docx' });
    assert.equal(itens.get('w1').name, 'Contrato ACME.docx');
    await assert.rejects(() => acao('arquivos.renomear').run(ctx, { id: 'w1', nome: 'a/b.docx' }), /não aceita/);
    await acao('arquivos.copiar').run(ctx, { id: 'w1', nome: 'Modelo.docx', para: 'pasta1' });
    assert.deepEqual(itens.get('w1').copia, { '@microsoft.graph.conflictBehavior': 'rename', name: 'Modelo.docx', parentReference: { driveId: 'drive1', id: 'pasta1' } });
  });
  test('Word: baixa, edita e envia de volta (o leitor do Ergon vê o texto novo)', async () => {
    itens.get('w1').name = 'Contrato.docx';
    const r = await acao('documento.editar').run(ctx, { id: 'w1', procurar: 'R$ 1.000', trocar_por: 'R$ 1.250', acrescentar: 'Assinatura: ____' });
    assert.match(r.texto, /1 troca/); assert.equal(r.url, 'https://onedrive.live.com/w1');
    const lido = extractDoc('c.docx', '', enviado!);
    assert.match(lido.text, /R\$ 1\.250/); assert.match(lido.text, /Assinatura/);
  });
  test('Excel: escreve no intervalo certo da aba e lê de volta', async () => {
    const r = await acao('planilha.editar').run(ctx, { id: 'x1', intervalo: 'B2', valores: 'Aluguel | 1000\nLuz' });
    assert.match(r.texto, /Plan1!B2:C3/);
    assert.deepEqual(celulas['Plan1!B2:C3'], [['Aluguel', '1000'], ['Luz', '']]);
    await assert.rejects(() => acao('planilha.editar').run(ctx, { id: 'w1', intervalo: 'A1', valores: 'x' }), /não é uma pasta de trabalho/);
    await assert.rejects(() => acao('planilha.editar').run(ctx, { id: 'x1', aba: 'Outra', intervalo: 'A1', valores: 'x' }), /não existe/);
  });
  test('compartilhar fora do domínio pede aprovação; lixeira e apagar de vez', async () => {
    assert.match((await acao('arquivos.compartilhar').preparar!(ctx, { id: 'w1', email: 'x@outra.com' })).confirmar!, /fora do seu domínio/);
    await acao('arquivos.compartilhar').run(ctx, { id: 'w1', email: 'joao@empresa.com.br', papel: 'editar', avisar: false });
    assert.deepEqual(itens.get('w1').convite, { recipients: [{ email: 'joao@empresa.com.br' }], roles: ['write'], requireSignIn: true, sendInvitation: false });
    await acao('arquivos.apagar').run(ctx, { id: 'w1' });
    assert.equal(itens.get('w1').lixeira, true);
    await acao('arquivos.apagar_de_vez').run(ctx, { id: 'x1' });
    assert.ok(!itens.has('x1'));
  });
});

// ------------------------------------------------------------------- pela ponte: aprovação vs "Liberar tudo"
describe('escritório pela ponte: a regra de cada ação, com e sem "Liberar tudo"', () => {
  const TOKEN = 'token-da-ponte-de-teste-0123456789';
  class Motor implements HermesClient {
    n = 0; runs = new Map<string, RemoteRun>();
    async health() { return { ok: true, detail: 'teste' }; }
    async startRun(_p: StartRun) { const runId = `run_t${String(++this.n).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; }
    async getRun(id: string) { return this.runs.get(id)!; }
    async stop() { return { accepted: true, detail: 'ok' }; }
    async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
    async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
  }
  let h: Harness; let s: Session; let agente: string; let g: ReturnType<typeof googleFalso>;
  const antes = globalThis.fetch;
  async function sessao(texto: string): Promise<string> {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
  }
  const executar = async (sess: string, acao: string, parametros: Args) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sess, conexao: 'google', acao, parametros }, { 'x-ergon-bridge-token': TOKEN })).json;
  before(async () => {
    setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
    g = googleFalso();
    g.add({ id: 'doc1', name: 'Proposta', mimeType: 'application/vnd.google-apps.document', parents: ['root'], texto: 'x' });
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const u = new URL(String(input));
      if (/googleapis\.com$/.test(u.host)) {
        try { return new Response(JSON.stringify(await g.http(String(input), { method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined })), { status: 200, headers: { 'content-type': 'application/json' } }); }
        catch (e) { return new Response(JSON.stringify({ error: { message: String(e) } }), { status: 404, headers: { 'content-type': 'application/json' } }); }
      }
      return antes(input, init);
    }) as typeof fetch;
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.integrations.secrets.write(s.workspaceId, 'google', { access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600_000, account: 'ana@empresa.com.br', scopes: ESCOPOS_GOOGLE.join(' '), granted: ESCOPOS_GOOGLE.join(' ') });
    setIntegration(h.db, s.workspaceId, 'google', { state: 'connected', account_label: 'ana@empresa.com.br', connected_at: new Date().toISOString() });
  });
  after(async () => { globalThis.fetch = antes; setHttpClock(null); await h.close(); });

  test('sem "Liberar tudo": editar vai (a pessoa pediu); compartilhar para fora e lixeira pedem o cartão', async () => {
    const sess = await sessao('edite a proposta e compartilhe');
    assert.equal((await executar(sess, 'documento.editar', { id: 'doc1', acrescentar: 'ok' })).status, 'feita');
    assert.equal((await executar(sess, 'arquivos.compartilhar', { id: 'doc1', email: 'x@gmail.com' })).status, 'aguardando_confirmacao');
    assert.equal((await executar(sess, 'arquivos.apagar', { id: 'doc1' })).status, 'aguardando_confirmacao');
    assert.equal(g.arqs.get('doc1')!.permissoes, undefined);
  });
  test('"Liberar tudo" do workspace: compartilhar para fora e lixeira passam direto (com o link); apagar de vez continua pedindo', async () => {
    assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: true })).status, 200);
    try {
      const sess = await sessao('organize tudo sozinho');
      const r = await executar(sess, 'arquivos.compartilhar', { id: 'doc1', email: 'x@gmail.com' });
      assert.equal(r.status, 'feita', JSON.stringify(r));
      assert.equal(r.url, 'https://docs.google.com/x/doc1', 'o link do objeto afetado volta para ser citado');
      assert.equal((await executar(sess, 'arquivos.apagar', { id: 'doc1' })).status, 'feita');
      assert.equal((await executar(sess, 'arquivos.apagar_de_vez', { id: 'doc1' })).status, 'aguardando_confirmacao');
      assert.deepEqual(g.apagados, []);
      // tudo registrado, com o que foi liberado
      const feitas = h.db.all<{ acao: string; decisao: string }>("SELECT acao, decisao FROM conexao_acoes WHERE workspace_id = ? AND status = 'feita' AND acao IN ('arquivos.compartilhar', 'arquivos.apagar')", s.workspaceId);
      assert.equal(feitas.length, 2);
    } finally { await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: false }); }
  });
  test('governança: quem administra proíbe e o modo desliga para todos; o "meu" não liga enquanto proibido', async () => {
    await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: true, semAviso: true });
    let e = (await req(h, 'GET', '/api/conexoes', s)).json;
    assert.equal(e.liberarTudoMeu, true); assert.equal(e.liberarTudoSemAviso, true); assert.equal(e.administra, true);
    assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo/proibir', s, { on: true })).status, 200);
    e = (await req(h, 'GET', '/api/conexoes', s)).json;
    assert.equal(e.liberarTudoProibido, true); assert.equal(e.liberarTudoMeu, false); assert.equal(e.liberarTudo, false);
    assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: true })).status, 409);
    assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: true })).status, 409);
    const sess = await sessao('compartilhe a proposta');
    assert.equal((await executar(sess, 'arquivos.compartilhar', { id: 'doc1', email: 'y@gmail.com' })).status, 'aguardando_confirmacao');
    await req(h, 'PUT', '/api/conexoes/liberar-tudo/proibir', s, { on: false });
    assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: true })).status, 200);
    await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: false });
    const aud = h.db.all<{ action: string }>("SELECT action FROM audit_events WHERE workspace_id = ? AND action LIKE 'conexoes.liberar_tudo%'", s.workspaceId).map((x) => x.action);
    assert.ok(aud.includes('conexoes.liberar_tudo_proibido') && aud.includes('conexoes.liberar_tudo'));
  });
});

// ------------------------------------------------------------------- os Documentos do Ergon (arquivos do computador)
describe('Documentos do Ergon: ler e editar planilha e texto, com a versão de antes na Lixeira', () => {
  const TOKEN = 'token-da-ponte-de-teste-0123456789';
  class Motor implements HermesClient {
    n = 0; runs = new Map<string, RemoteRun>();
    async health() { return { ok: true, detail: 'teste' }; }
    async startRun(_p: StartRun) { const runId = `run_d${String(++this.n).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; }
    async getRun(id: string) { return this.runs.get(id)!; }
    async stop() { return { accepted: true, detail: 'ok' }; }
    async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
    async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
  }
  let h: Harness; let s: Session; let agente: string;
  async function sessao(texto: string): Promise<string> {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
  }
  const executar = async (sess: string, acao: string, parametros: Args) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sess, conexao: 'documentos', acao, parametros }, { 'x-ergon-bridge-token': TOKEN })).json;
  const subir = async (nome: string, mime: string, data: Buffer) => {
    const { saveArtifact } = await import('../src/services/artifacts.ts');
    return saveArtifact(h.db, h.bus, h.cfg.filesDir, h.cfg.maxUploadBytes, s.workspaceId, s.userId, { filename: nome, mime, data }).id;
  };
  before(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  });
  after(async () => { await h.close(); });

  test('buscar → ler → editar a planilha → ler de novo; a versão de antes fica na Lixeira', async () => {
    const id = await subir('Orçamento 2026.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', markdownToXlsx('| Item | Valor |\n|---|---|\n| Aluguel | 1000 |', 'Orçamento'));
    const sess = await sessao('atualize o orçamento: luz 200');
    const b = await executar(sess, 'documentos.buscar', { texto: 'orçamento' });
    assert.match(b.texto, new RegExp(`id=${id}`));
    const l = await executar(sess, 'documentos.ler', { id });
    assert.match(l.texto, /Aluguel/);
    const e = await executar(sess, 'documentos.editar_planilha', { id, celula: 'A3', valores: [['Luz', 200]] });
    assert.equal(e.status, 'feita', JSON.stringify(e));
    assert.match(e.url, /^#documentos\?pasta=/);
    const novo = /Novo id=(art_[0-9a-f]{32})/.exec(e.texto)![1];
    assert.match((await executar(sess, 'documentos.ler', { id: novo })).texto, /Luz/);
    assert.ok(h.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM artifacts WHERE id = ?', id)!.deleted_at, 'a de antes foi para a Lixeira');
    assert.equal(h.db.get<{ filename: string }>('SELECT filename FROM artifacts WHERE id = ?', novo)!.filename, 'Orçamento 2026.xlsx');
  });
  test('texto: docx e md; e o pedido que não partiu da pessoa não edita', async () => {
    const doc = await subir('Contrato.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', markdownToDocx('Valor: R$ 1.000', 'Contrato'));
    const md = await subir('notas.md', 'text/markdown', Buffer.from('# Notas\n\n- a\n'));
    const sess = await sessao('ajuste o contrato e as notas');
    const r = await executar(sess, 'documentos.editar_texto', { id: doc, procurar: 'R$ 1.000', trocar_por: 'R$ 1.500' });
    assert.equal(r.status, 'feita', JSON.stringify(r));
    const novo = /Novo id=(art_[0-9a-f]{32})/.exec(r.texto)![1];
    assert.match((await executar(sess, 'documentos.ler', { id: novo })).texto, /R\$ 1\.500/);
    const m = await executar(sess, 'documentos.editar_texto', { id: md, acrescentar: '- b' });
    assert.equal(m.status, 'feita');
    assert.equal((await executar(sess, 'documentos.editar_texto', { id: md, procurar: 'x' })).status, 'falhou', 'arquivo já na Lixeira');
    // uma rotina (pedido de fora): não edita
    const run = h.db.get<{ id: string }>('SELECT id FROM runs WHERE hermes_session_id = ?', sess)!.id;
    h.db.run("UPDATE runs SET idempotency_key = 'rotina-x' WHERE id = ?", run);
    const fora = await executar(sess, 'documentos.editar_texto', { id: novo, acrescentar: 'x' });
    assert.equal(fora.status, 'falhou'); assert.match(fora.texto, /só quando a própria pessoa pede/);
    assert.equal((await executar(sess, 'documentos.ler', { id: novo })).status, 'feita', 'ler continua');
  });
});
