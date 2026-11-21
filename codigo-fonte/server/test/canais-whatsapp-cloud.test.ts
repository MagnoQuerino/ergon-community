/**
 * rc.47: conversar com a equipe pelo WhatsApp oficial (Cloud API da Meta), com o motor falso e o relé falso. O relé é o
 * endereço público do webhook: o Ergon pede a rota com um verify token gerado aqui; as credenciais (token de acesso e App
 * Secret) vão só ao motor; a notificação que a Meta mandou ao relé chega selada pela conexão de saída, fica guardada
 * (cifrada) e vai ao motor pela saída dos canais, com o corpo cru e a assinatura, para o plugin conferir com o App
 * Secret; o que o motor recusa por assinatura sai e fica na auditoria. O plugin de verdade, com o Hermes contra a Meta
 * falsa, é conferido em hermes/tests/test_ergon_bridge_canais_whatsapp_cloud.py; o relé, em ergon-world/relay-teams.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import type { CanalNoMotor, CredencialCanal, HermesClient, HermesControlClient, LoginQrMotor, ModelOptions, NomeCanal, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { CanalErro } from '../src/services/hermes.ts';
import { RESPOSTA } from '../src/services/canais/index.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

const TOKEN = ['token-da-ponte', 'de-teste', '0123456789'].join('-');
const SENHA = 'senha-local-123';
// credenciais de exemplo, montadas por partes
const NUMERO = '1098765' + '43210987';
const WABA = '2000000' + '00000001';
const ACESSO = 'EAAG' + 'teste'.repeat(12) + 'Zx9';
const SEGREDO = '0123456789abcdef' + 'fedcba9876543210';
const DONA = '919812' + '345678';
const PONTE = { 'x-ergon-bridge-token': TOKEN };
const CERTO = { phoneNumberId: NUMERO, accessToken: ACESSO, appSecret: SEGREDO, wabaId: WABA };

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>(); n = 0; pedidos: StartRun[] = [];
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    this.pedidos.push(p);
    const runId = `run_teste${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** A ponte de controle do plugin, falsa: guarda a credencial, faz o login do WeChat pelo QR e devolve o pareamento. */
class Controle implements HermesControlClient {
  caps = ['conexoes', 'canais', 'canais_feishu_dingtalk', 'canais_wecom_weixin', 'canais_whatsapp_cloud'];
  bots: Partial<Record<NomeCanal, string>> = {};
  pareados: Partial<Record<NomeCanal, string>> = {};
  codigos: Record<string, { canal: NomeCanal; user: string; nome: string; chat: string }> = {};
  qr: LoginQrMotor = { estado: 'parado', qr: '', erro: null, expiraEm: 0 };
  qrPedidos: string[] = [];
  async health() { return true; }
  async info() { return { ok: true, pluginVersion: '0.13.0', vaultConfig: 11, capacidades: this.caps }; }
  async accounts() { return []; }
  async startLogin() { return { sessionId: 's', userCode: null, verificationUrl: null, expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null } as never; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: 'x/y', provider: 'nous' }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: ['todo'], safe: ['todo', 'web'] }; }
  async setApiToolsets(e: string[]) { return e; }
  async canais() {
    const um = (c: NomeCanal): CanalNoMotor => ({ configurado: !!this.bots[c], estado: this.bots[c] ? 'connected' : null, erro: null, ligados: this.pareados[c] ? [{ user_id: this.pareados[c]!, user_name: 'Ana' }] : [] });
    return { telegram: um('telegram'), discord: um('discord'), feishu: um('feishu'), dingtalk: um('dingtalk'), wecom: um('wecom'), weixin: um('weixin'), whatsapp_cloud: um('whatsapp_cloud') };
  }
  async setCanal(c: NomeCanal, cred: CredencialCanal) { this.bots[c] = 'token' in cred ? cred.token : JSON.stringify(cred); delete this.pareados[c]; }
  async parearCanal(c: NomeCanal, codigo: string) {
    const x = this.codigos[codigo];
    if (!x || x.canal !== c) throw new CanalErro('codigo', 'Código não encontrado ou vencido.');
    delete this.codigos[codigo];
    this.pareados[c] = x.user;
    return { userId: x.user, userName: x.nome, chatId: x.chat };
  }
  async removerCanal(c: NomeCanal) { delete this.bots[c]; delete this.pareados[c]; }
  async weixinQr(acao: 'iniciar' | 'estado' | 'cancelar') {
    this.qrPedidos.push(acao);
    if (acao === 'iniciar') this.qr = { estado: 'aguardando', qr: 'https://liteapp.weixin.qq.com/q/falso0001?qrcode=qr0001&bot_type=3', erro: null, expiraEm: 470 };
    if (acao === 'cancelar') this.qr = { estado: 'parado', qr: '', erro: null, expiraEm: 0 };
    return { ...this.qr };
  }
}

