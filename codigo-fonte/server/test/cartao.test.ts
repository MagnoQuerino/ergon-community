/**
 * O que vai dentro do cartão das tarefas da pessoa (rc.41): campos próprios por quadro (texto, número, data, lista de
 * opções, etiquetas, pessoa) com valores conferidos pelo tipo; subtarefas; links (só http/https); pessoas do
 * workspace; comentários de pessoas e de agentes (240 caracteres); anexos de Documentos. O quadro da equipe não muda;
 * no quadro espelhado tudo fica só no Ergon; outro workspace não alcança nada disto.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { decide, interpretRules, validateInterpretation } from '../src/services/interpret.ts';
import { applyDecision } from '../src/services/actions.ts';
import { findConnection } from '../src/services/ingest.ts';
import { importBoards } from '../src/services/mirror.ts';
import { FixtureTaskProvider } from './mirror-fixture.ts';
import { addPerson, FIXTURES, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>(); n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) { const runId = `run_teste${String(++this.n).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

describe('o cartão das tarefas da pessoa', () => {
  let h: Harness; let s: Session; let bruna: Session; let quadro = ''; let colunas: Array<{ id: string; name: string }> = []; let tarefa = '';
  before(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h, 'ana', 'senha-da-ana-123');
    bruna = await addPerson(h, 'bruna', 'senha-bruna-123', 'Bruna');
    const b = (await req(h, 'POST', '/api/boards', s, { name: 'Clientes', columns: ['Contato', 'Proposta', 'Fechado'] })).json;
    quadro = b.id; colunas = b.columns;
    tarefa = (await req(h, 'POST', '/api/tasks', s, { title: 'Proposta para a ACME', boardId: quadro, columnId: colunas[0].id })).json.id;
  });
  after(async () => { await h.close(); });

  const ver = async (b = quadro, quem = s) => (await req(h, 'GET', `/api/boards/${b}`, quem)).json as { fields: Array<{ id: string; name: string; type: string; showOnCard: boolean; options: Array<{ id: string; name: string; color: string }> }>;
    tasks: Array<{ id: string; card: null | { sub: [number, number] | null; comments: number; links: number; files: number; people: Array<{ id: string; name: string }>; values: Record<string, unknown> } }> };
  const cartao = async (t = tarefa, quem = s) => (await req(h, 'GET', `/api/tasks/${t}/card`, quem)).json;
  const campo = async (corpo: Record<string, unknown>, b = quadro) => req(h, 'POST', `/api/boards/${b}/fields`, s, corpo);
  const valor = (c: string, value: unknown, t = tarefa) => req(h, 'PUT', `/api/tasks/${t}/fields/${c}`, s, { value });

  const ids: Record<string, string> = {}; let opcoes: Array<{ id: string; name: string; color: string }> = []; let etiquetas: Array<{ id: string; name: string; color: string }> = [];
  test('campos: os seis tipos; nome obrigatório e sem repetir; opções com cor da paleta; editar, reordenar e apagar', async () => {
    for (const [nome, type] of [['Contato', 'text'], ['Valor', 'number'], ['Visita', 'date'], ['Dono', 'person']] as const) {
      const r = await campo({ name: nome, type }); assert.equal(r.status, 201, JSON.stringify(r.json)); ids[type] = r.json.id;
    }
    const sel = await campo({ name: 'Estágio', type: 'select', options: [{ name: 'Frio', color: 'info' }, { name: 'Quente', color: 'perigo' }] });
    assert.equal(sel.status, 201); ids.select = sel.json.id; opcoes = sel.json.options;
    assert.deepEqual(opcoes.map((o) => [o.name, o.color, /^opt_[a-f0-9]{32}$/.test(o.id)]), [['Frio', 'info', true], ['Quente', 'perigo', true]]);
    const et = await campo({ name: 'Etiquetas', type: 'labels', options: [{ name: 'Urgente', color: 'urgente' }, { name: 'VIP', color: 'dourado' }, { name: 'Novo' }] });
    ids.labels = et.json.id; etiquetas = et.json.options;
    assert.deepEqual([et.json.showOnCard, etiquetas[2].color], [true, 'neutro'], 'etiquetas aparecem sempre no cartão; sem cor escolhida, a neutra');
    assert.equal((await campo({ name: '  ', type: 'text' })).status, 400);
    assert.equal((await campo({ name: 'contato', type: 'text' })).status, 409, 'nome repetido (sem olhar maiúsculas)');
    assert.equal((await campo({ name: 'Outro', type: 'cor' })).status, 400, 'tipo fora da lista');
    assert.equal((await campo({ name: 'Outro', type: 'select', options: [{ name: 'A', color: '#ff0000' }] })).status, 400, 'cor fora da paleta');
    assert.equal((await campo({ name: 'Outro', type: 'select', options: [{ name: 'A' }, { name: 'a' }] })).status, 400, 'opção repetida');
    // no banco, o nome e as opções ficam cifrados (quando há cofre); a leitura devolve abertos
    assert.deepEqual((await ver()).fields.map((f) => f.name), ['Contato', 'Valor', 'Visita', 'Dono', 'Estágio', 'Etiquetas']);
    // editar: renomear a opção guarda o id (os cards não perdem a escolha); reordenar; mostrar no cartão até 2
    const ed = await req(h, 'PATCH', `/api/fields/${ids.select}`, s, { name: 'Temperatura', position: 0, options: [{ id: opcoes[0].id, name: 'Gelado', color: 'agua' }, { id: opcoes[1].id, name: 'Quente', color: 'perigo' }, { name: 'Morno', color: 'atencao' }] });
    assert.equal(ed.status, 200, JSON.stringify(ed.json));
    assert.deepEqual(ed.json.options.map((o: { id: string; name: string }) => [o.id === opcoes[0].id || o.id === opcoes[1].id, o.name]), [[true, 'Gelado'], [true, 'Quente'], [false, 'Morno']]);
    opcoes = ed.json.options;
    assert.equal((await ver()).fields[0].name, 'Temperatura');
    assert.equal((await req(h, 'PATCH', `/api/fields/${ids.text}`, s, { options: [] })).status, 400, 'texto não tem opções');
    assert.equal((await req(h, 'PATCH', `/api/fields/${ids.number}`, s, { showOnCard: true })).status, 200);
    assert.equal((await req(h, 'PATCH', `/api/fields/${ids.date}`, s, { showOnCard: true })).status, 200);
    assert.equal((await req(h, 'PATCH', `/api/fields/${ids.text}`, s, { showOnCard: true })).status, 409, 'só dois campos no cartão');
    const some = (await campo({ name: 'Descartável', type: 'text' })).json.id as string;
    await valor(some, 'x');
    assert.equal((await req(h, 'DELETE', `/api/fields/${some}`, s)).status, 200);
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_field_values WHERE field_id = ?', some)!.n, 0, 'os valores saem com o campo');
    assert.equal((await req(h, 'DELETE', `/api/fields/${some}`, s)).status, 404);
  });

  test('valores: conferidos pelo tipo do campo; vazio tira; aparecem no cartão do quadro', async () => {
    assert.equal((await valor(ids.text, '  Maria, compras  ')).json.value, 'Maria, compras');
    assert.equal((await valor(ids.text, 'x'.repeat(501))).status, 400);
    assert.equal((await valor(ids.number, 1250.5)).json.value, 1250.5);
    assert.equal((await valor(ids.number, 'mil')).status, 400, 'número não aceita texto');
    assert.equal((await valor(ids.date, '2026-12-01')).json.value, '2026-12-01');
    for (const ruim of ['01/12/2026', '2026-02-30', 'amanhã']) assert.equal((await valor(ids.date, ruim)).status, 400, ruim);
    assert.equal((await valor(ids.select, opcoes[1].id)).json.value, opcoes[1].id);
    assert.equal((await valor(ids.select, `opt_${'0'.repeat(32)}`)).status, 400, 'opção que não é do campo');
    assert.equal((await valor(ids.select, 'Quente')).status, 400, 'pelo id, não pelo nome');
    assert.deepEqual((await valor(ids.labels, [etiquetas[2].id, etiquetas[0].id, etiquetas[0].id])).json.value, [etiquetas[0].id, etiquetas[2].id], 'sem repetir, na ordem das opções');
    assert.equal((await valor(ids.labels, etiquetas[0].id)).status, 400, 'etiquetas: uma lista');
    assert.equal((await valor(ids.person, s.userId)).json.value, s.userId);
    assert.equal((await valor(ids.person, bruna.userId)).status, 400, 'pessoa de outro workspace não');
    assert.equal((await valor(ids.text, '')).json.value, null);
    const t = (await ver()).tasks.find((x) => x.id === tarefa)!;
    assert.deepEqual(t.card!.values, { [ids.number]: 1250.5, [ids.date]: '2026-12-01', [ids.select]: opcoes[1].id, [ids.labels]: [etiquetas[0].id, etiquetas[2].id], [ids.person]: s.userId });
    assert.deepEqual((await cartao()).values[ids.labels], [etiquetas[0].id, etiquetas[2].id]);
    // campo de outro quadro não vale nesta tarefa
    const outro = (await req(h, 'POST', '/api/boards', s, { name: 'Outro' })).json.id as string;
    const cOutro = (await campo({ name: 'X', type: 'text' }, outro)).json.id as string;
    assert.equal((await valor(cOutro, 'x')).status, 409);
    // apagar o quadro leva o card e tira os campos dele (e os valores)
    const tOutro = (await req(h, 'POST', '/api/tasks', s, { title: 'No outro', boardId: outro })).json.id as string;
    await valor(cOutro, 'fica?', tOutro);
    assert.equal((await req(h, 'DELETE', `/api/boards/${outro}`, s, {})).status, 200);
    assert.deepEqual((await cartao(tOutro)).values, {});
  });

  test('subtarefas: criar, marcar, renomear, reordenar, apagar; o card mostra "feitas/total"', async () => {
    const a = (await req(h, 'POST', `/api/tasks/${tarefa}/subtasks`, s, { title: '  Levantar   requisitos ' })).json;
    assert.deepEqual([a.title, a.done, a.position], ['Levantar requisitos', false, 0]);
    const b = (await req(h, 'POST', `/api/tasks/${tarefa}/subtasks`, s, { title: 'Montar planilha' })).json;
    const c = (await req(h, 'POST', `/api/tasks/${tarefa}/subtasks`, s, { title: 'Enviar' })).json;
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/subtasks`, s, { title: '   ' })).status, 400);
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/subtasks`, s, { title: 'x'.repeat(201) })).status, 400);
    const rev = h.db.get<{ r: number }>('SELECT revision AS r FROM tasks WHERE id = ?', tarefa)!.r;
    assert.equal((await req(h, 'PATCH', `/api/subtasks/${a.id}`, s, { done: true })).status, 200);
    const m = await req(h, 'PATCH', `/api/subtasks/${c.id}`, s, { position: 0, title: 'Enviar ao cliente' });
    assert.deepEqual(m.json.subtasks.map((x: { title: string; done: boolean }) => [x.title, x.done]), [['Enviar ao cliente', false], ['Levantar requisitos', true], ['Montar planilha', false]]);
    assert.deepEqual((await ver()).tasks.find((x) => x.id === tarefa)!.card!.sub, [1, 3]);
    assert.equal((await req(h, 'DELETE', `/api/subtasks/${b.id}`, s)).status, 200);
    assert.deepEqual((await ver()).tasks.find((x) => x.id === tarefa)!.card!.sub, [1, 2]);
    assert.equal(h.db.get<{ r: number }>('SELECT revision AS r FROM tasks WHERE id = ?', tarefa)!.r, rev, 'mexer nas subtarefas não muda a revisão da tarefa (quem edita o título não perde o que digitou)');
    assert.equal((await req(h, 'PATCH', `/api/subtasks/${b.id}`, s, { done: true })).status, 404);
  });

  test('links: só http e https, bem formados, sem repetir; título opcional', async () => {
    const ok = await req(h, 'POST', `/api/tasks/${tarefa}/links`, s, { url: ' https://acme.example/proposta?id=7 ', title: 'Pasta da proposta' });
    assert.deepEqual([ok.status, ok.json.url, ok.json.title], [201, 'https://acme.example/proposta?id=7', 'Pasta da proposta']);
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/links`, s, { url: 'http://intranet.local/x' })).status, 201);
    for (const ruim of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://exemplo.test/x', 'acme.example', 'https://', 'https://usuario:senha@acme.example/', ' ', 'vbscript:x'])
      assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/links`, s, { url: ruim })).status, 400, ruim);
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/links`, s, { url: 'https://acme.example/proposta?id=7' })).status, 409, 'repetido');
    const c = await cartao();
    assert.deepEqual(c.links.map((l: { url: string }) => l.url), ['https://acme.example/proposta?id=7', 'http://intranet.local/x']);
    assert.equal((await req(h, 'DELETE', `/api/tasks/${tarefa}/links/${c.links[1].id}`, s)).status, 200);
    assert.equal((await ver()).tasks.find((x) => x.id === tarefa)!.card!.links, 1);
  });

  test('pessoas: uma ou mais do workspace (além do agente); quem não é do workspace não entra', async () => {
    // uma colega no mesmo workspace
    const colega = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    h.db.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'carla', 'Carla', 'x', ?)", colega, new Date().toISOString());
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, colega, new Date().toISOString());
    assert.deepEqual((await cartao()).members.map((m: { name: string }) => m.name).sort(), ['Alexandre', 'Carla'].sort());
    const r = await req(h, 'PUT', `/api/tasks/${tarefa}/people`, s, { userIds: [s.userId, colega] });
    assert.deepEqual(r.json.people.map((p: { id: string }) => p.id).sort(), [s.userId, colega].sort());
    assert.equal((await req(h, 'PUT', `/api/tasks/${tarefa}/people`, s, { userIds: [bruna.userId] })).status, 400, 'de outro workspace');
    assert.deepEqual((await ver()).tasks.find((x) => x.id === tarefa)!.card!.people.map((p) => p.name).sort(), ['Alexandre', 'Carla']);
    assert.equal((await req(h, 'PUT', `/api/tasks/${tarefa}/people`, s, { userIds: [colega] })).json.people.length, 1);
    // o agente responsável continua sendo outra coisa
    assert.equal(h.db.get<{ a: string | null }>('SELECT agent_id AS a FROM tasks WHERE id = ?', tarefa)!.a, null);
  });

  test('comentários: 240 caracteres no servidor; autor e hora; cada um apaga só o seu', async () => {
    const c = await req(h, 'POST', `/api/tasks/${tarefa}/comments`, s, { body: '  Cliente pediu desconto de 10%.  ' });
    assert.deepEqual([c.status, c.json.body, c.json.authorType, c.json.authorName, c.json.mine], [201, 'Cliente pediu desconto de 10%.', 'user', 'Alexandre', true]);
    assert.ok(Math.abs(Date.parse(c.json.createdAt) - Date.now()) < 5000);
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/comments`, s, { body: 'é'.repeat(240) })).status, 201, '240 letras acentuadas cabem');
    const longo = await req(h, 'POST', `/api/tasks/${tarefa}/comments`, s, { body: 'x'.repeat(241) });
    assert.deepEqual([longo.status, longo.json.error], [400, 'comentario_longo']);
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/comments`, s, { body: '   ' })).status, 400);
    assert.ok(!JSON.stringify(h.db.raw.prepare('SELECT body FROM task_comments').all()).includes('desconto') || !h.db.fieldCipher, 'com cofre, o texto fica cifrado');
    // outra pessoa do mesmo workspace vê, mas não apaga o que não é dela
    const carla = h.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'carla'")!.id;
    const { apagarComentario, comentar } = await import('../src/services/cartao.ts');
    assert.throws(() => apagarComentario(h.db, h.bus, { userId: carla, workspaceId: s.workspaceId, role: 'member' }, tarefa, c.json.id), /só o próprio/);
    const dela = comentar(h.db, h.bus, s.workspaceId, { type: 'user', id: carla }, tarefa, 'Posso ligar amanhã.');
    assert.equal((await req(h, 'DELETE', `/api/tasks/${tarefa}/comments/${dela.id}`, s)).status, 403, 'nem quem administra apaga o de outra pessoa');
    assert.deepEqual((await cartao()).comments.map((x: { authorName: string; mine: boolean }) => [x.authorName, x.mine]), [['Alexandre', true], ['Alexandre', true], ['Carla', false]]);
    assert.equal((await req(h, 'DELETE', `/api/tasks/${tarefa}/comments/${c.json.id}`, s)).status, 200);
    assert.equal((await ver()).tasks.find((x) => x.id === tarefa)!.card!.comments, 2);
  });

  test('a IA comenta: pela gestão do coordenador (tarefa.comentar) e pelo comando numa conversa, com o nome do agente e o mesmo limite', async () => {
    const coord = h.db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 1", s.workspaceId)!;
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord.id })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: 'oi', clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const sessao = h.db.get<{ x: string }>('SELECT hermes_session_id AS x FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.x;
    const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/gestao', null, corpo, { 'x-ergon-bridge-token': TOKEN })).json;
    const lista = JSON.stringify(await ponte({ op: 'listar', session_id: sessao, area: 'tarefas' }));
    assert.ok(lista.includes('tarefa.comentar'), 'a ação aparece nas ferramentas de tarefas do coordenador');
    const r = await ponte({ op: 'executar', session_id: sessao, acao: 'tarefa.comentar', parametros: { id: tarefa, body: 'Liguei para o cliente: retorna na sexta.' } });
    assert.deepEqual([r.ok, r.status], [true, 'feita'], JSON.stringify(r));
    const longo = await ponte({ op: 'executar', session_id: sessao, acao: 'tarefa.comentar', parametros: { id: tarefa, body: 'x'.repeat(241) } });
    assert.deepEqual([longo.ok, /240/.test(longo.texto)], [false, true], 'o mesmo limite para a IA');
    let ult = (await cartao()).comments.at(-1);
    assert.deepEqual([ult.authorType, ult.authorName, ult.body, ult.mine], ['agent', coord.name, 'Liguei para o cliente: retorna na sexta.', false]);
    // quem administra o workspace pode apagar o comentário de um agente
    assert.equal((await req(h, 'DELETE', `/api/tasks/${tarefa}/comments/${ult.id}`, s)).status, 200);
    // pelo comando (actions.ts): "/comentar #N texto"; a pessoa assina o dela, o agente assina o dele
    const n = h.db.get<{ n: number }>('SELECT number AS n FROM tasks WHERE id = ?', tarefa)!.n;
    const i = interpretRules(`/comentar #${n} Falta o CNPJ na proposta.`);
    assert.deepEqual([i.proposed_action, i.target_task_number, i.comment], ['comentar_tarefa', n, 'Falta o CNPJ na proposta.']);
    assert.ok(validateInterpretation(i));
    assert.equal(interpretRules(`comente no card ${n}: revisar valores`).comment, 'revisar valores');
    assert.equal(interpretRules('comenta 3 coisas sobre o projeto').proposed_action === 'comentar_tarefa', false, 'número solto não é card');
    const pol = { profileCreates: 'demands' as const, canCommand: true, observeOnly: false };
    const d = decide(i, pol, '');
    assert.equal(d.kind, 'comment_task');
    assert.equal(decide(i, { ...pol, canCommand: false }, '').kind, 'none', 'sem permissão de comando, nada');
    const feito = applyDecision(h.db, h.bus, s.workspaceId, { type: 'agent', id: coord.id }, d, { origin: 'chat' });
    assert.match(feito.summary, /Comentário registrado/);
    ult = (await cartao()).comments.at(-1);
    assert.deepEqual([ult.authorType, ult.authorName, ult.body], ['agent', coord.name, 'Falta o CNPJ na proposta.']);
    const demais = applyDecision(h.db, h.bus, s.workspaceId, { type: 'agent', id: coord.id }, { kind: 'comment_task', number: n, text: 'y'.repeat(241), reason: '' }, { origin: 'chat' });
    assert.match(demais.summary, /não gravado.*240/);
    // num card da equipe também se comenta (o resto do cartão é só das tarefas da pessoa)
    const daEquipe = (await req(h, 'POST', '/api/tasks', s, { title: 'Pesquisar concorrentes', agentId: coord.id })).json.id as string;
    assert.equal((await req(h, 'POST', `/api/tasks/${daEquipe}/comments`, s, { body: 'Prioridade alta.' })).status, 201);
    assert.equal((await req(h, 'POST', `/api/tasks/${daEquipe}/subtasks`, s, { title: 'x' })).status, 409, 'o quadro da equipe anda pelo trabalho');
    assert.equal((await req(h, 'POST', `/api/tasks/${daEquipe}/links`, s, { url: 'https://x.example' })).status, 409);
    const equipe = h.db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND audience = 'team' AND origin = 'native'", s.workspaceId)!.id;
    assert.equal((await campo({ name: 'X', type: 'text' }, equipe)).status, 409, 'o quadro da equipe não ganha campos');
    assert.deepEqual((await ver(equipe)).fields, []);
  });

  test('anexos: arquivos que já estão em Documentos, por referência; sem repetir; o da lixeira não abre', async () => {
    const doc = (await req(h, 'POST', '/api/artifacts', s, Buffer.from('a;b\n1;2'), { 'content-type': 'application/octet-stream', 'x-filename': 'proposta.csv', 'x-file-type': 'text/csv' })).json.id as string;
    const antes = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ?', s.workspaceId)!.n;
    const a = await req(h, 'POST', `/api/tasks/${tarefa}/attachments`, s, { artifactId: doc });
    assert.deepEqual([a.status, a.json.filename, a.json.mime, a.json.available, a.json.artifactId], [201, 'proposta.csv', 'text/csv', true, doc]);
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id = ?', s.workspaceId)!.n, antes, 'nenhum arquivo novo: só a referência');
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/attachments`, s, { artifactId: doc })).status, 409);
    const deOutra = (await req(h, 'POST', '/api/artifacts', bruna, Buffer.from('segredo'), { 'content-type': 'application/octet-stream', 'x-filename': 'b.txt', 'x-file-type': 'text/plain' })).json.id as string;
    assert.equal((await req(h, 'POST', `/api/tasks/${tarefa}/attachments`, s, { artifactId: deOutra })).status, 404, 'arquivo de outro workspace');
    assert.equal((await ver()).tasks.find((x) => x.id === tarefa)!.card!.files, 1);
    assert.equal((await req(h, 'POST', '/api/documents/trash', s, { artifactId: doc })).status, 200);
    assert.deepEqual((await cartao()).attachments.map((x: { filename: string; available: boolean }) => [x.filename, x.available]), [['proposta.csv', false]]);
    assert.equal((await req(h, 'DELETE', `/api/tasks/${tarefa}/attachments/${a.json.id}`, s)).status, 200);
    assert.deepEqual((await cartao()).attachments, []);
  });

  test('outro workspace não lê nem escreve nada do cartão; sem sessão, nada', async () => {
    for (const [m, url, corpo] of [
      ['GET', `/api/tasks/${tarefa}/card`, undefined], ['GET', `/api/boards/${quadro}/fields`, undefined], ['POST', `/api/boards/${quadro}/fields`, { name: 'X', type: 'text' }],
      ['PATCH', `/api/fields/${ids.text}`, { name: 'Y' }], ['DELETE', `/api/fields/${ids.text}`, undefined], ['PUT', `/api/tasks/${tarefa}/fields/${ids.text}`, { value: 'x' }],
      ['POST', `/api/tasks/${tarefa}/subtasks`, { title: 'x' }], ['POST', `/api/tasks/${tarefa}/links`, { url: 'https://x.example' }], ['PUT', `/api/tasks/${tarefa}/people`, { userIds: [] }],
      ['POST', `/api/tasks/${tarefa}/comments`, { body: 'x' }],
    ] as Array<[string, string, unknown]>) {
      assert.equal((await req(h, m, url, bruna, corpo)).status, 404, `${m} ${url}`);
      assert.equal((await req(h, m, url, null, corpo)).status, 401, `${m} ${url} sem sessão`);
    }
    const sub = (await cartao()).subtasks[0].id as string;
    assert.equal((await req(h, 'PATCH', `/api/subtasks/${sub}`, bruna, { done: true })).status, 404);
    assert.equal((await req(h, 'DELETE', `/api/subtasks/${sub}`, bruna)).status, 404);
  });

  test('quadro espelhado: campos, subtarefas e comentários ficam só no Ergon (nada entra na fila de escrita do aplicativo)', async () => {
    const con = findConnection(h.db, s.workspaceId, 'mirror_fixture', 'fixture');
    await importBoards(h.db, h.bus, s.workspaceId, con.id, s.userId, new FixtureTaskProvider(FIXTURES, 'planner-like-v1'), ['plan-fixture-1']);
    const esp = h.db.get<{ id: string; audience: string }>("SELECT id, audience FROM boards WHERE workspace_id = ? AND origin = 'mirror'", s.workspaceId)!;
    const t = h.db.get<{ id: string }>('SELECT id FROM tasks WHERE board_id = ?', esp.id)!.id;
    const fila = () => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mirror_outbox WHERE workspace_id = ?', s.workspaceId)!.n;
    const antes = fila();
    if (esp.audience === 'user') {
      const c = await campo({ name: 'Nota interna', type: 'text' }, esp.id);
      assert.equal(c.status, 201, JSON.stringify(c.json));
      assert.equal((await valor(c.json.id, 'só aqui', t)).status, 200);
      assert.equal((await req(h, 'POST', `/api/tasks/${t}/subtasks`, s, { title: 'Conferir' })).status, 201);
      assert.equal((await cartao(t)).mirror, true);
    }
    assert.equal((await req(h, 'POST', `/api/tasks/${t}/comments`, s, { body: 'Comentário local.' })).status, 201);
    assert.equal(fila(), antes, 'nada foi para o aplicativo de origem');
    // as colunas do espelhado continuam vindo do aplicativo
    assert.equal((await req(h, 'POST', `/api/boards/${esp.id}/columns`, s, { name: 'x' })).status, 409);
  });
});
