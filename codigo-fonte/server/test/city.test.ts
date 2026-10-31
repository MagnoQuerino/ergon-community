import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CATALOG, GROW_AT, cityExtent, fitAt, freeCells, occupancy, placeError, type Placed } from '../../shared/city.ts';
import { id, now } from '../src/lib/util.ts';
import { periodStarts, usageSummary } from '../src/services/usage.ts';
import { allAgents, cityStructures, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('grade da cidade (shared/city.ts)', () => {
  const start: Placed[] = [
    { id: 'a', kind: 'stoa', i: 2, j: 1 }, { id: 'b', kind: 'ginasio', i: 0, j: 1 }, { id: 'c', kind: 'teatro', i: 5, j: 1 },
    { id: 'd', kind: 'agora', i: 2, j: 3 }, { id: 'e', kind: 'termas', i: 4, j: 3 }, { id: 'f', kind: 'bairro', i: 0, j: 3 },
  ];

  test('cidade inicial cabe na área base, sem sobreposição, com lotes livres', () => {
    for (const p of start) assert.equal(placeError(start, p.kind, p.i, p.j, p.id), null, p.kind);
    const e = cityExtent(start);
    assert.deepEqual(e, { i0: 0, j0: 0, i1: 7, j1: 6 });
    assert.ok(occupancy(start) < GROW_AT);
    assert.ok(freeCells(start).length >= 15);
  });

  test('lote ocupado, fora da área e tipo único são recusados', () => {
    assert.equal(placeError(start, 'oikos', 3, 1), 'occupied');
    assert.equal(placeError(start, 'oikos', 7, 0), 'outside');
    assert.equal(placeError(start, 'agora', 0, 0), 'unique');
    assert.equal(placeError(start, 'oikos', 0, 0), null);
    assert.equal(placeError(start, 'oikos', 6, 3), null);
    assert.equal(placeError(start, 'nada', 0, 0), 'unknown_kind');
  });

  test('fitAt encaixa a pegada em volta do lote clicado (ou diz que não cabe)', () => {
    assert.deepEqual(fitAt(start, 'oikos', 1, 0), [1, 0]);
    const emp = fitAt(start, 'emporion', 1, 0); // 2×2: no topo só cabe 2×1… não cabe
    assert.equal(emp, null);
    const esc = fitAt(start, 'didaskaleion', 1, 0)!; // 2×1: cobre o lote clicado e um vizinho
    assert.ok(esc[1] === 0 && (esc[0] === 0 || esc[0] === 1));
    assert.equal(placeError(start, 'didaskaleion', esc[0], esc[1]), null);
  });

  test('ao chegar a 80% de ocupação, a cidade abre mais um anel de lotes', () => {
    const placed = [...start];
    let n = 0;
    while (occupancy(placed) < GROW_AT - 0.03 && n < 60) {
      const [ci, cj] = freeCells(placed)[0];
      placed.push({ id: `x${n++}`, kind: 'oikos', i: ci, j: cj });
    }
    const before = cityExtent(placed);
    // completa até passar de 80%: a área cresce e sobram lotes livres
    while (n < 80) {
      const free = freeCells(placed); const e = cityExtent(placed);
      if ((e.i1 - e.i0) * (e.j1 - e.j0) > (before.i1 - before.i0) * (before.j1 - before.j0)) break;
      placed.push({ id: `x${n++}`, kind: 'oikos', i: free[0][0], j: free[0][1] });
    }
    const grown = cityExtent(placed);
    assert.ok(grown.i0 < before.i0 && grown.j1 > before.j1, 'um anel a mais');
    assert.ok(occupancy(placed) < GROW_AT);
    assert.ok(freeCells(placed).length > 0);
  });

  test('catálogo: tipos de trabalho com vagas; áreas sem vagas; capacidades pequenas e grandes', () => {
    const work = CATALOG.filter((t) => t.category === 'trabalho');
    assert.ok(work.length >= 8);
    for (const t of work) assert.ok(t.slotsPerFloor > 0 && t.floors.initial >= 1 && t.floors.max >= t.floors.initial, t.id);
    for (const t of CATALOG.filter((x) => x.category !== 'trabalho')) assert.equal(t.slotsPerFloor, 0, t.id);
    const small = work.filter((t) => t.size === 'pequena'); const big = work.filter((t) => t.size === 'grande');
    assert.ok(small.every((t) => t.floors.max * t.slotsPerFloor <= 5));
    assert.ok(big.every((t) => t.floors.max * t.slotsPerFloor >= 12));
  });
});

describe('estruturas pela API (loja e editor do mapa, versão local)', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('a cidade inicial: a Stoa com 2 andares e as cinco áreas, cada uma no seu lote', async () => {
    const st = { structures: await cityStructures(h, s), agents: await allAgents(h, s) };
    const kinds = st.structures.map((x: { kind: string }) => x.kind).sort();
    assert.deepEqual(kinds, ['agora', 'bairro', 'ginasio', 'stoa', 'teatro', 'termas']);
    const stoa = st.structures.find((x: { kind: string }) => x.kind === 'stoa');
    assert.deepEqual([stoa.i, stoa.j], [2, 1]);
    assert.equal(stoa.floors.length, 2);
    assert.ok(st.agents.every((a: { building_id: string }) => a.building_id === stoa.id));
    assert.deepEqual((await req(h, 'GET', '/api/structures', s)).json, st.structures, '/api/structures: o mesmo construtor');
  });

  test('loja: cria uma casa num lote livre (grátis), recusa lote ocupado e dá vagas novas', async () => {
    const before = (await req(h, 'GET', '/api/capacity', s)).json.slots;
    const r = await req(h, 'POST', '/api/structures', s, { kind: 'oikos', i: 0, j: 0 });
    assert.equal(r.status, 201);
    assert.equal(r.json.local, true);
    const bad = await req(h, 'POST', '/api/structures', s, { kind: 'oikos', i: 0, j: 0 });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, 'occupied');
    const uniq = await req(h, 'POST', '/api/structures', s, { kind: 'agora', i: 1, j: 0 });
    assert.equal(uniq.status, 400, 'áreas da cidade não estão na loja');
    const after1 = (await req(h, 'GET', '/api/capacity', s)).json.slots;
    assert.equal(after1, before + 2);
    const ag = await req(h, 'POST', '/api/agents', s, { name: 'Morador', role: 'Ocupa a casa nova', profileKey: 'central' });
    assert.equal(ag.status, 201);
    const who = (await allAgents(h, s)).find((a: { id: string }) => a.id === ag.json.id);
    assert.equal(who.building_id, r.json.id, 'o primeiro andar com vaga é o da casa nova');
    const log = (await req(h, 'GET', '/api/activity', s)).json as Array<{ action: string; evidence: string }>;
    assert.match(log.find((e) => e.action === 'structure.create')!.evidence, /nenhum \(versão local\)/);
  });

  test('editor: move a estrutura para um lote livre; recusa sobreposição', async () => {
    const termas = (await cityStructures(h, s)).find((x: { kind: string }) => x.kind === 'termas');
    assert.equal((await req(h, 'PATCH', `/api/structures/${termas.id}`, s, { i: 3, j: 1 })).status, 409);
    assert.equal((await req(h, 'PATCH', `/api/structures/${termas.id}`, s, { i: 2, j: 5 })).status, 200);
    const moved = (await cityStructures(h, s)).find((x: { id: string }) => x.id === termas.id);
    assert.deepEqual([moved.i, moved.j], [2, 5]);
    assert.equal((await req(h, 'PATCH', `/api/structures/${termas.id}`, s, { name: 'Termas de Ergon' })).status, 200);
  });

  test('andares por estrutura até o máximo do tipo; remover só vazia e só criada na loja', async () => {
    const st = { structures: await cityStructures(h, s) };
    const casa = st.structures.find((x: { kind: string }) => x.kind === 'oikos');
    assert.equal((await req(h, 'POST', `/api/structures/${casa.id}/floors`, s)).status, 201);
    const full = await req(h, 'POST', `/api/structures/${casa.id}/floors`, s);
    assert.equal(full.status, 409);
    assert.equal(full.json.error, 'max_floors');
    const busy = await req(h, 'DELETE', `/api/structures/${casa.id}`, s);
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error, 'structure_occupied');
    const stoa = st.structures.find((x: { kind: string }) => x.kind === 'stoa');
    assert.equal((await req(h, 'DELETE', `/api/structures/${stoa.id}`, s)).json.error, 'base_structure');
    const free = await req(h, 'POST', '/api/structures', s, { kind: 'pharmakopoleion', i: 1, j: 0 });
    assert.equal((await req(h, 'DELETE', `/api/structures/${free.json.id}`, s)).status, 200);
    assert.ok(!(await cityStructures(h, s)).some((x: { id: string }) => x.id === free.json.id));
  });

  test('versão anterior (Stoa sem lote) ganha lote e as áreas na inicialização, uma vez só', async () => {
    h.db.run('UPDATE buildings SET lot_x = NULL, lot_z = NULL WHERE workspace_id = ? AND kind = ?', s.workspaceId, 'stoa');
    h.db.run("UPDATE buildings SET removed_at = ? WHERE workspace_id = ? AND kind = 'bairro'", now(), s.workspaceId);
    const { ensureCity } = await import('../src/services/structures.ts');
    const changed = ensureCity(h.db, null, s.workspaceId);
    assert.ok(changed.includes('stoa') && changed.includes('bairro'));
    assert.deepEqual(ensureCity(h.db, null, s.workspaceId), [], 'idempotente');
  });
});

