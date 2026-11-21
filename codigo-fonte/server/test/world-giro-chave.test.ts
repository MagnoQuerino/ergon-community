/**
 * Giro da chave do workspace World depois que alguém sai (world/src/sync.ts: removeMember marca rotation_required; o
 * push kind 'rotation' com keyVersion + 1 libera). Três pessoas: a Ana (dona) tira a Bia; o Caio fica. A chave nova
 * nasce no computador da Ana, vai cifrada para os aparelhos de quem ficou, e o giro leva as chaves de antes: o Caio e
 * um aparelho novo da Ana leem o histórico inteiro; a Bia, mesmo com o cifrado na mão, não abre nada depois do giro.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openChange } from '../src/world/sync-crypto.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('Giro da chave do workspace World depois que alguém sai', () => {
  let world: FakeWorld; let pc1: Harness; let ana: Session; let pc2: Harness; let bia: Session; let pc3: Harness; let caio: Session; let pc4: Harness | null = null; let ana2: Session;
  let sws = ''; let biaAcc = '';
  const FRASE = 'frase de recuperação do workspace da ana para o teste';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; for (const h of [pc1, pc2, pc3, pc4]) await h?.close(); await world.stop(); });
  const accOf = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;
  const temTarefa = async (h: Harness, s: Session, titulo: string) => h.db.all<{ title: string }>('SELECT title FROM tasks WHERE workspace_id = ?', s.workspaceId).some((t) => t.title === titulo);
  const agentes = (h: Harness, s: Session) => h.db.all<{ name: string }>("SELECT name FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId).map((a) => a.name);
  const conectar = async (h: Harness, s: Session, email: string, mode: 'signup' | 'login' = 'signup') =>
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode, email, password: 'senha-do-world-123', ...(mode === 'signup' ? { displayName: email.split('@')[0] } : {}) })).status, 200);
  const entrar = async (h: Harness, s: Session, role: string) => {
    const inv = await req(pc1, 'POST', '/api/world/members/invites', ana, { role });
    assert.equal((await req(h, 'POST', '/api/world/invites/accept', s, { token: inv.json.token })).status, 200);
    assert.equal((await req(h, 'POST', '/api/world/bind', s, { syncWorkspaceId: sws })).status, 200);
  };

  test('a Ana liga o Sync com a frase; a Bia e o Caio entram e recebem a chave', async () => {
    pc1 = await harness(); ana = await setupOwner(pc1, 'ana', 'senha-da-ana-123'); await conectar(pc1, ana, 'ana@exemplo.test');
    sws = (await req(pc1, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
    assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', ana, { recoveryPhrase: FRASE })).status, 200);
    world.activate(sws, 'world_team', 8);
    assert.equal((await req(pc1, 'POST', '/api/agents', ana, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', ana, {})).status, 200);
    pc2 = await harness(); bia = await setupOwner(pc2, 'bia', 'senha-da-bia-123'); await conectar(pc2, bia, 'bia@exemplo.test');
    pc3 = await harness(); caio = await setupOwner(pc3, 'caio', 'senha-do-caio-123'); await conectar(pc3, caio, 'caio@exemplo.test');
    await entrar(pc2, bia, 'editor'); await entrar(pc3, caio, 'editor');
    biaAcc = accOf('bia@exemplo.test');
    assert.equal((await req(pc1, 'POST', '/api/world/sync/share', ana, {})).json.shared, 2);
    for (const [h, s] of [[pc2, bia], [pc3, caio]] as const) {
      assert.equal((await req(h, 'POST', '/api/world/sync/join', s, {})).status, 200);
      assert.equal((await req(h, 'POST', '/api/world/sync/pull', s, { apply: true })).status, 200);
      assert.ok(agentes(h, s).includes('Frodo'));
    }
    // o Caio cria algo antes do giro (cifrado com a chave 1); a Ana ainda não recebeu. (Uma tarefa: a equipe é só do dono
    // — o esqueleto de um colaborador nem vai nem é aplicado, world/sync-local.ts)
    assert.equal((await req(pc3, 'POST', '/api/tasks', caio, { title: 'Colher os tomates' })).status, 201);
    assert.equal((await req(pc3, 'POST', '/api/world/sync/push', caio, {})).status, 200);
    assert.equal((await req(pc3, 'GET', '/api/world/sync', caio)).json.keyVersion, 1);
  });

  test('quem edita não gira a chave', async () => {
    const r = await req(pc3, 'POST', '/api/world/sync/rotate', caio, {});
    assert.deepEqual([r.status, r.json.error], [403, 'sync_forbidden']);
    assert.equal(world.rotations.length, 0);
  });

  test('a Ana tira a Bia: a chave gira na hora, vai para o Caio e os envios voltam', async () => {
    const r = await req(pc1, 'DELETE', `/api/world/members/${biaAcc}`, ana);
    assert.deepEqual([r.status, r.json.rotated, r.json.rotationRequired, r.json.keyVersion, r.json.shared], [200, true, false, 2, 1]);
    assert.deepEqual(world.rotations, [{ ws: sws, keyVersion: 2, by: accOf('ana@exemplo.test') }]);
    assert.equal(world.workspaces.get(sws)!.rotationRequired, false, 'o World soube que o giro foi feito');
    const st = (await req(pc1, 'GET', '/api/world/sync', ana)).json;
    assert.deepEqual([st.keyVersion, st.rotationPending, st.recoveryOutdated], [2, false, true], 'a frase ainda abre só a chave antiga');
    assert.deepEqual((await req(pc1, 'GET', '/api/world/members', ana)).json.awaitingKey, [], 'ninguém que ficou espera a chave');
    assert.equal((await req(pc1, 'POST', '/api/world/sync/recovery', ana, { recoveryPhrase: 'curta' })).status, 400);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/recovery', ana, { recoveryPhrase: FRASE })).json.recoveryOutdated, false);
    // a Ana recebe o que o Caio mandou antes do giro (chave 1) e envia com a chave 2
    assert.equal((await req(pc1, 'POST', '/api/world/sync/pull', ana, { apply: true })).status, 200);
    assert.ok(await temTarefa(pc1, ana, 'Colher os tomates'), 'o que o Caio mandou com a chave 1 chegou');
    assert.equal((await req(pc1, 'POST', '/api/agents', ana, { name: 'Merry', role: 'Logística' })).status, 201);
    const p = await req(pc1, 'POST', '/api/world/sync/push', ana, {});
    assert.equal(p.status, 200);
    const w = world.workspaces.get(sws)!;
    assert.equal(w.changes.at(-1)!.keyVersion, 2);
    assert.ok(!JSON.stringify(w.changes).includes('Merry'), 'o World continua sem ler');
  });

  test('a Bia, mesmo com o cifrado na mão, não abre nada depois do giro', async () => {
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', bia, {})).status, 404);
    const chave = Buffer.from(pc2.db.get<{ sync_key: string }>('SELECT sync_key FROM world_sync WHERE workspace_id = ?', bia.workspaceId)!.sync_key, 'base64');
    const w = world.workspaces.get(sws)!;
    const antes = w.changes.find((c) => c.keyVersion === 1 && c.kind === 'snapshot')!;
    assert.ok(openChange(chave, sws, antes as never), 'o que ela já tinha, ela já tinha');
    for (const c of w.changes.filter((x) => (x.keyVersion as number) >= 2)) assert.throws(() => openChange(chave, sws, c as never), `versão ${c.version}`);
  });

  test('o Caio recebe a chave nova sozinho ao receber as mudanças e volta a enviar', async () => {
    assert.equal((await req(pc3, 'POST', '/api/tasks', caio, { title: 'Podar a cerca' })).status, 201);
    assert.equal((await req(pc3, 'POST', '/api/world/sync/push', caio, {})).json.error, 'key_version', 'com a chave velha, o World recusa');
    const r = await req(pc3, 'POST', '/api/world/sync/pull', caio, { apply: true });
    assert.equal(r.status, 200);
    assert.ok(agentes(pc3, caio).includes('Merry'));
    assert.equal((await req(pc3, 'GET', '/api/world/sync', caio)).json.keyVersion, 2);
    const p = await req(pc3, 'POST', '/api/world/sync/push', caio, {});
    assert.equal(p.status, 200); assert.ok(p.json.sent.tasks >= 1);
    assert.equal(world.workspaces.get(sws)!.changes.at(-1)!.keyVersion, 2, 'o Caio envia com a chave nova');
  });

  test('um computador novo da Ana entra pela frase depois do giro e lê o histórico inteiro', async () => {
    pc4 = await harness(); ana2 = await setupOwner(pc4, 'ana-notebook', 'senha-do-notebook-123');
    await conectar(pc4, ana2, 'ana@exemplo.test', 'login');
    assert.equal((await req(pc4, 'POST', '/api/world/bind', ana2, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(pc4, 'POST', '/api/world/sync/join', ana2, { recoveryPhrase: FRASE })).status, 200);
    const prev = await req(pc4, 'POST', '/api/world/sync/pull', ana2, {});
    assert.equal(prev.status, 200, 'abre as mudanças das chaves 1 e 2');
    assert.ok(prev.json.preview.agents.some((x: { name: string }) => x.name === 'Merry'), 'o esqueleto da chave 2 chega');
    assert.equal((await req(pc4, 'POST', '/api/world/sync/pull', ana2, { apply: true })).status, 200);
    for (const n of ['Frodo', 'Merry']) assert.ok(agentes(pc4, ana2).includes(n), n);
    assert.ok(await temTarefa(pc4, ana2, 'Colher os tomates'), 'o que o Caio mandou com a chave 1');
    const ring = pc4.db.get<{ old_keys: string }>('SELECT old_keys FROM world_sync WHERE workspace_id = ?', ana2.workspaceId)!.old_keys;
    assert.deepEqual(Object.keys(JSON.parse(ring)), ['1'], 'aprendeu a chave 1 pelo giro');
  });

  test('girar de novo: a chave 3 leva a 1 e a 2; outro computador que já girou só busca a nova', async () => {
    const r = await req(pc1, 'POST', '/api/world/sync/rotate', ana, {});
    assert.deepEqual([r.status, r.json.rotated, r.json.keyVersion], [200, true, 3]);
    const again = await req(pc4!, 'POST', '/api/world/sync/rotate', ana2, {});
    assert.deepEqual([again.status, again.json.rotated, again.json.keyVersion], [200, false, 3]);
    assert.equal(world.rotations.length, 2);
  });
});
