/**
 * Guardião dos Prazos em escala: a cobertura confere TODAS as atrasadas e as que vencem
 * hoje — 0, 10, 300, 1.200 tarefas —, o modelo recebe as mais urgentes e o resumo do resto, o Ergon completa o que o
 * texto não avisou (lista inteira no arquivo), e leitura de conta que para no limite é dita como parcial.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { localParts, zonedToUtc } from '../src/services/routine-time.ts';
import { createTask, userBoard } from '../src/services/tasks.ts';
import { harness, req, setupOwner } from './helpers.ts';

const two = (n: number) => String(n).padStart(2, '0');
const dayIn = (tz: string, n: number) => { const p = localParts(tz, Date.now()); const noon = zonedToUtc(tz, p.y, p.m, p.d, 12, 0); const q = localParts(tz, noon + n * 86_400_000); return `${q.y}-${two(q.m)}-${two(q.d)}`; };

class Motor implements HermesClient {
  started: StartRun[] = []; runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${this.started.length}_c`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `s${this.started.length}`, usage: { inputTokens: 500, outputTokens: 90, costUsd: null }, model: 'nous/teste' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste', provider: 'nous', providers: [] }; }
}

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

async function guardiao(tz = 'America/Sao_Paulo') {
  const motor = new Motor();
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
  const s = await setupOwner(h);
  h.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ?', s.workspaceId); // passos de boas-vindas fora
  const rid = (await req(h, 'POST', '/api/routines', s, { template: 'guardiao-prazos', tz })).json.id as string;
  const cfg = JSON.parse(h.db.get<{ config: string }>('SELECT config FROM routines WHERE id = ?', rid)!.config);
  h.db.run('UPDATE routines SET config = ? WHERE id = ?', h.db.seal(s.workspaceId, JSON.stringify({ ...cfg, maxPerDay: 50 })), rid);
  const board = userBoard(h.db, s.workspaceId).id;
  const add = (title: string, dueOn: string) => createTask(h.db, null, s.workspaceId, { type: 'user', id: s.userId }, { title, boardId: board, origin: 'manual', dueOn }).number;
  let k = 0;
  const run = async () => {
    const r = await req(h, 'POST', `/api/routines/${rid}/run`, s, { clientRequestId: `cobertura-${String(++k).padStart(4, '0')}` });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    for (let i = 0; i < 10; i++) { await new Promise((x) => setTimeout(x, 15)); await h.executor.tick(); }
    return (await req(h, 'GET', `/api/routine-runs/${r.json.id}`, s)).json;
  };
  const file = async (d: { deliverables: Array<{ type: string; id: string }> }) => (await req(h, 'GET', `/api/artifacts/${d.deliverables.find((x) => x.type === 'arquivo')!.id}/download`, s)).res.body as string;
  return { h, s, motor, add, run, file };
}
const crit = (d: { checks: { criteria: Array<{ id: string; ok: boolean; detail?: string }> } }, id: string) => d.checks.criteria.find((c) => c.id === id)!;

describe('Guardião dos Prazos: cobertura completa em qualquer volume', () => {
  test('0 tarefas: nada pedindo atenção, sem chamar o modelo', async () => {
    const g = await guardiao();
    const d = await g.run();
    assert.equal(d.status, 'skipped'); assert.equal(d.summary, 'Nada pedindo atenção');
    assert.equal(g.motor.started.length, 0);
    await g.h.close();
  });

  test('10 tarefas (3 atrasadas, 2 hoje, 5 tranquilas), duplicadas incluídas: todas as 5 obrigatórias avisadas', async () => {
    const g = await guardiao();
    const late = [g.add('Pagar fornecedor', dayIn('America/Sao_Paulo', -3)), g.add('Pagar fornecedor', dayIn('America/Sao_Paulo', -3)), g.add('Enviar laudo', dayIn('America/Sao_Paulo', -40))];
    const today = [g.add('Assinar contrato', dayIn('America/Sao_Paulo', 0)), g.add('Ligar para o banco', dayIn('America/Sao_Paulo', 0))];
    for (let i = 0; i < 5; i++) g.add(`Planejar ${i}`, dayIn('America/Sao_Paulo', 10));
    g.motor.reply = () => [...late, ...today].map((n) => `#${n} precisa de ação.`).join('\n');
    const d = await g.run();
    assert.equal(d.checks.verdict, 'validado', JSON.stringify(d.checks.criteria));
    assert.match(crit(d, 'cobertura').detail!, /^5 avisada\(s\), de 5$/);
    assert.equal(new Set(late.slice(0, 2)).size, 2, 'repetidas não se fundem: cada uma tem o seu número');
    await g.h.close();
  });

  for (const total of [300, 1200]) {
    test(`${total} atrasadas: o modelo recebe as 40 mais urgentes; a cobertura confere todas; o Ergon completa a lista inteira no arquivo`, async () => {
      const g = await guardiao();
      const nums: number[] = [];
      for (let i = 0; i < total; i++) nums.push(g.add(`Atrasada ${i}`, dayIn('America/Sao_Paulo', -1 - (i % 20))));
      g.motor.reply = (p) => {
        assert.match(p.input, new RegExp(`\\(mais ${total - 40} além destas — todas conferidas pelo sistema`), 'o resto aparece resumido, não some');
        // cita 5 que NÃO estão entre as 40 detalhadas: existem nos dados, então conferem
        return nums.slice(0, 5).map((n) => `#${n} atrasada.`).join('\n');
      };
      const d = await g.run();
      assert.equal(d.checks.verdict, 'parcial');
      const c = crit(d, 'cobertura');
      assert.equal(c.ok, false); assert.match(c.detail!, new RegExp(`^faltaram ${total - 5} de ${total}: .* e mais ${total - 25} \\(o sistema acrescentou todas\\)$`));
      const body = await g.file(d);
      // a última criada (além de qualquer limite antigo de 300) está no complemento do arquivo
      assert.match(body, new RegExp(`O sistema acrescenta o que o texto não avisou \\(${total - 5}\\)`));
      for (const n of [nums[5], nums[299], nums[total - 1]]) assert.match(body, new RegExp(`- #${n} "Atrasada \\d+"`), `#${n} no arquivo`);
      // na conversa, as primeiras 40 e o aviso de que a lista inteira está no arquivo
      const note = g.h.db.all<{ content: string }>("SELECT content FROM messages WHERE role = 'system' ORDER BY created_at DESC, rowid DESC LIMIT 3").map((m) => m.content).join('\n');
      assert.match(note, new RegExp(`… e mais ${total - 5 - 40} — a lista completa está no arquivo da entrega`));
      await g.h.close();
    });
  }

  test('fuso do usuário: "hoje" é o dia dele (Kiribati, UTC+14), não o do servidor', async () => {
    const tz = 'Pacific/Kiritimati';
    const g = await guardiao(tz);
    const n = g.add('Entregar relatório', dayIn(tz, 0));
    g.motor.reply = (p) => { assert.match(p.input, new RegExp(`#${n} "Entregar relatório" · você · vence HOJE`)); return `#${n} vence hoje.`; };
    const d = await g.run();
    assert.equal(crit(d, 'cobertura').ok, true);
    await g.h.close();
  });

  test('tarefas das contas em várias páginas: todas lidas; as atrasadas da última página também têm de ser avisadas', async () => {
    const g = await guardiao();
    g.h.integrations.secrets.write(g.s.workspaceId, 'microsoft', { access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600_000, account: 'eu@x.com' });
    setIntegration(g.h.db, g.s.workspaceId, 'microsoft', { state: 'connected', account_label: 'eu@x.com', connected_at: new Date().toISOString(), last_error: null });
    let pages = 3;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.host !== 'graph.microsoft.com') return realFetch(input, init);
      if (u.pathname === '/v1.0/me/todo/lists') return Response.json({ value: [{ id: 'l1', displayName: 'Trabalho' }] });
      if (u.pathname === '/v1.0/me/todo/lists/l1/tasks') {
        const p = Number(u.searchParams.get('p') ?? '1');
        const value = Array.from({ length: 5 }, (_, i) => ({ title: `Conta p${p} t${i}`, status: 'notStarted', dueDateTime: { dateTime: `${dayIn('America/Sao_Paulo', p === pages ? -2 : 9)}T00:00:00.0000000`, timeZone: 'UTC' } }));
        return Response.json({ value, ...(p < pages ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/todo/lists/l1/tasks?p=${p + 1}` } : {}) });
      }
      if (u.pathname === '/v1.0/me/planner/tasks') return Response.json({ value: [] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    g.motor.reply = (p) => { const codes = [...p.input.matchAll(/^- (T\d+) · "Conta p3/gm)].map((m) => m[1]); return codes.map((c) => `${c} atrasada.`).join('\n'); };
    const d = await g.run();
    assert.equal(crit(d, 'fontes').ok, true, 'três páginas: leitura completa');
    assert.match(crit(d, 'cobertura').detail!, /^5 avisada\(s\), de 5$/, 'as 5 atrasadas da 3ª página');
    // mais páginas do que o limite de leitura: a conferência diz "lida em parte" e o aviso aparece
    pages = 14;
    g.motor.reply = () => 'nada a dizer';
    const d2 = await g.run();
    assert.equal(crit(d2, 'fontes').ok, false);
    assert.match(crit(d2, 'fontes').detail!, /Microsoft tarefas: lida em parte \(limite de leitura\)/);
    assert.match(d2.facts, /lido em parte — havia mais do que o limite de leitura/);
    assert.notEqual(d2.checks.verdict, 'validado');
    globalThis.fetch = realFetch;
    await g.h.close();
  });
});
