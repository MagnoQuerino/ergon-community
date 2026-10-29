import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { api, setCsrf, setGuard } from './lib/api.ts';
import { startActivity } from './lib/activity.ts';
import { clearResourceCache, prefetchResources, startLive, useLiveStatus, useResource } from './lib/live.ts';
import type { AppState, AuthState, Me, Usage, VersionInfo, View } from './lib/types.ts';
import { AuthFlow, AutoUnlockPrompt, LockOverlay, PersonOpenScreen, ProtectScreen, ReauthDialog } from './components/AuthFlow.tsx';
import { ErgonLogo, Splash } from './brand/Brand.tsx';
import { DecisionsPanel } from './components/DecisionsPanel.tsx';
import { Icon } from './components/Icon.tsx';
import { AgentWindow } from './components/AgentWindow.tsx';
import { AgentesView } from './views/AgentesView.tsx';
import { AmbienteView } from './views/AmbienteView.tsx';
import { AtividadeView } from './views/OtherViews.tsx';
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
import { initPrefs, savePrefs } from './lib/prefs.ts';
// só na distribuição proprietária (a Community não traz views/world): entrar com a Conta Ergon de qualquer tela
const worldLinkMod = Object.values(import.meta.glob<{ default: ComponentType<{ onClose: () => void }> }>('./views/world/WorldLinkDialog.tsx'))[0];
const WorldLinkDialog = worldLinkMod ? lazy(worldLinkMod) : null;
import { useSurface } from './lib/surface.ts';
import { coordinatorOf } from './lib/team.ts';
import { CommandPalette, type CardHit, type PaletteItem } from './components/CommandPalette.tsx';
import { ConversationDock, ConversationsDialog } from './components/ConversationDock.tsx';
import { TaskDetail } from './components/TaskDetail.tsx';
import { WorkspaceSwitcher } from './components/Workspaces.tsx';
import { AccountMenu } from './components/AccountMenu.tsx';
import { onOpenCard, onOpenConversation, onOpenDecisions } from './lib/open.ts';
import { clearRecents, pushRecent, type Recent } from './lib/recents.ts';

type Auth = { state: 'loading' } | { state: 'out'; st: AuthState } | { state: 'in'; me: Me };
type Waiter = (ok: boolean) => void;

