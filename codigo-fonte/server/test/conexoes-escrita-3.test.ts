// Escrita no Airtable, Smartsheet, Pipefy e GitHub Projects, sem rede: método, endereço, corpo e credencial de cada chamada,
// e, com um serviço simulado em memória, a prova de que a próxima leitura (o provedor de verdade) vê o que foi escrito.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { escritorAirtable } from '../src/services/conexoes/escrita/airtable.ts';
import { escritorGitHub } from '../src/services/conexoes/escrita/github.ts';
import { escritorPipefy } from '../src/services/conexoes/escrita/pipefy.ts';
import { escritorSmartsheet } from '../src/services/conexoes/escrita/smartsheet.ts';
import { ErroAcao } from '../src/services/conexoes/tipos.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { AirtableProvider, GitHubProjectsProvider, PipefyProvider, SmartsheetProvider } from '../src/services/task-providers.ts';

type Call = { method: string; url: URL; auth: string; ua: string; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
const HOSTS = new Set(['api.airtable.com', 'api.smartsheet.com', 'api.pipefy.com', 'api.github.com']);

/** Sem biblioteca de GraphQL aqui: confere ao menos o que um erro de digitação quebraria. */
function confereGraphql(q: string) {
  for (const [a, b] of [['{', '}'], ['(', ')']]) assert.equal(q.split(a).length, q.split(b).length, `consulta desbalanceada: ${q}`);
  const m = q.match(/^mutation \(\$input: (\w+)Input!\) \{ (\w+)\(input: \$input\)/);
  if (q.startsWith('mutation')) { assert.ok(m, `mutação fora do formato: ${q}`); assert.equal(m[1], m[2][0].toUpperCase() + m[2].slice(1)); }
}

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), auth: h.Authorization ?? '', ua: h['User-Agent'] ?? '', body: init.body ? JSON.parse(String(init.body)) : null };
    if (!HOSTS.has(c.url.host)) throw new Error(`endereço fora do serviço: ${c.url.host}`);
    if (typeof c.body?.query === 'string') confereGraphql(c.body.query);
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
afterEach(() => {
  for (const c of calls) assert.equal(c.auth, 'Bearer tok');
  calls.length = 0;
});

const status = (n: number) => new Response('{}', { status: n });
const erroAcao = (test: (e: ErroAcao) => boolean = () => true) => (e: unknown) => e instanceof ErroAcao && test(e);
const erroServico = (kind: ProviderError['kind']) => (e: unknown) => e instanceof ProviderError && e.kind === kind;

