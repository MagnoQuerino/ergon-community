/**
 * Mattermost (na nuvem ou em instalação própria), API v4, com o token de acesso pessoal da pessoa: ele age como a própria conta.
 * Referências oficiais:
 * - docs.mattermost.com/api/reference/ get-user, get-teams-for-user, get-channels-for-team-for-user, get-channel, get-posts-for-channel,
 *   get-post-thread, get-post, search-posts, get-users-by-ids, create-post, delete-post, get-groups
 * - github.com/mattermost/mattermost/tree/master/api/v4/source: introduction.yaml (autenticação, teto de 200 por página);
 *   posts.yaml, teams.yaml, channels.yaml, users.yaml, groups.yaml e definitions.yaml (corpos e respostas, que a página acima não mostra)
 * - docs.mattermost.com/developers/integrate/reference/personal-access-token (como criar o token)
 * - docs.mattermost.com/developers/integrate/reference/message-attachments (props.attachments: fallback, pretext, text, title)
 * - github.com/mattermost/mattermost/blob/master/server/channels/app/mention_parser_standard.go (como o servidor acha menções)
 * - github.com/mattermost/mattermost/blob/master/server/channels/api4/group.go (GET /groups: exige licença; quem não administra vê os
 *   grupos que aceitam menção, os únicos que importam aqui) | server/i18n (api.license_error, no idioma da pessoa)
 */
import { clip } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Args, type CtxAcao } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef } from './declarativo.ts';

/** Sem a flag "u" de propósito: com ela, "ſ" e "K" (Kelvin) contariam como letras comuns e a menção escaparia. */
const MENCAO_EM_MASSA = /@(channel|all|here|everyone)(?![0-9a-z])/gi;
/** Letra ou número antes do @ e um domínio depois dele: é endereço de e-mail, como ana@all.com. */
const parteDeEmail = (tudo: string, pos: number, fim: number): boolean => /[\p{L}\p{N}]$/u.test(tudo.slice(Math.max(0, pos - 2), pos)) && /^[.-][0-9a-z]/i.test(tudo.slice(fim, fim + 2));

/**
 * A API não tem opção, por mensagem, que desligue @channel, @all e @here (`silent` só vale para robôs e integrações). O servidor
 * só reconhece a menção com o nome colado no @, então um espaço a desarma. O cartão de confirmação já mostra o texto assim.
 * Nada antes do @ protege: no Rocket.Chat, "#sala@all" e "ana@x.com@all" chamam a sala inteira, porque o nome da sala ou o e-mail
 * termina no @ (packages/message-parser/src/grammar.pegjs). Nada além de letra sem acento ou número continua o nome: a outra
 * leitura do Rocket.Chat (lib/MentionsParser.ts) entende "@allé" como @all. Só o e-mail de verdade (ana@all.com) e o nome
 * parecido (@allan) ficam como estão. <!channel> é a forma do Slack.
 */
export const semMencaoEmMassa = (texto: string): string => texto
  .replace(/<!(channel|all|here|everyone)>/giu, '@ $1')
  .replace(MENCAO_EM_MASSA, (m: string, nome: string, pos: number, tudo: string) => (parteDeEmail(tudo, pos, pos + m.length) ? m : `@ ${nome}`));

const textoSeguro = (a: Args): string => semMencaoEmMassa(String(a.texto ?? ''));

/** "@nome" no texto: os caracteres dos nomes de grupo do Mattermost (model/group.go) e dos nomes que o Rocket.Chat lê como menção. */
const CITADO = /@([0-9a-z._-]+)/gi;
/** O servidor tira a pontuação do fim antes de procurar o nome (ProcessText, em mention_parser_standard.go). */
const semPontaFinal = (nome: string): string => nome.replace(/[._-]+$/, '');
/** Letra ou número antes do @ e um domínio no nome: é endereço de e-mail, não menção. */
const eEmail = (tudo: string, pos: number, nome: string): boolean => /[\p{L}\p{N}]$/u.test(tudo.slice(Math.max(0, pos - 2), pos)) && /\.[0-9a-z]/i.test(nome);

/** Os nomes citados com @, para perguntar ao servidor quais chamam muita gente. */
export const nomesCitados = (texto: string): string[] => [...new Set([...texto.matchAll(CITADO)]
  .filter((m) => !eEmail(texto, m.index, m[1]))
  .map((m) => semPontaFinal(m[1]))
  .filter(Boolean))];

