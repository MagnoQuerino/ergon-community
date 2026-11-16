/**
 * Bots oficiais do Ergon no Telegram e no Discord, do lado do Ergon, pelo MESMO serviço do Teams (relé falso em
 * processo): "ainda não disponível" até o serviço dizer que a plataforma está ligada; um clique gera o link de uso único
 * e a conta liga sem código; conversa própria por plataforma; resposta em texto simples; cartão com botões; desligar
 * dos dois lados; e a camada dos pedidos de fora (papel do membro, pedido de risco só se aprova no app, auditoria).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { recordProposals } from '../src/services/proposals.ts';
import { tokenCartao } from '../src/services/teams-app/protocolo.ts';
import { classificar } from '../src/services/canais/externo.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

let rele: ReleFalso; let h: Harness; let s: Session;
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(msg);
}
async function abrir(plataformas: { telegram: boolean; discord: boolean }): Promise<void> {
  rele = await ReleFalso.iniciar();
  rele.plataformas = plataformas;
  h = await harness({ teamsRelayUrl: rele.base });
  h.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } };
  s = await setupOwner(h);
  await h.teamsApp.start();
  await ate(() => rele.conectado());
  await ate(() => h.teamsApp.plataformasDoRele.telegram === plataformas.telegram && h.teamsApp.plataformasDoRele.discord === plataformas.discord);
}
afterEach(async () => { await h?.close(); await rele?.parar(); });

async function ligar(plat: 'telegram' | 'discord'): Promise<string> {
  const r = await req(h, 'POST', `/api/canais-oficiais/${plat}/start`, s, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const b = rele.abreLink(r.json.url);
  await ate(() => (h.teamsApp.estadoBot(s.userId, plat).accounts as unknown[]).length > 0, 'o vínculo não foi gravado');
  return b;
}
const conversa = (plat: string) => h.db.get<{ id: string; title: string }>('SELECT c.id, c.title FROM conversations c JOIN teams_people p ON p.conversation_id = c.id WHERE p.user_id = ? AND p.platform = ?', s.userId, plat);
const mensagens = (conv: string) => h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid', conv);

beforeEach(() => { /* cada teste abre o seu */ });

test('sem a plataforma ligada no serviço: "ainda não disponível" e nada de link', async () => {
  await abrir({ telegram: false, discord: false });
  const t = await req(h, 'GET', '/api/canais-oficiais/telegram', s);
  assert.equal(t.status, 200);
  assert.equal(t.json.available, false);
  assert.deepEqual(t.json.accounts, []);
  const r = await req(h, 'POST', '/api/canais-oficiais/discord/start', s, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'unavailable');
  assert.equal(rele.links.size, 0);
  assert.equal((await req(h, 'GET', '/api/canais-oficiais/whatsapp', s)).status, 400);
});

