import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { throttle } from '../src/security/factors.ts';
import { Vault } from '../src/security/keys.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { platformToolsets } from '../src/services/characters.ts';
import { HermesError, type HermesClient, type HermesControlClient, type MotorInfo, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { filtrarOrfaos, motorName, motorSecret } from '../src/services/motors.ts';
import { setSetting } from '../src/services/sectors.ts';
import { addPerson, allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** o que a tela não mostra (Saúde, Atividade, o pedido na fila) */
const JARGAO = /\bmotor(es)?\b|\bgerente\b|ponte de controle|cont[eê]iner|\bimagem\b|\bpodman\b|\bdocker\b|respondeu \d{3}/i;

const MASTER = 'token-da-instalacao-'.padEnd(40, 'x');
const MANAGER = 'http://gerente.test:8645';
const IMG_A = 'sha256:aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111';
const IMG_B = 'sha256:bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222';

type Infra = ReturnType<typeof fakeInfra>;

class FakeMotor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  /** o que as execuções novas respondem: 'completed' (termina na hora) ou 'running' (fica trabalhando) */
  next: 'completed' | 'running' = 'completed';
  private readonly infra: Infra; private readonly user: string;
  constructor(infra: Infra, user: string) { this.infra = infra; this.user = user; }
  /** a API só responde com o cofre aberto e a imagem funcionando (como o motor de verdade) */
  async health() { const ok = this.infra.sealed.get(this.user) === false && !this.infra.down.has(this.infra.imageOf(this.user)); return { ok, detail: ok ? 'fake' : 'connect ECONNREFUSED' }; }
  async startRun(p: StartRun) {
    if (this.infra.sealed.get(this.user) !== false) throw new HermesError(503, 'o motor de IA não respondeu');
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}`;
    this.runs.set(runId, { status: this.next, output: this.next === 'completed' ? 'resposta' : null, error: null, sessionId: `sess-${p.idempotencyKey.slice(-12)}`, usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { const t = this.infra.toolsOf(this.user); return t.known.map((n) => ({ name: n, label: n, enabled: t.enabled.includes(n), configured: true, tools: [] })); }
}
class FakeControl implements HermesControlClient {
  accountsAsked = 0;
  sets: string[][] = [];
  private readonly infra: Infra; private readonly user: string;
  constructor(infra: Infra, user: string) { this.infra = infra; this.user = user; }
  async health() { return (await this.info()).ok; }
  async info(): Promise<MotorInfo> { return { ok: this.infra.sealed.get(this.user) === false, pluginVersion: '0.3.0', vaultConfig: 2, capacidades: this.infra.capsOf(this.infra.imageOf(this.user)) }; }
  async accounts() { this.accountsAsked++; return [{ id: 'nous', name: 'Nous Portal', connected: false, freeTier: null, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 'sess_x', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: null, provider: null }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { const t = this.infra.toolsOf(this.user); return { enabled: [...t.enabled], safe: t.known.filter((n) => n !== 'terminal' && n !== 'code_execution') }; }
  async setApiToolsets(enabled: string[]) { this.sets.push(enabled); const t = this.infra.toolsOf(this.user); t.enabled = enabled.filter((n) => t.known.includes(n)); return [...t.enabled]; }
}

/**
 * Gerente de motores e receptores dos cofres, falsos, no contrato da rc.24: ensure {adoptLegacy, idle, start} responde
 * {stale, recreated, image, prevImage}; confirm, rollback, limpeza e apagar volume. Registram o que o Ergon pediu.
 */
function fakeInfra() {
  const motors = new Map<string, FakeMotor>(); const controls = new Map<string, FakeControl>();
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; token: string | null }> = [];
  const unlocks: Array<{ user: string; key: string; previous?: string; token: string | null }> = [];
  const sealed = new Map<string, boolean>();
  const images = new Map<string, string>(); const prevs = new Map<string, string>(); const running = new Map<string, boolean>();
  /** imagem recusada (rótulo de espera do gerente): enquanto a configurada for esta, o motor não conta como desatualizado */
  const held = new Map<string, string>();
  const tools = new Map<string, { enabled: string[]; known: string[] }>();
  const caps = new Map<string, string[] | null>(); const down = new Set<string>();
  const st = { target: IMG_A, avisos: [] as string[], unlockFail: null as string | null, volumes: null as null | Array<{ nome: string; emUso?: boolean; herdado?: boolean; instalacao?: 'nossa' | 'sem-marca' | 'outra' }> };
  let adoptedBy: string | null = null;
  const imageOf = (u: string) => images.get(u) ?? IMG_A;
  const capsOf = (img: string) => (caps.has(img) ? caps.get(img)! : ['conexoes', 'bloqueio_prefixo']);
  const toolsOf = (u: string) => { if (!tools.has(u)) tools.set(u, { enabled: ['todo', 'ergon_conexoes'], known: ['todo', 'web', 'ergon_conexoes'] }); return tools.get(u)!; };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const users = () => [...new Set([...images.keys(), ...running.keys()])];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    if (u.origin === MANAGER) {
      calls.push({ method, path: u.pathname, body, token: headers.get('x-ergon-manager-token') });
      if (u.pathname === '/v1/motors' && method === 'GET') return json({ motors: users().map((x) => ({ uid: x, state: running.get(x) ? 'running' : 'exited', stale: imageOf(x) !== st.target && held.get(x) !== st.target, image: imageOf(x), prevImage: prevs.get(x) ?? null })) });
      if (u.pathname === '/v1/volumes' && method === 'GET') return st.volumes ? json({ volumes: st.volumes }) : json({ error: 'rota' }, 404);
      if (u.pathname === '/v1/maintenance/clean') return json({ ok: true, removidas: [{ id: 'sha256:velha', bytes: 5e8 }], liberado: 5e8, avisos: st.avisos.map((volume) => ({ volume, motivo: 'sem contêiner' })) });
      const vol = /^\/v1\/volumes\/([^/]+)$/.exec(u.pathname);
      if (vol && method === 'DELETE') return json({ ok: true });
      const m = /^\/v1\/motors\/(usr_[a-f0-9]{32})(?:\/(ensure|stop|confirm|rollback))?$/.exec(u.pathname);
      if (!m) return json({ error: 'rota' }, 404);
      const uid = m[1];
      if (m[2] === 'ensure') {
        const adopt = !!body?.adoptLegacy && (!adoptedBy || adoptedBy === uid);
        if (adopt) adoptedBy = uid;
        const cur = imageOf(uid);
        const stale = cur !== st.target && held.get(uid) !== st.target;
        if (stale && running.get(uid) && body?.idle !== true) return json({ ok: true, adopted: adopt, created: false, recreated: false, stale: true, image: cur, prevImage: prevs.get(uid) ?? null });
        if (stale) {
          prevs.set(uid, cur); images.set(uid, st.target); sealed.set(uid, true); running.set(uid, body?.start !== false);
          return json({ ok: true, adopted: adopt, created: false, recreated: true, stale: true, image: st.target, prevImage: cur });
        }
        if (!images.has(uid)) images.set(uid, cur);
        if (body?.start !== false) { if (!running.get(uid)) sealed.set(uid, true); running.set(uid, true); }
        return json({ ok: true, adopted: adopt, created: false, recreated: false, stale: false, image: cur, prevImage: prevs.get(uid) ?? null });
      }
      if (m[2] === 'confirm') { prevs.delete(uid); return json({ ok: true }); }
      if (m[2] === 'rollback') {
        const p = prevs.get(uid);
        if (!p) return json({ error: 'sem imagem anterior' }, 409);
        held.set(uid, imageOf(uid)); images.set(uid, p); prevs.delete(uid); sealed.set(uid, true); running.set(uid, true);
        return json({ ok: true });
      }
      if (m[2] === 'stop' || method === 'DELETE') { sealed.set(uid, true); running.set(uid, false); return json({ ok: true }); }
    }
    const v = /^ergon-motor-([a-f0-9]{32})$/.exec(u.hostname);
    if (v && u.port === '8644') {
      const user = `usr_${v[1]}`;
      if (u.pathname === '/status') return json({ sealed: sealed.get(user) ?? true });
      if (u.pathname === '/unlock') {
        if (st.unlockFail) return json({ error: st.unlockFail }, 500);
        unlocks.push({ user, key: String(body?.key), previous: body?.previous as string | undefined, token: headers.get('x-ergon-bridge-token') }); sealed.set(user, false); return json({ ok: true });
      }
    }
    return json({ error: 'sem rota no teste' }, 599);
  }) as typeof fetch;
  const infra = {
    motors, controls, calls, unlocks, fetchFake, sealed, images, prevs, running, held, caps, down, st, tools, imageOf, capsOf, toolsOf,
    motorOf: (x: string) => { if (!motors.has(x)) motors.set(x, new FakeMotor(infra, x)); return motors.get(x)!; },
    controlOf: (x: string) => { if (!controls.has(x)) controls.set(x, new FakeControl(infra, x)); return controls.get(x)!; },
    ensures: (x: string) => calls.filter((c) => c.path === `/v1/motors/${x}/ensure`),
  };
  return infra;
}

async function build(infra: Infra, dir?: string, vault?: Vault): Promise<Harness> {
  return harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', motorManagerUrl: MANAGER, bridgeToken: MASTER },
    { motorClients: (u) => ({ hermes: infra.motorOf(u), control: infra.controlOf(u) }), motorFetch: infra.fetchFake, ...(dir ? { dir } : {}), ...(vault ? { vault } : {}) });
}
async function setup(): Promise<{ h: Harness; a: Session; b: Session; infra: Infra }> {
  throttle.reset();
  const infra = fakeInfra();
  const h = await build(infra);
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
const run = (h: Harness, id: string) => h.db.get<{ status: string; started_at: string | null; error: string | null; hermes_run_id: string | null }>('SELECT status, started_at, error, hermes_run_id FROM runs WHERE id = ?', id)!;
const ticks = async (h: Harness, n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };

describe('um motor de IA por pessoa', () => {
  test('cada pessoa liga o próprio motor e abre o cofre dele com a chave dela; só a primeira herda o motor de antes', async () => {
    const { h, a, b, infra } = await setup();
    assert.equal(h.motors.perPerson, true);
    const ensures = infra.calls.filter((c) => c.path.endsWith('/ensure'));
    assert.ok(ensures.every((c) => c.token === MASTER), 'só o Ergon fala com o gerente (token da instalação)');
    assert.deepEqual(ensures.find((c) => c.path.includes(a.userId))?.body, { adoptLegacy: true, idle: true, start: true }, 'a primeira conta herda o motor de antes');
    assert.deepEqual(ensures.find((c) => c.path.includes(b.userId))?.body, { adoptLegacy: false, idle: true, start: true });
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
    const espera = h.db.get<{ error: string }>('SELECT error FROM runs WHERE id = ?', r.runId)!.error;
    assert.match(espera, /^aguardando a equipe \(ligando\)$/);
    assert.doesNotMatch(espera, JARGAO, 'o pedido na fila não fala das peças por dentro');
    assert.equal(infra.motorOf(b.userId).started.length, 0);
    await h.motors.ensure(b.userId); // o pedido acima já mandou ligar; aqui só espera
    await ticks(h, 2);
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
    // se o cofre dela ficar (o gerente não respondeu), a Saúde mostra de quando é
    const hoje = new Date().toISOString().slice(0, 10).split('-').reverse().join('/');
    assert.deepEqual(filtrarOrfaos(h.db, [`ergon_motor-${b.userId.slice(4)}`]), [{ nome: `ergon_motor-${b.userId.slice(4)}`, conta: `uma conta removida em ${hoje}` }]);
    const stopped = await h.motors.stopIdle(Date.now() + 5 * 3600_000);
    assert.deepEqual(stopped, [a.userId]);
    assert.equal(h.motors.state(a.userId).state, 'desligado');
    assert.equal(motorName(a.userId), `ergon-motor-${a.userId.slice(4)}`);
    await h.close();
  });
});

describe('renovação do motor (versão nova)', () => {
  test('livre: o gerente recria no mesmo cofre, a chave é entregue de novo, a versão é conferida e confirmada', async () => {
    const { h, a, infra } = await setup();
    const antes = infra.unlocks.filter((x) => x.user === a.userId).length;
    infra.st.target = IMG_B; // versão nova do motor configurada
    await h.motors.ensure(a.userId);
    assert.deepEqual(infra.ensures(a.userId).at(-1)!.body, { adoptLegacy: true, idle: true, start: true }, 'nenhum trabalho no motor: pode recriar');
    assert.equal(infra.imageOf(a.userId), IMG_B);
    const dela = infra.unlocks.filter((x) => x.user === a.userId);
    assert.equal(dela.length, antes + 1, 'o contêiner novo nasce com o cofre fechado: a chave vai de novo');
    assert.equal(dela.at(-1)!.key, h.vault.motorKey(a.userId), 'a mesma chave da pessoa (o cofre é o mesmo)');
    assert.ok(infra.calls.some((c) => c.path === `/v1/motors/${a.userId}/confirm`), 'confirmada: o gerente pode apagar a imagem anterior');
    assert.ok(!infra.calls.some((c) => c.path.endsWith('/rollback')));
    assert.equal(h.motors.state(a.userId).state, 'aberto');
    const ev = h.db.get<{ action: string; result: string; evidence: string; target_type: string }>("SELECT action, result, evidence, target_type FROM audit_events WHERE action = 'equipe.atualizada'");
    assert.ok(ev, 'a renovação fica no registro'); assert.match(ev!.result, /^equipe atualizada para a versão \S+$/);
    // a Atividade mostra ação, resultado e evidência como estão: o identificador curto fica (para quem investiga), sem jargão
    assert.equal(JSON.parse(ev!.evidence).pacote, 'bbbbbbbbbbbb');
    for (const t of [ev!.action, ev!.result, ev!.evidence, ev!.target_type]) assert.doesNotMatch(t, JARGAO, t);
    // de novo: nada muda (zero recriações, nada de confirmar outra vez)
    const n = infra.calls.length;
    await h.motors.stop(a.userId); await h.motors.ensure(a.userId);
    assert.equal(infra.calls.slice(n).filter((c) => c.path.endsWith('/confirm')).length, 0);
    await h.close();
  });

  test('ocupado: fica "renovando", o pedido novo espera na fila sem relógio; livre, recria e volta a "aberto" e o pedido segue', async () => {
    const { h, a, infra } = await setup();
    const motor = infra.motorOf(a.userId);
    motor.next = 'running';
    const r1 = await chat(h, a, 'um trabalho comprido', 'req-renova-001');
    await ticks(h, 2);
    assert.ok(run(h, r1.runId).hermes_run_id, 'o primeiro pedido já está no motor');
    infra.st.target = IMG_B;
    await h.motors.ensure(a.userId);
    assert.equal(infra.ensures(a.userId).at(-1)!.body?.idle, false, 'trabalho em andamento no motor: não pode recriar agora');
    assert.equal(h.motors.state(a.userId).state, 'renovando');
    assert.equal(h.motors.accepting(a.workspaceId), false);
    assert.equal(infra.imageOf(a.userId), IMG_A, 'nada mudou no contêiner');
    // a Saúde diz a verdade
    const saude = (await req(h, 'GET', '/api/saude', a)).json;
    assert.match(saude.componentes.find((c: { id: string }) => c.id === 'motor').detalhe, /^Atualizando a equipe para a versão /);
    // pedido novo durante a renovação: fica na fila, sem started_at, dizendo por quê
    const r2 = await chat(h, a, 'um pedido novo', 'req-renova-002');
    await ticks(h, 3);
    assert.equal(run(h, r2.runId).status, 'queued'); assert.equal(run(h, r2.runId).started_at, null);
    assert.equal(run(h, r2.runId).error, 'aguardando a equipe (atualizando para a versão nova; o pedido segue sozinho quando terminar)');
    assert.doesNotMatch(run(h, r2.runId).error ?? '', JARGAO);
    assert.equal(motor.started.length, 1, 'nada novo foi ao motor velho');
    // o primeiro termina; o passo de 60 s renova
    motor.runs.get(run(h, r1.runId).hermes_run_id!)!.status = 'completed';
    await ticks(h, 1);
    assert.equal(run(h, r1.runId).status, 'succeeded');
    motor.next = 'completed';
    await h.motors.tick();
    await h.motors.ensure(a.userId); // espera a renovação que o passo começou
    assert.equal(infra.imageOf(a.userId), IMG_B);
    assert.equal(h.motors.state(a.userId).state, 'aberto');
    assert.equal(infra.unlocks.filter((x) => x.user === a.userId).at(-1)!.key, h.vault.motorKey(a.userId));
    await ticks(h, 2);
    assert.equal(motor.started.length, 2, 'o pedido que esperava foi ao motor novo');
    assert.notEqual(run(h, r2.runId).started_at, null);
    await h.close();
  });

  test('falhou depois de recriar (versão sem as Conexões): o gerente volta para a anterior, a tela diz, e não entra em laço', async () => {
    const { h, a, infra } = await setup();
    const IMG_C = 'sha256:cccccccccccc3333333333333333333333333333333333333333333333333333';
    infra.caps.set(IMG_C, ['bloqueio_prefixo']);
    infra.st.target = IMG_C;
    await h.motors.ensure(a.userId);
    assert.equal(infra.calls.filter((c) => c.path === `/v1/motors/${a.userId}/rollback`).length, 1, 'voltou para a versão anterior');
    assert.ok(!infra.calls.some((c) => c.path === `/v1/motors/${a.userId}/confirm`), 'a versão que falhou não é confirmada');
    assert.equal(infra.imageOf(a.userId), IMG_A);
    assert.equal(h.motors.state(a.userId).state, 'aberto', 'a equipe segue no motor de antes, com o mesmo cofre');
    assert.equal(h.motors.saude(a.userId).falha, 'a versão nova da equipe veio sem as Conexões');
    const falhou = h.db.get<{ result: string; evidence: string }>("SELECT result, evidence FROM audit_events WHERE action = 'equipe.atualizacao_falhou'");
    assert.ok(falhou);
    assert.match(falhou!.result, /^a atualização da equipe para a versão \S+ não deu certo \(a versão nova da equipe veio sem as Conexões\); a equipe voltou para a versão anterior$/);
    for (const t of [falhou!.result, falhou!.evidence]) assert.doesNotMatch(t, JARGAO, t);
    const motor = (await req(h, 'GET', '/api/saude', a)).json.componentes.find((c: { id: string }) => c.id === 'motor');
    assert.equal(motor.nome, 'Equipe de IA');
    assert.doesNotMatch(motor.detalhe, JARGAO);
    assert.equal(motor.estado, 'atencao'); assert.match(motor.detalhe, /não deu certo .*segue na versão anterior/);
    // a próxima volta não recria de novo com o motor ligado
    await h.motors.ensure(a.userId);
    assert.equal(infra.ensures(a.userId).at(-1)!.body?.idle, false);
    assert.equal(infra.calls.filter((c) => c.path.endsWith('/rollback')).length, 1, 'sem laço de recriar e voltar');
    await h.close();
  });

  test('o motor novo não responde no prazo: volta para a anterior', async () => {
    const { h, a, infra } = await setup();
    infra.down.add(IMG_B);
    infra.st.target = IMG_B;
    h.cfg.motorRenewMinutes = 0; // prazo já vencido na primeira conferência
    await h.motors.ensure(a.userId);
    assert.equal(infra.calls.filter((c) => c.path === `/v1/motors/${a.userId}/rollback`).length, 1);
    assert.match(h.motors.saude(a.userId).falha ?? '', /não respondeu/);
    assert.doesNotMatch(h.motors.saude(a.userId).falha ?? '', JARGAO, 'sem "ponte de controle" nem "motor" na Saúde');
    assert.equal(infra.imageOf(a.userId), IMG_A);
    await h.close();
  });

  test('parte fechada: o motor desatualizado é recriado sem ligar e sem chave; quando a pessoa entra, abre e confirma', async () => {
    const { h, a, b, infra } = await setup();
    await h.close();
    infra.st.target = IMG_B;
    // servidor reinicia (sem trancamento): ninguém abriu a própria parte ainda
    const v = new Vault(h.dir, KDF_TEST); assert.ok(v.unsealOpenAccess());
    const h2 = await build(infra, h.dir, v);
    assert.equal(h2.vault.personOpen(a.userId), false); assert.equal(h2.vault.personOpen(b.userId), false);
    const chaves = infra.unlocks.length;
    assert.equal(await h2.motors.renewClosed(), 2);
    for (const u of [a.userId, b.userId]) {
      assert.deepEqual(infra.ensures(u).at(-1)!.body, { adoptLegacy: u === a.userId, idle: true, start: false }, 'recria sem ligar');
      assert.equal(infra.imageOf(u), IMG_B); assert.equal(infra.running.get(u), false);
    }
    assert.equal(infra.unlocks.length, chaves, 'nenhuma chave entregue: a parte da pessoa está fechada');
    // o Alexandre entra: o motor liga na versão nova, recebe a chave e a versão é conferida
    assert.equal((await req(h2, 'POST', '/api/session/unlock', a, { password: 'senha-local-123' })).status, 200);
    await h2.motors.ensure(a.userId);
    assert.equal(h2.motors.state(a.userId).state, 'aberto');
    assert.equal(infra.unlocks.at(-1)!.user, a.userId); assert.equal(infra.unlocks.at(-1)!.key, h2.vault.motorKey(a.userId));
    assert.ok(infra.calls.some((c) => c.path === `/v1/motors/${a.userId}/confirm`));
    await h2.close();
  });

  test('parte fechada, versão nova com defeito: na primeira abertura volta para a anterior; um motor que voltou não volta de novo', async () => {
    const { h, a, infra } = await setup();
    await h.close();
    const IMG_C = 'sha256:cccccccccccc4444444444444444444444444444444444444444444444444444';
    infra.caps.set(IMG_C, ['bloqueio_prefixo']);
    infra.st.target = IMG_C;
    const v = new Vault(h.dir, KDF_TEST); assert.ok(v.unsealOpenAccess());
    const h2 = await build(infra, h.dir, v);
    await h2.motors.renewClosed();
    assert.equal(infra.imageOf(a.userId), IMG_C);
    assert.equal((await req(h2, 'POST', '/api/session/unlock', a, { password: 'senha-local-123' })).status, 200);
    await h2.motors.ensure(a.userId);
    assert.equal(infra.calls.filter((c) => c.path === `/v1/motors/${a.userId}/rollback`).length, 1);
    assert.equal(infra.imageOf(a.userId), IMG_A); assert.equal(h2.motors.state(a.userId).state, 'aberto');
    await h2.close();
    // o servidor reinicia de novo: o motor que voltou não é desfeito outra vez
    infra.prevs.set(a.userId, IMG_C); // o rótulo da imagem de antes ficou no contêiner que voltou
    const v3 = new Vault(h.dir, KDF_TEST); assert.ok(v3.unsealOpenAccess());
    const h3 = await build(infra, h.dir, v3);
    assert.equal((await req(h3, 'POST', '/api/session/unlock', a, { password: 'senha-local-123' })).status, 200);
    await h3.motors.ensure(a.userId);
    assert.equal(infra.calls.filter((c) => c.path === `/v1/motors/${a.userId}/rollback`).length, 1, 'sem laço entre reinícios');
    assert.equal(h3.motors.state(a.userId).state, 'aberto');
    await h3.close();
  });

  test('contêiner trocado por fora com o estado "aberto": volta a "ligando" e a chave é entregue de novo, sem reiniciar o servidor', async () => {
    const { h, a, infra } = await setup();
    const vistos: string[] = [];
    h.bus.subscribe(a.workspaceId, (e) => { if (e.type === 'motor.changed') vistos.push(String((e.data as { state?: string }).state)); });
    const antes = infra.unlocks.filter((x) => x.user === a.userId).length;
    infra.sealed.set(a.userId, true); // alguém recriou o contêiner: a API não responde e o cofre diz "fechado"
    await h.motors.tick();
    await h.motors.ensure(a.userId);
    assert.deepEqual(vistos, ['ligando', 'aberto']);
    assert.equal(infra.unlocks.filter((x) => x.user === a.userId).length, antes + 1);
    assert.equal(h.motors.state(a.userId).state, 'aberto');
    await h.close();
  });

  test('Conexões ligadas por padrão ao abrir, salvo quando a pessoa desligou', async () => {
    const { h, a, b, infra } = await setup();
    for (const u of [a.userId, b.userId]) infra.toolsOf(u).enabled = ['todo'];
    setSetting(h.db, b.workspaceId, 'ferramentas.contas', 'desligado');
    for (const u of [a.userId, b.userId]) { await h.motors.stop(u); await h.motors.ensure(u); }
    assert.ok(platformToolsets(a.userId).enabled.includes('ergon_conexoes'), 'ausente = ligado');
    assert.ok(infra.controlOf(a.userId).sets.at(-1)!.includes('ergon_conexoes'));
    assert.ok(!platformToolsets(b.userId).enabled.includes('ergon_conexoes'), 'a Bruna desligou: fica desligado');
    assert.equal(infra.controlOf(b.userId).sets.length, 0);
    // desligar pela tela grava a escolha: o motor não liga sozinho de novo
    assert.equal((await req(h, 'PUT', '/api/ai/tools', a, { enabled: ['passos'] })).status, 200);
    await h.motors.stop(a.userId); await h.motors.ensure(a.userId);
    assert.ok(!platformToolsets(a.userId).enabled.includes('ergon_conexoes'));
    // a Bruna desligou (gravado a partir da rc.24) e o motor voltou com as Conexões na lista (renovado, ou a migração do
    // cofre): ao abrir, a escolha gravada vale
    infra.toolsOf(b.userId).enabled = ['todo', 'ergon_conexoes'];
    await h.motors.stop(b.userId); await h.motors.ensure(b.userId);
    assert.ok(!platformToolsets(b.userId).enabled.includes('ergon_conexoes'), 'a escolha da Bruna vale');
    assert.ok(!infra.controlOf(b.userId).sets.at(-1)!.includes('ergon_conexoes'));
    // o texto do registro vai cifrado no banco: confere depois de ler
    assert.ok(h.db.all<{ result: string | null }>("SELECT result FROM audit_events WHERE action = 'ai.tools'").some((x) => /^Conexões desligadas para a equipe/.test(x.result ?? '')), 'fica no registro');
    await h.close();
  });
});

describe('espaço: imagens antigas e cofres sem dono', () => {
  test('limpeza uma vez por versão, quando todos os abertos estão na versão nova; manda todas as pessoas do banco', async () => {
    const { h, a, b, infra } = await setup();
    const limpezas = () => infra.calls.filter((c) => c.path === '/v1/maintenance/clean');
    // versão nova: a limpeza desta versão ainda não rodou
    h.db.run("DELETE FROM instance_settings WHERE key = 'limpeza_versao'");
    const n0 = limpezas().length;
    infra.st.target = IMG_B;
    infra.motorOf(b.userId).next = 'running';
    const rb = await chat(h, b, 'trabalho da Bruna', 'req-espaco-001'); await ticks(h, 2);
    await h.motors.ensure(b.userId);
    assert.equal(h.motors.state(b.userId).state, 'renovando');
    await h.motors.ensure(a.userId);
    assert.equal(h.motors.state(a.userId).state, 'aberto');
    assert.equal(await h.motors.limparSePronto(), false, 'a Bruna ainda não renovou');
    assert.equal(limpezas().length, n0);
    infra.motorOf(b.userId).runs.get(run(h, rb.runId).hermes_run_id!)!.status = 'completed'; await ticks(h, 1);
    await h.motors.tick(); await h.motors.ensure(b.userId);
    await new Promise((r) => setTimeout(r, 20)); // a abertura dela dispara a limpeza (app.ts, onChange)
    assert.equal(limpezas().length, n0 + 1, 'todos os abertos na versão nova: uma limpeza');
    assert.deepEqual(limpezas().at(-1)!.body?.users, [a.userId, b.userId].sort(), 'todas as pessoas do banco');
    assert.deepEqual(limpezas().at(-1)!.body?.pendentes, []);
    assert.equal(await h.motors.limparSePronto(), false, 'uma vez por versão');
    assert.equal(limpezas().length, n0 + 1);
    await h.close();
  });

  test('só cofre de conta que não existe mais é oferecido; reinstalação com dois cofres sem contêiner: nenhuma oferta', async () => {
    const { h, a, b, infra } = await setup();
    const vol = (u: string) => `ergon_motor-${u.slice(4)}`;
    // reinstalação: os cofres das duas pessoas estão sem contêiner, e o de antes também
    infra.st.avisos = [vol(a.userId), vol(b.userId), 'ergon_hermes-vault'];
    infra.st.volumes = [{ nome: vol(a.userId) }, { nome: vol(b.userId) }, { nome: 'ergon_hermes-vault', herdado: true }];
    const r1 = await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true });
    assert.equal(r1.status, 200); assert.deepEqual(r1.json.volumes, [], 'nenhuma oferta de apagar');
    assert.equal(r1.json.liberado, 5e8);
    const limpeza = () => infra.calls.filter((c) => c.path === '/v1/maintenance/clean').at(-1)!.body!;
    assert.deepEqual(limpeza().volumesOrfaos, [], 'cofres de quem existe nunca vão como órfãos');
    assert.equal((await req(h, 'POST', '/api/saude/liberar-espaco', a, {})).status, 400, 'sem a confirmação no corpo, nada');
    // uma conta removida (o gerente não chegou a apagar o cofre dela)
    const sumido = `usr_${'d'.repeat(32)}`;
    infra.st.avisos = [vol(a.userId), vol(sumido), 'ergon_hermes-vault', 'outro_volume'];
    infra.st.volumes = [{ nome: vol(a.userId), emUso: true, instalacao: 'nossa' }, { nome: vol(sumido), instalacao: 'nossa' }, { nome: 'ergon_hermes-vault', herdado: true }];
    const r2 = (await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true })).json;
    assert.deepEqual(r2.volumes, [{ nome: vol(sumido), conta: 'uma conta removida' }]);
    // sem a marca da instalação (gerente de antes, ou cofre de antes da marca): a tela não afirma que foi uma conta deste Ergon
    infra.st.volumes = [{ nome: vol(a.userId), emUso: true }, { nome: vol(sumido) }, { nome: 'ergon_hermes-vault', herdado: true }];
    const semMarca = (await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true })).json;
    // a tela prefixa "Cofre de": o rótulo do servidor não repete "cofre de"
    assert.deepEqual(semMarca.volumes, [{ nome: vol(sumido), conta: 'uma conta que não existe neste Ergon (pode ser de outra instalação, ou de antes de reinstalar)' }]);
    // de outra instalação no mesmo Docker: nunca é oferecido
    infra.st.volumes = [{ nome: vol(a.userId), emUso: true, instalacao: 'nossa' }, { nome: vol(sumido), instalacao: 'outra' }];
    await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true });
    assert.deepEqual(limpeza().volumesOrfaos, [], 'o servidor nem manda o nome');
    infra.st.volumes = [{ nome: vol(a.userId), emUso: true, instalacao: 'nossa' }, { nome: vol(sumido), instalacao: 'nossa' }];
    assert.deepEqual((await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true })).json.volumes, [{ nome: vol(sumido), conta: 'uma conta removida' }]);
    assert.deepEqual(limpeza().volumesOrfaos, [vol(sumido)], 'o Ergon cruza com o banco e manda só o de quem não existe');
    const saude = (await req(h, 'GET', '/api/saude', a)).json;
    assert.match(saude.componentes.find((c: { id: string }) => c.id === 'cofres').detalhe, /1 cofre guardado \(uma conta removida\)/);
    assert.equal(saude.espaco.volumes.length, 1);
    // apagar: confirmação com o nome; nunca o de quem existe nem o de antes
    assert.equal((await req(h, 'DELETE', `/api/saude/volumes/${vol(sumido)}`, a, { confirmar: 'sim' })).status, 400);
    assert.equal((await req(h, 'DELETE', `/api/saude/volumes/${vol(a.userId)}`, a, { confirmar: vol(a.userId) })).status, 409);
    assert.equal((await req(h, 'DELETE', '/api/saude/volumes/ergon_hermes-vault', a, { confirmar: 'ergon_hermes-vault' })).status, 400);
    assert.ok(!infra.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/v1/volumes/')), 'nada apagado até aqui');
    assert.equal((await req(h, 'DELETE', `/api/saude/volumes/${vol(sumido)}`, a, { confirmar: vol(sumido) })).status, 200);
    assert.deepEqual(infra.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/v1/volumes/')).map((c) => c.path), [`/v1/volumes/${vol(sumido)}`]);
    assert.deepEqual((await req(h, 'GET', '/api/saude', a)).json.espaco.volumes, []);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'admin.apagar_cofre'"));
    // só quem administra
    assert.equal((await req(h, 'POST', '/api/saude/liberar-espaco', b, { confirmar: true })).status, 403);
    await h.close();
  });

  test('o filtro: pessoa existente, herdeira do cofre de antes e o próprio cofre de antes ficam de fora', async () => {
    const { h, a, b } = await setup();
    const sumido = 'e'.repeat(32);
    const nomes = [`ergon_motor-${a.userId.slice(4)}`, `ergon_motor-${b.userId.slice(4)}`, 'ergon_hermes-vault', 'ergon_hermes-data', `ergon_motor-${sumido}`];
    assert.deepEqual(filtrarOrfaos(h.db, nomes).map((v) => v.nome), [`ergon_motor-${sumido}`]);
    h.db.run("INSERT INTO instance_settings (key, value, updated_at) VALUES ('motor_legacy_owner', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", `usr_${sumido}`, new Date().toISOString());
    assert.deepEqual(filtrarOrfaos(h.db, nomes), [], 'nunca o da pessoa que herdou o cofre de antes');
    await h.close();
  });
});
