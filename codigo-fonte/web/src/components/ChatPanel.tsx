import { useEffect, useRef, useState } from 'react';
import { ApiError, api, errMsg, requestId } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { PROPOSAL_KIND, stripControl, type Agent, type AiStatus, type Conversation, type Message, type Proposal, type RequestPayload } from '../lib/types.ts';
import { ConfirmPopup } from './ConfirmPopup.tsx';
import { Icon } from './Icon.tsx';
import { AgentProfile } from './AgentProfile.tsx';

/** Nota do sistema (bloco tracejado): até 3 linhas; o resto com "ver tudo" (antes, só cabiam 3 acionamentos). */
function SystemNote({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  if (lines.length <= 4) return <>{text}</>;
  return (
    <>
      {all ? text : lines.slice(0, 3).join('\n')}
      <button type="button" className="linkish msg__more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
        {all ? 'ver menos' : `ver tudo (${lines.length - 3} mais)`}
      </button>
    </>
  );
}

/**
 * Pedido de um card repassado pelo agente da conversa: responder a uma pergunta, aprovar, devolver com instrução ou
 * tentar de novo, ali mesmo. A resposta vai para o card, que já volta a trabalhar; a mensagem do agente fica acima,
 * como dele (nunca como se fosse do usuário).
 */
function RequestCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const r = (() => { try { return JSON.parse(p.payload ?? '{}') as RequestPayload; } catch { return null; } })();
  const [text, setText] = useState('');
  const [back, setBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!r) return null;
  const send = async (action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss', note?: string) => {
    setBusy(true); setErr(null);
    try { await api.post(`/api/proposals/${p.id}/respond`, note ? { action, text: note } : { action }); setText(''); setBack(false); onDone(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const open = <button type="button" className="linkish" onClick={() => openCard(r.taskId)}>abrir o card #{r.number}</button>;
  if (p.status !== 'proposed') return <div className="req-card req-card--done"><span className="muted small">Card #{r.number}: {p.result ?? 'respondido'}</span></div>;
  return (
    <div className="req-card" role="group" aria-label={`Pedido do card #${r.number}`}>
      {r.excerpt && <details className="req-card__excerpt"><summary>O que veio no card #{r.number}</summary><p className="pre">{r.excerpt}</p></details>}
      {r.need === 'info' || back ? (
        <form className="req-card__form" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t) void send(back ? 'return' : 'answer', t); }}>
          <textarea autoFocus value={text} rows={2} maxLength={1500} onChange={(e) => setText(e.target.value)}
            placeholder={back ? 'O que precisa mudar (vai para o agente)' : `Sua resposta para ${r.agent}`} aria-label={back ? 'Instrução' : 'Sua resposta'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = text.trim(); if (t) void send(back ? 'return' : 'answer', t); } }} />
          <div className="row row--wrap">
            <button className="btn btn--sm btn--primary" disabled={busy || !text.trim()}>{back ? 'Devolver' : 'Responder'}</button>
            {r.need === 'info' && !back && <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void send('return', 'Siga sem essa informação, com o que você já tem.')}>Seguir sem isso</button>}
            {back && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setBack(false)}>Cancelar</button>}
            <span className="grow" />{open}
          </div>
        </form>
      ) : (
        <div className="row row--wrap">
          {(r.need === 'approval' || r.need === 'review') && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void send('approve')}>{r.need === 'review' ? 'Aprovar assim mesmo' : 'Aprovar'}</button>}
          {r.need === 'retry' && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void send('retry')}>Tentar de novo</button>}
          {r.need !== 'retry' && <button className="btn btn--sm" disabled={busy} onClick={() => setBack(true)}>Devolver com instrução</button>}
          {r.need === 'retry' && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void send('dismiss')}>Deixar como está</button>}
          <span className="grow" />{open}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

const MODE_LABEL: Record<string, string> = { simulated: 'SIMULADO', real: 'modelo real', local: '' };

/** Texto do agente com as imagens que ele gerou ([imagem: art_…], guardadas em Arquivos pelo Ergon). */
function WithImages({ text }: { text: string }) {
  const parts = text.split(/\[imagem: (art_[a-f0-9]{32})\]/);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((p, i) => i % 2 === 0 ? p : (
    <a key={i} className="msg__img" href={`/api/artifacts/${p}/download`} target="_blank" rel="noreferrer" title="Abrir a imagem (também em Arquivos)">
      <img src={`/api/artifacts/${p}/download`} alt="Imagem gerada pelo agente" loading="lazy" />
    </a>
  ))}</>;
}

