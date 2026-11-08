/**
 * A mesma conta em mais de um workspace, nos casos de borda: outra conta com o mesmo nome não toma o lugar da emprestada,
 * um token novo da mesma conta (o mesmo id no serviço, no mesmo endereço) vale para todos, autorizar de novo onde a
 * credencial mora religa quem a usa, um pedido de exclusão recusado não mexe em nada, o aviso de renovação do Google segue
 * a autorização de verdade e uma renovação de acesso atrasada não desfaz desconectar nem trocar de conta.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { conferir } from '../src/services/conexoes/conectores/index.ts';

const realFetch = globalThis.fetch;
/** segura a próxima renovação de acesso na Microsoft até a prova soltar */
let renovacao: { chegou: () => void; solta: Promise<void> } | null = null;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? '';
    // o mesmo nome para duas credenciais diferentes (trabalho e pessoal, por exemplo); "tok-gid-X-…" é um token da conta X
    const gid = /tok-gid-(\w+?)-/.exec(auth)?.[1];
    if (url.host === 'app.asana.com') return new Response(JSON.stringify({ data: { name: 'Ana Empresa', ...(gid ? { gid } : {}) } }), { status: 200 });
    // a mesma conta Atlassian responde igual em qualquer site
    if (url.host.endsWith('.atlassian.net')) return new Response(JSON.stringify({ accountId: 'acc-ana', displayName: 'Ana Empresa' }), { status: 200 });
    if (url.host === 'login.microsoftonline.com') {
      const corpo = String(init.body);
      if (corpo.includes('grant_type=refresh_token')) {
        if (renovacao) { const r = renovacao; renovacao = null; r.chegou(); await r.solta; }
        return new Response(JSON.stringify({ access_token: 'acesso-renovado', refresh_token: 'renova-x-2', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'acesso-a', refresh_token: 'renova-a', expires_in: 3600, scope: 'User.Read Tasks.ReadWrite' }), { status: 200 });
    }
    if (url.host === 'graph.microsoft.com') return new Response(JSON.stringify({ displayName: 'Conta A', mail: auth.includes('acesso-a') ? 'conta-a@y.z' : 'outra@y.z' }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

let h: Harness; let s: Session; let a: string; let b: string;
const estado = (ws: string, kind = 'asana') => h.db.get<{ state: string; o: string | null; erro: string | null }>('SELECT state, origem_workspace_id AS o, last_error AS erro FROM integrations WHERE workspace_id = ? AND kind = ?', ws, kind)!;
const token = (ws: string) => h.integrations.secrets.readOwn<{ token: string }>(ws, 'asana')?.token ?? null;
beforeEach(async () => {
  h = await harness({ msClientId: 'app-de-teste', googleTesting: true });
  s = await setupOwner(h);
  a = s.workspaceId;
  h.integrations.secrets.writeOwn(a, 'asana', { token: 'tok-da-empresa-123456' });
  setIntegration(h.db, a, 'asana', { state: 'connected', account_label: 'Ana Empresa', connected_at: new Date().toISOString() });
  b = (await req(h, 'POST', '/api/workspaces', s, { name: 'Pessoal' })).json.workspaceId;
});
afterEach(() => h.close());
const usar = (kind = 'asana') => req(h, 'POST', `/api/conexoes/${kind}/usar-de`, s, { workspaceId: a });
const irPara = (ws: string) => req(h, 'POST', '/api/session/workspace', s, { workspaceId: ws });
const colar = (t: string) => req(h, 'POST', '/api/integrations/asana/token', s, { token: t });

describe('conta emprestada', () => {
  test('outra credencial com o mesmo nome de conta: quem usava a de antes fica com ela', async () => {
    await usar();
    await irPara(a);
    assert.equal((await colar('tok-da-pessoal-mesmo-nome-99')).status, 200);
    assert.equal(token(a), 'tok-da-pessoal-mesmo-nome-99');
    assert.equal(estado(b).o, null, 'deixou de apontar para A');
    assert.equal(token(b), 'tok-da-empresa-123456', 'e continua na conta de antes, nunca na outra');
  });

  test('a mesma conta com um token novo onde a credencial mora: quem a usa emprestada continua usando, já com o novo', async () => {
    await irPara(a);
    assert.equal((await colar('tok-gid-u1-primeiro-123456')).status, 200);
    assert.equal(h.integrations.secrets.readOwn<{ conta_id: string }>(a, 'asana')!.conta_id, 'u1', 'a credencial guarda o id da conta');
    await irPara(b); await usar(); await irPara(a);
    setIntegration(h.db, b, 'asana', { state: 'error', last_error: 'O Asana recusou: token vencido.' });
    assert.equal((await colar('tok-gid-u1-renovado-654321')).status, 200);
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: a, erro: null }, 'segue emprestada e volta a funcionar');
    assert.equal(token(b), null, 'sem cópia');
    assert.equal(h.integrations.secrets.read<{ token: string }>(b, 'asana')!.token, 'tok-gid-u1-renovado-654321', 'usa o token novo');
  });

  test('outra conta com o mesmo nome (id diferente): quem usava fica com a de antes', async () => {
    await irPara(a);
    assert.equal((await colar('tok-gid-u1-primeiro-123456')).status, 200);
    await irPara(b); await usar(); await irPara(a);
    assert.equal((await colar('tok-gid-u2-outra-conta-123456')).status, 200);
    assert.equal(estado(b).o, null, 'deixou de apontar para A');
    assert.equal(token(b), 'tok-gid-u1-primeiro-123456');
    assert.equal(token(a), 'tok-gid-u2-outra-conta-123456');
  });

  test('o mesmo id de conta noutro endereço é outra conta: quem usava fica com a de antes', async () => {
    const jira = (site: string, tok: string) => req(h, 'POST', '/api/integrations/jira/token', s, { credentials: { site, email: 'ana@empresa.com', token: tok } });
    await irPara(a);
    assert.equal((await jira('empresa-a', 'tok-jira-site-a-123456')).status, 200);
    await irPara(b); await usar('jira'); await irPara(a);
    assert.equal((await jira('empresa-b', 'tok-jira-site-b-123456')).status, 200);
    assert.equal(estado(b, 'jira').o, null);
    assert.equal(h.integrations.secrets.readOwn<{ site: string }>(b, 'jira')!.site, 'empresa-a', 'continua no site de antes');
  });

  test('a mesma credencial colada de novo onde ela mora religa quem a usa e tinha caído', async () => {
    await usar();
    setIntegration(h.db, b, 'asana', { state: 'error', last_error: 'A autorização venceu: entre de novo em Conexões.' });
    await irPara(a);
    assert.equal((await colar('tok-da-empresa-123456')).status, 200);
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: a, erro: null }, 'segue emprestada e volta a funcionar');
  });

  test('entrar de novo com a mesma conta onde ela mora religa quem a usa', async () => {
    const sso = h.integrations.sso;
    const entrar = async (ws: string) => {
      const u = new URL(sso.start('microsoft', ws, s.userId));
      const r = await sso.finish('microsoft', u.searchParams.get('state')!, 'codigo');
      h.integrations.markSso('microsoft', r.workspaceId, r.userId, r.account);
    };
    await entrar(a);
    await usar('microsoft');
    setIntegration(h.db, b, 'microsoft', { state: 'error', last_error: 'A autorização venceu: entre de novo em Conexões.' });
    await entrar(a);
    assert.deepEqual({ ...estado(b, 'microsoft') }, { state: 'connected', o: a, erro: null });
  });

  test('pedido de exclusão recusado não mexe na conta emprestada', async () => {
    await usar();
    assert.equal((await req(h, 'DELETE', `/api/workspaces/${a}`, s, { confirmName: 'nome errado' })).status, 400);
    assert.equal(estado(b).o, a, 'continua emprestada');
    assert.equal(token(b), null, 'sem cópia da credencial');
  });

  test('o aviso de renovação do Google segue a autorização, não a hora do empréstimo', async () => {
    const seisDias = new Date(Date.now() - 6 * 86_400_000).toISOString();
    setIntegration(h.db, a, 'google', { state: 'connected', account_label: 'ana@gmail.com', connected_at: seisDias });
    await usar('google');
    const item = (await req(h, 'GET', '/api/integrations', s)).json.find((i: { kind: string }) => i.kind === 'google');
    assert.equal(item.renewBy, new Date(Date.parse(seisDias) + 7 * 86_400_000).toISOString());
  });
});

