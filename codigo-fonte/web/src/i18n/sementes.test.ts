// rc.45: o português de fábrica que a tela traduz (sementes.ts) é exatamente o que o servidor grava ao criar o workspace,
// e cada texto tem tradução no inglês (completo) e no chinês e no hindi.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { TEXTOS_DE_FABRICA } from './sementes.ts';
import { en } from './en/index.ts';
import { zhCN } from './zh-CN/index.ts';
import { hi } from './hi/index.ts';

const SERVIDOR = ['characters.ts', 'sectors.ts', 'seed.ts'].map((f) => fs.readFileSync(new URL(`../../../server/src/services/${f}`, import.meta.url), 'utf8')).join('\n');

test('cada texto de fábrica reconhecido está no servidor, entre aspas, do mesmo jeito', () => {
  for (const s of TEXTOS_DE_FABRICA) assert.ok(SERVIDOR.includes(`'${s}'`), `o servidor não grava mais: ${s}`);
});

test('as funções, os setores e os quadros de fábrica têm tradução em en, zh-CN e hi', () => {
  const chaves = Object.keys(en.equipe).filter((k) => k.startsWith('semente.') && !k.startsWith('semente.bio.'));
  assert.equal(chaves.length, TEXTOS_DE_FABRICA.length);
  for (const [nome, d] of [['zh-CN', zhCN], ['hi', hi]] as const) {
    const area = (d.equipe ?? {}) as Record<string, unknown>;
    for (const k of chaves) assert.ok(typeof area[k] === 'string' && (area[k] as string).trim(), `falta em ${nome}: equipe.${k}`);
  }
});

test('a biblioteca de rotinas: o nome, a frase e o grupo de fábrica são os mesmos do servidor, com tradução em en e zh-CN', async () => {
  const { CATALOG, CATEGORIES } = await import('../../../server/src/services/routine-catalog.ts');
  const { pt } = await import('./pt/index.ts');
  const P = pt.rotinas as Record<string, unknown>; const E = en.rotinas as Record<string, unknown>; const Z = (zhCN.rotinas ?? {}) as Record<string, unknown>;
  for (const r of CATALOG) {
    assert.equal(P[`catalogo.${r.key}.nome`], r.name, r.key);
    assert.equal(P[`catalogo.${r.key}.beneficio`], r.benefit, r.key);
    for (const d of [E, Z]) assert.ok(d[`catalogo.${r.key}.nome`] && d[`catalogo.${r.key}.beneficio`], r.key);
  }
  for (const [k, v] of Object.entries(CATEGORIES)) assert.equal(P[`catalogo.categoria.${k}`], v, k);
});

test('as ferramentas: o nome, a nota e os motivos de fábrica são os mesmos do servidor, com tradução em en e zh-CN', async () => {
  const { TOOLS } = await import('../../../server/src/services/characters.ts');
  const fonte = fs.readFileSync(new URL('../../../server/src/services/characters.ts', import.meta.url), 'utf8');
  const { pt } = await import('./pt/index.ts');
  const P = pt.configuracoes as Record<string, unknown>; const E = en.configuracoes as Record<string, unknown>; const Z = (zhCN.configuracoes ?? {}) as Record<string, unknown>;
  for (const f of Object.values(TOOLS) as Array<{ id: string; label: string; note: string }>) {
    assert.equal(P[`ferramenta.${f.id}.nome`], f.label, f.id);
    assert.equal(P[`ferramenta.${f.id}.nota`], f.note, f.id);
    for (const d of [E, Z]) assert.ok(d[`ferramenta.${f.id}.nome`] && d[`ferramenta.${f.id}.nota`], f.id);
  }
  for (const k of Object.keys(P).filter((x) => x.startsWith('ferramenta.sufixo.'))) assert.ok(fonte.includes(String(P[k])), `o servidor não escreve mais: ${String(P[k])}`);
});

test('a história (bio) dos personagens de fábrica é a mesma do servidor, com tradução em en e zh-CN (hi lê o inglês)', async () => {
  const { CHARACTERS, characterColumns } = await import('../../../server/src/services/characters.ts');
  const { pt } = await import('./pt/index.ts');
  const P = pt.equipe as Record<string, unknown>; const E = en.equipe as Record<string, unknown>; const Z = (zhCN.equipe ?? {}) as Record<string, unknown>;
  for (const c of CHARACTERS) {
    assert.equal(P[`semente.bio.${c.key}`], characterColumns(c).bio, c.key);
    assert.ok(E[`semente.bio.${c.key}`] && Z[`semente.bio.${c.key}`], c.key);
  }
});
