// Zendesk, Freshdesk e Intercom (sem rede): método, endereço, cabeçalho e corpo exatos; risco de cada ação; erro e texto de terceiros.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { FRESHDESK } from '../src/services/conexoes/conectores/freshdesk.ts';
import { INTERCOM } from '../src/services/conexoes/conectores/intercom.ts';
import { ZENDESK } from '../src/services/conexoes/conectores/zendesk.ts';
import { acaoDe, conferirConector, httpDoConector, type ConectorDef } from '../src/services/conexoes/conectores/declarativo.ts';
import { ErroAcao, type Risco } from '../src/services/conexoes/tipos.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { harness, setupOwner } from './helpers.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const ACESSO = { access_token: 'acesso-temporario', token_type: 'bearer', scope: 'read write', expires_in: 1800 };
/** Pedidos de acesso temporário (Zendesk): ficam à parte, e `calls` continua contando só as chamadas à API. */
const trocas: Call[] = [];
let respostaDaTroca: (c: Call) => Response | unknown = () => ACESSO;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    const troca = c.url.pathname === '/oauth/tokens';
    (troca ? trocas : calls).push(c);
    const out = troca ? respostaDaTroca(c) : answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
afterEach(() => { calls.length = 0; trocas.length = 0; answer = () => ({}); respostaDaTroca = () => ACESSO; });

