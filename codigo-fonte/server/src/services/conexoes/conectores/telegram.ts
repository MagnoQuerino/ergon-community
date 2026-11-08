/**
 * Telegram, com um bot do próprio usuário (Bot API). Referências oficiais, conferidas em 05/11/2026 (#getchat, #getupdates e
 * #getwebhookinfo de novo em 06/11/2026):
 *   core.telegram.org/bots/api (#making-requests, #getupdates, #getwebhookinfo, #getme, #getchat, #sendmessage, #replyparameters, #update,
 *     #message, #chat, #chatfullinfo, #user)
 *   core.telegram.org/bots (o bot não começa conversa com ninguém) | core.telegram.org/bots/features (#privacy-mode, #botfather)
 *   core.telegram.org/bots/tutorial (como obter o token) | core.telegram.org/bots/faq (getUpdates: as 100 mais antigas sem confirmar)
 *
 * O token vai no endereço, como a Bot API pede: por isso é conferido antes de virar endereço (uma "/" nele mudaria o método
 * chamado), e nenhuma mensagem de erro do motor leva o endereço.
 *
 * Leitura sem consumir: `offset` confirma o que veio antes dele (e um negativo faz o Telegram esquecer o restante), e
 * `allowed_updates` fica gravado no bot. telegram.novidades não manda nenhum dos dois, para não tirar nada de quem mais lê este
 * bot. Efeitos: as mesmas novidades voltam a cada leitura; vêm as mais antigas primeiro, no máximo 100; o Telegram guarda por até
 * 24 horas. Só telegram.marcar_lidas manda `offset`, sempre positivo e logo acima de uma novidade que está na fila.
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';

const TOKEN_BOT = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;
/** "1-4096 characters after entities parsing": sem parse_mode, é o tamanho do próprio texto. */
const MAX_TEXTO = 4096;
const MAX_LINHA = 4200;
/** O máximo que o Telegram entrega de uma vez. */
const MAX_FILA = 100;
/** No cartão de confirmação, que também precisa caber com o texto que vai. */
const MAX_NOME = 80;
const MAX_QUEM = 60;
const MAX_CITADA = 300;

// ---------------------------------------------------------------------------------------------------- como ler a resposta
const TIPOS_MENSAGEM = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message', 'edited_business_message'];
const mensagemDa = (u: any): { tipo: string | undefined; m: any } => { const tipo = TIPOS_MENSAGEM.find((t) => u?.[t]); return { tipo, m: tipo ? u[tipo] : null }; };
const nomeDaConversa = (c: any): string => c?.title || (c?.username ? `@${c.username}` : [c?.first_name, c?.last_name].filter(Boolean).join(' ')) || 'conversa';
const nomeDe = (p: any): string => [p?.first_name, p?.last_name].filter(Boolean).join(' ') || (p?.username ? `@${p.username}` : '');
const quando = (s: unknown): string => {
  const n = Number(s) * 1000;
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 16).replace('T', ' ') : '';
};
function linhaNovidade(u: any): string {
  const { tipo, m } = mensagemDa(u);
  if (m) {
    return linhaDe('{quando} {conversa} (conversa: {id}) {quem}: {texto} (mensagem: {mensagem}, novidade: {novidade}{editada})', {
      quando: quando(m.date), conversa: nomeDaConversa(m.chat), id: m.chat?.id, quem: nomeDe(m.from) || nomeDaConversa(m.chat), texto: m.text ?? m.caption ?? '(sem texto)',
      mensagem: m.message_id, novidade: u.update_id, editada: tipo?.startsWith('edited') ? ', editada' : '',
    }, MAX_LINHA);
  }
  // outros tipos (bot incluído num grupo, botão clicado): diz que houve e de qual conversa, para achar o id
  const outro = Object.keys(u ?? {}).find((k) => k !== 'update_id') ?? 'desconhecido';
  const c = u?.[outro]?.chat ?? u?.[outro]?.message?.chat;
  return linhaDe('novidade do tipo {tipo} {conversa} (conversa: {id}, novidade: {novidade})', { tipo: outro, conversa: c ? nomeDaConversa(c) : '', id: c?.id ?? '-', novidade: u?.update_id });
}
function daConversa(u: any, conversa: string): boolean {
  const c = mensagemDa(u).m?.chat;
  return !!c && (String(c.id) === conversa || (!!c.username && `@${String(c.username).toLowerCase()}` === conversa.toLowerCase().replace(/^@?/, '@')));
}
const textoDa = (u: any): string => { const m = mensagemDa(u).m; return String(m?.text ?? m?.caption ?? '').toLowerCase(); };
/** Se ficou algo de fora e como chegar lá. A contagem vem de getWebhookInfo; a documentação não a garante para quem lê por getUpdates, então leitura cheia também avisa. */
function avisoDeMais(todas: any[], a: Args): string {
  const ultima = Number(todas.at(-1)?.update_id);
  if (!Number.isSafeInteger(ultima)) return '';
  const como = `Para ver as seguintes, use telegram.marcar_lidas com ate_novidade ${ultima}: as lidas saem da fila do bot de vez. Esta leitura não marca nada.`;
  const mais = (Number(a.pendentes) || 0) - todas.length;
  if (mais > 0) return `\n(há mais: ${mais} ${mais === 1 ? 'novidade' : 'novidades'} depois destas. ${como})`;
  return todas.length >= Number(a.limite) ? `\n(pode haver mais. ${como})` : '';
}

