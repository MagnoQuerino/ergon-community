// Escrita no Asaas, na Omie e no RD Station CRM (sem rede, credenciais de mentira): o conjunto pequeno de ações que uma pequena
// empresa usa, cada uma com o risco certo, o corpo exato que a documentação pede, a credencial no lugar certo, os erros em
// português, e nada que mova dinheiro (pagar, transferir, estornar, cancelar, dar baixa). E o atalho "Só leitura" de Conexões.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { ASAAS } from '../src/services/conexoes/conectores/asaas.ts';
import { OMIE, diaNoFuso } from '../src/services/conexoes/conectores/omie.ts';
import { RDSTATION } from '../src/services/conexoes/conectores/rdstation.ts';
import { acaoDe, httpDoConector, type ConectorDef, type Credenciais } from '../src/services/conexoes/conectores/declarativo.ts';
import { soLeituraDe } from '../src/services/conexoes/catalogo.ts';
import { decidir } from '../src/services/conexoes/regra.ts';
import { ErroAcao, type CtxAcao, type Http } from '../src/services/conexoes/tipos.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
afterEach(() => { calls.length = 0; answer = () => ({}); });

const contexto = (def: ConectorDef, creds: Credenciais): CtxAcao => ({ workspaceId: 'ws', tz: 'UTC', http: httpDoConector(def, creds), creds });
const acaoEm = (def: ConectorDef) => (id: string) => { const d = def.acoes.find((a) => a.id === id); assert.ok(d, id); return acaoDe(d); };
const erro = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status });
const riscoDe = (def: ConectorDef, id: string, a: Record<string, unknown> = {}) => { const r = def.acoes.find((x) => x.id === id)!.risco; return typeof r === 'function' ? r(a) : r; };
const espiaKind = (ctx: CtxAcao) => { const kinds: unknown[] = []; const http: Http = (u, init) => { kinds.push(init?.kind); return ctx.http(u, init); }; return { ctx: { ...ctx, http }, kinds }; };

/** O que nunca pode existir num conector financeiro: mover dinheiro, desfazer cobrança, apagar. */
const MOVE_DINHEIRO = /transfer|refund|estorn|reembols|anticipat|antecip|pay(?:ment)?s?\/[^/]+\/(?:receive|refund|cancel)|receiveInCash|bill|pagar_conta|lancar|baixa|liquid|cancel|exclu|delet|remov|split|withdraw|saque|pix\/(?:transactions|qrCodes\/pay)/i;

