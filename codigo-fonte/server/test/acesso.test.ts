/**
 * Acesso e sessões: expiração, saída, revogação, troca de senha, reinício e confirmação
 * recente para operações privilegiadas — cada mudança de estado conferida pelo lado de quem tenta usar a sessão.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { throttle } from '../src/security/factors.ts';
import { addPerson, harness, loginAs, req, setupOwner, type Harness, type Session } from './helpers.ts';

const PASS = 'senha-local-123';
const NEW = 'girassol-trombone-neblina-azul';
const ok = async (h: Harness, s: Session) => (await req(h, 'GET', '/api/me', s)).status;

describe('sessões: o estado muda e quem usa a sessão sente na hora', () => {
  test('sessão vencida não entra e sai do banco', async () => {
    throttle.reset();
    const h = await harness(); const s = await setupOwner(h);
    assert.equal(await ok(h, s), 200);
    h.db.run('UPDATE sessions SET expires_at = ?', new Date(Date.now() - 1000).toISOString());
    assert.equal(await ok(h, s), 401);
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n, 0);
    await h.close();
  });

  test('sair invalida o cookie; entrar de novo cria outra sessão', async () => {
    throttle.reset();
    const h = await harness(); const s = await setupOwner(h);
    assert.equal((await req(h, 'POST', '/api/auth/logout', s)).status, 200);
    assert.equal(await ok(h, s), 401);
    const s2 = await loginAs(h, 'alexandre', PASS);
    assert.equal(await ok(h, s2), 200);
    await h.close();
  });

  test('encerrar outra sessão pela Segurança derruba só aquela', async () => {
    throttle.reset();
    const h = await harness(); const a = await setupOwner(h);
    const b = await loginAs(h, 'alexandre', PASS);
    const list = (await req(h, 'GET', '/api/security/status', a)).json.sessions as Array<{ id: string; current: number }>;
    const other = list.find((x) => !x.current)!;
    assert.equal((await req(h, 'DELETE', `/api/security/sessions/${other.id}`, a)).status, 200);
    assert.equal(await ok(h, b), 401, 'a outra caiu');
    assert.equal(await ok(h, a), 200, 'a sua continua');
    await h.close();
  });

  test('trocar a senha encerra as outras sessões; a antiga deixa de valer; a nova vale', async () => {
    throttle.reset();
    const h = await harness(); const a = await setupOwner(h);
    const b = await loginAs(h, 'alexandre', PASS);
    assert.equal((await req(h, 'POST', '/api/security/password', a, { current: PASS, next: NEW })).status, 200);
    assert.equal(await ok(h, b), 401);
    assert.equal(await ok(h, a), 200);
    assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: PASS })).status, 401);
    assert.equal(await ok(h, await loginAs(h, 'alexandre', NEW)), 200);
    // senha atual errada não troca nada
    assert.equal((await req(h, 'POST', '/api/security/password', a, { current: 'errada-errada-1', next: PASS })).status, 401);
    await h.close();
  });

  test('reiniciar o servidor (cofre aberto) mantém as sessões válidas', async () => {
    throttle.reset();
    const h = await harness(); const s = await setupOwner(h);
    await h.close();
    const h2 = await harness({}, { dir: h.dir });
    assert.equal(await ok(h2, s), 200);
    await h2.close();
  });

  test('operações privilegiadas pedem confirmação recente; sem ela, nada muda', async () => {
    throttle.reset();
    const h = await harness(); const s = await setupOwner(h);
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true });
    h.db.run('UPDATE sessions SET auth_at = ?', new Date(Date.now() - 60 * 60_000).toISOString());
    for (const [m, url, body] of [['POST', '/api/security/recovery/new', {}], ['PUT', '/api/security/lock', { enabled: false }], ['POST', '/api/security/totp/start', {}]] as const) {
      const r = await req(h, m, url, s, body);
      assert.equal(r.status, 401, `${url}: ${JSON.stringify(r.json)}`); assert.equal(r.json.error, 'reauth');
    }
    assert.equal((await req(h, 'GET', '/api/security/status', s)).json.lock.enabled, true, 'o trancamento continuou ligado');
    await h.close();
  });

  test('quem não administra não mexe na segurança da instalação (a própria frase, sim)', async () => {
    throttle.reset();
    const h = await harness(); await setupOwner(h);
    const s = await addPerson(h, 'bruna', 'senha-bruna-123');
    assert.equal((await req(h, 'PUT', '/api/security/lock', s, { enabled: true })).status, 403);
    assert.equal((await req(h, 'GET', '/api/people', s)).status, 403);
    assert.equal((await req(h, 'POST', '/api/security/recovery/new', s, {})).status, 200, 'cada pessoa gera a própria frase');
    await h.close();
  });
});
