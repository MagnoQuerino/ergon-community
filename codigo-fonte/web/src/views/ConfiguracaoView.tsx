import { MinhaContaPanel, WorkspaceConfigPanel } from './ContaPanel.tsx';
import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AgentTool, AiStatus, AppState, ComposicaoAgente, ComposicaoResumo, ProcessLimit, Usage } from '../lib/types.ts';
import { COMPACTAR_AJUDA, COMPACTAR_ATUALIZACAO, COMPACTAR_DEPOIS, COMPACTAR_ROTULO, COMPOSICAO_ESTIMADA, COMPOSICAO_INTRO, COMPOSICAO_NOTA, COMPOSICAO_VAZIA, PASSOS_AJUDA, PASSOS_DEPOIS, PASSOS_OPCOES, PASSOS_PADRAO, chamadasTexto, detalhe, fatias, passosCompartilhado, tamanhoMedio } from '../lib/custo.ts';
import { TOOL_BADGE } from '../components/AgentProfile.tsx';
import { Icon } from '../components/Icon.tsx';
import { holdersText } from '../lib/team.ts';
import type { Me, VersionInfo } from '../lib/types.ts';

/** GET /api/ai/tools: cada ferramenta com quem a tem (contagem e até 3 nomes, o Coordenador primeiro). */
type ToolWithHolders = AgentTool & { holders?: { count: number; sample: string[] } };
import { SaudePanel } from './SaudePanel.tsx';
import { SegurancaPanel } from './SegurancaPanel.tsx';
import { PessoasPanel } from './PessoasPanel.tsx';
import { PacotesPanel } from './PacotesPanel.tsx';
import { AtualizacoesPanel } from './AtualizacoesPanel.tsx';
import { MusicCreditsBlock } from '../components/MusicButton.tsx';
import { lazy, Suspense, type ComponentType } from 'react';

// módulo opcional (views/world): a Community não traz essa pasta
const worldMod = Object.values(import.meta.glob<{ default: ComponentType }>('./world/WorldPanel.tsx'))[0];
const WorldPanel = worldMod ? lazy(worldMod) : null;


/** Configuração: as ferramentas da equipe (andamento, consumo), a conta, o workspace, a segurança e, para quem administra
 *  o Ergon neste computador, as pessoas e a saúde da instalação. */
