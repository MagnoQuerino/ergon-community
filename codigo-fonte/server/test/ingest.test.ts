import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const BRIDGE_TOKEN = 'token-de-teste-da-ponte-0123456789';

describe('Teams — fixture → evento → tarefa → resposta simulada', () => {
  let h: Harness;
  let s: Session;
  let first: any;
  before(async () => {
    h = await harness();
    s = await setupOwner(h);
    first = (await req(h, 'POST', '/api/fixtures/teams/cenario-basico/replay', s)).json;
  });
  after(async () => { await h.close(); });

  test('cada evento recebe o status esperado', () => {
    const st = first.results.map((r: { status: string }) => r.status);
    assert.deepEqual(st, ['accepted', 'accepted', 'accepted', 'accepted', 'rejected_identity', 'rejected_tenant', 'ignored_echo', 'edit_logged', 'accepted', 'accepted']);
    assert.equal(first.fixture, true);
  });

  test('comando explícito cria tarefa e devolve resposta (simulada, não enviada)', async () => {
    const r = first.results[0];
    assert.ok(r.taskId);
    assert.match(r.reply, /Tarefa #\d+ criada: Preparar pauta/);
    const outbox = (await req(h, 'GET', '/api/outbox', s)).json as Array<{ status: string; platform: string; mode: string }>;
    assert.ok(outbox.length > 0);
    assert.ok(outbox.every((o) => o.status === 'simulated' && o.mode === 'fixture'));
  });

  test('nem toda mensagem vira tarefa', () => {
    assert.equal(first.results[1].taskId, null); // "Obrigado!"
    assert.equal(first.results[9].taskId, null); // tentativa de instrução embutida
    assert.equal(first.results[4].taskId, null); // identidade desconhecida
    assert.equal(first.results[5].taskId, null); // outro tenant
    assert.equal(first.results[6].taskId, null); // eco do bot
  });

  test('instrução embutida em mensagem não é executada', async () => {
    const board = (await req(h, 'GET', '/api/boards', s)).json[0];
    const view = (await req(h, 'GET', `/api/boards/${board.id}`, s)).json;
    assert.ok(view.tasks.length >= 3, 'tarefas continuam no quadro');
    assert.ok(view.tasks.every((t: { archived?: number }) => !t.archived));
  });

  test('/pendencias responde com a lista', () => {
    assert.match(first.results[3].reply, /Pendências \(\d+\)/);
  });

  test('edição não cria nova demanda', () => {
    assert.equal(first.results[7].summary, 'edição registrada; não cria nova demanda');
    assert.equal(first.results[7].taskId, first.results[2].taskId);
  });

  test('mensagens semelhantes não são fundidas: nova tarefa + proposta de vínculo', async () => {
    const a = first.results[2].taskId;
    const b = first.results[8].taskId;
    assert.ok(a && b && a !== b);
    const detail = (await req(h, 'GET', `/api/tasks/${b}`, s)).json;
    assert.equal(detail.proposals.length, 1);
    assert.equal(detail.proposals[0].status, 'proposed');
    assert.equal(detail.proposals[0].related_task_id, a);
    // confirmação e reversão
    assert.equal((await req(h, 'POST', `/api/link-proposals/${detail.proposals[0].id}`, s, { decision: 'confirmed' })).status, 200);
    assert.equal((await req(h, 'POST', `/api/link-proposals/${detail.proposals[0].id}`, s, { decision: 'proposed' })).status, 200);
    const again = (await req(h, 'GET', `/api/tasks/${b}`, s)).json;
    assert.equal(again.proposals[0].status, 'proposed');
  });

  test('reprocessar a mesma fixture não duplica eventos nem tarefas', async () => {
    const before = (await req(h, 'GET', '/api/source-events', s)).json.length;
    const second = (await req(h, 'POST', '/api/fixtures/teams/cenario-basico/replay', s)).json;
    assert.ok(second.results.every((r: { duplicate: boolean }) => r.duplicate));
    assert.deepEqual(second.results.map((r: { taskId: string | null }) => r.taskId), first.results.map((r: { taskId: string | null }) => r.taskId));
    assert.equal((await req(h, 'GET', '/api/source-events', s)).json.length, before);
  });

  test('conclusão humana não é revertida por reentrega de evento', async () => {
    const taskId = first.results[0].taskId;
    // o quadro da equipe é automático: a pessoa não edita o card, mas pode dizer na conversa que concluiu
    assert.equal((await req(h, 'PATCH', `/api/tasks/${taskId}`, s, { completed: true })).status, 409);
    const n = (await req(h, 'GET', `/api/tasks/${taskId}`, s)).json.task.number;
    const st = { agents: await allAgents(h, s) };
    const coord = st.agents.find((a: { char_key: string }) => a.char_key === 'aristoteles');
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord.id })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: `Concluí a #${n}`, clientRequestId: 'conclui-0001' });
    await req(h, 'POST', '/api/fixtures/teams/cenario-basico/replay', s);
    const t = (await req(h, 'GET', `/api/tasks/${taskId}`, s)).json.task;
    assert.equal(t.completed, 1);
    assert.equal(t.completed_by, 'human');
  });
});

