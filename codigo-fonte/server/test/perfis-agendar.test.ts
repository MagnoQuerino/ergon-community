/**
 * A mudança no agente chega ao perfil dele antes do próximo pedido (ensaio da rc.27). Antes: com o motor fechado, ligando
 * ou renovando no momento da mudança, o envio logo depois (Perfis.agendar) desistia calado, nada o repetia, e o pedido
 * seguinte (que religa o motor) rodava no perfil sem a mudança até a volta de 60 s pegar; um envio que falhava só ia de
 * novo na volta, sem nada no registro. Confere, com um motor por pessoa e uma ponte falsa:
 * - mudou com o motor fechado: o perfil vai assim que o motor abre, sem esperar a volta;
 * - o envio falhou: fica no registro e vai de novo em poucos segundos;
 * - o pedido do agente espera a mudança chegar ao perfil (o perfil dele é mandado na hora) e só então começa, no perfil;
 * - passou do limite curto: a conversa nova vai no perfil padrão, com as instruções inteiras; a que já mora no perfil
 *   continua nele.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setLog } from '../src/lib/log.ts';
import { throttle } from '../src/security/factors.ts';
import { HermesError, type HermesClient, type HermesControlClient, type PedidoDePerfil, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { nomeDoPerfil } from '../src/services/perfis.ts';
import { almaDoAgente } from '../src/services/runs.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const MASTER = 'token-da-instalacao-'.padEnd(40, 'y');
const MANAGER = 'http://gerente.test:8645';

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  perfis = new Map<string, PedidoDePerfil>();
  envios: string[] = [];
  /** quantos envios de perfil seguidos falham (503) */
  falhar = 0;
  /** segura os envios de perfil até soltar */
  segurar: Promise<void> | null = null;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    if (p.profile && !this.perfis.has(p.profile)) throw new HermesError(404, 'Unknown or unconfigured profile');
    this.started.push(p);
    const runId = `run_${String(this.started.length).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sess_${runId}`, usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: [] }]; }
  control(): HermesControlClient {
    const self = this;
    return {
      health: async () => true,
      info: async () => ({ ok: true, pluginVersion: '0.6.0', vaultConfig: 4, capacidades: ['conexoes', 'perfis', 'memoria', 'ajudantes'] }),
      apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e,
      modelInfo: async () => ({ model: null, provider: null }),
      async perfil(nome: string, pedido: PedidoDePerfil) {
        if (self.segurar) await self.segurar;
        if (self.falhar > 0) { self.falhar--; throw new HermesError(503, 'a equipe de IA não respondeu agora'); }
        self.envios.push(nome);
        const criado = !self.perfis.has(nome);
        self.perfis.set(nome, pedido);
        return { criado, mudou: criado ? ['criado'] : ['alma'] };
      },
    } as unknown as HermesControlClient;
  }
}

function gerente() {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.origin === MANAGER) return json(u.pathname.endsWith('/ensure') ? { ok: true, stale: false, recreated: false, image: 'sha256:x', prevImage: null } : { ok: true });
    if (u.port === '8644') return json(u.pathname === '/status' ? { sealed: false } : { ok: true });
    return json({ error: 'sem rota' }, 599);
  }) as typeof fetch;
}

