/**
 * rc.45: o motor no idioma da pessoa. O chinês vai ao motor como zh (o Hermes tem o catálogo) e o hindi como hi (sem
 * catálogo no Hermes: as mensagens fixas caem no inglês, a voz e a transcrição ficam em hindi); o inglês da Índia é
 * inglês. Motor de antes da rc.45 (sem a capacidade idiomas_zh_hi) recusaria zh e hi e o pedido inteiro: recebe en. E o
 * agente responde no idioma de quem lê (a pessoa da conversa; sem ela, quem é dono do workspace).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchDosAjustes } from '../src/services/ajustes-motor.ts';
import type { AjustesMotor } from '../src/services/hermes.ts';
import { idiomaDoMotor, instrucaoDeIdioma, motorDoIdioma } from '../src/services/idioma-motor.ts';
import { instructionsFor } from '../src/services/runs.ts';
import { coordinatorFor } from '../src/services/team-query.ts';
import { harness, req, setupOwner } from './helpers.ts';

const MOTOR: AjustesMotor = { reserva: [], naoTreinar: true, buscaPrivada: false, buscaPrivadaDisponivel: false, arrumarCompetencias: false, idioma: 'en', vozFalar: 'piper', vozModelo: 'base', vozIdioma: 'en' };
const ESCOLHAS = { reserva: { modo: 'desligado' as const, lista: [] }, naoTreinar: true, buscaPrivada: false, arrumarCompetencias: false, anotarMemoria: true, raciocinio: 'high' as const, vozFalar: 'piper' as const, vozModelo: 'base' as const };

test('o idioma do motor para cada idioma da tela', () => {
  assert.deepEqual(['pt-BR', 'en', 'en-IN', 'zh-CN', 'hi', undefined].map((l) => motorDoIdioma(l as never)), ['pt', 'en', 'en', 'zh', 'hi', undefined]);
});

test('ajustes: zh e hi vão ao motor que os aceita (mensagens fixas, voz e transcrição); ao de antes, en', () => {
  assert.deepEqual(patchDosAjustes(ESCOLHAS, MOTOR, { opcoes: null, idioma: 'zh', idiomasNovos: true }), { idioma: 'zh', vozIdioma: 'zh' });
  assert.deepEqual(patchDosAjustes(ESCOLHAS, MOTOR, { opcoes: null, idioma: 'hi', idiomasNovos: true }), { idioma: 'hi', vozIdioma: 'hi' });
  assert.deepEqual(patchDosAjustes(ESCOLHAS, MOTOR, { opcoes: null, idioma: 'zh' }), {}, 'motor de antes: fica em inglês (nada a mudar)');
  assert.deepEqual(patchDosAjustes(ESCOLHAS, { ...MOTOR, idioma: 'pt', vozIdioma: 'pt' }, { opcoes: null, idioma: 'hi' }), { idioma: 'en', vozIdioma: 'en' });
});

test('a linha do idioma nas instruções: nada em português; chinês, hindi e inglês da Índia ditos ao agente', () => {
  assert.equal(instrucaoDeIdioma(undefined), '');
  assert.equal(instrucaoDeIdioma('pt-BR'), '');
  assert.match(instrucaoDeIdioma('zh-CN'), /chinês simplificado \(简体中文\)/);
  assert.match(instrucaoDeIdioma('hi'), /hindi, em devanágari/);
  assert.match(instrucaoDeIdioma('en-IN'), /lakh e crore/);
});

test('o agente responde no idioma de quem lê: na conversa, a pessoa; no card e na rotina, quem é dono do workspace', async () => {
  const h = await harness({});
  try {
    const s = await setupOwner(h);
    const coord = coordinatorFor(h.db, s.workspaceId)!;
    assert.doesNotMatch(instructionsFor(h.db, s.workspaceId, coord, 'Canal: teste.', { userId: s.userId }), /Idioma: a pessoa usa/, 'português: as instruções ficam como sempre');
    assert.equal((await req(h, 'PUT', '/api/me/prefs', s, { lang: 'zh-CN' })).json.lang, 'zh-CN');
    assert.equal(idiomaDoMotor(h.db, s.userId), 'zh');
    const conversa = instructionsFor(h.db, s.workspaceId, coord, 'Canal: teste.', { userId: s.userId });
    assert.match(conversa, /Idioma: a pessoa usa o Ergon em chinês simplificado/);
    assert.ok(conversa.indexOf('Idioma: a pessoa') < conversa.indexOf('Canal: teste.'), 'entre as instruções fixas, antes da nota do canal');
    assert.match(instructionsFor(h.db, s.workspaceId, coord, 'Canal: quadro da equipe.'), /chinês simplificado/, 'card: o idioma de quem é dono');
  } finally { await h.close(); }
});
