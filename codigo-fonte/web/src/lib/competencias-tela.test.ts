import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoriasDaLoja, contarOrigens, destaques, ehArquivoDeCompetencia, gradeDaLoja, filtrarInstaladas, filtrarLoja, iconeDaCategoria, instaladas, nomeLegivel, removivel, tipoDoArquivo, verificada,
} from './competencias-tela.ts';
import type { CompetenciaLoja } from './recursos.ts';
import type { AgentSkill, Skill } from './types.ts';

const lib: Skill[] = [
  { name: 'docx', description: 'Documentos do Word', category: 'productivity', enabled: true, origem: 'equipe' },
  { name: 'excel-author', description: 'Planilhas', category: 'finance', enabled: true, origem: 'loja' },
  { name: 'revisar-contratos', description: 'Confere cláusulas de contrato', category: 'enviadas', enabled: true, origem: 'enviada' },
  { name: 'meeting-notes', description: 'Atas de reunião', category: 'notes', enabled: true }, // motor de antes: sem origem
];
const treino = (id: string, status: AgentSkill['status']): AgentSkill => ({ id, agentId: 'agt_1', name: `ergon-x-${id}`, title: `Treino ${id}`, description: 'Jeito de responder', status, version: 1,
  createdAt: '', updatedAt: '', uses: 0, lastUsedAt: null, files: {}, versions: [] } as AgentSkill);

test('instaladas: biblioteca e Treinar numa lista; ligadas primeiro; removidas do Treinar somem', () => {
  const l = instaladas(lib, ['excel-author'], [treino('a', 'ativa'), treino('b', 'desativada'), treino('c', 'removida')]);
  assert.equal(l.length, 6);
  assert.deepEqual(l.slice(0, 2).map((i) => i.titulo).sort(), ['Excel author', 'Treino a']);
  assert.equal(l.find((i) => i.nome === 'meeting-notes')?.origem, 'equipe');
  assert.equal(l.find((i) => i.chave === 'treinar:b')?.ligada, false);
  assert.deepEqual(contarOrigens(l), { treinar: 2, equipe: 2, loja: 1, enviada: 1 });
});

test('filtro das instaladas: deste agente, equipe toda, origem e busca sem acento', () => {
  const l = instaladas(lib, ['excel-author'], [treino('a', 'ativa')]);
  assert.deepEqual(filtrarInstaladas(l, { busca: '', de: 'agente', origem: 'todas' }).map((i) => i.nome).sort(), ['ergon-x-a', 'excel-author']);
  assert.equal(filtrarInstaladas(l, { busca: '', de: 'equipe', origem: 'todas' }).length, 5);
  assert.deepEqual(filtrarInstaladas(l, { busca: '', de: 'equipe', origem: 'enviada' }).map((i) => i.nome), ['revisar-contratos']);
  assert.deepEqual(filtrarInstaladas(l, { busca: 'clausulas contrato', de: 'equipe', origem: 'todas' }).map((i) => i.nome), ['revisar-contratos']);
  assert.deepEqual(filtrarInstaladas(l, { busca: 'reuniao', de: 'equipe', origem: 'todas' }).map((i) => i.nome), ['meeting-notes']);
  assert.ok(removivel(l.find((i) => i.nome === 'excel-author')!));
  assert.ok(!removivel(l.find((i) => i.nome === 'docx')!));
});

const loja: CompetenciaLoja[] = [
  { id: 'official/a/xlsx', nome: 'xlsx', descricao: 'Spreadsheets', fonte: 'official', confianca: 'builtin', categoria: 'productivity', instalada: false },
  { id: 'official/a/pdf', nome: 'pdf', descricao: 'PDF files', fonte: 'official', confianca: 'builtin', categoria: 'productivity', instalada: true },
  { id: 'gh/x/budget', nome: 'budget-planner', descricao: 'Plan a budget', fonte: 'github', confianca: 'community', categoria: 'finance', instalada: false },
  { id: 'gh/x/zz', nome: 'aaa-tool', descricao: 'Something', fonte: 'github', confianca: 'trusted', categoria: 'productivity', instalada: false },
];

