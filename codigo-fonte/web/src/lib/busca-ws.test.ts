import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSCA_WS_A_PARTIR, filtrarWorkspaces, mostraBuscaWs, moverAtivo } from './busca-ws.ts';

const ws = ['Loja da Ana', 'Padaria São João', 'ÉRGON Labs', 'Vida pessoal', 'Clínica Saúde', 'Projeto  Café'].map((name, i) => ({ id: `w${i}`, name }));
const nomes = (q: string) => filtrarWorkspaces(ws, q).map((w) => w.name);

test('busca de workspace: pelo nome, sem caixa e sem acento, na ordem da lista', () => {
  assert.deepEqual(nomes('sao'), ['Padaria São João']);
  assert.deepEqual(nomes('SÃO JOÃO'), ['Padaria São João']);
  assert.deepEqual(nomes('ergon'), ['ÉRGON Labs']);
  assert.deepEqual(nomes('clinica saude'), ['Clínica Saúde']);
  assert.deepEqual(nomes('l'), ['Loja da Ana', 'ÉRGON Labs', 'Vida pessoal', 'Clínica Saúde']);
  assert.deepEqual(nomes('projeto cafe'), ['Projeto  Café'], 'espaços repetidos contam como um');
  assert.deepEqual(nomes('xyz'), []);
});

test('busca de workspace: vazia ou só espaço devolve todos, sem mexer na lista original', () => {
  assert.equal(filtrarWorkspaces(ws, '').length, ws.length);
  assert.equal(filtrarWorkspaces(ws, '   ').length, ws.length);
  assert.notEqual(filtrarWorkspaces(ws, ''), ws);
});

test('busca de workspace: a caixa só aparece com mais de 5', () => {
  assert.equal(BUSCA_WS_A_PARTIR, 6);
  assert.equal(mostraBuscaWs(0), false);
  assert.equal(mostraBuscaWs(5), false);
  assert.equal(mostraBuscaWs(6), true);
});

test('busca de workspace: as setas dão a volta nas pontas', () => {
  assert.equal(moverAtivo(0, 3, 1), 1);
  assert.equal(moverAtivo(2, 3, 1), 0);
  assert.equal(moverAtivo(0, 3, -1), 2);
  assert.equal(moverAtivo(5, 0, 1), 0);
});

test('busca de workspace: o seletor da barra e Configurações usam a busca, com o texto traduzido', () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ler = (f: string) => fs.readFileSync(path.join(raiz, f), 'utf8');
  const barra = ler('components/Workspaces.tsx'); const conf = ler('views/ContaPanel.tsx');
  for (const src of [barra, conf]) {
    assert.match(src, /filtrarWorkspaces\(/);
    assert.match(src, /mostraBuscaWs\(/);
    assert.match(src, /placeholder=\{t\('geral\.ws\.buscar'\)\}/);
  }
  // na barra: foco ao abrir, setas e Enter escolhem, Esc limpa e depois fecha
  assert.match(barra, /autoFocus/);
  assert.match(barra, /'ArrowDown'/); assert.match(barra, /'ArrowUp'/); assert.match(barra, /'Enter'/);
  assert.match(barra, /data-esc-own/);
  assert.match(barra, /'Escape'/);
  assert.match(ler('i18n/pt/geral.ts'), /'ws\.buscar': 'Buscar workspace'/);
  assert.match(ler('i18n/en/geral.ts'), /'ws\.buscar': 'Search workspaces'/);
});