/**
 * Pedido de permissão de um agente (ferramenta que executa código): autoriza ali mesmo, com a senha (o
 * autenticador é só no login). Depois o agente continua o pedido sozinho.
 */
function PermissionCard({ p, onDone, onReject }: { p: Proposal; onDone: () => void; onReject: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="perm-card" onSubmit={async (e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      try { await api.post(`/api/proposals/${p.id}/authorize`, { password }); setPassword(''); onDone(); }
      catch (x) {
        setErr(x instanceof ApiError && x.code === 'invalid_login' ? 'Senha incorreta.' : errMsg(x));
      } finally { setBusy(false); }
    }}>
      <div className="perm-card__head"><Icon name="lock" size={16} /> <b>Pedido de permissão</b></div>
      <p className="perm-card__what">{p.summary}</p>
      <p className="hint warn">Com isso, o agente executa programas e comandos no ambiente isolado do motor de IA: pode criar e apagar arquivos ali, instalar pacotes e acessar a internet. Autorize só se o pedido foi seu.</p>
      <div className="row row--wrap">
        <input type="password" autoComplete="current-password" autoFocus required placeholder="Sua senha" aria-label="Sua senha" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn--sm btn--primary" disabled={busy || !password}>{busy ? 'Conferindo…' : 'Autorizar'}</button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={onReject}>Recusar</button>
      </div>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

/** Pedido de ligar uma ferramenta protegida passado à coordenação: o caminho até a conversa onde a senha é pedida. */
function HandoffCard({ p }: { p: Proposal }) {
  const d = (() => { try { return JSON.parse(p.payload ?? '{}') as { coordinatorId?: string; coordinator?: string; conversationId?: string }; } catch { return {}; } })();
  return (
    <div className="perm-card perm-card--handoff">
      <div className="perm-card__head"><Icon name="lock" size={16} /> <b>Pedido passado {d.coordinator ? `a ${d.coordinator}` : 'à coordenação'}</b></div>
      <p className="perm-card__what">{p.summary}</p>
      {d.coordinatorId && d.conversationId && (
        <div className="row"><button className="btn btn--sm btn--primary" onClick={() => openConversation(d.coordinatorId, d.conversationId)}><Icon name="chat" size={14} /> Abrir a conversa e confirmar</button></div>
      )}
    </div>
  );
}

/**
 * Pergunta com opções que o agente faz (ex.: no preparo de uma rotina): um clique responde; "outra resposta" deixa
 * escrever. Respondidas todas as da rodada, elas vão juntas para o agente continuar.
 */
function QuestionCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const options = (() => { try { return (JSON.parse(p.payload ?? '{}') as { options?: string[] }).options ?? []; } catch { return []; } })();
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (a: string) => {
    if (!a.trim()) return;
    setBusy(true); setErr(null);
    try { await api.post(`/api/proposals/${p.id}/answer`, { answer: a.trim() }); onDone(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  if (p.status !== 'proposed') return (
    <div className="question-card question-card--done"><span className="question-card__q">{p.summary}</span><span className="badge badge--ok">{p.result}</span></div>
  );
  return (
    <div className="question-card" role="group" aria-label={p.summary}>
      <span className="question-card__q">{p.summary}</span>
      <div className="question-card__opts">
        {options.map((o) => <button key={o} className="btn btn--sm" disabled={busy} onClick={() => void answer(o)}>{o}</button>)}
        {!showOther && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setShowOther(true)}>Outra resposta</button>}
      </div>
      {showOther && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void answer(other); }}>
          <input value={other} maxLength={300} onChange={(e) => setOther(e.target.value)} placeholder="Escreva a sua resposta" aria-label="Outra resposta" autoFocus />
          <button className="btn btn--sm btn--primary" disabled={busy || !other.trim()}>Responder</button>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/** Rascunhos das conversas (por agente), só na memória da aba: nada de conteúdo da conversa em disco ou na URL. */
const DRAFTS = new Map<string, string>();

export function ChatPanel({ agent, onClose, compact, draft, embedded, conversationId }: { agent: Agent; onClose?: () => void; compact?: boolean; draft?: string | null; embedded?: boolean; conversationId?: string | null }) {
  const convs = useResource<Conversation[]>(`/api/conversations?agentId=${agent.id}`, ['messages.changed']);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  // rascunho por agente, na memória desta aba: fechar a janela ou trocar de agente não apaga o que você digitou
  const [text, setTextRaw] = useState(() => draft ?? DRAFTS.get(agent.id) ?? '');
  const setText = (v: string) => { setTextRaw(v); if (v) DRAFTS.set(agent.id, v); else DRAFTS.delete(agent.id); };
  useEffect(() => { if (draft) setText(draft); }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTextRaw(draft ?? DRAFTS.get(agent.id) ?? ''); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const msgs = useResource<Message[]>(convId ? `/api/conversations/${convId}/messages` : null, ['messages.changed', 'runs.changed']);
  // propostas da coordenação (mudar setor, criar agente, ferramentas): nada muda até você aplicar
  const props = useResource<Proposal[]>(convId ? `/api/proposals?conversationId=${convId}` : null, ['proposals.changed']);
  const decide = async (id: string, decision: 'apply' | 'reject') => {
    setErr(null);
    try { await api.post(`/api/proposals/${id}`, { decision }); props.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  // várias propostas de uma vez (um tema inteiro, por exemplo): aplicar ou recusar todas, na ordem em que vieram
  const batch = (props.data ?? []).filter((p) => p.status === 'proposed' && p.kind !== 'question' && p.kind !== 'permission' && p.kind !== 'info_request');
  const [batchBusy, setBatchBusy] = useState(false);
  const decideAll = async (decision: 'apply' | 'reject') => {
    setBatchBusy(true); setErr(null);
    const failed: string[] = [];
    for (const p of [...batch].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      try { await api.post(`/api/proposals/${p.id}`, { decision }); } catch (e) { failed.push(`${p.summary.slice(0, 60)} (${errMsg(e)})`); }
    }
    setBatchBusy(false); props.reload();
    if (failed.length) setErr(`${failed.length === 1 ? 'Uma não foi aplicada' : `${failed.length} não foram aplicadas`}: ${failed.join(' · ')}`);
  };
  const end = useRef<HTMLDivElement>(null);

  const picked = useRef(!!conversationId);
  useEffect(() => { setConvId(conversationId ?? null); setErr(null); picked.current = !!conversationId; }, [agent.id, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // abre na conversa comum mais recente; as das rotinas (entregas, recomendações) ficam na lista, sem tomar a frente.
  // Sem conversa comum ainda, começa uma nova ao enviar (nada cai na conversa de entrega de uma rotina).
  useEffect(() => {
    if (picked.current || convId || !convs.data) return;
    picked.current = true;
    const common = convs.data.find((c) => !c.purpose);
    if (common) setConvId(common.id);
  }, [convs.data, convId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.data?.length, props.data?.length]);
  // abrir a conversa (ou trocar de conversa) já deixa o cursor no campo: é só escrever
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 60); return () => window.clearTimeout(t); }, [convId, agent.id]);
  const [hint, setHint] = useState<string | null>(null);
  // sem nenhum provedor de IA conectado, os agentes não conversam: em toda tentativa, o aviso com "Conectar agora"
  const ai = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const semIa = !!ai.data && ai.data.executor === 'real' && !ai.data.accounts.some((x) => x.connected) && !(ai.data.byok ?? []).some((x) => x.connected) && !ai.data.default.model;
  const [avisoIa, setAvisoIa] = useState(false);

  const lastRun = [...(msgs.data ?? [])].reverse().find((m) => m.run_id);
  const busy = !!lastRun && ['queued', 'running', 'waiting_user'].includes(lastRun.run_status ?? '');
  const queuedCount = (msgs.data ?? []).filter((m) => m.queued).length;

  async function newConversation() {
    setErr(null);
    try {
      const c = await api.post<Conversation>('/api/conversations', { agentId: agent.id });
      setConvId(c.id);
      convs.reload();
    } catch (e) { setErr(errMsg(e)); }
  }

  /** Enter envia; com o agente ainda respondendo, Ctrl+Enter (ou o botão) põe a mensagem na fila da conversa. */
  async function send(queue = false) {
    const t = text.trim();
    // a anterior ainda indo: Ctrl+Enter já põe esta na fila (o servidor confere a conversa ocupada de uma vez só)
    if (!t || (sending && !queue)) return;
    if (semIa) { setAvisoIa(true); ai.reload(); return; }
    if (busy && !queue) { setHint(`${agent.name} ainda está respondendo: Ctrl+Enter põe a sua mensagem na fila.`); return; }
    setErr(null); setHint(null); setSending(true);
    // o campo limpa na hora: dá para escrever a próxima enquanto esta vai (antes, limpava depois e apagava o que você
    // tinha começado a digitar); se não for, o texto volta
    setText('');
    const restore = () => setTextRaw((cur) => { const v = cur ? cur : t; DRAFTS.set(agent.id, v); return v; });
    try {
      let id = convId;
      if (!id) { const c = await api.post<Conversation>('/api/conversations', { agentId: agent.id }); id = c.id; setConvId(id); }
      // mesmo identificador ao reenviar após falha de rede: o servidor não duplica
      if (!pending.current || pending.current.text !== t) pending.current = { id: requestId(), text: t };
      await api.post(`/api/conversations/${id}/messages`, { text: t, clientRequestId: pending.current.id, ...(queue ? { queue: true } : {}) });
      pending.current = null;
      msgs.reload();
      convs.reload();
    } catch (e) {
      restore();
      if (e instanceof ApiError && e.code === 'busy') setHint(`${agent.name} ainda está respondendo: Ctrl+Enter põe a sua mensagem na fila.`);
      else setErr(errMsg(e));
    } finally { setSending(false); input.current?.focus({ preventScroll: true }); }
  }

  async function cancel() {
    if (!lastRun?.run_id) return;
    try { await api.post(`/api/runs/${lastRun.run_id}/cancel`); msgs.reload(); } catch (e) { setErr(errMsg(e)); }
  }

  return (
    <section className={`chat ${compact ? 'chat--compact' : ''} ${embedded ? 'chat--embedded' : ''}`} aria-label={`Conversa com ${agent.name}`}>
      {!embedded && <header className="chat__head">
        <span className="avatar" style={{ background: agent.color }} aria-hidden="true">{agent.name[0]}</span>
        <div className="chat__who">
          <strong>{agent.name}</strong>
          <span>{agent.role} · {agent.sector_name}</span>
        </div>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Fechar conversa"><Icon name="x" /></button>}
      </header>}
      {agent.char_key && !embedded && (
        <details className="chat__profile">
          <summary>{agent.bio ? agent.bio.split(/(?<=[.!?])\s/)[0] : 'Perfil'} <span className="muted">perfil</span></summary>
          <AgentProfile agent={agent} />
        </details>
      )}
      <div className="chat__convs">
        <select value={convId ?? ''} onChange={(e) => setConvId(e.target.value || null)} aria-label="Conversa">
          {(!convs.data?.length || !convId) && <option value="">{convs.data?.length ? 'Nova conversa' : 'Nenhuma conversa'}</option>}
          {convs.data?.map((c) => <option key={c.id} value={c.id}>{c.title} · {new Date(c.last_at ?? c.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</option>)}
        </select>
        <button className="btn btn--ghost" onClick={newConversation}><Icon name="plus" size={14} /> Nova</button>
      </div>
      <div className="chat__msgs" role="log" aria-live="polite">
        {!msgs.data?.length && <p className="muted center">Escreva uma mensagem. Use <code>/tarefa título</code> para criar um card ou <code>/pendencias</code>.</p>}
        {/* mensagens e cartões (perguntas, propostas, permissões) na ordem em que aconteceram */}
        {[...(msgs.data ?? []).map((m) => ({ at: m.created_at, m, p: null as Proposal | null })), ...(props.data ?? []).map((p) => ({ at: p.created_at, m: null, p }))]
          .sort((a, b) => a.at.localeCompare(b.at)).map(({ m, p }) => m ? (
          <div key={m.id} className={`msg msg--${m.role} ${m.queued ? 'msg--queued' : ''}`}>
            {m.role === 'agent' && MODE_LABEL[m.mode] && <span className={`badge ${m.mode === 'simulated' ? 'badge--warn' : 'badge--ok'}`}>{MODE_LABEL[m.mode]}</span>}
            <div className="msg__body">{m.role === 'agent' ? <WithImages text={stripControl(m.content)} /> : m.role === 'system' ? <SystemNote text={m.content} /> : m.content}</div>
            <time>{m.queued ? 'na fila · vai quando terminar' : new Date(m.created_at).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}</time>
          </div>
        ) : !p ? null : p.kind === 'info_request' ? (
          <RequestCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} />
        ) : p.kind === 'question' ? (
          <QuestionCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} />
        ) : p.kind === 'handoff' ? (
          <HandoffCard key={p.id} p={p} />
        ) : p.kind === 'permission' && p.status === 'proposed' ? (
          <PermissionCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} onReject={() => decide(p.id, 'reject')} />
        ) : (
          <div key={p.id} className={`proposal-card proposal-card--${p.status}`}>
            <span className="badge">{PROPOSAL_KIND[p.kind] ?? p.kind}</span>
            <span className="proposal-card__txt">{p.summary}{p.result && p.status !== 'proposed' ? <span className="muted"> — {p.result}</span> : null}</span>
            {p.status === 'proposed' ? (
              <span className="row">
                <button className="btn btn--sm btn--primary" onClick={() => decide(p.id, 'apply')}>{p.kind === 'routine' ? 'Ativar rotina' : 'Aplicar'}</button>
                <button className="btn btn--sm btn--ghost" onClick={() => decide(p.id, 'reject')}>Recusar</button>
              </span>
            ) : <span className={`badge ${p.status === 'applied' ? 'badge--ok' : p.status === 'failed' ? 'badge--err' : ''}`}>{p.status === 'applied' ? (p.kind === 'permission' ? 'autorizada' : 'aplicada') : p.status === 'failed' ? 'falhou' : 'recusada'}</span>}
          </div>
        ))}
        {batch.length >= 2 && (
          <div className="proposal-batch" role="group" aria-label="Todas as propostas pendentes">
            <span>{batch.length} propostas esperando você nesta conversa</span>
            <button className="btn btn--sm btn--primary" disabled={batchBusy} onClick={() => void decideAll('apply')}>Aplicar todas</button>
            <button className="btn btn--sm btn--ghost" disabled={batchBusy} onClick={() => void decideAll('reject')}>Recusar todas</button>
          </div>
        )}
        {busy && (
          <div className="msg msg--system run-line">
            <span className="dot dot--pulse" /> {lastRun?.run_status === 'queued' ? 'Na fila (limite de execuções simultâneas)…' : lastRun?.run_status === 'waiting_user' ? 'Aguardando decisão humana' : 'Executando…'}
            <button className="btn btn--ghost btn--sm" onClick={cancel}><Icon name="stop" size={12} /> Cancelar</button>
          </div>
        )}
        <div ref={end} />
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {(hint || (busy && text.trim()) || queuedCount > 0) && (
        <p className="chat__hint" role="status">{hint ?? (queuedCount > 0 ? `${queuedCount} mensagem(ns) na fila: vão para ${agent.name} quando ele terminar.` : 'Ctrl+Enter põe a mensagem na fila da conversa.')}</p>
      )}
      {avisoIa && (
        <ConfirmPopup title="Conecte um provedor de IA" confirmLabel="Conectar agora"
          onConfirm={() => { setAvisoIa(false); location.hash = '#conexoes'; }} onCancel={() => setAvisoIa(false)}>
          <p>Você ainda não conectou um provedor de IA ao Ergon, então não é possível conversar com os agentes ainda. Leva um minuto: a sua mensagem fica guardada aqui.</p>
        </ConfirmPopup>
      )}
      <form className="chat__input" onSubmit={(e) => { e.preventDefault(); void send(busy); }}>
        <textarea ref={input} data-autofocus value={text} onChange={(e) => { setText(e.target.value); if (hint) setHint(null); }} maxLength={4000} rows={2} placeholder={`Peça algo a ${agent.name}…`}
          // Enter envia · Shift+Enter quebra a linha · Ctrl+Enter põe na fila da conversa (vai quando o agente terminar)
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); void send(true); return; }
            if (!e.shiftKey) { e.preventDefault(); void send(); }
          }} aria-label="Mensagem" aria-describedby={`chat-keys-${agent.id}`} />
        <span id={`chat-keys-${agent.id}`} hidden>Enter envia; Shift+Enter quebra a linha; Ctrl+Enter põe na fila da conversa.</span>
        <button className="btn btn--primary" type="submit" disabled={sending || !text.trim()} aria-label={busy ? 'Pôr na fila (Ctrl+Enter)' : 'Enviar (Enter)'} title={busy ? 'Pôr na fila (Ctrl+Enter)' : 'Enviar (Enter)'}>
          <Icon name={busy ? 'clock' : 'send'} />
        </button>
      </form>
    </section>
  );
}
