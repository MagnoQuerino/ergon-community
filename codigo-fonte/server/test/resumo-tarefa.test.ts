/**
 * Resumo da tarefa para a pessoa (services/resumo-tarefa.ts): a situação em uma palavra e a frase exata do que se aprova
 * ou do que foi feito, pelos FATOS que o sistema registrou (cartões esperando o clique, ações feitas pelo serviço,
 * documento entregue), mais a linha que o agente escreve ao entregar ("Para você decidir: …" / "Feito: …"), que nunca
 * aparece duas vezes. Entregas de exemplo como as de verdade; o aplicativo de teste é o Asana, com a API simulada.
 * Também: "Aprovar" de vários cartões de uma vez (o card volta a andar uma vez só) e a prévia do PDF dentro do card.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { AVISO_SEM_CARTAO, avisoSemCartao, etapaCurta, fatoDaAcao, fraseDepoisDeLer, fraseDoPendente, frasesDoFeito, separarLinhaParaVoce } from '../src/services/resumo-tarefa.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_resumo${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

let gid = 0;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }] }));
  if (path === '/tasks' && method === 'GET') return Promise.resolve(json({ data: [] }));
  return Promise.resolve(json({ data: { gid: `novo${++gid}`, modified_at: 'v2', permalink_url: `https://app.asana.com/0/p1/novo${gid}` } }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
async function preparar(): Promise<void> {
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[];
  if (!tools.includes('contas')) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, 'contas']), agente);
  h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
}
async function card(titulo: string, opts: { fora?: boolean; aprovar?: boolean } = {}): Promise<{ task: string; sessao: string; run: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  if (opts.fora) h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
  if (opts.aprovar) await req(h, 'PUT', `/api/tasks/${t.id}/approval`, s, { required: true });
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>("SELECT id, hermes_session_id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%' ORDER BY created_at DESC LIMIT 1", t.id)!;
  return { task: t.id, sessao: r.hermes_session_id, run: r.id };
}
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>) =>
  req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao: 'asana', acao, parametros }, { 'x-ergon-bridge-token': TOKEN });
type Resumo = { situacao: { tom: string; texto: string }; faixa: { titulo: string; frase: string; itens: string[]; doAgente: string | null } };
/** os cartões de ação numa conta que o card espera, como a tela os mostra (a ordem de chegada) */
const cartoesDe = (taskId: string) => h.db.all<{ id: string }>(`SELECT p.id FROM agent_proposals p JOIN runs r ON r.id = p.run_id
  WHERE r.task_id = ? AND p.kind = 'conexao' AND p.status = 'proposed' ORDER BY p.created_at`, taskId).map((x) => x.id);
const detalhe = async (taskId: string) => (await req(h, 'GET', `/api/tasks/${taskId}`, s)).json as { resumo: Resumo; log: Array<{ action: string; evidence: string | null }>; steps: Array<{ short: string }> };

const PALAVRAS = 'O faturamento cresceu em relação a setembro, puxado pelos clientes recorrentes da região sul e pela linha nova de serviços. '.repeat(8);

