/**
 * Microsoft "de vez": ao conectar, o login emenda sozinho as etapas (base → Teams → leitura → canais), sem a pessoa voltar
 * para clicar de novo. Em conta de trabalho, a leitura só entra sozinha para quem aprova pela empresa (ou depois da aprovação do
 * administrador): para os outros, o primeiro login termina no básico e a leitura é pedida em "Liberar leitura". A etapa que a empresa só libera com o administrador não trava a conexão: o que já foi dado continua
 * valendo e a tela oferece o pedido pronto. Conta pessoal não tem Teams: pula as etapas dele. Os canais (sempre o administrador)
 * só entram no encadeamento quando se sabe que a conta aprova pela empresa (as funções de diretório no token, decisão de
 * 09/11); sem saber, a tela oferece o pedido. Sem rede: o login e o Graph simulados no formato documentado.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ESCOPOS_MICROSOFT } from '../src/services/conexoes/acoes/microsoft.ts';
import { FUNCOES_QUE_APROVAM, podeAprovarPelaEmpresa } from '../src/services/sso.ts';
import { FORA_DO_CONSENTIMENTO_DO_USUARIO } from '../src/services/conexoes/acoes/microsoft.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { consentimentoDe, integrationRow, setIntegration, settingsOf } from '../src/services/integrations.ts';

const MS_ID = '11111111-2222-3333-4444-555555555555';
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';
const TID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN_GLOBAL = '62e90394-69f5-4237-9190-012177145e10';
const USUARIO_COMUM = 'b79fbf4d-3ef9-4689-8143-76b194e85509';
const OIDC = ['openid', 'profile', 'offline_access'];
const jwt = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const escopos = (s: string | null | undefined) => (s ?? '').split(/\s+/).filter(Boolean);
const ADMIN_EXIGIDO = `error=access_denied&error_description=${encodeURIComponent('AADSTS90094: Admin consent is required for the permissions requested by this application.')}`;
const ADMIN_EXIGIDO_65001 = `error=invalid_client&error_description=${encodeURIComponent('AADSTS65001: The user or administrator has not consented to use the application.')}`;

/**
 * Tudo o que o primeiro login ("Entrar com a Microsoft") pode pedir numa conta de trabalho, fixado aqui: uma permissão nova nesta
 * lista é uma decisão, não um acidente. Nada de "precisa de administrador" na tabela oficial (permissions-reference) nem na lista
 * da política padrão gerenciada pela Microsoft (FORA_DO_CONSENTIMENTO_DO_USUARIO).
 */
const PRIMEIRO_LOGIN = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.Send', 'Files.ReadWrite',
  'Chat.ReadBasic', 'Chat.Create', 'ChatMessage.Send', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'];
/** nunca no primeiro login: "Admin consent required: Yes" (permissions-reference), barradas pela política padrão ou de alcance da empresa inteira */
const ADMIN_SEMPRE = ['ChannelMessage.Read.All', 'Group.Read.All', 'Group.ReadWrite.All', 'Sites.Read.All', 'Sites.ReadWrite.All', 'Directory.Read.All',
  'Directory.ReadWrite.All', 'User.Read.All', 'User.ReadBasic.All', 'TeamMember.Read.All', 'ChannelMember.Read.All', 'Files.Read.All', 'Files.ReadWrite.All', 'Mail.Read.Shared'];

type Token = Record<string, string>;
const tokenCalls: Token[] = [];
let tid = TID;
/** declarações extras do id_token e do acesso (para wids) */
let extraId: Record<string, unknown> = {};
let acessoJwt: Record<string, unknown> | null = null;
const realFetch = globalThis.fetch;
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 1 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    if (u.host === 'login.microsoftonline.com' && u.pathname.endsWith('/token')) {
      const b = Object.fromEntries(new URLSearchParams(String(init.body)));
      tokenCalls.push(b);
      const n = tokenCalls.length;
      return json({
        access_token: acessoJwt ? jwt(acessoJwt) : `acesso-${n}`, refresh_token: `renova-${n}`, expires_in: 3599,
        scope: escopos(b.scope).filter((e) => !OIDC.includes(e)).join(' '),
        id_token: jwt({ tid, preferred_username: 'ana@empresa.com', ...extraId }),
      });
    }
    if (u.host === 'graph.microsoft.com' && u.pathname === '/v1.0/me') return json({ mail: 'ana@empresa.com', userPrincipalName: 'ana@empresa.com', id: 'eu' });
    if (u.host === 'graph.microsoft.com') return json({ error: { code: 'NotFound' } }, 404);
    throw new TypeError(`rota não simulada: ${String(input)}`);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session;
