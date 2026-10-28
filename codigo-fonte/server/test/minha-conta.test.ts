import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** Minha conta: nome de exibição e foto de perfil. */
describe('minha conta', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  test('foto: grava, aparece em /api/me e sai', async () => {
    assert.equal((await req(h, 'GET', '/api/me', s)).json.user.avatar, null);
    assert.equal((await req(h, 'PUT', '/api/me/avatar', s, { image: png })).status, 200);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.user.avatar, png);
    assert.equal((await req(h, 'DELETE', '/api/me/avatar', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.user.avatar, null);
  });

  test('foto: só imagem PNG, JPEG ou WebP em data URL; nada de outro tipo ou tamanho exagerado', async () => {
    for (const image of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://exemplo.com/foto.png', 'data:text/html;base64,PGI+', `data:image/png;base64,${'A'.repeat(300_001)}`]) {
      assert.ok([400, 413].includes((await req(h, 'PUT', '/api/me/avatar', s, { image })).status), image.slice(0, 30));
    }
  });

  test('nome de exibição: muda; vazio recusado', async () => {
    const r = await req(h, 'PATCH', '/api/me', s, { displayName: '  Ana   Souza ' });
    assert.equal(r.status, 200);
    assert.equal(r.json.displayName, 'Ana Souza');
    assert.equal((await req(h, 'GET', '/api/me', s)).json.user.displayName, 'Ana Souza');
    assert.equal((await req(h, 'PATCH', '/api/me', s, { displayName: '   ' })).status, 400);
  });
});
