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
  const chaves = Object.keys(en.equipe).filter((k) => k.startsWith('semente.'));
  assert.equal(chaves.length, TEXTOS_DE_FABRICA.length);
  for (const [nome, d] of [['zh-CN', zhCN], ['hi', hi]] as const) {
    const area = (d.equipe ?? {}) as Record<string, unknown>;
    for (const k of chaves) assert.ok(typeof area[k] === 'string' && (area[k] as string).trim(), `falta em ${nome}: equipe.${k}`);
  }
});
