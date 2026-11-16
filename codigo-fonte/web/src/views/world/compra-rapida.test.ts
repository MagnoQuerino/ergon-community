// A compra em um clique da etiqueta do plano: o que cada pessoa vê, a moeda travada na da assinatura, cortesia sem
// adicionais e cada botão no passo certo do carrinho.
//   node --test src/views/world/compra-rapida.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moedaDe, nivelDe, ofertas, passoDe, precoEm, proximoPlano, type EstadoPlano, type ItemC } from './compra-rapida.ts';

const pr = (brl: string, fora: string) => ({ BRL: brl, USD: fora, EUR: fora });
const plano = (tier: string, interval: 'month' | 'year', brl: string, fora: string): ItemC => ({
  sku: `world_${tier}${interval === 'year' ? '_annual' : ''}`, kind: 'plan', name: `World ${tier}`, priceCents: brl, sellable: true, tier, interval, prices: pr(brl, fora),
  seatSku: `addon_seat_${tier}${interval === 'year' ? '_annual' : ''}`,
});
const CAT: ItemC[] = [
  plano('sync', 'month', '2189', '399'), plano('sync', 'year', '23641', '4299'), plano('pro', 'month', '5489', '999'), plano('pro', 'year', '59281', '10799'),
  plano('team', 'month', '10989', '1999'), plano('team', 'year', '118681', '21599'),
  ...['sync', 'pro', 'team'].flatMap((t) => [
    { sku: `addon_seat_${t}`, kind: 'addon', name: 'Pessoa', priceCents: '1990', sellable: true, interval: 'month' as const, prices: pr('1990', '349') },
    { sku: `addon_seat_${t}_annual`, kind: 'addon', name: 'Pessoa anual', priceCents: '21492', sellable: true, interval: 'year' as const, prices: pr('21492', '3799') },
  ]),
  { sku: 'addon_jobs_5', kind: 'addon', name: '+5 Jobs', priceCents: '1990', sellable: true, interval: 'month', prices: pr('1990', '349') },
  { sku: 'addon_jobs_5_annual', kind: 'addon', name: '+5 Jobs anual', priceCents: '21492', sellable: true, interval: 'year', prices: pr('21492', '3799') },
  { sku: 'topup_1990', kind: 'topup', name: 'r1', priceCents: '1990', sellable: true, dracmas: '2000', prices: pr('1990', '349') },
  { sku: 'topup_4990', kind: 'topup', name: 'r2', priceCents: '4990', sellable: true, dracmas: '5000', prices: pr('4990', '849') },
  { sku: 'topup_9990', kind: 'topup', name: 'r3', priceCents: '9990', sellable: false, dracmas: '10000', prices: pr('9990', '1699') },
];
const estado = (o: Partial<EstadoPlano> & { plan?: string | null; source?: string; currency?: string } = {}): EstadoPlano => ({
  role: o.role ?? 'owner',
  entitlement: { status: o.plan === null ? 'none' : 'active', plan_sku: o.plan === undefined ? 'world_pro' : o.plan, source: o.plan === null ? null : o.source ?? 'stripe' },
  subscription: o.plan === null || o.source === 'cortesia' ? null : { status: 'active', plan: o.plan ?? 'world_pro', currency: o.currency ?? 'brl' },
  items: o.items ?? [{ sku: o.plan ?? 'world_pro', quantity: 1 }],
});

test('nível, próximo plano no mesmo período e o alvo', () => {
  assert.equal(nivelDe('world_team_annual'), 'team');
  assert.equal(nivelDe(null), null);
  assert.equal(proximoPlano(CAT, 'world_sync')?.sku, 'world_pro');
  assert.equal(proximoPlano(CAT, 'world_pro_annual')?.sku, 'world_team_annual', 'anual sobe no anual');
  assert.equal(proximoPlano(CAT, 'world_team'), undefined, 'no Team não há acima');
  assert.equal(proximoPlano(CAT, null)?.sku, 'world_pro', 'sem plano: o recomendado');
  assert.equal(proximoPlano(CAT, 'world_sync', 'team')?.sku, 'world_team', 'a Governança pede o Team');
  assert.equal(proximoPlano(CAT, 'world_team', 'pro'), undefined, 'alvo abaixo não desce');
});

