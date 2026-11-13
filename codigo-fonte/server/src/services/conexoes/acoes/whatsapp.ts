/**
 * WhatsApp para os agentes: achar uma conversa, ler o que está guardado e enviar texto. Aqui não há HTTP nem endereço:
 * tudo passa por WhatsAppReader (services/whatsapp.ts), que tem o socket, o banco e os filtros de privacidade.
 *
 * Forma de sendMessage e do jid conferida no @whiskeysockets/baileys 7.0.0-rc14 instalado: lib/Socket/messages-send.js,
 * lib/WABinary/jid-utils.js e README ("Whatsapp IDs Explain", "Sending Messages").
 * Risco de bloqueio do número ao usar cliente não oficial:
 *   https://faq.whatsapp.com/1217634902127718 (apps não oficiais), https://faq.whatsapp.com/1848531392146538 (banimento
 *   temporário), https://faq.whatsapp.com/717472490411581 (conta restrita), https://faq.whatsapp.com/361005896189245
 *   (uso responsável), https://www.whatsapp.com/legal/terms-of-service, https://www.whatsapp.com/legal/messaging-guidelines
 */
import { fold } from '../../../lib/util.ts';
import { localParts } from '../../routine-time.ts';
import { neutral } from '../../operations.ts';
import { jidDeConversa, type MensagemGuardada } from '../../whatsapp.ts';
import { ErroAcao, num, precisa, txt, type Acao, type Args } from '../tipos.ts';

export interface WhatsAppDasAcoes {
  /** conta: qual dos números do WhatsApp ('' ou ausente = o principal) */
  enviar(ws: string, jid: string, texto: string, conta?: string): Promise<string>;
  /** só as conversas fora das exceções (o leitor já tira) */
  conversas(ws: string, conta?: string): Array<{ jid: string; nome: string; salvo?: boolean }>;
  /** recusa com ErroAcao o que os filtros não permitem */
  mensagens(ws: string, jid: string, limite: number, conta?: string): Promise<MensagemGuardada[]>;
}

/** Teto nosso, não do WhatsApp: o cartão de confirmação e o registro cortam o resumo em 6000, e o texto tem de caber inteiro. */
const TEXTO_MAX = 4096;
const OPCOES_MAX = 20;
const NUMERO = /^\+?[\d\s().-]{8,}$/;
const LEITOR_LIMITADO = 'O sistema só guarda mensagens recebidas depois de conectar, até 500 caracteres cada, e não guarda o que foi enviado daqui.';
const LISTA_PARCIAL = 'A lista só tem quem já apareceu depois de conectar, não a agenda inteira: pode faltar gente.';

const cru = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const grupo = (jid: string) => jid.endsWith('@g.us');
const rotulo = (c: { jid: string; nome: string }) => `${neutral(c.nome)} (${c.jid})`;
const dois = (n: number) => String(n).padStart(2, '0');

function quando(tz: string, iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const p = localParts(tz, ms);
  return `${dois(p.d)}/${dois(p.m)}/${p.y} ${dois(p.hh)}:${dois(p.mm)} · `;
}

/**
 * Do que o agente disse (jid, número ou nome) para uma conversa. Nome vale inteiro, sem acento nem diferença de maiúsculas.
 * `aceitaParecida`: para ler, basta uma única parecida. Para enviar, não: a lista é parcial, e "João" não pode virar
 * "João da Padaria" num envio que ninguém desfaz.
 */
function escolher(wa: WhatsAppDasAcoes, ctx: { workspaceId: string; conta?: string }, termo: string, aceitaParecida: boolean): { jid: string; nome: string; conhecida: boolean } {
  const lista = wa.conversas(ctx.workspaceId, ctx.conta);
  if (termo.includes('@')) {
    if (!jidDeConversa(termo)) throw new ErroAcao(`"${neutral(termo)}" não é uma conversa do WhatsApp: use o nome, ou um jid como 5511999990000@s.whatsapp.net ou 123456789@g.us`);
    const achada = lista.find((c) => c.jid === termo);
    return { jid: termo, nome: achada?.nome ?? termo, conhecida: !!achada };
  }
  const nome = fold(termo);
  const digitos = NUMERO.test(termo) ? termo.replace(/\D/g, '') : null;
  const exatas = lista.filter((c) => fold(c.nome) === nome || (digitos && c.jid.split('@')[0] === digitos));
  if (exatas.length === 1) return { ...exatas[0], conhecida: true };
  const opcoes = (l: typeof lista) => l.slice(0, OPCOES_MAX).map(rotulo);
  if (exatas.length > 1) throw new ErroAcao(`há mais de uma conversa "${neutral(termo)}". Escolha uma e passe o jid dela`, opcoes(exatas));
  const parecidas = lista.filter((c) => fold(c.nome).includes(nome));
  if (aceitaParecida && parecidas.length === 1) return { ...parecidas[0], conhecida: true };
  if (parecidas.length) throw new ErroAcao(`não há conversa com o nome exato "${neutral(termo)}". Pergunte à pessoa qual destas é e passe o jid dela`, opcoes(parecidas));
  throw new ErroAcao(`não encontrei a conversa "${neutral(termo)}". ${LISTA_PARCIAL} Peça o número à pessoa e passe o jid (DDI, DDD e número, sem sinais, seguidos de @s.whatsapp.net)`);
}

