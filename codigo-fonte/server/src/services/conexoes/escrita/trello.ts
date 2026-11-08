/**
 * Trello: escrita nos quadros. Referências (conferidas em nov/2026):
 *   https://developer.atlassian.com/cloud/trello/rest/api-group-cards/ (POST /cards e PUT /cards/{id}: aceitam corpo JSON)
 *   https://developer.atlassian.com/cloud/trello/swagger.v3.json (parâmetros: due aceita null; dueComplete; text do comentário, na consulta)
 *   https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/ (cabeçalho Authorization e escopos read/write)
 *   https://developer.atlassian.com/cloud/trello/guides/rest-api/object-definitions/ (campos do cartão)
 * Inverso da leitura em TrelloProvider (task-providers.ts): coluna = lista; concluída = dueComplete ou lista cujo nome casa com
 * DONE; prazo = due; versão = dateLastActivity. Chave e token vão só no cabeçalho, nunca no endereço.
 */
import { fold } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita } from '../tipos.ts';

const BASE = 'https://api.trello.com/1';
/** O Trello guarda um instante: meio-dia em UTC cai no mesmo dia em quase todos os fusos (meia-noite viraria a véspera no Brasil). */
const prazoDe = (d: string) => `${d}T12:00:00.000Z`;

interface Lista { id: string; nome: string }
const feito = (j: any, id: string): Escrita => ({ id: String(j?.id ?? id), versao: j?.dateLastActivity ? String(j.dateLastActivity) : null, url: j?.shortUrl ? String(j.shortUrl) : j?.url ? String(j.url) : null });

export function escritorTrello(key: string, token: string): EscritorTarefas {
  const auth = { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` };
  const escrever = async (method: 'POST' | 'PUT', caminho: string, body?: unknown): Promise<any> => {
    try { return await request(`${BASE}${caminho}`, { method, headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Trello recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };
  const put = async (tarefa: string, body: Record<string, unknown>) => feito(await escrever('PUT', `/cards/${seg(tarefa)}`, body), tarefa);
  /** as listas abertas, na ordem do quadro */
  const listas = async (quadro: string): Promise<Lista[]> => {
    const j = (await request(`${BASE}/boards/${seg(quadro)}/lists?filter=open&fields=name,pos`, { headers: auth })) as any[];
    return [...j].sort((a, b) => Number(a.pos) - Number(b.pos)).map((l) => ({ id: String(l.id), nome: String(l.name) }));
  };
  const listaDe = (todas: Lista[], coluna: string): Lista => {
    const f = fold(coluna);
    const l = todas.find((x) => x.id === coluna || fold(x.nome) === f);
    if (!l) throw new ErroAcao(`este quadro não tem a lista "${neutral(coluna, 60)}"`, todas.map((x) => neutral(x.nome, 60)));
    return l;
  };
  return {
    async criar(quadro, t) {
      const todas = await listas(quadro);
      if (!todas.length) throw new ErroAcao('este quadro não tem nenhuma lista aberta: crie uma no Trello primeiro');
      const lista = t.coluna ? listaDe(todas, t.coluna) : todas[0];
      const j = await escrever('POST', '/cards', { idList: lista.id, name: t.titulo, ...(t.descricao ? { desc: t.descricao } : {}), ...(t.prazo ? { due: prazoDe(t.prazo) } : {}) });
      if (!j?.id) throw new ProviderError('unavailable', 'o Trello não confirmou a criação (pode ter feito ou não): confira lá antes de repetir');
      return feito(j, String(j.id));
    },
    // o inverso de `completed` da leitura: lista de concluídos, se o quadro tiver; senão, a marca do cartão
    async concluir(quadro, tarefa, feita) {
      const todas = await listas(quadro);
      if (feita) {
        const pronta = todas.find((l) => DONE.test(l.nome));
        return put(tarefa, pronta ? { idList: pronta.id } : { dueComplete: true });
      }
      // reabrir precisa desfazer as duas marcas, ou a leitura continua vendo concluída
      const cartao = await request(`${BASE}/cards/${seg(tarefa)}?fields=idList`, { headers: auth });
      if (!todas.some((l) => l.id === String(cartao.idList) && DONE.test(l.nome))) return put(tarefa, { dueComplete: false });
      const aberta = todas.find((l) => !DONE.test(l.nome));
      if (!aberta) throw new ErroAcao('não dá para reabrir: todas as listas deste quadro são de concluídos', todas.map((l) => neutral(l.nome, 60)));
      return put(tarefa, { idList: aberta.id, dueComplete: false });
    },
    async mover(quadro, tarefa, coluna) {
      return put(tarefa, { idList: listaDe(await listas(quadro), coluna).id });
    },
    async editar(_quadro, tarefa, m) {
      const body = {
        ...(m.titulo !== undefined ? { name: m.titulo } : {}), ...(m.descricao !== undefined ? { desc: m.descricao } : {}),
        ...(m.prazo !== undefined ? { due: m.prazo === null ? null : prazoDe(m.prazo) } : {}),
      };
      if (!Object.keys(body).length) return { id: tarefa };
      return put(tarefa, body);
    },
    // `text` é parâmetro de consulta nesta rota (a documentação só promete corpo JSON nas rotas do cartão)
    async comentar(_quadro, tarefa, texto) {
      await escrever('POST', `/cards/${seg(tarefa)}/actions/comments?text=${encodeURIComponent(texto)}`);
    },
  };
}
