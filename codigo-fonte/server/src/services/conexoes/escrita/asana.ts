/**
 * Asana: escrita nos projetos. Referência: developers.asana.com/reference (tasks, sections, stories).
 * Inverso da leitura em AsanaProvider (integrations.ts): coluna = seção; concluída = completed; prazo = due_on; versão = modified_at.
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita } from '../tipos.ts';

const BASE = 'https://app.asana.com/api/1.0';
/** coluna sintética de projeto sem seções (ver getBoard) */
const SEM_SECAO = '__geral__';
const CAMPOS = 'opt_fields=modified_at,permalink_url';

export function escritorAsana(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}` };
  const escrever = async (method: 'POST' | 'PUT', caminho: string, data: Record<string, unknown>): Promise<any> => {
    try { return await request(`${BASE}${caminho}`, { method, headers: auth, body: { data }, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Asana recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };
  const feito = (j: any, id: string): Escrita => ({ id: String(j?.data?.gid ?? id), versao: j?.data?.modified_at ? String(j.data.modified_at) : null, url: j?.data?.permalink_url ? String(j.data.permalink_url) : null });
  const put = async (tarefa: string, data: Record<string, unknown>) => feito(await escrever('PUT', `/tasks/${seg(tarefa)}?${CAMPOS}`, data), tarefa);
  return {
    async criar(quadro, t) {
      const coluna = t.coluna && t.coluna !== SEM_SECAO ? t.coluna : null;
      const j = await escrever('POST', `/tasks?${CAMPOS}`, {
        name: t.titulo, ...(t.descricao ? { notes: t.descricao } : {}), ...(t.prazo ? { due_on: t.prazo } : {}),
        ...(coluna ? { memberships: [{ project: quadro, section: coluna }] } : { projects: [quadro] }),
      });
      if (!j?.data?.gid) throw new ProviderError('unavailable', 'o Asana não confirmou a criação (pode ter feito ou não): confira lá antes de repetir');
      return feito(j, String(j.data.gid));
    },
    concluir: (_quadro, tarefa, feita) => put(tarefa, { completed: feita }),
    async mover(_quadro, tarefa, coluna) {
      if (coluna === SEM_SECAO) return { id: tarefa };
      await escrever('POST', `/sections/${seg(coluna)}/addTask`, { task: tarefa });
      return { id: tarefa, versao: null };
    },
    editar: (_quadro, tarefa, m) => put(tarefa, { ...(m.titulo !== undefined ? { name: m.titulo } : {}), ...(m.descricao !== undefined ? { notes: m.descricao } : {}), ...(m.prazo !== undefined ? { due_on: m.prazo } : {}) }),
    async comentar(_quadro, tarefa, texto) {
      await escrever('POST', `/tasks/${seg(tarefa)}/stories`, { text: texto });
    },
  };
}
