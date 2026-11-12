/**
 * A resposta à iniciativa do colega (relato de 12/11/2026): o colega com pendência puxa conversa ("Oi, Alexandre! Tem um
 * minutinho?"); a pessoa responde "oi, pode falar" e ele tem de seguir direto ao assunto que o fez chamar — não começar
 * do zero com "estou aqui para ajudar, o que precisa?". A abertura não passa pelo motor (é pronta, sem IA): a execução da
 * resposta recebe a própria abertura e o motivo dela (messages.motivo) com o estado de agora de cada card. Vale depois de
 * reinício, em "tentar de novo", na conversa que vai ao perfil do agente com sessão nova, com a pendência resolvida no
 * meio do caminho e em inglês.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, PedidoDePerfil, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { assuntoDeLeve } from '../src/services/initiative.ts';
import { nomeDoPerfil } from '../src/services/perfis.ts';
import { openerFor } from '../../shared/personalities.ts';
import { allAgents, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: Array<StartRun & { runId: string }> = [];
  runs = new Map<string, RemoteRun>();
  perfis = new Map<string, PedidoDePerfil>();
  fails = false;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    const runId = `run_inic${String(this.started.length + 1).padStart(6, '0')}`;
    this.started.push({ ...p, runId });
    this.runs.set(runId, this.fails ? { status: 'failed', output: null, error: 'o provedor demorou demais (teste)', sessionId: 's', usage: null, model: null }
      : { status: 'completed', output: 'Certo.', error: null, sessionId: `sess_${runId}`, usage: null, model: 'nous/teste-1' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
  control(perfis = false): HermesControlClient {
    const self = this;
    return {
      async health() { return true; },
      ...(perfis ? { async info() { return { ok: true, pluginVersion: '0.5.0', vaultConfig: 4, capacidades: ['conexoes', 'perfis', 'memoria', 'ajudantes'] }; } } : {}),
      async accounts() { return [{ id: 'nous', name: 'Nous Portal', connected: true, freeTier: false, tier: null, expiresAt: null }]; },
      async startLogin() { return { sessionId: 's', userCode: 'A', verificationUrl: 'https://auth.example', expiresAt: null, pollSeconds: 5 }; },
      async pollLogin() { return { status: 'approved', error: null, email: null, model: null }; },
      async cancelLogin() {}, async disconnect() {},
      async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; },
      async setDefaultModel() { return { ok: true, confirmMessage: null }; },
      async skills() { return []; },
      async apiToolsets() { return { enabled: [], safe: [] }; },
      async setApiToolsets(e: string[]) { return e; },
      ...(perfis ? { async perfil(nome: string, pedido: PedidoDePerfil) { const criado = !self.perfis.has(nome); self.perfis.set(nome, pedido); return { criado, mudou: criado ? ['criado'] : ['alma'] }; } } : {}),
    } as HermesControlClient;
  }
}

let n = 0;
const rid = () => `req-iniciativa-${String(++n).padStart(4, '0')}`;

/** Um card da Hipátia esperando uma informação da pessoa (com a pergunta), e a pessoa chegando depois de 5 h fora. */
async function pendenciaEChegada(h: Harness, s: Session, agentId: string, title: string, pergunta: string): Promise<{ taskId: string; number: number; conv: string; abertura: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title, agentId })).json as { id: string; number: number };
  h.db.run("UPDATE tasks SET work_state = 'aguardando_info' WHERE id = ?", t.id);
  h.db.run(`INSERT INTO task_results (id, workspace_id, task_id, run_id, kind, state, criteria, evidence, justification, decided_by, created_at)
            VALUES (?, ?, ?, NULL, 'informativo', 'aguardando_info', 'x', ?, 'falta uma informação', 'agente', ?)`,
    `tr_${String(++n).padStart(32, '0')}`, s.workspaceId, t.id, JSON.stringify({ pergunta }), new Date().toISOString());
  const ago = new Date(Date.now() - 5 * 3600_000).toISOString();
  h.db.run('INSERT INTO presence (workspace_id, user_id, last_seen_at) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at', s.workspaceId, s.userId, ago);
  assert.equal((await req(h, 'POST', '/api/presence', s)).json.arrived, true);
  const conv = h.db.get<{ conversation_id: string }>('SELECT conversation_id FROM nudges WHERE workspace_id = ? AND item_key = ?', s.workspaceId, `card:${t.id}`)!.conversation_id;
  const abertura = h.db.get<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'agent' ORDER BY created_at DESC, rowid DESC LIMIT 1", conv)!.content;
  return { taskId: t.id, number: t.number, conv, abertura };
}

const say = (h: Harness, s: Session, c: string, text: string) => req(h, 'POST', `/api/conversations/${c}/messages`, s, { text, clientRequestId: rid() });
/** O que foi ao motor na última execução desta conversa. */
const enviado = (motor: Motor, h: Harness, conv: string) => {
  const r = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE conversation_id = ? AND hermes_run_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', conv)!;
  return motor.started.find((p) => p.runId === r.hermes_run_id)!;
};

