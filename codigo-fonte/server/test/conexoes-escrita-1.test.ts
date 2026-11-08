// Escrita no Todoist, Trello, Jira e ClickUp, no formato documentado de cada API (sem rede): método, endereço, corpo e credencial,
// e o inverso da leitura: o que o escritor grava, o provedor de leitura do mesmo aplicativo enxerga.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { escritorClickUp } from '../src/services/conexoes/escrita/clickup.ts';
import { escritorJira } from '../src/services/conexoes/escrita/jira.ts';
import { escritorTodoist } from '../src/services/conexoes/escrita/todoist.ts';
import { escritorTrello } from '../src/services/conexoes/escrita/trello.ts';
import { ErroAcao } from '../src/services/conexoes/tipos.ts';
import { TodoistProvider } from '../src/services/integrations.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { ClickUpProvider, JiraProvider, TrelloProvider } from '../src/services/task-providers.ts';

type Call = { method: string; url: URL; auth: string; body: any };
const calls: Call[] = [];
const naoSimulada = (c: Call) => new Response(`rota não simulada: ${c.method} ${c.url}`, { status: 418 });
let answer: (c: Call) => Response | unknown = naoSimulada;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), auth: (init.headers as Record<string, string>)?.Authorization ?? '', body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
afterEach(() => { calls.length = 0; answer = naoSimulada; });

