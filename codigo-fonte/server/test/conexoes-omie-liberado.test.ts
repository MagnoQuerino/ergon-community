/**
 * Omie: lançamento idêntico no mesmo dia fica liberado (decisão de 09/11). Cada inclusão de conta a receber leva um código
 * de integração novo, então a Omie não recusa a segunda venda igual. O que segue valendo é a proteção do sistema contra
 * repetir o MESMO envio numa nova tentativa: a conferência por trabalho (o mesmo pedido já feito não sai de novo).
 * Ponta a ponta pela ponte do motor, com o motor falso e a API da Omie simulada (sem rede).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
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

// ---------------------------------------------------------------- API da Omie simulada (recusa código repetido, como a de verdade)
const incluidas: string[] = [];
/** a próxima inclusão a Omie grava, mas a resposta se perde (o serviço caiu antes de responder) */
let perderResposta = false;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function omie(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.omie.com.br') return realFetch(input, init);
  const b = init.body ? JSON.parse(String(init.body)) : {};
  if (b.call === 'IncluirContaReceber') {
    const cod = String(b.param?.[0]?.codigo_lancamento_integracao);
    if (incluidas.includes(cod)) return Promise.resolve(json({ faultstring: `ERROR: Lançamento já cadastrado para o Código de Integração [${cod}] !`, faultcode: 'SOAP-ENV:Client-102' }, 500));
    incluidas.push(cod);
    if (perderResposta) { perderResposta = false; return Promise.resolve(json({ faultstring: 'Serviço temporariamente indisponível' }, 503)); }
    return Promise.resolve(json({ codigo_lancamento_omie: incluidas.length, codigo_status: '0', descricao_status: 'Lançamento cadastrado com sucesso!' }));
  }
  return Promise.resolve(json({ empresas_cadastro: [{ razao_social: 'Loja Teste' }] }));
}
before(() => { globalThis.fetch = omie as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
beforeEach(() => { incluidas.length = 0; perderResposta = false; });

let h: Harness; let s: Session; let agente: string; const motor = new Motor();
const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': TOKEN }));
async function conversar(texto: string, convId?: string): Promise<string> {
  const conv = convId ? { id: convId } : (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  ultimaConversa = conv.id;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  for (let i = 0; i < 3; i++) await h.executor.tick();
  return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
}
let ultimaConversa = '';
/** a execução da sessão termina (a conversa fica livre para a próxima mensagem da pessoa) */
async function terminar(sessao: string) {
  const r = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE hermes_session_id = ?', sessao)!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output: 'Não deu: a Omie não confirmou. Confira lá.', error: null, sessionId: sessao, usage: null, model: 'nous/teste-1' });
  for (let i = 0; i < 3; i++) await h.executor.tick();
}
const incluir = (sessao: string) => ponte({ op: 'executar', session_id: sessao, conexao: 'omie', acao: 'omie.incluir_conta_receber',
  parametros: { cliente: 2485780, valor: 150.5, vencimento: '10/12/2026', categoria: '1.01.02', conta_corrente: 427619 } });

describe('Omie: lançamento idêntico no mesmo dia', () => {
  before(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.integrations.secrets.write(s.workspaceId, 'omie', { app_key: '9999999999', app_secret: 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5' });
    setIntegration(h.db, s.workspaceId, 'omie', { state: 'connected', account_label: 'Loja Teste', connected_at: new Date().toISOString() });
  });
  after(async () => { await h.close(); });

  test('dois pedidos da pessoa, em conversas diferentes, com os mesmos dados no mesmo dia: os dois são lançados', async () => {
    const r1 = await incluir(await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12'));
    const r2 = await incluir(await conversar('Lance outra venda igual: R$ 150,50 para a Loja Teste, vencendo em 10/12'));
    assert.equal(r1.json.status, 'feita', JSON.stringify(r1.json));
    assert.equal(r2.json.status, 'feita', JSON.stringify(r2.json));
    assert.equal(incluidas.length, 2, 'a Omie lançou as duas');
    assert.notEqual(incluidas[0], incluidas[1]);
  });

  // a nova tentativa da equipe num card está em equipe-tenta-de-novo.test.ts (Omie: a conta a receber já lançada no card)
  test('a mesma inclusão repetida na mesma execução (o agente insistindo) segue barrada pelo sistema, antes da Omie', async () => {
    const sessao = await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12');
    assert.equal((await incluir(sessao)).json.status, 'feita');
    const de_novo = (await incluir(sessao)).json;
    assert.equal(de_novo.status, 'feita');
    assert.match(de_novo.texto, /^Já feita neste trabalho \(o serviço registrou\), não repeti/);
    assert.equal(incluidas.length, 1, 'nada saiu duas vezes');
  });

  test('na mesma conversa, a pessoa pede outra venda igual numa mensagem nova: sai a segunda; o mesmo pedido sem dizer que é outra, e o agente insistindo, não', async () => {
    const sessao = await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12');
    assert.equal((await incluir(sessao)).json.status, 'feita');
    await terminar(sessao);
    const conv = ultimaConversa;
    // a mesma frase de novo (ela pode estar só repetindo o pedido): não sai, e o agente fica sabendo como lançar outra
    const s2 = await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12', conv);
    const r2 = (await incluir(s2)).json;
    assert.equal(r2.status, 'feita');
    assert.match(r2.texto, /^Já feita neste trabalho \(o serviço registrou\), não repeti/);
    assert.match(r2.texto, /Se a pessoa quer outra igual de propósito, ela pede de novo dizendo que é outra/);
    assert.equal(incluidas.length, 1);
    await terminar(s2);
    // outra venda igual, dita na mensagem nova: é pedido novo, sai (com outro código)
    const s3 = await conversar('Vendi outra igual agora: lance outra venda de R$ 150,50 para a Loja Teste, vencendo em 10/12', conv);
    const r3 = (await incluir(s3)).json;
    assert.equal(r3.status, 'feita', JSON.stringify(r3));
    assert.doesNotMatch(r3.texto, /^Já feita/);
    assert.equal(incluidas.length, 2, 'a Omie lançou as duas');
    assert.notEqual(incluidas[0], incluidas[1]);
    // o agente insiste na mesma execução: vale uma vez por mensagem da pessoa
    assert.match((await incluir(s3)).json.texto, /^Já feita neste trabalho/);
    assert.equal(incluidas.length, 2);
    await terminar(s3);
    // "de novo" também vale
    const s4 = await conversar('Lança de novo essa mesma venda, por favor', conv);
    assert.equal((await incluir(s4)).json.status, 'feita');
    assert.equal(incluidas.length, 3);
  });

  test('a resposta da Omie se perdeu (pode ter lançado): a mesma inclusão não sai de novo sozinha; o pedido novo da pessoa, dizendo que é de novo, sai', async () => {
    const sessao = await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12');
    perderResposta = true;
    const r1 = (await incluir(sessao)).json;
    assert.equal(r1.status, 'falhou', JSON.stringify(r1));
    assert.match(r1.texto, /pode ter feito ou não/);
    assert.equal(incluidas.length, 1, 'a Omie gravou, mas a resposta não chegou');
    // o agente insiste, na mesma execução: o sistema segura, antes da Omie
    const r2 = (await incluir(sessao)).json;
    assert.equal(r2.status, 'falhou');
    assert.match(r2.texto, /^Não repeti: esta mesma ação, pedida há pouco, ficou sem a confirmação do serviço/);
    assert.equal(incluidas.length, 1, 'nada saiu duas vezes');
    // a pessoa manda o mesmo pedido de novo, sem dizer que é de novo: também segura
    await terminar(sessao);
    const conv = ultimaConversa;
    const s2 = await conversar('Lance a venda de R$ 150,50 para a Loja Teste, vencendo em 10/12', conv);
    assert.notEqual(s2, sessao);
    assert.match((await incluir(s2)).json.texto, /^Não repeti/);
    assert.equal(incluidas.length, 1);
    // ela conferiu na Omie e pede de novo: é decisão dela, sai (com um código novo)
    await terminar(s2);
    const s3 = await conversar('Conferi na Omie e não está lá: lance de novo, por favor', conv);
    const r3 = (await incluir(s3)).json;
    assert.equal(r3.status, 'feita', JSON.stringify(r3));
    assert.equal(incluidas.length, 2);
  });
});
