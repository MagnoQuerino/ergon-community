/**
 * Carregador da Cidade (lib/cityData.ts, docs/CIDADE_REGIOES.md) sem navegador: servidor e relógio de mentira.
 * Modo e histerese, cidade inteira em páginas, seleção por orçamento e prioridade, teto duro, carência, mapa,
 * resposta velha descartada, junção de eventos, cidade escondida, ordem entregue ao motor e a cidade pequena igual à
 * de antes (vaga, casa e ordem).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, CityLoader, GRACE_MS, HARD_CAP, MAP_UNLOAD_MS, SETTLE_MS, toScene, type Clock } from './cityData.ts';
import type { CityAgent, CityAgentsPage, CityOverview, Structure } from './types.ts';
import type { SceneAgent, SceneWindow } from '../scene/types.ts';
import { RESIDENTS_PER_HOUSE } from '../../../shared/city.ts';

const tick = () => new Promise<void>((r) => setImmediate(r));

class FakeClock implements Clock {
  t = 0; private q: Array<{ at: number; fn: () => void; id: number }> = []; private n = 0;
  now() { return this.t; }
  after(ms: number, fn: () => void) { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; }
  cancel(h: unknown) { this.q = this.q.filter((x) => x.id !== h); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const x = this.q[0]; if (!x || x.at > end) break;
      this.q.shift(); this.t = x.at; x.fn();
    }
    this.t = end;
  }
}

/** Servidor de mentira: responde com o banco do momento do pedido (como o servidor real), quando o teste mandar. */
class FakeServer {
  db: CityAgent[] = []; page = 2000;
  reqs: Array<{ q: string; snap: CityAgentsPage; resolve: (p: CityAgentsPage) => void; reject: (e: Error) => void }> = [];
  log: string[] = [];
  fetch = (q: string) => new Promise<CityAgentsPage>((resolve, reject) => { this.log.push(q); this.reqs.push({ q, snap: this.answer(q), resolve, reject }); });
  answer(q: string): CityAgentsPage {
    const p = new URLSearchParams(q); const total = this.db.length;
    const copy = (l: CityAgent[]) => l.map((a) => ({ ...a }));
    if (p.get('all')) {
      const start = Number(p.get('cursor') ?? 0); const next = start + this.page < total ? String(start + this.page) : null;
      return { total, agents: copy(this.db.slice(start, start + this.page)), next };
    }
    if (p.get('f')) { const fs = new Set(p.get('f')!.split(',')); return { total, agents: copy(this.db.filter((a) => fs.has(a.floor_id))) }; }
    if (p.get('ids')) { const ids = new Set(p.get('ids')!.split(',')); return { total, agents: copy(this.db.filter((a) => ids.has(a.id))) }; }
    throw new Error(`consulta inesperada: ${q}`);
  }
  respond(i = 0) { const r = this.reqs.splice(i, 1)[0]; r.resolve(r.snap); }
  async respondAll() { while (this.reqs.length) { this.respond(0); await tick(); } await tick(); }
  floorsAsked(): string[] { return this.reqs.flatMap((r) => new URLSearchParams(r.q).get('f')?.split(',') ?? []); }
}

