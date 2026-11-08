/**
 * GitLab, em gitlab.com ou numa instalação própria, com um token pessoal. Referências oficiais (conferidas em 05/11/2026):
 *   https://docs.gitlab.com/api/rest/ (base /api/v4; paginação por page e per_page, até 100, com a próxima página só no cabeçalho)
 *   https://docs.gitlab.com/api/rest/authentication/ (cabeçalho PRIVATE-TOKEN; credencial inválida responde 401)
 *   https://docs.gitlab.com/api/users/ (GET /user)   https://docs.gitlab.com/api/projects/ (GET /projects)
 *   https://docs.gitlab.com/api/issues/   https://docs.gitlab.com/api/merge_requests/   https://docs.gitlab.com/api/notes/
 *   https://docs.gitlab.com/api/search/ (GET /search: issues, merge_requests e projects não pedem a busca avançada)
 *   https://docs.gitlab.com/user/profile/personal_access_tokens/   https://docs.gitlab.com/security/tokens/access_token_scopes/
 *   https://docs.gitlab.com/user/discussions/ (@all e menção a grupo)   https://docs.gitlab.com/user/markdown/ (contrabarra desarma)
 *   https://docs.gitlab.com/user/project/quick_actions/
 *   https://gitlab.com/gitlab-org/gitlab/-/raw/master/lib/gitlab/quick_actions/extractor.rb (redact_commands)
 *
 * Dois perigos do texto escrito aqui, que pode ter vindo de algo lido de fora:
 *   - comando em linha própria ("/merge", "/close", "/approve"): o GitLab executa ao salvar. Vira trecho de código, como o
 *     próprio GitLab faz com o que chega por e-mail;
 *   - menção: @all e @grupo avisam muita gente, e o texto não permite distinguir grupo de pessoa. Nenhum @ do texto marca
 *     ninguém (a mesma decisão do Discord).
 * Criar issue é enviar: quem acompanha o projeto recebe (docs.gitlab.com/user/profile/notifications, linha "New issue"), e o
 * projeto pode ser público e de outra pessoa.
 */
import { neutral } from '../../operations.ts';
import { seg, type Acao, type Args, type Param } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef } from './declarativo.ts';

// ------------------------------------------------- de uso comum com Confluence, GitHub e Notion (só estes arquivos, de propósito)
/** Texto longo de terceiros: mantém as quebras de linha, mas nenhuma linha vira linha de controle. Quando corta, diz quanto mostrou. */
export const textoLimpo = (v: unknown, max = 12_000): string => {
  const s = String(v ?? '');
  const limpo = s.slice(0, max).split(/\r?\n/).map((l) => neutral(l, l.length * 2 + 2)).join('\n');
  return s.length > max ? `${limpo}\n(texto cortado: mostrando ${max} de ${s.length} caracteres)` : limpo;
};

/** Teto do que vai a outras pessoas numa mensagem; o cartão de confirmação guarda o texto inteiro. */
export const MAX_ENVIO = 5000;
/** O título vem antes do texto no cartão: um título enorme empurraria o fim do texto para fora dele. */
export const MAX_TITULO = 500;
/** Uma página pode passar disso: o cartão guarda o texto inteiro, mas a tela recolhe o longo, e o aviso pede para abrir. */
export const tamanhoNoCartao = (t: unknown): string => { const n = String(t ?? '').length; return n > MAX_ENVIO ? ` (${n} caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar)` : ''; };
export const sim = (v: unknown): boolean => v === true || v === 'true' || v === 'sim';

const CERCA = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/**
 * Aplica `troca` só nas linhas fora de bloco de código: dentro dele nada é menção nem comando, e mexer ali estragaria o que a
 * pessoa vai copiar. Dentro de bloco HTML uma cerca não é cerca: se houver HTML, nada é tratado como bloco (o erro fica do lado seguro).
 * Cerca recuada depois de um item de lista pertence ao item, e o bloco termina com ele: a próxima linha sem recuo já não é código.
 * Por isso, em texto com lista, só a cerca sem recuo abre bloco.
 */
