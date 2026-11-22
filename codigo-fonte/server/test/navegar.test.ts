// Navegar a pedido (rc.49): a pessoa conduz o navegador; nenhum site ou provedor fixo nas instruções.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navegarComo } from '../src/services/runs.ts';

test('navegar: o agente abre o navegador ao vivo e segue o que a pessoa conduz, sem site fixo', () => {
  assert.match(navegarComo(['navegador']), /ao vivo/);
  assert.match(navegarComo(['navegador']), /Ela conduz/);
  assert.match(navegarComo(['computador']), /controle do computador/);
  for (const ids of [['navegador'], ['computador'], ['navegador', 'computador', 'web']]) assert.doesNotMatch(navegarComo(ids), /google|bing|search\?q=/i);
  assert.equal(navegarComo(['web']), '');
});
