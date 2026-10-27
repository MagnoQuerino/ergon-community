import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { redactUrl } from '../src/lib/util.ts';
import { buildGate } from '../src/gate.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { throttle, totpAt } from '../src/security/factors.ts';
import { Vault, normalizePhrase } from '../src/security/keys.ts';
import { setupOwner as setupOwnerSvc } from '../src/services/auth.ts';
import { loadConfig } from '../src/config.ts';
import { VERSION, newer } from '../src/version.ts';
import { ORIGIN, harness, loginAs, req, testConfig, tmpDir, type Harness, type Session } from './helpers.ts';

const PASS = 'senha-local-123';
const cookieOf = (setCookie: string | string[] | undefined) => (Array.isArray(setCookie) ? setCookie[0] : setCookie ?? '').split(';')[0];

async function setup(h: Harness): Promise<{ s: Session; recovery: { phrase: string; ask: number[] } }> {
  const r = await req(h, 'POST', '/api/auth/setup', null, { username: 'alexandre', password: PASS, displayName: 'Alexandre' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cookie = cookieOf(r.res.headers['set-cookie']);
  const me = (await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
  return { s: { cookie, csrf: me.csrf, workspaceId: me.workspaceId, userId: me.user.id }, recovery: r.json.recovery };
}
const answersFor = (rec: { phrase: string; ask: number[] }) => Object.fromEntries(rec.ask.map((p) => [String(p), rec.phrase.split(' ')[p - 1]]));

describe('proteção no primeiro uso: banco, campos e frase de recuperação', () => {
  let h: Harness; let s: Session; let recovery: { phrase: string; ask: number[] };
  before(async () => { throttle.reset(); h = await harness(); ({ s, recovery } = await setup(h)); });
  after(async () => { await h.close(); });

  test('senha fraca é recusada já no cadastro', async () => {
    const h2 = await harness();
    const r = await req(h2, 'POST', '/api/auth/setup', null, { username: 'fulano', password: '123456789' });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'weak_password');
    await h2.close();
  });

  test('arquivo do banco cifrado, campos sensíveis cifrados por workspace, nada em claro no disco', async () => {
    await req(h, 'POST', '/api/tasks', s, { title: 'Pagar o advogado do divórcio' });
    assert.ok(Db.isEncryptedFile(h.cfg.dbPath));
    const raw = Buffer.concat([fs.readFileSync(h.cfg.dbPath), ...(['-wal'].map((x) => fs.existsSync(h.cfg.dbPath + x) ? fs.readFileSync(h.cfg.dbPath + x) : Buffer.alloc(0)))]);
    for (const secret of ['Pagar o advogado', 'Planejar a semana', 'Você coordena a equipe']) assert.ok(!raw.includes(Buffer.from(secret)), `"${secret}" não pode aparecer no arquivo`);
    const cell = h.db.raw.prepare("SELECT title FROM tasks WHERE number = (SELECT MAX(number) FROM tasks)").get() as { title: string };
    assert.match(cell.title, /^ev1\.ws_[a-f0-9]{32}\./, 'o banco guarda o valor cifrado com a chave do workspace');
    const view = (await req(h, 'GET', '/api/boards', s)).json;
    const mine = view.find((b: { audience: string }) => b.audience === 'user');
    const tasks = (await req(h, 'GET', `/api/boards/${mine.id}`, s)).json.tasks;
    assert.ok(tasks.some((t: { title: string }) => t.title === 'Pagar o advogado do divórcio'), 'a aplicação lê normalmente');
    const wk = h.db.raw.prepare('SELECT wrapped, key_source FROM workspace_keys').all() as Array<{ wrapped: string; key_source: string }>;
    assert.ok(wk.length >= 1 && wk.every((k) => k.key_source === 'person' && k.wrapped.startsWith(`pk1.${s.userId}.`)), 'chave do workspace embrulhada pela chave da pessoa dona dele');
  });

  test('frase de 24 palavras, mostrada uma vez, só vale depois de confirmar 3 palavras', async () => {
    assert.equal(recovery.phrase.split(' ').length, 24);
    assert.ok(normalizePhrase(recovery.phrase.toUpperCase()), 'aceita a frase como a pessoa digitar');
    assert.equal(h.vault.personHasRecovery(s.userId), false, 'ainda não confirmada');
    const wrong = Object.fromEntries(recovery.ask.map((p) => [String(p), 'abacate']));
    assert.equal((await req(h, 'POST', '/api/security/recovery/confirm', s, { answers: wrong })).status, 400);
    assert.equal((await req(h, 'POST', '/api/security/recovery/confirm', s, { answers: answersFor(recovery) })).status, 200);
    assert.equal(h.vault.personHasRecovery(s.userId), true, 'frase pessoal');
    const kr = fs.readFileSync(path.join(h.dir, 'keyring.json'), 'utf8');
    assert.ok(!kr.includes(recovery.phrase.split(' ')[0] + ' ' + recovery.phrase.split(' ')[1]), 'a frase não fica gravada');
  });

  test('trava por inatividade: desligada por padrão; ligada com o tempo que o usuário escolhe (1 min a 24 h)', async () => {
    assert.equal((await req(h, 'GET', '/api/me', s)).json.idleMinutes, 0);
    h.db.run('UPDATE sessions SET last_seen_at = ?', new Date(Date.now() - 48 * 3600_000).toISOString());
    assert.equal((await req(h, 'GET', '/api/state', s)).status, 200, 'desligada: não tranca nem depois de 2 dias');
    assert.equal((await req(h, 'PUT', '/api/security/idle', s, { minutes: 90 })).status, 200);
    assert.equal((await req(h, 'GET', '/api/security/status', s)).json.idleMinutes, 90);
    assert.equal((await req(h, 'PUT', '/api/security/idle', s, { minutes: 1441 })).status, 400, 'até 24 h');
    assert.equal((await req(h, 'PUT', '/api/security/idle', s, { minutes: 0 })).status, 200, 'desliga de novo');
  });

  test('trava por inatividade: 423 até destrancar; a fila continua (o servidor segue aberto)', async () => {
    assert.equal((await req(h, 'PUT', '/api/security/idle', s, { minutes: 5 })).status, 200);
    h.db.run('UPDATE sessions SET last_seen_at = ?', new Date(Date.now() - 10 * 60_000).toISOString());
    const locked = await req(h, 'GET', '/api/state', s);
    assert.equal(locked.status, 423); assert.equal(locked.json.error, 'locked');
    assert.equal(h.vault.state(), 'open', 'trancar a tela não fecha o cofre: agentes seguem trabalhando');
    assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: 'errada-errada' })).status, 401);
    assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: PASS })).status, 200);
    assert.equal((await req(h, 'GET', '/api/state', s)).status, 200);
  });

  test('ações sensíveis pedem confirmação recente; autenticador com código que não se repete', async () => {
    h.db.run('UPDATE sessions SET auth_at = ?', new Date(Date.now() - 10 * 60_000).toISOString());
    const need = await req(h, 'POST', '/api/security/totp/start', s);
    assert.equal(need.status, 401); assert.equal(need.json.error, 'reauth');
    await req(h, 'POST', '/api/session/unlock', s, { password: PASS });
    const st = (await req(h, 'POST', '/api/security/totp/start', s)).json;
    assert.match(st.uri, /^otpauth:\/\/totp\/Ergon/); assert.match(st.qr, /^data:image\/png/);
    const t = Math.floor(Date.now() / 30_000);
    assert.equal((await req(h, 'POST', '/api/security/totp/confirm', s, { code: totpAt(st.secret, t) })).status, 200);
    const secretCell = h.db.raw.prepare('SELECT totp_secret FROM users').get() as { totp_secret: string };
    assert.match(secretCell.totp_secret, /^ev1\._\./, 'segredo do autenticador cifrado');
    // novo login exige o código; o mesmo código não vale duas vezes
    const l = await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: PASS });
    assert.equal(l.json.need2fa, true); assert.equal(l.json.methods.totp, true); assert.ok(!l.res.headers['set-cookie'], 'sem sessão antes do 2º fator');
    assert.equal((await req(h, 'POST', '/api/auth/login/totp', null, { challenge: l.json.challenge, code: totpAt(st.secret, t) })).status, 401, 'código já usado');
    const ok = await req(h, 'POST', '/api/auth/login/totp', null, { challenge: l.json.challenge, code: totpAt(st.secret, t + 1) });
    assert.equal(ok.status, 200); assert.ok(ok.res.headers['set-cookie']);
    // depois de entrar, o autenticador não é pedido de novo: a tela trancada abre com a senha
    assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: PASS })).status, 200, 'destrancar: só a senha');
    assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: 'errada-errada' })).status, 401);
  });

  test('freio progressivo: 5 erros seguidos → espera', async () => {
    throttle.reset();
    for (let i = 0; i < 5; i++) assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: `errada-${i}` })).status, 401);
    const r = await req(h, 'POST', '/api/auth/login', null, { username: 'alexandre', password: PASS });
    assert.equal(r.status, 429); assert.match(r.json.message, /Espere/);
    throttle.reset();
  });
});

