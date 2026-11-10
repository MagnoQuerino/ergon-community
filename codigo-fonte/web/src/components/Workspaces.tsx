import { useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { useBalao } from '../lib/balao.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

interface Workspace { id: string; name: string; role: string; current: boolean; agents: number; openTasks: number; working: number; waiting: number }

// trocar de workspace muda tudo o que a tela mostra (equipe, cidade, quadros, conversas): recarrega a página
const recarregar = () => window.location.reload();

/** Seletor de workspace na barra de cima: o atual e, ao abrir, a visão geral de todos os da pessoa. */
export function WorkspaceSwitcher({ current }: { current: string }) {
  const t = useT();
  // um balão da barra por vez; na janela mais estreita o botão sai e o balão abre pela gaveta do menu
  const [open, setOpen] = useBalao('workspace');
  return (
    <span className="topbar__wswrap">
      <button className="chip chip--btn topbar__ws" data-keep-surface onClick={() => setOpen((v) => !v)} aria-expanded={open}
        aria-label={t('geral.ws.botaoAria', { nome: current })} title={t('geral.ws.botaoDica')}>
        <Icon name="layers" size={14} /><span className="topbar__ws-txt">{current}</span><Icon name="chevron" size={12} />
      </button>
      {open && <WorkspacesPanel onClose={() => setOpen(false)} />}
    </span>
  );
}

function WorkspacesPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
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
      <div className="drawer__head"><h3 className="drawer__title" id="ws-title">{t('geral.ws.titulo')}</h3><button className="icon-btn" onClick={onClose} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button></div>
      <p className="muted small">{t('geral.ws.explica')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {!list ? <p className="muted small">{t('geral.comum.carregando')}</p> : (
        <ul className="ws-list">
          {list.map((w) => (
            <li key={w.id}>
              <button className={`ws-item ${w.current ? 'is-current' : ''}`} disabled={busy} onClick={() => void entrar(w)}
                aria-current={w.current ? 'true' : undefined} title={w.current ? t('geral.ws.atual') : t('geral.ws.entrarEm', { nome: w.name })}>
                <span className="ws-item__head">
                  <b className="ws-item__name">{w.name}</b>
                  {w.current && <span className="chip chip--stat">{t('geral.ws.atualChip')}</span>}
                  <span className="ws-item__grow" />
                  {!w.current && <Icon name="chevron-right" size={14} />}
                </span>
                <span className="ws-item__nums muted small">
                  {t('geral.ws.agentes', { n: w.agents })} · {t('geral.ws.tarefasAbertas', { n: w.openTasks })}
                  {w.working > 0 && <> · <span className="ws-item__on">{t('geral.ws.trabalhando', { n: w.working })}</span></>}
                  {w.waiting > 0 && <> · <b>{t('geral.ws.aguardando', { n: w.waiting })}</b></>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {novo === null ? (
        <button className="btn btn--ghost ws-new" onClick={() => setNovo('')}><Icon name="plus" size={14} /> {t('geral.ws.novo')}</button>
      ) : (
        <form className="ws-new__form" onSubmit={(e) => { e.preventDefault(); void criar(); }}>
          <label className="small" htmlFor="ws-novo">{t('geral.ws.nomeNovo')}</label>
          <div className="ws-item__edit">
            <input id="ws-novo" className="input" value={novo} maxLength={60} autoFocus placeholder={t('geral.ws.exemplo')} onChange={(e) => setNovo(e.target.value)} />
            <button className="btn btn--sm btn--gold" disabled={busy || !novo.trim()}>{t('geral.ws.criar')}</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNovo(null)}>{t('geral.comum.cancelar')}</button>
          </div>
          <p className="muted small">{t('geral.ws.nasce')}</p>
        </form>
      )}
    </aside>
  );
}
