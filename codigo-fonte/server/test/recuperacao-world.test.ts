/**
 * Recuperação pela senha do Ergon World (rc.42), no lugar da frase ou junto dela:
 * (a) os dados locais: a chave pessoal embrulhada por Argon2id(rótulo ‖ senha do World, sal próprio), só no keyring
 *     deste computador — o World confere a senha no login de sempre e nunca recebe o embrulho;
 * (b) a chave do workspace no World Sync: envelope de recuperação pela senha do World (este, sim, guardado no World).
 * Senha do World trocada: refeita quando o World aceita a nova aqui; trocada fora daqui, o embrulho deixa de valer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { buildGate } from '../src/gate.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { throttle } from '../src/security/factors.ts';
import { Vault, worldLocalSecret } from '../src/security/keys.ts';
import { newWorkspaceKey, recoveryKindOf, unwrapForRecovery, unwrapForRecoveryWorld, wrapForRecovery, wrapForRecoveryWorld } from '../src/world/sync-crypto.ts';
import { WorldClient } from '../src/world/link.ts';
import { FakeWorld } from './fake-world.ts';
import { ORIGIN, harness, req, sessionFrom, setupOwner, testConfig, type Harness, type Session } from './helpers.ts';

const SENHA_ERGON = 'senha-da-ana-no-ergon-123';
const SENHA_WORLD = 'lua cheia sobre o farol de alexandria';
const EMAIL = 'ana@exemplo.test';
const WS = `sws_${'c'.repeat(32)}`;

/** O keyring deste computador (o embrulho do World fica aqui, e só aqui). */
const keyringOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8')) as { people: Record<string, { wraps: Array<{ type: string; salt?: string; blob: string; email?: string; stale?: boolean }> }> };
const worldWrap = (dir: string, userId: string) => keyringOf(dir).people[userId].wraps.find((w) => w.type === 'world');

describe('cifra da recuperação pela senha do World', () => {
  test('(a) embrulho local: só a senha certa abre; sal e derivação próprios, diferentes da senha do Ergon', async () => {
    const h = await harness(); const s = await setupOwner(h, 'ana', SENHA_ERGON);
    const v = h.vault;
    await v.setPersonWorld(s.userId, EMAIL, SENHA_WORLD);
    const w = worldWrap(h.dir, s.userId)!;
    const pw = keyringOf(h.dir).people[s.userId].wraps.find((x) => x.type === 'password')!;
    assert.ok(w.salt && w.salt !== pw.salt, 'sal próprio');
    assert.equal(w.email, EMAIL);
    const scope = `person/${s.userId}`;
    const asWrap = w as unknown as Parameters<typeof v.keyring.openSecret>[0];
    assert.ok(await v.keyring.openSecret(asWrap, worldLocalSecret(SENHA_WORLD), scope), 'a senha do World (com o rótulo) abre');
    assert.equal(await v.keyring.openSecret(asWrap, SENHA_WORLD, scope), null, 'a senha crua (a derivação de outra coisa) não abre');
    assert.equal(await v.keyring.openSecret(asWrap, worldLocalSecret('outra senha qualquer 123'), scope), null, 'senha errada não abre');
    assert.equal(await v.keyring.openSecret(asWrap, worldLocalSecret(SENHA_WORLD), 'person/usr_outra'), null, 'amarrado à pessoa');
    assert.equal(await v.openPersonWorld(s.userId, 'outra senha qualquer 123'), false);
    assert.equal(await v.openPersonWorld(s.userId, SENHA_WORLD), true);
    await h.close();
  });

  test('(b) envelope do Sync: só a senha certa, o workspace e a versão; separado da frase e de parâmetros adulterados', async () => {
    const dek = newWorkspaceKey();
    const w = await wrapForRecoveryWorld(dek, SENHA_WORLD, WS, 3, KDF_TEST);
    assert.equal(recoveryKindOf(w), 'world'); assert.equal(recoveryKindOf(wrapForRecovery(dek, 'uma frase comprida de teste', WS, 3)), 'phrase');
    assert.ok(!w.includes(dek.toString('base64')));
    assert.deepEqual(await unwrapForRecoveryWorld(w, SENHA_WORLD, WS, 3), dek);
    await assert.rejects(unwrapForRecoveryWorld(w, 'outra senha qualquer 123', WS, 3), 'senha errada');
    await assert.rejects(unwrapForRecoveryWorld(w, SENHA_WORLD, `sws_${'d'.repeat(32)}`, 3), 'outro workspace');
    await assert.rejects(unwrapForRecoveryWorld(w, SENHA_WORLD, WS, 4), 'outra versão da chave');
    assert.throws(() => unwrapForRecovery(w, SENHA_WORLD, WS, 3), 'a mesma senha pela derivação da frase não abre');
    const pesado = JSON.stringify({ ...JSON.parse(w), kdf: { ...KDF_TEST, memoryKiB: 64 * 1024 * 1024 } });
    await assert.rejects(unwrapForRecoveryWorld(pesado, SENHA_WORLD, WS, 3), /formato/, 'parâmetros fora dos limites');
    assert.notEqual(await wrapForRecoveryWorld(dek, SENHA_WORLD, WS, 3, KDF_TEST), w, 'sal novo a cada envelope');
  });
});

