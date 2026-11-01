import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ERGON_MS_APP, loadConfig } from '../src/config.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const MS_ID = '11111111-2222-3333-4444-555555555555';
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('Microsoft: o app público vem pronto e o login serve para conta pessoal e de trabalho', () => {
  let h: Harness; let s: Session;
  const realFetch = globalThis.fetch;
  const tokenCalls: Array<Record<string, string>> = [];
  let tid = MSA; let n = 0;
  before(async () => {
    h = await harness({ msClientId: MS_ID });
    s = await setupOwner(h);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
        tokenCalls.push(body); n++;
        return json({ access_token: `acesso-${n}`, refresh_token: `renova-${n}`, expires_in: 3599, ...(body.grant_type === 'authorization_code' ? { id_token: idToken({ tid, preferred_username: 'ana@empresa.com' }) } : {}) });
      }
      if (url.startsWith('https://graph.microsoft.com/v1.0/me')) return json({ mail: 'ana@empresa.com' });
      return json({}, 404);
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = realFetch; await h.close(); });

  const begin = async () => new URL((await req(h, 'POST', '/api/integrations/microsoft/start', s)).json.url);

  test('sem configurar nada, o identificador é o do app público do Ergon; off desliga', () => {
    assert.equal(loadConfig({}).msClientId, ERGON_MS_APP);
    assert.equal(loadConfig({ ERGON_MS_CLIENT_ID: '' }).msClientId, ERGON_MS_APP);
    assert.equal(loadConfig({ ERGON_MS_CLIENT_ID: 'off' }).msClientId, null);
    assert.equal(loadConfig({ ERGON_MS_CLIENT_ID: MS_ID }).msClientId, MS_ID);
  });

  test('conta pessoal: só pede o que existe para ela (sem Teams nem Planner) e conecta de uma vez', async () => {
    tid = MSA;
    const u = await begin();
    const scope = u.searchParams.get('scope') ?? '';
    assert.match(scope, /Mail\.Read/); assert.match(scope, /Calendars\.Read/);
    assert.doesNotMatch(scope, /Chat\.Read|\.Shared/, 'nada que só existe em conta de trabalho');
    const r = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${u.searchParams.get('state')}&code=c1` });
    assert.match(String(r.headers.location), /microsoft=conectado/);
    assert.doesNotMatch(tokenCalls.at(-1)!.scope, /Chat\.Read/);
  });

  test('conta de trabalho: conecta e segue para pedir Teams/Planner; recusar mantém a conexão', async () => {
    tid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const u = await begin();
    const r = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${u.searchParams.get('state')}&code=c2` });
    assert.equal(r.statusCode, 302);
    const next = new URL(String(r.headers.location));
    assert.equal(next.host, 'login.microsoftonline.com', 'segunda etapa no login da Microsoft');
    assert.match(next.searchParams.get('scope') ?? '', /Chat\.Read/);
    assert.equal(next.searchParams.get('login_hint'), 'ana@empresa.com', 'a mesma conta, sem escolher de novo');
    const g = ((await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string }>).find((i) => i.kind === 'microsoft')!;
    assert.equal(g.state, 'connected', 'a primeira etapa já conectou');
    const no = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${next.searchParams.get('state')}&error=access_denied` });
    assert.match(String(no.headers.location), /microsoft=conectado/, 'recusar o extra não desfaz a conexão');
    // aceitando: a renovação pede as mesmas permissões concedidas
    const u2 = await begin();
    const r2 = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${u2.searchParams.get('state')}&code=c3` });
    const n2 = new URL(String(r2.headers.location));
    const ok = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${n2.searchParams.get('state')}&code=c4` });
    assert.match(String(ok.headers.location), /microsoft=conectado/);
    assert.match(tokenCalls.at(-1)!.scope, /Chat\.Read/);
  });
});
