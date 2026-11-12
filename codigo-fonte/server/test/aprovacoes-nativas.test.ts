/**
 * Aprovações nativas (rc.27, services/aprovacoes.ts). Com um motor falso que segue o contrato provado no Hermes de verdade
 * (hermes/tests/test_ergon_bridge_rotinas.py): approval.request no fluxo de eventos, resposta por POST /v1/runs/{id}/approval.
 * - um comando de risco do Terminal vira o cartão "comando para aprovar" na conversa (e em "Aguardando você"); a decisão da
 *   tela vai ao motor no mesmo turno (once / deny), sem continuação;
 * - depois do prazo do motor, o cartão continua com a pessoa: aprovado, o agente recebe a continuação e o mesmo comando sai
 *   aprovado no pedido seguinte da conversa, sem outro cartão;
 * - o tempo esperando a pessoa no portão não conta no limite da execução;
 * - o cartão do Ergon que segurou o turno (ação numa conta, aprovação depois de ler as contas): a decisão de sempre (a mesma
 *   função da tela e dos canais) vai ao motor e a ferramenta recebe o resultado que está no Ergon, sem continuação; depois
 *   do prazo, segue a continuação de antes;
 * - num card da equipe, o comando esperando aprovação deixa o card "Com você".
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, RunEvent, StartRun } from '../src/services/hermes.ts';
import { PRAZO_DO_MOTOR_MS } from '../src/services/aprovacoes.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-aprova-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  ouvintes = new Map<string, (e: RunEvent) => void>();
  respostas: Array<{ runId: string; choice: string; requestId: string | null }> = [];
  /** quantos pedidos o motor resolve na resposta (0 = já não esperava) */
  resolve = 1;
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_aprova${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async events(id: string, on: (e: RunEvent) => void, signal: AbortSignal) {
    this.ouvintes.set(id, on);
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
  async approve(runId: string, choice: string, requestId: string | null) { this.respostas.push({ runId, choice, requestId }); return this.resolve; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// a API do Asana simulada: uma ação numa conta que pede confirmação
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
  if (path === '/tasks' && (init.method ?? 'GET') === 'GET') return Promise.resolve(json({ data: [] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const espera = () => new Promise((r) => setImmediate(r));
beforeEach(async () => {
  escritas = 0;
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
});
afterEach(() => { h.aprovacoes.setClock(null); return h.close(); });

const ponte = (rota: string, corpo: Record<string, unknown>) => req(h, 'POST', `/internal/bridge/v1/${rota}`, null, corpo, { 'x-ergon-bridge-token': TOKEN });
async function conversar(texto: string, conv?: string): Promise<{ sessao: string; conv: string; run: string; remoto: string }> {
  const c = conv ?? (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id;
  await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string; hermes_run_id: string }>('SELECT id, hermes_session_id, hermes_run_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c)!;
  return { sessao: r.hermes_session_id, conv: c, run: r.id, remoto: r.hermes_run_id };
}
async function pedir(remoto: string, e: Partial<RunEvent>): Promise<void> {
  motor.ouvintes.get(remoto)!({ event: 'approval.request', choices: ['once', 'session', 'always', 'deny'], ...e } as RunEvent);
  for (let i = 0; i < 5; i++) await espera();
}
const cartoes = (kind = 'aprovacao') => h.db.all<{ id: string; status: string; summary: string; conversation_id: string | null; run_id: string | null }>(
  'SELECT id, status, summary, conversation_id, run_id FROM agent_proposals WHERE kind = ? ORDER BY created_at, rowid', kind);
const runsDa = (conv: string) => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?', conv)!.n;
const decidir = (id: string, decision: 'apply' | 'reject', extra: Record<string, unknown> = {}) => req(h, 'POST', `/api/proposals/${id}`, s, { decision, ...extra });

describe('aprovações nativas: comando de risco do Terminal', () => {
  test('o pedido do motor vira o cartão; aprovar na tela responde ao motor no mesmo turno (once), sem continuação', async () => {
    const c = await conversar('apague a pasta temporária');
    await pedir(c.remoto, { requestId: 'req-1', command: 'rm -rf /tmp/pasta', description: 'delete in root path', patternKey: 'delete in root path' });
    const [k] = cartoes();
    assert.ok(k && k.status === 'proposed' && k.conversation_id === c.conv && k.run_id === c.run, 'o cartão está na conversa, da execução');
    assert.match(k.summary, /rm -rf \/tmp\/pasta/, 'o cartão mostra o comando inteiro');
    const dec = (await req(h, 'GET', '/api/decisions', s)).json;
    assert.ok(dec.proposals.some((p: { id: string; agent_name: string | null }) => p.id === k.id && p.agent_name), '"Aguardando você" mostra, com quem pediu');
    // o motor fica "esperando aprovação": a execução espera a pessoa, e "Aguardando você" mostra só o cartão (sem item repetido)
    motor.runs.set(c.remoto, { status: 'waiting_for_approval', output: null, error: null, sessionId: `sessao-${c.remoto}`, usage: null, model: null });
    await tick();
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', c.run)!.status, 'waiting_user');
    assert.equal((await req(h, 'GET', '/api/decisions', s)).json.waiting.length, 0, 'o cartão basta');
    motor.runs.set(c.remoto, { status: 'running', output: null, error: null, sessionId: `sessao-${c.remoto}`, usage: null, model: null });
    await tick();
    await pedir(c.remoto, { requestId: 'req-1', command: 'rm -rf /tmp/pasta', patternKey: 'delete in root path' });
    assert.equal(cartoes().length, 1, 'o mesmo pedido repetido (o fluxo recomeça depois de um reinício): nada novo');
    const antes = runsDa(c.conv);
    const r = await decidir(k.id, 'apply');
    assert.equal(r.status, 200); assert.equal(r.json.status, 'applied');
    assert.deepEqual(motor.respostas, [{ runId: c.remoto, choice: 'once', requestId: 'req-1' }], 'a resposta vai ao motor, para o pedido certo');
    assert.equal(runsDa(c.conv), antes, 'o agente segue no mesmo turno: nenhuma continuação');
    assert.equal((await decidir(k.id, 'apply')).status, 409, 'decidido não decide de novo');
  });

  test('recusar no mesmo turno: deny', async () => {
    const c = await conversar('apague a pasta temporária');
    await pedir(c.remoto, { requestId: 'req-2', command: 'rm -rf /tmp/outra' });
    assert.equal((await decidir(cartoes()[0].id, 'reject')).json.status, 'rejected');
    assert.deepEqual(motor.respostas.map((x) => x.choice), ['deny']);
  });

  test('depois do prazo do motor: o cartão continua com a pessoa; aprovado, o agente continua e o mesmo comando sai aprovado sem outro cartão', async () => {
    const c = await conversar('rode a limpeza');
    const t0 = Date.now();
    await pedir(c.remoto, { requestId: 'req-3', command: 'rm -rf /tmp/limpeza' });
    h.aprovacoes.setClock(() => t0 + 2 * 60_000);
    assert.ok(h.executor.esperaHumana(c.run) >= 2 * 60_000 - 1000, 'o tempo parado esperando a pessoa não conta no limite da execução');
    // o motor desistiu (prazo de 5 min) e a execução terminou dizendo que espera
    h.aprovacoes.setClock(() => t0 + PRAZO_DO_MOTOR_MS + 60_000);
    motor.runs.set(c.remoto, { status: 'completed', output: 'Pedi a sua aprovação para o comando; aguardo.', error: null, sessionId: `sessao-${c.remoto}`, usage: null, model: null });
    await tick();
    const [k] = cartoes();
    assert.equal(k.status, 'proposed', 'o cartão continua com a pessoa (espera quanto for preciso)');
    const antes = runsDa(c.conv);
    assert.equal((await decidir(k.id, 'apply')).json.status, 'applied');
    assert.equal(motor.respostas.length, 0, 'o motor já não esperava: nada vai a ele');
    assert.equal(runsDa(c.conv), antes + 1, 'o agente recebe a continuação na conversa');
    const cont = h.db.get<{ input: string }>('SELECT input FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.conv)!;
    assert.match(cont.input, /Aprovei o comando[\s\S]*rm -rf \/tmp\/limpeza/);
    await tick();
    const nova = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.conv)!.hermes_run_id;
    await pedir(nova, { requestId: 'req-4', command: 'rm -rf /tmp/limpeza' });
    assert.deepEqual(motor.respostas, [{ runId: nova, choice: 'once', requestId: 'req-4' }], 'o mesmo comando, na mesma conversa: aprovado sem outro cartão');
    assert.equal(cartoes().length, 1);
    await pedir(nova, { requestId: 'req-5', command: 'rm -rf /' });
    assert.equal(cartoes().length, 2, 'outro comando: outro cartão');
  });

  test('num card da equipe: o comando esperando aprovação deixa o card "Com você"', async () => {
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Limpar a pasta de relatórios', agentId: agente })).json;
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
    await tick();
    const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', t.id)!;
    await pedir(r.hermes_run_id, { requestId: 'req-6', command: 'rm -rf /srv/relatorios' });
    assert.equal((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.conexoes.filter((c: { kind: string }) => c.kind === 'aprovacao').length, 1, 'o card mostra o cartão');
    h.aprovacoes.setClock(() => Date.now() + PRAZO_DO_MOTOR_MS + 60_000);
    motor.runs.set(r.hermes_run_id, { status: 'completed', output: 'Pedi a aprovação do comando; quando a pessoa decidir, sigo.', error: null, sessionId: 's', usage: null, model: null });
    await tick();
    assert.equal(h.db.get<{ work_state: string }>('SELECT work_state FROM tasks WHERE id = ?', t.id)!.work_state, 'aguardando_aprovacao', 'o card espera com você');
  });
});

describe('aprovações nativas: o cartão do Ergon que segurou o turno', () => {
  test('ação numa conta: a decisão da tela executa, responde ao motor e a ferramenta recebe o resultado que está no Ergon', async () => {
    const c = await conversar('crie a tarefa no Asana');
    h.db.run('UPDATE runs SET idempotency_key = ? WHERE id = ?', `routine-${crypto.randomUUID()}`, c.run); // não partiu da pessoa: pede confirmação
    const r = (await ponte('conexoes', { op: 'executar', session_id: c.sessao, conexao: 'asana', acao: 'tarefa.criar', parametros: { titulo: 'Ligar para a Ana', quadro: 'Vendas' } })).json;
    assert.equal(r.status, 'aguardando_confirmacao');
    const [k] = cartoes('conexao');
    assert.equal(r.cartao, k.id, 'o plugin recebe o cartão para segurar o turno');
    assert.match(r.resumo, /Asana/);
    assert.equal(escritas, 0, 'nada feito antes do clique');
    await pedir(c.remoto, { requestId: 'req-c1', patternKey: `plugin_rule:ergon_${k.id}`, command: '<conexoes_executar> (plugin approval rule)' });
    assert.equal(cartoes().length, 0, 'não abre outro cartão: é o mesmo da conexão');
    const antes = runsDa(c.conv);
    assert.equal((await decidir(k.id, 'apply')).json.status, 'applied');
    assert.equal(escritas, 1, 'o clique executou o que o cartão mostrou');
    assert.deepEqual(motor.respostas, [{ runId: c.remoto, choice: 'once', requestId: 'req-c1' }], 'o motor segurava o turno: recebe a resposta');
    assert.equal(runsDa(c.conv), antes, 'sem continuação: o resultado volta à ferramenta no mesmo turno');
    const depois = (await ponte('conexoes', { op: 'cartao', session_id: c.sessao, cartao: k.id })).json;
    assert.equal(depois.status, 'feita'); assert.match(depois.texto, /confirmou e foi feito/);
    // outro trabalho não lê o cartão deste
    const outra = await conversar('outra coisa');
    assert.equal((await ponte('conexoes', { op: 'cartao', session_id: outra.sessao, cartao: k.id })).json.status, 'falhou');
  });

  test('ação numa conta recusada no mesmo turno: deny, e a ferramenta recebe a recusa', async () => {
    const c = await conversar('crie a tarefa no Asana');
    h.db.run('UPDATE runs SET idempotency_key = ? WHERE id = ?', `routine-${crypto.randomUUID()}`, c.run);
    await ponte('conexoes', { op: 'executar', session_id: c.sessao, conexao: 'asana', acao: 'tarefa.criar', parametros: { titulo: 'Mandar proposta', quadro: 'Vendas' } });
    const [k] = cartoes('conexao');
    await pedir(c.remoto, { requestId: 'req-c2', patternKey: `plugin_rule:ergon_${k.id}` });
    assert.equal((await decidir(k.id, 'reject')).json.status, 'rejected');
    assert.deepEqual(motor.respostas.map((x) => x.choice), ['deny']);
    assert.match((await ponte('conexoes', { op: 'cartao', session_id: c.sessao, cartao: k.id })).json.texto, /recusou/);
    assert.equal(escritas, 0);
  });

  test('o motor parou de esperar no mesmo instante (resolved 0): a continuação de antes segue', async () => {
    const c = await conversar('crie a tarefa no Asana');
    h.db.run('UPDATE runs SET idempotency_key = ? WHERE id = ?', `routine-${crypto.randomUUID()}`, c.run);
    await ponte('conexoes', { op: 'executar', session_id: c.sessao, conexao: 'asana', acao: 'tarefa.criar', parametros: { titulo: 'Revisar orçamento', quadro: 'Vendas' } });
    const [k] = cartoes('conexao');
    await pedir(c.remoto, { requestId: 'req-c3', patternKey: `plugin_rule:ergon_${k.id}` });
    motor.resolve = 0;
    const antes = runsDa(c.conv);
    assert.equal((await decidir(k.id, 'apply')).json.status, 'applied');
    assert.equal(runsDa(c.conv), antes + 1, 'o agente recebe o resultado como continuação, como antes');
  });

  test('aprovação depois de ler as contas: a escolha da tela (prazo) vale e vai ao motor no mesmo turno; depois do prazo, a continuação de antes', async () => {
    const c = await conversar('abra o site do contrato');
    const cartao = (conv: string, run: string) => {
      recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: run }, [{ kind: 'depois_de_ler', agente: 'Hipátia', grupo: 'sites', escopo: `conv:${conv}`,
        chaves: ['site:https://site.exemplo'], ferramenta: 'web_extract', alvo: 'https://site.exemplo', resumo: 'Hipátia quer abrir um site' }]);
      return cartoes('depois_de_ler').at(-1)!.id;
    };
    const k = cartao(c.conv, c.run);
    await pedir(c.remoto, { requestId: 'req-l1', patternKey: `plugin_rule:ergon_${k}` });
    const antes = runsDa(c.conv);
    assert.equal((await decidir(k, 'apply', { prazo: '8h' })).json.status, 'applied');
    assert.deepEqual(motor.respostas, [{ runId: c.remoto, choice: 'once', requestId: 'req-l1' }]);
    assert.equal(runsDa(c.conv), antes, 'sem continuação: a ferramenta segue no mesmo turno');
    // outro cartão, e o motor desistiu antes do clique: a continuação de antes
    const d = await conversar('abra outro site');
    const k2 = cartao(d.conv, d.run);
    await pedir(d.remoto, { requestId: 'req-l2', patternKey: `plugin_rule:ergon_${k2}` });
    h.aprovacoes.setClock(() => Date.now() + PRAZO_DO_MOTOR_MS + 60_000);
    const antes2 = runsDa(d.conv);
    assert.equal((await decidir(k2, 'reject')).json.status, 'rejected');
    assert.equal(motor.respostas.length, 1, 'nada ao motor, que já não esperava');
    assert.equal(runsDa(d.conv), antes2 + 1, 'o agente recebe a decisão como continuação');
  });

  test('cartão já decidido quando o motor pede (uma regra, ou a pessoa rápida): responde na hora', async () => {
    const c = await conversar('abra o site');
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: c.conv, runId: c.run }, [{ kind: 'depois_de_ler', agente: 'Hipátia', grupo: 'sites', escopo: `conv:${c.conv}`,
      chaves: ['site:https://x.exemplo'], ferramenta: 'web_extract', alvo: 'https://x.exemplo', resumo: 'abrir um site' }]);
    const k = cartoes('depois_de_ler')[0].id;
    h.db.run("UPDATE agent_proposals SET status = 'rejected' WHERE id = ?", k);
    await pedir(c.remoto, { requestId: 'req-l3', patternKey: `plugin_rule:ergon_${k}` });
    assert.deepEqual(motor.respostas.map((x) => x.choice), ['deny']);
  });
});
