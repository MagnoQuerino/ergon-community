import assert from 'node:assert/strict';
import { isValidElement, type ReactElement } from 'react';
import { test } from 'node:test';
import * as N from './nucleo.ts';
import { idiomaDoNavegador, ehIdioma } from './idiomas.ts';
import { pt } from './pt/index.ts';
import { en } from './en/index.ts';

// o idioma atual vive no navegador (localStorage) e no <html lang>: aqui, um navegador de mentira antes de carregar
const guardado = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => { guardado.set(k, v); }, removeItem: (k: string) => { guardado.delete(k); } },
  document: { documentElement: { lang: '' } },
});
const I = await import('./index.ts');
const html = () => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang;
// o Intl separa número e símbolo com espaço fixo (U+00A0, U+202F): para comparar, espaço comum
const esp = (s: string) => s.replace(/[  ]/g, ' ');

test('idioma do navegador: português se a língua começa com "pt"; inglês nos outros casos', () => {
  for (const l of ['pt-BR', 'pt', 'pt-PT', 'PT-br', ' pt-BR ']) assert.equal(idiomaDoNavegador(l), 'pt-BR', l);
  for (const l of ['en-US', 'en', 'es-ES', 'fr', 'ptx', '', undefined, null]) assert.equal(idiomaDoNavegador(l), 'en', String(l));
  assert.equal(ehIdioma('pt-BR'), true);
  assert.equal(ehIdioma('en'), true);
  for (const v of ['pt', 'es', 'EN', '', null, 1]) assert.equal(ehIdioma(v), false);
});

test('plural pelo Intl, com o 0 exato à parte e o "other" de reserva', () => {
  const p = { zero: 'nada', one: '{n} aviso', other: '{n} avisos' };
  assert.equal(N.montar('pt-BR', p, { n: 0 }), 'nada');
  assert.equal(N.montar('pt-BR', p, { n: 1 }), '1 aviso');
  assert.equal(N.montar('pt-BR', p, { n: 2 }), '2 avisos');
  assert.equal(N.montar('pt-BR', p, { n: 1250 }), '1.250 avisos', 'o número sai formatado no idioma');
  assert.equal(N.montar('en', { one: '{n} warning', other: '{n} warnings' }, { n: 1250 }), '1,250 warnings');
  assert.equal(N.montar('en', { one: '{n} warning', other: '{n} warnings' }, { n: 0 }), '0 warnings', 'sem "zero": o 0 é plural em inglês');
  // o Intl põe o 0 no singular em português (select(0) = 'one'); a tela sempre disse "0 tarefas abertas"
  assert.equal(new Intl.PluralRules('pt-BR').select(0), 'one', 'o motivo da regra');
  assert.equal(N.montar('pt-BR', { one: '{n} aviso', other: '{n} avisos' }, { n: 0 }), '0 avisos', 'sem "zero": o 0 vai para o plural');
  assert.equal(N.montar('pt-BR', { one: '{n} aviso', other: '{n} avisos' }, { n: 1 }), '1 aviso');
  // os plurais de verdade do dicionário, como no balão de workspaces de um workspace recém-criado
  assert.equal(N.montar('pt-BR', pt.geral['ws.agentes'], { n: 0 }), '0 agentes');
  assert.equal(N.montar('pt-BR', pt.geral['ws.tarefasAbertas'], { n: 0 }), '0 tarefas abertas');
  assert.equal(N.montar('pt-BR', pt.geral['ws.tarefasAbertas'], { n: 1 }), '1 tarefa aberta');
  assert.equal(N.montar('en', en.geral['ws.tarefasAbertas'], { n: 0 }), '0 open tasks');
  assert.equal(N.formaDoPlural('pt-BR', { other: 'só other' }, 1), 'só other');
  // o português tem o caso "many" (1 milhão): sem ele, vale o other
  assert.equal(N.montar('pt-BR', { one: '{n} aviso', other: '{n} avisos' }, { n: 1_000_000 }), '1.000.000 avisos');
});

