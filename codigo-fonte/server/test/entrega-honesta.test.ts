/**
 * Entrega honesta: nada de "concluído" sem evidência. O que o pedido quer fazer numa conta conectada vale pelo registro do
 * serviço (conexao_acoes): feita → concluída com a evidência; esperando o cartão → espera a pessoa; depois do clique, o card
 * é conferido de novo (feita → concluída, recusada → descartado por você, falhou → falha com o motivo do serviço). Agente
 * com as Conexões que nem chamou a conexão é falha (o card #16, e-mail "concluído" sem nada enviado), e "não saiu do papel"
 * nunca vira entrega para aprovar (o card #17). Só "sem confirmação" quando nenhuma conexão faz aquilo (pagar um boleto).
 * E a rotina "Teams + e-mail → tarefas": no máximo uma rodada por dia, com a conferência pelo registro do serviço.
 * O aplicativo de teste é o Asana, com a API simulada; a Microsoft fica só "conectada" (nenhuma chamada sai para ela).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setPlatformToolsets } from '../src/services/characters.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { intencoesDoPedido, naoFeito } from '../src/services/results.ts';
import { CATALOG, TEAMS_POR_DIA, conferirConexoes, leTeams, templateByKey } from '../src/services/routine-catalog.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_honesta${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// ---------------------------------------------------------------------------------------- API do Asana simulada
let asanaNega = false; let chamadas = 0;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  if (method !== 'GET') { chamadas++; if (asanaNega) return Promise.resolve(json({ errors: [{ message: 'not authorized' }] }, 403)); }
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  if (path === '/tasks' && method === 'GET') return Promise.resolve(json({ data: [] }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
async function preparar(persistir = false): Promise<void> {
  asanaNega = false; chamadas = 0;
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[];
  if (!tools.includes('contas')) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, 'contas']), agente);
  if (!persistir) h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
}
const conectarAsana = () => {
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
};
/** A Microsoft "conectada": as ações aparecem para os agentes (nenhuma chamada sai para ela nestes testes). */
const conectarMicrosoft = () => setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
/** Um card da equipe posto para trabalhar. fora: veio de uma mensagem recebida (as ações pedem confirmação). */
async function card(titulo: string, fora = false): Promise<{ task: string; number: number; sessao: string; run: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  if (fora) h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>("SELECT id, hermes_session_id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%' ORDER BY created_at DESC LIMIT 1", t.id)!;
  return { task: t.id, number: t.number, sessao: r.hermes_session_id, run: r.id };
}
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>, conexao = 'asana') =>
  req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao, acao, parametros }, { 'x-ergon-bridge-token': TOKEN });
