// O estado de um cartão na nuvem (o que GET /api/world/cards devolve) → o item do menu e o selo. Sem tela aqui:
// conferido por nuvem-cartao.test.ts.
import type { ChaveWorld, tw } from './textos.ts';

export type Selo = 'na_fila' | 'trabalhando' | 'concluido' | 'falhou' | 'recuperando';
/** o que o servidor devolve; recovery, history e fallback podem faltar (servidor mais antigo) */
export interface CartaoNuvem {
  ref: string; where: 'local' | 'preparing' | 'remote'; badge: Selo | null; jobState: string | null; canSend: boolean; reason: string | null; canClaim: boolean;
  recovery?: { round: number; of: number }; history?: Array<{ round: number; reason: string }>; fallback?: string | null;
}

export const SELO: Record<Selo | 'preparando', Extract<ChaveWorld, `cartao.selo.${string}`>> = {
  na_fila: 'cartao.selo.naFila', trabalhando: 'cartao.selo.trabalhando', concluido: 'cartao.selo.concluido', falhou: 'cartao.selo.falhou', preparando: 'cartao.selo.preparando', recuperando: 'cartao.selo.recuperando',
};
export const TOM: Record<Selo | 'preparando', 'info' | 'ok' | 'warn'> = { na_fila: 'info', trabalhando: 'info', concluido: 'ok', falhou: 'warn', preparando: 'info', recuperando: 'warn' };

/** O texto do selo: na rodada de recuperação, "Recuperando na nuvem (2 de 3)". */
export function textoDoSelo(c: CartaoNuvem, selo: Selo | 'preparando', t: typeof tw): string {
  if (selo === 'recuperando') return t('cartao.selo.recuperando', { rodada: c.recovery?.round ?? 1, total: c.recovery?.of ?? 3 });
  return t(SELO[selo] as Exclude<(typeof SELO)[Selo], 'cartao.selo.recuperando'>);
}

/** O aviso curto depois que rodou no Ergon AI (sem o modelo do agente): "Rodou no Ergon AI: <motivo>". */
export const avisoDoModelo = (c: CartaoNuvem, t: typeof tw): string | null => (c.fallback ? t('cartao.ergonAi', { motivo: c.fallback }) : null);

/** Falhou na nuvem: o que falhou em cada rodada, curto ("Rodada 2: resposta cortada"). Vazio fora da falha final. */
export function historicoDaFalha(c: CartaoNuvem, t: typeof tw): string[] {
  if (c.where !== 'remote' || c.badge !== 'falhou') return [];
  return (c.history ?? []).map((x) => (x.round > 0 ? t('cartao.rodada', { n: x.round, motivo: x.reason }) : t('cartao.rodadaOriginal', { motivo: x.reason })));
}

export interface ResumoFora { counts: { concluidos: number; recuperados: number; falharam: number; ergonAi: number }; items: Array<{ ref: string; title: string | null; outcome: string; recovered: boolean; fallback: string | null; reason: string | null }> }
/** "Enquanto você esteve fora": a linha com os números (só os que não são zero); null = nada a mostrar. */
export function linhaDoResumo(r: ResumoFora | null | undefined, t: typeof tw): string | null {
  const c = r?.counts;
  if (!c || !(c.concluidos || c.falharam)) return null;
  const partes = [
    c.concluidos ? t('fora.concluidos', { n: c.concluidos }) : '', c.recuperados ? t('fora.recuperados', { n: c.recuperados }) : '',
    c.falharam ? t('fora.falharam', { n: c.falharam }) : '', c.ergonAi ? t('fora.ergonAi', { n: c.ergonAi }) : '',
  ].filter(Boolean);
  return `${t('fora.titulo')}: ${partes.join(' · ')}`;
}
/** Uma linha do detalhe do resumo: o nome do card e o que aconteceu. */
export function detalheDoResumo(x: ResumoFora['items'][number], t: typeof tw): string {
  const nome = x.title ?? t('fora.semNome');
  const o = x.outcome === 'falhou' ? t('fora.itemFalhou', { motivo: x.reason ?? '—' }) : x.recovered ? t('fora.itemRecuperado') : t('fora.itemConcluido');
  return `${nome}: ${o}${x.fallback ? ` · ${t('cartao.ergonAi', { motivo: x.fallback })}` : ''}`;
}

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
