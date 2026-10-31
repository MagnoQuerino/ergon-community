import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentOptions, coordLabel, examplesOf, holdersText, restOf } from './team.ts';

test('quem tem a ferramenta: contagem do servidor e até 3 nomes, o resto em "e mais" (nunca some calado)', () => {
  assert.equal(holdersText(undefined), 'ninguém');
  assert.equal(holdersText({ count: 0, sample: [] }), 'ninguém');
  assert.equal(holdersText({ count: 2, sample: ['Hipátia', 'Sócrates'] }), 'Hipátia, Sócrates');
  assert.equal(holdersText({ count: 3, sample: ['Aristóteles', 'Hipátia', 'Sócrates'] }), 'Aristóteles, Hipátia, Sócrates');
  assert.equal(holdersText({ count: 3_211, sample: ['Aristóteles', 'Hipátia', 'Sócrates'] }), 'Aristóteles, Hipátia, Sócrates e mais 3.208');
  // amostra maior que a contagem (corrida entre consultas): não inventa ninguém
  assert.equal(holdersText({ count: 1, sample: ['Hipátia', 'Sócrates'] }), 'Hipátia');
  assert.equal(holdersText({ count: 5, sample: [] }), '5 agentes');
});

test('exemplos da Ajuda: os colegas que o servidor manda, repetindo o primeiro se faltar', () => {
  assert.deepEqual(examplesOf([{ name: 'Hipátia' }, { name: 'Sócrates' }, { name: 'Euclides' }]), ['Hipátia', 'Sócrates', 'Euclides']);
  assert.deepEqual(examplesOf([{ name: 'Hipátia' }]), ['Hipátia', 'Hipátia', 'Hipátia']);
  assert.deepEqual(examplesOf([]), ['um agente', 'um agente', 'um agente']);
  assert.equal(coordLabel({ name: 'Gandalf' }), 'Gandalf');
  assert.equal(coordLabel(null), 'a coordenação');
});

test('filtro "Agente" do quadro: só quem tem card, sem repetir, em ordem alfabética (desativado com nome)', () => {
  const tasks = [
    { agent_id: 'agt_s', agent_name: 'Sócrates' }, { agent_id: null, agent_name: null }, { agent_id: 'agt_a', agent_name: 'Ésquilo' },
    { agent_id: 'agt_s', agent_name: 'Sócrates' }, { agent_id: 'agt_h', agent_name: 'Hipátia' }, { agent_id: 'agt_x' },
  ];
  assert.deepEqual(agentOptions(tasks), [
    { id: 'agt_x', name: 'Agente' }, { id: 'agt_a', name: 'Ésquilo' }, { id: 'agt_h', name: 'Hipátia' }, { id: 'agt_s', name: 'Sócrates' },
  ]);
  assert.deepEqual(agentOptions([]), []);
});

test('resto da equipe nas conversas: tira quem já tem conversa, na mesma ordem; com 10 mil, só filtra o que veio', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(restOf(items, new Set(['b', 'd'])).map((x) => x.id), ['a', 'c']);
  assert.equal(restOf(items, new Set()), items, 'sem conversas: a mesma lista');
  const big = Array.from({ length: 48 }, (_, i) => ({ id: `agt_${i}` }));
  assert.equal(restOf(big, new Set(big.map((x) => x.id))).length, 0, 'página inteira já nas conversas: a próxima vem ao rolar');
});
