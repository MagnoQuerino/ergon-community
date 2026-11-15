// O estado de um cartão na nuvem (o que GET /api/world/cards devolve) → o item do menu e o selo. Sem tela aqui:
// conferido por nuvem-cartao.test.ts.
import type { ChaveWorld } from './textos.ts';

export type Selo = 'na_fila' | 'trabalhando' | 'concluido' | 'falhou';
export interface CartaoNuvem { ref: string; where: 'local' | 'preparing' | 'remote'; badge: Selo | null; jobState: string | null; canSend: boolean; reason: string | null; canClaim: boolean }

export const SELO: Record<Selo | 'preparando', Extract<ChaveWorld, `cartao.selo.${string}`>> = {
  na_fila: 'cartao.selo.naFila', trabalhando: 'cartao.selo.trabalhando', concluido: 'cartao.selo.concluido', falhou: 'cartao.selo.falhou', preparando: 'cartao.selo.preparando',
};
export const TOM: Record<Selo | 'preparando', 'info' | 'ok' | 'warn'> = { na_fila: 'info', trabalhando: 'info', concluido: 'ok', falhou: 'warn', preparando: 'info' };

/**
 * Na nuvem: o selo; "Trazer para este computador" só com o Job terminado. Aqui: "Rodar na nuvem", desabilitado com o
 * motivo quando o cartão não pode ir agora.
 */
export function estadoDoCartao(c: CartaoNuvem): { acao: 'enviar' | 'trazer' | null; pode: boolean; motivo: string | null; selo: Selo | 'preparando' | null } {
  if (c.where === 'remote') return { acao: c.canClaim ? 'trazer' : null, pode: c.canClaim, motivo: null, selo: c.badge ?? 'na_fila' };
  return { acao: 'enviar', pode: c.canSend, motivo: c.canSend ? null : c.reason, selo: c.where === 'preparing' ? 'preparando' : null };
}

/** Há cartão trabalhando na nuvem: a tela relê de leve (o servidor lê o World no máximo a cada 20 s). */
export const acompanhar = (cards: CartaoNuvem[]): boolean => cards.some((c) => c.where === 'preparing' || (c.where === 'remote' && !c.canClaim));

/** O nome do workspace do World na lista (o código curto só quando ele não tem nome). */
export function nomeDoWorkspace(w: { workspaceId: string; label?: string | null }): { nome: string } | { codigo: string } {
  const n = w.label?.trim();
  return n ? { nome: n } : { codigo: `${w.workspaceId.slice(0, 12)}…` };
}
