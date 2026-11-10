import { useEffect, useRef, useState } from 'react';
import { useSurface } from '../lib/surface.ts';
import { teamUrl, useGroupPages, type TeamAgent, type TeamSector, type TeamStructure } from '../lib/teamData.ts';
import { Icon } from './Icon.tsx';
import { fmtNumero, useT } from '../i18n/index.ts';

export type Pick = { kind: 'sector'; key: string; name: string } | { kind: 'structure'; id: string; name: string; addFloor?: boolean };

/**
 * "Mover para…": escolhe um setor ou uma construção por cartões, com busca, inclusive destinos que a página ainda não
 * carregou (a lista vem do servidor, por partes). A mesma ação do arraste, sem arrastar: teclado e toque.
 * Sem agente (`agent` nulo), serve para escolher o endereço de um agente novo.
 */
export function MoveTray({ agent, title, initial = 'structure', onPick, onClose, kinds = ['sector', 'structure'] }: {
  agent: TeamAgent | null; title: string; initial?: 'sector' | 'structure'; kinds?: Array<'sector' | 'structure'>;
  onPick: (p: Pick) => void; onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [tab, setTab] = useState<'sector' | 'structure'>(kinds.includes(initial) ? initial : kinds[0]);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const h = setTimeout(() => setDq(q), 200); return () => clearTimeout(h); }, [q]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [tab]);
  const sectors = useGroupPages<TeamSector>((c) => (tab === 'sector' ? `${teamUrl.sectors(dq, c, 20)}&sample=0` : null), `s|${tab}|${dq}`);
  const structures = useGroupPages<TeamStructure>((c) => (tab === 'structure' ? `${teamUrl.structures({ q: dq }, c, 20)}&sample=0` : null), `b|${tab}|${dq}`);
  const coord = !!agent?.coordinator;
  const page = tab === 'sector' ? sectors : structures;
  const busca = tab === 'sector' ? t('quadro.mover.buscarSetor') : t('quadro.mover.buscarConstrucao');
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg movetray" role="dialog" aria-modal="true" aria-labelledby="movetray-t">
        <header className="dlg__head">
          <h3 id="movetray-t">{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('quadro.mover.fechar')}><Icon name="x" /></button>
        </header>
        {kinds.length > 1 && (
          <div className="seg" role="tablist" aria-label={t('quadro.mover.tipo')}>
            <button role="tab" aria-selected={tab === 'sector'} className={`seg__btn ${tab === 'sector' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setTab('sector'); setQ(''); }}><Icon name="layers" size={14} /> {t('quadro.mover.setor')}</button>
            <button role="tab" aria-selected={tab === 'structure'} className={`seg__btn ${tab === 'structure' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setTab('structure'); setQ(''); }}><Icon name="temple" size={14} /> {t('quadro.mover.construcao')}</button>
          </div>
        )}
        <label className="movetray__search"><Icon name="search" size={14} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={busca} aria-label={busca} />
        </label>
        {tab === 'sector' && coord ? (
          <p className="hint">{t('quadro.mover.coordenador')}</p>
        ) : (
          <div className="movetray__list" role="listbox" aria-label={tab === 'sector' ? t('quadro.mover.setores') : t('quadro.mover.construcoes')}>
            {tab === 'sector' && sectors.data?.items.map((s) => {
              const here = agent?.sector_key === s.key;
              return (
                <button key={s.key} role="option" aria-selected={here} className={`dest ${here ? 'dest--here' : ''}`} disabled={here}
                  onClick={() => onPick({ kind: 'sector', key: s.key, name: s.name })}>
                  <span className="dest__icon"><Icon name="layers" size={16} /></span>
                  <span className="dest__body"><b>{s.name}</b><small>{here ? t('quadro.mover.setorAtual') : t('quadro.mover.agentes', { n: s.count })}{s.description ? ` · ${s.description}` : ''}</small></span>
                </button>
              );
            })}
            {tab === 'structure' && structures.data?.items.map((b) => {
              const here = agent?.building_id === b.id; const full = b.free === 0;
              return (
                <div key={b.id} className={`dest ${here ? 'dest--here' : ''} ${full ? 'dest--full' : ''}`}>
                  <button className="dest__main" disabled={here || full} aria-label={here ? t('quadro.mover.atualAria', { nome: b.name }) : full ? t('quadro.mover.cheiaAria', { nome: b.name }) : b.name} onClick={() => onPick({ kind: 'structure', id: b.id, name: b.name })}>
                    <span className="dest__icon"><Icon name="temple" size={16} /></span>
                    <span className="dest__body"><b>{b.name}</b>
                      <small>{b.kind_name} · {t('quadro.mover.lote', { i: b.i, j: b.j })} · {here ? t('quadro.mover.enderecoAtual') : full ? t('quadro.mover.cheia', { ativos: fmtNumero(b.active), vagas: fmtNumero(b.slots) }) : t('quadro.mover.livres', { n: b.free })}</small></span>
                  </button>
                  {full && !here && b.can_grow && (
                    <button className="btn btn--sm" onClick={() => onPick({ kind: 'structure', id: b.id, name: b.name, addFloor: true })}><Icon name="plus" size={13} /> {agent ? t('quadro.mover.andarEMover') : t('quadro.mover.andarEUsar')}</button>
                  )}
                </div>
              );
            })}
            {page.data && !page.data.items.length && <p className="hint">{dq ? t('quadro.mover.nadaPara', { busca: dq }) : t('quadro.mover.nada')}</p>}
            {page.error && <p className="error">{page.error}</p>}
          </div>
        )}
        {(page.prev || page.next) && !(tab === 'sector' && coord) && (
          <footer className="movetray__pages">
            <button className="btn btn--sm btn--ghost" onClick={() => page.prev?.()} hidden={!page.prev}><Icon name="chevron" size={13} /> {t('quadro.mover.anteriores')}</button>
            <span className="muted small">{tab === 'sector' ? t('quadro.mover.totalSetores', { n: page.data?.total ?? 0 }) : t('quadro.mover.totalConstrucoes', { n: page.data?.total ?? 0 })}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => page.next?.()} hidden={!page.next}>{t('quadro.mover.proximas')} <Icon name="chevron" size={13} /></button>
          </footer>
        )}
      </section>
    </div>
  );
}
