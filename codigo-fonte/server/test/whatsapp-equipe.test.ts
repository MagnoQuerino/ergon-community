/**
 * "Número da equipe" no WhatsApp, com o Baileys e o motor falsos (sem rede e sem conta): um número pareado vira o canal da
 * equipe; só telefones liberados e confirmados por código falam com o coordenador (pelo mesmo caminho do Telegram e do
 * Discord), a resposta sai do número como mensagem comum, confirmações vão como opções numeradas, o que chegou com o
 * Ergon fechado ('append') entra com o aviso de atraso ou fica de fora depois de 24 h, e o eco do próprio número nunca
 * vira pedido.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { WA_RISKS_VERSION } from '../src/services/whatsapp.ts';
import { notaCanal } from '../src/services/canais/index.ts';
import { SO_A_EQUIPE, canalDoRemetente, normalizarTelefone, respostaNumerada, type WhatsAppEquipe } from '../src/services/canais/whatsapp.ts';
import { classificar } from '../src/services/canais/externo.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const SENHA = 'senha-local-123';
const EQUIPE = '5511900001111';
const ANA = '5511988880000';
const ANA_JID = `${ANA}@s.whatsapp.net`;
const BIA_JID = '5511977770000@s.whatsapp.net';
const ESTRANHO = '5521955554444@s.whatsapp.net';

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

/** Baileys falso: os mesmos eventos do real; o envio devolve o id pedido e, como o real (emitOwnEvents), o eco em 'append'. */
function fakeBaileys() {
  const bus = new EventEmitter();
  const enviadas: Array<{ jid: string; texto: string; id: string }> = [];
  const sock = {
    ev: { on: (n: string, f: (...a: unknown[]) => void) => bus.on(n, f), removeAllListeners: () => bus.removeAllListeners() },
    user: { id: `${EQUIPE}:4@s.whatsapp.net`, lid: '99887766@lid', name: 'Equipe' },
    end() {}, ws: { close() {} }, async logout() {},
    async groupMetadata() { return { subject: 'Grupo' }; },
    async sendMessage(jid: string, conteudo: { text: string }, opts: { messageId?: string } = {}) {
      const id = opts.messageId ?? `MSG${enviadas.length + 1}`;
      enviadas.push({ jid, texto: conteudo.text, id });
      const msg = { key: { remoteJid: jid, fromMe: true, id }, message: { conversation: conteudo.text }, messageTimestamp: Math.floor(Date.now() / 1000) };
      process.nextTick(() => bus.emit('messages.upsert', { type: 'append', messages: [msg] }));
      return msg;
    },
  };
  const mod = {
    makeWASocket: () => sock, DisconnectReason: { loggedOut: 401 },
    BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v }, initAuthCreds: () => ({ me: null }), proto: { Message: { AppStateSyncKeyData: { fromObject: (x: unknown) => x } } },
  };
  return { bus, sock, mod, enviadas };
}

