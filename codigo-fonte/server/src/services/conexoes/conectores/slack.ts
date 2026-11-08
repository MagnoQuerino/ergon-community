/**
 * Slack, com um app do próprio usuário (Web API). Referências oficiais, conferidas em 05/11/2026:
 *   docs.slack.dev/apis/web-api (corpo JSON com token no cabeçalho; ok:false no corpo; token nunca na consulta)
 *   docs.slack.dev/reference/methods/auth.test | conversations.list | conversations.history | conversations.replies
 *   docs.slack.dev/reference/methods/users.list | users.info | conversations.info | search.messages | chat.postMessage | conversations.open
 *   docs.slack.dev/reference/methods/reactions.add | chat.delete
 *   docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments (title, fallback, text e pretext de um cartão)
 *   docs.slack.dev/reference/objects/conversation-object | reference/objects/user-object
 *   docs.slack.dev/messaging/formatting-message-text (#escaping, #special-mentions, #disabling-automatic-parsing)
 *   docs.slack.dev/authentication/tokens (xoxb- e xoxp-) | reference/scopes/search.read (só token de usuário)
 *   docs.slack.dev/app-manifests/configuring-apps-with-app-manifests | reference/app-manifest
 *   docs.slack.dev/app-management/quickstart-app-settings (nomes dos botões)
 *   docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps (app interno, como este, não entra no limite novo)
 *
 * A credencial é um campo só, porque toda ação usa o mesmo token: o motor não troca de token por ação. Com xoxb- os agentes
 * agem como o app e veem só os canais para onde ele foi convidado; com xoxp- agem como a pessoa e também buscam.
 * search.messages é marcado como legado pelo Slack (o substituto é assistant.search.context).
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';

const ESCOPOS = [
  'channels:read', 'groups:read', 'im:read', 'mpim:read', // conversations.list
  'channels:history', 'groups:history', 'im:history', 'mpim:history', // conversations.history e replies
  'users:read', // users.list
  'chat:write', // chat.postMessage e chat.delete
  'im:write', // conversations.open
  'reactions:write', // reactions.add
];
const manifesto = (usuario?: string[]) => ({
  display_information: { name: 'Ergon' },
  features: { bot_user: { display_name: 'Ergon', always_online: true } },
  oauth_config: { scopes: { bot: ESCOPOS, ...(usuario ? { user: usuario } : {}) } as { bot: string[]; user?: string[] } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
});
const linkDoApp = (m: unknown): string => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(m))}`;
/** O que a pessoa cola no Slack para criar o app. Padrão: só o app, que vê os canais para onde foi convidado. */
export const MANIFESTO_SLACK = manifesto();
const MANIFESTO_TEXTO = JSON.stringify(MANIFESTO_SLACK);
/** Opção: também o token de usuário, com os mesmos escopos e a busca. Com ele, os agentes agem em nome da pessoa. */
export const MANIFESTO_SLACK_COM_BUSCA = manifesto([...ESCOPOS, 'search:read']);

/** O motor manda "application/json"; aqui vai também a codificação, para acentos chegarem certos. */
const JSON_UTF8 = { 'Content-Type': 'application/json; charset=utf-8' };
const POR_PAGINA = 200;
/** Para achar por nome: até 2000 canais ou pessoas. Passou disso, a resposta pede o id. */
const MAX_PAGINAS = 10;
/**
 * O cartão de confirmação mostra até 6000 caracteres (proposals.ts): texto maior sairia sem a pessoa ler o fim. O motor recusa em
 * vez de cortar (Param.max). Mesmo com tudo virando entidade, 5000 caracteres ficam abaixo do corte do Slack, de 40 mil.
 */
const MAX_TEXTO = 5000;
/** Mensagem lida: longa o bastante para ler de verdade. */
const MAX_LINHA = 3000;
/** Título ou texto de reserva de um cartão: o suficiente para saber o que é. */
const MAX_CARTAO = 200;
/** A mensagem citada no cartão de confirmação, que também precisa caber com o texto que vai. */
const MAX_CITADA = 300;

// ---------------------------------------------------------------------------------------------------------- texto
/**
 * Texto de quem escreve nunca chama muita gente. O Slack só trata como controle o que vem entre < e >, então &, < e > viram
 * entidades, como manda a documentação: <!channel>, <!here>, <!everyone> e <!subteam^...> aparecem como texto e não notificam.
 * Escritos à mão, @channel, @here e @everyone não notificam porque link_names nunca é enviado. Menção a uma pessoa só
 * (<@U123>) continua valendo.
 */