/** Cidade com `spec` = [construção, agentes por andar]; banco na ordem do servidor e casa pela regra do contrato. */
function cityOf(spec: Array<[string, number[]]>): { ov: CityOverview; db: CityAgent[] } {
  const structures: Structure[] = spec.map(([id, levels], n) => ({
    id, kind: 'stoa', name: id, i: n, j: 0, origin: 'local',
    floors: levels.map((active, level) => ({ id: `${id}-f${level}`, level, name: `Andar ${level}`, slots: Math.max(6, active), origin: 'base', active, working: 0, waiting: 0, queued: 0 })),
  }));
  const rows: CityAgent[] = [];
  const sorted = [...spec].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let base = 0;
  for (const [b, levels] of sorted) levels.forEach((n, level) => {
    for (let slot = 0; slot < n; slot++) rows.push(agent(`${b}-${level}-${slot}`, b, level, slot, Math.floor((base + slot) / RESIDENTS_PER_HOUSE)));
    base += n;
  });
  return { ov: { total: rows.length, structures }, db: rows };
}
function agent(id: string, building: string, level: number, slot: number, house: number, o: Partial<CityAgent> = {}): CityAgent {
  return { id, name: `Nome ${id}`, role: 'Pesquisa', color: '#2f6f8f', char_key: null, look_seed: 1, sector_name: 'Produção', building_id: building, floor_id: `${building}-f${level}`, level, slot, house, run_status: null, last_outcome: null, ...o };
}
const bid = (n: number) => `b${String(n).padStart(3, '0')}`;
const grid = (buildings: number, floors: number, per: number) => Array.from({ length: buildings }, (_, n) => [bid(n), Array(floors).fill(per)] as [string, number[]]);
/** Janela: construções na ordem (distância = posição), `near` para as primeiras `nearN`. */
const win = (ids: string[], nearN = ids.length, extra: Partial<SceneWindow> = {}): SceneWindow => ({ buildings: ids.map((id, i) => ({ id, dist: i * 10, near: i < nearN })), map: false, open: null, selected: null, ...extra });

function setup(spec: Array<[string, number[]]>) {
  const clock = new FakeClock(); const srv = new FakeServer(); const { ov, db } = cityOf(spec); srv.db = db;
  const out = { overviews: 0, changes: 0 };
  const l = new CityLoader({ agents: srv.fetch, reloadOverview: () => { out.overviews++; }, changed: () => { out.changes++; }, clock });
  return { l, clock, srv, ov, db, out };
}

test('modo: cidade inteira até 1.200, por região acima de 1.500, com histerese entre os dois', () => {
  const { l } = setup([]);
  const ov = (total: number): CityOverview => ({ total, structures: [] });
  l.setOverview(ov(1000)); assert.equal(l.mode, 'cidade');
  l.setOverview(ov(1500)); assert.equal(l.mode, 'cidade', 'até 1.500 continua inteira');
  l.setOverview(ov(1501)); assert.equal(l.mode, 'regiao');
  l.setOverview(ov(1300)); assert.equal(l.mode, 'regiao', 'na faixa do meio, fica como está');
  l.setOverview(ov(1200)); assert.equal(l.mode, 'cidade');
  // começa na faixa do meio: inteira (só vira por região acima de 1.500)
  const b = setup([]).l; b.setOverview(ov(1400)); assert.equal(b.mode, 'cidade');
  const c = setup([]).l; c.setOverview(ov(1600)); assert.equal(c.mode, 'regiao');
});

test('cidade inteira: páginas juntadas e entregues de uma vez, na ordem do servidor (BINARY)', async () => {
  // "bld_B" vem antes de "bld_a" no BINARY (maiúscula antes), ao contrário do localeCompare
  const { l, srv, ov, db } = setup([['bld_a', [2, 1]], ['bld_B', [2]], ['bld_c', [1]]]);
  srv.page = 2;
  l.setOverview(ov);
  assert.equal(l.ready, false);
  assert.deepEqual(srv.log, ['all=1']);
  srv.respond(); await tick();
  assert.equal(l.list.length, 0, 'nada aparece aos poucos');
  assert.equal(l.ready, false);
  assert.deepEqual(srv.log, ['all=1', 'all=1&cursor=2']);
  await srv.respondAll();
  assert.equal(l.ready, true); assert.equal(l.partial, false);
  assert.deepEqual(l.list.map((a) => a.id), db.map((a) => a.id));
  assert.equal(l.list[0].building_id, 'bld_B');
  assert.deepEqual(srv.log, ['all=1', 'all=1&cursor=2', 'all=1&cursor=4']);
});

