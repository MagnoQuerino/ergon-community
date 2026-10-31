import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errMsg, type ApiError } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { beginDrag, useDragging, type DropTarget } from '../lib/dragMove.ts';
import { teamUrl, useAgentList, useGroupPages, type Placement, type TeamAgent, type TeamSector, type TeamStructure, type TeamSummary } from '../lib/teamData.ts';
import type { AppState } from '../lib/types.ts';
import { AgentFigure } from '../components/AgentFigure.tsx';
import { Icon } from '../components/Icon.tsx';
import { MoveTray, type Pick } from '../components/MoveTray.tsx';
import { NewAgentDialog } from '../components/NewAgentDialog.tsx';
import { DistributionDialog } from '../components/DistributionDialog.tsx';
import { VirtualGrid } from '../components/VirtualGrid.tsx';

const RUN_LABEL: Record<string, string> = { running: 'trabalhando', queued: 'na fila', waiting_user: 'aguarda você' };
const CARD_H = 132; const CARD_MIN = 280;
type Mode = 'setor' | 'estrutura';
type Open = { kind: 'sector'; key: string; name: string } | { kind: 'structure'; id: string; name: string } | null;
interface Toast { text: string; tone?: 'error'; actions?: Array<{ label: string; run: () => void }> }
type MoveDest = { kind: 'sector'; key: string; name: string } | { kind: 'structure'; id: string; name: string };

const MODE_KEY = 'ergon.equipe.modo';
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'estrutura' ? 'estrutura' : 'setor'; } catch { return 'setor'; } };

/**
 * Equipe: os personagens da cidade, por setor (o que fazem) ou por estrutura (onde moram). Clicar abre o perfil;
 * arrastar pelo boneco muda de setor ou de construção, e "Mover para…" faz o mesmo sem arrastar. Tudo vem por partes
 * do servidor (docs/EQUIPE_VISUAL.md): grupos recolhidos mostram uma amostra e a contagem; abrir um grupo, ou buscar,
 * carrega os membros conforme a rolagem, e só os visíveis viram elementos na página.
 */
