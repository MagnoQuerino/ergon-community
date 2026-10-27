import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank } from './search.ts';
import { addRecent } from './recents.ts';

test('busca: todas as palavras, sem acento e sem caixa; começar igual vem primeiro', () => {
  assert.equal(rank('config', 'Configurações'), 2);
  assert.equal(rank('seguranca', 'Configurações › Segurança'), 1);
  assert.equal(rank('urac', 'Configurações'), 0);
  assert.equal(rank('fluxos equipe', 'Fluxos da equipe'), 2);
  assert.equal(rank('fluxos rotina', 'Fluxos da equipe'), -1);
  assert.equal(rank('', 'Ambiente'), -1);
});

test('recentes: o último aberto primeiro, sem repetir, no máximo 8, título curto', () => {
  let list = addRecent([], { kind: 'card', id: 'a', label: '#1 A' }, 1);
  list = addRecent(list, { kind: 'agente', id: 'b', label: 'Hipátia' }, 2);
  list = addRecent(list, { kind: 'card', id: 'a', label: '#1 A' }, 3);
  assert.deepEqual(list.map((r) => r.id), ['a', 'b']);
  for (let i = 0; i < 20; i++) list = addRecent(list, { kind: 'card', id: `c${i}`, label: 'x' }, 10 + i);
  assert.equal(list.length, 8);
  assert.equal(list[0].id, 'c19');
  assert.equal(addRecent([], { kind: 'card', id: 'z', label: 'y'.repeat(300) })[0].label.length, 120);
});
