/**
 * Busca rápida (Ctrl+K): cards de todos os quadros pelo número ou por palavras do título (sem acento, sem caixa),
 * rotinas pelo nome. Os títulos ficam cifrados no banco; a busca abre e filtra no servidor local.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('busca rápida', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('acha card pelo título (sem acento) e pelo número, em qualquer quadro; arquivado não aparece', async () => {
    const boards = (await req(h, 'GET', '/api/boards', s)).json as Array<{ id: string; audience: string }>;
    const mine = boards.find((b) => b.audience === 'user')!;
    const agent = (await req(h, 'GET', '/api/state', s)).json.agents[1];
    const team = (await req(h, 'POST', '/api/tasks', s, { title: 'Cotação de nitrogênio líquido', agentId: agent.id })).json;
    const own = (await req(h, 'POST', '/api/tasks', s, { title: 'Ligar para o fornecedor de nitrogenio', boardId: mine.id })).json;
    const gone = (await req(h, 'POST', '/api/tasks', s, { title: 'Nitrogênio antigo', agentId: agent.id })).json;
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', gone.id);
    const r = (await req(h, 'GET', `/api/search?q=${encodeURIComponent('NITROGENIO')}`, s)).json;
    const ids = r.tasks.map((t: { id: string }) => t.id);
    assert.ok(ids.includes(team.id) && ids.includes(own.id), 'nos dois quadros, sem acento e sem caixa');
    assert.ok(!ids.includes(gone.id), 'arquivado fica de fora');
    assert.equal(r.tasks.find((t: { id: string }) => t.id === team.id).audience, 'team');
    assert.equal(r.tasks.find((t: { id: string }) => t.id === own.id).board_id, mine.id, 'diz em que quadro abrir');
    const byNum = (await req(h, 'GET', `/api/search?q=${encodeURIComponent(`#${team.number}`)}`, s)).json;
    assert.equal(byNum.tasks[0].id, team.id);
    const both = (await req(h, 'GET', `/api/search?q=${encodeURIComponent('fornecedor nitrog')}`, s)).json;
    assert.deepEqual(both.tasks.map((t: { id: string }) => t.id), [own.id], 'todas as palavras');
  });

  test('sem sessão não busca; busca vazia ou longa demais é recusada', async () => {
    assert.equal((await req(h, 'GET', '/api/search?q=x', null)).status, 401);
    assert.equal((await req(h, 'GET', '/api/search?q=', s)).status, 400);
    assert.equal((await req(h, 'GET', `/api/search?q=${'a'.repeat(101)}`, s)).status, 400);
  });
});
