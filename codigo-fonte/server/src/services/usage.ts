/**
 * Consumo de modelo: só o que o provedor informou nas execuções reais (tokens de entrada e saída e, quando
 * houver, o custo cobrado). Ausente não vira zero e nada é estimado. O painel se adapta à conta:
 * assinatura (ChatGPT) não tem custo por uso; créditos (Nous) e chave de API só mostram custo quando o
 * provedor informa o valor cobrado. Tokens valem sempre. Os limites e o saldo da assinatura (5 h / semana, créditos)
 * vêm do provedor, lidos pelo motor (rc.27: a ponte de controle, /ergon/v1/cota): `accounts`. Motor de antes ou
 * provedor que não informa: lista vazia (a tela não mostra nada no lugar).
 */
import type { Db } from '../db/db.ts';
import type { Billing } from './ai.ts';
import type { CotaConta } from './hermes.ts';

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
  /** limites e saldo de cada conta de IA, como o provedor informa (nunca estimado); vazio = não informado */
  accounts: ContaDeIa[];
  /** tipo de cobrança da conta do modelo padrão */
  billing: Billing;
  /** mostrar custo? só quando algum custo cobrado foi informado (nunca estimado) */
  costVisible: boolean;
  note: string;
}

/** Uma janela de limite: quanto RESTA (0 a 100) e quando renova. */
export interface JanelaDeUso { kind: 'sessao' | 'semana' | 'semana_modelo' | 'assinatura' | 'chave' | 'outro'; label: string; usedPercent: number; leftPercent: number; resetsAt: string | null; scope: 'conta' | 'modelo' }
export interface ContaDeIa { provider: string; plan: string | null; windows: JanelaDeUso[]; balanceUsd: number | null; unlimited: boolean; renewsAt: string | null; readAt: string | null }

/** O que o motor leu do provedor → o que a tela mostra (o que resta, arredondado; datas só se forem datas). */
export function contasDeIa(cota: CotaConta[] | null | undefined): ContaDeIa[] {
  const data = (v: string | null) => (v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
  return (cota ?? []).map((c) => ({
    provider: c.provedor, plan: c.plano,
    windows: c.janelas.map((w) => { const usado = Math.round(Math.max(0, Math.min(100, w.usado))); return { kind: w.tipo, label: w.rotulo, usedPercent: usado, leftPercent: 100 - usado, resetsAt: data(w.renovaEm), scope: w.escopo }; }),
    balanceUsd: c.saldoUsd, unlimited: c.saldoIlimitado, renewsAt: data(c.renovaEm), readAt: data(c.lidoEm),
  })).filter((c) => c.windows.length || c.balanceUsd !== null || c.unlimited);
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
  none: 'Sem conta de IA conectada: a equipe não trabalha nos pedidos, sem consumo.',
};

export function usageSummary(db: Db, workspaceId: string, tzOffsetMin: number, nowMs = Date.now(), billing: Billing = 'none', cota: CotaConta[] | null = null): UsageSummary {
  const s = periodStarts(nowMs, tzOffsetMin);
  const month = period(db, workspaceId, s.month);
  const year = period(db, workspaceId, s.year);
  return {
    month, year, subscription: null, accounts: contasDeIa(cota), billing,
    costVisible: billing !== 'subscription' && (month.runsWithCost > 0 || year.runsWithCost > 0),
    note: NOTE[billing],
  };
}