test('por região: o andar aberto, o do escolhido e depois pela distância, até o orçamento; 250 ms depois de parar; 100 andares por pedido', async () => {
  // 100 prédios × 4 andares × 5 = 2.000 agentes (por região)
  const { l, clock, srv, ov } = setup(grid(100, 4, 5));
  l.setOverview(ov);
  assert.equal(l.mode, 'regiao'); assert.equal(l.ready, true, 'por região, o overview basta para desenhar');
  const ids = Array.from({ length: 100 }, (_, n) => bid(n));
  const w = win(ids, 100, { open: { building: 'b099', level: 3 }, selected: { id: 'b098-0-0', building: 'b098', level: 0 } });
  l.setWindow(w); clock.advance(100); l.setWindow(w); clock.advance(200);
  assert.equal(srv.reqs.length, 0, 'a câmera ainda mexia há menos de 250 ms');
  clock.advance(50);
  assert.equal(srv.reqs.length, 3, '300 andares em pedidos de até 100');
  assert.ok(srv.reqs.every((r) => r.q.split(',').length <= 100));
  const asked = srv.floorsAsked();
  assert.equal(asked.length, 300);
  assert.deepEqual(asked.slice(0, 4), ['b099-f3', 'b098-f0', 'b000-f0', 'b000-f1'], 'o aberto, o do escolhido e o mais perto');
  assert.equal(asked.at(-1), 'b074-f1', 'até o orçamento de 1.500 (2 obrigatórios + 298 pela distância)');
  await srv.respondAll();
  assert.equal(l.stats().agents, BUDGET);
  // nada a mais com a mesma janela
  l.setWindow({ ...w }); clock.advance(SETTLE_MS);
  assert.equal(srv.reqs.length, 0);
});

test('orçamento: o mais perto primeiro, sem pular para um mais longe que caiba; andar vazio não é pedido', () => {
  const { l, clock, srv, ov } = setup([['b000', [1000]], ['b001', [600]], ['b002', [0, 10]], ['b003', [10]], ['b900', [1000]]]);
  l.setOverview(ov); assert.equal(l.mode, 'regiao');
  l.setWindow(win(['b000', 'b001', 'b002', 'b003'])); clock.advance(SETTLE_MS);
  assert.deepEqual(srv.floorsAsked(), ['b000-f0'], '600 não cabe depois de 1.000: para ali (o 10 mais longe espera)');
});

test('teto duro de 2.500: descarrega primeiro o que está mais longe e não se quer', async () => {
  // 200 prédios × 4 × 5 = 4.000
  const { l, clock, srv, ov } = setup(grid(200, 4, 5));
  l.setOverview(ov);
  const A = Array.from({ length: 200 }, (_, n) => bid(n));
  l.setWindow(win(A, 75)); clock.advance(SETTLE_MS); await srv.respondAll();
  assert.equal(l.stats().agents, 1500);
  // uma recarga dos carregados fica a caminho enquanto a câmera vai embora
  l.event('agents.changed', {}); clock.advance(200);
  const reloads = srv.reqs.length; assert.ok(reloads > 0);
  // B: perto agora são b100…b199; os de antes continuam na margem (b000 a 100, …, b074 a 174)
  const B = [...A.slice(100), ...A.slice(0, 100)];
  l.setWindow(win(B, 100)); clock.advance(SETTLE_MS);
  const floors = new Set(l.stats().floors);
  assert.ok(floors.has('b049-f3') && !floors.has('b050-f0') && !floors.has('b074-f3'), 'saem os mais longe: b050…b074');
  assert.equal(l.stats().agents, 1000);
  await srv.respondAll();
  assert.equal(l.stats().agents, HARD_CAP);
  const after = new Set(l.stats().floors);
  assert.ok(after.has('b174-f3') && !after.has('b175-f0'));
  assert.ok(!after.has('b050-f0'), 'a recarga antiga de um andar descarregado não o traz de volta (nem vazio)');
});

