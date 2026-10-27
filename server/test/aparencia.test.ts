import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('aparência sorteada do agente (semente do boneco)', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });
  const state = async () => (await req(h, 'GET', '/api/state', s)).json as { agents: Array<{ id: string; name: string; char_key: string | null; look_seed: number | null }> };

  test('a equipe de personagens nasce com a iconografia própria (sem semente); agente novo nasce sorteado', async () => {
    const st = await state();
    assert.ok(st.agents.filter((a) => a.char_key).every((a) => a.look_seed === null));
    const r = await req(h, 'POST', '/api/agents', s, { name: 'Temístocles', role: 'Vendas e propostas comerciais' });
    assert.equal(r.status, 201);
    const novo = (await state()).agents.find((a) => a.id === r.json.id)!;
    assert.ok(Number.isInteger(novo.look_seed) && novo.look_seed! > 0, 'agente novo já tem boneco sorteado');
    const r2 = await req(h, 'POST', '/api/agents', s, { name: 'Péricles', role: 'Relações públicas' });
    assert.notEqual((await state()).agents.find((a) => a.id === r2.json.id)!.look_seed, novo.look_seed, 'cada um com o seu');
  });

  test('"Redefinir" grava a semente nova; "Voltar ao original" tira; valor inválido é recusado', async () => {
    const ari = (await state()).agents.find((a) => a.char_key === 'aristoteles')!;
    assert.equal((await req(h, 'PATCH', `/api/agents/${ari.id}`, s, { lookSeed: 4242 })).status, 200);
    assert.equal((await state()).agents.find((a) => a.id === ari.id)!.look_seed, 4242);
    assert.equal((await req(h, 'PATCH', `/api/agents/${ari.id}`, s, { lookSeed: null })).status, 200);
    assert.equal((await state()).agents.find((a) => a.id === ari.id)!.look_seed, null);
    for (const bad of [0, -3, 1.5, 2 ** 31, 'abc']) assert.equal((await req(h, 'PATCH', `/api/agents/${ari.id}`, s, { lookSeed: bad })).status, 400, String(bad));
    const log = (await req(h, 'GET', '/api/activity', s)).json as Array<{ action: string; evidence: string | null }>;
    assert.ok(log.some((e) => e.action === 'agent.update' && /aparência/.test(e.evidence ?? '')), 'fica no registro');
  });
});
