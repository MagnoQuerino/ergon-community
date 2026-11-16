/**
 * Primeiro acesso com a conta do Ergon World ("Já tenho conta Ergon World"): o World confere e-mail e senha ANTES de
 * existir a conta deste computador (senha errada não deixa conta local pela metade); depois a conta local nasce com a
 * mesma senha, o aparelho entra na conta do World e só faltam os detalhes daqui (a frase e a IA).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, sessionFrom, setupOwner, type Harness } from './helpers.ts';

describe('Primeiro acesso com a conta do Ergon World', () => {
  let world: FakeWorld; let pc1: Harness; let pc2: Harness;
  const SENHA = 'lua cheia sobre o farol de alexandria';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc1?.close(); await pc2?.close(); await world.stop(); });

  test('a conta do World é conferida antes; a conta local nasce com a mesma senha e o aparelho entra no World', async () => {
    // a conta do World já existe (criada em outro computador)
    pc1 = await harness(); const a1 = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
    assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'ana@exemplo.test', password: SENHA, displayName: 'Ana' })).status, 200);

    pc2 = await harness();
    assert.equal((await req(pc2, 'GET', '/api/auth/state')).json.needsSetup, true);
    const errada = await req(pc2, 'POST', '/api/world/setup/check', null, { email: 'ana@exemplo.test', password: 'senha-errada-123' });
    assert.deepEqual([errada.status, errada.json.error], [400, 'invalid_credentials']);
    assert.equal((await req(pc2, 'POST', '/api/world/setup/check', null, { email: 'nao-e-email', password: SENHA })).status, 400);
    assert.equal((await req(pc2, 'GET', '/api/auth/state')).json.needsSetup, true, 'nada foi criado aqui');

    const ok = await req(pc2, 'POST', '/api/world/setup/check', null, { email: 'ana@exemplo.test', password: SENHA });
    assert.deepEqual([ok.status, ok.json.ok], [200, true]);
    const r = await req(pc2, 'POST', '/api/auth/setup', null, { username: 'ana', password: SENHA, displayName: 'ana' });
    assert.equal(r.status, 200); assert.ok(r.json.recovery, 'a frase de recuperação vem em seguida');
    const s = await sessionFrom(pc2, r.res.headers['set-cookie']);
    assert.equal((await req(pc2, 'POST', '/api/world/connect', s, { mode: 'login', email: 'ana@exemplo.test', password: SENHA })).status, 200);
    const st = (await req(pc2, 'GET', '/api/world/status', s)).json;
    assert.equal(st.link.accountEmail, 'ana@exemplo.test');
    assert.equal([...world.devices.values()].filter((d) => d.accountId === [...world.accounts.values()].find((x) => x.email === 'ana@exemplo.test')!.id).length, 2, 'o segundo aparelho da Ana');
    // depois de criada a conta local, a conferência não vale mais
    assert.equal((await req(pc2, 'POST', '/api/world/setup/check', null, { email: 'ana@exemplo.test', password: SENHA })).status, 409);
  });
});