let h: Harness; let s: Session; let motor: Motor; let fake: ReturnType<typeof fakeBaileys>; let eq: WhatsAppEquipe;
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (pred()) return; await h.executor.tick().catch(() => undefined); await wait(15); }
  assert.fail(msg);
}
let seq = 0;
/** Uma mensagem chegando ao número da equipe (`segundosAtras`: escrita há tanto tempo; 'append' = guardada com o Ergon fechado). */
async function recebe(jid: string, texto: string, o: { tipo?: 'notify' | 'append'; segundosAtras?: number; extra?: Record<string, unknown>; fromMe?: boolean; id?: string } = {}): Promise<string> {
  const id = o.id ?? `IN${++seq}`;
  fake.bus.emit('messages.upsert', { type: o.tipo ?? 'notify', messages: [{
    key: { remoteJid: jid, id, fromMe: !!o.fromMe }, pushName: 'Ana', message: o.extra ?? { conversation: texto },
    messageTimestamp: Math.floor(Date.now() / 1000) - (o.segundosAtras ?? 0),
  }] });
  await wait(30);
  return id;
}
const paraAna = () => fake.enviadas.filter((e) => e.jid === ANA_JID);
const conversaDaAna = () => h.db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM canais_vinculos WHERE canal = ?', canalDoRemetente(s.workspaceId, '', ANA))?.conversation_id ?? null;
const pedidosDaAna = () => { const c = conversaDaAna(); return c ? h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid", c).map((m) => m.content) : []; };
async function terminar(output: string): Promise<void> {
  const r = h.db.get<{ id: string; hermes_run_id: string }>('SELECT id, hermes_run_id FROM runs WHERE hermes_run_id IS NOT NULL ORDER BY rowid DESC LIMIT 1')!;
  motor.runs.set(r.hermes_run_id, { status: 'completed', output, error: null, sessionId: `sessao-${r.hermes_run_id}`, usage: null, model: 'nous/teste-1' });
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', r.id)!.status === 'succeeded', 'a execução não terminou');
}
const equipe = (body: Record<string, unknown>) => req(h, 'PUT', '/api/integrations/whatsapp/equipe', s, body);
async function liberarAna(): Promise<string> {
  assert.equal((await equipe({ ligado: true })).status, 200);
  const r = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes', s, { telefone: '+55 (11) 98888-0000', password: SENHA });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json.remetentes.find((x: { telefone: string }) => x.telefone === `+${ANA}`);
  assert.equal(p.estado, 'pendente'); assert.match(p.codigo, /^ERGON [A-Z2-9]{6}$/);
  assert.equal(p.link, `https://wa.me/${EQUIPE}?text=${encodeURIComponent(p.codigo)}`);
  return p.codigo;
}
async function anaConfirmada(): Promise<void> {
  const codigo = await liberarAna();
  await recebe(ANA_JID, codigo);
  await ate(() => paraAna().some((e) => /^Pronto: este WhatsApp agora conversa com a equipe/.test(e.texto)), 'a confirmação não respondeu');
}

beforeEach(async () => {
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
  h.canais.ajustes = { avisosMs: 60, atrasoMs: 10, digitandoMs: 5000, esperaMaxMs: 300, arrendamentoMs: 200 };
  s = await setupOwner(h);
  eq = h.whatsapp.equipe as WhatsAppEquipe;
  eq.ajustes = { ...eq.ajustes, avisoAtrasoMs: 30 };
  setIntegration(h.db, s.workspaceId, 'whatsapp', { state: 'connected', account_label: 'Equipe', settings: { cards: false, numero: EQUIPE, riscos: { versao: WA_RISKS_VERSION } } });
  fake = fakeBaileys();
  h.whatsapp.loader = async () => fake.mod;
  h.whatsapp.qrLoader = async () => ({ toDataURL: async () => 'data:image/png;base64,QR' });
  await h.whatsapp.start(s.workspaceId, null);
  fake.bus.emit('connection.update', { connection: 'open' });
  await wait();
  h.canais.start();
});
afterEach(async () => { h.canais.stop(); await h.close(); });

test('funções puras: resposta numerada e telefone', () => {
  assert.deepEqual(respostaNumerada('1'), { opcao: 1, pedido: null });
  assert.deepEqual(respostaNumerada(' 2 #3. '), { opcao: 2, pedido: 3 });
  assert.deepEqual(respostaNumerada('Aprovar pedido 4'), { opcao: 1, pedido: 4 });
  assert.deepEqual(respostaNumerada('recuso'), { opcao: 2, pedido: null });
  assert.equal(respostaNumerada('1 reunião amanhã'), null);
  assert.equal(respostaNumerada('12'), null);
  assert.equal(normalizarTelefone('+55 (11) 98888-0000'), ANA);
  assert.equal(normalizarTelefone('ana'), null);
});

test('desligado: nada acontece (nem conversa, nem resposta); a leitura de sempre segue', async () => {
  await recebe(ANA_JID, 'Prepare o relatório');
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canais_vinculos')!.n, 0);
  assert.equal(fake.enviadas.length, 0);
  assert.equal(motor.pedidos.length, 0);
  const e = (await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json;
  assert.equal(e.disponivel, true); assert.equal(e.ligado, false); assert.equal(e.numero, `+${EQUIPE}`);
});

test('sem os riscos aceitos, não liga', async () => {
  setIntegration(h.db, s.workspaceId, 'whatsapp', { settings: { numero: EQUIPE } });
  const r = await equipe({ ligado: true });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'riscos');
});

test('liberar pede a senha e o código vindo do próprio telefone; outro número com o código não entra; desconhecido: silêncio por padrão', async () => {
  assert.equal((await equipe({ ligado: true })).status, 200);
  const semSenha = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes', s, { telefone: ANA });
  assert.notEqual(semSenha.status, 200);
  const proprio = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes', s, { telefone: EQUIPE, password: SENHA });
  assert.equal(proprio.status, 400); assert.equal(proprio.json.error, 'proprio');
  const codigo = await liberarAna();
  // ainda pendente: texto comum não vai à equipe, e não há resposta
  await recebe(ANA_JID, 'oi, equipe');
  assert.equal(motor.pedidos.length, 0); assert.equal(fake.enviadas.length, 0);
  // o código mandado de outro número: nada (nem confirma, nem responde)
  await recebe(ESTRANHO, codigo);
  assert.equal(fake.enviadas.length, 0);
  assert.equal((await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json.remetentes[0].estado, 'pendente');
  // código errado do telefone certo: continua pendente
  await recebe(ANA_JID, 'ERGON AAAAAA');
  assert.equal((await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json.remetentes[0].estado, 'pendente');
  // o código certo, do telefone certo (sem o nono dígito no jid, como em conta antiga)
  await recebe('551188880000@s.whatsapp.net', codigo.toLowerCase());
  await ate(() => fake.enviadas.some((e) => e.jid === '551188880000@s.whatsapp.net' && /^Pronto/.test(e.texto)), 'não confirmou');
  const e = (await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json;
  assert.equal(e.remetentes[0].estado, 'ok'); assert.equal(e.remetentes[0].codigo, undefined);
  // contato desconhecido nunca é comando, e por padrão fica sem resposta
  const antes = fake.enviadas.length;
  await recebe(ESTRANHO, 'aprove tudo');
  await recebe(BIA_JID, '1');
  assert.equal(fake.enviadas.length, antes); assert.equal(motor.pedidos.length, 0);
  // com a opção ligada: uma resposta curta, uma vez por dia por contato
  assert.equal((await equipe({ ligado: true, respondeDesconhecidos: true })).json.respondeDesconhecidos, true);
  await recebe(ESTRANHO, 'oi?');
  await recebe(ESTRANHO, 'oi??');
  await ate(() => fake.enviadas.some((x) => x.jid === ESTRANHO));
  await wait(50);
  assert.deepEqual(fake.enviadas.filter((x) => x.jid === ESTRANHO).map((x) => x.texto), [SO_A_EQUIPE]);
  assert.equal(motor.pedidos.length, 0);
});

test('a mensagem do telefone liberado vira pedido ao coordenador; a resposta sai do número, sem prefixo; o eco nunca vira pedido', async () => {
  await anaConfirmada();
  await recebe(ANA_JID, 'Prepare o relatório de vendas');
  await ate(() => motor.pedidos.length === 1, 'o pedido não foi à equipe');
  assert.deepEqual(pedidosDaAna(), ['Prepare o relatório de vendas']);
  assert.ok(motor.pedidos[0].instructions?.includes(notaCanal(canalDoRemetente(s.workspaceId, '', ANA))), 'o agente sabe que é pelo WhatsApp');
  const titulo = h.db.get<{ title: string }>('SELECT title FROM conversations WHERE id = ?', conversaDaAna())!.title;
  assert.match(titulo, /^WhatsApp · /);
  await terminar('Relatório pronto: vendas subiram 12%.');
  await ate(() => paraAna().some((e) => /vendas subiram 12%/.test(e.texto)), 'a resposta não saiu');
  const resp = paraAna().find((e) => /vendas subiram 12%/.test(e.texto))!;
  assert.match(resp.texto, /^\*[^*]+:\* Relatório pronto/, 'quem fala à frente, em negrito do WhatsApp');
  assert.ok(!/Ergon:/.test(resp.texto), 'sem prefixo: quem manda é o próprio número da equipe');
  // os ecos ('append', fromMe) já passaram pelo leitor: nada virou pedido; o mesmo id de novo, nem que viesse como de fora
  await wait(50);
  assert.equal(motor.pedidos.length, 1);
  await recebe(ANA_JID, resp.texto, { id: resp.id, tipo: 'append' });
  await recebe(ANA_JID, 'mensagem minha no próprio número', { fromMe: true });
  assert.deepEqual(pedidosDaAna(), ['Prepare o relatório de vendas']);
  // a mesma mensagem entregue de novo (reconexão): não duplica
  await recebe(ANA_JID, 'Prepare o relatório de vendas', { id: 'IN-dup' });
  await recebe(ANA_JID, 'Prepare o relatório de vendas', { id: 'IN-dup', tipo: 'append' });
  assert.equal(pedidosDaAna().length, 2);
});

test('confirmações vão como opções numeradas; "1" aprova, "2 N" recusa o pedido N, e com dois abertos o número sem pedido pergunta qual', async () => {
  await anaConfirmada();
  await recebe(ANA_JID, 'crie o setor Comercial');
  await ate(() => motor.pedidos.length === 1);
  await terminar('Posso criar o setor?');
  await ate(() => paraAna().some((e) => /Posso criar/.test(e.texto)));
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversaDaAna()!, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
  await ate(() => paraAna().some((e) => /^\*Pedido 1:\*/.test(e.texto)), 'o cartão não saiu');
  const cartao = paraAna().find((e) => /^\*Pedido 1:\*/.test(e.texto))!;
  assert.match(cartao.texto, /Precisa de você/); assert.match(cartao.texto, /\*1\* Aprovar · \*2\* Recusar/);
  const pid1 = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'sector_new' ORDER BY rowid DESC LIMIT 1")!.id;
  await recebe(ANA_JID, '1');
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid1)?.status === 'applied', '"1" não aprovou');
  await ate(() => paraAna().some((e) => /^\*Pedido 1:\* .*Aprovado/.test(e.texto)), 'sem a linha final');
  assert.equal(motor.pedidos.length, 1, 'a resposta numerada não vai à equipe como pedido');
  // dois abertos
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversaDaAna()!, runId: null }, [{ kind: 'sector_new', name: 'Jurídico', description: 'x' }]);
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conversaDaAna()!, runId: null }, [{ kind: 'sector_new', name: 'Compras', description: 'y' }]);
  await ate(() => paraAna().some((e) => /^\*Pedido 3:\*/.test(e.texto)), 'os cartões não saíram');
  await recebe(ANA_JID, '2');
  await ate(() => paraAna().some((e) => /^Há 2 pedidos abertos \(2, 3\)/.test(e.texto)), 'não perguntou qual');
  const [p2, p3] = h.db.all<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'sector_new' ORDER BY rowid DESC LIMIT 2").map((r) => r.id).reverse();
  await recebe(ANA_JID, '2 3');
  await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', p3)?.status === 'rejected', '"2 3" não recusou');
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', p2)!.status, 'proposed');
  await recebe(ANA_JID, '1 9');
  await ate(() => paraAna().some((e) => /O pedido 9 não está aberto/.test(e.texto)));
});