// ---------------------------------------------------------------------------------------------------------- conferências
/** O Telegram aceita o número da conversa ou o @nome público: número sai como número, como manda a API. */
function destino(v: unknown): number | string {
  const s = String(v ?? '').trim();
  if (/^-?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,}$/.test(s)) return s.startsWith('@') ? s : `@${s}`;
  throw new ErroAcao('"conversa" precisa ser o número da conversa (vem de telegram.novidades) ou o @nome público dela');
}
function comEnvio(a: Args): Args {
  if (!String(a.texto ?? '').trim()) throw new ErroAcao('falta "texto"');
  return { ...a, chat_id: destino(a.conversa) };
}
/** preparar recebe o pedido antes de o motor conferir os parâmetros: o que o clique recusaria não pode virar cartão. */
function envioCabe(a: Args): void {
  comEnvio(a);
  const n = String(a.texto).length;
  if (n > MAX_TEXTO) throw new ErroAcao(`"texto" tem ${n} caracteres, e o limite é ${MAX_TEXTO}: encurte ou divida (nada foi feito)`);
}
const sim = (v: unknown) => v === true || v === 'true' || v === 'sim';
const semSom = (a: Args) => (sim(a.silencioso) ? ' (avisa sem som)' : '');
const novidades = (n: number): string => `${n} ${n === 1 ? 'novidade' : 'novidades'}`;
const SEM_LEITURA = 'este bot entrega as novidades a outro sistema (webhook): enquanto for assim, o Telegram não deixa lê-las por aqui';

/** A fila como está, sem marcar nada. */
async function filaDoBot(ctx: CtxAcao): Promise<any[]> {
  const j = await ctx.http(`/getUpdates?limit=${MAX_FILA}`);
  return Array.isArray(j?.result) ? j.result : [];
}
/** Só marca até uma novidade que está na fila: negativo faria o Telegram esquecer o resto, e alto demais levaria o que ninguém leu. */
async function conferirMarcacao(ctx: CtxAcao, bruto: unknown): Promise<{ ate: number; quantas: number }> {
  const ate = Number(bruto);
  if (!Number.isSafeInteger(ate) || ate < 1 || !Number.isSafeInteger(ate + 1)) throw new ErroAcao('"ate_novidade" precisa ser o número da última novidade lida (vem de telegram.novidades)');
  const w = await ctx.http('/getWebhookInfo');
  if (w?.result?.url) throw new ErroAcao(SEM_LEITURA);
  const fila = await filaDoBot(ctx);
  if (!fila.some((u) => u?.update_id === ate)) throw new ErroAcao(`a novidade ${ate} não está na fila do bot: leia de novo com telegram.novidades (nada foi feito)`);
  return { ate, quantas: fila.filter((u) => Number(u?.update_id) <= ate).length };
}

// --------------------------------------------------------------------------------------------- o que o cartão precisa mostrar
function rotuloDaConversa(c: any): string {
  if (c?.type === 'private') return `conversa privada com ${neutral(nomeDe(c) || 'alguém', MAX_NOME)}`;
  return `${c?.type === 'channel' ? 'canal' : 'grupo'} ${neutral(nomeDaConversa(c), MAX_NOME)}`;
}
/** A conversa de verdade: o número fixa o alvo do clique, e o nome é o que a pessoa reconhece. */
async function conversaDoCartao(ctx: CtxAcao, a: Args): Promise<{ id: string; rotulo: string }> {
  const alvo = destino(a.conversa);
  const j = await ctx.http(`/getChat?chat_id=${encodeURIComponent(String(alvo))}`);
  return { id: String(j?.result?.id ?? alvo), rotulo: rotuloDaConversa(j?.result) };
}
/** O Telegram não tem como buscar uma mensagem pelo número: o texto só existe enquanto a novidade estiver na fila. */
async function citadaDaFila(ctx: CtxAcao, conversa: string, mensagem: number): Promise<string> {
  const fila = await filaDoBot(ctx).catch(() => [] as any[]);
  const m = fila.map((u) => mensagemDa(u).m).find((x) => x?.message_id === mensagem && String(x?.chat?.id) === conversa);
  if (!m) return `Mensagem ${mensagem}: o bot não tem mais o texto dela`;
  return `Mensagem de ${neutral(nomeDe(m.from) || nomeDaConversa(m.chat), MAX_QUEM)}: "${neutral(String(m.text ?? m.caption ?? '(sem texto)'), MAX_CITADA)}"`;
}

