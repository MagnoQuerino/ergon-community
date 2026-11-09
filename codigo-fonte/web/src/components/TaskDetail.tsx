import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { ORIGIN_LABEL, SOURCE_LABEL, type Column, type Need } from '../lib/types.ts';
import { linhaDoHistorico, tomDe, type LogRow } from '../lib/tarefa-tela.ts';
import { DICA_NOME_PROVISORIO, motivoDaFalha } from '../lib/textos-tela.ts';
import { gravarNome } from '../lib/titulo-card.ts';
import { Loading } from '../brand/Brand.tsx';
import { Icon } from './Icon.tsx';
import { DueChip } from './Board.tsx';
import { TextoLongo } from './TextoLongo.tsx';
import { BotoesPrazo, type Prazo } from './CartaoRegra.tsx';
import { ActionBar, IconAction, TaskFiles, TechDetails, type TaskFile, type WorkInfo } from './TaskWork.tsx';

interface Step { position: number; agentId: string; title: string; short?: string; status: 'pendente' | 'em_andamento' | 'feita' | 'falhou'; doneAt: string | null }
/** o que a pessoa vê de cara (server/src/services/resumo-tarefa.ts): a situação e a frase exata do que decide */
interface Resumo { situacao: { tom: string; texto: string }; faixa: { titulo: string; frase: string; itens: string[]; doAgente: string | null } }
interface Detail {
  task: { id: string; number: number; title: string; title_source?: 'pessoa' | 'equipe' | 'provisorio' | null; description: string; completed: number; completed_by: string | null; completed_at: string | null; column_id: string; agent_id: string | null; origin: string; is_fixture: number; revision: number; board_id: string; external_assignee: string | null; parent_task_id: string | null; due_on: string | null; priority?: number };
  log: LogRow[];
  /** motivo do último envio ao aplicativo que falhou */
  envio?: string | null;
  link: { external_id: string; external_version: string; external_extra: string; sync_state: string; conflict: string | null; last_seen_at: string } | null;
  proposals: Array<{ id: string; related_number: number; related_title: string; reason: string; score: number; status: string }>;
  source: { platform: string; is_fixture: number; received_at: string; status: string; text_excerpt: string | null } | null;
  runs: Array<{ id: string; agent_id: string; status: string; mode: string; created_at: string }>;
  review: { id: string; status: 'open' | 'approved' | 'limit' | 'stopped'; round: number; max_rounds: number; reviewer_name: string; producer_name: string; finished_at: string | null } | null;
  files: { inputs: TaskFile[]; deliverables: TaskFile[] };
  work: WorkInfo | null;
  resumo?: Resumo | null;
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
  /** nome e cor de todo agente citado no card (responsável, etapas, origem, execuções, histórico), desativados incluídos */
  agents?: Record<string, { name: string; color: string }>;
  /** quem faria a revisão crítica deste card: a mesma escolha do servidor que começa a revisão (nunca o próprio autor) */
  reviewer?: { id: string; name: string } | null;
  /** ações numa conta pedidas neste card, esperando o seu clique */
  conexoes?: Array<{ id: string; kind?: string; summary: string; created_at: string }>;
}

const REVIEW_STATUS: Record<string, string> = {
  open: 'em andamento', approved: 'entrega razoável', limit: 'limite de rodadas: ainda há pontos', stopped: 'interrompida',
};
const STEP_ICON: Record<Step['status'], string> = { feita: 'check', em_andamento: 'play', pendente: 'clock', falhou: 'alert' };
/** a leitura marcou no vínculo que a descrição do aplicativo passa do que o card guarda (ver server/src/services/mirror.ts) */
const marcaDeCorte = (extra: string | undefined): boolean => !!extra && (JSON.parse(extra) as { descricao_cortada?: boolean }).descricao_cortada === true;

