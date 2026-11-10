import { useEffect, useMemo, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useHashParam } from '../lib/route.ts';
import { pushRecent } from '../lib/recents.ts';
import { agentOptions } from '../lib/team.ts';
import type { AppState, BoardSummary, BoardView } from '../lib/types.ts';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { Board, ViewToggle } from '../components/Board.tsx';
import { useT } from '../i18n/index.ts';

/**
 * Fluxos da equipe: o quadro dos agentes. Eles registram as demandas, pegam a próxima da fila, pedem ajuda uns
 * aos outros e entregam — você acompanha quem está com cada tarefa e o que um passa ao outro, sem editar.
 * Para mudar algo, conversa com a coordenação.
 */
export function EquipeView({ state, compact, onAskCoordinator, reload }: { state: AppState; compact?: boolean; onAskCoordinator: (text: string) => void; reload: () => void }) {
  const t = useT();
  const boards = useResource<BoardSummary[]>('/api/boards', ['tasks.changed']);
  const team = boards.data?.find((b) => b.audience === 'team');
  const view = useResource<BoardView>(team ? `/api/boards/${team.id}` : null, ['tasks.changed', 'runs.changed']);
  // quadro ou lista: vale a última escolha (antes, voltava ao quadro a cada visita)
  const [mode, setMode] = useState<'kanban' | 'lista'>(() => { try { return localStorage.getItem('ergon.equipe.view') === 'lista' ? 'lista' : 'kanban'; } catch { return 'kanban'; } });
  useEffect(() => { try { localStorage.setItem('ergon.equipe.view', mode); } catch { /* sem armazenamento */ } }, [mode]);
  const [who, setWho] = useState('');
  // card aberto no endereço (#equipe?card=…): atualizar a página mantém, o Voltar fecha
  const [openTask, setOpenTask] = useHashParam('card');
  const [err, setErr] = useState<string | null>(null);
  // card aberto entra nos recentes da busca (Ctrl+K)
  const opened = view.data?.tasks.find((t) => t.id === openTask);
  useEffect(() => {
    if (opened) pushRecent({ kind: 'card', id: opened.id, label: `#${opened.number} ${opened.title}`, where: t('quadro.equipe.titulo'), href: `#equipe?card=${opened.id}` });
  }, [opened?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // o filtro "Agente": quem tem card neste quadro (o nome vem no card), não a equipe inteira
  const options = useMemo(() => agentOptions(view.data?.tasks ?? []), [view.data?.tasks]);
  // escolhido sem card agora (o último foi concluído e saiu, por exemplo): volta a mostrar todos
  const pick = !who || who === '-' || !view.data || options.some((o) => o.id === who) ? who : '';
  const tasks = (view.data?.tasks ?? []).filter((x) => !pick || x.agent_id === pick || (pick === '-' && !x.agent_id));
  const auto = state.teamAutorun;
  const setAuto = async (enabled: boolean) => {
    setErr(null);
    try { await api.put('/api/team/autorun', { enabled }); reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const working = (view.data?.tasks ?? []).filter((x) => x.run_status).length;
  const todo = view.data?.columns.find((c) => c.system_key === 'todo')?.id;
  const lim = state.runs.limit.limit;
  // arrastar na fila: a ordem vai para o servidor; o quadro se atualiza pelo aviso de mudança
  const reorder = async (taskId: string, before: string | null) => {
    setErr(null);
    try { await api.post(`/api/tasks/${taskId}/queue`, { before }); view.reload(); } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <div className={`page page--board ${compact ? 'page--compact' : ''}`}>
      {!compact && (
        <header className="page__head">
          <h2>{t('quadro.equipe.titulo')}</h2>
          <p className="muted">{t('quadro.equipe.sub')}</p>
        </header>
      )}
      <div className="toolbar">
        <ViewToggle view={mode} onChange={setMode} />
        <select value={pick} onChange={(e) => setWho(e.target.value)} aria-label={t('quadro.equipe.agente')}>
          <option value="">{t('quadro.equipe.todos')}</option>
          <option value="-">{t('quadro.equipe.naTriagem')}</option>
          {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className="grow" />
        {!compact && (
          <label className={`switch ${auto ? 'switch--on' : ''}`} title={t('quadro.equipe.autoDica')}>
            <input type="checkbox" checked={auto} onChange={(e) => void setAuto(e.target.checked)} />
            <span>{auto ? t('quadro.equipe.autoLigado') : t('quadro.equipe.autoDesligado')}</span>
          </label>
        )}
      </div>
      {!compact && (
        <p className="hint">
          {auto
            ? t('quadro.equipe.dicaLigado', { limite: lim === null ? t('quadro.equipe.semLimite') : t('quadro.equipe.ateLimite', { n: lim }), agora: working ? t('quadro.equipe.agora', { n: working }) : '' })
            : t('quadro.equipe.dicaDesligado')}
        </p>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {view.data && <Board columns={view.data.columns} tasks={tasks} view={mode} editable={false} openId={openTask} onOpen={setOpenTask} team
        queueColumn={todo} onReorder={pick ? undefined : (id, before) => void reorder(id, before)} />}
      {openTask && view.data && (
        <TaskDetail taskId={openTask} columns={view.data.columns} mode="team" onClose={() => setOpenTask(null)} onAskCoordinator={onAskCoordinator} />
      )}
    </div>
  );
}