export function App() {
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
      initPrefs(me.prefs);
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

const NAV: Array<{ id: View; label: string; icon: string }> = [
  { id: 'ambiente', label: 'Ambiente', icon: 'temple' },
  { id: 'agentes', label: 'Agentes', icon: 'users' },
  { id: 'rotinas', label: 'Rotinas', icon: 'repeat' },
  { id: 'equipe', label: 'Fluxos da equipe', icon: 'layers' },
  { id: 'tarefas', label: 'Tarefas', icon: 'tasks' },
  { id: 'atividade', label: 'Atividade', icon: 'activity' },
  { id: 'conexoes', label: 'Conexões', icon: 'plug' },
  { id: 'configuracao', label: 'Configurações', icon: 'gear' },
];
/** no pé do menu: manuais, dicas e contornos */
const HELP_NAV = { id: 'ajuda' as View, label: 'Ajuda', icon: 'help' };

/** Tour inicial: um passo por área (os textos usam o nome de quem coordena hoje). */
const tourSteps = (coord: string): TourStep[] => [
  { target: 'nav-ambiente', title: 'Ambiente', text: `A cidade da sua equipe. Cada pessoa nas construções é um agente; clique em alguém para conversar.` },
  { target: 'nav-agentes', title: 'Agentes', text: `Veja e edite cada agente: nome, função, setor, instruções, ferramentas e história. Ou peça a ${coord}.` },
  { target: 'nav-rotinas', title: 'Rotinas', text: 'Trabalhos que se repetem sozinhos, como o Briefing Diário. Ao ativar, a rotina se adapta ao seu jeito.' },
  { target: 'nav-equipe', title: 'Fluxos da equipe', text: 'O quadro onde os agentes trabalham: cada card tem responsável e o histórico do que foi feito.' },
  { target: 'nav-tarefas', title: 'Tarefas', text: 'As suas tarefas. Quando quiser ajuda, envie qualquer uma para a equipe.' },
  { target: 'decisions', title: 'Aguardando você', text: 'Tudo que precisa da sua decisão: propostas da equipe, perguntas e sugestões. Nada importante muda sem o seu clique.' },
  { target: 'nav-conexoes', title: 'Conexões', text: 'Conecte a sua conta de IA (sem ela, as respostas são simuladas), e-mail, WhatsApp e quadros de tarefas.' },
  { target: 'nav-ajuda', title: 'Ajuda', text: `Manuais, dicas e contornos para quando algo não sair como esperado. E ${coord} sempre pode ajudar na conversa.` },
];

function Shell({ me, onLogout, onIdle, onMeChanged, onOverlay }: { me: Me; onLogout: () => void; onIdle: () => void; onMeChanged: () => void; onOverlay: (on: boolean) => void }) {
  const st = useResource<AppState>('/api/state', ['runs.changed', 'agents.changed', 'tasks.changed', 'rules.changed', 'city.changed', 'proposals.changed', 'integrations.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed', 'agents.changed']);
  // versão do servidor (relida ao reconectar): servidor atualizado com esta aba aberta pede recarregar
  const ver = useResource<VersionInfo>('/api/version', []);
  // as outras telas já buscadas por baixo: trocar de menu só mostra o que está pronto
  useEffect(() => {
    const t = window.setTimeout(() => prefetchResources(['/api/boards', '/api/ai/status', '/api/ai/models', '/api/ai/tools', '/api/ai/skills', '/api/limits', '/api/integrations',
      '/api/conversations/recent', '/api/artifacts', '/api/routines', '/api/routines/library', '/api/routines/recommend', '/api/people', '/api/packages',
      '/api/packages/catalog/official', '/api/decisions', '/api/saude', '/api/workspaces', '/api/packages/cosmetics']), 400);
    return () => clearTimeout(t);
  }, []);
  const [view, setView] = useState<View>(() => (location.hash.slice(1).split('?')[0] as View) || 'ambiente');
  // janela do agente (conversas, perfil, atividade), aberta de qualquer tela
  const [win, setWin] = useState<{ id: string; tab: 'conversa' | 'perfil' | 'atividade'; draft: string | null; conversationId: string | null } | null>(null);
  const [decisions, setDecisions] = useState(false);
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
  const [statusOpen, setStatusOpen] = useState(false);
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
  useEffect(() => startActivity(me.idleMinutes, onIdle), [me.idleMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // ir para uma área (pelo endereço) fecha a conversa ou a janela de agente aberta por cima
    const onHash = () => { const h = location.hash.slice(1).split('?')[0] as View; if ([...NAV, HELP_NAV].some((n) => n.id === h)) { setView(h); setWin(null); setConvs(null); } };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { if (location.hash.slice(1).split('?')[0] !== view) history.replaceState(null, '', `#${view}`); }, [view]);
  const s = st.data;
  if (!s) return <Splash label={st.error ?? undefined} />;

  const openAgent = (id: string, tab: 'conversa' | 'perfil' | 'atividade' = 'conversa', draft: string | null = null, conversationId: string | null = null) => {
    const a = s.agents.find((x) => x.id === id);
    if (a) pushRecent({ kind: 'agente', id, label: a.name, where: a.role });
    setWin({ id, tab, draft, conversationId });
  };
  const logout = () => { clearRecents(); onLogout(); };
  const coordinator = coordinatorOf(s.agents);
  const coordLabel = coordinator?.name ?? 'a coordenação';
  const askCoordinator = (text: string) => { if (coordinator) openAgent(coordinator.id, 'conversa', text); };
  const startTour = () => { setFocus(false); setWin(null); setDecisions(false); setTour(true); };
  const endTour = () => { setTour(false); savePrefs({ tourDone: true }); };
  const tipOther = s.agents.find((a) => a.status === 'active' && a.id !== coordinator?.id)?.name ?? 'um agente';
  const winAgent = win ? s.agents.find((a) => a.id === win.id) ?? null : null;
  const sim = s.executor.mode === 'simulated';

  // avisos que pedem ação: nunca somem por falta de espaço (na janela estreita viram um contador que abre o Estado)
  const alerts: Alert[] = [
    ...(sim ? [{ id: 'sim', label: 'SIMULAÇÃO', tone: 'warn' as const, title: 'As respostas dos agentes são simuladas até uma conta de IA ser conectada — a melhor escolha é a assinatura Nous. Veja Configurações.', act: () => setView('configuracao') }] : []),
    ...(ver.data && ver.data.version !== __ERGON_VERSION__ ? [{ id: 'reload', label: 'NOVA VERSÃO · RECARREGAR', tone: 'warn' as const, title: `O Ergon foi atualizado para a versão ${ver.data.version}. Esta aba ainda está com a ${__ERGON_VERSION__}.`, act: () => location.reload() }] : []),
    ...(ver.data?.updateAvailable && ver.data.version === __ERGON_VERSION__ ? [{ id: 'update', label: `ATUALIZAÇÃO ${ver.data.latest?.version ?? ''}`, tone: 'attn' as const, title: `Versão ${ver.data.latest?.version} disponível. Veja Configurações.`, act: () => setView('configuracao') }] : []),
  ];
  // trocar de área limpa o endereço antes (o card aberto numa área não reabre na outra: o painel não fecha mais antes do clique)
  const go = (v: View) => { setFocus(false); setCard(null); if (location.hash.slice(1) !== v) history.replaceState(null, '', `#${v}`); setView(v); };
  // a busca leva a um card (quadro certo, card aberto no endereço), a uma rotina ou a um recente
  const goHash = (href: string) => { setFocus(false); location.hash = href; };
  const openCard = (t: CardHit) => {
    const href = t.audience === 'team' ? `#equipe?card=${t.id}` : `#tarefas?board=${t.board_id}&card=${t.id}`;
    pushRecent({ kind: 'card', id: t.id, label: `#${t.number} ${t.title}`, where: t.audience === 'team' ? 'Fluxos da equipe' : 'Tarefas', href });
    goHash(href);
  };
  const openRoutine = (id: string, name: string) => { const href = `#rotinas?rotina=${id}`; pushRecent({ kind: 'rotina', id, label: name, href }); goHash(href); };
  const openRecent = (r: Recent) => {
    if (r.kind === 'agente') { if (s.agents.some((a) => a.id === r.id)) openAgent(r.id); return; }
    if (r.href && /^#(equipe|tarefas|rotinas)\?[a-z]+=[A-Za-z0-9_]+(&[a-z]+=[A-Za-z0-9_]+)?$/.test(r.href)) goHash(r.href);
  };
  const paletteBase: { acoes: PaletteItem[]; areas: PaletteItem[] } = {
    acoes: [
      ...(coordinator ? [{ key: 'a-pedir', label: `Pedir a ${coordinator.name}`, sub: 'Encaminha a quem faz', icon: 'chat', keywords: 'conversar perguntar', run: () => openAgent(coordinator.id, 'conversa') }] : []),
      { key: 'a-decisoes', label: 'Aguardando você', sub: `${s.decisionsPending} pendente(s)`, icon: 'bell', keywords: 'decisoes propostas aprovar', run: () => setDecisions(true) },
      { key: 'a-foco', label: focus ? 'Sair do Modo foco' : 'Modo foco', sub: 'O trabalho sem a cidade', icon: 'focus', run: () => setFocus((f) => !f) },
      { key: 'a-estado', label: 'Estado do Ergon', sub: 'Processos, consumo e avisos', icon: 'pulse', keywords: 'execucoes consumo', run: () => setStatusOpen(true) },
      { key: 'a-limite', label: 'Trabalhos ao mesmo tempo', sub: 'Configurações › Andamento da equipe', icon: 'gauge', keywords: 'limite concorrencia fila', run: () => go('configuracao') },
      { key: 'a-seguranca', label: 'Segurança', sub: 'Configurações › Segurança', icon: 'shield', keywords: 'senha frase recuperacao', run: () => goHash('#configuracao?seguranca') },
      { key: 'a-tour', label: 'Fazer o tour', sub: 'Uma volta rápida pelas áreas', icon: 'compass', keywords: 'ajuda', run: () => startTour() },
    ],
    areas: [...NAV, HELP_NAV].map((n) => ({ key: `v-${n.id}`, label: n.label, icon: n.icon, run: () => go(n.id) })),
  };
  const paletteAgents: PaletteItem[] = s.agents.filter((a) => a.status === 'active').map((a) => ({ key: `ag-${a.id}`, label: a.name, sub: a.role, icon: 'users', keywords: a.sector_name, run: () => openAgent(a.id) }));
  const navItems = (inDrawer: boolean) => (
    <>
      {[...NAV, HELP_NAV].map((n) => (
        <button key={n.id} data-tour={inDrawer ? undefined : `nav-${n.id}`} data-autofocus={inDrawer && view === n.id ? '' : undefined} className={`nav ${n.id === HELP_NAV.id ? 'nav--foot' : ''} ${view === n.id && !focus ? 'nav--on' : ''}`}
          onClick={() => { go(n.id); if (inDrawer) setNavOpen(false); }} aria-current={view === n.id && !focus ? 'page' : undefined} title={navCompact && !inDrawer ? n.label : undefined}>
          <Icon name={n.icon} /> <span className="nav__label">{n.label}</span>
        </button>
      ))}
    </>
  );
  const running = s.runs.running; const queued = s.runs.queued; const pending = s.decisionsPending;

  return (
    <div className={`shell ${focus ? 'shell--focus' : ''} ${navCompact ? 'shell--compact' : ''}`}>
      {/* teclado: o primeiro Tab oferece pular o cabeçalho e o menu (WCAG 2.4.1) */}
      <button className="skip" onClick={() => document.querySelector<HTMLElement>('main.main')?.focus()}>Pular para o conteúdo</button>
      <header className="topbar">
        <button className="icon-btn topbar__menu" data-keep-surface onClick={() => setNavOpen((v) => !v)} aria-label="Menu" title="Menu" aria-expanded={navOpen} aria-controls="nav-drawer">
          <Icon name="menu" size={22} />
        </button>
        <div className="brand" title={live.status === 'ao_vivo' ? `Conectado ao servidor local · atualizado às ${(live.at ?? new Date(s.serverTime)).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}` : live.status === 'conectando' ? 'Conectando ao servidor local…' : 'Reconectando ao servidor local…'}>
          <ErgonLogo kind="horizontal" onDark height={28} />
          <span className={`dot ${live.status === 'ao_vivo' ? 'dot--green' : 'dot--amber dot--pulse'}`} role="img" aria-label={live.status === 'ao_vivo' ? 'conectado' : 'reconectando'} />
        </div>
        <WorkspaceSwitcher current={s.workspace.name} />
        {coordinator && (
          <button className="btn btn--gold topbar__ask" onClick={() => openAgent(coordinator.id, 'conversa')} aria-label={`Pedir a ${coordinator.name}`} title={`Peça qualquer coisa: ${coordinator.name} encaminha a quem faz`}>
            <Icon name="chat" size={16} /><span className="topbar__ask-long">Pedir a {coordinator.name}</span><span className="topbar__ask-short">Pedir</span>
          </button>
        )}
        {/* busca no meio, com cara de campo; à direita, só ícones do mesmo tamanho (Estado, Aguardando você, Modo foco) e a conta */}
        <span className="topbar__grow">
          <button className="tb-search" data-keep-surface onClick={() => setPalette((v) => !v)} aria-label="Buscar (Ctrl+K)" title="Buscar cards, agentes, rotinas e áreas (Ctrl+K)" aria-expanded={palette}>
            <Icon name="search" size={16} /><span className="tb-search__txt">Buscar cards, agentes, rotinas…</span><kbd className="tb-search__kbd">Ctrl K</kbd>
          </button>
        </span>
        <span className="topbar__icons">
          <span className="topbar__statuswrap">
            <button className={`tb-icon ${statusOpen ? 'is-on' : ''}`} data-keep-surface onClick={() => setStatusOpen((v) => !v)} aria-expanded={statusOpen}
              aria-label={`Estado: ${running} em execução${queued ? `, ${queued} na fila` : ''}${alerts.length ? `; ${alerts.length} aviso(s): ${alerts.map((a) => a.label).join(', ')}` : ''}`}
              title={[running ? `${running} em execução` : queued ? `${queued} na fila` : 'Nada em execução', ...alerts.map((a) => a.label)].join(' · ')}>
              <Icon name="activity" size={18} />
              {alerts.length > 0 ? <span className="tb-badge tb-badge--warn">!</span>
                : (running > 0 || queued > 0) && <span className={`tb-dot ${running ? 'tb-dot--green' : 'tb-dot--amber'}`} />}
            </button>
            {/* o Estado é um balão abaixo do botão; os avisos (simulação, atualização) aparecem lá */}
            {statusOpen && (
              <StatusPanel onClose={() => setStatusOpen(false)} live={live.status} runs={s.runs} capacity={s.capacity} usage={usage.data} alerts={alerts}
                onAct={(a) => { setStatusOpen(false); a.act(); }} />
            )}
          </span>
          <button data-tour="decisions" data-keep-surface className={`tb-icon ${decisions ? 'is-on' : ''}`} onClick={() => setDecisions((v) => !v)} aria-expanded={decisions}
            aria-label={`${pending} aguardando você`} title={pending ? `${pending} aguardando você` : 'Nada aguardando você'}>
            <Icon name="bell" size={18} />{pending > 0 && <span className="tb-badge">{pending > 99 ? '99+' : pending}</span>}
          </button>
          <button className={`tb-icon ${focus ? 'is-on' : ''}`} onClick={() => setFocus((f) => !f)} aria-pressed={focus} aria-label="Modo foco" title="Modo foco: o trabalho sem a cidade (Esc volta)">
            <Icon name="focus" size={18} />
          </button>
          <span className="topbar__sep" aria-hidden="true" />
          <AccountMenu me={me} onLogout={logout} onAccount={() => goHash('#configuracao?conta')} />
        </span>
      </header>

      {!focus && (
        <nav className="sidebar" aria-label="Navegação">
          {navItems(false)}
          <button className="nav nav--collapse" onClick={() => setNavCompact((v) => !v)} aria-pressed={navCompact} title={navCompact ? 'Mostrar os nomes do menu' : 'Recolher o menu (só ícones)'}>
            <Icon name={navCompact ? 'chevron-right' : 'chevron-left'} /> <span className="nav__label">Recolher menu</span>
          </button>
        </nav>
      )}
      {navOpen && (
        <NavDrawer onClose={() => setNavOpen(false)}>
          {navItems(true)}
          {/* o que o cabeçalho não mostra nas janelas mais estreitas continua aqui */}
          <div className="navdrawer__foot">
            <button className="nav" onClick={() => { setNavOpen(false); setFocus((f) => !f); }} aria-pressed={focus}><Icon name="focus" /> <span className="nav__label">{focus ? 'Sair do Modo foco' : 'Modo foco'}</span></button>
            <button className="nav" onClick={() => { setNavOpen(false); setPalette(true); }}><Icon name="search" /> <span className="nav__label">Buscar <span className="nav__hint">(Ctrl+K)</span></span></button>
            <button className="nav" onClick={() => { setNavOpen(false); setStatusOpen(true); }}><Icon name="pulse" /> <span className="nav__label">Estado do Ergon{running ? ` · ${running} em execução` : ''}</span></button>
            <button className="nav" onClick={logout}><Icon name="logout" /> <span className="nav__label">Sair ({me.user.displayName})</span></button>
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
          <AgentesView state={s} reload={st.reload} onOpen={openAgent} />
        ) : view === 'equipe' ? (
          <EquipeView state={s} onAskCoordinator={askCoordinator} reload={st.reload} />
        ) : view === 'tarefas' ? (
          <TarefasView agents={s.agents} onGo={setView} />
        ) : view === 'rotinas' ? (
          <RotinasView state={s} onOpenAgent={openAgent} onGo={setView} />
        ) : view === 'conexoes' ? (
          <ConexoesView />
        ) : view === 'ajuda' ? (
          <AjudaView state={s} onGo={setView} onTour={startTour} onRedo={me.role === 'owner' ? () => setOnb('redo') : undefined} />
        ) : view === 'configuracao' ? (
          <ConfiguracaoView state={s} me={me} onMeChanged={onMeChanged} reload={() => { st.reload(); usage.reload(); }} />
        ) : (
          <AtividadeView />
        )}
      </main>
      {win && winAgent && <AgentWindow key={`${win.id}-${win.conversationId ?? ''}`} agent={winAgent} state={s} initialTab={win.tab} draft={win.draft} conversationId={win.conversationId} onClose={() => setWin(null)} reload={st.reload} />}
      {!focus && !onb && !tour && <ViewTip view={view} coord={coordLabel} other={tipOther} onTour={startTour} />}
      {onb && (
        <Onboarding displayName={me.user.displayName} workspaceName={s.workspace.name} redo={onb === 'redo'} onCancel={() => setOnb(null)}
          onFinish={({ tour: t, goal: g }) => { setOnb(null); setGoal(g); onMeChanged(); st.reload(); if (t) startTour(); }} />
      )}
      {tour && (
        <Tour steps={tourSteps(coordLabel)} onClose={endTour} final={(close) => (
          <div className="tour__final">
            <h3>Pronto!</h3>
            <p>{coordinator ? <>Que tal começar conversando com <b>{coordinator.name}</b>? {goal ? 'O seu objetivo já vai escrito na mensagem.' : 'Conte o que você quer resolver primeiro.'}</> : 'Explore à vontade. A Ajuda fica no pé do menu.'}</p>
            <div className="tour__nav">
              <button className="btn btn--sm" onClick={close}>Explorar sozinho</button>
              <span className="tour__grow" />
              {coordinator && <button className="btn btn--sm btn--primary" autoFocus onClick={() => { close(); openAgent(coordinator.id, 'conversa', goal ? `Quero começar por: ${goal}` : null); }}><Icon name="chat" size={14} /> Conversar com {coordinator.name}</button>}
            </div>
          </div>
        )} />
      )}
      {palette && (
        <CommandPalette base={paletteBase} agents={paletteAgents} onCard={openCard} onRoutine={openRoutine} onRecent={openRecent} onClose={() => setPalette(false)} />
      )}
      {decisions && <DecisionsPanel onClose={() => setDecisions(false)} onOpenAgent={(...a) => { setDecisions(false); openAgent(...a); }} onGo={(v) => { setDecisions(false); setView(v); }} />}
      {card && <TaskDetail key={card} taskId={card} agents={s.agents} mode="auto" over onClose={() => setCard(null)} onAskCoordinator={(t) => { setCard(null); setConvs(null); askCoordinator(t); }} />}
      {convs && <ConversationsDialog agents={s.agents} initial={convs} onClose={() => setConvs(null)} onOpenAgent={(id, tab) => { setConvs(null); openAgent(id, tab); }} />}
      <ConversationDock agents={s.agents} hidden={!!convs || !!win || focus || tour || !!onb} />

    </div>
  );
}

/** Aviso que pede ação (simulação, versão nova, atualização, frase de recuperação). */
interface Alert { id: string; label: string; tone: 'warn' | 'attn'; title: string; act: () => void }

const localPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const saveLocalPref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento: vale só nesta visita */ } };

/** Menu inteiro na janela estreita: abre pelo botão do cabeçalho; fecha ao escolher, no Esc ou clicando fora. */
function NavDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, modal: true, outside: true });
  return (
    <div className="navdrawer-back">
      <nav ref={ref} id="nav-drawer" className="navdrawer" aria-label="Menu">
        <div className="navdrawer__head">
          <ErgonLogo kind="horizontal" onDark height={26} />
          <button className="icon-btn" onClick={onClose} aria-label="Fechar o menu (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
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
function StatusPanel({ onClose, live, runs, capacity, usage, alerts, onAct }: {
  onClose: () => void; live: string; runs: AppState['runs']; capacity: AppState['capacity']; usage: Usage | null; alerts: Alert[]; onAct: (a: Alert) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose, outside: true });
  return (
    <aside ref={ref} className="status-pop" role="dialog" aria-labelledby="status-title">
      <div className="drawer__head"><h3 className="drawer__title" id="status-title">Estado do Ergon</h3><button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button></div>
      {alerts.length > 0 && (
        <section className="block">
          <h4>Avisos</h4>
          <div className="status-panel__alerts">
            {alerts.map((a) => (
              <button key={a.id} className="dec-link" onClick={() => onAct(a)}><span><b>{a.label}</b><br /><span className="muted small">{a.title}</span></span><Icon name="chevron-right" size={14} /></button>
            ))}
          </div>
        </section>
      )}
      <section className="block">
        <h4>Agora</h4>
        <div className="kv">
          <span>Processos</span><b>{runs.processes} trabalhando <span className="muted">({runs.limit.limit === null ? 'sem limite' : `até ${runs.limit.limit} ao mesmo tempo`})</span>{runs.cardsWaiting ? <> · {runs.cardsWaiting} card{runs.cardsWaiting === 1 ? '' : 's'} esperando em A fazer</> : null}</b>
          <span>Conversas</span><b>livres <span className="muted">(não entram no limite)</span></b>
          <span>Equipe</span><b>{capacity.active} agentes · {capacity.slots} vagas</b>
          <span>Servidor</span><b>{live === 'ao_vivo' ? 'conectado' : 'reconectando…'}</b>
        </div>
      </section>
      <section className="block">
        <h4>Consumo</h4>
        <div className="row row--wrap"><UsageChips usage={usage} /></div>
        <p className="hint">Tokens e custo como a conta de IA informa; nada é estimado.</p>
      </section>
    </aside>
  );
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : n >= 1e3 ? `${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n));
const fmtUsd = (v: number) => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;

/**
 * Consumo: tokens sempre (mês ⇄ ano, com um clique). Custo só quando a conta informa o valor cobrado —
 * assinatura (ChatGPT) não tem custo por uso, então o chip some. Limites de plano só quando informados.
 */
function UsageChips({ usage }: { usage: Usage | null }) {
  const [year, setYear] = useState(false);
  if (!usage) return null;
  const p = year ? usage.year : usage.month; const label = year ? 'ano' : 'mês';
  const tokens = p.tokensIn + p.tokensOut;
  const sub = usage.subscription;
  return (
    <>
      <button className="chip chip--stat" onClick={() => setYear((v) => !v)} aria-pressed={year}
        title={`Tokens neste ${label}: entrada ${p.tokensIn.toLocaleString('pt-BR')} · saída ${p.tokensOut.toLocaleString('pt-BR')} · ${p.runs} execuções reais. ${usage.note} Clique para ver o ${year ? 'mês' : 'ano'}.`}>
        <Icon name="token" size={14} /> {fmtTokens(tokens)} tokens <span className="muted">· {label}</span>
      </button>
      {usage.costVisible && (
        <button className={`chip chip--stat ${p.costUsd === null ? 'chip--muted' : ''}`} onClick={() => setYear((v) => !v)} aria-pressed={year}
          title={p.costUsd === null ? `A conta não informou custo neste ${label}. Nada é estimado.` : `Custo cobrado informado pela conta em ${p.runsWithCost} execução(ões) deste ${label}. Sem estimativas.`}>
          <Icon name="coins" size={14} /> {p.costUsd === null ? 'US$ —' : fmtUsd(p.costUsd)} <span className="muted">· {label}</span>
        </button>
      )}
      {sub?.windows.map((w) => (
        <span key={w.label} className="chip chip--stat" title={`${sub.provider}: limite ${w.label}${w.resetsAt ? ` · renova ${new Date(w.resetsAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}`}>
          <Icon name="clock" size={14} /> {w.label} <span className="meter"><span style={{ width: `${Math.min(100, w.usedPercent)}%` }} /></span> {Math.round(w.usedPercent)}%
        </span>
      ))}
    </>
  );
}
