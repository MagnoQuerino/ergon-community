/**
 * Abrir um card ou uma conversa de qualquer lugar (a conversa, "aguardando você", o modo foco), sem trocar de tela:
 * o Shell escuta e abre por cima do que estiver aberto. Só identificadores passam por aqui.
 */
const CARD = 'ergon:abrir-card';
const CONVERSA = 'ergon:abrir-conversa';

/** de: a lista de onde o card foi aberto ('decisoes' = Aguardando você): o card ganha "Voltar" e o X volta à lista */
export type OrigemDoCard = 'decisoes';
export function openCard(taskId: string, de?: OrigemDoCard): void {
  window.dispatchEvent(new CustomEvent(CARD, { detail: { taskId, de: de ?? null } }));
}

/** Abre o diálogo das conversas nesta (ou na última que você ativou, sem argumentos). */
export function openConversation(agentId?: string | null, conversationId?: string | null): void {
  window.dispatchEvent(new CustomEvent(CONVERSA, { detail: { agentId: agentId ?? null, conversationId: conversationId ?? null } }));
}

export function onOpenCard(fn: (taskId: string, de: OrigemDoCard | null) => void): () => void {
  const h = (e: Event) => { const d = (e as CustomEvent<{ taskId: string; de?: OrigemDoCard | null }>).detail; if (d?.taskId) fn(d.taskId, d.de ?? null); };
  window.addEventListener(CARD, h);
  return () => window.removeEventListener(CARD, h);
}

/** Abre o diálogo das conversas numa sala (rc.42: conversa em grupo). */
export function openSala(salaId: string, foco?: string | null): void {
  window.dispatchEvent(new CustomEvent(CONVERSA, { detail: { agentId: null, conversationId: null, salaId, foco: foco ?? null } }));
}

/** `foco` (sala): o pedido de cessão (sav_…) ou a mensagem (msg_…) que a sala mostra em destaque ao abrir */
export function onOpenConversation(fn: (agentId: string | null, conversationId: string | null, salaId?: string | null, foco?: string | null) => void): () => void {
  const h = (e: Event) => { const d = (e as CustomEvent<{ agentId: string | null; conversationId: string | null; salaId?: string | null; foco?: string | null }>).detail; fn(d?.agentId ?? null, d?.conversationId ?? null, d?.salaId ?? null, d?.foco ?? null); };
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
