import { MinhaContaPanel, WorkspaceConfigPanel } from './ContaPanel.tsx';
import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AgentTool, AiStatus, AppState, ModelCatalog, ProcessLimit, Usage } from '../lib/types.ts';
import { ModelSelect, TOOL_BADGE } from '../components/AgentProfile.tsx';
import { Icon } from '../components/Icon.tsx';
import type { Me, VersionInfo } from '../lib/types.ts';
import { SaudePanel } from './SaudePanel.tsx';
import { SegurancaPanel } from './SegurancaPanel.tsx';
import { PessoasPanel } from './PessoasPanel.tsx';
import { PacotesPanel } from './PacotesPanel.tsx';
import { lazy, Suspense, type ComponentType } from 'react';

// módulo opcional (views/world): a Community não traz essa pasta
const worldMod = Object.values(import.meta.glob<{ default: ComponentType }>('./world/WorldPanel.tsx'))[0];
const WorldPanel = worldMod ? lazy(worldMod) : null;
import { AiAccounts } from '../components/AiAccounts.tsx';


/** Configuração: a IA da equipe (conta, modelo, ferramentas, andamento), a segurança da conta e, para quem administra
 *  o Ergon neste computador, as pessoas e a saúde da instalação. */
export function ConfiguracaoView({ state, me, onMeChanged, reload }: { state: AppState; me: Me; onMeChanged: () => void; reload: () => void }) {
  const admin = me.admin;
  const [tab, setTab] = useState<'ia' | 'conta' | 'workspace' | 'seguranca' | 'saude' | 'pessoas' | 'pacotes' | 'world'>(() => (location.hash.includes('?conta') ? 'conta' : location.hash.includes('?workspace') ? 'workspace' : location.hash.includes('seguranca') ? 'seguranca' : location.hash.includes('world') && WorldPanel ? 'world' : location.hash.includes('pacotes') ? 'pacotes'
    : location.hash.includes('saude') && admin ? 'saude' : location.hash.includes('pessoas') && admin ? 'pessoas' : 'ia'));
  // o menu da conta abre Configurações › Minha conta (ou Workspace) mesmo com Configurações já aberta
  useEffect(() => {
    const ver = () => { if (location.hash.includes('?conta')) setTab('conta'); else if (location.hash.includes('?workspace')) setTab('workspace'); };
    window.addEventListener('hashchange', ver);
    return () => window.removeEventListener('hashchange', ver);
  }, []);
  return (
    <div className="page">
      <header className="page__head">
        <h2>Configurações</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'conta'} className={`tab ${tab === 'conta' ? 'tab--on' : ''}`} onClick={() => setTab('conta')}>Minha conta</button>
          <button role="tab" aria-selected={tab === 'workspace'} className={`tab ${tab === 'workspace' ? 'tab--on' : ''}`} onClick={() => setTab('workspace')}>Workspace</button>
          <button role="tab" aria-selected={tab === 'ia'} className={`tab ${tab === 'ia' ? 'tab--on' : ''}`} onClick={() => setTab('ia')}>IA da equipe</button>
          <button role="tab" aria-selected={tab === 'seguranca'} className={`tab ${tab === 'seguranca' ? 'tab--on' : ''}`} onClick={() => setTab('seguranca')}>Segurança</button>
          {admin && me.mode === 'local' && <button role="tab" aria-selected={tab === 'pessoas'} className={`tab ${tab === 'pessoas' ? 'tab--on' : ''}`} onClick={() => setTab('pessoas')}>Pessoas</button>}
          <button role="tab" aria-selected={tab === 'pacotes'} className={`tab ${tab === 'pacotes' ? 'tab--on' : ''}`} onClick={() => setTab('pacotes')}>Pacotes</button>
          {WorldPanel && <button role="tab" aria-selected={tab === 'world'} className={`tab ${tab === 'world' ? 'tab--on' : ''}`} onClick={() => setTab('world')}>Conta Ergon</button>}
          {admin && <button role="tab" aria-selected={tab === 'saude'} className={`tab ${tab === 'saude' ? 'tab--on' : ''}`} onClick={() => setTab('saude')}>Saúde</button>}
        </div>
      </header>
      {tab === 'conta' ? <MinhaContaPanel me={me} onChanged={onMeChanged} /> : tab === 'workspace' ? <WorkspaceConfigPanel state={state} me={me} /> : tab === 'ia' ? <IaPanel state={state} reload={reload} /> : tab === 'pacotes' ? <PacotesPanel agents={state.agents} /> : tab === 'world' && WorldPanel ? <Suspense fallback={null}><WorldPanel /></Suspense> : tab === 'saude' ? <SaudePanel /> : tab === 'pessoas' ? <PessoasPanel me={me} /> : <SegurancaPanel me={me} onChanged={onMeChanged} />}
      <VersionCard />
    </div>
  );
}

