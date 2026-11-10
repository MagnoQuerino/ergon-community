import { MinhaContaPanel, WorkspaceConfigPanel } from './ContaPanel.tsx';
import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import type { AgentTool, AiStatus, AppState, ComposicaoAgente, ComposicaoResumo, ProcessLimit, Usage } from '../lib/types.ts';
import { PASSOS_OPCOES, PASSOS_PADRAO, chamadasTexto, compactarAjuda, compactarAtualizacao, compactarDepois, compactarRotulo, composicaoEstimada, composicaoIntro, composicaoNota, composicaoVazia, detalhe, fatias, passosAjuda, passosCompartilhado, passosDepois, tamanhoMedio } from '../lib/custo.ts';
import { fmtMoeda, fmtNumero, tn, useT } from '../i18n/index.ts';
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
  const t = useT();
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
        <h2>{t('configuracoes.titulo')}</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'ia'} className={`tab ${tab === 'ia' ? 'tab--on' : ''}`} onClick={() => setTab('ia')}>{t('configuracoes.abas.ferramentas')}</button>
          <button role="tab" aria-selected={tab === 'conta'} className={`tab ${tab === 'conta' ? 'tab--on' : ''}`} onClick={() => setTab('conta')}>{t('configuracoes.abas.conta')}</button>
          <button role="tab" aria-selected={tab === 'workspace'} className={`tab ${tab === 'workspace' ? 'tab--on' : ''}`} onClick={() => setTab('workspace')}>{t('configuracoes.abas.workspace')}</button>
          <button role="tab" aria-selected={tab === 'seguranca'} className={`tab ${tab === 'seguranca' ? 'tab--on' : ''}`} onClick={() => setTab('seguranca')}>{t('configuracoes.abas.seguranca')}</button>
          {admin && me.mode === 'local' && <button role="tab" aria-selected={tab === 'pessoas'} className={`tab ${tab === 'pessoas' ? 'tab--on' : ''}`} onClick={() => setTab('pessoas')}>{t('configuracoes.abas.pessoas')}</button>}
          <button role="tab" aria-selected={tab === 'pacotes'} className={`tab ${tab === 'pacotes' ? 'tab--on' : ''}`} onClick={() => setTab('pacotes')}>{t('configuracoes.abas.pacotes')}</button>
          {WorldPanel && <button role="tab" aria-selected={tab === 'world'} className={`tab ${tab === 'world' ? 'tab--on' : ''}`} onClick={() => setTab('world')}>{t('configuracoes.abas.contaErgon')}</button>}
          {me.mode === 'local' && <button role="tab" aria-selected={tab === 'atualizacoes'} className={`tab ${tab === 'atualizacoes' ? 'tab--on' : ''}`} onClick={() => setTab('atualizacoes')}>{t('configuracoes.abas.atualizacoes')}</button>}
          {admin && <button role="tab" aria-selected={tab === 'saude'} className={`tab ${tab === 'saude' ? 'tab--on' : ''}`} onClick={() => setTab('saude')}>{t('configuracoes.abas.saude')}</button>}
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
  const t = useT();
  const [ok, setOk] = useState(false);
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (ok) return <>{children}</>;
  const entrar = async () => {
    if (!senha) { setErr(t('configuracoes.gate.senhaVazia')); return; }
    setBusy(true); setErr(null);
    try { await api.post('/api/session/unlock', { password: senha }); setSenha(''); setOk(true); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  // as opções ficam à vista (em desfoque e sem clique): dá para saber o que se pode mudar aqui antes de abrir
  return (
    <div className="seg-gate">
      <div className="seg-gate__fundo" aria-hidden="true" inert>{children}</div>
      <div className="seg-gate__dialogo" role="dialog" aria-modal="false" aria-labelledby="seg-gate-titulo">
        <h3 id="seg-gate-titulo"><Icon name="lock" size={16} /> {t('configuracoes.gate.titulo')}</h3>
        <p className="muted small">{t('configuracoes.gate.texto')}</p>
        <form className="seg-gate__form" onSubmit={(e) => { e.preventDefault(); void entrar(); }}>
          <input className="input" type="password" autoComplete="current-password" autoFocus aria-label={t('configuracoes.gate.senhaAtual')} placeholder={t('configuracoes.gate.senhaAtual')} value={senha} onChange={(e) => { setSenha(e.target.value); setErr(null); }} />
          <button className="btn btn--primary" disabled={busy}>{busy ? t('configuracoes.comum.conferindo') : t('configuracoes.gate.desbloquear')}</button>
        </form>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </div>
  );
}

/** Rodapé com a versão instalada; o botão leva a Configurações › Atualizações (verificar, atualizar, voltar, aviso). */
function VersionCard({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const v = useResource<VersionInfo>('/api/version', []);
  if (!v.data) return null;
  const d = v.data;
  const onde = d.mode === 'cloud' ? t('configuracoes.rodape.nuvem') : t('configuracoes.rodape.local');
  return (
    <div className="hint version version--row">
      <span>
        {d.build !== 'dev' ? t('configuracoes.rodape.versaoBuild', { versao: d.version, build: d.build, onde }) : t('configuracoes.rodape.versao', { versao: d.version, onde })}
        {d.updateAvailable && d.latest ? <> · <b>{t('configuracoes.rodape.disponivel', { versao: d.latest.version })}</b></> : null}
      </span>
      {d.mode === 'local' && <button className="btn btn--sm" onClick={onOpen}>{t('configuracoes.abas.atualizacoes')}</button>}
    </div>
  );
}

function IaPanel({ state, reload }: { state: AppState; reload: () => void }) {
  const t = useT();
  const status = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const tools = useResource<ToolWithHolders[]>('/api/ai/tools', ['agents.changed']);
  const usage = useResource<Usage>(`/api/usage?tz=${new Date().getTimezoneOffset()}`, ['runs.changed']);
  const composicao = useResource<ComposicaoResumo>('/api/usage/composicao?dias=30', ['usage.changed']);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);


  // quem tem cada ferramenta vem na própria lista (holders): basta relê-la
  const toggleTool = async (id: string, on: boolean) => {
    const enabled = (tools.data ?? []).filter((f) => f.kind === 'ia' && f.platform && f.id !== id).map((f) => f.id);
    try { await api.put('/api/ai/tools', { enabled: on ? [...enabled, id] : enabled }); tools.reload(); } catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
  };
  const s = status.data;

  return (
    <>
      <p className="muted">{tn('configuracoes.ia.intro', { conexoes: <a href="#conexoes">{t('configuracoes.ia.introConexoes')}</a> })}</p>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}

      <section className="card">
        <h3>{t('configuracoes.abas.ferramentas')}</h3>
        <p className="muted small">{t('configuracoes.ferr.texto')}</p>
        <p className="hint"><Icon name="lock" size={12} /> {t('configuracoes.ferr.protegidas')}</p>
        <div className="tools-grid">
          {(tools.data ?? []).filter((f) => f.kind === 'ia' || f.id === 'agenda').map((f) => f.kind === 'ergon' ? (
            // do próprio Ergon: sempre ligada (vale para quem a tem no perfil)
            <label key={f.id} className="tool-opt tool-opt--on">
              <input type="checkbox" checked onChange={() => {}} aria-readonly="true" title={t('configuracoes.ferr.sempreLigadaDica')} />
              <span className="tool-opt__txt"><b>{f.label}</b><small>{f.note}</small></span>
              <span className="tool-opt__tags"><span className={`badge ${TOOL_BADGE[f.status]}`}>{t('configuracoes.ferr.ligada')}</span>
                <span className="muted small">{holdersText(f.holders)}</span></span>
            </label>
          ) : (
            <label key={f.id} className={`tool-opt ${f.platform ? 'tool-opt--on' : ''} ${!f.safe && !f.guarded ? 'tool-opt--off' : ''}`}>
              <input type="checkbox" checked={!!f.platform} disabled={(!f.safe && !f.guarded) || !s?.available || f.id === 'passos'} onChange={(e) => void toggleTool(f.id, e.target.checked)} />
              <span className="tool-opt__txt"><b>{f.guarded && <Icon name="lock" size={12} />} {f.label}</b><small>{f.note.replace(/ — (desligada|bloqueada):.*$/, '')}{f.guarded && !f.platform ? ` · ${t('configuracoes.ferr.pedeSenha')}` : ''}</small></span>
              <span className="tool-opt__tags"><span className={`badge ${TOOL_BADGE[f.status]}`}>{f.safe || f.guarded ? (f.platform ? t('configuracoes.ferr.ligada') : f.guarded ? t('configuracoes.ferr.protegida') : t('configuracoes.ferr.desligada')) : t('configuracoes.ferr.bloqueada')}</span>
                <span className="muted small">{holdersText(f.holders)}</span></span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>{t('configuracoes.andamento.titulo')}</h3>
        <label className="check"><input type="checkbox" checked={state.teamAutorun} onChange={async (e) => { try { await api.put('/api/team/autorun', { enabled: e.target.checked }); reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); } }} />
          {t('configuracoes.andamento.autorun')}</label>
        <label className="check"><input type="checkbox" checked={state.teamInitiative !== false} onChange={async (e) => { try { await api.put('/api/team/initiative', { enabled: e.target.checked }); reload(); } catch (x) { setMsg({ kind: 'error', text: errMsg(x) }); } }} />
          {t('configuracoes.andamento.iniciativa')}</label>
        <ProcessLimitField limit={state.runs.limit} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <PassosField value={state.teamMaxTurns ?? PASSOS_PADRAO} pendente={state.teamMaxTurnsPendente === true} outros={state.teamMaxTurnsOutros ?? 0} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <CompactacaoField ligada={state.teamCompactacao !== false} pendente={state.teamCompactacaoPendente === true} atualizacao={state.teamCompactacaoAtualizacao === true} outros={state.teamMaxTurnsOutros ?? 0} onSaved={reload} onError={(text) => setMsg({ kind: 'error', text })} />
        <p className="hint">{t('configuracoes.andamento.dica')}</p>
      </section>

      {usage.data && (
        <section className="card">
          <h3>{t('configuracoes.consumo.titulo')}</h3>
          <p>{usage.data.costVisible && usage.data.month.costUsd !== null
            ? tn('configuracoes.consumo.mesComCusto', { n: usage.data.month.runs, tokens: <strong>{fmtNumero(usage.data.month.tokensIn + usage.data.month.tokensOut)}</strong>, custo: <strong>{fmtMoeda(usage.data.month.costUsd, 'USD', { maximumFractionDigits: 4 })}</strong> })
            : tn('configuracoes.consumo.mes', { n: usage.data.month.runs, tokens: <strong>{fmtNumero(usage.data.month.tokensIn + usage.data.month.tokensOut)}</strong> })}</p>
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
  const t = useT();
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
      <label htmlFor="passos-pedido">{t('configuracoes.passos.rotulo')}</label>
      <select id="passos-pedido" value={String(escolha)} onChange={(e) => void save(Number(e.target.value))} aria-describedby="passos-pedido-hint">
        {opcoes.map((n) => <option key={n} value={n}>{n === PASSOS_PADRAO ? t('configuracoes.passos.opcaoPadrao', { n }) : t('configuracoes.passos.opcao', { n })}</option>)}
      </select>
      <small id="passos-pedido-hint" className="muted">{passosAjuda()}{outros ? ` ${passosCompartilhado(outros)}` : ''}{depois ? ` ${passosDepois()}` : ''}</small>
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
  useT(); // troca de idioma redesenha os textos de lib/custo.ts
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
  const aviso = chega ? compactarAtualizacao() : depois ? compactarDepois() : '';
  return (
    <div className="compactar">
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => void save(e.target.checked)} aria-describedby="compactar-hint" /> {compactarRotulo()}</label>
      <p id="compactar-hint" className="hint">{compactarAjuda()}{outros ? ` ${passosCompartilhado(outros)}` : ''}</p>
      {aviso && <p className="hint" role="status">{aviso}</p>}
    </div>
  );
}

/** Do que é feita cada chamada ao modelo: a equipe toda e os agentes que mais gastam (últimos 30 dias, medido). */
function ComposicaoCard({ data }: { data: ComposicaoResumo }) {
  const t = useT();
  const linhas = data.geral ? [data.geral, ...data.agentes.slice(0, 8)] : [];
  return (
    <section className="card">
      <h3>{t('configuracoes.custo.composicaoTitulo')}</h3>
      <p className="muted small">{composicaoIntro()}</p>
      {!linhas.length ? <p className="hint">{composicaoVazia()}</p> : (
        <div className="custo-lista">
          {linhas.map((a, i) => <ComposicaoLinha key={a.agentId || 'geral'} a={a} geral={i === 0} />)}
        </div>
      )}
      {!!linhas.length && <p className="hint">{composicaoNota()}{linhas.some((a) => a.estimado) ? ` ${composicaoEstimada()}` : ''}</p>}
    </section>
  );
}

function ComposicaoLinha({ a, geral }: { a: ComposicaoAgente; geral: boolean }) {
  useT(); // troca de idioma redesenha os textos de lib/custo.ts
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
  const t = useT();
  const [busy, setBusy] = useState(false);
  const numbers = [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32, ...(typeof limit.choice === 'number' ? [limit.choice] : [])])].sort((a, b) => a - b);
  const save = async (v: string) => {
    setBusy(true);
    try { await api.put('/api/runs/limit', { choice: v === 'auto' || v === 'ilimitado' ? v : Number(v) }); onSaved(); }
    catch (x) { onError(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <div className="field field--limit">
      <label htmlFor="proc-limit">{t('configuracoes.limite.rotulo')}</label>
      <select id="proc-limit" value={String(limit.choice)} disabled={busy} onChange={(e) => void save(e.target.value)} aria-describedby="proc-limit-hint">
        <option value="auto">{t('configuracoes.limite.auto', { maquina: limit.machine })}</option>
        {numbers.map((n) => <option key={n} value={n}>{n === 5 ? t('configuracoes.limite.opcaoPadrao', { n }) : t('configuracoes.limite.opcao', { n })}</option>)}
        <option value="ilimitado">{t('configuracoes.limite.semLimite')}</option>
      </select>
      <small id="proc-limit-hint" className="muted">
        {t('configuracoes.limite.ajuda', { memoria: fmtNumero(limit.memoryGb), nucleos: limit.cpus })}
        {limit.cap !== null ? ` ${t('configuracoes.limite.plano', { teto: limit.cap })}` : ''}
      </small>
    </div>
  );
}
