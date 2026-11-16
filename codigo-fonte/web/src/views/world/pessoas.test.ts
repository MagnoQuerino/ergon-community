// Pessoas no Ergon World e o carrinho do plano: quem pode o quê na tela (pessoas.ts) e os passos do pagamento
// (carrinho.ts).   node --test src/views/world/pessoas.test.ts   (roda pelo npm test via lib/pessoas-world.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { administra, codigoValido, inicial, limparCodigo, papeisDoConvite, papeisPara, podeTirar, podeTransferir, vagas, type Pessoa } from './pessoas.ts';
import { atualDe, jobsDe, passos, somaDoCatalogo, vagaDe, VAZIO, type ItemCat } from './carrinho.ts';

const p = (role: Pessoa['role'], me = false): Pessoa => ({ accountId: `acc_${role}${me ? 'eu' : ''}`, name: role, email: null, role, since: '2026-01-01', me });

test('só dono e admin administram; quem edita e quem lê veem a lista sem mexer', () => {
  assert.equal(administra('owner'), true); assert.equal(administra('admin'), true);
  assert.equal(administra('editor'), false); assert.equal(administra('viewer'), false); assert.equal(administra(null), false);
  for (const eu of ['editor', 'viewer'] as const) for (const alvo of ['admin', 'editor', 'viewer'] as const) {
    assert.deepEqual(papeisPara(eu, p(alvo)), []); assert.equal(podeTirar(eu, p(alvo)), false); assert.equal(podeTransferir(eu, p(alvo)), false);
  }
  assert.deepEqual(papeisDoConvite('editor'), []);
});

test('o dono: convida e promove a admin; troca papel de qualquer um menos o dele; transfere para quem já está', () => {
  assert.deepEqual(papeisDoConvite('owner'), ['admin', 'editor', 'viewer']);
  assert.deepEqual(papeisPara('owner', p('admin')), ['admin', 'editor', 'viewer']);
  assert.deepEqual(papeisPara('owner', p('owner', true)), [], 'o dono só muda por transferência');
  assert.equal(podeTirar('owner', p('admin')), true);
  assert.equal(podeTirar('owner', p('owner', true)), false);
  assert.equal(podeTransferir('owner', p('viewer')), true);
  assert.equal(podeTransferir('owner', p('owner', true)), false);
});

test('quem administra sem ser dono: não convida admin, não mexe em admin, não tira o dono nem a si', () => {
  assert.deepEqual(papeisDoConvite('admin'), ['editor', 'viewer']);
  assert.deepEqual(papeisPara('admin', p('editor')), ['editor', 'viewer']);
  assert.deepEqual(papeisPara('admin', p('admin')), []);
  assert.deepEqual(papeisPara('admin', p('admin', true)), []);
  assert.deepEqual(papeisPara('admin', p('owner')), []);
  assert.equal(podeTirar('admin', p('viewer')), true);
  assert.equal(podeTirar('admin', p('admin')), false);
  assert.equal(podeTirar('admin', p('owner')), false);
  assert.equal(podeTransferir('admin', p('editor')), false);
});

test('vagas contam pessoas e convites pendentes; a inicial e o código colado', () => {
  assert.deepEqual(vagas({ myRole: 'owner', seats: 8, members: [p('owner', true), p('editor')], invites: [{ id: 'inv_1', role: 'viewer', expiresAt: '', createdAt: '' }] }), { usadas: 3, total: 8, livres: 5 });
  assert.deepEqual(vagas({ myRole: 'owner', seats: 1, members: [p('owner', true), p('editor')], invites: [] }).livres, 0);
  assert.equal(inicial({ name: 'ísis', email: null }), 'Í');
  assert.equal(inicial({ name: null, email: 'bia@x.test' }), 'B');
  assert.equal(inicial({ name: '  ', email: null }), '·');
  const tok = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.equal(limparCodigo(` ergon://convite/${tok}\n`), tok);
  assert.equal(codigoValido(tok), true); assert.equal(codigoValido('curto'), false); assert.equal(codigoValido('AbCd EfGh IjKl MnOp'), true, 'espaços somem');
});