export function semMencaoEmMassa(texto: string): string {
  return texto.split(/(<@[UW][A-Z0-9]+>)/).map((p, i) => (i % 2 ? p : p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))).join('');
}
/** O inverso, para ler: sem isso, ao citar "A &amp; B" a resposta sairia errada. */
const legivel = (s: unknown): string => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function comTexto(a: Args): Args {
  const t = String(a.texto ?? '');
  if (!t.trim()) throw new ErroAcao('falta "texto"');
  return { ...a, texto_slack: semMencaoEmMassa(t) };
}
/** preparar recebe o pedido antes de o motor conferir os parâmetros: texto que o clique recusaria não pode virar cartão. */
function textoCabe(a: Args): void {
  comTexto(a);
  const n = String(a.texto).length;
  if (n > MAX_TEXTO) throw new ErroAcao(`"texto" tem ${n} caracteres, e o limite é ${MAX_TEXTO}: encurte ou divida (nada foi feito)`);
}
function exigirTs(a: Args, campo = 'mensagem'): void {
  if (!/^\d+\.\d+$/.test(String(a[campo] ?? ''))) throw new ErroAcao(`"${campo}" precisa ser o ts da mensagem, como 1503435956.000247 (vem de slack.ler)`);
}
/** Data AAAA-MM-DD (horário universal) ou ts de mensagem: o Slack pede o número. */
function carimbo(v: unknown, campo: string): string | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  const n = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(n)) throw new ErroAcao(`"${campo}" precisa ser uma data AAAA-MM-DD ou o ts de uma mensagem`);
  return String(n / 1000);
}
const sim = (v: unknown) => v === true || v === 'true' || v === 'sim';
const sem = (s: unknown) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// -------------------------------------------------------------------------------------------- nome vira id, sem chutar
const ID_CANAL = /^[CGD](?=[A-Z0-9]*\d)[A-Z0-9]{7,}$/;
const ID_PESSOA = /^[UW](?=[A-Z0-9]*\d)[A-Z0-9]{7,}$/;
const pagina = (o: Record<string, string>, cursor: string) => new URLSearchParams({ ...o, ...(cursor ? { cursor } : {}) }).toString();

/** Só nome exato. Sem ele, recusa e mostra os parecidos: nunca escreve num canal adivinhado. */
async function acharCanal(ctx: CtxAcao, bruto: unknown): Promise<string> {
  const v = String(bruto ?? '').trim();
  if (!v) throw new ErroAcao('falta "canal"');
  const marcado = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$/.exec(v);
  if (marcado) return marcado[1];
  if (ID_CANAL.test(v)) return v;
  if (ID_PESSOA.test(v)) throw new ErroAcao('isso é o id de uma pessoa: para escrever a ela, use slack.direta');
  const nome = v.replace(/^#/, '').toLowerCase();
  const parecidos: string[] = [];
  let cursor = '';
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const j = await ctx.http(`/conversations.list?${pagina({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: String(POR_PAGINA) }, cursor)}`);
    for (const c of j.channels ?? []) {
      if (c.name === nome) return String(c.id);
      if (String(c.name).includes(nome)) parecidos.push(`#${neutral(String(c.name))} (id: ${neutral(String(c.id))})`);
    }
    cursor = j.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  const alem = cursor ? ` Só olhei os primeiros ${POR_PAGINA * MAX_PAGINAS} canais: use o id.` : '';
  throw new ErroAcao(`não encontrei o canal "${neutral(nome)}". O app só enxerga canais públicos e os privados para onde foi convidado.${alem}`, parecidos.length ? parecidos.slice(0, 10) : undefined);
}

const nomesDa = (u: any): string[] => [u.real_name, u.profile?.real_name, u.profile?.display_name, u.profile?.real_name_normalized, u.profile?.display_name_normalized].filter(Boolean);
const rotuloDa = (u: any): string => `${neutral(String(nomesDa(u)[0] ?? u.id))} (id: ${neutral(String(u.id))})`;

/** Mensagem direta vai a uma pessoa certa ou a nenhuma: nome repetido ou parecido volta como escolha, nunca como chute. */
async function acharPessoa(ctx: CtxAcao, bruto: unknown): Promise<{ id: string; nome: string }> {
  const v = String(bruto ?? '').trim();
  if (!v) throw new ErroAcao('falta "pessoa"');
  const marcada = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(v);
  if (marcada) return { id: marcada[1], nome: marcada[1] };
  if (ID_PESSOA.test(v)) return { id: v, nome: v };
  const alvo = sem(v.replace(/^@/, ''));
  const exatas: any[] = []; const parecidas: any[] = [];
  let cursor = '';
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const j = await ctx.http(`/users.list?${pagina({ limit: String(POR_PAGINA) }, cursor)}`);
    for (const u of j.members ?? []) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      const nomes = nomesDa(u).map(sem);
      if (nomes.includes(alvo)) exatas.push(u);
      else if (nomes.some((n) => n.includes(alvo))) parecidas.push(u);
    }
    cursor = j.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  if (exatas.length === 1) return { id: String(exatas[0].id), nome: String(nomesDa(exatas[0])[0] ?? exatas[0].id) };
  if (exatas.length > 1) throw new ErroAcao(`há ${exatas.length} pessoas chamadas "${neutral(v)}": escolha pelo id`, exatas.slice(0, 10).map(rotuloDa));
  const alem = cursor ? ` Só olhei as primeiras ${POR_PAGINA * MAX_PAGINAS} pessoas: use o id.` : '';
  throw new ErroAcao(`não encontrei a pessoa "${neutral(v)}": use o nome completo ou o id (veja slack.pessoas).${alem}`, parecidas.length ? parecidas.slice(0, 10).map(rotuloDa) : undefined);
}

