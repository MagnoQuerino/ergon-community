import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { criterioSimples, justificativaSimples, linhaDoHistorico, previaDe, type LogRow } from './tarefa-tela.ts';

const nomes: Record<string, string> = { agt_a: 'Aspásia' };
const nomeDe = (id: string | null) => (id ? nomes[id] ?? null : null);
const linha = (x: Partial<LogRow>): LogRow => ({ id: 'e1', actor_type: 'system', actor_id: null, action: 'task.create', evidence: null, result: '', created_at: '2026-11-09T10:00:00Z', ...x });

test('histórico: a entrega vira "Aspásia entregou" e a resposta inteira fica para o "ver mais"', () => {
  const resposta = 'Pesquisei as redes da empresa.\n[[perguntar pergunta="x"]]\nTexto longo da entrega.';
  const l = linhaDoHistorico(linha({ action: 'agent.result.succeeded', actor_type: 'agent', actor_id: 'agt_a', evidence: JSON.stringify({ output: resposta }), result: 'ok' }), nomeDe);
  assert.equal(l.titulo, 'Aspásia entregou');
  assert.equal(l.saida, 'Pesquisei as redes da empresa.\nTexto longo da entrega.', 'sem as linhas de controle');
  assert.equal(l.resumo, null, 'a linha curta não repete a resposta');
});

test('histórico: linhas curtas para o que não é entrega ("Card criado", "Situação: em processamento")', () => {
  assert.equal(linhaDoHistorico(linha({ action: 'task.create', actor_type: 'user' }), nomeDe).titulo, 'Card criado');
  assert.equal(linhaDoHistorico(linha({ action: 'task.update', actor_type: 'user', result: 'título' }), nomeDe).titulo, 'Card alterado');
  const s = linhaDoHistorico(linha({ action: 'task.work_state', result: 'Em processamento — pegou da fila' }), nomeDe);
  assert.equal(s.titulo, 'Situação: em processamento');
  assert.equal(s.detalhe, 'pegou da fila');
  assert.equal(linhaDoHistorico(linha({ action: 'task.queue_start', actor_type: 'agent', actor_id: 'agt_a' }), nomeDe).titulo, 'Aspásia começou a trabalhar');
});

test('"Como foi conferido": palavras de todo dia, e o detalhe técnico só quando o ponto não passou', () => {
  assert.deepEqual(criterioSimples({ id: 'modelo', label: 'x', ok: true, detail: 'nous/modelo-1' }), { texto: 'Escrito pelo agente com a conta de IA', detalhe: null });
  assert.deepEqual(criterioSimples({ id: 'conteudo', label: 'Conteúdo com pelo menos 120 palavras', ok: false, detail: '40 palavras' }), { texto: 'A entrega está completa (não é só um resumo)', detalhe: '40 palavras' });
  assert.equal(justificativaSimples('Concluída com evidência: 5 critérios atendidos, 1 entregável(is) no card.'), 'Tudo o que a conferência pede foi atendido; o arquivo entregue está no card.');
});

