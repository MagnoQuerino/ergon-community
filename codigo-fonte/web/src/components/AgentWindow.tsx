import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errMsg, requestId } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { keepTyped, useSurface } from '../lib/surface.ts';
import { COORDINATOR_ONLY, COORDINATOR_TOOLS, coordName } from '../lib/team.ts';
import type { Agent, AgentTool, AppState, ModelCatalog, Skill } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';
import { ModelSelect, TOOL_BADGE, modelName } from './AgentProfile.tsx';
import { TrainTab } from './TrainTab.tsx';
import { PersonalityPicker } from './PersonalityPicker.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { AgentPreview } from './AgentPreview.tsx';
import { EffectPicker, effectsFor, useFxOptions, type FxChoice } from './EffectPicker.tsx';
import { MoveTray, type Pick } from './MoveTray.tsx';
import { newSeed } from '../world/pack.ts';

type Tab = 'conversa' | 'perfil' | 'treinar' | 'atividade';
interface Activity {
  runs: Array<{ id: string; kind: string; status: string; mode: string; model: string | null; tokens_in: number | null; tokens_out: number | null; created_at: string; error: string | null }>;
  tasks: Array<{ id: string; number: number; title: string; completed: number; column_name: string }>;
  totals: { runs: number; tokens_in: number | null; tokens_out: number | null };
}
const RUN_STATUS: Record<string, string> = { queued: 'na fila', running: 'trabalhando', waiting_user: 'aguarda você', succeeded: 'concluída', failed: 'falhou', cancelled: 'cancelada' };
const fmtN = (n: number | null | undefined) => (n ?? 0).toLocaleString('pt-BR');

/** Janela do agente: conversas, perfil do subagente (o que vai para a IA a cada execução) e atividade. */
export function AgentWindow({ agent, state, initialTab = 'conversa', draft, conversationId, onClose, reload }: {
  agent: Agent; state: AppState; initialTab?: Tab; draft?: string | null; conversationId?: string | null; onClose: () => void; reload: () => void;
}) {
  const [tab, setTab] = useState<Tab>(agent.status === 'active' ? initialTab : 'perfil');
  // perfil alterado e não salvo: fechar (X, Esc, clique no fundo) pergunta antes, em vez de perder em silêncio
  const dirty = useRef(false);
  const ref = useRef<HTMLElement>(null);
  const requestClose = () => { if (keepTyped(dirty.current, `as alterações no perfil de ${agent.name}`)) onClose(); };
  useSurface(ref, { onClose: requestClose, modal: true, outside: true });
  const sector = state.sectors.find((s) => s.key === agent.profile);
  const building = state.structures.find((s) => s.id === agent.building_id);
  return (
    <div className="awin-back">
      <section ref={ref} className="awin" role="dialog" aria-modal="true" aria-labelledby={`awin-${agent.id}`}>
        <header className="awin__head">
          <AgentAvatar agent={agent} size={38} />
          <div className="awin__who">
            <strong id={`awin-${agent.id}`}>{agent.name}</strong>
            <span className="muted">{agent.role} · {sector?.name ?? agent.sector_name}{building ? ` · ${building.name}` : ''}</span>
          </div>
          <span className="chip" title="Modelo de IA deste agente">{modelName(agent.model)}</span>
          {agent.status !== 'active' && <span className="badge badge--warn">desativado</span>}
          {agent.run_status && <span className="badge badge--warn">{RUN_STATUS[agent.run_status]}</span>}
          <button className="icon-btn" onClick={requestClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        <div className="tabs" role="tablist">
          {(['conversa', 'perfil', 'treinar', 'atividade'] as Tab[]).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab--on' : ''}`} disabled={(k === 'conversa' || k === 'treinar') && agent.status !== 'active'} onClick={() => setTab(k)}>
              {{ conversa: 'Conversas', perfil: 'Perfil e ferramentas', treinar: 'Treinar', atividade: 'Atividade' }[k]}
            </button>
          ))}
        </div>
        <div className="awin__body">
          {tab === 'conversa' && <div className="awin__chat"><ChatPanel agent={agent} embedded draft={draft} conversationId={conversationId} /></div>}
          {tab === 'perfil' && <ProfileEditor agent={agent} state={state} reload={reload} onClose={onClose} onDirty={(v) => { dirty.current = v; }} />}
          {tab === 'treinar' && <TrainTab agent={agent} />}
          {tab === 'atividade' && <ActivityTab agent={agent} />}
        </div>
      </section>
    </div>
  );
}

