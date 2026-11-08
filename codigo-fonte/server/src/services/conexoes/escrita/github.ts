/**
 * GitHub Projects (v2): escrita nos projetos, por GraphQL. Referências oficiais (conferidas em 05/11/2026):
 *   https://docs.github.com/en/graphql/reference/projects (addProjectV2DraftIssue, updateProjectV2ItemFieldValue,
 *     clearProjectV2ItemFieldValue, updateProjectV2DraftIssue, ProjectV2Item, ProjectV2Field, ProjectV2FieldType)
 *   https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
 *   https://docs.github.com/en/graphql/reference/issues (updateIssue, reopenIssue, addComment)
 *   https://docs.github.com/en/graphql/reference/pulls (updatePullRequest, reopenPullRequest)
 *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps (project, repo)
 *   https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-access-to-your-projects (papéis)
 * Inverso da leitura em GitHubProjectsProvider (task-providers.ts): quadro = id do projeto; coluna = id da opção do campo
 * "Status"; título e corpo = os do conteúdo do item (rascunho, issue ou pull request); concluída = status de "feito", ou issue
 * ou pull request fechados; prazo = o primeiro campo de data com nome de prazo (sem ele, a leitura não traz prazo); versão =
 * updatedAt do item. Concluir só muda o Status (não fecha a issue no repositório), mas
 * reabrir tem de reabrir a issue fechada: senão a leitura continuaria vendo concluída.
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, PRAZO_AMPLO, recusado, request } from '../../task-providers.ts';
import { ErroAcao, type EscritorTarefas, type Escrita } from '../tipos.ts';

type Json = any; // respostas externas: lidas campo a campo
const API = 'https://api.github.com/graphql';
/** coluna sintética de getBoard */
const SEM_STATUS = '__sem_status__';
const ITEM_FEITO = 'projectV2Item { id updatedAt }';

interface Opcao { id: string; name: string }
interface Projeto { url: string | null; status: string | null; opcoes: Opcao[]; prazo: string | null; datas: string[] }
interface Item { id: string; updatedAt: string | null; statusNome: string; tipo: string; conteudo: string | null; estado: string | null; url: string | null }

const falha = (e: Json, kind: 'read' | 'write'): Error => {
  const tipo = String(e?.type ?? ''); const msg = neutral(String(e?.message ?? 'erro na chamada'), 300);
  if (tipo === 'FORBIDDEN' || tipo === 'INSUFFICIENT_SCOPES' || /not been granted|not accessible|required scopes|permission|credential/i.test(msg)) return new ProviderError('forbidden', `o GitHub recusou: ${msg}`);
  if (tipo === 'NOT_FOUND' || /could not resolve/i.test(msg)) return new ProviderError('not_found', `não encontrado (ou sem acesso): ${msg}`);
  if (tipo === 'UNPROCESSABLE') return new ErroAcao(`o GitHub recusou: ${msg}`);
  // erro sem tipo numa mutação vale como um 5xx: pode ter feito ou não, e o espelho só deixa de criar de novo se ouvir "não confirmou"
  if (kind === 'write' && tipo !== 'RATE_LIMITED') return new ProviderError('unavailable', `o GitHub não confirmou (pode ter feito ou não): ${msg}. Confira lá antes de repetir`);
  return new ProviderError('unavailable', `o GitHub respondeu com erro: ${msg}`);
};
const naoConfirmou = (o: string) => new ProviderError('unavailable', `o GitHub não confirmou ${o}`);
const idProjeto = (quadro: string): string => {
  if (!/^PVT_[A-Za-z0-9_-]{4,60}$/.test(quadro)) throw new ErroAcao('projeto inválido: o quadro do GitHub é o id do projeto ("PVT_...")');
  return quadro;
};
const nomes = (l: Opcao[]) => l.map((o) => neutral(o.name, 60));
const fechado = (i: Item) => i.estado === 'CLOSED' || i.estado === 'MERGED';

