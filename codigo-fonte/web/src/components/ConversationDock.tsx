import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtData, fmtHora, t, useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { SECTION_LABEL, contactsOf, unreadTotal, type Contact, type Section } from '../lib/conversations.ts';
import { cachedResource, useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { restOf } from '../lib/team.ts';
import { useAgentList, type TeamAgent } from '../lib/teamData.ts';
import type { AgentLite, RecentConversation } from '../lib/types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';
import { VirtualGrid } from './VirtualGrid.tsx';

type WithAgent = RecentConversation & { agent: AgentLite };
/** As conversas com o colega embutido pelo servidor (sem ele não há retrato nem nome para mostrar). */
const withAgent = (list: RecentConversation[] | null): WithAgent[] => (list ?? []).filter((c): c is WithAgent => !!c.agent);
/** O colega de cada contato, pelo id. */
const litesOf = (list: WithAgent[]) => new Map(list.map((c) => [c.agent_id, c.agent]));

/** Quando: "agora", "há 5 min", "ontem 14:20", "12/10" (no idioma da tela; quem mostra usa useT() e redesenha na troca). */
export const when = (iso: string) => {
  const d = new Date(iso); const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return t('conversas.quando.agora');
  if (min < 60) return t('conversas.quando.minutos', { n: min });
  const today = new Date(); const y = new Date(Date.now() - 86_400_000);
  const hm = fmtHora(d);
  if (d.toDateString() === today.toDateString()) return hm;
  if (d.toDateString() === y.toDateString()) return t('conversas.quando.ontem', { hora: hm });
  return fmtData(d, { day: '2-digit', month: '2-digit' });
};

/** Ponto de não lida (com o número) e a marca de prioridade do colega. */
export function Marks({ unread, priority, reason }: { unread: number; priority: 'urgente' | 'alta' | null; reason?: string | null }) {
  const t = useT();
  const marca = priority === 'urgente' ? t('conversas.marca.urgente') : t('conversas.marca.precisa');
  return (
    <>
      {priority && <span className={`prio prio--${priority}`} title={reason ? t('conversas.marca.comMotivo', { marca, motivo: reason }) : marca}>
        <Icon name="flag" size={11} />{priority === 'urgente' ? t('conversas.marca.urgenteCurto') : t('conversas.marca.voceCurto')}
      </span>}
      {unread > 0 && <span className="unread" aria-label={t('conversas.marca.naoLidas', { n: unread })}>{unread > 9 ? '9+' : unread}</span>}
    </>
  );
}

/**
 * Atalho fixo para retomar conversas, no canto inferior direito: o retrato de quem falou por último e, atrás dele, até
 * 3 conversas. Passar o mouse abre o leque; clicar abre a conversa já com o cursor no campo. Chegou algo que você não
 * leu: o retrato ganha o anel pulsando e o número (na cor da prioridade, quando o colega marcou). Os rostos vêm
 * embutidos nas conversas (o servidor já manda só as de colegas ativos); sem nenhuma, o atalho abre o Coordenador.
 */
export function ConversationDock({ coordinator, hidden }: { coordinator: AgentLite | null; hidden?: boolean }) {
  const t = useT();
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'agents.changed', 'conversations.changed', 'proposals.changed']);
  const list = useMemo(() => withAgent(recent.data), [recent.data]);
  const lites = useMemo(() => litesOf(list), [list]);
  const people = useMemo(() => contactsOf(list).slice(0, 4), [list]);
  const total = unreadTotal(list);
  if (hidden) return null;
  // ainda sem conversa: o atalho já está lá, e abre as Conversas com o Coordenador, pronto para escrever
  if (!people.length) {
    const coord = coordinator;
    if (!coord) return null;
    return (
      <div className="cdock" role="navigation" aria-label={t('conversas.titulo')}>
        <button type="button" className="cdock__bubble cdock__bubble--main cdock__bubble--vazio" onClick={() => openConversation(coord.id, null)}
          aria-label={t('conversas.doca.comecarAria', { nome: coord.name })} title={t('conversas.doca.comecarDica', { nome: coord.name })}>
          <Icon name="chat" size={26} />
        </button>
      </div>
    );
  }
  const agentOf = (id: string) => lites.get(id) as AgentLite; // todo contato saiu de uma conversa com o colega embutido
  // quem tem algo não lido vem para a frente
  const ordered = [...people].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0));
  const [first, ...back] = ordered;
  const firstName = agentOf(first.agentId).name;
  const mainLabel = first.unread ? t('conversas.doca.mandouMensagem', { nome: firstName }) : t('conversas.doca.retomarCom', { nome: firstName });
  const ring = (c: Contact) => (c.unread > 0 ? `cdock__bubble--new ${c.priority ? `cdock__bubble--${c.priority}` : ''}` : '');
  return (
    <div className="cdock" role="navigation" aria-label={t('conversas.doca.retomar')}>
      {back.slice().reverse().map((c, i) => {
        const a = agentOf(c.agentId);
        const depth = back.length - i; // o mais antigo fica mais atrás
        return (
          <button key={c.agentId} type="button" className={`cdock__bubble cdock__bubble--back cdock__bubble--d${depth} ${ring(c)}`} style={{ ['--i' as string]: depth }}
            onClick={() => openConversation(c.agentId, c.latest.id)} aria-label={c.unread ? t('conversas.doca.conversaComNaoLidas', { nome: a.name, n: c.unread }) : t('conversas.doca.conversaCom', { nome: a.name })} title={`${a.name} · ${when(c.lastAt)}`}>
            <AgentAvatar agent={a} size={44} />
            {c.unread > 0 && <span className="cdock__count">{c.unread > 9 ? '9+' : c.unread}</span>}
            <span className="cdock__name">{a.name}</span>
          </button>
        );
      })}
      <button type="button" className={`cdock__bubble cdock__bubble--main ${ring(first)}`} onClick={() => openConversation(first.agentId, first.latest.id)}
        aria-label={total ? t('conversas.doca.totalNaoLidas', { frase: mainLabel, n: total }) : mainLabel}
        title={first.unread ? t('conversas.doca.mensagemNovaDe', { nome: firstName, quando: when(first.lastAt) }) : t('conversas.doca.retomarComQuando', { nome: firstName, quando: when(first.lastAt) })}>
        <AgentAvatar agent={agentOf(first.agentId)} size={58} />
        {total > 0 && <span className="cdock__count cdock__count--main">{total > 9 ? '9+' : total}</span>}
      </button>
    </div>
  );
}

