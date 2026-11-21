/**
 * A nuvem do Ergon World como GÊMEA da equipe do computador, de ponta a ponta (dois Ergons de verdade e o World de
 * mentira, fake-world.ts):
 * - o que se edita no computador (papel, instruções, competências, ferramentas, setor, aparência, nome) chega à nuvem;
 *   o agente removido sai de lá; os setores e as ferramentas da equipe também;
 * - as rotinas chegam ATIVAS como no computador e nunca duplicam, mesmo depois de vários esqueletos;
 * - cada horário de rotina é de quem está com o workspace: com o computador aberto, só ele executa; fechado, a nuvem
 *   executa o horário uma vez e conta ao World o próximo (é por ele que o orquestrador a acorda);
 * - a partida que não se registra a tempo (token de partida vencido) sai para ganhar um token novo; disco novo num
 *   workspace já preparado fica em "erro" com o motivo; a espera pelos canais é só da primeira partida.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { updateSector } from '../src/services/sectors.ts';
import type { Bus } from '../src/services/bus.ts';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { needsSetup } from '../src/services/auth.ts';
import { instanceSetting, setInstanceSetting } from '../src/services/security.ts';
import { FakeWorld } from './fake-world.ts';
import { FOLGA_POSSE_MS } from '../src/world/nuvem.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc: Harness; let dono: Session; let nuvem: Harness; let sws = ''; let wsN = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_WORKSPACE', 'ERGON_CLOUD_BOOT_TOKEN', 'ERGON_NUVEM_PASSO_MS', 'ERGON_NUVEM_CICLO_MS', 'ERGON_NUVEM_CANAIS_MS', 'ERGON_WORLD_AUTOSYNC_MS'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const control = { health: async () => true, accounts: async () => [], byok: async () => ({ providers: [], custom: [], ergonAi: true }), ergonAi: async () => undefined, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
const bus = { publish() {}, subscribe() { return () => undefined; } } as unknown as Bus;
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 30_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await pausa(40); }
  assert.fail(`${msg} (estados da nuvem: ${JSON.stringify(world.clouds.get(sws)?.states.slice(-4))})`);
}
const agenteN = (nome: string) => nuvem.db.get<{ id: string; role: string; charter: string | null; tools: string; hermes_skills: string; status: string; look_seed: number; sector: string; sync_ref: string | null }>(
  "SELECT a.id, a.role, a.charter, a.tools, a.hermes_skills, a.status, a.look_seed, p.key AS sector, a.sync_ref FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.name = ? ORDER BY a.status = 'active' DESC LIMIT 1", wsN, nome);
const rotinasN = () => nuvem.db.all<{ id: string; status: string; name: string; next_run_at: string | null; sync_ref: string | null }>("SELECT id, status, name, next_run_at, sync_ref FROM routines WHERE workspace_id = ? AND status != 'archived'", wsN);
/** uma volta da sincronia automática do computador terminada depois deste instante (o esqueleto novo foi enviado) */
const versaoPc = () => pc.db.get<{ v: number }>('SELECT last_version AS v FROM world_sync WHERE workspace_id = ?', dono.workspaceId)!.v;

