import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acoesDaLinha, comConta, comoAdicionar, nomeNaTela, outrasContas, podeAdicionar, temVariasContas } from './contas.ts';
import type { ContaDaTela, Integration } from './types.ts';

const conta = (x: Partial<ContaDaTela>): ContaDaTela => ({ conta: '', id: 'int_1', principal: true, nome: 'ana@empresa.com', apelido: null, account: 'ana@empresa.com', state: 'connected', ativa: true, error: null, connectedAt: null, lastSyncAt: null, sharedFrom: null, live: null, renewBy: null, aviso: null, ...x });
const app = (x: Partial<Integration>): Pick<Integration, 'auth' | 'state' | 'ready' | 'contas'> => ({ auth: 'oauth', state: 'connected', ready: true, contas: [conta({})], ...x });

test('uma conta só: nada de lista, e a primeira entra pelo botão de sempre', () => {
  assert.equal(temVariasContas(app({})), false);
  assert.deepEqual(outrasContas(app({})), []);
  assert.equal(podeAdicionar(app({ state: 'off', contas: [conta({ state: 'off' })] })), false, 'sem a principal conectada, não há "outra"');
  assert.equal(podeAdicionar(app({})), true);
});

test('duas contas: a lista aparece; a que ficou desligada sem credencial não conta', () => {
  const duas = app({ contas: [conta({}), conta({ conta: 'c0123abcd', id: 'int_2', principal: false, nome: 'pessoal@gmail.com' })] });
  assert.equal(temVariasContas(duas), true);
  assert.deepEqual(outrasContas(duas).map((c) => c.conta), ['c0123abcd']);
  assert.equal(temVariasContas(app({ contas: [conta({}), conta({ conta: 'c0123abcd', principal: false, state: 'off' })] })), false);
});

test('cada aplicativo adiciona do seu jeito; "em breve" e login sem registro não oferecem', () => {
  assert.equal(comoAdicionar({ auth: 'token' }), 'credencial');
  assert.equal(comoAdicionar({ auth: 'oauth' }), 'login');
  assert.equal(comoAdicionar({ auth: 'qr' }), 'qr');
  assert.equal(comoAdicionar({ auth: 'soon' }), null);
  assert.equal(podeAdicionar(app({ auth: 'soon' })), false);
  assert.equal(podeAdicionar(app({ ready: false })), false);
  // um número novo ainda pareando: o próximo espera
  assert.equal(podeAdicionar(app({ auth: 'qr', contas: [conta({}), conta({ conta: 'c0123abcd', principal: false, state: 'pending' })] })), false);
});

test('o que cada linha oferece: a principal não desconecta pela lista, só a conectada vira principal', () => {
  const p = acoesDaLinha({ auth: 'oauth' }, conta({}));
  assert.deepEqual(p, { tornarPrincipal: false, ligarDesligar: true, desconectar: false, conectarDeNovo: false, whatsapp: false });
  const outra = acoesDaLinha({ auth: 'token' }, conta({ conta: 'c0123abcd', principal: false, state: 'error' }));
  assert.equal(outra.tornarPrincipal, false); assert.equal(outra.conectarDeNovo, true); assert.equal(outra.desconectar, true); assert.equal(outra.ligarDesligar, false);
  const numero = acoesDaLinha({ auth: 'qr' }, conta({ conta: 'c0123abcd', principal: false, state: 'pending' }));
  assert.equal(numero.whatsapp, true); assert.equal(numero.conectarDeNovo, false);
});

test('nome na tela e endereço com a conta', () => {
  assert.equal(nomeNaTela(conta({ nome: '  ' }), 'conta nova'), 'conta nova');
  assert.equal(nomeNaTela(conta({ nome: 'Trabalho' }), 'x'), 'Trabalho');
  assert.equal(comConta('/api/integrations/google/lists', ''), '/api/integrations/google/lists', 'a principal fica como sempre foi');
  assert.equal(comConta('/api/integrations/google/lists', 'c0123abcd'), '/api/integrations/google/lists?conta=c0123abcd');
  assert.equal(comConta('/api/x?a=1', 'c0123abcd'), '/api/x?a=1&conta=c0123abcd');
});

test('rotina: a escolha só aparece com mais de uma conta que as fontes leem; marcar e desmarcar por aplicativo', async () => {
  const { alternarConta, contaMarcada, gruposDaRotina } = await import('./contas.ts');
  const a = conta({ id: 'int_a' }); const b = conta({ id: 'int_b', conta: 'c0123abcd', principal: false, nome: 'pessoal@gmail.com' });
  const ints = [{ kind: 'google', name: 'Google', contas: [a, b] }, { kind: 'whatsapp', name: 'WhatsApp', contas: [conta({ id: 'int_w' })] }, { kind: 'microsoft', name: 'Microsoft 365', contas: [conta({ id: 'int_m' })] }];
  assert.deepEqual(gruposDaRotina(ints, ['tarefas.paradas']), [], 'não lê contas: sem escolha');
  assert.deepEqual(gruposDaRotina(ints, ['email.caixa']).map((g) => g.kind), ['google'], 'só o aplicativo com duas contas');
  assert.deepEqual(gruposDaRotina(ints, ['mensagens.texto']), [], 'um número só: sem escolha');
  const g = gruposDaRotina(ints, ['agenda'])[0].contas;
  assert.equal(contaMarcada([], g, 'int_a'), true); assert.equal(contaMarcada([], g, 'int_b'), true, 'sem escolha, lê todas');
  const so = alternarConta([], g, 'int_b');
  assert.deepEqual(so, ['int_a'], 'desmarcar uma deixa só a outra');
  assert.equal(contaMarcada(so, g, 'int_b'), false);
  assert.deepEqual(alternarConta(so, g, 'int_a'), ['int_a'], 'a última não sai');
  assert.deepEqual(alternarConta(so, g, 'int_b'), [], 'todas de novo: volta a ler todas');
  assert.deepEqual(alternarConta(['int_x'], g, 'int_b'), ['int_x', 'int_a'], 'a escolha de outro aplicativo fica');
});
