import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { api, setCsrf, setGuard } from './lib/api.ts';
import { startActivity } from './lib/activity.ts';
import { THEME_ICON, THEME_NEXT, rotuloDoTema, setThemeMode, useTheme } from './lib/theme.ts';
import { fmtCompacto, fmtDataHora, fmtHora, fmtMoeda, fmtNumero, tn, useIdioma, useT } from './i18n/index.ts';
import { clearResourceCache, prefetchResources, startLive, useLiveStatus, useResource } from './lib/live.ts';
import type { AppState, AuthState, Me, Usage, VersionInfo, View } from './lib/types.ts';
import { AuthFlow, AutoUnlockPrompt, LockOverlay, PersonOpenScreen, ProtectScreen, ReauthDialog } from './components/AuthFlow.tsx';
import { ErgonLogo, Splash } from './brand/Brand.tsx';
import { DecisionsPanel } from './components/DecisionsPanel.tsx';
import { Icon } from './components/Icon.tsx';
import { PausaControle } from './components/AjustesEquipe.tsx';
import { fraseCurtaDaCota } from './lib/ajustes.ts';
import { AgentWindow, type AgentHead } from './components/AgentWindow.tsx';
import { AgentesView } from './views/AgentesView.tsx';
import { AmbienteView } from './views/AmbienteView.tsx';
import { AtividadeView } from './views/OtherViews.tsx';
import { DocumentosView } from './views/DocumentosView.tsx';
import { RotinasView } from './views/RotinasView.tsx';
import { ConexoesView } from './views/ConexoesView.tsx';
import { ConfiguracaoView } from './views/ConfiguracaoView.tsx';
import { EquipeView } from './views/EquipeView.tsx';
import { TarefasView } from './views/TarefasView.tsx';
import { FocoView } from './views/FocoView.tsx';
import { AjudaView } from './views/AjudaView.tsx';
import { Onboarding } from './components/Onboarding.tsx';
import { Tour, type TourStep } from './components/Tour.tsx';
import { ViewTip } from './components/Tips.tsx';
import { initPrefs, savePrefs, usePrefs } from './lib/prefs.ts';
import { music } from './lib/music.ts';
import { MusicButton } from './components/MusicButton.tsx';
import { abrirBalao, useBalao } from './lib/balao.ts';
// só na distribuição proprietária (a Community não traz views/world): entrar com a Conta Ergon de qualquer tela
const worldLinkMod = Object.values(import.meta.glob<{ default: ComponentType<{ onClose: () => void }> }>('./views/world/WorldLinkDialog.tsx'))[0];
const WorldLinkDialog = worldLinkMod ? lazy(worldLinkMod) : null;
import { useSurface } from './lib/surface.ts';
import { CommandPalette, type CardHit, type PaletteItem } from './components/CommandPalette.tsx';
import { ConversationDock, ConversationsDialog } from './components/ConversationDock.tsx';
import { TaskDetail } from './components/TaskDetail.tsx';
import { WorkspaceSwitcher } from './components/Workspaces.tsx';
import { AccountMenu } from './components/AccountMenu.tsx';
import { onOpenCard, onOpenConversation, onOpenDecisions } from './lib/open.ts';
import { clearRecents, pushRecent, removeRecent, type Recent } from './lib/recents.ts';

type Auth = { state: 'loading' } | { state: 'out'; st: AuthState } | { state: 'in'; me: Me };
type Waiter = (ok: boolean) => void;

