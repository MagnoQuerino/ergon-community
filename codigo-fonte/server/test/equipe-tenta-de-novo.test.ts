/**
 * A equipe tenta de novo (decisão 19, 08/11/2026): quando a conferência de entrega mostra que faltou fazer na conta — o
 * agente não usou a conexão, o pedido não chegou ao serviço, o serviço recusou por um parâmetro, fez só uma parte —, o card
 * volta para a equipe (rodadas 1–2 a coordenação, 3–4 o reforço) com o que faltou dito com clareza, e a conferência confere
 * de novo. Só vai para a pessoa o que só ela resolve (autorizar a conta, uma ação que ela desligou, um envio que o serviço
 * não confirmou) ou quando as rodadas acabam. O que já saiu pela conta no trabalho atual não sai de novo.
 * O aplicativo de teste é o Asana, com a API simulada; a Microsoft fica só "conectada" (nenhuma chamada sai para ela).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { ESCOPOS_MICROSOFT } from '../src/services/conexoes/acoes/microsoft.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setSetting } from '../src/services/sectors.ts';
import { PERSIST_ROUNDS } from '../src/services/teamwork.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_denovo${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// ---------------------------------------------------------------------------------------- API do Asana simulada
/** o que a próxima escrita no Asana responde: ok, 403 (sem permissão), 422 (parâmetro recusado), sem confirmação ou um 5xx */
let asana: 'ok' | 'nega' | 'parametro' | 'sem_confirmar' | 502 | 503 | 504 = 'ok';
let escritas = 0;
/** os e-mails que a Microsoft simulada aceitou (para quem), e a resposta do próximo envio: ok, sem resposta (a conexão caiu) */
let enviados: string[] = [];
let graph: 'ok' | 'caiu_uma' = 'ok';
let omieLancadas = 0;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host === 'graph.microsoft.com' && url.pathname === '/v1.0/me/sendMail' && init.method === 'POST') {
    escritas++;
    const para = (JSON.parse(String(init.body)) as { message: { toRecipients: Array<{ emailAddress: { address: string } }> } }).message.toRecipients.map((r) => r.emailAddress.address).join(',');
    // a conexão caiu depois de mandar o pedido: o serviço pode ter enviado ou não
    if (graph === 'caiu_uma') { graph = 'ok'; return Promise.reject(new Error('a conexão caiu (teste)')); }
    enviados.push(para);
    return Promise.resolve(new Response(null, { status: 202 }));
  }
  // Omie: cada conta a receber que chega é lançada (o código de integração é novo a cada inclusão, decisão de 09/11)
  if (url.host === 'app.omie.com.br') {
    const b = init.body ? JSON.parse(String(init.body)) as { call?: string } : {};
    if (b.call === 'IncluirContaReceber') { omieLancadas++; return Promise.resolve(json({ codigo_lancamento_omie: omieLancadas, codigo_status: '0', descricao_status: 'Lançamento cadastrado com sucesso!' })); }
    return Promise.resolve(json({ empresas_cadastro: [{ razao_social: 'Loja Teste' }] }));
  }
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  if (method !== 'GET') {
    escritas++;
    if (asana === 'nega') return Promise.resolve(json({ errors: [{ message: 'not authorized' }] }, 403));
    if (asana === 'parametro') { asana = 'ok'; return Promise.resolve(json({ errors: [{ message: 'projects: Not a recognized ID' }] }, 422)); }
    if (asana === 'sem_confirmar') return Promise.resolve(json({ data: {} }));
    if (typeof asana === 'number') return Promise.resolve(json({ errors: [{ message: 'gateway' }] }, asana));
  }
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  if (path === '/tasks' && method === 'GET') return Promise.resolve(json({ data: [{ gid: 't9', name: 'Enviar NF', notes: '', completed: false, modified_at: 'v1', memberships: [{ section: { gid: 's1' }, project: { gid: 'p1' } }] }] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
interface Exec { id: string; idempotency_key: string; input: string; hermes_session_id: string | null; agent_id: string }
/** A execução que o motor está rodando agora (a próxima a responder). */
const rodando = () => h.db.get<Exec>("SELECT id, idempotency_key, input, hermes_session_id, agent_id FROM runs WHERE status = 'running' AND hermes_run_id IS NOT NULL ORDER BY created_at, rowid LIMIT 1");
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
/** Responde cada execução, na ordem, até não sobrar nenhuma. A resposta pode usar a conexão antes (executar). */
async function conduzir(responder: (r: Exec) => Promise<string> | string, max = 40): Promise<Exec[]> {
  const vistas: Exec[] = [];
  for (let i = 0; i < max; i++) {
    await tick();
    const r = rodando();
    if (!r) { if (!h.db.get("SELECT 1 AS x FROM runs WHERE status IN ('queued', 'running')")) return vistas; continue; }
    vistas.push(r);
    await terminar(r.id, await responder(r));
  }
  throw new Error('as execuções não terminaram');
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>, conexao = 'asana') =>
  req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao, acao, parametros }, { 'x-ergon-bridge-token': TOKEN });
const resultado = (taskId: string) => h.db.get<{ state: string; justification: string; evidence: string }>(
  'SELECT state, justification, evidence FROM task_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId)!;
const rodadas = (taskId: string) => h.db.all<{ evidence: string; result: string }>("SELECT evidence, result FROM audit_events WHERE target_id = ? AND action = 'task.persist' ORDER BY created_at, rowid", taskId)
  .map((a) => ({ ...JSON.parse(a.evidence) as { kind: string; by: string; motivo: string; refazer?: string }, result: a.result }));
const triagem = (r: Exec) => r.idempotency_key.startsWith('triagem-');
const cartoes = (conv: string) => h.db.all<{ payload: string }>("SELECT payload FROM agent_proposals WHERE conversation_id = ? AND kind = 'info_request' AND status = 'proposed'", conv)
  .map((p) => JSON.parse(p.payload) as { need: string });

async function preparar(): Promise<void> {
  asana = 'ok'; escritas = 0; enviados = []; graph = 'ok'; omieLancadas = 0;
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0 ORDER BY created_at LIMIT 1", s.workspaceId)!.id;
  const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[];
  if (!tools.includes('contas')) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, 'contas']), agente);
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date(Date.now() - 3600_000).toISOString() });
  setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
}
/** Um card da equipe ligado a uma conversa, posto para trabalhar. fora: veio de uma mensagem recebida (as ações pedem confirmação). */
async function card(titulo: string, fora = false): Promise<{ task: string; conv: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, t.id);
  if (fora) h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  return { task: t.id, conv };
}
const INSTRUCAO = 'Faça agora pela conexão do Asana o que o pedido pede e confira o resultado do serviço.';

