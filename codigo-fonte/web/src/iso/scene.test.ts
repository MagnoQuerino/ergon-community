import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIFE_WEIGHTS, between, isDarkHour, isNightHour, msUntilMorning, pairAt, pickActivity, pickChoice, rng, type LifeChoice } from './life.ts';
import { compareBoxes, sortItems, type Sortable } from './sort.ts';
import { figureGrid, gridExtent, lookFor, type Gesture } from './figures.ts';
import { project } from './projection.ts';
import { ALEXANDRIA_DIA, ALEXANDRIA_NOITE, THEMES } from './theme.ts';
import { STOA_DESKS, benchSeat, handoffSpot, idleSpotOf, planFor, seatOf, specOf, stairBox, stairPath, visitSpot, FLOOR_H } from '../world/buildings.ts';
import { areaDef } from '../world/areas.ts';
import type { AABB } from '../world/geom.ts';

const box = (x0: number, z0: number, x1: number, z1: number, y0 = 0, y1 = 1): AABB => ({ x0, y0, z0, x1, y1, z1 });
const agent = (x: number, z: number, y = 0): AABB => box(x - 0.15, z - 0.15, x + 0.15, z + 0.15, y, y + 1.8);

test('quem cobre quem: caixas 3D decidem a ordem (mesa, meia parede, degrau, árvore, prédio)', () => {
  // quem senta atrás da mesa: a mesa vem depois (cobre as pernas)
  const desk = box(-0.72, -0.42, 0.72, 0.42, 0, 0.75);
  assert.equal(compareBoxes(agent(0, -0.6), desk), -1);
  assert.equal(compareBoxes(agent(1.15, 0.3), desk), 1, 'ocioso à direita da mesa fica na frente');
  // meia parede comprida: atrás dela em z, mesmo perto da ponta (o erro do desenho por centro)
  const wall = box(-6.3, 2.3, 1.3, 2.5, 0, 0.72);
  assert.equal(compareBoxes(agent(1.1, 1.8), wall), -1, 'atrás da parede, perto da ponta');
  assert.equal(compareBoxes(agent(1.6, 2.4), wall), 1, 'depois da ponta (à direita), na frente');
  // escada: quem sobe fica na frente dos degraus de trás e em cima do degrau onde pisa
  const st = specOf('stoa').stair!; const sb = stairBox(st); const steps = stairPath(st);
  const stepBox = (k: number) => { const run = (st.hi - st.lo) / 10; const za = st.hi - (k + 1) * run; return box(sb.x0, za, sb.x1, za + run, 0, ((k + 1) * FLOOR_H) / 10); };
  const s4 = steps[4];
  assert.equal(compareBoxes(agent(s4.p[0], s4.p[1], s4.h), stepBox(4)), 1, 'em cima do degrau');
  assert.equal(compareBoxes(agent(s4.p[0], s4.p[1], s4.h), stepBox(6)), 1, 'na frente dos degraus mais altos');
  assert.equal(compareBoxes(agent(sb.x0 - 0.4, s4.p[1]), stepBox(8)), -1, 'quem passa ao lado (à esquerda) fica atrás da escada');
  // árvore e prédio
  const tree = box(-0.25, -0.25, 0.25, 0.25, 0, 3.4);
  assert.equal(compareBoxes(agent(0, -1), tree), -1, 'atrás da árvore: a copa cobre');
  const building = box(0, 0, 16, 11, 0, 8);
  assert.equal(compareBoxes(agent(8, 12), building), 1, 'na rua da frente');
  assert.equal(compareBoxes(agent(8, -1), building), -1, 'na rua de trás');
});

test('ordenação topológica respeita as caixas mesmo quando a profundidade do centro engana', () => {
  const order: string[] = [];
  const mk = (id: string, b: AABB, rect: [number, number, number, number]): Sortable & { id: string } => ({ id, box: b, rect, draw: () => order.push(id) });
  const wall = mk('parede', box(-6.3, 2.3, 1.3, 2.5, 0, 0.72), [0, 0, 100, 100]);
  const who = mk('agente', agent(1.1, 1.8), [10, 10, 30, 60]); // centro mais "fundo" que o da parede? não: x+z = 2,9 > −0,6
  for (const it of sortItems([wall, who])) it.draw();
  assert.deepEqual(order, ['agente', 'parede']);
});

