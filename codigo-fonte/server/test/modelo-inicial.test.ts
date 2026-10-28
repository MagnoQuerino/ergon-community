import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness } from './helpers.ts';

/** Modelo para começar: ao conectar a conta de IA sem modelo padrão, a equipe não fica "sem modelo". */
class Motor implements HermesClient {
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(_p: StartRun) { return { runId: 'run_x', replayed: false }; }
  async getRun(): Promise<RemoteRun> { return { status: 'completed', output: 'ok', error: null, sessionId: 's', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, model: 'x' }; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return []; }
  async modelOptions(): Promise<ModelOptions> {
    return { model: this.padrao?.model ?? null, provider: this.padrao?.provider ?? null, providers: [
      { slug: 'nous', name: 'Nous Portal', current: true, authenticated: true,
        models: ['anthropic/claude-opus-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'qwen/qwen3-max', 'meta/llama-free:free'],
        pricing: { 'anthropic/claude-opus-5.5': { input: '$4.00', output: '$20.00' }, 'deepseek/deepseek-v4.1-flash-1017': { input: '$0.20', output: '$0.80' },
          'qwen/qwen3-max': { input: '$1.20', output: '$6.00' }, 'meta/llama-free:free': { input: '$0', output: '$0', free: true } } },
      { slug: 'openai-codex', name: 'ChatGPT', current: false, authenticated: false, models: [], pricing: {} },
    ] } as ModelOptions;
  }
  padrao: { provider: string; model: string } | null = null;
}

class Controle implements HermesControlClient {
  motor: Motor; gratuito: boolean;
  constructor(motor: Motor, gratuito = false) { this.motor = motor; this.gratuito = gratuito; }
  escolhidos: string[] = [];
  async health() { return true; }
  async accounts() { return [{ id: 'nous', name: 'Nous Portal', connected: true, freeTier: this.gratuito, tier: null, expiresAt: null }, { id: 'openai-codex', name: 'ChatGPT', connected: false, freeTier: null, tier: null, expiresAt: null }]; }
  async startLogin() { return { sessionId: 'sess_abc123', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device', expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'approved', error: null, email: 'eu@example.com', model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: this.motor.padrao?.model ?? null, provider: this.motor.padrao?.provider ?? null }; }
  async setDefaultModel(provider: string, model: string) { this.escolhidos.push(model); this.motor.padrao = { provider, model }; return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(e: string[]) { return e; }
}

async function conectar(gratuito: boolean, padrao: { provider: string; model: string } | null = null) {
  const motor = new Motor(); motor.padrao = padrao;
  const controle = new Controle(motor, gratuito);
  const h: Harness = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-0123456789' }, { hermes: motor, control: controle });
  const s = await setupOwner(h);
  assert.equal((await req(h, 'POST', '/api/ai/accounts/nous/login', s)).status, 200);
  const r = await req(h, 'GET', '/api/ai/logins/sess_abc123', s);
  const st = (await req(h, 'GET', '/api/ai/status', s)).json;
  return { h, r: r.json, st, controle };
}

describe('modelo para começar ao conectar a conta de IA', () => {
  const abertos: Harness[] = [];
  after(async () => { for (const h of abertos) await h.close(); });

  test('sem modelo padrão: escolhe um intermediário da conta conectada, nunca o de ponta', async () => {
    const { h, r, st, controle } = await conectar(false); abertos.push(h);
    assert.equal(r.status, 'approved');
    assert.deepEqual(controle.escolhidos, ['qwen/qwen3-max']);
    assert.match(r.starterModel, /Qwen3 Max/);
    assert.equal(st.default.model, 'qwen/qwen3-max');
  });

  test('plano gratuito: um modelo grátis', async () => {
    const { h, controle } = await conectar(true); abertos.push(h);
    assert.deepEqual(controle.escolhidos, ['meta/llama-free:free']);
  });

  test('a conta já tinha modelo padrão: nada muda', async () => {
    const { h, r, controle } = await conectar(false, { provider: 'nous', model: 'deepseek/deepseek-v4.1-flash-1017' }); abertos.push(h);
    assert.deepEqual(controle.escolhidos, []);
    assert.equal(r.starterModel, null);
  });
});
