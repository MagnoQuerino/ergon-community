/**
 * Airtable: escrita nas tabelas. Referências oficiais (conferidas em 05/11/2026):
 *   https://airtable.com/developers/web/api/create-records
 *   https://airtable.com/developers/web/api/update-record (PATCH só mexe no que vai; PUT apagaria o resto)
 *   https://airtable.com/developers/web/api/get-record
 *   https://airtable.com/developers/web/api/get-base-schema
 *   https://airtable.com/developers/web/api/create-comment
 *   https://airtable.com/developers/web/api/field-model (seleção = nome da opção; sem typecast, opção inexistente é recusada)
 *   https://airtable.com/developers/web/api/scopes
 *   https://airtable.com/developers/web/api/errors
 * Inverso da leitura em AirtableProvider (task-providers.ts): quadro = "appX/tblY"; título = campo principal; coluna = nome da
 * opção do campo de seleção, escolhido como na leitura; concluída = opção de "feito" ou caixa de seleção; prazo = o primeiro campo
 * de data com nome de prazo (sem ele, a leitura não traz prazo). Sem versão: a da
 * leitura é um hash dos campos, e a próxima leitura confere. Sem typecast: nunca cria opção nova no campo de status.
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, PRAZO_AMPLO, recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita, type MudancaTarefa } from '../tipos.ts';

type Json = any; // respostas externas: lidas campo a campo
const BASE = 'https://api.airtable.com/v0';
/** colunas sintéticas de getBoard */
const SEM_STATUS = '__sem_status__';
const UMA_COLUNA = '__tarefas__';

interface Tabela { primario: string; status?: Json; check?: Json; notas?: Json; prazo?: Json; datas: string[]; escolhas: string[] }

/** Mesmo formato que a leitura aceita; nada de endereço montado com o que o modelo disser. */
const alvo = (quadro: string): [string, string] => {
  const [base, tabela] = quadro.split('/');
  if (!/^app[a-zA-Z0-9]{8,20}$/.test(base ?? '') || !/^tbl[a-zA-Z0-9]{8,20}$/.test(tabela ?? '')) throw new ErroAcao('tabela inválida: o quadro do Airtable tem o formato "appXXX/tblXXX"');
  return [base, tabela];
};

const nomes = (l: string[]) => l.map((n) => neutral(n, 60));

