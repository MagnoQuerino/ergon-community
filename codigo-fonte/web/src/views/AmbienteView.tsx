import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import type { Agent, AppState, CityAgent, CityAgentsPage, Structure, View } from '../lib/types.ts';
import type { TeamAgent } from '../lib/teamData.ts';
import { useCityData } from '../lib/cityData.ts';
import { ErgonLoader } from '../brand/Brand.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { StructureCard } from '../components/StructureCard.tsx';
import { CentralTrabalho, type CentralSection } from '../components/CentralTrabalho.tsx';
import { useResource } from '../lib/live.ts';
import { OPS_EVENTS, OPS_URL, cloudOn, summaryOf, type AmbientOps, type Distribution } from '../lib/ambient.ts';
import { openDecisions } from '../lib/open.ts';
import type { SceneApi, SceneFocus, SceneObject, SceneOps, StructureIn } from '../scene/types.ts';
import { THEMES } from '../iso/theme.ts';
import { THEME_LABEL, THEME_NEXT, setThemeMode, useTheme } from '../lib/theme.ts';
import { typeOf } from '../../../shared/city.ts';

// palco e loja carregados à parte, para não pesar o primeiro acesso; o palco já começa a vir junto com os dados da
// cidade (a cena espera os moradores para montar e, sem isso, só então buscaria o código)
const loadScene = () => import('../iso/IsoScene.tsx');
const Scene = lazy(loadScene);
if (typeof window !== 'undefined') void loadScene().catch(() => undefined);
const loadStore = () => import('../iso/StoreDialog.tsx');
const StoreDialog = lazy(loadStore);
// a loja já vem carregada quando a pessoa clica num lote (abrir só mostra, sem esperar)
if (typeof window !== 'undefined') window.setTimeout(() => { void loadStore().catch(() => undefined); }, 3000);

/** Alexandre Magno passeia pela ágora: não é agente e não conversa — o clique mostra a bio. */
const FOUNDER_BIO = {
  name: 'Alexandre Magno',
  title: 'fundador do Ergon · aposentado',
  text: 'Antes dos 30 já tinha um império e uma dúzia de cidades com o próprio nome. Fundou o Ergon, entregou a coordenação a Aristóteles — o antigo professor, que não perde a chance de lembrar quem ensinou quem — e se aposentou para passear pela ágora fazendo perguntas a quem trabalha.',
  note: 'Não atende pedidos: está de folga desde 323 a.C.',
};

// dia e noite da cidade = tema da plataforma (lib/theme.ts): trocar aqui troca o app inteiro
const CHAT_W = 380;
const NO_STRUCTURES: Structure[] = [];

/** O que a cena já sabe do agente, no formato do perfil (campos de perfil vazios até o completo chegar por baixo). */
function agentOfRow(a: CityAgent): Agent {
  return {
    id: a.id, name: a.name, role: a.role, color: a.color, status: 'active', demo: 0, floor_id: a.floor_id, floor_level: a.level, building_id: a.building_id,
    profile: '', sector_name: a.sector_name, run_status: a.run_status, char_key: a.char_key, bio: null, skills: [], tools: [], model_hint: null,
    charter: null, model: null, provider: null, hermes_skills: [], deactivation_note: null, coordinator: 0, look_seed: a.look_seed, last_outcome: a.last_outcome,
  };
}
/** Idem, a partir da linha do Localizar (agente leve da equipe). */
function agentOfTeam(a: TeamAgent): Agent {
  return {
    id: a.id, name: a.name, role: a.role, color: a.color, status: a.status, demo: a.demo ? 1 : 0, floor_id: a.floor_id ?? '', floor_level: a.floor_level ?? 0,
    building_id: a.building_id ?? '', profile: a.sector_key, sector_name: a.sector_name, run_status: a.run_status, char_key: a.char_key, bio: null, skills: [],
    tools: [], model_hint: null, charter: null, model: null, provider: null, hermes_skills: [], deactivation_note: a.deactivation_note,
    coordinator: a.coordinator ? 1 : 0, look_seed: a.look_seed, last_outcome: null,
  };
}

/**
 * A cidade. Fica montada mesmo quando outra área do Ergon está na tela (`active` = false): a vida dos agentes
 * continua em segundo plano e voltar aqui só mostra a cena, do jeito que eles deixaram.
 * Construções e contagens vêm do overview; os moradores, do carregador (lib/cityData.ts: a cidade inteira até 1.200
 * agentes, por região acima disso).
 */
