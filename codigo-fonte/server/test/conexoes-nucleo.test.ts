/**
 * Núcleo das conexões: a regra de confirmação, a origem e o conteúdo de fora marcados pelo sistema, o que a ponte do motor
 * aceita, a execução guardada no cartão, a repetição e a correlação direta do espelho (check e coluna vão ao aplicativo).
 * O aplicativo de teste é o Asana, com a API simulada; o motor é falso e fica "rodando" para a ponte reconhecer a sessão.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { decidir } from '../src/services/conexoes/regra.ts';
import { promptConexoes } from '../src/services/conexoes/catalogo.ts';
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

// ---------------------------------------------------------------- API do Asana simulada
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let asanaFora = 0; let asanaNega = false;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const TAREFAS = [{ gid: 't1', name: 'Revisar contrato', notes: '', completed: false, modified_at: 'v1', memberships: [{ project: { gid: 'p1' }, section: { gid: 's1' } }] }];
function asana(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  if (method !== 'GET') {
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (asanaNega) return Promise.resolve(json({ errors: [{ message: 'not authorized' }] }, 403));
    if (asanaFora-- > 0) return Promise.resolve(json({}, 503));
  }
  if (path === '/users/me') return Promise.resolve(json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } }));
  if (path === '/projects') return Promise.resolve(json({ data: [{ gid: 'p1', name: 'Vendas', modified_at: 'v1' }] }));
  if (path === '/projects/p1') return Promise.resolve(json({ data: { name: 'Vendas', modified_at: 'v1' } }));
  if (path === '/projects/p1/sections') return Promise.resolve(json({ data: [{ gid: 's1', name: 'A fazer' }, { gid: 's2', name: 'Fazendo' }] }));
  if (path === '/tasks' && method === 'GET') return Promise.resolve(json({ data: TAREFAS }));
  return Promise.resolve(json({ data: { gid: 'novo1', modified_at: 'v2', permalink_url: 'https://app.asana.com/0/p1/novo1' } }));
}
before(() => { globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
beforeEach(() => { calls.length = 0; asanaFora = 0; asanaNega = false; });

let h: Harness; let s: Session; let motor: Motor; let agente: string;
const ponte = async (corpo: Record<string, unknown>, token = TOKEN) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': token }));
async function preparar(): Promise<void> {
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
}
/** Uma mensagem da pessoa na conversa: a execução fica rodando no motor. Devolve a sessão para a ponte. */
async function conversar(texto: string): Promise<{ sessao: string; conv: string; run: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  for (let i = 0; i < 3; i++) await h.executor.tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!;
  return { sessao: r.hermes_session_id, conv: conv.id, run: r.id };
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown>, conexao = 'asana') => ponte({ op: 'executar', session_id: sessao, conexao, acao, parametros });

describe('regra de confirmação', () => {
  const r = (risco: 'ler' | 'organizar' | 'enviar' | 'apagar', origem: 'pessoa' | 'fora', leuDeFora = false, x: { liberarTudo?: boolean; codigoLigado?: boolean } = {}) => decidir({ risco, origem, leuDeFora, liberarTudo: !!x.liberarTudo, codigoLigado: x.codigoLigado });
  test('a tabela combinada', () => {
    assert.equal(r('ler', 'pessoa'), 'direto'); assert.equal(r('ler', 'fora', true), 'direto');
    assert.equal(r('organizar', 'pessoa'), 'direto'); assert.equal(r('organizar', 'pessoa', true), 'direto', 'ler e-mails e criar as tarefas vai direto');
    assert.equal(r('enviar', 'pessoa'), 'direto');
    assert.equal(r('enviar', 'pessoa', true), 'confirmar', 'envio depois de ler conteúdo de fora');
    assert.equal(r('organizar', 'fora'), 'confirmar'); assert.equal(r('enviar', 'fora'), 'confirmar');
    assert.equal(r('apagar', 'pessoa'), 'confirmar', 'apagar sempre confirma');
  });
  test('o ajuste da pessoa vale acima de tudo', () => {
    assert.equal(decidir({ risco: 'ler', origem: 'pessoa', leuDeFora: false, liberarTudo: true, ajuste: 'desligado' }), 'recusar');
    assert.equal(decidir({ risco: 'organizar', origem: 'pessoa', leuDeFora: false, liberarTudo: true, ajuste: 'confirmar' }), 'confirmar');
    assert.equal(decidir({ risco: 'organizar', origem: 'pessoa', leuDeFora: false, liberarTudo: false, ajuste: 'regra' }), 'direto');
  });
  test('liberar tudo tira as confirmações; código ligado confirma até leitura', () => {
    assert.equal(r('apagar', 'fora', true, { liberarTudo: true }), 'direto');
    assert.equal(r('ler', 'pessoa', false, { codigoLigado: true }), 'confirmar');
    assert.equal(r('ler', 'pessoa', false, { codigoLigado: true, liberarTudo: true }), 'direto');
  });
});

