/**
 * A chave da sincronia chega à nuvem SOZINHA e em segundos (rc.41). O caso de produção: a nuvem do workspace ficou em
 * "aguardando a chave" por mais de 10 min com o Ergon aberto no computador, e só andou quando a pessoa clicou em
 * "Autorizar meus outros computadores". Aqui, um computador de verdade (o servidor do Ergon) contra o World de mentira,
 * com o aparelho-nuvem feito à mão (as mesmas chamadas do contêiner), nas condições daquela conta:
 *  - chave na versão 2 (já girou), quatro aparelhos na conta (dois revogados), outro computador da pessoa e o de outra
 *    pessoa do workspace na lista de quem precisa da chave, um deles com defeito, e a nuvem por ÚLTIMO na lista;
 *  - o ciclo de um minuto longe (10 min no teste): a entrega não espera por ele;
 *  - a pausa pedida ao fechar a janela não segura a chave; instalação antiga sem a tabela de ligação; World antigo (sem
 *    keyWanted nem kind); computador com a chave velha não entrega chave errada.
 * Cada tentativa e o resultado ficam no registro do servidor, sem a chave nem o envelope.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { unwrapForDevice } from '../src/world/sync-crypto.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc: Harness; let ana: Session; let pc2: Harness; let ana2: Session; let pcBia: Harness; let bia: Session; let sws = '';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_AUTOSYNC_MS', 'ERGON_WORLD_ENTREGA_MS', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
const registro: Array<{ msg: string; o: Record<string, unknown> }> = [];
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean | Promise<boolean>, msg: string, ms = 8000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return Date.now() - t0; await pausa(25); }
  assert.fail(`${msg}\n${registro.slice(-12).map((x) => `${x.msg} ${JSON.stringify(x.o)}`).join('\n')}`);
}
const der = (k: crypto.KeyObject, pub: boolean) => k.export({ format: 'der', type: pub ? 'spki' : 'pkcs8' }).toString('base64');
const chaveDoPc = (h: Harness, s: Session) => h.db.get<{ k: string; v: number }>('SELECT sync_key AS k, key_version AS v FROM world_sync WHERE workspace_id = ?', s.workspaceId)!;
const envelopeDe = (dev: string) => world.workspaces.get(sws)!.envelopes.get(dev);
const idDoAparelho = (h: Harness, s: Session) => h.db.get<{ d: string }>('SELECT device_id AS d FROM world_links WHERE user_id = ?', s.userId)!.d;

/** O contêiner da nuvem chegando: token de partida, aparelho-nuvem na conta do dono e a prova de posse (world/nuvem.ts, passo 3). */
async function nuvemChega(): Promise<{ deviceId: string; priv: string; abre: () => Buffer | null }> {
  const bootToken = world.clouds.get(sws)?.bootToken ?? world.nuvem(sws);
  const ed = crypto.generateKeyPairSync('ed25519'); const x = crypto.generateKeyPairSync('x25519');
  const post = async (p: string, b: unknown) => (await fetch(`${world.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<any>;
  const reg = await post('/v1/cloud/boot', { bootToken, installationId: crypto.randomBytes(16).toString('hex'), publicKey: der(ed.publicKey, true), syncPublicKey: der(x.publicKey, true) });
  await post('/v1/devices/confirm', { deviceId: reg.deviceId, signature: crypto.sign(null, Buffer.from(reg.challenge), ed.privateKey).toString('base64') });
  await post('/v1/cloud/boot/state', { bootToken, state: 'aguardando_chave', detail: 'Abra o Ergon no seu computador uma vez: ele entrega a chave da sincronia à nuvem.' });
  const priv = der(x.privateKey, false);
  return { deviceId: reg.deviceId, priv, abre: () => { const e = envelopeDe(reg.deviceId); return e ? unwrapForDevice(e.wrapped, priv, sws, e.keyVersion) : null; } };
}

/**
 * Disco refeito = aparelho-nuvem novo: este computador fixou o primeiro (world/nuvem-fixa.ts) e não entrega a chave ao
 * novo sem a pessoa dona confirmar com a senha. Confere que nada foi antes e confirma pela rota da tela.
 */
async function confirmarNuvemNova(h: Harness, s: Session, deviceId: string) {
  await pausa(200);
  assert.equal(envelopeDe(deviceId), undefined, 'aparelho-nuvem novo: nada antes da confirmação');
  const tela = (await req(h, 'GET', '/api/world/nuvem/conexoes', s)).json;
  assert.equal(tela.trocaNuvem?.aparelho, deviceId, 'a tela pede a confirmação');
  const r = await req(h, 'POST', '/api/world/nuvem/conexoes/confirmar-nuvem', s, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.trocaNuvem, null);
}

before(async () => {
  world = await new FakeWorld().start();
  // o ciclo de um minuto fica longe (10 min; a primeira volta sai aos 5 s): o que entrega a chave aqui é a conferência de perto
  Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC_MS: '600000', ERGON_WORLD_ENTREGA_MS: '60' });
  delete process.env.ERGON_WORLD_AUTOSYNC;
});
after(async () => {
  await pc?.close(); await pc2?.close(); await pcBia?.close(); await world?.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('a conta do caso: chave na versão 2, quatro aparelhos (dois revogados), outro computador e outra pessoa na lista', async () => {
  pc = await harness();
  pc.app.log.info = ((o: unknown, msg?: string) => { if (typeof msg === 'string' && /sincronia|nuvem/.test(msg)) registro.push({ msg, o: o as Record<string, unknown> }); }) as typeof pc.app.log.info;
  ana = await setupOwner(pc, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc, 'POST', '/api/world/sync/enable', ana, {})).status, 200);
  world.activate(sws, 'world_pro', 5);
  assert.equal((await req(pc, 'POST', '/api/world/sync/push', ana, {})).status, 200);
  // dois aparelhos antigos da conta, revogados (um computador trocado e um aparelho-nuvem de um disco anterior)
  const contaAna = [...world.accounts.values()].find((a) => a.email === 'ana@exemplo.test')!.id;
  for (const nome of ['PC antigo', 'nuvem antiga']) {
    const x = crypto.generateKeyPairSync('x25519');
    world.devices.set(`dev_${crypto.randomBytes(16).toString('hex')}`, { id: '', accountId: contaAna, name: nome, publicKey: 'x', syncPublicKey: der(x.publicKey, true), challenge: '', status: 'revoked', session: null, lastSeenAt: new Date().toISOString() });
  }
  for (const [id, d] of world.devices) d.id = id;
  // a Bia entra no workspace (o computador dela precisa da chave e a gravação do envelope dela falha: aparelho com defeito)
  pcBia = await harness(); bia = await setupOwner(pcBia, 'bia', 'senha-da-bia-123');
  assert.equal((await req(pcBia, 'POST', '/api/world/connect', bia, { mode: 'signup', email: 'bia@exemplo.test', password: 'senha-do-world-123', displayName: 'Bia' })).status, 200);
  const convite = (await req(pc, 'POST', '/api/world/members/invites', ana, { role: 'editor' })).json.token as string;
  assert.equal((await req(pcBia, 'POST', '/api/world/invites/accept', bia, { token: convite })).status, 200);
  world.envelopeFail.set(idDoAparelho(pcBia, bia), [500, 'internal']);
  // a chave gira (como depois de alguém sair): versão 2
  const giro = await req(pc, 'POST', '/api/world/sync/rotate', ana, {});
  assert.deepEqual([giro.status, giro.json.keyVersion], [200, 2]);
  assert.equal(chaveDoPc(pc, ana).v, 2);
  // outro computador da Ana conectado (ainda sem a chave nova)
  pc2 = await harness(); ana2 = await setupOwner(pc2, 'ana-notebook', 'senha-do-notebook-123');
  assert.equal((await req(pc2, 'POST', '/api/world/connect', ana2, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
  const ativos = [...world.devices.values()].filter((d) => d.accountId === contaAna && d.status === 'active').length;
  assert.deepEqual([[...world.devices.values()].filter((d) => d.accountId === contaAna).length, ativos], [4, 2]);
});

test('a nuvem esperando a chave recebe em segundos: por último na lista, com um aparelho falhando antes, sem esperar o ciclo', async () => {
  world.nuvemPorUltimo = true;
  world.nuvem(sws);
  await pc.app.ready();
  // a primeira volta do ciclo (aos 5 s) acha a nuvem ativa e avisa que o computador está aberto; a próxima é só daqui a 10 min
  await ate(() => world.clouds.get(sws)!.presence.length > 0, 'o computador não avisou que está aberto', 9000);
  // o envelope do outro computador da Ana saiu no ciclo; o da Bia falhou e não atrapalhou
  await ate(() => !!envelopeDe(idDoAparelho(pc2, ana2)), 'o outro computador da pessoa não recebeu a chave');
  assert.equal(envelopeDe(idDoAparelho(pcBia, bia)), undefined);
  const voltas = world.clouds.get(sws)!.presence.length;
  const nuvem = await nuvemChega();
  const levou = await ate(() => !!envelopeDe(nuvem.deviceId), 'a nuvem ficou esperando a chave');
  assert.ok(levou < 3000, `levou ${levou} ms`);
  assert.equal(world.clouds.get(sws)!.presence.length, voltas, 'foi a conferência de perto, não o ciclo de um minuto');
  // é a chave certa, na versão certa: o contêiner abre o envelope com a chave privada dele
  assert.equal(envelopeDe(nuvem.deviceId)!.keyVersion, 2);
  assert.equal(nuvem.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
  assert.equal(world.keyWanted(sws), false);
  // o registro do servidor conta a história (aparelho e código do erro), sem a chave nem o envelope
  // (o World grava o envelope antes de responder; o registro "chave entregue" sai quando a resposta chega aqui: espera
  // por ele em vez de olhar no mesmo instante — com a máquina carregada, a resposta chega depois da conferência)
  await ate(() => registro.some((x) => x.msg === 'sincronia: chave entregue' && x.o.aparelho === nuvem.deviceId && x.o.nuvem === true), 'o registro não contou a entrega à nuvem', 3000);
  const texto = JSON.stringify(registro);
  assert.ok(registro.some((x) => /entrega da chave a um aparelho falhou/.test(x.msg) && x.o.aparelho === idDoAparelho(pcBia, bia) && x.o.erro === 'internal'), texto);
  assert.ok(registro.some((x) => /está esperando a chave/.test(x.msg)), texto);
  assert.ok(!texto.includes(chaveDoPc(pc, ana).k) && !texto.includes(envelopeDe(nuvem.deviceId)!.wrapped.slice(20, 60)), 'nada de segredo no registro');
  // a tela mostra o que ficou pendente (a entrega à Bia), sem esconder
  // (o "esperando a chave" sai do estado quando a entrega termina aqui, logo depois do registro: espera por ele também)
  await ate(async () => (await req(pc, 'GET', '/api/world/sync', ana)).json.auto?.nuvem?.esperandoChave === false, 'o estado seguiu dizendo que a nuvem espera a chave', 3000);
  const st = (await req(pc, 'GET', '/api/world/sync', ana)).json;
  assert.deepEqual([st.auto.auto, st.auto.pendencia?.passo, st.auto.nuvem.esperandoChave], [true, 'chave', false]);
});

test('disco refeito (aparelho-nuvem novo) com a sincronia em pausa: a chave chega do mesmo jeito', async () => {
  // fechar a janela pede a pausa (nada de dados vai nem vem por 2 min): a chave não é dado do workspace
  assert.equal((await req(pc, 'POST', '/api/world/sync/pausar', ana, {})).json.concluida, true);
  const antes = registro.length;
  const nuvem = await nuvemChega();
  await confirmarNuvemNova(pc, ana, nuvem.deviceId);
  assert.ok(pc.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'world.cloud_device_changed' AND target_id = ?", ana.workspaceId, nuvem.deviceId), 'a troca ficou na auditoria');
  const levou = await ate(() => !!envelopeDe(nuvem.deviceId), 'em pausa, a nuvem ficou esperando a chave');
  assert.ok(levou < 3000, `levou ${levou} ms`);
  assert.equal(nuvem.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
  await ate(() => registro.slice(antes).some((x) => x.msg === 'sincronia: chave entregue' && x.o.motivo === 'nuvem esperando a chave'), 'o registro não contou a entrega', 3000);
  assert.equal((await req(pc, 'POST', '/api/world/sync/retomar', ana, {})).status, 200);
});

test('a tela olhando o cartão da nuvem dispara a entrega na hora (sem conferência de perto nem ciclo)', async () => {
  await pc.close();
  process.env.ERGON_WORLD_ENTREGA_MS = '600000';
  pc = await harness({}, { dir: pc.dir });
  pc.app.log.info = ((o: unknown, msg?: string) => { if (typeof msg === 'string' && /sincronia|nuvem/.test(msg)) registro.push({ msg, o: o as Record<string, unknown> }); }) as typeof pc.app.log.info;
  await pc.app.ready();
  const nuvem = await nuvemChega();
  await confirmarNuvemNova(pc, ana, nuvem.deviceId);
  await pausa(300);
  assert.equal(envelopeDe(nuvem.deviceId), undefined, 'ninguém conferiu ainda');
  const c = await req(pc, 'GET', '/api/world/cloud', ana);
  assert.deepEqual([c.status, c.json.active, c.json.keyWanted], [200, true, true]);
  const levou = await ate(() => !!envelopeDe(nuvem.deviceId), 'olhar o cartão não entregou a chave');
  assert.ok(levou < 2000, `levou ${levou} ms`);
  assert.equal(nuvem.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
  process.env.ERGON_WORLD_ENTREGA_MS = '60';
});

test('instalação antiga (sincronia ligada antes da tabela de ligação) e World antigo (sem keyWanted nem kind)', async () => {
  await pc.close();
  // rc de antes do w0005: só world_sync conhece o workspace World; o ciclo automático nem enxergava este workspace
  process.env.ERGON_WORLD_AUTOSYNC_MS = '150';
  pc = await harness({}, { dir: pc.dir });
  pc.db.run('DELETE FROM world_workspace_ids WHERE workspace_id = ?', ana.workspaceId);
  world.antigo = true; world.nuvemPorUltimo = true;
  const voltas = world.clouds.get(sws)!.presence.length;
  await pc.app.ready();
  // (World antigo não diz o tipo do aparelho: a fixação da nuvem só vale com o kind do World atual)
  const nuvem = await nuvemChega();
  const levou = await ate(() => !!envelopeDe(nuvem.deviceId), 'World antigo: a nuvem ficou esperando a chave');
  assert.ok(levou < 3000, `levou ${levou} ms`);
  assert.equal(nuvem.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
  await ate(() => world.clouds.get(sws)!.presence.length > voltas, 'sem a tabela de ligação, o computador não avisou que está aberto');
  world.antigo = false; world.nuvemPorUltimo = false;
});

test('computador com a chave velha não entrega chave errada: busca a nova antes; sem ela, não entrega nada', async () => {
  await pc.close(); // só pedidos pela rota daqui em diante (sem ciclo automático no meio)
  process.env.ERGON_WORLD_AUTOSYNC = '0';
  pc = await harness({}, { dir: pc.dir });
  // o notebook entra na sincronia (o computador principal já entregou a chave v2 a ele) e fica com ela
  assert.equal((await req(pc2, 'POST', '/api/world/bind', ana2, { syncWorkspaceId: sws })).status, 200);
  assert.equal((await req(pc2, 'POST', '/api/world/sync/join', ana2, {})).status, 200);
  assert.equal(chaveDoPc(pc2, ana2).v, 2);
  // o principal gira de novo (v3), mas a entrega ao notebook falha: ele fica com a v2
  world.envelopeFail.set(idDoAparelho(pc2, ana2), [500, 'internal']);
  assert.equal((await req(pc, 'POST', '/api/world/sync/rotate', ana, {})).json.keyVersion, 3);
  const nuvem = await nuvemChega();
  await confirmarNuvemNova(pc, ana, nuvem.deviceId);
  world.envelopeFail.clear(); world.envelopeFail.set(idDoAparelho(pcBia, bia), [500, 'internal']);
  // o notebook tenta entregar: o World pede a v3, ele só tem a v2 e ainda não recebeu a nova → não grava envelope nenhum
  const semChave = await req(pc2, 'POST', '/api/world/sync/share', ana2, {});
  assert.deepEqual([semChave.status, semChave.json.error], [409, 'key_pending']);
  assert.equal(envelopeDe(nuvem.deviceId), undefined, 'nada de chave velha com etiqueta nova');
  assert.equal(envelopeDe(idDoAparelho(pc2, ana2))?.keyVersion, 2);
  // o principal entrega (a nuvem primeiro) e o notebook passa a ter a v3; aí o notebook também entrega certo
  const r = await req(pc, 'POST', '/api/world/sync/share', ana, {});
  assert.deepEqual([r.status, r.json.shared, r.json.failed, r.json.cloud], [200, 2, 1, 'entregue']);
  assert.equal(nuvem.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
  const outra = await nuvemChega();
  const doNotebook = await req(pc2, 'POST', '/api/world/sync/share', ana2, {});
  assert.deepEqual([doNotebook.status, doNotebook.json.cloud], [200, 'entregue']);
  assert.equal(chaveDoPc(pc2, ana2).v, 3, 'pegou a chave nova antes de entregar');
  assert.equal(outra.abre()!.toString('base64'), chaveDoPc(pc, ana).k);
});
