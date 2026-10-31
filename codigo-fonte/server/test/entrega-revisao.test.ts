/**
 * Entrega e revisão (decisão de 30/10): o que depende do julgamento da pessoa (texto, documento, pesquisa) é entregue
 * para a aprovação dela; ajustes fazem uma versão nova no MESMO card; "Revisar" reabre um card concluído. E: vários
 * cards numa resposta (com ordem e "depois de"), lote grande com confirmação, cancelar card inexistente não vira
 * cartão, conversa no jeito dos aplicativos de mensagem e Documentos geridos por qualquer colega.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { parsePlans } from '../src/services/purpose.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'Feito.';
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_er${String(this.started.length + 1).padStart(6, '0')}`;
    this.started.push(p);
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: 's', usage: null, model: 'nous/teste-1' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
class Control implements HermesControlClient {
  async health() { return true; }
  async accounts() { return [{ id: 'nous', name: 'Nous Portal', connected: true, freeTier: false, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 's', userCode: 'A', verificationUrl: 'https://auth.example', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'approved', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(e: string[]) { return e; }
}

const TEXTO = (t: string) => `# ${t}\n\n${'Texto completo e revisado, pronto para usar, com todos os pontos pedidos e as fontes indicadas. '.repeat(30)}`;
const COORD = /Você é o Coordenador da equipe/;

describe('entrega e revisão, lote de cards, conversa e Documentos', () => {
  let h: Harness; let s: Session; let motor: Motor; let st: any;
  const agent = (key: string) => st.agents.find((a: { char_key: string }) => a.char_key === key) as { id: string; name: string };
  let n = 0;
  const rid = () => `req-entrega-${String(++n).padStart(4, '0')}`;
  const run = async (k = 40) => { for (let i = 0; i < k; i++) { h.teamwork.tick(); await h.executor.tick(); } };
  const conv = async (key: string) => (await req(h, 'POST', '/api/conversations', s, { agentId: agent(key).id })).json.id as string;
  const say = async (c: string, text: string, extra: Record<string, unknown> = {}) => req(h, 'POST', `/api/conversations/${c}/messages`, s, { text, clientRequestId: rid(), ...extra });
  const card = (num: number) => h.db.get<{ id: string; completed: number; work_state: string; review_round: number; delivered_at: string | null; review: string | null; queue_pos: number }>(
    'SELECT id, completed, work_state, review_round, delivered_at, review, queue_pos FROM tasks WHERE workspace_id = ? AND number = ?', s.workspaceId, num)!;
  const cards = () => h.db.all<{ number: number; title: string }>('SELECT number, title FROM tasks WHERE workspace_id = ? AND archived = 0 ORDER BY number', s.workspaceId);
  const props = async (c: string) => (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json as Array<{ id: string; kind: string; status: string; payload: string | null; summary: string }>;

  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, control: new Control() });
    s = await setupOwner(h);
    st = (await req(h, 'GET', '/api/state', s)).json;
    h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
  });
  after(async () => { await h.close(); });

  test('leitura: vários planos, ordem, "depois de", revisão e a linha inventada [[card]]', () => {
    const p = parsePlans('[[plano objetivo="A" ordem="2"]]\n[[etapa agente="Hipátia" faz="pesquisar A"]]\n[[plano objetivo="B" ordem="1" revisao="nao"]]\n[[etapa agente="Diógenes" faz="fazer B"]]\n[[plano objetivo="C" depois="1" revisao="forte"]]\n[[etapa agente="Heródoto" faz="escrever C"]]\n[[card titulo="D" responsavel="Hipátia" trabalho="levantar D"]]');
    assert.deepEqual(p.map((x) => [x.objective, x.order ?? null, x.after, x.review ?? null, x.steps.length]), [['A', 2, [], null, 1], ['B', 1, [], 'nao', 1], ['C', null, [1], 'forte', 1], ['D', null, [], null, 1]]);
  });

  test('várias entregas independentes numa resposta: um card cada, na ordem recomendada, com "depois de"', async () => {
    const c = await conv('aristoteles');
    const before = cards().length;
    motor.reply = (p) => COORD.test(p.instructions) && !/^A equipe terminou/.test(p.input)
      ? 'Abro três cards, nesta ordem.\n[[plano objetivo="Pesquisa de concorrentes" ordem="1"]]\n[[etapa agente="Hipátia" faz="Levantar concorrentes"]]\n[[plano objetivo="Pesquisa de preços" ordem="2"]]\n[[etapa agente="Hipátia" faz="Levantar preços"]]\n[[plano objetivo="Proposta comercial" ordem="3" depois="1,2"]]\n[[etapa agente="Heródoto" faz="Escrever a proposta"]]'
      : TEXTO('Resultado');
    await say(c, 'Preciso de 2 pesquisas e depois uma proposta com base nelas');
    await run(2);
    const made = cards().slice(before);
    assert.deepEqual(made.map((x) => x.title), ['Pesquisa de concorrentes', 'Pesquisa de preços', 'Proposta comercial']);
    const [a, b, d] = made.map((x) => card(x.number));
    assert.ok(a.queue_pos < b.queue_pos && b.queue_pos < d.queue_pos, 'a fila segue a ordem recomendada');
    assert.equal(h.db.all('SELECT 1 FROM task_deps WHERE task_id = ?', d.id).length, 2, 'a proposta espera as duas pesquisas');
    const notes = h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'", c);
    assert.ok(notes.some((x) => /3 cards abertos, nesta ordem/.test(x.content)), 'um resumo só para o lote');
    // as pesquisas terminam e vão para a aprovação; a proposta só começa depois que elas forem concluídas
    await run(40);
    assert.equal(card(made[0].number).work_state, 'aguardando_aprovacao');
    assert.ok(card(made[0].number).delivered_at);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?", d.id)!.n, 0, 'proposta ainda esperando as pesquisas');
    for (const x of made) h.db.run('UPDATE tasks SET archived = 1 WHERE number = ? AND workspace_id = ?', x.number, s.workspaceId);
  });

  test('entrega para a sua aprovação: Aprovar e Pedir ajustes; ajuste faz a versão 2 no mesmo card', async () => {
    const c = await conv('aristoteles');
    const before = cards().length;
    motor.reply = (p) => COORD.test(p.instructions) && !/^A equipe terminou/.test(p.input)
      ? 'Vou montar.\n[[plano objetivo="Contrato de prestação de serviço"]]\n[[etapa agente="Heródoto" faz="Redigir o contrato"]]'
      : /^A equipe terminou/.test(p.input) ? `Aqui está o contrato.\n\n${TEXTO('Contrato')}` : TEXTO('Contrato');
    await say(c, 'Quero um contrato de prestação de serviço');
    await run(40);
    const num = cards()[before].number;
    let t = card(num);
    assert.equal(t.work_state, 'aguardando_aprovacao'); assert.equal(t.completed, 0); assert.equal(t.review, 'leve');
    assert.ok(h.db.get("SELECT 1 FROM runs WHERE idempotency_key LIKE 'entrega-%' AND conversation_id = ?", c), 'o contrato foi entregue na conversa');
    let ap = (await props(c)).find((p) => p.kind === 'info_request' && p.status === 'proposed' && JSON.parse(p.payload!).review);
    assert.ok(ap, 'cartão Aprovar / Pedir ajustes depois da entrega');
    // pedir ajustes: nova rodada no mesmo card, sem card novo
    await req(h, 'POST', `/api/proposals/${ap!.id}/respond`, s, { action: 'return', text: 'Inclua uma cláusula de confidencialidade' });
    await run(40);
    t = card(num);
    assert.equal(t.review_round, 2); assert.equal(t.work_state, 'aguardando_aprovacao');
    assert.equal(cards().length, before + 1, 'nenhum card novo para o ajuste');
    const v2 = motor.started.find((p) => /versão 2/.test(p.input));
    assert.ok(v2 && /confidencialidade/.test(v2.input), 'a entrega da versão 2 sabe o que mudou');
    ap = (await props(c)).find((p) => p.kind === 'info_request' && p.status === 'proposed' && JSON.parse(p.payload!).review);
    assert.equal(JSON.parse(ap!.payload!).round, 2);
    await req(h, 'POST', `/api/proposals/${ap!.id}/respond`, s, { action: 'approve' });
    assert.equal(card(num).completed, 1, 'aprovado: concluído');
    // a mensagem de entrega sabe de que card veio (para Revisar ali mesmo)
    const msgs = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ cards?: Array<{ number: number }> }>;
    assert.ok(msgs.some((m) => m.cards?.some((x) => x.number === num)));
    // Revisar um card concluído: reabre o mesmo card na rodada 3
    const r = await req(h, 'POST', `/api/tasks/${t.id}/revise`, s, { text: 'Troque o foro para São Paulo' });
    assert.equal(r.status, 200);
    assert.equal(card(num).completed, 0); assert.equal(card(num).review_round, 3);
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', t.id);
  });

  test('lote grande (mais de 8): você confirma com "Abrir todos"', async () => {
    const c = await conv('aristoteles');
    const before = cards().length;
    const plans = Array.from({ length: 9 }, (_, i) => `[[plano objetivo="Tarefa ${i + 1}" revisao="nao"]]\n[[etapa agente="Diógenes" faz="Fazer a tarefa ${i + 1}"]]`).join('\n');
    motor.reply = (p) => (COORD.test(p.instructions) && !/^A equipe terminou/.test(p.input) ? `São 9.\n${plans}` : TEXTO('Feito'));
    await say(c, 'Organize estas 9 tarefas');
    await run(2);
    assert.equal(cards().length, before, 'nada aberto antes de você confirmar');
    const batch = (await props(c)).find((p) => p.kind === 'batch' && p.status === 'proposed');
    assert.ok(batch); assert.match(batch!.summary, /Abrir 9 cards/);
    assert.equal((await req(h, 'POST', `/api/proposals/${batch!.id}`, s, { decision: 'apply' })).status, 200);
    assert.equal(cards().length, before + 9);
    for (const x of cards().slice(before)) h.db.run('UPDATE tasks SET archived = 1 WHERE number = ? AND workspace_id = ?', x.number, s.workspaceId);
  });

  test('cancelar card que não existe não vira cartão: só uma nota', async () => {
    const c = await conv('aristoteles');
    motor.reply = () => 'Limpo o quadro. [[cancelar-card numero="991" motivo="duplicado"]]';
    await say(c, 'cancela o card 991');
    await run(3);
    assert.equal((await props(c)).filter((p) => p.kind === 'delete_task').length, 0);
    assert.ok(h.db.get("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'system' AND content LIKE '%#991 não está no quadro%'", c) || h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'", c).some((m) => /#991 não está no quadro/.test(m.content)));
  });

  test('conversa: renomear, arquivar, não lida, marcar, responder citando, bifurcar e a busca que acha tudo', async () => {
    const c = await conv('hipatia');
    motor.reply = () => 'A fonte principal é https://exemplo.test/relatorio-anual e o número-chave é 42.';
    await say(c, 'qual a fonte do relatório anual?'); await run(3);
    const msgs = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ id: string; role: string; marked?: number }>;
    const resp = msgs.find((m) => m.role === 'agent')!;
    await req(h, 'PATCH', `/api/conversations/${c}`, s, { title: 'Relatório anual' });
    await req(h, 'PUT', `/api/messages/${resp.id}/mark`, s, { on: true });
    assert.equal((await req(h, 'GET', `/api/conversations/${c}/marks`, s)).json.length, 1);
    // responder citando: o colega sabe a qual mensagem
    await say(c, 'e de que ano?', { replyTo: resp.id }); await run(3);
    assert.match(motor.started.filter((p) => /e de que ano/.test(p.input)).at(-1)!.instructions, /A pessoa está respondendo a esta mensagem sua: “A fonte principal/);
    // busca: assunto, mensagem e link
    const found = (await req(h, 'GET', '/api/search/conversations?q=relatorio', s)).json;
    assert.ok(found.assuntos.some((x: { id: string }) => x.id === c));
    assert.ok(found.mensagens.some((x: { id: string }) => x.id === resp.id));
    assert.ok(found.links.some((x: { url: string }) => x.url === 'https://exemplo.test/relatorio-anual'));
    assert.equal((await req(h, 'GET', `/api/conversations/${c}/media`, s)).json.links[0].url, 'https://exemplo.test/relatorio-anual');
    // bifurcar: novo assunto com o mesmo colega; a mensagem vai junto como contexto
    const f = (await req(h, 'POST', `/api/messages/${resp.id}/fork`, s)).json;
    await say(f.id, 'aprofunda isso'); await run(3);
    assert.match(motor.started.filter((p) => /aprofunda isso/.test(p.input)).at(-1)!.instructions, /Este assunto foi aberto a partir desta mensagem sua/);
    // não lida e arquivar
    await req(h, 'PATCH', `/api/conversations/${c}`, s, { unread: true });
    assert.equal((await req(h, 'GET', '/api/conversations/recent', s)).json.find((x: { id: string }) => x.id === c).unread, 1);
    await req(h, 'PATCH', `/api/conversations/${c}`, s, { archived: true });
    assert.ok(!(await req(h, 'GET', '/api/conversations/recent', s)).json.some((x: { id: string }) => x.id === c), 'arquivado sai da lista');
    assert.ok((await req(h, 'GET', '/api/search/conversations?q=relatorio&kind=assuntos', s)).json.assuntos.some((x: { id: string; archived: boolean }) => x.id === c && x.archived), 'a busca acha o arquivado');
  });

  test('Documentos por qualquer colega: salvar como Word numa pasta; apagar de vez só com o seu clique', async () => {
    const c = await conv('herodoto');
    motor.reply = () => `${TEXTO('Política de férias')}\n[[salvar-documento nome="Política de férias" formato="docx" pasta="RH/Políticas"]]`;
    await say(c, 'escreve a política de férias e salva em RH/Políticas'); await run(3);
    const doc = h.db.get<{ id: string; mime: string; folder_id: string }>("SELECT id, mime, folder_id FROM artifacts WHERE filename = 'Política de férias.docx'")!;
    assert.ok(doc); assert.match(doc.mime, /wordprocessingml/);
    const path = (await req(h, 'GET', `/api/documents?folder=${doc.folder_id}`, s)).json.path.map((x: { name: string }) => x.name);
    assert.deepEqual(path, ['RH', 'Políticas']);
    motor.reply = () => 'Apago de vez quando você confirmar. [[apagar arquivo="Política de férias.docx"]]';
    await say(c, 'apaga de vez esse documento'); await run(3);
    assert.ok(h.db.get('SELECT 1 FROM artifacts WHERE id = ?', doc.id), 'nada apagado antes do seu clique');
    const purge = (await props(c)).find((p) => p.kind === 'purge' && p.status === 'proposed')!;
    assert.ok(purge);
    await req(h, 'POST', `/api/proposals/${purge.id}`, s, { decision: 'apply' });
    assert.equal(h.db.get('SELECT 1 FROM artifacts WHERE id = ?', doc.id), undefined);
  });

  test('Entregas: a pasta dos cards se chama Entregas, aceita outro nome e tem atalho', async () => {
    const r = (await req(h, 'GET', '/api/documents?folder=entregas', s)).json;
    assert.equal(r.folder.name, 'Entregas');
    assert.equal((await req(h, 'PATCH', `/api/documents/folders/${r.folder.id}`, s, { name: 'Entregas da equipe' })).status, 200, 'pasta automática aceita outro nome');
    assert.equal((await req(h, 'POST', '/api/documents/trash', s, { folderId: r.folder.id })).status, 409, 'mas não vai para a lixeira');
  });
});
