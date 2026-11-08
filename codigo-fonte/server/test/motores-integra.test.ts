/**
 * Renovação de ponta a ponta: o gerente de motores DE VERDADE (createManager, com o Docker falso de docker-falso.ts) atrás
 * do servidor DE VERDADE (Motors + fila pelo harness). Confere o contrato entre os dois, que os testes de cada lado com o
 * outro simulado não pegam: sem a imagem nova, o motor de antes abre (nada de "renovando" para sempre com o cofre fechado);
 * a imagem que some do disco nunca deixa a pessoa sem contêiner; num Docker compartilhado, o cofre de outra instalação
 * nunca é oferecido nem apagado; e uma resposta que se perde no caminho não confirma uma versão com defeito.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as mm from '../src/services/motor-manager.ts';
import { HermesError } from '../src/services/hermes.ts';
import { TOOLS, toolStatus } from '../src/services/characters.ts';
import { VERSION } from '../src/version.ts';
import { allAgents, harness, req, setupOwner, tmpDir } from './helpers.ts';
import * as F from './docker-falso.ts';

const MANAGER = 'http://gerente.test:8645';
const uidOfName = (n: string) => `usr_${n.replace(/^ergon-motor-/, '')}`;

/** O mundo em volta do servidor: o gerente real, o receptor do cofre de cada motor e os clientes do motor (simulados). */
function mundo(d: ReturnType<typeof F.fakeDocker>, image = F.B_REF) {
  const sealed = new Map<string, boolean>();
  const unlocks: Array<{ user: string; key: string }> = [];
  const caps = new Map<string, string[]>();
  const docker = async (method: string, path: string, body?: unknown) => {
    const r = await d.docker(method, path, body);
    const m = /^\/containers\/(?:create\?name=)?(ergon-motor-[a-f0-9]{32})(?:\/(start|stop))?/.exec(path);
    if (m && r.status < 300) sealed.set(uidOfName(m[1]), true); // contêiner novo, religado ou parado: cofre fechado
    return r;
  };
  let mgr = mm.createManager(F.cfg(image), docker);
  /** o gerente reinicia com outra imagem configurada (a atualização do Ergon): cache novo */
  const trocar = (ref: string) => { mgr = mm.createManager(F.cfg(ref), docker); };
  const ctr = (u: string) => d.containers.get(F.nome(u));
  const live = (u: string) => !!ctr(u)?.running && sealed.get(u) === false;
  /** a imagem do motor traz as Conexões? (as capacidades dela; sem nada dito, traz) */
  const temConexoes = (u: string) => (caps.get(ctr(u)?.image ?? '') ?? ['conexoes']).includes('conexoes');
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.origin === MANAGER) {
      const out = await mgr.handle(init?.method ?? 'GET', u.pathname, headers.get('x-ergon-manager-token') ?? undefined, body);
      return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'content-type': 'application/json' } });
    }
    const v = /^ergon-motor-([a-f0-9]{32})$/.exec(u.hostname);
    if (v && u.port === '8644') {
      const user = `usr_${v[1]}`;
      if (!ctr(user)?.running) throw new TypeError('fetch failed');
      if (u.pathname === '/status') return new Response(JSON.stringify({ sealed: sealed.get(user) ?? true }));
      if (u.pathname === '/unlock') { unlocks.push({ user, key: String(body?.key) }); sealed.set(user, false); return new Response(JSON.stringify({ ok: true })); }
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const clients = (user: string) => ({
    hermes: {
      health: async () => ({ ok: live(user), detail: 'teste' }),
      startRun: async (p: { idempotencyKey: string }) => { if (!live(user)) throw new HermesError(503, 'o motor de IA não respondeu'); return { runId: `run_${p.idempotencyKey.slice(-10)}`, replayed: false }; },
      getRun: async () => ({ status: 'completed', output: 'resposta', error: null, sessionId: 's', usage: null }),
      stop: async () => ({ accepted: true, detail: 'ok' }),
      toolsets: async () => [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: [] }, ...(temConexoes(user) ? [{ name: 'ergon_conexoes', label: 'c', enabled: true, configured: true, tools: [] }] : [])],
    },
    control: {
      health: async () => live(user),
      info: async () => ({ ok: live(user), pluginVersion: '0.3.0', vaultConfig: 2, capacidades: caps.get(ctr(user)?.image ?? '') ?? ['conexoes'] }),
      accounts: async () => [], startLogin: async () => ({}), pollLogin: async () => ({}), cancelLogin: async () => {}, disconnect: async () => {},
      modelInfo: async () => ({ model: null, provider: null }), setDefaultModel: async () => ({ ok: true, confirmMessage: null }), skills: async () => [],
      apiToolsets: async () => (temConexoes(user) ? { enabled: ['todo', 'ergon_conexoes'], safe: ['todo', 'ergon_conexoes'] } : { enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e,
    },
  });
  return { get mgr() { return mgr; }, trocar, fetchFake, clients, sealed, unlocks, caps, ctr };
}

/** A instalação do caso real: o motor da pessoa como a rc.22 criava (sem marca), parado na imagem de antes (A). */
const cfgServidor = { executor: 'hermes', hermesApiKey: 'chave-de-teste-123', motorManagerUrl: MANAGER, bridgeToken: F.MASTER } as const;
async function montar(d: ReturnType<typeof F.fakeDocker>, image = F.A_REF, dir?: string) {
  const w = mundo(d, image);
  const h = await harness(cfgServidor, { motorClients: w.clients as never, motorFetch: w.fetchFake, ...(dir ? { dir } : {}) });
  const a = await setupOwner(h);
  await h.motors.ensure(a.userId);
  assert.equal(h.motors.state(a.userId).state, 'aberto', 'primeira criação abre');
  await h.motors.stop(a.userId);
  d.containers.delete(F.nome(a.userId));
  d.addContainer(F.nome(a.userId), F.specRc22(a.userId, F.vol(a.userId), F.A_REF), F.A, false);
  return { h, a, w };
}
const instalacao = (o: Parameters<typeof F.fakeDocker>[0] = {}) => { const d = F.instalacaoPresa(o); d.containers.delete(F.nome(F.U1)); return d; };
/** O que a equipe vê da ferramenta Conexões (com conta conectada) no motor da pessoa. */
const contas = (uid: string) => toolStatus(TOOLS.contas, { scope: uid, contas: true });
const comB = (d: ReturnType<typeof F.fakeDocker>) => { if (!d.images.has(F.B)) d.addImage({ id: F.B, digests: [F.B_REF], created: 6, size: 3.28e9, shared: 3.268e9 }); };

test('o caso real de ponta a ponta: renova no mesmo cofre, entrega a chave de novo, confirma e abre', async () => {
  const d = instalacao();
  const { h, a, w } = await montar(d);
  comB(d); w.trocar(F.B_REF);
  const chaves = w.unlocks.length;
  await h.motors.ensure(a.userId);
  const c = w.ctr(a.userId)!;
  assert.equal(c.image, F.B, 'motor na imagem configurada');
  assert.equal(c.spec.HostConfig.Mounts[0].Source, F.vol(a.userId), 'mesmo cofre');
  assert.equal(w.unlocks.length, chaves + 1, 'chave entregue de novo');
  assert.equal(w.unlocks.at(-1)!.key, h.vault.motorKey(a.userId));
  assert.equal(h.motors.state(a.userId).state, 'aberto');
  assert.equal(d.images.has(F.A), false, 'a confirmação apagou a imagem anterior');
  const ev = h.db.get<{ result: string; evidence: string }>("SELECT result, evidence FROM audit_events WHERE action = 'equipe.atualizada'");
  assert.ok(ev);
  for (const t of [ev!.result, ev!.evidence]) assert.doesNotMatch(t, /\bmotor|\bimagem\b|gerente|cont[eê]iner/i, 'a Atividade mostra isto como está');
  assert.equal(d.count(/^DELETE \/volumes/), 0);
  // o botão "Liberar espaço (X GB)": a estimativa do gerente, no cache, sem apagar nada. Uma versão antiga do núcleo que
  // apareceu depois da limpeza desta versão: a estimativa conta só o que era dela
  d.addImage({ id: F.h('c5c5c5c5'), digests: [`${F.CORE}@${F.dig('c5c5c5c59')}`], created: 0, size: 116e6, shared: 0 });
  const apagadas = d.count(/^DELETE \/images/);
  await h.motors.tick();
  const saude = (await req(h, 'GET', '/api/saude', a)).json;
  assert.equal(saude.espaco.liberavel, 116e6);
  assert.equal(d.count(/^DELETE \/images/), apagadas, 'a estimativa não apaga');
  assert.ok(d.images.has(F.h('c5c5c5c5')));
  await h.close();
});

test('sem a imagem nova e sem internet: o motor de antes abre (com a chave), os pedidos andam, e a Saúde diz que a atualização está pendente', async () => {
  const d = instalacao();
  const { h, a, w } = await montar(d);
  d.images.delete(F.B); // a imagem da versão nova não chegou ao disco, e o registro não responde
  w.trocar(F.B_REF);
  const chaves = w.unlocks.length;
  await h.motors.ensure(a.userId);
  assert.equal(w.ctr(a.userId)?.image, F.A, 'segue na imagem de antes');
  assert.equal(h.motors.state(a.userId).state, 'aberto', 'nada de "renovando" para sempre');
  assert.equal(w.sealed.get(a.userId), false, 'o cofre do motor de antes foi aberto');
  assert.equal(w.unlocks.length, chaves + 1);
  const conv = (await req(h, 'POST', '/api/conversations', a, { agentId: (await allAgents(h, a))[0].id })).json;
  const r = (await req(h, 'POST', `/api/conversations/${conv.id}/messages`, a, { text: 'oi', clientRequestId: 'integra-sem-imagem-1' })).json;
  for (let i = 0; i < 4; i++) await h.executor.tick();
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.runId)!.status, 'succeeded', 'o pedido andou no motor de antes');
  assert.match(String(h.motors.saude(a.userId).adiada), /ainda não chegou a este computador/);
  const saude = (await req(h, 'GET', '/api/saude', a)).json;
  const detalhe = saude.componentes.find((x: { id: string }) => x.id === 'motor').detalhe;
  assert.match(detalhe, /pendente: a versão nova da equipe ainda não chegou.*o sistema tenta de novo sozinho/);
  assert.doesNotMatch(detalhe, /\bmotor|gerente|\bimagem\b/i, 'a Saúde fala da equipe');
  await h.close();
});

