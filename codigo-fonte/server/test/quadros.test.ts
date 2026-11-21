/**
 * Os quadros da pessoa (rc.41): vários quadros, colunas livres (criar, renomear, reordenar, apagar), nada se perde ao
 * apagar; o quadro de entrada fica; o da equipe e os espelhados não mudam por aqui.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('quadros da pessoa', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h, 'ana', 'senha-da-ana-123'); });
  after(async () => { await h.close(); });

  const quadros = async () => (await req(h, 'GET', '/api/boards', s)).json as Array<{ id: string; name: string; audience: string; origin: string }>;
  const colunas = async (b: string) => ((await req(h, 'GET', `/api/boards/${b}`, s)).json.columns as Array<{ id: string; name: string }>);

  test('cria um quadro com as colunas iniciais ou as dadas; renomeia; limites e nomes vazios', async () => {
    const r = await req(h, 'POST', '/api/boards', s, { name: '  Casa  ' });
    assert.equal(r.status, 201); assert.equal(r.json.name, 'Casa');
    assert.deepEqual((await colunas(r.json.id)).map((c) => c.name), ['A fazer', 'Fazendo', 'Feito']);
    const p = await req(h, 'POST', '/api/boards', s, { name: 'Pedidos', columns: ['Novo', 'Orçado', 'Pago', 'Entregue'] });
    assert.deepEqual((await colunas(p.json.id)).map((c) => c.name), ['Novo', 'Orçado', 'Pago', 'Entregue']);
    assert.ok((await quadros()).some((b) => b.name === 'Pedidos' && b.audience === 'user' && b.origin === 'native'));
    assert.equal((await req(h, 'PATCH', `/api/boards/${p.json.id}`, s, { name: 'Pedidos 2026' })).json.name, 'Pedidos 2026');
    assert.equal((await req(h, 'POST', '/api/boards', s, { name: '   ' })).status, 400);
    assert.equal((await req(h, 'POST', '/api/boards', s, { name: 'x'.repeat(61) })).status, 400);
  });

  test('colunas livres: cria numa posição, renomeia, reordena; apagar leva os cards para outra coluna; a última fica', async () => {
    const b = (await req(h, 'POST', '/api/boards', s, { name: 'Obra', columns: ['Um'] })).json.id as string;
    const dois = (await req(h, 'POST', `/api/boards/${b}/columns`, s, { name: 'Dois' })).json.id as string;
    await req(h, 'POST', `/api/boards/${b}/columns`, s, { name: 'Zero', position: 0 });
    assert.deepEqual((await colunas(b)).map((c) => c.name), ['Zero', 'Um', 'Dois']);
    await req(h, 'PATCH', `/api/columns/${dois}`, s, { name: 'Dois!', position: 0 });
    assert.deepEqual((await colunas(b)).map((c) => c.name), ['Dois!', 'Zero', 'Um']);
    const t = await req(h, 'POST', '/api/tasks', s, { title: 'Comprar tijolo', boardId: b, columnId: dois });
    assert.equal(t.status, 201, t.body);
    const um = (await colunas(b)).find((c) => c.name === 'Um')!.id;
    const apagou = await req(h, 'DELETE', `/api/columns/${dois}`, s, { destino: um });
    assert.deepEqual([apagou.status, apagou.json.movidos], [200, 1]);
    assert.equal(h.db.get<{ c: string }>('SELECT column_id AS c FROM tasks WHERE id = ?', t.json.id)!.c, um, 'o card não se perdeu');
    const zero = (await colunas(b)).find((c) => c.name === 'Zero')!.id;
    await req(h, 'DELETE', `/api/columns/${zero}`, s, {});
    assert.equal((await req(h, 'DELETE', `/api/columns/${um}`, s, {})).status, 409, 'a última coluna fica');
  });

  test('apagar um quadro leva os cards para outro quadro da pessoa; o de entrada não se apaga', async () => {
    const b = (await req(h, 'POST', '/api/boards', s, { name: 'Viagem' })).json.id as string;
    const col = (await colunas(b))[1].id;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Reservar hotel', boardId: b, columnId: col })).json.id as string;
    const entrada = (await quadros()).find((x) => x.audience === 'user' && x.name === 'Minhas tarefas')!.id;
    const r = await req(h, 'DELETE', `/api/boards/${b}`, s, {});
    assert.deepEqual([r.status, r.json.movidos, r.json.destino], [200, 1, entrada]);
    assert.equal(h.db.get<{ b: string }>('SELECT board_id AS b FROM tasks WHERE id = ?', t)!.b, entrada);
    assert.ok(!(await quadros()).some((x) => x.id === b));
    assert.equal((await req(h, 'DELETE', `/api/boards/${entrada}`, s, {})).status, 409);
    assert.equal((await req(h, 'PATCH', `/api/boards/${entrada}`, s, { name: 'Entrada' })).status, 200, 'renomear pode');
  });

  test('o quadro da equipe não muda por aqui; uma coluna "Feito" num quadro novo não ganha código', async () => {
    const equipe = (await quadros()).find((x) => x.audience === 'team')!;
    assert.equal((await req(h, 'PATCH', `/api/boards/${equipe.id}`, s, { name: 'x' })).status, 409);
    assert.equal((await req(h, 'POST', `/api/boards/${equipe.id}/columns`, s, { name: 'x' })).status, 409);
    const col = (await colunas(equipe.id))[0].id;
    assert.equal((await req(h, 'DELETE', `/api/columns/${col}`, s, {})).status, 409);
    const b = (await req(h, 'POST', '/api/boards', s, { name: 'Livre' })).json.id as string;
    const { marcarColunas } = await import('../src/services/colunas.ts');
    marcarColunas(h.db, s.workspaceId);
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM columns WHERE board_id = ? AND system_key IS NOT NULL', b)!.n, 0);
  });
});
