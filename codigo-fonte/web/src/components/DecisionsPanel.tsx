import { useRef, useState, type ReactNode } from 'react';
import { ACAO, FILEIRA } from '../lib/cartoes-acoes.ts';
import { textoCurto, useEnvioPorItem } from '../lib/envio.ts';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openCard, openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { cardClick } from '../lib/cardClick.ts';
import { PROPOSAL_KIND, type Decisions, type View } from '../lib/types.ts';
import { useT } from '../i18n/index.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';
import { TextoLongo } from './TextoLongo.tsx';
import { BotoesPrazo, BotoesRegra, alcanceSugerido } from './CartaoRegra.tsx';
import { Selo } from './Selo.tsx';

type OpenAgent = (id: string, tab?: 'conversa' | 'perfil' | 'atividade', draft?: string | null, conversationId?: string | null) => void;

/** O recado da coordenação (tom de colega) separado da ficha técnica da rotina. */
const split = (s: string): [string, string] => {
  // i18n-ok: reconhece o começo da ficha que o servidor escreve
  const i = s.search(/\n?(?:Rotina (?:nova|.+\(da biblioteca\))|Ajustar a rotina)/);
  return i > 0 ? [s.slice(0, i).trim(), s.slice(i).trim()] : ['', s];
};

const KIND = PROPOSAL_KIND;
const NEED_ICON = { info: 'help', approval: 'check', review: 'eye', retry: 'repeat' } as const;
const NEED_LABEL = { info: 'servidor.decisoes.precisa.info', approval: 'servidor.decisoes.precisa.approval', review: 'servidor.decisoes.precisa.review', retry: 'servidor.decisoes.precisa.retry' } as const;

