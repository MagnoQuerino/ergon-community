import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, api, errMsg, requestId, uploadFile } from '../lib/api.ts';
import { dragHasFiles, inlinePreview, isImage, kindOf, size } from '../lib/files.ts';
import { useLiveEvent, useResource } from '../lib/live.ts';
import { plainText, toWordHtml } from '../lib/markdown.ts';
import { openCard } from '../lib/open.ts';
import { PROPOSAL_KIND, stripControl, type Agent, type AiStatus, type Attachment, type Conversation, type Message, type Proposal } from '../lib/types.ts';
import { ConfirmPopup } from './ConfirmPopup.tsx';
import { HandoffCard, PermissionCard, QuestionCard, RequestCard, SystemNote } from './ChatCards.tsx';
import { Icon } from './Icon.tsx';
import { AgentProfile } from './AgentProfile.tsx';
import { Markdown } from './Markdown.tsx';

/** Rascunhos das conversas (por agente), só na memória da aba: nada de conteúdo da conversa em disco ou na URL. */
const DRAFTS = new Map<string, string>();

/** Sugestões da conversa vazia, no jeito de cada colega (clicar põe no campo; nada de comando para decorar). */
const SUGGEST: Record<string, string[]> = {
  aristoteles: ['O que a equipe está fazendo agora?', 'Preciso de um contrato de prestação de serviço', 'Organiza os meus Documentos por cliente'],
  hipatia: ['Pesquisa os principais concorrentes de ', 'Resume este documento para mim', 'O que já sabemos sobre '],
  herodoto: ['Escreve um e-mail de cobrança educado para ', 'Revisa este texto e deixa mais claro', 'Faz um post curto sobre '],
  arquimedes: ['Analisa esta planilha de vendas', 'Monta um orçamento para ', 'Calcula a margem de '],
  fidias: ['Monta uma apresentação sobre ', 'Ideias de logo para ', 'Cria uma imagem de '],
  socrates: ['Critica este plano sem dó', 'Onde este texto está fraco?', 'Faz as perguntas difíceis sobre '],
  platao: ['Me ajuda a pensar a estratégia de ', 'Qual é a ideia central por trás de ', 'Organiza minhas ideias sobre '],
  hesiodo: ['O que vence esta semana?', 'Me lembra amanhã às 9h de ', 'Monta a pauta da reunião de '],
  diogenes: ['Resolve isto para mim: ', 'Faz a lista do que comprar para ', 'Me dá o passo a passo para '],
  aspasia: ['Responde este cliente: ', 'Escreve uma mensagem de WhatsApp para ', 'Como respondo esta reclamação?'],
  euclides: ['Confere este documento', 'Tem erro nesta planilha?', 'Este contrato está completo?'],
  hipodamo: ['Planeja o projeto de ', 'Monta um cronograma para ', 'Quais são as etapas para '],
};
const suggestionsFor = (a: Agent) => SUGGEST[a.char_key ?? ''] ?? ['Me ajuda com ', 'Resume este arquivo', 'O que você faz de melhor?'];

/** Arquivo subindo ou pronto para ir junto da mensagem. */
interface Pending { key: string; file: File; progress: number; art: Attachment | null; error: string | null; abort: AbortController }

/** Mensagem que você acabou de mandar (aparece na hora, antes de o servidor confirmar). */
interface Optimistic { key: string; text: string; files: Attachment[]; serverId: string | null; queued: boolean }

/** A nota do sistema virou o quê: ficha simples, falha com "tentar de novo", parada, ou ação de Documentos com desfazer. */
function systemKind(text: string): { kind: 'fail' | 'stop' | 'docs' | 'note'; text: string; undo: string | null } {
  const undo = text.match(/\{\{desfazer:(aud_[a-f0-9]{32})\}\}/)?.[1] ?? null;
  const clean = text.replace(/\s*\{\{desfazer:aud_[a-f0-9]{32}\}\}/, '').replace(/^Sistema — /, '');
  if (/^Não deu certo desta vez: /.test(clean)) return { kind: 'fail', text: clean, undo: null };
  if (clean === 'Você interrompeu.' || /^Parou: /.test(clean)) return { kind: 'stop', text: clean, undo: null };
  if (/^Documentos — /.test(clean)) return { kind: 'docs', text: clean.replace(/^Documentos — /, ''), undo };
  return { kind: 'note', text: clean, undo: null };
}

