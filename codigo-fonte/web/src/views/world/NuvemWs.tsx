import { useState } from 'react';
import { api, errMsg, requestId } from '../../lib/api.ts';
import { useResource } from '../../lib/live.ts';
import { fmtData, fmtMoeda } from '../../i18n/index.ts';
import { useTw } from './textos.ts';

interface Nuvem {
  offered: boolean; active: boolean; forSale?: boolean; planActive?: boolean; owner?: boolean; source?: 'stripe' | 'cortesia' | 'teste' | null;
  until?: string | null; runtime?: 'parado' | 'dormindo' | 'rodando' | 'fila' | 'pausado' | null; diskUsedBytes?: string; diskQuotaBytes?: string;
  trialAvailable?: boolean; waitlisted?: boolean;
}
interface Preview { upgrade: boolean; prorationDate: number; amountDueCents: string }
const gb = (b?: string) => `${(Number(b ?? 0) / 1024 ** 3).toFixed(1)} GB`;

/**
 * "Subir o WS para o World": o adicional que põe o workspace para RODAR no World com os computadores desligados. Fica
 * escondido enquanto o World não oferece (a venda abre só com o executor pronto); quem já tem (cortesia) vê o estado.
 * Sempre deixa claro que não é a sincronia nem a colaboração.
 */
export default function NuvemWs() {
  const t = useTw();
  const r = useResource<Nuvem>('/api/world/cloud', []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pv, setPv] = useState<Preview | null>(null);
  const d = r.data;
  if (!d || (!d.offered && !d.active)) return null;
  const go = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); setPv(null); r.reload(); } catch (e) {
      const text = errMsg(e); setMsg({ kind: 'error', text: /lista de espera|waitlist/i.test(text) ? t('ws.espera') : text }); r.reload();
    } finally { setBusy(false); }
  };
  const contratar = async () => {
    if (!pv) { setBusy(true); setMsg(null); try { setPv(await api.post<Preview>('/api/world/billing/change/preview', { cloud: 1 })); } catch (e) { setMsg({ kind: 'error', text: /lista de espera|waitlist/i.test(errMsg(e)) ? t('ws.espera') : errMsg(e) }); } finally { setBusy(false); } return; }
    await go(() => api.post('/api/world/billing/change/confirm', { cloud: 1, prorationDate: pv.prorationDate, idempotencyKey: requestId() }), t('ws.feito'));
  };
  return (
    <section className="card">
      <h3>{t('ws.titulo')}</h3>
      <p>{t('ws.oque')}</p>
      <p className="muted small">{t('ws.diferenca')}</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {d.active ? (
        <>
          <p><b>{t('ws.ativo')}</b>{d.source ? ` · ${t(`ws.origem.${d.source}`)}` : ''}{d.until ? ` · ${t('ws.ate', { data: fmtData(d.until) })}` : ''}</p>
          {d.runtime && <p>{t(`ws.estado.${d.runtime}`)}</p>}
          <p className="muted small">{t('ws.disco', { usado: gb(d.diskUsedBytes), total: gb(d.diskQuotaBytes) })}</p>
        </>
      ) : (
        <>
          <p className="small">{t('ws.preco')}</p>
          {d.waitlisted && <p className="muted small" role="status">{t('ws.espera')}</p>}
          {!d.planActive ? <p className="muted small">{t('ws.precisaPlano')}</p> : !d.owner ? <p className="muted small">{t('ws.soDono')}</p> : (
            <p>
              {d.trialAvailable && <button className="btn btn--primary" disabled={busy} onClick={() => void go(() => api.post('/api/world/cloud/trial'), t('ws.feito'))}>{t('ws.testar')}</button>}{' '}
              {d.forSale && <button className="btn" disabled={busy} onClick={() => void contratar()}>{pv ? t('ws.confirmar', { valor: fmtMoeda(Number(pv.amountDueCents) / 100, 'BRL') }) : t('ws.contratar')}</button>}
            </p>
          )}
        </>
      )}
    </section>
  );
}
