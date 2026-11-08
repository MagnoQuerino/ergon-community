/**
 * Google: o que os agentes fazem na conta (Gmail, Agenda, Drive e Contatos), com os mesmos ids e parâmetros da Microsoft.
 * `ctx.http` já vem autenticado; endereços são fixos aqui, nenhum vem do modelo; o cursor de página é o nextPageToken, que
 * só entra codificado no endereço fixo. Texto de outras pessoas sai por neutral() e marcado deFora/privado.
 *
 * Permissões, por ação. As de leitura são as que a conta já autoriza hoje: quem conectou antes segue lendo e só precisa
 * autorizar de novo para escrever. `gmail.modify` já contém leitura, rascunho, envio, marcadores e lixeira, sem apagar de vez.
 *
 * Referências (conferidas em 05/11/2026):
 *   Gmail: https://developers.google.com/workspace/gmail/api/auth/scopes (classes das permissões)
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages (Message, MessagePart)
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments (MessagePartBody)
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/get
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 *     https://developers.google.com/workspace/gmail/api/guides/filtering (datas em segundos, fora do fuso do Pacífico)
 *     https://developers.google.com/workspace/gmail/api/guides/labels (SPAM e TRASH aplicáveis à mão)
 *     https://developers.google.com/workspace/gmail/api/guides/threads (threadId, In-Reply-To, References, Subject)
 *     https://developers.google.com/workspace/gmail/api/guides/sending (raw em base64url)
 *     https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/get (format, cabeçalhos do rascunho)
 *     https://support.google.com/mail/answer/7190 (operadores de busca)
 *   Agenda: https://developers.google.com/workspace/calendar/api/auth
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events (start, end exclusivo, attendees)
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/list
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/get
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/insert (sendUpdates)
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/patch (lista enviada substitui a anterior)
 *     https://developers.google.com/workspace/calendar/api/v3/reference/events/delete
 *     https://developers.google.com/workspace/calendar/api/v3/reference/calendarList
 *     https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
 *     https://developers.google.com/workspace/calendar/api/guides/create-events (reunião do Google Meet)
 *   Drive: https://developers.google.com/workspace/drive/api/guides/api-specific-auth (classes das permissões)
 *     https://developers.google.com/workspace/drive/api/reference/rest/v3/files (campos do arquivo)
 *     https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
 *     https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
 *     https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export (teto de 10 MB)
 *     https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create
 *     https://developers.google.com/workspace/drive/api/guides/manage-uploads (multipart até 5 MB)
 *     https://developers.google.com/workspace/drive/api/guides/manage-downloads (capabilities.canDownload)
 *     https://developers.google.com/workspace/drive/api/guides/ref-export-formats
 *     https://developers.google.com/workspace/drive/api/guides/search-files (como escapar o texto)
 *     https://developers.google.com/workspace/drive/api/guides/ref-search-terms (fullText)
 *     https://developers.google.com/workspace/drive/api/guides/handle-errors
 *   Pessoas: https://developers.google.com/people/api/rest/v1/people/searchContacts
 *     https://developers.google.com/people/api/rest/v1/otherContacts/search
 *     https://developers.google.com/people/api/rest/v1/people/searchDirectoryPeople
 *     https://developers.google.com/people/api/rest/v1/SearchResponse
 *     https://developers.google.com/people/api/rest/v1/DirectorySourceType
 *     https://developers.google.com/people/v1/contacts (aquecer a busca)
 *   Permissões: https://developers.google.com/identity/protocols/oauth2/scopes
 *     https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
 *     https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
 */
import crypto from 'node:crypto';
import { NetworkFailure, fetchWithPolicy, retryHint } from '../../../lib/http.ts';
import { fold } from '../../../lib/util.ts';
import { readDocument } from '../../doc-isolated.ts';
import { sheetText, xmlText, type DocText } from '../../doc-text.ts';
import { validDue } from '../../due.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { localParts, validTz, zonedToUtc } from '../../routine-time.ts';
import { ESCOPO_TAREFAS } from '../escrita/google.ts';
import { caber, htmlParaTexto, marcaDe, semControle } from '../texto.ts';
import { ErroAcao, emails, lista, num, precisa, seg, txt, type Acao, type Args, type CtxAcao, type Http, type Param, type Resultado } from '../tipos.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AGENDA = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_ENVIO = 'https://www.googleapis.com/upload/drive/v3';
const PESSOAS = 'https://people.googleapis.com/v1';

const permissao = (s: string) => `https://www.googleapis.com/auth/${s}`;
const LER_EMAIL = [permissao('gmail.readonly')];
const MEXER_EMAIL = [permissao('gmail.modify')];
const LER_AGENDA = [permissao('calendar.readonly')];
/** `calendar.events` não lista calendários: achar um calendário pelo nome usa a leitura */
const MEXER_AGENDA = [permissao('calendar.events'), permissao('calendar.readonly')];
const LER_DRIVE = [permissao('drive.readonly')];
const CRIAR_DRIVE = [permissao('drive.file')];
const LER_PESSOAS = [permissao('contacts.readonly')];
/** Ampliam a busca de pessoas, mas sem elas a ação funciona com o que tem (conta pessoal não tem diretório). */
const PESSOAS_OPCIONAIS = [permissao('contacts.other.readonly'), permissao('directory.readonly')];

const DIA_MS = 86_400_000;
const MAX_EMAIL_LIDO = 12_000;
const MAX_DOC = 20_000;
const MAX_ASSUNTO = 255;
const MAX_EMAIL = 100_000;
const MAX_DESCRICAO = 8_000;
/** acima disto, o cartão diz o tamanho do rascunho antes do texto: o cartão leva o texto inteiro, mas a tela recolhe texto longo, e o fim passa fácil sem ser lido */
const TEXTO_LONGO = 4000;
const TETO_ARQUIVO = 15 * 1024 * 1024;
/** a documentação indica o envio multipart para arquivos de até 5 MB */
const TETO_ENVIO = 5 * 1024 * 1024;
const AQUECE_MS = 10 * 60_000;
const ESPERA_CACHE_MS = 3000;

const enc = encodeURIComponent;
const sim = (a: Args, k: string): boolean => a[k] === true || a[k] === 1 || (typeof a[k] === 'string' && /^(true|sim|1)$/i.test(a[k].trim()));
/** leitura sem erro, para o cartão de confirmação: o resumo nunca lança */
const s = (a: Args, k: string): string => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
const emLista = (a: Args, k: string): string => lista(a, k, 100).join(', ');
/** No cartão de confirmação: texto de outra pessoa não cria linha nem imita o que vem depois. */
const noCartao = (v: unknown, max = 200): string => neutral(semControle(v), max);
/** Conteúdo da conta escrito por outras pessoas: é dado, nunca instrução. */
const lido = (texto: string, url?: string | null): Resultado => ({ texto, deFora: true, privado: true, url: url ?? null });
/** Texto obrigatório inteiro: o que vai sair em nome da pessoa não é cortado às escondidas. */
const inteiro = (a: Args, k: string, max: number): string => {
  const v = txt(a, k, max + 1);
  if (!v?.trim()) throw new ErroAcao(`falta "${k}"`);
  if (v.length > max) throw new ErroAcao(`"${k}" passou de ${max} caracteres: nada foi feito; encurte o texto`);
  return v;
};
const opcional = (a: Args, k: string, max: number): string | undefined => (txt(a, k) === undefined ? undefined : inteiro(a, k, max));
const quando = (v: string | number, tz: string): string => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(t) : '';
};
const cursorDe = (a: Args): string | undefined => {
  const c = txt(a, 'cursor', 4096)?.trim();
  if (c && /\s|:\/\//.test(c)) throw new ErroAcao('"cursor" inválido: use exatamente o valor devolvido pela chamada anterior');
  return c || undefined;
};
const haMais = (j: any): string => (j?.nextPageToken ? `\nHá mais resultados: repita os mesmos parâmetros com cursor="${String(j.nextPageToken)}".` : '');

// --------------------------------------------------------------------------------------------- bytes (arquivos)
export interface RespostaBytes { data: Buffer; mime: string }
export type HttpBytes = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Buffer; kind?: 'read' | 'write'; teto?: number }) => Promise<RespostaBytes>;
/**
 * `Http` fala JSON: request() passa o corpo por JSON.stringify e a resposta por JSON.parse. Baixar do Drive e enviar multipart
 * precisam de bytes (o Google não tem endereço pré-autenticado), por isso `ctx.http.bytes`. Sem ele, arquivos.ler e
 * arquivos.criar dizem isso antes de chamar qualquer coisa.
 */
export type HttpComBytes = Http & { bytes?: HttpBytes };

const bytesDe = (ctx: CtxAcao): HttpBytes => {
  const b = (ctx.http as HttpComBytes).bytes;
  if (!b) throw new ErroAcao('ler e criar arquivos do Drive ainda não está ligado nesta versão; nada foi feito');
  return b;
};

async function erroDoServico(res: Response): Promise<ProviderError> {
  let motivo = ''; let razao = '';
  try {
    const e = JSON.parse(await res.text())?.error;
    razao = String(e?.errors?.[0]?.reason ?? '');
    motivo = String(e?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
  } catch { /* sem detalhe */ }
  const porque = motivo ? ` (${motivo})` : '';
  const status = res.status;
  // recusa do arquivo, não da conta: autorizar de novo não resolveria
  if (status === 403 && /SizeLimit|NotDownloadable|Abusive/i.test(razao)) return new ProviderError('unavailable', `o Google não entrega este arquivo${porque}`, { status });
  if (status === 401 || status === 403) return new ProviderError('forbidden', `acesso recusado pelo serviço (credencial inválida, expirada ou sem permissão)${porque}`, { status });
  if (status === 404) return new ProviderError('not_found', `não encontrado (ou sem acesso)${porque}`, { status });
  if (status === 429) return new ProviderError('unavailable', `limite de uso do serviço atingido; ${retryHint(res)}`);
  return new ProviderError('unavailable', `o serviço respondeu ${status}${porque}`, { status });
}

/** Lê a resposta parando no teto: um arquivo enorme nunca chega inteiro à memória. */
async function corpoComTeto(res: Response, teto: number): Promise<Buffer> {
  const grande = () => new ErroAcao(`arquivo grande demais (mais de ${Math.round(teto / 1024 / 1024)} MB): nada foi lido`);
  if (Number(res.headers.get('content-length') ?? 0) > teto) { await res.body?.cancel().catch(() => undefined); throw grande(); }
  const pedacos: Uint8Array[] = []; let total = 0;
  const leitor = res.body?.getReader();
  while (leitor) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.length;
    if (total > teto) { await leitor.cancel().catch(() => undefined); throw grande(); }
    pedacos.push(value);
  }
  return Buffer.concat(pedacos);
}

