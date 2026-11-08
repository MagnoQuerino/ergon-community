// Escrita no monday.com, Notion e Linear (sem rede): método, endereço, credencial e corpo de cada chamada, e o principal:
// cada serviço simulado guarda o estado, então a leitura real (getBoard) confere depois se a escrita apareceu.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { escritorLinear } from '../src/services/conexoes/escrita/linear.ts';
import { escritorMonday } from '../src/services/conexoes/escrita/monday.ts';
import { escritorNotion } from '../src/services/conexoes/escrita/notion.ts';
import { ErroAcao } from '../src/services/conexoes/tipos.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { LinearProvider, MondayProvider, NotionProvider } from '../src/services/task-providers.ts';
import { setHttpClock } from '../src/lib/http.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => { throw new Error('resposta não definida no teste'); };
const realFetch = globalThis.fetch;
before(() => {
  setHttpClock({ sleep: async () => undefined });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
afterEach(() => { calls.length = 0; });

const acao = (trecho?: RegExp) => (e: unknown) => e instanceof ErroAcao && (!trecho || trecho.test(e.message));
const provedor = (kind: string, trecho?: RegExp) => (e: unknown) => e instanceof ProviderError && e.kind === kind && (!trecho || trecho.test(e.message));
const mutacoes = () => calls.filter((c) => /^mutation/.test(String(c.body?.query ?? '')));
const semColchetes = (e: unknown) => { const x = e as ErroAcao; assert.ok(!`${x.message} ${(x.opcoes ?? []).join(' ')}`.includes('[[')); return true; };

// ------------------------------------------------------------------------------------------------------- monday.com
const COL_STATUS = { id: 'status', title: 'Status', type: 'status', settings: { type: 'status', labels: [{ id: 5, index: 3, label: '' }, { id: 0, index: 0, label: 'Working on it' }, { id: 1, index: 1, label: 'Done', is_done: true }, { id: 2, index: 2, label: 'Stuck' }] } };
const COL_NOTAS = { id: 'notas', title: 'Notas', type: 'long_text', settings: null };
const COL_PRAZO = { id: 'data7', title: 'Prazo', type: 'date', settings: null };
const COL_PRIORIDADE = { id: 'prio', title: 'Prioridade', type: 'status', settings: { labels: [{ id: 0, index: 0, label: 'Alta' }, { id: 1, index: 1, label: 'Baixa' }] } };

/** Serviço simulado: guarda os valores e responde tanto a leitura real quanto as consultas e mutações do escritor. */
function mondayFake(o: { colunas?: any[]; valores?: Record<string, string | null>; semColumnValues?: boolean } = {}) {
  const colunas = o.colunas ?? [COL_STATUS, COL_NOTAS, COL_PRAZO];
  const grupos = [{ id: 'g1', title: 'A fazer', position: '1' }, { id: 'g2', title: 'Fazendo', position: '2' }];
  const it: any = { id: '10', name: 'Item', updated_at: 'v1', url: 'https://x.monday.com/boards/1/pulses/10', group: { id: 'g1' }, valores: { ...(o.valores ?? {}) } };
  const vista = () => ({ id: it.id, name: it.name, updated_at: it.updated_at, url: it.url, group: it.group, column_values: o.semColumnValues ? [] : colunas.map((c) => ({ id: c.id, type: c.type, text: it.valores[c.id] ?? null })) });
  const toca = () => { it.updated_at = 'v2'; return { id: it.id, url: it.url, updated_at: 'v2' }; };
  return { it, resposta: (c: Call): unknown => {
    const q = String(c.body.query); const v = c.body.variables;
    if (q.includes('items_page')) return { data: { boards: [{ id: '1', name: 'Q', updated_at: 'b1', columns: colunas, groups: grupos, items_page: { cursor: null, items: [vista()] } }] } };
    if (q.includes('create_item')) return { data: { create_item: { id: '99', url: 'https://x.monday.com/boards/1/pulses/99', updated_at: 'v9' } } };
    if (q.includes('change_simple_column_value')) {
      const col = colunas.find((x) => x.id === v.c);
      const settings = typeof col.settings === 'string' ? JSON.parse(col.settings) : col.settings;
      it.valores[v.c] = v.s === '' ? null : settings.labels.find((l: any) => String(l.id) === v.s).label;
      return { data: { change_simple_column_value: toca() } };
    }
    if (q.includes('change_multiple_column_values')) {
      for (const [k, x] of Object.entries(JSON.parse(v.v) as Record<string, any>)) { if (k === 'name') it.name = x; else it.valores[k] = x?.date ?? x?.text ?? null; }
      return { data: { change_multiple_column_values: toca() } };
    }
    if (q.includes('move_item_to_group')) { it.group = { id: v.g }; return { data: { move_item_to_group: toca() } }; }
    if (q.includes('create_update')) return { data: { create_update: { id: '777' } } };
    if (q.includes('items(ids')) return { data: { boards: [{ columns: colunas }], items: [vista()] } };
    if (q.includes('boards(ids')) return { data: { boards: [{ columns: colunas, groups: grupos }] } };
    throw new Error(`consulta inesperada: ${q}`);
  } };
}

describe('monday.com: escrita', () => {
  const w = escritorMonday('tok');
  const leitura = () => new MondayProvider('tok').getBoard('1');

  test('criar: endereço, token sem Bearer, variáveis (nada do modelo na consulta), JSON em texto e o retorno', async () => {
    answer = mondayFake().resposta;
    const r = await w.criar('1', { titulo: ' Revisar ', descricao: 'cláusula 4', coluna: 'g2', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: '99', versao: 'v9', url: 'https://x.monday.com/boards/1/pulses/99' });
    const c = mutacoes()[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.monday.com/v2'); assert.equal(c.headers.Authorization, 'tok');
    assert.equal(c.headers['API-Version'], undefined);
    assert.equal(c.body.variables.b, '1'); assert.equal(c.body.variables.g, 'g2'); assert.equal(c.body.variables.n, 'Revisar');
    assert.equal(typeof c.body.variables.v, 'string');
    assert.deepEqual(JSON.parse(c.body.variables.v), { notas: { text: 'cláusula 4' }, data7: { date: '2026-11-20' } });
    assert.ok(!c.body.query.includes('Revisar') && !c.body.query.includes('g2'));
    assert.ok(!c.body.query.includes('settings_str'));
  });
  test('criar sem coluna, ou na sintética, não manda grupo nem consulta o quadro', async () => {
    answer = mondayFake().resposta;
    await w.criar('1', { titulo: 'A' }); await w.criar('1', { titulo: 'B', coluna: '__tarefas__' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.variables, { b: '1', n: 'A' });
    assert.deepEqual(calls[1].body.variables, { b: '1', n: 'B' });
  });
  test('parâmetro errado vira erro claro, antes de escrever', async () => {
    answer = mondayFake({ colunas: [COL_STATUS] }).resposta;
    await assert.rejects(() => w.criar('1', { titulo: 'A', coluna: 'nao-existe' }), (e: unknown) => acao(/não tem a coluna/)(e) && (e as ErroAcao).opcoes!.includes('A fazer (g1)'));
    await assert.rejects(() => w.criar('1', { titulo: 'A', descricao: 'x' }), acao(/texto longo/));
    await assert.rejects(() => w.criar('1', { titulo: 'A', prazo: '2026-11-20' }), acao(/coluna de data/));
    await assert.rejects(() => w.criar('1', { titulo: '   ' }), acao(/vazio/));
    await assert.rejects(() => w.criar('1', { titulo: 'x'.repeat(256) }), acao(/255/));
    await assert.rejects(() => w.criar('abc', { titulo: 'A' }), acao(/quadro inválido/));
    await assert.rejects(() => w.concluir('1', '10"){}', true), acao(/tarefa inválida/));
    await assert.rejects(() => w.editar('1', '10', {}), acao(/nada para mudar/));
    assert.equal(mutacoes().length, 0);
  });
  test('descrição acima do limite é erro, não corte; prazo inválido idem', async () => {
    answer = mondayFake().resposta;
    await assert.rejects(() => w.criar('1', { titulo: 'A', descricao: 'x'.repeat(2001) }), acao(/2000/));
    await assert.rejects(() => w.editar('1', '10', { prazo: '20/11/2026' }), acao(/AAAA-MM-DD/));
    assert.equal(mutacoes().length, 0);
  });
  test('várias colunas de data: usa a do prazo; sem nenhuma com esse nome, pergunta', async () => {
    const inicio = { id: 'd1', title: 'Início', type: 'date', settings: null };
    answer = mondayFake({ colunas: [inicio, COL_PRAZO] }).resposta;
    await w.editar('1', '10', { prazo: '2026-12-01' });
    assert.deepEqual(JSON.parse(mutacoes()[0].body.variables.v), { data7: { date: '2026-12-01' } });
    answer = mondayFake({ colunas: [inicio, { id: 'd2', title: 'Fim', type: 'date', settings: null }] }).resposta;
    await assert.rejects(() => w.editar('1', '10', { prazo: '2026-12-01' }), (e: unknown) => acao(/várias colunas de data/)(e) && (e as ErroAcao).opcoes!.length === 2);
  });
  test('concluir: a próxima leitura vê concluída; reabrir: não vê mais', async () => {
    const f = mondayFake({ valores: { status: 'Working on it' } }); answer = f.resposta;
    assert.equal((await leitura()).tasks[0].completed, false);
    const r = await w.concluir('1', '10', true);
    assert.deepEqual(r, { id: '10', versao: 'v2', url: f.it.url });
    const c = mutacoes()[0];
    assert.ok(c.body.query.includes('change_simple_column_value'));
    assert.deepEqual(c.body.variables, { b: '1', i: '10', c: 'status', s: '1' }); // o id da etiqueta, não o nome
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir('1', '10', false);
    assert.equal(mutacoes()[1].body.variables.s, '', '"Working on it" e "Stuck" não são "em aberto": limpa');
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('reabrir: etiqueta com nome de aberto, venha onde vier; sem ela, limpa a coluna', async () => {
    const labels = [{ id: 2, index: 0, label: 'Parado' }, { id: 1, index: 1, label: 'Done', is_done: true }, { id: 3, index: 2, label: 'A fazer' }];
    let f = mondayFake({ colunas: [{ ...COL_STATUS, settings: { labels } }], valores: { status: 'Done' } }); answer = f.resposta;
    await w.concluir('1', '10', false);
    assert.equal(mutacoes()[0].body.variables.s, '3');
    assert.equal((await leitura()).tasks[0].completed, false);
    // só etiquetas de concluído também limpa: não é mais erro
    calls.length = 0;
    f = mondayFake({ colunas: [{ ...COL_STATUS, settings: { labels: [{ id: 1, index: 0, label: 'Done', is_done: true }] } }], valores: { status: 'Done' } }); answer = f.resposta;
    await w.concluir('1', '10', false);
    assert.deepEqual(mutacoes()[0].body.variables, { b: '1', i: '10', c: 'status', s: '' });
    assert.equal(f.it.valores.status, null);
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('reabrir limpando: a leitura passa à próxima coluna de status; se ela diz concluído, avisa em vez de fingir', async () => {
    const fase = { id: 'fase', title: 'Fase', type: 'status', settings: { labels: [{ id: 1, index: 0, label: 'Feito' }] } };
    answer = mondayFake({ colunas: [COL_STATUS, fase], valores: { status: 'Done', fase: 'Feito' } }).resposta;
    await assert.rejects(() => w.concluir('1', '10', false), acao(/"Fase"/));
    assert.equal(mutacoes().length, 0);
    // a próxima coluna não diz concluído: limpar basta
    const f = mondayFake({ colunas: [COL_STATUS, COL_PRIORIDADE], valores: { status: 'Done', prio: 'Alta' } }); answer = f.resposta;
    await w.concluir('1', '10', false);
    assert.equal(mutacoes()[0].body.variables.s, '');
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('prazo: só em coluna com nome de prazo, mesmo com uma coluna de data só; limpar nela não mexe', async () => {
    const inicio = { id: 'd1', title: 'Início', type: 'date', settings: null };
    answer = mondayFake({ colunas: [inicio] }).resposta;
    await assert.rejects(() => w.editar('1', '10', { prazo: '2026-12-01' }), (e: unknown) => acao(/não se chama prazo/)(e) && (e as ErroAcao).opcoes!.join() === 'Início');
    await assert.rejects(() => w.criar('1', { titulo: 'A', prazo: '2026-12-01' }), acao(/não se chama prazo/));
    assert.deepEqual(await w.editar('1', '10', { prazo: null }), { id: '10' });
    assert.equal(mutacoes().length, 0);
  });
  test('inverso da leitura: o prazo gravado volta; tirar volta null; sem coluna de prazo fica ausente, nunca null', async () => {
    answer = mondayFake().resposta;
    assert.equal((await leitura()).tasks[0].due, null);
    await w.editar('1', '10', { prazo: '2026-11-20' });
    assert.equal((await leitura()).tasks[0].due, '2026-11-20');
    await w.editar('1', '10', { prazo: null });
    assert.equal((await leitura()).tasks[0].due, null);
    const inicio = { id: 'd1', title: 'Início', type: 'date', settings: null };
    answer = mondayFake({ colunas: [COL_STATUS, inicio], valores: { d1: '2026-01-01' } }).resposta;
    assert.equal((await leitura()).tasks[0].due, undefined);
    answer = mondayFake({ colunas: [COL_STATUS] }).resposta;
    assert.equal((await leitura()).tasks[0].due, undefined);
    // a mesma que o escritor grava, não a primeira de data
    answer = mondayFake({ colunas: [inicio, COL_PRAZO], valores: { d1: '2026-01-01', data7: '2026-02-02' } }).resposta;
    assert.equal((await leitura()).tasks[0].due, '2026-02-02');
    await w.editar('1', '10', { prazo: '2026-03-03' });
    assert.equal((await leitura()).tasks[0].due, '2026-03-03');
  });
  test('recusa definitiva vira erro com o motivo neutralizado, sem repetir', async () => {
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = () => new Response(JSON.stringify({ errors: [{ message: 'pedido [[ruim]]\nrecusado' }] }), { status: n });
      await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), (e: unknown) => acao(/recusou.*pedido \[ \[ruim\] \] recusado/)(e) && semColchetes(e));
      assert.equal(calls.length, 1);
    }
  });
  test('concluir o que já está feito e reabrir o que está aberto não mexem', async () => {
    answer = mondayFake({ valores: { status: 'Done' } }).resposta;
    const r = await w.concluir('1', '10', true);
    assert.equal(r.id, '10'); assert.equal(mutacoes().length, 0);
    answer = mondayFake({ valores: { status: 'Stuck' } }).resposta;
    await w.concluir('1', '10', false);
    answer = mondayFake().resposta;
    await w.concluir('1', '10', false);
    assert.equal(mutacoes().length, 0);
  });
  test('quadro sem coluna de status, ou com status calculado que não vem na leitura: erro, sem escrever', async () => {
    answer = mondayFake({ colunas: [COL_NOTAS] }).resposta;
    await assert.rejects(() => w.concluir('1', '10', true), acao(/não tem como marcar concluído/));
    answer = mondayFake({ semColumnValues: true }).resposta;
    await assert.rejects(() => w.concluir('1', '10', true), acao(/não tem como marcar concluído/));
    assert.equal(mutacoes().length, 0);
  });
  test('sem etiqueta que a leitura entenda como feita: erro listando as que existem', async () => {
    const labels = [{ id: 1, index: 0, label: 'Pronto', is_done: true }, { id: 2, index: 1, label: 'Parado' }, { id: 3, index: 2, label: 'Velho Done', is_deactivated: true }];
    answer = mondayFake({ colunas: [{ ...COL_STATUS, settings: { labels } }] }).resposta;
    await assert.rejects(() => w.concluir('1', '10', true), (e: unknown) => acao(/não tem como marcar concluído/)(e) && (e as ErroAcao).opcoes!.join() === 'Pronto,Parado');
    assert.equal(mutacoes().length, 0);
  });
  test('duas colunas de status: escreve na que a leitura vai olhar', async () => {
    // Prioridade vazia antes: a leitura pula e lê Status
    let f = mondayFake({ colunas: [COL_PRIORIDADE, COL_STATUS], valores: { status: 'Stuck' } }); answer = f.resposta;
    await w.concluir('1', '10', true);
    assert.equal(mutacoes()[0].body.variables.c, 'status');
    assert.equal((await leitura()).tasks[0].completed, true);
    // Status antes da Prioridade preenchida: escreve no Status
    calls.length = 0;
    f = mondayFake({ colunas: [COL_STATUS, COL_PRIORIDADE], valores: { prio: 'Alta' } }); answer = f.resposta;
    await w.concluir('1', '10', true);
    assert.equal(mutacoes()[0].body.variables.c, 'status');
    assert.equal((await leitura()).tasks[0].completed, true);
    // Prioridade preenchida antes: a leitura nunca veria a conclusão. Erro, em vez de fingir que fez
    calls.length = 0;
    answer = mondayFake({ colunas: [COL_PRIORIDADE, COL_STATUS], valores: { prio: 'Alta', status: 'Stuck' } }).resposta;
    await assert.rejects(() => w.concluir('1', '10', true), acao(/"Prioridade" vem antes/));
    assert.equal(mutacoes().length, 0);
  });
  test('settings em texto também é entendido', async () => {
    answer = mondayFake({ colunas: [{ ...COL_STATUS, settings: JSON.stringify(COL_STATUS.settings) }], valores: { status: 'Stuck' } }).resposta;
    await w.concluir('1', '10', true);
    assert.equal(mutacoes()[0].body.variables.s, '1');
  });
  test('mover usa o grupo; a leitura vê a nova coluna; a sintética não chama nada; grupo inexistente lista as opções', async () => {
    answer = mondayFake().resposta;
    const r = await w.mover('1', '10', 'g2');
    assert.equal(r.versao, 'v2');
    assert.deepEqual(mutacoes()[0].body.variables, { i: '10', g: 'g2' });
    assert.equal((await leitura()).tasks[0].columnExternalId, 'g2');
    calls.length = 0;
    assert.deepEqual(await w.mover('1', '10', '__tarefas__'), { id: '10' });
    assert.equal(calls.length, 0);
    await assert.rejects(() => w.mover('1', '10', 'zzz'), acao(/não tem a coluna/));
    assert.equal(mutacoes().length, 0);
  });
  test('editar manda tudo numa chamada; null limpa; só título não consulta o quadro', async () => {
    answer = mondayFake().resposta;
    await w.editar('1', '10', { titulo: 'Novo', descricao: '', prazo: null });
    const c = mutacoes()[0];
    assert.ok(c.body.query.includes('change_multiple_column_values'));
    assert.equal(typeof c.body.variables.v, 'string');
    assert.deepEqual(JSON.parse(c.body.variables.v), { name: 'Novo', notas: null, data7: null });
    calls.length = 0;
    await w.editar('1', '10', { titulo: 'Só' });
    assert.equal(calls.length, 1);
  });
  test('limpar o que o quadro não tem não é erro nem chama mutação', async () => {
    answer = mondayFake({ colunas: [COL_STATUS] }).resposta;
    assert.deepEqual(await w.editar('1', '10', { descricao: '', prazo: null }), { id: '10' });
    assert.equal(mutacoes().length, 0);
  });
  test('comentar', async () => {
    answer = mondayFake().resposta;
    await w.comentar!('1', '10', 'feito');
    assert.ok(mutacoes()[0].body.query.includes('create_update'));
    assert.deepEqual(mutacoes()[0].body.variables, { i: '10', t: 'feito' });
    await assert.rejects(() => w.comentar!('1', '10', '  '), acao(/vazio/));
  });
  test('200 com errors nunca é sucesso, mesmo com dados parciais', async () => {
    answer = () => ({ data: { move_item_to_group: { id: '10' }, boards: [{ columns: [], groups: [{ id: 'g2', title: 'B' }] }] }, errors: [{ message: 'valor [[ruim]]\nrecusado', extensions: { code: 'ColumnValueException', status_code: 200 } }] });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), (e: unknown) => acao(/valor \[ \[ruim\] \] recusado/)(e) && semColchetes(e));
    answer = () => ({ errors: [{ message: 'Sem acesso', extensions: { code: 'UserUnauthorizedException', status_code: 403 } }], data: [] });
    await assert.rejects(() => w.comentar!('1', '10', 'x'), provedor('forbidden'));
    answer = () => ({ errors: [{ message: 'Item', extensions: { code: 'ResourceNotFoundException' } }] });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), provedor('not_found'));
    answer = () => ({ errors: [{ message: 'Bloqueada', extensions: { code: 'API_TEMPORARILY_BLOCKED' } }] });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), provedor('unavailable'));
  });
  test('erro interno com 200 numa mutação é resultado incerto: diz "não confirmou", e o espelho não cria de novo; bloqueio passageiro não', async () => {
    answer = () => ({ errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    await assert.rejects(() => w.criar('1', { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    answer = () => ({ errors: [{ message: 'Bloqueada', extensions: { code: 'API_TEMPORARILY_BLOCKED' } }] });
    await assert.rejects(() => w.criar('1', { titulo: 'A' }), (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
    answer = () => ({ errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    await assert.rejects(() => w.concluir('1', '10', true), (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
  });
  test('formato antigo de erro e resposta sem o item também não são sucesso', async () => {
    answer = () => ({ error_code: 'ColumnValueException', error_message: 'etiqueta inexistente', status_code: 200 });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), acao(/etiqueta inexistente/));
    answer = () => ({ data: { change_multiple_column_values: null } });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    answer = () => ({ data: { create_update: null } });
    await assert.rejects(() => w.comentar!('1', '10', 'x'), provedor('unavailable', /não confirmou/));
  });
  test('escrita não repete às cegas: 500 e queda de conexão fazem uma tentativa só', async () => {
    answer = () => new Response('{}', { status: 500 });
    await assert.rejects(() => w.comentar!('1', '10', 'x'), provedor('unavailable', /respondeu 500/));
    assert.equal(calls.length, 1);
    calls.length = 0;
    answer = () => { throw new Error('socket hang up'); };
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    assert.equal(calls.length, 1);
  });
  test('credencial recusada vira erro de acesso, sem repetir o token', async () => {
    answer = () => new Response('{}', { status: 401 });
    await assert.rejects(() => w.editar('1', '10', { titulo: 'A' }), (e: unknown) => provedor('forbidden')(e) && !(e as Error).message.includes('tok'));
  });
});

// ------------------------------------------------------------------------------------------------------------ Notion
const DS = '11111111-1111-1111-1111-111111111111';
const PG = '22222222-2222-2222-2222-222222222222';
const OP = { todo: { id: 'o-todo', name: 'Não iniciado' }, doing: { id: 'o-doing', name: 'Em andamento' }, done: { id: 'o-done', name: 'Encerrado' } };
const STATUS = { type: 'status', status: { options: [OP.todo, OP.doing, OP.done], groups: [{ name: 'To-do', option_ids: ['o-todo'] }, { name: 'In progress', option_ids: ['o-doing'] }, { name: 'Complete', option_ids: ['o-done'] }] } };
const BASE_COMPLETA = { Nome: { type: 'title', title: {} }, Status: STATUS, Descrição: { type: 'rich_text', rich_text: {} }, Prazo: { type: 'date', date: {} } };

function notionFake(properties: Record<string, any> = BASE_COMPLETA, inicial: Record<string, any> = {}) {
  const pagina: any = { object: 'page', id: PG, url: 'https://www.notion.so/p', last_edited_time: 'n1', properties: { Nome: { title: [{ plain_text: 'Tarefa' }] }, ...inicial } };
  const texto = (rs: any[]) => rs.map((r) => ({ plain_text: r.text.content }));
  const aplica = (v: Record<string, any>) => {
    for (const [k, x] of Object.entries(v)) {
      if ('status' in x || 'select' in x) {
        const t = 'status' in x ? 'status' : 'select';
        const op = x[t] && ((properties[k][t].options as any[]).find((o) => o.id === x[t].id));
        pagina.properties[k] = { [t]: op ?? null };
      } else if ('title' in x) pagina.properties[k] = { title: texto(x.title) };
      else if ('rich_text' in x) pagina.properties[k] = { rich_text: texto(x.rich_text) };
      else pagina.properties[k] = x;
    }
    pagina.last_edited_time = 'n2';
  };
  return { pagina, resposta: (c: Call): unknown => {
    const p = c.url.pathname;
    if (c.method === 'GET' && p === `/v1/data_sources/${DS}`) return { id: DS, title: [{ plain_text: 'Base' }], last_edited_time: 'b1', properties };
    if (c.method === 'POST' && p === `/v1/data_sources/${DS}/query`) return { results: [pagina], has_more: false, next_cursor: null };
    if (c.method === 'GET' && p === `/v1/pages/${PG}`) return pagina;
    if (c.method === 'PATCH' && p === `/v1/pages/${PG}`) { aplica(c.body.properties); return pagina; }
    if (c.method === 'POST' && p === '/v1/pages') return { object: 'page', id: PG, url: 'https://www.notion.so/novo', last_edited_time: 'n9', properties: {} };
    if (c.method === 'POST' && p === '/v1/comments') return { object: 'comment', id: 'c1' };
    throw new Error(`chamada inesperada: ${c.method} ${p}`);
  } };
}

describe('Notion: escrita', () => {
  const w = escritorNotion('tok');
  const leitura = () => new NotionProvider('tok').getBoard(DS);
  const patch = () => calls.filter((c) => c.method === 'PATCH');

  test('criar em base: parent de fonte de dados, título, descrição, prazo e coluna; mesma versão e credencial da leitura', async () => {
    answer = notionFake().resposta;
    const r = await w.criar(DS, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'o-doing', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: PG, versao: 'n9', url: 'https://www.notion.so/novo' });
    const c = calls.at(-1)!;
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.notion.com/v1/pages'); assert.equal(c.headers.Authorization, 'Bearer tok');
    assert.deepEqual(c.body.parent, { type: 'data_source_id', data_source_id: DS });
    assert.deepEqual(c.body.properties, {
      Nome: { title: [{ type: 'text', text: { content: 'Revisar' } }] }, Descrição: { rich_text: [{ type: 'text', text: { content: 'cláusula 4' } }] },
      Prazo: { date: { start: '2026-11-20' } }, Status: { status: { id: 'o-doing' } },
    });
    const escrita = c.headers['Notion-Version'];
    calls.length = 0;
    await leitura();
    assert.equal(calls[0].headers['Notion-Version'], escrita);
    assert.equal(calls[0].headers.Authorization, c.headers.Authorization);
  });
  test('criar sem coluna, ou nas sintéticas, não manda status', async () => {
    answer = notionFake().resposta;
    await w.criar(DS, { titulo: 'A' }); await w.criar(DS, { titulo: 'B', coluna: '__sem_status__' }); await w.criar(DS, { titulo: 'C', coluna: '__tarefas__' });
    for (const c of calls.filter((x) => x.method === 'POST')) assert.deepEqual(Object.keys(c.body.properties), ['Nome']);
  });
  test('texto acima de 2000 caracteres vai em pedaços, sem partir emoji; acima do teto é erro', async () => {
    answer = notionFake().resposta;
    await w.criar(DS, { titulo: 'A', descricao: `${'x'.repeat(1999)}😀${'y'.repeat(2500)}` });
    const partes = calls.at(-1)!.body.properties['Descrição'].rich_text as any[];
    assert.ok(partes.every((p) => p.text.content.length <= 2000));
    assert.equal(partes.map((p) => p.text.content).join(''), `${'x'.repeat(1999)}😀${'y'.repeat(2500)}`);
    assert.equal(partes[0].text.content.length, 1999);
    await assert.rejects(() => w.criar(DS, { titulo: 'A', descricao: 'x'.repeat(200_001) }), acao(/longo demais/));
  });
  test('parâmetro errado vira erro claro, antes de escrever', async () => {
    answer = notionFake().resposta;
    await assert.rejects(() => w.criar(DS, { titulo: 'A', coluna: 'nao-existe' }), (e: unknown) => acao(/não tem a coluna/)(e) && (e as ErroAcao).opcoes!.includes('Em andamento (o-doing)'));
    await assert.rejects(() => w.criar(DS, { titulo: '  ' }), acao(/vazio/));
    await assert.rejects(() => w.criar(DS, { titulo: 'A', prazo: 'amanhã' }), acao(/AAAA-MM-DD/));
    await assert.rejects(() => w.criar('../users/me', { titulo: 'A' }), acao(/base inválida/));
    await assert.rejects(() => w.concluir(DS, '../users/me', true), acao(/tarefa inválida/));
    await assert.rejects(() => w.editar(DS, PG, {}), acao(/nada para mudar/));
    answer = notionFake({ Nome: { type: 'title', title: {} } }).resposta;
    await assert.rejects(() => w.criar(DS, { titulo: 'A', descricao: 'x' }), acao(/propriedade de texto/));
    await assert.rejects(() => w.criar(DS, { titulo: 'A', prazo: '2026-11-20' }), acao(/propriedade de data/));
    await assert.rejects(() => w.mover(DS, PG, 'o-todo'), acao(/não tem colunas/));
    assert.equal(calls.filter((c) => c.method === 'PATCH' || c.url.pathname === '/v1/pages').length, 0);
  });
  test('concluir em status: opção do grupo Complete (mesmo sem nome conhecido); a leitura vê concluída; reabrir volta', async () => {
    answer = notionFake().resposta;
    assert.equal((await leitura()).tasks[0].completed, false);
    const r = await w.concluir(DS, PG, true);
    assert.deepEqual(r, { id: PG, versao: 'n2', url: 'https://www.notion.so/p' });
    assert.equal(patch()[0].url.pathname, `/v1/pages/${PG}`);
    assert.deepEqual(patch()[0].body.properties, { Status: { status: { id: 'o-done' } } });
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir(DS, PG, false);
    assert.deepEqual(patch()[1].body.properties, { Status: { status: { id: 'o-todo' } } });
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('concluir: "Cancelado" não vira concluído; prefere o nome de feito do grupo Complete; sem nome claro, pergunta', async () => {
    const CANC = { id: 'o-canc', name: 'Cancelado' }; const FEITO = { id: 'o-feito', name: 'Concluído' }; const ARQ = { id: 'o-arq', name: 'Arquivado' };
    const com = (options: any[], extra: Record<string, any> = {}) => ({ Nome: { type: 'title', title: {} }, Status: { type: 'status', status: { options: [OP.todo, ...options], groups: [{ name: 'To-do', option_ids: ['o-todo'] }, { name: 'Complete', option_ids: options.map((o) => o.id) }] } }, ...extra });
    answer = notionFake(com([CANC, FEITO])).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Status: { status: { id: 'o-feito' } } });
    assert.equal((await leitura()).tasks[0].completed, true);
    calls.length = 0;
    answer = notionFake(com([CANC, ARQ])).resposta;
    await assert.rejects(() => w.concluir(DS, PG, true), (e: unknown) => acao(/nome claro/)(e) && (e as ErroAcao).opcoes!.join() === 'Cancelado (o-canc),Arquivado (o-arq)');
    answer = notionFake(com([CANC])).resposta;
    await assert.rejects(() => w.concluir(DS, PG, true), acao(/nome claro/));
    assert.equal(patch().length, 0);
    // com caixa de seleção a leitura já vê concluída: não precisa escolher nem mexer no status
    answer = notionFake(com([CANC, ARQ], { Feito: { type: 'checkbox', checkbox: {} } })).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Feito: { checkbox: true } });
    assert.equal((await leitura()).tasks[0].completed, true);
  });
  test('prazo: só em propriedade com nome de prazo, mesmo com uma de data só; limpar nela não mexe', async () => {
    const so = { Nome: { type: 'title', title: {} }, Início: { type: 'date', date: {} } };
    answer = notionFake(so).resposta;
    await assert.rejects(() => w.editar(DS, PG, { prazo: '2026-12-01' }), (e: unknown) => acao(/não se chama prazo/)(e) && (e as ErroAcao).opcoes!.join() === 'Início');
    await assert.rejects(() => w.criar(DS, { titulo: 'A', prazo: '2026-12-01' }), acao(/não se chama prazo/));
    assert.deepEqual(await w.editar(DS, PG, { prazo: null }), { id: PG });
    assert.equal(patch().length, 0);
    assert.equal(calls.filter((c) => c.url.pathname === '/v1/pages').length, 0);
  });
  test('inverso da leitura: o prazo gravado volta; tirar volta null; sem propriedade de prazo fica ausente, nunca null', async () => {
    answer = notionFake().resposta;
    assert.equal((await leitura()).tasks[0].due, null);
    await w.editar(DS, PG, { prazo: '2026-11-20' });
    assert.equal((await leitura()).tasks[0].due, '2026-11-20');
    await w.editar(DS, PG, { prazo: null });
    assert.equal((await leitura()).tasks[0].due, null);
    const data = { type: 'date', date: {} };
    answer = notionFake({ Nome: { type: 'title', title: {} }, Início: data }, { Início: { date: { start: '2026-01-01' } } }).resposta;
    assert.equal((await leitura()).tasks[0].due, undefined);
    answer = notionFake({ Nome: { type: 'title', title: {} } }).resposta;
    assert.equal((await leitura()).tasks[0].due, undefined);
    // a mesma que o escritor grava, não a primeira de data
    answer = notionFake({ Nome: { type: 'title', title: {} }, Início: data, Prazo: data }, { Início: { date: { start: '2026-01-01' } }, Prazo: { date: { start: '2026-02-02T10:00:00.000-03:00' } } }).resposta;
    assert.equal((await leitura()).tasks[0].due, '2026-02-02');
  });
  test('reabrir usa a opção padrão, se houver, e não mexe em quem não está feito', async () => {
    const props = { ...BASE_COMPLETA, Status: { type: 'status', status: { ...STATUS.status, default_option: 'Em andamento' } } };
    answer = notionFake(props, { Status: { status: OP.done } }).resposta;
    await w.concluir(DS, PG, false);
    assert.deepEqual(patch()[0].body.properties, { Status: { status: { id: 'o-doing' } } });
    calls.length = 0;
    answer = notionFake(BASE_COMPLETA, { Status: { status: OP.doing } }).resposta;
    assert.deepEqual(await w.concluir(DS, PG, false), { id: PG });
    assert.equal(patch().length, 0);
  });
  test('propriedade select: escreve em select, pelo nome que significa feito', async () => {
    const select = { Nome: { type: 'title', title: {} }, Situação: { type: 'select', select: { options: [{ id: 's1', name: 'Aberto' }, { id: 's2', name: 'Concluído' }] } } };
    answer = notionFake(select).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Situação: { select: { id: 's2' } } });
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir(DS, PG, false);
    assert.deepEqual(patch()[1].body.properties, { Situação: { select: { id: 's1' } } });
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('select com nome qualquer não é status (como na leitura): sem caixa, não tem como concluir', async () => {
    const outra = { Nome: { type: 'title', title: {} }, Cor: { type: 'select', select: { options: [{ id: 's1', name: 'Done' }] } } };
    answer = notionFake(outra).resposta;
    await assert.rejects(() => w.concluir(DS, PG, true), acao(/não tem como marcar concluído/));
    assert.equal(patch().length, 0);
  });
  test('caixa de seleção: concluir e reabrir; reabrir também tira o status feito, senão a leitura segue concluída', async () => {
    const so = { Nome: { type: 'title', title: {} }, Feito: { type: 'checkbox', checkbox: {} } };
    answer = notionFake(so).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Feito: { checkbox: true } });
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir(DS, PG, false);
    assert.deepEqual(patch()[1].body.properties, { Feito: { checkbox: false } });
    assert.equal((await leitura()).tasks[0].completed, false);
    calls.length = 0;
    answer = notionFake({ ...BASE_COMPLETA, Concluído: { type: 'checkbox', checkbox: {} } }).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Concluído: { checkbox: true }, Status: { status: { id: 'o-done' } } });
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir(DS, PG, false);
    assert.deepEqual(patch()[1].body.properties, { Concluído: { checkbox: false }, Status: { status: { id: 'o-todo' } } });
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('status sem opção de feito, com caixa: basta a caixa; sem caixa: erro listando as opções', async () => {
    const opcoes = { type: 'status', status: { options: [OP.todo, OP.doing], groups: [] } };
    answer = notionFake({ Nome: { type: 'title', title: {} }, Status: opcoes, Feito: { type: 'checkbox', checkbox: {} } }).resposta;
    await w.concluir(DS, PG, true);
    assert.deepEqual(patch()[0].body.properties, { Feito: { checkbox: true } });
    calls.length = 0;
    answer = notionFake({ Nome: { type: 'title', title: {} }, Status: opcoes }).resposta;
    await assert.rejects(() => w.concluir(DS, PG, true), (e: unknown) => acao(/não tem como marcar concluído/)(e) && (e as ErroAcao).opcoes!.length === 2);
    assert.equal(patch().length, 0);
  });
  test('reabrir quando só existem opções de concluído é erro', async () => {
    answer = notionFake({ Nome: { type: 'title', title: {} }, Status: { type: 'status', status: { options: [OP.done], groups: [{ name: 'Complete', option_ids: ['o-done'] }] } } }, { Status: { status: OP.done } }).resposta;
    await assert.rejects(() => w.concluir(DS, PG, false), acao(/só tem opções de concluído/));
  });
  test('mover: opção; sem status (null); sintética sem coluna não chama nada', async () => {
    answer = notionFake().resposta;
    await w.mover(DS, PG, 'o-doing');
    assert.deepEqual(patch()[0].body.properties, { Status: { status: { id: 'o-doing' } } });
    assert.equal((await leitura()).tasks[0].columnExternalId, 'o-doing');
    await w.mover(DS, PG, '__sem_status__');
    assert.deepEqual(patch()[1].body.properties, { Status: { status: null } });
    assert.equal((await leitura()).tasks[0].columnExternalId, '__sem_status__');
    calls.length = 0;
    assert.deepEqual(await w.mover(DS, PG, '__tarefas__'), { id: PG });
    assert.equal(calls.length, 0);
  });
  test('editar: só o que mudou; descrição vazia e prazo null limpam; a leitura vê título e descrição', async () => {
    answer = notionFake().resposta;
    await w.editar(DS, PG, { titulo: 'Novo', descricao: 'Texto' });
    assert.deepEqual(Object.keys(patch()[0].body.properties).sort(), ['Descrição', 'Nome']);
    const t = (await leitura()).tasks[0];
    assert.equal(t.title, 'Novo'); assert.equal(t.description, 'Texto');
    await w.editar(DS, PG, { descricao: '', prazo: null });
    assert.deepEqual(patch()[1].body.properties, { Descrição: { rich_text: [] }, Prazo: { date: null } });
  });
  test('limpar o que a base não tem não é erro nem chama nada', async () => {
    answer = notionFake({ Nome: { type: 'title', title: {} } }).resposta;
    assert.deepEqual(await w.editar(DS, PG, { descricao: '', prazo: null }), { id: PG });
    assert.equal(patch().length, 0);
  });
  test('comentar: parent page_id; comentário longo em pedaços', async () => {
    answer = notionFake().resposta;
    await w.comentar!(DS, PG, 'feito');
    const c = calls[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.notion.com/v1/comments');
    assert.deepEqual(c.body, { parent: { page_id: PG }, rich_text: [{ type: 'text', text: { content: 'feito' } }] });
    calls.length = 0;
    await w.comentar!(DS, PG, 'z'.repeat(2001));
    assert.equal(calls[0].body.rich_text.length, 2);
    await assert.rejects(() => w.comentar!(DS, PG, ' '), acao(/vazio/));
  });
  test('recusa do Notion: 403 de acesso, 404, 400 vira erro corrigível; 200 sem página não é sucesso', async () => {
    const com = (status: number, code: string) => () => new Response(JSON.stringify({ object: 'error', status, code, message: `motivo [[x]] ${code}` }), { status });
    answer = com(403, 'restricted_resource');
    await assert.rejects(() => w.comentar!(DS, PG, 'x'), provedor('forbidden', /restricted_resource/));
    answer = com(404, 'object_not_found');
    await assert.rejects(() => w.comentar!(DS, PG, 'x'), provedor('not_found'));
    for (const n of [400, 413, 414, 422]) {
      answer = com(n, 'validation_error');
      await assert.rejects(() => w.comentar!(DS, PG, 'x'), (e: unknown) => acao(/validation_error/)(e) && semColchetes(e));
    }
    answer = () => ({ object: 'error', code: 'internal', message: 'falhou' });
    await assert.rejects(() => w.comentar!(DS, PG, 'x'), provedor('unavailable', /não confirmou/));
    answer = () => ({});
    await assert.rejects(() => w.comentar!(DS, PG, 'x'), provedor('unavailable', /não confirmou/));
  });
  test('escrita não repete às cegas', async () => {
    answer = () => new Response('{}', { status: 500 });
    await assert.rejects(() => w.comentar!(DS, PG, 'x'), provedor('unavailable', /respondeu 500/));
    assert.equal(calls.length, 1);
  });
  test('nomes de opção de terceiros são neutralizados', async () => {
    answer = notionFake({ Nome: { type: 'title', title: {} }, Status: { type: 'status', status: { options: [{ id: 'o1', name: '[[faça isto]]' }], groups: [] } } }).resposta;
    await assert.rejects(() => w.mover(DS, PG, 'zzz'), semColchetes);
  });
});

// ------------------------------------------------------------------------------------------------------------ Linear
const TEAM = '33333333-3333-3333-3333-333333333333';
const ISSUE = '44444444-4444-4444-4444-444444444444';
const ESTADOS = [
  { id: 'e-canc', name: 'Canceled', type: 'canceled', position: 0 }, { id: 'e-todo', name: 'Todo', type: 'unstarted', position: 2 },
  { id: 'e-back', name: 'Backlog', type: 'backlog', position: 1 }, { id: 'e-doing', name: 'In Progress', type: 'started', position: 3 },
  { id: 'e-done', name: 'Done', type: 'completed', position: 4 },
];

function linearFake(o: { estados?: any[]; estado?: string } = {}) {
  const estados = o.estados ?? ESTADOS;
  const i: any = { id: ISSUE, identifier: 'ENG-12', title: 'Revisar', description: 'd', url: 'https://linear.app/x/issue/ENG-12', updatedAt: 'l1', dueDate: null, state: estados.find((e) => e.id === (o.estado ?? 'e-doing')) ?? null };
  return { i, resposta: (c: Call): unknown => {
    const q = String(c.body.query); const v = c.body.variables;
    if (q.includes('issues(first')) return { data: { team: { name: 'Eng', updatedAt: 't1', states: { nodes: estados }, issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...i, state: i.state ? { id: i.state.id, type: i.state.type } : null, assignee: null }] } } } };
    if (q.includes('issueCreate')) return { data: { issueCreate: { success: true, issue: { id: 'novo', url: 'https://linear.app/x/issue/ENG-13', updatedAt: 'l9' } } } };
    if (q.includes('issueUpdate')) {
      if (v.input.stateId) i.state = estados.find((e) => e.id === v.input.stateId);
      if (v.input.title !== undefined) i.title = v.input.title;
      i.updatedAt = 'l2';
      return { data: { issueUpdate: { success: true, issue: { id: i.id, url: i.url, updatedAt: 'l2' } } } };
    }
    if (q.includes('commentCreate')) return { data: { commentCreate: { success: true, comment: { id: 'c1' } } } };
    if (q.includes('issue(id')) return { data: { team: { states: { nodes: estados } }, issue: { id: i.id, url: i.url, updatedAt: i.updatedAt, state: i.state } } };
    if (q.includes('team(id')) return { data: { team: { states: { nodes: estados } } } };
    throw new Error(`consulta inesperada: ${q}`);
  } };
}

describe('Linear: escrita', () => {
  const w = escritorLinear('lin_api_tok');
  const leitura = () => new LinearProvider('lin_api_tok').getBoard(TEAM);

  test('criar: chave sem Bearer, variáveis, e o retorno', async () => {
    answer = linearFake().resposta;
    const r = await w.criar(TEAM, { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'e-todo', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 'novo', versao: 'l9', url: 'https://linear.app/x/issue/ENG-13' });
    const c = mutacoes()[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.linear.app/graphql'); assert.equal(c.headers.Authorization, 'lin_api_tok');
    assert.deepEqual(c.body.variables.input, { teamId: TEAM, title: 'Revisar', description: 'cláusula 4', stateId: 'e-todo', dueDate: '2026-11-20' });
    assert.ok(!c.body.query.includes('Revisar') && !c.body.query.includes(TEAM));
  });
  test('criar sem coluna, ou na sintética, fica no estado padrão do time', async () => {
    answer = linearFake().resposta;
    await w.criar(TEAM, { titulo: 'A' }); await w.criar(TEAM, { titulo: 'B', coluna: '__tarefas__' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.variables.input, { teamId: TEAM, title: 'A' });
    assert.deepEqual(calls[1].body.variables.input, { teamId: TEAM, title: 'B' });
  });
  test('o identificador que a leitura põe no título não vai para o Linear', async () => {
    answer = linearFake().resposta;
    const antes = (await leitura()).tasks[0].title;
    assert.equal(antes, 'ENG-12 · Revisar');
    await w.editar(TEAM, ISSUE, { titulo: antes });
    assert.equal(mutacoes()[0].body.variables.input.title, 'Revisar');
    assert.equal((await leitura()).tasks[0].title, 'ENG-12 · Revisar');
  });
  test('parâmetro errado vira erro claro, antes de escrever', async () => {
    answer = linearFake().resposta;
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A', coluna: 'zzz' }), (e: unknown) => acao(/não tem a coluna/)(e) && (e as ErroAcao).opcoes!.includes('Todo (e-todo)'));
    await assert.rejects(() => w.mover(TEAM, ISSUE, 'zzz'), acao(/não tem a coluna/));
    await assert.rejects(() => w.criar(TEAM, { titulo: ' ' }), acao(/vazio/));
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'ENG-12 · ' }), acao(/vazio/));
    await assert.rejects(() => w.criar('x', { titulo: 'A' }), acao(/time inválido/));
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A', prazo: '20/11' }), acao(/AAAA-MM-DD/));
    await assert.rejects(() => w.editar(TEAM, ISSUE, {}), acao(/nada para mudar/));
    await assert.rejects(() => w.comentar!(TEAM, ISSUE, ''), acao(/vazio/));
    assert.equal(mutacoes().length, 0);
  });
  test('concluir escolhe um estado completed, nunca canceled; a leitura vê concluída; reabrir vai para unstarted', async () => {
    answer = linearFake().resposta;
    assert.equal((await leitura()).tasks[0].completed, false);
    const r = await w.concluir(TEAM, ISSUE, true);
    assert.deepEqual(r, { id: ISSUE, versao: 'l2', url: 'https://linear.app/x/issue/ENG-12' });
    const c = mutacoes()[0];
    assert.ok(c.body.query.includes('issueUpdate'));
    assert.deepEqual(c.body.variables, { id: ISSUE, input: { stateId: 'e-done' } });
    assert.equal((await leitura()).tasks[0].completed, true);
    await w.concluir(TEAM, ISSUE, false);
    assert.deepEqual(mutacoes()[1].body.variables.input, { stateId: 'e-todo' });
    assert.equal((await leitura()).tasks[0].completed, false);
  });
  test('vários estados completed: o primeiro por posição', async () => {
    answer = linearFake({ estados: [{ id: 'd2', name: 'Lançado', type: 'completed', position: 9 }, { id: 'd1', name: 'Done', type: 'completed', position: 5 }, { id: 't', name: 'Todo', type: 'unstarted', position: 1 }], estado: 't' }).resposta;
    await w.concluir(TEAM, ISSUE, true);
    assert.equal(mutacoes()[0].body.variables.input.stateId, 'd1');
  });
  test('sem unstarted, reabrir vai para backlog', async () => {
    answer = linearFake({ estados: ESTADOS.filter((e) => e.type !== 'unstarted'), estado: 'e-done' }).resposta;
    await w.concluir(TEAM, ISSUE, false);
    assert.equal(mutacoes()[0].body.variables.input.stateId, 'e-back');
  });
  test('já está assim: não mexe (cancelada conta como concluída, como na leitura)', async () => {
    answer = linearFake({ estado: 'e-done' }).resposta;
    await w.concluir(TEAM, ISSUE, true);
    answer = linearFake({ estado: 'e-canc' }).resposta;
    await w.concluir(TEAM, ISSUE, true);
    answer = linearFake({ estado: 'e-doing' }).resposta;
    const r = await w.concluir(TEAM, ISSUE, false);
    assert.equal(r.id, ISSUE);
    assert.equal(mutacoes().length, 0);
  });
  test('time sem estado de concluído: erro listando os que existem', async () => {
    answer = linearFake({ estados: [{ id: 'a', name: 'Aberto', type: 'unstarted', position: 0 }], estado: 'a' }).resposta;
    await assert.rejects(() => w.concluir(TEAM, ISSUE, true), (e: unknown) => acao(/não tem como marcar concluído/)(e) && (e as ErroAcao).opcoes!.join() === 'Aberto');
    assert.equal(mutacoes().length, 0);
  });
  test('mover é stateId; a leitura vê a coluna nova; a sintética não chama nada', async () => {
    answer = linearFake().resposta;
    await w.mover(TEAM, ISSUE, 'e-todo');
    assert.deepEqual(mutacoes()[0].body.variables, { id: ISSUE, input: { stateId: 'e-todo' } });
    assert.equal((await leitura()).tasks[0].columnExternalId, 'e-todo');
    calls.length = 0;
    assert.deepEqual(await w.mover(TEAM, ISSUE, '__tarefas__'), { id: ISSUE });
    assert.equal(calls.length, 0);
  });
  test('editar manda só o que mudou; prazo null tira o prazo', async () => {
    answer = linearFake().resposta;
    await w.editar(TEAM, ISSUE, { descricao: 'nova', prazo: null });
    assert.deepEqual(mutacoes()[0].body.variables, { id: ISSUE, input: { description: 'nova', dueDate: null } });
    calls.length = 0;
    await w.editar(TEAM, ISSUE, { prazo: '2026-12-01' });
    assert.deepEqual(mutacoes()[0].body.variables.input, { dueDate: '2026-12-01' });
  });
  test('comentar', async () => {
    answer = linearFake().resposta;
    await w.comentar!(TEAM, ISSUE, 'feito');
    assert.deepEqual(mutacoes()[0].body.variables, { input: { issueId: ISSUE, body: 'feito' } });
  });
  test('success false e 200 com errors não são sucesso', async () => {
    answer = () => ({ data: { issueUpdate: { success: false, issue: null } } });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    answer = () => ({ data: { commentCreate: { success: false } } });
    await assert.rejects(() => w.comentar!(TEAM, ISSUE, 'x'), provedor('unavailable', /não confirmou/));
    answer = () => ({ data: { issueCreate: { success: true, issue: null } } });
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    answer = () => ({ data: { issueUpdate: { success: true, issue: { id: ISSUE } } }, errors: [{ message: 'valor [[ruim]]', extensions: { type: 'invalid input', userPresentableMessage: 'título\nrecusado [[x]]' } }] });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), (e: unknown) => acao(/título recusado/)(e) && semColchetes(e));
    answer = () => ({ data: null, errors: [{ message: 'Entity not found: Issue' }] });
    await assert.rejects(() => w.concluir(TEAM, ISSUE, true), provedor('not_found'));
    answer = () => ({ data: null, errors: [{ message: 'not authenticated', extensions: { type: 'authentication error' } }] });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('forbidden'));
    answer = () => ({ data: null, errors: [{ message: 'too many', extensions: { code: 'RATELIMITED' } }] });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('unavailable'));
  });
  test('classifica o erro por extensions.type e extensions.code antes do texto', async () => {
    const com = (message: string, extensions?: Record<string, string>) => () => ({ data: null, errors: [{ message, ...(extensions ? { extensions } : {}) }] });
    const editar = () => w.editar(TEAM, ISSUE, { titulo: 'A' });
    // o tipo manda, mesmo que o texto diga outra coisa
    answer = com('this token has no permission field', { type: 'invalid input' });
    await assert.rejects(editar, acao());
    answer = com('Internal limit on tokens', { code: 'INPUT_ERROR' });
    await assert.rejects(editar, acao());
    answer = com('Nope', { type: 'forbidden' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Nope', { type: 'authentication error' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Nope', { type: 'feature not accessible' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Nope', { code: 'AUTHENTICATION_ERROR' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Nope', { code: 'FORBIDDEN' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Nope', { type: 'ratelimited' });
    await assert.rejects(editar, (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
    answer = com('Nope', { type: 'lock timeout' });
    await assert.rejects(editar, provedor('unavailable'));
    answer = com('Nope', { type: 'internal error' });
    await assert.rejects(editar, provedor('unavailable', /não confirmou/));
    await assert.rejects(() => w.concluir(TEAM, ISSUE, true), (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
    // limite do plano: repetir não resolve, a pessoa precisa saber
    answer = com('Limite do plano', { type: 'usage limit exceeded' });
    await assert.rejects(editar, acao(/Limite do plano/));
    // tipo que não diz nada: vale o texto
    answer = com('not authenticated', { type: 'unknown' });
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Author is required', { type: 'other' });
    await assert.rejects(editar, acao(/Author/));
  });
  test('no texto, só palavras inteiras: "Author" não é credencial, "internalNote" não é erro interno', async () => {
    const com = (message: string) => () => ({ data: null, errors: [{ message }] });
    const editar = () => w.editar(TEAM, ISSUE, { titulo: 'A' });
    for (const t of ['Author is required', 'Invalid tokenizer option', 'Campo authored inválido', 'Field internalNote is invalid', 'Label not foundation', 'Value temporarily_x']) {
      answer = com(t);
      await assert.rejects(editar, acao(), t);
    }
    answer = com('Not authenticated');
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Invalid token');
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('You lack the permission');
    await assert.rejects(editar, provedor('forbidden'));
    answer = com('Entity not found: Issue');
    await assert.rejects(editar, provedor('not_found'));
    answer = com('Rate limit exceeded');
    await assert.rejects(editar, provedor('unavailable'));
    answer = com('Internal server error');
    await assert.rejects(editar, provedor('unavailable', /não confirmou/));
  });
  test('recusa definitiva (400, 413, 414, 422) vira erro de ação, sem repetir', async () => {
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = () => new Response(JSON.stringify({ errors: [{ message: 'valor [[ruim]]', extensions: { code: 'INPUT_ERROR' } }] }), { status: n });
      await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), (e: unknown) => acao(/valor \[ \[ruim\] \]/)(e) && semColchetes(e));
      assert.equal(calls.length, 1);
    }
    answer = () => new Response(JSON.stringify({ errors: [{ message: 'Nope', extensions: { code: 'AUTHENTICATION_ERROR' } }] }), { status: 400 });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('forbidden'));
  });
  test('erro interno com 200 numa mutação é resultado incerto: diz "não confirmou", e o espelho não cria de novo; o de leitura não', async () => {
    answer = () => ({ data: null, errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    await assert.rejects(() => w.concluir(TEAM, ISSUE, true), (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
    answer = () => ({ data: null, errors: [{ message: 'too many', extensions: { code: 'RATELIMITED' } }] });
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A' }), (e: unknown) => provedor('unavailable')(e) && !/não confirmou/.test((e as Error).message));
  });
  test('400 do Linear com corpo de erro: classificado pelo motivo', async () => {
    answer = () => new Response(JSON.stringify({ errors: [{ message: 'Argument Validation Error', extensions: { code: 'INPUT_ERROR' } }] }), { status: 400 });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), acao(/Argument Validation Error/));
    answer = () => new Response(JSON.stringify({ errors: [{ message: 'Authentication required, not authenticated' }] }), { status: 400 });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('forbidden'));
  });
  test('escrita não repete às cegas; 429 recusado sobe como passageiro', async () => {
    answer = () => new Response('{}', { status: 500 });
    await assert.rejects(() => w.comentar!(TEAM, ISSUE, 'x'), provedor('unavailable', /respondeu 500/));
    assert.equal(calls.length, 1);
    calls.length = 0;
    answer = () => { throw new Error('socket hang up'); };
    await assert.rejects(() => w.criar(TEAM, { titulo: 'A' }), provedor('unavailable', /não confirmou/));
    assert.equal(calls.length, 1);
    answer = () => new Response('{}', { status: 429 });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), provedor('unavailable', /limite de uso/));
  });
  test('credencial recusada vira erro de acesso, sem repetir a chave', async () => {
    answer = () => new Response('{}', { status: 401 });
    await assert.rejects(() => w.editar(TEAM, ISSUE, { titulo: 'A' }), (e: unknown) => provedor('forbidden')(e) && !(e as Error).message.includes('lin_api_tok'));
  });
});