test('a imagem nova some do disco depois de conferida: a pessoa nunca fica sem contêiner', async () => {
  const d = instalacao();
  const { h, a, w } = await montar(d);
  comB(d); w.trocar(F.B_REF);
  await h.motors.ensure(a.userId); // renovou para B (B no cache do gerente)
  await h.motors.stop(a.userId);
  // a imagem B some (alguém apagou imagens com o motor parado) e a especificação muda: o motor fica no que existe
  d.images.delete(F.B); w.ctr(a.userId)!.image = F.A; w.ctr(a.userId)!.spec.Labels['ergon.motor.spec'] = 'x';
  for (let i = 0; i < 3; i++) await h.motors.ensure(a.userId).catch(() => undefined);
  assert.ok(w.ctr(a.userId), 'o contêiner continua lá');
  assert.equal(w.ctr(a.userId)!.running, true);
  assert.equal(h.motors.state(a.userId).state, 'aberto');
  await h.close();
});

test('Docker compartilhado: o cofre de OUTRA instalação nunca é oferecido nem apagado', async () => {
  const d = instalacao(); d.volumes.delete(F.vol(F.U1));
  const outra = mm.createManager({ ...F.cfg(F.B_REF), master: F.OUTRO }, d.docker);
  await outra.handle('POST', `/v1/motors/${F.U3}/ensure`, F.OUTRO, {});
  assert.equal(d.volLabels.get(F.vol(F.U3))?.['ergon.instalacao'], mm.installTag(F.OUTRO));
  d.containers.delete(F.nome(F.U3)); // a outra instalação foi removida (os cofres ficam) ou está reinstalando
  const { h, a } = await montar(d, F.B_REF);
  await h.motors.ensure(a.userId);
  const r = await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.volumes, [], 'nenhuma oferta de apagar');
  const del = await req(h, 'DELETE', `/api/saude/volumes/${F.vol(F.U3)}`, a, { confirmar: F.vol(F.U3) });
  assert.notEqual(del.status, 200);
  assert.ok(d.volumes.has(F.vol(F.U3)), 'o cofre de outra instalação nunca sai');
  await h.close();
});

