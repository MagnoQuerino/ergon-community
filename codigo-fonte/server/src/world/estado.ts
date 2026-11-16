/**
 * O que o Estado do Ergon, a etiqueta do plano na barra de cima e a Governança mostram do Ergon World, lido aqui (a
 * sessão do World nunca vai à tela):
 *  - GET /api/world/consumo: os Dracmas gastos no mês (Ergon AI × Jobs, pelo extrato), a data da próxima franquia e os
 *    Jobs do mês;
 *  - GET /api/world/cards/recent: os últimos resultados da nuvem neste computador (vistos ou não);
 *  - GET /api/world/activity: o registro do que aconteceu no workspace World (só para quem administra).
 * O mês é o mês-calendário no horário de Salvador, como o teto por pessoa do World. Falha do World não vira zero: a
 * resposta diz que não está disponível.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import type { HttpError } from '../lib/util.ts';
import type { WorldClient } from './link.ts';

interface Ctx { userId: string; workspaceId: string }
export interface EstadoHost {
  app: FastifyInstance; db: Db; client: WorldClient;
  auth(req: FastifyRequest): Ctx;
  /** o workspace World do workspace atual, só se for o ligado pela pessoa */
  worldWs(a: Ctx): string | null;
  /** a sessão do World da pessoa, ou null sem conta conectada */
  session(userId: string): string | null;
}

/** Começo do mês-calendário em Salvador (UTC−3, sem horário de verão), em UTC. */
export function inicioDoMes(agora = new Date()): Date {
  const local = new Date(agora.getTime() - 3 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 3));
}

const MICRO = 1_000_000n;
/** "12.345678" (Dracmas com 6 casas, como o World manda) → micro-Dracmas; texto estranho vira 0. */
export function paraMicro(v: unknown): bigint {
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,6}))?$/.exec(String(v ?? '').trim());
  if (!m) return 0n;
  const n = BigInt(m[2]) * MICRO + BigInt((m[3] ?? '').padEnd(6, '0'));
  return m[1] ? -n : n;
}
export const deMicro = (n: bigint): string => { const neg = n < 0n; const a = neg ? -n : n; return `${neg ? '-' : ''}${a / MICRO}.${(a % MICRO).toString().padStart(6, '0')}`; };

interface Entrada { kind: string; amount: string; createdAt: string; meta?: { component?: string } | null }
/**
 * Soma o que saiu dos Dracmas desde `desde`, por componente: capture de 'ai_tokens' é Ergon AI, de 'job_seconds' é Job,
 * o resto fica em "outros". O extrato vem do mais novo para o mais velho; para ao passar do começo do mês.
 */
export function somarGastos(entradas: Entrada[], desde: Date): { ai: bigint; jobs: bigint; other: bigint; passou: boolean } {
  const s = { ai: 0n, jobs: 0n, other: 0n, passou: false };
  for (const e of entradas) {
    if (new Date(e.createdAt) < desde) { s.passou = true; break; }
    if (e.kind !== 'capture') continue;
    const v = paraMicro(e.amount); const c = e.meta?.component;
    if (c === 'ai_tokens') s.ai += v; else if (c === 'job_seconds') s.jobs += v; else s.other += v;
  }
  return s;
}

interface Billing { entitlement?: { status?: string; plan_sku?: string | null; source?: string | null; next_grant_at?: string | null }; subscription?: { plan?: string | null; periodEnd?: string | null } | null }
/**
 * Quando chega a próxima franquia mensal: o World diz (entitlement.next_grant_at, aditivo); sem isso, no plano mensal
 * pago, é a renovação. No anual e na cortesia, sem o campo do World, não se sabe (null).
 */
export function proximaFranquia(b: Billing): string | null {
  const e = b.entitlement;
  if (!e || !['active', 'grace'].includes(e.status ?? '')) return null;
  if (e.next_grant_at) return e.next_grant_at;
  const plano = b.subscription?.plan ?? e.plan_sku ?? '';
  return e.source !== 'cortesia' && b.subscription?.periodEnd && !plano.endsWith('_annual') ? b.subscription.periodEnd : null;
}

