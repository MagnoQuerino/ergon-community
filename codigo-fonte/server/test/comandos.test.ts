/**
 * Trabalho contínuo (rc.27): o equivalente, numa conversa ou num card, dos comandos /goal, /loop, /heartbeat, /btw e /review
 * do motor, que não passam pela API. Meta com juiz, repetir até cumprir, checagem periódica, comentar sem interromper e
 * revisão independente; e os atalhos digitados na conversa, com os nomes do Ergon e os originais, em qualquer idioma.
 * O motor é falso (fica "rodando" até o teste terminar a execução); o juiz e o pedido de revisão vêm de uma ponte falsa.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun, VereditoMeta } from '../src/services/hermes.ts';
import { parseComando, parseIntervalo } from '../src/services/comandos.ts';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  entradas: StartRun[] = [];
  comentarios: Array<{ run: string; texto: string }> = [];
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_cmd${String(++this.n).padStart(6, '0')}`;
    this.entradas.push(p);
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async steer(run: string, texto: string) { if (this.runs.get(run)?.status !== 'running') return false; this.comentarios.push({ run, texto }); return true; }
  async toolsets() { return [] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
class Ponte {
  vereditos: VereditoMeta[] = [];
  julgados: Array<{ meta: string; resposta: string }> = [];
  revisoes: Array<{ mensagens: Array<{ role: string; text: string }>; foco: string }> = [];
  async health() { return true; }
  async accounts() { return []; }
  async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(e: string[]) { return e; }
  async julgarMeta(meta: string, resposta: string): Promise<VereditoMeta> {
    this.julgados.push({ meta, resposta });
    return this.vereditos.shift() ?? { veredito: 'continue', motivo: 'ainda falta', continuar: `[Continuing toward your standing goal]\nGoal: ${meta}`, semJuiz: false };
  }
  async pedidoRevisao(mensagens: Array<{ role: 'user' | 'assistant'; text: string }>, foco: string) {
    this.revisoes.push({ mensagens, foco });
    return { titulo: 'Review', pedido: `PEDIDO DE REVISÃO DO MOTOR\n${mensagens.map((m) => `[${m.role}] ${m.text}`).join('\n')}\nFOCO: ${foco}` };
  }
}

let h: Harness; let s: Session; let agente: string; let motor: Motor; let ponte: Ponte;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const esperar = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
beforeEach(async () => {
  motor = new Motor(); ponte = new Ponte();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, control: ponte as unknown as HermesControlClient });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, 'aspasia')!.id;
});
afterEach(() => h.close());

const novaConversa = async () => (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
const dizer = (conv: string, text: string) => req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text, clientRequestId: `m-${crypto.randomUUID()}` });
const mensagens = (conv: string) => h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conv);
const execucoes = (conv: string) => h.db.all<{ id: string; status: string; hermes_run_id: string | null }>('SELECT id, status, hermes_run_id FROM runs WHERE conversation_id = ? ORDER BY created_at, rowid', conv);
const lista = async (conv: string) => (await req(h, 'GET', `/api/comandos?conversationId=${conv}`, s)).json.comandos as Array<Record<string, any>>;
/** O motor termina a execução em andamento da conversa com este texto (e o juiz, se houver meta, lê). */
async function responder(conv: string, output: string): Promise<void> {
  await tick();
  const r = execucoes(conv).find((x) => x.status === 'running')!;
  motor.runs.set(r.hermes_run_id!, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await tick();
  await esperar();
  await tick();
}

describe('atalhos digitados: os nomes do Ergon e os originais, em qualquer idioma', () => {
  test('lê o comando, o intervalo e o critério', () => {
    assert.deepEqual(parseComando('/meta entregar o relatório com três seções'), { tipo: 'meta', texto: 'entregar o relatório com três seções', intervaloS: null, criterio: null, parar: false });
    assert.equal(parseComando('/goal ship the report')!.tipo, 'meta');
    assert.equal(parseComando('/GOAL ship the report')!.tipo, 'meta');
    assert.deepEqual(parseComando('/repetir 30m confira a caixa de entrada até: chegar a resposta do cliente'),
      { tipo: 'repetir', texto: 'confira a caixa de entrada', intervaloS: 1800, criterio: 'chegar a resposta do cliente', parar: false });
    assert.deepEqual(parseComando('/loop every 2h check the inbox until: the client replied'), { tipo: 'repetir', texto: 'check the inbox', intervaloS: 7200, criterio: 'the client replied', parar: false });
    assert.deepEqual(parseComando('/heartbeat every 10 minutes veja se o site está no ar'), { tipo: 'checagem', texto: 'veja se o site está no ar', intervaloS: 600, criterio: null, parar: false });
    assert.equal(parseComando('/checagem a cada 1 dia confira os prazos')!.intervaloS, 86400);
    assert.equal(parseComando('/hb 90s ping')!.intervaloS, 90);
    assert.deepEqual(parseComando('/btw use o tom formal'), { tipo: 'comentar', texto: 'use o tom formal', intervaloS: null, criterio: null, parar: false });
    assert.equal(parseComando('/comentar use o tom formal')!.tipo, 'comentar');
    assert.equal(parseComando('/review confira os números')!.tipo, 'revisao');
    assert.equal(parseComando('/revisão')!.tipo, 'revisao');
    assert.deepEqual(parseComando('/meta parar'), { tipo: 'meta', texto: '', intervaloS: null, criterio: null, parar: true });
    assert.equal(parseComando('/goal stop')!.parar, true);
    assert.equal(parseComando('/checagem sem intervalo, só o pedido')!.intervaloS, null);
  });
  test('o que não é comando segue como mensagem', () => {
    assert.equal(parseComando('qual a meta do mês?'), null);
    assert.equal(parseComando('/desconhecido faça algo'), null);
    assert.equal(parseComando('veja /meta no meio do texto'), null);
    assert.equal(parseComando('/'), null);
    assert.equal(parseIntervalo('30 minutos'), 1800);
    assert.equal(parseIntervalo('2 horas'), 7200);
    assert.equal(parseIntervalo('amanhã'), null);
  });
});

describe('meta com juiz: o trabalho só termina quando o critério for cumprido', () => {
  test('/goal na conversa: o agente trabalha, o juiz do motor lê cada resposta e o trabalho segue até cumprir', async () => {
    const conv = await novaConversa();
    const r = await dizer(conv, '/goal entregar o relatório com três seções');
    assert.equal(r.json.comando.codigo, 'ligado');
    assert.equal(r.json.comando.tipo, 'meta');
    assert.equal(mensagens(conv).at(-1)!.content, 'Trabalhe até cumprir esta meta: entregar o relatório com três seções', 'a primeira rodada sai como mensagem sua');
    assert.ok(!mensagens(conv).some((m) => m.content.startsWith('/goal')), 'o atalho não vai ao agente como texto');
    assert.equal((await lista(conv))[0].status, 'ativo');

    ponte.vereditos.push({ veredito: 'continue', motivo: 'só há duas seções', continuar: '[Continuing toward your standing goal]\nGoal: entregar o relatório com três seções', semJuiz: false });
    await responder(conv, 'Segue o relatório, com introdução e análise.');
    assert.deepEqual(ponte.julgados, [{ meta: 'entregar o relatório com três seções', resposta: 'Segue o relatório, com introdução e análise.' }], 'o juiz leu o critério e a resposta');
    assert.match(mensagens(conv).at(-1)!.content, /Ainda não cumpriu a meta \(só há duas seções\)/, 'a rodada seguinte diz por quê');
    assert.equal(execucoes(conv).length, 2, 'e o agente continua sozinho');
    await tick();
    assert.match(motor.entradas.at(-1)!.instructions, /Continuing toward your standing goal/, 'com o texto de continuação do próprio motor');
    let c = (await lista(conv))[0];
    assert.equal(c.rodadas, 1); assert.equal(c.nota, 'só há duas seções');

    ponte.vereditos.push({ veredito: 'done', motivo: 'as três seções estão lá', continuar: '', semJuiz: false });
    await responder(conv, 'Agora com a conclusão.');
    c = (await lista(conv))[0];
    assert.equal(c.status, 'cumprido'); assert.equal(c.nota, 'as três seções estão lá');
    assert.equal(execucoes(conv).length, 2, 'cumprida: nenhuma rodada a mais');
    // depois de cumprida, as respostas seguintes não chamam mais o juiz
    await dizer(conv, 'obrigado');
    await responder(conv, 'De nada.');
    assert.equal(ponte.julgados.length, 2);
  });

  test('limite de rodadas, bloqueio e parar', async () => {
    const conv = await novaConversa();
    const r = (await req(h, 'POST', `/api/conversations/${conv}/comandos`, s, { tipo: 'meta', texto: 'zerar a fila', max: 2 })).json;
    assert.equal(r.codigo, 'ligado');
    await responder(conv, 'Fiz uma parte.');
    await responder(conv, 'Fiz mais uma parte.');
    assert.equal((await lista(conv))[0].rodadas, 2);
    await responder(conv, 'Ainda falta.');
    assert.equal((await lista(conv))[0].status, 'esgotado', 'acabaram as rodadas: para, sem gastar mais');
    assert.equal(execucoes(conv).length, 3);

    const conv2 = await novaConversa();
    await dizer(conv2, '/meta publicar o site');
    ponte.vereditos.push({ veredito: 'blocked', motivo: 'falta a senha do provedor', continuar: '', semJuiz: false });
    await responder(conv2, 'Preciso da senha do provedor.');
    const b = (await lista(conv2))[0];
    assert.equal(b.status, 'bloqueado'); assert.equal(b.nota, 'falta a senha do provedor');

    const conv3 = await novaConversa();
    await dizer(conv3, '/meta organizar a pasta');
    assert.equal((await dizer(conv3, '/meta parar')).json.comando.codigo, 'parado');
    assert.equal((await lista(conv3))[0].status, 'parado');
    await responder(conv3, 'Organizei metade.');
    assert.equal(ponte.julgados.filter((j) => j.meta === 'organizar a pasta').length, 0, 'parada: o juiz não é mais chamado');
    assert.equal((await dizer(conv3, '/goal stop')).json.comando.codigo, 'nada_a_parar');
  });

  test('sem juiz (motor de antes ou fora do ar): a meta para, em vez de gastar rodadas no escuro', async () => {
    const conv = await novaConversa();
    await dizer(conv, '/meta revisar o contrato');
    ponte.vereditos.push({ veredito: 'continue', motivo: '', continuar: '', semJuiz: true });
    await responder(conv, 'Revisei.');
    const c = (await lista(conv))[0];
    assert.equal(c.status, 'bloqueado'); assert.equal(c.nota, 'sem_juiz');
    assert.equal(execucoes(conv).length, 1);
  });

  test('comando de uma conversa: outra pessoa do workspace não consegue parar', async () => {
    const conv = await novaConversa();
    await dizer(conv, '/meta revisar o contrato');
    const c = (await lista(conv))[0];
    const b = await addPerson(h, 'bruna', 'senha-comprida-da-bruna-1');
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, b.userId, new Date().toISOString());
    assert.equal((await req(h, 'POST', '/api/session/workspace', b, { workspaceId: s.workspaceId })).status, 200);
    assert.equal((await req(h, 'DELETE', `/api/comandos/${c.id}`, b)).status, 404);
    assert.equal((await lista(conv))[0].status, 'ativo', 'continua ativo');
    assert.equal((await req(h, 'DELETE', `/api/comandos/${c.id}`, s)).json.ok, true, 'quem é dona para');
  });

  test('num card: a cada entrega o juiz lê; sem cumprir, o card volta à equipe com a instrução', async () => {
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Montar a proposta comercial', agentId: agente })).json;
    const r = (await req(h, 'POST', `/api/tasks/${t.id}/comandos`, s, { tipo: 'meta', texto: 'a proposta tem preço, prazo e validade' })).json;
    assert.equal(r.codigo, 'ligado');
    const det = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.equal(det.comandos.length, 1);
    assert.equal(det.comandos[0].kind, 'meta'); assert.equal(det.comandos[0].texto, 'a proposta tem preço, prazo e validade');
    assert.equal((await req(h, 'DELETE', `/api/comandos/${det.comandos[0].id}`, s)).json.ok, true);
    assert.equal((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.comandos[0].status, 'parado');
  });
});

describe('repetir até cumprir e checagem periódica: o relógio do Ergon', () => {
  test('/heartbeat: o pedido volta a cada intervalo, só com o trabalho parado, até o limite ou até você parar', async () => {
    const conv = await novaConversa();
    let agora = Date.now();
    h.comandos.setClock(() => agora);
    const r = await dizer(conv, '/heartbeat every 10 minutes veja se o site está no ar');
    assert.equal(r.json.comando.codigo, 'ligado');
    assert.equal(mensagens(conv).at(-1)!.content, 'veja se o site está no ar', 'a primeira checagem sai agora');
    let c = (await lista(conv))[0];
    assert.equal(c.kind, 'checagem'); assert.equal(c.intervalo_s, 600); assert.equal(c.rodadas, 1);
    assert.equal(h.comandos.tick(), 0, 'antes do intervalo: nada');
    agora += 601_000;
    assert.equal(h.comandos.tick(), 0, 'o agente ainda responde a anterior: esta volta passa');
    await responder(conv, 'No ar.');
    agora += 601_000;
    assert.equal(h.comandos.tick(), 1);
    assert.equal(mensagens(conv).filter((m) => m.role === 'user' && m.content === 'veja se o site está no ar').length, 2);
    await responder(conv, 'No ar.');
    c = (await lista(conv))[0];
    assert.equal(c.rodadas, 2);
    assert.equal(ponte.julgados.length, 0, 'checagem não tem juiz');
    assert.equal((await dizer(conv, '/checagem parar')).json.comando.codigo, 'parado');
    agora += 601_000;
    assert.equal(h.comandos.tick(), 0, 'parada: não volta mais');
  });

  test('/loop com critério: repete até o juiz dizer que cumpriu; e o limite de rodadas', async () => {
    const conv = await novaConversa();
    let agora = Date.now();
    h.comandos.setClock(() => agora);
    await dizer(conv, '/loop 5m confira a caixa de entrada até: chegou a resposta do cliente');
    let c = (await lista(conv))[0];
    assert.equal(c.kind, 'repetir'); assert.equal(c.intervalo_s, 300); assert.equal(c.criterio, 'chegou a resposta do cliente');
    ponte.vereditos.push({ veredito: 'continue', motivo: 'nada do cliente ainda', continuar: '', semJuiz: false });
    await responder(conv, 'Nada novo.');
    assert.equal(execucoes(conv).length, 1, 'sem cumprir, espera o intervalo (não emenda outra rodada)');
    agora += 301_000;
    assert.equal(h.comandos.tick(), 1);
    ponte.vereditos.push({ veredito: 'done', motivo: 'o cliente respondeu', continuar: '', semJuiz: false });
    await responder(conv, 'Chegou a resposta do cliente.');
    c = (await lista(conv))[0];
    assert.equal(c.status, 'cumprido'); assert.equal(c.nota, 'o cliente respondeu');
    agora += 301_000;
    assert.equal(h.comandos.tick(), 0);

    const conv2 = await novaConversa();
    await req(h, 'POST', `/api/conversations/${conv2}/comandos`, s, { tipo: 'repetir', texto: 'veja o estoque', intervaloS: 60, max: 2 });
    await responder(conv2, 'Estoque visto.');
    agora += 61_000; assert.equal(h.comandos.tick(), 1);
    await responder(conv2, 'Estoque visto.');
    agora += 61_000; assert.equal(h.comandos.tick(), 0);
    assert.equal((await lista(conv2))[0].status, 'esgotado');
  });

  test('pedido vazio ou intervalo fora do limite: recusados', async () => {
    const conv = await novaConversa();
    assert.equal((await req(h, 'POST', `/api/conversations/${conv}/comandos`, s, { tipo: 'checagem', texto: '' })).status, 400);
    assert.equal((await req(h, 'POST', `/api/conversations/${conv}/comandos`, s, { tipo: 'checagem', texto: 'x', intervaloS: 5 })).status, 400);
    assert.equal((await req(h, 'POST', `/api/conversations/${conv}/comandos`, s, { tipo: 'meta', texto: 'x', max: 500 })).status, 400);
    assert.equal((await req(h, 'POST', '/api/conversations/cnv_00000000000000000000000000000000/comandos', s, { tipo: 'meta', texto: 'x' })).status, 404);
  });
});

describe('comentar sem interromper', () => {
  test('/btw com o agente trabalhando: o comentário entra no trabalho em andamento, sem execução nova', async () => {
    const conv = await novaConversa();
    await dizer(conv, 'escreva a proposta');
    await tick();
    const r = await dizer(conv, '/btw use o tom formal');
    assert.equal(r.json.comando.codigo, 'entregue');
    assert.deepEqual(motor.comentarios.map((c) => c.texto), ['use o tom formal']);
    assert.equal(execucoes(conv).length, 1, 'nenhuma execução nova');
    assert.equal(execucoes(conv)[0].status, 'running', 'e a que estava segue');
    assert.deepEqual(mensagens(conv).at(-1), { role: 'system', content: 'Comentário entregue sem interromper: use o tom formal' });
  });
  test('sem trabalho em andamento: segue como mensagem normal', async () => {
    const conv = await novaConversa();
    const r = await dizer(conv, '/comentar use o tom formal');
    assert.equal(r.json.comando.codigo, 'sem_trabalho');
    assert.deepEqual(mensagens(conv).at(-1), { role: 'user', content: 'use o tom formal' });
    assert.equal(motor.comentarios.length, 0);
  });
});

describe('revisão independente', () => {
  test('/review: um colega que não fez o trabalho revisa numa sessão separada, com o pedido do motor, e o parecer volta para a conversa', async () => {
    const conv = await novaConversa();
    await dizer(conv, 'faça a proposta comercial');
    await responder(conv, 'Segue a proposta: preço de 10 mil, prazo de 30 dias.');
    const r = await dizer(conv, '/review confira os números');
    assert.equal(r.json.comando.codigo, 'pedida');
    assert.deepEqual(ponte.revisoes[0].mensagens, [{ role: 'user', text: 'faça a proposta comercial' }, { role: 'assistant', text: 'Segue a proposta: preço de 10 mil, prazo de 30 dias.' }]);
    assert.equal(ponte.revisoes[0].foco, 'confira os números');
    const rev = h.db.get<{ id: string; agent_id: string; conversation_id: string | null; task_id: string | null; input: string; hermes_run_id: string | null }>("SELECT * FROM runs WHERE idempotency_key LIKE 'comando-revisao-%'")!;
    assert.notEqual(rev.agent_id, agente, 'o revisor é outro colega');
    assert.equal(rev.conversation_id, null, 'numa sessão separada (não herda a conversa)');
    assert.match(rev.input, /^PEDIDO DE REVISÃO DO MOTOR/);
    assert.equal((await lista(conv))[0].status, 'ativo');
    await tick();
    const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', rev.id)!.hermes_run_id;
    motor.runs.set(remoto, { status: 'completed', output: 'O preço não fecha com a tabela: revise antes de enviar.', error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
    await tick(); await esperar();
    const quem = h.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', rev.agent_id)!.name;
    assert.deepEqual(mensagens(conv).at(-1), { role: 'system', content: `Revisão independente, por ${quem}:\n\nO preço não fecha com a tabela: revise antes de enviar.` });
    const c = (await lista(conv))[0];
    assert.equal(c.kind, 'revisao'); assert.equal(c.status, 'cumprido');
    assert.equal(c.nota, `${quem}\nO preço não fecha com a tabela: revise antes de enviar.`);
  });
  test('sem trabalho entregue: não há o que revisar', async () => {
    const conv = await novaConversa();
    const r = await dizer(conv, '/review');
    assert.equal(r.status, 409);
  });
});
