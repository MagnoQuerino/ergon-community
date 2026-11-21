// O campo das Salas: a marca só se forma por nome exato ou Tab; Backspace logo depois desfaz; sem escolha, texto cru.
//   node --test src/lib/mencoes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aoEnviar, backspace, editar, escolher, esquecerRecem, pedacos, sugestoes, tokenAtivo, vazio, type Campo, type Candidato } from './mencoes.ts';

const C: Candidato[] = [
  { tipo: 'pessoa', chave: 'acc:ana', nome: 'Ana' }, { tipo: 'pessoa', chave: 'acc:anap', nome: 'Ana Paula' },
  { tipo: 'pessoa', chave: 'acc:rog', nome: 'Rogério' }, { tipo: 'agente', chave: 'Aristóteles', nome: 'Aristóteles' },
];
/** digita letra por letra, como a tela */
const digitar = (c: Campo, s: string): Campo => { let x = c; for (const ch of s) x = editar(x, x.texto + ch, x.texto.length + 1, C); return x; };

test('sugestões: @ pessoas e agentes, # só pessoas; o começo do nome antes; sem acento conta', () => {
  const t = tokenAtivo({ ...vazio(), texto: 'oi @ar' }, 6)!;
  assert.deepEqual([t.marcador, t.consulta], ['@', 'ar']);
  assert.deepEqual(sugestoes(t, C).map((x) => x.nome), ['Aristóteles', 'Ana Paula', 'Rogério'].filter((n) => n === 'Aristóteles' || n.toLowerCase().includes('ar')));
  assert.deepEqual(sugestoes(tokenAtivo({ ...vazio(), texto: '#' }, 1)!, C).map((x) => x.tipo), ['pessoa', 'pessoa', 'pessoa']);
  assert.deepEqual(sugestoes(tokenAtivo({ ...vazio(), texto: '@rog' }, 4)!, C).map((x) => x.nome), ['Rogério'], 'sem acento acha');
  assert.equal(tokenAtivo({ ...vazio(), texto: 'ana@empresa' }, 11), null, 'e-mail não é marcador');
  assert.equal(tokenAtivo({ ...vazio(), texto: 'C#' }, 2), null);
});

test('Tab (escolher o primeiro) forma a marca com o nome certo e um espaço', () => {
  const c = digitar(vazio(), '@Aris');
  const t = tokenAtivo(c, c.texto.length)!;
  const r = escolher(c, t, c.texto.length, sugestoes(t, C)[0]);
  assert.equal(r.campo.texto, '@Aristóteles ');
  assert.deepEqual(r.campo.marcas, [{ tipo: 'agente', chave: 'Aristóteles', inicio: 0, fim: 12 }]);
  assert.equal(r.cursor, 13);
  const t2 = digitar(r.campo, 'resumo #Ro');
  const tk = tokenAtivo(t2, t2.texto.length)!;
  const r2 = escolher(t2, tk, t2.texto.length, sugestoes(tk, C)[0]);
  assert.deepEqual(r2.campo.marcas.map((m) => [m.tipo, m.chave]), [['agente', 'Aristóteles'], ['cessao', 'acc:rog']]);
  assert.equal(aoEnviar(r2.campo, C).marcas.length, 2);
});

test('nome digitado exatamente igual + espaço ou pontuação forma; diferente (caixa, incompleto) fica cru', () => {
  const ok = digitar(vazio(), '@Rogério, olha');
  assert.deepEqual(ok.marcas, [{ tipo: 'pessoa', chave: 'acc:rog', inicio: 0, fim: 8 }]);
  const caixa = digitar(vazio(), '@rogério olha');
  assert.deepEqual(caixa.marcas, [], 'não é igual: texto cru');
  const meio = digitar(vazio(), '@Rog olha');
  assert.deepEqual(meio.marcas, []);
  assert.deepEqual(aoEnviar(meio, C).marcas, [], 'nada vai ao servidor como menção');
  // "Ana" com "Ana Paula" na lista: o espaço pode ser o meio do nome mais longo, então só forma com pontuação
  const ambiguo = digitar(vazio(), '@Ana ');
  assert.deepEqual(ambiguo.marcas, []);
  assert.equal(digitar(vazio(), '@Ana,').marcas[0]?.chave, 'acc:ana');
  assert.equal(digitar(vazio(), '@Ana Paula ').marcas[0]?.chave, 'acc:anap');
  // exato no fim, ao enviar, também vale
  assert.deepEqual(aoEnviar(digitar(vazio(), 'cede aí #Ana'), C).marcas, [{ tipo: 'cessao', chave: 'acc:ana', inicio: 8, fim: 12 }]);
});

test('Backspace logo depois da marca a desfaz sem apagar letra; o seguinte apaga normal', () => {
  const c = digitar(vazio(), '@Aris');
  const t = tokenAtivo(c, 5)!;
  const { campo, cursor } = escolher(c, t, 5, C[3]);
  const desfeita = backspace(campo, cursor)!;
  assert.ok(desfeita, 'desfaz');
  assert.equal(desfeita.texto, '@Aristóteles ', 'nenhuma letra some');
  assert.deepEqual(desfeita.marcas, []);
  assert.equal(backspace(desfeita, cursor), null, 'o próximo Backspace é normal');
  // formada digitando: Backspace com o cursor no fim do nome desfaz
  const d = digitar(vazio(), '@Rogério olha');
  assert.ok(backspace(d, 8));
  assert.equal(backspace(esquecerRecem(d), 13), null, 'longe da marca: normal');
});

test('mexer dentro da marca a desfaz; texto antes e depois move as posições', () => {
  const c = digitar(vazio(), '@Rogério olha');
  const dentro = editar(c, '@Rogrio olha', 4, C);
  assert.deepEqual(dentro.marcas, []);
  const antes = editar(c, 'oi @Rogério olha', 3, C);
  assert.deepEqual(antes.marcas.map((m) => [m.inicio, m.fim]), [[3, 11]]);
  const depois = editar(c, '@Rogério olha isto', 18, C);
  assert.deepEqual(depois.marcas.map((m) => [m.inicio, m.fim]), [[0, 8]]);
  // espaços nas pontas saem e as posições andam junto
  assert.deepEqual(aoEnviar({ ...antes, texto: `  ${antes.texto}`, marcas: antes.marcas.map((m) => ({ ...m, inicio: m.inicio + 2, fim: m.fim + 2 })) }, C).marcas.map((m) => m.inicio), [3]);
});

test('pedaços para mostrar: a marca vira chip; marcas estranhas são ignoradas', () => {
  const p = pedacos('@Ana veja #Rogério', [{ tipo: 'pessoa', chave: 'acc:ana', inicio: 0, fim: 4 }, { tipo: 'cessao', chave: 'acc:rog', inicio: 10, fim: 18 }, { inicio: 2, fim: 99 }, null]);
  assert.deepEqual(p.map((x) => [x.texto, x.marca?.tipo ?? null]), [['@Ana', 'pessoa'], [' veja ', null], ['#Rogério', 'cessao']]);
  assert.deepEqual(pedacos('sem nada', null), [{ texto: 'sem nada' }]);
});