describe('resposta à iniciativa: o colega segue do assunto que o fez chamar', () => {
  let h: Harness; let s: Session; let motor: Motor; let hip: { id: string };

  before(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor, control: motor.control() });
    s = await setupOwner(h);
    hip = (await allAgents(h, s)).find((a: { char_key: string }) => a.char_key === 'hipatia');
  });
  after(async () => { await h.close(); });

  test('abertura com o assunto de leve, nas duas línguas', () => {
    assert.equal(assuntoDeLeve([{ title: 'Levantamento de concorrentes' }], 'pt'), 'É sobre “Levantamento de concorrentes”.');
    assert.equal(assuntoDeLeve([{ title: 'A' }, { title: 'B' }], 'pt'), 'É sobre “A” e mais uma coisa.');
    assert.equal(assuntoDeLeve([{ title: 'A' }, { title: 'B' }, { title: 'C' }], 'en'), 'It’s about “A” and 2 more things.');
    assert.equal(openerFor('conciso', 'Ana Souza', 10, 0, 'en'), 'Ana, got a minute?');
    assert.equal(openerFor('formal', 'Ana', 9, 0, 'en'), 'Good morning, Ana. Would you have a moment?');
    assert.equal(openerFor('formal', 'Ana', 9, 0), 'Bom dia, Ana. Teria um momento?', 'o português continua igual');
  });

  test('"oi, pode falar": a resposta recebe a abertura, o card e o que ele precisa — não um cumprimento novo', async () => {
    const p = await pendenciaEChegada(h, s, hip.id, 'Levantamento de concorrentes', 'Qual é a região que entra no levantamento?');
    assert.match(p.abertura, /Alexandre/);
    assert.match(p.abertura, /É sobre “Levantamento de concorrentes”\./, 'a abertura já sugere o assunto de leve');
    await drain(h, 3);
    assert.equal((await say(h, s, p.conv, 'oi, pode falar')).status, 201);
    await drain(h, 3);
    const run = enviado(motor, h, p.conv);
    assert.equal(run.input, 'oi, pode falar');
    assert.ok(run.instructions.includes(`com esta mensagem sua: “${p.abertura}”`), 'o colega sabe o que ele mesmo disse (a abertura não passou pelo motor)');
    assert.match(run.instructions, /não trate como um cumprimento novo, não pergunte o que ela precisa/);
    assert.ok(run.instructions.includes(`card #${p.number} “Levantamento de concorrentes”: precisa de uma informação: Qual é a região que entra no levantamento?`));
    assert.match(run.instructions, /idioma em que ela escreveu/);
    const props = (await req(h, 'GET', `/api/proposals?conversationId=${p.conv}`, s)).json as Array<{ kind: string; status: string }>;
    assert.ok(props.some((x) => x.kind === 'info_request' && x.status === 'proposed'), 'o cartão para responder ali mesmo');
    // a conversa seguiu: a próxima mensagem já não é a resposta ao chamado
    await say(h, s, p.conv, 'e o outro assunto?'); await drain(h, 3);
    assert.doesNotMatch(enviado(motor, h, p.conv).instructions, /Foi você quem puxou conversa/);
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', p.taskId);
  });

  test('pendência resolvida antes da resposta: o colega diz que já se resolveu, sem cobrar', async () => {
    const p = await pendenciaEChegada(h, s, hip.id, 'Planilha de fornecedores', 'Qual o prazo de entrega?');
    await drain(h, 3);
    // a pessoa respondeu pelo cartão (ou noutro lugar) e o card foi concluído enquanto isso
    h.db.run('UPDATE tasks SET completed = 1, completed_at = ? WHERE id = ?', new Date().toISOString(), p.taskId);
    await say(h, s, p.conv, 'oi, pode falar'); await drain(h, 3);
    const ins = enviado(motor, h, p.conv).instructions;
    assert.ok(ins.includes(`com esta mensagem sua: “${p.abertura}”`));
    assert.ok(ins.includes(`O que fez você chamar já se resolveu enquanto isso (fatos do sistema, de agora):\n- card #${p.number} “Planilha de fornecedores”: já foi concluído`));
    assert.match(ins, /que isso já se resolveu enquanto isso e que não precisa mais dela nisso: não cobre/);
    assert.doesNotMatch(ins, /Por que você chamou/);
    const props = h.db.all<{ payload: string }>("SELECT payload FROM agent_proposals WHERE workspace_id = ? AND kind = 'info_request'", s.workspaceId);
    assert.ok(!props.some((x) => x.payload.includes(p.taskId)), 'nada de cartão para o que já se resolveu');
  });

  test('"tentar de novo" depois de uma falha: a nova tentativa também leva o motivo', async () => {
    const p = await pendenciaEChegada(h, s, hip.id, 'Resumo do contrato', 'Qual versão do contrato vale?');
    await drain(h, 3);
    motor.fails = true;
    await say(h, s, p.conv, 'oi, tô aqui'); await drain(h, 3);
    motor.fails = false;
    assert.equal((await req(h, 'POST', `/api/conversations/${p.conv}/retry`, s)).status, 200);
    await drain(h, 3);
    const ins = enviado(motor, h, p.conv).instructions;
    assert.ok(ins.includes(`com esta mensagem sua: “${p.abertura}”`));
    assert.ok(ins.includes(`card #${p.number} “Resumo do contrato”: precisa de uma informação: Qual versão do contrato vale?`));
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', p.taskId);
  });

  test('em inglês: a abertura sai em inglês e a resposta segue o idioma da pessoa', async () => {
    h.db.run("UPDATE users SET lang = 'en' WHERE id = ?", s.userId);
    try {
      const p = await pendenciaEChegada(h, s, hip.id, 'Competitor survey', 'Which region goes into the survey?');
      assert.match(p.abertura, /Alexandre/);
      assert.match(p.abertura, /It’s about “Competitor survey”\.$/);
      assert.doesNotMatch(p.abertura, /minuto|Tem um|preciso/, 'nada de português para quem usa em inglês');
      await drain(h, 3);
      await say(h, s, p.conv, 'hi, go ahead'); await drain(h, 3);
      const ins = enviado(motor, h, p.conv).instructions;
      assert.ok(ins.includes(`com esta mensagem sua: “${p.abertura}”`));
      assert.ok(ins.includes('Which region goes into the survey?'));
      assert.match(ins, /no idioma em que ela escreveu/);
      h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', p.taskId);
    } finally { h.db.run("UPDATE users SET lang = 'pt-BR' WHERE id = ?", s.userId); }
  });

  test('reinício do servidor entre a abertura e a resposta: o motivo vem do banco', async () => {
    const p = await pendenciaEChegada(h, s, hip.id, 'Calendário de entregas', 'Qual o dia da primeira entrega?');
    await drain(h, 3);
    await h.close();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { dir: h.dir, hermes: motor, control: motor.control() });
    // outra fala pronta do colega depois da abertura (um aviso do sistema em nome dele) não esconde o chamado
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', 'Aviso qualquer.', 'local', ?)",
      `msg_${'a'.repeat(32)}`, s.workspaceId, p.conv, new Date().toISOString());
    await say(h, s, p.conv, 'oi, pode falar'); await drain(h, 3);
    const ins = enviado(motor, h, p.conv).instructions;
    assert.ok(ins.includes(`com esta mensagem sua: “${p.abertura}”`));
    assert.ok(ins.includes(`card #${p.number} “Calendário de entregas”: precisa de uma informação: Qual o dia da primeira entrega?`));
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', p.taskId);
  });

  test('abertura de antes do motivo guardado (vinda da rc.26): as pendências daquele chamado valem', async () => {
    const p = await pendenciaEChegada(h, s, hip.id, 'Lista de clientes', 'De qual cidade?');
    await drain(h, 3);
    h.db.run('UPDATE messages SET motivo = NULL WHERE conversation_id = ?', p.conv);
    await say(h, s, p.conv, 'fala'); await drain(h, 3);
    const ins = enviado(motor, h, p.conv).instructions;
    assert.ok(ins.includes(`com esta mensagem sua: “${p.abertura}”`));
    assert.ok(ins.includes(`card #${p.number} “Lista de clientes”: precisa de uma informação: De qual cidade?`), 'a pergunta de agora, pelo card');
    h.db.run('UPDATE tasks SET archived = 1 WHERE id = ?', p.taskId);
  });
});