describe('WhatsApp — observação sem resposta automática', () => {
  let h: Harness;
  let s: Session;
  let res: any;
  before(async () => {
    h = await harness();
    s = await setupOwner(h);
    res = (await req(h, 'POST', '/api/fixtures/whatsapp/observacao-basica/replay', s)).json;
  });
  after(async () => { await h.close(); });

  test('status por mensagem', () => {
    assert.deepEqual(res.results.map((r: { status: string }) => r.status),
      ['accepted', 'accepted', 'accepted', 'ignored_not_monitored', 'ignored_echo', 'edit_logged', 'accepted']);
  });

  test('demanda observada em grupo não vira tarefa automaticamente; fica no log', async () => {
    assert.equal(res.results[1].taskId, null);
    const ev = (await req(h, 'GET', '/api/source-events', s)).json as Array<{ external_id: string; interpretation: string; event_type: string }>;
    const e = ev.find((x) => x.external_id === 'FXWA0002' && x.event_type === 'message')!;
    assert.match(e.interpretation, /demanda/);
    assert.match(e.interpretation, /observação/);
  });

  test('comando do proprietário em conversa direta cria tarefa; resposta não é enviada', async () => {
    assert.ok(res.results[2].taskId);
    assert.equal(res.results[2].reply, null);
    const outbox = (await req(h, 'GET', '/api/outbox', s)).json as Array<{ status: string; platform: string }>;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, 'simulated');
  });

  test('comando dentro de grupo não tem permissão de comando', () => {
    assert.equal(res.results[6].taskId, null);
  });

  test('chat fora da seleção: texto não é armazenado', async () => {
    const ev = (await req(h, 'GET', '/api/source-events', s)).json as Array<{ external_id: string; text_excerpt: string | null; actor_display: string | null }>;
    const e = ev.find((x) => x.external_id === 'FXWA0004')!;
    assert.equal(e.text_excerpt, null);
    assert.equal(e.actor_display, null);
  });

  test('toda decisão devolvida ao gateway é "handled" (sem turno de agente respondendo contatos)', () => {
    assert.ok(res.results.every((r: { action: string }) => r.action === 'handled'));
  });
});

describe('ponte interna Hermes → Ergon', () => {
  let h: Harness;
  let s: Session;
  const payload = (over: Record<string, unknown> = {}) => ({
    schema: 'ergon.bridge.v1', platform: 'teams', message_id: 'teams-real-0001', text: '/tarefa Validar ponte real',
    source: { user_id: 'aad-real-owner', user_name: 'Alexandre', chat_id: 'a:dm', chat_type: 'dm', tenant_id: 'tenant-real' },
    workspace_id: 'ws_00000000000000000000000000000000', ...over,
  });
  const post = (body: unknown, token: string | null = BRIDGE_TOKEN) => h.app.inject({
    method: 'POST', url: '/internal/bridge/v1/events',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-ergon-bridge-token': token } : {}) }, payload: JSON.stringify(body),
  });
  before(async () => {
    h = await harness({
      bridgeToken: BRIDGE_TOKEN,
      teams: { enabled: true, tenantId: 'tenant-real', allowedUsers: ['aad-real-owner'], botId: null },
    });
    s = await setupOwner(h);
    // identidades reais vêm da configuração, sincronizadas na inicialização
    const { syncConfiguredIdentities } = await import('../src/services/ingest.ts');
    syncConfiguredIdentities(h.db, h.cfg);
  });
  after(async () => { await h.close(); });

  test('sem token ou com token errado → 401', async () => {
    assert.equal((await post(payload(), null)).statusCode, 401);
    assert.equal((await post(payload(), 'token-errado-token-errado-0000')).statusCode, 401);
  });

  test('evento real autenticado chega ao Kanban e ao log (não fica invisível no gateway)', async () => {
    const r = await post(payload());
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.action, 'handled');
    assert.match(j.reply, /Tarefa #\d+ criada: Validar ponte real/);
    const ev = (await req(h, 'GET', '/api/source-events', s)).json as Array<{ external_id: string; is_fixture: number; mode: string; task_id: string }>;
    const e = ev.find((x) => x.external_id === 'teams-real-0001')!;
    assert.equal(e.is_fixture, 0);
    assert.equal(e.mode, 'real');
    assert.ok(e.task_id);
    const conns = (await req(h, 'GET', '/api/connections', s)).json as Array<{ id: string; kind: string; mode: string; state: string }>;
    const teamsConn = conns.find((c) => c.kind === 'teams' && c.mode === 'real')! as { id: string; state: string };
    // eventos pela ponte não bastam: "conectado" só após confirmação humana de teste real
    assert.equal(teamsConn.state, 'nao_validado');
    assert.equal((await req(h, 'POST', `/api/connections/${teamsConn.id}/validate`, s)).status, 200);
    const after = (await req(h, 'GET', '/api/connections', s)).json as Array<{ kind: string; mode: string; state: string }>;
    assert.equal(after.find((c) => c.kind === 'teams' && c.mode === 'real')!.state, 'conectado');
    // workspace vem da conexão, não do payload
    const t = (await req(h, 'GET', `/api/tasks/${e.task_id}`, s)).json.task;
    assert.equal(t.workspace_id, s.workspaceId);
  });

  test('reentrega do gateway devolve a mesma decisão sem nova tarefa', async () => {
    const r = (await post(payload())).json();
    assert.equal(r.duplicate, true);
    assert.match(r.reply, /Validar ponte real/);
  });

  test('conversa livre segue para o agente Hermes ("continue"); tenant errado é rejeitado', async () => {
    const free = (await post(payload({ message_id: 'teams-real-0002', text: 'Qual a previsão para amanhã?' }))).json();
    assert.equal(free.action, 'continue');
    const wrong = (await post(payload({ message_id: 'teams-real-0003', source: { user_id: 'aad-real-owner', tenant_id: 'outro' } }))).json();
    assert.equal(wrong.status, 'rejected_tenant');
  });

  test('conector desabilitado no Ergon recusa eventos', async () => {
    const r = await post(payload({ platform: 'whatsapp', message_id: 'wa-1' }));
    assert.equal(r.statusCode, 403);
  });
});
