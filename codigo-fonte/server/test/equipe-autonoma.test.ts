/**
 * Equipe autônoma até a entrega (decisão de produto, 30/10/2026): o que trava um card volta para a equipe resolver —
 * a coordenação nas rodadas 1–2, o reforço (o modelo mais forte) nas 3–4 —, a ajuda vira etapa do MESMO card (uma
 * entrega, um card) e o texto passa inteiro entre as etapas. A pessoa só decide o que ela quer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PERSIST_ROUNDS, parseTrainRequests, stripControl, strongestOf } from '../src/services/teamwork.ts';
import { activeTeam } from '../src/services/team.ts';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class FakeMotor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  fails: (p: StartRun) => boolean = () => false;
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}_${this.started.length}`;
    this.runs.set(runId, this.fails(p)
      ? { status: 'failed', output: null, error: 'tempo esgotado (teste)', sessionId: 'sess-x', usage: null, model: null }
      : { status: 'completed', output: this.reply(p), error: null, sessionId: `sess-${p.sessionKey.slice(-12)}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'nous/teste-1' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: ['todo_list'] }]; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
class FakeControl implements HermesControlClient {
  async health() { return true; }
  async accounts() { return [{ id: 'nous', name: 'Nous Portal', connected: true, freeTier: false, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 's', userCode: 'A', verificationUrl: 'https://auth.example', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'approved', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: ['todo'], safe: ['todo'] }; }
  async setApiToolsets(e: string[]) { return e; }
}

/** um documento de verdade (passa na conferência de documento) */
const DOC = (head: string, fim = '') => `# ${head}\n\n${'Cláusula com o texto completo do contrato de licença de uso de marca, pronta para assinatura entre as partes. '.repeat(40)}${fim ? `\n\n${fim}` : ''}`;
const TRIAGE = /Você coordena a equipe\. Um card travou|como reforço para montar uma estratégia NOVA/;

