// O carrinho do plano do Ergon World: o que a pessoa quer (trocar o plano, pessoas adicionais, pacotes de Jobs, uma
// recarga) vira UM checkout de assinatura (sem assinatura: plano + seats + jobPacks) ou UMA mudança com prévia (com
// assinatura), e a recarga, que é pagamento à parte, vira um segundo passo claro ("1 de 2", "2 de 2"). Os preços que a
// tela mostra antes da prévia são a soma do catálogo (rotulada assim); o valor cobrado vem sempre do World. Puro.
export interface ItemCat { sku: string; kind: string; name: string; priceCents: string | null; sellable: boolean; tier?: string | null; interval?: 'month' | 'year'; people?: number; jobSlots?: number; seatSku?: string }
export interface Carrinho { plano: string | null; pessoas: number; jobs: number; recarga: string | null; nuvem?: boolean }
export const VAZIO: Carrinho = { plano: null, pessoas: 0, jobs: 0, recarga: null, nuvem: false };

/** O que já está na assinatura: o plano e as quantidades de vagas e pacotes. */
export interface Atual { plano: string | null; assinatura: boolean; pessoas: number; jobs: number; nuvem?: boolean }
export const atualDe = (planSku: string | null, assinatura: boolean, items: Array<{ sku: string; quantity: number }>): Atual => ({
  plano: planSku, assinatura,
  pessoas: items.filter((i) => i.sku.startsWith('addon_seat_')).reduce((n, i) => n + i.quantity, 0),
  jobs: items.filter((i) => i.sku.startsWith('addon_jobs_5')).reduce((n, i) => n + i.quantity, 0),
  nuvem: items.some((i) => i.sku.startsWith('addon_cloud') && i.quantity > 0),
});

export const vazio = (c: Carrinho): boolean => !c.plano && !c.pessoas && !c.jobs && !c.recarga && !c.nuvem;
/** Há mudança de assinatura (plano, pessoas ou Jobs)? */
export const mexeNaAssinatura = (c: Carrinho, a: Atual): boolean => (!!c.plano && c.plano !== a.plano) || c.pessoas > 0 || c.jobs > 0 || (!!c.nuvem && !a.nuvem);

export type Passo =
  | { tipo: 'checkout'; corpo: { sku: string; seats?: number; jobPacks?: number; cloud?: number } }
  | { tipo: 'mudanca'; corpo: { plan?: string; seats?: number; jobPacks?: number; cloud?: number } }
  | { tipo: 'recarga'; corpo: { sku: string } };

/**
 * Os passos, na ordem: primeiro a assinatura (checkout novo ou mudança com prévia), depois a recarga. Sem assinatura e
 * sem plano escolhido, pessoas e Jobs não entram (vão junto de um plano): o erro é devolvido para a tela dizer.
 */
export function passos(c: Carrinho, a: Atual): { passos: Passo[]; erro: 'semPlano' | null } {
  const out: Passo[] = [];
  if (!a.assinatura) {
    const plano = c.plano ?? null;
    if (!plano && (c.pessoas || c.jobs || c.nuvem)) return { passos: [], erro: 'semPlano' };
    if (plano) out.push({ tipo: 'checkout', corpo: { sku: plano, ...(c.pessoas ? { seats: c.pessoas } : {}), ...(c.jobs ? { jobPacks: c.jobs } : {}), ...(c.nuvem ? { cloud: 1 } : {}) } });
  } else if (mexeNaAssinatura(c, a)) {
    out.push({ tipo: 'mudanca', corpo: { ...(c.plano && c.plano !== a.plano ? { plan: c.plano } : {}), ...(c.pessoas ? { seats: a.pessoas + c.pessoas } : {}), ...(c.jobs ? { jobPacks: a.jobs + c.jobs } : {}), ...(c.nuvem && !a.nuvem ? { cloud: 1 } : {}) } });
  }
  if (c.recarga) out.push({ tipo: 'recarga', corpo: { sku: c.recarga } });
  return { passos: out, erro: null };
}

