import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useSurface } from '../lib/surface.ts';
import type { AppState, Structure, View } from '../lib/types.ts';
import { ErgonLoader } from '../brand/Brand.tsx';
import { ChatPanel } from '../components/ChatPanel.tsx';
import { Icon } from '../components/Icon.tsx';
import { StructureCard } from '../components/StructureCard.tsx';
import { CentralTrabalho, type CentralSection } from '../components/CentralTrabalho.tsx';
import { useResource } from '../lib/live.ts';
import { OPS_EVENTS, OPS_URL, cloudOn, summaryOf, type AmbientOps, type Distribution } from '../lib/ambient.ts';
import { openDecisions } from '../lib/open.ts';
import type { SceneAgent, SceneApi, SceneFocus, SceneObject, SceneOps, StructureIn } from '../scene/types.ts';
import { THEMES, type ThemeId } from '../iso/theme.ts';
import { isDarkHour } from '../iso/life.ts';
import { typeOf } from '../../../shared/city.ts';

// palco e loja carregados à parte, para não pesar o primeiro acesso
const Scene = lazy(() => import('../iso/IsoScene.tsx'));
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

type ThemeMode = 'auto' | ThemeId;
const prefTheme = (): ThemeMode => { try { const v = localStorage.getItem('ergon.themeMode'); return v === 'dia' || v === 'noite' ? v : 'auto'; } catch { return 'auto'; } };
const THEME_NEXT: Record<ThemeMode, ThemeMode> = { auto: 'dia', dia: 'noite', noite: 'auto' };
const THEME_LABEL: Record<ThemeMode, string> = { auto: 'Dia e noite automáticos (seguem o relógio deste computador)', dia: 'Sempre dia', noite: 'Sempre noite' };
const CHAT_W = 380;

/**
 * A cidade. Fica montada mesmo quando outra área do Ergon está na tela (`active` = false): a vida dos agentes
 * continua em segundo plano e voltar aqui só mostra a cena, do jeito que eles deixaram.
 */
