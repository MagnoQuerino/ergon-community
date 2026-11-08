/**
 * Microsoft: escrita no Planner (planos e buckets) e no To Do (listas). `http` já vem autenticado com a conta.
 * Inverso da leitura em MicrosoftTasksProvider (integrations.ts). Ids de quadro: "planner:<planId>" e "todo:<listId>".
 *   Planner: coluna = bucket; concluída = percentComplete 100; prazo = instante em UTC (dueAt); versão = @odata.etag.
 *   To Do: colunas sintéticas open/done = status; prazo = a data à meia-noite em UTC (dueOf); versão = lastModifiedDateTime.
 * Permissão: Tasks.ReadWrite delegada, sem consentimento de administrador. Planner não existe em conta pessoal; To Do existe.
 * Planner não tem comentário pela API e To Do também não: `comentar` não existe aqui.
 * Referências (Microsoft Graph v1.0, conferidas em 05/11/2026):
 *   https://learn.microsoft.com/en-us/graph/api/planner-post-tasks?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/plannertask-get?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/plannertask-update?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/plannertaskdetails-get?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/plannertaskdetails-update?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/plannerplan-list-buckets?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/resources/planner-overview?view=graph-rest-1.0 (etag, 409 e 412)
 *   https://learn.microsoft.com/en-us/graph/api/todotasklist-post-tasks?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/api/todotask-update?view=graph-rest-1.0 ("only HTML type is supported")
 *   https://learn.microsoft.com/en-us/graph/api/resources/datetimetimezone?view=graph-rest-1.0
 *   https://learn.microsoft.com/en-us/graph/permissions-reference (Tasks.ReadWrite)
 */
import { validDue } from '../../due.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DEFAULT_TZ, validTz, zonedToUtc } from '../../routine-time.ts';
import { recusado } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita, type Http } from '../tipos.ts';

const BASE = 'https://graph.microsoft.com/v1.0';
const ORIGEM = new URL(BASE).origin;
const COLUNAS_TODO = ['open', 'done'];
type Parte = Pick<EscritorTarefas, 'criar' | 'concluir' | 'mover' | 'editar'>;
type Corpo = Record<string, unknown>;

function quadroDe(quadro: string): { tipo: 'planner' | 'todo'; id: string } {
  const texto = String(quadro ?? '');
  const i = texto.indexOf(':');
  const tipo = texto.slice(0, Math.max(i, 0)); const id = texto.slice(i + 1);
  if ((tipo !== 'planner' && tipo !== 'todo') || !id) throw new ErroAcao(`quadro inválido: "${neutral(texto, 60)}". Use "planner:<id do plano>" ou "todo:<id da lista>"`);
  return { tipo, id };
}