test('marcadores: preenche, formata número e deixa à vista o que faltou', () => {
  assert.equal(N.interpolar('pt-BR', 'Pedir a {nome}', { nome: 'Aristóteles' }), 'Pedir a Aristóteles');
  // só o {n} (a quantidade) ganha separador; número do card, ano, porta e versão saem crus
  assert.equal(N.interpolar('pt-BR', '{n} cards', { n: 1234 }), '1.234 cards');
  assert.equal(N.interpolar('en', '{n} cards', { n: 1234 }), '1,234 cards');
  assert.equal(N.interpolar('pt-BR', '#{numero} {titulo}', { numero: 1234, titulo: 'X' }), '#1234 X');
  assert.equal(N.interpolar('en', 'Since {ano}, port {porta}', { ano: 2026, porta: 8787 }), 'Since 2026, port 8787');
  assert.equal(N.interpolar('en', '{a} and {a}', { a: 'x' }), 'x and x');
  assert.equal(N.interpolar('en', 'Hi {nome}', {}), 'Hi {nome}');
  assert.equal(N.interpolar('pt-BR', 'Hi {nome}', { nome: null }), 'Hi {nome}');
  assert.equal(N.interpolar('pt-BR', 'sem marcador'), 'sem marcador');
  assert.deepEqual(N.pedacos('Que tal {nome}? {x}!'), ['Que tal ', { marca: 'nome' }, '? ', { marca: 'x' }, '!']);
  assert.deepEqual(N.pedacos('{a}'), [{ marca: 'a' }]);
});

test('datas, horas, números e dinheiro pelo Intl do idioma (no lugar do pt-BR fixo)', () => {
  const d = new Date(2026, 10, 9, 14, 5);
  assert.equal(N.fmtData('pt-BR', d), '09/11/2026');
  assert.equal(N.fmtData('en', d), '11/9/26');
  assert.equal(N.fmtHora('pt-BR', d), '14:05');
  assert.equal(esp(N.fmtHora('en', d)), '2:05 PM');
  assert.match(esp(N.fmtDataHora('pt-BR', d)), /^09\/11\/2026,? 14:05$/);
  assert.equal(N.fmtData('pt-BR', d.getTime()), '09/11/2026', 'aceita o número de milissegundos');
  assert.equal(N.fmtData('pt-BR', d.toISOString()), '09/11/2026', 'aceita o texto ISO');
  assert.equal(N.fmtData('pt-BR', 'não é data'), '', 'nunca "Invalid Date"');
  assert.equal(N.fmtNumero('pt-BR', 1250.5), '1.250,5');
  assert.equal(N.fmtNumero('en', 1250.5), '1,250.5');
  assert.equal(esp(N.fmtCompacto('pt-BR', 1250)), '1,3 mil');
  assert.equal(N.fmtCompacto('en', 2_500_000), '2.5M');
  assert.equal(esp(N.fmtMoeda('pt-BR', 1.5, 'USD')), 'US$ 1,50');
  assert.equal(esp(N.fmtMoeda('en', 1.5, 'USD')), '$1.50');
  assert.equal(esp(N.fmtMoeda('pt-BR', 10, 'BRL')), 'R$ 10,00');
  assert.equal(N.fmtBytes('pt-BR', 1536), '1,5 KB');
  assert.equal(N.fmtBytes('en', 1536), '1.5 KB');
  assert.equal(N.fmtBytes('en', 820), '820 B');
  assert.equal(N.fmtLista('pt-BR', ['a', 'b', 'c']), 'a, b e c');
  assert.equal(N.fmtLista('en', ['a', 'b', 'c']), 'a, b, and c');
  assert.equal(N.fmtLista('pt-BR', ['a', 'b'], 'disjunction'), 'a ou b');
});

test('a moeda do World: o símbolo ₯ não se traduz; só o número segue o idioma', () => {
  assert.equal(N.fmtDracmas('pt-BR', 1250.5), '₯ 1.250,5');
  assert.equal(N.fmtDracmas('en', 1250.5), '₯ 1,250.5');
  assert.equal(N.fmtDracmas('en', 3), '₯ 3');
});