export function AmbienteView({ state, onNavigate, selectedId, onSelect, reload, active = true }: {
  state: AppState; onNavigate: (v: View) => void; selectedId: string | null; onSelect: (id: string | null) => void; reload: () => void; active?: boolean;
}) {
  const { mode: themeMode, theme: themeId } = useTheme();
  const [editing, setEditing] = useState(false);
  const [lost, setLost] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [bio, setBio] = useState(false);
  const [store, setStore] = useState<{ i: number; j: number } | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [focus, setFocus] = useState<SceneFocus | null>(null);
  const sceneApi = useRef<SceneApi | null>(null);
  const [sceneOn, setSceneOn] = useState(false);
  const city = useCityData(state.workspace.id, active);
  const structs = city.overview?.structures ?? NO_STRUCTURES;
  // trabalho da equipe: lido só com a cidade na tela (fora dela, nada de recarga operacional); o mesmo SSE de sempre
  const opsRes = useResource<AmbientOps>(active ? OPS_URL : null, OPS_EVENTS);
  const ops = opsRes.data;
  const dist = useResource<Distribution>('/api/distribution', []);
  const cloud = cloudOn(dist.data);
  const sceneOps: SceneOps | null = useMemo(() => (ops ? summaryOf(ops, cloud) : null), [ops, cloud]);
  // Central de Trabalho: a gaveta da direita (a mesma da conversa; uma de cada vez)
  const [central, setCentral] = useState<CentralSection | null>(null);
  const [section, setSection] = useState<CentralSection>('trabalho');
  const openCentral = useCallback((s: CentralSection) => { setSection(s); setCentral(s); onSelect(null); setCard(null); }, [onSelect]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  // o escolhido abre a conversa na hora com o que já se sabe dele (a linha da cena ou a do Localizar); o perfil
  // completo (/api/agents/:id) chega por baixo e, se ele não estiver mais ativo, a conversa fecha
  const [picked, setPicked] = useState<TeamAgent | null>(null);
  const row = selectedId ? city.get(selectedId) : undefined;
  const profileRes = useResource<Agent>(selectedId ? `/api/agents/${encodeURIComponent(selectedId)}` : null, ['agents.changed']);
  const profile = profileRes.data && profileRes.data.id === selectedId ? profileRes.data : null;
  const selected: Agent | null = useMemo(() => {
    if (!selectedId) return null;
    if (profile) return profile.status === 'active' ? profile : null;
    if (row) return agentOfRow(row);
    return picked && picked.id === selectedId && picked.status === 'active' ? agentOfTeam(picked) : null;
  }, [selectedId, profile, row, picked]);
  // escolhido que a cena ainda não carregou (outra tela, cidade por região): o perfil diz o andar; a cena vai até lá,
  // abre o andar e centraliza quando ele chegar
  const located = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) { located.current = null; return; }
    if (located.current === selectedId || row || !profile || profile.status !== 'active' || !sceneOn || !sceneApi.current) return;
    located.current = selectedId;
    sceneApi.current.focusAgentAt(selectedId, profile.building_id, profile.floor_level);
  }, [selectedId, row, profile, sceneOn]);

  // painel de conversa: entra deslizando da direita e sai do mesmo jeito (fica montado durante a saída)
  const [chatAgent, setChatAgent] = useState(selected);
  const [chatOpen, setChatOpen] = useState(!!selected);
  useEffect(() => {
    if (selected) { setChatAgent(selected); requestAnimationFrame(() => setChatOpen(true)); return; }
    setChatOpen(false);
    const t = setTimeout(() => setChatAgent(null), 320);
    return () => clearTimeout(t);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected) setChatAgent(selected); }, [selected]);
  // escolher um agente na cidade troca a gaveta para a conversa dele
  useEffect(() => { if (selectedId) setCentral(null); }, [selectedId]);

  const structures: StructureIn[] = useMemo(() => structs.map((s) => ({ id: s.id, kind: s.kind, name: s.name, i: s.i, j: s.j, floors: s.floors.map((f) => ({ id: f.id, level: f.level, slots: f.slots })) })), [structs]);

  const onObject = useCallback((k: SceneObject, text?: string) => {
    if (k === 'board' || k === 'central') openCentral('trabalho'); // o quadro da Stoa é a bancada da Central
    else if (k === 'espera') openCentral('espera');
    else if (k === 'shelf' || k === 'entregas') openCentral('entregas'); // a estante mostra as entregas (com atalho para todos os arquivos)
    else if (k === 'decisoes') openDecisions();
    else if (k === 'conexoes') onNavigate('conexoes');
    else if (k === 'atividade') onNavigate('atividade');
    else if (k === 'info') setToast(text ?? null);
    else { setToast(null); setBio(true); }
  }, [onNavigate, openCentral]);

  // depois de uma ação aqui mesmo: o estado do app e as construções de novo, sem esperar o evento
  const refreshCity = city.refresh;
  const changed = useCallback(() => { reload(); refreshCity(); }, [reload, refreshCity]);
  const onMove = useCallback(async (id: string, i: number, j: number) => {
    try { await api.patch(`/api/structures/${id}`, { i, j }); changed(); }
    catch (e) { setToast(errMsg(e)); changed(); }
  }, [changed]);

  const build = async (kind: string, i: number, j: number) => {
    try {
      const r = await api.post<{ id: string }>('/api/structures', { kind, i, j });
      setStore(null); changed();
      setToast(`${typeOf(kind)?.name ?? 'Estrutura'} construída — versão local: grátis.`);
      setTimeout(() => sceneApi.current?.flyTo(r.id), 400);
      setCard(r.id);
    } catch (e) { setToast(errMsg(e)); }
  };

  const pick = (id: string) => { setCard(id === 'cidade' ? null : id); sceneApi.current?.flyTo(id); };
  const cardStruct = structs.find((s) => s.id === card) ?? null;
  // moradores do prédio do cartão que a cena já tem (os nomes aparecem já, o servidor confirma)
  const cardKnown = useMemo(() => (card ? city.agents.filter((a) => a.building_id === card) : []), [card, city.agents]);
  // Localizar um agente: a conversa abre com a linha dele e a câmera vai até o andar (mesmo longe, sem ele carregado)
  const locate = (a: TeamAgent) => {
    setCard(null); setPicked(a); located.current = a.id; onSelect(a.id);
    if (a.building_id && a.floor_level !== null && a.floor_level !== undefined) sceneApi.current?.focusAgentAt(a.id, a.building_id, a.floor_level);
    else sceneApi.current?.focusAgent(a.id);
  };
  const loading = (
    <div className="stage__loading">
      <ErgonLoader onDark label={city.error ? `Não deu para carregar a cidade agora (${city.error}). Tentando de novo…` : 'Carregando a cidade…'} />
    </div>
  );

  return (
    <div className="ambiente">
      <div className="stage" style={{ background: THEMES[themeId].bg, ['--drawer' as string]: `${chatOpen || central ? CHAT_W : 0}px` }}>
        {/* a cena só entra com o que desenhar (cidade inteira: construções e todos os bonecos; por região: as
            construções e contagens), para nada aparecer aos poucos */}
        {!lost ? (city.ready ? (
          <Suspense fallback={loading}>
            <Scene structures={structures} agents={city.scene} partial={city.partial} counts={city.overview} selectedId={selectedId} themeId={themeId} editing={editing}
              rightInset={chatOpen || central ? CHAT_W : 0} active={active} ops={sceneOps}
              onSelectAgent={(id) => onSelect(id)} onObject={onObject} onLot={(i, j) => { setEditing(false); setStore({ i, j }); }}
              onStructure={(id) => setCard(id)} onFocus={setFocus} onMove={onMove} onContextLost={() => setLost(true)}
              onReady={(a) => { sceneApi.current = a; setSceneOn(!!a); }} onWindow={city.onWindow} />
          </Suspense>
        ) : loading) : (
          <div className="htmlplan-wrap">
            <CentralTrabalho embedded ops={ops} error={opsRes.error} section={section} onSection={setSection}
              onBoard={() => onNavigate('equipe')} onFiles={() => { location.hash = '#documentos?pasta=entregas'; }} />
            <HtmlPlan structures={structs} known={city.agents} onSelect={onSelect} selectedId={selectedId} />
          </div>
        )}

        <div className="stage__tools stage__tools--left">
          <StructurePicker structures={structs} value={card} onPick={pick} onAgent={locate} />
          {ops && !editing && (
            <div className="ops-sum" role="group" aria-label="Trabalho da equipe">
              <button className={`ops-sum__part ${central === 'trabalho' ? 'is-on' : ''}`} onClick={() => (central === 'trabalho' ? setCentral(null) : openCentral('trabalho'))} aria-pressed={central === 'trabalho'}
                title="Central de Trabalho: o que está em andamento, o que espera e por quê">
                <Icon name="layers" size={14} /> {ops.local.busy} em andamento{ops.local.limit !== null ? ` de ${ops.local.limit}` : ''}
              </button>
              {ops.decisions.total > 0 && (
                <button className="ops-sum__part ops-sum__part--att" onClick={openDecisions} title="Aguardando você: responder, aprovar ou devolver">
                  <Icon name="bell" size={14} /> {ops.decisions.total} precisa{ops.decisions.total === 1 ? '' : 'm'} de você
                </button>
              )}
              {ops.deliveries.total > 0 && (
                <button className={`ops-sum__part ${central === 'entregas' ? 'is-on' : ''}`} onClick={() => (central === 'entregas' ? setCentral(null) : openCentral('entregas'))} aria-pressed={central === 'entregas'} title="Entregas recentes">
                  <Icon name="check" size={14} /> {ops.deliveries.total} entrega{ops.deliveries.total === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="stage__tools stage__tools--right">
          <button className={`tool ${editing ? 'tool--on' : ''}`} onClick={() => { setEditing((v) => !v); setCard(null); }} aria-pressed={editing} title="Editor do mapa: arraste prédios e áreas para outros lotes">
            <Icon name="edit" size={16} /> <span>Editar mapa</span>
          </button>
          <button className="tool tool--icon" onClick={() => setThemeMode(THEME_NEXT[themeMode])}
            title={THEME_LABEL[themeMode]} aria-label={THEME_LABEL[themeMode]}>
            <Icon name={themeMode === 'auto' ? 'auto' : themeMode === 'dia' ? 'sun' : 'moon'} size={17} />
          </button>
        </div>
        {editing && (
          <div className="editbar" role="status">
            <Icon name="map" size={16} /> Arraste um prédio ou área para outro lote livre (verde: cabe; vermelho: não cabe). Ruas, árvores e braseiros se refazem sozinhos. <kbd>Esc</kbd> cancela.
            <button className="btn btn--gold btn--sm" onClick={() => setEditing(false)}>Concluir</button>
          </div>
        )}
        {cardStruct && !editing && (
          <StructureCard key={cardStruct.id} s={cardStruct} focus={focus} known={cardKnown} onClose={() => setCard(null)}
            onOpenFloor={(level) => sceneApi.current?.open(cardStruct.id, level)} onCloseBuilding={() => sceneApi.current?.close()}
            onChanged={(msg) => { changed(); if (msg) setToast(msg); }} onError={(m) => setToast(m)} />
        )}
        {toast && <div className="toast" role="status">{toast}</div>}
        {bio && (
          <aside className="bio-card" role="dialog" aria-label={`Bio de ${FOUNDER_BIO.name}`}>
            <button className="icon-btn" onClick={() => setBio(false)} aria-label="Fechar"><Icon name="x" /></button>
            <h3>{FOUNDER_BIO.name}</h3>
            <span className="muted">{FOUNDER_BIO.title}</span>
            <p>{FOUNDER_BIO.text}</p>
            <p className="muted">{FOUNDER_BIO.note}</p>
          </aside>
        )}
        {store && (
          <Suspense fallback={null}>
            <StoreDialog lot={store} structures={structs} themeId={themeId} onBuild={build} onClose={() => setStore(null)} />
          </Suspense>
        )}
        {central && !selectedId && (
          <div className="chat-drawer chat-drawer--open central-drawer" style={{ width: CHAT_W }}>
            <CentralTrabalho ops={ops} error={opsRes.error} section={section} onSection={(x) => { setSection(x); setCentral(x); }} onClose={() => setCentral(null)}
              onBoard={() => onNavigate('equipe')} onFiles={() => { location.hash = '#documentos?pasta=entregas'; }} />
          </div>
        )}
        {chatAgent && (
          <div className={`chat-drawer ${chatOpen ? 'chat-drawer--open' : ''}`} style={{ width: CHAT_W }}>
            <ChatPanel agent={chatAgent} onClose={() => onSelect(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Localizar: busca agentes e construções (no servidor, por partes, inclusive o que está longe na cidade) e leva a
 * câmera até lá; a lista só existe enquanto está aberta. Praças e áreas, que são poucas, vêm da própria cidade.
 */
function StructurePicker({ structures, value, onPick, onAgent }: { structures: Structure[]; value: string | null; onPick: (id: string) => void; onAgent: (a: TeamAgent) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: () => setOpen(false), outside: true, active: open });
  const cur = structures.find((s) => s.id === value);
  return (
    <div className="picker" ref={ref}>
      <button className="picker__btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <Icon name="map" size={15} /> {cur ? cur.name : 'Cidade'} <Icon name="chevron" size={14} />
      </button>
      {open && <Finder structures={structures} value={value} onPick={(id) => { onPick(id); setOpen(false); }} onAgent={(a) => { onAgent(a); setOpen(false); }} />}
    </div>
  );
}

const foldName = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function Finder({ structures, value, onPick, onAgent }: { structures: Structure[]; value: string | null; onPick: (id: string) => void; onAgent: (a: TeamAgent) => void }) {
  const [q, setQ] = useState(''); const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  // a linha leve traz o andar (building_id, floor_level): a câmera vai até lá mesmo sem o agente carregado
  type Ag = { items: TeamAgent[]; total: number };
  type Bu = { items: Array<{ id: string; name: string; kind_name: string; active: number; slots: number }>; total: number };
  const agentsRes = useResource<Ag>(dq ? `/api/team/agents?q=${encodeURIComponent(dq)}&limit=6` : null, []);
  const buildsRes = useResource<Bu>(dq ? `/api/team/structures?limit=8&sample=0&q=${encodeURIComponent(dq)}` : null, ['city.changed', 'agents.changed']);
  // enquanto o termo novo carrega, a lista do termo anterior fica (sem piscar "nada encontrado")
  const lastA = useRef<Ag | null>(null); const lastB = useRef<Bu | null>(null);
  if (agentsRes.data) lastA.current = agentsRes.data; if (buildsRes.data) lastB.current = buildsRes.data;
  const agents = { data: dq ? agentsRes.data ?? lastA.current : null }; const busy = !!dq && (agentsRes.loading || buildsRes.loading);
  // sem termo: os prédios da própria cidade, como antes (até 60; a cidade grande busca pelo nome)
  const LOCAL = 60;
  const work = structures.filter((s) => typeOf(s.kind)?.category === 'trabalho');
  const localB: Bu = { items: work.slice(0, LOCAL).map((s) => ({ id: s.id, name: s.name, kind_name: typeOf(s.kind)?.common ?? s.kind, active: s.floors.reduce((n, f) => n + f.active, 0), slots: s.floors.reduce((n, f) => n + f.slots, 0) })), total: work.length };
  const builds = { data: dq ? buildsRes.data ?? lastB.current : localB };
  const areas = structures.filter((s) => typeOf(s.kind)?.category !== 'trabalho' && (!dq || foldName(s.name).includes(foldName(dq))));
  const none = dq && !busy && !agents.data?.items.length && !builds.data?.items.length && !areas.length;
  return (
    <div className="picker__menu picker__menu--open picker__menu--finder" role="listbox" aria-label="Localizar" aria-busy={busy}>
      <label className="picker__search"><Icon name="search" size={14} />
        <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Localizar agente ou construção" aria-label="Localizar agente ou construção" />
      </label>
      {!dq && <button role="option" aria-selected={!value} className={`picker__item ${!value ? 'picker__item--on' : ''}`} onClick={() => onPick('cidade')}><span>Cidade inteira</span><span className="muted">{structures.length} estruturas</span></button>}
      {!!agents.data?.items.length && <div className="picker__group">Agentes{agents.data.total > agents.data.items.length ? ` · ${agents.data.total}` : ''}</div>}
      {agents.data?.items.map((a) => (
        <button key={a.id} role="option" aria-selected={false} className="picker__item" onClick={() => onAgent(a)}>
          <span>{a.name}</span><span className="muted">{a.role}{a.building_name ? ` · ${a.building_name}` : ''}</span>
        </button>
      ))}
      {!!builds.data?.items.length && <div className="picker__group">Prédios{builds.data.total > builds.data.items.length ? ` · ${builds.data.total} (busque pelo nome)` : ''}</div>}
      {builds.data?.items.map((s) => (
        <button key={s.id} role="option" aria-selected={s.id === value} className={`picker__item ${s.id === value ? 'picker__item--on' : ''}`} onClick={() => onPick(s.id)}>
          <span>{s.name}</span><span className="muted">{s.kind_name}{s.slots ? ` · ${s.active}/${s.slots}` : ''}</span>
        </button>
      ))}
      {!!areas.length && <div className="picker__group">Praças, lazer e moradias</div>}
      {areas.map((s) => (
        <button key={s.id} role="option" aria-selected={s.id === value} className={`picker__item ${s.id === value ? 'picker__item--on' : ''}`} onClick={() => onPick(s.id)}>
          <span>{s.name}</span><span className="muted">{typeOf(s.kind)?.common}</span>
        </button>
      ))}
      {none && <p className="hint picker__empty">Nada encontrado para “{dq}”.</p>}
    </div>
  );
}

/**
 * Modo HTML (o palco gráfico se perdeu): cada prédio recolhido, com a contagem do servidor; abrir um prédio mostra os
 * moradores dele andar por andar (o prédio todo, do servidor). Nada de um botão por agente da cidade inteira.
 */
function HtmlPlan({ structures, known, onSelect, selectedId }: { structures: Structure[]; known: CityAgent[]; onSelect: (id: string) => void; selectedId: string | null }) {
  const work = structures.filter((s) => s.floors.length);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="htmlplan">
      <p className="hint">O palco gráfico foi perdido: modo HTML ativo. Todo o trabalho continua disponível.</p>
      {work.map((s) => {
        const on = open === s.id;
        const active = s.floors.reduce((n, f) => n + f.active, 0); const slots = s.floors.reduce((n, f) => n + f.slots, 0);
        return (
          <section key={s.id} className="htmlplan__floor">
            <h3>
              <button className="link" aria-expanded={on} onClick={() => setOpen(on ? null : s.id)} title={on ? 'Recolher' : 'Ver quem está em cada andar'}>{s.name}</button>{' '}
              <span className="muted">{active}/{slots} vagas · {s.floors.length} {s.floors.length === 1 ? 'andar' : 'andares'}</span>
            </h3>
            {on && <HtmlBuilding s={s} known={known} onSelect={onSelect} selectedId={selectedId} />}
          </section>
        );
      })}
    </div>
  );
}

function HtmlBuilding({ s, known, onSelect, selectedId }: { s: Structure; known: CityAgent[]; onSelect: (id: string) => void; selectedId: string | null }) {
  const res = useResource<CityAgentsPage>(`/api/city/agents?b=${encodeURIComponent(s.id)}`, ['agents.changed', 'city.changed', 'runs.changed']);
  // até chegar, os que a cena já tinha deste prédio (na mesma ordem)
  const by = useMemo(() => {
    const m = new Map<string, CityAgent[]>();
    for (const a of res.data?.agents ?? known) {
      if (a.building_id !== s.id) continue;
      const l = m.get(a.floor_id); if (l) l.push(a); else m.set(a.floor_id, [a]);
    }
    return m;
  }, [res.data, known, s.id]);
  return (
    <>
      {res.error && !res.data && <p className="hint warn" role="status">Não deu para ler os moradores agora ({res.error}).</p>}
      {[...s.floors].reverse().map((f) => (
        <div key={f.id}>
          <p className="small"><b>{f.name}</b> <span className="muted">{f.active}/{f.slots} vagas</span></p>
          <div className="htmlplan__agents">
            {(by.get(f.id) ?? []).map((a) => (
              <button key={a.id} className={`agent-chip ${selectedId === a.id ? 'agent-chip--on' : ''}`} onClick={() => onSelect(a.id)}>
                <span className="avatar avatar--sm" style={{ background: a.color }}>{a.name[0]}</span> {a.name}
                {a.run_status && <span className="badge badge--warn">{a.run_status === 'running' ? 'trabalhando' : a.run_status === 'queued' ? 'na fila' : 'aguarda'}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
