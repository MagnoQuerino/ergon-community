/**
 * Cartões pedidos pelo agente por uma ferramenta do motor (rc.27): perguntar de volta, pedido seguro de chave e senha de
 * administrador. O motor é falso e fica "rodando" para a ponte reconhecer a sessão; a ponte de controle é falsa e guarda o
 * que recebeu (é o cofre do motor).
 *
 * O ponto central: o valor de uma chave ou senha NUNCA fica no Ergon — nem no banco (aberto ou no arquivo), nem na
 * conversa, no histórico, na auditoria ou nas respostas das rotas. O valor de teste é montado por partes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ChavesGuardadas, HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { SEM_CONSULTA_MS, SENHA_ESPERA_MS } from '../src/services/cartoes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-cartoes-0123456789';
const SEGREDO = ['ghp', 'Zx9', 'Qw7Lm2', 'Vt5Rk8Nb'].join('_');
const SENHA = ['S3nh4', 'de', 'adm1n', 'x9'].join('-');

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  entradas: StartRun[] = [];
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_cartao${String(++this.n).padStart(6, '0')}`;
    this.entradas.push(p);
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_cartoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}
/** A ponte de controle do motor: o cofre dele. Guarda o que recebeu para o teste conferir. */
class Cofre {
  guardadas = new Map<string, { valor: string; motivo: string }>();
  sudo: string | null = null;
  falhar: number | null = null;
  async health() { return true; }
  async accounts() { return []; }
  async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: ['ergon_cartoes'], safe: ['ergon_cartoes'] }; }
  async setApiToolsets(e: string[]) { return e; }
  async chavesGuardadas(): Promise<ChavesGuardadas> {
    return { sudo: !!this.sudo, chaves: [...this.guardadas].map(([nome, v]) => ({ nome, motivo: v.motivo, quando: '2026-11-10T10:00:00Z', agente: 'Aspásia' })) };
  }
  async guardarChave(c: { nome: string; valor: string; motivo?: string; sudo?: boolean }) {
    if (this.falhar) throw Object.assign(new Error('recusado'), { status: this.falhar });
    if (c.sudo) this.sudo = c.valor; else this.guardadas.set(c.nome, { valor: c.valor, motivo: c.motivo ?? '' });
  }
  async apagarChave(nome: string) {
    if (nome === 'SUDO_PASSWORD') { const tinha = !!this.sudo; this.sudo = null; return tinha; }
    return this.guardadas.delete(nome);
  }
}

let h: Harness; let s: Session; let agente: string; let motor: Motor; let cofre: Cofre;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const novo = () => crypto.randomBytes(16).toString('hex');
const ponte = async (rota: string, corpo: Record<string, unknown>) => (await req(h, 'POST', `/internal/bridge/v1/${rota}`, null, corpo, { 'x-ergon-bridge-token': TOKEN })).json as Record<string, any>;

async function preparar(control: Cofre | null = new Cofre()): Promise<void> {
  motor = new Motor();
  cofre = control ?? new Cofre();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: control as unknown as HermesControlClient | null });
  s = await setupOwner(h);
  agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, 'aspasia')!.id;
}
beforeEach(() => preparar());
afterEach(() => h.close());

async function pedir(texto: string): Promise<{ sessao: string; run: string; conv: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conv.id)!;
  return { sessao: r.hermes_session_id, run: r.id, conv: conv.id };
}
async function cardNaFila(titulo: string): Promise<{ task: string; number: number; sessao: string; run: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>("SELECT id, hermes_session_id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)!;
  return { task: t.id, number: t.number, sessao: r.hermes_session_id, run: r.id };
}
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
const propostas = async (conv: string) => (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ id: string; kind: string; summary: string; status: string; result: string | null; payload: string | null }>;
const mensagens = (conv: string) => h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conv);
const pergunta = (sessao: string, pedido: string, perguntas: Array<{ pergunta: string; opcoes?: string[]; varias?: boolean }>) =>
  ponte('cartao', { pedido, tipo: 'pergunta', session_id: sessao, perguntas: perguntas.map((q, i) => ({ qid: `q${i}`, ...q })) });

