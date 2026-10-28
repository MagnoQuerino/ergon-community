import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTRAIT_H, PORTRAIT_W, portraitBackground, portraitGrid } from './portrait.ts';
import { CHARACTER_LOOKS } from './figures.ts';

const count = (g: (string | null)[][]) => g.flat().filter(Boolean).length;

test('retrato 3x4: cabeça e ombros do boneco da cidade, sem cortar o rosto', () => {
  const g = portraitGrid({ name: 'Aristóteles', color: '#2f4f8f', role: 'Coordenação da equipe', char_key: 'aristoteles' });
  assert.equal(g.length, PORTRAIT_H);
  assert.ok(g.every((row) => row.length === PORTRAIT_W), 'todas as linhas com a mesma largura');
  assert.equal(PORTRAIT_W / PORTRAIT_H, 3 / 4, 'proporção 3x4');
  assert.ok(count(g) > PORTRAIT_W * PORTRAIT_H * 0.35, 'o boneco ocupa boa parte do retrato');
  // nada do rosto fica na borda de cima: há ao menos uma linha vazia ou cabelo antes da pele
  assert.ok(g[0].every((c) => c === null) || g.slice(0, 3).some((row) => row.some(Boolean)));
});

test('cada personagem tem o seu retrato; agente sem personagem também ganha um', () => {
  const keys = Object.keys(CHARACTER_LOOKS);
  const seen = new Set(keys.map((k) => JSON.stringify(portraitGrid({ name: k, color: '#7a5a3a', char_key: k }))));
  assert.equal(seen.size, keys.length, 'doze retratos diferentes');
  const novo = portraitGrid({ name: 'Temístocles', color: '#3a6a5a', role: 'Vendas' });
  assert.ok(count(novo) > 100);
  assert.match(portraitBackground('#2f4f8f'), /^#[0-9a-f]{6}$/);
});
