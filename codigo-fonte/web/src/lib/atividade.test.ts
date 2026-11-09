import assert from 'node:assert/strict';
import { test } from 'node:test';
import { destinoDaExecucao, destinoDoEvento, destinoDoRegistro, rotuloDaLinha, rotuloDoDestino, type Destino } from './atividade.ts';
import { semJargao } from './textos-tela.ts';

const T = `tsk_${'a'.repeat(32)}`; const C = `cnv_${'b'.repeat(32)}`; const A = `agt_${'c'.repeat(32)}`; const R = `run_${'d'.repeat(32)}`;

test('execução: o card dela; sem card, a conversa; sem as duas, o agente', () => {
  assert.deepEqual(destinoDaExecucao({ task_id: T, conversation_id: C, agent_id: A }), { tipo: 'card', id: T });
  assert.deepEqual(destinoDaExecucao({ task_id: null, conversation_id: C, agent_id: A }), { tipo: 'conversa', agentId: A, conversationId: C });
  assert.deepEqual(destinoDaExecucao({ task_id: null, conversation_id: null, agent_id: A }), { tipo: 'agente', id: A });
  assert.equal(destinoDaExecucao({}), null);
  // a conversa sem o agente não abre (a janela das conversas precisa dele)
  assert.equal(destinoDaExecucao({ conversation_id: C }), null);
});

test('evento de origem: o card que ele virou, se virou', () => {
  assert.deepEqual(destinoDoEvento({ task_id: T }), { tipo: 'card', id: T });
  assert.equal(destinoDoEvento({ task_id: null }), null);
});

test('registro: cada alvo vai para a sua tela; o que não tem tela própria fica sem destino', () => {
  const d = (target_type: string | null, target_id: string | null, actor_type: string | null = 'user', actor_id: string | null = null) => destinoDoRegistro({ target_type, target_id, actor_type, actor_id });
  assert.deepEqual(d('task', T), { tipo: 'card', id: T });
  assert.deepEqual(d('run', R), { tipo: 'execucao', id: R });
  assert.deepEqual(d('agent', A), { tipo: 'agente', id: A });
  assert.deepEqual(d('routine', `rtn_${'e'.repeat(32)}`), { tipo: 'endereco', href: `#rotinas?rotina=rtn_${'e'.repeat(32)}` });
  assert.deepEqual(d('board', `brd_${'f'.repeat(32)}`), { tipo: 'endereco', href: `#tarefas?board=brd_${'f'.repeat(32)}` });
  assert.deepEqual(d('integration', 'trello'), { tipo: 'endereco', href: '#conexoes?app=trello' });
  assert.deepEqual(d('rule', `rul_${'1'.repeat(32)}`), { tipo: 'endereco', href: '#conexoes?regras' });
  assert.deepEqual(d('source_event', `evt_${'2'.repeat(32)}`), { tipo: 'aba', aba: 'eventos' });
  assert.deepEqual(d('conversation', C, 'agent', A), { tipo: 'conversa', agentId: A, conversationId: C });
  assert.equal(d('conversation', C, 'user', 'usr_x'), null, 'sem o agente, a conversa não abre');
  for (const t of ['floor', 'building', 'batch', 'workspace', 'artifact', 'proposal', null]) assert.equal(d(t, `x_${'3'.repeat(32)}`), null, String(t));
  assert.equal(d('task', null), null);
});

test('registro: só identificadores com o formato esperado vão para o endereço ou abrem algo', () => {
  const d = (target_type: string, target_id: string) => destinoDoRegistro({ target_type, target_id });
  assert.equal(d('integration', 'trello&card=x'), null);
  assert.equal(d('integration', '../x'), null);
  assert.equal(d('routine', 'rtn_1?preparo=x'), null);
  assert.equal(d('task', '<b>oi</b>'), null);
  assert.equal(d('board', ''), null);
});

test('o que a linha diz que abre: português, sem jargão', () => {
  const todos: Destino[] = [
    { tipo: 'card', id: T }, { tipo: 'conversa', agentId: A, conversationId: C }, { tipo: 'agente', id: A }, { tipo: 'execucao', id: R },
    { tipo: 'aba', aba: 'eventos' }, { tipo: 'endereco', href: '#rotinas?rotina=x' }, { tipo: 'endereco', href: '#conexoes?app=x' }, { tipo: 'endereco', href: '#tarefas?board=x' },
  ];
  const proibidas = new RegExp(['Her' + 'mes', 'M' + 'G3', 'am' + 'agno', 'fund' + 'ador', 'motor', 'token', 'API', 'contêiner'].join('|'), 'i');
  for (const x of todos) {
    const r = rotuloDoDestino(x);
    assert.ok(semJargao(r), r);
    assert.doesNotMatch(r, proibidas);
    assert.match(r, /^(Abrir|Ver) /);
  }
});

test('o nome da linha para o leitor de tela: o que ela abre e de que linha se trata', () => {
  assert.equal(rotuloDaLinha({ tipo: 'card', id: T }, 'tarefa.criada, 09/11/2026 10:00'), 'Abrir o card: tarefa.criada, 09/11/2026 10:00');
  assert.equal(rotuloDaLinha({ tipo: 'conversa', agentId: A, conversationId: C }, '  Platão,\n 09/11  '), 'Abrir a conversa: Platão, 09/11');
  assert.equal(rotuloDaLinha({ tipo: 'agente', id: A }, '   '), 'Abrir o agente', 'sem resumo: só o que abre');
  for (const d of [{ tipo: 'card', id: T }, { tipo: 'execucao', id: R }, { tipo: 'endereco', href: '#rotinas?rotina=x' }] as Destino[]) assert.ok(semJargao(rotuloDaLinha(d, 'x')));
});