/** O mesmo espaço depois do @ que desarma @all, só nos nomes indicados. */
export const desarmarCitados = (texto: string, desarmar: (nome: string) => boolean): string => texto.replace(CITADO, (m: string, nome: string, pos: number) => (!eEmail(texto, pos, nome) && desarmar(semPontaFinal(nome)) ? `@ ${nome}` : m));

/** O cartão de confirmação mostra até 6000 caracteres (proposals.ts): texto maior sairia sem a pessoa ler o fim. Recusa em vez de cortar. */
export const MAX_TEXTO = 5000;
/** No cartão de confirmação, que também precisa caber com o texto que vai. */
export const MAX_NOME = 80;
export const MAX_QUEM = 60;
export const MAX_CITADA = 300;
/** Título ou texto de reserva de um cartão: o suficiente para saber o que é. */
const MAX_CARTAO = 200;

/** O motor confere o tamanho do que chegou; aqui é o texto como vai sair, porque o espaço que desarma a menção também conta. */
export const conferirTexto = async (_ctx: CtxAcao, a: Args): Promise<Args> => {
  const t = textoSeguro(a);
  if (!t.trim()) throw new ErroAcao('falta "texto"');
  if (t.length > MAX_TEXTO) throw new ErroAcao(`"texto" tem ${t.length} caracteres, e o limite é ${MAX_TEXTO}: encurte ou divida (nada foi feito)`);
  return a;
};

/** Dos nomes citados: quais chamam muita gente (em minúsculas) e quais não deu para conferir. */
export interface Citados { chamam: Set<string>; semConferir: string[] }
export interface TextoDoCartao { texto: string; aviso?: string; confirmar?: string }

/**
 * O texto que o cartão mostra e o clique envia: sem @all e sem menção a quem chama muita gente. O que não deu para conferir fica
 * como está, porque pode ser só uma pessoa: o cartão avisa e a ação espera a confirmação.
 */
export async function textoDoCartao(ctx: CtxAcao, a: Args, oQue: 'grupo' | 'time', consultar: (nomes: string[]) => Promise<Citados>): Promise<TextoDoCartao> {
  await conferirTexto(ctx, a);
  const seguro = textoSeguro(a);
  const nomes = nomesCitados(seguro);
  if (!nomes.length) return { texto: seguro };
  const { chamam, semConferir } = await consultar(nomes);
  const texto = desarmarCitados(seguro, (n) => chamam.has(n.toLowerCase()));
  await conferirTexto(ctx, { texto });
  if (!semConferir.length) return { texto };
  return {
    texto,
    aviso: `Atenção: não deu para conferir se ${clip(semConferir.map((n) => `@${n}`).join(', '), MAX_CARTAO)} chama um ${oQue} inteiro.`,
    confirmar: `não deu para conferir se o texto chama um ${oQue} inteiro: confira antes de enviar`,
  };
}
/** Linhas do cartão: o que não existe não vira linha em branco. */
export const linhas = (...l: Array<string | undefined>): string => l.filter(Boolean).join('\n');

/** Cartão de uma mensagem: título ou texto de reserva, sem deixar que ele vire linha de controle. */
export const marcaDeCartao = (titulo: unknown): string => (titulo ? `[cartão: ${neutral(String(titulo), MAX_CARTAO)}]` : '[cartão]');
/** Texto, anexos e cartões juntos. O fecho de uma marca, colado num título que termina em "]", não pode formar o fecho de uma linha de controle. */
export const juntarConteudo = (partes: unknown[]): string => partes.filter(Boolean).join(' ').replace(/\](?=\])/g, '] ') || '(sem texto)';
export const listaDe = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Mensagem só com arquivo ou de integração costuma vir sem texto: sem isto, pareceria que não há nada. Com o post recém-criado, só file_ids existe. */
function conteudoDoPost(p: any): string {
  const arquivos = listaDe(p?.metadata?.files);
  const anexos = arquivos.length ? arquivos.map((f) => `[anexo: ${f?.name || 'arquivo'}]`) : listaDe(p?.file_ids).map(() => '[anexo]');
  const cartoes = listaDe(p?.props?.attachments).map((c) => marcaDeCartao(c?.title || c?.fallback || c?.text || c?.pretext));
  return juntarConteudo([p?.message, ...anexos, ...cartoes]);
}

const quando = (ms: unknown): string => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };
const linhaDoPost = (p: any): string => `- ${linhaDe(p.root_id ? '{quando} pessoa {user_id}: {conteudo} (id: {id}, canal: {channel_id}, fio: {root_id})' : '{quando} pessoa {user_id}: {conteudo} (id: {id}, canal: {channel_id})', { ...p, quando: quando(p.create_at), conteudo: conteudoDoPost(p) }, 2000)}`;

