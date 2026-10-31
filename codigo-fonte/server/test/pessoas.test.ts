import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { throttle } from '../src/security/factors.ts';
import { PersonKeySource, PersonSealedError, Vault } from '../src/security/keys.ts';
import { CLOSED_VALUE } from '../src/security/fields.ts';
import { addPerson, allAgents, answersFor, confirmPhrase, drain, harness, req, setupOwner, type Harness, type Recovery, type Session } from './helpers.ts';

const A = { user: 'alexandre', pass: 'senha-local-123' };
const B = { user: 'bruna', pass: 'senha-bruna-123' };
const keyring = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.dir, 'keyring.json'), 'utf8'));
/** primeira coluna da primeira linha (leitura crua, sem decifrar) */
const one = (db: Db, sql: string, ...params: string[]) => Object.values(db.raw.prepare(sql).get(...params) as Record<string, unknown>)[0];
const titles = (db: Db) => db.all<{ title: string }>('SELECT title FROM tasks').map((t) => t.title);
/** como o index.ts ao reiniciar sem trancamento: cofre novo; a chave ao lado dos dados abre só a instalação */
const restartVault = (dir: string) => { const v = new Vault(dir, KDF_TEST); assert.ok(v.unsealOpenAccess(), 'abre a instalação sozinho'); return v; };

/** Duas pessoas: Alexandre (a primeira, administra) e Bruna, cada uma com uma tarefa no próprio quadro. */
async function twoPeople(): Promise<{ h: Harness; a: Session; b: Session & { recovery: Recovery } }> {
  throttle.reset();
  const h = await harness();
  const a = await setupOwner(h);
  const b = await addPerson(h, B.user, B.pass, 'Bruna');
  assert.equal((await req(h, 'POST', '/api/tasks', a, { title: 'Segredo do Alexandre' })).status, 201);
  assert.equal((await req(h, 'POST', '/api/tasks', b, { title: 'Segredo da Bruna' })).status, 201);
  return { h, a, b };
}

describe('várias pessoas no mesmo computador: contas', () => {
  test('a tela de entrada oferece "criar conta"; a segunda pessoa ganha workspace, chave e frase próprios', async () => {
    throttle.reset();
    const h = await harness();
    assert.equal((await req(h, 'GET', '/api/auth/state')).json.signup, null, 'antes do primeiro uso, só "crie a sua conta"');
    const a = await setupOwner(h);
    assert.equal((await req(h, 'GET', '/api/auth/state')).json.signup, 'aberto', 'padrão: qualquer pessoa no computador cria a sua');
    // a primeira pessoa ainda não confirmou a frase dela: a segunda conta espera (senão a parte dela ficaria sem volta)
    const early = await req(h, 'POST', '/api/auth/register', null, { username: B.user, password: B.pass });
    assert.equal(early.status, 409); assert.equal(early.json.error, 'others_without_phrase');
    const b = await addPerson(h, B.user, B.pass, 'Bruna');
    assert.notEqual(b.workspaceId, a.workspaceId, 'workspace próprio');
    assert.equal(b.recovery.phrase.split(' ').length, 24, 'frase própria, mostrada uma vez');
    const me = (await req(h, 'GET', '/api/me', b)).json;
    assert.equal(me.admin, false); assert.equal(me.recovery, false, 'a frase dela vale depois de confirmada');
    assert.equal((await req(h, 'GET', '/api/me', a)).json.admin, true, 'a primeira conta administra');
    await confirmPhrase(h, b, b.recovery);
    assert.equal((await req(h, 'GET', '/api/me', b)).json.recovery, true);
    const dek = h.db.raw.prepare('SELECT wrapped FROM workspace_keys WHERE workspace_id = ?').get(b.workspaceId) as { wrapped: string };
    assert.equal(PersonKeySource.personOf(dek.wrapped), b.userId, 'a chave do workspace dela é embrulhada pela chave dela');
    assert.equal((await req(h, 'POST', '/api/auth/register', null, { username: B.user, password: 'outra-senha-forte-1' })).json.error, 'username_taken');
    await h.close();
  });

  test('só com convite: sem código não entra; o código vale uma vez', async () => {
    const { h, a, b } = await twoPeople();
    await confirmPhrase(h, b, b.recovery); // quem já está aqui tem a frase dela
    assert.equal((await req(h, 'PUT', '/api/people/signup', a, { policy: 'convite' })).status, 200);
    assert.equal((await req(h, 'GET', '/api/auth/state')).json.signup, 'convite');
    const sem = await req(h, 'POST', '/api/auth/register', null, { username: 'carla', password: 'senha-carla-123' });
    assert.equal(sem.status, 403); assert.equal(sem.json.error, 'invite');
    const inv = (await req(h, 'POST', '/api/people/invites', a, {})).json;
    assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const ok = await req(h, 'POST', '/api/auth/register', null, { username: 'carla', password: 'senha-carla-123', invite: inv.code.toLowerCase() });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const de_novo = await req(h, 'POST', '/api/auth/register', null, { username: 'daniel', password: 'senha-daniel-123', invite: inv.code });
    assert.equal(de_novo.status, 403, 'convite já usado');
    await h.close();
  });

  test('quem administra vê quem tem conta (sem ver nada dentro); as outras pessoas não veem a lista', async () => {
    const { h, a, b } = await twoPeople();
    const list = (await req(h, 'GET', '/api/people', a)).json;
    assert.deepEqual(list.people.map((p: { username: string }) => p.username), [A.user, B.user]);
    assert.equal(list.isolated, true, 'duas pessoas: cada parte só abre pela própria pessoa');
    assert.ok(!JSON.stringify(list).includes('Segredo'), 'nada do conteúdo');
    assert.equal((await req(h, 'GET', '/api/people', b)).status, 403);
    await h.close();
  });
});

