import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PULL, atEdge, pull } from './elastic.ts';

test('elástico: puxa com resistência, nunca passa do máximo, nos dois sentidos', () => {
  let v = 0;
  const steps: number[] = [];
  for (let i = 0; i < 40; i++) { v = pull(v, -100); steps.push(v); }
  assert.ok(steps[0] < 0, 'no fim da lista, o conteúdo sobe');
  assert.ok(Math.abs(steps[1] - steps[0]) < Math.abs(steps[0]), 'cada giro puxa menos que o anterior');
  assert.ok(steps.every((s) => Math.abs(s) <= MAX_PULL));
  assert.ok(pull(0, 100) > 0, 'no começo, o conteúdo desce');
  assert.equal(pull(-MAX_PULL, -100), -MAX_PULL, 'no máximo, fica no máximo');
});

test('elástico: só no fim da área, na direção do giro', () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, scrollWidth: 300, clientHeight: 400, clientWidth: 300 };
  assert.equal(atEdge(box, 'y', -10), true, 'no topo, girando para cima');
  assert.equal(atEdge(box, 'y', 10), false, 'no topo, girando para baixo: rola normal');
  assert.equal(atEdge({ ...box, scrollTop: 599.5 }, 'y', 10), true, 'no fim (com arredondamento do navegador)');
  assert.equal(atEdge({ ...box, scrollTop: 300 }, 'y', 10), false, 'no meio');
  assert.equal(atEdge({ ...box, scrollWidth: 900, scrollLeft: 600 }, 'x', 10), true, 'de lado, no fim');
});
