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
import type { SceneApi, SceneFocus, SceneObject, SceneOps, SceneTag, StructureIn } from '../scene/types.ts';
import { savePrefs, usePrefs } from '../lib/prefs.ts';
import { CityBar } from '../components/CityBar.tsx';
import { PausaControle } from '../components/AjustesEquipe.tsx';
import { indicadores, type Indicador } from '../lib/barra.ts';
import { THEMES } from '../iso/theme.ts';
import { useTheme } from '../lib/theme.ts';
import { typeOf } from '../../../shared/city.ts';
import { fmtNumero, tn, useT } from '../i18n/index.ts';
import { comumDoTipo, nomeDaConstrucao, nomeDoAndar, nomeDoTipo } from '../world/buildings.ts';

// palco e loja carregados à parte, para não pesar o primeiro acesso; o palco já começa a vir junto com os dados da
// cidade (a cena espera os moradores para montar e, sem isso, só então buscaria o código)
const loadScene = () => import('../iso/IsoScene.tsx');
const Scene = lazy(loadScene);
if (typeof window !== 'undefined') void loadScene().catch(() => undefined);
const loadStore = () => import('../iso/StoreDialog.tsx');
const StoreDialog = lazy(loadStore);
// a loja já vem carregada quando a pessoa clica num lote (abrir só mostra, sem esperar)
if (typeof window !== 'undefined') window.setTimeout(() => { void loadStore().catch(() => undefined); }, 3000);

/** Alexandre Magno passeia pela ágora: não é agente e não conversa — o clique mostra a bio (textos em cidade.bio.*). */
const NPC_NAME = 'Alexandre Magno'; // i18n-ok: nome de personagem, não se traduz

