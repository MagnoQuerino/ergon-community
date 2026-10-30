import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SurfaceStack, type SurfaceEntry } from './surface-stack.ts';

const e = (id: number, o: Partial<SurfaceEntry> = {}): SurfaceEntry => ({ id, modal: false, outside: false, escape: true, ignoreFromInputs: false, ...o });

test('Escape fecha só a de cima, nunca duas (antes: o perfil sobre o Modo Foco fechava o Modo Foco)', () => {
  const s = new SurfaceStack();
  s.push(e(1, { ignoreFromInputs: true })); // Modo Foco
  s.push(e(2, { modal: true }));             // perfil do agente
  assert.equal(s.onEscape(false)?.id, 2);
  s.remove(2);
  assert.equal(s.onEscape(false)?.id, 1, 'depois, a de baixo');
  assert.equal(s.onEscape(true), null, 'Escape num campo de texto do Modo Foco é do campo');
  s.remove(1);
  assert.equal(s.onEscape(false), null, 'nada aberto: o Escape segue para a página (a cidade)');
});

test('superfície que não responde ao Escape segura o Escape (não passa para a de baixo)', () => {
  const s = new SurfaceStack();
  s.push(e(1)); s.push(e(2, { escape: false }));
  assert.equal(s.onEscape(false), null);
});

test('clique fora: só nas dispensáveis, só se começou e terminou fora, e não num gatilho', () => {
  const s = new SurfaceStack();
  s.push(e(1, { outside: true }));
  assert.equal(s.onOutsideClick(false, false, false)?.id, 1);
  assert.equal(s.onOutsideClick(true, false, false), null, 'arrastar de dentro para fora (selecionar texto) não fecha');
  assert.equal(s.onOutsideClick(false, true, false), null, 'clique dentro não fecha');
  assert.equal(s.onOutsideClick(false, false, true), null, 'o botão que abre e fecha não fecha duas vezes');
  s.push(e(2, { outside: false, modal: true }));
  assert.equal(s.onOutsideClick(false, false, false), null, 'confirmação crítica não fecha com clique fora');
});

test('painel do card: clicar noutro card, menu ou link troca na hora; área vazia fecha (antes: o 1º clique só fechava)', () => {
  const s = new SurfaceStack();
  s.push(e(1, { outside: true, passThrough: true }));
  assert.equal(s.onOutsideClick(false, false, false, true), null, 'o clicado assume: abre o outro card, vai para a área');
  assert.equal(s.onOutsideClick(false, false, false, false)?.id, 1, 'clique em área vazia fecha');
  s.push(e(2, { outside: true }));
  assert.equal(s.onOutsideClick(false, false, false, true)?.id, 2, 'gavetas comuns continuam fechando com o clique fora');
});

test('janela modal aberta em qualquer lugar da pilha: o que fica atrás (a dica) espera', () => {
  const s = new SurfaceStack();
  assert.equal(s.hasModal(), false);
  s.push(e(1, { modal: true })); s.push(e(2));
  assert.equal(s.hasModal(), true, 'um menu por cima da janela não muda nada');
  s.remove(1);
  assert.equal(s.hasModal(), false);
});

test('Tab preso só quando a de cima é modal; reabrir a mesma não duplica', () => {
  const s = new SurfaceStack();
  s.push(e(1)); assert.equal(s.trapsTab(), false);
  s.push(e(2, { modal: true })); assert.equal(s.trapsTab(), true);
  s.push(e(1)); assert.deepEqual(s.ids(), [2, 1]);
  assert.equal(s.trapsTab(), false);
});
