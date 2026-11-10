import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setIdioma } from '../i18n/index.ts';
import { NOMES_DE_FABRICA, nomeDaColuna } from './colunas.ts';

test('colunas de fábrica seguem o idioma pelo código; a renomeada pela pessoa fica', async () => {
  await setIdioma('en');
  assert.equal(nomeDaColuna({ name: 'A fazer', system_key: 'todo' }), 'To do');
  assert.equal(nomeDaColuna({ name: 'Com você', system_key: 'with_you' }), 'With you');
  assert.equal(nomeDaColuna({ name: 'Concluído', system_key: 'done' }), 'Done');
  assert.equal(nomeDaColuna({ name: 'Fazendo', system_key: 'doing' }), 'Doing');
  assert.equal(nomeDaColuna({ name: 'Minha coluna', system_key: 'doing' }), 'Minha coluna', 'renomeada pela pessoa');
  assert.equal(nomeDaColuna({ name: 'Ideias', system_key: null }), 'Ideias', 'coluna criada pela pessoa');
  await setIdioma('pt-BR');
  assert.equal(nomeDaColuna({ name: 'A fazer', system_key: 'todo' }), 'A fazer');
  assert.equal(nomeDaColuna({ name: 'To do', system_key: 'todo' }), 'A fazer');
});

test('os nomes de fábrica são os mesmos do servidor', { skip: !fs.existsSync(path.resolve(import.meta.dirname, '../../../server/src/services/colunas.ts')) }, () => {
  const srv = fs.readFileSync(path.resolve(import.meta.dirname, '../../../server/src/services/colunas.ts'), 'utf8');
  for (const nomes of Object.values(NOMES_DE_FABRICA)) for (const nome of Object.keys(nomes)) assert.ok(srv.includes(`'${nome}'`), nome);
});
