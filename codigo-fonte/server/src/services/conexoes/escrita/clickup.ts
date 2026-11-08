/**
 * ClickUp: escrita nas listas pela API v2. Referências (conferidas em nov/2026):
 *   https://developer.clickup.com/reference/createtask e .../updatetask (campos; descrição com um espaço esvazia)
 *   https://developer.clickup.com/reference/createtaskcomment (comment_text e notify_all são obrigatórios)
 *   https://developer.clickup.com/reference/getlist (statuses: status, type, orderindex)
 *   https://developer.clickup.com/docs/authentication (token pessoal direto no cabeçalho Authorization)
 * Inverso da leitura em ClickUpProvider (task-providers.ts): coluna = situação por nome ("__tarefas__" = lista sem situações);
 * concluída = situação do tipo "done" ou "closed"; prazo = due_date em ms; versão = date_updated.
 */
import { fold } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita } from '../tipos.ts';

const BASE = 'https://api.clickup.com/api/v2';
/** coluna sintética de lista sem situações (ver getBoard) */
const UMA_COLUNA = '__tarefas__';
/** O ClickUp guarda um instante: meio-dia em UTC cai no mesmo dia em quase todos os fusos, e a leitura corta em UTC. */
const prazoDe = (d: string) => Date.parse(`${d}T12:00:00.000Z`);

interface Situacao { nome: string; tipo: string }
const feito = (j: any, id: string): Escrita => ({ id: String(j?.id ?? id), versao: j?.date_updated ? String(j.date_updated) : null, url: j?.url ? String(j.url) : null });

export function escritorClickUp(token: string): EscritorTarefas {
  const auth = { Authorization: token };
  const escrever = async (method: 'POST' | 'PUT', caminho: string, body: unknown): Promise<any> => {
    try { return await request(`${BASE}${caminho}`, { method, headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o ClickUp recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };
  const situacoes = async (quadro: string): Promise<Situacao[]> => {
    const l = await request(`${BASE}/list/${seg(quadro)}`, { headers: auth });
    return [...((l.statuses ?? []) as any[])].sort((a, b) => Number(a.orderindex) - Number(b.orderindex)).map((s) => ({ nome: String(s.status), tipo: String(s.type ?? '') }));
  };
  const nomes = (todas: Situacao[]) => todas.map((s) => neutral(s.nome, 60));
  const situacaoDe = async (quadro: string, coluna: string): Promise<string> => {
    const todas = await situacoes(quadro);
    const f = fold(coluna);
    const s = todas.find((x) => fold(x.nome) === f);
    if (!s) throw new ErroAcao(`esta lista não tem a situação "${neutral(coluna, 60)}"`, nomes(todas));
    return s.nome;
  };
  const put = async (tarefa: string, body: Record<string, unknown>) => feito(await escrever('PUT', `/task/${seg(tarefa)}`, body), tarefa);
  return {
    async criar(quadro, t) {
      const status = t.coluna && t.coluna !== UMA_COLUNA ? await situacaoDe(quadro, t.coluna) : null;
      const j = await escrever('POST', `/list/${seg(quadro)}/task`, {
        name: t.titulo, ...(t.descricao ? { description: t.descricao } : {}), ...(status ? { status } : {}),
        ...(t.prazo ? { due_date: prazoDe(t.prazo), due_date_time: false } : {}),
      });
      if (!j?.id) throw new ProviderError('unavailable', 'o ClickUp não confirmou a criação (pode ter feito ou não): confira lá antes de repetir');
      return feito(j, String(j.id));
    },
    async concluir(quadro, tarefa, feita) {
      const todas = await situacoes(quadro);
      const fechada = (s: Situacao) => s.tipo === 'done' || s.tipo === 'closed';
      const alvo = feita ? todas.find((s) => s.tipo === 'done') ?? todas.find(fechada) : todas.find((s) => s.tipo === 'open') ?? todas.find((s) => !fechada(s));
      if (!alvo) throw new ErroAcao(`esta lista não tem situação ${feita ? 'de concluído' : 'em aberto'}: não dá para ${feita ? 'concluir' : 'reabrir'} por aqui`, nomes(todas));
      return put(tarefa, { status: alvo.nome });
    },
    async mover(quadro, tarefa, coluna) {
      if (coluna === UMA_COLUNA) return { id: tarefa };
      return put(tarefa, { status: await situacaoDe(quadro, coluna) });
    },
    async editar(_quadro, tarefa, m) {
      const body = {
        ...(m.titulo !== undefined ? { name: m.titulo } : {}), ...(m.descricao !== undefined ? { description: m.descricao || ' ' } : {}),
        ...(m.prazo !== undefined ? { due_date: m.prazo === null ? null : prazoDe(m.prazo), due_date_time: false } : {}),
      };
      if (!Object.keys(body).length) return { id: tarefa };
      const j = await escrever('PUT', `/task/${seg(tarefa)}`, body);
      // a documentação não diz como tirar o prazo: o null só vale se a resposta confirmar
      if (m.prazo === null && j?.due_date) throw new ErroAcao('o ClickUp não tirou o prazo desta tarefa: tire pelo próprio ClickUp');
      return feito(j, tarefa);
    },
    async comentar(_quadro, tarefa, texto) {
      await escrever('POST', `/task/${seg(tarefa)}/comment`, { comment_text: texto, notify_all: false });
    },
  };
}