describe('a linha para a pessoa: sai da entrega e vira a frase da faixa', () => {
  test('"Para você decidir:" no fim (com negrito ou marcador) sai do corpo; o resto fica igual', () => {
    const doc = `# Proposta para a Acme\n\n${PALAVRAS}\n\n**Para você decidir:** aprovar a proposta de R$ 18.400 para a Acme, com entrega em 30 dias.`;
    const x = separarLinhaParaVoce(doc);
    assert.deepEqual(x.linha, { tipo: 'decidir', texto: 'aprovar a proposta de R$ 18.400 para a Acme, com entrega em 30 dias.' });
    assert.ok(!/Para você decidir/.test(x.corpo));
    assert.ok(x.corpo.startsWith('# Proposta para a Acme'));
    assert.deepEqual(separarLinhaParaVoce('Criei as 3 tarefas no Asana.\nFeito: criei no Asana as tarefas A, B e C.\n[[fim]]').linha, { tipo: 'feito', texto: 'criei no Asana as tarefas A, B e C.' });
  });
  test('"Feito: sim" no meio de um documento é conteúdo, não a linha; sem a linha, o texto volta igual', () => {
    const doc = `# Checklist\n\nFeito: sim\n\n${'Uma linha do documento.\n'.repeat(6)}Fim do documento.`;
    assert.equal(separarLinhaParaVoce(doc).linha, null);
    assert.equal(separarLinhaParaVoce(doc).corpo, doc);
    // documento que termina num quadro de status (com marcador): a linha "Feito" é conteúdo e fica no documento
    const status = `# Relatório\n\n${PALAVRAS}\n\n## Resumo\n- **Feito:** levantamento de preços com 3 fornecedores\n- **Pendente:** assinatura do contrato\n- **Próximo passo:** reunião na quinta`;
    assert.deepEqual(separarLinhaParaVoce(status), { corpo: status, linha: null });
    const obra = `# Obra\n\n${PALAVRAS}\n\n- Pendente: vistoria elétrica\n- Feito: contrato assinado com a construtora\n- Pendente: alvará`;
    assert.deepEqual(separarLinhaParaVoce(obra), { corpo: obra, linha: null });
    // só a ÚLTIMA linha com texto vale: "Feito:" logo antes do fim é do documento
    const quase = `${PALAVRAS}\nFeito: contrato assinado\nPróximo passo: alvará`;
    assert.deepEqual(separarLinhaParaVoce(quase), { corpo: quase, linha: null });
    assert.equal(separarLinhaParaVoce('- Feito: criei as tarefas A e B.').linha, null, 'com marcador de lista não é a linha para a pessoa');
  });
  test('a linha fala em enviar ou pagar e nenhum cartão espera: o aviso de que aprovar só conclui o card', () => {
    assert.equal(avisoSemCartao({ tipo: 'decidir', texto: 'aprovar o envio de 2 e-mails para Ana e Bruno' }), AVISO_SEM_CARTAO);
    assert.equal(avisoSemCartao({ tipo: 'decidir', texto: 'escolher entre o plano A e o B' }), null);
    assert.equal(avisoSemCartao({ tipo: 'feito', texto: 'enviei 2 e-mails' }), null);
  });
});

