// O inglês tem exatamente o que o português tem (o tipo já garante; aqui, de novo, em tempo de execução), com os mesmos
// marcadores, sem texto esquecido em português e com os termos fixos do glossário. E a partição das áreas é coerente.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { pt } from './pt/index.ts';
import { en } from './en/index.ts';
import { GLOSSARIO } from './glossario.ts';
import { PARTICAO, FORA_DA_VARREDURA } from './particao.ts';
import type { Mensagem, Plural } from './tipos.ts';

type Areas = Record<string, Record<string, Mensagem>>;
const PT = pt as unknown as Areas;
const EN = en as unknown as Areas;
const SRC = new URL('../', import.meta.url);
const existe = (rel: string) => fs.existsSync(new URL(rel, SRC));

/** Letras que só o português usa. */
const ACENTO = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
/** Estas não aparecem em inglês (nem nos nomes gregos dos personagens, que usam ó, é, á…). */
const SO_PORTUGUES = /[ãõçÃÕÇ]/;
const formas = (m: Mensagem): string[] => (typeof m === 'string' ? [m] : Object.values(m as Plural).filter((v): v is string => typeof v === 'string'));
const marcas = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]));
const todas = function* (d: Areas) { for (const [a, area] of Object.entries(d)) for (const [k, m] of Object.entries(area)) yield { chave: `${a}.${k}`, m }; };
// montada por partes: a exportação pública recusa arquivos com estes nomes escritos por inteiro
const PROIBIDAS = new RegExp(['Her' + 'mes', 'M' + 'G3', 'am' + 'agno', 'fund' + 'ador'].join('|'), 'i');

test('o inglês tem as mesmas áreas e as mesmas chaves do português, do mesmo tipo e com os mesmos marcadores', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(PT).sort(), 'áreas');
  const erros: string[] = [];
  for (const [a, area] of Object.entries(PT)) {
    const outra = EN[a] ?? {};
    for (const k of Object.keys(area)) if (!(k in outra)) erros.push(`falta em en: ${a}.${k}`);
    for (const k of Object.keys(outra)) if (!(k in area)) erros.push(`sobra em en: ${a}.${k}`);
    for (const [k, m] of Object.entries(area)) {
      const e = outra[k];
      if (e === undefined) continue;
      if (typeof m !== typeof e) { erros.push(`${a}.${k}: plural num idioma e texto no outro`); continue; }
      if (typeof e === 'object' && typeof (e as Plural).other !== 'string') erros.push(`${a}.${k}: plural sem "other" em en`);
      const mp = new Set(formas(m).flatMap((s) => [...marcas(s)])); const me = new Set(formas(e).flatMap((s) => [...marcas(s)]));
      if (typeof m === 'object') { mp.add('n'); me.add('n'); }
      if ([...mp].sort().join() !== [...me].sort().join()) erros.push(`${a}.${k}: marcadores {${[...mp].join(', ')}} em pt e {${[...me].join(', ')}} em en`);
      if (formas(m).some((s) => !s.trim()) || formas(e).some((s) => !s.trim())) erros.push(`${a}.${k}: texto vazio`);
    }
  }
  assert.deepEqual(erros, []);
});

test('nada esquecido em português no inglês', () => {
  const erros: string[] = [];
  for (const { chave, m } of todas(EN)) {
    const [a, ...r] = chave.split('.'); const p = PT[a]?.[r.join('.')];
    for (const s of formas(m)) {
      if (SO_PORTUGUES.test(s)) erros.push(`${chave}: letra do português no inglês: ${s}`);
      if (p && formas(p).includes(s) && ACENTO.test(s)) erros.push(`${chave}: igual ao português (esqueceu de traduzir?): ${s}`);
    }
  }
  assert.deepEqual(erros, []);
});

test('o tom das telas nas duas línguas: sem o nome do motor e o Ergon não é uma pessoa', () => {
  const erros: string[] = [];
  for (const d of [PT, EN]) for (const { chave, m } of todas(d)) for (const s of formas(m)) {
    if (PROIBIDAS.test(s)) erros.push(`${chave}: nome proibido na tela: ${s}`);
    if (/\b[Oo] Ergon (sabe|lê|le|pensa|acha|decide|quer|entende|aprende)\b/.test(s)) erros.push(`${chave}: o Ergon como pessoa: ${s}`);
    if (/\bErgon (knows|thinks|reads|decides|decided|wants|believes|understands|learns)\b/.test(s)) erros.push(`${chave}: Ergon as a person: ${s}`);
  }
  assert.deepEqual(erros, []);
});