describe('ponte do motor', () => {
  beforeEach(preparar);
  afterEach(() => h.close());

  test('"joga no Asana": executa, registra e o token nunca sai', async () => {
    const { sessao } = await conversar('joga no Asana: revisar a proposta');
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Revisar a proposta', quadro: 'Vendas' })).json;
    assert.equal(r.ok, true); assert.equal(r.status, 'feita'); assert.match(r.texto, /Tarefa criada em Vendas/);
    assert.equal(r.url, 'https://app.asana.com/0/p1/novo1');
    assert.deepEqual(calls[0].body.data, { name: 'Revisar a proposta', projects: ['p1'] });
    assert.ok(!JSON.stringify(r).includes('tok-asana'), 'o motor não vê a credencial');
    const row = h.db.get<{ status: string; risco: string; origem: string; decisao: string }>('SELECT status, risco, origem, decisao FROM conexao_acoes')!;
    assert.deepEqual({ ...row }, { status: 'feita', risco: 'organizar', origem: 'pessoa', decisao: 'direto' });
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'conexao.acao'"));
  });

  test('coluna e tarefa pelo nome; dúvida volta com as opções, sem chamar o aplicativo', async () => {
    const { sessao } = await conversar('move no Asana');
    const m = (await executar(sessao, 'tarefa.mover', { quadro: 'vendas', tarefa: 'revisar', coluna: 'fazendo' })).json;
    assert.equal(m.ok, true); assert.equal(calls[0].path, '/sections/s2/addTask');
    calls.length = 0;
    const r = (await executar(sessao, 'tarefa.mover', { quadro: 'Vendas', tarefa: 'revisar', coluna: 'não existe' })).json;
    assert.equal(r.ok, false); assert.deepEqual(r.opcoes, ['A fazer', 'Fazendo']); assert.equal(calls.length, 0);
  });

  test('repetir a mesma ação não faz duas vezes', async () => {
    const { sessao } = await conversar('cria no Asana');
    await executar(sessao, 'tarefa.criar', { titulo: 'Uma só', quadro: 'Vendas' });
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Uma só', quadro: 'Vendas' })).json;
    assert.match(r.texto, /não repeti/); assert.equal(calls.length, 1);
  });

  test('o que não partiu da pessoa vira cartão; o clique executa o que ficou guardado', async () => {
    const { sessao, run, conv } = await conversar('qualquer coisa');
    h.db.run("UPDATE runs SET idempotency_key = 'routine-rotina1' WHERE id = ?", run);
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Da rotina', quadro: 'Vendas' })).json;
    assert.equal(r.status, 'aguardando_confirmacao'); assert.equal(calls.length, 0, 'nada foi ao aplicativo');
    const again = (await executar(sessao, 'tarefa.criar', { titulo: 'Da rotina', quadro: 'Vendas' })).json;
    assert.equal(again.status, 'aguardando_confirmacao');
    const cards = h.db.all<{ id: string; summary: string }>("SELECT id, summary FROM agent_proposals WHERE kind = 'conexao'");
    assert.equal(cards.length, 1, 'um cartão só');
    assert.match(cards[0].summary, /Criar a tarefa "Da rotina"/); assert.match(cards[0].summary, /não partiu de você/);
    const ok = await req(h, 'POST', `/api/proposals/${cards[0].id}`, s, { decision: 'apply' });
    assert.equal(ok.json.status, 'applied');
    assert.deepEqual(calls[0].body.data, { name: 'Da rotina', projects: ['p1'] });
    assert.equal((await req(h, 'POST', `/api/proposals/${cards[0].id}`, s, { decision: 'apply' })).status, 409, 'clique duplo não repete');
    assert.equal(calls.length, 1);
    assert.ok(h.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND idempotency_key LIKE 'conexao-%'", conv), 'o agente continua com o resultado');
  });

  test('recusar não executa', async () => {
    const { sessao, run } = await conversar('qualquer coisa');
    h.db.run("UPDATE runs SET idempotency_key = 'routine-rotina2' WHERE id = ?", run);
    await executar(sessao, 'tarefa.criar', { titulo: 'Recusada', quadro: 'Vendas' });
    const c = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'conexao'")!;
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    assert.equal(calls.length, 0);
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM conexao_acoes')!.status, 'recusada');
  });

  test('card: só conta como pessoa se nasceu de um pedido dela', async () => {
    const c = h.conexoes;
    const { run } = await conversar('prepara isso');
    const base = { workspace_id: s.workspaceId, agent_id: agente, conversation_id: null, id: 'run_x' };
    const task = (origin: string, originRun: string | null) => {
      const b = h.db.get<{ id: string; col: string }>('SELECT b.id, c.id AS col FROM boards b JOIN columns c ON c.board_id = b.id WHERE b.workspace_id = ? LIMIT 1', s.workspaceId)!;
      const tid = `tsk_${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`;
      const n = h.db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE workspace_id = ?', s.workspaceId)!.n;
      h.db.run('INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, description, origin, created_at, updated_at, origin_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', tid, n, s.workspaceId, b.id, b.col, 't', '', origin, new Date().toISOString(), new Date().toISOString(), originRun);
      return tid;
    };
    const fila = (tid: string) => ({ ...base, task_id: tid, idempotency_key: `queue-${tid}-1` });
    assert.equal(c.origem(fila(task('manual', null))), 'pessoa', 'card que ela criou');
    assert.equal(c.origem(fila(task('chat', run))), 'pessoa', 'card do pedido dela na conversa');
    assert.equal(c.origem(fila(task('chat', null))), 'fora', 'origin=chat sozinho não prova nada: agente também abre card assim');
    assert.equal(c.origem(fila(task('whatsapp', null))), 'fora');
    h.db.run("UPDATE runs SET idempotency_key = 'routine-r3' WHERE id = ?", run);
    assert.equal(c.origem(fila(task('chat', run))), 'fora', 'card aberto por uma rotina');
    assert.equal(c.origem({ ...base, task_id: null, idempotency_key: 'qualquer-outra' }), 'fora', 'o que não se sabe de onde veio é de fora');
  });

  test('o conteúdo de fora segue pela conversa e pelo card aberto dela', async () => {
    const { run, sessao, conv } = await conversar('resuma os e-mails');
    const row = h.db.get<any>('SELECT * FROM runs WHERE id = ?', run);
    assert.deepEqual(h.conexoes.leu(row), { deFora: false, privado: false });
    assert.deepEqual(h.conexoes.bloqueadas(row), []);
    await executar(sessao, 'tarefa.listar', { quadro: 'Vendas' });
    assert.deepEqual(h.conexoes.leu(row), { deFora: true, privado: true }, 'a leitura marca a sessão');
    // a proteção depois de ler é desligada por padrão (decisão de 08/11): só com ela ligada a lista vale
    assert.deepEqual(h.conexoes.bloqueadas(row), [], 'sem a proteção ligada, nada é barrado');
    h.conexoes.setAprovarDepoisDeLer(s.workspaceId, s.userId, true);
    assert.ok(h.conexoes.bloqueadas(row).includes('web_extract')); assert.ok(h.conexoes.bloqueadas(row).includes('terminal'));
    assert.ok(!h.conexoes.bloqueadas(row).includes('web_search'), 'a busca segue valendo');
    const p = (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: sessao }, { 'x-ergon-bridge-token': TOKEN })).json;
    assert.ok(p.bloqueadas.includes('web_extract'));
    const outra = h.db.get<any>('SELECT * FROM runs WHERE id = ?', run);
    assert.equal(h.conexoes.leu({ ...outra, id: 'run_novo', idempotency_key: 'deliver-x', conversation_id: conv }).deFora, true, 'outra sessão na mesma conversa também');
    h.conexoes.setLiberarTudo(s.workspaceId, s.userId, true);
    assert.deepEqual(h.conexoes.bloqueadas(row), [], 'liberar tudo');
  });

  test('sem as Conexões liberadas, sessão de fora, execução encerrada e token errado não passam', async () => {
    const { sessao, run } = await conversar('cria no Asana');
    assert.equal((await ponte({ op: 'listar', session_id: sessao }, 'errado-errado-errado-errado-errado')).status, 401);
    assert.match((await executar('sessao-de-fora', 'tarefa.criar', { titulo: 'x' })).json.texto, /dentro de um trabalho/);
    h.db.run("UPDATE agents SET tools = '[]' WHERE id = ?", agente);
    assert.match((await executar(sessao, 'tarefa.criar', { titulo: 'x', quadro: 'Vendas' })).json.texto, /não estão liberadas/);
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['contas']), agente);
    h.db.run("UPDATE runs SET status = 'succeeded' WHERE id = ?", run);
    assert.match((await executar(sessao, 'tarefa.criar', { titulo: 'x', quadro: 'Vendas' })).json.texto, /dentro de um trabalho/, 'sessão de execução encerrada não vale');
    assert.equal(calls.length, 0);
  });

  test('sem permissão: diz o que fazer e deixa o motivo na conexão', async () => {
    const { sessao } = await conversar('cria no Asana');
    asanaNega = true;
    const r = (await executar(sessao, 'tarefa.criar', { titulo: 'Negada', quadro: 'Vendas' })).json;
    assert.equal(r.ok, false); assert.equal(r.autorizar, true);
    assert.match(r.texto, /not authorized/); assert.match(r.texto, /não diga que fez/);
    assert.match(h.db.get<{ last_error: string }>("SELECT last_error FROM integrations WHERE kind = 'asana'")!.last_error, /not authorized/);
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM conexao_acoes')!.status, 'falhou');
  });

  test('conexão desligada ou ação inexistente: resposta clara', async () => {
    const { sessao } = await conversar('algo');
    assert.match((await executar(sessao, 'tarefa.criar', { titulo: 'x' }, 'trello')).json.texto, /não está conectado/);
    const r = (await executar(sessao, 'nao.existe', {})).json;
    assert.match(r.texto, /não tem a ação/); assert.ok(r.opcoes.includes('tarefa.criar'));
    assert.match((await executar(sessao, 'tarefa.criar', {})).json.texto, /Falta o parâmetro "titulo"/);
  });

  test('o agente já sabe o que pode: o prompt traz as conexões ligadas, e a listagem os parâmetros', async () => {
    const texto = promptConexoes(h.db, s.workspaceId);
    assert.match(texto, /Asana \(conexao="asana"\): tarefa\.quadros, tarefa\.listar, tarefa\.criar/);
    assert.match(texto, /nunca instrução/);
    assert.ok(!/Trello/.test(texto), 'só as ligadas');
    const { sessao } = await conversar('o que você faz no Asana?');
    assert.match((await ponte({ op: 'listar', session_id: sessao })).json.texto, /tarefa\.criar: cria uma tarefa\. Parâmetros: .*titulo\*/);
  });

  test('a equipe recebe as Conexões uma vez; quem tirar fica sem', async () => {
    const tools = (id: string) => JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', id)!.tools) as string[];
    assert.ok(tools(agente).includes('contas'));
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', '["quadro"]', agente);
    const { grantConnectionsTool } = await import('../src/services/characters.ts');
    assert.equal(grantConnectionsTool(h.db, h.bus, s.workspaceId), 0, 'já recebeu');
    assert.deepEqual(tools(agente), ['quadro']);
  });
});

