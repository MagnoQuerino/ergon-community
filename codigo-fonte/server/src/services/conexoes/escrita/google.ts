/**
 * Google Tasks: escrita nas listas. Inverso da leitura em GoogleTasksProvider (integrations.ts): quadro = lista; só existem
 * as colunas sintéticas "open" e "done", que são a própria situação (mover entre elas = concluir ou reabrir); concluída =
 * status completed; prazo = due; versão = etag. Tarefa sem título some da leitura, por isso título vazio é erro. A API não
 * tem comentários: `comentar` fica de fora.
 * Referências (conferidas em 05/11/2026):
 *   https://developers.google.com/workspace/tasks/reference/rest/v1/tasks (limites de title e notes; due guarda só o dia)
 *   https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert
 *   https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/patch
 *   https://developers.google.com/workspace/tasks/auth (permissão de escrita)
 */
import { validDue } from '../../due.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita, type Http, type MudancaTarefa } from '../tipos.ts';

const BASE = 'https://tasks.googleapis.com/tasks/v1';
export const ESCOPO_TAREFAS = 'https://www.googleapis.com/auth/tasks';
const MAX_TITULO = 1024;
const MAX_NOTAS = 8192;
const COLUNAS = ['open', 'done'];

const feitaNa = (coluna: string): boolean => {
  if (!COLUNAS.includes(coluna)) throw new ErroAcao(`o Google Tasks só tem as colunas "open" (a fazer) e "done" (concluídas), não "${coluna}"`, COLUNAS);
  return coluna === 'done';
};
const titulo = (v: string): string => {
  const t = v.trim();
  if (!t) throw new ErroAcao('a tarefa precisa de um título: sem ele, o Google Tasks não a mostra');
  if (t.length > MAX_TITULO) throw new ErroAcao(`título longo demais: o Google Tasks aceita até ${MAX_TITULO} caracteres`);
  return t;
};
const notas = (v: string): string => {
  if (v.length > MAX_NOTAS) throw new ErroAcao(`descrição longa demais: o Google Tasks aceita até ${MAX_NOTAS} caracteres`);
  return v;
};
/** A API guarda só o dia; a leitura (dueOf) pega os dez primeiros caracteres, então a meia-noite UTC não desloca a data. */
const prazo = (v: string): string => {
  const d = v.trim().slice(0, 10);
  if (!validDue(d)) throw new ErroAcao('"prazo" precisa ser uma data válida no formato AAAA-MM-DD');
  return `${d}T00:00:00.000Z`;
};

export function escritorGoogle(http: Http): EscritorTarefas {
  const lista = (quadro: string) => {
    if (!quadro) throw new ErroAcao('falta dizer em qual lista do Google Tasks');
    return `${BASE}/lists/${seg(quadro)}/tasks`;
  };
  const feito = (j: any, id = ''): Escrita => ({ id: String(j?.id ?? id), versao: j?.etag ? String(j.etag) : null, url: j?.webViewLink ? String(j.webViewLink) : null });
  const patch = async (quadro: string, tarefa: string, corpo: Record<string, unknown>) =>
    feito(await http(`${lista(quadro)}/${seg(tarefa)}`, { method: 'PATCH', body: corpo, kind: 'write' }), tarefa);
  // reabrir limpa também o carimbo de conclusão: a API só o omite em tarefa não concluída
  const situacao = (feita: boolean) => (feita ? { status: 'completed' } : { status: 'needsAction', completed: null });
  return {
    escopos: [ESCOPO_TAREFAS],
    async criar(quadro, t) {
      const corpo = {
        title: titulo(t.titulo), ...(t.descricao ? { notes: notas(t.descricao) } : {}), ...(t.prazo ? { due: prazo(t.prazo) } : {}),
        ...(t.coluna && feitaNa(t.coluna) ? { status: 'completed' } : {}),
      };
      return feito(await http(lista(quadro), { method: 'POST', body: corpo, kind: 'write' }));
    },
    concluir: (quadro, tarefa, feita) => patch(quadro, tarefa, situacao(feita)),
    mover: async (quadro, tarefa, coluna) => patch(quadro, tarefa, situacao(feitaNa(coluna))),
    async editar(quadro, tarefa, m: MudancaTarefa) {
      const corpo = {
        ...(m.titulo !== undefined ? { title: titulo(m.titulo) } : {}), ...(m.descricao !== undefined ? { notes: notas(m.descricao) } : {}),
        ...(m.prazo !== undefined ? { due: m.prazo === null ? null : prazo(m.prazo) } : {}),
      };
      if (!Object.keys(corpo).length) throw new ErroAcao('nada para mudar: diga título, descrição ou prazo');
      return patch(quadro, tarefa, corpo);
    },
  };
}