before(async () => {
  world = await new FakeWorld().start();
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_NUVEM_PASSO_MS: '120', ERGON_NUVEM_CICLO_MS: '250', ERGON_NUVEM_CANAIS_MS: '20000', ERGON_WORLD_AUTOSYNC_MS: '250' });
});
after(async () => {
  await nuvem?.close(); await pc?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let frodo = ''; let sam = ''; let rotinaPc = '';
test('o computador monta a equipe (setor, ferramentas, competências, rotina diária ativa) e a nuvem sobe gêmea', async () => {
  pc = await harness();
  dono = await setupOwner(pc, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc, 'POST', '/api/world/connect', dono, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc, 'POST', '/api/world/bind', dono, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc, 'POST', '/api/world/sync/enable', dono, { recoveryPhrase: 'frase de recuperação da ana para a nuvem' })).status, 200);
  world.activate(sws);
  frodo = (await req(pc, 'POST', '/api/agents', dono, { name: 'Frodo', role: 'Pesquisa de campo' })).json.id;
  sam = (await req(pc, 'POST', '/api/agents', dono, { name: 'Sam', role: 'Logística da viagem' })).json.id;
  assert.equal((await req(pc, 'PATCH', `/api/agents/${frodo}`, dono, { tools: ['web', 'passos'], hermesSkills: ['docx'], charter: 'Pesquise o caminho mais seguro.', lookSeed: 4242, sectorKey: 'brainstorm' })).status, 200);
  updateSector(pc.db, bus, dono.workspaceId, { type: 'user', id: dono.userId }, 'producao', { instructions: 'Entregue sempre um mapa.' });
  // ferramentas da equipe: a pessoa desligou o navegador (Configurações › Ferramentas)
  pc.db.run("INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'ferramentas.navegador', 'desligado', ?)", dono.workspaceId, new Date().toISOString());
  const r = await req(pc, 'POST', '/api/routines', dono, { template: 'guardiao-prazos', trigger: { kind: 'schedule', days: [0, 1, 2, 3, 4, 5, 6], time: '08:00' }, tz: 'America/Sao_Paulo' });
  assert.equal(r.status, 201); rotinaPc = r.json.id; assert.equal(r.json.status, 'active');
  assert.equal((await req(pc, 'POST', '/api/world/sync/push', dono, {})).status, 200);
  Object.assign(process.env, { ERGON_WORLD_WORKSPACE: sws, ERGON_CLOUD_BOOT_TOKEN: world.nuvem(sws) });

  nuvem = await harness({ mode: 'cloud' }, { control });
  await nuvem.app.ready();
  await ate(() => world.clouds.get(sws)!.states.at(-1) === 'pronto', 'a nuvem não ficou pronta');
  wsN = nuvem.db.get<{ w: string }>('SELECT workspace_id AS w FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)!.w;
  const f = agenteN('Frodo')!;
  assert.equal(f.sync_ref, frodo, 'a identidade é a do computador');
  assert.deepEqual([f.role, f.charter, f.sector, Number(f.look_seed)], ['Pesquisa de campo', 'Pesquise o caminho mais seguro.', 'brainstorm', 4242]);
  assert.deepEqual(JSON.parse(f.tools), ['web', 'passos'], 'as ferramentas do agente');
  assert.deepEqual(JSON.parse(f.hermes_skills), ['docx'], 'as competências');
  assert.equal(nuvem.db.get<{ i: string }>("SELECT instructions AS i FROM profiles WHERE workspace_id = ? AND key = 'producao'", wsN)!.i, 'Entregue sempre um mapa.', 'o setor');
  assert.equal(nuvem.db.get<{ v: string }>("SELECT value AS v FROM workspace_settings WHERE workspace_id = ? AND key = 'ferramentas.navegador'", wsN)?.v, 'desligado', 'a escolha da equipe');
  const rs = rotinasN();
  assert.equal(rs.length, 1); assert.equal(rs[0].status, 'active', 'na nuvem a rotina fica ativa como no computador'); assert.equal(rs[0].sync_ref, rotinaPc);
});

test('editar e remover no computador reflete na nuvem; três esqueletos depois, nada duplica', async () => {
  assert.equal((await req(pc, 'PATCH', `/api/agents/${frodo}`, dono, { name: 'Frodo Bolseiro', role: 'Guia da comitiva', charter: 'Guie a comitiva.', tools: ['web'], hermesSkills: ['docx', 'pdf'], sectorKey: 'producao' })).status, 200);
  assert.equal((await req(pc, 'POST', `/api/agents/${sam}/deactivate`, dono, {})).status, 200);
  await ate(() => agenteN('Frodo Bolseiro')?.role === 'Guia da comitiva', 'a edição do agente não chegou');
  const f = agenteN('Frodo Bolseiro')!;
  assert.deepEqual([f.charter, f.sector, JSON.parse(f.tools), JSON.parse(f.hermes_skills)], ['Guie a comitiva.', 'producao', ['web'], ['docx', 'pdf']]);
  assert.equal(agenteN('Frodo'), undefined, 'renomeado, não duplicado');
  await ate(() => agenteN('Sam')?.status === 'archived', 'o agente removido não saiu da nuvem');
  // três esqueletos (cada mudança na equipe manda um): a rotina segue uma só, ativa, com a mesma identidade
  const id = rotinasN()[0].id;
  for (const t of ['Primeiro ajuste.', 'Segundo ajuste.', 'Terceiro ajuste.']) {
    const v = versaoPc();
    updateSector(pc.db, bus, dono.workspaceId, { type: 'user', id: dono.userId }, 'central', { instructions: t });
    await ate(() => versaoPc() > v, 'o computador não enviou o esqueleto');
    await ate(() => nuvem.db.get<{ i: string }>("SELECT instructions AS i FROM profiles WHERE workspace_id = ? AND key = 'central'", wsN)?.i === t, 'o setor não chegou');
  }
  const rs = rotinasN();
  assert.equal(rs.length, 1, JSON.stringify(rs)); assert.equal(rs[0].id, id); assert.equal(rs[0].status, 'active');
  assert.equal(nuvem.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active' AND name LIKE 'Frodo%'", wsN)!.n, 1);
  // a rotina pausada no computador pausa na nuvem
  assert.equal((await req(pc, 'PATCH', `/api/routines/${rotinaPc}`, dono, { status: 'paused' })).status, 200);
  await ate(() => rotinasN()[0]?.status === 'paused', 'a pausa não chegou');
  assert.equal((await req(pc, 'PATCH', `/api/routines/${rotinaPc}`, dono, { status: 'active' })).status, 200);
  await ate(() => rotinasN()[0]?.status === 'active', 'a retomada não chegou');
});

/** foi pulado pela posse (o horário era do outro aparelho)? A rotina em si também pode pular ("nada pedindo atenção") */
const daPosse = (x: { status: string; summary: string | null }) => x.status === 'skipped' && /computador|nuvem do Ergon World/.test(x.summary ?? '');
const execucoes = (h: Harness, routineId: string) => h.db.all<{ status: string; summary: string | null; slot: string }>("SELECT status, summary, slot FROM routine_runs WHERE routine_id = ? AND trigger = 'schedule' ORDER BY created_at", routineId);

test('com o computador aberto, o horário é dele: a nuvem não executa (nada em dobro)', async () => {
  // um horário de depois de o computador abrir; a nuvem decide com a palavra do World dada depois dele (com a folga)
  const slot = new Date(Math.max(world.clouds.get(sws)!.pcSince! + 50, Date.now() - 1000)).toISOString();
  await pausa(FOLGA_POSSE_MS + 600);
  const idN = rotinasN()[0].id;
  pc.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, rotinaPc);
  nuvem.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, idN);
  await pc.routines.tick(); await nuvem.routines.tick();
  const noPc = execucoes(pc, rotinaPc); const naNuvem = execucoes(nuvem, idN);
  assert.equal(noPc.length, 1); assert.ok(!daPosse(noPc[0]), `o computador executou: ${JSON.stringify(noPc)}`);
  assert.equal(naNuvem.length, 1); assert.ok(daPosse(naNuvem[0])); assert.match(naNuvem[0].summary ?? '', /computador da equipe estava com o workspace aberto/);
  // o computador conta ao World o próximo horário (amanhã às 8h) a cada aviso de aberto
  await ate(() => world.clouds.get(sws)!.wakeLog.some((w) => w.by === 'pc' && w.at === pc.db.get<{ n: string }>('SELECT next_run_at AS n FROM routines WHERE id = ?', rotinaPc)!.n), 'o computador não contou o próximo horário');
});