const contexto = (def: ConectorDef, creds: Record<string, string>) => ({ workspaceId: 'ws', tz: 'UTC', http: httpDoConector(def, creds), creds });
const acaoEm = (def: ConectorDef) => (id: string) => acaoDe(def.acoes.find((a) => a.id === id)!);
const riscoDe = (a: { risco: Risco | ((x: Record<string, unknown>) => Risco) }, args: Record<string, unknown> = {}): Risco => (typeof a.risco === 'function' ? a.risco(args) : a.risco);
const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
const recusaDeAcesso = (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden';

describe('as três definições', () => {
  for (const def of [ZENDESK, FRESHDESK, INTERCOM]) {
    test(`${def.kind}: grupo, nome, ajuda e riscos pedidos`, () => {
      assert.match(def.kind, /^[a-z]{3,20}$/);
      assert.equal(def.grupo, 'suporte');
      assert.ok(def.ajuda.url.startsWith('https://'));
      assert.ok(def.ajuda.passos.length > 80);
      assert.ok(def.campos.some((c) => c.secret), 'a credencial é campo secreto');
      assert.ok(def.acoes.every((a) => a.id.startsWith(`${def.kind}.`)), 'ações com o nome do conector');
      const r = (sufixo: string) => riscoDe(def.acoes.find((a) => a.id === `${def.kind}.${sufixo}`)!);
      assert.equal(r('buscar'), 'ler'); assert.equal(r('ler'), 'ler');
      assert.equal(r('responder'), 'enviar');
      // Zendesk: nota interna vai ao responsável e chamado novo vai aos atendentes, pelos gatilhos padrão
      const avisa = def.kind === 'zendesk' ? 'enviar' : 'organizar';
      assert.equal(r('nota'), avisa); assert.equal(r('criar'), avisa);
    });
  }
});

describe('Zendesk', () => {
  const creds = { subdominio: 'empresa', identificador: 'ergon', segredo: 'segredo-de-exemplo-com-40-caracteres-000' };
  const ctx = contexto(ZENDESK, creds);
  const acao = acaoEm(ZENDESK);

  test('campos e ajuda: cliente OAuth, com o passo a passo da tela do Zendesk', () => {
    assert.deepEqual(ZENDESK.campos.map((c) => c.name), ['subdominio', 'identificador', 'segredo']);
    assert.equal(ZENDESK.campos[2].secret, true);
    assert.ok(!ZENDESK.campos[1].secret, 'o identificador aparece na tela do Zendesk e não é segredo');
    for (const t of ['Admin Center', 'OAuth clients', 'Add OAuth client', 'Confidential', 'Identifier', 'Secret', 'Save', 'Scopes']) assert.ok(ZENDESK.ajuda.passos.includes(t), t);
    assert.match(ZENDESK.ajuda.passos, /em nome de quem criou/, 'a pessoa sabe em nome de quem os agentes respondem');
    assert.match(ZENDESK.ajuda.url, /^https:\/\/support\.zendesk\.com\//);
  });
  test('confere a conta trocando a credencial de aplicativo por um acesso temporário', async () => {
    const esta = { ...creds, identificador: 'ergon-conferir' };
    answer = () => ({ user: { id: 7, name: 'Ana', role: 'agent' } });
    assert.equal(await conferirConector(ZENDESK, esta), 'Ana');
    assert.equal(trocas[0].method, 'POST');
    assert.equal(trocas[0].url.href, 'https://empresa.zendesk.com/oauth/tokens');
    assert.deepEqual(trocas[0].body, { grant_type: 'client_credentials', client_id: 'ergon-conferir', client_secret: esta.segredo, scope: 'read write' });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.href, 'https://empresa.zendesk.com/api/v2/users/me');
    assert.equal(calls[0].headers.Authorization, 'Bearer acesso-temporario');
    await conferirConector(ZENDESK, esta);
    assert.equal(trocas.length, 1, 'o acesso temporário é reaproveitado enquanto vale');
  });
  test('acesso vencido antes da hora: pede outro uma vez e repete', async () => {
    const esta = { ...creds, identificador: 'ergon-vencido' };
    let vezes = 0;
    answer = () => (++vezes === 1 ? new Response('{"error":"invalid_token"}', { status: 401 }) : { user: { id: 7, name: 'Ana' } });
    assert.equal(await conferirConector(ZENDESK, esta), 'Ana');
    assert.equal(trocas.length, 2);
    assert.equal(calls.length, 2);
  });
  test('segredo errado ou escopo fora do permitido: recusa, sem repetir o segredo e sem chamar a API', async () => {
    const esta = { ...creds, identificador: 'ergon-errado' };
    respostaDaTroca = () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }), { status: 401 });
    await assert.rejects(() => conferirConector(ZENDESK, esta), (e: unknown) => recusaDeAcesso(e) && !(e as Error).message.includes(esta.segredo));
    assert.equal(calls.length, 0);
    respostaDaTroca = () => new Response(JSON.stringify({ error: 'invalid_scope', error_description: 'scope not allowed' }), { status: 400 });
    await assert.rejects(() => conferirConector(ZENDESK, esta), (e: unknown) => e instanceof ProviderError && /invalid_scope/.test(e.message));
    respostaDaTroca = () => ({ token_type: 'bearer' });
    await assert.rejects(() => conferirConector(ZENDESK, esta), recusaDeAcesso);
    assert.equal(calls.length, 0);
  });
  test('conexão antiga, com token de API: pede para conectar de novo, sem mandar nada ao Zendesk', async () => {
    const antiga = { subdominio: 'empresa', email: 'ana@empresa.com', token: 'tok-de-exemplo-com-40-caracteres-aqui-00' };
    const ve = (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && e.reauth && /conecte de novo/.test(e.message) && !e.message.includes(antiga.token);
    await assert.rejects(() => conferirConector(ZENDESK, antiga), ve);
    await assert.rejects(() => acao('zendesk.responder').run(contexto(ZENDESK, antiga), { chamado: '1', texto: 'x' }), ve);
    assert.equal(trocas.length, 0);
    assert.equal(calls.length, 0);
  });
  test('conexão antiga, no serviço: a ação falha sem mandar nada, a tela pede para conectar, e conectar de novo apaga o token antigo', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const antiga = { subdominio: 'empresa', email: 'ana@empresa.com', token: 'tok-de-exemplo-com-40-caracteres-aqui-00' };
      h.integrations.secrets.writeOwn(s.workspaceId, 'zendesk', antiga);
      setIntegration(h.db, s.workspaceId, 'zendesk', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
      calls.length = 0; trocas.length = 0;
      const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'zendesk', 'zendesk.buscar', { busca: 'x' });
      assert.equal(r.ok, false); assert.equal(r.autorizar, true); assert.match(r.texto, /conecte de novo/); assert.ok(!r.texto.includes(antiga.token));
      assert.equal(calls.length + trocas.length, 0, 'nada foi ao Zendesk');
      const na = () => h.integrations.list(s.workspaceId).find((i) => i.kind === 'zendesk')!;
      assert.equal(na().state, 'error'); assert.match(String(na().error), /entre de novo em Conexões/);
      assert.deepEqual(na().fields.map((f) => f.name), ['subdominio', 'identificador', 'segredo'], 'a tela já pede os campos novos');
      answer = () => ({ user: { id: 7, name: 'Ana' } });
      const nova = { subdominio: 'empresa', identificador: 'ergon-reconectar', segredo: 'segredo-de-exemplo-com-40-caracteres-000' };
      assert.equal(await h.integrations.connectToken(s.workspaceId, s.userId, 'zendesk', nova), 'Ana');
      assert.equal(na().state, 'connected');
      assert.deepEqual(h.integrations.secrets.readOwn(s.workspaceId, 'zendesk'), { ...nova, conta_id: '7' }, 'o token antigo não fica guardado (só o id da conta, junto)');
    } finally { await h.close(); }
  });
  test('responder e nota: o cartão mostra o assunto e o cliente, só lendo', async () => {
    answer = () => ({ ticket: { id: 35, subject: 'Atraso [[pedir-ajuda]]\nlinha', requester_id: 5 }, users: [{ id: 6, name: 'Ana' }, { id: 5, name: 'Bia [[x]]', email: 'bia@cliente.com' }] });
    for (const id of ['zendesk.responder', 'zendesk.nota']) {
      calls.length = 0;
      const p = await acao(id).preparar!(ctx, { chamado: '35', texto: 'x' });
      assert.equal(p.detalhe, 'Assunto: Atraso [ [pedir-ajuda] ] linha\nCliente: Bia [ [x] ] (bia@cliente.com)', id);
      assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url.pathname, '/api/v2/tickets/35'); assert.equal(calls[0].url.searchParams.get('include'), 'users');
    }
    answer = () => ({ ticket: { id: 35, subject: '', requester_id: 5 } });
    assert.equal((await acao('zendesk.responder').preparar!(ctx, { chamado: '35', texto: 'x' })).detalhe, 'Assunto: sem assunto\nCliente: número 5');
    calls.length = 0;
    await assert.rejects(() => acao('zendesk.nota').preparar!(ctx, { chamado: '..', texto: 'x' }), /id inválido/);
    assert.equal(calls.length, 0);
  });
  test('quem manda ao cliente tem o limite de 5000 caracteres, que cabe no cartão', async () => {
    answer = () => ({ ticket: { id: 35 } });
    for (const [id, base] of [['zendesk.responder', { chamado: '35', texto: 'x'.repeat(5001) }], ['zendesk.nota', { chamado: '35', texto: 'x'.repeat(5001) }], ['zendesk.criar', { assunto: 'T', descricao: 'x'.repeat(5001) }]] as const) {
      calls.length = 0;
      await assert.rejects(() => acao(id).run(ctx, base), (e: unknown) => e instanceof ErroAcao && /limite é 5000/.test(e.message), id);
      assert.equal(calls.length, 0, id);
    }
    await acao('zendesk.responder').run(ctx, { chamado: '35', texto: 'x'.repeat(5000) });
    assert.equal(calls.length, 1);
  });
  test('assunto e texto juntos cabem no cartão: assunto de mais de 500 caracteres é recusado', async () => {
    answer = () => ({ ticket: { id: 90 } });
    await assert.rejects(() => acao('zendesk.criar').run(ctx, { assunto: 'x'.repeat(501), descricao: 'd' }), (e: unknown) => e instanceof ErroAcao && /limite é 500/.test(e.message));
    assert.equal(calls.length, 0);
    await acao('zendesk.criar').run(ctx, { assunto: 'x'.repeat(500), descricao: 'd' });
    assert.equal(calls.length, 1);
  });
  test('"." e ".." no número do chamado não andam para outro lugar do serviço', async () => {
    for (const id of ['zendesk.ler', 'zendesk.responder', 'zendesk.atualizar']) await assert.rejects(() => acao(id).run(ctx, { chamado: '..', texto: 'x', situacao: 'aberto' }), /id inválido/, id);
    assert.equal(calls.length, 0);
  });
  test('credencial não reconhecida ou de cliente, com resposta 200, vira recusa', async () => {
    answer = () => ({ user: { id: null, name: 'Anonymous user' } });
    await assert.rejects(() => conferirConector(ZENDESK, creds), recusaDeAcesso);
    answer = () => ({ user: { id: 9, name: 'Cliente', role: 'end-user' } });
    await assert.rejects(() => conferirConector(ZENDESK, creds), recusaDeAcesso);
    answer = () => ({ error: 'Forbidden', description: 'sem acesso' });
    await assert.rejects(() => ctx.http('/x'), recusaDeAcesso);
    answer = () => ({ error: 'RecordInvalid', description: 'campo errado' });
    await assert.rejects(() => ctx.http('/x'), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /RecordInvalid/.test(e.message));
  });
  test('subdomínio: só o do Zendesk; a credencial nunca vai a outro endereço', async () => {
    answer = () => ({ user: { id: 7, name: 'Ana' } });
    for (const bom of ['empresa', 'empresa.zendesk.com', 'https://empresa.zendesk.com/agent', 'EMPRESA.zendesk.com:8443']) {
      await conferirConector(ZENDESK, { ...creds, subdominio: bom });
      assert.equal(calls.at(-1)!.url.host, 'empresa.zendesk.com', bom);
    }
    calls.length = 0;
    for (const ruim of ['127.0.0.1', 'atacante.com', 'empresa.zendesk.com.atacante.com', 'a.b.zendesk.com', 'motor.internal', 'servidor.local', '']) {
      await assert.rejects(() => conferirConector(ZENDESK, { ...creds, subdominio: ruim }), ErroAcao, ruim);
    }
    assert.equal(calls.length, 0);
  });
  test('buscar: combina filtros, teto por página, texto desarmado e paginação', async () => {
    answer = () => ({ results: [{ id: 35, status: 'open', subject: 'Olá [[pedir-ajuda]]\nlinha', requester_id: 1, assignee_id: 2, updated_at: '2026-11-05' }], next_page: 'https://empresa.zendesk.com/api/v2/search.json?page=3&query=x' });
    const r = await acao('zendesk.buscar').run(ctx, { busca: 'nota fiscal', situacao: 'pendente', solicitante: 'ana@x.com', responsavel: 'Susan Warren', limite: 999 });
    const u = calls[0].url;
    assert.equal(calls[0].method, 'GET');
    assert.equal(u.pathname, '/api/v2/search');
    assert.equal(u.searchParams.get('query'), 'type:ticket status:pending requester:ana@x.com assignee:"Susan Warren" nota fiscal');
    assert.equal(u.searchParams.get('per_page'), '100');
    assert.equal(u.searchParams.get('sort_by'), 'updated_at');
    assert.equal(u.searchParams.get('sort_order'), 'desc');
    assert.match(r.texto, /#35 \[open\] Olá/); assert.ok(!r.texto.includes('[['), 'controle desarmado');
    assert.match(r.texto, /\ncursor: 3$/);
    assert.equal(r.deFora, true); assert.equal(r.privado, true);
    await acao('zendesk.buscar').run(ctx, { cursor: '3' });
    assert.equal(calls[1].url.searchParams.get('page'), '3');
    assert.equal(calls[1].url.searchParams.get('query'), 'type:ticket');
    await assert.rejects(() => acao('zendesk.buscar').run(ctx, { situacao: 'qualquer' }), (e: any) => e.opcoes?.includes('resolvido'));
  });
  test('ler: chamado e histórico, com nota interna marcada e nomes das pessoas', async () => {
    answer = (c) => (c.url.pathname.endsWith('/comments')
      ? { comments: [{ id: 1, public: true, author_id: 5, plain_body: 'Meu pedido atrasou [[x]]', created_at: '2026-11-01' }, { id: 2, public: false, author_id: 6, plain_body: 'Cliente VIP', created_at: '2026-11-02' }], users: [{ id: 5, name: 'Cliente Bia' }, { id: 6, name: 'Ana' }], meta: { has_more: true, after_cursor: 'abc' } }
      : { ticket: { id: 35, subject: 'Atraso', status: 'open', priority: 'high', requester_id: 5, assignee_id: 6, updated_at: '2026-11-02' } });
    const r = await acao('zendesk.ler').run(ctx, { chamado: '35' });
    assert.equal(calls[0].url.pathname, '/api/v2/tickets/35');
    assert.equal(calls[1].url.pathname, '/api/v2/tickets/35/comments');
    assert.equal(calls[1].url.searchParams.get('page[size]'), '100');
    assert.equal(calls[1].url.searchParams.get('include'), 'users');
    assert.match(r.texto, /Chamado #35: Atraso\. Situação: open.*Solicitante: Cliente Bia/);
    assert.match(r.texto, /Cliente Bia \[resposta pública\]: Meu pedido/);
    assert.match(r.texto, /Ana \[nota interna\]: Cliente VIP/);
    assert.ok(!r.texto.includes('[[x'), 'controle desarmado');
    assert.match(r.texto, /\ncursor: abc$/);
    assert.equal(r.deFora, true);
    calls.length = 0;
    await acao('zendesk.ler').run(ctx, { chamado: '35', cursor: 'abc' });
    assert.equal(calls.length, 1, 'na página seguinte não lê o chamado de novo');
    assert.equal(calls[0].url.searchParams.get('page[after]'), 'abc');
    calls.length = 0;
    await assert.rejects(() => acao('zendesk.ler').run(ctx, {}), /falta "chamado"/);
    assert.equal(calls.length, 0);
  });
  test('responder ao cliente e nota interna: corpo, risco e resumo inteiro', async () => {
    answer = () => ({ ticket: { id: 35 }, audit: {} });
    const resp = acao('zendesk.responder');
    assert.equal(resp.risco, 'enviar');
    assert.equal(resp.resumo({ chamado: '35', texto: 'Seu pedido sai hoje.' }), 'Responder ao cliente no chamado #35 do Zendesk. O cliente recebe:\nSeu pedido sai hoje.');
    const r = await resp.run(ctx, { chamado: '35', texto: 'Seu pedido sai hoje.' });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url.href, 'https://empresa.zendesk.com/api/v2/tickets/35');
    assert.deepEqual(calls[0].body, { ticket: { comment: { body: 'Seu pedido sai hoje.', public: true } } });
    assert.equal(r.texto, 'Resposta enviada no chamado #35.');
    assert.equal(r.deFora, undefined);
    const nota = acao('zendesk.nota');
    assert.equal(nota.risco, 'enviar', 'o gatilho padrão manda a nota ao responsável');
    await nota.run(ctx, { chamado: '35', texto: 'Cliente VIP' });
    assert.deepEqual(calls[1].body, { ticket: { comment: { body: 'Cliente VIP', public: false } } });
    assert.match(nota.resumo({ chamado: '35', texto: 'Cliente VIP' }), /o cliente não vê; o responsável pelo chamado recebe por e-mail\):\nCliente VIP/);
  });
  test('atualizar: situação e responsável por número ou e-mail', async () => {
    const a = acao('zendesk.atualizar');
    // gatilhos padrão: quem recebe o chamado, o grupo que recebe, e o responsável quando o chamado sai de "resolvido", ganham e-mail
    for (const x of [{ responsavel: '42' }, { responsavel: 'bia@empresa.com' }, { grupo: '8' }, { situacao: 'aberto' }, { situacao: 'pendente' }, { situacao: 'em_espera' }]) assert.equal(riscoDe(a, x), 'enviar', JSON.stringify(x));
    for (const x of [{ prioridade: 'alta' }, { situacao: 'resolvido' }, { situacao: 'resolvido', prioridade: 'baixa' }]) assert.equal(riscoDe(a, x), 'organizar', JSON.stringify(x));
    assert.match(a.resumo({ chamado: '35', responsavel: '42' }), /pode avisar a equipe/);
    assert.ok(!a.resumo({ chamado: '35', prioridade: 'alta' }).includes('avisar'));
    await a.run(ctx, { chamado: '35', situacao: 'resolvido', responsavel: '42', grupo: '8', prioridade: 'urgente' });
    assert.equal(calls[0].method, 'PUT');
    assert.deepEqual(calls[0].body, { ticket: { status: 'solved', priority: 'urgent', assignee_id: 42, group_id: 8 } });
    await a.run(ctx, { chamado: '35', responsavel: 'bia@empresa.com' });
    assert.deepEqual(calls[1].body, { ticket: { assignee_email: 'bia@empresa.com' } });
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { chamado: '35' }), /diga o que mudar/);
    await assert.rejects(() => a.run(ctx, { chamado: '35', responsavel: 'Bia' }), /responsavel/);
    await assert.rejects(() => a.run(ctx, { chamado: '35', situacao: 'fechado' }), (e: any) => !e.opcoes?.includes('fechado'));
    assert.equal(calls.length, 0, 'recusa sem chamar');
    assert.match(a.resumo({ chamado: '35', situacao: 'resolvido', responsavel: '42' }), /#35.*situação para resolvido; responsável para 42/);
  });
  test('criar: sempre envia, porque o gatilho padrão avisa os atendentes; em nome de um cliente, avisa também ele', async () => {
    answer = () => ({ ticket: { id: 90 } });
    const a = acao('zendesk.criar');
    const proprio = { assunto: 'Impressora', descricao: 'Parou' };
    assert.equal(riscoDe(a, proprio), 'enviar');
    assert.equal(a.resumo(proprio), 'Criar um chamado no Zendesk. O Zendesk pode avisar os atendentes por e-mail.\nAssunto: Impressora\nParou');
    const r = await a.run(ctx, proprio);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.href, 'https://empresa.zendesk.com/api/v2/tickets');
    assert.deepEqual(calls[0].body, { ticket: { subject: 'Impressora', comment: { body: 'Parou' } } });
    assert.equal(r.texto, 'Chamado criado: #90.');
    const cliente = { assunto: 'Pedido', descricao: 'Atrasou', solicitante: 'bia@cliente.com', nome_solicitante: 'Bia', prioridade: 'alta', responsavel: 'ana@empresa.com' };
    assert.equal(riscoDe(a, cliente), 'enviar');
    assert.equal(a.resumo(cliente), 'Criar um chamado no Zendesk em nome de bia@cliente.com. O Zendesk avisa essa pessoa por e-mail e pode avisar os atendentes.\nAssunto: Pedido\nAtrasou');
    await a.run(ctx, cliente);
    assert.deepEqual(calls[1].body, { ticket: { subject: 'Pedido', comment: { body: 'Atrasou' }, priority: 'high', requester: { email: 'bia@cliente.com', name: 'Bia' }, assignee_email: 'ana@empresa.com' } });
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { ...proprio, solicitante: 'não é e-mail' }), /e-mail válido/);
    await assert.rejects(() => a.run(ctx, { ...proprio, solicitante: 'bia@cliente.com, outro@cliente.com' }), /único e-mail/);
    assert.equal(calls.length, 0);
  });
  test('resposta 403 vira recusa de acesso', async () => {
    answer = () => new Response(JSON.stringify({ error: 'Forbidden', description: 'You do not have access' }), { status: 403 });
    await assert.rejects(() => acao('zendesk.responder').run(ctx, { chamado: '1', texto: 'x' }), recusaDeAcesso);
  });
});

