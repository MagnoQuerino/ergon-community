import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { cardClick, cardKey } from '../lib/cardClick.ts';
import { destinoDaExecucao, destinoDoEvento, destinoDoRegistro, rotuloDaLinha, rotuloDoDestino, type Destino } from '../lib/atividade.ts';

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

type Tab = 'log' | 'eventos' | 'execucoes' | 'saida';
const TABS: Tab[] = ['log', 'eventos', 'execucoes', 'saida'];
export function AtividadeView({ onOpenAgent }: { onOpenAgent: (id: string, tab: 'atividade') => void }) {
  const [tab, setTab] = useState<Tab>(() => TABS.find((t) => location.hash.includes(`?${t}`)) ?? 'log');
  // os arquivos saíram daqui: o endereço antigo ("#atividade?arquivos") abre Documentos › Entregas; as regras também
  // ("#atividade?regras" abre Conexões › Regras, o lugar único delas) — depois do ciclo, senão o App (que acerta o endereço
  // da área depois dos filhos) desfaz a troca
  useEffect(() => {
    const destino = location.hash.includes('?arquivos') ? '#documentos?pasta=entregas' : location.hash.includes('?regras') ? '#conexoes?regras' : null;
    if (!destino) return;
    const t = setTimeout(() => { location.hash = destino; }); return () => clearTimeout(t);
  }, []);
  const log = useResource<Array<{ id: string; actor_type: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; evidence: string | null; result: string; created_at: string }>>(tab === 'log' ? '/api/activity' : null, ['audit.created']);
  const events = useResource<Array<{ id: string; platform: string; mode: string; external_id: string; event_type: string; actor_display: string | null; received_at: string; is_fixture: number; text_excerpt: string | null; interpretation: string | null; status: string; task_id: string | null }>>(tab === 'eventos' ? '/api/source-events' : null, ['events.changed']);
  const runs = useResource<Array<{ id: string; agent_id: string; agent_name: string; kind: string; status: string; mode: string; error: string | null; conversation_id: string | null; task_id: string | null; created_at: string; finished_at: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null }>>(tab === 'execucoes' ? '/api/runs' : null, ['runs.changed']);
  const outbox = useResource<Array<{ id: string; platform: string; mode: string; body: string; status: string; created_at: string }>>(tab === 'saida' ? '/api/outbox' : null, ['events.changed']);
  const [err, setErr] = useState<string | null>(null);
  const t = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const cancel = async (id: string) => { try { await api.post(`/api/runs/${id}/cancel`); runs.reload(); } catch (e) { setErr(errMsg(e)); } };
  const num = (v: number | null) => (v === null ? 'não informado' : String(v));
  // cada linha abre o que aconteceu: o card, a conversa, o agente, a rotina, a conexão ou a aba com o detalhe
  const ir = async (d: Destino | null): Promise<void> => {
    if (!d) return;
    setErr(null);
    if (d.tipo === 'card') openCard(d.id);
    else if (d.tipo === 'conversa') openConversation(d.agentId, d.conversationId);
    else if (d.tipo === 'agente') onOpenAgent(d.id, 'atividade');
    else if (d.tipo === 'endereco') location.hash = d.href;
    else if (d.tipo === 'aba') setTab(d.aba);
    else {
      // a linha do registro só tem a execução: o card ou a conversa dela vêm do servidor
      try { const r = await api.get<{ task_id: string | null; conversation_id: string | null; agent_id: string | null }>(`/api/runs/${d.id}`); await ir(destinoDaExecucao(r)); } catch (e) { setErr(errMsg(e)); }
    }
  };
  // a linha diz o que abre também a quem usa leitor de tela (o title não é lido de forma confiável): "Abrir o card: …"
  const linha = (d: Destino | null, resumo: string) => (d ? { className: 'row-click', tabIndex: 0, title: rotuloDoDestino(d), 'aria-label': rotuloDaLinha(d, resumo), onClick: cardClick(() => void ir(d)), onKeyDown: cardKey(() => void ir(d)) } : {});
  // a seta marca as linhas que abrem algo (as outras ficam só para ler); não ocupa coluna nova
  const seta = (d: Destino | null) => (d ? <span className="act-open" aria-hidden="true"> ›</span> : null);

  return (
    <div className="page">
      <header className="page__head"><h2>Atividade</h2><p className="muted">Registro de ações, evidência mínima e resultado. Não contém raciocínio interno de modelos.</p></header>
      <ExportarRelatorio />
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab--on' : ''}`} onClick={() => setTab(k)}>
            {{ log: 'Log', eventos: 'Eventos de origem', execucoes: 'Execuções', saida: 'Saída' }[k]}
          </button>
        ))}
      </div>
      <p className="muted small">As regras (as propostas e as que valem) ficam em <a href="#conexoes?regras">Conexões › Regras</a>.</p>
      {err && <p className="error">{err}</p>}
      {(tab === 'log' || tab === 'eventos' || tab === 'execucoes') && <p className="hint">As linhas com › abrem o que aconteceu: o card, a conversa, o agente ou a conexão.</p>}
      {tab === 'log' && <div className="table-wrap"><table className="table"><thead><tr><th>Quando</th><th>Ator</th><th>Ação</th><th>Resultado</th><th>Evidência</th></tr></thead>
        <tbody>{log.data?.map((e) => { const d = destinoDoRegistro(e); return <tr key={e.id} {...linha(d, `${e.action}, ${t(e.created_at)}`)}><td>{t(e.created_at)}{seta(d)}</td><td>{e.actor_type}</td><td>{e.action}</td><td>{e.result}</td>
          {/* a evidência é para ler e copiar (duplo clique numa palavra): clicar nela não leva para outra área */}
          <td className="pre small" data-card-skip>{e.evidence ?? ''}</td></tr>; })}</tbody></table></div>}
      {tab === 'eventos' && <div className="table-wrap"><table className="table"><thead><tr><th>Recebido</th><th>Canal</th><th>Tipo</th><th>Status</th><th>Trecho</th><th>Interpretação</th><th>Tarefa</th></tr></thead>
        <tbody>{events.data?.map((e) => { const d = destinoDoEvento(e); return <tr key={e.id} {...linha(d, `${e.event_type}, ${t(e.received_at)}`)}><td>{t(e.received_at)}{seta(d)}</td><td>{e.platform} {e.is_fixture ? <span className="badge badge--warn">exemplo</span> : null}</td>
          <td>{e.event_type}</td><td>{e.status}</td><td>{e.text_excerpt ?? <span className="muted">(não armazenado)</span>}</td><td className="small">{e.interpretation ?? ''}</td><td>{e.task_id ? 'sim' : '—'}</td></tr>; })}</tbody></table></div>}
      {tab === 'execucoes' && <div className="table-wrap"><table className="table"><thead><tr><th>Criada</th><th>Agente</th><th>Tipo</th><th>Modo</th><th>Estado</th><th>Tokens (in/out)</th><th>Custo</th><th>Erro</th><th /></tr></thead>
        <tbody>{runs.data?.map((r) => { const d = destinoDaExecucao(r); return <tr key={r.id} {...linha(d, `${r.agent_name}, ${t(r.created_at)}`)}><td>{t(r.created_at)}{seta(d)}</td><td>{r.agent_name}</td><td>{r.kind}</td>
          <td>{r.mode === 'simulated' ? <span className="badge badge--warn">sem conta de IA</span> : null}</td><td>{r.status}</td>
          <td>{num(r.tokens_in)} / {num(r.tokens_out)}</td><td>{r.cost_usd === null ? 'não informado' : `US$ ${r.cost_usd.toFixed(4).replace('.', ',')}`}</td><td className="small" data-card-skip>{r.error ?? ''}</td>
          <td>{['queued', 'running', 'waiting_user'].includes(r.status) && <button className="btn btn--sm btn--ghost" title="Cancelar esta execução" onClick={() => cancel(r.id)}>Cancelar</button>}</td></tr>; })}</tbody></table></div>}
      {tab === 'saida' && <div className="table-wrap"><table className="table"><thead><tr><th>Criada</th><th>Canal</th><th>Estado</th><th>Texto</th></tr></thead>
        <tbody>{outbox.data?.map((o) => <tr key={o.id}><td>{t(o.created_at)}</td><td>{o.platform} ({o.mode})</td><td>{o.status}</td><td className="pre">{o.body}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