describe('consumo informado pelo provedor', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('início do mês e do ano no fuso de quem pergunta', () => {
    // 1º de março, 01:00 em São Paulo (UTC−3) = 04:00 UTC → mês começa em 1º de março 03:00 UTC
    const t = Date.UTC(2026, 2, 1, 4, 0, 0);
    assert.deepEqual(periodStarts(t, 180), { month: '2026-03-01T03:00:00.000Z', year: '2026-01-01T03:00:00.000Z' });
  });

  test('soma só execuções reais; custo ausente fica "não informado" (null), nunca zero estimado', async () => {
    const ag = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? LIMIT 1", s.workspaceId)!;
    const ins = (mode: string, tin: number | null, tout: number | null, cost: number | null, est = 0) => h.db.run(
      `INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, tokens_in, tokens_out, cost_usd, cost_is_estimate, created_at)
       VALUES (?, ?, ?, 'chat', 'succeeded', ?, 'x', ?, ?, ?, ?, ?, ?)`, id('run'), s.workspaceId, ag.id, mode, id('idem'), tin, tout, cost, est, now());
    ins('real', 2874, 3, null); ins('real', 1000, 200, null); ins('simulated', null, null, null);
    let u = usageSummary(h.db, s.workspaceId, 0);
    assert.equal(u.month.runs, 2);
    assert.equal(u.month.tokensIn, 3874);
    assert.equal(u.month.tokensOut, 203);
    assert.equal(u.month.costUsd, null);
    assert.equal(u.subscription, null);
    ins('real', 10, 10, 0.25); ins('real', 10, 10, 9.99, 1); // estimativa não entra
    u = usageSummary(h.db, s.workspaceId, 0);
    assert.equal(u.month.costUsd, 0.25);
    assert.equal(u.month.runsWithCost, 1);
    const api = (await req(h, 'GET', '/api/usage?tz=180', s)).json;
    assert.equal(api.year.runs, 4);
  });
});