// ------------------------------------------------------------------------------------------------- como ler a resposta
const proximoCursor = (j: any) => j.response_metadata?.next_cursor || null;
const quando = (ts: unknown): string => {
  const n = Number(ts) * 1000;
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 16).replace('T', ' ') : '';
};
const listaDe = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const marcaDeCartao = (titulo: string): string => (titulo ? `[cartão: ${neutral(titulo, MAX_CARTAO)}]` : '[cartão]');
/** Texto de um bloco de cartão (header e section têm text; context, elements). */
const textoDoBloco = (b: any): string => String(b?.text?.text ?? listaDe(b?.elements).map((e) => e?.text).filter((t) => typeof t === 'string').join(' '));
/**
 * Texto, anexos e cartões. Mensagem de bot ou só com arquivo costuma vir com text vazio: sem isto, pareceria que não há nada.
 * Cartão: título ou texto de reserva (docs.slack.dev/legacy/legacy-messaging/legacy-secondary-message-attachments). Bloco só
 * conta quando não há text nem cartão, porque o Slack repete nele o mesmo texto da mensagem.
 */
function conteudoDa(m: any): string {
  const texto = legivel(m?.text);
  const anexos = listaDe(m?.files).map((f) => `[anexo: ${f?.name || f?.title || 'arquivo'}]`);
  const cartoes = listaDe(m?.attachments).map((c) => marcaDeCartao(legivel(c?.title || c?.fallback || c?.text || c?.pretext)));
  const bloco = !texto && !cartoes.length ? listaDe(m?.blocks).map(textoDoBloco).find(Boolean) : '';
  // o fecho da marca, colado num título que termina em "]", não pode formar o fecho de uma linha de controle
  return [texto, ...anexos, ...cartoes, bloco ? marcaDeCartao(legivel(bloco)) : ''].filter(Boolean).join(' ').replace(/\](?=\])/g, '] ') || '(sem texto)';
}
const linhaMensagem = (m: any): string => linhaDe('{quando} {quem}: {texto} (ts: {ts}{fio}{respostas})', {
  quando: quando(m.ts), quem: m.user || m.username || m.bot_id || 'alguém', texto: conteudoDa(m), ts: m.ts,
  // na principal, thread_ts é o próprio ts e o número de respostas já diz que há conversa
  fio: m.thread_ts && m.thread_ts !== m.ts ? `, fio: ${m.thread_ts}` : '',
  respostas: m.reply_count ? `, ${m.reply_count} respostas` : '',
}, MAX_LINHA);
const linhaCanal = (c: any): string => {
  const notas = [c.is_private && !c.is_im && !c.is_mpim ? 'privado' : '', c.is_archived ? 'arquivado' : '', c.is_member === false ? 'o app não está nele' : '', c.num_members !== undefined ? `${c.num_members} pessoas` : ''].filter(Boolean).join(', ');
  return linhaDe('{nome} (id: {id}{notas}) {assunto}', {
    nome: c.is_im ? `conversa direta com ${c.user}` : c.is_mpim ? `grupo direto ${c.name}` : `#${c.name}`, id: c.id, notas: notas ? `, ${notas}` : '', assunto: legivel(c.topic?.value || c.purpose?.value),
  });
};
const linhaPessoa = (u: any): string => {
  const notas = [u.deleted ? 'desativada' : '', u.is_bot ? 'robô' : ''].filter(Boolean).join(', ');
  return linhaDe('{nome} (apelido: {apelido}, id: {id}{notas})', { nome: nomesDa(u)[0] ?? u.id, apelido: u.profile?.display_name || '-', id: u.id, notas: notas ? `, ${notas}` : '' });
};
const linhaAchado = (m: any): string => linhaDe('{quando} #{canal} {quem}: {texto} (canal: {id}, ts: {ts}) {link}', {
  quando: quando(m.ts), canal: m.channel?.name, quem: m.username || m.user || 'alguém', texto: conteudoDa(m), id: m.channel?.id, ts: m.ts, link: m.permalink,
}, MAX_LINHA);

