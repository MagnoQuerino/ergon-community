import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { throttle } from '../src/security/factors.ts';
import type { HermesClient, HermesControlClient, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { motorName, motorSecret } from '../src/services/motors.ts';
import { addPerson, allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const MASTER = 'token-da-instalacao-'.padEnd(40, 'x');
const MANAGER = 'http://gerente.test:8645';

class FakeMotor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}`;
    this.runs.set(runId, { status: 'completed', output: 'resposta', error: null, sessionId: `sess-${p.idempotencyKey.slice(-12)}`, usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: [] }]; }
}
class FakeControl implements HermesControlClient {
  accountsAsked = 0;
  async health() { return true; }
  async accounts() { this.accountsAsked++; return [{ id: 'nous', name: 'Nous Portal', connected: false, freeTier: null, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 'sess_x', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: null, provider: null }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(enabled: string[]) { return enabled; }
}

/** Gerente de motores e receptores dos cofres, falsos: registram o que o Ergon pediu. */
function fakeInfra() {
  const motors = new Map<string, FakeMotor>(); const controls = new Map<string, FakeControl>();
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; token: string | null }> = [];
  const unlocks: Array<{ user: string; key: string; previous?: string; token: string | null }> = [];
  const sealed = new Map<string, boolean>();
  let adoptedBy: string | null = null;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const headers = new Headers(init?.headers);
    if (u.origin === MANAGER) {
      calls.push({ method: init?.method ?? 'GET', path: u.pathname, body, token: headers.get('x-ergon-manager-token') });
      const m = /^\/v1\/motors\/(usr_[a-f0-9]{32})(?:\/(ensure|stop))?$/.exec(u.pathname);
      if (!m) return json({ error: 'rota' }, 404);
      if (m[2] === 'ensure') {
        const adopt = !!body?.adoptLegacy && (!adoptedBy || adoptedBy === m[1]);
        if (adopt) adoptedBy = m[1];
        return json({ ok: true, adopted: adopt, state: 'running' });
      }
      if (m[2] === 'stop' || init?.method === 'DELETE') { sealed.set(m[1], true); return json({ ok: true }); }
    }
    const v = /^ergon-motor-([a-f0-9]{32})$/.exec(u.hostname);
    if (v && u.port === '8644') {
      const user = `usr_${v[1]}`;
      if (u.pathname === '/status') return json({ sealed: sealed.get(user) ?? true });
      if (u.pathname === '/unlock') { unlocks.push({ user, key: String(body?.key), previous: body?.previous as string | undefined, token: headers.get('x-ergon-bridge-token') }); sealed.set(user, false); return json({ ok: true }); }
    }
    return json({ error: 'sem rota no teste' }, 599);
  }) as typeof fetch;
  const motorOf = (u: string) => { if (!motors.has(u)) motors.set(u, new FakeMotor()); return motors.get(u)!; };
  const controlOf = (u: string) => { if (!controls.has(u)) controls.set(u, new FakeControl()); return controls.get(u)!; };
  return { motors, controls, calls, unlocks, fetchFake, motorOf, controlOf };
}

async function setup(): Promise<{ h: Harness; a: Session; b: Session; infra: ReturnType<typeof fakeInfra> }> {
  throttle.reset();
  const infra = fakeInfra();
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', motorManagerUrl: MANAGER, bridgeToken: MASTER },
    { motorClients: (u) => ({ hermes: infra.motorOf(u), control: infra.controlOf(u) }), motorFetch: infra.fetchFake });
  const a = await setupOwner(h);
  const b = await addPerson(h, 'bruna', 'senha-bruna-123', 'Bruna');
  await h.motors.ensure(a.userId); await h.motors.ensure(b.userId);
  return { h, a, b, infra };
}
const chat = async (h: Harness, s: Session, text: string, id: string) => {
  const st = { agents: await allAgents(h, s) };
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: st.agents[0].id })).json;
  return (await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text, clientRequestId: id })).json as { runId: string };
};

describe('um motor de IA por pessoa', () => {
  test('cada pessoa liga o próprio motor e abre o cofre dele com a chave dela; só a primeira herda o motor de antes', async () => {
    const { h, a, b, infra } = await setup();
    assert.equal(h.motors.perPerson, true);
    const ensures = infra.calls.filter((c) => c.path.endsWith('/ensure'));
    assert.ok(ensures.every((c) => c.token === MASTER), 'só o Ergon fala com o gerente (token da instalação)');
    assert.deepEqual(ensures.find((c) => c.path.includes(a.userId))?.body, { adoptLegacy: true }, 'a primeira conta herda o motor de antes');
    assert.deepEqual(ensures.find((c) => c.path.includes(b.userId))?.body, { adoptLegacy: false });
    const ua = infra.unlocks.find((x) => x.user === a.userId)!; const ub = infra.unlocks.find((x) => x.user === b.userId)!;
    assert.equal(ua.key, h.vault.motorKey(a.userId)); assert.equal(ub.key, h.vault.motorKey(b.userId));
    assert.notEqual(ua.key, ub.key, 'um cofre, uma chave');
    assert.equal(ua.previous, h.vault.hermesKey(), 'o cofre herdado troca de senha: da chave da instalação para a da pessoa');
    assert.equal(ub.previous, undefined);
    assert.equal(ua.token, motorSecret(MASTER, 'bridge', a.userId), 'o receptor do cofre de cada motor tem o token dele');
    // de novo (motor religado): a troca de senha já foi feita
    await h.motors.stop(a.userId); await h.motors.ensure(a.userId);
    assert.equal(infra.unlocks.filter((x) => x.user === a.userId).at(-1)!.previous, undefined);
    await h.close();
  });

  test('o trabalho de cada pessoa vai para o motor dela; com o motor desligado, espera ele ligar', async () => {
    const { h, a, b, infra } = await setup();
    await chat(h, a, 'pedido do Alexandre', 'req-motor-a-001');
    await h.executor.tick(); await h.executor.tick();
    assert.equal(infra.motorOf(a.userId).started.length, 1); assert.equal(infra.motorOf(b.userId).started.length, 0);
    await h.motors.stop(b.userId);
    const r = await chat(h, b, 'pedido da Bruna', 'req-motor-b-001');
    await h.executor.tick(); await h.executor.tick();
    assert.match(h.db.get<{ error: string }>('SELECT error FROM runs WHERE id = ?', r.runId)!.error, /aguardando o motor de IA/);
    assert.equal(infra.motorOf(b.userId).started.length, 0);
    await h.motors.ensure(b.userId); // o pedido acima já mandou ligar; aqui só espera
    await h.executor.tick();
    assert.equal(infra.motorOf(b.userId).started.length, 1, 'ligado o motor dela, o pedido segue');
    assert.equal(infra.motorOf(a.userId).started.length, 1, 'nada da Bruna no motor do Alexandre');
    await h.close();
  });

  test('a ponte reconhece cada motor; o motor de uma pessoa não vê sessão de outra; o token da instalação não vale ali', async () => {
    const { h, a, b, infra } = await setup();
    const r = await chat(h, b, 'pedido da Bruna', 'req-motor-b-002');
    await h.executor.tick(); await h.executor.tick(); await h.executor.tick();
    const session = h.db.get<{ s: string }>('SELECT hermes_session_id AS s FROM runs WHERE id = ?', r.runId)!.s;
    assert.ok(session);
    const policy = (token: string) => h.app.inject({ method: 'POST', url: '/internal/bridge/v1/tool-policy', headers: { 'x-ergon-bridge-token': token, 'content-type': 'application/json' }, payload: JSON.stringify({ session_id: session }) });
    assert.equal((await policy(motorSecret(MASTER, 'bridge', b.userId))).json().known, true);
    assert.equal((await policy(motorSecret(MASTER, 'bridge', a.userId))).json().known, false, 'o motor do Alexandre não sabe nada da sessão da Bruna');
    assert.equal((await policy(MASTER)).statusCode, 401, 'nenhum motor tem o token da instalação');
    void infra;
    await h.close();
  });

  test('conta de IA, ferramentas e modelo: cada pessoa no próprio motor', async () => {
    const { h, a, b, infra } = await setup();
    await req(h, 'GET', '/api/ai/status', a);
    assert.equal(infra.controlOf(a.userId).accountsAsked > 0, true);
    assert.equal(infra.controlOf(b.userId).accountsAsked, 0, 'a conta de IA da Bruna não é consultada pelo Alexandre');
    await req(h, 'GET', '/api/ai/status', b);
    assert.equal(infra.controlOf(b.userId).accountsAsked > 0, true);
    await h.close();
  });

  test('remover a conta remove o motor; motor parado há tempo desliga sozinho', async () => {
    const { h, a, b, infra } = await setup();
    assert.equal((await req(h, 'DELETE', `/api/people/${b.userId}`, a, { confirm: 'bruna' })).status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(infra.calls.some((c) => c.method === 'DELETE' && c.path === `/v1/motors/${b.userId}`), 'o gerente apaga contêiner e cofre dela');
    const stopped = await h.motors.stopIdle(Date.now() + 5 * 3600_000);
    assert.deepEqual(stopped, [a.userId]);
    assert.equal(h.motors.state(a.userId).state, 'desligado');
    assert.equal(motorName(a.userId), `ergon-motor-${a.userId.slice(4)}`);
    await h.close();
  });
});
