import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { openConversation } from '../lib/open.ts';
import { useSurface } from '../lib/surface.ts';
import { SOURCE_LABEL, type Column, type Need } from '../lib/types.ts';
import { linhaDoHistorico, tomDe, type ChaveSimples, type LogRow } from '../lib/tarefa-tela.ts';
import { DICA_NOME_PROVISORIO, motivoDaFalha } from '../lib/textos-tela.ts';
import { gravarNome } from '../lib/titulo-card.ts';
import { fmtDataHora, tn, useT } from '../i18n/index.ts';
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

/** o estado da revisão crítica (o que o servidor guarda) → a chave do texto */
const REVIEW_STATUS: Record<string, ChaveSimples> = {
  open: 'tarefa.revisao.open', approved: 'tarefa.revisao.approved', limit: 'tarefa.revisao.limit', stopped: 'tarefa.revisao.stopped',
};
/** de onde o card veio (a etiqueta do topo): Teams e WhatsApp são nomes de marca e ficam como estão */
const ORIGEM: Record<string, ChaveSimples> = { manual: 'tarefa.origem.manual', chat: 'tarefa.origem.chat', mirror: 'tarefa.origem.mirror', demo: 'tarefa.origem.demo' };
const MARCAS_DE_ORIGEM: Record<string, string> = { teams: 'Teams', whatsapp: 'WhatsApp' };
const STEP_ICON: Record<Step['status'], string> = { feita: 'check', em_andamento: 'play', pendente: 'clock', falhou: 'alert' };
/** a leitura marcou no vínculo que a descrição do aplicativo passa do que o card guarda (ver server/src/services/mirror.ts) */
const marcaDeCorte = (extra: string | undefined): boolean => !!extra && (JSON.parse(extra) as { descricao_cortada?: boolean }).descricao_cortada === true;

