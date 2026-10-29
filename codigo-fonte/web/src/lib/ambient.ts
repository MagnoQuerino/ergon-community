/**
 * Leitura do trabalho da equipe para o Ambiente (GET /api/ambient/operations, server/src/services/ambient.ts).
 * Só leitura: as ações abrem os painéis de sempre (card, "Aguardando você", conversa).
 */
export const OPS_URL = '/api/ambient/operations';
/** eventos que mudam o trabalho (o mesmo SSE do resto do Ergon; recarga agregada pelo useResource) */
export const OPS_EVENTS = ['tasks.changed', 'runs.changed', 'proposals.changed', 'rules.changed', 'agents.changed'];

export type OpsCategory = 'ativo' | 'pronto' | 'bloqueado' | 'precisa_de_voce' | 'impedido' | 'falhou';
export type OpsAction = 'abrir' | 'priorizar' | 'responder' | 'parar' | 'cancelar' | 'conversa';
export interface OpsItem {
  key: string; source: 'task' | 'run'; taskId: string | null; number: number | null; runId: string | null; title: string;
  agentId: string | null; agentName: string | null; category: OpsCategory; reason: string; reasonCode: string;
  position: number | null; slot: boolean; since: string | null; priority: boolean; simulated: boolean;
  dependsOn: Array<{ taskId: string; number: number; agentName: string | null }>; actions: OpsAction[];
}
export interface OpsDelivery {
  taskId: string; number: number; title: string; agentName: string | null; completedAt: string;
  by: 'agent' | 'human' | 'external'; resultState: string | null; kind: string | null; deliverables: number; simulated: boolean;
}
export interface AmbientOps {
  version: number; at: string; workspaceId: string;
  local: { limit: number | null; choice: 'auto' | 'ilimitado' | number; cap: number | null; busy: number; waitingExecutor: number; conversations: number; autorun: boolean; mode: 'real' | 'simulated' };
  totals: Record<OpsCategory, number>; items: Record<OpsCategory, OpsItem[]>; more: Record<OpsCategory, number>;
  decisions: { total: number };
  deliveries: { total: number; days: number; items: OpsDelivery[] };
}

/** Resumo para a cena (placas da cidade): só números, sem títulos. */
export interface OpsSummary {
  busy: number; limit: number | null; ready: number; blocked: number; attention: number; decisions: number; deliveries: number; cloud: boolean;
}
export const summaryOf = (o: AmbientOps, cloud = false): OpsSummary => ({ cloud,
  busy: o.local.busy, limit: o.local.limit, ready: o.totals.pronto, blocked: o.totals.bloqueado + o.totals.impedido + o.totals.falhou,
  attention: o.totals.precisa_de_voce, decisions: o.decisions.total, deliveries: o.deliveries.total,
});

/** Trabalho na nuvem ligado nesta instalação (edição com o World e o serviço configurado). */
export interface Distribution { distribution: string; world: { available: boolean; configured?: boolean } }
export const cloudOn = (d: Distribution | null | undefined): boolean => !!d?.world.available && !!d.world.configured;

/** Tempo decorrido em palavras curtas ("há 3 min"); sem estimativa de quanto falta. */
export function elapsed(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}
