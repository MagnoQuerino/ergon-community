import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SITUACAO_LABEL, situacaoDe } from './work.ts';

test('o selo do card no quadro usa as mesmas palavras da situação nos detalhes da tarefa', () => {
  // as mesmas de server/src/services/resumo-tarefa.ts (situacao.texto)
  assert.equal(situacaoDe('aguardando_aprovacao'), 'Esperando sua aprovação');
  assert.equal(situacaoDe('aguardando_info'), 'Precisa de você');
  assert.equal(situacaoDe('processamento'), 'Trabalhando');
  assert.equal(situacaoDe('falha'), 'Não foi feito');
  assert.equal(situacaoDe('revisao'), 'Precisa da sua decisão');
  assert.equal(situacaoDe('concluida'), 'Feito');
  assert.equal(situacaoDe(null), 'Na fila');
  assert.equal(situacaoDe('estado_desconhecido'), 'Na fila');
  assert.equal(Object.keys(SITUACAO_LABEL).length, 9);
});
