// A compra em um clique da etiqueta do plano (barra de cima): o que se oferece a quem, no preço de qual moeda, e qual
// passo do carrinho (carrinho.ts) cada botão dispara. Puro: conferido por compra-rapida.test.ts.
//  - Só quem é dono do workspace compra; os outros veem o plano e "peça ao dono".
//  - Cortesia: sem assinatura para mexer (nada de pessoas e Jobs adicionais); recarga e subir de plano continuam.
//  - A moeda é a da assinatura (o World recusa misturar); sem assinatura, a base (BRL).
//  - Pessoas e Jobs adicionais seguem o período do plano (mensal ou anual); subir de plano também.
import { anualDe, atualDe, jobsDe, passos, vagaDe, VAZIO, type ItemCat, type Passo } from './carrinho.ts';

export type Moeda = 'BRL' | 'USD' | 'EUR';
export interface ItemC extends ItemCat { prices?: Partial<Record<Moeda, string | null>> | null; dracmas?: string | null; monthlyDracmas?: string }
export interface EstadoPlano {
  role: string;
  entitlement: { status: string; plan_sku: string | null; tier?: string | null; source?: string | null };
  subscription: { status: string; plan: string | null; currency?: string | null } | null;
  items: Array<{ sku: string; quantity: number }>;
}

const LIVE = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];
export const NIVEIS = ['sync', 'pro', 'team'] as const;
export type Nivel = (typeof NIVEIS)[number];
// i18n-ok: nomes de produto (os planos do Ergon World), não se traduzem
const NOME: Record<Nivel, string> = { sync: 'Sync', pro: 'Pro', team: 'Team' };

/** O nível do plano (sync, pro, team) pelo sku ou pelo campo tier; null sem plano. */
export function nivelDe(sku: string | null | undefined, tier?: string | null): Nivel | null {
  const t = (tier ?? (sku ? sku.replace(/^world_/, '').replace(/_annual$/, '') : null)) as Nivel | null;
  return t && (NIVEIS as readonly string[]).includes(t) ? t : null;
}
/** O nome curto da etiqueta: "Pro", "Team" (nomes de produto: não se traduzem). */
export const nomeCurto = (n: Nivel): string => NOME[n];
/** O nome inteiro: "World Pro". */
// i18n-ok: nome de produto
export const nomeDoPlano = (n: Nivel): string => `World ${NOME[n]}`;

/** O plano vale agora (ativo ou em tolerância)? */
export const comPlano = (b: EstadoPlano): boolean => ['active', 'grace'].includes(b.entitlement.status) && !!b.entitlement.plan_sku;
export const ehCortesia = (b: EstadoPlano): boolean => comPlano(b) && b.entitlement.source === 'cortesia';
export const assinaturaViva = (b: EstadoPlano): boolean => !!b.subscription && LIVE.includes(b.subscription.status);

/** A moeda da assinatura (tudo o que entra nela segue essa moeda); sem assinatura, BRL. */
export function moedaDe(b: EstadoPlano): Moeda {
  const c = String(b.subscription?.currency ?? '').toUpperCase();
  return c === 'USD' || c === 'EUR' ? c : 'BRL';
}
/** O preço do item na moeda (centavos, texto); null = não se vende nela. */
export function precoEm(i: ItemC, m: Moeda): string | null {
  if (i.prices) return i.prices[m] ?? null;
  return m === 'BRL' ? i.priceCents : null;
}

/**
 * O próximo plano acima do atual, no mesmo período (mensal ou anual); com `alvo`, aquele nível (se for acima). Sem
 * plano, o Pro mensal (o recomendado), ou o alvo. Só o que está à venda.
 */
export function proximoPlano(cat: ItemC[], atual: string | null, alvo?: Nivel): ItemC | undefined {
  const planos = cat.filter((i) => i.kind === 'plan' && i.sellable);
  const cur = nivelDe(atual);
  const intervalo = atual ? (anualDe(cat, atual) ? 'year' : 'month') : 'month';
  const rank = cur ? NIVEIS.indexOf(cur) : -1;
  const quer = alvo && NIVEIS.indexOf(alvo) > rank ? alvo : cur ? NIVEIS[rank + 1] : 'pro';
  if (!quer) return undefined;
  return planos.find((p) => nivelDe(p.sku, p.tier) === quer && (p.interval ?? 'month') === intervalo);
}

export interface Ofertas {
  /** quem pode comprar: só o dono */
  pode: boolean;
  temPlano: boolean; cortesia: boolean; assinatura: boolean; anual: boolean; moeda: Moeda;
  nivel: Nivel | null;
  recargas: ItemC[];
  /** +1 pessoa e +5 Jobs no período do plano (só com assinatura paga) */
  pessoa: ItemC | null; jobs: ItemC | null;
  upgrade: ItemC | null;
}

/** O que a etiqueta oferece, para quem, e em que moeda. */
export function ofertas(cat: ItemC[], b: EstadoPlano, alvo?: Nivel): Ofertas {
  const temPlano = comPlano(b); const cortesia = ehCortesia(b); const assinatura = assinaturaViva(b);
  const plano = temPlano ? b.entitlement.plan_sku : null;
  const moeda = moedaDe(b);
  const vende = (i: ItemC | undefined): ItemC | null => (i && i.sellable && precoEm(i, moeda) !== null ? i : null);
  const extras = temPlano && assinatura && !cortesia;
  return {
    pode: b.role === 'owner', temPlano, cortesia, assinatura, moeda,
    anual: !!plano && anualDe(cat, plano), nivel: nivelDe(plano, temPlano ? b.entitlement.tier : null),
    recargas: cat.filter((i) => i.kind === 'topup' && i.sellable && precoEm(i, moeda) !== null),
    pessoa: extras ? vende(vagaDe(cat, plano)) : null,
    jobs: extras ? vende(jobsDe(cat, plano)) : null,
    upgrade: vende(proximoPlano(cat, plano, alvo)),
  };
}

export type Acao = { tipo: 'recarga'; sku: string } | { tipo: 'pessoa' } | { tipo: 'jobs' } | { tipo: 'upgrade'; sku: string };

/**
 * O passo do carrinho de cada botão: recarga é pagamento à parte (Stripe); pessoa, Jobs e subir de plano, com
 * assinatura, são uma mudança com prévia (preview → confirmar); sem assinatura (cortesia, sem plano), subir é um
 * checkout. null quando a ação não cabe (pessoa ou Jobs sem assinatura).
 */
export function passoDe(a: Acao, b: EstadoPlano): Passo | null {
  const atual = atualDe(comPlano(b) ? b.entitlement.plan_sku : null, assinaturaViva(b), b.items);
  const c = a.tipo === 'recarga' ? { ...VAZIO, recarga: a.sku } : a.tipo === 'upgrade' ? { ...VAZIO, plano: a.sku } : a.tipo === 'pessoa' ? { ...VAZIO, pessoas: 1 } : { ...VAZIO, jobs: 1 };
  const r = passos(c, atual);
  return r.erro ? null : r.passos[0] ?? null;
}
