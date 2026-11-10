import { Suspense, lazy, useRef, useState, type ComponentType } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { cloudOn, elapsed, OPS_URL, type AmbientOps, type Distribution, type OpsCategory, type OpsItem } from '../lib/ambient.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation, openDecisions } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { Icon } from './Icon.tsx';
import { fmtHora, fmtNumero, tn, useT, type Chave } from '../i18n/index.ts';

/** Ala da nuvem (só na edição com o World; a Community não traz o arquivo e a ala simplesmente não aparece). */
const nuvemMod = Object.values(import.meta.glob<{ default: ComponentType }>('../views/world/AlaNuvem.tsx'))[0];
const AlaNuvem = nuvemMod ? lazy(nuvemMod) : null;

export type CentralSection = 'trabalho' | 'espera' | 'voce' | 'entregas';
const SECTION_LABEL = { trabalho: 'cidade.central.secao.trabalho', espera: 'cidade.central.secao.espera', voce: 'cidade.central.secao.voce', entregas: 'cidade.central.secao.entregas' } as const satisfies Record<CentralSection, Chave>;
const SECTION_TITLE = { trabalho: 'cidade.central.secaoDica.trabalho', espera: 'cidade.central.secaoDica.espera', voce: 'cidade.central.secaoDica.voce', entregas: 'cidade.central.secaoDica.entregas' } as const satisfies Record<CentralSection, Chave>;

/**
 * Central de Trabalho: o que a equipe está fazendo, o que espera e por quê, o que precisa de você e o que ficou
 * pronto — a mesma leitura das placas da cidade, em lista (teclado e leitor de tela). Cada linha abre o card de
 * sempre, onde estão priorizar, responder, parar e cancelar. Nada aqui executa trabalho por conta própria.
 */