const AGENT = 'token-do-ajudante-0123456789abcdef';
const agentCall = (h: Harness, url: string, body: unknown = {}, token = AGENT) =>
  h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-ergon-agent-token': token }, payload: JSON.stringify(body) });

describe('destravar sozinho: botão na tela + ajudante do computador', () => {
  test('instalação sem ajudante: nem aviso nem botão', async () => {
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, false);
    const missing = await req(h, 'POST', '/api/security/auto-unlock', s);
    assert.equal(missing.status, 409); assert.equal(missing.json.error, 'agent_missing');
    await h.close();
  });

  test('o botão pede, o ajudante busca a chave (mesmo chegando depois), e desligar invalida', async () => {
    throttle.reset();
    const h = await harness({ agentToken: AGENT });
    const { s } = await setup(h);
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true }); // o destrancar sozinho só vale com o trancamento ligado
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, true, 'aviso do primeiro acesso aparece');
    assert.equal((await agentCall(h, '/api/agent/hello', {}, 'x'.repeat(32))).statusCode, 401, 'token do ajudante confere');
    assert.equal((await agentCall(h, '/api/agent/hello', { label: 'Notebook', platform: 'windows' })).json().enroll, false);
    assert.equal((await agentCall(h, '/api/agent/auto-unlock/claim')).statusCode, 409, 'sem pedido, o ajudante não pega chave nenhuma');
    assert.equal((await req(h, 'POST', '/api/security/auto-unlock', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/security/status', s)).json.autoUnlockPending, true);
    assert.equal((await agentCall(h, '/api/agent/hello')).json().enroll, true);
    const claim = (await agentCall(h, '/api/agent/auto-unlock/claim')).json();
    assert.match(claim.key, /^[0-9a-f]{64}$/);
    assert.equal((await agentCall(h, '/api/agent/auto-unlock/claim')).statusCode, 409, 'pedido vale uma vez');
    assert.equal((await agentCall(h, '/api/agent/hello', { keyId: claim.id })).json().keyValid, true);
    const st = (await req(h, 'GET', '/api/security/status', s)).json;
    assert.equal(st.autoUnlock.length, 1); assert.equal(st.agent.label, 'Notebook'); assert.equal(st.autoUnlockPending, false);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, false, 'já ligado: sem aviso');
    assert.equal((await req(h, 'DELETE', '/api/security/auto-unlock', s)).status, 200);
    assert.equal((await agentCall(h, '/api/agent/hello', { keyId: claim.id })).json().keyValid, false, 'o ajudante sabe que a chave caiu e apaga a dele');
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, false, 'escolha feita: o aviso não volta');
    await h.close();
  });

  test('"agora não" no aviso fica registrado', async () => {
    throttle.reset();
    const h = await harness({ agentToken: AGENT });
    const { s } = await setup(h);
    await req(h, 'PUT', '/api/security/lock', s, { enabled: true }); // o destrancar sozinho só vale com o trancamento ligado
    await agentCall(h, '/api/agent/hello');
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, true);
    assert.equal((await req(h, 'POST', '/api/security/auto-unlock/asked', s, { choice: 'desligar' })).status, 200);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.autoUnlockPrompt, false);
    await h.close();
  });
});