/** Resultado da busca da lista de conversas (contatos, assuntos, mensagens, arquivos e links). */
interface SearchResult {
  contatos: AgentLite[];
  assuntos: Array<{ id: string; agentId: string; agent: string; title: string; archived: boolean }>;
  mensagens: Array<{ id: string; conversationId: string; agentId: string; agent: string; title: string; role: string; created_at: string; text: string; hit: [number, number] }>;
  arquivos: Array<{ id: string; filename: string; mime: string; size: number; created_at: string; conversation_id: string | null; message_id: string | null; agentId: string | null; agent?: AgentLite | null }>;
  links: Array<{ url: string; conversationId: string; agentId: string; agent: string; messageId: string; created_at: string }>;
}
type Filter = 'tudo' | 'contatos' | 'assuntos' | 'mensagens' | 'arquivos' | 'links';
/** os filtros da busca: a chave do nome de cada um (traduzido na hora de mostrar) */
const FILTERS: Array<[Filter, `conversas.busca.${Filter}`]> = [['tudo', 'conversas.busca.tudo'], ['contatos', 'conversas.busca.contatos'], ['assuntos', 'conversas.busca.assuntos'], ['mensagens', 'conversas.busca.mensagens'], ['arquivos', 'conversas.busca.arquivos'], ['links', 'conversas.busca.links']];
/** assuntos visíveis por colega antes do "ver todos" */
const TOPICS_SHOWN = 5;
/** altura de uma linha da seção Equipe (retrato de 34 + respiro), para a lista virtualizada */
const ROW_H = 46;