// ---------------------------------------------------------------------------------------------------------- Asaas
describe('Asaas: escrita', () => {
  const chave = '$aact_prod_chave-de-mentira-para-teste';
  const ctx = contexto(ASAAS, { access_token: chave });
  const acao = acaoEm(ASAAS);

  test('o conjunto: cadastrar cliente e criar link só organizam; criar cobrança é envio (o Asaas avisa o cliente)', () => {
    const escrita = ASAAS.acoes.filter((a) => a.risco !== 'ler');
    assert.deepEqual(escrita.map((a) => [a.id, a.risco, a.metodo]), [['asaas.criar_cliente', 'organizar', 'POST'], ['asaas.criar_cobranca', 'enviar', 'POST'], ['asaas.criar_link', 'organizar', 'POST']]);
  });
  test('nada move dinheiro: nenhum DELETE, nenhum caminho de pagar, estornar, transferir ou cancelar, e nenhum split no corpo', () => {
    for (const d of ASAAS.acoes) {
      assert.notEqual(d.metodo, 'DELETE', d.id); assert.notEqual(d.risco, 'apagar', d.id);
      assert.doesNotMatch(`${d.id} ${d.caminho}`, MOVE_DINHEIRO, d.id);
      assert.ok(['/payments', '/payments/{id}', '/customers', '/customers/{id}', '/finance/balance', '/paymentLinks'].includes(d.caminho), `${d.id}: ${d.caminho}`);
      if (d.corpo && typeof d.corpo === 'object') assert.doesNotMatch(JSON.stringify(d.corpo), /split|callback|walletId|interest|fine|creditCard/i, d.id);
    }
  });

  test('cadastrar cliente: POST /customers com os nomes do Asaas, CPF só com números, kind write, e o id na resposta', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [] } : { object: 'customer', id: 'cus_000005219613', name: 'Ana Souza', cpfCnpj: '12345678909' });
    const { ctx: c, kinds } = espiaKind(ctx);
    const r = await acao('asaas.criar_cliente').run(c, { nome: 'Ana Souza', cpf_cnpj: '123.456.789-09', email: 'ana@exemplo.com', celular: '31999990000', referencia: 'cli-7' });
    // antes, a conferência de que o cliente ainda não existe (uma repetição não cadastra duas vezes)
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.pathname, '/v3/customers'); assert.equal(calls[0].url.searchParams.get('cpfCnpj'), '12345678909');
    assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].url.href, 'https://api.asaas.com/v3/customers');
    assert.equal(calls[1].headers.access_token, chave); assert.equal(calls[1].headers['User-Agent'], 'Ergon/1.0.0');
    assert.deepEqual(calls[1].body, { name: 'Ana Souza', cpfCnpj: '12345678909', email: 'ana@exemplo.com', mobilePhone: '31999990000', externalReference: 'cli-7' });
    assert.deepEqual(kinds, ['read', 'write'], 'escrita não repete às cegas');
    assert.equal(r.texto, 'Cliente cadastrado no Asaas (id: cus_000005219613).');
    assert.ok(!r.texto.includes('12345678909'), 'o CPF não volta no texto');
  });
  test('cadastrar cliente: CPF ou CNPJ com tamanho errado não vai ao Asaas', async () => {
    await assert.rejects(() => acao('asaas.criar_cliente').run(ctx, { nome: 'Ana', cpf_cnpj: '1234' }), (e: unknown) => e instanceof ErroAcao && /11 números \(CPF\) ou 14 \(CNPJ\)/.test(e.message));
    assert.equal(calls.length, 0);
  });

  test('criar cobrança: POST /payments com cliente, forma, valor e vencimento; a fatura vira o endereço do recibo', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [] } : { object: 'payment', id: 'pay_080225913252', customer: 'cus_1', value: 129.9, status: 'PENDING', billingType: 'PIX', invoiceUrl: 'https://www.asaas.com/i/080225913252' });
    const { ctx: c, kinds } = espiaKind(ctx);
    const r = await acao('asaas.criar_cobranca').run(c, { cliente: 'cus_1', valor: '129.9', vencimento: '2026-11-30', forma: 'PIX', descricao: 'Mensalidade de novembro' });
    assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].url.href, 'https://api.asaas.com/v3/payments');
    const { externalReference: ref, ...corpo } = calls[1].body;
    assert.deepEqual(corpo, { customer: 'cus_1', billingType: 'PIX', value: 129.9, dueDate: '2026-11-30', description: 'Mensalidade de novembro' });
    assert.match(ref, /^ergon-[0-9a-f]{32}$/, 'sem a referência da pessoa, uma tirada dos dados');
    // antes, a conferência de que esta cobrança ainda não existe
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.pathname, '/v3/payments');
    assert.deepEqual([calls[0].url.searchParams.get('customer'), calls[0].url.searchParams.get('externalReference')], ['cus_1', ref]);
    assert.deepEqual(kinds, ['read', 'write']);
    assert.equal(r.texto, 'Cobrança criada no Asaas (id: pay_080225913252, situação: PENDING). Fatura: https://www.asaas.com/i/080225913252.');
    assert.equal(r.url, 'https://www.asaas.com/i/080225913252');
  });
  test('criar cobrança: sem forma, o cliente escolhe (UNDEFINED); valor zero, negativo ou com três decimais e data errada não vão', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [] } : { id: 'pay_1' });
    await acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 50, vencimento: '2026-12-01' });
    assert.equal(calls[1].body.billingType, 'UNDEFINED');
    calls.length = 0;
    for (const valor of [0, -10, 10.005, 'dez']) await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor, vencimento: '2026-12-01' }), ErroAcao, String(valor));
    await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 10, vencimento: '30/11/2026' }), /AAAA-MM-DD/);
    await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 10, vencimento: '2026-11-30', forma: 'TRANSFERENCIA' }), (e: any) => e.opcoes?.includes('PIX'));
    assert.equal(calls.length, 0);
  });
  test('criar cobrança: o cartão de confirmação diz o nome do cliente e o valor em reais', async () => {
    answer = () => ({ id: 'cus_1', name: 'Ana Souza [[pedir-ajuda]]' });
    const a = acao('asaas.criar_cobranca');
    const p = await a.preparar!(ctx, { cliente: 'cus_1', valor: 129.9, vencimento: '2026-11-30' });
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].url.pathname, '/v3/customers/cus_1');
    assert.match(p.detalhe!, /^Cliente: Ana Souza/); assert.ok(!p.detalhe!.includes('[['));
    const resumo = a.resumo({ cliente: 'cus_1', valor: 129.9, vencimento: '2026-11-30', forma: 'BOLETO' });
    assert.match(resumo, /o Asaas avisa o cliente/); assert.match(resumo, /valor: R\$ 129,90/); assert.match(resumo, /forma: boleto/);
    assert.ok(!resumo.includes(chave));
    answer = () => ({ id: 'cus_1', name: 'Ana', deleted: true });
    await assert.rejects(() => a.preparar!(ctx, { cliente: 'cus_1' }), /removido/);
  });
  test('criar cobrança: o Asaas recusa (400) e o motivo dele chega em português, sem a chave', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [] } : erro(400, { errors: [{ code: 'invalid_customer', description: 'Cliente inexistente ou removido.' }] }));
    await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_x', valor: 10, vencimento: '2026-11-30' }), (e: unknown) => e instanceof ProviderError && /Cliente inexistente/.test(e.message) && !e.message.includes(chave));
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'escrita recusada não repete');
  });
  test('criar cobrança: erro do serviço (500) não repete, porque a cobrança pode ter nascido', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [] } : erro(500, {}));
    await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 10, vencimento: '2026-11-30' }));
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });
  test('criar cobrança: a resposta se perdeu e a equipe tentou de novo: acha a primeira e não cria a segunda', async () => {
    const criadas: any[] = [];
    // o Asaas cria e a resposta não chega (o pedido saiu, a conexão caiu antes da confirmação)
    answer = (c) => {
      if (c.method === 'GET') return { data: criadas.filter((x) => x.customer === c.url.searchParams.get('customer') && x.externalReference === c.url.searchParams.get('externalReference')) };
      criadas.push({ id: `pay_${criadas.length + 1}`, status: 'PENDING', customer: c.body.customer, externalReference: c.body.externalReference, invoiceUrl: 'https://www.asaas.com/i/1' });
      throw new TypeError('fetch failed');
    };
    const pedido = { cliente: 'cus_123', valor: 500, vencimento: '2026-12-10', descricao: 'Projeto' };
    await assert.rejects(() => acao('asaas.criar_cobranca').run(ctx, pedido), /não confirmou \(pode ter feito ou não\)/);
    const r = await acao('asaas.criar_cobranca').run(ctx, { ...pedido, valor: '500.00' });
    assert.equal(criadas.length, 1, 'uma cobrança só: o cliente não é avisado duas vezes');
    assert.match(r.texto, /já existia no Asaas, com os mesmos dados \(id: pay_1, situação: PENDING\): não criei outra/);
    assert.equal(r.url, 'https://www.asaas.com/i/1');
    // outra cobrança de verdade (outro vencimento) leva outra referência e é criada
    answer = (c) => (c.method === 'GET' ? { data: [] } : { id: 'pay_2' });
    calls.length = 0;
    await acao('asaas.criar_cobranca').run(ctx, { ...pedido, vencimento: '2027-01-10' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });
  test('criar cobrança: a referência da pessoa vale, e uma igual de propósito pede outra referência', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [{ id: 'pay_9', status: 'PENDING' }] } : { id: 'pay_x' });
    const r = await acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 10, vencimento: '2026-11-30', referencia: 'pedido-42' });
    assert.equal(calls[0].url.searchParams.get('externalReference'), 'pedido-42');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(r.texto, /informe uma "referencia" diferente/);
    // removida no Asaas não conta como existente
    answer = (c) => (c.method === 'GET' ? { data: [{ id: 'pay_9', deleted: true }] } : { id: 'pay_x' });
    calls.length = 0;
    await acao('asaas.criar_cobranca').run(ctx, { cliente: 'cus_1', valor: 10, vencimento: '2026-11-30', referencia: 'pedido-42' });
    assert.equal(calls[1].body.externalReference, 'pedido-42');
  });
  test('cadastrar cliente: o CPF já cadastrado devolve o cliente que existe, sem cadastrar outro', async () => {
    answer = (c) => (c.method === 'GET' ? { data: [{ id: 'cus_7', name: 'Ana Souza' }] } : { id: 'cus_novo' });
    const r = await acao('asaas.criar_cliente').run(ctx, { nome: 'Ana Souza', cpf_cnpj: '123.456.789-09' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(r.texto, 'Este cliente já estava cadastrado no Asaas com este CPF ou CNPJ (id: cus_7): não cadastrei outro.');
  });
  test('criar link: número acima do teto é recusado antes do cartão, em vez de ir cortado (o cartão mostra o que vai)', async () => {
    const a = acao('asaas.criar_link');
    for (const [k, v] of [['parcelas_max', 24], ['dias_boleto', 400]] as const) {
      const pedido = { nome: 'Curso', valor: 600, forma: 'CREDIT_CARD', tipo: 'parcelado', parcelas_max: 6, [k]: v };
      await assert.rejects(() => a.preparar!(ctx, pedido), (e: unknown) => e instanceof ErroAcao && new RegExp(`"${k}" vai até`).test(e.message), k);
      await assert.rejects(() => a.run(ctx, pedido), ErroAcao, `${k}: na execução também (clique da própria pessoa)`);
    }
    assert.equal(calls.length, 0);
    // no teto, vai
    answer = () => ({ id: '1', url: 'https://www.asaas.com/c/1' });
    await a.run(ctx, { nome: 'Curso', valor: 600, forma: 'CREDIT_CARD', tipo: 'parcelado', parcelas_max: 21 });
    assert.equal(calls[0].body.maxInstallmentCount, 21);
    // na leitura, pedir mais que o teto só traz o teto
    calls.length = 0; answer = () => ({ data: [], hasMore: false });
    await acao('asaas.cobrancas').run(ctx, { limite: 500 });
    assert.equal(calls[0].url.searchParams.get('limit'), '100');
  });

  test('criar link: avulso por padrão, com os nomes do Asaas, e o endereço do link no resultado', async () => {
    answer = () => ({ id: '725104409743', name: 'Consulta', url: 'https://www.asaas.com/c/725104409743' });
    const r = await acao('asaas.criar_link').run(ctx, { nome: 'Consulta', valor: 200, forma: 'PIX', fim: '2026-12-31' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.href, 'https://api.asaas.com/v3/paymentLinks');
    assert.deepEqual(calls[0].body, { name: 'Consulta', billingType: 'PIX', chargeType: 'DETACHED', value: 200, dueDateLimitDays: 10, endDate: '2026-12-31' });
    assert.equal(r.texto, 'Link de pagamento criado no Asaas: https://www.asaas.com/c/725104409743 (id: 725104409743).');
    assert.equal(r.url, 'https://www.asaas.com/c/725104409743');
  });
  test('criar link: sem valor, quem paga escolhe; parcelado pede o número de parcelas e o cartão', async () => {
    answer = () => ({ id: '1', url: 'https://www.asaas.com/c/1' });
    await acao('asaas.criar_link').run(ctx, { nome: 'Doação' });
    assert.equal('value' in calls[0].body, false);
    await acao('asaas.criar_link').run(ctx, { nome: 'Curso', valor: 600, forma: 'CREDIT_CARD', tipo: 'parcelado', parcelas_max: 6 });
    assert.deepEqual([calls[1].body.chargeType, calls[1].body.maxInstallmentCount], ['INSTALLMENT', 6]);
    calls.length = 0;
    await assert.rejects(() => acao('asaas.criar_link').run(ctx, { nome: 'Curso', forma: 'CREDIT_CARD', tipo: 'parcelado' }), /parcelas_max/);
    await assert.rejects(() => acao('asaas.criar_link').run(ctx, { nome: 'Curso', forma: 'PIX', tipo: 'parcelado', parcelas_max: 3 }), /cartão de crédito/);
    assert.equal(calls.length, 0);
  });
  test('a chave de testes cria no ambiente de testes do Asaas', async () => {
    answer = () => ({ id: 'cus_1' });
    await acao('asaas.criar_cliente').run(contexto(ASAAS, { access_token: '$aact_hmlg_abc' }), { nome: 'Ana', cpf_cnpj: '12345678909' });
    assert.equal(calls[0].url.host, 'api-sandbox.asaas.com');
  });
});

// ----------------------------------------------------------------------------------------------------------- Omie
describe('Omie: escrita', () => {
  const app_key = '9999999999';
  const app_secret = 'a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5a1b2c3d4e5';
  const creds = { app_key, app_secret };
  const ctx = contexto(OMIE, creds);
  const acao = acaoEm(OMIE);

  test('o conjunto: só inclusões, que organizam; todas as chamadas são Listar, Pesquisar, Consultar ou Incluir', async () => {
    assert.deepEqual(OMIE.acoes.filter((a) => a.risco !== 'ler').map((a) => [a.id, a.risco]), [['omie.incluir_cliente', 'organizar'], ['omie.incluir_conta_receber', 'organizar']]);
    for (const d of OMIE.acoes) {
      assert.equal(d.semRepetir, true, `${d.id}: a Omie bloqueia depois de poucos pedidos errados`);
      assert.doesNotMatch(d.id, MOVE_DINHEIRO, d.id);
      const corpo = (d.corpo as (a: Record<string, unknown>, c: Credenciais) => any)({ id: 1, cliente: 1, valor: 1, vencimento: '01/12/2026', previsao: '01/12/2026', categoria: '1.01.01', conta_corrente: 1, razao_social: 'X', limite: 1 }, creds);
      assert.match(corpo.call, /^(Listar|Pesquisar|Consultar|Incluir)/, d.id);
      assert.doesNotMatch(corpo.call, /Lancar|Baixa|Cancelar|Excluir|Estornar|Liquidar|Alterar|Recebimento|Pagamento/, d.id);
    }
  });

  test('incluir cliente: IncluirCliente em /geral/clientes/, com o código de integração e só o que veio', async () => {
    answer = () => ({ codigo_cliente_omie: 2485780, codigo_cliente_integracao: 'x', codigo_status: '0', descricao_status: 'Cliente cadastrado com sucesso!' });
    const r = await acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana Souza ME', nome_fantasia: 'Loja da Ana', cpf_cnpj: '12.345.678/0001-99', email: 'ana@exemplo.com', ddd: '31', telefone: '99999-0000', cidade: 'Betim', estado: 'mg' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.href, 'https://app.omie.com.br/api/v1/geral/clientes/');
    const { call, app_key: k, app_secret: s, param } = calls[0].body;
    assert.deepEqual([call, k, s, param.length], ['IncluirCliente', app_key, app_secret, 1]);
    const { codigo_cliente_integracao: cod, ...resto } = param[0];
    assert.match(cod, /^ergon-cli-[0-9a-f]{32}$/); assert.ok(cod.length <= 60, 'a Omie aceita até 60');
    assert.deepEqual(resto, { razao_social: 'Ana Souza ME', nome_fantasia: 'Loja da Ana', cnpj_cpf: '12345678000199', email: 'ana@exemplo.com', telefone1_ddd: '31', telefone1_numero: '99999-0000', cidade: 'Betim', estado: 'MG' });
    assert.equal(r.texto, 'O cliente incluído na Omie (id: 2485780).');
    for (const x of [app_key, app_secret]) assert.ok(!r.texto.includes(x) && !acao('omie.incluir_cliente').resumo({ razao_social: 'X', ...creds }).includes(x));
  });
  test('conta a receber idêntica no mesmo dia fica liberada (decisão de 09/11): cada inclusão leva um código novo', async () => {
    answer = () => ({ codigo_lancamento_omie: 1, codigo_status: '0' });
    const conta = { cliente: 1, valor: 50, vencimento: '10/12/2026', categoria: '1.01.02', conta_corrente: 1 };
    await acao('omie.incluir_conta_receber').run(ctx, conta);
    await acao('omie.incluir_conta_receber').run(ctx, { ...conta });
    const cods = calls.map((c) => c.body.param[0].codigo_lancamento_integracao);
    assert.equal(cods.length, 2);
    for (const c of cods) assert.match(c, /^ergon-cr-[0-9a-f]{32}$/);
    assert.notEqual(cods[0], cods[1], 'a Omie não recusa a segunda');
  });
  test('cliente: o mesmo cadastro no mesmo dia leva o mesmo código (a Omie recusa a cópia); dados diferentes, outro código', async () => {
    answer = () => ({ codigo_cliente_omie: 1, codigo_status: '0' });
    await acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana' });
    await acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana' });
    await acao('omie.incluir_cliente').run(ctx, { razao_social: 'Beto' });
    const cods = calls.map((c) => c.body.param[0].codigo_cliente_integracao);
    assert.equal(cods[0], cods[1]); assert.notEqual(cods[0], cods[2]);
  });
  test('incluir cliente: estado e documento conferidos antes de ir à Omie', async () => {
    await assert.rejects(() => acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana', estado: 'Minas' }), /sigla/);
    await assert.rejects(() => acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana', cpf_cnpj: '123' }), /CPF/);
    assert.equal(calls.length, 0);
  });
  test('a Omie respondeu 200 sem incluir (codigo_status diferente de 0): é erro, com o motivo dela', async () => {
    answer = () => ({ codigo_cliente_omie: 0, codigo_status: '102', descricao_status: 'O campo razao_social é obrigatório' });
    await assert.rejects(() => acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana' }), (e: unknown) => e instanceof ErroAcao && /não incluiu o cliente: O campo razao_social/.test(e.message));
  });
  test('código de integração repetido (com 200 ou com faultstring): o agente lê que já foi incluído e o que fazer, e nada repete', async () => {
    const ctxCr = contexto(OMIE, creds);
    const conta = { cliente: 1, valor: 50, vencimento: '10/12/2026', categoria: '1.01.02', conta_corrente: 1 };
    for (const resposta of [
      () => ({ codigo_cliente_omie: 0, codigo_status: '101', descricao_status: 'Cliente já cadastrado para o Código de Integração' }),
      () => erro(500, { faultstring: 'ERROR: Cliente já cadastrado para o Código de Integração [ergon-cli-x] !', faultcode: 'SOAP-ENV:Client-102' }),
    ]) {
      answer = resposta; calls.length = 0;
      await assert.rejects(() => acao('omie.incluir_cliente').run(ctx, { razao_social: 'Ana' }), (e: unknown) => e instanceof ErroAcao && /já foi incluído antes na Omie.*procure o id dele em omie\.clientes/.test(e.message));
      assert.equal(calls.length, 1, 'não repete');
    }
    answer = () => erro(500, { faultstring: 'ERROR: Lançamento já cadastrado para o Código de Integração [ergon-cr-x] !', faultcode: 'SOAP-ENV:Client-102' });
    await assert.rejects(() => acao('omie.incluir_conta_receber').run(ctxCr, conta), (e: unknown) => e instanceof ErroAcao && /já foi incluída antes.*confira em omie.contas_receber/.test(e.message));
    // outro erro da Omie segue como veio
    answer = () => erro(500, { faultstring: 'ERROR: Categoria [9.99] não cadastrada !', faultcode: 'SOAP-ENV:Client-5' });
    await assert.rejects(() => acao('omie.incluir_conta_receber').run(ctxCr, conta), (e: unknown) => e instanceof ProviderError && /Categoria/.test(e.message));
  });
  test('o código de integração usa o dia do workspace: 20h59 e 21h01 em Brasília são o mesmo dia (em UTC, não seriam)', async () => {
    assert.equal(diaNoFuso('America/Sao_Paulo', new Date('2026-11-08T23:59:00Z')), '2026-11-08');
    assert.equal(diaNoFuso('America/Sao_Paulo', new Date('2026-11-09T00:01:00Z')), '2026-11-08');
    assert.equal(diaNoFuso('fuso/que-nao-existe', new Date('2026-11-09T00:01:00Z')), '2026-11-09', 'fuso inválido: o dia em UTC, sem quebrar');
    // o mesmo instante em dois fusos 25 horas distantes cai sempre em dias diferentes: o código muda, então o fuso conta
    answer = () => ({ codigo_cliente_omie: 1, codigo_status: '0' });
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) await acao('omie.incluir_cliente').run({ ...contexto(OMIE, creds), tz }, { razao_social: 'Ana' });
    const [a, b] = calls.map((c) => c.body.param[0].codigo_cliente_integracao);
    assert.notEqual(a, b);
  });

  test('incluir conta a receber: IncluirContaReceber com os campos da Omie, datas em dd/mm/aaaa e previsão igual ao vencimento', async () => {
    answer = () => ({ codigo_lancamento_omie: 9821, codigo_lancamento_integracao: 'x', codigo_status: '0', descricao_status: 'Lançamento cadastrado com sucesso!' });
    const r = await acao('omie.incluir_conta_receber').run(ctx, { cliente: 2485780, valor: 150.5, vencimento: '2026-12-10', categoria: '1.01.02', conta_corrente: 427619, documento: 'NF 123' });
    assert.equal(calls[0].url.href, 'https://app.omie.com.br/api/v1/financas/contareceber/');
    const p = calls[0].body.param[0];
    assert.equal(calls[0].body.call, 'IncluirContaReceber');
    assert.match(p.codigo_lancamento_integracao, /^ergon-cr-[0-9a-f]{32}$/);
    const { codigo_lancamento_integracao: _c, ...resto } = p;
    assert.deepEqual(resto, { codigo_cliente_fornecedor: 2485780, data_vencimento: '10/12/2026', data_previsao: '10/12/2026', valor_documento: 150.5, codigo_categoria: '1.01.02', id_conta_corrente: 427619, numero_documento: 'NF 123' });
    assert.equal('boleto' in p, false, 'o boleto não é gerado');
    assert.equal(r.texto, 'A conta a receber incluída na Omie (id: 9821).');
  });
  test('incluir conta a receber: faltou o obrigatório ou o valor é inválido, nada vai', async () => {
    const base = { cliente: 1, valor: 10, vencimento: '10/12/2026', categoria: '1.01.02', conta_corrente: 1 };
    await assert.rejects(() => acao('omie.incluir_conta_receber').run(ctx, { ...base, valor: 0 }), /maior que zero/);
    await assert.rejects(() => acao('omie.incluir_conta_receber').run(ctx, { ...base, vencimento: '2026-13-40' }), /dd\/mm\/aaaa/);
    assert.equal(calls.length, 0);
    const a = OMIE.acoes.find((x) => x.id === 'omie.incluir_conta_receber')!;
    assert.deepEqual(Object.entries(a.params).filter(([, p]) => p.obrigatorio).map(([n]) => n), ['cliente', 'valor', 'vencimento', 'categoria', 'conta_corrente']);
    assert.match(acaoDe(a).resumo(base), /não gera boleto e não avisa o cliente/);
    assert.match(acaoDe(a).resumo(base), /valor: R\$ 10,00/);
  });
  test('categorias e contas correntes: as listas que a inclusão usa, com os nomes da Omie', async () => {
    answer = () => ({ pagina: 1, total_de_paginas: 1, categoria_cadastro: [{ codigo: '1.01.02', descricao: 'Vendas de serviços', conta_receita: 'S', conta_despesa: 'N', conta_inativa: 'N' }] });
    const cat = await acao('omie.categorias').run(ctx, {});
    assert.equal(calls[0].url.href, 'https://app.omie.com.br/api/v1/geral/categorias/');
    assert.deepEqual(calls[0].body, { call: 'ListarCategorias', app_key, app_secret, param: [{ pagina: 1, registros_por_pagina: 30 }] });
    assert.equal(cat.texto, '- Código: 1.01.02, Descrição: Vendas de serviços, Tipo: receita');
    answer = () => ({ pagina: 1, total_de_paginas: 2, ListarContasCorrentes: [{ nCodCC: 427619, descricao: 'Banco do Brasil', codigo_banco: '001', inativo: 'N' }] });
    const cc = await acao('omie.contas_correntes').run(ctx, {});
    assert.equal(calls[1].url.href, 'https://app.omie.com.br/api/v1/geral/contacorrente/');
    assert.deepEqual(calls[1].body, { call: 'ListarContasCorrentes', app_key, app_secret, param: [{ pagina: 1, registros_por_pagina: 30, apenas_importado_api: 'N' }] });
    assert.equal(cc.texto, '- Id: 427619, Descrição: Banco do Brasil, Banco: 001, Inativa: N\ncursor: 2');
  });
});

// ------------------------------------------------------------------------------------------------- RD Station CRM
describe('RD Station CRM: criar empresa', () => {
  const token = 'token-rd-de-mentira-0123456789';
  const ctx = contexto(RDSTATION, { token });
  const acao = acaoEm(RDSTATION);
  test('POST /organizations com o corpo em "organization", o token na consulta e o dono do token como responsável', async () => {
    answer = (c) => (c.url.pathname === '/api/v1/users/me' ? { id: 'eu' } : { _id: 'org_1', name: 'Padaria Pão Bom' });
    const r = await acao('rdstation.criar_empresa').run(ctx, { nome: 'Padaria Pão Bom', site: 'https://paobom.com.br', segmentos: 'Alimentação, Varejo' });
    assert.equal(calls[1].method, 'POST'); assert.equal(calls[1].url.pathname, '/api/v1/organizations'); assert.equal(calls[1].url.searchParams.get('token'), token);
    assert.deepEqual(calls[1].body, { organization: { name: 'Padaria Pão Bom', url: 'https://paobom.com.br', user_id: 'eu', organization_segments: ['Alimentação', 'Varejo'] } });
    assert.equal(r.texto, 'Empresa criada (id: org_1).');
    assert.ok(!acao('rdstation.criar_empresa').resumo({ nome: 'X', token }).includes(token));
  });
  test('sem responsável só organiza; com responsável (pode avisar a pessoa), é envio', () => {
    assert.equal(riscoDe(RDSTATION, 'rdstation.criar_empresa'), 'organizar');
    assert.equal(riscoDe(RDSTATION, 'rdstation.criar_empresa', { responsavel: 'u2' }), 'enviar');
  });
});

// ---------------------------------------------------------------------------------------------------------- Só leitura
describe('Só leitura', () => {
  test('a regra: tipos que escrevem desligados e nenhuma ação que escreve ligada por exceção', () => {
    const acoes = [{ id: 'a.ler', risco: 'ler' as const }, { id: 'a.criar', risco: 'organizar' as const }, { id: 'a.atribuir', risco: () => 'enviar' as const }];
    const todos = { organizar: 'desligado', enviar: 'desligado', apagar: 'desligado' } as const;
    assert.equal(soLeituraDe({ tipos: { ...todos }, acoes: {} }, acoes), true);
    assert.equal(soLeituraDe({ tipos: { ...todos }, acoes: { 'a.ler': 'desligado' } }, acoes), true, 'desligar uma leitura não muda nada');
    assert.equal(soLeituraDe({ tipos: { ...todos }, acoes: { 'a.criar': 'confirmar' } }, acoes), false, 'exceção ligada numa escrita');
    assert.equal(soLeituraDe({ tipos: { organizar: 'desligado', enviar: 'desligado' }, acoes: {} }, acoes), false);
    assert.equal(soLeituraDe({ tipos: {}, acoes: {} }, acoes), false);
    // só contam os tipos que a conexão tem: sem ação de apagar, apagar não precisa estar desligado
    const semApagar = [{ id: 'a.ler', risco: 'ler' as const }, { id: 'a.criar', risco: 'organizar' as const }, { id: 'a.cobrar', risco: 'enviar' as const }];
    assert.equal(soLeituraDe({ tipos: { organizar: 'desligado', enviar: 'desligado' }, acoes: {} }, semApagar), true);
    assert.equal(soLeituraDe({ tipos: { organizar: 'desligado' }, acoes: {} }, semApagar), false);
    // cada escrita desligada uma a uma também é só leitura
    assert.equal(soLeituraDe({ tipos: {}, acoes: { 'a.criar': 'desligado', 'a.cobrar': 'desligado' } }, semApagar), true);
    assert.equal(soLeituraDe({ tipos: { organizar: 'desligado', enviar: 'desligado' }, acoes: { 'a.cobrar': 'regra' } }, semApagar), false, '"seguir a regra" na ação deixa ligada');
    // desligado vale acima de "Liberar tudo" e da origem
    assert.equal(decidir({ risco: 'organizar', origem: 'pessoa', leuDeFora: false, liberarTudo: true, ajuste: 'desligado' }), 'recusar');
  });

  let h: Harness; let s: Session;
  beforeEach(async () => { h = await harness(); s = await setupOwner(h); });
  afterEach(() => h.close());
  const ligar = (kind: string, creds: Record<string, string>) => {
    h.integrations.secrets.writeOwn(s.workspaceId, kind as never, creds);
    setIntegration(h.db, s.workspaceId, kind as never, { state: 'connected', account_label: 'Conta', connected_at: new Date().toISOString() });
  };
  const estado = async (kind: string) => (await req(h, 'GET', '/api/conexoes', s)).json.ligadas.find((x: { kind: string }) => x.kind === kind);

  test('um clique desliga toda escrita da conexão; a pessoa e o agente são recusados sem chamar o serviço; outro clique volta', async () => {
    ligar('asaas', { access_token: '$aact_prod_chave-de-mentira-para-teste' });
    const antes = await estado('asaas');
    assert.equal(antes.soLeitura, false); assert.equal(antes.escreve, true);
    // uma exceção antiga ligada numa escrita não escapa do atalho
    assert.equal((await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: { tipos: { enviar: 'confirmar' }, acoes: { 'asaas.criar_link': 'regra', 'asaas.saldo': 'desligado' } } })).status, 200);
    const r = await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    assert.equal(r.status, 200); assert.equal(r.json.soLeitura, true);
    assert.deepEqual(r.json.permissoes, { tipos: { organizar: 'desligado', enviar: 'desligado', apagar: 'desligado' }, acoes: { 'asaas.saldo': 'desligado' } }, 'o ajuste das leituras fica');
    assert.equal((await estado('asaas')).soLeitura, true);

    const pessoa = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'asaas', 'asaas.criar_link', { nome: 'Consulta' });
    assert.equal(pessoa.ok, false); assert.match(pessoa.texto, /desligada/);
    assert.equal(calls.length, 0, 'nada foi ao Asaas');
    // para o agente, as escritas nem aparecem
    const lista = h.conexoes.listar(s.workspaceId, 'asaas');
    assert.match(lista, /asaas\.cobrancas/); assert.doesNotMatch(lista, /asaas\.criar_/); assert.doesNotMatch(lista, /asaas\.saldo/);

    const volta = await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: false });
    assert.equal(volta.json.soLeitura, false);
    assert.deepEqual(volta.json.permissoes, { tipos: { enviar: 'confirmar' }, acoes: { 'asaas.saldo': 'desligado' } }, 'o "sempre confirmar" que ela tinha posto volta');
    assert.match(h.conexoes.listar(s.workspaceId, 'asaas'), /asaas\.criar_cobranca/);
  });

  const settings = () => h.db.get<{ settings: string }>("SELECT settings FROM integrations WHERE kind = 'asaas'")!.settings;
  test('marcar e desmarcar devolve o ajuste de escrita de antes: tipo em "confirmar" e ação desligada voltam como estavam', async () => {
    ligar('asaas', { access_token: '$aact_prod_chave-de-mentira-para-teste' });
    const antes = { tipos: { enviar: 'confirmar', organizar: 'confirmar' }, acoes: { 'asaas.criar_cobranca': 'desligado', 'asaas.criar_link': 'regra', 'asaas.saldo': 'desligado' } };
    assert.equal((await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: antes })).status, 200);
    await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    // marcar de novo (dois cliques, duas abas) não troca o retrato de antes pelo "tudo desligado"
    await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    // mexer só numa leitura, em só leitura, não perde o retrato
    const ja = (await estado('asaas')).permissoes;
    await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: { ...ja, acoes: { ...ja.acoes, 'asaas.cobrancas': 'confirmar' } } });
    const volta = await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: false });
    assert.deepEqual(volta.json.permissoes, { tipos: { enviar: 'confirmar', organizar: 'confirmar' }, acoes: { 'asaas.criar_cobranca': 'desligado', 'asaas.criar_link': 'regra', 'asaas.saldo': 'desligado', 'asaas.cobrancas': 'confirmar' } });
    assert.equal(volta.json.soLeitura, false);
    const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'asaas', 'asaas.criar_cobranca', { cliente: 'cus_1', valor: 10, vencimento: '2026-12-01' });
    assert.equal(r.ok, false, 'a ação que ela tinha desligado continua desligada'); assert.equal(calls.length, 0);
    assert.equal(settings().includes('soLeituraAntes'), false, 'o retrato sai depois de devolvido');
  });

  test('ligar uma escrita à mão já sai do só leitura: desmarcar depois não volta ao retrato velho', async () => {
    ligar('asaas', { access_token: '$aact_prod_chave-de-mentira-para-teste' });
    await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: { tipos: { enviar: 'confirmar' }, acoes: {} } });
    await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    const ja = (await estado('asaas')).permissoes;
    await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: { ...ja, tipos: { ...ja.tipos, organizar: 'regra' } } });
    assert.equal((await estado('asaas')).soLeitura, false);
    assert.equal(settings().includes('soLeituraAntes'), false);
    // marcar de novo tira um retrato novo, o de agora
    await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    const volta = await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: false });
    assert.deepEqual(volta.json.permissoes.tipos, { enviar: 'desligado', apagar: 'desligado' });
  });

  test('só leitura feito à mão: a caixa aparece marcada, e desmarcar volta a escrita para a regra (não fica presa)', async () => {
    ligar('asaas', { access_token: '$aact_prod_chave-de-mentira-para-teste' });
    await req(h, 'PUT', '/api/conexoes/asaas/permissoes', s, { permissoes: { tipos: { organizar: 'desligado', enviar: 'desligado' }, acoes: {} } });
    assert.equal((await estado('asaas')).soLeitura, true, 'o Asaas não tem ação de apagar: os tipos que a tela mostra bastam');
    // marcar por cima tiraria o retrato "tudo desligado"; desmarcar não pode devolver isso
    await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: true });
    const volta = await req(h, 'PUT', '/api/conexoes/asaas/so-leitura', s, { on: false });
    assert.equal(volta.json.soLeitura, false); assert.deepEqual(volta.json.permissoes, { tipos: {}, acoes: {} });
  });

  test('vale para a ação cujo risco depende dos parâmetros (RD Station: criar com responsável vira envio)', async () => {
    ligar('rdstation', { token: 'token-rd-de-mentira-0123456789' });
    await req(h, 'PUT', '/api/conexoes/rdstation/so-leitura', s, { on: true });
    for (const args of [{ nome: 'X' }, { nome: 'X', responsavel: 'u2' }]) {
      const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'rdstation', 'rdstation.criar_empresa', args);
      assert.equal(r.ok, false, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  });

  test('conexão desconectada: o atalho recusa com 409', async () => {
    assert.equal((await req(h, 'PUT', '/api/conexoes/omie/so-leitura', s, { on: true })).status, 409);
  });
});