beforeEach(async () => {
  h = await harness({ msClientId: MS_ID }); s = await setupOwner(h);
  tokenCalls.length = 0; tid = TID; extraId = {}; acessoJwt = null;
});
afterEach(() => h.close());

const comecar = async (corpo?: Record<string, unknown>) => new URL((await req(h, 'POST', '/api/integrations/microsoft/start', s, corpo)).json.url);
const voltar = async (state: string | null, resto: string) => h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?state=${state}&${resto}` });
/** devolve o código da etapa; a volta é a próxima página da Microsoft (URL) ou o aviso da tela (string) */
const aceitar = async (u: URL, code: string): Promise<URL | string> => {
  const loc = String((await voltar(u.searchParams.get('state'), `code=${code}`)).headers.location);
  return loc.startsWith('https://') ? new URL(loc) : loc;
};
const pagina = (x: URL | string): URL => { assert.ok(x instanceof URL, `esperava a próxima página da Microsoft, veio ${String(x)}`); return x; };
const conexao = async () => (await req(h, 'GET', '/api/conexoes', s)).json.ligadas.find((x: { kind: string }) => x.kind === 'microsoft') as {
  faltam: string[]; etapas: Array<{ id: string; estado: string; link: string | null; administrador: boolean; opcional: boolean; erro: string | null }>;
};
const etapas = async () => (await conexao()).etapas.map((e) => [e.id, e.estado]);
const etapa = async (id: string) => (await conexao()).etapas.find((e) => e.id === id)!;
const estado = async () => ((await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string }>).find((i) => i.kind === 'microsoft')!.state;
const cred = () => h.integrations.secrets.readOwn<Record<string, any>>(s.workspaceId, 'microsoft')!;

describe('conta de trabalho: tudo de uma vez', () => {
  test('sucesso total (quem aprova pela empresa): base, Teams (Chat.ReadBasic), leitura (Chat.Read) e canais em sequência, sem voltar à tela', async () => {
    extraId = { wids: [ADMIN_GLOBAL] };
    const base = await comecar();
    const teams = pagina(await aceitar(base, 'c1'));
    assert.ok(escopos(teams.searchParams.get('scope')).includes('Chat.ReadBasic'), 'o Teams vem logo depois');
    assert.equal(await estado(), 'connected', 'a primeira etapa já conectou');
    const leitura = pagina(await aceitar(teams, 'c2'));
    assert.ok(escopos(leitura.searchParams.get('scope')).includes('Chat.Read'), 'a leitura traz o conteúdo das conversas');
    const canais = pagina(await aceitar(leitura, 'c3'));
    assert.ok(escopos(canais.searchParams.get('scope')).includes('ChannelMessage.Read.All'), 'e, por último, os canais');
    assert.equal(canais.searchParams.get('login_hint'), 'ana@empresa.com', 'a mesma conta, sem escolher de novo');
    assert.equal(canais.searchParams.get('prompt'), null);
    assert.equal(await aceitar(canais, 'c4'), '/#conexoes?microsoft=conectado');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'ok']]);
    const dadas = new Set(escopos(cred().granted).map((x) => x.toLowerCase()));
    for (const e of ['Chat.ReadBasic', 'Chat.Read', 'ChannelMessage.Read.All', 'Mail.Send', 'Mail.Read']) assert.ok(dadas.has(e.toLowerCase()), e);
    assert.deepEqual((await conexao()).faltam, []);
  });

  test('"Liberar leitura" também emenda os canais (quem aprova pela empresa)', async () => {
    extraId = { wids: [ADMIN_GLOBAL] };
    const t = pagina(await aceitar(await comecar(), 'c1'));
    const l = pagina(await aceitar(t, 'c2'));
    await voltar(l.searchParams.get('state'), 'error=access_denied');
    const l2 = await comecar({ etapa: 'leitura' });
    const c = pagina(await aceitar(l2, 'c3'));
    assert.ok(escopos(c.searchParams.get('scope')).includes('ChannelMessage.Read.All'));
  });

  test('leitura negada pela política da empresa: o envio continua conectado e a tela oferece o pedido ao administrador', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    assert.equal(await aceitar(t, 'c2'), '/#conexoes?microsoft=basico', 'o primeiro login para no que a pessoa autoriza sozinha');
    assert.equal((await etapa('leitura')).estado, 'falta');
    const l = await comecar({ etapa: 'leitura' });
    const r = await voltar(l.searchParams.get('state'), ADMIN_EXIGIDO);
    assert.equal(String(r.headers.location), '/#conexoes?microsoft=sem-leitura', 'não vai para os canais, que dariam no mesmo');
    assert.equal(await estado(), 'connected');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'bloqueado'], ['canais', 'bloqueado']]);
    const leitura = await etapa('leitura');
    assert.equal(leitura.administrador, true);
    assert.match(leitura.link ?? '', /\/v2\.0\/adminconsent\?/);
    assert.equal(leitura.erro, 'A empresa exige a aprovação do administrador.');
    assert.ok((await etapa('canais')).link, 'os canais também com o pedido pronto');
    assert.deepEqual((await conexao()).faltam, [], 'nada de "Autorizar de novo" para o que só o administrador libera');
    // o que já foi dado segue funcionando
    const dadas = new Set(escopos(cred().granted).map((x) => x.toLowerCase()));
    for (const e of [...ESCOPOS_MICROSOFT.base, ...ESCOPOS_MICROSOFT.trabalho]) assert.ok(dadas.has(e.toLowerCase()), e);
    // entrar de novo depois: o primeiro login não leva de novo à página do administrador (a marca é "bloqueado", não "aprovado")
    // (a simulação devolve só o que cada etapa pede: a base recomeça do que a conta tem e passa pelo Teams de novo)
    const t2 = pagina(await aceitar(await comecar(), 'c3'));
    assert.equal(await aceitar(t2, 'c4'), '/#conexoes?microsoft=basico');
    // "Tentar de novo" na linha da leitura (o administrador pode ter aprovado); os canais não entram, porque não se sabe que esta
    // conta aprova pela empresa: o pedido ao administrador fica na tela
    const l3 = await comecar({ etapa: 'leitura' });
    assert.ok(escopos(l3.searchParams.get('scope')).includes('Mail.Read'), 'tenta a leitura de novo');
    assert.equal(await aceitar(l3, 'c5'), '/#conexoes?microsoft=sem-canais');
    assert.equal((await etapa('leitura')).estado, 'ok');
    assert.ok((await etapa('canais')).link, 'o pedido ao administrador pronto');
    assert.ok(!tokenCalls.some((b) => escopos(b.scope).includes('ChannelMessage.Read.All')), 'nem pediu os canais');
    // a mesma conta, agora sabidamente administradora (as funções de diretório no token): aí os canais entram; os que voltam
    // sem ser dados não são pedidos de novo
    extraId = { wids: [ADMIN_GLOBAL] };
    const t3 = pagina(await aceitar(await comecar(), 'c6'));
    const l4 = pagina(await aceitar(t3, 'c7'));
    const c3 = pagina(await aceitar(l4, 'c8'));
    assert.ok(escopos(c3.searchParams.get('scope')).includes('ChannelMessage.Read.All'), 'os canais nunca tinham sido pedidos');
    assert.equal(String((await voltar(c3.searchParams.get('state'), ADMIN_EXIGIDO)).headers.location), '/#conexoes?microsoft=sem-canais');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'bloqueado']]);
    const t4 = pagina(await aceitar(await comecar(), 'c9'));
    const l5 = pagina(await aceitar(t4, 'c10'));
    assert.equal(await aceitar(l5, 'c11'), '/#conexoes?microsoft=sem-canais', 'os canais já voltaram sem ser dados: o pedido fica na tela');
  });

  test('Teams negado pela política (AADSTS65001): o envio continua, e o Teams e a leitura mostram o pedido, não "Tentar de novo"', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    const r = await voltar(t.searchParams.get('state'), ADMIN_EXIGIDO_65001);
    assert.equal(String(r.headers.location), '/#conexoes?microsoft=precisa-admin');
    assert.equal(await estado(), 'connected');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'bloqueado'], ['leitura', 'bloqueado'], ['canais', 'bloqueado']]);
    const teams = await etapa('trabalho');
    assert.equal(teams.administrador, true);
    // o pedido do Teams é o da leitura, que pede também tudo o que vem antes
    const link = new URL(teams.link!);
    for (const e of ['Chat.ReadBasic', 'ChatMessage.Send', 'Mail.Read', 'Chat.Read']) assert.ok(escopos(link.searchParams.get('scope')).includes(`https://graph.microsoft.com/${e}`), e);
    assert.equal(link.searchParams.get('state')?.split('.')[1], 'leitura');
    assert.deepEqual((await conexao()).faltam, [], '"Autorizar de novo" não resolveria');
    // o agente diz o mesmo: pedir ao administrador, nunca autorizar de novo
    const a = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.conversas', {});
    assert.equal(a.ok, false);
    assert.match(a.texto, /administrador/); assert.doesNotMatch(a.texto, /Autorizar de novo/);
  });

  test('Teams bloqueado pela empresa e depois liberado: segue para a leitura; os canais, só sabendo que a conta aprova pela empresa', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    await voltar(t.searchParams.get('state'), ADMIN_EXIGIDO_65001);
    // o administrador aprovou; "Já aprovaram? Conectar de novo" na linha do Teams
    const t2 = await comecar({ etapa: 'trabalho' });
    const l = pagina(await aceitar(t2, 'c2'));
    assert.equal(await aceitar(l, 'c3'), '/#conexoes?microsoft=sem-canais', 'sem saber que é administradora, não leva aos canais');
    assert.deepEqual((await etapas()).slice(0, 3), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok']]);
    assert.ok((await etapa('canais')).link);
    // a pessoa que se sabe administradora: a marca dos canais veio junto do Teams, não de um pedido, então eles entram
    extraId = { wids: [ADMIN_GLOBAL] };
    const t3 = await comecar({ etapa: 'trabalho' });
    const c = pagina(await aceitar(t3, 'c4'));
    assert.ok(escopos(c.searchParams.get('scope')).includes('ChannelMessage.Read.All'));
    assert.equal(await aceitar(c, 'c5'), '/#conexoes?microsoft=conectado');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'ok']]);
  });

  test('pedir o Teams de novo antes da aprovação: a página que não volta não apaga que a empresa exige o administrador', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    await voltar(t.searchParams.get('state'), ADMIN_EXIGIDO_65001);
    await comecar({ etapa: 'trabalho' });
    assert.equal((await etapa('trabalho')).administrador, true, 'esperando a Microsoft, o pedido ao administrador continua');
    // a página da Microsoft ficou aberta (ou foi fechada) e não voltou: 11 minutos depois
    const r = integrationRow(h.db, s.workspaceId, 'microsoft');
    const c = consentimentoDe(r);
    const antigo = new Date(Date.now() - 11 * 60_000).toISOString();
    setIntegration(h.db, s.workspaceId, 'microsoft', { settings: { ...settingsOf(r), consentimento: { ...c, etapas: { ...c.etapas, trabalho: { ...c.etapas!.trabalho!, em: antigo } } } } });
    const teams = await etapa('trabalho');
    assert.equal(teams.estado, 'bloqueado');
    assert.equal(teams.administrador, true, 'continua sendo do administrador');
    assert.ok(teams.link, 'com o pedido pronto, não "Tentar de novo"');
    assert.deepEqual((await conexao()).faltam, []);
    const a = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.conversas', {});
    assert.match(a.texto, /administrador/); assert.doesNotMatch(a.texto, /Autorizar de novo/);
  });

  test('o administrador aprova pelo link (o da leitura, que cobre o Teams): o Teams também sai de "precisa do administrador"', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    await voltar(t.searchParams.get('state'), ADMIN_EXIGIDO_65001);
    const state = new URL((await etapa('trabalho')).link!).searchParams.get('state')!;
    const r = await h.app.inject({ method: 'GET', url: `/api/integrations/microsoft/callback?admin_consent=True&tenant=${TID}&state=${encodeURIComponent(state)}` });
    assert.equal(String(r.headers.location), '/#conexoes?microsoft=admin-aprovou');
    const teams = await etapa('trabalho');
    assert.equal(teams.estado, 'aprovado', 'falta só a pessoa entrar de novo');
    assert.equal(teams.link, null);
    assert.equal((await etapa('leitura')).estado, 'aprovado');
    // o agente manda autorizar (agora passa), não pedir ao administrador de novo
    const a = await h.conexoes.daPessoa(s.workspaceId, s.userId, 'microsoft', 'teams.conversas', {});
    assert.doesNotMatch(a.texto, /aprovação do administrador/);
  });

  test('recusar o Teams na página (sem exigência da empresa) continua sendo "Tentar de novo"', async () => {
    const t = pagina(await aceitar(await comecar(), 'c1'));
    assert.equal(String((await voltar(t.searchParams.get('state'), 'error=access_denied')).headers.location), '/#conexoes?microsoft=parcial');
    const teams = await etapa('trabalho');
    assert.equal(teams.administrador, false); assert.equal(teams.link, null);
  });

  test('o primeiro login de quem não aprova pela empresa nunca pede o que só o administrador libera; a leitura é incremental', async () => {
    const fora = new Set(FORA_DO_CONSENTIMENTO_DO_USUARIO.map((e) => e.toLowerCase()));
    const base = await comecar();
    // tudo o que o primeiro login manda à Microsoft, etapa por etapa, até voltar à tela
    const pedidos: URL[] = [base];
    let x: URL | string = await aceitar(base, 'c1');
    while (x instanceof URL) { pedidos.push(x); x = await aceitar(x, `c${pedidos.length + 1}`); }
    assert.equal(x, '/#conexoes?microsoft=basico');
    for (const u of pedidos) {
      const esc = escopos(u.searchParams.get('scope'));
      assert.deepEqual(esc.filter((e) => fora.has(e.toLowerCase()) || ADMIN_SEMPRE.includes(e) || /\.default$|^https?:/i.test(e)), [], u.href);
      assert.deepEqual(esc.filter((e) => !PRIMEIRO_LOGIN.includes(e)), [], 'só o que está fixado aqui');
      assert.notEqual(u.searchParams.get('prompt'), 'admin_consent');
      assert.equal(u.pathname, '/common/oauth2/v2.0/authorize', 'locatário common: conta pessoal e de trabalho');
    }
    // a leitura só sai quando a pessoa clica em "Liberar leitura"
    const l = await comecar({ etapa: 'leitura' });
    for (const e of ['Mail.Read', 'Calendars.ReadWrite', 'Tasks.ReadWrite', 'Chat.Read']) assert.ok(escopos(l.searchParams.get('scope')).includes(e), e);
    assert.ok(!escopos(l.searchParams.get('scope')).includes('ChannelMessage.Read.All'), 'os canais são outro pedido');
    // e os canais, só na linha deles
    assert.ok(escopos((await comecar({ etapa: 'canais' })).searchParams.get('scope')).includes('ChannelMessage.Read.All'));
  });

  test('o administrador já aprovou a leitura pelo link: o primeiro login segue até ela', async () => {
    assert.equal(await aceitar(pagina(await aceitar(await comecar(), 'c1')), 'c2'), '/#conexoes?microsoft=basico');
    const state = new URL((await etapa('leitura')).link!).searchParams.get('state')!;
    assert.match(String((await voltar(state, 'admin_consent=True')).headers.location), /microsoft=admin-aprovou$/);
    const l = pagina(await aceitar(pagina(await aceitar(await comecar(), 'c3')), 'c4'));
    assert.ok(escopos(l.searchParams.get('scope')).includes('Mail.Read'));
  });

  test('canais negados no fim do encadeamento: tudo o resto fica valendo, sem nada em vermelho na conexão', async () => {
    extraId = { wids: [ADMIN_GLOBAL] };
    const l = pagina(await aceitar(pagina(await aceitar(await comecar(), 'c1')), 'c2'));
    const c = pagina(await aceitar(l, 'c3'));
    assert.equal(String((await voltar(c.searchParams.get('state'), ADMIN_EXIGIDO)).headers.location), '/#conexoes?microsoft=sem-canais');
    assert.equal(await estado(), 'connected');
    const m = (await req(h, 'GET', '/api/integrations', s)).json.find((i: { kind: string }) => i.kind === 'microsoft');
    assert.equal(m.error, null);
    assert.deepEqual(await etapas(), [['base', 'ok'], ['trabalho', 'ok'], ['leitura', 'ok'], ['canais', 'bloqueado']]);
    assert.ok((await etapa('canais')).link);
  });
});

