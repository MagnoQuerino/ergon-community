/**
 * Quem manda na equipe é a conta DONA do workspace (revisão de segurança antes do lançamento, rc.41):
 * - o World diz o autor de cada mudança (conta e tipo do aparelho); o esqueleto da equipe (com a parte privada:
 *   ferramentas, rotinas e a configuração delas) só é aplicado vindo de um aparelho da conta dona;
 * - o computador de um colaborador honesto não manda o esqueleto; um forjado por ele (ele tem a chave do workspace) é
 *   ignorado no computador da dona e na nuvem (registrado; na nuvem, também na auditoria);
 * - ferramentas que executam código (Terminal, Executar código) nunca ligam pela sincronia num computador: chegam
 *   desligadas e esperam a confirmação com a senha; na nuvem da dona, vêm como no computador dela.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { sealChange } from '../src/world/sync-crypto.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, loginAs, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pcAna: Harness; let ana: Session; let pcCaio: Harness; let caio: Session; let nuvem: Harness; let sws = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_WORKSPACE', 'ERGON_CLOUD_BOOT_TOKEN', 'ERGON_NUVEM_PASSO_MS', 'ERGON_NUVEM_CICLO_MS', 'ERGON_NUVEM_CANAIS_MS', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const control = { health: async () => true, accounts: async () => [], byok: async () => ({ providers: [], custom: [], ergonAi: true }), ergonAi: async () => undefined, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 30_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(40); }
  assert.fail(msg);
}
const registros: string[] = [];
const espiar = (h: Harness) => { for (const nivel of ['info', 'warn', 'error'] as const) { const orig = h.app.log[nivel].bind(h.app.log); h.app.log[nivel] = ((...a: unknown[]) => { if (typeof a[1] === 'string') registros.push(JSON.stringify(a)); return (orig as (...x: unknown[]) => void)(...a); }) as typeof h.app.log.info; } };
const agente = (h: Harness, ws: string, nome: string) => h.db.get<{ id: string; tools: string; status: string }>("SELECT id, tools, status FROM agents WHERE workspace_id = ? AND name = ? AND status = 'active'", ws, nome);
const acc = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!.id;

before(async () => {
  world = await new FakeWorld().start();
  // só pedidos pelas rotas (sem o ciclo automático no meio) nos computadores; a nuvem roda o dela
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC: '0', ERGON_NUVEM_PASSO_MS: '120', ERGON_NUVEM_CICLO_MS: '200', ERGON_NUVEM_CANAIS_MS: '20' });
});
after(async () => {
  await nuvem?.close(); await pcAna?.close(); await pcCaio?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('a dona monta a equipe com Terminal; o colaborador recebe a equipe, mas o Terminal chega desligado, esperando a senha', async () => {
  pcAna = await harness(); espiar(pcAna); ana = await setupOwner(pcAna, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pcAna, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pcAna, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/enable', ana, {})).status, 200);
  world.activate(sws, 'world_team', 8);
  const frodo = (await req(pcAna, 'POST', '/api/agents', ana, { name: 'Frodo', role: 'Pesquisa de campo' })).json.id as string;
  assert.equal((await req(pcAna, 'PATCH', `/api/agents/${frodo}`, ana, { tools: ['web', 'terminal'] })).status, 200);
  pcAna.db.run("INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'ferramentas.terminal', 'ligado', ?)", ana.workspaceId, new Date().toISOString());
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/push', ana, {})).status, 200);

  pcCaio = await harness(); espiar(pcCaio); caio = await setupOwner(pcCaio, 'caio', 'senha-do-caio-123');
  assert.equal((await req(pcCaio, 'POST', '/api/world/connect', caio, { mode: 'signup', email: 'caio@exemplo.test', password: 'senha-do-world-123', displayName: 'Caio' })).status, 200);
  const inv = await req(pcAna, 'POST', '/api/world/members/invites', ana, { role: 'admin' });
  assert.equal((await req(pcCaio, 'POST', '/api/world/invites/accept', caio, { token: inv.json.token })).status, 200);
  assert.equal((await req(pcCaio, 'POST', '/api/world/bind', caio, { syncWorkspaceId: sws })).status, 200);
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/share', ana, {})).status, 200);
  assert.equal((await req(pcCaio, 'POST', '/api/world/sync/join', caio, {})).status, 200);
  assert.equal((await req(pcCaio, 'POST', '/api/world/sync/pull', caio, { apply: true })).status, 200);
  const f = agente(pcCaio, caio.workspaceId, 'Frodo');
  assert.ok(f, 'a equipe da dona chegou');
  assert.deepEqual(JSON.parse(f!.tools), ['web'], 'o Terminal não liga pela sincronia num computador');
  assert.notEqual(pcCaio.db.get<{ v: string }>("SELECT value AS v FROM workspace_settings WHERE workspace_id = ? AND key = 'ferramentas.terminal'", caio.workspaceId)?.v, 'ligado');
  const g = (await req(pcCaio, 'GET', '/api/sync/guardadas', caio)).json.itens as Array<{ tool: string; agente: string | null }>;
  assert.deepEqual(g.map((x) => [x.tool, x.agente]).sort(), [['terminal', null], ['terminal', 'Frodo']], 'a tela pede a confirmação (equipe e agente)');
  // ligar pede a senha: sessão sem confirmação recente → reauth; com a senha (entrar de novo) → liga
  pcCaio.db.run("UPDATE sessions SET auth_at = '2020-01-01T00:00:00.000Z'");
  const semSenha = await req(pcCaio, 'POST', '/api/sync/guardadas', caio, { ligar: true });
  assert.deepEqual([semSenha.status, semSenha.json.error], [401, 'reauth']);
  assert.deepEqual(JSON.parse(agente(pcCaio, caio.workspaceId, 'Frodo')!.tools), ['web']);
  caio = await loginAs(pcCaio, 'caio', 'senha-do-caio-123');
  const ok = await req(pcCaio, 'POST', '/api/sync/guardadas', caio, { ligar: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(JSON.parse(agente(pcCaio, caio.workspaceId, 'Frodo')!.tools).sort(), ['terminal', 'web']);
  assert.equal((await req(pcCaio, 'GET', '/api/sync/guardadas', caio)).json.itens.length, 0);
  // o mesmo esqueleto de novo não tira nem pede de novo (o agente daqui já tem)
  assert.equal((await req(pcAna, 'PATCH', `/api/agents/${frodo}`, ana, { role: 'Guia' })).status, 200);
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/push', ana, {})).status, 200);
  assert.equal((await req(pcCaio, 'POST', '/api/world/sync/pull', caio, { apply: true })).status, 200);
  assert.deepEqual(JSON.parse(agente(pcCaio, caio.workspaceId, 'Frodo')!.tools).sort(), ['terminal', 'web']);
  assert.equal((await req(pcCaio, 'GET', '/api/sync/guardadas', caio)).json.itens.length, 0);
});

test('o computador do colaborador não manda o esqueleto: a equipe dele não vai ao World', async () => {
  const antesN = world.workspaces.get(sws)!.changes.length;
  assert.equal((await req(pcCaio, 'POST', '/api/agents', caio, { name: 'Intruso', role: 'Qualquer coisa' })).status, 201);
  assert.equal((await req(pcCaio, 'POST', '/api/tasks', caio, { title: 'Tarefa do Caio' })).status, 201);
  assert.equal((await req(pcCaio, 'POST', '/api/world/sync/push', caio, {})).status, 200);
  const novas = world.workspaces.get(sws)!.changes.slice(antesN);
  assert.ok(novas.length >= 1, 'o conteúdo dele vai');
  assert.deepEqual([...new Set(novas.map((c) => c.kind))], ['change'], 'só conteúdo, nenhum snapshot');
  assert.ok(novas.every((c) => c.accountId === acc('caio@exemplo.test')), 'o World registra o autor');
});

test('um esqueleto forjado pelo colaborador é ignorado no computador da dona e na nuvem dela', async () => {
  // o Caio tem a chave do workspace: abre o último esqueleto da Ana, troca a equipe (agente novo com Terminal, a equipe
  // com Terminal ligado, a coordenação arquivando o Frodo) e manda como snapshot assinado pelo aparelho dele
  const w = world.workspaces.get(sws)!;
  const dek = Buffer.from(pcCaio.db.get<{ k: string }>('SELECT sync_key AS k FROM world_sync WHERE workspace_id = ?', caio.workspaceId)!.k, 'base64');
  const l = pcCaio.db.get<{ d: string; k: string }>('SELECT device_id AS d, device_keys AS k FROM world_links WHERE user_id = ?', caio.userId)!;
  const forjado = { type: 'blueprint', blueprint: { format: 'ergon.blueprint', version: 1, createdAt: new Date().toISOString(), ergonVersion: 'x', workspace: { name: 'Tomado' }, sectors: [],
    agents: [{ name: 'Intruso', role: 'Executa tudo', sectorKey: 'producao', charter: null, bio: null, skills: [], color: '#ff0000', lookSeed: null, coordinator: false, charKey: null }], structures: [], routines: [],
    sync: { agents: [{ ref: 'agt_intruso0001', name: 'Intruso', tools: ['terminal', 'calculo'], hermesSkills: [], model: null, provider: null }], routines: [], teamTools: [{ id: 'terminal', state: 'ligado' }, { id: 'calculo', state: 'ligado' }] } } };
  const sealed = sealChange(dek, sws, forjado, { operationId: 'bp_forjado_000001', expectedVersion: w.head, schemaVersion: 1, keyVersion: w.keyVersion ?? 1, kind: 'snapshot', deviceId: l.d }, (JSON.parse(l.k) as { ed25519: string }).ed25519);
  w.head += 1; w.changes.push({ ...sealed, version: w.head, deviceId: l.d, accountId: acc('caio@exemplo.test'), deviceKind: 'app' });
  const r = await req(pcAna, 'POST', '/api/world/sync/pull', ana, { apply: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(agente(pcAna, ana.workspaceId, 'Frodo'), 'a equipe da dona segue como está');
  assert.equal(agente(pcAna, ana.workspaceId, 'Intruso'), undefined, 'o agente do colaborador não entrou');
  assert.equal(pcAna.db.get<{ n: string }>('SELECT name AS n FROM workspaces WHERE id = ?', ana.workspaceId)!.n !== 'Tomado', true);
  assert.ok(registros.some((x) => x.includes('esqueleto da equipe vindo de quem não é dono do workspace (ignorado)')));

  // a nuvem da Ana sobe e recebe tudo: a equipe dela (com o Terminal, que lá vem como no computador dela), nada do Caio
  delete process.env.ERGON_WORLD_AUTOSYNC;
  Object.assign(process.env, { ERGON_WORLD_WORKSPACE: sws, ERGON_CLOUD_BOOT_TOKEN: world.nuvem(sws) });
  nuvem = await harness({ mode: 'cloud' }, { control }); espiar(nuvem);
  await nuvem.app.ready();
  // os computadores daqui não têm o ciclo automático: a Ana entrega a chave à nuvem pela rota
  await ate(() => !!world.clouds.get(sws)!.deviceId && world.devices.get(world.clouds.get(sws)!.deviceId!)?.status === 'active', 'a nuvem não se registrou');
  assert.equal((await req(pcAna, 'POST', '/api/world/sync/share', ana, {})).json.cloud, 'entregue');
  await ate(() => world.clouds.get(sws)!.states.at(-1) === 'pronto', 'a nuvem não ficou pronta');
  const wsN = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
  const f = agente(nuvem, wsN, 'Frodo');
  assert.ok(f, 'a equipe da dona está na nuvem');
  assert.deepEqual(JSON.parse(f!.tools).sort(), ['terminal', 'web'], 'na nuvem da dona, a escolha dela vale');
  assert.equal(agente(nuvem, wsN, 'Intruso'), undefined, 'o esqueleto do colaborador não manda na nuvem');
  assert.notEqual(nuvem.db.get<{ v: string }>("SELECT value AS v FROM workspace_settings WHERE workspace_id = ? AND key = 'ferramentas.calculo'", wsN)?.v, 'ligado');
  assert.ok(nuvem.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'team.sync_ignored'", wsN), 'na nuvem, fica na auditoria');
});
