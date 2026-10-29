import { useEffect, useMemo, useRef, useState } from 'react';
import { contactsOf } from '../lib/conversations.ts';
import { useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import type { Agent, RecentConversation } from '../lib/types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';

/** Quando: "agora", "há 5 min", "ontem 14:20", "12/10". */
const when = (iso: string) => {
  const d = new Date(iso); const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const today = new Date(); const y = new Date(Date.now() - 86_400_000);
  const hm = d.toLocaleTimeString('pt-BR', { timeStyle: 'short' });
  if (d.toDateString() === today.toDateString()) return hm;
  if (d.toDateString() === y.toDateString()) return `ontem ${hm}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
};

/**
 * Atalho fixo para retomar conversas, no canto inferior direito: o retrato do último agente com quem você falou e,
 * atrás dele, até 3 conversas anteriores. Passar o mouse aumenta um pouco e abre o leque; clicar abre a conversa já
 * com o cursor no campo. Com um painel aberto à direita (o card, por exemplo), o atalho fica ao lado dele. A ordem é a
 * da última vez que VOCÊ escreveu — o que os agentes escrevem sozinhos não conta.
 */
export function ConversationDock({ agents, hidden }: { agents: Agent[]; hidden?: boolean }) {
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'agents.changed']);
  const list = useMemo(() => (recent.data ?? []).filter((c) => agents.some((a) => a.id === c.agent_id && a.status === 'active')), [recent.data, agents]);
  // um círculo por contato (a conversa mais recente de cada um): o último e até 3 atrás
  const people = useMemo(() => contactsOf(list).slice(0, 4).map((x) => x.latest), [list]);
  if (hidden) return null;
  // ainda sem conversa: o atalho já está lá, e abre as Conversas com o Coordenador, pronto para escrever
  if (!people.length) {
    const coord = agents.find((a) => a.coordinator && a.status === 'active') ?? agents.find((a) => a.status === 'active');
    if (!coord) return null;
    return (
      <div className="cdock" role="navigation" aria-label="Conversas">
        <button type="button" className="cdock__bubble cdock__bubble--main cdock__bubble--vazio" onClick={() => openConversation(coord.id, null)}
          aria-label={`Conversas: começar com ${coord.name}`} title={`Conversas: comece falando com ${coord.name}`}>
          <Icon name="chat" size={26} />
        </button>
      </div>
    );
  }
  const agentOf = (id: string) => agents.find((a) => a.id === id)!;
  const [first, ...back] = people;
  return (
    <div className="cdock" role="navigation" aria-label="Retomar conversas">
      {back.slice().reverse().map((c, i) => {
        const a = agentOf(c.agent_id);
        const depth = back.length - i; // o mais antigo fica mais atrás
        return (
          <button key={c.id} type="button" className={`cdock__bubble cdock__bubble--back cdock__bubble--d${depth}`} style={{ ['--i' as string]: depth }}
            onClick={() => openConversation(c.agent_id, c.id)} aria-label={`Conversa com ${a.name}`} title={`${a.name} · ${when(c.last_user_at)}`}>
            <AgentAvatar agent={a} size={44} />
            <span className="cdock__name">{a.name}</span>
          </button>
        );
      })}
      <button type="button" className="cdock__bubble cdock__bubble--main" onClick={() => openConversation(first.agent_id, first.id)}
        aria-label={`Retomar a conversa com ${agentOf(first.agent_id).name}`} title={`Retomar a conversa com ${agentOf(first.agent_id).name} (${when(first.last_user_at)})`}>
        <AgentAvatar agent={agentOf(first.agent_id)} size={58} />
      </button>
    </div>
  );
}

/**
 * Conversas: parecido com o modo foco, só com as conversas. À esquerda, um contato por agente, do que você ativou por
 * último para o mais antigo (o que os agentes escrevem sozinhos não sobe); à direita, a conversa com ele, com o cursor
 * no campo — as outras conversas com o mesmo agente ficam no seletor de cima da conversa.
 */
export function ConversationsDialog({ agents, initial, onClose, onOpenAgent }: {
  agents: Agent[]; initial: { agentId: string | null; conversationId: string | null }; onClose: () => void;
  onOpenAgent: (id: string, tab?: 'conversa' | 'perfil' | 'atividade') => void;
}) {
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed']);
  const active = agents.filter((a) => a.status === 'active');
  const [sel, setSel] = useState<{ agentId: string | null; conversationId: string | null }>(initial);
  useEffect(() => setSel(initial), [initial.agentId, initial.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // sem escolha: a última conversa que você ativou
  const list = (recent.data ?? []).filter((c) => active.some((a) => a.id === c.agent_id));
  const current = sel.agentId ? sel : list[0] ? { agentId: list[0].agent_id, conversationId: list[0].id } : { agentId: active[0]?.id ?? null, conversationId: null };
  const agent = active.find((a) => a.id === current.agentId) ?? null;
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [q, setQ] = useState('');
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const contacts = contactsOf(list);
  const shown = contacts.filter((c) => { const a = active.find((x) => x.id === c.agentId); return !q.trim() || fold(`${a?.name} ${c.titles.join(' ')}`).includes(fold(q.trim())); });
  const others = active.filter((a) => !list.some((c) => c.agent_id === a.id));
  return (
    <div className="awin-back">
      <section ref={ref} className="awin convs" role="dialog" aria-modal="true" aria-label="Conversas">
        <aside className="convs__list" aria-label="Suas conversas">
          <div className="convs__head">
            <b>Conversas</b>
            <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
          </div>
          <label className="foco__search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversa" aria-label="Buscar conversa" /></label>
          <ul>
            {shown.map((c) => {
              const a = active.find((x) => x.id === c.agentId)!;
              const on = c.agentId === current.agentId;
              return (
                <li key={c.agentId}>
                  <button className={`convs__item ${on ? 'is-on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => setSel({ agentId: c.agentId, conversationId: c.latest.id })}
                    title={c.count > 1 ? `${c.count} conversas com ${a.name}: escolha no seletor acima da conversa` : undefined}>
                    <AgentAvatar agent={a} size={34} />
                    <span className="convs__txt"><b>{a.name}</b><small>{c.count > 1 ? `${c.count} conversas · ` : ''}{a.role}</small></span>
                    <time className="muted small">{when(c.latest.last_user_at)}</time>
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="muted small">Nenhuma conversa ainda.</li>}
          </ul>
          {others.length > 0 && (
            <label className="field convs__new">Conversar com
              <select value="" onChange={(e) => e.target.value && setSel({ agentId: e.target.value, conversationId: null })}>
                <option value="">escolha um agente…</option>
                {others.map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}</option>)}
              </select>
            </label>
          )}
        </aside>
        <div className="convs__chat">
          {agent ? (
            <>
              <header className="foco__chat-head">
                <AgentAvatar agent={agent} size={36} />
                <div className="foco__chat-who"><b>{agent.name}</b><small>{agent.role} · {agent.sector_name}</small></div>
                <button className="btn btn--sm btn--ghost" onClick={() => onOpenAgent(agent.id, 'perfil')}><Icon name="edit" size={13} /> Perfil</button>
              </header>
              <ChatPanel key={`${agent.id}-${current.conversationId ?? 'nova'}`} agent={agent} embedded conversationId={current.conversationId} />
            </>
          ) : <p className="muted center">Nenhum agente ativo.</p>}
        </div>
      </section>
    </div>
  );
}
