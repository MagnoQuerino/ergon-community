import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { EDGE_GROW, cityExtent, placeError } from '../../shared/city.ts';
import { cityActivity } from '../src/services/city-activity.ts';
import { allAgents, cityStructures, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const agora = () => new Date().toISOString();

describe('Cidade Viva: etiquetas só do que é real, por workspace', () => {
  let h: Harness; let s: Session; let agents: Array<{ id: string }>;
  let n = 0;
  const run = (agent: string, task: string | null, status: string, extra: { review?: string } = {}) => {
    n++;
    h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, task_id, kind, status, mode, input, idempotency_key, created_at, review_id) VALUES (?, ?, ?, ?, 'subtask', ?, 'simulated', 'x', ?, ?, ?)`,
      `run_cv_${n}`, s.workspaceId, agent, task, status, `cv-${n}`, agora(), extra.review ?? null);
    return `run_cv_${n}`;
  };
  const tags = async () => (await req(h, 'GET', '/api/city/activity', s)).json.tags as Array<{ kind: string; agents: string[]; lead: string; taskId: string | null; number: number | null; label: string; title: string; href: string | null }>;
  const card = async (title: string, agent: string) => (await req(h, 'POST', '/api/tasks', s, { title, agentId: agent })).json as { id: string; number: number };

  before(async () => { h = await harness(); s = await setupOwner(h); agents = await allAgents(h, s); });
  after(async () => { await h.close(); });

  test('sem execução, sem etiqueta (nada inventado)', async () => {
    assert.deepEqual(await tags(), []);
  });

  test('executando: o número real do card, o texto curto e o caminho do card; some quando termina', async () => {
    const c = await card('Relatório mensal', agents[1].id);
    const r = run(agents[1].id, c.id, 'running');
    const t = (await tags()).find((x) => x.lead === agents[1].id)!;
    assert.equal(t.kind, 'executando');
    assert.equal(t.label, `#${c.number}`);
    assert.equal(t.title, `Trabalhando na tarefa #${c.number}`);
    assert.equal(t.taskId, c.id);
    assert.match(t.href!, new RegExp(`card=${c.id}$`));
    assert.ok(!JSON.stringify(t).includes('Relatório mensal'), 'sem o título da tarefa');
    h.db.run(`UPDATE runs SET status = 'succeeded' WHERE id = ?`, r);
    assert.equal((await tags()).find((x) => x.lead === agents[1].id), undefined, 'terminou: a etiqueta some');
  });

  test('revisão conjunta: uma etiqueta só, no autor, com os dois agentes', async () => {
    const c = await card('Proposta', agents[2].id);
    h.db.run(`INSERT INTO reviews (id, workspace_id, task_id, reviewer_id, producer_id, status, round, max_rounds, created_at) VALUES ('rvw_cv_1', ?, ?, ?, ?, 'open', 1, 2, ?)`,
      s.workspaceId, c.id, agents[3].id, agents[2].id, agora());
    run(agents[3].id, c.id, 'running', { review: 'rvw_cv_1' });
    const list = (await tags()).filter((x) => x.agents.includes(agents[2].id) || x.agents.includes(agents[3].id));
    assert.equal(list.length, 1, 'sem etiqueta duplicada');
    assert.equal(list[0].kind, 'revisando');
    assert.equal(list[0].lead, agents[2].id);
    assert.deepEqual(new Set(list[0].agents), new Set([agents[2].id, agents[3].id]));
    assert.equal(list[0].title, `Revisando a tarefa #${c.number}`);
    h.db.run(`UPDATE reviews SET status = 'approved' WHERE id = 'rvw_cv_1'`);
    assert.equal((await tags()).filter((x) => x.kind === 'revisando').length, 0, 'revisão fechada: some');
  });

  test('esperando aprovação ou informação: vem do estado da tarefa', async () => {
    const c = await card('Contrato', agents[4].id);
    h.db.run(`UPDATE tasks SET work_state = 'aguardando_aprovacao' WHERE id = ?`, c.id);
    assert.equal((await tags()).find((x) => x.lead === agents[4].id)?.kind, 'aguardando_aprovacao');
    h.db.run(`UPDATE tasks SET work_state = 'aguardando_info' WHERE id = ?`, c.id);
    assert.equal((await tags()).find((x) => x.lead === agents[4].id)?.kind, 'aguardando_info', 'mudou o estado, mudou a etiqueta');
    h.db.run(`UPDATE tasks SET completed = 1 WHERE id = ?`, c.id);
    assert.equal((await tags()).find((x) => x.lead === agents[4].id), undefined);
  });

  test('outro workspace: nada dele aparece aqui', async () => {
    const c = await card('Daqui', agents[5].id);
    run(agents[5].id, c.id, 'running');
    assert.ok((await tags()).some((x) => x.lead === agents[5].id));
    const a = s.workspaceId;
    const b = (await req(h, 'POST', '/api/workspaces', s, { name: 'Pessoal' })).json.workspaceId as string;
    assert.deepEqual(cityActivity(h.db, b), [], 'o workspace B não vê a execução de A');
    assert.ok(cityActivity(h.db, a).some((x) => x.lead === agents[5].id));
  });

  test('Alexandre Magno: ligado por padrão, desligar vale só para este workspace', async () => {
    assert.equal((await req(h, 'GET', '/api/city/settings', s)).json.npc, true);
    assert.equal((await req(h, 'PUT', '/api/city/settings', s, { npc: false })).json.npc, false);
    assert.equal((await req(h, 'GET', '/api/city/settings', s)).json.npc, false);
    assert.equal((await req(h, 'PUT', '/api/city/settings', s, { npc: true })).json.npc, true);
  });
});

describe('construir na beirada amplia a cidade', () => {
  test('passar da borda é permitido (só colisão impede); longe demais continua fora', () => {
    const placed = [{ id: 'a', kind: 'stoa', i: 0, j: 0 }];
    const e = cityExtent(placed);
    // grande, metade para fora da borda
    assert.equal(placeError(placed, 'stoa', e.i1 - 1, 0), null);
    assert.equal(placeError(placed, 'stoa', e.i0 - 3, e.j0 - 2), null);
    assert.equal(placeError(placed, 'stoa', e.i1 + EDGE_GROW + 1, 0), 'outside');
    assert.equal(placeError(placed, 'stoa', 0, 0), 'occupied');
    const grown = cityExtent([...placed, { id: 'b', kind: 'stoa', i: e.i1 - 1, j: 0 }]);
    assert.ok(grown.i1 > e.i1, 'a área de lotes cresce para conter a nova');
  });

  test('pelo servidor: mover para a beirada passa, sobre outra estrutura não', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const st = await cityStructures(h, s);
    const placed = st.map((x: { id: string; kind: string; i: number; j: number }) => ({ id: x.id, kind: x.kind, i: x.i, j: x.j }));
    const e = cityExtent(placed);
    const termas = st.find((x: { kind: string }) => x.kind === 'termas');
    assert.equal((await req(h, 'PATCH', `/api/structures/${termas.id}`, s, { i: e.i1, j: e.j0 })).status, 200, 'logo depois da borda');
    const outra = st.find((x: { kind: string }) => x.kind === 'stoa');
    assert.equal((await req(h, 'PATCH', `/api/structures/${termas.id}`, s, { i: outra.i, j: outra.j })).status, 409);
    await h.close();
  });
});
