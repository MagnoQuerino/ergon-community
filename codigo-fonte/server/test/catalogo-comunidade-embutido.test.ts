/**
 * Os modelos da comunidade que já estão no repositório (catalogo/pacotes/exemplos) vêm com o Ergon: aparecem na Loja
 * sem internet, como "não verificado", e instalam pelo caminho de sempre.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness, req, setupOwner } from './helpers.ts';

test('modelos da comunidade embutidos: sem internet, não verificados, instaláveis e iguais aos do catálogo público', async () => {
  const h = await harness();
  try {
    const s = await setupOwner(h);
    const l = (await req(h, 'GET', '/api/packages/catalog/bundled', s)).json as Array<{ id: string; verified: boolean; installed: boolean; author: string; preview: unknown }>;
    assert.deepEqual(l.map((x) => [x.id, x.verified, x.author]).sort(), [['comunidade.exemplos.cao-de-socrates', false, 'exemplos'], ['comunidade.exemplos.tema-mar-egeu', false, 'exemplos']]);
    assert.ok(l.every((x) => x.preview), 'com prévia');
    assert.equal((await req(h, 'POST', '/api/packages/catalog/bundled/install', s, { id: 'comunidade.exemplos.tema-mar-egeu' })).status, 200);
    assert.equal((await req(h, 'POST', '/api/packages/catalog/bundled/install', s, { id: 'comunidade.exemplos.nao-existe' })).status, 404);
    assert.equal(((await req(h, 'GET', '/api/packages/catalog/bundled', s)).json as Array<{ id: string; installed: boolean }>).find((x) => x.id.endsWith('mar-egeu'))!.installed, true);
  } finally { await h.close(); }
  // os mesmos arquivos do catálogo público do repositório (quando ele está junto)
  const pub = path.resolve(import.meta.dirname, '..', '..', '..', 'catalogo', 'pacotes', 'exemplos');
  if (fs.existsSync(pub)) for (const f of fs.readdirSync(pub)) assert.deepEqual(fs.readFileSync(path.join(pub, f)), fs.readFileSync(path.resolve(import.meta.dirname, '..', 'catalogo', 'comunidade', f)), f);
});
