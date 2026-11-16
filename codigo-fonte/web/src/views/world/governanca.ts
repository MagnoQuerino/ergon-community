// A Governança do workspace no Ergon World (World Team): quem vê o item do menu, a frase de cada linha do registro e
// as barras dos tetos. Puro: conferido por governanca.test.ts.
import { comPlano, nivelDe, type EstadoPlano } from './compra-rapida.ts';
import type { ChaveWorld, tw } from './textos.ts';

/** 'aberto' = World Team e a pessoa administra; 'trancado' = administra, mas o plano não é o Team; null = não aparece. */
export type AcessoGov = 'aberto' | 'trancado' | null;
export function acessoGovernanca(bound: boolean, b: EstadoPlano | null): AcessoGov {
  if (!bound || !b || !['owner', 'admin'].includes(b.role)) return null;
  return comPlano(b) && nivelDe(b.entitlement.plan_sku, b.entitlement.tier) === 'team' ? 'aberto' : 'trancado';
}

export interface Atividade { id: string; at: string; action: string; actor: { accountId: string; name: string | null } | null; target: { accountId: string; name: string | null } | null; detail?: Record<string, string> | null }
const PAPEL: Record<string, Extract<ChaveWorld, `papel.${string}`>> = { owner: 'papel.owner', admin: 'papel.admin', editor: 'papel.editor', viewer: 'papel.viewer' };

/** A frase de uma linha do registro ("Ana mudou o papel de Bia para Admin"); ação desconhecida: o código, curto. */
export function linhaDaAtividade(a: Atividade, t: typeof tw, dracmas: (v: string) => string): string {
  const quem = a.actor?.name?.trim() || t('gov.alguem'); const alvo = a.target?.name?.trim() || t('gov.alguem');
  const d = a.detail ?? {}; const papel = PAPEL[d.role ?? ''] ? t(PAPEL[d.role]) : d.role ?? '';
  switch (a.action) {
    case 'budget.set': return !d.cap || d.cap === 'livre' || d.cap === 'null' ? t('gov.acao.tetoLivre', { quem, alvo }) : t('gov.acao.teto', { quem, alvo, valor: dracmas(d.cap) });
    case 'sync.member.role': return t('gov.acao.papel', { quem, alvo, papel });
    case 'sync.member.remove': return t('gov.acao.tirou', { quem, alvo });
    case 'sync.member.join': return t('gov.acao.entrou', { quem, papel });
    case 'jobs.policy': return d.recovery === 'false' ? t('gov.acao.recuperacaoDesligada', { quem }) : t('gov.acao.recuperacaoLigada', { quem });
    case 'wallet.topup': return t('gov.acao.recarga');
    case 'wallet.monthly': return t('gov.acao.franquia');
    case 'wallet.upgrade': return t('gov.acao.subiu');
    case 'card.handoff': return t('gov.acao.nuvem', { quem });
    case 'jobs.recovery': return t('gov.acao.recuperou');
    case 'sync.transfer': return t('gov.acao.titularidade', { quem, alvo });
    default: return t('gov.acao.outra', { quem, acao: a.action.slice(0, 40) });
  }
}
/** O ícone de cada tipo de linha. */
export const iconeDaAtividade = (action: string): string => (action.startsWith('budget') || action.startsWith('wallet') ? 'coins'
  : action.startsWith('sync.member') || action === 'sync.transfer' ? 'users' : action.startsWith('jobs') || action === 'card.handoff' ? 'cloud' : 'shield');

/** A barra do teto: quanto do teto foi usado (0 a 100); sem teto, proporcional ao maior gasto do mês. */
export function barraDoTeto(usado: number, teto: number | null, maior: number): { pct: number; tom: 'ok' | 'atencao' | 'cheio' | 'livre' } {
  if (teto === null) return { pct: maior > 0 ? Math.min(100, (usado / maior) * 100) : 0, tom: 'livre' };
  if (teto <= 0) return { pct: 100, tom: 'cheio' };
  const pct = Math.min(100, (usado / teto) * 100);
  return { pct, tom: pct >= 100 ? 'cheio' : pct >= 80 ? 'atencao' : 'ok' };
}
