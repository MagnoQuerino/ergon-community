/**
 * Canais (Telegram, Discord, Teams) com a nuvem do Ergon World, do lado do Ergon, com o relé falso em processo:
 * - no computador: a nuvem é declarada ao serviço como reserva das contas ligadas pela pessoa dona do workspace; o que
 *   chega pela sincronia (a nuvem já respondeu no canal) não é mandado de novo;
 * - na nuvem: só liga depois de o workspace chegar; atende as contas ligadas no computador pela conta local do contêiner,
 *   na MESMA conversa do canal (a que veio pela sincronia), sem reenviar o que já estava nela e sem desfazer vínculos.
 * O caminho inteiro, com o relé de verdade e dois Ergons, é exercitado no laboratório do ergon-world.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createConversation } from '../src/services/chat.ts';
import { coordinatorFor } from '../src/services/team-query.ts';
import { id as novoId, now } from '../src/lib/util.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

let rele: ReleFalso; let h: Harness; let s: Session;
const SWS = `sws_${'a'.repeat(32)}`; const NUVEM = `ins_${'b'.repeat(26)}`; const PC = `ins_${'c'.repeat(26)}`;
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(msg);
}
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function abrir(over: Record<string, unknown> = {}): Promise<void> {
  rele = await ReleFalso.iniciar();
  rele.plataformas = { telegram: true, discord: true };
  h = await harness({ teamsRelayUrl: rele.base, ...over });
  h.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, pedidoMs: 2000, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } };
  s = await setupOwner(h);
}
afterEach(async () => { await h?.close(); await rele?.parar(); });
const ws = () => h.db.get<{ workspace_id: string }>("SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner'", s.userId)!.workspace_id;
const mensagens = (conv: string) => h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid', conv);
/** uma mensagem como a sincronia grava (vinda de outro aparelho): sem execução */
function sincronizada(conv: string, role: 'user' | 'agent', texto: string): string {
  const id = novoId('msg');
  h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, 'real', ?)", id, ws(), conv, role, role === 'user' ? s.userId : null, h.db.seal(ws(), texto), now());
  return id;
}

test('computador: declara a nuvem como reserva das contas do dono; repete só quando muda; tira quando a nuvem acaba', async () => {
  await abrir();
  await h.teamsApp.start();
  await ate(() => rele.conectado());
  // sem conta ligada ainda: a reserva vale, com a lista vazia
  h.teamsApp.reserva(ws(), { installationId: NUVEM, syncWorkspaceId: SWS });
  await ate(() => rele.reservas.length === 1);
  assert.deepEqual(rele.reservas[0].personRefs, []);
  // liga o Telegram: a pessoa entra na lista (na próxima conferência de cada minuto)
  const r = await req(h, 'POST', '/api/canais-oficiais/telegram/start', s, {});
  const b = rele.abreLink(r.json.url);
  await ate(() => (h.teamsApp.estadoBot(s.userId, 'telegram').accounts as unknown[]).length > 0);
  h.teamsApp.reserva(ws(), { installationId: NUVEM, syncWorkspaceId: SWS });
  await ate(() => rele.reservas.length === 2);
  assert.equal(rele.reservas[1].installationId, NUVEM); assert.equal(rele.reservas[1].workspaceId, SWS);
  assert.deepEqual(rele.reservas[1].personRefs, [rele.vinculos.get(b)!.personRef]);
  // nada mudou: não pede de novo (nem depois de reconectar, porque o serviço já tem a mesma)
  h.teamsApp.reserva(ws(), { installationId: NUVEM, syncWorkspaceId: SWS });
  rele.derrubar(); await ate(() => rele.conexoes >= 2 && rele.conectado());
  h.teamsApp.reserva(ws(), { installationId: NUVEM, syncWorkspaceId: SWS });
  await pausa(150);
  assert.equal(rele.reservas.length, 2);
  // outro workspace não toma o lugar; a nuvem deste acabou: tira
  h.teamsApp.reserva('ws_outro', { installationId: `ins_${'d'.repeat(26)}`, syncWorkspaceId: SWS });
  h.teamsApp.reserva('ws_outro', null);
  await pausa(100);
  assert.equal(rele.reservas.length, 2);
  h.teamsApp.reserva(ws(), null);
  await ate(() => rele.reservas.length === 3);
  assert.equal(rele.reservas[2].installationId, null);
});

