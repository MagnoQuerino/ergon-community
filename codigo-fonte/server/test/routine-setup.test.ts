// Ativação adaptativa das rotinas: a coordenação estuda o jeito de trabalhar do usuário e ajusta a rotina antes de
// ligar (pergunta só se precisar); sem conta de IA, o Ergon faz o melhor ajuste sozinho. Pronta, roda a primeira vez.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { earlyTime, heuristicAdaptation, parseSetupReply } from '../src/services/routine-setup.ts';
import { templateByKey } from '../src/services/routine-catalog.ts';
import { id } from '../src/lib/util.ts';
import { throttle } from '../src/security/factors.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SP = 'America/Sao_Paulo';

test('ajuste do Ergon sem modelo: briefing antes do início do dia, foco nos temas que mais aparecem', () => {
  const t = templateByKey('briefing-diario')!;
  assert.equal(earlyTime(9.5, '08:00'), '09:15');
  assert.equal(earlyTime(5, '08:00'), '06:00', 'nunca antes das 6');
  assert.equal(earlyTime(null, '08:00'), '08:00');
  const a = heuristicAdaptation(t, { facts: '', startHour: 9.5, weekdays: [1, 2, 3, 4, 5], themes: ['proposta', 'cliente', 'contrato', 'nota'], connected: [], richness: 'bastante' }, SP);
  assert.deepEqual(a.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '09:15', tz: SP });
  assert.match(a.extra ?? '', /proposta, cliente, contrato/);
  const none = heuristicAdaptation(t, { facts: '', startHour: null, weekdays: [], themes: [], connected: [], richness: 'nada' }, SP);
  assert.equal(none.extra, undefined); assert.match(none.summary, /padrão/);
});

test('resposta do preparo: configuração e perguntas (no máximo 2, com 2 a 4 opções)', () => {
  const r = parseSetupReply('Percebi X.\n[[configurar-rotina quando="seg a sex 07:40" ajuste="Foque em propostas." parada="2" resumo="mais cedo e focado"]]', SP);
  assert.deepEqual(r.config?.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '07:40', tz: SP });
  assert.equal(r.config?.extra, 'Foque em propostas.'); assert.equal(r.config?.staleDays, 2);
  const qs = parseSetupReply('[[perguntar pergunta="Foco?" opcoes="Clientes|Equipe"]] [[perguntar pergunta="Só uma" opcoes="A"]] [[perguntar pergunta="Tom?" opcoes="Curto|Detalhado|Com números"]] [[perguntar pergunta="3ª" opcoes="X|Y"]]', SP);
  assert.deepEqual(qs.questions.map((q) => q.question), ['Foco?', 'Tom?']);
});

describe('preparo sem conta de IA', () => {
  let h: Harness; let s: Session;
  before(async () => { throttle.reset(); h = await harness(); s = await setupOwner(h, 'alexandre', 'senha-local-123'); });
  after(async () => { await h.close(); });

  test('ativar: o Ergon ajusta pelo ritmo do usuário, liga e já roda a primeira', async () => {
    // o usuário costuma começar por volta das 9h30 (horário de São Paulo)
    const agent = (await allAgents(h, s)).find((a: { char_key: string }) => a.char_key === 'hesiodo').id;
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent })).json.id;
    for (let d = 1; d <= 5; d++) {
      const at = new Date(Date.UTC(2026, 9, 19 + d, 12, 30)).toISOString(); // 09:30 em São Paulo
      h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'local', ?)",
        id('msg'), s.workspaceId, conv, s.userId, 'Preciso da proposta do cliente Acme revisada', at);
    }
    const r = await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: SP, adapt: true, extra: 'Comece pelas decisões.' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const st = (await req(h, 'GET', `/api/routines/${r.json.id}/setup`, s)).json;
    assert.equal(st.setup.status, 'ready');
    assert.equal(st.routine.status, 'active');
    assert.equal(st.routine.schedule, 'Seg a sex às 09:15', 'chega 15 min antes de ele começar');
    assert.match(st.routine.config.extra, /^Comece pelas decisões\./, 'a dica do usuário vale');
    assert.equal(st.setup.adapted.source, 'ergon');
    assert.ok(st.firstRun, 'primeira execução');
    assert.equal(st.firstRun.status, 'succeeded');
    const msgs = (await req(h, 'GET', `/api/conversations/${st.setup.conversationId}/messages`, s)).json;
    assert.ok(msgs.some((m: { content: string }) => /conta de IA conectada/.test(m.content)), 'diz o que muda com a conta de IA');
  });
});

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${this.started.length}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `sess-${this.started.length}`, usage: { inputTokens: 300, outputTokens: 80, costUsd: null }, model: 'x/y' });
    return { runId, replayed: false };
  }
  async getRun(rid: string) { return this.runs.get(rid)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'x/y', provider: 'nous', providers: [] }; }
}

