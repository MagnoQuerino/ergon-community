// "Rodar na nuvem" nos cartões: o item do menu, o selo e o nome do workspace do World (nuvem-cartao.ts).
//   node --test src/views/world/nuvem-cartao.test.ts   (roda pelo npm test via lib/nuvem-cartao-world.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acompanhar, estadoDoCartao, nomeDoWorkspace, SELO, type CartaoNuvem } from './nuvem-cartao.ts';
import { TEXTOS_WORLD } from './textos.ts';

const base: CartaoNuvem = { ref: 'rotina:rtn_x', where: 'local', badge: null, jobState: null, canSend: true, reason: null, canClaim: false };

test('aqui e pode ir: "Rodar na nuvem" habilitado, sem selo', () => {
  assert.deepEqual(estadoDoCartao(base), { acao: 'enviar', pode: true, motivo: null, selo: null });
});
test('aqui e não pode ir: o item aparece desabilitado com o motivo curto', () => {
  assert.deepEqual(estadoDoCartao({ ...base, canSend: false, reason: 'Espere esta etapa terminar.' }), { acao: 'enviar', pode: false, motivo: 'Espere esta etapa terminar.', selo: null });
});
test('na nuvem: o selo do estado do Job; "Trazer para este computador" só com o Job terminado', () => {
  const r = { ...base, where: 'remote' as const, canSend: false };
  assert.deepEqual(estadoDoCartao({ ...r, badge: 'na_fila' }), { acao: null, pode: false, motivo: null, selo: 'na_fila' });
  assert.deepEqual(estadoDoCartao({ ...r, badge: 'trabalhando' }).acao, null);
  assert.deepEqual(estadoDoCartao({ ...r, badge: 'concluido', canClaim: true }), { acao: 'trazer', pode: true, motivo: null, selo: 'concluido' });
  assert.equal(estadoDoCartao({ ...base, where: 'preparing' }).selo, 'preparando');
  const pt = TEXTOS_WORLD['pt-BR'];
  assert.deepEqual(['na_fila', 'trabalhando', 'concluido', 'falhou'].map((k) => pt[SELO[k as keyof typeof SELO]]), ['Na fila da nuvem', 'Trabalhando na nuvem', 'Concluído na nuvem', 'Falhou na nuvem']);
});
test('relê de leve só enquanto há cartão trabalhando na nuvem', () => {
  assert.equal(acompanhar([base]), false);
  assert.equal(acompanhar([{ ...base, where: 'remote', badge: 'trabalhando' }]), true);
  assert.equal(acompanhar([{ ...base, where: 'remote', badge: 'concluido', canClaim: true }]), false);
});
test('workspace do World: o nome; o código curto só sem nome', () => {
  assert.deepEqual(nomeDoWorkspace({ workspaceId: 'sws_0123456789abcdef', label: 'Laboratório' }), { nome: 'Laboratório' });
  assert.deepEqual(nomeDoWorkspace({ workspaceId: 'sws_0123456789abcdef', label: null }), { codigo: 'sws_01234567…' });
  assert.deepEqual(nomeDoWorkspace({ workspaceId: 'sws_0123456789abcdef', label: '  ' }), { codigo: 'sws_01234567…' });
});