export function AmbienteView({ state, onNavigate, selectedId, onSelect, reload, active = true }: {
  state: AppState; onNavigate: (v: View) => void; selectedId: string | null; onSelect: (id: string | null) => void; reload: () => void; active?: boolean;
}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(prefTheme);
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => { const t = setInterval(() => setHour(new Date().getHours()), 60_000); return () => clearInterval(t); }, []);
  const themeId: ThemeId = themeMode === 'auto' ? (isDarkHour(hour) ? 'noite' : 'dia') : themeMode;
  const [editing, setEditing] = useState(false);
  const [lost, setLost] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [bio, setBio] = useState(false);
  const [store, setStore] = useState<{ i: number; j: number } | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [focus, setFocus] = useState<SceneFocus | null>(null);
  const sceneApi = useRef<SceneApi | null>(null);
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

  // painel de conversa: entra deslizando da direita e sai do mesmo jeito (fica montado durante a saída)
  const selected = state.agents.find((a) => a.id === selectedId && a.status === 'active') ?? null;
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

  const structures: StructureIn[] = useMemo(() => state.structures.map((s) => ({ id: s.id, kind: s.kind, name: s.name, i: s.i, j: s.j, floors: s.floors.map((f) => ({ id: f.id, level: f.level, slots: f.slots })) })), [state.structures]);
  const sceneAgents: SceneAgent[] = useMemo(() => {
    const slot = new Map<string, number>();
    return state.agents.filter((a) => a.status === 'active').map((a) => {
      const k = `${a.building_id}|${a.floor_level}`; const n = slot.get(k) ?? 0; slot.set(k, n + 1);
      return { id: a.id, name: a.name, color: a.color, role: a.role, key: a.char_key, seed: a.look_seed ?? null, building: a.building_id, level: a.floor_level, slot: n, run: a.run_status, outcome: a.last_outcome ?? null };
    });
  }, [state.agents]);

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

  const onMove = useCallback(async (id: string, i: number, j: number) => {
    try { await api.patch(`/api/structures/${id}`, { i, j }); reload(); }
    catch (e) { setToast(errMsg(e)); reload(); }
  }, [reload]);

  const build = async (kind: string, i: number, j: number) => {
    try {
      const r = await api.post<{ id: string }>('/api/structures', { kind, i, j });
      setStore(null); reload();
      setToast(`${typeOf(kind)?.name ?? 'Estrutura'} construída — versão local: grátis.`);
      setTimeout(() => sceneApi.current?.flyTo(r.id), 400);
      setCard(r.id);
    } catch (e) { setToast(errMsg(e)); }
  };

  const pick = (id: string) => { setCard(id === 'cidade' ? null : id); sceneApi.current?.flyTo(id); };
  const cardStruct = state.structures.find((s) => s.id === card) ?? null;

  return (
    <div className="ambiente">
      <div className="stage" style={{ background: THEMES[themeId].bg, ['--drawer' as string]: `${chatOpen || central ? CHAT_W : 0}px` }}>
        {!lost ? (
          <Suspense fallback={<div className="stage__loading"><ErgonLoader onDark label="Carregando a cidade…" /></div>}>
            <Scene structures={structures} agents={sceneAgents} selectedId={selectedId} themeId={themeId} editing={editing} rightInset={chatOpen || central ? CHAT_W : 0} active={active} ops={sceneOps}
              onSelectAgent={(id) => onSelect(id)} onObject={onObject} onLot={(i, j) => { setEditing(false); setStore({ i, j }); }}
              onStructure={(id) => setCard(id)} onFocus={setFocus} onMove={onMove} onContextLost={() => setLost(true)}
              onReady={(a) => { sceneApi.current = a; }} />
          </Suspense>
        ) : (
          <div className="htmlplan-wrap">
            <CentralTrabalho embedded ops={ops} error={opsRes.error} agents={state.agents} section={section} onSection={setSection}
              onBoard={() => onNavigate('equipe')} onFiles={() => { history.replaceState(null, '', '#atividade?arquivos'); onNavigate('atividade'); }} />
            <HtmlPlan state={state} onSelect={onSelect} selectedId={selectedId} />
          </div>
        )}

        <div className="stage__tools stage__tools--left">
          <StructurePicker structures={state.structures} value={card} onPick={pick} />
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
          <button className="tool tool--icon" onClick={() => { const n = THEME_NEXT[themeMode]; setThemeMode(n); try { localStorage.setItem('ergon.themeMode', n); } catch { /* sem armazenamento */ } }}
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
          <StructureCard s={cardStruct} focus={focus} agents={state.agents} onClose={() => setCard(null)}
            onOpenFloor={(level) => sceneApi.current?.open(cardStruct.id, level)} onCloseBuilding={() => sceneApi.current?.close()}
            onChanged={(msg) => { reload(); if (msg) setToast(msg); }} onError={(m) => setToast(m)} />
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
            <StoreDialog lot={store} structures={state.structures} themeId={themeId} onBuild={build} onClose={() => setStore(null)} />
          </Suspense>
        )}
        {central && !selectedId && (
          <div className="chat-drawer chat-drawer--open central-drawer" style={{ width: CHAT_W }}>
            <CentralTrabalho ops={ops} error={opsRes.error} agents={state.agents} section={section} onSection={(x) => { setSection(x); setCentral(x); }} onClose={() => setCentral(null)}
              onBoard={() => onNavigate('equipe')} onFiles={() => { history.replaceState(null, '', '#atividade?arquivos'); onNavigate('atividade'); }} />
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

/** Seletor singelo das estruturas: leva a câmera até ela (que aparece fechada). */
function StructurePicker({ structures, value, onPick }: { structures: Structure[]; value: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: () => setOpen(false), outside: true, autoFocus: false, active: open });
  const cur = structures.find((s) => s.id === value);
  const work = structures.filter((s) => typeOf(s.kind)?.category === 'trabalho');
  const areas = structures.filter((s) => typeOf(s.kind)?.category !== 'trabalho');
  const item = (s: Structure) => {
    const t = typeOf(s.kind); const slots = s.floors.reduce((n, f) => n + f.slots, 0); const active = s.floors.reduce((n, f) => n + f.active, 0);
    return (
      <button key={s.id} role="option" aria-selected={s.id === value} className={`picker__item ${s.id === value ? 'picker__item--on' : ''}`} onClick={() => { onPick(s.id); setOpen(false); }}>
        <span>{s.name}</span>
        <span className="muted">{t?.common}{slots ? ` · ${active}/${slots}` : ''}</span>
      </button>
    );
  };
  return (
    <div className="picker" ref={ref}>
      <button className="picker__btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <Icon name="map" size={15} /> {cur ? cur.name : 'Cidade'} <Icon name="chevron" size={14} />
      </button>
      <div className={`picker__menu ${open ? 'picker__menu--open' : ''}`} role="listbox" aria-label="Estruturas">
        <button role="option" aria-selected={!value} className={`picker__item ${!value ? 'picker__item--on' : ''}`} onClick={() => { onPick('cidade'); setOpen(false); }}>
          <span>Cidade inteira</span><span className="muted">{structures.length} estruturas</span>
        </button>
        {!!work.length && <div className="picker__group">Prédios</div>}
        {work.map(item)}
        {!!areas.length && <div className="picker__group">Praças, lazer e moradias</div>}
        {areas.map(item)}
      </div>
    </div>
  );
}

function HtmlPlan({ state, onSelect, selectedId }: { state: AppState; onSelect: (id: string) => void; selectedId: string | null }) {
  const work = state.structures.filter((s) => s.floors.length);
  return (
    <div className="htmlplan">
      <p className="hint">O palco gráfico foi perdido: modo HTML ativo. Todo o trabalho continua disponível.</p>
      {work.flatMap((s) => [...s.floors].reverse().map((f) => (
        <section key={f.id} className="htmlplan__floor">
          <h3>{s.name} · {f.name} <span className="muted">{f.active}/{f.slots} vagas</span></h3>
          <div className="htmlplan__agents">
            {state.agents.filter((a) => a.status === 'active' && a.floor_id === f.id).map((a) => (
              <button key={a.id} className={`agent-chip ${selectedId === a.id ? 'agent-chip--on' : ''}`} onClick={() => onSelect(a.id)}>
                <span className="avatar avatar--sm" style={{ background: a.color }}>{a.name[0]}</span> {a.name}
                {a.run_status && <span className="badge badge--warn">{a.run_status === 'running' ? 'trabalhando' : a.run_status === 'queued' ? 'na fila' : 'aguarda'}</span>}
              </button>
            ))}
          </div>
        </section>
      )))}
    </div>
  );
}