/** Item do menu "⋯". */
interface MenuItem { icon: string; label: string; onClick: () => void; danger?: boolean; on?: boolean; sep?: boolean }
/** Menu "⋯" da tarefa: o que não é a decisão de agora (executar de novo, revisar, abrir a conversa, excluir…). */
function MaisAcoes({ items }: { items: MenuItem[] }) {
  const t = useT();
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
      <button type="button" className="icon-btn tdet__more" onClick={() => setOpen((o) => !o)} aria-label={t('tarefa.maisAcoes')} title={t('tarefa.maisAcoes')} aria-expanded={open} aria-haspopup="menu"><Icon name="dots" /></button>
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
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const l = linhaDoHistorico(e, nomeDe, revisor);
  const mais = !!(l.detalhe || l.saida || l.erro);
  return (
    <li className="tlog__item">
      <div className="tlog__row">
        <time>{fmtDataHora(e.created_at)}</time>
        <span className="tlog__t">{l.titulo}{l.quem && <span className="muted"> · {l.quem}</span>}</span>
        {mais && <button type="button" className="linkish tlog__more" aria-expanded={aberta} onClick={() => setAberta((v) => !v)}>{aberta ? t('tarefa.historico.verMenos') : t('tarefa.historico.verMais')}</button>}
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
  const t = useT();
  const [aberta, setAberta] = useState(false);
  const curta = s.short ?? s.title;
  const longa = curta !== s.title;
  return (
    <li className={`step step--${s.status}`} title={longa ? s.title : undefined}>
      <span className="step__icon" aria-hidden="true"><Icon name={STEP_ICON[s.status]} size={13} /></span>
      <span className="step__txt">
        <b>{nome}</b> — {aberta ? s.title : curta}{s.status === 'em_andamento' ? <span className="muted"> {t('tarefa.etapas.agora')}</span> : null}
        {longa && <> <button type="button" className="linkish small" aria-expanded={aberta} onClick={() => setAberta((v) => !v)}>{aberta ? t('tarefa.etapas.menos') : t('tarefa.etapas.mais')}</button></>}
      </span>
    </li>
  );
}

/** O pedido (a descrição do card), recolhido em 3 linhas: quem quer ler tudo abre. */
function Pedido({ texto }: { texto: string }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const longo = texto.length > 220 || texto.split('\n').length > 3;
  return (
    <section className="block tdet__pedido">
      <h4>{t('tarefa.pedido.titulo')}</h4>
      <p className={`pre drawer__desc ${!aberto && longo ? 'tdet__clamp' : ''}`}>{texto}</p>
      {longo && <button type="button" className="linkish small" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>{aberto ? t('tarefa.pedido.recolher') : t('tarefa.pedido.inteiro')}</button>}
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
  const t = useT();
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
  useEffect(() => { if (!savedNow) return; const h = window.setTimeout(() => setSavedNow(false), 2500); return () => window.clearTimeout(h); }, [savedNow]);
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
        setErr(t('tarefa.naoGravei', { erro: errMsg(e) })); d.reload(); return false;
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

  if (!d.data) return <aside ref={ref} className={`drawer ${over ? 'drawer--over' : ''}`} role="dialog" aria-label={t('tarefa.carregando')}><Loading error={d.error} /></aside>;
  const data = d.data;
  const tk = data.task;
  // ligada a um aplicativo: o que você muda aqui vai para lá
  const editable = mode === 'user' || mode === 'mirror';
  // os nomes vêm com o card (só os citados nele), não da equipe inteira
  const names = data.agents ?? {};
  const nameOf = (id: string | null) => (id ? names[id]?.name ?? null : null);
  /** o agente do card pelo nome; sem o nome, "O agente" (começo de frase) */
  const oAgente = () => nameOf(tk.agent_id) ?? t('tarefa.nomes.oAgente');
  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setErr(null);
    try { const r = await api.patch<{ revision: number }>(`/api/tasks/${tk.id}`, { ...body, expectedRevision: rev.current || tk.revision }); rev.current = r.revision; d.reload(); return true; }
    catch (e) { setErr(errMsg(e)); d.reload(); return false; }
  };
  // o nome que você der ao card da equipe fica: a coordenação não troca mais sozinha. Só fecha o campo e diz "Salvo"
  // quando gravou; falhou, o que você digitou continua ali (lib/titulo-card.ts)
  const rename = async () => {
    const id = tk.id;
    setErr(null);
    const g = await gravarNome((corpo) => api.patch<{ revision: number }>(`/api/tasks/${id}`, corpo), naming, tk.title);
    if (idRef.current !== id) return;
    if (!g.fechar) { setErr(t('tarefa.naoGraveiNome', { erro: errMsg(g.erro) })); return; }
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
      return decision === 'apply' ? r.result : t('tarefa.msg.recusado');
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
        const r = await api.post<{ results: Array<{ status: string; result: string }> }>(`/api/tasks/${tk.id}/cartoes`, { decision, ids: lote.map((c) => c.id) });
        const falhas = r.results.filter((x) => x.status === 'failed');
        if (decision === 'apply' && falhas.length) throw new Error(falhas.map((x) => x.result).join(' · '));
        return decision === 'apply' ? t('tarefa.msg.aprovadoN', { n: r.results.length }) : t('tarefa.msg.recusado');
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === 'decided') return null;
        throw e;
      }
    });
  };
  const respond = (action: 'answer' | 'approve' | 'return' | 'retry', text: string | null = null) => act(action, async () => {
    const r = await api.post<{ result: string; runId: string | null }>(`/api/tasks/${tk.id}/respond`, text !== null ? { action, text } : { action });
    setAjuste(null); setAnswer('');
    return action === 'answer' ? t('tarefa.msg.respostaEnviada', { nome: nameOf(tk.agent_id) ?? t('tarefa.nomes.oAgenteMeio') }) : r.result;
  });
  const revisar = (text: string) => act('revise', async () => {
    const r = await api.post<{ result: string }>(`/api/tasks/${tk.id}/revise`, { text });
    setAjuste(null);
    return r.result || t('tarefa.msg.voltouParaEquipe');
  });
  const sendToTeam = () => act('team', async () => {
    const r = await api.post<{ number: number; routed: string | null }>(`/api/tasks/${tk.id}/send-to-team`);
    // o encaminhamento (routed) é a frase que o servidor manda
    return `${t('tarefa.msg.enviadaEquipe', { numero: r.number })} ${r.routed ?? ''}`;
  });
  // revisão crítica: de quem tem a ferramenta de revisão hoje (qualquer nome), nunca do próprio autor — o nome é o de
  // quem o servidor de fato chama ao começar a revisão
  const reviewer = data.reviewer ?? null;
  const askReview = () => act('review', async () => {
    await api.post(`/api/tasks/${tk.id}/review`);
    return t('tarefa.msg.revisaoPedida', { revisor: reviewer?.name ?? t('tarefa.nomes.aRevisao'), autor: nameOf(tk.agent_id) ?? t('tarefa.nomes.quemFez') });
  });
  const active = data.runs.find((r) => ['queued', 'running', 'waiting_user'].includes(r.status));
  // parar: só o trabalho de agora (o card fica aberto para tentar de novo ou devolver); cancelar: o card sai do quadro
  const stop = (runId: string) => act('stop', async () => {
    await api.post(`/api/runs/${runId}/cancel`);
    return t('tarefa.msg.vaiParar', { nome: oAgente() });
  });
  const cancel = () => act('cancel', async () => { await api.post(`/api/tasks/${tk.id}/cancel`); setConfirmCancel(false); onClose(); return null; });
  const work = data.work;
  const startWork = () => act('work', async () => {
    const x = await api.post<{ runId: string | null; mode: string; stopped: { state: string; justification: string } | null }>(`/api/tasks/${tk.id}/work`);
    if (x.stopped) throw new Error(x.stopped.justification);
    return t('tarefa.msg.comecou', { nome: oAgente() });
  });
  // fila da equipe: Prioridade (topo) e subir/descer — o mesmo que arrastar no quadro, sem precisar arrastar
  const pri = !!tk.priority;
  const arrange = (body: { priority?: boolean; move?: 'up' | 'down' }) => act('queue', async () => {
    const r = await api.post<{ priority: boolean; position: number | null }>(`/api/tasks/${tk.id}/queue`, body);
    if (body.priority) return r.position ? t('tarefa.msg.prioridadeTopoPosicao', { posicao: r.position }) : t('tarefa.msg.prioridadeTopo');
    if (body.priority === false) return t('tarefa.msg.semPrioridade');
    return r.position ? t('tarefa.msg.posicaoNaFila', { posicao: r.position }) : null;
  });
  // esperando o clique numa ação de conta: a decisão é o cartão dela, não aprovar o card
  const need: Need | null = !work || tk.completed || active || conexoes.length ? null
    : work.state === 'aguardando_info' ? 'info' : work.state === 'aguardando_aprovacao' ? 'approval' : work.state === 'revisao' ? 'review' : work.state === 'falha' ? 'retry' : null;
  const external = work?.result?.state === 'sem_confirmacao';
  const origin = data.origin;
  const column = data.column ?? columns?.find((c) => c.id === tk.column_id)?.name;
  const children = data.children ?? [];
  const resumo = data.resumo ?? null;
  const tom = tomDe(resumo?.situacao.tom ?? (tk.completed ? 'feito' : 'fila')); // i18n-ok: o tom é nome de classe, não texto de tela
  const indo = (what: string, label: string, doing: string) => (busy === what ? doing : label);
  const origemDoCard = MARCAS_DE_ORIGEM[tk.origin] ?? (ORIGEM[tk.origin] ? t(ORIGEM[tk.origin]) : tk.origin);

  // confirmação de cancelar/apagar, logo abaixo dos botões: diz o que para, o que vai junto e quem fica sabendo
  const confirmBox = confirmCancel && (
    <div className="ask-box ask-box--danger" role="group" aria-label={t('tarefa.confirmar')}>
      <p className="ask-box__q">
        <b>{editable ? t('tarefa.confirmar.apagar') : tk.completed ? t('tarefa.confirmar.tirar', { numero: tk.number }) : t('tarefa.confirmar.cancelar', { numero: tk.number })}</b>{' '}
        {active ? `${t('tarefa.confirmar.paraAgora', { nome: oAgente() })} ` : ''}{t('tarefa.confirmar.saiDoQuadro')}
        {children.length > 0 && ` ${t('tarefa.confirmar.vaiJunto', { lista: children.map((c) => `#${c.number} ${c.title}`).join('; ') })}`}
        {origin && !origin.delivered && !tk.completed && ` ${t('tarefa.confirmar.conversaSabe')}`}
      </p>
      <div className="row">
        <button className="btn btn--sm btn--danger" aria-busy={busy === 'cancel'} onClick={() => void cancel()}>
          <Icon name="trash" size={13} /> {indo('cancel', editable ? t('tarefa.apagar') : tk.completed ? t('tarefa.tirarDoQuadro') : t('tarefa.cancelarTarefa'), t('tarefa.cancelando'))}
        </button>
        <button className="btn btn--sm" onClick={() => setConfirmCancel(false)}>{t('tarefa.voltar')}</button>
      </div>
    </div>
  );
  // "Pedir ajuste": o que precisa mudar vai para o agente (e, num card concluído, ele reabre numa nova rodada)
  const ajusteBox = ajuste && (
    <form className="ask-box tdet__ajuste" onSubmit={(e) => {
      e.preventDefault();
      const txt = ajuste.texto.trim();
      if (txt.length < 3) { setErr(t('tarefa.ajuste.minimo')); return; }
      void (ajuste.modo === 'revise' ? revisar(txt) : respond('return', txt));
    }}>
      <label className="field">{ajuste.modo === 'revise' ? t('tarefa.ajuste.revisar') : t('tarefa.ajuste.devolver')}
        <textarea data-autofocus rows={3} value={ajuste.texto} onChange={(e) => setAjuste({ ...ajuste, texto: e.target.value })} placeholder={t('tarefa.ajuste.exemplo')} />
      </label>
      <div className="row">
        <button className="btn btn--primary" aria-busy={busy === 'return' || busy === 'revise'}><Icon name="send" size={14} /> {busy === 'return' || busy === 'revise' ? t('tarefa.enviando') : t('tarefa.ajuste.enviar')}</button>
        <button type="button" className="btn btn--ghost" onClick={() => setAjuste(null)}>{t('tarefa.voltar')}</button>
      </div>
    </form>
  );
  const pedirAjuste = (modo: 'return' | 'revise') => setAjuste((v) => (v ? null : { modo, texto: '' }));

  // os botões grandes da faixa: a decisão de agora (Aprovar, Pedir ajuste), quando cabe
  let botoes: ReactNode = null;
  if (mode === 'team' && !tk.completed) {
    if (lote.length === 1 && lote[0].kind === 'depois_de_ler') {
      const c = lote[0];
      botoes = <BotoesPrazo ocupado={!!busy} onEscolher={(prazo) => void decidir(c.id, 'apply', prazo)} onRecusar={() => void decidir(c.id, 'reject')} />;
    } else if (lote.length) {
      const n = lote.length;
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'apply' || busy?.startsWith('apply:')} onClick={() => void decidirTodos('apply')}>
          <Icon name="check" size={16} /> {busy === 'apply' || busy?.startsWith('apply:') ? t('tarefa.aprovando') : n > 1 ? t('tarefa.aprovarN', { n }) : t('tarefa.aprovar')}
        </button>
        <button className="btn btn--big" aria-busy={busy === 'reject' || busy?.startsWith('reject:')} onClick={() => void decidirTodos('reject')}>
          <Icon name="x" size={16} /> {busy === 'reject' || busy?.startsWith('reject:') ? t('tarefa.recusando') : t('tarefa.recusar')}
        </button>
      </>;
    } else if (need === 'approval' || need === 'review') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'approve'} onClick={() => void respond('approve')}>
          <Icon name="check" size={16} /> {indo('approve', external ? t('tarefa.confirmarFeito') : need === 'review' ? t('tarefa.aprovarAssimMesmo') : t('tarefa.aprovar'), t('tarefa.aprovando'))}
        </button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> {t('tarefa.pedirAjuste')}</button>
      </>;
    } else if (need === 'retry') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'work'} onClick={() => void startWork()}><Icon name="repeat" size={16} /> {indo('work', t('tarefa.tentarDeNovo'), t('tarefa.comecando'))}</button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> {t('tarefa.pedirAjuste')}</button>
      </>;
    } else if (need === 'info') {
      botoes = <>
        <button className="btn btn--primary btn--big" aria-busy={busy === 'answer'} onClick={() => { if (answer.trim()) void respond('answer', answer.trim()); else setErr(t('tarefa.escrevaResposta')); }}>
          <Icon name="send" size={16} /> {indo('answer', t('tarefa.responder'), t('tarefa.enviando'))}
        </button>
        <button className="btn btn--big" aria-pressed={ajuste?.modo === 'return'} onClick={() => pedirAjuste('return')}><Icon name="undo" size={16} /> {t('tarefa.pedirAjuste')}</button>
      </>;
    } else if (!active && work && tom === 'fila') {
      botoes = <button className="btn btn--big" aria-busy={busy === 'work'} onClick={() => void startWork()}><Icon name="play" size={16} /> {indo('work', t('tarefa.comecarAgora'), t('tarefa.comecando'))}</button>;
    }
  }

  // o menu "⋯": o que não é a decisão de agora
  const menu: MenuItem[] = [];
  if (mode === 'team') {
    if (active) menu.push({ icon: 'stop', label: t('tarefa.menu.parar'), onClick: () => void stop(active.id) });
    if (work && !tk.completed && !active && need !== 'retry' && tom !== 'fila') menu.push({ icon: 'repeat', label: t('tarefa.menu.executarDeNovo'), onClick: () => void startWork() });
    if (work && !tk.completed && !active && !botoes) menu.push({ icon: 'undo', label: t('tarefa.menu.pedirAjuste'), onClick: () => pedirAjuste('return') });
    // o agente entregou e fez uma pergunta: dá para aprovar o que veio sem responder (como antes, agora no menu)
    if (need === 'info') menu.push({ icon: 'check', label: t('tarefa.menu.aprovarSemResponder'), onClick: () => void respond('approve') });
    if (tk.completed) menu.push({ icon: 'pen', label: t('tarefa.menu.revisar'), onClick: () => pedirAjuste('revise') });
    if (tk.agent_id && data.review?.status !== 'open' && !tk.completed) menu.push({ icon: 'eye', label: reviewer ? t('tarefa.menu.revisaoCriticaA', { nome: reviewer.name }) : t('tarefa.menu.revisaoCritica'), onClick: () => void askReview() });
    if (origin?.conversationId) menu.push({ icon: 'chat', label: t('tarefa.menu.abrirConversa', { nome: nameOf(origin.agentId) ?? t('tarefa.nomes.oAgenteMeio') }), onClick: () => openConversation(origin.agentId, origin.conversationId) });
    if (onAskCoordinator) menu.push({ icon: 'users', label: t('tarefa.menu.falarCoordenacao'), onClick: () => onAskCoordinator(t('tarefa.menu.sobreOCard', { numero: tk.number })) });
    if (work && !tk.completed) menu.push({ icon: 'shield-check', label: t('tarefa.menu.exigirAprovacao'), on: work.requiresApproval,
      onClick: () => void act('approval', async () => { await api.put(`/api/tasks/${tk.id}/approval`, { required: !work.requiresApproval }); return null; }) });
    if (data.queue) {
      menu.push({ icon: 'flag', label: pri ? t('tarefa.menu.tirarPrioridade') : t('tarefa.menu.prioridade'), on: pri, onClick: () => void arrange({ priority: !pri }), sep: true });
      if (data.queue.position > 1) menu.push({ icon: 'chevron-up', label: t('tarefa.menu.subir'), onClick: () => void arrange({ move: 'up' }) });
      if (data.queue.position < data.queue.total) menu.push({ icon: 'chevron', label: t('tarefa.menu.descer'), onClick: () => void arrange({ move: 'down' }) });
    }
    menu.push({ icon: 'trash', label: tk.completed ? t('tarefa.tirarDoQuadro') : t('tarefa.menu.excluir'), danger: true, sep: true, onClick: () => setConfirmCancel(true) });
  }

  const feedback = <>
    {err && <p className="error" role="alert">{err}</p>}
    {ok && <p className="ok" role="status">{ok}</p>}
  </>;
  const reenviar = async () => { try { await api.post(`/api/tasks/${tk.id}/reenviar`); d.reload(); } catch (e) { setErr(errMsg(e)); } };

  return (
    <aside ref={ref} className={`drawer task-panel ${over ? 'drawer--over' : ''}`} role="dialog" aria-labelledby={`task-title-${tk.id}`}>
      {editable ? (
        <>
          <header className="drawer__head">
            <span className="muted" id={`task-title-${tk.id}`}>{t('tarefa.editavel.titulo', { numero: tk.number })}</span>
            <span className="badge">{mode === 'mirror' ? (SOURCE_LABEL[source ?? ''] ?? t('tarefa.origem.mirror')) : origemDoCard}</span>
            <span className="drawer__saved" role="status">{savedNow ? <><Icon name="check" size={12} /> {t('tarefa.salvo')}</> : ''}</span>
            <button className="icon-btn" onClick={() => void requestClose()} aria-label={t('tarefa.fechar')} title={t('tarefa.fechar')}><Icon name="x" /></button>
          </header>
          <label className="field">{t('tarefa.editavel.campoTitulo')}<input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void saveText()} maxLength={200} /></label>
          {cortada ? (
            <div className="field">{t('tarefa.editavel.descricao')}
              <p className="pre drawer__desc">{tk.description}</p>
              <p className="hint">{t('tarefa.editavel.descricaoCortada')}</p>
            </div>
          ) : <label className="field">{t('tarefa.editavel.descricao')}<textarea value={desc} rows={4} onChange={(e) => setDesc(e.target.value)} onBlur={() => void saveText()} /></label>}
          <div className="row">
            <label className="check"><input type="checkbox" checked={!!tk.completed} onChange={(e) => patch({ completed: e.target.checked })} /> {t('tarefa.editavel.concluida')}</label>
            <label className="field field--inline">{t('tarefa.editavel.coluna')}
              <select value={tk.column_id} onChange={(e) => patch({ columnId: e.target.value })}>{(columns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            <label className="field field--inline">{t('tarefa.editavel.prazo')}
              <input type="date" value={tk.due_on ?? ''} onChange={(e) => patch({ dueOn: e.target.value || null })} />
              {tk.due_on && <button type="button" className="linkish" onClick={() => patch({ dueOn: null })}>{t('tarefa.editavel.tirarPrazo')}</button>}
            </label>
          </div>
          {mode === 'mirror' ? (
            <>
              <div className="kv"><span>{t('tarefa.editavel.atribuidaA')}</span><b>{tk.external_assignee ?? '—'}</b></div>
              <p className="hint">{t('tarefa.editavel.ligadaA', { app: SOURCE_LABEL[source ?? ''] ?? t('tarefa.nomes.umAplicativo') })}</p>
            </>
          ) : (
            <>
              <TaskFiles taskId={tk.id} inputs={data.files.inputs} deliverables={data.files.deliverables} canAttach onChanged={d.reload}
                hint={t('tarefa.editavel.dicaPlanilha')} />
              <section className="block">
                <h4>{t('tarefa.editavel.pedirEquipe')}</h4>
                <p className="hint">{t('tarefa.editavel.pedirEquipeDica')}</p>
                <button className="btn" aria-busy={busy === 'team'} onClick={() => void sendToTeam()}><Icon name="users" size={14} /> {indo('team', t('tarefa.editavel.enviarEquipe'), t('tarefa.enviando'))}</button>
              </section>
              <ActionBar>
                <IconAction icon="trash" danger label={t('tarefa.editavel.apagarDica')} pressed={confirmCancel} onClick={() => setConfirmCancel((v) => !v)} />
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
              <span className="tdet__num">#{tk.number}</span>
              {mode === 'team' && naming !== null ? (
                <form className="row task-rename" data-esc-own onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input aria-label={t('tarefa.renomear.campo')} value={naming} autoFocus maxLength={200} onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setNaming(null); } }} />
                  <button className="btn btn--sm" type="submit"><Icon name="check" size={13} /> {t('tarefa.salvar')}</button>
                  <button className="btn btn--sm" type="button" onClick={() => setNaming(null)}>{t('tarefa.voltar')}</button>
                </form>
              ) : (
                <h2 className="tdet__title" id={`task-title-${tk.id}`}>{tk.title}{mode === 'team' && (
                  <button type="button" className="icon-btn" aria-label={t('tarefa.renomear')} title={t('tarefa.renomear')} onClick={() => setNaming(tk.title)}><Icon name="edit" size={15} /></button>
                )}</h2>
              )}
            </div>
            {mode === 'team' && naming === null && tk.title_source === 'provisorio' && <p className="hint tdet__hint">{DICA_NOME_PROVISORIO}</p>}
            {mode === 'team' && <MaisAcoes items={menu} />}
            <button className="icon-btn" onClick={() => void requestClose()} aria-label={t('tarefa.fechar')} title={t('tarefa.fechar')}><Icon name="x" /></button>
          </header>
          {/* 2. a situação em uma palavra, com cor */}
          <div className="tdet__status">
            <span className={`tdet__sit tdet__sit--${tom}`}>{resumo?.situacao.texto ?? (tk.completed ? t('tarefa.situacao.feito') : data.queue ? t('tarefa.situacao.naFila', { posicao: data.queue.position, total: data.queue.total }) : column ?? t('tarefa.situacao.aberta'))}</span>
            {tk.due_on && <DueChip due={tk.due_on} done={!!tk.completed} />}
            {mode === 'team' && tk.agent_id && <span className="muted small">{t('tarefa.situacao.com', { nome: nameOf(tk.agent_id) ?? '' })}</span>}
          </div>
          {/* 3. a faixa de decisão: a frase exata do que se aprova (ou do que foi feito); 4. os botões grandes */}
          {resumo && (
            <section className={`tdet__faixa tdet__faixa--${tom}`} aria-label={resumo.faixa.titulo}>
              <p className="tdet__faixa-t">{resumo.faixa.titulo}</p>
              <p className="tdet__frase">{resumo.faixa.frase}</p>
              {resumo.faixa.itens.length > 0 && <ul className="tdet__itens">{resumo.faixa.itens.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {resumo.faixa.doAgente && <p className="tdet__agente">{resumo.faixa.doAgente}</p>}
              {(conexoes.length > 0 || data.files.deliverables.length > 0) && <p className="tdet__abaixo muted small">{t('tarefa.faixa.detalhesAbaixo')}</p>}
              {need === 'info' && (
                <textarea className="tdet__resp" data-autofocus value={answer} rows={2} onChange={(e) => setAnswer(e.target.value)} placeholder={t('tarefa.faixa.resposta')}
                  aria-label={t('tarefa.faixa.respostaCampo')} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (answer.trim()) void respond('answer', answer.trim()); } }} />
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
            <section className="block tdet__cartoes" aria-label={t('tarefa.cartoes.titulo')}>
              <h4>{conexoes.length > 1 ? t('tarefa.cartoes.tituloN', { n: conexoes.length }) : t('tarefa.cartoes.titulo')}</h4>
              {conexoes.map((c) => (
                <div key={c.id} className="tdet__cartao" role="group" aria-label={c.kind === 'depois_de_ler' ? t('tarefa.cartoes.esperandoAprovacao') : t('tarefa.cartoes.esperandoConfirmacao')}>
                  <p className="pre"><TextoLongo texto={c.summary} /></p>
                  {!(lote.length === 1 && lote[0].id === c.id) && (c.kind === 'depois_de_ler' ? (
                    <BotoesPrazo ocupado={!!busy} onEscolher={(prazo) => void decidir(c.id, 'apply', prazo)} onRecusar={() => void decidir(c.id, 'reject')} />
                  ) : (
                    <div className="row">
                      <button className="btn btn--sm" aria-busy={busy === `apply:${c.id}`} onClick={() => void decidir(c.id, 'apply')}>{indo(`apply:${c.id}`, t('tarefa.cartoes.aprovarEste'), t('tarefa.aprovando'))}</button>
                      <button className="btn btn--sm btn--ghost" aria-busy={busy === `reject:${c.id}`} onClick={() => void decidir(c.id, 'reject')}>{indo(`reject:${c.id}`, t('tarefa.cartoes.recusarEste'), t('tarefa.recusando'))}</button>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* 5. as etapas, uma linha cada */}
          {data.steps.length > 0 && (
            <section className="block steps" aria-label={t('tarefa.etapas.titulo')}>
              <h4>{t('tarefa.etapas.titulo')}</h4>
              <ol className="steps__list">
                {data.steps.map((s) => <LinhaEtapa key={s.position} s={s} nome={nameOf(s.agentId) ?? t('tarefa.nomes.agente')} />)}
                {origin && (
                  <li className={`step ${origin.delivered ? 'step--feita' : 'step--pendente'}`}>
                    <span className="step__icon" aria-hidden="true"><Icon name={origin.delivered ? 'check' : 'chat'} size={13} /></span>
                    <span className="step__txt">{tn('tarefa.etapas.entregarNaConversa', { nome: <b>{nameOf(origin.deliverAgentId) ?? t('tarefa.nomes.aCoordenacao')}</b> })}</span>
                  </li>
                )}
              </ol>
            </section>
          )}

          {/* 6. arquivos com "Ver" (abre por cima, sem sair da tarefa) */}
          {mode === 'team' && (
            <TaskFiles taskId={tk.id} inputs={data.files.inputs} deliverables={data.files.deliverables} canAttach={!tk.completed} onChanged={d.reload} />
          )}
          {/* i18n-ok: 'Plano:' é a marca que o servidor põe na descrição, não texto de tela */}
          {tk.description && <Pedido texto={data.steps.length ? tk.description.split('\n\nPlano:\n')[0] : tk.description} />}

          {!data.link?.conflict && data.envio && <p className="warn">{t('tarefa.envio.naoFoi', { motivo: data.envio })} <button type="button" className="linkish" onClick={() => void reenviar()}>{t('tarefa.tentarDeNovo')}</button></p>}
          {data.link?.conflict && <p className="warn">{data.link.conflict}{data.link.sync_state === 'escrita_falhou' && <> <button type="button" className="linkish" onClick={() => void reenviar()}>{t('tarefa.tentarDeNovo')}</button></>}</p>}
        </>
      )}

      {mode !== 'team' && data.source && (
        <section className="block">
          <h4>{t('tarefa.deOndeVeio')}</h4>
          <p className="muted">{data.source.platform} · {fmtDataHora(data.source.received_at)}</p>
          {data.source.text_excerpt && <blockquote>{data.source.text_excerpt}</blockquote>}
        </section>
      )}

      {/* 7. histórico recolhido; cada entrega também ("ver mais") */}
      <details className="block log-block">
        <summary>{t('tarefa.historico.titulo')} <span className="muted">({data.log.length})</span></summary>
        <ol className="tlog">
          {data.log.map((e) => <LinhaLog key={e.id} e={e} nomeDe={nameOf} revisor={data.review?.reviewer_name ?? null} />)}
        </ol>
      </details>

      {/* 8. como foi conferido, em linguagem simples, recolhido no fim */}
      {mode === 'team' && (
        <TechDetails work={work} queue={data.queue} extra={<>
          {data.source && <p className="muted small">{t('tarefa.conferido.deOndeVeio', { plataforma: data.source.platform, quando: fmtDataHora(data.source.received_at) })}{data.source.text_excerpt ? ` — “${data.source.text_excerpt}”` : ''}</p>}
          {data.review && <p className="muted small">{t('tarefa.conferido.revisao', { revisor: data.review.reviewer_name, autor: data.review.producer_name, rodada: data.review.round, total: data.review.max_rounds, estado: REVIEW_STATUS[data.review.status] ? t(REVIEW_STATUS[data.review.status]) : data.review.status })}</p>}
          {origin && <p className="muted small">{origin.delivered
            ? t('tarefa.conferido.pedidoEntregue', { nome: nameOf(origin.agentId) ?? t('tarefa.nomes.umAgente') })
            : t('tarefa.conferido.pedidoAEntregar', { nome: nameOf(origin.agentId) ?? t('tarefa.nomes.umAgente'), quem: nameOf(origin.deliverAgentId) ?? t('tarefa.nomes.quemRecebeu') })}{origin.purpose ? `: “${origin.purpose}”` : ''}</p>}
        </>} />
      )}
    </aside>
  );
}
