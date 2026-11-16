// A página do Ergon World (views/world/MundoView.tsx): item próprio no menu, preços só do catálogo do World, movimento
// só para quem não pediu menos movimento, e as configurações continuam em Configurações › Ergon World.
//   node --test src/lib/mundo-pagina.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const ler = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pagina = ler('views/world/MundoView.tsx');
const css = ler('styles.css');
const app = ler('App.tsx');

test('o Ergon World tem item próprio no menu da esquerda (quando o módulo do World está na instalação)', () => {
  assert.match(app, /import\.meta\.glob<[^>]+>\('\.\/views\/world\/MundoView\.tsx'\)/);
  assert.match(app, /id: 'world' as const, label: 'geral\.nav\.world'/);
});

test('preços e números da página vêm do World: nada de valor em reais escrito no código', () => {
  assert.doesNotMatch(pagina, /R\$\s*\d|priceCents: ['"\d]|monthlyDracmas: ['"\d]/);
  assert.match(pagina, /\/api\/world\/catalog/);
  assert.match(pagina, /\/api\/world\/billing\/checkout/, 'assinar usa o pagamento de sempre');
});

test('movimento só sem "reduzir movimento": a folha para tudo da página e a aparição ao rolar depende do sistema', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.mundo \*, \.mundo \*::before, \.mundo \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.match(pagina, /prefers-reduced-motion: reduce/);
  assert.match(pagina, /parado \? <circle/, 'o ponto da sincronia (animação do SVG) fica parado');
});

test('o que se configura continua em Configurações › Ergon World ("Gerenciar")', () => {
  assert.match(pagina, /#configuracao\?world/);
  for (const proibido of ['/api/world/unlink', "api.del('/api/world/bind')", '/api/world/billing/cancel']) assert.ok(!pagina.includes(proibido), proibido);
});
