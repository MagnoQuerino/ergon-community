/**
 * O Ergon World no Estado do Ergon, na etiqueta da barra e na Governança: o gasto do mês separado entre Ergon AI e Jobs
 * (pelo extrato, só o mês de Salvador), a próxima franquia, os Jobs do mês (do World, ou os daqui quando o World ainda
 * não conta), os últimos resultados da nuvem, a última sincronia e o registro do workspace (só quem administra).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { deMicro, inicioDoMes, paraMicro, proximaFranquia, somarGastos } from '../src/world/estado.ts';

describe('Estado do Ergon com o Ergon World', () => {
  let world: FakeWorld; let pc: Harness; let ana: Session; let sws = '';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc?.close(); await world.stop(); });

  test('o mês de Salvador, Dracmas em texto e a soma por componente', () => {
    assert.equal(inicioDoMes(new Date('2026-11-16T12:00:00Z')).toISOString(), '2026-11-01T03:00:00.000Z');
    // 1º de dezembro às 01:00 UTC ainda é 30 de novembro em Salvador
    assert.equal(inicioDoMes(new Date('2026-12-01T01:00:00Z')).toISOString(), '2026-11-01T03:00:00.000Z');
    assert.equal(paraMicro('12.5'), 12_500_000n); assert.equal(paraMicro('-0.000001'), -1n); assert.equal(paraMicro('abc'), 0n);
    assert.equal(deMicro(12_500_000n), '12.500000');
    const desde = new Date('2026-11-01T03:00:00Z');
    const g = somarGastos([
      { kind: 'capture', amount: '3.000000', createdAt: '2026-11-10T00:00:00Z', meta: { component: 'ai_tokens' } },
      { kind: 'capture', amount: '2.000000', createdAt: '2026-11-09T00:00:00Z', meta: { component: 'job_seconds' } },
      { kind: 'grant', amount: '500.000000', createdAt: '2026-11-08T00:00:00Z' },
      { kind: 'capture', amount: '1.000000', createdAt: '2026-11-07T00:00:00Z', meta: null },
      { kind: 'capture', amount: '9.000000', createdAt: '2026-10-31T00:00:00Z', meta: { component: 'ai_tokens' } },
    ], desde);
    assert.deepEqual(g, { ai: 3_000_000n, jobs: 2_000_000n, other: 1_000_000n, passou: true });
  });

  test('a próxima franquia: a do World; sem ela, a renovação do plano mensal pago', () => {
    const ativo = { status: 'active', plan_sku: 'world_pro', source: 'stripe' };
    assert.equal(proximaFranquia({ entitlement: { ...ativo, next_grant_at: '2026-12-05T03:00:00Z' } }), '2026-12-05T03:00:00Z');
    assert.equal(proximaFranquia({ entitlement: ativo, subscription: { plan: 'world_pro', periodEnd: '2026-12-10T00:00:00Z' } }), '2026-12-10T00:00:00Z');
    assert.equal(proximaFranquia({ entitlement: ativo, subscription: { plan: 'world_pro_annual', periodEnd: '2027-11-10T00:00:00Z' } }), null, 'no anual, só o World sabe');
    assert.equal(proximaFranquia({ entitlement: { ...ativo, source: 'cortesia' }, subscription: null }), null);
    assert.equal(proximaFranquia({ entitlement: { status: 'none' } }), null);
  });

  test('sem workspace ligado: nada sai do aparelho', async () => {
    pc = await harness(); ana = await setupOwner(pc, 'ana', 'senha-da-ana-123');
    assert.equal((await req(pc, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    const antes = world.log.length;
    assert.deepEqual((await req(pc, 'GET', '/api/world/consumo', ana)).json.available, false);
    assert.deepEqual((await req(pc, 'GET', '/api/world/cards/recent', ana)).json, { items: [] });
    assert.deepEqual((await req(pc, 'GET', '/api/world/activity', ana)).json, { available: false, allowed: false, entries: [] });
    assert.equal(world.log.length, antes);
  });

  test('consumo do mês: Ergon AI e Jobs separados, a franquia do World e os Jobs do mês', async () => {
    sws = (await req(pc, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
    world.activate(sws, 'world_team');
    const w = world.workspaces.get(sws)!;
    const agora = Date.now(); const dia = 86_400_000;
    // mais velho primeiro, como o World grava; 250 linhas no mês: a soma passa por mais de uma página (200 por página)
    w.statement = [
      { id: 'led_0', kind: 'capture', delta: '0', amount: '50.000000', createdAt: new Date(inicioDoMes().getTime() - dia).toISOString(), meta: { component: 'ai_tokens' } },
      ...Array.from({ length: 250 }, (_, i) => ({ id: `led_${i + 1}`, kind: 'capture', delta: '0', amount: '1.500000', createdAt: new Date(Math.max(inicioDoMes().getTime() + 1000, agora - (250 - i) * 1000)).toISOString(), meta: { component: i % 3 === 0 ? 'job_seconds' : 'ai_tokens' } })),
    ];
    w.nextGrantAt = '2026-12-01T03:00:00.000Z';
    const c = (await req(pc, 'GET', '/api/world/consumo', ana)).json;
    assert.equal(c.available, true);
    assert.deepEqual(c.spent, { ai: '249.000000', jobs: '126.000000', other: '0.000000' }, 'o mês anterior fica de fora');
    assert.equal(c.nextMonthlyAt, '2026-12-01T03:00:00.000Z');
    assert.equal(c.jobs.source, 'world');
    assert.equal(c.jobs.total, 0);
    assert.equal(world.log.filter((l) => l.path.startsWith('/v1/wallet/statement')).length, 2, 'duas páginas, e para no mês anterior');
    // relido em seguida: vem da memória (30 s), sem nova ida ao World
    const antes = world.log.length;
    await req(pc, 'GET', '/api/world/consumo', ana);
    assert.equal(world.log.length, antes);
  });

  test('World sem a contagem dos Jobs: conta os que voltaram para este computador; últimos resultados com o nome', async () => {
    const tid = pc.db.get<{ id: string }>('SELECT id FROM tasks WHERE workspace_id = ? LIMIT 1', ana.workspaceId)?.id ?? null;
    const rid = pc.db.get<{ id: string }>('SELECT id FROM routines WHERE workspace_id = ? LIMIT 1', ana.workspaceId)?.id ?? null;
    const ref = tid ? `card:${tid}` : rid ? `rotina:${rid}` : 'card:nao-existe';
    const at = new Date().toISOString();
    pc.db.run(`INSERT INTO world_cloud_results (job_id, workspace_id, user_id, card_ref, outcome, recovered, fallback, reason, at) VALUES (?, ?, ?, ?, 'concluido', 1, NULL, NULL, ?)`, 'job_a', ana.workspaceId, ana.userId, ref, at);
    pc.db.run(`INSERT INTO world_cloud_results (job_id, workspace_id, user_id, card_ref, outcome, recovered, fallback, reason, at) VALUES (?, ?, ?, ?, 'falhou', 0, NULL, 'a fonte não respondeu', ?)`, 'job_b', ana.workspaceId, ana.userId, ref, at);
    const recentes = (await req(pc, 'GET', '/api/world/cards/recent', ana)).json.items as Array<{ ref: string; outcome: string; recovered: boolean; title: string | null }>;
    assert.equal(recentes.length, 2);
    assert.deepEqual(recentes.map((x) => x.outcome).sort(), ['concluido', 'falhou']);
    if (tid || rid) assert.ok(recentes.every((x) => typeof x.title === 'string'), 'o nome do card ou da rotina');
    // um World sem /v1/jobs/stats (404): a contagem é a deste computador
    const semStats = new FakeWorld();
    try {
      await semStats.start();
      process.env.ERGON_WORLD_URL = semStats.url;
      const pc3 = await harness(); const caio = await setupOwner(pc3, 'caio', 'senha-do-caio-123');
      await req(pc3, 'POST', '/api/world/connect', caio, { mode: 'signup', email: 'caio@exemplo.test', password: 'senha-do-world-123', displayName: 'Caio' });
      const s3 = (await req(pc3, 'POST', '/api/world/bind', caio, {})).json.syncWorkspaceId as string;
      semStats.activate(s3, 'world_pro');
      const orig = (semStats as unknown as { route: (...a: unknown[]) => unknown }).route.bind(semStats);
      (semStats as unknown as { route: (...a: unknown[]) => unknown }).route = (method: unknown, u: unknown, ...rest: unknown[]) => ((u as URL).pathname === '/v1/jobs/stats' ? { fail: [404, 'job'] } : orig(method, u, ...rest));
      pc3.db.run(`INSERT INTO world_cloud_results (job_id, workspace_id, user_id, card_ref, outcome, recovered, fallback, reason, at) VALUES ('job_c', ?, ?, 'card:x', 'concluido', 1, NULL, NULL, ?)`, caio.workspaceId, caio.userId, new Date().toISOString());
      const j = (await req(pc3, 'GET', '/api/world/consumo', caio)).json.jobs;
      assert.deepEqual(j, { total: 1, succeeded: 1, failed: 0, recovered: 1, source: 'local' });
      await pc3.close(); await semStats.stop();
    } finally { process.env.ERGON_WORLD_URL = world.url; }
  });

  test('registro do workspace: quem administra vê as ações (com os nomes); a última sincronia aparece no estado do Sync', async () => {
    const acc = [...world.accounts.values()].find((a) => a.email === 'ana@exemplo.test')!;
    assert.equal((await req(pc, 'PUT', `/api/world/budgets/${acc.id}`, ana, { capDracmas: '300' })).status, 200);
    const r = (await req(pc, 'GET', '/api/world/activity', ana)).json;
    assert.equal(r.available, true); assert.equal(r.allowed, true);
    assert.equal(r.entries[0].action, 'budget.set');
    assert.equal(r.entries[0].actor.name, 'Ana');
    // quem não administra: permitido = false, sem erro na tela
    world.roles.set(acc.id, 'editor');
    assert.deepEqual((await req(pc, 'GET', '/api/world/activity', ana)).json, { available: true, allowed: false, entries: [] });
    world.roles.delete(acc.id);
    // Sync: ligado e enviado, a última sincronia vem com a hora
    assert.equal((await req(pc, 'POST', '/api/world/sync/enable', ana, {})).status, 200);
    assert.equal((await req(pc, 'POST', '/api/world/sync/push', ana)).status, 200);
    const st = (await req(pc, 'GET', '/api/world/sync', ana)).json;
    assert.equal(st.enabled, true);
    assert.ok(typeof st.lastSyncAt === 'string' && st.lastSyncAt.length > 0);
  });
});
