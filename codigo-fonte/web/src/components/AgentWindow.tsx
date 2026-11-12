import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, requestId } from '../lib/api.ts';
import { cachedResource, useLiveEvent, useResource } from '../lib/live.ts';
import { pushRecent } from '../lib/recents.ts';
import { keepTyped, useSurface } from '../lib/surface.ts';
import { COORDINATOR_ONLY, COORDINATOR_TOOLS } from '../lib/team.ts';
import type { TeamAgent } from '../lib/teamData.ts';
import type { Agent, AgentLite, AgentTool, ModelCatalog, RecentConversation, Sector, Skill } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';
import { ModelSelect, TOOL_BADGE, modelName } from './AgentProfile.tsx';
import { ModelosPorTarefa } from './ModelosPorTarefa.tsx';
import { TrainTab } from './TrainTab.tsx';
import { MemoriaTab } from './MemoriaTab.tsx';
import { PersonalityPicker } from './PersonalityPicker.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { AgentPreview } from './AgentPreview.tsx';
import { cardClick, cardKey } from '../lib/cardClick.ts';
import { destinoDaExecucao, rotuloDaLinha, rotuloDoDestino } from '../lib/atividade.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { EffectPicker, effectsFor, useFxOptions, type FxChoice } from './EffectPicker.tsx';
import { MoveTray, type Pick as MovePick } from './MoveTray.tsx';
import { newSeed } from '../world/pack.ts';
import { fmtDataHora, fmtLista, fmtNumero, tn, useT, type Chave, type ValoresDe } from '../i18n/index.ts';
/** chave de texto sem valores a preencher (os rótulos das tabelas abaixo) */
type Rotulo = { [K in Chave]: keyof ValoresDe<K> extends never ? K : never }[Chave];

type Tab = 'conversa' | 'perfil' | 'treinar' | 'memoria' | 'atividade';
const ABA: Readonly<Record<Tab, Rotulo>> = { conversa: 'agente.aba.conversa', perfil: 'agente.aba.perfil', treinar: 'agente.treinar', memoria: 'agente.aba.memoria', atividade: 'agente.aba.atividade' };
interface Activity {
  runs: Array<{ id: string; kind: string; status: string; mode: string; model: string | null; tokens_in: number | null; tokens_out: number | null; created_at: string; error: string | null; task_id?: string | null; conversation_id?: string | null }>;
  tasks: Array<{ id: string; number: number; title: string; completed: number; column_name: string }>;
  totals: { runs: number; tokens_in: number | null; tokens_out: number | null };
}
const RUN_STATUS: Readonly<Record<string, Rotulo>> = {
  queued: 'agente.execucao.naFila', running: 'agente.execucao.trabalhando', waiting_user: 'agente.execucao.aguardaVoce',
  succeeded: 'agente.execucao.concluida', failed: 'agente.execucao.falhou', cancelled: 'agente.execucao.cancelada',
};
/** o estado de uma ferramenta (o servidor manda a palavra em português; a tela mostra no idioma da pessoa) */
const TOOL_STATUS: Readonly<Record<AgentTool['status'], Rotulo>> = {
  'disponível': 'agente.ferramenta.disponivel', 'parcial': 'agente.ferramenta.parcial', 'desligada': 'agente.ferramenta.desligada',
  'bloqueada': 'agente.ferramenta.bloqueada', 'preparado': 'agente.ferramenta.preparado', 'planejado': 'agente.ferramenta.planejado',
  'atualizando': 'agente.ferramenta.atualizando',
};
const fmtN = (n: number | null | undefined) => fmtNumero(n ?? 0);

/** O que quem abre já sabe do agente (a linha leve da lista, da conversa, da busca): o cabeçalho e a conversa aparecem na hora. */
export type AgentHead = AgentLite & Partial<Pick<TeamAgent, 'status' | 'run_status' | 'building_name'>>;
/** GET /api/agents/:id: o perfil completo, com o efeito pessoal escolhido. */
type FullAgent = Agent & { fx?: { mode: FxChoice['mode']; option: string | null };
  /** o perfil do agente no motor, quando já está pronto (rc.27); null/ausente = ainda sem perfil */
  hermesPerfil?: string | null };

