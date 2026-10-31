/**
 * Motor da cidade por região (docs/CIDADE_REGIOES.md) sem navegador: canvas e janela de mentira, nada é desenhado.
 * Ordem de entrada e casa vindas do servidor, saída adiada da lista parcial, escolhido que ainda não chegou, contagens
 * do servidor nas janelas e no selo, aviso de janela, texto da casa e o limite dos sprites dos bonecos.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LOTS } from '../../../shared/city.ts';
import type { StructureIn } from '../world/town.ts';
import type { SceneAgent, SceneCounts, SceneWindow } from '../scene/types.ts';
import { residentsOf } from '../world/regions.ts';
import { project } from './projection.ts';
import { closedRect } from './buildingArt.ts';
import { THEMES } from './theme.ts';

// ---- navegador de mentira: o motor só precisa de um canvas que aceite tudo e de quem ouça eventos
const noop = () => {};
const ctx: any = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : ctx), set: () => true, apply: () => ctx });
const canvas = (): any => ({
  width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener: noop, removeEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }), setPointerCapture: noop, releasePointerCapture: noop,
});
const g = globalThis as any;
g.document ??= { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', createElement: () => canvas() };
g.window ??= { addEventListener: noop, removeEventListener: noop, setInterval, clearInterval, setTimeout, clearTimeout, devicePixelRatio: 1 };
g.requestAnimationFrame ??= () => 1;
g.cancelAnimationFrame ??= noop;

const { IsoEngine } = await import('./engine.ts');
const { figureCacheSize, figureSprite, lookFor, reserveFigures } = await import('./figures.ts');

const st = (id: string, kind: string, i: number, j: number, floors = 2): StructureIn => ({ id, kind, name: kind, i, j, floors: Array.from({ length: floors }, (_, l) => ({ id: `${id}-f${l}`, level: l, slots: 6 })) });
const base = () => Object.entries(DEFAULT_LOTS).map(([kind, [i, j]], n) => st(`b${n}`, kind, i, j)); // b0 = a Stoa
const sa = (id: string, level: number, slot: number, house: number, o: Partial<SceneAgent> = {}): SceneAgent => ({ id, name: `Nome ${id}`, color: '#2f6f8f', role: 'Pesquisa', building: 'b0', level, slot, run: null, outcome: null, house, ...o });

function mk(structs: StructureIn[] = base()) {
  const calls = { focus: [] as unknown[], windows: [] as SceneWindow[], structures: [] as unknown[] };
  const e = new IsoEngine(canvas(), {
    onSelectAgent: noop, onObject: noop, onLot: noop, onStructure: (id) => calls.structures.push(id), onFocus: (f) => calls.focus.push(f), onMove: noop, onLost: noop,
    onWindow: (w) => calls.windows.push(w),
  });
  e.setTown(structs); e.resize(1280, 800);
  return { e, x: e as any, calls };
}
/** Câmera bem longe da cidade (ninguém na tela). */
const away = (x: any) => { x.cx = x.tcx = 1e7; x.cy = x.tcy = 1e7; };

test('cidade inteira: ordem de entrada = ordem da lista, casa vinda do servidor, quem sai da lista some na hora', () => {
  const { e, x } = mk();
  const list = [sa('a1', 0, 0, 0), sa('a2', 0, 1, 0), sa('a3', 1, 0, 7)];
  e.setAgents(list);
  assert.deepEqual([...x.rts.keys()], ['a1', 'a2', 'a3']);
  assert.deepEqual([...x.rts.values()].map((r: any) => r.house), [0, 0, 7], 'a casa é a do servidor (nada é recalculado aqui)');
  e.setAgents([list[0], { ...list[2], house: 3 }]);
  assert.deepEqual([...x.rts.keys()], ['a1', 'a3']);
  assert.equal(x.rts.get('a3').house, 3);
  assert.equal(e.debug().mode, 'cidade');
});

test('por região: quem sai da lista só vai embora parado (sem andar, sem grupo, fora da tela, não escolhido, fora do prédio aberto)', () => {
  const { e, x } = mk();
  const all = [sa('a1', 0, 0, 0), sa('a2', 0, 1, 0), sa('a3', 1, 0, 1), sa('a4', 1, 1, 1), sa('a5', 0, 2, 1)];
  e.setAgents(all, { partial: true });
  e.setAgents([all[0]], { partial: true });
  assert.equal(x.rts.size, 5, 'na tela: ninguém some');
  assert.equal(e.debug().leaving, 4);
  away(x);
  x.rts.get('a2').mover = { path: [[0, 0, 0], [1, 0, 0]], seg: 0, t: 0, pos: [0, 0, 0] }; // andando
  x.selected = 'a3';                                                                     // escolhido
  x.focus = { building: 'b0', level: 1 };                                                // a4 está no prédio aberto
  x.rts.get('a5').life.plan = { group: 'g1' };                                           // num grupo
  x.sweepLeaving();
  assert.deepEqual([...x.rts.keys()].sort(), ['a1', 'a2', 'a3', 'a4', 'a5']);
  x.rts.get('a2').mover = null; x.selected = null; x.focus = null; x.rts.get('a5').life.plan = null;
  assert.equal(x.sweepLeaving(), true);
  assert.deepEqual([...x.rts.keys()], ['a1']);
  // voltou para a lista antes de sair: fica (e deixa de estar de saída)
  e.setAgents(all.slice(0, 2), { partial: true }); e.setAgents([all[0]], { partial: true }); e.setAgents(all.slice(0, 2), { partial: true });
  assert.equal(e.debug().leaving, 0);
  // cidade inteira de novo: quem não está na lista sai na hora
  e.setAgents([all[0]], { partial: true }); e.setAgents([all[0]]);
  assert.deepEqual([...x.rts.keys()], ['a1']); assert.equal(e.debug().leaving, 0);
});