test('carência: fora do que se mantém, o andar fica mais 15 s; volta antes e fica', async () => {
  const { l, clock, srv, ov } = setup(grid(100, 2, 10));
  l.setOverview(ov);
  const A = Array.from({ length: 10 }, (_, n) => bid(n)); const B = Array.from({ length: 10 }, (_, n) => bid(50 + n));
  l.setWindow(win(A)); clock.advance(SETTLE_MS); await srv.respondAll();
  assert.equal(l.stats().agents, 200);
  l.setWindow(win(B)); clock.advance(SETTLE_MS); await srv.respondAll();
  assert.equal(l.stats().agents, 400, 'os de antes ainda estão');
  clock.advance(GRACE_MS - 10);
  assert.ok(l.stats().floors.includes('b000-f0'));
  clock.advance(20);
  assert.ok(!l.stats().floors.includes('b000-f0'), 'depois de 15 s, sai');
  assert.equal(l.stats().agents, 200);
  // volta antes dos 15 s: fica
  l.setWindow(win(A)); clock.advance(SETTLE_MS); await srv.respondAll();
  clock.advance(5000); l.setWindow(win(B)); clock.advance(SETTLE_MS); clock.advance(5000);
  l.setWindow(win(A)); clock.advance(SETTLE_MS); clock.advance(GRACE_MS * 2);
  assert.ok(l.stats().floors.includes('b000-f0') && l.stats().floors.includes('b050-f0') === false);
});

test('mapa: nada novo carrega; depois de 20 s descarrega, menos o andar aberto e o do escolhido', async () => {
  const { l, clock, srv, ov } = setup(grid(100, 2, 10));
  l.setOverview(ov);
  const A = Array.from({ length: 10 }, (_, n) => bid(n));
  l.setWindow(win(A)); clock.advance(SETTLE_MS); await srv.respondAll();
  const before = srv.log.length;
  l.setWindow({ buildings: [], map: true, open: { building: 'b001', level: 0 }, selected: { id: 'b090-0-0', building: 'b090', level: 0 } });
  clock.advance(SETTLE_MS);
  assert.equal(srv.log.length, before, 'no mapa, nem o andar do escolhido (não carregado) é pedido');
  clock.advance(MAP_UNLOAD_MS - SETTLE_MS - 10);
  assert.equal(l.stats().agents, 200);
  clock.advance(20);
  assert.deepEqual(l.stats().floors, ['b001-f0']);
  // saiu do mapa: carrega de novo o que se quer
  l.setWindow(win(A)); clock.advance(SETTLE_MS);
  assert.ok(srv.floorsAsked().includes('b000-f0'));
});

test('resposta velha descartada: o pedido mais novo de um andar ganha; por agente, o dado mais novo ganha', async () => {
  const { l, clock, srv, ov, db } = setup(grid(100, 2, 10));
  l.setOverview(ov);
  l.setWindow(win([bid(0)])); clock.advance(SETTLE_MS); await srv.respondAll();
  const x = db.find((a) => a.id === 'b000-0-0')!;
  // dois recarregamentos do mesmo andar: o segundo responde primeiro
  x.name = 'v2'; l.event('agents.changed', {}); clock.advance(200);
  x.name = 'v3'; l.event('agents.changed', {}); clock.advance(1000);
  assert.equal(srv.reqs.length, 2);
  srv.respond(1); await tick(); assert.equal(l.get(x.id)!.name, 'v3');
  srv.respond(0); await tick(); assert.equal(l.get(x.id)!.name, 'v3', 'a resposta antiga não volta o nome');
  // recarga do andar pedida antes do agente (ids): a do agente, mais nova, ganha mesmo chegando antes
  clock.advance(2000);
  l.event('agents.changed', {}); clock.advance(200);
  x.run_status = 'running'; l.event('runs.changed', { agentId: x.id, status: 'running' }); clock.advance(200);
  const idsReq = srv.reqs.findIndex((r) => r.q.startsWith('ids='));
  assert.ok(idsReq >= 0);
  srv.respond(idsReq); await tick(); assert.equal(l.get(x.id)!.run_status, 'running');
  await srv.respondAll(); assert.equal(l.get(x.id)!.run_status, 'running', 'o andar (pedido antes) não desfaz');
  // resposta de um andar que saiu de vista enquanto vinha: não entra
  l.setWindow(win([bid(5)])); clock.advance(SETTLE_MS);
  l.setWindow(win([bid(9)])); clock.advance(SETTLE_MS);
  const i5 = srv.reqs.findIndex((r) => r.q.includes('b005-f0'));
  srv.respond(i5); await tick();
  assert.ok(!l.stats().floors.includes('b005-f0'));
});

