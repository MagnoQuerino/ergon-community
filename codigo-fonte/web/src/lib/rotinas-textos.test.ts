import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import en from '../i18n/en/rotinas.ts';
import pt from '../i18n/pt/rotinas.ts';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tela = () => fs.readFileSync(path.join(raiz, 'views/RotinasView.tsx'), 'utf8');

test('Rotinas: as listas de "faltam" e do apoio continuam juntadas por vírgula (mesmo português de antes)', () => {
  const s = tela();
  assert.match(s, /const faltam = missing\.map\(\(n\) => n\.label\)\.join\(', '\);/);
  assert.match(s, /apoio: tpl\.agentNames\.slice\(1\)\.join\(', '\)/);
});

test('Rotinas: a recomendação usa "a coordenação" no meio da frase e "A coordenação" só no começo', () => {
  const s = tela();
  assert.match(s, /<RecommendCard coordName=\{coordName\} coordNameInicio=\{coord\?\.name \?\? t\('rotinas\.coordenacaoInicio'\)\} \/>/);
  assert.match(s, /t\('rotinas\.rec\.analisando', \{ nome: coordNameInicio \}\)/);
  assert.match(s, /t\('rotinas\.rec\.explica', \{ nome: coordName \}\)/);
  assert.match(s, /t\('rotinas\.rec\.consumo', \{ nome: coordName \}\)/);
  // as frases do meio começam com o nome depois de vírgula: a forma minúscula é a certa
  assert.match(pt['rec.explica'], /^Uma vez por semana, \{nome\}/);
  assert.equal(en['coordenacao'], 'the coordinator');
});

test('Rotinas em inglês: rótulos distintos e frases naturais na gaveta', () => {
  assert.notEqual(en['ficha.aoExecutar'], en['editar.quandoRoda']);
  assert.equal(en['ficha.aoExecutar'], 'When you run it');
  assert.doesNotMatch(en['preparo.antesDeLigar'], /alongside with/);
  assert.match(en['preparo.antesDeLigar'], /^\{pergunta\} /);
  assert.equal(en['arquivos.erroBusca'], "Couldn't search right now (check Connections).");
});
