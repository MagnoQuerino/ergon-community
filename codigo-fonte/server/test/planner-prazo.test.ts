/**
 * Prazo das tarefas do Planner no espelho: o Planner guarda o prazo
 * como instante em UTC; a data é a do fuso do workspace — a mesma da leitura das contas e do próprio Planner. Exemplo:
 * "Verificar retorno da Construtora Alfa", prazo 25/10 no Planner, aparecia no espelho como 26/10. E o espelho
 * corrige sozinho o que já tinha gravado errado, mesmo sem a tarefa mudar no Planner.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dueAt, dueOf } from '../src/services/due.ts';
import { integrationRow, setIntegration } from '../src/services/integrations.ts';
import { importBoards, type BoardSnapshot, type TaskProvider } from '../src/services/mirror.ts';
import { harness, setupOwner, type Harness, type Session } from './helpers.ts';

const SP = 'America/Sao_Paulo';

describe('prazo dado como instante (Planner)', () => {
  test('a data é a do fuso do workspace, não o texto em UTC', () => {
    // fim do dia 25/10 em Brasília, guardado em UTC já no dia 26
    assert.equal(dueAt('2026-10-26T02:59:59Z', SP), '2026-10-25');
    assert.equal(dueOf('2026-10-26T02:59:59Z'), '2026-10-26', 'o jeito antigo errava o dia');
    // meia-noite de Brasília em UTC
    assert.equal(dueAt('2026-10-25T03:00:00Z', SP), '2026-10-25');
    // o fuso manda: o mesmo instante em UTC é 26/10
    assert.equal(dueAt('2026-10-26T02:59:59Z', 'UTC'), '2026-10-26');
    // só data: vale como está (nada a converter)
    assert.equal(dueAt('2026-10-25', SP), '2026-10-25');
    assert.equal(dueAt('', SP), null); assert.equal(dueAt(null, SP), null); assert.equal(dueAt('não é data', SP), null);
  });
});

describe('espelho do Planner e do To Do (provedor da Microsoft)', () => {
  let h: Harness; let s: Session;
  const realFetch = globalThis.fetch;
  before(async () => {
    h = await harness(); s = await setupOwner(h);
    h.integrations.secrets.write(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3600_000, account: 'eu@empresa.com' });
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'eu@empresa.com', connected_at: new Date().toISOString() });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      const p = u.pathname;
      if (p === '/v1.0/planner/plans/p1') return json({ title: 'Atividades Administrativas', '@odata.etag': 'e1' });
      if (p === '/v1.0/planner/plans/p1/buckets') return json({ value: [{ id: 'b1', name: 'A fazer' }] });
      if (p === '/v1.0/planner/plans/p1/tasks') return json({ value: [
        { id: 't1', title: 'Verificar retorno da Construtora Alfa sobre o orçamento da obra', bucketId: 'b1', percentComplete: 0, '@odata.etag': 'v1', dueDateTime: '2026-10-26T02:59:59Z', assignments: {} },
        { id: 't2', title: 'Aprovar orçamento 4120 da DELTA', bucketId: 'b1', percentComplete: 0, '@odata.etag': 'v1', dueDateTime: '2026-10-25T03:00:00Z', assignments: {} },
      ] });
      if (p === '/v1.0/me/todo/lists/l1') return json({ displayName: 'Tarefas' });
      if (p === '/v1.0/me/todo/lists/l1/tasks') return json({ value: [
        { id: 'd1', title: 'CADASTRAR CLIENTE NO OMIE', status: 'notStarted', lastModifiedDateTime: 'x', dueDateTime: { dateTime: '2026-06-29T00:00:00.0000000', timeZone: 'UTC' } },
      ] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = realFetch; await h.close(); });

  test('Planner: a tarefa de 25/10 chega como 25/10 (antes, 26/10); To Do segue com a data como está', async () => {
    const provider = h.integrations.provider(s.workspaceId, 'microsoft'); // o fuso vem do workspace
    const planner = await provider.getBoard('planner:p1');
    assert.deepEqual(planner.tasks.map((t) => [t.externalId, t.due]), [['t1', '2026-10-25'], ['t2', '2026-10-25']]);
    const todo = await provider.getBoard('todo:l1');
    assert.equal(todo.tasks[0].due, '2026-06-29', 'To Do guarda só a data: converter erraria o dia');
  });
});

describe('o espelho corrige sozinho o prazo já gravado', () => {
  test('mesma versão no aplicativo, prazo calculado diferente: atualiza e registra a mudança de prazo; depois fica quieto', async () => {
    const h = await harness(); const s = await setupOwner(h);
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', connected_at: new Date().toISOString() });
    const conn = integrationRow(h.db, s.workspaceId, 'microsoft').id;
    let due = '2026-10-26'; // como a versão antiga gravava
    const snap = (): BoardSnapshot => ({
      board: { externalId: 'planner:p1', name: 'Planner › Atividades Administrativas', version: 'e1' },
      columns: [{ externalId: 'b1', name: 'A fazer', order: 0 }],
      tasks: [{ externalId: 't1', columnExternalId: 'b1', title: 'Verificar retorno da Construtora Alfa', description: '', completed: false, version: 'v1', assignee: null, due, extra: {} }],
      complete: true,
    });
    const provider: TaskProvider = { name: 'microsoft', isFixture: false, supports: { title: true, description: true, completion: true, columns: true, writeBack: false },
      listBoards: async () => [], getBoard: async () => snap() };
    await importBoards(h.db, h.bus, s.workspaceId, conn, s.userId, provider, ['planner:p1']);
    const dueOn = () => h.db.get<{ due_on: string }>("SELECT t.due_on FROM tasks t JOIN task_links l ON l.task_id = t.id WHERE l.external_id = 't1'")!.due_on;
    assert.equal(dueOn(), '2026-10-26');
    due = '2026-10-25'; // a leitura corrigida; o Planner não mudou nada (mesma versão v1)
    const rep = await importBoards(h.db, h.bus, s.workspaceId, conn, s.userId, provider, ['planner:p1']);
    assert.equal(dueOn(), '2026-10-25');
    assert.equal(rep.boards[0].updated, 1);
    const ev = h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'mirror.task.update' ORDER BY created_at DESC LIMIT 1");
    assert.match(String(ev?.evidence), /"prazo":\{"de":"2026-10-26","para":"2026-10-25"\}/);
    const again = await importBoards(h.db, h.bus, s.workspaceId, conn, s.userId, provider, ['planner:p1']);
    assert.equal(again.boards[0].unchanged, 1, 'sem diferença: pula, como antes');
    await h.close();
  });
});