/**
 * O caminho de bytes de `ctx.http`, com a mesma política de request(): leitura repete o que é passageiro, escrita não repete
 * às cegas, erros viram ProviderError. O token nunca sai do endereço pedido: o fetch tira a credencial em redirecionamento
 * para outro domínio. Ligar em servico.ts: Object.assign(http, { bytes: transporteBytes((renovar) => sso.accessToken(ws, kind, { force: renovar })) }).
 */
export function transporteBytes(token: (renovar: boolean) => Promise<string>): HttpBytes {
  return async (url, init = {}) => {
    const chama = async (renovar: boolean): Promise<Response> => {
      const t = await token(renovar);
      try {
        return await fetchWithPolicy(() => fetch(url, { method: init.method ?? 'GET', headers: { ...init.headers, Authorization: `Bearer ${t}` }, body: init.body ? new Uint8Array(init.body) : undefined, signal: AbortSignal.timeout(60_000) }), { kind: init.kind ?? 'read', budgetMs: 90_000 });
      } catch (e) {
        throw new ProviderError('unavailable', e instanceof NetworkFailure && e.unknownOutcome ? 'o serviço não confirmou (pode ter feito ou não): confira lá antes de repetir' : 'o serviço não respondeu');
      }
    };
    let res = await chama(false);
    if (res.status === 401) { // 401: o serviço não fez nada, repetir é seguro
      await res.body?.cancel().catch(() => undefined);
      res = await chama(true);
    }
    if (!res.ok) throw await erroDoServico(res);
    return { data: await corpoComTeto(res, init.teto ?? TETO_ARQUIVO), mime: res.headers.get('content-type') ?? '' };
  };
}

// ---------------------------------------------------------------------------------------------- marcadores
/** Os mesmos nomes de uso diário que a Microsoft aceita, no id de marcador do sistema do Gmail. */
const MARCADOR_CONHECIDO: Record<string, string> = {
  inbox: 'INBOX', entrada: 'INBOX', 'caixa de entrada': 'INBOX', sent: 'SENT', sentitems: 'SENT', enviados: 'SENT', enviadas: 'SENT', 'itens enviados': 'SENT',
  draft: 'DRAFT', drafts: 'DRAFT', rascunho: 'DRAFT', rascunhos: 'DRAFT', trash: 'TRASH', deleteditems: 'TRASH', lixeira: 'TRASH', excluidos: 'TRASH', 'itens excluidos': 'TRASH',
  spam: 'SPAM', junkemail: 'SPAM', 'lixo eletronico': 'SPAM',
};
const ARQUIVO = new Set(['archive', 'arquivo', 'arquivar', 'arquivados', 'arquivo morto']);
interface Marcador { id: string; nome: string; doUsuario: boolean }

/** `exato`, para escrever: procurar pode acertar por aproximação; mover para um marcador que a pessoa não nomeou, não. */
async function marcadorDe(ctx: CtxAcao, valor: string, exato = false): Promise<Marcador> {
  const v = valor.trim(); const f = fold(v);
  if (MARCADOR_CONHECIDO[f]) return { id: MARCADOR_CONHECIDO[f], nome: v, doUsuario: false };
  const todos = ((await ctx.http(`${GMAIL}/labels`)).labels ?? []) as any[];
  const nome = (l: any) => String(l?.name ?? '');
  const porId = todos.filter((l) => String(l.id) === v);
  const certo = porId.length ? porId : todos.filter((l) => fold(nome(l)) === f);
  const parecido = certo.length ? certo : todos.filter((l) => fold(nome(l)).includes(f));
  if (exato && certo.length !== 1) {
    if (certo.length) throw new ErroAcao(`mais de um marcador chamado "${neutral(v, 60)}": use o id`, certo.map((l) => `${neutral(nome(l), 80)} (${neutral(String(l.id), 80)})`));
    throw new ErroAcao(`não achei o marcador "${neutral(v, 60)}": diga o nome exato ou o id`, (parecido.length ? parecido : todos).map((l) => neutral(nome(l), 80)));
  }
  if (parecido.length !== 1) throw new ErroAcao(parecido.length ? `mais de um marcador parecido com "${neutral(v, 60)}"` : `não achei o marcador "${neutral(v, 60)}"`, (parecido.length ? parecido : todos).map((l) => neutral(nome(l), 80)));
  return { id: String(parecido[0].id), nome: nome(parecido[0]), doUsuario: parecido[0].type === 'user' };
}
/** Para onde email.mover pode levar: o marcador, ou arquivar (null). Lixeira, spam e os que o próprio Gmail põe ficam de fora. */
async function destinoDeMover(ctx: CtxAcao, alvo: string): Promise<Marcador | null> {
  if (ARQUIVO.has(fold(alvo))) return null;
  const m = await marcadorDe(ctx, alvo, true);
  // lixeira e spam se apagam sozinhos com o tempo: apagar sempre pede confirmação, e mover (que não pede) não pode ser o atalho
  if (m.id === 'TRASH' || m.id === 'SPAM') throw new ErroAcao('mandar para a lixeira ou para o spam é apagar: use email.apagar, que pede confirmação; nada foi feito');
  if (m.id === 'SENT' || m.id === 'DRAFT') throw new ErroAcao(`o próprio Gmail põe o marcador "${m.id}": não dá para mover para lá; nada foi feito`);
  return m;
}

// ---------------------------------------------------------------------------------------------- ler e-mail
const cabecalho = (parte: any, nome: string): string => String(((parte?.headers ?? []) as any[]).find((h) => String(h?.name).toLowerCase() === nome)?.value ?? '');

/** A API não diz em que codificação vem o corpo: tenta UTF-8 e, se não for, o charset declarado na parte. */
function decodificar(parte: any): string {
  const b = Buffer.from(String(parte?.body?.data ?? ''), 'base64url');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* não é UTF-8 */ }
  const charset = /charset="?([\w.:-]+)/i.exec(cabecalho(parte, 'content-type'))?.[1];
  try { return new TextDecoder(charset ?? 'latin1').decode(b); } catch { return b.toString('latin1'); }
}

/** O corpo em texto puro e em HTML, e os nomes dos anexos. */
function partesDoEmail(raiz: any): { plano: string; html: string; anexos: string[] } {
  const planos: string[] = []; const htmls: string[] = []; const anexos: string[] = [];
  const andar = (p: any, fundo: number) => {
    if (!p || fundo > 20) return;
    const nome = String(p.filename ?? '').trim();
    if (nome || /^attachment/i.test(cabecalho(p, 'content-disposition'))) { anexos.push(nome || '(sem nome)'); return; }
    const mime = String(p.mimeType ?? '').toLowerCase();
    if (p.body?.data && mime === 'text/plain') planos.push(decodificar(p));
    else if (p.body?.data && mime === 'text/html') htmls.push(decodificar(p));
    for (const f of (p.parts ?? []) as any[]) andar(f, fundo + 1);
  };
  andar(raiz, 0);
  return { plano: planos.join('\n').trim(), html: htmls.join('\n'), anexos };
}

// ---------------------------------------------------------------------------------------------- escrever e-mail
const semQuebra = (v: string) => v.replace(/[\r\n\0\x85\p{Zl}\p{Zp}]+/gu, ' ').trim();

/**
 * Valor de cabeçalho: sem CR/LF (nada de cabeçalho a mais) e, com acento, em RFC 2047. Cada palavra codificada fica em
 * até 64 caracteres, com a linha em até 76 mesmo depois de "Subject: ", e nunca parte um caractere no meio.
 */
function rfc2047(valor: string): string {
  const v = semQuebra(valor);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const pedacos: string[] = []; let atual = '';
  for (const ch of v) {
    if (Buffer.byteLength(atual + ch) > 39) { pedacos.push(atual); atual = ch; } else atual += ch;
  }
  if (atual) pedacos.push(atual);
  return pedacos.map((p) => `=?UTF-8?B?${Buffer.from(p, 'utf8').toString('base64')}?=`).join('\r\n ');
}

interface Mensagem { de?: string; para: string[]; cc: string[]; assunto: string; texto: string; responde?: string; referencias?: string[] }