test('computador: o que a nuvem respondeu chega pela sincronia e NÃO vai de novo ao canal; o que nasce aqui continua indo', async () => {
  await abrir();
  await h.teamsApp.start();
  await ate(() => rele.conectado());
  const r = await req(h, 'POST', '/api/canais-oficiais/telegram/start', s, {});
  const b = rele.abreLink(r.json.url);
  await ate(() => (h.teamsApp.estadoBot(s.userId, 'telegram').accounts as unknown[]).length > 0);
  rele.diz(b, 'Oi!');
  await ate(() => rele.enviados.filter((e) => e.purpose === 'reply').length === 1, 'a resposta daqui não saiu');
  const conv = h.db.get<{ c: string }>("SELECT conversation_id AS c FROM teams_people WHERE user_id = ? AND platform = 'telegram'", s.userId)!.c;
  // a nuvem atendeu com o computador fechado: pergunta e resposta chegam pela sincronia
  const ids = [sincronizada(conv, 'user', 'e o relatório?'), sincronizada(conv, 'agent', 'O relatório saiu às 9h.')];
  h.teamsApp.sincronizadas(ws(), ids);
  h.bus.publish(ws(), 'messages.changed', {});
  await pausa(300);
  assert.equal(rele.enviados.filter((e) => e.purpose === 'reply').length, 1, 'a resposta da nuvem não é repetida no Telegram');
  assert.ok(mensagens(conv).some((m) => m.content === 'O relatório saiu às 9h.'), 'mas aparece na conversa do computador');
  // a conversa segue daqui normalmente
  rele.diz(b, 'Obrigada!');
  await ate(() => rele.enviados.filter((e) => e.purpose === 'reply').length === 2, 'a resposta seguinte não saiu');
});

test('nuvem: só liga com o workspace pronto; atende a conta do computador na mesma conversa, sem reenviar o que já estava nela', async () => {
  await abrir({ mode: 'cloud' });
  await h.teamsApp.start();
  await pausa(150);
  assert.equal(rele.conexoes, 0, 'antes de o workspace chegar, não conecta');
  assert.equal(h.teamsApp.instalacaoNoRele(), null);
  // o workspace chegou pela sincronia, com a conversa "Telegram" do computador
  const conv = createConversation(h.db, ws(), s.userId, coordinatorFor(h.db, ws())!, 'Telegram').id;
  sincronizada(conv, 'user', 'pergunta antiga'); sincronizada(conv, 'agent', 'resposta antiga (o computador já mandou)');
  const b = rele.contaDoComputador(PC, SWS, 'telegram');
  h.teamsApp.atender({ userId: s.userId, workspaceId: ws(), syncWorkspaceId: SWS });
  await ate(() => rele.conectado());
  assert.match(h.teamsApp.instalacaoNoRele() ?? '', /^ins_/);
  await ate(() => !!h.db.get('SELECT 1 AS x FROM teams_bindings WHERE binding_id = ? AND standby_of = ?', b, PC), 'a conta do computador não entrou');
  assert.equal(h.db.get<{ c: string }>("SELECT conversation_id AS c FROM teams_people WHERE user_id = ? AND platform = 'telegram'", s.userId)!.c, conv, 'continua na conversa do computador');
  await pausa(200);
  assert.equal(rele.enviados.length, 0, 'o que já estava na conversa não vai ao canal de novo');
  assert.ok(!rele.quadros.some((q) => q.type === 'link.revoke' || q.type === 'link.update'), 'a reserva não mexe no vínculo');
  // a pessoa escreve com o computador fechado
  rele.dizNaReserva(b, 'qual o status do projeto?');
  await ate(() => rele.enviados.some((e) => e.purpose === 'reply' && e.bindingId === b), 'a nuvem não respondeu');
  assert.equal(rele.acks.at(-1)!.status, 'accepted');
  assert.ok(mensagens(conv).some((m) => m.role === 'user' && m.content === 'qual o status do projeto?'), 'entrou na conversa que o computador vê');
  assert.equal(h.teamsApp.ocupado(), true, 'acabou de atender: a nuvem não dorme no meio');
  // mensagens do computador que chegam depois pela sincronia também não são reenviadas daqui
  const antes = rele.enviados.length;
  h.teamsApp.sincronizadas(ws(), [sincronizada(conv, 'agent', 'resposta que o computador deu')]);
  h.bus.publish(ws(), 'messages.changed', {});
  await pausa(250);
  assert.equal(rele.enviados.length, antes);
  // reconectar não desfaz nada; o computador tirou a reserva: a conta sai daqui
  rele.derrubar(); await ate(() => rele.conexoes >= 2 && rele.conectado());
  await pausa(100);
  assert.ok(h.db.get('SELECT 1 AS x FROM teams_bindings WHERE binding_id = ?', b));
  assert.ok(!rele.quadros.some((q) => q.type === 'link.revoke'));
  rele.daReserva = []; rele.derrubar(); await ate(() => rele.conexoes >= 3 && rele.conectado());
  await ate(() => !h.db.get('SELECT 1 AS x FROM teams_bindings WHERE binding_id = ?', b), 'a conta devia ter saído');
});

test('nuvem: pedido de risco pelo canal não fica preso num cartão que ninguém vê: pede para abrir o Ergon', async () => {
  await abrir({ mode: 'cloud' });
  const b = rele.contaDoComputador(PC, SWS, 'telegram');
  await h.teamsApp.start();
  h.teamsApp.atender({ userId: s.userId, workspaceId: ws(), syncWorkspaceId: SWS });
  await ate(() => !!h.db.get('SELECT 1 AS x FROM teams_bindings WHERE binding_id = ?', b));
  rele.dizNaReserva(b, 'apague todos os clientes da planilha');
  await ate(() => rele.enviados.some((e) => /abra o Ergon no computador/.test(e.text ?? '')), 'não avisou');
});