const CAT: ItemCat[] = [
  { sku: 'world_pro', kind: 'plan', name: 'Pro', priceCents: '4900', sellable: true, tier: 'pro', interval: 'month', seatSku: 'addon_seat_pro' },
  { sku: 'world_team', kind: 'plan', name: 'Team', priceCents: '19900', sellable: true, tier: 'team', interval: 'month', seatSku: 'addon_seat_team' },
  { sku: 'addon_seat_pro', kind: 'addon', name: 'Pessoa', priceCents: '1490', sellable: true },
  { sku: 'addon_seat_team', kind: 'addon', name: 'Pessoa', priceCents: '1290', sellable: true },
  { sku: 'addon_jobs_5', kind: 'addon', name: 'Jobs', priceCents: '2900', sellable: true },
  { sku: 'world_pro_annual', kind: 'plan', name: 'Pro', priceCents: '52920', sellable: true, tier: 'pro', interval: 'year', seatSku: 'addon_seat_pro_annual' },
  { sku: 'addon_seat_pro_annual', kind: 'addon', name: 'Pessoa', priceCents: '21492', sellable: true, interval: 'year' },
  { sku: 'addon_jobs_5_annual', kind: 'addon', name: 'Jobs', priceCents: '21492', sellable: true, interval: 'year' },
  { sku: 'topup_1000', kind: 'topup', name: '₯ 1.000', priceCents: '1990', sellable: true },
  { sku: 'topup_x', kind: 'topup', name: 'sem preço', priceCents: null, sellable: false },
];

test('carrinho sem assinatura: plano + pessoas + Jobs num checkout; recarga é o passo 2; sem plano, pessoas não entram', () => {
  const a = atualDe(null, false, []);
  assert.deepEqual(passos({ plano: 'world_pro', pessoas: 2, jobs: 1, recarga: null }, a), { passos: [{ tipo: 'checkout', corpo: { sku: 'world_pro', seats: 2, jobPacks: 1 } }], erro: null });
  assert.deepEqual(passos({ plano: 'world_pro', pessoas: 0, jobs: 0, recarga: 'topup_1000' }, a).passos.map((x) => x.tipo), ['checkout', 'recarga']);
  assert.deepEqual(passos({ ...VAZIO, pessoas: 1 }, a), { passos: [], erro: 'semPlano' });
  assert.deepEqual(passos({ ...VAZIO, recarga: 'topup_1000' }, a).passos, [{ tipo: 'recarga', corpo: { sku: 'topup_1000' } }]);
});

test('carrinho com assinatura: mudança com o total desejado (atual + o que entrou); só recarga não mexe na assinatura', () => {
  const a = atualDe('world_pro', true, [{ sku: 'world_pro', quantity: 1 }, { sku: 'addon_seat_pro', quantity: 2 }, { sku: 'addon_jobs_5', quantity: 1 }]);
  assert.deepEqual(a, { plano: 'world_pro', assinatura: true, pessoas: 2, jobs: 1 });
  assert.deepEqual(passos({ plano: 'world_team', pessoas: 1, jobs: 0, recarga: null }, a).passos, [{ tipo: 'mudanca', corpo: { plan: 'world_team', seats: 3 } }]);
  assert.deepEqual(passos({ plano: 'world_pro', pessoas: 0, jobs: 0, recarga: 'topup_1000' }, a).passos, [{ tipo: 'recarga', corpo: { sku: 'topup_1000' } }], 'o mesmo plano não é mudança');
  assert.deepEqual(passos({ ...VAZIO, jobs: 2, recarga: 'topup_1000' }, a).passos.map((x) => x.tipo), ['mudanca', 'recarga']);
});

test('a soma do catálogo (só para mostrar): plano novo, vagas do nível certo, pacotes e recarga; sem preço, nada', () => {
  const a = atualDe('world_pro', true, []);
  assert.equal(somaDoCatalogo(CAT, { plano: 'world_team', pessoas: 2, jobs: 1, recarga: 'topup_1000' }, a), 19900 + 2 * 1290 + 2900 + 1990);
  assert.equal(somaDoCatalogo(CAT, { ...VAZIO, pessoas: 1 }, a), 1490, 'a vaga do plano atual');
  assert.equal(somaDoCatalogo(CAT, { ...VAZIO, recarga: 'topup_x' }, a), null);
  assert.equal(somaDoCatalogo(CAT, VAZIO, a), null);
});

test('carrinho no plano anual: vaga e pacote anuais, nunca misturados com os mensais', () => {
  assert.equal(vagaDe(CAT, 'world_pro_annual')?.sku, 'addon_seat_pro_annual');
  assert.equal(jobsDe(CAT, 'world_pro_annual')?.sku, 'addon_jobs_5_annual');
  assert.equal(jobsDe(CAT, 'world_pro')?.sku, 'addon_jobs_5');
  const a = atualDe('world_pro_annual', true, [{ sku: 'world_pro_annual', quantity: 1 }, { sku: 'addon_jobs_5_annual', quantity: 2 }]);
  assert.equal(a.jobs, 2);
  assert.equal(somaDoCatalogo(CAT, { ...VAZIO, pessoas: 1, jobs: 1 }, a), 21492 * 2);
  assert.equal(somaDoCatalogo(CAT, { plano: 'world_pro_annual', pessoas: 1, jobs: 0, recarga: null }, atualDe('world_pro', true, [])), 52920 + 21492, 'mensal → anual: a vaga já sai anual');
});
