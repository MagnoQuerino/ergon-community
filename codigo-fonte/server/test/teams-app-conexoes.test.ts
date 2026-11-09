/**
 * Pelo Teams vale a mesma regra das ações nas contas que vale no app: o que a pessoa pede pela conta do Teams ligada vai
 * direto; o que não partiu dela pede cartão, o cartão vai ao Teams, e o clique lá decide pela mesma função da tela (a ação
 * sai uma vez, com o mesmo registro). O aplicativo de teste é o Asana, com a API simulada; o motor é falso e fica
 * "rodando" para a ponte reconhecer a sessão; o serviço do Teams é o falso em processo.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

const TOKEN = ['token-da-ponte', 'de-teste', '0123456789'].join('-');
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>(); n = 0;
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

const chamadas: Array<{ method: string; path: string }> = [];
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'slack.com') {
    // Slack simulado: o bastante para o cartão de "apagar" mostrar o canal e a mensagem, e para apagar de fato
    if ((init.method ?? 'GET') !== 'GET' && url.pathname !== '/api/auth.test') chamadas.push({ method: init.method ?? 'GET', path: url.pathname });
    return Promise.resolve(json({ ok: true, team: 'Acme', user: 'ana', user_id: 'U012AB3CD', channel: { id: 'C012AB3CD', name: 'geral' }, channels: [{ id: 'C012AB3CD', name: 'geral' }],
      messages: [{ type: 'message', user: 'U012AB3CD', text: 'mensagem antiga', ts: '1503435956.000247' }], user_profile: {}, profile: { real_name: 'Ana' }, has_more: false, response_metadata: { next_cursor: '' } }));
  }
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const p = url.pathname.replace('/api/1.0', ''); const method = init.method ?? 'GET';
  if (method !== 'GET') chamadas.push({ method, path: p });
  if (p === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (p === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (p === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (p === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let rele: ReleFalso;
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(msg);
}
beforeEach(async () => {
  chamadas.length = 0;
  rele = await ReleFalso.iniciar();
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN, teamsRelayUrl: rele.base }, { hermes: motor });
  h.teamsApp.ajustes = { avisosMs: 100, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400 } };
  s = await setupOwner(h);
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: ['tok', 'asana', 'de', 'teste', '123456'].join('-') });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
  await h.teamsApp.start();
  await ate(() => rele.conectado());
});
afterEach(async () => { await h.close(); await rele.parar(); });

async function ligar(): Promise<string> {
  const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') });
  return (await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: 'senha-local-123' })).json.binding.id;
}
/** A pessoa escreve no Teams: a execução fica rodando no motor (a sessão dela). */
async function noTeams(b: string, texto: string): Promise<{ sessao: string; run: string }> {
  const antes = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')!.n;
  rele.diz(b, texto);
  await ate(() => !!h.db.get("SELECT 1 AS x FROM runs WHERE hermes_session_id IS NOT NULL AND rowid > ?", antes), 'a execução não começou');
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs ORDER BY rowid DESC LIMIT 1')!;
  return { sessao: r.hermes_session_id, run: r.id };
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>) =>
  req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao: 'asana', acao, parametros }, { 'x-ergon-bridge-token': TOKEN });
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', runId)!.status === 'succeeded');
}

