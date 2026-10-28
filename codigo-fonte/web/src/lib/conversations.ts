import type { RecentConversation } from './types.ts';

/** Um contato na lista de conversas: o agente, a conversa que você ativou por último e quantas há com ele. */
export interface Contact { agentId: string; latest: RecentConversation; count: number; titles: string[] }

/**
 * Uma linha por contato (agente), na ordem da última vez que VOCÊ escreveu a ele; as várias conversas com o mesmo
 * agente ficam no seletor da conversa, não repetidas na lista. Antes, cada conversa era uma linha e o mesmo agente
 * aparecia várias vezes.
 */
export function contactsOf(list: RecentConversation[]): Contact[] {
  const by = new Map<string, Contact>();
  const sorted = [...list].sort((a, b) => b.last_user_at.localeCompare(a.last_user_at));
  for (const c of sorted) {
    const cur = by.get(c.agent_id);
    if (cur) { cur.count++; cur.titles.push(c.title); } else by.set(c.agent_id, { agentId: c.agent_id, latest: c, count: 1, titles: [c.title] });
  }
  return [...by.values()];
}