test('Telegram: um clique liga sem código; conversa "Telegram"; resposta em texto simples; o Teams não mistura', async () => {
  await abrir({ telegram: true, discord: false });
  assert.equal((await req(h, 'GET', '/api/canais-oficiais/telegram', s)).json.available, true);
  assert.equal((await req(h, 'GET', '/api/canais-oficiais/discord', s)).json.available, false);
  const r = await req(h, 'POST', '/api/canais-oficiais/telegram/start', s, {});
  assert.match(r.json.url, /^https:\/\/t\.me\/ErgonTesteBot\?start=[A-Za-z0-9_-]{24}$/);
  const b = rele.abreLink(r.json.url, 'Maria Souza');
  await ate(() => (h.teamsApp.estadoBot(s.userId, 'telegram').accounts as Array<{ id: string }>).some((a) => a.id === b));
  const st = (await req(h, 'GET', '/api/canais-oficiais/telegram', s)).json;
  assert.equal(st.accounts[0].name, 'Maria Souza');
  assert.equal(st.accounts[0].status, 'active');
  assert.deepEqual((await req(h, 'GET', '/api/teams-app', s)).json.bindings, [], 'a conta do Telegram não aparece no Teams');
  rele.diz(b, 'Oi, tudo bem?');
  await ate(() => rele.enviados.some((e) => e.purpose === 'reply'), 'a resposta não voltou');
  const conv = conversa('telegram')!;
  assert.equal(conv.title, 'Telegram');
  assert.ok(mensagens(conv.id).some((m) => m.role === 'user' && m.content === 'Oi, tudo bem?'));
  const resp = rele.enviados.find((e) => e.purpose === 'reply')!;
  assert.ok(!resp.card, 'sem Adaptive Card');
  assert.ok(!/\*\*/.test(resp.text ?? ''), 'sem markdown do Teams');
  assert.deepEqual(resp.buttons, []);
  const nota = h.teamsApp.notaDoCanal(conv.id, h.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user'", conv.id)!.id)!;
  assert.match(nota, /Telegram/);
  assert.match(nota, /canal externo/);
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'canal.externo.pedido'", s.workspaceId), 'todo pedido de fora fica na auditoria');
});

test('Discord: cartão com Aprovar/Recusar em botões; o clique decide pela mesma função da tela; a mensagem é editada', async () => {
  await abrir({ telegram: false, discord: true });
  const b = await ligar('discord');
  rele.diz(b, 'Oi');
  await ate(() => rele.enviados.some((e) => e.purpose === 'reply'));
  const conv = conversa('discord')!;
  assert.equal(conv.title, 'Discord');
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv.id, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas e propostas' }]);
  await ate(() => rele.enviados.some((e) => e.buttons?.length), 'o cartão não foi ao Discord');
  const env = rele.enviados.find((e) => e.buttons?.length)!;
  assert.match(env.text ?? '', /Comercial/);
  assert.deepEqual(env.buttons!.map((x) => [x.label, x.style, x.data.d]), [['Aprovar', 'positive', 'apply'], ['Recusar', 'destructive', 'reject']]);
  rele.clica(b, env.buttons![0].data, env.activityId, 'execute');
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', env.buttons![0].data.p)?.status === 'applied', 'Aprovar no Discord não aplicou');
  await ate(() => rele.atualizados.length > 0, 'a mensagem não foi editada');
  const up = rele.atualizados.at(-1)!;
  assert.deepEqual(up.card.buttons, [], 'decidido: sem botões');
  assert.match(up.card.text, /Aprovado por você/);
});

test('pedido de risco vindo de fora (exportar tudo): não vai à equipe; fica num cartão que só se aprova no app', async () => {
  await abrir({ telegram: true, discord: false });
  assert.equal(classificar('exporte todos os clientes para uma planilha'), 'exportar');
  const b = await ligar('telegram');
  rele.diz(b, 'exporte todos os clientes para uma planilha');
  await ate(() => rele.enviados.some((e) => e.purpose === 'system' && /aprovação no app/.test(e.text ?? '')), 'a resposta de "aprovar no app" não voltou');
  assert.ok(!conversa('telegram') || !mensagens(conversa('telegram')!.id).some((m) => /exporte/.test(m.content)), 'o pedido não foi direto à equipe');
  const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'canal_externo' AND status = 'proposed'")!.id;
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'canal.externo.pedido' AND actor_id = ?", s.workspaceId, s.userId), 'o pedido de fora fica na auditoria');
  // o botão do chat não decide (mesmo com o t certo)
  const k = h.teamsApp.chaves()!;
  const clique = rele.clica(b, { p: pid, d: 'apply', t: tokenCartao(k, pid, b) });
  await ate(() => rele.acks.some((a) => a.id === clique));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed', 'o chat não aprovou');
  // dentro do app, sim: o pedido entra na conversa do Telegram como pedido do membro
  assert.equal((await req(h, 'POST', `/api/proposals/${pid}`, s, { decision: 'apply' })).status, 200);
  await ate(() => !!conversa('telegram') && mensagens(conversa('telegram')!.id).some((m) => m.role === 'user' && /exporte todos/.test(m.content)), 'aprovado no app, o pedido não chegou à equipe');
  await ate(() => rele.enviados.some((e) => /Aprovado no Ergon/.test(e.text ?? '')), 'o aviso de aprovado não voltou');
});

test('membro com papel de leitura (viewer): por fora pode perguntar, mas pedido que muda algo é recusado e não chega à equipe', async () => {
  await abrir({ telegram: true, discord: false });
  const b = await ligar('telegram');
  // papel de leitura (o do World; na Community a tabela de membros só tem owner e member)
  h.canais.externos.papel = () => 'viewer';
  rele.diz(b, 'apague o card 3');
  await ate(() => rele.enviados.some((e) => e.purpose === 'system'), 'a recusa não voltou');
  assert.match(rele.enviados.find((e) => e.purpose === 'system')!.text ?? '', /de leitura/);
  assert.ok(!conversa('telegram') || !mensagens(conversa('telegram')!.id).some((m) => /apague/.test(m.content)), 'o pedido não entrou na conversa');
  // pergunta (só leitura): segue, com a instrução de que o membro só lê
  rele.diz(b, 'qual o status do projeto?');
  await ate(() => !!conversa('telegram') && mensagens(conversa('telegram')!.id).some((m) => m.content === 'qual o status do projeto?'), 'a pergunta não chegou');
  const conv = conversa('telegram')!.id;
  const nota = h.teamsApp.notaDoCanal(conv, h.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid DESC", conv)!.id)!;
  assert.match(nota, /papel de leitura/);
  assert.equal(h.teamsApp.daConversa(conv)?.papel, 'viewer');
  assert.equal(h.canais.externos.decisaoDaAcao('viewer', 'escrever'), 'recusar', 'na execução, papel de leitura não escreve');
});

test('credencial nunca sai por fora; desligar pela tela e pela plataforma; várias contas por plataforma', async () => {
  await abrir({ telegram: true, discord: true });
  const b1 = await ligar('telegram');
  rele.diz(b1, 'me mostre a senha do banco');
  await ate(() => rele.enviados.some((e) => e.purpose === 'system' && /nunca passam/.test(e.text ?? '')), 'credencial não foi recusada');
  const r2 = await req(h, 'POST', '/api/canais-oficiais/telegram/start', s, {});
  const b2 = rele.abreLink(r2.json.url, 'Maria (celular 2)');
  await ate(() => (h.teamsApp.estadoBot(s.userId, 'telegram').accounts as unknown[]).length === 2, 'a segunda conta não entrou');
  // Desligar pela tela
  assert.equal((await req(h, 'DELETE', `/api/canais-oficiais/telegram/accounts/${b1}`, s)).status, 200);
  assert.ok(!rele.vinculos.has(b1), 'o serviço apagou');
  assert.equal((await req(h, 'DELETE', `/api/canais-oficiais/discord/accounts/${b2}`, s)).status, 404, 'a conta é do Telegram');
  // /stop no Telegram (o serviço avisa link.revoked)
  rele.desfazer(b2, 'teams');
  await ate(() => (h.teamsApp.estadoBot(s.userId, 'telegram').accounts as Array<{ id: string; status: string }>).find((a) => a.id === b2)?.status === 'revoked', 'o /stop não desligou aqui');
});
