/**
 * Rocket.Chat (na nuvem ou em instalação própria), com o token de acesso pessoal da pessoa: ele age como a própria conta.
 * Referências oficiais, em developer.rocket.chat/apidocs/: authenticate-a-rest-client, generate-personal-access-token,
 * get-profile-information (/me), get-all-subscriptions (subscriptions.get), get-room-information (rooms.info),
 * get-channel-history, get-group-history, dm-history, search-message (chat.search), get-thread-messages, get-message
 * (chat.getMessage), get-team-info (teams.info), post-message (chat.postMessage: "#" e "@" no mesmo campo do id),
 * delete-chat-message (chat.delete), query-parameters (count e offset).
 * docs.rocket.chat/docs/manage-personal-access-tokens (como criar o token).
 * Código oficial, para o que a documentação não diz: github.com/RocketChat/Rocket.Chat, apps/meteor/server/api/v1/channels.ts
 * (a resposta do histórico não traz offset nem total: por isso o cursor é a data), apps/meteor/lib/MentionsParser.ts
 * mais packages/message-parser/src/grammar.pegjs (como o servidor acha menções), apps/meteor/server/services/messages/hooks/BeforeSaveMentions.ts
 * (@nome de um time chama o time), apps/meteor/server/api/v1/teams.ts (teams.info: 400 "Team not found", 403 quando existe e a
 * conta não vê), apps/meteor/server/lib/messages/processWebhookMessage.ts (o que "#" e "@" fazem), apps/meteor/server/settings/general.ts
 * (limite de uso padrão), packages/core-typings/src/IMessage (file, files, attachments, blocks).
 */
import { clip } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { ErroAcao, type Args, type CtxAcao } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef } from './declarativo.ts';
import { MAX_CITADA, MAX_NOME, MAX_QUEM, MAX_TEXTO, conferirTexto, juntarConteudo, linhas, listaDe, marcaDeCartao, semMencaoEmMassa, textoDoCartao, type Citados } from './mattermost.ts';

/** A API não tem opção, por mensagem, que desligue @all e @here: o espaço depois do @ desarma, como no Mattermost. */
const textoSeguro = (a: Args): string => semMencaoEmMassa(String(a.texto ?? ''));

/**
 * Texto, anexos e cartões. Mensagem só com arquivo vem sem texto. O anexo do tipo "file" repete o nome do arquivo; a legenda só mora
 * nele. Bloco só conta quando não há mais nada, porque o resto já diz o que é.
 */
function conteudoDa(x: any): string {
  const vistos = new Set<string>();
  const arquivos = [...listaDe(x?.files), ...(x?.file ? [x.file] : [])].filter((f) => { const k = String(f?._id ?? f?.name ?? ''); if (k && vistos.has(k)) return false; vistos.add(k); return true; });
  const deArquivo = listaDe(x?.attachments).filter((c) => c?.type === 'file');
  const cartoes = listaDe(x?.attachments).filter((c) => c?.type !== 'file').map((c) => marcaDeCartao(c?.title || c?.text || c?.description || c?.pretext));
  const nomes = arquivos.length ? arquivos.map((f) => f?.name) : deArquivo.map((c) => c?.title);
  const blocos = listaDe(x?.blocks);
  const bloco = !x?.msg && !nomes.length && !cartoes.length && blocos.length ? marcaDeCartao(blocos.map((b) => b?.text?.text).find(Boolean)) : '';
  return juntarConteudo([x?.msg, ...nomes.map((n) => `[anexo: ${n || 'arquivo'}]`), ...deArquivo.map((c) => (c?.description ? neutral(String(c.description), MAX_CITADA) : '')), ...cartoes, bloco]);
}
const linhaDaMensagem = (x: any): string => linhaDe(x.tmid ? '{ts} {u.username}: {conteudo} (id: {_id}, fio: {tmid})' : '{ts} {u.username}: {conteudo} (id: {_id})', { ...x, conteudo: conteudoDa(x) }, 2000);

/** Cada tipo de sala tem o seu histórico. Atendimento (livechat) e outros tipos têm API própria e ficam de fora. */
const HISTORICO: Record<string, string> = { c: 'channels.history', p: 'groups.history', d: 'dm.history' };

