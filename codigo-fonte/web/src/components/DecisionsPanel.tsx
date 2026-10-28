import { useRef, useState, type ReactNode } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { PROPOSAL_KIND, type Decisions, type View } from '../lib/types.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';

type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null) => void;

/** O recado da coordenação (tom de colega) separado da ficha técnica da rotina. */
const split = (s: string): [string, string] => {
  const i = s.search(/\n?(?:Rotina (?:nova|.+\(da biblioteca\))|Ajustar a rotina)/);
  return i > 0 ? [s.slice(0, i).trim(), s.slice(i).trim()] : ['', s];
};

const KIND = PROPOSAL_KIND;
const NEED_LABEL = { info: 'pede uma informação', approval: 'pede a sua aprovação', review: 'não passou na conferência', retry: 'falhou' } as const;

/** Um item: o que é (clicável: abre o card ou a conversa) e, ao lado, as decisões ali mesmo. */
function Item({ badge, onOpen, openLabel, children, actions }: { badge: string; onOpen?: () => void; openLabel?: string; children: ReactNode; actions: ReactNode }) {
  return (
    <article className="dec-card">
      <div className="dec-card__top">
        <span className="badge">{badge}</span>
        {onOpen && <button type="button" className="dec-card__open" onClick={onOpen} title={openLabel} aria-label={openLabel}><Icon name="chevron-right" size={14} /></button>}
      </div>
      {onOpen ? <button type="button" className="dec-card__txt dec-card__link" onClick={onOpen}>{children}</button> : <div className="dec-card__txt">{children}</div>}
      <div className="row row--wrap dec-card__acts">{actions}</div>
    </article>
  );
}

/**
 * "Aguardando você": as aprovações e os pedidos dentro da plataforma, num lugar só — cards que pedem uma informação ou
 * a sua aprovação, propostas da equipe (inclusive apagar um card), sugestões de rotina, perguntas, permissões, vínculos
 * e regras. Cada item tem Aprovar e Recusar (ou Responder) ali mesmo; clicar no item abre o card (ou a conversa) por
 * cima da tela, sem trocar de área. Antes, os cards que esperavam você nem entravam na conta.
 */