let h: Harness; let s: Session; let motor: Motor; let ctl: Controle; let rele: ReleFalso;
async function ate(pred: () => boolean | Promise<boolean>, m = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (await pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(m);
}
beforeEach(async () => {
  rele = await ReleFalso.iniciar();
  motor = new Motor(); ctl = new Controle();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN, teamsRelayUrl: rele.base }, { hermes: motor, control: ctl });
  h.canais.ajustes = { avisosMs: 60, atrasoMs: 10, digitandoMs: 5000, esperaMaxMs: 300, arrendamentoMs: 200 };
  h.teamsApp.ajustes = { ...h.teamsApp.ajustes, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } };
  s = await setupOwner(h);
  h.canais.start();
  await h.teamsApp.start();
  await ate(() => h.teamsApp.conectadoAoServico() && h.teamsApp.whatsappNoServico() === true, 'o Ergon não conectou ao relé falso');
});
afterEach(async () => { h.canais.stop(); await h.teamsApp.stop(); await h.close(); await rele.parar(); });

const CANAIS = ['telegram', 'discord', 'feishu', 'dingtalk', 'wecom', 'weixin', 'whatsapp_cloud'];
async function buscar(acks: Array<Record<string, unknown>> = [], espera = 0): Promise<Array<Record<string, any>>> {
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: CANAIS, acks, espera }, PONTE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.itens;
}
const assinar = (raw: Buffer, segredo = SEGREDO) => 'sha256=' + crypto.createHmac('sha256', segredo).update(raw).digest('hex');
const notificacao = (texto: string) => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001234', phone_number_id: NUMERO }, contacts: [{ profile: { name: 'Priya' }, wa_id: DONA }],
  messages: [{ from: DONA, id: 'wamid.' + crypto.randomBytes(6).toString('hex'), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }] } }] }] }));
const ackDoRele = (id: string) => rele.acks.find((a) => a.id === id);
const tabela = () => h.db.all<{ id: string; status: string; assinatura: string }>('SELECT id, status, assinatura FROM canais_webhooks');

test('WhatsApp oficial: pede o plugin da rc.47 e o relé; credenciais só no motor; o endereço e o verify token na tela', async () => {
  ctl.caps = ['conexoes', 'canais', 'canais_feishu_dingtalk', 'canais_wecom_weixin'];
  (h.canais.d as { capacidades: unknown }).capacidades = async () => ctl.caps;
  let e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.whatsapp_cloud.disponivel, false); assert.equal(e.whatsapp_cloud.motivo, 'versao');
  assert.equal((await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO)).status, 409, 'motor de antes: nem tenta');
  ctl.caps.push('canais_whatsapp_cloud');
  e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.whatsapp_cloud.disponivel, true); assert.equal(e.whatsapp_cloud.rele, 'ok'); assert.equal(e.whatsapp_cloud.webhook, null);
  for (const ruim of [{ ...CERTO, appSecret: 'curto' }, { ...CERTO, phoneNumberId: 'abc12345' }, { ...CERTO, accessToken: 'x'.repeat(39) }, { ...CERTO, wabaId: '12' }]) {
    const r = await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, ruim);
    assert.equal(r.status, 400, JSON.stringify(r.json));
  }
  assert.equal(ctl.bots.whatsapp_cloud, undefined, 'formato errado nem vai ao motor');
  assert.equal(rele.rotaWa, null, 'nem pede a rota');
  const r = await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cred = JSON.parse(ctl.bots.whatsapp_cloud!) as Record<string, string>;
  assert.deepEqual({ ...cred, verifyToken: 'x' }, { phoneNumberId: NUMERO, accessToken: ACESSO, appSecret: SEGREDO, wabaId: WABA, verifyToken: 'x' });
  assert.match(cred.verifyToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(rele.verifyWa, cred.verifyToken, 'o relé recebe o mesmo verify token (para a verificação da Meta)');
  const w = r.json.whatsapp_cloud.webhook;
  assert.equal(w.url, `${rele.base.replace('http://', 'https://')}/whatsapp/${rele.rotaWa}`);
  assert.equal(w.verifyToken, cred.verifyToken); assert.equal(w.phoneNumberId, NUMERO);
  const tela = JSON.stringify(r.json);
  assert.ok(!tela.includes(ACESSO) && !tela.includes(SEGREDO), 'o token e o App Secret não voltam para a tela');
  const banco = h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => JSON.stringify(h.db.all(`SELECT * FROM "${t.name}"`))).join('');
  assert.ok(!banco.includes(ACESSO) && !banco.includes(SEGREDO), 'nem ficam no banco');
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'canal.whatsapp_cloud.ligar'"), 'fica na auditoria');
  // de novo (trocou o token): o mesmo endereço e o mesmo verify token (o que está colado na Meta continua valendo)
  const rota = rele.rotaWa;
  const r2 = await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, { ...CERTO, accessToken: ACESSO + 'B' });
  assert.equal(r2.json.whatsapp_cloud.webhook.verifyToken, cred.verifyToken); assert.equal(rele.rotaWa, rota);
  // desligar: o motor apaga, e a rota some no relé
  e = (await req(h, 'DELETE', '/api/canais/whatsapp_cloud', s)).json;
  assert.equal(ctl.bots.whatsapp_cloud, undefined); assert.equal(e.whatsapp_cloud.webhook, null);
  await ate(() => rele.rotaWa === null, 'a rota não sumiu no relé');
});