describe('etapas numa frase curta e os fatos das contas', () => {
  test('etapaCurta: a primeira oração, sem cortar palavra, em minúscula', () => {
    assert.equal(etapaCurta('Verificar as redes sociais da empresa nos últimos 30 dias, listando os comentários negativos e as reclamações'), 'verificar as redes sociais da empresa nos últimos 30 dias');
    assert.equal(etapaCurta('Calcular os dados de vendas. Depois montar a tabela.'), 'calcular os dados de vendas');
    assert.equal(etapaCurta('Revisar'), 'revisar');
    assert.equal(etapaCurta('Calcular os dados de alcance, engajamento e crescimento de seguidores por rede social'), 'calcular os dados de alcance, engajamento e crescimento de seguidores…', 'vírgula cedo é lista: corta na palavra');
    assert.equal(etapaCurta('Levantar o orçamento revisado e o novo prazo no quadro de vendas, conferindo os valores com a planilha'), 'levantar o orçamento revisado e o novo prazo no quadro de vendas');
    assert.ok(etapaCurta('Pesquisar fornecedores de embalagem biodegradável compatíveis com o processo industrial atual da fábrica').length <= 73);
  });
  test('etapaCurta: nome próprio e cliente no começo ficam como estão; o corte em ":" não deixa só o nome', () => {
    assert.equal(etapaCurta('Ana revisa o contrato com o jurídico'), 'Ana revisa o contrato com o jurídico');
    assert.equal(etapaCurta('Pedro Alves: levantar os custos'), 'Pedro Alves: levantar os custos');
    assert.equal(etapaCurta('Acme: montar a proposta comercial'), 'Acme: montar a proposta comercial');
    assert.equal(etapaCurta('Oscar revisa a planilha'), 'Oscar revisa a planilha');
    assert.equal(etapaCurta('Pôr no quadro as datas combinadas'), 'pôr no quadro as datas combinadas');
    assert.equal(etapaCurta('Levantar os custos da obra: material e mão de obra'), 'levantar os custos da obra', 'oração longa antes do ":" ainda corta');
  });
  test('a frase exata não esconde o que pesa: cópia, apagar, mover e cobrar aparecem com o verbo certo', () => {
    const cc = fatoDaAcao({ conexao: 'microsoft', acao: 'email.enviar', args: JSON.stringify({ para: 'ana@x.com', cc: 'diretoria@x.com, cliente@y.com', assunto: 'Orçamento' }), resumo: null });
    assert.equal(fraseDoPendente([cc]), 'enviar um e-mail para ana@x.com, com cópia para diretoria@x.com e cliente@y.com, sobre “Orçamento”');
    assert.deepEqual(frasesDoFeito([cc]), ['E-mail enviado para ana@x.com, com cópia para diretoria@x.com e cliente@y.com, sobre “Orçamento”.']);
    const apagar = [1, 2, 3].map((i) => fatoDaAcao({ conexao: 'microsoft', acao: 'email.apagar', args: JSON.stringify({ id: `m${i}` }), resumo: `Apagar o e-mail m${i}: ele vai para Itens Excluídos e dá para recuperar de lá` }));
    assert.equal(fraseDoPendente(apagar), 'apagar 3 e-mails');
    assert.deepEqual(frasesDoFeito(apagar), ['3 e-mails apagados.']);
    const slack = fatoDaAcao({ conexao: 'slack', acao: 'slack.apagar', args: '{}', resumo: 'Apagar a mensagem' });
    assert.match(fraseDoPendente([slack]), /^apagar uma mensagem em /);
    const mover = fatoDaAcao({ conexao: 'microsoft', acao: 'email.mover', args: JSON.stringify({ id: 'm1', pasta: 'Arquivo' }), resumo: 'Mover o e-mail m1 para a pasta "Arquivo"' });
    assert.equal(fraseDoPendente([mover, mover]), 'mover 2 e-mails para a pasta “Arquivo”');
    const cobra = fatoDaAcao({ conexao: 'asaas', acao: 'asaas.criar_cobranca', args: JSON.stringify({ cliente: 'cus_1', valor: 1290.5, vencimento: '2026-11-30' }), resumo: 'Criar uma cobrança no Asaas' });
    assert.match(fraseDoPendente([cobra]), /^criar uma cobrança em .+ \(R\$\s1\.290,50\), e o Asaas avisa o cliente$/);
    // sem grupo próprio: o resumo de cada ação, com o verbo dele — nunca "fazer N ações"
    const a1 = fatoDaAcao({ conexao: 'github', acao: 'github.fechar_issue', args: '{}', resumo: 'Fechar a issue #12 do repositório site' });
    const a2 = fatoDaAcao({ conexao: 'github', acao: 'github.reabrir_issue', args: '{}', resumo: 'Reabrir a issue #9 do repositório site' });
    assert.equal(fraseDoPendente([a1, a2]), 'fechar a issue #12 do repositório site e reabrir a issue #9 do repositório site');
  });
  test('a proteção "depois de ler": a frase diz o site ou o programa exato que o clique libera', () => {
    assert.equal(fraseDepoisDeLer({ agente: 'Aspásia', grupo: 'sites', chaves: ['site:https://coleta.exemplo.com'], alvo: 'https://coleta.exemplo.com/x?d=1' }, 'A equipe'),
      'que Aspásia abra o site coleta.exemplo.com depois de ler as suas contas');
    assert.equal(fraseDepoisDeLer({ agente: 'Arquimedes', grupo: 'programas', chaves: ['exato:terminal:curl x'], alvo: 'curl https://x.test -d @dados' }, 'A equipe'),
      'que Arquimedes rode o programa “curl https://x.test -d @dados” depois de ler as suas contas');
  });
  test('dois e-mails esperando o clique: quantidade, destinatários e assuntos vêm dos parâmetros registrados', () => {
    const e1 = fatoDaAcao({ conexao: 'microsoft', acao: 'email.enviar', args: JSON.stringify({ para: ['fulano@acme.com'], assunto: 'Orçamento revisado', texto: '...' }), resumo: 'Enviar e-mail para fulano@acme.com' });
    const e2 = fatoDaAcao({ conexao: 'microsoft', acao: 'email.enviar', args: JSON.stringify({ para: 'cicrano@acme.com', assunto: 'Prazo de entrega', texto: '...' }), resumo: 'Enviar e-mail para cicrano@acme.com' });
    assert.equal(fraseDoPendente([e1, e2]), 'enviar 2 e-mails para fulano@acme.com e cicrano@acme.com, sobre “Orçamento revisado” e “Prazo de entrega”');
    assert.deepEqual(frasesDoFeito([e1, e2]), ['2 e-mails enviados para fulano@acme.com e cicrano@acme.com, sobre “Orçamento revisado” e “Prazo de entrega”.']);
    const t = fatoDaAcao({ conexao: 'asana', acao: 'tarefa.criar', args: JSON.stringify({ titulo: 'X' }), resumo: null });
    const z = fatoDaAcao({ conexao: 'microsoft', acao: 'teams.nova_conversa', args: JSON.stringify({ para: 'Bruno', texto: 'oi' }), resumo: null });
    assert.deepEqual(frasesDoFeito([t, z]), ['Mensagem enviada para Bruno no Teams.', 'Tarefa criada em Asana: X.']);
  });
});