/** inline: dentro de outra tela (modo foco), sem gaveta nem botão de fechar */
export function DecisionsPanel({ onClose, inline }: { onClose?: () => void; onOpenAgent?: OpenAgent; onGo?: (v: View) => void; inline?: boolean }) {
  const d = useResource<Decisions>('/api/decisions', ['proposals.changed', 'runs.changed', 'rules.changed', 'tasks.changed']);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({}); // resposta ou instrução de cada card
  const [returning, setReturning] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: () => onClose?.(), outside: true, active: !inline });
  const act = async (id: string, fn: () => Promise<{ result?: string; status?: string } | unknown>) => {
    setBusy(id); setErr(null); setDone(null);
    try { const r = (await fn()) as { result?: string; status?: string } | undefined; if (r?.result) setDone(r.status === 'failed' ? null : r.result); if (r?.status === 'failed') setErr(r.result ?? 'falhou'); d.reload(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };
  const respond = (taskId: string, action: 'answer' | 'approve' | 'return', note?: string) =>
    act(taskId, async () => { const r = await api.post<{ result: string }>(`/api/tasks/${taskId}/respond`, note ? { action, text: note } : { action }); setText((x) => ({ ...x, [taskId]: '' })); setReturning(null); return r; });
  const proposal = (id: string, decision: 'apply' | 'reject') => act(id, () => api.post(`/api/proposals/${id}`, { decision }));
  const x = d.data;
  const routines = x?.proposals.filter((p) => p.kind === 'routine' || p.kind === 'routine_edit') ?? [];
  const team = x?.proposals.filter((p) => p.kind !== 'routine' && p.kind !== 'routine_edit') ?? [];
  const empty = x && !x.total;
  const conv = (p: { agent_id: string | null; conversation_id: string | null }) => (p.agent_id && p.conversation_id ? () => openConversation(p.agent_id, p.conversation_id) : undefined);
  return (
    <aside ref={ref} className={inline ? 'dec-inline' : 'drawer dec-panel'} role={inline ? undefined : 'dialog'} aria-labelledby={inline ? undefined : 'dec-title'} aria-label={inline ? 'Aguardando você' : undefined}>
      {!inline && <div className="drawer__head"><h3 className="drawer__title" id="dec-title">Aguardando você</h3><button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button></div>}
      {!x ? <Loading error={d.error} /> : (
        <>
          {err && <p className="error" role="alert">{err}</p>}
          {done && <p className="ok" role="status">{done}</p>}
          {empty && <p className="muted">Nada esperando você agora.</p>}

          {x.cards.length > 0 && <h4 className="rt-sub">Cards esperando você</h4>}
          {x.cards.map((c) => {
            const v = text[c.id] ?? '';
            return (
              <Item key={c.id} badge={`#${c.number} · ${NEED_LABEL[c.need]}`} onOpen={() => openCard(c.id)} openLabel={`Abrir o card #${c.number}`}
                actions={c.need === 'info' ? (
                  <form className="dec-answer" onSubmit={(e) => { e.preventDefault(); if (v.trim()) void respond(c.id, 'answer', v.trim()); }}>
                    <input value={v} maxLength={1500} onChange={(e) => setText((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="Sua resposta" aria-label={`Resposta para o card #${c.number}`} />
                    <button className="btn btn--sm btn--primary" disabled={busy === c.id || !v.trim()}>Responder</button>
                    <button type="button" className="btn btn--sm" disabled={busy === c.id} title="O agente segue sem essa informação"
                      onClick={() => void respond(c.id, 'return', 'Siga sem essa informação, com o que você já tem.')}>Recusar</button>
                  </form>
                ) : returning === c.id ? (
                  <form className="dec-answer" onSubmit={(e) => { e.preventDefault(); if (v.trim().length >= 3) void respond(c.id, 'return', v.trim()); }}>
                    <input autoFocus value={v} maxLength={1500} onChange={(e) => setText((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="O que precisa mudar" aria-label={`Instrução para o card #${c.number}`} />
                    <button className="btn btn--sm" disabled={busy === c.id || v.trim().length < 3}>Devolver</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setReturning(null)}>Cancelar</button>
                  </form>
                ) : (<>
                  <button className="btn btn--sm btn--primary" disabled={busy === c.id} onClick={() => void respond(c.id, 'approve')}>{c.external ? 'Confirmar' : 'Aprovar'}</button>
                  <button className="btn btn--sm" disabled={busy === c.id} onClick={() => setReturning(c.id)} title="Devolver ao agente com uma instrução">Recusar</button>
                </>)}>
                <b>{c.title}</b>
                <span className="muted small"> · {c.agent_name ?? 'a equipe'}</span>
                {c.need === 'info' && <span className="dec-card__q">{c.question ?? c.justification}</span>}
                {c.need === 'review' && c.justification && <span className="dec-card__q muted">{c.justification}</span>}
              </Item>
            );
          })}

          {routines.length > 0 && <h4 className="rt-sub">Rotinas</h4>}
          {routines.map((p) => (
            <article key={p.id} className="dec-card dec-card--routine">
              <span className="badge">{KIND[p.kind]}{p.purpose === 'routine-recommend' ? ' · recomendação' : ''}</span>
              {split(p.summary)[0] && <p className="dec-card__pitch">{split(p.summary)[0]}</p>}
              <p className="dec-card__txt dec-card__spec">{split(p.summary)[1]}</p>
              <div className="row row--wrap">
                <button className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => void proposal(p.id, 'apply')}>{p.kind === 'routine' ? 'Ativar' : 'Aprovar'}</button>
                <button className="btn btn--sm" disabled={!!busy} onClick={() => void proposal(p.id, 'reject')}>Recusar</button>
                {conv(p) && <button className="btn btn--sm btn--ghost" onClick={conv(p)}>Conversar sobre ela</button>}
              </div>
            </article>
          ))}

          {team.length > 0 && <h4 className="rt-sub">Propostas e pedidos da equipe</h4>}
          {team.map((p) => (
            <Item key={p.id} badge={`${KIND[p.kind] ?? p.kind}${p.agent_name ? ` · ${p.agent_name}` : ''}`} onOpen={conv(p)} openLabel="Abrir a conversa"
              actions={p.kind === 'question'
                ? conv(p) && <button className="btn btn--sm btn--primary" onClick={conv(p)}><Icon name="chat" size={13} /> Responder</button>
                : p.kind === 'permission'
                ? conv(p) && <button className="btn btn--sm btn--primary" onClick={conv(p)}><Icon name="key" size={13} /> Autorizar na conversa</button>
                : <>
                  <button className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => void proposal(p.id, 'apply')}>Aprovar</button>
                  <button className="btn btn--sm" disabled={!!busy} onClick={() => void proposal(p.id, 'reject')}>Recusar</button>
                </>}>
              {p.summary}
            </Item>
          ))}

          {x.waiting.length > 0 && <h4 className="rt-sub">Esperando a sua resposta</h4>}
          {x.waiting.map((w) => (
            <Item key={w.id} badge="pergunta" onOpen={() => openConversation(w.agent_id, w.conversation_id)} openLabel="Abrir a conversa"
              actions={<button className="btn btn--sm btn--primary" onClick={() => openConversation(w.agent_id, w.conversation_id)}>Responder</button>}>
              {w.agent_name} fez uma pergunta e está esperando.
            </Item>
          ))}

          {(x.linkList.length > 0 || x.ruleList.length > 0) && <h4 className="rt-sub">Para conferir</h4>}
          {x.linkList.map((l) => (
            <Item key={l.id} badge="vínculo" onOpen={() => openCard(l.task_id)} openLabel={`Abrir o card #${l.number}`}
              actions={<>
                <button className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => void act(l.id, () => api.post(`/api/link-proposals/${l.id}`, { decision: 'confirmed' }))}>Aprovar</button>
                <button className="btn btn--sm" disabled={!!busy} onClick={() => void act(l.id, () => api.post(`/api/link-proposals/${l.id}`, { decision: 'rejected' }))}>Recusar</button>
              </>}>
              #{l.number} “{l.title}” parece o mesmo que #{l.related_number} “{l.related_title}”. <span className="muted small">{l.reason}</span>
            </Item>
          ))}
          {x.ruleList.map((r) => (
            <Item key={r.id} badge="regra"
              actions={<>
                <button className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => void act(r.id, () => api.post(`/api/rules/${r.id}`, { decision: 'active' }))}>Aprovar</button>
                <button className="btn btn--sm" disabled={!!busy} onClick={() => void act(r.id, () => api.post(`/api/rules/${r.id}`, { decision: 'rejected' }))}>Recusar</button>
              </>}>
              {r.text}
            </Item>
          ))}
          {x.refusedRoutines.length > 0 && (
            <details className="dec-refused">
              <summary>Sugestões de rotina recusadas ({x.refusedRoutines.length})</summary>
              <p className="hint">Ficam guardadas: não voltam sozinhas. Se mudou de ideia, traga de volta sem refazer a análise.</p>
              {x.refusedRoutines.map((r) => (
                <div key={r.id} className="dec-card dec-card--muted">
                  <p className="dec-card__txt">{r.summary}</p>
                  <button className="btn btn--sm" disabled={!!busy} onClick={() => void act(r.id, () => api.post(`/api/proposals/${r.id}/reconsider`))}>Reconsiderar</button>
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </aside>
  );
}