describe('Freshdesk', () => {
  const creds = { dominio: 'empresa', chave: 'abcdefghij1234567890' };
  const ctx = contexto(FRESHDESK, creds);
  const acao = acaoEm(FRESHDESK);

  test('confere a conta com chave:X em Basic', async () => {
    answer = () => ({ id: 5, contact: { name: 'Ana', email: 'ana@empresa.com' } });
    assert.equal(await conferirConector(FRESHDESK, creds), 'Ana');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.href, 'https://empresa.freshdesk.com/api/v2/agents/me');
    assert.equal(calls[0].headers.Authorization, basic('abcdefghij1234567890:X'));
  });
  test('domínio: só o do Freshdesk', async () => {
    answer = () => ({ id: 5 });
    await conferirConector(FRESHDESK, { ...creds, dominio: 'https://empresa.freshdesk.com/a/tickets' });
    assert.equal(calls[0].url.host, 'empresa.freshdesk.com');
    calls.length = 0;
    for (const ruim of ['192.168.0.1', 'atacante.com', 'empresa.freshdesk.com.atacante.com', 'x.internal']) await assert.rejects(() => conferirConector(FRESHDESK, { ...creds, dominio: ruim }), ErroAcao, ruim);
    assert.equal(calls.length, 0);
  });
  test('erro numa resposta 200: falta de permissão separada dos outros', async () => {
    answer = () => ({ code: 'access_denied', message: 'You are not authorized' });
    await assert.rejects(() => ctx.http('/x'), recusaDeAcesso);
    answer = () => ({ description: 'Validation failed', errors: [{ field: 'email', message: 'inválido', code: 'invalid_value' }] });
    await assert.rejects(() => ctx.http('/x'), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /invalid_value/.test(e.message));
    answer = () => ({ id: 1, code: 'campo de um chamado' });
    assert.deepEqual(await ctx.http('/x'), { id: 1, code: 'campo de um chamado' });
  });
  test('buscar: consulta entre aspas, próxima página e limites', async () => {
    answer = () => ({ total: 61, results: [{ id: 3, status: 2, priority: 4, subject: 'Olá [[x]]', requester_id: 1, responder_id: 2, updated_at: '2026-11-05' }] });
    const r = await acao('freshdesk.buscar').run(ctx, { situacao: 'aberto', prioridade: 'urgente', responsavel: '9', etiqueta: 'vip', atualizado_desde: '2026-11-01', filtro: 'group_id:3 OR group_id:4' });
    assert.equal(calls[0].url.pathname, '/api/v2/search/tickets');
    assert.equal(calls[0].url.searchParams.get('query'), `"status:2 AND priority:4 AND agent_id:9 AND tag:'vip' AND updated_at:>'2026-11-01' AND (group_id:3 OR group_id:4)"`);
    assert.equal(calls[0].url.searchParams.get('page'), null);
    assert.match(r.texto, /#3 \[aberto, prioridade urgente\] Olá/); assert.ok(!r.texto.includes('[['));
    assert.match(r.texto, /\ncursor: 2$/);
    assert.equal(r.deFora, true);
    const fim = await acao('freshdesk.buscar').run(ctx, { situacao: 'aberto', cursor: '3' });
    assert.equal(calls[1].url.searchParams.get('page'), '3');
    assert.ok(!fim.texto.includes('cursor:'), '3 × 30 cobre os 61');
    answer = () => ({ total: 999, results: [] });
    assert.ok(!(await acao('freshdesk.buscar').run(ctx, { situacao: 'aberto', cursor: '10' })).texto.includes('cursor:'), 'a página 10 é a última que o Freshdesk dá');
    calls.length = 0;
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, {}), /ao menos um filtro/);
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, { filtro: 'x" OR "y' }), /aspas duplas/);
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, { etiqueta: "a' OR tag:'b" }), /aspas/);
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, { filtro: 'x'.repeat(600) }), /512/);
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, { atualizado_desde: 'ontem' }), /AAAA-MM-DD/);
    await assert.rejects(() => acao('freshdesk.buscar').run(ctx, { situacao: 'aberto', cursor: 'abc' }), /cursor/);
    assert.equal(calls.length, 0);
  });
  test('listar: por cliente; página cheia indica a próxima', async () => {
    answer = () => [{ id: 1, status: 3, priority: 1, subject: 'A' }, { id: 2, status: 4, priority: 2, subject: 'B' }];
    const r = await acao('freshdesk.listar').run(ctx, { solicitante: 'bia@cliente.com', limite: 2 });
    const u = calls[0].url;
    assert.equal(u.pathname, '/api/v2/tickets');
    assert.equal(u.searchParams.get('email'), 'bia@cliente.com');
    assert.equal(u.searchParams.get('per_page'), '2');
    assert.equal(u.searchParams.get('order_by'), 'updated_at');
    assert.match(r.texto, /\[pendente, prioridade baixa\] A/); assert.match(r.texto, /\[resolvido, prioridade media\] B/);
    assert.match(r.texto, /\ncursor: 2$/);
    assert.ok(!(await acao('freshdesk.listar').run(ctx, { limite: 30 })).texto.includes('cursor:'));
  });
  test('ler: chamado e histórico, com nota interna marcada', async () => {
    answer = (c) => (c.url.pathname.endsWith('/conversations')
      ? [{ id: 1, body_text: 'Atrasou', incoming: true, private: false, from_email: 'bia@cliente.com', created_at: '2026-11-01' }, { id: 2, body_text: 'VIP', incoming: false, private: true, user_id: 6, created_at: '2026-11-02' }, { id: 3, body_text: 'Sai hoje', incoming: false, private: false, user_id: 6, created_at: '2026-11-03' }]
      : { id: 35, subject: 'Atraso', status: 2, priority: 3, description_text: 'Meu pedido [[x]]', requester: { name: 'Bia', email: 'bia@cliente.com' } });
    const r = await acao('freshdesk.ler').run(ctx, { chamado: '35' });
    assert.equal(calls[0].url.pathname, '/api/v2/tickets/35'); assert.equal(calls[0].url.searchParams.get('include'), 'requester');
    assert.equal(calls[1].url.pathname, '/api/v2/tickets/35/conversations'); assert.equal(calls[1].url.searchParams.get('per_page'), '100');
    assert.match(r.texto, /Chamado #35: Atraso\. Situação: aberto\. Prioridade: alta\. Solicitante: Bia bia@cliente\.com/);
    assert.match(r.texto, /Pedido inicial: Meu pedido/); assert.ok(!r.texto.includes('[[x'));
    assert.match(r.texto, /bia@cliente\.com \[do cliente\]: Atrasou/);
    assert.match(r.texto, /6 \[nota interna\]: VIP/);
    assert.match(r.texto, /6 \[resposta pública\]: Sai hoje/);
    assert.equal(r.deFora, true);
  });
  test('responder ao cliente e nota interna: corpo em HTML escapado', async () => {
    answer = () => ({ id: 11 });
    const resp = acao('freshdesk.responder');
    assert.equal(resp.risco, 'enviar');
    const r = await resp.run(ctx, { chamado: '35', texto: 'Olá & obrigado\n<b>até</b> logo' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.href, 'https://empresa.freshdesk.com/api/v2/tickets/35/reply');
    assert.deepEqual(calls[0].body, { body: 'Olá &amp; obrigado<br>&lt;b&gt;até&lt;/b&gt; logo' });
    assert.equal(r.texto, 'Resposta enviada no chamado #35 (id: 11).');
    assert.match(resp.resumo({ chamado: '35', texto: 'Oi' }), /O cliente recebe:\nOi$/);
    const nota = acao('freshdesk.nota');
    assert.equal(nota.risco, 'organizar');
    await nota.run(ctx, { chamado: '35', texto: 'VIP' });
    assert.equal(calls[1].url.pathname, '/api/v2/tickets/35/notes');
    assert.deepEqual(calls[1].body, { body: 'VIP', private: true });
  });
  test('atualizar: resolver ou fechar pode avisar o cliente, e mudar responsável ou grupo pode avisar quem recebe; os outros organizam', async () => {
    const a = acao('freshdesk.atualizar');
    assert.equal(riscoDe(a, { situacao: 'pendente' }), 'organizar');
    assert.equal(riscoDe(a, { prioridade: 'alta' }), 'organizar');
    assert.equal(riscoDe(a, { responsavel: '9' }), 'enviar');
    assert.equal(riscoDe(a, { grupo: '3' }), 'enviar');
    assert.match(a.resumo({ chamado: '35', responsavel: '9' }), /pode avisar por e-mail o responsável ou o grupo/);
    assert.equal(riscoDe(a, { situacao: 'resolvido' }), 'enviar');
    assert.equal(riscoDe(a, { situacao: 'fechado' }), 'enviar');
    assert.match(a.resumo({ chamado: '35', situacao: 'resolvido' }), /pode avisar o cliente por e-mail/);
    assert.ok(!a.resumo({ chamado: '35', situacao: 'pendente' }).includes('avisar'));
    await a.run(ctx, { chamado: '35', situacao: 'pendente', prioridade: 'alta', responsavel: '9', grupo: '3' });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url.href, 'https://empresa.freshdesk.com/api/v2/tickets/35');
    assert.deepEqual(calls[0].body, { status: 3, priority: 3, responder_id: 9, group_id: 3 });
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { chamado: '35' }), /diga o que mudar/);
    await assert.rejects(() => a.run(ctx, { chamado: '35', responsavel: 'Bia' }), /número/);
    assert.equal(calls.length, 0);
  });
  test('criar: em seu nome organiza e usa o seu e-mail; em nome de um cliente envia', async () => {
    answer = (c) => (c.method === 'GET' ? { id: 5, contact: { email: 'ana@empresa.com' } } : { id: 70 });
    const a = acao('freshdesk.criar');
    const proprio = { assunto: 'Impressora', descricao: 'Parou\nde vez' };
    assert.equal(riscoDe(a, proprio), 'organizar');
    const r = await a.run(ctx, proprio);
    assert.equal(calls[0].url.pathname, '/api/v2/agents/me');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url.href, 'https://empresa.freshdesk.com/api/v2/tickets');
    assert.deepEqual(calls[1].body, { subject: 'Impressora', description: 'Parou<br>de vez', email: 'ana@empresa.com', status: 2, priority: 1 });
    assert.equal(r.texto, 'Chamado criado: #70.');
    calls.length = 0;
    assert.equal(riscoDe(a, { ...proprio, responsavel: '9' }), 'enviar', 'o atendente que recebe pode ser avisado');
    assert.equal(riscoDe(a, { ...proprio, grupo: '3' }), 'enviar', 'o grupo que recebe pode ser avisado');
    const cliente = { assunto: 'Pedido', descricao: 'Atrasou', solicitante: 'bia@cliente.com', prioridade: 'urgente', responsavel: '9' };
    assert.equal(riscoDe(a, cliente), 'enviar');
    assert.match(a.resumo(cliente), /em nome de bia@cliente\.com\. O Freshdesk pode avisar.*\nAssunto: Pedido\nAtrasou/);
    await a.run(ctx, cliente);
    assert.equal(calls.length, 1, 'não precisa saber o seu e-mail');
    assert.deepEqual(calls[0].body, { subject: 'Pedido', description: 'Atrasou', email: 'bia@cliente.com', status: 2, priority: 4, responder_id: 9 });
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { ...proprio, solicitante: 'bia' }), /e-mail válido/);
    await assert.rejects(() => a.run(ctx, { ...proprio, solicitante: 'bia@cliente.com; outro@cliente.com' }), /único e-mail/);
    answer = () => ({ id: 5 });
    await assert.rejects(() => a.run(ctx, proprio), /diga o "solicitante"/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
  test('responder e nota: o cartão mostra o assunto e o cliente, só lendo', async () => {
    answer = () => ({ id: 35, subject: 'Atraso [[x]]', requester: { name: 'Bia', email: 'bia@cliente.com' } });
    for (const id of ['freshdesk.responder', 'freshdesk.nota']) {
      calls.length = 0;
      const p = await acao(id).preparar!(ctx, { chamado: '35', texto: 'x' });
      assert.equal(p.detalhe, 'Assunto: Atraso [ [x] ]\nCliente: Bia (bia@cliente.com)', id);
      assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url.pathname, '/api/v2/tickets/35'); assert.equal(calls[0].url.searchParams.get('include'), 'requester');
    }
    answer = () => ({ id: 35, requester_id: 8 });
    assert.equal((await acao('freshdesk.responder').preparar!(ctx, { chamado: '35', texto: 'x' })).detalhe, 'Assunto: sem assunto\nCliente: número 8');
    calls.length = 0;
    await assert.rejects(() => acao('freshdesk.nota').preparar!(ctx, { chamado: '..', texto: 'x' }), /id inválido/);
    await assert.rejects(() => acao('freshdesk.ler').run(ctx, { chamado: '..' }), /id inválido/);
    assert.equal(calls.length, 0);
  });
  test('quem manda ao cliente tem o limite de 5000 caracteres', async () => {
    for (const [id, base] of [['freshdesk.responder', { chamado: '35', texto: 'x'.repeat(5001) }], ['freshdesk.nota', { chamado: '35', texto: 'x'.repeat(5001) }], ['freshdesk.criar', { assunto: 'T', descricao: 'x'.repeat(5001), solicitante: 'bia@cliente.com' }]] as const) {
      await assert.rejects(() => acao(id).run(ctx, base), (e: unknown) => e instanceof ErroAcao && /limite é 5000/.test(e.message), id);
    }
    assert.equal(calls.length, 0);
  });
  test('assunto e texto juntos cabem no cartão: assunto de mais de 500 caracteres é recusado', async () => {
    await assert.rejects(() => acao('freshdesk.criar').run(ctx, { assunto: 'x'.repeat(501), descricao: 'd', solicitante: 'bia@cliente.com' }), (e: unknown) => e instanceof ErroAcao && /limite é 500/.test(e.message));
    assert.equal(calls.length, 0);
    answer = () => ({ id: 70 });
    await acao('freshdesk.criar').run(ctx, { assunto: 'x'.repeat(500), descricao: 'd', solicitante: 'bia@cliente.com' });
    assert.equal(calls.length, 1);
  });
  test('as listas declaram o cursor uma vez só, e ele continua de onde parou', async () => {
    for (const id of ['freshdesk.buscar', 'freshdesk.listar', 'freshdesk.ler', 'freshdesk.atendentes']) assert.ok('cursor' in acao(id).params, id);
    answer = () => [{ id: 1, status: 2, priority: 1, subject: 'A' }];
    const r = await acao('freshdesk.listar').run(ctx, { limite: 1, cursor: 2 });
    assert.equal(calls[0].url.searchParams.get('page'), '2');
    assert.equal(calls[0].url.searchParams.getAll('page').length, 1);
    assert.match(r.texto, /^- #1 \[aberto/);
    assert.match(r.texto, /\ncursor: 3$/);
    answer = () => [];
    assert.equal((await acao('freshdesk.listar').run(ctx, {})).texto, 'nada encontrado');
  });
  test('atendentes: número de cada um e próxima página', async () => {
    answer = () => [{ id: 9, contact: { name: 'Ana', email: 'ana@empresa.com' } }];
    const r = await acao('freshdesk.atendentes').run(ctx, { limite: 1, cursor: '2' });
    assert.equal(calls[0].url.pathname, '/api/v2/agents');
    assert.equal(calls[0].url.searchParams.get('per_page'), '1');
    assert.equal(calls[0].url.searchParams.get('page'), '2');
    assert.match(r.texto, /Ana ana@empresa\.com \(número: 9\)\ncursor: 3$/);
    calls.length = 0;
    await assert.rejects(() => acao('freshdesk.atendentes').run(ctx, { cursor: 'abc' }), /cursor/);
    await assert.rejects(() => acao('freshdesk.listar').run(ctx, { cursor: 'abc' }), /cursor/);
    await assert.rejects(() => acao('freshdesk.ler').run(ctx, { chamado: '1', cursor: 'abc' }), /cursor/);
    assert.equal(calls.length, 0, 'cursor errado é recusado sem chamar');
  });
});

