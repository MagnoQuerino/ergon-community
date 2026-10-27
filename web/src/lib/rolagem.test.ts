import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// As regras do styles.css, sem comentários: [seletores, declarações]
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), m[2]] as const);
const where = (re: RegExp) => new Set(rules.filter(([, body]) => re.test(body)).flatMap(([sel]) => sel));

// Os Fluxos da equipe travavam a rolagem: o "contain" valia para tudo (*), e qualquer pedaço cortado ou faixa de lado
// (texto com "…", a lista de tarefas, o quadro) virava uma área que segurava a roda do mouse.
test('nada de segurar a rolagem em tudo: o * não leva overscroll-behavior', () => {
  const all = rules.filter(([sel, body]) => sel.includes('*') && /overscroll-behavior/.test(body));
  assert.deepEqual(all, []);
});

test('quem segura a rolagem vertical é área que rola de verdade na vertical (painel, janela, menu)', () => {
  const vertical = where(/overflow(-y)?:\s*(auto|scroll)\b/);
  const sideways = where(/overflow-x:\s*(auto|scroll)/);
  const holds = where(/overscroll-behavior(-y)?:\s*(contain|none)/);
  assert.ok(holds.has('.main') && holds.has('.drawer') && holds.has('.chat__msgs'), 'a página, o card e a conversa continuam segurando');
  for (const sel of holds) assert.ok(vertical.has(sel) && !sideways.has(sel), `${sel} segura a roda vertical sem rolar na vertical`);
});

test('faixa que rola só de lado segura só o giro de lado; o vertical passa para a página', () => {
  const sideways = rules.filter(([, body]) => /overflow-x:\s*(auto|scroll)/.test(body) && !/overflow-y:/.test(body)).flatMap(([sel]) => sel);
  const holdsX = where(/overscroll-behavior-x:\s*contain/);
  assert.ok(sideways.includes('.board'), 'o quadro é uma dessas faixas');
  assert.deepEqual(sideways.filter((s) => !holdsX.has(s)), []);
});

test('arrastando o quadro, o encaixe na coluna fica desligado (senão puxa de volta a cada movimento)', () => {
  const dragging = rules.find(([sel]) => sel.includes('.board--dragging'));
  assert.ok(dragging && /scroll-snap-type:\s*none/.test(dragging[1]));
});