test('"Ver": .md formatado, texto, .csv em tabela, imagem e PDF; Word e Excel só baixar', () => {
  assert.equal(previaDe('resultado-T3.md', 'text/markdown'), 'markdown');
  assert.equal(previaDe('notas.txt', 'text/plain'), 'texto');
  assert.equal(previaDe('vendas.csv', 'text/csv'), 'tabela');
  assert.equal(previaDe('foto.png', 'image/png'), 'imagem');
  assert.equal(previaDe('contrato.pdf', 'application/pdf'), 'pdf');
  assert.equal(previaDe('proposta.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'baixar');
  assert.equal(previaDe('planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'baixar');
  assert.equal(previaDe('pagina.html', 'text/html'), 'baixar', 'HTML nunca é mostrado');
});

test('em inglês: as mesmas linhas no idioma da tela, com o nome do agente como está', async () => {
  const { setIdioma } = await import('../i18n/index.ts');
  await setIdioma('en', { guardar: false });
  try {
    const l = linhaDoHistorico(linha({ action: 'agent.result.succeeded', actor_type: 'agent', actor_id: 'agt_a', evidence: JSON.stringify({ output: 'ok' }) }), nomeDe);
    assert.equal(l.titulo, 'Aspásia delivered');
    assert.equal(linhaDoHistorico(linha({ action: 'task.create', actor_type: 'user' }), nomeDe).titulo, 'Card created');
    assert.equal(linhaDoHistorico(linha({ action: 'task.create', actor_type: 'user' }), nomeDe).quem, 'you');
    assert.equal(linhaDoHistorico(linha({ action: 'task.queue_start' }), nomeDe).titulo, 'Started working');
    assert.equal(linhaDoHistorico(linha({ action: 'acao.que.nao.existe' }), nomeDe).titulo, 'Entry');
    assert.equal(criterioSimples({ id: 'modelo', label: 'x', ok: true }).texto, 'Written by the agent with the AI account');
    assert.equal(criterioSimples({ id: 'novo', label: 'Rótulo do servidor', ok: true }).texto, 'Rótulo do servidor', 'ponto sem tradução: o rótulo do servidor');
    assert.equal(justificativaSimples('Concluída com evidência: 5 critérios atendidos, 1 entregável(is) no card.'), 'Everything the check asks for was met; the delivered file is on the card.');
    assert.equal(justificativaSimples('Concluída com evidência: 5 critérios atendidos, 3 entregável(is) no card.'), 'Everything the check asks for was met; the 3 delivered files are on the card.');
    assert.equal(justificativaSimples('Concluída com evidência: 4 critérios atendidos.'), 'Everything the check asks for was met.');
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});

// a tela nunca fala do modo de teste nem jura que é "de verdade": essas frases não existem mais no app
const PROIBIDAS = /n[aã]o simulad[ao]|\(n[aã]o simulada\)|dados reais|n[aã]o [eé] demonstra[cç][aã]o|modo simulado:/i;
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arquivos = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'node_modules' ? [] : arquivos(p);
  return /\.(ts|tsx)$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [p] : [];
});

test('nenhum texto de tela fala em "resposta não simulada", "dados reais" ou "não é demonstração"', () => {
  const achados = [path.join(raiz, 'web', 'src'), path.join(raiz, 'server', 'src')].filter((d) => fs.existsSync(d)).flatMap(arquivos)
    .filter((f) => PROIBIDAS.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(raiz, f));
  assert.deepEqual(achados, []);
});

// Ampliado: a tela também não fala do modo de teste ("simulação", "SIMULADO", o selo "real"). Só os textos que aparecem
// (comentários fora). Exceções, se um dia houver, ficam nesta lista, com o motivo.
const EXCECOES: string[] = [];
const MODO_TESTE = /simula[cç][aã]o|simulad[oa]s?\b|SIMULA[ÇC][ÃA]O|SIMULADO|>\s*real\s*<|\?\s*'simulado'\s*:\s*'real'/;
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('nenhuma tela fala de simulação nem põe o selo "real" (a falta de conta de IA aparece como "sem conta de IA")', () => {
  const telas = arquivos(path.join(raiz, 'web', 'src')).filter((f) => f.endsWith('.tsx'));
  const achados = telas.filter((f) => !EXCECOES.includes(path.relative(raiz, f)) && MODO_TESTE.test(semComentarios(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(raiz, f));
  assert.deepEqual(achados, []);
  // os textos do servidor que vão para a tela (o consumo, a saúde) também
  for (const f of ['server/src/services/usage.ts', 'server/src/services/health.ts']) {
    const texto = semComentarios(fs.readFileSync(path.join(raiz, f), 'utf8'));
    assert.doesNotMatch(texto, /respostas simuladas|modo de simula[cç][aã]o|SIMULADAS/, f);
  }
});

test('inglês da tarefa: o mesmo papel com o mesmo nome, a revisão com o complemento e a leitura do aplicativo sem confundir com a conferência', async () => {
  const { default: en } = await import('../i18n/en/tarefa.ts');
  assert.equal(en['nomes.quemFezInicio'].toLowerCase(), en['nomes.quemFez'], 'quem fez: um termo só');
  assert.match(en['msg.revisaoPedida'], /ask \{autor\} some questions\.$/);
  assert.doesNotMatch(en['acao.naoApareceu'], /\bcheck/i, 'a conferência usa "check"; a leitura do aplicativo não');
});