/** Item do menu "⋯". */
interface MenuItem { icon: string; label: string; onClick: () => void; danger?: boolean; on?: boolean; sep?: boolean }
/** Menu "⋯" da tarefa: o que não é a decisão de agora (executar de novo, revisar, abrir a conversa, excluir…). */
function MaisAcoes({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', close);
    ref.current?.addEventListener('keydown', esc);
    const el = ref.current;
    return () => { window.removeEventListener('mousedown', close); el?.removeEventListener('keydown', esc); };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className="tdet__menu" ref={ref} data-esc-own={open ? '' : undefined}>
      <button type="button" className="icon-btn tdet__more" onClick={() => setOpen((o) => !o)} aria-label="Mais ações" title="Mais ações" aria-expanded={open} aria-haspopup="menu"><Icon name="dots" /></button>
      {open && (
        <div className="tdet__menulist" role="menu">
          {items.map((it, i) => (
            <button key={i} type="button" role={it.on === undefined ? 'menuitem' : 'menuitemcheckbox'} className={`${it.danger ? 'is-danger' : ''} ${it.sep ? 'has-sep' : ''}`} aria-checked={it.on === undefined ? undefined : it.on}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <Icon name={it.icon} size={14} /> <span>{it.label}</span>{it.on ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Uma linha do histórico: curta de cara; a resposta inteira do agente só com "ver mais". */
function LinhaLog({ e, nomeDe, revisor }: { e: LogRow; nomeDe: (id: string | null) => string | null; revisor: string | null }) {
  const [aberta, setAberta] = useState(false);
  const l = linhaDoHistorico(e, nomeDe, revisor);
  const mais = !!(l.detalhe || l.saida || l.erro);
  return (
    <li className="tlog__item">
      <div className="tlog__row">
        <time>{new Date(e.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</time>
        <span className="tlog__t">{l.titulo}{l.quem && <span className="muted"> · {l.quem}</span>}</span>
        {mais && <button type="button" className="linkish tlog__more" aria-expanded={aberta} onClick={() => setAberta((v) => !v)}>{aberta ? 'ver menos' : 'ver mais'}</button>}
      </div>
      {!aberta && l.resumo && <div className="muted small tlog__resumo">{l.resumo}</div>}
      {aberta && (
        <div className="tlog__open">
          {l.detalhe && <div className="muted pre">{l.detalhe}</div>}
          {l.saida && <div className="log__out">{l.saida}</div>}
          {l.erro && <div className="error">{l.erro}</div>}
        </div>
      )}
    </li>
  );
}

/** Uma etapa numa linha ("Aspásia — verificar as redes"); o texto inteiro ao passar o mouse ou abrir. */
function LinhaEtapa({ s, nome }: { s: Step; nome: string }) {
  const [aberta, setAberta] = useState(false);
  const curta = s.short ?? s.title;
  const longa = curta !== s.title;
  return (
    <li className={`step step--${s.status}`} title={longa ? s.title : undefined}>
      <span className="step__icon" aria-hidden="true"><Icon name={STEP_ICON[s.status]} size={13} /></span>
      <span className="step__txt">
        <b>{nome}</b> — {aberta ? s.title : curta}{s.status === 'em_andamento' ? <span className="muted"> (agora)</span> : null}
        {longa && <> <button type="button" className="linkish small" aria-expanded={aberta} onClick={() => setAberta((v) => !v)}>{aberta ? 'menos' : 'mais'}</button></>}
      </span>
    </li>
  );
}

/** O pedido (a descrição do card), recolhido em 3 linhas: quem quer ler tudo abre. */
function Pedido({ texto }: { texto: string }) {
  const [aberto, setAberto] = useState(false);
  const longo = texto.length > 220 || texto.split('\n').length > 3;
  return (
    <section className="block tdet__pedido">
      <h4>O pedido</h4>
      <p className={`pre drawer__desc ${!aberto && longo ? 'tdet__clamp' : ''}`}>{texto}</p>
      {longo && <button type="button" className="linkish small" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>{aberto ? 'recolher' : 'ver o pedido inteiro'}</button>}
    </section>
  );
}

/**
 * Detalhe do card. 'team': quadro da equipe — de cima para baixo, o que importa para decidir de relance: título e
 * número; a situação em uma palavra, com cor; a FAIXA DE DECISÃO com a frase exata do que se aprova (ou do que foi
 * feito), pelos fatos que o sistema registrou; os botões grandes (Aprovar, Pedir ajuste), e o resto no menu "⋯"; as
 * etapas numa linha cada; os arquivos com "Ver"; o histórico e "Como foi conferido" recolhidos no fim.
 * 'user': suas tarefas locais — edita e envia à equipe. 'mirror': ligada a um aplicativo — o que muda aqui reflete lá.
 */
/** over: aberto por cima de qualquer tela (de uma conversa, de "aguardando você"): fica acima das janelas */
export function TaskDetail({ taskId, columns: askedColumns, mode: asked, source: askedSource, onClose, onAskCoordinator, over }: {
  taskId: string; columns?: Column[]; mode: 'team' | 'user' | 'mirror' | 'auto'; source?: string | null;
  onClose: () => void; onAskCoordinator?: (text: string) => void; over?: boolean;
}) {
  const d = useResource<Detail>(`/api/tasks/${taskId}`, ['tasks.changed', 'runs.changed', 'proposals.changed']);
  // 'auto': aberto de fora do quadro ("aguardando você", uma conversa) — o modo vem do quadro do card
  const b = d.data?.board;
  const mode: 'team' | 'user' | 'mirror' = asked !== 'auto' ? asked : b?.origin === 'mirror' ? 'mirror' : b?.audience === 'user' ? 'user' : 'team';
  const source = askedSource ?? b?.source ?? null;
  // suas tarefas abertas de fora do quadro: as colunas vêm do quadro delas
  const own = useResource<{ columns: Column[] }>(asked === 'auto' && mode === 'user' && d.data ? `/api/boards/${d.data.task.board_id}` : null, []);
  const columns = askedColumns ?? own.data?.columns;
  // descrição maior do que o card guarda: o resto está no aplicativo, e editar aqui o apagaria lá. Fica só para ler
  const cortada = mode === 'mirror' && !!d.data && (d.data.task.description.length >= 8000 || marcaDeCorte(d.data.link?.external_extra));
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [naming, setNaming] = useState<string | null>(null); // card da equipe: "Dar outro nome" aberto (o texto)
  // "Pedir ajuste": devolver com instrução (card aberto) ou revisar (card concluído reabre numa nova rodada)
  const [ajuste, setAjuste] = useState<{ modo: 'return' | 'revise'; texto: string } | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // o clique em andamento (o botão diz o que está indo; nada fica cinza esperando)
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
  useEffect(() => { setOk(null); setErr(null); setAjuste(null); setAnswer(''); setConfirmCancel(false); setNaming(null); rev.current = 0; }, [taskId]);

  /** Grava título e descrição se mudaram (em fila). false = não gravou: o erro fica à vista e o card, aberto. */
  const saveText = (): Promise<boolean> => {
    const id = taskId; const want = { title, desc };
    const run = async (): Promise<boolean> => {
      const body: Record<string, unknown> = {};
      if (want.title !== saved.current.title && want.title.trim()) body.title = want.title;
      if (want.desc !== saved.current.desc && !cortada) body.description = want.desc;
      if (!Object.keys(body).length || (mode !== 'user' && mode !== 'mirror')) return true;
      setErr(null);
      try {
        const r = await api.patch<{ revision: number }>(`/api/tasks/${id}`, { ...body, expectedRevision: rev.current });
        rev.current = r.revision; saved.current = { title: want.title, desc: want.desc }; d.reload(); if (idRef.current === id) setSavedNow(true); return true;
      } catch (e) {
        // a leitura achou a descrição maior do que cabe aqui depois que o card abriu: fica a de antes, e o título grava sozinho
        if (e instanceof ApiError && e.code === 'descricao_longa') {
          want.desc = saved.current.desc; if (idRef.current === id) setDesc(saved.current.desc);
          const foi = await run(); d.reload(); return foi;
        }
        setErr(`Não gravei a alteração: ${errMsg(e)}`); d.reload(); return false;
      }
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
  const data = d.data;
  const t = data.task;
  // ligada a um aplicativo: o que você muda aqui vai para lá
  const editable = mode === 'user' || mode === 'mirror';
  // os nomes vêm com o card (só os citados nele), não da equipe inteira
  const names = data.agents ?? {};
  const nameOf = (id: string | null) => (id ? names[id]?.name ?? null : null);
  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setErr(null);
    try { const r = await api.patch<{ revision: number }>(`/api/tasks/${t.id}`, { ...body, expectedRevision: rev.current || t.revision }); rev.current = r.revision; d.reload(); return true; }
    catch (e) { setErr(errMsg(e)); d.reload(); return false; }
  };
  // o nome que você der ao card da equipe fica: a coordenação não troca mais sozinha. Só fecha o campo e diz "Salvo"
  // quando gravou; falhou, o que você digitou continua ali (lib/titulo-card.ts)
  const rename = async () => {
    const id = t.id;
    setErr(null);
    const g = await gravarNome((corpo) => api.patch<{ revision: number }>(`/api/tasks/${id}`, corpo), naming, t.title);
    if (idRef.current !== id) return;
    if (!g.fechar) { setErr(`Não gravei o nome: ${errMsg(g.erro)}`); return; }
    if (g.revision !== undefined) rev.current = g.revision;
    setNaming(null);
    if (g.salvo) { setSavedNow(true); d.reload(); }
  };
  /** Um clique por vez: o segundo clique enquanto o primeiro vai é ignorado (o botão diz "Aprovando…", não fica cinza). */
  const act = async (what: string, fn: () => Promise<string | null>) => {
    if (busy) return;
    setErr(null); setOk(null); setBusy(what);
    try { const m = await fn(); if (m) setOk(m); d.reload(); } catch (e) { setErr(errMsg(e)); d.reload(); } finally { setBusy(null); }
  };
  const conexoes = data.conexoes ?? [];
  // o "Aprovar" grande decide as ações nas contas que a tela mostra (todas de uma vez); a proteção "depois de ler"
  // (abrir um site, rodar um programa) é uma decisão à parte, uma a uma — só vira o botão grande quando é a única
  const contas = conexoes.filter((c) => c.kind !== 'depois_de_ler');
  const lote = contas.length ? contas : conexoes.length === 1 ? conexoes : [];
  // cartão de ação numa conta: um, ou todos de uma vez ("Aprovar" decide o que a faixa diz); já decidido noutro lugar: só relê
  // prazo: o cartão de aprovação depois de ler as contas (1 h, 8 h, 72 h, sempre)
  const decidir = (id: string, decision: 'apply' | 'reject', prazo?: Prazo) => act(`${decision}:${id}`, async () => {
    try {
      const r = await api.post<{ status: string; result: string }>(`/api/proposals/${id}`, { decision, ...(prazo ? { prazo } : {}) });
      if (decision === 'apply' && r.status === 'failed') throw new Error(r.result);
      return decision === 'apply' ? r.result : 'Recusado: a equipe fica sabendo.';
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'decided') return null;
      throw e;
    }
  });
  const decidirTodos = (decision: 'apply' | 'reject') => {
    if (lote.length === 1) return decidir(lote[0].id, decision);
    return act(decision, async () => {
      try {
        // só o que a tela mostrou: chegou outro pedido depois, o servidor não decide nada e a tela relê (409 'mudou')
        const r = await api.post<{ results: Array<{ status: string; result: string }> }>(`/api/tasks/${t.id}/cartoes`, { decision, ids: lote.map((c) => c.id) });
        const falhas = r.results.filter((x) => x.status === 'failed');
        if (decision === 'apply' && falhas.length) throw new Error(falhas.map((x) => x.result).join(' · '));
        return decision === 'apply' ? `Aprovado (${r.results.length}). A equipe continua.` : 'Recusado: a equipe fica sabendo.';
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === 'decided') return null;
        throw e;
      }
    });
  };
  const respond = (action: 'answer' | 'approve' | 'return' | 'retry', text: string | null = null) => act(action, async () => {
    const r = await api.post<{ result: string; runId: string | null }>(`/api/tasks/${t.id}/respond`, text !== null ? { action, text } : { action });
    setAjuste(null); setAnswer('');
    return action === 'answer' ? `Resposta enviada: ${nameOf(t.agent_id) ?? 'o agente'} continua.` : r.result;
  });
  const revisar = (text: string) => act('revise', async () => {
    const r = await api.post<{ result: string }>(`/api/tasks/${t.id}/revise`, { text });
    setAjuste(null);
    return r.result || 'O card voltou para a equipe com o que você quer mudar.';
  });
  const sendToTeam = () => act('team', async () => {
    const r = await api.post<{ number: number; routed: string | null }>(`/api/tasks/${t.id}/send-to-team`);
    return `Enviada: card #${r.number} no Fluxos da equipe. ${r.routed ?? ''}`;
  });
  // revisão crítica: de quem tem a ferramenta de revisão hoje (qualquer nome), nunca do próprio autor — o nome é o de
  // quem o servidor de fato chama ao começar a revisão
  const reviewer = data.reviewer ?? null;
  const askReview = () => act('review', async () => {
    await api.post(`/api/tasks/${t.id}/review`);
    return `${reviewer?.name ?? 'A revisão'} vai examinar o material e perguntar a ${nameOf(t.agent_id) ?? 'quem fez'}.`;
  });
  const active = data.runs.find((r) => ['queued', 'running', 'waiting_user'].includes(r.status));
  // parar: só o trabalho de agora (o card fica aberto para tentar de novo ou devolver); cancelar: o card sai do quadro
  const stop = (runId: string) => act('stop', async () => {
    await api.post(`/api/runs/${runId}/cancel`);
    return `${nameOf(t.agent_id) ?? 'O agente'} vai parar. O card fica aberto: dá para tentar de novo ou pedir um ajuste.`;
  });
  const cancel = () => act('cancel', async () => { await api.post(`/api/tasks/${t.id}/cancel`); setConfirmCancel(false); onClose(); return null; });
  const work = data.work;
  const startWork = () => act('work', async () => {
    const x = await api.post<{ runId: string | null; mode: string; stopped: { state: string; justification: string } | null }>(`/api/tasks/${t.id}/work`);
    if (x.stopped) throw new Error(x.stopped.justification);
    return `${nameOf(t.agent_id) ?? 'O agente'} começou.`;
  });
  // fila da equipe: Prioridade (topo) e subir/descer — o mesmo que arrastar no quadro, sem precisar arrastar
  const pri = !!t.priority;
  const arrange = (body: { priority?: boolean; move?: 'up' | 'down' }) => act('queue', async () => {
    const r = await api.post<{ priority: boolean; position: number | null }>(`/api/tasks/${t.id}/queue`, body);
    return body.priority ? `Prioridade: topo da fila${r.position ? ` (${r.position}º)` : ''}.` : body.priority === false ? 'Sem prioridade: o card fica onde está.' : r.position ? `Agora é o ${r.position}º da fila.` : null;
  });
  // esperando o clique numa ação de conta: a decisão é o cartão dela, não aprovar o card
  const need: Need | null = !work || t.completed || active || conexoes.length ? null
    : work.state === 'aguardando_info' ? 'info' : work.state === 'aguardando_aprovacao' ? 'approval' : work.state === 'revisao' ? 'review' : work.state === 'falha' ? 'retry' : null;
  const external = work?.result?.state === 'sem_confirmacao';
  const origin = data.origin;
  const column = data.column ?? columns?.find((c) => c.id === t.column_id)?.name;
  const children = data.children ?? [];
  const resumo = data.resumo ?? null;
  const tom = tomDe(resumo?.situacao.tom ?? (t.completed ? 'feito' : 'fila'));
  const indo = (what: string, label: string, doing: string) => (busy === what ? doing : label);

  // confirmação de cancelar/apagar, logo abaixo dos botões: diz o que para, o que vai junto e quem fica sabendo
  const confirmBox = confirmCancel && (
    <div className="ask-box ask-box--danger" role="group" aria-label="Confirmar">
      <p className="ask-box__q">
        <b>{editable ? 'Apagar esta tarefa?' : t.completed ? `Tirar o card #${t.number} do quadro?` : `Cancelar o card #${t.number}?`}</b>{' '}
        {active ? `${nameOf(t.agent_id) ?? 'O agente'} para agora. ` : ''}Sai do quadro; o histórico fica em Atividade.
        {children.length > 0 && ` Vai junto o que nasceu dele: ${children.map((c) => `#${c.number} ${c.title}`).join('; ')}.`}
        {origin && !origin.delivered && !t.completed && ' A conversa de onde o pedido veio fica sabendo que não haverá entrega.'}
      </p>
      <div className="row">
        <button className="btn btn--sm btn--danger" aria-busy={busy === 'cancel'} onClick={() => void cancel()}>
          <Icon name="trash" size={13} /> {indo('cancel', editable ? 'Apagar' : t.completed ? 'Tirar do quadro' : 'Cancelar a tarefa', 'Cancelando…')}
        </button>
        <button className="btn btn--sm" onClick={() => setConfirmCancel(false)}>Voltar</button>
      </div>
    </div>
  );
  // "Pedir ajuste": o que precisa mudar vai para o agente (e, num card concluído, ele reabre numa nova rodada)
  const ajusteBox = ajuste && (
    <form className="ask-box tdet__ajuste" onSubmit={(e) => {
      e.preventDefault();
      const txt = ajuste.texto.trim();
      if (txt.length < 3) { setErr('Escreva o que precisa mudar (pelo menos 3 letras).'); return; }
      void (ajuste.modo === 'revise' ? revisar(txt) : respond('return', txt));
    }}>
      <label className="field">{ajuste.modo === 'revise' ? 'O que você quer mudar (o card volta para a equipe)' : 'O que precisa mudar (vai para o agente)'}
        <textarea data-autofocus rows={3} value={ajuste.texto} onChange={(e) => setAjuste({ ...ajuste, texto: e.target.value })} placeholder="Ex.: troque o tom para mais formal; inclua o prazo de entrega" />
      </label>
      <div className="row">
        <button className="btn btn--primary" aria-busy={busy === 'return' || busy === 'revise'}><Icon name="send" size={14} /> {busy === 'return' || busy === 'revise' ? 'Enviando…' : 'Enviar o ajuste'}</button>
        <button type="button" className="btn btn--ghost" onClick={() => setAjuste(null)}>Voltar</button>
      </div>
    </form>
  );
  const pedirAjuste = (modo: 'return' | 'revise') => setAjuste((v) => (v ? null : { modo, texto: '' }));

  // os botões grandes da faixa: a decisão de agora (Aprovar, Pedir ajuste), quando cabe
  let botoes: ReactNode = null;
  if (mode === 'team' && !t.completed) {
    if (lote.length === 1 && lote[0].kind === 'depois_de_ler') {
      const c = lote[0];
      botoes = <BotoesPrazo ocupado={!!busy} onEscolher={(prazo) => void decidir(c.id, 'apply', prazo)} onRecusar={() => void decidir(c.id, 'reject')} />;
    } else if (lote.length) {
      const n = lote.length;
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'apply' || busy?.startsWith('apply:')} onClick={() => void decidirTodos('apply')}>
          <Icon name="check" size={16} /> {busy === 'apply' || busy?.startsWith('apply:') ? 'Aprovando…' : n > 1 ? `Aprovar (${n})` : 'Aprovar'}
        </button>
        <button className="btn btn--big" aria-busy={busy === 'reject' || busy?.startsWith('reject:')} onClick={() => void decidirTodos('reject')}>
          <Icon name="x" size={16} /> {busy === 'reject' || busy?.startsWith('reject:') ? 'Recusando…' : 'Recusar'}
        </button>
      </>;
    } else if (need === 'approval' || need === 'review') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'approve'} onClick={() => void respond('approve')}>
          <Icon name="check" size={16} /> {indo('approve', external ? 'Confirmar que foi feito' : need === 'review' ? 'Aprovar assim mesmo' : 'Aprovar', 'Aprovando…')}
        </button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> Pedir ajuste</button>
      </>;
    } else if (need === 'retry') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'work'} onClick={() => void startWork()}><Icon name="repeat" size={16} /> {indo('work', 'Tentar de novo', 'Começando…')}</button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> Pedir ajuste</button>
      </>;
    } else if (need === 'info') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'answer'} onClick={() => { if (answer.trim()) void respond('answer', answer.trim()); else setErr('Escreva a sua resposta.'); }}>
          <Icon name="send" size={16} /> {indo('answer', 'Responder', 'Enviando…')}
        </button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> Pedir ajuste</button>
      </>;
    } else if (!active && work && tom === 'fila') {
      botoes = <button className="btn btn--big" aria-busy={busy === 'work'} onClick={() => void startWork()}><Icon name="play" size={16} /> {indo('work', 'Começar agora', 'Começando…')}</button>;
    }
  }

  // o menu "⋯": o que não é a decisão de agora
  const menu: MenuItem[] = [];
  if (mode === 'team') {
    if (active) menu.push({ icon: 'stop', label: 'Parar agora (o card fica aberto)', onClick: () => void stop(active.id) });
    if (work && !t.completed && !active && need !== 'retry' && tom !== 'fila') menu.push({ icon: 'repeat', label: 'Executar de novo', onClick: () => void startWork() });
    if (work && !t.completed && !active && !botoes) menu.push({ icon: 'undo', label: 'Pedir ajuste (devolver com instrução)', onClick: () => pedirAjuste('return') });
    // o agente entregou e fez uma pergunta: dá para aprovar o que veio sem responder (como antes, agora no menu)
    if (need === 'info') menu.push({ icon: 'check', label: 'Aprovar assim mesmo (sem responder)', onClick: () => void respond('approve') });
    if (t.completed) menu.push({ icon: 'pen', label: 'Revisar (pedir uma mudança)', onClick: () => pedirAjuste('revise') });
    if (t.agent_id && data.review?.status !== 'open' && !t.completed) menu.push({ icon: 'eye', label: reviewer ? `Pedir revisão crítica a ${reviewer.name}` : 'Pedir revisão crítica', onClick: () => void askReview() });
    if (origin?.conversationId) menu.push({ icon: 'chat', label: `Abrir a conversa com ${nameOf(origin.agentId) ?? 'o agente'}`, onClick: () => openConversation(origin.agentId, origin.conversationId) });
    if (onAskCoordinator) menu.push({ icon: 'users', label: 'Falar com a coordenação sobre este card', onClick: () => onAskCoordinator(`Sobre o card #${t.number}: `) });
    if (work && !t.completed) menu.push({ icon: 'shield-check', label: 'Exigir a minha aprovação antes de concluir', on: work.requiresApproval,
      onClick: () => void act('approval', async () => { await api.put(`/api/tasks/${t.id}/approval`, { required: !work.requiresApproval }); return null; }) });
    if (data.queue) {
      menu.push({ icon: 'flag', label: pri ? 'Tirar a prioridade' : 'Prioridade: topo da fila', on: pri, onClick: () => void arrange({ priority: !pri }), sep: true });
      if (data.queue.position > 1) menu.push({ icon: 'chevron-up', label: 'Subir na fila', onClick: () => void arrange({ move: 'up' }) });
      if (data.queue.position < data.queue.total) menu.push({ icon: 'chevron', label: 'Descer na fila', onClick: () => void arrange({ move: 'down' }) });
    }
    menu.push({ icon: 'trash', label: t.completed ? 'Tirar do quadro' : 'Excluir (cancelar a tarefa)', danger: true, sep: true, onClick: () => setConfirmCancel(true) });
  }

  const feedback = <>
    {err && <p className="error" role="alert">{err}</p>}
    {ok && <p className="ok" role="status">{ok}</p>}
  </>;

  return (
    <aside ref={ref} className={`drawer task-panel ${over ? 'drawer--over' : ''}`} role="dialog" aria-labelledby={`task-title-${t.id}`}>
      {editable ? (
        <>
          <header className="drawer__head">
            <span className="muted" id={`task-title-${t.id}`}>Tarefa #{t.number}</span>
            <span className="badge">{mode === 'mirror' ? (SOURCE_LABEL[source ?? ''] ?? 'ligada') : ORIGIN_LABEL[t.origin] ?? t.origin}</span>
            <span className="drawer__saved" role="status">{savedNow ? <><Icon name="check" size={12} /> Salvo</> : ''}</span>
            <button className="icon-btn" onClick={() => void requestClose()} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
          </header>
          <label className="field">Título<input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void saveText()} maxLength={200} /></label>
          {cortada ? (
            <div className="field">Descrição
              <p className="pre drawer__desc">{t.description}</p>
              <p className="hint">Esta descrição é maior do que cabe aqui: edite no aplicativo.</p>
            </div>
          ) : <label className="field">Descrição<textarea value={desc} rows={4} onChange={(e) => setDesc(e.target.value)} onBlur={() => void saveText()} /></label>}
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
          {mode === 'mirror' ? (
            <>
              <div className="kv"><span>Atribuída a</span><b>{t.external_assignee ?? '—'}</b></div>
              <p className="hint">Ligada a {SOURCE_LABEL[source ?? ''] ?? 'um aplicativo'}: concluir, mudar de coluna ou editar aqui reflete lá, e o que mudar lá chega aqui. Para apagar, apague no aplicativo.</p>
            </>
          ) : (
            <>
              <TaskFiles taskId={t.id} inputs={data.files.inputs} deliverables={data.files.deliverables} canAttach onChanged={d.reload}
                hint="Uma planilha (CSV) anexada aqui vai junto quando você envia à equipe: quem cuida de dados analisa e entrega relatório e indicadores." />
              <section className="block">
                <h4>Pedir à equipe</h4>
                <p className="hint">Vira um card no Fluxos da equipe; a coordenação encaminha a quem faz. Esta tarefa continua sua.</p>
                <button className="btn" aria-busy={busy === 'team'} onClick={() => void sendToTeam()}><Icon name="users" size={14} /> {indo('team', 'Enviar à equipe', 'Enviando…')}</button>
              </section>
              <ActionBar>
                <IconAction icon="trash" danger label="Apagar a tarefa (sai do quadro; o histórico fica)" pressed={confirmCancel} onClick={() => setConfirmCancel((v) => !v)} />
              </ActionBar>
              {confirmBox}
            </>
          )}
          {feedback}
        </>
      ) : (
        <>
          {/* 1. título e número */}
          <header className="tdet__head">
            <div className="tdet__titlebox">
              <span className="tdet__num">#{t.number}</span>
              {mode === 'team' && naming !== null ? (
                <form className="row task-rename" data-esc-own onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input aria-label="Nome do card" value={naming} autoFocus maxLength={200} onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setNaming(null); } }} />
                  <button className="btn btn--sm" type="submit"><Icon name="check" size={13} /> Salvar</button>
                  <button className="btn btn--sm" type="button" onClick={() => setNaming(null)}>Voltar</button>
                </form>
              ) : (
                <h2 className="tdet__title" id={`task-title-${t.id}`}>{t.title}{mode === 'team' && (
                  <button type="button" className="icon-btn" aria-label="Dar outro nome ao card" title="Dar outro nome ao card" onClick={() => setNaming(t.title)}><Icon name="edit" size={15} /></button>
                )}</h2>
              )}
            </div>
            {mode === 'team' && naming === null && t.title_source === 'provisorio' && <p className="hint tdet__hint">{DICA_NOME_PROVISORIO}</p>}
            {mode === 'team' && <MaisAcoes items={menu} />}
            <button className="icon-btn" onClick={() => void requestClose()} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
          </header>
          {/* 2. a situação em uma palavra, com cor */}
          <div className="tdet__status">
            <span className={`tdet__sit tdet__sit--${tom}`}>{resumo?.situacao.texto ?? (t.completed ? 'Feito' : data.queue ? `Na fila (${data.queue.position}º de ${data.queue.total})` : column ?? 'Aberta')}</span>
            {t.due_on && <DueChip due={t.due_on} done={!!t.completed} />}
            {mode === 'team' && t.agent_id && <span className="muted small">com {nameOf(t.agent_id)}</span>}
          </div>
          {/* 3. a faixa de decisão: a frase exata do que se aprova (ou do que foi feito); 4. os botões grandes */}
          {resumo && (
            <section className={`tdet__faixa tdet__faixa--${tom}`} aria-label={resumo.faixa.titulo}>
              <p className="tdet__faixa-t">{resumo.faixa.titulo}</p>
              <p className="tdet__frase">{resumo.faixa.frase}</p>
              {resumo.faixa.itens.length > 0 && <ul className="tdet__itens">{resumo.faixa.itens.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {resumo.faixa.doAgente && <p className="tdet__agente">{resumo.faixa.doAgente}</p>}
              {(conexoes.length > 0 || data.files.deliverables.length > 0) && <p className="tdet__abaixo muted small">Detalhes abaixo.</p>}
              {need === 'info' && (
                <textarea className="tdet__resp" data-autofocus value={answer} rows={2} onChange={(e) => setAnswer(e.target.value)} placeholder="Sua resposta (vai para o agente, e o card volta a andar)"
                  aria-label="Sua resposta" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (answer.trim()) void respond('answer', answer.trim()); } }} />
              )}
              {botoes && <div className="tdet__acts">{botoes}</div>}
              {ajusteBox}
              {confirmBox}
              {feedback}
            </section>
          )}
          {!resumo && <>{ajusteBox}{confirmBox}{feedback}</>}
          {/* sem o resumo (servidor antigo): o motivo da falha à vista, como antes */}
          {mode === 'team' && need === 'retry' && !resumo && <p className="ask-box ask-box--line" role="status">{motivoDaFalha(work?.result?.justification)}</p>}

          {/* o que cada cartão vai fazer, inteiro (conta, destino, texto): decidir um por um também dá */}
          {conexoes.length > 0 && (
            <section className="block tdet__cartoes" aria-label="O que vai acontecer">
              <h4>O que vai acontecer{conexoes.length > 1 ? ` (${conexoes.length})` : ''}</h4>
              {conexoes.map((c) => (
                <div key={c.id} className="tdet__cartao" role="group" aria-label={c.kind === 'depois_de_ler' ? 'Esperando a sua aprovação' : 'Esperando a sua confirmação'}>
                  <p className="pre"><TextoLongo texto={c.summary} /></p>
                  {!(lote.length === 1 && lote[0].id === c.id) && (c.kind === 'depois_de_ler' ? (
                    <BotoesPrazo ocupado={!!busy} onEscolher={(prazo) => void decidir(c.id, 'apply', prazo)} onRecusar={() => void decidir(c.id, 'reject')} />
                  ) : (
                    <div className="row">
                      <button className="btn btn--sm" aria-busy={busy === `apply:${c.id}`} onClick={() => void decidir(c.id, 'apply')}>{indo(`apply:${c.id}`, 'Aprovar só este', 'Aprovando…')}</button>
                      <button className="btn btn--sm btn--ghost" aria-busy={busy === `reject:${c.id}`} onClick={() => void decidir(c.id, 'reject')}>{indo(`reject:${c.id}`, 'Recusar este', 'Recusando…')}</button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* 5. as etapas, uma linha cada */}
          {data.steps.length > 0 && (
            <section className="block steps" aria-label="Etapas">
              <h4>Etapas</h4>
              <ol className="steps__list">
                {data.steps.map((s) => <LinhaEtapa key={s.position} s={s} nome={nameOf(s.agentId) ?? 'Agente'} />)}
                {origin && (
                  <li className={`step ${origin.delivered ? 'step--feita' : 'step--pendente'}`}>
                    <span className="step__icon" aria-hidden="true"><Icon name={origin.delivered ? 'check' : 'chat'} size={13} /></span>
                    <span className="step__txt"><b>{nameOf(origin.deliverAgentId) ?? 'A coordenação'}</b> — entregar na conversa</span>
                  </li>
                )}
              </ol>
            </section>
          )}

          {/* 6. arquivos com "Ver" (abre por cima, sem sair da tarefa) */}
          {mode === 'team' && (
            <TaskFiles taskId={t.id} inputs={data.files.inputs} deliverables={data.files.deliverables} canAttach={!t.completed} onChanged={d.reload} />
          )}
          {t.description && <Pedido texto={data.steps.length ? t.description.split('\n\nPlano:\n')[0] : t.description} />}

          {!data.link?.conflict && data.envio && <p className="warn">Não foi enviado ao aplicativo: {data.envio} <button type="button" className="linkish" onClick={async () => { try { await api.post(`/api/tasks/${t.id}/reenviar`); d.reload(); } catch (e) { setErr(errMsg(e)); } }}>Tentar de novo</button></p>}
          {data.link?.conflict && <p className="warn">{data.link.conflict}{data.link.sync_state === 'escrita_falhou' && <> <button type="button" className="linkish" onClick={async () => { try { await api.post(`/api/tasks/${t.id}/reenviar`); d.reload(); } catch (e) { setErr(errMsg(e)); } }}>Tentar de novo</button></>}</p>}
        </>
      )}

      {mode !== 'team' && data.source && (
        <section className="block">
          <h4>De onde veio</h4>
          <p className="muted">{data.source.platform} · {new Date(data.source.received_at).toLocaleString('pt-BR')}</p>
          {data.source.text_excerpt && <blockquote>{data.source.text_excerpt}</blockquote>}
        </section>
      )}

      {/* 7. histórico recolhido; cada entrega também ("ver mais") */}
      <details className="block log-block">
        <summary>Histórico <span className="muted">({data.log.length})</span></summary>
        <ol className="tlog">
          {data.log.map((e) => <LinhaLog key={e.id} e={e} nomeDe={nameOf} revisor={data.review?.reviewer_name ?? null} />)}
        </ol>
      </details>

      {/* 8. como foi conferido, em linguagem simples, recolhido no fim */}
      {mode === 'team' && (
        <TechDetails work={work} queue={data.queue} extra={<>
          {data.source && <p className="muted small">De onde veio: {data.source.platform} · {new Date(data.source.received_at).toLocaleString('pt-BR')}{data.source.text_excerpt ? ` — “${data.source.text_excerpt}”` : ''}</p>}
          {data.review && <p className="muted small">Revisão crítica: {data.review.reviewer_name} → {data.review.producer_name} · rodada {data.review.round} de {data.review.max_rounds} · {REVIEW_STATUS[data.review.status]}</p>}
          {origin && <p className="muted small">Pedido na conversa com {nameOf(origin.agentId) ?? 'um agente'}{origin.delivered ? ' · entregue lá' : ` · ${nameOf(origin.deliverAgentId) ?? 'quem recebeu'} entrega lá`}{origin.purpose ? `: “${origin.purpose}”` : ''}</p>}
        </>} />
      )}
    </aside>
  );
}
