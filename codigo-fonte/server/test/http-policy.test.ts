/**
 * Política de falha das chamadas externas: o que repete, quanto espera, o que
 * nunca repete, e como a renovação de credenciais distingue "fora do ar" de "conecte de novo".
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, test } from 'node:test';
import { NetworkFailure, fetchWithPolicy, retryAfterMs, setHttpClock } from '../src/lib/http.ts';
import { SecretStore } from '../src/services/integrations.ts';
import { SsoAuth } from '../src/services/sso.ts';
import { request } from '../src/services/task-providers.ts';
import { testConfig, tmpDir } from './helpers.ts';

type Step = { status: number; headers?: Record<string, string>; body?: unknown } | 'derrubar';
let script: Step[] = []; let hits = 0;
let server: http.Server; let base = '';
const sleeps: number[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const step = script.shift() ?? { status: 200, body: { ok: true } };
    if (step === 'derrubar') { req.socket.destroy(); return; }
    res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
    res.end(JSON.stringify(step.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setHttpClock({ sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 1 });
});
after(async () => { setHttpClock(null); await new Promise((r) => server.close(r)); });
afterEach(() => { script = []; hits = 0; sleeps.length = 0; });

const get = (path = '/x') => fetchWithPolicy(() => fetch(base + path, { signal: AbortSignal.timeout(5000) }));
const post = (path = '/x') => fetchWithPolicy(() => fetch(base + path, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) }), { kind: 'write' });
/** porta fechada: conexão recusada (a requisição com certeza não saiu) */
async function closedPort(): Promise<string> {
  const s = http.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port; await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

describe('leitura: falha passageira tem nova tentativa', () => {
  test('503, 503, 200 → dá certo na terceira, com espera crescente', async () => {
    script = [{ status: 503 }, { status: 502 }, { status: 200, body: { ok: 1 } }];
    const r = await get();
    assert.equal(r.status, 200); assert.equal(hits, 3);
    assert.deepEqual(sleeps, [500, 1500]);
  });

  test('429 com Retry-After curto: espera o que o serviço pediu', async () => {
    script = [{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }];
    assert.equal((await get()).status, 200);
    assert.deepEqual(sleeps, [2000]);
  });

  test('Retry-After longo: não fica esperando; a mensagem diz quando tentar', async () => {
    script = [{ status: 429, headers: { 'retry-after': '600' } }];
    const r = await get();
    assert.equal(r.status, 429); assert.equal(hits, 1); assert.deepEqual(sleeps, []);
    assert.equal(retryAfterMs(r), 600_000);
    script = [{ status: 429, headers: { 'retry-after': '600' } }];
    await assert.rejects(request(`${base}/y`), /limite de uso do serviço atingido; tente de novo depois das \d\d:\d\d/);
  });

  test('desiste depois de 3 tentativas e devolve a última resposta', async () => {
    script = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }];
    assert.equal((await get()).status, 503); assert.equal(hits, 3);
    script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    await assert.rejects(request(`${base}/y`), /o serviço respondeu 500/);
  });

  test('401, 403, 404 e 400 não repetem (repetir não muda a resposta)', async () => {
    for (const status of [401, 403, 404, 400]) {
      script = [{ status }, { status: 200 }]; hits = 0;
      assert.equal((await get()).status, status); assert.equal(hits, 1, `${status} uma vez só`);
    }
    script = [{ status: 401 }];
    await assert.rejects(request(`${base}/y`), (e: Error & { kind?: string }) => e.kind === 'forbidden');
  });

  test('sem resposta (conexão derrubada, porta fechada): tenta de novo e, sem jeito, diz que não respondeu', async () => {
    script = ['derrubar', { status: 200 }];
    assert.equal((await get()).status, 200); assert.equal(hits, 2);
    const off = await closedPort();
    await assert.rejects(fetchWithPolicy(() => fetch(off, { signal: AbortSignal.timeout(2000) })), (e: unknown) => e instanceof NetworkFailure && !e.unknownOutcome && e.attempts === 3);
    await assert.rejects(request(off), /o serviço não respondeu/);
  });
});

