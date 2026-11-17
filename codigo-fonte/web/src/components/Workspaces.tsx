import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useSurface } from '../lib/surface.ts';
import { useBalao } from '../lib/balao.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';
import { WsFoto } from './WsCard.tsx';
import { filtrarWorkspaces, mostraBuscaWs, moverAtivo } from '../lib/busca-ws.ts';

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
  // qual está no Ergon World (quando a instalação tem o World; sem ele, a resposta não tem conta e nenhum ganha o selo)
  const world = useResource<{ link: { boundWorkspaceId: string | null } | null }>('/api/world/status', []);
  const noWorld = world.data?.link?.boundWorkspaceId ?? null;
  const list = res.data;
  const [err, setErr] = useState<string | null>(null);
  const [novo, setNovo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // busca pelo nome, com muitos workspaces: setas e Enter escolhem, Esc limpa e depois fecha
  const [busca, setBusca] = useState('');
  const [ativo, setAtivo] = useState(0);
  const comBusca = !!list && mostraBuscaWs(list.length);
  const vistos = list ? (comBusca ? filtrarWorkspaces(list, busca) : list) : [];
  const ativoReal = comBusca && vistos.length ? Math.min(ativo, vistos.length - 1) : -1;
  const idAtivo = ativoReal >= 0 ? vistos[ativoReal].id : null;
  useEffect(() => { if (idAtivo) document.getElementById(`ws-op-${idAtivo}`)?.scrollIntoView?.({ block: 'nearest' }); }, [idAtivo]);

  const act = async (fn: () => Promise<unknown>, depois: () => void) => {
    setBusy(true); setErr(null);
    try { await fn(); depois(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const entrar = (w: Workspace) => (w.current ? onClose() : act(() => api.post('/api/session/workspace', { workspaceId: w.id }), recarregar));
  const criar = () => novo?.trim() && act(() => api.post('/api/workspaces', { name: novo }), recarregar);
  const teclaBusca = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAtivo(moverAtivo(ativoReal, vistos.length, e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const w = vistos[ativoReal]; if (w && !busy) void entrar(w); }
    else if (e.key === 'Escape') { e.preventDefault(); if (busca) { setBusca(''); setAtivo(0); } else onClose(); }
  };

  return (
    <aside ref={ref} className="status-pop ws-pop" role="dialog" aria-labelledby="ws-title">
      <div className="drawer__head"><h3 className="drawer__title" id="ws-title">{t('geral.ws.titulo')}</h3><button className="icon-btn" onClick={onClose} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button></div>
      <p className="muted small">{t('geral.ws.explica')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {comBusca && (
        <label className="help__search ws-busca" data-esc-own><Icon name="search" size={15} />
          <input type="search" value={busca} autoFocus data-autofocus placeholder={t('geral.ws.buscar')} aria-label={t('geral.ws.buscarAria')}
            aria-controls="ws-lista" aria-activedescendant={idAtivo ? `ws-op-${idAtivo}` : undefined}
            onChange={(e) => { setBusca(e.target.value); setAtivo(0); }} onKeyDown={teclaBusca} />
        </label>
      )}
      {!list ? <p className="muted small">{t('geral.comum.carregando')}</p> : comBusca && !vistos.length ? <p className="muted small" role="status">{t('geral.ws.nenhum')}</p> : (
        <ul className="ws-list" id="ws-lista">
          {vistos.map((w, i) => (
            <li key={w.id}>
              <button id={`ws-op-${w.id}`} className={`ws-item ${w.current ? 'is-current' : ''} ${i === ativoReal ? 'is-active' : ''}`} disabled={busy} onClick={() => void entrar(w)}
                aria-current={w.current ? 'true' : undefined} title={w.current ? t('geral.ws.atual') : t('geral.ws.entrarEm', { nome: w.name })}>
                <WsFoto id={w.id} w={84} h={52} className="ws-item__foto" />
                <span className="ws-item__txt">
                  <span className="ws-item__head">
                    <b className="ws-item__name">{w.name}</b>
                    <span className="ws-item__grow" />
                    {!w.current && <Icon name="chevron-right" size={14} />}
                  </span>
                  <span className="ws-item__selos">
                    {w.current && <span className="badge badge--atual">{t('geral.ws.atualChip')}</span>}
                    {world.data?.link && (noWorld === w.id
                      ? <span className="badge badge--world"><Icon name="globe" size={11} /> {t('geral.ws.noWorld')}</span>
                      : <span className="badge">{t('geral.ws.local')}</span>)}
                  </span>
                  <span className="ws-item__nums muted small">
                    {t('geral.ws.agentes', { n: w.agents })} · {t('geral.ws.tarefasAbertas', { n: w.openTasks })}
                    {w.working > 0 && <> · <span className="ws-item__on">{t('geral.ws.trabalhando', { n: w.working })}</span></>}
                    {w.waiting > 0 && <> · <b>{t('geral.ws.aguardando', { n: w.waiting })}</b></>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {novo === null ? (
        <div className="ws-pop__pe">
          <button className="btn btn--ghost ws-new" onClick={() => setNovo('')}><Icon name="plus" size={14} /> {t('geral.ws.novo')}</button>
          <a className="btn btn--ghost" href="#configuracao?workspace" onClick={onClose}><Icon name="gear" size={14} /> {t('geral.ws.gerenciar')}</a>
        </div>
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
