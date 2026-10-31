import { useEffect, useRef, useState } from 'react';
import { api, errMsg, type ApiError } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import { Icon } from './Icon.tsx';

interface Plan {
  planId: string; total: number;
  moves: Array<{ agentId: string; name: string; sector: string; from: string; fromName: string; to: string; toName: string }>;
  structures: Array<{ id: string; name: string; before: number; after: number; slots: number }>;
  blocked: Array<{ sector: string; home: string; waiting: number }>;
}
const SHOWN = 12;

/**
 * "Sugerir distribuição": uma regra local (sem IA, sem custo) junta colegas do mesmo setor na construção onde o setor
 * já é maioria, usando só lugares livres. Mostra antes/depois e os impedimentos; nada muda até a pessoa aplicar, e
 * aplicar é tudo ou nada. Só o endereço muda — setor, função e trabalho ficam.
 */
export function DistributionDialog({ onClose, onApplied }: { onClose: () => void; onApplied: (r: { batchId: string; moved: number }) => void }) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const load = () => { setErr(null); api.get<Plan>('/api/team/distribution').then(setPlan).catch((e) => setErr(errMsg(e))); };
  useEffect(load, []);
  const apply = async () => {
    if (!plan || busy) return;
    setBusy(true); setErr(null);
    try { onApplied(await api.post<{ batchId: string; moved: number }>('/api/team/distribution/apply', { planId: plan.planId })); }
    catch (e) {
      if ((e as ApiError).code === 'plan_changed') { setErr('A equipe mudou enquanto você olhava: esta é a sugestão atualizada.'); load(); }
      else setErr(errMsg(e));
      setBusy(false);
    }
  };
  const moves = plan ? (all ? plan.moves : plan.moves.slice(0, SHOWN)) : [];
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg distrib" role="dialog" aria-modal="true" aria-labelledby="distrib-t">
        <header className="dlg__head">
          <h3 id="distrib-t">Sugerir distribuição</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        <p className="muted small">Junta colegas do mesmo setor na construção onde o setor já é maioria, só com lugares livres. Só o endereço muda: setor, função e trabalhos ficam. Nada muda até você aplicar.</p>
        {!plan && !err && <p className="hint">Calculando…</p>}
        {plan && plan.total === 0 && (plan.blocked.length
          ? <p className="hint">Agora não há lugar livre para juntar ninguém. Veja abaixo onde falta espaço.</p>
          : <p className="ok">A equipe já está distribuída assim. Nada a mudar.</p>)}
        {plan && plan.total > 0 && (
          <>
            <p className="distrib__total"><b>{plan.total}</b> agente{plan.total === 1 ? '' : 's'} mudaria{plan.total === 1 ? '' : 'm'} de endereço.</p>
            <div className="distrib__cols">
              <div>
                <h4>Construções (antes → depois)</h4>
                <ul className="distrib__list">
                  {plan.structures.map((b) => <li key={b.id}><span>{b.name}</span><span className="muted">{b.before} → <b>{b.after}</b> de {b.slots}</span></li>)}
                </ul>
              </div>
              <div>
                <h4>Quem muda</h4>
                <ul className="distrib__list">
                  {moves.map((m) => <li key={m.agentId}><span><b>{m.name}</b> <span className="muted small">· {m.sector}</span></span><span className="muted small">{m.fromName} → {m.toName}</span></li>)}
                </ul>
                {plan.moves.length > SHOWN && !all && <button className="linkish" onClick={() => setAll(true)}>Ver mais ({plan.moves.length - SHOWN})</button>}
                {plan.total > plan.moves.length && <p className="hint">E mais {plan.total - plan.moves.length} — a lista mostra os primeiros {plan.moves.length}.</p>}
              </div>
            </div>
          </>
        )}
        {plan && plan.blocked.length > 0 && (
          <div className="distrib__blocked">
            <h4>Impedimentos</h4>
            <ul>{plan.blocked.map((x) => <li key={x.sector}>{x.sector}: {x.waiting} não cabe{x.waiting === 1 ? '' : 'm'} em {x.home} (sem lugar livre). Para juntar mais gente, adicione andares ou construções.</li>)}</ul>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <footer className="dlg__foot">
          <button className="btn btn--ghost" onClick={onClose}>{plan?.total ? 'Agora não' : 'Fechar'}</button>
          {!!plan?.total && <button className="btn btn--primary" onClick={() => void apply()} aria-busy={busy}><Icon name="check" size={14} /> {busy ? 'Aplicando…' : `Aplicar (${plan.total})`}</button>}
        </footer>
      </section>
    </div>
  );
}