/** Menu de um assunto: renomear, fixar, marcar como não lida, arquivar. */
function TopicMenu({ topic, onRename, onDone }: { topic: RecentConversation; onRename: () => void; onDone: (patch: Record<string, unknown>) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (patch: Record<string, unknown>) => { setOpen(false); onDone(patch); };
  return (
    <div className="convs__menu" ref={ref}>
      <button type="button" className="icon-btn convs__pin" onClick={() => setOpen((o) => !o)} aria-label={t('conversas.menu.opcoes')} aria-expanded={open}><Icon name="dots" size={13} /></button>
      {open && (
        <div className="convs__menu-list" role="menu">
          <button role="menuitem" onClick={() => { setOpen(false); onRename(); }}><Icon name="pen" size={13} /> {t('conversas.menu.renomear')}</button>
          <button role="menuitem" onClick={() => pick({ pinned: !topic.pinned_at })}><Icon name="pin" size={13} /> {topic.pinned_at ? t('conversas.menu.soltar') : t('conversas.menu.fixar')}</button>
          <button role="menuitem" onClick={() => pick({ unread: true })}><Icon name="bell" size={13} /> {t('conversas.menu.naoLida')}</button>
          <button role="menuitem" onClick={() => pick({ archived: true })}><Icon name="folder" size={13} /> {t('conversas.menu.arquivar')}</button>
        </div>
      )}
    </div>
  );
}

/** Trecho com o termo destacado. */
const Hit = ({ text, hit }: { text: string; hit: [number, number] }) => <>{text.slice(0, hit[0])}<mark>{text.slice(hit[0], hit[1])}</mark>{text.slice(hit[1])}</>;

/**
 * Quem ainda não tem conversa, no fim da lista: a equipe por partes (a próxima página chega ao rolar) e só as linhas
 * à vista viram botões — com 10 mil agentes, continuam umas poucas dezenas. Quem já está nas seções acima não repete.
 */
function TeamRest({ scope, shown, currentId, onOpen }: { scope: string; shown: ReadonlySet<string>; currentId: string | null; onOpen: (a: TeamAgent) => void }) {
  const t = useT();
  const list = useAgentList({ status: 'active' }, scope);
  const items = useMemo(() => restOf(list.items, shown), [list.items, shown]);
  if (!list.ready || (!items.length && !list.next)) return null;
  return (
    <div className="convs__section">
      <span className="convs__section-name">{t('conversas.secao.equipe')}</span>
      {/* flex: none — dentro da lista (flex) a grade guarda a altura de todas as linhas, e a lista rola */}
      <div style={{ flex: 'none' }}>
        <VirtualGrid items={items} hasMore={!!list.next} onNeedMore={list.more} rowHeight={ROW_H} gap={2} minColWidth={10_000} keyOf={(a) => a.id} label={t('conversas.secao.equipe')}
          render={(a) => (
            <button className={`convs__item ${a.id === currentId ? 'is-on' : ''}`} onClick={() => onOpen(a)}>
              <AgentAvatar agent={a} size={34} />
              <span className="convs__txt"><b>{a.name}</b><small>{a.role}</small></span>
            </button>
          )} />
      </div>
    </div>
  );
}

/**
 * Conversas, como num aplicativo de mensagens: todos os colegas numa lista só — Fixadas, Precisa de você, Recentes e,
 * no fim, quem ainda não tem conversa —, com o ponto de não lida, a marca de prioridade e a última fala. Os assuntos
 * do colega aberto aparecem embaixo dele (os 5 primeiros e "ver todos"), com renomear, fixar, não lida e arquivar.
 * A busca do topo acha tudo: contatos, assuntos, mensagens, arquivos e links — e leva direto à mensagem.
 */
export function ConversationsDialog({ coordinator, scope, initial, onClose, onOpenAgent }: {
  coordinator: TeamAgent | null; scope: string; initial: { agentId: string | null; conversationId: string | null }; onClose: () => void;
  onOpenAgent: (id: string, tab?: 'conversa' | 'perfil' | 'atividade', lite?: AgentLite | null) => void;
}) {
  const t = useT();
  // agents.changed: nome e rosto novos de um colega aparecem na lista sem fechar e abrir de novo
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'conversations.changed', 'proposals.changed', 'agents.changed']);
  const list = useMemo(() => withAgent(recent.data), [recent.data]);
  const lites = useMemo(() => litesOf(list), [list]);
  // a linha leve de quem foi escolhido sem conversa (seção Equipe, busca): o cabeçalho aparece na hora
  const [sel, setSel] = useState<{ agentId: string | null; conversationId: string | null; messageId?: string | null; lite?: AgentLite | null }>(initial);
  useEffect(() => setSel(initial), [initial.agentId, initial.conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const contacts = useMemo(() => contactsOf(list), [list]);
  // sem escolha: quem tem algo para você, ou a última conversa; sem nenhuma, o Coordenador (como o atalho do canto)
  const first = contacts.find((c) => c.unread || c.priority) ?? contacts[0];
  const current = sel.agentId ? sel : first ? { agentId: first.agentId, conversationId: first.latest.id } : { agentId: coordinator?.id ?? null, conversationId: null };
  const cid = current.agentId;
  // colega sem conversa recente: a linha leve dele confere se continua ativo (desativado cai em "Nenhum agente ativo")
  const isCoord = !!cid && cid === coordinator?.id;
  const needRow = !!cid && !lites.has(cid) && !isCoord;
  const row = useResource<TeamAgent>(needRow ? `/api/team/agents/${cid}` : null, ['agents.changed']);
  const seen = row.data?.id === cid ? row.data : null;
  const early = needRow && !seen && !row.error ? (sel.agentId === cid ? sel.lite ?? null : null) ?? cachedResource<TeamAgent>(`/api/team/agents/${cid}`) ?? null : null;
  const agent: AgentLite | null = !cid ? null : lites.get(cid) ?? (isCoord ? coordinator : seen ? (seen.status === 'active' ? seen : null) : early);
  const waiting = needRow && !seen && !row.error && !early; // chegando (milissegundos): nem "nenhum agente", nem conversa de outro
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('tudo');
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const searching = q.trim().length >= 2;
  const found = useResource<SearchResult>(searching ? `/api/search/conversations?q=${encodeURIComponent(q.trim())}&kind=${filter}` : null, ['messages.changed', 'conversations.changed']);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const patch = async (id: string, body: Record<string, unknown>) => {
    setErr(null);
    try { await api.patch(`/api/conversations/${id}`, body); recent.reload(); if (body.archived && id === current.conversationId) setSel({ agentId: current.agentId, conversationId: null }); } catch (e) { setErr(errMsg(e)); }
  };
  const newTopic = async (agentId: string) => {
    setErr(null);
    try { const c = await api.post<{ id: string }>('/api/conversations', { agentId }); setSel({ agentId, conversationId: c.id }); recent.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const open = (agentId: string, conversationId: string | null, messageId?: string | null, lite?: AgentLite | null) => { setSel({ agentId, conversationId, messageId: messageId ?? null, lite: lite ?? null }); setQ(''); };
  const sections = (['fixadas', 'precisa', 'recentes'] as Section[]).map((s) => ({ s, items: contacts.filter((c) => c.section === s) })).filter((x) => x.items.length);
  const inSections = useMemo(() => new Set(lites.keys()), [lites]);
  return (
    <div className="awin-back">
      <section ref={ref} className="awin convs" role="dialog" aria-modal="true" aria-label={t('conversas.titulo')}>
        <aside className="convs__list" aria-label={t('conversas.lista.suas')}>
          <div className="convs__head">
            <b>{t('conversas.titulo')}</b>
            <button className="icon-btn" onClick={onClose} aria-label={t('conversas.lista.fechar')} title={t('conversas.lista.fechar')}><Icon name="x" /></button>
          </div>
          <label className="foco__search"><Icon name="search" size={14} /><input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('conversas.busca.campo')} aria-label={t('conversas.busca.aria')}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ(''); } }} /></label>
          {searching && (
            <div className="convs__filters" role="group" aria-label={t('conversas.busca.filtrar')}>
              {FILTERS.map(([k, label]) => <button key={k} type="button" className={`chip ${filter === k ? 'chip--on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{t(label)}</button>)}
            </div>
          )}
          {err && <p className="error small">{err}</p>}
          {searching ? (
            <div className="convs__results">
              {!found.data && <p className="muted small">{t('conversas.busca.procurando')}</p>}
              {!!found.data?.contatos.length && <div className="convs__section"><span className="convs__section-name">{t('conversas.busca.contatos')}</span>
                {found.data.contatos.map((a) => { const c = contacts.find((x) => x.agentId === a.id); return (
                  <button key={a.id} type="button" className="convs__item" onClick={() => open(a.id, c?.latest.id ?? null, null, a)}><AgentAvatar agent={a} size={30} /><span className="convs__txt"><b>{a.name}</b><small>{a.role}</small></span></button>); })}</div>}
              {!!found.data?.assuntos.length && <div className="convs__section"><span className="convs__section-name">{t('conversas.busca.assuntos')}</span>
                {found.data.assuntos.map((x) => <button key={x.id} type="button" className="convs__result" onClick={() => open(x.agentId, x.id)}><b>{x.title}</b><small>{x.agent}{x.archived ? ` · ${t('conversas.busca.arquivado')}` : ''}</small></button>)}</div>}
              {!!found.data?.mensagens.length && <div className="convs__section"><span className="convs__section-name">{t('conversas.busca.mensagens')}</span>
                {found.data.mensagens.map((m) => <button key={m.id} type="button" className="convs__result" onClick={() => open(m.agentId, m.conversationId, m.id)}><small>{m.role === 'user' ? t('conversas.busca.voce') : m.agent} · {m.title} · {when(m.created_at)}</small><span><Hit text={m.text} hit={m.hit} /></span></button>)}</div>}
              {!!found.data?.arquivos.length && <div className="convs__section"><span className="convs__section-name">{t('conversas.busca.arquivos')}</span>
                {found.data.arquivos.map((f) => <button key={f.id} type="button" className="convs__result" onClick={() => (f.agentId && f.conversation_id ? open(f.agentId, f.conversation_id, f.message_id, f.agent ?? null) : window.open(`/api/artifacts/${f.id}/download`, '_blank'))}><b><Icon name="file" size={12} /> {f.filename}</b><small>{f.agentId ? t('conversas.busca.naConversaCom', { nome: f.agent?.name ?? t('conversas.busca.colega') }) : t('conversas.busca.emDocumentos')} · {when(f.created_at)}</small></button>)}</div>}
              {!!found.data?.links.length && <div className="convs__section"><span className="convs__section-name">{t('conversas.busca.links')}</span>
                {found.data.links.map((l) => <button key={`${l.messageId}-${l.url}`} type="button" className="convs__result" onClick={() => open(l.agentId, l.conversationId, l.messageId)}><b>{l.url}</b><small>{l.agent} · {when(l.created_at)}</small></button>)}</div>}
              {found.data && !found.data.contatos.length && !found.data.assuntos.length && !found.data.mensagens.length && !found.data.arquivos.length && !found.data.links.length && <p className="muted small">{t('conversas.busca.nada')}</p>}
            </div>
          ) : (
            <>
              {sections.map(({ s, items }) => (
                <div key={s} className="convs__section">
                  <span className="convs__section-name">{t(SECTION_LABEL[s])}</span>
                  <ul>
                    {items.map((c) => {
                      const a = lites.get(c.agentId) as AgentLite;
                      const on = c.agentId === current.agentId;
                      const preview = c.latest.last_text ? (c.latest.last_role === 'user' ? t('conversas.lista.voceDisse', { texto: c.latest.last_text }) : c.latest.last_text) : a.role;
                      const all = expanded.has(c.agentId);
                      const topics = all ? c.convs : c.convs.slice(0, TOPICS_SHOWN);
                      return (
                        <li key={c.agentId} className={on ? 'is-open' : ''}>
                          <button className={`convs__item ${on ? 'is-on' : ''} ${c.unread ? 'is-unread' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => open(c.agentId, c.latest.id)}>
                            <span className={`convs__avatar ${c.unread ? 'convs__avatar--new' : ''}`}><AgentAvatar agent={a} size={34} /></span>
                            <span className="convs__txt">
                              <span className="convs__line"><b>{a.name}</b><time className="muted small">{when(c.lastAt)}</time></span>
                              <span className="convs__line"><small title={c.priorityReason ?? undefined}>{c.priority && c.priorityReason ? c.priorityReason : preview}</small><Marks unread={c.unread} priority={c.priority ?? (c.waiting ? 'alta' : null)} reason={c.priorityReason ?? (c.waiting ? t('conversas.lista.pedidosEsperando', { n: c.waiting }) : null)} /></span>
                            </span>
                          </button>
                          {on && (
                            <ul className="convs__topics" aria-label={t('conversas.lista.assuntosCom', { nome: a.name })}>
                              {topics.map((tp) => (
                                <li key={tp.id} className={`convs__topic ${tp.id === (current.conversationId ?? c.latest.id) ? 'is-on' : ''}`}>
                                  {renaming?.id === tp.id ? (
                                    <form className="convs__rename" onSubmit={(e) => { e.preventDefault(); const n = renaming.title.trim(); setRenaming(null); if (n && n !== tp.title) void patch(tp.id, { title: n }); }}>
                                      <input autoFocus value={renaming.title} onChange={(e) => setRenaming({ id: tp.id, title: e.target.value })} onBlur={() => setRenaming(null)} aria-label={t('conversas.lista.novoNome')}
                                        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); } }} />
                                    </form>
                                  ) : (
                                    <button type="button" className="convs__topic-main" onClick={() => open(c.agentId, tp.id)} onDoubleClick={() => setRenaming({ id: tp.id, title: tp.title })} title={t('conversas.lista.assuntoDica', { titulo: tp.title })}>
                                      {tp.pinned_at && <Icon name="pin" size={11} />}<span>{tp.title}</span>
                                      <Marks unread={tp.unread ?? 0} priority={tp.priority ?? null} reason={tp.priority_reason} />
                                    </button>
                                  )}
                                  <TopicMenu topic={tp} onRename={() => setRenaming({ id: tp.id, title: tp.title })} onDone={(p) => void patch(tp.id, p)} />
                                </li>
                              ))}
                              {c.convs.length > TOPICS_SHOWN && (
                                <li><button type="button" className="linkish convs__new-topic" onClick={() => setExpanded((x) => { const n = new Set(x); if (all) n.delete(c.agentId); else n.add(c.agentId); return n; })}>
                                  {all ? t('conversas.lista.verMenos') : t('conversas.lista.verTodos', { n: c.convs.length })}</button></li>
                              )}
                              <li><button type="button" className="linkish convs__new-topic" onClick={() => void newTopic(c.agentId)}><Icon name="plus" size={12} /> {t('conversas.lista.novoAssunto')}</button></li>
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              <TeamRest scope={scope} shown={inSections} currentId={current.agentId} onOpen={(a) => open(a.id, null, null, a)} />
            </>
          )}
        </aside>
        <div className="convs__chat">
          {agent ? (
            <>
              <header className="foco__chat-head">
                <AgentAvatar agent={agent} size={36} />
                <div className="foco__chat-who"><b>{agent.name}</b><small>{agent.role} · {agent.sector_name}</small></div>
                <button className="btn btn--sm btn--ghost" onClick={() => onOpenAgent(agent.id, 'perfil', agent)}><Icon name="edit" size={13} /> {t('conversas.lista.perfil')}</button>
              </header>
              <ChatPanel key={`${agent.id}-${current.conversationId ?? 'nova'}`} agent={agent} embedded hidePicker conversationId={current.conversationId}
                focusMessage={sel.messageId ?? null} onOpenConversation={(agentId, conversationId) => { setSel({ agentId, conversationId }); recent.reload(); }} />
            </>
          ) : waiting ? null : <p className="muted center">{t('conversas.lista.nenhumAgente')}</p>}
        </div>
      </section>
    </div>
  );
}