describe('várias pessoas: isolamento também na criptografia', () => {
  test('com duas pessoas, a chave da instalação não abre a parte de ninguém', async () => {
    const { h, a, b } = await twoPeople();
    const k = keyring(h);
    assert.equal(Object.keys(k.people).length, 2);
    for (const p of Object.values(k.people) as Array<{ wraps: Array<{ type: string }> }>) assert.ok(!p.wraps.some((w) => w.type === 'mk'), 'nenhuma parte embrulhada pela MK');
    await h.close();
    // reinício sem trancamento: a instalação abre sozinha, as partes não
    const v = restartVault(h.dir);
    assert.equal(v.personOpen(a.userId), false); assert.equal(v.personOpen(b.userId), false);
    const db = new Db(h.cfg.dbPath, { key: v.dbKey() });
    db.setCipher(v.personKeySource(() => null));
    assert.ok(titles(db).every((t) => t === CLOSED_VALUE || !t.startsWith('Segredo')), 'sem a pessoa, o conteúdo fica fechado');
    assert.throws(() => db.seal(b.workspaceId, 'tentativa de gravar'), PersonSealedError, 'gravar na parte fechada falha (nada vira lixo)');
    // a senha da Bruna abre só a parte dela
    assert.equal(await v.openPerson(b.userId, B.pass), true);
    const seen = titles(db);
    assert.ok(seen.includes('Segredo da Bruna')); assert.ok(!seen.includes('Segredo do Alexandre'));
    assert.equal(await v.openPerson(a.userId, B.pass), false, 'a senha de uma não abre a outra');
    db.close();
  });

  test('a frase de uma pessoa não serve para outra; a de cada uma recupera a própria conta', async () => {
    const { h, b } = await twoPeople();
    await confirmPhrase(h, b, b.recovery);
    const outra = await req(h, 'POST', '/api/auth/recover', null, { username: A.user, phrase: b.recovery.phrase, newPassword: 'invasao-senha-nova-1' });
    assert.equal(outra.status, 401);
    const dela = await req(h, 'POST', '/api/auth/recover', null, { username: B.user, phrase: b.recovery.phrase, newPassword: 'bruna-senha-nova-22' });
    assert.equal(dela.status, 200);
    await h.close();
    const v = restartVault(h.dir);
    assert.equal(await v.openPerson(b.userId, 'bruna-senha-nova-22'), true, 'a senha nova abre a parte dela depois de reiniciar');
  });

  test('depois de reiniciar: quem já tem sessão vê "digite a senha"; o trabalho de quem não entrou espera', async () => {
    const { h, a, b } = await twoPeople();
    const st = { agents: await allAgents(h, b) };
    const conv = (await req(h, 'POST', '/api/conversations', b, { agentId: st.agents[0].id })).json;
    await h.close();
    // o servidor sobe de novo (sem trancamento): ninguém abriu a própria parte ainda
    const h2 = await harness({}, { dir: h.dir, vault: restartVault(h.dir) });
    const r = await req(h2, 'GET', '/api/state', a);
    assert.equal(r.status, 423); assert.equal(r.json.error, 'person_sealed');
    assert.equal((await req(h2, 'GET', '/api/me', a)).json.personSealed, true, 'a interface mostra a tela de destrancar');
    // a Bruna pede algo na conversa de antes... não dá: ela também está fechada
    assert.equal((await req(h2, 'POST', `/api/conversations/${conv.id}/messages`, b, { text: 'oi', clientRequestId: 'req-multi-0001' })).status, 423);
    // o Alexandre digita a senha: a parte dele abre; a da Bruna continua fechada
    assert.equal((await req(h2, 'POST', '/api/session/unlock', a, { password: A.pass })).status, 200);
    assert.equal((await req(h2, 'GET', '/api/state', a)).status, 200);
    assert.ok((await req(h2, 'GET', '/api/state', a)).json.team.active > 0);
    assert.ok((await allAgents(h2, a)).length > 0);
    assert.equal(h2.vault.personOpen(b.userId), false);
    // trabalho que já estava na fila da Bruna não anda até ela entrar
    h2.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, max_attempts, created_at) VALUES ('run_00000000000000000000000000000077', ?, ?, 'chat', 'queued', 'simulated', 'x', 'multi-espera', 2, ?)",
      b.workspaceId, st.agents[0].id, new Date().toISOString());
    await drain(h2);
    assert.equal(one(h2.db, "SELECT status FROM runs WHERE id = 'run_00000000000000000000000000000077'"), 'queued', 'fica na fila');
    assert.equal((await req(h2, 'POST', '/api/session/unlock', b, { password: B.pass })).status, 200);
    await drain(h2);
    assert.notEqual(one(h2.db, "SELECT status FROM runs WHERE id = 'run_00000000000000000000000000000077'"), 'queued', 'com a parte aberta, a fila anda');
    await h2.close();
  });

  test('uma pessoa só: nada muda (a instalação abre sozinha e a parte dela também)', async () => {
    throttle.reset();
    const h = await harness();
    const a = await setupOwner(h);
    await req(h, 'POST', '/api/tasks', a, { title: 'Sozinho no computador' });
    await h.close();
    const v = restartVault(h.dir);
    assert.equal(v.personOpen(a.userId), true, 'com uma pessoa só, a chave da instalação abre a parte dela');
    const h2 = await harness({}, { dir: h.dir, vault: v });
    assert.equal((await req(h2, 'GET', '/api/state', a)).status, 200);
    await h2.close();
  });
});

