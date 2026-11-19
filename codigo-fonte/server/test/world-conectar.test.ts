/**
 * Conectar um workspace ao Ergon World já liga a sincronia (sem outro clique), e um workspace que está só no World
 * (apagado num computador antigo, por exemplo) pode ser apagado de lá pela lista "No Ergon World e ainda não neste
 * computador": o World o desativa e ele some da lista na hora.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness } from './helpers.ts';

describe('Conectar ao Ergon World', () => {
  let world: FakeWorld; const abertos: Harness[] = [];
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; for (const h of abertos) await h.close(); await world.stop(); });
  const accOf = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;

  test('conectar liga a sincronia; apagar do World tira o workspace da lista para baixar', async () => {
    const h = await harness(); abertos.push(h); const s = await setupOwner(h, 'eva', 'senha-de-eva-123');
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email: 'eva@exemplo.test', password: 'senha-do-world-123', displayName: 'Eva' })).status, 200);
    const b = await req(h, 'POST', '/api/world/bind', s, {});
    assert.equal(b.status, 200, JSON.stringify(b.json)); assert.equal(b.json.syncEnabled, true);
    assert.equal((await req(h, 'GET', '/api/world/sync', s)).json.enabled, true, 'sincronizando sem outro clique');

    // um workspace dela que está só no World
    const velho = world.serverWorkspace(accOf('eva@exemplo.test'), { source: 'cortesia', label: 'Antigo' });
    await req(h, 'POST', '/api/world/refresh', s);
    const lista = async () => ((await req(h, 'GET', '/api/world/status', s)).json.link.workspaces as Array<{ workspaceId: string }>).map((w) => w.workspaceId);
    assert.ok((await lista()).includes(velho));
    const r = await req(h, 'POST', '/api/world/remote/remove', s, { syncWorkspaceId: velho });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(world.deactivated.has(velho), 'o World desativa');
    assert.ok(!(await lista()).includes(velho), 'some da lista na hora, sem esperar a renovação');
    // o que está neste computador não se apaga por aqui
    const aqui = (await req(h, 'GET', '/api/world/sync', s)).json.syncWorkspaceId as string;
    assert.equal((await req(h, 'POST', '/api/world/remote/remove', s, { syncWorkspaceId: aqui })).status, 409);
  });
});
