/**
 * Execução de código vale pelo agente, não pelo motor: com Terminal e Executar código ligados no motor, o pedido da
 * pessoa a um agente que NÃO tem essas ferramentas lê e organiza direto; o agente que tem continua confirmando tudo.
 * E a proteção que justifica a regra fica: enquanto outro trabalho do mesmo motor é de um agente que roda programas, ou
 * depois que um programa rodou neste motor, a ação confirma (o programa poderia se passar pela sessão de outro).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-codigo-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_codigo${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  // como no motor da instalação real: Terminal e Executar código ligados para a equipe
  async toolsets() { return ['ergon_conexoes', 'todo', 'terminal', 'code_execution'].map((name) => ({ name, label: name, enabled: true, configured: true, tools: [] })); }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// API do Asana simulada (só o que as ações usadas aqui pedem)
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
let escritas = 0;
function asana(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  if ((init.method ?? 'GET') !== 'GET') escritas++;
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  if (path === '/tasks' && (init.method ?? 'GET') === 'GET') return Promise.resolve(json({ data: [{ gid: 't1', name: 'Revisar contrato', notes: '', completed: false, modified_at: 'v1', memberships: [{ project: { gid: 'p1' }, section: { gid: 's1' } }] }] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let semCodigo: string; let comCodigo: string;
beforeEach(async () => {
  escritas = 0;
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
  s = await setupOwner(h);
  const id = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
  semCodigo = id('aspasia');
  comCodigo = id('diogenes');
  h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'contas']), semCodigo);
  h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'contas', 'terminal', 'calculo']), comCodigo);
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
});
afterEach(() => h.close());

/** Mensagem da pessoa ao agente: a execução fica rodando no motor (a ponte reconhece a sessão). */
async function pedir(agente: string, texto: string): Promise<{ sessao: string; run: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  for (let i = 0; i < 3; i++) await h.executor.tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!;
  return { sessao: r.hermes_session_id, run: r.id };
}
const executar = async (sessao: string, acao: string, parametros: Record<string, unknown>) =>
  (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao: 'asana', acao, parametros }, { 'x-ergon-bridge-token': TOKEN })).json as { status: string; texto: string };

describe('regra de execução de código, por agente', () => {
  test('agente sem Terminal nem Executar código: ler e organizar vão direto, mesmo com eles ligados no motor', async () => {
    const { sessao } = await pedir(semCodigo, 'liste minhas tarefas do Asana e crie uma para revisar a proposta');
    assert.equal((await executar(sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'feita', 'ler vai direto');
    assert.equal((await executar(sessao, 'tarefa.criar', { titulo: 'Revisar a proposta', quadro: 'Vendas' })).status, 'feita', 'organizar vai direto');
    assert.equal(escritas, 1);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_proposals WHERE kind = 'conexao'")!.n, 0, 'nenhum cartão');
  });

  test('agente com Terminal e Executar código: continua confirmando tudo, inclusive ler', async () => {
    const { sessao } = await pedir(comCodigo, 'liste minhas tarefas do Asana');
    const r = await executar(sessao, 'tarefa.listar', { quadro: 'Vendas' });
    assert.equal(r.status, 'aguardando_confirmacao');
    const card = h.db.get<{ summary: string }>("SELECT summary FROM agent_proposals WHERE kind = 'conexao'")!;
    assert.match(card.summary, /execução de código/);
  });

  test('outro trabalho do mesmo motor com um agente que roda programas, ou programa que já rodou: confirma', async () => {
    const a = await pedir(semCodigo, 'liste minhas tarefas do Asana');
    const b = await pedir(comCodigo, 'calcule a planilha');
    assert.equal((await executar(a.sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'aguardando_confirmacao', 'o programa do colega poderia se passar por esta sessão');
    // o colega terminou sem rodar programa nenhum: volta a ir direto
    h.db.run("UPDATE runs SET status = 'succeeded' WHERE id = ?", b.run);
    assert.equal((await executar(a.sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'feita');
    // um programa rodou neste motor (pode ter ficado um processo em segundo plano): confirma até o motor reiniciar
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, preview, started_at) VALUES (?, ?, 0, 'terminal', NULL, ?)", s.workspaceId, b.run, new Date().toISOString());
    assert.equal((await executar(a.sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'aguardando_confirmacao');
  });

  test('a proteção depois de ler vem desligada, e a rede de segurança do Terminal continua de pé', async () => {
    const { sessao, run } = await pedir(comCodigo, 'leia as tarefas do Asana e rode o script');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'contas']), comCodigo);
    assert.equal((await executar(sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'feita');
    const pol = (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: sessao }, { 'x-ergon-bridge-token': TOKEN })).json as { bloqueadas: string[] };
    assert.deepEqual(pol.bloqueadas, [], 'depois de ler as contas, o Terminal não é barrado (proteção desligada por padrão)');
    // um programa rodou: as ações nas contas confirmam, mesmo sem a proteção depois de ler
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, preview, started_at) VALUES (?, ?, 0, 'terminal', NULL, ?)", s.workspaceId, run, new Date().toISOString());
    assert.equal((await executar(sessao, 'tarefa.listar', { quadro: 'Vendas' })).status, 'aguardando_confirmacao');
    assert.equal((await executar(sessao, 'tarefa.criar', { titulo: 'x', quadro: 'Vendas' })).status, 'aguardando_confirmacao');
    assert.equal(escritas, 0);
  });
});
