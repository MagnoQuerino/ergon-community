/**
 * Consumo de modelo: só o que o provedor informou nas execuções reais (tokens de entrada e saída e, quando
 * houver, o custo cobrado). Ausente não vira zero e nada é estimado. O painel se adapta à conta:
 * assinatura (ChatGPT) não tem custo por uso; créditos (Nous) e chave de API só mostram custo quando o
 * provedor informa o valor cobrado. Tokens valem sempre. Limites de assinatura (5 h / semana) só aparecem
 * quando o motor os informar (a versão atual não informa).
 */
import type { Db } from '../db/db.ts';
import type { Billing } from './ai.ts';

export interface UsagePeriod {
  from: string;
  runs: number; // execuções reais no período
  runsWithTokens: number;
  tokensIn: number;
  tokensOut: number;
  runsWithCost: number;
  costUsd: number | null; // null = nenhum custo informado pelo provedor
}

export interface UsageSummary {
  month: UsagePeriod;
  year: UsagePeriod;
  subscription: null | { provider: string; windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> };
  /** tipo de cobrança da conta do modelo padrão */
  billing: Billing;
  /** mostrar custo? só quando algum custo cobrado foi informado (nunca estimado) */
  costVisible: boolean;
  note: string;
}

/** Início do mês e do ano no fuso de quem pergunta (minutos de diferença para UTC, como Date.getTimezoneOffset). */
export function periodStarts(nowMs: number, tzOffsetMin: number): { month: string; year: string } {
  const local = new Date(nowMs - tzOffsetMin * 60_000); // relógio local representado em UTC
  const m = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + tzOffsetMin * 60_000;
  const y = Date.UTC(local.getUTCFullYear(), 0, 1) + tzOffsetMin * 60_000;
  return { month: new Date(m).toISOString(), year: new Date(y).toISOString() };
}

function period(db: Db, workspaceId: string, from: string): UsagePeriod {
  const r = db.get<{ runs: number; wt: number; tin: number | null; tout: number | null; wc: number; cost: number | null }>(
    `SELECT COUNT(*) AS runs,
            SUM(tokens_in IS NOT NULL OR tokens_out IS NOT NULL) AS wt,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
            SUM(cost_usd IS NOT NULL AND COALESCE(cost_is_estimate, 0) = 0) AS wc,
            SUM(CASE WHEN COALESCE(cost_is_estimate, 0) = 0 THEN cost_usd END) AS cost
       FROM runs WHERE workspace_id = ? AND mode = 'real' AND created_at >= ?`, workspaceId, from);
  return {
    from, runs: Number(r?.runs ?? 0), runsWithTokens: Number(r?.wt ?? 0), tokensIn: Number(r?.tin ?? 0), tokensOut: Number(r?.tout ?? 0),
    runsWithCost: Number(r?.wc ?? 0), costUsd: r?.cost === null || r?.cost === undefined ? null : Number(r.cost),
  };
}

const NOTE: Record<Billing, string> = {
  subscription: 'Assinatura do ChatGPT: sem custo por uso (vale a mensalidade). Os tokens mostram quanto a equipe trabalhou.',
  credits: 'Conta com créditos: o custo aparece quando o provedor informa o valor cobrado; o saldo fica no portal da conta.',
  api: 'Chave de API: o custo aparece quando o provedor informa o valor cobrado de cada execução.',
  none: 'Sem conta de IA conectada: respostas simuladas, sem consumo.',
};

export function usageSummary(db: Db, workspaceId: string, tzOffsetMin: number, nowMs = Date.now(), billing: Billing = 'none'): UsageSummary {
  const s = periodStarts(nowMs, tzOffsetMin);
  const month = period(db, workspaceId, s.month);
  const year = period(db, workspaceId, s.year);
  return {
    month, year, subscription: null, billing,
    costVisible: billing !== 'subscription' && (month.runsWithCost > 0 || year.runsWithCost > 0),
    note: NOTE[billing],
  };
}