test('tempo relativo: há 5 minutos / 5 minutes ago; agora / now', () => {
  const agora = Date.UTC(2026, 10, 9, 12);
  assert.equal(N.fmtRelativo('pt-BR', agora - 5 * 60_000, agora), 'há 5 minutos');
  assert.equal(N.fmtRelativo('en', agora - 5 * 60_000, agora), '5 minutes ago');
  assert.equal(N.fmtRelativo('pt-BR', agora - 10_000, agora), 'agora');
  assert.equal(N.fmtRelativo('en', agora - 10_000, agora), 'now');
  assert.equal(N.fmtRelativo('en', agora + 2 * 86_400_000, agora), 'in 2 days');
  assert.equal(N.fmtRelativo('pt-BR', agora - 86_400_000, agora), 'ontem');
  assert.equal(N.fmtRelativo('pt-BR', 'x', agora), '');
});

test('t(): português de saída; trocar o idioma baixa o inglês, vale na hora, avisa quem ouve e muda o <html lang>', async () => {
  assert.equal(I.idiomaAtual(), 'pt-BR', 'sem escolha guardada: português');
  assert.equal(html(), 'pt-BR');
  assert.equal(I.t('geral.barra.modoFoco'), 'Modo Foco');
  assert.equal(I.t('geral.barra.pedirA', { nome: 'Aristóteles' }), 'Pedir a Aristóteles');
  assert.equal(I.t('geral.estado.avisos', { n: 1 }), '1 aviso');
  assert.equal(I.t('geral.decisoes.aguardando', { n: 0 }), 'Nada aguardando você');
  const ouvidos: string[] = [];
  const parar = I.onIdioma((l) => ouvidos.push(l));
  const troca = I.setIdioma('en');
  // o inglês ainda está chegando: a tela continua inteira em português (nunca meio a meio)
  assert.equal(I.idiomaAtual(), 'pt-BR');
  assert.equal(I.t('geral.barra.modoFoco'), 'Modo Foco');
  await troca;
  assert.equal(I.idiomaAtual(), 'en');
  assert.equal(html(), 'en');
  assert.equal(guardado.get('ergon.idioma'), 'en', 'a escolha fica neste navegador');
  assert.equal(I.t('geral.barra.modoFoco'), 'Focus Mode');
  assert.equal(I.t('geral.barra.pedirA', { nome: 'Aristóteles' }), 'Ask Aristóteles', 'o nome do personagem fica como está');
  assert.equal(I.t('geral.estado.avisos', { n: 1250 }), '1,250 warnings');
  assert.equal(I.fmtNumero(1250.5), '1,250.5', 'os formatadores seguem o idioma atual');
  assert.equal(I.fmtDracmas(10), '₯ 10');
  await I.setIdioma('en'); // o mesmo idioma: ninguém é avisado de novo
  await I.setIdioma('xx' as never); // idioma que não existe: nada muda
  assert.equal(I.idiomaAtual(), 'en');
  // já baixado: a troca é imediata, sem esperar
  void I.setIdioma('pt-BR', { guardar: false });
  assert.equal(I.idiomaAtual(), 'pt-BR');
  assert.equal(guardado.get('ergon.idioma'), 'en', 'guardar: false não muda a escolha guardada');
  parar();
  void I.setIdioma('en');
  assert.deepEqual(ouvidos, ['en', 'pt-BR'], 'quem parou de ouvir não é mais avisado');
  assert.equal(I.t('geral.naoExiste' as never), 'geral.naoExiste', 'chave desconhecida aparece como está (nunca quebra a tela)');
});

