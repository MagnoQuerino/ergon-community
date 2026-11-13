/**
 * Várias contas por aplicativo (rc.29): dois e-mails, dois números de WhatsApp, duas contas do mesmo quadro. A primeira conta
 * continua funcionando igual (a de antes vira a principal na migração 0046); cada conta tem a credencial própria no cofre, o
 * apelido, o liga/desliga e a escrita dela; o agente escolhe pelo nome (sem dizer, a principal); o cartão diz por qual conta
 * sai; rotinas leem uma, várias ou todas e dizem de qual conta veio; cada número do WhatsApp tem o seu pareamento. Conta de
 * uma pessoa nunca aparece para outra, e a conta emprestada entre workspaces continua valendo.
 * O aplicativo de teste é o Asana, com a API simulada (o token diz qual conta é); o motor é falso e fica "rodando".
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { AccountReader } from '../src/services/account-reader.ts';
import { promptConexoes } from '../src/services/conexoes/catalogo.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { acharConta, contasDe, integrationRow, setIntegration } from '../src/services/integrations.ts';
import type { SsoAuth } from '../src/services/sso.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { addPerson, harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
const TRABALHO = 'tok-asana-trabalho-0123456789';
const PESSOAL = 'tok-asana-pessoal-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_teste${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// ---------------------------------------------------------------- Asana simulado: cada token é uma conta
type Call = { method: string; path: string; auth: string; body: any };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const quem = (auth: string) => (auth.includes(PESSOAL) ? { name: 'Ana Pessoal', gid: 'u2' } : { name: 'Ana Trabalho', gid: 'u1' });
let agenda: (auth: string) => unknown[] = () => [];
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? '';
  if (url.host === 'www.googleapis.com' && url.pathname.includes('/calendar/')) return Promise.resolve(json({ items: agenda(auth) }));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const p = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  if (method !== 'GET') calls.push({ method, path: p, auth, body: init.body ? JSON.parse(String(init.body)) : null });
  if (p === '/users/me') return Promise.resolve(json({ data: { ...quem(auth), workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (p === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (p === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (p === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  if (p === '/tasks' && method === 'GET') return Promise.resolve(json({ data: [] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
beforeEach(() => { calls.length = 0; agenda = () => []; });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': TOKEN }));
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
async function preparar(): Promise<void> {
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  // a conta de antes: a principal, conectada como sempre
  assert.equal((await req(h, 'POST', '/api/integrations/asana/token', s, { token: TRABALHO })).status, 200);
}
const adicionar = (token = PESSOAL) => req(h, 'POST', '/api/integrations/asana/token', s, { token, conta: 'nova' });
const daTela = async (sess = s) => (await req(h, 'GET', '/api/integrations', sess)).json.find((i: { kind: string }) => i.kind === 'asana') as { state: string; account: string; contas: Array<{ conta: string; id: string; principal: boolean; nome: string; ativa: boolean; state: string }> };
const segunda = () => contasDe(h.db, s.workspaceId, 'asana').find((c) => c.conta !== '')!;
async function conversar(texto: string): Promise<{ sessao: string; run: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!;
  return { sessao: r.hermes_session_id, run: r.id };
}
/** Um card que não partiu da pessoa (veio de uma mensagem recebida): toda escrita pede o cartão. */
async function cardNaFila(titulo: string): Promise<{ sessao: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  return { sessao: h.db.get<{ hermes_session_id: string }>("SELECT hermes_session_id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)!.hermes_session_id };
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>, conta?: string) => ponte({ op: 'executar', session_id: sessao, conexao: 'asana', acao, parametros, ...(conta ? { conta } : {}) });

describe('várias contas do mesmo aplicativo', () => {
  beforeEach(preparar);
  afterEach(() => h.close());

  test('duas contas com o mesmo nome e sem apelido: o agente vê "Ana" e "Ana (2)" e consegue escolher a segunda', async () => {
    assert.equal((await adicionar()).status, 200);
    h.db.run("UPDATE integrations SET account_label = 'Ana' WHERE workspace_id = ? AND kind = 'asana'", s.workspaceId);
    const vistas = h.integrations.contasDoAgente(s.workspaceId, 'asana');
    assert.deepEqual(vistas.map((c) => c.nome), ['Ana', 'Ana (2)']);
    const todas = contasDe(h.db, s.workspaceId, 'asana');
    assert.equal(acharConta(todas, 'Ana (2)')?.conta, segunda().conta, 'o nome que o agente vê serve para pedir');
    assert.equal(acharConta(todas, 'ana')?.conta, '', '"Ana" sozinha é a primeira (a principal)');
    const { sessao } = await conversar('crie a tarefa pela outra conta');
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Pela segunda', quadro: 'Vendas' }, 'Ana (2)')).json;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(calls.some((c) => c.method === 'POST' && c.auth.includes(PESSOAL)), 'saiu pela segunda conta');
  });

  test('uma conta só: a tela é a de sempre (a conta é a principal), e o agente não vê nada de "contas"', async () => {
    const a = await daTela();
    assert.equal(a.state, 'connected'); assert.equal(a.account, 'Ana Trabalho');
    assert.equal(a.contas.length, 1); assert.equal(a.contas[0].principal, true); assert.equal(a.contas[0].conta, '');
    assert.doesNotMatch(promptConexoes(h.db, s.workspaceId), /contas:/);
    const { sessao } = await conversar('o que dá para fazer no Asana?');
    assert.doesNotMatch((await ponte({ op: 'listar', session_id: sessao, conexao: 'asana' })).json.texto, /contas:/);
  });

  test('adicionar outra conta: credencial própria no cofre, a principal não muda; a mesma conta não entra duas vezes', async () => {
    const r = await adicionar();
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.account, 'Ana Pessoal');
    const a = await daTela();
    assert.equal(a.account, 'Ana Trabalho', 'o cartão continua com a principal');
    assert.deepEqual(a.contas.map((c) => [c.principal, c.nome]), [[true, 'Ana Trabalho'], [false, 'Ana Pessoal']]);
    const outra = segunda();
    assert.match(outra.conta, /^c[0-9a-f]{8}$/);
    assert.equal(h.integrations.secrets.read<{ token: string }>(s.workspaceId, 'asana')!.token, TRABALHO);
    assert.equal(h.integrations.secrets.read<{ token: string }>(s.workspaceId, 'asana', outra.conta)!.token, PESSOAL);
    const dir = path.join(h.cfg.dataDir, 'secrets');
    assert.ok(fs.existsSync(path.join(dir, `${s.workspaceId}-asana.json`)) && fs.existsSync(path.join(dir, `${s.workspaceId}-asana.${outra.conta}.json`)), 'um arquivo por conta');
    const de_novo = await adicionar();
    assert.equal(de_novo.status, 409); assert.equal(de_novo.json.error, 'ja_conectada');
    assert.equal(contasDe(h.db, s.workspaceId, 'asana').length, 2);
  });

  test('apelido editável (padrão: o nome da conta), sem repetir; o agente acha pelo apelido, pelo nome ou por parte dele', async () => {
    await adicionar();
    const c = segunda().conta;
    assert.equal((await req(h, 'PATCH', `/api/integrations/asana/contas/${c}`, s, { apelido: 'Pessoal' })).status, 200);
    assert.equal((await daTela()).contas[1].nome, 'Pessoal');
    const rep = await req(h, 'PATCH', '/api/integrations/asana/contas/principal', s, { apelido: 'pessoal' });
    assert.equal(rep.status, 409); assert.equal(rep.json.error, 'apelido_repetido');
    assert.equal(rep.json.message_t?.codigo, 'erro.apelidoRepetido', 'a tela em inglês traduz');
    const todas = contasDe(h.db, s.workspaceId, 'asana');
    assert.equal(acharConta(todas, '')?.conta, '', 'sem dizer: a principal');
    assert.equal(acharConta(todas, 'PESSOAL')?.conta, c);
    assert.equal(acharConta(todas, 'Ana Trabalho')?.conta, '');
    assert.equal(acharConta(todas, 'trabalho')?.conta, '', 'parte do nome, única');
    assert.equal(acharConta(todas, 'Ana'), null, 'parte que serve às duas: pergunta');
    // apelido em branco: volta o nome da conta
    await req(h, 'PATCH', `/api/integrations/asana/contas/${c}`, s, { apelido: '' });
    assert.equal((await daTela()).contas[1].nome, 'Ana Pessoal');
  });

  test('o agente vê as contas e escolhe por qual sai; sem dizer, a principal; conta que não existe diz as opções', async () => {
    await adicionar();
    await req(h, 'PATCH', `/api/integrations/asana/contas/${segunda().conta}`, s, { apelido: 'Pessoal' });
    assert.match(promptConexoes(h.db, s.workspaceId), /contas: "Ana Trabalho" \(principal[^)]*\), "Pessoal"/);
    const { sessao } = await conversar('crie a tarefa Revisar no Asana, no quadro Vendas');
    assert.match((await ponte({ op: 'listar', session_id: sessao, conexao: 'asana' })).json.texto, /"Pessoal"/);
    const r1 = (await executar(sessao, 'tarefa.criar', { titulo: 'Pela principal', quadro: 'Vendas' })).json;
    assert.equal(r1.status, 'feita', JSON.stringify(r1));
    assert.equal(calls.at(-1)!.auth, `Bearer ${TRABALHO}`);
    const r2 = (await executar(sessao, 'tarefa.criar', { titulo: 'Pela pessoal', quadro: 'Vendas' }, 'Pessoal')).json;
    assert.equal(r2.status, 'feita', JSON.stringify(r2));
    assert.equal(calls.at(-1)!.auth, `Bearer ${PESSOAL}`);
    const linha = h.db.get<{ integracao_id: string; conta: string }>("SELECT integracao_id, conta FROM conexao_acoes WHERE acao = 'tarefa.criar' ORDER BY created_at DESC LIMIT 1")!;
    assert.equal(linha.integracao_id, segunda().id, 'o registro guarda por qual conta saiu');
    const r3 = (await executar(sessao, 'tarefa.criar', { titulo: 'X', quadro: 'Vendas' }, 'Financeiro')).json;
    assert.equal(r3.status, 'falhou'); assert.match(r3.texto, /não tem a conta "Financeiro".*"Ana Trabalho", "Pessoal"/);
  });

  test('liga/desliga e escrita por conta: desligada ou só leitura numa, a outra segue', async () => {
    await adicionar();
    const c = segunda().conta;
    const { sessao } = await conversar('crie no Asana');
    await req(h, 'PATCH', `/api/integrations/asana/contas/${c}`, s, { ativa: false });
    const off = (await executar(sessao, 'tarefa.criar', { titulo: 'A', quadro: 'Vendas' }, 'Ana Pessoal')).json;
    assert.equal(off.status, 'falhou'); assert.match(off.texto, /desligou a conta "Ana Pessoal"/);
    assert.doesNotMatch(promptConexoes(h.db, s.workspaceId), /Ana Pessoal/, 'desligada nem aparece ao agente');
    await req(h, 'PATCH', `/api/integrations/asana/contas/${c}`, s, { ativa: true });
    assert.equal((await req(h, 'PUT', '/api/conexoes/asana/so-leitura', s, { on: true, conta: c })).status, 200);
    const so = (await executar(sessao, 'tarefa.criar', { titulo: 'B', quadro: 'Vendas' }, 'Ana Pessoal')).json;
    assert.equal(so.status, 'falhou'); assert.match(so.texto, /desligou esta ação/);
    const principal = (await executar(sessao, 'tarefa.criar', { titulo: 'C', quadro: 'Vendas' })).json;
    assert.equal(principal.status, 'feita', 'a escrita da principal não mudou');
    const tela = (await req(h, 'GET', '/api/conexoes', s)).json.ligadas.find((x: { kind: string }) => x.kind === 'asana');
    assert.deepEqual(tela.contas.map((x: { soLeitura: boolean }) => x.soLeitura), [false, true]);
    // a principal desligada: sem dizer qual, sai pela única ligada
    await req(h, 'PATCH', '/api/integrations/asana/contas/principal', s, { ativa: false });
    await req(h, 'PUT', '/api/conexoes/asana/so-leitura', s, { on: false, conta: c });
    const unica = (await executar(sessao, 'tarefa.criar', { titulo: 'D', quadro: 'Vendas' })).json;
    assert.equal(unica.status, 'feita', JSON.stringify(unica)); assert.equal(calls.at(-1)!.auth, `Bearer ${PESSOAL}`);
  });

  test('o cartão de confirmação diz por qual conta sai, e o clique sai por ela mesmo depois de trocar a principal', async () => {
    await adicionar();
    const outra = segunda();
    await req(h, 'PATCH', `/api/integrations/asana/contas/${outra.conta}`, s, { apelido: 'Pessoal' });
    const { sessao } = await cardNaFila('Organizar no Asana');
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Do card', quadro: 'Vendas' }, 'Pessoal')).json;
    assert.equal(r.status, 'aguardando_confirmacao', JSON.stringify(r)); assert.equal(calls.length, 0);
    const cartao = h.db.get<{ id: string; payload: string }>("SELECT id, payload FROM agent_proposals WHERE kind = 'conexao' ORDER BY created_at DESC LIMIT 1")!;
    assert.equal(JSON.parse(cartao.payload).conta, 'Pessoal (Ana Pessoal)', 'o cartão mostra a conta');
    // trocar a principal antes do clique: o cartão continua saindo pela conta que ele mostrou
    assert.equal((await req(h, 'PATCH', `/api/integrations/asana/contas/${outra.conta}`, s, { principal: true })).status, 200);
    assert.equal(integrationRow(h.db, s.workspaceId, 'asana').id, outra.id, 'a outra virou a principal (o id segue a conta)');
    assert.equal(h.integrations.secrets.read<{ token: string }>(s.workspaceId, 'asana')!.token, PESSOAL, 'a credencial seguiu a conta');
    const d = await req(h, 'POST', `/api/proposals/${cartao.id}`, s, { decision: 'apply' });
    assert.equal(d.status, 200, JSON.stringify(d.json)); assert.equal(d.json.status, 'applied', JSON.stringify(d.json));
    assert.equal(calls.at(-1)!.auth, `Bearer ${PESSOAL}`);
  });

  test('desconectar outra conta a tira da lista; desconectar a principal promove a outra', async () => {
    await adicionar();
    const outra = segunda();
    assert.equal((await req(h, 'DELETE', `/api/integrations/asana?conta=${outra.conta}`, s)).status, 200);
    assert.equal((await daTela()).contas.length, 1);
    assert.equal(h.integrations.secrets.readOwn(s.workspaceId, 'asana', outra.conta), null, 'a credencial saiu do cofre');
    await adicionar();
    const nova = segunda();
    assert.equal((await req(h, 'DELETE', '/api/integrations/asana', s)).status, 200);
    const a = await daTela();
    assert.equal(a.state, 'connected'); assert.equal(a.account, 'Ana Pessoal', 'a outra conta virou a principal');
    assert.equal(integrationRow(h.db, s.workspaceId, 'asana').id, nova.id);
  });

  test('isolamento: a conta de uma pessoa nunca aparece para outra; conta entre workspaces continua valendo, como mais uma conta', async () => {
    await adicionar();
    const bia = await addPerson(h, 'bia', 'senha-da-bia-123');
    const deBia = await daTela(bia);
    assert.ok(!deBia || deBia.contas.every((c) => c.nome !== 'Ana Pessoal' && c.nome !== 'Ana Trabalho'), 'nada da Ana para a Bia');
    assert.equal((await req(h, 'PATCH', `/api/integrations/asana/contas/${segunda().conta}`, bia, { apelido: 'x' })).status >= 400, true);
    // outro workspace da Ana: usa a pessoal como mais uma conta lá, sem colar de novo
    const ws2 = (await req(h, 'POST', '/api/workspaces', s, { name: 'Pessoal' })).json.workspaceId;
    h.integrations.secrets.write(ws2, 'asana', { token: TRABALHO });
    setIntegration(h.db, ws2, 'asana', { state: 'connected', account_label: 'Ana Trabalho', connected_at: new Date().toISOString() });
    const r = h.integrations.usarDe(ws2, s.userId, 'asana', s.workspaceId, segunda().conta, 'nova');
    assert.equal(r, 'Ana Pessoal');
    const la = contasDe(h.db, ws2, 'asana');
    assert.equal(la.length, 2);
    assert.equal(h.integrations.secrets.read<{ token: string }>(ws2, 'asana', la[1].conta)!.token, PESSOAL, 'lê a credencial de lá');
    assert.equal(h.integrations.secrets.readOwn(ws2, 'asana', la[1].conta), null, 'nada copiado');
  });
});