/** Versão instalada e aviso de atualização (a mesma versão vale para o Ergon local e o da nuvem). */
function VersionCard() {
  const v = useResource<VersionInfo>('/api/version', []);
  if (!v.data) return null;
  const d = v.data;
  return (
    <p className="hint version">
      Ergon {d.version}{d.build !== 'dev' ? ` (${d.build})` : ''} · {d.mode === 'cloud' ? 'nuvem' : 'neste computador'}
      {d.updateAvailable && d.latest ? <> · <b>versão {d.latest.version} disponível</b>{d.mode === 'local' ? <> — para atualizar, rode no computador: <code>ergon atualizar</code> (faz backup antes)</> : null}{d.latest.url ? <> · <a href={d.latest.url} target="_blank" rel="noreferrer noopener">novidades</a></> : null}</> : null}
    </p>
  );
}

function IaPanel({ state, reload }: { state: AppState; reload: () => void }) {
  const status = useResource<AiStatus>('/api/ai/status', []);
  const catalog = useResource<ModelCatalog>('/api/ai/models', []);
  const tools = useResource<AgentTool[]>('/api/ai/tools', ['agents.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [def, setDef] = useState<{ model: string | null; provider: string | null }>({ model: null, provider: null });
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { if (catalog.data) setDef({ model: catalog.data.default.model, provider: catalog.data.default.provider }); }, [catalog.data]);


  const saveDefault = async (force = false) => {
    if (!def.model || !def.provider) return;
    setMsg(null);
    try {
      const r = await api.post<{ ok: boolean; confirmMessage: string | null }>('/api/ai/default-model', { provider: def.provider, model: def.model, confirm: force });
      if (!r.ok && r.confirmMessage) { setConfirm(r.confirmMessage); return; }
      setConfirm(null); setMsg({ kind: 'ok', text: 'Modelo padrão da conta alterado. Vale para os agentes sem modelo próprio, a partir da próxima conversa.' }); catalog.reload(); status.reload();
    } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const toggleTool = async (id: string, on: boolean) => {
    const enabled = (tools.data ?? []).filter((t) => t.kind === 'ia' && t.platform && t.id !== id).map((t) => t.id);
    try { await api.put('/api/ai/tools', { enabled: on ? [...enabled, id] : enabled }); tools.reload(); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const s = status.data;

  return (
    <>
      <p className="muted">A conta que paga os modelos, o modelo padrão e as ferramentas que os agentes podem usar.</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>Conta de IA</h3>
        {/* o aviso do modo de simulação vem do próprio AiAccounts (o mesmo em Conexões e nas boas-vindas) */}
        <AiAccounts onChanged={reload} />
      </section>

      <section className="card">
        <h3>Modelo padrão</h3>
        <p className="muted small">Usado por todos os agentes que não têm modelo próprio (cada agente pode ter o seu, no perfil dele).</p>
        {catalog.error ? <p className="hint">Conecte uma conta de IA para escolher.</p> : (
          <div className="row row--wrap">
            <ModelSelect catalog={catalog.data} value={def.model} provider={def.provider} allowDefault={false} onChange={(model, provider) => { setDef({ model, provider }); setConfirm(null); }} />
            <button className="btn btn--primary" disabled={!def.model || (def.model === catalog.data?.default.model && def.provider === catalog.data?.default.provider)} onClick={() => saveDefault()}>Salvar</button>
          </div>
        )}
        {confirm && <div className="confirm">{confirm} <button className="btn btn--sm btn--primary" onClick={() => saveDefault(true)}>Usar mesmo assim</button><button className="btn btn--sm btn--ghost" onClick={() => setConfirm(null)}>Cancelar</button></div>}
        <p className="hint">Preço: o publicado pela conta, em dólares por milhão de tokens (entrada / saída). Faixas: econômico até US$ 0,50, intermediário até US$ 3, ponta acima disso.</p>
      </section>

      <section className="card">
        <h3>Ferramentas da equipe</h3>
        <p className="muted small">O que fica ligado para os agentes. Cada agente usa só as que tem no perfil; quem não tem pede ajuda a um colega (a coordenação controla essas travas).</p>
        <p className="hint"><Icon name="lock" size={12} /> As que executam código ficam protegidas: ligar pede a sua senha. Se um agente precisar delas numa conversa, aparece um pedido de permissão ali mesmo, e você autoriza com a senha.</p>
        <div className="tools-grid">
          {(tools.data ?? []).filter((t) => t.kind === 'ia').map((t) => (
            <label key={t.id} className={`tool-opt ${t.platform ? 'tool-opt--on' : ''} ${!t.safe && !t.guarded ? 'tool-opt--off' : ''}`}>
              <input type="checkbox" checked={!!t.platform} disabled={(!t.safe && !t.guarded) || !s?.available || t.id === 'passos'} onChange={(e) => void toggleTool(t.id, e.target.checked)} />
              <span className="tool-opt__txt"><b>{t.guarded && <Icon name="lock" size={12} />} {t.label}</b><small>{t.note.replace(/ — (desligada|bloqueada):.*$/, '')}{t.guarded && !t.platform ? ' · ligar pede a sua senha' : ''}</small></span>
              <span className="tool-opt__tags"><span className={`badge ${TOOL_BADGE[t.status]}`}>{t.safe || t.guarded ? (t.platform ? 'ligada' : t.guarded ? 'protegida' : 'desligada') : 'bloqueada'}</span>
                <span className="muted small">{state.agents.filter((a) => a.status === 'active' && a.tools.some((x) => x.id === t.id)).map((a) => a.name).join(', ') || 'ninguém'}</span></span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Andamento da equipe</h3>
        <label className="check"><input type="checkbox" checked={state.teamAutorun} onChange={async (e) => { try { await api.put('/api/team/autorun', { enabled: e.target.checked }); reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); } }} />
          A equipe pega sozinha as tarefas de “A fazer”, de cima para baixo</label>
        <ProcessLimitField limit={state.runs.limit} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <p className="hint">Conversas não entram no limite: você fala com qualquer agente a qualquer hora, mesmo com a equipe ocupada. Cards, rotinas e revisões acima do limite esperam a vez — os cards em “A fazer”, onde você pode marcar Prioridade ou arrastar para o topo. Cada tarefa usa o modelo de IA e conta no consumo.</p>
      </section>

      {usage.data && (
        <section className="card">
          <h3>Consumo</h3>
          <p>Este mês: <strong>{(usage.data.month.tokensIn + usage.data.month.tokensOut).toLocaleString('pt-BR')}</strong> tokens em {usage.data.month.runs} execuções reais{usage.data.costVisible && usage.data.month.costUsd !== null ? <> · custo informado: <strong>US$ {usage.data.month.costUsd.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</strong></> : null}.</p>
          <p className="hint">{usage.data.note}</p>
        </section>
      )}
    </>
  );
}

/** Quantos processos andam ao mesmo tempo: automático (pela memória que o Ergon tem), um número ou sem limite. */
function ProcessLimitField({ limit, onSaved, onError }: { limit: ProcessLimit; onSaved: () => void; onError: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const numbers = [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, ...(typeof limit.choice === 'number' ? [limit.choice] : [])])].sort((a, b) => a - b);
  const save = async (v: string) => {
    setBusy(true);
    try { await api.put('/api/runs/limit', { choice: v === 'auto' || v === 'ilimitado' ? v : Number(v) }); onSaved(); }
    catch (x) { onError(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="field field--limit">
      <label htmlFor="proc-limit">Trabalhos ao mesmo tempo</label>
      <select id="proc-limit" value={String(limit.choice)} disabled={busy} onChange={(e) => void save(e.target.value)} aria-describedby="proc-limit-hint">
        <option value="auto">Automático ({limit.machine} nesta máquina)</option>
        {numbers.map((n) => <option key={n} value={n}>{n} ao mesmo tempo</option>)}
        <option value="ilimitado">Sem limite</option>
      </select>
      <small id="proc-limit-hint" className="muted">
        O automático usa um a cada 4 GB de memória do Ergon (aqui: {limit.memoryGb.toLocaleString('pt-BR')} GB, {limit.cpus} núcleos), até 6. Sem limite, tudo anda junto: só num computador forte.
        {limit.cap !== null ? ` O seu plano permite até ${limit.cap}.` : ''}
      </small>
    </div>
  );
}