const decidir = async (decision: 'apply' | 'reject') => {
  const p = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'conexao' AND status = 'proposed' ORDER BY created_at DESC LIMIT 1")!;
  return (await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision })).json as { status: string; result: string };
};
const estado = (taskId: string) => h.db.get<{ completed: number; archived: number; work_state: string }>('SELECT completed, archived, work_state FROM tasks WHERE id = ?', taskId)!;
const resultado = (taskId: string) => h.db.get<{ state: string; justification: string; evidence: string; run_id: string | null }>(
  'SELECT state, justification, evidence, run_id FROM task_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId);
/** A execução que o card ganhou depois do clique (o card volta a andar com a decisão). */
const novaExecucao = async (taskId: string, antes: string) => { await tick(); return h.db.get<{ id: string; input: string }>('SELECT id, input FROM runs WHERE task_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1', taskId, antes); };

describe('entrega honesta: o card #16 e o card #17', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('#16: pedido de e-mail, agente com as Conexões, nenhuma chamada → falha com o motivo, nunca concluído nem "confirme quando estiver feito"', async () => {
    conectarMicrosoft();
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    assert.match(h.db.get<{ input: string }>('SELECT input FROM runs WHERE id = ?', c.run)!.input, /faça agora pelas Conexões/, 'o agente não ouve mais "você não executa ações fora do Ergon"');
    await terminar(c.run, 'Preparei o e-mail para a Delta pedindo o orçamento revisado, com o número do pedido, o prazo de resposta até sexta e a assinatura. Não tenho e-mail entre as minhas ferramentas, então ele está pronto para você enviar.');
    const r = resultado(c.task)!;
    assert.equal(r.state, 'falha');
    assert.match(r.justification, /não chegou a usar a conexão com Microsoft 365 para enviar o e-mail/);
    assert.match(r.justification, /Nada saiu pela conta/);
    assert.equal(JSON.parse(r.evidence).honesta, 'sem_chamada');
    const t = estado(c.task);
    assert.equal(t.completed, 0); assert.equal(t.work_state, 'falha');
    // falha não se aprova: nem em "aguardando você", nem pelo botão
    assert.ok(!(await req(h, 'GET', '/api/decisions', s)).json.cards.some((x: { id: string }) => x.id === c.task));
    const ap = await req(h, 'POST', `/api/tasks/${c.task}/respond`, s, { action: 'approve' });
    assert.equal(ap.status, 409); assert.match(ap.json.message ?? JSON.stringify(ap.json), /não foi feito/);
    assert.equal(estado(c.task).completed, 0, 'continua aberto');
  });

  test('#16 com a equipe ligada: a falha vai para a pessoa ("Tentar de novo"); a equipe não tenta mandar por conta própria', async () => {
    await h.close(); await preparar(true);
    conectarMicrosoft();
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, c.task);
    await terminar(c.run, 'Preparei o e-mail para a Delta pedindo o orçamento revisado, com o número do pedido, o prazo de resposta até sexta e a assinatura, pronto para você enviar quando quiser.');
    assert.equal(resultado(c.task)!.state, 'falha');
    // uma nova tentativa por iniciativa da equipe poderia enviar o que a pessoa só queria preparar (as palavras do pedido enganam)
    assert.equal(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'task.persist' AND target_id = ?", c.task), undefined, 'sem ciclo da equipe');
    const cartao = ((await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ kind: string; status: string; payload: string | null }>)
      .find((p) => p.kind === 'info_request' && p.status === 'proposed');
    assert.equal(JSON.parse(cartao!.payload!).need, 'retry', 'a pessoa decide: Tentar de novo');
  });

  test('#17: "não saiu do papel" nunca vira entrega para aprovar; o cartão da conversa oferece tentar de novo', async () => {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
    const c = await card('Avaliar uma semana de conversas do Teams e criar as tarefas no Planner');
    h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, c.task); // o pedido veio de uma conversa
    await terminar(c.run, 'A avaliação não saiu do papel: as Conexões ainda não estão habilitadas no workspace e a permissão não desceu da conta conectada até o perfil da equipe.');
    const r = resultado(c.task)!;
    assert.equal(r.state, 'falha', 'sem conta conectada: o próprio agente disse que não fez');
    assert.equal(JSON.parse(r.evidence).honesta, 'declarou');
    assert.match(r.justification, /disse “A avaliação não saiu do papel/);
    assert.notEqual(estado(c.task).work_state, 'aguardando_aprovacao');
    const cartao = ((await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ id: string; kind: string; status: string; payload: string | null }>)
      .find((p) => p.kind === 'info_request' && p.status === 'proposed');
    assert.ok(cartao, 'a conversa fica sabendo');
    assert.equal(JSON.parse(cartao!.payload!).need, 'retry', 'tentar de novo, nunca Aprovar');
    assert.equal((await req(h, 'POST', `/api/proposals/${cartao!.id}/respond`, s, { action: 'approve' })).status, 409, 'nem pelo cartão');
    assert.equal(estado(c.task).completed, 0);
  });

  test('#17 com a Microsoft conectada: ler o Teams e criar no Planner sem nenhuma chamada é falha', async () => {
    conectarMicrosoft();
    const c = await card('Avaliar uma semana de conversas do Teams e criar as tarefas no Planner');
    await terminar(c.run, `Avaliei a semana: ${'os pontos principais foram combinados e as tarefas estão claras, '.repeat(6)}e deixo o plano abaixo para você aprovar.`);
    const r = resultado(c.task)!;
    assert.equal(r.state, 'falha');
    assert.match(r.justification, /não chegou a usar a conexão com Microsoft 365 para ler as conversas do Teams e criar as tarefas/);
  });

  test('o que nenhuma conexão faz (pagar um boleto) continua esperando a sua confirmação', async () => {
    conectarMicrosoft();
    const c = await card('Pagar o boleto da Delta que vence sexta');
    await terminar(c.run, 'Separei o boleto da Delta: valor de 1.250 reais, vencimento na sexta, código de barras conferido com a nota fiscal do mês. Não tenho acesso ao seu banco: para concluir, pague pelo aplicativo do banco e confirme aqui no card.');
    assert.equal(resultado(c.task)!.state, 'sem_confirmacao', '"não tenho acesso" é o esperado no que só a pessoa faz');
    assert.equal(estado(c.task).work_state, 'aguardando_aprovacao');
  });

  test('"sem confirmação" com uma ferramenta que falhou no caminho não conta a etapa como feita', async () => {
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Pagar o boleto da Delta que vence sexta', agentId: agente })).json;
    h.db.run("INSERT INTO task_steps (id, workspace_id, task_id, position, agent_id, title, status, created_at) VALUES ('stp_honesta1', ?, ?, 1, ?, 'Separar o boleto e preparar o pagamento', 'em_andamento', ?)",
      s.workspaceId, t.id, agente, new Date().toISOString());
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s); await tick();
    const run = h.db.get<{ id: string }>("SELECT id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)!.id;
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, started_at, finished_at, ok) VALUES (?, ?, 0, 'web_search', ?, ?, 0)", s.workspaceId, run, new Date().toISOString(), new Date().toISOString());
    await terminar(run, 'Separei o boleto da Delta: valor de 1.250 reais, vencimento na sexta, código de barras conferido com a nota fiscal do mês. Para concluir, pague pelo aplicativo do banco e confirme aqui no card.');
    assert.equal(resultado(t.id)!.state, 'sem_confirmacao');
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM task_steps WHERE id = 'stp_honesta1'")!.status, 'falhou');
  });

  test('chamou a conexão, mas o pedido não chegou ao serviço (parâmetro errado): falha dizendo isso', async () => {
    conectarMicrosoft();
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, started_at, finished_at, ok) VALUES (?, ?, 0, 'conexoes_executar', ?, ?, 1)", s.workspaceId, c.run, new Date().toISOString(), new Date().toISOString());
    await terminar(c.run, 'Tentei enviar o e-mail para a Delta pela conta da Microsoft, mas a ferramenta respondeu que faltava um parâmetro, e eu deixei o texto pronto aqui no card.');
    const r = resultado(c.task)!;
    assert.equal(r.state, 'falha');
    assert.match(r.justification, /tentou usar a conexão com Microsoft 365 para enviar o e-mail, mas o pedido não chegou ao serviço/);
  });
});