test('eventos: runs.changed junta os ids dos carregados; recarregar e overview no máximo 1 vez por segundo', async () => {
  const { l, clock, srv, ov, out } = setup([['bld_a', [6, 6]]]);
  l.setOverview(ov); await srv.respondAll();
  srv.log.length = 0;
  l.event('runs.changed', { agentId: 'bld_a-0-1' }); clock.advance(50);
  l.event('runs.changed', { agentId: 'bld_a-1-2' }); l.event('runs.changed', { agentId: 'outro' }); l.event('runs.changed', { agentId: 'bld_a-0-1' });
  clock.advance(100);
  assert.deepEqual(srv.log, ['ids=bld_a-0-1,bld_a-1-2'], 'um pedido só, sem quem não está carregado');
  assert.equal(out.overviews, 1);
  l.event('runs.changed', { agentId: 'bld_a-0-1' }); clock.advance(500);
  assert.equal(out.overviews, 1, 'o overview espera completar 1 s');
  clock.advance(500);
  assert.equal(out.overviews, 2);
  await srv.respondAll(); srv.log.length = 0;
  // agents.changed em rajada: uma recarga só; outra logo depois espera 1 s
  l.event('agents.changed', {}); l.event('city.changed', { id: 'bld_a' }); l.event('agents.changed', { id: 'x' });
  clock.advance(150);
  assert.deepEqual(srv.log, ['all=1']);
  l.event('agents.changed', {}); clock.advance(800);
  assert.deepEqual(srv.log, ['all=1']);
  clock.advance(200);
  assert.deepEqual(srv.log, ['all=1'], 'a segunda espera a primeira terminar');
  srv.respond(); await tick();
  assert.deepEqual(srv.log, ['all=1', 'all=1']);
  await srv.respondAll();
  // agente que deixou de ser ativo: o ids não o traz e ele sai
  srv.db = srv.db.filter((a) => a.id !== 'bld_a-1-2');
  l.event('runs.changed', { agentId: 'bld_a-1-2' }); clock.advance(150); await srv.respondAll();
  assert.equal(l.get('bld_a-1-2'), undefined);
});

test('cidade escondida: nada entra nem sai; o que está carregado continua se atualizando', async () => {
  const { l, clock, srv, ov, db } = setup(grid(100, 2, 10));
  l.setOverview(ov);
  const A = [bid(0)]; const B = [bid(50)];
  l.setWindow(win(A)); clock.advance(SETTLE_MS); await srv.respondAll();
  l.setActive(false);
  l.setWindow(win(B)); clock.advance(SETTLE_MS); clock.advance(GRACE_MS * 3);
  assert.deepEqual(srv.reqs.length, 0);
  assert.ok(l.stats().floors.includes('b000-f0'));
  db.find((a) => a.id === 'b000-0-3')!.run_status = 'waiting_user';
  l.event('runs.changed', { agentId: 'b000-0-3' }); clock.advance(150); await srv.respondAll();
  assert.equal(l.get('b000-0-3')!.run_status, 'waiting_user');
  l.setActive(true); clock.advance(SETTLE_MS);
  assert.ok(srv.floorsAsked().includes('b050-f0'));
});

test('ordem entregue ao motor = ordem do servidor (construção BINARY, andar, vaga), mesmo com andares chegando fora de ordem', async () => {
  const spec: Array<[string, number[]]> = [['bld_a', [3, 2]], ['bld_B', [2, 3]], ['bld_c', [4]], ...grid(300, 1, 5)];
  const { l, clock, srv, ov, db } = setup(spec);
  l.setOverview(ov); assert.equal(l.mode, 'regiao');
  // dois pedidos; o segundo responde primeiro
  l.setWindow(win(['bld_c'])); clock.advance(SETTLE_MS);
  l.setWindow(win(['bld_c', 'bld_a', 'bld_B'])); clock.advance(SETTLE_MS);
  assert.equal(srv.reqs.length, 2);
  srv.respond(1); await tick(); srv.respond(0); await tick();
  const want = db.filter((a) => ['bld_a', 'bld_B', 'bld_c'].includes(a.building_id)).map((a) => a.id);
  assert.deepEqual(l.list.map((a) => a.id), want);
  assert.deepEqual(l.list.slice(0, 2).map((a) => a.building_id), ['bld_B', 'bld_B']);
  // mesma referência enquanto nada muda (o motor não recalcula à toa)
  assert.equal(l.list, l.list);
});