test('WhatsApp oficial: o relé fora (ou sem o webhook) não deixa ligar; o endereço de outro servidor é recusado', async () => {
  rele.whatsapp = false;
  await h.teamsApp.stop(); await h.teamsApp.start();
  await ate(() => h.teamsApp.whatsappNoServico() === false, 'não releu /v1/info');
  const r = await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO);
  assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.error, 'rele');
  assert.equal(ctl.bots.whatsapp_cloud, undefined);
  rele.whatsapp = true; rele.urlWa = 'https://outro.exemplo.invalido/whatsapp/wac_' + 'a'.repeat(22);
  await h.teamsApp.stop(); await h.teamsApp.start();
  await ate(() => h.teamsApp.whatsappNoServico() === true, 'não releu /v1/info');
  const r2 = await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO);
  assert.equal(r2.status, 502, JSON.stringify(r2.json)); assert.equal(ctl.bots.whatsapp_cloud, undefined);
});

test('WhatsApp oficial: a notificação do relé vai ao motor com o corpo cru e a assinatura; recusada por assinatura sai e fica na auditoria', async () => {
  // sem ninguém com o WhatsApp oficial neste Ergon, o relé recebe a recusa (e descarta)
  const sem = notificacao('ninguém aqui');
  const id0 = rele.notificacaoWhatsApp(sem, assinar(sem));
  await ate(() => !!ackDoRele(id0), 'sem ack do Ergon');
  assert.equal(ackDoRele(id0)!.ok, false); assert.equal(ackDoRele(id0)!.error?.code, 'disabled');
  assert.equal((await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO)).status, 200);
  const raw = notificacao('कल की बिक्री रिपोर्ट भेजो');
  const id1 = rele.notificacaoWhatsApp(raw, assinar(raw));
  await ate(() => ackDoRele(id1)?.ok === true, 'o Ergon não aceitou a notificação');
  // repetida pelo relé (pelo menos uma vez): não duplica
  rele.conexao!.enviar({ ...rele.quadros.at(-1), id: id1 });
  assert.equal(tabela().length, 1);
  const guardado = h.db.raw.prepare('SELECT corpo FROM canais_webhooks').get() as { corpo: string };
  assert.ok(!guardado.corpo.includes(raw.toString('base64').slice(0, 40)), 'o corpo fica cifrado no banco');
  // o motor busca pela saída: o item "webhook" com o corpo cru (base64) e a assinatura da Meta
  let itens: Array<Record<string, any>> = [];
  await ate(async () => { itens = (await buscar()).filter((i) => i.tipo === 'webhook'); return itens.length > 0; }, 'o motor não recebeu a notificação');
  assert.equal(itens[0].canal, 'whatsapp_cloud');
  assert.ok(Buffer.from(itens[0].corpo, 'base64').equals(raw), 'byte a byte (a assinatura é sobre ele)');
  assert.equal(itens[0].assinatura, assinar(raw));
  assert.equal((await buscar()).filter((i) => i.tipo === 'webhook').length, 0, 'em voo: não vai de novo logo');
  await buscar([{ id: itens[0].id, ok: true }]);
  assert.equal(tabela().length, 0, 'recebida pelo motor: sai');
  // o motor recusa por assinatura (App Secret trocado, ou não veio da Meta): sai e fica na auditoria
  const raw2 = notificacao('forjada');
  const id2 = rele.notificacaoWhatsApp(raw2, assinar(raw2, 'f'.repeat(32)));
  await ate(() => ackDoRele(id2)?.ok === true, 'sem ack');
  await ate(async () => { itens = (await buscar()).filter((i) => i.tipo === 'webhook'); return itens.length > 0; }, 'não saiu');
  await buscar([{ id: itens[0].id, ok: false, erro: 'assinatura' }]);
  assert.equal(tabela().length, 0);
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'canal.whatsapp_cloud.assinatura'"));
  // passageiro (o gateway reiniciando): fica e vai de novo
  const raw3 = notificacao('de novo');
  const id3 = rele.notificacaoWhatsApp(raw3, assinar(raw3));
  await ate(() => ackDoRele(id3)?.ok === true, 'sem ack');
  await ate(async () => { itens = (await buscar()).filter((i) => i.tipo === 'webhook'); return itens.length > 0; }, 'não saiu');
  const de_novo = await buscar([{ id: itens[0].id, ok: false, erro: 'sem conexão', passageiro: true }]);
  assert.ok(de_novo.some((i) => i.id === itens[0].id && i.tipo === 'webhook'), 'vai de novo ao motor');
  assert.equal(tabela().length, 1);
  // um motor que não manda o canal whatsapp_cloud na lista não recebe nada dele
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: ['telegram'], acks: [], espera: 0 }, PONTE);
  assert.equal(r.json.itens.filter((i: { tipo: string }) => i.tipo === 'webhook').length, 0);
});