/** O valor não está em nenhuma linha de nenhuma tabela (lidas abertas, como o Ergon lê) nem em nenhum arquivo da pasta de dados. */
function ondeEsta(valor: string): string[] {
  const achados: string[] = [];
  for (const t of h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    for (const linha of h.db.all<Record<string, unknown>>(`SELECT * FROM "${t.name}"`)) {
      if (JSON.stringify(linha).includes(valor)) achados.push(`tabela ${t.name}`);
    }
  }
  const varrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (fs.readFileSync(p).includes(valor)) achados.push(`arquivo ${path.relative(h.dir, p)}`);
    }
  };
  varrer(h.dir);
  return [...new Set(achados)];
}

describe('perguntar de volta: a pergunta do agente vira cartão e a resposta volta no mesmo trabalho', () => {
  test('a ferramenta abre o cartão, espera consultando e recebe a resposta sem nova mensagem na conversa', async () => {
    const { sessao, conv, run } = await pedir('prepare a capa do relatório');
    const pedido = novo();
    assert.deepEqual(await pergunta(sessao, pedido, [{ pergunta: 'Qual cor uso na capa?', opcoes: ['Azul', 'Verde'] }]), { estado: 'esperando' });
    const cards = (await propostas(conv)).filter((p) => p.kind === 'question');
    assert.equal(cards.length, 1, 'um cartão na conversa');
    assert.equal(cards[0].summary, 'Qual cor uso na capa?');
    assert.deepEqual(JSON.parse(cards[0].payload!).options, ['Azul', 'Verde'], 'com as opções');
    assert.equal((await req(h, 'GET', '/api/decisions', s)).json.proposals.some((p: { id: string }) => p.id === cards[0].id), true, 'e em "Aguardando você"');
    assert.equal((await ponte('cartao/estado', { pedido })).estado, 'esperando');
    assert.equal((await pergunta(sessao, pedido, [{ pergunta: 'Qual cor uso na capa?', opcoes: ['Azul', 'Verde'] }])).estado, 'esperando', 'o mesmo pedido de novo não abre outro cartão');
    assert.equal((await propostas(conv)).filter((p) => p.kind === 'question').length, 1);

    const antes = mensagens(conv).length;
    const r = (await req(h, 'POST', `/api/proposals/${cards[0].id}/answer`, s, { answer: 'Azul' })).json;
    assert.deepEqual(r, { sent: false, entregue: 'agora' }, 'a ferramenta ainda espera: a resposta vai por ela');
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', respostas: { q0: 'Azul' } });
    assert.equal(mensagens(conv).length, antes, 'nenhuma mensagem nova: o agente continua o mesmo trabalho');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?', conv)!.n, 1, 'nem execução nova');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', run)!.status, 'running');
    assert.equal((await req(h, 'POST', `/api/proposals/${cards[0].id}/answer`, s, { answer: 'Verde' })).status, 409, 'já respondida');
    const aud = h.db.all<{ action: string; result: string }>("SELECT action, result FROM audit_events WHERE action LIKE 'cartao.%' OR action = 'question.answer'");
    assert.deepEqual(aud.map((a) => a.action), ['cartao.pergunta.pedido', 'question.answer']);
  });

  test('várias perguntas e várias opções: a resposta só segue com todas respondidas', async () => {
    const { sessao, conv } = await pedir('organize o evento');
    const pedido = novo();
    await pergunta(sessao, pedido, [{ pergunta: 'Quais dias?', opcoes: ['Segunda', 'Terça', 'Quarta'], varias: true }, { pergunta: 'Para quantas pessoas?' }]);
    const cards = (await propostas(conv)).filter((p) => p.kind === 'question').reverse();
    assert.equal(cards.length, 2);
    assert.equal(JSON.parse(cards.find((c) => c.summary === 'Quais dias?')!.payload!).multi, true);
    const dias = cards.find((c) => c.summary === 'Quais dias?')!; const quantas = cards.find((c) => c.summary !== 'Quais dias?')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${dias.id}/answer`, s, { answer: 'Segunda', answers: ['Segunda', 'Quarta'] })).json.entregue, 'falta');
    assert.equal((await ponte('cartao/estado', { pedido })).estado, 'esperando', 'falta uma');
    assert.equal((await req(h, 'POST', `/api/proposals/${quantas.id}/answer`, s, { answer: 'Umas quarenta' })).json.entregue, 'agora');
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', respostas: { q0: ['Segunda', 'Quarta'], q1: 'Umas quarenta' } });
  });

  test('a ferramenta parou de esperar: a resposta segue como continuação imediata, numa mensagem sua', async () => {
    const { sessao, conv, run } = await pedir('envie o relatório');
    const pedido = novo();
    await pergunta(sessao, pedido, [{ pergunta: 'Posso enviar hoje?', opcoes: ['Sim', 'Não'] }]);
    assert.equal((await ponte('cartao/estado', { pedido, desistir: true })).estado, 'esperando');
    await terminar(run, 'Aguardo a sua resposta.');
    const card = (await propostas(conv)).find((p) => p.kind === 'question')!;
    assert.equal(card.status, 'proposed', 'o cartão continua com a pessoa');
    const r = (await req(h, 'POST', `/api/proposals/${card.id}/answer`, s, { answer: 'Sim' })).json;
    assert.deepEqual(r, { sent: true, entregue: 'continuacao' });
    const ms = mensagens(conv);
    assert.equal(ms.at(-1)!.role, 'user');
    assert.equal(ms.at(-1)!.content, 'Minha resposta: Posso enviar hoje? → Sim');
    await tick();
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?', conv)!.n, 2, 'o agente retoma com a resposta');
    assert.equal((await ponte('cartao/estado', { pedido })).estado, 'cancelada', 'a ferramenta antiga não leva a resposta de novo');
  });

  test('a ferramenta caiu sem avisar (parou de consultar): a resposta também segue como continuação', async () => {
    const { sessao, conv } = await pedir('revise o texto');
    const pedido = novo();
    let agora = Date.now();
    h.cartoes.setClock(() => agora);
    await pergunta(sessao, pedido, [{ pergunta: 'Tom formal?', opcoes: ['Sim', 'Não'] }]);
    agora += SEM_CONSULTA_MS + 1000;
    const card = (await propostas(conv)).find((p) => p.kind === 'question')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/answer`, s, { answer: 'Sim' })).json.entregue, 'continuacao');
    assert.match(mensagens(conv).at(-1)!.content, /Tom formal\? → Sim/);
  });

  test('respondida, mas a execução terminou antes de a ferramenta levar: a resposta não se perde', async () => {
    const { sessao, conv, run } = await pedir('monte a agenda');
    const pedido = novo();
    await pergunta(sessao, pedido, [{ pergunta: 'Manhã ou tarde?', opcoes: ['Manhã', 'Tarde'] }]);
    const card = (await propostas(conv)).find((p) => p.kind === 'question')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/answer`, s, { answer: 'Tarde' })).json.entregue, 'agora');
    await terminar(run, 'Parei no meio.');
    assert.match(mensagens(conv).at(-1)!.content, /Manhã ou tarde\? → Tarde/, 'segue como continuação');
  });

  test('recusar o cartão: o agente fica sabendo', async () => {
    const { sessao, conv } = await pedir('escolha o fornecedor');
    const pedido = novo();
    await pergunta(sessao, pedido, [{ pergunta: 'Qual fornecedor?' }, { pergunta: 'Qual prazo?' }]);
    const card = (await propostas(conv)).find((p) => p.kind === 'question')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}`, s, { decision: 'apply' })).status, 400, 'aplicar não: responde-se pelo cartão');
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    assert.equal((await ponte('cartao/estado', { pedido })).estado, 'recusada');
    assert.ok((await propostas(conv)).filter((p) => p.kind === 'question').every((p) => p.status === 'rejected'), 'as perguntas da mesma rodada saem juntas');
  });

  test('num card da equipe (sem conversa): o cartão aparece no card e em "Aguardando você", e a resposta volta', async () => {
    const c = await cardNaFila('Montar a proposta comercial');
    const pedido = novo();
    assert.equal((await ponte('cartao', { pedido, tipo: 'pergunta', session_id: c.sessao, perguntas: [{ qid: 'q0', pergunta: 'Qual desconto máximo?', opcoes: ['5%', '10%'] }] })).estado, 'esperando');
    const det = (await req(h, 'GET', `/api/tasks/${c.task}`, s)).json;
    assert.equal(det.cartoes.length, 1);
    assert.equal(det.cartoes[0].summary, 'Qual desconto máximo?');
    const dec = (await req(h, 'GET', '/api/decisions', s)).json.proposals.find((p: { id: string }) => p.id === det.cartoes[0].id);
    assert.equal(dec.task_number, c.number, '"Aguardando você" diz de qual card é');
    assert.equal((await req(h, 'POST', `/api/proposals/${det.cartoes[0].id}/answer`, s, { answer: '10%' })).json.entregue, 'agora');
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', respostas: { q0: '10%' } });
    assert.equal((await req(h, 'GET', `/api/tasks/${c.task}`, s)).json.cartoes.length, 0);
  });

  test('o tempo esperando a pessoa não conta no limite da execução', async () => {
    // sem as ferramentas que levam tempo (a pessoa tirou), o limite é o normal (180 s)
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'passos', 'saida', 'visao']), agente);
    const { sessao, run } = await pedir('faça a análise');
    const pedido = novo();
    let agora = Date.now();
    h.cartoes.setClock(() => agora);
    await pergunta(sessao, pedido, [{ pergunta: 'Qual período?' }]);
    for (let i = 0; i < 30; i++) { agora += 10_000; await ponte('cartao/estado', { pedido }); }
    assert.equal(h.cartoes.esperaMs(run), 300_000, 'cinco minutos esperando');
    // a execução começou "há 6 minutos" (o limite é 180 s): sem a espera, pararia; com ela, segue
    h.db.run('UPDATE runs SET started_at = ? WHERE id = ?', new Date(Date.now() - 360_000).toISOString(), run);
    await tick();
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', run)!.status, 'running');
    h.db.run('UPDATE runs SET started_at = ? WHERE id = ?', new Date(Date.now() - 600_000).toISOString(), run);
    await tick();
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', run)!.status, 'failed', 'além da espera, o limite vale');
  });

  test('fora de um trabalho em andamento, ou com o token errado: nada', async () => {
    assert.equal((await pergunta('sessao-que-nao-existe', novo(), [{ pergunta: 'Oi?' }])).estado, 'falhou');
    const { sessao, run } = await pedir('oi');
    await terminar(run, 'Olá.');
    assert.equal((await pergunta(sessao, novo(), [{ pergunta: 'Oi?' }])).estado, 'falhou', 'execução já terminada');
    assert.equal((await req(h, 'POST', '/internal/bridge/v1/cartao', null, { pedido: novo(), tipo: 'pergunta' }, { 'x-ergon-bridge-token': 'errado' })).status, 401);
    assert.equal((await ponte('cartao/estado', { pedido: novo() })).estado, 'falhou');
  });

  test('os ganchos de espera humana do motor chegam (sem conteúdo)', async () => {
    assert.deepEqual(await ponte('espera', { fase: 'pedido', kind: 'clarify', request_id: 'abc', session_id: 'x' }), { ok: true });
    await ponte('espera', { fase: 'resolvido', kind: 'clarify', request_id: 'abc', outcome: 'submitted' });
    assert.deepEqual(h.cartoes.esperas.map((e) => [e.fase, e.kind, e.outcome]), [['pedido', 'clarify', ''], ['resolvido', 'clarify', 'submitted']]);
  });
});

