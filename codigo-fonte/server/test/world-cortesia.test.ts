/**
 * Plano cortesia (World: entitlement.source / workspaces[].source = 'cortesia'): ativo, sem assinatura paga. O aplicativo
 * passa o campo adiante (estado do plano e lista de workspaces da conta) e recusa o que só vale para plano pago: o portal
 * de pagamento, cancelar e trocar o período (mensal/anual). Subir de plano continua. O extrato traz 'cortesia'.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('Plano cortesia do Ergon World', () => {
  let world: FakeWorld; let pc: Harness; let ana: Session; let sws = '';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc?.close(); await world.stop(); });

  test('o plano pago vem como stripe; a cortesia aparece no estado, na lista de workspaces e no extrato', async () => {
    pc = await harness(); ana = await setupOwner(pc, 'ana', 'senha-da-ana-123');
    assert.equal((await req(pc, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    sws = (await req(pc, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
    world.activate(sws, 'world_pro');
    assert.equal((await req(pc, 'GET', '/api/world/billing', ana)).json.entitlement.source, 'stripe');
    world.cortesia(sws, 'world_pro', '500.000000');
    const b = (await req(pc, 'GET', '/api/world/billing', ana)).json;
    assert.deepEqual([b.entitlement.status, b.entitlement.source, b.subscription], ['active', 'cortesia', null]);
    await req(pc, 'POST', '/api/world/refresh', ana);
    const ws = (await req(pc, 'GET', '/api/world/status', ana)).json.link.workspaces as Array<{ workspaceId: string; source: string }>;
    assert.equal(ws.find((w) => w.workspaceId === sws)!.source, 'cortesia');
    const ext = (await req(pc, 'GET', '/api/world/wallet/statement', ana)).json.entries as Array<{ kind: string; delta: string }>;
    assert.deepEqual(ext.map((x) => [x.kind, x.delta]), [['cortesia', '500.000000']]);
  });

  test('cortesia: sem portal, sem cancelar e sem trocar o período; subir de plano continua', async () => {
    const antes = world.log.length;
    for (const [url, body] of [['/api/world/billing/portal', {}], ['/api/world/billing/cancel', { idempotencyKey: 'cancelar-1' }],
      ['/api/world/billing/change/preview', { plan: 'world_pro_annual' }]] as const) {
      const r = await req(pc, 'POST', url, ana, body);
      assert.deepEqual([r.status, r.json.error], [409, 'cortesia'], url);
    }
    assert.ok(!world.log.slice(antes).some((l) => /portal|cancel|change/.test(l.path)), 'nada disso chega ao World');
    // sem assinatura, subir de plano pelo carrinho é um checkout (o plano pago passa a valer no lugar da cortesia)
    const up = await req(pc, 'POST', '/api/world/billing/checkout', ana, { sku: 'world_team', seats: 1, idempotencyKey: 'subir-1' });
    assert.equal(up.status, 200, 'subir de plano pelo carrinho continua');
    assert.deepEqual(world.checkouts.at(-1)!.items.map((i) => i.sku), ['world_team', 'addon_seat_team']);
  });
});