/** A lista de posts vem em duas partes: `order` (os ids, do mais novo ao mais velho) e `posts` (o conteúdo de cada um). */
const postsDe = (j: any): any[] => (Array.isArray(j?.order) ? j.order : []).map((id: string) => j.posts?.[id]).filter(Boolean);
const juntar = (l: string[]): string => (l.length ? l.join('\n') : 'nada encontrado');

// --------------------------------------------------------------------------------------------- o que o cartão precisa mostrar
const POR_PAGINA = 200;
/** Para procurar grupos: até 1000. Passou disso, o cartão avisa. */
const MAX_PAGINAS = 5;
const NAO_E_DESTE_CANAL = 'esta mensagem não é deste canal: confira o canal e a mensagem (nada foi feito)';

/** O nome que a pessoa reconhece. Conversa direta não tem nome: o do canal é "id__id" (GetDMNameFromIds, model/channel.go). */
async function canalNoCartao(ctx: CtxAcao, id: unknown): Promise<string> {
  const c = await ctx.http(`/channels/${seg(id)}`);
  if (c?.type !== 'D') return `${neutral(String(c?.display_name || c?.name || id), MAX_NOME)}${c?.type === 'P' ? ' (privado)' : ''}`;
  const ids = [...new Set(String(c.name ?? '').split('__').filter(Boolean))];
  const gente = await ctx.http('/users/ids', { method: 'POST', kind: 'read', body: ids }).catch(() => []);
  const nomes = listaDe(gente).map((u) => neutral(String(u?.username ?? u?.id), MAX_QUEM));
  return `conversa direta entre ${neutral((nomes.length ? nomes : ids).join(', '), MAX_NOME)}`;
}
/** Quem escreveu e o que escreveu. Sem conseguir o nome, o id ainda diz alguma coisa e não impede o resto do cartão. */
async function citadaNoCartao(ctx: CtxAcao, p: any): Promise<string> {
  const u = p?.user_id ? await ctx.http(`/users/${seg(p.user_id)}`).catch(() => null) : null;
  return `Mensagem de ${neutral(String(u?.username ?? p?.user_id ?? 'alguém'), MAX_QUEM)}: "${neutral(conteudoDoPost(p), MAX_CITADA)}"`;
}

/** Servidor sem licença não tem grupos, e o de versão antiga não tem esta rota: nada a conferir. Outra recusa pode esconder um grupo. */
const SEM_LICENCA = /licen[sçczt]|lizenz|lisans|лиценз|ліценз|ライセンス|라이선스|许可证|許可證/i;
const semGrupos = (e: unknown): boolean => e instanceof ProviderError && (e.status === 404 || e.status === 501 || (e.status === 403 && SEM_LICENCA.test(e.message)));

/** Os grupos que aceitam menção, página a página, até achar todos os nomes citados. */
async function gruposCitados(ctx: CtxAcao, nomes: string[]): Promise<Citados> {
  const chamam = new Set<string>();
  const buscados = new Set(nomes.map((n) => n.toLowerCase()));
  const faltam = () => nomes.filter((n) => !chamam.has(n.toLowerCase()));
  for (let page = 0; page < MAX_PAGINAS; page++) {
    let l: any[];
    try {
      l = listaDe(await ctx.http(`/groups?${new URLSearchParams({ filter_allow_reference: 'true', per_page: String(POR_PAGINA), page: String(page) })}`));
    } catch (e) {
      return { chamam, semConferir: semGrupos(e) ? [] : faltam() };
    }
    for (const g of l) {
      const nome = String(g?.name ?? '').toLowerCase();
      if (buscados.has(nome)) chamam.add(nome);
    }
    if (l.length < POR_PAGINA || !faltam().length) return { chamam, semConferir: [] };
  }
  return { chamam, semConferir: faltam() };
}

const P_CANAL = { tipo: 'texto', obrigatorio: true, descricao: 'id do canal' } as const;
const P_EQUIPE = { tipo: 'texto', obrigatorio: true, descricao: 'id da equipe' } as const;

