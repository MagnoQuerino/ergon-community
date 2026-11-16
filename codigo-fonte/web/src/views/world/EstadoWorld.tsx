import { useResource } from '../../lib/live.ts';
import { Icon } from '../../components/Icon.tsx';
import { ErgonMarca } from '../../brand/Brand.tsx';
import { fmtData, fmtDracmas, fmtHora, useIdioma } from '../../i18n/index.ts';
import { useTw, type ChaveWorld } from './textos.ts';
import { comPlano, ehCortesia, nivelDe, nomeDoPlano } from './compra-rapida.ts';
import { useWorldVivo } from './vivo.ts';

interface Pool { available: true; slots: number; running: number; starting: number }
interface Unavailable { available: false; last: Pool | null }
interface Consumo { available: boolean; spent: { ai: string; jobs: string; other: string }; nextMonthlyAt: string | null; jobs: { total: number } | null }
interface Sync { enabled: boolean; lastSyncAt?: string | null }
interface Device { status: string }
interface Policy { available: boolean; recovery: boolean; rounds?: number }
interface Recentes { items: Array<{ ref: string; title: string | null; outcome: string; recovered: boolean; at: string }> }

// i18n-ok: o fuso de Salvador (o dos créditos), não é texto de tela
const dia = (iso: string | null | undefined) => (iso ? fmtData(iso, { dateStyle: 'short', timeZone: 'America/Bahia' }) : '');
const dr = (v: string | number | undefined) => fmtDracmas(Math.round(Number(v ?? 0) * 100) / 100);
const hoje = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const RES: Record<string, Extract<ChaveWorld, `estado.resultado.${string}`>> = { concluido: 'estado.resultado.concluido', falhou: 'estado.resultado.falhou' };

/**
 * O Ergon World no Estado do Ergon (só no workspace ligado): o plano e a renovação (ou a cortesia), as pessoas, os
 * Jobs na nuvem, os Dracmas (saldo, gasto do mês entre Ergon AI e Jobs, a próxima franquia), o Sync, a recuperação e
 * os últimos resultados da nuvem. Tudo numa olhada; o detalhe fica na página do Ergon World.
 */
export default function EstadoWorld({ onGo }: { onGo?: () => void }) {
  const t = useTw();
  useIdioma();
  const { bound, bill, wallet } = useWorldVivo();
  const on = bound;
  const jobs = useResource<Pool | Unavailable>(on ? '/api/world/jobs' : null, []);
  const consumo = useResource<Consumo>(on ? '/api/world/consumo' : null, ['world.changed']);
  const sync = useResource<Sync>(on ? '/api/world/sync' : null, []);
  const devs = useResource<Device[]>(on ? '/api/world/devices' : null, []);
  const pol = useResource<Policy>(on ? '/api/world/job-policy' : null, []);
  const rec = useResource<Recentes>(on ? '/api/world/cards/recent' : null, ['routines.changed', 'tasks.changed']);
  if (!on) return null;
  const e = bill?.entitlement; const sub = bill?.subscription;
  const temPlano = !!bill && comPlano(bill);
  const nivel = temPlano ? nivelDe(e!.plan_sku, e!.tier) : null;
  const nome = nivel ? nomeDoPlano(nivel) : '';
  const plano = !bill ? '…' : !temPlano ? t('estado.semPlano')
    : ehCortesia(bill) ? (e!.effective_until ? t('estado.planoCortesia', { plano: nome, dia: dia(e!.effective_until) }) : t('estado.planoCortesiaSemFim', { plano: nome }))
      : sub?.cancelAt ? t('estado.planoAte', { plano: nome, dia: dia(sub.cancelAt) })
        : sub?.periodEnd ? t('estado.planoRenova', { plano: nome, dia: dia(sub.periodEnd) })
          : e!.effective_until ? t('estado.planoAte', { plano: nome, dia: dia(e!.effective_until) }) : t('estado.planoAtivo', { plano: nome });
  const p = jobs.data?.available ? jobs.data : jobs.data?.last ?? null;
  const c = consumo.data?.available ? consumo.data : null;
  const gasto = c ? Number(c.spent.ai) + Number(c.spent.jobs) + Number(c.spent.other) : null;
  const aparelhos = (devs.data ?? []).filter((d) => d.status === 'active').length;
  const s = sync.data;
  const itens = rec.data?.items.slice(0, 3) ?? [];
  return (
    <section className="block estado-world" aria-labelledby="estado-world-t">
      <h4 id="estado-world-t" className="estado-world__titulo"><ErgonMarca size={14} /> {t('selo.chamada')}</h4>
      <div className="kv estado-world__kv">
        <span>{t('estado.plano')}</span><b>{plano}</b>
        {temPlano && <><span>{t('estado.pessoas')}</span><b>{t('pagina.membro.pessoasValor', { usadas: bill!.seatsUsed, n: e!.people })}</b></>}
        {temPlano && <><span>{t('estado.jobs')}</span><b>{t('estado.jobsValor', { rodando: p ? p.running + p.starting : 0, vagas: p?.slots ?? e!.job_slots, mes: c?.jobs?.total ?? '—' })}</b></>}
        <span>{t('estado.dracmas')}</span>
        <b>{wallet ? dr(wallet.available) : '…'}
          {c && gasto !== null && <small className="estado-world__sub">{t('estado.gastoMes', { total: dr(gasto), ia: dr(c.spent.ai), jobs: dr(c.spent.jobs) })}</small>}
          {c?.nextMonthlyAt && <small className="estado-world__sub">{t('estado.franquia', { dia: dia(c.nextMonthlyAt) })}</small>}
        </b>
        {s && <><span>{t('estado.sync')}</span><b>{!s.enabled ? t('estado.syncDesligada')
          : s.lastSyncAt ? t('estado.syncLigada', { quando: hoje(s.lastSyncAt) ? fmtHora(s.lastSyncAt) : dia(s.lastSyncAt), aparelhos: t('estado.aparelhos', { n: aparelhos }) })
            : t('estado.syncLigadaSemData', { aparelhos: t('estado.aparelhos', { n: aparelhos }) })}</b></>}
        {pol.data?.available && <><span>{t('estado.recuperacao')}</span><b>{pol.data.recovery ? t('estado.recuperacaoLigada', { n: pol.data.rounds ?? 3 }) : t('estado.recuperacaoDesligada')}</b></>}
      </div>
      {itens.length > 0 && (
        <>
          <p className="estado-world__rot">{t('estado.resultados')}</p>
          <ul className="estado-world__res">
            {itens.map((x, i) => (
              <li key={`${x.ref}-${i}`}>
                <span className={`estado-world__ponto estado-world__ponto--${x.outcome === 'falhou' ? 'falhou' : 'ok'}`} aria-hidden="true" />
                <span className="estado-world__nome">{x.title ?? t('estado.semNome')}</span>
                <small className="muted">{x.recovered && x.outcome !== 'falhou' ? t('estado.resultado.recuperado') : RES[x.outcome] ? t(RES[x.outcome]) : x.outcome} · {hoje(x.at) ? fmtHora(x.at) : dia(x.at)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {(consumo.data && !consumo.data.available && (consumo.data as { reason?: string }).reason === 'offline') && <p className="hint warn">{t('estado.semConexao')}</p>}
      <a className="btn btn--sm btn--ghost estado-world__abrir" href="#world" onClick={() => onGo?.()}><Icon name="globe" size={14} /> {t('estado.abrir')}</a>
    </section>
  );
}