describe('a equipe tenta de novo o que faltou fazer na conta', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('não usou a conexão → nova rodada com a instrução da conferência; a segunda tentativa faz e o card conclui sem a pessoa', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    let tentativa = 0;
    const vistas = await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) return 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.';
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'feita');
      return 'Criei a tarefa no Asana.';
    });
    const p = rodadas(c.task);
    assert.equal(p.length, 1, 'uma rodada da equipe');
    assert.equal(p[0].kind, 'conexao');
    assert.match(p[0].refazer!, /A conferência de entrega mostra que criar as tarefas não foi feito: ninguém chamou a conexão com Asana/);
    assert.match(p[0].refazer!, /conexoes_executar \(conexao="asana" acao="tarefa\.criar"\)/);
    const decisao = vistas.find(triagem)!;
    assert.match(decisao.input, /O que a conferência de entrega mostra e o que fazer agora: A conferência de entrega mostra que criar as tarefas não foi feito/);
    assert.match(decisao.input, /não uma decisão da pessoa/);
    const nova = vistas.filter((r) => !triagem(r))[1];
    assert.match(nova.input, /respondeu ao que travou — siga isto: Faça agora pela conexão do Asana/);
    assert.match(nova.input, /O que a conferência de entrega mostrou \(siga também\): A conferência de entrega mostra que criar as tarefas não foi feito/, 'a instrução da conferência chega a quem tenta de novo');
    const x = resultado(c.task);
    assert.equal(x.state, 'validado', x.justification);
    assert.equal(h.db.get<{ completed: number }>('SELECT completed FROM tasks WHERE id = ?', c.task)!.completed, 1);
    assert.deepEqual(cartoes(c.conv), [], 'nada chegou à pessoa');
    assert.equal(escritas, 1);
  });

  test('parâmetro recusado pelo serviço → a equipe corrige e tenta de novo, sem a pessoa', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    asana = 'parametro';
    let tentativa = 0;
    await conduzir(async (r) => {
      if (triagem(r)) return 'Use o quadro Vendas pelo nome, como a lista de parâmetros pede, e tente de novo.';
      tentativa++;
      const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
      return resp.status === 'feita' ? 'Criei a tarefa no Asana.' : `Não deu: ${resp.texto}`;
    });
    assert.equal(tentativa, 2);
    const p = rodadas(c.task);
    assert.equal(p.length, 1);
    assert.match(p[0].refazer!, /não aceitou criar as tarefas: “o Asana recusou o pedido/);
    assert.equal(resultado(c.task).state, 'validado');
    assert.deepEqual(cartoes(c.conv), []);
  });

  test('rodadas esgotadas → a pessoa fica sabendo, com o motivo verdadeiro (e o número de rodadas)', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    const vistas = await conduzir((r) => (triagem(r) ? INSTRUCAO : 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.'), 80);
    assert.equal(rodadas(c.task).length, PERSIST_ROUNDS, 'o limite de rodadas segura o gasto');
    assert.equal(vistas.filter((r) => !triagem(r)).length, PERSIST_ROUNDS + 1, 'uma tentativa por rodada, mais a primeira');
    assert.equal(vistas.filter(triagem).length, PERSIST_ROUNDS);
    const x = resultado(c.task);
    assert.equal(x.state, 'falha');
    assert.match(x.justification, /não chegou a usar a conexão com Asana para criar as tarefas/);
    assert.deepEqual(cartoes(c.conv).map((p) => p.need), ['retry'], 'a pessoa decide: Tentar de novo');
    const msg = h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY created_at", c.conv).at(-1)!.content;
    assert.match(msg, new RegExp(`A equipe tentou resolver em ${PERSIST_ROUNDS} rodadas e não conseguiu\\. Último motivo: Não foi feito: .+ não chegou a usar a conexão com Asana`));
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'task.persist_exhausted'", c.task));
  });

  test('envio já feito não se repete: a nova tentativa sabe o que já saiu, e o serviço não faz de novo nem depois da janela de repetição', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato e concluir no Asana a tarefa Enviar NF');
    let tentativa = 0;
    const vistas = await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) {
        assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json.status, 'feita');
        // o que saiu ficou para trás da janela de repetição de 15 minutos: no mesmo trabalho do card, ainda não sai de novo
        h.db.run("UPDATE conexao_acoes SET created_at = ?, decided_at = NULL WHERE task_id = ?", new Date(Date.now() - 3600_000).toISOString(), c.task);
        return 'Criei a tarefa Revisar contrato no Asana. A outra não deu tempo.';
      }
      // a nova tentativa insiste em criar de novo: o serviço não repete
      const de_novo = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json;
      assert.equal(de_novo.status, 'feita');
      assert.match(de_novo.texto, /^Já feita neste trabalho \(o serviço registrou\), não repeti/);
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.concluir', { quadro: 'Vendas', tarefa: 'Enviar NF' })).json.status, 'feita');
      return 'Concluí no Asana a tarefa Enviar NF. A de Revisar contrato já estava criada.';
    });
    assert.equal(escritas, 2, 'uma criação e uma conclusão: nada saiu duas vezes');
    const p = rodadas(c.task);
    assert.equal(p.length, 1);
    assert.match(p[0].refazer!, /faltou mudar as tarefas .*Já feito pela conexão neste card, com o registro do serviço \(não repita\): criar as tarefas/);
    const nova = vistas.filter((r) => !triagem(r))[1];
    assert.match(nova.input, /Já feito nas contas neste card, com o registro do serviço \(não repita\):\n- asana · tarefa\.criar/);
    assert.equal(resultado(c.task).state, 'validado', resultado(c.task).justification);
  });

  test('Omie: a conta a receber já lançada no card não sai de novo na nova tentativa da equipe (mesmo com o código novo a cada inclusão)', async () => {
    h.integrations.secrets.write(s.workspaceId, 'omie', { app_key: '9999999999', app_secret: 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5' });
    setIntegration(h.db, s.workspaceId, 'omie', { state: 'connected', account_label: 'Loja Teste', connected_at: new Date().toISOString() });
    const VENDA = { cliente: 2485780, valor: 150.5, vencimento: '10/12/2026', categoria: '1.01.02', conta_corrente: 427619 };
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato e concluir no Asana a tarefa Enviar NF');
    let tentativa = 0; let de_novo: { status?: string; texto?: string } = {};
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) {
        assert.equal((await executar(r.hermes_session_id!, 'omie.incluir_conta_receber', VENDA, 'omie')).json.status, 'feita');
        assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json.status, 'feita');
        // fora da janela de 15 minutos: no mesmo trabalho do card, ainda não sai de novo
        h.db.run('UPDATE conexao_acoes SET created_at = ?, decided_at = NULL WHERE task_id = ?', new Date(Date.now() - 3600_000).toISOString(), c.task);
        return 'Lancei a conta a receber na Omie e criei a tarefa Revisar contrato no Asana. A outra não deu tempo.';
      }
      // a nova tentativa refaz tudo, inclusive o lançamento: o sistema segura antes da Omie
      de_novo = (await executar(r.hermes_session_id!, 'omie.incluir_conta_receber', VENDA, 'omie')).json;
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.concluir', { quadro: 'Vendas', tarefa: 'Enviar NF' })).json.status, 'feita');
      return 'Concluí no Asana a tarefa Enviar NF. O lançamento na Omie já estava feito.';
    });
    assert.equal(tentativa, 2, 'houve a nova tentativa da equipe');
    assert.equal(rodadas(c.task).length, 1);
    assert.equal(de_novo.status, 'feita', JSON.stringify(de_novo));
    assert.match(String(de_novo.texto), /^Já feita neste trabalho \(o serviço registrou\), não repeti/);
    assert.doesNotMatch(String(de_novo.texto), /Se a pessoa quer outra igual/, 'no card, quem libera é a resposta da pessoa, não a dica da conversa');
    assert.equal(omieLancadas, 1, 'a Omie recebeu um lançamento só');
  });

  test('envio que pede confirmação continua pedindo na nova tentativa: o card espera o clique da pessoa', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme', true);
    let tentativa = 0;
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) return 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.';
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
      return 'Pedi a confirmação da pessoa para criar a tarefa no Asana; quando ela decidir, sigo.';
    });
    assert.equal(rodadas(c.task).length, 1);
    assert.equal(escritas, 0, 'nada saiu sem o clique');
    assert.equal(h.db.get<{ work_state: string }>('SELECT work_state FROM tasks WHERE id = ?', c.task)!.work_state, 'aguardando_aprovacao');
    assert.ok(h.db.get("SELECT 1 AS x FROM agent_proposals WHERE kind = 'conexao' AND status = 'proposed'"), 'o cartão de confirmação está com a pessoa');
  });
});

