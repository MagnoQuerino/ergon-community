/**
 * Canais externos com os papéis do Ergon World (services/canais/externo.ts), com o World de mentira (fake-world.ts): a
 * pessoa local ligada a uma conta do World fala pelo canal com o papel que tem no workspace do World (editor escreve,
 * leitura não); sem o World, vale o último papel conhecido por 24 h e depois leitura; tirada do workspace no World, os
 * canais dela caem na hora, com registro.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('canais externos: o papel do membro vem do World', () => {
  let world: FakeWorld; let h: Harness; let ana: Session; let bia: Session; let biaAcc = ''; let ws = ''; let canal: `whatsapp:${string}`;
  const TEL = '5511977770000';
  before(async () => {
    world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url;
    h = await harness();
    ana = await setupOwner(h, 'ana', 'senha-da-ana-123');
    ws = ana.workspaceId;
    assert.equal((await req(h, 'POST', '/api/world/connect', ana, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    const sws = (await req(h, 'POST', '/api/world/bind', ana, {})).json.syncWorkspaceId as string;
    world.activate(sws, 'world_team', 8);
    // a Bia é outra pessoa deste mesmo Ergon, com a conta dela no World, membro do workspace da Ana
    bia = await addPerson(h, 'bia', 'senha-da-bia-123', 'Bia Lima');
    assert.equal((await req(h, 'POST', '/api/world/connect', bia, { mode: 'signup', email: 'bia@exemplo.test', password: 'senha-do-world-456', displayName: 'Bia' })).status, 200);
    biaAcc = [...world.accounts.values()].find((a) => a.email === 'bia@exemplo.test')!.id;
    const inv = await req(h, 'POST', '/api/world/members/invites', ana, { role: 'editor' });
    assert.equal(inv.status, 200, JSON.stringify(inv.json));
    assert.equal((await req(h, 'POST', '/api/world/invites/accept', bia, { token: inv.json.token })).json.role, 'editor');
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", ws, bia.userId, new Date().toISOString());
    canal = `whatsapp:${ws}::${TEL}`;
    h.canais.ligarLocal(bia.userId, ws, canal, TEL, `${TEL}@s.whatsapp.net`, 'Bia Lima');
  });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await h?.close(); await world.stop(); });

  const conversaDaBia = () => h.canais.ligadoLocal(bia.userId, canal)?.conversationId ?? null;

  test('sem a lista do World ainda: leitura (o mais restrito); a lista que a tela busca traz o papel', async () => {
    h.canais.externos.buscarMembros = null; // sem a busca em segundo plano: só o que a tela traz
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'viewer');
    const m = await req(h, 'GET', '/api/world/members', ana);
    assert.equal(m.status, 200);
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'editor');
    assert.equal(h.canais.externos.papel(ws, ana.userId), 'owner', 'o dono local segue dono');
  });

  test('editor pelo World escreve: o pedido vai; escrita numa conta confirma; apagar espera o app (não é recusado)', async () => {
    const r = h.canais.receberLocal(bia.userId, canal, { message_id: 'm1', text: 'Crie um card para revisar o contrato' });
    assert.equal(r.ok, true); assert.equal(r.reply, undefined);
    assert.ok(conversaDaBia());
    assert.equal(h.conexoes.canalExterno!(conversaDaBia(), 'enviar'), 'confirmar');
    assert.equal(h.conexoes.canalExterno!(conversaDaBia(), 'organizar'), 'confirmar');
    const apagar = h.canais.receberLocal(bia.userId, canal, { message_id: 'm2', text: 'apague o card 3' });
    assert.match(apagar.reply ?? '', /precisa de aprovação no app/);
  });

  test('leitura pelo World não escreve', async () => {
    assert.equal((await req(h, 'PUT', `/api/world/members/${biaAcc}/role`, ana, { role: 'viewer' })).status, 200);
    await req(h, 'GET', '/api/world/members', ana);
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'viewer');
    assert.equal(h.conexoes.canalExterno!(conversaDaBia(), 'organizar'), 'recusar');
    assert.equal(h.conexoes.canalExterno!(conversaDaBia(), 'ler'), null);
    const r = h.canais.receberLocal(bia.userId, canal, { message_id: 'm3', text: 'apague o card 3' });
    assert.match(r.reply ?? '', /papel neste workspace é de leitura/);
  });

  test('a renovação e o papel vencido buscam de novo; sem o World, o último papel vale 24 h, depois leitura', async () => {
    assert.equal((await req(h, 'PUT', `/api/world/members/${biaAcc}/role`, ana, { role: 'editor' })).status, 200);
    // a busca em segundo plano (a que o World liga): papel guardado há mais de 5 min busca de novo
    let buscas = 0;
    const real = async (w: string) => { buscas++; const m = (await req(h, 'GET', '/api/world/members', ana)).json; return w === ws ? m.members : null; };
    h.canais.externos.buscarMembros = real;
    const agora = Date.now();
    h.canais.externos.agora = () => agora + 6 * 60_000;
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'viewer', 'o guardado ainda é o de antes');
    await h.canais.externos.atualizarPapeis(ws); // a mesma busca que o papel vencido disparou
    assert.ok(buscas >= 1);
    // o World fora do ar: a busca falha, e o último papel conhecido segue valendo
    h.canais.externos.agora = Date.now;
    await req(h, 'GET', '/api/world/members', ana);
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'editor');
    h.canais.externos.buscarMembros = async () => { throw new Error('World fora do ar'); };
    h.canais.externos.agora = () => Date.now() + 23 * 3_600_000;
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'editor', 'até 24 h: o último papel conhecido');
    await h.canais.externos.atualizarPapeis(ws);
    h.canais.externos.agora = () => Date.now() + 25 * 3_600_000;
    assert.equal(h.canais.externos.papel(ws, bia.userId), 'viewer', 'depois de 24 h sem o World: leitura');
    h.canais.externos.agora = Date.now;
    h.canais.externos.buscarMembros = null;
  });

  test('tirada do workspace no World: os canais dela caem na hora, com registro', async () => {
    assert.ok(h.canais.ligadoLocal(bia.userId, canal));
    const r = await req(h, 'DELETE', `/api/world/members/${biaAcc}`, ana);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(h.canais.ligadoLocal(bia.userId, canal), null, 'o vínculo caiu na hora, sem esperar a próxima mensagem');
    const reg = h.db.get<{ target_id: string; evidence: string }>("SELECT target_id, evidence FROM audit_events WHERE action = 'canal.externo.revogado' ORDER BY rowid DESC LIMIT 1");
    assert.equal(reg?.target_id, bia.userId); assert.match(reg!.evidence, /tirado do workspace no Ergon World/);
    assert.equal(h.canais.externos.papel(ws, bia.userId), null, 'não é mais membro para os canais');
  });

  test('a pessoa removida do Ergon: os canais dela caem, com registro', async () => {
    const carla = { userId: 'usr_carla00000000000000000000000000' };
    h.db.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'carla', 'Carla', 'x', ?)", carla.userId, new Date().toISOString());
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", ws, carla.userId, new Date().toISOString());
    const c: `whatsapp:${string}` = `whatsapp:${ws}::5511966660000`;
    h.canais.ligarLocal(carla.userId, ws, c, '5511966660000', '5511966660000@s.whatsapp.net', 'Carla');
    h.canais.pessoaRemovida(carla.userId);
    assert.equal(h.canais.ligadoLocal(carla.userId, c), null);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'canal.externo.revogado' AND target_id = ?", carla.userId));
  });
});