describe('entrega honesta: o registro do serviço decide, antes e depois do cartão', () => {
  beforeEach(async () => { await preparar(); conectarAsana(); });
  afterEach(() => h.close());

  test('feita pela conexão → concluída com a evidência do serviço (o texto curto basta)', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme');
    const r = (await executar(c.sessao, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json;
    assert.equal(r.status, 'feita', JSON.stringify(r)); assert.equal(chamadas, 1);
    await terminar(c.run, 'Pronto.');
    const x = resultado(c.task)!;
    assert.equal(x.state, 'validado', x.justification);
    assert.match(x.justification, /Concluída com evidência: Asana registrou: criar as tarefas/);
    assert.match(x.justification, /Tarefa criada/, 'o que o serviço devolveu');
    assert.equal(estado(c.task).completed, 1);
  });

  test('esperando o cartão → aguardando a sua confirmação; confirmar → a conferência de novo conclui com a evidência', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme', true);
    assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
    await terminar(c.run, 'Pedi a confirmação da pessoa para criar a tarefa no Asana; quando ela decidir, sigo.');
    assert.equal(estado(c.task).work_state, 'aguardando_aprovacao');
    assert.equal(resultado(c.task), undefined, 'nada decidido enquanto espera');
    assert.equal((await decidir('apply')).status, 'applied');
    const nova = (await novaExecucao(c.task, c.run))!;
    assert.match(nova.input, /Já feito nas contas neste card, com o registro do serviço \(não repita\)/);
    await terminar(nova.id, 'A tarefa foi criada no Asana depois da sua confirmação.');
    const x = resultado(c.task)!;
    assert.equal(x.state, 'validado', x.justification); assert.equal(x.run_id, nova.id);
    assert.equal(estado(c.task).completed, 1);
  });

  test('recusar no cartão → recusado por você: o card fica aberto esperando o que mudar, sem falha nem entrega, e nada sai do quadro', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme', true);
    // um card que nasceu deste e já terminou: a recusa não mexe nele
    const filho = (await req(h, 'POST', '/api/tasks', s, { title: 'Levantar o contrato da Acme', agentId: agente })).json.id as string;
    h.db.run('UPDATE tasks SET parent_task_id = ?, completed = 1 WHERE id = ?', c.task, filho);
    await executar(c.sessao, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' });
    await terminar(c.run, 'Pedi a confirmação da pessoa para criar a tarefa no Asana; quando ela decidir, sigo.');
    assert.equal((await decidir('reject')).status, 'rejected');
    const nova = (await novaExecucao(c.task, c.run))!;
    await terminar(nova.id, 'Entendido: não criei a tarefa, porque a pessoa recusou no cartão.');
    const x = resultado(c.task)!;
    assert.equal(x.state, 'descartado', x.justification);
    assert.match(x.justification, /^Recusado por você no cartão: criar as tarefas\. Nada foi feito; o card fica aberto esperando o que mudar/);
    const t = estado(c.task);
    assert.equal(t.archived, 0, 'continua no quadro'); assert.equal(t.completed, 0, 'não conta como feito');
    assert.equal(t.work_state, 'aguardando_info');
    assert.equal(estado(filho).archived, 0, 'o card que nasceu dele não sai junto');
    const d = (await req(h, 'GET', '/api/decisions', s)).json.cards.find((y: { id: string }) => y.id === c.task);
    assert.equal(d?.need, 'info', 'aguardando você: o que mudar');
    assert.match(d.question, /O que a equipe deve mudar para fazer de novo\? Se não quer mais, cancele o card\./);
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/respond`, s, { action: 'approve' })).status, 409, 'nada a aprovar');
    assert.equal(chamadas, 0);
  });

  test('confirmar e o serviço recusar → falha com o motivo do serviço', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato da Acme', true);
    await executar(c.sessao, 'tarefa.criar', { titulo: 'Revisar contrato da Acme', quadro: 'Vendas' });
    await terminar(c.run, 'Pedi a confirmação da pessoa para criar a tarefa no Asana; quando ela decidir, sigo.');
    asanaNega = true;
    assert.equal((await decidir('apply')).status, 'failed');
    const nova = (await novaExecucao(c.task, c.run))!;
    await terminar(nova.id, 'A criação da tarefa no Asana falhou, segundo o resultado da ferramenta.');
    const x = resultado(c.task)!;
    assert.equal(x.state, 'falha');
    assert.match(x.justification, /^Não foi feito: Asana não aceitou criar as tarefas \(.*not authorized/);
    assert.equal(JSON.parse(x.evidence).honesta, 'servico_falhou');
    assert.equal(estado(c.task).completed, 0);
  });
});

describe('entrega honesta: o que conta como pedido numa conta e como "não fiz"', () => {
  before(async () => { await preparar(); conectarMicrosoft(); });
  after(() => h.close());
  const ids = (t: string) => intencoesDoPedido(h.db, s.workspaceId, t).map((i) => i.id);

  test('pedidos de ação numa conta conectada', () => {
    assert.deepEqual(ids('Envie um e-mail para a Ana com a proposta'), ['email.enviar']);
    assert.deepEqual(ids('Mande no Teams para o João que a reunião mudou'), ['teams.enviar']);
    assert.deepEqual(ids('Avaliar uma semana de conversas do Teams e criar tarefas no Planner'), ['teams.ler', 'tarefa.criar']);
    assert.deepEqual(ids('Marque uma reunião com a Carla na quinta'), ['agenda.criar']);
  });

  test('não é pedido de ação: como fazer, rascunho, não enviar, e-mail já enviado, tarefa sem aplicativo, pagar', () => {
    assert.deepEqual(ids('Como enviar e-mail pelo Ergon?'), []);
    assert.deepEqual(ids('Escreva o e-mail para a Ana, mas não envie: só o rascunho'), []);
    // e-mail já enviado não é pedido de envio; resumir esse e-mail é ler a caixa da pessoa (a leitura vale pelo registro)
    assert.deepEqual(ids('Resuma o e-mail enviado pelo João ontem'), ['email.ler']);
    assert.deepEqual(ids('Crie as tarefas do projeto de lançamento'), [], 'sem aplicativo citado: o quadro do Ergon');
    assert.deepEqual(ids('Pagar o boleto da Delta'), []);
  });

  test('"não fiz": no começo ou em resposta curta; ressalva no meio de uma entrega não conta', () => {
    assert.match(naoFeito('A avaliação não saiu do papel por falta de acesso.')!, /não saiu do papel/);
    assert.match(naoFeito('Não consegui enviar o e-mail: a conta não respondeu.')!, /Não consegui enviar/);
    assert.equal(naoFeito('Não consegui acessar o site do IBGE, mas usei a PNAD de 2024 e o relatório completo está abaixo.'), null);
    assert.equal(naoFeito(`${'Pesquisa completa com as fontes indicadas e os números conferidos. '.repeat(40)}Não foi possível acessar uma das fontes, que ficou de fora.`), null);
    assert.equal(naoFeito('Preparei o rascunho. Não tenho acesso ao seu banco, então falta você pagar.', true), null, 'o que nenhuma conexão faz: falta a pessoa fazer');
  });
});

describe('rotina "Teams + e-mail → tarefas": uma rodada por dia, conferida pelo registro do serviço', () => {
  test('o catálogo não oferece mais que uma rodada por dia para o que lê o Teams', () => {
    const t = templateByKey('teams-email-tarefas')!;
    assert.ok(t && t.available);
    assert.ok(leTeams(t));
    assert.deepEqual(t.conexoes!.le.flatMap((g) => g.acoes).sort(), ['email.buscar', 'email.ler', 'teams.conversas', 'teams.ler']);
    assert.deepEqual(t.conexoes!.cria.acoes, ['tarefa.criar']);
    assert.ok(t.checks?.includes('conexoes'));
    assert.match(t.approvals, /a menos que você ligue "Liberar tudo" em Conexões/);
    for (const x of CATALOG.filter(leTeams)) {
      assert.ok(x.defaults!.config.maxPerDay <= TEAMS_POR_DIA, `${x.name}: no máximo ${TEAMS_POR_DIA} por dia`);
      assert.ok(x.defaults!.trigger.kind === 'manual' || typeof x.defaults!.trigger.time === 'string', `${x.name}: um horário só por dia`);
    }
    assert.match(t.defaults!.config.instruction, /Dados desde/, 'só o período desde a última rodada');
  });

  test('a conferência das Conexões: leu o e-mail e o Teams pelo registro, e conta o que criou', () => {
    const t = templateByKey('teams-email-tarefas')!;
    const ok = conferirConexoes(t, [{ acao: 'email.buscar', status: 'feita' }, { acao: 'teams.conversas', status: 'feita' }, { acao: 'teams.ler', status: 'feita' },
      { acao: 'tarefa.criar', status: 'feita' }, { acao: 'tarefa.criar', status: 'pendente' }])!;
    assert.equal(ok.ok, true);
    assert.equal(ok.detail, 'E-mail: 1 leitura(s) · Teams: 2 leitura(s) · Tarefas: 1 criada(s), 1 esperando a sua confirmação');
    const semTeams = conferirConexoes(t, [{ acao: 'email.buscar', status: 'feita' }, { acao: 'teams.conversas', status: 'falhou', erro: 'falta a aprovação do administrador' }])!;
    assert.equal(semTeams.ok, false);
    assert.match(semTeams.detail, /Teams: não foi lido \(falta a aprovação do administrador\)/);
    assert.equal(conferirConexoes(t, [])!.ok, false, 'sem registro, não leu');
    assert.equal(conferirConexoes(templateByKey('briefing-diario')!, []), null, 'rotina que não usa as Conexões');
  });

  test('"Executar agora" de novo no mesmo dia não é aceito', async () => {
    const hh = await harness();
    try {
      const ss = await setupOwner(hh);
      const r = await req(hh, 'POST', '/api/routines', ss, { template: 'teams-email-tarefas', tz: 'America/Sao_Paulo' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.schedule, 'Seg a sex às 17:45');
      assert.equal((await req(hh, 'POST', `/api/routines/${r.json.id}/run`, ss, { clientRequestId: 'teams-dia-1' })).status, 202);
      const ativa = () => hh.db.get("SELECT 1 AS x FROM routine_runs WHERE routine_id = ? AND status IN ('queued', 'gathering', 'running')", r.json.id);
      for (let i = 0; i < 200 && ativa(); i++) await new Promise((ok) => setTimeout(ok, 10));
      assert.ok(!ativa(), 'a primeira rodada terminou');
      const de_novo = await req(hh, 'POST', `/api/routines/${r.json.id}/run`, ss, { clientRequestId: 'teams-dia-2' });
      assert.equal(de_novo.status, 429, JSON.stringify(de_novo.json));
      assert.equal(de_novo.json.message, 'Esta rotina já rodou nas últimas 24 horas (uma rodada por dia).');
    } finally { await hh.close(); }
  });
});

describe('entrega honesta: o que a revisão achou (falsos positivos, nova tentativa, ferramenta que falta)', () => {
  beforeEach(async () => { await preparar(); conectarMicrosoft(); });
  afterEach(() => h.close());
  const ids = (t: string) => intencoesDoPedido(h.db, s.workspaceId, t).map((i) => i.id);
  const corpo = 'O texto abaixo traz os números de 2024, as políticas públicas em andamento, os programas estaduais e as recomendações para escolas e prefeituras. '.repeat(4);
  const semCiclo = (taskId: string) => assert.equal(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'task.persist' AND target_id = ?", taskId), undefined, 'sem ciclo da equipe');

  test('rascunho, "para eu enviar", guia, política e conteúdo já colado não são pedido de agir na conta', () => {
    for (const p of [
      'Escreva um texto para eu enviar por e-mail ao cliente',
      'Redija um e-mail para enviar à Ana amanhã',
      'Prepare a resposta para eu mandar por e-mail',
      'Faça um relatório sobre o uso das mensagens do Teams na empresa',
      'Crie um guia de boas práticas para responder e-mails de clientes',
      'Monte um treinamento sobre como a equipe deve ler e-mails com atenção',
      'Escreva uma política: nunca envie e-mail com dados sensíveis',
      'Analise as conversas do Teams que colei abaixo',
    ]) assert.deepEqual(ids(p), [], p);
    assert.deepEqual(ids('Leia meus e-mails e resuma'), ['email.ler']);
    assert.deepEqual(ids('Envie um e-mail para a Ana com a proposta'), ['email.enviar']);
  });

  test('"não fiz" é o que o agente diz de si ou da ferramenta dele, não o assunto do texto', () => {
    assert.equal(naoFeito('Milhões de brasileiros ainda não têm acesso à internet de qualidade. Este artigo mostra os dados de 2024.'), null);
    assert.equal(naoFeito('Comparativo dos planos: no plano gratuito, a exportação não está disponível; no plano Pro, ela vem incluída.'), null);
    assert.equal(naoFeito('Resumo: a lei diz que não é possível abrir empresa sem CNPJ, e o roteiro abaixo explica cada passo.'), null);
    assert.equal(naoFeito('Pesquisa pronta. O cliente informou que não consegue acessar o portal desde terça; sugiro abrir chamado.'), null);
    assert.match(naoFeito('Não tenho acesso ao seu e-mail entre as minhas ferramentas.')!, /Não tenho acesso/);
    assert.match(naoFeito('As Conexões ainda não estão habilitadas para mim, então nada saiu.')!, /não estão habilitadas/);
  });

  test('um artigo e um comparativo corretos não viram falha; um rascunho pedido também não', async () => {
    for (const [titulo, saida] of [
      ['Escreva um artigo sobre inclusão digital no Brasil', `Milhões de brasileiros ainda não têm acesso à internet de qualidade. ${corpo}`],
      ['Compare os planos gratuito e Pro do Notion', `No plano gratuito, a exportação em lote não está disponível; no Pro, vem incluída. ${corpo}`],
      ['Redija um e-mail para eu enviar à Ana amanhã com a proposta', `Assunto: Proposta comercial\n\nOlá, Ana! Segue a proposta conforme conversamos. ${corpo}`],
    ]) {
      const c = await card(titulo);
      await terminar(c.run, saida);
      const r = resultado(c.task)!;
      assert.notEqual(r.state, 'falha', `${titulo}: ${r.justification}`);
    }
  });

  test('falha parcial e nova tentativa: o que já saiu pela conta conta, e o card conclui', async () => {
    conectarAsana();
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Cadastrar no Asana a tarefa Revisar contrato e concluir no Asana a tarefa Enviar NF', agentId: agente })).json;
    let n = 0;
    const rodar = async (acao: string, saida: string) => {
      const r = h.db.get<{ id: string }>('SELECT id FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', t.id)!;
      const agora = new Date().toISOString();
      h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, started_at, finished_at, ok) VALUES (?, ?, 0, 'conexoes_executar', ?, ?, 1)", s.workspaceId, r.id, agora, agora);
      h.db.run(`INSERT INTO conexao_acoes (id, workspace_id, run_id, agent_id, task_id, conexao, acao, risco, origem, decisao, status, resultado, created_at)
        VALUES (?, ?, ?, ?, ?, 'asana', ?, 'organizar', 'pessoa', 'direto', 'feita', 'ok', ?)`, `cxa_honesta_${++n}`, s.workspaceId, r.id, agente, t.id, acao, agora);
      await terminar(r.id, saida);
      return resultado(t.id)!;
    };
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s); await tick();
    const a = await rodar('tarefa.criar', 'Criei a tarefa Revisar contrato no Asana. A outra não deu tempo.');
    assert.equal(a.state, 'falha');
    assert.match(a.justification, /^Não foi feito por inteiro: faltou mudar as tarefas/);
    await new Promise((ok) => setTimeout(ok, 5));
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s); await tick();
    const entrada = h.db.get<{ input: string }>('SELECT input FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', t.id)!.input;
    assert.match(entrada, /Já feito nas contas neste card/, 'a nova tentativa sabe o que já saiu');
    await new Promise((ok) => setTimeout(ok, 5));
    const b = await rodar('tarefa.concluir', 'Concluí no Asana a tarefa Enviar NF. A de Revisar contrato já estava criada.');
    assert.equal(b.state, 'validado', b.justification);
  });

  test('ninguém no card tem a ferramenta Conexões: falha dizendo isso, nunca "confirme quando estiver feito"', async () => {
    await h.close(); await preparar(true); conectarMicrosoft();
    const tools = (JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[]).filter((x) => x !== 'contas');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(tools), agente);
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    await terminar(c.run, 'Não tenho acesso ao seu e-mail entre as minhas ferramentas. Preparei o texto para a Delta com o número do pedido e o prazo até sexta, pronto para você enviar.');
    const r = resultado(c.task)!;
    assert.equal(r.state, 'falha', r.justification);
    assert.equal(JSON.parse(r.evidence).honesta, 'sem_ferramenta');
    assert.match(r.justification, /não tem a ferramenta Conexões.*Ligue as Conexões no perfil dele, em Equipe, ou passe o card a um colega que tenha/);
    semCiclo(c.task);
  });

  test('rotina "Teams + e-mail → tarefas" com modelo: a conferência da rodada leva o registro do serviço (sem leitura registrada, nunca "validado")', async () => {
    const r = await req(h, 'POST', '/api/routines', s, { template: 'teams-email-tarefas', tz: 'America/Sao_Paulo' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal((await req(h, 'POST', `/api/routines/${r.json.id}/run`, s, { clientRequestId: 'teams-modelo-1' })).status, 202);
    let rr: { run_id: string | null; status: string } | undefined;
    for (let i = 0; i < 200; i++) {
      await tick(1);
      rr = h.db.get<{ run_id: string | null; status: string }>('SELECT run_id, status FROM routine_runs WHERE routine_id = ?', r.json.id);
      if (rr?.run_id && h.db.get<{ hermes_run_id: string | null }>('SELECT hermes_run_id FROM runs WHERE id = ?', rr.run_id)?.hermes_run_id) break;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.ok(rr?.run_id, `a rodada chegou ao agente (${JSON.stringify(rr)})`);
    await terminar(rr!.run_id!, `Li 14 e-mails e 6 conversas do Teams e criei 3 tarefas no Planner. ${'Cada tarefa traz quem pediu, quando e de onde veio. '.repeat(5)}`);
    const fim = h.db.get<{ checks: string | null; verdict: string | null; status: string }>('SELECT checks, verdict, status FROM routine_runs WHERE routine_id = ?', r.json.id)!;
    assert.equal(fim.status, 'succeeded', JSON.stringify(fim));
    const cx = (JSON.parse(fim.checks ?? '{}').criteria as Array<{ id: string; ok: boolean; detail: string }>).find((k) => k.id === 'conexoes');
    assert.ok(cx, 'critério das Conexões na conferência');
    assert.equal(cx!.ok, false);
    assert.match(cx!.detail, /E-mail: não foi lido \(nenhuma leitura registrada\) · Teams: não foi lido/);
    assert.notEqual(fim.verdict, 'validado', 'o texto "li 14 e-mails" sem registro não vale');
  });

  test('o motor deste computador ainda não tem as Conexões: a falha diz isso, sem culpar o agente e sem ciclo da equipe', async () => {
    await h.close(); await preparar(true); conectarMicrosoft();
    try {
      const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
      setPlatformToolsets(['todo', 'web'], '_', ['todo', 'web']); // o motor (lido) não tem o conjunto
      await terminar(c.run, 'As Conexões estão sendo atualizadas neste computador; a parte do e-mail segue quando terminar.');
      const r = resultado(c.task)!;
      assert.equal(r.state, 'falha', r.justification);
      assert.equal(JSON.parse(r.evidence).honesta, 'sem_ferramenta');
      assert.match(r.justification, /as Conexões estão sendo atualizadas neste computador, então .+ não tinha como enviar o e-mail/);
      assert.doesNotMatch(r.justification, /não chegou a usar/);
      semCiclo(c.task);
    } finally { setPlatformToolsets([], '_', []); }
  });
});