describe('recuperar os dados locais pela senha do World (pelas rotas, com o World de mentira)', () => {
  let world: FakeWorld; let h: Harness; let s: Session;
  /** tudo o que foi ao World (corpo de cada pedido): o embrulho local nunca pode aparecer aqui */
  const foiAoWorld: string[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.startsWith(world.url)) foiAoWorld.push(`${u} ${typeof init?.body === 'string' ? init.body : ''}`);
      return realFetch(input, init);
    }) as typeof fetch;
    h = await harness(); s = await setupOwner(h, 'ana', SENHA_ERGON);
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email: EMAIL, password: SENHA_WORLD, displayName: 'Ana' })).status, 200);
  });
  after(async () => { globalThis.fetch = realFetch; process.env.ERGON_WORLD_URL = ''; await h?.close(); await world.stop(); });
  beforeEach(() => throttle.reset());

  test('escolher: confere a senha no World; a mesma senha do Ergon não serve; sem frase, já conta como recuperação', async () => {
    assert.equal((await req(h, 'GET', '/api/me', s)).json.recovery, false);
    const st0 = (await req(h, 'GET', '/api/security/status', s)).json;
    assert.deepEqual([st0.worldRecovery.available, st0.worldRecovery.email, st0.recoveryWorld], [true, EMAIL, null]);
    const errada = await req(h, 'POST', '/api/security/recovery/world', s, { password: 'senha-errada-do-world' });
    assert.deepEqual([errada.status, errada.json.error], [400, 'invalid_world']);
    const mesma = await req(h, 'POST', '/api/security/recovery/world', s, { password: SENHA_ERGON });
    assert.deepEqual([mesma.status, mesma.json.error], [409, 'world_same_password']);
    const ok = await req(h, 'POST', '/api/security/recovery/world', s, { password: SENHA_WORLD });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.recoveryWorld, { email: EMAIL, stale: false });
    assert.equal((await req(h, 'GET', '/api/me', s)).json.recovery, true);
    assert.equal((await req(h, 'GET', '/api/auth/state')).json.worldRecovery, true, '"Esqueci a senha" mostra a opção');
  });

  test('o embrulho local não sai do aparelho: nenhum pedido ao World leva o sal nem o embrulho', () => {
    const w = worldWrap(h.dir, s.userId)!;
    assert.ok(foiAoWorld.length > 0 && foiAoWorld.some((x) => x.includes('/v1/accounts/login')), 'a senha foi conferida no World');
    for (const x of foiAoWorld) { assert.ok(!x.includes(w.blob), 'embrulho'); assert.ok(!x.includes(w.salt!), 'sal'); }
  });

  test('esqueci a senha do Ergon: senha do World errada não entra; a certa redefine e entra', async () => {
    const errada = await req(h, 'POST', '/api/auth/recover/world', null, { username: 'ana', email: EMAIL, password: 'senha-errada-do-world', newPassword: 'senha nova da ana 2026' });
    assert.deepEqual([errada.status, errada.json.error], [401, 'invalid_world']);
    const outroUsuario = await req(h, 'POST', '/api/auth/recover/world', null, { username: 'bia', email: EMAIL, password: SENHA_WORLD, newPassword: 'senha nova da ana 2026' });
    assert.equal(outroUsuario.status, 401, 'usuário sem essa reserva: a mesma resposta');
    const ok = await req(h, 'POST', '/api/auth/recover/world', null, { username: 'ana', email: EMAIL, password: SENHA_WORLD, newPassword: 'senha nova da ana 2026' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await req(h, 'GET', '/api/me', s)).status, 401, 'as sessões antigas caem');
    const login = await req(h, 'POST', '/api/auth/login', null, { username: 'ana', password: 'senha nova da ana 2026' });
    assert.equal(login.status, 200);
    s = await sessionFrom(h, login.res.headers['set-cookie']);
    assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'ana', password: SENHA_ERGON })).status, 401, 'a senha antiga não vale');
  });

  test('World fora do ar: mensagem curta, nada muda', async () => {
    await world.stop();
    try {
      const r = await req(h, 'POST', '/api/auth/recover/world', null, { username: 'ana', email: EMAIL, password: SENHA_WORLD, newPassword: 'mais uma senha nova 2026' });
      assert.deepEqual([r.status, r.json.error, r.json.message], [503, 'world_offline', 'Sem conexão com o Ergon World agora. Tente de novo.']);
      assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'ana', password: 'senha nova da ana 2026' })).status, 200);
    } finally { await world.start(); }
  });

  test('senha do World trocada por "esqueci a senha" aqui: o embrulho acompanha (a nova recupera)', async () => {
    const r = await req(h, 'POST', '/api/world/account/password/reset', s, { email: EMAIL, code: '123456', password: 'senha nova do world 2026' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(worldWrap(h.dir, s.userId)!.stale, undefined);
    assert.equal(await h.vault.openPersonWorld(s.userId, 'senha nova do world 2026'), true);
    assert.equal(await h.vault.openPersonWorld(s.userId, SENHA_WORLD), false, 'a antiga deixou de abrir');
  });

  test('senha do World trocada lá fora: ao tentar recuperar, o World aceita e o embrulho não abre → aviso e nova escolha', async () => {
    [...world.accounts.values()].find((a) => a.email === EMAIL)!.password = 'trocada no site do world 2026';
    const r = await req(h, 'POST', '/api/auth/recover/world', null, { username: 'ana', email: EMAIL, password: 'trocada no site do world 2026', newPassword: 'outra senha nova 2026' });
    assert.deepEqual([r.status, r.json.error], [409, 'world_recovery_stale']);
    const me = (await req(h, 'GET', '/api/me', s)).json;
    assert.deepEqual([me.recovery, me.recoveryWorldStale], [false, true], 'o lembrete pede a nova escolha');
    // a pessoa escolhe de novo (com a senha nova do World): volta a valer
    assert.equal((await req(h, 'POST', '/api/security/recovery/world', s, { password: 'trocada no site do world 2026' })).status, 200);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.recoveryWorldStale, false);
  });

  test('trancado (depois de reiniciar): a senha do World abre pelo portão e define a senha nova', async () => {
    assert.equal((await req(h, 'PUT', '/api/security/lock', s, { enabled: true })).status, 200);
    const dir = h.dir; await h.close();
    const cfg = testConfig(dir); const vault = new Vault(dir, KDF_TEST);
    assert.equal(vault.state(), 'sealed');
    const checks: string[] = [];
    const g = await buildGate(cfg, vault, () => new Db(cfg.dbPath, { key: vault.dbKey() }), {
      worldCheck: async (email, password) => { checks.push(email); await new WorldClient({ url: world.url, refreshSeconds: 900 }).call('POST', '/v1/accounts/login', { email, password }); },
    });
    const post = (body: unknown) => g.app.inject({ method: 'POST', url: '/api/unseal/world', headers: { 'content-type': 'application/json', origin: ORIGIN }, payload: JSON.stringify(body) });
    assert.equal((await g.app.inject({ method: 'GET', url: '/api/auth/state' })).json().worldRecovery, true);
    assert.equal((await post({ username: 'ana', email: EMAIL, password: 'senha-errada-do-world', newPassword: 'senha depois do portao 2026' })).statusCode, 401);
    assert.equal(vault.state(), 'sealed');
    const ok = await post({ username: 'ana', email: EMAIL, password: 'trocada no site do world 2026', newPassword: 'senha depois do portao 2026' });
    assert.equal(ok.statusCode, 200, ok.body); assert.ok(ok.headers['set-cookie']);
    assert.deepEqual(checks, [EMAIL, EMAIL]);
    (await g.done).close(); await g.app.close();
    h = await harness({}, { dir, vault });
    assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'ana', password: 'senha depois do portao 2026' })).status, 200);
  });
});