describe('depois de reiniciar: selado até a senha, a frase ou o cofre do sistema', () => {
  let dir: string; let recovery: { phrase: string; ask: number[] }; let autoKey: string;
  before(async () => {
    throttle.reset();
    const h = await harness({ agentToken: AGENT });
    dir = h.dir;
    const r = await setup(h);
    recovery = r.recovery;
    await req(h, 'POST', '/api/security/recovery/confirm', r.s, { answers: answersFor(recovery) });
    await req(h, 'POST', '/api/tasks', r.s, { title: 'Sobrevive ao reinício cifrado' });
    // o ajudante do computador busca a chave do destravar sozinho depois que a pessoa liga o botão
    await agentCall(h, '/api/agent/hello');
    assert.equal((await req(h, 'POST', '/api/security/auto-unlock', r.s)).status, 200);
    autoKey = (await agentCall(h, '/api/agent/auto-unlock/claim')).json().key;
    await h.close();
  });
  beforeEach(() => throttle.reset());

  const gate = async () => {
    const cfg = testConfig(dir);
    const vault = new Vault(dir, KDF_TEST);
    assert.equal(vault.state(), 'sealed');
    const g = await buildGate(cfg, vault, () => new Db(cfg.dbPath, { key: vault.dbKey() }));
    return { cfg, vault, ...g };
  };
  const post = (app: Awaited<ReturnType<typeof gate>>['app'], url: string, body: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', origin: ORIGIN }, payload: JSON.stringify(body) });

  test('selado: só a tela de destrancar responde; senha errada não abre', async () => {
    const g = await gate();
    assert.equal((await g.app.inject({ method: 'GET', url: '/api/auth/state' })).json().sealed, true);
    assert.equal((await g.app.inject({ method: 'GET', url: '/api/state' })).statusCode, 423);
    assert.equal((await post(g.app, '/api/unseal', { username: 'alexandre', password: 'errada-123' })).statusCode, 401);
    assert.equal(g.vault.state(), 'sealed');
    const ok = await post(g.app, '/api/unseal', { username: 'alexandre', password: PASS });
    assert.equal(ok.statusCode, 200); assert.ok(ok.headers['set-cookie'], 'já entra com sessão');
    const db = await g.done;
    db.setCipher(g.vault.personKeySource(() => null)); // a senha abriu a instalação e a parte da pessoa
    assert.ok(db.all<{ title: string }>('SELECT title FROM tasks').some((t) => t.title === 'Sobrevive ao reinício cifrado'));
    db.close(); await g.app.close();
  });

  test('cofre do sistema: a chave do lançador abre sem senha', async () => {
    const g = await gate();
    assert.equal((await post(g.app, '/api/unseal/auto', { key: '0'.repeat(64) })).statusCode, 401);
    const r = await post(g.app, '/api/unseal/auto', { key: autoKey });
    assert.equal(r.statusCode, 200); assert.ok(!r.headers['set-cookie'], 'destrancar sozinho não cria sessão');
    (await g.done).close(); await g.app.close();
  });

  test('senha esquecida: a frase abre e define senha nova; a antiga deixa de valer', async () => {
    const g = await gate();
    assert.equal((await post(g.app, '/api/unseal/recovery', { username: 'alexandre', phrase: 'abacate '.repeat(24), newPassword: 'nova-senha-de-teste-forte' })).statusCode, 401);
    const r = await post(g.app, '/api/unseal/recovery', { username: 'alexandre', phrase: `  ${recovery.phrase.toUpperCase()} `, newPassword: 'girassol-trombone-neblina-azul' });
    assert.equal(r.statusCode, 200, r.body);
    (await g.done).close(); await g.app.close();
    const g2 = await gate();
    assert.equal((await post(g2.app, '/api/unseal', { username: 'alexandre', password: PASS })).statusCode, 401);
    assert.equal((await post(g2.app, '/api/unseal', { username: 'alexandre', password: 'girassol-trombone-neblina-azul' })).statusCode, 200);
    (await g2.done).close(); await g2.app.close();
  });
});

describe('instalação antiga sem criptografia', () => {
  test('depois do login, só a proteção responde; proteger cifra banco e dados já gravados', async () => {
    throttle.reset();
    const dir = tmpDir();
    const cfg = testConfig(dir);
    // banco em claro com um usuário (como uma instalação de antes desta versão)
    const old = new Db(cfg.dbPath); old.migrate();
    const r = await setupOwnerSvc(old, { username: 'alexandre', password: PASS, displayName: 'Alexandre' }, 6, KDF_TEST);
    old.run("INSERT INTO rules (id, workspace_id, text, status, created_at) VALUES ('rul_00000000000000000000000000000001', ?, 'segredo antigo em claro', 'active', ?)", r.workspaceId, new Date().toISOString());
    old.close();
    const h = await harness({}, { dir });
    const s = await loginAs(h, 'alexandre', PASS);
    assert.equal((await req(h, 'GET', '/api/boards', s)).status, 428);
    assert.equal((await req(h, 'GET', '/api/security/status', s)).json.protected, false);
    const p = await req(h, 'POST', '/api/security/protect', s, { password: PASS });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.recovery.phrase.split(' ').length, 24);
    assert.ok(Db.isEncryptedFile(cfg.dbPath));
    assert.ok(!fs.readFileSync(cfg.dbPath).includes(Buffer.from('segredo antigo em claro')));
    const cell = h.db.raw.prepare('SELECT text FROM rules').get() as { text: string };
    assert.match(cell.text, /^ev1\./, 'dado antigo cifrado por campo');
    assert.equal((await req(h, 'GET', '/api/rules', s)).json[0].text, 'segredo antigo em claro');
    assert.equal((await req(h, 'GET', '/api/boards', s)).status, 200);
    await h.close();
  });
});

