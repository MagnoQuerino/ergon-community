/**
 * Trabalhos ao mesmo tempo (conversar com Aristóteles enquanto Hipátia pesquisa). Conversa nunca espera; processos (cards, rotinas, revisões) seguem o limite que você escolhe — padrão
 * pela memória da máquina, um número ou sem limite —, sob o teto do plano. O que passa do limite espera em "A fazer",
 * na ordem da fila: Prioridade leva ao topo, arrastar muda a ordem.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { machineDefault, parseChoice, processLimit } from '../src/services/concurrency.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const GB = 1024 ** 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('limite de processos: padrão da máquina, escolha e teto do plano', () => {
  test('padrão da máquina: um processo a cada 4 GB, sem passar dos núcleos nem de 6', () => {
    assert.equal(machineDefault(16 * GB, 8), 4);
    assert.equal(machineDefault(7.7 * GB, 8), 1, 'Docker com 8 GB: um por vez');
    assert.equal(machineDefault(2 * GB, 8), 1, 'nunca menos de 1');
    assert.equal(machineDefault(64 * GB, 4), 4, 'não passa dos núcleos');
    assert.equal(machineDefault(128 * GB, 32), 6, 'não passa de 6 no automático');
  });

  test('escolha guardada: automático, número (1 a 32) ou sem limite; o resto vale automático', () => {
    assert.equal(parseChoice(null), 'auto');
    assert.equal(parseChoice('ilimitado'), 'ilimitado');
    assert.equal(parseChoice('3'), 3);
    assert.equal(parseChoice('0'), 'auto');
    assert.equal(parseChoice('33'), 'auto');
    assert.equal(parseChoice('2.5'), 'auto');
  });
});

describe('trabalhos ao mesmo tempo: conversas livres, processos no limite, fila com prioridade', () => {
  let h: Harness;
  let s: Session;
  let agents: Array<{ id: string; name: string }>;
  before(async () => {
    h = await harness({ maxConcurrentRuns: 0, simulatedDelayMs: 600 });
    s = await setupOwner(h);
    agents = (await req(h, 'GET', '/api/state', s)).json.agents;
    // o quadro da equipe começa vazio neste teste (a equipe de partida pode trazer cards)
    h.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ?', s.workspaceId);
  });
  after(async () => { await h.close(); });

  const running = (sql = '') => Number(h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'running' ${sql}`, s.workspaceId)!.n);
  const settle = async () => {
    for (let i = 0; i < 200 && h.db.get("SELECT 1 AS x FROM runs WHERE status IN ('queued', 'running')"); i++) { await h.executor.tick(); await sleep(20); }
  };

  test('Configurações: aceita automático, número e sem limite; recusa 0 e 33; o teto do plano vale por cima', async () => {
    for (const bad of [0, 33, 'tudo', 2.5]) assert.equal((await req(h, 'PUT', '/api/runs/limit', s, { choice: bad })).status, 400, String(bad));
    const auto = (await req(h, 'PUT', '/api/runs/limit', s, { choice: 'auto' })).json;
    assert.equal(auto.choice, 'auto');
    assert.equal(auto.limit, auto.machine, 'automático = padrão da máquina');
    assert.equal(auto.cap, null, 'local, sem teto');
    assert.equal((await req(h, 'PUT', '/api/runs/limit', s, { choice: 'ilimitado' })).json.limit, null, 'sem limite');
    assert.equal((await req(h, 'PUT', '/api/runs/limit', s, { choice: 3 })).json.limit, 3);
    const plano = { maxConcurrentRuns: 2 };
    assert.equal(processLimit(h.db, plano, s.workspaceId).limit, 2, 'na nuvem, o plano manda: escolheu 3, o plano dá 2');
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 'ilimitado' });
    assert.equal(processLimit(h.db, plano, s.workspaceId).limit, 2, 'sem limite também para no teto do plano');
    const st = (await req(h, 'GET', '/api/state', s)).json;
    assert.equal(st.runs.limit.choice, 'ilimitado');
    assert.equal(typeof st.runs.limit.machine, 'number');
  });

  test('conversa não entra no limite: com o limite 1 ocupado por um processo, três conversas andam juntas', async () => {
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 1 });
    for (let i = 0; i < 2; i++) {
      h.executor.enqueue({ workspaceId: s.workspaceId, agentId: agents[1].id, kind: 'subtask', input: `rotina ${i}`, instructions: 'x', idempotencyKey: `routine-teste-${i}` });
    }
    const convs: string[] = [];
    for (let i = 0; i < 3; i++) convs.push((await req(h, 'POST', '/api/conversations', s, { agentId: agents[i].id })).json.id);
    for (const [i, c] of convs.entries()) {
      assert.equal((await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: `oi ${i}`, clientRequestId: `req-livre-000${i}` })).status, 201);
    }
    await h.executor.tick();
    assert.equal(running("AND idempotency_key LIKE 'chat-%'"), 3, 'as três conversas trabalham');
    assert.equal(running("AND idempotency_key LIKE 'routine-%'"), 1, 'um processo (limite 1); o outro espera a vez');
    assert.equal(Number(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued' AND idempotency_key LIKE 'routine-%'")!.n), 1);
    await settle();
    assert.equal(h.executor.maxObservedProcesses, 1, 'nunca dois processos ao mesmo tempo');
    assert.equal(Number(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status <> 'succeeded'")!.n), 0, 'tudo terminou');
  });

  test('cards: o que passa do limite espera em "A fazer"; Prioridade vai ao topo; arrastar muda a ordem; sem limite, todos andam', async () => {
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 2 });
    const cards: Array<{ id: string; number: number }> = [];
    for (let i = 1; i <= 5; i++) cards.push((await req(h, 'POST', '/api/tasks', s, { title: `Pesquisa ${i}`, agentId: agents[1].id })).json);
    const col = (id: string) => h.db.get<{ n: string }>('SELECT c.name AS n FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?', id)!.n;
    const order = () => h.teamwork.queue(s.workspaceId).map((q) => cards.findIndex((c) => c.id === q.id) + 1);
    assert.deepEqual(order(), [1, 2, 3, 4, 5], 'ordem de chegada');
    // você arruma a fila antes de ligar: 5 com prioridade (topo), 4 arrastado para antes do 2
    const p = await req(h, 'POST', `/api/tasks/${cards[4].id}/queue`, s, { priority: true });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(p.json, { priority: true, position: 1 });
    assert.equal((await req(h, 'POST', `/api/tasks/${cards[3].id}/queue`, s, { before: cards[1].id })).json.position, 3);
    assert.deepEqual(order(), [5, 1, 4, 2, 3]);
    assert.equal((await req(h, 'POST', `/api/tasks/${cards[0].id}/queue`, s, { before: null })).json.position, 5, 'arrastado para o fim');
    assert.deepEqual(order(), [5, 4, 2, 3, 1]);
    // sem arrastar (teclado, toque): subir e descer trocam com o vizinho; na ponta, nada muda
    const move = async (n: number, dir: 'up' | 'down') => (await req(h, 'POST', `/api/tasks/${cards[n - 1].id}/queue`, s, { move: dir })).json.position;
    assert.equal(await move(3, 'up'), 3);
    assert.deepEqual(order(), [5, 4, 3, 2, 1]);
    assert.equal(await move(5, 'up'), 1, 'o primeiro não sobe mais');
    assert.equal(await move(1, 'down'), 5, 'o último não desce mais');
    assert.equal(await move(4, 'down'), 3);
    assert.equal(await move(4, 'up'), 2);
    assert.deepEqual(order(), [5, 4, 3, 2, 1]);
    assert.deepEqual((await req(h, 'GET', `/api/tasks/${cards[2].id}`, s)).json.queue, { position: 3, total: 5 }, 'o card diz onde está na fila');
    const board = (await req(h, 'GET', `/api/boards/${cards[0] && h.db.get<{ b: string }>('SELECT board_id AS b FROM tasks WHERE id = ?', cards[0].id)!.b}`, s)).json;
    const todoCol = board.columns.find((c: { name: string }) => c.name === 'A fazer').id;
    assert.deepEqual(board.tasks.filter((t: { column_id: string }) => t.column_id === todoCol).map((t: { id: string }) => cards.findIndex((c) => c.id === t.id) + 1), [5, 4, 3, 2, 1], 'o quadro mostra a ordem da fila');
    assert.equal(board.tasks.find((t: { id: string }) => t.id === cards[4].id).priority, 1);
    // liga o andamento: dois andam (limite 2), na ordem da fila; os outros esperam em "A fazer"
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: true });
    h.teamwork.tick();
    const started = h.db.all<{ task_id: string }>("SELECT task_id FROM runs WHERE idempotency_key LIKE 'queue-%' ORDER BY created_at").map((r) => cards.findIndex((c) => c.id === r.task_id) + 1);
    assert.deepEqual(started, [5, 4], 'pegou de cima para baixo, até encher as vagas');
    assert.equal(col(cards[1].id), 'A fazer', 'o resto espera em A fazer, sem ser recusado');
    assert.deepEqual(order(), [3, 2, 1]);
    assert.equal((await req(h, 'GET', `/api/tasks/${cards[4].id}`, s)).json.queue, null, 'card andando não está na fila');
    // um card concluído não tem fila
    h.db.run('UPDATE tasks SET completed = 1 WHERE id = ?', cards[2].id);
    assert.equal((await req(h, 'POST', `/api/tasks/${cards[2].id}/queue`, s, { priority: true })).status, 409);
    h.db.run('UPDATE tasks SET completed = 0 WHERE id = ?', cards[2].id);
    // sem limite: o que espera anda todo de uma vez
    await req(h, 'PUT', '/api/runs/limit', s, { choice: 'ilimitado' });
    h.teamwork.tick();
    assert.equal(h.teamwork.queue(s.workspaceId).length, 0, 'todos os cards andando');
    await h.executor.tick();
    assert.equal(running("AND idempotency_key LIKE 'queue-%'"), 5);
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
    await settle();
  });

  test('ordem só no quadro da equipe: card das suas tarefas não tem fila', async () => {
    const mine = (await req(h, 'GET', '/api/boards', s)).json.find((b: { audience: string }) => b.audience === 'user');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Comprar pão', boardId: mine.id })).json;
    assert.equal((await req(h, 'POST', `/api/tasks/${t.id}/queue`, s, { priority: true })).status, 409);
  });
});