/** O nível do plano (sync, pro, team) e o sku da vaga adicional dele. */
export const tierDe = (sku: string | null): string | null => (sku ? sku.replace(/^world_/, '').replace(/_annual$/, '') : null);
export const vagaDe = (cat: ItemCat[], planoSku: string | null): ItemCat | undefined => {
  const p = cat.find((i) => i.sku === planoSku);
  return cat.find((i) => i.sku === (p?.seatSku ?? `addon_seat_${tierDe(planoSku)}`));
};

/** O plano é anual? (as vagas e os pacotes acompanham o período do plano: nunca se misturam) */
export const anualDe = (cat: ItemCat[], planoSku: string | null): boolean => (cat.find((i) => i.sku === planoSku)?.interval ?? (planoSku?.endsWith('_annual') ? 'year' : 'month')) === 'year';
/** "Subir o WS para o World" no período do plano. */
export const nuvemDe = (cat: ItemCat[], planoSku: string | null): ItemCat | undefined => cat.find((i) => i.sku === (anualDe(cat, planoSku) ? 'addon_cloud_annual' : 'addon_cloud'));
/** O pacote de +5 Jobs no período do plano. */
export const jobsDe = (cat: ItemCat[], planoSku: string | null): ItemCat | undefined => cat.find((i) => i.sku === (anualDe(cat, planoSku) ? 'addon_jobs_5_annual' : 'addon_jobs_5'));

/**
 * Soma pelo catálogo (centavos), só para mostrar antes da prévia: o plano novo (preço cheio do período), as vagas e os
 * pacotes no período do plano (por mês ou por ano), e a recarga. null quando falta preço de algum item.
 */
export function somaDoCatalogo(cat: ItemCat[], c: Carrinho, a: Atual, comboPct = 0): number | null {
  const preco = (sku: string | null | undefined, q = 1) => { const i = cat.find((x) => x.sku === sku); return i && i.priceCents != null ? Number(i.priceCents) * q : null; };
  const partes: Array<number | null> = [];
  const plano = c.plano && c.plano !== a.plano ? c.plano : null;
  if (plano) partes.push(preco(plano));
  if (c.pessoas) partes.push(preco(vagaDe(cat, c.plano ?? a.plano)?.sku, c.pessoas));
  if (c.jobs) partes.push(preco(jobsDe(cat, c.plano ?? a.plano)?.sku, c.jobs));
  const nuvem = !!c.nuvem && !a.nuvem;
  if (nuvem) partes.push(preco(nuvemDe(cat, c.plano ?? a.plano)?.sku));
  if (!partes.length || partes.some((x) => x === null)) return null;
  let assinatura = (partes as number[]).reduce((s, x) => s + x, 0);
  // combo Plano + nuvem num checkout novo: o desconto a mais vale na assinatura toda (a mudança mostra a prévia exata)
  if (nuvem && comboPct > 0 && !a.assinatura && plano) assinatura -= Math.round((assinatura * comboPct) / 100);
  const recarga = c.recarga ? preco(c.recarga) : 0;
  return recarga === null ? null : assinatura + recarga;
}

/** O passo 2 de 2 que fica guardado quando o 1 leva ao pagamento (o retorno do Stripe continua daqui). */
export const CHAVE_PENDENTE = 'ergon.world.carrinho.recarga';

/**
 * Os planos que o carrinho oferece: os à venda, menos o atual; do anual não se volta ao mensal; e no plano cortesia
 * (sem assinatura paga) não se troca o período, só se sobe de plano no mesmo período.
 */
export function planosDoCarrinho(planos: ItemCat[], atual: ItemCat | undefined, cortesia: boolean): ItemCat[] {
  return planos.filter((p) => p.kind === 'plan' && p.sku !== atual?.sku && p.sellable
    && !(atual?.interval === 'year' && p.interval === 'month')
    && !(cortesia && atual && p.interval !== atual.interval));
}