test('a moeda é a da assinatura; sem preço nela, o item não aparece', () => {
  assert.equal(moedaDe(estado({ currency: 'usd' })), 'USD');
  assert.equal(moedaDe(estado({ plan: null })), 'BRL');
  const o = ofertas(CAT, estado({ currency: 'eur' }));
  assert.equal(o.moeda, 'EUR');
  assert.equal(precoEm(o.upgrade!, o.moeda), '1999');
  assert.equal(precoEm({ sku: 'x', kind: 'topup', name: 'x', priceCents: '100', sellable: true }, 'USD'), null, 'sem a tabela por moeda, só BRL');
  const semUsd = CAT.map((i) => (i.sku === 'topup_4990' ? { ...i, prices: { BRL: '4990', USD: null, EUR: null } } : i));
  assert.deepEqual(ofertas(semUsd, estado({ currency: 'usd' })).recargas.map((r) => r.sku), ['topup_1990']);
});

test('o dono no Pro mensal: recargas à venda, +1 pessoa e +5 Jobs mensais, e o Team mensal', () => {
  const o = ofertas(CAT, estado());
  assert.equal(o.pode, true);
  assert.deepEqual(o.recargas.map((r) => r.sku), ['topup_1990', 'topup_4990'], 'só o que está à venda');
  assert.deepEqual([o.pessoa?.sku, o.jobs?.sku, o.upgrade?.sku], ['addon_seat_pro', 'addon_jobs_5', 'world_team']);
  const anual = ofertas(CAT, estado({ plan: 'world_pro_annual' }));
  assert.deepEqual([anual.anual, anual.pessoa?.sku, anual.jobs?.sku, anual.upgrade?.sku], [true, 'addon_seat_pro_annual', 'addon_jobs_5_annual', 'world_team_annual']);
});

test('cortesia: sem adicionais (não há assinatura); recarga e subir de plano continuam', () => {
  const o = ofertas(CAT, estado({ source: 'cortesia', items: [] }));
  assert.deepEqual([o.cortesia, o.pessoa, o.jobs, o.upgrade?.sku, o.recargas.length], [true, null, null, 'world_team', 2]);
  // subir é um checkout (não há assinatura para mudar)
  assert.deepEqual(passoDe({ tipo: 'upgrade', sku: 'world_team' }, estado({ source: 'cortesia', items: [] })), { tipo: 'checkout', corpo: { sku: 'world_team' } });
  assert.equal(passoDe({ tipo: 'pessoa' }, estado({ source: 'cortesia', items: [] })), null);
});

test('quem não é dono vê o plano, mas não compra', () => {
  for (const role of ['admin', 'editor', 'viewer']) assert.equal(ofertas(CAT, estado({ role })).pode, false, role);
});

test('cada botão no passo do carrinho: mudança com prévia com assinatura, recarga à parte', () => {
  const b = estado({ items: [{ sku: 'world_pro', quantity: 1 }, { sku: 'addon_seat_pro', quantity: 2 }, { sku: 'addon_jobs_5', quantity: 1 }] });
  assert.deepEqual(passoDe({ tipo: 'pessoa' }, b), { tipo: 'mudanca', corpo: { seats: 3 } });
  assert.deepEqual(passoDe({ tipo: 'jobs' }, b), { tipo: 'mudanca', corpo: { jobPacks: 2 } });
  assert.deepEqual(passoDe({ tipo: 'upgrade', sku: 'world_team' }, b), { tipo: 'mudanca', corpo: { plan: 'world_team' } });
  assert.deepEqual(passoDe({ tipo: 'recarga', sku: 'topup_1990' }, b), { tipo: 'recarga', corpo: { sku: 'topup_1990' } });
  // sem plano: assinar é checkout; recarga também vale
  const sem = estado({ plan: null, items: [] });
  assert.deepEqual(passoDe({ tipo: 'upgrade', sku: 'world_pro' }, sem), { tipo: 'checkout', corpo: { sku: 'world_pro' } });
  assert.deepEqual(ofertas(CAT, sem).upgrade?.sku, 'world_pro');
  assert.equal(ofertas(CAT, sem).pessoa, null);
});