export function App() {
  // trocar de idioma redesenha a tela inteira na hora (sem recarregar e sem perder o que está aberto)
  useIdioma();
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [locked, setLocked] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [worldLink, setWorldLink] = useState(false);
  // boas-vindas ou tour na tela: o convite para destrancar sozinho espera terminar
  const [overlay, setOverlay] = useState(false);
  // pedidos parados esperando destrancar / confirmar a identidade (refeitos depois)
  const lockWaiters = useRef<Waiter[]>([]);
  const reauthWaiters = useRef<Waiter[]>([]);
  const release = (list: { current: Waiter[] }, ok: boolean) => { const w = list.current; list.current = []; w.forEach((f) => f(ok)); };

  const check = async () => {
    try {
      const s = await api.get<AuthState>('/api/auth/state');
      if (s.sealed || s.needsSetup || !s.authenticated) { clearResourceCache(); release(lockWaiters, false); release(reauthWaiters, false); setLocked(false); return setAuth({ state: 'out', st: s }); }
      const me = await api.get<Me>('/api/me');
      setCsrf(me.csrf);
      // o idioma da pessoa já com o dicionário baixado antes de a tela dela aparecer (nada de trocar de língua na frente dela)
      await initPrefs(me.prefs, me.user.id);
      // volume e aleatório da música são da pessoa; nada começa a tocar aqui
      music.configure(me.prefs, (p) => savePrefs(p));
      setLocked(me.locked);
      setAuth({ state: 'in', me });
    } catch { setAuth({ state: 'loading' }); window.setTimeout(() => void check(), 2000); }
  };
  useEffect(() => {
    void check();
    setGuard((code) => {
      if (code === 'locked') { setLocked(true); return new Promise<boolean>((r) => lockWaiters.current.push(r)); }
      if (code === 'reauth') { setReauth(true); return new Promise<boolean>((r) => reauthWaiters.current.push(r)); }
      if (code === 'world_link_required') { setWorldLink(true); return Promise.resolve(false); }
      void check(); // sem sessão, trancado depois de reiniciar, proteger ou 2º fator: a tela certa vem do estado
      return Promise.resolve(false);
    });
    return () => setGuard(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // tela trancada não guarda os dados das telas na memória da interface
  useEffect(() => { if (locked) clearResourceCache(); }, [locked]);
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    clearResourceCache();
    release(lockWaiters, false); release(reauthWaiters, false); setLocked(false); setReauth(false);
    void check();
  };
  if (auth.state === 'loading') return <Splash />;
  if (auth.state === 'out') return <AuthFlow key={`${auth.st.sealed}-${auth.st.needsSetup}-${auth.st.signup ?? ''}`} st={auth.st} onDone={check} />;
  const me = auth.me;
  if (!me.protected) return <ProtectScreen onDone={check} onLogout={logout} />;
  if (me.personSealed) return <PersonOpenScreen name={me.user.displayName} onDone={check} onLogout={logout} />;
  return (
    <>
      {!locked && <Shell me={me} onLogout={logout} onIdle={() => setLocked(true)} onMeChanged={check} onOverlay={setOverlay} />}
      {locked && <LockOverlay name={me.user.displayName} factors={me.factors} rpId={me.rpId} onLogout={logout} onUnlocked={() => { setLocked(false); release(lockWaiters, true); }} />}
      {me.autoUnlockPrompt && !locked && !reauth && !overlay && me.onboarding !== 'pending' && <AutoUnlockPrompt onDone={check} />}
      {worldLink && !locked && WorldLinkDialog && <Suspense fallback={null}><WorldLinkDialog onClose={() => setWorldLink(false)} /></Suspense>}
      {reauth && !locked && <ReauthDialog factors={me.factors} rpId={me.rpId} onDone={() => { setReauth(false); release(reauthWaiters, true); }} onCancel={() => { setReauth(false); release(reauthWaiters, false); }} />}
    </>
  );
}

// os nomes ficam como chave e são traduzidos na hora de mostrar (a troca de idioma redesenha o menu)
type ChaveNav = `geral.nav.${'cidade' | 'equipe' | 'rotinas' | 'fluxos' | 'tarefas' | 'documentos' | 'atividade' | 'conexoes' | 'configuracoes' | 'ajuda'}`;
const NAV: Array<{ id: View; label: ChaveNav; icon: string }> = [
  { id: 'ambiente', label: 'geral.nav.cidade', icon: 'temple' },
  { id: 'agentes', label: 'geral.nav.equipe', icon: 'users' },
  { id: 'rotinas', label: 'geral.nav.rotinas', icon: 'repeat' },
  { id: 'equipe', label: 'geral.nav.fluxos', icon: 'layers' },
  { id: 'tarefas', label: 'geral.nav.tarefas', icon: 'tasks' },
  { id: 'documentos', label: 'geral.nav.documentos', icon: 'folder' },
  { id: 'atividade', label: 'geral.nav.atividade', icon: 'activity' },
  { id: 'conexoes', label: 'geral.nav.conexoes', icon: 'plug' },
  { id: 'configuracao', label: 'geral.nav.configuracoes', icon: 'gear' },
];
/** no pé do menu: manuais, dicas e contornos */
const HELP_NAV: { id: View; label: ChaveNav; icon: string } = { id: 'ajuda', label: 'geral.nav.ajuda', icon: 'help' };

/** Tour inicial: um passo por área (os textos usam o nome de quem coordena hoje). Montado na hora, no idioma atual. */
const tourSteps = (t: ReturnType<typeof useT>, coord: string): TourStep[] => [
  { target: 'nav-ambiente', title: t('geral.nav.cidade'), text: t('geral.tour.cidade') },
  { target: 'nav-agentes', title: t('geral.nav.equipe'), text: t('geral.tour.equipe', { coord }) },
  { target: 'nav-rotinas', title: t('geral.nav.rotinas'), text: t('geral.tour.rotinas') },
  { target: 'nav-equipe', title: t('geral.nav.fluxos'), text: t('geral.tour.fluxos') },
  { target: 'nav-tarefas', title: t('geral.nav.tarefas'), text: t('geral.tour.tarefas') },
  { target: 'decisions', title: t('geral.tour.aguardando'), text: t('geral.tour.aguardandoTexto') },
  { target: 'nav-conexoes', title: t('geral.nav.conexoes'), text: t('geral.tour.conexoes') },
  { target: 'nav-ajuda', title: t('geral.nav.ajuda'), text: t('geral.tour.ajuda', { coord }) },
];

function Shell({ me, onLogout, onIdle, onMeChanged, onOverlay }: { me: Me; onLogout: () => void; onIdle: () => void; onMeChanged: () => void; onOverlay: (on: boolean) => void }) {
  const t = useT();
  const st = useResource<AppState>('/api/state', ['runs.changed', 'agents.changed', 'tasks.changed', 'rules.changed', 'city.changed', 'proposals.changed', 'integrations.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed', 'agents.changed']);
  // versão do servidor (relida ao reconectar): servidor atualizado com esta aba aberta pede recarregar
  const ver = useResource<VersionInfo>('/api/version', []);
  // ao abrir: procura versão nova (só se o aviso estiver ligado em Configurações › Atualizações) e mostra o aviso discreto
  const prefs = usePrefs();
  const [upd, setUpd] = useState<string | null>(null);
  useEffect(() => {
    if (me.mode !== 'local' || !prefs.updateNotice) { setUpd(null); return; }
    let vivo = true;
    const t = window.setTimeout(() => {
      api.get<VersionInfo>('/api/version?verificar=1').then((r) => { if (vivo) setUpd(r.updateAvailable && r.latest ? r.latest.version : null); }).catch(() => {});
    }, 1500);
    return () => { vivo = false; clearTimeout(t); };
  }, [me.mode, prefs.updateNotice]);
  const openUpdates = () => {
    setFocus(false); setCard(null);
    history.replaceState(null, '', '#configuracao?atualizacoes');
    setView('configuracao');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  // as outras telas já buscadas por baixo: trocar de menu só mostra o que está pronto
  useEffect(() => {
    const t = window.setTimeout(() => prefetchResources(['/api/boards', '/api/ai/status', '/api/ai/models', '/api/ai/tools', '/api/ai/skills', '/api/limits', '/api/integrations', '/api/conexoes', '/api/conexoes/regras', '/api/teams-app', '/api/canais',
      '/api/conversations/recent', '/api/artifacts', '/api/routines', '/api/routines/library', '/api/routines/recommend', '/api/people', '/api/packages',
      '/api/packages/catalog/official', '/api/decisions', '/api/saude', '/api/workspaces', '/api/packages/cosmetics']), 400);
    return () => clearTimeout(t);
  }, []);
  const [view, setView] = useState<View>(() => (location.hash.slice(1).split('?')[0] as View) || 'ambiente');
  // janela do agente (conversas, perfil, atividade), aberta de qualquer tela
  const [win, setWin] = useState<{ id: string; tab: 'conversa' | 'perfil' | 'atividade'; draft: string | null; conversationId: string | null; lite: AgentHead | null } | null>(null);
  // os balões da barra (Estado, Aguardando você, Workspace, Música, Conta): um aberto por vez (lib/balao.ts)
  const [decisions, setDecisions] = useBalao('decisoes');
  const [focus, setFocus] = useState(false);
  // navegação: gaveta com o menu inteiro na janela estreita; menu lateral recolhível (só ícones) na larga
  const [navOpen, setNavOpen] = useState(false);
  const [navCompact, setNavCompact] = useState(() => localPref('ergon.nav.compact') === '1');
  useEffect(() => { saveLocalPref('ergon.nav.compact', navCompact ? '1' : '0'); }, [navCompact]);
  useEffect(() => {
    // alargou a janela com a gaveta aberta: o menu lateral volta e a gaveta fecha sozinha
    const mq = matchMedia('(min-width: 901px)');
    const on = () => { if (mq.matches) setNavOpen(false); };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [statusOpen, setStatusOpen] = useBalao('estado');
  // busca rápida: Ctrl+K (Cmd+K no Mac) de qualquer lugar, ou a lupa do cabeçalho
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  // card aberto por cima de qualquer tela (de "aguardando você", de uma conversa) e o diálogo das conversas
  const [card, setCard] = useState<string | null>(null);
  const [convs, setConvs] = useState<{ agentId: string | null; conversationId: string | null } | null>(null);
  useEffect(() => onOpenCard((id) => { setDecisions(false); setCard(id); }), []);
  useEffect(() => onOpenConversation((agentId, conversationId) => { setDecisions(false); setWin(null); setConvs({ agentId, conversationId }); }), []);
  useEffect(() => onOpenDecisions(() => { setCard(null); setDecisions(true); }), []);
  // primeiro acesso (perguntas de boas-vindas) ou refazer pela Ajuda; tour inicial; objetivo contado nas perguntas
  const [onb, setOnb] = useState<'first' | 'redo' | null>(() => (me.onboarding === 'pending' && me.role === 'owner' ? 'first' : null));
  const [tour, setTour] = useState(false);
  const [goal, setGoal] = useState('');
  useEffect(() => onOverlay(!!onb || tour), [onb, tour]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useLiveStatus();
  useEffect(() => startLive(), []);
  const theme = useTheme();
  useEffect(() => startActivity(me.idleMinutes, onIdle), [me.idleMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // ir para uma área (pelo endereço) fecha a conversa ou a janela de agente aberta por cima
    const onHash = () => { const h = location.hash.slice(1).split('?')[0] as View; if ([...NAV, HELP_NAV].some((n) => n.id === h)) { setView(h); setWin(null); setConvs(null); } };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { if (location.hash.slice(1).split('?')[0] !== view) history.replaceState(null, '', `#${view}`); }, [view]);
  // a janela mais aberta (a do Coordenador: "Pedir a…") já com o perfil buscado por baixo
  const coordId = st.data?.team.coordinator?.id ?? null;
  useEffect(() => { if (coordId) prefetchResources([`/api/agents/${coordId}`, `/api/team/agents/${coordId}`]); }, [coordId]);
  const s = st.data;
  if (!s) return <Splash label={st.error ?? undefined} />;

  // a equipe sem a lista inteira: o Coordenador e uns nomes para as dicas (o resto vem por partes, em cada tela)
  const coordinator = s.team.coordinator;
  const coordLabel = coordinator?.name ?? t('geral.comum.aCoordenacao');
  // a janela abre pelo id, já com a linha leve de quem abriu (o perfil completo chega por baixo); o recente é
  // gravado pela própria janela quando o perfil chega
  const openAgent = (id: string, tab: 'conversa' | 'perfil' | 'atividade' = 'conversa', draft: string | null = null, conversationId: string | null = null, lite: AgentHead | null = null) => {
    setWin({ id, tab, draft, conversationId, lite: lite ?? (coordinator?.id === id ? coordinator : null) });
  };
  const logout = () => { clearRecents(); onLogout(); };
  const askCoordinator = (text: string) => { if (coordinator) openAgent(coordinator.id, 'conversa', text); };
  const startTour = () => { setFocus(false); setWin(null); setDecisions(false); setTour(true); };
  const endTour = () => { setTour(false); savePrefs({ tourDone: true }); };
  const tipOther = s.team.others[0]?.name ?? t('geral.comum.umAgente');
  const sim = s.executor.mode === 'simulated';

  // avisos que pedem ação: nunca somem por falta de espaço (na janela estreita viram um contador que abre o Estado)
  const alerts: Alert[] = [
    ...(sim ? [{ id: 'sem-ia', label: t('geral.alerta.semIa'), tone: 'warn' as const, title: t('geral.alerta.semIaDica'), act: () => setView('configuracao') }] : []),
    ...(ver.data && ver.data.version !== __ERGON_VERSION__ ? [{ id: 'reload', label: t('geral.alerta.novaVersao'), tone: 'warn' as const, title: t('geral.alerta.novaVersaoDica', { nova: ver.data.version, atual: __ERGON_VERSION__ }), act: () => location.reload() }] : []),
  ];
  // trocar de área limpa o endereço antes (o card aberto numa área não reabre na outra: o painel não fecha mais antes do clique)
  const go = (v: View) => { setFocus(false); setCard(null); if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`); setView(v); };
  // a busca leva a um card (quadro certo, card aberto no endereço), a uma rotina ou a um recente
  const goHash = (href: string) => { setFocus(false); location.hash = href; };
  // o quadro do recente (Fluxos da equipe ou Tarefas) a busca tira do endereço, no idioma da hora
  const openCard = (c: CardHit) => {
    const href = c.audience === 'team' ? `#equipe?card=${c.id}` : `#tarefas?board=${c.board_id}&card=${c.id}`;
    pushRecent({ kind: 'card', id: c.id, label: `#${c.number} ${c.title}`, href });
    goHash(href);
  };
  // créditos da música: Configurações rolada até eles, com o bloco aberto (de novo, se já estiver lá)
  const openCredits = () => {
    if (location.hash === '#configuracao?creditos') { setFocus(false); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    else goHash('#configuracao?creditos');
  };
  const openRoutine = (id: string, name: string) => { const href = `#rotinas?rotina=${id}`; pushRecent({ kind: 'rotina', id, label: name, href }); goHash(href); };
  const openRecent = (r: Recent) => {
    // agente que não existe mais (outro workspace, apagado): a janela fecha sozinha e o recente sai da lista
    if (r.kind === 'agente') { openAgent(r.id); return; }
    if (r.href && /^#(equipe|tarefas|rotinas)\?[a-z]+=[A-Za-z0-9_]+(&[a-z]+=[A-Za-z0-9_]+)?$/.test(r.href)) goHash(r.href);
  };
  const paletteBase: { acoes: PaletteItem[]; areas: PaletteItem[] } = {
    acoes: [
      ...(coordinator ? [{ key: 'a-pedir', label: t('geral.barra.pedirA', { nome: coordinator.name }), sub: t('geral.busca.pedirSub'), icon: 'chat', keywords: t('geral.busca.pedirPalavras'), run: () => openAgent(coordinator.id, 'conversa') }] : []),
      { key: 'a-decisoes', label: t('geral.busca.aguardando'), sub: t('geral.busca.pendentes', { n: s.decisionsPending }), icon: 'bell', keywords: t('geral.busca.aguardandoPalavras'), run: () => setDecisions(true) },
      { key: 'a-foco', label: focus ? t('geral.busca.sairDoFoco') : t('geral.barra.modoFoco'), sub: t('geral.busca.focoSub'), icon: 'focus', run: () => setFocus((f) => !f) },
      { key: 'a-estado', label: t('geral.busca.estado'), sub: t('geral.busca.estadoSub'), icon: 'pulse', keywords: t('geral.busca.estadoPalavras'), run: () => setStatusOpen(true) },
      { key: 'a-limite', label: t('geral.busca.limite'), sub: t('geral.busca.limiteSub'), icon: 'gauge', keywords: t('geral.busca.limitePalavras'), run: () => go('configuracao') },
      { key: 'a-seguranca', label: t('geral.busca.seguranca'), sub: t('geral.busca.segurancaSub'), icon: 'shield', keywords: t('geral.busca.segurancaPalavras'), run: () => goHash('#configuracao?seguranca') },
      { key: 'a-tour', label: t('geral.busca.tour'), sub: t('geral.busca.tourSub'), icon: 'compass', keywords: t('geral.busca.tourPalavras'), run: () => startTour() },
    ],
    areas: [...NAV, HELP_NAV].map((n) => ({ key: `v-${n.id}`, label: t(n.label), icon: n.icon, run: () => go(n.id) })),
  };
  const navItems = (inDrawer: boolean) => (
    <>
      {[...NAV, HELP_NAV].map((n) => (
        <button key={n.id} data-tour={inDrawer ? undefined : `nav-${n.id}`} data-autofocus={inDrawer && view === n.id ? '' : undefined} className={`nav ${n.id === HELP_NAV.id ? 'nav--foot' : ''} ${view === n.id && !focus ? 'nav--on' : ''}`}
          onClick={() => { go(n.id); if (inDrawer) setNavOpen(false); }} aria-current={view === n.id && !focus ? 'page' : undefined} title={navCompact && !inDrawer ? t(n.label) : undefined}>
          <Icon name={n.icon} /> <span className="nav__label">{t(n.label)}</span>
        </button>
      ))}
    </>
  );
  const running = s.runs.running; const queued = s.runs.queued; const pending = s.decisionsPending;

  return (
    <div className={`shell ${focus ? 'shell--focus' : ''} ${navCompact ? 'shell--compact' : ''}`}>
      {/* teclado: o primeiro Tab oferece pular o cabeçalho e o menu (WCAG 2.4.1) */}
      <button className="skip" onClick={() => document.querySelector<HTMLElement>('main.main')?.focus()}>{t('geral.barra.pularConteudo')}</button>
      <header className="topbar">
        <button className="tb-icon topbar__menu" data-keep-surface onClick={() => setNavOpen((v) => !v)} aria-label={[t('geral.barra.menu'), alerts.length ? t('geral.barra.menuAvisos', { n: alerts.length }) : '', upd ? t('geral.barra.menuAtualizacao') : ''].filter(Boolean).join(' · ')} title={t('geral.barra.menu')} aria-expanded={navOpen} aria-controls="nav-drawer">
          <Icon name="menu" size={20} />
          {/* só na janela estreita (o Estado e o aviso de versão ficam na gaveta): o menu avisa que há algo lá */}
          {(alerts.length > 0 || !!upd) && <span className="tb-badge tb-badge--warn topbar__menu-badge" aria-hidden="true">!</span>}
        </button>
        <div className="brand" title={live.status === 'ao_vivo' ? t('geral.barra.conectado', { hora: fmtHora(live.at ?? new Date(s.serverTime)) }) : live.status === 'conectando' ? t('geral.barra.conectando') : t('geral.barra.reconectando')}>
          {/* o logo leva de volta à Cidade, de qualquer tela */}
          <button type="button" className="brand__home" onClick={() => go('ambiente')} aria-label={t('geral.barra.irParaCidade')} title={t('geral.barra.cidade')}><ErgonLogo kind="horizontal" onDark height={28} /></button>
          <span className={`dot ${live.status === 'ao_vivo' ? 'dot--green' : 'dot--amber dot--pulse'}`} role="img" aria-label={live.status === 'ao_vivo' ? t('geral.barra.pontoConectado') : t('geral.barra.pontoReconectando')} />
        </div>
        <WorkspaceSwitcher current={s.workspace.name} />
        {coordinator && (
          <button className="btn btn--gold topbar__ask" onClick={() => openAgent(coordinator.id, 'conversa')} aria-label={t('geral.barra.pedirA', { nome: coordinator.name })} title={t('geral.barra.pedirDica', { nome: coordinator.name })}>
            <Icon name="chat" size={16} /><span className="topbar__ask-long">{t('geral.barra.pedirA', { nome: coordinator.name })}</span><span className="topbar__ask-short">{t('geral.barra.pedirCurto')}</span>
          </button>
        )}
        {/* busca no meio, com cara de campo; à direita, ícones do mesmo tamanho (Estado, Aguardando você, Música, Tema), o
            Modo Foco com o nome (nunca some: na janela estreita quem sai para o menu são os outros) e a conta */}
        <span className="topbar__grow">
          <button className="tb-search" data-keep-surface onClick={() => setPalette((v) => !v)} aria-label={t('geral.barra.buscar')} title={t('geral.barra.buscarDica')} aria-expanded={palette}>
            <Icon name="search" size={16} /><span className="tb-search__txt">{t('geral.barra.buscarCampo')}</span><kbd className="tb-search__kbd">Ctrl K</kbd>
          </button>
        </span>
        {upd && (
          <button className="tb-upd" onClick={openUpdates} aria-label={t('geral.barra.atualizacaoAria', { versao: upd })} title={t('geral.barra.atualizacaoDica', { versao: upd })}>
            <Icon name="download" size={14} /><span className="tb-upd__txt">{t('geral.barra.atualizacao')}</span>
          </button>
        )}
        {/* rc.27: equipe em pausa, sempre à vista na barra de cima; abre o Estado, onde se retoma */}
        {s.teamPausa?.pausada && (
          <button className="tb-upd tb-pausa" data-keep-surface onClick={() => setStatusOpen(true)} aria-label={t('configuracoes.ajustes.pausa.dica')} title={t('configuracoes.ajustes.pausa.dica')}>
            <Icon name="pause" size={14} /><span className="tb-upd__txt">{t('configuracoes.ajustes.pausa.emPausa')}</span>
          </button>
        )}
        <span className="topbar__icons">
          <span className="topbar__statuswrap">
            <button className={`tb-icon ${statusOpen ? 'is-on' : ''}`} data-keep-surface onClick={() => setStatusOpen((v) => !v)} aria-expanded={statusOpen}
              aria-label={`${t('geral.estado.rotulo')}: ${[t('geral.estado.emExecucao', { n: running }), queued ? t('geral.estado.naFila', { n: queued }) : ''].filter(Boolean).join(', ')}${alerts.length ? `; ${t('geral.estado.avisos', { n: alerts.length })}: ${alerts.map((a) => a.label).join(', ')}` : ''}`}
              title={[running ? t('geral.estado.emExecucao', { n: running }) : queued ? t('geral.estado.naFila', { n: queued }) : t('geral.estado.nadaEmExecucao'), ...alerts.map((a) => a.label)].join(' · ')}>
              <Icon name="activity" size={18} />
              {alerts.length > 0 ? <span className="tb-badge tb-badge--warn">!</span>
                : (running > 0 || queued > 0) && <span className={`tb-dot ${running ? 'tb-dot--green' : 'tb-dot--amber'}`} />}
            </button>
            {/* o Estado é um balão abaixo do botão; os avisos (simulação, atualização) aparecem lá */}
            {statusOpen && (
              <StatusPanel onClose={() => setStatusOpen(false)} live={live.status} runs={s.runs} capacity={s.capacity} usage={usage.data} alerts={alerts} pausa={s.teamPausa} onPausa={st.reload}
                onAct={(a) => { setStatusOpen(false); a.act(); }} />
            )}
          </span>
          <button data-tour="decisions" data-keep-surface className={`tb-icon ${decisions ? 'is-on' : ''}`} onClick={() => setDecisions((v) => !v)} aria-expanded={decisions}
            aria-label={t('geral.decisoes.aguardando', { n: pending })} title={t('geral.decisoes.aguardando', { n: pending })}>
            <Icon name="bell" size={18} />{pending > 0 && <span className="tb-badge">{pending > 99 ? '99+' : pending}</span>}
          </button>
          <MusicButton onCredits={openCredits} />
          <button className="tb-icon topbar__theme" onClick={() => setThemeMode(THEME_NEXT[theme.mode])} aria-label={rotuloDoTema(theme.mode)} title={rotuloDoTema(theme.mode)}>
            <Icon name={THEME_ICON[theme.mode]} size={18} />
          </button>
          <button className={`tb-pill topbar__focus ${focus ? 'is-on' : ''}`} onClick={() => setFocus((f) => !f)} aria-pressed={focus} title={focus ? t('geral.barra.sairDoFoco') : t('geral.barra.modoFocoDica')}>
            <Icon name="focus" size={16} /><span className="topbar__focus-txt">{t('geral.barra.modoFoco')}</span>
          </button>
          <span className="topbar__sep" aria-hidden="true" />
          <AccountMenu me={me} onLogout={logout} onAccount={() => goHash('#configuracao?conta')} />
        </span>
      </header>

      {!focus && (
        <nav className="sidebar" aria-label={t('geral.nav.aria')}>
          {navItems(false)}
          <button className="nav nav--collapse" onClick={() => setNavCompact((v) => !v)} aria-pressed={navCompact} title={navCompact ? t('geral.nav.mostrarNomes') : t('geral.nav.recolherDica')}>
            <Icon name={navCompact ? 'chevron-right' : 'chevron-left'} /> <span className="nav__label">{t('geral.nav.recolher')}</span>
          </button>
        </nav>
      )}
      {navOpen && (
        <NavDrawer onClose={() => setNavOpen(false)}>
          {navItems(true)}
          {/* o que o cabeçalho não mostra nas janelas mais estreitas continua aqui */}
          <div className="navdrawer__foot">
            <button className="nav" onClick={() => { setNavOpen(false); setPalette(true); }}><Icon name="search" /> <span className="nav__label">{t('geral.nav.buscar')} <span className="nav__hint">(Ctrl+K)</span></span></button>
            <button className="nav" onClick={() => { setNavOpen(false); setStatusOpen(true); }}><Icon name="pulse" /> <span className="nav__label">{[t('geral.nav.estado'), running ? t('geral.estado.emExecucao', { n: running }) : '', alerts.length ? t('geral.estado.avisos', { n: alerts.length }) : ''].filter(Boolean).join(' · ')}</span></button>
            {/* na janela mais estreita o seletor de workspace sai da barra: o balão dele abre daqui */}
            <button className="nav" onClick={() => { setNavOpen(false); abrirBalao('workspace'); }}><Icon name="layers" /> <span className="nav__label">{t('geral.nav.workspace', { nome: s.workspace.name })}</span></button>
            {upd && <button className="nav" onClick={() => { setNavOpen(false); openUpdates(); }}><Icon name="download" /> <span className="nav__label">{t('geral.nav.atualizacao')} <span className="nav__hint">{t('geral.nav.atualizacaoVersao', { versao: upd })}</span></span></button>}
            <button className="nav" onClick={() => setThemeMode(THEME_NEXT[theme.mode])}><Icon name={THEME_ICON[theme.mode]} /> <span className="nav__label">{rotuloDoTema(theme.mode, true)}</span></button>
            <button className="nav" onClick={logout}><Icon name="logout" /> <span className="nav__label">{t('geral.nav.sair', { nome: me.user.displayName })}</span></button>
          </div>
        </NavDrawer>
      )}

      <main className="main" tabIndex={-1}>
        {/* a cidade fica sempre montada: em outra área, oculta e viva em segundo plano */}
        <div className="keep" hidden={focus || view !== 'ambiente'}>
          <AmbienteView state={s} onNavigate={setView} selectedId={selected} onSelect={setSelected} reload={st.reload} active={!focus && view === 'ambiente'} />
        </div>
        {focus ? (
          <FocoView state={s} selectedId={selected} onSelect={setSelected} onOpenAgent={openAgent} onAskCoordinator={askCoordinator}
            onExit={() => setFocus(false)} onGo={(v) => { setFocus(false); setView(v); }} />
        ) : view === 'ambiente' ? null : view === 'agentes' ? (
          <AgentesView state={s} onOpen={(id, tab, lite) => openAgent(id, tab, null, null, lite ?? null)} />
        ) : view === 'equipe' ? (
          <EquipeView state={s} onAskCoordinator={askCoordinator} reload={st.reload} />
        ) : view === 'tarefas' ? (
          <TarefasView onGo={setView} />
        ) : view === 'rotinas' ? (
          <RotinasView coord={coordinator} onOpenAgent={openAgent} onGo={setView} />
        ) : view === 'documentos' ? (
          <DocumentosView coord={coordLabel} />
        ) : view === 'conexoes' ? (
          <ConexoesView />
        ) : view === 'ajuda' ? (
          <AjudaView state={s} onGo={setView} onTour={startTour} onRedo={me.role === 'owner' ? () => setOnb('redo') : undefined} />
        ) : view === 'configuracao' ? (
          <ConfiguracaoView state={s} me={me} onMeChanged={onMeChanged} reload={() => { st.reload(); usage.reload(); }} />
        ) : (
          <AtividadeView onOpenAgent={(id, tab) => openAgent(id, tab)} />
        )}
      </main>
      {/* conversas por baixo; o perfil aberto dali vem por cima e, ao fechar, volta para a conversa */}
      {convs && <ConversationsDialog coordinator={coordinator} scope={s.workspace.id} initial={convs} onClose={() => setConvs(null)} onOpenAgent={(id, tab, lite) => openAgent(id, tab, null, null, lite ?? null)} />}
      {win && <AgentWindow key={`${win.id}-${win.conversationId ?? ''}`} agentId={win.id} initial={win.lite} coordName={coordLabel} sectors={s.sectors} initialTab={win.tab} draft={win.draft} conversationId={win.conversationId}
        onClose={() => setWin(null)} onGone={() => { removeRecent('agente', win.id); setWin(null); }} />}
      {!focus && !onb && !tour && <ViewTip view={view} coord={coordLabel} other={tipOther} onTour={startTour} />}
      {onb && (
        <Onboarding displayName={me.user.displayName} workspaceName={s.workspace.name} redo={onb === 'redo'} onCancel={() => setOnb(null)}
          onFinish={({ tour: t, goal: g }) => { setOnb(null); setGoal(g); onMeChanged(); st.reload(); if (t) startTour(); }} />
      )}
      {tour && (
        <Tour steps={tourSteps(t, coordLabel)} onClose={endTour} final={(close) => (
          <div className="tour__final">
            <h3>{t('geral.tour.pronto')}</h3>
            <p>{coordinator ? <>{tn('geral.tour.conversarCom', { nome: <b>{coordinator.name}</b> })} {goal ? t('geral.tour.objetivoEscrito') : t('geral.tour.conteObjetivo')}</> : t('geral.tour.explore')}</p>
            <div className="tour__nav">
              <button className="btn btn--sm" onClick={close}>{t('geral.tour.explorarSozinho')}</button>
              <span className="tour__grow" />
              {coordinator && <button className="btn btn--sm btn--primary" autoFocus onClick={() => { close(); openAgent(coordinator.id, 'conversa', goal ? t('geral.tour.mensagemObjetivo', { objetivo: goal }) : null); }}><Icon name="chat" size={14} /> {t('geral.tour.conversarBotao', { nome: coordinator.name })}</button>}
            </div>
          </div>
        )} />
      )}
      {palette && (
        <CommandPalette base={paletteBase} onAgent={(a) => openAgent(a.id, 'conversa', null, null, a)} onCard={openCard} onRoutine={openRoutine} onRecent={openRecent} onClose={() => setPalette(false)} />
      )}
      {decisions && <DecisionsPanel onClose={() => setDecisions(false)} onOpenAgent={(...a) => { setDecisions(false); openAgent(...a); }} onGo={(v) => { setDecisions(false); setView(v); }} />}
      {card && <TaskDetail key={card} taskId={card} mode="auto" over onClose={() => setCard(null)} onAskCoordinator={(t) => { setCard(null); setConvs(null); askCoordinator(t); }} />}
      <ConversationDock coordinator={coordinator} hidden={!!convs || !!win || focus || tour || !!onb} />

    </div>
  );
}

/** Aviso que pede ação (simulação, versão nova, atualização, frase de recuperação). */
interface Alert { id: string; label: string; tone: 'warn' | 'attn'; title: string; act: () => void }

const localPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const saveLocalPref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento: vale só nesta visita */ } };

/** Menu inteiro na janela estreita: abre pelo botão do cabeçalho; fecha ao escolher, no Esc ou clicando fora. */
function NavDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  return (
    <div className="navdrawer-back">
      <nav ref={ref} id="nav-drawer" className="navdrawer" aria-label={t('geral.barra.menu')}>
        <div className="navdrawer__head">
          <ErgonLogo kind="horizontal" onDark height={26} />
          <button className="icon-btn" onClick={onClose} aria-label={t('geral.nav.fecharMenu')} title={t('geral.comum.fechar')}><Icon name="x" /></button>
        </div>
        {children}
      </nav>
    </div>
  );
}

/**
 * Estado do Ergon, sob demanda: o que está rodando, a capacidade, o consumo (só o que a conta informa) e os avisos.
 * Antes, tudo isso disputava o cabeçalho com "Aguardando você"; na janela estreita, parte sumia sem aviso.
 */
function StatusPanel({ onClose, live, runs, capacity, usage, alerts, onAct, pausa, onPausa }: {
  onClose: () => void; live: string; runs: AppState['runs']; capacity: AppState['capacity']; usage: Usage | null; alerts: Alert[]; onAct: (a: Alert) => void;
  pausa: AppState['teamPausa']; onPausa: () => void;
}) {
  const t = useT();
  const [erroPausa, setErroPausa] = useState<string | null>(null);
  const cota = fraseCurtaDaCota(usage?.accounts);
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, outside: true });
  return (
    <aside ref={ref} className="status-pop" role="dialog" aria-labelledby="status-title">
      <div className="drawer__head"><h3 className="drawer__title" id="status-title">{t('geral.estado.titulo')}</h3><button className="icon-btn" onClick={onClose} aria-label={t('geral.comum.fechar')} title={t('geral.comum.fechar')}><Icon name="x" /></button></div>
      {alerts.length > 0 && (
        <section className="block">
          <h4>{t('geral.estado.alertas')}</h4>
          <div className="status-panel__alerts">
            {alerts.map((a) => (
              <button key={a.id} className="dec-link" onClick={() => onAct(a)}><span><b>{a.label}</b><br /><span className="muted small">{a.title}</span></span><Icon name="chevron-right" size={14} /></button>
            ))}
          </div>
        </section>
      )}
      <section className="block">
        <h4>{t('geral.estado.agora')}</h4>
        <div className="kv">
          <span>{t('geral.estado.processos')}</span><b>{t('geral.estado.trabalhando', { n: runs.processes })} <span className="muted">({runs.limit.limit === null ? t('geral.estado.semLimite') : t('geral.estado.ateLimite', { limite: fmtNumero(runs.limit.limit) })})</span>{runs.cardsWaiting ? <> · {t('geral.estado.cardsEsperando', { n: runs.cardsWaiting })}</> : null}</b>
          <span>{t('geral.estado.conversas')}</span><b>{t('geral.estado.conversasLivres')} <span className="muted">{t('geral.estado.foraDoLimite')}</span></b>
          <span>{t('geral.estado.equipe')}</span><b>{t('geral.estado.agentes', { n: capacity.active })} · {t('geral.estado.vagas', { n: capacity.slots })}</b>
          <span>{t('geral.estado.servidor')}</span><b>{live === 'ao_vivo' ? t('geral.estado.conectado') : t('geral.estado.reconectando')}</b>
        </div>
        {/* rc.27: pausar e retomar a equipe (nenhum trabalho novo começa; o que está andando termina) */}
        <PausaControle pausa={pausa} onMudou={onPausa} onError={setErroPausa} />
        {erroPausa && <p className="error" role="alert">{erroPausa}</p>}
      </section>
      <section className="block">
        <h4>{t('geral.consumo.titulo')}</h4>
        <div className="row row--wrap"><UsageChips usage={usage} /></div>
        {cota && <p className="status-pop__cota">{cota}</p>}
        <p className="hint">{t('geral.consumo.nota')}</p>
      </section>
    </aside>
  );
}

// no idioma da tela: 1,2 mi · 3,4 mil / 1.2M · 3.4K; US$ 1,50 / $1.50
const fmtTokens = (n: number) => (n >= 1e3 ? fmtCompacto(n) : fmtNumero(n));
const fmtUsd = (v: number) => fmtMoeda(v, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });

/**
 * Consumo: tokens sempre (mês ⇄ ano, com um clique). Custo só quando a conta informa o valor cobrado —
 * assinatura (ChatGPT) não tem custo por uso, então o chip some. Limites de plano só quando informados.
 */
// a nota pela forma de cobrança: a nota pronta que o servidor manda vem sempre em português
const NOTA_COBRANCA = {
  subscription: 'geral.consumo.notaAssinatura', credits: 'geral.consumo.notaCreditos', api: 'geral.consumo.notaApi', none: 'geral.consumo.notaSem',
} as const satisfies Record<Usage['billing'], string>;

function UsageChips({ usage }: { usage: Usage | null }) {
  const t = useT();
  const [year, setYear] = useState(false);
  if (!usage) return null;
  const p = year ? usage.year : usage.month; const label = year ? t('geral.consumo.ano') : t('geral.consumo.mes');
  const outro = year ? t('geral.consumo.mes') : t('geral.consumo.ano');
  const tokens = p.tokensIn + p.tokensOut;
  const sub = usage.subscription;
  return (
    <>
      <button className="chip chip--stat" onClick={() => setYear((v) => !v)} aria-pressed={year}
        title={t('geral.consumo.tokensDica', { periodo: label, entrada: fmtNumero(p.tokensIn), saida: fmtNumero(p.tokensOut), n: p.runs, nota: t(NOTA_COBRANCA[usage.billing]), outro })}>
        <Icon name="token" size={14} /> {t('geral.consumo.tokens', { qtd: fmtTokens(tokens) })} <span className="muted">· {label}</span>
      </button>
      {usage.costVisible && (
        <button className={`chip chip--stat ${p.costUsd === null ? 'chip--muted' : ''}`} onClick={() => setYear((v) => !v)} aria-pressed={year}
          title={p.costUsd === null ? t('geral.consumo.semCusto', { periodo: label }) : t('geral.consumo.custoDica', { n: p.runsWithCost, periodo: label })}>
          <Icon name="coins" size={14} /> {p.costUsd === null ? t('geral.consumo.custoVazio') : fmtUsd(p.costUsd)} <span className="muted">· {label}</span>
        </button>
      )}
      {sub?.windows.map((w) => (
        <span key={w.label} className="chip chip--stat" title={w.resetsAt ? t('geral.consumo.limiteRenova', { provedor: sub.provider, janela: w.label, quando: fmtDataHora(w.resetsAt) }) : t('geral.consumo.limite', { provedor: sub.provider, janela: w.label })}>
          <Icon name="clock" size={14} /> {w.label} <span className="meter"><span style={{ width: `${Math.min(100, w.usedPercent)}%` }} /></span> {Math.round(w.usedPercent)}%
        </span>
      ))}
    </>
  );
}
