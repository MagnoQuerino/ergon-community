/**
 * Salas com a nuvem do workspace (FakeWorld): com os computadores fechados, a mensagem de um membro chega à nuvem do
 * dono, que responde com as conexões do dono SÓ quando foi ele quem pediu ou quando ele já cedeu a quem pediu; sem
 * cessão, a nuvem diz na sala que falta alguém com acesso. Com o computador do dono aberto, a nuvem não responde (ele
 * responde). As cessões dadas no computador chegam à nuvem (aparelho da mesma conta); credencial nenhuma viaja.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import type { RunDaSessao } from '../src/services/runs.ts';
import { FakeWorld } from './fake-world.ts';
import { drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pcRog: Harness; let rog: Session; let pcAna: Harness; let ana: Session; let nuvem: Harness; let sws = ''; let wsN = ''; let userN = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_WORKSPACE', 'ERGON_CLOUD_BOOT_TOKEN', 'ERGON_NUVEM_PASSO_MS', 'ERGON_NUVEM_CICLO_MS', 'ERGON_NUVEM_CANAIS_MS', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const control = { health: async () => true, accounts: async () => [], byok: async () => ({ providers: [], custom: [], ergonAi: true }), ergonAi: async () => undefined, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 40_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(100); }
  assert.fail(msg);
}
const acc = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;
const AGENTE = 'Hipátia';
let rid = 0; const crid = () => `salas-nuvem-${String(++rid).padStart(4, '0')}`;
const marca = (texto: string, trecho: string, tipo: 'pessoa' | 'agente' | 'cessao', chave: string) => { const i = texto.indexOf(trecho); return { tipo, chave, inicio: i, fim: i + trecho.length }; };
const pull = async (h: Harness, s: Session) => { const r = await req(h, 'POST', '/api/world/sync/pull', s, { apply: true }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const push = async (h: Harness, s: Session) => { for (let i = 0; i < 5; i++) { await pull(h, s); const r = await req(h, 'POST', '/api/world/sync/push', s, {}); if (r.status === 200) return; if (r.json?.error !== 'version_conflict') assert.fail(JSON.stringify(r.json)); await pausa(150); } assert.fail('push'); };
const realFetch = globalThis.fetch;
const chamadas: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
function asana(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  chamadas.push(`${init.method ?? 'GET'} ${path}`);
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Rogério', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  return Promise.resolve(json({ data: {} }));
}
/** o computador do Rogério aberto (o sinal de presença que a sincronia automática manda) ou fechado */
const computador = (aberto: boolean) => {
  const cl = world.clouds.get(sws)!; const t = Date.now();
  if (aberto) { cl.pcSince = cl.pcSeenAt === null ? t : cl.pcSince; cl.pcSeenAt = t; world.pcAberto.set(sws, true); }
  else { if (cl.pcSeenAt !== null) cl.pcLeftAt = t; cl.pcSeenAt = null; world.pcAberto.set(sws, false); }
};

