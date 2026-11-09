/**
 * A cópia antiga dos dados do motor ("<projeto>_hermes-data", em texto aberto, de antes do cofre cifrado) sai sozinha
 * quando é seguro — e nunca outro volume. Gerente de verdade (createManager) com o Docker falso de docker-falso.ts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as mm from '../src/services/motor-manager.ts';
import { parseMotorInfo } from '../src/services/hermes.ts';
import { B, B_REF, MASTER, OUTRO, U1, U2, cfg, fakeDocker, nome, vol } from './docker-falso.ts';

const ANTIGO = 'ergon_hermes-data';
const HERDADO = 'ergon_hermes-vault';
const pedir = (m: ReturnType<typeof mm.createManager>, body: unknown) => m.handle('POST', '/v1/maintenance/dados-antigos', MASTER, body);

/** Instalação que veio do motor único: o cofre herdado (para onde a cópia antiga foi copiada) é o do motor de U2. */
async function instalacao(o: { semAntigo?: boolean; rotulos?: Record<string, string> } = {}) {
  const d = fakeDocker();
  d.addImage({ id: B, digests: [B_REF], created: 6, size: 3.28e9, shared: 3.268e9 });
  d.volumes.add(HERDADO);
  if (!o.semAntigo) { d.volumes.add(ANTIGO); d.volLabels.set(ANTIGO, o.rotulos ?? { 'com.docker.compose.project': 'ergon', 'com.docker.compose.volume': 'hermes-data' }); }
  d.volumes.add('ergon_ergon-data'); d.volumes.add('outro_hermes-data');
  const m = mm.createManager(cfg(B_REF), d.docker);
  const r = await m.handle('POST', `/v1/motors/${U2}/ensure`, MASTER, { adoptLegacy: true });
  assert.equal(r.json.adopted, true, 'U2 herdou o cofre de antes');
  assert.equal(d.containers.get(nome(U2))!.spec.HostConfig.Mounts[0].Source, HERDADO);
  return { d, m };
}
const outrosIntactos = (d: ReturnType<typeof fakeDocker>) => {
  for (const v of [HERDADO, 'ergon_ergon-data', 'outro_hermes-data']) assert.ok(d.volumes.has(v), `${v} fica`);
};

