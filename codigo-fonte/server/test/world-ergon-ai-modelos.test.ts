/**
 * Ergon AI só com a marca Ergon (rc.33): o World publica `ergon-ai` e `ergon-ai-sinapse` (id, nome, descrição) e ainda
 * aceita os ids antigos (deepseek-*). A tela nunca mostra "DeepSeek" no Ergon AI; a instalação de antes, que guardou o
 * endpoint com os ids antigos, conecta de novo em silêncio (com o mesmo "como padrão") e as escolhas gravadas migram.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AuxModels, HermesClient, HermesControlClient, ModelOptions } from '../src/services/hermes.ts';
import { apelidoErgonAi, labelFor, modelLabel, modelosVisiveisErgonAi, precisaReconectarErgonAi, rotuloErgonAi } from '../src/services/ai.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness } from './helpers.ts';

describe('Ergon AI: os nomes na tela', () => {
  test('os apelidos e qualquer id antigo no Ergon AI aparecem com o nome da marca', () => {
    assert.equal(modelLabel('ergon-ai'), 'Ergon AI');
    assert.equal(modelLabel('ergon-ai-sinapse'), 'Ergon AI Sinapse');
    assert.equal(modelLabel('ergon-ai/deepseek-flash'), 'Ergon AI', 'execução na nuvem gravada como conta/modelo');
    assert.equal(labelFor('ergon-ai', 'deepseek-reasoner'), 'Ergon AI Sinapse', 'id antigo: o nome do apelido dele');
    for (const id of ['deepseek-flash', 'deepseek-chat', 'deepseek-v4-flash', 'outro-qualquer']) {
      assert.equal(labelFor('ergon-ai', id), 'Ergon AI', id);
      assert.doesNotMatch(labelFor('ergon-ai', id), /deepseek/i);
    }
    assert.equal(labelFor('ergon-ai', 'ergon-ai-sinapse'), 'Ergon AI Sinapse');
    assert.equal(rotuloErgonAi(null), 'Ergon AI');
    // fora do Ergon AI, o nome de sempre (a chave própria da DeepSeek continua DeepSeek)
    assert.equal(labelFor('deepseek', 'deepseek-chat'), 'Deepseek Chat');
  });
  test('ids antigos → apelidos; o que já é apelido fica; reconectar só com id fora dos apelidos', () => {
    assert.deepEqual(['deepseek-flash', 'deepseek-chat', 'deepseek-v4-flash', 'deepseek-reasoner', 'ergon-ai', 'ergon-ai-sinapse', 'gpt-5'].map(apelidoErgonAi),
      ['ergon-ai', 'ergon-ai', 'ergon-ai', 'ergon-ai-sinapse', 'ergon-ai', 'ergon-ai-sinapse', null]);
    assert.equal(precisaReconectarErgonAi(['ergon-ai', 'ergon-ai-sinapse']), false);
    assert.equal(precisaReconectarErgonAi(['deepseek-flash']), true);
    assert.equal(precisaReconectarErgonAi(['ergon-ai', 'deepseek-reasoner']), true);
  });
});

describe('Ergon AI: a instalação de antes migra sozinha', () => {
  let world: FakeWorld; let h: Harness;
  // o motor: o endpoint "ergon-ai" guardado com os ids antigos, o padrão e as tarefas de apoio apontando para eles
  const motor = {
    endpoint: ['deepseek-flash', 'deepseek-reasoner'] as string[],
    padrao: { provider: 'ergon-ai' as string | null, model: 'deepseek-flash' as string | null },
    tarefas: new Map<string, { provider: string | null; model: string | null }>([['compression', { provider: 'ergon-ai', model: 'deepseek-reasoner' }], ['vision', { provider: 'openai', model: 'gpt-visao' }]]),
    ajudantes: { provider: 'ergon-ai', model: 'deepseek-chat' } as { provider: string | null; model: string | null },
    conexoes: [] as Array<{ models: string[]; makeDefault: boolean }>,
  };
  const control = {
    health: async () => true,
    accounts: async () => [],
    byok: async () => ({ providers: [], custom: [], ergonAi: true }),
    modelInfo: async () => ({ ...motor.padrao }),
    setDefaultModel: async (provider: string, model: string) => { motor.padrao = { provider, model }; return { ok: true, confirmMessage: null }; },
    auxModels: async (): Promise<AuxModels> => ({ main: { ...motor.padrao }, tasks: [...motor.tarefas].map(([task, v]) => ({ task, ...v })) }),
    setAuxModel: async (task: string, provider: string | null, model: string | null) => { motor.tarefas.set(task, { provider, model }); return { ok: true, confirmMessage: null }; },
    delegacao: async () => ({ ...motor.ajudantes }),
    setDelegacao: async (provider: string | null, model: string | null) => { motor.ajudantes = { provider, model }; return true; },
    ergonAi: async (c: { models: string[]; makeDefault: boolean }) => { motor.endpoint = [...c.models]; motor.conexoes.push({ models: c.models, makeDefault: c.makeDefault }); },
    removeErgonAi: async () => undefined,
  } as unknown as HermesControlClient;
  const hermes = {
    health: async () => ({ ok: true, detail: 'teste' }),
    modelOptions: async (): Promise<ModelOptions> => ({ ...motor.padrao, providers: [{ slug: 'ergon-ai', name: 'Ergon AI', current: true, authenticated: true, models: [...motor.endpoint], pricing: {} }] }),
  } as unknown as HermesClient;

  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; h = await harness({}, { control, hermes }); });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await h.close(); await world.stop(); });

  test('ao renovar com o World: conecta de novo com os apelidos (mesmo "como padrão") e migra padrão, tarefas, ajudantes e agentes', async () => {
    const s = await setupOwner(h, 'ana', 'senha-de-ana-123');
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    const conta = [...world.accounts.values()].find((a) => a.email === 'ana@exemplo.test')!;
    assert.equal((await req(h, 'POST', '/api/world/bind', s, { syncWorkspaceId: world.serverWorkspace(conta.id, { source: 'cortesia' }) })).status, 200);
    // um agente com o modelo próprio no Ergon AI, gravado com o id antigo
    const ag = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", s.workspaceId)!.id;
    h.db.run("UPDATE agents SET provider = 'ergon-ai', model = 'deepseek-v4-flash' WHERE id = ?", ag);
    // antes: a tela já mostra a marca, mesmo com os ids antigos guardados
    const antes = (await req(h, 'GET', '/api/ai/models', s)).json as { default: { label: string }; providers: Array<{ models: Array<{ label: string }> }> };
    assert.equal(antes.default.label, 'Ergon AI');
    const nomes = antes.providers[0].models.map((m) => m.label);
    assert.ok(nomes.every((n) => /^Ergon AI( Sinapse)?$/.test(n)), nomes.join());
    assert.equal(new Set(nomes).size, nomes.length, `sem nome repetido: ${nomes.join()}`);
    assert.doesNotMatch(JSON.stringify(antes), /DeepSeek|Deepseek/);

    assert.equal((await req(h, 'POST', '/api/world/refresh', s)).status, 200);
    for (let i = 0; i < 100 && !(motor.conexoes.length && motor.ajudantes.model === 'ergon-ai'); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(motor.conexoes, [{ models: ['ergon-ai', 'ergon-ai-sinapse'], makeDefault: true }], 'em silêncio, com o mesmo "como padrão"');
    assert.deepEqual(motor.padrao, { provider: 'ergon-ai', model: 'ergon-ai' });
    assert.deepEqual(motor.tarefas.get('compression'), { provider: 'ergon-ai', model: 'ergon-ai-sinapse' }, 'deepseek-reasoner → Sinapse');
    assert.deepEqual(motor.tarefas.get('vision'), { provider: 'openai', model: 'gpt-visao' }, 'outra conta fica como está');
    assert.deepEqual(motor.ajudantes, { provider: 'ergon-ai', model: 'ergon-ai' });
    assert.equal(h.db.get<{ model: string }>('SELECT model FROM agents WHERE id = ?', ag)!.model, 'ergon-ai');

    // o seletor: os dois modelos do Ergon AI com o nome e a descrição curta do World
    const depois = (await req(h, 'GET', '/api/ai/models', s)).json as { providers: Array<{ id: string; models: Array<{ id: string; label: string; description?: string }> }> };
    assert.deepEqual(depois.providers.find((p) => p.id === 'ergon-ai')!.models.map((m) => [m.id, m.label, m.description]),
      [['ergon-ai', 'Ergon AI', 'Rápido, para o dia a dia'], ['ergon-ai-sinapse', 'Ergon AI Sinapse', 'Pensa antes de responder']]);
    const tm = (await req(h, 'GET', '/api/ai/task-models', s)).json as { main: { label: string }; tasks: Array<{ task: string; runs: { label: string } }> };
    assert.equal(tm.main.label, 'Ergon AI');
    assert.equal(tm.tasks.find((t) => t.task === 'compression')!.runs.label, 'Ergon AI Sinapse');

    // de novo: já com os apelidos, não conecta outra vez
    assert.equal((await req(h, 'POST', '/api/world/refresh', s)).status, 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(motor.conexoes.length, 1);
  });
});

test('a lista do Ergon AI na tela: um modelo por nome (ids antigos do endpoint não repetem "Ergon AI")', () => {
  assert.deepEqual(modelosVisiveisErgonAi(['deepseek-v4-flash', 'ergon-ai', 'ergon-ai-sinapse']), ['ergon-ai', 'ergon-ai-sinapse']);
  assert.deepEqual(modelosVisiveisErgonAi(['deepseek-flash', 'deepseek-reasoner']), ['deepseek-flash', 'deepseek-reasoner']);
  assert.deepEqual(modelosVisiveisErgonAi(['ergon-ai', 'deepseek-chat', 'ergon-ai-sinapse', 'deepseek-reasoner']), ['ergon-ai', 'ergon-ai-sinapse']);
});
