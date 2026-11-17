/**
 * O serviço oficial do Teams embutido no app (DEFAULT_TEAMS_RELAY_URL, ao lado de DEFAULT_WORLD_URL): vale sem
 * ERGON_TEAMS_RELAY_URL e sem o "Ajuste da instalação"; ERGON_TEAMS_RELAY_URL vazia desliga. Enquanto a saúde do
 * oficial não responde, a tela diz "ainda não disponível" e este Ergon não registra nada nem gera chaves; quando
 * responde, conecta sozinho. Endereço escolhido (ambiente ou ajuste) vale sem conferir a saúde.
 */
import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { setLog } from '../src/lib/log.ts';
import { DEFAULT_TEAMS_RELAY_URL, DEFAULT_WORLD_URL } from '../src/world/config.ts';
import { harness, loginAs, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

let rele: ReleFalso | null = null; let h: Harness | null = null; let s: Session;
const chaves = () => h!.db.get("SELECT value FROM instance_settings WHERE key = 'teams_relay_keys'");
async function ate(pred: () => boolean, msg: string, ms = 10_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(msg);
}
function rapido(x: Harness, saudeMs = 60_000) {
  x.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, saudeMs, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } };
}

describe('serviço oficial do Teams: o endereço embutido e quem vence', () => {
  test('o padrão é https://api.ergonworld.com/canais, o relé dos canais no ar; ERGON_TEAMS_RELAY_URL troca ou (vazia) desliga', () => {
    assert.equal(DEFAULT_TEAMS_RELAY_URL, 'https://api.ergonworld.com/canais');
    assert.equal(DEFAULT_WORLD_URL, 'https://api.ergonworld.com');
    const padrao = loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(padrao.teamsRelayOficial, DEFAULT_TEAMS_RELAY_URL);
    assert.equal(padrao.teamsRelayUrl, null, 'o oficial não conta como "definido na instalação" (o ajuste continua aberto)');
    const vazia = loadConfig({ ERGON_TEAMS_RELAY_URL: '' } as NodeJS.ProcessEnv);
    assert.equal(vazia.teamsRelayOficial, null); assert.equal(vazia.teamsRelayUrl, null);
    const outro = loadConfig({ ERGON_TEAMS_RELAY_URL: ' https://rele.exemplo.com ' } as NodeJS.ProcessEnv);
    assert.equal(outro.teamsRelayUrl, 'https://rele.exemplo.com');
  });
});

