/**
 * Confluence Cloud, com o e-mail da conta e um token de API. Referências oficiais (conferidas em 05/11/2026):
 *   https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/ (e-mail:token em Basic, no endereço do site)
 *   https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ (nomes dos botões e validade)
 *   https://support.atlassian.com/confluence/kb/scoped-api-tokens-in-confluence-cloud/ (token com escopos só em api.atlassian.com)
 *   https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/   .../rest/v2/api-group-space/   .../rest/v2/api-group-comment/
 *   especificação: https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json (corpo, versão, _links.next, _links.base)
 *   https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/ (GET /wiki/rest/api/search, cursor)
 *   https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/ (GET /wiki/rest/api/user/current)
 *   especificação: https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json (excerpt, tipo "anonymous" do usuário)
 *   https://developer.atlassian.com/cloud/confluence/performing-text-searches-using-cql/   .../cql-fields/ (text ~, type, space)
 *   https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ (nós do texto em atlas_doc_format)
 *
 * O texto simples vai escapado, em parágrafos: nada do que foi escrito vira macro nem menção. Para ler pedimos atlas_doc_format
 * (JSON com o texto puro), em vez de desmontar o XHTML do formato "storage". Para acrescentar, o "storage" atual é devolvido
 * intacto, senão o que a página já tem (macros, tabelas) se perderia.
 * Só "token sem escopos" funciona aqui: o com escopos exigiria outro endereço, descoberto por uma chamada (o `base` do motor é síncrono).
 * Criar e atualizar página são enviar: quem acompanha a página ou o espaço recebe e-mail, e página nova avisa na hora
 * (support.atlassian.com/confluence-cloud/docs/watch-pages-spaces-and-blogs).
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef } from './declarativo.ts';
import { MAX_ENVIO, MAX_TITULO, tamanhoNoCartao, textoLimpo } from './gitlab.ts';

/** O id de página é um inteiro de 64 bits: não pode virar Number. Só dígitos, porque também vai no corpo (pai, responder_a). */
const idOk = (a: Args, k: string): Args => {
  if (a[k] !== undefined && !/^\d{1,19}$/.test(String(a[k]))) throw new ErroAcao(`"${k}" precisa ser o número que identifica o item (só dígitos)`);
  return a;
};
const escapar = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** O "storage" que o Confluence espera. */
const storageDe = (a: Args): string => (a.formato === 'storage' ? String(a.texto ?? '') : String(a.texto ?? '').replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapar(p).replace(/\n/g, '<br/>')}</p>`).join(''));
const P_FORMATO: Param = { tipo: 'texto', descricao: 'texto = texto simples; storage = o formato de marcação do Confluence', opcoes: ['texto', 'storage'], padrao: 'texto' };
const corpoDe = (value: string) => ({ representation: 'storage', value });

const cursorDe = (link: unknown): string | null => (typeof link === 'string' ? new URLSearchParams(link.split('?')[1] ?? '').get('cursor') : null);
const linkDe = (j: any): string | null => (j?._links?.base && j?._links?.webui ? `${j._links.base}${j._links.webui}` : null);

/** Espaço pela chave (o que a pessoa conhece) ou pelo número (o que a criação de página pede). */
async function idDoEspaco(ctx: CtxAcao, espaco: string): Promise<string> {
  if (/^\d+$/.test(espaco)) return espaco;
  const j = await ctx.http(`/api/v2/spaces?keys=${encodeURIComponent(espaco)}`);
  const id = j?.results?.[0]?.id;
  if (!id) throw new ErroAcao(`não achei o espaço "${neutral(espaco, 60)}": use confluence.espacos para ver os que existem`);
  return String(id);
}

/** O texto de uma página: JSON em atlas_doc_format para texto corrido, sem perder títulos e listas. */
function adfParaTexto(n: any): string {
  if (!n || typeof n !== 'object') return '';
  const filhos = (sep = ''): string => (Array.isArray(n.content) ? n.content : []).map(adfParaTexto).join(sep);
  switch (n.type) {
    case 'text': return String(n.text ?? '');
    case 'hardBreak': return '\n';
    case 'mention': case 'emoji': case 'status': return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard': case 'blockCard': return String(n.attrs?.url ?? '');
    case 'paragraph': return filhos();
    case 'heading': return `${'#'.repeat(Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6))} ${filhos()}`;
    case 'bulletList': return (n.content ?? []).map((x: any) => `- ${adfParaTexto(x)}`).join('\n');
    case 'orderedList': return (n.content ?? []).map((x: any, i: number) => `${i + 1}. ${adfParaTexto(x)}`).join('\n');
    case 'blockquote': return filhos('\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock': return `\`\`\`\n${filhos()}\n\`\`\``;
    case 'rule': return '---';
    case 'tableRow': return filhos(' | ');
    case 'tableCell': case 'tableHeader': return filhos(' ');
    case 'doc': case 'panel': case 'expand': case 'nestedExpand': return filhos('\n\n');
    default: return filhos('\n');
  }
}
const textoDoCorpo = (j: any, max?: number): string => {
  try { return textoLimpo(adfParaTexto(JSON.parse(String(j?.body?.atlas_doc_format?.value ?? '{}'))), max); } catch { return ''; }
};
/** Comentário numa linha só. O corte fica com textoLimpo, para o aviso de quanto mostrou não se perder. */
const comentarioEmUmaLinha = (c: any): string => { const t = textoDoCorpo(c, 4000); return neutral(t, t.length); };

