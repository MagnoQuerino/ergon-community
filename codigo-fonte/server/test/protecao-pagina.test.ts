import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildGate } from '../src/gate.ts';
import { PAGE_CSP } from '../src/lib/protecao-pagina.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { Vault } from '../src/security/keys.ts';
import { harness, req, testConfig, tmpDir, type Harness } from './helpers.ts';

// A proteção da página antes da rc.28, diretiva por diretiva: a rc.28 só acrescenta o som (media-src). Qualquer outra
// mudança (abrir scripts, conexões, molduras) reprova aqui e pede revisão de segurança.
const ANTES = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const partes = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [nome, ...v] = d.split(/\s+/); return [nome, v.join(' ')] as const; }));

describe('proteção da página: o "Ouvir" toca e nada mais se abre', () => {
  let h: Harness;
  before(async () => { h = await harness(); });
  after(async () => { await h.close(); });

  test('só entra media-src (o próprio Ergon e blob:); as outras diretivas ficam idênticas', () => {
    const antes = partes(ANTES); const agora = partes(PAGE_CSP);
    assert.equal(agora.get('media-src'), "'self' blob:");
    agora.delete('media-src');
    assert.deepEqual([...agora], [...antes]);
    // o som não abre dados embutidos nem endereços de fora
    assert.doesNotMatch(PAGE_CSP, /media-src[^;]*(data:|https?:|\*)/);
  });

  test('o app aberto responde com essa proteção', async () => {
    const r = await req(h, 'GET', '/api/health');
    assert.equal(r.res.headers['content-security-policy'], PAGE_CSP);
    assert.match(String(r.res.headers['content-security-policy']), /(^|; )media-src 'self' blob:(;|$)/);
    assert.equal(r.res.headers['x-frame-options'], 'DENY');
  });

  test('a tela trancada (portão) responde com a mesma proteção', async () => {
    const dir = tmpDir();
    const g = await buildGate(testConfig(dir), new Vault(dir, KDF_TEST), () => { throw new Error('o teste não destranca'); });
    try {
      const r = await g.app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers['content-security-policy'], PAGE_CSP);
    } finally { await g.app.close(); }
  });
});
