/**
 * Microsoft de verdade: o consentimento em etapas (A: o que a política padrão da Microsoft deixa o próprio usuário autorizar; B:
 * a leitura, que na empresa costuma pedir o administrador; C: os canais, sempre o administrador), o pedido ao administrador com o
 * link pronto, o "conectando…" que vence, o Teams sem becos (sem Chat.Read, a lista funciona e a leitura pede o administrador,
 * nunca "Autorizar de novo"), a conta pessoal sem Teams e a credencial de antes (todas as permissões numa etapa só) funcionando
 * sem novo login. Sem rede: o login e o Graph são simulados no formato documentado.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { integrationRow, setIntegration, settingsOf } from '../src/services/integrations.ts';
import { ACOES_MICROSOFT, ESCOPOS_MICROSOFT, FORA_DO_CONSENTIMENTO_DO_USUARIO } from '../src/services/conexoes/acoes/microsoft.ts';
import { setHttpClock } from '../src/lib/http.ts';

const MS_ID = '11111111-2222-3333-4444-555555555555';
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';
const TID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OIDC = ['openid', 'profile', 'offline_access'];
const idToken = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const lower = (l: string[]) => l.map((x) => x.toLowerCase());
const escoposDoPedido = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean);
/** o que as versões anteriores pediam de uma vez só (etapa base + a do Teams), e o que a Microsoft devolvia */
const PEDIDO_ANTIGO = 'openid profile offline_access User.Read Tasks.ReadWrite Mail.Read Mail.ReadWrite Mail.Send Calendars.Read Calendars.ReadWrite Files.ReadWrite Files.Read.All People.Read Chat.Read Chat.Create ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send';
const DADO_ANTIGO = 'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Calendars.ReadWrite Channel.ReadBasic.All ChannelMessage.Send Chat.Create https://graph.microsoft.com/Chat.Read ChatMessage.Send Files.Read.All Files.ReadWrite Mail.Read Mail.ReadWrite Mail.Send People.Read Tasks.ReadWrite Team.ReadBasic.All User.Read profile openid email';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// a tela de Conexões e os textos dela (os avisos da volta do login saíram para web/src/lib/textos-tela.ts)
const tela = (() => {
  try {
    const ler = (f: string) => { try { return fs.readFileSync(path.join(RAIZ, f), 'utf8'); } catch { return ''; } };
    return fs.readFileSync(path.join(RAIZ, 'web/src/views/ConexoesView.tsx'), 'utf8') + ler('web/src/lib/textos-tela.ts');
  } catch { return null; }
})();

type Token = Record<string, string>;
const tokenCalls: Token[] = [];
const graphCalls: string[] = [];
/** resposta do login para cada troca (padrão: devolve só o que a etapa pediu, sem os do OpenID) */
let respostaToken: (b: Token, n: number) => Response;
let tid = TID;
let graph: Array<[RegExp, (u: URL) => Response]> = [];
const realFetch = globalThis.fetch;
const padrao = (b: Token, n: number) => json({
  access_token: `acesso-${n}`, refresh_token: `renova-${n}`, expires_in: 3599,
  scope: escoposDoPedido(b.scope).filter((e) => !OIDC.includes(e)).join(' '),
  id_token: idToken({ tid, preferred_username: 'ana@empresa.com' }),
});
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 1 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    if (u.host === 'login.microsoftonline.com' && u.pathname.endsWith('/token')) {
      const b = Object.fromEntries(new URLSearchParams(String(init.body)));
      tokenCalls.push(b);
      return respostaToken(b, tokenCalls.length);
    }
    if (u.host === 'graph.microsoft.com') {
      graphCalls.push(decodeURIComponent(u.pathname + u.search));
      const r = graph.find(([re]) => re.test(decodeURIComponent(u.pathname + u.search)));
      if (r) return r[1](u);
      if (u.pathname === '/v1.0/me') return json({ mail: 'ana@empresa.com', userPrincipalName: 'ana@empresa.com', id: 'eu' });
      return json({ error: { code: 'NotFound' } }, 404);
    }
    throw new TypeError(`rota não simulada: ${String(input)}`);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session;
beforeEach(async () => {
  h = await harness({ msClientId: MS_ID }); s = await setupOwner(h);
  tokenCalls.length = 0; graphCalls.length = 0; graph = []; tid = TID; respostaToken = padrao;
});
afterEach(() => h.close());