test('com o computador fechado, a nuvem executa o horário uma vez e conta ao World o próximo (o orquestrador acorda por ele)', async () => {
  const idN = rotinasN()[0].id;
  const proximoNoPc = pc.db.get<{ n: string }>('SELECT next_run_at AS n FROM routines WHERE id = ?', rotinaPc)!.n;
  await pc.close();
  const cl = world.clouds.get(sws)!;
  assert.equal(cl.presence.at(-1), false);
  assert.deepEqual(cl.wakeLog.filter((w) => w.by === 'pc').at(-1), { by: 'pc', at: proximoNoPc }, 'ao fechar, o computador conta o próximo horário');
  // o horário chegou (o orquestrador acordou a nuvem por ele): a nuvem sabe pela resposta do World que a posse é dela
  const slot = new Date(Date.now() + 300).toISOString();
  nuvem.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, idN);
  await pausa(400);
  // a palavra do World ainda é de antes do horário (com a folga): espera e pede de novo
  await nuvem.routines.tick();
  assert.equal(execucoes(nuvem, idN).filter((x) => x.slot === slot).length, 0, 'decide só com a palavra do World de depois do horário');
  await pausa(FOLGA_POSSE_MS + 600); // os ciclos da nuvem trazem a posse contada depois do horário
  await nuvem.routines.tick();
  await nuvem.routines.tick(); // um segundo tique não roda de novo o mesmo horário
  const r = execucoes(nuvem, idN).filter((x) => x.slot === slot);
  assert.equal(r.length, 1); assert.ok(!daPosse(r[0]), JSON.stringify(r));
  const proximo = nuvem.db.get<{ n: string }>('SELECT next_run_at AS n FROM routines WHERE id = ?', idN)!.n;
  assert.ok(Date.parse(proximo) > Date.now(), 'o próximo horário é o de amanhã');
  await ate(() => nuvem.db.get("SELECT 1 AS x FROM routine_runs WHERE routine_id = ? AND status IN ('queued', 'gathering', 'running')", idN) === undefined, 'a execução não terminou');
  await ate(() => cl.wakeLog.at(-1)?.by === 'nuvem' && cl.wakeLog.at(-1)?.at === proximo, 'a nuvem não contou o próximo horário (para dormir até ele)');
  assert.equal(execucoes(nuvem, idN).filter((x) => x.slot === slot).length, 1, 'uma vez só');
});

