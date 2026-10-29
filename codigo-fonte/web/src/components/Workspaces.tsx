import { useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

interface Workspace { id: string; name: string; role: string; current: boolean; agents: number; openTasks: number; working: number; waiting: number }

const n = (v: number, um: string, varios: string) => `${v} ${v === 1 ? um : varios}`;
// trocar de workspace muda tudo o que a tela mostra (equipe, cidade, quadros, conversas): recarrega a página
const recarregar = () => window.location.reload();

/** Seletor de workspace na barra de cima: o atual e, ao abrir, a visão geral de todos os da pessoa. */
export function WorkspaceSwitcher({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="topbar__wswrap">
      <button className="chip chip--btn topbar__ws" data-keep-surface onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={`Workspace: ${current}. Trocar ou criar workspace`} title="Workspaces: trocar, ver todos ou criar um novo">
        <Icon name="layers" size={14} /><span className="topbar__ws-txt">{current}</span><Icon name="chevron" size={12} />
      </button>
      {open && <WorkspacesPanel onClose={() => setOpen(false)} />}
    </span>
  );
}

function WorkspacesPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, outside: true });
  const res = useResource<Workspace[]>('/api/workspaces', ['tasks.changed', 'runs.changed', 'agents.changed']);
  const list = res.data;
  const [err, setErr] = useState<string | null>(null);
  const [novo, setNovo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, depois: () => void) => {
    setBusy(true); setErr(null);
    try { await fn(); depois(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const entrar = (w: Workspace) => (w.current ? onClose() : act(() => api.post('/api/session/workspace', { workspaceId: w.id }), recarregar));
  const criar = () => novo?.trim() && act(() => api.post('/api/workspaces', { name: novo }), recarregar);

  return (
    <aside ref={ref} className="status-pop ws-pop" role="dialog" aria-labelledby="ws-title">
      <div className="drawer__head"><h3 className="drawer__title" id="ws-title">Workspaces</h3><button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button></div>
      <p className="muted small">Cada workspace tem a sua equipe, cidade, quadros, conversas e rotinas. A conta de IA é sua e vale para todos.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {!list ? <p className="muted small">Carregando…</p> : (
        <ul className="ws-list">
          {list.map((w) => (
            <li key={w.id}>
              <button className={`ws-item ${w.current ? 'is-current' : ''}`} disabled={busy} onClick={() => void entrar(w)}
                aria-current={w.current ? 'true' : undefined} title={w.current ? 'Workspace atual' : `Entrar em ${w.name}`}>
                <span className="ws-item__head">
                  <b className="ws-item__name">{w.name}</b>
                  {w.current && <span className="chip chip--stat">atual</span>}
                  <span className="ws-item__grow" />
                  {!w.current && <Icon name="chevron-right" size={14} />}
                </span>
                <span className="ws-item__nums muted small">
                  {n(w.agents, 'agente', 'agentes')} · {n(w.openTasks, 'tarefa aberta', 'tarefas abertas')}
                  {w.working > 0 && <> · <span className="ws-item__on">{w.working} trabalhando</span></>}
                  {w.waiting > 0 && <> · <b>{w.waiting} aguardando você</b></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {novo === null ? (
        <button className="btn btn--ghost ws-new" onClick={() => setNovo('')}><Icon name="plus" size={14} /> Novo workspace</button>
      ) : (
        <form className="ws-new__form" onSubmit={(e) => { e.preventDefault(); void criar(); }}>
          <label className="small" htmlFor="ws-novo">Nome do workspace novo (uma empresa, um projeto, a vida pessoal…)</label>
          <div className="ws-item__edit">
            <input id="ws-novo" className="input" value={novo} maxLength={60} autoFocus placeholder="Ex.: Loja da Ana" onChange={(e) => setNovo(e.target.value)} />
            <button className="btn btn--sm btn--gold" disabled={busy || !novo.trim()}>Criar e entrar</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNovo(null)}>Cancelar</button>
          </div>
          <p className="muted small">Ele nasce com a equipe e a cidade iniciais e passa pelas boas-vindas, como uma conta nova.</p>
        </form>
      )}
    </aside>
  );
}
