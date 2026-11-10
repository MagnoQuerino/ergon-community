// Teste-catraca da tradução: nenhum arquivo de tela fora de pendentes.ts tem texto em português escrito direto no
// código (tem de vir do dicionário, por t()), e a lista de pendentes só diminui (arquivo já limpo sai dela). A
// heurística está explicada no começo de varredura.ts; COMO-TRADUZIR.md tem o passo a passo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { varrer } from './varredura.ts';
import { FORA_DA_VARREDURA } from './particao.ts';
import { PENDENTES } from './pendentes.ts';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Os arquivos de tela: tudo em web/src menos o próprio dicionário, os testes e as declarações de tipo. */
function arquivos(dir = SRC): string[] {
  const out: string[] = [];
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const rel = path.relative(SRC, p).split(path.sep).join('/');
    if (fs.statSync(p).isDirectory()) { if (rel !== 'i18n') out.push(...arquivos(p)); continue; }
    if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome) && !nome.endsWith('.d.ts') && !FORA_DA_VARREDURA.includes(rel)) out.push(rel);
  }
  return out.sort();
}

test('catraca: texto de tela em português só nos arquivos ainda pendentes; arquivo limpo sai da lista', () => {
  const pendentes = new Set(Object.values(PENDENTES).flat());
  const erros: string[] = [];
  const vistos = new Set<string>();
  for (const rel of arquivos()) {
    vistos.add(rel);
    const achados = varrer(fs.readFileSync(path.join(SRC, rel), 'utf8'), rel);
    if (pendentes.has(rel)) {
      if (!achados.length) erros.push(`${rel}: já não tem texto escrito direto — tire o arquivo de i18n/pendentes.ts`);
    } else if (achados.length) {
      erros.push(`${rel}: texto de tela fora do dicionário (use t() de i18n/index.ts):\n${achados.slice(0, 15).map((a) => `    linha ${a.linha} (regra ${a.regra}): ${a.texto}`).join('\n')}${achados.length > 15 ? `\n    … e mais ${achados.length - 15}` : ''}`);
    }
  }
  // pendente que não existe: só views/world pode faltar (a Community não traz)
  for (const f of pendentes) if (!vistos.has(f) && !f.startsWith('views/world/')) erros.push(`${f}: está em i18n/pendentes.ts mas não existe`);
  assert.equal(erros.length, 0, `\n${erros.join('\n')}`);
});

test('a varredura acha o texto de tela e deixa de fora o que é código', () => {
  const achou = (src: string) => varrer(src, 'x.tsx').map((a) => a.texto);
  // texto solto no JSX, acentuado, frase, atributo visível, resultado mostrado no JSX, o pt-BR fixo
  assert.deepEqual(achou('const a = <b>Salvar</b>;'), ['Salvar']);
  assert.deepEqual(achou("const a = x === 1 ? 'pronto' : 'não deu';"), ['pronto', 'não deu']);
  assert.deepEqual(achou("const a = 'Foto atualizada.';"), ['Foto atualizada.']);
  assert.deepEqual(achou("const a = 'abrir a conta';"), ['abrir a conta'], 'palavra curta do português');
  assert.deepEqual(achou('const a = <i title="Fechar" aria-label="Fechar o menu" placeholder="Nome" />;'), ['Fechar', 'Fechar o menu', 'Nome']);
  assert.deepEqual(achou("const a = <p>{ok ? 'Pronto' : 'Erro'}</p>;"), ['Pronto', 'Erro']);
  assert.deepEqual(achou("const NAV = [{ id: 'x', label: 'Rotinas' }];"), ['Rotinas']);
  assert.deepEqual(achou("const h = d.toLocaleTimeString('pt-BR');"), ['pt-BR']);
  assert.deepEqual(achou('const a = `Pedir a ${nome}`;'), ['Pedir a']);
  // código: chaves, classes, ids, endereços, ícones, tipos, imports, o 1º argumento de t(), nomes universais
  assert.deepEqual(achou([
    "import { x } from './Configurações.ts';",
    "type M = 'automático' | 'dia';",
    "const v = view === 'conexoes' ? 'equipe' : 'rotinas';",
    'const a = <div className="btn btn--sm nav nav--foot" key="k" id="ws-nome" data-tour="nav-ajuda" href="#configuracao?conta" />;',
    "const b = t('geral.barra.modoFoco');",
    "const c = t(`geral.tema.${m}`);",
    "localStorage.setItem('ergon.nav.compact', 'Não guarde');",
    "const d = api.get('/api/team/agents?limit=1');",
    "const e = { help: 'M12 21a9 9 0 1 0 0-18' };",
    'const f = <kbd>Ctrl K</kbd>;',
    'const g = <span>Microsoft · Google</span>;',
    "const h = { 'Conexões': 1 };",
    "const i = cond && 'pronto' ? 1 : 2;",
  ].join('\n')), []);
  // comparar com o português que o servidor manda também conta (some quando o servidor mandar um código; até lá, i18n-ok)
  assert.deepEqual(achou("const j = status === 'concluída';"), ['concluída']);
  // i18n-ok: de propósito (na linha ou na de cima)
  assert.deepEqual(achou("const re = /^Não foi feito/; const s = 'Não foi feito'; // i18n-ok: reconhece o texto do servidor"), []);
  assert.deepEqual(achou("// i18n-ok: o servidor manda assim\nconst s = 'Concluída';"), []);
  assert.equal(varrer("const a = <b>Salvar</b>;\nconst b = 'Não';", 'x.tsx')[1].linha, 2, 'a linha certa');
});

