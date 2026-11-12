import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import pt from '../i18n/pt/conexoes.ts';
import en from '../i18n/en/conexoes.ts';

const view = fs.readFileSync(new URL('../views/ConexoesView.tsx', import.meta.url), 'utf8');
const chaves = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k.startsWith('canal.'));

test('Telegram e Discord: os textos da tela nas duas línguas, sem jargão nem o nome do motor', () => {
  assert.deepEqual(chaves(en).sort(), chaves(pt).sort());
  const tudo = [...chaves(pt).map((k) => String((pt as Record<string, unknown>)[k])), ...chaves(en).map((k) => String((en as Record<string, unknown>)[k]))].join(' ');
  // "Reset Token" é o nome do botão no portal do Discord, que a pessoa precisa achar: o único lugar com a palavra
  assert.doesNotMatch(tudo.replaceAll('Reset Token', ''), /Hermes|\btoken\b|\bAPI\b|motor|contêiner|container|gateway/i);
  // a diferença para as conexões de conta que agem em nome da pessoa fica clara
  assert.match(pt['canal.secaoTexto'], /diferente das conexões Telegram e Discord/);
  // com o Ergon fechado: o que cada um faz, dito na tela
  assert.match(pt['canal.fechado.telegram'], /guarda as mensagens por até 24 horas/);
  assert.match(pt['canal.fechado.discord'], /não guarda as mensagens/);
  // o passo a passo leigo de cada um
  assert.match(pt['canal.tg.passo1'], /\{botfather\}/);
  assert.match(pt['canal.dc.passo2'], /Message Content Intent/);
});

test('Telegram e Discord: a tela guarda o código do bot, liga pelo código do bot com a senha e mostra os dois canais', () => {
  assert.match(view, /api\.put\(`\/api\/canais\/\$\{canal\}\/bot`, \{ token: token\.trim\(\) \}\)/);
  assert.match(view, /api\.post\(`\/api\/canais\/\$\{canal\}\/parear`, \{ codigo, password: senha \}\)/);
  assert.match(view, /useResource<Record<NomeCanal, EstadoCanal>>\('\/api\/canais', \['canais\.changed'\]\)/);
  assert.match(view, /\(\['telegram', 'discord'\] as const\)\.map/);
  assert.match(view, /<ConversaPorCanais \/>/);
  // o campo do código do bot não mostra o que foi colado
  assert.match(view, /t\('conexoes\.canal\.codigoDoBot'\)\}<input type="password"/);
  for (const c of ['formato', 'codigo', 'tentativas', 'motor']) assert.ok(pt[`canal.erro.${c}` as keyof typeof pt], c);
});
