// Ambiente operacional (A1): a leitura do trabalho bate com o agendador, o executor e "Aguardando você"; conta sem
// duplicar, explica a espera com o motivo real, não muda nada e não mostra o que é de outra pessoa.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runningProcesses } from '../src/services/concurrency.ts';
import { pendingCount } from '../src/services/proposals.ts';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

type Item = { key: string; taskId: string | null; runId: string | null; number: number | null; category: string; reasonCode: string; reason: string; position: number | null; slot: boolean; agentId: string | null; title: string; dependsOn: Array<{ taskId: string }>; actions: string[] };
type Ops = {
  version: number; local: { limit: number | null; busy: number; conversations: number; autorun: boolean; waitingExecutor: number };
  totals: Record<string, number>; items: Record<string, Item[]>; more: Record<string, number>; decisions: { total: number };
  deliveries: { total: number; items: Array<{ taskId: string; simulated: boolean; resultState: string | null }> };
};

describe('Ambiente operacional: leitura do trabalho da equipe', () => {
  let h: Harness; let s: Session; let agents: Array<{ id: string; name: string; coordinator: number }>;
  before(async () => {
    h = await harness({ maxConcurrentRuns: 0, simulatedDelayMs: 300 });
    s = await setupOwner(h);
    agents = (await req(h, 'GET', '/api/state', s)).json.agents;
    h.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ?', s.workspaceId); // começa sem os cards de partida
  });
  after(async () => { await h.close(); });

  const ops = async (sess = s, q = ''): Promise<Ops> => { const r = await req(h, 'GET', `/api/ambient/operations${q}`, sess); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
  const card = async (title: string, agent = agents[1].id) => (await req(h, 'POST', '/api/tasks', s, { title, agentId: agent })).json as { id: string; number: number };
  const all = (o: Ops) => Object.values(o.items).flat();
  const settle = async () => { for (let i = 0; i < 200 && h.db.get("SELECT 1 AS x FROM runs WHERE status IN ('queued', 'running')"); i++) { await h.executor.tick(); await sleep(15); } };
  const clean = () => { h.db.run("UPDATE runs SET status = 'cancelled' WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting_user')", s.workspaceId); h.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ?', s.workspaceId); };

  test('limite 1 e três pedidos: 1 em andamento ocupando a vaga, 2 prontos na ordem do agendador; ao terminar, o próximo entra', async () => {
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 1 });
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    const c = [await card('Pesquisa A'), await card('Pesquisa B'), await card('Pesquisa C')];
    let o = await ops();
    assert.equal(o.version, 1);
    assert.equal(o.totals.pronto, 3);
    assert.ok(o.items.pronto.every((i) => i.reasonCode === 'autorun'), 'andamento desligado: diz isso, não "falta vaga"');
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: true });
    h.teamwork.tick(); await h.executor.tick();
    o = await ops();
    assert.equal(o.local.limit, 1);
    assert.equal(o.local.busy, runningProcesses(h.db, s.workspaceId), 'vagas ocupadas = a regra do executor');
    assert.equal(o.local.busy, 1);
    assert.equal(o.totals.ativo, 1); assert.equal(o.items.ativo[0].taskId, c[0].id); assert.equal(o.items.ativo[0].slot, true);
    assert.deepEqual(o.items.pronto.map((i) => [i.taskId, i.position, i.reasonCode]), [[c[1].id, 1, 'vaga'], [c[2].id, 2, 'vaga']]);
    assert.match(o.items.pronto[0].reason, /próximo a começar/);
    assert.match(o.items.pronto[1].reason, /2º a começar/);
    assert.equal(all(o).length, 3, 'cada pedido uma vez só');
    await settle(); h.teamwork.tick(); await h.executor.tick();
    o = await ops();
    assert.equal(o.items.ativo[0]?.taskId, c[1].id, 'o seguinte entrou');
    assert.equal(o.totals.pronto, 1);
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    await settle(); clean();
  });

  test('priorizar pelo card muda a mesma ordem que o agendador usa (sem tirar ninguém do trabalho)', async () => {
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    const c = [await card('Um'), await card('Dois'), await card('Três')];
    await req(h, 'POST', `/api/tasks/${c[2].id}/queue`, s, { priority: true });
    const o = await ops();
    assert.deepEqual(o.items.pronto.map((i) => i.taskId), [c[2].id, c[0].id, c[1].id]);
    assert.deepEqual(o.items.pronto.map((i) => i.taskId), h.teamwork.queue(s.workspaceId).map((q) => q.id), 'a mesma ordem do quadro');
    assert.ok(o.items.pronto[0].actions.includes('priorizar'));
    clean();
  });

  test('ajuda pendente: o pai fica bloqueado com o motivo, sem ocupar vaga e sem ser contado duas vezes', async () => {
    const pai = await card('Relatório trimestral');
    const filho = await card('Ajuda: levantar números', agents[2].id);
    h.db.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', pai.id, filho.id);
    const o = await ops();
    const p = all(o).find((i) => i.taskId === pai.id)!;
    assert.equal(p.category, 'bloqueado'); assert.equal(p.reasonCode, 'ajuda');
    assert.match(p.reason, new RegExp(`#${filho.number}`));
    assert.equal(p.dependsOn[0].taskId, filho.id);
    assert.equal(all(o).find((i) => i.taskId === filho.id)!.category, 'pronto', 'a ajuda é um pedido próprio, na fila');
    assert.equal(all(o).filter((i) => i.taskId === pai.id).length, 1);
    assert.equal(o.totals.bloqueado + o.totals.pronto, 2);
    clean();
  });

  test('esperando você: não ocupa vaga e aparece em "precisa de você" e em "Aguardando você"', async () => {
    const c = await card('Proposta comercial');
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: true });
    h.teamwork.tick(); await h.executor.tick();
    h.db.run("UPDATE runs SET status = 'waiting_user' WHERE task_id = ?", c.id);
    const o = await ops();
    const it = all(o).find((i) => i.taskId === c.id)!;
    assert.equal(it.category, 'precisa_de_voce'); assert.equal(it.slot, false);
    assert.ok(it.actions.includes('responder'));
    assert.equal(o.local.busy, 0, 'esperando você libera a vaga, como no executor');
    assert.equal(o.decisions.total, pendingCount(h.db, s.workspaceId));
    assert.ok(o.decisions.total >= 1);
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    clean();
    // estados do contrato de resultado que pedem você
    const a = await card('Aprovar envio'); const f = await card('Planilha quebrada');
    h.db.run("UPDATE tasks SET work_state = 'aguardando_aprovacao' WHERE id = ?", a.id);
    h.db.run("UPDATE tasks SET work_state = 'falha' WHERE id = ?", f.id);
    const o2 = await ops();
    assert.equal(all(o2).find((i) => i.taskId === a.id)!.reasonCode, 'aprovacao');
    assert.equal(all(o2).find((i) => i.taskId === f.id)!.category, 'falhou', 'falha não é entrega nem espera');
    clean();
  });

  test('conversa não ocupa vaga; cancelar tira o card da leitura e entregas mostram só concluídos (com simulação identificada)', async () => {
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 1 });
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agents[0].id })).json.id;
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'oi', clientRequestId: 'amb-conv-0001' });
    await h.executor.tick();
    let o = await ops();
    assert.equal(o.local.conversations, 1); assert.equal(o.local.busy, 0, 'a conversa não toma posto');
    assert.equal(all(o).length, 0, 'conversa não vira item de trabalho');
    await settle();
    const c = await card('Cancelar este');
    const cx = await req(h, 'POST', `/api/tasks/${c.id}/cancel`, s, { reason: 'desisti' });
    assert.equal(cx.status, 200, JSON.stringify(cx.json));
    o = await ops();
    assert.ok(!all(o).some((i) => i.taskId === c.id));
    const d = await card('Entregue');
    h.db.run("UPDATE tasks SET completed = 1, completed_at = ?, completed_by = 'agent', work_state = 'concluida' WHERE id = ?", new Date().toISOString(), d.id);
    h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, task_id, kind, status, mode, input, idempotency_key, created_at) VALUES ('run_sim_1', ?, ?, ?, 'subtask', 'succeeded', 'simulated', 'x', 'queue-sim-1', ?)`, s.workspaceId, agents[1].id, d.id, new Date().toISOString());
    o = await ops();
    const e = o.deliveries.items.find((x) => x.taskId === d.id)!;
    assert.ok(e, 'concluído aparece em entregas'); assert.equal(e.simulated, true, 'simulação continua identificada');
    assert.ok(!all(o).some((i) => i.taskId === d.id), 'entregue não conta como trabalho aberto');
    clean();
  });

  test('parar pelo card (o mesmo botão): o trabalho sai da vaga e aparece como parado, não como falha', async () => {
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 1 });
    const c = await card('Parar no meio');
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: true });
    h.teamwork.tick(); await h.executor.tick();
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    const run = all(await ops()).find((i) => i.taskId === c.id)!;
    assert.equal(run.category, 'ativo');
    assert.equal((await req(h, 'POST', `/api/runs/${run.runId}/cancel`, s, {})).status, 200);
    await settle();
    const o = await ops();
    const it = all(o).find((i) => i.taskId === c.id)!;
    assert.equal(it.category, 'impedido'); assert.equal(it.reasonCode, 'parado');
    assert.equal(o.local.busy, 0);
    clean();
  });

  test('ler não muda nada: nem execução, nem auditoria, nem fila', async () => {
    await card('X'); await card('Y');
    const snap = () => JSON.stringify([h.db.all('SELECT id, status FROM runs ORDER BY id'), h.db.get('SELECT COUNT(*) AS n FROM audit_events'), h.db.all('SELECT id, queue_pos, priority, updated_at FROM tasks ORDER BY id')]);
    const before = snap();
    for (let i = 0; i < 5; i++) await ops();
    assert.equal(snap(), before);
    clean();
  });

  test('1.000 cards: totais exatos, página de 20, o resto pelo "ver mais"', async () => {
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    const board = h.db.get<{ b: string; c: string }>("SELECT b.id AS b, c.id AS c FROM boards b JOIN columns c ON c.board_id = b.id WHERE b.workspace_id = ? AND b.audience = 'team' AND c.name = 'A fazer'", s.workspaceId)!;
    const base = Number(h.db.get<{ n: number }>('SELECT MAX(number) AS n FROM tasks WHERE workspace_id = ?', s.workspaceId)!.n);
    const at = new Date().toISOString();
    h.db.tx(() => { for (let i = 1; i <= 1000; i++) h.db.run(`INSERT INTO tasks (id, number, workspace_id, board_id, column_id, agent_id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`, `tsk_carga_${i}`, base + i, s.workspaceId, board.b, board.c, agents[1 + (i % 3)].id, `Carga ${i}`, at, at); });
    const t0 = Date.now();
    const o = await ops();
    const ms = Date.now() - t0;
    assert.equal(o.totals.pronto, 1000); assert.equal(o.items.pronto.length, 20); assert.equal(o.more.pronto, 980);
    assert.ok(ms < 3000, `leitura em ${ms} ms`);
    const p2 = await ops(s, '?category=pronto&offset=20&limit=50');
    assert.equal(p2.items.pronto.length, 50); assert.equal(p2.items.pronto[0].position, 21); assert.equal(p2.totals.pronto, 1000);
    clean();
  });

  test('cada pessoa só vê o próprio workspace; execução da conversa de outra pessoa aparece sem título', async () => {
    const b = await addPerson(h, 'beatriz', 'senha-da-beatriz-123');
    const mine = await card('Só do Alexandre');
    const ob = await ops(b);
    assert.ok(!all(ob).some((i) => i.taskId === mine.id), 'outro workspace não aparece');
    assert.equal(ob.totals.pronto + ob.totals.ativo, all(ob).filter((i) => i.category === 'pronto' || i.category === 'ativo').length + ob.more.pronto + ob.more.ativo);
    // alguém que também é do workspace do Alexandre não vê o título de um processo ligado à conversa dele
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agents[0].id })).json.id;
    h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, conversation_id, kind, status, mode, input, idempotency_key, created_at, started_at) VALUES ('run_priv_1', ?, ?, ?, 'subtask', 'running', 'simulated', 'x', 'routine-priv-1', ?, ?)`, s.workspaceId, agents[0].id, conv, new Date().toISOString(), new Date().toISOString());
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, b.userId, new Date().toISOString());
    const asOwner = all(await ops()).find((i) => i.key === 'run:run_priv_1')!;
    assert.ok(asOwner.actions.includes('conversa'), 'quem é dono da conversa pode abrir');
    const sw = await req(h, 'POST', '/api/session/workspace', b, { workspaceId: s.workspaceId });
    assert.equal(sw.status, 200, JSON.stringify(sw.json));
    const asOther = all(await ops(b)).find((i) => i.key === 'run:run_priv_1')!;
    assert.equal(asOther.title, 'Trabalho de outra pessoa do workspace');
    assert.deepEqual(asOther.actions, [], 'sem atalho para a conversa de outra pessoa');
    assert.equal(asOther.slot, true, 'mas a vaga continua contada');
    h.db.run("UPDATE runs SET status = 'cancelled' WHERE id = 'run_priv_1'");
    clean();
  });

  test('sem sessão: 401; parâmetros fora do contrato: 400', async () => {
    assert.equal((await req(h, 'GET', '/api/ambient/operations', null)).status, 401);
    assert.equal((await req(h, 'GET', '/api/ambient/operations?category=tudo', s)).status, 400);
    assert.equal((await req(h, 'GET', '/api/ambient/operations?category=pronto&limit=999', s)).status, 400);
  });
});
