import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';

// Atividade ----------------------------------------------------------------------------------------
const diaIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diasAtras = (n: number) => diaIso(new Date(Date.now() - n * 86_400_000));
/** Baixa o relatório do período em Markdown: guardar, ou entregar a quem vai investigar um problema. */
function ExportarRelatorio() {
  const [aberto, setAberto] = useState(false);
  const [de, setDe] = useState(() => diasAtras(6));
  const [ate, setAte] = useState(() => diaIso(new Date()));
  // o texto das conversas só vai se a pessoa marcar (o arquivo costuma ser entregue a outra pessoa)
  const [conteudo, setConteudo] = useState(false);
  if (!aberto) return <p><button className="btn btn--ghost" onClick={() => setAberto(true)}>Exportar relatório (.md)</button></p>;
  // datas trocadas: vale o período que a pessoa quis dizer
  const [a, b] = de <= ate ? [de, ate] : [ate, de];
  const url = `/api/activity/report?de=${a}&ate=${b}&conteudo=${conteudo ? 1 : 0}`;
  const longo = (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1 > 90;
  const preset = (n: number, label: string) => <button className="btn btn--sm btn--ghost" aria-pressed={de === diasAtras(n) && ate === diaIso(new Date())} onClick={() => { setDe(diasAtras(n)); setAte(diaIso(new Date())); }}>{label}</button>;
  return (
    <div className="relatorio">
      <p><b>Exportar relatório</b></p>
      <p className="muted small">{conteudo
        ? 'Execuções, ferramentas usadas, erros, conexões, ações registradas e o texto das suas conversas e dos cards do período, num arquivo Markdown. As senhas e os acessos guardados das contas nunca entram.'
        : 'Execuções, ferramentas usadas, erros, conexões e ações registradas do período, num arquivo Markdown: quem fez, quando e como terminou, sem o texto das conversas, dos cards e das ações nas contas. As senhas e os acessos guardados das contas nunca entram.'}</p>
      <div className="relatorio__linha">
        {preset(0, 'Hoje')} {preset(6, '7 dias')} {preset(29, '30 dias')}
        <label>De <input type="date" value={de} max={diaIso(new Date())} onChange={(e) => e.target.value && setDe(e.target.value)} /></label>
        <label>Até <input type="date" value={ate} max={diaIso(new Date())} onChange={(e) => e.target.value && setAte(e.target.value)} /></label>
      </div>
      <p><label><input type="checkbox" checked={conteudo} onChange={(e) => setConteudo(e.target.checked)} /> Incluir o texto das conversas e dos cards</label></p>
      {conteudo && <p className="hint">O arquivo pode trazer e-mails, nomes e assuntos que apareceram nas conversas, e uma senha ou chave que você tenha colado numa delas. Revise o arquivo e veja com quem vai compartilhá-lo.</p>}
      {longo && <p className="hint">O relatório cobre até 90 dias: vão os 90 dias que terminam em {b.split('-').reverse().join('/')}.</p>}
      <p><a className="btn" href={url} download>Baixar relatório</a> <button className="btn btn--ghost" onClick={() => setAberto(false)}>Fechar</button></p>
    </div>
  );
}

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
      <ExportarRelatorio />
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