describe('várias pessoas: remover conta e trava de cada uma', () => {
  test('remover: a chave sai primeiro, depois dados e arquivos; quem administra não sai', async () => {
    const { h, a, b } = await twoPeople();
    await req(h, 'POST', '/api/artifacts', b, Buffer.from('arquivo da Bruna'), { 'content-type': 'application/octet-stream', 'x-filename': 'b.txt', 'x-file-type': 'text/plain' });
    assert.ok(fs.existsSync(path.join(h.cfg.filesDir, b.workspaceId)));
    // pede confirmação recente e o usuário digitado
    h.db.run('UPDATE sessions SET auth_at = ? WHERE user_id = ?', new Date(Date.now() - 3600_000).toISOString(), a.userId);
    assert.equal((await req(h, 'DELETE', `/api/people/${b.userId}`, a, { confirm: B.user })).status, 401, 'confirmação recente');
    assert.equal((await req(h, 'POST', '/api/session/unlock', a, { password: A.pass })).status, 200);
    assert.equal((await req(h, 'DELETE', `/api/people/${b.userId}`, a, { confirm: 'errado' })).status, 400);
    const r = await req(h, 'DELETE', `/api/people/${b.userId}`, a, { confirm: B.user });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!keyring(h).people[b.userId], 'a parte dela saiu do keyring');
    assert.equal(one(h.db, 'SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?', b.workspaceId), 0);
    assert.equal(one(h.db, 'SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = ?', b.workspaceId), 0);
    assert.equal(fs.existsSync(path.join(h.cfg.filesDir, b.workspaceId)), false, 'arquivos removidos');
    assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: B.user, password: B.pass })).status, 401);
    assert.ok(titles(h.db).includes('Segredo do Alexandre'), 'o resto fica como estava');
    assert.equal((await req(h, 'DELETE', `/api/people/${a.userId}`, a, { confirm: A.user })).json.error, 'admin_stays');
    // voltou a uma pessoa só: a parte do Alexandre volta a abrir pela chave da instalação (nada a isolar)
    assert.ok(keyring(h).people[a.userId].wraps.some((w: { type: string }) => w.type === 'mk'));
    await h.close();
  });

  test('a própria pessoa pode sair; a trava por inatividade é de cada uma', async () => {
    const { h, a, b } = await twoPeople();
    assert.equal((await req(h, 'PUT', '/api/security/idle', b, { minutes: 5 })).status, 200);
    h.db.run('UPDATE sessions SET last_seen_at = ?', new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal((await req(h, 'GET', '/api/state', b)).status, 423, 'a da Bruna tranca');
    assert.equal((await req(h, 'GET', '/api/state', a)).status, 200, 'a do Alexandre segue a dele (desligada)');
    assert.equal((await req(h, 'POST', '/api/session/unlock', b, { password: B.pass })).status, 200);
    assert.equal((await req(h, 'DELETE', '/api/me/account', b, { confirm: B.user })).status, 200);
    assert.equal(one(h.db, 'SELECT COUNT(*) AS n FROM users'), 1);
    await h.close();
  });
});

