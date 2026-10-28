import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { now } from '../src/lib/util.ts';
import { addPerson, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('autenticação, CSRF e origem', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('rotas protegidas exigem sessão', async () => {
    assert.equal((await req(h, 'GET', '/api/state')).status, 401);
    assert.equal((await req(h, 'GET', '/api/boards')).status, 401);
    assert.equal((await req(h, 'GET', '/api/health')).status, 200);
  });

  test('cookie de sessão é HttpOnly e SameSite=Strict', async () => {
    const r = await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: 'senha-local-123' });
    const c = String(r.res.headers['set-cookie']);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /^ergon_session_8787=/, 'nome inclui a porta para instâncias locais não colidirem');
  });

  test('segundo setup é recusado', async () => {
    const r = await req(h, 'POST', '/api/auth/setup', null, { username: 'outro', password: 'senha-local-456' });
    assert.equal(r.status, 409);
  });

  test('escrita sem CSRF ou com origem externa é rejeitada', async () => {
    const noCsrf = await h.app.inject({ method: 'POST', url: '/api/tasks', headers: { cookie: s.cookie, origin: 'http://localhost:8787', 'content-type': 'application/json' }, payload: '{"title":"x"}' });
    assert.equal(noCsrf.statusCode, 403);
    const evil = await req(h, 'POST', '/api/tasks', s, { title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const crossSite = await req(h, 'POST', '/api/tasks', s, { title: 'x' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    const ok = await req(h, 'POST', '/api/tasks', s, { title: 'Tarefa válida' });
    assert.equal(ok.status, 201);
  });

  test('senha errada não autentica', async () => {
    const r = await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: 'errada-errada' });
    assert.equal(r.status, 401);
  });

  test('cabeçalhos de segurança presentes', async () => {
    const r = await req(h, 'GET', '/api/health');
    assert.equal(r.res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(r.res.headers['content-security-policy']), /frame-ancestors 'none'/);
  });
});

describe('isolamento entre workspaces e conversas', () => {
  let h: Harness;
  let a: Session;
  let b: Session;
  before(async () => {
    h = await harness();
    a = await setupOwner(h);
    // segunda pessoa no mesmo computador, pela tela de entrada: outro workspace, outra chave
    b = await addPerson(h, 'bruna', 'senha-bruna-123', 'Bruna');
  });
  after(async () => { await h.close(); });

  test('usuário de outro workspace não lê tarefa, quadro, execução, arquivo nem conversa por ID', async () => {
    const task = (await req(h, 'POST', '/api/tasks', a, { title: 'Segredo do workspace A' })).json;
    const boards = (await req(h, 'GET', '/api/boards', a)).json;
    const art = (await req(h, 'POST', '/api/artifacts', a, Buffer.from('conteúdo A'), {
      'content-type': 'application/octet-stream', 'x-filename': 'a.txt', 'x-file-type': 'text/plain' })).json;
    const state = (await req(h, 'GET', '/api/state', a)).json;
    const conv = (await req(h, 'POST', '/api/conversations', a, { agentId: state.agents[0].id })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, a, { text: 'mensagem privada', clientRequestId: 'req-isol-0001' });
    await drain(h);
    const run = (await req(h, 'GET', '/api/runs', a)).json[0];

    assert.equal((await req(h, 'GET', `/api/tasks/${task.id}`, b)).status, 404);
    assert.equal((await req(h, 'PATCH', `/api/tasks/${task.id}`, b, { completed: true })).status, 404);
    assert.equal((await req(h, 'GET', `/api/boards/${boards[0].id}`, b)).status, 404);
    assert.equal((await req(h, 'GET', `/api/artifacts/${art.id}/download`, b)).status, 404);
    assert.equal((await req(h, 'GET', `/api/conversations/${conv.id}/messages`, b)).status, 404);
    assert.equal((await req(h, 'POST', `/api/conversations/${conv.id}/messages`, b, { text: 'invasão', clientRequestId: 'req-isol-0002' })).status, 404);
    assert.equal((await req(h, 'GET', `/api/runs/${run.id}`, b)).status, 404);
    assert.equal((await req(h, 'POST', `/api/agents/${state.agents[0].id}/archive`, b)).status, 404);
    // listas de B não contêm nada de A
    const bTasks = (await req(h, 'GET', '/api/activity', b)).json as Array<{ target_id: string }>;
    assert.ok(!bTasks.some((e) => e.target_id === task.id));
    // e A continua lendo normalmente
    assert.equal((await req(h, 'GET', `/api/tasks/${task.id}`, a)).status, 200);
  });

  test('trocar de workspace exige membership', async () => {
    const r = await req(h, 'POST', '/api/session/workspace', b, { workspaceId: a.workspaceId });
    assert.equal(r.status, 404);
  });

  test('FK composta impede apontar para objeto de outro workspace mesmo via SQL direto', () => {
    const colA = h.db.get<{ id: string; board_id: string }>('SELECT id, board_id FROM columns WHERE workspace_id = ? LIMIT 1', a.workspaceId)!;
    assert.throws(() => h.db.run(
      `INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, origin, created_at, updated_at)
       VALUES ('tsk_x', 999, ?, ?, ?, 'cruzada', 'manual', ?, ?)`, b.workspaceId, colA.board_id, colA.id, now(), now()), /FOREIGN KEY/);
  });

  test('duas conversas com o mesmo agente não compartilham histórico nem sessão Hermes', async () => {
    const state = (await req(h, 'GET', '/api/state', a)).json;
    const agentId = state.agents[1].id;
    const c1 = (await req(h, 'POST', '/api/conversations', a, { agentId })).json;
    const c2 = (await req(h, 'POST', '/api/conversations', a, { agentId })).json;
    assert.notEqual(c1.hermes_session_key, c2.hermes_session_key);
    assert.match(c1.hermes_session_key, new RegExp(`^ergon:${a.workspaceId}:user:${a.userId}:agent:${agentId}:conv:${c1.id}$`));
    await req(h, 'POST', `/api/conversations/${c1.id}/messages`, a, { text: 'assunto exclusivo da conversa um', clientRequestId: 'req-conv-0001' });
    await drain(h);
    const m2 = (await req(h, 'GET', `/api/conversations/${c2.id}/messages`, a)).json as Array<{ content: string }>;
    assert.equal(m2.length, 0);
    const m1 = (await req(h, 'GET', `/api/conversations/${c1.id}/messages`, a)).json as Array<{ content: string; mode: string; role: string }>;
    assert.ok(m1.some((m) => m.content.includes('assunto exclusivo')));
    const agentMsg = m1.find((m) => m.role === 'agent');
    assert.equal(agentMsg?.mode, 'simulated');
    assert.match(agentMsg!.content, /Simulação — sem modelo/);
  });
});
