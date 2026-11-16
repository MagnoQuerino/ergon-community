import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import pt from '../i18n/pt/conexoes.ts';
import en from '../i18n/en/conexoes.ts';

// Conexões em blocos (rc.33): fechado, cada conexão é um bloco do mesmo tamanho (logo, nome, estado e, com mais de uma, quantas
// contas); aberto, o cartão ocupa a linha. Um aberto por vez em toda a tela; o X e o Esc fecham e o foco volta ao bloco.
const view = readFileSync(new URL('../views/ConexoesView.tsx', import.meta.url), 'utf8');
const logo = readFileSync(new URL('../components/BrandLogo.tsx', import.meta.url), 'utf8');
const icones = readFileSync(new URL('../components/simple-icons.ts', import.meta.url), 'utf8');

test('um só estado de aberto para a tela inteira: as grades das contas, dos canais e dos aplicativos usam o mesmo', () => {
  const grades = [...view.matchAll(/<GradeDeBlocos blocos=\{[^}]+\} aberto=\{open\} abrir=\{setOpen\} \/>/g)];
  assert.ok(grades.length >= 3, `grades: ${grades.length}`);
  // clicar no bloco aberto fecha; clicar noutro troca (o estado guarda um só)
  assert.match(view, /onClick=\{\(\) => abrir\(aberto === b\.kind \? null : b\.kind\)\} aria-expanded=\{aberto === b\.kind\}/);
  assert.match(view, /\{aberto === b\.kind && b\.corpo\(\)\}/);
});

test('o X e o Esc fecham, e o foco volta ao bloco', () => {
  assert.match(view, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Escape' && open && !e\.defaultPrevented\) \{ e\.preventDefault\(\); fechar\(\); \} \}\}/);
  assert.match(view, /const fechar = \(\) => \{ const k = open; setOpen\(null\); if \(k\) window\.setTimeout\(\(\) => document\.getElementById\(`tile-\$\{k\}`\)\?\.focus\(\), 0\); \};/);
  for (const c of ['<Detail i={i}', '<TeamsConversa onClose={fechar} />', 'onClose={fechar} />']) assert.ok(view.includes(c), c);
  assert.ok((view.match(/conn-detail__x/g) ?? []).length >= 3, 'Detail, Teams e os canais têm o X');
});

test('o bloco fechado mostra só o logo, o nome, o estado e (com mais de uma) quantas contas', () => {
  assert.match(view, /<BrandLogo kind=\{b\.logo \?\? b\.kind\} name=\{b\.name\} \/>\s*<span className="conn-tile__txt"><b>\{b\.name\}<\/b>/);
  // o bloco do Telegram e do Discord de "Conversar com a equipe" não se confunde com a conexão de conta de mesmo nome
  assert.match(view, /kind: `equipe-\$\{c\}`, logo: c/);
  assert.match(view, /\(b\.contas \?\? 0\) > 1 && <span className="muted small">\{t\('conexoes\.multi\.nContas', \{ n: b\.contas! \}\)\}/);
  for (const d of [pt, en]) assert.deepEqual(Object.keys(d['multi.nContas']), ['one', 'other']);
});

test('as letras miúdas ficam atrás de "Detalhes"; as introduções das seções têm uma linha', () => {
  assert.ok((view.match(/<summary>\{t\('conexoes\.detalhes'\)\}<\/summary>/g) ?? []).length >= 3);
  for (const k of ['contas.curto', 'canal.grupoTexto'] as const) assert.ok(pt[k].length <= 110 && en[k].length <= 110, k);
});

test('logos: Teams, Telegram, Discord, Slack e as outras marcas sem a inicial cinza', () => {
  for (const k of ['telegram', 'discord', 'hubspot', 'zendesk', 'gitlab', 'zoom', 'dropbox', 'calendly', 'mcp']) assert.match(icones, new RegExp(`\\n  ${k}: \\{ title:`), k);
  assert.match(logo, /if \(kind === 'teams'\) return/);
  assert.match(logo, /if \(kind === 'slack'\) return/);
  for (const k of ['asaas', 'gohighlevel', 'omie', 'pipedrive', 'salesforce']) assert.match(logo, new RegExp(`\\n  ${k}: \\{ hex:`), k);
  assert.doesNotMatch(logo, /#6b6a62/, 'sem o cinza de antes');
  assert.doesNotMatch(logo, /https?:\/\//, 'nada vem de fora');
});