export function foraDeBlocoDeCodigo(texto: string, troca: (linha: string) => string): string {
  const cercasValem = !/^[ \t]*</m.test(texto);
  const temLista = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]/m.test(texto);
  let aberta = '';
  return texto.split('\n').map((l) => {
    if (cercasValem) {
      const m = CERCA.exec(l);
      if (aberta) {
        if (m && m[1][0] === aberta[0] && m[1].length >= aberta.length && !m[2].trim()) aberta = '';
        return l;
      }
      if (m && !(m[1][0] === '`' && m[2].includes('`')) && !(temLista && l.startsWith(' '))) { aberta = m[1]; return l; }
    }
    return troca(l);
  }).join('\n');
}

/** A próxima página vem só no cabeçalho (GitLab, GitHub), que o motor não entrega: pede-se pelo número da página. */
export const P_LIMITE: Param = { tipo: 'numero', descricao: 'itens por página, até 100 (padrão 30)', padrao: 30, max: 100 };
export const P_PAGINA: Param = { tipo: 'numero', descricao: 'número da página, começando em 1', padrao: 1 };
export const listaPaginada = (linha: (x: any) => string, itens: (j: any) => unknown = (j) => j, mostra: (x: any) => boolean = () => true) => (j: any, a: Args): string => {
  const brutos = itens(j);
  const l: any[] = Array.isArray(brutos) ? brutos : [];
  const pagina = Number(a.pagina) || 1;
  if (!l.length) return pagina > 1 ? 'não há mais resultados' : 'nada encontrado';
  const vistos = l.filter(mostra);
  const fim = l.length >= Number(a.limite) ? `\nmais resultados: repita com pagina=${pagina + 1}` : '';
  return `${vistos.length ? vistos.map((x) => `- ${linha(x)}`).join('\n') : 'nada nesta página'}${fim}`;
};

