import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Limites de layout (rc.33): nenhum cartão esticado, em nenhuma tela. A medida no navegador (1920 px, altura dos cartões)
// fica em web/e2e/layout.mjs; aqui, as regras que a garantem.
const ler = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const css = ler('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), m[2]] as const);
/** a última declaração de `prop` para o seletor exato (a que vale, na mesma especificidade) */
const ultima = (sel: string, prop: string): string | null => {
  let v: string | null = null;
  for (const [sels, body] of rules) if (sels.includes(sel)) { const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`)); if (m) v = m[1].trim(); }
  return v;
};

test('texto corrido com ~80 caracteres por linha no máximo; a letra nunca abaixo de 12 px', () => {
  assert.match(css, /--texto-max:\s*80ch/);
  assert.ok(rules.some(([sels, body]) => sels.some((s) => s.startsWith(':where(.page)') && /\bp\b/.test(s)) && /max-width:\s*var\(--texto-max\)/.test(body)));
  for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(Number(m[1]) >= 12, `font-size ${m[1]}px`);
  assert.match(ultima('small', 'font-size') ?? '', /max\(12px/);
});

test('grades de cartões com minmax() e auto-fit: sem coluna vazia, sem cartão fino e comprido', () => {
  assert.match(ultima('.feature-grid', 'grid-template-columns') ?? '', /repeat\(auto-fit, minmax\(min\(\d+px, 100%\), 1fr\)\)/);
  assert.equal(ultima('.feature-grid', 'align-items'), 'start');
  assert.match(ultima('.grade-cartoes', 'grid-template-columns') ?? '', /auto-fit/);
  assert.equal(ultima('.grade-cartoes > *', 'max-width'), 'var(--cartao-max)');
});

test('Microsoft 365: o resumo à vista; o que já liberou, o pedido ao administrador, as ações e o teste recolhidos', () => {
  const v = ler('views/ConexoesView.tsx');
  assert.match(v, /<div className="conn-secoes">[\s\S]*<EtapasMicrosoft[\s\S]*<AcoesDaConexao[\s\S]*<details className="conn-secao">[\s\S]*<TestarConexao/);
  assert.match(v, /<details className="conn-secao conn-etapas"/);
  assert.match(v, /<details className="conn-acoes conn-secao"[\s\S]*conn-so-leitura[\s\S]*<\/details>/, 'Só leitura dentro da seção das ações');
  assert.match(v, /<details className="conn-admin conn-secao/);
  // conectada, o texto de apresentação sai (o cartão é o resumo)
  assert.match(v, /i\.state !== 'connected' && <p className="muted">\{i\.about\}<\/p>/);
  // a lista longa (34 ações) rola por dentro, último recurso
  assert.ok(ultima('.conn-acoes__lista', 'max-height'));
});

test('card no painel lateral: o título fica com a largura que sobra (nunca uma letra por linha)', () => {
  assert.equal(ultima('.tdet__titlebox', 'flex'), '1 1 0');
  assert.match(ultima('.tdet__titlebox', 'min-width') ?? '', /min\(/);
  assert.equal(ultima('.tdet__head > :not(.tdet__titlebox)', 'flex'), 'none');
  assert.equal(ultima('.tdet__title', 'overflow-wrap'), 'anywhere');
  assert.equal(ultima('.tlog', 'grid-template-columns'), 'minmax(0, 1fr)');
  // a dica do nome provisório fica dentro da caixa do título, não ao lado dela
  const td = ler('components/TaskDetail.tsx');
  const caixa = td.slice(td.indexOf('<div className="tdet__titlebox">'), td.indexOf('<MaisAcoes items={menu} />'));
  assert.match(caixa, /tdet__hint[^\n]*\n\s*<\/div>/);
  // overflow-wrap: anywhere encolhe a largura mínima: no painel inteiro, só break-word
  assert.equal(ultima('.drawer', 'overflow-wrap'), 'break-word');
});

test('Aguardando você → card → Voltar: uma pilha; X e Esc voltam à lista, o clique fora fecha tudo', () => {
  const td = ler('components/TaskDetail.tsx');
  assert.match(td, /if \(onBack && why !== 'outside'\) onBack\(\); else onClose\(\);/);
  assert.match(td, /useSurface\(ref, \{ onClose: \(why\) => void requestClose\(why\)/);
  assert.match(td, /tdet__voltar/);
  const dp = ler('components/DecisionsPanel.tsx');
  assert.match(dp, /openCard\(id, inline \? undefined : 'decisoes'\)/);
  assert.match(dp, /inert=\{sob \|\| undefined\}/);
  const app = ler('App.tsx');
  assert.match(app, /onOpenCard\(\(id, de\) => \{ if \(de !== 'decisoes'\) setDecisions\(false\)/);
  assert.match(app, /<DecisionsPanel sob=\{!!card && cardDe === 'decisoes'\}/);
  assert.match(app, /onBack=\{cardDe === 'decisoes' && decisions \?/);
  assert.equal(ultima('.dec-panel--sob', 'visibility'), 'hidden');
});
