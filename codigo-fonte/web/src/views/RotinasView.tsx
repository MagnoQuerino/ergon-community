import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, requestId } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { keepTyped, useSurface } from '../lib/surface.ts';
import type { AppState, ArtifactRow, CloudFile, EvidenceLevels, FileRef, InputSpec, ParamSpec, ParamValues, RecommendState, Routine, RoutineLibrary, RoutineRun, RoutineRunDetail, RoutineRunStatus, RoutineSetupState, RoutineTemplate, RoutineTrigger, View } from '../lib/types.ts';
import { Loading, PhraseLoader } from '../brand/Brand.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { coordinatorOf } from '../lib/team.ts';
import { useHashParam } from '../lib/route.ts';
import { pushRecent } from '../lib/recents.ts';

/**
 * Rotinas: trabalhos que a equipe já sabe fazer. Biblioteca (o que dá para delegar), Minhas rotinas (o que está
 * ligado, quando roda, o que entregou) e Histórico (cada execução com resultado, dados coletados e entregáveis).
 * Nada de prompt nem de configuração técnica: escolher, ajustar o horário e, se quiser, pedir ajustes a quem coordena.
 */
type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null) => void;
type Tab = 'biblioteca' | 'minhas' | 'historico';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'America/Sao_Paulo'; } })();
const STATUS: Record<RoutineRunStatus, { label: string; cls: string }> = {
  queued: { label: 'Na fila', cls: 'badge--warn' }, gathering: { label: 'Coletando dados', cls: 'badge--warn' }, running: { label: 'Executando', cls: 'badge--warn' },
  succeeded: { label: 'Concluída', cls: 'badge--ok' }, skipped: { label: 'Sem novidade', cls: '' }, failed: { label: 'Falhou', cls: 'badge--err' },
  cancelled: { label: 'Cancelada', cls: '' }, missed: { label: 'Perdida', cls: 'badge--warn' },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const MODES: Record<string, string> = { manual: 'Sob demanda', schedule: 'Agendada', event: 'Por evento', condition: 'Por condição' };
/** fase 1 ainda não pronta = vem a seguir; as outras dizem a fase do plano */
const phaseLabel = (n: number) => (n === 1 ? 'Em breve' : `Fase ${n}`);
const CONDITION: Record<string, string> = { sempre: 'Sempre analisa', novidades: 'Usa o modelo só se algo mudou', sinal: 'Usa o modelo só quando acha algo que pede atenção' };

export function RotinasView({ state, onOpenAgent, onGo }: { state: AppState; onOpenAgent: OpenAgent; onGo: (v: View) => void }) {
  const lib = useResource<RoutineLibrary>('/api/routines/library', ['routines.changed', 'integrations.changed']);
  const mine = useResource<Routine[]>('/api/routines', ['routines.changed', 'runs.changed']);
  const [tab, setTab] = useState<Tab | null>(null);
  // rotina vinda da busca (#rotinas?rotina=…): abre "Minhas rotinas" e destaca o card dela
  const [focusId] = useHashParam('rotina');
  const shown: Tab = tab ?? (focusId || mine.data?.length ? 'minhas' : 'biblioteca');
  const coord = coordinatorOf(state.agents);
  const createWithCoord = () => coord && onOpenAgent(coord.id, 'conversa', 'Quero criar uma rotina: ');
  const [setup, setSetup] = useState<{ id: string; fresh: boolean } | null>(() => { const m = location.hash.match(/preparo=(rtn_[a-f0-9]{32})/); return m ? { id: m[1], fresh: false } : null; });
  const openSetup = (id: string, fresh = false) => { history.replaceState(null, '', `#rotinas?preparo=${id}`); setSetup({ id, fresh }); };
  const closeSetup = () => { history.replaceState(null, '', '#rotinas'); setSetup(null); setTab('minhas'); mine.reload(); };
  if (setup) return <RoutineSetup key={setup.id} id={setup.id} fresh={setup.fresh} state={state} onBack={closeSetup} onGo={onGo} />;

  return (
    <div className="page rt-page">
      <header className="page__head rt-head">
        <div>
          <h2>Rotinas</h2>
          <p className="muted">Trabalhos que a sua equipe digital já sabe fazer. Escolha o que delegar: a rotina coleta os dados, chama o agente certo só quando há o que analisar e entrega o resultado pronto.</p>
        </div>
        <button className="btn btn--primary" onClick={createWithCoord} disabled={!coord} title={coord ? `Conte a ${coord.name} o que você quer que aconteça sozinho: a prévia aparece e você aprova.` : 'Ninguém coordena a equipe agora'}>
          <Icon name="chat" size={16} /> Criar rotina com {coord?.name ?? 'a coordenação'}
        </button>
      </header>
      <RecommendCard coordName={coord?.name ?? 'A coordenação'} />
      <div className="tabs" role="tablist">
        {(['biblioteca', 'minhas', 'historico'] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={shown === k} className={`tab ${shown === k ? 'tab--on' : ''}`} onClick={() => setTab(k)}>
            {{ biblioteca: 'Biblioteca', minhas: `Minhas rotinas${mine.data?.length ? ` (${mine.data.length})` : ''}`, historico: 'Histórico' }[k]}
          </button>
        ))}
      </div>
      {shown === 'biblioteca' && (lib.data ? <Library lib={lib.data} coordName={coord?.name ?? 'a coordenação'} onGo={onGo} onInstalled={(id) => openSetup(id, true)} /> : <Loading error={lib.error} />)}
      {shown === 'minhas' && (mine.data ? <Mine list={mine.data} focusId={focusId} coord={coord ?? null} onOpenAgent={onOpenAgent} onSetup={(id) => openSetup(id)} reload={mine.reload} onLibrary={() => setTab('biblioteca')} /> : <Loading error={mine.error} />)}
      {shown === 'historico' && <History routines={mine.data ?? []} onOpenAgent={onOpenAgent} />}
    </div>
  );
}