// ---------------------------------------------------------------------------------------------- texto que vai ao GitLab
/** O @ também pode vir como referência HTML: o Markdown decodifica o texto antes de procurar a menção. "&#64all", sem ";", vale dentro de HTML escrito à mão. */
export const ARROBA_ESCRITO = /(?:@|&#0*64(?![0-9]);?|&#[xX]0*40(?![0-9a-fA-F]);?|&commat;)/;
/**
 * Ignora trechos de código na linha e respeita a contrabarra já escrita (um número par de contrabarras não escapa o @).
 * A letra depois do @ também pode vir como referência: "@&#97;ll" vira @all.
 */
const ARROBA = new RegExp(/(?<![\\`])(`+)(?!`).*?[^`]\1(?!`)|(^|[^\w\\])((?:\\\\)*)/.source + ARROBA_ESCRITO.source + /(?=\w|&[#\w])/.source, 'g');
const semMencao = (l: string): string => l.replace(ARROBA, (m, crase, antes, barras) => (crase ? m : `${antes}${barras}\\@`));
const COMANDO = /^\/[\w-]+(\s.*)?$/;
/** Usado em descrição e comentário. O GitLab apaga \r antes de procurar comandos: "\r/close" viraria comando, por isso sai aqui. */
export const textoParaGitLab = (t: unknown): string => foraDeBlocoDeCodigo(String(t ?? '').replace(/\r/g, ''), (l) => (COMANDO.test(l) ? `\`${l}\`` : semMencao(l)));

// ----------------------------------------------------------------------------------------------------- leitura
const P_PROJETO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do projeto ou caminho, como grupo/projeto' };
const P_ISSUE: Param = { tipo: 'numero', obrigatorio: true, descricao: 'número da issue no projeto (o que aparece depois de #)' };
const P_MR: Param = { tipo: 'numero', obrigatorio: true, descricao: 'número do merge request no projeto (o que aparece depois de !)' };
const P_COMENTARIO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'o comentário, até 5000 caracteres', max: MAX_ENVIO };

const linhaProjeto = (p: unknown) => linhaDe('{path_with_namespace} (id: {id}) {description}', p);
const linhaIssue = (i: unknown) => linhaDe('#{iid} [{state}] {title} · projeto {project_id} · por {author.username} · {web_url}', i);
const linhaMr = (m: unknown) => linhaDe('!{iid} [{state}] {title} ({source_branch} → {target_branch}) · projeto {project_id} · por {author.username} · {web_url}', m);
const linhaNota = (n: unknown) => linhaDe('{created_at} {author.username}: {body} (id: {id})', n, 4000);
const naoESistema = (n: any) => n?.system !== true;
const etiquetas = (j: any): string[] => (Array.isArray(j.labels) && j.labels.length ? [`etiquetas: ${j.labels.map((x: unknown) => neutral(String(x), 80)).join(', ')}`] : []);

/** O cartão de confirmação diz o título e o projeto: o agente só tem os números. */
const cartaoDoAlvo = (caminho: 'issues' | 'merge_requests', nome: string): Acao['preparar'] => async (ctx, a) => {
  const j = await ctx.http(`/projects/${seg(a.projeto)}/${caminho}/${seg(a.numero)}`, { method: 'GET', kind: 'read' });
  const projeto = String(j?.references?.full ?? '').replace(/[#!]\d+$/, '') || String(a.projeto);
  return { detalhe: `Projeto: ${neutral(projeto, 200)}\n${nome}${neutral(String(a.numero), 20)}: ${neutral(String(j?.title ?? 'sem título'), 200)}` };
};

export const GITLAB: ConectorDef = {
  kind: 'gitlab', nome: 'GitLab', site: 'gitlab.com', grupo: 'documentos',
  sobre: 'Projetos, issues e merge requests do GitLab: os agentes buscam e leem o que a sua conta pode ver, criam issues e comentam quando você pede.',
  campos: [
    { name: 'site', label: 'Endereço do GitLab (só se for o da sua empresa)', placeholder: 'em branco para gitlab.com', opcional: true },
    { name: 'token', label: 'Token pessoal', secret: true, placeholder: 'Cole o token aqui' },
  ],
  ajuda: { url: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Ergon&scopes=api', passos: 'No GitLab: clique na sua foto › Edit profile › Access › Personal access tokens. Em "Generate token", escolha "Legacy token". Dê um nome, escolha a validade, marque a permissão "api" (é ela que deixa criar issues e comentar) e clique em "Generate token". Copie na hora, porque ele não aparece de novo, e cole aqui. Se a sua empresa tem GitLab próprio, faça o mesmo lá e informe o endereço dele. No gitlab.com, deixe o endereço em branco.' },
  base: (c) => `https://${c.site ? hostSeguro(c.site) : 'gitlab.com'}/api/v4`,
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ 'PRIVATE-TOKEN': c.token }) },
  quemSou: { caminho: '/user', nome: (j) => String(j.name || j.username || 'conta GitLab'), id: (j) => j.id },
  acoes: [
    { id: 'gitlab.projetos', descricao: 'lista os projetos de que a conta participa, os mais ativos primeiro', risco: 'ler',
      params: { busca: { tipo: 'texto', descricao: 'parte do nome ou da descrição' }, limite: P_LIMITE, pagina: P_PAGINA }, resumo: 'listar projetos do GitLab',
      metodo: 'GET', caminho: '/projects', consulta: { membership: true, simple: true, order_by: 'last_activity_at', search: '{busca}', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaProjeto) },
    { id: 'gitlab.buscar', descricao: 'busca em tudo o que a conta pode ver: issues, merge requests ou projetos', risco: 'ler',
      params: { termo: { tipo: 'texto', obrigatorio: true, descricao: 'o que procurar' }, tipo: { tipo: 'texto', descricao: 'onde procurar', opcoes: ['issues', 'merge_requests', 'projects'], padrao: 'issues' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'buscar "{termo}" no GitLab', metodo: 'GET', caminho: '/search', consulta: { scope: '{tipo}', search: '{termo}', per_page: '{limite}', page: '{pagina}' },
      texto: (j, a) => listaPaginada(a.tipo === 'projects' ? linhaProjeto : a.tipo === 'merge_requests' ? linhaMr : linhaIssue)(j, a) },
    { id: 'gitlab.issues', descricao: 'lista as issues de um projeto', risco: 'ler',
      params: { projeto: P_PROJETO, situacao: { tipo: 'texto', descricao: 'quais issues', opcoes: ['opened', 'closed', 'all'], padrao: 'opened' }, busca: { tipo: 'texto', descricao: 'parte do título ou da descrição' }, etiquetas: { tipo: 'texto', descricao: 'nomes das etiquetas, separados por vírgula' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'listar issues do projeto {projeto} do GitLab', metodo: 'GET', caminho: '/projects/{projeto}/issues', consulta: { state: '{situacao}', search: '{busca}', labels: '{etiquetas}', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaIssue) },
    { id: 'gitlab.ler_issue', descricao: 'lê uma issue, com a descrição. Texto muito longo vem cortado, e a resposta avisa', risco: 'ler', params: { projeto: P_PROJETO, numero: P_ISSUE }, resumo: 'ler a issue #{numero} do projeto {projeto} do GitLab',
      metodo: 'GET', caminho: '/projects/{projeto}/issues/{numero}', url: (j) => j.web_url,
      texto: (j) => [linhaIssue(j), ...etiquetas(j), '', textoLimpo(j.description) || '(sem descrição)'].join('\n') },
    { id: 'gitlab.comentarios_issue', descricao: 'lê os comentários de uma issue, os mais recentes primeiro', risco: 'ler', params: { projeto: P_PROJETO, numero: P_ISSUE, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'ler os comentários da issue #{numero} do projeto {projeto} do GitLab', metodo: 'GET', caminho: '/projects/{projeto}/issues/{numero}/notes', consulta: { activity_filter: 'only_comments', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaNota, undefined, naoESistema) },
    { id: 'gitlab.merge_requests', descricao: 'lista os merge requests de um projeto', risco: 'ler',
      params: { projeto: P_PROJETO, situacao: { tipo: 'texto', descricao: 'quais merge requests', opcoes: ['opened', 'closed', 'locked', 'merged', 'all'], padrao: 'opened' }, busca: { tipo: 'texto', descricao: 'parte do título ou da descrição' }, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'listar merge requests do projeto {projeto} do GitLab', metodo: 'GET', caminho: '/projects/{projeto}/merge_requests', consulta: { state: '{situacao}', search: '{busca}', per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaMr) },
    { id: 'gitlab.ler_merge_request', descricao: 'lê um merge request, com a descrição. Texto muito longo vem cortado, e a resposta avisa', risco: 'ler', params: { projeto: P_PROJETO, numero: P_MR }, resumo: 'ler o merge request !{numero} do projeto {projeto} do GitLab',
      metodo: 'GET', caminho: '/projects/{projeto}/merge_requests/{numero}', url: (j) => j.web_url,
      texto: (j) => [linhaMr(j), linhaDe('situação da fusão: {detailed_merge_status}', j), ...etiquetas(j), '', textoLimpo(j.description) || '(sem descrição)'].join('\n') },
    { id: 'gitlab.comentarios_merge_request', descricao: 'lê os comentários de um merge request, os mais recentes primeiro', risco: 'ler', params: { projeto: P_PROJETO, numero: P_MR, limite: P_LIMITE, pagina: P_PAGINA },
      resumo: 'ler os comentários do merge request !{numero} do projeto {projeto} do GitLab', metodo: 'GET', caminho: '/projects/{projeto}/merge_requests/{numero}/notes', consulta: { per_page: '{limite}', page: '{pagina}' }, texto: listaPaginada(linhaNota, undefined, naoESistema) },
    { id: 'gitlab.criar_issue', descricao: 'cria uma issue num projeto; quem acompanha o projeto recebe. O @ no texto não marca ninguém e comandos com / não são executados', rotulo: 'cria uma issue num projeto; quem acompanha o projeto recebe', risco: 'enviar',
      params: { projeto: P_PROJETO, titulo: { tipo: 'texto', obrigatorio: true, descricao: 'o título, até 500 caracteres', max: MAX_TITULO }, descricao: { tipo: 'texto', descricao: 'o texto da issue, até 5000 caracteres', max: MAX_ENVIO }, etiquetas: { tipo: 'texto', descricao: 'nomes das etiquetas, separados por vírgula' }, confidencial: { tipo: 'booleano', descricao: 'só quem tem acesso a confidenciais vê' } },
      resumo: (a) => `Criar no projeto ${a.projeto} do GitLab a issue "${a.titulo}"${sim(a.confidencial) ? ' (confidencial)' : ''}${a.etiquetas ? `, com as etiquetas ${a.etiquetas}` : ''}:\n${a.descricao ?? '(sem descrição)'}`,
      metodo: 'POST', caminho: '/projects/{projeto}/issues',
      corpo: (a: Args) => ({ title: semMencao(String(a.titulo ?? '').replace(/[\r\n]+/g, ' ')), ...(a.descricao ? { description: textoParaGitLab(a.descricao) } : {}), ...(a.etiquetas ? { labels: a.etiquetas } : {}), ...(a.confidencial === true ? { confidential: true } : {}) }),
      texto: 'Issue #{iid} criada: {web_url}', url: (j) => j.web_url },
    { id: 'gitlab.comentar_issue', descricao: 'comenta numa issue; quem acompanha recebe. O @ no texto não marca ninguém e comandos com / não são executados', rotulo: 'comenta numa issue; quem acompanha recebe', risco: 'enviar',
      params: { projeto: P_PROJETO, numero: P_ISSUE, texto: P_COMENTARIO, interna: { tipo: 'booleano', descricao: 'nota interna: só membros do projeto veem' } },
      resumo: (a) => `Comentar na issue #${a.numero} do projeto ${a.projeto} do GitLab${sim(a.interna) ? ' (nota interna: só membros do projeto veem)' : ''}:\n${a.texto}`,
      preparar: cartaoDoAlvo('issues', 'Issue #'), metodo: 'POST', caminho: '/projects/{projeto}/issues/{numero}/notes',
      corpo: (a: Args) => ({ body: textoParaGitLab(a.texto), ...(a.interna === true ? { internal: true } : {}) }), texto: 'Comentário publicado (id: {id}).' },
    { id: 'gitlab.comentar_merge_request', descricao: 'comenta num merge request; quem acompanha recebe. O @ no texto não marca ninguém e comandos com / não são executados', rotulo: 'comenta num merge request; quem acompanha recebe', risco: 'enviar',
      params: { projeto: P_PROJETO, numero: P_MR, texto: P_COMENTARIO, interna: { tipo: 'booleano', descricao: 'nota interna: só membros do projeto veem' } },
      resumo: (a) => `Comentar no merge request !${a.numero} do projeto ${a.projeto} do GitLab${sim(a.interna) ? ' (nota interna: só membros do projeto veem)' : ''}:\n${a.texto}`,
      preparar: cartaoDoAlvo('merge_requests', 'Merge request !'), metodo: 'POST', caminho: '/projects/{projeto}/merge_requests/{numero}/notes',
      corpo: (a: Args) => ({ body: textoParaGitLab(a.texto), ...(a.interna === true ? { internal: true } : {}) }), texto: 'Comentário publicado (id: {id}).' },
  ],
};