describe('instalação de antes desta versão (uma pessoa, chaves pela MK)', () => {
  test('a primeira senha digitada cria a chave da pessoa e passa as chaves dos workspaces para ela', async () => {
    throttle.reset();
    const h = await harness();
    const a = await setupOwner(h);
    await req(h, 'POST', '/api/tasks', a, { title: 'De antes da atualização' });
    // volta ao formato anterior: DEKs pela MK (lk1.) e keyring sem pessoas
    const legacy = h.vault.keySource();
    const src = h.vault.personKeySource(() => a.userId);
    for (const r of h.db.raw.prepare('SELECT workspace_id, wrapped FROM workspace_keys').all() as Array<{ workspace_id: string; wrapped: string }>) {
      h.db.raw.prepare("UPDATE workspace_keys SET wrapped = ?, key_source = 'local' WHERE workspace_id = ?").run(legacy.wrapDek(r.workspace_id, src.unwrapDek(r.workspace_id, r.wrapped)), r.workspace_id);
    }
    const k = keyring(h); delete k.people; k.v = 1;
    fs.writeFileSync(path.join(h.dir, 'keyring.json'), JSON.stringify(k));
    await h.close();
    const v = restartVault(h.dir);
    assert.equal(v.hasPerson(a.userId), false);
    const h2 = await harness({}, { dir: h.dir, vault: v });
    // o trabalho de fundo segue (dados pela MK, como antes); a sessão pede a senha uma vez para criar a chave dela
    assert.equal((await req(h2, 'GET', '/api/state', a)).json.error, 'person_sealed');
    assert.equal((await req(h2, 'POST', '/api/session/unlock', a, { password: A.pass })).status, 200);
    assert.equal(h2.vault.hasPerson(a.userId), true);
    const wk = h2.db.raw.prepare('SELECT wrapped, key_source FROM workspace_keys').all() as Array<{ wrapped: string; key_source: string }>;
    assert.ok(wk.every((x) => PersonKeySource.personOf(x.wrapped) === a.userId && x.key_source === 'person'), 'chaves dos workspaces pela chave dela');
    assert.ok(titles(h2.db).includes('De antes da atualização'), 'os dados continuam lá');
    // antes de outra pessoa criar conta, ela gera a frase pessoal
    assert.equal((await req(h2, 'POST', '/api/auth/register', null, { username: B.user, password: B.pass })).json.error, 'others_without_phrase');
    const rec = (await req(h2, 'POST', '/api/security/recovery/new', a, {})).json;
    assert.equal((await req(h2, 'POST', '/api/security/recovery/confirm', a, { answers: answersFor(rec) })).status, 200);
    assert.equal((await req(h2, 'POST', '/api/auth/register', null, { username: B.user, password: B.pass })).status, 200);
    await h2.close();
  });
});