describe('endereço, versão e o que a interface precisa saber', () => {
  test('quem abre por 127.0.0.1 vai para localhost (passkeys); a API não é redirecionada', async () => {
    const h = await harness();
    const page = await h.app.inject({ method: 'GET', url: '/tarefas?x=1', headers: { host: `127.0.0.1:${h.cfg.port}` } });
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, `http://localhost:${h.cfg.port}/tarefas?x=1`);
    const api = await h.app.inject({ method: 'GET', url: '/api/health', headers: { host: `127.0.0.1:${h.cfg.port}` } });
    assert.equal(api.statusCode, 200);
    await h.close();
  });

  test('/api/me traz 2º fatores, frase e trava; /api/version a versão única', async () => {
    throttle.reset();
    const h = await harness();
    const { s, recovery } = await setup(h);
    let me = (await req(h, 'GET', '/api/me', s)).json;
    assert.deepEqual(me.factors, { totp: false, passkeys: 0 });
    assert.equal(me.recovery, false, 'frase só vale depois de confirmada');
    assert.equal(me.rpId, 'localhost');
    await req(h, 'POST', '/api/security/recovery/confirm', s, { answers: answersFor(recovery) });
    me = (await req(h, 'GET', '/api/me', s)).json;
    assert.equal(me.recovery, true);
    const v = (await req(h, 'GET', '/api/version', s)).json;
    assert.equal(v.version, VERSION);
    assert.equal(v.updateAvailable, false, 'sem manifesto configurado, não consulta nada');
    await h.close();
  });

  test('comparação de versões', () => {
    assert.ok(newer('0.2.0', '0.1.9'));
    assert.ok(newer('1.0.0', '1.0.0-beta.3'));
    assert.ok(newer('1.0.0-beta.10', '1.0.0-beta.9'));
    assert.ok(!newer('0.2.0', '0.2.0'));
    assert.ok(!newer('0.1.0', '0.2.0'));
  });
});