export function escritorAirtable(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}` };
  /** Escrita. Recusa (422 é a mais comum: valor que o campo não aceita): a pessoa corrige, repetir não adianta. */
  const escrever = async (method: 'POST' | 'PATCH', url: string, body: unknown): Promise<Json> => {
    try { return await request(url, { method, headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Airtable recusou o pedido: ${neutral(e.message, 240)}`);
      throw e;
    }
  };

  const tabela = async (quadro: string): Promise<Tabela> => {
    const [base, id] = alvo(quadro);
    const t = (((await request(`${BASE}/meta/bases/${seg(base)}/tables`, { headers: auth })).tables ?? []) as Json[]).find((x) => String(x.id) === id);
    if (!t) throw new ProviderError('not_found', 'tabela não encontrada (ou sem acesso)');
    const f = (t.fields ?? []) as Json[];
    // as mesmas regras de getBoard: outro campo aqui e a leitura não veria a escrita
    const status = f.find((c) => c.type === 'singleSelect' && /status|situa|etapa|fase|estado/i.test(c.name)) ?? f.find((c) => c.type === 'singleSelect');
    const check = f.find((c) => c.type === 'checkbox' && /done|feit|conclu|complet/i.test(c.name));
    const notas = f.find((c) => (c.type === 'multilineText' || c.type === 'richText') && /descri|nota|notes|detalhe/i.test(c.name));
    const dataCampos = f.filter((c) => c.type === 'date' || c.type === 'dateTime');
    return {
      primario: String(t.primaryFieldId), status, check, notas, prazo: dataCampos.find((c) => PRAZO_AMPLO.test(c.name)),
      datas: dataCampos.map((c) => String(c.name)), escolhas: ((status?.options?.choices ?? []) as Json[]).map((c) => String(c.name)),
    };
  };

  /** Valor do campo de status para a coluna: undefined = não há o que gravar; null = sem status. */
  const valorDe = (t: Tabela, coluna: string): string | null | undefined => {
    if (coluna === SEM_STATUS || coluna === UMA_COLUNA) {
      if (!t.escolhas.length) return undefined;
      if (coluna === SEM_STATUS) return null;
    }
    if (t.escolhas.includes(coluna)) return coluna;
    throw new ErroAcao(t.escolhas.length ? `a coluna "${neutral(coluna, 60)}" não existe nesta tabela` : 'esta tabela não tem campo de seleção de status: não há colunas para escolher', nomes(t.escolhas));
  };

  const campos = (t: Tabela, m: MudancaTarefa): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (m.titulo !== undefined) {
      if (!m.titulo.trim()) throw new ErroAcao('o título não pode ficar vazio');
      out[t.primario] = m.titulo;
    }
    if (m.descricao !== undefined) {
      if (!t.notas) throw new ErroAcao('esta tabela não tem campo de descrição: crie um campo de texto longo chamado "Descrição" ou mande sem descrição');
      out[t.notas.id] = m.descricao;
    }
    if (m.prazo !== undefined) {
      if (!t.prazo) throw new ErroAcao('esta tabela não tem campo de data de prazo (nome com "prazo", "vencimento" ou "due"): crie um ou mande sem prazo', nomes(t.datas));
      // meio-dia UTC: o dia não muda em nenhum fuso comum
      out[t.prazo.id] = m.prazo === null ? null : t.prazo.type === 'date' ? m.prazo : `${m.prazo}T12:00:00.000Z`;
    }
    return out;
  };

  const feito = (j: Json): Escrita => {
    if (!j?.id) throw new ProviderError('unavailable', 'o Airtable não confirmou a escrita (resposta sem id)');
    return { id: String(j.id), versao: null, url: null };
  };
  const lista = (quadro: string) => { const [b, t] = alvo(quadro); return `${BASE}/${seg(b)}/${seg(t)}`; };
  const registro = (quadro: string, tarefa: string) => `${lista(quadro)}/${seg(tarefa)}`;
  const patch = async (quadro: string, tarefa: string, fields: Record<string, unknown>): Promise<Escrita> =>
    (Object.keys(fields).length ? feito(await escrever('PATCH', registro(quadro, tarefa), { fields })) : { id: tarefa, versao: null, url: null });

  return {
    async criar(quadro, n) {
      if (!n.titulo?.trim()) throw new ErroAcao('falta o título');
      const t = await tabela(quadro);
      const fields = campos(t, { titulo: n.titulo, ...(n.descricao ? { descricao: n.descricao } : {}), ...(n.prazo ? { prazo: n.prazo } : {}) });
      // sem coluna: a primeira de verdade, nunca uma de "feito"; tarefa nova não nasce concluída
      const v = n.coluna ? valorDe(t, n.coluna) : t.escolhas.find((c) => !DONE.test(c));
      if (v && t.status) fields[t.status.id] = v;
      return feito(await escrever('POST', lista(quadro), { fields }));
    },
    async concluir(quadro, tarefa, feita) {
      const t = await tabela(quadro);
      const fields: Record<string, unknown> = {};
      if (feita) {
        const final = t.escolhas.find((c) => DONE.test(c));
        if (!t.check && final === undefined) throw new ErroAcao('esta tabela não tem como marcar concluída: falta uma opção de status como "Concluído" ou uma caixa de seleção chamada "Feito"', nomes(t.escolhas));
        if (t.check) fields[t.check.id] = true;
        if (final !== undefined) fields[t.status.id] = final;
      } else {
        // a leitura vê concluída por qualquer um dos dois: reabrir tem de desfazer os dois
        const r = await request(`${registro(quadro, tarefa)}?returnFieldsByFieldId=true`, { headers: auth });
        if (t.check) fields[t.check.id] = false;
        if (t.status && DONE.test(String(r.fields?.[t.status.id] ?? ''))) fields[t.status.id] = t.escolhas.find((c) => !DONE.test(c)) ?? null;
      }
      return patch(quadro, tarefa, fields);
    },
    async mover(quadro, tarefa, coluna) {
      const t = await tabela(quadro);
      const v = valorDe(t, coluna);
      return patch(quadro, tarefa, v === undefined ? {} : { [t.status.id]: v });
    },
    async editar(quadro, tarefa, m) {
      return patch(quadro, tarefa, campos(await tabela(quadro), m));
    },
    async comentar(quadro, tarefa, texto) {
      const j = await escrever('POST', `${registro(quadro, tarefa)}/comments`, { text: texto });
      if (!j?.id) throw new ProviderError('unavailable', 'o Airtable não confirmou o comentário (resposta sem id)');
    },
  };
}
