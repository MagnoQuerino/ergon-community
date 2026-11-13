// Modelos por tarefa (rc.27): a lógica da seção e os textos dela nas duas línguas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import conexoesEn from '../i18n/en/conexoes.ts';
import conexoesPt from '../i18n/pt/conexoes.ts';
import {
  TAREFA_AJUDANTES, TEXTO_DA_TAREFA, comModeloProprio, enderecoDaEconomia, enderecoDaLista, mudancasDaEconomia, situacaoDaEconomia, textoDaTarefa,
  type EconomySuggestion, type OndeRoda, type TaskModelRow, type TaskModels,
} from './modelos-tarefa.ts';

const ler = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const conta = { id: 'nous', name: 'Nous Portal', billing: 'credits' as const };
const principal: OndeRoda = { provider: 'nous', model: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', account: conta };
const linha = (task: string, model: string | null = null, extra: Partial<TaskModelRow> = {}): TaskModelRow => ({
  task, kind: task === TAREFA_AJUDANTES ? 'ajudantes' : 'apoio', provider: model ? 'nous' : null, model,
  runs: model ? { provider: 'nous', model, label: model, account: conta } : principal, ...extra,
});
// as tarefas de apoio do motor (v0.22.2), na ordem em que ele devolve
const DO_MOTOR = ['vision', 'compression', 'skills_hub', 'approval', 'mcp', 'title_generation', 'review', 'voice_chat', 'triage_specifier', 'kanban_decomposer', 'profile_describer', 'curator', 'background_review'];
const pt = conexoesPt as Record<string, unknown>; const en = conexoesEn as Record<string, unknown>;

test('toda tarefa do motor e os ajudantes têm nome claro e uma linha do que faz, em português e em inglês', () => {
  for (const task of [...DO_MOTOR, TAREFA_AJUDANTES]) {
    const x = textoDaTarefa({ task });
    assert.ok('chave' in x.nome && x.oque && 'chave' in x.oque, task);
    for (const chave of [x.nome.chave, x.oque.chave]) {
      const k = chave.replace(/^conexoes\./, '');
      for (const [lingua, d] of [['pt', pt], ['en', en]] as const) {
        const texto = d[k];
        assert.equal(typeof texto, 'string', `${lingua} ${k}`);
        assert.ok(String(texto).trim().length >= 6, `${lingua} ${k}`);
        // o nome é para gente: nunca a chave composta do motor (skills_hub, title_generation…), nem jargão
        assert.doesNotMatch(String(texto), new RegExp(`\\b(${task.includes('_') ? task : 'hermes'}|hermes|token|tokens|API|MCP|kanban|motor|engine|cont[êe]iner|container|plugin|subagent\\w*)\\b`, 'i'), `${lingua} ${k}: ${String(texto)}`);
      }
      assert.notEqual(pt[k], en[k], k);
    }
    // o nome é curto (cabe ao lado do seletor); a explicação é uma frase
    assert.ok(String(pt[`tarefa.${task}.nome`]).length <= 32 && String(en[`tarefa.${task}.nome`]).length <= 32, task);
    assert.match(String(pt[`tarefa.${task}.oque`]), /\.$/, task);
  }
  assert.deepEqual(Object.keys(TEXTO_DA_TAREFA).sort(), [...DO_MOTOR, TAREFA_AJUDANTES].sort());
});

test('tarefa que a tela não conhece aparece de qualquer jeito: com o que o complemento declarou, ou com a própria chave', () => {
  assert.deepEqual(textoDaTarefa({ task: 'memoria_longa', declared: { label: 'Long memory', hint: 'Recalls old notes', by: 'memoria', follows: 'compression' } }),
    { nome: { texto: 'Long memory' }, oque: { texto: 'Recalls old notes' } });
  assert.deepEqual(textoDaTarefa({ task: 'memoria_longa', declared: { label: '', hint: '', by: 'memoria', follows: null } }), { nome: { texto: 'memoria_longa' }, oque: null });
  assert.deepEqual(textoDaTarefa({ task: 'tarefa_nova_do_motor' }), { nome: { texto: 'tarefa_nova_do_motor' }, oque: null });
  // nome de propriedade herdada não vira tarefa conhecida
  assert.deepEqual(textoDaTarefa({ task: 'constructor' }), { nome: { texto: 'constructor' }, oque: null });
});

test('o resumo da seção recolhida: quantas têm modelo próprio', () => {
  const tm: TaskModels = { supported: true, main: principal, tasks: [linha('vision'), linha('compression', 'deepseek/flash'), linha('title_generation', 'deepseek/flash'), linha(TAREFA_AJUDANTES)] };
  assert.equal(comModeloProprio(tm), 2);
  assert.equal(comModeloProprio({ ...tm, tasks: tm.tasks.map((t) => linha(t.task)) }), 0);
  assert.equal(comModeloProprio(null), 0);
});

test('a economia: aplicar manda exatamente o que a prévia mostrou; e cada motivo de não haver nada a aplicar', () => {
  const barato = { provider: 'nous', model: 'deepseek/flash', label: 'Deepseek Flash', tier: 'econômico' as const, input: 0.2, output: 0.8, account: conta };
  const imagens = { ...barato, model: 'google/mini' };
  const s: EconomySuggestion = { model: barato, reason: null, kept: [{ task: 'title_generation', reason: 'same' }],
    changes: [{ task: 'vision', from: principal, to: imagens }, { task: 'compression', from: principal, to: barato }] };
  assert.deepEqual(mudancasDaEconomia(s), [{ task: 'vision', provider: 'nous', model: 'google/mini' }, { task: 'compression', provider: 'nous', model: 'deepseek/flash' }]);
  assert.equal(situacaoDaEconomia(s), 'mudancas');
  assert.equal(situacaoDaEconomia({ ...s, changes: [] }), 'jaEsta');
  const nada = { model: null, changes: [], kept: [] };
  assert.equal(situacaoDaEconomia({ ...nada, reason: 'main' }), 'principal');
  assert.equal(situacaoDaEconomia({ ...nada, reason: 'none' }), 'semModelo');
  assert.equal(situacaoDaEconomia({ ...nada, reason: 'unsupported' }), 'atualizar');
  assert.deepEqual(mudancasDaEconomia({ ...nada, reason: 'main' }), []);
});

test('os endereços: da equipe da pessoa ou do perfil do agente', () => {
  assert.equal(enderecoDaLista(), '/api/ai/task-models');
  assert.equal(enderecoDaLista(null), '/api/ai/task-models');
  assert.equal(enderecoDaLista('socrates'), '/api/ai/task-models?perfil=socrates');
  assert.equal(enderecoDaEconomia(), '/api/ai/task-models/economy');
  assert.equal(enderecoDaEconomia('socrates'), '/api/ai/task-models/economy?perfil=socrates');
});

test('os textos da seção: "Usar o principal", o botão da economia, o que muda antes de aplicar e de onde sai o custo', () => {
  assert.equal(pt['tarefas.titulo'], 'Modelos por tarefa');
  assert.equal(en['tarefas.titulo'], 'Models by task');
  assert.equal(pt['tarefas.usarPrincipal'], 'Usar o principal');
  assert.equal(pt['economia.botao'], 'Usar modelos econômicos nas tarefas de apoio');
  assert.match(String(pt['tarefas.custo']), /\{conta\}/); assert.match(String(en['tarefas.custo']), /\{conta\}/);
  for (const m of ['{tarefa}', '{de}', '{contaDe}', '{para}', '{contaPara}']) { assert.ok(String(pt['economia.linha']).includes(m), m); assert.ok(String(en['economia.linha']).includes(m), m); }
  // nenhum texto novo com o nome do motor ou com jargão, nas duas línguas
  for (const d of [pt, en]) {
    for (const [k, v] of Object.entries(d)) {
      if (!/^(tarefas|tarefa|economia)\./.test(k)) continue;
      const texto = typeof v === 'string' ? v : JSON.stringify(v);
      assert.doesNotMatch(texto, /hermes|\btokens?\b|\bAPI\b|\bmotor\b|\bengine\b|cont[êe]iner|container|endpoint|plugin/i, k);
      assert.doesNotMatch(texto, /\b(o|the) Ergon (sabe|lê|acha|decide|knows|reads|thinks|decides)/i, k);
    }
  }
});

test('a tela: seção recolhida, em Conexões e na janela do agente, com o seletor das contas conectadas e sem botão desabilitado', () => {
  const src = ler('../components/ModelosPorTarefa.tsx');
  assert.match(src, /<details className="modelos-tarefa">/);
  assert.doesNotMatch(src, /<details[^>]*\bopen\b/, 'abre recolhida');
  assert.doesNotMatch(src, /\bdisabled\b/, 'nada de botão desabilitado esperando');
  // todas as linhas que o servidor mandar, sem filtro por tarefa
  assert.match(src, /tm\.tasks\.map\(/);
  assert.doesNotMatch(src, /tm\.tasks\.filter\(/);
  // o mesmo seletor do modelo padrão (os modelos das contas conectadas), com "Usar o principal" como a opção sem escolha
  assert.match(src, /<ModelSelect [^>]*defaultLabel=\{principal\}/);
  assert.match(src, /t\('conexoes\.tarefas\.usarPrincipalCom'/);
  assert.match(src, /t\('conexoes\.tarefas\.custo', \{ conta: conta\(row\.runs\.account\) \}\)/);
  // a economia: primeiro a prévia (GET), e só o botão Aplicar grava (PUT) o que a prévia mostrou
  assert.match(src, /api\.get<EconomySuggestion>\(enderecoDaEconomia\(perfil\)\)/);
  assert.match(src, /gravar\(mudancasDaEconomia\(previa\)/);
  assert.ok(src.indexOf("t('conexoes.economia.titulo')") < src.indexOf("t('conexoes.economia.aplicar')"));
  assert.match(ler('../components/ModeloPadrao.tsx'), /<ModelosPorTarefa \/>/);
  // na janela do agente: os do perfil dele no motor (rc.27); os da equipe só enquanto o perfil não fica pronto
  assert.match(ler('../components/AgentWindow.tsx'), /<ModelosPorTarefa perfil=\{agent\.hermesPerfil \?\? null\} deTodaEquipe=\{!agent\.hermesPerfil\} \/>/);
  assert.match(ler('../components/AgentProfile.tsx'), /defaultLabel \?\? \(/);
});
