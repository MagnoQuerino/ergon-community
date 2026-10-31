import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cachedResource, useLiveEvent, useResource } from '../lib/live.ts';
import { useMinWidth } from '../lib/media.ts';
import { useSurface } from '../lib/surface.ts';
import { teamUrl, useAgentList, useGroupPages, useRunStatus, type TeamAgent, type TeamSector } from '../lib/teamData.ts';
import type { Agent, AgentLite, AppState, BoardSummary, BoardView, RecentConversation, View } from '../lib/types.ts';
import { contactsOf } from '../lib/conversations.ts';
import { Marks } from '../components/ConversationDock.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { DecisionsPanel } from '../components/DecisionsPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { AgentAvatar } from '../components/AgentAvatar.tsx';
import { VirtualGrid } from '../components/VirtualGrid.tsx';

type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null, lite?: AgentLite | null) => void;
const RUN: Record<string, { label: string; cls: string }> = {
  running: { label: 'trabalhando', cls: 'dot--green dot--pulse' }, queued: { label: 'na fila', cls: 'dot--amber' }, waiting_user: { label: 'esperando você', cls: 'dot--amber dot--pulse' },
};
/** Um colega na coluna da equipe: a linha leve (das conversas, das amostras, da busca), com o andamento quando se sabe. */
type Who = AgentLite & { run_status?: TeamAgent['run_status']; coordinator?: boolean };
/** altura de um colega na lista por partes (retrato de 28, duas linhas de texto e o respiro) */
const CHIP_H = 43;

/** Do perfil já buscado (a cidade busca o do selecionado): o cabeçalho aparece na hora, sem esperar a linha leve. */
function fromProfile(id: string): Who | null {
  const a = cachedResource<Agent>(`/api/agents/${id}`);
  return a && a.status === 'active' ? { ...a, look_seed: a.look_seed ?? null, coordinator: !!a.coordinator } : null;
}

/**
 * Modo foco: o trabalho sem a cidade. À esquerda a equipe — o Coordenador sempre no topo, depois quem tem conversa com
 * você (ninguém com mensagem nova fica escondido) e os setores com uma amostra e a contagem ("Ver todos" carrega o
 * setor por partes); a busca procura no servidor. No centro a conversa com quem você escolheu, à direita o que espera
 * você e o quadro da equipe. A cidade não para: fica oculta e viva em segundo plano. Esc (fora de um campo) volta.
 */
