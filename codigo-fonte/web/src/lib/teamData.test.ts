import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareAgents, fold, matches, patchList, type TeamAgent } from './teamData.ts';
import { colsFor, visibleRange } from './virtual.ts';
import { Lru } from '../iso/portrait.ts';

const ag = (id: string, name: string, o: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name, role: 'Pesquisa', color: '#2f6f8f', status: 'active', demo: false, coordinator: false, char_key: null, look_seed: 1, deactivation_note: null,
  sector_key: 'producao', sector_name: 'Produção', building_id: 'bld_a', building_name: 'Stoa', floor_name: 'Térreo', run_status: null, ...o,
});

test('mesma ordem do servidor: Coordenador primeiro, nome sem acento, depois o id (nomes repetidos)', () => {
  const list = [ag('3', 'Zenão'), ag('2', 'Ésquilo'), ag('1', 'esquilo'), ag('9', 'Aristóteles', { coordinator: true }), ag('4', 'Álvaro')];
  assert.deepEqual(list.sort(compareAgents).map((a) => a.id), ['9', '4', '1', '2', '3']);
  assert.equal(fold('Hipátia ÉSQUILO'), 'hipatia esquilo');
});

test('filtro igual ao do servidor (moradores só ativos; busca sem acento no nome e no papel)', () => {
  assert.equal(matches(ag('1', 'Hipátia'), { q: 'HIPAT' }), true);
  assert.equal(matches(ag('1', 'X', { role: 'Propostas comerciais' }), { q: 'comerc' }), true);
  assert.equal(matches(ag('1', 'X', { status: 'archived' }), { structure: 'bld_a' }), false);
  assert.equal(matches(ag('1', 'X', { status: 'archived' }), { status: 'archived' }), true);
  assert.equal(matches(ag('1', 'X'), { sector: 'outro' }), false);
});

test('atualização incremental de uma lista carregada: sai, entra na posição certa ou só ajusta o total', () => {
  const s = { items: [ag('1', 'Ana'), ag('2', 'Bia'), ag('3', 'Caio')], total: 10, next: 'c' };
  const f = { sector: 'producao' };
  // mudou de setor: sai e o total cai
  assert.deepEqual(patchList(s, '2', ag('2', 'Bia', { sector_key: 'outro' }), f), { items: [s.items[0], s.items[2]], total: 9, next: 'c' });
  // chegou alguém que fica entre os carregados: entra no lugar certo
  const r = patchList(s, '7', ag('7', 'Beto'), f);
  assert.deepEqual(r.items.map((a) => a.name), ['Ana', 'Beto', 'Bia', 'Caio']); assert.equal(r.total, 11);
  // chegou alguém depois do trecho carregado (há mais páginas): só o total; aparece ao rolar
  const z = patchList(s, '8', ag('8', 'Zeca'), f);
  assert.equal(z.items.length, 3); assert.equal(z.total, 11);
  // lista completa: entra no fim
  assert.equal(patchList({ ...s, next: null }, '8', ag('8', 'Zeca'), f).items.at(-1)!.name, 'Zeca');
  // renomeado: troca de lugar sem duplicar
  const rn = patchList(s, '1', ag('1', 'Bruna'), f);
  assert.deepEqual(rn.items.map((a) => a.name), ['Bia', 'Bruna', 'Caio']); assert.equal(rn.total, 10);
  // sumiu (removido ou de outro workspace)
  assert.equal(patchList(s, '3', null, f).total, 9);
});

test('grade virtualizada: o mesmo número de elementos com 12 ou com 10.000 agentes', () => {
  const cols = colsFor(1200, 280, 12);
  assert.equal(cols, 4);
  const view = { cols, rowH: 144, top: 0, viewH: 900, overscan: 2 };
  const small = visibleRange({ ...view, count: 12 });
  const big = visibleRange({ ...view, count: 10_000 });
  assert.deepEqual(small, [0, 12]);
  assert.ok(big[1] - big[0] <= (Math.ceil(900 / 144) + 2) * cols, `${big[1] - big[0]} elementos`);
  // rolado até o meio: só a faixa da tela
  const mid = visibleRange({ ...view, count: 10_000, top: -144 * 1000 });
  assert.deepEqual(mid, [(1000 - 2) * cols, (1000 + 7 + 2) * cols]);
  assert.deepEqual(visibleRange({ ...view, count: 0 }), [0, 0]);
  assert.deepEqual(visibleRange({ ...view, count: 40, top: 5000 }), [0, 0], 'grade abaixo da tela: nada montado');
});

test('cache com descarte: guarda no máximo o limite e o mais usado fica', () => {
  const c = new Lru<number>(3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3); c.get('a'); c.set('d', 4);
  assert.equal(c.size, 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1);
  for (let i = 0; i < 1000; i++) c.set(`k${i}`, i);
  assert.equal(c.size, 3);
});
