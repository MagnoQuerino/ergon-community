import { useState } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { openCard, openConversation } from '../lib/open.ts';
import type { Proposal, RequestPayload } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/* Cartões da conversa: pedidos dos cards, permissões, perguntas com opções e notas do sistema. */

/** Nota do sistema (bloco tracejado): até 3 linhas; o resto com "ver tudo" (antes, só cabiam 3 acionamentos). */
export function SystemNote({ text }: { text: string }) {
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
export function RequestCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
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
          <textarea autoFocus value={text} rows={2} onChange={(e) => setText(e.target.value)}
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

/** Pedido de permissão de um agente (ferramenta que executa código): autoriza ali mesmo, com a senha; depois ele continua sozinho. */
export function PermissionCard({ p, onDone, onReject }: { p: Proposal; onDone: () => void; onReject: () => void }) {
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
export function HandoffCard({ p }: { p: Proposal }) {
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
export function QuestionCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
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

