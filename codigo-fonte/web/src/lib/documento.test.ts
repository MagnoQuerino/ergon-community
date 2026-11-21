import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocoVisual, estiloDoPapel, presencaPorTrecho, regraDePagina, registrarBlocoVisual, trechosAoVivo, trechosMudados, type FrenteAoVivo } from './documento.ts';
import { parseInline, parseMarkdown } from './markdown.ts';
import { IDENTIDADE_PADRAO, MODELOS_ORIGINAIS, preencher, tituloDoDocumento } from '../../../shared/entregaveis.ts';

const [ERGON, ABNT] = MODELOS_ORIGINAIS;
const frente = (x: Partial<FrenteAoVivo>): FrenteAoVivo => ({
  id: 'f', acao: 'revisar', especialidade: 'texto', estado: 'trabalhando', cor: '#3366aa', blocos: [], conferidoAte: 0, aoVivo: null,
  agente: { id: 'a', name: 'Hipátia', role: '', color: '#888', char_key: null, look_seed: null }, ...x,
});

test('Markdown do documento: lista dentro de lista, títulos até ######, imagem só de Documentos, link mailto', () => {
  const [l] = parseMarkdown('- um\n  - um.a\n  - um.b\n- dois');
  assert.equal(l.t, 'ul');
  if (l.t !== 'ul') return;
  assert.equal(l.items.length, 2);
  assert.equal(l.subs?.[0]?.[0].t, 'ul', 'a sublista fica dentro do item');
  assert.deepEqual(parseMarkdown('#### Quarto').map((b) => (b.t === 'h' ? b.level : 0)), [4]);
  const id = `art_${'c'.repeat(32)}`;
  assert.deepEqual(parseInline(`![Gráfico](${id})`), [{ t: 'img', id, alt: 'Gráfico' }]);
  assert.deepEqual(parseInline('![x](https://rastreador.example/p.png)'), [{ t: 'a', href: 'https://rastreador.example/p.png', c: [{ t: 'text', v: 'x' }] }], 'imagem de fora nunca carrega: vira link');
  assert.deepEqual(parseInline('[fale](mailto:contato@example.com)'), [{ t: 'a', href: 'mailto:contato@example.com', c: [{ t: 'text', v: 'fale' }] }]);
  assert.deepEqual(parseInline('[x](data:text/html,<script>)'), [{ t: 'text', v: '[x](data:text/html,<script>)' }]);
});

test('papel e página: variáveis do modelo, @page com margens ABNT e número no alto', () => {
  const v = estiloDoPapel(ABNT, IDENTIDADE_PADRAO);
  assert.match(v['--doc-fonte'], /Times/);
  assert.equal(v['--doc-m-esq'], '3cm');
  assert.equal(v['--doc-recuo'], '1.25cm');
  const r = regraDePagina(ABNT, '');
  assert.match(r, /margin: 3cm 2cm 2cm 3cm/);
  assert.match(r, /@top-right \{ content: counter\(page\)/);
  assert.match(r, /@page :first/, 'a capa não leva número');
  assert.match(regraDePagina(ERGON, 'Acme "x"'), /@bottom-left \{ content: "Acme  x "/, 'aspas do texto não quebram a regra');
  assert.equal(preencher('{empresa} · {titulo}', { empresa: '', titulo: 'Proposta', data: '' }), 'Proposta');
  assert.equal(tituloDoDocumento('sem título', 'etapa2-arquimedes-T48-4f05ef35.md'), 'etapa2 arquimedes T48');
});

test('realce do que mudou e a equipe ao vivo', () => {
  assert.deepEqual([...trechosMudados(['a', 'b', 'c'], ['a', 'B', 'c', 'd'])], [1, 3]);
  assert.deepEqual([...trechosMudados(['a', 'b'], ['b', 'a'])], [], 'só mover não acende');
  assert.deepEqual([...trechosMudados(null, ['a'])], []);
  const f = frente({ blocos: [1, 2], aoVivo: 'novo texto' });
  const vivo = trechosAoVivo(['a', 'b', 'c', 'd'], [f, frente({ id: 'g', blocos: [3], estado: 'espera' })]);
  assert.deepEqual(vivo.map((x) => x.texto), ['a', 'novo texto', '', 'd']);
  assert.equal(vivo[1].escrevendo?.id, 'f');
  assert.deepEqual([...presencaPorTrecho([f, frente({ id: 'g', blocos: [3], estado: 'feito' })]).keys()], [1, 2], 'só quem está trabalhando aparece');
});

test('bloco visual de outro módulo: só o tipo registrado, com prefixo ergon-', () => {
  assert.equal(blocoVisual('ergon-grafico'), null);
  const C = () => null;
  registrarBlocoVisual('grafico', C);
  assert.equal(blocoVisual('ergon-grafico')?.Componente, C);
  assert.equal(blocoVisual('grafico'), null);
  assert.equal(blocoVisual('js'), null);
});
