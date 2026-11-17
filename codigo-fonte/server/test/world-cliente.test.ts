/**
 * O cliente do Ergon World (server/src/world) ponta a ponta contra um World de mentira (fake-world.ts): conectar com
 * conta nova, com as mesmas credenciais do Ergon (senha local conferida aqui antes, nada sai se ela estiver errada) e
 * com uma conta que já existe em outro computador; o limite de aparelhos; só o workspace escolhido tem o plano e
 * sincroniza (cifrado); sem trava de escrita (World fora do ar não impede nada local, e o Sync continua depois); e
 * desconectar.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const PW = 'senha-local-123';
const FRASE = 'frase de recuperação do sync da ana para o teste';
let world: FakeWorld;

before(async () => {
  world = await new FakeWorld().start();
  process.env.ERGON_WORLD_URL = world.url;
});
after(async () => { process.env.ERGON_WORLD_URL = ''; await world.stop(); });

const novoWorkspace = async (h: Harness, s: Session, name: string): Promise<string> => {
  const r = await req(h, 'POST', '/api/workspaces', s, { name });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.workspaceId as string;
};
const abrir = async (h: Harness, s: Session, ws: string) => {
  assert.equal((await req(h, 'POST', '/api/session/workspace', s, { workspaceId: ws })).status, 200);
  s.workspaceId = ws;
};
const tarefas = (h: Harness, ws: string) => h.db.all<{ title: string }>('SELECT title FROM tasks WHERE workspace_id = ? AND archived = 0', ws).map((t) => t.title);

describe('sem o endereço do World', () => {
  test('o estado diz "não configurado", as rotas do World não existem e tudo local funciona', async () => {
    process.env.ERGON_WORLD_URL = '';
    try {
      const h = await harness(); const s = await setupOwner(h);
      const d = await req(h, 'GET', '/api/distribution');
      assert.deepEqual([d.json.distribution, d.json.world.available, d.json.world.configured], ['community', true, false]);
      const st = await req(h, 'GET', '/api/world/status', s);
      assert.deepEqual([st.status, st.json.configured, st.json.link], [200, false, null]);
      assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'login', email: 'a@b.test', password: 'x'.repeat(12) })).status, 404);
      assert.equal((await req(h, 'POST', '/api/tasks', s, { title: 'Funciona sem o World' })).status, 201);
      await h.close();
    } finally { process.env.ERGON_WORLD_URL = world.url; }
  });
});

describe('cliente do Ergon World', () => {
  let pc1: Harness; let a1: Session; let casa = ''; let trabalho = '';

  test('conta nova: o World cria a conta, o aparelho prova a posse da chave e a conta liga ao perfil local', async () => {
    pc1 = await harness(); a1 = await setupOwner(pc1, 'ana', PW);
    casa = a1.workspaceId;
    trabalho = await novoWorkspace(pc1, a1, 'Trabalho');
    await abrir(pc1, a1, casa);
    const st0 = (await req(pc1, 'GET', '/api/world/status', a1)).json;
    assert.deepEqual([st0.configured, st0.link], [true, null]);
    assert.deepEqual(st0.localWorkspaces.map((w: { id: string }) => w.id).sort(), [casa, trabalho].sort());

    const curta = await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'ana@exemplo.test', password: 'curta', displayName: 'Ana' });
    assert.deepEqual([curta.status, curta.json.error], [400, 'password_short']);
    assert.equal(world.calls('/v1/accounts'), 0, 'senha curta nem sai daqui');

    const r = await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'Ana@Exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.accountEmail, r.json.emailVerified], ['ana@exemplo.test', false]);
    const dev = [...world.devices.values()][0];
    assert.equal(dev.status, 'active', 'o aparelho assinou o desafio com a chave dele');
    assert.deepEqual(world.bindings.map((x) => x.localPersonId), [a1.userId]);
    const raw = pc1.db.raw.prepare('SELECT device_keys, session_token FROM world_links WHERE user_id = ?').get(a1.userId) as { device_keys: string; session_token: string };
    assert.ok(raw.device_keys.startsWith('ev1.') && raw.session_token.startsWith('ev1.'), 'chaves e sessão cifradas com a chave da pessoa');
    assert.ok(!JSON.stringify(world.log).includes(PW), 'a senha local não foi ao World');

    const st = (await req(pc1, 'GET', '/api/world/status', a1)).json;
    assert.deepEqual([st.link.accountEmail, st.link.emailVerified, st.link.boundWorkspaceId], ['ana@exemplo.test', false, null]);
    assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).json.error, 'world_already_linked');

    assert.equal((await req(pc1, 'POST', '/api/world/account/email/verify', a1, { code: '000000' })).json.error, 'invalid_code');
    assert.equal((await req(pc1, 'POST', '/api/world/account/email/verify', a1, { code: '123456' })).status, 200);
    assert.equal((await req(pc1, 'GET', '/api/world/status', a1)).json.link.emailVerified, true);
  });

  test('conta nova com as mesmas credenciais do Ergon: a senha local é conferida aqui antes; errada, nada chega ao World', async () => {
    const h = await harness(); const b = await setupOwner(h, 'bruno', PW);
    const antes = world.log.length;
    const errada = await req(h, 'POST', '/api/world/connect', b, { mode: 'local', email: 'bruno@exemplo.test', localPassword: 'senha-errada-999' });
    assert.deepEqual([errada.status, errada.json.error], [400, 'invalid_local_password']);
    assert.equal(world.log.length, antes, 'nenhum pedido ao World');
    const ok = await req(h, 'POST', '/api/world/connect', b, { mode: 'local', email: 'bruno@exemplo.test', localPassword: PW });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const enviados = world.log.slice(antes).filter((x) => x.path === '/v1/accounts');
    assert.equal(enviados.length, 1, 'a senha vai uma vez, para criar a conta');
    assert.deepEqual(enviados[0].body, { email: 'bruno@exemplo.test', password: PW, displayName: 'Alexandre' }, 'o nome local, o e-mail e a senha local');
    assert.equal([...world.accounts.values()].find((a) => a.email === 'bruno@exemplo.test')?.password, PW);
    // o login local continua igual: a conta do World não troca a senha nem o acesso daqui
    assert.equal((await req(h, 'POST', '/api/auth/login', null, { username: 'bruno', password: PW })).status, 200);
    const dup = await req(h, 'POST', '/api/world/unlink', b, {});
    assert.equal(dup.status, 200);
    const outra = await req(h, 'POST', '/api/world/connect', b, { mode: 'signup', email: 'bruno@exemplo.test', password: 'outra-senha-123', displayName: 'Bruno' });
    assert.deepEqual([outra.status, outra.json.error], [409, 'email_in_use']);
    const login = await req(h, 'POST', '/api/world/connect', b, { mode: 'login', email: 'bruno@exemplo.test', password: 'errada-mas-longa' });
    assert.deepEqual([login.status, login.json.error], [400, 'invalid_credentials'], 'sem 401: a tela não confunde com a sessão local');
    await h.close();
  });

  test('só o workspace escolhido é do World: plano, créditos, Jobs e Sync; os outros ficam locais', async () => {
    // nada ligado ainda: nenhum workspace tem plano nem sincroniza
    assert.equal((await req(pc1, 'GET', '/api/world/billing', a1)).json.workspaceId, null);
    assert.deepEqual((await req(pc1, 'GET', '/api/world/sync', a1)).json, { bound: false, enabled: false });
    assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', a1, {})).json.error, 'world_not_bound');

    const bind = await req(pc1, 'POST', '/api/world/bind', a1, { workspaceId: trabalho });
    assert.equal(bind.status, 200, JSON.stringify(bind.json));
    const sws = bind.json.syncWorkspaceId as string;
    assert.match(sws, /^sws_[a-f0-9]{32}$/);
    // links por conta: um segundo workspace também liga (o plano diz quantos têm direito); desligar é por workspace
    const b2 = await req(pc1, 'POST', '/api/world/bind', a1, { workspaceId: casa });
    assert.equal(b2.status, 200, JSON.stringify(b2.json));
    assert.deepEqual((await req(pc1, 'GET', '/api/world/status', a1)).json.link.boundWorkspaceIds, [trabalho, casa]);
    assert.equal((await req(pc1, 'DELETE', `/api/world/bind?workspaceId=${casa}`, a1)).status, 200);
    assert.deepEqual((await req(pc1, 'GET', '/api/world/status', a1)).json.link.boundWorkspaceIds, [trabalho]);

    // no workspace "Casa" (aberto agora), nada do World
    const st = (await req(pc1, 'GET', '/api/world/status', a1)).json;
    assert.deepEqual([st.link.boundWorkspaceId, st.link.boundWorkspaceName, st.link.currentIsBound], [trabalho, 'Trabalho', false]);
    assert.equal((await req(pc1, 'GET', '/api/world/billing', a1)).json.workspaceId, null);
    assert.equal((await req(pc1, 'GET', '/api/world/jobs', a1)).json.reason, 'sem_workspace');
    assert.equal((await req(pc1, 'POST', '/api/world/billing/checkout', a1, { sku: 'world_pro', idempotencyKey: 'k1' })).json.error, 'world_not_bound');
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.error, 'world_not_bound');

    // no "Trabalho": o plano (pagamento pela página do Stripe que o World gera), créditos e Sync
    await abrir(pc1, a1, trabalho);
    assert.equal((await req(pc1, 'GET', '/api/world/billing', a1)).json.workspaceId, sws);
    const co = await req(pc1, 'POST', '/api/world/billing/checkout', a1, { sku: 'world_pro', idempotencyKey: 'k2' });
    assert.equal(co.status, 200); assert.match(co.json.url, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(world.log.at(-1)!.body.workspaceId, sws, 'a compra é do workspace World ligado');
    const en = await req(pc1, 'POST', '/api/world/sync/enable', a1, { recoveryPhrase: FRASE });
    assert.deepEqual([en.status, en.json.syncWorkspaceId], [200, sws]);
    assert.equal((await req(pc1, 'POST', '/api/tasks', a1, { title: 'Levar o anel a Mordor' })).status, 201);
    const sem = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.deepEqual([sem.status, sem.json.error], [402, 'world_inactive'], 'sem o plano pago, nada vai');
    world.activate(sws);
    assert.equal((await req(pc1, 'GET', '/api/world/wallet', a1)).json.available, '1000.000000');
    const p = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.equal(p.status, 200, JSON.stringify(p.json)); assert.ok(p.json.sent.tasks >= 1);

    // tarefa do workspace local "Casa": nunca vai
    await abrir(pc1, a1, casa);
    assert.equal((await req(pc1, 'POST', '/api/tasks', a1, { title: 'Comprar pão em casa' })).status, 201);
    await abrir(pc1, a1, trabalho);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.sent.tasks, 0, 'nada novo no Trabalho');
    assert.equal([...world.workspaces.keys()].filter((k) => world.workspaces.get(k)!.owner === dev1Account()).length, 2, 'o do Trabalho e o da Casa (ligado e desligado acima)');
    const tudo = JSON.stringify([...world.workspaces.values()].map((w) => w.changes));
    for (const x of ['Mordor', 'Comprar pão', 'Trabalho']) assert.ok(!tudo.includes(x), `o World guarda sem ler: ${x}`);
  });

  let pc2: Harness; let a2: Session;
  test('outro computador: entra com a mesma conta, escolhe o workspace local e sincroniza o do World', async () => {
    pc2 = await harness(); a2 = await setupOwner(pc2, 'ana-notebook', 'senha-do-notebook-123');
    const r = await req(pc2, 'POST', '/api/world/connect', a2, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = (await req(pc2, 'GET', '/api/world/status', a2)).json;
    const sws = st.link.workspaces[0].workspaceId as string;
    assert.equal(st.link.workspaces.length, 2);
    assert.equal((await req(pc2, 'POST', '/api/world/bind', a2, { workspaceId: a2.workspaceId, syncWorkspaceId: sws })).status, 200);
    const s0 = (await req(pc2, 'GET', '/api/world/sync', a2)).json;
    assert.deepEqual([s0.bound, s0.enabled, s0.origin, s0.syncWorkspaceId], [true, false, 'joined', sws]);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/enable', a2, {})).json.error, 'sync_join', 'não gera outra chave para um workspace que já existe');
    assert.equal((await req(pc2, 'POST', '/api/world/sync/join', a2, {})).status, 404, 'sem chave para este aparelho ainda');
    // o PC 1 entrega a chave a este aparelho (ou a frase de recuperação abriria)
    assert.equal((await req(pc1, 'POST', '/api/world/sync/share', a1, {})).json.shared, 1);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/join', a2, {})).status, 200);
    const prev = await req(pc2, 'POST', '/api/world/sync/pull', a2, {});
    assert.ok(prev.json.incoming.tasks >= 1);
    assert.ok(!tarefas(pc2, a2.workspaceId).includes('Levar o anel a Mordor'), 'prévia não muda nada');
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json.applied, true);
    const aqui = tarefas(pc2, a2.workspaceId);
    assert.ok(aqui.includes('Levar o anel a Mordor'));
    assert.ok(!aqui.includes('Comprar pão em casa'), 'o workspace que ficou local no PC 1 não chegou');
  });

  test('frase de recuperação: errada não abre a chave; a certa abre', async () => {
    const h = await harness(); const s = await setupOwner(h, 'ana-tablet', 'senha-do-tablet-123');
    world.sessionLimit = 3;
    try {
      assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
      const sws = (await req(h, 'GET', '/api/world/status', s)).json.link.workspaces[0].workspaceId;
      await req(h, 'POST', '/api/world/bind', s, { syncWorkspaceId: sws });
      assert.equal((await req(h, 'POST', '/api/world/sync/join', s, { recoveryPhrase: 'frase errada mas comprida o bastante' })).status, 400);
      assert.equal((await req(h, 'POST', '/api/world/sync/join', s, { recoveryPhrase: FRASE })).status, 200);
      await req(h, 'POST', '/api/world/unlink', s, {});
    } finally { world.sessionLimit = 2; }
    await h.close();
  });

  test('limite de aparelhos: a conexão recusada mostra quais estão conectados e entra liberando o escolhido', async () => {
    const h = await harness(); const s = await setupOwner(h, 'ana-trabalho', 'senha-do-trabalho-123');
    const r = await req(h, 'POST', '/api/world/connect', s, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' });
    assert.deepEqual([r.status, r.json.error], [409, 'session_limit']);
    const lim = (await req(h, 'GET', '/api/world/status', s)).json.deviceLimit;
    assert.equal(lim.kind, 'session_limit'); assert.equal(lim.devices.length, 2); assert.equal(lim.canRetry, true);
    const notebook = (await req(pc2, 'GET', '/api/world/status', a2)).json.link.deviceId;
    const ok = await req(h, 'POST', '/api/world/connect/device', s, { endSessionsOf: notebook });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal((await req(h, 'GET', '/api/world/status', s)).json.deviceLimit, null);
    assert.equal(world.devices.get(notebook)!.session, null, 'a sessão do notebook foi encerrada');
    await req(h, 'POST', '/api/world/unlink', s, {});
    await h.close();
  });

  test('sem trava de escrita: com o World fora do ar, tudo local funciona; só o Sync espera e continua depois', async () => {
    await world.stop();
    for (const ws of [trabalho, casa]) {
      await abrir(pc1, a1, ws);
      assert.equal((await req(pc1, 'POST', '/api/tasks', a1, { title: `Sem rede em ${ws.slice(0, 8)}` })).status, 201);
      assert.equal(pc1.db.workspaceOpen(ws), true, 'tarefas de fundo seguem');
    }
    await abrir(pc1, a1, trabalho);
    assert.equal((await req(pc1, 'POST', '/api/agents', a1, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
    const off = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.deepEqual([off.status, off.json.error], [503, 'world_offline']);
    assert.equal((await req(pc1, 'GET', '/api/world/status', a1)).status, 200);
    await world.start();
    const back = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.equal(back.json.sent.tasks, 1, 'a tarefa feita sem rede foi agora');
  });

  test('desconectar: o aparelho sai da conta, o workspace volta a ser só local e os dados ficam', async () => {
    await abrir(pc1, a1, trabalho);
    const antes = tarefas(pc1, trabalho);
    const devId = (await req(pc1, 'GET', '/api/world/status', a1)).json.link.deviceId as string;
    assert.equal((await req(pc1, 'POST', '/api/world/unlink', a1, {})).status, 200);
    assert.equal(world.devices.get(devId)!.status, 'revoked');
    assert.equal((await req(pc1, 'GET', '/api/world/status', a1)).json.link, null);
    for (const t of ['world_links', 'world_sync', 'world_workspace_ids', 'world_sync_records']) assert.equal(pc1.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n, 0, t);
    assert.deepEqual(tarefas(pc1, trabalho), antes);
    assert.equal((await req(pc1, 'GET', '/api/world/sync', a1)).json.bound, false);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.error, 'world_not_bound');
    assert.equal((await req(pc1, 'GET', '/api/world/billing', a1)).json.workspaceId, null);
    assert.equal((await req(pc1, 'POST', '/api/tasks', a1, { title: 'Depois de desconectar' })).status, 201);
    await pc1.close(); await pc2.close();
  });
});

function dev1Account(): string { return [...world.accounts.values()].find((a) => a.email === 'ana@exemplo.test')!.id; }