describe('modo nuvem: configuração insegura não sobe', () => {
  test('exige https, cookie seguro, token de configuração e nada só-local', () => {
    assert.throws(() => loadConfig({ ERGON_MODE: 'cloud' } as NodeJS.ProcessEnv), /https.*COOKIE_SECURE.*SETUP_TOKEN.*FIXTURES/);
    assert.throws(() => loadConfig({ ERGON_MODE: 'cloud', ERGON_PUBLIC_URL: 'https://app.exemplo.com', ERGON_COOKIE_SECURE: 'true', ERGON_SETUP_TOKEN: 'x'.repeat(32), ERGON_FIXTURES_ENABLED: 'false', ERGON_WHATSAPP_ENABLED: 'true' } as NodeJS.ProcessEnv), /WhatsApp/);
    const ok = loadConfig({ ERGON_MODE: 'cloud', ERGON_PUBLIC_URL: 'https://app.exemplo.com', ERGON_COOKIE_SECURE: 'true', ERGON_SETUP_TOKEN: 'x'.repeat(32), ERGON_FIXTURES_ENABLED: 'false' } as NodeJS.ProcessEnv);
    assert.equal(ok.mode, 'cloud');
  });
});

describe('nuvem: autenticador ou passkey obrigatórios', () => {
  test('sem 2º fator, a sessão só serve para cadastrar um', async () => {
    throttle.reset();
    const h = await harness({ mode: 'cloud' });
    const { s } = await setup(h);
    const blocked = await req(h, 'GET', '/api/boards', s);
    assert.equal(blocked.status, 428); assert.equal(blocked.json.error, 'enroll_2fa');
    const st = (await req(h, 'POST', '/api/security/totp/start', s)).json;
    assert.equal((await req(h, 'POST', '/api/security/totp/confirm', s, { code: totpAt(st.secret, Math.floor(Date.now() / 30_000)) })).status, 200);
    assert.equal((await req(h, 'GET', '/api/boards', s)).status, 200);
    const pk = await req(h, 'POST', '/api/security/passkeys/options', s);
    assert.equal(pk.json.options.rp.id, 'localhost', 'passkey presa ao nome do endereço, nunca a um IP');
    await h.close();
  });
});


