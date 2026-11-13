import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addPerson, allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

// a janela do agente (aba Atividade): cada execução diz de qual card e de qual conversa veio, para a linha abrir o que
// ela fez (antes, a tabela só mostrava; a tela não tinha como chegar ao card ou à conversa)
describe('atividade do agente: a execução traz o card e a conversa dela', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness({ maxConcurrentRuns: 0, simulatedDelayMs: 0 }); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('uma conversa com o agente: a execução aparece com a conversa; sem card', async () => {
    const agent = (await allAgents(h, s)).find((a: { coordinator: number }) => !a.coordinator);
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent.id })).json.id as string;
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'oi', clientRequestId: 'atv-agente-0001' });
    await h.executor.tick();
    const r = await req(h, 'GET', `/api/agents/${agent.id}/activity`, s);
    assert.equal(r.status, 200);
    const run = (r.json.runs as Array<{ conversation_id: string | null; task_id: string | null }>).find((x) => x.conversation_id === conv);
    assert.ok(run, 'a execução da conversa está na lista, com o id da conversa');
    assert.equal(run.task_id, null);
    // o que já existia continua igual
    assert.ok(Array.isArray(r.json.tasks));
    assert.equal(typeof r.json.totals, 'object');
  });

  test('outra pessoa do mesmo workspace vê a execução, mas sem a conversa de quem conversou (não promete abrir)', async () => {
    const agent = (await allAgents(h, s)).find((a: { coordinator: number }) => !a.coordinator);
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent.id })).json.id as string;
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'só minha', clientRequestId: 'atv-agente-0002' });
    await h.executor.tick();
    const b = await addPerson(h, 'bruna', 'senha-comprida-da-bruna-1');
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, b.userId, new Date().toISOString());
    assert.equal((await req(h, 'POST', '/api/session/workspace', b, { workspaceId: s.workspaceId })).status, 200);
    const runId = h.db.get<{ id: string }>('SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv)!.id;

    // quem conversou: a conversa vem nas três rotas
    assert.equal((await req(h, 'GET', '/api/runs', s)).json.find((x: { id: string }) => x.id === runId).conversation_id, conv);
    assert.equal((await req(h, 'GET', `/api/runs/${runId}`, s)).json.conversation_id, conv);
    assert.equal((await req(h, 'GET', `/api/agents/${agent.id}/activity`, s)).json.runs.find((x: { id: string }) => x.id === runId).conversation_id, conv);

    // a outra pessoa: a execução continua lá (o trabalho conta), a conversa não
    const lista = (await req(h, 'GET', '/api/runs', b)).json.find((x: { id: string }) => x.id === runId);
    assert.ok(lista, 'a execução aparece para quem também é do workspace');
    assert.equal(lista.conversation_id, null);
    const uma = await req(h, 'GET', `/api/runs/${runId}`, b);
    assert.equal(uma.status, 200);
    assert.equal(uma.json.conversation_id, null);
    const atv = (await req(h, 'GET', `/api/agents/${agent.id}/activity`, b)).json.runs.find((x: { id: string }) => x.id === runId);
    assert.ok(atv);
    assert.equal(atv.conversation_id, null);
    // e a conversa, de fato, não abre para ela (o que a linha prometeria)
    assert.equal((await req(h, 'GET', `/api/conversations/${conv}/messages`, b)).status, 404);
  });
});
