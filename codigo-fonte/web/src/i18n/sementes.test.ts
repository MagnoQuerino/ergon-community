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

test('rc.47: as equipes de nicho e as perguntas do primeiro acesso são as do servidor, com tradução em en, zh-CN e hi', async () => {
  const { PRESETS, USES, NICHES } = await import('../../../server/src/services/team-presets.ts');
  const { pt } = await import('./pt/index.ts');
  const P = pt.equipe as Record<string, unknown>;
  const esperado: Record<string, string> = {};
  for (const u of USES) { esperado[`uso.${u.key}.rotulo`] = u.label; esperado[`uso.${u.key}.dica`] = u.hint; }
  for (const n of NICHES) esperado[`nicho.${n.key}`] = n.label;
  for (const p of PRESETS) {
    esperado[`preset.${p.key}.titulo`] = p.title; esperado[`preset.${p.key}.resumo`] = p.summary; esperado[`preset.${p.key}.passo`] = p.firstStep;
    for (const [sk, [nome, desc]] of Object.entries(p.sectors) as Array<[string, [string, string]]>) { esperado[`preset.${p.key}.setor.${sk}`] = nome; esperado[`preset.${p.key}.setorDesc.${sk}`] = desc; }
    for (const a of p.agents) esperado[`preset.${p.key}.papel.${a.char}`] = a.role;
  }
  for (const [k, v] of Object.entries(esperado)) assert.equal(P[k], v, `o português de equipe.${k} não é mais o do servidor`);
  const doDicionario = Object.keys(P).filter((k) => /^(preset|uso|nicho)\./.test(k) && k !== 'preset.geral.titulo' && k !== 'preset.geral.resumo');
  assert.deepEqual(doDicionario.sort(), Object.keys(esperado).sort(), 'chave de preset sem texto no servidor');
  for (const [nome, d] of [['en', en], ['zh-CN', zhCN], ['hi', hi]] as const) {
    const area = (d.equipe ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(esperado)) assert.ok(typeof area[k] === 'string' && (area[k] as string).trim(), `falta em ${nome}: equipe.${k}`);
  }
});

test('rc.47: a ficha da biblioteca (entrega, exame, aprovação, exemplo, entrada, campos, fontes, o que precisa) é a do servidor, com tradução em en, zh-CN e hi', async () => {
  const { CATALOG, SOURCES, NEED_LABEL } = await import('../../../server/src/services/routine-catalog.ts');
  const { pt } = await import('./pt/index.ts');
  const { setIdioma } = await import('./index.ts');
  const { fichaDaRotina } = await import('./sementes.ts');
  const P = pt.rotinas as Record<string, unknown>;
  const dics = [en, zhCN, hi].map((d) => (d.rotinas ?? {}) as Record<string, unknown>);
  const confere = (k: string, v: string | undefined) => {
    if (v === undefined) return;
    assert.equal(P[k], v, k);
    for (const d of dics) assert.ok(typeof d[k] === 'string' && d[k] !== v, `sem tradução: ${k}`);
  };
  for (const r of CATALOG) {
    const c = `catalogo.${r.key}.`;
    confere(c + 'entrega', r.produces); confere(c + 'examina', r.examines); confere(c + 'aprovacao', r.approvals); confere(c + 'exemplo', r.sample);
    confere(c + 'entradaTexto', r.input?.text?.label); confere(c + 'entradaTextoEx', r.input?.text?.placeholder); confere(c + 'entradaArquivos', r.input?.files?.label);
    for (const p of r.params ?? []) { confere(`${c}param.${p.key}`, p.label); if (p.placeholder && !/^https?:/.test(p.placeholder)) confere(`${c}param.${p.key}.ex`, p.placeholder); confere(`${c}param.${p.key}.dica`, p.hint); }
  }
  for (const [k, v] of Object.entries(SOURCES)) confere(`fonte.${k}`, v as string);
  for (const [k, v] of Object.entries(NEED_LABEL)) if (!['microsoft', 'google', 'whatsapp'].includes(k)) confere(`precisa.${k}`, v as string);
  // e a tela usa: em hindi, a ficha de fábrica sai inteira em hindi; um texto mudado pela pessoa fica como está
  const r = CATALOG.find((x: { key: string }) => x.key === 'analista-planilhas')!;
  await setIdioma('hi');
  try {
    const f = fichaDaRotina({ key: r.key, produces: r.produces, examines: r.examines, approvals: 'outro texto', sample: r.sample, sources: [SOURCES.planilhas as string], needs: [{ id: 'planilhas', label: NEED_LABEL.planilhas as string }], input: r.input, params: r.params });
    assert.match(f.produces, /[ऀ-ॿ]/); assert.match(f.sample!, /₹/); assert.equal(f.approvals, 'outro texto');
    assert.match(f.sources[0], /[ऀ-ॿ]/); assert.match(f.needs![0].label, /[ऀ-ॿ]/); assert.match(f.input!.text!.label, /[ऀ-ॿ]/);
  } finally { await setIdioma('pt-BR'); }
});