// --------------------------------------------------------------------------------------------- o que o cartão precisa mostrar
/** O canal pelo nome ou id: o id fixa o alvo do clique, e o nome é o que a pessoa reconhece. */
async function canalNoCartao(ctx: CtxAcao, bruto: unknown): Promise<{ id: string; rotulo: string }> {
  const id = await acharCanal(ctx, bruto);
  const { channel: c } = await ctx.http(`/conversations.info?channel=${encodeURIComponent(id)}`);
  if (c?.is_im) {
    const { user: u } = await ctx.http(`/users.info?user=${encodeURIComponent(String(c.user))}`);
    return { id, rotulo: `conversa direta com ${neutral(String(nomesDa(u ?? {})[0] ?? c.user))}` };
  }
  if (c?.is_mpim) return { id, rotulo: `grupo direto ${neutral(String(c.name ?? id))}` };
  return { id, rotulo: `#${neutral(String(c?.name ?? id))}${c?.is_private ? ' (privado)' : ''}` };
}
/**
 * A mensagem de um ts e o fio dela. conversations.replies aceita o ts de qualquer mensagem da conversa e devolve primeiro a principal;
 * oldest e latest iguais trazem só a pedida junto. O thread_ts de todas é o da principal; sem ele, a mensagem ainda não tem conversa.
 */
async function mensagemDe(ctx: CtxAcao, canal: string, ts: string): Promise<{ m: any; fio: string }> {
  const j = await ctx.http(`/conversations.replies?${new URLSearchParams({ channel: canal, ts, oldest: ts, latest: ts, inclusive: 'true', limit: '2' })}`);
  const l = listaDe(j?.messages);
  if (!l.length) throw new ErroAcao('mensagem não encontrada: confira o ts');
  return { m: l.find((x) => x?.ts === ts) ?? l[0], fio: String(l[0]?.thread_ts ?? ts) };
}
/** Quem escreveu, pelo nome: sem conseguir, o id ainda diz alguma coisa e não impede o resto do cartão. */
async function autorDa(ctx: CtxAcao, m: any): Promise<string> {
  if (!m?.user) return neutral(String(m?.username || m?.bot_profile?.name || m?.bot_id || 'alguém'), 60);
  const j = await ctx.http(`/users.info?user=${encodeURIComponent(String(m.user))}`).catch(() => null);
  return neutral(String(nomesDa(j?.user ?? {})[0] ?? m.user), 60);
}
/** Canal e mensagem de verdade, para quem só tem os ids. */
async function cartaoDaMensagem(ctx: CtxAcao, a: Args): Promise<{ canal: string; fio: string; detalhe: string }> {
  exigirTs(a);
  const { id, rotulo } = await canalNoCartao(ctx, a.canal);
  const { m, fio } = await mensagemDe(ctx, id, String(a.mensagem));
  return { canal: id, fio, detalhe: `Canal: ${rotulo}\nMensagem de ${await autorDa(ctx, m)}: "${neutral(conteudoDa(m), MAX_CITADA)}"` };
}

