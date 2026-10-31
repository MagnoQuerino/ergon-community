import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { parsePlan, questionIn } from '../src/services/purpose.ts';
import { parseChatCommand, parseProposals } from '../src/services/proposals.ts';
import { HELP_MAX, parseHelpRequests } from '../src/services/teamwork.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** Motor falso: devolve o que o teste mandar, pelo texto do pedido. */
class FakeMotor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 40)}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `s-${p.sessionKey.slice(-12)}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'nous/teste' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste', provider: 'nous', providers: [] }; }
}

const LONG = (what: string) => `${what}: ${'a Vértice Laboratórios monta e adapta laboratórios analíticos sob medida, com projeto, instalação e suporte. '.repeat(9)}`;
const agent = (st: any, key: string) => st.agents.find((a: { char_key: string }) => a.char_key === key);

/** entregue: concluído, ou entregue à pessoa e esperando a aprovação dela (decisão de 30/10: texto, documento e pesquisa vão para a aprovação) */
const entregue = (t: { completed: number; work_state?: string | null }) => Number(t.completed) === 1 || t.work_state === 'aguardando_aprovacao';

describe('o fio do pedido: o que o usuário pediu chega até a entrega', () => {
  let h: Harness; let s: Session; let motor: FakeMotor; let st: any;
  before(async () => {
    motor = new FakeMotor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h);
    st = { agents: await allAgents(h, s) };
    // só os cards deste teste no quadro
    for (const x of h.db.all<{ id: string }>('SELECT id FROM tasks WHERE workspace_id = ?', s.workspaceId)) h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', x.id);
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false }); // nada anda pela fila: o fio anda sozinho
  });
  after(async () => { await h.close(); });

  const conv = async (key: string) => (await req(h, 'POST', '/api/conversations', s, { agentId: agent(st, key).id })).json.id as string;
  const say = (c: string, text: string, extra: Record<string, unknown> = {}) => req(h, 'POST', `/api/conversations/${c}/messages`, s, { text, clientRequestId: crypto.randomUUID(), ...extra });
  const msgs = async (c: string) => (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ role: string; content: string; queued: number }>;
  const run = async (n = 12) => { for (let i = 0; i < n; i++) { await h.executor.tick(); } };

  test('leitura do plano, da pergunta, do apagar card e do limite de pedidos de ajuda', () => {
    const p = parsePlan('Vou organizar.\n[[plano objetivo="Resumo de 3 linhas sobre a Vértice"]]\n[[etapa agente="Hipátia" faz="Pesquisar empresas chamadas Vértice"]]\n[[etapa agente="Sócrates" faz="Resumir em 3 linhas"]]');
    assert.deepEqual({ objective: p?.objective, steps: p?.steps }, { objective: 'Resumo de 3 linhas sobre a Vértice', steps: [{ agent: 'Hipátia', task: 'Pesquisar empresas chamadas Vértice' }, { agent: 'Sócrates', task: 'Resumir em 3 linhas' }] });
    assert.equal(parsePlan('[[plano objetivo="Sem etapas"]]'), null, 'plano sem etapa não é plano');
    assert.equal(questionIn('Preciso saber. [[perguntar pergunta="Qual período?"]]'), 'Qual período?');
    assert.deepEqual(parseProposals('Ok. [[apagar-card numero="37" motivo="duplicado"]]'), [{ kind: 'delete_task', number: 37, reason: 'duplicado' }]);
    assert.deepEqual(parseChatCommand('Apague o card #12, está duplicado'), { kind: 'delete_task', number: 12, reason: 'está duplicado' });
    const all = Array.from({ length: 14 }, (_, i) => `[[pedir-ajuda agente="A${i}" pedido="parte ${i} do trabalho"]]`).join('\n');
    assert.equal(parseHelpRequests(all).length, HELP_MAX.agent);
    assert.equal(parseHelpRequests(all, HELP_MAX.coordinator).length, 12, 'o coordenador aciona a equipe inteira');
  });

  test('pedido na conversa não vira card sozinho; "/tarefa" vira, e a entrega volta para a conversa', async () => {
    const c = await conv('hesiodo');
    const before = Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE archived = 0')!.n);
    motor.reply = () => 'Feito: a pauta é abertura, números do mês e próximos passos, nessa ordem, com dez minutos para cada assunto.';
    await say(c, 'Preciso que você organize a pauta da reunião de sexta');
    await run(4);
    assert.equal(Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE archived = 0')!.n), before, 'o agente resolve na conversa (antes: virava card e a fila respondia de novo)');
    assert.ok((await msgs(c)).every((m) => !/interpretação por regras/.test(m.content)), 'sem nota de regras quando nada foi feito por regras');
    const r = await say(c, '/tarefa levantar as datas das reuniões do trimestre');
    assert.equal(r.status, 201);
    const t = h.db.get<{ conversation_id: string; deliver_agent_id: string; origin_run_id: string }>("SELECT conversation_id, deliver_agent_id, origin_run_id FROM tasks WHERE archived = 0 ORDER BY number DESC LIMIT 1")!;
    assert.equal(t.conversation_id, c, 'o card pedido explicitamente leva a conversa');
    assert.equal(t.deliver_agent_id, agent(st, 'hesiodo').id);
    assert.equal(t.origin_run_id, r.json.runId);
    await run(4);
  });

  test('A1: Aristóteles pede à Hipátia; quando ela responde, ele continua e entrega o que foi pedido, na conversa', async () => {
    const c = await conv('aristoteles');
    motor.reply = (p) => p.input.includes('Sua etapa (1 de 1)') ? LONG('Achei o site da Vértice')
      : p.input.startsWith('A equipe terminou') ? 'A Vértice projeta laboratórios analíticos sob medida.\nInstala e valida os equipamentos.\nDá suporte técnico contínuo.'
      : 'Vou pedir à Hipátia. [[pedir-ajuda agente="Hipátia" pedido="Investigue o site verticelab.com e diga o que a empresa faz"]]';
    await say(c, 'Faça um resumo de 3 linhas sobre o site verticelab.com');
    await run(2);
    // uma entrega, um card: o pedido de ajuda vira o card do pedido, com a Hipátia como etapa, e já começa
    const help = h.db.get<{ id: string; agent_id: string; conversation_id: string; purpose: string; number: number }>("SELECT id, agent_id, conversation_id, purpose, number FROM tasks WHERE archived = 0 ORDER BY number DESC LIMIT 1")!;
    assert.equal(help.agent_id, agent(st, 'hipatia').id);
    assert.equal(help.conversation_id, c);
    assert.match(help.purpose, /resumo de 3 linhas sobre o site/, 'o pedido do usuário fica gravado no card (cifrado no banco)');
    assert.ok((await msgs(c)).some((m) => m.role === 'system' && new RegExp(`card #${help.number} com o plano em 1 etapa`).test(m.content)));
    await run(8);
    assert.ok(entregue(h.db.get<{ completed: number; work_state: string }>('SELECT completed, work_state FROM tasks WHERE id = ?', help.id)!));
    const delivery = motor.started.find((p) => p.idempotencyKey.startsWith('ergon-entrega-'));
    assert.ok(delivery, 'quem recebeu o pedido continua sozinho');
    assert.match(delivery!.input, /Pedido do usuário: “Faça um resumo de 3 linhas sobre o site verticelab.com”/);
    assert.match(delivery!.input, /1\. Hipátia — Investigue o site verticelab\.com[^\n]*:\nAchei o site da Vértice/);
    const m = await msgs(c);
    const last = m[m.length - 1];
    assert.equal(last.role, 'agent', 'a entrega aparece como mensagem do Aristóteles');
    assert.match(last.content, /^A Vértice projeta laboratórios/);
    const log = (await req(h, 'GET', `/api/tasks/${help.id}`, s)).json;
    assert.ok(log.log.some((e: { action: string }) => e.action === 'task.delivery'));
    assert.equal(log.origin.delivered, true);
  });

  test('A2: o coordenador planeja; o card nasce com as etapas, cada uma recebe o que veio antes, e ele entrega', async () => {
    const c = await conv('aristoteles');
    motor.reply = (p) => {
      if (p.input.startsWith('A equipe terminou')) return 'Vértice: laboratórios analíticos sob medida.\nProjeto, instalação e validação.\nSuporte técnico contínuo.';
      if (p.input.includes('← a sua etapa') && p.input.includes('Sua etapa (1 de 3)')) return LONG('Lista: Vértice Laboratórios (laboratórios), Vértice Engenharia (obras)');
      if (p.input.includes('Sua etapa (2 de 3)')) return LONG('A mais provável é a Vértice Laboratórios');
      if (p.input.includes('Sua etapa (3 de 3)')) return 'Vértice monta laboratórios analíticos sob medida.\nProjeta, instala e valida.\nDá suporte técnico contínuo.';
      return 'Plano pronto: Hipátia pesquisa, Euclides escolhe e Sócrates resume; eu entrego aqui.\n[[plano objetivo="Resumo de 3 linhas sobre o que a Vértice faz"]]\n'
        + '[[etapa agente="Hipátia" faz="Pesquisar empresas chamadas Vértice e listar com o contexto do workspace"]]\n[[etapa agente="Euclides" faz="Escolher a mais provável"]]\n[[etapa agente="Sócrates" faz="Resumir em 3 linhas"]]';
    };
    await say(c, 'Quero um resumo de 3 linhas sobre o que a Vértice faz');
    await run(3);
    const t = h.db.get<{ id: string; number: number; agent_id: string }>("SELECT id, number, agent_id FROM tasks WHERE archived = 0 ORDER BY number DESC LIMIT 1")!;
    let card = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.equal(card.task.title, 'Resumo de 3 linhas sobre o que a Vértice faz');
    assert.deepEqual(card.steps.map((x: { agentId: string }) => x.agentId), [agent(st, 'hipatia').id, agent(st, 'euclides').id, agent(st, 'socrates').id]);
    assert.equal(card.origin.deliverAgentId, agent(st, 'aristoteles').id, 'quem recebeu o pedido entrega');
    assert.ok((await msgs(c)).some((m) => m.role === 'system' && new RegExp(`card #${t.number} com o plano em 3 etapa`).test(m.content)));
    await run(14);
    const inputs = motor.started.filter((p) => p.idempotencyKey.startsWith(`ergon-queue-${t.id}`)).map((p) => p.input);
    assert.equal(inputs.length, 3, 'uma execução por etapa, sem passar pela fila (andamento automático desligado)');
    assert.match(inputs[0], /Pedido do usuário \(o objetivo de todo o plano\): “Quero um resumo de 3 linhas/);
    assert.match(inputs[1], /O que as etapas anteriores entregaram:\n\[1\. Hipátia\]\nLista: Vértice Laboratórios/, 'a etapa 2 recebe o que a 1 entregou');
    assert.match(inputs[2], /\[2\. Euclides\]\nA mais provável/);
    card = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.ok(entregue(card.task), 'resumo curto no fim passa: o conteúdo conta o plano inteiro');
    assert.ok(card.steps.every((x: { status: string }) => x.status === 'feita'));
    const m = await msgs(c);
    assert.equal(m[m.length - 1].role, 'agent');
    assert.match(m[m.length - 1].content, /^Vértice: laboratórios analíticos/, 'Aristóteles entrega na conversa');
    const delivery = motor.started.find((p) => p.idempotencyKey === `ergon-entrega-${h.db.get<{ o: string }>('SELECT origin_run_id AS o FROM tasks WHERE id = ?', t.id)!.o}`)!;
    assert.match(delivery.input, /1\. Hipátia — Pesquisar empresas.*\n2\. Euclides/s);
  });

  test('A3/A6: a pergunta de uma etapa aparece na conversa como mensagem do agente; a resposta volta ao card e ele segue', async () => {
    const c = await conv('aristoteles');
    let answered = false;
    motor.reply = (p) => {
      if (p.input.startsWith('A equipe terminou')) return 'Número-base: 12 cards concluídos de 19 a 23/10.';
      // a pergunta passa antes pela coordenação: qual semana é decisão do usuário, então ela encaminha
      if (p.input.includes('Você coordena a equipe. Um card travou')) return '[[perguntar pergunta="Qual semana conta: de 19 a 23/10 ou de 26 a 30/10?"]]';
      if (p.input.includes('Sua etapa (1 de 1)')) {
        if (p.input.includes('A pessoa respondeu à sua pergunta: de 19 a 23/10')) { answered = true; return LONG('Contagem feita para 19 a 23/10: 12 concluídos'); }
        return 'Preciso de um dado. [[perguntar pergunta="Qual semana conta: de 19 a 23/10 ou de 26 a 30/10?"]]';
      }
      return 'Arquimedes conta.\n[[plano objetivo="Número-base da semana"]]\n[[etapa agente="Arquimedes" faz="Contar os cards concluídos na semana"]]';
    };
    await say(c, 'Quantos cards foram concluídos na semana?');
    await run(8);
    const t = h.db.get<{ id: string; number: number }>("SELECT id, number FROM tasks WHERE archived = 0 ORDER BY number DESC LIMIT 1")!;
    let m = await msgs(c);
    const ask = m.find((x) => x.role === 'agent' && /Preciso de uma informação sua para seguir com o card/.test(x.content));
    assert.ok(ask, 'o Aristóteles, que conferiu que só o usuário decide, pergunta como mensagem dele (não do usuário)');
    assert.equal(h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_id = ? AND action = 'task.persist_decision'", t.id)
      && JSON.parse(h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_id = ? AND action = 'task.persist_decision'", t.id)!.evidence).decision, 'perguntar à pessoa');
    assert.match(ask!.content, /Qual semana conta/);
    const props = (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json as Array<{ id: string; kind: string; status: string; payload: string }>;
    const card = props.find((p) => p.kind === 'info_request' && p.status === 'proposed')!;
    assert.equal(JSON.parse(card.payload).need, 'info');
    // também em "aguardando você", com a pergunta
    const dec = (await req(h, 'GET', '/api/decisions', s)).json;
    assert.ok(dec.cards.some((x: { id: string; need: string; question: string }) => x.id === t.id && x.need === 'info' && /Qual semana/.test(x.question)));
    assert.equal(dec.proposals.filter((p: { kind: string }) => p.kind === 'info_request').length, 0, 'o mesmo pedido não conta duas vezes');
    assert.equal((await req(h, 'GET', '/api/state', s)).json.decisionsPending, dec.total);
    // responde ali mesmo
    const r = await req(h, 'POST', `/api/proposals/${card.id}/respond`, s, { action: 'answer', text: 'de 19 a 23/10' });
    assert.equal(r.status, 200);
    assert.ok(r.json.runId, 'a resposta já põe o card para trabalhar');
    m = await msgs(c);
    assert.ok(m.some((x) => x.role === 'user' && x.content === 'de 19 a 23/10'), 'a resposta aparece como do usuário');
    await run(10);
    assert.ok(answered, 'o agente recebeu a resposta');
    assert.ok(entregue(h.db.get<{ completed: number; work_state: string }>('SELECT completed, work_state FROM tasks WHERE id = ?', t.id)!));
    m = await msgs(c);
    assert.match(m[m.length - 1].content, /^Número-base: 12 cards/);
    // o pedido da etapa foi respondido; o que sobra é a aprovação da entrega (texto vai para a aprovação da pessoa)
    assert.equal((await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json.filter((p: { kind: string; status: string; payload: string }) => p.kind === 'info_request' && p.status === 'proposed' && !JSON.parse(p.payload).review).length, 0);
  });

  test('aprovação pedida na conversa: aprovar ali conclui o card e quem recebeu o pedido entrega', async () => {
    const c = await conv('aristoteles');
    motor.reply = (p) => p.input.startsWith('A equipe terminou') ? 'Aqui está o comunicado aprovado.'
      : p.input.includes('Sua etapa (1 de 1)') ? LONG('# Comunicado\n\nTexto do comunicado')
      : 'Heródoto escreve.\n[[plano objetivo="Comunicado da linha nova"]]\n[[etapa agente="Heródoto" faz="Escrever o comunicado"]]';
    await say(c, 'Escreva o comunicado da linha nova');
    await run(3);
    const t = h.db.get<{ id: string }>("SELECT id FROM tasks WHERE archived = 0 ORDER BY number DESC LIMIT 1")!;
    h.db.run('UPDATE tasks SET requires_approval = 1 WHERE id = ?', t.id);
    await run(8);
    assert.equal(h.db.get<{ work_state: string }>('SELECT work_state FROM tasks WHERE id = ?', t.id)!.work_state, 'aguardando_aprovacao');
    const m = await msgs(c);
    assert.ok(m.some((x) => x.role === 'agent' && /está pronto e precisa da sua aprovação/.test(x.content)));
    const p = (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json.find((x: { kind: string; status: string }) => x.kind === 'info_request' && x.status === 'proposed');
    assert.equal(JSON.parse(p.payload).need, 'approval');
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}/respond`, s, { action: 'approve' })).status, 200);
    await run(4);
    assert.ok(entregue(h.db.get<{ completed: number; work_state: string }>('SELECT completed, work_state FROM tasks WHERE id = ?', t.id)!));
    const after = await msgs(c);
    assert.equal(after[after.length - 1].content, 'Aqui está o comunicado aprovado.');
  });

  test('A4: noutra conversa, o agente sabe como estão os pedidos feitos a outros agentes', async () => {
    const c = await conv('diogenes');
    const r = await say(c, 'Pedi ao Aristóteles o resumo da Vértice: como está?');
    const ins = h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE id = ?', r.json.runId)!.instructions;
    assert.match(ins, /Pedidos do usuário à equipe, de todas as conversas/);
    assert.match(ins, /“Resumo de 3 linhas sobre o que a Vértice faz” \(pedido a Aristóteles: “Quero um resumo de 3 linhas[^”]*”\): (?:concluído|entregue, esperando a aprovação do usuário[^.]*)\. Resultado: 1\. Hipátia/);
    await run(4);
  });

  // (o "apagar" virou "cancelar": o trabalho para e o card sai do quadro — ver cancelar.test.ts)
  test('A8: o coordenador propõe cancelar um card; só sai do quadro com a sua aprovação', async () => {
    const c = await conv('aristoteles');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Card duplicado de teste', agentId: agent(st, 'hesiodo').id })).json;
    motor.reply = () => `Esse card está duplicado.\n[[apagar-card numero="${t.number}" motivo="duplicado"]]`;
    await say(c, 'Esse card está sobrando, pode tirar?');
    await run(4);
    const p = (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json.find((x: { kind: string }) => x.kind === 'delete_task');
    assert.match(p.summary, new RegExp(`Cancelar o card #${t.number} “Card duplicado de teste”: duplicado`));
    assert.equal(h.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', t.id)!.archived, 0, 'nada muda antes da aprovação');
    assert.ok((await req(h, 'GET', '/api/decisions', s)).json.proposals.some((x: { id: string }) => x.id === p.id), 'aparece em "aguardando você"');
    const d = (await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json;
    assert.equal(d.status, 'applied');
    assert.equal(h.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', t.id)!.archived, 1);
    assert.ok((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.log.some((e: { action: string }) => e.action === 'task.cancelled'), 'o histórico fica');
  });

  test('D16: Ctrl+Enter põe a mensagem na fila da conversa; ela vai quando o agente termina', async () => {
    const c = await conv('fidias');
    motor.reply = (p) => `Resposta para: ${p.input}`;
    await say(c, 'primeira');
    assert.equal((await say(c, 'segunda')).status, 409, 'Enter com o agente respondendo: recusa, como antes');
    const q = await say(c, 'segunda', { queue: true });
    assert.equal(q.json.queued, true);
    assert.ok((await msgs(c)).some((m) => m.content === 'segunda' && m.queued === 1));
    await run(6);
    const m = await msgs(c);
    assert.ok(m.some((x) => x.content === 'Resposta para: segunda'), 'a mensagem da fila foi respondida');
    assert.ok(m.every((x) => !x.queued));
  });

  test('D17: conversas recentes pela última atividade (decisão de 30/10: com o ponto de não lida, a mensagem do agente também sobe)', async () => {
    const a = await conv('platao'); const b = await conv('herodoto');
    await say(a, 'Primeiro assunto com Platão'); await run(3);
    await say(b, 'Assunto com Heródoto'); await run(3);
    const ws = s.workspaceId;
    // o Platão escreve sozinho depois (uma entrega, por exemplo): sobe na lista e fica como não lida
    await req(h, 'POST', `/api/conversations/${a}/read`, s);
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES ('msg_teste_agente', ?, ?, 'agent', 'entrega', 'local', ?)", ws, a, new Date(Date.now() + 60_000).toISOString());
    const list = (await req(h, 'GET', '/api/conversations/recent', s)).json as Array<{ id: string; unread: number }>;
    assert.ok(list.findIndex((x) => x.id === a) < list.findIndex((x) => x.id === b));
    assert.equal(list.find((x) => x.id === a)!.unread, 1);
  });
});
