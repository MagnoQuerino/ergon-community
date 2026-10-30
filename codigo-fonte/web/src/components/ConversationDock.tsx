import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { SECTION_LABEL, contactsOf, unreadTotal, type Contact, type Section } from '../lib/conversations.ts';
import { useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import type { Agent, RecentConversation } from '../lib/types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';

/** Quando: "agora", "há 5 min", "ontem 14:20", "12/10". */
export const when = (iso: string) => {
  const d = new Date(iso); const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const today = new Date(); const y = new Date(Date.now() - 86_400_000);
  const hm = d.toLocaleTimeString('pt-BR', { timeStyle: 'short' });
  if (d.toDateString() === today.toDateString()) return hm;
  if (d.toDateString() === y.toDateString()) return `ontem ${hm}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
};

/** Ponto de não lida (com o número) e a marca de prioridade do colega. */
export function Marks({ unread, priority, reason }: { unread: number; priority: 'urgente' | 'alta' | null; reason?: string | null }) {
  return (
    <>
      {priority && <span className={`prio prio--${priority}`} title={reason ? `${priority === 'urgente' ? 'Urgente' : 'Precisa de você'}: ${reason}` : priority === 'urgente' ? 'Urgente' : 'Precisa de você'}>
        <Icon name="flag" size={11} />{priority === 'urgente' ? 'urgente' : 'você'}
      </span>}
      {unread > 0 && <span className="unread" aria-label={`${unread} não lida(s)`}>{unread > 9 ? '9+' : unread}</span>}
    </>
  );
}

/**
 * Atalho fixo para retomar conversas, no canto inferior direito: o retrato de quem falou por último e, atrás dele, até
 * 3 conversas. Passar o mouse abre o leque; clicar abre a conversa já com o cursor no campo. Chegou algo que você não
 * leu: o retrato ganha o anel pulsando e o número (na cor da prioridade, quando o colega marcou).
 */
export function ConversationDock({ agents, hidden }: { agents: Agent[]; hidden?: boolean }) {
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'agents.changed', 'conversations.changed', 'proposals.changed']);
  const list = useMemo(() => (recent.data ?? []).filter((c) => agents.some((a) => a.id === c.agent_id && a.status === 'active')), [recent.data, agents]);
  const people = useMemo(() => contactsOf(list).slice(0, 4), [list]);
  const total = unreadTotal(list);
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
  // quem tem algo não lido vem para a frente
  const ordered = [...people].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0));
  const [first, ...back] = ordered;
  const ring = (c: Contact) => (c.unread > 0 ? `cdock__bubble--new ${c.priority ? `cdock__bubble--${c.priority}` : ''}` : '');
  return (
    <div className="cdock" role="navigation" aria-label="Retomar conversas">
      {back.slice().reverse().map((c, i) => {
        const a = agentOf(c.agentId);
        const depth = back.length - i; // o mais antigo fica mais atrás
        return (
          <button key={c.agentId} type="button" className={`cdock__bubble cdock__bubble--back cdock__bubble--d${depth} ${ring(c)}`} style={{ ['--i' as string]: depth }}
            onClick={() => openConversation(c.agentId, c.latest.id)} aria-label={`Conversa com ${a.name}${c.unread ? `: ${c.unread} não lida(s)` : ''}`} title={`${a.name} · ${when(c.lastAt)}`}>
            <AgentAvatar agent={a} size={44} />
            {c.unread > 0 && <span className="cdock__count">{c.unread > 9 ? '9+' : c.unread}</span>}
            <span className="cdock__name">{a.name}</span>
          </button>
        );
      })}
      <button type="button" className={`cdock__bubble cdock__bubble--main ${ring(first)}`} onClick={() => openConversation(first.agentId, first.latest.id)}
        aria-label={`${first.unread ? `${agentOf(first.agentId).name} mandou mensagem` : `Retomar a conversa com ${agentOf(first.agentId).name}`}${total ? ` (${total} não lida(s) ao todo)` : ''}`}
        title={`${first.unread ? 'Mensagem nova de' : 'Retomar a conversa com'} ${agentOf(first.agentId).name} (${when(first.lastAt)})`}>
        <AgentAvatar agent={agentOf(first.agentId)} size={58} />
        {total > 0 && <span className="cdock__count cdock__count--main">{total > 9 ? '9+' : total}</span>}
      </button>
    </div>
  );
}

/**
 * Conversas: como num aplicativo de mensagens. À esquerda, um contato por colega — Fixadas, Precisa de você e
 * Recentes —, com o ponto de não lida, a marca de prioridade e a última fala; os assuntos com o mesmo colega abrem
 * embaixo dele. À direita, a conversa, com o cursor no campo.
 */
export function ConversationsDialog({ agents, initial, onClose, onOpenAgent }: {
  agents: Agent[]; initial: { agentId: string | null; conversationId: string | null }; onClose: () => void;
  onOpenAgent: (id: string, tab?: 'conversa' | 'perfil' | 'atividade') => void;
}) {
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'conversations.changed', 'proposals.changed']);
  const active = agents.filter((a) => a.status === 'active');
  const [sel, setSel] = useState<{ agentId: string | null; conversationId: string | null }>(initial);
  useEffect(() => setSel(initial), [initial.agentId, initial.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (recent.data ?? []).filter((c) => active.some((a) => a.id === c.agent_id));
  const contacts = contactsOf(list);
  // sem escolha: quem tem algo para você, ou a última conversa
  const first = contacts.find((c) => c.unread || c.priority) ?? contacts[0];
  const current = sel.agentId ? sel : first ? { agentId: first.agentId, conversationId: first.latest.id } : { agentId: active[0]?.id ?? null, conversationId: null };
  const agent = active.find((a) => a.id === current.agentId) ?? null;
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const shown = contacts.filter((c) => { const a = active.find((x) => x.id === c.agentId); return !q.trim() || fold(`${a?.name} ${c.titles.join(' ')}`).includes(fold(q.trim())); });
  const others = active.filter((a) => !list.some((c) => c.agent_id === a.id));
  const pin = async (c: RecentConversation) => {
    setErr(null);
    try { await api.patch(`/api/conversations/${c.id}`, { pinned: !c.pinned_at }); recent.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const newTopic = async (agentId: string) => {
    setErr(null);
    try { const c = await api.post<{ id: string }>('/api/conversations', { agentId }); setSel({ agentId, conversationId: c.id }); recent.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const sections = (['fixadas', 'precisa', 'recentes'] as Section[]).map((s) => ({ s, items: shown.filter((c) => c.section === s) })).filter((x) => x.items.length);
  return (
    <div className="awin-back">
      <section ref={ref} className="awin convs" role="dialog" aria-modal="true" aria-label="Conversas">
        <aside className="convs__list" aria-label="Suas conversas">
          <div className="convs__head">
            <b>Conversas</b>
            <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
          </div>
          <label className="foco__search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversa" aria-label="Buscar conversa" /></label>
          {err && <p className="error small">{err}</p>}
          {sections.map(({ s, items }) => (
            <div key={s} className="convs__section">
              {sections.length > 1 || s !== 'recentes' ? <span className="convs__section-name">{SECTION_LABEL[s]}</span> : null}
              <ul>
                {items.map((c) => {
                  const a = active.find((x) => x.id === c.agentId)!;
                  const on = c.agentId === current.agentId;
                  const preview = c.latest.last_text ? `${c.latest.last_role === 'user' ? 'Você: ' : ''}${c.latest.last_text}` : a.role;
                  return (
                    <li key={c.agentId} className={`${on ? 'is-open' : ''}`}>
                      <button className={`convs__item ${on ? 'is-on' : ''} ${c.unread ? 'is-unread' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => setSel({ agentId: c.agentId, conversationId: c.latest.id })}>
                        <span className={`convs__avatar ${c.unread ? 'convs__avatar--new' : ''}`}><AgentAvatar agent={a} size={34} /></span>
                        <span className="convs__txt">
                          <span className="convs__line"><b>{a.name}</b><time className="muted small">{when(c.lastAt)}</time></span>
                          <span className="convs__line"><small title={c.priorityReason ?? undefined}>{c.priority && c.priorityReason ? c.priorityReason : preview}</small><Marks unread={c.unread} priority={c.priority ?? (c.waiting ? 'alta' : null)} reason={c.priorityReason ?? (c.waiting ? `${c.waiting} pedido(s) esperando você` : null)} /></span>
                        </span>
                      </button>
                      {on && (
                        <ul className="convs__topics" aria-label={`Assuntos com ${a.name}`}>
                          {c.convs.map((t) => (
                            <li key={t.id} className={`convs__topic ${t.id === (current.conversationId ?? c.latest.id) ? 'is-on' : ''}`}>
                              <button type="button" className="convs__topic-main" onClick={() => setSel({ agentId: c.agentId, conversationId: t.id })} title={t.title}>
                                {t.pinned_at && <Icon name="pin" size={11} />}<span>{t.title}</span>
                                <Marks unread={t.unread ?? 0} priority={t.priority ?? null} reason={t.priority_reason} />
                              </button>
                              <button type="button" className={`icon-btn convs__pin ${t.pinned_at ? 'is-on' : ''}`} onClick={() => void pin(t)} aria-label={t.pinned_at ? 'Soltar do topo' : 'Fixar no topo'} title={t.pinned_at ? 'Soltar do topo' : 'Fixar no topo'}><Icon name="pin" size={13} /></button>
                            </li>
                          ))}
                          <li><button type="button" className="linkish convs__new-topic" onClick={() => void newTopic(c.agentId)}><Icon name="plus" size={12} /> Novo assunto</button></li>
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {!shown.length && <p className="muted small">Nenhuma conversa ainda.</p>}
          {others.length > 0 && (
            <label className="field convs__new">Conversar com
              <select value="" onChange={(e) => e.target.value && setSel({ agentId: e.target.value, conversationId: null })}>
                <option value="">escolha um colega…</option>
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
              <ChatPanel key={`${agent.id}-${current.conversationId ?? 'nova'}`} agent={agent} embedded hidePicker={list.some((c) => c.agent_id === agent.id)} conversationId={current.conversationId} />
            </>
          ) : <p className="muted center">Nenhum agente ativo.</p>}
        </div>
      </section>
    </div>
  );
}