describe('quem aprova pela empresa', () => {
  test('a declaração wids decide; sem ela, não se sabe', () => {
    assert.equal(podeAprovarPelaEmpresa(jwt({ wids: [ADMIN_GLOBAL, USUARIO_COMUM] })), true);
    assert.equal(podeAprovarPelaEmpresa(jwt({ wids: [USUARIO_COMUM] })), false);
    assert.equal(podeAprovarPelaEmpresa(jwt({ tid: TID })), null);
    assert.equal(podeAprovarPelaEmpresa('opaco-de-conta-pessoal', undefined), null);
    // o primeiro token que traz a declaração vale
    assert.equal(podeAprovarPelaEmpresa(jwt({ tid: TID }), jwt({ wids: [ADMIN_GLOBAL.toUpperCase()] })), true);
    assert.equal(FUNCOES_QUE_APROVAM.size, 4);
  });

  test('conta que sabidamente não aprova: o encadeamento termina na leitura, sem a página sem saída dos canais', async () => {
    extraId = { wids: [USUARIO_COMUM] };
    assert.equal(await aceitar(pagina(await aceitar(await comecar(), 'c1')), 'c2'), '/#conexoes?microsoft=basico');
    const l = await comecar({ etapa: 'leitura' });
    assert.equal(await aceitar(l, 'c3'), '/#conexoes?microsoft=sem-canais');
    const c = await etapa('canais');
    assert.equal(c.estado, 'falta'); assert.ok(c.link, 'o pedido ao administrador já pronto');
    assert.ok(!tokenCalls.some((b) => escopos(b.scope).includes('ChannelMessage.Read.All')), 'nem pediu os canais');
  });

  test('sem saber se a conta aprova pela empresa (o token sem as funções de diretório): não leva aos canais; oferece o pedido', async () => {
    assert.equal(await aceitar(pagina(await aceitar(await comecar(), 'c1')), 'c2'), '/#conexoes?microsoft=basico');
    const l = await comecar({ etapa: 'leitura' });
    assert.equal(await aceitar(l, 'c3'), '/#conexoes?microsoft=sem-canais');
    const c = await etapa('canais');
    assert.equal(c.estado, 'falta'); assert.ok(c.link, 'o pedido ao administrador já pronto');
    assert.match(c.link!, /\/v2\.0\/adminconsent\?/);
    assert.ok(!tokenCalls.some((b) => escopos(b.scope).includes('ChannelMessage.Read.All')), 'nem pediu os canais');
    assert.deepEqual((await conexao()).faltam, [], 'nada de "Autorizar de novo": o que falta é do administrador');
    // pedir os canais de propósito (a pessoa clicou na linha deles) continua valendo
    const u = await comecar({ etapa: 'canais' });
    assert.ok(escopos(u.searchParams.get('scope')).includes('ChannelMessage.Read.All'));
  });

  test('administrador (wids no acesso, quando o id_token não traz): segue até os canais', async () => {
    acessoJwt = { tid: TID, wids: [ADMIN_GLOBAL] };
    const l = pagina(await aceitar(pagina(await aceitar(await comecar(), 'c1')), 'c2'));
    const c = pagina(await aceitar(l, 'c3'));
    assert.ok(escopos(c.searchParams.get('scope')).includes('ChannelMessage.Read.All'));
    assert.equal(await aceitar(c, 'c4'), '/#conexoes?microsoft=conectado');
    assert.equal((await etapa('canais')).estado, 'ok');
  });
});

