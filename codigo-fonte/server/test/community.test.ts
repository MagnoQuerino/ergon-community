/**
 * O que vale na Community: o cliente do Ergon World vem junto e só liga com o endereço do World; sem ele, o estado diz
 * "não configurado" e tudo local funciona sem serviço externo. E a fronteira: o cliente público não leva nada do
 * serviço privado (SDK e chaves do Stripe, o razão dos créditos em SQL, chaves privadas, código do serviço).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness, req, setupOwner } from './helpers.ts';

const raiz = path.resolve(import.meta.dirname, '..', '..');

test('Community: o cliente do World vem junto, desligado sem endereço, e tudo funciona sem serviço externo', async () => {
  process.env.ERGON_WORLD_URL = '';
  const h = await harness();
  const s = await setupOwner(h);
  const d = await req(h, 'GET', '/api/distribution');
  assert.deepEqual([d.json.distribution, d.json.world.available, d.json.world.configured], ['community', true, false]);
  assert.equal((await req(h, 'GET', '/api/world/status', s)).json.configured, false);
  for (const rota of ['/api/world/billing', '/api/world/wallet', '/api/world/sync']) assert.equal((await req(h, 'GET', rota, s)).status, 404, rota);
  assert.equal((await req(h, 'POST', '/api/tasks', s, { title: 'Funciona sem rede' })).status, 201);
  await h.close();
});

test('fronteira: o cliente público não leva código do serviço privado do World', () => {
  const PROIBIDO: Array<[string, RegExp]> = [
    ['SDK ou API do Stripe', /from ['"]stripe['"]|require\(['"]stripe['"]\)|api\.stripe\.com/],
    ['chave do Stripe', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]|\bwhsec_[A-Za-z0-9]/],
    ['razão dos créditos (SQL)', /milli_?drachma|wallet_lots|ledger_entries|hold_allocations/i],
    ['chave privada', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
    ['código do serviço', /from ['"][^'"]*world\/src\//],
  ];
  const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : arquivos(path.join(d, e.name))) : /\.(ts|tsx|sql|mjs|js)$/.test(e.name) ? [path.join(d, e.name)] : []));
  const achados: string[] = [];
  for (const d of ['server/src', 'server/test', 'web/src']) for (const f of arquivos(path.join(raiz, d))) {
    if (f === import.meta.filename) continue;
    const s = fs.readFileSync(f, 'utf8');
    for (const [nome, re] of PROIBIDO) if (re.test(s)) achados.push(`${path.relative(raiz, f)}: ${nome}`);
  }
  assert.deepEqual(achados, []);
  for (const p of ['package.json', 'server/package.json', 'web/package.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(raiz, p), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const dep of ['stripe', 'pg', 'postgres']) assert.ok(!j.dependencies?.[dep] && !j.devDependencies?.[dep], `${p}: ${dep}`);
  }
  assert.ok(fs.existsSync(path.join(raiz, 'server', 'src', 'world', 'index.ts')), 'o cliente do World está aqui');
});
