// A Ajuda em inglês ensina o que a tela em inglês tem: o comando que o servidor aceita em inglês e os rótulos
// de botão citados como eles aparecem; exemplos dos campos no uso natural ("e.g."), sem "E.g.:".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ajuda from './en/ajuda.ts';

const A = ajuda as unknown as Record<string, string>;

test('ajuda em inglês: /task no lugar de /tarefa, e o servidor aceita /task', () => {
  assert.match(A['conversar.i4Tarefa'], /^\/task\b/);
  const interpret = new URL('../../../server/src/services/interpret.ts', import.meta.url);
  if (!fs.existsSync(interpret)) return;
  const linha = fs.readFileSync(interpret, 'utf8').split('\n').find((l) => l.includes('cmdTask:')) ?? '';
  assert.ok(linha.includes('/task'), 'o servidor deixou de aceitar /task');
});

test('ajuda em inglês: rótulos citados batem com os botões e exemplos usam "e.g."', () => {
  assert.match(A['temas.p3'], /“Restore the Greek names and stories”/);
  assert.match(A['personalizar.p3'], /“Write with the Coordinator”/);
  assert.match(A['decisoes.p1'], /“\{chip\}”/);
  assert.match(A['pagina.refazerAviso'], /The names you gave/);
  for (const [chave, texto] of Object.entries(A)) {
    if (typeof texto === 'string') assert.doesNotMatch(texto, /E\.g\.:/, chave);
  }
  assert.equal(A['onb.espacoExemplo'], 'e.g. Ana’s home');
});
