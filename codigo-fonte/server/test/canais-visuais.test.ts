// Blocos visuais nos canais (rc.42): a resposta do agente com visuais sai no Telegram e no Discord como texto (os números e
// a fonte) e como imagem (o PNG do bloco); a cerca é normalizada ao gravar a resposta (a que não passa vira JSON comum).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CanalNoMotor, CredencialCanal, HermesClient, HermesControlClient, ModelOptions, NomeCanal, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { CanalErro } from '../src/services/hermes.ts';
import { cercaVisual } from '../../shared/visuais/cercas.ts';
import { EXEMPLOS } from '../../shared/visuais/exemplos.ts';
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
    return { telegram: um('telegram'), discord: um('discord'), feishu: um('feishu'), dingtalk: um('dingtalk'), wecom: um('wecom'), weixin: um('weixin') };
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
async function terminar(output: string): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.id)!.status === 'succeeded', 'a execução não terminou');
}


test('resposta com visuais: o texto leva os números e a fonte, e cada bloco vai também como PNG; o bloco fora do formato fica como JSON comum', async () => {
  recebidos.length = 0;
  await ligar();
  await entrada({ tipo: 'mensagem', user_id: '111222333', chat_id: '111222333', user_name: 'Ana', message_id: '77', text: 'Como foram os gastos?', sent_at: new Date().toISOString() });
  await ate(() => motor.pedidos.length > 0, 'o pedido não foi ao motor');
  await terminar(`Fechei novembro.\n\n${cercaVisual(EXEMPLOS.barras)}\n\n\`\`\`ergon-visual\n{"tipo":"kpi","rotulo":"Sem fonte","valor":1}\n\`\`\``);
  const gravada = h.db.all<{ content: string }>("SELECT content FROM messages WHERE role = 'agent' ORDER BY rowid DESC LIMIT 1")[0].content;
  assert.match(gravada, /```ergon-barras\n\{"titulo":"Gastos por categoria"/);
  assert.match(gravada, /```json\n\{"tipo":"kpi","rotulo":"Sem fonte","valor":1\}\n```/, 'o bloco sem fonte não passa: fica como JSON comum');
  const texto = await ateSair((x) => x.tipo === 'texto' && /Fechei novembro/.test(x.texto ?? ''), 'o texto não saiu');
  assert.match(texto.texto, /• Folha: R\$ 9\.800/);
  assert.match(texto.texto, /Fonte: Nubank PJ/);
  assert.ok(!texto.texto.includes('ergon-'));
  const img = await ateSair((x) => x.tipo === 'imagem', 'a imagem não saiu');
  assert.equal(img.texto, 'Gastos por categoria');
  assert.equal(Buffer.from(img.png, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(recebidos.filter((x) => x.tipo === 'imagem').length, 1, 'só o bloco válido vira imagem');
});
