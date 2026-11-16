/**
 * Ala "Na nuvem" do Ambiente operacional: a leitura dos Jobs do World para a Central de Trabalho. É outro pool, com
 * a capacidade do plano do workspace (job_slots do World), nunca somado ao local. As regras são as do serviço central
 * do World: admitido, em execução e cancelando reservam vaga; na fila e esperando saldo não reservam (e não
 * são cobrados). Fonte indisponível vira "indisponível" com a última leitura, nunca "zero".
 */
export interface RemoteJobsRaw {
  slots: number; running: number;
  jobs: Array<{ id: string; state: string; routineRef: string; queuedAt: string; startedAt: string | null; mine: boolean }>;
}
export interface RemotePool {
  available: true; fetchedAt: string; stale: boolean;
  /** capacidade do plano (vagas de Jobs do workspace) */
  slots: number;
  /** vagas reservadas: em execução + iniciando (admitido) + parando (cancelamento pedido) */
  reserved: number; running: number; starting: number; stopping: number;
  /** esperando vaga (não cobrado) e esperando saldo de créditos */
  queued: number; waitingBalance: number;
  /** só os seus pedidos aparecem com o nome da rotina; os dos outros, só na contagem */
  mine: Array<{ id: string; state: 'executando' | 'iniciando' | 'parando' | 'na_fila' | 'sem_saldo'; routineRef: string; since: string }>;
}
export interface RemoteUnavailable { available: false; reason: 'nao_configurado' | 'sem_conta' | 'sem_workspace' | 'offline' | 'erro'; message: string; last: RemotePool | null }

const STATE: Record<string, RemotePool['mine'][number]['state']> = {
  running: 'executando', admitted: 'iniciando', cancel_requested: 'parando', queued: 'na_fila', waiting_balance: 'sem_saldo',
};

export function normalizeJobs(raw: RemoteJobsRaw, at = new Date().toISOString()): RemotePool {
  const n = (s: string) => raw.jobs.filter((j) => j.state === s).length;
  const running = n('running'); const starting = n('admitted'); const stopping = n('cancel_requested');
  return {
    available: true, fetchedAt: at, stale: false, slots: Math.max(0, Number(raw.slots) || 0),
    reserved: running + starting + stopping, running, starting, stopping, queued: n('queued'), waitingBalance: n('waiting_balance'),
    mine: raw.jobs.filter((j) => j.mine && STATE[j.state]).slice(0, 20)
      .map((j) => ({ id: j.id, state: STATE[j.state], routineRef: String(j.routineRef).slice(0, 80), since: j.startedAt ?? j.queuedAt })),
  };
}
