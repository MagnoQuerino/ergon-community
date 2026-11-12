import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import { ORDEM_ECONOMIA, ORDEM_PARA_COMECAR, porFaixa } from '../src/services/ai.ts';
import { HttpHermesControl, parseAuxModels, rotaDoPerfil, type AuxModels, type HermesClient, type HermesControlClient, type ModelOptions, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness } from './helpers.ts';

/**
 * Modelos por tarefa (rc.27): o modelo de cada tarefa de apoio do motor (todas as que ele devolver, inclusive as de
 * complementos) e o dos ajudantes temporários, pela ponte; "usar o principal" por padrão; a conta de onde sai o custo;
 * a sugestão de economia, que só diz o que mudaria; e o motor de antes, que ainda não tem o recurso.
 */
const OPUS = 'anthropic/claude-opus-5.5'; const FLASH = 'deepseek/deepseek-v4.1-flash-1017'; const QWEN = 'qwen/qwen3-max';
const MINI = 'google/gemini-mini'; const GRATIS = 'meta/llama-free:free';

class Motor implements HermesClient {
  padrao: { provider: string; model: string } | null = { provider: 'nous', model: OPUS };
  modelos = [OPUS, FLASH, QWEN, MINI, GRATIS];
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(_p: StartRun) { return { runId: 'run_x', replayed: false }; }
  async getRun(): Promise<RemoteRun> { return { status: 'completed', output: 'ok', error: null, sessionId: 's', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, model: 'x' }; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> {
    const precos: Record<string, { input: string; output: string; free?: boolean }> = {
      [OPUS]: { input: '$4.00', output: '$20.00' }, [FLASH]: { input: '$0.20', output: '$0.80' }, [QWEN]: { input: '$1.20', output: '$6.00' },
      [MINI]: { input: '$0.30', output: '$1.00' }, [GRATIS]: { input: '$0', output: '$0', free: true },
    };
    return { model: this.padrao?.model ?? null, provider: this.padrao?.provider ?? null, providers: [
      { slug: 'nous', name: 'Nous Portal', current: true, authenticated: true, models: this.modelos, pricing: Object.fromEntries(this.modelos.map((m) => [m, precos[m]])) },
      { slug: 'openai-codex', name: 'ChatGPT', current: false, authenticated: true, models: ['gpt-6-codex'], pricing: {} },
    ] } as ModelOptions;
  }
}

const TAREFAS = ['vision', 'compression', 'skills_hub', 'approval', 'mcp', 'title_generation', 'review', 'voice_chat', 'triage_specifier', 'kanban_decomposer', 'profile_describer', 'curator'];

class Controle implements HermesControlClient {
  motor: Motor;
  constructor(motor: Motor) { this.motor = motor; }
  gratuito = false; antigo = false; caro: string | null = null;
  aux = new Map<string, { provider: string; model: string }>();
  ajudantes: { provider: string | null; model: string | null } = { provider: null, model: null };
  veImagens = new Map<string, boolean>([[MINI, true], [FLASH, false]]);
  chamadas: string[] = []; principalGravado: string[] = [];
  async health() { return true; }
  async accounts() { return [{ id: 'nous', name: 'Nous Portal', connected: true, freeTier: this.gratuito, tier: null, expiresAt: null }, { id: 'openai-codex', name: 'ChatGPT', connected: true, freeTier: null, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 's', userCode: 'A', verificationUrl: 'https://auth.example/device', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: this.motor.padrao?.model ?? null, provider: this.motor.padrao?.provider ?? null }; }
  async setDefaultModel(provider: string, model: string) { this.principalGravado.push(model); this.motor.padrao = { provider, model }; return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(e: string[]) { return e; }
  async auxModels(perfil?: string | null): Promise<AuxModels | null> {
    this.chamadas.push(`ler${perfil ? '@' + perfil : ''}`);
    if (this.antigo) return null;
    const linha = (task: string) => ({ task, provider: this.aux.get(task)?.provider ?? null, model: this.aux.get(task)?.model ?? null });
    return {
      main: { provider: this.motor.padrao?.provider ?? null, model: this.motor.padrao?.model ?? null },
      tasks: [...TAREFAS.map(linha), { ...linha('memoria_longa'), label: 'Long memory', hint: 'Recalls old notes', plugin: 'memoria', inheritFrom: 'compression',
        effective: { provider: this.aux.get('compression')?.provider ?? null, model: this.aux.get('compression')?.model ?? null } }],
    };
  }
  async setAuxModel(task: string, provider: string | null, model: string | null, confirm: boolean, perfil?: string | null) {
    this.chamadas.push(`gravar ${task}=${provider ?? '-'}/${model ?? '-'}${perfil ? '@' + perfil : ''}`);
    if (model && model === this.caro && !confirm) return { ok: false, confirmMessage: 'This model is expensive.' };
    if (provider && model) this.aux.set(task, { provider, model }); else this.aux.delete(task);
    return { ok: true, confirmMessage: null };
  }
  async delegacao() { return this.antigo ? null : this.ajudantes; }
  async setDelegacao(provider: string | null, model: string | null, perfil?: string | null) {
    this.chamadas.push(`ajudantes=${provider ?? '-'}/${model ?? '-'}${perfil ? '@' + perfil : ''}`);
    if (this.antigo) return null;
    this.ajudantes = { provider, model }; return true;
  }
  async modelosVisao(modelos: Array<{ provider: string; model: string }>) { return modelos.map((m) => this.veImagens.get(m.model) ?? null); }
}

const abertos: Harness[] = [];
async function abrir(prep: (c: Controle, m: Motor) => void = () => {}) {
  const motor = new Motor(); const controle = new Controle(motor);
  prep(controle, motor);
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-0123456789' }, { hermes: motor, control: controle });
  abertos.push(h);
  return { h, s: await setupOwner(h), controle, motor };
}
const linha = (j: any, task: string) => j.tasks.find((t: { task: string }) => t.task === task);

describe('modelos por tarefa', () => {
  after(async () => { for (const h of abertos) await h.close(); });

  test('a lista traz TODAS as tarefas do motor (e a do complemento), cada uma usando o principal, com a conta do custo', async () => {
    const { h, s } = await abrir();
    const r = await req(h, 'GET', '/api/ai/task-models', s);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.supported, true);
    assert.deepEqual(r.json.tasks.map((t: { task: string }) => t.task), [...TAREFAS, 'memoria_longa', 'delegation']);
    assert.deepEqual(r.json.main, { provider: 'nous', model: OPUS, label: 'Claude Opus 5.5', account: { id: 'nous', name: 'Nous Portal', billing: 'credits' } });
    for (const t of r.json.tasks) {
      assert.equal(t.provider, null, t.task); assert.equal(t.model, null, t.task);
      assert.deepEqual(t.runs, { provider: 'nous', model: OPUS, label: 'Claude Opus 5.5', account: { id: 'nous', name: 'Nous Portal', billing: 'credits' } }, t.task);
    }
    assert.equal(linha(r.json, 'delegation').kind, 'ajudantes');
    assert.equal(linha(r.json, 'vision').kind, 'apoio');
    assert.deepEqual(linha(r.json, 'memoria_longa').declared, { label: 'Long memory', hint: 'Recalls old notes', by: 'memoria', follows: 'compression' });
    assert.equal(linha(r.json, 'vision').declared, undefined);
  });

  test('gravar o modelo de uma tarefa, de outra conta, e voltar ao principal', async () => {
    const { h, s, controle } = await abrir();
    const r = await req(h, 'PUT', '/api/ai/task-models', s, { changes: [{ task: 'compression', provider: 'nous', model: FLASH }, { task: 'review', provider: 'openai-codex', model: 'gpt-6-codex' }] });
    assert.deepEqual(r.json, { ok: true, confirmMessage: null, applied: ['compression', 'review'] });
    const j = (await req(h, 'GET', '/api/ai/task-models', s)).json;
    assert.deepEqual(linha(j, 'compression').runs, { provider: 'nous', model: FLASH, label: 'Deepseek V4.1 Flash 1017', account: { id: 'nous', name: 'Nous Portal', billing: 'credits' } });
    assert.equal(linha(j, 'compression').model, FLASH);
    // o custo da revisão sai da assinatura do ChatGPT, não dos créditos
    assert.deepEqual(linha(j, 'review').runs.account, { id: 'openai-codex', name: 'ChatGPT (assinatura)', billing: 'subscription' });
    // a tarefa do complemento segue a de resumir: roda onde ela roda, sem escolha própria
    assert.equal(linha(j, 'memoria_longa').model, null);
    assert.equal(linha(j, 'memoria_longa').runs.model, FLASH);
    assert.equal(linha(j, 'title_generation').runs.model, OPUS);
    const aud = h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'ai.task_models'");
    assert.match(aud?.evidence ?? '', /compression/);
    // voltar ao principal: os dois nulos
    assert.equal((await req(h, 'PUT', '/api/ai/task-models', s, { changes: [{ task: 'compression', provider: null, model: null }] })).status, 200);
    assert.equal(controle.chamadas.at(-1), 'gravar compression=-/-');
    assert.equal(linha((await req(h, 'GET', '/api/ai/task-models', s)).json, 'compression').runs.model, OPUS);
    assert.deepEqual(controle.principalGravado, [], 'o modelo principal nunca é tocado');
  });

  test('os ajudantes temporários têm o próprio modelo, na mesma lista', async () => {
    const { h, s, controle } = await abrir();
    assert.equal((await req(h, 'PUT', '/api/ai/task-models', s, { changes: [{ task: 'delegation', provider: 'nous', model: FLASH }] })).status, 200);
    assert.deepEqual(controle.ajudantes, { provider: 'nous', model: FLASH });
    assert.equal(linha((await req(h, 'GET', '/api/ai/task-models', s)).json, 'delegation').runs.model, FLASH);
    await req(h, 'PUT', '/api/ai/task-models', s, { changes: [{ task: 'delegation', provider: null, model: null }] });
    assert.deepEqual(controle.ajudantes, { provider: null, model: null });
  });

  test('recusas: modelo fora das contas, tarefa que o motor não tem, escolha pela metade; nada é gravado', async () => {
    const { h, s, controle } = await abrir();
    const put = (changes: unknown) => req(h, 'PUT', '/api/ai/task-models', s, { changes });
    assert.equal((await put([{ task: 'vision', provider: 'nous', model: 'nao/existe' }])).status, 400);
    assert.equal((await put([{ task: 'vision', provider: 'anthropic', model: OPUS }])).status, 400);
    const r = await put([{ task: 'compression', provider: 'nous', model: FLASH }, { task: 'inventada', provider: 'nous', model: FLASH }]);
    assert.equal(r.status, 400); assert.equal(r.json.message_t?.codigo, 'erro.tarefaDeApoioDesconhecida');
    assert.equal((await put([{ task: 'vision', provider: 'nous', model: null }])).status, 400);
    assert.equal((await put([{ task: 'Vision!', provider: null, model: null }])).status, 400);
    assert.equal((await put([])).status, 400);
    assert.equal((await put([{ task: 'vision', provider: null, model: null, base_url: 'http://x' }])).status, 400);
    assert.ok(!controle.chamadas.some((c) => c.startsWith('gravar') || c.startsWith('ajudantes')), controle.chamadas.join(' | '));
  });

  test('modelo caro: a pergunta volta para a pessoa, e só grava com a confirmação', async () => {
    const { h, s, controle } = await abrir((c) => { c.caro = OPUS; c.motor.padrao = { provider: 'nous', model: QWEN }; });
    const mud = [{ task: 'curator', provider: 'nous', model: FLASH }, { task: 'review', provider: 'nous', model: OPUS }];
    const r = await req(h, 'PUT', '/api/ai/task-models', s, { changes: mud });
    assert.equal(r.json.ok, false); assert.deepEqual(r.json.applied, ['curator']);
    assert.match(r.json.confirmMessage, /expensive/);
    assert.equal(controle.aux.has('review'), false);
    const r2 = await req(h, 'PUT', '/api/ai/task-models', s, { changes: mud, confirm: true });
    assert.equal(r2.json.ok, true); assert.equal(controle.aux.get('review')?.model, OPUS);
  });

  test('equipe de IA de antes (sem o recurso): a tela sabe, e gravar não mexe em nada, nem no principal', async () => {
    const { h, s, controle } = await abrir((c) => { c.antigo = true; });
    const j = (await req(h, 'GET', '/api/ai/task-models', s)).json;
    assert.equal(j.supported, false); assert.deepEqual(j.tasks, []); assert.equal(j.main.model, OPUS);
    const r = await req(h, 'PUT', '/api/ai/task-models', s, { changes: [{ task: 'compression', provider: 'nous', model: FLASH }] });
    assert.equal(r.status, 409); assert.equal(r.json.message_t?.codigo, 'erro.modelosTarefaNaoChegou');
    assert.ok(!controle.chamadas.some((c) => c.startsWith('gravar')));
    assert.deepEqual(controle.principalGravado, []);
    assert.equal((await req(h, 'GET', '/api/ai/task-models/economy', s)).json.reason, 'unsupported');
  });

  test('por agente: o perfil vai junto até o motor; perfil estranho é recusado; o de fora do workspace também', async () => {
    const { h, s, controle } = await abrir();
    const ag = h.db.get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM agents ORDER BY rowid LIMIT 1')!;
    const P = 'erg-0123456789abcdef0123';
    h.db.run("INSERT INTO agent_profiles (agent_id, workspace_id, profile, state, updated_at) VALUES (?, ?, ?, 'pronto', ?)", ag.id, ag.workspace_id, P, new Date().toISOString());
    // a janela do agente sabe o perfil dele quando está pronto (e escolhe os modelos ali); sem perfil pronto: null
    assert.equal((await req(h, 'GET', `/api/agents/${ag.id}`, s)).json.hermesPerfil, P);
    const outro = h.db.get<{ id: string }>('SELECT id FROM agents WHERE id <> ? ORDER BY rowid LIMIT 1', ag.id)!;
    assert.equal((await req(h, 'GET', `/api/agents/${outro.id}`, s)).json.hermesPerfil, null);
    h.db.run("UPDATE agent_profiles SET state = 'pendente' WHERE agent_id = ?", ag.id);
    assert.equal((await req(h, 'GET', `/api/agents/${ag.id}`, s)).json.hermesPerfil, null);
    h.db.run("UPDATE agent_profiles SET state = 'pronto' WHERE agent_id = ?", ag.id);
    assert.equal((await req(h, 'GET', `/api/ai/task-models?perfil=${P}`, s)).status, 200);
    assert.ok(controle.chamadas.includes(`ler@${P}`));
    await req(h, 'PUT', '/api/ai/task-models', s, { perfil: P, changes: [{ task: 'vision', provider: 'nous', model: MINI }, { task: 'delegation', provider: 'nous', model: FLASH }] });
    assert.ok(controle.chamadas.includes(`gravar vision=nous/${MINI}@${P}`)); assert.ok(controle.chamadas.includes(`ajudantes=nous/${FLASH}@${P}`));
    assert.equal((await req(h, 'GET', '/api/ai/task-models?perfil=..%2Fx', s)).status, 400);
    assert.equal((await req(h, 'GET', '/api/ai/task-models?perfil=erg-ffffffffffffffffffff', s)).status, 404);
    assert.equal((await req(h, 'PUT', '/api/ai/task-models', s, { perfil: 'erg-ffffffffffffffffffff', changes: [{ task: 'vision', provider: null, model: null }] })).status, 404);
    assert.equal((await req(h, 'PUT', '/api/ai/task-models', s, { perfil: 'A B', changes: [{ task: 'vision', provider: null, model: null }] })).status, 400);
  });

  test('economia: diz o que mudaria (resumir, dar nome, ver imagens) com o mais barato, e não grava nada', async () => {
    const { h, s, controle } = await abrir();
    const e = (await req(h, 'GET', '/api/ai/task-models/economy', s)).json;
    assert.equal(e.reason, null);
    assert.equal(e.model.model, FLASH, 'o econômico de menor preço publicado');
    assert.deepEqual(e.model.account, { id: 'nous', name: 'Nous Portal', billing: 'credits' });
    // ver imagens: o mais barato não enxerga; vai o primeiro que o motor sabe que enxerga
    assert.deepEqual(e.changes.map((c: any) => [c.task, c.from.model, c.to.model]), [['vision', OPUS, MINI], ['compression', OPUS, FLASH], ['title_generation', OPUS, FLASH]]);
    assert.deepEqual(e.kept, []);
    assert.ok(!controle.chamadas.some((c) => c.startsWith('gravar')), 'a sugestão só mostra');
    // aplicar é a gravação comum, com o que a pessoa viu
    await req(h, 'PUT', '/api/ai/task-models', s, { changes: e.changes.map((c: any) => ({ task: c.task, provider: c.to.provider, model: c.to.model })) });
    const e2 = (await req(h, 'GET', '/api/ai/task-models/economy', s)).json;
    assert.deepEqual(e2.changes, []);
    assert.deepEqual(e2.kept, [{ task: 'vision', reason: 'same' }, { task: 'compression', reason: 'same' }, { task: 'title_generation', reason: 'same' }]);
  });

  test('economia: sem saber quem enxerga imagens, ver imagens fica como está', async () => {
    const { h, s } = await abrir((c) => { c.veImagens.clear(); });
    const e = (await req(h, 'GET', '/api/ai/task-models/economy', s)).json;
    assert.deepEqual(e.changes.map((c: any) => c.task), ['compression', 'title_generation']);
    assert.deepEqual(e.kept, [{ task: 'vision', reason: 'vision' }]);
  });

  test('economia: plano gratuito só recebe modelo grátis; principal já barato não muda; sem modelo econômico, nada', async () => {
    const a = await abrir((c) => { c.gratuito = true; });
    assert.equal((await req(a.h, 'GET', '/api/ai/task-models/economy', a.s)).json.model.model, GRATIS);
    const b = await abrir((c) => { c.motor.padrao = { provider: 'nous', model: FLASH }; });
    assert.deepEqual((await req(b.h, 'GET', '/api/ai/task-models/economy', b.s)).json, { model: null, changes: [], kept: [], reason: 'main' });
    const c = await abrir((x) => { x.motor.modelos = [OPUS]; });
    assert.equal((await req(c.h, 'GET', '/api/ai/task-models/economy', c.s)).json.reason, 'none');
  });

  test('a régua das faixas: para começar, o intermediário; para as tarefas de apoio, o econômico mais barato; nunca o de ponta', () => {
    const m = [{ id: 'p', tier: 'ponta' as const, input: 4, output: 20 }, { id: 'i', tier: 'intermediário' as const, input: 1.2, output: 6 }, { id: 'e1', tier: 'econômico' as const, input: 0.3, output: 1 },
      { id: 'e2', tier: 'econômico' as const, input: 0.2, output: 0.8 }, { id: 'g', tier: 'grátis' as const, input: 0, output: 0 }];
    assert.equal(porFaixa(m, ORDEM_PARA_COMECAR)?.id, 'i');
    assert.equal(porFaixa(m, ORDEM_ECONOMIA, true)?.id, 'e2');
    assert.equal(porFaixa(m.filter((x) => x.tier !== 'econômico'), ORDEM_ECONOMIA, true)?.id, 'g');
    assert.equal(porFaixa([m[0]], ORDEM_ECONOMIA, true), null);
  });
});

describe('modelos por tarefa: o cliente da ponte', () => {
  test('o que o motor devolve vira linhas: "auto" é usar o principal; tarefa estranha ou repetida sai', () => {
    const a = parseAuxModels({ main: { provider: 'nous', model: OPUS }, tasks: [
      { task: 'vision', provider: 'auto', model: '', base_url: '' }, { task: 'compression', provider: 'nous', model: FLASH },
      { task: 'vision', provider: 'nous', model: QWEN }, { task: '../x', provider: 'nous', model: QWEN }, { task: 'mcp', provider: 'nous', model: '' }, null,
      { task: 'extra', provider: 'auto', model: '', label: 'Extra', hint: 'Faz algo', plugin: 'p', inherit_from: 'vision', effective: { provider: 'auto', model: '' } },
    ] });
    assert.deepEqual(a.main, { provider: 'nous', model: OPUS });
    assert.deepEqual(a.tasks, [
      { task: 'vision', provider: null, model: null }, { task: 'compression', provider: 'nous', model: FLASH }, { task: 'mcp', provider: null, model: null },
      { task: 'extra', provider: null, model: null, label: 'Extra', hint: 'Faz algo', plugin: 'p', inheritFrom: 'vision', effective: { provider: null, model: null } },
    ]);
    assert.deepEqual(parseAuxModels(null), { tasks: [], main: { provider: null, model: null } });
  });

  test('as rotas: do motor ou do perfil (/p/<perfil>/...), "usar o principal" como o motor entende, e 404 = ainda não tem', async () => {
    const vistos: Array<{ m: string; url: string; body: any }> = [];
    let antigo = false;
    const srv = createServer((q, r) => {
      let raw = '';
      q.on('data', (d) => { raw += d; });
      q.on('end', () => {
        vistos.push({ m: q.method ?? '', url: q.url ?? '', body: raw ? JSON.parse(raw) : null });
        const url = (q.url ?? '').replace(/^\/p\/[a-z0-9_-]+/, '');
        const ok = (o: unknown) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
        if (antigo) { r.writeHead(404, { 'Content-Type': 'application/json' }); return r.end('{"error":"rota não liberada pela ponte do Ergon"}'); }
        if (url === '/api/model/auxiliary') return ok({ tasks: [{ task: 'vision', provider: 'auto', model: '' }], main: { provider: 'nous', model: OPUS } });
        if (url === '/api/model/set') return ok({ ok: true });
        if (url === '/ergon/v1/delegacao' && q.method === 'GET') return ok({ provider: 'nous', model: FLASH });
        if (url === '/ergon/v1/delegacao') return ok({ ok: true });
        if (url === '/ergon/v1/modelos/visao') return ok({ visao: [true, null, 'x'] });
        r.writeHead(404); r.end('{}');
      });
    });
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    try {
      const c = new HttpHermesControl(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'token-de-teste');
      assert.deepEqual(await c.auxModels(), { tasks: [{ task: 'vision', provider: null, model: null }], main: { provider: 'nous', model: OPUS } });
      assert.equal(vistos.at(-1)?.url, '/api/model/auxiliary');
      await c.auxModels('socrates');
      assert.equal(vistos.at(-1)?.url, '/p/socrates/api/model/auxiliary');
      await c.setAuxModel('compression', 'nous', FLASH, false, 'socrates');
      assert.deepEqual(vistos.at(-1), { m: 'POST', url: '/p/socrates/api/model/set', body: { scope: 'auxiliary', task: 'compression', provider: 'nous', model: FLASH, confirm_expensive_model: false } });
      await c.setAuxModel('compression', null, null, false);
      assert.deepEqual(vistos.at(-1), { m: 'POST', url: '/api/model/set', body: { scope: 'auxiliary', task: 'compression', provider: 'auto', model: '', confirm_expensive_model: false } });
      assert.deepEqual(await c.delegacao(), { provider: 'nous', model: FLASH });
      assert.equal(await c.setDelegacao(null, null, 'platao'), true);
      assert.deepEqual(vistos.at(-1), { m: 'PUT', url: '/p/platao/ergon/v1/delegacao', body: { provider: '', model: '' } });
      assert.deepEqual(await c.modelosVisao([{ provider: 'nous', model: MINI }, { provider: 'nous', model: FLASH }, { provider: 'nous', model: QWEN }]), [true, null, null]);
      await assert.rejects(() => c.auxModels('../etc'), /perfil inválido/);
      assert.throws(() => rotaDoPerfil('A', '/x'), /perfil inválido/);
      assert.equal(rotaDoPerfil(null, '/x'), '/x');
      antigo = true;
      assert.equal(await c.auxModels(), null);
      assert.equal(await c.delegacao(), null);
      assert.equal(await c.setDelegacao('nous', FLASH), null);
      assert.equal(await c.modelosVisao([{ provider: 'nous', model: MINI }]), null);
    } finally { await new Promise((res) => srv.close(res)); }
  });
});