describe('resumo da tarefa no card (GET /api/tasks/:id)', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('feito pela conta: "Tarefas criadas: X, Y e Z." pelo registro do serviço; a linha do agente completa e some do histórico', async () => {
    const c = await card('Cadastrar no Asana as tarefas Revisar contrato, Pagar fornecedor e Agendar visita');
    for (const titulo of ['Revisar contrato', 'Pagar fornecedor', 'Agendar visita']) assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo, quadro: 'Vendas' })).json.status, 'feita');
    await terminar(c.run, 'Criei as três tarefas no quadro Vendas.\n\nFeito: criei no Asana as 3 tarefas pedidas, no quadro Vendas.');
    const d = await detalhe(c.task);
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'feito', texto: 'Feito' });
    assert.equal(d.resumo.faixa.frase, 'Tarefas criadas em Asana: Revisar contrato, Pagar fornecedor e Agendar visita.');
    assert.match(d.resumo.faixa.doAgente ?? '', /criei no Asana as 3 tarefas/);
    const saida = d.log.filter((e) => e.evidence && /"output"/.test(e.evidence)).map((e) => JSON.parse(e.evidence!).output as string);
    assert.ok(saida.length > 0 && saida.every((o) => !/Feito: criei/.test(o)), 'a linha não aparece duplicada no texto');
  });

  test('esperando o clique em 2 cartões: a frase diz exatamente o que se aprova; "Aprovar" decide os dois e o card anda uma vez só', async () => {
    const c = await card('Cadastrar no Asana as tarefas Revisar contrato e Pagar fornecedor', { fora: true });
    for (const titulo of ['Revisar contrato', 'Pagar fornecedor']) assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo, quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
    await terminar(c.run, 'Pedi a sua confirmação para criar as duas tarefas.\nPara você decidir: criar no Asana as tarefas Revisar contrato e Pagar fornecedor.');
    let d = await detalhe(c.task);
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'decidir', texto: 'Esperando sua aprovação' });
    assert.equal(d.resumo.faixa.frase, 'Aguardando sua aprovação para criar as tarefas “Revisar contrato” e “Pagar fornecedor” em Asana.');
    const antes = Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', c.task)!.n);
    const ids = cartoesDe(c.task);
    assert.equal(ids.length, 2);
    const r = await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'apply', ids });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.results.map((x: { status: string }) => x.status), ['applied', 'applied']);
    assert.equal(Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', c.task)!.n), antes + 1, 'uma execução nova, não uma por cartão');
    await tick();
    const nova = h.db.get<{ id: string; input: string }>("SELECT id, input FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", c.task)!;
    assert.match(nova.input, /Revisar contrato[\s\S]*Pagar fornecedor/, 'a execução nova sabe das duas decisões');
    await terminar(nova.id, 'As duas tarefas foram criadas depois da sua confirmação.\nFeito: criei no Asana as tarefas Revisar contrato e Pagar fornecedor.');
    d = await detalhe(c.task);
    assert.equal(d.resumo.situacao.tom, 'feito');
    assert.equal(d.resumo.faixa.frase, 'Tarefas criadas em Asana: Revisar contrato e Pagar fornecedor.');
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'apply', ids })).status, 409, 'nada mais esperando');
  });

  test('"Aprovar (N)" decide só os cartões que a tela mostrou: chegou outro depois da leitura, nada sai e a tela relê', async () => {
    const c = await card('Cadastrar no Asana as tarefas Revisar contrato e Pagar fornecedor', { fora: true });
    for (const titulo of ['Revisar contrato', 'Pagar fornecedor']) assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo, quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
    const vistos = cartoesDe(c.task); // o que a pessoa leu na tela
    // a execução ainda roda e pede uma 3ª ação entre a leitura e o clique
    assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo: 'Agendar visita', quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
    const r = await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'apply', ids: vistos });
    assert.equal(r.status, 409);
    assert.equal(r.json.error ?? r.json.code, 'mudou', JSON.stringify(r.json));
    assert.equal(cartoesDe(c.task).length, 3, 'nenhum cartão foi decidido');
    assert.equal(Number(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conexao_acoes WHERE task_id = ? AND status = 'feita'", c.task)!.n), 0, 'nada saiu pela conta');
    // todos decididos noutro lugar (a conversa, "Aguardando você"): não diz "Aprovado (0)"
    const todos = cartoesDe(c.task);
    for (const id of todos) assert.equal((await req(h, 'POST', `/api/proposals/${id}`, s, { decision: 'reject' })).status, 200);
    const tarde = await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'apply', ids: todos });
    assert.equal(tarde.status, 409);
    assert.equal(tarde.json.error ?? tarde.json.code, 'decided');
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'apply' })).status, 400, 'sem a lista do que foi visto, nada é decidido');
  });

  test('a proteção "depois de ler" fica fora do lote: a faixa a mostra à parte, com o site exato, e "Aprovar (N)" não a decide', async () => {
    const c = await card('Cadastrar no Asana a tarefa Revisar contrato', { fora: true });
    assert.equal((await executar(c.sessao, 'tarefa.criar', { titulo: 'Revisar contrato', quadro: 'Vendas' })).json.status, 'aguardando_confirmacao');
    const nome = h.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agente)!.name;
    h.db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at) VALUES ('apr_leitura1', ?, NULL, ?, 'depois_de_ler', ?, 'abrir um site', 'proposed', ?)`,
      s.workspaceId, c.run, JSON.stringify({ kind: 'depois_de_ler', agente: nome, grupo: 'sites', escopo: `task:${c.task}`, chaves: ['site:https://coleta.exemplo.com'], ferramenta: 'browser_navigate', alvo: 'https://coleta.exemplo.com/x' }), new Date().toISOString());
    const d = await detalhe(c.task);
    assert.equal(d.resumo.faixa.frase, 'Aguardando sua aprovação para criar a tarefa “Revisar contrato” em Asana.');
    assert.ok(d.resumo.faixa.itens.some((x) => x === `À parte, decida no cartão abaixo: Que ${nome} abra o site coleta.exemplo.com depois de ler as suas contas.`), JSON.stringify(d.resumo.faixa));
    const ids = cartoesDe(c.task);
    assert.equal(ids.length, 1, 'o lote é só a ação na conta');
    const r = await req(h, 'POST', `/api/tasks/${c.task}/cartoes`, s, { decision: 'reject', ids });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM agent_proposals WHERE id = 'apr_leitura1'")!.status, 'proposed', 'a liberação do site continua esperando a sua decisão');
  });

  test('card que conclui sozinho com "Para você decidir": a escolha não vira "o que foi feito"', async () => {
    const c = await card('Comparar os planos A e B de internet para o escritório');
    await terminar(c.run, `${PALAVRAS}\n\nPara você decidir: escolher entre o plano A (R$ 50) e o B (R$ 80).`);
    const d = await detalhe(c.task);
    assert.equal(h.db.get<{ completed: number }>('SELECT completed FROM tasks WHERE id = ?', c.task)!.completed, 1, JSON.stringify(d.resumo));
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'feito', texto: 'Feito' });
    assert.doesNotMatch(d.resumo.faixa.frase, /plano A/);
    assert.ok(d.resumo.faixa.itens.includes('Ficou para você decidir: escolher entre o plano A (R$ 50) e o B (R$ 80).'), JSON.stringify(d.resumo.faixa));
    assert.equal(d.resumo.faixa.doAgente, null);
  });

  test('"Pronto." seguido de uma linha "Feito:" longa continua sendo só uma declaração: não conclui o card', async () => {
    const c = await card('Responder sobre os prazos de entrega dos fornecedores Delta e Alfa');
    await terminar(c.run, 'Pronto.\nFeito: respondi a pergunta sobre os prazos de entrega dos fornecedores Delta e Alfa, com as datas de cada pedido e a recomendação de qual priorizar.');
    const t = h.db.get<{ completed: number; work_state: string }>('SELECT completed, work_state FROM tasks WHERE id = ?', c.task)!;
    assert.equal(t.completed, 0);
    const crit = JSON.parse(h.db.get<{ criteria: string }>('SELECT criteria FROM task_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', c.task)!.criteria) as Array<{ id: string; ok: boolean }>;
    assert.equal(crit.find((x) => x.id === 'alegacao')?.ok, false, JSON.stringify(crit));
    assert.equal(crit.find((x) => x.id === 'conteudo')?.ok, false);
  });

  test('documento esperando a sua aprovação: a frase vem do documento entregue; a linha do agente vai abaixo, com o nome dele, e não vai para o arquivo', async () => {
    const c = await card('Escrever o relatório de vendas de outubro para a diretoria', { aprovar: true });
    await terminar(c.run, `Segue o relatório.\n# Relatório de vendas — outubro\n\n${PALAVRAS}\n\nPara você decidir: aprovar o relatório de outubro com as 3 recomendações para a diretoria.`);
    const d = await detalhe(c.task);
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'decidir', texto: 'Esperando sua aprovação' });
    assert.match(d.resumo.faixa.frase, /^Aguardando sua aprovação do documento “Relatório de vendas — outubro”, entregue por .+\.$/);
    assert.match(d.resumo.faixa.doAgente ?? '', /: aprovar o relatório de outubro com as 3 recomendações para a diretoria\.$/);
    assert.ok(!d.resumo.faixa.itens.includes(AVISO_SEM_CARTAO), 'aprovar um relatório não promete envio');
    const art = h.db.get<{ artifact_id: string }>("SELECT artifact_id FROM task_artifacts WHERE task_id = ? AND role = 'entregavel'", c.task)!;
    const arquivo = await req(h, 'GET', `/api/artifacts/${art.artifact_id}/download`, s);
    assert.match(arquivo.res.body, /^# Relatório de vendas — outubro/);
    assert.ok(!/Para você decidir/.test(arquivo.res.body), 'o documento sai sem a linha');
  });

  test('a linha fala em enviar e-mails, mas nenhum cartão espera: a frase não promete o envio, e o aviso diz que aprovar só conclui', async () => {
    const c = await card('Redigir os e-mails do orçamento para Ana e Bruno', { aprovar: true });
    await terminar(c.run, `# E-mails do orçamento\n\n${PALAVRAS}\n\nPara você decidir: aprovar o envio de 2 e-mails para Ana e Bruno com o orçamento revisado.`);
    const d = await detalhe(c.task);
    assert.equal(d.resumo.situacao.tom, 'decidir');
    assert.doesNotMatch(d.resumo.faixa.frase, /envio/, 'a frase principal sai dos fatos');
    assert.ok(d.resumo.faixa.itens.includes(AVISO_SEM_CARTAO), JSON.stringify(d.resumo.faixa));
    assert.match(d.resumo.faixa.doAgente ?? '', /aprovar o envio de 2 e-mails/);
  });

  test('na conversa, o pedido de aprovação diz o que se aprova (a linha do agente), sem repeti-la no trecho', async () => {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
    const c = await card('Escrever o relatório de vendas de outubro para a diretoria', { aprovar: true });
    h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, c.task);
    await terminar(c.run, `# Relatório de vendas — outubro\n\n${PALAVRAS}\n\nPara você decidir: aprovar o relatório de outubro com as 3 recomendações para a diretoria.`);
    const msg = h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY created_at", conv).map((m) => m.content).join('\n');
    assert.match(msg, /precisa da sua aprovação\. Para você decidir: aprovar o relatório de outubro com as 3 recomendações para a diretoria\./, msg);
    const p = h.db.get<{ payload: string }>("SELECT payload FROM agent_proposals WHERE conversation_id = ? AND kind = 'info_request' AND status = 'proposed'", conv)!;
    const excerpt = (JSON.parse(p.payload) as { excerpt: string | null }).excerpt ?? '';
    assert.match(excerpt, /^# Relatório de vendas — outubro/);
    assert.doesNotMatch(excerpt, /Para você decidir/, 'a linha não aparece duas vezes');
    // quem entrega na conversa recebe a entrega com a linha (nada some)
    const { cardOutput } = await import('../src/services/purpose.ts');
    assert.match(cardOutput(h.db, c.task), /Para você decidir: aprovar o relatório/);
  });

  test('sem a linha do agente, a frase vem só dos fatos (documento entregue, por quem)', async () => {
    const c = await card('Escrever o relatório de vendas de outubro para a diretoria', { aprovar: true });
    await terminar(c.run, `# Relatório de vendas — outubro\n\n${PALAVRAS}`);
    const d = await detalhe(c.task);
    assert.match(d.resumo.faixa.frase, /^Aguardando sua aprovação do documento “Relatório de vendas — outubro”, entregue por .+\.$/);
    assert.equal(d.resumo.faixa.doAgente, null);
  });

  test('trabalhando agora, e a instrução de entrega pede a linha para a pessoa', async () => {
    const c = await card('Escrever o relatório de vendas de outubro para a diretoria');
    const d = await detalhe(c.task);
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'trabalhando', texto: 'Trabalhando' });
    assert.match(d.resumo.faixa.frase, /está trabalhando nisto agora\.$/);
    assert.match(h.db.get<{ input: string }>('SELECT input FROM runs WHERE id = ?', c.run)!.input, /"Para você decidir: …"[\s\S]*"Feito: …"/);
  });

  test('não foi feito: a frase diz o motivo, sem o jargão da conferência', async () => {
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
    const c = await card('Enviar e-mail ao fornecedor Delta pedindo o orçamento revisado');
    await terminar(c.run, 'Preparei o e-mail para a Delta, pronto para você enviar.');
    const d = await detalhe(c.task);
    assert.deepEqual({ tom: d.resumo.situacao.tom, texto: d.resumo.situacao.texto }, { tom: 'falhou', texto: 'Não foi feito' });
    assert.match(d.resumo.faixa.frase, /^Não foi feito: .*não chegou a usar a conexão/);
    assert.ok(!/O card fica aberto/.test(d.resumo.faixa.frase));
  });
});

