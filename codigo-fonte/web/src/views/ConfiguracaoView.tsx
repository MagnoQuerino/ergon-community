import { MinhaContaPanel, WorkspaceConfigPanel } from './ContaPanel.tsx';
import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AgentTool, AiStatus, AppState, ProcessLimit, Usage } from '../lib/types.ts';
import { TOOL_BADGE } from '../components/AgentProfile.tsx';
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


/** Configuração: as ferramentas da equipe (andamento, consumo), a conta, o workspace, a segurança e, para quem administra
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
          <button role="tab" aria-selected={tab === 'ia'} className={`tab ${tab === 'ia' ? 'tab--on' : ''}`} onClick={() => setTab('ia')}>Ferramentas da equipe</button>
          <button role="tab" aria-selected={tab === 'conta'} className={`tab ${tab === 'conta' ? 'tab--on' : ''}`} onClick={() => setTab('conta')}>Minha conta</button>
          <button role="tab" aria-selected={tab === 'workspace'} className={`tab ${tab === 'workspace' ? 'tab--on' : ''}`} onClick={() => setTab('workspace')}>Workspace</button>
          <button role="tab" aria-selected={tab === 'seguranca'} className={`tab ${tab === 'seguranca' ? 'tab--on' : ''}`} onClick={() => setTab('seguranca')}>Segurança</button>
          {admin && me.mode === 'local' && <button role="tab" aria-selected={tab === 'pessoas'} className={`tab ${tab === 'pessoas' ? 'tab--on' : ''}`} onClick={() => setTab('pessoas')}>Pessoas</button>}
          <button role="tab" aria-selected={tab === 'pacotes'} className={`tab ${tab === 'pacotes' ? 'tab--on' : ''}`} onClick={() => setTab('pacotes')}>Pacotes</button>
          {WorldPanel && <button role="tab" aria-selected={tab === 'world'} className={`tab ${tab === 'world' ? 'tab--on' : ''}`} onClick={() => setTab('world')}>Conta Ergon</button>}
          {admin && <button role="tab" aria-selected={tab === 'saude'} className={`tab ${tab === 'saude' ? 'tab--on' : ''}`} onClick={() => setTab('saude')}>Saúde</button>}
        </div>
      </header>
      {tab === 'conta' ? <MinhaContaPanel me={me} onChanged={onMeChanged} /> : tab === 'workspace' ? <WorkspaceConfigPanel state={state} me={me} /> : tab === 'ia' ? <IaPanel state={state} reload={reload} /> : tab === 'pacotes' ? <PacotesPanel agents={state.agents} /> : tab === 'world' && WorldPanel ? <Suspense fallback={null}><WorldPanel /></Suspense> : tab === 'saude' ? <SaudePanel /> : tab === 'pessoas' ? <PessoasPanel me={me} /> : <SegurancaGate><SegurancaPanel me={me} onChanged={onMeChanged} /></SegurancaGate>}
      <VersionCard />
    </div>
  );
}

/** Segurança só com a senha atual: pedida toda vez que a aba abre (vale enquanto ela estiver aberta). */
function SegurancaGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState(false);
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (ok) return <>{children}</>;
  const entrar = async () => {
    if (!senha) { setErr('Digite a sua senha atual.'); return; }
    setBusy(true); setErr(null);
    try { await api.post('/api/session/unlock', { password: senha }); setSenha(''); setOk(true); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  // as opções ficam à vista (em desfoque e sem clique): dá para saber o que se pode mudar aqui antes de abrir
  return (
    <div className="seg-gate">
      <div className="seg-gate__fundo" aria-hidden="true" inert>{children}</div>
      <div className="seg-gate__dialogo" role="dialog" aria-modal="false" aria-labelledby="seg-gate-titulo">
        <h3 id="seg-gate-titulo"><Icon name="lock" size={16} /> Desbloquear opções de segurança</h3>
        <p className="muted small">Senha, frase de recuperação, verificação em duas etapas e trancamento ficam protegidos. Digite a sua senha atual para mexer neles.</p>
        <form className="seg-gate__form" onSubmit={(e) => { e.preventDefault(); void entrar(); }}>
          <input className="input" type="password" autoComplete="current-password" autoFocus aria-label="Senha atual" placeholder="Senha atual" value={senha} onChange={(e) => { setSenha(e.target.value); setErr(null); }} />
          <button className="btn btn--primary" disabled={busy}>{busy ? 'Conferindo…' : 'Desbloquear'}</button>
        </form>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
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
  const status = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const tools = useResource<AgentTool[]>('/api/ai/tools', ['agents.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);


  const toggleTool = async (id: string, on: boolean) => {
    const enabled = (tools.data ?? []).filter((t) => t.kind === 'ia' && t.platform && t.id !== id).map((t) => t.id);
    try { await api.put('/api/ai/tools', { enabled: on ? [...enabled, id] : enabled }); tools.reload(); reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const s = status.data;

  return (
    <>
      <p className="muted">As ferramentas que os agentes podem usar, o andamento e o consumo da equipe. A conta de IA e o modelo padrão ficam em <a href="#conexoes">Conexões</a>.</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>Ferramentas da equipe</h3>
        <p className="muted small">O que fica ligado para os agentes. Cada agente usa só as que tem no perfil; quem não tem pede ajuda a um colega (a coordenação controla essas travas).</p>
        <p className="hint"><Icon name="lock" size={12} /> As que executam código ficam protegidas: ligar pede a sua senha. Também dá para pedir conversando com qualquer agente (“liga o Terminal para a Hipátia”): o pedido vai para a coordenação, e você confirma com a senha na conversa com ela.</p>
        <div className="tools-grid">
          {(tools.data ?? []).filter((t) => t.kind === 'ia' || t.id === 'agenda').map((t) => t.kind === 'ergon' ? (
            // do próprio Ergon: sempre ligada (vale para quem a tem no perfil)
            <label key={t.id} className="tool-opt tool-opt--on">
              <input type="checkbox" checked onChange={() => {}} aria-readonly="true" title="Ferramenta do próprio Ergon: sempre ligada" />
              <span className="tool-opt__txt"><b>{t.label}</b><small>{t.note}</small></span>
              <span className="tool-opt__tags"><span className={`badge ${TOOL_BADGE[t.status]}`}>ligada</span>
                <span className="muted small">{state.agents.filter((a) => a.status === 'active' && a.tools.some((x) => x.id === t.id)).map((a) => a.name).join(', ') || 'ninguém'}</span></span>
            </label>
          ) : (
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
        {numbers.map((n) => <option key={n} value={n}>{n} ao mesmo tempo{n === 5 ? ' (padrão)' : ''}</option>)}
        <option value="ilimitado">Sem limite</option>
      </select>
      <small id="proc-limit-hint" className="muted">
        O padrão é 5. O automático usa um a cada 4 GB de memória do Ergon (aqui: {limit.memoryGb.toLocaleString('pt-BR')} GB, {limit.cpus} núcleos), até 6. Sem limite, tudo anda junto: só num computador forte.
        {limit.cap !== null ? ` O seu plano permite até ${limit.cap}.` : ''}
      </small>
    </div>
  );
}
