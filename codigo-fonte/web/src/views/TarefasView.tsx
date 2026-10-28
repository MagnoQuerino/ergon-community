import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useHashParam } from '../lib/route.ts';
import { pushRecent } from '../lib/recents.ts';
import { SOURCE_LABEL, type Agent, type BoardSummary, type BoardView, type Integration, type TaskCard } from '../lib/types.ts';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { Board, ViewToggle } from '../components/Board.tsx';

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } };

/**
 * Suas tarefas: a lista local do Ergon ou o espelho de uma lista/quadro de um aplicativo conectado (Planner,
 * To Do, Asana, Todoist). Escolheu, espelhou: o Ergon atualiza sozinho. O espelho traz título, descrição,
 * situação e responsável; mudanças se fazem no aplicativo de origem.
 */
export function TarefasView({ agents, onGo }: { agents: Agent[]; onGo: (v: 'conexoes') => void }) {
  const boards = useResource<BoardSummary[]>('/api/boards', ['tasks.changed']);
  const ints = useResource<Integration[]>('/api/integrations', ['integrations.changed']);
  const mine = (boards.data ?? []).filter((b) => b.audience === 'user');
  const [boardId, setBoardId] = useState<string | null>(() => pref('ergon.tarefas.board', '') || null);
  useEffect(() => { if (boards.data && (!boardId || !mine.some((b) => b.id === boardId)) && mine.length) setBoardId(mine[0].id); }, [boards.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (boardId) save('ergon.tarefas.board', boardId); }, [boardId]);
  const view = useResource<BoardView>(boardId ? `/api/boards/${boardId}` : null, ['tasks.changed']);
  const [mode, setMode] = useState<'kanban' | 'lista'>(() => (pref('ergon.tarefas.view', 'kanban') as 'kanban' | 'lista'));
  // card aberto no endereço (#tarefas?card=…): atualizar a página mantém, o Voltar fecha
  const [openTask, setOpenTask] = useHashParam('card');
  // a busca (Ctrl+K) pode levar a um card de outra lista sua: o endereço diz qual (#tarefas?board=…&card=…)
  const [hashBoard] = useHashParam('board');
  useEffect(() => { if (hashBoard && hashBoard !== boardId && mine.some((b) => b.id === hashBoard)) setBoardId(hashBoard); }, [hashBoard, boards.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const opened = view.data?.tasks.find((t) => t.id === openTask);
  useEffect(() => {
    if (opened && boardId) pushRecent({ kind: 'card', id: opened.id, label: `#${opened.number} ${opened.title}`, where: 'Tarefas', href: `#tarefas?board=${boardId}&card=${opened.id}` });
  }, [opened?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ kind: string; lists: Array<{ externalId: string; name: string }> | null; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const current = mine.find((b) => b.id === boardId);
  const mirror = current?.origin === 'mirror';
  const connected = (ints.data ?? []).filter((i) => i.tasks && i.state === 'connected');

  const create = async () => {
    if (!newTitle.trim() || !boardId) return;
    setErr(null);
    try { await api.post('/api/tasks', { title: newTitle.trim(), boardId, ...(newDue ? { dueOn: newDue } : {}) }); setNewTitle(''); setNewDue(''); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const move = async (taskId: string, columnId: string) => {
    const t = view.data?.tasks.find((x) => x.id === taskId);
    if (!t || t.column_id === columnId) return;
    try { await api.patch(`/api/tasks/${taskId}`, { columnId, expectedRevision: t.revision }); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const toggle = async (t: TaskCard, completed: boolean) => {
    try { await api.patch(`/api/tasks/${t.id}`, { completed, expectedRevision: t.revision }); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const pick = async (kind: string) => {
    setPicking({ kind, lists: null });
    try { const r = await api.get<{ lists: Array<{ externalId: string; name: string }> }>(`/api/integrations/${kind}/lists`); setPicking({ kind, lists: r.lists }); }
    catch (e) { setPicking({ kind, lists: [], error: errMsg(e) }); }
  };
  const mirrorList = async (kind: string, listId: string) => {
    setErr(null); setSyncing(true);
    try { const r = await api.post<{ boardId: string }>('/api/boards/mirror', { kind, listId }); setPicking(null); boards.reload(); setBoardId(r.boardId); }
    catch (e) { setErr(errMsg(e)); } finally { setSyncing(false); }
  };
  const sync = async () => {
    if (!boardId) return;
    setSyncing(true); setErr(null);
    try { await api.post(`/api/boards/${boardId}/sync`); boards.reload(); view.reload(); } catch (e) { setErr(errMsg(e)); } finally { setSyncing(false); }
  };

  return (
    <div className="page page--board">
      <header className="page__head">
        <h2>Tarefas</h2>
        <p className="muted">As suas tarefas. As da equipe de agentes ficam em Fluxos da equipe.</p>
      </header>
      <div className="toolbar">
        <select value={boardId ?? ''} onChange={(e) => { const v = e.target.value; if (v.startsWith('+')) void pick(v.slice(1)); else { setBoardId(v); setOpenTask(null); } }} aria-label="Lista">
          <optgroup label="Ergon">{mine.filter((b) => b.origin === 'native').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>
          {connected.map((i) => (
            <optgroup key={i.kind} label={i.name}>
              {mine.filter((b) => b.source === i.kind).map((b) => <option key={b.id} value={b.id}>{b.name.replace(/^(Planner|To Do) › /, '$1 › ')}</option>)}
              <option value={`+${i.kind}`}>+ Espelhar outra lista do {SOURCE_LABEL[i.kind] ?? i.name}…</option>
            </optgroup>
          ))}
        </select>
        <ViewToggle view={mode} onChange={(v) => { setMode(v); save('ergon.tarefas.view', v); }} />
        {mirror && current && (
          <span className={`badge ${current.sync_state === 'error' ? 'badge--err' : ''}`}>
            {current.sync_state === 'error' ? `falha ao ler: ${current.last_error}` : `espelho de ${SOURCE_LABEL[current.source ?? ''] ?? 'aplicativo'} · lido às ${current.last_synced_at ? new Date(current.last_synced_at).toLocaleTimeString('pt-BR', { timeStyle: 'short' }) : '—'}`}
          </span>
        )}
        {mirror && <button className="btn btn--sm" onClick={sync} disabled={syncing}>{syncing ? 'Atualizando…' : 'Atualizar agora'}</button>}
        {!mirror && (
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Nova tarefa… (dá para escrever o prazo: “até sexta”)" maxLength={200} aria-label="Título da nova tarefa" />
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label="Prazo (opcional)" title="Prazo (opcional)" className="new-due" />
            <button className="btn btn--primary" type="submit" disabled={!newTitle.trim()}>Adicionar</button>
          </form>
        )}
      </div>
      {!connected.length && (
        <p className="hint">Usa Trello, Jira, Asana, monday.com, ClickUp, Notion, Planner, To Do, Todoist ou outro app de tarefas? <button className="linkish" onClick={() => onGo('conexoes')}>Conecte em Conexões</button> e escolha a lista aqui: o espelho é automático (título, descrição, situação e responsável).</p>
      )}
      {picking && (
        <section className="card picklist">
          <div className="row"><strong>Qual lista do {SOURCE_LABEL[picking.kind] ?? picking.kind} espelhar?</strong><span className="grow" /><button className="btn btn--sm btn--ghost" onClick={() => setPicking(null)}>Fechar</button></div>
          {picking.error && <p className="error">{picking.error}</p>}
          {!picking.lists && <p className="muted">Lendo as listas da sua conta…</p>}
          <div className="row row--wrap">
            {picking.lists?.map((l) => <button key={l.externalId} className="chip" disabled={syncing} onClick={() => mirrorList(picking.kind, l.externalId)}>{l.name}</button>)}
            {picking.lists && !picking.lists.length && !picking.error && <span className="muted">Nenhuma lista encontrada nesta conta.</span>}
          </div>
        </section>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {view.data && (
        <Board columns={view.data.columns} tasks={view.data.tasks} agents={agents} view={mode} editable={!mirror} openId={openTask}
          onOpen={setOpenTask} onMove={move} onToggle={mirror ? undefined : toggle} />
      )}
      {openTask && view.data && (
        <TaskDetail taskId={openTask} columns={view.data.columns} agents={agents} mode={mirror ? 'mirror' : 'user'} source={current?.source} onClose={() => setOpenTask(null)} />
      )}
    </div>
  );
}