function download(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Ficha de um arquivo da mensagem (imagem com miniatura; o resto com o tipo); clicar abre ou baixa. */
function FileChip({ f, progress, error, onRemove }: { f: { filename: string; mime: string; size: number; id?: string }; progress?: number; error?: string | null; onRemove?: () => void }) {
  const href = f.id ? `/api/artifacts/${f.id}/download${inlinePreview(f.mime) ? '?inline=1' : ''}` : undefined;
  const body = (
    <>
      {f.id && isImage(f.mime) ? <img src={`/api/artifacts/${f.id}/download?inline=1`} alt="" loading="lazy" /> : <span className="fchip__icon"><Icon name={f.mime.startsWith('image/') ? 'image' : 'file'} size={16} /></span>}
      <span className="fchip__txt"><b title={f.filename}>{f.filename}</b><small>{error ? error : progress !== undefined && progress < 1 && !f.id ? `subindo… ${Math.round(progress * 100)}%` : `${kindOf(f.filename, f.mime)} · ${size(f.size)}`}</small></span>
      {progress !== undefined && !f.id && !error && <span className="fchip__bar" style={{ width: `${Math.round(progress * 100)}%` }} />}
    </>
  );
  return (
    <span className={`fchip ${error ? 'fchip--err' : ''}`}>
      {href ? <a className="fchip__main" href={href} target="_blank" rel="noreferrer" title="Abrir (também em Documentos)">{body}</a> : <span className="fchip__main">{body}</span>}
      {onRemove && <button type="button" className="fchip__x" onClick={onRemove} aria-label={`Tirar ${f.filename}`}><Icon name="x" size={12} /></button>}
    </span>
  );
}

/** "Platão está escrevendo…" (ou o que ele está fazendo agora), com as reticências animadas. */
function Typing({ who, activity, status }: { who: string; activity: string | null; status: string | null }) {
  const what = status === 'queued' ? 'vai começar já já' : status === 'waiting_user' ? 'esperando você' : activity ? activity : 'está escrevendo';
  return (
    <div className="msg msg--agent msg--typing" aria-live="polite">
      <span className="typing" aria-hidden="true"><i /><i /><i /></span>
      <span className="typing__txt">{who} {what}…</span>
    </div>
  );
}

export function ChatPanel({ agent, onClose, compact, draft, embedded, conversationId, hidePicker }: {
  agent: Agent; onClose?: () => void; compact?: boolean; draft?: string | null; embedded?: boolean; conversationId?: string | null;
  /** a lista de conversas ao lado já mostra os assuntos: sem o seletor de cima */
  hidePicker?: boolean;
}) {
  const convs = useResource<Conversation[]>(`/api/conversations?agentId=${agent.id}`, ['messages.changed']);
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  // rascunho por agente, na memória desta aba: fechar a janela ou trocar de agente não apaga o que você digitou
  const [text, setTextRaw] = useState(() => draft ?? DRAFTS.get(agent.id) ?? '');
  const setText = (v: string) => { setTextRaw(v); if (v) DRAFTS.set(agent.id, v); else DRAFTS.delete(agent.id); };
  useEffect(() => { if (draft) setText(draft); }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTextRaw(draft ?? DRAFTS.get(agent.id) ?? ''); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const msgs = useResource<Message[]>(convId ? `/api/conversations/${convId}/messages` : null, ['messages.changed', 'runs.changed']);
  // propostas da coordenação (mudar setor, criar agente, ferramentas): nada muda até você aplicar
  const props = useResource<Proposal[]>(convId ? `/api/proposals?conversationId=${convId}` : null, ['proposals.changed']);
  const decide = async (id: string, decision: 'apply' | 'reject') => {
    setErr(null);
    try { await api.post(`/api/proposals/${id}`, { decision }); props.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  // várias propostas de uma vez (um tema inteiro, por exemplo): aplicar ou recusar todas, na ordem em que vieram
  const batch = (props.data ?? []).filter((p) => p.status === 'proposed' && !['question', 'permission', 'info_request', 'handoff'].includes(p.kind));
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

  // abrir a conversa (ou trocar de conversa) já deixa o cursor no campo: é só escrever
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 60); return () => window.clearTimeout(t); }, [convId, agent.id]);
  // o campo cresce com o texto (até um limite) e volta ao tamanho de uma linha depois de enviar
  useLayoutEffect(() => {
    const el = input.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, Math.max(42, el.scrollHeight))}px`;
  }, [text]);

  // sem nenhum provedor de IA conectado, os agentes não conversam: em toda tentativa, o aviso com "Conectar agora"
  const ai = useResource<AiStatus>('/api/ai/status', ['ai.changed']);
  const semIa = !!ai.data && ai.data.executor === 'real' && !ai.data.accounts.some((x) => x.connected) && !(ai.data.byok ?? []).some((x) => x.connected) && !ai.data.default.model;
  const [avisoIa, setAvisoIa] = useState(false);

  const list = msgs.data ?? [];
  const lastRun = [...list].reverse().find((m) => m.run_id);
  const busy = !!lastRun && ['queued', 'running', 'waiting_user'].includes(lastRun.run_status ?? '');

  // resposta chegando ao vivo: o texto até aqui e o que o colega faz agora (o servidor avisa; o texto vem sob pedido)
  const liveRun = busy ? lastRun?.run_id ?? null : null;
  const [live, setLive] = useState<{ text: string; activity: string | null } | null>(null);
  const fetchLive = useCallback(async () => {
    if (!liveRun) return;
    try { const l = await api.get<{ text: string; activity: string | null }>(`/api/runs/${liveRun}/live`); setLive(l); } catch { /* segue com as reticências */ }
  }, [liveRun]);
  useEffect(() => { setLive(null); if (liveRun) void fetchLive(); }, [liveRun, fetchLive]);
  useLiveEvent('runs.live', (d) => { if (d.id === liveRun) void fetchLive(); });

  // mensagem enviada aparece na hora; some quando o servidor já a mostra
  const [optimistic, setOptimistic] = useState<Optimistic[]>([]);
  const shownOptimistic = optimistic.filter((o) => !o.serverId || !list.some((m) => m.id === o.serverId));
  useEffect(() => { if (optimistic.length && optimistic.length !== shownOptimistic.length) setOptimistic(shownOptimistic); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // rolagem: só desce sozinha se você está no fim; senão, a pílula "novas mensagens"
  const box = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [fresh, setFresh] = useState(0);
  const seen = useRef<{ conv: string | null; ids: Set<string>; ready: boolean }>({ conv: null, ids: new Set(), ready: false });
  if (seen.current.conv !== convId) seen.current = { conv: convId, ids: new Set(), ready: false };
  const isNew = (id: string) => seen.current.ready && !seen.current.ids.has(id);
  useEffect(() => {
    if (!msgs.data) return;
    const s = seen.current;
    const added = msgs.data.filter((m) => !s.ids.has(m.id));
    for (const m of msgs.data) s.ids.add(m.id);
    if (!s.ready) { s.ready = true; requestAnimationFrame(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }); return; }
    if (!added.length) return;
    if (atEnd || added.some((m) => m.role === 'user')) requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }));
    else setFresh((n) => n + added.filter((m) => m.role !== 'user').length);
  }, [msgs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (atEnd && (live?.text || busy)) box.current?.scrollTo({ top: box.current.scrollHeight }); }, [live?.text, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (atEnd) box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }); }, [props.data?.length, shownOptimistic.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = () => {
    const el = box.current; if (!el) return;
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtEnd(end);
    if (end) setFresh(0);
  };
  const toEnd = () => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }); setFresh(0); };

  // lida: a conversa aberta, com a janela à vista e você no fim
  const readMark = useRef<string | null>(null);
  useEffect(() => {
    if (!convId || !atEnd) return;
    const lastAgent = [...list].reverse().find((m) => m.role === 'agent');
    if (!lastAgent || readMark.current === `${convId}:${lastAgent.id}`) return;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      readMark.current = `${convId}:${lastAgent.id}`;
      void api.post(`/api/conversations/${convId}/read`).catch(() => { readMark.current = null; });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [convId, atEnd, list]);

  // arquivos: arrastar para qualquer lugar da conversa, colar (Ctrl+V) ou o clipe
  const [files, setFiles] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const ensureConv = async (): Promise<string> => {
    if (convId) return convId;
    const c = await api.post<Conversation>('/api/conversations', { agentId: agent.id });
    setConvId(c.id); picked.current = true; convs.reload();
    return c.id;
  };
  const addFiles = async (list: FileList | File[]) => {
    const arr = [...list].filter((f) => f.size > 0);
    if (!arr.length) return;
    setErr(null);
    let cid: string;
    try { cid = await ensureConv(); } catch (e) { setErr(errMsg(e)); return; }
    for (const file of arr) {
      const p: Pending = { key: requestId(), file, progress: 0, art: null, error: null, abort: new AbortController() };
      setFiles((cur) => [...cur, p]);
      const upd = (patch: Partial<Pending>) => setFiles((cur) => cur.map((x) => (x.key === p.key ? { ...x, ...patch } : x)));
      uploadFile<Attachment>(file, { conversationId: cid }, (v) => upd({ progress: v }), p.abort.signal)
        .then((art) => upd({ art, progress: 1 }))
        .catch((e) => { if (!(e instanceof ApiError && e.code === 'aborted')) upd({ error: errMsg(e) }); });
    }
    input.current?.focus({ preventScroll: true });
  };
  const removeFile = (key: string) => setFiles((cur) => { cur.find((x) => x.key === key)?.abort.abort(); return cur.filter((x) => x.key !== key); });
  const uploading = files.some((f) => !f.art && !f.error);
  const [sendWhenReady, setSendWhenReady] = useState(false);

  const pending = useRef<{ id: string; text: string } | null>(null);
  /** Enter envia; com o colega trabalhando, a mensagem entra na fila e vai quando ele terminar (editável até ir). */
  async function send() {
    const t = text.trim();
    const ready = files.filter((f) => f.art).map((f) => f.art!);
    if (!t && !ready.length && !uploading) return;
    if (semIa) { setAvisoIa(true); ai.reload(); return; }
    // arquivo ainda subindo: a mensagem sai sozinha quando ele terminar (sem botão esperando)
    if (uploading) { setSendWhenReady(true); setHint('Mando assim que os arquivos terminarem de subir.'); return; }
    setErr(null); setHint(null); setSendWhenReady(false);
    // colega trabalhando (ou a anterior ainda indo): esta entra na fila
    const queue = busy || optimistic.some((o) => !o.serverId);
    const key = requestId();
    setOptimistic((cur) => [...cur, { key, text: t, files: ready, serverId: null, queued: queue }]);
    // o campo limpa na hora: dá para escrever a próxima enquanto esta vai; se não for, o texto volta
    setText(''); setFiles([]);
    const restore = () => setTextRaw((cur) => { const v = cur ? cur : t; DRAFTS.set(agent.id, v); return v; });
    try {
      const id = await ensureConv();
      // mesmo identificador ao reenviar após falha de rede: o servidor não duplica
      if (!pending.current || pending.current.text !== t) pending.current = { id: requestId(), text: t };
      const body = { text: t, clientRequestId: pending.current.id, ...(ready.length ? { attachments: ready.map((f) => f.id) } : {}) };
      const post = (q: boolean) => api.post<{ messageId: string }>(`/api/conversations/${id}/messages`, { ...body, ...(q ? { queue: true } : {}) });
      // a tela ainda não sabia que ele começou a responder: a mensagem vai para a fila em vez de voltar
      const r = await post(queue).catch((e) => { if (e instanceof ApiError && e.code === 'busy' && !queue) return post(true); throw e; });
      pending.current = null;
      setOptimistic((cur) => cur.map((o) => (o.key === key ? { ...o, serverId: r.messageId } : o)));
      msgs.reload(); convs.reload();
    } catch (e) {
      setOptimistic((cur) => cur.filter((o) => o.key !== key));
      restore();
      setErr(errMsg(e));
    } finally { input.current?.focus({ preventScroll: true }); }
  }
  useEffect(() => { if (sendWhenReady && !uploading) void send(); }, [sendWhenReady, uploading]); // eslint-disable-line react-hooks/exhaustive-deps

  // parar: a resposta de agora (e, se a conversa abriu um card que ainda anda, a opção de parar ele também)
  const [cards, setCards] = useState<Array<{ id: string; number: number; title: string }>>([]);
  const [stopCard, setStopCard] = useState<{ id: string; number: number; title: string } | null>(null);
  // acabou de mandar e a tela ainda não viu a resposta começar: o Esc e o Parar já valem
  const working = busy || shownOptimistic.some((o) => !o.queued);
  async function stop() {
    let runId = busy ? lastRun?.run_id ?? null : null;
    try {
      if (!runId && convId) {
        const fresh = await api.get<Message[]>(`/api/conversations/${convId}/messages`);
        runId = [...fresh].reverse().find((m) => m.run_id && ['queued', 'running', 'waiting_user'].includes(m.run_status ?? ''))?.run_id ?? null;
      }
      if (!runId) return;
      await api.post(`/api/runs/${runId}/cancel`);
      msgs.reload();
      if (convId) setCards(await api.get(`/api/conversations/${convId}/cards`));
    } catch (e) { setErr(errMsg(e)); }
  }
  useEffect(() => setCards([]), [convId]);
  async function retry() {
    if (!convId) return;
    try { await api.post(`/api/conversations/${convId}/retry`); msgs.reload(); } catch (e) { setErr(errMsg(e)); }
  }
  async function undoDocs(id: string) {
    try { await api.post(`/api/documents/undo/${id}`); setHint('Desfeito.'); } catch (e) { setErr(errMsg(e)); }
  }

  // fila: editar ou tirar o que ainda não foi
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const saveEdit = async () => {
    if (!editing) return;
    try { await api.patch(`/api/messages/${editing.id}`, { text: editing.text }); setEditing(null); msgs.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const dropQueued = async (id: string) => { try { await api.del(`/api/messages/${id}`); msgs.reload(); } catch (e) { setErr(errMsg(e)); } };

  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (m: Message) => {
    try { await navigator.clipboard.writeText(plainText(stripControl(m.content))); setCopied(m.id); window.setTimeout(() => setCopied(null), 1600); } catch { setErr('Não deu para copiar aqui; selecione o texto e use Ctrl+C.'); }
  };
  const title = convs.data?.find((c) => c.id === convId)?.title ?? `Conversa com ${agent.name}`;
  const saveDoc = (m: Message) => download(`${title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim() || 'entrega'}.doc`, 'application/msword', toWordHtml(stripControl(m.content), title));

  const timeline = useMemo(() => [...list.map((m) => ({ at: m.created_at, m, p: null as Proposal | null })), ...(props.data ?? []).map((p) => ({ at: p.created_at, m: null as Message | null, p }))]
    .sort((a, b) => a.at.localeCompare(b.at)), [list, props.data]);
  const lastMsg = list[list.length - 1];

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && working) { e.preventDefault(); e.stopPropagation(); void stop(); return; }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault(); void send();
  };

  return (
    <section className={`chat ${compact ? 'chat--compact' : ''} ${embedded ? 'chat--embedded' : ''} ${drag ? 'chat--drag' : ''}`} aria-label={`Conversa com ${agent.name}`}
      onDragEnter={(e) => { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDrag(true); }}
      onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDrag(false); }}
      onDrop={(e) => { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDrag(false); void addFiles(e.dataTransfer.files); }}>
      {!embedded && <header className="chat__head">
        <span className="avatar" style={{ background: agent.color }} aria-hidden="true">{agent.name[0]}</span>
        <div className="chat__who">
          <strong>{agent.name}</strong>
          <span>{busy ? <span className="chat__status">trabalhando…</span> : `${agent.role} · ${agent.sector_name}`}</span>
        </div>
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Fechar conversa"><Icon name="x" /></button>}
      </header>}
      {agent.char_key && !embedded && (
        <details className="chat__profile">
          <summary>{agent.bio ? agent.bio.split(/(?<=[.!?])\s/)[0] : 'Perfil'} <span className="muted">perfil</span></summary>
          <AgentProfile agent={agent} />
        </details>
      )}
      {!hidePicker && <div className="chat__convs">
        <select value={convId ?? ''} onChange={(e) => setConvId(e.target.value || null)} aria-label="Conversa">
          {(!convs.data?.length || !convId) && <option value="">{convs.data?.length ? 'Nova conversa' : 'Nenhuma conversa'}</option>}
          {convs.data?.map((c) => <option key={c.id} value={c.id}>{c.title} · {new Date(c.last_at ?? c.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</option>)}
        </select>
        <button className="btn btn--ghost" onClick={async () => { setErr(null); try { const c = await api.post<Conversation>('/api/conversations', { agentId: agent.id }); setConvId(c.id); picked.current = true; convs.reload(); } catch (e) { setErr(errMsg(e)); } }}><Icon name="plus" size={14} /> Nova</button>
      </div>}
      <div className="chat__msgs" role="log" aria-live="polite" ref={box} onScroll={onScroll}>
        {!list.length && !shownOptimistic.length && (
          <div className="chat__empty">
            <p>Fale com {agent.name} como fala com um colega. Pode arrastar arquivos para cá, de qualquer tipo.</p>
            <div className="chat__suggest">
              {suggestionsFor(agent).map((s) => <button key={s} type="button" className="chip" onClick={() => { setText(s); input.current?.focus(); }}>{s.trim()}</button>)}
            </div>
          </div>
        )}
        {/* mensagens e cartões (perguntas, propostas, permissões) na ordem em que aconteceram */}
        {timeline.map(({ m, p }, i) => {
          if (m) {
            const prev = timeline[i - 1]?.m;
            const cont = !!prev && prev.role === m.role && m.role !== 'system' && Date.parse(m.created_at) - Date.parse(prev.created_at) < 3 * 60_000;
            const anim = isNew(m.id) ? 'msg--in' : '';
            if (m.role === 'system') {
              const k = systemKind(m.content);
              return (
                <div key={m.id} className={`msg msg--system msg--${k.kind} ${anim}`}>
                  <div className="msg__body">{k.kind === 'note' ? <SystemNote text={k.text} /> : k.text}</div>
                  {k.kind === 'fail' && m.id === lastMsg?.id && !busy && <button type="button" className="btn btn--sm" onClick={() => void retry()}><Icon name="repeat" size={12} /> Tentar de novo</button>}
                  {k.kind === 'docs' && k.undo && <button type="button" className="linkish" onClick={() => void undoDocs(k.undo!)}><Icon name="undo" size={12} /> Desfazer</button>}
                </div>
              );
            }
            if (m.queued && editing?.id === m.id) {
              return (
                <form key={m.id} className="msg msg--user msg--queued msg--editing" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
                  <textarea autoFocus value={editing.text} rows={2} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} aria-label="Editar a mensagem da fila"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
                  <div className="row"><button className="btn btn--sm btn--primary">Salvar</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>Cancelar</button></div>
                </form>
              );
            }
            const body = m.role === 'agent' ? stripControl(m.content) : m.content;
            return (
              <div key={m.id} className={`msg msg--${m.role} ${m.queued ? 'msg--queued' : ''} ${cont ? 'msg--cont' : ''} ${anim}`}>
                {m.role === 'agent' && m.mode === 'simulated' && <span className="badge badge--warn">SIMULADO</span>}
                {body && <div className="msg__body">{m.role === 'agent' ? <Markdown text={body} /> : body}</div>}
                {!!m.attachments?.length && <div className="msg__files">{m.attachments.map((f) => <FileChip key={f.id} f={f} />)}</div>}
                <div className="msg__foot">
                  <time>{m.queued ? `na fila · vai quando ${agent.name} terminar` : new Date(m.created_at).toLocaleTimeString('pt-BR', { timeStyle: 'short' })}</time>
                  {m.queued ? (
                    <span className="msg__acts">
                      <button type="button" className="linkish" onClick={() => setEditing({ id: m.id, text: m.content })}><Icon name="edit" size={12} /> Editar</button>
                      <button type="button" className="linkish" onClick={() => void dropQueued(m.id)}><Icon name="x" size={12} /> Tirar</button>
                    </span>
                  ) : m.role === 'agent' && body ? (
                    <span className="msg__acts">
                      <button type="button" className="linkish" onClick={() => void copy(m)} title="Copiar o texto"><Icon name={copied === m.id ? 'check' : 'copy'} size={12} /> {copied === m.id ? 'Copiado' : 'Copiar'}</button>
                      {body.length > 1200 && <button type="button" className="linkish" onClick={() => saveDoc(m)} title="Baixar como documento (abre no Word)"><Icon name="download" size={12} /> Documento</button>}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          }
          if (!p) return null;
          return p.kind === 'info_request' ? <RequestCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} />
            : p.kind === 'question' ? <QuestionCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} />
            : p.kind === 'handoff' ? <HandoffCard key={p.id} p={p} />
            : p.kind === 'permission' && p.status === 'proposed' ? <PermissionCard key={p.id} p={p} onDone={() => { props.reload(); msgs.reload(); }} onReject={() => decide(p.id, 'reject')} />
            : (
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
            );
        })}
        {shownOptimistic.map((o) => (
          <div key={o.key} className="msg msg--user msg--in msg--sending">
            {o.text && <div className="msg__body">{o.text}</div>}
            {!!o.files.length && <div className="msg__files">{o.files.map((f) => <FileChip key={f.id} f={f} />)}</div>}
            <div className="msg__foot"><time>{o.queued ? 'na fila' : 'enviando…'}</time></div>
          </div>
        ))}
        {batch.length >= 2 && (
          <div className="proposal-batch" role="group" aria-label="Todas as propostas pendentes">
            <span>{batch.length} propostas esperando você nesta conversa</span>
            <button className="btn btn--sm btn--primary" disabled={batchBusy} onClick={() => void decideAll('apply')}>Aplicar todas</button>
            <button className="btn btn--sm btn--ghost" disabled={batchBusy} onClick={() => void decideAll('reject')}>Recusar todas</button>
          </div>
        )}
        {busy && (live?.text
          ? (
            <div className="msg msg--agent msg--live">
              <div className="msg__body"><Markdown text={stripControl(live.text)} /><span className="caret" aria-hidden="true" /></div>
              {live.activity && <div className="msg__activity"><span className="typing" aria-hidden="true"><i /><i /><i /></span> {agent.name} está {live.activity}…</div>}
            </div>
          )
          : <Typing who={agent.name} activity={live?.activity ?? null} status={lastRun?.run_status ?? null} />)}
        {!busy && cards.length > 0 && (
          <div className="msg msg--system msg--stop">
            <div className="msg__body">{cards.length === 1 ? `O card #${cards[0].number} que saiu desta conversa continua andando.` : `${cards.length} cards desta conversa continuam andando.`}</div>
            {cards.map((c) => <button key={c.id} type="button" className="btn btn--sm" onClick={() => setStopCard(c)}><Icon name="stop" size={12} /> Parar o card #{c.number}</button>)}
          </div>
        )}
      </div>
      {fresh > 0 && <button type="button" className="chat__fresh" onClick={toEnd}>↓ {fresh === 1 ? '1 mensagem nova' : `${fresh} mensagens novas`}</button>}
      {err && <p className="error" role="alert">{err}</p>}
      {hint && <p className="chat__hint" role="status">{hint}</p>}
      {avisoIa && (
        <ConfirmPopup title="Conecte um provedor de IA" confirmLabel="Conectar agora"
          onConfirm={() => { setAvisoIa(false); location.hash = '#conexoes'; }} onCancel={() => setAvisoIa(false)}>
          <p>Você ainda não conectou um provedor de IA ao Ergon, então não é possível conversar com os agentes ainda. Leva um minuto: a sua mensagem fica guardada aqui.</p>
        </ConfirmPopup>
      )}
      {stopCard && (
        <ConfirmPopup title={`Parar o card #${stopCard.number}?`} confirmLabel="Parar o card"
          onConfirm={async () => { const c = stopCard; setStopCard(null); try { await api.post(`/api/tasks/${c.id}/cancel`, {}); setCards((cur) => cur.filter((x) => x.id !== c.id)); } catch (e) { setErr(errMsg(e)); } }}
          onCancel={() => setStopCard(null)}>
          <p>“{stopCard.title}”: o trabalho para e o card sai do quadro. O histórico fica. <button type="button" className="linkish" onClick={() => openCard(stopCard.id)}>Ver o card</button></p>
        </ConfirmPopup>
      )}
      {drag && <div className="chat__drop" aria-hidden="true"><Icon name="clip" size={28} /><b>Solte para enviar a {agent.name}</b><small>qualquer tipo de arquivo</small></div>}
      <form className="chat__input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {files.length > 0 && <div className="chat__files">{files.map((f) => <FileChip key={f.key} f={f.art ?? { filename: f.file.name, mime: f.file.type || 'application/octet-stream', size: f.file.size }} progress={f.progress} error={f.error} onRemove={() => removeFile(f.key)} />)}</div>}
        <div className="chat__row">
          <button type="button" className="icon-btn chat__clip" onClick={() => picker.current?.click()} aria-label="Anexar arquivos" title="Anexar arquivos (ou arraste para a conversa)"><Icon name="clip" /></button>
          <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
          <textarea ref={input} data-autofocus data-esc-own={working ? '' : undefined} value={text} onChange={(e) => { setText(e.target.value); if (hint) setHint(null); }} rows={1}
            placeholder={busy ? `Escreva a próxima: vai quando ${agent.name} terminar` : `Fale com ${agent.name}…`}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
            // Enter envia (com o colega trabalhando, entra na fila) · Shift+Enter quebra a linha · Esc para a resposta
            onKeyDown={keyDown} aria-label="Mensagem" aria-describedby={`chat-keys-${agent.id}`} />
          <span id={`chat-keys-${agent.id}`} hidden>Enter envia; Shift+Enter quebra a linha; com o colega trabalhando, Enter põe na fila e Esc para a resposta.</span>
          {working && <button type="button" className="btn chat__stop" onClick={() => void stop()} aria-label="Parar a resposta (Esc)" title="Parar (Esc)"><Icon name="stop" /></button>}
          {(!busy || text.trim() || files.length > 0) && (
            <button className="btn btn--primary chat__send" type="submit" aria-label={busy ? 'Pôr na fila' : 'Enviar (Enter)'} title={busy ? 'Pôr na fila (vai quando terminar)' : 'Enviar (Enter)'}>
              <Icon name={busy ? 'clock' : 'send'} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