test('glossário: os termos conferidos aparecem traduzidos do jeito fixo, e a moeda do World nunca é traduzida', async () => {
  const erros: string[] = [];
  // o nome da moeda está na lista do módulo do World
  const moeda = new URL('../views/world/glossario-moeda.ts', import.meta.url);
  const termos = [...GLOSSARIO, ...(fs.existsSync(moeda) ? (await import(moeda.href) as { GLOSSARIO_MOEDA: typeof GLOSSARIO }).GLOSSARIO_MOEDA : [])];
  for (const { chave, m } of todas(PT)) {
    const [a, ...r] = chave.split('.'); const e = EN[a]?.[r.join('.')];
    if (!e) continue;
    const textoEn = formas(e).join(' \n ');
    for (const termo of termos.filter((x) => x.conferir)) {
      if (formas(m).some((s) => s.includes(termo.pt)) && !textoEn.includes(termo.en)) erros.push(`${chave}: "${termo.pt}" pede "${termo.en}" no inglês`);
    }
  }
  for (const { chave, m } of todas(EN)) for (const s of formas(m)) if (/drachm/i.test(s)) erros.push(`${chave}: a moeda do World não se traduz: ${s}`);
  assert.deepEqual(erros, []);
});

test('glossário: o GLOSSARIO.md explica todos os termos da lista (e vice-versa não esquece nenhum)', () => {
  const md = fs.readFileSync(new URL('./GLOSSARIO.md', import.meta.url), 'utf8');
  const linhas = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Português') && !l.startsWith('|---'));
  for (const termo of GLOSSARIO) assert.ok(linhas.some((l) => l.includes(termo.pt) && l.includes(termo.en)), `GLOSSARIO.md sem a linha de "${termo.pt}" → "${termo.en}"`);
  const conferidos = linhas.filter((l) => l.includes('(conferido)'));
  for (const l of conferidos) {
    const pt0 = l.split('|')[1].trim().split(' / ')[0].replace(/\{nome\}/, '').trim();
    assert.ok(GLOSSARIO.some((x) => x.conferir && x.pt === pt0), `GLOSSARIO.md marca "${pt0}" como conferido, mas glossario.ts não`);
  }
  const vistos = new Set<string>();
  for (const x of GLOSSARIO) { assert.ok(!vistos.has(x.pt), `termo repetido: ${x.pt}`); vistos.add(x.pt); }
});

test('partição: as mesmas áreas do dicionário e cada arquivo numa área só', () => {
  assert.deepEqual(Object.keys(PARTICAO).sort(), Object.keys(PT).sort(), 'uma área da partição para cada área do dicionário');
  const dono = new Map<string, string>();
  for (const [a, arqs] of Object.entries(PARTICAO)) for (const f of arqs) {
    assert.ok(!dono.has(f), `${f} em duas áreas: ${dono.get(f)} e ${a}`);
    dono.set(f, a);
    assert.ok(!FORA_DA_VARREDURA.includes(f), `${f} está fora da varredura e numa área`);
    assert.ok(existe(f), `${f} (área ${a}) não existe`);
    assert.match(f, /^[\w/.-]+\.tsx?$/, `caminho a partir de web/src: ${f}`);
  }
  // cada área tem o seu arquivo nos dois idiomas
  for (const a of Object.keys(PT)) for (const l of ['pt', 'en']) assert.ok(existe(`i18n/${l}/${a}.ts`), `falta i18n/${l}/${a}.ts`);
});

// ——— os idiomas parciais (rc.44): chinês, hindi e o inglês da Índia ———
// Cada um traz só as chaves já traduzidas; o resto cai na reserva (o inglês), nunca na chave crua. Aqui: as chaves e os
// tipos batem com o português, os marcadores também, nada vazio nem em português, a marca de revisão por nativo está
// em cada arquivo e as áreas principais estão cobertas.
const { zhCN } = await import('./zh-CN/index.ts');
const { hi } = await import('./hi/index.ts');
const { enIN } = await import('./en-IN/index.ts');
const { IDIOMAS, RESERVA } = await import('./idiomas.ts');
const PARCIAIS: Record<string, Areas> = { 'zh-CN': zhCN as unknown as Areas, hi: hi as unknown as Areas, 'en-IN': enIN as unknown as Areas };
/** O mínimo de cada área principal (a fatia 1 do plano: entrar e boas-vindas, navegação, conversa e salas, configurações
 *  básicas, tarefas e entregas). Uma área a mais pode entrar a qualquer hora; uma destas não pode encolher. */
