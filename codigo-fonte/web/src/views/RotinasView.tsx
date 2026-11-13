import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, requestId } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { keepTyped, useSurface } from '../lib/surface.ts';
import type { ArtifactRow, CloudFile, EvidenceLevels, FileRef, InputSpec, Integration, ParamSpec, ParamValues, RecommendState, Routine, RoutineLibrary, RoutineRun, RoutineRunDetail, RoutineRunStatus, RoutineSetupState, RoutineTemplate, RoutineTrigger, View } from '../lib/types.ts';
import type { TeamAgent } from '../lib/teamData.ts';
import { Loading, PhraseLoader } from '../brand/Brand.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { useHashParam } from '../lib/route.ts';
import { alternarConta, contaMarcada, gruposDaRotina, nomeNaTela } from '../lib/contas.ts';
import { pushRecent } from '../lib/recents.ts';
import { cardClick } from '../lib/cardClick.ts';
import { fmtData, fmtLista, fmtNumero, t, tn, useIdioma, useT, type Chave } from '../i18n/index.ts';

/**
 * Rotinas: trabalhos que a equipe já sabe fazer. Biblioteca (o que dá para delegar), Minhas rotinas (o que está
 * ligado, quando roda, o que entregou) e Histórico (cada execução com resultado, dados coletados e entregáveis).
 * Nada de prompt nem de configuração técnica: escolher, ajustar o horário e, se quiser, pedir ajustes a quem coordena.
 */
type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null) => void;
type Tab = 'biblioteca' | 'minhas' | 'historico';
/** As chaves sem marcador: as das tabelas de rótulos abaixo (o texto é buscado na hora de mostrar, no idioma da tela). */
type Rotulo = { [K in Chave]: Parameters<typeof t<K>>['length'] extends 1 ? K : never }[Chave];

const DAYS = [0, 1, 2, 3, 4, 5, 6].map((i) => `rotinas.dia.${i}` as Rotulo);
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Sao_Paulo'; } })();
const STATUS: Record<RoutineRunStatus, { label: Rotulo; cls: string }> = {
  queued: { label: 'rotinas.status.queued', cls: 'badge--warn' }, gathering: { label: 'rotinas.status.gathering', cls: 'badge--warn' }, running: { label: 'rotinas.status.running', cls: 'badge--warn' },
  succeeded: { label: 'rotinas.status.succeeded', cls: 'badge--ok' }, skipped: { label: 'rotinas.status.skipped', cls: '' }, failed: { label: 'rotinas.status.failed', cls: 'badge--err' },
  cancelled: { label: 'rotinas.status.cancelled', cls: '' }, missed: { label: 'rotinas.status.missed', cls: 'badge--warn' },
};
const when = (iso: string | null) => (iso ? fmtData(iso, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) || '—' : '—');
const MODES: Record<string, Rotulo> = { manual: 'rotinas.modo.manual', schedule: 'rotinas.modo.schedule', event: 'rotinas.modo.event', condition: 'rotinas.modo.condition' };

const CONDITION: Record<string, Rotulo> = { sempre: 'rotinas.condicao.sempre', novidades: 'rotinas.condicao.novidades', sinal: 'rotinas.condicao.sinal' };
/** o rótulo da tabela, ou o valor como veio (um valor novo que a tela ainda não conhece) */
const rotulo = (tabela: Record<string, Rotulo>, k: string) => (tabela[k] ? t(tabela[k]) : k);
const opcional = (rotuloDoCampo: string, obrigatorio: boolean | undefined) => (obrigatorio ? rotuloDoCampo : t('rotinas.opcional', { rotulo: rotuloDoCampo }));

/** coord: quem coordena hoje (vem pronto no /api/state), para "Criar rotina com…" e os ajustes */
export function RotinasView({ coord, onOpenAgent, onGo }: { coord: { id: string; name: string } | null; onOpenAgent: OpenAgent; onGo: (v: View) => void }) {
  const t = useT();
  const lib = useResource<RoutineLibrary>('/api/routines/library', ['routines.changed', 'integrations.changed']);
  const mine = useResource<Routine[]>('/api/routines', ['routines.changed', 'runs.changed']);
  const [tab, setTab] = useState<Tab | null>(null);
  // rotina vinda da busca (#rotinas?rotina=…): abre "Minhas rotinas" e destaca o card dela
  const [focusId] = useHashParam('rotina');
  const shown: Tab = tab ?? (focusId || mine.data?.length ? 'minhas' : 'biblioteca');
  const createWithCoord = () => coord && onOpenAgent(coord.id, 'conversa', t('rotinas.rascunho.criar'));
  const [setup, setSetup] = useState<{ id: string; fresh: boolean } | null>(() => { const m = location.hash.match(/preparo=(rtn_[a-f0-9]{32})/); return m ? { id: m[1], fresh: false } : null; });
  const openSetup = (id: string, fresh = false) => { history.replaceState(null, '', `#rotinas?preparo=${id}`); setSetup({ id, fresh }); };
  const closeSetup = () => { history.replaceState(null, '', '#rotinas'); setSetup(null); setTab('minhas'); mine.reload(); };
  if (setup) return <RoutineSetup key={setup.id} id={setup.id} fresh={setup.fresh} onBack={closeSetup} onGo={onGo} />;
  const coordName = coord?.name ?? t('rotinas.coordenacao');
  const abas: Record<Tab, string> = {
    biblioteca: t('rotinas.abas.biblioteca'),
    minhas: mine.data?.length ? t('rotinas.abas.minhasN', { n: mine.data.length }) : t('rotinas.abas.minhas'),
    historico: t('rotinas.abas.historico'),
  };

  return (
    <div className="page rt-page">
      <header className="page__head rt-head">
        <div>
          <h2>{t('rotinas.titulo')}</h2>
          <p className="muted">{t('rotinas.cabeca.explica')}</p>
        </div>
        <button className="btn btn--primary" onClick={createWithCoord} disabled={!coord} title={coord ? t('rotinas.cabeca.criarDica', { nome: coord.name }) : t('rotinas.cabeca.criarSemCoord')}>
          <Icon name="chat" size={16} /> {t('rotinas.cabeca.criarCom', { nome: coordName })}
        </button>
      </header>
      <RecommendCard coordName={coordName} coordNameInicio={coord?.name ?? t('rotinas.coordenacaoInicio')} />
      <div className="tabs" role="tablist">
        {(['biblioteca', 'minhas', 'historico'] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={shown === k} className={`tab ${shown === k ? 'tab--on' : ''}`} onClick={() => setTab(k)}>
            {abas[k]}
          </button>
        ))}
      </div>
      {shown === 'biblioteca' && (lib.data ? <Library lib={lib.data} coordName={coordName} onGo={onGo} onInstalled={(id) => openSetup(id, true)} /> : <Loading error={lib.error} />)}
      {shown === 'minhas' && (mine.data ? <Mine list={mine.data} focusId={focusId} coord={coord ?? null} onOpenAgent={onOpenAgent} onSetup={(id) => openSetup(id)} reload={mine.reload} onLibrary={() => setTab('biblioteca')} /> : <Loading error={mine.error} />)}
      {shown === 'historico' && <History routines={mine.data ?? []} onOpenAgent={onOpenAgent} />}
    </div>
  );
}