/** Recomendação inteligente: escolha consciente (lê o trabalho do workspace e usa o modelo uma vez por semana). */
function RecommendCard({ coordName }: { coordName: string }) {
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
    try { await api.post('/api/routines/recommend/run'); st.reload(); setMsg({ ok: true, text: `${coordName} está analisando. As sugestões chegam em "Aguardando você", no topo.` }); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <section className={`card feature ${s?.enabled ? 'feature--on' : 'feature--rec'} rt-rec`}>
      <header className="row">
        <h3><Icon name="auto" size={16} /> Recomendação inteligente de rotinas</h3>
        {s && (
          <button role="switch" aria-checked={s.enabled} aria-label="Recomendação inteligente de rotinas" className={`switch ${s.enabled ? 'switch--on' : ''}`} disabled={busy} onClick={toggle}>
            <span className="switch__knob" /><span className="switch__txt">{s.enabled ? 'Ligada' : 'Desligada'}</span>
          </button>
        )}
      </header>
      <p className="muted">Uma vez por semana, {coordName} olha como a equipe trabalha — tarefas que voltam, pedidos parecidos aos agentes, o que chega pelos canais — e sugere rotinas para o que hoje é feito na mão ou de improviso. As sugestões chegam para você decidir; recusadas não voltam sozinhas, mas dá para pedir de novo.</p>
      <p className="hint">Para isso, {coordName} lê os pedidos e as tarefas do workspace com o modelo de IA, uma vez por semana (consome créditos da conta conectada). Nada sai deste computador além da chamada ao modelo. Vem ligada, como todas as automações: desligue no botão se preferir.</p>
      {s?.enabled && (
        <div className="row row--wrap">
          <button className="btn btn--sm" onClick={analyze} disabled={busy || s.needsAi} title={s.needsAi ? 'Precisa de uma conta de IA conectada (Conexões)' : undefined}><Icon name="auto" size={14} /> Analisar agora</button>
          <span className="hint">{s.needsAi ? 'Conecte uma conta de IA em Conexões para as análises.' : `Última análise: ${when(s.last)} · próxima: ${when(s.next)}`}</span>
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
    </section>
  );
}

// --- Biblioteca -----------------------------------------------------------------------------------------------

function Library({ lib, coordName, onGo, onInstalled }: { lib: RoutineLibrary; coordName: string; onGo: (v: View) => void; onInstalled: (routineId: string) => void }) {
  const [open, setOpen] = useState<RoutineTemplate | null>(null);
  const [only, setOnly] = useState(false);
  // por finalidade; "só as que já dá para usar" esconde as que pedem uma conexão que ainda falta
  const usable = (r: RoutineTemplate) => r.available && r.needs.every((n) => n.ok);
  const groups = useMemo(() => Object.entries(lib.categories).map(([k, label]) => ({ key: k, label, items: lib.routines.filter((r) => r.category === k && (!only || usable(r))) }))
    .filter((g) => g.items.length), [lib, only]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = lib.routines.filter(usable).length;
  return (
    <>
      <div className="row row--wrap rt-filter">
        <span className="muted">{lib.routines.length} rotinas, todas prontas · {ready} já dá para usar agora; as outras pedem uma conexão (o cartão diz qual).</span>
        <label className="field--inline"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Só as que já dá para usar</label>
      </div>
      {groups.map((g) => (
        <section key={g.key} className="rt-group">
          <h3 className="rt-group__title">{g.label}</h3>
          <div className="rt-grid">
            {g.items.map((t) => <TemplateCard key={t.key} t={t} onOpen={() => setOpen(t)} />)}
          </div>
        </section>
      ))}
      {open && <TemplateDrawer t={open} coordName={coordName} onClose={() => setOpen(null)} onGo={onGo} onInstalled={(id) => { setOpen(null); onInstalled(id); }} />}
    </>
  );
}

function TemplateCard({ t, onOpen }: { t: RoutineTemplate; onOpen: () => void }) {
  const active = t.installed.length > 0;
  const missing = t.needs.filter((n) => !n.ok);
  return (
    <button className={`rt-card ${t.available ? '' : 'rt-card--soon'} ${active ? 'rt-card--on' : ''}`} onClick={onOpen}>
      <span className="rt-card__head">
        <b>{t.name}</b>
        {active ? <span className="badge badge--ok">Ativa</span> : t.available ? <span className="badge badge--ok">Pronta</span> : <span className="badge badge--soon">{phaseLabel(t.phase)}</span>}
      </span>
      <span className="rt-card__txt">{t.benefit}</span>
      <span className="rt-card__meta">
        <span className="rt-agents"><Icon name="users" size={12} /> {t.agentNames.join(' + ')}</span>
        {t.schedule && <span><Icon name="clock" size={12} /> {t.schedule}</span>}
      </span>
      {(missing.length > 0 || t.privateData) && (
        <span className="rt-needs">
          {missing.map((n) => <span key={n.id} className="rt-need">falta: {n.label}</span>)}
          {t.privateData && <span className="rt-need rt-need--priv"><Icon name="lock" size={11} /> dados privados: só com a sua autorização</span>}
        </span>
      )}
    </button>
  );
}

/** Dias e hora (no fuso deste computador). */
function TriggerEditor({ value, onChange, modes }: { value: RoutineTrigger; onChange: (t: RoutineTrigger) => void; modes?: string[] }) {
  const sched = value.kind === 'schedule' ? value : null;
  const canSchedule = !modes || modes.includes('schedule');
  return (
    <div className="rt-trigger">
      <div className="row row--wrap">
        <label className="field--inline"><input type="radio" checked={!sched} onChange={() => onChange({ kind: 'manual' })} /> Quando eu pedir</label>
        {canSchedule && <label className="field--inline"><input type="radio" checked={!!sched} onChange={() => onChange({ kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' })} /> Em dias e horário</label>}
      </div>
      {sched && (
        <div className="row row--wrap">
          <span className="rt-days" role="group" aria-label="Dias">
            {DAYS.map((d, i) => (
              <button key={d} type="button" className={`chip ${sched.days.includes(i) ? 'chip--on' : ''}`} aria-pressed={sched.days.includes(i)}
                onClick={() => { const days = sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort(); onChange({ ...sched, days }); }}>{d}</button>
            ))}
          </span>
          <label className="field--inline">às <input type="time" value={sched.time} onChange={(e) => e.target.value && onChange({ ...sched, time: e.target.value })} /></label>
          {!sched.days.length && <span className="hint warn">Escolha ao menos um dia.</span>}
        </div>
      )}
    </div>
  );
}

function TemplateDrawer({ t, coordName, onClose, onGo, onInstalled }: { t: RoutineTemplate; coordName: string; onClose: () => void; onGo: (v: View) => void; onInstalled: (routineId: string) => void }) {
  const [extra, setExtra] = useState('');
  const [params, setParams] = useState<ParamValues>({});
  const specs = t.params ?? [];
  const lacking = specs.filter((p) => p.required && !(params[p.key] ?? []).length);
  // pede o pedido na hora (objetivo, ata, documento): não roda sozinha logo depois de ativar
  const asksInput = !!t.input && !!(t.input.text?.required || t.input.files?.required || t.input.oneOf);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const close = () => { if (keepTyped(!!extra.trim() || Object.values(params).some((v) => v.length), 'o que você escreveu para esta rotina')) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const missing = t.needs.filter((n) => !n.ok);
  const iaMissing = missing.some((n) => n.id === 'ia');
  const install = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<Routine>('/api/routines', { template: t.key, extra: extra.trim(), tz: TZ, adapt: true, ...(specs.length ? { params } : {}) });
      onInstalled(r.id);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={t.name}>
      <div className="drawer__head">
        <span className={`badge ${t.available ? 'badge--ok' : 'badge--soon'}`}>{t.available ? 'Pronta' : phaseLabel(t.phase)}</span>
        <button className="icon-btn" onClick={close} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
      </div>
      <h3 className="drawer__title">{t.name}</h3>
      <p className="drawer__desc">{t.benefit}</p>
      <dl className="rt-facts">
        <dt>O que entrega</dt><dd>{t.produces}</dd>
        <dt>O que examina</dt><dd>{t.sources.length > 0 ? <ul>{t.sources.map((s) => <li key={s}>{s}</li>)}</ul> : t.examines}</dd>
        <dt>Quem executa</dt><dd>{t.agentNames[0]}{t.agentNames.length > 1 ? ` (apoio: ${t.agentNames.slice(1).join(', ')})` : ''}. Se sair da equipe, a coordenação assume.</dd>
        <dt>Precisa de</dt>
        <dd className="rt-needlist">
          {t.needs.map((n) => <span key={n.id} className={`badge ${n.ok ? 'badge--ok' : 'badge--warn'}`}>{n.ok ? '✓' : '○'} {n.label}</span>)}
          {missing.some((n) => ['ia', 'microsoft', 'google', 'whatsapp'].includes(n.id)) && <button className="link rt-link" onClick={() => onGo('conexoes')}>Ir para Conexões</button>}
        </dd>
        <dt>Pede a sua aprovação</dt><dd>{t.approvals}</dd>
        <dt>Modos</dt><dd>{t.modes.map((m) => MODES[m]).join(' · ')}</dd>
      </dl>
      {t.privateData && <p className="hint warn"><Icon name="lock" size={12} /> Examina comunicações ou documentos privados: fica na biblioteca, mas só começa depois que você autorizar o acesso.</p>}
      {t.sample && (
        <>
          <h4 className="rt-sub">Exemplo do resultado</h4>
          <blockquote className="rt-sample">{t.sample}</blockquote>
        </>
      )}
      {t.available ? (
        <>
          <div className="rt-adapt">
            <Icon name="auto" size={16} />
            <p>{specs.some((p) => p.required) ? 'Só diga o que acompanhar, abaixo.' : 'Não precisa configurar nada.'} Ao ativar, {coordName} estuda com o que você trabalha, o seu ritmo e o seu jeito de escrever e ajusta a rotina ao seu caso (horário, foco e formato){asksInput ? '; depois, é só executar com o pedido quando precisar' : ' — e já roda a primeira vez para você ver'}.{iaMissing ? ' Sem conta de IA, o Ergon faz esse ajuste pelo que já vê do seu trabalho.' : ''}</p>
          </div>
          {t.input && <p className="hint"><Icon name="send" size={12} /> Ao executar, você {inputHint(t.input)}.</p>}
          {specs.length > 0 && (
            <>
              <h4 className="rt-sub">O que acompanhar</h4>
              <ParamsEditor specs={specs} value={params} onChange={setParams} />
            </>
          )}
          <label className="field">Quer contar algo antes? (opcional)
            <textarea rows={2} maxLength={600} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Ex.: quero ver primeiro o que depende de mim; ignore tarefas pessoais." />
          </label>
          {err && <p className="error" role="alert">{err}</p>}
          {lacking.length > 0 && <p className="hint warn">Para rodar sozinha, preencha: {lacking.map((p) => p.label).join(', ')}. Dá para ativar agora e completar depois em Editar.</p>}
          <div className="row row--wrap">
            <button className="btn btn--primary" disabled={busy} onClick={() => void install()}>{busy ? 'Ativando…' : t.installed.length ? 'Ativar outra' : 'Ativar'}</button>
          </div>
        </>
      ) : (
        <p className="hint">{t.phase === 1 ? 'Vem a seguir, ainda nesta primeira fase do plano de rotinas' : `Chega na fase ${t.phase} do plano de rotinas`}{missing.length ? `, junto com: ${missing.map((n) => n.label).join(', ')}` : ''}. Enquanto isso, dá para pedir algo parecido na conversa com {t.agentNames[0]}.</p>
      )}
    </aside>
  );
}

// --- Minhas rotinas -------------------------------------------------------------------------------------------

function Mine({ list, focusId, coord, onOpenAgent, onSetup, reload, onLibrary }: { list: Routine[]; focusId?: string | null; coord: { id: string; name: string } | null; onOpenAgent: OpenAgent; onSetup: (id: string) => void; reload: () => void; onLibrary: () => void }) {
  const [edit, setEdit] = useState<Routine | null>(null);
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`rotina-${focusId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.classList.add('rt-item--focus');
    const t = window.setTimeout(() => el?.classList.remove('rt-item--focus'), 2400);
    return () => window.clearTimeout(t);
  }, [focusId, list.length]);
  if (!list.length) return (
    <section className="card rt-empty">
      <h3>Nenhuma rotina ligada ainda</h3>
      <p className="muted">Comece pelo <b>Briefing Diário</b>: todo dia útil de manhã, o que espera você, o que está andando e o que priorizar.</p>
      <button className="btn btn--primary" onClick={onLibrary}>Abrir a biblioteca</button>
    </section>
  );
  return (
    <>
      <div className="rt-mine">{list.map((r) => <RoutineCard key={r.id} r={r} coord={coord} onOpenAgent={onOpenAgent} onSetup={() => onSetup(r.id)} onEdit={() => { pushRecent({ kind: 'rotina', id: r.id, label: r.name, href: `#rotinas?rotina=${r.id}` }); setEdit(r); }} reload={reload} />)}</div>
      {edit && <EditDrawer r={list.find((x) => x.id === edit.id) ?? edit} coordName={coord?.name ?? 'a coordenação'} onClose={() => setEdit(null)} reload={reload} />}
    </>
  );
}

function RoutineCard({ r, coord, onOpenAgent, onSetup, onEdit, reload }: { r: Routine; coord: { id: string; name: string } | null; onOpenAgent: OpenAgent; onSetup: () => void; onEdit: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };
  const st = r.last ? STATUS[r.last.status] : null;
  const [ask, setAsk] = useState(false);
  const runNow = () => (r.input ? setAsk(true) : act(() => api.post(`/api/routines/${r.id}/run`, { clientRequestId: requestId() })));
  return (
    <article id={`rotina-${r.id}`} className={`card rt-item ${r.status === 'paused' ? 'rt-item--paused' : ''}`}>
      <header className="rt-item__head">
        <div>
          <h3>{r.name}</h3>
          <p className="muted">
            <Icon name="clock" size={12} /> {r.schedule}{r.status === 'active' && r.nextRunAt ? ` · próxima: ${when(r.nextRunAt)}` : ''}
            {' · '}executa: {r.agentName ?? '—'}{r.templateName ? '' : ' · criada na conversa'}
          </p>
        </div>
        <span className={`badge ${r.status === 'active' ? 'badge--ok' : r.status === 'setup' ? 'badge--warn' : ''}`}>{r.status === 'active' ? 'Ativa' : r.status === 'setup' ? 'Em preparo' : 'Pausada'}</span>
      </header>
      <p className="rt-item__last">
        {r.running ? <><span className="dot dot--green dot--pulse" /> Executando agora…</>
          : r.last && st ? <><span className={`badge ${st.cls}`}>{st.label}</span> {when(r.last.finished_at ?? r.last.created_at)} — {r.last.error ?? r.last.summary ?? ''}</>
            : <span className="muted">Ainda não executou.</span>}
      </p>
      {r.config.extra && <p className="hint">Ajuste: {r.config.extra}</p>}
      {r.missing.length > 0 && <p className="hint warn">Falta configurar: {r.missing.join(', ')}. <button className="link" onClick={onEdit}>Configurar</button></p>}
      {r.proposes && <p className="hint">{r.proposes === 'tarefas' ? 'As tarefas que ela propõe' : 'Os lançamentos que ela lê'} chegam em "Aguardando você": nada entra sem o seu clique.</p>}
      <div className="row row--wrap">
        {r.status === 'setup' && <button className="btn btn--sm btn--primary" onClick={onSetup}><Icon name="auto" size={13} /> Ver o preparo</button>}
        {r.status !== 'setup' && <button className="btn btn--sm btn--primary" disabled={busy || r.running} onClick={() => void runNow()}><Icon name="send" size={13} /> Executar agora</button>}
        {r.status !== 'setup' && <button className="btn btn--sm" disabled={busy} onClick={() => act(() => api.patch(`/api/routines/${r.id}`, { status: r.status === 'active' ? 'paused' : 'active', tz: TZ }))}>{r.status === 'active' ? 'Pausar' : 'Retomar'}</button>}
        <button className="btn btn--sm" onClick={onEdit}><Icon name="edit" size={13} /> Editar</button>
        {r.conversationId && r.agentId && <button className="btn btn--sm" onClick={() => onOpenAgent(r.agentId!, 'conversa', null, r.conversationId)}><Icon name="chat" size={13} /> Conversa da rotina</button>}
        {coord && <button className="btn btn--sm btn--ghost" onClick={() => (r.hasSetup ? onSetup() : onOpenAgent(coord.id, 'conversa', `Ajuste a rotina "${r.name}": `))}>Ajustar com {coord.name}</button>}
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act(() => api.post(`/api/routines/${r.id}/duplicate`))}>Duplicar</button>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => { if (confirm(`Remover a rotina "${r.name}"? O histórico continua guardado.`)) void act(() => api.del(`/api/routines/${r.id}`)); }}><Icon name="trash" size={13} /> Remover</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {ask && r.input && <RunDialog r={r} spec={r.input} onClose={() => setAsk(false)} onDone={() => { setAsk(false); reload(); }} />}
    </article>
  );
}

/** "escreve o objetivo" / "anexa as planilhas" — o que a rotina vai pedir. */
const inputHint = (s: InputSpec) => [s.text && `escreve: ${s.text.label.replace(/\?$/, '').toLowerCase()}${s.text.required ? '' : ' (opcional)'}`, s.files && `anexa: ${s.files.label.toLowerCase()}`].filter(Boolean).join(s.oneOf ? ' ou ' : ' e ');

/** Executar com o pedido: o texto (objetivo, assunto, ata) e os arquivos desta execução. */
function RunDialog({ r, spec, onClose, onDone }: { r: Routine; spec: InputSpec; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rid] = useState(requestId);
  const ref = useRef<HTMLElement>(null);
  const close = () => { if (keepTyped(!!text.trim() || files.length > 0, 'o pedido desta execução')) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const kept = r.paramSpecs.some((p) => p.kind === 'arquivos' && (r.config.params[p.key] ?? []).length);
  const can = (!spec.text?.required || text.trim()) && (!spec.files?.required || files.length || kept) && (!spec.oneOf || text.trim() || files.length);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api.post(`/api/routines/${r.id}/run`, { clientRequestId: rid, input: { ...(text.trim() ? { text: text.trim() } : {}), ...(files.length ? { files } : {}) } }); onDone(); }
    catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={`Executar ${r.name}`}>
      <div className="drawer__head"><span className="badge">executar agora</span><button className="icon-btn" onClick={close} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button></div>
      <h3 className="drawer__title">{r.name}</h3>
      {spec.text && (
        <label className="field">{spec.text.label}{spec.text.required ? '' : ' (opcional)'}
          <textarea rows={spec.oneOf ? 8 : 4} maxLength={50000} value={text} onChange={(e) => setText(e.target.value)} placeholder={spec.text.placeholder} autoFocus />
        </label>
      )}
      {spec.files && (
        <>
          <h4 className="rt-sub">{spec.files.label}{spec.files.required && !kept ? '' : ' (opcional)'}</h4>
          {kept && <p className="hint">Sem anexar nada, ela usa os arquivos que acompanha.</p>}
          <FilePicker value={files} onChange={setFiles} max={spec.files.max ?? 5} accept={spec.files.accept} />
        </>
      )}
      {spec.oneOf && <p className="hint">Basta um dos dois: o texto colado ou o arquivo.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row"><button className="btn btn--primary" disabled={busy || !can} onClick={() => void go()}>{busy ? 'Enviando…' : 'Executar'}</button><button className="btn btn--ghost" onClick={close}>Cancelar</button></div>
      <p className="hint">Documentos, e-mails e notícias são lidos como dados: o que estiver escrito neles nunca vira ordem para a equipe.</p>
    </aside>
  );
}

/** O que a rotina acompanha: listas (uma por linha ou separadas por ;), endereços https e arquivos escolhidos. */
function ParamsEditor({ specs, value, onChange }: { specs: ParamSpec[]; value: ParamValues; onChange: (v: ParamValues) => void }) {
  return (
    <div className="rt-params">
      {specs.map((p) => p.kind === 'arquivos' ? (
        <div key={p.key} className="field">
          <span>{p.label}{p.required ? '' : ' (opcional)'}</span>
          <FilePicker value={(value[p.key] ?? []).filter((x): x is FileRef => typeof x === 'object')} onChange={(f) => onChange({ ...value, [p.key]: f })} max={p.max ?? 10} />
        </div>
      ) : (
        <label key={p.key} className="field">{p.label}{p.required ? '' : ' (opcional)'}
          <textarea rows={p.kind === 'urls' ? 2 : 3} value={(value[p.key] ?? []).filter((x): x is string => typeof x === 'string').join('\n')} placeholder={p.placeholder}
            onChange={(e) => onChange({ ...value, [p.key]: e.target.value.split(/[;\n]/).map((x) => x.trim()).filter(Boolean) })} />
          <span className="hint">{p.kind === 'urls' ? 'Um endereço https por linha.' : 'Um por linha (ou separados por ponto e vírgula).'}{p.hint ? ` ${p.hint}` : ''}</span>
        </label>
      ))}
    </div>
  );
}

/** Arquivos para a rotina: os do Ergon, um novo (enviado agora) ou do OneDrive/Google Drive (procurados pelo nome). */
function FilePicker({ value, onChange, max, accept }: { value: FileRef[]; onChange: (f: FileRef[]) => void; max: number; accept?: string }) {
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
      if (!r.reads.some((x) => x.status === 'ok')) setMsg(r.reads.some((x) => x.status !== 'nao_conectada') ? 'Não consegui procurar agora (veja Conexões).' : 'Conecte Microsoft 365 ou Google em Conexões para escolher arquivos da nuvem.');
    } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="rt-files">
      {value.length > 0 && (
        <ul className="rt-files__sel">
          {value.map((f) => <li key={`${f.kind}:${f.id}`}><Icon name="folder" size={12} /> {f.name} <span className="muted small">{f.kind === 'ergon' ? 'Ergon' : f.kind === 'google' ? 'Google Drive' : 'OneDrive'}</span>
            <button className="icon-btn" aria-label={`Tirar ${f.name}`} onClick={() => onChange(value.filter((v) => !(v.kind === f.kind && v.id === f.id)))}><Icon name="x" size={12} /></button></li>)}
        </ul>
      )}
      {value.length < max && (
        <>
          <div className="row row--wrap">
            <input className="rt-files__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Procurar pelo nome" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
            <button type="button" className="btn btn--sm" disabled={busy || q.trim().length < 2} onClick={() => void search()}>Procurar na nuvem</button>
            <label className="btn btn--sm">Enviar arquivo<input type="file" hidden accept={accept} onChange={(e) => { void send(e.target.files?.[0]); e.target.value = ''; }} /></label>
          </div>
          {local.length > 0 && <ul className="rt-files__list">{local.map((a) => <li key={a.id}><button type="button" className="link" disabled={has({ kind: 'ergon', id: a.id, name: a.filename })} onClick={() => add({ kind: 'ergon', id: a.id, name: a.filename })}>{a.filename}</button> <span className="muted small">no Ergon · {when(a.created_at)}</span></li>)}</ul>}
          {cloud && (cloud.length ? <ul className="rt-files__list">{cloud.map((c) => <li key={c.id}><button type="button" className="link" onClick={() => add({ kind: c.provider, id: c.id, name: c.name })}>{c.name}</button> <span className="muted small">{c.provider === 'google' ? 'Google Drive' : c.folder} · {when(c.modified)}</span></li>)}</ul> : <p className="muted small">Nada com esse nome na nuvem.</p>)}
          <p className="hint">Word, Excel, PowerPoint, PDF com texto, CSV, XML da NF-e e extrato OFX. Arquivos da nuvem são lidos de novo a cada execução (a versão mais nova).</p>
        </>
      )}
      {msg && <p className="hint warn">{msg}</p>}
    </div>
  );
}

function EditDrawer({ r, coordName, onClose, reload }: { r: Routine; coordName: string; onClose: () => void; reload: () => void }) {
  const [name, setName] = useState(r.name);
  const [trigger, setTrigger] = useState<RoutineTrigger>(r.trigger);
  const [extra, setExtra] = useState(r.config.extra ?? '');
  const [stale, setStale] = useState(r.config.staleDays ?? 3);
  const [params, setParams] = useState<ParamValues>(r.config.params ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const versions = useResource<Array<{ version: number; name: string; schedule: string; note: string | null; created_at: string }>>(`/api/routines/${r.id}/versions`, ['routines.changed']);
  const usesStale = r.config.sources.includes('tarefas.paradas');
  const ref = useRef<HTMLElement>(null);
  const dirty = name !== r.name || JSON.stringify(trigger) !== JSON.stringify(r.trigger) || extra !== (r.config.extra ?? '') || stale !== (r.config.staleDays ?? 3) || JSON.stringify(params) !== JSON.stringify(r.config.params ?? {});
  const close = () => { if (keepTyped(dirty, 'as alterações desta rotina')) onClose(); };
  useSurface(ref, { onClose: close, outside: true });
  const save = async () => {
    if (trigger.kind === 'schedule' && !trigger.days.length) { setMsg({ ok: false, text: 'Escolha ao menos um dia, ou "Quando eu pedir".' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/routines/${r.id}`, { name: name.trim() || r.name, trigger: { ...trigger, ...(trigger.kind === 'schedule' ? { tz: TZ } : {}) }, extra: extra.trim(), ...(usesStale ? { staleDays: stale } : {}), ...(r.paramSpecs.length ? { params } : {}), tz: TZ });
      setMsg({ ok: true, text: 'Salvo (versão nova).' }); reload(); versions.reload();
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  const restore = async (v: number) => {
    setBusy(true); setMsg(null);
    try { await api.post(`/api/routines/${r.id}/restore`, { version: v }); setMsg({ ok: true, text: `Voltou para a versão ${v}.` }); reload(); versions.reload(); }
    catch (e) { setMsg({ ok: false, text: errMsg(e) }); } finally { setBusy(false); }
  };
  return (
    <aside ref={ref} className="drawer rt-drawer" role="dialog" aria-label={`Editar ${r.name}`}>
      <div className="drawer__head"><span className="badge">versão {r.version}</span><button className="icon-btn" onClick={close} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button></div>
      <h3 className="drawer__title">Editar rotina</h3>
      <label className="field">Nome<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
      <h4 className="rt-sub">Quando roda</h4>
      <TriggerEditor value={trigger} onChange={setTrigger} />
      <label className="field">Ajuste (o que esta rotina deve levar em conta)
        <textarea rows={3} maxLength={600} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Ex.: priorize pedidos de fornecedores." />
      </label>
      {usesStale && <label className="field">Considerar tarefa parada depois de (dias)<input type="number" min={1} max={60} value={stale} onChange={(e) => setStale(Number(e.target.value) || 3)} /></label>}
      {r.paramSpecs.length > 0 && <><h4 className="rt-sub">O que acompanhar</h4><ParamsEditor specs={r.paramSpecs} value={params} onChange={setParams} /></>}
      <dl className="rt-facts">
        <dt>Olha</dt><dd>{r.config.sourceLabels.join('; ')}</dd>
        <dt>Usa o modelo</dt><dd>{CONDITION[r.config.condition] ?? r.config.condition}</dd>
        <dt>Entrega</dt><dd>{r.config.deliver.map((d) => (d === 'conversa' ? 'na conversa da rotina' : 'em arquivo (.md)')).join(' e ')}{r.outputs.length ? `, com ${r.outputs.map((o) => OUTPUT[o] ?? o).join(', ')}` : ''}</dd>
        {r.input && <><dt>Ao executar</dt><dd>Você {inputHint(r.input)}.</dd></>}
      </dl>
      <p className="hint">Para mudar o que a rotina olha ou faz, peça a {coordName}: a prévia aparece e você aprova.</p>
      {msg && <p className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</p>}
      <div className="row"><button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>Salvar</button><button className="btn btn--ghost" onClick={close}>Fechar</button></div>
      <h4 className="rt-sub">Versões</h4>
      <ul className="rt-versions">
        {versions.data?.map((v) => (
          <li key={v.version}>
            <b>v{v.version}</b> · {when(v.created_at)} · {v.schedule}{v.note ? ` · ${v.note}` : ''}
            {v.version !== r.version && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void restore(v.version)}>Restaurar</button>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// --- Histórico -------------------------------------------------------------------------------------------------

function History({ routines, onOpenAgent }: { routines: Routine[]; onOpenAgent: OpenAgent }) {
  const [filter, setFilter] = useState('');
  const runs = useResource<RoutineRun[]>(`/api/routine-runs?limit=100${filter ? `&routineId=${filter}` : ''}`, ['routines.changed']);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="row row--wrap">
        <label className="field--inline">Rotina
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Todas</option>
            {routines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <span className="hint">Cada execução guarda os dados coletados (a evidência), o resultado e o consumo.</span>
      </div>
      {!runs.data ? <Loading error={runs.error} /> : !runs.data.length ? <p className="muted">Nenhuma execução ainda.</p> : (
        <div className="rt-runs">
          {runs.data.map((x) => (
            <div key={x.id} className={`rt-run ${open === x.id ? 'rt-run--open' : ''}`}>
              <button className="rt-run__row" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                <span className={`badge ${STATUS[x.status].cls}`}>{STATUS[x.status].label}</span>
                {x.verdict && <span className={`badge ${VERDICT[x.verdict].cls}`} title="Conferência da entrega">{VERDICT[x.verdict].label}</span>}
                <b>{x.name}</b>
                <span className="muted">{when(x.started_at ?? x.created_at)} · {x.trigger === 'schedule' ? 'agendada' : 'pedida'}{x.mode === 'local' ? ' · sem modelo' : x.agent ? ` · ${x.agent}` : ''}{x.tokens ? ` · ${x.tokens.toLocaleString('pt-BR')} tokens` : ''}</span>
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

const VERDICT: Record<'validado' | 'parcial' | 'reprovado', { label: string; cls: string }> = {
  validado: { label: 'dados conferidos', cls: 'badge--ok' }, parcial: { label: 'dados conferidos em parte', cls: 'badge--warn' }, reprovado: { label: 'não conferido', cls: 'badge--err' },
};
/** Cada nível do que a conferência prova, em palavras (a análise em si nunca é provada por código). */
const LEVEL: Array<[keyof EvidenceLevels, string, Record<string, [string, boolean]>]> = [
  ['coleta', 'Fontes', { completa: ['lidas por inteiro', true], parcial: ['lidas em parte', false], sem_fontes: ['não usa contas nem documentos', true] }],
  ['citacoes', 'O que o texto cita', { conferidas: ['existe nos dados', true], com_erro: ['tem item que não está nos dados', false], sem_modelo: ['montado pelo sistema', true] }],
  ['numeros', 'Números', { conferidos: ['estão nos dados (a conta do agente não é refeita)', true], com_erro: ['há número que não está nos dados', false], nao_conferidos: ['não conferidos nesta rotina', true] }],
  ['cobertura', 'Cobertura', { completa: ['tudo avisado', true], completada_pelo_ergon: ['o sistema completou o que faltou', false], nao_se_aplica: ['não se aplica', true] }],
  ['analise', 'A análise', { nao_verificada: ['não é verificada por código: leia com olho crítico', true] }],
  ['humano', 'Revisão humana', { revisao_necessaria: ['necessária antes de agir (extração por regras)', false], opcional: ['opcional', true] }],
];
const READ_STATUS: Record<string, string> = { ok: 'lida', nao_conectada: 'não conectada', sem_permissao: 'sem permissão', expirada: 'autorização vencida', erro: 'erro' };
const READ_WHAT: Record<string, string> = { agenda: 'Agenda', email: 'E-mail', tarefas: 'Tarefas', arquivos: 'Arquivos' };
const OUTPUT: Record<string, string> = { 'csv-indicadores': 'planilha de indicadores', 'csv-lancamentos': 'planilha de lançamentos', 'csv-conferencia': 'planilha da conferência',
  'csv-obrigacoes': 'calendário de obrigações', 'csv-semana': 'planilha da semana', pptx: 'apresentação (.pptx)' };

function RunDetail({ id, onOpenAgent, agentId }: { id: string; onOpenAgent: OpenAgent; agentId: string | null }) {
  const d = useResource<RoutineRunDetail>(`/api/routine-runs/${id}`, ['routines.changed']);
  if (!d.data) return <Loading error={d.error} />;
  const x = d.data;
  return (
    <div className="rt-run__detail">
      {x.output ? <div className="rt-output">{x.output}</div> : x.error ? <p className="error">{x.error}</p> : <p className="muted">{x.summary ?? 'Sem resultado.'}</p>}
      <div className="row row--wrap">
        {x.deliverables.map((dl) => dl.type === 'arquivo'
          ? <a key={dl.id} className="btn btn--sm" href={`/api/artifacts/${dl.id}/download`}><Icon name="folder" size={13} /> {dl.name}</a>
          : agentId ? <button key={dl.id} className="btn btn--sm" onClick={() => onOpenAgent(agentId, 'conversa', null, dl.id)}><Icon name="chat" size={13} /> Abrir a conversa</button> : null)}
      </div>
      {x.checks && (
        <div className="rt-checks">
          <p><span className={`badge ${x.checks.verdict ? VERDICT[x.checks.verdict].cls : ''}`}>{x.checks.verdict ? VERDICT[x.checks.verdict].label : 'sem conferência'}</span> <span className="muted">{x.checks.panel}</span></p>
          <ul className="crit">
            {x.checks.criteria.map((c) => <li key={c.id} className={c.ok ? 'crit--ok' : 'crit--no'}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span> {c.label}{c.detail ? <span className="muted"> — {c.detail}</span> : null}</li>)}
          </ul>
          {x.checks.levels && (
            <dl className="rt-levels" aria-label="O que esta conferência prova">
              {LEVEL.map(([k, label, words]) => { const [w, good] = words[x.checks!.levels![k]] ?? ['—', true]; return <div key={k}><dt>{label}</dt><dd className={good ? '' : 'warn'}>{w}</dd></div>; })}
            </dl>
          )}
          {x.checks.reads.some((r) => r.status !== 'nao_conectada') && (
            <p className="muted small">Contas: {x.checks.reads.filter((r) => r.status !== 'nao_conectada').map((r) => `${r.account === 'google' ? 'Google' : 'Microsoft'} ${READ_WHAT[r.what]}: ${READ_STATUS[r.status]}${r.status === 'ok' ? ` (${r.count})` : ''}`).join(' · ')}</p>
          )}
          {x.checks.warnings.map((w) => <p key={w} className="warn small">{w}</p>)}
        </div>
      )}
      {x.params && <RunInputLine raw={x.params} />}
      {x.facts && (
        <details className="rt-evidence">
          <summary>Dados coletados pelo sistema (evidência)</summary>
          <pre>{x.facts}</pre>
        </details>
      )}
    </div>
  );
}

/** O pedido daquela execução (o que você escreveu e os arquivos). */
function RunInputLine({ raw }: { raw: string }) {
  let x: { text?: string; files?: FileRef[] } = {};
  try { x = JSON.parse(raw); } catch { return null; }
  if (!x.text && !x.files?.length) return null;
  return <p className="muted small">Pedido: {x.text ? `"${x.text.length > 140 ? `${x.text.slice(0, 140)}…` : x.text}"` : ''}{x.files?.length ? `${x.text ? ' · ' : ''}arquivos: ${x.files.map((f) => f.name).join(', ')}` : ''}</p>;
}

// --- Preparo (ativação adaptativa) ------------------------------------------------------------------------------

const STUDY_BASE = [
  'Localizando os pergaminhos corretos…', 'Consultando o oráculo de Delfos…', 'Desenrolando papiros na Biblioteca de Alexandria…',
  'Acertando a clepsidra com o seu horário…', 'Afiando o estilete na tábua de cera…', 'Acendendo o Farol de Alexandria…', 'Pedindo licença às Musas…',
];
/** piadas de personagem: só com ele na equipe e com o nome original (num tema com outros nomes, a piada não cabe) */
const STUDY_CHAR: Array<[key: string, name: string, text: string]> = [
  ['aristoteles', 'Aristóteles', 'Aristóteles organizando tudo em categorias…'], ['hipatia', 'Hipátia', 'Hipátia cruzando as fontes…'],
  ['socrates', 'Sócrates', 'Sócrates fazendo perguntas demais (já, já ele termina)…'], ['arquimedes', 'Arquimedes', 'Arquimedes gritou "Eureka!" — conferindo se é sobre você…'],
  ['diogenes', 'Diógenes', 'Diógenes procurando, com a lanterna, um dado que faça sentido…'], ['euclides', 'Euclides', 'Euclides calculando a menor distância até o resultado…'],
  ['herodoto', 'Heródoto', 'Heródoto lendo as entrelinhas…'],
];
const studyPhrases = (agents: AppState['agents']) => [...STUDY_BASE,
  ...STUDY_CHAR.filter(([k, n]) => agents.some((a) => a.status === 'active' && a.char_key === k && a.name === n)).map(([, , t]) => t)];
const FIRST = ['Rodando a primeira vez para você ver…', 'Colhendo os dados de hoje…', 'Passando a limpo no papiro…', 'Selando o pergaminho com cera…'];

/**
 * A rotina recém-ativada: o que ela é, o andamento do preparo (com bom humor enquanto a coordenação estuda), o que foi
 * ajustado ao seu caso e o primeiro resultado — e, ao lado, a conversa com a coordenação, onde chegam as perguntas
 * (se houver) e onde dá para pedir qualquer mudança.
 */
function RoutineSetup({ id, fresh, state, onBack, onGo }: { id: string; fresh: boolean; state: AppState; onBack: () => void; onGo: (v: View) => void }) {
  const st = useResource<RoutineSetupState>(`/api/routines/${id}/setup`, ['routines.changed', 'proposals.changed', 'runs.changed']);
  // logo depois de ativar, a espera aparece por alguns segundos mesmo quando o ajuste é instantâneo (sem conta de IA)
  const [minDone, setMinDone] = useState(!fresh);
  useEffect(() => { if (fresh) { const t = window.setTimeout(() => setMinDone(true), 3800); return () => clearTimeout(t); } }, [fresh]);
  const [msg, setMsg] = useState<string | null>(null);
  const study = useMemo(() => studyPhrases(state.agents), [state.agents]);
  if (!st.data) return <div className="page"><Loading error={st.error} /></div>;
  const { routine: r, template: t, setup: s, firstRun } = st.data;
  const agent = state.agents.find((a) => a.id === s?.agentId) ?? null;
  const preparing = !s || s.status === 'studying' || s.status === 'adapting' || !minDone;
  const asking = s?.status === 'asking' && minDone;
  const ready = s?.status === 'ready' && minDone;
  const firstBusy = firstRun && ['queued', 'gathering', 'running'].includes(firstRun.status);
  // rotina que pede o pedido (objetivo, ata, documento) ou que ainda não sabe o que acompanhar: não roda sozinha ao ativar
  const asks = !!r.input && !!(r.input.text?.required || r.input.files?.required || r.input.oneOf);
  const waitsUser = (asks || r.missing.length > 0) && !firstRun;
  const [dialog, setDialog] = useState(false);
  const step = (done: boolean, now: boolean, label: string) => (
    <li className={`rt-step ${done ? 'rt-step--done' : now ? 'rt-step--now' : ''}`}><span className="rt-step__dot" aria-hidden="true">{done ? '✓' : ''}</span>{label}</li>
  );
  const again = async () => {
    if (r.input) { setDialog(true); return; }
    setMsg(null); try { await api.post(`/api/routines/${r.id}/run`, { clientRequestId: requestId() }); st.reload(); } catch (e) { setMsg(errMsg(e)); }
  };
  return (
    <div className="page rt-setup">
      <header className="rt-setup__head">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>← Rotinas</button>
        <h2>{r.name}</h2>
        <span className={`badge ${ready ? 'badge--ok' : 'badge--warn'}`}>{ready ? 'Ativa' : asking ? 'Esperando você' : 'Em preparo'}</span>
      </header>
      <div className="rt-setup__grid">
        <section className="rt-setup__main">
          <div className="card rt-setup__status">
            {preparing && <PhraseLoader phrases={study} size={92} />}
            {asking && (
              <div className="rt-setup__ask"><Icon name="chat" size={18} /><p><b>{agent?.name ?? 'A coordenação'} tem {s!.pendingQuestions > 1 ? 'duas perguntas rápidas' : 'uma pergunta rápida'}</b> antes de ligar a rotina. Responda ao lado com um clique.</p></div>
            )}
            {ready && s?.adapted && (
              <div className="rt-setup__ready">
                <h3><Icon name="auto" size={16} /> Pronta e ajustada ao seu caso</h3>
                <p>{s.adapted.summary.charAt(0).toUpperCase() + s.adapted.summary.slice(1)}.</p>
                <div className="rt-setup__chips">
                  <span className="chip"><Icon name="clock" size={12} /> {r.schedule}</span>
                  {s.adapted.changes.filter((c) => !c.startsWith('horário')).map((c) => <span key={c} className="chip">{c}</span>)}
                  <span className="chip">executa: {r.agentName}</span>
                </div>
                {s.adapted.source === 'ergon' && <p className="hint">{s.adapted.noted}. Com uma conta de IA conectada, o ajuste também lê o seu jeito de escrever e de priorizar.</p>}
              </div>
            )}
            <ol className="rt-steps">
              {step(true, false, 'Ler o que já está registrado sobre o seu trabalho')}
              {step(!!s && s.status !== 'studying' && minDone, !!s && s.status === 'studying', 'Entender com o que você trabalha e como se comunica')}
              {step(!!ready, !!s && (s.status === 'asking' || s.status === 'adapting'), 'Ajustar horário, foco e formato da rotina')}
              {waitsUser ? step(!!ready && !r.missing.length, false, r.missing.length ? 'Dizer o que acompanhar' : 'Pronta para o seu primeiro pedido')
                : step(!!ready && !!firstRun && !firstBusy, !!ready && !!firstBusy, 'Rodar a primeira vez')}
            </ol>
          </div>
          {ready && (
            <div className="card rt-first">
              <h3>{waitsUser ? 'Pronta para usar' : 'Primeiro resultado'}</h3>
              {waitsUser ? (r.missing.length
                ? <p className="hint warn">Para rodar, diga o que acompanhar: {r.missing.join(', ')} (Minhas rotinas › Editar).</p>
                : <p className="muted">Esta rotina trabalha a partir do seu pedido. Quando precisar, clique em executar e {r.input ? inputHint(r.input) : 'escreva o pedido'}.</p>)
              : !firstRun || firstBusy ? <PhraseLoader phrases={FIRST} size={56} every={2200} />
                : firstRun.output ? <div className="rt-output">{firstRun.output}</div>
                  : <p className={firstRun.error ? 'error' : 'muted'}>{firstRun.error ?? firstRun.summary ?? 'Sem resultado.'}</p>}
              <div className="row row--wrap">
                {firstRun?.deliverables.filter((d) => d.type === 'arquivo').map((d) => <a key={d.id} className="btn btn--sm" href={`/api/artifacts/${d.id}/download`}><Icon name="folder" size={13} /> {(d as { name: string }).name}</a>)}
                {!r.missing.length && <button className={`btn btn--sm ${waitsUser ? 'btn--primary' : ''}`} onClick={() => void again()} disabled={!!firstBusy}><Icon name="send" size={13} /> {waitsUser ? 'Executar agora' : 'Executar de novo'}</button>}
                <button className="btn btn--sm btn--primary" onClick={onBack}>Ir para Minhas rotinas</button>
              </div>
              {msg && <p className="error" role="alert">{msg}</p>}
              {dialog && r.input && <RunDialog r={r} spec={r.input} onClose={() => setDialog(false)} onDone={() => { setDialog(false); onBack(); }} />}
            </div>
          )}
          {t && (
            <div className="card rt-about">
              <h3>Sobre a rotina</h3>
              <p>{t.benefit}</p>
              <dl className="rt-facts">
                <dt>Entrega</dt><dd>{t.produces}</dd>
                <dt>Olha</dt><dd>{t.sources.join('; ')}</dd>
                <dt>Aprovação</dt><dd>{t.approvals}</dd>
              </dl>
              {!ready && t.sample && <><h4 className="rt-sub">Exemplo do resultado</h4><blockquote className="rt-sample">{t.sample}</blockquote></>}
              {ready && <button className="link rt-link" onClick={() => onGo('conexoes')}>Conectar mais contas deixa a rotina mais precisa</button>}
            </div>
          )}
        </section>
        <aside className="rt-setup__chat" aria-label="Conversa com a coordenação">
          {agent && s ? <ChatPanel agent={agent} embedded conversationId={s.conversationId} /> : <p className="muted">Sem coordenação ativa para conversar.</p>}
        </aside>
      </div>
    </div>
  );
}
