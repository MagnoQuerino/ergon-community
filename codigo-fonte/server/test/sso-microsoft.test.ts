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

  const voltar = (state: string | null, resto: string) => h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${state}&${resto}` });
  const estado = async () => ((await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string }>).find((i) => i.kind === 'microsoft')!.state;

  test('conta pessoal: primeiro enviar e criar, depois a leitura (sem Teams nem Planner)', async () => {
    tid = MSA;
    const u = await begin();
    const scope = u.searchParams.get('scope') ?? '';
    assert.match(scope, /Mail\.Send/); assert.doesNotMatch(scope, /Mail\.Read|Calendars\./, 'a leitura vem na etapa seguinte');
    assert.equal(u.searchParams.get('prompt'), 'select_account');
    const r = await voltar(u.searchParams.get('state'), 'code=c1');
    const leitura = new URL(String(r.headers.location));
    assert.match(leitura.searchParams.get('scope') ?? '', /Mail\.Read/); assert.match(leitura.searchParams.get('scope') ?? '', /Calendars\.Read/);
    assert.doesNotMatch(leitura.searchParams.get('scope') ?? '', /Chat\.|Channel|Team\.|\.Shared/, 'nada que só existe em conta de trabalho');
    assert.equal(leitura.searchParams.get('login_hint'), 'ana@empresa.com');
    assert.match(String((await voltar(leitura.searchParams.get('state'), 'code=c1b')).headers.location), /microsoft=conectado/);
    assert.doesNotMatch(tokenCalls.at(-1)!.scope, /Chat\./);
  });

  test('conta de trabalho: base, Teams e leitura em sequência; recusar uma etapa mantém as anteriores', async () => {
    tid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const u = await begin();
    const r = await voltar(u.searchParams.get('state'), 'code=c2');
    assert.equal(r.statusCode, 302);
    const teams = new URL(String(r.headers.location));
    assert.equal(teams.host, 'login.microsoftonline.com', 'segunda etapa no login da Microsoft');
    assert.match(teams.searchParams.get('scope') ?? '', /Chat\.ReadBasic/);
    assert.ok(!(teams.searchParams.get('scope') ?? '').split(' ').includes('Chat.Read'), 'ler o conteúdo é outra etapa');
    assert.equal(teams.searchParams.get('login_hint'), 'ana@empresa.com', 'a mesma conta, sem escolher de novo');
    assert.equal(await estado(), 'connected', 'a primeira etapa já conectou');
    const no = await voltar(teams.searchParams.get('state'), 'error=access_denied');
    assert.match(String(no.headers.location), /microsoft=parcial/, 'recusar o Teams não desfaz a conexão, e a tela diz o que ficou de fora');
    assert.equal(await estado(), 'connected');
    // aceitando: segue para a leitura; recusá-la (a empresa exige o administrador) deixa o resto valendo
    const u2 = await begin();
    const t2 = new URL(String((await voltar(u2.searchParams.get('state'), 'code=c3')).headers.location));
    const l2 = new URL(String((await voltar(t2.searchParams.get('state'), 'code=c4')).headers.location));
    assert.ok((l2.searchParams.get('scope') ?? '').split(' ').includes('Chat.Read')); assert.match(l2.searchParams.get('scope') ?? '', /Mail\.Read/);
    assert.match(String((await voltar(l2.searchParams.get('state'), 'error=access_denied')).headers.location), /microsoft=sem-leitura/);
    assert.equal(await estado(), 'connected');
    // de novo, agora liberando tudo
    const u3 = await begin();
    const t3 = new URL(String((await voltar(u3.searchParams.get('state'), 'code=c5')).headers.location));
    const l3 = new URL(String((await voltar(t3.searchParams.get('state'), 'code=c6')).headers.location));
    // e termina aí: sem saber se a conta aprova pela empresa, não leva aos canais (a tela oferece o pedido ao administrador)
    assert.match(String((await voltar(l3.searchParams.get('state'), 'code=c7')).headers.location), /microsoft=sem-canais$/);
    assert.ok(tokenCalls.at(-1)!.scope.split(' ').includes('Chat.Read'));
    assert.ok(!tokenCalls.some((b) => String(b.scope ?? '').split(' ').includes('ChannelMessage.Read.All')), 'nem pediu os canais');
  });
});
