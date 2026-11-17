import { useResource } from '../../lib/live.ts';

/** As regras comerciais que as telas mostram, vindas do World (catálogo.policy): mudam sem versão nova do app. */
export interface Politica { graceDays: number; retentionDays: number; annualDiscountPct: number; jobPackSize: number; planLinks: Record<string, number> }
const PADRAO: Politica = { graceDays: 7, retentionDays: 30, annualDiscountPct: 10, jobPackSize: 5, planLinks: { sync: 1, pro: 3, team: 10 } };

export function usePolitica(): Politica {
  const c = useResource<{ policy?: Partial<Politica> }>('/api/world/catalog', []);
  return { ...PADRAO, ...(c.data?.policy ?? {}) };
}
