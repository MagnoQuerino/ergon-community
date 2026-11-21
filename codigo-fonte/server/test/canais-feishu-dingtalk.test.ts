/**
 * rc.45: conversar com a equipe pelo Feishu (ou Lark) e pelo DingTalk, com o motor e o gateway falsos, pelo mesmo caminho
 * do Telegram e do Discord (canais.test.ts): o App ID e o App Secret vão ao motor (nunca ao banco nem à tela), o Lark
 * internacional, o pareamento com os ids de texto de cada plataforma, a mensagem em chinês que vira pedido na conversa
 * "Feishu/Lark" com o coordenador (com o idioma da pessoa nas instruções do agente), a resposta pela saída, o cartão
 * sem botões (a decisão é no app, no idioma da pessoa) e o clique forjado que não decide. O plugin de verdade, com o
 * Hermes e os SDKs do Feishu e do DingTalk contra servidores falsos, é conferido em
 * hermes/tests/test_ergon_bridge_canais_china.py.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CanalNoMotor, CredencialCanal, HermesClient, HermesControlClient, ModelOptions, NomeCanal, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { CanalErro } from '../src/services/hermes.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { coordinatorFor } from '../src/services/team-query.ts';
import { RESPOSTA, notaCanal } from '../src/services/canais/index.ts';
import { msg } from '../src/lib/i18n.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = ['token-da-ponte', 'de-teste', '0123456789'].join('-');
const SENHA = 'senha-local-123';
// credenciais de exemplo, montadas por partes
const FS_ID = 'cli_' + 'a1b2c3d4e5f6a7b8';
const FS_SEGREDO = 'Xy' + 'z9'.repeat(15);
const DT_ID = 'ding' + 'abcdefgh12345678';
const DT_SEGREDO = 'Sg' + '-a1B2'.repeat(10);
const FS_USER = 'ou_' + '7d8a6e6df7621556ce0d21922b676706';
const FS_CHAT = 'oc_' + '5ad11d72b830411d72b836c20';
const DT_USER = '$:LWCP_v1:$' + 'h8Nq+2Zp/9kWbBVc0ZqYhw==';
const DT_CHAT = 'cid' + 'Xp4Mz+0bJk1sWQ2Hq9N7lg==';
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

/** A ponte de controle do plugin, falsa: guarda o código do bot e devolve o pareamento. */
class Controle implements HermesControlClient {
  caps = ['conexoes', 'canais', 'canais_feishu_dingtalk'];
  bots: Partial<Record<NomeCanal, string>> = {};
  pareados: Partial<Record<NomeCanal, string>> = {};
  codigos: Record<string, { canal: NomeCanal; user: string; nome: string; chat: string }> = {};
  async health() { return true; }
  async info() { return { ok: true, pluginVersion: '0.4.0', vaultConfig: 11, capacidades: this.caps }; }
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
    return { telegram: um('telegram'), discord: um('discord'), feishu: um('feishu'), dingtalk: um('dingtalk') };
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
}

let h: Harness; let s: Session; let motor: Motor; let ctl: Controle;
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(msg);
}
beforeEach(async () => {
  motor = new Motor(); ctl = new Controle();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: ctl });
  h.canais.ajustes = { avisosMs: 60, atrasoMs: 10, digitandoMs: 5000, esperaMaxMs: 300, arrendamentoMs: 200 };
  s = await setupOwner(h);
  h.canais.start();
});
afterEach(async () => { h.canais.stop(); await h.close(); });

/** O gateway falso: o que o plugin faria. */
const entrada = (b: Record<string, unknown>) => req(h, 'POST', '/internal/bridge/v1/canais/entrada', null, { schema: 'ergon.canais.v1', canal: 'feishu', ...b }, PONTE);
const recebidos: Array<Record<string, any>> = [];
async function buscar(acks: Array<Record<string, unknown>> = [], espera = 0): Promise<Array<Record<string, any>>> {
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: ['telegram', 'discord', 'feishu', 'dingtalk'], acks, espera }, PONTE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.itens;
}
/** Busca até chegar algo que satisfaz, confirmando tudo como enviado (o número da mensagem é o id do item). */
async function ateSair(pred: (x: Record<string, any>) => boolean, msg: string): Promise<Record<string, any>> {
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
  assert.fail(msg);
}
async function ligar(canal: 'feishu' | 'dingtalk' = 'feishu'): Promise<void> {
  const cred = canal === 'feishu' ? { appId: FS_ID, appSecret: FS_SEGREDO, dominio: 'lark' } : { appId: DT_ID, appSecret: DT_SEGREDO };
  const r0 = await req(h, 'PUT', `/api/canais/${canal}/bot`, s, cred);
  assert.equal(r0.status, 200, JSON.stringify(r0.json));
  ctl.codigos.ABCD2345 = canal === 'feishu' ? { canal, user: FS_USER, nome: '李娜', chat: FS_CHAT } : { canal, user: DT_USER, nome: '王伟', chat: DT_CHAT };
  const r = await req(h, 'POST', `/api/canais/${canal}/parear`, s, { codigo: 'abcd-2345', password: SENHA });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const conversa = (canal = 'feishu') => h.db.get<{ conversation_id: string }>('SELECT conversation_id FROM canais_vinculos WHERE canal = ?', canal)?.conversation_id ?? null;
async function terminar(output: string): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.id)!.status === 'succeeded', 'a execução não terminou');
}


