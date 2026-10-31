import { useEffect, useRef, useState } from 'react';
import { useSurface } from '../lib/surface.ts';
import { teamUrl, useGroupPages, type TeamAgent, type TeamSector, type TeamStructure } from '../lib/teamData.ts';
import { Icon } from './Icon.tsx';

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
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [tab, setTab] = useState<'sector' | 'structure'>(kinds.includes(initial) ? initial : kinds[0]);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 200); return () => clearTimeout(t); }, [q]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [tab]);
  const sectors = useGroupPages<TeamSector>((c) => (tab === 'sector' ? `${teamUrl.sectors(dq, c, 20)}&sample=0` : null), `s|${tab}|${dq}`);
  const structures = useGroupPages<TeamStructure>((c) => (tab === 'structure' ? `${teamUrl.structures({ q: dq }, c, 20)}&sample=0` : null), `b|${tab}|${dq}`);
  const coord = !!agent?.coordinator;
  const page = tab === 'sector' ? sectors : structures;
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg movetray" role="dialog" aria-modal="true" aria-labelledby="movetray-t">
        <header className="dlg__head">
          <h3 id="movetray-t">{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        {kinds.length > 1 && (
          <div className="seg" role="tablist" aria-label="Tipo de destino">
            <button role="tab" aria-selected={tab === 'sector'} className={`seg__btn ${tab === 'sector' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setTab('sector'); setQ(''); }}><Icon name="layers" size={14} /> Setor</button>
            <button role="tab" aria-selected={tab === 'structure'} className={`seg__btn ${tab === 'structure' ? 'seg__btn--on is-on' : ''}`} onClick={() => { setTab('structure'); setQ(''); }}><Icon name="temple" size={14} /> Construção</button>
          </div>
        )}
        <label className="movetray__search"><Icon name="search" size={14} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'sector' ? 'Buscar setor' : 'Buscar construção'} aria-label={tab === 'sector' ? 'Buscar setor' : 'Buscar construção'} />
        </label>
        {tab === 'sector' && coord ? (
          <p className="hint">O Coordenador é o cargo fixo: o setor dele não muda. Ele pode mudar de construção.</p>
        ) : (
          <div className="movetray__list" role="listbox" aria-label={tab === 'sector' ? 'Setores' : 'Construções'}>
            {tab === 'sector' && sectors.data?.items.map((s) => {
              const here = agent?.sector_key === s.key;
              return (
                <button key={s.key} role="option" aria-selected={here} className={`dest ${here ? 'dest--here' : ''}`} disabled={here}
                  onClick={() => onPick({ kind: 'sector', key: s.key, name: s.name })}>
                  <span className="dest__icon"><Icon name="layers" size={16} /></span>
                  <span className="dest__body"><b>{s.name}</b><small>{here ? 'setor atual' : `${s.count} agente${s.count === 1 ? '' : 's'}`}{s.description ? ` · ${s.description}` : ''}</small></span>
                </button>
              );
            })}
            {tab === 'structure' && structures.data?.items.map((b) => {
              const here = agent?.building_id === b.id; const full = b.free === 0;
              return (
                <div key={b.id} className={`dest ${here ? 'dest--here' : ''} ${full ? 'dest--full' : ''}`}>
                  <button className="dest__main" disabled={here || full} aria-label={`${b.name}${here ? ' (atual)' : full ? ' (cheia)' : ''}`} onClick={() => onPick({ kind: 'structure', id: b.id, name: b.name })}>
                    <span className="dest__icon"><Icon name="temple" size={16} /></span>
                    <span className="dest__body"><b>{b.name}</b>
                      <small>{b.kind_name} · lote {b.i},{b.j} · {here ? 'endereço atual' : full ? `cheia (${b.active} de ${b.slots})` : `${b.free} lugar${b.free === 1 ? '' : 'es'} livre${b.free === 1 ? '' : 's'}`}</small></span>
                  </button>
                  {full && !here && b.can_grow && (
                    <button className="btn btn--sm" onClick={() => onPick({ kind: 'structure', id: b.id, name: b.name, addFloor: true })}><Icon name="plus" size={13} /> Adicionar andar e {agent ? 'mover' : 'usar'}</button>
                  )}
                </div>
              );
            })}
            {page.data && !page.data.items.length && <p className="hint">Nada encontrado{dq ? ` para “${dq}”` : ''}.</p>}
            {page.error && <p className="error">{page.error}</p>}
          </div>
        )}
        {(page.prev || page.next) && !(tab === 'sector' && coord) && (
          <footer className="movetray__pages">
            <button className="btn btn--sm btn--ghost" onClick={() => page.prev?.()} hidden={!page.prev}><Icon name="chevron" size={13} /> Anteriores</button>
            <span className="muted small">{page.data?.total ?? 0} {tab === 'sector' ? 'setores' : 'construções'}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => page.next?.()} hidden={!page.next}>Próximas <Icon name="chevron" size={13} /></button>
          </footer>
        )}
      </section>
    </div>
  );
}
