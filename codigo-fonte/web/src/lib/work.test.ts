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

test('os rótulos do quadro trocam de idioma na hora (a tabela lê o dicionário a cada leitura)', async () => {
  const { setIdioma } = await import('../i18n/index.ts');
  const { RESULT_LABEL, WORK_LABEL, DISPLAY_LABEL } = await import('./work.ts');
  try {
    await setIdioma('en', { guardar: false });
    assert.equal(situacaoDe('aguardando_aprovacao'), 'Waiting for your approval');
    assert.equal(situacaoDe('estado_desconhecido'), 'Queued');
    assert.equal(WORK_LABEL.revisao, 'Needs review');
    assert.equal(DISPLAY_LABEL.voce, 'Needs you');
    assert.equal(RESULT_LABEL.confirmado_humano, 'approved by you');
    assert.equal(RESULT_LABEL.inexistente, undefined, 'resultado desconhecido continua sem rótulo');
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
  assert.equal(RESULT_LABEL.reprovado, 'não passou');
  assert.deepEqual(Object.keys(RESULT_LABEL).length, 9);
});

test('a coluna Atualizada fica curta nos dois idiomas (coluna estreita) e o relógio adiantado não vira "daqui a"', async () => {
  const { setIdioma } = await import('../i18n/index.ts');
  const { haQuantoTempo } = await import('./work.ts');
  const agora = Date.parse('2026-11-10T12:00:00Z');
  const antes = (seg: number) => new Date(agora - seg * 1000).toISOString();
  const casos = (): string[] => [antes(20), antes(5 * 60), antes(59 * 60), antes(3 * 3600), antes(26 * 3600), antes(12 * 86_400), antes(-300)].map((iso) => haQuantoTempo(iso, agora));
  assert.deepEqual(casos(), ['agora', 'há 5 min', 'há 59 min', 'há 3 h', 'ontem', 'há 12 dias', 'agora']);
  assert.equal(haQuantoTempo('não é data', agora), '');
  try {
    await setIdioma('en', { guardar: false });
    assert.deepEqual(casos(), ['just now', '5 min ago', '59 min ago', '3 h ago', 'yesterday', '12 days ago', 'just now']);
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});

test('em inglês a posição na fila não repete o "#" do número do card ("#14 #2" confundia)', async () => {
  const { setIdioma, t } = await import('../i18n/index.ts');
  try {
    await setIdioma('en', { guardar: false });
    assert.doesNotMatch(t('quadro.card.posicao', { pos: 2 }), /#/);
    assert.equal(t('quadro.card.posicao', { pos: 2 }), '2 in line');
    assert.match(t('quadro.card.ariaNaFila', { numero: 14, titulo: 'X', pos: 2 }), /^Task #14: X, number 2 in line$/);
    assert.equal(t('quadro.mover.livres', { n: 1 }), '1 free spot');
    assert.equal(t('quadro.mover.livres', { n: 3 }), '3 free spots');
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});
