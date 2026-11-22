import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escolherVoz, idiomaDaFala, perfilDoNome } from './fala.ts';

test('fala do sistema: cada agente com uma voz fixa do idioma da tela', () => {
  const vozes = [{ lang: 'en-US', name: 'Aria' }, { lang: 'pt-BR', name: 'Maria' }, { lang: 'pt-BR', name: 'Daniel' }, { lang: 'pt-PT', name: 'Helia' }];
  assert.equal(perfilDoNome('Sócrates'), perfilDoNome('Sócrates'));
  assert.notEqual(perfilDoNome('Sócrates'), perfilDoNome('Hipátia'));
  assert.equal(escolherVoz(vozes, 'pt-BR', 0)!.name, 'Daniel');
  assert.equal(escolherVoz(vozes, 'pt-BR', 1)!.name, 'Maria');
  assert.equal(escolherVoz(vozes, 'hi-IN', 0), null);
  assert.equal(escolherVoz([{ lang: 'pt_PT', name: 'X' }], 'pt-BR', 3)!.name, 'X', 'sem o idioma exato, a mesma língua');
  assert.equal(idiomaDaFala('pt'), 'pt-BR');
});