describe('ferramentas que executam código nunca saem num clique', () => {
  test('proposta da coordenação para liberar Terminal vira pedido de permissão (com a senha); tirar continua simples', async () => {
    const { parseProposals, decideProposal, recordProposals } = await import('../src/services/proposals.ts');
    const ps = parseProposals('[[ferramenta agente="Hipátia" ferramenta="terminal" acao="dar"]] [[ferramenta agente="Hipátia" ferramenta="web" acao="dar"]] [[ferramenta agente="Hipátia" ferramenta="terminal" acao="tirar"]]');
    assert.deepEqual(ps.map((p) => p.kind), ['permission', 'tools', 'tools']);
    throttle.reset();
    const h = await harness();
    const { s } = await setup(h);
    // proposta antiga (gravada antes da regra) também não libera sem senha
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: null, runId: null }, [{ kind: 'tools', agent: 'Hipátia', tool: 'terminal', action: 'dar' }]);
    const id = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'tools' ORDER BY created_at DESC LIMIT 1")!.id;
    const r = decideProposal(h.db, h.bus, s.workspaceId, s.userId, id, 'apply');
    assert.equal(r.status, 'failed'); assert.match(r.result, /só com a sua senha/);
    const tools = JSON.parse(h.db.get<{ tools: string }>("SELECT tools FROM agents WHERE workspace_id = ? AND char_key = 'hipatia'", s.workspaceId)!.tools ?? '[]');
    assert.ok(!tools.includes('terminal'));
    await h.close();
  });
});

describe('logs sem segredos', () => {
  test('código de autorização e tokens na URL não vão para o log', () => {
    const u = redactUrl('/api/integrations/microsoft/callback?code=1.AcoA-segredo&state=abc123&session_state=xyz');
    assert.equal(u, '/api/integrations/microsoft/callback?code=[redigido]&state=[redigido]&session_state=[redigido]');
    assert.equal(redactUrl('/api/tasks?limit=20'), '/api/tasks?limit=20', 'parâmetros comuns ficam');
    assert.equal(redactUrl('/x?access_token=t&ok=1#y'), '/x?access_token=[redigido]&ok=1#y');
  });
});
