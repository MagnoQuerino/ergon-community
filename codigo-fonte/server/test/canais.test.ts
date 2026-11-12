/**
 * Conversar com a equipe pelo Telegram e pelo Discord, com o motor e o gateway falsos: a ponte de controle (o código do bot
 * e o pareamento), a entrada (a mensagem vira mensagem da pessoa na conversa do canal com o coordenador, pelo mesmo
 * caminho do app), a saída com espera longa (respostas, cartões com Aprovar/Recusar, a linha final, os avisos de "Com
 * você"), o clique que decide pela mesma função da tela, o pedido atrasado e quem não está ligado. O plugin de verdade
 * (com o Hermes) é conferido em hermes/tests/test_ergon_bridge_canais.py.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CanalNoMotor, HermesClient, HermesControlClient, ModelOptions, NomeCanal, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { CanalErro } from '../src/services/hermes.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { coordinatorFor } from '../src/services/team-query.ts';
import { RESPOSTA, notaCanal } from '../src/services/canais/index.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = ['token-da-ponte', 'de-teste', '0123456789'].join('-');
const SENHA = 'senha-local-123';
const TG = '1234567890' + ':' + 'AA' + 'b'.repeat(33);
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
  caps = ['conexoes', 'canais'];
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
    return { telegram: um('telegram'), discord: um('discord') };
  }
  async setCanal(c: NomeCanal, t: string) { this.bots[c] = t; delete this.pareados[c]; }
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
const entrada = (b: Record<string, unknown>) => req(h, 'POST', '/internal/bridge/v1/canais/entrada', null, { schema: 'ergon.canais.v1', canal: 'telegram', ...b }, PONTE);
const recebidos: Array<Record<string, any>> = [];
async function buscar(acks: Array<Record<string, unknown>> = [], espera = 0): Promise<Array<Record<string, any>>> {
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: ['telegram', 'discord'], acks, espera }, PONTE);
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
async function ligar(): Promise<void> {
  assert.equal((await req(h, 'PUT', '/api/canais/telegram/bot', s, { token: TG })).status, 200);
  ctl.codigos.ABCD2345 = { canal: 'telegram', user: '111222333', nome: 'Ana', chat: '111222333' };
  const r = await req(h, 'POST', '/api/canais/telegram/parear', s, { codigo: 'abcd-2345', password: SENHA });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const conversa = () => h.db.get<{ conversation_id: string }>("SELECT conversation_id FROM canais_vinculos WHERE canal = 'telegram'")?.conversation_id ?? null;
async function terminar(output: string): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.id)!.status === 'succeeded', 'a execução não terminou');
}

test('a tela: sem a capacidade do motor, não está disponível; com ela, guarda o código do bot no motor (nunca no banco) e liga pelo código', async () => {
  recebidos.length = 0;
  ctl.caps = ['conexoes'];
  let e = (await req(h, 'GET', '/api/canais', s)).json;
  assert.equal(e.telegram.disponivel, false); assert.equal(e.telegram.motivo, 'versao');
  ctl.caps = ['conexoes', 'canais'];
  (h.canais.d as { capacidades: unknown }).capacidades = async () => ctl.caps; // sem o cache de 60 s
  const ruim = await req(h, 'PUT', '/api/canais/telegram/bot', s, { token: 'isto-nao-e-um-codigo' });
  assert.equal(ruim.status, 400); assert.equal(ruim.json.error, 'formato');
  assert.equal(ctl.bots.telegram, undefined, 'formato errado nem vai ao motor');
  e = (await req(h, 'PUT', '/api/canais/telegram/bot', s, { token: TG })).json;
  assert.equal(ctl.bots.telegram, TG);
  assert.equal(e.telegram.bot, true); assert.equal(e.telegram.conexao, 'conectado'); assert.equal(e.telegram.ligado, null);
  assert.ok(!JSON.stringify(e).includes(TG.split(':')[1]), 'o código do bot não volta para a tela');
  const banco = h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => JSON.stringify(h.db.all(`SELECT * FROM "${t.name}"`))).join('');
  assert.ok(!banco.includes(TG.split(':')[1]), 'o código do bot não fica no banco');
  // confirmar o código pede a senha (é como cadastrar um aparelho novo que manda na equipe)
  ctl.codigos.ABCD2345 = { canal: 'telegram', user: '111222333', nome: 'Ana', chat: '111222333' };
  const semSenha = await req(h, 'POST', '/api/canais/telegram/parear', s, { codigo: 'ABCD2345' });
  assert.notEqual(semSenha.status, 200);
  const errado = await req(h, 'POST', '/api/canais/telegram/parear', s, { codigo: 'ZZZZ9999', password: SENHA });
  assert.equal(errado.status, 400); assert.equal(errado.json.error, 'codigo');
  e = (await req(h, 'POST', '/api/canais/telegram/parear', s, { codigo: 'abcd 2345', password: SENHA })).json;
  assert.equal(e.telegram.ligado.nome, 'Ana'); assert.equal(e.telegram.ligado.avisos, true, 'avisos ligados por padrão');
  assert.equal(e.discord.ligado, null);
  // desligar: o motor apaga o código do bot; a ligação some daqui
  e = (await req(h, 'DELETE', '/api/canais/telegram', s)).json;
  assert.equal(ctl.bots.telegram, undefined); assert.equal(e.telegram.ligado, null); assert.equal(e.telegram.bot, false);
});

test('a mensagem pelo Telegram vira pedido na conversa "Telegram" com o coordenador; a resposta volta pelo gateway', async () => {
  recebidos.length = 0;
  await ligar();
  const fora = await entrada({ tipo: 'mensagem', user_id: '999', chat_id: '999', message_id: '1', text: 'oi' });
  assert.equal(fora.json.reply, RESPOSTA.semVinculo, 'quem não está ligado neste Ergon recebe o aviso');
  const r = await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', user_name: 'Ana', message_id: '42', text: 'Prepare o relatório de vendas', sent_at: new Date().toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.digitando, true); assert.equal(r.json.reply, undefined);
  const conv = conversa();
  assert.ok(conv, 'a conversa do canal existe');
  const c = h.db.get<{ title: string; agent_id: string }>('SELECT title, agent_id FROM conversations WHERE id = ?', conv)!;
  assert.equal(c.title, 'Telegram');
  assert.equal(c.agent_id, coordinatorFor(h.db, s.workspaceId), 'com o coordenador');
  const msgs = h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid', conv);
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === 'Prepare o relatório de vendas'), 'mensagem da pessoa');
  assert.ok(msgs.some((m) => m.role === 'system' && m.content.includes('primeira mensagem pela conta do Telegram')), 'a primeira mensagem fica à vista');
  // entregue de novo (o gateway reiniciou no meio): não duplica
  await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', message_id: '42', text: 'Prepare o relatório de vendas' });
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'user'", conv)!.n, 1);
  await ate(() => motor.pedidos.length === 1, 'o pedido não foi à equipe');
  assert.ok(motor.pedidos[0].instructions?.includes(notaCanal('telegram')), 'o agente sabe que a conversa é pelo Telegram');
  const typ = await buscar();
  assert.ok(typ.some((i) => i.tipo === 'digitando' && i.chat_id === '111222333'), '"digitando" enquanto a equipe trabalha');
  await terminar('Relatório pronto: vendas subiram 12%.');
  const resp = await ateSair((x) => x.tipo === 'texto' && /vendas subiram 12%/.test(x.texto), 'a resposta não saiu');
  assert.match(resp.texto, /^\*\*.+:\*\* Relatório pronto/); assert.equal(resp.chat_id, '111222333'); assert.equal(resp.user_id, '111222333');
  // anexo sem texto: aviso honesto
  assert.equal((await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', message_id: '43', text: '', anexos: 1 })).json.reply, RESPOSTA.soTexto);
});

test('pedido que esperou com o Ergon fechado (Telegram entrega depois) chega com a nota de atraso para o agente', async () => {
  await ligar();
  await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', message_id: '7', text: 'Marque a reunião para amanhã', sent_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
  await ate(() => motor.pedidos.length === 1);
  assert.match(motor.pedidos[0].instructions ?? '', /Pedido enviado pelo Telegram em .* entregue agora com atraso/);
});

test('confirmação na conversa do canal vira cartão com Aprovar/Recusar; o botão decide pela mesma função e o cartão fica com a linha final', async () => {
  recebidos.length = 0;
  await ligar();
  await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', message_id: '1', text: 'crie o setor Comercial' });
  await ate(() => motor.pedidos.length === 1);
  await terminar('Posso criar o setor?');
  await ateSair((x) => x.tipo === 'texto', 'a resposta não saiu');
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversa()!, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
  const cartao = await ateSair((x) => x.tipo === 'cartao', 'o cartão não saiu');
  assert.match(cartao.texto, /Precisa de você/);
  assert.deepEqual(cartao.botoes.map((b: string[]) => b[0]), ['Aprovar', 'Recusar']);
  const pid = String(cartao.botoes[0][1]).slice(2);
  assert.ok(cartao.botoes.every((b: string[]) => Buffer.byteLength('erg:' + b[1]) <= 64), 'cabe no limite de 64 bytes do Telegram');
  const decididas: string[] = [];
  const original = h.canais.d.decidir;
  (h.canais.d as { decidir: unknown }).decidir = async (ws: string, u: string, p: string, d: 'apply' | 'reject') => { decididas.push(`${p}:${d}`); return original(ws, u, p, d); };
  // clique de outra conta do Telegram: nada
  assert.equal((await entrada({ tipo: 'clique', user_id: '999', chat_id: '999', dado: cartao.botoes[0][1], evento: 'e0' })).json.reply, RESPOSTA.semVinculo);
  const r = await entrada({ tipo: 'clique', user_id: '111222333', chat_id: '111222333', dado: cartao.botoes[0][1], evento: 'e1', message_id: `msg-${cartao.id}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)?.status === 'applied', 'Aprovar no Telegram não aplicou');
  assert.deepEqual(decididas, [`${pid}:apply`]);
  const edit = await ateSair((x) => x.tipo === 'editar', 'o cartão não ficou com a linha final');
  assert.equal(edit.message_id, `msg-${cartao.id}`); assert.match(edit.texto, /Aprovado por você às/);
  // clicar de novo não decide outra vez
  const de_novo = await entrada({ tipo: 'clique', user_id: '111222333', chat_id: '111222333', dado: cartao.botoes[1][1], evento: 'e2' });
  assert.equal(de_novo.json.reply, RESPOSTA.jaDecidido); assert.equal(decididas.length, 1);
});

test('pedido de chave ou senha na conversa do canal: aviso sem botões (o valor só se digita no Ergon); clique forjado não decide', async () => {
  recebidos.length = 0;
  await ligar();
  await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', message_id: '1', text: 'use a minha chave do clima' });
  await ate(() => motor.pedidos.length === 1);
  await terminar('Preciso da chave.');
  await ateSair((x) => x.tipo === 'texto', 'a resposta não saiu');
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversa()!, runId: null },
    [{ kind: 'segredo', tipo: 'chave', nome: 'CLIMA_TOKEN', motivo: 'ver a previsão', agente: 'Aspásia', pedido: 'a'.repeat(32) } as never]);
  const cartao = await ateSair((x) => x.tipo === 'cartao', 'o aviso não saiu');
  assert.deepEqual(cartao.botoes ?? [], [], 'sem Aprovar/Recusar');
  assert.match(cartao.texto, /Abra o Ergon para informar/);
  const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'segredo' AND workspace_id = ?", s.workspaceId)!.id;
  const r = await entrada({ tipo: 'clique', user_id: '111222333', chat_id: '111222333', dado: `a:${pid}`, evento: 'e9' });
  assert.equal(r.json.reply, RESPOSTA.noErgon);
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed');
});

test('"Com você" vai ao canal ligado (avisos ligados por padrão; desligáveis); o que sai fica na fila até o motor confirmar', async () => {
  recebidos.length = 0;
  await ligar();
  const app = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", s.workspaceId)!;
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: app.id })).json;
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv.id ?? conv.conversation?.id ?? null, runId: null }, [{ kind: 'sector_new', name: 'Jurídico', description: 'Contratos' }]);
  const aviso = await ateSair((x) => x.tipo === 'cartao' && /Precisa de você no Ergon/.test(x.texto), 'o aviso de "Com você" não foi ao Telegram');
  assert.equal(aviso.botoes.length, 2, 'decisão do app também com os botões');
  // sem confirmação do motor (caiu no meio), o item volta depois do prazo
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv.id ?? conv.conversation?.id ?? null, runId: null }, [{ kind: 'sector_new', name: 'Compras', description: 'x' }]);
  let levado: Record<string, any> | undefined;
  const fim = Date.now() + 5000;
  while (!levado && Date.now() < fim) { levado = (await buscar()).find((i) => i.tipo === 'cartao'); await new Promise((r) => setTimeout(r, 30)); }
  assert.ok(levado, 'o segundo aviso saiu');
  await new Promise((r) => setTimeout(r, 260));
  const outra = await buscar();
  assert.ok(outra.some((i) => i.id === levado!.id), 'sem confirmação, vai de novo');
  await buscar([{ id: levado!.id, ok: true, message_id: 'm2' }]);
  // avisos desligados: nada mais vai
  await req(h, 'PATCH', '/api/canais/telegram', s, { avisos: false });
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv.id ?? conv.conversation?.id ?? null, runId: null }, [{ kind: 'sector_new', name: 'TI', description: 'x' }]);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await buscar()).some((i) => /TI/.test(i.texto ?? '')), 'com os avisos desligados, não avisa');
});

test('a ponte interna dos canais exige o token do motor', async () => {
  const r = await req(h, 'POST', '/internal/bridge/v1/canais/saida', null, { schema: 'ergon.canais.v1', canais: ['telegram'] }, { 'x-ergon-bridge-token': 'x'.repeat(30) });
  assert.equal(r.status, 401);
});
