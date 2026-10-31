// Rotinas: biblioteca, ativação, execução (com e sem modelo), condição que economiza modelo, agenda com fuso,
// recuperação depois de reinício, criação e ajuste pela conversa e recomendação com base de recusas.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { nextOccurrence, parseWhen, scheduleText } from '../src/services/routine-time.ts';
import { routineProposalsFrom } from '../src/services/routine-proposals.ts';
import { stripControl } from '../src/services/teamwork.ts';
import { throttle } from '../src/security/factors.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SP = 'America/Sao_Paulo';

describe('horários das rotinas (fuso do usuário)', () => {
  test('próximo horário: dias úteis às 08:00 em São Paulo', () => {
    const t = { kind: 'schedule' as const, days: [1, 2, 3, 4, 5], time: '08:00', tz: SP };
    assert.equal(nextOccurrence(t, new Date('2026-10-26T10:00:00Z')), '2026-10-26T11:00:00.000Z', 'segunda 07:00 local → hoje às 08:00');
    assert.equal(nextOccurrence(t, new Date('2026-10-26T11:00:00Z')), '2026-10-27T11:00:00.000Z', 'no horário exato → o próximo');
    assert.equal(nextOccurrence(t, new Date('2026-10-30T12:00:00Z')), '2026-11-02T11:00:00.000Z', 'sexta depois das 08:00 → segunda');
    assert.equal(nextOccurrence({ kind: 'manual' }, new Date()), null);
  });
  test('horário de verão (Nova York): segunda às 09:00 depois da troca', () => {
    assert.equal(nextOccurrence({ kind: 'schedule', days: [1], time: '09:00', tz: 'America/New_York' }, new Date('2026-10-31T12:00:00Z')), '2026-11-02T14:00:00.000Z');
  });
  test('"quando" em português e o texto de volta', () => {
    assert.deepEqual(parseWhen('dias úteis 8h', SP), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00', tz: SP });
    assert.deepEqual(parseWhen('toda sexta-feira às 17:30', SP), { kind: 'schedule', days: [5], time: '17:30', tz: SP });
    assert.deepEqual(parseWhen('seg e qui 10h', SP), { kind: 'schedule', days: [1, 4], time: '10:00', tz: SP });
    assert.deepEqual(parseWhen('todo dia 7:30', SP), { kind: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '07:30', tz: SP });
    assert.deepEqual(parseWhen('sob demanda', SP), { kind: 'manual' });
    assert.equal(scheduleText({ kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00', tz: SP }), 'Seg a sex às 08:00');
    assert.equal(scheduleText({ kind: 'schedule', days: [5], time: '17:30', tz: SP }), 'Toda sexta às 17:30');
    assert.equal(scheduleText({ kind: 'schedule', days: [1, 4], time: '10:00', tz: SP }), 'Seg e qui às 10:00');
    assert.equal(scheduleText({ kind: 'manual' }), 'Quando você pedir');
  });
});

describe('rotinas sem modelo de IA (simulação)', () => {
  let h: Harness; let s: Session;
  before(async () => { throttle.reset(); h = await harness(); s = await setupOwner(h, 'alexandre', 'senha-local-123'); });
  after(async () => { await h.close(); });

  test('biblioteca: as 24 rotinas prontas, com o que cada uma pede e o que falta conectar', async () => {
    const lib = (await req(h, 'GET', '/api/routines/library', s)).json;
    assert.equal(lib.routines.length, 24);
    assert.ok(lib.routines.every((r: { available: boolean }) => r.available), 'fases 1 a 5: todas funcionam');
    const plan = lib.routines.find((r: { key: string }) => r.key === 'planejador-projetos');
    assert.equal(plan.input.text.required, true, 'pede o objetivo na hora de executar');
    assert.equal(plan.proposes, 'tarefas');
    const news = lib.routines.find((r: { key: string }) => r.key === 'radar-noticias');
    assert.deepEqual(news.params.map((p: { key: string }) => p.key), ['termos', 'feeds'], 'configura uma vez o que acompanhar');
    const radar = lib.routines.find((r: { key: string }) => r.key === 'radar-compromissos');
    assert.equal(radar.privateData, true);
    assert.ok(radar.needs.some((n: { id: string; ok: boolean }) => n.id === 'email' && !n.ok), 'mostra o que falta conectar');
    const brief = lib.routines.find((r: { key: string }) => r.key === 'briefing-diario');
    assert.equal(brief.schedule, 'Seg a sex às 08:00');
    assert.ok(brief.sample.length > 50, 'exemplo do resultado');
  });

  test('ativar: horário padrão no fuso do usuário; modelo ainda não pronto não ativa', async () => {
    const r = await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: SP });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.schedule, 'Seg a sex às 08:00');
    assert.ok(r.json.nextRunAt > new Date().toISOString());
    // rotina que acompanha algo (termos, contratos) ativa e diz o que falta configurar
    const radar = await req(h, 'POST', '/api/routines', s, { template: 'radar-noticias' });
    assert.equal(radar.status, 201); assert.deepEqual(radar.json.missing, ['Assuntos e palavras-chave']);
    assert.equal((await req(h, 'DELETE', `/api/routines/${radar.json.id}`, s)).status, 200);
    assert.equal((await req(h, 'POST', '/api/routines', s, { template: 'nao-existe' })).status, 404);
    assert.equal((await req(h, 'POST', '/api/routines', null, { template: 'briefing-diario' })).status, 401);
  });

  test('executar agora sem conta de IA: o Ergon monta o resumo (dizendo que é sem modelo) e entrega na conversa e em arquivo', async () => {
    const [rt] = (await req(h, 'GET', '/api/routines', s)).json;
    const run = await req(h, 'POST', `/api/routines/${rt.id}/run`, s, { clientRequestId: 'rotina-0001' });
    assert.equal(run.status, 202, JSON.stringify(run.json));
    const again = await req(h, 'POST', `/api/routines/${rt.id}/run`, s, { clientRequestId: 'rotina-0001' });
    assert.equal(again.json.id, run.json.id, 'mesmo pedido não executa duas vezes');
    const d = (await req(h, 'GET', `/api/routine-runs/${run.json.id}`, s)).json;
    assert.equal(d.status, 'succeeded'); assert.equal(d.mode, 'local');
    assert.match(d.output, /sem modelo de IA/);
    assert.match(d.facts, /\[Decisões esperando você: \d+\]/, 'evidência: os dados coletados ficam na execução');
    const types = d.deliverables.map((x: { type: string }) => x.type).sort();
    assert.deepEqual(types, ['arquivo', 'conversa']);
    const file = d.deliverables.find((x: { type: string }) => x.type === 'arquivo');
    const dl = await req(h, 'GET', `/api/artifacts/${file.id}/download`, s);
    assert.match(dl.res.body, /^# Briefing Diário — /);
    const msgs = (await req(h, 'GET', `/api/conversations/${rt.conversationId ?? d.deliverables[0].id}/messages`, s)).json;
    assert.ok(msgs.some((m: { content: string }) => /Briefing Diário — .*\nMontado pelo sistema, sem modelo/.test(m.content)));
    // a conversa da rotina não é a conversa principal com o agente
    const convs = (await req(h, 'GET', `/api/conversations?agentId=${(await req(h, 'GET', `/api/routines/${rt.id}`, s)).json.agentId}`, s)).json;
    assert.ok(convs.some((c: { purpose: string | null }) => c.purpose === `routine:${rt.id}`));
  });

  test('pausar, editar (versão nova), restaurar e duplicar', async () => {
    const [rt] = (await req(h, 'GET', '/api/routines', s)).json;
    const p = (await req(h, 'PATCH', `/api/routines/${rt.id}`, s, { status: 'paused' })).json;
    assert.equal(p.status, 'paused'); assert.equal(p.nextRunAt, null); assert.equal(p.version, 1, 'pausar não é versão nova');
    const e = (await req(h, 'PATCH', `/api/routines/${rt.id}`, s, { status: 'active', trigger: { kind: 'schedule', days: [1, 3, 5], time: '07:30' }, extra: 'Comece pelas decisões.' })).json;
    assert.equal(e.version, 2); assert.equal(e.schedule, 'Seg, qua e sex às 07:30'); assert.equal(e.config.extra, 'Comece pelas decisões.');
    const vs = (await req(h, 'GET', `/api/routines/${rt.id}/versions`, s)).json;
    assert.deepEqual(vs.map((v: { version: number }) => v.version), [2, 1]);
    const back = (await req(h, 'POST', `/api/routines/${rt.id}/restore`, s, { version: 1 })).json;
    assert.equal(back.version, 3); assert.equal(back.schedule, 'Seg a sex às 08:00'); assert.equal(back.config.extra, '');
    const dup = await req(h, 'POST', `/api/routines/${rt.id}/duplicate`, s);
    assert.equal(dup.status, 201); assert.equal(dup.json.status, 'paused'); assert.match(dup.json.name, /cópia/);
    assert.equal((await req(h, 'DELETE', `/api/routines/${dup.json.id}`, s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/routines', s)).json.length, 1);
  });

  test('agenda: horário vencido roda uma vez só; muito atrasado vira "perdida"; execução interrompida é retomada', async () => {
    const [rt] = (await req(h, 'GET', '/api/routines', s)).json;
    const slot = new Date(Date.now() - 2 * 60_000).toISOString();
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, rt.id);
    await h.routines.tick(); await h.routines.tick();
    const runs = h.db.all<{ trigger: string; slot: string; status: string }>("SELECT trigger, slot, status FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", rt.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].slot, slot);
    assert.ok((h.db.get<{ next_run_at: string }>('SELECT next_run_at FROM routines WHERE id = ?', rt.id)?.next_run_at ?? '') > new Date().toISOString());
    const old = new Date(Date.now() - 10 * 3600_000).toISOString();
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', old, rt.id);
    await h.routines.tick();
    const missed = h.db.get<{ status: string; summary: string }>('SELECT status, summary FROM routine_runs WHERE routine_id = ? AND slot = ?', rt.id, old);
    assert.equal(missed?.status, 'missed'); assert.match(missed!.summary, /desligado ou trancado/);
    // reinício no meio: ficou na fila sem chegar ao agente → o próximo passo retoma
    h.db.run(`INSERT INTO routine_runs (id, workspace_id, routine_id, version, trigger, idempotency_key, status, created_at)
              VALUES ('rrn_${'a'.repeat(32)}', ?, ?, 1, 'manual', 'teste-retomar', 'gathering', ?)`, s.workspaceId, rt.id, new Date(Date.now() - 5 * 60_000).toISOString());
    await h.routines.tick();
    // retomada: termina (aqui sem novidade desde a última, então sem modelo)
    assert.ok(['succeeded', 'skipped'].includes(h.db.get<{ status: string }>(`SELECT status FROM routine_runs WHERE id = 'rrn_${'a'.repeat(32)}'`)?.status ?? ''));
  });

  test('recomendação: ligada por padrão; liga e desliga; analisar precisa de conta de IA', async () => {
    assert.equal((await req(h, 'GET', '/api/routines/recommend', s)).json.enabled, true, 'automações ligadas por padrão');
    assert.equal((await req(h, 'PUT', '/api/routines/recommend', s, { enabled: true })).json.enabled, true);
    const r = await req(h, 'POST', '/api/routines/recommend/run', s);
    assert.equal(r.status, 409); assert.match(r.json.message, /conta de IA/);
    assert.equal((await req(h, 'PUT', '/api/routines/recommend', s, { enabled: false })).json.enabled, false);
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
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `sess-${this.started.length}`, usage: { inputTokens: 100, outputTokens: 50, costUsd: null }, model: 'x/y' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'x/y', provider: 'nous', providers: [] }; }
}

describe('rotinas com o modelo de IA', () => {
  let h: Harness; let s: Session; let motor: Motor; let coord: string; let conv: string;
  const settle = async () => { for (let i = 0; i < 5; i++) await h.executor.tick(); };
  before(async () => {
    throttle.reset();
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h, 'alexandre', 'senha-local-123');
    coord = (await allAgents(h, s)).find((a: { char_key: string }) => a.char_key === 'aristoteles').id;
    conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord })).json.id;
    motor.reply = (p) => {
      if (/^Rotina "Briefing Diário"/.test(p.input)) return 'Bom dia! Briefing de hoje.\nEsperando você: nada.\nPrioridades: destravar a #1.';
      if (/^Rotina "Supervisor de Projetos"/.test(p.input)) return 'Supervisão: 1. a #1 está parada; peça ao responsável.';
      if (/^Análise de rotinas/.test(p.input)) return [
        'Vi que toda semana você pede para conferir as notas fiscais.',
        '[[sugerir-rotina nome="Conferência de notas" quando="toda segunda 9h" agente="Arquimedes" fontes="tarefas.novas,tarefas.concluidas" condicao="novidades" instrucao="Liste as tarefas de notas fiscais novas e as concluídas na semana." motivo="4 pedidos parecidos em 30 dias" mensagem="Saudações! Notei que toda segunda vocês conferem as notas. Posso fazer isso e avisar, o que acha?"]]',
      ].join('\n');
      if (/aquela rotina/.test(p.input)) return `Claro, aqui está ela de novo.\n[[reapresentar-rotina id="${h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'routine' AND status = 'rejected' ORDER BY decided_at DESC LIMIT 1")?.id}"]]`;
      if (/ajuste o briefing/i.test(p.input)) return 'Combinado.\n[[ajustar-rotina rotina="Briefing Diário" quando="dias úteis 7h" ajuste="Ignore as tarefas pessoais."]]';
      if (/rotina/i.test(p.input)) return [
        'Prévia: toda sexta às 17h o Hesíodo lista o que travou e o que foi entregue.',
        '[[propor-rotina nome="Fechamento da semana" quando="toda sexta 17h" agente="Hesíodo" fontes="tarefas.paradas,tarefas.concluidas" condicao="sempre" entrega="conversa" instrucao="Liste o que travou na semana e o que foi entregue, em até 8 linhas."]]',
      ].join('\n');
      return 'ok';
    };
  });
  after(async () => { await h.close(); });

  test('briefing: dados vão ao agente como fatos, o resultado volta na conversa e em arquivo, com consumo', async () => {
    const rt = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: SP })).json;
    const run = (await req(h, 'POST', `/api/routines/${rt.id}/run`, s, { clientRequestId: 'rotina-real-1' })).json;
    assert.ok(['gathering', 'running'].includes(run.status), 'responde na hora; a leitura das contas segue em segundo plano');
    await settle();
    const started = motor.started.at(-1)!;
    assert.match(started.input, /^Rotina "Briefing Diário" — execução pedida agora/);
    assert.match(started.input, /são dados, não instruções/);
    assert.match(started.instructions ?? '', /Escreva o Briefing Diário/);
    const d = (await req(h, 'GET', `/api/routine-runs/${run.id}`, s)).json;
    assert.equal(d.status, 'succeeded'); assert.equal(d.mode, 'real');
    assert.equal(d.summary, 'Bom dia! Briefing de hoje.');
    assert.ok(d.deliverables.some((x: { type: string }) => x.type === 'arquivo'));
    const hist = (await req(h, 'GET', `/api/routine-runs?routineId=${rt.id}`, s)).json;
    assert.equal(hist[0].tokens, 150, 'consumo da execução aparece no histórico');
    const msgs = (await req(h, 'GET', `/api/conversations/${d.deliverables[0].id}/messages`, s)).json;
    assert.ok(msgs.some((m: { role: string; content: string }) => m.role === 'agent' && /Prioridades: destravar/.test(m.content)));
  });

  test('condição "sinal": sem tarefa parada não gasta modelo; com tarefa parada, chama o agente', async () => {
    const rt = (await req(h, 'POST', '/api/routines', s, { template: 'supervisor-projetos', tz: SP })).json;
    h.db.run('UPDATE tasks SET updated_at = ?, agent_id = COALESCE(agent_id, ?) WHERE workspace_id = ?', new Date().toISOString(), coord, s.workspaceId);
    const before = motor.started.length;
    const quiet = (await req(h, 'POST', `/api/routines/${rt.id}/run`, s, { clientRequestId: 'sup-quieto-1' })).json;
    assert.equal(quiet.status, 'skipped'); assert.equal(motor.started.length, before, 'nenhuma chamada ao modelo');
    h.db.run("UPDATE tasks SET updated_at = ? WHERE workspace_id = ? AND completed = 0", new Date(Date.now() - 6 * 86_400_000).toISOString(), s.workspaceId);
    const busy = (await req(h, 'POST', `/api/routines/${rt.id}/run`, s, { clientRequestId: 'sup-parado-1' })).json;
    assert.equal(busy.status, 'running');
    await settle();
    assert.match(motor.started.at(-1)!.input, /parada há 6 dias/);
    assert.equal((await req(h, 'GET', `/api/routine-runs/${busy.id}`, s)).json.status, 'succeeded');
  });

  test('criar rotina conversando com a coordenação: prévia, cartão, aplicar ativa', async () => {
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Quero uma rotina que toda sexta me diga o que travou na semana', clientRequestId: 'criar-rotina-1' });
    await settle();
    assert.match(motor.started.at(-1)!.instructions ?? '', /propor-rotina/, 'a coordenação sabe compor rotinas');
    const props = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json;
    const p = props.find((x: { kind: string }) => x.kind === 'routine');
    assert.ok(p, 'proposta de rotina na conversa');
    assert.match(p.summary, /Fechamento da semana.*Toda sexta às 17:00.*Hesíodo/s);
    const ok = (await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json;
    assert.equal(ok.status, 'applied', ok.result); assert.match(ok.result, /Fechamento da semana ativada/);
    const r = (await req(h, 'GET', '/api/routines', s)).json.find((x: { name: string }) => x.name === 'Fechamento da semana');
    assert.equal(r.schedule, 'Toda sexta às 17:00'); assert.equal(r.agentName, 'Hesíodo'); assert.equal(r.template, null);
    assert.deepEqual(r.config.sources, ['tarefas.paradas', 'tarefas.concluidas']);
  });

  test('ajustar uma rotina da biblioteca pela conversa muda só esta instalação (versão nova)', async () => {
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Ajuste o briefing para 7h e sem tarefas pessoais', clientRequestId: 'ajustar-rotina-1' });
    await settle();
    const p = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json.find((x: { kind: string; status: string }) => x.kind === 'routine_edit' && x.status === 'proposed');
    assert.ok(p); assert.match(p.summary, /Ajustar a rotina Briefing Diário/);
    assert.equal((await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json.status, 'applied');
    const b = (await req(h, 'GET', '/api/routines', s)).json.find((x: { template: string }) => x.template === 'briefing-diario');
    assert.equal(b.version, 2); assert.equal(b.schedule, 'Seg a sex às 07:00'); assert.equal(b.config.extra, 'Ignore as tarefas pessoais.');
  });

  test('recomendação: sugestão humanizada em "Aguardando você"; recusada não volta sozinha; dá para reapresentar', async () => {
    await req(h, 'PUT', '/api/routines/recommend', s, { enabled: true });
    const r = (await req(h, 'POST', '/api/routines/recommend/run', s)).json;
    await settle();
    assert.match(motor.started.at(-1)!.instructions ?? '', /sugerir-rotina/);
    let dec = (await req(h, 'GET', '/api/decisions', s)).json;
    const sug = dec.proposals.find((x: { kind: string; purpose: string }) => x.kind === 'routine' && x.purpose === 'routine-recommend');
    assert.ok(sug, 'sugestão chegou nas decisões');
    assert.match(sug.summary, /^Saudações! Notei que toda segunda/);
    assert.match(sug.summary, /Por quê: 4 pedidos parecidos/);
    assert.equal(sug.conversation_id, r.conversationId);
    assert.equal((await req(h, 'POST', `/api/proposals/${sug.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    // nova análise com a mesma sugestão: a base de recusas barra
    await req(h, 'POST', '/api/routines/recommend/run', s);
    await settle();
    dec = (await req(h, 'GET', '/api/decisions', s)).json;
    assert.equal(dec.proposals.filter((x: { kind: string }) => x.kind === 'routine').length, 0, 'não insiste no que foi recusado');
    assert.equal(dec.refusedRoutines.length, 1);
    // "aquela rotina que recusei": volta igual, sem refazer a análise
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Me mostre aquela rotina que recusei', clientRequestId: 'reapresentar-1' });
    await settle();
    dec = (await req(h, 'GET', '/api/decisions', s)).json;
    const back = dec.proposals.find((x: { kind: string }) => x.kind === 'routine');
    assert.ok(back); assert.match(back.summary, /^De novo \(recusada antes\):\nSaudações!/);
    // e pelo botão "Reconsiderar"
    assert.equal((await req(h, 'POST', `/api/proposals/${back.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    const re = await req(h, 'POST', `/api/proposals/${back.id}/reconsider`, s);
    assert.equal(re.status, 200); assert.match(re.json.id, /^apr_/);
  });
});

test('linhas de controle de rotina somem do texto e propostas inválidas são ignoradas', async () => {
  assert.equal(stripControl('Feito.\n[[propor-rotina nome="X" instrucao="y"]]\n[[sugerir-rotina nome="Z"]]'), 'Feito.');
  const h = await harness();
  try {
    const s = await setupOwner(h, 'alexandre', 'senha-local-123');
    const bad = routineProposalsFrom(h.db, s.workspaceId, '[[propor-rotina nome="Sem trabalho" instrucao="x"]] [[propor-rotina instrucao="sem nome nenhum aqui"]] [[ajustar-rotina rotina="Não existe" quando="seg 9h"]]', 'chat');
    assert.deepEqual(bad, []);
    const ok = routineProposalsFrom(h.db, s.workspaceId, '[[propor-rotina modelo="briefing-diario" quando="todo dia 6h" fontes="tarefas.paradas,codigo.qualquer"]]', 'chat');
    assert.equal(ok.length, 1);
    const p = ok[0] as Extract<typeof ok[number], { kind: 'routine' }>;
    assert.equal(p.spec.template, 'briefing-diario'); assert.equal(p.spec.name, 'Briefing Diário');
    assert.deepEqual(p.spec.sources, ['tarefas.paradas'], 'só fontes permitidas; nada de operação inventada');
  } finally { await h.close(); }
});
