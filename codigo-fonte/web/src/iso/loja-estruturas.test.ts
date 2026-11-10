// A loja de estruturas no idioma da tela: o catálogo (shared/city.ts) é dado e fica em português, e a StoreDialog
// traduz o nome comum e a descrição de cada estrutura à venda pelo dicionário da área "documentos".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CATALOG } from '../../../shared/city.ts';
import pt from '../i18n/pt/documentos.ts';
import en from '../i18n/en/documentos.ts';

const PT = pt as Record<string, unknown>;
const EN = en as Record<string, unknown>;
const loja = CATALOG.filter((s) => s.store);
const codigo = fs.readFileSync(new URL('./StoreDialog.tsx', import.meta.url), 'utf8');

test('loja: toda estrutura à venda tem nome comum e descrição nos dois idiomas, e o português é o do catálogo', () => {
  assert.ok(loja.length > 0);
  for (const s of loja) {
    for (const [campo, original] of [['comum', s.common], ['descricao', s.description]] as const) {
      const k = `construir.estrutura.${s.id}.${campo}`;
      assert.equal(PT[k], original, `${k}: o português difere do catálogo`);
      assert.equal(typeof EN[k], 'string', `${k}: falta o inglês`);
      assert.notEqual(EN[k], original, `${k}: inglês igual ao português`);
    }
  }
});

test('loja: a StoreDialog lista toda estrutura à venda (um prédio novo no catálogo não fica em português)', () => {
  const lista = codigo.match(/ESTRUTURAS_TRADUZIDAS = \[([^\]]*)\]/);
  assert.ok(lista, 'a lista ESTRUTURAS_TRADUZIDAS sumiu da StoreDialog');
  const ids = [...lista[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, loja.map((s) => s.id).sort());
  assert.doesNotMatch(codigo, /\{s\.description\}|\{nm\?\.common \?\? s\.common\}/, 'o texto do catálogo voltou direto para a tela');
});
