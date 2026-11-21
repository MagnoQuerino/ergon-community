/**
 * A nuvem ligada AGORA pelo computador (teste grátis, rc.41): a chave chega segundos depois de o contêiner pedir, sem
 * esperar o ciclo de um minuto e sem ninguém olhar o cartão da nuvem. O caso do laboratório integrado: a primeira volta
 * do ciclo tinha visto "sem nuvem" (vale 1 min), o teste começou logo depois, e a chave só saiu na volta seguinte.
 * Aqui o ciclo fica a 10 min: quem entrega é a conferência de perto, armada pela resposta do próprio teste grátis.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc: Harness; let ana: Session; let sws = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_AUTOSYNC_MS', 'ERGON_WORLD_ENTREGA_MS', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const der = (k: crypto.KeyObject, pub: boolean) => k.export({ format: 'der', type: pub ? 'spki' : 'pkcs8' }).toString('base64');

before(async () => {
  world = await new FakeWorld().start();
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC_MS: '600000', ERGON_WORLD_ENTREGA_MS: '60' });
  delete process.env.ERGON_WORLD_AUTOSYNC;
});
after(async () => {
  await pc?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('teste grátis começado pelo computador: o contêiner pede a chave e recebe em segundos, sem o ciclo', async () => {
  pc = await harness();
  ana = await setupOwner(pc, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc, 'POST', '/api/world/sync/enable', ana, {})).status, 200);
  world.activate(sws, 'world_pro', 3);
  await pc.app.ready();
  await pausa(5600); // a primeira volta do ciclo (aos 5 s) vê o workspace sem a nuvem
  const t = await req(pc, 'POST', '/api/world/cloud/trial', ana, {});
  assert.deepEqual([t.status, t.json.active, t.json.runtime, t.json.appState], [200, true, 'parado', null], JSON.stringify(t.json));
  // o orquestrador sobe o contêiner: aparelho-nuvem, prova de posse e o pedido da chave (world/nuvem.ts)
  await pausa(400);
  const cl = world.clouds.get(sws)!;
  const ed = crypto.generateKeyPairSync('ed25519'); const x = crypto.generateKeyPairSync('x25519');
  const post = async (p: string, b: unknown) => (await fetch(`${world.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<any>;
  const reg = await post('/v1/cloud/boot', { bootToken: cl.bootToken, installationId: crypto.randomBytes(16).toString('hex'), publicKey: der(ed.publicKey, true), syncPublicKey: der(x.publicKey, true) });
  await post('/v1/devices/confirm', { deviceId: reg.deviceId, signature: crypto.sign(null, Buffer.from(reg.challenge), ed.privateKey).toString('base64') });
  await post('/v1/cloud/boot/state', { bootToken: cl.bootToken, state: 'aguardando_chave', detail: 'Abra o Ergon no seu computador uma vez.' });
  const t0 = Date.now();
  while (!world.workspaces.get(sws)!.envelopes.get(reg.deviceId) && Date.now() - t0 < 4000) await pausa(25);
  assert.ok(world.workspaces.get(sws)!.envelopes.get(reg.deviceId), 'a nuvem ficou esperando a chave (só o ciclo de 10 min a entregaria)');
  assert.ok(Date.now() - t0 < 3000, `levou ${Date.now() - t0} ms`);
  assert.equal(cl.presence.length, 0, 'foi a conferência de perto, não uma volta do ciclo');
});
