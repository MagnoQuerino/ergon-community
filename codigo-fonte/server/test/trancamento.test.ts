import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { throttle } from '../src/security/factors.ts';
import { Vault } from '../src/security/keys.ts';
import { applyLockChoice, setInstanceSetting } from '../src/services/security.ts';
import { harness, req, type Harness, type Session } from './helpers.ts';

const PASS = 'senha-local-123';
const DAY = 86400_000;
const cookieOf = (setCookie: string | string[] | undefined) => (Array.isArray(setCookie) ? setCookie[0] : setCookie ?? '');

async function setup(h: Harness): Promise<{ s: Session; setCookie: string }> {
  const r = await req(h, 'POST', '/api/auth/setup', null, { username: 'alexandre', password: PASS, displayName: 'Alexandre' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const setCookie = cookieOf(r.res.headers['set-cookie']);
  const cookie = setCookie.split(';')[0];
  const me = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { s: { cookie, csrf: me.csrf, workspaceId: me.workspaceId, userId: me.user.id }, setCookie };
}
const keyFile = (h: Harness) => path.join(h.dir, 'unlock.key');
const openWraps = (h: Harness) => (JSON.parse(fs.readFileSync(path.join(h.dir, 'keyring.json'), 'utf8')).wraps as Array<{ purpose?: string }>).filter((w) => w.purpose === 'open').length;
/** como o index.ts ao reiniciar: cofre novo (selado) e, sem trancamento, abre sozinho */
const restart = (dir: string) => { const v = new Vault(dir, KDF_TEST); assert.equal(v.state(), 'sealed'); const opened = v.unsealOpenAccess(); return { v, opened }; };
const expiresIn = (h: Harness, s: Session) => {
  const rows = h.db.all<{ expires_at: string }>('SELECT expires_at FROM sessions');
  assert.ok(rows.length >= 1, s.cookie);
  return Math.max(...rows.map((r) => Date.parse(r.expires_at))) - Date.now();
};

describe('trancamento: desligado por padrão no computador, a proteção passa a ser a do computador', () => {
  test('instalação nova: abre sozinha ao reiniciar, sessão longa, registrado na auditoria', async () => {
    throttle.reset();
    const h = await harness();
    const { s, setCookie } = await setup(h);
    const st = (await req(h, 'GET', '/api/security/status', s)).json;
    assert.deepEqual(st.lock, { enabled: false, forced: false, sessionDays: 90 });
    assert.match(setCookie, /Max-Age=7776000/, 'cookie de 90 dias');
    assert.ok(expiresIn(h, s) > 89 * DAY, 'sessão de 90 dias no banco');
    assert.ok(fs.existsSync(keyFile(h)), 'a chave fica ao lado dos dados');
    assert.equal(openWraps(h), 1);
    assert.equal(h.vault.info().auto.length, 0, 'não conta como "destrancar sozinho"');
    const ev = h.db.all<{ action: string; evidence: string | null }>("SELECT action, evidence FROM audit_events WHERE action LIKE 'security.lock.%'");
    assert.equal(ev.length, 1); assert.equal(ev[0].action, 'security.lock.off');
    await req(h, 'POST', '/api/tasks', s, { title: 'Sobrevive ao reinício sem senha' });
    await h.close();
    const { v, opened } = restart(h.dir);
    assert.equal(opened, true); assert.equal(v.state(), 'open');
    const db = new Db(h.cfg.dbPath, { key: v.dbKey() }); db.setCipher(v.personKeySource(() => null));
    assert.ok(db.all<{ title: string }>('SELECT title FROM tasks').some((t) => t.title === 'Sobrevive ao reinício sem senha'), 'os dados abrem sem a senha');
    db.close();
  });

  test('ligar: a chave sai do disco, o reinício volta a pedir senha e as sessões voltam a 7 dias', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    const r = await req(h, 'PUT', '/api/security/lock', s, { enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json, { enabled: true, sessionDays: 7 });
    assert.equal(fs.existsSync(keyFile(h)), false); assert.equal(openWraps(h), 0);
    assert.ok(expiresIn(h, s) <= 7 * DAY + 60_000, 'a sessão longa foi encurtada');
    assert.equal((await req(h, 'GET', '/api/security/status', s)).json.lock.enabled, true);
    // a escolha fica: abrir de novo não desliga sozinho
    await h.close();
    const h2 = await harness({}, { dir: h.dir });
    assert.equal(h2.vault.openAccess(), false, 'escolha "ligado" respeitada');
    await h2.close();
    const { v, opened } = restart(h.dir);
    assert.equal(opened, false); assert.equal(v.state(), 'sealed', 'ao reiniciar pede a senha');
    assert.ok(await v.unsealPassword('alexandre', PASS), 'a senha continua abrindo');
  });

  test('desligar pede confirmação recente da identidade; o aviso fica registrado', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true });
    h.db.run('UPDATE sessions SET auth_at = ?', new Date(Date.now() - 30 * 60_000).toISOString());
    const stale = await req(h, 'PUT', '/api/security/lock', s, { enabled: false });
    assert.equal(stale.status, 401); assert.equal(stale.json.error, 'reauth');
    assert.equal(fs.existsSync(keyFile(h)), false, 'nada mudou sem confirmar');
    h.db.run('UPDATE sessions SET auth_at = ?', new Date().toISOString());
    const ok = await req(h, 'PUT', '/api/security/lock', s, { enabled: false });
    assert.equal(ok.status, 200); assert.deepEqual(ok.json, { enabled: false, sessionDays: 90 });
    assert.ok(fs.existsSync(keyFile(h))); assert.equal(openWraps(h), 1, 'um embrulho só, mesmo ligando e desligando');
    const acts = h.db.all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'security.lock.%' ORDER BY rowid").map((x) => x.action);
    assert.deepEqual(acts, ['security.lock.off', 'security.lock.on', 'security.lock.off']);
    assert.equal((await req(h, 'PUT', '/api/security/lock', s, { enabled: 'sim' })).status, 400);
    await h.close();
  });

  test('sem trancamento, a sessão se renova com o uso (uma vez por dia)', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    h.db.run('UPDATE sessions SET expires_at = ?', new Date(Date.now() + 10 * DAY).toISOString());
    const r = await req(h, 'GET', '/api/state', s);
    assert.equal(r.status, 200);
    assert.match(cookieOf(r.res.headers['set-cookie']), /Max-Age=7776000/, 'cookie renovado');
    assert.ok(expiresIn(h, s) > 89 * DAY);
    const again = await req(h, 'GET', '/api/state', s);
    assert.equal(again.res.headers['set-cookie'], undefined, 'no mesmo dia não renova de novo');
    // ligado: nada de renovação
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true });
    h.db.run('UPDATE sessions SET expires_at = ?', new Date(Date.now() + 2 * DAY).toISOString());
    assert.equal((await req(h, 'GET', '/api/state', s)).res.headers['set-cookie'], undefined);
    await h.close();
  });

  test('instalação já protegida (antes desta versão): atualizar mantém o trancamento; quem escolheu desligar tem a chave refeita', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    // simula a instalação antiga: sem escolha registrada e sem a chave ao lado dos dados
    h.vault.disableOpenAccess();
    h.db.run("DELETE FROM instance_settings WHERE key = 'lock_choice'");
    h.db.run("DELETE FROM audit_events WHERE action LIKE 'security.lock.%'");
    await h.close();
    const h2 = await harness({}, { dir: h.dir });
    assert.equal(h2.vault.openAccess(), false, 'atualizar nunca afrouxa a segurança sozinho');
    assert.equal(fs.existsSync(keyFile(h2)), false);
    assert.equal(h2.db.all("SELECT 1 FROM audit_events WHERE action = 'security.lock.kept'").length, 1, 'fica registrado');
    // a pessoa escolhe desligar (com confirmação recente) e, depois, a chave some do disco
    h2.db.run('UPDATE sessions SET auth_at = ?', new Date().toISOString());
    assert.equal((await req(h2, 'PUT', '/api/security/lock', s, { enabled: false })).status, 200);
    assert.equal(h2.vault.openAccess(), true);
    fs.rmSync(keyFile(h2));
    await h2.close();
    // reinício com a escolha "desligado" e a chave sumida (backup restaurado, arquivo apagado): pede a senha uma vez e refaz
    const v = new Vault(h.dir, KDF_TEST);
    assert.equal(v.unsealOpenAccess(), false, 'sem o arquivo, o reinício pede a senha');
    assert.ok(await v.unsealPassword('alexandre', PASS));
    const db = new Db(h.cfg.dbPath, { key: v.dbKey() }); db.setCipher(v.personKeySource(() => null));
    applyLockChoice(db, v, h.cfg, null);
    assert.equal(v.openAccess(), true); assert.ok(fs.existsSync(keyFile(h)));
    assert.equal(db.all("SELECT 1 FROM audit_events WHERE action = 'security.lock.off'").length, 1, 'sem novo registro: a escolha já existia');
    db.close();
    void s;
  });

  test('nuvem: sempre trancado; o padrão do computador não vale lá', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true });
    setInstanceSetting(h.db, 'lock_choice', '');
    applyLockChoice(h.db, h.vault, { ...h.cfg, mode: 'cloud' }, null);
    assert.equal(h.vault.openAccess(), false);
    await h.close();
  });

  test('backup não leva a chave do "sem trancamento"', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    const r = await req(h, 'POST', '/api/admin/backup', s);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const dir = path.join(h.cfg.backupsDir, r.json.file);
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    assert.ok(files.includes('keyring.json'));
    assert.ok(!files.some((f) => f.includes('unlock')), 'a chave fica só nesta máquina');
    for (const f of files) assert.ok(!fs.readFileSync(path.join(dir, f)).includes(Buffer.from(fs.readFileSync(keyFile(h), 'utf8'))), `${f} não contém a chave`);
    await h.close();
  });
});
