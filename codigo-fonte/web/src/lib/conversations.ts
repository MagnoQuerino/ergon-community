import type { RecentConversation } from './types.ts';

export type Section = 'fixadas' | 'precisa' | 'recentes';
export const SECTION_LABEL: Record<Section, string> = { fixadas: 'Fixadas', precisa: 'Precisa de você', recentes: 'Recentes' };

/**
 * Um contato na lista de conversas: o colega, as conversas com ele (os assuntos), o que você ainda não leu, se alguma
 * está fixada, a marca de prioridade mais alta e o que espera você.
 */
export interface Contact {
  agentId: string; latest: RecentConversation; count: number; titles: string[]; convs: RecentConversation[];
  unread: number; pinned: boolean; priority: 'urgente' | 'alta' | null; priorityReason: string | null; waiting: number; section: Section; lastAt: string;
}

const at = (c: RecentConversation) => c.last_at ?? c.last_user_at ?? c.created_at;

/**
 * Uma linha por colega, como num aplicativo de mensagens: Fixadas › Precisa de você › Recentes, cada grupo pela
 * última atividade (decisão de 30/10: com o ponto de não lida, o que o colega escreve também sobe; antes, só o que
 * você escrevia). Os assuntos com o mesmo colega ficam dentro do contato, as fixadas primeiro.
 */
export function contactsOf(list: RecentConversation[]): Contact[] {
  const by = new Map<string, RecentConversation[]>();
  for (const c of list) by.set(c.agent_id, [...(by.get(c.agent_id) ?? []), c]);
  const out: Contact[] = [];
  for (const [agentId, raw] of by) {
    const byTime = [...raw].sort((a, b) => at(b).localeCompare(at(a)));
    const convs = [...byTime].sort((a, b) => Number(!!b.pinned_at) - Number(!!a.pinned_at));
    const prio = raw.some((c) => c.priority === 'urgente') ? 'urgente' : raw.some((c) => c.priority === 'alta') ? 'alta' : null;
    const pinned = raw.some((c) => !!c.pinned_at);
    const waiting = raw.reduce((n, c) => n + (c.waiting ?? 0), 0);
    out.push({
      agentId, latest: byTime[0], count: raw.length, titles: byTime.map((c) => c.title), convs,
      unread: raw.reduce((n, c) => n + (c.unread ?? 0), 0), pinned, priority: prio,
      priorityReason: raw.find((c) => c.priority === prio)?.priority_reason ?? null, waiting,
      section: pinned ? 'fixadas' : prio || waiting ? 'precisa' : 'recentes', lastAt: at(byTime[0]),
    });
  }
  const rank: Record<Section, number> = { fixadas: 0, precisa: 1, recentes: 2 };
  const urgent = (x: Contact) => Number(x.section === 'precisa' && x.priority === 'urgente');
  return out.sort((a, b) => (rank[a.section] - rank[b.section]) || (urgent(b) - urgent(a)) || b.lastAt.localeCompare(a.lastAt));
}

/** Tudo o que você ainda não viu (o número no atalho e na barra). */
export function unreadTotal(list: RecentConversation[]): number {
  return list.reduce((n, c) => n + (c.unread ?? 0), 0);
}
