/**
 * E-mail confirmado no Ergon World (docs/CONTRATO_PUBLICO.md): sem ele, o World recusa criar ou comprar com
 * 403 email_unverified. O aplicativo passa adiante a mesma frase curta em toda rota (workspace World, carrinho,
 * convites, Ergon AI, perfil de criador da Loja), volta a mostrar a caixa do código e segue o World no authorize:
 * quem confirma pelo link do e-mail deixa de ver o pedido do código sem entrar de novo. O cadastro leva o idioma
 * da tela (locale), para os e-mails saírem no idioma da pessoa.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('E-mail confirmado e idioma da conta no Ergon World', () => {
  let world: FakeWorld; const abertos: Harness[] = [];
  before(async () => { world = await new FakeWorld().start(); world.requireVerifiedEmail = true; process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; for (const h of abertos) await h.close(); await world.stop(); });
  const conta = (email: string) => [...world.accounts.values()].find((a) => a.email === email)!;
  const control = { ergonAi: async () => undefined, removeErgonAi: async () => undefined } as unknown as HermesControlClient;
  const pc = async (user: string) => { const h = await harness({}, { control }); abertos.push(h); return { h, s: await setupOwner(h, user, `senha-de-${user}-123`) }; };
  const negado = (r: { status: number; json: { error?: string; message?: string } }, onde: string) => {
    assert.deepEqual([r.status, r.json.error, r.json.message], [403, 'email_unverified', 'Confirme o seu e-mail para continuar.'], onde);
  };

  test('o cadastro leva o idioma da tela (ou do navegador) no formato do World', async () => {
    const a = await pc('lia');
    assert.equal((await req(a.h, 'POST', '/api/world/connect', a.s, { mode: 'signup', email: 'lia@exemplo.test', password: 'senha-do-world-123', displayName: 'Lia', locale: 'en-US' })).status, 200);
    assert.equal(conta('lia@exemplo.test').locale, 'en');
    const b = await pc('remi');
    assert.equal((await req(b.h, 'POST', '/api/world/connect', b.s, { mode: 'signup', email: 'remi@exemplo.test', password: 'senha-do-world-123', displayName: 'Rémi' }, { 'accept-language': 'ja-JP, fr-CA;q=0.9, en;q=0.5' })).status, 200);
    assert.equal(conta('remi@exemplo.test').locale, 'fr', 'o primeiro idioma que o World conhece');
    const c = await pc('kenji');
    assert.equal((await req(c.h, 'POST', '/api/world/connect', c.s, { mode: 'signup', email: 'kenji@exemplo.test', password: 'senha-do-world-123', displayName: 'Kenji', locale: 'ja' }, { 'accept-language': 'ja' })).status, 200);
    assert.equal(conta('kenji@exemplo.test').locale, undefined, 'sem idioma conhecido: o World usa o padrão');
    const login = world.log.filter((l) => l.path === '/v1/accounts/login');
    assert.ok(login.every((l) => l.body.locale === undefined), 'só o cadastro leva o idioma');
  });

  let h: Harness; let ana: Session;
  test('sem o e-mail confirmado: criar o workspace World, comprar, convidar, aceitar, Ergon AI e perfil da Loja recusam com a frase curta', async () => {
    ({ h, s: ana } = await pc('ana'));
    assert.equal((await req(h, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana', locale: 'pt-BR' })).status, 200);
    assert.equal(conta('ana@exemplo.test').locale, 'pt');
    negado(await req(h, 'POST', '/api/world/bind', ana, {}), 'criar o workspace World');
    assert.equal([...world.workspaces.values()].filter((w) => w.owner === conta('ana@exemplo.test').id).length, 0, 'nada foi criado');

    // um workspace World que já existe (criado no site), sem plano: ligar não cria nada, então passa
    const sws = world.serverWorkspace(conta('ana@exemplo.test').id);
    assert.equal((await req(h, 'POST', '/api/world/bind', ana, { syncWorkspaceId: sws })).status, 200);
    negado(await req(h, 'POST', '/api/world/billing/checkout', ana, { sku: 'world_pro', idempotencyKey: 'email-1' }), 'carrinho');
    assert.equal(world.checkouts.length, 0);
    negado(await req(h, 'POST', '/api/world/members/invites', ana, { role: 'editor' }), 'convidar');
    negado(await req(h, 'POST', '/api/world/invites/accept', ana, { token: 'A'.repeat(32) }), 'aceitar convite');
    negado(await req(h, 'POST', '/api/world/ai/connect', ana, {}), 'Ergon AI sem plano vigente');
    negado(await req(h, 'POST', '/api/loja/criador', ana, { namespace: 'ana', nome: 'Ana Souza' }), 'perfil de criador da Loja');
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, false, 'a caixa do código fica à vista');
  });

  test('o World diz que falta confirmar: o aviso com o código volta mesmo se aqui achávamos que sim', async () => {
    h.db.run('UPDATE world_links SET email_verified = 1 WHERE user_id = ?', ana.userId);
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, true);
    negado(await req(h, 'POST', '/api/world/billing/checkout', ana, { sku: 'world_pro', idempotencyKey: 'email-2' }), 'carrinho');
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, false);
  });

  test('confirmou pelo link do e-mail: o authorize atualiza o aviso, sem novo login, e o que estava recusado passa', async () => {
    world.confirmEmail('ana@exemplo.test');
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, false, 'até o próximo authorize');
    assert.equal((await req(h, 'POST', '/api/world/refresh', ana)).status, 200);
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, true, 'sem pedir o código');
    const co = await req(h, 'POST', '/api/world/billing/checkout', ana, { sku: 'world_pro', idempotencyKey: 'email-3' });
    assert.equal(co.status, 200, JSON.stringify(co.json));
    world.activate([...world.workspaces.values()].find((w) => w.owner === conta('ana@exemplo.test').id)!.id, 'world_team', 3); // o pagamento confirmado

    assert.equal((await req(h, 'POST', '/api/world/members/invites', ana, { role: 'editor' })).status, 200);
    assert.equal((await req(h, 'POST', '/api/loja/criador', ana, { namespace: 'ana', nome: 'Ana Souza' })).status, 200);
    assert.equal((await req(h, 'POST', '/api/world/ai/connect', ana, {})).status, 200);
    // e o contrário: o World volta a pedir (e-mail trocado): o authorize desliga o aviso de confirmado
    conta('ana@exemplo.test').emailVerified = false;
    await req(h, 'POST', '/api/world/refresh', ana);
    assert.equal((await req(h, 'GET', '/api/world/status', ana)).json.link.emailVerified, false);
  });

  test('membro de um workspace com plano vigente usa o Ergon AI mesmo sem confirmar (só criar e comprar exigem)', async () => {
    const b = await pc('bia');
    assert.equal((await req(b.h, 'POST', '/api/world/connect', b.s, { mode: 'signup', email: 'bia@exemplo.test', password: 'senha-do-world-123', displayName: 'Bia' })).status, 200);
    const sws = world.serverWorkspace(conta('bia@exemplo.test').id, { source: 'cortesia' });
    assert.equal((await req(b.h, 'POST', '/api/world/bind', b.s, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(b.h, 'POST', '/api/world/ai/connect', b.s, {})).status, 200);
    negado(await req(b.h, 'POST', '/api/world/billing/checkout', b.s, { sku: 'world_team', idempotencyKey: 'email-4' }), 'comprar continua exigindo');
  });
});