const ligar = (cred: Record<string, unknown>) => {
  h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3_600_000, ...cred });
  setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: String(cred.account ?? 'ana@empresa.com'), connected_at: new Date().toISOString() });
};
const cred = () => h.integrations.secrets.readOwn<Record<string, any>>(s.workspaceId, 'microsoft')!;
const conexao = async () => (await req(h, 'GET', '/api/conexoes', s)).json.ligadas.find((x: { kind: string }) => x.kind === 'microsoft') as {
  faltam: string[]; acoes: Array<{ id: string }>; etapas: Array<{ id: string; estado: string; link: string | null; administrador: boolean; opcional: boolean; erro: string | null }>;
};
const etapa = async (id: string) => (await conexao()).etapas.find((e) => e.id === id)!;
const microsoft = async () => (await req(h, 'GET', '/api/integrations', s)).json.find((i: { kind: string }) => i.kind === 'microsoft');
const comecar = async (corpo?: Record<string, unknown>) => new URL((await req(h, 'POST', '/api/integrations/microsoft/start', s, corpo)).json.url);
const voltar = async (q: string) => h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?${q}` });
const A_TRABALHO = [...ESCOPOS_MICROSOFT.base, ...ESCOPOS_MICROSOFT.trabalho];

describe('etapa A: só o que a política padrão da Microsoft deixa o próprio usuário autorizar', () => {
  test('nenhum escopo da lista de exceções; a leitura é exatamente o que fica de fora', async () => {
    const fora = new Set(lower(FORA_DO_CONSENTIMENTO_DO_USUARIO));
    assert.deepEqual(A_TRABALHO.filter((e) => fora.has(e.toLowerCase())), [], 'etapa A');
    // tudo da leitura está na lista: é por isso que ela pode pedir o administrador (e a tela diz isso)
    assert.deepEqual([...ESCOPOS_MICROSOFT.leitura, ...ESCOPOS_MICROSOFT.leituraTrabalho].filter((e) => !fora.has(e.toLowerCase())), []);
    // o primeiro login e a etapa do Teams, como saem para a Microsoft
    const base = await comecar();
    assert.deepEqual(escoposDoPedido(base.searchParams.get('scope')).filter((e) => fora.has(e.toLowerCase())), []);
    const r = await voltar(`state=${base.searchParams.get('state')}&code=c1`);
    const trabalho = new URL(String(r.headers.location));
    assert.match(trabalho.searchParams.get('scope') ?? '', /Chat\.ReadBasic/);
    assert.deepEqual(escoposDoPedido(trabalho.searchParams.get('scope')).filter((e) => fora.has(e.toLowerCase())), [], 'a etapa do Teams também');
  });
});

describe('a soma do que foi dado e a renovação', () => {
  test('cada etapa soma ao que já estava dado; a renovação pede só isso, nunca a leitura que ficou de fora', async () => {
    const base = await comecar();
    const t = new URL(String((await voltar(`state=${base.searchParams.get('state')}&code=c1`)).headers.location));
    // a Microsoft devolve, na etapa do Teams, só o que ela pediu de novo: o de antes não pode se perder
    respostaToken = (b, n) => json({ access_token: `acesso-${n}`, refresh_token: `renova-${n}`, expires_in: 3599, scope: ESCOPOS_MICROSOFT.trabalho.join(' '), id_token: idToken({ tid, preferred_username: 'ana@empresa.com' }) });
    const leitura = new URL(String((await voltar(`state=${t.searchParams.get('state')}&code=c2`)).headers.location));
    assert.match(leitura.searchParams.get('scope') ?? '', /Mail\.Read/, 'segue para a leitura');
    assert.deepEqual(new Set(lower(escoposDoPedido(cred().granted))), new Set(lower(A_TRABALHO)), 'a soma das etapas A');
    // a empresa exige o administrador: a pessoa volta sem dar a leitura
    const nao = await voltar(`state=${leitura.searchParams.get('state')}&error=access_denied&error_description=AADSTS90094%3A+The+grant+requires+admin+permission.`);
    assert.match(String(nao.headers.location), /microsoft=sem-leitura/);
    assert.equal((await microsoft()).state, 'connected', 'a etapa A continua valendo');
    assert.equal((await etapa('leitura')).estado, 'bloqueado');
    assert.deepEqual((await conexao()).faltam, [], 'nada de "Autorizar de novo" para o que só o administrador libera');
    // a renovação
    h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { ...cred(), expires_at: Date.now() - 1000 });
    tokenCalls.length = 0;
    respostaToken = padrao;
    await h.integrations.sso.accessToken(s.workspaceId, 'microsoft');
    const pedido = new Set(lower(escoposDoPedido(tokenCalls[0].scope)));
    assert.equal(tokenCalls[0].grant_type, 'refresh_token');
    assert.deepEqual(pedido, new Set(lower([...OIDC, ...A_TRABALHO])), 'só o que a conta deu');
    for (const fora of ['Mail.Read', 'Chat.Read', 'ChannelMessage.Read.All']) assert.ok(!pedido.has(fora.toLowerCase()), fora);
  });
});

describe('pedido ao administrador', () => {
  test('link v2 com o locatário da pessoa, o app, escopos explícitos, o redirect registrado e um state que não muda', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: A_TRABALHO.join(' ') });
    const l = await etapa('leitura');
    assert.equal(l.administrador, true);
    const u = new URL(l.link!);
    assert.equal(u.origin, 'https://login.microsoftonline.com');
    assert.equal(u.pathname, `/${TID}/v2.0/adminconsent`);
    assert.equal(u.searchParams.get('client_id'), MS_ID);
    assert.equal(u.searchParams.get('redirect_uri'), h.integrations.sso.redirectUri('microsoft'));
    assert.match(u.searchParams.get('redirect_uri')!, /^http:\/\/localhost(:\d+)?\/api\/integrations\/microsoft\/callback$/, 'o registrado no app (a porta não conta em localhost)');
    const esc = escoposDoPedido(u.searchParams.get('scope'));
    assert.ok(!esc.some((e) => /\.default/.test(e)), 'nunca /.default');
    for (const e of [...ESCOPOS_MICROSOFT.leitura, 'Chat.Read', 'Mail.Send']) assert.ok(esc.includes(`https://graph.microsoft.com/${e}`), e);
    assert.ok(!esc.includes('https://graph.microsoft.com/ChannelMessage.Read.All'), 'os canais são outro pedido');
    assert.match(u.searchParams.get('state')!, /^[A-Za-z0-9_-]{20,64}\.leitura$/);
    assert.equal((await etapa('leitura')).link, l.link, 'o link pronto na tela não muda a cada leitura');
    const c = new URL((await etapa('canais')).link!);
    assert.ok(escoposDoPedido(c.searchParams.get('scope')).includes('https://graph.microsoft.com/ChannelMessage.Read.All'));
    assert.equal((await etapa('canais')).opcional, true);
    // sem o locatário guardado (credencial de antes): "organizations", nunca "common"
    ligar({ account: 'ana@empresa.com', pessoal: false, granted: A_TRABALHO.join(' ') });
    assert.equal(new URL((await etapa('leitura')).link!).pathname, '/organizations/v2.0/adminconsent');
    if (tela) for (const t of ['Pedir ao administrador', 'Já aprovaram? Conectar de novo', 'é esperado', 'nada sai daqui sozinho']) assert.ok(tela.includes(t), t);
  });

  test('admin_consent=True é só um atalho: marca "aprovado", e a tela oferece "Autorizar agora"', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: A_TRABALHO.join(' ') });
    const state = new URL((await etapa('leitura')).link!).searchParams.get('state')!;
    const r = await voltar(`admin_consent=True&tenant=${TID}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent('https://graph.microsoft.com/Mail.Read')}`);
    assert.match(String(r.headers.location), /#conexoes\?microsoft=admin-aprovou$/);
    assert.equal((await etapa('leitura')).estado, 'aprovado');
    if (tela) assert.ok(tela.includes('Autorizar agora'));
    // "Autorizar agora" / "Já aprovaram? Conectar de novo": o login incremental da etapa, com a mesma conta
    const u = await comecar({ etapa: 'leitura' });
    assert.match(u.searchParams.get('scope') ?? '', /Mail\.Read/); assert.equal(u.searchParams.get('login_hint'), 'ana@empresa.com');
    const fim = await voltar(`state=${u.searchParams.get('state')}&code=c9`);
    // depois da leitura, os canais não entram no encadeamento: não se sabe que esta conta aprova pela empresa (o token não traz
    // as funções de diretório), e a tela oferece o pedido ao administrador
    assert.match(String(fim.headers.location), /microsoft=sem-canais$/);
    assert.equal((await etapa('leitura')).estado, 'ok');
    assert.notEqual((await etapa('canais')).estado, 'ok');
    // pedidos de propósito (a pessoa clicou na linha dos canais): a Microsoft devolve sem eles (só o administrador aprova)
    const canais = await comecar({ etapa: 'canais' });
    assert.ok(escoposDoPedido(canais.searchParams.get('scope')).includes('ChannelMessage.Read.All'));
    const semCanais = await voltar(`state=${canais.searchParams.get('state')}&error=access_denied&error_description=${encodeURIComponent('AADSTS90094: Admin consent is required.')}`);
    assert.match(String(semCanais.headers.location), /microsoft=sem-canais$/);
    assert.equal((await etapa('canais')).estado, 'bloqueado');
    // state desconhecido (não é de nenhum Ergon daqui): nada muda e o aviso é neutro, sem mandar clicar no que não existe
    assert.match(String((await voltar('admin_consent=True&state=outro-state-qualquer-123456.leitura')).headers.location), /admin-aprovou-outro$/);
    // neutro: sem citar o nome de um botão (no primeiro login bloqueado ele se chama "Já aprovaram? Entrar de novo")
    if (tela) {
      assert.ok(tela.includes('Quem pediu já pode entrar de novo'), 'o aviso neutro na tela');
      assert.ok(!tela.includes('Quem pediu já pode clicar em'), 'sem mandar clicar num botão que pode ter outro nome');
    }
    // no link do administrador, só os escopos do OpenID que a página aceita
    assert.ok(!escoposDoPedido(new URL((await etapa('canais')).link!).searchParams.get('scope')).includes('offline_access'));
    // recusa do administrador: a tela diz
    const c = new URL((await etapa('canais')).link!).searchParams.get('state')!;
    assert.match(String((await voltar(`admin_consent=True&error=consent_required&error_description=AADSTS65004&state=${encodeURIComponent(c)}`)).headers.location), /admin-recusou/);
    assert.equal((await etapa('canais')).estado, 'bloqueado');
  });
});

