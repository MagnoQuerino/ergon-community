// O seletor de idioma e o caminho da escolha: menu do avatar e Minha conta, escondido até o inglês ser liberado, a
// escolha gravada na pessoa (o servidor aceita os mesmos idiomas da tela) e a tela inteira redesenhando na troca.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { IDIOMAS, IDIOMA_INGLES_LIBERADO, NOME_DO_IDIOMA } from './idiomas.ts';
import { pt } from './pt/index.ts';
import { en } from './en/index.ts';

const ler = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('seletor no menu do avatar e em Minha conta, "Português" / "English", escondido até o inglês ser liberado', () => {
  assert.deepEqual(NOME_DO_IDIOMA, { 'pt-BR': 'Português', en: 'English' }, 'cada idioma escrito nele mesmo');
  assert.equal(typeof IDIOMA_INGLES_LIBERADO, 'boolean');
  const seletor = ler('../components/SeletorIdioma.tsx');
  assert.match(seletor, /if \(!IDIOMA_INGLES_LIBERADO\) return null;/);
  assert.match(seletor, /onClick=\{\(\) => escolherIdioma\(l\)\}/);
  // dentro do menu do avatar (role=menu) os filhos têm de ser itens do menu: grupo + menuitemradio; em Minha conta, radiogroup
  assert.match(seletor, /role=\{compacto \? 'group' : 'radiogroup'\}/);
  assert.match(seletor, /const papel = compacto \? 'menuitemradio' : 'radio';/);
  assert.match(seletor, /role=\{papel\} aria-checked=\{atual === l\}/);
  assert.match(ler('../components/AccountMenu.tsx'), /role="menu"/);
  assert.doesNotMatch(seletor, /disabled/, 'nada de botão desabilitado esperando');
  assert.match(ler('../components/AccountMenu.tsx'), /<SeletorIdioma compacto \/>/);
  assert.match(ler('../views/ContaPanel.tsx'), /<SeletorIdioma \/>/);
});

test('a dica do seletor só promete o que a tela faz (a equipe ainda não responde no idioma da pessoa)', () => {
  for (const s of [pt.geral['idioma.dica'], en.geral['idioma.dica']]) assert.doesNotMatch(s, /equipe|responde|team|repl/i, s);
});

test('"Carregando…" das peças comuns vem do dicionário: o Loading, a tela de abertura do app e a do index.html', () => {
  const brand = ler('../brand/Brand.tsx');
  assert.match(brand, /label \?\? t\('geral\.comum\.carregando'\)/);
  assert.doesNotMatch(brand, /label = '/);
  const logo = ler('../brand/logo.ts');
  assert.match(logo, /export function splashHtml\(label: string\): string/, 'a legenda vem de quem chama, no idioma da tela');
  assert.doesNotMatch(logo, /'Carregando/);
  assert.match(ler('../../vite.config.ts'), /splashHtml\(geral\['comum\.carregando'\]\)/);
});

test('a escolha vai para a pessoa (servidor) e para o navegador; ao entrar, o idioma dela vale antes de a tela aparecer', () => {
  const prefs = ler('../lib/prefs.ts');
  assert.match(prefs, /export function escolherIdioma\(l: Idioma\) \{\s*setIdioma\(l\);\s*savePrefs\(\{ lang: l \}\);/);
  // ao entrar: a ordem de i18n/index.ts, e o que ainda não estava no servidor vai para lá
  assert.match(prefs, /const \{ pronto, gravar \} = usarIdiomaDaPessoa\(p\.lang, quem\);\s*if \(gravar\) savePrefs\(\{ lang: gravar \}\);\s*return pronto;/);
  const app = ler('../App.tsx');
  assert.match(app, /await initPrefs\(me\.prefs, me\.user\.id\);/);
  // a raiz ouve o idioma: a troca redesenha todas as telas, sem recarregar
  assert.match(app, /export function App\(\) \{[\s\S]{0,200}useIdioma\(\);/);
  assert.match(ler('../main.tsx'), /prepararIdioma\(\)\.then\(\(\) => createRoot/);
});

test('o servidor aceita exatamente os idiomas da tela', (t) => {
  const arq = new URL('../../../server/src/services/prefs.ts', import.meta.url);
  if (!fs.existsSync(arq)) { t.skip('sem o servidor nesta cópia'); return; }
  const srv = fs.readFileSync(arq, 'utf8');
  const lista = /IDIOMAS: readonly Idioma\[\] = \[([^\]]*)\]/.exec(srv)?.[1];
  assert.ok(lista, 'lista de idiomas no servidor');
  assert.deepEqual(lista.split(',').map((s) => s.trim().replace(/'/g, '')), [...IDIOMAS]);
  assert.match(fs.readFileSync(new URL('../../../server/src/app.ts', import.meta.url), 'utf8'), /lang: \{ type: 'string', enum: \[\.\.\.IDIOMAS\] \}/);
});