describe('resposta à iniciativa na conversa que vai ao perfil do agente (sessão nova no motor)', () => {
  test('a execução vai ao perfil da Hipátia, numa sessão que nunca viu a abertura, e leva o motivo', async () => {
    const motor = new Motor();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-' + '0123456789' }, { hermes: motor, control: motor.control(true) });
    try {
      const s = await setupOwner(h);
      const hip = (await allAgents(h, s)).find((a: { char_key: string }) => a.char_key === 'hipatia');
      await h.perfis.emDia(s.workspaceId, 100);
      assert.ok(h.perfis.perfilPronto(s.workspaceId, hip.id));
      const p = await pendenciaEChegada(h, s, hip.id, 'Pesquisa de preços', 'Qual o teto de preço?');
      await drain(h, 3);
      assert.equal(h.db.get('SELECT 1 AS x FROM runs WHERE conversation_id = ?', p.conv), undefined, 'a abertura não passou pelo motor: a sessão desta conversa nem existe');
      await say(h, s, p.conv, 'oi, pode falar'); await drain(h, 3);
      const run = enviado(motor, h, p.conv);
      assert.equal(run.profile, nomeDoPerfil(s.workspaceId, hip.id), 'no perfil do agente');
      assert.ok(run.instructions.includes(`com esta mensagem sua: “${p.abertura}”`));
      assert.ok(run.instructions.includes(`card #${p.number} “Pesquisa de preços”: precisa de uma informação: Qual o teto de preço?`));
    } finally { await h.close(); }
  });
});
