import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useHashParam } from '../lib/route.ts';
import { pushRecent } from '../lib/recents.ts';
import { SOURCE_LABEL, type BoardSummary, type BoardView, type Integration, type TaskCard } from '../lib/types.ts';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { Board, ViewToggle } from '../components/Board.tsx';
import { fmtHora, tn, useT } from '../i18n/index.ts';
import { comConta, nomeNaTela, temVariasContas } from '../lib/contas.ts';

const pref = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } };

/**
 * Suas tarefas: a lista local do Ergon ou uma lista/quadro de um aplicativo conectado (Planner, To Do, Asana, Todoist e
 * outros), ligada nos dois sentidos: título, descrição, situação, prazo e responsável chegam de lá, e dar check, mover
 * ou editar aqui muda lá (conexoes/espelho.ts).
 */
export function TarefasView({ onGo }: { onGo: (v: 'conexoes') => void }) {
  const t = useT();
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
    if (opened && boardId) pushRecent({ kind: 'card', id: opened.id, label: `#${opened.number} ${opened.title}`, where: t('quadro.tarefas.titulo'), href: `#tarefas?board=${boardId}&card=${opened.id}` });
  }, [opened?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // conta: de qual das contas do aplicativo vem a lista ('' = a principal), quando há mais de uma
  const [picking, setPicking] = useState<{ kind: string; conta: string; lists: Array<{ externalId: string; name: string }> | null; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const current = mine.find((b) => b.id === boardId);
  const mirror = current?.origin === 'mirror';
  const deTarefas = (ints.data ?? []).filter((i) => i.tasks);
  const connected = deTarefas.filter((i) => i.state === 'connected');
  // a conexão caiu (autorização vencida, desconectada): os quadros ligados a ela continuam na lista, com o aviso
  const grupos = deTarefas.filter((i) => i.state === 'connected' || mine.some((b) => b.origin === 'mirror' && b.source === i.kind));
  const caiu = mirror ? deTarefas.find((i) => i.kind === current?.source && i.state !== 'connected') : undefined;

  const create = async () => {
    if (!boardId) return;
    if (!newTitle.trim()) { setErr(t('quadro.tarefas.escrevaTitulo')); return; }
    setErr(null);
    try { await api.post('/api/tasks', { title: newTitle.trim(), boardId, ...(newDue ? { dueOn: newDue } : {}) }); setNewTitle(''); setNewDue(''); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const move = async (taskId: string, columnId: string) => {
    const card = view.data?.tasks.find((x) => x.id === taskId);
    if (!card || card.column_id === columnId) return;
    try { await api.patch(`/api/tasks/${taskId}`, { columnId, expectedRevision: card.revision }); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const toggle = async (card: TaskCard, completed: boolean) => {
    try { await api.patch(`/api/tasks/${card.id}`, { completed, expectedRevision: card.revision }); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const pick = async (kind: string, conta = '') => {
    setPicking({ kind, conta, lists: null });
    try { const r = await api.get<{ lists: Array<{ externalId: string; name: string }> }>(comConta(`/api/integrations/${kind}/lists`, conta)); setPicking({ kind, conta, lists: r.lists }); }
    catch (e) { setPicking({ kind, conta, lists: [], error: errMsg(e) }); }
  };
  const mirrorList = async (kind: string, listId: string, conta = '') => {
    setErr(null); setSyncing(true);
    try { const r = await api.post<{ boardId: string }>('/api/boards/mirror', { kind, listId, ...(conta ? { conta } : {}) }); setPicking(null); boards.reload(); setBoardId(r.boardId); }
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
        <h2>{t('quadro.tarefas.titulo')}</h2>
        <p className="muted">{t('quadro.tarefas.sub')}</p>
      </header>
      <div className="toolbar">
        <select value={boardId ?? ''} onChange={(e) => { const v = e.target.value; if (v.startsWith('+')) { const [k, c] = v.slice(1).split('|'); void pick(k, c ?? ''); } else { setBoardId(v); setOpenTask(null); } }} aria-label={t('quadro.tarefas.lista')}>
          <optgroup label="Ergon">{mine.filter((b) => b.origin === 'native').map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>
          {grupos.map((i) => (
            <optgroup key={i.kind} label={i.state === 'connected' ? i.name : t('quadro.tarefas.precisaReconectar', { nome: i.name })}>
              {mine.filter((b) => b.source === i.kind).map((b) => <option key={b.id} value={b.id}>{b.name.replace(/^(Planner|To Do) › /, '$1 › ')}</option>)}
              {/* mais de uma conta: a lista nova vem da conta escolhida */}
              {i.state === 'connected' && !temVariasContas(i) && <option value={`+${i.kind}`}>{t('quadro.tarefas.ligarOutra', { app: SOURCE_LABEL[i.kind] ?? i.name })}</option>}
              {temVariasContas(i) && (i.contas ?? []).filter((c) => c.state === 'connected').map((c) => <option key={c.id} value={`+${i.kind}|${c.conta}`}>{t('quadro.tarefas.ligarOutraDaConta', { app: SOURCE_LABEL[i.kind] ?? i.name, conta: nomeNaTela(c, i.name) })}</option>)}
            </optgroup>
          ))}
        </select>
        <ViewToggle view={mode} onChange={(v) => { setMode(v); save('ergon.tarefas.view', v); }} />
        {mirror && current && (
          <span className={`badge ${current.sync_state === 'error' ? 'badge--err' : ''}`}>
            {current.sync_state === 'error' ? t('quadro.tarefas.falhaAoLer', { erro: current.last_error ?? '' }) : t('quadro.tarefas.ligadaA', { app: SOURCE_LABEL[current.source ?? ''] ?? t('quadro.tarefas.aplicativo'), hora: current.last_synced_at ? fmtHora(current.last_synced_at) : '—' })}
          </span>
        )}
        {mirror && <button className="btn btn--sm" onClick={sync} disabled={syncing}>{syncing ? t('quadro.tarefas.atualizando') : t('quadro.tarefas.atualizarAgora')}</button>}
        {(
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t('quadro.tarefas.nova')} maxLength={200} aria-label={t('quadro.tarefas.novaAria')} />
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label={t('quadro.tarefas.prazoOpcional')} title={t('quadro.tarefas.prazoOpcional')} className="new-due" />
            <button className="btn btn--primary" type="submit">{t('quadro.tarefas.adicionar')}</button>
          </form>
        )}
      </div>
      {caiu && (
        <p className="warn">{t('quadro.tarefas.conexaoCaiu', { nome: caiu.name })} <button className="linkish" onClick={() => onGo('conexoes')}>{t('quadro.tarefas.reconectar')}</button></p>
      )}
      {!connected.length && (
        <p className="hint">{tn('quadro.tarefas.dicaConectar', { link: <button className="linkish" onClick={() => onGo('conexoes')}>{t('quadro.tarefas.conecte')}</button> })}</p>
      )}
      {picking && (
        <section className="card picklist">
          <div className="row"><strong>{t('quadro.tarefas.qualLista', { app: SOURCE_LABEL[picking.kind] ?? picking.kind })}</strong><span className="grow" /><button className="btn btn--sm btn--ghost" onClick={() => setPicking(null)}>{t('quadro.tarefas.fechar')}</button></div>
          {picking.error && <p className="error">{picking.error}</p>}
          {!picking.lists && <p className="muted">{t('quadro.tarefas.lendoListas')}</p>}
          <div className="row row--wrap">
            {picking.lists?.map((l) => <button key={l.externalId} className="chip" disabled={syncing} onClick={() => mirrorList(picking.kind, l.externalId, picking.conta)}>{l.name}</button>)}
            {picking.lists && !picking.lists.length && !picking.error && <span className="muted">{t('quadro.tarefas.semListas')}</span>}
          </div>
        </section>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {view.data && (
        <Board columns={view.data.columns} tasks={view.data.tasks} view={mode} editable openId={openTask}
          onOpen={setOpenTask} onMove={move} onToggle={toggle} />
      )}
      {openTask && view.data && (
        <TaskDetail taskId={openTask} columns={view.data.columns} mode={mirror ? 'mirror' : 'user'} source={current?.source} onClose={() => setOpenTask(null)} />
      )}
    </div>
  );
}
