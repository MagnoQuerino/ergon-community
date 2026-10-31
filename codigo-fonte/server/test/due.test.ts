import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dueOf, parseDue, validDue } from '../src/services/due.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

// sábado, 24/10/2026, 10h em São Paulo
const NOW = Date.parse('2026-10-24T13:00:00Z');
const TZ = 'America/Sao_Paulo';

describe('prazo das tarefas', () => {
  test('o pedido diz o prazo (só com palavra de prazo antes da data)', () => {
    assert.equal(parseDue('Revisar o contrato até sexta', TZ, NOW), '2026-10-30', 'a próxima sexta');
    assert.equal(parseDue('Arrumar a agenda até sábado', TZ, NOW), '2026-10-24', 'hoje é sábado: até sábado = hoje');
    assert.equal(parseDue('Relatório de custos até segunda-feira', TZ, NOW), '2026-10-26');
    assert.equal(parseDue('Enviar a proposta até amanhã', TZ, NOW), '2026-10-25');
    assert.equal(parseDue('Fechar o orçamento até hoje', TZ, NOW), '2026-10-24');
    assert.equal(parseDue('Apresentação para 30/10', TZ, NOW), '2026-10-30');
    assert.equal(parseDue('Entregar o site até 15/01', TZ, NOW), '2027-01-15', 'data que já passou este ano = ano que vem');
    assert.equal(parseDue('Pagar o fornecedor até o dia 5', TZ, NOW), '2026-11-05', 'dia que já passou este mês = mês que vem');
    assert.equal(parseDue('Prazo: dia 28', TZ, NOW), '2026-10-28');
    assert.equal(parseDue('Organizar os arquivos até o fim do mês', TZ, NOW), '2026-10-31');
    assert.equal(parseDue('Reunião na sexta com o cliente', TZ, NOW), null, 'sem palavra de prazo, não é prazo');
    assert.equal(parseDue('Revisar o contrato', TZ, NOW), null);
    assert.equal(parseDue('até 31/02', TZ, NOW), null, 'data que não existe');
  });

  test('datas dos aplicativos espelhados', () => {
    assert.equal(dueOf('2026-11-03'), '2026-11-03');
    assert.equal(dueOf('2026-11-03T12:00:00.000Z'), '2026-11-03');
    assert.equal(dueOf('1793750400000'), '2026-11-04', 'carimbo em ms (ClickUp)');
    assert.equal(dueOf(null), null);
    assert.equal(dueOf('amanhã'), null);
    assert.ok(validDue('2026-02-28') && !validDue('2026-02-30') && !validDue('30/10/2026'));
  });

  describe('no Ergon', () => {
    let h: Harness; let s: Session;
    before(async () => { h = await harness(); s = await setupOwner(h); });
    after(async () => { await h.close(); });

    test('criar com prazo, mudar, tirar; o prazo vai junto quando a tarefa é enviada à equipe', async () => {
      const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Planejar o lançamento', dueOn: '2026-11-10' })).json;
      assert.equal(t.due_on, '2026-11-10');
      const p = await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { dueOn: '2026-11-12', expectedRevision: t.revision });
      assert.equal(p.status, 200);
      assert.equal(h.db.get<{ d: string }>('SELECT due_on AS d FROM tasks WHERE id = ?', t.id)!.d, '2026-11-12');
      assert.equal((await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { dueOn: '2026-02-30' })).status, 400, 'data que não existe');
      assert.equal((await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { dueOn: 'amanhã' })).status, 400);
      const sent = (await req(h, 'POST', `/api/tasks/${t.id}/send-to-team`, s)).json;
      assert.equal(h.db.get<{ d: string }>('SELECT due_on AS d FROM tasks WHERE number = ? AND workspace_id = ?', sent.number, s.workspaceId)!.d, '2026-11-12');
      assert.equal((await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { dueOn: null })).status, 200);
      assert.equal(h.db.get<{ d: string | null }>('SELECT due_on AS d FROM tasks WHERE id = ?', t.id)!.d, null);
      // o quadro traz o prazo para o card e para a lista
      const view = (await req(h, 'GET', `/api/boards/${t.board_id}`, s)).json;
      assert.ok('due_on' in view.tasks.find((x: { id: string }) => x.id === t.id));
    });

    test('um pedido com prazo no chat vira o plano da coordenação, e o card nasce com o prazo', async () => {
      const coord = (await req(h, 'GET', '/api/state', s)).json.team.coordinator;
      const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord.id })).json;
      await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: 'Preciso que alguém revise o contrato até amanhã', clientRequestId: 'prazo-00001' });
      for (let i = 0; i < 4; i++) await h.executor.tick(); // a coordenação responde com o plano
      const row = h.db.all<{ title: string; due_on: string | null }>("SELECT title, due_on FROM tasks WHERE workspace_id = ? AND origin = 'chat'", s.workspaceId).find((x) => /contrato/i.test(x.title));
      assert.ok(row, 'virou card');
      assert.match(row!.due_on ?? '', /^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