describe('pedido seguro de chave: o valor vai direto ao cofre da equipe e não fica no Ergon', () => {
  test('o cartão protegido, o valor no cofre do motor, o agente só com o nome — e o valor em lugar nenhum do Ergon', async () => {
    const { sessao, conv } = await pedir('consulte os meus repositórios');
    const pedido = novo();
    assert.deepEqual(await ponte('cartao', { pedido, tipo: 'chave', session_id: sessao, nome: 'GITHUB_TOKEN', motivo: 'ler os seus repositórios no GitHub' }), { estado: 'esperando' });
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal(card.status, 'proposed');
    assert.deepEqual(JSON.parse(card.payload!), { kind: 'segredo', tipo: 'chave', nome: 'GITHUB_TOKEN', motivo: 'ler os seus repositórios no GitHub', agente: 'Aspásia', pedido });
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}`, s, { decision: 'apply' })).status, 400, 'não se aplica como proposta comum');

    const r = await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO });
    assert.deepEqual(r.json, { ok: true, entregue: 'agora', nome: 'GITHUB_TOKEN' });
    assert.deepEqual(cofre.guardadas.get('GITHUB_TOKEN'), { valor: SEGREDO, motivo: 'ler os seus repositórios no GitHub' }, 'o valor chegou ao cofre do motor');
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida' }, 'a ferramenta recebe só que foi respondida');
    const depois = (await propostas(conv)).find((p) => p.id === card.id)!;
    assert.equal(depois.status, 'applied');
    assert.equal(depois.result, 'guardada como GITHUB_TOKEN');
    assert.deepEqual(ondeEsta(SEGREDO), [], 'o valor não está em nenhuma tabela nem arquivo do Ergon');
    assert.ok(!JSON.stringify(mensagens(conv)).includes(SEGREDO));
    const aud = h.db.all<{ action: string; result: string; evidence: string | null }>("SELECT action, result, evidence FROM audit_events WHERE action LIKE 'cartao.%' ORDER BY created_at, rowid");
    assert.deepEqual(aud.map((a) => [a.action, a.result]), [['cartao.chave.pedido', 'Aspásia pediu a chave GITHUB_TOKEN'], ['cartao.chave.resposta', 'chave guardada como GITHUB_TOKEN']]);
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO })).status, 409, 'já respondido');
  });

  test('a ferramenta parou de esperar: a continuação diz só o nome', async () => {
    const { sessao, conv, run } = await pedir('publique o site');
    const pedido = novo();
    await ponte('cartao', { pedido, tipo: 'chave', session_id: sessao, nome: 'NETLIFY_TOKEN', motivo: 'publicar o site' });
    await ponte('cartao/estado', { pedido, desistir: true });
    await terminar(run, 'Aguardo a chave.');
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO })).json.entregue, 'continuacao');
    const ultima = mensagens(conv).at(-1)!;
    assert.equal(ultima.role, 'user');
    assert.match(ultima.content, /Guardei a chave NETLIFY_TOKEN no cofre da equipe/);
    await tick();
    assert.ok(!JSON.stringify(motor.entradas).includes(SEGREDO), 'nada do valor vai ao agente');
    assert.deepEqual(ondeEsta(SEGREDO), []);
  });

  test('nome inválido, valor com quebra de linha, cofre fora: recusas claras, e o erro nunca repete o valor', async () => {
    const { sessao, conv } = await pedir('use a chave');
    assert.equal((await ponte('cartao', { pedido: novo(), tipo: 'chave', session_id: sessao, nome: 'nome minusculo', motivo: 'x' })).estado, 'falhou');
    const pedido = novo();
    await ponte('cartao', { pedido, tipo: 'chave', session_id: sessao, nome: 'CLIMA_TOKEN', motivo: 'ver a previsão' });
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: `${SEGREDO}\nOUTRA=1` })).status, 400);
    cofre.falhar = 503;
    const r = await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO });
    assert.equal(r.status, 503);
    assert.ok(!JSON.stringify(r.json).includes(SEGREDO));
    assert.equal((await propostas(conv)).find((p) => p.id === card.id)!.status, 'proposed', 'o cartão continua aberto para tentar de novo');
    cofre.falhar = 400;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO })).status, 400);
    cofre.falhar = null;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SEGREDO })).status, 200);
    assert.deepEqual(ondeEsta(SEGREDO), []);
  });

  test('motor sem o cofre (versão anterior ou desligado): o agente é avisado para não pedir a chave no texto', async () => {
    await h.close();
    await preparar(null);
    const { sessao, conv } = await pedir('use a chave');
    const r = await ponte('cartao', { pedido: novo(), tipo: 'chave', session_id: sessao, nome: 'CLIMA_TOKEN', motivo: 'ver a previsão' });
    assert.equal(r.estado, 'falhou');
    assert.match(r.texto, /Não peça a chave nem a senha no texto da conversa/);
    assert.equal((await propostas(conv)).filter((p) => p.kind === 'segredo').length, 0);
    assert.deepEqual((await req(h, 'GET', '/api/seguranca/chaves', s)).json, { disponivel: false, chaves: [], sudo: false });
  });

  test('Configurações › Segurança: lista só os nomes e apaga', async () => {
    cofre.guardadas.set('GITHUB_TOKEN', { valor: SEGREDO, motivo: 'ler os repositórios' });
    cofre.sudo = SENHA;
    const lista = await req(h, 'GET', '/api/seguranca/chaves', s);
    assert.deepEqual(lista.json, { disponivel: true, sudo: true, chaves: [{ nome: 'GITHUB_TOKEN', motivo: 'ler os repositórios', quando: '2026-11-10T10:00:00Z', agente: 'Aspásia' }] });
    assert.ok(!JSON.stringify(lista.json).includes(SEGREDO) && !JSON.stringify(lista.json).includes(SENHA));
    assert.deepEqual((await req(h, 'DELETE', '/api/seguranca/chaves/GITHUB_TOKEN', s)).json, { apagada: true });
    assert.deepEqual((await req(h, 'DELETE', '/api/seguranca/chaves/SUDO_PASSWORD', s)).json, { apagada: true });
    assert.equal((await req(h, 'DELETE', '/api/seguranca/chaves/nome-ruim', s)).status, 400);
    assert.deepEqual((await req(h, 'GET', '/api/seguranca/chaves', s)).json, { disponivel: true, sudo: false, chaves: [] });
    assert.equal((await req(h, 'GET', '/api/seguranca/chaves', null)).status, 401, 'só quem está na conta');
    const aud = h.db.all<{ result: string }>("SELECT result FROM audit_events WHERE action = 'cartao.chave.apagada' ORDER BY created_at, rowid").map((a) => a.result);
    assert.deepEqual(aud, ['chave GITHUB_TOKEN apagada do cofre da equipe', 'senha de administrador apagada do cofre da equipe']);
  });
});

describe('senha de administrador: só para o trabalho, ou guardada se a pessoa marcar', () => {
  beforeEach(() => { h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'terminal']), agente); });
  test('sem o Terminal liberado para o agente: nem abre o cartão', async () => {
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro']), agente);
    const { sessao, conv } = await pedir('instale as fontes');
    const r = await ponte('cartao', { pedido: novo(), tipo: 'sudo', session_id: sessao, motivo: 'instalar' });
    assert.equal(r.estado, 'falhou');
    assert.match(r.texto, /Terminal não está liberado/);
    assert.equal((await propostas(conv)).filter((p) => p.kind === 'segredo').length, 0);
  });

  test('só para este trabalho: fica na memória até a ferramenta buscar, uma vez; nunca no banco nem no cofre', async () => {
    const { sessao, conv } = await pedir('instale as fontes');
    const pedido = novo();
    assert.equal((await ponte('cartao', { pedido, tipo: 'sudo', session_id: sessao, motivo: 'instalar o pacote de fontes' })).estado, 'esperando');
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal(JSON.parse(card.payload!).tipo, 'sudo');
    assert.deepEqual((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SENHA })).json, { ok: true, entregue: 'agora', nome: 'SUDO_PASSWORD' });
    assert.equal(cofre.sudo, null, 'não foi para o cofre');
    assert.deepEqual(ondeEsta(SENHA), [], 'nem para o banco ou arquivo');
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', valor: SENHA }, 'a ferramenta leva a senha');
    assert.equal((await ponte('cartao/estado', { pedido })).valor, undefined, 'uma vez só');
    assert.equal((await propostas(conv)).find((p) => p.id === card.id)!.result, 'entregue só para este trabalho');
    assert.deepEqual(ondeEsta(SENHA), []);
  });

  test('senha com acentos: guardar no cofre é recusado (com o motivo); só para este trabalho, vale', async () => {
    const acentuada = ['s3nhá', 'çom', 'acênto'].join('-');
    const { sessao, conv } = await pedir('instale as fontes');
    const pedido = novo();
    await ponte('cartao', { pedido, tipo: 'sudo', session_id: sessao, motivo: 'instalar o pacote de fontes' });
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    const r = await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: acentuada, guardar: true });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.json), /só para este trabalho/);
    assert.ok(!JSON.stringify(r.json).includes(acentuada), 'o erro não repete o valor');
    assert.equal(cofre.sudo, null, 'nada foi ao cofre');
    assert.equal((await propostas(conv)).find((p) => p.id === card.id)!.status, 'proposed', 'o cartão continua aberto');
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: acentuada })).status, 200);
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', valor: acentuada });
    assert.deepEqual(ondeEsta(acentuada), []);
  });

  test('chave com acentos: recusada antes de ir ao cofre', async () => {
    const { sessao, conv } = await pedir('use a chave');
    await ponte('cartao', { pedido: novo(), tipo: 'chave', session_id: sessao, nome: 'CLIMA_TOKEN', motivo: 'ver a previsão' });
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: `${SEGREDO}é` })).status, 400);
    assert.equal(cofre.guardadas.size, 0);
  });

  test('guardar para a equipe: vai para o cofre do motor, e a ferramenta recebe só a confirmação', async () => {
    const { sessao, conv } = await pedir('atualize os pacotes');
    const pedido = novo();
    await ponte('cartao', { pedido, tipo: 'sudo', session_id: sessao, motivo: 'atualizar os pacotes toda semana' });
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SENHA, guardar: true });
    assert.equal(cofre.sudo, SENHA);
    assert.deepEqual(await ponte('cartao/estado', { pedido }), { estado: 'respondida', guardada: true });
    assert.deepEqual(ondeEsta(SENHA), []);
  });

  test('respondida depois que a ferramenta parou de esperar: o agente pede de novo e recebe na hora (até 15 minutos)', async () => {
    const { sessao, conv, run } = await pedir('instale o pacote');
    const pedido = novo();
    let agora = Date.now();
    h.cartoes.setClock(() => agora);
    await ponte('cartao', { pedido, tipo: 'sudo', session_id: sessao, motivo: 'instalar o pacote' });
    await ponte('cartao/estado', { pedido, desistir: true });
    await terminar(run, 'Aguardo a senha.');
    const card = (await propostas(conv)).find((p) => p.kind === 'segredo')!;
    assert.equal((await req(h, 'POST', `/api/proposals/${card.id}/segredo`, s, { valor: SENHA })).json.entregue, 'continuacao');
    assert.match(mensagens(conv).at(-1)!.content, /Chame pedir_senha_admin de novo/);
    assert.ok(!mensagens(conv).at(-1)!.content.includes(SENHA));
    await tick();
    const nova = h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conv)!.hermes_session_id;
    assert.deepEqual(await ponte('cartao', { pedido: novo(), tipo: 'sudo', session_id: nova, motivo: 'instalar o pacote' }), { estado: 'respondida', valor: SENHA }, 'sem outro cartão');
    assert.equal((await propostas(conv)).filter((p) => p.kind === 'segredo').length, 1);
    // outra vez: já foi levada
    assert.equal((await ponte('cartao', { pedido: novo(), tipo: 'sudo', session_id: nova, motivo: 'de novo' })).estado, 'esperando');
    // e a que ninguém buscou em 15 minutos some da memória
    const card2 = (await propostas(conv)).find((p) => p.kind === 'segredo' && p.status === 'proposed')!;
    const p2 = JSON.parse(card2.payload!).pedido as string;
    await ponte('cartao/estado', { pedido: p2, desistir: true });
    await req(h, 'POST', `/api/proposals/${card2.id}/segredo`, s, { valor: SENHA });
    agora += SENHA_ESPERA_MS + 1000;
    await tick();
    const ultima = h.db.get<{ hermes_session_id: string }>("SELECT hermes_session_id FROM runs WHERE conversation_id = ? AND status = 'running' ORDER BY created_at DESC, rowid DESC LIMIT 1", conv)!.hermes_session_id;
    assert.equal((await ponte('cartao', { pedido: novo(), tipo: 'sudo', session_id: ultima, motivo: 'tarde demais' })).estado, 'esperando', 'passou do prazo: pede de novo');
    assert.deepEqual(ondeEsta(SENHA), []);
  });
});
