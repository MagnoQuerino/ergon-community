/**
 * As conexões do computador na nuvem do Ergon World (world/sync-conexoes.ts), de ponta a ponta com DOIS Ergons de
 * verdade (o computador e o contêiner em modo nuvem), o World de mentira (fake-world.ts) e a Microsoft de mentira:
 * - nada sai antes do aceite; o WhatsApp e a conexão com endereço da rede local ficam de fora, com o motivo;
 * - com o aceite, a nuvem recebe as contas e a equipe usa (a mesma ferramenta, com o acesso que veio do computador);
 * - a posse da renovação: computador aberto, a nuvem não renova; fechado, renova e o acesso novo volta ao computador;
 * - desligar o interruptor, desconectar ou tirar o aceite no computador tira da nuvem, com a credencial;
 * - nada em claro no World (nem nas mudanças, nem nos envelopes), nos registros ou na auditoria.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { setIntegration, type IntegrationKind } from '../src/services/integrations.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc: Harness; let dono: Session; let nuvem: Harness; let sws = ''; let wsNuvem = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_WORKSPACE', 'ERGON_CLOUD_BOOT_TOKEN', 'ERGON_NUVEM_PASSO_MS', 'ERGON_NUVEM_CICLO_MS', 'ERGON_NUVEM_CANAIS_MS', 'ERGON_WORLD_AUTOSYNC_MS'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const control = { health: async () => true, accounts: async () => [], byok: async () => ({ providers: [], custom: [], ergonAi: true }), ergonAi: async () => undefined, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 30_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(40); }
  assert.fail(msg);
}

// os segredos desta história: nenhum deles pode aparecer em claro fora dos cofres
const SEGREDOS = ['acesso-do-pc-1', 'renovacao-do-pc-1', 'secret_notion_da_ana_0123456789abcdef', 'token-do-mattermost-local-0123456789', 'acesso-da-nuvem-', 'renovacao-da-nuvem-'];
// a Microsoft de mentira: a renovação gira o refresh token (como a de verdade); o Graph responde e conta quem chamou com que acesso
const realFetch = globalThis.fetch;
const ms = { renovacoes: [] as string[], graph: [] as string[] };
const registros: string[] = [];
const espiar = (h: Harness) => { for (const nivel of ['info', 'warn', 'error'] as const) { const orig = h.app.log[nivel].bind(h.app.log); h.app.log[nivel] = ((...a: unknown[]) => { registros.push(JSON.stringify(a)); return (orig as (...x: unknown[]) => void)(...a); }) as typeof h.app.log.info; } };

before(async () => {
  world = await new FakeWorld().start();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
      const b = new URLSearchParams(String(init?.body ?? ''));
      ms.renovacoes.push(b.get('refresh_token') ?? '');
      const n = ms.renovacoes.length;
      return new Response(JSON.stringify({ access_token: `acesso-da-nuvem-${n}`, refresh_token: `renovacao-da-nuvem-${n}`, expires_in: 3600, scope: 'Mail.Read' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      ms.graph.push(String(new Headers(init?.headers).get('authorization') ?? ''));
      return new Response(JSON.stringify({ value: [{ id: 'lista-1', displayName: 'Compras' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_NUVEM_PASSO_MS: '120', ERGON_NUVEM_CICLO_MS: '200', ERGON_NUVEM_CANAIS_MS: '20', ERGON_WORLD_AUTOSYNC_MS: '200' });
});
after(async () => {
  globalThis.fetch = realFetch;
  await nuvem?.close(); await pc?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const conectar = (h: Harness, ws: string, kind: IntegrationKind, cred: Record<string, unknown>, conta: string) => {
  h.integrations.secrets.writeOwn(ws, kind, cred, '');
  setIntegration(h.db, ws, kind, { state: 'connected', account_label: conta, connected_at: new Date().toISOString() });
};
const naNuvem = (kind: IntegrationKind) => nuvem.integrations.secrets.readOwn<Record<string, unknown>>(wsNuvem, kind);
const linhaNuvem = (kind: string) => nuvem.db.get<{ state: string; account_label: string | null }>("SELECT state, account_label FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ''", wsNuvem, kind);
const tela = async () => (await req(pc, 'GET', '/api/world/nuvem/conexoes', dono)).json as { disponivel: boolean; aceite: unknown; contas: Array<{ id: string; kind: string; estado: string; motivo: string | null; usar: boolean }> };

test('o computador conecta Microsoft, Notion, um Mattermost da rede local e o WhatsApp; a nuvem sobe e fica pronta', async () => {
  pc = await harness(); espiar(pc);
  dono = await setupOwner(pc, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc, 'POST', '/api/world/connect', dono, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc, 'POST', '/api/world/bind', dono, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc, 'POST', '/api/world/sync/enable', dono, { recoveryPhrase: 'frase de recuperação da ana para a nuvem' })).status, 200);
  world.activate(sws);
  conectar(pc, dono.workspaceId, 'microsoft', { access_token: 'acesso-do-pc-1', refresh_token: 'renovacao-do-pc-1', expires_at: Date.now() + 3_600_000, account: 'ana@empresa.com', granted: 'Mail.Read' }, 'ana@empresa.com');
  conectar(pc, dono.workspaceId, 'notion', { token: 'secret_notion_da_ana_0123456789abcdef' }, 'Notion da Ana');
  conectar(pc, dono.workspaceId, 'mattermost', { site: 'chat.escritorio.local', token: 'token-do-mattermost-local-0123456789' }, 'ana');
  setIntegration(pc.db, dono.workspaceId, 'whatsapp', { state: 'connected', account_label: '+55 71 99999-0000' });
  Object.assign(process.env, { ERGON_WORLD_WORKSPACE: sws, ERGON_CLOUD_BOOT_TOKEN: world.nuvem(sws) });
  nuvem = await harness({ mode: 'cloud' }, { control }); espiar(nuvem);
  await nuvem.app.ready();
  await ate(() => world.clouds.get(sws)!.states.at(-1) === 'pronto', `a nuvem não ficou pronta: ${JSON.stringify(world.clouds.get(sws)?.states)}`);
  wsNuvem = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
});

test('antes do aceite nada sai; a tela diz o que vai e o que fica de fora (com o motivo)', async () => {
  await pausa(800); // vários ciclos da sincronia automática
  assert.equal(world.workspaces.get(sws)!.changes.filter((c) => c.kind === 'conexoes').length, 0, 'sem o aceite, nenhuma credencial saiu');
  const t = await tela();
  assert.equal(t.disponivel, true); assert.equal(t.aceite, null);
  const por = Object.fromEntries(t.contas.map((c) => [c.kind, c]));
  assert.equal(por.microsoft.estado, 'aguardando_aceite'); assert.equal(por.notion.estado, 'aguardando_aceite');
  assert.deepEqual([por.mattermost.estado, por.mattermost.motivo], ['fora', 'endereco_local']);
  assert.deepEqual([por.whatsapp.estado, por.whatsapp.motivo], ['fora', 'whatsapp']);
  // as rotas pedem o dono e validam a entrada
  assert.equal((await req(pc, 'POST', '/api/world/nuvem/conexoes/aceite', dono, { ligar: 'sim' })).status, 400);
  assert.equal((await req(pc, 'PUT', '/api/world/nuvem/conexoes/int_naoexiste0000', dono, { usar: true })).status, 404);
  assert.equal((await req(pc, 'GET', '/api/world/nuvem/conexoes', null)).status, 401);
});

test('com o aceite, a nuvem recebe as contas e a equipe usa; o que fica de fora não vai', async () => {
  assert.equal((await req(pc, 'POST', '/api/world/nuvem/conexoes/aceite', dono, { ligar: true })).status, 200);
  await ate(() => linhaNuvem('microsoft')?.state === 'connected' && linhaNuvem('notion')?.state === 'connected', 'as conexões não chegaram à nuvem');
  assert.equal(linhaNuvem('microsoft')!.account_label, 'ana@empresa.com');
  assert.equal(naNuvem('notion')!.token, 'secret_notion_da_ana_0123456789abcdef');
  assert.equal(naNuvem('microsoft')!.refresh_token, 'renovacao-do-pc-1');
  assert.equal(naNuvem('mattermost'), null, 'endereço da rede local: fica de fora'); assert.notEqual(linhaNuvem('mattermost')?.state, 'connected');
  assert.notEqual(linhaNuvem('whatsapp')?.state, 'connected', 'o WhatsApp fica de fora');
  // a equipe usa a mesma ferramenta (as listas do To Do), com o acesso que veio do computador, sem renovar nada
  const listas = await nuvem.integrations.provider(wsNuvem, 'microsoft').listBoards();
  assert.ok(listas.some((l) => l.name === 'To Do › Compras'));
  assert.equal(ms.graph.at(-1), 'Bearer acesso-do-pc-1'); assert.equal(ms.renovacoes.length, 0);
  // no computador, a tela diz que a conta está na nuvem
  const t = await tela();
  assert.ok(['na_nuvem', 'enviando'].includes(t.contas.find((c) => c.kind === 'microsoft')!.estado));
  await ate(async () => (await tela()).contas.find((c) => c.kind === 'notion')!.estado === 'na_nuvem', 'a tela não disse "na nuvem"');
});

test('posse: com o computador aberto a nuvem não renova; fechado, renova e o acesso novo volta ao computador', async () => {
  // o acesso venceu na nuvem com o computador aberto: quem renova é o computador
  const c = naNuvem('microsoft')!;
  nuvem.integrations.secrets.writeOwn(wsNuvem, 'microsoft', { ...c, expires_at: Date.now() - 1000 }, '');
  await ate(() => world.pcAberto.get(sws) === true, 'o computador não avisou que está aberto');
  await pausa(400); // a nuvem lê a posse no World
  await assert.rejects(nuvem.integrations.sso.accessToken(wsNuvem, 'microsoft'), /computador .* aberto/);
  assert.equal(ms.renovacoes.length, 0, 'nenhuma renovação na nuvem');
  // o computador fecha: a posse passa à nuvem, que renova (o refresh token gira)
  const dir = pc.dir; await pc.close();
  assert.equal(world.pcAberto.get(sws), false);
  await ate(async () => { try { return (await nuvem.integrations.sso.accessToken(wsNuvem, 'microsoft')) === 'acesso-da-nuvem-1'; } catch { return false; } }, 'a nuvem não renovou com o computador fechado');
  assert.deepEqual(ms.renovacoes, ['renovacao-do-pc-1']);
  // a devolução vai ao World cifrada para o computador (sem o computador ligado)
  await ate(() => world.workspaces.get(sws)!.changes.filter((x) => x.kind === 'conexoes' && x.deviceId === world.clouds.get(sws)!.deviceId).length > 0, 'a nuvem não devolveu o acesso renovado');
  // o computador abre de novo e fica com o acesso renovado (o mais novo), sem renovar ele mesmo
  pc = await harness({}, { dir }); espiar(pc);
  await pc.app.ready();
  await ate(() => pc.integrations.secrets.read<{ refresh_token: string }>(dono.workspaceId, 'microsoft')?.refresh_token === 'renovacao-da-nuvem-1', 'o acesso renovado não chegou ao computador');
  const noPc = pc.integrations.secrets.read<Record<string, unknown>>(dono.workspaceId, 'microsoft')!;
  assert.equal(noPc.access_token, 'acesso-da-nuvem-1'); assert.equal(noPc.account, 'ana@empresa.com', 'só o acesso muda: a conta é a mesma');
  assert.equal(ms.renovacoes.length, 1);
});

test('desligar o interruptor, desconectar e tirar o aceite no computador tiram da nuvem, com a credencial', async () => {
  // a credencial que não se lê agora (Ergon trancado, arquivo sumido) não tira a conta da nuvem: o retrato espera
  const cred = pc.integrations.secrets.readOwn(dono.workspaceId, 'notion')!;
  pc.integrations.secrets.remove(dono.workspaceId, 'notion');
  await pausa(800);
  assert.equal(naNuvem('notion')?.token, 'secret_notion_da_ana_0123456789abcdef', 'credencial ilegível no computador não apaga na nuvem');
  pc.integrations.secrets.writeOwn(dono.workspaceId, 'notion', cred);
  const t = await tela();
  const mid = t.contas.find((c) => c.kind === 'microsoft')!.id;
  assert.equal((await req(pc, 'PUT', `/api/world/nuvem/conexoes/${mid}`, dono, { usar: false })).status, 200);
  await ate(() => naNuvem('microsoft') === null && linhaNuvem('microsoft')?.state === 'off', 'a Microsoft não saiu da nuvem');
  assert.equal(naNuvem('notion')!.token, 'secret_notion_da_ana_0123456789abcdef', 'as outras ficam');
  assert.equal((await tela()).contas.find((c) => c.kind === 'microsoft')!.estado, 'desligada');
  await pc.integrations.disconnect(dono.workspaceId, dono.userId, 'notion');
  await ate(() => naNuvem('notion') === null && linhaNuvem('notion')?.state === 'off', 'desconectar no computador não tirou da nuvem');
  // religa a Microsoft e tira o aceite: sai tudo
  assert.equal((await req(pc, 'PUT', `/api/world/nuvem/conexoes/${mid}`, dono, { usar: true })).status, 200);
  await ate(() => linhaNuvem('microsoft')?.state === 'connected', 'religada, não voltou');
  assert.equal((await req(pc, 'POST', '/api/world/nuvem/conexoes/aceite', dono, { ligar: false })).status, 200);
  await ate(() => naNuvem('microsoft') === null && !nuvem.db.get('SELECT 1 AS x FROM world_conexoes_recebidas WHERE workspace_id = ?', wsNuvem), 'sem o aceite, a nuvem não ficou vazia');
});

test('nada em claro: nem no World (mudanças e envelopes), nem nos registros, nem na auditoria', async () => {
  const doWorld = JSON.stringify([...world.workspaces.values()].map((w) => ({ changes: w.changes, envelopes: [...w.envelopes.values()] })));
  for (const s of SEGREDOS) assert.ok(!doWorld.includes(s), `em claro no World: ${s}`);
  assert.ok(world.workspaces.get(sws)!.changes.filter((c) => c.kind === 'conexoes').length >= 4);
  const logs = registros.join('\n');
  assert.ok(logs.includes('conexões: retrato enviado à nuvem'), 'os registros contam o que aconteceu (sem o conteúdo)');
  for (const s of SEGREDOS) assert.ok(!logs.includes(s), `em claro num registro: ${s}`);
  for (const h of [pc, nuvem]) {
    const aud = JSON.stringify(h.db.all('SELECT * FROM audit_events'));
    for (const s of SEGREDOS) assert.ok(!aud.includes(s), `em claro na auditoria: ${s}`);
    const estado = JSON.stringify(h.db.all('SELECT * FROM world_conexoes_nuvem'));
    for (const s of SEGREDOS) assert.ok(!estado.includes(s), `em claro no estado: ${s}`);
  }
});
