import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ERGON_GOOGLE_APP, loadConfig } from '../src/config.ts';

// O app público do Google entra na imagem como arquivo (esteira de lançamento); sem ele, nada muda para quem usa cliente próprio.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergon-google-'));
const arquivo = path.join(dir, 'google-app.secret');
const base = { ERGON_DATA_DIR: dir, ERGON_GOOGLE_APP_SECRET_FILE: arquivo };

test('sem o arquivo do segredo e sem cliente próprio: Google sem app', () => {
  const c = loadConfig({ ...base });
  assert.equal(c.googleClientId, null); assert.equal(c.googleClientSecret, null);
});

test('com o arquivo: app público embutido, publicado (sem o prazo de 7 dias)', () => {
  fs.writeFileSync(arquivo, 'segredo-de-app-instalado-123\n');
  const c = loadConfig({ ...base, ERGON_GOOGLE_CLIENT_ID: '' });
  assert.equal(c.googleClientId, ERGON_GOOGLE_APP); assert.equal(c.googleClientSecret, 'segredo-de-app-instalado-123'); assert.equal(c.googleTesting, false);
  assert.equal(loadConfig({ ...base, ERGON_GOOGLE_TESTING: '1' }).googleTesting, true);
});

test('cliente próprio no ergon.env vence o embutido; "off" desliga', () => {
  fs.writeFileSync(arquivo, 'segredo-de-app-instalado-123');
  const proprio = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
  const c = loadConfig({ ...base, ERGON_GOOGLE_CLIENT_ID: proprio, ERGON_GOOGLE_CLIENT_SECRET: 'segredo-do-cliente-proprio' });
  assert.equal(c.googleClientId, proprio); assert.equal(c.googleClientSecret, 'segredo-do-cliente-proprio'); assert.equal(c.googleTesting, true);
  const off = loadConfig({ ...base, ERGON_GOOGLE_CLIENT_ID: 'off' });
  assert.equal(off.googleClientId, null); assert.equal(off.googleClientSecret, null);
});