test('loja: categorias, filtro, destaques e selo de verificada', () => {
  assert.deepEqual(categoriasDaLoja(loja), [{ categoria: 'productivity', n: 3 }, { categoria: 'finance', n: 1 }]);
  // as não instaladas antes; entre elas, os destaques primeiro
  assert.deepEqual(filtrarLoja(loja, { busca: '', categoria: null }).map((c) => c.nome), ['xlsx', 'aaa-tool', 'budget-planner', 'pdf']);
  assert.deepEqual(filtrarLoja(loja, { busca: 'budget', categoria: null }).map((c) => c.nome), ['budget-planner']);
  assert.deepEqual(filtrarLoja(loja, { busca: '', categoria: 'finance' }).map((c) => c.nome), ['budget-planner']);
  assert.deepEqual(destaques(loja).map((c) => c.nome), ['xlsx'], 'a instalada não aparece em destaque');
  assert.ok(verificada(loja[0]) && verificada(loja[3]) && !verificada(loja[2]));
  assert.equal(iconeDaCategoria('finance'), 'coins');
  assert.equal(iconeDaCategoria('qualquer'), 'bulb');
});

test('o arquivo escolhido: competência pronta ou material de estudo', () => {
  assert.ok(ehArquivoDeCompetencia('SKILL.md'));
  assert.ok(ehArquivoDeCompetencia('minha/skill.md'));
  assert.ok(ehArquivoDeCompetencia('pasta.zip'));
  assert.ok(!ehArquivoDeCompetencia('manual.pdf'));
  assert.ok(!ehArquivoDeCompetencia('notas.md'));
  assert.equal(tipoDoArquivo('SKILL.md'), 'texto');
  assert.equal(tipoDoArquivo('a.zip'), 'zip');
  assert.equal(tipoDoArquivo('a.pdf'), null);
  assert.equal(nomeLegivel('meeting-action-items'), 'Meeting action items');
});

test('a grade da loja não repete os destaques, e o "Mostrar mais" conta só o que falta nela', () => {
  const nomes = ['docx', 'pdf', 'xlsx', 'pptx', ...Array.from({ length: 96 }, (_, i) => `extra-${i}`)];
  const loja = nomes.map((nome) => ({ id: `oficial/${nome}`, nome, descricao: '', categoria: 'x', confianca: 'builtin', instalada: false }) as unknown as CompetenciaLoja);
  const emDestaque = loja.slice(0, 4);
  const grade = gradeDaLoja(loja, emDestaque);
  assert.equal(grade.length, 96);
  assert.ok(!grade.some((c) => emDestaque.includes(c)));
  // com 96 já na tela, nada falta (antes aparecia "Mostrar mais 4" que não mostrava nada)
  assert.equal(grade.length > 96, false);
});

test('telas: o arquivo da competência abre pelo teclado; trocar a chave sem nada não manda; varredura que falhou tenta de novo', async () => {
  const fs = await import('node:fs');
  const ler = (f: string) => fs.readFileSync(new URL(`../components/${f}`, import.meta.url), 'utf8');
  const add = ler('AdicionarCompetencia.tsx');
  assert.match(add, /<input ref=\{input\} type="file" className="sr-only"/, 'o campo de arquivo entra na ordem do Tab');
  assert.doesNotMatch(add, /type="file" hidden/);
  assert.match(ler('OutroAplicativo.tsx'), /if \(!Object\.keys\(valores\)\.length\) throw new Error\(t\('conexoes\.outro\.app\.trocarVazio'\)\)/);
  assert.match(ler('CompetenciasProntas.tsx'), /if \(v\.error\) \{ v\.reload\(\); setErro\(t\('agente\.loja\.varreduraFalhou'\)\); \}/);
});