describe('Intercom', () => {
  const creds = { token: 'dG9rOmV4ZW1wbG8tZGUtdG9rZW4', regiao: 'us' };
  const ctx = contexto(INTERCOM, creds);
  const acao = acaoEm(INTERCOM);
  /** responde /me e depois o que a ação pedir */
  const comMe = (depois: (c: Call) => unknown = () => ({ type: 'conversation', id: '12' })) => { answer = (c) => (c.url.pathname === '/me' ? { type: 'admin', id: '3156780', name: 'Ana' } : depois(c)); };

  test('confere a conta com Bearer e a versão fixa', async () => {
    answer = () => ({ type: 'admin', id: '1', name: 'Ana', app: { name: 'Loja' } });
    assert.equal(await conferirConector(INTERCOM, creds), 'Ana (Loja)');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.href, 'https://api.intercom.io/me');
    assert.equal(calls[0].headers.Authorization, 'Bearer dG9rOmV4ZW1wbG8tZGUtdG9rZW4');
    assert.equal(calls[0].headers['Intercom-Version'], '2.16');
  });
  test('região: só as três do Intercom', async () => {
    answer = () => ({ id: '1', name: 'Ana' });
    await conferirConector(INTERCOM, { ...creds, regiao: 'EU' });
    assert.equal(calls[0].url.host, 'api.eu.intercom.io');
    await conferirConector(INTERCOM, { ...creds, regiao: 'au' });
    assert.equal(calls[1].url.host, 'api.au.intercom.io');
    calls.length = 0;
    await assert.rejects(() => conferirConector(INTERCOM, { ...creds, regiao: 'atacante.com' }), /região inválida/);
    assert.equal(calls.length, 0);
    assert.ok(INTERCOM.campos.find((c) => c.name === 'regiao')!.pattern!.test('us'));
    assert.ok(!INTERCOM.campos.find((c) => c.name === 'regiao')!.pattern!.test('br'));
  });
  test('região em branco é a dos Estados Unidos: o campo é opcional, e a conexão aceita sem ele', async () => {
    assert.equal(INTERCOM.campos.find((c) => c.name === 'regiao')!.opcional, true);
    assert.ok(!INTERCOM.campos.find((c) => c.name === 'token')!.opcional, 'o token continua obrigatório');
    answer = () => ({ id: '1', name: 'Ana' });
    for (const sem of [{ token: creds.token }, { token: creds.token, regiao: '' }, { token: creds.token, regiao: '  ' }] as Array<Record<string, string>>) {
      await conferirConector(INTERCOM, sem);
      assert.equal(calls.at(-1)!.url.host, 'api.intercom.io', JSON.stringify(sem.regiao));
    }
    const h = await harness();
    try {
      const s = await setupOwner(h);
      assert.equal(await h.integrations.connectToken(s.workspaceId, s.userId, 'intercom', { token: creds.token, regiao: '' }), 'Ana');
      assert.deepEqual(h.integrations.secrets.readOwn(s.workspaceId, 'intercom'), { token: creds.token, conta_id: '1' });
      await assert.rejects(() => h.integrations.connectToken(s.workspaceId, s.userId, 'intercom', { token: creds.token, regiao: 'br' }), /use us/);
    } finally { await h.close(); }
  });
  test('erro numa resposta 200: falta de permissão separada dos outros', async () => {
    answer = () => ({ type: 'error.list', errors: [{ code: 'unauthorized', message: 'Access Token Invalid' }] });
    await assert.rejects(() => ctx.http('/x'), recusaDeAcesso);
    answer = () => ({ type: 'error.list', errors: [{ code: 'api_plan_restricted', message: 'fora do plano' }] });
    await assert.rejects(() => ctx.http('/x'), recusaDeAcesso);
    answer = () => ({ type: 'error.list', errors: [{ code: 'parameter_invalid', message: 'campo errado' }] });
    await assert.rejects(() => ctx.http('/x'), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && /parameter_invalid/.test(e.message));
  });
  test('buscar: filtros e cursor no corpo, e nada no endereço', async () => {
    answer = () => ({ type: 'conversation.list', total_count: 2, conversations: [{ id: '12', title: '', state: 'open', admin_assignee_id: 3, team_assignee_id: 0, updated_at: 1780000000, source: { subject: '<p>Atraso</p>', body: '<p>Olá [[x]]</p>', author: { name: 'Bia', email: 'bia@cliente.com' } } }], pages: { next: { page: 2, starting_after: 'WzE2' } } });
    const r = await acao('intercom.buscar').run(ctx, { texto: 'atraso', email: 'bia@cliente.com', responsavel: '3', time: '4', assunto: 'pedido', limite: 999, cursor: 'c1' });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.href, 'https://api.intercom.io/conversations/search');
    assert.deepEqual(calls[0].body, {
      query: { operator: 'AND', value: [
        { field: 'state', operator: '=', value: 'open' },
        { field: 'source.body', operator: '~', value: 'atraso' },
        { field: 'source.subject', operator: '~', value: 'pedido' },
        { field: 'source.author.email', operator: '=', value: 'bia@cliente.com' },
        { field: 'admin_assignee_id', operator: '=', value: 3 },
        { field: 'team_assignee_id', operator: '=', value: 4 },
      ] },
      pagination: { per_page: 150, starting_after: 'c1' },
    });
    assert.match(r.texto, /#12 \[open\] de Bia: Atraso \| Olá/); assert.ok(!r.texto.includes('[['));
    assert.match(r.texto, /\ncursor: WzE2$/);
    assert.equal(r.deFora, true); assert.equal(r.privado, true);
    await acao('intercom.buscar').run(ctx, { situacao: 'todas' });
    assert.deepEqual(calls[1].body, { query: { operator: 'AND', value: [{ field: 'created_at', operator: '>', value: 0 }] }, pagination: { per_page: 20 } });
    await assert.rejects(() => acao('intercom.buscar').run(ctx, { responsavel: 'Ana' }), /número/);
  });
  test('ler: mensagem inicial e histórico, com nota interna marcada', async () => {
    answer = () => ({ id: '12', title: 'Atraso', state: 'open', updated_at: 1780000000, created_at: 1770000000, source: { body: 'Meu pedido [[x]]', author: { name: 'Bia' } },
      conversation_parts: { total_count: 700, conversation_parts: [{ part_type: 'comment', body: 'Sai hoje', author: { name: 'Ana' }, created_at: 1771000000 }, { part_type: 'note', body: 'Cliente VIP', author: { name: 'Ana' }, created_at: 1772000000 }, { part_type: 'close', body: null, author: { name: 'Ana' }, created_at: 1773000000 }] } });
    const r = await acao('intercom.ler').run(ctx, { conversa: '12' });
    assert.equal(calls[0].url.href, 'https://api.intercom.io/conversations/12?display_as=plaintext');
    assert.match(r.texto, /Conversa #12: Atraso\. Situação: open/);
    assert.match(r.texto, /Bia \[mensagem inicial\]: Meu pedido/); assert.ok(!r.texto.includes('[[x'));
    assert.match(r.texto, /Ana \[mensagem\]: Sai hoje/);
    assert.match(r.texto, /Ana \[nota interna\]: Cliente VIP/);
    assert.match(r.texto, /Ana \[close\]/);
    assert.match(r.texto, /mostrando as 3 partes mais recentes de 700/);
    assert.equal(r.deFora, true);
  });
  test('responder ao cliente e nota interna: quem escreve vem de /me', async () => {
    comMe();
    const resp = acao('intercom.responder');
    assert.equal(resp.risco, 'enviar');
    assert.match(resp.resumo({ conversa: '12', texto: 'Oi' }), /O cliente recebe:\nOi$/);
    const r = await resp.run(ctx, { conversa: '12', texto: 'Olá & tudo bem?' });
    assert.equal(calls[0].url.pathname, '/me');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url.href, 'https://api.intercom.io/conversations/12/reply');
    assert.deepEqual(calls[1].body, { message_type: 'comment', type: 'admin', admin_id: '3156780', body: 'Olá &amp; tudo bem?' });
    assert.equal(r.texto, 'Resposta enviada na conversa #12.');
    calls.length = 0;
    const nota = acao('intercom.nota');
    assert.equal(nota.risco, 'organizar');
    await nota.run(ctx, { conversa: '12', texto: 'Linha 1\n\n<a class="entity_mention" href="x">@todos</a>' });
    assert.deepEqual(calls[1].body, { message_type: 'note', type: 'admin', admin_id: '3156780', body: '<p>Linha 1</p><p>&lt;a class="entity_mention" href="x"&gt;@todos&lt;/a&gt;</p>' });
  });
  test('situação: fechar, abrir e adiar sem mensagem ao cliente', async () => {
    comMe();
    const a = acao('intercom.situacao');
    assert.equal(a.risco, 'organizar');
    await a.run(ctx, { conversa: '12', situacao: 'fechada' });
    assert.equal(calls[1].url.href, 'https://api.intercom.io/conversations/12/parts');
    assert.deepEqual(calls[1].body, { message_type: 'close', type: 'admin', admin_id: '3156780', skip_notifications: true });
    await a.run(ctx, { conversa: '12', situacao: 'aberta' });
    assert.deepEqual(calls[3].body, { message_type: 'open', admin_id: '3156780', skip_notifications: true });
    await a.run(ctx, { conversa: '12', situacao: 'adiada', ate: '2026-11-06T09:00:00-03:00' });
    assert.deepEqual(calls[5].body, { message_type: 'snoozed', admin_id: '3156780', snoozed_until: Date.parse('2026-11-06T12:00:00Z') / 1000 });
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { conversa: '12', situacao: 'adiada' }), /para adiar/);
    await assert.rejects(() => a.run(ctx, { conversa: '12', situacao: 'adiada', ate: '2026-11-06T09:00:00' }), /com fuso/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });
  test('atribuir: número do atendente, e quem recebe é avisado; 0 tira e não avisa ninguém', async () => {
    comMe();
    const a = acao('intercom.atribuir');
    assert.equal(riscoDe(a, { responsavel: '4324241' }), 'enviar');
    assert.equal(riscoDe(a, { responsavel: '0' }), 'organizar');
    assert.match(a.resumo({ conversa: '12', responsavel: '4324241' }), /O novo responsável recebe aviso/);
    assert.ok(!a.resumo({ conversa: '12', responsavel: '0' }).includes('recebe aviso'));
    await a.run(ctx, { conversa: '12', responsavel: '4324241' });
    assert.deepEqual(calls[1].body, { message_type: 'assignment', type: 'admin', admin_id: '3156780', assignee_id: '4324241' });
    await a.run(ctx, { conversa: '12', responsavel: '0' });
    assert.equal(calls[3].body.assignee_id, '0');
    await assert.rejects(() => a.run(ctx, { conversa: '12', responsavel: 'Ana' }), /número/);
  });
  test('criar: tipo interno organiza; tipo que o cliente vê exige dizer, e aí envia', async () => {
    answer = (c) => (c.method === 'GET' ? { type: 'list', data: [{ id: '88', name: 'Interno', category: 'Back-office', is_internal: true }, { id: '99', name: 'Do cliente', category: 'Customer', is_internal: false }] } : { type: 'ticket', id: '500', ticket_id: '7' });
    const a = acao('intercom.criar');
    const interno = { tipo: '88', contato: 'bia@cliente.com', titulo: 'Impressora', descricao: 'Parou' };
    assert.equal(riscoDe(a, interno), 'organizar');
    const r = await a.run(ctx, interno);
    assert.equal(calls[0].url.pathname, '/ticket_types');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url.href, 'https://api.intercom.io/tickets');
    assert.deepEqual(calls[1].body, { ticket_type_id: '88', contacts: [{ email: 'bia@cliente.com' }], ticket_attributes: { _default_title_: 'Impressora', _default_description_: 'Parou' } });
    assert.equal(r.texto, 'Chamado criado (número: 500).');
    calls.length = 0;
    await assert.rejects(() => a.run(ctx, { ...interno, tipo: '99' }), /pode ser visto pelo cliente/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'um tipo visível ao cliente não passa como interno');
    await assert.rejects(() => a.run(ctx, { ...interno, tipo: '1' }), (e: any) => e instanceof ErroAcao && e.opcoes?.includes('88 (Interno)'));
    calls.length = 0;
    const cliente = { tipo: '99', contato: '6711', titulo: 'Pedido', descricao: 'Atrasou', para_cliente: 'sim', responsavel: '3', time: '4' };
    assert.equal(riscoDe(a, cliente), 'enviar');
    assert.equal(a.resumo(cliente), 'Criar um chamado no Intercom que 6711 pode ver e receber. O responsável ou o time pode ser avisado.\nTítulo: Pedido\nAtrasou');
    assert.equal(riscoDe(a, { ...interno, responsavel: '3' }), 'enviar', 'chamado interno atribuído a alguém avisa essa pessoa');
    assert.equal(riscoDe(a, { ...interno, time: '4' }), 'enviar');
    await a.run(ctx, cliente);
    assert.deepEqual(calls[1].body, { ticket_type_id: '99', contacts: [{ id: '6711' }], ticket_attributes: { _default_title_: 'Pedido', _default_description_: 'Atrasou' }, assignment: { admin_assignee_id: '3', team_assignee_id: '4' } });
  });
  test('responder e nota: o cartão mostra o assunto e o cliente, só lendo', async () => {
    answer = () => ({ id: '12', title: 'Atraso [[x]]', source: { subject: '<p>outro</p>', body: '<p>corpo</p>', author: { type: 'user', name: 'Bia', email: 'bia@cliente.com' } } });
    for (const id of ['intercom.responder', 'intercom.nota']) {
      calls.length = 0;
      const p = await acao(id).preparar!(ctx, { conversa: '12', texto: 'x' });
      assert.equal(p.detalhe, 'Assunto: Atraso [ [x] ]\nCliente: Bia (bia@cliente.com)', id);
      assert.equal(calls.length, 1); assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url.href, 'https://api.intercom.io/conversations/12?display_as=plaintext');
    }
    answer = () => ({ id: '12', title: '', source: { subject: '<p>Pedido</p>', body: 'corpo', author: { type: 'lead', email: 'bia@cliente.com' } } });
    assert.equal((await acao('intercom.responder').preparar!(ctx, { conversa: '12', texto: 'x' })).detalhe, 'Assunto: Pedido\nCliente: bia@cliente.com');
    // sem assunto: o começo da primeira mensagem. Quem começou foi um atendente: ele não é o cliente, e o que há é o número do contato
    answer = () => ({ id: '12', source: { body: 'Olá, seu pedido saiu', author: { type: 'admin', name: 'Ana', email: 'ana@empresa.com' } }, contacts: { contacts: [{ type: 'contact', id: '6711' }] } });
    assert.equal((await acao('intercom.responder').preparar!(ctx, { conversa: '12', texto: 'x' })).detalhe, 'Assunto: Olá, seu pedido saiu\nCliente: contato 6711');
    answer = () => ({ id: '12', source: { author: { type: 'bot', name: 'Fin' } } });
    assert.equal((await acao('intercom.responder').preparar!(ctx, { conversa: '12', texto: 'x' })).detalhe, 'Assunto: sem assunto\nCliente: não identificado');
    calls.length = 0;
    await assert.rejects(() => acao('intercom.nota').preparar!(ctx, { conversa: '..', texto: 'x' }), /id inválido/);
    assert.equal(calls.length, 0);
  });
  test('quem manda ao cliente tem o limite de 5000 caracteres', async () => {
    for (const [id, base] of [['intercom.responder', { conversa: '12', texto: 'x'.repeat(5001) }], ['intercom.nota', { conversa: '12', texto: 'x'.repeat(5001) }], ['intercom.criar', { tipo: '88', contato: '1', titulo: 'T', descricao: 'x'.repeat(5001) }]] as const) {
      await assert.rejects(() => acao(id).run(ctx, base), (e: unknown) => e instanceof ErroAcao && /limite é 5000/.test(e.message), id);
    }
    assert.equal(calls.length, 0);
  });
  test('título e texto juntos cabem no cartão: título de mais de 500 caracteres é recusado', async () => {
    await assert.rejects(() => acao('intercom.criar').run(ctx, { tipo: '88', contato: '1', titulo: 'x'.repeat(501), descricao: 'd' }), (e: unknown) => e instanceof ErroAcao && /limite é 500/.test(e.message));
    assert.equal(calls.length, 0);
  });
  test('atendentes e tipos: números para escolher', async () => {
    answer = () => ({ type: 'admin.list', admins: [{ id: '3', name: 'Ana', email: 'ana@empresa.com' }] });
    assert.match((await acao('intercom.atendentes').run(ctx, {})).texto, /Ana ana@empresa\.com \(número: 3\)/);
    assert.equal(calls[0].url.pathname, '/admins');
    answer = () => ({ type: 'list', data: [{ id: '88', name: 'Interno', is_internal: true }, { id: '99', name: 'Do cliente', is_internal: false }] });
    const r = await acao('intercom.tipos').run(ctx, {});
    assert.match(r.texto, /Interno \(número: 88, só a equipe vê\)/);
    assert.match(r.texto, /Do cliente \(número: 99, o cliente pode ver\)/);
  });
  test('resposta 403 vira recusa de acesso', async () => {
    answer = () => new Response(JSON.stringify({ type: 'error.list', errors: [{ code: 'api_plan_restricted', message: 'fora do plano' }] }), { status: 403 });
    await assert.rejects(() => acao('intercom.ler').run(ctx, { conversa: '1' }), recusaDeAcesso);
  });
});
