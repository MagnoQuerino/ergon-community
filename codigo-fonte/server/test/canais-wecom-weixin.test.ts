/**
 * rc.46: conversar com a equipe pelo WeCom (企业微信, o robô inteligente) e pelo WeChat pessoal (微信, iLink, experimental),
 * com o motor e o gateway falsos, pelo mesmo caminho do Feishu e do DingTalk (canais-feishu-dingtalk.test.ts): o Bot ID e
 * o Secret do WeCom vão ao motor (nunca ao banco nem à tela); o WeChat pessoal só liga pelo QR, com o consentimento
 * explícito da pessoa (fica na auditoria), e o QR chega à tela como imagem (o token da conta nunca passa por aqui); a
 * mensagem em chinês pelo WeCom vira pedido na conversa "WeCom" com o coordenador; o cartão vai sem botões e o WeChat
 * pessoal não recebe a imagem dos visuais. O plugin de verdade, com o Hermes contra o WeCom e o iLink falsos, é conferido
 * em hermes/tests/test_ergon_bridge_canais_wecom_weixin.py.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CanalNoMotor, CredencialCanal, HermesClient, HermesControlClient, LoginQrMotor, ModelOptions, NomeCanal, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { CanalErro } from '../src/services/hermes.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { coordinatorFor } from '../src/services/team-query.ts';
import { RESPOSTA, notaCanal } from '../src/services/canais/index.ts';
import { WEIXIN_RISCO_VERSAO } from '../src/services/canais/servico.ts';
import { msg } from '../src/lib/i18n.ts';
import { cercaVisual } from '../../shared/visuais/cercas.ts';
import { EXEMPLOS } from '../../shared/visuais/exemplos.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = ['token-da-ponte', 'de-teste', '0123456789'].join('-');
const SENHA = 'senha-local-123';
// credenciais de exemplo, montadas por partes
const WC_ID = 'aib' + 'Qx7Lm2Np9Rs4Tv';
const WC_SEGREDO = 'Sc' + 'rT8w'.repeat(8);
const WC_USER = 'ZhangWei';
const WX_USER = 'o9cq80' + '0kum_x7Y2bQ' + '@im.wechat';
const PONTE = { 'x-ergon-bridge-token': TOKEN };

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
  caps = ['conexoes', 'canais', 'canais_feishu_dingtalk', 'canais_wecom_weixin'];
  bots: Partial<Record<NomeCanal, string>> = {};
  pareados: Partial<Record<NomeCanal, string>> = {};
  codigos: Record<string, { canal: NomeCanal; user: string; nome: string; chat: string }> = {};
  qr: LoginQrMotor = { estado: 'parado', qr: '', erro: null, expiraEm: 0 };
  qrPedidos: string[] = [];
  async health() { return true; }
  async info() { return { ok: true, pluginVersion: '0.12.0', vaultConfig: 11, capacidades: this.caps }; }
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

let h: Harness; let s: Session; let motor: Motor; let ctl: Controle;
async function ate(pred: () => boolean, m = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(m);
}
beforeEach(async () => {
  motor = new Motor(); ctl = new Controle();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: ctl });
  h.canais.ajustes = { avisosMs: 60, atrasoMs: 10, digitandoMs: 5000, esperaMaxMs: 300, arrendamentoMs: 200 };
  s = await setupOwner(h);
  h.canais.start();
});
afterEach(async () => { h.canais.stop(); await h.close(); });

const entrada = (b: Record<string, unknown>) => req(h, 'POST', '/internal/bridge/v1/canais/entrada', null, { schema: 'ergon.canais.v1', canal: 'wecom', ...b }, PONTE);
const recebidos: Array<Record<string, any>> = [];
async function buscar(acks: Array<Record<string, unknown>> = [], espera = 0): Promise<Array<Record<string, any>>> {
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: ['telegram', 'discord', 'feishu', 'dingtalk', 'wecom', 'weixin'], acks, espera }, PONTE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.itens;
}
async function ateSair(pred: (x: Record<string, any>) => boolean, m: string): Promise<Record<string, any>> {
  const fim = Date.now() + 15_000;
  while (Date.now() < fim) {
    await h.executor.tick().catch(() => undefined);
    const itens = await buscar();
    recebidos.push(...itens);
    if (itens.length) await buscar(itens.filter((i) => i.tipo !== 'digitando').map((i) => ({ id: i.id, ok: true, message_id: `msg-${i.id}` })));
    const achou = recebidos.find(pred);
    if (achou) return achou;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(m);
}
async function ligar(canal: 'wecom' | 'weixin'): Promise<void> {
  if (canal === 'wecom') {
    const r0 = await req(h, 'PUT', '/api/canais/wecom/bot', s, { appId: WC_ID, appSecret: WC_SEGREDO });
    assert.equal(r0.status, 200, JSON.stringify(r0.json));
  } else {
    ctl.bots.weixin = 'conta-do-qr';
  }
  ctl.codigos.ABCD2345 = canal === 'wecom' ? { canal, user: WC_USER, nome: WC_USER, chat: WC_USER } : { canal, user: WX_USER, nome: WX_USER, chat: WX_USER };
  const r = await req(h, 'POST', `/api/canais/${canal}/parear`, s, { codigo: 'abcd-2345', password: SENHA });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const conversa = (canal: string) => h.db.get<{ conversation_id: string }>('SELECT conversation_id FROM canais_vinculos WHERE canal = ?', canal)?.conversation_id ?? null;
async function terminar(output: string): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.id)!.status === 'succeeded', 'a execução não terminou');
}

test('WeCom: pede o plugin da rc.46; o Bot ID e o Secret vão ao motor (nunca ao banco nem à tela); o pareamento com o userid', async () => {
  ctl.caps = ['conexoes', 'canais', 'canais_feishu_dingtalk'];
  (h.canais.d as { capacidades: unknown }).capacidades = async () => ctl.caps;
  let e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.feishu.disponivel, true, 'o Feishu segue com o plugin da rc.45');
  assert.equal(e.wecom.disponivel, false); assert.equal(e.wecom.motivo, 'versao');
  assert.equal(e.weixin.disponivel, false);
  assert.equal((await req(h, 'PUT', '/api/canais/wecom/bot', s, { appId: WC_ID, appSecret: WC_SEGREDO })).status, 409, 'motor de antes: nem tenta');
  ctl.caps = ['conexoes', 'canais', 'canais_feishu_dingtalk', 'canais_wecom_weixin'];
  e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.wecom.disponivel, true); assert.equal(e.weixin.disponivel, true);
  assert.equal(e.weixin.experimental, true, 'o WeChat pessoal vem marcado como experimental');
  assert.equal(e.weixin.bot, false, 'desligado até a pessoa ligar');
  for (const ruim of [{ appId: 'curto', appSecret: WC_SEGREDO }, { appId: WC_ID, appSecret: 'curto-demais' }, { token: 'x'.repeat(20) }]) {
    const r = await req(h, 'PUT', '/api/canais/wecom/bot', s, ruim);
    assert.equal(r.status, 400, JSON.stringify(r.json)); assert.equal(r.json.error, 'formato_app');
  }
  assert.equal(ctl.bots.wecom, undefined, 'formato errado nem vai ao motor');
  e = (await req(h, 'PUT', '/api/canais/wecom/bot', s, { appId: WC_ID, appSecret: WC_SEGREDO, dominio: 'lark' })).json;
  assert.deepEqual(JSON.parse(ctl.bots.wecom!), { appId: WC_ID, appSecret: WC_SEGREDO }, 'o WeCom não tem domínio');
  assert.equal(e.wecom.bot, true); assert.equal(e.wecom.conexao, 'conectado');
  const tela = JSON.stringify(e);
  assert.ok(!tela.includes(WC_SEGREDO), 'o Secret não volta para a tela');
  const banco = h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => JSON.stringify(h.db.all(`SELECT * FROM "${t.name}"`))).join('');
  assert.ok(!banco.includes(WC_SEGREDO), 'o Secret não fica no banco');
  const wx = await req(h, 'PUT', '/api/canais/weixin/bot', s, { appId: WC_ID, appSecret: WC_SEGREDO });
  assert.equal(wx.status, 400); assert.equal(wx.json.error, 'qr', 'o WeChat pessoal não aceita credencial colada');
  ctl.codigos.ABCD2345 = { canal: 'wecom', user: WC_USER, nome: WC_USER, chat: WC_USER };
  e = (await req(h, 'POST', '/api/canais/wecom/parear', s, { codigo: 'ABCD2345', password: SENHA })).json;
  assert.equal(e.wecom.ligado.nome, WC_USER);
  const v = h.db.get<{ externo_id: string; chat_id: string }>("SELECT externo_id, chat_id FROM canais_vinculos WHERE canal = 'wecom'")!;
  assert.deepEqual([v.externo_id, v.chat_id], [WC_USER, WC_USER]);
  e = (await req(h, 'DELETE', '/api/canais/wecom', s)).json;
  assert.equal(ctl.bots.wecom, undefined); assert.equal(e.wecom.ligado, null);
});

test('WeChat pessoal: o QR só com o consentimento explícito (na auditoria), como imagem; o endereço estranho não vira imagem', async () => {
  // sem a capacidade da rc.46, nem pede o QR
  ctl.caps = ['conexoes', 'canais', 'canais_feishu_dingtalk'];
  (h.canais.d as { capacidades: unknown }).capacidades = async () => ctl.caps;
  const consentimento = { aceito: true, versao: WEIXIN_RISCO_VERSAO };
  assert.equal((await req(h, 'POST', '/api/canais/weixin/qr', s, { consentimento })).status, 409);
  ctl.caps.push('canais_wecom_weixin');
  // sem consentimento (ou com o de outro texto do risco): nada vai ao motor
  for (const ruim of [{}, { consentimento: { aceito: false, versao: WEIXIN_RISCO_VERSAO } }, { consentimento: { aceito: true, versao: WEIXIN_RISCO_VERSAO + 1 } }]) {
    const r = await req(h, 'POST', '/api/canais/weixin/qr', s, ruim);
    assert.equal(r.status, 400, JSON.stringify(r.json));
  }
  assert.equal((await req(h, 'POST', '/api/canais/weixin/qr', s, { consentimento: { aceito: false, versao: WEIXIN_RISCO_VERSAO } })).json.error, 'consentimento');
  assert.deepEqual(ctl.qrPedidos, [], 'sem o sim da pessoa, o motor nem pede o QR');
  const r = await req(h, 'POST', '/api/canais/weixin/qr', s, { consentimento });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'aguardando');
  assert.match(r.json.qr, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, 'o QR chega como imagem (o navegador não fala com a Tencent)');
  assert.equal(r.json.expiraEm, 470);
  const aud = h.db.all<{ action: string; actor_id: string }>("SELECT action, actor_id FROM audit_events WHERE action = 'canal.weixin.consentimento'");
  assert.equal(aud.length, 1, 'o consentimento fica na auditoria'); assert.equal(aud[0].actor_id, s.userId);
  // escaneado: o QR segue na tela; confirmado: o canal fica configurado e o QR some
  ctl.qr = { estado: 'escaneado', qr: ctl.qr.qr, erro: null, expiraEm: 400 };
  assert.match((await req(h, 'GET', '/api/canais/weixin/qr', s)).json.qr, /^data:image\/png/);
  ctl.qr = { estado: 'confirmado', qr: '', erro: null, expiraEm: 0 };
  const c = (await req(h, 'GET', '/api/canais/weixin/qr', s)).json;
  assert.equal(c.estado, 'confirmado'); assert.equal(c.qr, null);
  assert.ok(h.db.get("SELECT 1 AS x FROM canais_bots WHERE canal = 'weixin'"), 'confirmado: a tela pede o código de pareamento');
  // um endereço que não é da Tencent não vira imagem
  ctl.qr = { estado: 'aguardando', qr: 'https://exemplo.invalido/q/abc', erro: null, expiraEm: 300 };
  assert.equal((await req(h, 'GET', '/api/canais/weixin/qr', s)).json.qr, null);
  const cancel = (await req(h, 'DELETE', '/api/canais/weixin/qr', s)).json;
  assert.equal(cancel.estado, 'parado');
});

test('a mensagem em chinês pelo WeCom vira pedido na conversa "WeCom" com o coordenador; o cartão sem botões; o WeChat pessoal sem a imagem dos visuais', async () => {
  recebidos.length = 0;
  await req(h, 'PUT', '/api/me/prefs', s, { lang: 'zh-CN' });
  await ligar('wecom');
  const fora = await entrada({ tipo: 'mensagem', user_id: 'LiNa', chat_id: 'LiNa', message_id: 'm0', text: '你好' });
  assert.equal(fora.json.reply, RESPOSTA.semVinculo);
  const r = await entrada({ tipo: 'mensagem', user_id: WC_USER, chat_id: WC_USER, user_name: WC_USER, message_id: 'wc_msg_2', text: '请帮我整理本周的客户跟进', sent_at: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.digitando, true);
  const conv = conversa('wecom')!;
  const c = h.db.get<{ title: string; agent_id: string }>('SELECT title, agent_id FROM conversations WHERE id = ?', conv)!;
  assert.equal(c.title, 'WeCom'); assert.equal(c.agent_id, coordinatorFor(h.db, s.workspaceId));
  await ate(() => motor.pedidos.length === 1, 'o pedido não foi à equipe');
  const instr = motor.pedidos[0].instructions ?? '';
  assert.ok(instr.includes(notaCanal('wecom')), 'o agente sabe que a conversa é pelo WeCom');
  assert.match(instr, /Idioma: a pessoa usa o Ergon em chinês simplificado/);
  await terminar(`本周共有 12 位客户待跟进。\n\n${cercaVisual(EXEMPLOS.barras)}`);
  const resp = await ateSair((x) => x.tipo === 'texto' && /12 位客户/.test(x.texto), 'a resposta não saiu');
  assert.equal(resp.canal, 'wecom'); assert.equal(resp.chat_id, WC_USER);
  await ateSair((x) => x.tipo === 'imagem' && x.canal === 'wecom', 'o WeCom recebe a imagem do visual');
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
  const cartao = await ateSair((x) => x.tipo === 'cartao' && x.canal === 'wecom', 'o cartão não saiu');
  assert.deepEqual(cartao.botoes ?? [], [], 'sem botões');
  assert.ok(cartao.texto.includes(msg('zh-CN', 'canal.decidaNoApp')), cartao.texto);
  const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'sector_new' AND workspace_id = ?", s.workspaceId)!.id;
  const clique = await entrada({ tipo: 'clique', user_id: WC_USER, chat_id: WC_USER, dado: `a:${pid}`, evento: 'e1' });
  assert.equal(clique.json.reply, RESPOSTA.noErgon, 'clique forjado não decide');
  // o WeChat pessoal: a mesma conversa com a equipe, sem a imagem
  await ligar('weixin');
  const rw = await entrada({ canal: 'weixin', tipo: 'mensagem', user_id: WX_USER, chat_id: WX_USER, message_id: 'wx1', text: '明天上午十点提醒我开会' });
  assert.equal(rw.status, 200, JSON.stringify(rw.json));
  assert.equal(h.db.get<{ title: string }>('SELECT title FROM conversations WHERE id = ?', conversa('weixin'))!.title, 'WeChat');
  await ate(() => motor.pedidos.length === 2, 'o pedido do WeChat não foi à equipe');
  await terminar(`好的。\n\n${cercaVisual(EXEMPLOS.barras)}`);
  await ateSair((x) => x.tipo === 'texto' && x.canal === 'weixin' && /好的/.test(x.texto), 'a resposta do WeChat não saiu');
  await new Promise((r2) => setTimeout(r2, 200));
  recebidos.push(...await buscar());
  assert.ok(!recebidos.some((x) => x.tipo === 'imagem' && x.canal === 'weixin'), 'o WeChat pessoal não recebe a imagem do visual');
});
