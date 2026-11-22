/**
 * rc.46: o registro alternativo do gerente de motores (instalar da China, onde o ghcr.io não responde). Com
 * ERGON_REGISTRY (escolhido pela pessoa), a imagem do motor vem de lá primeiro; com o espelho publicado com a versão
 * (ERGON_REGISTRY_ESPELHO), só quando o ghcr.io não responde. A cópia do espelho, por tag, ganha o nome de sempre; por
 * digest, o motor é criado com o nome do espelho (o digest é o mesmo).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as mm from '../src/services/motor-manager.ts';
import { B, B_REF, MASTER, MOTOR, U1, cfg, instalacaoPresa, nome } from './docker-falso.ts';

const ensure = (m: ReturnType<typeof mm.createManager>, uid: string, body: unknown = {}) => m.handle('POST', `/v1/motors/${uid}/ensure`, MASTER, body);
const CN = 'registry.cn-hangzhou.aliyuncs.com/ergon';
const TAG_REF = `${MOTOR}:1.1.0-rc.46`;
const pulls = (d: ReturnType<typeof instalacaoPresa>) => d.calls.filter((x) => x.startsWith('POST /images/create')).map((x) => decodeURIComponent(x.slice('POST /images/create?'.length)));

describe('gerente de motores: registro alternativo (rc.46)', () => {
  test('o nome no outro registro: a mesma tag ou o mesmo digest, só para as imagens do Ergon', () => {
    assert.equal(mm.noRegistro(TAG_REF, CN), `${CN}/ergon-community-hermes:1.1.0-rc.46`);
    assert.equal(mm.noRegistro(B_REF, `https://${CN}/`), `${CN}/${B_REF.split('/').pop()}`);
    assert.equal(mm.noRegistro('ghcr.io/x/ergon-community:1.2.3', 'localhost:5000'), 'localhost:5000/ergon-community:1.2.3');
    assert.equal(mm.noRegistro('alpine:3.20', CN), null, 'imagem de terceiros fica como está');
    assert.equal(mm.noRegistro('sha256:' + 'a'.repeat(64), CN), null, 'um ID não muda de registro');
    for (const ruim of ['', 'ftp://x y', 'a/../b', 'Registro Com Espaço']) assert.equal(mm.noRegistro(TAG_REF, ruim), null, ruim);
  });

  test('ERGON_REGISTRY: a imagem vem do registro escolhido primeiro e ganha o nome de sempre; nada vai ao ghcr.io', async () => {
    const d = instalacaoPresa(); const b = d.images.get(B)!; d.images.delete(B);
    d.registry.set(`${CN}/ergon-community-hermes:1.1.0-rc.46`, { ...b, tags: [`${CN}/ergon-community-hermes:1.1.0-rc.46`] });
    const r = await ensure(mm.createManager(cfg(TAG_REF, { registro: CN }), d.docker), U1);
    assert.equal(r.json.recreated, true, JSON.stringify(r.json));
    assert.deepEqual(pulls(d), [`fromImage=${CN}/ergon-community-hermes&tag=1.1.0-rc.46`], 'uma tentativa só, no registro escolhido');
    assert.ok(d.images.get(B)!.tags.includes(TAG_REF), 'a cópia ganhou o nome de sempre');
    assert.equal(d.containers.get(nome(U1))!.image, B);
    assert.equal(d.containers.get(nome(U1))!.spec.Image, TAG_REF);
  });

  test('ERGON_REGISTRY fora do ar: o de sempre (ghcr.io) fica de reserva', async () => {
    const d = instalacaoPresa({ foraDoAr: ['registry.cn-hangzhou.aliyuncs.com'] }); const b = d.images.get(B)!; d.images.delete(B);
    d.registry.set(TAG_REF, { ...b, tags: [TAG_REF] });
    const r = await ensure(mm.createManager(cfg(TAG_REF, { registro: CN }), d.docker), U1);
    assert.equal(r.json.recreated, true, JSON.stringify(r.json));
    assert.deepEqual(pulls(d), [`fromImage=${CN}/ergon-community-hermes&tag=1.1.0-rc.46`, `fromImage=${MOTOR}&tag=1.1.0-rc.46`]);
  });

  test('o espelho da versão: só quando o ghcr.io não responde; com ele no ar, nem é tentado', async () => {
    const d = instalacaoPresa({ foraDoAr: ['ghcr.io'] }); const b = d.images.get(B)!; d.images.delete(B);
    d.registry.set(`${CN}/ergon-community-hermes:1.1.0-rc.46`, { ...b, tags: [`${CN}/ergon-community-hermes:1.1.0-rc.46`] });
    const r = await ensure(mm.createManager(cfg(TAG_REF, { espelho: CN }), d.docker), U1);
    assert.equal(r.json.recreated, true, JSON.stringify(r.json));
    assert.deepEqual(pulls(d), [`fromImage=${MOTOR}&tag=1.1.0-rc.46`, `fromImage=${CN}/ergon-community-hermes&tag=1.1.0-rc.46`]);
    assert.equal(d.containers.get(nome(U1))!.image, B);

    const d2 = instalacaoPresa(); const b2 = d2.images.get(B)!; d2.images.delete(B);
    d2.registry.set(TAG_REF, { ...b2, tags: [TAG_REF] }); d2.registry.set(`${CN}/ergon-community-hermes:1.1.0-rc.46`, b2);
    await ensure(mm.createManager(cfg(TAG_REF, { espelho: CN }), d2.docker), U1);
    assert.deepEqual(pulls(d2), [`fromImage=${MOTOR}&tag=1.1.0-rc.46`], 'o ghcr.io respondeu: o espelho nem é tentado');
  });

  test('por digest, pelo espelho: o motor é criado com o nome do espelho (o mesmo digest)', async () => {
    const d = instalacaoPresa({ foraDoAr: ['ghcr.io'] }); const b = d.images.get(B)!; d.images.delete(B);
    const noEspelho = `${CN}/${B_REF.split('/').pop()}`;
    d.registry.set(noEspelho, { ...b, digests: [noEspelho] });
    const r = await ensure(mm.createManager(cfg(B_REF, { espelho: CN }), d.docker), U1);
    assert.equal(r.json.recreated, true, JSON.stringify(r.json));
    assert.equal(d.containers.get(nome(U1))!.image, B);
    assert.equal(d.containers.get(nome(U1))!.spec.Image, noEspelho);
    assert.equal(d.count(/\/tag\?/), 0, 'digest não se põe à mão');
  });

  test('nenhum dos dois responde: o motor de antes segue ligado, com o motivo (sem-imagem)', async () => {
    const d = instalacaoPresa({ foraDoAr: ['ghcr.io', 'registry.cn-hangzhou.aliyuncs.com'] }); d.images.delete(B);
    const r = await ensure(mm.createManager(cfg(TAG_REF, { espelho: CN }), d.docker), U1);
    assert.equal(r.json.recreated, false);
  });
});
