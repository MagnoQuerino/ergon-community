/**
 * A sincronia é automática (rc.41): dois computadores da mesma pessoa, SEM a nuvem e sem ninguém clicar em nada. O
 * ciclo de cada um entrega a chave, recebe e envia; a tela só mostra o estado de verdade (GET /api/world/sync) e o que
 * pede decisão: equipe nova de outro computador (fica retida) e conflitos. Estados que antes não tinham saída sozinhos:
 * o World pediu a troca da chave (quem administra troca no ciclo) e o World fora do ar (fica dito e volta sozinho).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc1: Harness; let a1: Session; let pc2: Harness; let a2: Session; let sws = ''; let conversa = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_AUTOSYNC_MS', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 8000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(30); }
  assert.fail(msg);
}
const estado = async (h: Harness, s: Session) => (await req(h, 'GET', '/api/world/sync', s)).json;
const escrever = (h: Harness, s: Session, idMsg: string, texto: string) =>
  h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'local', ?)", idMsg, s.workspaceId, conversa, s.userId, h.db.seal(s.workspaceId, texto), new Date().toISOString());
const tem = (h: Harness, idMsg: string) => !!h.db.get('SELECT 1 AS x FROM messages WHERE id = ?', idMsg);

before(async () => {
  world = await new FakeWorld().start();
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC_MS: '120' });
  delete process.env.ERGON_WORLD_AUTOSYNC;
});
after(async () => {
  await pc1?.close(); await pc2?.close(); await world.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('o segundo computador recebe a chave sozinho; a equipe nova fica retida para a pessoa ver', async () => {
  pc1 = await harness(); a1 = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc1, 'POST', '/api/world/bind', a1, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', a1, {})).status, 200);
  world.activate(sws);
  assert.equal((await req(pc1, 'POST', '/api/agents', a1, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
  const frodo = pc1.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = 'Frodo'", a1.workspaceId)!.id;
  conversa = (await req(pc1, 'POST', '/api/conversations', a1, { agentId: frodo, title: 'Diário' })).json.id;
  escrever(pc1, a1, 'msg_autoaaaaaaaaaaaa', 'a primeira, do PC');
  await pc1.app.ready();
  // sem ninguém clicar em "enviar": o ciclo manda a equipe e o conteúdo
  await ate(() => (world.workspaces.get(sws)?.head ?? 0) >= 2, 'o ciclo automático não enviou');
  // (o World grava a mudança antes de responder; o ciclo só marca "última vez certa" quando termina: espera por ele)
  await ate(async () => !!(await estado(pc1, a1)).auto.ultimaOk, 'o ciclo não terminou');
  const st = await estado(pc1, a1);
  assert.deepEqual([st.auto.auto, st.auto.pendencia, st.auto.equipeRetida, st.auto.nuvem?.ativa ?? false], [true, null, false, false]);
  assert.match(st.auto.ultimaOk, /^\d{4}-/);

  pc2 = await harness(); a2 = await setupOwner(pc2, 'ana-notebook', 'senha-do-notebook-123');
  assert.equal((await req(pc2, 'POST', '/api/world/connect', a2, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
  assert.equal((await req(pc2, 'POST', '/api/world/bind', a2, { syncWorkspaceId: sws })).status, 200);
  const dev2 = pc2.db.get<{ d: string }>('SELECT device_id AS d FROM world_links WHERE user_id = ?', a2.userId)!.d;
  // "Autorizar meus outros computadores" não existe mais: o ciclo do PC entrega a chave ao notebook
  await ate(() => world.workspaces.get(sws)!.envelopes.has(dev2), 'o notebook não recebeu a chave sozinho');
  assert.equal((await req(pc2, 'POST', '/api/world/sync/join', a2, {})).status, 200);
  await pc2.app.ready();
  await ate(async () => (await estado(pc2, a2)).auto.equipeRetida === true, 'a equipe nova não ficou retida para a pessoa ver');
  assert.equal(tem(pc2, 'msg_autoaaaaaaaaaaaa'), false, 'enquanto a pessoa não vê a equipe, nada entra');
  // a pessoa vê e recebe (a única decisão que ficou na tela)
  assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json.applied, true);
  await ate(async () => (await estado(pc2, a2)).auto.equipeRetida === false && !!(await estado(pc2, a2)).auto.ultimaOk, 'depois de receber a equipe, o ciclo não seguiu');
});

test('daí em diante, o que um escreve aparece no outro sem ninguém clicar em nada', async () => {
  escrever(pc1, a1, 'msg_autobbbbbbbbbbbb', 'do PC para o notebook');
  escrever(pc2, a2, 'msg_autocccccccccccc', 'do notebook para o PC');
  await ate(() => tem(pc2, 'msg_autobbbbbbbbbbbb') && tem(pc1, 'msg_autocccccccccccc'), 'as mensagens não cruzaram sozinhas');
  const head = world.workspaces.get(sws)!.head;
  await pausa(600);
  assert.equal(world.workspaces.get(sws)!.head, head, 'parado, o ciclo não gera mudança nenhuma');
});

test('o World pediu a troca da chave (alguém saiu): quem administra troca no ciclo e a sincronia segue', async () => {
  world.workspaces.get(sws)!.rotationRequired = true;
  escrever(pc1, a1, 'msg_autodddddddddddd', 'escrita com a troca pedida');
  await ate(() => world.workspaces.get(sws)!.keyVersion === 2, 'a chave não foi trocada sozinha');
  await ate(() => tem(pc2, 'msg_autodddddddddddd'), 'depois da troca, a mensagem não chegou ao notebook');
  assert.equal(pc2.db.get<{ v: number }>('SELECT key_version AS v FROM world_sync WHERE workspace_id = ?', a2.workspaceId)!.v, 2);
  await ate(async () => (await estado(pc1, a1)).auto.pendencia === null && (await estado(pc2, a2)).auto.pendencia === null, 'ficou pendência depois da troca');
});

test('World fora do ar: fica dito no estado (com quantas vezes) e volta sozinho quando ele volta', async () => {
  const porta = world.port;
  await world.stop();
  escrever(pc1, a1, 'msg_autoeeeeeeeeeeee', 'escrita com o World fora do ar');
  await ate(async () => { const p = (await estado(pc1, a1)).auto.pendencia; return p?.codigo === 'world_offline' && p.vezes >= 2; }, 'o estado não mostrou o World fora do ar');
  await world.start(porta);
  await ate(() => tem(pc2, 'msg_autoeeeeeeeeeeee'), 'com o World de volta, a mensagem não chegou');
  await ate(async () => (await estado(pc1, a1)).auto.pendencia === null, 'a pendência não saiu');
});

test('"Sincronizar agora" faz a volta já e devolve o estado', async () => {
  escrever(pc1, a1, 'msg_autoffffffffffff', 'pela saída de emergência');
  const r = await req(pc1, 'POST', '/api/world/sync/now', a1, {});
  assert.deepEqual([r.status, r.json.enabled, r.json.auto.pendencia], [200, true, null]);
  const d = await req(pc2, 'POST', '/api/world/sync/now', a2, {});
  assert.equal(d.status, 200);
  assert.ok(tem(pc2, 'msg_autoffffffffffff'));
});