export function FocoView({ state, selectedId, onSelect, onOpenAgent, onAskCoordinator, onExit, onGo }: {
  state: AppState; selectedId: string | null; onSelect: (id: string) => void; onOpenAgent: OpenAgent;
  onAskCoordinator: (text: string) => void; onExit: () => void; onGo: (v: View) => void;
}) {
  const scope = state.workspace.id;
  const coord = state.team.coordinator;
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setDq(q.trim()), 220); return () => window.clearTimeout(t); }, [q]);
  const [sector, setSector] = useState<{ key: string; name: string } | null>(null);
  useEffect(() => { setSector(null); setQ(''); }, [scope]);
  const [tab, setTab] = useState<'decisoes' | 'quadro'>(() => (state.decisionsPending ? 'decisoes' : 'quadro'));
  const [openTask, setOpenTask] = useState<string | null>(null);
  // ponto de não lida e marca de prioridade de cada colega (as mesmas da lista de Conversas), com o colega embutido
  const recent = useResource<RecentConversation[]>('/api/conversations/recent', ['messages.changed', 'conversations.changed', 'proposals.changed', 'agents.changed']);
  const contacts = useMemo(() => contactsOf(recent.data ?? []), [recent.data]);
  const marks = useMemo(() => new Map(contacts.map((c) => [c.agentId, c])), [contacts]);
  const talked = useMemo<Who[]>(() => contacts.flatMap((c) => (c.latest.agent && c.agentId !== coord?.id ? [c.latest.agent] : [])), [contacts, coord?.id]);
  // a equipe por partes: setores com amostra e contagem; a busca e o "Ver todos" vêm do servidor conforme a rolagem
  const sectors = useGroupPages<TeamSector>((c) => teamUrl.sectors('', c, 24), scope);
  const found = useAgentList(dq ? { q: dq } : null, scope);
  const members = useAgentList(sector ? { sector: sector.key } : null, scope);
  const samples = useMemo(() => (sectors.data?.items ?? []).flatMap((s) => s.sample), [sectors.data]);
  // andamento ao vivo de quem aparece fora das listas por partes (as listas se acertam sozinhas)
  const live = useRunStatus(useMemo(() => [...new Set([...talked, ...samples].map((a) => a.id))], [talked, samples]));
  const runOf = (a: Who) => (live.has(a.id) ? live.get(a.id) ?? null : a.run_status ?? null);

  // o escolhido (o mesmo da cidade): a linha leve dele confere se continua ativo; senão, o Coordenador
  const wantId = selectedId ?? coord?.id ?? state.team.others[0]?.id ?? null;
  const isCoord = !!coord && wantId === coord.id;
  const row = useResource<TeamAgent>(wantId && !isCoord ? `/api/team/agents/${wantId}` : null, ['agents.changed']);
  useLiveEvent('runs.changed', (d) => { if (wantId && !isCoord && d.agentId === wantId) row.reload(); });
  const known = (id: string): Who | null => talked.find((a) => a.id === id) ?? samples.find((a) => a.id === id) ?? found.items.find((a) => a.id === id)
    ?? members.items.find((a) => a.id === id) ?? fromProfile(id);
  const fresh = row.data?.id === wantId ? row.data : null;
  const picked: Who | null = !wantId ? null : isCoord ? coord : fresh ? (fresh.status === 'active' ? fresh : null) : row.error ? null : known(wantId);
  // chegando (milissegundos): nem a conversa de outro colega, nem "nenhum agente"
  const waiting = !!wantId && !isCoord && !fresh && !row.error && !picked;
  const agent: Who | null = picked ?? (waiting ? null : coord);

  const boards = useResource<BoardSummary[]>('/api/boards', ['tasks.changed']);
  const teamBoard = boards.data?.find((b) => b.audience === 'team');
  const board = useResource<BoardView>(teamBoard ? `/api/boards/${teamBoard.id}` : null, ['tasks.changed', 'runs.changed']);
  const columns = useMemo(() => (board.data?.columns ?? []).map((c) => ({ c, tasks: (board.data?.tasks ?? []).filter((t) => t.column_id === c.id && !t.completed) })), [board.data]);
  const done = (board.data?.tasks ?? []).filter((t) => t.completed).length;
  const pending = state.decisionsPending;
  // Esc sai do modo, pela pilha de superfícies: o que estiver por cima (card, janela do agente) fecha antes;
  // num campo de texto (a conversa), o Esc é do campo
  const root = useRef<HTMLDivElement>(null);
  useSurface(root, { onClose: onExit, ignoreFromInputs: true, autoFocus: false });
  // janela estreita: nada some — as áreas viram abas (antes: abaixo de 1.100 px sumiam Decisões e Quadro; abaixo de
  // 760 px, a equipe, e não dava para trocar de agente)
  const wide = useMinWidth(1100); const mid = useMinWidth(760);
  const size = wide ? 'wide' : mid ? 'mid' : 'narrow';
  const [pane, setPane] = useState<'equipe' | 'conversa' | 'lado'>('conversa');
  const show = {
    team: size !== 'narrow' || pane === 'equipe',
    chat: size === 'wide' || pane === 'conversa' || (size === 'mid' && pane === 'equipe'),
    side: size === 'wide' || pane === 'lado',
  };
  const pickSide = (t: 'decisoes' | 'quadro') => { setTab(t); setPane('lado'); };
  const tabBtn = (on: boolean, label: ReactNode, onClick: () => void, key: string) => (
    <button key={key} role="tab" aria-selected={on} className={on ? 'is-on' : ''} onClick={onClick}>{label}</button>
  );

  const chip = (a: Who, fixed = false) => {
    const m = marks.get(a.id); const run = runOf(a);
    return (
      <button key={a.id} className={`foco-agent ${agent?.id === a.id ? 'is-on' : ''}`} onClick={() => { onSelect(a.id); if (size === 'narrow') setPane('conversa'); }} aria-current={agent?.id === a.id ? 'true' : undefined}>
        <AgentAvatar agent={a} size={28} />
        <span className="foco-agent__txt"><b>{a.name}{fixed && <Icon name="lock" size={11} />}</b><small>{a.role}</small></span>
        {m && <Marks unread={a.id === agent?.id ? 0 : m.unread} priority={m.priority ?? (m.waiting ? 'alta' : null)} reason={m.priorityReason ?? (m.waiting ? `${m.waiting} pedido(s) esperando você` : null)} />}
        {run && <span className={`dot ${RUN[run]?.cls ?? ''}`} title={RUN[run]?.label} />}
      </button>
    );
  };
  const run = agent ? runOf(agent) : null;

  return (
    <div ref={root} className={`foco foco--${size}`}>
      {size !== 'wide' && (
        <div className="foco__switch">
          <div className="foco__tabs" role="tablist" aria-label="Áreas do Modo foco">
            {size === 'narrow' && tabBtn(pane === 'equipe', <><Icon name="users" size={14} /> Equipe</>, () => setPane('equipe'), 'eq')}
            {tabBtn(pane !== 'lado' && (size === 'mid' || pane === 'conversa'), <><Icon name="chat" size={14} /> {agent?.name ?? 'Conversa'}</>, () => setPane('conversa'), 'cv')}
            {tabBtn(pane === 'lado' && tab === 'decisoes', <><Icon name="bell" size={14} /> Aguardando{pending ? <span className="foco__count">{pending}</span> : null}</>, () => pickSide('decisoes'), 'dc')}
            {tabBtn(pane === 'lado' && tab === 'quadro', <><Icon name="layers" size={14} /> Quadro</>, () => pickSide('quadro'), 'qd')}
          </div>
          <button className="btn btn--sm btn--ghost" onClick={onExit} title="Sair do Modo foco (Esc)"><Icon name="x" size={14} /> Sair</button>
        </div>
      )}
      {show.team && <aside className="foco__team" aria-label="Equipe">
        <div className="foco__head">
          <b>Modo foco</b>
          {size === 'wide' && <button className="btn btn--sm btn--ghost" onClick={onExit} title="Voltar (Esc)"><Icon name="x" size={14} /> Sair</button>}
        </div>
        <label className="foco__search"><Icon name="search" size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar agente" aria-label="Buscar agente" /></label>
        {dq ? (
          <div className="foco__group">
            <span className="foco__group-name">Resultados{found.ready ? ` · ${found.total}` : ''}</span>
            <Part list={found} chip={chip} wait="Procurando…" empty="Ninguém com esse nome." />
          </div>
        ) : sector ? (
          <div className="foco__group">
            <button className="linkish" onClick={() => setSector(null)}><span className="flip"><Icon name="chevron" size={12} /></span> Todos os setores</button>
            <span className="foco__group-name">{sector.name}{members.ready ? ` · ${members.total}` : ''}</span>
            <Part list={members} chip={chip} wait="Carregando…" empty="Ninguém neste setor." />
          </div>
        ) : (
          <>
            {coord && <div className="foco__group"><span className="foco__group-name">Coordenador</span>{chip(coord, true)}</div>}
            {talked.length > 0 && <div className="foco__group"><span className="foco__group-name">Conversas</span>{talked.map((a) => chip(a))}</div>}
            {sectors.data?.items.map((s) => {
              const shown = s.sample.filter((a) => a.id !== coord?.id);
              if (!shown.length && s.count <= s.sample.length) return null;
              return (
                <div key={s.key} className="foco__group">
                  <span className="foco__group-name">{s.name}</span>
                  {shown.map((a) => chip(a))}
                  {s.count > s.sample.length && <button className="linkish" onClick={() => setSector({ key: s.key, name: s.name })}>Ver todos ({s.count.toLocaleString('pt-BR')})</button>}
                </div>
              );
            })}
            {(sectors.prev || sectors.next) && (
              <div className="row row--wrap">
                <button className="btn btn--sm btn--ghost" onClick={() => sectors.prev?.()} hidden={!sectors.prev}><span className="flip"><Icon name="chevron" size={12} /></span> Anteriores</button>
                <span className="muted small">{sectors.data?.total ?? 0} setores</span>
                <button className="btn btn--sm btn--ghost" onClick={() => sectors.next?.()} hidden={!sectors.next}>Próximos <Icon name="chevron" size={12} /></button>
              </div>
            )}
            {sectors.error && <p className="error small">{sectors.error} <button className="linkish" onClick={sectors.reload}>Tentar de novo</button></p>}
          </>
        )}
        <p className="hint foco__note">A cidade continua viva em segundo plano.</p>
      </aside>}

      {show.chat && <section className="foco__chat" aria-label="Conversa">
        {agent ? (
          <>
            <header className="foco__chat-head">
              <AgentAvatar agent={agent} size={36} />
              <div className="foco__chat-who"><b>{agent.name}</b><small>{agent.role} · {agent.sector_name}{run ? ` · ${RUN[run]?.label}` : ''}</small></div>
              <button className="btn btn--sm btn--ghost" onClick={() => onOpenAgent(agent.id, 'perfil', null, null, agent)}><Icon name="edit" size={13} /> Perfil</button>
            </header>
            <ChatPanel key={agent.id} agent={agent} embedded />
          </>
        ) : waiting ? null : <p className="muted center">Nenhum agente ativo.</p>}
      </section>}

      {show.side && <aside className="foco__side" aria-label="Decisões e quadro">
        {size === 'wide' && <div className="foco__tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'decisoes'} className={tab === 'decisoes' ? 'is-on' : ''} onClick={() => setTab('decisoes')}>Aguardando você{pending ? <span className="foco__count">{pending}</span> : null}</button>
          <button role="tab" aria-selected={tab === 'quadro'} className={tab === 'quadro' ? 'is-on' : ''} onClick={() => setTab('quadro')}>Quadro da equipe</button>
        </div>}
        {tab === 'decisoes' ? (
          <DecisionsPanel inline onOpenAgent={onOpenAgent} onGo={onGo} />
        ) : (
          <div className="foco__board">
            {columns.map(({ c, tasks }) => (
              <div key={c.id} className="foco__col">
                <span className="foco__group-name">{c.name} <span className="muted">{tasks.length}</span></span>
                {tasks.map((t) => (
                  <button key={t.id} className="foco__task" onClick={() => setOpenTask(t.id)}>
                    <span className="muted small">#{t.number}</span> <span className="foco__task-title">{t.title}</span>
                    <small className="muted">{(t.agent_id && t.agent_name) || 'triagem'}{t.run_status ? ` · ${RUN[t.run_status]?.label ?? t.run_status}` : ''}</small>
                  </button>
                ))}
                {!tasks.length && <span className="muted small">—</span>}
              </div>
            ))}
            {!board.data && <p className="muted small">Carregando o quadro…</p>}
            {done > 0 && <p className="hint">{done} concluída(s). <button className="linkish" onClick={() => onGo('equipe')}>Ver o quadro inteiro</button></p>}
          </div>
        )}
        {tab === 'quadro' && pending > 0 && <p className="hint">{pending} decisão(ões) esperando você. <button className="linkish" onClick={() => setTab('decisoes')}>Ver</button></p>}
      </aside>}
      {openTask && board.data && <TaskDetail taskId={openTask} columns={board.data.columns} mode="team" onClose={() => setOpenTask(null)} onAskCoordinator={onAskCoordinator} />}
    </div>
  );
}

/** Uma lista por partes na coluna da equipe: só as linhas à vista viram botões, e a próxima página chega ao rolar. */
function Part({ list, chip, wait, empty }: { list: ReturnType<typeof useAgentList>; chip: (a: Who, fixed?: boolean) => ReactNode; wait: string; empty: string }) {
  if (list.error) return <p className="error small">{list.error} <button className="linkish" onClick={list.reload}>Tentar de novo</button></p>;
  if (!list.ready) return <p className="muted small">{wait}</p>;
  // flex: none — dentro da coluna (flex) a grade guarda a altura de todas as linhas, e a coluna rola
  return (
    <div style={{ flex: 'none' }}>
      <VirtualGrid items={list.items} hasMore={!!list.next} onNeedMore={list.more} rowHeight={CHIP_H} gap={3} minColWidth={10_000} keyOf={(a) => a.id} label="Agentes"
        render={(a) => chip(a, a.coordinator)} empty={<p className="muted small">{empty}</p>} />
    </div>
  );
}