describe('a mesma permissão escrita de outro jeito', () => {
  test('"mail.read", "https://graph.microsoft.com/Mail.Read" e o id do Graph na frente contam igual', () => {
    const acao = (id: string) => ACOES_MICROSOFT.find((a) => a.id === id)!;
    for (const granted of ['https://graph.microsoft.com/Mail.Read 00000003-0000-0000-c000-000000000000/Calendars.Read User.Read', 'mail.read calendars.read user.read']) {
      ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted });
      assert.deepEqual(h.conexoes.faltam(s.workspaceId, 'microsoft', acao('email.buscar')), [], granted);
      assert.deepEqual(h.conexoes.faltam(s.workspaceId, 'microsoft', acao('agenda.listar')), [], granted);
      assert.deepEqual(h.conexoes.faltam(s.workspaceId, 'microsoft', acao('email.enviar')), ['Mail.Send'], granted);
    }
  });
});

describe('Teams sem becos', () => {
  test('sem Chat.Read: a lista de conversas funciona sem a prévia, e ler pede o administrador com o link, nunca "Autorizar de novo"', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: A_TRABALHO.join(' ') });
    graph = [[/\/me\/chats\?/, (u) => (/lastMessagePreview/.test(u.searchParams.get('$expand') ?? '') ? json({ error: { code: 'Forbidden' } }, 403)
      : json({ value: [{ id: '19:aaa@unq.gbl.spaces', chatType: 'oneOnOne', members: [{ displayName: 'Ana' }, { displayName: 'Bia Lima' }] }] }))]];
    const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.conversas', {});
    assert.equal(r.ok, true, r.texto);
    assert.match(r.texto, /chat=19:aaa@unq\.gbl\.spaces \| 1:1 \| Ana, Bia Lima/);
    assert.match(r.texto, /Sem a prévia/); assert.doesNotMatch(r.texto, /última:/);
    assert.ok(graphCalls.every((c) => !/lastMessagePreview/.test(c.split('$expand=')[1]?.split('&')[0] ?? '')), 'sabendo que falta a leitura, nem pede a prévia');
    const ler = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.ler', { chat: '19:aaa@unq.gbl.spaces' });
    assert.equal(ler.ok, false); assert.equal(ler.autorizar, false);
    assert.match(ler.texto, /aprovação do administrador da empresa/);
    assert.match(ler.texto, /https:\/\/login\.microsoftonline\.com\/[^ ]+\/v2\.0\/adminconsent\?/);
    assert.doesNotMatch(ler.texto, /Autorizar de novo/);
    // o teste da tela: nada aponta "Autorizar de novo", e a leitura diz o administrador
    const itens = (await req(h, 'POST', '/api/conexoes/microsoft/testar', s, {})).json.itens as Array<{ nome: string; ok: boolean; detalhe: string }>;
    assert.ok(!itens.some((x) => x.detalhe.startsWith('falta autorizar de novo')), JSON.stringify(itens));
    assert.ok(itens.some((x) => x.detalhe.startsWith('precisa da aprovação do administrador da empresa')));
    assert.ok(itens.some((x) => x.nome === 'lista as conversas do Teams, das mais recentes para as mais antigas' && x.ok));
  });

  test('canais: ação própria, que só a etapa opcional libera', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: [...A_TRABALHO, ...ESCOPOS_MICROSOFT.leitura, 'Chat.Read'].join(' ') });
    const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.ler_canal', { time: '172b0cce-e65d-44ce-9a49-91d9f2e8493a', canal: '19:geral@thread.tacv2' });
    assert.equal(r.ok, false); assert.match(r.texto, /canais do Teams/); assert.match(r.texto, /administrador/); assert.doesNotMatch(r.texto, /Autorizar de novo/);
    assert.equal(graphCalls.length, 0, 'nada vai ao Graph sem a permissão');
    assert.deepEqual((await conexao()).etapas.map((e) => [e.id, e.estado]), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'falta']]);
  });
});