test('a espera pelos canais é só da primeira partida: sem serviço dos canais alcançável, a seguinte fica pronta já', async () => {
  const dir = nuvem.dir;
  // a primeira partida já fez a espera (sem relé no teste, a marca não nasceu por ela: grava como se tivesse esperado)
  if (instanceSetting(nuvem.db, 'nuvem_canais_esperou') !== '1') setInstanceSetting(nuvem.db, 'nuvem_canais_esperou', '1');
  await nuvem.close();
  const cl = world.clouds.get(sws)!; const n = cl.states.length;
  process.env.ERGON_NUVEM_CANAIS_MS = '60000';
  // o serviço dos canais fora do ar (endereço que não responde): na 1ª partida isto seguraria 60 s em "ligando os canais"
  nuvem = await harness({ mode: 'cloud', teamsRelayUrl: 'http://127.0.0.1:9' }, { control, dir });
  await nuvem.teamsApp.start().catch(() => undefined);
  await nuvem.app.ready();
  const t0 = Date.now();
  await ate(() => cl.states.slice(n).includes('pronto'), 'a partida seguinte não ficou pronta', 15_000);
  assert.ok(Date.now() - t0 < 15_000);
  assert.ok(!cl.states.slice(n).some((s) => /ligando os canais/.test(s)), JSON.stringify(cl.states.slice(n)));
  process.env.ERGON_NUVEM_CANAIS_MS = '20000';
});

test('disco novo num workspace já preparado: "erro" com o motivo, sem criar nada; token de partida vencido: sai para ganhar um novo', async () => {
  await nuvem.close();
  const cl = world.clouds.get(sws)!; const n = cl.states.length;
  // disco novo (pasta vazia), o World já tem a chave e o workspace já foi preparado: não troca a chave sozinho
  const outro = await harness({ mode: 'cloud' }, { control });
  try {
    await outro.app.ready();
    await ate(() => cl.states.slice(n).some((s) => /^erro: .*preparado na nuvem com outro disco/.test(s)), 'o motivo não apareceu');
    assert.equal(needsSetup(outro.db), true, 'nenhuma conta local nasceu sem a chave guardada');
  } finally { await outro.close(); }
  // token de partida que o World não aceita mais (vencido) e ainda sem registro: sai com o código do token novo
  const sair = process.exit; let codigo: number | undefined;
  process.env.ERGON_CLOUD_BOOT_TOKEN = `${sws}.vencido`;
  (process as { exit: (c?: number) => never }).exit = ((c?: number) => { codigo = c; }) as (c?: number) => never;
  const velho = await harness({ mode: 'cloud' }, { control });
  try {
    await velho.app.ready();
    await ate(() => codigo !== undefined, 'não saiu para pedir um token novo', 10_000);
    assert.equal(codigo, 75);
  } finally { process.exit = sair; await velho.close().catch(() => undefined); }
});
