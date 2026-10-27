/**
 * O que vale na Community (COMMUNITY.json na raiz): o módulo opcional não existe, /api/world/* não responde e a
 * distribuição se declara Community. Com o módulo presente, este arquivo só confere que a Community continua
 * ligável por configuração.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness, req, setupOwner } from './helpers.ts';

const exportada = fs.existsSync(path.resolve(import.meta.dirname, '..', '..', 'COMMUNITY.json'));

test('Community: sem o módulo opcional e sem as rotas dele, funcionando sem serviço externo', async () => {
  if (exportada) assert.equal(fs.existsSync(path.resolve(import.meta.dirname, '..', 'src', 'world')), false, 'a exportação não pode levar server/src/world');
  const h = await harness({ distribution: 'community' });
  const s = await setupOwner(h);
  const d = await req(h, 'GET', '/api/distribution');
  assert.deepEqual([d.json.distribution, d.json.world.available], ['community', false]);
  for (const rota of ['/api/world/status', '/api/world/account', '/api/wallet', '/api/billing/state']) assert.equal((await req(h, 'GET', rota, s)).status, 404, rota);
  assert.equal((await req(h, 'POST', '/api/tasks', s, { title: 'Funciona sem rede' })).status, 201);
});
