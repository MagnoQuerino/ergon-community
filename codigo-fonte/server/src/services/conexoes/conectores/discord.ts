/**
 * Discord, com um bot do próprio usuário. Referências: discord.com/developers/docs/reference (autenticação "Bot <token>"),
 * .../resources/user (Get Current User, Get Current User Guilds, Create DM), .../resources/guild (Get Guild Channels),
 * .../resources/message (Get Channel Messages, Create Message; allowed_mentions).
 * Ler o texto das mensagens exige a opção "Message Content Intent" ligada no portal do bot.
 */
import { neutral } from '../../operations.ts';
import { seg, type Acao } from '../tipos.ts';
import type { ConectorDef } from './declarativo.ts';

/** Texto de quem escreve nunca aciona @everyone nem marca pessoas: um texto lido não pode chamar o servidor inteiro. */
const SEM_MENCAO = { parse: [] as string[] };
/** O cartão de confirmação diz o nome do canal: o agente só tem o id. */
const NOME_DO_CANAL: Acao['preparar'] = async (ctx, a) => {
  const c = await ctx.http(`/channels/${seg(a.canal)}`, { method: 'GET', kind: 'read' });
  return { detalhe: `Canal: #${neutral(String(c?.name ?? a.canal), 80)}` };
};

export const DISCORD: ConectorDef = {
  kind: 'discord', nome: 'Discord', site: 'discord.com', grupo: 'conversas',
  sobre: 'Servidores do Discord, com um bot seu: os agentes leem os canais em que o bot está e respondem quando você pede.',
  campos: [{ name: 'token', label: 'Token do bot', secret: true, placeholder: 'Cole o token do bot aqui' }],
  ajuda: { url: 'https://discord.com/developers/applications', passos: 'No portal de desenvolvedores do Discord: New Application › Bot › Reset Token e copie. Na mesma página, ligue "Message Content Intent". Depois, em OAuth2 › URL Generator, marque "bot" com as permissões View Channels, Send Messages e Read Message History, abra o link gerado e convide o bot para o seu servidor. Cole o token aqui.' },
  base: 'https://discord.com/api/v10',
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ Authorization: `Bot ${c.token}` }) },
  quemSou: { caminho: '/users/@me', nome: (j) => String(j.global_name ?? j.username ?? 'bot do Discord'), id: (j) => j.id },
  acoes: [
    { id: 'discord.servidores', descricao: 'lista os servidores em que o bot está', risco: 'ler', params: {}, resumo: 'listar servidores', metodo: 'GET', caminho: '/users/@me/guilds', lista: '', linha: '{name} (id: {id})' },
    { id: 'discord.canais', descricao: 'lista os canais de um servidor', risco: 'ler', params: { servidor: { tipo: 'texto', obrigatorio: true, descricao: 'id do servidor' } }, resumo: 'listar canais do servidor {servidor}',
      metodo: 'GET', caminho: '/guilds/{servidor}/channels', lista: '', linha: '#{name} (id: {id}, tipo {type})' },
    { id: 'discord.ler', descricao: 'lê as mensagens mais recentes de um canal', risco: 'ler',
      params: { canal: { tipo: 'texto', obrigatorio: true, descricao: 'id do canal' }, limite: { tipo: 'numero', descricao: 'até 100 (padrão 30)', padrao: 30, max: 100 }, antes_de: { tipo: 'texto', descricao: 'id de uma mensagem: lê as anteriores a ela' } },
      resumo: 'ler o canal {canal}', metodo: 'GET', caminho: '/channels/{canal}/messages', consulta: { limit: '{limite}', before: '{antes_de}' }, lista: '', linha: '{timestamp} {author.username}: {content} (id: {id})' },
    { id: 'discord.enviar', descricao: 'envia uma mensagem num canal', risco: 'enviar',
      params: { canal: { tipo: 'texto', obrigatorio: true, descricao: 'id do canal' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a mensagem, até 2000 caracteres' } },
      resumo: 'Enviar no canal {canal} do Discord:\n{texto}', preparar: NOME_DO_CANAL, metodo: 'POST', caminho: '/channels/{canal}/messages', corpo: { content: '{texto}', allowed_mentions: SEM_MENCAO }, texto: 'Mensagem enviada (id: {id}).' },
    { id: 'discord.responder', descricao: 'responde a uma mensagem de um canal', risco: 'enviar',
      params: { canal: { tipo: 'texto', obrigatorio: true, descricao: 'id do canal' }, mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem respondida' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a resposta' } },
      resumo: 'Responder à mensagem {mensagem} no canal {canal} do Discord:\n{texto}', preparar: NOME_DO_CANAL, metodo: 'POST', caminho: '/channels/{canal}/messages',
      corpo: { content: '{texto}', message_reference: { message_id: '{mensagem}' }, allowed_mentions: SEM_MENCAO }, texto: 'Resposta enviada (id: {id}).' },
    { id: 'discord.apagar', descricao: 'apaga uma mensagem do próprio bot', risco: 'apagar',
      params: { canal: { tipo: 'texto', obrigatorio: true, descricao: 'id do canal' }, mensagem: { tipo: 'texto', obrigatorio: true, descricao: 'id da mensagem' } },
      resumo: 'Apagar a mensagem {mensagem} do canal {canal} do Discord',
      preparar: async (ctx, a) => {
        const m = await ctx.http(`/channels/${seg(a.canal)}/messages/${seg(a.mensagem)}`, { method: 'GET', kind: 'read' });
        return { detalhe: `Mensagem de ${neutral(String(m?.author?.username ?? 'desconhecido'), 60)}: "${neutral(String(m?.content ?? ''), 500)}"` };
      },
      metodo: 'DELETE', caminho: '/channels/{canal}/messages/{mensagem}', texto: 'Mensagem apagada.' },
  ],
};
