import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contasLigadas, mostraBotao, telaDoBot, type EstadoBotOficial } from './botOficial.ts';

const base: EstadoBotOficial = { platform: 'telegram', available: false, connection: 'offline', accounts: [] };
const conta = (id: string, status: 'active' | 'paused' | 'revoked') => ({ id, name: 'Maria', linkedAt: '2026-11-16T12:00:00Z', status });

test('bot oficial: sem a plataforma no serviço, "ainda não disponível" e sem botão', () => {
  assert.equal(telaDoBot(base), 'indisponivel');
  assert.equal(mostraBotao(base), false);
});

test('bot oficial: disponível e sem conta mostra o botão; contas desligadas não contam', () => {
  const e = { ...base, available: true, accounts: [conta('bnd_a', 'revoked')] };
  assert.equal(telaDoBot(e), 'livre');
  assert.equal(mostraBotao(e), true);
  assert.deepEqual(contasLigadas(e), []);
});

test('bot oficial: várias contas ligadas (ativa e pausada), cada uma com Desligar; o botão segue para ligar outra', () => {
  const e = { ...base, available: true, accounts: [conta('bnd_a', 'active'), conta('bnd_b', 'paused'), conta('bnd_c', 'revoked')] };
  assert.equal(telaDoBot(e), 'ligado');
  assert.deepEqual(contasLigadas(e).map((a) => a.id), ['bnd_a', 'bnd_b']);
  assert.equal(mostraBotao(e), true);
  // o serviço fora do ar: a conta ligada continua à vista (para desligar)
  assert.equal(telaDoBot({ ...e, available: false }), 'ligado');
});