describe('várias pessoas: abrir sozinho de cada uma (ajudante do computador)', () => {
  const AGENT = 'token-do-ajudante-'.padEnd(40, 'z');
  const agent = (h: Harness, url: string, body: unknown = {}) =>
    h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-ergon-agent-token': AGENT }, payload: JSON.stringify(body) });

  test('a chave de cada pessoa abre só a parte dela; o ajudante guarda várias e abre as que estão fechadas', async () => {
    throttle.reset();
    const h = await harness({ agentToken: AGENT });
    const a = await setupOwner(h);
    const b = await addPerson(h, B.user, B.pass, 'Bruna');
    await agent(h, '/api/agent/hello', { label: 'Computador da sala', platform: 'windows' });
    assert.equal((await req(h, 'POST', '/api/security/auto-unlock', b, {})).status, 200, 'a Bruna liga o "abrir sozinho" dela');
    assert.equal((await agent(h, '/api/agent/hello')).json().enroll, true);
    const kb = (await agent(h, '/api/agent/auto-unlock/claim')).json();
    assert.match(kb.key, /^[0-9a-f]{64}$/);
    assert.deepEqual(h.vault.personAutoIds(b.userId), [kb.id], 'a chave embrulha a parte da Bruna');
    assert.deepEqual(h.vault.personAutoIds(a.userId), [], 'nada muda para o Alexandre');
    await h.close();
    // reinício sem trancamento: instalação aberta, partes fechadas; o ajudante vê que a parte da Bruna está fechada
    const h2 = await harness({ agentToken: AGENT }, { dir: h.dir, vault: restartVault(h.dir) });
    const hello = (await agent(h2, '/api/agent/hello', { keyIds: [kb.id, 'wrp_inexistente'] })).json();
    assert.deepEqual(hello.closed, [kb.id]); assert.deepEqual(hello.invalid, ['wrp_inexistente']);
    assert.equal((await agent(h2, '/api/agent/open', { key: '0'.repeat(64) })).statusCode, 401);
    assert.equal((await agent(h2, '/api/agent/open', { key: kb.key })).statusCode, 200);
    assert.equal(h2.vault.personOpen(b.userId), true, 'a parte dela abriu sem a senha');
    assert.equal(h2.vault.personOpen(a.userId), false, 'a do Alexandre continua fechada');
    // com o Ergon trancado (cofre novo, sem a chave ao lado dos dados), a mesma chave abre a instalação e só a parte dela
    const sealed = new Vault(h.dir, KDF_TEST);
    assert.equal(sealed.unsealAuto(kb.key), true);
    assert.equal(sealed.state(), 'open'); assert.equal(sealed.personOpen(b.userId), true); assert.equal(sealed.personOpen(a.userId), false);
    assert.deepEqual((await agent(h2, '/api/agent/hello', { keyIds: [kb.id] })).json().closed, [], 'aberta: nada a fazer');
    assert.equal((await req(h2, 'GET', '/api/state', b)).status, 200);
    // desligar na tela: a chave cai e o ajudante fica sabendo
    assert.equal((await req(h2, 'POST', '/api/session/unlock', b, { password: B.pass })).status, 200);
    assert.equal((await req(h2, 'DELETE', '/api/security/auto-unlock', b)).status, 200);
    assert.deepEqual((await agent(h2, '/api/agent/hello', { keyIds: [kb.id] })).json().invalid, [kb.id]);
    await h2.close();
  });
});