test('a tela: Feishu e DingTalk pedem o plugin da rc.45; o App ID e o App Secret vão ao motor (nunca ao banco nem à tela), com o Lark internacional', async () => {
  ctl.caps = ['conexoes', 'canais'];
  (h.canais.d as { capacidades: unknown }).capacidades = async () => ctl.caps;
  let e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.telegram.disponivel, true, 'o Telegram segue com o plugin de antes');
  assert.equal(e.feishu.disponivel, false); assert.equal(e.feishu.motivo, 'versao');
  assert.equal(e.dingtalk.disponivel, false);
  assert.equal((await req(h, 'PUT', '/api/canais/feishu/bot', s, { appId: FS_ID, appSecret: FS_SEGREDO })).status, 409, 'motor de antes: nem tenta');
  ctl.caps = ['conexoes', 'canais', 'canais_feishu_dingtalk'];
  e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.feishu.disponivel, true); assert.equal(e.dingtalk.disponivel, true);
  for (const ruim of [{ appId: 'abcdef', appSecret: FS_SEGREDO }, { appId: FS_ID, appSecret: 'curto-demais' }, { token: 'x'.repeat(20) }]) {
    const r = await req(h, 'PUT', '/api/canais/feishu/bot', s, ruim);
    assert.equal(r.status, 400, JSON.stringify(r.json)); assert.equal(r.json.error, 'formato_app');
  }
  assert.equal(ctl.bots.feishu, undefined, 'formato errado nem vai ao motor');
  e = (await req(h, 'PUT', '/api/canais/feishu/bot', s, { appId: FS_ID, appSecret: FS_SEGREDO, dominio: 'lark' })).json;
  assert.deepEqual(JSON.parse(ctl.bots.feishu!), { appId: FS_ID, appSecret: FS_SEGREDO, dominio: 'lark' }, 'o Lark (open.larksuite.com) vai junto');
  assert.equal(e.feishu.bot, true); assert.equal(e.feishu.conexao, 'conectado');
  (await req(h, 'PUT', '/api/canais/dingtalk/bot', s, { appId: DT_ID, appSecret: DT_SEGREDO, dominio: 'lark' }));
  assert.deepEqual(JSON.parse(ctl.bots.dingtalk!), { appId: DT_ID, appSecret: DT_SEGREDO }, 'o DingTalk não tem domínio');
  e = (await req(h, 'PUT', '/api/canais/feishu/bot', s, { appId: FS_ID, appSecret: FS_SEGREDO })).json;
  assert.equal(JSON.parse(ctl.bots.feishu!).dominio, 'feishu', 'sem escolha: o Feishu da China (open.feishu.cn)');
  const tela = JSON.stringify(e);
  assert.ok(!tela.includes(FS_SEGREDO) && !tela.includes(DT_SEGREDO), 'o App Secret não volta para a tela');
  const banco = h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => JSON.stringify(h.db.all(`SELECT * FROM "${t.name}"`))).join('');
  assert.ok(!banco.includes(FS_SEGREDO) && !banco.includes(DT_SEGREDO), 'o App Secret não fica no banco');
  // o pareamento com os ids de texto de cada plataforma (ou_…/oc_… no Feishu; $:LWCP…/cid… no DingTalk)
  ctl.codigos.ABCD2345 = { canal: 'feishu', user: FS_USER, nome: '李娜', chat: FS_CHAT };
  e = (await req(h, 'POST', '/api/canais/feishu/parear', s, { codigo: 'ABCD2345', password: SENHA })).json;
  assert.equal(e.feishu.ligado.nome, '李娜');
  ctl.codigos.WXYZ6789 = { canal: 'dingtalk', user: DT_USER, nome: '王伟', chat: DT_CHAT };
  e = (await req(h, 'POST', '/api/canais/dingtalk/parear', s, { codigo: 'WXYZ6789', password: SENHA })).json;
  assert.equal(e.dingtalk.ligado.nome, '王伟');
  const v = h.db.get<{ externo_id: string; chat_id: string }>("SELECT externo_id, chat_id FROM canais_vinculos WHERE canal = 'dingtalk'")!;
  assert.deepEqual([v.externo_id, v.chat_id], [DT_USER, DT_CHAT]);
  e = (await req(h, 'DELETE', '/api/canais/feishu', s)).json;
  assert.equal(ctl.bots.feishu, undefined); assert.equal(e.feishu.ligado, null); assert.equal(e.dingtalk.ligado.nome, '王伟');
});

