import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cityStructures, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('Equipe: setor e construção novos direto na tela', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('setor novo: nome obrigatório, sem repetir, e sem o limite antigo de 12', async () => {
    const r = await req(h, 'POST', '/api/sectors', s, { name: 'Atendimento', description: 'responde clientes' });
    assert.equal(r.status, 201);
    assert.equal(r.json.name, 'Atendimento');
    assert.ok((await req(h, 'GET', '/api/sectors', s)).json.some((x: { key: string }) => x.key === r.json.key));
    assert.equal((await req(h, 'POST', '/api/sectors', s, { name: 'atendimento' })).status, 409, 'mesmo nome (sem caixa) não repete');
    assert.equal((await req(h, 'POST', '/api/sectors', s, { name: '' })).status, 400);
    const before = (await req(h, 'GET', '/api/sectors', s)).json.length;
    for (let i = 0; i < 14 - before; i++) assert.equal((await req(h, 'POST', '/api/sectors', s, { name: `Setor extra ${i}` })).status, 201);
    assert.ok((await req(h, 'GET', '/api/sectors', s)).json.length >= 14, 'passa de 12 setores');
  });

  test('construção sem lote: vai para um lugar livre, com vagas; tipo inválido e lote pela metade são recusados', async () => {
    const antes = await cityStructures(h, s);
    const r = await req(h, 'POST', '/api/structures', s, { kind: 'oikos', name: 'Casa do Atendimento' });
    assert.equal(r.status, 201);
    const depois = await cityStructures(h, s);
    const nova = depois.find((x: { id: string }) => x.id === r.json.id);
    assert.ok(nova, 'aparece na cidade');
    assert.equal(nova.name, 'Casa do Atendimento');
    assert.equal(depois.length, antes.length + 1);
    assert.ok(nova.floors.length >= 1);
    const outra = await req(h, 'POST', '/api/structures', s, { kind: 'stoa' });
    assert.equal(outra.status, 201, 'e outra, sem colidir com a primeira');
    assert.equal((await req(h, 'POST', '/api/structures', s, { kind: 'nada' })).status, 400);
    assert.equal((await req(h, 'POST', '/api/structures', s, { kind: 'oikos', i: 0 })).status, 400);
  });
});
