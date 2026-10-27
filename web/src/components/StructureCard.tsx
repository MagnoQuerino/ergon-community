import { useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import type { Agent, Structure } from '../lib/types.ts';
import type { SceneFocus } from '../scene/types.ts';
import { Icon } from './Icon.tsx';
import { typeOf } from '../../../shared/city.ts';

/** Cartão da estrutura escolhida: andares (abrir um andar), ocupação, adicionar andar e remover (versão local: grátis). */
export function StructureCard({ s, focus, agents, onClose, onOpenFloor, onCloseBuilding, onChanged, onError }: {
  s: Structure; focus: SceneFocus | null; agents: Agent[]; onClose: () => void; onOpenFloor: (level: number) => void; onCloseBuilding: () => void;
  onChanged: (msg?: string) => void; onError: (msg: string) => void;
}) {
  const t = typeOf(s.kind);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const work = t?.category === 'trabalho';
  const open = focus?.building === s.id ? focus.level : null;
  const active = s.floors.reduce((n, f) => n + f.active, 0);
  const canAdd = work && t && s.floors.length < t.floors.max;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await fn(); onChanged(msg); } catch (e) { onError(errMsg(e)); } finally { setBusy(false); setConfirmDel(false); }
  };
  return (
    <aside className="scard" aria-label={`Estrutura: ${s.name}`}>
      <header className="scard__head">
        <div>
          <h3>{s.name}</h3>
          <span className="muted">{t?.common ?? s.kind}{t && t.name !== s.name ? ` · ${t.name}` : ''}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar"><Icon name="x" /></button>
      </header>
      {t && <p className="scard__desc">{t.description}</p>}
      {work && (
        <>
          <ul className="scard__floors">
            {[...s.floors].reverse().map((f) => {
              const who = agents.filter((a) => a.status === 'active' && a.floor_id === f.id);
              return (
                <li key={f.id}>
                  <button className={`scard__floor ${open === f.level ? 'scard__floor--on' : ''}`} onClick={() => (open === f.level ? onCloseBuilding() : onOpenFloor(f.level))} title={open === f.level ? 'Fechar o prédio' : 'Abrir o prédio neste andar'}>
                    <span>{f.name}</span>
                    <span className="slots" aria-label={`${f.active} de ${f.slots} vagas`}>{Array.from({ length: f.slots }, (_, i) => <span key={i} className={`slot slot--sm ${i < f.active ? 'slot--on' : ''}`} />)}</span>
                    <span className="muted small">{who.slice(0, 3).map((a) => a.name).join(', ')}{who.length > 3 ? '…' : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="row row--wrap">
            {canAdd && <button className="btn btn--sm" disabled={busy} onClick={() => run(() => api.post(`/api/structures/${s.id}/floors`), `Andar adicionado: +${t!.slotsPerFloor} vagas (versão local, grátis).`)}><Icon name="plus" size={13} /> Andar (+{t!.slotsPerFloor} vagas)</button>}
            {!canAdd && t && <span className="hint">{t.name} comporta até {t.floors.max} andar{t.floors.max > 1 ? 'es' : ''}. Para mais agentes, construa num lote livre.</span>}
            {s.origin === 'local' && (confirmDel ? (
              <span className="confirm">Remover {s.name}? <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => run(() => api.del(`/api/structures/${s.id}`), `${s.name} removida.`)}>Remover</button><button className="btn btn--sm" onClick={() => setConfirmDel(false)}>Cancelar</button></span>
            ) : (
              <button className="btn btn--sm btn--ghost" disabled={busy || active > 0} title={active ? 'Há agentes aqui: desative ou mude-os de construção antes' : 'Remover esta estrutura'} onClick={() => setConfirmDel(true)}><Icon name="trash" size={13} /> Remover</button>
            ))}
          </div>
        </>
      )}
      {!work && <p className="hint">Use “Editar mapa” para mudar de lote. Ruas e decoração acompanham.</p>}
    </aside>
  );
}
