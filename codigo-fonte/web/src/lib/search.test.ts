import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rank } from './search.ts';
import { addRecent, withoutRecent } from './recents.ts';

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

test('recentes: tirar um que não abre mais (agente de outro workspace) mantém a ordem dos outros', () => {
  let list = addRecent([], { kind: 'agente', id: 'agt_a', label: 'Hipátia' }, 1);
  list = addRecent(list, { kind: 'card', id: 'agt_a', label: '#7 mesmo id, outro tipo' }, 2);
  list = addRecent(list, { kind: 'agente', id: 'agt_b', label: 'Sócrates' }, 3);
  assert.deepEqual(withoutRecent(list, 'agente', 'agt_a').map((r) => `${r.kind}:${r.id}`), ['agente:agt_b', 'card:agt_a']);
  assert.equal(withoutRecent(list, 'agente', 'agt_z').length, 3, 'id desconhecido: nada muda');
});
