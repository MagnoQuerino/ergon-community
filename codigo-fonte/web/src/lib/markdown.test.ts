import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown, plainText } from './markdown.ts';

test('negrito, itálico, código, riscado e link na mesma linha', () => {
  assert.deepEqual(parseInline('**Pronto**: veja o *rascunho*, o `card #12` e ~~o antigo~~ em [Documentos](https://exemplo.test/x).'), [
    { t: 'b', c: [{ t: 'text', v: 'Pronto' }] }, { t: 'text', v: ': veja o ' }, { t: 'i', c: [{ t: 'text', v: 'rascunho' }] }, { t: 'text', v: ', o ' },
    { t: 'code', v: 'card #12' }, { t: 'text', v: ' e ' }, { t: 's', c: [{ t: 'text', v: 'o antigo' }] }, { t: 'text', v: ' em ' },
    { t: 'a', href: 'https://exemplo.test/x', c: [{ t: 'text', v: 'Documentos' }] }, { t: 'text', v: '.' },
  ]);
});

test('sublinhado no meio da palavra não vira itálico; ** sem par fica texto (resposta chegando)', () => {
  assert.deepEqual(parseInline('nome_do_arquivo.txt'), [{ t: 'text', v: 'nome_do_arquivo.txt' }]);
  assert.deepEqual(parseInline('**pela metade'), [{ t: 'text', v: '**pela metade' }]);
});

test('link só http(s); endereço solto vira link sem levar a pontuação', () => {
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [{ t: 'text', v: '[x](javascript:alert(1))' }]);
  assert.deepEqual(parseInline('Veja https://exemplo.test/a.'), [{ t: 'text', v: 'Veja ' }, { t: 'a', href: 'https://exemplo.test/a', c: [{ t: 'text', v: 'https://exemplo.test/a' }] }, { t: 'text', v: '.' }]);
});

test('imagem guardada em Documentos', () => {
  assert.deepEqual(parseInline(`Aqui: [imagem: art_${'a'.repeat(32)}]`), [{ t: 'text', v: 'Aqui: ' }, { t: 'img', id: `art_${'a'.repeat(32)}` }]);
});

test('títulos, listas, citação, separador e parágrafo com quebra de linha', () => {
  const b = parseMarkdown('# Contrato\n\nLinha um\nlinha dois\n\n- item a\n- item **b**\n\n3. três\n4. quatro\n\n> cuidado\n\n---');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ul', 'ol', 'quote', 'hr']);
  assert.deepEqual((b[1] as { c: unknown[] }).c, [{ t: 'text', v: 'Linha um' }, { t: 'br' }, { t: 'text', v: 'linha dois' }]);
  assert.equal((b[3] as { start: number }).start, 3);
});

test('tabela com alinhamento', () => {
  const [t] = parseMarkdown('| Item | Valor |\n|:--|--:|\n| Café | R$ 10 |\n| Pão | R$ 5 |');
  assert.equal(t.t, 'table');
  if (t.t !== 'table') return;
  assert.deepEqual(t.align, ['left', 'right']);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[1][0], [{ t: 'text', v: 'Pão' }]);
});

test('bloco de código fechado e aberto (texto ainda chegando)', () => {
  assert.deepEqual(parseMarkdown('```js\nconst a = 1;\n```\nfim'), [{ t: 'code', lang: 'js', v: 'const a = 1;' }, { t: 'p', c: [{ t: 'text', v: 'fim' }] }]);
  assert.deepEqual(parseMarkdown('```\nmetade'), [{ t: 'code', lang: '', v: 'metade' }]);
});

test('HTML fica texto (nunca vira código na página)', () => {
  assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [{ t: 'p', c: [{ t: 'text', v: '<img src=x onerror=alert(1)>' }] }]);
});

test('texto puro para copiar', () => {
  assert.equal(plainText('**Oi**, tudo bem?\n\n- um\n- dois'), 'Oi, tudo bem?\n\n• um\n• dois');
});