describe('World Sync: a chave do workspace recuperada pela senha do World', () => {
  let world: FakeWorld; let pc1: Harness; let a1: Session; let pc2: Harness; let a2: Session; let sws = '';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc1?.close(); await pc2?.close(); await world.stop(); });
  beforeEach(() => throttle.reset());

  test('PC 1 grava a recuperação pela senha do World (conferida no World); o envelope é do tipo world', async () => {
    pc1 = await harness(); a1 = await setupOwner(pc1, 'ana', SENHA_ERGON);
    assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: EMAIL, password: SENHA_WORLD, displayName: 'Ana' })).status, 200);
    sws = (await req(pc1, 'POST', '/api/world/bind', a1, {})).json.syncWorkspaceId;
    const errada = await req(pc1, 'POST', '/api/world/sync/enable', a1, { worldPassword: 'senha-errada-do-world' });
    assert.deepEqual([errada.status, errada.json.error], [400, 'invalid_world']);
    const ok = await req(pc1, 'POST', '/api/world/sync/enable', a1, { worldPassword: SENHA_WORLD });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.recoveryKind, 'world');
    const env = world.workspaces.get(sws)!.recovery!;
    assert.equal(recoveryKindOf(env.wrapped), 'world');
    assert.ok(!env.wrapped.includes(SENHA_WORLD), 'a senha não vai no envelope');
    world.activate(sws);
  });

  test('PC 2 (todos os outros aparelhos perdidos): entra com a senha do World; a frase não serve aqui', async () => {
    pc2 = await harness(); a2 = await setupOwner(pc2, 'ana-novo', 'senha do computador novo 123');
    assert.equal((await req(pc2, 'POST', '/api/world/connect', a2, { mode: 'login', email: EMAIL, password: SENHA_WORLD })).status, 200);
    assert.equal((await req(pc2, 'POST', '/api/world/bind', a2, { syncWorkspaceId: sws })).status, 200);
    const frase = await req(pc2, 'POST', '/api/world/sync/join', a2, { recoveryPhrase: 'uma frase de recuperação qualquer aqui' });
    assert.deepEqual([frase.status, frase.json.error], [400, 'recovery_kind']);
    const ok = await req(pc2, 'POST', '/api/world/sync/join', a2, { worldPassword: SENHA_WORLD });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual([ok.json.enabled, ok.json.recoveryKind], [true, 'world']);
  });

  test('senha do World trocada aqui (esqueci a senha): o envelope acompanha; trocada lá fora: aviso curto', async () => {
    assert.equal((await req(pc1, 'POST', '/api/world/account/password/reset', a1, { email: EMAIL, code: '123456', password: 'senha nova do world 2026' })).status, 200);
    const env = world.workspaces.get(sws)!.recovery!;
    assert.ok(await unwrapForRecoveryWorld(env.wrapped, 'senha nova do world 2026', sws, env.keyVersion), 'refeito com a nova');
    await assert.rejects(unwrapForRecoveryWorld(env.wrapped, SENHA_WORLD, sws, env.keyVersion), 'a antiga não abre mais');

    [...world.accounts.values()].find((a) => a.email === EMAIL)!.password = 'trocada no site do world 2026';
    const pc3 = await harness(); const a3 = await setupOwner(pc3, 'ana-tres', 'senha do terceiro computador 123');
    try {
      assert.equal((await req(pc3, 'POST', '/api/world/connect', a3, { mode: 'login', email: EMAIL, password: 'trocada no site do world 2026', endSessionsOf: [...world.devices.values()].find((d) => d.status === 'active')!.id })).status, 200);
      assert.equal((await req(pc3, 'POST', '/api/world/bind', a3, { syncWorkspaceId: sws })).status, 200);
      const r = await req(pc3, 'POST', '/api/world/sync/join', a3, { worldPassword: 'trocada no site do world 2026' });
      assert.deepEqual([r.status, r.json.error], [409, 'recovery_world_stale']);
    } finally { await pc3.close(); }
  });
});
