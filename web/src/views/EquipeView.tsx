import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api.ts';
import { useResource } from '../lib/live.ts';
import { useHashParam } from '../lib/route.ts';
import { pushRecent } from '../lib/recents.ts';
import type { AppState, BoardSummary, BoardView } from '../lib/types.ts';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { Board, ViewToggle } from '../components/Board.tsx';

/**
 * Fluxos da equipe: o quadro dos agentes. Eles registram as demandas, pegam a próxima da fila, pedem ajuda uns
 * aos outros e entregam — você acompanha quem está com cada tarefa e o que um passa ao outro, sem editar.
 * Para mudar algo, conversa com a coordenação.
 */
export function EquipeView({ state, compact, onAskCoordinator, reload }: { state: AppState; compact?: boolean; onAskCoordinator: (text: string) => void; reload: () => void }) {
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
    if (opened) pushRecent({ kind: 'card', id: opened.id, label: `#${opened.number} ${opened.title}`, where: 'Fluxos da equipe', href: `#equipe?card=${opened.id}` });
  }, [opened?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const agents = state.agents;
  const tasks = (view.data?.tasks ?? []).filter((t) => !who || t.agent_id === who || (who === '-' && !t.agent_id));
  const auto = state.teamAutorun;
  const setAuto = async (enabled: boolean) => {
    setErr(null);
    try { await api.put('/api/team/autorun', { enabled }); reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const working = (view.data?.tasks ?? []).filter((t) => t.run_status).length;
  const todo = view.data?.columns.find((c) => c.name === 'A fazer')?.id;
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
          <h2>Fluxos da equipe</h2>
          <p className="muted">O quadro dos agentes: quem está com cada tarefa, o que um passa ao outro e o que espera na fila. É automático — você acompanha e, para mudar algo, fala com a coordenação.</p>
        </header>
      )}
      <div className="toolbar">
        <ViewToggle view={mode} onChange={setMode} />
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Agente">
          <option value="">Todos os agentes</option>
          <option value="-">Na triagem</option>
          {agents.filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span className="grow" />
        {!compact && (
          <label className={`switch ${auto ? 'switch--on' : ''}`} title="Quando ligado, a equipe pega as tarefas de “A fazer”, de cima para baixo, até o limite de trabalhos ao mesmo tempo (Configurações)">
            <input type="checkbox" checked={auto} onChange={(e) => void setAuto(e.target.checked)} />
            <span>Andamento automático {auto ? 'ligado' : 'desligado'}</span>
          </label>
        )}
      </div>
      {!compact && (
        <p className="hint">
          {auto
            ? `A equipe pega as tarefas de “A fazer” de cima para baixo, ${lim === null ? 'sem limite de trabalhos ao mesmo tempo' : `até ${lim} ao mesmo tempo`}${working ? ` (agora: ${working} em andamento)` : ''}; o resto espera a vez. Arraste para mudar a ordem ou marque Prioridade no card. Conversas não entram no limite.`
            : 'Desligado: os agentes só trabalham quando você conversa com eles. Ligue para a equipe dar andamento à fila sozinha (cada tarefa usa o modelo de IA e conta no consumo).'}
        </p>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {view.data && <Board columns={view.data.columns} tasks={tasks} agents={agents} view={mode} editable={false} openId={openTask} onOpen={setOpenTask} team
        queueColumn={todo} onReorder={who ? undefined : (id, before) => void reorder(id, before)} />}
      {openTask && view.data && (
        <TaskDetail taskId={openTask} columns={view.data.columns} agents={agents} mode="team" onClose={() => setOpenTask(null)} onAskCoordinator={onAskCoordinator} />
      )}
    </div>
  );
}
