/**
 * Loja do Ergon World no aplicativo local (world/src/marketplace.ts): colaborativa e grátis. A vitrine aparece sem conta;
 * o selo é "Oficial" (equipe) ou "Comunidade"; publicar é de graça, sem preço, com o id do criador e a revisão antes;
 * "minhas publicações" mostra as versões (GET /v1/marketplace/mine é proposto: o World de mentira o tem, o real ainda não).
 * Instalar passa pela validação de sempre; competência de terceiros chega com o texto inteiro, para ler antes.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildPackage } from '../src/services/ergon-package.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SKILL = `---
name: revisar-contratos
description: Confere cláusulas de contrato
---
# Revisar contratos

Leia o contrato inteiro e liste as cláusulas de multa, prazo e rescisão.
`;
const fxPkg = (id: string, cor = '#3a7bd5') => buildPackage({ package_id: id, version: '1.0.0', title: 'Aura do mar', summary: 'Uma aura azul em volta de todos', creator_id: 'x', license: 'CC-BY-4.0', ergon: { min: '1.0.0' }, kind: 'fx' },
  { effects: [{ target: { all: true }, effect: 'aura', color: cor, intensity: 0.5 }] });

describe('Loja do Ergon World: colaborativa, grátis, com revisão e selo Oficial ou Comunidade', () => {
  let world: FakeWorld; let pc1: Harness; let ana: Session; let pc2: Harness; let bia: Session;
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc1?.close(); await pc2?.close(); await world.stop(); });
  const conectar = async (h: Harness, s: Session, email: string) =>
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email, password: 'senha-do-world-123', displayName: email.split('@')[0] })).status, 200);
  const minhas = async () => (await req(pc1, 'GET', '/api/loja/minhas', ana)).json;

  test('a vitrine aparece sem conta do World; o item da equipe vem com o selo Oficial', async () => {
    pc1 = await harness(); ana = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
    world.publishOfficial(await fxPkg('ergon.oficial.aura-do-mar'));
    const r = await req(pc1, 'GET', '/api/loja/itens', ana);
    assert.equal(r.status, 200); assert.equal(r.json.disponivel, true);
    assert.deepEqual(r.json.itens.map((i: { title: string; official: boolean; kind: string }) => [i.title, i.official, i.kind]), [['Aura do mar', true, 'fx']]);
    assert.ok(!('priceCents' in r.json.itens[0]), 'nada de preço na tela');
    assert.equal((await req(pc1, 'GET', '/api/loja/minhas', ana)).status, 428, 'publicar pede a conta');
  });

  test('publicar: perfil de criador, prévia da equipe e da competência, envio grátis e revisão', async () => {
    await conectar(pc1, ana, 'ana@exemplo.test');
    const sem = await req(pc1, 'POST', '/api/loja/publicar/previa', ana, { fonte: 'equipe', titulo: 'Equipe da Ana', resumo: 'A equipe do escritório da Ana' });
    assert.deepEqual([sem.status, sem.json.error], [409, 'creator_required']);
    assert.equal((await req(pc1, 'POST', '/api/loja/criador', ana, { namespace: 'Oficial', nome: 'x' })).status, 400);
    assert.equal((await req(pc1, 'POST', '/api/loja/criador', ana, { namespace: 'ana', nome: 'Ana Souza' })).status, 200);
    const eu = await minhas();
    assert.deepEqual([eu.disponivel, eu.creator.namespace, eu.items.length], [true, 'ana', 0]);

    const eq = await req(pc1, 'POST', '/api/loja/publicar/previa', ana, { fonte: 'equipe', namespace: 'ana', titulo: 'Equipe da Ana', resumo: 'A equipe do escritório da Ana' });
    assert.equal(eq.status, 200, JSON.stringify(eq.json));
    assert.deepEqual([eq.json.kind, eq.json.packageId], ['team-blueprint', 'comunidade.ana.equipe-da-ana']);
    assert.ok(eq.json.preview.agents.length > 0, 'a prévia mostra quem vem na equipe');
    assert.equal(world.mkItems.size, 1, 'a prévia não envia nada');

    const curto = await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'competencia', namespace: 'ana', titulo: 'Revisar contratos', resumo: 'x', texto: SKILL });
    assert.equal(curto.status, 400, 'resumo de verdade');
    const pub = await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'competencia', namespace: 'ana', titulo: 'Revisar contratos', resumo: 'Confere multa, prazo e rescisão', texto: SKILL, priceCents: 900 });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.deepEqual([pub.json.kind, pub.json.status, pub.json.version], ['skill', 'in_review', '1.0.0']);
    const enviado = world.log.filter((l) => l.method === 'POST' && l.path === '/v1/marketplace/items');
    assert.deepEqual(enviado.map((l) => Object.keys(l.body)), [['artifactB64']], 'nenhum preço sai deste computador');

    const m = await minhas();
    assert.deepEqual(m.items.map((i: { title: string; status: string; versions: unknown[] }) => [i.title, i.status, i.versions.length]), [['Revisar contratos', 'in_review', 1]]);
    world.moderate(m.items[0].id, 'approve');
    const v2 = await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'competencia', namespace: 'ana', titulo: 'Revisar contratos', resumo: 'Confere multa, prazo e rescisão', texto: SKILL, versao: '1.0.1' });
    assert.equal(v2.status, 200);
    assert.equal((await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'competencia', namespace: 'ana', titulo: 'Revisar contratos', resumo: 'Confere multa, prazo e rescisão', texto: SKILL, versao: '1.0.1' })).json.error, 'version_exists');
    const vs = (await minhas()).items[0].versions.map((v: { version: string; status: string }) => [v.version, v.status]);
    assert.deepEqual(vs, [['1.0.0', 'approved'], ['1.0.1', 'pending']], 'as versões, cada uma com o estado dela');
  });

  test('publicar um visual: o arquivo .ergon ganha o id do criador; aprovado, outra pessoa vê com o selo Comunidade e instala', async () => {
    const arq = (await fxPkg('comunidade.qualquer.aura', '#8a3ad5')).toString('base64');
    const ruim = await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'arquivo', namespace: 'ana', titulo: 'Aura lilás', resumo: 'Aura lilás suave em todos', arquivo: Buffer.from('não é zip').toString('base64') });
    assert.equal(ruim.status, 422);
    const ok = await req(pc1, 'POST', '/api/loja/publicar', ana, { fonte: 'arquivo', namespace: 'ana', titulo: 'Aura lilás', resumo: 'Aura lilás suave em todos', arquivo: arq });
    assert.deepEqual([ok.status, ok.json.packageId, ok.json.kind], [200, 'comunidade.ana.aura-lilas', 'fx']);
    world.moderate(ok.json.itemId, 'approve');

    pc2 = await harness(); bia = await setupOwner(pc2, 'bia', 'senha-da-bia-123'); await conectar(pc2, bia, 'bia@exemplo.test');
    const vit = (await req(pc2, 'GET', '/api/loja/itens', bia)).json.itens as Array<{ id: string; title: string; official: boolean; creator: string; kind: string }>;
    const lilas = vit.find((i) => i.title === 'Aura lilás')!;
    assert.deepEqual([lilas.official, lilas.creator], [false, 'Ana Souza']);
    const pv = await req(pc2, 'POST', `/api/loja/itens/${lilas.id}/abrir`, bia);
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.deepEqual([pv.json.verified, pv.json.previa.installable, pv.json.preview.fx.color], [false, true, '#8a3ad5']);
    assert.equal((await req(pc2, 'POST', `/api/loja/itens/${lilas.id}/instalar`, bia)).status, 200);
    const inst = ((await req(pc2, 'GET', '/api/packages', bia)).json as Array<{ title: string; verified: boolean; active: boolean }>).filter((x) => x.active);
    assert.deepEqual(inst.map((x) => [x.title, x.verified]), [['Aura lilás', false]]);
  });

  test('competência de terceiros: chega com o texto inteiro para ler antes, e não instala pelo caminho dos visuais', async () => {
    // a versão nova esconde o item até a revisão (como no World): aprovada, volta à vitrine
    world.moderate([...world.mkItems.values()].find((i) => i.kind === 'skill')!.id, 'approve');
    const vit = (await req(pc2, 'GET', '/api/loja/itens?tipo=skill', bia)).json.itens as Array<{ id: string; title: string; kind: string }>;
    assert.deepEqual(vit.map((i) => [i.title, i.kind]), [['Revisar contratos', 'skill']]);
    const pv = await req(pc2, 'POST', `/api/loja/itens/${vit[0].id}/abrir`, bia);
    assert.equal(pv.status, 200);
    assert.equal(pv.json.verified, false);
    assert.match(pv.json.competencia.texto, /Leia o contrato inteiro e liste as cláusulas de multa, prazo e rescisão\./);
    assert.equal(pv.json.competencia.nome, 'revisar-contratos');
    const r = await req(pc2, 'POST', `/api/loja/itens/${vit[0].id}/instalar`, bia);
    assert.deepEqual([r.status, r.json.error], [409, 'package_kind']);
    assert.equal((await req(pc2, 'POST', '/api/loja/itens/x/abrir', bia)).status, 400);
  });

  test('sem rede: a vitrine diz que não está disponível agora, sem quebrar a tela', async () => {
    await world.stop();
    const r = await req(pc2, 'GET', '/api/loja/itens', bia);
    assert.deepEqual([r.status, r.json.disponivel, r.json.itens], [200, false, []]);
    await world.start(world.port);
  });
});