describe('equipe autônoma: resolve sozinha até entregar, um card por entrega', () => {
  let h: Harness; let s: Session; let motor: FakeMotor; let st: any;
  const agent = (key: string) => st.agents.find((a: { char_key: string }) => a.char_key === key);
  const audits = (taskId: string, action: string) => h.db.all<{ evidence: string; result: string }>(
    'SELECT evidence, result FROM audit_events WHERE target_id = ? AND action = ? ORDER BY created_at', taskId, action).map((a) => ({ ...JSON.parse(a.evidence), result: a.result }));
  const run = async (n = 30) => { for (let i = 0; i < n; i++) { h.teamwork.tick(); await h.executor.tick(); } };
  const clean = () => { for (const x of h.db.all<{ id: string }>('SELECT id FROM tasks WHERE workspace_id = ? AND completed = 0', s.workspaceId)) h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', x.id); };
  const card = async (title: string, key: string) => {
    clean();
    const t = (await req(h, 'POST', '/api/tasks', s, { title, agentId: agent(key).id })).json;
    h.db.run('UPDATE tasks SET column_id = ? WHERE id = ?', h.db.get<{ id: string }>("SELECT id FROM columns WHERE board_id = ? AND name = 'A fazer'", t.board_id)!.id, t.id);
    return t as { id: string; number: number };
  };
  const detail = async (id: string) => (await req(h, 'GET', `/api/tasks/${id}`, s)).json;

  before(async () => {
    motor = new FakeMotor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, control: new FakeControl() });
    s = await setupOwner(h);
    st = (await req(h, 'GET', '/api/state', s)).json;
  });
  after(async () => { await h.close(); });

  test('pergunta sobre o trabalho: a coordenação responde, o agente segue e nada chega à pessoa', async () => {
    const t = await card('Contrato de licença de uso de marca, de 1 página, entre aurora.example e vertice.example', 'herodoto');
    motor.reply = (p) => TRIAGE.test(p.input) ? 'Os dados que não estão nos sites ficam como [PREENCHER]. Escreva o contrato completo agora, sem esperar.'
      : /respondeu ao que travou — siga isto: Os dados que não estão nos sites/.test(p.input) ? DOC('Contrato de licença de uso de marca')
      : 'Para redigir preciso do CNPJ das duas empresas. [[perguntar pergunta="Qual é o CNPJ da aurora.example e da vertice.example?"]]';
    await run();
    const d = await detail(t.id);
    assert.equal(d.task.completed, 1, 'entregue sem a pessoa');
    assert.equal(d.work.result.state, 'validado');
    const rounds = audits(t.id, 'task.persist');
    assert.equal(rounds.length, 1);
    assert.deepEqual([rounds[0].kind, rounds[0].by, rounds[0].stuck], ['pergunta', 'Aristóteles', 'Heródoto']);
    assert.equal(audits(t.id, 'task.persist_decision')[0].decision, 'instruir');
    const dec = (await req(h, 'GET', '/api/decisions', s)).json;
    assert.ok(!dec.cards.some((x: { id: string }) => x.id === t.id), 'nada em "aguardando você"');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?', t.id)!.n, 0, 'nenhum card a mais');
  });

  test('ajuda vira etapa do mesmo card; pedir de volta a quem pediu não vira pingue-pongue', async () => {
    const before = Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n);
    const t = await card('Comunicado sobre a licença de marca para os parceiros', 'herodoto');
    motor.reply = (p) => TRIAGE.test(p.input) ? '[[assumir]]\nTom formal e direto, com frases curtas e vocabulário simples, adequado a um comunicado entre empresas parceiras.'
      // a etapa de quem pediu (o plano também lista a etapa de ajuda: esta condição vem antes)
      : p.input.includes('O que as etapas anteriores entregaram') ? DOC('Comunicado aos parceiros')
      : p.input.includes('Ajuda a Heródoto') ? 'Preciso que o Heródoto me diga o público. [[pedir-ajuda agente="Heródoto" pedido="Qual é o público do texto?"]]'
      : 'Começo pelo texto. [[pedir-ajuda agente="Diógenes" pedido="Defina o tom do comunicado"]]';
    await run(2);
    let d = await detail(t.id);
    assert.deepEqual(d.steps.map((x: { agentId: string; status: string }) => [x.agentId, x.status]).slice(0, 2), [[agent('diogenes').id, d.steps[0].status], [agent('herodoto').id, 'pendente']]);
    assert.match(d.steps[0].title, /^Ajuda a Heródoto: Defina o tom do comunicado/);
    assert.equal(audits(t.id, 'task.help_step').length, 1);
    await run();
    d = await detail(t.id);
    assert.equal(Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n), before + 1, 'uma entrega, um card: nenhum card de ajuda');
    const p = audits(t.id, 'task.persist');
    assert.equal(p[0]?.kind, 'ajuda', 'a ajuda pedida de volta a quem pediu vai para a coordenação');
    assert.equal(audits(t.id, 'task.persist_decision')[0].decision, 'assumir');
    const last = motor.started.filter((x) => x.input.includes('O que as etapas anteriores entregaram')).at(-1)!;
    assert.match(last.input, /Tom formal e direto/, 'quem pediu continua com o que a coordenação fez');
    assert.equal(d.task.completed, 1);
  });

  test('reforço e limite: rodadas 3–4 com o modelo mais forte; depois, a pessoa fica sabendo (uma vez)', async () => {
    h.db.run('UPDATE agents SET model = ? WHERE id = ?', 'anthropic/claude-opus-5.5', agent('euclides').id);
    const t = await card('Pesquisar o que a verticelab.com vende e para quem', 'hipatia');
    motor.fails = (p) => !TRIAGE.test(p.input) && p.idempotencyKey.includes('queue-');
    motor.reply = () => 'Tente de novo começando pela página inicial e pela seção de produtos.';
    await run(80);
    motor.fails = () => false;
    const rounds = audits(t.id, 'task.persist');
    assert.equal(rounds.length, PERSIST_ROUNDS);
    assert.deepEqual(rounds.map((r) => r.by), ['Aristóteles', 'Aristóteles', 'Euclides', 'Euclides'], 'o reforço é quem tem o modelo mais forte');
    assert.match(rounds[2].result, /Euclides entra como reforço/);
    const d = await detail(t.id);
    assert.equal(d.task.completed, 0);
    assert.equal(d.work.result.state, 'falha', 'depois das rodadas, a falha chega a você, com o motivo');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)!.n, PERSIST_ROUNDS + 1);
    h.db.run('UPDATE agents SET model = NULL WHERE id = ?', agent('euclides').id);
  });

  test('texto longo passa inteiro entre as etapas e fica como arquivo do card; a entrega final leva o documento inteiro', async () => {
    clean();
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent('aristoteles').id })).json.id as string;
    const contrato = DOC('Contrato de licença', 'FIM-DO-CONTRATO').repeat(8); // ~40 mil caracteres
    motor.reply = (p) => p.input.startsWith('A equipe terminou') ? (p.input.includes('FIM-DO-CONTRATO') ? `Contrato final:\n${contrato}` : 'faltou o contrato')
      : p.input.includes('Sua etapa (1 de 2)') ? contrato
      : p.input.includes('Sua etapa (2 de 2)') ? (p.input.includes('FIM-DO-CONTRATO') ? DOC('Revisão: aprovado, sem cortes') : 'O texto chegou cortado.')
      : 'Heródoto escreve, Sócrates revisa.\n[[plano objetivo="Contrato de licença revisado"]]\n[[etapa agente="Heródoto" faz="Redigir o contrato; campos sem dado ficam como [PREENCHER]."]]\n[[etapa agente="Sócrates" faz="Revisar o contrato"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Quero um contrato de licença de marca revisado', clientRequestId: crypto.randomUUID() });
    await run(40);
    const t = h.db.get<{ id: string }>('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY number DESC LIMIT 1', conv)!;
    const d = await detail(t.id);
    assert.equal(d.task.completed, 1);
    assert.ok(d.files.deliverables.some((f: { filename: string }) => /^etapa1-herodoto-T\d+/.test(f.filename)), 'a entrega da etapa 1 ficou como arquivo do card');
    const msgs = (await req(h, 'GET', `/api/conversations/${conv}/messages`, s)).json as Array<{ role: string; content: string }>;
    const last = msgs[msgs.length - 1];
    assert.match(last.content, /^Contrato final:/, 'a entrega na conversa recebeu o documento inteiro');
  });

  test('ajuda pedida na conversa vira UM card, com os colegas como etapas', async () => {
    clean();
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent('aristoteles').id })).json.id as string;
    const before = Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n);
    motor.reply = (p) => p.input.includes('Sua etapa') || p.input.startsWith('A equipe terminou') ? DOC('Parte pronta')
      : 'Vou acionar a equipe. [[pedir-ajuda agente="Hipátia" pedido="Levantar os dados das duas empresas"]] [[pedir-ajuda agente="Euclides" pedido="Conferir os dados levantados"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Levante e confira os dados da aurora.example e da vertice.example', clientRequestId: crypto.randomUUID() });
    await run(4);
    assert.equal(Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n), before + 1, 'um card só');
    const t = h.db.get<{ id: string }>('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY number DESC LIMIT 1', conv)!;
    assert.deepEqual((await detail(t.id)).steps.map((x: { agentId: string }) => x.agentId), [agent('hipatia').id, agent('euclides').id]);
  });

  test('leitura: linha de controle com colchetes dentro, competência pedida pela coordenação e o reforço', () => {
    assert.equal(stripControl('Plano.\n[[etapa agente="Heródoto" faz="Campos sem dado ficam como [PREENCHER]."]]\nFim.'), 'Plano.\nFim.');
    assert.deepEqual(parseTrainRequests('Vou ensinar. [[treinar agente="Platão" competencia="Contratos de licença" pedido="Como redigir licença de uso de marca" links="https://a.example/x https://b.example"]]'),
      [{ agent: 'Platão', title: 'Contratos de licença', request: 'Como redigir licença de uso de marca', links: ['https://a.example/x', 'https://b.example'] }]);
    const team = activeTeam(h.db, s.workspaceId);
    assert.equal(strongestOf(h.db, s.workspaceId, team, [])?.name, 'Platão', 'sem modelo indicado, Platão');
    assert.notEqual(strongestOf(h.db, s.workspaceId, team, [agent('platao').id])?.name, 'Platão', 'nunca quem travou');
  });
});

describe('equipe autônoma: no modo simulado não há ciclo (nada de trabalho a refazer)', () => {
  test('entrega reprovada no simulado fica como está, sem rodadas', async () => {
    const h = await harness();
    const s = await setupOwner(h);
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const her = st.agents.find((a: { char_key: string }) => a.char_key === 'herodoto');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Redigir o comunicado de férias', agentId: her.id })).json;
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
    for (let i = 0; i < 10; i++) await h.executor.tick();
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE target_id = ? AND action = 'task.persist'", t.id)!.n, 0);
    await h.close();
  });
});
