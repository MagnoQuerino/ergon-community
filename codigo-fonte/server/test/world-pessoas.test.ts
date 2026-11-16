/**
 * Pessoas no Ergon World: o aplicativo local passa adiante, com a sessão de quem pede e só no workspace ligado, os
 * pedidos de pessoas do World (convidar, aceitar, papel, tirar, cancelar convite, transferir a titularidade) e o
 * carrinho do plano. As regras são as do World (world/src/sync.ts), repetidas no World de mentira (fake-world.ts).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('Pessoas no World: convite, papéis, saída e titularidade', () => {
  let world: FakeWorld; let pc1: Harness; let ana: Session; let pc2: Harness; let bia: Session; let sws = ''; let biaAcc = ''; let anaAcc = '';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc1?.close(); await pc2?.close(); await world.stop(); });
  const accOf = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;
  const convidar = async (role: string) => req(pc1, 'POST', '/api/world/members/invites', ana, { role });

  test('sem workspace ligado: lista vazia e nada sai do aparelho', async () => {
    pc1 = await harness(); ana = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
    assert.equal((await req(pc1, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    const antes = world.calls(`/v1/sync/workspaces`);
    const r = await req(pc1, 'GET', '/api/world/members', ana);
    assert.deepEqual(r.json, { myRole: null, seats: 0, members: [], invites: [], awaitingKey: [] });
    assert.equal(world.calls('/v1/sync/workspaces'), antes);
    assert.equal((await convidar('editor')).status, 409, 'convidar pede o workspace ligado');
  });

  test('a dona convida com um papel; o código entra na conta de quem aceita, que liga um workspace dela e recebe a chave', async () => {
    sws = (await req(pc1, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
    assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', ana, {})).status, 200);
    world.activate(sws, 'world_team', 8);
    anaAcc = accOf('ana@exemplo.test');
    const m0 = (await req(pc1, 'GET', '/api/world/members', ana)).json;
    assert.equal(m0.myRole, 'owner'); assert.equal(m0.seats, 8); assert.equal(m0.members.length, 1); assert.equal(m0.members[0].me, true);

    assert.equal((await convidar('owner')).status, 400, 'dono não se convida');
    const inv = await convidar('editor');
    assert.equal(inv.status, 200); assert.match(inv.json.token, /^[A-Za-z0-9_-]{30,}$/);
    assert.equal((await req(pc1, 'GET', '/api/world/members', ana)).json.invites.length, 1, 'o convite pendente aparece (e ocupa vaga)');

    pc2 = await harness(); bia = await setupOwner(pc2, 'bia', 'senha-da-bia-123');
    assert.equal((await req(pc2, 'POST', '/api/world/connect', bia, { mode: 'signup', email: 'bia@exemplo.test', password: 'senha-do-world-456', displayName: 'Bia' })).status, 200);
    biaAcc = accOf('bia@exemplo.test');
    assert.equal((await req(pc2, 'POST', '/api/world/invites/accept', bia, { token: 'x' })).status, 400, 'código mal formado nem sai daqui');
    assert.equal((await req(pc2, 'POST', '/api/world/invites/accept', bia, { token: 'A'.repeat(32) })).status, 404, 'código que não existe');
    const ok = await req(pc2, 'POST', '/api/world/invites/accept', bia, { token: inv.json.token });
    assert.deepEqual(ok.json, { workspaceId: sws, role: 'editor' });
    assert.equal((await req(pc2, 'POST', '/api/world/invites/accept', bia, { token: inv.json.token })).status, 404, 'convite usado não vale de novo');
    const st = (await req(pc2, 'GET', '/api/world/status', bia)).json;
    assert.ok(st.link.workspaces.some((w: { workspaceId: string; role: string }) => w.workspaceId === sws && w.role === 'editor'), 'o workspace aparece na lista do World da Bia');

    assert.equal((await req(pc2, 'POST', '/api/world/bind', bia, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(pc2, 'GET', '/api/world/sync', bia)).json.origin, 'joined');
    const m1 = (await req(pc1, 'GET', '/api/world/members', ana)).json;
    assert.equal(m1.members.length, 2); assert.equal(m1.invites.length, 0);
    assert.deepEqual(m1.awaitingKey, [biaAcc], 'a Bia espera a chave');
    assert.equal((await req(pc1, 'POST', '/api/world/sync/share', ana, {})).json.shared, 1, 'a dona entrega a chave ao computador da Bia');
    assert.deepEqual((await req(pc1, 'GET', '/api/world/members', ana)).json.awaitingKey, []);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/join', bia, {})).status, 200, 'a Bia entra na sincronização sem frase');
  });

  test('papéis: quem edita vê a lista sem e-mails e não administra; a dona troca o papel, mas não o dela', async () => {
    const vb = (await req(pc2, 'GET', '/api/world/members', bia)).json;
    assert.equal(vb.myRole, 'editor'); assert.deepEqual(vb.invites, []);
    assert.equal(vb.members.find((m: { me: boolean }) => !m.me).email, null, 'e-mail dos outros só para quem administra');
    assert.equal((await req(pc2, 'POST', '/api/world/members/invites', bia, { role: 'viewer' })).status, 403);
    assert.equal((await req(pc2, 'PUT', `/api/world/members/${anaAcc}/role`, bia, { role: 'viewer' })).status, 403, 'quem edita não troca papel');
    assert.equal((await req(pc2, 'DELETE', `/api/world/members/${anaAcc}`, bia)).status, 403);
    assert.equal((await req(pc1, 'PUT', `/api/world/members/${biaAcc}/role`, ana, { role: 'chefe' })).status, 400);
    assert.equal((await req(pc1, 'PUT', '/api/world/members/acc_nada/role', ana, { role: 'viewer' })).status, 400);
    assert.equal((await req(pc1, 'PUT', `/api/world/members/${biaAcc}/role`, ana, { role: 'viewer' })).status, 200);
    assert.equal((await req(pc1, 'GET', '/api/world/members', ana)).json.members.find((m: { accountId: string }) => m.accountId === biaAcc).role, 'viewer');
    assert.equal((await req(pc1, 'PUT', `/api/world/members/${anaAcc}/role`, ana, { role: 'admin' })).status, 409);
  });

  test('vagas: convite pendente ocupa vaga; sem vaga, o World recusa; cancelar libera', async () => {
    world.workspaces.get(sws)!.seats = 3;
    const inv = await convidar('viewer');
    assert.equal(inv.status, 200);
    const sem = await convidar('viewer');
    assert.equal(sem.status, 409); assert.equal(sem.json.error, 'seats');
    const pend = (await req(pc1, 'GET', '/api/world/members', ana)).json.invites;
    assert.equal(pend.length, 1);
    assert.equal((await req(pc1, 'DELETE', '/api/world/members/invites/x', ana)).status, 400);
    assert.equal((await req(pc1, 'DELETE', `/api/world/members/invites/${pend[0].id}`, ana)).status, 200);
    assert.equal((await req(pc1, 'GET', '/api/world/members', ana)).json.invites.length, 0);
    assert.equal((await convidar('viewer')).status, 200, 'a vaga voltou');
    world.workspaces.get(sws)!.invites = [];
    world.workspaces.get(sws)!.seats = 8;
  });

  test('tirar alguém: o acesso dele cai na hora e o World pede para girar a chave antes de novos envios', async () => {
    const r = await req(pc1, 'DELETE', `/api/world/members/${biaAcc}`, ana);
    assert.deepEqual(r.json, { ok: true, rotationRequired: true });
    assert.equal((await req(pc2, 'GET', '/api/world/members', bia)).status, 404, 'a Bia não vê mais o workspace');
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', bia, {})).status, 404);
    assert.equal((await req(pc1, 'POST', '/api/agents', ana, { name: 'Sam', role: 'Jardinagem' })).status, 201);
    const push = await req(pc1, 'POST', '/api/world/sync/push', ana, {});
    assert.equal(push.status, 409); assert.equal(push.json.error, 'rotation_required');
  });

  test('carrinho: plano, pessoas e Jobs num checkout só; com assinatura, prévia e confirmação; recarga à parte', async () => {
    // a Bia, fora do workspace da Ana, liga um workspace novo dela (sem assinatura)
    assert.equal((await req(pc2, 'DELETE', '/api/world/bind', bia)).status, 200);
    const meu = (await req(pc2, 'POST', '/api/world/bind', bia, {})).json.syncWorkspaceId as string;
    assert.equal((await req(pc2, 'POST', '/api/world/billing/checkout', bia, { sku: 'world_pro', seats: 2, jobPacks: 1, idempotencyKey: 'carrinho-1' })).status, 200);
    assert.deepEqual(world.checkouts.at(-1), { ws: meu, items: [{ sku: 'world_pro', quantity: 1 }, { sku: 'addon_seat_pro', quantity: 2 }, { sku: 'addon_jobs_5', quantity: 1 }] });
    assert.equal((await req(pc2, 'POST', '/api/world/billing/checkout', bia, { sku: 'world_pro', seats: -1, idempotencyKey: 'carrinho-2' })).status, 400);
    assert.equal((await req(pc2, 'POST', '/api/world/billing/checkout', bia, { sku: 'world_pro_annual', seats: 1, jobPacks: 2, idempotencyKey: 'carrinho-anual' })).status, 200);
    assert.deepEqual(world.checkouts.at(-1)!.items, [{ sku: 'world_pro_annual', quantity: 1 }, { sku: 'addon_seat_pro_annual', quantity: 1 }, { sku: 'addon_jobs_5_annual', quantity: 2 }], 'no anual, os adicionais são anuais');
    assert.equal((await req(pc2, 'POST', '/api/world/billing/checkout', bia, { sku: 'topup_1000', seats: 1, idempotencyKey: 'carrinho-3' })).status, 400, 'pessoas e Jobs vão junto de um plano');
    assert.equal((await req(pc2, 'POST', '/api/world/billing/checkout', bia, { sku: 'topup_1000', idempotencyKey: 'carrinho-4' })).status, 200, 'recarga: pagamento à parte');
    // a Ana já assina: prévia e confirmação
    assert.equal((await req(pc1, 'POST', '/api/world/billing/checkout', ana, { sku: 'world_pro', idempotencyKey: 'carrinho-5' })).json.error, 'has_subscription');
    const pv = (await req(pc1, 'POST', '/api/world/billing/change/preview', ana, { seats: 2, jobPacks: 1 })).json;
    assert.equal(pv.upgrade, true); assert.equal(pv.amountDueCents, '2490');
    assert.equal((await req(pc1, 'POST', '/api/world/billing/change/confirm', ana, { seats: 2, jobPacks: 1, prorationDate: pv.prorationDate, idempotencyKey: 'mudanca-1' })).status, 200);
    assert.equal((await req(pc1, 'GET', '/api/world/members', ana)).json.seats, 5, 'as vagas compradas entram no plano');
  });

  test('transferir a titularidade: só a dona, para quem já é membro; ela passa a administrar', async () => {
    const inv = await convidar('admin');
    assert.equal((await req(pc2, 'POST', '/api/world/invites/accept', bia, { token: inv.json.token })).status, 200);
    assert.equal((await req(pc1, 'POST', '/api/world/members/transfer', ana, { toAccountId: 'acc_x' })).status, 400);
    assert.equal((await req(pc1, 'POST', '/api/world/members/transfer', ana, { toAccountId: biaAcc })).status, 200);
    const m = (await req(pc1, 'GET', '/api/world/members', ana)).json;
    assert.equal(m.myRole, 'admin');
    assert.equal(m.members.find((x: { accountId: string }) => x.accountId === biaAcc).role, 'owner');
    assert.equal((await req(pc1, 'POST', '/api/world/members/transfer', ana, { toAccountId: biaAcc })).status, 403, 'quem não é mais dona não transfere');
  });
});