export function escritorGitHub(token: string): EscritorTarefas {
  const auth = { Authorization: `Bearer ${token}`, 'User-Agent': 'Ergon' };
  const chamar = async (query: string, variables: Record<string, unknown>, kind: 'read' | 'write'): Promise<Json> => {
    let j: Json;
    try { j = await request(API, { headers: auth, body: { query, variables }, kind }); }
    catch (e) { if (recusado(e)) throw new ErroAcao(`o GitHub recusou o pedido: ${neutral(e.message, 240)}`); throw e; }
    if (j.errors?.length) throw falha(j.errors[0], kind); // erro com dados parciais também é erro: numa escrita, não houve sucesso
    return j.data ?? {};
  };
  const mut = (query: string, input: Record<string, unknown>) => chamar(query, { input }, 'write');

  const projeto = async (quadro: string): Promise<Projeto> => {
    const p = (await chamar(`query ($id: ID!) { node(id: $id) { ... on ProjectV2 { id url
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
      fields(first: 50) { nodes { ... on ProjectV2Field { id name dataType } } } } } }`, { id: idProjeto(quadro) }, 'read')).node;
    if (!p?.id) throw new ProviderError('not_found', 'projeto não encontrado (ou sem acesso)');
    const datas = ((p.fields?.nodes ?? []) as Json[]).filter((f) => f?.dataType === 'DATE');
    const prazo = datas.find((f) => PRAZO_AMPLO.test(String(f.name)));
    return {
      url: p.url ? String(p.url) : null, status: p.field?.id ? String(p.field.id) : null,
      opcoes: ((p.field?.options ?? []) as Json[]).map((o) => ({ id: String(o.id), name: String(o.name) })),
      prazo: prazo ? String(prazo.id) : null, datas: datas.map((f) => String(f.name)),
    };
  };
  /** O item tem de ser deste projeto: `node` aceita qualquer id da conta. */
  const item = async (quadro: string, tarefa: string): Promise<Item> => {
    const n = (await chamar(`query ($id: ID!) { node(id: $id) { ... on ProjectV2Item { id updatedAt project { id }
      fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
      content { __typename ... on DraftIssue { id } ... on Issue { id state url } ... on PullRequest { id state url } } } } }`, { id: tarefa }, 'read')).node;
    if (!n?.id) throw new ProviderError('not_found', 'item não encontrado (ou sem acesso)');
    if (String(n.project?.id) !== quadro) throw new ErroAcao('este item não é deste projeto');
    return {
      id: String(n.id), updatedAt: n.updatedAt ? String(n.updatedAt) : null, statusNome: String(n.fieldValueByName?.name ?? ''), tipo: String(n.content?.__typename ?? ''),
      conteudo: n.content?.id ? String(n.content.id) : null, estado: n.content?.state ? String(n.content.state) : null, url: n.content?.url ? String(n.content.url) : null,
    };
  };

  const opcaoDe = (p: Projeto, coluna: string): Opcao => {
    const o = p.opcoes.find((x) => x.id === coluna);
    if (!o) throw new ErroAcao(p.opcoes.length ? `a coluna "${neutral(coluna, 60)}" não existe neste projeto` : 'este projeto não tem campo "Status": não há colunas para escolher', nomes(p.opcoes));
    return o;
  };
  const semPrazo = (p: Projeto) => new ErroAcao('este projeto não tem campo de data de prazo (nome com "prazo", "due" ou "target"): crie um ou mande sem prazo', p.datas.map((n) => neutral(n, 60)));

  /** Devolve a marca que a leitura vai ver neste item. */
  const gravarStatus = async (p: Projeto, quadro: string, tarefa: string, opcao: string): Promise<string | null> => {
    const r = (await mut(`mutation ($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { ${ITEM_FEITO} } }`,
      { projectId: quadro, itemId: tarefa, fieldId: p.status, value: { singleSelectOptionId: opcao } })).updateProjectV2ItemFieldValue?.projectV2Item;
    if (!r?.id) throw naoConfirmou('a mudança de coluna');
    return r.updatedAt ? String(r.updatedAt) : null;
  };
  const limpar = async (quadro: string, tarefa: string, campo: string): Promise<string | null> => {
    const r = (await mut(`mutation ($input: ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input: $input) { ${ITEM_FEITO} } }`,
      { projectId: quadro, itemId: tarefa, fieldId: campo })).clearProjectV2ItemFieldValue?.projectV2Item;
    if (!r?.id) throw naoConfirmou('a limpeza do campo');
    return r.updatedAt ? String(r.updatedAt) : null;
  };
  const gravarPrazo = async (p: Projeto, quadro: string, tarefa: string, prazo: string | null): Promise<string | null> => {
    if (!p.prazo) throw semPrazo(p);
    if (prazo === null) return limpar(quadro, tarefa, p.prazo);
    const r = (await mut(`mutation ($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { ${ITEM_FEITO} } }`,
      { projectId: quadro, itemId: tarefa, fieldId: p.prazo, value: { date: prazo } })).updateProjectV2ItemFieldValue?.projectV2Item;
    if (!r?.id) throw naoConfirmou('a mudança de prazo');
    return r.updatedAt ? String(r.updatedAt) : null;
  };

  return {
    async criar(quadro, n) {
      if (!n.titulo?.trim()) throw new ErroAcao('falta o título');
      const p = await projeto(quadro);
      if (n.prazo && !p.prazo) throw semPrazo(p);
      // sem coluna: a primeira de verdade, nunca uma de "feito"; tarefa nova não nasce concluída. Confere antes de criar
      const coluna = n.coluna === SEM_STATUS ? undefined : n.coluna ? opcaoDe(p, n.coluna) : p.opcoes.find((o) => !DONE.test(o.name));
      const r = (await mut(`mutation ($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id updatedAt } } }`,
        { projectId: quadro, title: n.titulo, ...(n.descricao ? { body: n.descricao } : {}) })).addProjectV2DraftIssue?.projectItem;
      if (!r?.id) throw naoConfirmou('a criação do item');
      const id = String(r.id); let versao: string | null = r.updatedAt ? String(r.updatedAt) : null;
      // a API pede chamadas separadas para criar e preencher; aqui o erro é definitivo: repetir criaria outro item
      try {
        if (coluna) versao = await gravarStatus(p, quadro, id, coluna.id);
        if (n.prazo) versao = await gravarPrazo(p, quadro, id, n.prazo);
      } catch (e) {
        throw new ErroAcao(`o item foi criado (id ${id}), mas a coluna ou o prazo não foram gravados: ${e instanceof Error ? neutral(e.message, 300) : 'erro desconhecido'}. Não crie de novo: edite este item`, undefined, { id, versao, url: p.url });
      }
      return { id, versao, url: p.url };
    },
    async concluir(quadro, tarefa, feita) {
      const p = await projeto(quadro); const i = await item(quadro, tarefa);
      const url = i.url ?? p.url;
      const nada = (): Escrita => ({ id: tarefa, versao: i.updatedAt, url });
      if (feita) {
        if (DONE.test(i.statusNome)) return nada();
        const final = p.opcoes.find((o) => DONE.test(o.name));
        if (!final) {
          if (fechado(i)) return nada(); // a leitura já vê concluída: não há o que mudar
          throw new ErroAcao('este projeto não tem como marcar concluído: falta uma opção "Done" ou "Concluído" no campo Status', nomes(p.opcoes));
        }
        return { id: tarefa, versao: await gravarStatus(p, quadro, tarefa, final.id), url };
      }
      if (i.estado === 'MERGED') throw new ErroAcao('este pull request já foi mesclado: não dá para reabrir');
      if (fechado(i)) {
        if (i.tipo === 'Issue') await mut(`mutation ($input: ReopenIssueInput!) { reopenIssue(input: $input) { issue { id } } }`, { issueId: i.conteudo });
        else await mut(`mutation ($input: ReopenPullRequestInput!) { reopenPullRequest(input: $input) { pullRequest { id } } }`, { pullRequestId: i.conteudo });
      }
      if (!DONE.test(i.statusNome)) return { id: tarefa, versao: fechado(i) ? null : i.updatedAt, url };
      const aberta = p.opcoes.find((o) => !DONE.test(o.name));
      return { id: tarefa, versao: aberta ? await gravarStatus(p, quadro, tarefa, aberta.id) : await limpar(quadro, tarefa, p.status!), url };
    },
    async mover(quadro, tarefa, coluna) {
      const p = await projeto(quadro);
      if (coluna === SEM_STATUS) {
        if (!p.status) return { id: tarefa };
        return { id: tarefa, versao: await limpar(quadro, tarefa, p.status), url: p.url };
      }
      return { id: tarefa, versao: await gravarStatus(p, quadro, tarefa, opcaoDe(p, coluna).id), url: p.url };
    },
    async editar(quadro, tarefa, m) {
      if (m.titulo !== undefined && !m.titulo.trim()) throw new ErroAcao('o título não pode ficar vazio');
      const p = await projeto(quadro);
      if (m.prazo !== undefined && !p.prazo) throw semPrazo(p);
      const i = await item(quadro, tarefa);
      let versao: string | null = null;
      if (m.titulo !== undefined || m.descricao !== undefined) {
        const textos = { ...(m.titulo !== undefined ? { title: m.titulo } : {}), ...(m.descricao !== undefined ? { body: m.descricao } : {}) };
        if (i.tipo === 'DraftIssue') {
          const r = (await mut(`mutation ($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id } } }`, { draftIssueId: i.conteudo, ...textos })).updateProjectV2DraftIssue?.draftIssue;
          if (!r?.id) throw naoConfirmou('a mudança no rascunho');
        } else if (i.tipo === 'Issue') {
          const r = (await mut(`mutation ($input: UpdateIssueInput!) { updateIssue(input: $input) { issue { id } } }`, { id: i.conteudo, ...textos })).updateIssue?.issue;
          if (!r?.id) throw naoConfirmou('a mudança na issue');
        } else if (i.tipo === 'PullRequest') {
          const r = (await mut(`mutation ($input: UpdatePullRequestInput!) { updatePullRequest(input: $input) { pullRequest { id } } }`, { pullRequestId: i.conteudo, ...textos })).updatePullRequest?.pullRequest;
          if (!r?.id) throw naoConfirmou('a mudança no pull request');
        } else throw new ErroAcao('o conteúdo deste item não está acessível: confira o acesso ao repositório');
      }
      if (m.prazo !== undefined) versao = await gravarPrazo(p, quadro, tarefa, m.prazo);
      return { id: tarefa, versao, url: i.url ?? p.url };
    },
    async comentar(quadro, tarefa, texto) {
      idProjeto(quadro);
      const i = await item(quadro, tarefa);
      if (i.tipo !== 'Issue' && i.tipo !== 'PullRequest') throw new ErroAcao('rascunho de projeto não tem comentários no GitHub: converta em issue ou use a descrição');
      const r = (await mut(`mutation ($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id } } } }`, { subjectId: i.conteudo, body: texto })).addComment;
      if (!r?.commentEdge?.node?.id) throw naoConfirmou('o comentário');
    },
  };
}