describe('migração 0046: a conta de antes vira a principal, sem perder nada', () => {
  test('banco parado na 0045 com conexões e mensagens do WhatsApp: tudo fica, com a conta principal', () => {
    const dir = tmpDir();
    const db = new Db(path.join(dir, 'ergon.sqlite'));
    db.migrate({ until: '0045_motivo_da_iniciativa.sql' });
    const ws = `ws_${crypto.randomBytes(16).toString('hex')}`; const now = new Date().toISOString();
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws, 'Empresa', now);
    db.run("INSERT INTO integrations (id, workspace_id, kind, state, account_label, settings, connected_at, created_at) VALUES ('int_a', ?, 'asana', 'connected', 'Ana', '{\"permissoes\":{\"tipos\":{\"enviar\":\"confirmar\"},\"acoes\":{}}}', ?, ?)", ws, now, now);
    db.run("INSERT INTO integrations (id, workspace_id, kind, state, account_label, settings, created_at) VALUES ('int_w', ?, 'whatsapp', 'connected', 'Meu WhatsApp', '{}', ?)", ws, now);
    db.run("INSERT INTO connections (id, workspace_id, kind, label, mode, created_at) VALUES ('con_w', ?, 'whatsapp', 'WhatsApp', 'real', ?)", ws, now);
    db.run("INSERT INTO source_events (id, workspace_id, connection_id, external_id, event_type, received_at, status) VALUES ('evt_1', ?, 'con_w', 'WA1', 'message', ?, 'accepted')", ws, now);
    db.migrate();
    const rows = db.all<{ id: string; kind: string; conta: string; ativa: number; settings: string; account_label: string }>('SELECT id, kind, conta, ativa, settings, account_label FROM integrations ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.id, r.kind, r.conta, r.ativa, r.account_label]), [['int_a', 'asana', '', 1, 'Ana'], ['int_w', 'whatsapp', '', 1, 'Meu WhatsApp']]);
    assert.match(rows[0].settings, /confirmar/, 'o ajuste da conta ficou');
    assert.equal(db.get<{ i: string }>("SELECT integracao_id AS i FROM source_events WHERE id = 'evt_1'")!.i, 'int_w', 'a mensagem de antes veio pelo número principal');
    assert.equal(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    // a segunda conta do mesmo aplicativo agora cabe; duas principais, não
    db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, created_at) VALUES ('int_b', ?, 'asana', 'c0123abcd', 'off', ?)", ws, now);
    assert.throws(() => db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, created_at) VALUES ('int_c', ?, 'asana', '', 'off', ?)", ws, now));
    assert.throws(() => db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, created_at) VALUES ('int_d', ?, 'asana', 'xyz', 'off', ?)", ws, now), 'id de conta fora do formato');
    db.close();
  });
});

