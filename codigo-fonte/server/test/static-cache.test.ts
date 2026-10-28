import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { harness, tmpDir, type Harness } from './helpers.ts';

describe('frontend compilado: cache', () => {
  let h: Harness;
  before(async () => {
    const web = tmpDir();
    fs.mkdirSync(path.join(web, 'assets'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><script src="/assets/app-abc123.js"></script>');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
    h = await harness({ webDir: web });
  });
  after(async () => { await h.close(); });

  test('index.html nunca fica em cache (atualizações trocam os nomes dos pacotes)', async () => {
    for (const url of ['/', '/index.html', '/ambiente-qualquer']) {
      const res = await h.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers['cache-control']), /no-cache/, url);
    }
  });

  test('pacotes com hash podem ficar em cache longo', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /immutable/);
  });
});
