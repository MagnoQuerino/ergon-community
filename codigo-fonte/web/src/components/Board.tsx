import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Column, TaskCard } from '../lib/types.ts';
import { Icon } from './Icon.tsx';
import { DISPLAY_BADGE, DISPLAY_LABEL, WORK_LABEL, displayOf, type WorkState } from '../lib/work.ts';

const RUN_LABEL: Record<string, string> = { running: 'trabalhando', queued: 'na fila', waiting_user: 'aguarda você' };
/** Coluna vazia no quadro da equipe: o que significa (nas suas listas, só "Nenhuma tarefa"). */
const TEAM_EMPTY: Record<string, string> = { 'A fazer': 'Nada esperando a vez.', 'Em andamento': 'Ninguém trabalhando agora.', 'Concluído': 'Nada concluído ainda.' };
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Hoje no relógio deste computador (AAAA-MM-DD). */
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Prazo para mostrar: "qui, 30/10", com a situação (atrasada, hoje, nos próximos 2 dias). */
export function dueInfo(due: string | null, done = false): { label: string; cls: string; title: string } | null {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const today = todayIso();
  const days = Math.round((dt.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86_400_000);
  const label = `${WD[dt.getDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}${y !== new Date().getFullYear() ? `/${String(y).slice(2)}` : ''}`;
  if (done) return { label, cls: 'due--done', title: `Prazo: ${label}` };
  if (days < 0) return { label, cls: 'due--late', title: `Atrasada: o prazo era ${label} (${-days} dia${days === -1 ? '' : 's'})` };
  if (days === 0) return { label: `hoje`, cls: 'due--today', title: `Prazo: hoje (${label})` };
  if (days <= 2) return { label, cls: 'due--soon', title: `Prazo: ${label} (em ${days} dia${days === 1 ? '' : 's'})` };
  return { label, cls: '', title: `Prazo: ${label}` };
}

export function DueChip({ due, done }: { due: string | null; done?: boolean }) {
  const i = dueInfo(due, done);
  if (!i) return null;
  return <span className={`due ${i.cls}`} title={i.title}><Icon name="clock" size={12} /> {i.label}</span>;
}

const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ontem' : `há ${d} dias`;
};

type SortKey = 'numero' | 'prazo' | 'responsavel' | 'atualizada';

/**
 * Quadro com os mesmos cards em dois formatos equivalentes: colunas (kanban) ou lista em tabela, agrupada pelas mesmas
 * colunas, com as mesmas ações — abrir, concluir e mudar de coluna (arrastando no kanban; escolhendo a situação na
 * lista). Só muda o que é seu e local. No quadro da equipe, a coluna da fila (queueColumn) se reordena arrastando:
 * os agentes pegam de cima para baixo.
 */