test('pedido da pessoa pelo Teams vai direto; o que não partiu dela vira cartão no Teams, e Aprovar lá executa pela mesma função', async () => {
  const b = await ligar();
  const um = await noTeams(b, 'cria a tarefa "Revisar contrato" no Asana, em Vendas');
  const direto = (await executar(um.sessao, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json;
  assert.equal(direto.status, 'feita', 'pedido dela (pela conta do Teams ligada): sem cartão');
  assert.equal(chamadas.length, 1);
  await terminar(um.run, 'Criei a tarefa "Revisar contrato" em Vendas.');
  await ate(() => rele.enviados.some((e) => e.purpose === 'reply' && /Revisar contrato/.test(e.text ?? '')), 'a resposta não voltou');
  assert.ok(!rele.enviados.some((e) => e.card), 'nenhum cartão');

  // a mesma sessão, agora como se uma rotina tivesse pedido: não partiu da pessoa → cartão
  const dois = await noTeams(b, 'e organiza o resto');
  h.db.run('UPDATE runs SET idempotency_key = ? WHERE id = ?', 'routine-teste-0001', dois.run);
  const espera = (await executar(dois.sessao, 'tarefa.criar', { titulo: 'Da rotina', quadro: 'Vendas' })).json;
  assert.equal(espera.status, 'aguardando_confirmacao');
  assert.equal(chamadas.length, 1, 'nada saiu ainda');
  await ate(() => rele.enviados.some((e) => e.card), 'o cartão não foi ao Teams');
  const env = rele.enviados.find((e) => e.card)!;
  const texto = env.card.body.filter((x: any) => x.type === 'TextBlock').map((x: any) => x.text).join('\n');
  assert.match(texto, /Asana · pela conta Ana/); assert.match(texto, /não partiu de você/);
  const aprovar = env.card.body.find((x: any) => x.type === 'ActionSet').actions[0];
  rele.clica(b, aprovar.data, env.activityId);
  await ate(() => chamadas.length === 2, 'a ação não saiu pelo clique no Teams');
  const prop = h.db.get<{ status: string; kind: string }>('SELECT status, kind FROM agent_proposals WHERE id = ?', aprovar.data.p)!;
  assert.equal(prop.kind, 'conexao'); assert.equal(prop.status, 'applied');
  assert.ok(h.db.get("SELECT 1 AS x FROM conexao_acoes WHERE workspace_id = ? AND status = 'feita' AND decisao = 'confirmar'", s.workspaceId), 'o mesmo registro da ação confirmada na tela');
  await ate(() => rele.atualizados.length === 1, 'o cartão não ficou com a linha final');
  // clicar de novo não repete
  rele.clica(b, aprovar.data, env.activityId);
  await ate(() => rele.atualizados.length === 2);
  assert.equal(chamadas.length, 2, 'o clique repetido não executa de novo');
});

test('apagar pedido pela própria pessoa no Teams: sempre cartão no Teams; com "Liberar tudo" (escolha dela no app), vai direto, igual ao app', async () => {
  h.integrations.secrets.write(s.workspaceId, 'slack', { token: ['xoxb', '1234', '5678', 'abcdefgh'].join('-') });
  setIntegration(h.db, s.workspaceId, 'slack', { state: 'connected', account_label: 'Acme', connected_at: new Date().toISOString() });
  const b = await ligar();
  const um = await noTeams(b, 'apaga aquela mensagem antiga do #geral');
  const espera = (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: um.sessao, conexao: 'slack', acao: 'slack.apagar', parametros: { canal: 'C012AB3CD', mensagem: '1503435956.000247' } }, { 'x-ergon-bridge-token': TOKEN })).json;
  assert.equal(espera.status, 'aguardando_confirmacao', 'apagar sempre pede cartão, mesmo pedido pela pessoa');
  assert.ok(!chamadas.some((c) => c.path === '/api/chat.delete'), 'nada apagado ainda');
  await ate(() => rele.enviados.some((e) => e.card), 'o cartão de apagar não foi ao Teams');
  const env = rele.enviados.find((e) => e.card)!;
  const recusar = env.card.body.find((x: any) => x.type === 'ActionSet').actions[1];
  assert.equal(recusar.data.d, 'reject');
  rele.clica(b, recusar.data, env.activityId);
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', recusar.data.p)?.status === 'rejected', 'Recusar no Teams não recusou');
  assert.ok(!chamadas.some((c) => c.path === '/api/chat.delete'), 'recusado: nada apagado');
  await terminar(um.run, 'Ok, não apaguei.');

  // "Liberar tudo" ligado no app (escolha consciente): a mesma regra vale pelo Teams, sem cartão
  assert.equal((await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: true })).status, 200);
  const dois = await noTeams(b, 'agora pode apagar');
  const direto = (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: dois.sessao, conexao: 'slack', acao: 'slack.apagar', parametros: { canal: 'C012AB3CD', mensagem: '1503435956.000247' } }, { 'x-ergon-bridge-token': TOKEN })).json;
  assert.equal(direto.status, 'feita', JSON.stringify(direto));
  assert.equal(chamadas.filter((c) => c.path === '/api/chat.delete').length, 1);
  assert.equal(rele.enviados.filter((e) => e.card).length, 1, 'nenhum cartão novo');
});
