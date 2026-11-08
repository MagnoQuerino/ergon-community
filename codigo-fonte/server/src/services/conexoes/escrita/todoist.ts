/**
 * Todoist: escrita nos projetos pela API v1. Referências (conferidas em nov/2026):
 *   https://developer.todoist.com/api/v1/ (autenticação, escopos e lista de operações)
 *   https://github.com/Doist/todoist-api-typescript (SDK oficial; src/clients/task-client.ts, src/clients/comment-client.ts,
 *   src/consts/endpoints.ts, src/types/tasks/requests.ts, src/types/comments/requests.ts: rotas, campos e "no date")
 *   https://www.todoist.com/help/todoist/integrations/find-your-api-token-Jpzx9IIlB (onde a pessoa acha o token)
 * Inverso da leitura em TodoistProvider (integrations.ts): coluna = seção ("__sem_secao__" = nenhuma); concluída = checked;
 * prazo = due.date; versão = updated_at. A leitura só traz as abertas: a tarefa fechada some dela, e o espelho não trata a
 * ausência como prova de nada (complete: false).
 */
import { fold } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita } from '../tipos.ts';

const BASE = 'https://api.todoist.com/api/v1';
const TAREFA_NO_APP = 'https://app.todoist.com/app/task';
/** coluna sintética da leitura: a tarefa fica fora de qualquer seção */
const SEM_SECAO = '__sem_secao__';
const NOME_SEM_SECAO = 'Sem seção';
const PAGINAS = 5;

const feito = (j: any, id: string): Escrita => {
  const tarefa = String(j?.id ?? id);
  const versao = j?.updated_at ?? j?.added_at;
  return { id: tarefa, versao: versao ? String(versao) : null, url: `${TAREFA_NO_APP}/${seg(tarefa)}` };
};

export function escritorTodoist(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}` };
  const escrever = async (caminho: string, body?: unknown): Promise<any> => {
    try { return await request(`${BASE}${caminho}`, { method: 'POST', headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Todoist recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };
  /** null = sem seção. O cursor é opaco e só entra na consulta: o endereço é sempre o daqui. */
  const secaoDe = async (quadro: string, coluna: string): Promise<string | null> => {
    const f = fold(coluna);
    if (coluna === SEM_SECAO || f === fold(NOME_SEM_SECAO)) return null;
    const todas: any[] = []; let cursor: unknown = null;
    for (let i = 0; i < PAGINAS; i++) {
      const j = await request(`${BASE}/sections?project_id=${encodeURIComponent(quadro)}${typeof cursor === 'string' && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: auth });
      todas.push(...(Array.isArray(j) ? j : j.results ?? []));
      cursor = Array.isArray(j) ? null : j.next_cursor;
      if (!cursor) break;
    }
    const s = todas.find((x) => String(x.id) === coluna || fold(String(x.name)) === f);
    if (!s) throw new ErroAcao(`este projeto não tem a seção "${neutral(coluna, 60)}"`, [NOME_SEM_SECAO, ...todas.map((x) => neutral(String(x.name), 60))]);
    return String(s.id);
  };
  return {
    async criar(quadro, t) {
      const secao = t.coluna ? await secaoDe(quadro, t.coluna) : null;
      const j = await escrever('/tasks', {
        content: t.titulo, project_id: quadro, ...(t.descricao ? { description: t.descricao } : {}),
        ...(secao ? { section_id: secao } : {}), ...(t.prazo ? { due_date: t.prazo } : {}),
      });
      if (!j?.id) throw new ProviderError('unavailable', 'o Todoist não confirmou a criação (pode ter feito ou não): confira lá antes de repetir');
      return feito(j, String(j.id));
    },
    async concluir(_quadro, tarefa, feita) {
      await escrever(`/tasks/${seg(tarefa)}/${feita ? 'close' : 'reopen'}`);
      return feito(null, tarefa);
    },
    // a rota aceita um destino só; sem seção = a raiz do próprio projeto
    async mover(quadro, tarefa, coluna) {
      const secao = await secaoDe(quadro, coluna);
      return feito(await escrever(`/tasks/${seg(tarefa)}/move`, secao ? { section_id: secao } : { project_id: quadro }), tarefa);
    },
    async editar(_quadro, tarefa, m) {
      const body = {
        ...(m.titulo !== undefined ? { content: m.titulo } : {}), ...(m.descricao !== undefined ? { description: m.descricao } : {}),
        ...(m.prazo === null ? { due_string: 'no date' } : m.prazo ? { due_date: m.prazo } : {}),
      };
      if (!Object.keys(body).length) return feito(null, tarefa);
      return feito(await escrever(`/tasks/${seg(tarefa)}`, body), tarefa);
    },
    async comentar(_quadro, tarefa, texto) {
      await escrever('/comments', { task_id: tarefa, content: texto });
    },
  };
}
