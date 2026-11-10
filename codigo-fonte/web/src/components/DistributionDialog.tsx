import { useEffect, useRef, useState } from 'react';
import { fmtNumero, tn, useT } from '../i18n/index.ts';
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
  const t = useT();
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
      if ((e as ApiError).code === 'plan_changed') { setErr(t('equipe.distrib.mudou')); load(); }
      else setErr(errMsg(e));
      setBusy(false);
    }
  };
  const moves = plan ? (all ? plan.moves : plan.moves.slice(0, SHOWN)) : [];
  return (
    <div className="dlg-back">
      <section ref={ref} className="dlg distrib" role="dialog" aria-modal="true" aria-labelledby="distrib-t">
        <header className="dlg__head">
          <h3 id="distrib-t">{t('equipe.distrib.titulo')}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('equipe.novo.fechar')}><Icon name="x" /></button>
        </header>
        <p className="muted small">{t('equipe.distrib.intro')}</p>
        {!plan && !err && <p className="hint">{t('equipe.distrib.calculando')}</p>}
        {plan && plan.total === 0 && (plan.blocked.length
          ? <p className="hint">{t('equipe.distrib.semLugar')}</p>
          : <p className="ok">{t('equipe.distrib.jaDistribuida')}</p>)}
        {plan && plan.total > 0 && (
          <>
            <p className="distrib__total">{tn('equipe.distrib.total', { n: plan.total, qtd: <b>{fmtNumero(plan.total)}</b> })}</p>
            <div className="distrib__cols">
              <div>
                <h4>{t('equipe.distrib.construcoes')}</h4>
                <ul className="distrib__list">
                  {plan.structures.map((b) => <li key={b.id}><span>{b.name}</span><span className="muted">{tn('equipe.distrib.antesDepois', { antes: b.before, depois: <b>{b.after}</b>, lugares: b.slots })}</span></li>)}
                </ul>
              </div>
              <div>
                <h4>{t('equipe.distrib.quemMuda')}</h4>
                <ul className="distrib__list">
                  {moves.map((m) => <li key={m.agentId}><span><b>{m.name}</b> <span className="muted small">· {m.sector}</span></span><span className="muted small">{m.fromName} → {m.toName}</span></li>)}
                </ul>
                {plan.moves.length > SHOWN && !all && <button className="linkish" onClick={() => setAll(true)}>{t('equipe.distrib.verMais', { n: plan.moves.length - SHOWN })}</button>}
                {plan.total > plan.moves.length && <p className="hint">{t('equipe.distrib.eMais', { n: plan.total - plan.moves.length, mostrados: fmtNumero(plan.moves.length) })}</p>}
              </div>
            </div>
          </>
        )}
        {plan && plan.blocked.length > 0 && (
          <div className="distrib__blocked">
            <h4>{t('equipe.distrib.impedimentos')}</h4>
            <ul>{plan.blocked.map((x) => <li key={x.sector}>{t('equipe.distrib.naoCabe', { n: x.waiting, setor: x.sector, casa: x.home })}</li>)}</ul>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <footer className="dlg__foot">
          <button className="btn btn--ghost" onClick={onClose}>{plan?.total ? t('equipe.distrib.agoraNao') : t('equipe.distrib.fechar')}</button>
          {!!plan?.total && <button className="btn btn--primary" onClick={() => void apply()} aria-busy={busy}><Icon name="check" size={14} /> {busy ? t('equipe.distrib.aplicando') : t('equipe.distrib.aplicar', { n: plan.total })}</button>}
        </footer>
      </section>
    </div>
  );
}
