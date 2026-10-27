/**
 * Guardião dos Prazos: prazos em risco (suas tarefas, da equipe e das contas conectadas), mudanças de prazo e o
 * contrato de evidência — toda atrasada ou vencendo hoje tem de ser avisada (se o agente esquecer, o Ergon completa),
 * datas citadas têm de existir nos dados, e sem risco nenhum o modelo nem é chamado.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { localParts, zonedToUtc } from '../src/services/routine-time.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SP = 'America/Sao_Paulo';
const two = (n: number) => String(n).padStart(2, '0');
const lp = localParts(SP, Date.now());
const noon = zonedToUtc(SP, lp.y, lp.m, lp.d, 12, 0);
const day = (n: number) => { const p = localParts(SP, noon + n * 86_400_000); return `${p.y}-${two(p.m)}-${two(p.d)}`; };
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}${iso.slice(0, 4) === String(new Date().getFullYear()) ? '' : `/${iso.slice(0, 4)}`}`;

class Motor implements HermesClient {
  started: StartRun[] = []; runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${this.started.length}_g`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `s${this.started.length}`, usage: { inputTokens: 500, outputTokens: 90, costUsd: null }, model: 'nous/teste' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste', provider: 'nous', providers: [] }; }
}

describe('Guardião dos Prazos', () => {
  let h: Harness; let s: Session; let motor: Motor; let rid: string;
  const n: Record<string, number> = {};
  const realFetch = globalThis.fetch;
  const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 15)); await h.executor.tick(); } };
  const run = async (key: string) => {
    const r = await req(h, 'POST', `/api/routines/${rid}/run`, s, { clientRequestId: key });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    await settle();
    return (await req(h, 'GET', `/api/routine-runs/${r.json.id}`, s)).json;
  };
  const agentId = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
  const task = async (key: string, body: Record<string, unknown>) => { const t = (await req(h, 'POST', '/api/tasks', s, body)).json; n[key] = t.number; return t; };

  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h);
    // tarefas de partida (boas-vindas) fora do caminho: o teste controla os prazos
    h.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ?', s.workspaceId);
    await task('atrasada', { title: 'Pagar boleto do aluguel', dueOn: day(-2) });                                  // sua, atrasada
    await task('hoje', { title: 'Revisar contrato Acme', agentId: agentId('herodoto'), dueOn: day(0) });            // equipe, hoje, não começou
    const semDono = await task('semDono', { title: 'Levantar preços de servidores', agentId: agentId('hipatia'), dueOn: day(2) });
    h.db.run('UPDATE tasks SET agent_id = NULL WHERE id = ?', semDono.id);                                          // sem responsável
    const parada = await task('parada', { title: 'Atualizar política de qualidade', agentId: agentId('euclides'), dueOn: day(1) });
    h.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', new Date(Date.now() - 5 * 86_400_000).toISOString(), parada.id);
    const calma = await task('calma', { title: 'Atualizar o site', agentId: agentId('fidias'), dueOn: day(3) });       // no prazo, andando
    const doing = h.db.get<{ id: string }>("SELECT c.id FROM columns c JOIN tasks t ON t.board_id = c.board_id WHERE t.id = ? AND c.name = 'Em andamento'", calma.id)!;
    h.db.run('UPDATE tasks SET column_id = ? WHERE id = ?', doing.id, calma.id);
    await task('longe', { title: 'Planejar 2027', dueOn: day(10) });                                              // fora da antecedência
    const feita = await task('feita', { title: 'Já entregue', dueOn: day(-5) });
    await req(h, 'PATCH', `/api/tasks/${feita.id}`, s, { completed: true });                                         // concluída: fora
    const mudou = await task('mudou', { title: 'Relatório mensal', dueOn: day(1) });
    await req(h, 'PATCH', `/api/tasks/${mudou.id}`, s, { dueOn: day(5) });                                         // adiada 4 dias, por você
    // suas tarefas no To Do (conta Microsoft conectada; API simulada)
    h.integrations.secrets.write(s.workspaceId, 'microsoft', { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600_000, account: 'eu@verticelab.com' });
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'eu@verticelab.com', connected_at: new Date().toISOString(), last_error: null });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== 'graph.microsoft.com') return realFetch(input, init);
      const body = u.pathname === '/v1.0/me/todo/lists' ? { value: [{ id: 'l1', displayName: 'Trabalho' }] }
        : u.pathname === '/v1.0/me/todo/lists/l1/tasks' ? { value: [
          { title: 'Enviar proposta revisada', status: 'notStarted', dueDateTime: { dateTime: `${day(2)}T00:00:00.0000000`, timeZone: 'UTC' } },
          { title: 'Renovar domínio', status: 'notStarted', dueDateTime: { dateTime: `${day(9)}T00:00:00.0000000`, timeZone: 'UTC' } },
          { title: 'Reescrever a política antiga', status: 'notStarted', dueDateTime: { dateTime: '2024-03-18T00:00:00.0000000', timeZone: 'UTC' } },
        ] } : null;
      return new Response(JSON.stringify(body ?? { error: { code: 'Forbidden' } }), { status: body ? 200 : 403, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    rid = (await req(h, 'POST', '/api/routines', s, { template: 'guardiao-prazos', tz: SP })).json.id;
  });
  after(async () => { globalThis.fetch = realFetch; await h.close(); });

  test('está na biblioteca, pronto, à tarde nos dias úteis, com Hesíodo', async () => {
    const lib = (await req(h, 'GET', '/api/routines/library', s)).json;
    const g = lib.routines.find((r: { key: string }) => r.key === 'guardiao-prazos');
    assert.equal(g.available, true);
    const rt = (await req(h, 'GET', `/api/routines/${rid}`, s)).json;
    assert.match(rt.schedule, /Seg a sex às 14:00/);
    assert.deepEqual(rt.config.sources, ['prazos.risco', 'prazos.pessoais', 'prazos.mudancas']);
  });

  test('avisa as atrasadas, as de hoje e as em risco; mostra mudanças de prazo; conferência validada', async () => {
    motor.reply = () => [
      `Prazos — ${br(day(0))}: 4 pedem atenção.`,
      `1. #${n.atrasada} Pagar boleto do aluguel está ATRASADA há 2 dias (prazo ${br(day(-2))}): pagar hoje.`,
      `2. #${n.hoje} Revisar contrato Acme vence HOJE e ainda não começou: Heródoto começa agora.`,
      `3. #${n.semDono} vence em ${br(day(2))} e está sem responsável: passar para a Hipátia.`,
      `4. #${n.parada} está parada há 5 dias e vence amanhã: Euclides destrava.`,
      `Mudou: #${n.mudou} Relatório mensal foi adiado de ${br(day(1))} para ${br(day(5))} (por você).`,
      'T1 Reescrever a política antiga (To Do) está atrasada desde 18/03/2024: concluir ou tirar o prazo.',
    ].join('\n');
    const d = await run('guardiao-1');
    assert.equal(d.status, 'succeeded', d.error ?? '');
    const input = motor.started.at(-1)!.input;
    assert.match(input, new RegExp(`#${n.atrasada} "Pagar boleto do aluguel" · você · ATRASADA há 2 dia\\(s\\) \\(prazo ${br(day(-2))}\\)`));
    assert.match(input, new RegExp(`#${n.hoje} "Revisar contrato Acme" · Heródoto · vence HOJE \\(${br(day(0))}\\) · ainda não começou`));
    assert.match(input, new RegExp(`#${n.semDono} "Levantar preços de servidores" · sem responsável · vence em 2 dia\\(s\\) \\([a-zá]{3}, ${br(day(2))}\\) · sem responsável`));
    assert.match(input, new RegExp(`#${n.parada} "Atualizar política de qualidade" · Euclides · vence em 1 dia\\(s\\).* · parada há 5 dias, ainda não começou`));
    assert.match(input, /\(1 tarefa\(s\) com prazo nos próximos 3 dias sem sinal de risco\)/, 'a que está andando no prazo só é contada');
    assert.doesNotMatch(input, /Planejar 2027|Já entregue/);
    assert.match(input, new RegExp(`#${n.mudou} "Relatório mensal" · prazo de ${br(day(1))} para ${br(day(5))} \\(adiado 4 dia\\(s\\), por você\\)`));
    assert.match(input, new RegExp(`"Enviar proposta revisada" · vence em 2 dia\\(s\\) \\(${br(day(2))}\\) · To Do › Trabalho`), 'suas tarefas das contas, com antecedência');
    assert.doesNotMatch(input, /Renovar domínio/, 'fora da antecedência de 3 dias');
    assert.match(input, /"Reescrever a política antiga" · ATRASADA há \d+ dia\(s\) \(prazo 18\/03\/2024\)/, 'de outro ano: com o ano');
    assert.equal(d.checks.verdict, 'validado', JSON.stringify(d.checks.criteria));
    const crit = Object.fromEntries(d.checks.criteria.map((c: { id: string; ok: boolean; detail?: string }) => [c.id, c]));
    assert.equal(crit.cobertura.ok, true); assert.match(crit.cobertura.detail, /3 avisada\(s\), de 3/, 'as do Ergon e a atrasada do To Do');
    assert.match(input, /T1 · "Reescrever a política antiga" · ATRASADA/, 'tarefa das contas com código citável');
    assert.equal(crit.datas.ok, true);
    assert.match(d.checks.panel, /Prazos em risco \(1 atrasada, 1 vencendo hoje\): 4/);
  });

  test('o agente esquece uma que vence hoje: o Ergon completa a entrega e a conferência fica em parte', async () => {
    motor.reply = () => `Prazos: #${n.atrasada} Pagar boleto do aluguel está atrasada desde ${br(day(-2))}.`;
    const d = await run('guardiao-2');
    assert.equal(d.checks.verdict, 'parcial');
    const crit = Object.fromEntries(d.checks.criteria.map((c: { id: string; ok: boolean; detail?: string }) => [c.id, c]));
    assert.equal(crit.cobertura.ok, false); assert.match(crit.cobertura.detail, new RegExp(`faltaram 2 de 3: T1, #${n.hoje} \\(o Ergon acrescentou todas\\)`));
    const msgs = (await req(h, 'GET', `/api/conversations/${d.deliverables[0].id}/messages`, s)).json;
    const note = msgs.find((m: { content: string }) => /O Ergon acrescenta o que o texto não avisou/.test(m.content));
    assert.ok(note, 'aviso do que faltou na conversa');
    assert.match(note.content, new RegExp(`#${n.hoje} "Revisar contrato Acme" · Heródoto · vence HOJE`));
    const file = d.deliverables.find((x: { type: string }) => x.type === 'arquivo');
    assert.match((await req(h, 'GET', `/api/artifacts/${file.id}/download`, s)).res.body, new RegExp(`O Ergon acrescenta[\\s\\S]*#${n.hoje}`));
  });

  test('data que não está nos dados: não conferido', async () => {
    motor.reply = () => `#${n.atrasada} atrasada; #${n.hoje} vence hoje; renegocie para 30/12.`;
    const d = await run('guardiao-3');
    assert.equal(d.checks.verdict, 'reprovado');
    const datas = d.checks.criteria.find((c: { id: string }) => c.id === 'datas');
    assert.equal(datas.ok, false); assert.match(datas.detail, /30\/12/);
  });

  test('sem risco nenhum: não chama o modelo e só registra "nada pedindo atenção"', async () => {
    for (const k of ['atrasada', 'hoje', 'semDono', 'parada']) h.db.run('UPDATE tasks SET completed = 1 WHERE workspace_id = ? AND number = ?', s.workspaceId, n[k]);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== 'graph.microsoft.com') return realFetch(input, init);
      return new Response(JSON.stringify(u.pathname === '/v1.0/me/todo/lists' ? { value: [] } : { value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const before = motor.started.length;
    const d = await run('guardiao-4');
    assert.equal(d.status, 'skipped'); assert.equal(motor.started.length, before, 'nenhuma chamada ao modelo');
    assert.equal(d.summary, 'Nada pedindo atenção');
  });
});