function ProfileEditor({ agent, state, reload, onClose, onDirty }: { agent: Agent; state: AppState; reload: () => void; onClose: () => void; onDirty: (dirty: boolean) => void }) {
  const catalog = useResource<ModelCatalog>('/api/ai/models', ['ai.changed']);
  const tools = useResource<AgentTool[]>('/api/ai/tools', ['agents.changed']);
  const skills = useResource<Skill[]>('/api/ai/skills', []);
  const init = () => ({
    name: agent.name, role: agent.role, sectorKey: agent.profile, model: agent.model, provider: agent.provider, charter: agent.charter ?? '', bio: agent.bio ?? '',
    skills: agent.skills, hermesSkills: agent.hermes_skills, tools: agent.tools.map((t) => t.id), structureId: agent.building_id,
    lookSeed: agent.look_seed ?? null,
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newMethod, setNewMethod] = useState('');
  const [skillQ, setSkillQ] = useState('');
  // efeito pessoal (Pacotes instalados): vale na hora, sem esperar o Salvar
  const fxOptions = useFxOptions();
  const fxNow = useResource<{ mode: FxChoice['mode']; option: string | null }>(`/api/agents/${agent.id}/fx`, ['agents.changed']);
  const fxChoice: FxChoice = fxNow.data?.mode === 'custom' && fxNow.data.option ? { mode: 'custom', option: fxNow.data.option } : { mode: fxNow.data?.mode === 'off' ? 'off' : 'inherit' };
  const setFx = async (c: FxChoice) => {
    try { await api.put(`/api/agents/${agent.id}/fx`, c); fxNow.reload(); setMsg({ kind: 'ok', text: c.mode === 'inherit' ? 'Efeito: o padrão da cidade.' : c.mode === 'off' ? 'Sem efeito neste agente.' : 'Efeito aplicado (na cidade também).' }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  // mover: a mesma operação da Equipe (setor OU construção, com conferência no servidor)
  const [tray, setTray] = useState<'sector' | 'structure' | null>(null);
  const moveTo = async (p: Pick) => {
    setTray(null);
    const body = p.kind === 'sector' ? { sectorKey: p.key, expect: { sectorKey: agent.profile } } : { structureId: p.id, expect: { structureId: agent.building_id }, ...(p.addFloor ? { addFloor: true } : {}) };
    try { await api.post(`/api/agents/${agent.id}/move`, body); setMsg({ kind: 'ok', text: p.kind === 'sector' ? `Agora no setor ${p.name}. Papel, instruções e ferramentas continuam.` : `Agora mora em ${p.name}. Setor e trabalhos continuam.` }); reload(); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const [drafting, setDrafting] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [offResult, setOffResult] = useState<{ redistributed: Array<{ number: number; title: string; to: string; reason: string }>; tools: Array<{ label: string; to: string }> } | null>(null);
  const sector = state.sectors.find((s) => s.key === f.sectorKey);
  const work = state.structures.filter((s) => s.floors.length);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = agent.status === 'active';

  const save = async () => {
    setMsg(null);
    const body: Record<string, unknown> = {};
    const base = init();
    for (const k of Object.keys(f) as Array<keyof typeof f>) if (JSON.stringify(f[k]) !== JSON.stringify(base[k])) body[k] = f[k];
    if ('model' in body || 'provider' in body) { body.model = f.model; if (f.model) body.provider = f.provider; else delete body.provider; }
    if (body.structureId === agent.building_id) delete body.structureId;
    try { await api.patch(`/api/agents/${agent.id}`, body); setMsg({ kind: 'ok', text: 'Salvo. Vale a partir da próxima conversa ou tarefa.' }); reload(); }
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
          setMsg({ kind: 'ok', text: 'A coordenação escreveu uma proposta. Revise e clique em Salvar.' });
        } else setMsg({ kind: 'error', text: r.error ?? 'A coordenação não devolveu uma proposta legível; tente de novo ou escreva você mesmo.' });
      } catch (e) { if (!stop) { setDrafting(null); setMsg({ kind: 'error', text: errMsg(e) }); } }
    };
    void poll();
    return () => { stop = true; };
  }, [drafting]);

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
  const toggleTool = (id: string, on: boolean) => setF((x) => ({ ...x, tools: on ? [...new Set([...x.tools, id])] : x.tools.filter((t) => t !== id) }));
  const shownSkills = useMemo(() => {
    const q = skillQ.trim().toLowerCase();
    return (skills.data ?? []).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q) || s.category.includes(q)).slice(0, 40);
  }, [skills.data, skillQ]);
  const toggleSkill = (name: string) => setF((x) => ({ ...x, hermesSkills: x.hermesSkills.includes(name) ? x.hermesSkills.filter((s) => s !== name) : [...x.hermesSkills, name] }));

  return (
    <div className="editor">
      {agent.bio && <p className="profile__bio">{agent.bio}</p>}
      {!active && agent.deactivation_note && <p className="hint">Desativado: {agent.deactivation_note}.</p>}
      {fixed && <p className="fixed-note"><Icon name="lock" size={13} /> <span><b>Cargo fixo.</b> O Coordenador está sempre na equipe e a função dele não muda: ele recebe os pedidos e encaminha. Nome, aparência, história, foco, modelo e ferramentas extras são seus.</span></p>}
      {/* aparência: o boneco da cidade, sorteado do pacote gráfico (Grécia Clássica) a cada "Redefinir" */}
      <div className="look-row">
        <div className="look-row__stage"><AgentPreview agent={{ ...agent, look_seed: f.lookSeed }} fx={effectsFor(fxChoice, fxOptions, agent)} size={3} label={`Aparência de ${agent.name}`} /></div>
        <div className="look-row__txt">
          <b>Aparência</b>
          <span className="hint">O boneco da cidade e o retrato das conversas. "Redefinir" sorteia outro, combinando cabelo, barba, roupa e objetos da Grécia Clássica; a cor da roupa continua a do agente.</span>
          <div className="row row--wrap">
            <button type="button" className="btn btn--sm" onClick={() => setF((x) => ({ ...x, lookSeed: newSeed() }))}><Icon name="repeat" size={13} /> Redefinir</button>
            {agent.char_key && f.lookSeed !== null && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setF((x) => ({ ...x, lookSeed: null }))}>Voltar ao original</button>}
            {f.lookSeed !== (agent.look_seed ?? null) && <span className="hint">Clique em Salvar para manter.</span>}
          </div>
          <b className="look-row__sub">Efeitos dos seus Pacotes</b>
          <EffectPicker value={fxChoice} onChange={(c) => void setFx(c)} options={fxOptions} />
          {active && (
            <div className="row row--wrap look-row__move">
              <span className="hint"><Icon name="pin" size={12} /> {state.structures.find((s) => s.id === agent.building_id)?.name ?? '—'} · setor {state.sectors.find((s) => s.key === agent.profile)?.name ?? agent.sector_name}</span>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setTray('structure')}><Icon name="temple" size={13} /> Mover para…</button>
            </div>
          )}
        </div>
      </div>
      {tray && <MoveTray agent={{ id: agent.id, name: agent.name, role: agent.role, color: agent.color, status: agent.status, demo: !!agent.demo, coordinator: !!agent.coordinator, char_key: agent.char_key, look_seed: agent.look_seed ?? null, deactivation_note: agent.deactivation_note, sector_key: agent.profile, sector_name: agent.sector_name, building_id: agent.building_id, building_name: null, floor_name: null, run_status: agent.run_status }}
        initial={tray} title={`Mover ${agent.name} para…`} onPick={(p) => void moveTo(p)} onClose={() => setTray(null)} />}
      <PersonalityPicker agent={agent} onChanged={reload} />
      <div className="editor__grid">
        <label className="field">Nome<input value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Papel (função){fixed ? ' — fixo' : ''}<input value={f.role} maxLength={80} disabled={fixed} onChange={(e) => setF({ ...f, role: e.target.value })} /></label>
        <label className="field">Setor
          <select value={f.sectorKey} disabled={fixed} onChange={(e) => setF({ ...f, sectorKey: e.target.value })}>
            {state.sectors.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
          {sector?.description && <span className="hint">{sector.description} {sector.creates_tasks === 'demands' ? 'Cria cards para demandas claras.' : 'Só cria card quando você pede.'}</span>}
        </label>
        <label className="field">Construção
          <select value={f.structureId} onChange={(e) => setF({ ...f, structureId: e.target.value })} disabled={!active}>
            {work.map((s) => { const free = s.floors.reduce((n, fl) => n + fl.slots - fl.active, 0); return <option key={s.id} value={s.id} disabled={s.id !== agent.building_id && free <= 0}>{s.name} ({free} vaga{free === 1 ? '' : 's'})</option>; })}
          </select>
        </label>
        <label className="field editor__wide">Modelo de IA
          {catalog.error ? <span className="hint">Sem conta de IA conectada: usa o modelo padrão. Conecte uma conta em Conexões para escolher.</span>
            : <ModelSelect catalog={catalog.data} value={f.model} provider={f.provider} onChange={(model, provider) => setF({ ...f, model, provider })} />}
          <span className="hint">Cada agente pode ter o seu. "Padrão da conta" segue o modelo escolhido em Configurações. Preço: o publicado pela conta, por milhão de tokens de entrada / saída.</span>
        </label>
        <label className="field editor__wide">História (bio)
          <textarea rows={2} maxLength={600} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} placeholder="Quem é este personagem, em duas linhas. Aparece no perfil e na cidade." />
          <span className="hint">É o tom do personagem, não uma instrução para a IA. Trocar de tema? Mude nome e história à vontade: a função continua a mesma.</span>
        </label>
      </div>

      <label className="field">{fixed ? 'Foco da coordenação (o protocolo do cargo vai sempre; aqui entra o seu jeito: prioridades, tom, o que vem primeiro)' : 'Instruções (o que vai para a IA a cada execução)'}
        <textarea rows={6} maxLength={4000} value={f.charter} onChange={(e) => setF({ ...f, charter: e.target.value })} />
      </label>
      {!fixed && <div className="row">
        <button className="btn btn--sm" onClick={draft} disabled={!!drafting || !f.role.trim()}><Icon name="edit" size={13} /> {drafting ? 'A coordenação está escrevendo…' : 'Escrever com a coordenação'}</button>
        <span className="hint">{coordName(state.agents)} redige instruções, métodos e ferramentas a partir do papel e do setor; você revisa antes de salvar.</span>
      </div>}

      <div className="block">
        <h4>Métodos</h4>
        <div className="row row--wrap">
          {f.skills.map((s) => <span key={s} className="skill">{s} <button className="x" aria-label={`Tirar ${s}`} onClick={() => setF({ ...f, skills: f.skills.filter((x) => x !== s) })}>×</button></span>)}
          <form className="row" onSubmit={(e) => { e.preventDefault(); const v = newMethod.trim(); if (v) setF({ ...f, skills: [...new Set([...f.skills, v])] }); setNewMethod(''); }}>
            <input value={newMethod} maxLength={80} placeholder="novo método…" onChange={(e) => setNewMethod(e.target.value)} aria-label="Novo método" />
          </form>
        </div>
        {sector && sector.skills.some((s) => !f.skills.includes(s)) && (
          <p className="hint">Sugestões do setor: {sector.skills.filter((s) => !f.skills.includes(s)).map((s) => <button key={s} className="linkish" onClick={() => setF({ ...f, skills: [...f.skills, s] })}>+ {s}</button>)}</p>
        )}
      </div>

      <div className="block">
        <h4>Ferramentas <span className="muted small">— cada agente se especializa; quem não tem uma ferramenta pede ajuda a quem tem (a coordenação controla as travas)</span></h4>
        <div className="tools-grid">
          {(tools.data ?? []).filter((t) => fixed || !COORDINATOR_ONLY.includes(t.id)).map((t) => {
            const on = f.tools.includes(t.id);
            const blocked = t.status === 'bloqueada' && !on;
            const locked = fixed && COORDINATOR_TOOLS.includes(t.id);
            return (
              <label key={t.id} className={`tool-opt ${on ? 'tool-opt--on' : ''} ${blocked ? 'tool-opt--off' : ''}`} title={t.note}>
                <input type="checkbox" checked={on} disabled={blocked || locked} onChange={(e) => toggleTool(t.id, e.target.checked)} />
                <span className="tool-opt__txt"><b>{t.label}</b><small>{t.note}</small></span>
                <span className="tool-opt__tags">
                  {locked && <span className="badge">do cargo</span>}
                  {!locked && recommended.has(t.id) && <span className="badge">recomendada</span>}
                  {t.status !== 'disponível' && <span className={`badge ${TOOL_BADGE[t.status]}`}>{t.status}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="block">
        <h4>Skills da biblioteca <span className="muted small">— instruções prontas que o agente consulta quando tem a ferramenta "Skills da biblioteca"</span></h4>
        {f.hermesSkills.length > 0 && <div className="row row--wrap">{f.hermesSkills.map((s) => <span key={s} className="skill">{s} <button className="x" onClick={() => toggleSkill(s)} aria-label={`Tirar ${s}`}>×</button></span>)}</div>}
        {f.hermesSkills.length > 0 && !f.tools.includes('habilidades') && <p className="hint warn">Sem a ferramenta "Skills da biblioteca", o agente só recebe o nome das skills como orientação.</p>}
        {(skills.data?.length ?? 0) > 0 ? (
          <details>
            <summary className="muted">Escolher na biblioteca ({skills.data!.length})</summary>
            <input value={skillQ} onChange={(e) => setSkillQ(e.target.value)} placeholder="buscar (ex.: pesquisa, planilha, apresentação)" aria-label="Buscar skill" className="skill-search" />
            <div className="skill-list">
              {shownSkills.map((s) => (
                <button key={s.name} className={`skill-item ${f.hermesSkills.includes(s.name) ? 'skill-item--on' : ''}`} onClick={() => toggleSkill(s.name)}>
                  <b>{s.name}</b><span className="muted">{s.category}</span><small>{s.description}</small>
                </button>
              ))}
            </div>
          </details>
        ) : <p className="hint">Biblioteca de skills indisponível (sem conta de IA conectada).</p>}
      </div>

      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      {offResult && (
        <div className="ok">
          {agent.name} desativado. {offResult.redistributed.length ? `Tarefas redistribuídas pela coordenação: ${offResult.redistributed.map((r) => `#${r.number} → ${r.to}`).join(', ')}.` : 'Não havia tarefas abertas.'}
          {offResult.tools.length ? ` Ferramentas que só ele tinha: ${offResult.tools.map((t) => `${t.label} → ${t.to}`).join(', ')}.` : ''}
        </div>
      )}
      <div className="editor__foot">
        {fixed ? <span className="hint">O Coordenador não sai da equipe.</span> : active ? (
          confirmOff ? (
            <div className="confirm">
              Ao desativar {agent.name}, a coordenação revisa os fluxos que dependem dele: as tarefas abertas passam a colegas e as ferramentas que só ele tinha são repassadas. Conversas e histórico ficam guardados e você pode reativar depois.
              <button className="btn btn--sm btn--primary" onClick={deactivate}>Desativar</button>
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmOff(false)}>Cancelar</button>
            </div>
          ) : <button className="btn btn--ghost" onClick={() => setConfirmOff(true)}>Desativar agente</button>
        ) : <button className="btn" onClick={reactivate}>Reativar</button>}
        <span className="grow" />
        <button className="btn btn--ghost" onClick={() => { setF(init()); setMsg(null); }} disabled={!dirty}>Desfazer</button>
        <button className="btn btn--primary" onClick={save} disabled={!dirty}>Salvar</button>
        {!active && <button className="btn btn--ghost" onClick={onClose}>Fechar</button>}
      </div>
    </div>
  );
}

function ActivityTab({ agent }: { agent: Agent }) {
  const d = useResource<Activity>(`/api/agents/${agent.id}/activity`, ['runs.changed', 'tasks.changed']);
  if (!d.data) return <Loading error={d.error} />;
  const t = d.data.totals;
  return (
    <div>
      <p className="muted">{fmtN(t.runs)} execuções reais · {fmtN((t.tokens_in ?? 0) + (t.tokens_out ?? 0))} tokens (entrada {fmtN(t.tokens_in)} · saída {fmtN(t.tokens_out)})</p>
      <h4>Com quem está o quê</h4>
      {d.data.tasks.length ? (
        <ul className="plain">{d.data.tasks.map((x) => <li key={x.id}><span className="muted">#{x.number}</span> {x.title} <span className={`badge ${x.completed ? 'badge--ok' : ''}`}>{x.completed ? 'feito' : x.column_name}</span></li>)}</ul>
      ) : <p className="hint">Nenhuma tarefa no quadro da equipe.</p>}
      <h4>Últimas execuções</h4>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Quando</th><th>Tipo</th><th>Modelo</th><th>Tokens</th><th>Estado</th></tr></thead>
        <tbody>{d.data.runs.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>{r.kind === 'chat' ? 'conversa' : 'tarefa'}</td>
            <td>{r.mode === 'simulated' ? <span className="badge badge--warn">simulação</span> : modelName(r.model)}</td>
            <td>{r.tokens_in === null ? '—' : fmtN((r.tokens_in ?? 0) + (r.tokens_out ?? 0))}</td>
            <td>{RUN_STATUS[r.status] ?? r.status}{r.error ? <span className="small error-inline"> {r.error}</span> : null}</td>
          </tr>
        ))}
        {!d.data.runs.length && <tr><td colSpan={5} className="muted">Ainda sem execuções.</td></tr>}</tbody>
      </table></div>
    </div>
  );
}