test('com o Ergon fechado: o que chegou ("append") entra com o aviso de atraso; mais de 24 h fica de fora, e a pessoa fica sabendo', async () => {
  await anaConfirmada();
  // a confirmação foi agora: para o teste, ela vale desde ontem e meio
  h.db.run('UPDATE canais_wa_remetentes SET desde_ts = ?', Math.floor(Date.now() / 1000) - 40 * 3600);
  await recebe(ANA_JID, 'Isto é de anteontem', { tipo: 'append', segundosAtras: 30 * 3600 });
  await recebe(ANA_JID, 'Marque a reunião para amanhã', { tipo: 'append', segundosAtras: 3 * 3600 });
  await ate(() => motor.pedidos.length === 1, 'o atrasado não foi à equipe');
  assert.deepEqual(pedidosDaAna(), ['Marque a reunião para amanhã']);
  assert.match(motor.pedidos[0].instructions ?? '', /Pedido enviado pelo WhatsApp em .* entregue agora com atraso/);
  await ate(() => paraAna().some((e) => /O Ergon estava fechado: a sua mensagem de .* chegou à equipe só agora\. Uma mensagem de mais de 24 h ficou de fora/.test(e.texto)), 'sem o aviso de atraso');
  // de antes de liberar: nunca
  h.db.run('UPDATE canais_wa_remetentes SET desde_ts = ?', Math.floor(Date.now() / 1000) - 60);
  await recebe(ANA_JID, 'antigo', { tipo: 'append', segundosAtras: 3600 });
  assert.equal(pedidosDaAna().length, 1);
});

