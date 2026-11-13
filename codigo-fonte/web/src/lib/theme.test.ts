import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { THEME_ICON, THEME_NEXT, contrasteDe, dataThemeOf, themeOf, type ThemeMode } from './theme.ts';
import { PATHS as ICONES } from './icones.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('alto contraste: a quarta opção do botão do tema, depois do escuro, e volta ao automático', () => {
  const visto: ThemeMode[] = []; let m: ThemeMode = 'auto';
  for (let i = 0; i < 4; i++) { visto.push(m); m = THEME_NEXT[m]; }
  assert.deepEqual(visto, ['auto', 'dia', 'noite', 'contraste']); assert.equal(m, 'auto');
  for (const k of Object.keys(THEME_NEXT) as ThemeMode[]) assert.ok(THEME_ICON[k] in ICONES, `ícone ${THEME_ICON[k]}`);
});

test('alto contraste: escolhido vale sempre; no automático, liga sozinho quando o sistema pede mais contraste', () => {
  assert.equal(contrasteDe('contraste', false), true);
  assert.equal(contrasteDe('auto', true), true);
  assert.equal(contrasteDe('auto', false), false);
  // quem escolheu claro ou escuro de propósito fica com a escolha, mesmo com o pedido do sistema
  assert.equal(contrasteDe('dia', true), false); assert.equal(contrasteDe('noite', true), false);
  assert.equal(dataThemeOf('contraste', 22), 'contraste');
  assert.equal(dataThemeOf('auto', 22, true), 'contraste');
  assert.equal(dataThemeOf('auto', 22, false), 'dark');
  assert.equal(dataThemeOf('auto', 10, false), 'light');
  assert.equal(dataThemeOf('noite', 10, true), 'dark');
  // a Cidade não tem desenho de alto contraste: fica de dia
  assert.equal(themeOf('contraste', 22), 'dia'); assert.equal(themeOf('auto', 22, true), 'dia'); assert.equal(themeOf('auto', 22), 'noite');
});

test('alto contraste: o tema existe na folha de estilos, nos textos (pt e en) e na galeria', () => {
  const css = fs.readFileSync(path.join(here, '..', 'styles.css'), 'utf8');
  assert.match(css, /:root\[data-theme="contraste"\] \{/);
  assert.match(css, /@media \(forced-colors: active\)/);
  for (const l of ['pt', 'en']) {
    const g = fs.readFileSync(path.join(here, '..', 'i18n', l, 'geral.ts'), 'utf8');
    assert.match(g, /'tema\.contraste':/); assert.match(g, /'tema\.contrasteCurto':/);
  }
  assert.match(fs.readFileSync(path.join(here, '..', 'galeria', 'main.tsx'), 'utf8'), /'contraste' \? 'contraste'/);
  assert.match(fs.readFileSync(path.join(here, 'theme.ts'), 'utf8'), /prefers-contrast: more/);
});
