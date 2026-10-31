/**
 * Equipe visual e escala (docs/EQUIPE_VISUAL.md): consultas por partes com totais do banco, mover entre setores e
 * construções (com conflito, construção cheia e Coordenador), criação com a aparência da prévia, efeito pessoal dos
 * Pacotes e o ensaio sintético de escala (milhares de agentes e de construções, sem executar nenhum).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { buildPackage, type PackageData } from '../src/services/ergon-package.ts';
import { foldText } from '../src/db/db.ts';
import { fitAt, freeCells } from '../../shared/city.ts';
import { ORIGIN, cityStructures, harness, oldPlaces, req, setupOwner, type Harness, type Session } from './helpers.ts';

type Agent = { id: string; name: string; role: string; coordinator: boolean; sector_key: string; building_id: string | null; status: string };
/** id sintético no formato real (prefixo + 32 hex) */
const sid = (p: string, n: number) => `${p}_ee${String(n).padStart(30, '0')}`;
type Page<T> = { items: T[]; total: number; next: string | null };

const pkg = (id: string, effects: NonNullable<PackageData['effects']>) => buildPackage({ package_id: id, version: '1.0.0', title: 'Efeitos de teste', summary: 'Efeitos para a equipe', creator_id: 'ana', license: 'CC-BY-4.0', ergon: { min: '0.2.0' }, kind: 'fx' }, { effects });
const install = async (h: Harness, s: Session, buf: Buffer) => { const r = await h.app.inject({ method: 'POST', url: '/api/packages/install', payload: buf, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/x-ergon' } }); return { status: r.statusCode, json: JSON.parse(r.body) as { id: string } }; };

describe('Equipe por partes, mover e criar', () => {
  let h: Harness; let s: Session;
  const all = async (url: string) => { const out: Agent[] = []; let next: string | null = null; let pages = 0;
    do { const r = await req(h, 'GET', `${url}${url.includes('?') ? '&' : '?'}limit=5${next ? `&cursor=${next}` : ''}`, s); const p = r.json as Page<Agent>; out.push(...p.items); next = p.next; pages++; } while (next && pages < 100);
    return out; };
  const byName = async (name: string) => ((await req(h, 'GET', `/api/team/agents?q=${encodeURIComponent(name)}`, s)).json as Page<Agent>).items.find((a) => a.name === name)!;

  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('lista por partes: cursor estável, Coordenador primeiro, nomes sem acento, total do banco', async () => {
    const sum = (await req(h, 'GET', '/api/team/summary', s)).json;
    const list = await all('/api/team/agents');
    assert.equal(list.length, sum.agents.active);
    assert.equal(new Set(list.map((a) => a.id)).size, list.length, 'sem repetidos entre páginas');
    assert.equal(list[0].coordinator, true);
    const rest = list.slice(1).map((a) => foldText(a.name));
    assert.deepEqual(rest, [...rest].sort(), 'ordem alfabética sem acento');
    const p = (await req(h, 'GET', '/api/team/agents?limit=3', s)).json as Page<Agent>;
    assert.equal(p.items.length, 3); assert.equal(p.total, sum.agents.active); assert.ok(p.next);
    assert.equal((await req(h, 'GET', '/api/team/agents?cursor=lixo!', s)).status, 400);
  });

  test('busca sem acento e sem caixa; setores e construções com contagem e amostra', async () => {
    await req(h, 'POST', '/api/agents', s, { name: 'Ésquilo', role: 'Roteiros de teatro', sectorKey: 'auto' });
    assert.ok((await req(h, 'GET', '/api/team/agents?q=ESQUI', s)).json.items.some((a: Agent) => a.name === 'Ésquilo'));
    assert.ok((await req(h, 'GET', '/api/team/agents?q=teatro', s)).json.items.some((a: Agent) => a.name === 'Ésquilo'), 'acha pelo papel');
    const sectors = (await req(h, 'GET', '/api/team/sectors', s)).json as Page<{ key: string; count: number; sample: Agent[] }>;
    const sum = (await req(h, 'GET', '/api/team/summary', s)).json;
    assert.equal(sectors.items.reduce((n, x) => n + x.count, 0), sum.agents.active);
    assert.ok(sectors.items.every((x) => x.sample.length <= 4 && x.sample.length === Math.min(4, x.count)));
    const st = (await req(h, 'GET', '/api/team/structures', s)).json as Page<{ id: string; active: number; slots: number; free: number; sample: Agent[] }>;
    assert.equal(st.items.reduce((n, x) => n + x.active, 0), sum.agents.active);
    assert.ok(st.items.every((x) => x.free === Math.max(0, x.slots - x.active)));
    const one = st.items.find((x) => x.active)!;
    const residents = (await req(h, 'GET', `/api/team/agents?structure=${one.id}`, s)).json as Page<Agent>;
    assert.equal(residents.total, one.active);
  });

  test('mover de setor só muda o vínculo; de construção só o endereço; Coordenador não troca de setor', async () => {
    const list0 = await all('/api/team/agents');
    const a = list0.find((x) => !x.coordinator && x.sector_key !== 'producao')!;
    const full0 = (await req(h, 'GET', `/api/agents/${a.id}`, s)).json;
    const r = await req(h, 'POST', `/api/agents/${a.id}/move`, s, { sectorKey: 'producao' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.to.sectorKey, 'producao'); assert.equal(r.json.from.sectorKey, a.sector_key);
    const full1 = (await req(h, 'GET', `/api/agents/${a.id}`, s)).json;
    for (const k of ['role', 'charter', 'tools', 'skills', 'model', 'building_id', 'look_seed']) assert.deepEqual(full1[k], full0[k], `${k} preservado`);
    // desfazer = mover de volta, conferindo que ninguém mudou depois
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, { sectorKey: a.sector_key, expect: { sectorKey: 'producao' } })).status, 200);
    const late = await req(h, 'POST', `/api/agents/${a.id}/move`, s, { sectorKey: a.sector_key, expect: { sectorKey: 'producao' } });
    assert.equal(late.status, 409); assert.equal(late.json.error, 'moved_since', 'desfazer atrasado não sobrescreve');
    // construção: setor e trabalhos ficam (uma segunda construção, num lote livre)
    const lot = await cityStructures(h, s) as Array<{ id: string; kind: string; i: number; j: number }>;
    let at: [number, number] | null = null;
    for (const [ci, cj] of freeCells(lot)) { at = fitAt(lot, 'emporion', ci, cj); if (at) break; }
    assert.equal((await req(h, 'POST', '/api/structures', s, { kind: 'emporion', i: at![0], j: at![1] })).status, 201);
    const structs = (await req(h, 'GET', '/api/team/structures?free=1', s)).json.items as Array<{ id: string }>;
    const other = structs.find((x) => x.id !== a.building_id)!;
    const m = await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: other.id });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const after = (await req(h, 'GET', `/api/agents/${a.id}`, s)).json;
    assert.equal(after.building_id, other.id); assert.equal(after.profile, a.sector_key);
    // Coordenador
    const coord = (await req(h, 'GET', '/api/team/agents?limit=1', s)).json.items[0] as Agent;
    assert.equal((await req(h, 'POST', `/api/agents/${coord.id}/move`, s, { sectorKey: 'producao' })).json.error, 'fixed_sector');
    const cm = await req(h, 'POST', `/api/agents/${coord.id}/move`, s, { structureId: other.id });
    assert.ok(cm.status === 200 || cm.json.error === 'structure_full', JSON.stringify(cm.json));
    // os dois de uma vez, nenhum, o mesmo lugar, outro workspace
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, { sectorKey: 'producao', structureId: other.id })).status, 400);
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, {})).status, 400);
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: other.id })).json.changed, false);
    assert.equal((await req(h, 'POST', '/api/agents/agt_00000000000000000000000000000000/move', s, { sectorKey: 'producao' })).status, 404);
  });

  test('construção cheia: erro claro; "Adicionar andar e mover" numa transação; não recebe agente nem fora do mapa', async () => {
    const a = (await all('/api/team/agents')).filter((x) => !x.coordinator).at(-1)!;
    // uma casa (1 andar pequeno) cheia de propósito, num lote livre de verdade
    const lot = await cityStructures(h, s) as Array<{ id: string; kind: string; i: number; j: number }>;
    let at: [number, number] | null = null;
    for (const [ci, cj] of freeCells(lot)) { at = fitAt(lot, 'oikos', ci, cj); if (at) break; }
    const made = await req(h, 'POST', '/api/structures', s, { kind: 'oikos', i: at![0], j: at![1] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const house = made!.json.id;
    const info = () => req(h, 'GET', '/api/team/structures?q=oikos&limit=100', s).then((r) => (r.json.items as Array<{ id: string; slots: number; active: number; floors: number; can_grow: boolean }>).find((x) => x.id === house)!);
    const slots = (await info()).slots;
    const fillers = ((await req(h, 'GET', '/api/team/agents?limit=50', s)).json.items as Agent[]).filter((x) => !x.coordinator && x.id !== a.id).slice(0, slots);
    for (const f of fillers) assert.equal((await req(h, 'POST', `/api/agents/${f.id}/move`, s, { structureId: house })).status, 200);
    const full = await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: house });
    assert.equal(full.status, 409); assert.equal(full.json.error, 'structure_full');
    const before = await info();
    const grown = await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: house, addFloor: true });
    if (before.can_grow) {
      assert.equal(grown.status, 200, JSON.stringify(grown.json)); assert.equal(grown.json.grew, true);
      assert.equal((await info()).floors, before.floors + 1);
    } else assert.equal(grown.json.error, 'max_floors');
    const agora = lot.find((x) => x.kind === 'agora')!;
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: agora.id })).json.error, 'not_building');
  });

  test('criar com a aparência da prévia: a semente e a cor enviadas ficam gravadas', async () => {
    const r = await req(h, 'POST', '/api/agents', s, { name: 'Temístocles', role: 'Propostas comerciais', sectorKey: 'auto', lookSeed: 123456789, color: '#2f6f8f' });
    assert.equal(r.status, 201);
    const full = (await req(h, 'GET', `/api/agents/${r.json.id}`, s)).json;
    assert.equal(full.look_seed, 123456789); assert.equal(full.color, '#2f6f8f');
    assert.equal((await req(h, 'POST', '/api/agents', s, { name: 'Temístocles', role: 'x', lookSeed: 5 })).status, 409, 'o segundo clique não cria outro');
    assert.equal((await req(h, 'POST', '/api/agents', s, { name: 'Outro', role: 'x', lookSeed: 0 })).status, 400);
  });

  test('efeito pessoal: só pacotes instalados; pessoal > alvos; sem efeito; renomear mantém; desinstalar volta ao padrão', async () => {
    assert.deepEqual((await req(h, 'GET', '/api/packages/fx-options', s)).json, []);
    const inst = await install(h, s, await pkg('comunidade.ana.efeitos', [
      { target: { all: true }, effect: 'aura', color: '#c9a227', intensity: 0.5 },
      { target: { agentName: 'ninguém' }, effect: 'celestial_glow', color: '#b9d7ff', intensity: 0.7 },
    ]));
    assert.equal(inst.status, 200, JSON.stringify(inst.json));
    const opts = (await req(h, 'GET', '/api/packages/fx-options', s)).json as Array<{ id: string; label: string }>;
    assert.deepEqual(opts.map((o) => o.label), ['Aura', 'Brilho celeste']);
    const a = await byName('Temístocles'); const b = await byName('Heródoto');
    const fx = async () => (await req(h, 'GET', '/api/packages/cosmetics', s)).json.effects as Array<{ agentId: string; effect: string }>;
    assert.deepEqual((await fx()).filter((e) => e.agentId === a.id).map((e) => e.effect), ['aura'], 'herda o alvo "todos"');
    assert.equal((await req(h, 'PUT', `/api/agents/${a.id}/fx`, s, { mode: 'custom', option: opts[1].id })).status, 200);
    assert.deepEqual((await fx()).filter((e) => e.agentId === a.id).map((e) => e.effect), ['celestial_glow'], 'pessoal substitui, sem duplicar');
    await req(h, 'PUT', `/api/agents/${b.id}/fx`, s, { mode: 'off' });
    assert.equal((await fx()).filter((e) => e.agentId === b.id).length, 0, 'sem efeito');
    assert.equal((await req(h, 'PUT', `/api/agents/${a.id}/fx`, s, { mode: 'custom', option: 'pkg_00000000000000000000000000000000:0' })).status, 409, 'só o que está instalado');
    await req(h, 'PATCH', `/api/agents/${a.id}`, s, { name: 'Temístocles II' });
    assert.equal((await req(h, 'GET', `/api/agents/${a.id}/fx`, s)).json.option, opts[1].id, 'renomear não perde o vínculo');
    // criar já com efeito, numa transação só
    const c = await req(h, 'POST', '/api/agents', s, { name: 'Cleóbulo', role: 'Conteúdo', lookSeed: 77, fx: { mode: 'custom', option: opts[0].id } });
    assert.equal(c.status, 201);
    assert.equal((await req(h, 'GET', `/api/agents/${c.json.id}`, s)).json.fx.mode, 'custom');
    const bad = await req(h, 'POST', '/api/agents', s, { name: 'Sem Pacote', role: 'x', fx: { mode: 'custom', option: 'pkg_00000000000000000000000000000000:3' } });
    assert.equal(bad.status, 409);
    assert.equal((await req(h, 'GET', '/api/team/agents?q=sem%20pacote', s)).json.total, 0, 'falhou: nenhum agente pela metade');
    // desinstalar: quem usava volta a herdar (explícito) e o agente continua
    await req(h, 'DELETE', `/api/packages/${inst.json.id}`, s);
    assert.equal((await req(h, 'GET', `/api/agents/${a.id}/fx`, s)).json.mode, 'inherit');
    assert.equal((await fx()).filter((e) => e.agentId === a.id).length, 0);
    assert.equal((await req(h, 'GET', `/api/agents/${a.id}`, s)).status, 200);
  });

  test('desativado: não muda de endereço; reativar continua pelo caminho de sempre', async () => {
    const a = await byName('Cleóbulo');
    await req(h, 'POST', `/api/agents/${a.id}/deactivate`, s);
    const st = (await req(h, 'GET', '/api/team/structures?free=1', s)).json.items as Array<{ id: string }>;
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/move`, s, { structureId: st.find((x) => x.id !== a.building_id)!.id })).json.error, 'inactive');
    assert.ok((await req(h, 'GET', '/api/team/agents?status=archived', s)).json.items.some((x: Agent) => x.id === a.id));
    assert.equal((await req(h, 'POST', `/api/agents/${a.id}/reactivate`, s)).status, 200);
  });
});

describe('organização assistida: sugerir, aplicar numa transação, desfazer', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('sugere juntar o setor onde ele já é maioria, só com lugares livres; aplica tudo ou nada; desfaz honesto', async () => {
    // duas construções novas: metade da Produção vai morar longe da colega
    const lot = await cityStructures(h, s) as Array<{ id: string; kind: string; i: number; j: number }>;
    const place = async (kind: string) => { let at: [number, number] | null = null; const cur = await cityStructures(h, s); for (const [ci, cj] of freeCells(cur)) { at = fitAt(cur, kind, ci, cj); if (at) break; } return (await req(h, 'POST', '/api/structures', s, { kind, i: at![0], j: at![1], name: kind === 'emporion' ? 'Empório' : 'Ateliê' })).json.id as string; };
    void lot;
    const emporio = await place('emporion');
    const prod = ((await req(h, 'GET', '/api/team/agents?sector=producao', s)).json.items as Agent[]);
    assert.ok(prod.length >= 2);
    assert.equal((await req(h, 'POST', `/api/agents/${prod[0].id}/move`, s, { structureId: emporio })).status, 200);
    const plan = (await req(h, 'GET', '/api/team/distribution', s)).json;
    assert.equal(plan.total, 1, JSON.stringify(plan));
    assert.equal(plan.moves[0].agentId, prod[0].id, 'volta para junto do setor');
    assert.ok(plan.structures.some((x: { id: string; before: number; after: number }) => x.id === emporio && x.after === x.before - 1));
    // nada é gravado na prévia
    assert.equal((await req(h, 'GET', `/api/team/agents/${prod[0].id}`, s)).json.building_id, emporio);
    // a equipe mudou depois da prévia: aplicar é recusado inteiro
    const other = (await req(h, 'GET', '/api/team/agents?sector=qualidade', s)).json.items[0] as Agent;
    assert.equal((await req(h, 'POST', `/api/agents/${other.id}/move`, s, { structureId: emporio })).status, 200);
    const stale = await req(h, 'POST', '/api/team/distribution/apply', s, { planId: plan.planId });
    assert.equal(stale.status, 409); assert.equal(stale.json.error, 'plan_changed');
    assert.equal((await req(h, 'GET', `/api/team/agents/${prod[0].id}`, s)).json.building_id, emporio, 'nada aplicado');
    // prévia nova, aplicada
    const p2 = (await req(h, 'GET', '/api/team/distribution', s)).json;
    assert.equal(p2.total, 2);
    const ap = await req(h, 'POST', '/api/team/distribution/apply', s, { planId: p2.planId });
    assert.equal(ap.status, 200, JSON.stringify(ap.json)); assert.equal(ap.json.moved, 2);
    const after = (await req(h, 'GET', `/api/team/agents/${prod[0].id}`, s)).json;
    assert.notEqual(after.building_id, emporio); assert.equal(after.sector_key, 'producao', 'o setor não muda');
    assert.equal((await req(h, 'GET', '/api/team/distribution', s)).json.total, 0, 'já distribuída');
    // desfazer: volta os dois; depois de desfeito, não desfaz de novo
    const un = await req(h, 'POST', `/api/team/distribution/undo/${ap.json.batchId}`, s);
    assert.equal(un.status, 200, JSON.stringify(un.json)); assert.equal(un.json.moved, 2);
    assert.equal((await req(h, 'GET', `/api/team/agents/${prod[0].id}`, s)).json.building_id, emporio);
    assert.equal((await req(h, 'POST', `/api/team/distribution/undo/${ap.json.batchId}`, s)).json.error, 'already_undone');
    // aplicar de novo e mexer em alguém: desfazer é recusado inteiro
    const p3 = (await req(h, 'GET', '/api/team/distribution', s)).json;
    const ap3 = await req(h, 'POST', '/api/team/distribution/apply', s, { planId: p3.planId });
    assert.equal((await req(h, 'POST', `/api/agents/${prod[0].id}/move`, s, { structureId: emporio })).status, 200);
    const un3 = await req(h, 'POST', `/api/team/distribution/undo/${ap3.json.batchId}`, s);
    assert.equal(un3.status, 409); assert.equal(un3.json.error, 'moved_since');
  });
});

describe('organização assistida: mudanças encadeadas', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('quem entra no lugar que outro liberou: aplicar e desfazer (na ordem inversa) dão certo', async () => {
    const ws = s.workspaceId; const db = h.db; const t0 = new Date().toISOString();
    db.tx(() => {
      for (const [k, n] of [['p-sint', 'Setor P'], ['q-sint', 'Setor Q']]) db.run("INSERT INTO profiles (id, workspace_id, key, name, instructions, creates_tasks, position, custom) VALUES (?, ?, ?, ?, '', 'explicit_only', 90, 1)", sid('prf', k === 'p-sint' ? 1 : 2), ws, k, n);
      for (const [b, slots, t] of [[1, 2, '2030-01-01'], [2, 5, '2030-01-02']] as const) {
        db.run("INSERT INTO buildings (id, workspace_id, name, kind, origin, created_at, lot_x, lot_z) VALUES (?, ?, ?, 'stoa', 'simulated', ?, ?, 900)", sid('bld', b), ws, `S${b}`, t, 900 + b);
        db.run("INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at) VALUES (?, ?, ?, 0, 'Térreo', ?, 'simulated', ?)", sid('flr', b), ws, sid('bld', b), slots, t0);
      }
      const put = (n: number, name: string, sector: number, b: number) => db.run("INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at) VALUES (?, ?, ?, ?, ?, 'x', '#2f6f8f', 'active', ?)", sid('agt', n), ws, sid('flr', b), sid('prf', sector), name, t0);
      put(1, 'Ana', 1, 1); put(2, 'Zeca', 2, 1); put(3, 'P2', 1, 2); put(4, 'P3', 1, 2); put(5, 'P4', 1, 2); put(6, 'Bruno', 2, 2);
    });
    const plan = (await req(h, 'GET', '/api/team/distribution', s)).json;
    assert.deepEqual(plan.moves.map((m: { name: string; fromName: string; toName: string }) => `${m.name}:${m.fromName}>${m.toName}`), ['Ana:S1>S2', 'Bruno:S2>S1']);
    const ap = await req(h, 'POST', '/api/team/distribution/apply', s, { planId: plan.planId });
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    const un = await req(h, 'POST', `/api/team/distribution/undo/${ap.json.batchId}`, s);
    assert.equal(un.status, 200, JSON.stringify(un.json));
    assert.equal(db.get<{ f: string }>('SELECT floor_id AS f FROM agents WHERE id = ?', sid('agt', 1))!.f, sid('flr', 1));
    assert.equal(db.get<{ f: string }>('SELECT floor_id AS f FROM agents WHERE id = ?', sid('agt', 6))!.f, sid('flr', 2));
  });
});

describe('ensaio de escala (dados sintéticos, nenhum agente executa)', () => {
  let h: Harness; let s: Session;
  const N_AGENTS = 10_000; const N_STRUCT = 2_000; const CONCENTRATED = 5_000;
  const time = async (url: string) => { const t = performance.now(); const r = await req(h, 'GET', url, s); return { ms: performance.now() - t, r, bytes: Buffer.byteLength(JSON.stringify(r.json)) }; };
  const report: string[] = [];

  before(async () => {
    h = await harness(); s = await setupOwner(h);
    const ws = s.workspaceId; const db = h.db; const t0 = new Date().toISOString();
    const sector = db.get<{ id: string }>("SELECT id FROM profiles WHERE workspace_id = ? AND key = 'producao'", ws)!.id;
    const sectors = db.all<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = ?', ws).map((x) => x.id);
    db.tx(() => {
      // muitos setores vazios
      for (let i = 0; i < 300; i++) db.run("INSERT INTO profiles (id, workspace_id, key, name, instructions, creates_tasks, description, position, custom) VALUES (?, ?, ?, ?, '', 'explicit_only', NULL, ?, 1)", sid('prf', i), ws, `vazio-${i}`, `Setor vazio ${i}`, 100 + i);
      // construções: nomes repetidos e lotes muito distantes; uma concentra milhares de moradores
      for (let b = 0; b < N_STRUCT; b++) {
        const bid = sid('bld', b);
        db.run("INSERT INTO buildings (id, workspace_id, name, kind, origin, created_at, lot_x, lot_z) VALUES (?, ?, ?, 'stoa', 'simulated', ?, ?, ?)", bid, ws, b % 3 === 0 ? 'Stoa Repetida' : `Stoa ${b}`, t0, 1000 + (b % 50) * 900, 1000 + Math.floor(b / 50) * 900);
        const floors = b === 0 ? Math.ceil(CONCENTRATED / 50) : 2;
        for (let f = 0; f < floors; f++) db.run("INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at) VALUES (?, ?, ?, ?, ?, 50, 'simulated', ?)", sid('flr', b * 1000 + f), ws, bid, f, `${f}º`, t0);
      }
      for (let i = 0; i < N_AGENTS; i++) {
        const b = i < CONCENTRATED ? 0 : 1 + ((i - CONCENTRATED) % (N_STRUCT - 1));
        const f = i < CONCENTRATED ? Math.floor(i / 50) : Math.floor(((i - CONCENTRATED) / (N_STRUCT - 1)) % 2);
        db.run("INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at) VALUES (?, ?, ?, ?, ?, ?, '#2f6f8f', 'active', ?)",
          sid('agt', i), ws, sid('flr', b * 1000 + f), i % 2 ? sector : sectors[i % sectors.length], `Agente ${String(i).padStart(5, '0')}`, i % 7 ? 'Pesquisa' : 'Propostas comerciais', t0);
      }
    });
  });
  after(async () => { console.log(`\n[escala] ${report.join(' · ')}`); await h.close(); });

  test(`${N_AGENTS} agentes e ${N_STRUCT} construções: páginas limitadas, totais exatos, consultas rápidas`, async () => {
    const sum = await time('/api/team/summary');
    assert.ok(sum.r.json.agents.active >= N_AGENTS); assert.ok(sum.r.json.structures >= N_STRUCT);
    const first = await time('/api/team/agents?limit=48');
    assert.equal(first.r.json.items.length, 48); assert.equal(first.r.json.total, sum.r.json.agents.active);
    const search = await time('/api/team/agents?q=comerciais&limit=48');
    assert.ok(search.r.json.total >= Math.floor(N_AGENTS / 7));
    // percorrer 20 páginas seguidas pelo cursor: sem repetir, sem pular
    let next: string | null = first.r.json.next; const seen = new Set<string>(first.r.json.items.map((a: Agent) => a.id)); let worst = 0;
    for (let i = 0; i < 20 && next; i++) { const p = await time(`/api/team/agents?limit=48&cursor=${next}`); worst = Math.max(worst, p.ms); for (const a of p.r.json.items) { assert.ok(!seen.has(a.id)); seen.add(a.id); } next = p.r.json.next; }
    const structs = await time('/api/team/structures?limit=24');
    assert.equal(structs.r.json.items.length, 24); assert.ok(structs.r.json.total >= N_STRUCT);
    assert.ok(structs.r.json.items.every((x: { sample: unknown[] }) => x.sample.length <= 4));
    const dupes = await time('/api/team/structures?q=repetida&limit=100');
    assert.ok(dupes.r.json.total >= 600); assert.equal(new Set(dupes.r.json.items.map((x: { id: string }) => x.id)).size, dupes.r.json.items.length, 'homônimas distintas pelo id');
    const big = await time(`/api/team/agents?structure=${sid('bld', 0)}&limit=48`);
    assert.equal(big.r.json.total, CONCENTRATED); assert.equal(big.r.json.items.length, 48);
    const free = await time('/api/team/structures?free=1&limit=24');
    const sectors = await time('/api/team/sectors?limit=24');
    assert.ok(sectors.r.json.total >= 300); assert.equal(sectors.r.json.items.length, 24);
    // mover para uma construção distante, que nunca foi carregada na tela
    const far = sid('bld', 1999);
    const mv = await (async () => { const t = performance.now(); const r = await req(h, 'POST', `/api/agents/${sid('agt', 1)}/move`, s, { structureId: far }); return { ms: performance.now() - t, r }; })();
    assert.ok(mv.r.status === 200 || mv.r.json.error === 'structure_full', JSON.stringify(mv.r.json));
    for (const [k, v] of Object.entries({ resumo: sum, pagina: first, busca: search, construcoes: structs, homonimas: dupes, concentrada: big, livres: free, setores: sectors })) {
      report.push(`${k} ${v.ms.toFixed(0)} ms/${(v.bytes / 1024).toFixed(1)} KB`);
      assert.ok(v.ms < 2000, `${k}: ${v.ms.toFixed(0)} ms`);
      assert.ok(v.bytes < 200 * 1024, `${k}: resposta limitada (${v.bytes} bytes)`);
    }
    report.push(`pior página do cursor ${worst.toFixed(0)} ms`, `mover distante ${mv.ms.toFixed(0)} ms`);
  });

  test('sugestão de distribuição com 10.000: resposta limitada, plano inteiro contado', async () => {
    const d = await time('/api/team/distribution');
    assert.equal(d.r.status, 200);
    assert.ok(d.r.json.moves.length <= 200); assert.ok(d.r.json.total >= d.r.json.moves.length);
    report.push(`sugestão de distribuição ${d.ms.toFixed(0)} ms/${(d.bytes / 1024).toFixed(1)} KB (${d.r.json.total} mudariam)`);
    assert.ok(d.ms < 5000, `${d.ms} ms`);
  });

  test('cidade por região com 10.000: /api/state pequeno, a cidade sem agentes, moradores por partes e vaga/casa como antes', async () => {
    const ws = s.workspaceId;
    const active = Number(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", ws)!.n);
    const st = await time('/api/state');
    assert.equal(st.r.status, 200); assert.equal(st.r.json.agents, undefined); assert.equal(st.r.json.structures, undefined);
    assert.equal(st.r.json.team.active, active); assert.ok(st.r.json.team.coordinator);
    const ov = await time('/api/city/overview');
    assert.equal(ov.r.json.total, active); assert.ok(ov.r.json.structures.length >= N_STRUCT);
    type F = { id: string; active: number }; type B = { id: string; floors: F[] };
    const structs = ov.r.json.structures as B[];
    assert.equal(structs.flatMap((x) => x.floors).reduce((n, f) => n + f.active, 0), active, 'as contagens somam todos');
    // o que a tela pede de uma vez: 100 andares; 64 construções com as 3 primeiras vagas; a construção concentrada inteira; 200 pelo id
    const floors = structs.slice(1).flatMap((x) => x.floors.filter((f) => f.active).map((f) => f.id)).filter((_, i) => i % 7 === 0).slice(0, 100);
    const bf = await time(`/api/city/agents?f=${floors.join(',')}`);
    const blds = structs.filter((x) => x.floors.some((f) => f.active)).slice(0, 64).map((x) => x.id);
    const bb = await time(`/api/city/agents?b=${blds.join(',')}&per=3`);
    const big = await time(`/api/city/agents?b=${sid('bld', 0)}`);
    const some = Array.from({ length: 200 }, (_, i) => sid('agt', (i * 97) % N_AGENTS));
    const bi = await time(`/api/city/agents?ids=${some.join(',')}`);
    assert.equal(big.r.json.total, big.r.json.agents.length); assert.ok(big.r.json.total >= CONCENTRATED - 1);
    assert.ok(bb.r.json.agents.length <= 64 * 100 * 3 && bb.r.json.total >= bb.r.json.agents.length, 'per corta o que vem, não o total');
    // todos, por páginas de 2.000: vaga e casa iguais às do cálculo de antes (a lista inteira na ordem do /api/state de antes)
    const old = oldPlaces(h.db.all<{ id: string; status: string; building_id: string; floor_level: number }>(
      `SELECT a.id, a.status, f.building_id, f.level AS floor_level FROM agents a JOIN floors f ON f.id = a.floor_id JOIN profiles p ON p.id = a.profile_id
        WHERE a.workspace_id = ? ORDER BY a.status, f.building_id, f.level, a.created_at, a.rowid`, ws));
    const same = (list: Array<{ id: string; building_id: string; level: number; slot: number; house: number }>, mode: string) => {
      for (const a of list) { const w = old.get(a.id)!; assert.ok(w, `${mode}: ${a.id}`); assert.deepEqual([a.building_id, a.level, a.slot, a.house], [w.building, w.level, w.slot, w.house], `${mode}: ${a.id}`); }
    };
    let cursor: string | null = null; let pages = 0; let worst = 0; let heaviest = 0; const seen = new Set<string>();
    do {
      const p = await time(`/api/city/agents?all=1${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(p.r.status, 200); assert.ok(p.r.json.agents.length <= 2000); assert.equal(p.r.json.total, active);
      worst = Math.max(worst, p.ms); heaviest = Math.max(heaviest, p.bytes);
      same(p.r.json.agents, 'all');
      for (const a of p.r.json.agents) { assert.ok(!seen.has(a.id), 'sem repetir entre páginas'); seen.add(a.id); }
      cursor = p.r.json.next; pages++;
    } while (cursor && pages < 20);
    assert.equal(seen.size, active); assert.ok(pages >= 5);
    same(bf.r.json.agents, 'f'); same(bb.r.json.agents, 'b'); same(big.r.json.agents, 'b inteira'); same(bi.r.json.agents, 'ids');
    const search = await time('/api/search?q=agente%2000');
    assert.equal(search.r.json.agents.length, 6);
    const tools = await time('/api/ai/tools');
    const prof = await time('/api/agents?limit=100');
    assert.equal(prof.r.json.items.length, 100); assert.ok(prof.r.json.total >= active); assert.ok(prof.r.json.next);
    for (const [k, v, maxKb] of [['state', st, 100], ['overview', ov, 2048], ['andares(100)', bf, 512], ['construcoes(64,per3)', bb, 512], ['concentrada(5000)', big, 3072],
      ['ids(200)', bi, 256], ['paleta', search, 16], ['ferramentas', tools, 64], ['perfis(100)', prof, 512]] as const) {
      report.push(`${k} ${v.ms.toFixed(0)} ms/${(v.bytes / 1024).toFixed(1)} KB`);
      assert.ok(v.ms < (k === 'state' ? 500 : 2000), `${k}: ${v.ms.toFixed(0)} ms`);
      assert.ok(v.bytes < maxKb * 1024, `${k}: ${v.bytes} bytes`);
    }
    report.push(`todos em ${pages} páginas (pior ${worst.toFixed(0)} ms/${(heaviest / 1024).toFixed(0)} KB)`);
    assert.ok(worst < 2000 && heaviest < 1536 * 1024);
  });
});