test('a resposta da renovação se perde no caminho e a versão nova veio sem as Conexões: volta para a anterior, sem confirmar', async () => {
  const d = instalacao();
  const { h, a, w } = await montar(d);
  comB(d); w.trocar(F.B_REF);
  w.caps.set(F.B, ['bloqueio_prefixo']); // versão nova com defeito: sem as Conexões
  // o gerente faz a troca, mas o servidor desiste de esperar (o tempo da chamada estourou)
  const motores = h.motors as unknown as { d: { fetch: typeof fetch } };
  const orig = motores.d.fetch;
  let perdidas = 0;
  motores.d.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const r = await orig(input, init);
    if (String(input).endsWith('/ensure') && perdidas === 0) { perdidas++; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }
    return r;
  }) as typeof fetch;
  await h.motors.ensure(a.userId);
  assert.equal(h.motors.state(a.userId).state, 'renovando', 'tempo estourado é "renovando" (tenta de novo), não erro');
  assert.doesNotMatch(String(h.motors.state(a.userId).error), /aborted|timeout/i, 'nada em inglês na tela');
  // a tela põe o texto entre parênteses ("Está levando mais que o normal (…)"): sem jargão e sem parênteses dentro
  assert.doesNotMatch(String(h.motors.state(a.userId).error), /gerente|motores|[()]/i, 'sem jargão técnico na tela');
  await h.motors.ensure(a.userId);
  assert.equal(w.ctr(a.userId)?.image, F.A, 'voltou para a versão anterior');
  assert.ok(d.images.has(F.A), 'a anterior ficou no disco (não foi confirmada a versão com defeito)');
  assert.equal(h.motors.state(a.userId).state, 'aberto');
  assert.ok(h.motors.saude(a.userId).falha, 'a Saúde diz que a atualização não deu certo');
  await h.close();
});