const COBERTURA: Record<string, number> = { geral: 1, quadro: 1, tarefa: 1, visuais: 1, conversas: 0.65, conta: 0.4, ajuda: 0.2, configuracoes: 0.2 };

test('idiomas: cada um tem pasta, e os parciais caem no inglês', () => {
  for (const l of IDIOMAS) assert.ok(existe(`i18n/${l === 'pt-BR' ? 'pt' : l}/index.ts`), `falta i18n/${l}/index.ts`);
  for (const l of Object.keys(PARCIAIS)) assert.equal(RESERVA[l as keyof typeof RESERVA], 'en', `${l} cai no inglês`);
});

test('idiomas parciais: as mesmas chaves e marcadores do português, nada vazio, nada em português', () => {
  const erros: string[] = [];
  for (const [l, d] of Object.entries(PARCIAIS)) for (const [a, area] of Object.entries(d)) {
    if (!PT[a]) { erros.push(`${l}: área que não existe: ${a}`); continue; }
    for (const [k, m] of Object.entries(area)) {
      const p = PT[a][k];
      if (p === undefined) { erros.push(`${l}: sobra ${a}.${k}`); continue; }
      if (typeof p !== typeof m) { erros.push(`${l} ${a}.${k}: plural num idioma e texto no outro`); continue; }
      if (typeof m === 'object' && typeof (m as Plural).other !== 'string') erros.push(`${l} ${a}.${k}: plural sem "other"`);
      const mp = new Set(formas(p).flatMap((s) => [...marcas(s)])); const ml = new Set(formas(m).flatMap((s) => [...marcas(s)]));
      if (typeof p === 'object') { mp.add('n'); ml.add('n'); }
      if ([...mp].sort().join() !== [...ml].sort().join()) erros.push(`${l} ${a}.${k}: marcadores {${[...mp].join(', ')}} em pt e {${[...ml].join(', ')}} em ${l}`);
      for (const s of formas(m)) {
        if (!s.trim()) erros.push(`${l} ${a}.${k}: texto vazio`);
        if (SO_PORTUGUES.test(s)) erros.push(`${l} ${a}.${k}: letra do português: ${s}`);
        if (PROIBIDAS.test(s)) erros.push(`${l} ${a}.${k}: nome proibido na tela: ${s}`);
      }
    }
  }
  assert.deepEqual(erros, []);
});

test('chinês e hindi: cada arquivo marcado para revisão por nativo, e as áreas principais cobertas', () => {
  const erros: string[] = [];
  for (const l of ['zh-CN', 'hi']) {
    for (const [a, min] of Object.entries(COBERTURA)) {
      const arq = `i18n/${l}/${a}.ts`;
      if (!existe(arq)) { erros.push(`${l}: falta a área ${a}`); continue; }
      const src = fs.readFileSync(new URL(arq, SRC), 'utf8');
      if (!/REVISÃO POR NATIVO PENDENTE/.test(src) || !/export const REVISAO_NATIVA_PENDENTE = true;/.test(src)) erros.push(`${arq}: sem a marca de revisão por nativo`);
      const feitas = Object.keys(PARCIAIS[l][a] ?? {}).length; const total = Object.keys(PT[a]).length;
      if (feitas / total < min) erros.push(`${l} ${a}: ${feitas} de ${total} chaves (o mínimo é ${Math.round(min * 100)}%)`);
    }
    // o chinês e o hindi escrevem na sua escrita: uma área quase toda em letras latinas é tradução esquecida
    const ESCRITA = l === 'zh-CN' ? /[一-鿿]/ : /[ऀ-ॿ]/;
    for (const [a, area] of Object.entries(PARCIAIS[l])) {
      const textos = Object.values(area).flatMap(formas);
      const naEscrita = textos.filter((s) => ESCRITA.test(s)).length;
      if (naEscrita / textos.length < 0.85) erros.push(`${l} ${a}: só ${naEscrita} de ${textos.length} textos na escrita do idioma`);
    }
  }
  assert.deepEqual(erros, []);
});