// ------------------------------------------------------------------ cidade pequena idêntica
/** Gerador com semente (mulberry32). */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
interface Row { id: string; name: string; building: string; level: number; created: number; rowid: number; status: 'active' | 'archived' }
const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Antes: state.agents na ordem do fullAgents, vaga contada no AmbienteView e casa calculada no motor sobre todos. */
function oldScene(team: Row[]): SceneAgent[] {
  const rows = [...team].sort((a, b) => binary(a.status, b.status) || binary(a.building, b.building) || a.level - b.level || a.created - b.created || a.rowid - b.rowid);
  const slot = new Map<string, number>();
  const list = rows.filter((a) => a.status === 'active').map((a) => {
    const k = `${a.building}|${a.level}`; const n = slot.get(k) ?? 0; slot.set(k, n + 1);
    return { id: a.id, name: a.name, color: '#2f6f8f', role: 'Pesquisa', key: null, seed: 1, building: a.building, level: a.level, slot: n, run: null, outcome: null, house: 0 } as SceneAgent;
  });
  const order = [...list].sort((a, b) => a.building.localeCompare(b.building) || a.level - b.level || a.slot - b.slot);
  const house = new Map(order.map((a, i) => [a.id, Math.floor(i / RESIDENTS_PER_HOUSE)]));
  return list.map((a) => ({ ...a, house: house.get(a.id)! }));
}
/** A regra do contrato para o servidor: vaga por ROW_NUMBER na partição (prédio, nível) e casa pela base dos pares anteriores. */
function serverRows(team: Row[]): CityAgent[] {
  const act = team.filter((a) => a.status === 'active').sort((a, b) => binary(a.building, b.building) || a.level - b.level || a.created - b.created || a.rowid - b.rowid);
  const count = new Map<string, number>(); for (const a of act) count.set(`${a.building}|${a.level}`, (count.get(`${a.building}|${a.level}`) ?? 0) + 1);
  const pairs = [...count.keys()].map((k) => k.split('|')).sort((a, b) => binary(a[0], b[0]) || Number(a[1]) - Number(b[1]));
  const base = new Map<string, number>(); let acc = 0; for (const [b, l] of pairs) { base.set(`${b}|${l}`, acc); acc += count.get(`${b}|${l}`)!; }
  const slot = new Map<string, number>();
  return act.map((a) => {
    const k = `${a.building}|${a.level}`; const s = slot.get(k) ?? 0; slot.set(k, s + 1);
    return agent(a.id, a.building, a.level, s, Math.floor((base.get(k)! + s) / RESIDENTS_PER_HOUSE), { name: a.name });
  });
}

test('cidade pequena idêntica: mesma vaga, mesma casa e mesma ordem de entrada de antes (equipes geradas)', async () => {
  const hex = (r: () => number) => Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const blds = Array.from({ length: 2 + Math.floor(r() * 4) }, () => `bld_${hex(r)}`);
    const team: Row[] = []; let t = 0;
    const create = () => team.push({ id: `agt_${hex(r)}`, name: `A${team.length}`, building: blds[Math.floor(r() * blds.length)], level: Math.floor(r() * 3), created: (t += 1 + Math.floor(r() * 3)), rowid: team.length + 1, status: 'active' });
    for (let k = 0; k < 12; k++) create();
    for (let step = 0; step < 30; step++) {
      const x = team[Math.floor(r() * team.length)]; const op = r();
      if (op < 0.3) create();
      else if (op < 0.5) x.status = 'archived';
      else if (op < 0.65) x.status = 'active';
      else { x.building = blds[Math.floor(r() * blds.length)]; x.level = Math.floor(r() * 3); }
    }
    const before = oldScene(team);
    const { l, srv } = setup([]);
    srv.db = serverRows(team);
    l.setOverview({ total: srv.db.length, structures: [] });
    await srv.respondAll();
    assert.equal(l.mode, 'cidade');
    assert.deepEqual(l.list.map(toScene), before, `semente ${seed}`);
  }
});