describe('prévia de arquivo dentro do card', () => {
  beforeEach(() => preparar());
  afterEach(() => h.close());

  test('PDF com ?inline=1 abre dentro da própria tela (mesma origem); o resto continua sem moldura', async () => {
    const pdf = (await req(h, 'POST', '/api/artifacts', s, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'), { 'content-type': 'application/octet-stream', 'x-filename': 'contrato.pdf', 'x-file-type': 'application/pdf' })).json;
    const r = await req(h, 'GET', `/api/artifacts/${pdf.id}/download?inline=1`, s);
    assert.equal(r.status, 200);
    assert.equal(r.res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(String(r.res.headers['content-security-policy']), /frame-ancestors 'self'/);
    assert.doesNotMatch(String(r.res.headers['content-security-policy']), /script-src/);
    const baixar = await req(h, 'GET', `/api/artifacts/${pdf.id}/download`, s);
    assert.equal(baixar.res.headers['x-frame-options'], 'DENY');
    assert.match(String(baixar.res.headers['content-disposition']), /^attachment/);
    const outra = await req(h, 'GET', '/api/limits', s);
    assert.equal(outra.res.headers['x-frame-options'], 'DENY');
    assert.match(String(outra.res.headers['content-security-policy']), /frame-ancestors 'none'/);
  });
});