export const MATTERMOST: ConectorDef = {
  kind: 'mattermost', nome: 'Mattermost', site: 'mattermost.com', grupo: 'conversas',
  sobre: 'Equipes e canais do Mattermost: os agentes leem e buscam as conversas que a sua conta vê e respondem quando você pede. Nenhuma mensagem chama o canal inteiro nem um grupo.',
  campos: [
    { name: 'site', label: 'Endereço do seu Mattermost', placeholder: 'empresa.cloud.mattermost.com' },
    { name: 'token', label: 'Token de acesso pessoal', secret: true, placeholder: 'Cole o token aqui' },
  ],
  ajuda: {
    url: 'https://docs.mattermost.com/developers/integrate/reference/personal-access-token',
    passos: 'Primeiro, quem administra o seu Mattermost precisa ligar os tokens: System Console › Integrations › Integration Management, opção "Enable personal access tokens" (vem desligada). Se você não é administrador, essa pessoa também libera a sua conta: System Console › User Management › Users, procure você, Manage Roles, marque "Allow this account to generate personal access tokens" e clique em Save. Depois, na sua conta: Profile › Security › Personal Access Tokens › Create Token, escreva uma descrição e clique em Save. Copie o "Access Token" (não o "Token ID"): ele só aparece uma vez. O token faz tudo o que a sua conta faz, inclusive escrever nos canais em que você está. Evite uma conta de administrador: o token teria todos os poderes dela. Cole aqui o token e o endereço do seu Mattermost.',
  },
  base: (c) => `https://${hostSeguro(c.site)}/api/v4`,
  auth: { tipo: 'bearer' },
  // os erros do serviço vêm com código HTTP; isto cobre um intermediário que devolva o mesmo erro com 200
  erroNoCorpo: (j) => (typeof j?.status_code === 'number' && j.status_code >= 400 ? { mensagem: String(j.message ?? j.id ?? j.status_code), permissao: j.status_code === 401 || j.status_code === 403 } : null),
  quemSou: { caminho: '/users/me', nome: (j) => String(j.username ?? 'conta do Mattermost'), id: (j) => j.id },
  acoes: [
    { id: 'mattermost.equipes', descricao: 'lista as equipes de que você participa', risco: 'ler', params: {}, resumo: 'listar equipes',
      metodo: 'GET', caminho: '/users/me/teams', lista: '', linha: '{display_name} ({name}) (id: {id})' },
    { id: 'mattermost.canais', descricao: 'lista os canais de uma equipe em que você está', risco: 'ler', params: { equipe: P_EQUIPE }, resumo: 'listar canais da equipe {equipe}',
      metodo: 'GET', caminho: '/users/me/teams/{equipe}/channels', lista: '', linha: '{display_name} ({name}) (id: {id}, tipo {type})' },
    { id: 'mattermost.ler', descricao: 'lê as mensagens mais recentes de um canal', risco: 'ler',
      params: { canal: P_CANAL, limite: { tipo: 'numero', descricao: 'até 200 (padrão 30)', padrao: 30, max: 200 } },
      resumo: 'ler o canal {canal}', metodo: 'GET', caminho: '/channels/{canal}/posts', consulta: { per_page: '{limite}' },
      texto: (j) => juntar(postsDe(j).map(linhaDoPost)),
      // "before" traz o que veio antes do id dado; prev_post_id só diz se ainda há mais: seria pular essa mensagem se fosse o cursor
      proximo: (j) => (j.prev_post_id && j.order?.length ? String(j.order[j.order.length - 1]) : null), paramCursor: 'before' },
    { id: 'mattermost.fio', descricao: 'lê a conversa inteira em que uma mensagem está, da mais antiga à mais nova', risco: 'ler',
      params: { mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id de uma mensagem da conversa' } },
      resumo: 'ler a conversa da mensagem {mensagem}', metodo: 'GET', caminho: '/posts/{mensagem}/thread',
      texto: (j) => juntar(postsDe(j).sort((a, b) => Number(a.create_at) - Number(b.create_at)).map(linhaDoPost)) },
    { id: 'mattermost.buscar', descricao: 'busca mensagens numa equipe', risco: 'ler',
      params: {
        equipe: P_EQUIPE,
        termos: { tipo: 'texto', obrigatorio: true, descricao: 'o que buscar; aceita from:usuario e in:nome-do-canal' },
        qualquer_termo: { tipo: 'booleano', descricao: 'sim: basta um dos termos; não (padrão): todos os termos', padrao: false },
        limite: { tipo: 'numero', descricao: 'até 200 (padrão 30)', padrao: 30, max: 200 },
        pagina: { tipo: 'numero', descricao: 'página, a partir de 0. Só muda algo em servidor com Elasticsearch', padrao: 0 },
      },
      resumo: 'buscar "{termos}" na equipe {equipe}', metodo: 'POST', caminho: '/teams/{equipe}/posts/search',
      corpo: { terms: '{termos}', is_or_search: '{qualquer_termo}', page: '{pagina}', per_page: '{limite}' },
      texto: (j) => juntar(postsDe(j).map(linhaDoPost)) },
    { id: 'mattermost.pessoas', descricao: 'diz o nome das pessoas a partir dos ids que aparecem nas mensagens', rotulo: 'diz quem escreveu cada mensagem', risco: 'ler',
      params: { ids: { tipo: 'lista', obrigatorio: true, descricao: 'ids das pessoas' } },
      resumo: 'ver quem são as pessoas {ids}', metodo: 'POST', caminho: '/users/ids', corpo: (a: Args) => a.ids ?? [],
      lista: '', linha: '{username} ({first_name} {last_name}) (id: {id})' },
    { id: 'mattermost.enviar', descricao: 'envia uma mensagem num canal', risco: 'enviar',
      params: { canal: P_CANAL, texto: { tipo: 'texto', obrigatorio: true, descricao: `a mensagem, até ${MAX_TEXTO} caracteres`, max: MAX_TEXTO } },
      resumo: (a) => `Enviar no canal ${String(a.canal ?? '')} do Mattermost:\n${textoSeguro(a)}`,
      preparar: async (ctx, a) => {
        await conferirTexto(ctx, a);
        const canal = await canalNoCartao(ctx, a.canal);
        const t = await textoDoCartao(ctx, a, 'grupo', (nomes) => gruposCitados(ctx, nomes));
        return { detalhe: linhas(`Canal: ${canal}`, t.aviso), args: { ...a, texto: t.texto }, ...(t.confirmar ? { confirmar: t.confirmar } : {}) };
      },
      metodo: 'POST', caminho: '/posts', antes: conferirTexto, corpo: (a: Args) => ({ channel_id: a.canal, message: textoSeguro(a) }), texto: 'Mensagem enviada (id: {id}).' },
    { id: 'mattermost.responder', descricao: 'responde a uma mensagem, dentro da mesma conversa', risco: 'enviar',
      params: { canal: P_CANAL, mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem respondida' }, texto: { tipo: 'texto', obrigatorio: true, descricao: `a resposta, até ${MAX_TEXTO} caracteres`, max: MAX_TEXTO } },
      resumo: (a) => `Responder à mensagem ${String(a.mensagem ?? '')} no canal ${String(a.canal ?? '')} do Mattermost:\n${textoSeguro(a)}`,
      preparar: async (ctx, a) => {
        await conferirTexto(ctx, a);
        const p = await ctx.http(`/posts/${seg(a.mensagem)}`);
        if (p?.channel_id !== a.canal) throw new ErroAcao(NAO_E_DESTE_CANAL);
        const canal = await canalNoCartao(ctx, a.canal);
        const t = await textoDoCartao(ctx, a, 'grupo', (nomes) => gruposCitados(ctx, nomes));
        return { detalhe: linhas(`Canal: ${canal}`, await citadaNoCartao(ctx, p), t.aviso), args: { ...a, texto: t.texto }, ...(t.confirmar ? { confirmar: t.confirmar } : {}) };
      },
      metodo: 'POST', caminho: '/posts',
      // a resposta precisa apontar para a primeira mensagem da conversa, mesmo quando a respondida já é uma resposta
      antes: async (ctx, a) => {
        await conferirTexto(ctx, a);
        const p = await ctx.http(`/posts/${seg(a.mensagem)}`);
        if (p?.channel_id && p.channel_id !== a.canal) throw new ErroAcao(NAO_E_DESTE_CANAL);
        return { ...a, fio: p?.root_id || p?.id || a.mensagem };
      },
      corpo: (a: Args) => ({ channel_id: a.canal, message: textoSeguro(a), root_id: a.fio }), texto: 'Resposta enviada (id: {id}).' },
    { id: 'mattermost.apagar', descricao: 'apaga uma mensagem', risco: 'apagar',
      params: { mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem' } },
      resumo: 'Apagar a mensagem {mensagem} do Mattermost',
      preparar: async (ctx, a) => {
        const p = await ctx.http(`/posts/${seg(a.mensagem)}`);
        return { detalhe: linhas(`Canal: ${await canalNoCartao(ctx, p?.channel_id)}`, await citadaNoCartao(ctx, p)) };
      },
      metodo: 'DELETE', caminho: '/posts/{mensagem}', texto: 'Mensagem apagada.' },
  ],
};
