/**
 * Smartsheet: escrita nas planilhas. Referências oficiais (conferidas em 05/11/2026):
 *   https://developers.smartsheet.com/api/smartsheet/openapi/rows/rows-addtosheet
 *   https://developers.smartsheet.com/api/smartsheet/openapi/rows/update-rows
 *   https://developers.smartsheet.com/ai-mcp/smartsheet/mcp-server-tools (add_rows/update_rows: WRITE_SHEETS; "each row includes an ID")
 *   https://developers.smartsheet.com/api/smartsheet/openapi/sheets/getsheet (rowIds, pageSize, columns, permalink)
 *   https://developers.smartsheet.com/api/smartsheet/openapi/cells (regras de valor por tipo de coluna; strict; erro 1042)
 *   https://developers.smartsheet.com/api/smartsheet/openapi/discussions/row-discussions-create
 *   https://developers.smartsheet.com/api/smartsheet/guides/advanced-topics/oauth (escopos não passam por cima do compartilhamento)
 * Inverso da leitura em SmartsheetProvider (task-providers.ts): quadro = id da planilha; título = coluna principal; coluna =
 * opção da lista "Status", escolhida como na leitura; concluída = opção de "feito" ou caixa de seleção; prazo = a primeira coluna
 * de data com nome de prazo (sem ela, a leitura não traz prazo); versão = modifiedAt da linha. As células vão pelo id da coluna,
 * nunca pelo nome.
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, PRAZO_AMPLO, recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita, type MudancaTarefa } from '../tipos.ts';

type Json = any; // respostas externas: lidas campo a campo
const BASE = 'https://api.smartsheet.com/2.0';
/** colunas sintéticas de getBoard */
const SEM_STATUS = '__sem_status__';
const UMA_COLUNA = '__tarefas__';
/** o serviço corta em silêncio o que passar disso: melhor avisar do que perder texto */
const MAX_CELULA = 4000;

interface Planilha { url: string | null; principal: Json; status?: Json; check?: Json; notas?: Json; prazo?: Json; datas: string[]; opcoes: string[]; linhas: Json[] }

/** Endereço da planilha: só o id numérico entra nele, como na leitura. */
const folha = (quadro: string): string => {
  if (!/^\d{1,20}$/.test(quadro)) throw new ErroAcao('planilha inválida: o quadro do Smartsheet é o id numérico da planilha');
  return `${BASE}/sheets/${seg(quadro)}`;
};
const idLinha = (tarefa: string): number => {
  const n = Number(tarefa);
  if (!/^\d{1,20}$/.test(tarefa) || !Number.isSafeInteger(n)) throw new ErroAcao('tarefa inválida: a tarefa do Smartsheet é o id numérico da linha');
  return n;
};
const nomes = (l: string[]) => l.map((n) => neutral(n, 60));
/** Vazio limpa a célula; `strict: false` porque a regra estrita de lista só aceita uma das opções. */
const celula = (c: Json, valor: unknown) => (valor === null || valor === '' ? { columnId: c.id, value: '', strict: false } : { columnId: c.id, value: valor });
const texto = (v: string, rotulo: string) => {
  if (v.length > MAX_CELULA) throw new ErroAcao(`${rotulo} passa de ${MAX_CELULA} caracteres, o limite de uma célula do Smartsheet: encurte o texto`);
  return v;
};

/** 200 com falha no corpo também é falha. */
const confirmada = (j: Json): Json => {
  if (j?.resultCode !== 0) throw new ProviderError('unavailable', `o Smartsheet não confirmou a escrita (${neutral(String(j?.message ?? 'resposta sem resultado'), 120)})`);
  return j;
};

