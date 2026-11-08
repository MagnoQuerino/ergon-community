// Escrita no Asana, no formato documentado da API (sem rede): método, endereço, corpo e credencial de cada chamada.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { escritorAsana } from '../src/services/conexoes/escrita/asana.ts';
import { ErroAcao } from '../src/services/conexoes/tipos.ts';
import { ProviderError } from '../src/services/mirror.ts';

type Call = { method: string; url: URL; auth: string; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({ data: { gid: '111', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/1/111' } });
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
afterEach(() => { calls.length = 0; });

describe('Asana: escrita', () => {
  const w = escritorAsana('tok');
  test('criar numa seção usa memberships; devolve id, versão e endereço', async () => {
    const r = await w.criar('proj1', { titulo: 'Revisar', descricao: 'cláusula 4', coluna: 'sec1', prazo: '2026-11-20' });
    assert.deepEqual(r, { id: '111', versao: 'v2', url: 'https://app.asana.com/0/1/111' });
    const c = calls[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.pathname, '/api/1.0/tasks'); assert.equal(c.auth, 'Bearer tok');
    assert.deepEqual(c.body.data, { name: 'Revisar', notes: 'cláusula 4', due_on: '2026-11-20', memberships: [{ project: 'proj1', section: 'sec1' }] });
  });
  test('criar sem coluna, ou na coluna sintética, usa projects', async () => {
    await w.criar('proj1', { titulo: 'A' }); await w.criar('proj1', { titulo: 'B', coluna: '__geral__' });
    assert.deepEqual(calls[0].body.data, { name: 'A', projects: ['proj1'] });
    assert.deepEqual(calls[1].body.data, { name: 'B', projects: ['proj1'] });
  });
  test('concluir e reabrir', async () => {
    await w.concluir('proj1', 't1', true); await w.concluir('proj1', 't1', false);
    assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].url.pathname, '/api/1.0/tasks/t1'); assert.deepEqual(calls[0].body.data, { completed: true });
    assert.deepEqual(calls[1].body.data, { completed: false });
  });
  test('mover é a rota da seção; coluna sintética não chama nada', async () => {
    await w.mover('proj1', 't1', 'sec2');
    assert.equal(calls[0].url.pathname, '/api/1.0/sections/sec2/addTask'); assert.deepEqual(calls[0].body.data, { task: 't1' });
    await w.mover('proj1', 't1', '__geral__');
    assert.equal(calls.length, 1);
  });
  test('editar manda só o que mudou; prazo null tira o prazo', async () => {
    await w.editar('proj1', 't1', { titulo: 'Novo', prazo: null });
    assert.deepEqual(calls[0].body.data, { name: 'Novo', due_on: null });
  });
  test('comentar', async () => {
    await w.comentar!('proj1', 't1', 'feito');
    assert.equal(calls[0].url.pathname, '/api/1.0/tasks/t1/stories'); assert.deepEqual(calls[0].body.data, { text: 'feito' });
  });
  test('200 sem id ao criar não vira id vazio: diz que não confirmou; ao mudar, o id é o da tarefa', async () => {
    const naoConfirmou = (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /não confirmou/.test(e.message);
    answer = () => ({ data: {} });
    await assert.rejects(() => w.criar('proj1', { titulo: 'A' }), naoConfirmou);
    answer = () => ({});
    await assert.rejects(() => w.criar('proj1', { titulo: 'A' }), naoConfirmou);
    assert.equal((await w.concluir('proj1', 't1', true)).id, 't1');
    assert.equal((await w.editar('proj1', 't1', { titulo: 'B' })).id, 't1');
  });
  test('recusa definitiva vira erro com o motivo neutralizado, sem repetir', async () => {
    for (const n of [400, 413, 414, 422]) {
      calls.length = 0;
      answer = () => new Response(JSON.stringify({ errors: [{ message: 'due_on [[ruim]]\nrecusado', help: 'h' }] }), { status: n });
      const recusou = (e: unknown) => e instanceof ErroAcao && /Asana recusou.*due_on \[ \[ruim\] \] recusado/.test(e.message);
      await assert.rejects(() => w.editar('p', 't1', { titulo: 'A' }), recusou);
      await assert.rejects(() => w.criar('p', { titulo: 'A' }), recusou);
      await assert.rejects(() => w.mover('p', 't1', 'sec2'), recusou);
      await assert.rejects(() => w.comentar!('p', 't1', 'x'), recusou);
      assert.equal(calls.length, 4);
    }
    calls.length = 0;
    answer = () => new Response('{}', { status: 500 });
    await assert.rejects(() => w.editar('p', 't1', { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable');
    assert.equal(calls.length, 1);
  });
  test('"." e ".." mudariam a rota: nem saem', async () => {
    const invalido = (e: unknown) => e instanceof ErroAcao && /id inválido/.test(e.message);
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.concluir('p', ruim, true), invalido);
      await assert.rejects(() => w.editar('p', ruim, { titulo: 'A' }), invalido);
      await assert.rejects(() => w.mover('p', 't1', ruim), invalido);
      await assert.rejects(() => w.comentar!('p', ruim, 'x'), invalido);
    }
    assert.equal(calls.length, 0);
  });
  test('sem permissão vira erro de acesso; ids estranhos não mudam o endereço', async () => {
    answer = () => new Response('{}', { status: 403 });
    await assert.rejects(() => w.concluir('p', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    answer = () => ({ data: {} });
    await w.concluir('p', '../users/me', true);
    assert.equal(calls.at(-1)!.url.pathname, '/api/1.0/tasks/..%2Fusers%2Fme');
  });
});
