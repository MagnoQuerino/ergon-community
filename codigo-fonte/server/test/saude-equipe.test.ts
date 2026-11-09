// Campo "equipe" da saúde do Ergon (/api/health): o Ergon Desktop mostra a etapa "Atualizando a equipe" enquanto ele
// não disser "pronta". Logo depois de uma troca de versão, o motor de cada pessoa passa por "ligando" (o gerente o
// recria na imagem nova) antes de "renovando": as duas contam, senão a etapa quase nunca aparece.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { equipeNaSaude } from '../src/services/motors.ts';
import { harness, req } from './helpers.ts';

test('a saúde diz ligando ou renovando enquanto algum motor não está pronto', () => {
  assert.equal(equipeNaSaude([]), 'pronta', 'sem motores (um motor só, ou ninguém entrou ainda)');
  assert.equal(equipeNaSaude([{ state: 'aberto' }, { state: 'desligado' }, { state: 'erro' }]), 'pronta');
  assert.equal(equipeNaSaude([{ state: 'aberto' }, { state: 'ligando' }]), 'ligando', 'recriando na versão nova');
  assert.equal(equipeNaSaude([{ state: 'ligando' }, { state: 'renovando' }]), 'renovando');
});

const abertos: Array<{ close(): Promise<void> }> = [];
after(async () => { for (const h of abertos) await h.close(); });

test('/api/health leva o campo equipe calculado pelos estados dos motores', async () => {
  const h = await harness();
  abertos.push(h);
  const r = await req(h, 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.equipe, 'pronta');
});
