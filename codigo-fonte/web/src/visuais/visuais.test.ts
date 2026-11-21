// Blocos visuais na tela (rc.42): as cores do PNG do servidor são as do tema; o realce de código; os votos da conversa;
// a convenção ```ergon-<tipo> do documento (cada tipo tem o seu nome de cerca, sem "_").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PALETAS, VARIAVEL } from '../../../shared/visuais/paleta.ts';
import { temas } from '../lib/contraste-folha.ts';
import { realcar } from './realce.ts';
import { votosDe } from './conversa.ts';
import { cercaVoto } from '../../../shared/visuais/cercas.ts';
import { TODOS_OS_TIPOS, langDoTipo, tipoDoLang } from '../../../shared/visuais/esquema.ts';

const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('o PNG do servidor usa as mesmas cores dos temas claro e escuro da tela', () => {
  const { claro, escuro } = temas(css);
  for (const [nome, vars] of [['claro', claro], ['escuro', escuro]] as const) {
    for (const [cor, variavel] of Object.entries(VARIAVEL)) {
      let v = vars[variavel] ?? claro[variavel];
      while (v?.startsWith('var(')) v = vars[v.slice(4, -1)] ?? claro[v.slice(4, -1)];
      assert.equal(PALETAS[nome][cor as keyof typeof PALETAS.claro].toLowerCase(), v?.toLowerCase(), `${nome}: ${cor} (${variavel})`);
    }
  }
});

test('realce de código: palavra-chave, texto, número e comentário; o resto fica como texto', () => {
  const p = realcar('const x = "oi"; // fim\nreturn 42', 'ts');
  assert.deepEqual(p.filter((x) => x.c).map((x) => `${x.c}:${x.t}`), ['kw:const', 'str:"oi"', 'com:// fim', 'kw:return', 'num:42']);
  assert.equal(p.map((x) => x.t).join(''), 'const x = "oi"; // fim\nreturn 42');
  assert.deepEqual(realcar('SELECT 1 -- x', 'sql').filter((x) => x.c).map((x) => x.c), ['kw', 'num', 'com']);
});

test('votos da conversa: só a mensagem da pessoa que é só o voto', () => {
  const msgs = [
    { id: '1', role: 'user', content: cercaVoto({ enquete: 'enq-1', opcao: 1 }), created_at: '' },
    { id: '2', role: 'agent', content: cercaVoto({ enquete: 'enq-1', opcao: 0 }), created_at: '' },
    { id: '3', role: 'user', content: 'voto na 2', created_at: '' },
  ];
  assert.deepEqual(votosDe(msgs, () => ({ quem: 'eu', nome: 'Você' })), [{ enquete: 'enq-1', opcao: 1, quem: 'eu', nome: 'Você' }]);
});

test('cada tipo tem a sua cerca ```ergon-<tipo> no padrão do documento (letras, números e hífen) e volta ao mesmo tipo', () => {
  for (const t of TODOS_OS_TIPOS) {
    const lang = langDoTipo(t);
    assert.match(lang, /^ergon-[a-z0-9-]{1,30}$/);
    assert.equal(tipoDoLang(lang), t);
  }
  assert.equal(tipoDoLang('ergon-voto'), null);
  assert.equal(tipoDoLang('ergon-visual'), '');
});