test('limite de envio: o que passa do limite espera a vez, sem se perder', async () => {
  await anaConfirmada();
  eq.ajustes = { ...eq.ajustes, saidaPorMinuto: 1 };
  (eq as unknown as { saidas: Map<string, number[]> }).saidas.clear();
  const canal = canalDoRemetente(s.workspaceId, '', ANA);
  h.canais.avisarLocal(h.db.get<{ user_id: string }>('SELECT user_id FROM canais_vinculos')!.user_id, canal, 'aviso um');
  h.canais.avisarLocal(h.db.get<{ user_id: string }>('SELECT user_id FROM canais_vinculos')!.user_id, canal, 'aviso dois');
  await ate(() => paraAna().some((e) => e.texto === 'aviso um'));
  await wait(100);
  assert.ok(!paraAna().some((e) => e.texto === 'aviso dois'), 'o segundo espera');
  assert.equal(h.db.get<{ status: string }>("SELECT status FROM canais_saida WHERE canal = ? ORDER BY rowid DESC LIMIT 1", canal)!.status, 'pending');
});

test('desligar tira os telefones: a mensagem seguinte não vai a lugar nenhum', async () => {
  await anaConfirmada();
  assert.equal((await equipe({ ligado: false })).json.ligado, false);
  const antes = fake.enviadas.length;
  await recebe(ANA_JID, 'ainda funciona?');
  assert.equal(motor.pedidos.length, 0); assert.equal(fake.enviadas.length, antes);
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canais_vinculos')!.n, 0);
});