test('a varredura acha a palavra solta em tabelas, listas, argumentos, padrões e retornos (regra 6)', () => {
  const achou = (src: string) => varrer(src, 'x.tsx').map((a) => a.texto);
  // os casos reais que escapavam: um arquivo "limpo" que ainda mostrava português
  assert.deepEqual(achou("const NOMES = { fixadas: 'Fixadas', recentes: 'Recentes' };"), ['Fixadas', 'Recentes'], 'tabela Record (lib/conversations.ts)');
  assert.deepEqual(achou("const DAYS = ['Dom', 'Seg', 'Ter'];"), ['Dom', 'Seg', 'Ter'], 'lista (RotinasView)');
  assert.deepEqual(achou("indo('answer', 'Responder', 'Enviando…');"), ['Responder', 'Enviando…'], 'argumento de chamada (TaskDetail)');
  assert.deepEqual(achou("function tipo(x: string) { if (x) return 'Planilha'; return 'Arquivo'; }"), ['Planilha', 'Arquivo'], 'return (lib/files.ts)');
  assert.deepEqual(achou("const AREAS = [{ id: 'teatro', name: 'Teatro' }];"), ['Teatro'], 'name (world/areas.ts)');
  assert.deepEqual(achou("const a = <p>{{ conversa: 'Conversas' }[k]}</p>;"), ['Conversas'], 'tabela direto no JSX');
  assert.deepEqual(achou("export function Loading({ label = 'Carregando…' }) { return label; }"), ['Carregando…'], 'valor padrão (brand/Brand.tsx)');
  assert.deepEqual(achou("const f = (l?: string) => l ?? 'Carregando…';"), ['Carregando…'], 'o que a flecha devolve (brand/logo.ts)');
  assert.deepEqual(achou("const vazio = 'Nenhuma';"), ['Nenhuma'], 'valor inicial');
  // quem mostra o texto (regra 4) e a palavra com pontuação (regra 6): ChatPanel, Board, lib/ambient
  assert.deepEqual(achou("setHint('Desfeito.');"), ['Desfeito.']);
  assert.deepEqual(achou("toast('Pronto'); setErr('Excluir?'); const e = { erro: 'Falhou' };"), ['Pronto', 'Excluir?', 'Falhou']);
  assert.deepEqual(achou("toast('salvo'); alert('copiado'); window.confirm('descartar');"), ['salvo', 'copiado', 'descartar'], 'em minúscula também, quando é quem mostra');
  assert.deepEqual(achou("function quando(d: number) { return d === 1 ? 'ontem' : 'hoje'; }"), ['ontem', 'hoje'], 'palavra que só aparece na tela');
  // plural montado num template fora do JSX (AgentesView, engine.ts)
  assert.deepEqual(achou('const a = `${n} agentes`;'), ['agentes']);
  assert.deepEqual(achou("const a = `${n} agente${n === 1 ? '' : 's'}`;"), ['agente']);
  assert.deepEqual(achou("const a = `${n} vaga${n === 1 ? '' : 's'} livre${n === 1 ? '' : 's'}`;"), ['vaga', 'livre']);
  // continua de fora: chaves, comparações, teclas, nomes técnicos e o que vai para a API
  assert.deepEqual(achou([
    "const v = view === 'Cidade' ? 1 : 2;",
    "switch (x) { case 'Rotinas': break; }",
    "const k = ['Enter', 'Escape', 'ArrowUp'].includes(e.key);",
    "const m = { method: 'POST', 'Content-Type': 'application/json' };",
    "const r = { kind: 'atividade', areaId: a.id };",
    "setView('cidade'); setTab('conta');",
    "const s = `card-${id} tarefa-${n}`;",
    "const c = <Icon name=\"Gear\" className=\"Btn\" />;",
    "const b = ['Word', 'Excel', 'Chrome', 'Android'];",
    "const u = `/api/team/${id}/agentes`;",
    "localStorage.setItem('ergon.Tema', 'Noite');",
    "const ok = 'Files'; // i18n-ok: tipo do DataTransfer",
  ].join('\n')), []);
});
