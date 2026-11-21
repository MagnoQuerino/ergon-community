/**
 * GitHub, além dos quadros: repositórios, issues e pull requests, com a mesma credencial do GitHub Projects. Campos e ajuda ficam
 * com o catálogo. Referências oficiais (conferidas em 05/11/2026):
 *   https://docs.github.com/en/rest/about-the-rest-api/api-versions (2026-03-10 é a atual; 2022-11-28 vale até 10/03/2028)
 *   https://docs.github.com/en/rest/about-the-rest-api/breaking-changes (nada do que lemos ou escrevemos muda na 2026-03-10)
 *   https://docs.github.com/en/rest/repos/repos (GET /user/repos)   https://docs.github.com/en/rest/search/search (GET /search/issues)
 *   https://docs.github.com/en/rest/issues/issues   https://docs.github.com/en/rest/issues/comments   https://docs.github.com/en/rest/pulls/pulls
 *   https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
 *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps (repo, public_repo)
 *   https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax
 *
 * Toda menção com @ avisa alguém: @org/equipe avisa a equipe inteira, e robôs obedecem a "@dependabot merge". Nenhum @ do texto
 * marca ninguém (a mesma decisão do Discord). A documentação não traz um jeito próprio de desarmar: um caractere invisível depois
 * do @ quebra a menção sem mudar o que se lê.
 * Criar, fechar e reabrir issue são enviar: a documentação diz que criar "triggers notifications", o repositório pode ser público e
 * de outra pessoa, e o catálogo já trata assim concluir e reabrir pelo quadro (catalogo.ts).
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';
import { ARROBA_ESCRITO, foraDeBlocoDeCodigo, listaPaginada, MAX_ENVIO, MAX_TITULO, P_LIMITE, P_PAGINA, textoLimpo } from './gitlab.ts';

/**
 * Ignora trechos de código na linha: ali o @ não é menção, e o invisível estragaria o que se copia.
 * O @ e a letra depois dele também podem vir como referência HTML (&#64;all, @&#97;ll): o Markdown decodifica antes de procurar a menção.
 */