test('sorteios determinísticos e respeitando pontos ocupados', () => {
  const r1 = rng(7); const r2 = rng(7);
  for (let i = 0; i < 20; i++) assert.equal(r1(), r2());
  const acts = planFor('stoa', 0, 6).activities;
  const r = rng(3);
  const busy = new Set(acts.slice(1).map((a) => `p:${a.id}`));
  for (let i = 0; i < 10; i++) assert.equal(pickActivity(r, busy, acts, 'p:')?.id, acts[0].id);
  assert.equal(pickActivity(r, new Set(acts.map((a) => `p:${a.id}`)), acts, 'p:'), null, 'tudo ocupado: ninguém sai');
  const v = between(r, [5, 9]); assert.ok(v >= 5 && v <= 9);
});

test('escolhas: trabalho na mesa é a mais comum; a cidade é usada de verdade (piscina, corrida, disco…)', () => {
  const r = rng(11); const n: Record<string, number> = {};
  for (let i = 0; i < 8000; i++) { const c = pickChoice(r); n[c] = (n[c] ?? 0) + 1; }
  for (const k of Object.keys(LIFE_WEIGHTS) as LifeChoice[]) assert.ok((n[k] ?? 0) > 8000 * LIFE_WEIGHTS[k] * 0.6, `${k} aparece`);
  assert.ok(Object.entries(n).every(([k, v]) => k === 'desk' || v < n.desk), 'mesa domina');
  const outside = (['agora', 'termas', 'ginasio', 'teatro', 'casa'] as LifeChoice[]).reduce((s, k) => s + LIFE_WEIGHTS[k], 0);
  assert.ok(outside >= 0.3 && outside <= 0.4, `cidade ${outside}`);
  assert.ok(Math.abs(Object.values(LIFE_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'pesos somam 1');
});

test('noite: das 22h às 6h; tema automático escuro das 19h às 6h', () => {
  assert.ok(isNightHour(23) && isNightHour(2) && !isNightHour(6) && !isNightHour(14));
  assert.ok(isDarkHour(19) && isDarkHour(5) && !isDarkHour(6) && !isDarkHour(18));
  assert.equal(msUntilMorning(new Date(2026, 9, 24, 23, 0, 0)), 7 * 3600 * 1000);
  assert.equal(msUntilMorning(new Date(2026, 9, 24, 5, 30, 0)), 30 * 60 * 1000);
});

test('interações: quem entrega fica na mesma linha de quem recebe; visitante ao lado de quem trabalha; duplas lado a lado', () => {
  for (const kind of ['stoa', 'oikos', 'emporion', 'didaskaleion']) {
    const spec = specOf(kind); const plan = planFor(kind, 0, kind === 'stoa' ? 6 : 6);
    plan.desks.forEach((_, s) => {
      const home = idleSpotOf(plan, spec, s); const h = handoffSpot(plan, spec, s);
      assert.equal(project(h[0], 0, h[1])[1], project(home[0], 0, home[1])[1], `${kind} entrega ${s}: mesma linha`);
      const v = visitSpot(plan, spec, s); const seat = seatOf(plan, spec, s);
      assert.ok(Math.hypot(v[0] - seat[0], v[1] - seat[1]) < 1.2, `${kind} visita ${s}: perto da mesa`);
    });
    for (const c of plan.chats) { const [a, b] = pairAt(c); assert.equal(project(a[0], 0, a[1])[1], project(b[0], 0, b[1])[1], `${kind}: dupla na mesma linha`); }
  }
  assert.equal(STOA_DESKS.length, 6);
  const gym = areaDef('ginasio')!; const [a, b] = gym.wrestle!;
  assert.equal(project(a[0], 0, a[1])[1], project(b[0], 0, b[1])[1], 'luta: mesma linha');
});

test('banco: quem senta fica à frente da caixa do banco (nunca parece sentado de costas)', () => {
  const benches = [...planFor('stoa', 0, 6).objects.filter((o) => o.kind === 'bench'), ...(['agora', 'termas', 'ginasio'] as const).flatMap((k) => areaDef(k)!.props.filter((p) => p.kind === 'bench').map((p) => ({ x: p.x, z: p.z, hx: 0.9, hz: 0.26 })))];
  assert.ok(benches.length >= 6);
  for (const bn of benches) for (const side of [-1, 1] as const) {
    const [x, z] = benchSeat([bn.x, bn.z], side);
    assert.equal(compareBoxes(agent(x, z), box(bn.x - bn.hx, bn.z - bn.hz, bn.x + bn.hx, bn.z + bn.hz, 0, 0.48)), 1);
  }
});

test('gestos: braços erguidos (alegria, raiva) não passam do alto da cabeça; conversa, pensar, alcançar, entregar mudam o boneco', () => {
  const look = lookFor({ name: 'Caio', color: '#3f7d4e', role: 'Operações' }, ALEXANDRIA_DIA);
  const base = JSON.stringify(figureGrid(look, 'front', 'stand', 0, ALEXANDRIA_DIA, 'neutral', 'none'));
  const gestures: Gesture[] = ['talk', 'angry', 'worry', 'joy', 'think', 'reach', 'point', 'offer', 'receive'];
  for (const gst of gestures) for (const frame of [0, 1]) assert.notEqual(JSON.stringify(figureGrid(look, 'front', 'stand', frame, ALEXANDRIA_DIA, 'neutral', gst)), base, `${gst} quadro ${frame}`);
  const headTop = gridExtent(figureGrid(look, 'front', 'stand', 0, ALEXANDRIA_DIA, 'neutral', 'none')).top;
  for (const gst of ['joy', 'angry'] as Gesture[]) for (const frame of [0, 1]) {
    const g = figureGrid(look, 'front', 'stand', frame, ALEXANDRIA_DIA, 'smile', gst);
    assert.ok(gridExtent(g).top >= headTop, `${gst} ${frame}: mãos abaixo do alto da cabeça`);
    // braços curtos: a mão fica perto da cabeça, não lá fora
    const xs = g.flatMap((row, y) => (y < 20 ? row.map((c, x) => (c === look.skin[0] ? x : -1)).filter((x) => x >= 0) : []));
    assert.ok(Math.min(...xs) >= 1 && Math.max(...xs) <= 28, `${gst}: braço não estica para fora`);
  }
  const perch = figureGrid(look, 'front', 'perch', 0, ALEXANDRIA_DIA, 'smile', 'none');
  const sit = figureGrid(look, 'front', 'sit', 0, ALEXANDRIA_DIA, 'smile', 'none');
  const sandals = (g: (string | null)[][]) => g.slice(43, 48).some((row) => row.includes(ALEXANDRIA_DIA.sandal));
  assert.ok(sandals(perch) && !sandals(sit), 'banco: sandálias no chão; mesa: pernas escondidas');
});

test('temas: diurno é o padrão e todas as cores são válidas nos dois', () => {
  assert.equal(THEMES.dia, ALEXANDRIA_DIA); assert.equal(THEMES.noite, ALEXANDRIA_NOITE);
  const hex = /^#[0-9a-f]{6}$/i;
  for (const th of [ALEXANDRIA_DIA, ALEXANDRIA_NOITE]) {
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') { if (path !== 'id' && path !== 'name') assert.match(v, hex, `${th.id}.${path}`); }
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    };
    walk(th, '');
  }
});

test('personagens: iconografia por chave; Alexandre Magno jovem, de armadura e sem capacete', async () => {
  const { CHARACTER_LOOKS, npcLook } = await import('./figures.ts');
  const soc = lookFor({ name: 'Sócrates', color: '#6f6a60', key: 'socrates' }, ALEXANDRIA_DIA);
  assert.equal(soc.hairStyle, 'bald'); assert.ok(soc.beard);
  assert.equal(lookFor({ name: 'Diógenes', color: '#8a6f4a', key: 'diogenes' }, ALEXANDRIA_DIA).item, 'lamp');
  assert.ok(Object.keys(CHARACTER_LOOKS).length >= 12);
  const alex = npcLook(ALEXANDRIA_DIA);
  assert.equal(alex.outfit, 'armor'); assert.equal(alex.beard, false); assert.equal(alex.skin, ALEXANDRIA_DIA.skins[2]);
  const g = figureGrid(alex, 'front', 'stand', 0, ALEXANDRIA_DIA, 'smile', 'none');
  const head = g.slice(2, 8).flatMap((row) => row.slice(6, 22));
  assert.ok(!head.some((c) => ALEXANDRIA_DIA.bronze.includes(c as string)), 'sem capacete');
});