const P_PAGINA_ID: Param = { tipo: 'texto', obrigatorio: true, descricao: 'o número da página (id)' };
const P_LIMITE: Param = { tipo: 'numero', descricao: 'itens por vez, até 100 (padrão 25)', padrao: 25, max: 100 };

/** O cartão de confirmação diz o título da página: o agente só tem o número. */
const CARTAO_DA_PAGINA: Acao['preparar'] = async (ctx, a) => {
  idOk(a, 'pagina');
  const j = await ctx.http(`/api/v2/pages/${seg(a.pagina)}`, { method: 'GET', kind: 'read' });
  return { detalhe: `Página: ${neutral(String(j?.title ?? a.pagina), 200)}` };
};

export const CONFLUENCE: ConectorDef = {
  kind: 'confluence', nome: 'Confluence', site: 'atlassian.net', grupo: 'documentos',
  sobre: 'Páginas e espaços do Confluence: os agentes buscam e leem o que a sua conta pode ver, criam e atualizam páginas e comentam quando você pede.',
  campos: [
    { name: 'site', label: 'Endereço do Confluence', placeholder: 'sua-empresa.atlassian.net' },
    { name: 'email', label: 'E-mail da sua conta Atlassian', placeholder: 'voce@empresa.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHelp: 'e-mail inválido' },
    { name: 'token', label: 'Token de API', secret: true, placeholder: 'Cole o token aqui' },
  ],
  ajuda: { url: 'https://id.atlassian.com/manage-profile/security/api-tokens', passos: 'Abra a página de tokens da sua conta Atlassian e clique em "Create API token" (o botão simples, não o "with scopes": esse usa outro endereço e aqui não funciona). Dê um nome, escolha a validade (até 365 dias) e clique em "Create". Depois clique em "Copy to clipboard" e cole aqui, junto com o e-mail da conta e o endereço do site. O token pode o que a sua conta pode: para criar páginas e comentar, ela precisa ter essa permissão no espaço.' },
  base: (c) => `https://${hostSeguro(c.site, /\.atlassian\.net$/)}/wiki`,
  auth: { tipo: 'basic', usuario: (c) => c.email, senha: (c) => c.token },
  /** Sem credencial válida o Confluence pode responder como visitante ("anonymous"): isso não é "conectado". */
  erroNoCorpo: (j) => (j?.type === 'anonymous' ? { mensagem: 'o e-mail e o token não foram aceitos', permissao: true } : null),
  quemSou: { caminho: '/rest/api/user/current', nome: (j) => String(j.displayName || j.email || 'conta Confluence'), id: (j) => j.accountId },
  acoes: [
    { id: 'confluence.espacos', descricao: 'lista os espaços que a conta pode ver', risco: 'ler', params: { limite: P_LIMITE }, resumo: 'listar espaços do Confluence',
      metodo: 'GET', caminho: '/api/v2/spaces', consulta: { limit: '{limite}' }, lista: 'results', linha: '{name} (chave: {key}, id: {id})', proximo: (j) => cursorDe(j._links?.next) },
    { id: 'confluence.buscar', descricao: 'procura páginas por palavras, ou com uma consulta em CQL. Para continuar uma busca, repita os mesmos parâmetros e acrescente o cursor', rotulo: 'procura páginas por palavras', risco: 'ler',
      params: { busca: { tipo: 'texto', descricao: 'as palavras que a página deve ter' }, espaco: { tipo: 'texto', descricao: 'só neste espaço (chave)' }, cql: { tipo: 'texto', descricao: 'consulta pronta em CQL, como: type = page AND title ~ "ata". Se vier, "busca" e "espaco" não valem' }, limite: P_LIMITE },
      resumo: (a) => `buscar no Confluence: ${a.cql ?? a.busca ?? ''}`,
      antes: async (_c, a) => {
        if (a.cql) return a;
        if (!a.busca) throw new ErroAcao('diga o que procurar: "busca" ou "cql"');
        const aspas = (v: unknown) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        return { ...a, cql: `type = page AND text ~ ${aspas(a.busca)}${a.espaco ? ` AND space = ${aspas(a.espaco)}` : ''}` };
      },
      metodo: 'GET', caminho: '/rest/api/search', consulta: { cql: '{cql}', limit: '{limite}', excerpt: 'indexed_unescaped' }, lista: 'results', proximo: (j) => cursorDe(j._links?.next),
      linha: (r: any) => linhaDe('{titulo} ({tipo}, id: {id}) em {onde}: {trecho}', { titulo: r.title ?? r.content?.title, tipo: r.content?.type ?? r.entityType, id: r.content?.id, onde: r.resultGlobalContainer?.title, trecho: r.excerpt }) },
    { id: 'confluence.ler_pagina', descricao: 'lê o texto de uma página. Texto muito longo vem cortado, e a resposta avisa', risco: 'ler', params: { pagina: P_PAGINA_ID }, resumo: 'ler a página {pagina} do Confluence', antes: async (_c, a) => idOk(a, 'pagina'),
      metodo: 'GET', caminho: '/api/v2/pages/{pagina}', consulta: { 'body-format': 'atlas_doc_format' }, url: linkDe,
      texto: (j) => [linhaDe('{title} (id: {id}, versão {version.number})', j), '', textoDoCorpo(j) || '(página sem texto)'].join('\n') },
    { id: 'confluence.comentarios', descricao: 'lê os comentários de uma página', risco: 'ler', params: { pagina: P_PAGINA_ID, limite: P_LIMITE }, resumo: 'ler os comentários da página {pagina} do Confluence', antes: async (_c, a) => idOk(a, 'pagina'),
      metodo: 'GET', caminho: '/api/v2/pages/{pagina}/footer-comments', consulta: { 'body-format': 'atlas_doc_format', limit: '{limite}' }, lista: 'results', proximo: (j) => cursorDe(j._links?.next),
      linha: (c: any) => `${linhaDe('{version.createdAt} (autor {version.authorId}, id: {id}):', c)} ${comentarioEmUmaLinha(c)}` },
    { id: 'confluence.criar_pagina', descricao: 'cria uma página num espaço; quem acompanha o espaço recebe', risco: 'enviar',
      params: { espaco: { tipo: 'texto', obrigatorio: true, descricao: 'chave ou número do espaço' }, titulo: { tipo: 'texto', obrigatorio: true, descricao: 'o título, até 500 caracteres', max: MAX_TITULO }, texto: { tipo: 'texto', descricao: 'o conteúdo' }, pai: { tipo: 'texto', descricao: 'número da página acima desta; sem ele, fica na página inicial do espaço' }, formato: P_FORMATO },
      resumo: (a) => `Criar no espaço ${a.espaco} do Confluence a página "${a.titulo}"${a.pai ? `, dentro da página ${a.pai}` : ''}${tamanhoNoCartao(a.texto)}:\n${a.texto ?? '(sem texto)'}`,
      antes: async (ctx, a) => { idOk(a, 'pai'); return { ...a, id_do_espaco: await idDoEspaco(ctx, String(a.espaco)) }; },
      metodo: 'POST', caminho: '/api/v2/pages',
      corpo: (a: Args) => ({ spaceId: a.id_do_espaco, status: 'current', title: a.titulo, ...(a.pai ? { parentId: a.pai } : {}), ...(a.texto ? { body: corpoDe(storageDe(a)) } : {}) }),
      texto: 'Página criada: {title} (id: {id}).', url: linkDe },
    { id: 'confluence.atualizar_pagina', descricao: 'muda o título ou o texto de uma página; quem acompanha recebe. Por padrão acrescenta ao fim; "substituir" troca o texto inteiro', rotulo: 'muda o título ou o texto de uma página; quem acompanha recebe. Acrescenta ao fim ou troca o texto inteiro', risco: 'enviar',
      params: { pagina: P_PAGINA_ID, titulo: { tipo: 'texto', descricao: 'novo título, até 500 caracteres', max: MAX_TITULO }, texto: { tipo: 'texto', descricao: 'o conteúdo' }, modo: { tipo: 'texto', descricao: 'o que fazer com o texto', opcoes: ['acrescentar', 'substituir'], padrao: 'acrescentar' }, formato: P_FORMATO, nota: { tipo: 'texto', descricao: 'o que mudou, para o histórico da página' } },
      resumo: (a) => `Atualizar a página ${a.pagina} do Confluence${a.titulo ? `, com o novo título "${a.titulo}"` : ''}${tamanhoNoCartao(a.texto)}${a.texto ? (a.modo === 'substituir' ? ', trocando todo o texto por:' : ', acrescentando ao fim:') : ''}${a.texto ? `\n${a.texto}` : ''}`,
      preparar: CARTAO_DA_PAGINA,
      antes: async (ctx, a) => {
        idOk(a, 'pagina');
        if (!a.titulo && !a.texto) throw new ErroAcao('diga o que muda: "titulo", "texto" ou os dois');
        // a documentação pede a versão atual mais um; espaço com aprovação obrigatória responde 409, que chega à pessoa como erro
        const j = await ctx.http(`/api/v2/pages/${seg(a.pagina)}?body-format=storage`);
        const versao = Number(j?.version?.number);
        if (!Number.isFinite(versao)) throw new ErroAcao('o Confluence não informou a versão desta página: nada foi alterado');
        const atual = String(j?.body?.storage?.value ?? '');
        return { ...a, titulo_final: a.titulo ?? j.title, versao_nova: versao + 1, corpo_final: !a.texto ? atual : a.modo === 'substituir' ? storageDe(a) : `${atual}${storageDe(a)}` };
      },
      metodo: 'PUT', caminho: '/api/v2/pages/{pagina}',
      corpo: (a: Args) => ({ id: a.pagina, status: 'current', title: a.titulo_final, body: corpoDe(String(a.corpo_final)), version: { number: a.versao_nova, ...(a.nota ? { message: a.nota } : {}) } }),
      // o título que a página já tinha é escrito por quem tem acesso a ela: não volta ao agente
      texto: (j, a) => `Página ${String(a.pagina)} atualizada${a.titulo ? `, com o título "${String(a.titulo)}"` : ''} (versão ${linhaDe('{version.number}', j) || String(a.versao_nova)}).`, url: linkDe },
    { id: 'confluence.comentar', descricao: 'comenta numa página; quem acompanha recebe', risco: 'enviar',
      params: { pagina: P_PAGINA_ID, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o comentário, até 5000 caracteres', max: MAX_ENVIO }, responder_a: { tipo: 'texto', descricao: 'número do comentário que está sendo respondido' }, formato: P_FORMATO },
      resumo: (a) => `${a.responder_a ? `Responder ao comentário ${a.responder_a} da` : 'Comentar na'} página ${a.pagina} do Confluence:\n${a.texto}`,
      preparar: CARTAO_DA_PAGINA, antes: async (_c, a) => idOk(idOk(a, 'pagina'), 'responder_a'), metodo: 'POST', caminho: '/api/v2/footer-comments',
      corpo: (a: Args) => ({ ...(a.responder_a ? { parentCommentId: a.responder_a } : { pageId: a.pagina }), body: corpoDe(storageDe(a)) }),
      texto: 'Comentário publicado (id: {id}).', url: linkDe },
  ],
};
