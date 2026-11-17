/**
 * O bot do Ergon no Discord pelo relé dos canais unificado, do lado do Ergon: o serviço diz o que oferece em /v1/info
 * (guardado na instalação); a conta do Discord liga pelo CÓDIGO (o caminho do bot no ar: a pessoa manda "oi" ao bot e
 * digita o código aqui; sem organização para conferir, pede a escolha consciente) ou pelo "Adicionar ao Discord" (link
 * de uso único) quando o serviço oferece; cada plataforma tem a sua conversa com o coordenador e a sua nota do canal; a
 * resposta volta só para a plataforma dela; desligar uma não mexe na outra. O endereço padrão é o do relé no ar.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { setLog } from '../src/lib/log.ts';
import { NOTA_DISCORD, NOTA_TEAMS, RELE_PADRAO } from '../src/services/teams-app/servico.ts';
import { DEFAULT_TEAMS_RELAY_URL } from '../src/world/config.ts';
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
const conversaDo = (plat: 'teams' | 'discord') => h.db.get<{ id: string; title: string }>('SELECT c.id, c.title FROM conversations c JOIN teams_people p ON p.conversation_id = c.id WHERE p.user_id = ? AND p.platform = ?', s.userId, plat);
const respostasPara = (b: string) => rele.enviados.filter((e) => e.purpose === 'reply' && e.bindingId === b);

describe('Conversar pelo Discord (bot do Ergon no ar, pelo mesmo serviço)', () => {
  beforeEach(async () => {
    rele = await ReleFalso.iniciar();
    rele.plataformas = { telegram: false, discord: true };
    // o relé no ar hoje: o bot pelo Gateway e a ligação pelo código, sem o "Adicionar ao Discord" com state
    rele.discordLinkStart = false;
    h = await harness({ teamsRelayUrl: rele.base });
    rapido(h);
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado(), 'o Ergon não conectou ao serviço');
    await ate(() => !!h.teamsApp.info?.discord, 'sem /v1/info');
  });
  afterEach(async () => { await h.close(); await rele.parar(); });
  after(() => setLog(null));

  test('a tela sabe o que o serviço oferece: o link de adicionar o bot (montado pelo id), só pelo código; guardado para a próxima vez', async () => {
    const g = (await req(h, 'GET', '/api/canais-oficiais/discord', s)).json;
    assert.equal(g.available, true);
    assert.equal(g.linkStart, false);
    assert.equal(g.installUrl, `https://discord.com/oauth2/authorize?client_id=${APP}`);
    assert.equal(g.botName, 'Ergon');
    assert.equal(g.enabled, true);
    const guardado = JSON.parse(h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'teams_relay_info'")!.value);
    assert.equal(guardado.base, rele.base);
    assert.equal(guardado.discord.applicationId, APP);
    // sem o "Adicionar ao Discord" com state, o botão diz o caminho do código
    const st = await req(h, 'POST', '/api/canais-oficiais/discord/start', s, {});
    assert.equal(st.status, 409);
    assert.equal(st.json.error, 'code_only');
    // com ele, o link de uso único
    rele.discordLinkStart = true;
    rele.info = null;
    await h.teamsApp.stop(); await h.teamsApp.start();
    await ate(() => h.teamsApp.info?.discord?.linkStart === true, 'não releu /v1/info');
    const ok = await req(h, 'POST', '/api/canais-oficiais/discord/start', s, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.match(ok.json.url, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  });

  test('ligar uma conta do Discord pelo código: sem organização para conferir, pede a escolha consciente; vínculo com a plataforma', async () => {
    const codigo = rele.codigoDiscord('Ana Lima');
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: codigo, canal: 'discord' });
    assert.equal(c.status, 200);
    assert.equal(c.json.canal, 'discord'); assert.equal(c.json.conta, 'sem_conferir'); assert.equal(c.json.teamsName, 'Ana Lima');
    const sem = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, password: SENHA });
    assert.equal(sem.status, 400); assert.match(sem.json.message, /no seu próprio Discord/);
    const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.binding.canal, 'discord');
    assert.equal(h.db.get<{ platform: string }>('SELECT platform FROM teams_bindings WHERE binding_id = ?', ok.json.binding.id)!.platform, 'discord');
    // a conta aparece no cartão do Discord, não no do Teams
    assert.equal(((await req(h, 'GET', '/api/canais-oficiais/discord', s)).json.accounts as Array<{ id: string }>)[0]!.id, ok.json.binding.id);
    assert.deepEqual((await req(h, 'GET', '/api/teams-app', s)).json.bindings, []);
    // erro na voz do Discord
    const venc = await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ZZZZ-ZZZZ', canal: 'discord' });
    assert.equal(venc.json.error, 'code_invalid');
    // reconexão: o vínculo continua do Discord (o serviço diz `canal`)
    await h.teamsApp.stop(); await h.teamsApp.start();
    await ate(() => rele.conectado());
    assert.equal(h.db.get<{ platform: string }>('SELECT platform FROM teams_bindings WHERE binding_id = ?', ok.json.binding.id)!.platform, 'discord');
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

    const dt = rele.diz(bt, 'E no Teams?');
    await ate(() => rele.acks.some((a) => a.id === dt && a.status === 'accepted'), 'sem ack do Teams');
    const ct = conversaDo('teams')!;
    assert.equal(ct.title, 'Teams');
    assert.notEqual(ct.id, cd.id);
    await ate(() => respostasPara(bt).length === 1, 'a resposta não voltou ao Teams');
    assert.equal(respostasPara(bd).length, 1, 'a do Teams não vai ao Discord');
  });

  test('desligar a conversa pelo Discord: o vínculo do Discord pausa, o do Teams segue', async () => {
    const bt = await ligar('teams', 'Maria Souza');
    const bd = await ligar('discord', 'Ana Lima');
    const r = await req(h, 'POST', '/api/teams-app/enabled', s, { enabled: false, canal: 'discord' });
    assert.equal(r.status, 200);
    assert.equal((await req(h, 'GET', '/api/canais-oficiais/discord', s)).json.enabled, false);
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.enabled, true);
    const st = (id: string) => h.db.get<{ status: string }>('SELECT status FROM teams_bindings WHERE binding_id = ?', id)!.status;
    assert.equal(st(bd), 'paused'); assert.equal(st(bt), 'active');
    const dd = rele.diz(bd, 'ainda aí?');
    await ate(() => rele.acks.some((a) => a.id === dd), 'sem ack');
    assert.equal(rele.acks.find((a) => a.id === dd)!.error?.code, 'disabled');
  });

  test('o serviço sem Discord: o cartão do Discord fica "ainda não disponível"', async () => {
    rele.plataformas = { telegram: false, discord: false };
    await h.teamsApp.stop(); await h.teamsApp.start();
    await ate(() => h.teamsApp.info?.discord === null, 'não releu /v1/info');
    assert.equal((await req(h, 'GET', '/api/canais-oficiais/discord', s)).json.available, false);
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.available, true);
  });
});

describe('Endereço do serviço', () => {
  afterEach(async () => { await h.close(); });
  test('sem nada no ambiente: o relé dos canais no ar; "off" desliga; o ajuste da instalação troca', async () => {
    assert.equal(RELE_PADRAO, 'https://api.ergonworld.com/canais');
    assert.equal(DEFAULT_TEAMS_RELAY_URL, RELE_PADRAO, 'o padrão da configuração é o mesmo');
    h = await harness({ teamsRelayUrl: null, teamsRelayOficial: RELE_PADRAO });
    assert.equal(h.teamsApp.base(), RELE_PADRAO);
    h.teamsApp.definirEndereco('https://outro.exemplo/canais');
    assert.equal(h.teamsApp.base(), 'https://outro.exemplo/canais');
    h.teamsApp.definirEndereco('off');
    assert.equal(h.teamsApp.base(), null);
    h.teamsApp.definirEndereco(null);
    assert.equal(h.teamsApp.base(), RELE_PADRAO);
    await h.close();
    h = await harness();
    assert.equal(h.teamsApp.base(), null, 'os testes rodam sem o serviço oficial');
  });
});
