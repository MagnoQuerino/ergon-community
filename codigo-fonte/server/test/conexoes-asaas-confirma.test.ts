/**
 * Asaas: criar cobrança SEMPRE pede a confirmação da pessoa (decisão de 09/11), mesmo quando ela mesma pediu na conversa,
 * porque o Asaas avisa o cliente na hora. Nem "Liberar tudo" passa por cima (diferente de apagar). As outras
 * escritas do Asaas seguem a regra comum (cadastrar cliente vai direto quando a pessoa pede).
 * Ponta a ponta pela ponte do motor, com o motor falso e a API do Asaas simulada (sem rede).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { decidir } from '../src/services/conexoes/regra.ts';
import { ASAAS } from '../src/services/conexoes/conectores/asaas.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
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

// ---------------------------------------------------------------- API do Asaas simulada
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function asaas(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (!url.host.endsWith('asaas.com')) return realFetch(input, init);
  const path = url.pathname.replace('/v3', '');
  const method = init.method ?? 'GET';
  calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
  if (path === '/customers/cus_1') return Promise.resolve(json({ id: 'cus_1', name: 'Padaria Boa Vista' }));
  if (path === '/payments' && method === 'GET') return Promise.resolve(json({ data: [] }));
  if (path === '/customers' && method === 'GET') return Promise.resolve(json({ data: [] }));
  if (path === '/payments') return Promise.resolve(json({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://www.asaas.com/i/pay_1' }));
  if (path === '/customers') return Promise.resolve(json({ id: 'cus_2' }));
  return Promise.resolve(json({}));
}
before(() => { globalThis.fetch = asaas as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
beforeEach(() => { calls.length = 0; });

let h: Harness; let s: Session; let agente: string;
const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': TOKEN }));
async function conversar(texto: string): Promise<string> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  for (let i = 0; i < 3; i++) await h.executor.tick();
  return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>) => ponte({ op: 'executar', session_id: sessao, conexao: 'asaas', acao, parametros });
const COBRANCA = { cliente: 'cus_1', valor: 129.9, vencimento: '2026-11-30', descricao: 'Mensalidade de novembro' };
const criou = () => calls.some((c) => c.method === 'POST' && c.path === '/payments');

describe('Asaas: criar cobrança sempre pede confirmação', () => {
  before(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.integrations.secrets.write(s.workspaceId, 'asaas', { access_token: '$aact_prod_000000000000000000000000000000000000' });
    setIntegration(h.db, s.workspaceId, 'asaas', { state: 'connected', account_label: 'Conta Asaas', connected_at: new Date().toISOString() });
  });
  after(async () => { await h.close(); });
  afterEach(() => { h.conexoes.setLiberarTudo(s.workspaceId, s.userId, false); });

  test('a regra: a ação que se declara "sempre confirma" pede confirmação mesmo pedida pela pessoa e mesmo com "Liberar tudo"', () => {
    const base = { risco: 'enviar' as const, origem: 'pessoa' as const, leuDeFora: false, liberarTudo: false };
    assert.equal(decidir(base), 'direto', 'sem a marca, envio pedido pela pessoa vai direto');
    assert.equal(decidir({ ...base, sempreConfirma: true }), 'confirmar');
    assert.equal(decidir({ ...base, sempreConfirma: true, liberarTudo: true }), 'confirmar');
    assert.equal(decidir({ ...base, sempreConfirma: true, liberarTudo: true, origem: 'fora' }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'apagar', liberarTudo: true }), 'direto', 'apagar segue liberado por "Liberar tudo"');
    assert.equal(decidir({ ...base, sempreConfirma: true, ajuste: 'desligado' }), 'recusar');
    const marcadas = ASAAS.acoes.filter((a) => a.sempreConfirma).map((a) => a.id);
    assert.deepEqual(marcadas, ['asaas.criar_cobranca'], 'só criar cobrança (o cliente é avisado na hora)');
    assert.match(ASAAS.acoes.find((a) => a.id === 'asaas.criar_cobranca')!.rotulo!, /sempre pede a sua confirmação/);
  });

  test('a pessoa pediu na conversa: o cartão espera o clique, com o motivo; nada é criado antes', async () => {
    const sessao = await conversar('Crie a cobrança de R$ 129,90 da Padaria Boa Vista para 30/11');
    const r = await executar(sessao, 'asaas.criar_cobranca', COBRANCA);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, 'aguardando_confirmacao', JSON.stringify(r.json));
    assert.equal(criou(), false, 'nada saiu para o Asaas');
    const cartao = h.db.get<{ id: string; summary: string }>("SELECT id, summary FROM agent_proposals WHERE kind = 'conexao' ORDER BY created_at DESC LIMIT 1")!;
    assert.match(cartao.summary, /o Asaas avisa o cliente na hora/);
    assert.match(cartao.summary, /Padaria Boa Vista/);
    // o clique da pessoa cria
    const d = await req(h, 'POST', `/api/proposals/${cartao.id}`, s, { decision: 'apply' });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(criou(), true, 'depois do clique, a cobrança é criada');
  });

  test('com "Liberar tudo" ligado, criar cobrança também espera o cartão (o cliente é avisado na hora)', async () => {
    h.conexoes.setLiberarTudo(s.workspaceId, s.userId, true);
    const sessao = await conversar('Crie a cobrança de R$ 50 da Padaria Boa Vista para 01/12');
    const r = await executar(sessao, 'asaas.criar_cobranca', { ...COBRANCA, valor: 50, vencimento: '2026-12-01' });
    assert.equal(r.json.status, 'aguardando_confirmacao', JSON.stringify(r.json));
    assert.equal(criou(), false, 'nada saiu para o Asaas antes do clique');
    const cartao = h.db.get<{ summary: string }>("SELECT summary FROM agent_proposals WHERE kind = 'conexao' ORDER BY created_at DESC LIMIT 1")!;
    assert.match(cartao.summary, /o Asaas avisa o cliente na hora/);
  });

  test('as outras escritas do Asaas seguem a regra comum: cadastrar cliente pedido pela pessoa vai direto', async () => {
    const sessao = await conversar('Cadastre a Padaria Boa Vista no Asaas, CNPJ 11.222.333/0001-81');
    const r = await executar(sessao, 'asaas.criar_cliente', { nome: 'Padaria Boa Vista', cpf_cnpj: '11.222.333/0001-81' });
    assert.equal(r.json.status, 'feita', JSON.stringify(r.json));
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/customers'));
  });
});
