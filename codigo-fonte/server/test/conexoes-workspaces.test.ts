/**
 * Conexão é por workspace, e a mesma conta pode servir a mais de um workspace da mesma pessoa, sem conectar de novo: a
 * credencial mora num só, a renovação vale para todos, e permissões e quadros continuam de cada um. Uma conta nova num
 * workspace nunca sobrescreve a de outro, e desconectar ou apagar um workspace não derruba os outros.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { setIntegration } from '../src/services/integrations.ts';

const realFetch = globalThis.fetch;
const contaDe = (auth: string) => (auth.includes('tok-nova') ? 'Conta Nova' : 'Ana Empresa');
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.host === 'app.asana.com') return new Response(JSON.stringify({ data: { name: contaDe((init.headers as Record<string, string>).Authorization ?? '') } }), { status: 200 });
    if (url.host === 'login.microsoftonline.com') {
      const conta = String(init.body).includes('code=codigo-b') ? 'b' : 'a';
      return new Response(JSON.stringify({ access_token: `acesso-${conta}`, refresh_token: `renova-${conta}`, expires_in: 3600, scope: 'User.Read Tasks.ReadWrite' }), { status: 200 });
    }
    if (url.host === 'graph.microsoft.com') return new Response(JSON.stringify({ displayName: (init.headers as Record<string, string>).Authorization?.includes('acesso-b') ? 'Conta B' : 'Conta A', mail: (init.headers as Record<string, string>).Authorization?.includes('acesso-b') ? 'conta-b@y.z' : 'conta-a@y.z' }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

let h: Harness; let s: Session; let a: string; let b: string;
const ligar = (ws: string, kind: 'asana' | 'microsoft', creds: Record<string, unknown>, conta: string) => {
  h.integrations.secrets.writeOwn(ws, kind, creds);
  setIntegration(h.db, ws, kind, { state: 'connected', account_label: conta, connected_at: new Date().toISOString() });
};
const estado = (ws: string, kind = 'asana') => h.db.get<{ state: string; o: string | null; label: string | null }>('SELECT state, origem_workspace_id AS o, account_label AS label FROM integrations WHERE workspace_id = ? AND kind = ?', ws, kind);
beforeEach(async () => {
  h = await harness({ msClientId: 'app-de-teste' });
  s = await setupOwner(h);
  a = s.workspaceId;
  ligar(a, 'asana', { token: 'tok-da-empresa-123456' }, 'Ana Empresa');
  b = (await req(h, 'POST', '/api/workspaces', s, { name: 'Pessoal' })).json.workspaceId;
});
afterEach(() => h.close());
const usar = () => req(h, 'POST', '/api/conexoes/asana/usar-de', s, { workspaceId: a });

describe('a mesma conta em mais de um workspace', () => {
  test('o workspace novo não tem a conexão, mas oferece a do outro', async () => {
    assert.equal(estado(b)?.state ?? 'off', 'off');
    const r = (await req(h, 'GET', '/api/conexoes/asana/reutilizaveis', s)).json;
    assert.deepEqual(r.contas.map((c: { conta: string }) => c.conta), ['Ana Empresa']);
    assert.equal(r.contas[0].workspaceId, a);
  });

  test('usar a do outro: a credencial é uma só, sem cópia', async () => {
    assert.equal((await usar()).status, 200);
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: a, label: 'Ana Empresa' });
    assert.equal(h.integrations.secrets.read<{ token: string }>(b, 'asana')!.token, 'tok-da-empresa-123456');
    assert.equal(h.integrations.secrets.readOwn(b, 'asana'), null, 'nada foi copiado');
    const item = (await req(h, 'GET', '/api/integrations', s)).json.find((i: { kind: string }) => i.kind === 'asana');
    assert.equal(item.state, 'connected'); assert.equal(item.account, 'Ana Empresa'); assert.ok(item.sharedFrom, 'a tela diz de onde vem');
  });

  test('a renovação do acesso vale para os dois', async () => {
    await usar();
    h.integrations.secrets.write(b, 'asana', { token: 'tok-renovado-123456789' });
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(a, 'asana')!.token, 'tok-renovado-123456789');
  });

  test('permissões são de cada workspace', async () => {
    await usar();
    h.conexoes.setPermissoes(b, s.userId, 'asana', { tipos: { organizar: 'desligado' }, acoes: {} });
    assert.equal(h.conexoes.catalogoDe(b, 'asana').permissoes.tipos.organizar, 'desligado');
    assert.equal(h.conexoes.catalogoDe(a, 'asana').permissoes.tipos.organizar, undefined);
    // o escritor só confere a conexão ligada; cada operação do quadro confere o próprio ajuste (conexoes-espelho-fila.test.ts)
    assert.ok(h.conexoes.escritor(b, 'asana')); assert.ok(h.conexoes.escritor(a, 'asana'));
  });

  test('deixar de usar não mexe na conta do outro', async () => {
    await usar();
    assert.equal((await req(h, 'DELETE', '/api/integrations/asana', s)).status, 200);
    assert.deepEqual({ ...estado(b) }, { state: 'off', o: null, label: null });
    assert.equal(estado(a)!.state, 'connected');
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(a, 'asana')!.token, 'tok-da-empresa-123456');
  });

  test('desconectar onde a credencial mora: quem usa continua, com a credencial', async () => {
    await usar();
    await req(h, 'POST', '/api/session/workspace', s, { workspaceId: a });
    assert.equal((await req(h, 'DELETE', '/api/integrations/asana', s)).status, 200);
    assert.equal(estado(a)!.state, 'off');
    assert.equal(h.integrations.secrets.readOwn(a, 'asana'), null);
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: null, label: 'Ana Empresa' });
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(b, 'asana')!.token, 'tok-da-empresa-123456');
  });

  test('apagar o workspace onde a credencial mora não derruba o outro', async () => {
    await usar();
    assert.equal((await req(h, 'DELETE', `/api/workspaces/${a}`, s, { confirmName: 'Ergon Local' })).status, 200);
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: null, label: 'Ana Empresa' });
    assert.equal(h.integrations.secrets.read<{ token: string }>(b, 'asana')!.token, 'tok-da-empresa-123456');
  });

  test('três workspaces: quem sobra aponta para o que ficou com a credencial', async () => {
    await usar();
    const c = (await req(h, 'POST', '/api/workspaces', s, { name: 'Terceiro' })).json.workspaceId;
    await usar();
    await req(h, 'POST', '/api/session/workspace', s, { workspaceId: a });
    await req(h, 'DELETE', '/api/integrations/asana', s);
    assert.equal(estado(b)!.o, null);
    assert.equal(estado(c)!.o, b);
    assert.equal(h.integrations.secrets.read<{ token: string }>(c, 'asana')!.token, 'tok-da-empresa-123456');
  });

  test('conectar outra conta aqui nunca sobrescreve a de origem', async () => {
    await usar();
    const r = await req(h, 'POST', '/api/integrations/asana/token', s, { token: 'tok-nova-conta-123456' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: null, label: 'Conta Nova' });
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(a, 'asana')!.token, 'tok-da-empresa-123456', 'a da empresa ficou');
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(b, 'asana')!.token, 'tok-nova-conta-123456');
  });

  test('trocar de conta onde a credencial mora: quem usava a antiga fica com ela', async () => {
    await usar();
    await req(h, 'POST', '/api/session/workspace', s, { workspaceId: a });
    assert.equal((await req(h, 'POST', '/api/integrations/asana/token', s, { token: 'tok-nova-conta-123456' })).status, 200);
    assert.equal(estado(a)!.label, 'Conta Nova');
    assert.deepEqual({ ...estado(b) }, { state: 'connected', o: null, label: 'Ana Empresa' });
    assert.equal(h.integrations.secrets.readOwn<{ token: string }>(b, 'asana')!.token, 'tok-da-empresa-123456');
  });

  test('login com a conta: outra conta aqui não toca na de origem, nem herda a renovação dela', async () => {
    const sso = h.integrations.sso;
    const entrar = async (ws: string, codigo: string, conta: string) => {
      const u = new URL(sso.start('microsoft', ws, s.userId));
      const r = await sso.finish('microsoft', u.searchParams.get('state')!, codigo);
      h.integrations.markSso('microsoft', r.workspaceId, r.userId, r.account);
      assert.equal(r.account, conta);
    };
    await entrar(a, 'codigo-a', 'conta-a@y.z');
    await req(h, 'POST', '/api/conexoes/microsoft/usar-de', s, { workspaceId: a });
    assert.equal(estado(b, 'microsoft')!.o, a);
    await entrar(b, 'codigo-b', 'conta-b@y.z');
    assert.equal(estado(b, 'microsoft')!.o, null);
    assert.equal(h.integrations.secrets.readOwn<{ refresh_token: string }>(a, 'microsoft')!.refresh_token, 'renova-a');
    assert.equal(h.integrations.secrets.readOwn<{ refresh_token: string }>(b, 'microsoft')!.refresh_token, 'renova-b');
    assert.equal(h.integrations.secrets.readOwn<{ granted: string }>(b, 'microsoft')!.granted, 'User.Read Tasks.ReadWrite', 'guarda o que o serviço disse ter dado');
  });

  test('só entre os workspaces da própria pessoa', async () => {
    const outra = await addPerson(h, 'outra', 'senha-comprida-da-outra-1');
    assert.deepEqual((await req(h, 'GET', '/api/conexoes/asana/reutilizaveis', outra)).json.contas, []);
    const r = await req(h, 'POST', '/api/conexoes/asana/usar-de', outra, { workspaceId: a });
    assert.equal(r.status, 404);
    assert.equal(estado(outra.workspaceId)?.state ?? 'off', 'off');
  });

  test('WhatsApp é um aparelho só: não se empresta', async () => {
    h.integrations.secrets.writeOwn(a, 'whatsapp', { x: 1 });
    setIntegration(h.db, a, 'whatsapp', { state: 'connected', account_label: 'Número', connected_at: new Date().toISOString() });
    assert.deepEqual((await req(h, 'GET', '/api/conexoes/whatsapp/reutilizaveis', s)).json.contas, []);
    assert.equal((await req(h, 'POST', '/api/conexoes/whatsapp/usar-de', s, { workspaceId: a })).status, 404);
  });
});
