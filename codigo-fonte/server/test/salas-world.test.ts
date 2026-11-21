/**
 * Salas entre os computadores dos colaboradores, pela sincronia do World (FakeWorld): Rogério (dono), Ana (membro da
 * sala) e Caio (no workspace, fora da sala).
 * - a sala e as mensagens chegam só a quem está nela (pacotes selados para os aparelhos dos membros);
 * - @Ana avisa a Ana no Ergon dela; #Ana abre o cartão de cessão lá; cedendo, o agente roda no computador DELA com a
 *   conexão (falsa) dela, só para aquele pedido, e a auditoria registra dono, quem pediu, sala e agente;
 * - revogar corta; a governança desligada (pela dona do workspace) impede a cessão.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import type { RunDaSessao } from '../src/services/runs.ts';
import { FakeWorld } from './fake-world.ts';
import { drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pcRog: Harness; let rog: Session; let pcAna: Harness; let ana: Session; let pcCaio: Harness; let caio: Session; let sws = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const acc = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;
const AGENTE = 'Hipátia';
let rid = 0; const crid = () => `salas-world-${String(++rid).padStart(4, '0')}`;
const marca = (texto: string, trecho: string, tipo: 'pessoa' | 'agente' | 'cessao', chave: string) => { const i = texto.indexOf(trecho); return { tipo, chave, inicio: i, fim: i + trecho.length }; };
const pull = async (h: Harness, s: Session) => { const r = await req(h, 'POST', '/api/world/sync/pull', s, { apply: true }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const push = async (h: Harness, s: Session) => { await pull(h, s); const r = await req(h, 'POST', '/api/world/sync/push', s, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); };

// a API do Asana de mentira: a conexão falsa da Ana (só no computador dela)
const realFetch = globalThis.fetch;
const asanaCalls: string[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
function asana(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  asanaCalls.push(`${init.method ?? 'GET'} ${path}`);
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}

async function entrar(h: Harness, s: Session, email: string, nome: string) {
  assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email, password: 'senha-do-world-123', displayName: nome })).status, 200);
  const inv = await req(pcRog, 'POST', '/api/world/members/invites', rog, { role: 'editor' });
  assert.equal((await req(h, 'POST', '/api/world/invites/accept', s, { token: inv.json.token })).status, 200);
  assert.equal((await req(h, 'POST', '/api/world/bind', s, { syncWorkspaceId: sws })).status, 200);
  assert.equal((await req(pcRog, 'POST', '/api/world/sync/share', rog, {})).status, 200);
  assert.equal((await req(h, 'POST', '/api/world/sync/join', s, {})).status, 200);
  await pull(h, s);
}

before(async () => {
  world = await new FakeWorld().start();
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC: '0' });
  globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
  pcRog = await harness(); rog = await setupOwner(pcRog, 'rogerio', 'senha-do-rogerio-1');
  assert.equal((await req(pcRog, 'POST', '/api/world/connect', rog, { mode: 'signup', email: 'rogerio@exemplo.test', password: 'senha-do-world-123', displayName: 'Rogério' })).status, 200);
  sws = (await req(pcRog, 'POST', '/api/world/bind', rog, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pcRog, 'POST', '/api/world/sync/enable', rog, {})).status, 200);
  world.activate(sws, 'world_team', 8);
  await push(pcRog, rog);
  pcAna = await harness(); ana = await setupOwner(pcAna, 'ana', 'senha-da-ana-1234'); await entrar(pcAna, ana, 'ana@exemplo.test', 'Ana');
  pcCaio = await harness(); caio = await setupOwner(pcCaio, 'caio', 'senha-do-caio-123'); await entrar(pcCaio, caio, 'caio@exemplo.test', 'Caio');
  // os papéis do World (dono, editor) e a chave pública de cada aparelho: cada um envia uma vez e recebe dos outros
  for (const [h, s] of [[pcRog, rog], [pcAna, ana], [pcCaio, caio]] as const) {
    assert.equal((await req(h, 'GET', '/api/world/members', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/salas', s)).status, 200); // abriu as Salas: o aparelho se anuncia
  }
  for (const [h, s] of [[pcAna, ana], [pcCaio, caio], [pcRog, rog]] as const) await push(h, s);
  for (const [h, s] of [[pcRog, rog], [pcAna, ana], [pcCaio, caio]] as const) await pull(h, s);
  // a conexão falsa da Ana, só no computador dela
  pcAna.integrations.secrets.write(ana.workspaceId, 'asana', { token: 'tok-asana-da-ana-123456' });
  setIntegration(pcAna.db, ana.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
});
after(async () => {
  globalThis.fetch = realFetch; setHttpClock(null);
  await pcCaio?.close(); await pcAna?.close(); await pcRog?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let sala = '';
test('a sala e as mensagens chegam só aos membros (Ana sim, Caio não), e o World não lê nada', async () => {
  const disp = (await req(pcRog, 'GET', '/api/salas/disponiveis', rog)).json;
  const pAna = disp.pessoas.find((p: { nome: string }) => p.nome === 'Ana');
  assert.ok(pAna, JSON.stringify(disp.pessoas));
  assert.equal(pAna.chave, `acc:${acc('ana@exemplo.test')}`);
  const c = await req(pcRog, 'POST', '/api/salas', rog, { nome: 'Fechamento', pessoas: [pAna.chave], agentes: [AGENTE] });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  sala = c.json.id;
  const t = 'Bom dia! Planilha de novembro chegou.';
  assert.equal((await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: t, clientRequestId: crid() })).status, 201);
  const antesN = world.workspaces.get(sws)!.changes.length;
  await push(pcRog, rog);
  const novas = world.workspaces.get(sws)!.changes.slice(antesN);
  assert.ok(novas.length >= 1);
  assert.ok(novas.every((x) => !Buffer.from(String(x.ciphertext), 'base64').toString('latin1').includes('Fechamento')), 'cifrado: o World não lê');
  await pull(pcAna, ana); await pull(pcCaio, caio);
  const lAna = (await req(pcAna, 'GET', '/api/salas', ana)).json.salas;
  assert.equal(lAna.length, 1);
  assert.equal(lAna[0].nome, 'Fechamento');
  assert.equal(lAna[0].naoLidas, 1);
  const msgs = (await req(pcAna, 'GET', `/api/salas/${sala}/mensagens`, ana)).json.mensagens as Array<{ content: string; autor: { nome: string } }>;
  assert.ok(msgs.some((m) => m.content === t && m.autor.nome === 'Alexandre'));
  // Caio está no workspace e recebeu a mesma mudança, mas nenhum pacote era para ele
  assert.equal((await req(pcCaio, 'GET', '/api/salas', caio)).json.salas.length, 0);
  assert.equal((await req(pcCaio, 'GET', `/api/salas/${sala}`, caio)).status, 404);
  assert.equal(pcCaio.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', sala)!.n, 0);
  const devCaio = pcCaio.db.get<{ d: string }>('SELECT device_id AS d FROM world_links WHERE user_id = ?', caio.userId)!.d;
  assert.ok(!pcRog.db.get("SELECT 1 AS x FROM salas_enviados WHERE device_id = ? AND kind = 'msg'", devCaio), 'nada foi selado para o aparelho do Caio');
});

test('@Ana: a menção avisa a Ana no Ergon dela (sino); a resposta da Ana volta ao Rogério', async () => {
  const idAna = `acc:${acc('ana@exemplo.test')}`;
  const t = '@Ana, você confere os números?';
  await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: t, clientRequestId: crid(), marcas: [marca(t, '@Ana', 'pessoa', idAna)] });
  await push(pcRog, rog); await pull(pcAna, ana);
  const av = (await req(pcAna, 'GET', '/api/salas/avisos', ana)).json as Array<{ tipo: string; de_nome: string; sala: string }>;
  assert.equal(av.length, 1);
  assert.deepEqual([av[0].tipo, av[0].de_nome, av[0].sala], ['mencao', 'Alexandre', 'Fechamento']);
  assert.ok((await req(pcAna, 'GET', '/api/salas', ana)).json.salas[0].mencao, 'destaque de menção na lista');
  assert.ok((await req(pcAna, 'GET', '/api/state', ana)).json.decisionsPending >= 1, 'conta no sino "Aguardando você"');
  await req(pcAna, 'POST', `/api/salas/${sala}/lido`, ana);
  assert.equal((await req(pcAna, 'GET', '/api/salas/avisos', ana)).json.length, 0, 'abrir a sala vê a menção');
  await req(pcAna, 'POST', `/api/salas/${sala}/mensagens`, ana, { texto: 'Confiro sim.', clientRequestId: crid() });
  await push(pcAna, ana); await pull(pcRog, rog);
  const m = (await req(pcRog, 'GET', `/api/salas/${sala}/mensagens`, rog)).json.mensagens as Array<{ content: string; autor: { nome: string; chave: string } }>;
  assert.ok(m.some((x) => x.content === 'Confiro sim.' && x.autor.chave === idAna));
});

let pedido = '';
test('#Ana: cartão de cessão no Ergon dela; cedendo, o agente usa a conexão da Ana na sala e a auditoria registra', async () => {
  const idAna = `acc:${acc('ana@exemplo.test')}`; const idRog = `acc:${acc('rogerio@exemplo.test')}`;
  const t = `@${AGENTE}, preciso de um resumo da semana. #Ana`;
  const r = await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${AGENTE}`, 'agente', AGENTE), marca(t, '#Ana', 'cessao', idAna)] });
  pedido = r.json.messageId;
  await drain(pcRog);
  // no computador de quem pediu: o agente respondeu com as conexões do Rogério e sabe o que falta
  const run = pcRog.db.get<{ instructions: string }>("SELECT instructions FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", sala)!;
  assert.match(run.instructions, /conexões de Ana.*ainda não cederam/s);
  await push(pcRog, rog); await pull(pcAna, ana);
  // nenhum agente rodou no computador da Ana só por a mensagem ter chegado
  assert.equal(pcAna.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?', sala)!.n, 0);
  const av = (await req(pcAna, 'GET', '/api/salas/avisos', ana)).json as Array<{ id: string; tipo: string; agente: string }>;
  const cartao = av.find((x) => x.tipo === 'cessao')!;
  assert.ok(cartao, JSON.stringify(av));
  assert.equal(cartao.agente, AGENTE);
  assert.ok((await req(pcAna, 'GET', '/api/salas', ana)).json.salas[0].cessao, 'destaque de cessão na lista');
  // Caio não pode decidir o cartão da Ana (nem tem a sala)
  assert.equal((await req(pcCaio, 'POST', `/api/salas/avisos/${cartao.id}`, caio, { decisao: '24h' })).status, 404);

  const ok = await req(pcAna, 'POST', `/api/salas/avisos/${cartao.id}`, ana, { decisao: '24h' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await req(pcAna, 'POST', `/api/salas/avisos/${cartao.id}`, ana, { decisao: '24h' })).status, 409, 'já decidido');
  await drain(pcAna);
  // o complemento rodou no computador da Ana, a pedido do Rogério, com as conexões dela
  const f = pcAna.db.get<{ run_id: string; pedinte_chave: string; cedida: number }>('SELECT run_id, pedinte_chave, cedida FROM salas_fila WHERE conversation_id = ?', sala)!;
  assert.deepEqual([f.pedinte_chave, f.cedida], [idRog, 1]);
  const runAna = pcAna.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!;
  assert.match(runAna.instructions ?? '', /conexões de Ana, cedidas a este pedido de Alexandre/);
  const x = await pcAna.conexoes.executar(runAna, 'asana', 'tarefa.quadros', {});
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.equal(x.status, 'feita', 'ler pela conexão cedida vai direto');
  assert.ok(asanaCalls.includes('GET /projects'), 'a conexão (falsa) da Ana foi usada');
  // mudar algo na conta dela a pedido de outra pessoa espera o clique dela (o cartão fica no Ergon dela)
  const w = await pcAna.conexoes.executar(runAna, 'asana', 'tarefa.criar', { titulo: 'Resumo da semana', quadro: 'Vendas' });
  assert.equal(w.status, 'aguardando_confirmacao', JSON.stringify(w));
  assert.ok(!asanaCalls.some((c) => c.startsWith('POST')), 'nada foi criado na conta dela sem ela');
  const aud = pcAna.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE workspace_id = ? AND action = 'sala.conexao.cedida' ORDER BY created_at DESC LIMIT 1", ana.workspaceId)!;
  const ev = JSON.parse(aud.evidence);
  assert.deepEqual([ev.dono, ev.pedinte, ev.sala, ev.agente], [idAna, idRog, sala, AGENTE]);
  assert.ok(!aud.evidence.includes('tok-asana'), 'credencial nunca na auditoria');
  // a sala do Rogério fica sabendo (a cessão e a resposta do agente vinda do computador da Ana); a credencial não viaja
  await push(pcAna, ana); await pull(pcRog, rog);
  const m = (await req(pcRog, 'GET', `/api/salas/${sala}/mensagens`, rog)).json.mensagens as Array<{ role: string; marcas: { evento?: string } | null; autor: { nome: string }; pedinte: string | null }>;
  assert.ok(m.some((y) => y.role === 'system' && y.marcas?.evento === 'cedeu'));
  assert.equal(m.filter((y) => y.role === 'agent' && y.autor.nome === AGENTE && y.pedinte === idRog).length, 2, 'a resposta daqui e o complemento com as conexões da Ana');
  assert.ok(!pcRog.db.get("SELECT 1 AS x FROM integrations WHERE workspace_id = ? AND kind = 'asana' AND state = 'connected'", rog.workspaceId), 'a conexão da Ana não foi para o Rogério');
  for (const c of world.workspaces.get(sws)!.changes) assert.ok(!Buffer.from(String(c.ciphertext), 'base64').toString('latin1').includes('tok-asana'));
});

test('revogar corta: o próximo uso da conexão da Ana é recusado (e registrado)', async () => {
  const ces = (await req(pcAna, 'GET', '/api/salas/cessoes', ana)).json as Array<{ id: string; sala: string; prazo: string }>;
  assert.equal(ces.length, 1);
  assert.deepEqual([ces[0].sala, ces[0].prazo], ['Fechamento', '24h']);
  assert.equal((await req(pcRog, 'DELETE', `/api/salas/cessoes/${ces[0].id}`, rog)).status, 404, 'só quem cedeu revoga');
  assert.equal((await req(pcAna, 'DELETE', `/api/salas/cessoes/${ces[0].id}`, ana)).status, 200);
  const f = pcAna.db.get<{ run_id: string }>('SELECT run_id FROM salas_fila WHERE conversation_id = ?', sala)!;
  const runAna = pcAna.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!;
  const n = asanaCalls.length;
  const x = await pcAna.conexoes.executar(runAna, 'asana', 'tarefa.quadros', {});
  assert.equal(x.ok, false);
  assert.match(x.texto, /não foram cedidas/);
  assert.equal(asanaCalls.length, n, 'a conta da Ana não foi tocada');
  assert.ok(pcAna.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'sala.conexao.negada'", ana.workspaceId));
});

test('governança desligada pela dona do workspace: a Ana não recebe cartão e não consegue ceder', async () => {
  const idAna = `acc:${acc('ana@exemplo.test')}`;
  assert.equal((await req(pcAna, 'PUT', '/api/salas/governanca', ana, { cessao: false })).status, 403, 'editor não muda a governança');
  assert.equal((await req(pcRog, 'PUT', '/api/salas/governanca', rog, { cessao: false })).status, 200);
  const t = `@${AGENTE}, e o fluxo de caixa? #Ana`;
  await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${AGENTE}`, 'agente', AGENTE), marca(t, '#Ana', 'cessao', idAna)] });
  await drain(pcRog);
  await push(pcRog, rog); await pull(pcAna, ana);
  assert.equal((await req(pcAna, 'GET', '/api/salas/governanca', ana)).json.cessao, false, 'a governança chegou');
  assert.equal(((await req(pcAna, 'GET', '/api/salas/avisos', ana)).json as Array<{ tipo: string }>).filter((x) => x.tipo === 'cessao').length, 0, 'sem cartão de cessão');
  // uma cessão "sempre" dada antes não vale mais com a governança desligada
  pcAna.db.run("INSERT INTO salas_cessoes (id, workspace_id, conversation_id, dono_chave, pedinte_chave, prazo, created_at) VALUES ('sce_teste000000000000000000000000001', ?, ?, ?, ?, 'sempre', ?)",
    ana.workspaceId, sala, idAna, `acc:${acc('rogerio@exemplo.test')}`, new Date().toISOString());
  const f = pcAna.db.get<{ run_id: string }>('SELECT run_id FROM salas_fila WHERE conversation_id = ?', sala)!;
  const x = await pcAna.conexoes.executar(pcAna.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!, 'asana', 'tarefa.quadros', {});
  assert.equal(x.ok, false);
  // um cartão de cessão que estava aberto não se decide mais
  pcAna.db.run("INSERT INTO salas_avisos (id, workspace_id, conversation_id, message_id, para_chave, tipo, de_chave, de_nome, created_at) VALUES ('sav_aaaa0000000000000000000000000001', ?, ?, ?, ?, 'cessao', ?, 'Alexandre', ?)",
    ana.workspaceId, sala, pcAna.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1", sala)!.id, idAna, `acc:${acc('rogerio@exemplo.test')}`, new Date().toISOString());
  assert.equal((await req(pcAna, 'POST', '/api/salas/avisos/sav_aaaa0000000000000000000000000001', ana, { decisao: '7d' })).status, 403);
  assert.equal((await req(pcAna, 'POST', '/api/salas/avisos/sav_aaaa0000000000000000000000000001', ana, { decisao: 'recusar' })).status, 200, 'recusar continua podendo');
  assert.equal((await req(pcRog, 'PUT', '/api/salas/governanca', rog, { cessao: true })).status, 200);
});

test('papel de leitura (viewer) pede consulta, mas nada com efeito, nem com as próprias conexões', async () => {
  const idAna = acc('ana@exemplo.test');
  assert.equal((await req(pcRog, 'PUT', `/api/world/members/${idAna}/role`, rog, { role: 'viewer' })).status, 200);
  assert.equal((await req(pcAna, 'GET', '/api/world/members', ana)).status, 200); // o papel novo chega ao computador dela
  const t = `@${AGENTE}, liste os quadros e crie uma tarefa`;
  await req(pcAna, 'POST', `/api/salas/${sala}/mensagens`, ana, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${AGENTE}`, 'agente', AGENTE)] });
  await drain(pcAna);
  const f = pcAna.db.get<{ run_id: string; pedinte_chave: string }>("SELECT run_id, pedinte_chave FROM salas_fila WHERE conversation_id = ? AND cedida = 0 ORDER BY created_at DESC LIMIT 1", sala)!;
  assert.equal(f.pedinte_chave, `acc:${idAna}`);
  const run = pcAna.db.get<RunDaSessao>('SELECT * FROM runs WHERE id = ?', f.run_id)!;
  assert.equal((await pcAna.conexoes.executar(run, 'asana', 'tarefa.quadros', {})).status, 'feita');
  const w = await pcAna.conexoes.executar(run, 'asana', 'tarefa.criar', { titulo: 'Não pode', quadro: 'Vendas' });
  assert.equal(w.ok, false);
  assert.match(w.texto, /papel de leitura/);
  assert.equal((await req(pcAna, 'POST', `/api/salas/${sala}/mensagens/${pedido}/tarefa`, ana)).status, 403, 'leitura não cria cartão de tarefa');
  assert.equal((await req(pcRog, 'PUT', `/api/world/members/${idAna}/role`, rog, { role: 'editor' })).status, 200);
});

test('anexo da sala: chega a ficha; baixar traz o arquivo cifrado em partes, igual, só para quem está na sala', async () => {
  const bytes = Buffer.alloc(700 * 1024 + 123); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 251; // 3 partes
  const art = (await req(pcRog, 'POST', '/api/artifacts', rog, bytes, { 'content-type': 'application/octet-stream', 'x-filename': 'balanco.xlsx', 'x-file-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-conversation-id': sala })).json;
  assert.ok(art.id, JSON.stringify(art));
  assert.equal((await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: 'Segue o balanço.', clientRequestId: crid(), attachments: [art.id] })).status, 201);
  const grande = (await req(pcRog, 'POST', '/api/artifacts', rog, Buffer.alloc(4 * 1024 * 1024 + 1, 7), { 'content-type': 'application/octet-stream', 'x-filename': 'video.bin', 'x-file-type': 'application/octet-stream', 'x-conversation-id': sala })).json;
  assert.equal((await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: 'E o vídeo.', clientRequestId: crid(), attachments: [grande.id] })).status, 201);
  await push(pcRog, rog); await pull(pcAna, ana);
  const msgs = async () => (await req(pcAna, 'GET', `/api/salas/${sala}/mensagens`, ana)).json.mensagens as Array<{ content: string; attachments?: Array<{ id: string; filename: string }>; remotos?: Array<{ ref: string; estado: string; filename: string }> }>;
  let m = (await msgs()).find((x) => x.content === 'Segue o balanço.')!;
  assert.deepEqual(m.remotos?.map((r) => [r.filename, r.estado]), [['balanco.xlsx', 'remoto']], 'só a ficha, até alguém pedir');
  assert.equal(m.attachments, undefined);
  const v = (await msgs()).find((x) => x.content === 'E o vídeo.')!;
  assert.equal(v.remotos?.[0].estado, 'grande');
  assert.equal((await req(pcAna, 'POST', `/api/salas/${sala}/anexos/${grande.id}/baixar`, ana)).status, 413);
  // quem não está na sala não pede nada
  assert.equal((await req(pcCaio, 'POST', `/api/salas/${sala}/anexos/${art.id}/baixar`, caio)).status, 404);
  assert.equal((await req(pcAna, 'POST', `/api/salas/${sala}/anexos/${art.id}/baixar`, ana)).status, 200);
  assert.equal((await msgs()).find((x) => x.content === 'Segue o balanço.')!.remotos?.[0].estado, 'baixando');
  await push(pcAna, ana); await pull(pcRog, rog); // o pedido chega ao computador do Rogério
  for (let i = 0; i < 4; i++) { await push(pcRog, rog); await pull(pcAna, ana); } // as partes vão (até ~650 kB por mudança)
  m = (await msgs()).find((x) => x.content === 'Segue o balanço.')!;
  assert.equal(m.remotos, undefined);
  assert.equal(m.attachments?.[0].filename, 'balanco.xlsx');
  const baixado = await req(pcAna, 'GET', `/api/artifacts/${m.attachments![0].id}/download`, ana);
  assert.equal(baixado.status, 200);
  assert.ok(Buffer.compare(baixado.res.rawPayload, bytes) === 0, 'o arquivo chegou igual');
  // no World, só cifrado; e nenhum pedaço foi para o Caio
  const devCaio = pcCaio.db.get<{ d: string }>('SELECT device_id AS d FROM world_links WHERE user_id = ?', caio.userId)!.d;
  assert.ok(!pcRog.db.get('SELECT 1 AS x FROM salas_anexo_envios WHERE device_id = ?', devCaio));
  assert.ok(!pcRog.db.get('SELECT 1 AS x FROM salas_anexo_envios'), 'envio concluído');
  // um pedido forjado (Caio pedindo como se estivesse na sala) não sai: o serviço confere a sala e o membro
  assert.equal(pcRog.salas.receberPedidoDeAnexo(rog.workspaceId, `acc:${acc('caio@exemplo.test')}`, devCaio, { ref: art.id, salaId: sala }), false);
});

test('tópicos entre computadores: o compartilhado chega a todos da sala; o privado só aos convidados (nem o nome vaza)', async () => {
  const idAna = `acc:${acc('ana@exemplo.test')}`;
  const origem = (await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: 'Fornecedor de papel: qual escolhemos?', clientRequestId: crid() })).json.messageId as string;
  const comp = (await req(pcRog, 'POST', `/api/salas/${sala}/topicos`, rog, { visibilidade: 'compartilhado', origem })).json.id as string;
  const priv = (await req(pcRog, 'POST', `/api/salas/${sala}/topicos`, rog, { nome: 'Salários (confidencial)', visibilidade: 'privado', agentes: [AGENTE] })).json.id as string;
  const comAna = (await req(pcRog, 'POST', `/api/salas/${sala}/topicos`, rog, { nome: 'Só Rogério e Ana', visibilidade: 'privado', pessoas: [idAna] })).json.id as string;
  await req(pcRog, 'POST', `/api/salas/${priv}/mensagens`, rog, { texto: 'Números da folha individual', clientRequestId: crid() });
  await push(pcRog, rog); await pull(pcAna, ana); await pull(pcCaio, caio);
  const ts = (await req(pcAna, 'GET', `/api/salas/${sala}/topicos`, ana)).json as Array<{ id: string; nome: string }>;
  assert.deepEqual(ts.map((x) => x.id).sort(), [comp, comAna].sort());
  assert.ok(!pcAna.db.get('SELECT 1 AS x FROM conversations WHERE id = ?', priv), 'o privado nem existe no computador da Ana');
  assert.ok(!pcAna.db.all<{ content: string }>('SELECT content FROM messages').some((m) => m.content.includes('Salários') || m.content.includes('folha individual')));
  const m = (await req(pcAna, 'GET', `/api/salas/${sala}/mensagens`, ana)).json.mensagens.find((x: { id: string }) => x.id === origem);
  assert.equal(m.topico.id, comp, 'a origem mostra o tópico compartilhado');
  assert.ok(!pcCaio.db.get('SELECT 1 AS x FROM conversations WHERE id IN (?, ?, ?)', comp, priv, comAna), 'fora da sala: nada');
  // a Ana responde no compartilhado e menciona o Rogério; volta ao computador dele com o aviso
  const t = '@Rogério, prefiro o segundo';
  pcAna.db.run("UPDATE salas_membros SET nome = 'Rogério' WHERE chave = ?", `acc:${acc('rogerio@exemplo.test')}`);
  await req(pcAna, 'POST', `/api/salas/${comp}/mensagens`, ana, { texto: t, clientRequestId: crid(), marcas: [marca(t, '@Rogério', 'pessoa', `acc:${acc('rogerio@exemplo.test')}`)] });
  await push(pcAna, ana); await pull(pcRog, rog);
  assert.ok(pcRog.db.all<{ content: string }>('SELECT content FROM messages WHERE conversation_id = ?', comp).some((x) => x.content === t));
  assert.ok(((await req(pcRog, 'GET', '/api/salas/avisos', rog)).json as Array<{ conversation_id: string; tipo: string }>).some((v) => v.conversation_id === comp && v.tipo === 'mencao'));
  assert.ok((await req(pcRog, 'GET', '/api/salas', rog)).json.salas.find((x: { id: string }) => x.id === sala).mencao, 'a menção no tópico acende a sala');
});

test('tirada da sala, a Ana deixa de receber e não lê mais; as cessões dela na sala caem', async () => {
  const idAna = `acc:${acc('ana@exemplo.test')}`;
  assert.equal((await req(pcRog, 'POST', `/api/salas/${sala}/membros/remover`, rog, { tipo: 'pessoa', chave: idAna })).status, 200);
  await req(pcRog, 'POST', `/api/salas/${sala}/mensagens`, rog, { texto: 'Isto a Ana não vê.', clientRequestId: crid() });
  await push(pcRog, rog); await pull(pcAna, ana);
  assert.equal((await req(pcAna, 'GET', `/api/salas/${sala}`, ana)).status, 404);
  assert.equal((await req(pcAna, 'GET', '/api/salas', ana)).json.salas.length, 0);
  assert.ok(!pcAna.db.get("SELECT 1 AS x FROM messages WHERE conversation_id = ? AND content LIKE '%não vê%'", sala), 'a mensagem depois da saída não chegou');
  assert.ok(!pcAna.db.get('SELECT 1 AS x FROM salas_cessoes WHERE conversation_id = ? AND revogada_em IS NULL', sala));
});
