import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Um hook (useState, useEffect, use…) depois de um "if (…) return" no corpo do componente muda a ordem dos hooks
// entre um render e outro e o React derruba a tela inteira (tela em branco, erro #310). Varredura simples do código:
// no nível do corpo (dois espaços), nenhum hook depois de um retorno antecipado.
test('nenhum componente chama hook depois de um retorno antecipado', () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? arquivos(path.join(d, e.name)) : e.name.endsWith('.tsx') ? [path.join(d, e.name)] : []);
  const achados: string[] = [];
  for (const f of arquivos(raiz)) {
    let comp: string | null = null; let ret = 0;
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      if (/^(export )?(default )?function [A-Z]/.test(l) || /^(export )?const [A-Z]\w* = \(/.test(l)) { comp = l.slice(0, 60); ret = 0; }
      else if (comp && /^ {2}if \(.*\) return\b/.test(l)) ret = i + 1;
      else if (comp && ret && /^ {2}(const|let) .*= use[A-Z]\w*[<(]|^ {2}use[A-Z]\w*\(/.test(l)) achados.push(`${path.relative(raiz, f)}:${i + 1} (retorno na linha ${ret})`);
    });
  }
  assert.deepEqual(achados, []);
});