describe('rotinas: ler uma, várias ou todas as contas, dizendo de qual veio', () => {
  let h2: Harness; let s2: Session;
  before(async () => { h2 = await harness(); s2 = await setupOwner(h2); });
  after(() => h2.close());
  test('duas contas Google: a agenda lê as duas e marca a conta; a escolha da rotina limita; desligada não é lida', async () => {
    const ws = s2.workspaceId;
    setIntegration(h2.db, ws, 'google', { state: 'connected', account_label: 'ana@empresa.com' });
    const c = h2.integrations.novaConta(ws, 'google');
    setIntegration(h2.db, ws, 'google', { state: 'connected', account_label: 'ana@gmail.com', apelido: 'Pessoal' }, c);
    const pedidos: string[] = [];
    const sso = { accessToken: async (_w: string, _k: string, o: { conta?: string } = {}) => { pedidos.push(o.conta ?? ''); return `tok-${o.conta || 'principal'}`; } } as unknown as SsoAuth;
    agenda = (auth) => [{ summary: auth.includes('principal') ? 'Reunião do trabalho' : 'Dentista', start: { dateTime: new Date(Date.now() + 3600_000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200_000).toISOString() } }];
    const leitor = new AccountReader(h2.db, sso, { googleTesting: false });
    const todas = await leitor.events(ws, 2);
    assert.deepEqual(todas.items.map((e) => [e.title, e.contaNome]).sort(), [['Dentista', 'Pessoal'], ['Reunião do trabalho', 'ana@empresa.com']]);
    assert.equal(todas.reads.filter((r) => r.status === 'ok').length, 2);
    const idPessoal = contasDe(h2.db, ws, 'google').find((x) => x.conta === c)!.id;
    const so = await leitor.so([idPessoal]).events(ws, 2);
    assert.deepEqual(so.items.map((e) => e.title), ['Dentista'], 'só a escolhida');
    pedidos.length = 0;
    h2.integrations.ligar(ws, s2.userId, 'google', c, false);
    const semADesligada = await leitor.events(ws, 2);
    assert.deepEqual(semADesligada.items.map((e) => e.title), ['Reunião do trabalho']);
    assert.deepEqual(pedidos, [''], 'a desligada nem pede acesso');
    // a rotina que escolheu só a pessoal, com ela desligada: não passa a ler a do trabalho, que a pessoa deixou de fora
    pedidos.length = 0;
    const soADesligada = await leitor.so([idPessoal]).events(ws, 2);
    assert.deepEqual(soADesligada.items, [], 'a escolha da rotina continua valendo');
    assert.deepEqual(pedidos, [], 'nenhuma conta pede acesso');
    // uma conta só de novo: nada de marca de conta (como sempre foi)
    assert.equal(semADesligada.items[0].contaNome, undefined);
  });
  test('a rotina guarda a escolha só com contas deste workspace', async () => {
    const lib = (await req(h2, 'GET', '/api/routines/library', s2)).json;
    const tpl = (lib.routines as Array<{ key: string; sources?: string[] }>)[0];
    const r = (await req(h2, 'POST', '/api/routines', s2, { template: tpl.key })).json;
    const id = r.id ?? r.routine?.id;
    const minha = contasDe(h2.db, s2.workspaceId, 'google')[0].id;
    const p = await req(h2, 'PATCH', `/api/routines/${id}`, s2, { contas: [minha, `int_${'0'.repeat(32)}`] });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual(p.json.config.contas, [minha], 'a de fora (ou de outra pessoa) não entra');
  });
});