function textoDe(a: Args): string {
  const t = cru(a.texto);
  if (!t) throw new ErroAcao('falta "texto"');
  if (t.length > TEXTO_MAX) throw new ErroAcao(`o texto tem ${t.length} caracteres e o limite aqui é ${TEXTO_MAX}: encurte ou divida (nada foi enviado)`);
  return t;
}

export function acoesWhatsApp(wa: WhatsAppDasAcoes): Acao[] {
  return [
    {
      id: 'whatsapp.conversas',
      descricao: 'Lista as conversas conhecidas do WhatsApp, com nome e jid', rotulo: 'Lista as conversas conhecidas do WhatsApp',
      risco: 'ler',
      params: {
        busca: { tipo: 'texto', descricao: 'parte do nome ou do número' },
        limite: { tipo: 'numero', descricao: 'quantas no máximo; padrão 50, até 200' },
      },
      resumo: (a) => `Listar as conversas do WhatsApp${cru(a.busca) ? ` com "${cru(a.busca)}"` : ''}`,
      async run(ctx, a) {
        const busca = fold(txt(a, 'busca', 200)?.trim() ?? '');
        const limite = num(a, 'limite', 50, 200);
        const todas = wa.conversas(ctx.workspaceId, ctx.conta).filter((c) => fold(`${c.nome} ${c.jid}`).includes(busca)).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
        const linhas = todas.slice(0, limite).map((c) => `- ${rotulo(c)}${grupo(c.jid) ? ' · grupo' : ''}`);
        const topo = todas.length > limite ? `Mostrando ${limite} de ${todas.length} conversas.` : `${todas.length} conversa(s).`;
        return { texto: [`${topo} ${LISTA_PARCIAL}`, ...linhas].join('\n'), deFora: true, privado: true };
      },
    },
    {
      id: 'whatsapp.ler',
      descricao: 'Lê as mensagens guardadas de uma conversa do WhatsApp',
      risco: 'ler',
      params: {
        conversa: { tipo: 'texto', obrigatorio: true, descricao: 'nome da conversa ou jid' },
        limite: { tipo: 'numero', descricao: 'quantas das mais recentes; padrão 20, até 100' },
      },
      resumo: (a) => `Ler as mensagens guardadas da conversa "${cru(a.conversa)}" no WhatsApp`,
      async run(ctx, a) {
        const c = escolher(wa, ctx, precisa(a, 'conversa', 200), true);
        const msgs = await wa.mensagens(ctx.workspaceId, c.jid, num(a, 'limite', 20, 100), ctx.conta);
        const topo = msgs.length ? `${msgs.length} mensagem(ns) recebida(s) de ${rotulo(c)}, da mais antiga para a mais nova.` : `Nenhuma mensagem guardada de ${rotulo(c)}.`;
        const linhas = [...msgs].reverse().map((m) => `- ${quando(ctx.tz, m.em)}${neutral(m.autor ?? 'desconhecido')}: "${neutral(m.texto, 500)}"`);
        return { texto: [`${topo} ${LEITOR_LIMITADO}`, ...linhas].join('\n'), deFora: true, privado: true };
      },
    },
    {
      id: 'whatsapp.enviar',
      descricao: 'Envia uma mensagem de texto no WhatsApp, da conta da pessoa, a uma pessoa ou a um grupo',
      risco: 'enviar',
      params: {
        conversa: { tipo: 'texto', obrigatorio: true, descricao: 'nome exato da conversa, número ou jid; não precisa listar as conversas antes' },
        texto: { tipo: 'texto', obrigatorio: true, descricao: `a mensagem inteira, até ${TEXTO_MAX} caracteres` },
      },
      resumo: (a) => `Enviar pelo WhatsApp, da sua conta, para "${cru(a.conversa)}" a mensagem: "${cru(a.texto)}"`,
      // o destino sai daqui, fixado: o cartão mostra nome e número, e o clique envia àquele número
      async preparar(ctx, a) {
        textoDe(a);
        const termo = precisa(a, 'conversa', 200);
        const c = escolher(wa, ctx, termo, false);
        const porNome = !termo.includes('@') && !NUMERO.test(termo);
        const salvo = wa.conversas(ctx.workspaceId, ctx.conta).find((x) => x.jid === c.jid)?.salvo === true;
        return { args: { ...a, conversa: c.jid }, detalhe: `Para: ${neutral(c.nome)} (${grupo(c.jid) ? 'grupo' : `número ${c.jid.split('@')[0]}`})`,
          confirmar: porNome && !salvo ? 'o nome desta conversa não vem da sua agenda: quem escreve escolhe o próprio nome' : undefined };
      },
      async run(ctx, a) {
        const texto = textoDe(a);
        const termo = precisa(a, 'conversa', 200);
        const c = escolher(wa, ctx, termo, false);
        const id = await wa.enviar(ctx.workspaceId, c.jid, texto, ctx.conta);
        // só o que o agente passou e o que o sistema sabe: o nome salvo no contato é de terceiros e não volta aqui
        const aviso = c.conhecida ? '' : ' Esta conversa ainda não tinha aparecido por aqui: confira no celular se chegou.';
        return { texto: `Mensagem enviada para "${neutral(termo)}" (${c.jid})${id ? `, id ${id}` : ''}. O sistema não recebe confirmação de entrega.${aviso}` };
      },
    },
  ];
}