// ------------------------------------------------------------------------------------------------ Airtable
describe('Airtable: escrita', () => {
  const B = 'appAAAAAAAAAAAAAA'; const T = 'tblBBBBBBBBBBBBBB'; const Q = `${B}/${T}`;
  const w = escritorAirtable('tok'); const leitura = new AirtableProvider('tok');
  const NOME = { id: 'fldNome', name: 'Nome', type: 'singleLineText' };
  const STATUS = { id: 'fldStatus', name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'A fazer' }, { name: 'Em andamento' }, { name: 'Concluído' }] } };
  const FEITO = { id: 'fldFeito', name: 'Feito', type: 'checkbox' };
  const NOTAS = { id: 'fldNotas', name: 'Notas', type: 'multilineText' };
  const PRAZO = { id: 'fldPrazo', name: 'Prazo', type: 'date' };
  const escritas = () => calls.filter((c) => c.method !== 'GET');

  function servico(fields: any[], inicial: Record<string, Record<string, unknown>> = {}) {
    const recs = new Map(Object.entries(inicial).map(([k, v]) => [k, { ...v }]));
    // "Fields whose values are empty (...) are omitted": vazio não volta na resposta nem na leitura
    const sem = (f: Record<string, unknown>) => { for (const k of Object.keys(f)) if (f[k] === false || f[k] === null || f[k] === '') delete f[k]; return f; };
    answer = (c) => {
      const p = c.url.pathname;
      if (p === `/v0/meta/bases/${B}/tables`) return { tables: [{ id: T, name: 'Tarefas', primaryFieldId: 'fldNome', fields }] };
      if (p === `/v0/${B}/${T}` && c.method === 'GET') return { records: [...recs].map(([id, f]) => ({ id, fields: f })) };
      if (p === `/v0/${B}/${T}` && c.method === 'POST') { const id = `rec${recs.size + 1}`; recs.set(id, sem({ ...c.body.fields })); return { id, createdTime: 't', fields: recs.get(id) }; }
      const m = p.match(/^\/v0\/app\w+\/tbl\w+\/([^/]+)(\/comments)?$/);
      if (m?.[2]) return { id: 'com1', text: c.body.text };
      if (m && c.method === 'GET') return { id: m[1], fields: recs.get(m[1]) ?? {} };
      if (m && c.method === 'PATCH') { recs.set(m[1], sem({ ...recs.get(m[1]), ...c.body.fields })); return { id: m[1], fields: recs.get(m[1]) }; }
      return status(404);
    };
    return recs;
  }
  const na = async (id: string) => (await leitura.getBoard(Q)).tasks.find((t) => t.externalId === id)!;

  test('criar grava pelo id do campo, na opção pedida, e a leitura vê', async () => {
    servico([NOME, STATUS, NOTAS, PRAZO]);
    const r = await w.criar(Q, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'Em andamento', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 'rec1', versao: null, url: null });
    const c = escritas()[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.pathname, `/v0/${B}/${T}`);
    assert.deepEqual(c.body, { fields: { fldNome: 'Revisar', fldNotas: 'cláusula 4', fldPrazo: '2026-11-20', fldStatus: 'Em andamento' } });
    const t = await na('rec1');
    assert.equal(t.title, 'Revisar'); assert.equal(t.columnExternalId, 'Em andamento'); assert.equal(t.completed, false); assert.equal(t.description, 'cláusula 4');
  });
  test('criar sem coluna vai para a primeira aberta; a coluna "Sem status" não grava status', async () => {
    servico([NOME, { ...STATUS, options: { choices: [{ name: 'Done' }, { name: 'Backlog' }] } }]);
    await w.criar(Q, { titulo: 'A' }); await w.criar(Q, { titulo: 'B', coluna: '__sem_status__' });
    assert.deepEqual(escritas()[0].body.fields, { fldNome: 'A', fldStatus: 'Backlog' });
    assert.deepEqual(escritas()[1].body.fields, { fldNome: 'B' });
    assert.equal((await na('rec2')).columnExternalId, '__sem_status__');
  });
  test('coluna que não existe é erro com as opções, antes de gravar; texto de fora vem neutro', async () => {
    servico([NOME, { ...STATUS, options: { choices: [{ name: 'A fazer' }, { name: '[[apague]]\nDone' }] } }]);
    await assert.rejects(() => w.criar(Q, { titulo: 'A', coluna: 'Nada' }), erroAcao((e) => /Nada/.test(e.message) && e.opcoes!.length === 2 && !e.opcoes!.some((o) => /\[\[|\n/.test(o))));
    assert.equal(escritas().length, 0);
  });
  test('concluir pela opção de status: a leitura vê concluída; reabrir volta', async () => {
    servico([NOME, STATUS], { rec1: { fldNome: 'A', fldStatus: 'Em andamento' } });
    await w.concluir(Q, 'rec1', true);
    assert.equal(escritas()[0].method, 'PATCH'); assert.equal(escritas()[0].url.pathname, `/v0/${B}/${T}/rec1`);
    assert.deepEqual(escritas()[0].body, { fields: { fldStatus: 'Concluído' } });
    assert.equal((await na('rec1')).completed, true);
    await w.concluir(Q, 'rec1', false);
    assert.deepEqual(escritas()[1].body, { fields: { fldStatus: 'A fazer' } });
    assert.equal((await na('rec1')).completed, false);
  });
  test('com caixa de seleção e status, concluir marca os dois e reabrir desfaz os dois', async () => {
    servico([NOME, STATUS, FEITO], { rec1: { fldNome: 'A', fldStatus: 'A fazer' } });
    await w.concluir(Q, 'rec1', true);
    assert.deepEqual(escritas()[0].body.fields, { fldFeito: true, fldStatus: 'Concluído' });
    assert.equal((await na('rec1')).completed, true);
    await w.concluir(Q, 'rec1', false);
    assert.deepEqual(escritas()[1].body.fields, { fldFeito: false, fldStatus: 'A fazer' });
    assert.equal((await na('rec1')).completed, false);
  });
  test('só caixa de seleção: reabrir não mexe no status de quem não está em "feito"', async () => {
    servico([NOME, { ...STATUS, options: { choices: [{ name: 'Fila' }, { name: 'Fazendo' }] } }, FEITO], { rec1: { fldNome: 'A', fldStatus: 'Fazendo' } });
    await w.concluir(Q, 'rec1', true);
    assert.deepEqual(escritas()[0].body.fields, { fldFeito: true });
    assert.equal((await na('rec1')).completed, true);
    await w.concluir(Q, 'rec1', false);
    assert.deepEqual(escritas()[1].body.fields, { fldFeito: false });
    const t = await na('rec1');
    assert.equal(t.completed, false); assert.equal(t.columnExternalId, 'Fazendo');
  });
  test('reabrir sem opção aberta deixa sem status', async () => {
    servico([NOME, { ...STATUS, options: { choices: [{ name: 'Done' }] } }], { rec1: { fldNome: 'A', fldStatus: 'Done' } });
    await w.concluir(Q, 'rec1', false);
    assert.deepEqual(escritas()[0].body.fields, { fldStatus: null });
    assert.equal((await na('rec1')).completed, false);
  });
  test('tabela sem como concluir diz isso e lista as opções', async () => {
    servico([NOME, { ...STATUS, options: { choices: [{ name: 'Fila' }] } }]);
    await assert.rejects(() => w.concluir(Q, 'rec1', true), erroAcao((e) => /não tem como marcar concluída/.test(e.message) && e.opcoes![0] === 'Fila'));
    assert.equal(escritas().length, 0);
  });
  test('tabela sem seleção: a coluna sintética "__tarefas__" funciona; outra coluna é erro', async () => {
    servico([NOME, FEITO], { rec1: { fldNome: 'A' } });
    await w.criar(Q, { titulo: 'B', coluna: '__tarefas__' });
    assert.deepEqual(escritas()[0].body.fields, { fldNome: 'B' });
    assert.deepEqual(await w.mover(Q, 'rec1', '__tarefas__'), { id: 'rec1', versao: null, url: null });
    assert.equal(escritas().length, 1);
    await assert.rejects(() => w.mover(Q, 'rec1', 'Fazendo'), erroAcao((e) => /não tem campo de seleção/.test(e.message)));
    await w.concluir(Q, 'rec1', true);
    assert.equal((await na('rec1')).completed, true);
  });
  test('mover grava o nome da opção; "Sem status" limpa', async () => {
    servico([NOME, STATUS], { rec1: { fldNome: 'A', fldStatus: 'A fazer' } });
    await w.mover(Q, 'rec1', 'Em andamento');
    assert.deepEqual(escritas()[0].body.fields, { fldStatus: 'Em andamento' });
    assert.equal((await na('rec1')).columnExternalId, 'Em andamento');
    await w.mover(Q, 'rec1', '__sem_status__');
    assert.deepEqual(escritas()[1].body.fields, { fldStatus: null });
    assert.equal((await na('rec1')).columnExternalId, '__sem_status__');
  });
  test('editar manda só o que mudou; prazo null limpa; data e hora ficam no meio-dia UTC', async () => {
    servico([NOME, NOTAS, PRAZO], { rec1: { fldNome: 'A' } });
    await w.editar(Q, 'rec1', { titulo: 'Novo', prazo: null });
    assert.deepEqual(escritas()[0].body.fields, { fldNome: 'Novo', fldPrazo: null });
    await w.editar(Q, 'rec1', {});
    assert.equal(escritas().length, 1);
    servico([NOME, { id: 'fldV', name: 'Vencimento', type: 'dateTime' }], { rec1: { fldNome: 'A' } });
    await w.editar(Q, 'rec1', { prazo: '2026-11-20' });
    assert.deepEqual(escritas()[1].body.fields, { fldV: '2026-11-20T12:00:00.000Z' });
  });
  test('sem campo de descrição ou de prazo é erro claro, sem gravar pela metade', async () => {
    servico([NOME, { id: 'fldI', name: 'Início', type: 'date' }]);
    await assert.rejects(() => w.criar(Q, { titulo: 'A', descricao: 'x' }), erroAcao((e) => /campo de descrição/.test(e.message)));
    await assert.rejects(() => w.editar(Q, 'rec1', { titulo: 'B', prazo: '2026-11-20' }), erroAcao((e) => /campo de data de prazo/.test(e.message) && e.opcoes![0] === 'Início'));
    await assert.rejects(() => w.editar(Q, 'rec1', { titulo: '  ' }), erroAcao());
    assert.equal(escritas().length, 0);
  });
  test('recusa definitiva (422 e as outras) vira erro com o motivo neutralizado, sem repetir', async () => {
    const recs = servico([NOME, STATUS], { rec1: { fldNome: 'A' } }); const base = answer;
    const corpo = JSON.stringify({ error: { type: 'INVALID_VALUE_FOR_COLUMN', message: 'valor [[ruim]]\nrecusado' } });
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = (c) => (c.method !== 'GET' ? new Response(corpo, { status: n }) : base(c));
      const recusou = erroAcao((e) => /Airtable recusou.*INVALID_VALUE_FOR_COLUMN: valor \[ \[ruim\] \] recusado/.test(e.message));
      await assert.rejects(() => w.criar(Q, { titulo: 'A' }), recusou);
      await assert.rejects(() => w.mover(Q, 'rec1', 'A fazer'), recusou);
      await assert.rejects(() => w.comentar!(Q, 'rec1', 'x'), recusou);
      assert.equal(escritas().length, 3);
    }
    assert.equal(recs.size, 1);
    answer = base;
  });
  test('inverso da leitura: o prazo gravado volta; tirar volta null; sem campo de prazo fica ausente, nunca null', async () => {
    const INICIO = { id: 'fldI', name: 'Início', type: 'date' };
    servico([NOME, INICIO, PRAZO], { rec1: { fldNome: 'A', fldI: '2026-01-01' } });
    assert.equal((await na('rec1')).due, null);
    await w.editar(Q, 'rec1', { prazo: '2026-11-20' });
    assert.equal((await na('rec1')).due, '2026-11-20');
    await w.editar(Q, 'rec1', { prazo: null });
    assert.equal((await na('rec1')).due, null);
    // data e hora: o meio-dia em UTC volta no mesmo dia
    servico([NOME, { id: 'fldV', name: 'Vencimento', type: 'dateTime' }], { rec1: { fldNome: 'A' } });
    await w.editar(Q, 'rec1', { prazo: '2026-11-20' });
    assert.equal((await na('rec1')).due, '2026-11-20');
    servico([NOME, INICIO], { rec1: { fldNome: 'A', fldI: '2026-01-01' } });
    assert.equal((await na('rec1')).due, undefined);
    servico([NOME], { rec1: { fldNome: 'A' } });
    assert.equal((await na('rec1')).due, undefined);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    servico([NOME, STATUS]);
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.editar(Q, ruim, { titulo: 'B' }), erroAcao((e) => /id inválido/.test(e.message)));
      await assert.rejects(() => w.mover(Q, ruim, 'A fazer'), erroAcao((e) => /id inválido/.test(e.message)));
      await assert.rejects(() => w.comentar!(Q, ruim, 'x'), erroAcao((e) => /id inválido/.test(e.message)));
      await assert.rejects(() => w.concluir(Q, ruim, false), erroAcao((e) => /id inválido/.test(e.message)));
    }
    assert.equal(escritas().length, 0);
  });
  test('comentar', async () => {
    servico([NOME]);
    await w.comentar!(Q, 'rec1', 'feito');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, `/v0/${B}/${T}/rec1/comments`);
    assert.deepEqual(calls[0].body, { text: 'feito' });
    answer = () => ({});
    await assert.rejects(() => w.comentar!(Q, 'rec1', 'x'), erroServico('unavailable'));
  });
  test('sem permissão vira acesso recusado; escrita com 500 não repete; 200 sem id é erro; ids estranhos não mudam o endereço', async () => {
    const recs = servico([NOME]); const base = answer;
    answer = (c) => (c.method === 'POST' ? status(403) : base(c));
    await assert.rejects(() => w.criar(Q, { titulo: 'A' }), erroServico('forbidden'));
    calls.length = 0;
    answer = (c) => (c.method === 'POST' ? status(500) : base(c));
    await assert.rejects(() => w.criar(Q, { titulo: 'A' }), erroServico('unavailable'));
    assert.equal(escritas().length, 1);
    answer = (c) => (c.method === 'POST' ? {} : base(c));
    await assert.rejects(() => w.criar(Q, { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && /não confirmou/.test(e.message));
    assert.equal(recs.size, 0);
    calls.length = 0;
    answer = base;
    await w.editar(Q, '../users/me', { titulo: 'B' });
    assert.equal(escritas()[0].url.pathname, `/v0/${B}/${T}/..%2Fusers%2Fme`);
    calls.length = 0;
    await assert.rejects(() => w.editar('app1/../x', 'r', { titulo: 'B' }), erroAcao());
    assert.equal(calls.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------ Smartsheet
describe('Smartsheet: escrita', () => {
  const S = '123456';
  const w = escritorSmartsheet('tok'); const leitura = new SmartsheetProvider('tok');
  const TITULO = { id: 1, title: 'Tarefa', type: 'TEXT_NUMBER', primary: true };
  const STATUS = { id: 2, title: 'Status', type: 'PICKLIST', options: ['A fazer', 'Em andamento', 'Concluído'] };
  const FEITO = { id: 3, title: 'Feito', type: 'CHECKBOX' };
  const NOTAS = { id: 4, title: 'Notas', type: 'TEXT_NUMBER' };
  const PRAZO = { id: 5, title: 'Prazo', type: 'DATE' };
  const LINK = 'https://app.smartsheet.com/sheets/abc';
  const escritas = () => calls.filter((c) => c.method !== 'GET');

  function servico(columns: any[], inicial: Array<{ id: number; cells: Array<{ columnId: number; value: unknown }> }> = []) {
    const rows = inicial.map((r) => ({ ...r, modifiedAt: 'v0' }));
    let v = 0; let novo = 900;
    // regra estrita da documentação: lista só aceita uma das opções; vazio limpa
    const aplica = (r: any, cells: any[]) => {
      for (const c of cells) {
        const col = columns.find((x) => x.id === c.columnId);
        if (!col) return new Response(JSON.stringify({ errorCode: 1036, message: 'coluna inválida' }), { status: 400 });
        if (c.strict !== false && col.type === 'PICKLIST' && !col.options.includes(c.value)) return new Response(JSON.stringify({ errorCode: 1042, message: 'não conforme à lista' }), { status: 400 });
        r.cells = r.cells.filter((x: any) => x.columnId !== c.columnId);
        if (c.value !== '') r.cells.push({ columnId: c.columnId, value: c.value, displayValue: String(c.value) });
      }
      r.modifiedAt = `v${++v}`;
      return null;
    };
    answer = (c) => {
      const p = c.url.pathname;
      if (p === `/2.0/sheets/${S}` && c.method === 'GET') {
        const ids = c.url.searchParams.get('rowIds');
        const lim = c.url.searchParams.get('pageSize');
        return { id: Number(S), name: 'Plano', permalink: LINK, modifiedAt: 'm', columns, rows: ids ? rows.filter((r) => ids.split(',').includes(String(r.id))) : lim ? rows.slice(0, Number(lim)) : rows };
      }
      if (p === `/2.0/sheets/${S}/rows` && c.method === 'POST') {
        const r: any = { id: ++novo, cells: [] };
        const e = aplica(r, c.body[0].cells); if (e) return e;
        rows.push(r);
        return { message: 'SUCCESS', resultCode: 0, result: [r], version: 1 };
      }
      if (p === `/2.0/sheets/${S}/rows` && c.method === 'PUT') {
        const r: any = rows.find((x) => x.id === c.body[0].id);
        if (!r) return new Response(JSON.stringify({ errorCode: 1006, message: 'não encontrada' }), { status: 404 });
        const e = aplica(r, c.body[0].cells); if (e) return e;
        return { message: 'SUCCESS', resultCode: 0, result: [r], version: 2 };
      }
      if (/\/rows\/\d+\/discussions$/.test(p)) return { message: 'SUCCESS', resultCode: 0, result: { id: 7 } };
      return status(404);
    };
    return rows;
  }
  const linha = (status?: string) => ({ id: 11, cells: [{ columnId: 1, value: 'A' }, ...(status ? [{ columnId: 2, value: status }] : [])] });
  const na = async (id: string | number) => (await leitura.getBoard(S)).tasks.find((t) => t.externalId === String(id))!;

  test('criar usa os ids das colunas e a coluna principal como título; a versão é a que a leitura vê', async () => {
    servico([TITULO, STATUS, NOTAS, PRAZO]);
    const r = await w.criar(S, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'Em andamento', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: '901', versao: 'v1', url: LINK });
    const c = escritas()[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.pathname, `/2.0/sheets/${S}/rows`);
    assert.deepEqual(c.body, [{ toBottom: true, cells: [{ columnId: 1, value: 'Revisar' }, { columnId: 4, value: 'cláusula 4' }, { columnId: 5, value: '2026-11-20' }, { columnId: 2, value: 'Em andamento' }] }]);
    const t = await na(901);
    assert.equal(t.title, 'Revisar'); assert.equal(t.columnExternalId, 'Em andamento'); assert.equal(t.description, 'cláusula 4'); assert.equal(t.version, r.versao);
  });
  test('criar sem coluna vai para a primeira aberta; "Sem status" e "__tarefas__" não gravam status', async () => {
    servico([TITULO, { ...STATUS, options: ['Done', 'Fila'] }]);
    await w.criar(S, { titulo: 'A' }); await w.criar(S, { titulo: 'B', coluna: '__sem_status__' });
    assert.deepEqual(escritas()[0].body[0].cells.at(-1), { columnId: 2, value: 'Fila' });
    assert.equal(escritas()[1].body[0].cells.length, 1);
    servico([TITULO]);
    await w.criar(S, { titulo: 'C', coluna: '__tarefas__' });
    assert.equal(escritas()[2].body[0].cells.length, 1);
    assert.equal((await na(901)).columnExternalId, '__tarefas__');
  });
  test('coluna que não existe é erro com as opções, antes de gravar', async () => {
    servico([TITULO, STATUS]);
    await assert.rejects(() => w.criar(S, { titulo: 'A', coluna: 'Nada' }), erroAcao((e) => e.opcoes!.includes('A fazer')));
    assert.equal(escritas().length, 0);
  });
  test('concluir pela lista de status: a leitura vê concluída; reabrir volta', async () => {
    servico([TITULO, STATUS], [linha('Em andamento')]);
    const r = await w.concluir(S, '11', true);
    assert.equal(escritas()[0].method, 'PUT');
    assert.deepEqual(escritas()[0].body, [{ id: 11, cells: [{ columnId: 2, value: 'Concluído' }] }]);
    const t = await na(11);
    assert.equal(t.completed, true); assert.equal(t.version, r.versao);
    await w.concluir(S, '11', false);
    assert.deepEqual(escritas()[1].body[0].cells, [{ columnId: 2, value: 'A fazer' }]);
    assert.equal(calls.find((c) => c.url.searchParams.has('rowIds'))!.url.searchParams.get('rowIds'), '11');
    assert.equal((await na(11)).completed, false);
  });
  test('com caixa de seleção e status, concluir marca os dois e reabrir desfaz os dois', async () => {
    servico([TITULO, STATUS, FEITO], [linha('A fazer')]);
    await w.concluir(S, '11', true);
    assert.deepEqual(escritas()[0].body[0].cells, [{ columnId: 3, value: true }, { columnId: 2, value: 'Concluído' }]);
    await w.concluir(S, '11', false);
    assert.deepEqual(escritas()[1].body[0].cells, [{ columnId: 3, value: false }, { columnId: 2, value: 'A fazer' }]);
    assert.equal((await na(11)).completed, false);
  });
  test('só caixa de seleção: a leitura vê concluída, e o status de quem não está em "feito" não muda', async () => {
    servico([TITULO, { ...STATUS, options: ['Fila', 'Fazendo'] }, FEITO], [linha('Fazendo')]);
    await w.concluir(S, '11', true);
    assert.equal((await na(11)).completed, true);
    await w.concluir(S, '11', false);
    assert.deepEqual(escritas()[1].body[0].cells, [{ columnId: 3, value: false }]);
    assert.equal((await na(11)).completed, false);
  });
  test('planilha sem como concluir diz isso e lista as opções', async () => {
    servico([TITULO, { ...STATUS, options: ['Fila'] }], [linha('Fila')]);
    await assert.rejects(() => w.concluir(S, '11', true), erroAcao((e) => /não tem como marcar concluída/.test(e.message) && e.opcoes![0] === 'Fila'));
    assert.equal(escritas().length, 0);
  });
  test('reabrir linha que não existe é "não encontrada"', async () => {
    servico([TITULO, STATUS]);
    await assert.rejects(() => w.concluir(S, '99', false), erroServico('not_found'));
    assert.equal(escritas().length, 0);
  });
  test('mover grava a opção; "Sem status" limpa com strict false, que a regra estrita de lista recusaria', async () => {
    servico([TITULO, STATUS], [linha('A fazer')]);
    await w.mover(S, '11', 'Em andamento');
    assert.deepEqual(escritas()[0].body[0].cells, [{ columnId: 2, value: 'Em andamento' }]);
    assert.equal((await na(11)).columnExternalId, 'Em andamento');
    await w.mover(S, '11', '__sem_status__');
    assert.deepEqual(escritas()[1].body[0].cells, [{ columnId: 2, value: '', strict: false }]);
    assert.equal((await na(11)).columnExternalId, '__sem_status__');
    servico([TITULO], [linha()]);
    assert.deepEqual(await w.mover(S, '11', '__tarefas__'), { id: '11', versao: null, url: LINK });
    assert.equal(escritas().length, 2);
  });
  test('editar manda só o que mudou; prazo null limpa; texto acima do limite da célula é recusado', async () => {
    servico([TITULO, NOTAS, PRAZO], [linha()]);
    await w.editar(S, '11', { titulo: 'Novo', prazo: null });
    assert.deepEqual(escritas()[0].body, [{ id: 11, cells: [{ columnId: 1, value: 'Novo' }, { columnId: 5, value: '', strict: false }] }]);
    await assert.rejects(() => w.editar(S, '11', { descricao: 'x'.repeat(4001) }), erroAcao((e) => /4000/.test(e.message)));
    assert.equal(escritas().length, 1);
  });
  test('sem coluna de descrição ou de prazo é erro claro', async () => {
    servico([TITULO, { id: 6, title: 'Início', type: 'DATE' }], [linha()]);
    await assert.rejects(() => w.editar(S, '11', { descricao: 'x' }), erroAcao((e) => /coluna de descrição/.test(e.message)));
    await assert.rejects(() => w.criar(S, { titulo: 'A', prazo: '2026-11-20' }), erroAcao((e) => /data de prazo/.test(e.message) && e.opcoes![0] === 'Início'));
    assert.equal(escritas().length, 0);
  });
  test('recusa definitiva também vale para criar e comentar, sem repetir', async () => {
    servico([TITULO, STATUS], [linha('A fazer')]); const base = answer;
    answer = (c) => (c.method === 'POST' ? new Response(JSON.stringify({ errorCode: 1006, message: 'não encontrada' }), { status: 400 }) : base(c));
    await assert.rejects(() => w.criar(S, { titulo: 'A' }), erroAcao());
    await assert.rejects(() => w.comentar!(S, '11', 'x'), erroAcao());
    assert.equal(escritas().length, 2);
    answer = base;
  });
  test('inverso da leitura: o prazo gravado volta; tirar volta null; sem coluna de prazo fica ausente, nunca null', async () => {
    const INICIO = { id: 6, title: 'Início', type: 'DATE' };
    servico([TITULO, INICIO, PRAZO], [{ id: 11, cells: [{ columnId: 1, value: 'A' }, { columnId: 6, value: '2026-01-01' }] }]);
    assert.equal((await na(11)).due, null);
    await w.editar(S, '11', { prazo: '2026-11-20' });
    assert.equal((await na(11)).due, '2026-11-20');
    await w.editar(S, '11', { prazo: null });
    assert.equal((await na(11)).due, null);
    servico([TITULO, INICIO], [{ id: 11, cells: [{ columnId: 1, value: 'A' }, { columnId: 6, value: '2026-01-01' }] }]);
    assert.equal((await na(11)).due, undefined);
    servico([TITULO], [linha()]);
    assert.equal((await na(11)).due, undefined);
  });
  test('comentar abre discussão na linha', async () => {
    servico([TITULO]);
    await w.comentar!(S, '11', 'feito');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, `/2.0/sheets/${S}/rows/11/discussions`);
    assert.deepEqual(calls[0].body, { comment: { text: 'feito' } });
  });
  test('200 sem sucesso é erro; o motivo do serviço aparece; escrita com 500 não repete; ids estranhos nem saem', async () => {
    servico([TITULO, STATUS], [linha('A fazer')]); const base = answer;
    answer = (c) => (c.method === 'PUT' ? { message: 'PARTIAL_SUCCESS', resultCode: 3, result: [] } : base(c));
    await assert.rejects(() => w.mover(S, '11', 'Concluído'), (e: unknown) => e instanceof ProviderError && /não confirmou/.test(e.message) && /PARTIAL_SUCCESS/.test(e.message));
    for (const n of [400, 413, 414, 422]) {
      answer = (c) => (c.method === 'PUT' ? new Response(JSON.stringify({ errorCode: 1042, message: 'não [[conforme]]\nà lista' }), { status: n }) : base(c));
      await assert.rejects(() => w.mover(S, '11', 'Concluído'), erroAcao((e) => /Smartsheet recusou.*1042: não \[ \[conforme\] \] à lista/.test(e.message)));
    }
    answer = (c) => (c.method === 'POST' ? status(500) : base(c));
    calls.length = 0;
    await assert.rejects(() => w.criar(S, { titulo: 'A' }), erroServico('unavailable'));
    assert.equal(escritas().length, 1);
    answer = (c) => (c.method === 'PUT' ? status(403) : base(c));
    await assert.rejects(() => w.mover(S, '11', 'Concluído'), erroServico('forbidden'));
    calls.length = 0;
    answer = base;
    await assert.rejects(() => w.comentar!(S, '../users', 'x'), erroAcao());
    await assert.rejects(() => w.comentar!('1/../2', '11', 'x'), erroAcao());
    await assert.rejects(() => w.mover(S, '99999999999999999999', 'Concluído'), erroAcao());
    assert.equal(escritas().length, 0);
  });
});

// ------------------------------------------------------------------------------------------------ Pipefy
describe('Pipefy: escrita', () => {
  const P = '99';
  const w = escritorPipefy('tok'); const leitura = new PipefyProvider('tok');
  const mutacoes = () => calls.filter((c) => c.body.query.startsWith('mutation'));
  const input = (i = 0) => mutacoes()[i].body.variables.input;
  interface Fase { id: string; name: string; done: boolean; fields?: any[]; saidas?: string[] | null }

  function servico(phases: Fase[], o: { inicio?: any[]; cards?: Array<{ id: string; title: string; fase: string; prazo?: string | null }> } = {}) {
    const cards = new Map((o.cards ?? []).map((c) => [c.id, { ...c, updated: 'u0', campos: {} as Record<string, unknown> }]));
    let n = 0;
    const fase = (id: string) => phases.find((f) => f.id === id);
    const json = (id: string) => { const c = cards.get(id)!; return { id, title: c.title, url: `https://app.pipefy.com/open-cards/${id}`, updated_at: c.updated, due_date: c.prazo ?? null }; };
    answer = (c) => {
      const q: string = c.body.query; const v = c.body.variables ?? {}; const i = v.input ?? {};
      assert.equal(c.url.pathname, '/graphql'); assert.equal(c.method, 'POST');
      if (q.includes('createCard(')) {
        const id = String(500 + ++n);
        cards.set(id, { id, title: i.title, fase: i.phase_id ?? phases[0].id, prazo: i.due_date ?? null, updated: `u${n}`, campos: Object.fromEntries(((i.fields_attributes ?? []) as any[]).map((f) => [f.field_id, f.field_value])) });
        return { data: { createCard: { card: json(id) } } };
      }
      if (q.includes('moveCardToPhase(')) {
        const card = cards.get(i.card_id);
        const saidas = fase(card?.fase ?? '')?.saidas;
        if (saidas && !saidas.includes(i.destination_phase_id)) return { data: { moveCardToPhase: null }, errors: [{ message: 'Não pode mover', path: ['moveCardToPhase'], extensions: { code: 'PHASE_TRANSITION_ERROR' } }] };
        card!.fase = i.destination_phase_id; card!.updated = `u${100 + ++n}`;
        return { data: { moveCardToPhase: { card: { ...json(i.card_id), current_phase: { id: card!.fase } } } } };
      }
      if (q.includes('updateCard(')) {
        const card = cards.get(i.id)!;
        if (i.title !== undefined) card.title = i.title;
        if (i.due_date !== undefined) card.prazo = i.due_date;
        card.updated = `u${100 + ++n}`;
        return { data: { updateCard: { card: json(i.id) } } };
      }
      if (q.includes('updateCardField(')) {
        const card = cards.get(i.card_id)!;
        card.campos[i.field_id] = i.new_value; card.updated = `u${100 + ++n}`;
        return { data: { updateCardField: { success: true, card: json(i.card_id) } } };
      }
      if (q.includes('createComment(')) return { data: { createComment: { comment: { id: 'c1' } } } };
      if (q.includes('cards(pipe_id')) {
        return { data: { cards: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [...cards.values()].map((x) => ({ node: { id: x.id, title: x.title, done: fase(x.fase)?.done === true, updated_at: x.updated, due_date: x.prazo ?? null, current_phase: { id: x.fase }, assignees: [],
          fields: q.includes('fields') ? Object.entries(x.campos).map(([id, value]) => ({ value, field: { id } })) : undefined } })) } } };
      }
      if (q.includes('card(id: $id)')) {
        const x = cards.get(v.id);
        if (!x) return { data: { card: null }, errors: [{ message: 'Card not found', extensions: { code: 'RESOURCE_NOT_FOUND' } }] };
        const saidas = fase(x.fase)?.saidas;
        return { data: { card: { ...json(v.id), pipe: { id: P }, current_phase: { id: x.fase, cards_can_be_moved_to_phases: saidas === null ? null : (saidas ?? phases.map((f) => f.id)).map((id) => ({ id })) } } } };
      }
      if (q.includes('pipe(id: $id)')) return { data: { pipe: { name: 'Vendas', phases: phases.map((f) => ({ id: f.id, name: f.name, done: f.done, ...(q.includes('fields') ? { fields: f.fields ?? [] } : {}) })), ...(q.includes('start_form_fields') ? { start_form_fields: o.inicio ?? [] } : {}) } } };
      throw new Error(`consulta inesperada: ${q}`);
    };
    return cards;
  }
  const FASES: Fase[] = [{ id: '10', name: 'Caixa', done: false }, { id: '11', name: 'Fazendo', done: false }, { id: '12', name: 'Concluído', done: true }];
  const na = async (id: string) => (await leitura.getBoard(P)).tasks.find((t) => t.externalId === id)!;

  test('criar numa fase, com prazo e descrição no formulário inicial; a versão é a que a leitura vê', async () => {
    servico(FASES, { inicio: [{ id: 'descricao', label: 'Descrição', type: 'long_text' }] });
    const r = await w.criar(P, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: '11', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: '501', versao: 'u1', url: 'https://app.pipefy.com/open-cards/501' });
    assert.deepEqual(input(), { pipe_id: P, title: 'Revisar', phase_id: '11', due_date: '2026-11-20T12:00:00Z', fields_attributes: [{ field_id: 'descricao', field_value: 'cláusula 4' }] });
    assert.equal(mutacoes().length, 1);
    const t = await na('501');
    assert.equal(t.columnExternalId, '11'); assert.equal(t.version, r.versao); assert.equal(t.completed, false);
  });
  test('criar sem coluna deixa o Pipefy pôr na primeira fase; "__tarefas__" também', async () => {
    servico(FASES);
    await w.criar(P, { titulo: 'A' }); await w.criar(P, { titulo: 'B', coluna: '__tarefas__' });
    assert.deepEqual(input(0), { pipe_id: P, title: 'A' });
    assert.deepEqual(input(1), { pipe_id: P, title: 'B' });
  });
  test('descrição em campo de fase vai depois de criar; se falhar, avisa que o card já existe', async () => {
    servico(FASES.map((f) => (f.id === '11' ? { ...f, fields: [{ id: 'notas', label: 'Notas', type: 'long_text' }] } : f)));
    const r = await w.criar(P, { titulo: 'A', descricao: 'x' });
    assert.deepEqual(mutacoes().map((c) => c.body.query.match(/\{ (\w+)\(/)![1]), ['createCard', 'updateCardField']);
    assert.deepEqual(input(1), { card_id: '501', field_id: 'notas', new_value: 'x' });
    assert.equal(r.versao, 'u102');
    const base = answer;
    answer = (c) => (c.body.query.includes('updateCardField(') ? { data: { updateCardField: { success: false, card: null } } } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'B', descricao: 'x' }), erroAcao((e) => /foi criado \(id \d+\)/.test(e.message) && /Não crie de novo/.test(e.message)));
  });
  test('criar pela metade: o erro leva o card criado, para o espelho ligar sem duplicar', async () => {
    servico(FASES.map((f) => (f.id === '11' ? { ...f, fields: [{ id: 'notas', label: 'Notas', type: 'long_text' }] } : f))); const base = answer;
    answer = (c) => (c.body.query.includes('updateCardField(') ? { data: { updateCardField: { success: false, card: null } } } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'B', descricao: 'x' }), (e: unknown) => {
      assert.ok(e instanceof ErroAcao);
      assert.match(e.message, /foi criado \(id 501\).*Não crie de novo/);
      assert.deepEqual(e.criado, { id: '501', versao: 'u1', url: 'https://app.pipefy.com/open-cards/501' });
      return true;
    });
    // falha de acesso depois de criar também leva o card
    answer = (c) => (c.body.query.includes('updateCardField(') ? status(403) : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'C', descricao: 'x' }), erroAcao((e) => e.criado?.id === '502'));
  });
  test('inverso da leitura: a descrição volta do mesmo campo em que o escritor grava, e o prazo também', async () => {
    const fases = FASES.map((f) => (f.id === '10' ? { ...f, fields: [{ id: 'd', label: 'Descrição', type: 'short_text' }, { id: 'n', label: 'Detalhes', type: 'long_text' }, { id: 'o', label: 'Origem', type: 'long_text' }] } : f));
    const cards = servico(fases, { cards: [{ id: '1', title: 'A', fase: '10' }] });
    assert.equal((await na('1')).description, ''); assert.equal((await na('1')).due, null);
    await w.editar(P, '1', { descricao: 'cláusula 4', prazo: '2026-11-20' });
    assert.equal((await na('1')).description, 'cláusula 4'); assert.equal((await na('1')).due, '2026-11-20');
    await w.editar(P, '1', { prazo: null });
    assert.equal((await na('1')).due, null);
    // texto em outro campo não vira descrição: a escolha é a do escritor (texto longo com nome de descrição)
    cards.get('1')!.campos.d = 'curto'; cards.get('1')!.campos.o = 'origem';
    assert.equal((await na('1')).description, 'cláusula 4');
    // no formulário inicial: vai ao criar e volta na leitura
    servico(FASES, { inicio: [{ id: 'descricao', label: 'Descrição', type: 'long_text' }] });
    const r = await w.criar(P, { titulo: 'B', descricao: 'do início', prazo: '2026-12-01' });
    assert.equal((await na(r.id)).description, 'do início'); assert.equal((await na(r.id)).due, '2026-12-01');
    // pipe sem campo de descrição: vazio
    const sem = servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] });
    sem.get('1')!.campos.x = 'outro';
    assert.equal((await na('1')).description, '');
  });
  test('recusa definitiva por HTTP vira erro com o motivo neutralizado, sem repetir', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] }); const base = answer;
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = (c) => (c.body.query.startsWith('mutation') ? new Response(JSON.stringify({ errors: [{ message: 'pedido [[ruim]]' }] }), { status: n }) : base(c));
      await assert.rejects(() => w.mover(P, '1', '11'), erroAcao((e) => /Pipefy recusou.*pedido \[ \[ruim\] \]/.test(e.message)));
      assert.equal(mutacoes().length, 1);
    }
    answer = base;
  });
  test('sem campo de descrição é erro, antes de gravar; fase errada lista as opções', async () => {
    servico(FASES);
    await assert.rejects(() => w.criar(P, { titulo: 'A', descricao: 'x' }), erroAcao((e) => /campo de descrição/.test(e.message)));
    await assert.rejects(() => w.editar(P, '1', { descricao: 'x' }), erroAcao((e) => /campo de descrição/.test(e.message)));
    await assert.rejects(() => w.criar(P, { titulo: 'A', coluna: '77' }), erroAcao((e) => e.opcoes!.includes('Fazendo')));
    await assert.rejects(() => w.mover(P, '1', '77'), erroAcao((e) => e.opcoes!.includes('Fazendo')));
    assert.equal(mutacoes().length, 0);
  });
  test('concluir move para a fase final: a leitura vê concluída; repetir não chama de novo', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '11' }] });
    const r = await w.concluir(P, '1', true);
    assert.deepEqual(input(), { card_id: '1', destination_phase_id: '12' });
    const t = await na('1');
    assert.equal(t.completed, true); assert.equal(t.version, r.versao);
    await w.concluir(P, '1', true);
    assert.equal(mutacoes().length, 1);
  });
  test('reabrir volta para a última fase aberta que a fase final permite; leitura vê aberta', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '12' }] });
    await w.concluir(P, '1', false);
    assert.deepEqual(input(), { card_id: '1', destination_phase_id: '11' });
    assert.equal((await na('1')).completed, false);
    servico(FASES.map((f) => (f.done ? { ...f, saidas: ['10'] } : f)), { cards: [{ id: '1', title: 'A', fase: '12' }] });
    await w.concluir(P, '1', false);
    assert.equal(input(1).destination_phase_id, '10');
    servico(FASES.map((f) => (f.done ? { ...f, saidas: [] } : f)), { cards: [{ id: '1', title: 'A', fase: '12' }] });
    await assert.rejects(() => w.concluir(P, '1', false), erroAcao((e) => /não permite tirar/.test(e.message) && e.opcoes!.includes('Caixa')));
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await w.concluir(P, '1', false);
    assert.equal(mutacoes().length, 2);
  });
  test('pipe sem fase final não tem como concluir; com várias, escolhe a de "feito" ou pergunta', async () => {
    servico(FASES.slice(0, 2), { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await assert.rejects(() => w.concluir(P, '1', true), erroAcao((e) => /não tem fase final/.test(e.message)));
    servico([...FASES, { id: '13', name: 'Arquivado', done: true }], { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await w.concluir(P, '1', true);
    assert.equal(input().destination_phase_id, '12');
    const fins = [{ id: '10', name: 'Caixa', done: false }, { id: '12', name: 'Aprovado', done: true }, { id: '13', name: 'Reprovado', done: true }];
    servico(fins, { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await assert.rejects(() => w.concluir(P, '1', true), erroAcao((e) => /mais de uma fase final/.test(e.message) && e.opcoes!.length === 2));
    assert.equal(mutacoes().length, 1);
  });
  test('card de outro pipe é recusado', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await assert.rejects(() => w.concluir('98', '1', true), erroAcao((e) => /não é deste pipe/.test(e.message)));
  });
  test('editar: título e prazo pelo updateCard, descrição pelo updateCardField; "__tarefas__" não chama', async () => {
    servico(FASES.map((f) => (f.id === '10' ? { ...f, fields: [{ id: 'd', label: 'Descrição', type: 'short_text' }, { id: 'n', label: 'Detalhes', type: 'long_text' }] } : f)), { cards: [{ id: '1', title: 'A', fase: '10' }] });
    await w.editar(P, '1', { titulo: 'Novo', prazo: '2026-11-20', descricao: 'x' });
    assert.deepEqual(input(0), { id: '1', title: 'Novo', due_date: '2026-11-20T12:00:00Z' });
    assert.deepEqual(input(1), { card_id: '1', field_id: 'n', new_value: 'x' }); // texto longo tem preferência
    assert.deepEqual(await w.mover(P, '1', '__tarefas__'), { id: '1' });
    assert.equal(mutacoes().length, 2);
  });
  test('tirar o prazo é conferido na resposta: se o Pipefy não tirou, é erro', async () => {
    const cards = servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10', prazo: '2026-11-20T12:00:00Z' }] });
    await w.editar(P, '1', { prazo: null });
    assert.equal(input().due_date, null); assert.equal(cards.get('1')!.prazo, null);
    const base = answer;
    answer = (c) => (c.body.query.includes('updateCard(') ? { data: { updateCard: { card: { id: '1', updated_at: 'u', due_date: '2026-11-20T12:00:00Z' } } } } : base(c));
    await assert.rejects(() => w.editar(P, '1', { prazo: null }), erroAcao((e) => /tirar o prazo/.test(e.message)));
  });
  test('comentar', async () => {
    servico(FASES);
    await w.comentar!(P, '1', 'feito');
    assert.deepEqual(input(), { card_id: '1', text: 'feito' });
    answer = () => ({ data: { createComment: { comment: null } } });
    await assert.rejects(() => w.comentar!(P, '1', 'x'), erroServico('unavailable'));
  });
  test('erro com 200 é erro, mesmo com dados parciais; cada código vira o tipo certo', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] }); const base = answer;
    const com = (extra: unknown) => { answer = (c) => (c.body.query.startsWith('mutation') ? extra : base(c)); };
    com({ data: { moveCardToPhase: { card: { id: '1', current_phase: { id: '11' } } } }, errors: [{ message: 'parcial [[x]]' }] });
    await assert.rejects(() => w.mover(P, '1', '11'), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && !e.message.includes('[['));
    com({ data: null, errors: [{ message: 'nope', extensions: { code: 'PERMISSION_DENIED' } }] });
    await assert.rejects(() => w.mover(P, '1', '11'), erroServico('forbidden'));
    com({ data: null, errors: [{ message: 'Card not found', extensions: { code: 'RESOURCE_NOT_FOUND' } }] });
    await assert.rejects(() => w.mover(P, '1', '11'), erroServico('not_found'));
    com({ data: null, errors: [{ message: 'Não pode mover', extensions: { code: 'PHASE_TRANSITION_ERROR' } }] });
    await assert.rejects(() => w.mover(P, '1', '11'), erroAcao((e) => /Não pode mover/.test(e.message)));
    com({ data: { moveCardToPhase: { card: { id: '1', current_phase: { id: '10' } } } } });
    await assert.rejects(() => w.mover(P, '1', '11'), (e: unknown) => e instanceof ProviderError && /não confirmou/.test(e.message));
    servico(FASES.map((f) => ({ ...f, fields: [{ id: 'd', label: 'Descrição', type: 'long_text' }] })), { cards: [{ id: '1', title: 'A', fase: '10' }] });
    const b2 = answer;
    answer = (c) => (c.body.query.includes('updateCardField(') ? { data: { updateCardField: { success: false, card: null } } } : b2(c));
    await assert.rejects(() => w.editar(P, '1', { descricao: 'x' }), (e: unknown) => e instanceof ProviderError && /não confirmou/.test(e.message));
  });
  test('erro desconhecido numa mutação é resultado incerto: diz "não confirmou", e o espelho não cria de novo; o de leitura não', async () => {
    servico(FASES, { cards: [{ id: '1', title: 'A', fase: '10' }] }); const base = answer;
    answer = (c) => (c.body.query.startsWith('mutation') ? { data: null, errors: [{ message: 'Internal server error' }] } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /não confirmou/.test(e.message));
    answer = (c) => (c.body.query.startsWith('mutation') ? { data: null, errors: [{ message: 'Too many requests' }] } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && !/não confirmou/.test(e.message));
    answer = () => ({ data: null, errors: [{ message: 'Internal server error' }] });
    await assert.rejects(() => w.concluir(P, '1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && !/não confirmou/.test(e.message));
  });
  test('escrita com 500 não repete; pipe inválido nem sai', async () => {
    servico(FASES); const base = answer;
    answer = (c) => (c.body.query.startsWith('mutation') ? status(500) : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), erroServico('unavailable'));
    assert.equal(mutacoes().length, 1);
    calls.length = 0;
    await assert.rejects(() => w.criar('1 OR 2', { titulo: 'A' }), erroAcao());
    await assert.rejects(() => w.editar('x', '1', { titulo: 'A' }), erroAcao());
    assert.equal(calls.length, 0);
  });
});

