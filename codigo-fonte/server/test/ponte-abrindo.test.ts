/**
 * Logo depois de a equipe de IA ficar "aberta", a ponte de controle do motor ainda pode não ouvir (o plugin abre a porta
 * um pouco depois; o nome do contêiner pode ainda não resolver). Ensaio da rc.27: Contas de IA › endereço próprio
 * (POST /api/ai/byok-custom) respondia 500 "erro interno". Confere:
 * - o cliente da ponte tenta de novo, em seguida, quando o pedido nem chegou (conexão recusada, nome que não resolve), e
 *   não repete quando pode ter chegado (tempo esgotado);
 * - toda rota em que o erro da equipe de IA chega sem tratamento responde 503 com o texto "ainda está ligando" (com o código
 *   para a tela traduzir), nunca 500 "erro interno"; a recusa da equipe vira 502 com o motivo.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { fetchPonte, HermesError, HttpHermesControl, pedidoNaoChegou, type HermesControlClient } from '../src/services/hermes.ts';
import { harness, req, setupOwner } from './helpers.ts';

const PONTE = 'token-da-ponte-de-teste-' + '0123456789';

async function portaLivre(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return p;
}

describe('a ponte da equipe de IA logo depois de abrir', () => {
  test('pedido que nem chegou (conexão recusada, nome que não resolve): sim; tempo esgotado: não', () => {
    assert.equal(pedidoNaoChegou(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true);
    assert.equal(pedidoNaoChegou(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN' } })), true);
    assert.equal(pedidoNaoChegou(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } })), true);
    assert.equal(pedidoNaoChegou(Object.assign(new Error('x'), { name: 'TimeoutError' })), false);
    assert.equal(pedidoNaoChegou(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), false, 'conexão cortada: pode ter chegado');
  });

  test('a ponte abre um instante depois: o pedido segue sem erro', async () => {
    const porta = await portaLivre();
    const vistos: string[] = [];
    const srv = http.createServer((rq, rs) => {
      vistos.push(`${rq.method} ${rq.url}`);
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ ok: true, id: 'byok-local', models: 3 }));
    });
    const abrir = setTimeout(() => srv.listen(porta, '127.0.0.1'), 700);
    try {
      const control = new HttpHermesControl(`http://127.0.0.1:${porta}`, PONTE);
      const t0 = Date.now();
      const r = await control.addByokCustom!({ kind: 'ollama', name: 'Local', baseUrl: 'http://ollama.test:11434' });
      assert.equal(r.id, 'byok-local');
      assert.ok(Date.now() - t0 >= 600, 'esperou a ponte abrir');
      assert.deepEqual(vistos, ['POST /ergon/v1/byok/custom'], 'um pedido só chegou');
    } finally { clearTimeout(abrir); await new Promise<void>((ok) => srv.close(() => ok())); }
  });

  test('tempo esgotado não repete (o pedido pode ter chegado)', async () => {
    let chamadas = 0;
    const srv = http.createServer(() => { chamadas++; /* nunca responde */ });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`;
      await assert.rejects(fetchPonte(url, { signal: AbortSignal.timeout(300) }, [50, 50]));
      await new Promise((x) => setTimeout(x, 200));
      assert.equal(chamadas, 1);
    } finally { srv.closeAllConnections(); await new Promise<void>((ok) => srv.close(() => ok())); }
  });

  test('a equipe de IA não respondeu: 503 com "ainda está ligando", nunca "erro interno"; recusa: 502 com o motivo', async () => {
    let erro: HermesError = new HermesError(503, 'a equipe de IA não respondeu agora');
    const control = {
      health: async () => true, info: async () => ({ ok: true, pluginVersion: '0.6.0', vaultConfig: 4, capacidades: [] }),
      apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e,
      modelInfo: async () => ({ model: null, provider: null }),
      addByokCustom: async () => { throw erro; },
      removeByokCustom: async () => { throw erro; },
    } as unknown as HermesControlClient;
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: PONTE }, { control });
    const s = await setupOwner(h);
    const corpo = { kind: 'ollama', name: 'Local', baseUrl: 'http://ollama.test:11434' };
    let r = await req(h, 'POST', '/api/ai/byok-custom', s, corpo);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, 'ai_unavailable');
    assert.equal(r.json.message_t?.codigo, 'erro.equipeAbrindo');
    assert.doesNotMatch(String(r.json.message), /erro interno/);
    erro = new HermesError(502, 'a equipe de IA teve um problema agora; tente de novo');
    r = await req(h, 'DELETE', '/api/ai/byok-custom/byok-local', s);
    assert.equal(r.status, 503, 'outra rota da ponte, o mesmo tratamento');
    erro = new HermesError(404, 'rota não liberada pela ponte do Ergon');
    r = await req(h, 'DELETE', '/api/ai/byok-custom/byok-local', s);
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'ai_refused');
    await h.close();
  });
});
