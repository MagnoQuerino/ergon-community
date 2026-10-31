import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { contrast, varsOf } from './contraste.ts';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const light = varsOf(css, ':root');
const dark = { ...light, ...varsOf(css, ':root[data-theme="dark"]') };
const THEMES: Array<[string, Record<string, string>]> = [['claro', light], ['escuro', dark]];

test('texto principal, secundário, de aviso, de sucesso e de erro legíveis nos dois temas (≥ 4,5)', () => {
  const pairs: Array<[string, string]> = [
    ['--ink', '--bg'], ['--ink', '--panel'], ['--ink', '--panel-2'], ['--muted', '--panel'], ['--muted', '--panel-2'], ['--muted', '--bg'],
    ['--warn', '--warn-bg'], ['--ok', '--ok-bg'], ['--err', '--err-bg'], ['--teal', '--panel'], ['--gold-ink', '--panel'],
  ];
  for (const [nome, v] of THEMES) {
    for (const [fg, bg] of pairs) {
      const c = contrast(v[fg], v[bg]);
      assert.ok(c >= 4.5, `${nome}: ${fg} sobre ${bg} = ${c.toFixed(2)} (precisa de 4,5)`);
    }
  }
});

test('nenhuma regra com texto sobre fundo próprio abaixo de 4,5, no claro e no escuro (o amarelo sobre amarelo)', () => {
  const resolve = (val: string, vars: Record<string, string>) => {
    let x = val.trim();
    for (let i = 0; i < 4; i++) { const m = x.match(/^var\((--[\w-]+)(?:,[^)]*)?\)/); if (!m) break; x = vars[m[1]] ?? ''; }
    if (/^#[0-9a-fA-F]{3,6}$/.test(x)) return x;
    // fundo quase opaco (vidro sobre a cidade) conta como a própria cor; translúcido de verdade fica de fora
    const a = x.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
    return /^rgb\(/.test(x) || (a && Number(a[1]) >= 0.7) ? x : null;
  };
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));
  // ajustes próprios do escuro: o seletor ajustado é avaliado pelo ajuste, não pela regra de base
  const darkFixed = rules.filter((r) => r.sel.includes(':root[data-theme="dark"]')).map((r) => r.sel).join(' ');
  const bad: string[] = [];
  for (const r of rules) {
    const bg = r.body.match(/background(?:-color)?\s*:\s*([^;]+);/)?.[1];
    // sem cor própria, o texto herda a cor principal (--ink): o caso do botão claro fixo com texto claro no escuro
    const fg = r.body.match(/(?:^|;|\s)color\s*:\s*([^;]+);/)?.[1] ?? (/font|padding/.test(r.body) ? 'var(--ink)' : undefined);
    if (!bg || !fg) continue;
    const scopedDark = r.sel.includes('data-theme="dark"');
    for (const [nome, vars] of THEMES) {
      if (scopedDark && nome === 'claro') continue;
      if (!scopedDark && nome === 'escuro' && r.sel.split(',').some((s) => darkFixed.includes(s.trim()))) continue;
      const b = resolve(bg, vars); const f = resolve(fg, vars);
      if (!b || !f) continue;
      const c = contrast(b, f);
      if (c < 4.5) bad.push(`${nome} ${c.toFixed(2)}: ${r.sel.slice(0, 80)} (${f} sobre ${b})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('texto nunca menor que 11,5 px (legibilidade)', () => {
  const small = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 11.5);
  assert.deepEqual(small, []);
});