const ARROBA = new RegExp(/(?<![\\`])(`+)(?!`).*?[^`]\1(?!`)|(^|[^\w])/.source + ARROBA_ESCRITO.source + /(?=[A-Za-z0-9]|&[#\w])/.source, 'g');
export const semMencao = (t: unknown): string => foraDeBlocoDeCodigo(String(t ?? '').replace(/\r/g, ''), (l) => l.replace(ARROBA, (m, crase, antes) => (crase ? m : `${antes}@\u200B`)));

const P_DONO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'dono do repositório (pessoa ou organização)' };
const P_REPO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'nome do repositório' };
const P_NUMERO: Param = { tipo: 'numero', obrigatorio: true, descricao: 'número da issue ou do pull request' };
/** Quem escreve "dono/repositorio" num campo só recebe o erro certo, em vez de um "não encontrado" do GitHub. */
const repoOk = async (_c: unknown, a: Args): Promise<Args> => {
  for (const k of ['dono', 'repositorio']) if (!/^[\w.-]{1,100}$/.test(String(a[k] ?? ''))) throw new ErroAcao(`"${k}" inválido: use só o nome, sem barras`);
  return a;
};

const rotulos = (j: any): string[] => (Array.isArray(j.labels) && j.labels.length ? [`etiquetas: ${j.labels.map((x: any) => neutral(String(x?.name ?? x), 80)).join(', ')}`] : []);
const linhaIssue = (i: any) => `${i.pull_request ? 'pull request ' : ''}${linhaDe('#{number} [{state}] {title} · por {user.login} · {html_url}', i)}`;
const linhaPull = (p: any) => linhaDe('#{number} [{state}] {title} ({head.ref} → {base.ref}) · por {user.login} · {html_url}', p);
const linhaRepo = (r: any) => { const d = linhaDe('{description}', r); return `${linhaDe('{full_name}', r)}${r.private ? ' (privado)' : ''}${d ? `: ${d}` : ''}`; };
const linhaComentario = (c: any) => linhaDe('{created_at} {user.login}: {body} (id: {id})', c, 4000);

const naoEPull = (j: any, a: Args): any => {
  if (j?.pull_request) throw new ErroAcao(`o número ${a.numero} é um pull request, não uma issue: nada foi alterado`);
  return j;
};
/** Mudar a situação de um pull request pelo caminho de issue também funcionaria: aqui é só para issue. */
async function soIssue(ctx: CtxAcao, a: Args): Promise<Args> {
  await repoOk(ctx, a);
  naoEPull(await ctx.http(`/repos/${seg(a.dono)}/${seg(a.repositorio)}/issues/${seg(a.numero)}`), a);
  return a;
}

/** O cartão de confirmação diz o título e o repositório: o agente só tem o número. O caminho de issue também responde por pull request. */
const lerAlvo = async (ctx: CtxAcao, a: Args): Promise<any> => {
  await repoOk(ctx, a);
  return ctx.http(`/repos/${seg(a.dono)}/${seg(a.repositorio)}/issues/${seg(a.numero)}`, { method: 'GET', kind: 'read' });
};
const detalheDoAlvo = (j: any, a: Args): string => `Repositório: ${neutral(`${a.dono}/${a.repositorio}`, 200)}\n${j?.pull_request ? 'Pull request' : 'Issue'} #${neutral(String(a.numero), 20)}: ${neutral(String(j?.title ?? 'sem título'), 200)}`;
const CARTAO_COMENTAR: Acao['preparar'] = async (ctx, a) => ({ detalhe: detalheDoAlvo(await lerAlvo(ctx, a), a) });
const CARTAO_FECHAR: Acao['preparar'] = async (ctx, a) => { const j = naoEPull(await lerAlvo(ctx, a), a); return { detalhe: detalheDoAlvo(j, a) }; };

export const GITHUB_EXTRAS: ConectorDef = {
  kind: 'github', nome: 'GitHub', site: 'github.com', grupo: 'documentos',
  sobre: 'Repositórios, issues e pull requests do GitHub: os agentes buscam e leem o que a sua conta pode ver, criam, fecham e reabrem issues e comentam quando você pede.',
  campos: [],
  ajuda: { url: 'https://github.com/settings/tokens', passos: 'No GitHub: sua foto › Settings › Developer settings › Personal access tokens › Tokens (classic) › Generate new token › Generate new token (classic). Marque "repo" (ou só "public_repo", se forem apenas repositórios públicos) e clique em "Generate token". Copie e cole aqui.' },
  base: 'https://api.github.com',
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Ergon' }) },
  quemSou: { caminho: '/user', nome: (j) => String(j.name || j.login || 'conta GitHub'), id: (j) => j.node_id },
  acoes: [
    { id: 'github.repositorios', descricao: 'lista os repositórios a que a conta tem acesso, os mais recentes primeiro', risco: 'ler',
      params: { visibilidade: { tipo: 'texto', descricao: 'quais repositórios', opcoes: ['all', 'public', 'private'], padrao: 'all' }, limite: P_LIMITE, pagina: P_PAGINA }, resumo: 'listar repositórios do GitHub',
      metodo: 'GET', caminho: '/user/repos', consulta: { visibility: '{visibilidade}', sort: 'updated', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaRepo) },
    { id: 'github.buscar', descricao: 'procura issues ou pull requests em tudo o que a conta pode ver; aceita os filtros da busca do GitHub, como repo:dono/nome ou is:open', rotulo: 'procura issues ou pull requests em tudo o que a conta pode ver', risco: 'ler',
      params: { busca: { tipo: 'texto', obrigatorio: true, descricao: 'o que procurar' }, tipo: { tipo: 'texto', descricao: 'o que procurar', opcoes: ['issue', 'pull-request'], padrao: 'issue' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'buscar "{busca}" no GitHub',
      antes: async (_c, a) => ({ ...a, q: /(^|\s)is:(issue|pr|pull-request)(\s|$)/i.test(String(a.busca)) ? a.busca : `${a.busca} is:${a.tipo}` }),
      metodo: 'GET', caminho: '/search/issues', consulta: { q: '{q}', per_page: '{limite}', page: '{pagina}' },
      texto: (j, a) => `${listaPaginada(linhaIssue, (x) => x.items)(j, a)}${j.incomplete_results ? '\nbusca incompleta: o GitHub avisou que o tempo acabou antes de olhar tudo' : ''}` },
    { id: 'github.issues', descricao: 'lista as issues de um repositório; os pull requests vêm junto e marcados', risco: 'ler',
      params: { dono: P_DONO, repositorio: P_REPO, situacao: { tipo: 'texto', descricao: 'quais issues', opcoes: ['open', 'closed', 'all'], padrao: 'open' }, etiquetas: { tipo: 'texto', descricao: 'nomes das etiquetas, separados por vírgula' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'listar issues de {dono}/{repositorio} no GitHub', antes: repoOk, metodo: 'GET', caminho: '/repos/{dono}/{repositorio}/issues', consulta: { state: '{situacao}', labels: '{etiquetas}', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaIssue) },
    { id: 'github.ler_issue', descricao: 'lê uma issue, com a descrição. Texto muito longo vem cortado, e a resposta avisa', risco: 'ler', params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO }, resumo: 'ler a issue #{numero} de {dono}/{repositorio} no GitHub', antes: repoOk,
      metodo: 'GET', caminho: '/repos/{dono}/{repositorio}/issues/{numero}', url: (j) => j.html_url,
      texto: (j) => [linhaIssue(j), ...rotulos(j), '', textoLimpo(j.body) || '(sem descrição)'].join('\n') },
    { id: 'github.comentarios', descricao: 'lê os comentários de uma issue ou de um pull request, os mais antigos primeiro', risco: 'ler', params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'ler os comentários de #{numero} em {dono}/{repositorio} no GitHub', antes: repoOk, metodo: 'GET', caminho: '/repos/{dono}/{repositorio}/issues/{numero}/comments', consulta: { per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaComentario) },
    { id: 'github.pull_requests', descricao: 'lista os pull requests de um repositório', risco: 'ler',
      params: { dono: P_DONO, repositorio: P_REPO, situacao: { tipo: 'texto', descricao: 'quais pull requests', opcoes: ['open', 'closed', 'all'], padrao: 'open' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'listar pull requests de {dono}/{repositorio} no GitHub', antes: repoOk, metodo: 'GET', caminho: '/repos/{dono}/{repositorio}/pulls', consulta: { state: '{situacao}', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaPull) },
    { id: 'github.ler_pull_request', descricao: 'lê um pull request, com a descrição. Texto muito longo vem cortado, e a resposta avisa', risco: 'ler', params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO }, resumo: 'ler o pull request #{numero} de {dono}/{repositorio} no GitHub', antes: repoOk,
      metodo: 'GET', caminho: '/repos/{dono}/{repositorio}/pulls/{numero}', url: (j) => j.html_url,
      texto: (j) => [linhaPull(j), `${j.merged ? 'já incorporado' : j.draft ? 'rascunho' : 'ainda não incorporado'} · ${linhaDe('situação da fusão: {mergeable_state}', j)}`, ...rotulos(j), '', textoLimpo(j.body) || '(sem descrição)'].join('\n') },
    { id: 'github.criar_issue', descricao: 'cria uma issue num repositório; quem acompanha o repositório recebe. O @ no texto não marca ninguém', risco: 'enviar',
      params: { dono: P_DONO, repositorio: P_REPO, titulo: { tipo: 'texto', obrigatorio: true, descricao: 'o título, até 500 caracteres', max: MAX_TITULO }, texto: { tipo: 'texto', descricao: 'o texto da issue, até 5000 caracteres', max: MAX_ENVIO }, etiquetas: { tipo: 'lista', descricao: 'nomes das etiquetas; sem permissão de escrita no repositório, o GitHub as ignora' } },
      resumo: (a) => `Criar em ${a.dono}/${a.repositorio} no GitHub a issue "${a.titulo}"${a.etiquetas ? `, com as etiquetas ${a.etiquetas}` : ''}:\n${a.texto ?? '(sem descrição)'}`,
      antes: repoOk, metodo: 'POST', caminho: '/repos/{dono}/{repositorio}/issues',
      corpo: (a: Args) => ({ title: semMencao(String(a.titulo ?? '').replace(/[\r\n]+/g, ' ')), ...(a.texto ? { body: semMencao(a.texto) } : {}), ...(Array.isArray(a.etiquetas) && a.etiquetas.length ? { labels: a.etiquetas } : {}) }),
      texto: 'Issue #{number} criada: {html_url}', url: (j) => j.html_url },
    { id: 'github.comentar', descricao: 'comenta numa issue ou num pull request; quem acompanha recebe. O @ no texto não marca ninguém', risco: 'enviar',
      params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o comentário, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: (a) => `Comentar em #${a.numero} de ${a.dono}/${a.repositorio} no GitHub:\n${a.texto}`,
      preparar: CARTAO_COMENTAR, antes: repoOk, metodo: 'POST', caminho: '/repos/{dono}/{repositorio}/issues/{numero}/comments',
      corpo: (a: Args) => ({ body: semMencao(a.texto) }), texto: 'Comentário publicado: {html_url}', url: (j) => j.html_url },
    { id: 'github.fechar_issue', descricao: 'fecha uma issue (não vale para pull request); quem acompanha recebe', risco: 'enviar',
      params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO, motivo: { tipo: 'texto', descricao: 'completed = resolvida; not_planned = não será feita', opcoes: ['completed', 'not_planned'], padrao: 'completed' } },
      resumo: (a) => `Fechar a issue #${a.numero} de ${a.dono}/${a.repositorio} no GitHub, como ${a.motivo === 'not_planned' ? 'não planejada' : 'resolvida'}`,
      preparar: CARTAO_FECHAR, antes: soIssue, metodo: 'PATCH', caminho: '/repos/{dono}/{repositorio}/issues/{numero}', corpo: { state: 'closed', state_reason: '{motivo}' }, texto: 'Issue #{number} fechada: {html_url}', url: (j) => j.html_url },
    { id: 'github.reabrir_issue', descricao: 'reabre uma issue fechada (não vale para pull request); quem acompanha recebe', risco: 'enviar', params: { dono: P_DONO, repositorio: P_REPO, numero: P_NUMERO },
      resumo: 'Reabrir a issue #{numero} de {dono}/{repositorio} no GitHub',
      preparar: CARTAO_FECHAR, antes: soIssue, metodo: 'PATCH', caminho: '/repos/{dono}/{repositorio}/issues/{numero}', corpo: { state: 'open', state_reason: 'reopened' }, texto: 'Issue #{number} reaberta: {html_url}', url: (j) => j.html_url },
  ],
};
