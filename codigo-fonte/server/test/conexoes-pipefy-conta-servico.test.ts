// Pipefy pela conta de serviço (o jeito que o Pipefy recomenda; o token pessoal ficou obsoleto), sem rede: a troca do Client ID
// e do Client Secret pelo acesso, o acesso guardado até vencer, a renovação quando o Pipefy recusa antes da hora, o segredo que
// só vai ao próprio Pipefy, quem conectou do jeito antigo continuando a funcionar com o aviso, e a conexão pela tela.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { ProviderError } from '../src/services/mirror.ts';
import { escritorPipefy } from '../src/services/conexoes/escrita/pipefy.ts';
import { INTEGRATIONS, setIntegration } from '../src/services/integrations.ts';
import { PIPEFY_TOKEN_URL, PipefyProvider, enderecoTokenPipefy, pipefyAntigo } from '../src/services/task-providers.ts';

type Call = { method: string; url: string; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: String(input), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : json(out);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });
afterEach(() => { calls.length = 0; answer = () => ({}); });

// cada teste com a sua credencial: o acesso fica guardado por credencial
let n = 0;
const conta = () => ({ client_id: `id-da-conta-${++n}`, client_secret: `segredo-da-conta-de-servico-${n}-abcdef` });
const PESSOAL = ['pessoal', 'antigo', '0123456789abcdef'].join('-');
/** Pipefy falso: o endereço do token entrega acessos numerados; o GraphQL aceita só o acesso esperado. */
const pipefy = (o: { valido?: () => string; expira?: number; recusarTroca?: boolean } = {}) => {
  let emitidos = 0;
  answer = (c) => {
    if (c.url === PIPEFY_TOKEN_URL || c.url.startsWith('https://app.pipefy.com/')) {
      if (o.recusarTroca) return json({ error: 'invalid_client', error_description: `cliente ${c.body?.client_secret} desconhecido` }, 401);
      return json({ access_token: `acesso-${++emitidos}`, token_type: 'Bearer', expires_in: o.expira ?? 86_400, service_account: { name: 'Ergon' } });
    }
    if (c.url === 'https://api.pipefy.com/graphql') {
      const esperado = o.valido?.() ?? `acesso-${emitidos}`;
      if (c.headers.Authorization !== `Bearer ${esperado}`) return json({ errors: [{ title: 'Unauthorized', detail: 'You are not authorized to access this page' }] }, 401);
      if (String(c.body?.query).includes('me {')) return json({ data: { me: { id: '77', name: 'Ergon (conta de serviço)', email: 'ergon@pipefy.com' } } });
      if (String(c.body?.query).includes('createComment')) return json({ data: { createComment: { comment: { id: 'c1' } } } });
      return json({ data: {} });
    }
    throw new TypeError(`rota não simulada: ${c.url}`);
  };
};

