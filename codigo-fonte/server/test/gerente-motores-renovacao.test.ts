/**
 * Renovação, volta e limpeza do gerente de motores, com um Docker falso que conhece imagens (mapa nome → ID,
 * 'Image' no inspect, /images/{ref}/json, /images/json, DELETE /images com 409, /system/df) e conta cada chamada.
 * O primeiro teste reproduz a instalação que ficou presa na imagem antiga: no código da rc.22 ele falha.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
// por nome do módulo (e não por nomes soltos) para o primeiro teste também rodar contra o código antigo
import * as mm from '../src/services/motor-manager.ts';
import { A, A_REF, B, B_REF, C, C_REF, CORE, CORE_NOW, MASTER, MOTOR, OUTRO, U1, U2, U3, cfg, dig, h, instalacaoPresa, nome, specRc22, vol } from './docker-falso.ts';
const ensure = (m: ReturnType<typeof mm.createManager>, uid: string, body: unknown = {}) => m.handle('POST', `/v1/motors/${uid}/ensure`, MASTER, body);

describe('gerente de motores: renovação', () => {
  test('caso real: motor parado na imagem antiga e a nova já baixada → recriado na nova, com o MESMO cofre e os rótulos novos', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const r = await ensure(m, U1, { adoptLegacy: true }); // o que o Ergon da rc.22 manda
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = d.containers.get(nome(U1))!;
    assert.equal(c.image, B, 'o motor está na imagem configurada');
    assert.equal(c.spec.HostConfig.Mounts[0].Source, vol(U1), 'o mesmo cofre');
    assert.equal(c.running, true);
    const L = c.spec.Labels;
    assert.equal(L['ergon.motor'], U1);
    assert.equal(L['ergon.motor.volume'], vol(U1));
    assert.equal(L['ergon.motor.image'], B_REF);
    assert.equal(L['ergon.motor.prev-image'], `sha256:${A}`, 'a imagem de antes fica anotada para voltar');
    assert.match(L['ergon.motor.spec'], /^[a-f0-9]{64}$/);
    assert.match(L['ergon.instalacao'], /^[a-f0-9]{64}$/);
    assert.ok(!Object.values(L).some((v) => String(v).includes(MASTER)), 'o token da instalação não aparece nos rótulos');
    assert.equal(r.json.recreated, true); assert.equal(r.json.stale, false); assert.equal(r.json.pendente, true);
    assert.equal(r.json.image, `sha256:${B}`); assert.equal(r.json.prevImage, `sha256:${A}`);
    assert.equal(d.count(/^DELETE \/volumes/), 0, 'nenhum volume apagado');
    assert.equal(d.count(/^DELETE \/containers\/.*(force|v=)/), 0, 'contêiner removido sem força e sem volumes');
    assert.ok(d.images.has(A), 'a imagem anterior continua no disco');
  });

  test('ligado e o Ergon diz que está livre (idle) → para, recria e liga; ligado sem idle → não mexe e avisa', async () => {
    const d = instalacaoPresa(); d.containers.get(nome(U1))!.running = true;
    const m = mm.createManager(cfg(B_REF), d.docker);
    const before = d.calls.length;
    const busy = await ensure(m, U1, {});
    assert.equal(busy.json.stale, true); assert.equal(busy.json.recreated, false);
    assert.equal(d.containers.get(nome(U1))!.image, A, 'continua na imagem de antes, trabalhando');
    assert.equal(d.calls.slice(before).filter((x) => /\/stop|^DELETE|\/containers\/create/.test(x)).length, 0, 'nem parou, nem removeu, nem criou');
    const free = await ensure(m, U1, { idle: true });
    assert.equal(free.json.recreated, true);
    assert.ok(d.calls.includes(`POST /containers/${nome(U1)}/stop?t=20`));
    assert.equal(d.containers.get(nome(U1))!.image, B); assert.equal(d.containers.get(nome(U1))!.running, true);
  });

  test('em dia não recria (nem ligado, nem parado); especificação mudada recria na mesma imagem, sem anotar imagem anterior', async () => {
    const d = instalacaoPresa(); d.containers.delete(nome(U1));
    const m = mm.createManager(cfg(B_REF), d.docker);
    assert.equal((await ensure(m, U2)).json.created, true);
    const creates = () => d.count(/^POST \/containers\/create/);
    assert.equal(creates(), 1);
    assert.equal((await ensure(m, U2, { idle: true })).json.recreated, false);
    await m.handle('POST', `/v1/motors/${U2}/stop`, MASTER, null);
    const again = await ensure(m, U2);
    assert.equal(again.json.recreated, false); assert.equal(again.json.stale, false); assert.equal(creates(), 1, 'nenhum contêiner novo');
    assert.equal(d.containers.get(nome(U2))!.running, true, 'só religou');
    // a mesma imagem, outro limite de memória: a especificação mudou
    const m2 = mm.createManager(cfg(B_REF, { memBytes: 3 * 1024 ** 3 }), d.docker);
    const r = await ensure(m2, U2, { idle: true });
    assert.equal(r.json.recreated, true); assert.equal(r.json.prevImage, null); assert.equal(r.json.pendente, false);
    assert.equal(d.containers.get(nome(U2))!.spec.HostConfig.Memory, 3 * 1024 ** 3);
    assert.equal(d.containers.get(nome(U2))!.spec.HostConfig.Mounts[0].Source, vol(U2));
  });

  test('o cofre herdado (ergon_hermes-vault) continua sendo o do motor depois da troca', async () => {
    const d = instalacaoPresa(); d.containers.delete(nome(U1)); d.volumes.delete(vol(U1));
    d.addContainer(nome(U1), specRc22(U1, 'ergon_hermes-vault', A_REF), A, false);
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1, { adoptLegacy: true });
    assert.equal(r.json.recreated, true); assert.equal(r.json.adopted, true);
    const c = d.containers.get(nome(U1))!;
    assert.equal(c.spec.HostConfig.Mounts[0].Source, 'ergon_hermes-vault', 'o volume vem do rótulo, não é recalculado');
    assert.equal(c.spec.Labels['ergon.motor.volume'], 'ergon_hermes-vault');
    assert.ok(d.volumes.has('ergon_hermes-vault')); assert.equal(d.volumes.has(vol(U1)), false, 'nenhum cofre novo vazio');
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });

  test('cofre montado diferente do rótulo: recusa e não remove nada', async () => {
    const d = instalacaoPresa(); const c = d.containers.get(nome(U1))!;
    c.spec.HostConfig.Mounts[0].Source = 'ergon_outro-cofre';
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1);
    assert.equal(r.status, 409);
    assert.equal(d.containers.get(nome(U1))!.image, A);
    assert.equal(d.count(/^DELETE/), 0);
  });

  test('cofre montado diferente do rótulo com o motor ligado: recusa sem desligar', async () => {
    const d = instalacaoPresa(); const c = d.containers.get(nome(U1))!;
    c.spec.HostConfig.Mounts[0].Source = 'ergon_outro-cofre'; c.running = true;
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1, { idle: true });
    assert.equal(r.status, 409); assert.match(r.json.error, /segue como estava/);
    assert.equal(d.count(/\/stop/), 0, 'nem desligou');
    assert.equal(d.containers.get(nome(U1))!.running, true);
  });

  test('o motor não parou a tempo: aborta com stale, sem remover', async () => {
    const d = instalacaoPresa({ stuckStop: true }); d.containers.get(nome(U1))!.running = true;
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1, { idle: true });
    assert.equal(r.status, 200); assert.equal(r.json.stale, true); assert.equal(r.json.recreated, false);
    assert.equal(d.count(/^DELETE/), 0); assert.equal(d.count(/^POST \/containers\/create/), 0);
  });

  for (const forma of [{ bareIds: true }, { bareImageIds: true }]) {
    test(`ID da imagem com e sem 'sha256:' (${Object.keys(forma)[0]}): a mesma imagem não recria`, async () => {
      const d = instalacaoPresa(forma); d.containers.delete(nome(U1));
      const m = mm.createManager(cfg(B_REF), d.docker);
      await ensure(m, U1);
      await ensure(m, U1, { idle: true });
      await m.handle('POST', `/v1/motors/${U1}/stop`, MASTER, null);
      const r = await ensure(m, U1);
      assert.equal(r.json.recreated, false); assert.equal(r.json.stale, false);
      assert.equal(d.count(/^POST \/containers\/create/), 1);
      assert.equal(r.json.image, `sha256:${B}`);
    });
  }

  test('imagem por digest ausente: baixa pela referência inteira, sem tag, e recria', async () => {
    const d = instalacaoPresa(); const b = d.images.get(B)!; d.images.delete(B); d.registry.set(B_REF, b);
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1);
    assert.equal(r.json.recreated, true, JSON.stringify(r.json));
    const pulls = d.calls.filter((x) => x.startsWith('POST /images/create'));
    assert.deepEqual(pulls, [`POST /images/create?fromImage=${encodeURIComponent(B_REF)}`]);
    assert.match(pulls[0], /fromImage=ghcr\.io%2Fexemplo%2Fergon-community-hermes%40sha256%3A[a-f0-9]{64}$/);
    assert.ok(!pulls[0].includes('tag='));
    assert.equal(d.containers.get(nome(U1))!.image, B);
  });

  test('pedido de download: tag só depois da última barra (porta do registro não é tag)', () => {
    assert.equal(mm.pullQuery('localhost:5000/ergon-hermes:1.2'), 'fromImage=localhost%3A5000%2Fergon-hermes&tag=1.2');
    assert.equal(mm.pullQuery('localhost:5000/ergon-hermes'), 'fromImage=localhost%3A5000%2Fergon-hermes&tag=latest');
    assert.equal(mm.pullQuery('ergon-hermes:dev'), 'fromImage=ergon-hermes&tag=dev');
    assert.equal(mm.pullQuery(`${MOTOR}:1.1.0@${dig('ab')}`), `fromImage=${encodeURIComponent(`${MOTOR}:1.1.0@${dig('ab')}`)}`);
  });

  test('sem internet e sem a imagem nova: liga o motor de antes e avisa stale, dizendo por quê (sem-imagem)', async () => {
    const d = instalacaoPresa(); d.images.delete(B);
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1);
    assert.equal(r.status, 200); assert.equal(r.json.stale, true); assert.equal(r.json.recreated, false);
    assert.equal(r.json.motivo, 'sem-imagem', 'o Ergon abre o motor de antes em vez de esperar uma renovação que não vem');
    assert.equal(d.containers.get(nome(U1))!.image, A); assert.equal(d.containers.get(nome(U1))!.running, true);
  });

  test('a imagem nova some do disco depois de conferida (cache): o contêiner antigo não é removido, e o motor segue', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    assert.equal((await ensure(m, U1)).json.recreated, true); // B no cache do gerente
    await m.handle('POST', `/v1/motors/${U1}/stop`, MASTER, {});
    // alguém apagou a imagem B por fora, e a especificação mudou: o ID ainda vem do cache por digest
    d.images.delete(B); d.containers.get(nome(U1))!.spec.Labels['ergon.motor.spec'] = 'x';
    // o motor de antes, para o teste, numa imagem que existe (B saiu): a que estava antes, A
    d.containers.get(nome(U1))!.image = A;
    const n0 = d.count(/^DELETE \/containers/);
    const r = await ensure(m, U1, { idle: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.motivo, 'sem-imagem'); assert.equal(r.json.recreated, false);
    assert.equal(d.count(/^DELETE \/containers/), n0, 'o contêiner antigo fica');
    assert.ok(d.containers.get(nome(U1)), 'a pessoa nunca fica sem contêiner');
    assert.equal(d.containers.get(nome(U1))!.running, true, 'e ele segue ligado');
  });

  test('ligado sem o Ergon dizer que está livre: o motivo é "ocupado"', async () => {
    const d = instalacaoPresa(); d.containers.get(nome(U1))!.running = true;
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1);
    assert.equal(r.json.stale, true); assert.equal(r.json.motivo, 'ocupado');
  });

  test('uma operação por pessoa de cada vez: dois pedidos juntos recriam uma vez só; o ID da imagem vem do cache', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const [x, y] = await Promise.all([ensure(m, U1, { idle: true }), ensure(m, U1, { idle: true })]);
    assert.equal(x.json.recreated, true); assert.equal(y.json.recreated, false);
    assert.equal(d.count(/^POST \/containers\/create/), 1);
    // uma para o ID (o segundo pedido usa o cache) e uma conferência sem cache logo antes da troca: a imagem pode ter saído
    // do disco depois de conferida, e aí o contêiner antigo não é removido
    assert.equal(d.count(new RegExp(`^GET /images/${B_REF.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/json`)), 2);
  });

  test('outra instalação no mesmo Docker: o motor dela nunca é tocado', async () => {
    const d = instalacaoPresa();
    const other = mm.createManager({ ...cfg(A_REF), master: OUTRO }, d.docker);
    assert.equal((await other.handle('POST', `/v1/motors/${U3}/ensure`, OUTRO, {})).status, 200);
    const m = mm.createManager(cfg(B_REF), d.docker);
    const before = d.calls.length;
    assert.equal((await ensure(m, U3, { idle: true })).status, 409);
    assert.equal((await m.handle('POST', `/v1/motors/${U3}/stop`, MASTER, null)).status, 409);
    assert.equal((await m.handle('DELETE', `/v1/motors/${U3}`, MASTER, null)).status, 409);
    const list = (await m.handle('GET', '/v1/motors', MASTER, null)).json.motors;
    assert.ok(!list.some((x: { uid: string }) => x.uid === U3));
    assert.deepEqual(await m.reconcileOnStart(), [], 'nem o antigo sem marca, nem o de outra instalação');
    assert.equal(d.containers.get(nome(U3))!.image, A); assert.equal(d.containers.get(nome(U3))!.running, true);
    assert.equal(d.calls.slice(before).filter((x) => x.includes(nome(U3)) && !x.startsWith('GET')).length, 0, 'nem parou, nem removeu');
  });
});


describe('gerente de motores: confirmar e voltar', () => {
  test('voltar recria na imagem anterior com a trava (hold); o ensure seguinte não recria; a versão seguinte sim', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    await ensure(m, U1);
    const rb = await m.handle('POST', `/v1/motors/${U1}/rollback`, MASTER, {});
    assert.equal(rb.status, 200, JSON.stringify(rb.json));
    const c = d.containers.get(nome(U1))!;
    assert.equal(c.image, A, 'de volta na imagem anterior');
    assert.equal(c.spec.HostConfig.Mounts[0].Source, vol(U1));
    assert.equal(c.spec.Labels['ergon.motor.hold'], B_REF, 'a imagem recusada fica anotada');
    assert.equal(c.spec.Labels['ergon.motor.prev-image'], undefined);
    assert.equal(rb.json.pendente, false);
    const creates = d.count(/^POST \/containers\/create/);
    for (const body of [{ idle: true }, {}]) {
      const r = await ensure(m, U1, body);
      assert.equal(r.json.recreated, false); assert.equal(r.json.stale, false, 'sem laço de recriação');
    }
    await m.handle('POST', `/v1/motors/${U1}/stop`, MASTER, null);
    assert.equal((await ensure(m, U1)).json.recreated, false);
    assert.equal(d.count(/^POST \/containers\/create/), creates);
    assert.equal((await m.handle('GET', '/v1/motors', MASTER, null)).json.motors.find((x: { uid: string }) => x.uid === U1).stale, false);
    assert.equal((await m.handle('POST', `/v1/motors/${U1}/rollback`, MASTER, {})).status, 409, 'sem imagem anterior para voltar');
    // veio outra versão: a trava não vale mais
    d.addImage({ id: C, digests: [C_REF], created: 7 });
    const next = await ensure(mm.createManager(cfg(C_REF), d.docker), U1, { idle: true });
    assert.equal(next.json.recreated, true);
    assert.equal(d.containers.get(nome(U1))!.image, C);
    assert.equal(d.containers.get(nome(U1))!.spec.Labels['ergon.motor.hold'], undefined);
  });

  test('confirmar apaga a imagem anterior sem força; em uso por outro motor, ou guardada para outra troca, fica', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    d.addContainer(nome(U2), specRc22(U2, vol(U2), A_REF), A, true); // outra pessoa ainda na imagem A, trabalhando
    await ensure(m, U1);
    const busy = await m.handle('POST', `/v1/motors/${U1}/confirm`, MASTER, null);
    assert.equal(busy.status, 200); assert.equal(busy.json.removida, false); assert.equal(busy.json.emUso, true);
    assert.ok(d.images.has(A));
    // a outra pessoa também troca: as duas renovações têm a mesma imagem anterior
    assert.equal((await ensure(m, U2, { idle: true })).json.recreated, true);
    // duas trocas da mesma imagem anterior: confirmar a primeira não apaga o que a segunda ainda pode precisar
    const d2 = instalacaoPresa(); const m2 = mm.createManager(cfg(B_REF), d2.docker);
    d2.addContainer(nome(U2), specRc22(U2, vol(U2), A_REF), A, false);
    await ensure(m2, U1); await ensure(m2, U2);
    const first = await m2.handle('POST', `/v1/motors/${U1}/confirm`, MASTER, null);
    assert.equal(first.json.removida, false, 'U2 ainda pode precisar voltar para A');
    const second = await m2.handle('POST', `/v1/motors/${U2}/confirm`, MASTER, null);
    assert.equal(second.json.removida, true); assert.equal(second.json.id, `sha256:${A}`);
    assert.equal(d2.images.has(A), false);
    assert.ok(d2.calls.includes(`DELETE /images/sha256:${A}`), 'sem força');
    assert.equal(d2.count(/^DELETE \/volumes/), 0);
  });
});

describe('gerente de motores: limpeza', () => {
  const removed = (r: { json: { removidas: { id: string }[] } }) => r.json.removidas.map((x) => x.id.slice(7, 15)).sort();
  const clean = (m: ReturnType<typeof mm.createManager>, body: unknown) => m.handle('POST', '/v1/maintenance/clean', MASTER, body);

  test('a estimativa (para o botão "Liberar espaço (X GB)") faz a mesma conta da limpeza, sem apagar nada', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const e = await m.handle('POST', '/v1/maintenance/estimate', MASTER, { users: [U1], pendentes: [] });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    assert.equal(e.json.liberavel, 4 * 116e6 + 3 * 12e6);
    assert.equal(d.count(/^DELETE/), 0, 'nada apagado'); assert.equal(d.count(/\/stop/), 0, 'nada desligado');
    const r = await clean(m, { users: [U1], pendentes: [] });
    assert.equal(r.json.liberado, e.json.liberavel, 'a limpeza libera o que a estimativa disse');
    assert.equal((await m.handle('POST', '/v1/maintenance/estimate', MASTER, { users: [U1] })).json.liberavel, 0, 'depois de limpar, nada');
  });

  test('no estado real antes da troca: a imagem atual sem contêiner nunca sai, terceiros ficam, nenhum volume é apagado', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const r = await clean(m, { users: [U1], pendentes: [] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(removed(r), ['c1c1c1c1', 'c2c2c2c2', 'c3c3c3c3', 'c4c4c4c4', 'd1d1d1d1', 'd2d2d2d2', 'd3d3d3d3']);
    assert.ok(d.images.has(B), 'a do motor da versão atual (sem contêiner) fica');
    assert.ok(d.images.has(A), 'a que o motor usa fica');
    assert.ok(d.images.has(CORE_NOW), 'a do núcleo (servidor e gerente) fica');
    assert.ok(!d.images.has(h('c4c4c4c4')), 'a versão anterior do núcleo sai (mesma regra do lançador)');
    for (const t of ['a1a1a1a1', '9e9e9e9e', '3e3e3e3e', '0d0d0d0d']) assert.ok(d.images.has(h(t)), `imagem de fora fica (${t})`);
    assert.equal(d.count(/^DELETE \/volumes/), 0);
    assert.equal(d.count(/prune/), 0, 'nunca prune');
    assert.equal(d.count(/^DELETE \/containers/), 0);
    assert.equal(r.json.liberado, 4 * 116e6 + 3 * 12e6, 'só o que era exclusivo de cada imagem (as camadas do Hermes são compartilhadas)');
    assert.deepEqual(r.json.repositorios.sort(), [CORE, MOTOR]);
    assert.ok(d.containers.get(nome(U1)), 'o motor continua');
  });

  test('com a conta do disco (Docker), o liberado é a diferença real', async () => {
    const d = instalacaoPresa({ layersSize: true });
    const r = await clean(mm.createManager(cfg(B_REF), d.docker), { users: [U1] });
    assert.equal(r.json.liberado, 4 * 116e6 + 3 * 12e6);
  });

  test('a versão anterior do núcleo fica só se pedido; sem se achar, o gerente não mexe no núcleo; 409 fica', async () => {
    const d = instalacaoPresa(); d.images.get(h('d1d1d1d1'))!.conflito = true;
    const r = await clean(mm.createManager(cfg(B_REF), d.docker), { users: [U1], manterNucleoAnterior: true });
    assert.ok(!removed(r).includes('c4c4c4c4') && d.images.has(h('c4c4c4c4')), 'pedido para guardar: fica');
    assert.ok(d.images.has(h('d1d1d1d1')), 'quem respondeu 409 fica, sem erro');
    const d2 = instalacaoPresa();
    const r2 = await clean(mm.createManager(cfg(B_REF, { selfIds: [] }), d2.docker), { users: [U1] });
    assert.deepEqual(removed(r2), ['d1d1d1d1', 'd2d2d2d2', 'd3d3d3d3'], 'só imagens antigas do motor');
    assert.deepEqual(r2.json.repositorios, [MOTOR]);
  });

  test('depois da troca: a imagem anterior de uma troca pendente fica (mesmo com o gerente reiniciado)', async () => {
    const d = instalacaoPresa();
    await ensure(mm.createManager(cfg(B_REF), d.docker), U1);
    const fresh = () => mm.createManager(cfg(B_REF), d.docker); // reiniciado: não lembra das trocas
    await clean(fresh(), { users: [U1], pendentes: [U1] });
    assert.ok(d.images.has(A), 'o Ergon disse que a troca ainda não foi confirmada');
    const r = await clean(fresh(), { users: [U1], pendentes: [] });
    assert.ok(removed(r).includes('a0a0a0a2'));
    assert.ok(d.images.has(B));
  });

  test('contêiner de conta removida (desta instalação) sai sem força; o cofre fica e vira aviso; de outra instalação, nada', async () => {
    const d = instalacaoPresa(); d.containers.delete(nome(U1));
    const m = mm.createManager(cfg(B_REF), d.docker);
    await ensure(m, U2);
    const other = mm.createManager({ ...cfg(A_REF), master: OUTRO }, d.docker);
    await other.handle('POST', `/v1/motors/${U3}/ensure`, OUTRO, {});
    await other.handle('POST', `/v1/motors/${U3}/stop`, OUTRO, null);
    // a outra instalação renova o motor dela: a imagem anterior (A) fica anotada lá
    d.addImage({ id: C, digests: [C_REF], created: 7 });
    await mm.createManager({ ...cfg(C_REF), master: OUTRO }, d.docker).handle('POST', `/v1/motors/${U3}/ensure`, OUTRO, { start: false });
    assert.equal(d.containers.get(nome(U3))!.image, C);
    d.addContainer('ergon-motor-legado', specRc22(`usr_${'9'.repeat(32)}`, `ergon_motor-${'9'.repeat(32)}`, `${MOTOR}@${dig('d1d1d1d19')}`), h('d1d1d1d1'), false); // sem marca e fora da lista
    const idU2 = d.containers.get(nome(U2))!.id;
    const r = await clean(m, { users: [U1] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(d.containers.has(nome(U2)), false, 'o motor da conta removida saiu');
    assert.ok(d.volumes.has(vol(U2)), 'o cofre dela ficou');
    assert.deepEqual(r.json.avisos.map((a: { volume: string; motivo: string }) => [a.volume, a.motivo]), [[vol(U2), 'conta-removida']]);
    assert.ok(d.containers.has(nome(U3)), 'o de outra instalação ficou');
    assert.ok(d.containers.has('ergon-motor-legado'), 'o antigo sem marca e fora da lista ficou');
    assert.ok(d.images.has(A), 'a imagem anterior da outra instalação ficou (nenhum contêiner usa, mas ela pode precisar voltar)');
    assert.ok(d.calls.includes(`DELETE /containers/${idU2}`), 'pelo ID, sem força e sem volumes');
    assert.equal(d.count(/^DELETE \/volumes/), 0);
    // sem a lista de contas, nenhum contêiner sai
    await ensure(m, U2);
    await clean(m, {});
    assert.ok(d.containers.has(nome(U2)));
  });

  test('cofres órfãos: o Ergon decide; a limpeza só avisa; apagar recusa o herdado, o que está em uso e o que não é de motor', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const orfao = `ergon_motor-${'5'.repeat(32)}`; d.volumes.add(orfao); d.volumes.add('ergon_hermes-vault');
    const lv = (await m.handle('GET', '/v1/volumes', MASTER, null)).json.volumes;
    assert.deepEqual(lv.map((x: { nome: string; emUso: boolean }) => [x.nome, x.emUso]).sort(), [[orfao, false], [vol(U1), true], ['ergon_hermes-vault', false]].sort());
    const r = await clean(m, { users: [U1], volumesOrfaos: [orfao, vol(U1), 'ergon_hermes-vault'] });
    assert.deepEqual(r.json.avisos.map((a: { volume: string }) => a.volume), [orfao], 'só o órfão de verdade vira aviso');
    assert.ok(d.volumes.has(orfao));
    const del = (n: string) => m.handle('DELETE', `/v1/volumes/${encodeURIComponent(n)}`, MASTER, null);
    assert.equal((await del('ergon_hermes-vault')).status, 409);
    assert.equal((await del('ergon_ergon-data')).status, 400);
    assert.equal((await del(vol(U1))).status, 409);
    assert.equal((await del('../x')).status, 400);
    assert.ok(d.volumes.has('ergon_hermes-vault') && d.volumes.has('ergon_ergon-data') && d.volumes.has(vol(U1)));
    const ok = await del(orfao);
    assert.equal(ok.status, 200); assert.equal(ok.json.removido, true);
    assert.equal(d.volumes.has(orfao), false);
    assert.equal(d.count(/^DELETE \/volumes/), 1);
  });

  test('cofre novo leva a marca da instalação; sem motor e sem conta na lista vira aviso; reinstalação, sem marca e de outra instalação não', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    await ensure(m, U2);
    assert.deepEqual(d.volLabels.get(vol(U2)), { 'ergon.instalacao': mm.installTag(MASTER), 'ergon.motor': U2 });
    const other = mm.createManager({ ...cfg(B_REF), master: OUTRO }, d.docker);
    await other.handle('POST', `/v1/motors/${U3}/ensure`, OUTRO, {});
    // nenhum dos três tem contêiner agora (como depois de reinstalar, ou de apagar à mão)
    for (const u of [U2, U3]) d.containers.delete(nome(u));
    d.containers.delete(nome(U1));
    const semMarca = `ergon_motor-${'4'.repeat(32)}`; d.volumes.add(semMarca);
    const reinstalada = await m.handle('POST', '/v1/maintenance/clean', MASTER, { users: [U1, U2] });
    assert.deepEqual(reinstalada.json.avisos, [], 'contas da lista: nenhuma oferta de apagar');
    const r = await m.handle('POST', '/v1/maintenance/clean', MASTER, { users: [U1] });
    assert.deepEqual(r.json.avisos.map((a: { volume: string; motivo: string }) => [a.volume, a.motivo]), [[vol(U2), 'sem-conta']],
      'só o cofre desta instalação cuja conta não está na lista (o sem marca e o de outra instalação, só se o Ergon mandar o nome)');
    const comNome = await m.handle('POST', '/v1/maintenance/clean', MASTER, { users: [U1], volumesOrfaos: [semMarca, vol(U1)] });
    assert.deepEqual(comNome.json.avisos.map((a: { volume: string }) => a.volume).sort(), [vol(U2), semMarca].sort());
    // Docker compartilhado: o cofre com a marca de outra instalação não vira aviso nem com o nome mandado
    const outraComNome = await m.handle('POST', '/v1/maintenance/clean', MASTER, { users: [U1], volumesOrfaos: [vol(U3)] });
    assert.ok(!outraComNome.json.avisos.some((a: { volume: string }) => a.volume === vol(U3)));
    assert.ok(d.volumes.has(vol(U2)) && d.volumes.has(vol(U3)) && d.volumes.has(semMarca));
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });

  test('Docker compartilhado: o cofre de outra instalação nem aparece na lista e nunca é apagado; o sem marca aparece como tal', async () => {
    const d = instalacaoPresa(); const m = mm.createManager(cfg(B_REF), d.docker);
    const other = mm.createManager({ ...cfg(B_REF), master: OUTRO }, d.docker);
    await other.handle('POST', `/v1/motors/${U3}/ensure`, OUTRO, {});
    d.containers.delete(nome(U3)); // a outra instalação foi removida (os cofres ficam) ou está reinstalando
    const semMarca = `ergon_motor-${'4'.repeat(32)}`; d.volumes.add(semMarca);
    const lv = (await m.handle('GET', '/v1/volumes', MASTER, null)).json.volumes as Array<{ nome: string; instalacao: string }>;
    assert.ok(!lv.some((x) => x.nome === vol(U3)), 'o de outra instalação não aparece');
    assert.equal(lv.find((x) => x.nome === semMarca)?.instalacao, 'sem-marca');
    const del = await m.handle('DELETE', `/v1/volumes/${vol(U3)}`, MASTER, null);
    assert.equal(del.status, 409); assert.match(del.json.error, /outra instalação/);
    assert.ok(d.volumes.has(vol(U3)));
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });

  test('o corpo cabe a lista de 1.000 pessoas; acima de 64 KB, recusa', async () => {
    const d = instalacaoPresa();
    const srv = mm.serveManager(cfg(B_REF), d.docker, 0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/maintenance/clean`;
      const users = Array.from({ length: 1000 }, (_, i) => `usr_${i.toString(16).padStart(32, '0')}`);
      const post = (body: string) => fetch(url, { method: 'POST', headers: { 'X-Ergon-Manager-Token': MASTER, 'Content-Type': 'application/json' }, body });
      const big = JSON.stringify({ users: [...users, U1], pendentes: [] });
      assert.ok(big.length > 4096 && big.length < 64 * 1024);
      assert.equal((await post(big)).status, 200);
      assert.equal((await post(JSON.stringify({ users, pad: 'x'.repeat(70 * 1024) }))).status, 413);
    } finally { srv.close(); }
  });
});

describe('gerente de motores: partida e lista', () => {
  test('na partida, só os motores parados e desatualizados desta instalação são recriados, sem ligar', async () => {
    const d = instalacaoPresa(); d.containers.delete(nome(U1));
    const old = mm.createManager(cfg(A_REF), d.docker);
    await ensure(old, U1); await ensure(old, U2);
    await old.handle('POST', `/v1/motors/${U2}/stop`, MASTER, null);
    d.addContainer(nome(U3), specRc22(U3, vol(U3), A_REF), A, false); // antigo, sem marca: espera o Ergon pedir
    const m = mm.createManager(cfg(B_REF), d.docker);
    const before = d.calls.length;
    assert.deepEqual(await m.reconcileOnStart(), [U2]);
    assert.equal(d.containers.get(nome(U2))!.image, B); assert.equal(d.containers.get(nome(U2))!.running, false, 'recriado sem ligar');
    assert.equal(d.containers.get(nome(U1))!.image, A); assert.equal(d.containers.get(nome(U1))!.running, true, 'o ligado ficou');
    assert.equal(d.containers.get(nome(U3))!.image, A, 'o antigo sem marca ficou');
    assert.equal(d.calls.slice(before).filter((x) => (x.includes(nome(U1)) || x.includes(nome(U3))) && !x.startsWith('GET')).length, 0);
    const lst = (await m.handle('GET', '/v1/motors', MASTER, null)).json.motors as { uid: string; stale: boolean; legado: boolean; image: string; prevImage: string | null }[];
    assert.deepEqual(lst.map((x) => [x.uid, x.stale, x.legado]).sort(), [[U1, true, false], [U2, false, false], [U3, true, true]].sort());
    assert.equal(lst.find((x) => x.uid === U2)!.prevImage, `sha256:${A}`);
    // o Ergon pede o motor: fica sabendo que ele foi trocado (para reentregar a chave e confirmar), uma vez
    const r = await ensure(m, U2);
    assert.equal(r.json.recreated, true); assert.equal(r.json.pendente, true); assert.equal(d.containers.get(nome(U2))!.running, true);
    assert.equal((await ensure(m, U2)).json.recreated, false);
  });

  test('o gerente se acha pelo mountinfo, pelo cgroup ou pelo nome da máquina', () => {
    const dk = 'a'.repeat(64); const pd = 'b'.repeat(64); const cg = 'c'.repeat(64);
    const files: Record<string, string> = {
      '/proc/self/mountinfo': `1 2 0:1 /var/lib/docker/containers/${dk}/hostname /etc/hostname rw\n3 4 0:2 /var/lib/containers/storage/overlay-containers/${pd}/userdata/hosts /etc/hosts rw\n5 6 0:3 /var/lib/docker/overlay2/${'d'.repeat(64)}/merged / rw`,
      '/proc/self/cgroup': `0::/\n12:memory:/machine.slice/libpod-${cg}.scope`,
    };
    assert.deepEqual(mm.selfContainerIds((p) => files[p] ?? '', 'motores'), [dk, pd, cg]);
    assert.deepEqual(mm.selfContainerIds(() => '', '0123456789ab'), ['0123456789ab']);
  });
});

describe('gerente de motores: queda no meio da troca e limpeza ao mesmo tempo', () => {
  const espera = async (cond: () => unknown, n = 200) => { for (let i = 0; i < n && !cond(); i++) await new Promise((x) => setTimeout(x, 5)); };

  test('o gerente cai entre remover o contêiner antigo e criar o novo: o próximo ensure monta o cofre DA PESSOA, nunca o herdado', async () => {
    const d = instalacaoPresa(); // U1 parado na A (como a rc.22 criava), cofre ergon_motor-<U1>
    d.volumes.add('ergon_hermes-vault'); // o cofre do motor de antes (um motor só) ainda existe e ninguém o usa
    d.addImage({ id: B, digests: [B_REF], created: 6, size: 3.28e9, shared: 3.268e9 });
    let travar = true;
    const docker = async (m: string, p: string, b?: unknown) => {
      if (travar && m === 'POST' && p.startsWith('/containers/create')) return new Promise<never>(() => {}); // o processo do gerente morre aqui
      return d.docker(m, p, b);
    };
    void mm.createManager(cfg(B_REF), docker).handle('POST', `/v1/motors/${U1}/ensure`, MASTER, { adoptLegacy: true, idle: true, start: true });
    await espera(() => !d.containers.has(nome(U1)));
    assert.equal(d.containers.has(nome(U1)), false, 'o contêiner antigo saiu e o novo ainda não existe');
    travar = false;
    // o gerente reinicia (compose) e o Ergon pede de novo, como sempre (a pessoa é a administradora e ninguém herdou o cofre de antes)
    const r = await ensure(mm.createManager(cfg(B_REF), d.docker), U1, { adoptLegacy: true, idle: true, start: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = d.containers.get(nome(U1))!;
    assert.equal(c.spec.HostConfig.Mounts[0].Source, vol(U1), 'o motor volta no MESMO cofre da pessoa');
    assert.equal(r.json.adopted, false, 'não herda o cofre de antes: a pessoa já tem o dela');
    assert.ok(d.volumes.has('ergon_hermes-vault'), 'o herdado fica como estava');
    assert.equal(d.count(/^DELETE \/volumes/), 0);
    // quem não tem cofre nenhum ainda herda o de antes (o caminho de sempre)
    const r2 = await ensure(mm.createManager(cfg(B_REF), d.docker), U2, { adoptLegacy: true });
    assert.equal(r2.json.adopted, true);
    assert.equal(d.containers.get(nome(U2))!.spec.HostConfig.Mounts[0].Source, 'ergon_hermes-vault');
  });

  test('limpeza com a listagem lenta enquanto outra pessoa troca: a troca espera a limpeza e a imagem anterior dela fica', async () => {
    const d = instalacaoPresa();
    d.addImage({ id: B, digests: [B_REF], created: 6, size: 3.28e9, shared: 3.268e9 });
    let soltarLista = null as (() => void) | null; let segurou = false;
    const docker = async (m: string, p: string, b?: unknown) => {
      if (m === 'GET' && p === '/containers/json?all=1' && !segurou) { segurou = true; await new Promise<void>((ok) => { soltarLista = ok; }); }
      return d.docker(m, p, b);
    };
    const g = mm.createManager(cfg(B_REF), docker);
    const limpeza = g.clean({ users: [U1], pendentes: [U1] }); // o Ergon diz que U1 ainda não confirmou
    await espera(() => soltarLista);
    assert.ok(soltarLista, 'a listagem da limpeza está presa');
    const troca = g.ensure(U1, { idle: true, start: false }); // U1 entra agora
    await new Promise((x) => setTimeout(x, 50));
    assert.equal(d.count(new RegExp(`^DELETE /containers/${nome(U1)}`)), 0, 'a troca não remove o contêiner no meio da limpeza');
    soltarLista!();
    const l = await limpeza; const r = await troca;
    assert.equal(r.recreated, true, 'depois da limpeza, a troca acontece');
    assert.equal(r.prevImage, `sha256:${A}`);
    assert.ok(!l.removidas.some((x) => x.id === `sha256:${A}`), 'a limpeza não apagou a imagem anterior de quem está trocando');
    assert.ok(d.images.has(A), 'a volta atrás continua possível');
    const v = await g.rollback(U1, false);
    assert.equal(d.containers.get(nome(U1))!.image, A); assert.equal(v.recreated, true);
  });

  test('a estimativa não espera troca nenhuma nem segura as trocas (não apaga nada)', async () => {
    const d = instalacaoPresa();
    let soltarLista = null as (() => void) | null; let segurou = false;
    const docker = async (m: string, p: string, b?: unknown) => {
      if (m === 'GET' && p === '/containers/json?all=1' && !segurou) { segurou = true; await new Promise<void>((ok) => { soltarLista = ok; }); }
      return d.docker(m, p, b);
    };
    const g = mm.createManager(cfg(B_REF), docker);
    const est = g.clean({ users: [U1], estimar: true });
    await espera(() => soltarLista);
    const r = await g.ensure(U1, { idle: true, start: false });
    assert.equal(r.recreated, true, 'a troca não esperou a estimativa');
    soltarLista!();
    assert.deepEqual((await est).removidas, []);
  });
});

describe('gerente de motores: com a forma do Podman 5.6.2 de verdade', () => {
  const clean = (m: ReturnType<typeof mm.createManager>, body: unknown) => m.handle('POST', '/v1/maintenance/clean', MASTER, body);

  test('o falso responde como o Podman sondado: HostConfig.Mounts null, df com LayersSize e Id sem sha256:, cofre sem rótulo {}, 404 com cause', async () => {
    const d = instalacaoPresa({ podman: true });
    const i = await d.docker('GET', `/containers/${nome(U1)}/json`);
    assert.equal(i.json.HostConfig.Mounts, null);
    assert.deepEqual(i.json.HostConfig.Binds, [`${vol(U1)}:/vault:rprivate,nosuid,nodev,rbind`]);
    assert.deepEqual(i.json.Mounts.map((m: { Name: string; Destination: string }) => [m.Name, m.Destination]), [[vol(U1), '/vault']]);
    const df = await d.docker('GET', '/system/df');
    assert.ok(df.json.LayersSize > 0, 'o Podman 5.x devolve o total das camadas');
    assert.ok(df.json.Images.every((x: { Id: string; RepoTags: string[] }) => /^[a-f0-9]{64}$/.test(x.Id) && x.RepoTags[0] === '<none>'));
    const il = await d.docker('GET', '/images/json');
    assert.deepEqual(il.json.find((x: { Id: string }) => x.Id === `sha256:${A}`).RepoTags, [A_REF], 'sem tag, o Podman põe ali a referência com digest');
    const vs = await d.docker('GET', '/volumes');
    assert.deepEqual(vs.json.Warnings, []); assert.deepEqual(vs.json.Volumes.find((x: { Name: string }) => x.Name === vol(U1)).Labels, {});
    const nf = await d.docker('GET', `/containers/${nome(U2)}/json`);
    assert.equal(nf.status, 404); assert.equal(nf.json.cause, 'no such container'); assert.equal(nf.json.response, 404);
  });

  test('caso real: o inspect não traz HostConfig.Mounts e a renovação dá certo só pelo Mounts[].Name (mesmo cofre, e a volta também)', async () => {
    const d = instalacaoPresa({ podman: true }); const m = mm.createManager(cfg(B_REF), d.docker);
    const r = await ensure(m, U1, { adoptLegacy: true, idle: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.recreated, true); assert.equal(r.json.prevImage, `sha256:${A}`);
    const c = d.containers.get(nome(U1))!;
    assert.equal(c.image, B); assert.equal(c.spec.HostConfig.Mounts[0].Source, vol(U1), 'o mesmo cofre');
    const v = await m.handle('POST', `/v1/motors/${U1}/rollback`, MASTER, { start: false });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(d.containers.get(nome(U1))!.image, A); assert.equal(d.containers.get(nome(U1))!.spec.HostConfig.Mounts[0].Source, vol(U1));
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });

  test('sem Mounts[].Name e sem HostConfig.Mounts (só HostConfig.Binds, como o Podman guarda): o cofre ainda é achado, e a troca é no mesmo', async () => {
    const d = instalacaoPresa({ podman: true });
    const docker = async (m: string, p: string, b?: unknown) => {
      const r = await d.docker(m, p, b);
      if (m === 'GET' && /^\/containers\/[\w.-]+\/json$/.test(p) && r.status === 200) r.json = { ...r.json, Mounts: [] };
      return r;
    };
    const r = await ensure(mm.createManager(cfg(B_REF), docker), U1, { idle: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(d.containers.get(nome(U1))!.image, B);
    assert.equal(d.containers.get(nome(U1))!.spec.HostConfig.Mounts[0].Source, vol(U1));
  });

  test('limpeza: o liberado é a diferença real do disco (LayersSize), igual à estimativa', async () => {
    const d = instalacaoPresa({ podman: true }); const m = mm.createManager(cfg(B_REF), d.docker);
    const e = await m.handle('POST', '/v1/maintenance/estimate', MASTER, { users: [U1], pendentes: [] });
    assert.equal(e.json.liberavel, 4 * 116e6 + 3 * 12e6);
    const antes = (await d.docker('GET', '/system/df')).json.LayersSize;
    const r = await clean(m, { users: [U1], pendentes: [] });
    assert.deepEqual(r.json.removidas.map((x: { id: string }) => x.id.slice(7, 15)).sort(), ['c1c1c1c1', 'c2c2c2c2', 'c3c3c3c3', 'c4c4c4c4', 'd1d1d1d1', 'd2d2d2d2', 'd3d3d3d3']);
    const depois = (await d.docker('GET', '/system/df')).json.LayersSize;
    assert.equal(r.json.liberado, antes - depois, 'a diferença real');
    assert.equal(r.json.liberado, e.json.liberavel);
    for (const t of ['a1a1a1a1', '9e9e9e9e', '3e3e3e3e', '0d0d0d0d']) assert.ok(d.images.has(h(t)), `imagem de fora fica (${t})`);
    assert.ok(d.images.has(A) && d.images.has(B) && d.images.has(CORE_NOW) && !d.images.has(h('c4c4c4c4')));
    assert.deepEqual(r.json.repositorios.sort(), [CORE, MOTOR]);
  });

  test('cofres sem rótulo ({} no Podman) contam como "sem marca", nunca como de outra instalação', async () => {
    const d = instalacaoPresa({ podman: true }); const m = mm.createManager(cfg(B_REF), d.docker);
    const semMarca = `ergon_motor-${'4'.repeat(32)}`; d.volumes.add(semMarca);
    const lv = (await m.handle('GET', '/v1/volumes', MASTER, null)).json.volumes as Array<{ nome: string; instalacao: string; emUso: boolean }>;
    assert.equal(lv.find((x) => x.nome === semMarca)?.instalacao, 'sem-marca');
    assert.equal(lv.find((x) => x.nome === vol(U1))?.emUso, true);
    const r = await clean(m, { users: [U1], volumesOrfaos: [semMarca] });
    assert.deepEqual(r.json.avisos.map((a: { volume: string }) => a.volume), [semMarca]);
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });
});