describe('serviço oficial do Teams: saúde antes de oferecer', () => {
  afterEach(async () => { await h?.close(); h = null; await rele?.parar(); rele = null; });
  after(() => setLog(null));

  test('fora do ar: "ainda não disponível", sem registro nem chaves; respondeu: a tela oferece e o Ergon conecta sozinho', async () => {
    rele = await ReleFalso.iniciar();
    rele.saudavel = false;
    h = await harness({ teamsRelayOficial: rele.base });
    rapido(h, 80);
    s = await setupOwner(h);
    await h.teamsApp.start();
    const g = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g.status, 200);
    assert.equal(g.json.available, false); assert.equal(g.json.reason, 'unavailable'); assert.equal(g.json.connection, 'offline');
    assert.equal(g.json.relay.fromEnv, false, 'o ajuste da instalação continua oferecido');
    assert.equal(g.json.relay.url, rele.base);
    assert.ok(rele.consultasDeSaude >= 1, 'conferiu a saúde');
    assert.equal(rele.tentativasDeRegistro, 0, 'nada de registro antes de a saúde responder');
    assert.equal(chaves(), undefined, 'nem chaves geradas');
    assert.equal(h.teamsApp.cliente, null);
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ABCD-EFGH' });
    assert.equal(c.status, 409); assert.equal(c.json.code ?? c.json.error, 'unavailable'); assert.equal(c.json.message, 'Ainda não disponível.');
    // continua conferindo sozinho (aqui a cada 80 ms; em produção, 1 h) e, quando a saúde responde, liga
    const antes = rele.consultasDeSaude;
    await ate(() => rele!.consultasDeSaude > antes, 'não conferiu de novo');
    rele.saudavel = true;
    await ate(() => rele!.conectado(), 'não conectou depois que a saúde respondeu');
    const g2 = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g2.json.available, true); assert.equal(g2.json.reason, undefined);
    assert.equal(rele.tentativasDeRegistro, 1);
    // já registrado no oficial: reiniciar com a saúde fora não esconde o recurso (é só "sem conexão" até voltar)
    const dir = h.dir; await h.close();
    rele.saudavel = false;
    h = await harness({ teamsRelayOficial: rele.base }, { dir });
    rapido(h, 80);
    await h.teamsApp.start();
    const g3 = await req(h, 'GET', '/api/teams-app', await loginAs(h, 'alexandre', 'senha-local-123'));
    assert.equal(g3.json.available, true);
    await ate(() => rele!.conectado(), 'não reconectou à instalação já registrada');
    assert.equal(rele.tentativasDeRegistro, 1, 'sem registrar de novo');
  });

  test('a tela aberta confere de novo (no máximo uma vez por minuto) e, se respondeu, conecta', async () => {
    rele = await ReleFalso.iniciar();
    rele.saudavel = false;
    h = await harness({ teamsRelayOficial: rele.base });
    rapido(h); // a nova tentativa sozinha só em 1 min: aqui quem confere é a tela
    s = await setupOwner(h);
    await h.teamsApp.start();
    const n = rele.consultasDeSaude;
    await req(h, 'GET', '/api/teams-app', s);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rele.consultasDeSaude, n, 'menos de um minuto depois: não confere de novo');
    rele.saudavel = true;
    const real = h.teamsApp.agora; h.teamsApp.agora = () => real() + 61_000;
    const g = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g.json.available, false, 'a resposta desta chamada ainda é a de antes');
    await ate(() => rele!.conectado(), 'não conectou depois da conferência pela tela');
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.available, true);
  });

  test('endereço escolhido vence o oficial e vale sem conferir a saúde; o ajuste vazio (ou igual ao oficial) volta ao padrão', async () => {
    rele = await ReleFalso.iniciar();
    rele.saudavel = false; // o relé escolhido nem precisa de /healthz
    h = await harness({ teamsRelayOficial: 'https://api.ergonworld.com/canais' });
    rapido(h);
    s = await setupOwner(h);
    // sem iniciar: o oficial não é conferido (nem pela tela), então fica indisponível
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.reason, 'unavailable');
    const put = await req(h, 'PUT', '/api/teams-app/relay-url', s, { url: rele.base });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    await h.teamsApp.start();
    await ate(() => rele!.conectado(), 'o endereço do ajuste não conectou');
    const g = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g.json.available, true); assert.equal(g.json.relay.url, rele.base);
    assert.equal(rele.consultasDeSaude, 0, 'endereço escolhido: sem conferir a saúde');
    assert.equal(h.teamsApp.oficial(), false);
    await req(h, 'PUT', '/api/teams-app/relay-url', s, { url: 'https://api.ergonworld.com/canais/' });
    assert.equal(h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'teams_relay_url'")?.value, '', 'o próprio oficial não fica gravado como escolha');
    assert.equal(h.teamsApp.oficial(), true);
    assert.equal(h.teamsApp.base(), 'https://api.ergonworld.com/canais');
  });

  test('ERGON_TEAMS_RELAY_URL vence o ajuste e o oficial; vazia (como nos testes), sem endereço nenhum', async () => {
    h = await harness({ teamsRelayUrl: 'https://rele.exemplo.com', teamsRelayOficial: 'https://api.ergonworld.com/canais' });
    assert.equal(h.teamsApp.base(), 'https://rele.exemplo.com'); assert.equal(h.teamsApp.oficial(), false); assert.equal(h.teamsApp.disponivel(), true);
    await h.close();
    h = await harness();
    s = await setupOwner(h);
    assert.equal(h.cfg.teamsRelayOficial, null);
    const g = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g.json.available, false); assert.equal(g.json.reason, 'unconfigured');
  });
});