export function AgentesView({ state, reload, onOpen }: { state: AppState; reload: () => void; onOpen: (id: string, tab?: 'conversa' | 'perfil') => void }) {
  const scope = state.workspace.id;
  const summary = useResource<TeamSummary>('/api/team/summary', ['agents.changed', 'city.changed']).data;
  const [mode, setMode] = useState<Mode>(readMode);
  const [q, setQ] = useState(''); const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  const [open, setOpen] = useState<Open>(null);
  const [creating, setCreating] = useState(false);
  const [tray, setTray] = useState<{ agent: TeamAgent; tab: 'sector' | 'structure' } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState(false);
  const [distrib, setDistrib] = useState(false);
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* sem armazenamento: só não lembra */ } }, [mode]);
  useEffect(() => { setOpen(null); setQ(''); }, [scope]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.actions?.length ? 10000 : 6000); return () => clearTimeout(t); }, [toast]);

  // a mesma operação para arrastar, "Mover para…", "Adicionar andar e mover" e Desfazer
  const busy = useRef(new Set<string>());
  const move = useCallback(async (a: TeamAgent, dest: MoveDest, opts: { addFloor?: boolean; expect?: { sectorKey?: string; structureId?: string }; undo?: boolean } = {}) => {
    if (busy.current.has(a.id)) return; // um movimento por vez para o mesmo agente
    busy.current.add(a.id); setPending(new Set(busy.current));
    const body = dest.kind === 'sector' ? { sectorKey: dest.key } : { structureId: dest.id };
    try {
      const r = await api.post<{ from: Placement; to: Placement; changed: boolean; grew: boolean }>(`/api/agents/${a.id}/move`, {
        ...body, ...(opts.addFloor ? { addFloor: true } : {}),
        expect: opts.expect ?? (dest.kind === 'sector' ? { sectorKey: a.sector_key } : { structureId: a.building_id ?? undefined }),
      });
      if (!r.changed) return;
      const back: MoveDest = dest.kind === 'sector' ? { kind: 'sector', key: r.from.sectorKey, name: r.from.sectorName } : { kind: 'structure', id: r.from.structureId ?? '', name: r.from.structureName ?? '' };
      const now = { ...a, sector_key: r.to.sectorKey, sector_name: r.to.sectorName, building_id: r.to.structureId, building_name: r.to.structureName };
      const text = opts.undo ? `Desfeito: ${a.name} voltou para ${dest.kind === 'sector' ? `o setor ${r.to.sectorName}` : r.to.structureName}.`
        : dest.kind === 'sector' ? `${a.name} agora está no setor ${dest.name}. Papel, instruções e ferramentas continuam os mesmos.`
          : `${a.name} agora mora em ${dest.name}${r.grew ? ' (com um andar novo)' : ''}. Setor e trabalhos continuam os mesmos.`;
      setToast({ text, actions: opts.undo || !back.name ? [] : [{ label: 'Desfazer', run: () => { setToast(null); void move(now, back, { undo: true, expect: dest.kind === 'sector' ? { sectorKey: r.to.sectorKey } : { structureId: r.to.structureId ?? undefined } }); } }] });
    } catch (e) {
      const code = (e as ApiError).code;
      if (code === 'structure_full' && dest.kind === 'structure') {
        setToast({ text: `${dest.name} está cheia.`, tone: 'error', actions: [
          { label: 'Adicionar andar e mover', run: () => { setToast(null); void move(a, dest, { ...opts, addFloor: true }); } },
          { label: 'Escolher outra', run: () => { setToast(null); setTray({ agent: a, tab: 'structure' }); } },
        ] });
      } else setToast({ text: errMsg(e), tone: 'error' });
    } finally { busy.current.delete(a.id); setPending(new Set(busy.current)); }
  }, []);

  const onDrop = useCallback((a: TeamAgent, t: DropTarget) => {
    if (t.kind === 'sector') void move(a, { kind: 'sector', key: t.id, name: t.name });
    else if (t.kind === 'structure') void move(a, { kind: 'structure', id: t.id, name: t.name });
  }, [move]);
  const drag = useCallback((e: React.PointerEvent<HTMLElement>, a: TeamAgent) => beginDrag(e, a, {
    onDrop, onTray: (x) => setTray({ agent: x, tab: 'structure' }), disabled: busy.current.has(a.id),
    onRefuse: (x, why) => setToast({ text: `${x.name} não mudou: ${why}.`, tone: 'error' }),
  }), [onDrop]);
  const pickFromTray = (p: Pick) => {
    const a = tray?.agent; setTray(null); if (!a) return;
    void move(a, p.kind === 'sector' ? { kind: 'sector', key: p.key, name: p.name } : { kind: 'structure', id: p.id, name: p.name }, p.kind === 'structure' && p.addFloor ? { addFloor: true } : {});
  };
  const card = (a: TeamAgent, extra?: ReactNode) => <AgentCard key={a.id} a={a} pending={pending.has(a.id)} onOpen={onOpen} onDrag={drag} onMove={(x, tab) => setTray({ agent: x, tab })} extra={extra} />;
  const reactivate = async (a: TeamAgent) => {
    try { await api.post(`/api/agents/${a.id}/reactivate`); setToast({ text: `${a.name} voltou à equipe.` }); reload(); } catch (err) { setToast({ text: errMsg(err), tone: 'error' }); }
  };

  const total = summary?.agents.active ?? state.agents.filter((a) => a.status === 'active').length;
  return (
    <div className="page equipe">
      <header className="equipe__head">
        <div>
          <h2>Equipe</h2>
          <p className="muted">{total} agente{total === 1 ? '' : 's'} · {mode === 'setor' ? 'Especialistas organizados por setor' : 'O endereço de cada especialista'}</p>
        </div>
        <div className="equipe__actions">
          <div className="equipe__more">
              <button className="icon-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} aria-label="Mais ações" title="Mais ações"><Icon name="dots" /></button>
              {menu && <MoreMenu themed={(summary?.themed ?? 0) > 0} onClose={() => setMenu(false)} onDistribute={() => { setMenu(false); setDistrib(true); }} onRestore={async () => {
                setMenu(false);
                try {
                  const r = await api.post<{ restored: string[]; skipped: string[] }>('/api/team/restore-theme');
                  setToast({ text: r.skipped.length ? `Voltaram: ${r.restored.join(', ') || 'nenhum'}. Ficaram como estão: ${r.skipped.join('; ')}.` : 'Nomes e histórias gregos de volta. Funções e instruções continuam como estavam.' });
                  reload();
                } catch (e) { setToast({ text: errMsg(e), tone: 'error' }); }
              }} />}
          </div>
          <button className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> Novo agente</button>
        </div>
      </header>

      <div className="equipe__bar">
        <div className="seg" role="tablist" aria-label="Apresentação">
          <button role="tab" aria-selected={mode === 'setor'} className={`seg__btn ${mode === 'setor' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setMode('setor'); setOpen(null); }}><Icon name="layers" size={14} /> Por setor</button>
          <button role="tab" aria-selected={mode === 'estrutura'} className={`seg__btn ${mode === 'estrutura' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setMode('estrutura'); setOpen(null); }}><Icon name="temple" size={14} /> Por estrutura</button>
        </div>
        <label className="equipe__search"><Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pelo nome ou pelo que faz" aria-label="Buscar na equipe" />
          {q && <button className="icon-btn" onClick={() => setQ('')} aria-label="Limpar a busca"><Icon name="x" size={13} /></button>}
        </label>
        <span className="muted small equipe__tip">Arraste pelo boneco · ou use “Mover para…”</span>
      </div>

      {dq ? (
        <MemberList title={`Resultados para “${dq}”`} filter={{ q: dq, status: 'all' }} scope={scope} card={(a) => card(a)} empty="Ninguém encontrado." />
      ) : open ? (
        <section className="equipe__open" data-drop-kind={open.kind} data-drop-id={open.kind === 'sector' ? open.key : open.id} data-drop-name={open.name}>
          <button className="linkish equipe__back" onClick={() => setOpen(null)}><span className="flip"><Icon name="chevron" size={13} /></span> {open.kind === 'sector' ? 'Todos os setores' : 'Todas as construções'}</button>
          <MemberList title={open.name} filter={open.kind === 'sector' ? { sector: open.key } : { structure: open.id }} scope={scope} card={(a) => card(a)}
            empty={open.kind === 'sector' ? 'Ninguém neste setor ainda. Arraste alguém para cá ou use “Mover para…”.' : 'Sem moradores. Arraste alguém para cá ou use “Mover para…”.'} />
        </section>
      ) : mode === 'setor' ? (
        <SectorGroups scope={scope} card={(a) => card(a)} onOpenGroup={setOpen} />
      ) : (
        <StructureGroups scope={scope} card={(a) => card(a)} onOpenGroup={setOpen} onToast={setToast} />
      )}

      {!dq && !open && (summary?.agents.archived ?? 0) > 0 && (
        <details className="equipe__off">
          <summary className="muted">Desativados ({summary!.agents.archived})</summary>
          <MemberList title="" filter={{ status: 'archived' }} scope={scope} empty="Ninguém desativado."
            card={(a) => card(a, <button className="btn btn--sm" onClick={(e) => { e.stopPropagation(); void reactivate(a); }}><Icon name="undo" size={13} /> Reativar</button>)} />
        </details>
      )}

      <p className="equipe__foot muted small">
        <span>{mode === 'setor' ? 'Mudar de setor preserva o papel, as instruções e as ferramentas.' : 'Mudar de endereço preserva o setor e os trabalhos.'}</span>
        <span>Clique no nome para abrir o perfil</span>
      </p>

      <DragLayer />
      {toast && (
        <div className={`equipe__toast ${toast.tone === 'error' ? 'equipe__toast--error' : ''}`} role="status">
          <span>{toast.text}</span>
          {toast.actions?.map((x) => <button key={x.label} className="linkish" onClick={x.run}>{x.label}</button>)}
          <button className="icon-btn" onClick={() => setToast(null)} aria-label="Fechar aviso"><Icon name="x" size={13} /></button>
        </div>
      )}
      {creating && <NewAgentDialog onClose={() => setCreating(false)} onCreated={(r) => {
        setCreating(false);
        setToast({ text: `${r.name} entrou na equipe, no setor ${r.sector}${r.sectorReason ? ` (${r.sectorReason})` : ''}. A aparência escolhida foi mantida.`, actions: [{ label: 'Abrir perfil', run: () => { setToast(null); onOpen(r.id, 'perfil'); } }] });
        reload();
      }} />}
      {tray && <MoveTray agent={tray.agent} initial={tray.tab} title={`Mover ${tray.agent.name} para…`} onPick={pickFromTray} onClose={() => setTray(null)} />}
      {distrib && <DistributionDialog onClose={() => setDistrib(false)} onApplied={(r) => {
        setDistrib(false);
        setToast({ text: `${r.moved} agente${r.moved === 1 ? '' : 's'} mudaram de endereço. Setores e trabalhos continuam os mesmos.`, actions: [{ label: 'Desfazer', run: async () => {
          setToast(null);
          try { const u = await api.post<{ moved: number }>(`/api/team/distribution/undo/${r.batchId}`); setToast({ text: `Desfeito: ${u.moved} agente${u.moved === 1 ? '' : 's'} voltaram para onde estavam.` }); }
          catch (e) { setToast({ text: errMsg(e), tone: 'error' }); }
        } }] });
      }} />}
    </div>
  );
}