export function escritorSmartsheet(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}` };
  /** Escrita. Recusa (400 é a mais comum: valor que a coluna não aceita): a pessoa corrige, repetir não adianta. */
  const escrever = async (method: 'POST' | 'PUT', url: string, body: unknown): Promise<Json> => {
    try { return await request(url, { method, headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Smartsheet recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };

  const planilha = async (quadro: string, linha?: number): Promise<Planilha> => {
    // uma linha só: a estrutura vem junto e a planilha inteira não precisa descer
    const s = await request(`${folha(quadro)}?${linha === undefined ? 'pageSize=1' : `rowIds=${linha}`}`, { headers: auth });
    const cols = (s.columns ?? []) as Json[];
    // as mesmas regras de getBoard: outra coluna aqui e a leitura não veria a escrita
    const status = cols.find((c) => c.type === 'PICKLIST' && /status|situa|etapa|fase|estado/i.test(c.title));
    const datas = cols.filter((c) => c.type === 'DATE');
    return {
      url: s.permalink ? String(s.permalink) : null, principal: cols.find((c) => c.primary) ?? cols[0], status,
      check: cols.find((c) => c.type === 'CHECKBOX' && /done|feit|conclu|complet/i.test(c.title)),
      notas: cols.find((c) => c.type === 'TEXT_NUMBER' && /descri|nota|notes|detalhe/i.test(c.title)),
      prazo: datas.find((c) => PRAZO_AMPLO.test(c.title)), datas: datas.map((c) => String(c.title)),
      opcoes: ((status?.options ?? []) as unknown[]).map(String), linhas: (s.rows ?? []) as Json[],
    };
  };

  /** Valor da lista de status para a coluna: undefined = não há o que gravar; null = sem status. */
  const valorDe = (p: Planilha, coluna: string): string | null | undefined => {
    if (coluna === SEM_STATUS || coluna === UMA_COLUNA) {
      if (!p.opcoes.length) return undefined;
      if (coluna === SEM_STATUS) return null;
    }
    if (p.opcoes.includes(coluna)) return coluna;
    throw new ErroAcao(p.opcoes.length ? `a coluna "${neutral(coluna, 60)}" não existe nesta planilha` : 'esta planilha não tem coluna de lista "Status": não há colunas para escolher', nomes(p.opcoes));
  };

  const celulas = (p: Planilha, m: MudancaTarefa): Json[] => {
    const out: Json[] = [];
    if (m.titulo !== undefined) {
      if (!m.titulo.trim()) throw new ErroAcao('o título não pode ficar vazio');
      if (!p.principal) throw new ErroAcao('esta planilha não tem coluna principal');
      out.push(celula(p.principal, texto(m.titulo, 'o título')));
    }
    if (m.descricao !== undefined) {
      if (!p.notas) throw new ErroAcao('esta planilha não tem coluna de descrição: crie uma coluna de texto chamada "Descrição" ou mande sem descrição');
      out.push(celula(p.notas, texto(m.descricao, 'a descrição')));
    }
    if (m.prazo !== undefined) {
      if (!p.prazo) throw new ErroAcao('esta planilha não tem coluna de data de prazo (nome com "prazo", "vencimento" ou "due"): crie uma ou mande sem prazo', nomes(p.datas));
      out.push(celula(p.prazo, m.prazo));
    }
    return out;
  };

  const feito = (j: Json, url: string | null): Escrita => {
    const r = confirmada(j).result; const linha = Array.isArray(r) ? r[0] : r;
    if (!linha?.id) throw new ProviderError('unavailable', 'o Smartsheet não confirmou a escrita (resposta sem a linha)');
    return { id: String(linha.id), versao: linha.modifiedAt ? String(linha.modifiedAt) : null, url };
  };
  /** Nada a mudar é sucesso sem chamada. O corpo é sempre uma lista: a resposta também vem como lista. */
  const atualizar = async (p: Planilha, quadro: string, tarefa: string, cells: Json[]): Promise<Escrita> => {
    const id = idLinha(tarefa);
    if (!cells.length) return { id: tarefa, versao: null, url: p.url };
    return feito(await escrever('PUT', `${folha(quadro)}/rows`, [{ id, cells }]), p.url);
  };

  return {
    async criar(quadro, n) {
      if (!n.titulo?.trim()) throw new ErroAcao('falta o título');
      const p = await planilha(quadro);
      const cells = celulas(p, { titulo: n.titulo, ...(n.descricao ? { descricao: n.descricao } : {}), ...(n.prazo ? { prazo: n.prazo } : {}) });
      // sem coluna: a primeira de verdade, nunca uma de "feito"; tarefa nova não nasce concluída
      const v = n.coluna ? valorDe(p, n.coluna) : p.opcoes.find((o) => !DONE.test(o));
      if (v && p.status) cells.push(celula(p.status, v));
      return feito(await escrever('POST', `${folha(quadro)}/rows`, [{ toBottom: true, cells }]), p.url);
    },
    async concluir(quadro, tarefa, feita) {
      if (feita) {
        const p = await planilha(quadro);
        const final = p.opcoes.find((o) => DONE.test(o));
        if (!p.check && final === undefined) throw new ErroAcao('esta planilha não tem como marcar concluída: falta uma opção de status como "Concluído" ou uma caixa de seleção chamada "Feito"', nomes(p.opcoes));
        return atualizar(p, quadro, tarefa, [...(p.check ? [celula(p.check, true)] : []), ...(final !== undefined ? [celula(p.status, final)] : [])]);
      }
      // a leitura vê concluída por qualquer um dos dois: reabrir tem de desfazer os dois
      const id = idLinha(tarefa);
      const p = await planilha(quadro, id);
      const linha = p.linhas.find((r) => String(r.id) === tarefa);
      if (!linha) throw new ProviderError('not_found', 'linha não encontrada nesta planilha (ou sem acesso)');
      const atual = p.status ? ((linha.cells ?? []) as Json[]).find((c) => String(c.columnId) === String(p.status.id))?.value : undefined;
      const cells: Json[] = p.check ? [celula(p.check, false)] : [];
      if (DONE.test(String(atual ?? ''))) cells.push(celula(p.status, p.opcoes.find((o) => !DONE.test(o)) ?? null));
      return atualizar(p, quadro, tarefa, cells);
    },
    async mover(quadro, tarefa, coluna) {
      const p = await planilha(quadro);
      const v = valorDe(p, coluna);
      return atualizar(p, quadro, tarefa, v === undefined ? [] : [celula(p.status, v)]);
    },
    async editar(quadro, tarefa, m) {
      const p = await planilha(quadro);
      return atualizar(p, quadro, tarefa, celulas(p, m));
    },
    async comentar(quadro, tarefa, comentario) {
      confirmada(await escrever('POST', `${folha(quadro)}/rows/${seg(idLinha(tarefa))}/discussions`, { comment: { text: comentario } }));
    },
  };
}