describe('conta pessoal', () => {
  test('sem a marca, o domínio de consumidor basta: o Teams não aparece, e a leitura é ela quem libera', async () => {
    ligar({ account: 'eu@hotmail.com', granted: ESCOPOS_MICROSOFT.base.join(' ') });
    const c = await conexao();
    assert.deepEqual(c.acoes.filter((a) => a.id.startsWith('teams.')), []);
    assert.deepEqual(c.etapas.map((e) => e.id), ['base', 'leitura'], 'sem Teams nem canais');
    assert.equal(c.etapas[1].administrador, false); assert.equal(c.etapas[1].link, null);
    assert.deepEqual(c.faltam, []);
    const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'email.buscar', {});
    assert.match(r.texto, /Liberar leitura/); assert.doesNotMatch(r.texto, /administrador|Autorizar de novo/);
    const t = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.conversas', {});
    assert.match(t.texto, /não tem a ação/, 'nem existe para conta pessoal');
    // a marca gravada no login vale mais que o domínio
    ligar({ account: 'eu@hotmail.com', pessoal: false, tid: TID, granted: ESCOPOS_MICROSOFT.base.join(' ') });
    assert.ok((await conexao()).acoes.some((a) => a.id === 'teams.conversas'));
  });

  test('login de conta pessoal: depois da base, a leitura, e nada do Teams', async () => {
    tid = MSA;
    const base = await comecar();
    const prox = new URL(String((await voltar(`state=${base.searchParams.get('state')}&code=c1`)).headers.location));
    const pedido = escoposDoPedido(prox.searchParams.get('scope'));
    assert.ok(pedido.includes('Mail.Read'));
    assert.ok(!pedido.some((e) => /^(Chat|Channel|Team)/.test(e)), pedido.join(' '));
    assert.match(String((await voltar(`state=${prox.searchParams.get('state')}&code=c2`)).headers.location), /microsoft=conectado/);
    assert.equal(cred().pessoal, true);
  });
});