describe('a decisão da equipe não veio', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('a rodada da equipe não terminou → a pessoa fica sabendo, e o histórico diz isso em português', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    for (let i = 0; i < 20; i++) {
      await tick();
      const r = rodando();
      if (!r) { if (!h.db.get("SELECT 1 AS x FROM runs WHERE status IN ('queued', 'running')")) break; continue; }
      const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', r.id)!.hermes_run_id;
      if (triagem(r)) motor.runs.set(remoto, { status: 'failed', output: null, error: 'tempo esgotado (teste)', sessionId: 's', usage: null, model: null });
      else motor.runs.set(remoto, { status: 'completed', output: 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.', error: null, sessionId: 's', usage: null, model: 'nous/teste-1' });
      await tick();
    }
    const d = h.db.get<{ result: string }>("SELECT result FROM audit_events WHERE target_id = ? AND action = 'task.persist_decision'", c.task)!;
    assert.match(d.result, /não chegou a uma decisão \(não terminou\)/);
    assert.doesNotMatch(d.result, /failed/);
    assert.deepEqual(cartoes(c.conv).map((p) => p.need), ['retry']);
  });
});

describe('o que só a pessoa resolve vai para ela, sem rodada da equipe', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());
  const semRodada = (taskId: string) => assert.equal(rodadas(taskId).length, 0, 'sem rodada da equipe');

  test('o serviço recusou a permissão (autorizar a conta de novo) → a pessoa, com o que fazer', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    asana = 'nega';
    await conduzir(async (r) => {
      const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
      assert.equal(resp.autorizar, true);
      return `Não deu: ${resp.texto}`;
    });
    semRodada(c.task);
    const x = resultado(c.task);
    assert.equal(x.state, 'falha');
    assert.equal(JSON.parse(x.evidence).honesta, 'servico_falhou');
    assert.match(x.justification, /Só você resolve isto: falta você liberar o acesso em Conexões › Asana/);
    assert.deepEqual(cartoes(c.conv).map((p) => p.need), ['retry']);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'conexao.pessoa'", c.task), 'a marca no histórico do card');
  });

  test('ação desligada pela pessoa → a pessoa (só ela liga), mesmo quando o agente só diz que não conseguiu', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    const row = h.db.get<{ settings: string }>("SELECT settings FROM integrations WHERE workspace_id = ? AND kind = 'asana'", s.workspaceId)!;
    await conduzir(async (r) => {
      // desligada durante o trabalho: o pedido para na regra, sem chegar ao serviço
      setIntegration(h.db, s.workspaceId, 'asana', { settings: { ...JSON.parse(row.settings || '{}'), permissoes: { tipos: {}, acoes: { 'tarefa.criar': 'desligado' } } } });
      const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
      assert.equal(resp.desligada, true);
      return 'Não consegui criar a tarefa no Asana: a pessoa desligou essa ação nas Conexões.';
    });
    semRodada(c.task);
    const x = resultado(c.task);
    assert.equal(x.state, 'falha');
    assert.match(x.justification, /Só você resolve isto: esta ação está desligada em Conexões › Asana, e só você decide ligar/);
  });

  test('a pessoa desligou a ação entre o cartão e o clique → nada sai, e o card fica com ela (sem rodada da equipe)', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme', true);
    const row = h.db.get<{ settings: string }>("SELECT settings FROM integrations WHERE workspace_id = ? AND kind = 'asana'", s.workspaceId)!;
    let tentativa = 0;
    await conduzir(async (r) => {
      if (++tentativa === 1) {
        assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
        return 'Pedi a confirmação da pessoa para criar a tarefa no Asana; quando ela decidir, sigo.';
      }
      return 'Não consegui criar a tarefa no Asana: a ação foi desligada nas Conexões depois do cartão.';
    }, 4);
    setIntegration(h.db, s.workspaceId, 'asana', { settings: { ...JSON.parse(row.settings || '{}'), permissoes: { tipos: {}, acoes: { 'tarefa.criar': 'desligado' } } } });
    const p = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'conexao' AND status = 'proposed'")!;
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json.status, 'failed');
    await conduzir(() => 'Não consegui criar a tarefa no Asana: a ação foi desligada nas Conexões depois do cartão.');
    semRodada(c.task);
    assert.equal(escritas, 0);
    assert.match(resultado(c.task).justification, /Só você resolve isto: esta ação está desligada em Conexões › Asana/);
  });

  test('o serviço não confirmou se fez (pode ter saído) → a pessoa confere; a equipe não repete', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    asana = 'sem_confirmar';
    await conduzir(async (r) => {
      const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
      assert.equal(resp.incerto, true);
      assert.match(resp.texto, /Não repita esta ação: pode ter saído/);
      return 'O Asana não confirmou a criação da tarefa.';
    });
    semRodada(c.task);
    assert.equal(escritas, 1);
    assert.match(resultado(c.task).justification, /Só você resolve isto: Asana não confirmou se fez: confira lá antes de pedir de novo/);
  });

  test('a empresa precisa aprovar (administrador) → a pessoa, mesmo sem o pedido chegar ao serviço', async () => {
    // conta de trabalho que deu só a etapa A: ler e-mails precisa da aprovação do administrador da empresa
    h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3_600_000,
      account: 'ana@empresa.test', tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pessoal: false, granted: [...ESCOPOS_MICROSOFT.base, ...ESCOPOS_MICROSOFT.trabalho].join(' ') });
    const c = await card('Leia meus e-mails do João desta semana e resuma');
    await conduzir(async (r) => {
      const resp = (await executar(r.hermes_session_id!, 'email.buscar', { consulta: 'João' }, 'microsoft')).json;
      assert.equal(resp.administrador, true, JSON.stringify(resp));
      return 'Ainda não deu para ler os e-mails: falta a aprovação do administrador da empresa.';
    });
    semRodada(c.task);
    const x = resultado(c.task);
    assert.equal(x.state, 'falha');
    assert.match(x.justification, /Só você resolve isto: falta você liberar o acesso em Conexões › Microsoft 365/);
  });

  test('autorizar de novo deixa a marca para trás: a falha seguinte volta a ser da equipe', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    asana = 'nega';
    let tentativa = 0;
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) {
        const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
        return `Não deu: ${resp.texto}`;
      }
      return 'Criei a tarefa no Asana.';
    });
    assert.match(resultado(c.task).justification, /Só você resolve isto/);
    // a pessoa conecta de novo e usa "Tentar de novo"; desta vez o agente nem chama a conexão: a equipe resolve
    asana = 'ok';
    setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', connected_at: new Date(Date.now() + 1000).toISOString() });
    await new Promise((ok) => setTimeout(ok, 5));
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/respond`, s, { action: 'retry' })).status, 200);
    let depois = 0;
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++depois === 1) return 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.';
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'feita');
      return 'Criei a tarefa no Asana.';
    });
    assert.equal(rodadas(c.task)[0]?.kind, 'conexao', 'sem a marca à vista, volta para a equipe');
    assert.equal(resultado(c.task).state, 'validado');
  });
});

describe('falta a ferramenta: um colega que tem entra no card', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('quem pegou o card não tem as Conexões, um colega tem → a equipe põe o colega, sem a pessoa', async () => {
    const tools = (JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[]).filter((x) => x !== 'contas');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(tools), agente);
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    const vistas = await conduzir((r) => (triagem(r) ? INSTRUCAO : 'Não tenho acesso ao seu e-mail entre as minhas ferramentas. O texto para a Delta está pronto.'), 80);
    const p = rodadas(c.task);
    assert.equal(p[0]?.kind, 'conexao');
    assert.match(p[0].refazer!, /não tem a ferramenta Conexões.*Quem tem a ferramenta Conexões na equipe: .+\. Ponha um deles numa etapa deste card/);
    assert.match(vistas.find(triagem)!.input, /Quem tem a ferramenta Conexões na equipe/);
  });

  test('ninguém na equipe tem as Conexões → a pessoa, com o que fazer', async () => {
    for (const a of h.db.all<{ id: string; tools: string }>('SELECT id, tools FROM agents WHERE workspace_id = ?', s.workspaceId)) {
      h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify((JSON.parse(a.tools) as string[]).filter((x) => x !== 'contas')), a.id);
    }
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    await conduzir(() => 'Não tenho acesso ao seu e-mail entre as minhas ferramentas. O texto para a Delta está pronto.');
    assert.equal(rodadas(c.task).length, 0);
    assert.match(resultado(c.task).justification, /Ligue as Conexões no perfil dele, em Equipe/);
    assert.deepEqual(cartoes(c.conv).map((p) => p.need), ['retry']);
  });
});

// ------------------------------------------------------------------------------- revisão: o que nunca pode sair duas vezes
/** Conta de trabalho da Microsoft com todas as permissões (nenhuma chamada sai para a Microsoft de verdade). */
function microsoftCompleta(): void {
  h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3_600_000,
    account: 'ana@empresa.test', tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pessoal: false, granted: Object.values(ESCOPOS_MICROSOFT).flat().join(' ') });
}
const pausa = () => new Promise((ok) => setTimeout(ok, 5));
const propostas = () => h.db.all<{ payload: string }>("SELECT payload FROM agent_proposals WHERE kind = 'conexao' AND status = 'proposed'").map((p) => JSON.parse(p.payload) as { porque: string; resumo: string });

describe('revisão: escrita que o serviço não confirmou não se repete', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  for (const status of [502, 503, 504] as const) {
    test(`a escrita recebeu ${status} (o serviço pode ter feito antes de falhar) → a pessoa confere; a equipe não repete`, async () => {
      const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
      asana = status;
      await conduzir(async (r) => {
        if (triagem(r)) return INSTRUCAO;
        const resp = (await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
        assert.equal(resp.incerto, true, JSON.stringify(resp));
        assert.match(resp.texto, /Não repita esta ação: pode ter saído/);
        return `Não deu: ${resp.texto}`;
      });
      assert.equal(rodadas(c.task).length, 0, 'sem rodada da equipe');
      assert.equal(escritas, 1, 'uma escrita só');
      const x = resultado(c.task);
      assert.equal(x.state, 'falha');
      assert.match(x.justification, new RegExp(`respondeu ${status}`));
      assert.match(x.justification, /Só você resolve isto: Asana não confirmou se fez/);
    });
  }

  test('um envio sem confirmação, outro (a outra pessoa) que deu certo, e falta a agenda → a marca do primeiro continua: a pessoa confere', async () => {
    microsoftCompleta();
    // o que falta é a agenda: a nova tentativa poderia mandar de novo à Ana, então a marca vale para o card inteiro
    const c = await card('Envie um e-mail para ana@cliente.test e outro para bia@cliente.test dizendo que a reunião foi adiada, e marque na minha agenda a reunião de sexta às 10h');
    graph = 'caiu_uma';
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      const a = (await executar(r.hermes_session_id!, 'email.enviar', { para: ['ana@cliente.test'], assunto: 'Reunião adiada', texto: 'A reunião foi adiada para sexta.' }, 'microsoft')).json;
      assert.equal(a.incerto, true, JSON.stringify(a));
      const b = (await executar(r.hermes_session_id!, 'email.enviar', { para: ['bia@cliente.test'], assunto: 'Reunião adiada', texto: 'A reunião foi adiada para sexta.' }, 'microsoft')).json;
      assert.equal(b.status, 'feita', JSON.stringify(b));
      return 'Não consegui enviar o e-mail para a Ana: o serviço não confirmou. O da Bia saiu.';
    });
    assert.equal(rodadas(c.task).length, 0, 'sem rodada da equipe: repetir poderia mandar duas vezes à Ana');
    assert.equal(escritas, 2);
    assert.match(resultado(c.task).justification, /Só você resolve isto: Microsoft 365 não confirmou se fez/);
  });
});

describe('revisão: o risco de cada chamada decide a marca de ação desligada', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('o tipo "enviar" desligado e um evento com convidados (enviar só por causa deles) → a pessoa, sem rodada da equipe', async () => {
    microsoftCompleta();
    const row = h.db.get<{ settings: string }>("SELECT settings FROM integrations WHERE workspace_id = ? AND kind = 'microsoft'", s.workspaceId)!;
    setIntegration(h.db, s.workspaceId, 'microsoft', { settings: { ...JSON.parse(row.settings || '{}'), permissoes: { tipos: { enviar: 'desligado' }, acoes: {} } } });
    const c = await card('Marque na minha agenda uma reunião com joao@acme.test amanhã às 10h e convide ele');
    let chamadas = 0;
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      chamadas++;
      const resp = (await executar(r.hermes_session_id!, 'agenda.criar', { titulo: 'Reunião com o João', inicio: '2026-11-09T10:00:00', fim: '2026-11-09T11:00:00', participantes: ['joao@acme.test'] }, 'microsoft')).json;
      assert.equal(resp.desligada, true, JSON.stringify(resp));
      return 'Não consegui marcar a reunião: a pessoa desligou o envio de convites nas Conexões.';
    });
    assert.equal(rodadas(c.task).length, 0, 'sem rodada da equipe');
    assert.equal(chamadas, 1, 'nenhuma nova tentativa à toa');
    assert.match(resultado(c.task).justification, /Só você resolve isto: esta ação está desligada em Conexões › Microsoft 365, e só você decide ligar/);
    const marca = JSON.parse(h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_id = ? AND action = 'conexao.pessoa'", c.task)!.evidence) as { risco: string };
    assert.equal(marca.risco, 'enviar', 'a marca guarda o risco desta chamada');
  });
});

describe('revisão: a nova tentativa da equipe não reenvia com outro texto', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('o comentário já saiu na tentativa anterior; a nova tentativa comenta de novo com outro texto → cartão para a pessoa, nada sai sozinho', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato e concluir no Asana a tarefa Enviar NF');
    let tentativa = 0; let segundo: { status: string } | null = null;
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      if (++tentativa === 1) {
        assert.equal((await executar(r.hermes_session_id!, 'tarefa.comentar', { quadro: 'Vendas', tarefa: 'Enviar NF', texto: 'A NF sai hoje.' })).json.status, 'feita');
        assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json.status, 'feita');
        return 'Comentei na tarefa Enviar NF e criei a tarefa Revisar contrato no Asana. A conclusão não deu tempo.';
      }
      // a nova tentativa reescreve o comentário (o hash muda): não sai sem a pessoa
      segundo = (await executar(r.hermes_session_id!, 'tarefa.comentar', { quadro: 'Vendas', tarefa: 'Enviar NF', texto: 'A NF sai hoje, como combinado.' })).json;
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.concluir', { quadro: 'Vendas', tarefa: 'Enviar NF' })).json.status, 'feita');
      return 'Concluí no Asana a tarefa Enviar NF e pedi a confirmação da pessoa para o comentário.';
    });
    assert.equal(rodadas(c.task).length, 1);
    assert.equal(segundo!.status, 'aguardando_confirmacao');
    assert.equal(escritas, 3, 'um comentário, uma criação e uma conclusão: o segundo comentário espera o clique');
    const p = propostas();
    assert.equal(p.length, 1);
    assert.match(p[0].porque, /uma nova tentativa da equipe quer mandar de novo por esta ação, que já saiu neste trabalho/);
  });

  test('fora de uma rodada da equipe, o segundo comentário com outro texto sai como sempre', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    await conduzir(async (r) => {
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.comentar', { quadro: 'Vendas', tarefa: 'Enviar NF', texto: 'Primeiro aviso.' })).json.status, 'feita');
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.comentar', { quadro: 'Vendas', tarefa: 'Enviar NF', texto: 'Segundo aviso.' })).json.status, 'feita');
      assert.equal((await executar(r.hermes_session_id!, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'feita');
      return 'Criei a tarefa no Asana e deixei os dois avisos na Enviar NF.';
    });
    assert.equal(escritas, 3);
    assert.equal(resultado(c.task).state, 'validado');
  });
});

describe('revisão: a pessoa pede, na resposta, para repetir um envio', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  const JOAO = { para: ['joao@acme.test'], assunto: 'Reunião adiada', texto: 'A reunião foi adiada para sexta.' };
  /** Primeiro envio ao João e uma pergunta; a pessoa responde com `resposta` (sem rodada da equipe para a pergunta). */
  async function perguntou(resposta: string): Promise<{ task: string; conv: string }> {
    microsoftCompleta();
    setSetting(h.db, s.workspaceId, 'team.persist', '0');
    const c = await card('Envie um e-mail para joao@acme.test dizendo que a reunião foi adiada para sexta');
    await conduzir(async (r) => {
      assert.equal((await executar(r.hermes_session_id!, 'email.enviar', JOAO, 'microsoft')).json.status, 'feita');
      return 'Enviei o e-mail ao João. [[perguntar pergunta="Quer que eu avise mais alguém?"]]';
    });
    assert.equal(resultado(c.task).state, 'aguardando_info', resultado(c.task).justification);
    await pausa();
    setSetting(h.db, s.workspaceId, 'team.persist', '1');
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/respond`, s, { action: 'answer', text: resposta })).status, 200);
    await pausa();
    return c;
  }

  test('"mande o mesmo e-mail de novo" → sai de novo, e o card conclui sem rodadas da equipe', async () => {
    const c = await perguntou('O João disse que não recebeu: mande o mesmo e-mail de novo para ele');
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      const resp = (await executar(r.hermes_session_id!, 'email.enviar', JOAO, 'microsoft')).json;
      assert.doesNotMatch(String(resp.texto), /^Já feita/);
      return 'Enviei de novo o e-mail ao João.';
    });
    assert.deepEqual(enviados, ['joao@acme.test', 'joao@acme.test'], 'o pedido dela vale');
    assert.equal(rodadas(c.task).length, 0);
    assert.equal(resultado(c.task).state, 'validado', resultado(c.task).justification);
  });

  test('"mande também para a Carla" não libera repetir o do João: só o da Carla sai', async () => {
    const c = await perguntou('Sim, mande um e-mail também para carla@acme.test');
    await conduzir(async (r) => {
      if (triagem(r)) return INSTRUCAO;
      assert.match(String((await executar(r.hermes_session_id!, 'email.enviar', JOAO, 'microsoft')).json.texto), /^Já feita neste trabalho/);
      assert.equal((await executar(r.hermes_session_id!, 'email.enviar', { ...JOAO, para: ['carla@acme.test'] }, 'microsoft')).json.status, 'feita');
      return 'Enviei o e-mail para a Carla também.';
    });
    assert.deepEqual(enviados, ['joao@acme.test', 'carla@acme.test']);
    assert.equal(resultado(c.task).state, 'validado', resultado(c.task).justification);
  });
});

describe('revisão: "a equipe tentou em N rodadas" só quando as rodadas acabaram', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('uma rodada antes, e a equipe desligada agora → o motivo da conferência, sem dizer que a equipe tentou', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    let tentativa = 0;
    await conduzir(async (r) => {
      if (triagem(r)) {
        // a pessoa desliga a equipe enquanto a rodada decide: a próxima falha não abre rodada
        setSetting(h.db, s.workspaceId, 'team.persist', '0');
        return INSTRUCAO;
      }
      tentativa++;
      return 'Preparei a tarefa Revisar contrato da Acme com o prazo e a descrição; ela está pronta para entrar no Asana.';
    });
    assert.equal(tentativa, 2);
    assert.equal(rodadas(c.task).length, 1);
    const x = resultado(c.task);
    assert.equal(x.state, 'falha');
    assert.match(x.justification, /não chegou a usar a conexão com Asana/);
    assert.doesNotMatch(x.justification, /A equipe tentou resolver/);
    assert.equal(h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'task.persist_exhausted'", c.task), undefined);
  });
});
