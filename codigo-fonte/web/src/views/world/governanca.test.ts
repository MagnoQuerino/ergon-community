// A Governança: quem vê o item do menu, a frase de cada linha do registro e as barras dos tetos.
//   node --test src/views/world/governanca.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acessoGovernanca, barraDoTeto, iconeDaAtividade, linhaDaAtividade } from './governanca.ts';
import { tw } from './textos.ts';
import type { EstadoPlano } from './compra-rapida.ts';

const b = (role: string, plan: string | null, source = 'stripe'): EstadoPlano => ({ role, entitlement: { status: plan ? 'active' : 'none', plan_sku: plan, source: plan ? source : null }, subscription: null, items: [] });

test('o item do menu: aberto no Team para dono e admin, trancado nos outros planos, ausente para quem edita ou só vê', () => {
  assert.equal(acessoGovernanca(true, b('owner', 'world_team')), 'aberto');
  assert.equal(acessoGovernanca(true, b('admin', 'world_team_annual')), 'aberto');
  assert.equal(acessoGovernanca(true, b('owner', 'world_team', 'cortesia')), 'aberto', 'cortesia também vale');
  assert.equal(acessoGovernanca(true, b('owner', 'world_pro')), 'trancado');
  assert.equal(acessoGovernanca(true, b('admin', null)), 'trancado');
  assert.equal(acessoGovernanca(true, b('editor', 'world_team')), null);
  assert.equal(acessoGovernanca(true, b('viewer', 'world_pro')), null);
  assert.equal(acessoGovernanca(false, b('owner', 'world_team')), null, 'workspace fora do World');
  assert.equal(acessoGovernanca(true, null), null, 'plano ainda não lido');
});

test('as linhas do registro, com os nomes; ação desconhecida não quebra', () => {
  const dr = (v: string) => `₯ ${Number(v)}`;
  const p = (nome: string) => ({ accountId: 'acc_1', name: nome });
  const l = (action: string, detail: Record<string, string> = {}, target = p('Bia')) => linhaDaAtividade({ id: '1', at: '', action, actor: p('Ana'), target, detail }, tw, dr);
  assert.equal(l('budget.set', { cap: '300.000000' }), 'Ana definiu o teto de Bia: ₯ 300');
  assert.equal(l('budget.set', { cap: 'livre' }), 'Ana deixou Bia sem teto');
  assert.equal(l('sync.member.role', { role: 'admin' }), 'Ana mudou o papel de Bia para Admin');
  assert.equal(l('sync.member.join', { role: 'editor' }), 'Ana entrou como Edita');
  assert.equal(l('jobs.policy', { recovery: 'false' }), 'Ana desligou a recuperação');
  assert.equal(l('coisa.nova'), 'Ana: coisa.nova');
  assert.equal(linhaDaAtividade({ id: '2', at: '', action: 'wallet.topup', actor: null, target: null }, tw, dr), 'Recarga de Dracmas');
  assert.equal(iconeDaAtividade('budget.set'), 'coins');
  assert.equal(iconeDaAtividade('sync.member.remove'), 'users');
});

test('barras dos tetos: perto do teto avisa; sem teto, proporcional ao maior gasto', () => {
  assert.deepEqual(barraDoTeto(50, 100, 50), { pct: 50, tom: 'ok' });
  assert.deepEqual(barraDoTeto(85, 100, 85), { pct: 85, tom: 'atencao' });
  assert.deepEqual(barraDoTeto(120, 100, 120), { pct: 100, tom: 'cheio' });
  assert.deepEqual(barraDoTeto(10, null, 40), { pct: 25, tom: 'livre' });
  assert.deepEqual(barraDoTeto(0, null, 0), { pct: 0, tom: 'livre' });
  assert.deepEqual(barraDoTeto(0, 0, 0), { pct: 100, tom: 'cheio' });
});
