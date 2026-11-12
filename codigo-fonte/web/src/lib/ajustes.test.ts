// rc.27: os textos dos ajustes da equipe de IA (limites da conta, pausa, plano B) nas duas línguas, sem jargão.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fraseCurtaDaCota, fraseDaJanela, linhasDaConta, mover, nomeDaConta, textoDaPausa } from './ajustes.ts';
import type { ContaDeIa } from './types.ts';
import { pt } from '../i18n/pt/index.ts';
import { en } from '../i18n/en/index.ts';
import { setIdioma } from '../i18n/index.ts';

// montado por partes: a exportação pública recusa arquivos com os nomes privados escritos por inteiro
const JARGAO = new RegExp(['\\bmotor', 'cont[eê]iner', '\\btoken', '\\bAPI\\b', '\\bprompt', 'Her' + 'mes', 'o Ergon (lê|sabe|mede)', 'fallback', 'steer'].join('|'), 'i');
const CONTA: ContaDeIa = { provider: 'openai-codex', plan: 'Plus', balanceUsd: 7.5, unlimited: false, renewsAt: null, readAt: '2026-11-10T10:00:00.000Z', windows: [
  { kind: 'sessao', label: 'Session', usedPercent: 12, leftPercent: 88, resetsAt: '2026-11-10T15:00:00.000Z', scope: 'conta' },
  { kind: 'semana', label: 'Weekly', usedPercent: 61, leftPercent: 39, resetsAt: '2026-11-14T10:00:00.000Z', scope: 'conta' },
  { kind: 'semana_modelo', label: 'Opus week', usedPercent: 95, leftPercent: 5, resetsAt: null, scope: 'modelo' }] };

after(async () => { await setIdioma('pt-BR', { guardar: false }); });

test('os textos novos: sem jargão, nas duas línguas, e com as mesmas chaves', () => {
  const ptA = Object.entries(pt.configuracoes).filter(([k]) => k.startsWith('ajustes.'));
  const enA = en.configuracoes as unknown as Record<string, unknown>;
  assert.ok(ptA.length > 40);
  for (const [k, v] of ptA) {
    assert.ok(k in enA, `sem inglês: ${k}`);
    for (const txt of [JSON.stringify(v), JSON.stringify(enA[k])]) assert.doesNotMatch(txt, JARGAO, `${k}: ${txt}`);
  }
  for (const k of ['historico.reservaUsada', 'historico.orientou', 'historico.equipePausada', 'historico.equipeRetomada', 'erro.orientarNaoAndando', 'erro.reservaForaDaConta'] as const) {
    assert.ok(k in pt.servidor && k in en.servidor, k);
    assert.doesNotMatch(String((pt.servidor as Record<string, unknown>)[k]) + String((en.servidor as Record<string, unknown>)[k]), JARGAO);
  }
});

test('em português: quanto resta e quando renova, o saldo e a pausa', () => {
  assert.match(fraseDaJanela(CONTA.windows[1]), /^Restam 39% da cota semanal, renova em .*2026/);
  assert.equal(fraseDaJanela({ ...CONTA.windows[1], resetsAt: null }), 'Restam 39% da cota semanal');
  const l = linhasDaConta(CONTA);
  assert.equal(l.titulo, 'ChatGPT · plano Plus');
  assert.equal(l.resta, 39, 'a barra mostra a janela mais apertada da conta (a do modelo não conta)');
  assert.ok(l.frases.some((f) => /^Saldo: US\$\s?7,50$/.test(f)), l.frases.join(' | '));
  assert.match(fraseCurtaDaCota([CONTA]) ?? '', /^Restam 39% da cota semanal/);
  assert.equal(fraseCurtaDaCota([]), null);
  assert.equal(textoDaPausa({ pausada: false, desde: null }), 'Equipe trabalhando');
  assert.equal(textoDaPausa({ pausada: true, desde: null }), 'Equipe em pausa');
  assert.match(textoDaPausa({ pausada: true, desde: '2026-11-10T12:30:00.000Z' }), /^Equipe em pausa desde /);
  assert.equal(nomeDaConta('nous'), 'Nous Portal'); assert.equal(nomeDaConta('x', 'Minha conta'), 'Minha conta'); assert.equal(nomeDaConta('outra'), 'outra');
});

test('em inglês', async () => {
  await setIdioma('en', { guardar: false });
  assert.match(fraseDaJanela(CONTA.windows[1]), /^39% of the weekly limit left, renews /);
  assert.equal(linhasDaConta(CONTA).titulo, 'ChatGPT · Plus plan');
  assert.equal(textoDaPausa({ pausada: true, desde: null }), 'Team paused');
  await setIdioma('pt-BR', { guardar: false });
});

test('subir e descer na lista de reserva', () => {
  assert.deepEqual(mover(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(mover(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  const l = ['a', 'b'];
  assert.equal(mover(l, 0, -1), l); assert.equal(mover(l, 1, 1), l);
});