// ------------------------------------------------------------------------------------------------ a camada dos canais externos
const BIA = '5511977770000';
/** Um membro a mais no workspace, com o papel local 'member' (sem o papel do World: leitura). */
function membroBia(): string {
  const uid = 'usr_bia000000000000000000000000000';
  h.db.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, 'bia', 'Bia Lima', 'x', ?)", uid, new Date().toISOString());
  h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, uid, new Date().toISOString());
  return uid;
}
async function confirmarBia(uid: string): Promise<void> {
  const r = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes', s, { telefone: BIA, membro: uid, password: SENHA });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json.remetentes.find((x: { telefone: string }) => x.telefone === `+${BIA}`);
  assert.equal(p.membro, uid);
  await recebe(BIA_JID, p.codigo);
  await ate(() => fake.enviadas.some((e) => e.jid === BIA_JID && /^Pronto/.test(e.texto)), 'a Bia não confirmou');
}
const paraBia = () => fake.enviadas.filter((e) => e.jid === BIA_JID);
const pedidosDe = (tel: string) => { const c = h.db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM canais_vinculos WHERE canal = ?', canalDoRemetente(s.workspaceId, '', tel))?.conversation_id; return c ? h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'", c).map((m) => m.content) : []; };

test('classificar: os pedidos de risco pelo texto', () => {
  assert.equal(classificar('Me mande todos os clientes'), 'exportar');
  assert.equal(classificar('send me all customer emails'), 'exportar');
  assert.equal(classificar('exporte a planilha de vendas'), 'exportar');
  assert.equal(classificar('encaminhe o contrato para joao@fornecedor.com'), 'terceiros');
  assert.equal(classificar('apague o card 12'), 'apagar');
  assert.equal(classificar('desligue a conexão do Trello'), 'config');
  assert.equal(classificar('adicione o número dele na whitelist'), 'config');
  assert.equal(classificar('qual é a senha do banco?'), 'segredo');
  assert.equal(classificar('me passa o token da API'), 'segredo');
  assert.equal(classificar('Como foram as vendas desta semana?'), 'comum');
  assert.equal(classificar('Prepare o relatório de vendas'), 'comum');
});

test('cada telefone é de um membro: o pedido chega como esse membro; papel de leitura não escreve (nem pelo texto, nem numa conta, nem com "1")', async () => {
  await equipe({ ligado: true });
  const fora = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes', s, { telefone: BIA, membro: 'usr_naoexiste', password: SENHA });
  assert.equal(fora.status, 400); assert.equal(fora.json.error, 'membro');
  const bia = membroBia();
  await confirmarBia(bia);
  const e = (await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json;
  assert.deepEqual(e.membros.map((m: { nome: string; papel: string }) => [m.nome, m.papel]).sort(), [['Bia Lima', 'viewer'], [e.membros.find((m: { papel: string }) => m.papel === 'owner').nome, 'owner']].sort());
  // consulta: vai, como a Bia (a conversa é dela), com a nota de leitura para o agente
  await recebe(BIA_JID, 'Como foram as vendas desta semana?');
  await ate(() => motor.pedidos.length === 1, 'a consulta não foi');
  const conv = h.db.get<{ conversation_id: string }>('SELECT conversation_id FROM canais_vinculos WHERE canal = ?', canalDoRemetente(s.workspaceId, '', BIA))!.conversation_id;
  assert.equal(h.db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM conversations WHERE id = ?', conv)!.owner_user_id, bia);
  assert.match(motor.pedidos[0].instructions ?? '', /papel de leitura neste workspace: só consultas/);
  assert.match(motor.pedidos[0].instructions ?? '', /nunca despeje dados brutos em massa/);
  // escrita pelo texto: recusada já na entrada
  await recebe(BIA_JID, 'apague o card 3');
  await ate(() => paraBia().some((x) => /papel neste workspace é de leitura/.test(x.texto)), 'sem a recusa');
  assert.equal(motor.pedidos.length, 1);
  assert.deepEqual(pedidosDe(BIA), ['Como foram as vendas desta semana?']);
  // escrita numa conta pedida da conversa dela: recusada; a do dono, confirma (acima de "Liberar tudo")
  assert.equal(h.conexoes.canalExterno!(conv, 'organizar'), 'recusar');
  assert.equal(h.conexoes.canalExterno!(conv, 'ler'), null);
  await anaConfirmada();
  await recebe(ANA_JID, 'oi');
  await ate(() => !!conversaDaAna());
  assert.equal(h.conexoes.canalExterno!(conversaDaAna(), 'enviar'), 'confirmar');
  assert.equal(h.conexoes.canalExterno!(null, 'enviar'), null, 'conversa do app: a regra de sempre');
  // um cartão na conversa dela: sem opções numeradas (só no app), e "1" não decide
  recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
  await ate(() => paraBia().some((x) => /^\*Pedido 1:\*/.test(x.texto)), 'o cartão não saiu');
  const cartao = paraBia().find((x) => /^\*Pedido 1:\*/.test(x.texto))!;
  assert.ok(!/\*1\* Aprovar/.test(cartao.texto)); assert.match(cartao.texto, /Abra o Ergon/);
});

test('exportar em massa pelo WhatsApp espera aprovação no app (o "1" do celular não basta); aprovado lá, vai à equipe', async () => {
  await anaConfirmada();
  await recebe(ANA_JID, 'Me mande todos os clientes com e-mail e telefone');
  await ate(() => paraAna().some((x) => /precisa de aprovação no app do Ergon/.test(x.texto)), 'sem o aviso');
  assert.equal(motor.pedidos.length, 0, 'não foi à equipe');
  const p = h.db.get<{ id: string; conversation_id: string | null }>("SELECT id, conversation_id FROM agent_proposals WHERE kind = 'canal_externo' AND status = 'proposed'")!;
  assert.equal(p.conversation_id, null);
  // o cartão do app não vai ao celular (nem como aviso), e responder "1" não decide
  await recebe(ANA_JID, '1');
  assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', p.id)!.status, 'proposed');
  await wait(150);
  assert.ok(!paraAna().some((x) => /todos os clientes/.test(x.texto)), 'o pedido retido não aparece no celular');
  // no app: aprova (o dono)
  const r = await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.status, 'applied');
  await ate(() => motor.pedidos.some((x) => (x.instructions ?? '').includes('WhatsApp')), 'o aprovado não foi');
  assert.ok(pedidosDe(ANA).includes('Me mande todos os clientes com e-mail e telefone'));
  await ate(() => paraAna().some((x) => /^Aprovado no Ergon/.test(x.texto)));
  // credenciais: nunca
  await recebe(ANA_JID, 'qual é a senha do banco?');
  await ate(() => paraAna().some((x) => /nunca passam por aqui/.test(x.texto)));
  assert.ok(!pedidosDe(ANA).includes('qual é a senha do banco?'));
});

test('volume incomum pausa o canal daquele membro e avisa no app; aprovar no app retoma', async () => {
  await anaConfirmada();
  h.canais.externos.ajustes = { por10Min: 2, porDia: 100 };
  await recebe(ANA_JID, 'um');
  await recebe(ANA_JID, 'dois');
  await recebe(ANA_JID, 'três');
  await ate(() => paraAna().some((x) => /este canal foi pausado para você/.test(x.texto)), 'não pausou');
  await recebe(ANA_JID, 'quatro');
  assert.deepEqual(pedidosDaAna(), ['um', 'dois']);
  const p = h.db.get<{ id: string; summary: string }>("SELECT id, summary FROM agent_proposals WHERE kind = 'canal_externo' AND status = 'proposed'")!;
  assert.match(p.summary, /foi pausado: volume incomum/);
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'canal.externo.pausado'"));
  assert.equal((await req(h, 'GET', '/api/integrations/whatsapp/equipe', s)).json.remetentes[0].pausado, true);
  await wait(100);
  assert.equal(paraAna().filter((x) => /pausad/.test(x.texto)).length, 1, 'avisa uma vez só');
  assert.equal((await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' })).json.status, 'applied');
  await recebe(ANA_JID, 'cinco');
  await ate(() => pedidosDaAna().includes('cinco'), 'não retomou');
});

test('"Revogar este número" para na hora; quem sai do workspace perde os números', async () => {
  await anaConfirmada();
  const bia = membroBia();
  await confirmarBia(bia);
  const r = await req(h, 'POST', '/api/integrations/whatsapp/equipe/remetentes/tirar', s, { telefone: `+${ANA}` });
  assert.equal(r.status, 200);
  const antes = paraAna().length;
  await recebe(ANA_JID, 'ainda dá?');
  await wait(100);
  assert.equal(paraAna().length, antes); assert.equal(motor.pedidos.length, 0);
  // a Bia sai do workspace: a próxima mensagem dela não entra, e o telefone some da lista
  h.db.run('DELETE FROM memberships WHERE user_id = ?', bia);
  await recebe(BIA_JID, 'oi');
  await wait(100);
  assert.equal(motor.pedidos.length, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canais_wa_remetentes WHERE user_id = ?', bia)!.n, 0);
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canais_vinculos WHERE user_id = ?', bia)!.n, 0);
});

test('auditoria: cada pedido por canal externo fica no registro com membro, canal e categoria (sem o texto)', async () => {
  await anaConfirmada();
  await recebe(ANA_JID, 'Prepare o relatório de vendas');
  await recebe(ANA_JID, 'apague o card 3');
  await ate(() => h.db.all("SELECT 1 AS x FROM audit_events WHERE action = 'canal.externo.pedido'").length === 2, 'sem o registro');
  const regs = h.db.all<{ actor_id: string; target_id: string; evidence: string }>("SELECT actor_id, target_id, evidence FROM audit_events WHERE action = 'canal.externo.pedido' ORDER BY rowid");
  assert.ok(regs.every((x) => x.actor_id === s.userId && x.target_id === 'whatsapp'));
  assert.deepEqual(regs.map((x) => JSON.parse(x.evidence).categoria), ['comum', 'apagar']);
  assert.deepEqual(regs.map((x) => JSON.parse(x.evidence).resultado), ['entregue', 'espera aprovação no app']);
  assert.ok(!regs.some((x) => x.evidence.includes('relatório')), 'o texto não vai ao registro');
});
