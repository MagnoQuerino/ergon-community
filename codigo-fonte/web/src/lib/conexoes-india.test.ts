// rc.48: os conectores da Índia na tela: o logo (a inicial na cor da marca), os textos de cada um nos cinco idiomas (o en-IN
// usa os do inglês) e o motivo do Tally indisponível na nuvem, também traduzido.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pt from '../i18n/pt/conexoes.ts';
import en from '../i18n/en/conexoes.ts';
import hi from '../i18n/hi/conexoes.ts';
import zh from '../i18n/zh-CN/conexoes.ts';
import { TEXTOS_DE_APP, noIdioma } from './textos-de-app.ts';
import type { Integration } from './types.ts';

const KINDS = ['zoho', 'razorpay', 'freshsales', 'tally'];
const logo = readFileSync(new URL('../components/BrandLogo.tsx', import.meta.url), 'utf8');

test('logo e textos de cada conector da Índia, em pt, en, hi e zh-CN', () => {
  for (const k of KINDS) {
    assert.match(logo, new RegExp(`\\n  ${k}: \\{ hex:`), k);
    const x = TEXTOS_DE_APP[k];
    assert.ok(x, k);
    const chaves = [x.sobre, x.passos, x.soon, ...Object.values(x.campos ?? {}).flatMap((c) => [c.rotulo, c.exemplo])].filter(Boolean).map((c) => String(c).replace(/^conexoes\./, ''));
    for (const d of [pt, en, hi, zh] as Array<Record<string, unknown>>) for (const c of chaves) assert.equal(typeof d[c], 'string', `${k}: ${c}`);
  }
  assert.match(String(hi['app.tally.soNuvem']), /[ऀ-ॿ]/); assert.match(String(zh['app.tally.soNuvem']), /[一-龥]/);
});

test('o Tally indisponível na nuvem mostra o motivo no idioma da tela', () => {
  const i = { kind: 'tally', name: 'Tally', auth: 'soon', soon: 'texto do servidor', about: 'x', help: null, fields: [] } as unknown as Integration;
  const t = (c: string) => `[${c}]`;
  assert.equal(noIdioma(i, t as never).soon, '[conexoes.app.tally.soNuvem]');
  assert.equal(noIdioma({ ...i, soon: null } as Integration, t as never).soon, null, 'no computador, nada muda');
});
