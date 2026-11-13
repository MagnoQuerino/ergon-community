import { useState } from 'react';
import { useT, tn } from '../i18n/index.ts';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { openCard, openConversation } from '../lib/open.ts';
import type { Proposal, RequestPayload } from '../lib/types.ts';
import { ACAO, FILEIRA } from '../lib/cartoes-acoes.ts';
import { textoCurto, useEnvio } from '../lib/envio.ts';
import { Icon } from './Icon.tsx';
import { Selo } from './Selo.tsx';

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
      <button type="button" className={`${ACAO.leve} msg__more`} onClick={() => setAll((v) => !v)} aria-expanded={all}>
        {all ? t('conversas.nota.verMenos') : t('conversas.nota.verTudo', { n: lines.length - 3 })}
      </button>
    </>
  );
}

/**
 * Pedido de um card repassado pelo agente da conversa: responder a uma pergunta, aprovar, devolver com instrução ou
 * tentar de novo, ali mesmo. A resposta vai para o card, que já volta a trabalhar; a mensagem do agente fica acima,
 * como dele (nunca como se fosse do usuário). Enquanto vai, o botão fica ativo, diz "Enviando…" e o segundo clique
 * não manda de novo (lib/envio.ts).
 */
export function RequestCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const t = useT();
  const r = (() => { try { return JSON.parse(p.payload ?? '{}') as RequestPayload; } catch { return null; } })();
  const [text, setText] = useState('');
  const [back, setBack] = useState(false);
  const { indo, enviar } = useEnvio();
  const [err, setErr] = useState<string | null>(null);
  // o campo só com espaços: o clique (ou o Enter) avisa aqui no cartão, em vez de não fazer nada
  const [aviso, setAviso] = useState(false);
  if (!r) return null;
  // a resposta foi: o cartão vira "respondido" quando a conversa relê (até lá, a trava segura o segundo clique)
  const send = (action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss', note?: string) => void enviar(action, async () => {
    setErr(null); setAviso(false);
    await api.post(`/api/proposals/${p.id}/respond`, note ? { action, text: note } : { action });
    setText(''); setBack(false); onDone();
  }, true).catch((e) => setErr(errMsg(e)));
  const rotulo = (acao: string, texto: string) => (indo === acao ? (acao === 'approve' ? t('conversas.proposta.aprovando') : t('conversas.proposta.enviando')) : texto);
  const open = <button type="button" className={`${ACAO.leve} card-acts__fim`} onClick={() => openCard(r.taskId)}>{t('conversas.pedido.abrirCard', { numero: r.number })}</button>;
  // p.result: o que o servidor registrou ao responder
  if (p.status !== 'proposed') return <div className="req-card req-card--done"><span className="muted small">{t('conversas.pedido.respondidoComo', { numero: r.number, resultado: p.result ?? t('conversas.pedido.respondido') })}</span></div>;
  const enviar1 = () => { if (textoCurto(text)) { setAviso(true); return; } send(back ? 'return' : 'answer', text.trim()); };
  const round = r.round ?? 1;
  const principal = back ? 'return' : 'answer';
  return (
    <div className="req-card" role="group" aria-label={t('conversas.pedido.aria', { numero: r.number })}>
      {r.excerpt && <details className="req-card__excerpt"><summary>{t('conversas.pedido.oQueVeio', { numero: r.number })}</summary><p className="pre">{r.excerpt}</p></details>}
      {r.need === 'info' || back ? (
        // o campo é obrigatório: Responder vazio não envia (o próprio navegador pede para escrever), sem botão cinza
        <form className="req-card__form" onSubmit={(e) => { e.preventDefault(); enviar1(); }}>
          <textarea autoFocus required value={text} rows={2} onChange={(e) => { setAviso(false); setText(e.target.value); }}
            placeholder={back ? (r.review ? t('conversas.pedido.ajustarCampo') : t('conversas.pedido.mudarCampo')) : t('conversas.pedido.respostaPara', { nome: r.agent })} aria-label={back ? t('conversas.pedido.instrucao') : t('conversas.pedido.suaResposta')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar1(); } }} />
          <div className={FILEIRA}>
            <button className={ACAO.principal} aria-busy={indo === principal}>{rotulo(principal, back ? (r.review ? t('conversas.pedido.pedirAjustes') : t('conversas.pedido.devolver')) : t('conversas.pedido.responder'))}</button>
            {r.need === 'info' && !back && <button type="button" className={ACAO.secundario} aria-busy={indo === 'return'} onClick={() => send('return', t('conversas.pedido.seguirSemTexto'))}>{rotulo('return', t('conversas.pedido.seguirSem'))}</button>}
            {back && <button type="button" className={ACAO.secundario} onClick={() => { setAviso(false); setBack(false); }}>{t('conversas.pedido.cancelar')}</button>}
            {open}
          </div>
          {aviso && <p className="error small" role="alert">{t('tarefa.escrevaResposta')}</p>}
        </form>
      ) : (
        <div className={FILEIRA}>
          {r.review && <span className="req-card__what">{tn('conversas.pedido.entrega', { titulo: <b>{round > 1 ? t('conversas.pedido.entregaDoCardVersao', { numero: r.number, versao: round }) : t('conversas.pedido.entregaDoCard', { numero: r.number })}</b> })}</span>}
          {(r.need === 'approval' || r.need === 'review') && <button className={ACAO.principal} aria-busy={indo === 'approve'} onClick={() => send('approve')}>{rotulo('approve', r.need === 'review' ? t('conversas.pedido.aprovarAssim') : t('conversas.pedido.aprovar'))}</button>}
          {r.need === 'retry' && <button className={ACAO.principal} aria-busy={indo === 'retry'} onClick={() => send('retry')}>{rotulo('retry', t('conversas.pedido.tentarDeNovo'))}</button>}
          {r.need !== 'retry' && <button className={ACAO.secundario} onClick={() => { if (!indo) setBack(true); }}>{r.review ? t('conversas.pedido.pedirAjustes') : t('conversas.pedido.devolverComInstrucao')}</button>}
          {r.need === 'retry' && <button className={ACAO.secundario} aria-busy={indo === 'dismiss'} onClick={() => send('dismiss')}>{rotulo('dismiss', t('conversas.pedido.deixar'))}</button>}
          {open}
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
  const { indo, enviar } = useEnvio();
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="perm-card" onSubmit={(e) => {
      e.preventDefault();
      void enviar('autorizar', async () => { setErr(null); await api.post(`/api/proposals/${p.id}/authorize`, { password }); setPassword(''); onDone(); }, true)
        .catch((x) => setErr(x instanceof ApiError && x.code === 'invalid_login' ? t('conversas.permissao.senhaErrada') : errMsg(x)));
    }}>
      <div className="perm-card__head"><Icon name="lock" size={16} /> <b>{t('conversas.permissao.titulo')}</b></div>
      <p className="perm-card__what">{p.summary}</p>
      <p className="hint warn">{t('conversas.permissao.aviso')}</p>
      <div className={FILEIRA}>
        <input type="password" autoComplete="current-password" autoFocus required placeholder={t('conversas.permissao.senha')} aria-label={t('conversas.permissao.senha')} value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className={ACAO.principal} aria-busy={!!indo}>{indo ? t('conversas.permissao.conferindo') : t('conversas.permissao.autorizar')}</button>
        <button type="button" className={ACAO.secundario} onClick={() => { if (!indo) onReject(); }}>{t('conversas.permissao.recusar')}</button>
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
        <div className={FILEIRA}><button className={ACAO.principal} onClick={() => openConversation(d.coordinatorId, d.conversationId)}><Icon name="chat" size={14} /> {t('conversas.repasse.abrir')}</button></div>
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
  // pedido: a pergunta veio da ferramenta do agente (a resposta volta no mesmo trabalho); multi: aceita várias opções
  const d = (() => { try { return JSON.parse(p.payload ?? '{}') as { options?: string[]; pedido?: string; multi?: boolean }; } catch { return {}; } })();
  const options = d.options ?? [];
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const { indo, enviar } = useEnvio();
  const [err, setErr] = useState<string | null>(null);
  // qual: a opção (ou o botão) que diz "Enviando…"; respondida, a trava segura até o cartão virar "respondida"
  const [aviso, setAviso] = useState(false);
  const answer = (qual: string, a: string, varias?: string[]) => {
    // "Outra resposta" só com espaços: avisa no cartão (o required do navegador só barra o campo vazio)
    if (textoCurto(a)) { setAviso(true); return; }
    void enviar(qual, async () => { setErr(null); await api.post(`/api/proposals/${p.id}/answer`, { answer: a.trim(), ...(varias?.length ? { answers: varias } : {}) }); onDone(); }, true)
      .catch((e) => setErr(errMsg(e)));
  };
  const naoResponder = () => void enviar('nao', async () => { setErr(null); await api.post(`/api/proposals/${p.id}`, { decision: 'reject' }); onDone(); }, true)
    .catch((e) => setErr(errMsg(e)));
  const enviando = t('conversas.proposta.enviando');
  if (p.status !== 'proposed') return (
    <div className="question-card question-card--done"><span className="question-card__q">{p.summary}</span>
      <Selo icone={p.status === 'applied' ? 'check' : 'x'} tom={p.status === 'applied' ? 'ok' : undefined}>{p.result?.split('\n').join(', ')}</Selo></div>
  );
  const temAcoes = (d.multi && marcadas.length > 0) || !showOther || !!d.pedido;
  return (
    <div className="question-card" role="group" aria-label={p.summary}>
      <span className="question-card__q">{p.summary}</span>
      <div className="question-card__opts">
        {d.multi ? options.map((o) => (
          <label key={o} className="question-card__opt card-opt">
            <input type="checkbox" checked={marcadas.includes(o)} onChange={(e) => setMarcadas((cur) => (e.target.checked ? [...cur, o] : cur.filter((x) => x !== o)))} /> {o}
          </label>
        )) : options.map((o, i) => (
          <button key={o} type="button" className={ACAO.opcao} aria-busy={indo === `opcao:${o}`} onClick={() => answer(`opcao:${o}`, o)}>
            {indo === `opcao:${o}` ? enviando : o}
            {d.pedido && i === 0 && options.length > 1 ? <Selo icone="bulb">{t('conversas.pergunta.recomendada')}</Selo> : null}
          </button>
        ))}
      </div>
      {temAcoes && (
        <div className={FILEIRA}>
          {d.multi && marcadas.length > 0 && <button type="button" className={ACAO.principal} aria-busy={indo === 'varias'} onClick={() => answer('varias', marcadas.join(', '), marcadas)}>{indo === 'varias' ? enviando : t('conversas.pergunta.responder')}</button>}
          {!showOther && <button type="button" className={ACAO.secundario} onClick={() => setShowOther(true)}>{t('conversas.pergunta.outra')}</button>}
          {d.pedido && <button type="button" className={`${ACAO.leve} question-card__nao`} aria-busy={indo === 'nao'} onClick={naoResponder}>{indo === 'nao' ? enviando : t('conversas.pergunta.naoResponder')}</button>}
        </div>
      )}
      {showOther && (
        <form className={FILEIRA} onSubmit={(e) => { e.preventDefault(); answer('outra', other); }}>
          <input required value={other} maxLength={300} onChange={(e) => { setAviso(false); setOther(e.target.value); }} placeholder={t('conversas.pergunta.campo')} aria-label={t('conversas.pergunta.outra')} autoFocus />
          <button className={ACAO.principal} aria-busy={indo === 'outra'}>{indo === 'outra' ? enviando : t('conversas.pergunta.responder')}</button>
        </form>
      )}
      {showOther && aviso && <p className="error small" role="alert">{t('tarefa.escrevaResposta')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

/**
 * Cartão protegido: o agente pediu uma chave, senha ou token (pedir_chave) ou a senha de administrador (pedir_senha_admin).
 * O valor vai direto ao cofre da equipe: não aparece na conversa, no histórico nem nos registros, e o agente recebe só o
 * nome. A senha de administrador vale só para este trabalho, a menos que você marque guardar.
 */
// i18n-ok: o resultado que o servidor grava quando a senha fica no cofre (server/src/services/cartoes.ts), não é texto de tela
const SUDO_GUARDADA = 'guardada para a equipe';
export function SecretCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const t = useT();
  const d = (() => { try { return JSON.parse(p.payload ?? '{}') as { tipo?: 'chave' | 'sudo'; nome?: string; motivo?: string; agente?: string }; } catch { return {}; } })();
  const sudo = d.tipo === 'sudo';
  const [valor, setValor] = useState('');
  const [guardar, setGuardar] = useState(false);
  const { indo, enviar } = useEnvio();
  const [err, setErr] = useState<string | null>(null);
  if (p.status !== 'proposed') return (
    <div className="perm-card perm-card--done"><Icon name="lock" size={14} /> {sudo ? t('conversas.segredo.feitoSudo') : t('conversas.segredo.feito', { nome: d.nome ?? '' })}{' '}
      <Selo icone={p.status === 'applied' ? 'check' : 'x'} tom={p.status === 'applied' ? 'ok' : undefined}>{p.status !== 'applied' ? t('conversas.segredo.recusado')
        : sudo ? (p.result === SUDO_GUARDADA ? t('conversas.segredo.guardada') : t('conversas.segredo.soEste')) : t('conversas.segredo.guardadaComo', { nome: d.nome ?? '' })}</Selo></div>
  );
  const recusar = () => void enviar('recusar', async () => { setErr(null); await api.post(`/api/proposals/${p.id}`, { decision: 'reject' }); onDone(); }, true)
    .catch((e) => setErr(errMsg(e)));
  return (
    <form className="perm-card perm-card--segredo" autoComplete="off" onSubmit={(e) => {
      e.preventDefault(); if (!valor) return;
      void enviar('entregar', async () => { setErr(null); await api.post(`/api/proposals/${p.id}/segredo`, { valor, ...(sudo ? { guardar } : {}) }); setValor(''); onDone(); }, true)
        .catch((x) => setErr(errMsg(x)));
    }}>
      <div className="perm-card__head"><Icon name={sudo ? 'shield' : 'key'} size={16} /> <b>{sudo ? t('conversas.segredo.tituloSudo', { nome: d.agente ?? '' }) : t('conversas.segredo.titulo', { nome: d.agente ?? '', chave: d.nome ?? '' })}</b></div>
      {d.motivo && <p className="perm-card__what">{d.motivo}</p>}
      <p className="hint small">{sudo ? t('conversas.segredo.comoSudo') : t('conversas.segredo.como', { nome: d.nome ?? '' })}</p>
      {sudo && <p className="hint warn small">{t('conversas.segredo.riscoSudo')}</p>}
      <div className={FILEIRA}>
        <input type="password" autoComplete="new-password" spellCheck={false} required value={valor} maxLength={4000} onChange={(e) => setValor(e.target.value)}
          placeholder={sudo ? t('conversas.segredo.campoSudo') : t('conversas.segredo.campo')} aria-label={sudo ? t('conversas.segredo.campoSudo') : t('conversas.segredo.campo')} />
        <button className={ACAO.principal} aria-busy={indo === 'entregar'}>{indo === 'entregar' ? t('conversas.segredo.guardando') : t('conversas.segredo.entregar')}</button>
        <button type="button" className={ACAO.secundario} aria-busy={indo === 'recusar'} onClick={recusar}>{indo === 'recusar' ? t('conversas.proposta.enviando') : t('conversas.segredo.naoInformar')}</button>
      </div>
      {sudo && (
        <label className="row small"><input type="checkbox" checked={guardar} onChange={(e) => setGuardar(e.target.checked)} /> {t('conversas.segredo.guardarSudo')}</label>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </form>
  );
}
