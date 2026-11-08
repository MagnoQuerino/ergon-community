/**
 * monday.com: escrita nos quadros (GraphQL). Mesma credencial e mesma versão da leitura: token no Authorization, sem
 * "Bearer", e sem cabeçalho API-Version (vale a versão Current, 2026-10 em nov/2026). Referências (conferidas em 05/11/2026):
 *   https://api.monday.com/v2/get_schema?format=sdl&version=2026-10 (assinaturas; as change_* devolvem Item, embora a página columns diga Column)
 *   https://developer.monday.com/api-reference/reference/items (create_item, move_item_to_group, url, updated_at)
 *   https://developer.monday.com/api-reference/docs/change-column-values
 *   https://developer.monday.com/api-reference/reference/status (id da etiqueta; settings no lugar de settings_str)
 *   https://developer.monday.com/api-reference/reference/date  .../long-text  .../name  .../updates
 *   https://developer.monday.com/api-reference/docs/errors (erro de aplicação vem com HTTP 200 e `errors`)
 *   https://developer.monday.com/api-reference/docs/working-with-multi-level-boards
 *   https://developer.monday.com/api-reference/docs/authentication
 *
 * Inverso da leitura em MondayProvider (task-providers.ts): coluna = grupo; concluída = o texto da PRIMEIRA coluna do tipo
 * status que tiver texto bate com DONE; descrição = coluna long_text; prazo = a primeira coluna de data com nome de prazo (sem ela,
 * a leitura não traz prazo); versão = updated_at.
 * Quadro de vários níveis com status calculado: sem `capabilities: [CALCULATED]` a coluna nem vem em column_values, e escrever
 * no item pai responde sucesso sem mudar nada. A leitura não veria a conclusão, então vira erro em vez de fingir que fez.
 */
import { DONE, PRAZO, recusado, request } from '../../task-providers.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, dia, type EscritorTarefas, type Escrita, type MudancaTarefa } from '../tipos.ts';

const API = 'https://api.monday.com/v2';
/** coluna sintética de quadro sem grupos (ver getBoard) */
const SEM_GRUPO = '__tarefas__';
const ID = /^\d{1,20}$/;
const MAX_NOME = 255;
const MAX_TEXTO_LONGO = 2000;
/** etiquetas que querem dizer "em aberto": "Working on it" e "Stuck" não voltam a tarefa para o começo */
const ABERTO = /^((em )?abert[oa]s?|a fazer|n[aã]o (iniciad|come[cç]ad)[oa]|pendente|nov[oa]|fila|backlog|open|to.?do|not started|pending|new)$/i;
const ITEM = 'id url updated_at';

type Quadro = { colunas: any[]; grupos: any[] };

const texto = (v: any): string => String(v?.text ?? '').trim();

/** Etiquetas ativas de uma coluna de status, na ordem de exibição (`settings`; `settings_str` está obsoleto desde 2025-10). */
function etiquetas(coluna: any): Array<{ id: string; nome: string; feita: boolean }> {
  let s = coluna?.settings;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
  return ((Array.isArray(s?.labels) ? s.labels : []) as any[])
    .filter((l) => !l.is_deactivated && String(l.label ?? '').trim())
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .map((l) => ({ id: String(l.id), nome: String(l.label).trim(), feita: l.is_done === true }));
}

/** Erro no corpo de uma resposta 200: nunca é "feito". Credencial e inexistência têm tipo próprio; passageiro pode repetir; o resto a pessoa corrige. */
function erroDe(e: any, kind: 'read' | 'write'): Error {
  const bruto = typeof e === 'string' ? e : String(e?.message ?? 'erro na chamada');
  const codigo = typeof e === 'string' ? '' : String(e?.extensions?.code ?? '');
  const msg = `monday.com: ${neutral(bruto, 200)}`;
  const tudo = `${codigo} ${bruto}`;
  if (/unauthori|access.?denied|permission|forbidden|not authenticated|your ip is restricted/i.test(tudo)) return new ProviderError('forbidden', msg);
  if (/not.?found|InvalidBoardId|InvalidItemId/i.test(tudo)) return new ProviderError('not_found', msg);
  // erro interno numa mutação vale como um 5xx: pode ter feito ou não, e o espelho só deixa de criar de novo se ouvir "não confirmou"
  if (kind === 'write' && /internal/i.test(tudo)) return new ProviderError('unavailable', `o monday.com não confirmou (pode ter feito ou não): confira lá antes de repetir. ${msg}`);
  if (/temporar|rate.?limit|complexity|concurrency|internal|locked|try again/i.test(tudo)) return new ProviderError('unavailable', msg);
  return new ErroAcao(msg);
}

