import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const GOOGLE_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const GOOGLE_SECRET = 'segredo-do-cliente-google-123';

describe('SSO parametrizado: Google (conta + Google Tasks)', () => {
  let h: Harness; let s: Session;
  const realFetch = globalThis.fetch;
  const tokenCalls: Array<Record<string, string>> = [];
  let accessN = 0;
  before(async () => {
    h = await harness({ googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SECRET, msClientId: '11111111-2222-3333-4444-555555555555' });
    s = await setupOwner(h);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
        tokenCalls.push(body);
        if (body.client_secret !== GOOGLE_SECRET) return json({ error: 'invalid_client' }, 401);
        accessN++;
        // na renovação o Google não manda outro refresh token
        return json({ access_token: `acesso-${accessN}`, expires_in: 3599, ...(body.grant_type === 'authorization_code' ? { refresh_token: 'renovacao-1' } : {}) });
      }
      if (!auth.startsWith('Bearer acesso-')) return json({ error: 'unauthenticated' }, 401);
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ email: 'alexandre@example.com', name: 'Alexandre' });
      if (url.startsWith('https://tasks.googleapis.com/tasks/v1/users/@me/lists?')) return json({ items: [{ id: 'L1', title: 'Minhas tarefas', updated: '2026-10-20' }] });
      if (url === 'https://tasks.googleapis.com/tasks/v1/users/@me/lists/L1') return json({ id: 'L1', title: 'Minhas tarefas', updated: '2026-10-20' });
      if (url.startsWith('https://tasks.googleapis.com/tasks/v1/lists/L1/tasks?')) return json({ items: [
        { id: 'g1', title: 'Pagar a conta de luz', notes: 'até dia 30', status: 'needsAction', etag: 'e1' },
        { id: 'g2', title: 'Enviar relatório', status: 'completed', etag: 'e2' },
        { id: 'g3', title: '', status: 'needsAction', etag: 'e3' },
      ] });
      return json({}, 404);
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = realFetch; await h.close(); });

  test('o card do Google aparece pronto quando o app está registrado', async () => {
    const list = (await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; auth: string; ready: boolean; setup: { needs: string } | null }>;
    const g = list.find((i) => i.kind === 'google')!;
    assert.equal(g.auth, 'oauth'); assert.equal(g.ready, true); assert.match(g.setup!.needs, /ERGON_GOOGLE_CLIENT_ID/);
  });

  test('login: PKCE, acesso contínuo, state de uso único e só do provedor que começou', async () => {
    const r = await req(h, 'POST', '/api/integrations/google/start', s);
    assert.equal(r.status, 200);
    const u = new URL(r.json.url);
    assert.equal(u.host, 'accounts.google.com');
    assert.equal(u.searchParams.get('client_id'), GOOGLE_ID);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('access_type'), 'offline', 'pede renovação (sem ela o acesso cai em 1 hora)');
    assert.match(u.searchParams.get('scope') ?? '', /tasks\.readonly/);
    assert.ok(!u.toString().includes(GOOGLE_SECRET), 'o segredo nunca vai para o navegador');
    assert.match(u.searchParams.get('redirect_uri') ?? '', /\/api\/integrations\/google\/callback$/);
    const state = u.searchParams.get('state')!;
    // o state do Google não serve na volta da Microsoft (e é gasto)
    const wrong = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${state}&code=x` });
    assert.match(String(wrong.headers.location), /microsoft=erro/);
    const again = await req(h, 'POST', '/api/integrations/google/start', s);
    const st2 = new URL(again.json.url).searchParams.get('state')!;
    const ok = await h.app.inject({ method: 'GET', url: `/api/integrations/google/callback?state=${st2}&code=codigo-do-google` });
    assert.equal(ok.statusCode, 302); assert.match(String(ok.headers.location), /google=conectado/);
    const ex = tokenCalls.at(-1)!;
    assert.equal(ex.grant_type, 'authorization_code'); assert.ok(ex.code_verifier, 'troca com o verificador PKCE'); assert.equal(ex.client_secret, GOOGLE_SECRET);
    const reuse = await h.app.inject({ method: 'GET', url: `/api/integrations/google/callback?state=${st2}&code=outro` });
    assert.match(String(reuse.headers.location), /google=erro/, 'state de uso único');
    const g = ((await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string; account: string }>).find((i) => i.kind === 'google')!;
    assert.equal(g.state, 'connected'); assert.equal(g.account, 'alexandre@example.com');
    const dump = JSON.stringify(h.db.all('SELECT * FROM integrations')) + JSON.stringify(h.db.all('SELECT * FROM audit_events'));
    assert.ok(!dump.includes('renovacao-1') && !dump.includes('acesso-'), 'tokens fora do banco e do log');
  });

  test('Google Tasks no seu quadro: lista, concluídas, sem responsável; renovação sem perder o refresh token', async () => {
    const lists = (await req(h, 'GET', '/api/integrations/google/lists', s)).json.lists;
    assert.deepEqual(lists.map((l: { externalId: string; name: string }) => [l.externalId, l.name]), [['L1', 'Minhas tarefas']]);
    const m = await req(h, 'POST', '/api/boards/mirror', s, { kind: 'google', listId: 'L1' });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const view = (await req(h, 'GET', `/api/boards/${m.json.boardId}`, s)).json;
    assert.deepEqual(view.columns.map((c: { name: string }) => c.name), ['A fazer', 'Concluídas']);
    assert.deepEqual(view.tasks.map((t: { title: string; completed: number }) => [t.title, t.completed]), [['Pagar a conta de luz', 0], ['Enviar relatório', 1]]);
    assert.equal(view.board.audience, 'user');
    // acesso vencendo: renova com o refresh token e o guarda (o Google não manda outro)
    const file = (await import('node:path')).join(h.cfg.dataDir, 'secrets', `${s.workspaceId}-google.json`);
    const fs = await import('node:fs');
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('renovacao-1')), 'tokens cifrados no disco');
    const t = h.integrations.secrets.read<Record<string, unknown>>(s.workspaceId, 'google')!;
    h.integrations.secrets.write(s.workspaceId, 'google', { ...t, expires_at: Date.now() - 1000 });
    assert.equal((await req(h, 'POST', `/api/boards/${m.json.boardId}/sync`, s)).status, 200);
    assert.equal(tokenCalls.at(-1)!.grant_type, 'refresh_token');
    assert.equal(h.integrations.secrets.read<{ refresh_token: string }>(s.workspaceId, 'google')!.refresh_token, 'renovacao-1');
  });

  test('sem o app registrado: diz exatamente o que falta', async () => {
    const h2 = await harness({ googleClientId: GOOGLE_ID, googleClientSecret: null });
    const s2 = await setupOwner(h2);
    const r = await req(h2, 'POST', '/api/integrations/google/start', s2);
    assert.equal(r.status, 409); assert.match(r.json.message, /ERGON_GOOGLE_CLIENT_SECRET/); assert.match(r.json.message, /docs\/GOOGLE\.md/);
    assert.equal(((await req(h2, 'GET', '/api/integrations', s2)).json as Array<{ kind: string; ready: boolean }>).find((i) => i.kind === 'google')!.ready, false);
    await h2.close();
  });
});
