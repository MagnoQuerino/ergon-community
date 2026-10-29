// Ferramentas que executam código (Executar código, Terminal): bloqueadas por padrão; o agente pede permissão na
// conversa e o usuário autoriza ali mesmo com a senha — e o agente continua sozinho.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { parsePermissionRequests } from '../src/services/proposals.ts';
import { stripControl } from '../src/services/teamwork.ts';
import { throttle } from '../src/security/factors.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${this.started.length}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: 'sess-1', usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'x/y' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: ['todo'] }]; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'x/y', provider: 'nous', providers: [] }; }
}
class Control implements HermesControlClient {
  sets: string[][] = [];
  async health() { return true; }
  async accounts() { return []; }
  async startLogin() { return { sessionId: 's', userCode: null, verificationUrl: null, expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: 'x/y', provider: 'nous' }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: ['todo'], safe: ['todo', 'web'] }; }
  async setApiToolsets(e: string[]) { this.sets.push(e); return ['todo', ...e.filter((x) => x !== 'todo')]; }
}

const PASS = 'senha-local-123';

describe('pedido de permissão com senha, na conversa', () => {
  let h: Harness; let s: Session; let motor: Motor; let control: Motor | Control; let agentId: string; let conv: string;
  before(async () => {
    throttle.reset();
    motor = new Motor(); control = new Control();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-0123456789' }, { hermes: motor, control: control as Control });
    s = await setupOwner(h, 'alexandre', PASS);
    await h.ai.refreshToolsets();
    const st = (await req(h, 'GET', '/api/state', s)).json;
    agentId = st.agents.find((a: { char_key: string }) => a.char_key === 'hipatia').id;
    conv = (await req(h, 'POST', '/api/conversations', s, { agentId })).json.id;
  });
  after(async () => { await h.close(); });

  test('o pedido é lido da resposta e some do texto mostrado', () => {
    const t = 'Preciso rodar um script.\n[[pedir-permissao ferramenta="terminal" motivo="listar os arquivos do projeto"]]';
    assert.deepEqual(parsePermissionRequests(t, 'Hipátia'), [{ kind: 'permission', agent: 'Hipátia', tool: 'terminal', reason: 'listar os arquivos do projeto' }]);
    assert.deepEqual(parsePermissionRequests('[[pedir-permissao ferramenta="web" motivo="x y z"]]', 'A'), [], 'só ferramentas que executam código');
    assert.equal(stripControl(t), 'Preciso rodar um script.');
  });

  test('bloqueadas por padrão; as instruções ensinam a pedir permissão', async () => {
    const tools = (await req(h, 'GET', '/api/ai/tools', s)).json as Array<{ id: string; status: string; guarded?: boolean }>;
    for (const id of ['calculo', 'terminal']) {
      const t = tools.find((x) => x.id === id)!;
      assert.equal(t.status, 'bloqueada'); assert.equal(t.guarded, true);
    }
    motor.reply = () => 'Vou somar a planilha.\n[[pedir-permissao ferramenta="calculo" motivo="somar a coluna de vendas"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Some a coluna de vendas da planilha', clientRequestId: 'perm-0001' });
    for (let i = 0; i < 4; i++) await h.executor.tick();
    assert.match(motor.started[0].instructions ?? '', /pedir-permissao/);
  });

  test('cartão na conversa: aplicar sem senha não vale; senha errada não vale; senha certa libera e o agente continua', async () => {
    const props = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ id: string; kind: string; status: string; summary: string }>;
    const p = props.find((x) => x.kind === 'permission')!;
    assert.ok(p, 'pedido de permissão registrado'); assert.match(p.summary, /Executar código/);
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).status, 400, 'sem senha não libera');
    const wrong = await req(h, 'POST', `/api/proposals/${p.id}/authorize`, s, { password: 'senha-errada-999' });
    assert.equal(wrong.status, 401);
    assert.equal((control as Control).sets.length, 0, 'nada ligado no motor');
    motor.reply = () => 'Somei: 1.234.';
    const ok = await req(h, 'POST', `/api/proposals/${p.id}/authorize`, s, { password: PASS });
    assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.status, 'applied');
    assert.ok((control as Control).sets.at(-1)!.includes('code_execution'), 'conjunto ligado no motor');
    const ag = (await req(h, 'GET', '/api/state', s)).json.agents.find((a: { id: string }) => a.id === agentId);
    assert.ok(ag.tools.some((t: { id: string; status: string }) => t.id === 'calculo' && t.status === 'disponível'), 'ferramenta liberada para quem pediu');
    for (let i = 0; i < 4; i++) await h.executor.tick();
    const cont = motor.started.at(-1)!;
    assert.match(cont.input, /autorizou agora a ferramenta Executar código/);
    const msgs = (await req(h, 'GET', `/api/conversations/${conv}/messages`, s)).json as Array<{ role: string; content: string }>;
    assert.ok(msgs.some((m) => m.role === 'agent' && m.content === 'Somei: 1.234.'), 'o agente continuou sozinho');
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}/authorize`, s, { password: PASS })).status, 409, 'vale uma vez');
  });

  test('ligar em Configuração ou dar a um agente pede a senha recente', async () => {
    // sessão nova, sem confirmação recente: o servidor pede a senha (401 reauth)
    h.db.run('UPDATE sessions SET auth_at = ?', new Date(Date.now() - 10 * 60_000).toISOString());
    const r = await req(h, 'PUT', '/api/ai/tools', s, { enabled: ['passos', 'calculo', 'terminal'] });
    assert.equal(r.status, 401); assert.equal(r.json.error, 'reauth');
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const other = st.agents.find((a: { char_key: string }) => a.char_key === 'platao');
    const p = await req(h, 'PATCH', `/api/agents/${other.id}`, s, { tools: [...other.tools.map((t: { id: string }) => t.id), 'terminal'] });
    assert.equal(p.status, 401); assert.equal(p.json.error, 'reauth');
    assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: PASS })).status, 200);
    assert.equal((await req(h, 'PUT', '/api/ai/tools', s, { enabled: ['passos', 'calculo', 'terminal'] })).status, 200);
  });
});

describe('ligar código ou terminal conversando: o pedido vai para a coordenação', () => {
  let h: Harness; let s: Session; let motor: Motor; let control: Control; let hipatia: string; let hesiodo: string; let conv: string;
  before(async () => {
    throttle.reset();
    motor = new Motor(); control = new Control();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-0123456789' }, { hermes: motor, control });
    s = await setupOwner(h, 'alexandre', PASS);
    await h.ai.refreshToolsets();
    const st = (await req(h, 'GET', '/api/state', s)).json;
    hipatia = st.agents.find((a: { char_key: string }) => a.char_key === 'hipatia').id;
    hesiodo = st.agents.find((a: { char_key: string }) => a.char_key === 'hesiodo').id;
    conv = (await req(h, 'POST', '/api/conversations', s, { agentId: hipatia })).json.id;
  });
  after(async () => { await h.close(); });

  test('outro agente passa o pedido; a senha é pedida na conversa com a coordenação; autorizado, quem pediu continua', async () => {
    motor.reply = () => 'Vou passar o pedido para a coordenação.\n[[liberar-ferramenta ferramenta="terminal" agente="Hipátia" motivo="rodar os scripts do projeto"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Liga o terminal para você', clientRequestId: 'lib-0001' });
    for (let i = 0; i < 4; i++) await h.executor.tick();
    assert.match(motor.started[0].instructions ?? '', /liberar-ferramenta/, 'as instruções ensinam a passar o pedido');
    const aqui = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ kind: string; status: string; payload: string | null }>;
    const aviso = aqui.find((p) => p.kind === 'handoff')!;
    assert.ok(aviso, 'aviso com o caminho na conversa de origem');
    assert.equal(aviso.status, 'applied', 'o aviso não espera decisão');
    assert.ok(!aqui.some((p) => p.kind === 'permission'), 'a senha não é pedida aqui');
    const d = JSON.parse(aviso.payload!) as { conversationId: string; coordinatorId: string };
    const coordConv = (await req(h, 'GET', `/api/proposals?conversationId=${d.conversationId}`, s)).json as Array<{ id: string; kind: string; summary: string }>;
    const perm = coordConv.find((p) => p.kind === 'permission')!;
    assert.ok(perm, 'pedido com senha na conversa com a coordenação'); assert.match(perm.summary, /Terminal/);
    const st = (await req(h, 'GET', '/api/state', s)).json;
    assert.ok(Number(st.agents.find((a: { id: string }) => a.id === d.coordinatorId).coordinator) === 1, 'é a coordenação');
    motor.reply = () => 'Rodei os scripts.';
    const ok = await req(h, 'POST', `/api/proposals/${perm.id}/authorize`, s, { password: PASS });
    assert.equal(ok.json.status, 'applied', JSON.stringify(ok.json));
    assert.ok(control.sets.at(-1)!.includes('terminal'), 'ligado no motor');
    for (let i = 0; i < 4; i++) await h.executor.tick();
    const cont = motor.started.at(-1)!;
    assert.match(cont.input, /autorizou agora a ferramenta Terminal/);
    const msgs = (await req(h, 'GET', `/api/conversations/${conv}/messages`, s)).json as Array<{ role: string; content: string }>;
    assert.ok(msgs.some((m) => m.role === 'agent' && m.content === 'Rodei os scripts.'), 'Hipátia continua na conversa dela');
    const coordMsgs = (await req(h, 'GET', `/api/conversations/${d.conversationId}/messages`, s)).json as Array<{ role: string; content: string }>;
    assert.ok(coordMsgs.some((m) => m.role === 'system' && /você autorizou/.test(m.content)), 'a coordenação registra a autorização');
  });

  test('para a equipe (sem agente): só liga no motor', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const coord = st.agents.find((a: { coordinator: boolean }) => a.coordinator);
    const cc = (await req(h, 'POST', '/api/conversations', s, { agentId: coord.id })).json.id;
    motor.reply = () => 'Peço a sua senha abaixo.\n[[liberar-ferramenta ferramenta="calculo" agente="equipe" motivo="planilhas da equipe"]]';
    await req(h, 'POST', `/api/conversations/${cc}/messages`, s, { text: 'Liga o executar código para a equipe', clientRequestId: 'lib-0002' });
    for (let i = 0; i < 4; i++) await h.executor.tick();
    const perm = ((await req(h, 'GET', `/api/proposals?conversationId=${cc}`, s)).json as Array<{ id: string; kind: string; summary: string }>).find((p) => p.kind === 'permission')!;
    assert.match(perm.summary, /para a equipe/);
    const ok = await req(h, 'POST', `/api/proposals/${perm.id}/authorize`, s, { password: PASS });
    assert.equal(ok.json.status, 'applied'); assert.match(ok.json.result, /ligada para a equipe/);
    assert.ok(control.sets.at(-1)!.includes('code_execution'));
  });

  test('lembrete com data: quem tem a ferramenta propõe; aprovado, vira tarefa sua com prazo', async () => {
    const c2 = (await req(h, 'POST', '/api/conversations', s, { agentId: hesiodo })).json.id;
    motor.reply = () => 'Anoto para você.\n[[propor-tarefa titulo="Lembrete: renovar o alvará" responsavel="você" prazo="2030-03-10"]]';
    await req(h, 'POST', `/api/conversations/${c2}/messages`, s, { text: 'Me lembra de renovar o alvará em 10/03/2030', clientRequestId: 'lem-0001' });
    for (let i = 0; i < 4; i++) await h.executor.tick();
    const p = ((await req(h, 'GET', `/api/proposals?conversationId=${c2}`, s)).json as Array<{ id: string; kind: string; summary: string }>).find((x) => x.kind === 'task')!;
    assert.ok(p, 'proposta de lembrete'); assert.match(p.summary, /na conversa com Hesíodo/);
    const r = await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' });
    assert.equal(r.json.status, 'applied', JSON.stringify(r.json));
    const tools = (await req(h, 'GET', '/api/ai/tools', s)).json as Array<{ id: string; status: string }>;
    assert.equal(tools.find((t) => t.id === 'agenda')!.status, 'disponível', 'lembretes com data não ficam mais bloqueados');
  });
});
