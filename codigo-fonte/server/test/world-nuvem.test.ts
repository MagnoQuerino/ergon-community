/**
 * Nuvem do Ergon World ("Subir o WS para o World"), a partida do contêiner de ponta a ponta com DOIS Ergons de verdade
 * (o computador da pessoa e o contêiner, em modo nuvem), o World de mentira (fake-world.ts) e um relé falso para cada um:
 * - o contêiner sobe sem ninguém: cria a conta local e o cofre (a chave fica no World), entra na conta do dono como
 *   aparelho-nuvem (fora do limite de aparelhos) e espera a chave da sincronia;
 * - o computador, sozinho, avisa que está aberto, entrega a chave ao aparelho-nuvem e sincroniza;
 * - o contêiner recebe a equipe e as conversas, liga o Ergon AI no motor, entra no serviço dos canais e só então diz
 *   "pronto"; o computador declara a instalação dele como reserva dos canais;
 * - o que nasce na nuvem volta ao computador; fechar o computador avisa o World; na partida seguinte o cofre abre com a
 *   chave guardada no World.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { KDF_TEST } from '../src/security/crypto.ts';
import { Vault } from '../src/security/keys.ts';
import { createWorld } from '../src/world/index.ts';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

let world: FakeWorld; let pc: Harness; let dono: Session; let nuvem: Harness; let relePc: ReleFalso; let releNuvem: ReleFalso; let sws = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_WORKSPACE', 'ERGON_CLOUD_BOOT_TOKEN', 'ERGON_NUVEM_PASSO_MS', 'ERGON_NUVEM_CICLO_MS', 'ERGON_NUVEM_CANAIS_MS', 'ERGON_WORLD_AUTOSYNC_MS'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const motor = { conexoes: 0 };
const control = { health: async () => true, accounts: async () => [], byok: async () => ({ providers: [], custom: [], ergonAi: true }), ergonAi: async () => { motor.conexoes++; }, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 30_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(40); }
  assert.fail(`${msg} (estados da nuvem: ${JSON.stringify(world.clouds.get(sws)?.states)})`);
}
const AJUSTES = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, pedidoMs: 2000, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } };

before(async () => {
  world = await new FakeWorld().start(); relePc = await ReleFalso.iniciar(); releNuvem = await ReleFalso.iniciar();
  for (const r of [relePc, releNuvem]) r.plataformas = { telegram: true, discord: false };
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_NUVEM_PASSO_MS: '120', ERGON_NUVEM_CICLO_MS: '250', ERGON_NUVEM_CANAIS_MS: '20000', ERGON_WORLD_AUTOSYNC_MS: '250' });
});
after(async () => {
  await nuvem?.close(); await pc?.close(); await relePc?.parar(); await releNuvem?.parar(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('o computador liga o workspace ao World com a sincronia; a nuvem é ativada', async () => {
  pc = await harness({ teamsRelayUrl: relePc.base }); pc.teamsApp.ajustes = AJUSTES;
  dono = await setupOwner(pc, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc, 'POST', '/api/world/connect', dono, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc, 'POST', '/api/world/bind', dono, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc, 'POST', '/api/world/sync/enable', dono, { recoveryPhrase: 'frase de recuperação da ana para a nuvem' })).status, 200);
  world.activate(sws);
  assert.equal((await req(pc, 'POST', '/api/agents', dono, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
  const frodo = pc.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = 'Frodo'", dono.workspaceId)!.id;
  const cv = await req(pc, 'POST', '/api/conversations', dono, { agentId: frodo, title: 'Plano da viagem' });
  pc.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES ('msg_pcaaaaaaaaaaaaaaa', ?, ?, 'user', ?, ?, 'local', ?)",
    dono.workspaceId, cv.json.id, dono.userId, pc.db.seal(dono.workspaceId, 'Qual o caminho mais seguro?'), new Date().toISOString());
  assert.equal((await req(pc, 'POST', '/api/world/sync/push', dono, {})).status, 200);
  await pc.teamsApp.start();
  await ate(() => relePc.conectado(), 'o computador não entrou no serviço dos canais');
  // a pessoa contrata: a nuvem do workspace fica ativa e o orquestrador entrega o token de partida ao contêiner
  Object.assign(process.env, { ERGON_WORLD_WORKSPACE: sws, ERGON_CLOUD_BOOT_TOKEN: world.nuvem(sws) });
});

test('o contêiner sobe sem ninguém, recebe a chave do computador, os dados e fica pronto; o computador o declara reserva dos canais', async () => {
  nuvem = await harness({ mode: 'cloud', teamsRelayUrl: releNuvem.base }, { control }); nuvem.teamsApp.ajustes = AJUSTES;
  await nuvem.teamsApp.start();
  await nuvem.app.ready(); // o index.ts de verdade escuta a porta: é aí que a partida começa
  const cl = world.clouds.get(sws)!;
  await ate(() => cl.states.at(-1) === 'pronto', 'a nuvem não ficou pronta');
  // cofre: a chave nasceu no contêiner e está guardada no World; conta local "nuvem"
  assert.match(cl.vaultKey ?? '', /^[a-f0-9]{64}$/);
  const u = nuvem.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'nuvem'")!;
  assert.ok(u, 'a conta local do contêiner');
  // aparelho-nuvem na conta do dono, fora do limite de aparelhos
  const d = world.devices.get(cl.deviceId!)! as unknown as { status: string; kind: string; accountId: string };
  assert.deepEqual([d.status, d.kind], ['active', 'cloud']);
  assert.equal(d.accountId, [...world.accounts.values()].find((a) => a.email === 'ana@exemplo.test')!.id);
  // esperou a chave (só um computador da pessoa a entrega) e depois recebeu a equipe e a conversa
  // (a chave pode chegar antes da primeira tentativa: o computador entrega assim que o aparelho-nuvem aparece)
  const wsNuvem = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
  assert.ok(nuvem.db.get("SELECT 1 AS x FROM agents WHERE workspace_id = ? AND name = 'Frodo' AND status = 'active'", wsNuvem), 'a equipe chegou');
  assert.equal(nuvem.db.get<{ content: string }>("SELECT content FROM messages WHERE id = 'msg_pcaaaaaaaaaaaaaaa'")?.content, 'Qual o caminho mais seguro?', 'a conversa chegou');
  assert.equal(motor.conexoes, 1, 'o Ergon AI foi ligado no motor uma vez');
  // canais: "pronto" só veio depois de o contêiner entrar no serviço; o World sabe a instalação e o computador a declara
  assert.match(cl.relay ?? '', /^ins_/);
  assert.equal(cl.relay, nuvem.teamsApp.instalacaoNoRele());
  await ate(() => relePc.reservas.some((f) => f.installationId === cl.relay && f.workspaceId === sws), 'o computador não declarou a reserva');
  // posse: o computador avisa que está aberto; o contêiner não conta como computador
  assert.ok(cl.presence.length > 0 && cl.presence.every((x) => x === true), JSON.stringify(cl.presence));
});

test('o que a nuvem fez volta ao computador sozinho; fechar o computador avisa o World', async () => {
  const conv = nuvem.db.get<{ c: string }>("SELECT conversation_id AS c FROM messages WHERE id = 'msg_pcaaaaaaaaaaaaaaa'")!.c;
  const wsNuvem = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
  nuvem.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES ('msg_nuvembbbbbbbbbbbb', ?, ?, 'agent', NULL, ?, 'real', ?)",
    wsNuvem, conv, nuvem.db.seal(wsNuvem, 'Pelas montanhas, com o computador fechado.'), new Date().toISOString());
  await ate(() => pc.db.get<{ content: string }>("SELECT content FROM messages WHERE id = 'msg_nuvembbbbbbbbbbbb'")?.content === 'Pelas montanhas, com o computador fechado.', 'a resposta da nuvem não chegou ao computador');
  const cl = world.clouds.get(sws)!;
  await pc.close();
  assert.equal(cl.presence.at(-1), false, 'ao fechar, o computador avisa (a nuvem assume sem esperar)');
});

test('partida seguinte: o cofre do contêiner abre com a chave guardada no World (e não abre com o token de outro)', async () => {
  const cfg = nuvem.cfg; const dir = nuvem.dir;
  await nuvem.close();
  const cofre = new Vault(dir, KDF_TEST);
  assert.equal(cofre.state(), 'sealed');
  const certo = process.env.ERGON_CLOUD_BOOT_TOKEN;
  process.env.ERGON_CLOUD_BOOT_TOKEN = 'token-de-outro-workspace';
  await assert.rejects(createWorld(cfg).prepare!(cofre), /não consegui abrir o cofre/);
  assert.equal(cofre.state(), 'sealed');
  process.env.ERGON_CLOUD_BOOT_TOKEN = certo;
  await createWorld(cfg).prepare!(cofre);
  assert.equal(cofre.state(), 'open');
});
