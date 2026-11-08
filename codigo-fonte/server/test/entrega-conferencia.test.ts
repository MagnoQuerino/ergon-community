/**
 * Conferência pelas Conexões, segunda revisão: o pedido do dia a dia ("responde o João no Teams", "dá uma olhada no
 * Teams", "lê meus emails") é conferido pelo registro do serviço como o pedido formal; com uma conta conectada, o
 * card que cita o aplicativo ou cuja resposta afirma uma ação na conta nunca fecha pelo texto (rede de segurança);
 * "não consegui ler o Teams: as Conexões não estão habilitadas" é falha mesmo sem conta casada; envio de verdade que
 * fala de curso, manual ou rascunho continua sendo envio; pergunta, pesquisa e "me ajude a responder" não são envio;
 * a resposta a uma pergunta que pede um envio novo exige esse envio; e a leitura do Teams é uma por dia no workspace.
 * A Microsoft fica só "conectada" (nenhuma chamada sai para ela nestes testes).
 */
import assert from 'node:assert/strict';
import { afterEach, before, after, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { classifyTask, intencoesDoPedido, naoFeito } from '../src/services/results.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_confer${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

let h: Harness; let s: Session; let motor: Motor; let agente: string; let nAcao = 0;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const pausa = () => new Promise((ok) => setTimeout(ok, 5));
async function preparar(): Promise<void> {
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
  const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', agente)!.tools) as string[];
  if (!tools.includes('contas')) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, 'contas']), agente);
  h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
}
const conectarMicrosoft = () => setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
/** Um card da equipe posto para trabalhar; conversa: o pedido veio de uma conversa (a entrega vai para Aprovar). */
async function card(titulo: string, conversa = false): Promise<string> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  if (conversa) {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id as string;
    h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv, t.id);
  }
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  return t.id as string;
}
/** A execução atual do card termina com a saída dada; acao: o serviço registrou essa ação da Microsoft nela. */
async function terminar(taskId: string, output: string, acao?: string, status = 'feita'): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId)!;
  if (acao) {
    const agora = new Date().toISOString();
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, started_at, finished_at, ok) VALUES (?, ?, 0, 'conexoes_executar', ?, ?, 1)", s.workspaceId, r.id, agora, agora);
    h.db.run(`INSERT INTO conexao_acoes (id, workspace_id, run_id, agent_id, task_id, conexao, acao, risco, origem, decisao, status, resultado, created_at)
      VALUES (?, ?, ?, ?, ?, 'microsoft', ?, 'enviar', 'pessoa', 'direto', ?, 'Enviado a joao@empresa.test', ?)`, `cxa_confer_${++nAcao}`, s.workspaceId, r.id, agente, taskId, acao, status, agora);
  }
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
const resultado = (taskId: string) => h.db.get<{ state: string; justification: string; evidence: string }>(
  'SELECT state, justification, evidence FROM task_results WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId)!;
const estado = (taskId: string) => h.db.get<{ completed: number; work_state: string }>('SELECT completed, work_state FROM tasks WHERE id = ?', taskId)!;
const ids = (t: string) => intencoesDoPedido(h.db, s.workspaceId, t).map((i) => i.id);
const corpo = 'O texto traz o contexto, os números de 2024, as recomendações e os próximos passos para a equipe, com as fontes indicadas. '.repeat(4);

describe('R1: o pedido do dia a dia é conferido pelo registro do serviço', () => {
  before(async () => { await preparar(); conectarMicrosoft(); });
  after(() => h.close());

  test('formas coloquiais, "e-mail" no singular e endereço de e-mail', () => {
    for (const [p, quer] of [
      ['responde o João no teams que eu topo', 'teams.enviar'],
      ['fala pro João no Teams que a reunião mudou', 'teams.enviar'],
      ['avisa a equipe no Teams que a reunião mudou', 'teams.enviar'],
      ['dá uma olhada no teams e me diz o que tem de importante', 'teams.ler'],
      ['o que rolou no Teams hoje?', 'teams.ler'],
      ['checa o teams e me fala se o João respondeu', 'teams.ler'],
      ['responde o email do cliente confirmando a entrega', 'email.enviar'],
      ['lê meus emails de hoje e me resume', 'email.ler'],
      ['resume meus e-mails de hoje', 'email.ler'],
      ['Leia o último e-mail da Ana e me diga o que ela quer', 'email.ler'],
      ['Veja se a Ana respondeu meu e-mail', 'email.ler'],
      ['vê se chegou e-mail do banco', 'email.ler'],
      ['Envie a proposta para ana@empresa.com.br', 'email.enviar'],
      ['cria uma tarefa no Planner pra revisar o contrato', 'tarefa.criar'],
      ['marca uma reunião com a Carla amanhã', 'agenda.criar'],
    ] as const) assert.ok(ids(p).includes(quer), `${p} -> ${JSON.stringify(ids(p))}`);
  });

  test('o que a pessoa diz que o outro faz não é pedido ("o que o João responde")', () => {
    assert.deepEqual(ids('Me diga o que o cliente responde no Teams quando pergunto do prazo'), []);
    assert.deepEqual(ids('Veja o que a Ana fala no Teams sobre o prazo').filter((x) => x === 'teams.enviar'), []);
  });
});

describe('R1: ponta a ponta, sem nenhuma chamada à conexão', () => {
  beforeEach(async () => { await preparar(); conectarMicrosoft(); });
  afterEach(() => h.close());

  const CASOS: Array<[string, string]> = [
    ['responde o João no teams que eu topo', 'Respondi ao João no Teams dizendo que você topa a proposta e que podemos seguir com a reunião na quinta às dez horas, conforme ele sugeriu na última mensagem da conversa.'],
    ['dá uma olhada no teams e me diz o que tem de importante', 'Olhei o Teams: o João pediu o relatório até sexta, a Carla marcou a revisão do contrato para quinta e o time de vendas quer a planilha de metas atualizada até amanhã cedo.'],
    ['avisa a equipe no Teams que a reunião mudou para as 15h', 'Avisei a equipe no Teams que a reunião mudou para as 15h; a mensagem foi para o canal geral e todos podem ver a nova hora, com o link da sala de sempre e a pauta anexada.'],
  ];
  for (const [p, out] of CASOS) {
    test(`card do quadro: ${p} → falha, nunca concluído`, async () => {
      const t = await card(p); await terminar(t, out);
      const r = resultado(t);
      assert.equal(r.state, 'falha', r.justification);
      assert.match(r.justification, /não chegou a usar a conexão com Microsoft 365/);
      assert.equal(estado(t).completed, 0);
    });
    test(`card de conversa: ${p} → falha, nunca Aprovar`, async () => {
      const t = await card(p, true); await terminar(t, out);
      assert.equal(resultado(t).state, 'falha', resultado(t).justification);
      assert.notEqual(estado(t).work_state, 'aguardando_aprovacao');
    });
  }

  test('rede de segurança: pedido que cita o aplicativo, numa forma que a lista não conhece', async () => {
    const t = await card('resolve as pendências no Teams pra mim hoje, o João está esperando um retorno', true);
    await terminar(t, 'Tudo certo: o João recebeu o retorno no Teams, com a confirmação da reunião de quinta e o resumo do que combinamos na última conversa, como você queria.');
    const r = resultado(t);
    assert.equal(r.state, 'falha', r.justification);
    assert.match(r.justification, /não chegou a usar a conexão com Microsoft 365 para usar o Teams/);
  });

  test('rede de segurança: a resposta afirma uma ação na conta que o pedido não nomeou', async () => {
    const t = await card('fala com o João sobre a proposta de sexta');
    await terminar(t, 'Mandei a mensagem para o João no Teams dizendo que a proposta de sexta está de pé, que o valor ficou como combinado e que ele pode chamar você se tiver dúvida.');
    const r = resultado(t);
    assert.equal(r.state, 'falha', r.justification);
    assert.match(r.justification, /não chegou a usar a conexão com Microsoft 365 para usar o Teams/);
  });

  test('rede de segurança: com o registro do serviço, conclui', async () => {
    const t = await card('resolve as pendências no Teams pra mim hoje, o João está esperando um retorno');
    await terminar(t, 'O João recebeu o retorno no Teams, com a confirmação da reunião de quinta e o resumo do que combinamos na última conversa, como você queria.', 'teams.enviar');
    assert.equal(resultado(t).state, 'validado', resultado(t).justification);
  });

  test('rede de segurança não pega texto sobre o assunto nem uma pesquisa', async () => {
    for (const [p, out] of [
      ['Faça um relatório sobre o uso das mensagens do Teams na empresa', `Relatório: o Teams virou o canal principal da equipe. ${corpo}`],
      ['Compare o Teams e o Slack para uma equipe pequena', `Comparativo: o Teams vem junto da conta Microsoft; o Slack tem mais integrações. ${corpo}`],
    ]) {
      const t = await card(p); await terminar(t, out);
      assert.notEqual(resultado(t).state, 'falha', `${p}: ${resultado(t).justification}`);
    }
  });
});

describe('R2: "não consegui… as Conexões não estão habilitadas" é falha também sem conta casada', () => {
  afterEach(() => h.close());

  test('naoFeito no modo do que nenhuma conexão faz: a frase sobre as Conexões ou a conta vale; o banco não', () => {
    assert.ok(naoFeito('Não consegui responder o João no Teams porque não tenho acesso ao Teams entre as minhas ferramentas.', true));
    assert.ok(naoFeito('Não consegui ler suas conversas do Teams: as Conexões não estão habilitadas para mim. Assim que estiverem, eu leio e resumo.', true));
    assert.equal(naoFeito('Preparei o rascunho. Não tenho acesso ao seu banco, então falta você pagar.', true), null);
  });

  for (const ms of [false, true]) {
    test(`Microsoft ${ms ? 'conectada' : 'desconectada'}: dá uma olhada no Teams + "não consegui" → falha (quadro e conversa)`, async () => {
      await preparar(); if (ms) conectarMicrosoft();
      for (const conversa of [false, true]) {
        const t = await card('dá uma olhada no teams e me diz o que tem de importante', conversa);
        await terminar(t, 'Não consegui ler suas conversas do Teams: as Conexões não estão habilitadas para mim. Assim que estiverem liberadas no seu perfil, eu leio as conversas de hoje, separo o que é importante e trago o resumo para você aqui no card.');
        const r = resultado(t);
        assert.equal(r.state, 'falha', r.justification);
        assert.equal(estado(t).completed, 0);
      }
    });
  }

  test('sem conta: "não consegui ler o e-mail" num pedido de leitura → falha', async () => {
    await preparar();
    const t = await card('Leia o último e-mail da Ana e me diga o que ela quer', true);
    await terminar(t, 'Não consegui ler o e-mail da Ana porque não tenho acesso à sua caixa de entrada entre as minhas ferramentas. Se você colar o texto aqui, eu digo exatamente o que ela está pedindo e sugiro a resposta.');
    assert.equal(resultado(t).state, 'falha', resultado(t).justification);
    assert.equal(JSON.parse(resultado(t).evidence).honesta, 'declarou');
  });
});

describe('R3 e R4: envio de verdade continua envio; pergunta, pesquisa e ajuda para redigir não são', () => {
  before(async () => { await preparar(); conectarMicrosoft(); });
  after(() => h.close());

  test('envio que fala de curso, aula, manual, política, treinamento, "nunca", modelo ou rascunho', () => {
    for (const [p, quer] of [
      ['Envie um e-mail para a turma do curso avisando que a aula mudou para quinta', 'email.enviar'],
      ['Envie por e-mail ao cliente o manual do produto', 'email.enviar'],
      ['Mande um e-mail para o João dizendo que nunca mais vamos atrasar a entrega', 'email.enviar'],
      ['Mande no Teams para a equipe que o treinamento foi remarcado', 'teams.enviar'],
      ['Envie à Ana por e-mail a política de reembolso', 'email.enviar'],
      ['Mande por e-mail para a Ana o modelo de contrato que fizemos', 'email.enviar'],
      ['Envie o e-mail com o rascunho do contrato para a Ana revisar', 'email.enviar'],
      ['Envie um e-mail para a equipe sobre como usar o novo sistema', 'email.enviar'],
    ] as const) assert.ok(ids(p).includes(quer), `${p} -> ${JSON.stringify(ids(p))}`);
  });

  test('pergunta, pesquisa, explicação, "que eu mesmo vou mandar", "me ajude a" e o e-mail colado não são envio', () => {
    for (const p of [
      'Qual a melhor hora para enviar e-mails de marketing?',
      'Pesquise ferramentas para enviar e-mails em massa',
      'Faça um texto explicando por que devemos responder e-mails em 24 horas',
      'Me ajude a responder este e-mail que colei abaixo',
      'Escreva um e-mail de boas-vindas que eu mesmo vou mandar',
      'Leia o e-mail abaixo e me diga o que responder',
      'Liste as conversas do Teams que te mandei em anexo',
      'Escreva um rascunho de e-mail para a Ana sobre a reunião',
    ]) assert.deepEqual(ids(p), [], p);
    // a pergunta e a pesquisa sobre envio não são ação externa (a resposta vai para você aprovar)
    assert.notEqual(classifyTask('Qual a melhor hora para enviar e-mails de marketing?', false), 'externo');
    assert.notEqual(classifyTask('Pesquise ferramentas para enviar e-mails em massa', false), 'externo');
    assert.equal(classifyTask('Pode enviar a proposta ao cliente?', false), 'externo');
    // "me manda um resumo dos meus e-mails" é leitura, com a resposta aqui (não um envio)
    assert.ok(!ids('me manda um resumo dos meus e-mails de hoje').includes('email.enviar'));
    // o pedido educado continua pedido
    assert.ok(ids('Pode mandar um e-mail para o João dizendo que chego às 10?').includes('email.enviar'));
  });
});

describe('R3 e R4: ponta a ponta', () => {
  beforeEach(async () => { await preparar(); conectarMicrosoft(); });
  afterEach(() => h.close());

  test('envio que fala do curso, sem chamada → falha; nunca "Confirme no card quando estiver feito"', async () => {
    const t = await card('Envie um e-mail para a turma do curso avisando que a aula mudou para quinta');
    await terminar(t, 'Enviei o e-mail para a turma do curso avisando que a aula mudou para quinta, no mesmo horário e na mesma sala, e pedi que confirmem a presença respondendo a mensagem.');
    const r = resultado(t);
    assert.equal(r.state, 'falha', r.justification);
    assert.doesNotMatch(r.justification, /Confirme no card/);
  });

  test('a pergunta sobre e-mails vai para você aprovar, não vira falha "não usou a conexão"', async () => {
    const t = await card('Qual a melhor hora para enviar e-mails de marketing?', true);
    await terminar(t, `A melhor hora costuma ser entre 9h e 11h nos dias úteis. ${corpo}${corpo}`);
    const r = resultado(t);
    assert.equal(r.state, 'aguardando_aprovacao', r.justification);
  });
});

describe('R5: a resposta a uma pergunta que pede um envio novo exige esse envio', () => {
  beforeEach(async () => { await preparar(); conectarMicrosoft(); });
  afterEach(() => h.close());

  test('e-mail enviado, pergunta, "Sim, mande também para a Carla" sem registro novo → não conclui', async () => {
    const t = await card('Envie um e-mail para o João dizendo que a reunião foi adiada para sexta');
    await terminar(t, 'Enviei o e-mail ao João. [[perguntar pergunta="Quer que eu mande também para a Carla?"]]', 'email.enviar');
    assert.equal(resultado(t).state, 'aguardando_info', resultado(t).justification);
    await pausa();
    await req(h, 'POST', `/api/tasks/${t}/respond`, s, { action: 'answer', text: 'Sim, mande um e-mail também para a Carla' }); await tick();
    await pausa();
    await terminar(t, 'Pronto, tudo certo com o e-mail. A Carla também está a par do adiamento da reunião para sexta-feira, como você pediu na resposta.');
    const r = resultado(t);
    assert.equal(r.state, 'falha', r.justification);
    assert.match(r.justification, /pedido na sua resposta/);
  });

  test('com o envio novo registrado depois da resposta → conclui', async () => {
    const t = await card('Envie um e-mail para o João dizendo que a reunião foi adiada para sexta');
    await terminar(t, 'Enviei o e-mail ao João. [[perguntar pergunta="Quer que eu mande também para a Carla?"]]', 'email.enviar');
    await pausa();
    await req(h, 'POST', `/api/tasks/${t}/respond`, s, { action: 'answer', text: 'Sim, mande um e-mail também para a Carla' }); await tick();
    await pausa();
    await terminar(t, 'Enviado para a Carla também.', 'email.enviar');
    assert.equal(resultado(t).state, 'validado', resultado(t).justification);
  });

  test('a resposta que não pede nada novo mantém o episódio: o e-mail já enviado vale', async () => {
    const t = await card('Envie um e-mail para o João dizendo que a reunião foi adiada para sexta');
    await terminar(t, 'Enviei o e-mail ao João. [[perguntar pergunta="Quer que eu anote o adiamento no card?"]]', 'email.enviar');
    await pausa();
    await req(h, 'POST', `/api/tasks/${t}/respond`, s, { action: 'answer', text: 'Não precisa, obrigado' }); await tick();
    await pausa();
    await terminar(t, 'Combinado: o e-mail ao João já tinha saído com a nova data, sexta-feira, e não anotei mais nada no card, como você pediu.');
    assert.equal(resultado(t).state, 'validado', resultado(t).justification);
  });
});

describe('R6: a leitura do Teams é uma por dia no workspace, em todas as entradas', () => {
  afterEach(() => h.close());
  const ativa = (rid: string) => h.db.get("SELECT 1 AS x FROM routine_runs WHERE routine_id = ? AND status IN ('queued', 'gathering', 'running')", rid);
  const esperar = async (rid: string) => { for (let i = 0; i < 200 && ativa(rid); i++) { await tick(1); await new Promise((ok) => setTimeout(ok, 10)); } };

  test('"Executar agora" e depois o horário marcado no mesmo dia: o horário fica de fora, com o aviso', async () => {
    h = await harness(); s = await setupOwner(h);
    const r = await req(h, 'POST', '/api/routines', s, { template: 'teams-email-tarefas', tz: 'America/Sao_Paulo' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal((await req(h, 'POST', `/api/routines/${r.json.id}/run`, s, { clientRequestId: 'teams-r6-1' })).status, 202);
    await esperar(r.json.id);
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.json.id);
    await h.routines.tick();
    const rodadas = h.db.all<{ trigger: string; status: string; summary: string | null }>('SELECT trigger, status, summary FROM routine_runs WHERE routine_id = ? ORDER BY created_at, rowid', r.json.id);
    assert.equal(rodadas.filter((x) => !['missed', 'skipped'].includes(x.status)).length, 1, JSON.stringify(rodadas));
    const pulada = rodadas.find((x) => x.trigger === 'schedule')!;
    assert.equal(pulada.status, 'skipped');
    assert.equal(pulada.summary, 'O Teams já foi lido nas últimas 24 horas (uma leitura por dia): este horário ficou de fora.');
  });

  test('o horário marcado com a rodada anterior ainda aberta não abre outra', async () => {
    h = await harness(); s = await setupOwner(h);
    const r = await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    h.db.run(`INSERT INTO routine_runs (id, workspace_id, routine_id, version, trigger, slot, idempotency_key, status, requested_by, created_at)
      VALUES ('rrn_aberta1', ?, ?, 1, 'manual', NULL, 'manual:aberta1', 'running', NULL, ?)`, s.workspaceId, r.json.id, new Date().toISOString());
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.json.id);
    await h.routines.tick();
    const sched = h.db.get<{ status: string; summary: string }>("SELECT status, summary FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", r.json.id)!;
    assert.equal(sched.status, 'skipped');
    assert.equal(sched.summary, 'A rodada anterior ainda estava em andamento: este horário ficou de fora.');
  });

  test('duas rotinas que leem o Teams: a segunda não lê de novo no mesmo dia', async () => {
    h = await harness(); s = await setupOwner(h);
    const a = await req(h, 'POST', '/api/routines', s, { template: 'teams-email-tarefas', tz: 'America/Sao_Paulo' });
    const b = await req(h, 'POST', '/api/routines', s, { template: 'teams-email-tarefas', tz: 'America/Sao_Paulo' });
    assert.equal((await req(h, 'POST', `/api/routines/${a.json.id}/run`, s, { clientRequestId: 'dupla-a-1' })).status, 202);
    await esperar(a.json.id);
    const rb = await req(h, 'POST', `/api/routines/${b.json.id}/run`, s, { clientRequestId: 'dupla-b-1' });
    assert.equal(rb.status, 429, JSON.stringify(rb.json));
    assert.equal(rb.json.message, 'O Teams já foi lido nas últimas 24 horas por outra rotina (uma leitura por dia). Tente de novo amanhã.');
    // e o horário da segunda também fica de fora
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), b.json.id);
    await h.routines.tick();
    assert.equal(h.db.get<{ status: string }>("SELECT status FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", b.json.id)!.status, 'skipped');
  });
});
