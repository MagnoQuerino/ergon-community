/**
 * A fila durante a renovação do motor: o pedido novo espera sem contar tempo (sem started_at, sem tempo limite), o que
 * tinha sido admitido mas ainda não foi ao motor volta para a fila; e as instruções do agente dizem a verdade quando as
 * Conexões ainda não chegaram ao motor deste computador (sem "não prometa" sem motivo, sem mandar improvisar).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { throttle } from '../src/security/factors.ts';
import { setPlatformToolsets, setRenovacaoFalhou } from '../src/services/characters.ts';
import { HermesError, type HermesClient, type HermesControlClient, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { instructionsFor } from '../src/services/runs.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const MASTER = 'token-da-instalacao-'.padEnd(40, 'y');
const MANAGER = 'http://gerente.test:8645';

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  /** o motor responde 503 ao começar (subindo, ocupado) */
  fora = false;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    if (this.fora) throw new HermesError(503, 'o motor de IA não respondeu');
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}`;
    this.runs.set(runId, { status: 'completed', output: 'pronto', error: null, sessionId: 'sess-1', usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: [] }, { name: 'ergon_conexoes', label: 'c', enabled: true, configured: true, tools: [] }]; }
}
const control = { health: async () => true, info: async () => ({ ok: true, pluginVersion: '0.3.0', vaultConfig: 2, capacidades: ['conexoes'] }), apiToolsets: async () => ({ enabled: ['todo', 'ergon_conexoes'], safe: ['todo', 'ergon_conexoes'] }), setApiToolsets: async (e: string[]) => e, modelInfo: async () => ({ model: null, provider: null }) } as unknown as HermesControlClient;

/** Gerente que diz "desatualizado" enquanto `novo` não foi aplicado, e o receptor do cofre. */
function gerente() {
  const st = { novo: false, aplicado: false, sealed: true, ensures: [] as Array<Record<string, unknown> | null> };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (u.origin === MANAGER) {
      if (u.pathname.endsWith('/ensure')) {
        st.ensures.push(body);
        const stale = st.novo && !st.aplicado;
        if (stale && body?.idle !== true) return json({ ok: true, stale: true, recreated: false, image: 'sha256:velha', prevImage: null });
        if (stale) { st.aplicado = true; st.sealed = true; return json({ ok: true, stale: true, recreated: true, image: 'sha256:nova', prevImage: 'sha256:velha' }); }
        return json({ ok: true, stale: false, recreated: false, image: st.aplicado ? 'sha256:nova' : 'sha256:velha', prevImage: null });
      }
      return json({ ok: true });
    }
    if (u.port === '8644') {
      if (u.pathname === '/status') return json({ sealed: st.sealed });
      if (u.pathname === '/unlock') { st.sealed = false; return json({ ok: true }); }
    }
    return json({ error: 'sem rota' }, 599);
  }) as typeof fetch;
  return { st, f };
}

async function porPessoa(): Promise<{ h: Harness; s: Session; motor: Motor; g: ReturnType<typeof gerente> }> {
  throttle.reset();
  const motor = new Motor(); const g = gerente();
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', motorManagerUrl: MANAGER, bridgeToken: MASTER, runTimeoutSeconds: 30, longRunTimeoutSeconds: 30 },
    { motorClients: () => ({ hermes: motor, control }), motorFetch: g.f });
  const s = await setupOwner(h);
  await h.motors.ensure(s.userId);
  return { h, s, motor, g };
}
const pedir = async (h: Harness, s: Session, text: string, id: string) => {
  const agents = await allAgents(h, s);
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agents[0].id })).json;
  return (await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text, clientRequestId: id })).json.runId as string;
};
const linha = (h: Harness, id: string) => h.db.get<{ status: string; started_at: string | null; error: string | null }>('SELECT status, started_at, error FROM runs WHERE id = ?', id)!;
const ticks = async (h: Harness, n: number) => { for (let i = 0; i < n; i++) await h.executor.tick(); };

describe('fila durante a renovação do motor', () => {
  test('o pedido feito durante a renovação não estoura o tempo limite e segue quando o motor novo abre', async () => {
    const { h, s, motor, g } = await porPessoa();
    // versão nova com trabalho no motor: fica "renovando"
    h.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, max_attempts, created_at, started_at, hermes_run_id) SELECT 'run_00000000000000000000000000000abc', ?, id, 'chat', 'running', 'real', 'x', 'trabalho-no-motor', 2, ?, ?, 'run_remoto_velho' FROM agents WHERE workspace_id = ? LIMIT 1",
      s.workspaceId, new Date().toISOString(), new Date().toISOString(), s.workspaceId);
    motor.runs.set('run_remoto_velho', { status: 'running', output: null, error: null, sessionId: 'sess-velha', usage: null });
    g.st.novo = true;
    await h.motors.ensure(s.userId);
    assert.equal(h.motors.state(s.userId).state, 'renovando');
    const id = await pedir(h, s, 'resuma a semana', 'req-renovando-0001');
    // muito tempo depois (bem acima do tempo limite de 30 s): continua esperando, sem relógio
    h.db.run('UPDATE runs SET created_at = ? WHERE id = ?', new Date(Date.now() - 3600_000).toISOString(), id);
    await ticks(h, 4);
    assert.equal(linha(h, id).status, 'queued', 'não foi admitido');
    assert.equal(linha(h, id).started_at, null, 'sem started_at: o tempo limite não corre');
    assert.match(linha(h, id).error ?? '', /^aguardando a equipe \(atualizando para a versão nova; o pedido segue sozinho quando terminar\)$/);
    assert.doesNotMatch(linha(h, id).error ?? '', /\bmotor\b/i, 'o card fala da equipe');
    assert.equal(motor.started.length, 0);
    // o trabalho do motor velho termina; a renovação acontece e o pedido vai ao motor novo
    motor.runs.get('run_remoto_velho')!.status = 'completed';
    await ticks(h, 1);
    await h.motors.tick(); await h.motors.ensure(s.userId);
    assert.equal(g.st.aplicado, true); assert.equal(h.motors.state(s.userId).state, 'aberto');
    await ticks(h, 3);
    assert.equal(motor.started.length, 1);
    assert.equal(linha(h, id).status, 'succeeded', 'terminou, sem estourar o tempo');
    await h.close();
  });

  test('admitido mas ainda não enviado ao motor: com o motor deixando de receber, volta para a fila sem relógio', async () => {
    const { h, s, motor, g } = await porPessoa();
    motor.fora = true; // o motor responde 503: o pedido fica admitido, tentando de novo
    const id = await pedir(h, s, 'faça o resumo', 'req-renovando-0002');
    await ticks(h, 2);
    assert.equal(linha(h, id).status, 'running'); assert.ok(linha(h, id).started_at);
    // começa a renovação (o gerente diz "desatualizado" com trabalho no motor)
    h.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, max_attempts, created_at, started_at, hermes_run_id) SELECT 'run_00000000000000000000000000000abd', ?, id, 'chat', 'running', 'real', 'x', 'outro-no-motor', 2, ?, ?, 'run_remoto_2' FROM agents WHERE workspace_id = ? LIMIT 1",
      s.workspaceId, new Date().toISOString(), new Date().toISOString(), s.workspaceId);
    motor.runs.set('run_remoto_2', { status: 'running', output: null, error: null, sessionId: 'sess-2', usage: null });
    g.st.novo = true;
    await h.motors.ensure(s.userId);
    assert.equal(h.motors.state(s.userId).state, 'renovando');
    await ticks(h, 1);
    assert.equal(linha(h, id).status, 'queued', 'voltou para a fila');
    assert.equal(linha(h, id).started_at, null, 'o relógio do tempo limite zerou');
    await h.close();
  });
});

describe('instruções do agente com as Conexões a caminho', () => {
  async function umMotor(toolsets: Array<{ name: string; enabled: boolean }>): Promise<{ h: Harness; s: Session; coord: string }> {
    throttle.reset();
    const motor = new Motor();
    motor.toolsets = async () => toolsets.map((t) => ({ ...t, label: t.name, configured: true, tools: [] }));
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    const s = await setupOwner(h);
    await h.ai.refreshToolsets();
    const coord = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1', s.workspaceId)!.id;
    return { h, s, coord };
  }
  const conectar = (h: Harness, s: Session) => setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });

  test('motor sem o conjunto e conta conectada: o Aristóteles sabe que está atualizando e não improvisa', async () => {
    const { h, s, coord } = await umMotor([{ name: 'todo', enabled: true }, { name: 'web', enabled: false }]);
    conectar(h, s);
    const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', coord)!.tools) as string[];
    assert.ok(tools.includes('contas'), 'o Coordenador tem as Conexões');
    const ins = instructionsFor(h.db, s.workspaceId, coord, '');
    assert.doesNotMatch(ins, /Ainda não disponíveis[^\n]*Conexões/);
    assert.doesNotMatch(ins, /não prometa/);
    assert.match(ins, /As Conexões \(as contas e os aplicativos que a pessoa conectou\) estão sendo atualizadas neste computador/);
    assert.match(ins, /nada de skills de e-mail \(como himalaya\), terminal ou programas/);
    assert.match(ins, /segue quando a atualização terminar/);
    assert.doesNotMatch(ins, /Ferramentas que você ainda não pode usar[^\n]*Conexões/, 'não vai para a lista do que falta');
    await h.close();
  });

  test('depois de uma renovação que voltou atrás: o agente não promete que as Conexões "voltam sozinhas"', async () => {
    const { h, s, coord } = await umMotor([{ name: 'todo', enabled: true }, { name: 'web', enabled: false }]);
    conectar(h, s);
    setRenovacaoFalhou(() => true);
    try {
      const ins = instructionsFor(h.db, s.workspaceId, coord, '');
      assert.doesNotMatch(ins, /sendo atualizadas neste computador/, 'nada de "voltam sozinhas quando a atualização terminar"');
      assert.match(ins, /Ferramentas que você ainda não pode usar, e por quê: [^\n]*Conexões \(a atualização da equipe não deu certo neste computador: as Conexões voltam com a próxima versão do Ergon\)/);
    } finally { setRenovacaoFalhou(() => false); }
    await h.close();
  });

  test('o que falta vai com o motivo verdadeiro; Conexões ligadas: nada de aviso de atualização', async () => {
    const { h, s, coord } = await umMotor([{ name: 'todo', enabled: false }, { name: 'ergon_conexoes', enabled: false }]);
    conectar(h, s);
    // a pessoa desligou as Conexões e a Lista de passos (o motor tem os dois conjuntos)
    const ins = instructionsFor(h.db, s.workspaceId, coord, '');
    assert.match(ins, /Ferramentas que você ainda não pode usar, e por quê: [^\n]*Lista de passos \(desligada para a equipe: a pessoa liga em Configurações › Ferramentas\)/);
    assert.match(ins, /Conexões \(desligada para a equipe/);
    assert.doesNotMatch(ins, /sendo atualizadas neste computador/);
    setPlatformToolsets(['todo', 'ergon_conexoes'], '_', ['todo', 'ergon_conexoes']);
    const ok = instructionsFor(h.db, s.workspaceId, coord, '');
    assert.doesNotMatch(ok, /sendo atualizadas neste computador/);
    assert.doesNotMatch(ok, /Ferramentas que você ainda não pode usar[^\n]*Conexões/);
    assert.match(ok, /Ferramentas que você tem:[^\n]*Conexões/);
    await h.close();
  });
});