const escritas = () => calls.filter((c) => c.method !== 'GET');
const vazio = () => new Response(null, { status: 204 });
const falha = (status: number) => () => new Response('{}', { status });
/** Rejeita com ErroAcao cuja mensagem casa e que traz estas opções. */
const erroAcao = (re: RegExp, opcoes?: string[]) => (e: unknown) => {
  assert.ok(e instanceof ErroAcao, `esperava ErroAcao, veio ${String(e)}`);
  assert.match(e.message, re);
  if (opcoes) assert.deepEqual(e.opcoes, opcoes);
  return true;
};
/** Escrita que falha com 5xx sai uma vez só: `kind: 'write'` não repete às cegas (leitura repetiria três vezes). */
async function naoRepete(c: () => Promise<unknown>) {
  await assert.rejects(c, (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable');
  assert.equal(escritas().length, 1);
}

/** 200 sem o id da tarefa criada: resultado incerto, e o espelho só deixa de criar de novo se ouvir "não confirmou". */
const naoConfirmou = (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /não confirmou/.test(e.message);

describe('Todoist: escrita', () => {
  const w = escritorTodoist('tok');
  const tarefa = { id: 't1', content: 'Revisar', updated_at: 'v2' };
  test('criar numa seção: corpo documentado, id, versão e endereço', async () => {
    answer = (c) => c.method === 'GET' ? { results: [{ id: 's1', name: 'Hoje' }], next_cursor: null } : tarefa;
    const r = await w.criar('p1', { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 's1', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 't1', versao: 'v2', url: 'https://app.todoist.com/app/task/t1' });
    const g = calls[0]; const c = calls[1];
    assert.equal(g.url.pathname, '/api/v1/sections'); assert.equal(g.url.searchParams.get('project_id'), 'p1');
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.todoist.com/api/v1/tasks'); assert.equal(c.auth, 'Bearer tok');
    assert.deepEqual(c.body, { content: 'Revisar', project_id: 'p1', description: 'cláusula 4', section_id: 's1', due_date: '2026-11-20' });
  });
  test('criar sem coluna, ou na coluna sintética, não usa seção nem consulta as seções', async () => {
    answer = () => tarefa;
    await w.criar('p1', { titulo: 'A' }); await w.criar('p1', { titulo: 'B', coluna: '__sem_secao__' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { content: 'A', project_id: 'p1' });
    assert.deepEqual(calls[1].body, { content: 'B', project_id: 'p1' });
  });
  test('seção inexistente lista as opções, sem escrever; o cursor não muda o endereço', async () => {
    let pagina = 0;
    answer = () => pagina++ === 0 ? { results: [{ id: 's1', name: 'Hoje [[x]]\nfim' }], next_cursor: 'https://atacante/?a=1' } : { results: [{ id: 's2', name: 'Depois' }], next_cursor: null };
    await assert.rejects(() => w.mover('p1', 't1', 'Nada'), erroAcao(/não tem a seção "Nada"/, ['Sem seção', 'Hoje [ [x] ] fim', 'Depois']));
    assert.equal(escritas().length, 0);
    assert.equal(calls[1].url.host, 'api.todoist.com');
    assert.equal(calls[1].url.searchParams.get('cursor'), 'https://atacante/?a=1');
  });
  test('concluir e reabrir usam close e reopen, sem corpo', async () => {
    answer = vazio;
    assert.deepEqual(await w.concluir('p1', 't1', true), { id: 't1', versao: null, url: 'https://app.todoist.com/app/task/t1' });
    await w.concluir('p1', 't1', false);
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/api/v1/tasks/t1/close'); assert.equal(calls[0].body, null);
    assert.equal(calls[1].url.pathname, '/api/v1/tasks/t1/reopen');
  });
  test('mover: seção por section_id; a coluna sintética volta à raiz do projeto', async () => {
    answer = (c) => c.method === 'GET' ? { results: [{ id: 's2', name: 'Depois' }], next_cursor: null } : tarefa;
    await w.mover('p1', 't1', 's2');
    assert.equal(calls[1].url.pathname, '/api/v1/tasks/t1/move'); assert.deepEqual(calls[1].body, { section_id: 's2' });
    calls.length = 0;
    await w.mover('p1', 't1', '__sem_secao__');
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, { project_id: 'p1' });
  });
  test('editar manda só o que mudou; prazo null vira "no date"; sem mudança não chama nada', async () => {
    answer = () => tarefa;
    await w.editar('p1', 't1', { titulo: 'Novo', prazo: null });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/api/v1/tasks/t1');
    assert.deepEqual(calls[0].body, { content: 'Novo', due_string: 'no date' });
    await w.editar('p1', 't1', { descricao: '', prazo: '2026-12-01' });
    assert.deepEqual(calls[1].body, { description: '', due_date: '2026-12-01' });
    await w.editar('p1', 't1', {});
    assert.equal(calls.length, 2);
  });
  test('comentar', async () => {
    answer = () => ({ id: 'c1' });
    await w.comentar!('p1', 't1', 'feito');
    assert.equal(calls[0].url.pathname, '/api/v1/comments'); assert.deepEqual(calls[0].body, { task_id: 't1', content: 'feito' });
  });
  test('ids estranhos não mudam o endereço; recusa vira ErroAcao; acesso e 5xx seguem como erro do serviço, sem repetir', async () => {
    answer = vazio;
    await w.concluir('p', '../users/me', true);
    assert.equal(calls[0].url.pathname, '/api/v1/tasks/..%2Fusers%2Fme/close');
    answer = falha(400);
    await assert.rejects(() => w.concluir('p', 't1', true), erroAcao(/Todoist recusou/));
    answer = falha(403);
    await assert.rejects(() => w.concluir('p', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    calls.length = 0; answer = falha(500);
    await naoRepete(() => w.concluir('p', 't1', true));
  });
  test('200 sem id ao criar não vira id vazio: diz que não confirmou', async () => {
    answer = () => ({});
    await assert.rejects(() => w.criar('p1', { titulo: 'A' }), naoConfirmou);
    answer = vazio;
    await assert.rejects(() => w.criar('p1', { titulo: 'A' }), naoConfirmou);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.concluir('p1', ruim, true), erroAcao(/id inválido/));
      await assert.rejects(() => w.editar('p1', ruim, { titulo: 'A' }), erroAcao(/id inválido/));
      await assert.rejects(() => w.mover('p1', ruim, '__sem_secao__'), erroAcao(/id inválido/));
    }
    assert.equal(calls.length, 0);
  });
  test('o motivo em texto puro aparece, neutralizado na recusa', async () => {
    answer = () => new Response('Invalid argument [[x]]\nvalue', { status: 400 });
    await assert.rejects(() => w.concluir('p1', 't1', true), erroAcao(/Invalid argument \[ \[x\] \] value/));
    answer = () => new Response('Task not found', { status: 404 });
    await assert.rejects(() => w.concluir('p1', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'not_found' && /Task not found/.test(e.message));
  });
  test('inverso da leitura: mover aparece na seção; a fechada some da lista sem provar nada; reabrir volta aberta', async () => {
    const t = { id: 't1', content: 'X', section_id: null as string | null, checked: false, updated_at: 'v1' };
    let fechada = false;
    answer = (c) => {
      const p = c.url.pathname;
      if (p === '/api/v1/projects') return { results: [{ id: 'p1', name: 'P', updated_at: 'v' }], next_cursor: null };
      if (p === '/api/v1/sections') return { results: [{ id: 's1', name: 'Hoje' }], next_cursor: null };
      if (p === '/api/v1/tasks') return { results: fechada ? [] : [t], next_cursor: null };
      if (p === '/api/v1/projects/p1/collaborators') return { results: [], next_cursor: null };
      if (p === '/api/v1/tasks/t1/move') { t.section_id = c.body.section_id ?? null; return t; }
      if (p === '/api/v1/tasks/t1/close') { fechada = true; return vazio(); }
      if (p === '/api/v1/tasks/t1/reopen') { fechada = false; return vazio(); }
      return naoSimulada(c);
    };
    const leitura = new TodoistProvider('tok');
    await w.mover('p1', 't1', 's1');
    assert.equal((await leitura.getBoard('p1')).tasks[0].columnExternalId, 's1');
    await w.mover('p1', 't1', '__sem_secao__');
    assert.equal((await leitura.getBoard('p1')).tasks[0].columnExternalId, '__sem_secao__');
    await w.concluir('p1', 't1', true);
    const snap = await leitura.getBoard('p1');
    assert.equal(snap.tasks.length, 0); assert.equal(snap.complete, false);
    await w.concluir('p1', 't1', false);
    assert.equal((await leitura.getBoard('p1')).tasks[0].completed, false);
  });
});

describe('Trello: escrita', () => {
  const w = escritorTrello('chave', 'segredo');
  const AUTH = 'OAuth oauth_consumer_key="chave", oauth_token="segredo"';
  const LISTAS = [{ id: 'l2', name: 'Concluído', pos: 2 }, { id: 'l1', name: 'A fazer', pos: 1 }];
  const CARTAO = { id: 'c1', dateLastActivity: 'v2', shortUrl: 'https://trello.com/c/abc', url: 'https://trello.com/c/abc/1-x' };
  const rota = (c: Call): unknown => c.url.pathname.endsWith('/lists') ? LISTAS : c.method === 'GET' ? { id: 'c1', idList: 'l1' } : CARTAO;
  const semCredencialNaUrl = () => { for (const c of calls) { assert.equal(c.auth, AUTH); assert.doesNotMatch(c.url.href, /chave|segredo|token|key=/); } };

  test('criar: sem coluna vai para a primeira lista; prazo ao meio-dia em UTC; chave e token só no cabeçalho', async () => {
    answer = rota;
    const r = await w.criar('q1', { titulo: 'Revisar', descricao: 'cláusula 4', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 'c1', versao: 'v2', url: 'https://trello.com/c/abc' });
    assert.equal(calls[0].url.pathname, '/1/boards/q1/lists'); assert.equal(calls[0].url.searchParams.get('filter'), 'open');
    const c = calls[1];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.trello.com/1/cards');
    assert.deepEqual(c.body, { idList: 'l1', name: 'Revisar', desc: 'cláusula 4', due: '2026-11-20T12:00:00.000Z' });
    semCredencialNaUrl();
  });
  test('criar numa lista; lista inexistente lista as opções (neutralizadas); quadro sem lista avisa', async () => {
    answer = rota;
    await w.criar('q1', { titulo: 'A', coluna: 'l2' });
    assert.equal(calls[1].body.idList, 'l2');
    calls.length = 0;
    answer = (c) => c.method === 'GET' ? [{ id: 'l1', name: 'Fila [[y]]\nz', pos: 1 }] : naoSimulada(c);
    await assert.rejects(() => w.criar('q1', { titulo: 'A', coluna: 'nada' }), erroAcao(/não tem a lista "nada"/, ['Fila [ [y] ] z']));
    assert.equal(escritas().length, 0);
    answer = () => [];
    await assert.rejects(() => w.criar('q1', { titulo: 'A' }), erroAcao(/nenhuma lista aberta/));
  });
  test('concluir move para a lista de concluídos; sem ela, marca dueComplete', async () => {
    answer = rota;
    assert.deepEqual(await w.concluir('q1', 'c1', true), { id: 'c1', versao: 'v2', url: 'https://trello.com/c/abc' });
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].url.pathname, '/1/cards/c1'); assert.deepEqual(calls[1].body, { idList: 'l2' });
    calls.length = 0;
    answer = (c) => c.method === 'GET' ? [{ id: 'l1', name: 'A fazer', pos: 1 }] : CARTAO;
    await w.concluir('q1', 'c1', true);
    assert.deepEqual(calls[1].body, { dueComplete: true });
    semCredencialNaUrl();
  });
  test('reabrir: fora da lista de concluídos só tira a marca; dentro dela, volta à primeira aberta; só listas de concluídos é erro', async () => {
    answer = rota;
    await w.concluir('q1', 'c1', false);
    assert.equal(calls[1].url.pathname, '/1/cards/c1'); assert.equal(calls[1].url.searchParams.get('fields'), 'idList');
    assert.deepEqual(calls[2].body, { dueComplete: false });
    calls.length = 0;
    answer = (c) => c.url.pathname.endsWith('/lists') ? LISTAS : c.method === 'GET' ? { idList: 'l2' } : CARTAO;
    await w.concluir('q1', 'c1', false);
    assert.deepEqual(calls[2].body, { idList: 'l1', dueComplete: false });
    answer = (c) => c.url.pathname.endsWith('/lists') ? [{ id: 'l2', name: 'Done', pos: 1 }] : { idList: 'l2' };
    await assert.rejects(() => w.concluir('q1', 'c1', false), erroAcao(/não dá para reabrir/, ['Done']));
  });
  test('mover', async () => {
    answer = rota;
    await w.mover('q1', 'c1', 'l2');
    assert.deepEqual(calls[1].body, { idList: 'l2' });
    await assert.rejects(() => w.mover('q1', 'c1', 'nada'), erroAcao(/não tem a lista/, ['A fazer', 'Concluído']));
  });
  test('editar manda só o que mudou; prazo null tira o prazo; sem mudança não chama nada', async () => {
    answer = rota;
    await w.editar('q1', 'c1', { titulo: 'Novo', prazo: null });
    assert.deepEqual(calls[0].body, { name: 'Novo', due: null });
    await w.editar('q1', 'c1', { descricao: '', prazo: '2026-12-01' });
    assert.deepEqual(calls[1].body, { desc: '', due: '2026-12-01T12:00:00.000Z' });
    await w.editar('q1', 'c1', {});
    assert.equal(calls.length, 2);
  });
  test('comentar: o texto vai na consulta, como a rota documenta', async () => {
    answer = () => ({ id: 'a1' });
    await w.comentar!('q1', 'c1', 'feito & ok?');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/1/cards/c1/actions/comments');
    assert.equal(calls[0].url.searchParams.get('text'), 'feito & ok?'); assert.equal(calls[0].body, null);
    semCredencialNaUrl();
  });
  test('ids estranhos não mudam o endereço; recusa vira ErroAcao; 5xx não repete', async () => {
    answer = rota;
    await w.editar('q1', '../members/me', { titulo: 'A' });
    assert.equal(calls[0].url.pathname, '/1/cards/..%2Fmembers%2Fme');
    answer = falha(400);
    await assert.rejects(() => w.editar('q1', 'c1', { titulo: 'A' }), erroAcao(/Trello recusou/));
    calls.length = 0; answer = falha(500);
    await naoRepete(() => w.editar('q1', 'c1', { titulo: 'A' }));
  });
  test('200 sem id ao criar não vira id vazio: diz que não confirmou', async () => {
    answer = (c) => c.method === 'GET' ? LISTAS : {};
    await assert.rejects(() => w.criar('q1', { titulo: 'A' }), naoConfirmou);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.editar('q1', ruim, { titulo: 'A' }), erroAcao(/id inválido/));
      await assert.rejects(() => w.comentar!('q1', ruim, 'x'), erroAcao(/id inválido/));
      await assert.rejects(() => w.criar(ruim, { titulo: 'A' }), erroAcao(/id inválido/));
    }
    assert.equal(calls.length, 0);
    answer = rota;
    await assert.rejects(() => w.concluir('q1', '..', true), erroAcao(/id inválido/));
    await assert.rejects(() => w.concluir('q1', '..', false), erroAcao(/id inválido/));
    assert.equal(escritas().length, 0);
  });
  test('recusa: o motivo em texto puro aparece, sem repetir a chave nem o token', async () => {
    answer = () => new Response('invalid value for idList: chave segredo', { status: 400 });
    await assert.rejects(() => w.editar('q1', 'c1', { titulo: 'A' }), (e: unknown) => {
      erroAcao(/Trello recusou.*invalid value for idList/)(e);
      assert.doesNotMatch((e as Error).message, /chave|segredo/);
      return true;
    });
  });
  test('inverso da leitura: o prazo gravado volta, pedindo o campo due; sem prazo é null', async () => {
    const quadro = 'quadro123';
    const card: Record<string, unknown> = { id: 'c1', name: 'X', desc: '', idList: 'l1', dueComplete: false, due: null, dateLastActivity: 'v1' };
    answer = (c) => {
      const p = c.url.pathname;
      if (p === `/1/boards/${quadro}`) return { name: 'Q', dateLastActivity: 'v' };
      if (p === `/1/boards/${quadro}/lists`) return [{ id: 'l1', name: 'A fazer', pos: 1 }];
      // como o Trello: só vem o que foi pedido em fields (e sempre o id)
      if (p === `/1/boards/${quadro}/cards`) return [Object.fromEntries(['id', ...(c.url.searchParams.get('fields') ?? '').split(',')].map((k) => [k, card[k]]))];
      if (p === '/1/cards/c1' && c.method === 'PUT') { Object.assign(card, c.body); return card; }
      return naoSimulada(c);
    };
    const leitura = new TrelloProvider('chave', 'segredo');
    const prazo = async () => (await leitura.getBoard(quadro)).tasks[0].due;
    assert.equal(await prazo(), null);
    await w.editar(quadro, 'c1', { prazo: '2026-11-20' });
    assert.equal(await prazo(), '2026-11-20');
    await w.editar(quadro, 'c1', { prazo: null });
    assert.equal(await prazo(), null);
  });
  test('inverso da leitura: concluir aparece como completed nos dois jeitos, e reabrir desfaz', async () => {
    const quadro = 'quadro123';
    const montar = (listas: Array<{ id: string; name: string; pos: number }>) => {
      const card = { id: 'c1', name: 'X', desc: '', idList: 'l1', dueComplete: false, dateLastActivity: 'v1' };
      answer = (c) => {
        const p = c.url.pathname;
        if (p === `/1/boards/${quadro}`) return { name: 'Q', dateLastActivity: 'v' };
        if (p === `/1/boards/${quadro}/lists`) return listas;
        if (p === `/1/boards/${quadro}/cards`) return [card];
        if (p === '/1/cards/c1' && c.method === 'PUT') { Object.assign(card, c.body, { dateLastActivity: 'v2' }); return card; }
        if (p === '/1/cards/c1') return card;
        return naoSimulada(c);
      };
    };
    const leitura = new TrelloProvider('chave', 'segredo');
    const ver = async () => (await leitura.getBoard(quadro)).tasks[0];
    montar([{ id: 'l1', name: 'A fazer', pos: 1 }, { id: 'l2', name: 'Feito', pos: 2 }]);
    const r = await w.concluir(quadro, 'c1', true);
    assert.equal((await ver()).completed, true); assert.equal((await ver()).columnExternalId, 'l2'); assert.equal(r.versao, (await ver()).version);
    await w.concluir(quadro, 'c1', false);
    assert.equal((await ver()).completed, false); assert.equal((await ver()).columnExternalId, 'l1');
    montar([{ id: 'l1', name: 'A fazer', pos: 1 }]);
    await w.concluir(quadro, 'c1', true);
    assert.equal((await ver()).completed, true);
    await w.concluir(quadro, 'c1', false);
    assert.equal((await ver()).completed, false);
  });
});