export function Board({ columns, tasks, view, editable, openId, onOpen, onMove, onToggle, team, queueColumn, onReorder }: {
  columns: Column[]; tasks: TaskCard[]; view: 'kanban' | 'lista'; editable: boolean; openId: string | null; team?: boolean;
  onOpen: (id: string) => void; onMove?: (taskId: string, columnId: string) => void; onToggle?: (t: TaskCard, done: boolean) => void;
  queueColumn?: string; onReorder?: (taskId: string, beforeId: string | null) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  // fila da equipe: só os cards que esperam a vez (sem execução, não concluídos) mudam de ordem
  const waiting = (t: TaskCard) => !!onReorder && t.column_id === queueColumn && !t.run_status && !t.completed;
  const queued = tasks.filter(waiting);
  const [dropAt, setDropAt] = useState<{ before: string | null } | null>(null);
  const endDrag = () => { setDragId(null); setDropAt(null); };
  const dropInQueue = () => {
    if (dragId && dropAt && onReorder && queued.some((q) => q.id === dragId) && dropAt.before !== dragId) {
      const i = queued.findIndex((q) => q.id === dragId);
      const same = dropAt.before === (queued[i + 1]?.id ?? null); // soltou onde já estava
      if (!same) onReorder(dragId, dropAt.before);
    }
    endDrag();
  };
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'numero', dir: 1 });
  // nome e cor do responsável (e de quem recebeu o card enviado à equipe) vêm no próprio card, desativados incluídos
  const agentOf = (id: string | null, name: string | null | undefined, color: string | null | undefined) => (id && name ? { name, color: color ?? undefined } : null);

  /** O andamento real do card (o mesmo no kanban e na lista). */
  const badges = (t: TaskCard) => {
    const teamAg = agentOf(t.team_agent_id, t.team_agent_name, t.team_agent_color);
    const help = team && (t.is_help || (t.parent_task_id && t.parent_audience !== 'user'));
    return (
      <>
        {team && t.parent_audience === 'user' && <span className="badge badge--ok" title="Você enviou das suas tarefas">enviada por você</span>}
        {team && !!t.priority && !t.completed && !t.run_status && (!t.work_state || t.work_state === 'solicitada') && <span className="badge badge--pri" title="Prioridade: no topo da fila"><Icon name="flag" size={11} /> prioridade</span>}
        {t.run_status && <span className="badge badge--warn">{RUN_LABEL[t.run_status] ?? t.run_status}</span>}
        {team && !t.run_status && t.work_state && !['solicitada', 'concluida'].includes(t.work_state) && (
          <span className={`badge ${DISPLAY_BADGE[displayOf(t.work_state)]}`} title={`Estado do trabalho: ${WORK_LABEL[t.work_state as WorkState] ?? t.work_state}`}>{DISPLAY_LABEL[displayOf(t.work_state)]}</span>
        )}
        {t.deliverables > 0 && <span className="badge badge--ok" title="Entregáveis no card (abra para baixar)"><Icon name="folder" size={11} /> {t.deliverables}</span>}
        {!team && t.inputs > 0 && <span className="badge" title="Arquivos anexados"><Icon name="folder" size={11} /> {t.inputs}</span>}
        {help && <span className="badge badge--sim" title="Um agente pediu ajuda a outro">ajuda</span>}
        {team && t.handoffs > 0 && <span className="badge" title="Repasses entre agentes">{t.handoffs} repasse{t.handoffs === 1 ? '' : 's'}</span>}
        {t.team_number && <span className="badge badge--ok" title="Enviada à equipe">equipe #{t.team_number}{teamAg ? ` · ${teamAg.name}` : ''}</span>}
        {t.link_state === 'missing' && <span className="badge badge--err" title="Não apareceu na última leitura do aplicativo (não foi excluída)">ausente</span>}
        {t.proposals > 0 && <span className="badge" title="Possível duplicata: vínculo para confirmar">vínculo?</span>}
      </>
    );
  };
  const chipOf = (ag: { name: string; color?: string }, title?: string) => <span className="who" title={title}><span className="avatar avatar--xs" style={{ background: ag.color }}>{ag.name[0]}</span>{ag.name}</span>;
  /** Com quem está: o agente (equipe), quem o aplicativo diz (espelho), o agente que recebeu (enviada à equipe) ou você. */
  const who = (t: TaskCard, inList = false) => {
    const ag = agentOf(t.agent_id, t.agent_name, t.agent_color);
    if (team) return ag ? chipOf(ag) : <span className="badge">triagem</span>;
    if (t.external_assignee) return <span className="who" title="Atribuída no aplicativo de origem">{t.external_assignee}</span>;
    const teamAg = agentOf(t.team_agent_id, t.team_agent_name, t.team_agent_color);
    if (inList && teamAg) return chipOf(teamAg, `Enviada à equipe: card #${t.team_number}`);
    return inList ? <span className="muted">você</span> : null;
  };

  const card = (t: TaskCard) => {
    const help = team && (t.is_help || (t.parent_task_id && t.parent_audience !== 'user'));
    const inQueue = waiting(t);
    const pos = inQueue ? queued.findIndex((q) => q.id === t.id) + 1 : 0;
    return (
      <article key={t.id} className={`task ${t.completed ? 'task--done' : ''} ${openId === t.id ? 'task--open' : ''} ${help ? 'task--help' : ''} ${dragId === t.id ? 'task--dragging' : ''} ${dropAt?.before === t.id && dragId !== t.id ? 'task--drop-before' : ''}`}
        draggable={editable || inQueue}
        onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
        onDragEnd={endDrag}
        onDragOver={inQueue ? (e) => {
          if (!dragId || !queued.some((q) => q.id === dragId)) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2 ? t.id : queued[pos]?.id ?? null; // metade de cima: antes deste; de baixo: antes do próximo
          if (dropAt?.before !== before) setDropAt({ before });
        } : undefined}
        onClick={() => onOpen(t.id)}
        tabIndex={0} data-task={t.id} aria-label={`Tarefa #${t.number}: ${t.title}${pos ? `, ${pos}º na fila` : ''}`}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(t.id); } }}>
        <div className="task__top">
          {editable && onToggle && <input type="checkbox" checked={!!t.completed} onClick={(e) => e.stopPropagation()} onChange={(e) => onToggle(t, e.target.checked)} aria-label={`Concluir #${t.number}`} />}
          <span className="task__title">{t.title}</span>
        </div>
        <div className="task__meta">
          <span className="muted">#{t.number}</span>
          {pos > 0 && <span className="task__pos" title="Posição na fila: a equipe pega de cima para baixo">{pos}º</span>}
          <DueChip due={t.due_on} done={!!t.completed} />
          {who(t)}
          {badges(t)}
        </div>
      </article>
    );
  };

  if (view === 'lista') {
    const cmp = (a: TaskCard, b: TaskCard): number => {
      const k = sort.key;
      const v = k === 'prazo' ? (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999')
        : k === 'responsavel' ? ((a.agent_id && a.agent_name) || a.external_assignee || '~').localeCompare((b.agent_id && b.agent_name) || b.external_assignee || '~', 'pt-BR')
          : k === 'atualizada' ? b.updated_at.localeCompare(a.updated_at)
            : a.number - b.number;
      return (v || a.number - b.number) * sort.dir;
    };
    const head = (key: SortKey, label: string, cls = '') => (
      <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        <button className="tbl__sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
          {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
        </button>
      </th>
    );
    const cols = 6 + (editable && onToggle ? 1 : 0);
    return (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {editable && onToggle && <th className="tbl__check"><span className="sr-only">Concluída</span></th>}
              {head('numero', '#', 'tbl__num')}
              <th>Tarefa</th>
              <th className="tbl__col">Situação</th>
              {head('responsavel', team ? 'Responsável' : 'Com quem', 'tbl__who')}
              {head('prazo', 'Prazo', 'tbl__due')}
              <th className="tbl__state">Andamento</th>
              {head('atualizada', 'Atualizada', 'tbl__upd')}
            </tr>
          </thead>
          {columns.map((c) => {
            const rows = tasks.filter((t) => t.column_id === c.id).sort(cmp);
            return (
              <tbody key={c.id} className="tbl__group"
                onDragOver={(e) => { if (editable) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragId && editable && onMove) onMove(dragId, c.id); setDragId(null); }}>
                <tr className="tbl__grouphead"><th colSpan={cols + 1}>{c.name} <span className="muted">{rows.length}</span></th></tr>
                {rows.map((t) => (
                  <tr key={t.id} className={`tbl__row ${t.completed ? 'is-done' : ''} ${openId === t.id ? 'is-open' : ''}`} draggable={editable}
                    onDragStart={() => setDragId(t.id)} onClick={() => onOpen(t.id)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}>
                    {editable && onToggle && (
                      <td className="tbl__check"><input type="checkbox" checked={!!t.completed} onClick={(e) => e.stopPropagation()} onChange={(e) => onToggle(t, e.target.checked)} aria-label={`Concluir #${t.number}`} /></td>
                    )}
                    <td className="tbl__num muted">#{t.number}</td>
                    <td className="tbl__title"><span>{t.title}</span>{t.description && !/^Criada a partir|^Enviada das suas tarefas|^Primeiros passos/.test(t.description) ? <small>{t.description.slice(0, 120)}</small> : null}</td>
                    <td className="tbl__col" onClick={(e) => { if (editable && onMove) e.stopPropagation(); }}>
                      {editable && onMove
                        ? <select value={t.column_id} onChange={(e) => onMove(t.id, e.target.value)} aria-label={`Situação de #${t.number}`}>{columns.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                        : <span className="badge">{c.name}</span>}
                    </td>
                    <td className="tbl__who">{who(t, true) ?? <span className="muted">—</span>}</td>
                    <td className="tbl__due">{t.due_on ? <DueChip due={t.due_on} done={!!t.completed} /> : <span className="muted">—</span>}</td>
                    <td className="tbl__state"><span className="tbl__badges">{badges(t)}</span></td>
                    <td className="tbl__upd muted" title={new Date(t.updated_at).toLocaleString('pt-BR')}>{ago(t.updated_at)}</td>
                  </tr>
                ))}
                {!rows.length && <tr className="tbl__empty"><td colSpan={cols + 1} className="muted">Nenhuma tarefa.</td></tr>}
              </tbody>
            );
          })}
        </table>
      </div>
    );
  }
  return (
    <ColumnsScroller columns={columns.map((c) => ({ id: c.id, name: c.name, count: tasks.filter((t) => t.column_id === c.id).length }))}>
      {columns.map((c) => {
        const mine = tasks.filter((t) => t.column_id === c.id);
        const isQueue = !!onReorder && c.id === queueColumn;
        return (
          <section key={c.id} className={`column ${isQueue && dragId && dropAt?.before === null ? 'column--drop-end' : ''}`} aria-label={c.name} data-col={c.id}
            onDragOver={(e) => {
              if (editable) e.preventDefault();
              else if (isQueue && dragId && queued.some((q) => q.id === dragId)) {
                e.preventDefault();
                // abaixo do último card da fila: vai para o fim
                const last = queued[queued.length - 1];
                const el = last && e.currentTarget.querySelector<HTMLElement>(`[data-task="${last.id}"]`);
                if (el && e.clientY > el.getBoundingClientRect().bottom && dropAt?.before !== null) setDropAt({ before: null });
              }
            }}
            onDragLeave={(e) => { if (isQueue && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null); }}
            onDrop={(e) => {
              e.preventDefault();
              if (isQueue && !editable) return dropInQueue();
              if (dragId && editable && onMove) onMove(dragId, c.id);
              endDrag();
            }}>
            <h3>{c.name} <span className="muted">{mine.length}</span></h3>
            {isQueue && queued.length > 1 && <p className="column__hint">Arraste para mudar a ordem: a equipe pega de cima para baixo.</p>}
            {mine.map(card)}
            {!mine.length && <p className="column__empty">{(team && TEAM_EMPTY[c.name]) || (editable ? 'Nenhuma tarefa. Arraste um card para cá.' : 'Nenhuma tarefa.')}</p>}
          </section>
        );
      })}
    </ColumnsScroller>
  );
}

/**
 * Colunas do quadro que nem sempre cabem (meia tela, janela estreita): quando sobram colunas fora da vista, aparece
 * uma barra com o nome e a contagem de cada uma (clique leva até ela) e setas para ir de uma em uma. Arrastar pelo
 * fundo do quadro (não pelos cards) também desliza para o lado; no toque, o deslize é o do próprio navegador.
 */
function ColumnsScroller({ columns, children }: { columns: Array<{ id: string; name: string; count: number }>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState({ overflow: false, start: true, end: true, visible: new Set<string>() });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const visible = new Set<string>();
    el.querySelectorAll<HTMLElement>('[data-col]').forEach((c) => {
      const r = c.getBoundingClientRect();
      const shown = Math.min(r.right, box.right) - Math.max(r.left, box.left);
      if (r.width && shown / r.width >= 0.6) visible.add(c.dataset.col!); // à vista = pelo menos 60% da coluna
    });
    setState({ overflow: el.scrollWidth > el.clientWidth + 2, start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2, visible });
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', measure); };
  }, [measure, columns.length]);
  const go = (id: string) => ref.current?.querySelector<HTMLElement>(`[data-col="${id}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  const step = (dir: 1 | -1) => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-col]');
    if (el && first) el.scrollBy({ left: dir * (first.getBoundingClientRect().width + 12), behavior: 'smooth' });
  };
  // arrastar pelo fundo (mouse): desliza o quadro; cards e controles continuam com o comportamento deles
  // (o encaixe na coluna fica desligado enquanto arrasta: ligado, ele puxava o quadro de volta a cada movimento)
  const drag = useRef<{ x: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !state.overflow) return;
    if ((e.target as Element).closest('.task, button, input, select, textarea, a')) return;
    drag.current = { x: e.clientX, left: ref.current!.scrollLeft };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => { if (drag.current && ref.current) ref.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x); };
  const stop = () => { drag.current = null; setDragging(false); };
  return (
    <div className="board-wrap">
      {state.overflow && (
        <div className="board-nav" role="toolbar" aria-label="Colunas do quadro">
          <button className="icon-btn" onClick={() => step(-1)} disabled={state.start} aria-label="Coluna anterior" title="Coluna anterior"><Icon name="chevron-left" size={16} /></button>
          <div className="board-nav__cols">
            {columns.map((c) => (
              <button key={c.id} className={`board-nav__col ${state.visible.has(c.id) ? 'is-on' : ''}`} onClick={() => go(c.id)} aria-current={state.visible.has(c.id) ? 'true' : undefined}>
                {c.name} <span className="muted">{c.count}</span>
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={() => step(1)} disabled={state.end} aria-label="Próxima coluna" title="Próxima coluna"><Icon name="chevron-right" size={16} /></button>
        </div>
      )}
      <div ref={ref} className={`board ${state.overflow ? 'board--scroll' : ''} ${dragging ? 'board--dragging' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>
        {children}
      </div>
    </div>
  );
}

export function ViewToggle({ view, onChange }: { view: 'kanban' | 'lista'; onChange: (v: 'kanban' | 'lista') => void }) {
  return (
    <span className="seg" role="group" aria-label="Visão">
      <button className={`seg__btn ${view === 'kanban' ? 'seg__btn--on' : ''}`} aria-pressed={view === 'kanban'} onClick={() => onChange('kanban')}>Quadro</button>
      <button className={`seg__btn ${view === 'lista' ? 'seg__btn--on' : ''}`} aria-pressed={view === 'lista'} onClick={() => onChange('lista')}>Lista</button>
    </span>
  );
}