describe('renovação do acesso atrasada', () => {
  const ligarMicrosoft = () => {
    h.integrations.secrets.writeOwn(a, 'microsoft', { access_token: 'velho', refresh_token: 'renova-x', expires_at: Date.now() - 1000, account: 'conta-x@z.z' });
    setIntegration(h.db, a, 'microsoft', { state: 'connected', account_label: 'conta-x@z.z', connected_at: new Date().toISOString() });
  };
  const segurar = () => {
    let chegou!: () => void; const pediu = new Promise<void>((r) => { chegou = r; });
    let solta!: () => void; renovacao = { chegou, solta: new Promise<void>((r) => { solta = r; }) };
    return { pediu, solta: () => solta() };
  };

  test('desconectar durante a renovação: a credencial não volta', async () => {
    ligarMicrosoft();
    const r = segurar();
    const acesso = h.integrations.sso.accessToken(a, 'microsoft').then(() => 'ok', () => 'recusado');
    await r.pediu;
    h.integrations.disconnect(a, s.userId, 'microsoft');
    r.solta();
    assert.equal(await acesso, 'recusado');
    assert.equal(h.integrations.secrets.readOwn(a, 'microsoft'), null, 'continua apagada');
  });

  test('entrar com outra conta durante a renovação: fica a conta nova', async () => {
    ligarMicrosoft();
    const r = segurar();
    const acesso = h.integrations.sso.accessToken(a, 'microsoft').then(() => 'ok', () => 'recusado');
    await r.pediu;
    h.integrations.secrets.writeOwn(a, 'microsoft', { access_token: 'acesso-y', refresh_token: 'renova-y', expires_at: Date.now() + 3600_000, account: 'conta-y@z.z' });
    r.solta();
    assert.equal(await acesso, 'recusado');
    const t = h.integrations.secrets.readOwn<{ account: string; refresh_token: string }>(a, 'microsoft')!;
    assert.deepEqual({ conta: t.account, renova: t.refresh_token }, { conta: 'conta-y@z.z', renova: 'renova-y' });
  });

  test('sem nada mudando, a renovação grava como sempre', async () => {
    ligarMicrosoft();
    assert.equal(await h.integrations.sso.accessToken(a, 'microsoft'), 'acesso-renovado');
    assert.equal(h.integrations.secrets.readOwn<{ refresh_token: string }>(a, 'microsoft')!.refresh_token, 'renova-x-2');
  });
});