/** Recomendação inteligente: escolha consciente (lê o trabalho do workspace e usa o modelo uma vez por semana). */
function RecommendCard({ coordName, coordNameInicio }: { coordName: string; coordNameInicio: string }) {
  const t = useT();
  const st = useResource<RecommendState>('/api/routines/recommend', ['routines.changed']);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const s = st.data;
  const toggle = async () => {
    if (!s) return;
    setBusy(true); setMsg(null);
    try { await api.put('/api/routines/recommend', { enabled: !s.enabled }); st.reload(); } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const analyze = async () => {
    setBusy(true); setMsg(null);
    try { await api.post('/api/routines/recommend/run'); st.reload(); setMsg({ ok: true, text: t('rotinas.rec.analisando', { nome: coordNameInicio }) }); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <section className={`card feature ${s?.enabled ? 'feature--on' : 'feature--rec'} rt-rec`}>
      <header className="row">
        <h3><Icon name="auto" size={16} /> {t('rotinas.rec.titulo')}</h3>
        {s && (
          <button role="switch" aria-checked={s.enabled} aria-label={t('rotinas.rec.titulo')} className={`switch ${s.enabled ? 'switch--on' : ''}`} disabled={busy} onClick={toggle}>
            <span className="switch__knob" /><span className="switch__txt">{s.enabled ? t('rotinas.rec.ligada') : t('rotinas.rec.desligada')}</span>
          </button>
        )}
      </header>
      <p className="muted">{t('rotinas.rec.explica', { nome: coordName })}</p>
      <p className="hint">{t('rotinas.rec.consumo', { nome: coordName })}</p>
      {s?.enabled && (
        <div className="row row--wrap">
          <button className="btn btn--sm" onClick={analyze} disabled={busy || s.needsAi} title={s.needsAi ? t('rotinas.rec.precisaIa') : undefined}><Icon name="auto" size={14} /> {t('rotinas.rec.analisarAgora')}</button>
          <span className="hint">{s.needsAi ? t('rotinas.rec.conecteIa') : t('rotinas.rec.ultima', { ultima: when(s.last), proxima: when(s.next) })}</span>
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </section>
  );
}

// --- Biblioteca -----------------------------------------------------------------------------------------------

function Library({ lib, coordName, onGo, onInstalled }: { lib: RoutineLibrary; coordName: string; onGo: (v: View) => void; onInstalled: (routineId: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState<RoutineTemplate | null>(null);
  const [only, setOnly] = useState(false);
  // por finalidade; "só as que já dá para usar" esconde as que pedem uma conexão que ainda falta
  const usable = (r: RoutineTemplate) => r.needs.every((n) => n.ok);
  const groups = useMemo(() => Object.entries(lib.categories).map(([k, label]) => ({ key: k, label, items: lib.routines.filter((r) => r.category === k && (!only || usable(r))) }))
    .filter((g) => g.items.length), [lib, only]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = lib.routines.filter(usable).length;
  return (
    <>
      <div className="row row--wrap rt-filter">
        <span className="muted">{t('rotinas.biblioteca.resumo', { total: fmtNumero(lib.routines.length), prontas: fmtNumero(ready) })}</span>
        <label className="field--inline"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {t('rotinas.biblioteca.soUsaveis')}</label>
      </div>
      {groups.map((g) => (
        <section key={g.key} className="rt-group">
          <h3 className="rt-group__title">{g.label}</h3>
          <div className="rt-grid">
            {g.items.map((tpl) => <TemplateCard key={tpl.key} tpl={tpl} onOpen={() => setOpen(tpl)} />)}
          </div>
        </section>
      ))}
      {open && <TemplateDrawer tpl={open} coordName={coordName} onClose={() => setOpen(null)} onGo={onGo} onInstalled={(id) => { setOpen(null); onInstalled(id); }} />}
    </>
  );
}

function TemplateCard({ tpl, onOpen }: { tpl: RoutineTemplate; onOpen: () => void }) {
  const t = useT();
  const active = tpl.installed.length > 0;
  const missing = tpl.needs.filter((n) => !n.ok);
  return (
    <button className={`rt-card ${active ? 'rt-card--on' : ''}`} onClick={onOpen}>
      <span className="rt-card__head">
        <b>{tpl.name}</b>
        <span className="badge badge--ok">{active ? t('rotinas.estado.ativa') : t('rotinas.estado.pronta')}</span>
      </span>
      <span className="rt-card__txt">{tpl.benefit}</span>
      <span className="rt-card__meta">
        <span className="rt-agents"><Icon name="users" size={12} /> {tpl.agentNames.join(' + ')}</span>
        {tpl.schedule && <span><Icon name="clock" size={12} /> {tpl.schedule}</span>}
      </span>
      {(missing.length > 0 || tpl.privateData) && (
        <span className="rt-needs">
          {missing.map((n) => <span key={n.id} className="rt-need">{t('rotinas.modelo.falta', { nome: n.label })}</span>)}
          {tpl.privateData && <span className="rt-need rt-need--priv"><Icon name="lock" size={11} /> {t('rotinas.modelo.privados')}</span>}
        </span>
      )}
    </button>
  );
}

/** Dias e hora (no fuso deste computador). */
function TriggerEditor({ value, onChange, modes }: { value: RoutineTrigger; onChange: (v: RoutineTrigger) => void; modes?: string[] }) {
  const t = useT();
  const sched = value.kind === 'schedule' ? value : null;
  const canSchedule = !modes || modes.includes('schedule');
  return (
    <div className="rt-trigger">
      <div className="row row--wrap">
        <label className="field--inline"><input type="radio" checked={!sched} onChange={() => onChange({ kind: 'manual' })} /> {t('rotinas.gatilho.quandoPedir')}</label>
        {canSchedule && <label className="field--inline"><input type="radio" checked={!!sched} onChange={() => onChange({ kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' })} /> {t('rotinas.gatilho.diasHorario')}</label>}
      </div>
      {sched && (
        <div className="row row--wrap">
          <span className="rt-days" role="group" aria-label={t('rotinas.gatilho.dias')}>
            {DAYS.map((d, i) => (
              <button key={d} type="button" className={`chip ${sched.days.includes(i) ? 'chip--on' : ''}`} aria-pressed={sched.days.includes(i)}
                onClick={() => { const days = sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort(); onChange({ ...sched, days }); }}>{t(d)}</button>
            ))}
          </span>
          <label className="field--inline">{tn('rotinas.gatilho.as', { hora: <input type="time" value={sched.time} onChange={(e) => e.target.value && onChange({ ...sched, time: e.target.value })} /> })}</label>
          {!sched.days.length && <span className="hint warn">{t('rotinas.gatilho.umDia')}</span>}
        </div>
      )}
    </div>
  );
}

function TemplateDrawer({ tpl, coordName, onClose, onGo, onInstalled }: { tpl: RoutineTemplate; coordName: string; onClose: () => void; onGo: (v: View) => void; onInstalled: (routineId: string) => void }) {
  const t = useT();
  const [extra, setExtra] = useState('');
  const [params, setParams] = useState<ParamValues>({});
  const specs = tpl.params ?? [];
  const lacking = specs.filter((p) => p.required && !(params[p.key] ?? []).length);
  // pede o pedido na hora (objetivo, ata, documento): não roda sozinha logo depois de ativar
  const asksInput = !!tpl.input && !!(tpl.input.text?.required || tpl.input.files?.required || tpl.input.oneOf);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const close = () => { if (keepTyped(!!extra.trim() || Object.values(params).some((v) => v.length), t('rotinas.ativar.descartar'))) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const missing = tpl.needs.filter((n) => !n.ok);
  const iaMissing = missing.some((n) => n.id === 'ia');
  const install = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<Routine>('/api/routines', { template: tpl.key, extra: extra.trim(), tz: TZ, adapt: true, ...(specs.length ? { params } : {}) });
      onInstalled(r.id);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };

  const ajuste = [
    specs.some((p) => p.required) ? t('rotinas.ativar.soDiga') : t('rotinas.ativar.nada'),
    asksInput ? t('rotinas.ativar.ajustaPedido', { nome: coordName }) : t('rotinas.ativar.ajustaRoda', { nome: coordName }),
    iaMissing ? t('rotinas.ativar.semIa') : '',
  ].filter(Boolean).join(' ');
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={tpl.name}>
      <div className="drawer__head">
        <span className="badge badge--ok">{t('rotinas.estado.pronta')}</span>
        <button className="icon-btn" onClick={close} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button>
      </div>
      <h3 className="drawer__title">{tpl.name}</h3>
      <p className="drawer__desc">{tpl.benefit}</p>
      <dl className="rt-facts">
        <dt>{t('rotinas.ficha.entrega')}</dt><dd>{tpl.produces}</dd>
        <dt>{t('rotinas.ficha.examina')}</dt><dd>{tpl.sources.length > 0 ? <ul>{tpl.sources.map((s) => <li key={s}>{s}</li>)}</ul> : tpl.examines}</dd>
        <dt>{t('rotinas.ficha.executa')}</dt><dd>{tpl.agentNames.length > 1 ? t('rotinas.ficha.executaApoio', { nome: tpl.agentNames[0], apoio: tpl.agentNames.slice(1).join(', ') }) : t('rotinas.ficha.executaSo', { nome: tpl.agentNames[0] })}</dd>
        <dt>{t('rotinas.ficha.precisa')}</dt>
        <dd className="rt-needlist">
          {tpl.needs.map((n) => <span key={n.id} className={`badge ${n.ok ? 'badge--ok' : 'badge--warn'}`}>{n.ok ? '✓' : '○'} {n.label}</span>)}
          {missing.some((n) => ['ia', 'microsoft', 'google', 'whatsapp'].includes(n.id)) && <button className="link rt-link" onClick={() => onGo('conexoes')}>{t('rotinas.ficha.irConexoes')}</button>}
        </dd>
        <dt>{t('rotinas.ficha.aprovacao')}</dt><dd>{tpl.approvals}</dd>
        <dt>{t('rotinas.ficha.modos')}</dt><dd>{tpl.modes.map((m) => rotulo(MODES, m)).join(' · ')}</dd>
      </dl>
      {tpl.privateData && <p className="hint warn"><Icon name="lock" size={12} /> {t('rotinas.ficha.privados')}</p>}
      {tpl.sample && (
        <>
          <h4 className="rt-sub">{t('rotinas.ficha.exemplo')}</h4>
          <blockquote className="rt-sample">{tpl.sample}</blockquote>
        </>
      )}
      <div className="rt-adapt">
        <Icon name="auto" size={16} />
        <p>{ajuste}</p>
      </div>
      {tpl.input && <p className="hint"><Icon name="send" size={12} /> {t('rotinas.entrada.aoExecutar', { oque: inputHint(tpl.input) })}</p>}
      {specs.length > 0 && (
        <>
          <h4 className="rt-sub">{t('rotinas.ativar.oQueAcompanhar')}</h4>
          <ParamsEditor specs={specs} value={params} onChange={setParams} />
        </>
      )}
      <label className="field">{t('rotinas.ativar.contar')}
        <textarea rows={2} maxLength={600} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={t('rotinas.ativar.contarEx')} />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      {lacking.length > 0 && <p className="hint warn">{t('rotinas.ativar.preencha', { campos: lacking.map((p) => p.label).join(', ') })}</p>}
      <div className="row row--wrap">
        <button className="btn btn--primary" disabled={busy} onClick={() => void install()}>{busy ? t('rotinas.ativar.ativando') : tpl.installed.length ? t('rotinas.ativar.outra') : t('rotinas.ativar.ativar')}</button>
      </div>
    </aside>
  );
}

// --- Minhas rotinas -------------------------------------------------------------------------------------------

function Mine({ list, focusId, coord, onOpenAgent, onSetup, reload, onLibrary }: { list: Routine[]; focusId?: string | null; coord: { id: string; name: string } | null; onOpenAgent: OpenAgent; onSetup: (id: string) => void; reload: () => void; onLibrary: () => void }) {
  const t = useT();
  const [edit, setEdit] = useState<Routine | null>(null);
  // a gaveta aberta tem alteração não salva: abrir outra rotina (o Editar dela, mesmo depois do "Cancelar" no
  // "Descartar as alterações?") não troca a gaveta no meio da edição
  const dirtyEdit = useRef(false);
  const openEdit = (r: Routine) => {
    if (edit && edit.id !== r.id && dirtyEdit.current) return;
    pushRecent({ kind: 'rotina', id: r.id, label: r.name, href: `#rotinas?rotina=${r.id}` });
    setEdit(r);
  };
  const closeEdit = () => { dirtyEdit.current = false; setEdit(null); };
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`rotina-${focusId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('rt-item--focus');
    const timer = window.setTimeout(() => el?.classList.remove('rt-item--focus'), 2400);
    return () => window.clearTimeout(timer);
  }, [focusId, list.length]);
  if (!list.length) return (
    <section className="card rt-empty">
      <h3>{t('rotinas.minhas.vazia')}</h3>
      <p className="muted">{tn('rotinas.minhas.comece', { briefing: <b>{t('rotinas.minhas.briefing')}</b> })}</p>
      <button className="btn btn--primary" onClick={onLibrary}>{t('rotinas.minhas.abrirBiblioteca')}</button>
    </section>
  );
  return (
    <>
      <div className="rt-mine">{list.map((r) => <RoutineCard key={r.id} r={r} coord={coord} onOpenAgent={onOpenAgent} onSetup={() => onSetup(r.id)} onEdit={() => openEdit(r)} reload={reload} />)}</div>
      {/* key: cada rotina monta a própria gaveta (os campos nunca levam o que foi digitado para outra) */}
      {edit && <EditDrawer key={edit.id} r={list.find((x) => x.id === edit.id) ?? edit} coordName={coord?.name ?? t('rotinas.coordenacao')} onClose={closeEdit} onDirty={(d) => { dirtyEdit.current = d; }} reload={reload} />}
    </>
  );
}

function RoutineCard({ r, coord, onOpenAgent, onSetup, onEdit, reload }: { r: Routine; coord: { id: string; name: string } | null; onOpenAgent: OpenAgent; onSetup: () => void; onEdit: () => void; reload: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const st = r.last ? STATUS[r.last.status] : null;
  const [ask, setAsk] = useState(false);
  const runNow = () => (r.input ? setAsk(true) : act(() => api.post(`/api/routines/${r.id}/run`, { clientRequestId: requestId() })));
  const linha = [
    r.status === 'active' && r.nextRunAt ? `${r.schedule} · ${t('rotinas.cartao.proxima', { quando: when(r.nextRunAt) })}` : r.schedule,
    t('rotinas.cartao.executa', { nome: r.agentName ?? '—' }),
    r.templateName ? '' : t('rotinas.cartao.criadaConversa'),
  ].filter(Boolean).join(' · ');
  return (
    // o card inteiro abre a edição (os detalhes da rotina); os botões de baixo continuam fazendo só o deles
    <article id={`rotina-${r.id}`} className={`card rt-item card-click ${r.status === 'paused' ? 'rt-item--paused' : ''}`} onClick={cardClick(onEdit)}>
      <header className="rt-item__head">
        <div>
          <h3><button type="button" className="card-open" onClick={onEdit} aria-label={t('rotinas.cartao.verDetalhes', { nome: r.name })}>{r.name}</button></h3>
          <p className="muted">
            <Icon name="clock" size={12} /> {linha}
          </p>
        </div>
        <span className={`badge ${r.status === 'active' ? 'badge--ok' : r.status === 'setup' ? 'badge--warn' : ''}`}>{r.status === 'active' ? t('rotinas.estado.ativa') : r.status === 'setup' ? t('rotinas.estado.emPreparo') : t('rotinas.estado.pausada')}</span>
      </header>
      <p className="rt-item__last">
        {r.running ? <><span className="dot dot--green dot--pulse" /> {t('rotinas.cartao.executandoAgora')}</>
          : r.last && st ? <><span className={`badge ${st.cls}`}>{t(st.label)}</span> {when(r.last.finished_at ?? r.last.created_at)} — {r.last.error ?? r.last.summary ?? ''}</>
            : <span className="muted">{t('rotinas.cartao.naoExecutou')}</span>}
      </p>
      {r.config.extra && <p className="hint">{t('rotinas.cartao.ajuste', { texto: r.config.extra })}</p>}
      {r.missing.length > 0 && <p className="hint warn">{t('rotinas.cartao.faltaConfigurar', { campos: r.missing.join(', ') })} <button className="link" onClick={onEdit}>{t('rotinas.cartao.configurar')}</button></p>}
      {r.proposes && <p className="hint">{r.proposes === 'tarefas' ? t('rotinas.cartao.propoeTarefas') : t('rotinas.cartao.propoeLancamentos')}</p>}
      <div className="row row--wrap">
        {r.status === 'setup' && <button className="btn btn--sm btn--primary" onClick={onSetup}><Icon name="auto" size={13} /> {t('rotinas.cartao.verPreparo')}</button>}
        {r.status !== 'setup' && <button className="btn btn--sm btn--primary" disabled={busy || r.running} onClick={() => void runNow()}><Icon name="send" size={13} /> {t('rotinas.cartao.executarAgora')}</button>}
        {r.status !== 'setup' && <button className="btn btn--sm" disabled={busy} onClick={() => act(() => api.patch(`/api/routines/${r.id}`, { status: r.status === 'active' ? 'paused' : 'active', tz: TZ }))}>{r.status === 'active' ? t('rotinas.cartao.pausar') : t('rotinas.cartao.retomar')}</button>}
        <button className="btn btn--sm" onClick={onEdit}><Icon name="edit" size={13} /> {t('rotinas.cartao.editar')}</button>
        {r.conversationId && r.agentId && <button className="btn btn--sm" onClick={() => onOpenAgent(r.agentId!, 'conversa', null, r.conversationId)}><Icon name="chat" size={13} /> {t('rotinas.cartao.conversa')}</button>}
        {coord && <button className="btn btn--sm btn--ghost" onClick={() => (r.hasSetup ? onSetup() : onOpenAgent(coord.id, 'conversa', t('rotinas.rascunho.ajustar', { nome: r.name })))}>{t('rotinas.cartao.ajustarCom', { nome: coord.name })}</button>}
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act(() => api.post(`/api/routines/${r.id}/duplicate`))}>{t('rotinas.cartao.duplicar')}</button>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => { if (confirm(t('rotinas.cartao.removerConfirma', { nome: r.name }))) void act(() => api.del(`/api/routines/${r.id}`)); }}><Icon name="trash" size={13} /> {t('rotinas.cartao.remover')}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {ask && r.input && <RunDialog r={r} spec={r.input} onClose={() => setAsk(false)} onDone={() => { setAsk(false); reload(); }} />}
    </article>
  );
}

/** "escreve: o objetivo" / "anexa: as planilhas" — o que a rotina vai pedir (o rótulo vem da rotina). */
const inputHint = (s: InputSpec): string => {
  const partes: string[] = [];
  if (s.text) {
    const oque = s.text.label.replace(/\?$/, '').toLowerCase();
    partes.push(s.text.required ? t('rotinas.entrada.escreve', { oque }) : t('rotinas.entrada.escreveOpcional', { oque }));
  }
  if (s.files) partes.push(t('rotinas.entrada.anexa', { oque: s.files.label.toLowerCase() }));
  if (partes.length < 2) return partes[0] ?? '';
  return s.oneOf ? t('rotinas.entrada.ou', { a: partes[0], b: partes[1] }) : t('rotinas.entrada.e', { a: partes[0], b: partes[1] });
};

/** Executar com o pedido: o texto (objetivo, assunto, ata) e os arquivos desta execução. */
function RunDialog({ r, spec, onClose, onDone }: { r: Routine; spec: InputSpec; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rid] = useState(requestId);
  const ref = useRef<HTMLElement>(null);
  const close = () => { if (keepTyped(!!text.trim() || files.length > 0, t('rotinas.executar.descartar'))) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const kept = r.paramSpecs.some((p) => p.kind === 'arquivos' && (r.config.params[p.key] ?? []).length);
  const can = (!spec.text?.required || text.trim()) && (!spec.files?.required || files.length || kept) && (!spec.oneOf || text.trim() || files.length);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/api/routines/${r.id}/run`, { clientRequestId: rid, input: { ...(text.trim() ? { text: text.trim() } : {}), ...(files.length ? { files } : {}) } }); onDone(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={t('rotinas.executar.aria', { nome: r.name })}>
      <div className="drawer__head"><span className="badge">{t('rotinas.executar.selo')}</span><button className="icon-btn" onClick={close} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button></div>
      <h3 className="drawer__title">{r.name}</h3>
      {spec.text && (
        <label className="field">{opcional(spec.text.label, spec.text.required)}
          <textarea rows={spec.oneOf ? 8 : 4} maxLength={50000} value={text} onChange={(e) => setText(e.target.value)} placeholder={spec.text.placeholder} autoFocus />
        </label>
      )}
      {spec.files && (
        <>
          <h4 className="rt-sub">{opcional(spec.files.label, spec.files.required && !kept)}</h4>
          {kept && <p className="hint">{t('rotinas.executar.semAnexar')}</p>}
          <FilePicker value={files} onChange={setFiles} max={spec.files.max ?? 5} accept={spec.files.accept} />
        </>
      )}
      {spec.oneOf && <p className="hint">{t('rotinas.executar.basta')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row"><button className="btn btn--primary" disabled={busy || !can} onClick={() => void go()}>{busy ? t('rotinas.executar.enviando') : t('rotinas.executar.executar')}</button><button className="btn btn--ghost" onClick={close}>{t('geral.comum.cancelar')}</button></div>
      <p className="hint">{t('rotinas.executar.seguranca')}</p>
    </aside>
  );
}

/** O que a rotina acompanha: listas (uma por linha ou separadas por ;), endereços https e arquivos escolhidos. */
function ParamsEditor({ specs, value, onChange }: { specs: ParamSpec[]; value: ParamValues; onChange: (v: ParamValues) => void }) {
  const t = useT();
  return (
    <div className="rt-params">
      {specs.map((p) => p.kind === 'arquivos' ? (
        <div key={p.key} className="field">
          <span>{opcional(p.label, p.required)}</span>
          <FilePicker value={(value[p.key] ?? []).filter((x): x is FileRef => typeof x === 'object')} onChange={(f) => onChange({ ...value, [p.key]: f })} max={p.max ?? 10} />
        </div>
      ) : (
        <label key={p.key} className="field">{opcional(p.label, p.required)}
          <textarea rows={p.kind === 'urls' ? 2 : 3} value={(value[p.key] ?? []).filter((x): x is string => typeof x === 'string').join('\n')} placeholder={p.placeholder}
            onChange={(e) => onChange({ ...value, [p.key]: e.target.value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean) })} />
          <span className="hint">{p.kind === 'urls' ? t('rotinas.params.urls') : t('rotinas.params.lista')}{p.hint ? ` ${p.hint}` : ''}</span>
        </label>
      ))}
    </div>
  );
}

/** De onde vem o arquivo: nomes de produto, iguais nas duas línguas. */
const ORIGEM: Record<FileRef['kind'], string> = { ergon: 'Ergon', google: 'Google Drive', microsoft: 'OneDrive' }; // i18n-ok: nomes de produto

/** Arquivos para a rotina: os do Ergon, um novo (enviado agora) ou do OneDrive/Google Drive (procurados pelo nome). */
function FilePicker({ value, onChange, max, accept }: { value: FileRef[]; onChange: (f: FileRef[]) => void; max: number; accept?: string }) {
  const t = useT();
  const mine = useResource<ArtifactRow[]>('/api/artifacts', ['artifacts.changed']);
  const [q, setQ] = useState('');
  const [cloud, setCloud] = useState<CloudFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const has = (f: FileRef) => value.some((v) => v.kind === f.kind && v.id === f.id);
  const add = (f: FileRef) => { if (!has(f) && value.length < max) onChange([...value, f]); };
  const local = (mine.data ?? []).filter((a) => !q.trim() || a.filename.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  const send = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try { const a = await api.upload<{ id: string; filename: string }>(file); add({ kind: 'ergon', id: a.id, name: a.filename }); mine.reload(); }
    catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  const search = async () => {
    if (q.trim().length < 2) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.get<{ items: CloudFile[]; reads: Array<{ status: string; account: string }> }>(`/api/routines/cloud-files?q=${encodeURIComponent(q.trim())}`);
      setCloud(r.items);
      if (!r.reads.some((x) => x.status === 'ok')) setMsg(r.reads.some((x) => x.status !== 'nao_conectada') ? t('rotinas.arquivos.erroBusca') : t('rotinas.arquivos.conecte'));
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="rt-files">
      {value.length > 0 && (
        <ul className="rt-files__sel">
          {value.map((f) => <li key={`${f.kind}:${f.id}`}><Icon name="folder" size={12} /> {f.name} <span className="muted small">{ORIGEM[f.kind] ?? ORIGEM.microsoft}</span>
            <button className="icon-btn" aria-label={t('rotinas.arquivos.tirar', { nome: f.name })} onClick={() => onChange(value.filter((v) => !(v.kind === f.kind && v.id === f.id)))}><Icon name="x" size={12} /></button></li>)}
        </ul>
      )}
      {value.length < max && (
        <>
          <div className="row row--wrap">
            <input className="rt-files__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('rotinas.arquivos.procurarNome')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
            <button type="button" className="btn btn--sm" disabled={busy || q.trim().length < 2} onClick={() => void search()}>{t('rotinas.arquivos.procurarNuvem')}</button>
            <label className="btn btn--sm">{t('rotinas.arquivos.enviar')}<input type="file" hidden accept={accept} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          {local.length > 0 && <ul className="rt-files__list">{local.map((a) => <li key={a.id}><button type="button" className="link" disabled={has({ kind: 'ergon', id: a.id, name: a.filename })} onClick={() => add({ kind: 'ergon', id: a.id, name: a.filename })}>{a.filename}</button> <span className="muted small">{t('rotinas.arquivos.noErgon', { quando: when(a.created_at) })}</span></li>)}</ul>}
          {cloud && (cloud.length ? <ul className="rt-files__list">{cloud.map((c) => <li key={c.id}><button type="button" className="link" onClick={() => add({ kind: c.provider, id: c.id, name: c.name, ...(c.conta ? { conta: c.conta } : {}) })}>{c.name}</button> <span className="muted small">{c.provider === 'google' ? ORIGEM.google : c.folder} · {when(c.modified)}</span></li>)}</ul> : <p className="muted small">{t('rotinas.arquivos.nadaNuvem')}</p>)}
          <p className="hint">{t('rotinas.arquivos.formatos')}</p>
        </>
      )}
      {msg && <p className="hint warn">{msg}</p>}
    </div>
  );
}

function EditDrawer({ r, coordName, onClose, onDirty, reload }: { r: Routine; coordName: string; onClose: () => void; onDirty?: (dirty: boolean) => void; reload: () => void }) {
  const t = useT();
  const [name, setName] = useState(r.name);
  const [trigger, setTrigger] = useState<RoutineTrigger>(r.trigger);
  const [extra, setExtra] = useState(r.config.extra ?? '');
  const [stale, setStale] = useState(r.config.staleDays ?? 3);
  const [params, setParams] = useState<ParamValues>(r.config.params ?? {});
  // as contas que a rotina lê, quando há mais de uma do mesmo aplicativo (vazio = todas)
  const [contas, setContas] = useState<string[]>(r.config.contas ?? []);
  const ints = useResource<Integration[]>('/api/integrations', ['integrations.changed']);
  const grupos = gruposDaRotina(ints.data ?? [], r.config.sources);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const versions = useResource<Array<{ version: number; name: string; schedule: string; note: string | null; created_at: string }>>(`/api/routines/${r.id}/versions`, ['routines.changed']);
  const usesStale = r.config.sources.includes('tarefas.paradas');
  const ref = useRef<HTMLElement>(null);
  const dirty = name !== r.name || JSON.stringify(trigger) !== JSON.stringify(r.trigger) || extra !== (r.config.extra ?? '') || stale !== (r.config.staleDays ?? 3) || JSON.stringify(params) !== JSON.stringify(r.config.params ?? {}) || JSON.stringify(contas) !== JSON.stringify(r.config.contas ?? []);
  useEffect(() => { onDirty?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (keepTyped(dirty, t('rotinas.editar.descartar'))) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const save = async () => {
    if (trigger.kind === 'schedule' && !trigger.days.length) { setMsg({ ok: false, text: t('rotinas.editar.umDia') }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/routines/${r.id}`, { name: name.trim() || r.name, trigger: { ...trigger, ...(trigger.kind === 'schedule' ? { tz: TZ } : {}) }, extra: extra.trim(), ...(usesStale ? { staleDays: stale } : {}), ...(r.paramSpecs.length ? { params } : {}), ...(grupos.length || (r.config.contas ?? []).length ? { contas } : {}), tz: TZ });
      setMsg({ ok: true, text: t('rotinas.editar.salvo') }); reload(); versions.reload();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const restore = async (v: number) => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/routines/${r.id}/restore`, { version: v }); setMsg({ ok: true, text: t('rotinas.editar.voltou', { versao: v }) }); reload(); versions.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const onde = fmtLista(r.config.deliver.map((d) => (d === 'conversa' ? t('rotinas.entrega.conversa') : t('rotinas.entrega.arquivo'))));
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={t('rotinas.editar.aria', { nome: r.name })}>
      <div className="drawer__head"><span className="badge">{t('rotinas.editar.versao', { versao: r.version })}</span><button className="icon-btn" onClick={close} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button></div>
      <h3 className="drawer__title">{t('rotinas.editar.titulo')}</h3>
      <label className="field">{t('rotinas.editar.nome')}<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
      <h4 className="rt-sub">{t('rotinas.editar.quandoRoda')}</h4>
      <TriggerEditor value={trigger} onChange={setTrigger} />
      <label className="field">{t('rotinas.editar.ajuste')}
        <textarea rows={3} maxLength={600} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={t('rotinas.editar.ajusteEx')} />
      </label>
      {usesStale && <label className="field">{t('rotinas.editar.parada')}<input type="number" min={1} max={60} value={stale} onChange={(e) => setStale(Number(e.target.value) || 3)} /></label>}
      {r.paramSpecs.length > 0 && <><h4 className="rt-sub">{t('rotinas.ativar.oQueAcompanhar')}</h4><ParamsEditor specs={r.paramSpecs} value={params} onChange={setParams} /></>}
      {/* duas contas do mesmo aplicativo (dois e-mails, dois números): a rotina lê uma, várias ou todas */}
      {grupos.length > 0 && (
        <>
          <h4 className="rt-sub">{t('rotinas.editar.contas')}</h4>
          <p className="hint">{t('rotinas.editar.contasDica')}</p>
          {grupos.map((g) => (
            <fieldset key={g.kind} className="rt-contas"><legend>{g.name}</legend>
              {g.contas.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={contaMarcada(contas, g.contas, c.id)} onChange={() => setContas(alternarConta(contas, g.contas, c.id))} /> {nomeNaTela(c, g.name)}</label>)}
            </fieldset>
          ))}
        </>
      )}
      <dl className="rt-facts">
        <dt>{t('rotinas.ficha.olha')}</dt><dd>{r.config.sourceLabels.join('; ')}</dd>
        <dt>{t('rotinas.ficha.usaModelo')}</dt><dd>{rotulo(CONDITION, r.config.condition)}</dd>
        <dt>{t('rotinas.ficha.entregaCurta')}</dt><dd>{r.outputs.length ? t('rotinas.entrega.com', { onde, saidas: r.outputs.map((o) => rotulo(OUTPUT, o)).join(', ') }) : onde}</dd>
        {r.input && <><dt>{t('rotinas.ficha.aoExecutar')}</dt><dd>{t('rotinas.entrada.voce', { oque: inputHint(r.input) })}</dd></>}
      </dl>
      <p className="hint">{t('rotinas.editar.pecaMudar', { nome: coordName })}</p>
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
      <div className="row"><button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>{t('rotinas.editar.salvar')}</button><button className="btn btn--ghost" onClick={close}>{t('rotinas.editar.fechar')}</button></div>
      <h4 className="rt-sub">{t('rotinas.editar.versoes')}</h4>
      <ul className="rt-versions">
        {versions.data?.map((v) => (
          <li key={v.version}>
            <b>v{v.version}</b> · {when(v.created_at)} · {v.schedule}{v.note ? ` · ${v.note}` : ''}
            {v.version !== r.version && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void restore(v.version)}>{t('rotinas.editar.restaurar')}</button>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// --- Histórico -------------------------------------------------------------------------------------------------

function History({ routines, onOpenAgent }: { routines: Routine[]; onOpenAgent: OpenAgent }) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const runs = useResource<RoutineRun[]>(`/api/routine-runs?limit=100${filter ? `&routineId=${filter}` : ''}`, ['routines.changed']);
  const [open, setOpen] = useState<string | null>(null);
  const linha = (x: RoutineRun) => [
    when(x.started_at ?? x.created_at),
    x.trigger === 'schedule' ? t('rotinas.historico.agendada') : t('rotinas.historico.pedida'),
    x.mode === 'local' ? t('rotinas.historico.semModelo') : x.agent ?? '',
    x.tokens ? t('rotinas.historico.consumo', { n: x.tokens }) : '',
  ].filter(Boolean).join(' · ');
  return (
    <>
      <div className="row row--wrap">
        <label className="field--inline">{t('rotinas.historico.rotina')}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">{t('rotinas.historico.todas')}</option>
            {routines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <span className="hint">{t('rotinas.historico.explica')}</span>
      </div>
      {!runs.data ? <Loading error={runs.error} /> : !runs.data.length ? <p className="muted">{t('rotinas.historico.nenhuma')}</p> : (
        <div className="rt-runs">
          {runs.data.map((x) => (
            <div key={x.id} className={`rt-run ${open === x.id ? 'rt-run--open' : ''}`}>
              <button className="rt-run__row" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                <span className={`badge ${STATUS[x.status].cls}`}>{t(STATUS[x.status].label)}</span>
                {x.verdict && <span className={`badge ${VERDICT[x.verdict].cls}`} title={t('rotinas.historico.conferencia')}>{t(VERDICT[x.verdict].label)}</span>}
                <b>{x.name}</b>
                <span className="muted">{linha(x)}</span>
                <span className="rt-run__sum">{x.error ?? x.summary ?? ''}</span>
                <Icon name="chevron" size={14} />
              </button>
              {open === x.id && <RunDetail id={x.id} onOpenAgent={onOpenAgent} agentId={routines.find((r) => r.id === x.routine_id)?.agentId ?? null} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const VERDICT: Record<'validado' | 'parcial' | 'reprovado', { label: Rotulo; cls: string }> = {
  validado: { label: 'rotinas.veredito.validado', cls: 'badge--ok' }, parcial: { label: 'rotinas.veredito.parcial', cls: 'badge--warn' }, reprovado: { label: 'rotinas.veredito.reprovado', cls: 'badge--err' },
};
/** Cada nível do que a conferência prova, em palavras (a análise em si nunca é provada por código). */
const LEVEL: Array<[keyof EvidenceLevels, Rotulo, Record<string, [Rotulo, boolean]>]> = [
  ['coleta', 'rotinas.nivel.coleta', { completa: ['rotinas.nivel.coleta.completa', true], parcial: ['rotinas.nivel.coleta.parcial', false], sem_fontes: ['rotinas.nivel.coleta.semFontes', true] }],
  ['citacoes', 'rotinas.nivel.citacoes', { conferidas: ['rotinas.nivel.citacoes.conferidas', true], com_erro: ['rotinas.nivel.citacoes.comErro', false], sem_modelo: ['rotinas.nivel.citacoes.semModelo', true] }],
  ['numeros', 'rotinas.nivel.numeros', { conferidos: ['rotinas.nivel.numeros.conferidos', true], com_erro: ['rotinas.nivel.numeros.comErro', false], nao_conferidos: ['rotinas.nivel.numeros.naoConferidos', true] }],
  ['cobertura', 'rotinas.nivel.cobertura', { completa: ['rotinas.nivel.cobertura.completa', true], completada_pelo_ergon: ['rotinas.nivel.cobertura.completadaPeloErgon', false], nao_se_aplica: ['rotinas.nivel.cobertura.naoSeAplica', true] }],
  ['analise', 'rotinas.nivel.analise', { nao_verificada: ['rotinas.nivel.analise.naoVerificada', true] }],
  ['humano', 'rotinas.nivel.humano', { revisao_necessaria: ['rotinas.nivel.humano.necessaria', false], opcional: ['rotinas.nivel.humano.opcional', true] }],
];
const READ_STATUS: Record<string, Rotulo> = { ok: 'rotinas.leitura.ok', nao_conectada: 'rotinas.leitura.naoConectada', sem_permissao: 'rotinas.leitura.semPermissao', expirada: 'rotinas.leitura.expirada', erro: 'rotinas.leitura.erro' };
const READ_WHAT: Record<string, Rotulo> = { agenda: 'rotinas.leitura.agenda', email: 'rotinas.leitura.email', tarefas: 'rotinas.leitura.tarefas', arquivos: 'rotinas.leitura.arquivos' };
const OUTPUT: Record<string, Rotulo> = { 'csv-indicadores': 'rotinas.saida.csvIndicadores', 'csv-lancamentos': 'rotinas.saida.csvLancamentos', 'csv-conferencia': 'rotinas.saida.csvConferencia',
  'csv-obrigacoes': 'rotinas.saida.csvObrigacoes', 'csv-semana': 'rotinas.saida.csvSemana', pptx: 'rotinas.saida.pptx' };

function RunDetail({ id, onOpenAgent, agentId }: { id: string; onOpenAgent: OpenAgent; agentId: string | null }) {
  const t = useT();
  const d = useResource<RoutineRunDetail>(`/api/routine-runs/${id}`, ['routines.changed']);
  if (!d.data) return <Loading error={d.error} />;
  const x = d.data;
  return (
    <div className="rt-run__detail">
      {x.output ? <div className="rt-output">{x.output}</div> : x.error ? <p className="error">{x.error}</p> : <p className="muted">{x.summary ?? t('rotinas.detalhe.semResultado')}</p>}
      <div className="row row--wrap">
        {x.deliverables.map((dl) => dl.type === 'arquivo'
          ? <a key={dl.id} className="btn btn--sm" href={`/api/artifacts/${dl.id}/download`}><Icon name="folder" size={13} /> {dl.name}</a>
          : agentId ? <button key={dl.id} className="btn btn--sm" onClick={() => onOpenAgent(agentId, 'conversa', null, dl.id)}><Icon name="chat" size={13} /> {t('rotinas.detalhe.abrirConversa')}</button> : null)}
      </div>
      {x.checks && (
        <div className="rt-checks">
          <p><span className={`badge ${x.checks.verdict ? VERDICT[x.checks.verdict].cls : ''}`}>{x.checks.verdict ? t(VERDICT[x.checks.verdict].label) : t('rotinas.detalhe.semConferencia')}</span> <span className="muted">{x.checks.panel}</span></p>
          <ul className="crit">
            {x.checks.criteria.map((c) => <li key={c.id} className={c.ok ? 'crit--ok' : 'crit--no'}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.label}{c.detail ? <span className="muted"> — {c.detail}</span> : null}</li>)}
          </ul>
          {x.checks.levels && (
            <dl className="rt-levels" aria-label={t('rotinas.detalhe.provaAria')}>
              {LEVEL.map(([k, label, words]) => { const w = words[x.checks!.levels![k]]; const good = w ? w[1] : true; return <div key={k}><dt>{t(label)}</dt><dd className={good ? '' : 'warn'}>{w ? t(w[0]) : '—'}</dd></div>; })}
            </dl>
          )}
          {x.checks.reads.some((r) => r.status !== 'nao_conectada') && (
            <p className="muted small">{t('rotinas.detalhe.contas', {
              lista: x.checks.reads.filter((r) => r.status !== 'nao_conectada').map((r) => {
                const v = { conta: r.account === 'google' ? 'Google' : 'Microsoft', oque: rotulo(READ_WHAT, r.what), estado: rotulo(READ_STATUS, r.status) };
                return r.status === 'ok' ? t('rotinas.detalhe.leituraQtd', { ...v, qtd: fmtNumero(r.count) }) : t('rotinas.detalhe.leitura', v);
              }).join(' · '),
            })}</p>
          )}
          {x.checks.warnings.map((w) => <p key={w} className="warn small">{w}</p>)}
        </div>
      )}
      {x.params && <RunInputLine raw={x.params} />}
      {x.facts && (
        <details className="rt-evidence">
          <summary>{t('rotinas.detalhe.evidencia')}</summary>
          <pre>{x.facts}</pre>
        </details>
      )}
    </div>
  );
}

/** O pedido daquela execução (o que você escreveu e os arquivos). */
function RunInputLine({ raw }: { raw: string }) {
  const t = useT();
  let x: { text?: string; files?: FileRef[] } = {};
  try { x = JSON.parse(raw); } catch { return null; }
  if (!x.text && !x.files?.length) return null;
  const partes = [
    x.text ? `"${x.text.length > 140 ? `${x.text.slice(0, 140)}…` : x.text}"` : '',
    x.files?.length ? t('rotinas.detalhe.arquivos', { nomes: x.files.map((f) => f.name).join(', ') }) : '',
  ].filter(Boolean).join(' · ');
  return <p className="muted small">{t('rotinas.detalhe.pedido', { partes })}</p>;
}

// --- Preparo (ativação adaptativa) ------------------------------------------------------------------------------

const STUDY_BASE: Rotulo[] = [
  'rotinas.estudo.pergaminhos', 'rotinas.estudo.oraculo', 'rotinas.estudo.papiros',
  'rotinas.estudo.clepsidra', 'rotinas.estudo.estilete', 'rotinas.estudo.farol', 'rotinas.estudo.musas',
];
/** piadas de personagem: só com ele na equipe e com o nome original (num tema com outros nomes, a piada não cabe) */
const STUDY_CHAR: Array<[key: string, text: Rotulo]> = [
  ['aristoteles', 'rotinas.estudo.aristoteles'], ['hipatia', 'rotinas.estudo.hipatia'],
  ['socrates', 'rotinas.estudo.socrates'], ['arquimedes', 'rotinas.estudo.arquimedes'],
  ['diogenes', 'rotinas.estudo.diogenes'], ['euclides', 'rotinas.estudo.euclides'],
  ['herodoto', 'rotinas.estudo.herodoto'],
];
/** cast: os personagens ativos com o nome original (o servidor confere o nome; aqui só a chave) */
const studyPhrases = (cast: string[]) => [...STUDY_BASE, ...STUDY_CHAR.filter(([k]) => cast.includes(k)).map(([, txt]) => txt)].map((k) => t(k));
/** O preparo com quem conversa (a linha leve, desativado incluído) e o elenco das piadas. */
type SetupView = Omit<RoutineSetupState, 'setup'> & {
  setup: (NonNullable<RoutineSetupState['setup']> & { agent?: TeamAgent | null }) | null;
  cast?: string[];
};
const FIRST: Rotulo[] = ['rotinas.primeira.rodando', 'rotinas.primeira.colhendo', 'rotinas.primeira.limpo', 'rotinas.primeira.selando'];

/**
 * A rotina recém-ativada: o que ela é, o andamento do preparo (com bom humor enquanto a coordenação estuda), o que foi
 * ajustado ao seu caso e o primeiro resultado — e, ao lado, a conversa com a coordenação, onde chegam as perguntas
 * (se houver) e onde dá para pedir qualquer mudança.
 */
function RoutineSetup({ id, fresh, onBack, onGo }: { id: string; fresh: boolean; onBack: () => void; onGo: (v: View) => void }) {
  const t = useT();
  const idioma = useIdioma();
  const st = useResource<SetupView>(`/api/routines/${id}/setup`, ['routines.changed', 'proposals.changed', 'runs.changed', 'agents.changed']);
  // logo depois de ativar, a espera aparece por alguns segundos mesmo quando o ajuste é instantâneo (sem conta de IA)
  const [minDone, setMinDone] = useState(!fresh);
  useEffect(() => { if (fresh) { const timer = window.setTimeout(() => setMinDone(true), 3800); return () => clearTimeout(timer); } }, [fresh]);
  const [msg, setMsg] = useState<string | null>(null);
  const castKey = (st.data?.cast ?? []).join('|');
  const study = useMemo(() => studyPhrases(castKey ? castKey.split('|') : []), [castKey, idioma]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useMemo(() => FIRST.map((k) => t(k)), [idioma]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dialog, setDialog] = useState(false);
  // todos os hooks acima: abaixo daqui pode haver retorno antecipado
  if (!st.data) return <div className="page"><Loading error={st.error} /></div>;
  const { routine: r, template: tpl, setup: s, firstRun } = st.data;
  const agent = s?.agent ?? null;
  const preparing = !s || s.status === 'studying' || s.status === 'adapting' || !minDone;
  const asking = s?.status === 'asking' && minDone;
  const ready = s?.status === 'ready' && minDone;
  const firstBusy = firstRun && ['queued', 'gathering', 'running'].includes(firstRun.status);
  // rotina que pede o pedido (objetivo, ata, documento) ou que ainda não sabe o que acompanhar: não roda sozinha ao ativar
  const asks = !!r.input && !!(r.input.text?.required || r.input.files?.required || r.input.oneOf);
  const waitsUser = (asks || r.missing.length > 0) && !firstRun;
  const step = (done: boolean, now: boolean, label: string) => (
    <li className={`rt-step ${done ? 'rt-step--done' : now ? 'rt-step--now' : ''}`}><span className="rt-step__dot" aria-hidden="true">{done ? '✓' : ''}</span>{label}</li>
  );
  const again = async () => {
    if (r.input) { setDialog(true); return; }
    setMsg(null); try { await api.post(`/api/routines/${r.id}/run`, { clientRequestId: requestId() }); st.reload(); } catch (e) { setMsg(errMsg(e)); }
  };
  const quemPergunta = agent?.name ?? t('rotinas.coordenacaoInicio');
  return (
    <div className="page rt-setup">
      <header className="rt-setup__head">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>{t('rotinas.preparo.voltar')}</button>
        <h2>{r.name}</h2>
        <span className={`badge ${ready ? 'badge--ok' : 'badge--warn'}`}>{ready ? t('rotinas.estado.ativa') : asking ? t('rotinas.estado.esperandoVoce') : t('rotinas.estado.emPreparo')}</span>
      </header>
      <div className="rt-setup__grid">
        <section className="rt-setup__main">
          <div className="card rt-setup__status">
            {preparing && <PhraseLoader phrases={study} size={92} />}
            {asking && (
              <div className="rt-setup__ask"><Icon name="chat" size={18} /><p>{tn('rotinas.preparo.antesDeLigar', { pergunta: <b>{s!.pendingQuestions > 1 ? t('rotinas.preparo.temDuas', { nome: quemPergunta }) : t('rotinas.preparo.temUma', { nome: quemPergunta })}</b> })}</p></div>
            )}
            {ready && s?.adapted && (
              <div className="rt-setup__ready">
                <h3><Icon name="auto" size={16} /> {t('rotinas.preparo.prontaAjustada')}</h3>
                <p>{s.adapted.summary.charAt(0).toUpperCase() + s.adapted.summary.slice(1)}.</p>
                <div className="rt-setup__chips">
                  <span className="chip"><Icon name="clock" size={12} /> {r.schedule}</span>
                  {/* i18n-ok: 'horário' é o começo da frase que o servidor manda (a mudança de horário já está no chip do relógio) */}
                  {s.adapted.changes.filter((c) => !c.startsWith('horário')).map((c) => <span key={c} className="chip">{c}</span>)}
                  <span className="chip">{t('rotinas.cartao.executa', { nome: r.agentName ?? '—' })}</span>
                </div>
                {s.adapted.source === 'ergon' && <p className="hint">{t('rotinas.preparo.semIa', { nota: s.adapted.noted })}</p>}
              </div>
            )}
            <ol className="rt-steps">
              {step(true, false, t('rotinas.passo.ler'))}
              {step(!!s && s.status !== 'studying' && minDone, !!s && s.status === 'studying', t('rotinas.passo.entender'))}
              {step(!!ready, !!s && (s.status === 'asking' || s.status === 'adapting'), t('rotinas.passo.ajustar'))}
              {waitsUser ? step(!!ready && !r.missing.length, false, r.missing.length ? t('rotinas.passo.dizer') : t('rotinas.passo.prontaPedido'))
                : step(!!ready && !!firstRun && !firstBusy, !!ready && !!firstBusy, t('rotinas.passo.primeira'))}
            </ol>
          </div>
          {ready && (
            <div className="card rt-first">
              <h3>{waitsUser ? t('rotinas.preparo.prontaUsar') : t('rotinas.preparo.primeiroResultado')}</h3>
              {waitsUser ? (r.missing.length
                ? <p className="hint warn">{t('rotinas.preparo.digaAcompanhar', { campos: r.missing.join(', ') })}</p>
                : <p className="muted">{t('rotinas.preparo.trabalhaPedido', { oque: r.input ? inputHint(r.input) : t('rotinas.entrada.escrevaPedido') })}</p>)
              : !firstRun || firstBusy ? <PhraseLoader phrases={first} size={56} every={2200} />
                : firstRun.output ? <div className="rt-output">{firstRun.output}</div>
                  : <p className={firstRun.error ? 'error' : 'muted'}>{firstRun.error ?? firstRun.summary ?? t('rotinas.detalhe.semResultado')}</p>}
              <div className="row row--wrap">
                {firstRun?.deliverables.filter((d) => d.type === 'arquivo').map((d) => <a key={d.id} className="btn btn--sm" href={`/api/artifacts/${d.id}/download`}><Icon name="folder" size={13} /> {(d as { name: string }).name}</a>)}
                {!r.missing.length && <button className={`btn btn--sm ${waitsUser ? 'btn--primary' : ''}`} onClick={() => void again()} disabled={!!firstBusy}><Icon name="send" size={13} /> {waitsUser ? t('rotinas.cartao.executarAgora') : t('rotinas.preparo.executarDeNovo')}</button>}
                <button className="btn btn--sm btn--primary" onClick={onBack}>{t('rotinas.preparo.irMinhas')}</button>
              </div>
              {msg && <p className="error" role="alert">{msg}</p>}
              {dialog && r.input && <RunDialog r={r} spec={r.input} onClose={() => setDialog(false)} onDone={() => { setDialog(false); onBack(); }} />}
            </div>
          )}
          {tpl && (
            <div className="card rt-about">
              <h3>{t('rotinas.preparo.sobre')}</h3>
              <p>{tpl.benefit}</p>
              <dl className="rt-facts">
                <dt>{t('rotinas.ficha.entregaCurta')}</dt><dd>{tpl.produces}</dd>
                <dt>{t('rotinas.ficha.olha')}</dt><dd>{tpl.sources.join('; ')}</dd>
                <dt>{t('rotinas.ficha.aprovacaoCurta')}</dt><dd>{tpl.approvals}</dd>
              </dl>
              {!ready && tpl.sample && <><h4 className="rt-sub">{t('rotinas.ficha.exemplo')}</h4><blockquote className="rt-sample">{tpl.sample}</blockquote></>}
              {ready && <button className="link rt-link" onClick={() => onGo('conexoes')}>{t('rotinas.preparo.conectarMais')}</button>}
            </div>
          )}
        </section>
        <aside className="rt-setup__chat" aria-label={t('rotinas.preparo.conversaAria')}>
          {agent && s ? <ChatPanel agent={agent} embedded conversationId={s.conversationId} /> : <p className="muted">{t('rotinas.preparo.semCoord')}</p>}
        </aside>
      </div>
    </div>
  );
}
