// Textos da área Conexões que precisam combinar entre si em inglês (em português as formas coincidem).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import conexoesEn from '../i18n/en/conexoes.ts';
import conexoesPt from '../i18n/pt/conexoes.ts';

const VIEW = new URL('../views/ConexoesView.tsx', import.meta.url);

test('Teams: a pergunta diz "Unlink" e os dois botões da conta também (não o "Turn off" das regras)', () => {
  assert.equal(conexoesEn['teams.desligar'], 'Unlink');
  assert.equal(conexoesPt['teams.desligar'], 'Desligar');
  assert.match(String(conexoesEn['teams.desligarPergunta']), /^Unlink /);
  const src = fs.readFileSync(VIEW, 'utf8');
  const inicio = src.indexOf("t('conexoes.teams.desligarPergunta')");
  assert.ok(inicio > 0);
  const trecho = src.slice(inicio, inicio + 800);
  assert.equal((trecho.match(/t\('conexoes\.teams\.desligar'\)/g) ?? []).length, 2);
  assert.doesNotMatch(trecho, /conexoes\.acao\.desligar/);
});

test('Trello e campo padrão: o nome da credencial não se confunde com "API key"', () => {
  for (const k of ['token.trelloLink', 'token.campo', 'token.campoExemplo'] as const) {
    assert.doesNotMatch(String(conexoesEn[k]), /access key|api key/i, k);
  }
  assert.match(String(conexoesEn['token.trelloLink']), /Trello token/);
});

test('preço em dólar sem espaço depois de US$ em inglês', () => {
  assert.doesNotMatch(String(conexoesEn['modelo.preco']), /US\$ /);
});