before(async () => {
  world = await new FakeWorld().start();
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC: '0', ERGON_NUVEM_PASSO_MS: '120', ERGON_NUVEM_CICLO_MS: '300', ERGON_NUVEM_CANAIS_MS: '20' });
  globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
  pcRog = await harness(); rog = await setupOwner(pcRog, 'rogerio', 'senha-do-rogerio-1');
  pcRog.db.run('UPDATE users SET display_name = ? WHERE id = ?', 'Rogério', rog.userId); // o nome que a sala mostra (e que o # marca)
  assert.equal((await req(pcRog, 'POST', '/api/world/connect', rog, { mode: 'signup', email: 'rogerio@exemplo.test', password: 'senha-do-world-123', displayName: 'Rogério' })).status, 200);
  sws = (await req(pcRog, 'POST', '/api/world/bind', rog, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pcRog, 'POST', '/api/world/sync/enable', rog, {})).status, 200);
  world.activate(sws, 'world_team', 8);
  await push(pcRog, rog);
  pcAna = await harness(); ana = await setupOwner(pcAna, 'ana', 'senha-da-ana-1234');
  assert.equal((await req(pcAna, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  const inv = await req(pcRog, 'POST', '/api/world/members/invites', rog, { role: 'editor' });
  assert.equal((await req(pcAna, 'POST', '/api/world/invites/accept', ana, { token: inv.json.token })).status, 200);
  assert.equal((await req(pcAna, 'POST', '/api/world/bind', ana, { syncWorkspaceId: sws })).status, 200);
  assert.equal((await req(pcRog, 'POST', '/api/world/sync/share', rog, {})).status, 200);
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/join', ana, {})).status, 200);
  await pull(pcAna, ana);
  for (const [h, s] of [[pcRog, rog], [pcAna, ana]] as const) { await req(h, 'GET', '/api/world/members', s); await req(h, 'GET', '/api/salas', s); }
  // a nuvem do Rogério sobe, recebe a chave e a equipe
  Object.assign(process.env, { ERGON_WORLD_WORKSPACE: sws, ERGON_CLOUD_BOOT_TOKEN: world.nuvem(sws) });
  nuvem = await harness({ mode: 'cloud' }, { control });
  await nuvem.app.ready();
  await ate(() => !!world.clouds.get(sws)!.deviceId && world.devices.get(world.clouds.get(sws)!.deviceId!)?.status === 'active', 'a nuvem não se registrou');
  assert.equal((await req(pcRog, 'POST', '/api/world/sync/share', rog, {})).json.cloud, 'entregue');
  await ate(() => world.clouds.get(sws)!.states.at(-1) === 'pronto', 'a nuvem não ficou pronta');
  wsN = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
  userN = nuvem.db.get<{ u: string }>("SELECT user_id AS u FROM memberships WHERE workspace_id = ? AND role = 'owner'", wsN)!.u;
  // a conexão do Rogério na nuvem (no produto, ela chega cifrada só para a nuvem: sync-conexoes.ts)
  nuvem.integrations.secrets.write(wsN, 'asana', { token: 'tok-asana-do-rogerio-123' });
  setIntegration(nuvem.db, wsN, 'asana', { state: 'connected', account_label: 'Rogério', connected_at: new Date().toISOString() });
  // todos se anunciam e se conhecem (a nuvem anuncia sozinha a cada ciclo)
  await push(pcAna, ana); await push(pcRog, rog);
  await ate(() => !!pcRog.db.get("SELECT 1 AS x FROM salas_aparelhos WHERE device_id = ?", world.clouds.get(sws)!.deviceId!) || (pull(pcRog, rog), false), 'a nuvem não se anunciou');
  await pull(pcAna, ana);
});
after(async () => {
  globalThis.fetch = realFetch; setHttpClock(null);
  await nuvem?.close(); await pcAna?.close(); await pcRog?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let sala = '';
const idRog = () => `acc:${acc('rogerio@exemplo.test')}`; const idAna = () => `acc:${acc('ana@exemplo.test')}`;
const pedir = async (h: Harness, s: Session, salaId: string, texto: string) =>
  (await req(h, 'POST', `/api/salas/${salaId}/mensagens`, s, { texto, clientRequestId: crid(), marcas: [marca(texto, `@${AGENTE}`, 'agente', AGENTE), marca(texto, '#Rogério', 'cessao', idRog())] })).json.messageId as string;
const filaNuvem = (origem: string) => nuvem.db.get<{ run_id: string | null; cedida: number; pedinte_chave: string }>('SELECT run_id, cedida, pedinte_chave FROM salas_fila WHERE origem_id = ?', origem);

test('computador aberto: o Rogério cede na hora (7 dias); a cessão vai à nuvem dele, e a nuvem não responde no lugar do computador', async () => {
  computador(true);
  const disp = (await req(pcRog, 'GET', '/api/salas/disponiveis', rog)).json;
  sala = (await req(pcRog, 'POST', '/api/salas', rog, { nome: 'Vendas', pessoas: [disp.pessoas.find((p: { nome: string }) => p.nome === 'Ana').chave], agentes: [AGENTE] })).json.id;
  await push(pcRog, rog); await pull(pcAna, ana);
  const m1 = await pedir(pcAna, ana, sala, `@${AGENTE}, quais os projetos da conta? #Rogério`);
  await drain(pcAna); await push(pcAna, ana); await pull(pcRog, rog);
  const cartao = ((await req(pcRog, 'GET', '/api/salas/avisos', rog)).json as Array<{ id: string; tipo: string }>).find((x) => x.tipo === 'cessao')!;
  assert.ok(cartao);
  assert.equal((await req(pcRog, 'POST', `/api/salas/avisos/${cartao.id}`, rog, { decisao: '7d' })).status, 200);
  await drain(pcRog); await push(pcRog, rog);
  // a nuvem recebe a sala, as mensagens e a cessão do Rogério; o computador estava aberto: ela não responde
  await ate(() => !!nuvem.db.get('SELECT 1 AS x FROM salas_cessoes WHERE conversation_id = ?', sala), 'a cessão não chegou à nuvem');
  await ate(() => !!nuvem.db.get('SELECT 1 AS x FROM messages WHERE id = ?', m1), 'a mensagem da Ana não chegou à nuvem');
  await pausa(7000); // passa a folga da posse: a nuvem já decidiu
  assert.equal(filaNuvem(m1), undefined, 'com o computador aberto, a nuvem não responde');
  for (const c of world.workspaces.get(sws)!.changes) assert.ok(!Buffer.from(String(c.ciphertext), 'base64').toString('latin1').includes('tok-asana'), 'credencial nunca no World');
});

test('computadores fechados: a mensagem da Ana chega e a nuvem do Rogério responde com as conexões dele (cedidas), com auditoria', async () => {
  computador(false);
  const m2 = await pedir(pcAna, ana, sala, `@${AGENTE}, e agora? #Rogério`);
  await drain(pcAna); await push(pcAna, ana);
  await ate(() => !!filaNuvem(m2)?.run_id, 'a nuvem não respondeu com a cessão', 60_000);
  const f = filaNuvem(m2)!;
  assert.deepEqual([f.cedida, f.pedinte_chave], [1, idAna()]);
  await drain(nuvem, 20);
  const run = nuvem.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!;
  const x = await nuvem.conexoes.executar(run, 'asana', 'tarefa.quadros', {});
  assert.equal(x.status, 'feita', JSON.stringify(x));
  const ev = JSON.parse(nuvem.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE workspace_id = ? AND action = 'sala.conexao.cedida' ORDER BY created_at DESC LIMIT 1", wsN)!.evidence);
  assert.deepEqual([ev.dono, ev.pedinte, ev.sala, ev.agente], [idRog(), idAna(), sala, AGENTE]);
  // a resposta da nuvem chega à Ana (e ao Rogério quando ele abrir)
  await ate(async () => { await pull(pcAna, ana); return !!pcAna.db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND role = 'agent' AND created_at > (SELECT created_at FROM messages WHERE id = ?) AND autor_chave = ? AND pedinte_chave = ? AND marcas IS NOT NULL", sala, m2, `agt:${AGENTE}`, idAna()); }, 'a resposta da nuvem não chegou à Ana', 60_000);
});

test('computadores fechados, sem cessão: a nuvem não usa a conexão do dono e avisa que falta alguém com acesso', async () => {
  const sala2 = (await req(pcRog, 'POST', '/api/salas', rog, { nome: 'Compras', pessoas: [idAna()], agentes: [AGENTE] })).json.id;
  await push(pcRog, rog); await pull(pcAna, ana);
  computador(false);
  const m3 = await pedir(pcAna, ana, sala2, `@${AGENTE}, preciso dos projetos. #Rogério`);
  await drain(pcAna); await push(pcAna, ana);
  await ate(() => nuvem.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'", sala2).some((m) => m.content.includes('precisa de alguém com acesso')), 'a nuvem não avisou', 60_000);
  assert.equal(filaNuvem(m3), undefined, 'sem cessão, nenhum agente roda com a conexão do dono');
  // o cartão fica para o Rogério decidir (na nuvem, se ele abrir o app lá; ou no computador)
  assert.ok(nuvem.db.get("SELECT 1 AS x FROM salas_avisos WHERE message_id = ? AND tipo = 'cessao' AND status = 'aberto'", m3));
});

test('o dono pedindo na nuvem (computadores fechados): a nuvem usa as conexões dele, como as próprias', async () => {
  const texto = `@${AGENTE}, liste os projetos`;
  const r = nuvem.salas.enviar(wsN, userN, sala, { texto, clientRequestId: crid(), marcas: [marca(texto, `@${AGENTE}`, 'agente', AGENTE)] });
  assert.deepEqual(r.agentes, [AGENTE]);
  await drain(nuvem, 20);
  const f = nuvem.db.get<{ run_id: string; pedinte_chave: string; cedida: number }>('SELECT run_id, pedinte_chave, cedida FROM salas_fila WHERE origem_id = ?', r.messageId)!;
  assert.deepEqual([f.pedinte_chave, f.cedida], [idRog(), 0]);
  const antesN = Number(nuvem.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'sala.conexao.cedida'")!.n);
  const x = await nuvem.conexoes.executar(nuvem.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!, 'asana', 'tarefa.quadros', {});
  assert.equal(x.status, 'feita', JSON.stringify(x));
  assert.equal(Number(nuvem.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'sala.conexao.cedida'")!.n), antesN, 'são dele: não é uso cedido');
});