export function escritorMonday(token: string): EscritorTarefas {
  const chama = async (query: string, variables: Record<string, unknown>, kind: 'read' | 'write'): Promise<any> => {
    let j: any;
    try { j = await request(API, { headers: { Authorization: token }, body: { query, variables }, kind }); }
    catch (e) { if (recusado(e)) throw new ErroAcao(`o monday.com recusou o pedido: ${neutral(e.message, 240)}`); throw e; }
    // `errors` é o formato atual; error_message/error_code, o de versões antigas. Dados parciais junto do erro não salvam a escrita
    const erro = j?.errors?.[0] ?? (j?.error_message || j?.error_code ? { message: j.error_message ?? j.error_code, extensions: { code: j.error_code } } : null);
    if (erro) throw erroDe(erro, kind);
    return j?.data ?? {};
  };
  const escreve = async (nome: string, query: string, variables: Record<string, unknown>): Promise<Escrita> => {
    const it = (await chama(query, variables, 'write'))[nome];
    if (!it?.id) throw new ProviderError('unavailable', 'o monday.com não confirmou (pode ter feito ou não): confira lá antes de repetir');
    return { id: String(it.id), versao: it.updated_at ? String(it.updated_at) : null, url: it.url ? String(it.url) : null };
  };
  const quadroDe = async (quadro: string): Promise<Quadro> => {
    const b = (await chama('query ($b: [ID!]) { boards(ids: $b) { columns { id title type settings } groups { id title } } }', { b: [quadro] }, 'read')).boards?.[0];
    if (!b) throw new ProviderError('not_found', 'quadro não encontrado (ou sem acesso)');
    return { colunas: b.columns ?? [], grupos: b.groups ?? [] };
  };
  const confere = (quadro: string, tarefa?: string) => {
    if (!ID.test(quadro)) throw new ErroAcao('quadro inválido: o monday.com usa um número');
    if (tarefa !== undefined && !ID.test(tarefa)) throw new ErroAcao('tarefa inválida: o monday.com usa um número');
  };
  const nomeOk = (s: string): string => {
    const v = String(s ?? '').trim();
    if (!v) throw new ErroAcao('o título não pode ficar vazio');
    if (v.length > MAX_NOME) throw new ErroAcao(`o título tem ${v.length} caracteres e o monday.com aceita até ${MAX_NOME}`);
    return v;
  };
  const grupoOk = (q: Quadro, grupo: string) => {
    if (!q.grupos.some((g) => String(g.id) === grupo)) throw new ErroAcao(`este quadro não tem a coluna "${neutral(grupo, 60)}"`, q.grupos.map((g) => neutral(`${g.title} (${g.id})`)));
  };
  /** Valores de descrição e prazo. Sem coluna para gravar é erro (nunca some em silêncio); limpar o que não existe não é. */
  const valores = (q: Quadro, m: Pick<MudancaTarefa, 'descricao' | 'prazo'>): Record<string, unknown> => {
    const v: Record<string, unknown> = {};
    if (m.descricao !== undefined) {
      const col = q.colunas.find((c) => c.type === 'long_text');
      if (m.descricao.length > MAX_TEXTO_LONGO) throw new ErroAcao(`a descrição tem ${m.descricao.length} caracteres e o monday.com aceita até ${MAX_TEXTO_LONGO}`);
      if (col) v[col.id] = m.descricao ? { text: m.descricao } : null;
      else if (m.descricao) throw new ErroAcao('este quadro não tem coluna de texto longo para a descrição: tire a descrição, use um comentário ou crie a coluna no monday.com');
    }
    if (m.prazo !== undefined) {
      const datas = q.colunas.filter((c) => c.type === 'date');
      // só com nome de prazo, como na leitura: a única coluna de data de um quadro pode ser "Início" ou "Nascimento"
      const col = datas.find((c) => PRAZO.test(String(c.title)));
      const prazo = m.prazo ? dia({ prazo: m.prazo }, 'prazo') : null;
      if (col) v[col.id] = prazo ? { date: prazo } : null;
      else if (prazo && datas.length) throw new ErroAcao(`${datas.length > 1 ? 'este quadro tem várias colunas de data e nenhuma se chama prazo' : 'a única coluna de data deste quadro não se chama prazo'}: renomeie a certa no monday.com`, datas.map((c) => neutral(String(c.title))));
      else if (prazo) throw new ErroAcao('este quadro não tem coluna de data para o prazo: tire o prazo ou crie a coluna no monday.com');
    }
    return v;
  };

  return {
    async criar(quadro, t) {
      confere(quadro);
      const nome = nomeOk(t.titulo);
      const grupo = t.coluna && t.coluna !== SEM_GRUPO ? t.coluna : null;
      let v: Record<string, unknown> = {};
      if (grupo || t.descricao || t.prazo) {
        const q = await quadroDe(quadro);
        if (grupo) grupoOk(q, grupo);
        v = valores(q, { ...(t.descricao ? { descricao: t.descricao } : {}), ...(t.prazo ? { prazo: t.prazo } : {}) });
      }
      return escreve('create_item', `mutation ($b: ID!, $g: String, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { ${ITEM} } }`,
        { b: quadro, n: nome, ...(grupo ? { g: grupo } : {}), ...(Object.keys(v).length ? { v: JSON.stringify(v) } : {}) });
    },
    async concluir(quadro, tarefa, feita) {
      confere(quadro, tarefa);
      const d = await chama(`query ($b: [ID!], $i: [ID!]) { boards(ids: $b) { columns { id title type settings } } items(ids: $i) { ${ITEM} column_values { id type text } } }`, { b: [quadro], i: [tarefa] }, 'read');
      const b = d.boards?.[0]; const it = d.items?.[0];
      if (!b) throw new ProviderError('not_found', 'quadro não encontrado (ou sem acesso)');
      if (!it) throw new ProviderError('not_found', 'tarefa não encontrada (ou sem acesso)');
      const colunas = new Map<string, any>(((b.columns ?? []) as any[]).map((c) => [String(c.id), c]));
      const titulo = (v: any) => neutral(String(colunas.get(String(v.id))?.title ?? v.id));
      // a mesma seleção e a mesma ordem que a leitura enxerga
      const status = ((it.column_values ?? []) as any[]).filter((v) => v.type === 'status');
      if (!status.length) throw new ErroAcao('este quadro não tem como marcar concluído: nenhuma coluna de status legível (sem coluna, ou status calculado a partir de subitens)');
      const atual = status.find((v) => texto(v));
      if (atual ? DONE.test(texto(atual)) === feita : !feita) return { id: tarefa, versao: it.updated_at ? String(it.updated_at) : null, url: it.url ? String(it.url) : null };
      const muda = (coluna: unknown, etiqueta: string) => escreve('change_simple_column_value', `mutation ($b: ID!, $i: ID!, $c: String!, $s: String) { change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: $s) { ${ITEM} } }`,
        { b: quadro, i: tarefa, c: String(coluna), s: etiqueta });
      if (!feita) {
        const alvo = etiquetas(colunas.get(String(atual.id))).find((l) => ABERTO.test(l.nome));
        if (alvo) return muda(atual.id, alvo.id);
        // sem etiqueta de aberto, limpa. A leitura passa então à próxima coluna de status com texto: se ela diz concluído, limpar não reabre
        const proxima = status.slice(status.indexOf(atual) + 1).find((v) => texto(v));
        if (proxima && DONE.test(texto(proxima))) throw new ErroAcao(`não dá para reabrir limpando "${titulo(atual)}": a coluna "${titulo(proxima)}" também diz concluído. Mude essa coluna no monday.com`);
        return muda(atual.id, '');
      }
      for (const v of status) {
        const ls = etiquetas(colunas.get(String(v.id)));
        const alvo = ls.find((l) => l.feita && DONE.test(l.nome)) ?? ls.find((l) => DONE.test(l.nome));
        if (alvo) return muda(v.id, alvo.id);
        // a leitura para na primeira coluna de status com texto: concluir numa coluna depois desta não apareceria
        if (texto(v)) throw new ErroAcao(`este quadro não tem como marcar concluído: a coluna "${titulo(v)}" vem antes e não tem etiqueta de concluído (Done, Feito, Concluído...). Crie uma, ou esvazie ou mova essa coluna no monday.com`, ls.map((l) => neutral(l.nome)));
      }
      throw new ErroAcao('este quadro não tem como marcar concluído: nenhuma coluna de status tem etiqueta de concluído (Done, Feito, Concluído...). Crie uma no monday.com',
        status.flatMap((v) => etiquetas(colunas.get(String(v.id))).map((l) => neutral(l.nome))));
    },
    async mover(quadro, tarefa, coluna) {
      confere(quadro, tarefa);
      if (coluna === SEM_GRUPO) return { id: tarefa };
      grupoOk(await quadroDe(quadro), coluna);
      return escreve('move_item_to_group', `mutation ($i: ID!, $g: String!) { move_item_to_group(item_id: $i, group_id: $g) { ${ITEM} } }`, { i: tarefa, g: coluna });
    },
    async editar(quadro, tarefa, m) {
      confere(quadro, tarefa);
      if (m.titulo === undefined && m.descricao === undefined && m.prazo === undefined) throw new ErroAcao('nada para mudar: diga título, descrição ou prazo');
      const v: Record<string, unknown> = {};
      if (m.titulo !== undefined) v.name = nomeOk(m.titulo);
      if (m.descricao !== undefined || m.prazo !== undefined) Object.assign(v, valores(await quadroDe(quadro), m));
      if (!Object.keys(v).length) return { id: tarefa };
      return escreve('change_multiple_column_values', `mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { ${ITEM} } }`,
        { b: quadro, i: tarefa, v: JSON.stringify(v) });
    },
    async comentar(quadro, tarefa, comentario) {
      confere(quadro, tarefa);
      if (!String(comentario ?? '').trim()) throw new ErroAcao('o comentário está vazio');
      const u = (await chama('mutation ($i: ID!, $t: String!) { create_update(item_id: $i, body: $t) { id } }', { i: tarefa, t: comentario }, 'write')).create_update;
      if (!u?.id) throw new ProviderError('unavailable', 'o monday.com não confirmou (pode ter feito ou não): confira lá antes de repetir');
    },
  };
}
