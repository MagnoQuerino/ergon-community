// Controle do computador (rc.42): os rótulos que o dono pediu e o passo de permissão para cada caso que o Ergon Desktop
// conta (desktop/src-tauri/src/computador/captura.rs), nos dois idiomas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import geralPt from '../i18n/pt/geral.ts';
import geralEn from '../i18n/en/geral.ts';
import cfgPt from '../i18n/pt/configuracoes.ts';

const raiz = path.resolve(import.meta.dirname, '..', '..', '..');
const ler = (p: string) => fs.readFileSync(path.join(raiz, p), 'utf8');

test('os rótulos do controle: "Assumir o controle", "Conceder o controle", "Ativar acesso total?", "Não perguntar novamente"', () => {
  assert.equal(geralPt['computador.assumir'], 'Assumir o controle');
  assert.equal(geralPt['computador.conceder'], 'Conceder o controle');
  assert.equal(geralPt['computador.ativarTitulo'], 'Ativar acesso total?');
  assert.equal(geralPt['computador.naoPerguntar'], 'Não perguntar novamente');
  assert.deepEqual([geralPt['computador.ativar'], geralPt['computador.soDestaVez'], geralPt['computador.agoraNao']], ['Ativar', 'Só desta vez', 'Agora não']);
  // o selo da área de trabalho (fora do React) usa os mesmos rótulos
  const selo = ler('desktop/ui/computador-selo.js');
  for (const r of [geralPt['computador.assumir'], geralPt['computador.conceder']]) assert.ok(selo.includes(r), r);
});

test('cada passo de permissão que o aplicativo conta tem a sua instrução, em português e em inglês', () => {
  const captura = ler('desktop/src-tauri/src/computador/captura.rs');
  const passos = [...captura.matchAll(/passo: Some\("([a-z_]+)"\)|Some\("([a-z_]+)"\) \} else/g)].map((m) => m[1] ?? m[2]);
  const comp = ler('web/src/components/ComputadorControle.tsx');
  for (const p of new Set([...passos, 'macos_acessibilidade', 'macos_gravacao'])) {
    assert.ok(comp.includes(`'${p}'`), `PASSOS sem ${p}`);
    assert.ok((geralPt as Record<string, unknown>)[`computador.passo.${p}`], `pt sem ${p}`);
    assert.ok((geralEn as Record<string, unknown>)[`computador.passo.${p}`], `en sem ${p}`);
  }
});

test('textos enxutos: o cartão cabe numa olhada (título, uma frase, uma garantia)', () => {
  assert.ok(String(geralPt['computador.ativarTexto']).length <= 100);
  assert.ok(String(geralPt['computador.ativarGarantia']).length <= 100);
  assert.ok(String(cfgPt['computador.sempre']).length <= 70);
});