const tituloOk = (s: string): string => {
  const t = s?.trim();
  if (!t) throw new ErroAcao('a tarefa precisa de um título');
  return t;
};
const diaOk = (prazo: string): string => {
  if (!validDue(prazo)) throw new ErroAcao(`prazo inválido: "${neutral(String(prazo), 40)}". Use AAAA-MM-DD`);
  return prazo;
};
/** Fim do dia no fuso do workspace, como o próprio Planner guarda (25/10 em Brasília = 2026-10-26T02:59:59Z): dueAt devolve a mesma data. */
function instantePrazo(prazo: string, tz: string): string {
  const [y, m, d] = diaOk(prazo).split('-').map(Number);
  return new Date(zonedToUtc(tz, y, m, d, 23, 59) + 59_000).toISOString().replace('.000Z', 'Z');
}
/** A data à meia-noite em UTC, como o To Do devolve e dueOf lê: converter para o fuso do workspace erraria o dia na leitura. */
const prazoTodo = (prazo: string) => ({ dateTime: `${diaOk(prazo)}T00:00:00.0000000`, timeZone: 'UTC' });
/** A documentação da atualização diz que `body` só aceita HTML. O texto vai escapado: um "<" digitado não vira marcação. */
const corpoTodo = (texto: string) => ({ contentType: 'html', content: texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>') });

const idCriado = (j: any): string => {
  if (!j?.id) throw new ErroAcao('o aplicativo não devolveu o id da tarefa criada: confira lá antes de criar de novo');
  return String(j.id);
};
/** Continuação da lista: o endereço vem da resposta, então só segue no próprio Graph (o token nunca vai a outro lugar). */
const proximaPagina = (link: unknown): string | null => {
  if (!link) return null;
  const u = URL.canParse(String(link)) ? new URL(String(link)) : null;
  if (!u || u.origin !== ORIGEM) throw new ProviderError('unavailable', 'o serviço indicou uma continuação fora do Microsoft Graph: recusada');
  return u.href;
};
/** Pedido errado (ex.: prazo antes do início): repetir não adianta, então vira erro que a pessoa entende. */
async function escreve(http: Http, url: string, init: Parameters<Http>[1]): Promise<any> {
  try { return await http(url, init); } catch (e) {
    if (recusado(e)) throw new ErroAcao(`o aplicativo recusou a alteração: ${neutral(e.message, 240)}`);
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------------- Planner
function escritorPlanner(http: Http, tz: string): Parte {
  const urlTarefa = (t: string) => `${BASE}/planner/tasks/${seg(t)}`;
  const etag = (j: any): string | null => (j?.['@odata.etag'] ? String(j['@odata.etag']) : null);
  const conflito = (e: unknown): e is ProviderError => e instanceof ProviderError && (e.status === 412 || e.status === 409);

  /** PATCH com a versão mais nova (If-Match). Se outra pessoa mexeu no meio (412; a documentação manda tratar 409 igual), relê e repete uma vez. */
  const comVersao = async (url: string, corpo: Corpo, lido?: any): Promise<any> => {
    const tenta = (j: any) => {
      const marca = etag(j);
      if (!marca) throw new ProviderError('unavailable', 'o Planner não informou a versão do item');
      return escreve(http, url, { method: 'PATCH', headers: { 'If-Match': marca, Prefer: 'return=representation' }, body: corpo, kind: 'write' });
    };
    try { return await tenta(lido ?? await http(url)); } catch (e) { if (!conflito(e)) throw e; }
    try { return await tenta(await http(url)); } catch (e) {
      if (conflito(e)) throw new ProviderError('unavailable', 'a tarefa mudou no Planner ao mesmo tempo, duas vezes seguidas: tente de novo', { status: e.status ?? undefined });
      throw e;
    }
  };
  const ler = async (plano: string, tarefa: string): Promise<any> => {
    const j = await http(urlTarefa(tarefa));
    if (j?.planId && String(j.planId) !== plano) throw new ErroAcao('esta tarefa não é deste plano do Planner');
    return j;
  };
  const patch = async (tarefa: string, corpo: Corpo, lido?: any): Promise<Escrita> => ({ id: tarefa, versao: etag(await comVersao(urlTarefa(tarefa), corpo, lido)), url: null });
  const gravaDescricao = (tarefa: string, texto: string) => comVersao(`${urlTarefa(tarefa)}/details`, { description: texto });
  /**
   * A versão da tarefa depois de gravar a descrição (os detalhes têm versão própria). Na criação, é a versão que o vínculo
   * guarda: a leitura seguinte, com ela, não mexe no card, que já tem o que a pessoa escreveu. Depois de uma edição, o espelho
   * (conexoes/espelho.ts) não usa a versão devolvida: apaga a do vínculo e a descrição que a leitura guardou pela versão
   * (esquecerLeitura, em integrations.ts), e a leitura seguinte relê os detalhes e compara os campos.
   * Se esta releitura falhar, a descrição já foi gravada: sem versão, a próxima leitura confere.
   */
  const versaoAgora = async (tarefa: string): Promise<string | null> => { try { return etag(await http(urlTarefa(tarefa))); } catch { return null; } };

  const buckets = async (plano: string): Promise<Array<{ id: string; nome: string }>> => {
    const out: any[] = [];
    let url: string | null = `${BASE}/planner/plans/${seg(plano)}/buckets`;
    for (let i = 0; url && i < 10; i++) {
      const j: any = await http(url);
      out.push(...(j?.value ?? []));
      url = proximaPagina(j?.['@odata.nextLink']);
    }
    return out.map((b) => ({ id: String(b.id), nome: String(b.name ?? '') }));
  };
  const bucketDe = (lista: Array<{ id: string; nome: string }>, coluna: string): string => {
    if (lista.some((b) => b.id === coluna)) return coluna;
    throw new ErroAcao(`a coluna "${neutral(String(coluna ?? ''), 60)}" não existe neste plano`, lista.map((b) => `${neutral(b.nome, 60)} (id: ${b.id})`));
  };

  return {
    async criar(plano, t) {
      const title = tituloOk(t.titulo);
      const due = t.prazo ? instantePrazo(t.prazo, tz) : null;
      const lista = await buckets(plano);
      // sem coluna, a primeira, como na leitura; plano sem bucket nenhum cria sem (só planId é obrigatório)
      const bucketId = t.coluna ? bucketDe(lista, t.coluna) : lista[0]?.id;
      const j = await escreve(http, `${BASE}/planner/tasks`, { method: 'POST', kind: 'write', body: { planId: plano, title, ...(bucketId ? { bucketId } : {}), ...(due ? { dueDateTime: due } : {}) } });
      const id = idCriado(j);
      if (!t.descricao) return { id, versao: etag(j), url: null };
      try { await gravaDescricao(id, t.descricao); } catch (e) {
        // a tarefa já existe lá: um erro comum faria criar de novo e duplicar
        throw new ErroAcao(`a tarefa foi criada no Planner (id: ${id}), mas a descrição não entrou (${e instanceof Error ? neutral(e.message, 160) : 'erro'}). Não crie de novo: edite essa tarefa`, undefined, { id, versao: etag(j), url: null });
      }
      return { id, versao: await versaoAgora(id), url: null };
    },
    async concluir(plano, tarefa, feita) {
      const atual = await ler(plano, tarefa);
      // já está assim: não regrava (reabrir o que está em 50% apagaria o andamento à toa)
      if ((Number(atual?.percentComplete) === 100) === feita) return { id: tarefa, versao: etag(atual), url: null };
      return patch(tarefa, { percentComplete: feita ? 100 : 0 }, atual);
    },
    async mover(plano, tarefa, coluna) {
      const alvo = bucketDe(await buckets(plano), coluna);
      const atual = await ler(plano, tarefa);
      if (String(atual?.bucketId ?? '') === alvo) return { id: tarefa, versao: etag(atual), url: null };
      return patch(tarefa, { bucketId: alvo }, atual);
    },
    async editar(plano, tarefa, m) {
      const campos: Corpo = {
        ...(m.titulo !== undefined ? { title: tituloOk(m.titulo) } : {}),
        ...(m.prazo !== undefined ? { dueDateTime: m.prazo === null ? null : instantePrazo(m.prazo, tz) } : {}),
      };
      let r: Escrita = { id: tarefa };
      if (Object.keys(campos).length) r = await patch(tarefa, campos, await ler(plano, tarefa));
      if (m.descricao !== undefined) { await gravaDescricao(tarefa, m.descricao); r = { id: tarefa, versao: await versaoAgora(tarefa), url: null }; }
      return r;
    },
  };
}

// --------------------------------------------------------------------------------------------------------- To Do
function escritorTodo(http: Http): Parte {
  const urlLista = (l: string) => `${BASE}/me/todo/lists/${seg(l)}/tasks`;
  const feito = (j: any, id: string): Escrita => ({ id, versao: j?.lastModifiedDateTime ? String(j.lastModifiedDateTime) : null, url: null });
  const patch = async (lista: string, tarefa: string, corpo: Corpo): Promise<Escrita> =>
    feito(await escreve(http, `${urlLista(lista)}/${seg(tarefa)}`, { method: 'PATCH', body: corpo, kind: 'write' }), tarefa);
  const status = (feita: boolean) => ({ status: feita ? 'completed' : 'notStarted' });
  /** As duas colunas de uma lista são sintéticas (ver getBoard): estar em "done" é estar concluída. */
  const colunaFeita = (coluna: string): boolean => {
    if (!COLUNAS_TODO.includes(coluna)) throw new ErroAcao(`a coluna "${neutral(String(coluna ?? ''), 60)}" não existe numa lista do To Do`, COLUNAS_TODO);
    return coluna === 'done';
  };
  return {
    async criar(lista, t) {
      const corpo: Corpo = {
        title: tituloOk(t.titulo),
        ...(t.descricao ? { body: corpoTodo(t.descricao) } : {}),
        ...(t.prazo ? { dueDateTime: prazoTodo(t.prazo) } : {}),
        ...(t.coluna && colunaFeita(t.coluna) ? status(true) : {}),
      };
      const j = await escreve(http, urlLista(lista), { method: 'POST', body: corpo, kind: 'write' });
      return feito(j, idCriado(j));
    },
    concluir: (lista, tarefa, feita) => patch(lista, tarefa, status(feita)),
    mover: async (lista, tarefa, coluna) => patch(lista, tarefa, status(colunaFeita(coluna))),
    async editar(lista, tarefa, m) {
      const corpo: Corpo = {
        ...(m.titulo !== undefined ? { title: tituloOk(m.titulo) } : {}),
        ...(m.descricao !== undefined ? { body: corpoTodo(m.descricao) } : {}),
        ...(m.prazo !== undefined ? { dueDateTime: m.prazo === null ? null : prazoTodo(m.prazo) } : {}),
      };
      return Object.keys(corpo).length ? patch(lista, tarefa, corpo) : { id: tarefa };
    },
  };
}

/** `tz`: fuso do workspace, o mesmo que a leitura usa no prazo do Planner. */
export function escritorMicrosoft(http: Http, tz: string = DEFAULT_TZ): EscritorTarefas {
  const partes = { planner: escritorPlanner(http, validTz(tz) ? tz : DEFAULT_TZ), todo: escritorTodo(http) };
  const de = (quadro: string) => { const q = quadroDe(quadro); return { w: partes[q.tipo], id: q.id }; };
  return {
    escopos: ['Tasks.ReadWrite'],
    async criar(quadro, t) { const { w, id } = de(quadro); return w.criar(id, t); },
    async concluir(quadro, tarefa, feita) { const { w, id } = de(quadro); return w.concluir(id, tarefa, feita); },
    async mover(quadro, tarefa, coluna) { const { w, id } = de(quadro); return w.mover(id, tarefa, coluna); },
    async editar(quadro, tarefa, m) { const { w, id } = de(quadro); return w.editar(id, tarefa, m); },
  };
}