describe('o id da conta nos conectores', () => {
  // a resposta de quem é a conta, no formato de cada serviço; o id é o do usuário, do bot ou do portal, que não muda com o token
  // (o token do Slack vai em partes: a varredura de segredos procura o formato inteiro)
  const casos: Array<{ kind: string; creds: Record<string, string>; resposta: unknown; nome: string; id: string | null }> = [
    { kind: 'slack', creds: { token: ['xoxb', '1', '2', 'abcdefghijklmnop'].join('-') }, resposta: { ok: true, team: 'Lab', user: 'ergon', team_id: 'T01', user_id: 'U09', bot_id: 'B01' }, nome: 'App no Slack de Lab', id: 'T01:U09' },
    { kind: 'discord', creds: { token: 'tok-discord-1234567890' }, resposta: { id: '80351110224678912', username: 'ergon-bot' }, nome: 'ergon-bot', id: '80351110224678912' },
    { kind: 'hubspot', creds: { token: 'pat-na1-1234567890abcdef' }, resposta: { portalId: 62515, portalName: 'Acme' }, nome: 'Acme', id: '62515' },
    { kind: 'pipedrive', creds: { token: 'tok-pipedrive-1234567890' }, resposta: { success: true, data: { id: 7, name: 'Ana', company_id: 99, company_name: 'Acme' } }, nome: 'Ana (Acme)', id: '99:7' },
    { kind: 'calendly', creds: { token: 'tok-calendly-1234567890' }, resposta: { resource: { uri: 'https://api.calendly.com/users/AAAA', name: 'Ana Lima' } }, nome: 'Ana Lima', id: 'https://api.calendly.com/users/AAAA' },
    { kind: 'mattermost', creds: { site: 'chat.empresa.com', token: 'tok-mattermost-123456' }, resposta: { id: 'xk9rm1', username: 'ana.lima' }, nome: 'ana.lima', id: 'xk9rm1' },
    // sem id na resposta: fica desconhecido, e um token novo promove quem usava (nunca a conta errada)
    { kind: 'rdstation', creds: { token: 'token-do-rd-1234567890' }, resposta: { name: 'Ana', organization: 'Acme' }, nome: 'Ana (Acme)', id: null },
  ];
  for (const c of casos) {
    test(c.kind, async () => {
      const antes = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify(c.resposta), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
      try { assert.deepEqual(await conferir(c.kind, c.creds), { nome: c.nome, id: c.id }); } finally { globalThis.fetch = antes; }
    });
  }
});