/** MIME montado à mão, só com ASCII: endereços conferidos, assunto em RFC 2047, corpo em base64. Devolve o `raw` da API. */
function montarRaw(m: Mensagem): string {
  const linhas = [
    ...(m.de ? [`From: ${m.de}`] : []), ...(m.para.length ? [`To: ${m.para.join(', ')}`] : []), ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${rfc2047(m.assunto)}`,
    ...(m.responde ? [`In-Reply-To: ${m.responde}`] : []), ...(m.referencias?.length ? [`References: ${m.referencias.join('\r\n ')}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  const corpo = Buffer.from(m.texto, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${linhas.join('\r\n')}\r\n\r\n${corpo}`, 'utf8').toString('base64url');
}

/** Endereços ditos pelo agente: conferidos, e só ASCII (o cabeçalho não leva acento em endereço). Nunca perde nome além do teto. */
const enderecos = (a: Args, k: string, teto = 100): string[] => {
  if (lista(a, k, teto + 1).length > teto) throw new ErroAcao(`"${k}" tem mais de ${teto} endereços: nada foi feito`);
  const l = emails(a, k, teto);
  for (const e of l) if (!/^[\x21-\x7e]+$/.test(e)) throw new ErroAcao(`"${e}" tem acento ou caractere especial: o envio não aceita esse endereço`);
  return l;
};
const ehEndereco = (e: string): boolean => { try { return enderecos({ e }, 'e').length === 1; } catch { return false; } };
/**
 * Endereços de um cabeçalho: nomes entre aspas podem ter vírgula e @. `duvidosos`: o que parece destinatário e não deu para
 * ler com certeza. Ao responder, os endereços são nossos e o resto fica de fora; num rascunho pronto, é o Gmail quem lê o
 * cabeçalho: quem chama precisa recusar, ou o cartão mostraria menos gente do que recebe.
 */
function lerEnderecos(h: string): { enderecos: string[]; duvidosos: string[] } {
  const sem = h.slice(0, 20_000).replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  const enderecos: string[] = []; const duvidosos: string[] = h.length > 20_000 ? ['(lista longa demais)'] : [];
  for (const parte of sem.split(/[,;]/)) {
    const m = /<([^<>\s]+)>/.exec(parte) ?? /([^\s<>()]+@[^\s<>()]+)/.exec(parte);
    const arrobas = parte.split('@').length - 1;
    if (m && ehEndereco(m[1])) {
      if (!enderecos.some((x) => x.toLowerCase() === m[1].toLowerCase())) enderecos.push(m[1]);
      if (arrobas > 1) duvidosos.push(parte.trim());
    } else if (arrobas > 0) duvidosos.push(parte.trim());
  }
  return { enderecos, duvidosos };
}
const enderecosDoCabecalho = (h: string): string[] => lerEnderecos(h).enderecos;
/** O endereço da própria conta, para o From (a API pede RFC 2822 e todos os exemplos oficiais o trazem). */
const minhaConta = async (ctx: CtxAcao): Promise<string> => String((await ctx.http(`${GMAIL}/profile`))?.emailAddress ?? '');
/** Confere tudo antes de chamar qualquer coisa; só depois pergunta quem é a conta. */
async function novaMensagem(ctx: CtxAcao, a: Args, exigeDestino: boolean): Promise<Mensagem> {
  const para = enderecos(a, 'para');
  if (exigeDestino && !para.length) throw new ErroAcao('falta "para"');
  const m = { para, cc: enderecos(a, 'cc'), assunto: inteiro(a, 'assunto', MAX_ASSUNTO), texto: inteiro(a, 'texto', MAX_EMAIL) };
  const de = await minhaConta(ctx);
  return { ...m, ...(ehEndereco(de) ? { de } : {}) };
}

const ID_MENSAGEM = /<[\x21-\x3b\x3d\x3f-\x7e]+>/g;

/** A resposta a um e-mail: para a conversa a aceitar, threadId, In-Reply-To, References e o mesmo assunto (guia de conversas). */
async function resposta(ctx: CtxAcao, a: Args): Promise<{ msg: Mensagem; conversa: string | null; original: { de: string; assunto: string; quando: string }; desviada: boolean }> {
  const texto = inteiro(a, 'texto', MAX_EMAIL);
  const [m, conta] = await Promise.all([ctx.http(`${GMAIL}/messages/${seg(precisa(a, 'id', 500))}?format=metadata&fields=id,threadId,internalDate,payload/headers`), minhaConta(ctx)]);
  const h = (n: string) => cabecalho(m.payload, n);
  const eu = conta.toLowerCase();
  const naoSouEu = (e: string) => e.toLowerCase() !== eu;
  const pedido = enderecosDoCabecalho(h('reply-to'));
  const remetente = pedido.length ? pedido : enderecosDoCabecalho(h('from'));
  const destinos = enderecosDoCabecalho(h('to'));
  // e-mail que a própria conta mandou: a resposta segue para quem o recebeu
  let para = remetente.filter(naoSouEu);
  if (!para.length) para = destinos.filter(naoSouEu);
  if (!para.length) para = remetente;
  if (!para.length) throw new ErroAcao('não achei para quem responder neste e-mail: use email.enviar dizendo o destinatário');
  const jaVai = new Set(para.map((e) => e.toLowerCase()));
  const cc = sim(a, 'todos') ? [...destinos, ...enderecosDoCabecalho(h('cc'))].filter((e) => naoSouEu(e) && !jaVai.has(e.toLowerCase())) : [];
  const original = semQuebra(h('subject')).slice(0, 900);
  const responde = h('message-id').match(ID_MENSAGEM)?.[0];
  const autores = new Set(enderecosDoCabecalho(h('from')).map((e) => e.toLowerCase()));
  return {
    original: { de: h('from'), assunto: h('subject'), quando: quando(Number(m.internalDate), ctx.tz) },
    desviada: pedido.some((e) => !autores.has(e.toLowerCase())),
    msg: { ...(ehEndereco(conta) ? { de: conta } : {}), para, cc: [...new Set(cc)], assunto: /^(re|res)\s*:/i.test(original) ? original : `Re: ${original}`, texto, responde, referencias: [...(h('references').match(ID_MENSAGEM) ?? []), ...(responde ? [responde] : [])].slice(-20) },
    conversa: m.threadId ? String(m.threadId) : null,
  };
}
const destinoDe = (m: Pick<Mensagem, 'para' | 'cc'>): string => `${m.para.map((e) => neutral(e, 120)).join(', ')}${m.cc.length ? ` (cópia: ${m.cc.map((e) => neutral(e, 120)).join(', ')})` : ''}`;
const sobreEmail = (verbo: string, a: Args) => `${verbo}${emLista(a, 'para') ? ` para ${emLista(a, 'para')}` : ''}${emLista(a, 'cc') ? `, cópia para ${emLista(a, 'cc')}` : ''}. Assunto: "${semQuebra(s(a, 'assunto'))}". Texto: "${s(a, 'texto')}"`;
/** O cartão de quem responde: no destino, só o endereço (o nome é o remetente quem escolhe). Rascunho não sai, então não obriga confirmar. */
async function cartaoDaResposta(ctx: CtxAcao, a: Args, sai: boolean): Promise<{ detalhe: string; confirmar?: string }> {
  const r = await resposta(ctx, a);
  const detalhe = [
    `A resposta vai para: ${r.msg.para.map((e) => noCartao(e, 120)).join(', ')}.`, ...(r.msg.cc.length ? [`Em cópia: ${r.msg.cc.map((e) => noCartao(e, 120)).join(', ')}.`] : []),
    `Responde ao e-mail "${noCartao(r.original.assunto, 300)}", de ${noCartao(r.original.de, 200)}${r.original.quando ? `, recebido em ${r.original.quando}` : ''}.`,
  ].join('\n');
  return { detalhe, ...(sai && r.desviada ? { confirmar: 'o e-mail pede resposta para outro endereço, diferente de quem o enviou' } : {}) };
}
/** Assunto e remetente, para quem vai apagar ou mover um e-mail que só conhece pelo id. */
async function emailNoCartao(ctx: CtxAcao, id: string): Promise<string> {
  const m = await ctx.http(`${GMAIL}/messages/${seg(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&fields=id,internalDate,payload/headers`);
  const data = quando(Number(m.internalDate), ctx.tz);
  return `E-mail "${noCartao(cabecalho(m.payload, 'subject'), 300)}", de ${noCartao(cabecalho(m.payload, 'from'), 200)}${data ? `, recebido em ${data}` : ''}.`;
}
/**
 * O rascunho como está: destinatários, inclusive cópia oculta, texto e anexos, e a impressão do que foi visto (conferida no clique).
 * Com texto e HTML, mostra o HTML, que é o que aparece para quem recebe.
 */
async function lerRascunho(ctx: CtxAcao, id: string): Promise<{ para: string[]; cc: string[]; oculta: string[]; reais: string[]; assunto: string; corpo: string; anexos: string[]; marca: string }> {
  const m = (await ctx.http(`${GMAIL}/drafts/${seg(id)}?format=full`)).message;
  const h = (n: string) => lerEnderecos(cabecalho(m?.payload, n));
  const [para, cc, oculta] = [h('to'), h('cc'), h('bcc')];
  const duvidosos = [...para.duvidosos, ...cc.duvidosos, ...oculta.duvidosos];
  if (duvidosos.length) throw new ErroAcao('o rascunho tem destinatário que não deu para ler com certeza: nada foi enviado; corrija o rascunho', duvidosos.slice(0, 20).map((e) => noCartao(e, 120)));
  const reais = [...para.enderecos, ...cc.enderecos, ...oculta.enderecos];
  if (!reais.length) throw new ErroAcao('o rascunho não tem destinatário: nada foi enviado');
  const { plano, html, anexos } = partesDoEmail(m?.payload);
  const assunto = cabecalho(m?.payload, 'subject');
  return { para: para.enderecos, cc: cc.enderecos, oculta: oculta.enderecos, reais, assunto, corpo: (html && htmlParaTexto(html)) || plano, anexos, marca: marcaDe([assunto, para.enderecos, cc.enderecos, oculta.enderecos, plano, html, anexos]) };
}
const grupoDeEnderecos = (l: string[]) => [...new Set(l.map((e) => e.toLowerCase()))].sort().join();
const ditosDoRascunho = (a: Args): string[] => {
  const ditos = enderecos(a, 'para');
  if (!ditos.length) throw new ErroAcao('falta "para"');
  return ditos;
};
function conferirDestinatarios(ditos: string[], reais: string[]): void {
  if (grupoDeEnderecos(ditos) !== grupoDeEnderecos(reais)) throw new ErroAcao('"para" não é a lista de destinatários deste rascunho: nada foi enviado; repita dizendo a lista real', reais.slice(0, 100).map((e) => neutral(e, 120)));
}
const sobreResposta = (verbo: string, a: Args) => `${verbo} ${sim(a, 'todos') ? 'a todos do' : 'ao remetente do'} e-mail ${s(a, 'id')}; quem recebe vem do e-mail original. Texto: "${s(a, 'texto')}"`;

// ------------------------------------------------------------------------------------------------------- agenda
const proximoDia = (d: string): string => new Date(Date.parse(`${d}T12:00:00Z`) + DIA_MS).toISOString().slice(0, 10);
const MOMENTO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
interface Momento { dia?: string; hora?: string; deslocamento?: string; ms: number }

/** Dia inteiro (AAAA-MM-DD) ou data e hora, com deslocamento ou no fuso dado. Data inválida é erro: nunca grava errado. */
function momento(v: string, k: string, tz: string): Momento {
  const erro = () => new ErroAcao(`"${k}" precisa estar no formato AAAA-MM-DD ou AAAA-MM-DDTHH:MM`);
  const m = MOMENTO.exec(v.trim());
  if (!m) throw erro();
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  if (!validDue(d)) throw erro();
  const [y, mes, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4]) return { dia: d, ms: zonedToUtc(tz, y, mes, dd, 0, 0) };
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) throw erro();
  const hora = `${d}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  const z = m[7]?.toUpperCase();
  const deslocamento = z && z !== 'Z' && !z.includes(':') ? `${z.slice(0, 3)}:${z.slice(3)}` : z;
  return { hora, deslocamento, ms: deslocamento ? Date.parse(`${hora}${deslocamento}`) : zonedToUtc(tz, y, mes, dd, Number(m[4]), Number(m[5])) + Number(m[6] ?? 0) * 1000 };
}
function fusoDe(ctx: CtxAcao, a: Args): string {
  const f = txt(a, 'fuso', 80)?.trim() || ctx.tz;
  if (!validTz(f)) throw new ErroAcao('"fuso" inválido: use, por exemplo, America/Sao_Paulo');
  return f;
}

/** O `start` e o `end` da API; o fim de um evento de dia inteiro é exclusivo lá (o dia seguinte ao último). */
function periodo(a: Args, tz: string, exigido: boolean): { start: Record<string, string>; end: Record<string, string> } | null {
  const i = txt(a, 'inicio', 40)?.trim(); const f = txt(a, 'fim', 40)?.trim();
  if (!i && !f && !exigido) return null;
  if (!i) throw new ErroAcao(f ? 'para mudar o fim, mande também "inicio"' : 'falta "inicio"');
  const ini = momento(i, 'inicio', tz);
  if (ini.dia) {
    const ult = f ? momento(f, 'fim', tz) : ini;
    if (!ult.dia) throw new ErroAcao('evento de dia inteiro: "fim" é o último dia, no formato AAAA-MM-DD');
    if (ult.dia < ini.dia) throw new ErroAcao('"fim" não pode ser antes de "inicio"');
    return { start: { date: ini.dia }, end: { date: proximoDia(ult.dia) } };
  }
  if (!f) throw new ErroAcao('falta "fim": a hora em que termina (se a pessoa não disse, pergunte)');
  const fim = momento(f, 'fim', tz);
  if (!fim.hora) throw new ErroAcao('"inicio" tem hora, então "fim" também precisa ter: AAAA-MM-DDTHH:MM');
  if (fim.ms <= ini.ms) throw new ErroAcao('"fim" precisa ser depois de "inicio"');
  const lado = (x: Momento): Record<string, string> => (x.deslocamento ? { dateTime: `${x.hora}${x.deslocamento}` } : { dateTime: x.hora!, timeZone: tz });
  return { start: lado(ini), end: lado(fim) };
}

/** Instante de `desde` e `ate`: dia inteiro no fuso da pessoa (`ate` inclui o dia), hora local, ou hora com deslocamento. */
function instante(a: Args, k: string, tz: string, fimDoDia: boolean): number | undefined {
  const v = txt(a, k, 40)?.trim();
  if (!v) return undefined;
  const x = momento(v, k, tz);
  if (!x.dia || !fimDoDia) return x.ms;
  const [y, m, d] = proximoDia(x.dia).split('-').map(Number);
  return zonedToUtc(tz, y, m, d, 0, 0);
}
function intervalo(a: Args, tz: string): { desde?: number; ate?: number } {
  const desde = instante(a, 'desde', tz, false); const ate = instante(a, 'ate', tz, true);
  if (desde !== undefined && ate !== undefined && desde >= ate) throw new ErroAcao('"desde" vem depois de "ate"');
  return { desde, ate };
}

const nomeAgenda = (c: any) => String(c?.summaryOverride ?? c?.summary ?? '');
/** Até cinco páginas da lista de calendários, seguindo o nextPageToken no endereço fixo. */
async function todasAgendas(ctx: CtxAcao): Promise<any[]> {
  const out: any[] = []; let pagina: string | undefined;
  for (let i = 0; i < 5; i++) {
    const j = await ctx.http(`${AGENDA}/users/me/calendarList?maxResults=250${pagina ? `&pageToken=${enc(pagina)}` : ''}`);
    out.push(...((j.items ?? []) as any[]));
    pagina = j.nextPageToken ? String(j.nextPageToken) : undefined;
    if (!pagina) break;
  }
  return out;
}
/** Para ler: calendário pelo id ou pelo nome, por aproximação; sem dizer, o principal. Havendo dúvida, pergunta com as opções. Para escrever, agendaExata. */
async function agendaDe(ctx: CtxAcao, a: Args): Promise<string> {
  const q = txt(a, 'agenda', 400)?.trim();
  if (!q || fold(q) === 'primary' || fold(q) === 'principal') return 'primary';
  if (q.includes('@')) return q;
  const todas = await todasAgendas(ctx);
  const f = fold(q);
  const certo = todas.filter((c) => String(c.id) === q || fold(nomeAgenda(c)) === f);
  const parecido = certo.length ? certo : todas.filter((c) => fold(nomeAgenda(c)).includes(f));
  if (parecido.length === 1) return String(parecido[0].id);
  throw new ErroAcao(parecido.length ? `mais de uma agenda parecida com "${neutral(q, 60)}"` : `não achei a agenda "${neutral(q, 60)}"`, (parecido.length ? parecido : todas).map((c) => neutral(nomeAgenda(c), 80)));
}

/**
 * Calendário numa ação de escrita: nome exato ou id, nunca aproximação nem um endereço fora da lista da conta (um "@" qualquer
 * seria a agenda de outra pessoa). Devolve o nome, para o cartão mostrar em qual agenda a ação cai.
 */
async function agendaExata(ctx: CtxAcao, a: Args): Promise<{ id: string; nome: string | null }> {
  const q = txt(a, 'agenda', 400)?.trim();
  if (!q || fold(q) === 'primary' || fold(q) === 'principal') return { id: 'primary', nome: null };
  const todas = await todasAgendas(ctx);
  const f = fold(q);
  const porId = todas.filter((c) => String(c.id) === q);
  const certo = porId.length ? porId : todas.filter((c) => fold(nomeAgenda(c)) === f);
  if (certo.length === 1) return { id: String(certo[0].id), nome: nomeAgenda(certo[0]) };
  if (certo.length) throw new ErroAcao(`mais de uma agenda chamada "${neutral(q, 60)}": use o id`, certo.map((c) => `${neutral(nomeAgenda(c), 80)} (${neutral(String(c.id), 120)})`));
  const parecido = todas.filter((c) => fold(nomeAgenda(c)).includes(f));
  throw new ErroAcao(`não achei a agenda "${neutral(q, 60)}": diga o nome exato ou o id`, (parecido.length ? parecido : todas).map((c) => neutral(nomeAgenda(c), 80)));
}

function horarioDe(e: any, tz: string): string {
  const dia = e.start?.date ? String(e.start.date) : '';
  const ultimo = e.end?.date ? new Date(Date.parse(`${e.end.date}T12:00:00Z`) - DIA_MS).toISOString().slice(0, 10) : dia;
  return dia ? `${dia}${ultimo > dia ? ` a ${ultimo}` : ''} dia todo` : `${quando(String(e.start?.dateTime), tz)} até ${quando(String(e.end?.dateTime), tz)}`;
}
function linhaEvento(e: any, tz: string): string {
  const horario = horarioDe(e, tz);
  const quem = ((e.attendees ?? []) as any[]).slice(0, 12).map((x) => neutral(String(x.email ?? ''), 80)).join(', ');
  return [
    `- id=${String(e.id)}`, horario, neutral(String(e.summary ?? '(sem título)'), 200), ...(e.location ? [`local: ${neutral(String(e.location), 120)}`] : []), ...(e.hangoutLink ? ['online'] : []),
    ...(e.organizer?.email ? [`organiza: ${neutral(String(e.organizer.email), 120)}`] : []), ...(quem ? [`participantes: ${quem}`] : []), ...(e.description ? [`descrição: ${neutral(htmlParaTexto(String(e.description)), 300)}`] : []),
  ].join(' | ');
}

const convida = (a: Args) => lista(a, 'participantes', 500).length > 0;
const fichaEvento = (ctx: CtxAcao, agenda: string, id: string): Promise<any> => ctx.http(`${AGENDA}/calendars/${seg(agenda)}/events/${seg(id)}?fields=summary,start,end,recurrence,recurringEventId,organizer(email,displayName),attendees(email,displayName,self)`);
const convidadoNoCartao = (x: any): string => { const e = noCartao(x?.email, 120); const n = x?.displayName ? noCartao(x.displayName, 80) : ''; return n && n !== e ? `${n} <${e}>` : e; };
function eventoNoCartao(e: any, tz: string, agenda: string | null): string[] {
  const gente = (e.attendees ?? []) as any[];
  return [
    `Compromisso: "${noCartao(e.summary ?? '(sem título)', 300)}", ${horarioDe(e, tz)}.`, ...(agenda ? [`Agenda: "${noCartao(agenda, 120)}".`] : []), ...(e.organizer?.email ? [`Organiza: ${convidadoNoCartao(e.organizer)}.`] : []),
    gente.length ? `Participantes: ${gente.slice(0, 50).map(convidadoNoCartao).join(', ')}${gente.length > 50 ? ` e mais ${gente.length - 50}` : ''}.` : 'Sem participantes.',
    // cancelar a série apaga todas: o id de agenda.listar é o de uma ocorrência, mas nada obriga o agente a usar esse
    ...(e.recurrence?.length ? ['É uma série: vale para todas as ocorrências.'] : e.recurringEventId ? ['Faz parte de uma série: muda só esta ocorrência.'] : []),
  ];
}
/** O id resolvido fica fixado: o clique cai na mesma agenda que o cartão mostrou. */
const comAgenda = (a: Args, agenda: { id: string; nome: string | null }): { args?: Args } => (agenda.nome ? { args: { ...a, agenda: agenda.id } } : {});
/** Confere a mudança antes de chamar qualquer coisa: o erro aparece antes do cartão, não depois do clique. */
function mudancaDoEvento(ctx: CtxAcao, a: Args): { participantes: string[]; campos: Record<string, unknown>; avisa: boolean } {
  const participantes = enderecos(a, 'participantes');
  const campos = camposEvento(a, fusoDe(ctx, a), false);
  if (!participantes.length && !Object.keys(campos).length) throw new ErroAcao('diga o que mudar: titulo, inicio, fim, local, descricao, participantes ou online');
  return { participantes, campos, avisa: participantes.length > 0 || sim(a, 'avisar_participantes') };
}
/** O risco é decidido só pelos parâmetros: mudança que outras pessoas veem precisa dizer isso, nunca passa por "organizar". */
function exigeAviso(hoje: any[], avisa: boolean): void {
  const outros = hoje.filter((x) => !x.self);
  if (outros.length && !avisa) throw new ErroAcao(`este compromisso tem ${outros.length} participante(s), e a mudança aparece para eles: repita com avisar_participantes=true`, outros.slice(0, 30).map((x) => neutral(String(x.email ?? ''), 120)));
}
const eventoEmTexto = (a: Args): string => [
  s(a, 'inicio') && `de ${s(a, 'inicio')}`, s(a, 'fim') && `até ${s(a, 'fim')}`, s(a, 'fuso') && `(fuso ${s(a, 'fuso')})`, s(a, 'local') && `em "${semQuebra(s(a, 'local'))}"`, sim(a, 'online') && 'reunião online',
  s(a, 'agenda') && `na agenda "${semQuebra(s(a, 'agenda'))}"`, s(a, 'descricao') && `descrição: "${s(a, 'descricao')}"`,
].filter(Boolean).join(', ');
const camposEvento = (a: Args, tz: string, exigeHora: boolean): Record<string, unknown> => {
  const local = txt(a, 'local', 300); const descricao = opcional(a, 'descricao', MAX_DESCRICAO);
  return {
    ...(txt(a, 'titulo') !== undefined ? { summary: semQuebra(inteiro(a, 'titulo', MAX_ASSUNTO)) } : {}), ...periodo(a, tz, exigeHora),
    ...(local !== undefined ? { location: semQuebra(local) } : {}), ...(descricao !== undefined ? { description: descricao } : {}),
    ...(sim(a, 'online') ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
};
const parametrosEvento = (avisa: boolean, a: Args) => `sendUpdates=${avisa ? 'all' : 'none'}${sim(a, 'online') ? '&conferenceDataVersion=1' : ''}`;

// ------------------------------------------------------------------------------------------------------ arquivos
const OFFICE = 'application/vnd.openxmlformats-officedocument';
/** documentos do Google viram os formatos que o leitor de documentos entende */
const EXPORTA: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: `${OFFICE}.wordprocessingml.document`, ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: `${OFFICE}.spreadsheetml.sheet`, ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: `${OFFICE}.presentationml.presentation`, ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
};
const PASTA = 'application/vnd.google-apps.folder';
const ATALHO = 'application/vnd.google-apps.shortcut';
const CAMPOS_ARQUIVO = 'id,name,mimeType,size,webViewLink,shortcutDetails/targetId,capabilities/canDownload';
const TIPOS_DE_TEXTO: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', log: 'text/plain' };

const metaArquivo = (ctx: CtxAcao, id: string) => ctx.http(`${DRIVE}/files/${seg(id)}?fields=${CAMPOS_ARQUIVO}&supportsAllDrives=true`);
const tamanho = (b: unknown): string => {
  const n = Number(b ?? 0);
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

// ------------------------------------------------------------------------------------------------------- pessoas
const MASCARA = 'names,emailAddresses,organizations';
const aquecidos = new Map<string, number>();
const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Contatos, "outros contatos" (quem já trocou e-mail com a conta) e o diretório da empresa; cada origem pode falhar sozinha. */
async function procurarPessoas(ctx: CtxAcao, texto: string, limite: number): Promise<{ achadas: any[]; faltou: string[] }> {
  const q = (mascara: string) => new URLSearchParams({ query: texto, readMask: mascara, pageSize: String(limite) });
  const dir = q(MASCARA);
  dir.append('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE');
  dir.append('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT');
  const origens: Array<[string, () => Promise<any[]>]> = [
    ['contatos', async () => (((await ctx.http(`${PESSOAS}/people:searchContacts?${q(MASCARA)}`)).results ?? []) as any[]).map((r) => r.person)],
    ['outros contatos', async () => (((await ctx.http(`${PESSOAS}/otherContacts:search?${q('names,emailAddresses')}`)).results ?? []) as any[]).map((r) => r.person)],
    ['diretório da empresa', async () => ((await ctx.http(`${PESSOAS}/people:searchDirectoryPeople?${dir}`)).people ?? []) as any[]],
  ];
  const r = await Promise.allSettled(origens.map(([, f]) => f()));
  if (r.every((x) => x.status === 'rejected')) throw (r[0] as PromiseRejectedResult).reason;
  return { achadas: r.flatMap((x) => (x.status === 'fulfilled' ? x.value : [])), faltou: origens.filter((_, i) => r[i].status === 'rejected').map(([n]) => n) };
}

function linhasDePessoas(achadas: any[]): string[] {
  const vistos = new Set<string>(); const out: string[] = [];
  for (const p of achadas) {
    const nome = String(p?.names?.[0]?.displayName ?? '');
    const mails = ((p?.emailAddresses ?? []) as any[]).map((e) => String(e?.value ?? '')).filter(Boolean);
    const chave = (mails[0] ?? nome).toLowerCase();
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    const o = p?.organizations?.[0];
    const onde = [o?.title, o?.name].filter(Boolean).map((x) => neutral(String(x), 80)).join(', ');
    out.push(`- ${neutral(nome || '(sem nome)', 120)}${mails.length ? ` · ${mails.slice(0, 3).map((e) => neutral(e, 120)).join(', ')}` : ''}${onde ? ` · ${onde}` : ''}`);
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------- ações
const P_ID_EMAIL: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do e-mail (vem de email.buscar)' };
const P_PARA: Param = { tipo: 'lista', obrigatorio: true, descricao: 'e-mails de quem recebe; use pessoas.buscar para achar pelo nome' };
const P_CC: Param = { tipo: 'lista', descricao: 'e-mails em cópia' };
const P_ASSUNTO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'assunto' };
const P_TEXTO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'texto, sem formatação' };
const P_TODOS: Param = { tipo: 'booleano', descricao: 'true = responde a todos do e-mail original' };
const P_CURSOR: Param = { tipo: 'texto', descricao: 'continuação devolvida pela chamada anterior' };
const P_AGENDA: Param = { tipo: 'texto', descricao: 'nome ou id da agenda (padrão: a principal)' };
const P_INICIO: Param = { tipo: 'texto', descricao: 'início, AAAA-MM-DDTHH:MM; AAAA-MM-DD = dia inteiro' };
const P_FIM: Param = { tipo: 'texto', descricao: 'fim, AAAA-MM-DDTHH:MM; em dia inteiro, o último dia (sem ele, um dia só)' };
const P_FUSO: Param = { tipo: 'texto', descricao: 'fuso das horas (padrão: o da pessoa), ex.: America/Sao_Paulo' };
const P_LOCAL: Param = { tipo: 'texto', descricao: 'local' };
const P_DESC: Param = { tipo: 'texto', descricao: 'descrição' };
const P_ONLINE: Param = { tipo: 'booleano', descricao: 'true = cria uma reunião do Google Meet' };
const P_ID_EVENTO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do compromisso (vem de agenda.listar)' };

export const ACOES_GOOGLE: Acao[] = [
  { id: 'email.buscar', risco: 'ler', escopos: LER_EMAIL, descricao: 'procura e-mails em toda a caixa, de qualquer época e categoria (não há período padrão)',
    params: {
      texto: { tipo: 'texto', descricao: 'busca como a do Gmail: palavras e operadores (has:attachment, filename:pdf)' },
      de: { tipo: 'texto', descricao: 'quem enviou: e-mail ou nome' }, para: { tipo: 'texto', descricao: 'quem recebeu: e-mail ou nome' }, assunto: { tipo: 'texto', descricao: 'palavras do assunto' },
      pasta: { tipo: 'texto', descricao: 'nome ou id do marcador (entrada, enviados, rascunhos, lixeira, spam, arquivo ou um seu)' },
      desde: { tipo: 'texto', descricao: 'data inicial, AAAA-MM-DD' }, ate: { tipo: 'texto', descricao: 'data final, AAAA-MM-DD' },
      nao_lidos: { tipo: 'booleano', descricao: 'só os não lidos' }, limite: { tipo: 'numero', descricao: 'quantos por página (padrão 25, até 100)' }, cursor: P_CURSOR,
    },
    resumo: (a) => `Buscar e-mails${s(a, 'texto') ? ` com "${s(a, 'texto')}"` : ''}${s(a, 'de') ? ` de ${s(a, 'de')}` : ''}${s(a, 'para') ? ` para ${s(a, 'para')}` : ''}${s(a, 'assunto') ? ` com assunto "${s(a, 'assunto')}"` : ''}`,
    async run(ctx, a) {
      const grupo = (op: string, k: string) => { const v = txt(a, k, 300)?.replace(/[(){}"]/g, ' ').replace(/\s+/g, ' ').trim(); return v ? [`${op}:${/\s/.test(v) ? `(${v})` : v}`] : []; };
      const { desde, ate } = intervalo(a, ctx.tz);
      const pasta = txt(a, 'pasta', 300)?.trim();
      const arquivo = !!pasta && ARQUIVO.has(fold(pasta));
      const marcador = pasta && !arquivo ? await marcadorDe(ctx, pasta) : null;
      const busca = [
        ...(txt(a, 'texto', 1000)?.trim() ? [txt(a, 'texto', 1000)!.trim()] : []), ...grupo('from', 'de'), ...grupo('to', 'para'), ...grupo('subject', 'assunto'),
        // datas em segundos: em AAAA/MM/DD, o Gmail entende meia-noite no fuso do Pacífico
        ...(desde !== undefined ? [`after:${Math.floor(desde / 1000)}`] : []), ...(ate !== undefined ? [`before:${Math.floor(ate / 1000)}`] : []),
        ...(sim(a, 'nao_lidos') ? ['is:unread'] : []), ...(arquivo ? ['in:archive'] : []),
      ].join(' ');
      const q = new URLSearchParams({ maxResults: String(num(a, 'limite', 25, 100)) });
      if (busca) q.set('q', busca);
      if (marcador) q.set('labelIds', marcador.id);
      if (marcador?.id === 'TRASH' || marcador?.id === 'SPAM') q.set('includeSpamTrash', 'true');
      const cursor = cursorDe(a);
      if (cursor) q.set('pageToken', cursor);
      const j = await ctx.http(`${GMAIL}/messages?${q}`);
      const ids = ((j.messages ?? []) as any[]).map((m) => String(m.id));
      const itens: any[] = [];
      for (let i = 0; i < ids.length; i += 5) { // poucas por vez: respeita o limite do Gmail
        itens.push(...await Promise.all(ids.slice(i, i + 5).map((id) => ctx.http(`${GMAIL}/messages/${seg(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&fields=id,threadId,labelIds,internalDate,snippet,payload/headers`))));
      }
      const linhas = itens.map((m) => [
        `- id=${String(m.id)}`, quando(Number(m.internalDate), ctx.tz), `de ${neutral(cabecalho(m.payload, 'from'), 160)}`, `para ${neutral(cabecalho(m.payload, 'to'), 200)}`, `assunto: ${neutral(cabecalho(m.payload, 'subject'), 200)}`,
        (m.labelIds ?? []).includes('UNREAD') ? 'não lido' : 'lido', `prévia: ${neutral(xmlText(String(m.snippet ?? '')), 300)}`,
      ].join(' | '));
      const v = caber(linhas);
      return lido(`${v.linhas.length ? `${v.linhas.length} e-mail(s):\n${v.linhas.join('\n')}` : 'Nenhum e-mail encontrado.'}${v.nota}${haMais(j)}`);
    } },
  { id: 'email.ler', risco: 'ler', escopos: LER_EMAIL, descricao: `lê um e-mail: corpo em texto (até ${MAX_EMAIL_LIDO.toLocaleString('pt-BR')} caracteres) e nomes dos anexos`, params: { id: P_ID_EMAIL },
    resumo: (a) => `Ler o e-mail ${s(a, 'id')}`,
    async run(ctx, a) {
      const m = await ctx.http(`${GMAIL}/messages/${seg(precisa(a, 'id', 500))}?format=full`);
      const { plano, html, anexos } = partesDoEmail(m.payload);
      const corpo = plano || (html ? htmlParaTexto(html) : '');
      const h = (n: string) => neutral(cabecalho(m.payload, n), 500);
      return lido([
        `Assunto: ${h('subject')}`, `De: ${h('from')}`, `Para: ${h('to')}`, ...(h('cc') ? [`Cópia: ${h('cc')}`] : []), `Data: ${quando(Number(m.internalDate), ctx.tz)}`, `Conversa: ${String(m.threadId ?? '')}`,
        `Anexos: ${anexos.length ? anexos.slice(0, 50).map((n) => neutral(n, 160)).join(', ') : 'nenhum'}`,
        corpo ? `Corpo${corpo.length > MAX_EMAIL_LIDO ? ` (só os primeiros ${MAX_EMAIL_LIDO} caracteres)` : ''}: ${neutral(corpo, MAX_EMAIL_LIDO)}` : `Prévia (o corpo não veio na resposta): ${neutral(xmlText(String(m.snippet ?? '')), 500)}`,
      ].join('\n'));
    } },
  { id: 'email.pastas', risco: 'ler', escopos: LER_EMAIL, descricao: 'lista os marcadores do Gmail, que fazem o papel das pastas', params: {},
    resumo: () => 'Listar os marcadores do e-mail',
    async run(ctx) {
      const l = ((await ctx.http(`${GMAIL}/labels`)).labels ?? []) as any[];
      return lido(l.length ? l.map((x) => `- ${neutral(String(x.name ?? ''), 200)} | id=${String(x.id)}`).join('\n') : 'Nenhum marcador encontrado.');
    } },
  { id: 'email.rascunho', risco: 'organizar', escopos: MEXER_EMAIL, descricao: 'salva um e-mail em Rascunhos, sem enviar',
    params: { para: { ...P_PARA, obrigatorio: false }, cc: P_CC, assunto: P_ASSUNTO, texto: P_TEXTO }, resumo: (a) => sobreEmail('Salvar rascunho (sem enviar)', a),
    async run(ctx, a) {
      const j = await ctx.http(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw: montarRaw(await novaMensagem(ctx, a, false)) } }, kind: 'write' });
      return { texto: `Rascunho salvo, nada foi enviado. id=${String(j.id ?? '')}` };
    } },
  { id: 'email.rascunho_resposta', risco: 'organizar', escopos: MEXER_EMAIL, descricao: 'salva uma resposta em Rascunhos, sem enviar (quem recebe vem do e-mail original)', params: { id: P_ID_EMAIL, texto: P_TEXTO, todos: P_TODOS },
    resumo: (a) => sobreResposta('Salvar rascunho (sem enviar) de resposta', a),
    preparar: (ctx, a) => cartaoDaResposta(ctx, a, false),
    async run(ctx, a) {
      const r = await resposta(ctx, a);
      const j = await ctx.http(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw: montarRaw(r.msg), ...(r.conversa ? { threadId: r.conversa } : {}) } }, kind: 'write' });
      return lido(`Rascunho de resposta salvo, nada foi enviado. Iria para: ${destinoDe(r.msg)}. id=${String(j.id ?? '')}`);
    } },
  { id: 'email.enviar', risco: 'enviar', escopos: MEXER_EMAIL, descricao: 'envia um e-mail novo em nome da pessoa', params: { para: P_PARA, cc: P_CC, assunto: P_ASSUNTO, texto: P_TEXTO },
    resumo: (a) => sobreEmail('Enviar e-mail', a),
    async run(ctx, a) {
      const m = await novaMensagem(ctx, a, true);
      const j = await ctx.http(`${GMAIL}/messages/send`, { method: 'POST', body: { raw: montarRaw(m) }, kind: 'write' });
      return { texto: `O serviço aceitou o envio para ${destinoDe(m)}, assunto "${neutral(m.assunto, 200)}". id=${String(j.id ?? '')}` };
    } },
  { id: 'email.responder', risco: 'enviar', escopos: MEXER_EMAIL, descricao: 'responde a um e-mail, na mesma conversa; quem recebe vem do próprio e-mail, nunca do agente', params: { id: P_ID_EMAIL, texto: P_TEXTO, todos: P_TODOS },
    resumo: (a) => sobreResposta('Responder', a),
    preparar: (ctx, a) => cartaoDaResposta(ctx, a, true),
    async run(ctx, a) {
      const r = await resposta(ctx, a);
      const j = await ctx.http(`${GMAIL}/messages/send`, { method: 'POST', body: { raw: montarRaw(r.msg), ...(r.conversa ? { threadId: r.conversa } : {}) }, kind: 'write' });
      return lido(`O serviço aceitou a resposta para ${destinoDe(r.msg)}. id=${String(j.id ?? '')}`);
    } },
  // Rascunho não pede confirmação, e o cartão só vê os parâmetros: sem "para", um rascunho escrito a mando de um e-mail
  // malicioso sairia com um clique às cegas. Quem recebe vai no cartão, e o que foi mostrado é conferido com o rascunho.
  { id: 'email.enviar_rascunho', risco: 'enviar', escopos: MEXER_EMAIL, descricao: 'envia um rascunho que já existe, como está; diga em "para" todos os destinatários dele', rotulo: 'envia um rascunho que já existe, como está',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do rascunho' }, para: { tipo: 'lista', obrigatorio: true, descricao: 'todos os e-mails que o rascunho alcança (para, cópia e cópia oculta): aparecem no cartão de confirmação e são conferidos com o rascunho antes de enviar' } },
    resumo: (a) => `Enviar o rascunho ${s(a, 'id')} para ${emLista(a, 'para') || '(sem destinatário)'}, como está salvo no Gmail. O sistema confere estes destinatários com o rascunho; o texto é o que está lá`,
    async preparar(ctx, a) {
      const id = precisa(a, 'id', 500);
      const ditos = ditosDoRascunho(a);
      const r = await lerRascunho(ctx, id);
      conferirDestinatarios(ditos, r.reais);
      const linha = (rot: string, l: string[]) => (l.length ? [`${rot}: ${l.map((e) => noCartao(e, 120)).join(', ')}.`] : []);
      return { args: { ...a, visto: r.marca }, detalhe: [
        ...linha('Vai para', r.para), ...linha('Em cópia', r.cc), ...linha('Em cópia oculta', r.oculta),
        `Assunto: "${noCartao(r.assunto, MAX_ASSUNTO)}".`, ...(r.anexos.length ? [`Anexos: ${r.anexos.slice(0, 50).map((n) => noCartao(n, 160)).join(', ')}.`] : []),
        `Texto do rascunho${r.corpo.length > MAX_EMAIL ? ` (só os primeiros ${MAX_EMAIL} caracteres; o resto está no rascunho)` : r.corpo.length > TEXTO_LONGO ? ` (${r.corpo.length} caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar)` : ''}: "${noCartao(r.corpo, MAX_EMAIL)}"`,
      ].join('\n') };
    },
    async run(ctx, a) {
      const id = precisa(a, 'id', 500);
      const ditos = ditosDoRascunho(a);
      const r = await lerRascunho(ctx, id);
      conferirDestinatarios(ditos, r.reais);
      // o clique envia o que a pessoa leu: mudou depois do cartão, ela precisa ver de novo
      if (a.visto !== undefined && a.visto !== r.marca) throw new ErroAcao('o rascunho mudou depois do cartão de confirmação: nada foi enviado; peça de novo, para a pessoa ver como ele está agora');
      const j = await ctx.http(`${GMAIL}/drafts/send`, { method: 'POST', body: { id }, kind: 'write' });
      return lido(`O serviço aceitou o envio do rascunho para ${destinoDe(r) || 'os destinatários em cópia oculta'}. id=${String(j.id ?? '')}`);
    } },
  { id: 'email.mover', risco: 'organizar', escopos: MEXER_EMAIL, descricao: 'move um e-mail para um marcador, saindo da Caixa de Entrada; pasta="arquivo" arquiva', rotulo: 'move um e-mail para um marcador, saindo da Caixa de Entrada, ou arquiva',
    params: { id: P_ID_EMAIL, pasta: { tipo: 'texto', obrigatorio: true, descricao: 'nome ou id do marcador de destino, ou "arquivo"' } },
    resumo: (a) => `Mover o e-mail ${s(a, 'id')} para a pasta "${semQuebra(s(a, 'pasta'))}"`,
    async preparar(ctx, a) {
      const m = await destinoDeMover(ctx, precisa(a, 'pasta', 300));
      const email = await emailNoCartao(ctx, precisa(a, 'id', 500));
      if (!m) return { detalhe: `${email}\nVai ser arquivado: sai da Caixa de Entrada.` };
      return { args: { ...a, pasta: m.id }, detalhe: `${email}\nVai para o marcador "${noCartao(m.nome, 120)}".` };
    },
    async run(ctx, a) {
      const id = precisa(a, 'id', 500); const alvo = precisa(a, 'pasta', 300);
      const m = await destinoDeMover(ctx, alvo);
      const modifica = (corpo: Record<string, string[]>) => ctx.http(`${GMAIL}/messages/${seg(id)}/modify`, { method: 'POST', body: corpo, kind: 'write' });
      if (!m) { await modifica({ removeLabelIds: ['INBOX'] }); return { texto: 'E-mail arquivado: saiu da Caixa de Entrada.' }; }
      await modifica({ addLabelIds: [m.id], ...(m.doUsuario ? { removeLabelIds: ['INBOX'] } : {}) });
      return lido(`E-mail movido para "${neutral(m.nome, 120)}".`);
    } },
  { id: 'email.apagar', risco: 'apagar', escopos: MEXER_EMAIL, descricao: 'manda um e-mail para a Lixeira do Gmail (dá para recuperar de lá)', params: { id: P_ID_EMAIL },
    resumo: (a) => `Apagar o e-mail ${s(a, 'id')}: ele vai para a Lixeira e dá para recuperar de lá`,
    preparar: async (ctx, a) => ({ detalhe: await emailNoCartao(ctx, precisa(a, 'id', 500)) }),
    async run(ctx, a) {
      await ctx.http(`${GMAIL}/messages/${seg(precisa(a, 'id', 500))}/trash`, { method: 'POST', kind: 'write' });
      return { texto: 'E-mail na Lixeira.' };
    } },

  { id: 'agenda.calendarios', risco: 'ler', escopos: LER_AGENDA, descricao: 'lista as agendas da conta', params: {},
    resumo: () => 'Listar as agendas',
    async run(ctx) {
      const todas = await todasAgendas(ctx);
      return lido(todas.length ? todas.map((c) => `- ${neutral(nomeAgenda(c), 120)}${c.primary ? ' (principal)' : ''} | ${/^(owner|writer)/.test(String(c.accessRole)) ? 'pode editar' : 'só leitura'} | id=${String(c.id)}`).join('\n') : 'Nenhuma agenda encontrada.');
    } },
  { id: 'agenda.listar', risco: 'ler', escopos: LER_AGENDA, descricao: 'lista compromissos de um período (datas passadas valem; sem período, os próximos 7 dias), com participantes e descrição curta',
    params: { desde: { tipo: 'texto', descricao: 'data inicial, AAAA-MM-DD' }, ate: { tipo: 'texto', descricao: 'data final, AAAA-MM-DD' }, agenda: P_AGENDA, limite: { tipo: 'numero', descricao: 'quantos por página (padrão 50, até 200)' }, cursor: P_CURSOR },
    resumo: (a) => `Ver a agenda${s(a, 'desde') ? ` desde ${s(a, 'desde')}` : ''}${s(a, 'ate') ? ` até ${s(a, 'ate')}` : ''}`,
    async run(ctx, a) {
      const p = intervalo(a, ctx.tz);
      const hoje = localParts(ctx.tz, Date.now());
      const desde = p.desde ?? (p.ate !== undefined ? p.ate - 7 * DIA_MS : zonedToUtc(ctx.tz, hoje.y, hoje.m, hoje.d, 0, 0));
      const ate = p.ate ?? desde + 7 * DIA_MS;
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(desde).toISOString(), timeMax: new Date(ate).toISOString(), maxResults: String(num(a, 'limite', 50, 200)), timeZone: ctx.tz,
        fields: 'nextPageToken,items(id,summary,description,location,start,end,hangoutLink,organizer(email),attendees(email))' });
      const cursor = cursorDe(a);
      if (cursor) q.set('pageToken', cursor);
      const j = await ctx.http(`${AGENDA}/calendars/${seg(await agendaDe(ctx, a))}/events?${q}`);
      const v = caber(((j.items ?? []) as any[]).map((e) => linhaEvento(e, ctx.tz)));
      return lido(`${v.linhas.length ? `${v.linhas.length} compromisso(s):\n${v.linhas.join('\n')}` : 'Nenhum compromisso neste período.'}${v.nota}${haMais(j)}`);
    } },
  { id: 'agenda.criar', risco: (a) => (convida(a) ? 'enviar' : 'organizar'), escopos: MEXER_AGENDA, descricao: 'cria um compromisso; com participantes, o convite sai para eles na hora',
    params: { titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título' }, inicio: { ...P_INICIO, obrigatorio: true }, fim: P_FIM, fuso: P_FUSO, participantes: { tipo: 'lista', descricao: 'e-mails de quem recebe o convite' }, local: P_LOCAL, descricao: P_DESC, online: P_ONLINE, agenda: P_AGENDA },
    resumo: (a) => `Criar na agenda "${semQuebra(s(a, 'titulo'))}"${eventoEmTexto(a) ? `, ${eventoEmTexto(a)}` : ''}${convida(a) ? `. O convite será enviado para ${emLista(a, 'participantes')}` : ', sem convidar ninguém'}`,
    async preparar(ctx, a) {
      const agenda = await agendaExata(ctx, a);
      if (!agenda.nome) return {};
      return { ...comAgenda(a, agenda), detalhe: `Na agenda "${noCartao(agenda.nome, 120)}".` };
    },
    async run(ctx, a) {
      const participantes = enderecos(a, 'participantes');
      precisa(a, 'titulo', MAX_ASSUNTO);
      const corpo = { ...camposEvento(a, fusoDe(ctx, a), true), ...(participantes.length ? { attendees: participantes.map((email) => ({ email })) } : {}) };
      // o risco vem dos participantes: sem eles é só organizar a agenda, e nada sai por e-mail
      const e = await ctx.http(`${AGENDA}/calendars/${seg((await agendaExata(ctx, a)).id)}/events?${parametrosEvento(participantes.length > 0, a)}`, { method: 'POST', body: corpo, kind: 'write' });
      return { texto: `Compromisso criado${participantes.length ? `; convite enviado para ${participantes.join(', ')}` : ''}. id=${String(e.id ?? '')}${e.hangoutLink ? `. Entrar na reunião: ${String(e.hangoutLink)}` : ''}`, url: e.htmlLink ? String(e.htmlLink) : null };
    } },
  { id: 'agenda.editar', risco: (a) => (convida(a) || sim(a, 'avisar_participantes') ? 'enviar' : 'organizar'), escopos: MEXER_AGENDA,
    descricao: 'altera um compromisso; se ele tem participantes, eles veem a mudança: isso precisa de avisar_participantes=true ou da nova lista em participantes', rotulo: 'altera um compromisso; se ele tem participantes, eles veem a mudança',
    params: { id: P_ID_EVENTO, titulo: { tipo: 'texto', descricao: 'título novo' }, inicio: P_INICIO, fim: P_FIM, fuso: P_FUSO, participantes: { tipo: 'lista', descricao: 'a lista inteira de participantes depois da mudança (substitui a atual)' }, avisar_participantes: { tipo: 'booleano', descricao: 'true = os participantes de hoje recebem o aviso da mudança' }, local: P_LOCAL, descricao: P_DESC, online: P_ONLINE, agenda: P_AGENDA },
    resumo: (a) => `Alterar o compromisso ${s(a, 'id')}${s(a, 'titulo') ? `: título "${semQuebra(s(a, 'titulo'))}"` : ''}${eventoEmTexto(a) ? `, ${eventoEmTexto(a)}` : ''}${convida(a) ? `. Participantes passam a ser ${emLista(a, 'participantes')}, e eles recebem o aviso` : sim(a, 'avisar_participantes') ? '. Os participantes recebem o aviso da mudança' : ''}`,
    async preparar(ctx, a) {
      const id = precisa(a, 'id', 1024);
      const { avisa } = mudancaDoEvento(ctx, a);
      const agenda = await agendaExata(ctx, a);
      const e = await fichaEvento(ctx, agenda.id, id);
      exigeAviso((e.attendees ?? []) as any[], avisa);
      return { ...comAgenda(a, agenda), detalhe: eventoNoCartao(e, ctx.tz, agenda.nome).join('\n') };
    },
    async run(ctx, a) {
      const id = precisa(a, 'id', 1024);
      const { participantes, campos, avisa } = mudancaDoEvento(ctx, a);
      const url = `${AGENDA}/calendars/${seg((await agendaExata(ctx, a)).id)}/events/${seg(id)}`;
      const hoje = ((await ctx.http(`${url}?fields=attendees`)).attendees ?? []) as any[];
      exigeAviso(hoje, avisa);
      if (participantes.length) { // a lista enviada substitui a anterior: quem continua mantém a resposta que já deu
        const antes = new Map(hoje.map((x) => [String(x.email).toLowerCase(), x]));
        campos.attendees = participantes.map((email) => antes.get(email.toLowerCase()) ?? { email });
      }
      const e = await ctx.http(`${url}?${parametrosEvento(avisa, a)}`, { method: 'PATCH', body: campos, kind: 'write' });
      return { texto: `Compromisso alterado${avisa ? '; os participantes recebem o aviso' : ''}.${e.hangoutLink ? ` Entrar na reunião: ${String(e.hangoutLink)}` : ''}`, url: e.htmlLink ? String(e.htmlLink) : null };
    } },
  { id: 'agenda.cancelar', risco: 'apagar', escopos: MEXER_AGENDA, descricao: 'tira um compromisso da agenda; os participantes, se houver, recebem o cancelamento', params: { id: P_ID_EVENTO, agenda: P_AGENDA },
    resumo: (a) => `Cancelar o compromisso ${s(a, 'id')}: ele sai da agenda e os participantes, se houver, recebem o cancelamento`,
    async preparar(ctx, a) {
      const id = precisa(a, 'id', 1024);
      const agenda = await agendaExata(ctx, a);
      const e = await fichaEvento(ctx, agenda.id, id);
      return { ...comAgenda(a, agenda), detalhe: eventoNoCartao(e, ctx.tz, agenda.nome).join('\n') };
    },
    async run(ctx, a) {
      await ctx.http(`${AGENDA}/calendars/${seg((await agendaExata(ctx, a)).id)}/events/${seg(precisa(a, 'id', 1024))}?sendUpdates=all`, { method: 'DELETE', kind: 'write' });
      return { texto: 'Compromisso cancelado.' };
    } },

  { id: 'arquivos.buscar', risco: 'ler', escopos: LER_DRIVE, descricao: 'procura no Drive, pelo nome e pelo conteúdo, inclusive o que foi compartilhado com a pessoa',
    params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'nome ou palavras do arquivo' }, limite: { tipo: 'numero', descricao: 'quantos por página (padrão 25, até 100)' }, cursor: P_CURSOR },
    resumo: (a) => `Procurar arquivos com "${s(a, 'texto')}"`,
    async run(ctx, a) {
      const termo = precisa(a, 'texto', 500).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = new URLSearchParams({ q: `fullText contains '${termo}' and trashed = false`, pageSize: String(num(a, 'limite', 25, 100)), includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)' });
      const cursor = cursorDe(a);
      if (cursor) q.set('pageToken', cursor);
      const j = await ctx.http(`${DRIVE}/files?${q}`);
      const v = caber(((j.files ?? []) as any[]).map((f) => [
        `- id=${String(f.id)}`, neutral(String(f.name ?? ''), 200), f.mimeType === PASTA ? 'pasta' : f.size ? tamanho(f.size) : 'documento do Google', ...(f.modifiedTime ? [`alterado em ${quando(String(f.modifiedTime), ctx.tz)}`] : []), ...(f.webViewLink ? [`endereço: ${String(f.webViewLink)}`] : []),
      ].join(' | ')));
      return lido(`${v.linhas.length ? `${v.linhas.length} arquivo(s):\n${v.linhas.join('\n')}` : 'Nenhum arquivo encontrado.'}${j.incompleteSearch ? '\nO Google avisou que a busca pode não ter olhado tudo.' : ''}${v.nota}${haMais(j)}`);
    } },
  { id: 'arquivos.ler', risco: 'ler', escopos: LER_DRIVE, descricao: `lê o texto de um arquivo de até 15 MB (documentos do Google, Word, Excel, PowerPoint, PDF com texto, CSV, texto), até ${MAX_DOC.toLocaleString('pt-BR')} caracteres`,
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do arquivo (vem de arquivos.buscar)' } },
    resumo: (a) => `Ler o arquivo ${s(a, 'id')}`,
    async run(ctx, a) {
      const bytes = bytesDe(ctx);
      const pedido = precisa(a, 'id', 500);
      let meta = await metaArquivo(ctx, pedido);
      if (meta.mimeType === ATALHO) {
        if (!meta.shortcutDetails?.targetId) throw new ErroAcao('este atalho não aponta para nenhum arquivo');
        meta = await metaArquivo(ctx, String(meta.shortcutDetails.targetId));
      }
      const mime = String(meta.mimeType ?? ''); const nome = String(meta.name ?? 'arquivo'); const id = seg(meta.id);
      const visto = neutral(nome, 120);
      // os erros citam o id pedido, não o nome: quem compartilha o arquivo escolhe o nome, e ele chegaria ao agente como texto do sistema
      const qual = `id=${neutral(pedido, 200)}`;
      if (mime === PASTA) throw new ErroAcao(`o item ${qual} é uma pasta, não um arquivo`);
      if (meta.capabilities?.canDownload === false) throw new ErroAcao(`não há permissão para baixar o arquivo ${qual}`);
      const exporta = EXPORTA[mime];
      let doc: DocText;
      if (exporta) {
        doc = await readDocument(`${nome}.${exporta.ext}`, exporta.mime, (await bytes(`${DRIVE}/files/${id}/export?mimeType=${enc(exporta.mime)}`, { teto: TETO_ARQUIVO })).data);
      } else {
        if (mime.startsWith('application/vnd.google-apps.')) throw new ErroAcao(`o arquivo ${qual} é de um tipo do Google que não dá para ler como texto (${neutral(mime, 80)})`);
        if (Number(meta.size ?? 0) > TETO_ARQUIVO) throw new ErroAcao('arquivo grande demais (mais de 15 MB): nada foi lido');
        doc = await readDocument(nome, mime, (await bytes(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, { teto: TETO_ARQUIVO })).data);
      }
      if (doc.status !== 'ok') throw new ErroAcao(`não deu para ler o arquivo ${qual}: ${neutral(doc.detail ?? 'sem texto legível (pode ser digitalizado)', 200)}`);
      const texto = doc.sheets?.length ? doc.sheets.map((x) => sheetText(x, 200).replace(/\n/g, ' // ')).join(' // ') : doc.text;
      return lido(`Arquivo ${visto}${texto.length > MAX_DOC ? ` (só os primeiros ${MAX_DOC} caracteres)` : ''}: ${neutral(texto, MAX_DOC)}`, meta.webViewLink ? String(meta.webViewLink) : null);
    } },
  { id: 'arquivos.criar', risco: 'organizar', escopos: CRIAR_DRIVE, descricao: 'cria um arquivo de texto pequeno na raiz do Drive da pessoa; o Drive aceita nomes repetidos, então nada é sobrescrito',
    params: { caminho: { tipo: 'texto', obrigatorio: true, descricao: 'nome do arquivo, ex.: resumo.txt (com a permissão usada, o Google só deixa criar na raiz)' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'conteúdo do arquivo' } },
    resumo: (a) => `Criar no Drive o arquivo "${semQuebra(s(a, 'caminho'))}" com o conteúdo: "${s(a, 'texto')}"`,
    async run(ctx, a) {
      const bytes = bytesDe(ctx);
      const nome = semQuebra(inteiro(a, 'caminho', 300));
      if (/[\\/]/.test(nome)) throw new ErroAcao('o Drive desta conexão só cria na raiz: diga só o nome do arquivo, ex.: resumo.txt; nada foi feito');
      const tipo = TIPOS_DE_TEXTO[/\.([a-z0-9]+)$/i.exec(nome)?.[1]?.toLowerCase() ?? ''];
      if (!tipo) throw new ErroAcao('"caminho" precisa terminar num arquivo de texto: .txt, .md, .csv, .tsv, .json, .xml, .html ou .log');
      const conteudo = inteiro(a, 'texto', TETO_ENVIO);
      if (Buffer.byteLength(conteudo) > TETO_ENVIO) throw new ErroAcao('"texto" passou de 5 MB: nada foi feito; encurte o texto');
      const fronteira = `ergon_${crypto.randomBytes(18).toString('hex')}`; // sorteada aqui: o conteúdo não tem como conhecê-la antes
      const corpo = [`--${fronteira}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name: nome }), `--${fronteira}`, `Content-Type: ${tipo}; charset=UTF-8`, '', conteudo, `--${fronteira}--`, ''].join('\r\n');
      const r = await bytes(`${DRIVE_ENVIO}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${fronteira}` }, body: Buffer.from(corpo, 'utf8'), kind: 'write', teto: 1024 * 1024 });
      let j: any = {};
      try { j = JSON.parse(r.data.toString('utf8')); } catch { /* o envio foi aceito, a resposta é que não veio legível */ }
      if (!j.id) return { texto: 'O serviço aceitou o envio, mas não devolveu o id: confira no Drive antes de repetir.' };
      return { texto: `Arquivo criado no Drive: ${neutral(String(j.name ?? nome), 200)} (id=${String(j.id)}).`, url: j.webViewLink ? String(j.webViewLink) : null };
    } },

  { id: 'pessoas.buscar', risco: 'ler', escopos: LER_PESSOAS, descricao: 'acha o e-mail de alguém pelo nome, nos contatos, em quem já trocou e-mail com a conta e no diretório da empresa',
    params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'começo do nome ou do e-mail' }, limite: { tipo: 'numero', descricao: 'quantos por origem (padrão 10, até 25)' } },
    resumo: (a) => `Procurar a pessoa "${s(a, 'texto')}"`,
    async run(ctx, a) {
      const texto = precisa(a, 'texto', 120); const limite = num(a, 'limite', 10, 25);
      // a busca lê um cache que a documentação manda atualizar antes, com uma consulta vazia
      const frio = Date.now() - (aquecidos.get(ctx.workspaceId) ?? 0) > AQUECE_MS;
      if (frio) {
        aquecidos.set(ctx.workspaceId, Date.now());
        await Promise.allSettled([ctx.http(`${PESSOAS}/people:searchContacts?query=&readMask=names,emailAddresses`), ctx.http(`${PESSOAS}/otherContacts:search?query=&readMask=names,emailAddresses`)]);
      }
      let r = await procurarPessoas(ctx, texto, limite);
      // o cache recém-pedido demora "alguns segundos": só espera se a primeira resposta veio vazia
      if (frio && !r.achadas.length) { await espera(ESPERA_CACHE_MS); r = await procurarPessoas(ctx, texto, limite); }
      const linhas = linhasDePessoas(r.achadas);
      return lido(`${linhas.length ? linhas.join('\n') : `Ninguém encontrado para "${neutral(texto, 80)}".`}${r.faltou.length ? `\nNão deu para consultar: ${r.faltou.join(', ')}.` : ''}`);
    } },
];

/** Tudo o que a conta Google precisa autorizar para as ações e o espelho de tarefas funcionarem (além de openid, email, profile). */
export const ESCOPOS_GOOGLE: string[] = [...new Set([ESCOPO_TAREFAS, ...ACOES_GOOGLE.flatMap((a) => a.escopos ?? []), ...PESSOAS_OPCIONAIS])];