function MoreMenu({ themed, onClose, onRestore, onDistribute }: { themed: boolean; onClose: () => void; onRestore: () => void; onDistribute: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  return (
    <div ref={ref} className="equipe__menu" role="menu">
      <button role="menuitem" onClick={onDistribute}><Icon name="layers" size={14} /> Sugerir distribuição…</button>
      {themed && <button role="menuitem" onClick={onRestore}><Icon name="palette" size={14} /> Voltar aos nomes e histórias gregos</button>}
    </div>
  );
}

/** Membros de um grupo, de uma busca ou os desativados: por partes, com a grade virtualizada. */
function MemberList({ title, filter, scope, card, empty }: { title: string; filter: { q?: string; sector?: string; structure?: string; status?: 'active' | 'archived' | 'all' }; scope: string; card: (a: TeamAgent) => ReactNode; empty: string }) {
  const list = useAgentList(filter, scope);
  return (
    <div className="members">
      {title && <h3 className="members__title">{title} <span className="muted">· {list.ready ? list.total : '…'}</span></h3>}
      {list.error && <p className="error">{list.error} <button className="linkish" onClick={list.reload}>Tentar de novo</button></p>}
      {list.ready && <VirtualGrid items={list.items} hasMore={!!list.next} onNeedMore={list.more} rowHeight={CARD_H} minColWidth={CARD_MIN} render={card} keyOf={(a) => a.id} label={title || 'Agentes'} empty={<p className="hint">{empty}</p>} />}
    </div>
  );
}

function Pager({ page, total, what }: { page: { prev: null | (() => void); next: null | (() => void) }; total: number; what: string }) {
  if (!page.prev && !page.next) return null;
  return (
    <div className="equipe__pager">
      <button className="btn btn--sm btn--ghost" onClick={() => page.prev?.()} hidden={!page.prev}><span className="flip"><Icon name="chevron" size={13} /></span> Anteriores</button>
      <span className="muted small">{total} {what}</span>
      <button className="btn btn--sm btn--ghost" onClick={() => page.next?.()} hidden={!page.next}>Próximos <Icon name="chevron" size={13} /></button>
    </div>
  );
}

/** Por setor: um recipiente por setor (com amostra e contagem), que também recebe agentes arrastados. */
function SectorGroups({ scope, card, onOpenGroup }: { scope: string; card: (a: TeamAgent) => ReactNode; onOpenGroup: (o: Open) => void }) {
  const g = useGroupPages<TeamSector>((c) => teamUrl.sectors('', c, 24), scope);
  if (g.error) return <p className="error">{g.error} <button className="linkish" onClick={g.reload}>Tentar de novo</button></p>;
  if (!g.data) return <div className="groups groups--loading" aria-busy="true" />;
  return (
    <>
      <div className="groups">
        {g.data.items.map((s) => (
          <section key={s.key} className="group" data-drop-kind="sector" data-drop-id={s.key} data-drop-name={s.name} aria-label={`Setor ${s.name}`}>
            <header className="group__head"><h3>{s.name}</h3><span className="muted">{s.count}</span></header>
            <div className="group__cards">
              {s.sample.map(card)}
              {!s.count && <p className="group__empty hint">Ninguém aqui ainda. Arraste alguém para cá.</p>}
            </div>
            {s.count > s.sample.length && <button className="linkish group__all" onClick={() => onOpenGroup({ kind: 'sector', key: s.key, name: s.name })}>Ver todos ({s.count})</button>}
            {s.description && <p className="group__desc muted small">{s.description}</p>}
          </section>
        ))}
      </div>
      <Pager page={g} total={g.data.total} what="setores" />
    </>
  );
}

/** Por estrutura: cada construção com ocupação, os moradores (amostra) e os lugares livres; com espaço para subir, "Andar". */
function StructureGroups({ scope, card, onOpenGroup, onToast }: { scope: string; card: (a: TeamAgent) => ReactNode; onOpenGroup: (o: Open) => void; onToast: (t: Toast) => void }) {
  const g = useGroupPages<TeamStructure>((c) => teamUrl.structures({}, c, 24), scope);
  const [adding, setAdding] = useState<string | null>(null);
  const addFloor = async (b: TeamStructure) => {
    if (adding) return; setAdding(b.id);
    try { await api.post(`/api/structures/${b.id}/floors`); onToast({ text: `Andar novo em ${b.name}.` }); g.reload(); }
    catch (e) { onToast({ text: errMsg(e), tone: 'error' }); } finally { setAdding(null); }
  };
  if (g.error) return <p className="error">{g.error} <button className="linkish" onClick={g.reload}>Tentar de novo</button></p>;
  if (!g.data) return <div className="groups groups--loading" aria-busy="true" />;
  return (
    <>
      <div className="groups">
        {g.data.items.map((b) => (
          <section key={b.id} className={`building ${b.free === 0 ? 'building--full' : ''}`} data-drop-kind="structure" data-drop-id={b.id} data-drop-name={b.name} aria-label={`${b.name}: ${b.active} de ${b.slots} lugares`}>
            <header className="building__head">
              <span className="building__icon"><Icon name="temple" size={18} /></span>
              <div><h3>{b.name}</h3><span className="muted small">{b.active} de {b.slots} lugares · {b.kind_name}</span></div>
            </header>
            <div className="building__people">
              {b.sample.map(card)}
              {b.free > 0 && <div className="building__free" aria-hidden="true"><Icon name="plus" size={14} /><span>{b.free} lugar{b.free === 1 ? '' : 'es'} livre{b.free === 1 ? '' : 's'}</span></div>}
            </div>
            <footer className="building__foot">
              <span className={`small ${b.free === 0 ? 'building__full' : 'muted'}`}>{b.free === 0 ? 'Cheia' : 'Recebe agentes'}</span>
              {b.active > b.sample.length && <button className="linkish" onClick={() => onOpenGroup({ kind: 'structure', id: b.id, name: b.name })}>Ver todos ({b.active})</button>}
              {b.can_grow && <button className="btn btn--sm btn--ghost" onClick={() => void addFloor(b)} aria-busy={adding === b.id}><Icon name="plus" size={13} /> {adding === b.id ? 'Subindo…' : 'Andar'}</button>}
            </footer>
          </section>
        ))}
      </div>
      <Pager page={g} total={g.data.total} what="construções" />
    </>
  );
}

/** Card de um agente: o boneco (alça de arraste), nome (abre o perfil), papel e endereço; menu com "Mover para…". */
function AgentCard({ a, pending, onOpen, onDrag, onMove, extra }: {
  a: TeamAgent; pending: boolean; onOpen: (id: string, tab?: 'conversa' | 'perfil') => void;
  onDrag: (e: React.PointerEvent<HTMLElement>, a: TeamAgent) => void; onMove: (a: TeamAgent, tab: 'sector' | 'structure') => void; extra?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const open = () => onOpen(a.id, 'perfil');
  return (
    <article className={`tcard ${a.status !== 'active' ? 'tcard--off' : ''} ${pending ? 'is-pending' : ''}`} aria-busy={pending} onClick={(e) => { if (!(e.target as HTMLElement).closest('button, [role="menu"]')) open(); }}>
      <span className="tcard__fig" onPointerDown={(e) => onDrag(e, a)} title={pending ? 'Movendo…' : 'Arraste para mudar de setor ou de construção'}><AgentFigure agent={a} /></span>
      <div className="tcard__body">
        <button className="tcard__name" onClick={open} aria-label={`Abrir o perfil de ${a.name}`}>{a.name}</button>
        <span className="tcard__role">{a.role}</span>
        <span className="tcard__sector">{a.sector_name}</span>
        {a.coordinator && <span className="tcard__meta"><Icon name="lock" size={12} /> Cargo fixo</span>}
        <span className="tcard__meta"><Icon name="pin" size={12} /> {a.building_name ?? '—'}</span>
        {pending ? <span className="badge">movendo…</span> : a.run_status ? <span className="badge badge--warn">{RUN_LABEL[a.run_status]}</span> : null}
        {a.status !== 'active' && <span className="muted small">{a.deactivation_note ?? 'desativado'}</span>}
        {extra}
      </div>
      <div className="tcard__menu">
        <button className="icon-btn" aria-haspopup="menu" aria-expanded={menu} aria-label={`Ações de ${a.name}`} onClick={() => setMenu((v) => !v)}><Icon name="dots" size={16} /></button>
        {menu && <CardMenu onClose={() => setMenu(false)} items={[
          { label: 'Abrir perfil', icon: 'users', run: open },
          ...(a.status === 'active' ? [{ label: 'Mover para outra construção…', icon: 'temple', run: () => onMove(a, 'structure') }] : []),
          ...(!a.coordinator ? [{ label: 'Mudar de setor…', icon: 'layers', run: () => onMove(a, 'sector') }] : []),
        ]} />}
      </div>
    </article>
  );
}

function CardMenu({ items, onClose }: { items: Array<{ label: string; icon: string; run: () => void }>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose, outside: true });
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  const key = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const bs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]; const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
  };
  return (
    <div ref={ref} className="tcard__menulist" role="menu" onKeyDown={key}>
      {items.map((x) => <button key={x.label} role="menuitem" onClick={() => { onClose(); x.run(); }}><Icon name={x.icon} size={14} /> {x.label}</button>)}
    </div>
  );
}

/** Fantasma do arraste e a bandeja "Mover para…" (soltar nela abre a escolha do destino, inclusive os não carregados). */
function DragLayer() {
  const a = useDragging();
  if (!a) return null;
  return (
    <>
      <div id="drag-ghost" className="drag-ghost" aria-hidden="true">
        <AgentFigure agent={a} />
        <span><b>{a.name}</b><small id="drag-ghost-hint">Solte num setor ou numa construção</small></span>
      </div>
      <div className="drag-tray" data-drop-kind="tray" data-drop-id="" data-drop-name="Mover para…" role="note">
        <Icon name="search" size={15} /> Solte aqui para escolher um destino que não está na tela · Esc cancela
      </div>
    </>
  );
}
