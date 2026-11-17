// O cartão de um comando para aprovar (rc.33): a pessoa lê uma frase simples; o comando só aparece dentro de "Ver
// detalhes técnicos" (recolhido, letra fixa, rolagem, ~12 linhas), sem os caminhos internos. Lido no código.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pt from '../i18n/pt/geral.ts';
import en from '../i18n/en/geral.ts';

const codigo = (rel: string) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('o comando só dentro da caixa de detalhes, recolhida, sem os caminhos internos', () => {
  const c = codigo('components/CartaoAprovacao.tsx');
  assert.match(c, /\{detalhe \? <DetalhesTecnicos texto=\{detalhe\} \/> : null\}/, 'o detalhe vai só para a caixa');
  const caixa = c.slice(c.indexOf('export function DetalhesTecnicos'));
  assert.match(caixa, /<details className="aprov__detalhes">/);
  assert.doesNotMatch(caixa, /<details[^>]*\bopen\b/, 'começa recolhida');
  assert.match(caixa, /<summary>\{t\('geral\.detalhesTecnicos'\)\}<\/summary>/);
  assert.match(caixa, /<pre className="aprov__codigo" tabIndex=\{0\}>\{limparCaminhos\(texto\)\}<\/pre>/, 'letra fixa, rolável pelo teclado, com o limpador de caminhos');
  // fora da caixa, o texto do cartão é a frase e a etiqueta, nada mais
  const corpo = c.slice(c.indexOf('export function TextoDaAprovacao'), c.indexOf('export function DetalhesTecnicos'));
  assert.equal((corpo.match(/detalhe/g) ?? []).length, 4, 'detalhe só na assinatura e na caixa');
  assert.doesNotMatch(corpo, /TextoLongo|<pre/);
});

test('a caixa: letra fixa, rolagem e no máximo umas 12 linhas', () => {
  const css = codigo('styles.css');
  const regra = css.slice(css.indexOf('.aprov__codigo {'), css.indexOf('}', css.indexOf('.aprov__codigo {')));
  assert.match(regra, /max-height: calc\(12 \* 1\.45em/);
  assert.match(regra, /overflow: auto/);
  assert.match(regra, /white-space: pre/);
  assert.match(regra, /monospace/);
});

test('a conversa, "Aguardando você" e o card usam o mesmo cartão; o comando nunca no corpo', () => {
  for (const [arquivo, v] of [['components/ChatPanel.tsx', 'p'], ['components/DecisionsPanel.tsx', 'p'], ['components/TaskDetail.tsx', 'c']] as const) {
    const s = codigo(arquivo);
    assert.match(s, new RegExp(`${v}\\.kind === 'aprovacao' \\? (?:<div className="tdet__aprov">)?<TextoDaAprovacao resumo=\\{${v}\\.summary\\} risco=\\{${v}\\.risco\\} detalhe=\\{${v}\\.detalhe\\} \\/>`), arquivo);
    // o detalhe só vai para o cartão de aprovação
    assert.equal((s.match(new RegExp(`\\b${v}\\.detalhe\\b`, 'g')) ?? []).length, 1, `${arquivo}: o detalhe aparece fora do cartão`);
  }
});

test('"Ver detalhes técnicos" nas duas línguas', () => {
  assert.equal((pt as Record<string, unknown>).detalhesTecnicos, 'Ver detalhes técnicos');
  assert.equal((en as Record<string, unknown>).detalhesTecnicos, 'See technical details');
});

test('a galeria mostra o cartão como ele é: frase sem código e o comando no detalhe', () => {
  const g = codigo('galeria/simular.ts');
  for (const nome of ['APROV_CONVERSA', 'APROV_LEGENDAS', 'APROV_APAGAR']) {
    const linha = g.split('\n').find((l) => l.startsWith(`const ${nome} =`)) ?? '';
    const frase = /summary: '([^']+)'/.exec(linha)?.[1] ?? '';
    assert.ok(frase.startsWith('Hipátia quer '), nome);
    for (const pedaco of ['python', 'EOF', 'rm -rf', 'flag', 'import']) assert.ok(!frase.includes(pedaco), `${nome}: ${frase}`);
    assert.match(linha, /detalhe: /);
  }
});
