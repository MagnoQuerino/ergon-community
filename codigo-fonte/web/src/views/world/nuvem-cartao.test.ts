// "Rodar na nuvem" nos cartões: o item do menu, o selo e o nome do workspace do World (nuvem-cartao.ts).
//   node --test src/views/world/nuvem-cartao.test.ts   (roda pelo npm test via lib/nuvem-cartao-world.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acompanhar, avisoDoModelo, detalheDoResumo, estadoDoCartao, historicoDaFalha, linhaDoResumo, nomeDoWorkspace, SELO, textoDoSelo, type CartaoNuvem } from './nuvem-cartao.ts';
import { TEXTOS_WORLD, tw } from './textos.ts';

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

test('recuperação: selo com a rodada; a falha final mostra o que falhou em cada rodada', () => {
  const r: CartaoNuvem = { ...base, where: 'remote', canSend: false, badge: 'recuperando', recovery: { round: 2, of: 3 } };
  const e = estadoDoCartao(r);
  assert.deepEqual([e.acao, e.selo], [null, 'recuperando']);
  assert.equal(textoDoSelo(r, 'recuperando', tw), 'Recuperando na nuvem (2 de 3)');
  assert.equal(textoDoSelo(r, 'na_fila', tw), 'Na fila da nuvem');
  assert.equal(acompanhar([r]), true, 'rodada em andamento: relê');
  assert.deepEqual(historicoDaFalha(r, tw), [], 'sem falha final, sem histórico');
  const fim: CartaoNuvem = { ...r, badge: 'falhou', canClaim: true, recovery: { round: 3, of: 3 }, history: [{ round: 0, reason: 'o modelo não respondeu' }, { round: 1, reason: 'resposta cortada' }] };
  assert.equal(textoDoSelo(fim, estadoDoCartao(fim).selo!, tw), 'Falhou na nuvem');
  assert.deepEqual(historicoDaFalha(fim, tw), ['Primeira tentativa: o modelo não respondeu', 'Rodada 1: resposta cortada']);
  assert.equal(estadoDoCartao(fim).acao, 'trazer');
  // servidor antigo, sem os campos novos: nada quebra
  assert.deepEqual(historicoDaFalha({ ...base, where: 'remote', badge: 'falhou' }, tw), []);
  assert.equal(textoDoSelo({ ...base }, 'recuperando', tw), 'Recuperando na nuvem (1 de 3)');
});
test('rodou no Ergon AI: o aviso curto com o motivo; sem troca, nada', () => {
  assert.equal(avisoDoModelo({ ...base, fallback: 'sem chave do provedor para a nuvem' }, tw), 'Rodou no Ergon AI: sem chave do provedor para a nuvem');
  assert.equal(avisoDoModelo({ ...base, fallback: null }, tw), null);
  assert.equal(avisoDoModelo(base, tw), null);
});
test('"Enquanto você esteve fora": uma linha com os números que não são zero; nada novo, nada', () => {
  const zero = { concluidos: 0, recuperados: 0, falharam: 0, ergonAi: 0 };
  assert.equal(linhaDoResumo({ counts: zero, items: [] }, tw), null);
  assert.equal(linhaDoResumo(null, tw), null);
  assert.equal(linhaDoResumo({ counts: { concluidos: 3, recuperados: 1, falharam: 1, ergonAi: 2 }, items: [] }, tw), 'Enquanto você esteve fora: 3 concluídos · 1 recuperado · 1 falhou · 2 rodaram no Ergon AI');
  assert.equal(linhaDoResumo({ counts: { ...zero, concluidos: 1 }, items: [] }, tw), 'Enquanto você esteve fora: 1 concluído');
  const item = { ref: 'card:tsk_x', title: 'Relatório', outcome: 'falhou', recovered: false, fallback: null, reason: 'tempo esgotado' };
  assert.equal(detalheDoResumo(item, tw), 'Relatório: falhou (tempo esgotado)');
  assert.equal(detalheDoResumo({ ...item, outcome: 'concluido', recovered: true, fallback: 'provedor não aceito na nuvem', title: null }, tw), 'Card: concluído depois de recuperar · Rodou no Ergon AI: provedor não aceito na nuvem');
});
