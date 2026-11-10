import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import pt from '../i18n/pt/geral.ts';
import en from '../i18n/en/geral.ts';

const ler = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const texto = (v: unknown) => (typeof v === 'string' ? v : Object.values(v as Record<string, string>).join(' '));

test('dica do consumo: a nota sai do dicionário pela forma de cobrança, não do texto do servidor (sempre em português)', () => {
  const app = ler('../App.tsx');
  assert.doesNotMatch(app, /usage\.note/, 'a tela não mostra usage.note');
  assert.match(app, /NOTA_COBRANCA\[usage\.billing\]/);
  for (const k of ['notaAssinatura', 'notaCreditos', 'notaApi', 'notaSem'] as const) {
    assert.ok(pt[`consumo.${k}`] && en[`consumo.${k}`], k);
  }
});

test('dica do consumo: o português é o mesmo texto que o servidor manda (NOTE em server/src/services/usage.ts)', (t) => {
  const url = new URL('../../../server/src/services/usage.ts', import.meta.url);
  if (!fs.existsSync(url)) { t.skip('sem o servidor ao lado'); return; }
  const srv = fs.readFileSync(url, 'utf8');
  for (const k of ['notaAssinatura', 'notaCreditos', 'notaApi', 'notaSem'] as const) {
    assert.ok(srv.includes(`'${pt[`consumo.${k}`]}'`), `consumo.${k} difere do servidor`);
  }
});

test('consumo em inglês: chip, dica e notas falam a mesma língua de produto, sem "token"', () => {
  const chaves = Object.keys(en).filter((k) => k.startsWith('consumo.'));
  assert.ok(chaves.length > 5);
  for (const k of chaves) assert.doesNotMatch(texto(en[k as keyof typeof en]), /token/i, k);
});