test('com a forma do Podman 5.6.2 de verdade (HostConfig.Mounts null, LayersSize de verdade): renova no mesmo cofre, confirma e abre', async () => {
  const d = instalacao({ podman: true });
  const { h, a, w } = await montar(d);
  comB(d); w.trocar(F.B_REF);
  const chaves = w.unlocks.length;
  await h.motors.ensure(a.userId);
  assert.equal(w.ctr(a.userId)!.image, F.B);
  assert.equal(w.ctr(a.userId)!.spec.HostConfig.Mounts[0].Source, F.vol(a.userId), 'mesmo cofre');
  assert.equal(w.unlocks.length, chaves + 1, 'chave entregue de novo');
  assert.equal(h.motors.state(a.userId).state, 'aberto');
  assert.equal(d.images.has(F.A), false, 'a confirmação apagou a imagem anterior');
  // uma versão antiga do motor que ficou no disco (as camadas grandes são as mesmas da atual): só o que era dela sai
  d.addImage({ id: F.h('d5d5d5d5'), digests: [`${F.MOTOR}@${F.dig('d5d5d5d59')}`], created: 1, size: 3.28e9, shared: 3.268e9 });
  const r = await req(h, 'POST', '/api/saude/liberar-espaco', a, { confirmar: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.removidas, 1);
  assert.equal(r.json.liberado, 12e6, 'a diferença real do disco (LayersSize), sem contar as camadas que a atual usa');
  assert.ok(d.images.has(F.B));
  assert.equal(d.count(/^DELETE \/volumes/), 0);
  await h.close();
});

/** O caso da volta atrás: a imagem de antes (A, de 30/10) sem as Conexões, e a versão nova (B) também veio sem elas. */
async function voltouAtras(dir: string) {
  const d = instalacao();
  const { h, a, w } = await montar(d, F.A_REF, dir);
  comB(d); w.trocar(F.B_REF);
  w.caps.set(F.A, ['bloqueio_prefixo']);
  w.caps.set(F.B, ['bloqueio_prefixo']);
  await h.motors.ensure(a.userId);
  assert.equal(w.ctr(a.userId)!.image, F.A, 'voltou para a anterior');
  assert.equal(contas(a.userId).status, 'bloqueada', 'nesta execução: nada de "voltam sozinhas"');
  await h.close();
  return { d, a, w };
}

test('depois de voltar atrás, o servidor reinicia: a falha continua valendo nesta versão (nada promete que as Conexões voltam sozinhas)', async () => {
  const dir = tmpDir();
  const { a, w } = await voltouAtras(dir);
  // o computador religou (o servidor e o gerente reiniciam); a versão nova até funcionaria agora, mas está travada (hold)
  w.trocar(F.B_REF); w.caps.delete(F.B);
  const h2 = await harness(cfgServidor, { dir, motorClients: w.clients as never, motorFetch: w.fetchFake });
  await h2.motors.ensure(a.userId);
  for (let i = 0; i < 3; i++) await h2.motors.tick();
  assert.equal(h2.motors.state(a.userId).state, 'aberto');
  assert.equal(w.ctr(a.userId)!.image, F.A, 'continua na anterior: a versão recusada fica travada até a próxima');
  assert.equal(contas(a.userId).status, 'bloqueada', 'a equipe não ouve que as Conexões "voltam sozinhas"');
  assert.match(String(contas(a.userId).note), /próxima versão do Ergon/);
  assert.ok(h2.motors.saude(a.userId).falha, 'a Saúde segue dizendo que a atualização não deu certo');
  await h2.close();
});

test('a falha gravada vale só para esta versão; e o gerente travado (hold) sem a falha gravada também conta como falha', async () => {
  const dir = tmpDir();
  const { d, a, w } = await voltouAtras(dir);
  d.addImage({ id: F.C, digests: [F.C_REF], created: 7, size: 3.28e9, shared: 3.268e9 }); // a imagem da versão seguinte
  w.trocar(F.B_REF); w.caps.delete(F.B);
  // sem o registro (banco de antes desta correção, por exemplo): o gerente diz que a versão configurada está travada
  {
    const h2 = await harness(cfgServidor, { dir, motorClients: w.clients as never, motorFetch: w.fetchFake });
    h2.db.run("DELETE FROM instance_settings WHERE key LIKE 'motor_renovacao_falhou:%'");
    await h2.motors.ensure(a.userId);
    assert.equal(w.ctr(a.userId)!.image, F.A);
    assert.equal(contas(a.userId).status, 'bloqueada');
    assert.ok(h2.motors.saude(a.userId).falha);
    await h2.close();
  }
  // a próxima versão do Ergon (outra imagem configurada): a falha de antes não vale mais, e o motor renova
  w.trocar(F.C_REF);
  const h3 = await harness(cfgServidor, { dir, motorClients: w.clients as never, motorFetch: w.fetchFake });
  await h3.motors.ensure(a.userId);
  for (let i = 0; i < 20 && w.ctr(a.userId)!.image !== F.C; i++) { await h3.motors.tick(); await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(w.ctr(a.userId)!.image, F.C, 'a versão seguinte renova');
  assert.equal(h3.motors.state(a.userId).state, 'aberto');
  assert.equal(h3.motors.saude(a.userId).falha, null);
  assert.equal(contas(a.userId).status, 'disponível');
  assert.equal(h3.db.get("SELECT 1 AS x FROM instance_settings WHERE key LIKE 'motor_renovacao_falhou:%'"), undefined, 'a marca saiu');
  await h3.close();
});

test('a marca gravada de outra versão do Ergon não vale (e sai)', async () => {
  const dir = tmpDir();
  const { a, w } = await voltouAtras(dir);
  w.trocar(F.B_REF);
  const h2 = await harness(cfgServidor, { dir, motorClients: w.clients as never, motorFetch: w.fetchFake });
  const chave = `motor_renovacao_falhou:${a.userId}`;
  const gravada = JSON.parse(String(h2.db.get<{ value: string }>('SELECT value FROM instance_settings WHERE key = ?', chave)?.value));
  assert.equal(gravada.versao, VERSION);
  h2.db.run('UPDATE instance_settings SET value = ? WHERE key = ?', JSON.stringify({ ...gravada, versao: '0.0.1-antiga' }), chave);
  // a trava do gerente também sai (outra versão, outra imagem configurada): sem ela, nada mais diz que falhou
  w.ctr(a.userId)!.spec.Labels['ergon.motor.hold'] = F.A_REF;
  assert.equal(h2.motors.saude(a.userId).falha, null, 'a falha de outra versão não aparece');
  assert.equal(h2.db.get('SELECT 1 AS x FROM instance_settings WHERE key = ?', chave), undefined, 'e sai do banco');
  await h2.close();
});
