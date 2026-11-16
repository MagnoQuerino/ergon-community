/**
 * Workspace World criado do lado do servidor, antes de qualquer computador (primeiro checkout do site; "Criar workspace
 * e conceder" do painel interno): o aplicativo adota pelo bind e, como ninguém tem a chave ainda, quem é dono (ou admin)
 * liga a sincronia num clique: a chave nasce aqui e o primeiro envelope vai ao World, como num workspace criado por este
 * computador. Onde a chave já existe, nada muda: espera a entrega de quem a tem. Quem não administra não cria a chave.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('World Sync num workspace criado no servidor', () => {
  let world: FakeWorld; const abertos: Harness[] = [];
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; for (const h of abertos) await h.close(); await world.stop(); });
  const accOf = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;
  const devOf = async (h: Harness, s: Session) => (await req(h, 'GET', '/api/world/status', s)).json.link.deviceId as string;
  const tarefas = (h: Harness, ws: string) => h.db.all<{ title: string }>('SELECT title FROM tasks WHERE workspace_id = ?', ws).map((r) => r.title);
  const pc = async (user: string, email: string, mode: 'signup' | 'login') => {
    const h = await harness(); abertos.push(h); const s = await setupOwner(h, user, `senha-de-${user}-123`);
    const r = await req(h, 'POST', '/api/world/connect', s, { mode, email, password: 'senha-do-world-123', displayName: user });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { h, s };
  };

  let ana1: { h: Harness; s: Session }; let sws = '';
  test('a dona liga o workspace da cortesia: a chave nasce aqui, o primeiro envelope vai ao World e as mudanças sincronizam', async () => {
    ana1 = await pc('ana', 'ana@exemplo.test', 'signup');
    sws = world.serverWorkspace(accOf('ana@exemplo.test'), { source: 'cortesia' });
    await req(ana1.h, 'POST', '/api/world/refresh', ana1.s);
    assert.ok((await req(ana1.h, 'GET', '/api/world/status', ana1.s)).json.link.workspaces.some((w: { workspaceId: string }) => w.workspaceId === sws), 'aparece na lista da conta');
    assert.equal((await req(ana1.h, 'POST', '/api/world/bind', ana1.s, { syncWorkspaceId: sws })).status, 200);
    const s0 = (await req(ana1.h, 'GET', '/api/world/sync', ana1.s)).json;
    assert.deepEqual([s0.enabled, s0.origin, s0.syncWorkspaceId, s0.keyState], [false, 'joined', sws, 'first'], 'a tela oferece ligar, sem esperar chave');
    assert.equal(world.workspaces.get(sws)!.envelopes.size, 0);

    const en = await req(ana1.h, 'POST', '/api/world/sync/enable', ana1.s, {});
    assert.equal(en.status, 200, JSON.stringify(en.json));
    assert.deepEqual([en.json.enabled, en.json.syncWorkspaceId, en.json.keyVersion], [true, sws, 1]);
    const w = world.workspaces.get(sws)!;
    assert.deepEqual([...w.envelopes.keys()], [await devOf(ana1.h, ana1.s)], 'o primeiro envelope, para este aparelho');
    assert.equal(w.envelopes.get(await devOf(ana1.h, ana1.s))!.keyVersion, 1);
    assert.equal([...world.workspaces.values()].filter((x) => x.owner === accOf('ana@exemplo.test')).length, 1, 'nenhum workspace World a mais');

    assert.equal((await req(ana1.h, 'POST', '/api/tasks', ana1.s, { title: 'Plantar as sementes da cortesia' })).status, 201);
    const p = await req(ana1.h, 'POST', '/api/world/sync/push', ana1.s, {});
    assert.equal(p.status, 200, JSON.stringify(p.json)); assert.ok(p.json.sent.tasks >= 1);
    assert.ok(!JSON.stringify(w.changes).includes('sementes'), 'o World guarda sem ler');

    // outro computador da Ana: a chave agora existe, então espera a entrega (o caminho de sempre) e recebe as mudanças
    const ana2 = await pc('ana-notebook', 'ana@exemplo.test', 'login');
    assert.equal((await req(ana2.h, 'POST', '/api/world/bind', ana2.s, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(ana2.h, 'GET', '/api/world/sync', ana2.s)).json.keyState, 'handover');
    assert.equal((await req(ana2.h, 'POST', '/api/world/sync/enable', ana2.s, {})).json.error, 'sync_join', 'não gera uma segunda chave');
    assert.equal((await req(ana1.h, 'POST', '/api/world/sync/share', ana1.s, {})).json.shared, 1);
    assert.equal((await req(ana2.h, 'GET', '/api/world/sync', ana2.s)).json.keyState, 'mine');
    assert.equal((await req(ana2.h, 'POST', '/api/world/sync/enable', ana2.s, {})).status, 200, 'com a chave entregue, "Ligar" entra direto');
    assert.equal((await req(ana2.h, 'POST', '/api/world/sync/pull', ana2.s, { apply: true })).json.applied, true);
    assert.ok(tarefas(ana2.h, ana2.s.workspaceId).includes('Plantar as sementes da cortesia'));
    await req(ana2.h, 'POST', '/api/world/unlink', ana2.s, {});
  });

  test('primeiro checkout do site: "Entrar" (o botão antigo) também cria a chave num clique', async () => {
    const caio = await pc('caio', 'caio@exemplo.test', 'signup');
    const ws = world.serverWorkspace(accOf('caio@exemplo.test'), { plan: 'world_pro' });
    assert.equal((await req(caio.h, 'POST', '/api/world/bind', caio.s, { syncWorkspaceId: ws })).status, 200);
    const j = await req(caio.h, 'POST', '/api/world/sync/join', caio.s, { recoveryPhrase: 'uma frase de recuperação longa o bastante' });
    assert.equal(j.status, 200, JSON.stringify(j.json)); assert.equal(j.json.enabled, true);
    const w = world.workspaces.get(ws)!;
    assert.equal(w.envelopes.size, 1); assert.equal(w.recovery?.keyVersion, 1, 'com a frase, o envelope de recuperação também');
    assert.equal((await req(caio.h, 'POST', '/api/tasks', caio.s, { title: 'Primeira tarefa paga' })).status, 201);
    assert.equal((await req(caio.h, 'POST', '/api/world/sync/push', caio.s, {})).status, 200);
  });

  test('outro computador da dona que ligou sem enviar nada e sem frase: a chave existe, então espera a entrega', async () => {
    const d1 = await pc('dani', 'dani@exemplo.test', 'signup');
    const ws = world.serverWorkspace(accOf('dani@exemplo.test'), { source: 'cortesia' });
    await req(d1.h, 'POST', '/api/world/bind', d1.s, { syncWorkspaceId: ws });
    assert.equal((await req(d1.h, 'POST', '/api/world/sync/enable', d1.s, {})).status, 200);
    const antes = world.workspaces.get(ws)!.envelopes.get(await devOf(d1.h, d1.s))!.wrapped;
    const d2 = await pc('dani-notebook', 'dani@exemplo.test', 'login');
    await req(d2.h, 'POST', '/api/world/bind', d2.s, { syncWorkspaceId: ws });
    assert.equal(world.workspaces.get(ws)!.head, 0, 'nada enviado ainda');
    assert.equal((await req(d2.h, 'GET', '/api/world/sync', d2.s)).json.keyState, 'handover');
    assert.equal((await req(d2.h, 'POST', '/api/world/sync/enable', d2.s, {})).json.error, 'sync_join');
    assert.equal((await req(d2.h, 'POST', '/api/world/sync/join', d2.s, {})).status, 404);
    const w = world.workspaces.get(ws)!;
    assert.equal(w.envelopes.size, 1, 'nenhuma segunda chave'); assert.equal(w.envelopes.get(await devOf(d1.h, d1.s))!.wrapped, antes);
  });

  test('membro que entra num workspace com envelopes espera a entrega; quem não administra não cria a primeira chave', async () => {
    const bia = await pc('bia', 'bia@exemplo.test', 'signup'); const biaAcc = accOf('bia@exemplo.test');
    // no workspace da Ana, que já tem chave: a Bia (editora) espera a entrega
    world.workspaces.get(sws)!.members = new Map([[biaAcc, { role: 'editor', since: new Date().toISOString() }]]);
    assert.equal((await req(bia.h, 'POST', '/api/world/bind', bia.s, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(bia.h, 'GET', '/api/world/sync', bia.s)).json.keyState, 'handover');
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/enable', bia.s, {})).json.error, 'sync_join');
    assert.ok(!world.workspaces.get(sws)!.envelopes.has(await devOf(bia.h, bia.s)), 'a Bia não grava chave nenhuma');
    assert.equal((await req(ana1.h, 'POST', '/api/world/sync/share', ana1.s, {})).json.shared, 1, 'a dona entrega');
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/join', bia.s, {})).status, 200);
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/pull', bia.s, { apply: true })).json.applied, true);
    assert.ok(tarefas(bia.h, bia.s.workspaceId).includes('Plantar as sementes da cortesia'));

    // outro workspace criado no servidor para a Ana, ainda sem chave: a Bia, editora, não cria a primeira
    assert.equal((await req(bia.h, 'DELETE', '/api/world/bind', bia.s)).status, 200);
    const novo = world.serverWorkspace(accOf('ana@exemplo.test'), { source: 'cortesia', label: 'Ateliê' });
    const w = world.workspaces.get(novo)!;
    w.members = new Map([[biaAcc, { role: 'editor', since: new Date().toISOString() }]]);
    assert.equal((await req(bia.h, 'POST', '/api/world/bind', bia.s, { syncWorkspaceId: novo })).status, 200);
    assert.equal((await req(bia.h, 'GET', '/api/world/sync', bia.s)).json.keyState, 'handover');
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/enable', bia.s, {})).json.error, 'sync_join');
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/join', bia.s, {})).status, 404);
    assert.equal(w.envelopes.size, 0, 'nenhum envelope criado por quem não administra');
    assert.equal((await req(bia.h, 'GET', '/api/world/sync', bia.s)).json.enabled, false);

    // como admin, pode: a chave nasce no computador dela
    w.members.set(biaAcc, { role: 'admin', since: new Date().toISOString() });
    assert.equal((await req(bia.h, 'GET', '/api/world/sync', bia.s)).json.keyState, 'first');
    assert.equal((await req(bia.h, 'POST', '/api/world/sync/enable', bia.s, {})).status, 200);
    assert.deepEqual([...w.envelopes.keys()], [await devOf(bia.h, bia.s)]);
  });
});
