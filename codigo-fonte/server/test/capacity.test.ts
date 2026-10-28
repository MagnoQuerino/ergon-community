import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { id, now } from '../src/lib/util.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

// a capacidade continua garantida no servidor e no banco (vale para os planos da nuvem e para quem desliga o
// crescimento automático); no local, por padrão, a cidade cresce sozinha (teste no fim do arquivo)
describe('capacidade de habitantes (validada no servidor)', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness({ autoGrow: false }); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('demonstração começa com 2 andares × 6 vagas (as mesas de cada planta) = 12 personagens, sem vaga livre', async () => {
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.equal(c.slots, 12);
    assert.equal(c.active, 12);
    assert.equal(c.free, 0);
  });

  test('capacidade cheia bloqueia criação via API', async () => {
    const r = await req(h, 'POST', '/api/agents', s, { name: 'Extra', role: 'Teste', profileKey: 'central' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'capacity_exceeded');
  });

  test('gatilho do banco bloqueia mesmo inserção direta (sem passar pelo serviço)', () => {
    const f = h.db.get<{ id: string }>('SELECT id FROM floors WHERE workspace_id = ? LIMIT 1', s.workspaceId)!;
    const p = h.db.get<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = ? LIMIT 1', s.workspaceId)!;
    assert.throws(() => h.db.run(
      `INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at) VALUES (?, ?, ?, ?, 'X', 'Y', '#000000', 'active', ?)`,
      id('agt'), s.workspaceId, f.id, p.id, now()), /capacity_exceeded/);
  });

  test('arquivar libera vaga; reativar com capacidade cheia é bloqueado', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const victim = st.agents.find((a: { coordinator: number }) => !a.coordinator).id;
    assert.equal((await req(h, 'POST', `/api/agents/${victim}/archive`, s)).status, 200);
    const created = await req(h, 'POST', '/api/agents', s, { name: 'Nova', role: 'Ocupa a vaga', profileKey: 'brainstorm' });
    assert.equal(created.status, 201);
    const re = await req(h, 'POST', `/api/agents/${victim}/reactivate`, s);
    assert.equal(re.status, 409);
    assert.equal(re.json.error, 'capacity_exceeded');
  });

  test('agente com execução ativa não pode ser arquivado', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const agent = st.agents.find((a: { status: string; coordinator: number }) => a.status === 'active' && !a.coordinator);
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent.id })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: 'olá', clientRequestId: 'req-busy-00001' });
    const r = await req(h, 'POST', `/api/agents/${agent.id}/archive`, s);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'agent_busy');
  });

  test('andar extra (versão local, grátis) libera vagas, sem cobrança', async () => {
    const r = await req(h, 'POST', '/api/floors', s);
    assert.equal(r.status, 201);
    assert.equal(r.json.local, true);
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.equal(c.slots, 18);
    const floor = c.floors.find((f: { id: string }) => f.id === r.json.id);
    assert.equal(floor.origin, 'simulated');
    const log = (await req(h, 'GET', '/api/activity', s)).json as Array<{ action: string; evidence: string }>;
    const ev = log.find((e) => e.action === 'floor.add_simulated');
    assert.match(ev!.evidence, /nenhum/);
  });

  test('andar ocupado não pode ser removido; andar base nunca', async () => {
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    const top = c.floors[c.floors.length - 1];
    await req(h, 'POST', '/api/agents', s, { name: 'Morador', role: 'Ocupa o andar novo', profileKey: 'central', floorId: top.id });
    const r = await req(h, 'DELETE', `/api/floors/${top.id}`, s);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'floor_occupied');
    const base = await req(h, 'DELETE', `/api/floors/${c.floors[0].id}`, s);
    assert.equal(base.status, 409);
  });

  test('a Stoa tem um máximo de andares (para mais agentes, outra estrutura)', async () => {
    let last = { status: 201, json: null as any };
    for (let i = 0; i < 5; i++) last = await req(h, 'POST', '/api/floors', s);
    assert.equal(last.status, 409);
    assert.match(last.json.message, /construa outra estrutura/);
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.equal(c.floors.length, 4);
  });
});

describe('corrida concorrente de criação (conexões separadas, mesmo arquivo)', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness({ autoGrow: false }); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('8 criações simultâneas com 2 vagas livres → exatamente 2 sucessos', async () => {
    // abre 2 vagas: arquiva 2 agentes
    const st = (await req(h, 'GET', '/api/state', s)).json;
    for (const a of st.agents.filter((x: { coordinator: number }) => !x.coordinator).slice(0, 2)) assert.equal((await req(h, 'POST', `/api/agents/${a.id}/archive`, s)).status, 200);
    const barrier = new SharedArrayBuffer(8);
    const flag = new Int32Array(barrier);
    const N = 8;
    const results = new Array<Promise<{ ok: boolean; code?: string }>>();
    const workers: Worker[] = [];
    for (let n = 0; n < N; n++) {
      const w = new Worker(new URL('./capacity-worker.ts', import.meta.url), {
        workerData: { dbPath: h.cfg.dbPath, dbKey: h.vault.state() === 'open' ? h.vault.dbKey().toString('hex') : null, workspaceId: s.workspaceId, userId: s.userId, n, barrier },
      });
      workers.push(w);
      results.push(new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); }));
    }
    while (Atomics.load(flag, 1) < N) await new Promise((r) => setTimeout(r, 10));
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    const out = await Promise.all(results);
    await Promise.all(workers.map((w) => w.terminate()));
    const ok = out.filter((r) => r.ok).length;
    assert.equal(ok, 2, JSON.stringify(out));
    assert.ok(out.filter((r) => !r.ok).every((r) => r.code === 'capacity_exceeded'));
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.equal(c.active, 12);
    assert.equal(c.free, 0);
  });

  test('requisições HTTP paralelas também respeitam o limite', async () => {
    await req(h, 'POST', '/api/floors', s); // +6 vagas
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      req(h, 'POST', '/api/agents', s, { name: `Paralelo ${i}`, role: 'Teste', profileKey: 'central' })));
    assert.equal(rs.filter((r) => r.status === 201).length, 6);
    assert.equal(rs.filter((r) => r.status === 409).length, 6);
  });
});

describe('versão local: quantos agentes quiser', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('sem vaga, a cidade cresce sozinha: primeiro andares na Stoa, depois uma construção nova', async () => {
    assert.equal((await req(h, 'GET', '/api/capacity', s)).json.free, 0, 'a equipe de partida ocupa todas as vagas');
    for (let i = 0; i < 20; i++) {
      const r = await req(h, 'POST', '/api/agents', s, { name: `Extra ${i}`, role: 'Teste de capacidade', profileKey: 'central' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    const c = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.equal(c.active, 32);
    assert.ok(c.slots >= 32);
    const grew = h.db.all<{ result: string }>("SELECT result FROM audit_events WHERE workspace_id = ? AND action = 'city.grow'", s.workspaceId).map((x) => x.result);
    assert.ok(grew.some((x) => /andar novo/.test(x)) && grew.some((x) => /nova/.test(x)), grew.join(' | '));
    // reativar também cabe sempre
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const one = st.agents.find((a: { coordinator: number; status: string }) => !a.coordinator && a.status === 'active');
    assert.equal((await req(h, 'POST', `/api/agents/${one.id}/archive`, s)).status, 200);
    await req(h, 'POST', '/api/agents', s, { name: 'Ocupa a vaga', role: 'Teste', profileKey: 'central' });
    assert.equal((await req(h, 'POST', `/api/agents/${one.id}/reactivate`, s)).status, 200);
  });
});
