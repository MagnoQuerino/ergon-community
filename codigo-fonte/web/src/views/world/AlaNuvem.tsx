import { useResource } from '../../lib/live.ts';
import { fmtHora } from '../../i18n/index.ts';
import { useTw, type ChaveWorld } from './textos.ts';

interface Status { configured: boolean; link: { currentIsBound: boolean } | null }
interface Pool {
  available: true; fetchedAt: string; stale: boolean; slots: number; reserved: number; running: number; starting: number; stopping: number;
  queued: number; waitingBalance: number; mine: Array<{ id: string; state: string; routineRef: string; since: string }>;
}
interface Unavailable { available: false; reason: string; message: string; last: Pool | null }

const STATE: Record<string, Extract<ChaveWorld, `nuvem.estado.${string}`>> = {
  executando: 'nuvem.estado.executando', iniciando: 'nuvem.estado.iniciando', parando: 'nuvem.estado.parando', na_fila: 'nuvem.estado.naFila', sem_saldo: 'nuvem.estado.semSaldo',
};
const hora = (iso: string) => fmtHora(iso);

/**
 * Ala "Na nuvem" da Central de Trabalho: os Jobs do workspace no World, com a capacidade do plano. Só no workspace
 * ligado ao Ergon World; é outro pool, nunca somado às vagas deste computador. World fora do ar aparece como
 * indisponível, com a última leitura — nunca como zero.
 */
export default function AlaNuvem() {
  const t = useTw();
  const st = useResource<Status>('/api/world/status', []);
  const on = !!st.data?.configured && !!st.data?.link?.currentIsBound;
  const jobs = useResource<Pool | Unavailable>(on ? '/api/world/jobs' : null, []);
  if (!on) return null;
  const d = jobs.data;
  const p = d?.available ? d : d?.last ?? null;
  return (
    <section className="ala-nuvem" aria-label={t('nuvem.aria')}>
      <h3 className="central__sub">{t('nuvem.titulo')}</h3>
      {!d ? <p className="muted small">{t('nuvem.lendo')}</p> : (
        <>
          {!d.available && <p className="hint warn" role="status">{d.message}{d.last ? ` ${t('nuvem.ultimaLeitura', { hora: hora(d.last.fetchedAt) })}` : ''}</p>}
          {p && (
            <div className="postos">
              <div className="postos__txt">
                <b>{t('nuvem.vagas', { reservadas: p.reserved, total: p.slots })}</b>
                <span className="muted small">
                  {[p.running && t('nuvem.executando', { n: p.running }), p.starting && t('nuvem.iniciando', { n: p.starting }), p.stopping && t('nuvem.parando', { n: p.stopping }),
                    p.queued && t('nuvem.naFila', { n: p.queued }), p.waitingBalance && t('nuvem.esperandoSaldo', { n: p.waitingBalance })].filter(Boolean).join(' · ') || t('nuvem.nenhum')}
                  {` · ${t('nuvem.atualizado', { hora: hora(p.fetchedAt) })}`}
                </span>
              </div>
            </div>
          )}
          {p && p.mine.length > 0 && (
            <ul className="op-list">
              {p.mine.map((j) => (
                <li key={j.id}><div className="op-row op-row--static"><span className="op-row__txt"><span className="op-row__title">{j.routineRef}</span><span className="op-row__why">{STATE[j.state] ? t(STATE[j.state]) : j.state}</span></span></div></li>
              ))}
            </ul>
          )}
          <p className="muted small">{t('nuvem.rodape')}</p>
        </>
      )}
    </section>
  );
}