describe('preparo com a coordenação (modelo)', () => {
  let h: Harness; let s: Session; let motor: Motor;
  const settle = async () => { for (let i = 0; i < 6; i++) await h.executor.tick(); };
  before(async () => {
    throttle.reset(); motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h, 'alexandre', 'senha-local-123');
    motor.reply = (p) => {
      if (/^Preparo da rotina "Briefing Diário"/.test(p.input)) return 'Vi que você trabalha muito com propostas comerciais e escreve curto.\n[[configurar-rotina quando="seg a sex 07:40" ajuste="Comece pelas propostas comerciais em aberto; frases curtas." parada="2" resumo="mais cedo, focado em propostas"]]';
      if (/^Preparo da rotina "Supervisor de Projetos"/.test(p.input)) return 'Antes de ligar, duas escolhas.\n[[perguntar pergunta="O que mais importa?" opcoes="Prazos de clientes|Carga da equipe"]]\n[[perguntar pergunta="Quantos dias até considerar parada?" opcoes="2 dias|5 dias"]]';
      if (/^Minhas respostas/.test(p.input)) return 'Combinado.\n[[configurar-rotina quando="seg e qui 09:00" ajuste="Priorize prazos de clientes." parada="5" resumo="prazos de clientes primeiro"]]';
      if (/mude para as 9h/.test(p.input)) return 'Feito.\n[[configurar-rotina quando="seg a sex 09:00" resumo="agora às 9h"]]';
      if (/^Rotina "/.test(p.input)) return 'Primeira execução: tudo certo por aqui.';
      return 'ok';
    };
  });
  after(async () => { await h.close(); });

  test('estudo silencioso → ajuste → ativa e roda a primeira', async () => {
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: SP, adapt: true })).json;
    assert.equal(r.status, 'setup', 'em preparo enquanto estuda');
    let st = (await req(h, 'GET', `/api/routines/${r.id}/setup`, s)).json;
    assert.equal(st.setup.status, 'studying');
    await settle();
    const study = motor.started.find((p) => p.input.startsWith('Preparo da rotina'))!;
    assert.match(study.input, /\[Ritmo\]/); assert.match(study.input, /\[Como se comunica\]/);
    assert.match(study.instructions ?? '', /configurar-rotina/); assert.match(study.instructions ?? '', /perguntar/);
    st = (await req(h, 'GET', `/api/routines/${r.id}/setup`, s)).json;
    assert.equal(st.setup.status, 'ready'); assert.equal(st.setup.adapted.source, 'ia');
    assert.equal(st.routine.status, 'active'); assert.equal(st.routine.schedule, 'Seg a sex às 07:40');
    assert.equal(st.routine.config.extra, 'Comece pelas propostas comerciais em aberto; frases curtas.');
    assert.equal(st.routine.config.staleDays, 2); assert.equal(st.routine.version, 2);
    assert.equal(st.firstRun.status, 'succeeded'); assert.match(st.firstRun.output, /Primeira execução/);
    assert.ok(motor.started.some((p) => /Comece pelas propostas comerciais/.test(p.instructions ?? '')), 'a primeira já usa o ajuste');
    // depois de pronta, pedir mudança na conversa de preparo vale na hora (versão nova)
    await req(h, 'POST', `/api/conversations/${st.setup.conversationId}/messages`, s, { text: 'mude para as 9h', clientRequestId: 'mudar-9h-001' });
    await settle();
    const after2 = (await req(h, 'GET', `/api/routines/${r.id}`, s)).json;
    assert.equal(after2.schedule, 'Seg a sex às 09:00'); assert.equal(after2.version, 3);
    assert.equal(after2.config.extra, 'Comece pelas propostas comerciais em aberto; frases curtas.', 'o resto fica');
  });

  test('com dúvidas: pergunta com opções, as respostas voltam juntas e não viram tarefa', async () => {
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'supervisor-projetos', tz: SP, adapt: true })).json;
    await settle();
    let st = (await req(h, 'GET', `/api/routines/${r.id}/setup`, s)).json;
    assert.equal(st.setup.status, 'asking'); assert.equal(st.setup.pendingQuestions, 2); assert.equal(st.routine.status, 'setup');
    const qs = (await req(h, 'GET', `/api/proposals?conversationId=${st.setup.conversationId}`, s)).json.filter((p: { kind: string }) => p.kind === 'question');
    assert.deepEqual(JSON.parse(qs.find((q: { summary: string }) => q.summary === 'O que mais importa?').payload).options, ['Prazos de clientes', 'Carga da equipe']);
    const tasks = (await req(h, 'GET', '/api/state', s)).json;
    const before = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?', s.workspaceId)!.n;
    const first = await req(h, 'POST', `/api/proposals/${qs[0].id}/answer`, s, { answer: qs[0].summary === 'O que mais importa?' ? 'Prazos de clientes' : '5 dias' });
    assert.equal(first.json.sent, false, 'espera a outra resposta');
    const second = await req(h, 'POST', `/api/proposals/${qs[1].id}/answer`, s, { answer: qs[1].summary === 'O que mais importa?' ? 'Prazos de clientes' : '5 dias' });
    assert.equal(second.json.sent, true);
    assert.equal((await req(h, 'POST', `/api/proposals/${qs[1].id}/answer`, s, { answer: 'de novo' })).status, 409);
    await settle();
    const ans = motor.started.find((p) => p.input.startsWith('Minhas respostas'))!;
    assert.match(ans.input, /O que mais importa\? → Prazos de clientes/);
    assert.match(ans.instructions ?? '', /acabou de responder/);
    st = (await req(h, 'GET', `/api/routines/${r.id}/setup`, s)).json;
    assert.equal(st.setup.status, 'ready'); assert.equal(st.routine.schedule, 'Seg e qui às 09:00'); assert.equal(st.routine.config.staleDays, 5);
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?', s.workspaceId)!.n, before, 'as respostas não viram tarefa');
    assert.ok(tasks);
  });
});