describe('Pipefy: conta de serviço', () => {
  test('troca Client ID e Client Secret pelo acesso, no endereço do Pipefy, e usa o acesso como Bearer', async () => {
    const c = conta();
    pipefy();
    const quem = await new PipefyProvider(c).whoami();
    assert.deepEqual(quem, { nome: 'Ergon (conta de serviço)', id: '77' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].url, 'https://app.pipefy.com/oauth/token');
    assert.deepEqual(calls[0].body, { grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(calls[0].headers.Authorization, undefined, 'o segredo vai no corpo, não num cabeçalho');
    assert.equal(calls[1].url, 'https://api.pipefy.com/graphql'); assert.equal(calls[1].headers.Authorization, 'Bearer acesso-1');
  });

  test('o acesso fica guardado até perto de vencer: a segunda leitura não pede outro', async () => {
    const c = conta();
    pipefy();
    const p = new PipefyProvider(c);
    await p.whoami(); await p.whoami();
    assert.equal(calls.filter((x) => x.url === PIPEFY_TOKEN_URL).length, 1);
    // outro provedor com a mesma credencial (outra tela, o espelho, o escritor) aproveita o mesmo acesso
    await new PipefyProvider({ ...c }).whoami();
    assert.equal(calls.filter((x) => x.url === PIPEFY_TOKEN_URL).length, 1);
  });

  test('acesso que vence em menos de um minuto é renovado antes de usar', async () => {
    const c = conta();
    pipefy({ expira: 30 });
    const p = new PipefyProvider(c);
    await p.whoami(); await p.whoami();
    assert.equal(calls.filter((x) => x.url === PIPEFY_TOKEN_URL).length, 2);
    assert.equal(calls.at(-1)!.headers.Authorization, 'Bearer acesso-2');
  });

  test('o Pipefy recusou o acesso antes da hora (401): pede outro e repete uma vez só', async () => {
    const c = conta();
    let vale = 'acesso-1';
    pipefy({ valido: () => vale });
    const p = new PipefyProvider(c);
    await p.whoami();
    vale = 'acesso-2'; // o Pipefy revogou o primeiro
    calls.length = 0;
    assert.equal((await p.whoami()).id, '77');
    assert.deepEqual(calls.map((x) => [x.url, x.headers.Authorization]), [
      ['https://api.pipefy.com/graphql', 'Bearer acesso-1'], [PIPEFY_TOKEN_URL, undefined], ['https://api.pipefy.com/graphql', 'Bearer acesso-2'],
    ]);
    // continua recusando: não fica pedindo acesso para sempre
    vale = 'nenhum';
    calls.length = 0;
    await assert.rejects(() => p.whoami(), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    assert.equal(calls.filter((x) => x.url === PIPEFY_TOKEN_URL).length, 1);
    assert.equal(calls.filter((x) => x.url.includes('graphql')).length, 2);
  });

  test('credencial recusada na troca: erro de acesso em português, sem o segredo, e sem tentar o GraphQL', async () => {
    const c = conta();
    pipefy({ recusarTroca: true });
    await assert.rejects(() => new PipefyProvider(c).whoami(), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden'
      && /recusou a credencial: confira o identificador e o segredo em Conexões/.test(e.message) && !e.message.includes(c.client_secret));
    assert.ok(calls.every((x) => !x.url.includes('graphql')));
  });

  test('a escrita usa o mesmo acesso: comentar num card vai com o Bearer da conta de serviço', async () => {
    const c = conta();
    pipefy();
    await escritorPipefy(c).comentar!('1', '501', 'Feito pelo agente');
    assert.equal(calls[0].url, PIPEFY_TOKEN_URL);
    assert.equal(calls[1].headers.Authorization, 'Bearer acesso-1');
    assert.deepEqual(calls[1].body.variables, { input: { card_id: '501', text: 'Feito pelo agente' } });
  });

  test('o endereço do token: em branco é o padrão; outro só se for https do próprio Pipefy', () => {
    assert.equal(enderecoTokenPipefy(''), 'https://app.pipefy.com/oauth/token');
    assert.equal(enderecoTokenPipefy(undefined), PIPEFY_TOKEN_URL);
    assert.equal(enderecoTokenPipefy(' https://app.pipefy.com/oauth/token?x=1 '), 'https://app.pipefy.com/oauth/token');
    assert.equal(enderecoTokenPipefy('https://auth.pipefy.com/oauth/token'), 'https://auth.pipefy.com/oauth/token');
    for (const ruim of ['http://app.pipefy.com/oauth/token', 'https://pipefy.com.atacante.net/oauth/token', 'https://atacante.net/pipefy.com', 'https://naopipefy.com/x', 'https://u:s@app.pipefy.com/oauth/token', 'https://app.pipefy.com:8443/oauth/token', 'não é endereço']) {
      assert.throws(() => enderecoTokenPipefy(ruim), (e: unknown) => e instanceof ProviderError && /endereço de acesso/.test(e.message), ruim);
    }
  });

  test('endereço do token próprio (o que o Pipefy mostrou) é o usado na troca', async () => {
    const c = { ...conta(), token_url: 'https://app.pipefy.com/oauth/token-regional' };
    pipefy();
    await new PipefyProvider(c).whoami();
    assert.equal(calls[0].url, 'https://app.pipefy.com/oauth/token-regional');
  });
});

describe('Pipefy: quem conectou com o token pessoal (obsoleto)', () => {
  test('continua funcionando, direto com o token, sem troca nenhuma', async () => {
    answer = (c) => (c.headers.Authorization === `Bearer ${PESSOAL}` ? json({ data: { me: { id: '9', name: 'Ana' } } }) : json({}, 401));
    assert.equal((await new PipefyProvider({ token: PESSOAL }).whoami()).nome, 'Ana');
    assert.equal((await new PipefyProvider(PESSOAL).whoami()).nome, 'Ana', 'o formato de antes também');
    assert.ok(calls.every((x) => x.url === 'https://api.pipefy.com/graphql'));
  });
  test('é reconhecido como jeito antigo; com a conta de serviço, não', () => {
    assert.equal(pipefyAntigo({ token: PESSOAL }), true);
    assert.equal(pipefyAntigo({ ...conta() }), false);
    assert.equal(pipefyAntigo({ token: PESSOAL, ...conta() }), false);
    assert.equal(pipefyAntigo(null), false);
  });
  test('a definição pede a conta de serviço; o endereço do token é opcional', () => {
    const d = INTEGRATIONS.find((x) => x.kind === 'pipefy')!;
    assert.deepEqual(d.fields!.map((f) => [f.name, !!f.secret, !!f.opcional]), [['client_id', false, false], ['client_secret', true, false], ['token_url', false, true]]);
    assert.match(d.help!.steps, /Contas de serviço/); assert.match(d.help!.steps, /Client ID e Client Secret/);
    assert.doesNotMatch(d.help!.steps, /Tokens de acesso pessoal/);
    assert.doesNotMatch(d.credencialAntiga!.aviso, /\btoken\b/i, 'o aviso é para a pessoa, sem jargão');
  });
});

describe('Pipefy pela tela de Conexões', () => {
  let h: Harness; let s: Session;
  beforeEach(async () => { h = await harness(); s = await setupOwner(h); });
  afterEach(() => h.close());
  const item = async () => (await req(h, 'GET', '/api/integrations', s)).json.find((i: { kind: string }) => i.kind === 'pipefy');

  test('conectar com Client ID e Client Secret: confere no Pipefy, guarda e conecta sem aviso', async () => {
    const c = conta();
    pipefy();
    const r = await req(h, 'POST', '/api/integrations/pipefy/token', s, { credentials: c });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.account, 'Ergon (conta de serviço)');
    const guardada = h.integrations.secrets.read<Record<string, string>>(s.workspaceId, 'pipefy')!;
    assert.equal(guardada.client_id, c.client_id); assert.equal(guardada.client_secret, c.client_secret); assert.equal(guardada.token, undefined);
    const i = await item();
    assert.equal(i.state, 'connected'); assert.equal(i.aviso, null);
    assert.ok(!JSON.stringify(i).includes(c.client_secret), 'o segredo nunca volta à tela');
    // a leitura dos quadros também entra pela conta de serviço
    assert.ok(h.integrations.provider(s.workspaceId, 'pipefy') instanceof PipefyProvider);
  });

  test('endereço do token fora do Pipefy é recusado antes de mandar o segredo a qualquer lugar', async () => {
    pipefy();
    const r = await req(h, 'POST', '/api/integrations/pipefy/token', s, { credentials: { ...conta(), token_url: 'https://atacante.net/oauth/token' } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /próprio Pipefy/);
    assert.equal(calls.length, 0);
  });

  test('a tela de conectar diz logo no início, à vista, que quem cria a conta de serviço é o Super Admin da empresa', async () => {
    const i = await item();
    assert.match(i.help.antes, /^Antes de começar:/);
    assert.match(i.help.antes, /administrador principal da empresa no Pipefy \(o Super Admin\)/);
    assert.doesNotMatch(i.help.antes, /\btoken\b|\bAPI\b/i, 'sem jargão');
    // a tela põe o aviso antes dos passos e dos campos
    const tela = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'views', 'ConexoesView.tsx'), 'utf8');
    const antes = tela.indexOf('i.help?.antes &&'); const passos = tela.indexOf('{i.help.steps}'); const campos = tela.indexOf('{fields.map(');
    assert.ok(antes > 0 && antes < passos && passos < campos, 'o aviso vem primeiro');
    // as outras conexões não ganham aviso à toa
    assert.equal(INTEGRATIONS.filter((d) => d.help?.antes).map((d) => d.kind).join(','), 'pipefy');
  });

  test('sem o Client Secret, a tela diz o que falta', async () => {
    const r = await req(h, 'POST', '/api/integrations/pipefy/token', s, { credentials: { client_id: 'id-1' } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(r.json), /Client Secret/);
  });

  test('conectado com o token pessoal: continua conectado, e a tela avisa para reconectar do novo jeito', async () => {
    h.integrations.secrets.writeOwn(s.workspaceId, 'pipefy', { token: PESSOAL });
    setIntegration(h.db, s.workspaceId, 'pipefy', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
    const i = await item();
    assert.equal(i.state, 'connected');
    assert.match(i.aviso, /obsoleto/); assert.match(i.aviso, /reconecte do novo jeito/);
    assert.ok(h.integrations.provider(s.workspaceId, 'pipefy') instanceof PipefyProvider, 'o token antigo ainda lê os quadros');
    // reconectou com a conta de serviço: o aviso some
    pipefy();
    assert.equal((await req(h, 'POST', '/api/integrations/pipefy/token', s, { credentials: conta() })).status, 200);
    assert.equal((await item()).aviso, null);
  });

  test('cartão de antes da atualização, pela conexão com o token pessoal: a marca da credencial continua a mesma', async () => {
    // a marca que a versão anterior gravou no cartão: o id da conta e os campos que não eram segredo (o token era o único campo)
    const marcaAntiga = crypto.createHash('sha256').update(`pipefy\n${JSON.stringify(['77'])}`).digest('hex');
    const marca = () => (h.conexoes as unknown as { credencialDe(ws: string, k: string): string | null }).credencialDe(s.workspaceId, 'pipefy');
    h.integrations.secrets.writeOwn(s.workspaceId, 'pipefy', { token: PESSOAL, conta_id: '77' });
    assert.equal(marca(), marcaAntiga, 'ninguém reconectou: o clique no cartão esperando não pode ser recusado');
    // a conta de serviço entra com os campos novos: outra credencial, outra marca
    h.integrations.secrets.writeOwn(s.workspaceId, 'pipefy', { ...conta(), conta_id: '77' });
    assert.notEqual(marca(), marcaAntiga);
  });
});