describe('escrita: nunca faz duas vezes', () => {
  test('5xx numa escrita não repete (o serviço pode ter feito antes de falhar)', async () => {
    script = [{ status: 500 }, { status: 200 }];
    assert.equal((await post()).status, 500); assert.equal(hits, 1);
    script = [{ status: 503 }, { status: 200 }]; hits = 0;
    assert.equal((await post()).status, 503); assert.equal(hits, 1, '503 sem Retry-After também não');
  });

  test('429, ou 503 com Retry-After: o serviço recusou sem fazer — repetir é seguro', async () => {
    script = [{ status: 429 }, { status: 201 }];
    assert.equal((await post()).status, 201); assert.equal(hits, 2);
    script = [{ status: 503, headers: { 'retry-after': '1' } }, { status: 201 }]; hits = 0;
    assert.equal((await post()).status, 201); assert.equal(hits, 2);
  });

  test('conexão caída no meio de uma escrita = resultado desconhecido, sem repetir', async () => {
    script = ['derrubar', { status: 201 }];
    await assert.rejects(post(), (e: unknown) => e instanceof NetworkFailure && e.unknownOutcome && e.attempts === 1);
    assert.equal(hits, 1);
    script = ['derrubar'];
    await assert.rejects(request(`${base}/y`, { body: {}, kind: 'write' }), /não confirmou \(pode ter feito ou não\): confira lá antes de repetir/);
  });

  test('conexão recusada: a escrita com certeza não saiu, então repete', async () => {
    const off = await closedPort();
    await assert.rejects(fetchWithPolicy(() => fetch(off, { method: 'POST', body: '{}' }), { kind: 'write' }), (e: unknown) => e instanceof NetworkFailure && !e.unknownOutcome && e.attempts === 3);
  });
});

describe('renovação de credencial: "fora do ar" não é "conecte de novo"', () => {
  const realFetch = globalThis.fetch;
  let replies: Array<{ status: number; body: unknown }> = []; let tokenPosts = 0;
  const setup = () => {
    const dir = tmpDir();
    const cfg = testConfig(dir, { googleClientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com', googleClientSecret: 'segredo-do-cliente-google-123' });
    const store = new SecretStore(dir);
    const ws = `ws_${'a'.repeat(32)}`;
    store.write(ws, 'google', { access_token: 'velho', refresh_token: 'renovacao-1', expires_at: Date.now() - 1000, account: 'a@example.com' });
    return { sso: new SsoAuth(cfg, store), store, ws };
  };
  before(() => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input) !== 'https://oauth2.googleapis.com/token') return realFetch(input as string);
      tokenPosts++;
      await new Promise((r) => setTimeout(r, 20));
      const r = replies.shift() ?? { status: 200, body: { access_token: `novo-${tokenPosts}`, expires_in: 3600 } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  after(() => { globalThis.fetch = realFetch; });
  afterEach(() => { replies = []; tokenPosts = 0; });

  test('o Google fora do ar (503 três vezes): erro passageiro, a conexão continua, nada é apagado', async () => {
    const { sso, store, ws } = setup();
    replies = [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }];
    await assert.rejects(sso.accessToken(ws, 'google'), (e: Error & { kind?: string; reauth?: boolean }) => e.kind === 'unavailable' && !e.reauth && /a conexão continua/.test(e.message));
    assert.equal(tokenPosts, 3);
    assert.equal(store.read<{ refresh_token: string }>(ws, 'google')!.refresh_token, 'renovacao-1');
  });

  test('503 passageiro e depois certo: renova sem o usuário perceber', async () => {
    const { sso, ws } = setup();
    replies = [{ status: 503, body: {} }];
    assert.equal(await sso.accessToken(ws, 'google'), 'novo-2');
  });

  test('acesso revogado (invalid_grant): aí sim, "conecte de novo"', async () => {
    const { sso, ws } = setup();
    replies = [{ status: 400, body: { error: 'invalid_grant' } }];
    await assert.rejects(sso.accessToken(ws, 'google'), (e: Error & { kind?: string; reauth?: boolean }) => e.kind === 'forbidden' && e.reauth === true && /conecte de novo em Conexões/.test(e.message));
    assert.equal(tokenPosts, 1, 'recusa definitiva não repete');
  });

  test('leituras em paralelo com o acesso vencido: uma renovação só', async () => {
    const { sso, ws } = setup();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => sso.accessToken(ws, 'google')));
    assert.equal(tokenPosts, 1);
    assert.deepEqual(new Set(all), new Set(['novo-1']));
  });
});