// dia e noite da cidade = tema da plataforma (lib/theme.ts): trocar aqui troca o app inteiro
const CHAT_W = 380;
const NO_STRUCTURES: Structure[] = [];
const NO_TAGS: SceneTag[] = [];
const NO_TRACK: Indicador[] = [];
/** o que muda as etiquetas: execuções, tarefas e treinos (agents.changed) — o mesmo SSE de sempre */
const ACTIVITY_EVENTS = ['runs.changed', 'tasks.changed', 'agents.changed'];

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
  const t = useT();
  const { theme: themeId } = useTheme();
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
  // Cidade Viva: etiquetas do trabalho real (só com a cidade na tela), Alexandre (opção do workspace) e o modo calmo (da pessoa)
  const actRes = useResource<{ tags: SceneTag[] }>(active ? '/api/city/activity' : null, ACTIVITY_EVENTS);
  const tags = actRes.data?.tags ?? NO_TAGS;
  const citySettings = useResource<{ npc: boolean }>('/api/city/settings', ['city.changed']);
  const npcOn = citySettings.data?.npc !== false;
  const prefs = usePrefs();
  const calm = prefs.cityCalm;
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
    else if (k === 'tag' && text) location.hash = text; // a etiqueta abre o card no quadro dele
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
      setToast(t('cidade.tela.construida', { nome: typeOf(kind) ? nomeDoTipo(kind) : t('cidade.tela.estrutura') }));
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
      <ErgonLoader onDark label={city.error ? t('cidade.tela.erroCarregar', { erro: city.error }) : t('cidade.tela.carregando')} />
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
              rightInset={chatOpen || central ? CHAT_W : 0} active={active} ops={sceneOps} tags={tags} npc={npcOn} calm={calm}
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

        {/* rc.27: a equipe em pausa aparece na Cidade (ninguém começa trabalho novo); retomar fica à mão */}
        {state.teamPausa?.pausada && (
          <div className="cidade-pausa" role="status">
            <Icon name="pause" size={14} /> <span>{t('configuracoes.ajustes.pausa.cidade')}</span>
            <PausaControle compacto pausa={state.teamPausa} onMudou={reload} onError={(text) => setToast(text)} />
          </div>
        )}
        <CityBar
          picker={<StructurePicker structures={structs} value={card} onPick={pick} onAgent={locate} />}
          pickKey={cardStruct ? nomeDaConstrucao(cardStruct.name, cardStruct.kind) : t('cidade.localizar.cidade')}
          track={ops && !editing ? indicadores({ busy: ops.local.busy, limit: ops.local.limit, decisoes: ops.decisions.total, entregas: ops.deliveries.total }) : NO_TRACK}
          isOn={(k) => (k === 'trabalho' || k === 'entregas') && central === k}
          onTrack={(k) => { if (k === 'voce') openDecisions(); else if (central === k) setCentral(null); else openCentral(k); }}
          editing={editing} onEdit={() => { setEditing((v) => !v); setCard(null); }}
          calm={calm} onCalm={() => savePrefs({ cityCalm: !calm })} />
        {editing && (
          <div className="editbar" role="status">
            <Icon name="map" size={16} /> {tn('cidade.editor.dica', { esc: <kbd>Esc</kbd> })}
            <button className="btn btn--gold btn--sm" onClick={() => setEditing(false)}>{t('cidade.editor.concluir')}</button>
          </div>
        )}
        {cardStruct && !editing && (
          <StructureCard key={cardStruct.id} s={cardStruct} focus={focus} known={cardKnown} onClose={() => setCard(null)}
            onOpenFloor={(level) => sceneApi.current?.open(cardStruct.id, level)} onCloseBuilding={() => sceneApi.current?.close()}
            onChanged={(msg) => { changed(); if (msg) setToast(msg); }} onError={(m) => setToast(m)} />
        )}
        {toast && <div className="toast" role="status">{toast}</div>}
        {bio && (
          <aside className="bio-card" role="dialog" aria-label={t('cidade.bio.aria', { nome: NPC_NAME })}>
            <button className="icon-btn" onClick={() => setBio(false)} aria-label={t('cidade.tela.fechar')}><Icon name="x" /></button>
            <h3>{NPC_NAME}</h3>
            <span className="muted">{t('cidade.bio.titulo')}</span>
            <p>{t('cidade.bio.texto')}</p>
            <p className="muted">{t('cidade.bio.nota')}</p>
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: () => setOpen(false), outside: true, active: open });
  const cur = structures.find((s) => s.id === value);
  const curName = cur ? nomeDaConstrucao(cur.name, cur.kind) : t('cidade.localizar.cidade');
  return (
    <div className="picker" ref={ref}>
      <button className={`cb-pill picker__btn ${open ? 'is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} aria-label={t('cidade.localizar.aria', { nome: curName })} title={t('cidade.localizar.dica')}>
        <Icon name="map" size={16} /><span className="cb-pill__txt picker__name">{curName}</span><Icon name="chevron" size={16} />
      </button>
      {open && <Finder structures={structures} value={value} onPick={(id) => { onPick(id); setOpen(false); }} onAgent={(a) => { onAgent(a); setOpen(false); }} />}
    </div>
  );
}

const foldName = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function Finder({ structures, value, onPick, onAgent }: { structures: Structure[]; value: string | null; onPick: (id: string) => void; onAgent: (a: TeamAgent) => void }) {
  const t = useT();
  const [q, setQ] = useState(''); const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  // a linha leve traz o andar (building_id, floor_level): a câmera vai até lá mesmo sem o agente carregado
  type Ag = { items: TeamAgent[]; total: number };
  type Bu = { items: Array<{ id: string; kind: string; name: string; kind_name: string; active: number; slots: number }>; total: number };
  const agentsRes = useResource<Ag>(dq ? `/api/team/agents?q=${encodeURIComponent(dq)}&limit=6` : null, []);
  const buildsRes = useResource<Bu>(dq ? `/api/team/structures?limit=8&sample=0&q=${encodeURIComponent(dq)}` : null, ['city.changed', 'agents.changed']);
  // enquanto o termo novo carrega, a lista do termo anterior fica (sem piscar "nada encontrado")
  const lastA = useRef<Ag | null>(null); const lastB = useRef<Bu | null>(null);
  if (agentsRes.data) lastA.current = agentsRes.data; if (buildsRes.data) lastB.current = buildsRes.data;
  const agents = { data: dq ? agentsRes.data ?? lastA.current : null }; const busy = !!dq && (agentsRes.loading || buildsRes.loading);
  // sem termo: os prédios da própria cidade, como antes (até 60; a cidade grande busca pelo nome)
  const LOCAL = 60;
  const work = structures.filter((s) => typeOf(s.kind)?.category === 'trabalho');
  const localB: Bu = { items: work.slice(0, LOCAL).map((s) => ({ id: s.id, kind: s.kind, name: s.name, kind_name: s.kind, active: s.floors.reduce((n, f) => n + f.active, 0), slots: s.floors.reduce((n, f) => n + f.slots, 0) })), total: work.length };
  const builds = { data: dq ? buildsRes.data ?? lastB.current : localB };
  const areas = structures.filter((s) => typeOf(s.kind)?.category !== 'trabalho' && (!dq || [s.name, nomeDaConstrucao(s.name, s.kind)].some((n) => foldName(n).includes(foldName(dq)))));
  const none = dq && !busy && !agents.data?.items.length && !builds.data?.items.length && !areas.length;
  return (
    <div className="picker__menu picker__menu--open picker__menu--finder" role="listbox" aria-label={t('cidade.localizar.menu')} aria-busy={busy}>
      <label className="picker__search"><Icon name="search" size={14} />
        <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('cidade.localizar.campo')} aria-label={t('cidade.localizar.campo')} />
      </label>
      {!dq && <button role="option" aria-selected={!value} className={`picker__item ${!value ? 'picker__item--on' : ''}`} onClick={() => onPick('cidade')}><span>{t('cidade.localizar.cidadeInteira')}</span><span className="muted">{t('cidade.localizar.estruturas', { n: structures.length })}</span></button>}
      {!!agents.data?.items.length && <div className="picker__group">{agents.data.total > agents.data.items.length ? t('cidade.localizar.agentesTotal', { n: agents.data.total }) : t('cidade.localizar.agentes')}</div>}
      {agents.data?.items.map((a) => (
        <button key={a.id} role="option" aria-selected={false} className="picker__item" onClick={() => onAgent(a)}>
          <span>{a.name}</span><span className="muted">{a.role}{a.building_name ? ` · ${nomeDaConstrucao(a.building_name)}` : ''}</span>
        </button>
      ))}
      {!!builds.data?.items.length && <div className="picker__group">{builds.data.total > builds.data.items.length ? t('cidade.localizar.prediosTotal', { n: builds.data.total }) : t('cidade.localizar.predios')}</div>}
      {builds.data?.items.map((s) => (
        <button key={s.id} role="option" aria-selected={s.id === value} className={`picker__item ${s.id === value ? 'picker__item--on' : ''}`} onClick={() => onPick(s.id)}>
          <span>{nomeDaConstrucao(s.name, s.kind)}</span><span className="muted">{s.kind ? comumDoTipo(s.kind) : s.kind_name}{s.slots ? ` · ${fmtNumero(s.active)}/${fmtNumero(s.slots)}` : ''}</span>
        </button>
      ))}
      {!!areas.length && <div className="picker__group">{t('cidade.localizar.areas')}</div>}
      {areas.map((s) => (
        <button key={s.id} role="option" aria-selected={s.id === value} className={`picker__item ${s.id === value ? 'picker__item--on' : ''}`} onClick={() => onPick(s.id)}>
          <span>{nomeDaConstrucao(s.name, s.kind)}</span><span className="muted">{typeOf(s.kind) ? comumDoTipo(s.kind) : null}</span>
        </button>
      ))}
      {none && <p className="hint picker__empty">{t('cidade.localizar.nada', { busca: dq })}</p>}
    </div>
  );
}

/**
 * Modo HTML (o palco gráfico se perdeu): cada prédio recolhido, com a contagem do servidor; abrir um prédio mostra os
 * moradores dele andar por andar (o prédio todo, do servidor). Nada de um botão por agente da cidade inteira.
 */
function HtmlPlan({ structures, known, onSelect, selectedId }: { structures: Structure[]; known: CityAgent[]; onSelect: (id: string) => void; selectedId: string | null }) {
  const t = useT();
  const work = structures.filter((s) => s.floors.length);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="htmlplan">
      <p className="hint">{t('cidade.simples.aviso')}</p>
      {work.map((s) => {
        const on = open === s.id;
        const active = s.floors.reduce((n, f) => n + f.active, 0); const slots = s.floors.reduce((n, f) => n + f.slots, 0);
        return (
          <section key={s.id} className="htmlplan__floor">
            <h3>
              <button className="link" aria-expanded={on} onClick={() => setOpen(on ? null : s.id)} title={on ? t('cidade.simples.recolher') : t('cidade.simples.verAndares')}>{nomeDaConstrucao(s.name, s.kind)}</button>{' '}
              <span className="muted">{t('cidade.simples.vagas', { ativos: fmtNumero(active), vagas: fmtNumero(slots) })} · {t('cidade.simples.andares', { n: s.floors.length })}</span>
            </h3>
            {on && <HtmlBuilding s={s} known={known} onSelect={onSelect} selectedId={selectedId} />}
          </section>
        );
      })}
    </div>
  );
}

function HtmlBuilding({ s, known, onSelect, selectedId }: { s: Structure; known: CityAgent[]; onSelect: (id: string) => void; selectedId: string | null }) {
  const t = useT();
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
      {res.error && !res.data && <p className="hint warn" role="status">{t('cidade.simples.erroMoradores', { erro: res.error })}</p>}
      {[...s.floors].reverse().map((f) => (
        <div key={f.id}>
          <p className="small"><b>{nomeDoAndar(f.name)}</b> <span className="muted">{t('cidade.simples.vagas', { ativos: fmtNumero(f.active), vagas: fmtNumero(f.slots) })}</span></p>
          <div className="htmlplan__agents">
            {(by.get(f.id) ?? []).map((a) => (
              <button key={a.id} className={`agent-chip ${selectedId === a.id ? 'agent-chip--on' : ''}`} onClick={() => onSelect(a.id)}>
                <span className="avatar avatar--sm" style={{ background: a.color }}>{a.name[0]}</span> {a.name}
                {a.run_status && <span className="badge badge--warn">{a.run_status === 'running' ? t('cidade.simples.trabalhando') : a.run_status === 'queued' ? t('cidade.simples.naFila') : t('cidade.simples.aguarda')}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
