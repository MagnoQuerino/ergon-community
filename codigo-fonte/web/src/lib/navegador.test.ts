import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContaCliques, Toque, lerTecla, minutosAte, modificadores, paraViewport, rodaEmPixels } from './navegador.ts';

const tela = { largura: 1280, altura: 720 };
const tecla = (key: string, extra: Partial<Parameters<typeof lerTecla>[0]> = {}) => ({ key, code: '', keyCode: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });

test('coordenadas corrigidas pela escala: miniatura, ampliada e com faixas', () => {
  // miniatura de 320×180 (um quarto), deslocada na página
  const mini = { left: 100, top: 50, width: 320, height: 180 };
  assert.deepEqual(paraViewport(100, 50, mini, tela), { x: 0, y: 0 });
  assert.deepEqual(paraViewport(260, 140, mini, tela), { x: 640, y: 360 });
  assert.deepEqual(paraViewport(419.9, 229.9, mini, tela), { x: 1279, y: 719 });
  assert.equal(paraViewport(99, 60, mini, tela), null);
  assert.equal(paraViewport(420, 60, mini, tela), null);
  // ampliada 1,5×
  assert.deepEqual(paraViewport(960, 540, { left: 0, top: 0, width: 1920, height: 1080 }, tela), { x: 640, y: 360 });
  // caixa mais alta que a imagem (celular em pé): faixas em cima e embaixo não são a página
  const alta = { left: 0, top: 0, width: 390, height: 600 }; // imagem ocupa 390×219,4, centrada
  const faixa = (600 - 720 * (390 / 1280)) / 2;
  assert.equal(paraViewport(195, faixa - 2, alta, tela), null);
  assert.deepEqual(paraViewport(195, faixa + 720 * (390 / 1280) / 2, alta, tela), { x: 640, y: 360 });
  assert.equal(paraViewport(195, 600 - faixa + 2, alta, tela), null);
  // caixa mais larga: faixas dos lados
  const larga = { left: 10, top: 10, width: 1000, height: 360 }; // imagem 640×360, sobra 180 de cada lado
  assert.equal(paraViewport(10 + 100, 100, larga, tela), null);
  assert.deepEqual(paraViewport(10 + 180 + 320, 10 + 180, larga, tela), { x: 640, y: 360 });
  // caixa sem tamanho ou viewport desconhecido
  assert.equal(paraViewport(1, 1, { left: 0, top: 0, width: 0, height: 0 }, tela), null);
  assert.equal(paraViewport(1, 1, mini, { largura: 0, altura: 0 }), null);
});

test('teclas: caractere vai como texto; tecla com nome e atalho vão como tecla; modificador sozinho, nada', () => {
  assert.equal(lerTecla(tecla('a'), 'dn'), 'texto');
  assert.equal(lerTecla(tecla('a'), 'up'), null);
  assert.equal(lerTecla(tecla('ç'), 'dn'), 'texto');
  assert.equal(lerTecla(tecla('@', { altKey: true }), 'dn'), 'texto'); // AltGr
  assert.equal(lerTecla(tecla('Dead'), 'dn'), 'texto'); // acento esperando a letra
  assert.equal(lerTecla(tecla('a', { isComposing: true }), 'dn'), 'texto');
  assert.equal(lerTecla(tecla('Unidentified'), 'dn'), 'texto'); // teclado de celular
  assert.equal(lerTecla(tecla('v', { ctrlKey: true }), 'dn'), 'texto'); // colar
  assert.deepEqual(lerTecla(tecla('Enter', { code: 'Enter', keyCode: 13 }), 'dn'), { t: 'k', e: 'dn', key: 'Enter', code: 'Enter', vk: 13, k: 0 });
  assert.deepEqual(lerTecla(tecla('Backspace', { code: 'Backspace', keyCode: 8 }), 'up'), { t: 'k', e: 'up', key: 'Backspace', code: 'Backspace', vk: 8, k: 0 });
  assert.deepEqual(lerTecla(tecla('Tab', { code: 'Tab', keyCode: 9, shiftKey: true }), 'dn'), { t: 'k', e: 'dn', key: 'Tab', code: 'Tab', vk: 9, k: 8 });
  assert.deepEqual(lerTecla(tecla('a', { code: 'KeyA', keyCode: 65, ctrlKey: true }), 'dn'), { t: 'k', e: 'dn', key: 'a', code: 'KeyA', vk: 65, k: 2 });
  assert.deepEqual(lerTecla(tecla('Escape', { code: 'Escape', keyCode: 27 }), 'dn'), { t: 'k', e: 'dn', key: 'Escape', code: 'Escape', vk: 27, k: 0 });
  for (const m of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) assert.equal(lerTecla(tecla(m), 'dn'), null);
  assert.equal(lerTecla(tecla('Tecla Estranha'), 'dn'), null);
  assert.equal(modificadores({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), 15);
});

test('roda do mouse: pixels, linhas e páginas, com teto', () => {
  assert.deepEqual(rodaEmPixels(0, 120, 0, tela), { dx: 0, dy: 120 });
  assert.deepEqual(rodaEmPixels(0, 3, 1, tela), { dx: 0, dy: 120 });
  assert.deepEqual(rodaEmPixels(0, -1, 2, tela), { dx: 0, dy: -648 });
  assert.deepEqual(rodaEmPixels(1e6, -1e6, 0, tela), { dx: 2000, dy: -2000 });
});

test('cliques seguidos: duplo e triplo no mesmo lugar, e só', () => {
  const c = new ContaCliques();
  assert.equal(c.clique(100, 100, 1000), 1);
  assert.equal(c.clique(102, 101, 1200), 2);
  assert.equal(c.clique(101, 100, 1400), 3);
  assert.equal(c.clique(101, 100, 1500), 3);
  assert.equal(c.clique(101, 100, 3000), 1);
  assert.equal(c.clique(300, 100, 3100), 1);
});

test('toque: tocar é clicar; arrastar rola a página no sentido do dedo', () => {
  const t = new Toque();
  assert.deepEqual(t.comecar({ x: 200, y: 300 }), [{ t: 'm', e: 'mv', x: 200, y: 300 }]);
  assert.deepEqual(t.mover({ x: 203, y: 302 }), []);
  assert.deepEqual(t.soltar(), [{ t: 'm', e: 'dn', x: 200, y: 300, b: 0, c: 1 }, { t: 'm', e: 'up', x: 200, y: 300, b: 0, c: 1 }]);
  t.comecar({ x: 200, y: 300 });
  // o dedo sobe 60 px: a página rola 60 px para baixo
  assert.deepEqual(t.mover({ x: 200, y: 240 }), [{ t: 'm', e: 'wh', x: 200, y: 300, dx: 0, dy: 60 }]);
  assert.deepEqual(t.mover({ x: 200, y: 200 }), [{ t: 'm', e: 'wh', x: 200, y: 300, dx: 0, dy: 40 }]);
  assert.deepEqual(t.soltar(), []);
  assert.deepEqual(t.mover({ x: 1, y: 1 }), []);
});

test('quanto falta para o controle voltar sozinho', () => {
  const agora = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(minutosAte('2026-11-21T12:09:30Z', agora), 10);
  assert.equal(minutosAte('2026-11-21T12:00:20Z', agora), 1);
  assert.equal(minutosAte('2026-11-21T11:00:00Z', agora), 0);
  assert.equal(minutosAte(null, agora), null);
  assert.equal(minutosAte('x', agora), null);
});
