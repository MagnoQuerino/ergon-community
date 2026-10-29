/**
 * Abrir um card ou uma conversa de qualquer lugar (a conversa, "aguardando você", o modo foco), sem trocar de tela:
 * o Shell escuta e abre por cima do que estiver aberto. Só identificadores passam por aqui.
 */
const CARD = 'ergon:abrir-card';
const CONVERSA = 'ergon:abrir-conversa';

export function openCard(taskId: string): void {
  window.dispatchEvent(new CustomEvent(CARD, { detail: { taskId } }));
}

/** Abre o diálogo das conversas nesta (ou na última que você ativou, sem argumentos). */
export function openConversation(agentId?: string | null, conversationId?: string | null): void {
  window.dispatchEvent(new CustomEvent(CONVERSA, { detail: { agentId: agentId ?? null, conversationId: conversationId ?? null } }));
}

export function onOpenCard(fn: (taskId: string) => void): () => void {
  const h = (e: Event) => { const id = (e as CustomEvent<{ taskId: string }>).detail?.taskId; if (id) fn(id); };
  window.addEventListener(CARD, h);
  return () => window.removeEventListener(CARD, h);
}

export function onOpenConversation(fn: (agentId: string | null, conversationId: string | null) => void): () => void {
  const h = (e: Event) => { const d = (e as CustomEvent<{ agentId: string | null; conversationId: string | null }>).detail; fn(d?.agentId ?? null, d?.conversationId ?? null); };
  window.addEventListener(CONVERSA, h);
  return () => window.removeEventListener(CONVERSA, h);
}

const DECISOES = 'ergon:abrir-decisoes';
/** Abre "Aguardando você" (o mesmo painel do sino), de qualquer lugar: a praça da cidade, a Central de Trabalho. */
export function openDecisions(): void { window.dispatchEvent(new CustomEvent(DECISOES)); }
export function onOpenDecisions(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener(DECISOES, h);
  return () => window.removeEventListener(DECISOES, h);
}
