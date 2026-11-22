// Navegar a pedido (rc.49): com o navegador ou o computador, o agente abre e pesquisa na hora; sem eles, pesquisa na web.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navegarComo } from '../src/services/runs.ts';

test('navegar: o agente sabe abrir o Google com o navegador, o computador ou a pesquisa na web', () => {
  assert.match(navegarComo(['navegador', 'web']), /google\.com\/search\?q=/);
  assert.match(navegarComo(['navegador']), /ao vivo/);
  assert.match(navegarComo(['computador']), /controle do computador/);
  assert.match(navegarComo(['web']), /web_search/);
  assert.equal(navegarComo([]), '');
});