test('a ordem ao entrar: pessoa (servidor) > a escolha dela neste navegador > o navegador', () => {
  const nav = (lingua: string) => Object.defineProperty(globalThis, 'navigator', { value: { language: lingua }, configurable: true });
  guardado.clear();
  nav('pt-BR');
  assert.deepEqual(I.decidirAoEntrar('en', 'usr_a'), { idioma: 'en', lembrar: true, gravar: null }, 'a escolha da pessoa vence o navegador');
  assert.deepEqual(I.decidirAoEntrar(undefined, 'usr_a'), { idioma: 'pt-BR', lembrar: false, gravar: null }, 'sem escolha: o navegador');
  // a gravação no servidor falhou (savePrefs é silencioso): a escolha dela neste navegador vale e vai de novo ao servidor
  guardado.set('ergon.idioma:usr_a', 'en');
  assert.deepEqual(I.decidirAoEntrar(undefined, 'usr_a'), { idioma: 'en', lembrar: true, gravar: 'en' });
  // multiconta: a escolha da A neste navegador não passa para a B (que segue o navegador)
  guardado.set('ergon.idioma', 'en');
  assert.deepEqual(I.decidirAoEntrar(undefined, 'usr_b'), { idioma: 'pt-BR', lembrar: false, gravar: null });
  assert.equal(I.idiomaInicial(), 'en', 'a tela de entrada: a última escolha feita neste navegador');
  guardado.clear();
  assert.equal(I.idiomaInicial(), 'pt-BR', 'a tela de entrada sem escolha: o navegador');
  nav('en-US');
  assert.equal(I.idiomaInicial(), 'en');
  assert.deepEqual(I.decidirAoEntrar('pt-BR', 'usr_a'), { idioma: 'pt-BR', lembrar: true, gravar: null }, 'navegador em inglês, pessoa em português');
  assert.deepEqual(I.decidirAoEntrar('es', 'usr_a'), { idioma: 'en', lembrar: false, gravar: null }, 'valor estranho = sem escolha');
  nav('pt-BR');
});

test('ao entrar: a decisão vale na tela e a escolha fica nos dois lugares deste navegador', async () => {
  guardado.clear();
  // usarIdiomaDaPessoa aplica a decisão e devolve o que gravar (sem escolha em lugar nenhum: nada a gravar)
  await I.setIdioma('pt-BR', { guardar: false });
  const r = I.usarIdiomaDaPessoa(undefined, 'usr_a');
  await r.pronto;
  assert.equal(r.gravar, null);
  // escolher depois de entrar guarda nos dois lugares deste navegador: o da tela de entrada e o da pessoa
  await I.setIdioma('en');
  assert.equal(guardado.get('ergon.idioma'), 'en');
  assert.equal(guardado.get('ergon.idioma:usr_a'), 'en');
  await I.prepararIdioma();
  await I.setIdioma('pt-BR');
  guardado.clear();
});

test('pedidos de troca seguidos: vale o último', async () => {
  await I.setIdioma('pt-BR');
  const a = I.setIdioma('en'); const b = I.setIdioma('pt-BR');
  await Promise.all([a, b]);
  assert.equal(I.idiomaAtual(), 'pt-BR');
});

test('tn(): a frase com pedaços de tela nos marcadores, na ordem de cada idioma', async () => {
  await I.setIdioma('pt-BR');
  const el = I.tn('geral.barra.pedirA', { nome: 'X' }) as ReactElement<{ children: unknown[] }>;
  assert.ok(isValidElement(el));
  assert.deepEqual(el.props.children, ['Pedir a ', 'X']);
  await I.setIdioma('en');
  const plural = I.tn('geral.estado.avisos', { n: 2 }) as ReactElement<{ children: unknown[] }>;
  assert.deepEqual(plural.props.children, ['2', ' warnings']);
  await I.setIdioma('pt-BR');
});

test('ao abrir a página com o inglês escolhido neste navegador: a tela só aparece depois de o inglês chegar', async () => {
  guardado.set('ergon.idioma', 'en');
  // outra cópia do módulo, como numa página recém-aberta
  const J = await import(`./index.ts?pagina-nova=${Date.now()}`) as typeof I;
  assert.equal(J.idiomaAtual(), 'pt-BR', 'antes do dicionário chegar, nada em inglês pela metade');
  await J.prepararIdioma();
  assert.equal(J.idiomaAtual(), 'en');
  assert.equal(J.t('geral.barra.modoFoco'), 'Focus Mode');
  assert.equal(html(), 'en');
  guardado.clear();
  await I.setIdioma('pt-BR', { guardar: false });
});
