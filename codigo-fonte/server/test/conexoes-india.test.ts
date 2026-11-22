/**
 * rc.48, os conectores da Índia, sem rede e com APIs falsas: Zoho (login por data center, CRM, Books e Mail), Razorpay,
 * Freshsales e Tally (só rede local; indisponível na nuvem). Confere endereço, método, cabeçalho e corpo exatos, o que pede
 * confirmação e o que é sempre-protegido (reembolso, captura, enviar fatura, registrar pagamento e voucher), e que nenhum
 * endereço vem do modelo.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, test } from 'node:test';
import { setHttpClock } from '../src/lib/http.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { ErroAcao, type CtxAcao } from '../src/services/conexoes/tipos.ts';
import { decidir } from '../src/services/conexoes/regra.ts';
import { acaoDe, conferirConector, httpDoConector, type ConectorDef, type Credenciais } from '../src/services/conexoes/conectores/declarativo.ts';
import { RAZORPAY, emRupias } from '../src/services/conexoes/conectores/razorpay.ts';
import { FRESHSALES } from '../src/services/conexoes/conectores/freshsales.ts';
import { TALLY, enderecoLocal, ipDoTally, lerXml, saldo, transporteTally } from '../src/services/conexoes/conectores/tally.ts';
import { ACOES_ZOHO, ESCOPOS_ZOHO, httpZoho, linkCrm } from '../src/services/conexoes/acoes/zoho.ts';
import { SsoAuth, zohoDcDoServidor } from '../src/services/sso.ts';
import { Integrations, INTEGRATIONS, SecretStore, setIntegration } from '../src/services/integrations.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, testConfig, tmpDir, type Harness, type Session } from './helpers.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any; raw: string };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    // o Tally de teste é um servidor HTTP de verdade nesta máquina
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const raw = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
    let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const c: Call = { method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body, raw };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : json(out);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
afterEach(() => { calls.length = 0; answer = () => ({}); });

const contexto = (def: ConectorDef, creds: Credenciais): CtxAcao => ({ workspaceId: 'ws', tz: 'Asia/Kolkata', http: httpDoConector(def, creds), creds });
const acaoEm = (lista: Array<{ id: string }>, fazer: (d: any) => ReturnType<typeof acaoDe>) => (id: string) => { const d = lista.find((a) => a.id === id); assert.ok(d, id); return fazer(d); };

// ---------------------------------------------------------------------------------------------------- Zoho: login
describe('Zoho: login por data center', () => {
  const cfg = { ...testConfig(tmpDir()), zohoClientId: '1000.ABCDEFGHIJKLMNOP', zohoClientSecret: 'segredo-geral-0123456789', zohoSecretsPorDc: { in: 'segredo-da-india-0123456789' }, zohoDcInicial: 'com' };
  const segredos = new SecretStore(cfg.dataDir);
  const ws = `ws_${'a'.repeat(32)}`;
  const sso = new SsoAuth(cfg, segredos);
  const estado = (u: string) => new URL(u).searchParams.get('state')!;

  test('começa no accounts.zoho.com, com os escopos separados por vírgula, offline e consent', () => {
    assert.equal(sso.configured('zoho'), true);
    const u = new URL(sso.start('zoho', ws, 'u1'));
    assert.equal(u.origin + u.pathname, 'https://accounts.zoho.com/oauth/v2/auth');
    assert.equal(u.searchParams.get('scope'), ESCOPOS_ZOHO.join(','));
    assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.match(u.searchParams.get('redirect_uri')!, /\/api\/integrations\/zoho\/callback$/);
    assert.ok(ESCOPOS_ZOHO.includes('ZohoCRM.modules.deals.ALL') && ESCOPOS_ZOHO.includes('ZohoBooks.invoices.CREATE') && ESCOPOS_ZOHO.includes('ZohoMail.messages.ALL'));
  });
  test('a conta da Índia: a troca do código e o perfil vão ao accounts.zoho.in, com o segredo do DC; o DC fica guardado', async () => {
    answer = (c) => (c.url.pathname === '/oauth/v2/token' ? { access_token: 'acesso-zoho-1', refresh_token: 'renova-zoho-1', api_domain: 'https://www.zohoapis.in', expires_in: 3600 } : { Email: 'priya@sharma.in', Display_Name: 'Priya' });
    const fim = await sso.finish('zoho', estado(sso.start('zoho', ws, 'u1')), 'codigo-1', { accountsServer: 'https://accounts.zoho.in' });
    assert.equal(fim.account, 'priya@sharma.in (zoho.in)');
    assert.equal(calls[0].url.href, 'https://accounts.zoho.in/oauth/v2/token');
    const corpo = new URLSearchParams(calls[0].raw);
    assert.equal(corpo.get('client_secret'), 'segredo-da-india-0123456789'); assert.equal(corpo.get('grant_type'), 'authorization_code');
    assert.equal(calls[1].url.href, 'https://accounts.zoho.in/oauth/user/info'); assert.equal(calls[1].headers.Authorization, 'Zoho-oauthtoken acesso-zoho-1');
    const t = segredos.read<{ dc: string; refresh_token: string }>(ws, 'zoho')!;
    assert.equal(t.dc, 'in'); assert.equal(t.refresh_token, 'renova-zoho-1');
    // a renovação vai ao mesmo data center
    calls.length = 0;
    answer = () => ({ access_token: 'acesso-zoho-2', expires_in: 3600 });
    assert.equal(await sso.accessToken(ws, 'zoho', { force: true }), 'acesso-zoho-2');
    assert.equal(calls[0].url.href, 'https://accounts.zoho.in/oauth/v2/token');
    assert.equal(segredos.read<{ dc: string; refresh_token: string }>(ws, 'zoho')!.refresh_token, 'renova-zoho-1', 'a Zoho não manda outro refresh token: fica o anterior');
  });
  test('accounts-server que não é da Zoho: recusado antes de mandar o segredo a qualquer lugar', async () => {
    for (const ruim of ['https://accounts.zoho.in.atacante.com', 'http://accounts.zoho.in', 'https://accounts.zoho.in:444', 'https://accounts.zoho.in/x', 'https://atacante.com']) {
      assert.equal(zohoDcDoServidor(ruim), null, ruim);
      await assert.rejects(() => sso.finish('zoho', estado(sso.start('zoho', ws, 'u1')), 'c', { accountsServer: ruim }), /data center da Zoho/);
    }
    assert.equal(calls.length, 0);
    for (const [s, dc] of [['https://accounts.zoho.eu', 'eu'], ['https://accounts.zoho.com.au', 'com.au'], ['https://accounts.zohocloud.ca', 'ca'], ['https://accounts.zoho.com', 'com']]) assert.equal(zohoDcDoServidor(s), dc);
  });
  test('sem client id, o botão diz o que falta (não finge)', () => {
    const sem = new SsoAuth({ ...cfg, zohoClientId: null }, segredos);
    assert.equal(sem.configured('zoho'), false);
    assert.throws(() => sem.start('zoho', ws, 'u1'), /Falta registrar o aplicativo Ergon na Zoho/);
    assert.equal(new SsoAuth({ ...cfg, zohoClientSecret: null, zohoSecretsPorDc: {} }, segredos).configured('zoho'), false, 'sem segredo nenhum, também não');
  });
  test('o catálogo: Zoho entra por login, no grupo das contas', () => {
    const d = INTEGRATIONS.find((i) => i.kind === 'zoho')!;
    assert.equal(d.auth, 'oauth'); assert.equal(d.group, 'contas'); assert.match(d.about, /zoho\.in/);
  });
});

// ---------------------------------------------------------------------------------------------------- Zoho: ações
describe('Zoho: CRM, Books e Mail', () => {
  const ctx: CtxAcao = { workspaceId: 'ws', tz: 'Asia/Kolkata', dc: 'in', http: httpZoho('in', async () => 'acesso-zoho') };
  const acao = acaoEm(ACOES_ZOHO, (a) => a);
  const ORG = { organizations: [{ organization_id: '60012345', name: 'Sharma Traders', is_default_org: true }] };

  test('o http da Zoho: CRM e Books na API do data center, Mail no mail.zoho.<dc>, nada fora disso', async () => {
    answer = () => ({ data: [] });
    await ctx.http('/crm/v8/Leads?fields=Email');
    await ctx.http('/mail/accounts');
    assert.equal(calls[0].url.href, 'https://www.zohoapis.in/crm/v8/Leads?fields=Email');
    assert.equal(calls[1].url.href, 'https://mail.zoho.in/api/accounts');
    assert.equal(calls[0].headers.Authorization, 'Zoho-oauthtoken acesso-zoho');
    await assert.rejects(() => ctx.http('/../../atacante'), /fora da Zoho/);
    await assert.rejects(() => ctx.http('https://atacante.com/crm/'), /fora da Zoho/);
    answer = () => ({ code: 1002, message: 'Invoice does not exist' });
    await assert.rejects(() => ctx.http('/books/v3/invoices/1'), (e: unknown) => e instanceof ProviderError && /Invoice does not exist/.test(e.message));
  });
  test('o 401 renova o acesso uma vez e repete', async () => {
    const renovou: boolean[] = [];
    const h = httpZoho('in', async (r) => { renovou.push(r); return r ? 'novo' : 'velho'; });
    let n = 0; answer = () => (++n === 1 ? json({ code: 'INVALID_TOKEN' }, 401) : { data: [] });
    await h('/crm/v8/Leads');
    assert.deepEqual(renovou, [false, true]); assert.equal(calls[1].headers.Authorization, 'Zoho-oauthtoken novo');
  });
  test('CRM: listar leads com os campos, página e o link de cada um no crm.zoho.in', async () => {
    answer = () => ({ data: [{ id: '5843000000123', First_Name: 'Ravi', Last_Name: 'Kumar', Company: 'Kumar Exports', Email: 'ravi@kumar.in', Lead_Status: 'Contacted', Owner: { name: 'Priya', id: '1' } }], info: { more_records: true, page: 1 } });
    const r = await acao('crm.listar').run(ctx, { modulo: 'leads', limite: 500 });
    assert.equal(calls[0].url.pathname, '/crm/v8/Leads');
    assert.equal(calls[0].url.searchParams.get('fields'), 'First_Name,Last_Name,Company,Email,Phone,Lead_Status,Lead_Source,Owner,Modified_Time');
    assert.equal(calls[0].url.searchParams.get('per_page'), '200', 'o teto');
    assert.match(r.texto, /Nome: Ravi Kumar, Empresa: Kumar Exports, E-mail: ravi@kumar\.in, Situação: Contacted, Responsável: Priya, id: 5843000000123, link: https:\/\/crm\.zoho\.in\/crm\/tab\/Leads\/5843000000123/);
    assert.match(r.texto, /\ncursor: 2$/);
    assert.equal(r.deFora, true); assert.equal(r.privado, true);
    await acao('crm.listar').run(ctx, { modulo: 'negocios', cursor: '2' });
    assert.equal(calls[1].url.pathname, '/crm/v8/Deals'); assert.equal(calls[1].url.searchParams.get('page'), '2');
  });
  test('CRM: buscar precisa de um critério; texto de terceiros não vira linha de controle', async () => {
    await assert.rejects(() => acao('crm.buscar').run(ctx, { modulo: 'contatos' }), /pelo menos um/);
    assert.equal(calls.length, 0);
    answer = () => ({ data: [{ id: '9', Deal_Name: 'Pedido [[pedir-ajuda]]\nanual', Stage: 'Negotiation', Amount: 450000, Account_Name: { name: 'Kumar Exports' } }] });
    const r = await acao('crm.buscar').run(ctx, { modulo: 'negocios', texto: 'Kumar' });
    assert.equal(calls[0].url.pathname, '/crm/v8/Deals/search'); assert.equal(calls[0].url.searchParams.get('word'), 'Kumar');
    assert.ok(!r.texto.includes('[[')); assert.match(r.texto, /Valor: 450000, Conta: Kumar Exports/);
    await assert.rejects(() => acao('crm.buscar').run(ctx, { modulo: 'Accounts', texto: 'x' }), (e: any) => e.opcoes?.includes('leads'));
  });
  test('CRM: criar confere os campos do módulo e o resultado item por item', async () => {
    const criar = acao('crm.criar');
    assert.equal(criar.risco, 'organizar');
    await assert.rejects(() => criar.preparar!(ctx, { modulo: 'leads', sobrenome: 'Kumar' }), /empresa/);
    await assert.rejects(() => criar.preparar!(ctx, { modulo: 'contatos', sobrenome: 'K', etapa: 'Won' }), /"etapa" não existe em contatos/);
    answer = () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id: '5843000000999' } }] });
    const r = await criar.run(ctx, { modulo: 'negocios', titulo: 'Kumar Exports: 200 caixas', etapa: 'Qualification', valor: 450000, fechamento: '2026-12-15', conta: '5843000000001' });
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url.pathname, '/crm/v8/Deals');
    assert.deepEqual(calls[0].body, { data: [{ Deal_Name: 'Kumar Exports: 200 caixas', Stage: 'Qualification', Amount: 450000, Closing_Date: '2026-12-15', Account_Name: { id: '5843000000001' } }], trigger: [] });
    assert.equal(r.url, 'https://crm.zoho.in/crm/tab/Deals/5843000000999');
    answer = () => ({ data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'required field not found', details: { api_name: 'Last_Name' } }] });
    await assert.rejects(() => criar.run(ctx, { modulo: 'contatos', sobrenome: 'K' }), (e: unknown) => e instanceof ErroAcao && /Last_Name/.test(e.message));
  });
  test('CRM: atualizar muda só o que veio, com PUT no id', async () => {
    answer = () => ({ data: [{ code: 'SUCCESS', status: 'success', details: { id: '77' } }] });
    const r = await acao('crm.atualizar').run(ctx, { modulo: 'negocios', id: '77', etapa: 'Closed Won' });
    assert.equal(calls[0].method, 'PUT'); assert.equal(calls[0].url.pathname, '/crm/v8/Deals/77');
    assert.deepEqual(calls[0].body, { data: [{ Stage: 'Closed Won' }], trigger: [] });
    assert.match(r.texto, /Negócio atualizado no Zoho CRM \(id: 77\): https:\/\/crm\.zoho\.in\/crm\/tab\/Deals\/77/);
    assert.equal(linkCrm('com', 'contatos', '1'), 'https://crm.zoho.com/crm/tab/Contacts/1');
  });
  test('Books: a organização padrão entra em toda chamada; faturas com o link do Books', async () => {
    answer = (c) => (c.url.pathname.endsWith('/organizations') ? ORG : { invoices: [{ invoice_id: '9001', invoice_number: 'INV-000123', customer_name: 'Kumar Exports', status: 'overdue', total: 118000, balance: 118000, currency_code: 'INR', due_date: '2026-11-10' }], page_context: { has_more_page: false } });
    const r = await acao('books.faturas').run(ctx, { situacao: 'overdue' });
    assert.equal(calls[0].url.href, 'https://www.zohoapis.in/books/v3/organizations');
    assert.equal(calls[1].url.pathname, '/books/v3/invoices');
    assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { organization_id: '60012345', status: 'overdue', per_page: '20' });
    assert.match(r.texto, /Fatura: INV-000123, Cliente: Kumar Exports, Situação: overdue, Vencimento: 2026-11-10, Total: 118000, Em aberto: 118000, Moeda: INR, id: 9001, link: https:\/\/books\.zoho\.in\/app\/60012345#\/invoices\/9001/);
    answer = () => ({ organizations: [{ organization_id: '1', name: 'A' }, { organization_id: '2', name: 'B' }] });
    await assert.rejects(() => acao('books.clientes').run(ctx, {}), (e: any) => /mais de uma organização/.test(e.message) && e.opcoes.length === 2);
  });
  test('Books: criar fatura é rascunho (send=false), com os itens que o cartão mostra', async () => {
    const f = acao('books.criar_fatura');
    assert.equal(f.risco, 'organizar'); assert.equal(f.protegida, undefined);
    const itens = 'Caixas de papelão | 200 | 450\nFrete | 1 | 2500';
    assert.match(f.resumo({ cliente: '460000000026049', itens }), /RASCUNHO[\s\S]*- Caixas de papelão: 200 × 450\n- Frete: 1 × 2500\nTotal \(sem impostos\): 92500/);
    await assert.rejects(() => f.preparar!(ctx, { cliente: '1', itens: 'sem preço' }), /item 1 inválido/);
    answer = (c) => (c.url.pathname.endsWith('/organizations') ? ORG : { code: 0, invoice: { invoice_id: '9002', invoice_number: 'INV-000124', status: 'draft', total: 92500 } });
    const r = await f.run(ctx, { cliente: '460000000026049', itens, vencimento: '2026-12-01' });
    const post = calls.find((c) => c.method === 'POST')!;
    assert.equal(post.url.pathname, '/books/v3/invoices'); assert.equal(post.url.searchParams.get('send'), 'false'); assert.equal(post.url.searchParams.get('organization_id'), '60012345');
    assert.deepEqual(post.body, { customer_id: '460000000026049', line_items: [{ name: 'Caixas de papelão', quantity: 200, rate: 450 }, { name: 'Frete', quantity: 1, rate: 2500 }], due_date: '2026-12-01' });
    assert.match(r.texto, /rascunho/); assert.equal(r.url, 'https://books.zoho.in/app/60012345#/invoices/9002');
  });
  test('Books: enviar fatura e registrar pagamento são sempre-protegidos (nem "Liberar tudo" nem regra passam)', () => {
    for (const id of ['books.enviar_fatura', 'books.registrar_pagamento']) {
      const a = acao(id);
      assert.match(a.protegida!, /mesmo com "Liberar tudo"/, id);
      assert.equal(decidir({ risco: typeof a.risco === 'function' ? a.risco({}) : a.risco, origem: 'pessoa', leuDeFora: false, liberarTudo: true, regra: true, protegida: !!a.protegida }), 'confirmar', id);
    }
    const protegidas = ACOES_ZOHO.filter((a) => a.protegida).map((a) => a.id);
    assert.deepEqual(protegidas, ['books.enviar_fatura', 'books.registrar_pagamento']);
  });
  test('Books: o pagamento vai aplicado à fatura, com a forma e a referência', async () => {
    answer = (c) => (c.url.pathname.endsWith('/organizations') ? ORG : { code: 0, payment: { payment_id: '7', payment_number: '12', amount: 118000, date: '2026-11-22' } });
    await acao('books.registrar_pagamento').run(ctx, { cliente: '46', fatura: '9001', valor: 118000, data: '2026-11-22', forma: 'upi', referencia: 'UTR 4321' });
    const post = calls.find((c) => c.method === 'POST')!;
    assert.equal(post.url.pathname, '/books/v3/customerpayments');
    assert.deepEqual(post.body, { customer_id: '46', payment_mode: 'upi', amount: 118000, date: '2026-11-22', reference_number: 'UTR 4321', invoices: [{ invoice_id: '9001', amount_applied: 118000 }] });
  });
  test('Mail: listar, ler e enviar, com o risco dos outros e-mails', async () => {
    const CONTA = { data: [{ accountId: '2560000000012', primaryEmailAddress: 'priya@sharma.in' }] };
    answer = (c) => (c.url.pathname === '/api/accounts' ? CONTA : { data: [{ folderId: '11', messageId: '22', subject: 'Order 200 boxes', fromAddress: 'ravi@kumar.in', summary: 'Please confirm', receivedTime: '1763800000000', status: '0' }] });
    const l = await acao('email.buscar').run(ctx, { texto: 'boxes' });
    assert.equal(calls[1].url.pathname, '/api/accounts/2560000000012/messages/search'); assert.equal(calls[1].url.searchParams.get('searchKey'), 'entire:boxes');
    assert.match(l.texto, /de ravi@kumar\.in: "Order 200 boxes" Please confirm \(id: 11:22, não lido\)/);
    calls.length = 0;
    answer = (c) => (c.url.pathname === '/api/accounts' ? CONTA : { data: { content: '<p>Hi Priya,</p><p>Please confirm.</p>' } });
    const m = await acao('email.ler').run(ctx, { id: '11:22' });
    assert.equal(calls[1].url.pathname, '/api/accounts/2560000000012/folders/11/messages/22/content');
    assert.match(m.texto, /Hi Priya, Please confirm\./);
    await assert.rejects(() => acao('email.ler').run(ctx, { id: '../x' }), /pasta:mensagem/);
    const enviar = acao('email.enviar');
    assert.equal(enviar.risco, 'enviar'); assert.equal(enviar.protegida, undefined); assert.equal(enviar.sempreConfirma, undefined);
    assert.match(enviar.resumo({ para: 'ravi@kumar.in', assunto: 'Re: boxes', texto: 'Confirmado.' }), /^Enviar e-mail pelo Zoho Mail para ravi@kumar\.in\. Assunto: "Re: boxes"\. Texto: "Confirmado\."$/);
    calls.length = 0;
    answer = (c) => (c.url.pathname === '/api/accounts' ? CONTA : { status: { code: 200 }, data: {} });
    await enviar.run(ctx, { para: 'ravi@kumar.in', assunto: 'Re: boxes\r\nBcc: x@y.z', texto: 'Confirmado.' });
    assert.deepEqual(calls[1].body, { fromAddress: 'priya@sharma.in', toAddress: 'ravi@kumar.in', subject: 'Re: boxes Bcc: x@y.z', content: 'Confirmado.', mailFormat: 'plaintext' });
    await assert.rejects(() => enviar.preparar!(ctx, { para: 'não é e-mail', assunto: 'a', texto: 'b' }), /não é um e-mail válido/);
  });
});

// ---------------------------------------------------------------------------------------------------- Razorpay
describe('Razorpay', () => {
  const creds = { key_id: 'rzp_test_AbCdEf1234567', key_secret: 'segredo-razorpay-0123456789' };
  const ctx = contexto(RAZORPAY, creds);
  const acao = acaoEm(RAZORPAY.acoes, acaoDe);

  test('a definição: financeiro, chave em Basic, Key Id conferido, segredo secreto', async () => {
    assert.equal(RAZORPAY.grupo, 'financeiro');
    assert.deepEqual(RAZORPAY.campos.map((c) => [c.name, !!c.secret]), [['key_id', false], ['key_secret', true]]);
    assert.ok(RAZORPAY.campos[0].pattern!.test('rzp_live_AbCdEf1234567')); assert.ok(!RAZORPAY.campos[0].pattern!.test('sk_live_x'));
    answer = () => ({ entity: 'collection', count: 0, items: [] });
    assert.equal(await conferirConector(RAZORPAY, creds), 'Razorpay');
    assert.equal(calls[0].url.href, 'https://api.razorpay.com/v1/payments?count=1');
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString('base64')}`);
  });
  test('o que escreve é só criar link (confirma sempre), reembolsar e capturar (sempre-protegidos); o resto lê com GET', () => {
    const escrevem = RAZORPAY.acoes.filter((a) => a.metodo !== 'GET').map((a) => [a.id, a.metodo, a.caminho]);
    assert.deepEqual(escrevem, [['razorpay.criar_link', 'POST', '/payment_links'], ['razorpay.reembolsar', 'POST', '/payments/{pagamento}/refund'], ['razorpay.capturar', 'POST', '/payments/{pagamento}/capture']]);
    assert.ok(RAZORPAY.acoes.filter((a) => a.metodo === 'GET').every((a) => a.risco === 'ler'));
    assert.deepEqual(RAZORPAY.acoes.filter((a) => a.protegida).map((a) => a.id), ['razorpay.reembolsar', 'razorpay.capturar']);
    assert.deepEqual(RAZORPAY.acoes.filter((a) => a.sempreConfirma).map((a) => a.id), ['razorpay.criar_link']);
    for (const id of ['razorpay.reembolsar', 'razorpay.capturar']) assert.equal(decidir({ risco: 'enviar', origem: 'pessoa', leuDeFora: false, liberarTudo: true, regra: true, protegida: true }), 'confirmar', id);
    assert.equal(decidir({ risco: 'organizar', origem: 'pessoa', leuDeFora: false, liberarTudo: true, sempreConfirma: true }), 'confirmar', 'link: "Liberar tudo" não libera');
  });
  test('pagamentos: em rupias com lakh, UPI e o link do painel; período no horário da Índia; página por skip', async () => {
    answer = () => ({ entity: 'collection', count: 1, items: [{ id: 'pay_29QQoUBi66xm2f', amount: 12345650, currency: 'INR', status: 'captured', method: 'upi', vpa: 'ravi@okhdfcbank', email: 'ravi@kumar.in', order_id: 'order_1', created_at: 1763800000 }] });
    const r = await acao('razorpay.pagamentos').run(ctx, { de: '2026-11-01', ate: '2026-11-22', limite: 1 });
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { count: '1', from: String(Date.parse('2026-11-01T00:00:00+05:30') / 1000), to: String(Date.parse('2026-11-22T23:59:59+05:30') / 1000) });
    assert.match(r.texto, /Pagamento: pay_29QQoUBi66xm2f, Valor: ₹1,23,456\.50, Situação: captured, Forma: upi, UPI: ravi@okhdfcbank/);
    assert.match(r.texto, /link: https:\/\/dashboard\.razorpay\.com\/app\/payments\/pay_29QQoUBi66xm2f/);
    assert.match(r.texto, /\ncursor: 1$/);
    assert.equal(emRupias(9900, 'USD'), '99.00 USD');
  });
  test('criar link: paise, sem avisar o cliente por padrão; com SMS é envio; o cartão diz tudo', async () => {
    const link = acao('razorpay.criar_link');
    assert.equal(typeof link.risco === 'function' ? link.risco({}) : link.risco, 'organizar');
    assert.equal(typeof link.risco === 'function' ? link.risco({ avisar_sms: true }) : '', 'enviar');
    assert.equal(link.resumo({ valor: 4999.5, descricao: 'Pedido #123', cliente: 'Ravi Kumar', telefone: '+919812345678', avisar_sms: true }),
      'Criar um link de pagamento no Razorpay de ₹4,999.50 para Ravi Kumar, +919812345678.\nDescrição: Pedido #123\nO Razorpay avisa o cliente por SMS na hora.');
    await assert.rejects(() => link.preparar!(ctx, { valor: 0.5, descricao: 'x' }), /pelo menos 1/);
    await assert.rejects(() => link.preparar!(ctx, { valor: 10, descricao: 'x', avisar_email: true }), /"email"/);
    answer = () => ({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', amount: 499950, currency: 'INR' });
    const r = await link.run(ctx, { valor: 4999.5, descricao: 'Pedido #123', upi: true, referencia: 'PED-123' });
    assert.deepEqual(calls[0].body, { amount: 499950, currency: 'INR', description: 'Pedido #123', accept_partial: false, upi_link: true, notify: { sms: false, email: false }, reminder_enable: false, reference_id: 'PED-123' });
    assert.equal(r.url, 'https://rzp.io/i/abc'); assert.match(r.texto, /₹4,999\.50/);
  });
  test('reembolso: o cartão mostra o pagamento; o valor vai em paise', async () => {
    answer = (c) => (c.method === 'GET' ? { id: 'pay_1', amount: 100000, currency: 'INR', status: 'captured', method: 'card' } : { id: 'rfnd_1', payment_id: 'pay_1', amount: 50000, status: 'processed' });
    const p = await acao('razorpay.reembolsar').preparar!(ctx, { pagamento: 'pay_1', valor: 500 });
    assert.match(p.detalhe!, /Valor: ₹1,000\.00/);
    await acao('razorpay.reembolsar').run(ctx, { pagamento: 'pay_1', valor: 500, motivo: 'caixa amassada' });
    const post = calls.find((c) => c.method === 'POST')!;
    assert.equal(post.url.pathname, '/v1/payments/pay_1/refund');
    assert.deepEqual(post.body, { amount: 50000, speed: 'normal', notes: { motivo: 'caixa amassada' } });
  });
  test('erro do Razorpay sem repetir a chave', async () => {
    answer = () => json({ error: { code: 'BAD_REQUEST_ERROR', description: `The api key provided is invalid ${creds.key_secret}` } }, 401);
    await assert.rejects(() => conferirConector(RAZORPAY, creds), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && !e.message.includes(creds.key_secret));
  });
});

// ---------------------------------------------------------------------------------------------------- Freshsales
describe('Freshsales', () => {
  const creds = { dominio: 'sharma', chave: 'chave-freshsales-0123456789' };
  const ctx = contexto(FRESHSALES, creds);
  const acao = acaoEm(FRESHSALES.acoes, acaoDe);

  test('domínio: só da Freshworks; chave em "Token token="', async () => {
    answer = () => ({ users: [{ id: 1, display_name: 'Priya Sharma' }] });
    assert.equal(await conferirConector(FRESHSALES, creds), 'Priya Sharma');
    assert.equal(calls[0].url.href, 'https://sharma.myfreshworks.com/crm/sales/api/selector/owners');
    assert.equal(calls[0].headers.Authorization, `Token token=${creds.chave}`);
    await conferirConector(FRESHSALES, { ...creds, dominio: 'https://antiga.freshsales.io/contacts' });
    assert.equal(calls[1].url.href, 'https://antiga.freshsales.io/api/selector/owners');
    for (const ruim of ['192.168.0.1', 'atacante.com', 'sharma.myfreshworks.com.atacante.com', 'x.internal']) await assert.rejects(() => conferirConector(FRESHSALES, { ...creds, dominio: ruim }), ErroAcao, ruim);
  });
  test('buscar e listar, com o link de cada registro', async () => {
    answer = () => [{ id: '42', type: 'contact', name: 'Ravi Kumar', email: 'ravi@kumar.in' }, { id: '7', type: 'deal', name: 'Kumar Exports: 200 caixas' }];
    const b = await acao('freshsales.buscar').run(ctx, { texto: 'Kumar' });
    assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { q: 'Kumar', include: 'contact,sales_account,deal', per_page: '25' });
    assert.match(b.texto, /- \[contato\] Ravi Kumar, e-mail: ravi@kumar\.in, id: 42, link: https:\/\/sharma\.myfreshworks\.com\/crm\/sales\/contacts\/42/);
    assert.match(b.texto, /- \[negócio\] Kumar Exports: 200 caixas, id: 7, link: https:\/\/sharma\.myfreshworks\.com\/crm\/sales\/deals\/7/);
    calls.length = 0;
    answer = (c) => (c.url.pathname.endsWith('/filters') ? { filters: [{ id: 9, name: 'My Deals' }, { id: 3, name: 'All Deals', is_default: true }] } : { deals: [{ id: 7, name: 'Kumar', amount: 450000 }], meta: { total_pages: 2 } });
    const l = await acao('freshsales.listar').run(ctx, { tipo: 'negocios' });
    assert.equal(calls[1].url.pathname, '/crm/sales/api/deals/view/3');
    assert.match(l.texto, /Negócio: Kumar, Valor: 450000, id: 7/); assert.match(l.texto, /\ncursor: 2$/);
  });
  test('criar e atualizar: o corpo do tipo; responsável vira envio', async () => {
    const criar = acao('freshsales.criar');
    assert.equal(typeof criar.risco === 'function' && criar.risco({}), 'organizar');
    assert.equal(typeof criar.risco === 'function' && criar.risco({ responsavel: 5 }), 'enviar');
    await assert.rejects(() => criar.preparar!(ctx, { tipo: 'negocios', titulo: 'x' }), /valor/);
    await assert.rejects(() => criar.preparar!(ctx, { tipo: 'contas', empresa: 'X', email: 'a@b.c' }), /"email" não existe em contas/);
    answer = () => ({ contact: { id: 55 } });
    const r = await criar.run(ctx, { tipo: 'contatos', nome: 'Ravi', sobrenome: 'Kumar', email: 'ravi@kumar.in', conta: 12 });
    assert.equal(calls[0].url.pathname, '/crm/sales/api/contacts');
    assert.deepEqual(calls[0].body, { contact: { first_name: 'Ravi', last_name: 'Kumar', email: 'ravi@kumar.in', sales_account_id: 12 } });
    assert.equal(r.url, 'https://sharma.myfreshworks.com/crm/sales/contacts/55');
    await acao('freshsales.atualizar').run(ctx, { tipo: 'negocios', id: '7', valor: 500000, etapa: 3 });
    assert.equal(calls[1].method, 'PUT'); assert.equal(calls[1].url.pathname, '/crm/sales/api/deals/7');
    assert.deepEqual(calls[1].body, { deal: { amount: 500000, deal_stage_id: 3 } });
  });
});

// ---------------------------------------------------------------------------------------------------- Tally
describe('Tally: só rede local', () => {
  test('endereços: privado e desta máquina sim; público, enlace e metadado da nuvem não', () => {
    for (const ip of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.64.0.7', 'fd12:3456::1', '::ffff:192.168.1.2']) assert.equal(enderecoLocal(ip), 'privado', ip);
    for (const ip of ['127.0.0.1', '::1']) assert.equal(enderecoLocal(ip), 'maquina', ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '169.254.169.254', '0.0.0.0', '100.128.0.1', 'fe80::1', '2001:4860::8888', '::ffff:8.8.8.8']) assert.equal(enderecoLocal(ip), null, ip);
  });
  test('o nome é resolvido aqui e todo endereço dele tem de ser local; portas do Ergon e do sistema ficam de fora', async () => {
    assert.deepEqual(await ipDoTally({ host: 'tally-pc.local', porta: '9000' }, async () => ['192.168.1.20']), { ip: '192.168.1.20', porta: 9000 });
    assert.deepEqual(await ipDoTally({ host: '192.168.1.20' }), { ip: '192.168.1.20', porta: 9000 }, 'a porta padrão é 9000');
    await assert.rejects(() => ipDoTally({ host: 'tally.exemplo.com' }, async () => ['192.168.1.20', '203.0.113.9']), /endereço público não é aceito/);
    await assert.rejects(() => ipDoTally({ host: '169.254.169.254', porta: '80' }), /endereço público/);
    await assert.rejects(() => ipDoTally({ host: '8.8.8.8' }), /endereço público/);
    for (const p of ['8787', '22', '8642']) await assert.rejects(() => ipDoTally({ host: '127.0.0.1', porta: p }), /não é a do Tally/, p);
    await assert.rejects(() => ipDoTally({ host: 'a b' }), /inválido/);
    await assert.rejects(() => ipDoTally({ host: '10.0.0.1', porta: '70000' }), /porta/);
  });
  test('o leitor de XML: entidades, atributos, CDATA, sem DTD; o saldo em Dr/Cr', () => {
    const a = lerXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><ENVELOPE><LEDGER NAME="Kumar &amp; Sons"><PARENT>Sundry Debtors</PARENT><X><![CDATA[a<b]]></X><Y>&e;&#4;ok</Y></LEDGER></ENVELOPE>');
    const l = a.filhos[0].filhos[0];
    assert.equal(l.attrs.NAME, 'Kumar & Sons'); assert.equal(l.filhos[1].texto, 'a<b'); assert.equal(l.filhos[2].texto, '&e;ok', 'entidade externa não é lida');
    assert.equal(saldo('-123456.5'), '1,23,456.50 Dr'); assert.equal(saldo('2500'), '2,500.00 Cr'); assert.equal(saldo('0'), '0.00');
  });

  describe('com um TallyPrime de mentira nesta máquina', () => {
    let srv: http.Server; let porta = 0; const pedidos: string[] = [];
    let resposta = '';
    before(async () => {
      srv = http.createServer((q, r) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { pedidos.push(b); r.writeHead(200, { 'content-type': 'text/xml' }); r.end(resposta); }); });
      await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
      porta = (srv.address() as AddressInfo).port;
    });
    after(() => srv.close());
    afterEach(() => { pedidos.length = 0; });
    const creds = () => ({ host: '127.0.0.1', porta: String(porta), empresa: 'Sharma Traders' });
    const ctx = (): CtxAcao => ({ workspaceId: 'ws', tz: 'Asia/Kolkata', http: httpDoConector(TALLY, creds()), creds: creds() });
    const acao = acaoEm(TALLY.acoes, acaoDe);

    test('conferir: a lista de empresas; o pedido é um Export de Collection com a empresa', async () => {
      resposta = '<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Sharma Traders"><NAME>Sharma Traders</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>';
      assert.equal(await conferirConector(TALLY, creds()), 'TallyPrime: Sharma Traders');
      assert.match(pedidos[0], /<TALLYREQUEST>Export<\/TALLYREQUEST><TYPE>Collection<\/TYPE>/);
      assert.match(pedidos[0], /<SVCURRENTCOMPANY>Sharma Traders<\/SVCURRENTCOMPANY>/);
      assert.match(pedidos[0], /<TYPE>Company<\/TYPE>/);
    });
    test('razões com saldo Dr/Cr, filtrados por grupo; período em AAAAMMDD', async () => {
      resposta = '<ENVELOPE><BODY><DATA><COLLECTION><LEDGER NAME="Kumar Exports"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-10000</OPENINGBALANCE><CLOSINGBALANCE>-118000.00</CLOSINGBALANCE></LEDGER><LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><CLOSINGBALANCE>-2500</CLOSINGBALANCE></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>';
      const r = await acao('tally.razoes').run(ctx(), { grupo: 'Sundry Debtors', de: '2026-04-01', ate: '2026-11-22' });
      assert.equal(r.texto, '- Kumar Exports [Sundry Debtors]: abertura 10,000.00 Dr, fechamento 1,18,000.00 Dr');
      assert.match(pedidos[0], /<SVFROMDATE>20260401<\/SVFROMDATE><SVTODATE>20261122<\/SVTODATE>/);
      assert.equal(r.deFora, true);
    });
    test('vouchers por tipo: o filtro vai como fórmula do TDL; aspas no tipo são recusadas', async () => {
      resposta = '<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><DATE>20261120</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>123</VOUCHERNUMBER><PARTYLEDGERNAME>Kumar Exports</PARTYLEDGERNAME><AMOUNT>-118000</AMOUNT><NARRATION>200 caixas</NARRATION><MASTERID>901</MASTERID></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>';
      const r = await acao('tally.vouchers').run(ctx(), { tipo: 'Sales', de: '2026-11-01', ate: '2026-11-22' });
      assert.equal(r.texto, '- 2026-11-20 Sales nº 123: Kumar Exports, 1,18,000.00 Dr — 200 caixas (id 901)');
      assert.match(pedidos[0], /<FILTERS>ErgonFiltro<\/FILTERS><\/COLLECTION><SYSTEM TYPE="Formulae" NAME="ErgonFiltro">\$VoucherTypeName = "Sales"<\/SYSTEM>/);
      await assert.rejects(() => acao('tally.vouchers').run(ctx(), { tipo: 'Sales" OR "1' }), /aspas/);
    });
    test('criar voucher: sempre-protegido; débito negativo e crédito positivo; o texto do Tally é escapado', async () => {
      const v = acao('tally.criar_voucher');
      assert.match(v.protegida!, /mesmo com "Liberar tudo"/);
      assert.deepEqual(TALLY.acoes.filter((a) => a.protegida).map((a) => a.id), ['tally.criar_voucher']);
      assert.ok(TALLY.acoes.filter((a) => a.id !== 'tally.criar_voucher').every((a) => a.risco === 'ler'));
      await assert.rejects(() => v.preparar!(ctx(), { tipo: 'Receipt', data: '2026-11-22', debito: 'Cash', credito: 'cash', valor: 10 }), /diferentes/);
      resposta = '<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>902</LASTVCHID></RESPONSE>';
      const r = await v.run(ctx(), { tipo: 'Receipt', data: '2026-11-22', debito: 'HDFC Bank', credito: 'Kumar & Sons <x>', valor: 118000, narracao: 'UPI UTR 4321' });
      assert.equal(r.texto, 'Voucher criado no Tally (id 902).');
      assert.match(pedidos[0], /<TALLYREQUEST>Import Data<\/TALLYREQUEST>/);
      assert.match(pedidos[0], /<LEDGERNAME>HDFC Bank<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-118000\.00<\/AMOUNT>/);
      assert.match(pedidos[0], /<LEDGERNAME>Kumar &amp; Sons &lt;x&gt;<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>118000\.00<\/AMOUNT>/);
      resposta = '<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger \'Xyz\' does not exist!</LINEERROR></RESPONSE>';
      await assert.rejects(() => v.run(ctx(), { tipo: 'Receipt', data: '2026-11-22', debito: 'Xyz', credito: 'Cash', valor: 1 }), /Ledger 'Xyz' does not exist/);
    });
    test('resposta que não é do Tally e Tally desligado viram erro claro', async () => {
      resposta = '<html>oi</html>';
      await assert.rejects(() => acao('tally.empresas').run(ctx(), {}), /não parece do Tally/);
      await assert.rejects(() => transporteTally({ host: '127.0.0.1', porta: '1' })('/', { body: '' }), /não é a do Tally/);
      await assert.rejects(() => transporteTally({ host: '127.0.0.1', porta: '9' }, async () => ['127.0.0.1'])('/', { body: '' }), /não é a do Tally/);
    });
  });

  test('na nuvem: o cartão fica indisponível com o motivo, e conectar é recusado; a conexão não vai à nuvem', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const nuvem = new Integrations(h.db, h.bus, { ...h.cfg, mode: 'cloud' });
      const t = nuvem.list(s.workspaceId).find((i) => i.kind === 'tally')!;
      assert.equal(t.auth, 'soon'); assert.match(t.soon!, /Community local/);
      await assert.rejects(() => nuvem.connectToken(s.workspaceId, s.userId, 'tally', { host: '192.168.1.20' }), /na nuvem do Ergon/);
      // no computador (local), o cartão é o de conectar
      const local = h.integrations.list(s.workspaceId).find((i) => i.kind === 'tally')!;
      assert.equal(local.auth, 'token'); assert.deepEqual(local.fields.map((f) => f.name), ['host', 'porta', 'empresa']);
      assert.ok(INTEGRATIONS.find((i) => i.kind === 'tally')!.soLocal);
    } finally { await h.close(); }
  });
});

// ------------------------------------------------------------------------------- ponta a ponta pela ponte do motor
const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>(); n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) { const runId = `run_india${String(++this.n).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
describe('pela ponte: Zoho no data center da conta, Razorpay com "Liberar tudo"', () => {
  let h: Harness; let s: Session; let agente: string;
  before(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.integrations.secrets.write(s.workspaceId, 'zoho', { access_token: 'acesso-zoho-ponte', refresh_token: 'r', expires_at: Date.now() + 3600_000, account: 'priya@sharma.in (zoho.in)', dc: 'in' });
    setIntegration(h.db, s.workspaceId, 'zoho', { state: 'connected', account_label: 'priya@sharma.in (zoho.in)', connected_at: new Date().toISOString() });
    h.integrations.secrets.write(s.workspaceId, 'razorpay', { key_id: 'rzp_test_AbCdEf1234567', key_secret: 'segredo-razorpay-0123456789' });
    setIntegration(h.db, s.workspaceId, 'razorpay', { state: 'connected', account_label: 'Razorpay', connected_at: new Date().toISOString() });
  });
  after(async () => { h.conexoes.setLiberarTudo(s.workspaceId, s.userId, false); await h.close(); });
  async function sessao(texto: string) {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
  }
  const executar = async (sess: string, conexao: string, acao: string, parametros: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sess, conexao, acao, parametros }, { 'x-ergon-bridge-token': TOKEN })).json;

  test('o agente lê o Zoho CRM da Índia, com o link de cada lead', async () => {
    answer = () => ({ data: [{ id: '5843000000123', First_Name: 'Ravi', Last_Name: 'Kumar', Company: 'Kumar Exports' }] });
    const r = await executar(await sessao('Quais leads novos no Zoho?'), 'zoho', 'crm.listar', { modulo: 'leads' });
    assert.equal(r.status, 'feita', JSON.stringify(r));
    assert.equal(calls[0].url.origin, 'https://www.zohoapis.in'); assert.equal(calls[0].headers.Authorization, 'Zoho-oauthtoken acesso-zoho-ponte');
    assert.match(r.texto, /https:\/\/crm\.zoho\.in\/crm\/tab\/Leads\/5843000000123/);
    assert.ok(!JSON.stringify(r).includes('acesso-zoho-ponte'), 'o acesso nunca vai ao motor');
  });
  test('com "Liberar tudo": criar link e reembolsar esperam o cartão; ler vai direto; nada sai antes do clique', async () => {
    h.conexoes.setLiberarTudo(s.workspaceId, s.userId, true);
    const sess = await sessao('Reembolse o pagamento pay_1 e mande um link de ₹500 ao Ravi');
    answer = () => ({ entity: 'collection', count: 0, items: [] });
    assert.equal((await executar(sess, 'razorpay', 'razorpay.pagamentos', {})).status, 'feita');
    calls.length = 0;
    answer = () => ({ id: 'pay_1', amount: 100000, currency: 'INR', status: 'captured' });
    const re = await executar(sess, 'razorpay', 'razorpay.reembolsar', { pagamento: 'pay_1' });
    assert.equal(re.status, 'aguardando_confirmacao', JSON.stringify(re));
    const li = await executar(sess, 'razorpay', 'razorpay.criar_link', { valor: 500, descricao: 'Amostras' });
    assert.equal(li.status, 'aguardando_confirmacao', JSON.stringify(li));
    const pg = await executar(sess, 'zoho', 'books.registrar_pagamento', { cliente: '46', fatura: '9001', valor: 1000, data: '2026-11-22' });
    assert.equal(pg.status, 'aguardando_confirmacao', JSON.stringify(pg));
    assert.ok(!calls.some((c) => c.method === 'POST'), 'nada foi escrito antes do clique');
    const cartoes = h.db.all<{ summary: string }>("SELECT summary FROM agent_proposals WHERE kind = 'conexao' ORDER BY created_at DESC LIMIT 3").map((c) => c.summary).join('\n');
    assert.match(cartoes, /reembolso devolve dinheiro/); assert.match(cartoes, /criar link de pagamento no Razorpay sempre pede/); assert.match(cartoes, /registrar pagamento muda/);
  });
});