export function ConfiguracaoView({ state, me, onMeChanged, reload }: { state: AppState; me: Me; onMeChanged: () => void; reload: () => void }) {
  const admin = me.admin;
  const [tab, setTab] = useState<'ia' | 'conta' | 'workspace' | 'seguranca' | 'saude' | 'pessoas' | 'pacotes' | 'world' | 'atualizacoes'>(() => (location.hash.includes('?conta') ? 'conta' : location.hash.includes('atualizacoes') ? 'atualizacoes' : location.hash.includes('?workspace') ? 'workspace' : location.hash.includes('seguranca') ? 'seguranca' : location.hash.includes('world') && WorldPanel ? 'world' : location.hash.includes('pacotes') ? 'pacotes'
    : location.hash.includes('saude') && admin ? 'saude' : location.hash.includes('pessoas') && admin ? 'pessoas' : 'ia'));
  // o menu da conta abre Configurações › Minha conta (ou Workspace) mesmo com Configurações já aberta
  useEffect(() => {
    const ver = () => { if (location.hash.includes('?conta')) setTab('conta'); else if (location.hash.includes('?workspace')) setTab('workspace'); else if (location.hash.includes('?atualizacoes')) setTab('atualizacoes'); };
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
          {me.mode === 'local' && <button role="tab" aria-selected={tab === 'atualizacoes'} className={`tab ${tab === 'atualizacoes' ? 'tab--on' : ''}`} onClick={() => setTab('atualizacoes')}>Atualizações</button>}
          {admin && <button role="tab" aria-selected={tab === 'saude'} className={`tab ${tab === 'saude' ? 'tab--on' : ''}`} onClick={() => setTab('saude')}>Saúde</button>}
        </div>
      </header>
      {tab === 'conta' ? <MinhaContaPanel me={me} onChanged={onMeChanged} /> : tab === 'workspace' ? <WorkspaceConfigPanel state={state} me={me} /> : tab === 'ia' ? <IaPanel state={state} reload={reload} /> : tab === 'pacotes' ? <PacotesPanel agent={state.team.coordinator} /> :tab === 'world' && WorldPanel ? <Suspense fallback={null}><WorldPanel /></Suspense> : tab === 'saude' ? <SaudePanel /> : tab === 'atualizacoes' ? <AtualizacoesPanel admin={admin} /> : tab === 'pessoas' ? <PessoasPanel me={me} /> : <SegurancaGate><SegurancaPanel me={me} onChanged={onMeChanged} /></SegurancaGate>}
      <VersionCard onOpen={() => setTab('atualizacoes')} />
      <MusicCreditsBlock />
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

/** Rodapé com a versão instalada; o botão leva a Configurações › Atualizações (verificar, atualizar, voltar, aviso). */
function VersionCard({ onOpen }: { onOpen: () => void }) {
  const v = useResource<VersionInfo>('/api/version', []);
  if (!v.data) return null;
  const d = v.data;
  return (
    <div className="hint version version--row">
      <span>
        Ergon {d.version}{d.build !== 'dev' ? ` (${d.build})` : ''} · {d.mode === 'cloud' ? 'nuvem' : 'neste computador'}
        {d.updateAvailable && d.latest ? <> · <b>versão {d.latest.version} disponível</b></> : null}
      </span>
      {d.mode === 'local' && <button className="btn btn--sm" onClick={onOpen}>Atualizações</button>}
    </div>
  );
}

function IaPanel({ state, reload }: { state: AppState; reload: () => void }) {
  const status = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const tools = useResource<ToolWithHolders[]>('/api/ai/tools', ['agents.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed']);
  const composicao = useResource<ComposicaoResumo>('/api/usage/composicao?dias=30', ['usage.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);


  // quem tem cada ferramenta vem na própria lista (holders): basta relê-la
  const toggleTool = async (id: string, on: boolean) => {
    const enabled = (tools.data ?? []).filter((t) => t.kind === 'ia' && t.platform && t.id !== id).map((t) => t.id);
    try { await api.put('/api/ai/tools', { enabled: on ? [...enabled, id] : enabled }); tools.reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
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
                <span className="muted small">{holdersText(t.holders)}</span></span>
            </label>
          ) : (
            <label key={t.id} className={`tool-opt ${t.platform ? 'tool-opt--on' : ''} ${!t.safe && !t.guarded ? 'tool-opt--off' : ''}`}>
              <input type="checkbox" checked={!!t.platform} disabled={(!t.safe && !t.guarded) || !s?.available || t.id === 'passos'} onChange={(e) => void toggleTool(t.id, e.target.checked)} />
              <span className="tool-opt__txt"><b>{t.guarded && <Icon name="lock" size={12} />} {t.label}</b><small>{t.note.replace(/ — (desligada|bloqueada):.*$/, '')}{t.guarded && !t.platform ? ' · ligar pede a sua senha' : ''}</small></span>
              <span className="tool-opt__tags"><span className={`badge ${TOOL_BADGE[t.status]}`}>{t.safe || t.guarded ? (t.platform ? 'ligada' : t.guarded ? 'protegida' : 'desligada') : 'bloqueada'}</span>
                <span className="muted small">{holdersText(t.holders)}</span></span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Andamento da equipe</h3>
        <label className="check"><input type="checkbox" checked={state.teamAutorun} onChange={async (e) => { try { await api.put('/api/team/autorun', { enabled: e.target.checked }); reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); } }} />
          A equipe pega sozinha as tarefas de “A fazer”, de cima para baixo</label>
        <label className="check"><input type="checkbox" checked={state.teamInitiative !== false} onChange={async (e) => { try { await api.put('/api/team/initiative', { enabled: e.target.checked }); reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); } }} />
          A equipe puxa conversa quando você chega (boas-vindas com o resumo e quem precisa de você)</label>
        <ProcessLimitField limit={state.runs.limit} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <PassosField value={state.teamMaxTurns ?? PASSOS_PADRAO} pendente={state.teamMaxTurnsPendente === true} outros={state.teamMaxTurnsOutros ?? 0} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <CompactacaoField ligada={state.teamCompactacao !== false} pendente={state.teamCompactacaoPendente === true} atualizacao={state.teamCompactacaoAtualizacao === true} outros={state.teamMaxTurnsOutros ?? 0} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <p className="hint">Conversas não entram no limite: você fala com qualquer agente a qualquer hora, mesmo com a equipe ocupada. Cards, rotinas e revisões acima do limite esperam a vez — os cards em “A fazer”, onde você pode marcar Prioridade ou arrastar para o topo. Cada tarefa usa o modelo de IA e conta no consumo.</p>
      </section>

      {usage.data && (
        <section className="card">
          <h3>Consumo</h3>
          <p>Este mês: <strong>{(usage.data.month.tokensIn + usage.data.month.tokensOut).toLocaleString('pt-BR')}</strong> tokens em {usage.data.month.runs} execuções reais{usage.data.costVisible && usage.data.month.costUsd !== null ? <> · custo informado: <strong>US$ {usage.data.month.costUsd.toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</strong></> : null}.</p>
          <p className="hint">{usage.data.note}</p>
        </section>
      )}

      {composicao.data && <ComposicaoCard data={composicao.data} />}
    </>
  );
}

/**
 * Passos por pedido: quantas idas ao modelo um pedido pode dar (padrão 20). Grava na hora; vale no próximo pedido. O valor
 * e o aviso de que ainda não chegou à equipe vêm do servidor (o que vale de fato no motor deste workspace, também depois
 * de recarregar a tela); a resposta do salvar só antecipa o aviso até o estado chegar.
 */
function PassosField({ value, pendente, outros, onSaved, onError }: { value: number; pendente: boolean; outros: number; onSaved: () => void; onError: (text: string) => void }) {
  const [escolha, setEscolha] = useState(value);
  const [depois, setDepois] = useState(pendente);
  useEffect(() => { setEscolha(value); }, [value]);
  useEffect(() => { setDepois(pendente); }, [pendente]);
  const save = async (n: number) => {
    const antes = escolha;
    setEscolha(n);
    try { const r = await api.put<{ value: number; applied: boolean }>('/api/team/max-turns', { value: n }); setDepois(!r.applied); onSaved(); }
    catch (x) { setEscolha(antes); onError(errMsg(x)); }
  };
  const opcoes = [...new Set([...PASSOS_OPCOES, escolha])].sort((a, b) => a - b);
  return (
    <div className="field field--limit">
      <label htmlFor="passos-pedido">Passos por pedido</label>
      <select id="passos-pedido" value={String(escolha)} onChange={(e) => void save(Number(e.target.value))} aria-describedby="passos-pedido-hint">
        {opcoes.map((n) => <option key={n} value={n}>até {n} passos{n === PASSOS_PADRAO ? ' (padrão)' : ''}</option>)}
      </select>
      <small id="passos-pedido-hint" className="muted">{PASSOS_AJUDA}{outros ? ` ${passosCompartilhado(outros)}` : ''}{depois ? ` ${PASSOS_DEPOIS}` : ''}</small>
    </div>
  );
}

/**
 * Resumir as conversas longas mais cedo (ligado por padrão): grava na hora e vale no próximo pedido. Uma caixa de marcar do
 * mesmo jeito das outras da seção, com a ajuda embaixo e o aviso em linha própria. O valor e os avisos vêm do servidor
 * (ainda não chegou à equipe; ou a equipe é de antes desta opção e ela chega com a próxima atualização — a escolha fica
 * guardada); a resposta do salvar só antecipa o aviso até o estado chegar.
 */
function CompactacaoField({ ligada, pendente, atualizacao, outros, onSaved, onError }: { ligada: boolean; pendente: boolean; atualizacao: boolean; outros: number; onSaved: () => void; onError: (text: string) => void }) {
  const [on, setOn] = useState(ligada);
  const [depois, setDepois] = useState(pendente);
  const [chega, setChega] = useState(atualizacao);
  useEffect(() => { setOn(ligada); }, [ligada]);
  useEffect(() => { setDepois(pendente); }, [pendente]);
  useEffect(() => { setChega(atualizacao); }, [atualizacao]);
  const save = async (v: boolean) => {
    const antes = on;
    setOn(v);
    try {
      const r = await api.put<{ enabled: boolean; applied: boolean; atualizacao?: boolean }>('/api/team/compactacao', { enabled: v });
      setChega(r.atualizacao === true); setDepois(!r.applied && r.atualizacao !== true); onSaved();
    } catch (x) { setOn(antes); onError(errMsg(x)); }
  };
  const aviso = chega ? COMPACTAR_ATUALIZACAO : depois ? COMPACTAR_DEPOIS : '';
  return (
    <div className="compactar">
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => void save(e.target.checked)} aria-describedby="compactar-hint" /> {COMPACTAR_ROTULO}</label>
      <p id="compactar-hint" className="hint">{COMPACTAR_AJUDA}{outros ? ` ${passosCompartilhado(outros)}` : ''}</p>
      {aviso && <p className="hint" role="status">{aviso}</p>}
    </div>
  );
}

/** Do que é feita cada chamada ao modelo: a equipe toda e os agentes que mais gastam (últimos 30 dias, medido). */
function ComposicaoCard({ data }: { data: ComposicaoResumo }) {
  const linhas = data.geral ? [data.geral, ...data.agentes.slice(0, 8)] : [];
  return (
    <section className="card">
      <h3>Do que é feita cada chamada</h3>
      <p className="muted small">{COMPOSICAO_INTRO}</p>
      {!linhas.length ? <p className="hint">{COMPOSICAO_VAZIA}</p> : (
        <div className="custo-lista">
          {linhas.map((a, i) => <ComposicaoLinha key={a.agentId || 'geral'} a={a} geral={i === 0} />)}
        </div>
      )}
      {!!linhas.length && <p className="hint">{COMPOSICAO_NOTA}{linhas.some((a) => a.estimado) ? ` ${COMPOSICAO_ESTIMADA}` : ''}</p>}
    </section>
  );
}

function ComposicaoLinha({ a, geral }: { a: ComposicaoAgente; geral: boolean }) {
  const partes = fatias(a);
  return (
    <div className="custo-linha">
      <div className="custo-linha__topo">
        {geral ? <strong>{a.nome}</strong> : <b>{a.nome}</b>}
        <span className="muted small">{chamadasTexto(a.chamadas)} · {tamanhoMedio(a.mediaPorChamada)}</span>
      </div>
      <div className="custo-barra" role="img" aria-label={partes.map((p) => `${p.rotulo} ${p.pct}`).join(', ')}>
        {partes.filter((p) => p.fracao > 0).map((p) => <span key={p.id} className={`custo--${p.id}`} style={{ width: `${p.fracao * 100}%` }} />)}
      </div>
      <ul className="custo-legenda">
        {partes.map((p) => <li key={p.id}><i className={`custo--${p.id}`} aria-hidden="true" />{p.rotulo} {p.pct}</li>)}
      </ul>
      <p className="hint small">{detalhe(a)}</p>
    </div>
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