async function montar(): Promise<{ h: Harness; s: Session; motor: Motor; ag: any }> {
  throttle.reset();
  const motor = new Motor(); const control = motor.control();
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', motorManagerUrl: MANAGER, bridgeToken: MASTER },
    { motorClients: () => ({ hermes: motor, control }), motorFetch: gerente() });
  const s = await setupOwner(h);
  await h.motors.ensure(s.userId);
  await h.perfis.emDia(s.workspaceId, 100);
  const agentes = await allAgents(h, s);
  const ag = agentes.find((a) => !a.coordinator) ?? agentes[1];
  motor.envios.length = 0;
  return { h, s, motor, ag };
}
const esperar = async (cond: () => boolean, ms = 3000) => { const fim = Date.now() + ms; while (!cond() && Date.now() < fim) await new Promise((x) => setTimeout(x, 25)); return cond(); };
const ticks = async (h: Harness, n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const mudar = (h: Harness, s: Session, id: string, texto: string) => req(h, 'PATCH', `/api/agents/${id}`, s, { charter: texto });

describe('a mudança no agente chega ao perfil antes do próximo pedido', () => {
  test('mudou com o motor fechado: o perfil vai assim que o motor abre, sem esperar a volta', async () => {
    const { h, s, motor, ag } = await montar();
    await h.motors.stop(s.userId);
    assert.equal((await mudar(h, s, ag.id, 'Cuida só das plantas. MARCA-V2')).status, 200);
    await new Promise((x) => setTimeout(x, 800));
    assert.deepEqual(motor.envios, [], 'motor fechado: nada vai');
    await h.motors.ensure(s.userId);
    assert.ok(await esperar(() => motor.envios.includes(nomeDoPerfil(s.workspaceId, ag.id))), 'o motor abriu: o perfil foi logo');
    assert.match(motor.perfis.get(nomeDoPerfil(s.workspaceId, ag.id))!.alma, /MARCA-V2/);
    assert.ok(h.perfis.emDiaCom(s.workspaceId, ag.id));
    await h.close();
  });

  test('o envio falhou: fica no registro e vai de novo em poucos segundos', async () => {
    const { h, s, motor, ag } = await montar();
    const avisos: Array<{ o: Record<string, unknown>; m: string }> = [];
    setLog({ info() {}, warn: (o, m) => avisos.push({ o: o as Record<string, unknown>, m }), error() {} });
    try {
      motor.falhar = 1;
      await mudar(h, s, ag.id, 'Cuida só das plantas. MARCA-V3');
      assert.ok(await esperar(() => avisos.some((a) => /perfil do agente: o motor não recebeu/.test(a.m)), 2000), 'a falha vai para o registro');
      const a = avisos.find((x) => /o motor não recebeu/.test(x.m))!;
      assert.equal(a.o.agentId, ag.id); assert.equal(a.o.status, 503);
      assert.ok(await esperar(() => motor.envios.includes(nomeDoPerfil(s.workspaceId, ag.id)), 4500), 'foi de novo em poucos segundos');
      assert.ok(h.perfis.emDiaCom(s.workspaceId, ag.id));
    } finally { setLog(null); }
    await h.close();
  });

  test('o pedido do agente espera a mudança chegar ao perfil e só então começa, no perfil', async () => {
    const { h, s, motor, ag } = await montar();
    const perfil = nomeDoPerfil(s.workspaceId, ag.id);
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    let soltar!: () => void;
    motor.segurar = new Promise<void>((ok) => { soltar = ok; });
    await mudar(h, s, ag.id, 'Cuida só das plantas. MARCA-V4');
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-perfil-espera-1' });
    await ticks(h);
    assert.equal(motor.started.length, 0, 'não começa no perfil sem a mudança');
    const r = h.db.get<{ status: string; error: string | null }>("SELECT status, error FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", c)!;
    assert.match(String(r.error), /preparando o agente/);
    motor.segurar = null; soltar();
    assert.ok(await esperar(() => h.perfis.emDiaCom(s.workspaceId, ag.id)), 'o perfil ficou em dia');
    await ticks(h);
    const st = motor.started.at(-1);
    assert.ok(st, 'começou');
    assert.equal(st!.profile, perfil, 'no perfil do agente');
    assert.match(motor.perfis.get(perfil)!.alma, /MARCA-V4/, 'com a mudança já no perfil');
    assert.ok(!String(st!.instructions).startsWith(almaDoAgente(h.db, s.workspaceId, ag.id)), 'a identidade não vai de novo (o perfil já a tem)');
    await h.close();
  });

  test('passou do limite: conversa nova vai no perfil padrão com as instruções inteiras; a que mora no perfil continua nele', async () => {
    const { h, s, motor, ag } = await montar();
    const perfil = nomeDoPerfil(s.workspaceId, ag.id);
    h.executor.perfilEsperaMs = 300;
    // uma conversa que já começou no perfil
    const antiga = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    await req(h, 'POST', `/api/conversations/${antiga}/messages`, s, { text: 'Oi', clientRequestId: 'req-perfil-lim-0' });
    await ticks(h);
    assert.equal(motor.started.at(-1)!.profile, perfil);
    motor.runs.set([...motor.runs.keys()].at(-1)!, { status: 'completed', output: 'ok', error: null, sessionId: 's', usage: null });
    await ticks(h);
    // o motor não termina de receber o perfil agora (ocupado)
    let soltar!: () => void;
    motor.segurar = new Promise<void>((ok) => { soltar = ok; });
    await mudar(h, s, ag.id, 'Cuida só das plantas. MARCA-V5');
    const nova = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    await req(h, 'POST', `/api/conversations/${nova}/messages`, s, { text: 'Olá', clientRequestId: 'req-perfil-lim-1' });
    await req(h, 'POST', `/api/conversations/${antiga}/messages`, s, { text: 'E agora?', clientRequestId: 'req-perfil-lim-2' });
    const n0 = motor.started.length;
    await ticks(h);
    assert.equal(motor.started.length, n0, 'dentro do limite: espera');
    await new Promise((x) => setTimeout(x, 350));
    await ticks(h, 4);
    const comecados = motor.started.slice(n0);
    assert.equal(comecados.length, 2, JSON.stringify(comecados.map((x) => x.profile)));
    const daNova = comecados.find((x) => x.sessionKey.includes(nova))!;
    const daAntiga = comecados.find((x) => x !== daNova)!;
    assert.equal(daNova.profile ?? null, null, 'conversa nova: perfil padrão');
    assert.ok(String(daNova.instructions).startsWith(almaDoAgente(h.db, s.workspaceId, ag.id)), 'com a identidade inteira (e a mudança)');
    assert.match(String(daNova.instructions), /MARCA-V5/);
    assert.equal(daAntiga.profile, perfil, 'a conversa que mora no perfil continua nele');
    assert.ok(String(daAntiga.instructions).startsWith(almaDoAgente(h.db, s.workspaceId, ag.id)), 'e leva a identidade nova nas instruções (o perfil ainda tem a de antes)');
    motor.segurar = null; soltar();
    await h.close();
  });
});