const P_CONVERSA: Param = { tipo: 'texto', obrigatorio: true, descricao: 'número da conversa (vem de telegram.novidades) ou @nome público dela' };
const P_TEXTO: Param = { tipo: 'texto', obrigatorio: true, descricao: `a mensagem, até ${MAX_TEXTO} caracteres, sem formatação`, max: MAX_TEXTO };
const P_SILENCIOSO: Param = { tipo: 'booleano', descricao: 'avisa quem recebe sem som' };

export const TELEGRAM: ConectorDef = {
  kind: 'telegram', nome: 'Telegram', site: 'telegram.org', grupo: 'conversas',
  sobre: 'Conversas do Telegram, com um bot seu. O bot só vê as conversas em que foi incluído: em grupo, ele recebe só comandos e respostas a ele até você mudar isso, e em conversa privada a pessoa precisa escrever primeiro. Os agentes leem o que chegou nas últimas 24 horas e escrevem quando você pede.',
  campos: [{ name: 'token', label: 'Token do bot', secret: true, placeholder: 'Parecido com 123456789:AAHdqTcv...', pattern: TOKEN_BOT, patternHelp: 'cole o token inteiro que o @BotFather enviou: números, dois-pontos e letras' }],
  ajuda: {
    url: 'https://t.me/BotFather',
    passos: 'No Telegram, abra a conversa com o @BotFather (o link "Abrir a página", no fim deste texto, leva até lá) e envie /newbot. Ele pede um nome para o bot e depois um nome de usuário, que precisa terminar em "bot". Em seguida ele envia o token: copie e cole aqui. O mesmo token serve para ler e para escrever. Crie um bot só para os agentes: se outro programa também usa este bot, o que um marcar como lido some para o outro. Depois inclua o bot em cada grupo que os agentes vão usar. Em grupo, o bot só vê comandos e respostas a ele. Para ver tudo, faça dele administrador do grupo, ou envie /setprivacy ao @BotFather, desligue o modo de privacidade e inclua o bot de novo no grupo. Em conversa privada, a pessoa precisa escrever ao bot primeiro.',
  },
  base: (c) => {
    if (!TOKEN_BOT.test(String(c.token ?? ''))) throw new ErroAcao('token do bot inválido: cole o token inteiro que o @BotFather enviou');
    return `https://api.telegram.org/bot${c.token}`;
  },
  auth: { tipo: 'nenhuma' },
  erroNoCorpo: (j) => (j?.ok === false ? { mensagem: String(j.description ?? `erro ${j.error_code ?? 'desconhecido'}`), permissao: j.error_code === 401 || j.error_code === 403 } : null),
  quemSou: { caminho: '/getMe', nome: (j) => (j.result?.username ? `@${j.result.username}` : String(j.result?.first_name ?? 'bot do Telegram')), id: (j) => j.result?.id },
  acoes: [
    { id: 'telegram.novidades', descricao: 'lê o que chegou ao bot sem marcar como lido: as mesmas novidades voltam na próxima leitura, as mais antigas primeiro, até 100, e o Telegram guarda por até 24 horas. Para ver além delas, use telegram.marcar_lidas', rotulo: 'lê o que chegou ao bot, sem marcar como lido', risco: 'ler',
      params: { limite: { tipo: 'numero', descricao: 'quantas, até 100 (padrão 100)', padrao: MAX_FILA, max: MAX_FILA }, conversa: { tipo: 'texto', descricao: 'só desta conversa: número ou @nome' }, contem: { tipo: 'texto', descricao: 'só as que têm este texto' } },
      resumo: 'ler as novidades do bot no Telegram', metodo: 'GET', caminho: '/getUpdates',
      antes: async (ctx, a) => {
        // com webhook ligado o Telegram recusa a leitura: melhor dizer o motivo. O endereço do webhook não é mostrado (pode levar segredo).
        const w = await ctx.http('/getWebhookInfo');
        if (w?.result?.url) throw new ErroAcao(SEM_LEITURA);
        return { ...a, limite: Math.max(1, Math.floor(Number(a.limite) || MAX_FILA)), pendentes: w?.result?.pending_update_count };
      },
      consulta: { limit: '{limite}' },
      texto: (j, a) => {
        const todas: any[] = Array.isArray(j.result) ? j.result : [];
        const contem = String(a.contem ?? '').toLowerCase();
        const l = todas.filter((u) => (!a.conversa || daConversa(u, String(a.conversa))) && (!contem || textoDa(u).includes(contem)));
        return `${l.length ? l.map((u) => `- ${linhaNovidade(u)}`).join('\n') : 'nada encontrado'}${avisoDeMais(todas, a)}`;
      } },
    // tira da fila de vez, para qualquer programa, sem como recuperar: na regra é apagar, e sempre pede confirmação
    { id: 'telegram.marcar_lidas', descricao: 'marca como lidas as novidades até a indicada: elas saem da fila do bot de vez, para qualquer programa que use este bot', risco: 'apagar',
      params: { ate_novidade: { tipo: 'numero', obrigatorio: true, descricao: 'número da última novidade já lida (o "novidade" que vem em telegram.novidades)' } },
      resumo: (a) => `Marcar como lidas as novidades do bot no Telegram, até a ${a.ate_novidade}. Elas saem da fila do bot de vez, para qualquer programa que use este bot.`,
      preparar: async (ctx, a) => {
        const { ate, quantas } = await conferirMarcacao(ctx, a.ate_novidade);
        return { detalhe: `${quantas === 1 ? 'Sai' : 'Saem'} da fila do bot: ${novidades(quantas)}`, args: { ...a, ate_novidade: ate } };
      },
      metodo: 'GET', caminho: '/getUpdates',
      antes: async (ctx, a) => {
        const { ate, quantas } = await conferirMarcacao(ctx, a.ate_novidade);
        return { ...a, ate_novidade: ate, offset_telegram: ate + 1, quantas };
      },
      // limit 1: a novidade que vem junto só volta como resposta, sem ser confirmada, e não interessa aqui
      consulta: { offset: '{offset_telegram}', limit: 1 },
      texto: (_j, a) => `${a.quantas === 1 ? 'Marcada como lida' : 'Marcadas como lidas'} ${novidades(Number(a.quantas))}, até a ${a.ate_novidade}.` },
    { id: 'telegram.enviar', descricao: 'envia uma mensagem a uma conversa: o bot precisa estar nela, e numa conversa privada a pessoa precisa ter escrito primeiro', risco: 'enviar',
      params: { conversa: P_CONVERSA, texto: P_TEXTO, silencioso: P_SILENCIOSO },
      resumo: (a) => `Enviar na conversa ${a.conversa} do Telegram${semSom(a)}:\n${a.texto}`, metodo: 'POST', caminho: '/sendMessage',
      preparar: async (ctx, a) => {
        envioCabe(a);
        const { id, rotulo } = await conversaDoCartao(ctx, a);
        return { detalhe: `Conversa: ${rotulo}`, args: { ...a, conversa: id } };
      },
      antes: async (_ctx, a) => comEnvio(a),
      corpo: { chat_id: '{chat_id}', text: '{texto}', disable_notification: '{silencioso}' }, texto: 'Mensagem enviada (id: {result.message_id}).' },
    { id: 'telegram.responder', descricao: 'responde a uma mensagem de uma conversa', risco: 'enviar',
      params: { conversa: P_CONVERSA, mensagem: { tipo: 'numero', obrigatorio: true, descricao: 'número da mensagem respondida (vem de telegram.novidades)' }, texto: P_TEXTO, silencioso: P_SILENCIOSO },
      resumo: (a) => `Responder à mensagem ${a.mensagem} na conversa ${a.conversa} do Telegram${semSom(a)}:\n${a.texto}`, metodo: 'POST', caminho: '/sendMessage',
      preparar: async (ctx, a) => {
        envioCabe(a);
        const n = Number(a.mensagem);
        if (!Number.isSafeInteger(n) || n < 1) throw new ErroAcao('"mensagem" precisa ser o número da mensagem (vem de telegram.novidades)');
        const { id, rotulo } = await conversaDoCartao(ctx, a);
        return { detalhe: `Conversa: ${rotulo}\n${await citadaDaFila(ctx, id, n)}`, args: { ...a, conversa: id } };
      },
      antes: async (_ctx, a) => {
        const b = comEnvio(a);
        if (!Number.isSafeInteger(a.mensagem) || Number(a.mensagem) < 1) throw new ErroAcao('"mensagem" precisa ser o número da mensagem (vem de telegram.novidades)');
        return b;
      },
      corpo: { chat_id: '{chat_id}', text: '{texto}', reply_parameters: { message_id: '{mensagem}' }, disable_notification: '{silencioso}' }, texto: 'Resposta enviada (id: {result.message_id}).' },
  ],
};
