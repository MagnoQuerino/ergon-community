import { useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { ORIGIN_LABEL, SOURCE_LABEL, stripControl, type Agent, type Column, type Need } from '../lib/types.ts';
import { DISPLAY_BADGE, DISPLAY_LABEL, displayOf } from '../lib/work.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';
import { DueChip } from './Board.tsx';
import { reviewerOf } from '../lib/team.ts';
import { ActionBar, IconAction, TaskFiles, TechDetails, type TaskFile, type WorkInfo } from './TaskWork.tsx';

interface Step { position: number; agentId: string; title: string; status: 'pendente' | 'em_andamento' | 'feita' | 'falhou'; doneAt: string | null }
interface Detail {
  task: { id: string; number: number; title: string; description: string; completed: number; completed_by: string | null; completed_at: string | null; column_id: string; agent_id: string | null; origin: string; is_fixture: number; revision: number; board_id: string; external_assignee: string | null; parent_task_id: string | null; due_on: string | null; priority?: number };
  log: Array<{ id: string; actor_type: string; actor_id: string | null; action: string; evidence: string | null; result: string; created_at: string }>;
  link: { external_id: string; external_version: string; external_extra: string; sync_state: string; conflict: string | null; last_seen_at: string } | null;
  proposals: Array<{ id: string; related_number: number; related_title: string; reason: string; score: number; status: string }>;
  source: { platform: string; is_fixture: number; received_at: string; status: string; text_excerpt: string | null } | null;
  runs: Array<{ id: string; agent_id: string; status: string; mode: string; created_at: string }>;
  review: { id: string; status: 'open' | 'approved' | 'limit' | 'stopped'; round: number; max_rounds: number; reviewer_name: string; producer_name: string; finished_at: string | null } | null;
  files: { inputs: TaskFile[]; deliverables: TaskFile[] };
  work: WorkInfo | null;
  /** quadro da equipe: onde o card está na fila de "A fazer" (null = não está esperando ali) */
  queue?: { position: number; total: number } | null;
  column: string | null;
  board: { audience: 'team' | 'user'; origin: 'native' | 'mirror'; source: string | null } | null;
  /** o plano do coordenador, em ordem; a pergunta do agente (se o card espera uma informação sua) */
  steps: Step[];
  question: string | null;
  /** card parado pelo sistema (sem pergunta do agente): o que falta */
  missing: string | null;
  /** a conversa de onde o pedido veio: quem entrega lá, o pedido e se já foi entregue */
  origin: { conversationId: string | null; agentId: string; deliverAgentId: string; purpose: string | null; delivered: boolean } | null;
  /** cards que nasceram deste (ajuda pedida, o card enviado à equipe): cancelar este leva junto */
  children: Array<{ number: number; title: string }>;
}

const REVIEW_STATUS: Record<string, string> = {
  open: 'em andamento', approved: 'entrega razoável (VEREDITO: pronto)', limit: 'limite de rodadas: ainda há pontos', stopped: 'interrompida',
};
const RUN_STATUS: Record<string, string> = { queued: 'na fila', running: 'trabalhando', waiting_user: 'aguarda você', succeeded: 'concluída', failed: 'falhou', cancelled: 'cancelada' };
const STEP_ICON: Record<Step['status'], string> = { feita: 'check', em_andamento: 'play', pendente: 'clock', falhou: 'alert' };

const ACTION_LABEL: Record<string, string> = {
  'task.create': 'Card criado', 'task.update': 'Card alterado', 'task.delegate': 'Pedido a um agente', 'task.completion_reported': 'Conclusão informada (aguarda confirmação)',
  'source.edited': 'Mensagem de origem editada', 'mirror.task.import': 'Veio do aplicativo de origem', 'mirror.task.update': 'Atualizado pelo aplicativo de origem',
  'mirror.task.missing': 'Não apareceu na última leitura', 'link.confirmed': 'Vínculo confirmado', 'link.rejected': 'Vínculo rejeitado', 'link.revert': 'Vínculo revertido',
  'agent.result.succeeded': 'Resultado do agente', 'agent.result.failed': 'O agente não conseguiu', 'agent.result.cancelled': 'Execução cancelada',
  'task.route': 'Encaminhado pela coordenação', 'task.reassign': 'Redistribuído pela coordenação', 'task.handoff': 'Pedido de ajuda',
  'task.help_result': 'Ajuda recebida', 'task.queue_start': 'Começou a trabalhar', 'review.start': 'Revisão crítica pedida',
  'review.approved': 'Revisão: entrega razoável', 'review.limit': 'Revisão: limite de rodadas', 'review.stopped': 'Revisão interrompida',
  'task.result': 'Conferência do resultado', 'task.work_state': 'Estado do trabalho', 'operation.run': 'Análise feita pelo sistema', 'operation.refused': 'Processamento recusado',
  'task.waiting_help': 'Aguardando colegas', 'task.queue': 'Ordem da fila', 'task.requires_approval': 'Aprovação', 'agent.tools': 'Ferramentas do agente',
  'task.plan': 'Plano da coordenação', 'task.step_done': 'Etapa entregue', 'task.delivery': 'Entrega na conversa', 'task.deleted': 'Card apagado', 'task.cancelled': 'Card cancelado', 'task.help_not_done': 'Ajuda não veio',
};
/** ações cujo resultado (texto) explica o que aconteceu: aparecem no histórico */
const SHOW_RESULT = ['task.queue', 'task.route', 'task.reassign', 'task.handoff', 'task.help_result', 'task.result', 'task.work_state', 'operation.run', 'operation.refused', 'task.waiting_help',
  'task.queue_start', 'task.requires_approval', 'task.plan', 'task.step_done', 'task.delivery', 'task.deleted', 'task.cancelled', 'task.help_not_done'];

/**
 * Detalhe do card. 'team': quadro da equipe — você acompanha e decide (responder, aprovar, devolver), sem editar o
 * card. 'user': suas tarefas locais — edita e envia à equipe. 'mirror': espelho de um aplicativo — só leitura.
 * Fica o essencial (número, conversa, título, descrição, situação, com quem está, prazo, estado); a conferência e o
 * histórico ficam recolhidos no fim, em "Detalhes técnicos" e "Histórico". Clicar noutro card, menu ou link troca
 * na hora (o painel não engole o clique).
 */
/** over: aberto por cima de qualquer tela (de uma conversa, de "aguardando você"): fica acima das janelas */
export function TaskDetail({ taskId, columns: askedColumns, agents, mode: asked, source: askedSource, onClose, onAskCoordinator, over }: {
  taskId: string; columns?: Column[]; agents: Agent[]; mode: 'team' | 'user' | 'mirror' | 'auto'; source?: string | null;
  onClose: () => void; onAskCoordinator?: (text: string) => void; over?: boolean;
}) {
  const d = useResource<Detail>(`/api/tasks/${taskId}`, ['tasks.changed', 'runs.changed']);
  // 'auto': aberto de fora do quadro ("aguardando você", uma conversa) — o modo vem do quadro do card
  const b = d.data?.board;
  const mode: 'team' | 'user' | 'mirror' = asked !== 'auto' ? asked : b?.origin === 'mirror' ? 'mirror' : b?.audience === 'user' ? 'user' : 'team';
  const source = askedSource ?? b?.source ?? null;
  // suas tarefas abertas de fora do quadro: as colunas vêm do quadro delas
  const own = useResource<{ columns: Column[] }>(asked === 'auto' && mode === 'user' && d.data ? `/api/boards/${d.data.task.board_id}` : null, []);
  const columns = askedColumns ?? own.data?.columns;
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [back, setBack] = useState<string | null>(null); // "Devolver com instrução" aberto (o texto)
  const [answer, setAnswer] = useState('');
  const [busyAct, setBusyAct] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false); // "Cancelar a tarefa" pede confirmação ali mesmo
  useEffect(() => { if (!savedNow) return; const t = window.setTimeout(() => setSavedNow(false), 2500); return () => window.clearTimeout(t); }, [savedNow]);
  const ref = useRef<HTMLElement>(null);
  // edição: o que já está no servidor e a revisão conhecida; gravações em fila (sair do campo e fechar não brigam)
  const saved = useRef({ title: '', desc: '' });
  const rev = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const idRef = useRef(taskId);
  idRef.current = taskId;
  useEffect(() => {
    if (!d.data) return;
    setTitle(d.data.task.title); setDesc(d.data.task.description);
    saved.current = { title: d.data.task.title, desc: d.data.task.description }; rev.current = Math.max(rev.current, d.data.task.revision);
  }, [d.data?.task.id, d.data?.task.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOk(null); setErr(null); setBack(null); setAnswer(''); setConfirmCancel(false); rev.current = 0; }, [taskId]);

  /** Grava título e descrição se mudaram (em fila). false = não gravou: o erro fica à vista e o card, aberto. */
  const saveText = (): Promise<boolean> => {
    const id = taskId; const want = { title, desc };
    const run = async () => {
      const body: Record<string, unknown> = {};
      if (want.title !== saved.current.title && want.title.trim()) body.title = want.title;
      if (want.desc !== saved.current.desc) body.description = want.desc;
      if (!Object.keys(body).length || mode !== 'user') return true;
      setErr(null);
      try {
        const r = await api.patch<{ revision: number }>(`/api/tasks/${id}`, { ...body, expectedRevision: rev.current });
        rev.current = r.revision; saved.current = { title: want.title, desc: want.desc }; d.reload(); if (idRef.current === id) setSavedNow(true); return true;
      } catch (e) { setErr(`Não gravei a alteração: ${errMsg(e)}`); d.reload(); return false; }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  };
  /** Fechar (X, Esc, clique fora): grava o que estiver pendente antes; se não gravar, o card fica aberto com o erro. */
  const requestClose = async () => {
    const id = taskId;
    if (!(await saveText())) return;
    if (idRef.current === id) onClose(); // enquanto gravava, outro card foi aberto: esse fica
  };
  useSurface(ref, { onClose: () => void requestClose(), outside: true, passThrough: true });

  if (!d.data) return <aside ref={ref} className={`drawer ${over ? 'drawer--over' : ''}`} role="dialog" aria-label="Carregando a tarefa"><Loading error={d.error} /></aside>;
  const t = d.data.task;
  const editable = mode === 'user';
  const nameOf = (id: string | null) => agents.find((a) => a.id === id)?.name ?? null;
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try { const r = await api.patch<{ revision: number }>(`/api/tasks/${t.id}`, { ...body, expectedRevision: rev.current || t.revision }); rev.current = r.revision; d.reload(); }
    catch (e) { setErr(errMsg(e)); d.reload(); }
  };
  const act = async (fn: () => Promise<string | null>) => {
    setErr(null); setOk(null); setBusyAct(true);
    try { const m = await fn(); if (m) setOk(m); d.reload(); } catch (e) { setErr(errMsg(e)); d.reload(); } finally { setBusyAct(false); }
  };
  const respond = (action: 'answer' | 'approve' | 'return' | 'retry', text: string | null = null) => act(async () => {
    const r = await api.post<{ result: string; runId: string | null }>(`/api/tasks/${t.id}/respond`, text !== null ? { action, text } : { action });
    setBack(null); setAnswer('');
    return action === 'answer' ? `Resposta enviada: ${nameOf(t.agent_id) ?? 'o agente'} continua.` : r.result;
  });
  const sendToTeam = () => act(async () => {
    const r = await api.post<{ number: number; routed: string | null }>(`/api/tasks/${t.id}/send-to-team`);
    return `Enviada: card #${r.number} no Fluxos da equipe. ${r.routed ?? ''}`;
  });
  // revisão crítica: de quem tem a ferramenta de revisão hoje (qualquer nome), nunca do próprio autor
  const reviewer = reviewerOf(agents, t.agent_id);
  const askReview = () => act(async () => {
    await api.post(`/api/tasks/${t.id}/review`);
    return `${reviewer?.name ?? 'A revisão'} vai examinar o material e perguntar a ${nameOf(t.agent_id) ?? 'quem fez'}.`;
  });
  const active = d.data.runs.find((r) => ['queued', 'running', 'waiting_user'].includes(r.status));
  // parar: só o trabalho de agora (o card fica aberto para tentar de novo ou devolver); cancelar: o card sai do quadro
  const stop = (runId: string) => act(async () => {
    await api.post(`/api/runs/${runId}/cancel`);
    return `${nameOf(t.agent_id) ?? 'O agente'} vai parar. O card fica aberto: dá para tentar de novo ou devolver com uma instrução.`;
  });
  const cancel = () => act(async () => { await api.post(`/api/tasks/${t.id}/cancel`); setConfirmCancel(false); onClose(); return null; });
  // fila da equipe: Prioridade (topo) e subir/descer — o mesmo que arrastar no quadro, sem precisar arrastar
  const pri = !!t.priority;
  const arrange = (body: { priority?: boolean; move?: 'up' | 'down' }) => act(async () => {
    const r = await api.post<{ priority: boolean; position: number | null }>(`/api/tasks/${t.id}/queue`, body);
    return body.priority ? `Prioridade: topo da fila${r.position ? ` (${r.position}º)` : ''}.` : body.priority === false ? 'Sem prioridade: o card fica onde está.' : r.position ? `Agora é o ${r.position}º da fila.` : null;
  });
  const work = d.data.work;
  const disp = work ? displayOf(work.state) : null;
  const need: Need | null = !work || t.completed || active ? null
    : work.state === 'aguardando_info' ? 'info' : work.state === 'aguardando_aprovacao' ? 'approval' : work.state === 'revisao' ? 'review' : work.state === 'falha' ? 'retry' : null;
  const external = work?.result?.state === 'sem_confirmacao';
  const origin = d.data.origin;
  const column = d.data.column ?? columns?.find((c) => c.id === t.column_id)?.name;
  // confirmação de cancelar/apagar, logo abaixo dos botões: diz o que para, o que vai junto e quem fica sabendo
  const children = d.data.children ?? [];
  const confirmBox = confirmCancel && (
    <div className="ask-box ask-box--danger" role="group" aria-label="Confirmar">
      <p className="ask-box__q">
        <b>{editable ? 'Apagar esta tarefa?' : t.completed ? `Tirar o card #${t.number} do quadro?` : `Cancelar o card #${t.number}?`}</b>{' '}
        {active ? `${nameOf(t.agent_id) ?? 'O agente'} para agora. ` : ''}Sai do quadro; o histórico fica em Atividade.
        {children.length > 0 && ` Vai junto o que nasceu dele: ${children.map((c) => `#${c.number} ${c.title}`).join('; ')}.`}
        {origin && !origin.delivered && !t.completed && ' A conversa de onde o pedido veio fica sabendo que não haverá entrega.'}
      </p>
      <div className="row">
        <button className="btn btn--sm btn--danger" disabled={busyAct} onClick={() => void cancel()}>
          <Icon name="trash" size={13} /> {editable ? 'Apagar' : t.completed ? 'Tirar do quadro' : 'Cancelar a tarefa'}
        </button>
        <button className="btn btn--sm" onClick={() => setConfirmCancel(false)}>Voltar</button>
      </div>
    </div>
  );

  return (
    <aside ref={ref} className={`drawer task-panel ${over ? 'drawer--over' : ''}`} role="dialog" aria-labelledby={`task-title-${t.id}`}>
      <header className="drawer__head">
        <span className="muted" id={`task-title-${t.id}`}>Tarefa #{t.number}</span>
        <span className="badge">{mode === 'mirror' ? (SOURCE_LABEL[source ?? ''] ?? 'espelho') : ORIGIN_LABEL[t.origin] ?? t.origin}</span>
        <span className="drawer__saved" role="status">{savedNow ? <><Icon name="check" size={12} /> Salvo</> : ''}</span>
        <button className="icon-btn" onClick={() => void requestClose()} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
      </header>
      {editable ? (
        <>
          <label className="field">Título<input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void saveText()} maxLength={200} /></label>
          <label className="field">Descrição<textarea value={desc} rows={4} onChange={(e) => setDesc(e.target.value)} onBlur={() => void saveText()} /></label>
          <div className="row">
            <label className="check"><input type="checkbox" checked={!!t.completed} onChange={(e) => patch({ completed: e.target.checked })} /> Concluída</label>
            <label className="field field--inline">Coluna
              <select value={t.column_id} onChange={(e) => patch({ columnId: e.target.value })}>{(columns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            <label className="field field--inline">Prazo
              <input type="date" value={t.due_on ?? ''} onChange={(e) => patch({ dueOn: e.target.value || null })} />
              {t.due_on && <button type="button" className="linkish" onClick={() => patch({ dueOn: null })}>tirar</button>}
            </label>
          </div>
          <TaskFiles taskId={t.id} inputs={d.data.files.inputs} deliverables={d.data.files.deliverables} canAttach onChanged={d.reload}
            hint="Uma planilha (CSV) anexada aqui vai junto quando você envia à equipe: quem cuida de dados analisa e entrega relatório e indicadores." />
          <section className="block">
            <h4>Pedir à equipe</h4>
            <p className="hint">Vira um card no Fluxos da equipe; a coordenação encaminha a quem faz. Esta tarefa continua sua.</p>
            <button className="btn" onClick={() => void sendToTeam()}><Icon name="users" size={14} /> Enviar à equipe</button>
          </section>
          <ActionBar>
            <IconAction icon="trash" danger label="Apagar a tarefa (sai do quadro; o histórico fica)" pressed={confirmCancel} disabled={busyAct} onClick={() => setConfirmCancel((v) => !v)} />
          </ActionBar>
          {confirmBox}
        </>
      ) : (
        <>
          <h3 className="drawer__title">{t.title}</h3>
          {/* card com plano: as etapas aparecem logo abaixo, em ordem; a descrição fica só com o pedido */}
          {t.description && <p className="pre drawer__desc">{d.data.steps.length ? t.description.split('\n\nPlano:\n')[0] : t.description}</p>}
          <div className="kv">
            <span>Situação</span><b>{t.completed ? `concluída${t.completed_by === 'agent' ? ' pelo agente' : t.completed_by === 'external' ? ' no aplicativo' : ''}` : d.data.queue ? `na fila (${d.data.queue.position}º de ${d.data.queue.total})` : column ?? '—'}</b>
            {mode === 'team' && <><span>Com quem está</span><b>{nameOf(t.agent_id) ?? 'na triagem da coordenação'}{active ? ` · ${RUN_STATUS[active.status]}` : ''}</b></>}
            {mode === 'mirror' && <><span>Atribuída a</span><b>{t.external_assignee ?? '—'}</b></>}
            <span>Prazo</span><b>{t.due_on ? <DueChip due={t.due_on} done={!!t.completed} /> : '—'}</b>
            {disp && <><span>Estado</span><b><span className={`badge ${DISPLAY_BADGE[disp]}`}>{DISPLAY_LABEL[disp]}</span></b></>}
          </div>
          {origin && (
            <p className="task-origin">
              <Icon name="chat" size={13} /> Pedido na conversa com <b>{nameOf(origin.agentId) ?? 'um agente'}</b>
              {origin.delivered ? ' · entregue lá' : ` · ${nameOf(origin.deliverAgentId) ?? 'quem recebeu'} entrega lá`}
              {origin.conversationId && <> · <button type="button" className="linkish" onClick={() => openConversation(origin.agentId, origin.conversationId)}>abrir a conversa</button></>}
            </p>
          )}
          {mode === 'mirror' && <p className="hint">Espelho: título, descrição, situação e responsável vêm de {SOURCE_LABEL[source ?? ''] ?? 'lá'}. Mude no aplicativo de origem; o Ergon atualiza sozinho.</p>}

          {mode === 'team' && need === 'info' && (
            <form className="ask-box" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) void respond('answer', answer.trim()); }}>
              <p className="ask-box__q">{d.data.question ? <><b>{nameOf(t.agent_id) ?? 'O agente'} pergunta:</b> {d.data.question}</> : <><b>Falta algo seu:</b> {d.data.missing ?? 'uma informação.'}</>}</p>
              <textarea data-autofocus value={answer} rows={2} maxLength={1500} onChange={(e) => setAnswer(e.target.value)} placeholder="Sua resposta (vai para o agente, e o card volta a andar)"
                aria-label="Sua resposta" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (answer.trim()) void respond('answer', answer.trim()); } }} />
              <div className="row"><button className="btn btn--sm btn--primary" disabled={busyAct || !answer.trim()}><Icon name="send" size={13} /> Responder</button></div>
            </form>
          )}
          {mode === 'team' && (need === 'approval' || need === 'review') && (
            <p className="ask-box ask-box--line">
              {need === 'approval' ? (external ? 'Preparado: é algo a fazer fora do Ergon. Confirme quando estiver feito.' : 'Pronto do lado da equipe: falta a sua aprovação.')
                : `Não passou na conferência: ${work?.result?.justification ?? ''} Aprove assim mesmo ou devolva com uma instrução.`}
            </p>
          )}

          {d.data.steps.length > 0 && (
            <section className="block steps" aria-label="Etapas do plano">
              <h4>Etapas</h4>
              <ol className="steps__list">
                {d.data.steps.map((s) => (
                  <li key={s.position} className={`step step--${s.status}`}>
                    <span className="step__icon" aria-hidden="true"><Icon name={STEP_ICON[s.status]} size={13} /></span>
                    <span><b>{nameOf(s.agentId) ?? 'Agente'}</b> — {s.title}{s.status === 'em_andamento' ? <span className="muted"> (agora)</span> : null}</span>
                  </li>
                ))}
                {origin && (
                  <li className={`step ${origin.delivered ? 'step--feita' : 'step--pendente'}`}>
                    <span className="step__icon" aria-hidden="true"><Icon name={origin.delivered ? 'check' : 'chat'} size={13} /></span>
                    <span><b>{nameOf(origin.deliverAgentId) ?? 'A coordenação'}</b> — entregar na conversa</span>
                  </li>
                )}
              </ol>
            </section>
          )}

          {mode === 'team' && (
            <ActionBar>
              {work && !t.completed && <>
              {active && <IconAction icon="stop" label="Parar agora (o card fica aberto: dá para tentar de novo ou devolver)" disabled={busyAct} onClick={() => void stop(active.id)} />}
              {!active && <IconAction icon="play" primary={need === 'retry' || disp === 'fila'} label={need === 'retry' ? 'Tentar de novo' : 'Pôr para trabalhar agora'} disabled={busyAct}
                onClick={() => void act(async () => {
                  const x = await api.post<{ runId: string | null; mode: string; stopped: { state: string; justification: string } | null }>(`/api/tasks/${t.id}/work`);
                  if (x.stopped) throw new Error(x.stopped.justification);
                  return `${nameOf(t.agent_id) ?? 'O agente'} começou${x.mode === 'simulated' ? ' (modo simulado: sem modelo de IA, respostas de texto não contam como trabalho feito)' : ''}.`;
                })} />}
              {(need === 'approval' || need === 'review' || need === 'info') && (
                <IconAction icon="check" primary={need === 'approval'} label={external ? 'Confirmar que foi feito' : 'Aprovar e concluir'} disabled={busyAct} onClick={() => void respond('approve')} />
              )}
              <IconAction icon="undo" label={active ? 'Devolver com instrução (espere o agente terminar)' : 'Devolver com instrução'} pressed={back !== null} disabled={!!active || busyAct}
                onClick={() => setBack((v) => (v === null ? '' : null))} />
              <IconAction icon="shield-check" label={work.requiresApproval ? 'Exige a sua aprovação para concluir (clique para tirar)' : 'Exigir a minha aprovação antes de concluir'}
                pressed={work.requiresApproval} disabled={busyAct}
                onClick={() => void act(async () => { await api.put(`/api/tasks/${t.id}/approval`, { required: !work.requiresApproval }); return null; })} />
              {onAskCoordinator && <IconAction icon="chat" label="Falar com a coordenação sobre este card" onClick={() => onAskCoordinator(`Sobre o card #${t.number}: `)} />}
              {t.agent_id && d.data.review?.status !== 'open' && (
                <IconAction icon="eye" label={reviewer ? `Pedir revisão crítica a ${reviewer.name}` : 'Pedir revisão crítica (ninguém tem a ferramenta agora)'} disabled={busyAct} onClick={() => void askReview()} />
              )}
              {d.data.queue && <>
                <span className="iact-bar__sep" aria-hidden="true" />
                <IconAction icon="flag" label={pri ? 'Tirar a prioridade (o card fica onde está)' : 'Prioridade: leva o card ao topo da fila'} pressed={pri} onClick={() => void arrange({ priority: !pri })} />
                <IconAction icon="chevron-up" label="Subir na fila" disabled={d.data.queue.position === 1} onClick={() => void arrange({ move: 'up' })} />
                <IconAction icon="chevron" label="Descer na fila" disabled={d.data.queue.position === d.data.queue.total} onClick={() => void arrange({ move: 'down' })} />
              </>}
              <span className="iact-bar__sep" aria-hidden="true" />
              </>}
              <IconAction icon="trash" danger pressed={confirmCancel} disabled={busyAct} onClick={() => setConfirmCancel((v) => !v)}
                label={t.completed ? 'Tirar do quadro (o histórico fica)' : 'Cancelar a tarefa (o trabalho para e o card sai do quadro)'} />
            </ActionBar>
          )}
          {mode === 'team' && confirmBox}
          {back !== null && (
            <form className="ask-box" onSubmit={(e) => { e.preventDefault(); if (back.trim().length >= 3) void respond('return', back.trim()); }}>
              <label className="field">O que precisa mudar (vai para o agente; vale também para dizer que ele não precisa do que pediu)
                <textarea data-autofocus rows={3} value={back} maxLength={1500} onChange={(e) => setBack(e.target.value)} placeholder="Ex.: siga sem essa informação, use os dados do quadro" />
              </label>
              <div className="row"><button className="btn btn--sm" disabled={busyAct || back.trim().length < 3}><Icon name="undo" size={13} /> Devolver</button></div>
            </form>
          )}
          {mode === 'team' && (
            <TaskFiles taskId={t.id} inputs={d.data.files.inputs} deliverables={d.data.files.deliverables} canAttach={!t.completed} onChanged={d.reload} />
          )}
        </>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {ok && <p className="ok" role="status">{ok}</p>}
      {d.data.link?.conflict && <p className="warn">{d.data.link.conflict}</p>}

      {mode === 'team' && (
        <TechDetails work={work} queue={d.data.queue} extra={<>
          {d.data.source && <p className="muted small">De onde veio: {d.data.source.platform} · {new Date(d.data.source.received_at).toLocaleString('pt-BR')}{d.data.source.text_excerpt ? ` — “${d.data.source.text_excerpt}”` : ''}</p>}
          {d.data.review && <p className="muted small">Revisão crítica: {d.data.review.reviewer_name} → {d.data.review.producer_name} · rodada {d.data.review.round} de {d.data.review.max_rounds} · {REVIEW_STATUS[d.data.review.status]}</p>}
          {origin?.purpose && <p className="muted small">Pedido original: “{origin.purpose}”</p>}
        </>} />
      )}
      {mode !== 'team' && d.data.source && (
        <section className="block">
          <h4>De onde veio</h4>
          <p className="muted">{d.data.source.platform} · {new Date(d.data.source.received_at).toLocaleString('pt-BR')}</p>
          {d.data.source.text_excerpt && <blockquote>{d.data.source.text_excerpt}</blockquote>}
        </section>
      )}

      <details className="block log-block">
        <summary>{mode === 'team' ? 'Histórico (repasses e resultados)' : 'Histórico'} <span className="muted">({d.data.log.length})</span></summary>
        <ol className="log">
          {d.data.log.map((e) => {
            let ev: Record<string, unknown> = {};
            try { ev = e.evidence ? JSON.parse(e.evidence) : {}; } catch { ev = {}; }
            const who = e.actor_type === 'agent' && nameOf(e.actor_id) ? nameOf(e.actor_id) : e.actor_type === 'user' ? 'você' : e.actor_type === 'connector' ? 'integração' : 'sistema';
            return (
              <li key={e.id}>
                <time>{new Date(e.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</time>
                <strong>{typeof ev.reviewStep === 'string' && ev.reviewStep ? (ev.reviewStep === 'questions' ? `${nameOf(e.actor_id) ?? d.data?.review?.reviewer_name ?? 'A revisão'} perguntou` : `${nameOf(e.actor_id) ?? 'O autor'} respondeu`) : (ACTION_LABEL[e.action] ?? e.action)}</strong>{' '}
                <span className="muted">({who})</span>
                {SHOW_RESULT.includes(e.action) && <div className="muted">{e.result}</div>}
                {typeof ev.request === 'string' && <div className="log__out">{ev.request}</div>}
                {typeof ev.output === 'string' && <div className="log__out">{stripControl(ev.output)}</div>}
                {typeof ev.error === 'string' && ev.error && <div className="error">{ev.error}</div>}
              </li>
            );
          })}
        </ol>
      </details>
    </aside>
  );
}
