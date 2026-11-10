import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropProblem, type DropTarget } from './dragMove.ts';
import { setIdioma } from '../i18n/index.ts';
import type { TeamAgent } from './teamData.ts';

const agente = (x: Partial<TeamAgent> = {}) => ({ sector_key: 'vendas', building_id: 'b1', status: 'active', coordinator: false, ...x }) as TeamAgent;
const setor = (id: string): DropTarget => ({ kind: 'sector', id, name: id });
const casa = (id: string): DropTarget => ({ kind: 'structure', id, name: id });

test('arrastar: o motivo de não aceitar o agente, nas duas línguas', async () => {
  assert.equal(dropProblem(agente(), setor('vendas')), 'já está neste setor');
  assert.equal(dropProblem(agente({ coordinator: true }), setor('suporte')), 'o Coordenador não muda de setor');
  assert.equal(dropProblem(agente(), casa('b1')), 'já mora aqui');
  assert.equal(dropProblem(agente({ status: 'inactive' } as Partial<TeamAgent>), casa('b2')), 'desativado: reative antes');
  assert.equal(dropProblem(agente(), casa('b2')), null);
  assert.equal(dropProblem(agente(), { kind: 'tray', id: '', name: '' }), null);
  try {
    await setIdioma('en', { guardar: false });
    assert.equal(dropProblem(agente(), setor('vendas')), 'already in this sector');
    assert.equal(dropProblem(agente({ coordinator: true }), setor('suporte')), "the Coordinator doesn't change sectors");
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});