/** Um item: o que é (clicável: abre o card ou a conversa) e, ao lado, as decisões ali mesmo. */
function Item({ badge, icone = 'flag', onOpen, openLabel, children, actions, aviso }: { badge: string; icone?: string; onOpen?: () => void; openLabel?: string; children: ReactNode; actions: ReactNode; aviso?: string | null }) {
  return (
    // o item inteiro abre o card ou a conversa (antes, só o texto e a setinha); Aprovar e Recusar fazem só o deles
    <article className={`dec-card ${onOpen ? 'card-click' : ''}`} onClick={onOpen ? cardClick(onOpen) : undefined}>
      <div className="dec-card__top">
        <Selo icone={icone}>{badge}</Selo>
        {onOpen && <button type="button" className="dec-card__open" onClick={onOpen} title={openLabel} aria-label={openLabel}><Icon name="chevron-right" size={14} /></button>}
      </div>
      {onOpen ? <button type="button" className="dec-card__txt dec-card__link" onClick={onOpen}>{children}</button> : <div className="dec-card__txt">{children}</div>}
      {/* errar o Aprovar ou o Recusar por pouco (o vão entre eles) não tira a pessoa do painel */}
      <div className={`${FILEIRA} dec-card__acts`} data-card-skip>{actions}</div>
      {/* o campo só com espaços (ou curto demais) não some no clique: o aviso fica aqui, no próprio cartão */}
      {aviso && <p className="error small dec-card__aviso" role="alert" data-card-skip>{aviso}</p>}
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
  const t = useT();
  const d = useResource<Decisions>('/api/decisions', ['proposals.changed', 'runs.changed', 'rules.changed', 'tasks.changed']);
  // rc.28: a trava é por item — o botão fica ativo dizendo o que está indo (aria-busy), o segundo clique no MESMO item
  // não manda de novo, e o clique noutro cartão enquanto um vai é enviado de verdade (como na rc.27)
  const { vai, enviar } = useEnvioPorItem();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({}); // resposta ou instrução de cada card
  const [returning, setReturning] = useState<string | null>(null);
  // o aviso de um cartão (campo só com espaços, ou curto demais no Devolver): aparece nele, some quando a pessoa escreve
  const [aviso, setAviso] = useState<{ id: string; texto: string } | null>(null);
  const semAviso = (id: string) => setAviso((a) => (a?.id === id ? null : a));
  const ref = useRef<HTMLElement>(null);
  useSurface(ref, { onClose: () => onClose?.(), outside: true, active: !inline });
  // o recado depois do clique (r.result) chega no idioma da tela: o servidor manda result_t e lib/api.ts traduz
  // acao: o que está indo neste item ('approve', 'answer', 'return', 'apply', 'reject'…), para o botão certo dizer o dele
  const act = (id: string, acao: string, fn: () => Promise<{ result?: string; status?: string } | unknown>) => enviar(id, acao, async () => {
    setErr(null); setDone(null);
    try { const r = (await fn()) as { result?: string; status?: string } | undefined; if (r?.result) setDone(r.status === 'failed' ? null : r.result); if (r?.status === 'failed') setErr(r.result ?? t('servidor.decisoes.falhou')); d.reload(); }
    // já decidida noutro lugar (o cartão da conversa, outra aba): só relê, sem erro
    catch (e) { if (e instanceof ApiError && e.status === 409 && e.code === 'decided') d.reload(); else setErr(errMsg(e)); }
  });
  // a resposta do card (Responder, Aprovar, Devolver ou "seguir sem"): o botão dela, e só o dela, diz o que está indo
  // (o aviso do campo vazio sai ao enviar: "seguir sem" não fica com "Escreva a sua resposta." embaixo)
  const respond = (taskId: string, action: 'answer' | 'approve' | 'return', note?: string) => { semAviso(taskId); return act(taskId, action, async () => { const r = await api.post<{ result: string }>(`/api/tasks/${taskId}/respond`, note ? { action, text: note } : { action }); setText((x) => ({ ...x, [taskId]: '' })); setReturning((cur) => (cur === taskId ? null : cur)); return r; }); };
  // extra: o alcance (cartão de regra) ou o prazo (aprovação depois de ler) do botão escolhido; quem recusou lê "Recusando…"
  const proposal = (id: string, decision: 'apply' | 'reject', extra: { alcance?: string; prazo?: string } = {}) => act(id, decision, () => api.post(`/api/proposals/${id}`, { decision, ...extra }));
  const ocupadoDe = (id: string) => (vai(id, 'reject') ? 'recusar' as const : vai(id) ? 'aplicar' as const : false);
  const decidirItem = (id: string, decision: 'apply' | 'reject', fn: () => Promise<unknown>) => void act(id, decision, fn);
  const x = d.data;
  const routines = x?.proposals.filter((p) => p.kind === 'routine' || p.kind === 'routine_edit') ?? [];
  const team = x?.proposals.filter((p) => p.kind !== 'routine' && p.kind !== 'routine_edit') ?? [];
  const empty = x && !x.total;
  const conv = (p: { agent_id: string | null; conversation_id: string | null }) => (p.agent_id && p.conversation_id ? () => openConversation(p.agent_id, p.conversation_id) : undefined);
  return (
    <aside ref={ref} className={inline ? 'dec-inline' : 'drawer dec-panel'} role={inline ? undefined : 'dialog'} aria-labelledby={inline ? undefined : 'dec-title'} aria-label={inline ? t('servidor.decisoes.titulo') : undefined}>
      {!inline && <div className="drawer__head"><h3 className="drawer__title" id="dec-title">{t('servidor.decisoes.titulo')}</h3><button className="icon-btn" onClick={onClose} aria-label={t('servidor.decisoes.fechar')} title={t('servidor.decisoes.fechar')}><Icon name="x" /></button></div>}
      {!x ? <Loading error={d.error} /> : (
        <>
          {err && <p className="error" role="alert">{err}</p>}
          {done && <p className="ok" role="status">{done}</p>}
          {empty && <p className="muted">{t('servidor.decisoes.vazio')}</p>}

          {x.cards.length > 0 && <h4 className="rt-sub">{t('servidor.decisoes.cards')}</h4>}
          {x.cards.map((c) => {
            const v = text[c.id] ?? '';
            return (
              <Item key={c.id} icone={NEED_ICON[c.need]} badge={t('servidor.decisoes.badgeCard', { numero: c.number, precisa: t(NEED_LABEL[c.need]) })} onOpen={() => openCard(c.id)} openLabel={t('servidor.decisoes.abrirCard', { numero: c.number })} aviso={aviso?.id === c.id ? aviso.texto : null}
                actions={c.need === 'info' ? (
                  <form className={`dec-answer ${FILEIRA}`} onSubmit={(e) => { e.preventDefault(); if (textoCurto(v)) { setAviso({ id: c.id, texto: t('tarefa.escrevaResposta') }); return; } void respond(c.id, 'answer', v.trim()); }}>
                    <input required value={v} maxLength={1500} onChange={(e) => { semAviso(c.id); setText((t) => ({ ...t, [c.id]: e.target.value })); }} placeholder={t('servidor.decisoes.suaResposta')} aria-label={t('servidor.decisoes.respostaPara', { numero: c.number })} />
                    <button className={ACAO.principal} aria-busy={vai(c.id, 'answer')}>{vai(c.id, 'answer') ? t('servidor.decisoes.enviando') : t('servidor.decisoes.responder')}</button>
                    <button type="button" className={ACAO.secundario} aria-busy={vai(c.id, 'return')} title={t('servidor.decisoes.seguirSemDica')}
                      onClick={() => void respond(c.id, 'return', t('servidor.decisoes.seguirSem'))}>{vai(c.id, 'return') ? t('servidor.decisoes.enviando') : t('servidor.decisoes.recusar')}</button>
                  </form>
                ) : returning === c.id || vai(c.id, 'return') ? (
                  // a devolução deste card indo: o formulário fica, mesmo que a pessoa abra o Recusar de outro card (o
                  // `returning` é um só) — senão este voltava a mostrar Aprovar/Recusar parados, sem dizer que algo vai
                  <form className={`dec-answer ${FILEIRA}`} onSubmit={(e) => { e.preventDefault(); if (textoCurto(v, 3)) { setAviso({ id: c.id, texto: t('tarefa.ajuste.minimo') }); return; } void respond(c.id, 'return', v.trim()); }}>
                    <input autoFocus required minLength={3} value={v} maxLength={1500} onChange={(e) => { semAviso(c.id); setText((t) => ({ ...t, [c.id]: e.target.value })); }} placeholder={t('servidor.decisoes.oQueMudar')} aria-label={t('servidor.decisoes.instrucaoPara', { numero: c.number })} />
                    <button className={ACAO.principal} aria-busy={vai(c.id, 'return')}>{vai(c.id, 'return') ? t('servidor.decisoes.enviando') : t('servidor.decisoes.devolver')}</button>
                    {/* no meio da devolução o Cancelar não age: o formulário fica até ela terminar (o Aprovar não volta dizendo "Aprovando…") */}
                    <button type="button" className={ACAO.secundario} onClick={() => { if (!vai(c.id)) { semAviso(c.id); setReturning(null); } }}>{t('servidor.decisoes.cancelar')}</button>
                  </form>
                ) : (<>
                  <button className={ACAO.principal} aria-busy={vai(c.id, 'approve')} onClick={() => void respond(c.id, 'approve')}>{vai(c.id, 'approve') ? t('servidor.decisoes.aprovando') : c.external ? t('servidor.decisoes.confirmar') : t('servidor.decisoes.aprovar')}</button>
                  <button className={ACAO.secundario} onClick={() => { if (!vai(c.id)) setReturning(c.id); }} title={t('servidor.decisoes.devolverDica')}>{t('servidor.decisoes.recusar')}</button>
                </>)}>
                <b>{c.title}</b>
                <span className="muted small">{t('servidor.decisoes.deQuem', { nome: c.agent_name ?? t('servidor.decisoes.aEquipe') })}</span>
                {c.need === 'info' && <span className="dec-card__q">{c.question ?? c.justification}</span>}
                {c.need === 'review' && c.justification && <span className="dec-card__q muted">{c.justification}</span>}
              </Item>
            );
          })}

          {routines.length > 0 && <h4 className="rt-sub">{t('servidor.decisoes.rotinas')}</h4>}
          {routines.map((p) => (
            <article key={p.id} className="dec-card dec-card--routine">
              <Selo icone="repeat">{p.purpose === 'routine-recommend' ? t('servidor.decisoes.comRecomendacao', { tipo: KIND[p.kind] }) : KIND[p.kind]}</Selo>
              {split(p.summary)[0] && <p className="dec-card__pitch">{split(p.summary)[0]}</p>}
              <p className="dec-card__txt dec-card__spec">{split(p.summary)[1]}</p>
              <div className={FILEIRA}>
                <button className={ACAO.principal} aria-busy={vai(p.id, 'apply')} onClick={() => void proposal(p.id, 'apply')}>{vai(p.id, 'apply') ? t('servidor.decisoes.aplicando') : p.kind === 'routine' ? t('servidor.decisoes.ativar') : t('servidor.decisoes.aprovar')}</button>
                <button className={ACAO.secundario} aria-busy={vai(p.id, 'reject')} onClick={() => void proposal(p.id, 'reject')}>{vai(p.id, 'reject') ? t('servidor.decisoes.recusando') : t('servidor.decisoes.recusar')}</button>
                {conv(p) && <button className={`${ACAO.leve} card-acts__fim`} onClick={conv(p)}>{t('servidor.decisoes.conversarSobre')}</button>}
              </div>
            </article>
          ))}

          {team.length > 0 && <h4 className="rt-sub">{t('servidor.decisoes.propostas')}</h4>}
          {team.map((p) => p.kind === 'conexao' || p.kind === 'depois_de_ler' || p.kind === 'aprovacao' || p.kind === 'regra' ? (
            // ação numa conta: o texto inteiro (recolhido quando longo) e de onde veio — o card (#N · quem pediu) ou a conversa.
            // Este cartão existe para ler antes de Confirmar um envio em nome da pessoa: ele NÃO abre inteiro (clicar no texto
            // que se está lendo, ou errar Confirmar/Recusar por pouco, tirava o painel da frente); abre só pelo "#N · quem"
            <article key={p.id} className="dec-card">
              <div className="dec-card__top">
                <Selo icone={p.kind === 'regra' ? 'shield-check' : 'plug'}>{KIND[p.kind]}</Selo>
                {p.task_id ? <button type="button" className={ACAO.leve} onClick={() => openCard(p.task_id!)} title={t('servidor.decisoes.abrirCard', { numero: p.task_number ?? '' })}>#{p.task_number}{p.agent_name ? t('servidor.decisoes.deQuem', { nome: p.agent_name }) : ''}</button>
                  : conv(p) ? <button type="button" className={ACAO.leve} onClick={conv(p)} title={t('servidor.decisoes.abrirConversa')}>{p.agent_name ?? t('servidor.decisoes.aConversa')}</button>
                  : p.agent_name && <span className="muted small">{p.agent_name}</span>}
              </div>
              {/* o resumo é escrito pelo servidor e ainda vem só em português (próximo passo: server/src/lib/textos.ts, no começo) */}
              <div className="dec-card__txt"><TextoLongo texto={p.summary} /></div>
              <div className={`${FILEIRA} dec-card__acts`}>
                {p.kind === 'regra' ? <BotoesRegra sugerido={alcanceSugerido(p.payload)} ocupado={ocupadoDe(p.id)} onEscolher={(alcance) => void proposal(p.id, 'apply', { alcance })} onRecusar={() => void proposal(p.id, 'reject')} />
                  : p.kind === 'depois_de_ler' ? <BotoesPrazo ocupado={ocupadoDe(p.id)} onEscolher={(prazo) => void proposal(p.id, 'apply', { prazo })} onRecusar={() => void proposal(p.id, 'reject')} />
                  : <>
                    <button className={ACAO.principal} aria-busy={vai(p.id, 'apply')} onClick={() => void proposal(p.id, 'apply')}>{vai(p.id, 'apply') ? (p.kind === 'aprovacao' ? t('servidor.decisoes.aprovando') : t('servidor.decisoes.enviando')) : p.kind === 'aprovacao' ? t('servidor.decisoes.aprovar') : t('servidor.decisoes.confirmar')}</button>
                    <button className={ACAO.secundario} aria-busy={vai(p.id, 'reject')} onClick={() => void proposal(p.id, 'reject')}>{vai(p.id, 'reject') ? t('servidor.decisoes.recusando') : t('servidor.decisoes.recusar')}</button>
                  </>}
              </div>
            </article>
          ) : (
            <Item key={p.id} icone={p.kind === 'question' ? 'help' : p.kind === 'segredo' || p.kind === 'permission' ? 'key' : 'flag'} badge={p.agent_name ? t('servidor.decisoes.tipoDeQuem', { tipo: KIND[p.kind] ?? p.kind, nome: p.agent_name }) : KIND[p.kind] ?? p.kind} onOpen={conv(p)} openLabel={t('servidor.decisoes.abrirConversa')}
              actions={p.kind === 'question' || p.kind === 'segredo'
                ? (conv(p) ?? (p.task_id ? () => openCard(p.task_id!) : null)) && <button className={ACAO.principal} onClick={conv(p) ?? (() => openCard(p.task_id!))}>
                  <Icon name={p.kind === 'segredo' ? 'key' : 'chat'} size={13} /> {p.kind === 'segredo' ? t('servidor.decisoes.informar') : t('servidor.decisoes.responder')}</button>
                : p.kind === 'permission'
                ? conv(p) && <button className={ACAO.principal} onClick={conv(p)}><Icon name="key" size={13} /> {t('servidor.decisoes.autorizar')}</button>
                : <>
                  {/* apagar de vez: o vermelho cheio (o pedido já é a confirmação) */}
                  <button className={p.kind === 'purge' ? ACAO.perigoso : ACAO.principal} aria-busy={vai(p.id, 'apply')} onClick={() => void proposal(p.id, 'apply')}>{vai(p.id, 'apply') ? t('servidor.decisoes.aplicando') : t('servidor.decisoes.aprovar')}</button>
                  <button className={ACAO.secundario} aria-busy={vai(p.id, 'reject')} onClick={() => void proposal(p.id, 'reject')}>{vai(p.id, 'reject') ? t('servidor.decisoes.recusando') : t('servidor.decisoes.recusar')}</button>
                </>}>
              {p.summary}
            </Item>
          ))}

          {x.waiting.length > 0 && <h4 className="rt-sub">{t('servidor.decisoes.esperandoResposta')}</h4>}
          {x.waiting.map((w) => (
            <Item key={w.id} icone="chat" badge={t('servidor.decisoes.pergunta')} onOpen={() => openConversation(w.agent_id, w.conversation_id)} openLabel={t('servidor.decisoes.abrirConversa')}
              actions={<button className={ACAO.principal} onClick={() => openConversation(w.agent_id, w.conversation_id)}>{t('servidor.decisoes.responder')}</button>}>
              {t('servidor.decisoes.fezPergunta', { nome: w.agent_name })}
            </Item>
          ))}

          {(x.linkList.length > 0 || x.ruleList.length > 0) && <h4 className="rt-sub">{t('servidor.decisoes.paraConferir')}</h4>}
          {x.linkList.map((l) => (
            <Item key={l.id} icone="layers" badge={t('servidor.decisoes.vinculo')} onOpen={() => openCard(l.task_id)} openLabel={t('servidor.decisoes.abrirCard', { numero: l.number })}
              actions={<>
                <button className={ACAO.principal} aria-busy={vai(l.id, 'apply')} onClick={() => decidirItem(l.id, 'apply', () => api.post(`/api/link-proposals/${l.id}`, { decision: 'confirmed' }))}>{vai(l.id, 'apply') ? t('servidor.decisoes.aprovando') : t('servidor.decisoes.aprovar')}</button>
                <button className={ACAO.secundario} aria-busy={vai(l.id, 'reject')} onClick={() => decidirItem(l.id, 'reject', () => api.post(`/api/link-proposals/${l.id}`, { decision: 'rejected' }))}>{vai(l.id, 'reject') ? t('servidor.decisoes.recusando') : t('servidor.decisoes.recusar')}</button>
              </>}>
              {t('servidor.decisoes.pareceOMesmo', { numero: l.number, titulo: l.title, outro: l.related_number, outroTitulo: l.related_title })} <span className="muted small">{l.reason}</span>
            </Item>
          ))}
          {x.ruleList.map((r) => (
            <Item key={r.id} icone="shield-check" badge={t('servidor.decisoes.regra')} onOpen={() => { location.hash = '#conexoes?regras'; onClose?.(); }} openLabel={t('servidor.decisoes.verRegras')}
              actions={<>
                <button className={ACAO.principal} aria-busy={vai(r.id, 'apply')} onClick={() => decidirItem(r.id, 'apply', () => api.post(`/api/rules/${r.id}`, { decision: 'active' }))}>{vai(r.id, 'apply') ? t('servidor.decisoes.aprovando') : t('servidor.decisoes.aprovar')}</button>
                <button className={ACAO.secundario} aria-busy={vai(r.id, 'reject')} onClick={() => decidirItem(r.id, 'reject', () => api.post(`/api/rules/${r.id}`, { decision: 'rejected' }))}>{vai(r.id, 'reject') ? t('servidor.decisoes.recusando') : t('servidor.decisoes.recusar')}</button>
              </>}>
              {r.text}
            </Item>
          ))}
          {x.refusedRoutines.length > 0 && (
            <details className="dec-refused">
              <summary>{t('servidor.decisoes.recusadas', { quantas: x.refusedRoutines.length })}</summary>
              <p className="hint">{t('servidor.decisoes.recusadasDica')}</p>
              {x.refusedRoutines.map((r) => (
                <div key={r.id} className="dec-card dec-card--muted">
                  <p className="dec-card__txt">{r.summary}</p>
                  <div className={FILEIRA}><button className={ACAO.secundario} aria-busy={vai(r.id)} onClick={() => void act(r.id, 'reconsider', () => api.post(`/api/proposals/${r.id}/reconsider`))}>{vai(r.id) ? t('servidor.decisoes.enviando') : t('servidor.decisoes.reconsiderar')}</button></div>
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </aside>
  );
}
