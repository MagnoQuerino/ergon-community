// Área "agente": textos em inglês que não podem inverter o sentido do estado que vem do servidor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ptAgente from './pt/agente.ts';
import enAgente from './en/agente.ts';

test('"preparado" (falta conectar a conta) não aparece como "ready" em inglês', () => {
  assert.equal(ptAgente['ferramenta.preparado'], 'preparado');
  const en = enAgente['ferramenta.preparado'];
  assert.doesNotMatch(en, /^ready$/i);
  assert.match(en, /connect/i);
});

test('as dicas de competências citam o mesmo nome da ferramenta em inglês', () => {
  assert.match(enAgente['perfil.competenciasDica'], /"Library skills"/);
  assert.match(enAgente['perfil.semFerramentaCompetencias'], /"Library skills"/);
  assert.equal(enAgente['perfil.competencias'], 'Library skills');
});