export function CentralTrabalho({ ops, error, section, onSection, onClose, onBoard, onFiles, embedded }: {
  ops: AmbientOps | null; error: string | null; section: CentralSection; onSection: (s: CentralSection) => void;
  onClose?: () => void; onBoard: () => void; onFiles: () => void; embedded?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: () => onClose?.(), active: !embedded && !!onClose, autoFocus: !embedded });

  return (
    <aside ref={ref} className={`central ${embedded ? 'central--embedded' : ''}`} aria-labelledby="central-titulo">
      <header className="central__head">
        <h2 id="central-titulo" className="central__title"><Icon name="layers" size={17} /> {t('cidade.central.titulo')}</h2>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label={t('cidade.central.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button>}
      </header>
      <nav className="central__tabs" role="tablist" aria-label={t('cidade.central.partes')}>
        {(Object.keys(SECTION_LABEL) as CentralSection[]).map((k) => (
          <button key={k} role="tab" aria-selected={section === k} className={`central__tab ${section === k ? 'is-on' : ''}`} onClick={() => onSection(k)} title={t(SECTION_TITLE[k])}>
            {t(SECTION_LABEL[k])}{ops ? <span className="central__n">{countOf(ops, k)}</span> : null}
          </button>
        ))}
      </nav>
      <div className="central__body" role="tabpanel" aria-label={t(SECTION_TITLE[section])}>
        {!ops ? (error ? <p className="error" role="alert">{t('cidade.central.erro', { erro: error })}</p>
          : <p className="muted">{t('cidade.central.lendo')}</p>) : <>
          {error && <p className="hint warn" role="status">{t('cidade.central.semAtualizacao', { erro: error, hora: fmtHora(ops.at) })}</p>}
          {section === 'trabalho' && <Trabalho ops={ops} onBoard={onBoard} />}
          {section === 'espera' && <Espera ops={ops} />}
          {section === 'voce' && <Voce ops={ops} />}
          {section === 'entregas' && <Entregas ops={ops} onFiles={onFiles} />}
        </>}
      </div>
    </aside>
  );
}

function countOf(o: AmbientOps, k: CentralSection): number {
  if (k === 'trabalho') return o.totals.ativo;
  if (k === 'espera') return o.totals.pronto + o.totals.bloqueado + o.totals.impedido + o.totals.falhou;
  if (k === 'voce') return o.decisions.total;
  return o.deliveries.total;
}

/** Postos de trabalho: um por vaga, até 12; acima disso, o número. */
function Postos({ busy, limit }: { busy: number; limit: number | null }) {
  const t = useT();
  const shown = limit !== null && limit <= 12;
  return (
    <div className="postos">
      <div className="postos__txt">
        <b>{limit === null ? t('cidade.central.postos.emAndamento', { n: busy }) : t('cidade.central.postos.ocupadas', { ocupadas: fmtNumero(busy), limite: fmtNumero(limit) })}</b>
        <span className="muted small">{limit === null ? t('cidade.central.postos.aquiSemTeto') : t('cidade.central.postos.aqui')}</span>
      </div>
      {shown && (
        <div className="postos__pips" aria-hidden="true">
          {Array.from({ length: limit! }, (_, i) => <span key={i} className={`posto ${i < busy ? 'posto--on' : ''}`} />)}
        </div>
      )}
    </div>
  );
}

/** Uma linha: o retrato vem no próprio item (o agente leve do servidor), sem a lista da equipe. */
function Linha({ it }: { it: OpsItem }) {
  const t = useT();
  const ag = it.agent;
  const go = () => { if (it.taskId) openCard(it.taskId); else if (it.actions.includes('conversa') && it.agentId) openConversation(it.agentId, null); };
  const clickable = !!it.taskId || it.actions.includes('conversa');
  const body = (
    <>
      {ag ? <AgentAvatar agent={ag} size={30} /> : <span className="avatar avatar--sm" aria-hidden="true">?</span>}
      <span className="op-row__txt">
        <span className="op-row__title" title={it.title}>{it.number ? <span className="muted">#{it.number} </span> : null}{it.title}</span>
        <span className="op-row__why">{it.reason}{it.since ? <span className="muted"> · {elapsed(it.since)}</span> : null}</span>
        {(it.priority || it.simulated) && (
          <span className="op-row__tags">
            {it.priority && <span className="badge">{t('cidade.central.prioridade')}</span>}
            {it.simulated && <span className="badge badge--warn">{t('cidade.central.semIa')}</span>}
          </span>
        )}
      </span>
    </>
  );
  return clickable
    ? <li><button className="op-row" onClick={go} title={it.taskId ? t('cidade.central.abrirCard') : t('cidade.central.abrirConversa')}>{body}</button></li>
    : <li><div className="op-row op-row--static">{body}</div></li>;
}

/** Lista de uma categoria, com "ver mais" (pede a página seguinte ao servidor; os totais não mudam). */
function Lista({ ops, cat, empty }: { ops: AmbientOps; cat: OpsCategory; empty?: string }) {
  const t = useT();
  const [extra, setExtra] = useState<OpsItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = [...ops.items[cat], ...extra.filter((x) => !ops.items[cat].some((y) => y.key === x.key))];
  const left = ops.totals[cat] - items.length;
  const more = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.get<AmbientOps>(`${OPS_URL}?category=${cat}&offset=${items.length}&limit=50`); setExtra((e) => [...e, ...r.items[cat]]); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (!ops.totals[cat]) return empty ? <p className="muted small">{empty}</p> : null;
  return (
    <>
      <ul className="op-list">{items.map((it) => <Linha key={it.key} it={it} />)}</ul>
      {left > 0 && <button className="link" disabled={busy} onClick={() => void more()}>{busy ? t('geral.comum.carregando') : t('cidade.central.verMais', { n: left })}</button>}
      {err && <p className="error small" role="alert">{err}</p>}
    </>
  );
}

function Trabalho({ ops, onBoard }: { ops: AmbientOps; onBoard: () => void }) {
  const t = useT();
  return (
    <>
      <Postos busy={ops.local.busy} limit={ops.local.limit} />
      {ops.local.mode === 'simulated' && <p className="hint">{t('cidade.central.semIaAviso')}</p>}
      {ops.local.conversations > 0 && <p className="muted small">{t('cidade.central.conversas', { n: ops.local.conversations })}</p>}
      <h3 className="central__sub">{t('cidade.central.emAndamento')}</h3>
      <Lista ops={ops} cat="ativo" empty={t('cidade.central.nadaEmExecucao')} />
      <Nuvem />
      <p className="central__foot"><button className="link" onClick={onBoard}>{t('cidade.central.abrirQuadro')}</button><br />{t('cidade.central.quantosAoMesmoTempo')}</p>
    </>
  );
}

/**
 * Ala da nuvem: com o trabalho na nuvem ligado, a leitura dos Jobs (edição com o World); sem ele, o posto aparece
 * coberto com lona — está lá, reservado, mas sem uso nesta versão (nada para clicar, nada prometido).
 */
function Nuvem() {
  const t = useT();
  const d = useResource<Distribution>('/api/distribution', []);
  if (!d.data) return null;
  if (cloudOn(d.data) && AlaNuvem) return <Suspense fallback={null}><AlaNuvem /></Suspense>;
  return (
    <div className="nuvem-coberta" aria-label={t('cidade.central.nuvemAria')}>
      <span className="nuvem-coberta__lona" aria-hidden="true" />
      <span className="nuvem-coberta__txt"><b>{t('cidade.central.nuvem')}</b><span className="muted small">{t('cidade.central.nuvemTexto')}</span></span>
    </div>
  );
}

function Espera({ ops }: { ops: AmbientOps }) {
  const t = useT();
  const nada = !ops.totals.pronto && !ops.totals.bloqueado && !ops.totals.impedido && !ops.totals.falhou;
  return (
    <>
      {nada && <p className="muted small">{t('cidade.central.nadaEsperando')}</p>}
      {ops.totals.pronto > 0 && <>
        <h3 className="central__sub">{t('cidade.central.prontos')} <span className="muted">{ops.totals.pronto}</span></h3>
        <p className="muted small">{t('cidade.central.prontosExplica')}</p>
        <Lista ops={ops} cat="pronto" /* i18n-ok: a categoria da API, não é texto */ />
      </>}
      {ops.totals.bloqueado > 0 && <><h3 className="central__sub">{t('cidade.central.esperandoOutro')} <span className="muted">{ops.totals.bloqueado}</span></h3><Lista ops={ops} cat="bloqueado" /></>}
      {ops.totals.impedido > 0 && <><h3 className="central__sub">{t('cidade.central.parados')} <span className="muted">{ops.totals.impedido}</span></h3><Lista ops={ops} cat="impedido" /></>}
      {/* i18n-ok: a categoria da API (cat="falhou"), não é texto */}
      {ops.totals.falhou > 0 && <><h3 className="central__sub">{t('cidade.central.falharam')} <span className="muted">{ops.totals.falhou}</span></h3><Lista ops={ops} cat="falhou" /></>}
    </>
  );
}

function Voce({ ops }: { ops: AmbientOps }) {
  const t = useT();
  return (
    <>
      <div className="central__cta">
        <span>{tn('cidade.central.decisoes', { n: ops.decisions.total, qtd: <b>{fmtNumero(ops.decisions.total)}</b> })}</span>
        {ops.decisions.total > 0 && <button className="btn btn--primary btn--sm" onClick={openDecisions} title={t('cidade.central.responderDica')}>{t('cidade.central.responder')}</button>}
      </div>
      {ops.totals.precisa_de_voce > 0 && <>
        <h3 className="central__sub">{t('cidade.central.paradosEsperandoVoce')} <span className="muted">{ops.totals.precisa_de_voce}</span></h3>
        <Lista ops={ops} cat="precisa_de_voce" />
      </>}
      {!ops.decisions.total && !ops.totals.precisa_de_voce && <p className="muted small">{t('cidade.central.nadaParaDecidir')}</p>}
    </>
  );
}

function Entregas({ ops, onFiles }: { ops: AmbientOps; onFiles: () => void }) {
  const t = useT();
  const d = ops.deliveries;
  return (
    <>
      <p className="muted small">{t('cidade.central.concluidos', { n: d.days, total: fmtNumero(d.total) })}</p>
      {!d.items.length ? <p className="muted small">{t('cidade.central.nenhumaEntrega', { n: d.days })}</p> : (
        <ul className="op-list">
          {d.items.map((e) => (
            <li key={e.taskId}>
              <button className="op-row" onClick={() => openCard(e.taskId)} title={t('cidade.central.abrirEntrega')}>
                <span className="op-row__ico" aria-hidden="true"><Icon name={e.deliverables ? 'folder' : 'check'} size={16} /></span>
                <span className="op-row__txt">
                  <span className="op-row__title" title={e.title}><span className="muted">#{e.number} </span>{e.title}</span>
                  <span className="op-row__why">{e.by === 'human' ? t('cidade.central.porVoce') : e.by === 'external' ? t('cidade.central.noOutroApp') : e.agentName ? t('cidade.central.entreguePor', { nome: e.agentName }) : t('cidade.central.entregue')}
                    {` · ${e.deliverables ? t('cidade.central.arquivos', { n: e.deliverables }) : t('cidade.central.respostaNoCard')}`}<span className="muted"> · {elapsed(e.completedAt)}</span></span>
                  {e.simulated && <span className="op-row__tags"><span className="badge badge--warn">{t('cidade.central.semIa')}</span></span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {d.total > d.items.length && <p className="muted small">{t('cidade.central.maisRecentes', { n: d.items.length })}</p>}
      <p className="central__foot"><button className="link" onClick={onFiles}>{t('cidade.central.todosArquivos')}</button></p>
    </>
  );
}