describe('gerente de motores: a cópia antiga dos dados do motor', () => {
  test('seguro (o cofre herdado é o do motor de quem o herdou, ninguém usa a cópia antiga): apaga só ela, sem força', async () => {
    const { d, m } = await instalacao();
    const r = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.apagado, true);
    assert.equal(d.volumes.has(ANTIGO), false, 'a cópia antiga saiu');
    outrosIntactos(d);
    assert.deepEqual(d.calls.filter((x) => x.startsWith('DELETE /volumes')), [`DELETE /volumes/${ANTIGO}`], 'nenhum outro volume, sem força');
    // de novo: já não existe
    const r2 = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.deepEqual([r2.json.apagado, r2.json.existia], [false, false]);
  });

  test('sem o Ergon confirmar o cofre herdado: fica', async () => {
    const { d, m } = await instalacao();
    const r = await pedir(m, { dono: U2 });
    assert.equal(r.json.apagado, false); assert.match(r.json.motivo, /não confirmou/);
    assert.ok(d.volumes.has(ANTIGO));
  });

  test('o cofre herdado não é o montado no motor da pessoa (ou ela nem tem motor): fica', async () => {
    const { d, m } = await instalacao();
    await m.handle('POST', `/v1/motors/${U1}/ensure`, MASTER, {}); // U1 tem o próprio cofre
    assert.equal(d.containers.get(nome(U1))!.spec.HostConfig.Mounts[0].Source, vol(U1));
    const r = await pedir(m, { dono: U1, cofreConfirmado: true });
    assert.equal(r.json.apagado, false); assert.match(r.json.motivo, /não é o montado/);
    d.containers.delete(nome(U2));
    const r2 = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.equal(r2.json.apagado, false); assert.match(r2.json.motivo, /não tem motor/);
    assert.ok(d.volumes.has(ANTIGO));
  });

  test('sem o cofre herdado no disco (a cópia nunca foi para dentro de um cofre): fica', async () => {
    const { d, m } = await instalacao();
    d.containers.get(nome(U2))!.spec.HostConfig.Mounts = []; d.volumes.delete(HERDADO);
    const r = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.equal(r.json.apagado, false); assert.match(r.json.motivo, /sem o cofre herdado/);
    assert.ok(d.volumes.has(ANTIGO));
  });

  test('ainda usada por um contêiner, mesmo parado (o motor único de antes): fica', async () => {
    const { d, m } = await instalacao();
    d.addContainer('ergon_hermes_1', { Image: B_REF, Labels: { 'com.docker.compose.service': 'hermes' }, HostConfig: { Mounts: [{ Type: 'volume', Source: ANTIGO, Target: '/legacy' }] } }, B, false);
    const r = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.equal(r.json.apagado, false); assert.match(r.json.motivo, /usada por um contêiner/);
    assert.ok(d.volumes.has(ANTIGO));
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });

  test('rótulos de outra instalação ou de outro projeto: fica', async () => {
    const casos: Array<Record<string, string>> = [{ 'ergon.instalacao': mm.installTag(OUTRO) }, { 'com.docker.compose.project': 'outro' }, { 'com.docker.compose.volume': 'outra-coisa' }];
    for (const rotulos of casos) {
      const { d, m } = await instalacao({ rotulos });
      const r = await pedir(m, { dono: U2, cofreConfirmado: true });
      assert.equal(r.json.apagado, false, JSON.stringify(rotulos));
      assert.ok(d.volumes.has(ANTIGO));
    }
  });

  test('instalação sem cofre herdado com o nome do projeto (ex.: ensaio do World): não procura nada', async () => {
    const d = fakeDocker(); d.volumes.add(ANTIGO);
    const m = mm.createManager(cfg(B_REF, { legacyVolume: 'ergon-world-teste_nenhum-cofre-antigo' }), d.docker);
    const r = await pedir(m, { dono: U2, cofreConfirmado: true });
    assert.deepEqual([r.json.apagado, r.json.existia], [false, false]);
    assert.ok(d.volumes.has(ANTIGO));
    assert.equal(d.count(/^DELETE/), 0);
  });

  test('a prova da cópia vem da saúde da ponte: só true conta; o plugin de antes (sem o campo) não sabe dizer', () => {
    const base = { ok: true, dashboard: true, plugin_version: '0.3.0', vault_config: 2, capacidades: ['conexoes'] };
    assert.equal(parseMotorInfo({ ...base, dados_antigos: true }).dadosAntigos, true);
    assert.equal(parseMotorInfo({ ...base, dados_antigos: false }).dadosAntigos, false);
    assert.equal(parseMotorInfo(base).dadosAntigos, null);
    assert.equal(parseMotorInfo({ ...base, dados_antigos: 'true' }).dadosAntigos, null, 'texto não vale');
  });

  test('o pedido não escolhe o volume: só o dono, validado; sem o token, nada', async () => {
    const { d, m } = await instalacao();
    assert.equal((await pedir(m, { dono: 'ergon_ergon-data', cofreConfirmado: true })).status, 400);
    assert.equal((await m.handle('POST', '/v1/maintenance/dados-antigos', 'errado'.padEnd(40, 'x'), { dono: U2, cofreConfirmado: true })).status, 401);
    assert.equal((await m.handle('GET', '/v1/maintenance/dados-antigos', MASTER, null)).status, 405);
    const r = await pedir(m, { dono: U2, cofreConfirmado: true, volume: 'ergon_ergon-data', nome: 'ergon_ergon-data' });
    assert.equal(r.json.apagado, true);
    outrosIntactos(d);
  });
  test('conferir (o cofre não confirmou a cópia): diz se daria para apagar, e nunca apaga', async () => {
    const { d, m } = await instalacao();
    const r = await pedir(m, { dono: U2, conferir: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.apagado, r.json.existia, r.json.conferido, r.json.podeApagar], [false, true, true, true]);
    assert.equal(r.json.cofreDeAntes, d.volumes.has(HERDADO), 'diz se o cofre de antes existe');
    d.volumes.delete(HERDADO);
    assert.equal((await pedir(m, { dono: U2, conferir: true })).json.cofreDeAntes, false);
    d.volumes.add(HERDADO);
    // conferir vence: nem com a prova junto apaga
    const r2 = await pedir(m, { dono: U2, conferir: true, cofreConfirmado: true, decisaoDaPessoa: true });
    assert.equal(r2.json.apagado, false);
    assert.ok(d.volumes.has(ANTIGO));
    assert.equal(d.count(/^DELETE/), 0);
    // em uso por um contêiner (mesmo parado): não daria
    d.addContainer('ergon_hermes_1', { Image: B_REF, Labels: {}, HostConfig: { Mounts: [{ Type: 'volume', Source: ANTIGO, Target: '/legacy' }] } }, B, false);
    const r3 = await pedir(m, { dono: U2, conferir: true });
    assert.deepEqual([r3.json.conferido, r3.json.podeApagar], [true, false]);
    // de outra instalação: também não
    const o = await instalacao({ rotulos: { 'ergon.instalacao': mm.installTag(OUTRO) } });
    const r4 = await pedir(o.m, { dono: U2, conferir: true });
    assert.deepEqual([r4.json.conferido, r4.json.podeApagar], [true, false]);
    // sem a cópia: existia false
    const s = await instalacao({ semAntigo: true });
    const r5 = await pedir(s.m, { dono: U2, conferir: true });
    assert.deepEqual([r5.json.existia, r5.json.conferido], [false, true]);
  });

  test('decisão da pessoa: apaga só a cópia antiga, sem a prova do cofre (nem precisa do cofre herdado montado), sem força', async () => {
    const { d, m } = await instalacao();
    d.containers.get(nome(U2))!.spec.HostConfig.Mounts = []; d.volumes.delete(HERDADO); // a cópia nunca foi para um cofre
    const r = await pedir(m, { dono: U1, decisaoDaPessoa: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.apagado, r.json.decidido], [true, true]);
    assert.equal(d.volumes.has(ANTIGO), false);
    assert.deepEqual(d.calls.filter((x) => x.startsWith('DELETE /volumes')), [`DELETE /volumes/${ANTIGO}`], 'nenhum outro volume, sem força');
    for (const v of ['ergon_ergon-data', 'outro_hermes-data']) assert.ok(d.volumes.has(v));
    const r2 = await pedir(m, { dono: U1, decisaoDaPessoa: true });
    assert.deepEqual([r2.json.apagado, r2.json.existia, r2.json.decidido], [false, false, true]);
  });

  test('decisão da pessoa não passa por cima das outras travas: outra instalação, outro projeto, em uso', async () => {
    for (const rotulos of [{ 'ergon.instalacao': mm.installTag(OUTRO) }, { 'com.docker.compose.project': 'outro' }] as Array<Record<string, string>>) {
      const { d, m } = await instalacao({ rotulos });
      const r = await pedir(m, { dono: U2, decisaoDaPessoa: true });
      assert.deepEqual([r.json.apagado, r.json.decidido], [false, true], JSON.stringify(rotulos));
      assert.ok(d.volumes.has(ANTIGO));
    }
    const { d, m } = await instalacao();
    d.addContainer('ergon_hermes_1', { Image: B_REF, Labels: {}, HostConfig: { Mounts: [{ Type: 'volume', Source: ANTIGO, Target: '/legacy' }] } }, B, false);
    const r = await pedir(m, { dono: U2, decisaoDaPessoa: true });
    assert.equal(r.json.apagado, false); assert.match(r.json.motivo, /usada por um contêiner/);
    assert.ok(d.volumes.has(ANTIGO));
    assert.equal(d.count(/^DELETE \/volumes/), 0);
  });
});