test('escolhido ainda não carregado: focusAgentAt abre o andar já; quando ele chega, centraliza (também vindo de outra tela)', () => {
  const { e, x, calls } = mk();
  e.setAgents([sa('a1', 0, 0, 0)], { partial: true });
  e.focusAgentAt('x', 'b0', 1);
  assert.deepEqual(x.focus, { building: 'b0', level: 1 });
  assert.deepEqual(calls.focus.at(-1), { building: 'b0', level: 1 });
  assert.equal(calls.structures.length, 0, 'sem abrir o cartão da construção');
  assert.equal(x.selected, 'x'); assert.equal(x.selWait, true);
  e.setSelected('x'); // o efeito da tela repete o mesmo id: nada muda
  assert.equal(x.selWait, true);
  e.setAgents([sa('a1', 0, 0, 0), sa('x', 1, 2, 3)], { partial: true });
  assert.equal(x.selWait, false);
  const rt = x.rts.get('x'); const [, py] = project(rt.pos[0], rt.pos[1] + 0.9, rt.pos[2]);
  assert.equal(x.tk, 2); assert.equal(x.tcy, py, 'a câmera vai até ele');
  // vindo de outra tela (setSelected) sem estar carregado: espera, e ao chegar abre o andar dele e centraliza
  const b = mk(); b.e.setAgents([sa('a1', 0, 0, 0)], { partial: true });
  b.e.setSelected('y'); assert.equal(b.x.selWait, true); assert.equal(b.x.focus, null);
  b.e.setAgents([sa('a1', 0, 0, 0), sa('y', 1, 0, 0)], { partial: true });
  assert.deepEqual(b.x.focus, { building: 'b0', level: 1 });
  assert.equal(b.x.selWait, false);
  // já carregado: como sempre
  const c = mk(); c.e.setAgents([sa('z', 1, 1, 0)]); c.e.focusAgentAt('z', 'b0', 1);
  assert.equal(c.x.selWait, false); assert.equal(c.x.tk, 2);
});

test('contagens do servidor: janelas e selo dos andares não carregados; os carregados usam os bonecos', () => {
  const { e, x } = mk();
  const counts: SceneCounts = { total: 40, structures: [{ id: 'b0', floors: [{ level: 0, active: 1, working: 0, waiting: 0, queued: 0 }, { level: 1, active: 6, working: 2, waiting: 0, queued: 1 }] }] };
  e.setAgents([sa('a1', 0, 0, 0)], { partial: true }); // só o térreo carregado
  e.setCounts(counts);
  let occ = x.occupancy();
  assert.deepEqual(x.floorState('b0', 1, occ), { n: 6, working: 2, waiting: 0 }, 'andar de cima pelas contagens');
  assert.equal(x.floorState('b0', 0, occ).n, 1, 'térreo pelos bonecos');
  assert.equal(x.badgeOf('b0', occ), 'working');
  e.setCounts({ ...counts, structures: [{ id: 'b0', floors: [counts.structures[0].floors[0], { ...counts.structures[0].floors[1], waiting: 1 }] }] });
  assert.equal(x.badgeOf('b0', x.occupancy()), 'waiting');
  e.setCounts({ total: 40, structures: [{ id: 'b0', floors: [{ level: 1, active: 2, working: 0, waiting: 0, queued: 1 }] }] });
  assert.equal(x.badgeOf('b0', x.occupancy()), 'attention', 'na fila');
  // mapa: a cidade inteira pelas contagens (pelo endereço)
  assert.deepEqual(x.countOcc.get('b0'), { agents: 2, working: 0, waiting: 0 });
  // cidade inteira: todos os andares com gente carregados, as contagens não mudam nada
  e.setCounts(counts);
  e.setAgents([sa('a1', 0, 0, 0), sa('a2', 1, 0, 0)]);
  occ = x.occupancy();
  assert.equal(x.floorState('b0', 1, occ).n, 1);
  assert.equal(x.floorState('b0', 1, occ).working, 0);
  assert.equal(x.badgeOf('b0', occ), null);
  assert.equal(e.debug().total, 40);
});