describe('Jira: escrita', () => {
  const w = escritorJira('empresa', 'a@b.c', 'tok');
  const API = '/rest/api/3';
  const AUTH = `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`;
  const trans = (id: string, nomeSituacao: string, categoria: string, fields: Record<string, unknown> = {}) => ({ id, name: `para ${nomeSituacao}`, to: { id: `s${id}`, name: nomeSituacao, statusCategory: { key: categoria } }, fields });
  /** Simula uma tarefa com situação e transições; registra a transição feita. */
  const jira = (status: { id: string; name: string; statusCategory: { key: string } }, transitions: unknown[], extra: (c: Call) => unknown = naoSimulada) => (c: Call) => {
    if (c.url.pathname.endsWith('/transitions')) return c.method === 'GET' ? { transitions } : vazio();
    if (c.method === 'GET' && /\/issue\/[^/]+$/.test(c.url.pathname)) return { fields: { status } };
    return extra(c);
  };
  const ABERTA = { id: '1', name: 'A fazer', statusCategory: { key: 'new' } };
  const PRONTA = { id: '3', name: 'Concluído', statusCategory: { key: 'done' } };

  test('site inválido é erro de ação ao usar, sem nenhuma chamada; o endereço é o do site', async () => {
    const ruim = escritorJira('https://atacante.com', 'a@b.c', 'tok');
    await assert.rejects(() => ruim.concluir('PROJ', 'PROJ-1', true), erroAcao(/endereço do Jira inválido/));
    await assert.rejects(() => ruim.editar('PROJ', 'PROJ-1', { titulo: 'A' }), erroAcao(/endereço do Jira inválido/));
    assert.equal(calls.length, 0);
    answer = () => vazio();
    await w.editar('PROJ', 'PROJ-1', { titulo: 'A' });
    assert.equal(calls[0].url.host, 'empresa.atlassian.net'); assert.equal(calls[0].auth, AUTH);
  });
  test('criar: acha o tipo de tarefa, descrição em ADF, prazo em duedate; devolve a chave, que é o id da leitura', async () => {
    answer = (c) => c.url.pathname.includes('createmeta')
      ? { issueTypes: [{ id: '5', name: 'Épico', subtask: false, hierarchyLevel: 1 }, { id: '7', name: 'Subtarefa', subtask: true, hierarchyLevel: -1 }, { id: '9', name: 'Tarefa', subtask: false, hierarchyLevel: 0 }] }
      : { id: '10001', key: 'PROJ-1', self: 'x' };
    const r = await w.criar('PROJ', { titulo: 'Revisar\ncontrato', descricao: 'linha 1\n\nlinha 2', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 'PROJ-1', versao: null, url: 'https://empresa.atlassian.net/browse/PROJ-1' });
    assert.equal(calls[0].url.pathname, `${API}/issue/createmeta/PROJ/issuetypes`);
    const c = calls[1];
    assert.equal(c.method, 'POST'); assert.equal(c.url.pathname, `${API}/issue`); assert.equal(c.auth, AUTH);
    assert.deepEqual(c.body.fields, {
      project: { key: 'PROJ' }, summary: 'Revisar contrato', issuetype: { id: '9' }, duedate: '2026-11-20',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'linha 1' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'linha 2' }] }] },
    });
  });
  test('criar: sem "Task", o primeiro do nível padrão; sem tipo nenhum, avisa sem escrever', async () => {
    answer = (c) => c.url.pathname.includes('createmeta') ? { issueTypes: [{ id: '5', name: 'Epic', hierarchyLevel: 1 }, { id: '6', name: 'História', hierarchyLevel: 0 }] } : { key: 'PROJ-1' };
    await w.criar('PROJ', { titulo: 'A', coluna: '__tarefas__' });
    assert.equal(calls[1].body.fields.issuetype.id, '6');
    calls.length = 0;
    answer = () => ({ issueTypes: [] });
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A' }), erroAcao(/Create issues/));
    assert.equal(escritas().length, 0);
  });
  test('criar numa coluna: confere a situação antes e transita depois; se a coluna não existe, nada é criado', async () => {
    const meta = (c: Call) => c.url.pathname.includes('createmeta') ? { issueTypes: [{ id: '9', name: 'Task' }] }
      : c.url.pathname.endsWith('/statuses') ? [{ statuses: [{ id: '1', name: 'A fazer' }, { id: 's2', name: 'Fazendo' }] }] : { key: 'PROJ-1' };
    answer = (c) => jira(ABERTA, [trans('2', 'Fazendo', 'indeterminate')], meta)(c);
    await w.criar('PROJ', { titulo: 'A', coluna: 's2' });
    const es = escritas();
    assert.equal(es.length, 2); assert.equal(es[0].url.pathname, `${API}/issue`);
    assert.equal(es[1].url.pathname, `${API}/issue/PROJ-1/transitions`); assert.deepEqual(es[1].body, { transition: { id: '2' } });
    calls.length = 0;
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 'Nada' }), erroAcao(/não tem a situação "Nada"/, ['A fazer', 'Fazendo']));
    assert.equal(escritas().length, 0);
    // a coluna é a inicial: nasce nela, sem transição
    calls.length = 0;
    await w.criar('PROJ', { titulo: 'A', coluna: '1' });
    assert.equal(escritas().length, 1);
  });
  test('criar: se não der para ir à coluna, diz a chave e avisa para não criar de novo', async () => {
    const meta = (c: Call) => c.url.pathname.includes('createmeta') ? { issueTypes: [{ id: '9', name: 'Task' }] }
      : c.url.pathname.endsWith('/statuses') ? [{ statuses: [{ id: 's2', name: 'Fazendo' }] }] : { key: 'PROJ-1' };
    answer = (c) => jira(ABERTA, [trans('4', 'Bloqueada', 'indeterminate')], meta)(c);
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 's2' }), erroAcao(/PROJ-1 foi criada.*Não crie de novo/, ['Bloqueada']));
    calls.length = 0;
    answer = (c) => c.method === 'GET' && c.url.pathname.endsWith('/PROJ-1') ? falha(500)() : jira(ABERTA, [], meta)(c);
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 's2' }), erroAcao(/PROJ-1 foi criada/));
  });
  const META = (statuses: unknown[]) => (c: Call): unknown => c.url.pathname.includes('createmeta') ? { issueTypes: [{ id: '9', name: 'Task' }] } : c.url.pathname.endsWith('/statuses') ? [{ statuses }] : { key: 'PROJ-1' };
  const BACKLOG = { id: 's0', name: 'Backlog', statusCategory: { key: 'new' } };
  const FAZENDO = { id: 's2', name: 'Fazendo', statusCategory: { key: 'indeterminate' } };
  const CRIADA = { id: 'PROJ-1', versao: null, url: 'https://empresa.atlassian.net/browse/PROJ-1' };
  test('criar pela metade: o erro leva a tarefa criada, para o espelho ligar o card sem duplicar', async () => {
    answer = jira(ABERTA, [trans('4', 'Bloqueada', 'indeterminate')], META([FAZENDO]));
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 's2' }), (e: unknown) => {
      erroAcao(/PROJ-1 foi criada/, ['Bloqueada'])(e);
      assert.deepEqual((e as ErroAcao).criado, CRIADA);
      return true;
    });
    assert.equal(escritas().filter((c) => c.url.pathname === `${API}/issue`).length, 1);
  });
  test('criar: a situação pedida e a inicial são as duas da categoria "new": não é falha', async () => {
    // tasks.ts sempre manda a primeira coluna (aqui "Backlog"), e o fluxo pode começar em outra de "a fazer"
    answer = jira(ABERTA, [], META([BACKLOG, ABERTA]));
    assert.deepEqual(await w.criar('PROJ', { titulo: 'A', coluna: 's0' }), CRIADA);
    // há caminho: vai para a pedida
    calls.length = 0;
    answer = jira(ABERTA, [trans('0', 'Backlog', 'new')], META([BACKLOG, ABERTA]));
    await w.criar('PROJ', { titulo: 'A', coluna: 's0' });
    assert.deepEqual(escritas()[1].body, { transition: { id: '0' } });
    // transição recusada ou indisponível também não é falha
    const base = jira(ABERTA, [trans('0', 'Backlog', 'new')], META([BACKLOG, ABERTA]));
    answer = (c) => c.url.pathname.endsWith('/transitions') && c.method === 'POST' ? falha(400)() : base(c);
    assert.deepEqual(await w.criar('PROJ', { titulo: 'A', coluna: 's0' }), CRIADA);
    answer = (c) => c.url.pathname.endsWith('/transitions') ? falha(403)() : base(c);
    assert.deepEqual(await w.criar('PROJ', { titulo: 'A', coluna: 's0' }), CRIADA);
    // pediu "a fazer" e nasceu em outra categoria: aí é falha, e o card sabe qual é a tarefa
    answer = jira(FAZENDO, [], META([BACKLOG]));
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 's0' }), (e: unknown) => { erroAcao(/PROJ-1 foi criada/)(e); assert.deepEqual((e as ErroAcao).criado, CRIADA); return true; });
    // pediu outra categoria e nasceu em "a fazer": também
    answer = jira(ABERTA, [], META([FAZENDO]));
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A', coluna: 's2' }), erroAcao(/PROJ-1 foi criada/));
  });
  test('200 sem chave ao criar não vira id vazio: diz que não confirmou', async () => {
    answer = (c) => c.url.pathname.includes('createmeta') ? { issueTypes: [{ id: '9', name: 'Task' }] } : {};
    await assert.rejects(() => w.criar('PROJ', { titulo: 'A' }), naoConfirmou);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.editar('PROJ', ruim, { titulo: 'A' }), erroAcao(/id inválido/));
      await assert.rejects(() => w.comentar!('PROJ', ruim, 'x'), erroAcao(/id inválido/));
      await assert.rejects(() => w.concluir('PROJ', ruim, true), erroAcao(/id inválido/));
      await assert.rejects(() => w.mover('PROJ', ruim, '1'), erroAcao(/id inválido/));
      await assert.rejects(() => w.criar(ruim, { titulo: 'A' }), erroAcao(/id inválido/));
    }
    assert.equal(calls.length, 0);
  });
  test('recusa: o motivo do Jira aparece (errorMessages e errors como objeto), neutralizado', async () => {
    answer = () => new Response(JSON.stringify({ errorMessages: ['Projeto [[x]] fechado'], errors: { duedate: 'Campo fora da tela' } }), { status: 400 });
    await assert.rejects(() => w.editar('PROJ', 'PROJ-1', { titulo: 'A' }), erroAcao(/Projeto \[ \[x\] \] fechado; duedate: Campo fora da tela/));
  });
  test('concluir: escolhe a transição de categoria done com nome de feito, não a de cancelar', async () => {
    answer = jira(ABERTA, [trans('2', 'Fazendo', 'indeterminate'), trans('8', 'Cancelado', 'done'), trans('3', 'Concluído', 'done')]);
    assert.deepEqual(await w.concluir('PROJ', 'PROJ-1', true), { id: 'PROJ-1', versao: null, url: 'https://empresa.atlassian.net/browse/PROJ-1' });
    assert.equal(calls[0].url.pathname, `${API}/issue/PROJ-1`); assert.equal(calls[0].url.searchParams.get('fields'), 'status');
    assert.equal(calls[1].url.pathname, `${API}/issue/PROJ-1/transitions`); assert.equal(calls[1].url.searchParams.get('expand'), 'transitions.fields');
    assert.equal(calls[2].method, 'POST'); assert.deepEqual(calls[2].body, { transition: { id: '3' } });
  });
  test('concluir: uma só de categoria done vale mesmo com outro nome; várias sem nome claro pedem escolha', async () => {
    answer = jira(ABERTA, [trans('6', 'Publicado', 'done')]);
    await w.concluir('PROJ', 'PROJ-1', true);
    assert.deepEqual(escritas()[0].body, { transition: { id: '6' } });
    calls.length = 0;
    answer = jira(ABERTA, [trans('6', 'Publicado', 'done'), trans('8', 'Cancelado', 'done')]);
    await assert.rejects(() => w.concluir('PROJ', 'PROJ-1', true), erroAcao(/mais de uma situação de concluído/, ['Publicado', 'Cancelado']));
    assert.equal(escritas().length, 0);
  });
  test('concluir sem transição de concluído lista as que há; sem nenhuma, fala da permissão', async () => {
    answer = jira(ABERTA, [trans('2', 'Fazendo', 'indeterminate')]);
    await assert.rejects(() => w.concluir('PROJ', 'PROJ-1', true), erroAcao(/situação de concluído.*Transições disponíveis: Fazendo/, ['Fazendo']));
    answer = jira(ABERTA, []);
    await assert.rejects(() => w.concluir('PROJ', 'PROJ-1', true), erroAcao(/Transition issues/, []));
    assert.equal(escritas().length, 0);
  });
  test('repetir dá no mesmo: já concluída não transita (nem para outra de categoria done); já aberta também não', async () => {
    answer = jira(PRONTA, [trans('8', 'Cancelado', 'done')]);
    await w.concluir('PROJ', 'PROJ-1', true);
    answer = jira(ABERTA, [trans('3', 'Concluído', 'done')]);
    await w.concluir('PROJ', 'PROJ-1', false);
    assert.equal(escritas().length, 0);
  });
  test('reabrir prefere a categoria "a fazer"', async () => {
    answer = jira(PRONTA, [trans('2', 'Fazendo', 'indeterminate'), trans('1', 'A fazer', 'new'), trans('8', 'Cancelado', 'done')]);
    await w.concluir('PROJ', 'PROJ-1', false);
    assert.deepEqual(escritas()[0].body, { transition: { id: '1' } });
  });
  test('transição que pede campo: prefere a que não pede; recusada, diz qual campo', async () => {
    const pede = { resolution: { required: true, hasDefaultValue: false, name: 'Resolução', key: 'resolution' } };
    answer = jira(ABERTA, [trans('3', 'Done', 'done', pede), trans('5', 'Resolved', 'done', { x: { required: true, hasDefaultValue: true, name: 'X' } })]);
    await w.concluir('PROJ', 'PROJ-1', true);
    assert.deepEqual(escritas()[0].body, { transition: { id: '5' } });
    const pedeTudo = jira(ABERTA, [trans('3', 'Done', 'done', pede)]);
    answer = (c) => c.method === 'POST' ? falha(400)() : pedeTudo(c);
    await assert.rejects(() => w.concluir('PROJ', 'PROJ-1', true), erroAcao(/recusou a transição "para Done": ela pede Resolução/));
  });
  test('mover: transição pela situação de destino; já nela não faz nada; coluna sintética não chama nada', async () => {
    answer = jira(ABERTA, [trans('2', 'Fazendo', 'indeterminate')]);
    await w.mover('PROJ', 'PROJ-1', 's2');
    assert.deepEqual(escritas()[0].body, { transition: { id: '2' } });
    calls.length = 0;
    await w.mover('PROJ', 'PROJ-1', '1');
    assert.equal(escritas().length, 0);
    calls.length = 0;
    await w.mover('PROJ', 'PROJ-1', '__tarefas__');
    assert.equal(calls.length, 0);
  });
  test('mover sem transição: diz de onde, para onde e lista as que há', async () => {
    answer = jira(ABERTA, [trans('2', 'Fazendo', 'indeterminate')], () => [{ statuses: [{ id: 's9', name: 'Arquivo' }] }]);
    await assert.rejects(() => w.mover('PROJ', 'PROJ-1', 's9'), erroAcao(/de "A fazer" para "Arquivo".*Fazendo/, ['Fazendo']));
    assert.equal(escritas().length, 0);
  });
  test('editar: só o que mudou; prazo null e descrição vazia limpam; tira a chave que a leitura põe no título', async () => {
    answer = vazio;
    await w.editar('PROJ', 'PROJ-1', { titulo: 'PROJ-1 · Novo', descricao: '  ', prazo: null });
    assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].url.pathname, `${API}/issue/PROJ-1`);
    assert.deepEqual(calls[0].body, { fields: { summary: 'Novo', description: null, duedate: null } });
    await w.editar('PROJ', 'PROJ-1', { descricao: 'texto', prazo: '2026-12-01' });
    assert.deepEqual(calls[1].body.fields, { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'texto' }] }] }, duedate: '2026-12-01' });
    await w.editar('PROJ', 'PROJ-1', {});
    assert.equal(calls.length, 2);
  });
  test('comentar em ADF; comentário vazio não sai', async () => {
    answer = () => ({ id: '1' });
    await w.comentar!('PROJ', 'PROJ-1', 'feito\r\nok');
    assert.equal(calls[0].url.pathname, `${API}/issue/PROJ-1/comment`);
    assert.deepEqual(calls[0].body.body.content.map((p: any) => p.content[0].text), ['feito', 'ok']);
    assert.equal(calls[0].body.body.type, 'doc'); assert.equal(calls[0].body.body.version, 1);
    await assert.rejects(() => w.comentar!('PROJ', 'PROJ-1', '  \n '), erroAcao(/vazio/));
    assert.equal(calls.length, 1);
  });
  test('ids estranhos não mudam o endereço; recusa vira ErroAcao; acesso e 5xx seguem como erro do serviço, sem repetir', async () => {
    answer = vazio;
    await w.editar('PROJ', '../../myself', { titulo: 'A' });
    assert.equal(calls[0].url.pathname, `${API}/issue/..%2F..%2Fmyself`);
    answer = falha(400);
    await assert.rejects(() => w.editar('PROJ', 'PROJ-1', { titulo: 'A' }), erroAcao(/Jira recusou/));
    answer = falha(403);
    await assert.rejects(() => w.editar('PROJ', 'PROJ-1', { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    calls.length = 0; answer = falha(500);
    await naoRepete(() => w.editar('PROJ', 'PROJ-1', { titulo: 'A' }));
    calls.length = 0;
    const j = jira(ABERTA, [trans('3', 'Done', 'done')]);
    answer = (c) => c.method === 'POST' ? falha(500)() : j(c);
    await naoRepete(() => w.concluir('PROJ', 'PROJ-1', true));
  });
  test('inverso da leitura: mover e concluir aparecem na situação e em completed; reabrir desfaz', async () => {
    const S: Record<string, { id: string; name: string; statusCategory: { key: string } }> = {
      s1: { id: 's1', name: 'A fazer', statusCategory: { key: 'new' } }, s2: { id: 's2', name: 'Fazendo', statusCategory: { key: 'indeterminate' } }, s3: { id: 's3', name: 'Done', statusCategory: { key: 'done' } },
    };
    let agora = 's1';
    answer = (c) => {
      const p = c.url.pathname.slice(API.length);
      if (p === '/project/PROJ') return { name: 'Projeto' };
      if (p === '/project/PROJ/statuses') return [{ statuses: Object.values(S) }];
      if (p === '/search/jql') return { issues: [{ key: 'PROJ-1', fields: { summary: 'X', status: S[agora], updated: 'v' } }], isLast: true };
      if (p === '/issue/PROJ-1') return { fields: { status: S[agora] } };
      if (p === '/issue/PROJ-1/transitions' && c.method === 'GET') return { transitions: Object.values(S).filter((s) => s.id !== agora).map((s) => ({ id: `t-${s.id}`, name: s.name, to: s })) };
      if (p === '/issue/PROJ-1/transitions') { agora = String(c.body.transition.id).slice(2); return vazio(); }
      return naoSimulada(c);
    };
    const leitura = new JiraProvider('empresa', 'a@b.c', 'tok');
    const ver = async () => (await leitura.getBoard('PROJ')).tasks[0];
    await w.mover('PROJ', 'PROJ-1', 's2');
    assert.equal((await ver()).columnExternalId, 's2');
    await w.concluir('PROJ', 'PROJ-1', true);
    assert.equal((await ver()).completed, true); assert.equal((await ver()).columnExternalId, 's3');
    await w.concluir('PROJ', 'PROJ-1', false);
    assert.equal((await ver()).completed, false); assert.equal((await ver()).columnExternalId, 's1');
  });
});

describe('ClickUp: escrita', () => {
  const w = escritorClickUp('pk_tok');
  const SIT = [{ status: 'closed', type: 'closed', orderindex: 3 }, { status: 'A Fazer', type: 'open', orderindex: 0 }, { status: 'pronto', type: 'done', orderindex: 2 }, { status: 'fazendo', type: 'custom', orderindex: 1 }];
  const TAREFA = { id: 't1', date_updated: '1700', url: 'https://app.clickup.com/t/t1', due_date: null };
  const rota = (c: Call): unknown => c.method === 'GET' ? { statuses: SIT } : TAREFA;

  test('criar: situação pelo nome real, prazo em ms ao meio-dia em UTC, token sem Bearer; devolve id, versão e endereço', async () => {
    answer = rota;
    const r = await w.criar('L1', { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'a fazer', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: 't1', versao: '1700', url: 'https://app.clickup.com/t/t1' });
    assert.equal(calls[0].url.pathname, '/api/v2/list/L1');
    const c = calls[1];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, 'https://api.clickup.com/api/v2/list/L1/task'); assert.equal(c.auth, 'pk_tok');
    assert.deepEqual(c.body, { name: 'Revisar', description: 'cláusula 4', status: 'A Fazer', due_date: Date.UTC(2026, 10, 20, 12), due_date_time: false });
  });
  test('criar sem coluna, ou na sintética, deixa a situação padrão da lista e não consulta nada', async () => {
    answer = rota;
    await w.criar('L1', { titulo: 'A' }); await w.criar('L1', { titulo: 'B', coluna: '__tarefas__' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { name: 'A' }); assert.deepEqual(calls[1].body, { name: 'B' });
  });
  test('situação inexistente lista as opções, sem escrever', async () => {
    answer = (c) => c.method === 'GET' ? { statuses: [{ status: 'fila [[a]]', type: 'open', orderindex: 0 }] } : TAREFA;
    await assert.rejects(() => w.criar('L1', { titulo: 'A', coluna: 'Nada' }), erroAcao(/não tem a situação "Nada"/, ['fila [ [a] ]']));
    await assert.rejects(() => w.mover('L1', 't1', 'Nada'), erroAcao(/não tem a situação/));
    assert.equal(escritas().length, 0);
  });
  test('concluir vai à situação de tipo done; sem ela, à closed; reabrir, à de tipo open', async () => {
    answer = rota;
    assert.deepEqual(await w.concluir('L1', 't1', true), { id: 't1', versao: '1700', url: 'https://app.clickup.com/t/t1' });
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].url.pathname, '/api/v2/task/t1'); assert.deepEqual(calls[1].body, { status: 'pronto' });
    await w.concluir('L1', 't1', false);
    assert.deepEqual(calls[3].body, { status: 'A Fazer' });
    calls.length = 0;
    answer = (c) => c.method === 'GET' ? { statuses: [{ status: 'a', type: 'custom', orderindex: 0 }, { status: 'fim', type: 'closed', orderindex: 1 }] } : TAREFA;
    await w.concluir('L1', 't1', true);
    assert.deepEqual(calls[1].body, { status: 'fim' });
    await w.concluir('L1', 't1', false);
    assert.deepEqual(calls[3].body, { status: 'a' });
  });
  test('lista sem situação de concluído é erro claro, com as opções', async () => {
    answer = () => ({ statuses: [{ status: 'a', type: 'open', orderindex: 0 }] });
    await assert.rejects(() => w.concluir('L1', 't1', true), erroAcao(/não tem situação de concluído/, ['a']));
    answer = () => ({ statuses: [] });
    await assert.rejects(() => w.concluir('L1', 't1', true), erroAcao(/não tem situação de concluído/, []));
    assert.equal(escritas().length, 0);
  });
  test('mover usa a situação pelo nome; coluna sintética não chama nada', async () => {
    answer = rota;
    await w.mover('L1', 't1', 'fazendo');
    assert.deepEqual(calls[1].body, { status: 'fazendo' });
    calls.length = 0;
    await w.mover('L1', 't1', '__tarefas__');
    assert.equal(calls.length, 0);
  });
  test('editar: só o que mudou; descrição vazia vira um espaço; prazo null; sem mudança não chama nada', async () => {
    answer = rota;
    await w.editar('L1', 't1', { titulo: 'Novo', descricao: '', prazo: null });
    assert.equal(calls[0].method, 'PUT');
    assert.deepEqual(calls[0].body, { name: 'Novo', description: ' ', due_date: null, due_date_time: false });
    await w.editar('L1', 't1', { prazo: '2026-12-01' });
    assert.deepEqual(calls[1].body, { due_date: Date.UTC(2026, 11, 1, 12), due_date_time: false });
    await w.editar('L1', 't1', {});
    assert.equal(calls.length, 2);
  });
  test('se a resposta ainda trouxer o prazo depois do null, não diz que tirou', async () => {
    answer = () => ({ ...TAREFA, due_date: '1800000000000' });
    await assert.rejects(() => w.editar('L1', 't1', { prazo: null }), erroAcao(/não tirou o prazo/));
  });
  test('comentar manda notify_all, que a API exige', async () => {
    answer = () => ({ id: 'c1', hist_id: 'h1', date: 1 });
    await w.comentar!('L1', 't1', 'feito');
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/api/v2/task/t1/comment');
    assert.deepEqual(calls[0].body, { comment_text: 'feito', notify_all: false });
  });
  test('ids estranhos não mudam o endereço; recusa vira ErroAcao; acesso e 5xx seguem como erro do serviço, sem repetir', async () => {
    answer = rota;
    await w.editar('L1', '../user', { titulo: 'A' });
    assert.equal(calls[0].url.pathname, '/api/v2/task/..%2Fuser');
    answer = falha(400);
    await assert.rejects(() => w.editar('L1', 't1', { titulo: 'A' }), erroAcao(/ClickUp recusou/));
    answer = falha(401);
    await assert.rejects(() => w.editar('L1', 't1', { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    calls.length = 0; answer = falha(500);
    await naoRepete(() => w.editar('L1', 't1', { titulo: 'A' }));
  });
  test('200 sem id ao criar não vira id vazio: diz que não confirmou', async () => {
    answer = () => ({});
    await assert.rejects(() => w.criar('L1', { titulo: 'A' }), naoConfirmou);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.editar('L1', ruim, { titulo: 'A' }), erroAcao(/id inválido/));
      await assert.rejects(() => w.comentar!('L1', ruim, 'x'), erroAcao(/id inválido/));
      await assert.rejects(() => w.criar(ruim, { titulo: 'A' }), erroAcao(/id inválido/));
      await assert.rejects(() => w.concluir(ruim, 't1', true), erroAcao(/id inválido/));
    }
    assert.equal(calls.length, 0);
  });
  test('recusa: o motivo do ClickUp aparece (err e ECODE)', async () => {
    answer = () => new Response(JSON.stringify({ err: 'Status not found', ECODE: 'ITEM_015' }), { status: 400 });
    await assert.rejects(() => w.editar('L1', 't1', { titulo: 'A' }), erroAcao(/ClickUp recusou.*ITEM_015: Status not found/));
  });
  test('inverso da leitura: concluir aparece como completed, mover na coluna, reabrir desfaz, prazo no mesmo dia', async () => {
    const t: any = { id: 't1', name: 'X', status: SIT[1], date_updated: '1', due_date: null };
    answer = (c) => {
      const p = c.url.pathname;
      if (p === '/api/v2/list/L1') return { name: 'Lista', statuses: SIT };
      if (p === '/api/v2/list/L1/task') return { tasks: [t], last_page: true };
      if (p === '/api/v2/task/t1') {
        if (c.body.status) t.status = SIT.find((s) => s.status === c.body.status);
        if ('due_date' in c.body) t.due_date = c.body.due_date === null ? null : String(c.body.due_date);
        t.date_updated = '2';
        return t;
      }
      return naoSimulada(c);
    };
    const leitura = new ClickUpProvider('pk_tok');
    const ver = async () => (await leitura.getBoard('L1')).tasks[0];
    const r = await w.concluir('L1', 't1', true);
    assert.equal((await ver()).completed, true); assert.equal((await ver()).columnExternalId, 'pronto'); assert.equal(r.versao, (await ver()).version);
    await w.concluir('L1', 't1', false);
    assert.equal((await ver()).completed, false); assert.equal((await ver()).columnExternalId, 'a fazer');
    await w.mover('L1', 't1', 'fazendo');
    assert.equal((await ver()).columnExternalId, 'fazendo');
    await w.editar('L1', 't1', { prazo: '2026-11-20' });
    assert.equal((await ver()).due, '2026-11-20');
    await w.editar('L1', 't1', { prazo: null });
    assert.equal((await ver()).due, null);
  });
});
