/**
 * Notion: escrita nas páginas de uma fonte de dados, com a mesma credencial e a mesma versão da leitura (Bearer, 2025-09-03).
 * Referências (conferidas em 05/11/2026; as páginas de referência já mostram 2026-03-11, que só troca `archived` por `in_trash`, e não usamos):
 *   https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03 (parent data_source_id vale em qualquer versão)
 *   https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11
 *   https://developers.notion.com/reference/post-page  .../patch-page  .../create-a-comment
 *   https://developers.notion.com/reference/page-property-values (status e select por id; status null volta à opção padrão)
 *   https://developers.notion.com/reference/retrieve-a-data-source  .../request-limits (2000 caracteres por texto, 100 itens)
 *   https://developers.notion.com/reference/capabilities  https://developers.notion.com/guides/get-started/internal-connections
 *
 * Inverso da leitura em NotionProvider (task-providers.ts): coluna = opção da propriedade de status ou select; concluída =
 * caixa de seleção com nome de feito, OU opção de um grupo Complete/Concluído, OU opção com nome em DONE; descrição = rich_text
 * com nome de descrição; prazo = a primeira propriedade de data com nome de prazo (sem ela, a leitura não traz prazo); versão =
 * last_edited_time. A escolha das propriedades repete a da leitura de propósito: outra propriedade ela não enxergaria. Um erro do
 * Notion sempre vem com status 4xx/5xx (request() trata).
 */
import { DONE, PRAZO, recusado, request } from '../../task-providers.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, dia, seg, type EscritorTarefas, type Escrita, type MudancaTarefa } from '../tipos.ts';

const BASE = 'https://api.notion.com/v1';
const VERSAO = '2025-09-03';
/** colunas sintéticas de getBoard: base sem opções de status; página sem status */
const SEM_COLUNAS = '__tarefas__';
const SEM_STATUS = '__sem_status__';
const ID = /^[a-f0-9-]{32,36}$/i;
const POR_TEXTO = 2000;
const MAX_TEXTOS = 100;

/** Texto em pedaços no limite do Notion, sem partir um emoji ao meio. */
function rico(s: string): Array<{ type: 'text'; text: { content: string } }> {
  const partes: Array<{ type: 'text'; text: { content: string } }> = [];
  for (let i = 0; i < s.length;) {
    let fim = Math.min(i + POR_TEXTO, s.length);
    const u = s.charCodeAt(fim - 1);
    if (fim < s.length && u >= 0xd800 && u <= 0xdbff) fim--;
    partes.push({ type: 'text', text: { content: s.slice(i, fim) } });
    i = fim;
  }
  if (partes.length > MAX_TEXTOS) throw new ErroAcao(`texto longo demais para o Notion (até ${POR_TEXTO * MAX_TEXTOS} caracteres)`);
  return partes;
}

interface Esquema {
  tituloKey?: string; statusKey?: string; tipo: string; opcoes: any[]; checkKey?: string; descKey?: string; datas: string[];
  padrao: string | null; feitos: Set<string>; ehFeita(o: any): boolean;
}