export function registerEstado(h: EstadoHost): void {
  const { app, db, client } = h;
  const cache = new Map<string, { at: number; v: unknown }>();
  const nomeDe = (ref: string, ws: string): string | null => (ref.startsWith('card:')
    ? db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ? AND workspace_id = ?', ref.slice(5), ws)?.title ?? null
    : db.get<{ name: string }>('SELECT name FROM routines WHERE id = ? AND workspace_id = ?', ref.slice(7), ws)?.name ?? null);

  app.get('/api/world/consumo', async (req) => {
    const a = h.auth(req); const w = h.worldWs(a); const since = inicioDoMes();
    const vazio = { available: false, since: since.toISOString(), spent: { ai: '0.000000', jobs: '0.000000', other: '0.000000' }, nextMonthlyAt: null, jobs: null };
    const s = w ? h.session(a.userId) : null;
    if (!w || !s) return vazio;
    const key = `${a.userId}|${a.workspaceId}`; const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.v;
    try {
      // o extrato em páginas, até passar do começo do mês (no máximo 10 páginas de 200)
      const soma = { ai: 0n, jobs: 0n, other: 0n };
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const r: { next: string | null; entries: Entrada[] } = await client.call('GET', `/v1/wallet/statement?workspace=${w}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, s);
        const g = somarGastos(r.entries ?? [], since);
        soma.ai += g.ai; soma.jobs += g.jobs; soma.other += g.other;
        if (g.passou || !r.next || !(r.entries ?? []).length) break;
        cursor = r.next;
      }
      const bill = await client.call<Billing>('GET', `/v1/billing/state?workspace=${w}`, undefined, s);
      // os Jobs do mês no workspace inteiro (aditivo no World); sem a rota, os que voltaram para este computador
      let jobs: { total: number; succeeded: number; failed: number; recovered: number; source: 'world' | 'local' };
      try {
        const j = await client.call<{ total?: unknown; succeeded?: unknown; failed?: unknown; recovered?: unknown }>('GET', `/v1/jobs/stats?workspace=${w}&since=${encodeURIComponent(since.toISOString())}`, undefined, s);
        jobs = { total: Number(j.total) || 0, succeeded: Number(j.succeeded) || 0, failed: Number(j.failed) || 0, recovered: Number(j.recovered) || 0, source: 'world' };
      } catch (e) {
        if ((e as HttpError).code === 'world_offline') throw e;
        const r = db.get<{ total: number; ok: number; falhou: number; rec: number }>(`SELECT COUNT(*) AS total, SUM(outcome = 'concluido') AS ok, SUM(outcome = 'falhou') AS falhou, SUM(recovered) AS rec
          FROM world_cloud_results WHERE workspace_id = ? AND at >= ?`, a.workspaceId, since.toISOString());
        jobs = { total: Number(r?.total ?? 0), succeeded: Number(r?.ok ?? 0), failed: Number(r?.falhou ?? 0), recovered: Number(r?.rec ?? 0), source: 'local' };
      }
      const v = { available: true, since: since.toISOString(), spent: { ai: deMicro(soma.ai), jobs: deMicro(soma.jobs), other: deMicro(soma.other) }, nextMonthlyAt: proximaFranquia(bill), jobs };
      cache.set(key, { at: Date.now(), v });
      return v;
    } catch (e) {
      const code = (e as HttpError).code;
      if (code === 'world_offline' || code === 'rate_limited') return hit ? { ...(hit.v as object), stale: true } : { ...vazio, reason: 'offline' };
      throw e;
    }
  });

  app.get('/api/world/cards/recent', async (req) => {
    const a = h.auth(req);
    if (!h.worldWs(a)) return { items: [] };
    const rows = db.all<{ card_ref: string; outcome: string; recovered: number; fallback: string | null; at: string }>(
      'SELECT card_ref, outcome, recovered, fallback, at FROM world_cloud_results WHERE workspace_id = ? AND user_id = ? ORDER BY at DESC LIMIT 5', a.workspaceId, a.userId);
    return { items: rows.map((x) => ({ ref: x.card_ref, title: nomeDe(x.card_ref, a.workspaceId), outcome: x.outcome, recovered: !!Number(x.recovered), fallback: x.fallback, at: x.at })) };
  });

  app.get('/api/world/activity', async (req) => {
    const a = h.auth(req); const w = h.worldWs(a); const s = w ? h.session(a.userId) : null;
    if (!w || !s) return { available: false, allowed: false, entries: [] };
    try {
      const r = await client.call<{ entries?: unknown[] }>('GET', `/v1/workspaces/${w}/activity?limit=50`, undefined, s);
      return { available: true, allowed: true, entries: Array.isArray(r.entries) ? r.entries.slice(0, 50) : [] };
    } catch (e) {
      const st = (e as HttpError).status;
      // World sem o registro (rota que ainda não existe) ou sem permissão: a tela diz, sem erro
      if (st === 404) return { available: false, allowed: false, entries: [] };
      if (st === 403) return { available: true, allowed: false, entries: [] };
      throw e;
    }
  });
}