describe('o "conectando…"', () => {
  test('vence em 10 minutos, com o motivo; antes disso, continua', async () => {
    await comecar();
    assert.equal((await microsoft()).state, 'pending');
    const antes = (min: number) => {
      const r = integrationRow(h.db, s.workspaceId, 'microsoft');
      setIntegration(h.db, s.workspaceId, 'microsoft', { settings: { ...settingsOf(r), pendenteDesde: new Date(Date.now() - min * 60_000).toISOString() } });
    };
    antes(9);
    assert.equal((await microsoft()).state, 'pending');
    antes(11);
    const m = await microsoft();
    assert.equal(m.state, 'off'); assert.match(m.error, /não terminou em 10 minutos/); assert.match(m.error, /Entrar com a Microsoft/);
    // com a credencial de antes e a conexão caída (autorização vencida): volta como estava — caída, com o motivo de antes
    h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000, account: 'ana@empresa.com' });
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'error', last_error: 'A autorização da Microsoft venceu: entre de novo.' });
    await comecar();
    antes(11);
    const m2 = await microsoft();
    assert.equal(m2.state, 'error', 'continua caída, nunca "conectada"'); assert.match(m2.error, /não terminou em 10 minutos/); assert.match(m2.error, /A autorização da Microsoft venceu: entre de novo/);
    assert.doesNotMatch(m2.error, /continua valendo/);
    // o mesmo ao cancelar na página da Microsoft
    const u = await comecar();
    const r = await voltar(`error=access_denied&state=${u.searchParams.get('state')}`);
    assert.match(String(r.headers.location), /microsoft=recusado/);
    assert.equal((await microsoft()).state, 'error');
    // conectada de verdade: autorizar de novo nem passa por "conectando…", então nada derruba a conexão
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', last_error: null });
    await comecar();
    antes(11);
    assert.equal((await microsoft()).state, 'connected');
  });

  test('empresa que exige o administrador já no primeiro login: o cartão desconectado mostra o pedido pronto', async () => {
    const u = await comecar();
    const r = await voltar(`error=access_denied&error_description=${encodeURIComponent('AADSTS90094: Administrator consent is required.')}&state=${u.searchParams.get('state')}`);
    assert.match(String(r.headers.location), /microsoft=admin-base$/);
    const m = await microsoft();
    assert.equal(m.state, 'off');
    assert.ok(m.adminBase, 'o pedido ao administrador aparece sem conta conectada');
    const l = new URL(m.adminBase.link);
    assert.equal(l.pathname, '/organizations/v2.0/adminconsent');
    for (const e of [...ESCOPOS_MICROSOFT.base, ...ESCOPOS_MICROSOFT.leitura]) assert.ok(escoposDoPedido(l.searchParams.get('scope')).includes(`https://graph.microsoft.com/${e}`), e);
    // a marca e o cartão guardam o motivo em português; o erro cru da Microsoft fica só na evidência da auditoria
    assert.equal(m.adminBase.erro, 'A empresa exige a aprovação do administrador.');
    assert.equal(m.error, null, 'um passo esperado: nada em vermelho no cartão');
    for (const t of [m.adminBase.erro, m.error ?? '']) assert.doesNotMatch(t, /AADSTS|access_denied|consent is required/i);
    const ev = h.db.get<{ evidence: string; result: string }>("SELECT evidence, result FROM audit_events WHERE action = 'integration.connect.error' ORDER BY created_at DESC LIMIT 1")!;
    assert.match(ev.evidence, /AADSTS90094/, 'a evidência do que a Microsoft disse fica no registro');
    assert.doesNotMatch(ev.result, /AADSTS/);
    // o administrador aprovou pelo link do cartão desconectado: o aviso cita o botão que existe ("Já aprovaram? Entrar de novo")
    const aprovou = await voltar(`admin_consent=True&tenant=${TID}&state=${encodeURIComponent(l.searchParams.get('state')!)}`);
    assert.match(String(aprovou.headers.location), /#conexoes\?microsoft=admin-aprovou-base$/);
    // cancelar sem o código de administrador não é isso
    const u2 = await comecar();
    await voltar(`error=access_denied&state=${u2.searchParams.get('state')}`);
    assert.ok((await microsoft()).adminBase, 'a marca de antes fica até um login dar certo');
    assert.equal((await microsoft()).error, 'A autorização foi recusada na página da conta.');
    // outro código da Microsoft: em português, com o código só como referência para o suporte
    const u4 = await comecar();
    await voltar(`error=invalid_request&error_description=${encodeURIComponent('AADSTS50020: User account from identity provider does not exist in tenant.')}&state=${u4.searchParams.get('state')}`);
    assert.equal((await microsoft()).error, 'A Microsoft não concluiu a autorização (código AADSTS50020, para o suporte).');
    // o administrador aprovou e a pessoa entrou: a marca sai
    const u3 = await comecar();
    assert.equal((await voltar(`state=${u3.searchParams.get('state')}&code=c1`)).statusCode, 302); // segue para a próxima etapa
    assert.equal((await microsoft()).state, 'connected');
    assert.equal((await microsoft()).adminBase, null);
    if (tela) for (const t of ['A sua empresa precisa aprovar o Ergon', 'Já aprovaram? Entrar de novo']) assert.ok(tela.includes(t), t);
  });

  test('outra conta entrou no workspace: as marcas das etapas da conta de antes não valem para ela', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: A_TRABALHO.join(' ') });
    const st = new URL((await etapa('leitura')).link!).searchParams.get('state')!;
    await voltar(`admin_consent=True&tenant=${TID}&state=${encodeURIComponent(st)}`);
    assert.equal((await etapa('leitura')).estado, 'aprovado');
    respostaToken = (b, n) => json({
      access_token: `acesso-${n}`, refresh_token: `renova-${n}`, expires_in: 3599,
      scope: escoposDoPedido(b.scope).filter((e) => !OIDC.includes(e) && !ESCOPOS_MICROSOFT.leitura.includes(e)).join(' '),
      id_token: idToken({ tid, preferred_username: 'bia@empresa.com' }),
    });
    graph = [[/^\/v1\.0\/me(\?|$)/, () => json({ mail: 'bia@empresa.com', userPrincipalName: 'bia@empresa.com', id: 'bia' })]];
    const u = await comecar();
    await voltar(`state=${u.searchParams.get('state')}&code=c2`);
    assert.equal(cred().account, 'bia@empresa.com');
    assert.notEqual((await etapa('leitura')).estado, 'aprovado', 'a aprovação era para a conta de antes');
  });

  test('a etapa pedida que não voltou em 10 minutos vira pedido ao administrador', async () => {
    ligar({ account: 'ana@empresa.com', tid: TID, pessoal: false, granted: A_TRABALHO.join(' ') });
    await comecar({ etapa: 'leitura' });
    assert.equal((await etapa('leitura')).estado, 'pedido');
    const r = integrationRow(h.db, s.workspaceId, 'microsoft');
    const st = settingsOf(r) as { consentimento: { etapas: Record<string, { em: string }> } };
    st.consentimento.etapas.leitura.em = new Date(Date.now() - 11 * 60_000).toISOString();
    setIntegration(h.db, s.workspaceId, 'microsoft', { settings: st });
    const l = await etapa('leitura');
    assert.equal(l.estado, 'bloqueado'); assert.match(l.erro ?? '', /não voltou/); assert.ok(l.link);
    assert.equal((await req(h, 'POST', '/api/integrations/microsoft/start', s, { etapa: 'outra' })).status, 400);
  });
});

