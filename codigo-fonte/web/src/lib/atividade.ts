/**
 * Atividade: cada linha abre o que aconteceu — o card, a conversa, o agente, a rotina, a conexão ou a aba com o
 * detalhe. Aqui só a decisão (para onde ir), sem tela: a tela chama `destinoDo…` e segue o caminho.
 * Só identificadores passam adiante (nunca o texto), e só os que têm o formato esperado.
 */
export type Destino =
  | { tipo: 'card'; id: string }
  | { tipo: 'conversa'; agentId: string; conversationId: string }
  | { tipo: 'agente'; id: string }
  | { tipo: 'execucao'; id: string }
  | { tipo: 'endereco'; href: string }
  | { tipo: 'aba'; aba: 'eventos' };

const ID = /^[a-z]{2,8}_[A-Za-z0-9]{6,64}$/;
const KIND = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const id = (v: string | null | undefined): string | null => (v && ID.test(v) ? v : null);

/** Uma execução: o card dela; sem card, a conversa; sem as duas, a atividade do agente que executou. */
export function destinoDaExecucao(r: { task_id?: string | null; conversation_id?: string | null; agent_id?: string | null }): Destino | null {
  const task = id(r.task_id); const conv = id(r.conversation_id); const agent = id(r.agent_id);
  if (task) return { tipo: 'card', id: task };
  if (conv && agent) return { tipo: 'conversa', agentId: agent, conversationId: conv };
  if (agent) return { tipo: 'agente', id: agent };
  return null;
}

/** Um evento de origem (o que chegou por um canal): o card que ele virou, se virou. */
export function destinoDoEvento(e: { task_id?: string | null }): Destino | null {
  const task = id(e.task_id);
  return task ? { tipo: 'card', id: task } : null;
}

/** Uma linha do registro: pelo alvo da ação. O que não tem tela própria (um andar, um lote de cards) fica sem destino. */
export function destinoDoRegistro(e: { target_type: string | null; target_id?: string | null; actor_type?: string | null; actor_id?: string | null }): Destino | null {
  const alvo = e.target_id ?? null;
  switch (e.target_type) {
    case 'task': { const t = id(alvo); return t ? { tipo: 'card', id: t } : null; }
    case 'run': { const r = id(alvo); return r ? { tipo: 'execucao', id: r } : null; }
    case 'agent': { const a = id(alvo); return a ? { tipo: 'agente', id: a } : null; }
    case 'routine': { const r = id(alvo); return r ? { tipo: 'endereco', href: `#rotinas?rotina=${r}` } : null; }
    case 'board': { const b = id(alvo); return b ? { tipo: 'endereco', href: `#tarefas?board=${b}` } : null; }
    case 'integration': return alvo && KIND.test(alvo) ? { tipo: 'endereco', href: `#conexoes?app=${alvo}` } : null;
    case 'conversation': {
      // a conversa abre pelo agente: só quando foi o próprio agente quem agiu
      const c = id(alvo); const a = e.actor_type === 'agent' ? id(e.actor_id) : null;
      return c && a ? { tipo: 'conversa', agentId: a, conversationId: c } : null;
    }
    case 'rule': return { tipo: 'endereco', href: '#conexoes?regras' };
    case 'source_event': return { tipo: 'aba', aba: 'eventos' };
    default: return null;
  }
}

/** O que a linha diz que abre (o "title" e o rótulo para quem usa leitor de tela). */
export function rotuloDoDestino(d: Destino): string {
  switch (d.tipo) {
    case 'card': return 'Abrir o card';
    case 'conversa': return 'Abrir a conversa';
    case 'agente': return 'Abrir o agente';
    case 'execucao': return 'Abrir o que esta execução fez';
    case 'aba': return 'Ver nos eventos de origem';
    case 'endereco': return d.href.startsWith('#rotinas') ? 'Abrir a rotina' : d.href.startsWith('#conexoes') ? 'Abrir a conexão' : 'Abrir a lista';
  }
}

/**
 * O nome da linha clicável para quem usa leitor de tela: o que ela abre e de que linha se trata ("Abrir o card:
 * tarefa.criada, 09/11/2026 10:00"). Sem ele, a linha com foco era anunciada só pelas células, sem dizer que abre algo.
 */
export function rotuloDaLinha(d: Destino, resumo: string): string {
  const r = resumo.replace(/\s+/g, ' ').trim();
  return r ? `${rotuloDoDestino(d)}: ${r}` : rotuloDoDestino(d);
}