// ---------------------------------------------------------------------------------------------------------- erros
const SEM_BUSCA = 'a busca do Slack só funciona com o token de usuário, que começa com xoxp-. Crie o app com busca, pelo outro link da ajuda em Conexões › Slack, e cole esse token (com ele, os agentes agem em seu nome)';
const TOKEN_RUIM = 'o token não vale mais ou foi recusado: gere outro no Slack e cole em Conexões › Slack';
const CONVIDE = 'no Slack, abra o canal e escreva /invite seguido de @ e do nome do app';
/** Códigos da documentação do Slack, em português. Os marcados com `p` são falta de permissão; o resto é outro tipo de erro. */
const ERROS: Record<string, { m: string; p?: boolean }> = {
  missing_scope: { m: 'o app não tem esta permissão: crie o app de novo pelo link da ajuda e instale de novo', p: true },
  not_allowed_token_type: { m: SEM_BUSCA, p: true },
  not_in_channel: { m: `o app não está neste canal: ${CONVIDE}`, p: true },
  no_permission: { m: 'o app não tem permissão para isto', p: true },
  access_denied: { m: 'o Slack negou o acesso a isto', p: true },
  restricted_action: { m: 'as regras deste espaço de trabalho não permitem isto', p: true },
  restricted_action_read_only_channel: { m: 'este canal é só de leitura', p: true },
  restricted_action_thread_locked: { m: 'os administradores trancaram esta conversa: não dá para responder nela', p: true },
  posting_to_channel_denied: { m: 'este canal recusou a mensagem: ele não aceita arquivos nem imagens', p: true },
  cannot_reply_to_message: { m: 'esta mensagem não aceita respostas: escreva direto no canal' },
  cant_delete_message: { m: 'sem permissão para apagar esta mensagem: o app só apaga as que ele mesmo enviou', p: true },
  team_access_not_granted: { m: 'o token não tem acesso a este espaço de trabalho', p: true },
  ekm_access_denied: { m: 'os administradores suspenderam esta ação', p: true },
  invalid_auth: { m: TOKEN_RUIM, p: true }, not_authed: { m: TOKEN_RUIM, p: true }, token_revoked: { m: TOKEN_RUIM, p: true }, token_expired: { m: TOKEN_RUIM, p: true }, account_inactive: { m: TOKEN_RUIM, p: true },
  channel_not_found: { m: `canal não encontrado, ou o app não tem acesso a ele: ${CONVIDE}` },
  thread_not_found: { m: 'conversa não encontrada: confira o ts da mensagem' },
  message_not_found: { m: 'mensagem não encontrada: confira o ts' },
  user_not_found: { m: 'pessoa não encontrada' },
  user_disabled: { m: 'esta pessoa está desativada no Slack' },
  is_archived: { m: 'este canal está arquivado' },
  already_reacted: { m: 'o app já tinha reagido com este emoji' },
  invalid_name: { m: 'este emoji não existe neste espaço de trabalho' },
  invalid_cursor: { m: 'o cursor não vale mais: comece de novo, sem ele' },
  no_query: { m: 'falta o que buscar' },
  no_text: { m: 'falta o texto da mensagem' },
};

// ---------------------------------------------------------------------------------------------------------- parâmetros
const P_CANAL: Param = { tipo: 'texto', obrigatorio: true, descricao: 'nome do canal (ex.: geral) ou id (C…)' };
const P_TEXTO: Param = { tipo: 'texto', obrigatorio: true, descricao: `a mensagem, até ${MAX_TEXTO} caracteres`, max: MAX_TEXTO };
const P_TS: Param = { tipo: 'texto', obrigatorio: true, descricao: 'ts da mensagem, como 1503435956.000247 (vem de slack.ler)' };
const TIPOS: Record<string, string> = { canais: 'public_channel,private_channel', publicos: 'public_channel', privados: 'private_channel', diretas: 'im,mpim', todos: 'public_channel,private_channel,mpim,im' };

