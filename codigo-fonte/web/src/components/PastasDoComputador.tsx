import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { api, errMsg } from '../lib/api.ts';
import { EVENTO_PASTA_ESCOLHIDA, PEDIDO_ESCOLHER_PASTA, pastasInDesktopApp } from '../lib/desktop.ts';
import { useResource } from '../lib/live.ts';
import { Icon } from './Icon.tsx';

/** GET /api/pastas (server/src/services/pastas.ts) */
interface TelaPastas { disponivel: boolean; pastas: Array<{ id: string; caminho: string; nome: string; noMotor: string; modo: 'rw' | 'ro'; desde: string; montada: boolean }> }

/**
 * Conexões › Pastas do computador (rc.42): a pasta escolhida (pelo seletor do Ergon Desktop ou digitada) é concedida ao
 * motor da equipe, só ela; revogar tira. O selo diz se ela já está montada ("a caminho" até o motor ser refeito, num
 * momento sem trabalho em andamento). Na nuvem não aparece.
 */
export function PastasDoComputador() {
  const t = useT();
  const r = useResource<TelaPastas>('/api/pastas', ['pastas.changed']);
  const [caminho, setCaminho] = useState('');
  const [modo, setModo] = useState<'rw' | 'ro'>('rw');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const noApp = pastasInDesktopApp();
  useEffect(() => {
    if (!noApp) return;
    const on = (e: Event) => { const p = (e as CustomEvent).detail?.pasta; if (typeof p === 'string' && p.trim()) setCaminho(p.trim().slice(0, 1000)); };
    window.addEventListener(EVENTO_PASTA_ESCOLHIDA, on);
    return () => window.removeEventListener(EVENTO_PASTA_ESCOLHIDA, on);
  }, [noApp]);
  if (r.data && !r.data.disponivel) return null;
  const conceder = async () => {
    if (!caminho.trim() || ocupado) return;
    setOcupado('nova'); setErr(null);
    try { await api.post('/api/pastas', { caminho: caminho.trim(), modo }); setCaminho(''); r.reload(); } catch (e) { setErr(errMsg(e)); } finally { setOcupado(null); }
  };
  const revogar = async (id: string) => {
    setOcupado(id); setErr(null);
    try { await api.del(`/api/pastas/${id}`); r.reload(); } catch (e) { setErr(errMsg(e)); } finally { setOcupado(null); }
  };
  return (
    <section className="conn-group" id="conn-pastas">
      <h3>{t('conexoes.pastas.titulo')}</h3>
      {!!r.data?.pastas.length && (
        <ul className="pastas">
          {r.data.pastas.map((p) => (
            <li key={p.id} className="pastas__item">
              <Icon name="folder" size={16} />
              <span className="pastas__txt"><b>{p.caminho}</b><span className="muted small"> · {p.noMotor} · {p.modo === 'ro' ? t('conexoes.pastas.soLeitura') : t('conexoes.pastas.leituraEscrita')}</span></span>
              <span className={`badge ${p.montada ? 'badge--ok' : 'badge--warn'}`}>{p.montada ? t('conexoes.pastas.montada') : t('conexoes.pastas.aCaminho')}</span>
              <button type="button" className="btn btn--sm" aria-busy={ocupado === p.id} onClick={() => void revogar(p.id)}>{ocupado === p.id ? t('conexoes.pastas.revogando') : t('conexoes.pastas.revogar')}</button>
            </li>
          ))}
        </ul>
      )}
      <form className="pastas__nova" onSubmit={(e) => { e.preventDefault(); void conceder(); }}>
        <label className="field pastas__campo"><span className="sr-only">{t('conexoes.pastas.caminho')}</span>
          <input value={caminho} onChange={(e) => setCaminho(e.target.value)} placeholder={t('conexoes.pastas.exemplo')} aria-label={t('conexoes.pastas.caminho')} maxLength={1000} /></label>
        {noApp && <button type="button" className="btn" onClick={() => { location.href = PEDIDO_ESCOLHER_PASTA; }}><Icon name="folder" size={14} /> {t('conexoes.pastas.escolher')}</button>}
        <select value={modo} onChange={(e) => setModo(e.target.value as 'rw' | 'ro')} aria-label={t('conexoes.pastas.modo')}>
          <option value="rw">{t('conexoes.pastas.leituraEscrita')}</option>
          <option value="ro">{t('conexoes.pastas.soLeitura')}</option>
        </select>
        <button type="submit" className="btn btn--primary" disabled={!caminho.trim()} aria-busy={ocupado === 'nova'}>{ocupado === 'nova' ? t('conexoes.pastas.concedendo') : t('conexoes.pastas.conceder')}</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}
