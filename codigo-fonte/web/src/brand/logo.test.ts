import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRAND, CORE_R, EMBLEM_BOX, emblemSvg, figures, lockupLayout, logoSvg, splashHtml, wordmark } from './logo.ts';

test('emblema: cinco pessoas (três azul-marinho em cima, duas verde-petróleo embaixo) em volta do centro dourado', () => {
  const fs = figures();
  assert.equal(fs.length, 5);
  assert.deepEqual(fs.map((g) => g.tone), ['navy', 'navy', 'teal', 'teal', 'navy']);
  for (const g of fs) {
    assert.doesNotMatch(g.arc, /NaN|undefined/);
    assert.ok(Math.hypot(g.head.cx, g.head.cy) > CORE_R + g.head.r, 'cabeça fora do centro');
    assert.ok(Math.abs(Math.hypot(g.ux, g.uy) - 1) < 0.01, 'direção para fora unitária');
  }
  // simetria espelhada (como na arte oficial): direita ↔ esquerda
  const by = Object.fromEntries(fs.map((g) => [g.id, g]));
  for (const [a, b] of [['right', 'left'], ['lowRight', 'lowLeft']] as const) {
    assert.ok(Math.abs(by[a].head.cx + by[b].head.cx) < 0.2 && Math.abs(by[a].head.cy - by[b].head.cy) < 0.2, `${a} espelha ${b}`);
  }
  assert.ok(Math.abs(by.top.head.cx) < 0.1, 'a de cima no eixo');
});

test('caixa do emblema confere com o desenho (cabeças e faixas)', () => {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  const add = (x: number, y: number) => { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); };
  for (const g of figures()) {
    add(g.head.cx - g.head.r, g.head.cy - g.head.r); add(g.head.cx + g.head.r, g.head.cy + g.head.r);
    const b = g.band;
    for (let a = 0; a < 360; a += 0.5) { // elipse externa, só a parte entre os cortes (lado do meio da faixa)
      const t = (a * Math.PI) / 180; const ax = (b.axis * Math.PI) / 180;
      const x = b.cx + b.ao * Math.cos(t) * Math.cos(ax) - b.bo * Math.sin(t) * Math.sin(ax);
      const y = b.cy + b.ao * Math.cos(t) * Math.sin(ax) + b.bo * Math.sin(t) * Math.cos(ax);
      const side = (o: number[], i: number[], p: number[]) => Math.sign((i[0] - o[0]) * (p[1] - o[1]) - (i[1] - o[1]) * (p[0] - o[0]));
      if (b.cuts.every(([o, i]) => side(o, i, [x, y]) === side(o, i, b.mid))) add(x, y);
    }
  }
  assert.ok(Math.abs(minx - EMBLEM_BOX.x) < 1 && Math.abs(miny - EMBLEM_BOX.y) < 1, `canto ${minx}, ${miny}`);
  assert.ok(Math.abs(maxx - (EMBLEM_BOX.x + EMBLEM_BOX.w)) < 1 && Math.abs(maxy - (EMBLEM_BOX.y + EMBLEM_BOX.h)) < 1.5, `canto ${maxx}, ${maxy}`);
});

test('logotipo e marcas completas', () => {
  assert.deepEqual(wordmark().map((l) => l.ch).join(''), 'ERGON');
  for (const kind of ['stacked', 'horizontal'] as const) {
    const L = lockupLayout(kind);
    assert.ok(L.word.x + L.word.w <= L.w + 0.01 && L.emblem.x + L.emblem.w <= L.w + 0.01, `${kind}: cabe na largura`);
    const svg = logoSvg({ kind });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 [\d.]+ [\d.]+"/);
    assert.equal((svg.match(/class="eg-fig /g) ?? []).length, 5);
    assert.ok(svg.endsWith('</svg></svg>'));
  }
  // empilhada nas proporções da arte oficial: largura da palavra 789, emblema 549 centrado
  assert.ok(Math.abs(lockupLayout('stacked').emblem.x - 120) < 0.01);
  assert.match(logoSvg({ mono: '#141414' }), /fill="#141414"/);
  assert.doesNotMatch(logoSvg({ mono: '#141414' }), /#1D184B|#1F5B6B|#B88B5B/);
  assert.match(emblemSvg({ onDark: true }), new RegExp(BRAND.stone));
});

test('tela de carregamento: mesma marcação no index.html e no app, legenda escapada', () => {
  const h = splashHtml('<b>"x" & y</b>');
  assert.match(h, /&lt;b&gt;&quot;x&quot; &amp; y&lt;\/b&gt;/);
  assert.match(h, /class="eg-mark eg-anim"/);
  const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(index, /<div id="root"><!--ergon:splash--><\/div>/);
  assert.match(index, /<!--ergon:brand-css-->/);
  assert.match(index, new RegExp(`name="theme-color" content="${BRAND.navy}"`));
  const css = readFileSync(new URL('./brand.css', import.meta.url), 'utf8');
  assert.match(css, /prefers-reduced-motion: reduce/, 'respeita quem pede menos movimento');
});

// na imagem Docker só entram server/ e web/ (sem scripts/ nem docs/): lá este teste não se aplica
const brandScript = fileURLToPath(new URL('../../../scripts/brand-assets.mjs', import.meta.url));
const inRepo = existsSync(brandScript) && existsSync(fileURLToPath(new URL('../../../docs/brand', import.meta.url)));
test('arquivos gerados da marca (ícones, favicon, SVGs, Teams) estão em dia com a geometria', { skip: !inRepo && 'fora do repositório completo' }, () => {
  const out = execFileSync(process.execPath, [brandScript, '--check'], { encoding: 'utf8' });
  assert.match(out, /Marca em dia/);
});
