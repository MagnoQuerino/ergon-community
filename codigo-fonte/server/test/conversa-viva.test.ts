/**
 * Conversa com a equipe (pedido de produto, 30/10/2026): colegas, não robôs. Voz e personalidade por colega (os
 * extremos só com aceite), resposta chegando ao vivo, parar, fila editável, tentar de novo, não lidas, fixar,
 * prioridade marcada pelo agente, arquivos de qualquer formato na conversa, a equipe que puxa conversa quando a
 * pessoa chega, e Documentos (pastas, lixeira, desfazer, organização pela coordenação).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, RunEvent, StartRun } from '../src/services/hermes.ts';
import { parsePriority } from '../src/services/initiative.ts';
import { openerFor } from '../../shared/personalities.ts';
import { allAgents, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: Array<StartRun & { runId: string }> = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'Feito.';
  hold = false;
  fails = false;
  script: RunEvent[] = [];
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_teste${String(this.started.length + 1).padStart(6, '0')}`;
    this.started.push({ ...p, runId });
    this.runs.set(runId, this.fails ? { status: 'failed', output: null, error: 'o provedor demorou demais (teste)', sessionId: 's', usage: null, model: null }
      : this.hold ? { status: 'running', output: null, error: null, sessionId: 's', usage: null, model: null }
      : { status: 'completed', output: this.reply(p), error: null, sessionId: 's', usage: null, model: 'nous/teste-1' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop(id: string) { this.runs.set(id, { status: 'cancelled', output: null, error: null, sessionId: 's', usage: null, model: null }); return { accepted: true, detail: 'ok' }; }
  async events(_id: string, on: (e: RunEvent) => void, signal: AbortSignal) {
    for (const e of this.script) on(e);
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
  finish(id: string, output: string) { this.runs.set(id, { status: 'completed', output, error: null, sessionId: 's', usage: null, model: 'nous/teste-1' }); }
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

/** PNG 1×1 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('conversa com a equipe: colegas, ao vivo, arquivos, iniciativa e Documentos', () => {
  let h: Harness; let s: Session; let motor: Motor; let st: any;
  const agent = (key: string) => st.agents.find((a: { char_key: string }) => a.char_key === key) as { id: string; name: string; personality: string };
  let n = 0;
  const rid = () => `req-conversa-${String(++n).padStart(4, '0')}`;
  const conv = async (key: string): Promise<string> => (await req(h, 'POST', '/api/conversations', s, { agentId: agent(key).id })).json.id;
  const say = async (c: string, text: string, extra: Record<string, unknown> = {}) => req(h, 'POST', `/api/conversations/${c}/messages`, s, { text, clientRequestId: rid(), ...extra });
  const msgs = async (c: string) => (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ id: string; role: string; content: string; queued: number; attachments?: Array<{ filename: string }> }>;
  const recent = async () => (await req(h, 'GET', '/api/conversations/recent', s)).json as Array<{ id: string; unread: number; priority: string | null; priority_reason: string | null; pinned_at: string | null; last_text: string | null; title: string }>;
  const upload = (data: Buffer | string, name: string, type: string, hdr: Record<string, string> = {}) => req(h, 'POST', '/api/artifacts', s,
    Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-file-type': type, ...hdr });
  const lastRun = (c: string) => h.db.get<{ id: string; status: string }>('SELECT id, status FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c)!;
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, control: new Control() });
    s = await setupOwner(h);
    st = { agents: await allAgents(h, s) };
  });
  after(async () => { await h.close(); });

  test('voz de colega: guia comum, a personalidade de fábrica, o nome da pessoa; nada de "texto curto"', async () => {
    assert.equal(agent('diogenes').personality, 'acido', 'Diógenes vem ácido de fábrica');
    assert.equal(agent('aristoteles').personality, 'cordial');
    const c = await conv('diogenes');
    assert.equal((await say(c, 'oi, tudo certo por aí?')).status, 201);
    await drain(h, 3);
    const p = motor.started.at(-1)!;
    assert.match(p.instructions, /como um colega de trabalho, não como um assistente/);
    assert.match(p.instructions, /Sua personalidade \(escolhida pela pessoa\): Ácido/);
    assert.match(p.instructions, /Você conversa com Alexandre/);
    assert.match(p.instructions, /Nunca use frases de atendente/);
    assert.doesNotMatch(p.instructions, /Responda em texto curto/);
  });

  test('personalidade extrema só com o aceite; escolha vale para a pessoa e muda a voz', async () => {
    const dio = agent('diogenes');
    let r = await req(h, 'PUT', `/api/agents/${dio.id}/personality`, s, { personality: 'desgracado' });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'confirm_extreme');
    assert.equal((await req(h, 'PUT', `/api/agents/${dio.id}/personality`, s, { personality: 'inventada' })).status, 400);
    r = await req(h, 'PUT', `/api/agents/${dio.id}/personality`, s, { personality: 'desgracado', accepted: true });
    assert.equal(r.status, 200);
    st = { agents: await allAgents(h, s) };
    assert.equal(agent('diogenes').personality, 'desgracado');
    const c = await conv('diogenes');
    await say(c, 'e aí, o que falta?'); await drain(h, 3);
    assert.match(motor.started.at(-1)!.instructions, /Desgraçado/);
    assert.match(motor.started.at(-1)!.instructions, /saem sempre profissionais/, 'a trava das entregas vale até no extremo');
    await req(h, 'PUT', `/api/agents/${dio.id}/personality`, s, { personality: 'acido' });
    st = { agents: await allAgents(h, s) };
  });

  test('abertura pronta: primeiro nome, saudação da hora, no jeito da personalidade', () => {
    assert.equal(openerFor('conciso', 'Ana Souza', 10, 0), 'Ana, tem um minuto?');
    assert.equal(openerFor('formal', 'Ana', 9, 0), 'Bom dia, Ana. Teria um momento?');
    assert.match(openerFor('estupido', 'Ana', 15, 0), /Finalmente apareceu/);
  });

  test('ao vivo: o texto chegando e o que o colega faz agora; ao terminar vira mensagem', async () => {
    const c = await conv('hipatia');
    motor.hold = true;
    motor.script = [{ event: 'message.delta', delta: 'Achei três ' }, { event: 'message.delta', delta: 'fornecedores' }, { event: 'tool.started', tool: 'web_search', preview: 'preço do café' }];
    await say(c, 'pesquisa o preço do café'); await drain(h, 2); await wait();
    const run = lastRun(c);
    const live = (await req(h, 'GET', `/api/runs/${run.id}/live`, s)).json;
    assert.equal(live.text, 'Achei três fornecedores');
    assert.equal(live.activity, 'pesquisando na internet: “preço do café”');
    motor.finish(motor.started.at(-1)!.runId, 'Achei três fornecedores de café.');
    motor.hold = false; motor.script = [];
    await drain(h, 2);
    assert.equal((await msgs(c)).at(-1)!.content, 'Achei três fornecedores de café.');
    assert.equal((await req(h, 'GET', `/api/runs/${run.id}/live`, s)).json.text, '', 'terminou: o ao vivo some');
  });

  test('parar: a parada é sua e aparece como nota curta', async () => {
    const c = await conv('herodoto');
    motor.hold = true;
    await say(c, 'escreve um texto longo sobre o mar'); await drain(h, 2);
    const run = lastRun(c);
    assert.equal((await req(h, 'POST', `/api/runs/${run.id}/cancel`, s)).status, 200);
    await drain(h, 2);
    motor.hold = false;
    const last = (await msgs(c)).at(-1)!;
    assert.equal(last.role, 'system'); assert.equal(last.content, 'Você interrompeu.');
    assert.deepEqual((await req(h, 'GET', `/api/conversations/${c}/cards`, s)).json, [], 'sem card andando desta conversa');
  });

  test('fila: Enter com o colega trabalhando enfileira; dá para editar ou tirar até ir', async () => {
    const c = await conv('herodoto');
    motor.hold = true;
    await say(c, 'primeiro pedido'); await drain(h, 2);
    const q1 = await say(c, 'segundo pedido', { queue: true });
    const q2 = await say(c, 'terceiro pedido', { queue: true });
    assert.equal(q1.json.queued, true);
    assert.equal((await req(h, 'PATCH', `/api/messages/${q1.json.messageId}`, s, { text: 'segundo pedido, editado' })).status, 200);
    assert.equal((await req(h, 'DELETE', `/api/messages/${q2.json.messageId}`, s)).status, 200);
    const list = await msgs(c);
    assert.ok(list.some((m) => m.content === 'segundo pedido, editado' && m.queued === 1));
    assert.ok(!list.some((m) => m.content === 'terceiro pedido'), 'tirada da fila');
    motor.finish(motor.started.at(-1)!.runId, 'Primeiro feito.');
    motor.hold = false;
    for (let i = 0; i < 4; i++) { h.teamwork.tick(); await drain(h, 2); }
    assert.equal((await req(h, 'PATCH', `/api/messages/${q1.json.messageId}`, s, { text: 'tarde demais' })).json.error, 'not_queued');
    assert.ok(motor.started.some((p) => p.input.startsWith('segundo pedido, editado')), 'a versão editada foi ao agente');
  });

  test('falha: o motivo em linguagem simples e "tentar de novo" sem duplicar a mensagem', async () => {
    const c = await conv('hipatia');
    motor.fails = true;
    await say(c, 'resume o relatório de vendas'); await drain(h, 3);
    motor.fails = false;
    const fail = (await msgs(c)).at(-1)!;
    assert.match(fail.content, /^Não deu certo desta vez: /);
    const users = (await msgs(c)).filter((m) => m.role === 'user').length;
    const r = await req(h, 'POST', `/api/conversations/${c}/retry`, s);
    assert.equal(r.status, 200);
    await drain(h, 3);
    const after = await msgs(c);
    assert.equal(after.filter((m) => m.role === 'user').length, users, 'a mensagem não foi repetida');
    assert.equal(after.at(-1)!.role, 'agent');
    assert.equal((await req(h, 'POST', `/api/conversations/${c}/retry`, s)).json.error, 'answered', 'respondida não se repete');
  });

  test('prioridade do agente, não lida, lida e fixar; a marca sai quando você responde', async () => {
    assert.deepEqual(parsePriority('x [[prioridade nivel="urgente" motivo="prazo hoje"]]'), { level: 'urgente', reason: 'prazo hoje' });
    assert.equal(parsePriority('nada aqui'), null);
    const c = await conv('aspasia');
    motor.reply = () => 'O fornecedor precisa da sua resposta até as 17h. [[prioridade nivel="urgente" motivo="prazo hoje às 17h"]]';
    await say(c, 'como está o fornecedor?'); await drain(h, 3);
    motor.reply = () => 'Feito.';
    let row = (await recent()).find((x) => x.id === c)!;
    assert.equal(row.priority, 'urgente'); assert.equal(row.priority_reason, 'prazo hoje às 17h');
    assert.equal(row.unread, 1);
    assert.equal(row.last_text, 'O fornecedor precisa da sua resposta até as 17h.', 'a lista mostra a última fala sem a linha de controle');
    await req(h, 'POST', `/api/conversations/${c}/read`, s);
    await req(h, 'PATCH', `/api/conversations/${c}`, s, { pinned: true });
    row = (await recent()).find((x) => x.id === c)!;
    assert.equal(row.unread, 0); assert.ok(row.pinned_at);
    await say(c, 'respondi agora'); await drain(h, 3);
    assert.equal((await recent()).find((x) => x.id === c)!.priority, null, 'você respondeu: a marca sai');
    // alarme demais: depois de 3 urgentes em 24 h, o agente só consegue "precisa de você"
    for (let i = 0; i < 3; i++) h.db.run("INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, result, created_at) VALUES (?, ?, 'agent', ?, 'conversation.priority.urgente', 'urgente', ?)", `aud_${'f'.repeat(31)}${i}`, s.workspaceId, agent('aspasia').id, new Date().toISOString());
    motor.reply = () => 'Outra coisa urgente. [[prioridade nivel="urgente" motivo="de novo"]]';
    await say(c, 'e agora?'); await drain(h, 3);
    motor.reply = () => 'Feito.';
    assert.equal((await recent()).find((x) => x.id === c)!.priority, 'alta');
  });

  test('arquivos na conversa: qualquer formato fica em Documentos; texto lido, imagem para a visão, o resto com aviso honesto', async () => {
    const c = await conv('hipatia');
    const doc = await upload('Cláusula 7: multa de 2% ao mês. Código secreto XYZ-77.', 'contrato.txt', 'text/plain', { 'x-conversation-id': c });
    assert.equal(doc.status, 201);
    const folder = h.db.get<{ system_key: string; name: string; parent: string }>(
      'SELECT f.system_key, f.name, p.system_key AS parent FROM artifacts a JOIN folders f ON f.id = a.folder_id JOIN folders p ON p.id = f.parent_id WHERE a.id = ?', doc.json.id)!;
    assert.equal(folder.system_key, `agente:${agent('hipatia').id}`); assert.equal(folder.parent, 'conversas');
    assert.equal((await say(c, '', { attachments: [doc.json.id] })).status, 201, 'só o arquivo, sem texto');
    await drain(h, 3);
    let p = motor.started.at(-1)!;
    assert.match(p.input, /\[Anexos: contrato\.txt\]/);
    assert.match(p.input, /Código secreto XYZ-77/, 'o colega recebe o texto do arquivo');
    assert.match(p.instructions, /mandou arquivo\(s\) sem escrever nada/);
    const mine = (await msgs(c)).find((m) => m.role === 'user')!;
    assert.equal(mine.attachments?.[0].filename, 'contrato.txt');
    assert.equal((await recent()).find((x) => x.id === c)!.title, 'contrato.txt', 'a conversa ganha o nome do arquivo');
    // imagem: vai para a visão do modelo
    const img = await upload(PNG, 'foto.png', 'image/png', { 'x-conversation-id': c });
    await say(c, 'o que tem nesta foto?', { attachments: [img.json.id] }); await drain(h, 3);
    p = motor.started.at(-1)!;
    assert.equal(p.images?.length, 1); assert.equal(p.images?.[0].mime, 'image/png');
    // áudio: guardado, e o colega avisa que não abre
    const mp3 = await upload(Buffer.from([0x49, 0x44, 0x33, 0, 0, 0, 1, 2]), 'reuniao.mp3', 'audio/mpeg', { 'x-conversation-id': c });
    assert.equal(mp3.status, 201);
    await say(c, 'ouve a reunião', { attachments: [mp3.json.id] }); await drain(h, 3);
    assert.match(motor.started.at(-1)!.input, /Tipo que o sistema não abre/);
    // arquivo de outra pessoa ou inexistente não entra
    assert.equal((await say(c, 'e esse?', { attachments: ['art_00000000000000000000000000000000'] })).status, 404);
  });

  test('documento citado pelo nome na conversa é lido para o colega', async () => {
    await upload('Valor total da proposta: R$ 12.345,00 em 3 parcelas.', 'proposta-aurora.txt', 'text/plain');
    const c = await conv('herodoto');
    await say(c, 'usa a proposta-aurora para montar o e-mail de cobrança'); await drain(h, 3);
    assert.match(motor.started.at(-1)!.input, /R\$ 12\.345,00 em 3 parcelas/);
  });

  test('iniciativa: ao chegar, quem precisa de você puxa conversa (sem IA); a coordenação presta contas; responder traz o cartão', async () => {
    const hip = agent('hipatia');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Levantamento de concorrentes', agentId: hip.id })).json as { id: string; number: number };
    h.db.run("UPDATE tasks SET work_state = 'aguardando_info' WHERE id = ?", t.id);
    const ago = new Date(Date.now() - 5 * 3600_000).toISOString();
    h.db.run('INSERT INTO presence (workspace_id, user_id, last_seen_at) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at', s.workspaceId, s.userId, ago);
    const before = motor.started.length;
    assert.equal((await req(h, 'POST', '/api/presence', s)).json.arrived, true);
    const hipConv = h.db.get<{ conversation_id: string }>("SELECT conversation_id FROM nudges WHERE workspace_id = ? AND item_key = ?", s.workspaceId, `card:${t.id}`)!.conversation_id;
    const opener = (await msgs(hipConv)).at(-1)!;
    assert.equal(opener.role, 'agent');
    assert.match(opener.content, /Alexandre/, 'abertura pronta, com o nome, no jeito dela');
    assert.equal((await recent()).find((x) => x.id === hipConv)!.priority, 'alta');
    await drain(h, 3);
    const welcome = motor.started.slice(before).find((p) => /acabou de chegar/.test(p.input));
    assert.ok(welcome, 'a coordenação dá as boas-vindas');
    assert.match(welcome!.input, new RegExp(`Hipátia precisa de você no card #${t.number}`));
    assert.equal(motor.started.slice(before).filter((p) => p.idempotencyKey.includes('boas-vindas')).length, 1);
    // ainda aqui: nada de novo
    const count = (await msgs(hipConv)).length;
    assert.equal((await req(h, 'POST', '/api/presence', s)).json.arrived, false);
    assert.equal((await msgs(hipConv)).length, count, 'sem enxurrada');
    // respondeu: a Hipátia explica, e o cartão aparece nesta conversa
    await say(hipConv, 'oi, tô sim'); await drain(h, 3);
    const p = motor.started.at(-1)!;
    assert.match(p.instructions, /Você puxou conversa com a pessoa porque precisa dela nisto/);
    assert.match(p.instructions, new RegExp(`card #${t.number}`));
    const props = (await req(h, 'GET', `/api/proposals?conversationId=${hipConv}`, s)).json as Array<{ kind: string; status: string }>;
    assert.ok(props.some((x) => x.kind === 'info_request' && x.status === 'proposed'), 'o cartão para responder ali mesmo');
    assert.ok(h.db.get('SELECT answered_at FROM nudges WHERE item_key = ?', `card:${t.id}`)!.answered_at);
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', t.id);
  });

  test('Documentos: pastas, mover, renomear (a extensão fica), lixeira, restaurar, desfazer e prévia', async () => {
    const cli = (await req(h, 'POST', '/api/documents/folders', s, { name: 'Clientes' })).json;
    const acme = (await req(h, 'POST', '/api/documents/folders', s, { name: 'ACME', parentId: cli.id })).json;
    assert.equal((await req(h, 'POST', '/api/documents/folders', s, { name: 'acme', parentId: cli.id })).status, 409, 'nome repetido na mesma pasta');
    const f = (await upload('Prazo de entrega: 15 dias.', 'contrato-acme.txt', 'text/plain')).json;
    assert.ok((await req(h, 'GET', '/api/documents', s)).json.files.some((x: { id: string }) => x.id === f.id), 'sem pasta: raiz');
    await req(h, 'PATCH', `/api/artifacts/${f.id}`, s, { folderId: acme.id });
    const inAcme = (await req(h, 'GET', `/api/documents?folder=${acme.id}`, s)).json;
    assert.deepEqual(inAcme.path.map((x: { name: string }) => x.name), ['Clientes', 'ACME']);
    assert.ok(inAcme.files.some((x: { id: string }) => x.id === f.id));
    const ren = (await req(h, 'PATCH', `/api/artifacts/${f.id}`, s, { filename: 'Contrato final' })).json;
    assert.equal(h.db.get<{ filename: string }>('SELECT filename FROM artifacts WHERE id = ?', f.id)!.filename, 'Contrato final.txt');
    await req(h, 'POST', `/api/documents/undo/${ren.undo}`, s);
    assert.equal(h.db.get<{ filename: string }>('SELECT filename FROM artifacts WHERE id = ?', f.id)!.filename, 'contrato-acme.txt', 'desfeito');
    // pasta inteira para a lixeira e de volta
    await req(h, 'POST', '/api/documents/trash', s, { folderId: cli.id });
    const tr = (await req(h, 'GET', '/api/documents?folder=trash', s)).json;
    assert.ok(tr.files.some((x: { id: string }) => x.id === f.id)); assert.ok(tr.folders.some((x: { id: string }) => x.id === cli.id));
    await req(h, 'POST', '/api/documents/restore', s, { folderId: cli.id });
    assert.ok((await req(h, 'GET', `/api/documents?folder=${acme.id}`, s)).json.files.some((x: { id: string }) => x.id === f.id), 'voltou com tudo');
    // pasta automática fica
    const sys = h.db.get<{ id: string }>("SELECT id FROM folders WHERE workspace_id = ? AND system_key = 'conversas'", s.workspaceId)!;
    assert.equal((await req(h, 'POST', '/api/documents/trash', s, { folderId: sys.id })).status, 409);
    // prévia de texto
    const pv = (await req(h, 'GET', `/api/artifacts/${f.id}/preview`, s)).json;
    assert.equal(pv.kind, 'text'); assert.match(pv.text, /15 dias/);
    // esvaziar a lixeira apaga de vez
    const junk = (await upload('rascunho', 'rascunho.txt', 'text/plain')).json;
    await req(h, 'POST', '/api/documents/trash', s, { artifactId: junk.id });
    assert.equal((await req(h, 'POST', '/api/documents/trash/empty', s)).json.removed, 1);
    assert.equal(h.db.get('SELECT 1 AS x FROM artifacts WHERE id = ?', junk.id), undefined);
  });

  test('a coordenação organiza Documentos conversando, com desfazer na conversa', async () => {
    const c = await conv('aristoteles');
    motor.reply = () => 'Organizei para você. [[pasta caminho="Fornecedores/2026"]] [[mover-arquivo arquivo="contrato-acme.txt" para="Fornecedores/2026"]]';
    await say(c, 'cria a pasta Fornecedores/2026 e põe lá o contrato da ACME'); await drain(h, 3);
    motor.reply = () => 'Feito.';
    assert.match(motor.started.at(-1)!.instructions, /Documentos do workspace \(você gere pela conversa/);
    const notes = (await msgs(c)).filter((m) => m.role === 'system' && m.content.startsWith('Documentos — '));
    assert.equal(notes.length, 2);
    const moved = notes.find((m) => /movido para “Fornecedores\/2026”/.test(m.content));
    assert.ok(moved, 'a conversa diz o que mudou');
    const file = h.db.get<{ id: string; folder_id: string }>("SELECT id, folder_id FROM artifacts WHERE filename = 'contrato-acme.txt'")!;
    const path = (await req(h, 'GET', `/api/documents?folder=${file.folder_id}`, s)).json.path.map((x: { name: string }) => x.name);
    assert.deepEqual(path, ['Fornecedores', '2026']);
    const undoId = moved!.content.match(/\{\{desfazer:(aud_[a-f0-9]{32})\}\}/)![1];
    await req(h, 'POST', `/api/documents/undo/${undoId}`, s);
    const back = h.db.get<{ folder_id: string }>('SELECT folder_id FROM artifacts WHERE id = ?', file.id)!.folder_id;
    assert.deepEqual((await req(h, 'GET', `/api/documents?folder=${back}`, s)).json.path.map((x: { name: string }) => x.name), ['Clientes', 'ACME'], 'desfeito: voltou');
  });
});