// ------------------------------------------------------------------------------------------------ GitHub Projects
describe('GitHub Projects: escrita', () => {
  const P = 'PVT_projeto1'; const URL_P = 'https://github.com/users/eu/projects/1';
  const w = escritorGitHub('tok'); const leitura = new GitHubProjectsProvider('tok');
  const mutacoes = () => calls.filter((c) => c.body.query.startsWith('mutation'));
  const nomeM = (c: Call) => c.body.query.match(/\{ (\w+)\(/)![1];
  const input = (i = 0) => mutacoes()[i].body.variables.input;
  const OPS = [{ id: 'op1', name: 'Todo' }, { id: 'op2', name: 'In Progress' }, { id: 'op3', name: 'Done' }];
  const CAMPOS = [{ id: 'fDue', name: 'Due date', dataType: 'DATE' }, { id: 'fIni', name: 'Início', dataType: 'DATE' }, { id: 'fT', name: 'Title', dataType: 'TITLE' }];
  interface It { id: string; statusId?: string | null; statusNome?: string | null; content: any; projeto?: string; datas?: Record<string, string> }

  function servico(o: { itens?: It[]; opcoes?: Array<{ id: string; name: string }> | null; campos?: any[] } = {}) {
    const opcoes = o.opcoes === undefined ? OPS : o.opcoes;
    const itens = new Map((o.itens ?? []).map((i) => [i.id, { updatedAt: 'u0', prazo: null as string | null, ...i }]));
    let n = 0;
    const carimbo = (id: string) => { const i = itens.get(id)!; i.updatedAt = `u${++n}`; return { projectV2Item: { id, updatedAt: i.updatedAt } }; };
    answer = (c) => {
      assert.equal(c.url.pathname, '/graphql'); assert.equal(c.method, 'POST'); assert.equal(c.ua, 'Ergon');
      const q: string = c.body.query; const v = c.body.variables ?? {}; const i = v.input ?? {};
      if (q.includes('addProjectV2DraftIssue(')) {
        const id = `PVTI_novo${itens.size + 1}`;
        itens.set(id, { id, updatedAt: `u${++n}`, prazo: null, statusId: null, statusNome: null, content: { __typename: 'DraftIssue', id: `DI_${id}`, title: i.title, body: i.body ?? '' } });
        return { data: { addProjectV2DraftIssue: { projectItem: { id, updatedAt: itens.get(id)!.updatedAt } } } };
      }
      if (q.includes('updateProjectV2ItemFieldValue(')) {
        const it = itens.get(i.itemId)!;
        if (i.value.singleSelectOptionId) { it.statusId = i.value.singleSelectOptionId; it.statusNome = opcoes!.find((x) => x.id === it.statusId)!.name; } else { it.prazo = i.value.date; it.datas = { ...it.datas, [i.fieldId]: i.value.date }; }
        return { data: { updateProjectV2ItemFieldValue: carimbo(i.itemId) } };
      }
      if (q.includes('clearProjectV2ItemFieldValue(')) {
        const it = itens.get(i.itemId)!;
        if (i.fieldId === 'fStatus') { it.statusId = null; it.statusNome = null; } else { it.prazo = null; it.datas = { ...it.datas }; delete it.datas[i.fieldId]; }
        return { data: { clearProjectV2ItemFieldValue: carimbo(i.itemId) } };
      }
      if (q.includes('updateProjectV2DraftIssue(')) return { data: { updateProjectV2DraftIssue: { draftIssue: { id: i.draftIssueId } } } };
      if (q.includes('updateIssue(')) return { data: { updateIssue: { issue: { id: i.id } } } };
      if (q.includes('updatePullRequest(')) return { data: { updatePullRequest: { pullRequest: { id: i.pullRequestId } } } };
      if (q.includes('reopenIssue(')) { for (const it of itens.values()) if (it.content.id === i.issueId) it.content.state = 'OPEN'; return { data: { reopenIssue: { issue: { id: i.issueId } } } }; }
      if (q.includes('reopenPullRequest(')) { for (const it of itens.values()) if (it.content.id === i.pullRequestId) it.content.state = 'OPEN'; return { data: { reopenPullRequest: { pullRequest: { id: i.pullRequestId } } } }; }
      if (q.includes('addComment(')) return { data: { addComment: { commentEdge: { node: { id: 'IC_1' } } } } };
      if (q.includes('items(first')) {
        return { data: { node: { title: 'Roadmap', updatedAt: 'p', field: opcoes ? { options: opcoes } : null, ...(q.includes('fields(first') ? { fields: { nodes: [...(o.campos ?? CAMPOS), {}] } } : {}), items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...itens.values()].map((it) => ({
          id: it.id, updatedAt: it.updatedAt, isArchived: false, fieldValueByName: it.statusId ? { optionId: it.statusId, name: it.statusNome } : null, content: it.content,
          ...(q.includes('fieldValues(first') ? { fieldValues: { nodes: [{}, ...Object.entries(it.datas ?? {}).map(([id, date]) => ({ date, field: { id } }))] } } : {}),
        })) } } } };
      }
      if (q.includes('... on ProjectV2Item')) {
        const it = itens.get(v.id);
        if (!it) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] };
        return { data: { node: { id: it.id, updatedAt: it.updatedAt, project: { id: it.projeto ?? P }, fieldValueByName: it.statusId ? { optionId: it.statusId, name: it.statusNome } : null, content: it.content } } };
      }
      if (q.includes('... on ProjectV2')) return { data: { node: { id: P, url: URL_P, field: opcoes ? { id: 'fStatus', options: opcoes } : null, fields: { nodes: [...(o.campos ?? CAMPOS), {}] } } } };
      throw new Error(`consulta inesperada: ${q}`);
    };
    return itens;
  }
  const rascunho = (id = 'PVTI_1', statusId: string | null = 'op1'): It => ({ id, statusId, statusNome: OPS.find((o) => o.id === statusId)?.name ?? null, content: { __typename: 'DraftIssue', id: 'DI_1', title: 'A', body: '' } });
  const issue = (estado: string, statusId: string | null = 'op1', tipo = 'Issue'): It => ({ id: 'PVTI_2', statusId, statusNome: OPS.find((o) => o.id === statusId)?.name ?? null, content: { __typename: tipo, id: 'I_2', title: 'B', body: '', state: estado, url: 'https://github.com/eu/repo/issues/2', assignees: { nodes: [] } } });
  const na = async (id: string) => (await leitura.getBoard(P)).tasks.find((t) => t.externalId === id)!;

  test('criar é rascunho e depois Status por optionId, em chamadas separadas; a versão é a que a leitura vê', async () => {
    servico();
    const r = await w.criar(P, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'op2', prazo: '2026-11-20' });
    assert.deepEqual(mutacoes().map(nomeM), ['addProjectV2DraftIssue', 'updateProjectV2ItemFieldValue', 'updateProjectV2ItemFieldValue']);
    assert.deepEqual(input(0), { projectId: P, title: 'Revisar', body: 'cláusula 4' });
    assert.deepEqual(input(1), { projectId: P, itemId: r.id, fieldId: 'fStatus', value: { singleSelectOptionId: 'op2' } });
    assert.deepEqual(input(2), { projectId: P, itemId: r.id, fieldId: 'fDue', value: { date: '2026-11-20' } });
    assert.equal(r.url, URL_P);
    const t = await na(r.id);
    assert.equal(t.columnExternalId, 'op2'); assert.equal(t.title, 'Revisar'); assert.equal(t.description, 'cláusula 4'); assert.equal(t.version, r.versao);
  });
  test('criar sem coluna vai para a primeira aberta; "Sem status" não grava; coluna errada lista as opções, antes de criar', async () => {
    servico({ opcoes: [{ id: 'x', name: 'Concluído' }, { id: 'y', name: 'Fila' }] });
    await w.criar(P, { titulo: 'A' });
    assert.deepEqual(input(1).value, { singleSelectOptionId: 'y' });
    calls.length = 0;
    await w.criar(P, { titulo: 'B', coluna: '__sem_status__' });
    assert.deepEqual(mutacoes().map(nomeM), ['addProjectV2DraftIssue']);
    calls.length = 0;
    await assert.rejects(() => w.criar(P, { titulo: 'C', coluna: 'nada' }), erroAcao((e) => e.opcoes!.includes('Fila')));
    await assert.rejects(() => w.criar(P, { titulo: ' ' }), erroAcao());
    assert.equal(mutacoes().length, 0);
  });
  test('sem campo de prazo é erro antes de criar, e lista as datas que existem', async () => {
    servico({ campos: [{ id: 'fIni', name: 'Início', dataType: 'DATE' }], itens: [rascunho()] });
    await assert.rejects(() => w.criar(P, { titulo: 'A', prazo: '2026-11-20' }), erroAcao((e) => /data de prazo/.test(e.message) && e.opcoes![0] === 'Início'));
    await assert.rejects(() => w.editar(P, 'PVTI_1', { titulo: 'B', prazo: null }), erroAcao((e) => /data de prazo/.test(e.message)));
    assert.equal(mutacoes().length, 0);
  });
  test('se a coluna falha depois de criar, avisa que o item já existe (e não é erro de repetir)', async () => {
    servico(); const base = answer;
    answer = (c) => (c.body.query.includes('updateProjectV2ItemFieldValue(') ? { data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), erroAcao((e) => /foi criado \(id PVTI_novo1\)/.test(e.message) && /Não crie de novo/.test(e.message)));
  });
  test('criar pela metade: o erro leva o item criado, para o espelho ligar sem duplicar', async () => {
    servico(); const base = answer;
    answer = (c) => (c.body.query.includes('updateProjectV2ItemFieldValue(') ? { data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] } : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'A', coluna: 'op2' }), (e: unknown) => {
      assert.ok(e instanceof ErroAcao);
      assert.match(e.message, /foi criado \(id PVTI_novo1\).*Não crie de novo/);
      assert.deepEqual(e.criado, { id: 'PVTI_novo1', versao: 'u1', url: URL_P });
      return true;
    });
    // a coluna entrou e o prazo não: a marca é a da última escrita que deu certo
    let n = 0;
    answer = (c) => (c.body.query.includes('updateProjectV2ItemFieldValue(') && n++ === 1 ? status(500) : base(c));
    await assert.rejects(() => w.criar(P, { titulo: 'B', coluna: 'op2', prazo: '2026-11-20' }), erroAcao((e) => e.criado?.id === 'PVTI_novo2' && e.criado?.versao === 'u3' && e.criado?.url === URL_P));
  });
  test('inverso da leitura: o prazo gravado volta do mesmo campo; tirar volta null; sem campo de prazo fica ausente, nunca null', async () => {
    servico({ itens: [{ ...rascunho(), datas: { fIni: '2026-01-01' } }] });
    assert.equal((await na('PVTI_1')).due, null);
    await w.editar(P, 'PVTI_1', { prazo: '2026-11-20' });
    assert.equal((await na('PVTI_1')).due, '2026-11-20');
    await w.editar(P, 'PVTI_1', { prazo: null });
    assert.equal((await na('PVTI_1')).due, null);
    const r = await w.criar(P, { titulo: 'N', prazo: '2026-12-01' });
    assert.equal((await na(r.id)).due, '2026-12-01');
    servico({ campos: [{ id: 'fIni', name: 'Início', dataType: 'DATE' }], itens: [{ ...rascunho(), datas: { fIni: '2026-01-01' } }] });
    assert.equal((await na('PVTI_1')).due, undefined);
  });
  test('recusa definitiva por HTTP vira erro com o motivo neutralizado, sem repetir', async () => {
    servico({ itens: [rascunho()] }); const base = answer;
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = (c) => (c.body.query.startsWith('mutation') ? new Response(JSON.stringify({ message: 'pedido [[ruim]]' }), { status: n }) : base(c));
      await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroAcao((e) => /GitHub recusou.*pedido \[ \[ruim\] \]/.test(e.message)));
      assert.equal(mutacoes().length, 1);
    }
    answer = base;
  });
  test('concluir põe no Status de "feito": a leitura vê concluída, com a mesma versão; reabrir volta', async () => {
    servico({ itens: [rascunho()] });
    const r = await w.concluir(P, 'PVTI_1', true);
    assert.deepEqual(input(), { projectId: P, itemId: 'PVTI_1', fieldId: 'fStatus', value: { singleSelectOptionId: 'op3' } });
    const t = await na('PVTI_1');
    assert.equal(t.completed, true); assert.equal(t.version, r.versao);
    await w.concluir(P, 'PVTI_1', true);
    assert.equal(mutacoes().length, 1);
    await w.concluir(P, 'PVTI_1', false);
    assert.equal(input(1).value.singleSelectOptionId, 'op1');
    assert.equal((await na('PVTI_1')).completed, false);
  });
  test('projeto sem opção de "feito" diz que não tem como concluir; issue já fechada não precisa de nada', async () => {
    const opcoes = [{ id: 'a', name: 'Fila' }, { id: 'b', name: 'Fazendo' }];
    servico({ opcoes, itens: [rascunho('PVTI_1', null)] });
    await assert.rejects(() => w.concluir(P, 'PVTI_1', true), erroAcao((e) => /não tem como marcar concluído/.test(e.message) && e.opcoes!.includes('Fazendo')));
    servico({ opcoes, itens: [issue('CLOSED', null)] });
    await w.concluir(P, 'PVTI_2', true);
    assert.equal(mutacoes().length, 0);
    assert.equal((await na('PVTI_2')).completed, true);
    servico({ opcoes: null, itens: [rascunho('PVTI_1', null)] });
    await assert.rejects(() => w.concluir(P, 'PVTI_1', true), erroAcao());
  });
  test('reabrir issue fechada reabre no repositório, senão a leitura continuaria vendo concluída', async () => {
    servico({ itens: [issue('CLOSED', 'op3')] });
    const r = await w.concluir(P, 'PVTI_2', false);
    assert.deepEqual(mutacoes().map(nomeM), ['reopenIssue', 'updateProjectV2ItemFieldValue']);
    assert.deepEqual(input(0), { issueId: 'I_2' });
    assert.equal(r.url, 'https://github.com/eu/repo/issues/2');
    assert.equal((await na('PVTI_2')).completed, false);
  });
  test('reabrir pull request fechado usa a mutação dele; mesclado não reabre', async () => {
    servico({ itens: [issue('CLOSED', 'op2', 'PullRequest')] });
    await w.concluir(P, 'PVTI_2', false);
    assert.deepEqual(mutacoes().map(nomeM), ['reopenPullRequest']);
    assert.deepEqual(input(), { pullRequestId: 'I_2' });
    assert.equal((await na('PVTI_2')).completed, false);
    servico({ itens: [issue('MERGED', 'op3', 'PullRequest')] });
    await assert.rejects(() => w.concluir(P, 'PVTI_2', false), erroAcao((e) => /mesclado/.test(e.message)));
    assert.equal(mutacoes().length, 1);
  });
  test('reabrir sem opção aberta limpa o Status; item de outro projeto é recusado', async () => {
    servico({ opcoes: [{ id: 'op3', name: 'Done' }], itens: [rascunho('PVTI_1', 'op3')] });
    await w.concluir(P, 'PVTI_1', false);
    assert.deepEqual(mutacoes().map(nomeM), ['clearProjectV2ItemFieldValue']);
    assert.deepEqual(input(), { projectId: P, itemId: 'PVTI_1', fieldId: 'fStatus' });
    assert.equal((await na('PVTI_1')).completed, false);
    servico({ itens: [{ ...rascunho(), projeto: 'PVT_outro' }] });
    await assert.rejects(() => w.concluir(P, 'PVTI_1', true), erroAcao((e) => /não é deste projeto/.test(e.message)));
    await assert.rejects(() => w.comentar!(P, 'PVTI_1', 'x'), erroAcao());
  });
  test('mover grava a opção; "Sem status" limpa o campo; sem campo Status não chama', async () => {
    servico({ itens: [rascunho()] });
    const r = await w.mover(P, 'PVTI_1', 'op2');
    assert.deepEqual(input().value, { singleSelectOptionId: 'op2' });
    const t = await na('PVTI_1');
    assert.equal(t.columnExternalId, 'op2'); assert.equal(t.version, r.versao);
    await w.mover(P, 'PVTI_1', '__sem_status__');
    assert.equal(nomeM(mutacoes()[1]), 'clearProjectV2ItemFieldValue');
    assert.equal((await na('PVTI_1')).columnExternalId, '__sem_status__');
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'nada'), erroAcao((e) => e.opcoes!.includes('Todo')));
    servico({ opcoes: null, itens: [rascunho('PVTI_1', null)] });
    assert.deepEqual(await w.mover(P, 'PVTI_1', '__sem_status__'), { id: 'PVTI_1' });
    assert.equal(mutacoes().length, 2);
  });
  test('editar usa o id do conteúdo e a mutação de cada tipo; manda só o que mudou', async () => {
    servico({ itens: [rascunho(), issue('OPEN')] });
    assert.deepEqual(await w.editar(P, 'PVTI_1', { titulo: 'Novo' }), { id: 'PVTI_1', versao: null, url: URL_P });
    assert.equal(nomeM(mutacoes()[0]), 'updateProjectV2DraftIssue');
    assert.deepEqual(input(0), { draftIssueId: 'DI_1', title: 'Novo' });
    await w.editar(P, 'PVTI_2', { descricao: 'corpo' });
    assert.equal(nomeM(mutacoes()[1]), 'updateIssue');
    assert.deepEqual(input(1), { id: 'I_2', body: 'corpo' });
    servico({ itens: [issue('OPEN', 'op1', 'PullRequest')] });
    await w.editar(P, 'PVTI_2', { titulo: 'T', descricao: 'c' });
    assert.equal(nomeM(mutacoes()[2]), 'updatePullRequest');
    assert.deepEqual(input(2), { pullRequestId: 'I_2', title: 'T', body: 'c' });
  });
  test('editar o prazo: data no campo certo; null limpa; item sem conteúdo acessível é erro claro', async () => {
    const itens = servico({ itens: [rascunho()] });
    const r = await w.editar(P, 'PVTI_1', { prazo: '2026-11-20' });
    assert.deepEqual(input(0), { projectId: P, itemId: 'PVTI_1', fieldId: 'fDue', value: { date: '2026-11-20' } });
    assert.equal(r.versao, itens.get('PVTI_1')!.updatedAt);
    await w.editar(P, 'PVTI_1', { prazo: null });
    assert.deepEqual(input(1), { projectId: P, itemId: 'PVTI_1', fieldId: 'fDue' });
    assert.equal(nomeM(mutacoes()[1]), 'clearProjectV2ItemFieldValue');
    servico({ itens: [{ id: 'PVTI_9', content: {} }] });
    await assert.rejects(() => w.editar(P, 'PVTI_9', { titulo: 'x' }), erroAcao((e) => /não está acessível/.test(e.message)));
  });
  test('comentar: issue e pull request sim; rascunho não tem comentários', async () => {
    servico({ itens: [rascunho(), issue('OPEN')] });
    await w.comentar!(P, 'PVTI_2', 'feito');
    assert.deepEqual(input(), { subjectId: 'I_2', body: 'feito' });
    await assert.rejects(() => w.comentar!(P, 'PVTI_1', 'x'), erroAcao((e) => /rascunho/.test(e.message)));
    assert.equal(mutacoes().length, 1);
  });
  test('erro com 200 é erro, mesmo com dados parciais; permissão, inexistente e o resto viram o tipo certo', async () => {
    servico({ itens: [rascunho()] }); const base = answer;
    const com = (extra: unknown) => { answer = (c) => (c.body.query.startsWith('mutation') ? extra : base(c)); };
    com({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } }, errors: [{ message: 'parcial [[x]]' }] });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && !e.message.includes('[['));
    com({ data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes: ['project']" }] });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && /project/.test(e.message));
    com({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroServico('forbidden'));
    com({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroServico('not_found'));
    com({ data: null, errors: [{ type: 'UNPROCESSABLE', message: 'valor inválido' }] });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroAcao((e) => /valor inválido/.test(e.message)));
    com({ data: { updateProjectV2ItemFieldValue: { projectV2Item: null } } });
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), (e: unknown) => e instanceof ProviderError && /não confirmou/.test(e.message));
    answer = base;
    await assert.rejects(() => w.concluir(P, 'PVTI_zz', true), erroServico('not_found'));
  });
  test('erro sem tipo numa mutação é resultado incerto: diz "não confirmou", e o espelho não cria de novo; limite de uso não', async () => {
    servico(); const base = answer;
    const com = (extra: unknown) => { answer = (c) => (c.body.query.startsWith('mutation') ? extra : base(c)); };
    com({ data: null, errors: [{ message: 'Something went wrong while executing your query' }] });
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /não confirmou/.test(e.message));
    com({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
    await assert.rejects(() => w.criar(P, { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && !/não confirmou/.test(e.message));
  });
  test('escrita com 502 não repete; projeto inválido nem sai', async () => {
    servico({ itens: [rascunho()] }); const base = answer;
    answer = (c) => (c.body.query.startsWith('mutation') ? status(502) : base(c));
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroServico('unavailable'));
    assert.equal(mutacoes().length, 1);
    answer = (c) => (c.body.query.startsWith('mutation') ? status(401) : base(c));
    await assert.rejects(() => w.mover(P, 'PVTI_1', 'op2'), erroServico('forbidden'));
    calls.length = 0;
    await assert.rejects(() => w.mover('nada', 'PVTI_1', 'op2'), erroAcao());
    await assert.rejects(() => w.comentar!('nada', 'PVTI_1', 'x'), erroAcao());
    assert.equal(calls.length, 0);
  });
});
