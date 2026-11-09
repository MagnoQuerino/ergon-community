import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripControl } from './types.ts';
import { DICA_NOME_PROVISORIO } from './textos-tela.ts';
import { gravarNome, nomeParaGravar } from './titulo-card.ts';

test('a linha em que a coordenação renomeia um card não aparece na conversa', () => {
  assert.equal(stripControl('Está com o Euclides. [[titulo card="12" novo="Varredura de 1 semana do Teams"]]'), 'Está com o Euclides.');
  assert.equal(stripControl('Feito. [[renomear-card numero="7" titulo="Relatório de outubro"]]'), 'Feito.');
  assert.equal(stripControl('Certo. [[titulo card=9 "Lista de fornecedores"]]'), 'Certo.', 'também sem aspas no número');
  assert.equal(stripControl('O título do relatório ficou bom.'), 'O título do relatório ficou bom.', 'texto comum fica');
});

test('a dica do nome provisório não promete prazo e diz que a pessoa pode dar outro', () => {
  assert.doesNotMatch(DICA_NOME_PROVISORIO, /assim que|logo|em breve|já já/i, 'nada dispara a coordenação só para dar o nome');
  assert.match(DICA_NOME_PROVISORIO, /pode trocar/);
  assert.match(DICA_NOME_PROVISORIO, /lápis/);
});

test('o nome do card da equipe: só fecha e diz "Salvo" quando gravou; falhou, o texto fica', async () => {
  assert.equal(nomeParaGravar('  Fornecedores   de papel ', 'Lista'), 'Fornecedores de papel');
  assert.equal(nomeParaGravar('Lista', 'Lista'), null, 'igual: só fecha');
  assert.equal(nomeParaGravar('   ', 'Lista'), null, 'vazio: só fecha');

  const corpos: unknown[] = [];
  const ok = await gravarNome(async (c) => { corpos.push(c); return { revision: 7 }; }, 'Fornecedores de papel A4', 'Lista');
  assert.deepEqual(ok, { fechar: true, salvo: true, revision: 7 });
  assert.deepEqual(corpos, [{ title: 'Fornecedores de papel A4' }], 'vai sem a revisão: a equipe mexer no card não faz a gravação falhar');

  const falha = await gravarNome(async () => { throw new Error('sem conexão'); }, 'Fornecedores de papel A4', 'Lista');
  assert.equal(falha.fechar, false, 'o campo continua aberto com o que foi digitado');
  assert.equal(falha.salvo, false, 'nada de "Salvo" quando não gravou');

  let chamou = false;
  assert.deepEqual(await gravarNome(async () => { chamou = true; return { revision: 1 }; }, 'Lista', 'Lista'), { fechar: true, salvo: false });
  assert.equal(chamou, false, 'nome igual: não grava');
});