export function escritorNotion(token: string): EscritorTarefas {
  const h = { Authorization: `Bearer ${token}`, 'Notion-Version': VERSAO };
  const le = (p: string) => request(`${BASE}${p}`, { headers: h });
  /** Escrita. Pedido recusado (validation_error e afins): a pessoa corrige, repetir não adianta. */
  const escreve = async (method: string, p: string, body: unknown): Promise<any> => {
    let j: any;
    try { j = await request(`${BASE}${p}`, { method, headers: h, body, kind: 'write' }); }
    catch (e) { if (recusado(e)) throw new ErroAcao(`Notion: ${neutral(e.message, 300)}`); throw e; }
    if (!j?.id || j.object === 'error') throw new ProviderError('unavailable', 'o Notion não confirmou (pode ter feito ou não): confira lá antes de repetir');
    return j;
  };
  const feito = (j: any): Escrita => ({ id: String(j.id), versao: j.last_edited_time ? String(j.last_edited_time) : null, url: j.url ? String(j.url) : null });
  const pagina = async (tarefa: string, properties: Record<string, unknown>): Promise<Escrita> => feito(await escreve('PATCH', `/pages/${seg(tarefa)}`, { properties }));
  const confere = (quadro: string, tarefa?: string) => {
    if (!ID.test(quadro)) throw new ErroAcao('base inválida: o Notion usa um identificador de 32 caracteres');
    if (tarefa !== undefined && !ID.test(tarefa)) throw new ErroAcao('tarefa inválida: o Notion usa um identificador de 32 caracteres');
  };
  const esquema = async (quadro: string): Promise<Esquema> => {
    const ds = await le(`/data_sources/${seg(quadro)}`);
    const props = Object.entries((ds.properties ?? {}) as Record<string, any>);
    const status = props.find(([n, p]) => ['status', 'select'].includes(p.type) && /status|situa|etapa|fase|estado/i.test(n)) ?? props.find(([, p]) => p.type === 'status');
    const sp = status?.[1];
    const feitos = new Set<string>(((sp?.status?.groups ?? []) as any[]).filter((g) => /complete|conclu/i.test(String(g.name))).flatMap((g) => g.option_ids ?? []));
    return {
      tituloKey: props.find(([, p]) => p.type === 'title')?.[0],
      statusKey: status?.[0], tipo: sp?.type ?? '', opcoes: sp ? (sp[sp.type]?.options ?? []) : [],
      checkKey: props.find(([n, p]) => p.type === 'checkbox' && /done|feit|conclu|complet/i.test(n))?.[0],
      descKey: props.find(([n, p]) => p.type === 'rich_text' && /descri|nota|notes|detalhe/i.test(n))?.[0],
      datas: props.filter(([, p]) => p.type === 'date').map(([n]) => n),
      padrao: sp?.status?.default_option ?? null, feitos,
      ehFeita: (o) => feitos.has(String(o?.id)) || DONE.test(String(o?.name ?? '')),
    };
  };
  const nomes = (s: Esquema) => s.opcoes.map((o) => neutral(`${o.name} (${o.id})`));
  const opcaoOk = (s: Esquema, coluna: string) => {
    const o = s.opcoes.find((x) => String(x.id) === coluna);
    if (!o) throw new ErroAcao(s.opcoes.length ? `esta base não tem a coluna "${neutral(coluna, 60)}"` : 'esta base não tem colunas: falta uma propriedade de status ou select com opções', nomes(s));
    return { [s.tipo]: { id: String(o.id) } };
  };
  /** Valores de descrição e prazo. Sem propriedade para gravar é erro (nunca some em silêncio); limpar o que não existe não é. */
  const valores = (s: Esquema, m: Pick<MudancaTarefa, 'descricao' | 'prazo'>): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    if (m.descricao !== undefined) {
      if (s.descKey) p[s.descKey] = { rich_text: rico(m.descricao) };
      else if (m.descricao) throw new ErroAcao('esta base não tem propriedade de texto para a descrição (com nome como Descrição, Notas ou Detalhes): tire a descrição, use um comentário ou crie a propriedade no Notion');
    }
    if (m.prazo !== undefined) {
      // só com nome de prazo, como na leitura: a única data de uma base pode ser "Início" ou "Nascimento"
      const k = s.datas.find((n) => PRAZO.test(n));
      const prazo = m.prazo ? dia({ prazo: m.prazo }, 'prazo') : null;
      if (k) p[k] = { date: prazo ? { start: prazo } : null };
      else if (prazo && s.datas.length) throw new ErroAcao(`${s.datas.length > 1 ? 'esta base tem várias propriedades de data e nenhuma se chama prazo' : 'a única propriedade de data desta base não se chama prazo'}: renomeie a certa no Notion`, s.datas.map((n) => neutral(n)));
      else if (prazo) throw new ErroAcao('esta base não tem propriedade de data para o prazo: tire o prazo ou crie a propriedade no Notion');
    }
    return p;
  };
  const tituloOk = (s: Esquema, titulo: string) => {
    if (!String(titulo ?? '').trim()) throw new ErroAcao('o título não pode ficar vazio');
    if (!s.tituloKey) throw new ErroAcao('esta base não tem propriedade de título');
    return { [s.tituloKey]: { title: rico(titulo.trim()) } };
  };

  return {
    async criar(quadro, t) {
      confere(quadro);
      const s = await esquema(quadro);
      const coluna = t.coluna && t.coluna !== SEM_COLUNAS && t.coluna !== SEM_STATUS ? t.coluna : null;
      const properties = {
        ...tituloOk(s, t.titulo),
        ...valores(s, { ...(t.descricao ? { descricao: t.descricao } : {}), ...(t.prazo ? { prazo: t.prazo } : {}) }),
        ...(coluna ? { [String(s.statusKey)]: opcaoOk(s, coluna) } : {}),
      };
      return feito(await escreve('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: quadro }, properties }));
    },
    async concluir(quadro, tarefa, feita) {
      confere(quadro, tarefa);
      const s = await esquema(quadro);
      const p: Record<string, unknown> = {};
      if (s.checkKey) p[s.checkKey] = { checkbox: feita };
      if (feita) {
        // o grupo Complete também guarda "Cancelado": sem um nome claro de feito, só vale a opção única, e a escolha é da pessoa
        const feitas = s.opcoes.filter((x) => s.ehFeita(x));
        const claro = (x: any) => DONE.test(String(x.name));
        const o = feitas.find((x) => s.feitos.has(String(x.id)) && claro(x)) ?? feitas.find(claro) ?? (feitas.length === 1 && !/cancel/i.test(String(feitas[0].name)) ? feitas[0] : undefined);
        if (o) p[String(s.statusKey)] = { [s.tipo]: { id: String(o.id) } };
        else if (feitas.length && !s.checkKey) throw new ErroAcao('nenhuma opção de concluído desta base tem um nome claro (Done, Feito, Concluído): mova a tarefa para a que vale neste caso', feitas.map((x) => neutral(`${x.name} (${x.id})`)));
        if (!Object.keys(p).length) throw new ErroAcao('esta base não tem como marcar concluído: falta uma opção de status de concluído (grupo Complete, ou nome como Done, Feito, Concluído) ou uma caixa de seleção com nome de concluído', nomes(s));
      } else if (s.opcoes.length) {
        // a caixa sozinha não reabre: a leitura também olha o status. Só muda se o status diz feito (não volta "Em andamento" para "A fazer")
        const atual = (await le(`/pages/${seg(tarefa)}`)).properties?.[String(s.statusKey)]?.[s.tipo];
        if (atual && s.ehFeita(atual)) {
          const o = s.opcoes.find((x) => x.name === s.padrao && !s.ehFeita(x)) ?? s.opcoes.find((x) => !s.ehFeita(x));
          if (!o) throw new ErroAcao(`a propriedade "${neutral(String(s.statusKey))}" só tem opções de concluído: crie outra no Notion para reabrir`, nomes(s));
          p[String(s.statusKey)] = { [s.tipo]: { id: String(o.id) } };
        }
      }
      return Object.keys(p).length ? pagina(tarefa, p) : { id: tarefa }; // reabrir o que já está aberto
    },
    async mover(quadro, tarefa, coluna) {
      confere(quadro, tarefa);
      if (coluna === SEM_COLUNAS) return { id: tarefa };
      const s = await esquema(quadro);
      // status null volta à opção padrão, se a base tiver uma (documentação): a leitura seguinte mostra onde ela ficou
      if (coluna === SEM_STATUS && s.opcoes.length) return pagina(tarefa, { [String(s.statusKey)]: { [s.tipo]: null } });
      return pagina(tarefa, { [String(s.statusKey)]: opcaoOk(s, coluna) });
    },
    async editar(quadro, tarefa, m) {
      confere(quadro, tarefa);
      if (m.titulo === undefined && m.descricao === undefined && m.prazo === undefined) throw new ErroAcao('nada para mudar: diga título, descrição ou prazo');
      const s = await esquema(quadro);
      const p = { ...(m.titulo !== undefined ? tituloOk(s, m.titulo) : {}), ...valores(s, m) };
      return Object.keys(p).length ? pagina(tarefa, p) : { id: tarefa };
    },
    async comentar(quadro, tarefa, texto) {
      confere(quadro, tarefa);
      if (!String(texto ?? '').trim()) throw new ErroAcao('o comentário está vazio');
      await escreve('POST', '/comments', { parent: { page_id: tarefa }, rich_text: rico(texto) });
    },
  };
}