export const SLACK: ConectorDef = {
  kind: 'slack', nome: 'Slack', site: 'slack.com', grupo: 'conversas',
  sobre: 'Canais e conversas do Slack, com um app seu: os agentes leem os canais para onde você convidou o app e escrevem quando você pede. Nenhuma mensagem chama o canal inteiro.',
  campos: [{ name: 'token', label: 'Token do app', secret: true, placeholder: 'Cole aqui o token que começa com xoxb-', pattern: /^xox[bp]-\S+$/, patternHelp: 'use o token que começa com xoxb- (ou xoxp-, para buscar mensagens)' }],
  ajuda: {
    url: linkDoApp(MANIFESTO_SLACK),
    passos: `Você vai criar um app só seu no Slack, com as permissões já escolhidas. 1. Clique em "Abrir a página", no fim deste texto: o Slack abre a criação do app com tudo preenchido (entre na sua conta, se ele pedir). Se abrir sem preencher, clique em "Create an app", escolha criar "from a manifest" e cole o texto do botão "Copiar o texto do app", abaixo. 2. Escolha o seu espaço de trabalho, clique em "Next", confira o resumo e clique em "Create". 3. No menu da esquerda, abra "OAuth & Permissions", clique em "Install to Workspace" e depois em "Allow". 4. Volte a "OAuth & Permissions" e, na parte "OAuth Tokens", copie o token que começa com xoxb-. Cole aqui. 5. Em cada canal que os agentes vão usar, escreva /invite @Ergon. Opcional, para os agentes também buscarem mensagens: crie o app pelo link "Criar o app com busca", abaixo, em vez do primeiro. Siga os mesmos passos e, no passo 4, copie o token que começa com xoxp-. Com esse token, os agentes escrevem em seu nome e veem tudo o que você vê.`,
    // o texto do app e o segundo link ficam fora dos passos: a tela mostra um botão de copiar e um link de verdade
    extras: [{ rotulo: 'Copiar o texto do app', copiar: MANIFESTO_TEXTO }, { rotulo: 'Criar o app com busca', url: linkDoApp(MANIFESTO_SLACK_COM_BUSCA) }],
  },
  base: 'https://slack.com/api',
  auth: { tipo: 'bearer' },
  // o Slack diz em toda resposta se deu certo: um 200 com ok:false nunca pode parecer sucesso
  erroNoCorpo: (j) => {
    if (j?.ok !== false) return null;
    const codigo = String(j.error ?? 'erro desconhecido');
    const e = ERROS[codigo];
    const falta = codigo === 'missing_scope' && typeof j.needed === 'string' ? ` (falta ${j.needed})` : '';
    return { mensagem: e ? `${e.m}${falta}` : codigo, permissao: !!e?.p };
  },
  quemSou: { caminho: '/auth.test', metodo: 'POST', nome: (j) => (j.bot_id ? `App no Slack de ${j.team}` : `${j.user} no Slack de ${j.team}`),
    id: (j) => (j.team_id && j.user_id ? `${j.team_id}:${j.user_id}` : null) },
  acoes: [
    // ---------------------------------------------------------------------------------------------------- leitura
    { id: 'slack.canais', descricao: 'lista os canais e diz em quais o app está', risco: 'ler',
      params: { tipo: { tipo: 'texto', descricao: 'canais (públicos e privados, o padrão), publicos, privados, diretas ou todos', opcoes: Object.keys(TIPOS), padrao: 'canais' }, arquivados: { tipo: 'booleano', descricao: 'incluir os arquivados' }, limite: { tipo: 'numero', descricao: 'quantos por vez, até 200 (padrão 100)', padrao: 100, max: POR_PAGINA } },
      resumo: 'listar os canais do Slack', metodo: 'GET', caminho: '/conversations.list',
      antes: async (_ctx, a) => ({ ...a, tipos_slack: TIPOS[String(a.tipo)], sem_arquivados: a.arquivados !== true }),
      consulta: { types: '{tipos_slack}', exclude_archived: '{sem_arquivados}', limit: '{limite}' }, lista: 'channels', linha: linhaCanal, proximo: proximoCursor },
    { id: 'slack.ler', descricao: 'lê as mensagens de um canal, das mais novas para as mais antigas. As pessoas aparecem pelo id: slack.pessoas diz os nomes', rotulo: 'lê as mensagens de um canal, das mais novas para as mais antigas', risco: 'ler',
      params: { canal: P_CANAL, limite: { tipo: 'numero', descricao: 'quantas por vez, até 200 (padrão 30)', padrao: 30, max: POR_PAGINA }, desde: { tipo: 'texto', descricao: 'só depois desta data (AAAA-MM-DD, horário universal) ou deste ts' }, ate: { tipo: 'texto', descricao: 'só antes desta data (AAAA-MM-DD, horário universal) ou deste ts' } },
      resumo: 'ler o canal {canal} do Slack', metodo: 'GET', caminho: '/conversations.history',
      antes: async (ctx, a) => ({ ...a, canal: await acharCanal(ctx, a.canal), oldest: carimbo(a.desde, 'desde'), latest: carimbo(a.ate, 'ate') }),
      consulta: { channel: '{canal}', limit: '{limite}', oldest: '{oldest}', latest: '{latest}' }, lista: 'messages', linha: linhaMensagem, proximo: proximoCursor },
    { id: 'slack.respostas', descricao: 'lê as respostas de uma conversa dentro de um canal (a mensagem principal vem junto)', risco: 'ler',
      params: { canal: P_CANAL, mensagem: P_TS, limite: { tipo: 'numero', descricao: 'quantas por vez, até 200 (padrão 50)', padrao: 50, max: POR_PAGINA } },
      resumo: 'ler as respostas da mensagem {mensagem} no canal {canal} do Slack', metodo: 'GET', caminho: '/conversations.replies',
      antes: async (ctx, a) => { exigirTs(a); return { ...a, canal: await acharCanal(ctx, a.canal) }; },
      consulta: { channel: '{canal}', ts: '{mensagem}', limit: '{limite}' }, lista: 'messages', linha: linhaMensagem, proximo: proximoCursor },
    { id: 'slack.pessoas', descricao: 'lista as pessoas do espaço de trabalho, com nome e id', rotulo: 'lista as pessoas do espaço de trabalho', risco: 'ler',
      params: { limite: { tipo: 'numero', descricao: 'quantas por vez, até 200 (padrão 100)', padrao: 100, max: POR_PAGINA } },
      resumo: 'listar as pessoas do Slack', metodo: 'GET', caminho: '/users.list', consulta: { limit: '{limite}' }, lista: 'members', linha: linhaPessoa, proximo: proximoCursor },
    { id: 'slack.buscar', descricao: 'busca mensagens em todo o Slack. Só funciona com o token que começa com xoxp-', rotulo: 'busca mensagens em todo o Slack (só com o app com busca, da ajuda)', risco: 'ler',
      params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'o que buscar; aceita os filtros do Slack, como in:geral ou from:@ana' }, ordem: { tipo: 'texto', descricao: 'relevancia (padrão) ou recentes', opcoes: ['relevancia', 'recentes'], padrao: 'relevancia' }, limite: { tipo: 'numero', descricao: 'quantas por vez, até 100 (padrão 20)', padrao: 20, max: 100 } },
      resumo: 'buscar "{texto}" no Slack', metodo: 'GET', caminho: '/search.messages',
      antes: async (ctx, a) => {
        if (ctx.creds?.token?.startsWith('xoxb-')) throw new ErroAcao(SEM_BUSCA);
        if (!String(a.texto ?? '').trim()) throw new ErroAcao('falta "texto"');
        return { ...a, ordem_slack: a.ordem === 'recentes' ? 'timestamp' : 'score' };
      },
      consulta: { query: '{texto}', sort: '{ordem_slack}', count: '{limite}' }, lista: 'messages.matches', linha: linhaAchado,
      // a documentação não mostra onde vem o next_cursor da busca; a paginação por número de página está documentada (até 100)
      proximo: (j) => { const p = j.messages?.paging; return p && p.page < p.pages && p.page < 100 ? String(p.page + 1) : null; }, paramCursor: 'page' },
    // ---------------------------------------------------------------------------------------------------- escrita
    { id: 'slack.enviar', descricao: 'envia uma mensagem num canal em que o app está', risco: 'enviar',
      params: { canal: P_CANAL, texto: P_TEXTO },
      resumo: 'Enviar no canal {canal} do Slack:\n{texto}', metodo: 'POST', caminho: '/chat.postMessage', cabecalhos: JSON_UTF8,
      preparar: async (ctx, a) => {
        textoCabe(a);
        const { id, rotulo } = await canalNoCartao(ctx, a.canal);
        return { detalhe: `Canal: ${rotulo}`, args: { ...a, canal: id } };
      },
      antes: async (ctx, a) => { const b = comTexto(a); return { ...b, canal: await acharCanal(ctx, a.canal) }; },
      corpo: { channel: '{canal}', text: '{texto_slack}' }, texto: 'Mensagem enviada (canal: {channel}, ts: {ts}).' },
    { id: 'slack.responder', descricao: 'responde dentro da conversa de uma mensagem', risco: 'enviar',
      params: { canal: P_CANAL, mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'ts de qualquer mensagem da conversa (vem de slack.ler ou slack.respostas)' }, texto: P_TEXTO, tambem_no_canal: { tipo: 'booleano', descricao: 'mostrar a resposta também para todos no canal' } },
      resumo: (a) => `Responder à mensagem ${a.mensagem} no canal ${a.canal} do Slack${sim(a.tambem_no_canal) ? ', mostrando a resposta também para todos no canal' : ''}:\n${a.texto}`,
      metodo: 'POST', caminho: '/chat.postMessage', cabecalhos: JSON_UTF8,
      preparar: async (ctx, a) => {
        textoCabe(a);
        const { canal, fio, detalhe } = await cartaoDaMensagem(ctx, a);
        return { detalhe, args: { ...a, canal, mensagem: fio } };
      },
      // "Avoid using a reply's ts value; use its parent instead" (chat.postMessage): a resposta vai sempre para a mensagem principal
      antes: async (ctx, a) => {
        const b = comTexto(a);
        exigirTs(a);
        const canal = await acharCanal(ctx, a.canal);
        const { fio } = await mensagemDe(ctx, canal, String(a.mensagem));
        return { ...b, canal, mensagem: fio };
      },
      corpo: { channel: '{canal}', thread_ts: '{mensagem}', text: '{texto_slack}', reply_broadcast: '{tambem_no_canal}' }, texto: 'Resposta enviada (canal: {channel}, ts: {ts}).' },
    { id: 'slack.direta', descricao: 'envia uma mensagem direta a uma pessoa', risco: 'enviar',
      params: { pessoa: { tipo: 'texto', obrigatorio: true, descricao: 'nome completo, apelido ou id (U…) da pessoa' }, texto: P_TEXTO },
      resumo: 'Enviar mensagem direta a {pessoa} no Slack:\n{texto}', metodo: 'POST', caminho: '/chat.postMessage', cabecalhos: JSON_UTF8,
      preparar: async (ctx, a) => {
        textoCabe(a);
        const p = await acharPessoa(ctx, a.pessoa);
        const porNome = p.nome !== p.id;
        const { user: u } = await ctx.http(`/users.info?user=${encodeURIComponent(p.id)}`);
        if (u?.deleted) throw new ErroAcao('esta pessoa está desativada no Slack (nada foi feito)');
        return { detalhe: `Para: ${rotuloDa(u ?? { id: p.id })}`, args: { ...a, pessoa: p.id }, ...(porNome ? { confirmar: 'no Slack, cada pessoa escolhe o próprio nome: confira se é quem você quer' } : {}) };
      },
      antes: async (ctx, a) => {
        const b = comTexto(a);
        const p = await acharPessoa(ctx, a.pessoa);
        const aberta = await ctx.http('/conversations.open', { method: 'POST', kind: 'write', headers: JSON_UTF8, body: { users: p.id } });
        if (!aberta?.channel?.id) throw new ErroAcao('o Slack não abriu a conversa direta com esta pessoa');
        return { ...b, canal: String(aberta.channel.id), pessoa_id: p.id };
      },
      // quem o agente pediu e o id: o nome no Slack é a própria pessoa que escolhe, e não volta ao agente
      corpo: { channel: '{canal}', text: '{texto_slack}' }, texto: (j, a) => {
        const pedido = String(a.pessoa ?? '').trim(); const id = String(a.pessoa_id);
        return `Mensagem direta enviada a ${neutral(pedido, 120)} (${pedido === id ? '' : `id: ${neutral(id, 40)}, `}ts: ${neutral(String(j.ts ?? ''))}).`;
      } },
    // quem escreveu a mensagem vê e pode ser avisado: conta como enviar
    { id: 'slack.reagir', descricao: 'reage a uma mensagem com um emoji', risco: 'enviar',
      params: { canal: P_CANAL, mensagem: P_TS, emoji: { tipo: 'texto', obrigatorio: true, descricao: 'nome do emoji, como thumbsup' } },
      resumo: 'Reagir com o emoji :{emoji}: à mensagem {mensagem} do canal {canal} do Slack', metodo: 'POST', caminho: '/reactions.add', cabecalhos: JSON_UTF8,
      preparar: async (ctx, a) => {
        const { canal, detalhe } = await cartaoDaMensagem(ctx, a);
        return { detalhe, args: { ...a, canal } };
      },
      antes: async (ctx, a) => {
        exigirTs(a);
        const emoji = String(a.emoji ?? '').trim().replace(/^:|:$/g, '');
        if (!/^[a-z0-9_+'-]+(::[a-z0-9_-]+)?$/.test(emoji)) throw new ErroAcao('"emoji" precisa ser o nome do emoji, como thumbsup');
        return { ...a, emoji, canal: await acharCanal(ctx, a.canal) };
      },
      corpo: { channel: '{canal}', name: '{emoji}', timestamp: '{mensagem}' }, texto: 'Reação adicionada.' },
    { id: 'slack.apagar', descricao: 'apaga uma mensagem: com o token xoxb-, só as que o próprio app enviou', rotulo: 'apaga uma mensagem (com o app comum, só as que o próprio app enviou)', risco: 'apagar',
      params: { canal: P_CANAL, mensagem: P_TS },
      resumo: 'Apagar a mensagem {mensagem} do canal {canal} do Slack', metodo: 'POST', caminho: '/chat.delete', cabecalhos: JSON_UTF8,
      preparar: async (ctx, a) => {
        const { canal, detalhe } = await cartaoDaMensagem(ctx, a);
        return { detalhe, args: { ...a, canal } };
      },
      antes: async (ctx, a) => { exigirTs(a); return { ...a, canal: await acharCanal(ctx, a.canal) }; },
      corpo: { channel: '{canal}', ts: '{mensagem}' }, texto: 'Mensagem apagada.' },
  ],
};