test('aviso de janela: construções da tela + uma tela (perto = + meia tela), da mais perto para a mais longe; no mapa, nenhuma', () => {
  const spaced = [...base()]; let k = 0;
  for (let j = 8; k < 400; j += 2) for (let i = -40; i <= 40 && k < 400; i += 2) spaced.push(st(`c${k++}`, 'oikos', i, j, 1));
  const { e, x, calls } = mk(spaced);
  x.cx = x.tcx = 0; x.cy = x.tcy = 2000; x.k = x.tk = 0.5;
  x.emitWindow();
  const w = calls.windows.at(-1)!;
  assert.ok(w.buildings.length > 0 && w.buildings.length < 400);
  for (let i = 1; i < w.buildings.length; i++) assert.ok(w.buildings[i - 1].dist <= w.buildings[i].dist);
  const cross = (r: any, v: any) => r.x1 > v.x0 && r.x0 < v.x1 && r.y1 > v.y0 && r.y0 < v.y1;
  const keep = x.viewWorld(1); const near = x.viewWorld(0.5);
  const listed = new Map(w.buildings.map((b) => [b.id, b]));
  for (const b of x.town.buildings.values()) {
    const r = closedRect(b);
    assert.equal(listed.has(b.id), cross(r, keep), b.id);
    if (listed.has(b.id)) assert.equal(listed.get(b.id)!.near, cross(r, near), b.id);
  }
  assert.ok(w.buildings.some((b) => !b.near), 'há construções só na margem (mantidas, não pedidas)');
  const n = calls.windows.length; x.emitWindow();
  assert.equal(calls.windows.length, n, 'nada mudou: nenhum aviso');
  e.focusAgentAt('ag', 'c10', 0); x.emitWindow();
  assert.deepEqual(calls.windows.at(-1)!.selected, { id: 'ag', building: 'c10', level: 0 });
  assert.deepEqual(calls.windows.at(-1)!.open, { building: 'c10', level: 0 });
  x.mapMode = true; x.emitWindow();
  assert.equal(calls.windows.at(-1)!.map, true); assert.equal(calls.windows.at(-1)!.buildings.length, 0);
});

test('texto da casa: até 6 nomes de quem está carregado e "e mais X" pelo total da cidade', () => {
  const { e, x } = mk();
  const hit = { kind: 'casa', ref: 0 } as any;
  // cidade pequena (12): dois por casa, os dois nomes, como sempre
  e.setAgents(Array.from({ length: 12 }, (_, n) => sa(`p${n}`, n % 2, Math.floor(n / 2), Math.floor(n / 2))));
  e.setCounts({ total: 12, structures: [] });
  assert.equal(x.areaText(hit), 'Casa 1 · Nome p0 no trabalho · Nome p1 no trabalho');
  assert.equal(x.areaText({ kind: 'casa', ref: 8 }), 'Casa 9 · vazia, pronta para novos agentes');
  // cidade grande: 8 carregados na casa 1 (casas lógicas 0, 9, 18, 27), 10.013 ativos
  const big = Array.from({ length: 8 }, (_, n) => sa(`g${n}`, 0, n % 6, Math.floor(n / 2) * 9));
  e.setAgents(big, { partial: true }); e.setAgents(big);
  e.setCounts({ total: 10013, structures: [] });
  const total = residentsOf(0, 9, 10013);
  assert.equal(total, 1114);
  const t = x.areaText(hit);
  assert.equal(t.split(' · ').length, 1 + 6 + 1, t);
  assert.ok(t.endsWith(`e mais ${(total - 6).toLocaleString('pt-BR')}`), t);
  // ninguém carregado nela: só o total
  e.setAgents([]);
  assert.equal(x.areaText(hit), `Casa 1 · ${total.toLocaleString('pt-BR')} moradores`);
});

test('moradores por casa só com o total (a mesma conta das casas lógicas)', () => {
  for (const N of [0, 1, 2, 12, 17, 18, 19, 100, 10013]) {
    const per = new Array(9).fill(0);
    for (let pos = 0; pos < N; pos++) per[Math.floor(pos / 2) % 9]++;
    assert.deepEqual(per.map((_, h) => residentsOf(h, 9, N)), per, String(N));
  }
});

test('sprites dos bonecos com limite: o menos usado sai (passear pela cidade grande não acumula memória)', () => {
  const th = THEMES.dia; const base = lookFor({ name: 'Ana', color: '#2f6f8f' }, th);
  const look = (i: number) => ({ ...base, hair: `#${i.toString(16).padStart(6, '0')}` });
  for (let i = 0; i < 2300; i++) figureSprite(look(i), 'front', 'stand', 0, false, th);
  assert.equal(figureCacheSize(), 2000);
  reserveFigures(2600);
  for (let i = 2300; i < 2900; i++) figureSprite(look(i), 'front', 'stand', 0, false, th);
  assert.equal(figureCacheSize(), 2600, 'muitos bonecos na tela: cabe todo mundo');
  reserveFigures(0);
  figureSprite(look(9999), 'front', 'stand', 0, false, th);
  assert.equal(figureCacheSize(), 2000, 'de volta à capacidade de base');
  // o recém-usado continua (não refaz o sprite)
  const s = figureSprite(look(2899), 'front', 'stand', 0, false, th);
  assert.equal(figureSprite(look(2899), 'front', 'stand', 0, false, th), s);
});