/** Sem a linha de quem abriu: o que as telas já buscaram (a lista de conversas traz o colega embutido). */
function cachedHead(id: string): AgentHead | null {
  return cachedResource<RecentConversation[]>('/api/conversations/recent')?.find((c) => c.agent_id === id && c.agent)?.agent ?? null;
}

/**
 * Janela do agente: conversas, perfil do subagente (o que vai para a IA a cada execução) e atividade. Abre pelo id: o
 * cabeçalho e a conversa já com o que quem abriu sabe dele (`initial`, ou o que está em cache), e o perfil completo
 * chega por baixo. Agente que não existe (outro workspace, recente antigo): a janela fecha sozinha (`onGone`).
 */
export function AgentWindow({ agentId, initial, coordName, sectors, initialTab = 'conversa', draft, conversationId, onClose, onGone }: {
  agentId: string; initial?: AgentHead | null; coordName: string; sectors: Sector[]; initialTab?: Tab; draft?: string | null; conversationId?: string | null;
  onClose: () => void; onGone: () => void;
}) {
  const t = useT();
  const full = useResource<FullAgent>(`/api/agents/${agentId}`, ['agents.changed']);
  // a linha leve: endereço e andamento, relida também quando muda uma execução DESTE agente (o perfil não muda com ela)
  const row = useResource<TeamAgent>(`/api/team/agents/${agentId}`, ['agents.changed', 'city.changed']);
  const runTimer = useRef<number | null>(null);
  useLiveEvent('runs.changed', (d) => { if (d.agentId === agentId && runTimer.current === null) runTimer.current = window.setTimeout(() => { runTimer.current = null; row.reload(); }, 150); });
  useEffect(() => () => { if (runTimer.current !== null) clearTimeout(runTimer.current); }, []);
  const [seed] = useState<AgentHead | null>(() => initial ?? cachedHead(agentId));
  const a = full.data?.id === agentId ? full.data : null;
  const r = row.data?.id === agentId ? row.data : null;
  const head: AgentHead | null = r ?? (a ? { ...a, look_seed: a.look_seed ?? null } : seed);
  const status = r?.status ?? a?.status ?? seed?.status ?? 'active';
  const run = r ? r.run_status : a ? a.run_status : seed?.run_status ?? null;
  const place = r?.building_name ?? seed?.building_name ?? null;
  // o perfil chegou: entra nos recentes da busca (Ctrl+K) com o nome e o papel de agora
  useEffect(() => { if (a) pushRecent({ kind: 'agente', id: a.id, label: a.name, where: a.role }); }, [a?.id, a?.name, a?.role]); // eslint-disable-line react-hooks/exhaustive-deps
  // não veio: confere se o agente não existe mais (404) ou se foi só a conexão (o próximo recarregar acerta)
  const failed = full.error ?? row.error;
  useEffect(() => {
    if (!failed) return;
    let stop = false;
    api.get(`/api/team/agents/${agentId}`).catch((e: unknown) => { const st = (e as { status?: number }).status; if (!stop && (st === 404 || st === 400)) onGone(); });
    return () => { stop = true; };
  }, [failed, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState<Tab>(status === 'active' ? initialTab : 'perfil');
  // desativado (soube-se depois de abrir): conversa e treino ficam fechados, como se tivesse aberto assim
  useEffect(() => { if (status !== 'active' && (tab === 'conversa' || tab === 'treinar')) setTab('perfil'); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  // perfil alterado e não salvo: fechar (X, Esc, clique no fundo) pergunta antes, em vez de perder em silêncio
  const dirty = useRef(false);
  const ref = useRef<HTMLElement>(null);
  const requestClose = () => { if (keepTyped(dirty.current, t('agente.janela.descartarPerfil', { nome: head?.name ?? t('agente.janela.esteAgente') }))) onClose(); };
  useSurface(ref, { onClose: requestClose, modal: true, outside: true });
  const reload = () => { full.reload(); row.reload(); };
  return (
    <div className="awin-back">
      <section ref={ref} className="awin" role="dialog" aria-modal="true" aria-labelledby={`awin-${agentId}`} aria-busy={!head}>
        {head ? (
          <>
            <header className="awin__head">
              <AgentAvatar agent={head} size={38} />
              <div className="awin__who">
                <strong id={`awin-${agentId}`}>{head.name}</strong>
                <span className="muted">{head.role} · {head.sector_name}{place ? ` · ${place}` : ''}</span>
              </div>
              {a && <span className="chip" title={t('agente.janela.modeloDica')}>{modelName(a.model)}</span>}
              {status !== 'active' && <span className="badge badge--warn">{t('agente.janela.desativado')}</span>}
              {run && <span className="badge badge--warn">{t(RUN_STATUS[run])}</span>}
              <button className="icon-btn" onClick={requestClose} aria-label={t('agente.janela.fechar')} title={t('agente.janela.fechar')}><Icon name="x" /></button>
            </header>
            <div className="tabs" role="tablist">
              {(['conversa', 'perfil', 'treinar', 'memoria', 'atividade'] as Tab[]).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab--on' : ''}`} disabled={(k === 'conversa' || k === 'treinar') && status !== 'active'} onClick={() => setTab(k)}>
                  {t(ABA[k])}
                </button>
              ))}
            </div>
            <div className="awin__body">
              {tab === 'conversa' && <div className="awin__chat"><ChatPanel agent={{ ...head, id: agentId }} embedded draft={draft} conversationId={conversationId} /></div>}
              {tab === 'perfil' && (a ? <ProfileEditor agent={a} row={r} sectors={sectors} coordName={coordName} reload={reload} onClose={onClose} onDirty={(v) => { dirty.current = v; }} /> : <Loading error={full.error} />)}
              {tab === 'treinar' && <TrainTab agent={{ id: agentId, name: head.name }} full={a} onAgentChanged={reload} />}
              {tab === 'memoria' && <MemoriaTab agent={{ id: agentId, name: head.name }} />}
              {tab === 'atividade' && <ActivityTab agentId={agentId} />}
            </div>
          </>
        ) : (
          <>
            <header className="awin__head">
              <span className="grow" />
              <button className="icon-btn" onClick={onClose} aria-label={t('agente.janela.fechar')} title={t('agente.janela.fechar')}><Icon name="x" /></button>
            </header>
            <div className="awin__body"><Loading error={failed} /></div>
          </>
        )}
      </section>
    </div>
  );
}

function ProfileEditor({ agent, row, sectors, coordName, reload, onClose, onDirty }: {
  agent: FullAgent; row: TeamAgent | null; sectors: Sector[]; coordName: string; reload: () => void; onClose: () => void; onDirty: (dirty: boolean) => void;
}) {
  const t = useT();
  const catalog = useResource<ModelCatalog>('/api/ai/models', ['ai.changed']);
  const tools = useResource<AgentTool[]>('/api/ai/tools', ['agents.changed']);
  const skills = useResource<Skill[]>('/api/ai/skills', []);
  // a construção muda pelo "Mover para…" (a mesma operação da Equipe, com conferência no servidor), não pelo Salvar
  const init = () => ({
    name: agent.name, role: agent.role, sectorKey: agent.profile, model: agent.model, provider: agent.provider, charter: agent.charter ?? '', bio: agent.bio ?? '',
    skills: agent.skills, hermesSkills: agent.hermes_skills, tools: agent.tools.map((tool) => tool.id),
    lookSeed: agent.look_seed ?? null,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newMethod, setNewMethod] = useState('');
  const [skillQ, setSkillQ] = useState('');
  // efeito pessoal (Pacotes instalados): vale na hora, sem esperar o Salvar; a escolha de agora vem com o perfil
  const fxOptions = useFxOptions();
  const fxChoice: FxChoice = agent.fx?.mode === 'custom' && agent.fx.option ? { mode: 'custom', option: agent.fx.option } : { mode: agent.fx?.mode === 'off' ? 'off' : 'inherit' };
  const setFx = async (c: FxChoice) => {
    try { await api.put(`/api/agents/${agent.id}/fx`, c); reload(); setMsg({ kind: 'ok', text: t(c.mode === 'inherit' ? 'agente.perfil.efeitoPadrao' : c.mode === 'off' ? 'agente.perfil.efeitoNenhum' : 'agente.perfil.efeitoAplicado') }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  // mover: a mesma operação da Equipe (setor OU construção, com conferência no servidor)
  const [tray, setTray] = useState<'sector' | 'structure' | null>(null);
  const moveTo = async (p: MovePick) => {
    setTray(null);
    const body = p.kind === 'sector' ? { sectorKey: p.key, expect: { sectorKey: agent.profile } } : { structureId: p.id, expect: { structureId: agent.building_id }, ...(p.addFloor ? { addFloor: true } : {}) };
    try { await api.post(`/api/agents/${agent.id}/move`, body); setMsg({ kind: 'ok', text: t(p.kind === 'sector' ? 'agente.perfil.movidoSetor' : 'agente.perfil.movidoConstrucao', { nome: p.name }) }); reload(); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const [drafting, setDrafting] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [offResult, setOffResult] = useState<{ redistributed: Array<{ number: number; title: string; to: string; reason: string }>; tools: Array<{ label: string; to: string }> } | null>(null);
  const sector = sectors.find((s) => s.key === f.sectorKey);
  const place = row?.building_name ?? null;
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = agent.status === 'active';

  const save = async () => {
    setMsg(null);
    const body: Record<string, unknown> = {};
    const base = init();
    for (const k of Object.keys(f) as Array<keyof typeof f>) if (JSON.stringify(f[k]) !== JSON.stringify(base[k])) body[k] = f[k];
    if ('model' in body || 'provider' in body) { body.model = f.model; if (f.model) body.provider = f.provider; else delete body.provider; }
    try { await api.patch(`/api/agents/${agent.id}`, body); setMsg({ kind: 'ok', text: t('agente.perfil.salvo') }); reload(); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  // Escrever com a coordenação: o coordenador redige instruções, métodos e ferramentas; você revisa e salva
  const draft = async () => {
    setMsg(null);
    try {
      const r = await api.post<{ runId: string; mode: string }>('/api/agents/draft', { name: f.name, role: f.role, sectorKey: f.sectorKey, requestId: requestId() });
      setDrafting(r.runId);
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  useEffect(() => {
    if (!drafting) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<{ done: boolean; status: string; error: string | null; draft: { charter: string; methods: string[]; tools: string[] } | null }>(`/api/agents/draft/${drafting}`);
        if (stop) return;
        if (!r.done) { window.setTimeout(poll, 1500); return; }
        setDrafting(null);
        if (r.draft) {
          setF((x) => ({ ...x, charter: r.draft!.charter, skills: r.draft!.methods.length ? r.draft!.methods : x.skills, tools: r.draft!.tools.length ? [...new Set([...r.draft!.tools])] : x.tools }));
          setMsg({ kind: 'ok', text: t('agente.perfil.propostaPronta') });
        } else setMsg({ kind: 'error', text: r.error ?? t('agente.perfil.propostaIlegivel') });
      } catch (e) { if (!stop) { setDrafting(null); setMsg({ kind: 'error', text: errMsg(e) }); } }
    };
    void poll();
    return () => { stop = true; };
  }, [drafting]); // eslint-disable-line react-hooks/exhaustive-deps

  const deactivate = async () => {
    setMsg(null);
    try {
      const r = await api.post<{ redistributed: Array<{ number: number; title: string; to: string; reason: string }>; tools: Array<{ label: string; to: string }> }>(`/api/agents/${agent.id}/deactivate`);
      setOffResult(r); setConfirmOff(false); reload();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); setConfirmOff(false); }
  };
  const reactivate = async () => {
    try { await api.post(`/api/agents/${agent.id}/reactivate`); setOffResult(null); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };

  const recommended = new Set(sector?.tools ?? []);
  // o Coordenador é o único cargo fixo: função, setor e ferramentas de coordenação não mudam; o resto é livre
  const fixed = !!agent.coordinator;
  const toggleTool = (id: string, on: boolean) => setF((x) => ({ ...x, tools: on ? [...new Set([...x.tools, id])] : x.tools.filter((k) => k !== id) }));
  const shownSkills = useMemo(() => {
    const q = skillQ.trim().toLowerCase();
    return (skills.data ?? []).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q) || s.category.includes(q)).slice(0, 40);
  }, [skills.data, skillQ]);
  const toggleSkill = (name: string) => setF((x) => ({ ...x, hermesSkills: x.hermesSkills.includes(name) ? x.hermesSkills.filter((s) => s !== name) : [...x.hermesSkills, name] }));

  return (
    <div className="editor">
      {agent.bio && <p className="profile__bio">{agent.bio}</p>}
      {!active && agent.deactivation_note && <p className="hint">{t('agente.perfil.desativadoNota', { nota: agent.deactivation_note })}</p>}
      {fixed && <p className="fixed-note"><Icon name="lock" size={13} /> <span><b>{t('agente.perfil.cargoFixoTitulo')}</b> {t('agente.perfil.cargoFixo')}</span></p>}
      {/* aparência: o boneco da cidade, sorteado do pacote gráfico (Grécia Clássica) a cada "Redefinir" */}
      <div className="look-row">
        <div className="look-row__stage"><AgentPreview agent={{ ...agent, look_seed: f.lookSeed }} fx={effectsFor(fxChoice, fxOptions, agent)} size={3} label={t('agente.perfil.aparenciaDe', { nome: agent.name })} /></div>
        <div className="look-row__txt">
          <b>{t('agente.perfil.aparencia')}</b>
          <span className="hint">{t('agente.perfil.aparenciaDica')}</span>
          <div className="row row--wrap">
            <button type="button" className="btn btn--sm" onClick={() => setF((x) => ({ ...x, lookSeed: newSeed() }))}><Icon name="repeat" size={13} /> {t('agente.perfil.redefinir')}</button>
            {agent.char_key && f.lookSeed !== null && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setF((x) => ({ ...x, lookSeed: null }))}>{t('agente.perfil.voltarOriginal')}</button>}
            {f.lookSeed !== (agent.look_seed ?? null) && <span className="hint">{t('agente.perfil.salvarParaManter')}</span>}
          </div>
          <b className="look-row__sub">{t('agente.perfil.efeitosPacotes')}</b>
          <EffectPicker value={fxChoice} onChange={(c) => void setFx(c)} options={fxOptions} />
          {active && (
            <div className="row row--wrap look-row__move">
              <span className="hint"><Icon name="pin" size={12} /> {t('agente.perfil.ondeMora', { lugar: place ?? '—', setor: sectors.find((s) => s.key === agent.profile)?.name ?? agent.sector_name })}</span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTray('structure')}><Icon name="temple" size={13} /> {t('agente.perfil.moverPara')}</button>
            </div>
          )}
        </div>
      </div>
      {tray && <MoveTray agent={row ?? { id: agent.id, name: agent.name, role: agent.role, color: agent.color, status: agent.status, demo: !!agent.demo, coordinator: !!agent.coordinator, char_key: agent.char_key, look_seed: agent.look_seed ?? null, deactivation_note: agent.deactivation_note, sector_key: agent.profile, sector_name: agent.sector_name, building_id: agent.building_id, building_name: null, floor_name: null, floor_id: agent.floor_id, floor_level: agent.floor_level, run_status: agent.run_status }}
        initial={tray} title={t('agente.perfil.moverNomePara', { nome: agent.name })} onPick={(p) => void moveTo(p)} onClose={() => setTray(null)} />}
      <PersonalityPicker agent={agent} onChanged={reload} />
      <div className="editor__grid">
        <label className="field">{t('agente.perfil.nome')}<input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">{t(fixed ? 'agente.perfil.papelFixo' : 'agente.perfil.papel')}<input value={f.role} maxLength={80} disabled={fixed} onChange={(e) => setF({ ...f, role: e.target.value })} /></label>
        <label className="field">{t('agente.perfil.setor')}
          <select value={f.sectorKey} disabled={fixed} onChange={(e) => setF({ ...f, sectorKey: e.target.value })}>
            {sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
          {sector?.description && <span className="hint">{sector.description} {t(sector.creates_tasks === 'demands' ? 'agente.perfil.criaCards' : 'agente.perfil.soCardPedido')}</span>}
        </label>
        {/* a cidade pode ter milhares de construções: escolher é pelo "Mover para…" (com busca e por partes), não num select */}
        <div className="field">{t('agente.perfil.construcao')}
          <button type="button" className="btn btn--ghost" onClick={() => setTray('structure')} disabled={!active} title={active ? t('agente.perfil.escolherConstrucao') : undefined}>
            <Icon name="temple" size={13} /> {place ?? '—'}{active ? ` · ${t('agente.perfil.moverPara')}` : ''}
          </button>
        </div>
        <label className="field editor__wide">{t('agente.perfil.modeloIa')}
          {catalog.error ? <span className="hint">{t('agente.perfil.semContaIa')}</span>
            : <ModelSelect catalog={catalog.data} value={f.model} provider={f.provider} onChange={(model, provider) => setF({ ...f, model, provider })} />}
          <span className="hint">{t('agente.perfil.modeloDica')}</span>
        </label>
        {/* os modelos das tarefas de apoio DESTE agente (o perfil dele no motor); enquanto o perfil não fica pronto, os da equipe */}
        {!catalog.error && <div className="editor__wide"><ModelosPorTarefa perfil={agent.hermesPerfil ?? null} deTodaEquipe={!agent.hermesPerfil} /></div>}
        <label className="field editor__wide">{t('agente.perfil.historia')}
          <textarea rows={2} maxLength={600} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} placeholder={t('agente.perfil.historiaExemplo')} />
          <span className="hint">{t('agente.perfil.historiaDica')}</span>
        </label>
      </div>

      <label className="field">{t(fixed ? 'agente.perfil.focoCoordenacao' : 'agente.perfil.instrucoes')}
        <textarea rows={6} maxLength={4000} value={f.charter} onChange={(e) => setF({ ...f, charter: e.target.value })} />
      </label>
      {!fixed && <div className="row">
        <button className="btn btn--sm" onClick={draft} disabled={!!drafting || !f.role.trim()}><Icon name="edit" size={13} /> {t(drafting ? 'agente.perfil.escrevendo' : 'agente.perfil.escreverComCoordenacao')}</button>
        <span className="hint">{t('agente.perfil.escreverDica', { coord: coordName })}</span>
      </div>}

      <div className="block">
        <h4>{t('agente.perfil.metodos')}</h4>
        <div className="row row--wrap">
          {f.skills.map((s) => <span key={s} className="skill">{s} <button className="x" aria-label={t('agente.tirar', { nome: s })} onClick={() => setF({ ...f, skills: f.skills.filter((x) => x !== s) })}>×</button></span>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); const v = newMethod.trim(); if (v) setF({ ...f, skills: [...new Set([...f.skills, v])] }); setNewMethod(''); }}>
            <input value={newMethod} maxLength={80} placeholder={t('agente.perfil.novoMetodoExemplo')} onChange={(e) => setNewMethod(e.target.value)} aria-label={t('agente.perfil.novoMetodo')} />
          </form>
        </div>
        {sector && sector.skills.some((s) => !f.skills.includes(s)) && (
          <p className="hint">{tn('agente.perfil.sugestoesSetor', { itens: sector.skills.filter((s) => !f.skills.includes(s)).map((s) => <button key={s} className="linkish" onClick={() => setF({ ...f, skills: [...f.skills, s] })}>+ {s}</button>) })}</p>
        )}
      </div>

      <div className="block">
        <h4>{t('agente.perfil.ferramentas')} <span className="muted small">{t('agente.perfil.ferramentasDica')}</span></h4>
        <div className="tools-grid">
          {(tools.data ?? []).filter((tool) => fixed || !COORDINATOR_ONLY.includes(tool.id)).map((tool) => {
            const on = f.tools.includes(tool.id);
            // só o que executa código espera a autorização com a senha; o resto se escolhe sempre (o estado aparece ao lado)
            const blocked = tool.status === 'bloqueada' && !!tool.guarded && !on;
            const locked = fixed && COORDINATOR_TOOLS.includes(tool.id);
            const plena = tool.status === 'disponível'; // i18n-ok: o estado que o servidor manda, não texto de tela
            return (
              <label key={tool.id} className={`tool-opt ${on ? 'tool-opt--on' : ''} ${blocked ? 'tool-opt--off' : ''}`} title={tool.note}>
                <input type="checkbox" checked={on} disabled={blocked || locked} onChange={(e) => toggleTool(tool.id, e.target.checked)} />
                <span className="tool-opt__txt"><b>{tool.label}</b><small>{tool.note}</small></span>
                <span className="tool-opt__tags">
                  {locked && <span className="badge">{t('agente.perfil.doCargo')}</span>}
                  {!locked && recommended.has(tool.id) && <span className="badge">{t('agente.perfil.recomendada')}</span>}
                  {!plena && <span className={`badge ${TOOL_BADGE[tool.status]}`}>{TOOL_STATUS[tool.status] ? t(TOOL_STATUS[tool.status]) : tool.status}</span>}
                  {tool.aviso && <span className="badge badge--warn" title={tool.aviso === 'custo' ? t('agente.aviso.custoDica') : t('agente.aviso.riscoDica')}>{tool.aviso === 'custo' ? t('agente.aviso.custo') : t('agente.aviso.risco')}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="block">
        <h4>{t('agente.perfil.competencias')} <span className="muted small">{t('agente.perfil.competenciasDica')}</span></h4>
        {f.hermesSkills.length > 0 && <div className="row row--wrap">{f.hermesSkills.map((s) => <span key={s} className="skill">{s} <button className="x" onClick={() => toggleSkill(s)} aria-label={t('agente.tirar', { nome: s })}>×</button></span>)}</div>}
        {f.hermesSkills.length > 0 && !f.tools.includes('habilidades') && <p className="hint warn">{t('agente.perfil.semFerramentaCompetencias')}</p>}
        {(skills.data?.length ?? 0) > 0 ? (
          <details>
            <summary className="muted">{t('agente.perfil.escolherBiblioteca', { n: skills.data!.length })}</summary>
            <input value={skillQ} onChange={(e) => setSkillQ(e.target.value)} placeholder={t('agente.perfil.buscarExemplo')} aria-label={t('agente.perfil.buscarCompetencia')} className="skill-search" />
            <div className="skill-list">
              {shownSkills.map((s) => (
                <button key={s.name} className={`skill-item ${f.hermesSkills.includes(s.name) ? 'skill-item--on' : ''}`} onClick={() => toggleSkill(s.name)}>
                  <b>{s.name}</b><span className="muted">{s.category}</span><small>{s.description}</small>
                </button>
              ))}
            </div>
          </details>
        ) : <p className="hint">{t('agente.perfil.bibliotecaIndisponivel')}</p>}
      </div>

      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {offResult && (
        <div className="ok">
          {t('agente.perfil.desativadoOk', { nome: agent.name })} {offResult.redistributed.length ? t('agente.perfil.redistribuidas', { lista: fmtLista(offResult.redistributed.map((r) => `#${r.number} → ${r.to}`)) }) : t('agente.perfil.semTarefasAbertas')}
          {offResult.tools.length ? ` ${t('agente.perfil.ferramentasSoDele', { lista: fmtLista(offResult.tools.map((x) => `${x.label} → ${x.to}`)) })}` : ''}
        </div>
      )}
      <div className="editor__foot">
        {fixed ? <span className="hint">{t('agente.perfil.coordenadorNaoSai')}</span> : active ? (
          confirmOff ? (
            <div className="confirm">
              {t('agente.perfil.confirmarDesativar', { nome: agent.name })}
              <button className="btn btn--sm btn--primary" onClick={deactivate}>{t('agente.desativar')}</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmOff(false)}>{t('agente.cancelar')}</button>
            </div>
          ) : <button className="btn btn--ghost" onClick={() => setConfirmOff(true)}>{t('agente.perfil.desativarAgente')}</button>
        ) : <button className="btn" onClick={reactivate}>{t('agente.perfil.reativar')}</button>}
        <span className="grow" />
        <button className="btn btn--ghost" onClick={() => { setF(init()); setMsg(null); }} disabled={!dirty}>{t('agente.perfil.desfazer')}</button>
        <button className="btn btn--primary" onClick={save} disabled={!dirty}>{t('agente.perfil.salvar')}</button>
        {!active && <button className="btn btn--ghost" onClick={onClose}>{t('agente.perfil.fechar')}</button>}
      </div>
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const d = useResource<Activity>(`/api/agents/${agentId}/activity`, ['runs.changed', 'tasks.changed']);
  const t = useT();
  if (!d.data) return <Loading error={d.error} />;
  const tot = d.data.totals;
  return (
    <div>
      <p className="muted">{t('agente.atividade.resumo', { n: tot.runs, total: fmtN((tot.tokens_in ?? 0) + (tot.tokens_out ?? 0)), entrada: fmtN(tot.tokens_in), saida: fmtN(tot.tokens_out) })}</p>
      <h4>{t('agente.atividade.comQuem')}</h4>
      {d.data.tasks.length ? (
        // cada tarefa abre o card dela (antes, a lista só mostrava)
        <ul className="plain">{d.data.tasks.map((x) => <li key={x.id} className="card-click" onClick={cardClick(() => openCard(x.id))}><button type="button" className="card-open" onClick={() => openCard(x.id)} aria-label={t('agente.atividade.abrirCard', { numero: x.number, titulo: x.title })}><span className="muted">#{x.number}</span> {x.title}</button> <span className={`badge ${x.completed ? 'badge--ok' : ''}`}>{x.completed ? t('agente.atividade.feito') : x.column_name}</span></li>)}</ul>
      ) : <p className="hint">{t('agente.atividade.semTarefas')}</p>}
      <h4>{t('agente.atividade.ultimas')}</h4>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('agente.atividade.quando')}</th><th>{t('agente.atividade.tipo')}</th><th>{t('agente.atividade.modelo')}</th><th>{t('agente.atividade.consumo')}</th><th>{t('agente.atividade.estado')}</th></tr></thead>
        <tbody>{d.data.runs.map((r) => {
          // a execução abre o card ou a conversa dela; sem nenhum dos dois, a linha fica só para ler
          const dest = destinoDaExecucao({ task_id: r.task_id, conversation_id: r.conversation_id, agent_id: agentId });
          const ir = dest?.tipo === 'card' ? () => openCard(dest.id) : dest?.tipo === 'conversa' ? () => openConversation(dest.agentId, dest.conversationId) : null;
          const quando = fmtDataHora(r.created_at);
          const tipo = t(r.kind === 'chat' ? 'agente.atividade.conversa' : 'agente.atividade.tarefa');
          return (
          <tr key={r.id} {...(ir && dest ? { className: 'row-click', tabIndex: 0, title: rotuloDoDestino(dest), 'aria-label': rotuloDaLinha(dest, `${tipo}, ${quando}`), onClick: cardClick(ir), onKeyDown: cardKey(ir) } : {})}>
            <td>{quando}{ir && <span className="act-open" aria-hidden="true"> ›</span>}</td>
            <td>{tipo}</td>
            <td>{r.mode === 'simulated' ? <span className="badge badge--warn">{t('agente.atividade.semContaIa')}</span> : modelName(r.model)}</td>
            <td>{r.tokens_in === null ? '—' : fmtN((r.tokens_in ?? 0) + (r.tokens_out ?? 0))}</td>
            <td>{RUN_STATUS[r.status] ? t(RUN_STATUS[r.status]) : r.status}{r.error ? <span className="small error-inline"> {r.error}</span> : null}</td>
          </tr>
          );
        })}
        {!d.data.runs.length && <tr><td colSpan={5} className="muted">{t('agente.atividade.semExecucoes')}</td></tr>}</tbody>
      </table></div>
    </div>
  );
}
