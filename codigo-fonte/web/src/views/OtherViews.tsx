import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';

// Atividade ----------------------------------------------------------------------------------------
type Tab = 'log' | 'eventos' | 'execucoes' | 'regras' | 'saida';
const TABS: Tab[] = ['log', 'eventos', 'execucoes', 'regras', 'saida'];
export function AtividadeView() {
  // "#atividade?regras" abre direto na aba (vindo de "Aguardando você")
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => location.hash.includes(`?${t}`)) ?? 'log');
  // os arquivos saíram daqui: o endereço antigo ("#atividade?arquivos") abre Documentos › Entregas — depois do ciclo,
  // senão o App (que acerta o endereço da área depois dos filhos) desfaz a troca
  useEffect(() => { if (!location.hash.includes('?arquivos')) return; const t = setTimeout(() => { location.hash = '#documentos?pasta=entregas'; }); return () => clearTimeout(t); }, []);
  const log = useResource<Array<{ id: string; actor_type: string; action: string; target_type: string | null; evidence: string | null; result: string; created_at: string }>>(tab === 'log' ? '/api/activity' : null, ['audit.created']);
  const events = useResource<Array<{ id: string; platform: string; mode: string; external_id: string; event_type: string; actor_display: string | null; received_at: string; is_fixture: number; text_excerpt: string | null; interpretation: string | null; status: string; task_id: string | null }>>(tab === 'eventos' ? '/api/source-events' : null, ['events.changed']);
  const runs = useResource<Array<{ id: string; agent_name: string; kind: string; status: string; mode: string; error: string | null; created_at: string; finished_at: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null }>>(tab === 'execucoes' ? '/api/runs' : null, ['runs.changed']);
  const rules = useResource<Array<{ id: string; text: string; status: string; created_at: string }>>(tab === 'regras' ? '/api/rules' : null, ['rules.changed']);
  const outbox = useResource<Array<{ id: string; platform: string; mode: string; body: string; status: string; created_at: string }>>(tab === 'saida' ? '/api/outbox' : null, ['events.changed']);
  const [err, setErr] = useState<string | null>(null);
  const t = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const decideRule = async (id: string, decision: string) => { try { await api.post(`/api/rules/${id}`, { decision }); rules.reload(); } catch (e) { setErr(errMsg(e)); } };
  const cancel = async (id: string) => { try { await api.post(`/api/runs/${id}/cancel`); runs.reload(); } catch (e) { setErr(errMsg(e)); } };
  const num = (v: number | null) => (v === null ? 'não informado' : String(v));

  return (
    <div className="page">
      <header className="page__head"><h2>Atividade</h2><p className="muted">Registro de ações, evidência mínima e resultado. Não contém raciocínio interno de modelos.</p></header>
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab--on' : ''}`} onClick={() => setTab(k)}>
            {{ log: 'Log', eventos: 'Eventos de origem', execucoes: 'Execuções', regras: 'Regras propostas', saida: 'Saída' }[k]}
          </button>
        ))}
      </div>
      {err && <p className="error">{err}</p>}
      {tab === 'log' && <div className="table-wrap"><table className="table"><thead><tr><th>Quando</th><th>Ator</th><th>Ação</th><th>Resultado</th><th>Evidência</th></tr></thead>
        <tbody>{log.data?.map((e) => <tr key={e.id}><td>{t(e.created_at)}</td><td>{e.actor_type}</td><td>{e.action}</td><td>{e.result}</td><td className="pre small">{e.evidence ?? ''}</td></tr>)}</tbody></table></div>}
      {tab === 'eventos' && <div className="table-wrap"><table className="table"><thead><tr><th>Recebido</th><th>Canal</th><th>Tipo</th><th>Status</th><th>Trecho</th><th>Interpretação</th><th>Tarefa</th></tr></thead>
        <tbody>{events.data?.map((e) => <tr key={e.id}><td>{t(e.received_at)}</td><td>{e.platform} {e.is_fixture ? <span className="badge badge--warn">simulação</span> : <span className="badge badge--ok">real</span>}</td>
          <td>{e.event_type}</td><td>{e.status}</td><td>{e.text_excerpt ?? <span className="muted">(não armazenado)</span>}</td><td className="small">{e.interpretation ?? ''}</td><td>{e.task_id ? 'sim' : '—'}</td></tr>)}</tbody></table></div>}
      {tab === 'execucoes' && <div className="table-wrap"><table className="table"><thead><tr><th>Criada</th><th>Agente</th><th>Tipo</th><th>Modo</th><th>Estado</th><th>Tokens (in/out)</th><th>Custo</th><th>Erro</th><th /></tr></thead>
        <tbody>{runs.data?.map((r) => <tr key={r.id}><td>{t(r.created_at)}</td><td>{r.agent_name}</td><td>{r.kind}</td>
          <td><span className={`badge ${r.mode === 'simulated' ? 'badge--warn' : 'badge--ok'}`}>{r.mode === 'simulated' ? 'simulado' : 'real'}</span></td><td>{r.status}</td>
          <td>{num(r.tokens_in)} / {num(r.tokens_out)}</td><td>{r.cost_usd === null ? 'não informado' : `US$ ${r.cost_usd.toFixed(4)}`}</td><td className="small">{r.error ?? ''}</td>
          <td>{['queued', 'running', 'waiting_user'].includes(r.status) && <button className="btn btn--sm btn--ghost" onClick={() => cancel(r.id)}>Cancelar</button>}</td></tr>)}</tbody></table></div>}
      {tab === 'regras' && <div className="table-wrap"><table className="table"><thead><tr><th>Proposta em</th><th>Regra</th><th>Estado</th><th /></tr></thead>
        <tbody>{rules.data?.map((r) => <tr key={r.id}><td>{t(r.created_at)}</td><td>{r.text}</td><td>{r.status}</td>
          <td>{r.status === 'proposed' && <><button className="btn btn--sm" onClick={() => decideRule(r.id, 'active')}>Ativar</button> <button className="btn btn--sm btn--ghost" onClick={() => decideRule(r.id, 'rejected')}>Rejeitar</button></>}</td></tr>)}
          {!rules.data?.length && <tr><td colSpan={4} className="muted">Nenhuma regra. Frases como “a partir de agora…” no chat geram propostas.</td></tr>}</tbody></table></div>}
      {tab === 'saida' && <div className="table-wrap"><table className="table"><thead><tr><th>Criada</th><th>Canal</th><th>Estado</th><th>Texto</th></tr></thead>
        <tbody>{outbox.data?.map((o) => <tr key={o.id}><td>{t(o.created_at)}</td><td>{o.platform} ({o.mode})</td><td>{o.status}</td><td className="pre">{o.body}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