describe('a conexão de antes', () => {
  test('a credencial no formato atual (tudo numa etapa só) segue funcionando, sem novo login', async () => {
    ligar({ account: 'dono@empresa.com.br', pessoal: false, scopes: PEDIDO_ANTIGO, granted: DADO_ANTIGO, refresh_token: 'renova-dono', expires_at: Date.now() - 1000 });
    const c = await conexao();
    assert.deepEqual(c.faltam, [], 'nenhum "Autorizar de novo"');
    assert.deepEqual(c.etapas.map((e) => [e.id, e.estado]), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'falta']], 'só os canais, que são opcionais e novos');
    assert.ok(c.acoes.some((a) => a.id === 'teams.ler'));
    graph = [[/\/me\/chats\/19:x@thread\.v2\/messages/, () => json({ value: [{ messageType: 'message', createdDateTime: '2026-11-07T12:00:00Z', from: { user: { displayName: 'Bia' } }, body: { contentType: 'text', content: 'oi' } }] })]];
    const r = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.ler', { chat: '19:x@thread.v2' });
    assert.equal(r.ok, true, r.texto); assert.match(r.texto, /Bia: oi/);
    // o acesso tinha vencido: renovou pedindo só o que a conta deu (no nome curto), sem nada novo
    assert.equal(tokenCalls.length, 1); assert.equal(tokenCalls[0].grant_type, 'refresh_token'); assert.equal(tokenCalls[0].refresh_token, 'renova-dono');
    const pedido = escoposDoPedido(tokenCalls[0].scope);
    const dado = new Set(lower([...OIDC, ...escoposDoPedido(DADO_ANTIGO).map((e) => e.replace('https://graph.microsoft.com/', ''))]));
    assert.ok(pedido.every((e) => dado.has(e.toLowerCase())), pedido.join(' '));
    assert.ok(!pedido.includes('ChannelMessage.Read.All'));
    assert.equal((await microsoft()).state, 'connected');
    assert.equal(cred().tid, TID, 'o locatário veio na renovação, para o link do administrador');
  });
});