test('a mensagem em chinês pelo Feishu vira pedido na conversa "Feishu/Lark" com o coordenador, com o idioma da pessoa; a resposta volta pelo gateway', async () => {
  recebidos.length = 0;
  assert.equal((await req(h, 'PUT', '/api/me/prefs', s, { lang: 'zh-CN' })).json.lang, 'zh-CN');
  await ligar('feishu');
  const fora = await entrada({ tipo: 'mensagem', user_id: 'ou_' + 'f'.repeat(32), chat_id: 'oc_x123', message_id: 'om_1', text: '你好' });
  assert.equal(fora.json.reply, RESPOSTA.semVinculo);
  const r = await entrada({ tipo: 'mensagem', user_id: FS_USER, chat_id: FS_CHAT, user_name: '李娜', message_id: 'om_' + 'a'.repeat(30), text: '请整理第四季度的销售报告', sent_at: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.digitando, true);
  const conv = conversa('feishu')!;
  const c = h.db.get<{ title: string; agent_id: string }>('SELECT title, agent_id FROM conversations WHERE id = ?', conv)!;
  assert.equal(c.title, 'Feishu/Lark'); assert.equal(c.agent_id, coordinatorFor(h.db, s.workspaceId));
  const msgs = h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid', conv);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === '请整理第四季度的销售报告'));
  assert.ok(msgs.some((m) => m.role === 'system' && m.content.startsWith('系统 — 来自 Feishu/Lark 账户“李娜”的第一条消息')), 'a nota da primeira mensagem no idioma de quem ligou');
  await ate(() => motor.pedidos.length === 1, 'o pedido não foi à equipe');
  const instr = motor.pedidos[0].instructions ?? '';
  assert.ok(instr.includes(notaCanal('feishu')), 'o agente sabe que a conversa é pelo Feishu');
  assert.match(instr, /Idioma: a pessoa usa o Ergon em chinês simplificado/, 'e responde em chinês');
  const typ = await buscar();
  assert.ok(typ.some((i) => i.tipo === 'digitando' && i.canal === 'feishu' && i.chat_id === FS_CHAT));
  await terminar('第四季度销售额同比增长 18.5%。');
  const resp = await ateSair((x) => x.tipo === 'texto' && /18\.5%/.test(x.texto), 'a resposta não saiu');
  assert.equal(resp.canal, 'feishu'); assert.equal(resp.chat_id, FS_CHAT); assert.equal(resp.user_id, FS_USER);
});

test('cartão no Feishu e no DingTalk: sem botões, a decisão é no app (no idioma da pessoa); clique forjado não decide; DingTalk sem imagem', async () => {
  recebidos.length = 0;
  await req(h, 'PUT', '/api/me/prefs', s, { lang: 'zh-CN' });
  await ligar('dingtalk');
  await entrada({ canal: 'dingtalk', tipo: 'mensagem', user_id: DT_USER, chat_id: DT_CHAT, message_id: 'msg1', text: '创建 商务 部门' });
  await ate(() => motor.pedidos.length === 1);
  await terminar('可以创建这个部门吗？\n\n```ergon-visual\n{"tipo":"kpis","titulo":"销售","itens":[{"rotulo":"销售额","valor":1200,"formato":"inteiro"}]}\n```');
  await ateSair((x) => x.tipo === 'texto' && x.canal === 'dingtalk', 'a resposta não saiu');
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversa('dingtalk')!, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
  const cartao = await ateSair((x) => x.tipo === 'cartao' && x.canal === 'dingtalk', 'o cartão não saiu');
  assert.deepEqual(cartao.botoes ?? [], [], 'sem botões');
  assert.ok(cartao.texto.includes(msg('zh-CN', 'canal.decidaNoApp')), cartao.texto);
  assert.ok(!recebidos.some((x) => x.tipo === 'imagem' && x.canal === 'dingtalk'), 'o DingTalk não recebe a imagem do visual');
  const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'sector_new' AND workspace_id = ?", s.workspaceId)!.id;
  const r = await entrada({ canal: 'dingtalk', tipo: 'clique', user_id: DT_USER, chat_id: DT_CHAT, dado: `a:${pid}`, evento: 'e1' });
  assert.equal(r.json.reply, RESPOSTA.noErgon);
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed', 'o clique forjado não decide');
  // decidido no app: o cartão ganha a linha final (o Feishu edita; o DingTalk recebe a edição e o plugin manda de novo)
  const ap = await req(h, 'POST', `/api/proposals/${pid}`, s, { decision: 'apply' });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const edit = await ateSair((x) => x.tipo === 'editar' && x.canal === 'dingtalk', 'o cartão não ficou com a linha final');
  assert.equal(edit.message_id, `msg-${cartao.id}`);
});
