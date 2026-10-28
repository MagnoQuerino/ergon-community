import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useResource } from '../lib/live.ts';
import { useMinWidth } from '../lib/media.ts';
import { useSurface } from '../lib/surface.ts';
import { coordinatorOf } from '../lib/team.ts';
import type { AppState, BoardSummary, BoardView, View } from '../lib/types.ts';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { DecisionsPanel } from '../components/DecisionsPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { AgentAvatar } from '../components/AgentAvatar.tsx';

type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null) => void;
const RUN: Record<string, { label: string; cls: string }> = {
  running: { label: 'trabalhando', cls: 'dot--green dot--pulse' }, queued: { label: 'na fila', cls: 'dot--amber' }, waiting_user: { label: 'esperando você', cls: 'dot--amber dot--pulse' },
};

/**
 * Modo foco: o trabalho sem a cidade. À esquerda a equipe por setor (o Coordenador sempre no topo), no centro a
 * conversa com quem você escolheu, à direita o que espera você e o quadro da equipe. A cidade não para: fica
 * oculta e viva em segundo plano. Esc (fora de um campo de texto) volta.
 */
export function FocoView({ state, selectedId, onSelect, onOpenAgent, onAskCoordinator, onExit, onGo }: {
  state: AppState; selectedId: string | null; onSelect: (id: string) => void; onOpenAgent: OpenAgent;
  onAskCoordinator: (text: string) => void; onExit: () => void; onGo: (v: View) => void;
}) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'decisoes' | 'quadro'>(() => (state.decisionsPending ? 'decisoes' : 'quadro'));
  const [openTask, setOpenTask] = useState<string | null>(null);
  const active = state.agents.filter((a) => a.status === 'active');
  const coord = coordinatorOf(state.agents);
  const agent = active.find((a) => a.id === selectedId) ?? coord ?? active[0] ?? null;
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const term = fold(q.trim());
  const shown = active.filter((a) => !term || fold(`${a.name} ${a.role} ${a.sector_name}`).includes(term));
  const groups = state.sectors.map((s) => ({ s, list: shown.filter((a) => a.profile === s.key && a.id !== coord?.id) })).filter((g) => g.list.length);
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
  const nameOf = (id: string | null) => state.agents.find((a) => a.id === id)?.name ?? 'triagem';
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

  const chip = (a: (typeof active)[number], fixed = false) => (
    <button key={a.id} className={`foco-agent ${agent?.id === a.id ? 'is-on' : ''}`} onClick={() => { onSelect(a.id); if (size === 'narrow') setPane('conversa'); }} aria-current={agent?.id === a.id ? 'true' : undefined}>
      <AgentAvatar agent={a} size={28} />
      <span className="foco-agent__txt"><b>{a.name}{fixed && <Icon name="lock" size={11} />}</b><small>{a.role}</small></span>
      {a.run_status && <span className={`dot ${RUN[a.run_status]?.cls ?? ''}`} title={RUN[a.run_status]?.label} />}
    </button>
  );

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
        {coord && (!term || shown.some((a) => a.id === coord.id)) && (
          <div className="foco__group"><span className="foco__group-name">Coordenador</span>{chip(coord, true)}</div>
        )}
        {groups.map(({ s, list }) => (
          <div key={s.key} className="foco__group"><span className="foco__group-name">{s.name}</span>{list.map((a) => chip(a))}</div>
        ))}
        {!shown.length && <p className="muted small">Ninguém com esse nome.</p>}
        <p className="hint foco__note">A cidade continua viva em segundo plano.</p>
      </aside>}

      {show.chat && <section className="foco__chat" aria-label="Conversa">
        {agent ? (
          <>
            <header className="foco__chat-head">
              <AgentAvatar agent={agent} size={36} />
              <div className="foco__chat-who"><b>{agent.name}</b><small>{agent.role} · {agent.sector_name}{agent.run_status ? ` · ${RUN[agent.run_status]?.label}` : ''}</small></div>
              <button className="btn btn--sm btn--ghost" onClick={() => onOpenAgent(agent.id, 'perfil')}><Icon name="edit" size={13} /> Perfil</button>
            </header>
            <ChatPanel key={agent.id} agent={agent} embedded />
          </>
        ) : <p className="muted center">Nenhum agente ativo.</p>}
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
                    <small className="muted">{nameOf(t.agent_id)}{t.run_status ? ` · ${RUN[t.run_status]?.label ?? t.run_status}` : ''}</small>
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
      {openTask && board.data && <TaskDetail taskId={openTask} columns={board.data.columns} agents={state.agents} mode="team" onClose={() => setOpenTask(null)} onAskCoordinator={onAskCoordinator} />}
    </div>
  );
}