describe('WhatsApp com vários números: cada um com o seu pareamento', () => {
  let h3: Harness; let s3: Session;
  const socks: Array<{ bus: EventEmitter; id: string }> = [];
  /** o número do próximo aparelho pareado (null: o da lista) */
  let forcar: string | null = null;
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  before(async () => {
    h3 = await harness(); s3 = await setupOwner(h3);
    const numeros = ['5511999990000', '5521988880000'];
    h3.whatsapp.loader = async () => ({
      makeWASocket: () => {
        const bus = new EventEmitter(); const id = forcar ?? numeros[socks.length] ?? '5531977770000';
        socks.push({ bus, id });
        return { ev: { on: (n: string, f: (...a: unknown[]) => void) => bus.on(n, f), removeAllListeners: () => bus.removeAllListeners() }, user: { id: `${id}:3@s.whatsapp.net`, name: 'Ana' }, end() {}, ws: { close() {} }, async logout() {}, async groupMetadata() { return { subject: 'Grupo' }; } };
      },
      DisconnectReason: { loggedOut: 401 },
      BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v }, initAuthCreds: () => ({ me: null }), proto: { Message: { AppStateSyncKeyData: { fromObject: (x: unknown) => x } } },
    });
    h3.whatsapp.qrLoader = async () => ({ toDataURL: async () => 'data:image/png;base64,QR' });
  });
  after(() => h3.close());
  const msg = (chat: string, text: string, id: string) => ({ type: 'notify', messages: [{ key: { remoteJid: chat, id, fromMe: false }, pushName: 'Cliente', message: { conversation: text }, messageTimestamp: 1761300000 }] });

  test('dois números: dois QRs, duas pastas de sessão, o que chega diz por qual número veio', async () => {
    assert.equal((await req(h3, 'POST', '/api/integrations/whatsapp/start', s3, { aceitoRiscos: true })).status, 200);
    socks[0].bus.emit('connection.update', { connection: 'open' }); await wait();
    const r = await req(h3, 'POST', '/api/integrations/whatsapp/start', s3, { conta: 'nova' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = r.json.conta as string;
    assert.match(c, /^c[0-9a-f]{8}$/, 'um número novo, sem pedir o aceite de novo');
    socks[1].bus.emit('connection.update', { qr: 'codigo' }); await wait();
    assert.equal((await req(h3, 'GET', `/api/integrations/whatsapp?conta=${c}`, s3)).json.status, 'qr', 'o QR é do número novo');
    assert.equal((await req(h3, 'GET', '/api/integrations/whatsapp', s3)).json.status, 'connected', 'o principal segue lendo');
    socks[1].bus.emit('connection.update', { connection: 'open' }); await wait();
    const contas = contasDe(h3.db, s3.workspaceId, 'whatsapp');
    assert.deepEqual(contas.map((x) => x.state), ['connected', 'connected']);
    assert.match(contas[1].account_label!, /\+5521988880000/, 'com dois números, o número vai junto do nome');
    const dir = path.join(h3.cfg.dataDir, 'secrets');
    assert.ok(fs.existsSync(path.join(dir, `${s3.workspaceId}-whatsapp`)) && fs.existsSync(path.join(dir, `${s3.workspaceId}-whatsapp.${c}`)), 'uma pasta de sessão por número');
    // cada número guarda o que chega a ele, marcado com o número
    socks[0].bus.emit('messages.upsert', msg('5511888880000@s.whatsapp.net', 'Oi pelo número 1', 'M1')); await wait();
    socks[1].bus.emit('messages.upsert', msg('5511777770000@s.whatsapp.net', 'Oi pelo número 2', 'M2')); await wait();
    const ev = h3.db.all<{ integracao_id: string; channel: string }>("SELECT integracao_id, channel FROM source_events WHERE external_id IN ('M1', ?) ORDER BY external_id", `${c}:M2`);
    assert.deepEqual(ev.map((e) => e.integracao_id), [contas[0].id, contas[1].id]);
    assert.deepEqual(h3.whatsapp.conversas(s3.workspaceId, c).map((x) => x.jid), ['5511777770000@s.whatsapp.net'], 'cada número só vê as conversas dele');
    assert.deepEqual(h3.whatsapp.conversas(s3.workspaceId).map((x) => x.jid), ['5511888880000@s.whatsapp.net']);
    // a mesma mensagem de um grupo (o mesmo id) chega aos dois números: cada um guarda a sua, nenhuma vira "repetida"
    for (const corpo of [{ groups: true }, { groups: true, conta: c }]) assert.equal((await req(h3, 'PUT', '/api/integrations/whatsapp/filters', s3, corpo)).status, 200);
    const grupo = { type: 'notify', messages: [{ key: { remoteJid: '120363000000000001@g.us', participant: '5511666660000@s.whatsapp.net', id: 'G1', fromMe: false }, pushName: 'Cliente', message: { conversation: 'Oi, grupo' }, messageTimestamp: 1761300000 }] };
    socks[0].bus.emit('messages.upsert', grupo); await wait();
    socks[1].bus.emit('messages.upsert', grupo); await wait();
    const doGrupo = h3.db.all<{ integracao_id: string; status: string }>("SELECT integracao_id, status FROM source_events WHERE external_id IN ('G1', ?) ORDER BY external_id", `${c}:G1`);
    assert.deepEqual(doGrupo.map((e) => [e.integracao_id, e.status]), [[contas[0].id, 'accepted'], [contas[1].id, 'accepted']]);
    // desconectar o número novo não mexe no principal
    assert.equal((await req(h3, 'DELETE', `/api/integrations/whatsapp?conta=${c}`, s3)).status, 200);
    assert.equal(contasDe(h3.db, s3.workspaceId, 'whatsapp').length, 1);
    assert.equal((await req(h3, 'GET', '/api/integrations/whatsapp', s3)).json.status, 'connected');
    assert.ok(!fs.existsSync(path.join(dir, `${s3.workspaceId}-whatsapp.${c}`)), 'a sessão do número saiu');
  });

  test('número pareado antes da rc.29: a sessão retomada guarda o número, e o mesmo número não entra de novo como "outro número"', async () => {
    const ws = s3.workspaceId;
    const principal = integrationRow(h3.db, ws, 'whatsapp');
    // como na rc.28: conectado, sem o número guardado
    const { numero: _n, ...semNumero } = JSON.parse(principal.settings) as Record<string, unknown>;
    setIntegration(h3.db, ws, 'whatsapp', { settings: semNumero });
    assert.equal(JSON.parse(integrationRow(h3.db, ws, 'whatsapp').settings).numero, undefined);
    socks[0].bus.emit('connection.update', { connection: 'open' }); await wait(); // a sessão voltou (reinício)
    assert.equal(JSON.parse(integrationRow(h3.db, ws, 'whatsapp').settings).numero, '5511999990000', 'o número ficou guardado');
    forcar = '5511999990000';
    try {
      const r = await req(h3, 'POST', '/api/integrations/whatsapp/start', s3, { conta: 'nova' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const nova = r.json.conta as string;
      assert.equal(JSON.parse(integrationRow(h3.db, ws, 'whatsapp', nova).settings).numero, undefined, 'o número novo não herda o número do principal');
      socks.at(-1)!.bus.emit('connection.update', { connection: 'open' }); await wait();
      assert.deepEqual(contasDe(h3.db, ws, 'whatsapp').map((x) => x.conta), [''], 'o mesmo número pareado de novo sai; o de antes continua');
      assert.ok(!fs.existsSync(path.join(h3.cfg.dataDir, 'secrets', `${ws}-whatsapp.${nova}`)));
    } finally { forcar = null; }
  });
});

describe('rotina com conta escolhida: a escolha vale mesmo depois que a conta escolhida sai', () => {
  let h4: Harness; let s4: Session;
  before(async () => { h4 = await harness(); s4 = await setupOwner(h4); });
  after(() => h4.close());
  const rotina = async () => {
    const lib = (await req(h4, 'GET', '/api/routines/library', s4)).json;
    const r = (await req(h4, 'POST', '/api/routines', s4, { template: (lib.routines as Array<{ key: string }>)[0].key })).json;
    return (r.id ?? r.routine?.id) as string;
  };
  const config = (id: string) => JSON.parse(h4.db.get<{ config: string }>('SELECT config FROM routines WHERE id = ?', id)!.config) as { contas?: string[]; contasApps?: string[] };

  test('Google: a conta Pessoal escolhida é desconectada e apagada; a do trabalho, deixada de fora, não passa a ser lida', async () => {
    const ws = s4.workspaceId;
    setIntegration(h4.db, ws, 'google', { state: 'connected', account_label: 'ana@empresa.com' });
    const c = h4.integrations.novaConta(ws, 'google');
    setIntegration(h4.db, ws, 'google', { state: 'connected', account_label: 'ana@gmail.com', apelido: 'Pessoal' }, c);
    const idPessoal = contasDe(h4.db, ws, 'google').find((x) => x.conta === c)!.id;
    const id = await rotina();
    assert.equal((await req(h4, 'PATCH', `/api/routines/${id}`, s4, { contas: [idPessoal] })).status, 200);
    assert.deepEqual(config(id).contasApps, ['google'], 'a escolha guarda de qual aplicativo é');
    // desconectada e limpa (como limparAbandonadas faz): a linha some do banco
    h4.db.run('DELETE FROM integrations WHERE id = ?', idPessoal);
    const pedidos: string[] = [];
    const sso = { accessToken: async (_w: string, _k: string, o: { conta?: string } = {}) => { pedidos.push(o.conta ?? ''); return 'tok-principal'; } } as unknown as SsoAuth;
    agenda = () => [{ summary: 'Reunião do trabalho', start: { dateTime: new Date(Date.now() + 3600_000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200_000).toISOString() } }];
    const leitor = new AccountReader(h4.db, sso, { googleTesting: false });
    const cfg = config(id);
    const lido = await leitor.so(cfg.contas, cfg.contasApps).events(ws, 2);
    assert.deepEqual(lido.items, [], 'nada da conta deixada de fora');
    assert.deepEqual(pedidos, [], 'nenhuma conta pede acesso');
    const f = await leitor.so(cfg.contas, cfg.contasApps).read(ws, ['agenda'], new Date(Date.now() - 86400_000).toISOString(), 'America/Sao_Paulo');
    assert.equal(f.reads.find((r) => r.account === 'google')?.status, 'nao_conectada', 'a leitura diz que o Google escolhido não está conectado');
    // sem escolha, continua lendo todas (como sempre)
    assert.deepEqual((await leitor.events(ws, 2)).items.map((e) => e.title), ['Reunião do trabalho']);
  });

  test('WhatsApp: o número escolhido sai; as mensagens do outro número não entram, e a seção diz isso', async () => {
    const ws = s4.workspaceId; const now = new Date().toISOString();
    setIntegration(h4.db, ws, 'whatsapp', { state: 'connected', account_label: 'Pessoal' });
    const c = h4.integrations.novaConta(ws, 'whatsapp');
    setIntegration(h4.db, ws, 'whatsapp', { state: 'connected', account_label: 'Loja' }, c);
    const [principal, loja] = contasDe(h4.db, ws, 'whatsapp');
    const con = h4.db.get<{ id: string }>("SELECT id FROM connections WHERE workspace_id = ? AND kind = 'whatsapp' AND mode = 'real'", ws)?.id ?? 'con_wa4';
    h4.db.run("INSERT OR IGNORE INTO connections (id, workspace_id, kind, label, mode, created_at) VALUES (?, ?, 'whatsapp', 'WhatsApp', 'real', ?)", con, ws, now);
    const evento = (id: string, texto: string, conta: string) => h4.db.run("INSERT INTO source_events (id, workspace_id, connection_id, external_id, event_type, received_at, status, text_excerpt, actor_display, integracao_id) VALUES (?, ?, ?, ?, 'message', ?, 'accepted', ?, 'Cliente', ?)", id, ws, con, id, now, texto, conta);
    evento('evt_p1', 'mensagem do número pessoal', principal.id);
    evento('evt_l1', 'pedido da loja', loja.id);
    const { gatherExtra } = await import('../src/services/routine-sources.ts');
    const ctx = (contas: string[] | undefined, contasApps?: string[]) => ({ db: h4.db, ws, since: new Date(Date.now() - 86400_000).toISOString(), tz: 'America/Sao_Paulo', filesDir: h4.cfg.dataDir, accounts: null, contas, contasApps, input: {}, params: {}, horizonDays: 7, docBudget: 10_000 });
    const linhas = async (contas?: string[], apps?: string[]) => (await gatherExtra(ctx(contas, apps), ['mensagens.texto'])).sections.find((x) => x.key === 'mensagens.texto')!.lines.join('\n');
    assert.match(await linhas([loja.id], ['whatsapp']), /pedido da loja/);
    assert.doesNotMatch(await linhas([loja.id], ['whatsapp']), /número pessoal/);
    // o número da loja é desconectado e a linha some
    h4.db.run('DELETE FROM integrations WHERE id = ?', loja.id);
    const depois = await linhas([loja.id], ['whatsapp']);
    assert.doesNotMatch(depois, /número pessoal/, 'o número deixado de fora continua de fora');
    assert.doesNotMatch(depois, /pedido da loja/, 'mensagem de um número que saiu não entra');
    assert.match(depois, /não está mais conectado/);
    // sem escolha: lê os números ligados (como sempre)
    assert.match(await linhas(), /número pessoal/);
  });
});
