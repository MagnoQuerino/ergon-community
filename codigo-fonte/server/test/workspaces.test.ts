import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** Vários workspaces por pessoa: visão geral, criar (já entra), trocar, renomear; cada um com os seus dados. */
describe('workspaces da pessoa', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('visão geral, criar, trocar e dados separados', async () => {
    const inicio = (await req(h, 'GET', '/api/workspaces', s)).json;
    assert.equal(inicio.length, 1);
    assert.equal(inicio[0].current, true);
    assert.ok(inicio[0].agents > 0, 'o primeiro workspace já tem a equipe');
    const primeiro = inicio[0].id; const deBoasVindas = inicio[0].openTasks;
    const t = await req(h, 'POST', '/api/tasks', s, { title: 'Tarefa do primeiro' });
    assert.equal(t.status, 201);
    const tarefa = t.json.id ?? t.json.task?.id;
    assert.ok(tarefa, JSON.stringify(t.json));

    const r = await req(h, 'POST', '/api/workspaces', s, { name: '  Loja   da Ana ' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const segundo = r.json.workspaceId;
    const me = (await req(h, 'GET', '/api/me', s)).json;
    assert.equal(me.workspaceId, segundo, 'criar já entra no workspace novo');
    assert.deepEqual(me.workspaces.map((w: { name: string }) => w.name), ['Ergon Local', 'Loja da Ana']);

    const lista = (await req(h, 'GET', '/api/workspaces', s)).json;
    const novo = lista.find((w: { id: string }) => w.id === segundo);
    assert.equal(novo.current, true);
    assert.ok(novo.agents > 0, 'o workspace novo nasce com a equipe');
    assert.equal(novo.openTasks, deBoasVindas, 'só as tarefas de boas-vindas dele');
    assert.equal(lista.find((w: { id: string }) => w.id === primeiro).openTasks, deBoasVindas + 1);

    assert.equal((await req(h, 'GET', `/api/tasks/${tarefa}`, s)).status, 404, 'o workspace novo não vê a tarefa do outro');

    assert.equal((await req(h, 'POST', '/api/session/workspace', s, { workspaceId: primeiro })).status, 200);
    const deVolta = await req(h, 'GET', `/api/tasks/${tarefa}`, s);
    assert.equal(deVolta.status, 200, 'de volta ao primeiro, a tarefa está lá');
    assert.match(JSON.stringify(deVolta.json), /Tarefa do primeiro/);
  });

  test('renomear: só a dona; nome vazio recusado; workspace alheio não existe para ela', async () => {
    const [w] = (await req(h, 'GET', '/api/workspaces', s)).json;
    const r = await req(h, 'PATCH', `/api/workspaces/${w.id}`, s, { name: 'Escritório' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Escritório');
    assert.equal((await req(h, 'PATCH', `/api/workspaces/${w.id}`, s, { name: '   ' })).status, 400);
    assert.equal((await req(h, 'POST', '/api/workspaces', s, { name: '' })).status, 400);
    assert.ok([400, 404].includes((await req(h, 'PATCH', '/api/workspaces/ws_naoexiste123', s, { name: 'X' })).status));
    assert.ok([400, 404].includes((await req(h, 'POST', '/api/session/workspace', s, { workspaceId: 'ws_naoexiste123' })).status));
  });
});
