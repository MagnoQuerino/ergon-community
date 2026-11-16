/**
 * Conversar com a equipe pelo bot do Ergon no Discord (o mesmo serviço do Teams), do lado do Ergon: o serviço diz que
 * oferece o Discord e a tela mostra o link de adicionar; a ligação pelo código é a mesma (a conta do Discord não tem
 * organização para conferir: pede a escolha consciente); cada plataforma tem a sua conversa com o coordenador, a sua nota
 * do canal, e a resposta volta só para a plataforma da conversa; cartão do Discord menor; desligar uma não mexe na outra.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { setLog } from '../src/lib/log.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { NOTA_DISCORD, NOTA_TEAMS, RELE_PADRAO } from '../src/services/teams-app/servico.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

const SENHA = 'senha-local-123';
const APP = '1562060832806936576';
let rele: ReleFalso; let h: Harness; let s: Session;

function rapido(x: Harness) { x.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } }; }
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (pred()) return;
    await h.executor.tick().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(msg);
}
async function ligar(canal: 'teams' | 'discord', nome: string): Promise<string> {
  const codigo = canal === 'discord' ? rele.codigoDiscord(nome) : rele.codigoPara(nome);
  const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: codigo, canal });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.canal, canal);
  const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return ok.json.binding.id as string;
}
const conversaDo = (canal: 'teams' | 'discord') => canal === 'teams'
  ? h.db.get<{ id: string; title: string }>('SELECT c.id, c.title FROM conversations c JOIN teams_people p ON p.conversation_id = c.id WHERE p.user_id = ?', s.userId)
  : h.db.get<{ id: string; title: string }>("SELECT c.id, c.title FROM conversations c JOIN teams_conversas p ON p.conversation_id = c.id WHERE p.user_id = ? AND p.canal = 'discord'", s.userId);
const respostasPara = (b: string) => rele.enviados.filter((e) => e.purpose === 'reply' && e.bindingId === b);
const cartoesPara = (b: string) => rele.enviados.filter((e) => e.card && e.bindingId === b);
const textoDo = (card: any) => card.body.filter((b: any) => b.type === 'TextBlock').map((b: any) => b.text).join('\n');

describe('Conversar pelo Discord (bot do Ergon, pelo mesmo serviço)', () => {
  beforeEach(async () => {
    rele = await ReleFalso.iniciar();
    rele.info = { protocol: [1], teams: true, teamsAppId: '11111111-2222-3333-4444-555555555555', discord: { applicationId: APP, installUrl: 'https://outro.exemplo/x', botName: 'Ergon' } };
    h = await harness({ teamsRelayUrl: rele.base });
    rapido(h);
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado(), 'o Ergon não conectou ao serviço');
    await ate(() => !!h.teamsApp.info, 'sem /v1/info');
  });
  afterEach(async () => { await h.close(); await rele.parar(); });
  after(() => setLog(null));

  test('a tela sabe o que o serviço oferece: Discord com o link de adicionar (montado aqui), Teams; guardado para a próxima vez', async () => {
    const g = (await req(h, 'GET', '/api/teams-app', s)).json;
    assert.equal(g.canais.discord.available, true);
    assert.equal(g.canais.discord.installUrl, `https://discord.com/oauth2/authorize?client_id=${APP}`, 'o link vem do id, não do endereço que o serviço mandou');
    assert.equal(g.canais.discord.botName, 'Ergon');
    assert.equal(g.canais.discord.enabled, true);
    assert.equal(g.canais.teams.available, true);
    const guardado = JSON.parse(h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'teams_relay_info'")!.value);
    assert.equal(guardado.base, rele.base);
    assert.equal(guardado.discord.applicationId, APP);
  });

  test('ligar uma conta do Discord: sem organização para conferir, pede a escolha consciente; vínculo com a plataforma', async () => {
    const codigo = rele.codigoDiscord('Ana Lima');
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: codigo, canal: 'discord' });
    assert.equal(c.status, 200);
    assert.equal(c.json.canal, 'discord'); assert.equal(c.json.conta, 'sem_conferir'); assert.equal(c.json.teamsName, 'Ana Lima');
    const sem = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, password: SENHA });
    assert.equal(sem.status, 400); assert.match(sem.json.message, /no seu próprio Discord/);
    const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.binding.canal, 'discord');
    assert.equal(h.db.get<{ canal: string }>('SELECT canal FROM teams_bindings WHERE binding_id = ?', ok.json.binding.id)!.canal, 'discord');
    // erro na voz do Discord
    const venc = await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ZZZZ-ZZZZ', canal: 'discord' });
    assert.equal(venc.json.error, 'code_invalid');
  });

  test('Teams e Discord: uma conversa com o coordenador por plataforma, cada uma com a sua nota; a resposta volta só para a plataforma dela', async () => {
    const bt = await ligar('teams', 'Maria Souza');
    const bd = await ligar('discord', 'Ana Lima');
    const dd = rele.diz(bd, 'Resuma a minha semana');
    await ate(() => rele.acks.some((a) => a.id === dd && a.status === 'accepted'), 'sem ack do Discord');
    const cd = conversaDo('discord')!;
    assert.equal(cd.title, 'Discord');
    await ate(() => respostasPara(bd).length === 1, 'a resposta não voltou ao Discord');
    assert.equal(respostasPara(bt).length, 0, 'nada vai ao Teams');
    const run = h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE conversation_id = ?', cd.id)!;
    assert.ok(run.instructions.includes(NOTA_DISCORD), 'o agente sabe que a conversa é pelo Discord');
    assert.ok(!run.instructions.includes(NOTA_TEAMS));
    assert.ok(rele.digitando.some((d) => d.bindingId === bd && d.on), '"digitando" no Discord');
    // a primeira mensagem pela conta do Discord fica à vista no Ergon
    assert.ok(h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'", cd.id).some((m) => /conta do Discord "Ana Lima".*Conexões › Discord/.test(m.content)));

    const dt = rele.diz(bt, 'E no Teams?');
    await ate(() => rele.acks.some((a) => a.id === dt && a.status === 'accepted'), 'sem ack do Teams');
    const ct = conversaDo('teams')!;
    assert.equal(ct.title, 'Teams');
    assert.notEqual(ct.id, cd.id);
    await ate(() => respostasPara(bt).length === 1, 'a resposta não voltou ao Teams');
    assert.equal(respostasPara(bd).length, 1, 'a do Teams não vai ao Discord');
    const runT = h.db.all<{ instructions: string }>('SELECT instructions FROM runs WHERE conversation_id = ?', ct.id)[0]!;
    assert.ok(runT.instructions.includes(NOTA_TEAMS));
  });

  test('confirmação na conversa do Discord vira cartão no Discord, menor (cabe no embed); desligar o Discord não mexe no Teams', async () => {
    const bt = await ligar('teams', 'Maria Souza');
    const bd = await ligar('discord', 'Ana Lima');
    rele.diz(bd, 'Oi');
    await ate(() => respostasPara(bd).length === 1);
    const conv = conversaDo('discord')!.id;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas e propostas. '.repeat(300) }]);
    await ate(() => cartoesPara(bd).length === 1, 'o cartão não foi ao Discord');
    assert.equal(cartoesPara(bt).length, 0, 'nem ao Teams');
    const card = cartoesPara(bd)[0].card;
    const total = card.body.filter((b: any) => b.type === 'TextBlock').reduce((n: number, b: any) => n + b.text.length + 2, 0);
    assert.ok(total <= 3800, `texto do cartão do Discord: ${total}`);
    assert.match(textoDo(card), /Comercial/);
    // desligar a conversa pelo Discord: o vínculo do Discord pausa, o do Teams segue
    const g = (await req(h, 'POST', '/api/teams-app/enabled', s, { enabled: false, canal: 'discord' })).json;
    assert.equal(g.canais.discord.enabled, false); assert.equal(g.canais.teams.enabled, true); assert.equal(g.enabled, true);
    const st = (id: string) => h.db.get<{ status: string }>('SELECT status FROM teams_bindings WHERE binding_id = ?', id)!.status;
    assert.equal(st(bd), 'paused'); assert.equal(st(bt), 'active');
    const dd = rele.diz(bd, 'ainda aí?');
    await ate(() => rele.acks.some((a) => a.id === dd), 'sem ack');
    assert.equal(rele.acks.find((a) => a.id === dd)!.error?.code, 'disabled');
  });

  test('o serviço sem Discord: a tela mostra "em breve" só para o Discord', async () => {
    rele.info = { protocol: [1], teams: true, teamsAppId: null, discord: null };
    await h.teamsApp.stop(); await h.teamsApp.start();
    await ate(() => h.teamsApp.info?.discord === null, 'não releu /v1/info');
    const g = (await req(h, 'GET', '/api/teams-app', s)).json;
    assert.equal(g.canais.discord.available, false);
    assert.equal(g.canais.teams.available, true);
  });
});

describe('Endereço do serviço', () => {
  afterEach(async () => { await h.close(); });
  test('sem nada no ambiente: o da nuvem do Ergon; "off" desliga; o ajuste da instalação troca', async () => {
    h = await harness({ teamsRelayUrl: null });
    assert.equal(h.teamsApp.base(), RELE_PADRAO);
    assert.equal(RELE_PADRAO, 'https://api.ergonworld.com/canais');
    h.teamsApp.definirEndereco('https://outro.exemplo/canais');
    assert.equal(h.teamsApp.base(), 'https://outro.exemplo/canais');
    h.teamsApp.definirEndereco('off');
    assert.equal(h.teamsApp.base(), null);
    h.teamsApp.definirEndereco(null);
    assert.equal(h.teamsApp.base(), RELE_PADRAO);
    await h.close();
    h = await harness();
    assert.equal(h.teamsApp.base(), null, 'os testes rodam com "off"');
  });
});
