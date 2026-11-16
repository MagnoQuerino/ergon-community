// Os textos do World (textos.ts) com as mesmas conferências do dicionário da tela (i18n/completude.test.ts): o inglês
// tem as mesmas chaves e os mesmos marcadores, nada esquecido em português, a moeda nunca traduzida e o tom das telas.
// Fica no módulo do World (views/world).
//   node --test src/views/world/textos.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEXTOS_WORLD } from './textos.ts';
import { GLOSSARIO } from '../../i18n/glossario.ts';
import { GLOSSARIO_MOEDA } from './glossario-moeda.ts';
import type { Mensagem, Plural } from '../../i18n/tipos.ts';

const PT = TEXTOS_WORLD['pt-BR'];
const EN = TEXTOS_WORLD.en;
const formas = (m: Mensagem): string[] => (typeof m === 'string' ? [m] : Object.values(m as Plural).filter((v): v is string => typeof v === 'string'));
const marcas = (m: Mensagem) => new Set([...formas(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])), ...(typeof m === 'object' ? ['n'] : [])]);
// montada por partes, como no teste de completude
const PROIBIDAS = new RegExp(['Her' + 'mes', 'M' + 'G3', 'am' + 'agno', 'fund' + 'ador'].join('|'), 'i');

test('World: o inglês tem as mesmas chaves do português, do mesmo tipo e com os mesmos marcadores', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(PT).sort());
  for (const [k, m] of Object.entries(PT)) {
    const e = EN[k];
    assert.equal(typeof e, typeof m, `${k}: plural num idioma e texto no outro`);
    assert.deepEqual([...marcas(e)].sort(), [...marcas(m)].sort(), `${k}: marcadores diferentes`);
    for (const s of [...formas(m), ...formas(e)]) assert.ok(s.trim(), `${k}: texto vazio`);
  }
});

test('World: nada esquecido em português no inglês, e o tom das telas', () => {
  for (const [k, e] of Object.entries(EN)) for (const s of formas(e)) {
    assert.doesNotMatch(s, /[ãõçÃÕÇáéíóúâêôÁÉÍÓÚÂÊÔ]/, `${k}: letra do português no inglês: ${s}`);
    assert.doesNotMatch(s, /\btokens?\b|\bengine\b|\bcontainer\b/i, `${k}: jargão técnico no inglês: ${s}`);
    assert.doesNotMatch(s, /\bErgon (knows|thinks|reads|decides|decided|wants|believes|understands|learns)\b/, `${k}: Ergon as a person: ${s}`);
  }
  for (const d of [PT, EN]) for (const [k, m] of Object.entries(d)) for (const s of formas(m)) assert.doesNotMatch(s, PROIBIDAS, `${k}: nome proibido na tela`);
});

test('World: os termos conferidos do glossário e a moeda, que nunca se traduz', () => {
  for (const [k, m] of Object.entries(PT)) {
    const textoEn = formas(EN[k]).join(' \n ');
    for (const termo of [...GLOSSARIO, ...GLOSSARIO_MOEDA].filter((x) => x.conferir)) {
      if (formas(m).some((s) => s.includes(termo.pt))) assert.ok(textoEn.includes(termo.en), `${k}: "${termo.pt}" pede "${termo.en}" no inglês`);
    }
  }
  for (const [k, e] of Object.entries(EN)) for (const s of formas(e)) assert.doesNotMatch(s, /drachm/i, `${k}: a moeda do World não se traduz`);
});