/**
 * Só o id. No mesmo campo, a API aceita "#canal", que entra no canal, e "@pessoa", que abre uma conversa direta: nada disso pode
 * acontecer sem a pessoa ver no cartão.
 */
function salaConferida(a: Args): void {
  const s = String(a.sala ?? '').trim();
  if (!s) throw new ErroAcao('falta "sala"');
  if (/^[#@]/.test(s)) throw new ErroAcao('use o id da sala, que vem de rocketchat.salas: com # ou @ o Rocket.Chat entraria num canal ou abriria uma conversa sozinho (nada foi feito)');
}

/** count=0 pediria tudo de uma vez, onde o administrador deixa: o limite nunca fica abaixo de 1. */
const comLimite = async (_ctx: CtxAcao, a: Args): Promise<Args> => ({ ...a, limite: Math.max(1, Number(a.limite) || 1) });

async function historicoDaSala(ctx: CtxAcao, a: Args): Promise<Args> {
  salaConferida(a);
  const j = await ctx.http(`/rooms.info?roomId=${encodeURIComponent(String(a.sala))}`);
  const historico = HISTORICO[String(j?.room?.t)];
  if (!historico) throw new ErroAcao('esta sala é de um tipo que a leitura não cobre: só canais, grupos privados e mensagens diretas');
  return comLimite(ctx, { ...a, historico });
}

// --------------------------------------------------------------------------------------------- o que o cartão precisa mostrar
/** O nome que a pessoa reconhece, conferindo que o id é mesmo de uma sala. */
async function salaNoCartao(ctx: CtxAcao, id: unknown): Promise<string> {
  const j = await ctx.http(`/rooms.info?roomId=${encodeURIComponent(String(id))}`);
  const r = j?.room;
  if (r?.t === 'd') return `conversa direta${listaDe(r.usernames).length ? ` com ${clip(r.usernames.map((u: unknown) => neutral(String(u), MAX_QUEM)).join(', '), MAX_NOME)}` : ''}`;
  return `#${neutral(String(r?.fname || r?.name || id), MAX_NOME)}${r?.t === 'p' ? ' (privada)' : ''}`;
}
async function mensagemDaSala(ctx: CtxAcao, a: Args): Promise<any> {
  const { message: m } = await ctx.http(`/chat.getMessage?msgId=${encodeURIComponent(String(a.mensagem))}`);
  if (m?.rid !== a.sala) throw new ErroAcao('esta mensagem não é desta sala: confira a sala e a mensagem (nada foi feito)');
  return m;
}
const citadaNoCartao = (m: any): string => `Mensagem de ${neutral(String(m?.u?.username ?? 'alguém'), MAX_QUEM)}: "${neutral(conteudoDa(m), MAX_CITADA)}"`;

/** O Rocket.Chat limita cada rota a 10 chamadas por minuto, por padrão: mais nomes que isso ficam sem conferir, e o cartão avisa. */
const TETO_DE_CONSULTAS = 10;
/** true: é um time. false: não é. null: não deu para saber. */
async function eTime(ctx: CtxAcao, nome: string): Promise<boolean | null> {
  try {
    const j = await ctx.http(`/teams.info?teamName=${encodeURIComponent(nome)}`);
    return j?.teamInfo ? true : null;
  } catch (e) {
    if (!(e instanceof ProviderError)) return null;
    if (e.status === 403) return true; // existe, só a conta não vê; a menção chamaria o time do mesmo jeito
    if (e.status === 404) return false; // servidor sem times
    return e.status === 400 && /team not found/i.test(e.message) ? false : null;
  }
}
/** Na primeira falha, para: se foi o limite de uso ou o serviço fora, insistir em cada nome só faria a pessoa esperar. */
async function timesCitados(ctx: CtxAcao, nomes: string[]): Promise<Citados> {
  const chamam = new Set<string>();
  for (const [i, nome] of nomes.slice(0, TETO_DE_CONSULTAS).entries()) {
    const e = await eTime(ctx, nome);
    if (e === null) return { chamam, semConferir: nomes.slice(i) };
    if (e) chamam.add(nome.toLowerCase());
  }
  return { chamam, semConferir: nomes.slice(TETO_DE_CONSULTAS) };
}

const P_SALA = { tipo: 'texto', obrigatorio: true, descricao: 'id da sala' } as const;
const P_MENSAGEM = { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem' } as const;
const P_LIMITE = { tipo: 'numero', descricao: 'até 100 (padrão 30)', padrao: 30, max: 100 } as const;

export const ROCKETCHAT: ConectorDef = {
  kind: 'rocketchat', nome: 'Rocket.Chat', site: 'rocket.chat', grupo: 'conversas',
  sobre: 'Salas do Rocket.Chat: os agentes leem e buscam as conversas que a sua conta vê e respondem quando você pede. Nenhuma mensagem chama a sala inteira nem um time.',
  campos: [
    { name: 'site', label: 'Endereço do seu Rocket.Chat', placeholder: 'empresa.rocket.chat' },
    { name: 'usuario', label: 'ID do usuário (User Id)', placeholder: 'Aparece junto com o token' },
    { name: 'token', label: 'Token de acesso pessoal', secret: true, placeholder: 'Cole o token aqui' },
  ],
  ajuda: {
    url: 'https://docs.rocket.chat/docs/manage-personal-access-tokens',
    passos: 'No seu Rocket.Chat, clique na sua foto › Profile › Personal Access Tokens. Escreva um nome para o token, em Two Factor Authentication deixe "Require Two Factor Authentication" e clique em Add. Se a tela pedir, confirme com a sua senha ou código. Aparecem o ID do usuário (User Id) e o token, uma única vez: copie os dois para cá, junto com o endereço do seu Rocket.Chat. O token faz tudo o que a sua conta faz, inclusive escrever. Se a opção não aparecer, peça a quem administra para liberar a permissão "create-personal-access-tokens" em Manage › Workspace › Permissions.',
  },
  base: (c) => `https://${hostSeguro(c.site)}/api/v1`,
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ 'X-Auth-Token': c.token, 'X-User-Id': c.usuario }) },
  erroNoCorpo: (j) => (j?.success === false ? { mensagem: String(j.error ?? j.errorType ?? 'sem detalhe'), permissao: /not[-_ ]?allowed|unauthorized|forbidden|permission/i.test(`${j.errorType ?? ''} ${j.error ?? ''}`) } : null),
  quemSou: { caminho: '/me', nome: (j) => String(j.name || j.username || 'conta do Rocket.Chat'), id: (j) => j._id },
  acoes: [
    { id: 'rocketchat.salas', descricao: 'lista as salas em que você está', risco: 'ler', params: {}, resumo: 'listar salas',
      metodo: 'GET', caminho: '/subscriptions.get', lista: 'update', linha: '{fname} ({name}) (id: {rid}, tipo {t}, não lidas: {unread})' },
    { id: 'rocketchat.ler', descricao: 'lê as mensagens mais recentes de uma sala', risco: 'ler',
      params: {
        sala: P_SALA, limite: P_LIMITE,
        desde: { tipo: 'texto', descricao: 'só mensagens depois desta data, como 2026-11-05T13:00:00.000Z' },
        ate: { tipo: 'texto', descricao: 'só mensagens antes desta data, como 2026-11-05T13:00:00.000Z' },
      },
      resumo: 'ler a sala {sala}', metodo: 'GET', caminho: '/{historico}', antes: historicoDaSala,
      consulta: { roomId: '{sala}', count: '{limite}', oldest: '{desde}', latest: '{ate}' }, lista: 'messages', linha: linhaDaMensagem,
      // sem offset na resposta, a próxima página começa antes da mensagem mais antiga desta; página vazia encerra
      proximo: (j) => (Array.isArray(j.messages) && j.messages.length ? j.messages.map((m: any) => String(m.ts)).sort()[0] : null), paramCursor: 'latest' },
    { id: 'rocketchat.fio', descricao: 'lê as respostas de uma conversa, a partir da primeira mensagem dela', risco: 'ler',
      params: { mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da primeira mensagem da conversa' }, limite: P_LIMITE },
      resumo: 'ler a conversa da mensagem {mensagem}', metodo: 'GET', caminho: '/chat.getThreadMessages', antes: comLimite, consulta: { tmid: '{mensagem}', count: '{limite}' }, lista: 'messages', linha: linhaDaMensagem,
      proximo: (j) => { const fim = Number(j.offset) + Number(j.count); return fim < Number(j.total) ? String(fim) : null; }, paramCursor: 'offset' },
    { id: 'rocketchat.buscar', descricao: 'busca mensagens numa sala', risco: 'ler',
      params: { sala: P_SALA, termos: { tipo: 'texto', obrigatorio: true, descricao: 'o que buscar' }, limite: P_LIMITE, pular: { tipo: 'numero', descricao: 'quantos resultados pular, para ver os seguintes' } },
      resumo: 'buscar "{termos}" na sala {sala}', metodo: 'GET', caminho: '/chat.search', antes: async (ctx, a) => { salaConferida(a); return comLimite(ctx, a); }, consulta: { roomId: '{sala}', searchText: '{termos}', count: '{limite}', offset: '{pular}' }, lista: 'messages', linha: linhaDaMensagem },
    { id: 'rocketchat.enviar', descricao: 'envia uma mensagem numa sala', risco: 'enviar',
      params: { sala: P_SALA, texto: { tipo: 'texto', obrigatorio: true, descricao: `a mensagem, até ${MAX_TEXTO} caracteres`, max: MAX_TEXTO } },
      resumo: (a) => `Enviar na sala ${String(a.sala ?? '')} do Rocket.Chat:\n${textoSeguro(a)}`,
      preparar: async (ctx, a) => {
        salaConferida(a);
        await conferirTexto(ctx, a);
        const sala = await salaNoCartao(ctx, a.sala);
        const t = await textoDoCartao(ctx, a, 'time', (nomes) => timesCitados(ctx, nomes));
        return { detalhe: linhas(`Sala: ${sala}`, t.aviso), args: { ...a, texto: t.texto }, ...(t.confirmar ? { confirmar: t.confirmar } : {}) };
      },
      metodo: 'POST', caminho: '/chat.postMessage', antes: async (ctx, a) => { salaConferida(a); return conferirTexto(ctx, a); }, corpo: (a: Args) => ({ roomId: a.sala, text: textoSeguro(a) }), texto: 'Mensagem enviada (id: {message._id}).' },
    { id: 'rocketchat.responder', descricao: 'responde a uma mensagem, dentro da mesma conversa', risco: 'enviar',
      params: { sala: P_SALA, mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem respondida' }, texto: { tipo: 'texto', obrigatorio: true, descricao: `a resposta, até ${MAX_TEXTO} caracteres`, max: MAX_TEXTO } },
      resumo: (a) => `Responder à mensagem ${String(a.mensagem ?? '')} na sala ${String(a.sala ?? '')} do Rocket.Chat:\n${textoSeguro(a)}`,
      // a resposta a uma resposta vai para a primeira mensagem da conversa: tmid é a mensagem que abre o fio
      preparar: async (ctx, a) => {
        salaConferida(a);
        await conferirTexto(ctx, a);
        const m = await mensagemDaSala(ctx, a);
        const sala = await salaNoCartao(ctx, a.sala);
        const t = await textoDoCartao(ctx, a, 'time', (nomes) => timesCitados(ctx, nomes));
        return { detalhe: linhas(`Sala: ${sala}`, citadaNoCartao(m), t.aviso), args: { ...a, mensagem: m?.tmid || a.mensagem, texto: t.texto }, ...(t.confirmar ? { confirmar: t.confirmar } : {}) };
      },
      metodo: 'POST', caminho: '/chat.postMessage', antes: async (ctx, a) => { salaConferida(a); return conferirTexto(ctx, a); }, corpo: (a: Args) => ({ roomId: a.sala, text: textoSeguro(a), tmid: a.mensagem }), texto: 'Resposta enviada (id: {message._id}).' },
    { id: 'rocketchat.apagar', descricao: 'apaga uma mensagem', risco: 'apagar',
      params: { sala: P_SALA, mensagem: P_MENSAGEM },
      resumo: 'Apagar a mensagem {mensagem} da sala {sala} do Rocket.Chat',
      preparar: async (ctx, a) => {
        salaConferida(a);
        const m = await mensagemDaSala(ctx, a);
        return { detalhe: linhas(`Sala: ${await salaNoCartao(ctx, a.sala)}`, citadaNoCartao(m)) };
      },
      metodo: 'POST', caminho: '/chat.delete', antes: async (_ctx, a) => { salaConferida(a); return a; }, corpo: { roomId: '{sala}', msgId: '{mensagem}' }, texto: 'Mensagem apagada.' },
  ],
};
