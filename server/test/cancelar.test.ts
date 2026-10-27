import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { parseChatCommand, parseProposals } from '../src/services/proposals.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** Motor falso: devolve o que o teste mandar, pelo pedido. */
class FakeMotor implements HermesClient {
  reply: (p: StartRun) => string = () => 'ok';
  runs = new Map<string, RemoteRun>();
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 40)}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `s-${p.sessionKey.slice(-12)}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'nous/teste' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste', provider: 'nous', providers: [] }; }
}

const LONG = `Resumo: ${'a Vértice Laboratórios monta e adapta laboratórios analíticos sob medida, com projeto, instalação e suporte. '.repeat(9)}`;
const agent = (st: any, key: string) => st.agents.find((a: { char_key: string }) => a.char_key === key);

test('a coordenação entende "cancelar": a linha de controle e a frase na conversa', () => {
  assert.deepEqual(parseProposals('Certo. [[cancelar-card numero="12" motivo="o usuário desistiu"]]'), [{ kind: 'delete_task', number: 12, reason: 'o usuário desistiu' }]);
  assert.deepEqual(parseProposals('[[apagar-card numero="7"]]'), [{ kind: 'delete_task', number: 7, reason: '' }], 'o nome antigo continua valendo');
  assert.deepEqual(parseChatCommand('Cancele a tarefa 12'), { kind: 'delete_task', number: 12, reason: '' });
  assert.deepEqual(parseChatCommand('pare o card #7 porque mudou o plano'), { kind: 'delete_task', number: 7, reason: 'mudou o plano' });
  assert.equal(parseChatCommand('Para o card #12, use os dados da planilha'), null, '"para o card…" é preposição, não ordem');
});

describe('cancelar um card: o trabalho para, ele sai do quadro e nada continua depois', () => {
  let h: Harness; let s: Session; let motor: FakeMotor; let st: any;
  before(async () => {
    motor = new FakeMotor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h);
    st = (await req(h, 'GET', '/api/state', s)).json;
    for (const x of h.db.all<{ id: string }>('SELECT id FROM tasks WHERE workspace_id = ?', s.workspaceId)) h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', x.id);
    await req(h, 'PUT', '/api/team/autorun', s, { enabled: false });
  });
  after(async () => { await h.close(); });

  const tick = async (n = 1) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
  const archived = (id: string) => Number(h.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', id)!.archived);
  const boards = async () => (await req(h, 'GET', '/api/boards', s)).json as Array<{ id: string; audience: string; origin: string }>;

  test('pelo próprio card: uma tarefa sua sai do quadro, e o card que ela mandou à equipe vai junto', async () => {
    const mine = (await boards()).find((b) => b.audience === 'user' && b.origin === 'native')!;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Levantar preços de colunas C18', boardId: mine.id })).json;
    const sent = (await req(h, 'POST', `/api/tasks/${t.id}/send-to-team`, s)).json;
    const detail = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.deepEqual(detail.children.map((c: { number: number }) => c.number), [sent.number], 'a tela sabe o que vai junto antes de confirmar');
    const r = await req(h, 'POST', `/api/tasks/${t.id}/cancel`, s, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.also, [sent.number]);
    assert.match(r.json.result, new RegExp(`card #${t.number} cancelado, com #${sent.number}`));
    assert.equal(archived(t.id), 1);
    assert.equal(Number(h.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE number = ? AND workspace_id = ?', sent.number, s.workspaceId)!.archived), 1);
    assert.ok((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.log.some((e: { action: string }) => e.action === 'task.cancelled'), 'o histórico fica');
    assert.equal((await req(h, 'POST', `/api/tasks/${t.id}/cancel`, s, {})).status, 404, 'cancelar de novo: já saiu');
  });

  test('cancelar o card da equipe: a sua tarefa fica, sem a etiqueta "equipe #N", e dá para enviar de novo', async () => {
    const mine = (await boards()).find((b) => b.audience === 'user' && b.origin === 'native')!;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Revisar o manual do GC', boardId: mine.id })).json;
    const sent = (await req(h, 'POST', `/api/tasks/${t.id}/send-to-team`, s)).json;
    const teamCard = h.db.get<{ id: string }>('SELECT id FROM tasks WHERE number = ? AND workspace_id = ?', sent.number, s.workspaceId)!;
    const row = async () => ((await req(h, 'GET', `/api/boards/${mine.id}`, s)).json.tasks as Array<{ id: string; team_number: number | null }>).find((x) => x.id === t.id)!;
    assert.equal((await row()).team_number, sent.number);
    assert.equal((await req(h, 'POST', `/api/tasks/${teamCard.id}/cancel`, s, {})).status, 200);
    assert.equal(archived(t.id), 0, 'a sua tarefa continua');
    assert.equal((await row()).team_number, null, 'a etiqueta do card cancelado some');
    assert.equal((await req(h, 'POST', `/api/tasks/${t.id}/send-to-team`, s)).status, 201, 'enviar de novo');
  });

  test('card de um plano cancelado com o agente trabalhando: a próxima etapa não começa e não há entrega', async () => {
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agent(st, 'aristoteles').id })).json.id as string;
    motor.reply = (p) => p.input.includes('Sua etapa') ? LONG
      : 'Vou organizar.\n[[plano objetivo="Resumo da Vértice"]]\n[[etapa agente="Hipátia" faz="Pesquisar a Vértice"]]\n[[etapa agente="Sócrates" faz="Resumir em 3 linhas"]]';
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Quero um resumo da Vértice', clientRequestId: crypto.randomUUID() });
    // até a primeira etapa estar com a Hipátia, trabalhando
    let card: { id: string; number: number } | undefined;
    for (let i = 0; i < 20 && !card; i++) {
      await tick();
      card = h.db.get<{ id: string; number: number }>("SELECT t.id, t.number FROM tasks t JOIN runs r ON r.task_id = t.id WHERE t.conversation_id = ? AND r.status = 'running'", c);
    }
    assert.ok(card, 'a primeira etapa começou');
    const r = await req(h, 'POST', `/api/tasks/${card.id}/cancel`, s, { reason: 'mudei de ideia' });
    assert.equal(r.status, 200);
    await tick(10);
    const runs = h.db.all<{ agent_id: string }>('SELECT agent_id FROM runs WHERE task_id = ?', card.id);
    assert.deepEqual(runs.map((x) => x.agent_id), [agent(st, 'hipatia').id], 'só a etapa que já estava andando; a do Sócrates não começou');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM task_steps WHERE task_id = ? AND position = 2', card.id)!.status, 'pendente', 'o plano não anda depois do cancelamento');
    assert.ok(!h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'task.step_done'", card.id), 'a etapa que terminou depois não é dada como entregue');
    assert.ok(!h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'task.delivery'", card.id), 'nada é entregue');
    const msgs = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ role: string; content: string }>;
    assert.ok(msgs.some((m) => m.role === 'system' && m.content === `Sistema — card #${card!.number} cancelado por você: mudei de ideia. O trabalho parou e não haverá entrega.`),
      'a conversa de onde veio fica sabendo');
    assert.ok(!msgs.some((m) => /parou|precisa de você|não passou/i.test(m.content) && m.role === 'agent'), 'nenhum pedido repassado depois do cancelamento');
  });

  test('a coordenação vê os cards abertos e cancela pelo assunto, com a sua aprovação', async () => {
    const team = (await boards()).find((b) => b.audience === 'team')!;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Comparar detectores FID e TCD', boardId: team.id, agentId: agent(st, 'hipatia').id })).json;
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agent(st, 'aristoteles').id })).json.id as string;
    motor.reply = () => `Certo, vou pedir para tirar esse card.\n[[cancelar-card numero="${t.number}" motivo="o usuário desistiu"]]`;
    const sent = await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Cancele a dos detectores, desisti', clientRequestId: crypto.randomUUID() });
    const ins = h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE id = ?', sent.json.runId)!.instructions;
    assert.match(ins, /Cards abertos agora/);
    assert.match(ins, new RegExp(`#${t.number} Comparar detectores FID e TCD — Hipátia`), 'acha o card pelo assunto');
    await tick(6);
    const p = (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json.find((x: { kind: string }) => x.kind === 'delete_task');
    assert.match(p.summary, new RegExp(`Cancelar o card #${t.number} “Comparar detectores FID e TCD”: o usuário desistiu`));
    assert.equal(archived(t.id), 0, 'nada muda antes da sua aprovação');
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json.status, 'applied');
    assert.equal(archived(t.id), 1);
  });

  test('"cancele o card #N" escrito para a coordenação vira a mesma proposta', async () => {
    const team = (await boards()).find((b) => b.audience === 'team')!;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Roteiro do vídeo de manutenção', boardId: team.id, agentId: agent(st, 'fidias').id })).json;
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: agent(st, 'aristoteles').id })).json.id as string;
    motor.reply = () => 'Ok.';
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: `cancele o card #${t.number}`, clientRequestId: crypto.randomUUID() });
    const p = (await req(h, 'GET', `/api/proposals?conversationId=${c}`, s)).json.find((x: { kind: string }) => x.kind === 'delete_task');
    assert.ok(p, 'proposta registrada, para aplicar ali na conversa');
    await tick(4);
  });
});
