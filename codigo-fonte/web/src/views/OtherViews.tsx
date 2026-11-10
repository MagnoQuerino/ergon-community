import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { cardClick, cardKey } from '../lib/cardClick.ts';
import { destinoDaExecucao, destinoDoEvento, destinoDoRegistro, rotuloDaLinha, rotuloDoDestino, type Destino } from '../lib/atividade.ts';
import { fmtData, fmtMoeda, tn, useT } from '../i18n/index.ts';

// Atividade ----------------------------------------------------------------------------------------
const diaIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const diasAtras = (n: number) => diaIso(new Date(Date.now() - n * 86_400_000));
/** Baixa o relatório do período em Markdown: guardar, ou entregar a quem vai investigar um problema. */
function ExportarRelatorio() {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [de, setDe] = useState(() => diasAtras(6));
  const [ate, setAte] = useState(() => diaIso(new Date()));
  // o texto das conversas só vai se a pessoa marcar (o arquivo costuma ser entregue a outra pessoa)
  const [conteudo, setConteudo] = useState(false);
  if (!aberto) return <p><button className="btn btn--ghost" onClick={() => setAberto(true)}>{t('servidor.atividade.exportar')}</button></p>;
  // datas trocadas: vale o período que a pessoa quis dizer
  const [a, b] = de <= ate ? [de, ate] : [ate, de];
  const url = `/api/activity/report?de=${a}&ate=${b}&conteudo=${conteudo ? 1 : 0}`;
  const longo = (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1 > 90;
  const preset = (n: number, label: string) => <button className="btn btn--sm btn--ghost" aria-pressed={de === diasAtras(n) && ate === diaIso(new Date())} onClick={() => { setDe(diasAtras(n)); setAte(diaIso(new Date())); }}>{label}</button>;
  // o último dia do período, no formato de data do idioma (o dia exato, sem fuso: meio-dia local)
  const fim = fmtData(new Date(`${b}T12:00:00`));
  return (
    <div className="relatorio">
      <p><b>{t('servidor.atividade.exportarTitulo')}</b></p>
      <p className="muted small">{conteudo ? t('servidor.atividade.comConteudo') : t('servidor.atividade.semConteudo')}</p>
      <div className="relatorio__linha">
        {preset(0, t('servidor.atividade.hoje'))} {preset(6, t('servidor.atividade.dias7'))} {preset(29, t('servidor.atividade.dias30'))}
        <label>{t('servidor.atividade.de')} <input type="date" value={de} max={diaIso(new Date())} onChange={(e) => e.target.value && setDe(e.target.value)} /></label>
        <label>{t('servidor.atividade.ate')} <input type="date" value={ate} max={diaIso(new Date())} onChange={(e) => e.target.value && setAte(e.target.value)} /></label>
      </div>
      <p><label><input type="checkbox" checked={conteudo} onChange={(e) => setConteudo(e.target.checked)} /> {t('servidor.atividade.incluirTexto')}</label></p>
      {conteudo && <p className="hint">{t('servidor.atividade.avisoConteudo')}</p>}
      {longo && <p className="hint">{t('servidor.atividade.ate90', { data: fim })}</p>}
      <p><a className="btn" href={url} download>{t('servidor.atividade.baixar')}</a> <button className="btn btn--ghost" onClick={() => setAberto(false)}>{t('servidor.atividade.fechar')}</button></p>
    </div>
  );
}

type Tab = 'log' | 'eventos' | 'execucoes' | 'saida';
const TABS: Tab[] = ['log', 'eventos', 'execucoes', 'saida'];
export function AtividadeView({ onOpenAgent }: { onOpenAgent: (id: string, tab: 'atividade') => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(() => TABS.find((x) => location.hash.includes(`?${x}`)) ?? 'log');
  // os arquivos saíram daqui: o endereço antigo ("#atividade?arquivos") abre Documentos › Entregas; as regras também
  // ("#atividade?regras" abre Conexões › Regras, o lugar único delas) — depois do ciclo, senão o App (que acerta o endereço
  // da área depois dos filhos) desfaz a troca
  useEffect(() => {
    const destino = location.hash.includes('?arquivos') ? '#documentos?pasta=entregas' : location.hash.includes('?regras') ? '#conexoes?regras' : null;
    if (!destino) return;
    const h = setTimeout(() => { location.hash = destino; }); return () => clearTimeout(h);
  }, []);
  const log = useResource<Array<{ id: string; actor_type: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; evidence: string | null; result: string; created_at: string }>>(tab === 'log' ? '/api/activity' : null, ['audit.created']);
  const events = useResource<Array<{ id: string; platform: string; mode: string; external_id: string; event_type: string; actor_display: string | null; received_at: string; is_fixture: number; text_excerpt: string | null; interpretation: string | null; status: string; task_id: string | null }>>(tab === 'eventos' ? '/api/source-events' : null, ['events.changed']);
  const runs = useResource<Array<{ id: string; agent_id: string; agent_name: string; kind: string; status: string; mode: string; error: string | null; conversation_id: string | null; task_id: string | null; created_at: string; finished_at: string | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null }>>(tab === 'execucoes' ? '/api/runs' : null, ['runs.changed']);
  const outbox = useResource<Array<{ id: string; platform: string; mode: string; body: string; status: string; created_at: string }>>(tab === 'saida' ? '/api/outbox' : null, ['events.changed']);
  const [err, setErr] = useState<string | null>(null);
  const quando = (s: string) => fmtData(s, { dateStyle: 'short', timeStyle: 'medium' });
  const cancel = async (id: string) => { try { await api.post(`/api/runs/${id}/cancel`); runs.reload(); } catch (e) { setErr(errMsg(e)); } };
  const num = (v: number | null) => (v === null ? t('servidor.atividade.naoInformado') : String(v));
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
  const ABA = { log: t('servidor.atividade.aba.log'), eventos: t('servidor.atividade.aba.eventos'), execucoes: t('servidor.atividade.aba.execucoes'), saida: t('servidor.atividade.aba.saida') };

  return (
    <div className="page">
      <header className="page__head"><h2>{t('servidor.atividade.titulo')}</h2><p className="muted">{t('servidor.atividade.subtitulo')}</p></header>
      <ExportarRelatorio />
      <div className="tabs" role="tablist">
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab--on' : ''}`} onClick={() => setTab(k)}>
            {ABA[k]}
          </button>
        ))}
      </div>
      <p className="muted small">{tn('servidor.atividade.regrasEm', { link: <a href="#conexoes?regras">{t('servidor.atividade.regrasLink')}</a> })}</p>
      {err && <p className="error">{err}</p>}
      {(tab === 'log' || tab === 'eventos' || tab === 'execucoes') && <p className="hint">{t('servidor.atividade.linhasAbrem')}</p>}
      {tab === 'log' && <div className="table-wrap"><table className="table"><thead><tr><th>{t('servidor.atividade.col.quando')}</th><th>{t('servidor.atividade.col.ator')}</th><th>{t('servidor.atividade.col.acao')}</th><th>{t('servidor.atividade.col.resultado')}</th><th>{t('servidor.atividade.col.evidencia')}</th></tr></thead>
        <tbody>{log.data?.map((e) => { const d = destinoDoRegistro(e); return <tr key={e.id} {...linha(d, `${e.action}, ${quando(e.created_at)}`)}><td>{quando(e.created_at)}{seta(d)}</td><td>{e.actor_type}</td><td>{e.action}</td><td>{e.result}</td>
          {/* a evidência é para ler e copiar (duplo clique numa palavra): clicar nela não leva para outra área */}
          <td className="pre small" data-card-skip>{e.evidence ?? ''}</td></tr>; })}</tbody></table></div>}
      {tab === 'eventos' && <div className="table-wrap"><table className="table"><thead><tr><th>{t('servidor.atividade.col.recebido')}</th><th>{t('servidor.atividade.col.canal')}</th><th>{t('servidor.atividade.col.tipo')}</th><th>{t('servidor.atividade.col.status')}</th><th>{t('servidor.atividade.col.trecho')}</th><th>{t('servidor.atividade.col.interpretacao')}</th><th>{t('servidor.atividade.col.tarefa')}</th></tr></thead>
        <tbody>{events.data?.map((e) => { const d = destinoDoEvento(e); return <tr key={e.id} {...linha(d, `${e.event_type}, ${quando(e.received_at)}`)}><td>{quando(e.received_at)}{seta(d)}</td><td>{e.platform} {e.is_fixture ? <span className="badge badge--warn">{t('servidor.atividade.exemplo')}</span> : null}</td>
          <td>{e.event_type}</td><td>{e.status}</td><td>{e.text_excerpt ?? <span className="muted">{t('servidor.atividade.naoArmazenado')}</span>}</td><td className="small">{e.interpretation ?? ''}</td><td>{e.task_id ? t('servidor.atividade.sim') : '—'}</td></tr>; })}</tbody></table></div>}
      {tab === 'execucoes' && <div className="table-wrap"><table className="table"><thead><tr><th>{t('servidor.atividade.col.criada')}</th><th>{t('servidor.atividade.col.agente')}</th><th>{t('servidor.atividade.col.tipo')}</th><th>{t('servidor.atividade.col.modo')}</th><th>{t('servidor.atividade.col.estado')}</th><th>{t('servidor.atividade.col.uso')}</th><th>{t('servidor.atividade.col.custo')}</th><th>{t('servidor.atividade.col.erro')}</th><th /></tr></thead>
        <tbody>{runs.data?.map((r) => { const d = destinoDaExecucao(r); return <tr key={r.id} {...linha(d, `${r.agent_name}, ${quando(r.created_at)}`)}><td>{quando(r.created_at)}{seta(d)}</td><td>{r.agent_name}</td><td>{r.kind}</td>
          <td>{r.mode === 'simulated' ? <span className="badge badge--warn">{t('servidor.atividade.semContaIa')}</span> : null}</td><td>{r.status}</td>
          <td>{num(r.tokens_in)} / {num(r.tokens_out)}</td><td>{r.cost_usd === null ? t('servidor.atividade.naoInformado') : fmtMoeda(r.cost_usd, 'USD', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td><td className="small" data-card-skip>{r.error ?? ''}</td>
          <td>{['queued', 'running', 'waiting_user'].includes(r.status) && <button className="btn btn--sm btn--ghost" title={t('servidor.atividade.cancelarDica')} onClick={() => cancel(r.id)}>{t('servidor.atividade.cancelar')}</button>}</td></tr>; })}</tbody></table></div>}
      {tab === 'saida' && <div className="table-wrap"><table className="table"><thead><tr><th>{t('servidor.atividade.col.criada')}</th><th>{t('servidor.atividade.col.canal')}</th><th>{t('servidor.atividade.col.estado')}</th><th>{t('servidor.atividade.col.texto')}</th></tr></thead>
        <tbody>{outbox.data?.map((o) => <tr key={o.id}><td>{quando(o.created_at)}</td><td>{o.platform} ({o.mode})</td><td>{o.status}</td><td className="pre">{o.body}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
