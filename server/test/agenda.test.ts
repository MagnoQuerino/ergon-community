/**
 * Agenda das rotinas sob falhas: verificações simultâneas, duas rotinas no mesmo
 * horário, troca de fuso, falha sem repetição em cascata, pedido manual repetido e reinício antes do disparo.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { localParts } from '../src/services/routine-time.ts';
import { harness, req, setupOwner } from './helpers.ts';

class FailingMotor implements HermesClient {
  started = 0;
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(_p: StartRun) { this.started++; return { runId: `run_${this.started}_x`, replayed: false }; }
  async getRun(): Promise<RemoteRun> { return { status: 'failed', output: null, error: 'provedor fora do ar', sessionId: 's', usage: null, model: null }; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste', provider: 'nous', providers: [] }; }
}

const past = (min = 2) => new Date(Date.now() - min * 60_000).toISOString();

describe('agenda das rotinas sob falhas', () => {
  test('duas verificações ao mesmo tempo: cada horário vira uma execução só', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'supervisor-projetos', tz: 'America/Sao_Paulo' })).json;
    const slot = past();
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await Promise.all([h.routines.tick(), h.routines.tick(), h.routines.tick()]);
    await h.routines.tick();
    assert.equal(h.db.all("SELECT 1 FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", r.id).length, 1);
    await h.close();
  });

  test('duas rotinas no mesmo horário: as duas rodam, uma vez cada', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const a = (await req(h, 'POST', '/api/routines', s, { template: 'supervisor-projetos', tz: 'America/Sao_Paulo' })).json;
    const b = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo' })).json;
    const slot = past();
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id IN (?, ?)', slot, a.id, b.id);
    await h.routines.tick(); await h.routines.tick();
    for (const id of [a.id, b.id]) assert.equal(h.db.all("SELECT 1 FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", id).length, 1);
    await h.close();
  });

  test('troca de fuso: o próximo horário passa a ser 08:00 no fuso novo', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo' })).json;
    const sp = localParts('America/Sao_Paulo', Date.parse(r.nextRunAt));
    assert.deepEqual([sp.hh, sp.mm], [8, 0]);
    const e = (await req(h, 'PATCH', `/api/routines/${r.id}`, s, { trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'Europe/Lisbon' }, tz: 'Europe/Lisbon' })).json;
    const lx = localParts('Europe/Lisbon', Date.parse(e.nextRunAt));
    assert.deepEqual([lx.hh, lx.mm], [8, 0]);
    assert.notEqual(e.nextRunAt, r.nextRunAt);
    await h.close();
  });

  test('falha do provedor: a execução falha com o motivo, sem repetir em cascata; o próximo horário segue marcado', async () => {
    const motor = new FailingMotor();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    const s = await setupOwner(h);
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo' })).json;
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', past(), r.id);
    await h.routines.tick();
    for (let i = 0; i < 12; i++) { await new Promise((x) => setTimeout(x, 15)); await h.executor.tick(); await h.routines.tick(); }
    const runs = h.db.all<{ status: string; error: string | null }>("SELECT status, error FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", r.id);
    assert.equal(runs.length, 1); assert.equal(runs[0].status, 'failed'); assert.ok(runs[0].error);
    assert.ok(motor.started <= 2, `no máximo as tentativas da execução (${motor.started})`);
    const next = h.db.get<{ next_run_at: string }>('SELECT next_run_at FROM routines WHERE id = ?', r.id)!.next_run_at;
    assert.ok(next > new Date().toISOString(), 'o próximo horário continua marcado');
    await h.close();
  });

  test('pedido manual repetido (mesmo identificador) não roda duas vezes; outro pedido com uma em andamento é recusado', async () => {
    const motor = new FailingMotor();
    motor.getRun = async () => ({ status: 'running', output: null, error: null, sessionId: 's', usage: null, model: null });
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    const s = await setupOwner(h);
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo' })).json;
    const a = await req(h, 'POST', `/api/routines/${r.id}/run`, s, { clientRequestId: 'repetido-0001' });
    const b = await req(h, 'POST', `/api/routines/${r.id}/run`, s, { clientRequestId: 'repetido-0001' });
    assert.equal(a.json.id, b.json.id);
    await new Promise((x) => setTimeout(x, 30));
    const c = await req(h, 'POST', `/api/routines/${r.id}/run`, s, { clientRequestId: 'outro-pedido-0002' });
    assert.equal(c.status, 409); assert.equal(c.json.error, 'busy');
    await h.close();
  });

  test('reinício antes do disparo: o horário guardado roda uma vez depois de voltar', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const r = (await req(h, 'POST', '/api/routines', s, { template: 'supervisor-projetos', tz: 'America/Sao_Paulo' })).json;
    const slot = new Date(Date.now() + 1000).toISOString();
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await h.close();
    await new Promise((x) => setTimeout(x, 1100));
    const h2 = await harness({}, { dir: h.dir });
    await h2.routines.tick(); await h2.routines.tick();
    const runs = h2.db.all<{ slot: string }>("SELECT slot FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule'", r.id);
    assert.deepEqual(runs.map((x) => x.slot), [slot]);
    await h2.close();
  });
});