test('WhatsApp oficial: depois do código, a mensagem em hindi vira pedido na conversa "WhatsApp"; a resposta sai pelo canal', async () => {
  await req(h, 'PUT', '/api/me/prefs', s, { lang: 'hi' });
  assert.equal((await req(h, 'PUT', '/api/canais/whatsapp_cloud/bot', s, CERTO)).status, 200);
  ctl.codigos.ABCD2345 = { canal: 'whatsapp_cloud', user: DONA, nome: 'Priya', chat: DONA };
  const p = await req(h, 'POST', '/api/canais/whatsapp_cloud/parear', s, { codigo: 'abcd-2345', password: SENHA });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const entrada = (b: Record<string, unknown>) => req(h, 'POST', '/internal/bridge/v1/canais/entrada', null, { schema: 'ergon.canais.v1', canal: 'whatsapp_cloud', ...b }, PONTE);
  const fora = await entrada({ tipo: 'mensagem', user_id: '919900011122', chat_id: '919900011122', message_id: 'w0', text: 'नमस्ते' });
  assert.equal(fora.json.reply, RESPOSTA.semVinculo);
  const r = await entrada({ tipo: 'mensagem', user_id: DONA, chat_id: DONA, user_name: 'Priya', message_id: 'wamid.x1', text: 'कल की बिक्री रिपोर्ट भेजो', sent_at: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const conv = h.db.get<{ conversation_id: string }>("SELECT conversation_id FROM canais_vinculos WHERE canal = 'whatsapp_cloud'")!.conversation_id;
  assert.equal(h.db.get<{ title: string }>('SELECT title FROM conversations WHERE id = ?', conv)!.title, 'WhatsApp');
  await ate(() => motor.pedidos.length === 1, 'o pedido não foi à equipe');
  assert.match(motor.pedidos[0].instructions ?? '', /hindi|हिन्दी|Hindi/i);
  const run = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(run.hermes_run_id, { status: 'completed', output: 'कल की बिक्री ₹12,34,567 रही।', error: null, sessionId: 'x', usage: null, model: 'nous/teste-1' });
  const vistos: Array<Record<string, any>> = [];
  await ate(async () => { const it = await buscar(); vistos.push(...it); if (it.length) await buscar(it.filter((i) => i.tipo !== 'digitando').map((i) => ({ id: i.id, ok: true }))); return vistos.some((x) => x.tipo === 'texto' && /12,34,567/.test(x.texto)); }, 'a resposta não saiu');
  const resp = vistos.find((x) => x.tipo === 'texto' && /12,34,567/.test(x.texto))!;
  assert.equal(resp.canal, 'whatsapp_cloud'); assert.equal(resp.chat_id, DONA);
});
