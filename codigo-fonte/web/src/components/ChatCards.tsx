import { useState } from 'react';
import { useT, tn } from '../i18n/index.ts';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { openCard, openConversation } from '../lib/open.ts';
import type { Proposal, RequestPayload } from '../lib/types.ts';
import { Icon } from './Icon.tsx';

/* Cartões da conversa: pedidos dos cards, permissões, perguntas com opções e notas do sistema. */

/** Nota do sistema (bloco tracejado): até 3 linhas; o resto com "ver tudo" (antes, só cabiam 3 acionamentos). */
export function SystemNote({ text }: { text: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  if (lines.length <= 4) return <>{text}</>;
  return (
    <>
      {all ? text : lines.slice(0, 3).join('\n')}
      <button type="button" className="linkish msg__more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
        {all ? t('conversas.nota.verMenos') : t('conversas.nota.verTudo', { n: lines.length - 3 })}
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
  const t = useT();
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
  const open = <button type="button" className="linkish" onClick={() => openCard(r.taskId)}>{t('conversas.pedido.abrirCard', { numero: r.number })}</button>;
  // p.result: o que o servidor registrou ao responder
  if (p.status !== 'proposed') return <div className="req-card req-card--done"><span className="muted small">{t('conversas.pedido.respondidoComo', { numero: r.number, resultado: p.result ?? t('conversas.pedido.respondido') })}</span></div>;
  const enviar = () => { const v = text.trim(); if (v) void send(back ? 'return' : 'answer', v); };
  const round = r.round ?? 1;
  return (
    <div className="req-card" role="group" aria-label={t('conversas.pedido.aria', { numero: r.number })}>
      {r.excerpt && <details className="req-card__excerpt"><summary>{t('conversas.pedido.oQueVeio', { numero: r.number })}</summary><p className="pre">{r.excerpt}</p></details>}
      {r.need === 'info' || back ? (
        <form className="req-card__form" onSubmit={(e) => { e.preventDefault(); enviar(); }}>
          <textarea autoFocus value={text} rows={2} onChange={(e) => setText(e.target.value)}
            placeholder={back ? (r.review ? t('conversas.pedido.ajustarCampo') : t('conversas.pedido.mudarCampo')) : t('conversas.pedido.respostaPara', { nome: r.agent })} aria-label={back ? t('conversas.pedido.instrucao') : t('conversas.pedido.suaResposta')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); } }} />
          <div className="row row--wrap">
            <button className="btn btn--sm btn--primary" disabled={busy || !text.trim()}>{back ? (r.review ? t('conversas.pedido.pedirAjustes') : t('conversas.pedido.devolver')) : t('conversas.pedido.responder')}</button>
            {r.need === 'info' && !back && <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void send('return', t('conversas.pedido.seguirSemTexto'))}>{t('conversas.pedido.seguirSem')}</button>}
            {back && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setBack(false)}>{t('conversas.pedido.cancelar')}</button>}
            <span className="grow" />{open}
          </div>
        </form>
      ) : (
        <div className="row row--wrap">
          {r.review && <span className="req-card__what">{tn('conversas.pedido.entrega', { titulo: <b>{round > 1 ? t('conversas.pedido.entregaDoCardVersao', { numero: r.number, versao: round }) : t('conversas.pedido.entregaDoCard', { numero: r.number })}</b> })}</span>}
          {(r.need === 'approval' || r.need === 'review') && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void send('approve')}>{r.need === 'review' ? t('conversas.pedido.aprovarAssim') : t('conversas.pedido.aprovar')}</button>}
          {r.need === 'retry' && <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void send('retry')}>{t('conversas.pedido.tentarDeNovo')}</button>}
          {r.need !== 'retry' && <button className="btn btn--sm" disabled={busy} onClick={() => setBack(true)}>{r.review ? t('conversas.pedido.pedirAjustes') : t('conversas.pedido.devolverComInstrucao')}</button>}
          {r.need === 'retry' && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => void send('dismiss')}>{t('conversas.pedido.deixar')}</button>}
          <span className="grow" />{open}
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/** Pedido de permissão de um agente (ferramenta que executa código): autoriza ali mesmo, com a senha; depois ele continua sozinho. */
export function PermissionCard({ p, onDone, onReject }: { p: Proposal; onDone: () => void; onReject: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="perm-card" onSubmit={async (e) => {
      e.preventDefault(); setErr(null); setBusy(true);
      try { await api.post(`/api/proposals/${p.id}/authorize`, { password }); setPassword(''); onDone(); }
      catch (x) {
        setErr(x instanceof ApiError && x.code === 'invalid_login' ? t('conversas.permissao.senhaErrada') : errMsg(x));
      } finally { setBusy(false); }
    }}>
      <div className="perm-card__head"><Icon name="lock" size={16} /> <b>{t('conversas.permissao.titulo')}</b></div>
      <p className="perm-card__what">{p.summary}</p>
      <p className="hint warn">{t('conversas.permissao.aviso')}</p>
      <div className="row row--wrap">
        <input type="password" autoComplete="current-password" autoFocus required placeholder={t('conversas.permissao.senha')} aria-label={t('conversas.permissao.senha')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn--sm btn--primary" disabled={busy || !password}>{busy ? t('conversas.permissao.conferindo') : t('conversas.permissao.autorizar')}</button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={onReject}>{t('conversas.permissao.recusar')}</button>
      </div>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

/** Pedido de ligar uma ferramenta protegida passado à coordenação: o caminho até a conversa onde a senha é pedida. */
export function HandoffCard({ p }: { p: Proposal }) {
  const t = useT();
  const d = (() => { try { return JSON.parse(p.payload ?? '{}') as { coordinatorId?: string; coordinator?: string; conversationId?: string }; } catch { return {}; } })();
  return (
    <div className="perm-card perm-card--handoff">
      <div className="perm-card__head"><Icon name="lock" size={16} /> <b>{d.coordinator ? t('conversas.repasse.para', { nome: d.coordinator }) : t('conversas.repasse.coordenacao')}</b></div>
      <p className="perm-card__what">{p.summary}</p>
      {d.coordinatorId && d.conversationId && (
        <div className="row"><button className="btn btn--sm btn--primary" onClick={() => openConversation(d.coordinatorId, d.conversationId)}><Icon name="chat" size={14} /> {t('conversas.repasse.abrir')}</button></div>
      )}
    </div>
  );
}

/**
 * Pergunta com opções que o agente faz (ex.: no preparo de uma rotina): um clique responde; "outra resposta" deixa
 * escrever. Respondidas todas as da rodada, elas vão juntas para o agente continuar.
 */
export function QuestionCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const t = useT();
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
        {!showOther && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setShowOther(true)}>{t('conversas.pergunta.outra')}</button>}
      </div>
      {showOther && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void answer(other); }}>
          <input value={other} maxLength={300} onChange={(e) => setOther(e.target.value)} placeholder={t('conversas.pergunta.campo')} aria-label={t('conversas.pergunta.outra')} autoFocus />
          <button className="btn btn--sm btn--primary" disabled={busy || !other.trim()}>{t('conversas.pergunta.responder')}</button>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
