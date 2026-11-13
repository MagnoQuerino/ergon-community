import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// rc.29: o cartão "Conquistas e mascotes" saiu de Capacidades da equipe (pedido do dono: sem função para a pessoa e
// com nomes de dentro do motor). Nem a tela, nem os textos, nem a chamada voltam.
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p: string) => fs.readFileSync(path.join(src, p), 'utf8');

test('conquistas: fora da tela, dos textos pt/en e da biblioteca de capacidades', () => {
  const painel = ler('components/CapacidadesPanel.tsx');
  assert.doesNotMatch(painel, /Conquista|\/conquistas|cap\.conquistas/);
  for (const l of ['pt', 'en']) assert.doesNotMatch(ler(`i18n/${l}/configuracoes.ts`), /cap\.conquistas/, l);
  assert.doesNotMatch(ler('lib/recursos.ts'), /Conquista/);
});