describe('conta pessoal', () => {
  test('base e leitura, e acabou: nada do Teams nem dos canais', async () => {
    tid = MSA;
    const l = pagina(await aceitar(await comecar(), 'c1'));
    assert.ok(escopos(l.searchParams.get('scope')).includes('Mail.Read'));
    assert.ok(!escopos(l.searchParams.get('scope')).some((e) => /^(Chat|Channel|Team)/.test(e)));
    assert.equal(await aceitar(l, 'c2'), '/#conexoes?microsoft=conectado');
    assert.deepEqual(await etapas(), [['base', 'ok'], ['leitura', 'ok']]);
    assert.ok(!tokenCalls.some((b) => escopos(b.scope).some((e) => /^(Chat|Channel|Team)/.test(e))));
  });
});

describe('a conta no Entra (oid) para conferir a conta do Teams na ligação por código', () => {
  test('o login guarda o oid do id_token (em minúsculas) junto do locatário; sem oid no token, fica o de antes', async () => {
    const OID = ['ABCDEF01', '2345', '6789', 'ABCD', 'EF0123456789'].join('-');
    extraId = { oid: OID };
    await aceitar(await comecar(), 'c1');
    assert.equal(cred().tid, TID);
    assert.equal(cred().oid, OID.toLowerCase());
    extraId = { oid: 'não-é-um-guid' };
    await aceitar(await comecar(), 'c9');
    assert.equal(cred().oid, OID.toLowerCase(), 'oid inválido não apaga o que estava');
  });
});