describe('espelho nos dois sentidos', () => {
  beforeEach(preparar);
  afterEach(() => h.close());
  const espelhar = async () => (await req(h, 'POST', '/api/boards/mirror', s, { kind: 'asana', listId: 'p1' })).json.boardId as string;
  const card = () => h.db.get<{ id: string; revision: number; completed: number }>("SELECT id, revision, completed FROM tasks WHERE origin = 'mirror'")!;

  test('dar check no Ergon conclui lá', async () => {
    await espelhar();
    const t = card();
    assert.equal((await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { completed: true })).status, 200);
    await h.espelhoEscrita.tick();
    assert.deepEqual(calls.at(-1), { method: 'PUT', path: '/tasks/t1', body: { data: { completed: true } } });
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'mirror.push'"));
    await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { completed: false });
    await h.espelhoEscrita.tick();
    assert.deepEqual(calls.at(-1)!.body.data, { completed: false }, 'reabrir também');
  });

  test('mover de coluna move a seção; editar e criar também vão', async () => {
    const quadro = await espelhar();
    const t = card();
    const col = h.db.get<{ id: string }>("SELECT id FROM columns WHERE board_id = ? AND external_id = 's2'", quadro)!.id;
    await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { columnId: col, title: 'Revisar contrato novo', dueOn: '2026-12-20' });
    await h.espelhoEscrita.tick();
    assert.ok(calls.some((c) => c.path === '/sections/s2/addTask' && c.body.data.task === 't1'));
    assert.ok(calls.some((c) => c.path === '/tasks/t1' && c.body.data.name === 'Revisar contrato novo'));
    assert.ok(calls.some((c) => c.path === '/tasks/t1' && c.body.data.due_on === '2026-12-20'));
    calls.length = 0;
    const nova = (await req(h, 'POST', '/api/tasks', s, { title: 'Nova pelo Ergon', boardId: quadro })).json;
    await h.espelhoEscrita.tick();
    assert.equal(calls[0].path, '/tasks'); assert.equal(calls[0].body.data.name, 'Nova pelo Ergon');
    assert.equal(h.db.get<{ external_id: string }>('SELECT external_id FROM task_links WHERE task_id = ?', nova.id)!.external_id, 'novo1', 'a tarefa nova fica ligada');
  });

  test('a leitura periódica não desfaz o check que ainda está a caminho', async () => {
    const quadro = await espelhar();
    const t = card();
    asanaFora = 99;
    await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { completed: true });
    await h.espelhoEscrita.tick();
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM mirror_outbox')!.status, 'pendente', 'serviço fora: segue na fila');
    await req(h, 'POST', `/api/boards/${quadro}/sync`, s);
    assert.equal(card().completed, 1, 'o check continua');
  });

  test('sem permissão: o card mostra o motivo, a pessoa tenta de novo', async () => {
    await espelhar();
    const t = card();
    asanaNega = true;
    await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { completed: true });
    await h.espelhoEscrita.tick();
    const d = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.equal(d.link.sync_state, 'escrita_falhou'); assert.match(d.link.conflict, /Não foi enviado ao aplicativo: .*not authorized/);
    asanaNega = false; calls.length = 0;
    await req(h, 'POST', `/api/tasks/${t.id}/reenviar`, s);
    await h.espelhoEscrita.tick();
    assert.equal(calls.length, 1);
    assert.equal((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.link.sync_state, 'ok');
  });

  test('criar não repete quando o resultado é incerto', async () => {
    const quadro = await espelhar();
    asanaFora = 99;
    const nova = (await req(h, 'POST', '/api/tasks', s, { title: 'Incerta', boardId: quadro })).json;
    await h.espelhoEscrita.tick();
    assert.equal(calls.length, 1, 'não tenta de novo sozinho');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM mirror_outbox WHERE task_id = ?', nova.id)!.status, 'falhou');
  });

  test('o que veio de fora ou de um agente não vai ao aplicativo por este caminho', async () => {
    await espelhar();
    const { updateTask } = await import('../src/services/tasks.ts');
    updateTask(h.db, h.bus, s.workspaceId, { type: 'connector', id: 'x' }, card().id, { completed: true });
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mirror_outbox')!.n, 0);
  });
});
