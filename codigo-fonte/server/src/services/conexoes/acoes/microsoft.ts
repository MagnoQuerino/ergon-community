/**
 * Microsoft 365 para os agentes: e-mail, agenda, arquivos, pessoas e Teams, pelo Microsoft Graph v1.0. Os endereços são
 * fixos aqui: nada vem do modelo, e o cursor de paginação só vale dentro do Graph e no caminho da própria ação (o token nunca vai a outro lugar).
 * `CtxAcao.http` só fala JSON: download e envio de arquivo usam os endereços pré-autenticados que o Graph devolve, sem o token.
 * Texto de terceiros passa por neutral() e marca deFora/privado (regra.ts decide o que isso muda).
 *
 * Conferido nas páginas oficiais em 05/11/2026 (https://learn.microsoft.com/en-us/graph/ ...):
 *   permissões: permissions-reference; api/message-update; known-issues ("comment" não entra no corpo do rascunho)
 *   e-mail: api/user-list-messages ($filter + $orderby: InefficientFilter), search-query-parameter, filter-query-parameter, query-parameters,
 *     api/message-get, api/message-list-attachments, api/user-list-mailfolders, api/mailfolder-list-childfolders, api/resources/mailfolder,
 *     api/user-post-messages, api/user-sendmail, api/message-createreply, api/message-createreplyall, api/message-reply, api/message-send, api/message-move
 *   busca (KQL): https://learn.microsoft.com/en-us/purview/edisc-search-mailboxes e
 *     https://learn.microsoft.com/en-us/exchange/policy-and-compliance/ediscovery/message-properties-and-search-operators
 *   agenda: api/user-list-calendars, api/user-list-calendarview, api/calendar-list-calendarview, api/calendar-get, api/user-post-events, api/event-update,
 *     api/event-delete, api/resources/event, api/resources/datetimetimezone
 *   arquivos: api/driveitem-search, api/driveitem-get, api/driveitem-get-content, api/driveitem-createuploadsession, api/resources/driveitem,
 *     api/resources/remoteitem, sdks/large-file-upload
 *   pessoas: api/user-list-people, people-insights-overview
 *   Teams: api/chat-list, api/chat-list-messages, api/chat-post-messages, api/chat-post, api/user-list-joinedteams, api/channel-list,
 *     api/channel-post-messages, api/chatmessage-post, api/resources/chatmessage, api/chat-get, api/chat-list-members, api/team-get, api/channel-get
 *   cartão de confirmação: api/resources/message (replyTo), api/message-createreply e api/message-createreplyall (replyTo fica a cargo de quem responde),
 *     api/resources/mailfolder (parentFolderId, msgfolderroot), api/resources/event (type, isOrganizer); paginação: paging
 * Conferido em 08/11/2026:
 *   api/chat-list (Chat.ReadBasic basta para listar; $top até 50; $orderby só lastMessagePreview/createdDateTime desc; $expand=members para em 25),
 *   api/chat-get e api/chat-list-members (Chat.ReadBasic), api/chat-list-messages (Chat.Read; não existe para conta pessoal),
 *   api/channel-list-messages (ChannelMessage.Read.All, que sempre exige administrador; $top até 50), api/chat-post (pessoa de outra
 *   organização só entra pelo id e pelo tenantId dela, nunca pelo e-mail), best-practices-concept (client-request-id; 503 com espera),
 *   resources/teams-api-overview ("Polling requirements": consultar o mesmo recurso em laço viola os termos de uso; tudo aqui é sob
 *   demanda, num pedido da pessoa ou numa rotina, nunca numa vigia), e
 *   https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies (o que o usuário comum autoriza
 *   sozinho na política padrão "Let Microsoft manage your consent settings": ver ESCOPOS_MICROSOFT, no fim do arquivo)
 */
import crypto from 'node:crypto';
import { fold } from '../../../lib/util.ts';
import { NetworkFailure, fetchWithPolicy } from '../../../lib/http.ts';
import { readDocument } from '../../doc-isolated.ts';
import { sheetText } from '../../doc-text.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { localParts, zonedToUtc } from '../../routine-time.ts';
import { caber, htmlParaTexto, marcaDe, semControle } from '../texto.ts';
import { ErroAcao, emails, lista, num, precisa, seg, txt, type Acao, type Args, type CtxAcao, type Param, type Resultado } from '../tipos.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DIA_MS = 86_400_000;
const MAX_CORPO = 12_000; const MAX_DOC = 20_000; const MAX_BYTES = 15 * 1024 * 1024;
const MAX_ASSUNTO = 255; const MAX_EMAIL = 100_000; const MAX_TEAMS = 20_000; const MAX_ARQUIVO = 200_000; const MAX_DESCRICAO = 20_000;
/** acima disto, o cartão diz o tamanho do rascunho antes do texto: o cartão leva o texto inteiro, mas a tela recolhe texto longo, e o fim passa fácil sem ser lido */
const TEXTO_LONGO = 4000;
/** $orderby exige a propriedade primeiro no $filter: sem data pedida, este piso não restringe nada (ver buscaPorFiltro) */
const DESDE_SEMPRE = '1900-01-01T00:00:00Z';
const SEL_EMAIL = 'id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink';
const SEL_EVENTO = 'id,subject,start,end,isAllDay,isCancelled,location,attendees,organizer,bodyPreview,isOnlineMeeting,webLink';
const SEL_PESSOA = 'displayName,scoredEmailAddresses,userPrincipalName,jobTitle,companyName,department';
const SEL_PASTA = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount';
const SEL_ARQUIVO = 'id,name,size,file,folder,webUrl,lastModifiedDateTime,parentReference,remoteItem';

const enc = encodeURIComponent;
/**
 * O serviço (servico.ts) diz, quando sabe, se a conta deu uma permissão: com ela, a ação escolhe o pedido que a conta alcança
 * (a lista de conversas do Teams sem a prévia, por exemplo). Sem a informação, a ação tenta e se ajusta à recusa.
 */
export type CtxMicrosoft = CtxAcao & { temEscopo?: (escopo: string) => boolean };
const tem = (c: CtxAcao, escopo: string): boolean | undefined => (c as CtxMicrosoft).temEscopo?.(escopo);
/** Espera entre tentativas (os testes trocam: nada de esperar de verdade). */
let esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setEsperaMicrosoft(fn: ((ms: number) => Promise<void>) | null): void { esperar = fn ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))); }
/** Parâmetros percent-codificados (query-parameters: "RFC 3986"); os nomes `$...` ficam como na documentação. */
const qs = (p: Record<string, string | number | undefined>): string =>
  Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${enc(String(v))}`).join('&');
/** aspas simples dentro de texto OData dobram (query-parameters: "Escaping single quotes") */
const odata = (s: string) => s.replace(/'/g, "''");
/** texto de terceiros, sempre neutralizado e numa linha só */
const d = (v: unknown, max = 200): string => neutral(semControle(v), max);
const lido = (texto: string, url?: string | null): Resultado => ({ texto, deFora: true, privado: true, ...(url ? { url } : {}) });
const umaLinha = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const sim = (a: Args, k: string): boolean => a[k] === true || a[k] === 1 || (typeof a[k] === 'string' && /^(true|sim|1)$/i.test(a[k].trim()));
/** leitura sem erro, para o cartão de confirmação: o resumo nunca lança */
const s = (a: Args, k: string): string => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
const emLista = (a: Args, k: string): string => lista(a, k, 500).map(umaLinha).join(', ');

/** Texto obrigatório inteiro: o que vai sair em nome da pessoa não é cortado às escondidas. */
const inteiro = (a: Args, k: string, max: number): string => {
  const v = txt(a, k, max + 1);
  if (!v?.trim()) throw new ErroAcao(`falta "${k}"`);
  if (v.length > max) throw new ErroAcao(`"${k}" passou de ${max} caracteres: nada foi feito; encurte o texto`);
  return v;
};
const opcional = (a: Args, k: string, max: number): string | undefined => (txt(a, k) === undefined ? undefined : inteiro(a, k, max));
const assuntoDe = (a: Args, k = 'assunto'): string => umaLinha(inteiro(a, k, MAX_ASSUNTO));
/** Destinatários conferidos (emails() recusa quebra de linha no meio; as das pontas somem); nunca perde nome além do teto. */
function destinatarios(a: Args, k: string, teto = 100): string[] {
  if (lista(a, k, teto + 1).length > teto) throw new ErroAcao(`"${k}" tem mais de ${teto} endereços: nada foi feito`);
  return emails(a, k, teto);
}
const paraRecip = (l: string[]) => l.map((address) => ({ emailAddress: { address } }));

// ------------------------------------------------------------------------------------------------- paginação
interface Cursor { /** de qual ação */ t: string; u: string; desde?: number; ate?: number; naoLidos?: boolean }
const noGraph = (u: string): boolean => {
  if (!u.startsWith('https://graph.microsoft.com/')) return false;
  try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'graph.microsoft.com' && !x.port && !x.username && !x.password; } catch { return false; }
};
/** O @odata.nextLink vai codificado ao agente; o que não for do Graph não vira cursor. */
const proximo = (j: any, t: string, extra: Partial<Cursor> = {}): string | null => {
  const n = j?.['@odata.nextLink'];
  return typeof n === 'string' && noGraph(n) ? Buffer.from(JSON.stringify({ t, u: n, ...extra } satisfies Cursor)).toString('base64url') : null;
};
/**
 * O cursor passa pelo modelo: cada ação só continua no próprio caminho, senão a listagem de conversas leria e-mail mesmo com o
 * e-mail desligado. As formas são as da documentação: o @odata.nextLink pode voltar sem o /me (chat-list, chat-list-messages) ou
 * com o dono escrito (@odata.context de user-list-messages), e `/users/{dono}` só vale para a própria conta (abreCursor confere).
 */
const DONO = "(?:me|users/([^/]+)|users\\('([^/']+)'\\))";
/** o id num caminho, nas duas escritas do OData: /pasta/id ou /pasta('id') */
const ITEM = "(?:/[^/]+|\\('[^/']*'\\))";
const ROTA_DO_CURSOR: Record<string, RegExp> = {
  email: new RegExp(`^/v1\\.0/${DONO}/(?:messages|mailFolders${ITEM}/messages)$`),
  agenda: new RegExp(`^/v1\\.0/${DONO}/(?:calendarView|calendar/calendarView|calendars${ITEM}/calendarView)$`),
  arquivos: new RegExp(`^/v1\\.0/(?:${DONO}/drive|drives${ITEM})(?:/root)?/(?:microsoft\\.graph\\.)?search\\(.*\\)(?:&[^/]*)?$`),
  'teams.conversas': new RegExp(`^/v1\\.0/(?:${DONO}/)?chats$`),
  'teams.ler': new RegExp(`^/v1\\.0/(?:${DONO}/)?chats${ITEM}/messages$`),
};
async function abreCursor(c: CtxAcao, a: Args, t: string): Promise<Cursor | null> {
  const v = txt(a, 'cursor', 16_000)?.trim();
  if (!v) return null;
  const ruim = () => new ErroAcao('"cursor" inválido: use exatamente o valor devolvido pela chamada anterior');
  let cur: any;
  try { cur = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')); } catch { throw ruim(); }
  if (cur?.t !== t || typeof cur.u !== 'string' || !noGraph(cur.u)) throw ruim();
  const caminho = new URL(cur.u).pathname;
  let claro: string; // "%2F.." no meio de um trecho: o serviço decodifica e sobe de pasta
  try { claro = decodeURIComponent(caminho); } catch { throw ruim(); }
  const rota = ROTA_DO_CURSOR[t]?.exec(caminho);
  if (!rota || /(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(claro)) throw ruim();
  const dono = rota.slice(1).find(Boolean);
  if (dono) {
    const eu = await c.http(`${GRAPH}/me?${qs({ $select: 'id,userPrincipalName,mail' })}`);
    const alvo = decodeURIComponent(dono).toLowerCase();
    if (![eu?.id, eu?.userPrincipalName, eu?.mail].some((x) => String(x ?? '').toLowerCase() === alvo)) throw ruim();
  }
  return cur as Cursor;
}
const rodape = (cursor: string | null) => (cursor ? `\nHá mais resultados: repita os mesmos parâmetros com cursor="${cursor}".` : '');
/** Lista curta que a ação lê inteira (pastas, agendas, times): segue as páginas, sem passar do teto. */
async function paginas(c: CtxAcao, url: string, max = 5): Promise<any[]> {
  const out: any[] = []; let next: string | null = url;
  for (let i = 0; next && i < max; i++) {
    const j: any = await c.http(next);
    out.push(...((j.value ?? []) as any[]));
    next = typeof j['@odata.nextLink'] === 'string' && noGraph(j['@odata.nextLink']) ? j['@odata.nextLink'] : null;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- datas
const DATA = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const dois = (n: number) => String(n).padStart(2, '0');
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dataHora = (tz: string, ts: number): string => {
  if (!Number.isFinite(ts)) return '?';
  const p = localParts(tz, ts);
  return `${dois(p.d)}/${dois(p.m)}/${p.y} ${dois(p.hh)}:${dois(p.mm)}`;
};
/** data do Graph em UTC, com ou sem o sufixo */
const emUtc = (v: unknown): number => { const x = String(v ?? ''); return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(x) ? x : `${x}Z`); };

function lerData(k: string, v: string): { y: number; mo: number; dd: number; hh?: number; mm?: number; ss: number; zona?: string } {
  const m = DATA.exec(v);
  const y = Number(m?.[1]); const mo = Number(m?.[2]); const dd = Number(m?.[3]);
  const hh = m?.[4] === undefined ? undefined : Number(m[4]); const mm = m?.[5] === undefined ? undefined : Number(m[5]); const ss = Number(m?.[6] ?? 0);
  const dia = new Date(Date.UTC(y, mo - 1, dd));
  if (!m || dia.getUTCMonth() !== mo - 1 || dia.getUTCDate() !== dd || (hh ?? 0) > 23 || (mm ?? 0) > 59 || ss > 59) throw new ErroAcao(`"${k}" precisa estar no formato AAAA-MM-DD ou AAAA-MM-DDTHH:MM`);
  return { y, mo, dd, hh, mm, ss, zona: m[7] };
}
/** Instante de `desde`/`ate`: dia inteiro no fuso da pessoa, hora local, ou hora com fuso explícito. */
function instante(a: Args, k: string, tz: string, fimDoDia: boolean): number | undefined {
  const v = txt(a, k, 40)?.trim();
  if (!v) return undefined;
  const x = lerData(k, v);
  if (x.hh === undefined) return fimDoDia ? zonedToUtc(tz, x.y, x.mo, x.dd, 23, 59) + 59_000 : zonedToUtc(tz, x.y, x.mo, x.dd, 0, 0);
  if (!x.zona) return zonedToUtc(tz, x.y, x.mo, x.dd, x.hh, x.mm!) + x.ss * 1000;
  const t = Date.parse(`${x.y}-${dois(x.mo)}-${dois(x.dd)}T${dois(x.hh)}:${dois(x.mm!)}:${dois(x.ss)}${x.zona.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`);
  if (!Number.isFinite(t)) throw new ErroAcao(`"${k}" não é uma data válida`);
  return t;
}
function periodo(a: Args, tz: string): { desde?: number; ate?: number } {
  const desde = instante(a, 'desde', tz, false); const ate = instante(a, 'ate', tz, true);
  if (desde !== undefined && ate !== undefined && desde > ate) throw new ErroAcao('"desde" vem depois de "ate"');
  return { desde, ate };
}
/** Hora de evento (dateTimeTimeZone): data e hora locais + fuso; com fuso na própria hora, vai em UTC. */
function quando(a: Args, k: string, fuso: string): { dateTime: string; timeZone: string } {
  const v = precisa(a, k, 40);
  const x = lerData(k, v);
  if (x.hh === undefined) throw new ErroAcao(`"${k}" precisa de data e hora: AAAA-MM-DDTHH:MM`);
  if (x.zona) return { dateTime: iso(instante({ [k]: v }, k, 'UTC', false)!).slice(0, -1), timeZone: 'UTC' };
  return { dateTime: `${x.y}-${dois(x.mo)}-${dois(x.dd)}T${dois(x.hh)}:${dois(x.mm!)}:${dois(x.ss)}`, timeZone: fuso };
}
function fusoDe(c: CtxAcao, a: Args): string {
  const f = txt(a, 'fuso', 80)?.trim() || c.tz;
  if (!/^[\w+\-/ ().,:]{1,64}$/.test(f)) throw new ErroAcao('"fuso" inválido: use, por exemplo, America/Sao_Paulo');
  return f;
}

// ------------------------------------------------------------------------------------------------- texto
const emHtml = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r\n|\r|\n/g, '<br>');
const corpoDe = (b: any): string => (String(b?.contentType ?? '').toLowerCase() === 'html' ? htmlParaTexto(String(b?.content ?? '')) : String(b?.content ?? ''));
/** Texto novo em cima do corpo HTML que já existe: histórico do e-mail ou o bloco da reunião online. */
function emCimaDoHtml(texto: string, original: unknown): string {
  const novo = `<div>${emHtml(texto)}</div><br>`;
  const o = String(original ?? '');
  const m = /<body[^>]*>/i.exec(o);
  return m ? `${o.slice(0, m.index + m[0].length)}${novo}${o.slice(m.index + m[0].length)}` : `${novo}${o}`;
}
const quem = (e: any): string => {
  const n = e?.name ? d(e.name, 80) : ''; const m = e?.address ? d(e.address, 120) : '';
  return n && m && n !== m ? `${n} <${m}>` : n || m || '?';
};
const varios = (l: unknown, teto = 6): string => {
  const x = Array.isArray(l) ? l : [];
  const t = x.slice(0, teto).map((r: any) => quem(r?.emailAddress)).join(', ');
  return x.length > teto ? `${t} e mais ${x.length - teto}` : t;
};

// ------------------------------------------------------------------------------------------------- e-mail
/** Palavras seguras para a consulta KQL: sem aspas, sem operadores nem ":" que mudariam o sentido do pedido. */
const palavras = (x: string | undefined): string[] => (x ?? '').split(/[\s"\\():<>=*,;&|]+/)
  .map((p) => p.replace(/^[-+]+/, '')).filter(Boolean).map((p) => (/^(AND|OR|NOT|NEAR|ONEAR)$/.test(p) ? p.toLowerCase() : p));
/** Cada palavra com a propriedade e `AND` explícito: dentro de $search não há aspas aninhadas para errar. */
const noCampo = (campo: string, x: string | undefined) => palavras(x).map((p) => `${campo}:${p}`);
const ehEmail = (x: string) => /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/.test(x);

/**
 * Pastas com nome de uso diário valem em português; o resto é id ou nome exato. Inclui as subpastas: "qualquer pasta"
 * (api/user-list-mailfolders devolve só o primeiro nível e manda percorrer o resto).
 */
const PASTA_CONHECIDA: Record<string, string> = {
  inbox: 'inbox', entrada: 'inbox', 'caixa de entrada': 'inbox', sentitems: 'sentitems', enviados: 'sentitems', enviadas: 'sentitems', 'itens enviados': 'sentitems',
  drafts: 'drafts', rascunho: 'drafts', rascunhos: 'drafts', deleteditems: 'deleteditems', lixeira: 'deleteditems', excluidos: 'deleteditems', 'itens excluidos': 'deleteditems',
  junkemail: 'junkemail', spam: 'junkemail', 'lixo eletronico': 'junkemail', archive: 'archive', arquivo: 'archive', arquivados: 'archive', 'arquivo morto': 'archive',
  outbox: 'outbox', 'caixa de saida': 'outbox', clutter: 'clutter',
};
const pareceId = (x: string) => /^[A-Za-z0-9_\-+/=]{40,}$/.test(x);
interface Pasta { id: string; nome: string; caminho: string; total: number; naoLidos: number }
async function todasPastas(c: CtxAcao): Promise<Pasta[]> {
  const fila: Array<{ url: string; pai: string }> = [{ url: `${GRAPH}/me/mailFolders?${qs({ $select: SEL_PASTA, $top: 100 })}`, pai: '' }];
  const out: Pasta[] = [];
  for (let i = 0; i < fila.length && i < 60 && out.length < 500; i++) {
    for (const p of await paginas(c, fila[i].url)) {
      const nome = String(p.displayName ?? '');
      const caminho = fila[i].pai ? `${fila[i].pai}/${nome}` : nome;
      out.push({ id: String(p.id), nome, caminho, total: Number(p.totalItemCount ?? 0), naoLidos: Number(p.unreadItemCount ?? 0) });
      if (Number(p.childFolderCount ?? 0) > 0) fila.push({ url: `${GRAPH}/me/mailFolders/${seg(p.id)}/childFolders?${qs({ $select: SEL_PASTA, $top: 100 })}`, pai: caminho });
    }
  }
  return out;
}
async function pastaId(c: CtxAcao, valor: string): Promise<string> {
  const v = valor.trim(); const f = fold(v);
  if (PASTA_CONHECIDA[f]) return PASTA_CONHECIDA[f];
  if (pareceId(v)) return v;
  const todas = await todasPastas(c);
  const certo = todas.filter((p) => p.id === v || fold(p.nome) === f || fold(p.caminho) === f);
  if (certo.length === 1) return certo[0].id;
  throw new ErroAcao(certo.length ? `mais de uma pasta chamada "${d(v, 60)}": diga o caminho inteiro` : `não achei a pasta "${d(v, 60)}"`, (certo.length ? certo : todas).map((p) => d(p.caminho, 120)));
}
/**
 * Mover é "organizar" e não pede confirmação; apagar sempre pede (regra.ts). Itens Excluídos e Lixo Eletrônico se esvaziam
 * sozinhos, então mover para lá é apagar, e isso vale para as subpastas deles; a Caixa de Saída é o caminho do envio. Vale também
 * pelo nome ("Deleted Items": muda com o idioma da caixa) e pelo id, por isso a comparação com o id real de cada uma (só o serviço
 * sabe), subindo por parentFolderId até msgfolderroot, a pasta acima das que o Outlook mostra. Sem chegar lá, não move.
 */
const FORA_DE_MOVER = ['deleteditems', 'junkemail', 'outbox'];
const MAX_NIVEIS = 32;
async function destinoDeMover(c: CtxAcao, valor: string): Promise<{ id: string; nome: string }> {
  const recusa = () => new ErroAcao('mandar para a lixeira ou para o lixo eletrônico, ou para uma subpasta deles, é apagar: use email.apagar, que pede confirmação; a caixa de saída é só do envio; nada foi feito');
  const destino = await pastaId(c, valor);
  if (FORA_DE_MOVER.includes(destino)) throw recusa();
  if (Object.values(PASTA_CONHECIDA).includes(destino)) return { id: destino, nome: valor.trim() };
  const [raiz, ...reais] = await Promise.all(['msgfolderroot', ...FORA_DE_MOVER].map((nome) => c.http(`${GRAPH}/me/mailFolders/${nome}?${qs({ $select: 'id' })}`).catch((e: unknown) => {
    if (e instanceof ProviderError && e.kind === 'not_found') return null; // esta caixa não tem essa pasta
    throw e; // sem saber qual é a lixeira, não move
  })));
  const proibidas = new Set(reais.filter((p) => p?.id).map((p) => String(p.id)));
  const vistas = new Set<string>();
  let atual = destino; let nome = '';
  for (let i = 0; i < MAX_NIVEIS && !vistas.has(atual); i++) {
    if (proibidas.has(atual)) throw recusa();
    if (raiz?.id && atual === String(raiz.id)) return { id: destino, nome: nome || valor.trim() };
    vistas.add(atual);
    const p = await c.http(`${GRAPH}/me/mailFolders/${seg(atual)}?${qs({ $select: 'id,displayName,parentFolderId' })}`);
    if (i === 0) nome = String(p.displayName ?? '');
    if (!p.parentFolderId) return { id: destino, nome: nome || valor.trim() };
    atual = String(p.parentFolderId);
  }
  throw new ErroAcao('não deu para conferir de onde é a pasta de destino: nada foi feito');
}

/**
 * Sem texto: $filter. Regra documentada (api/user-list-messages): a propriedade do $orderby tem de aparecer primeiro no
 * $filter, senão InefficientFilter; por isso "de" ou "não lidos" sem data pedida levam o piso DESDE_SEMPRE na frente.
 */
function buscaPorFiltro(base: string, x: { limite: number; desde?: number; ate?: number; de?: string; naoLidos: boolean }): string {
  const datas: string[] = [];
  if (x.desde !== undefined) datas.push(`receivedDateTime ge ${iso(x.desde)}`);
  if (x.ate !== undefined) datas.push(`receivedDateTime le ${iso(x.ate)}`);
  const resto = [...(x.de ? [`from/emailAddress/address eq '${odata(x.de)}'`] : []), ...(x.naoLidos ? ['isRead eq false'] : [])];
  if (resto.length && !datas.length) datas.push(`receivedDateTime ge ${DESDE_SEMPRE}`);
  const filtro = [...datas, ...resto].join(' and ') || undefined;
  return `${base}?${qs({ $filter: filtro, $orderby: 'receivedDateTime desc', $select: SEL_EMAIL, $top: x.limite })}`;
}
/**
 * Com texto: $search, que não combina com $filter nem $orderby. As datas vão na consulta com folga de um dia (a KQL não
 * tem hora e o fuso dela não é o da pessoa) e a conferência exata é feita aqui, junto com "não lidos".
 */
function buscaPorTexto(base: string, x: { limite: number; texto?: string; de?: string; para?: string; assunto?: string; desde?: number; ate?: number }): string {
  const dia = (t: number) => iso(t).slice(0, 10);
  const kql = [
    ...palavras(x.texto), ...noCampo('from', x.de), ...noCampo('to', x.para), ...noCampo('subject', x.assunto),
    ...(x.desde !== undefined ? [`received>=${dia(x.desde - DIA_MS)}`] : []), ...(x.ate !== undefined ? [`received<=${dia(x.ate + DIA_MS)}`] : []),
  ];
  return `${base}?${qs({ $search: `"${kql.join(' AND ')}"`, $select: SEL_EMAIL, $top: x.limite })}`;
}
const linhaEmail = (m: any, tz: string): string => [
  `- id=${d(m.id, 512)}`, dataHora(tz, Date.parse(m.receivedDateTime)), `de ${quem(m.from?.emailAddress)}`, `para ${varios(m.toRecipients)}`,
  `assunto: ${d(m.subject, 200)}`, m.isRead === false ? 'não lido' : 'lido', ...(m.hasAttachments ? ['com anexo'] : []), `prévia: ${d(m.bodyPreview, 300)}`,
].join(' | ');

/** O mesmo erro, com o aviso do que ficou feito: "sem permissão" continua pedindo nova autorização. */
const comAviso = (e: unknown, aviso: string): Error => (e instanceof ProviderError
  ? new ProviderError(e.kind, `${e.message}. ${aviso}`, { reauth: e.reauth, status: e.status ?? undefined })
  : new ErroAcao(`${e instanceof Error ? e.message : 'erro'}. ${aviso}`));
const endereco = (r: any): string => String(r?.emailAddress?.address ?? '').trim();
const chave = (r: any): string => endereco(r).toLowerCase();
const unicos = (l: any[]): any[] => {
  const vistos = new Set<string>();
  return l.filter((r) => { const k = chave(r); if (!k || vistos.has(k)) return false; vistos.add(k); return true; });
};
const soEnderecos = (l: any[]): string => unicos(l).map((r) => d(endereco(r), 120)).join(', ');
const mesmos = (a: any[], b: any[]): boolean => unicos(a).map(chave).sort().join() === unicos(b).map(chave).sort().join();
/**
 * Quem recebe a resposta, decidido aqui a partir do e-mail original, igual no cartão e no envio. A documentação diz que o
 * replyTo fica a cargo de quem responde (message-createreply: "you should send the reply to the recipients in replyTo"), então
 * o rascunho que o serviço devolve não é prova de nada. E-mail que a própria conta mandou segue para quem o recebeu.
 */
async function destinoDaResposta(c: CtxAcao, id: string, todos: boolean): Promise<{ original: any; para: any[]; cc: any[]; desviada: boolean }> {
  const [m, eu] = await Promise.all([
    c.http(`${GRAPH}/me/messages/${seg(id)}?${qs({ $select: 'id,subject,from,sender,replyTo,toRecipients,ccRecipients,receivedDateTime' })}`),
    c.http(`${GRAPH}/me?${qs({ $select: 'mail,userPrincipalName' })}`),
  ]);
  const minhas = new Set([eu?.mail, eu?.userPrincipalName].filter(Boolean).map((x) => String(x).toLowerCase()));
  const naoSouEu = (r: any) => !minhas.has(chave(r));
  const quemEscreveu = unicos([m.from ?? m.sender]);
  const pedido = unicos(m.replyTo ?? []);
  const autor = pedido.length ? pedido : quemEscreveu;
  const destinos = unicos(m.toRecipients ?? []);
  let para = autor.filter(naoSouEu);
  if (!para.length) para = destinos.filter(naoSouEu);
  if (!para.length) para = autor;
  if (!para.length) throw new ErroAcao('não achei para quem responder neste e-mail: use email.enviar dizendo o destinatário');
  if (todos) para = unicos([...para, ...destinos.filter(naoSouEu)]);
  const jaVai = new Set(para.map(chave));
  const cc = todos ? unicos(m.ccRecipients ?? []).filter((r) => naoSouEu(r) && !jaVai.has(chave(r))) : [];
  const autores = new Set(quemEscreveu.map(chave));
  return { original: m, para, cc, desviada: autor.some((r) => !autores.has(chave(r))) };
}
/**
 * Rascunho de resposta com o texto no corpo, sobre o histórico: o `comment` do createReply não entra no corpo do rascunho
 * (known-issues), e a documentação não diz se o `comment` do reply é texto ou HTML. Assim, o que a pessoa leu é o que sai.
 */
async function rascunhoDeResposta(c: CtxAcao, id: string, texto: string, todos: boolean): Promise<any> {
  const alvo = await destinoDaResposta(c, id, todos);
  const r = await c.http(`${GRAPH}/me/messages/${seg(id)}/${todos ? 'createReplyAll' : 'createReply'}`, { method: 'POST', kind: 'write' });
  if (!r?.id) throw new ProviderError('unavailable', 'o serviço não devolveu o rascunho da resposta');
  const emTexto = String(r.body?.contentType ?? 'html').toLowerCase() === 'text';
  const corpo = emTexto ? { contentType: 'Text', content: `${texto}\n\n${String(r.body?.content ?? '')}` } : { contentType: 'HTML', content: emCimaDoHtml(texto, r.body?.content) };
  const certos = mesmos(r.toRecipients ?? [], alvo.para) && mesmos(r.ccRecipients ?? [], alvo.cc);
  const quemRecebe = certos ? {} : { toRecipients: paraRecip(alvo.para.map(endereco)), ccRecipients: paraRecip(alvo.cc.map(endereco)) };
  try { await c.http(`${GRAPH}/me/messages/${seg(r.id)}`, { method: 'PATCH', body: { body: corpo, ...quemRecebe }, kind: 'write' }); } catch (e) {
    throw comAviso(e, `Nada foi enviado; um rascunho sem o texto ficou em Rascunhos (id=${d(r.id, 512)})`);
  }
  return { ...r, toRecipients: alvo.para, ccRecipients: alvo.cc };
}
const destinoDe = (m: any): string => [varios(m?.toRecipients, 20), varios(m?.ccRecipients, 20) && `cópia: ${varios(m?.ccRecipients, 20)}`].filter(Boolean).join('; ') || 'destinatários definidos pelo Outlook';
/** O cartão de quem responde: no destino, só o endereço (o nome é o remetente quem escolhe). Rascunho não sai, então não obriga confirmar. */
async function cartaoDaResposta(c: CtxAcao, a: Args, sai: boolean): Promise<{ detalhe: string; confirmar?: string }> {
  inteiro(a, 'texto', MAX_EMAIL);
  const x = await destinoDaResposta(c, precisa(a, 'id', 2000), sim(a, 'todos'));
  const detalhe = [
    `A resposta vai para: ${soEnderecos(x.para)}.`, ...(x.cc.length ? [`Em cópia: ${soEnderecos(x.cc)}.`] : []),
    `Responde ao e-mail "${d(x.original.subject, 300)}", de ${quem((x.original.from ?? x.original.sender)?.emailAddress)}, recebido em ${dataHora(c.tz, Date.parse(x.original.receivedDateTime))}.`,
  ].join('\n');
  return { detalhe, ...(sai && x.desviada ? { confirmar: 'o e-mail pede resposta para outro endereço, diferente de quem o enviou' } : {}) };
}
/** Assunto e remetente, para quem vai apagar ou mover um e-mail que só conhece pelo id. */
async function emailNoCartao(c: CtxAcao, id: string): Promise<string> {
  const m = await c.http(`${GRAPH}/me/messages/${seg(id)}?${qs({ $select: 'id,subject,from,sender,receivedDateTime' })}`);
  return `E-mail "${d(m.subject, 300)}", de ${quem((m.from ?? m.sender)?.emailAddress)}, recebido em ${dataHora(c.tz, Date.parse(m.receivedDateTime))}.`;
}
/** O rascunho como está: destinatários, inclusive cópia oculta, texto e anexos, e a impressão do que foi visto (conferida no clique). */
async function lerRascunho(c: CtxAcao, id: string): Promise<{ m: any; reais: string[]; corpo: string; anexos: string[]; marca: string }> {
  const m = await c.http(`${GRAPH}/me/messages/${seg(id)}?${qs({ $select: 'id,isDraft,subject,toRecipients,ccRecipients,bccRecipients,hasAttachments,body' })}`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  if (m.isDraft !== true) throw new ErroAcao('este e-mail não é um rascunho: nada foi enviado');
  const reais = ([] as any[]).concat(m.toRecipients ?? [], m.ccRecipients ?? [], m.bccRecipients ?? []).map(endereco).filter(Boolean);
  if (!reais.length) throw new ErroAcao('o rascunho não tem destinatário: nada foi enviado');
  let anexos: string[] = [];
  if (m.hasAttachments) {
    const j = await c.http(`${GRAPH}/me/messages/${seg(id)}/attachments?${qs({ $select: 'name,size,isInline', $top: 50 })}`);
    anexos = ((j.value ?? []) as any[]).filter((x) => !x.isInline).map((x) => String(x.name ?? ''));
  }
  const corpo = corpoDe(m.body);
  return { m, reais, corpo, anexos, marca: marcaDe([m.subject, ...[m.toRecipients, m.ccRecipients, m.bccRecipients].map((l) => unicos(l ?? []).map(chave)), corpo, anexos]) };
}
const grupo = (l: string[]) => [...new Set(l.map((e) => e.toLowerCase()))].sort().join();
const ditosDoRascunho = (a: Args): string[] => {
  const ditos = destinatarios(a, 'para');
  if (!ditos.length) throw new ErroAcao('falta "para"');
  return ditos;
};
function conferirDestinatarios(ditos: string[], reais: string[]): void {
  if (grupo(ditos) !== grupo(reais)) throw new ErroAcao('"para" não é a lista de destinatários deste rascunho: nada foi enviado; repita dizendo a lista real', reais.slice(0, 100).map((e) => d(e, 120)));
}

const P_ID_EMAIL: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id do e-mail (vem de email.buscar)' };
const P_PARA: Param = { tipo: 'lista', obrigatorio: true, descricao: 'e-mails de quem recebe; use pessoas.buscar para achar pelo nome' };
const P_CC: Param = { tipo: 'lista', descricao: 'e-mails em cópia' };
const P_ASSUNTO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'assunto' };
const P_TEXTO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'texto, sem formatação' };
const P_TODOS: Param = { tipo: 'booleano', descricao: 'true = responde a todos do e-mail original' };
const ESCOPO_LER_EMAIL = ['Mail.Read'];
const ESCOPO_LER_AGENDA = ['Calendars.Read'];

const ACOES_EMAIL: Acao[] = [
  {
    id: 'email.buscar', risco: 'ler', escopos: ESCOPO_LER_EMAIL,
    descricao: 'procura e-mails em toda a caixa, em qualquer pasta e de qualquer época, inclusive "Outros" (não há período padrão); com texto, a Microsoft devolve no máximo 1.000 resultados',
    params: {
      texto: { tipo: 'texto', descricao: 'palavras em qualquer parte (remetente, assunto, corpo)' },
      de: { tipo: 'texto', descricao: 'quem enviou: e-mail ou nome' }, para: { tipo: 'texto', descricao: 'quem recebeu: e-mail ou nome' }, assunto: { tipo: 'texto', descricao: 'palavras do assunto' },
      pasta: { tipo: 'texto', descricao: 'nome ou id da pasta (entrada, enviados, rascunhos, lixeira, spam ou uma sua)' },
      desde: { tipo: 'texto', descricao: 'data inicial, AAAA-MM-DD' }, ate: { tipo: 'texto', descricao: 'data final, AAAA-MM-DD' },
      nao_lidos: { tipo: 'booleano', descricao: 'só os não lidos' }, limite: { tipo: 'numero', descricao: 'quantos por página (padrão 25, até 100)' }, cursor: { tipo: 'texto', descricao: 'continuação devolvida pela busca anterior' },
    },
    resumo: (a) => `Buscar e-mails${s(a, 'texto') ? ` com "${s(a, 'texto')}"` : ''}${s(a, 'de') ? ` de ${s(a, 'de')}` : ''}${s(a, 'para') ? ` para ${s(a, 'para')}` : ''}${s(a, 'assunto') ? ` com assunto "${s(a, 'assunto')}"` : ''}`,
    async run(c, a) {
      const cur = await abreCursor(c, a, 'email');
      let url: string; let conferir: { desde?: number; ate?: number; naoLidos?: boolean } | null = null;
      if (cur) {
        url = cur.u;
        if (cur.desde !== undefined || cur.ate !== undefined || cur.naoLidos) conferir = { desde: cur.desde, ate: cur.ate, naoLidos: cur.naoLidos };
      } else {
        const limite = num(a, 'limite', 25, 100);
        const texto = txt(a, 'texto', 300)?.trim(); const de = txt(a, 'de', 200)?.trim(); const para = txt(a, 'para', 200)?.trim(); const assunto = txt(a, 'assunto', 300)?.trim();
        const { desde, ate } = periodo(a, c.tz); const naoLidos = sim(a, 'nao_lidos');
        const pasta = txt(a, 'pasta', 400)?.trim();
        const base = pasta ? `${GRAPH}/me/mailFolders/${seg(await pastaId(c, pasta))}/messages` : `${GRAPH}/me/messages`;
        if (texto || para || assunto || (de && !ehEmail(de))) {
          if (![...palavras(texto), ...palavras(de), ...palavras(para), ...palavras(assunto)].length) throw new ErroAcao('a busca não tem nenhuma palavra: diga o que procurar');
          url = buscaPorTexto(base, { limite, texto, de, para, assunto, desde, ate });
          if (desde !== undefined || ate !== undefined || naoLidos) conferir = { desde, ate, naoLidos };
        } else url = buscaPorFiltro(base, { limite, desde, ate, de, naoLidos });
      }
      const j = await c.http(url);
      const todos = (j.value ?? []) as any[];
      const fica = conferir
        ? todos.filter((m) => {
          const at = Date.parse(m.receivedDateTime);
          return (conferir.desde === undefined || at >= conferir.desde) && (conferir.ate === undefined || at <= conferir.ate) && (!conferir.naoLidos || m.isRead === false);
        })
        : todos;
      const cursor = proximo(j, 'email', conferir ?? {});
      const fora = todos.length - fica.length;
      const nota = fora ? `\n(${fora} desta página não entraram por data ou por já estarem lidos.)` : '';
      if (!fica.length) return lido(`Nenhum e-mail ${cursor ? 'nesta página' : 'encontrado'}.${nota}${rodape(cursor)}`);
      const v = caber(fica.map((m) => linhaEmail(m, c.tz)));
      return lido(`${v.linhas.length} e-mail(s):\n${v.linhas.join('\n')}${nota}${v.nota}${rodape(cursor)}`);
    },
  },
  {
    id: 'email.ler', risco: 'ler', escopos: ESCOPO_LER_EMAIL, descricao: 'lê um e-mail: corpo em texto (até 12.000 caracteres) e nomes dos anexos', params: { id: P_ID_EMAIL },
    resumo: (a) => `Ler o e-mail ${s(a, 'id')}`,
    async run(c, a) {
      const id = precisa(a, 'id', 2000);
      const m = await c.http(`${GRAPH}/me/messages/${seg(id)}?${qs({ $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,isDraft,hasAttachments,body,webLink' })}`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
      let anexos: string[] = [];
      if (m.hasAttachments) {
        const j = await c.http(`${GRAPH}/me/messages/${seg(id)}/attachments?${qs({ $select: 'name,size,isInline', $top: 50 })}`);
        anexos = ((j.value ?? []) as any[]).filter((x) => !x.isInline).map((x) => d(x.name, 120));
      }
      const corpo = corpoDe(m.body);
      return lido([
        `Assunto: ${d(m.subject, 300)}`, `De: ${quem(m.from?.emailAddress)}`, `Para: ${varios(m.toRecipients, 20)}`, ...(m.ccRecipients?.length ? [`Cópia: ${varios(m.ccRecipients, 20)}`] : []),
        `Data: ${dataHora(c.tz, Date.parse(m.receivedDateTime))}${m.isDraft ? ' (rascunho)' : ''}`, `Anexos: ${anexos.length ? anexos.join(', ') : 'nenhum'}`,
        `Corpo${corpo.length > MAX_CORPO ? ` (só os primeiros ${MAX_CORPO} caracteres)` : ''}: ${d(corpo, MAX_CORPO)}`,
      ].join('\n'), m.webLink);
    },
  },
  {
    id: 'email.pastas', risco: 'ler', escopos: ESCOPO_LER_EMAIL, descricao: 'lista as pastas e subpastas do e-mail, com o total e os não lidos', params: {},
    resumo: () => 'Listar as pastas do e-mail',
    async run(c) {
      const todas = await todasPastas(c);
      return lido(todas.length ? todas.map((p) => `- ${d(p.caminho, 200)} | ${p.total} itens, ${p.naoLidos} não lidos | id=${d(p.id, 512)}`).join('\n') : 'Nenhuma pasta encontrada.');
    },
  },
  {
    id: 'email.rascunho', risco: 'organizar', escopos: ['Mail.ReadWrite'], descricao: 'salva um e-mail em Rascunhos, sem enviar; devolve o endereço para abrir no Outlook',
    params: { para: { ...P_PARA, obrigatorio: false }, cc: P_CC, assunto: P_ASSUNTO, texto: P_TEXTO },
    resumo: (a) => `Salvar rascunho (sem enviar)${emLista(a, 'para') ? ` para ${emLista(a, 'para')}` : ''}${emLista(a, 'cc') ? `, cópia para ${emLista(a, 'cc')}` : ''}. Assunto: "${umaLinha(s(a, 'assunto'))}". Texto: "${s(a, 'texto')}"`,
    async run(c, a) {
      const para = destinatarios(a, 'para'); const cc = destinatarios(a, 'cc');
      const m = await c.http(`${GRAPH}/me/messages`, { method: 'POST', kind: 'write', body: {
        subject: assuntoDe(a), body: { contentType: 'Text', content: inteiro(a, 'texto', MAX_EMAIL) },
        ...(para.length ? { toRecipients: paraRecip(para) } : {}), ...(cc.length ? { ccRecipients: paraRecip(cc) } : {}),
      } });
      return { texto: `Rascunho salvo, nada foi enviado. id=${String(m.id ?? '')}`, url: m.webLink ?? null };
    },
  },
  {
    id: 'email.rascunho_resposta', risco: 'organizar', escopos: ['Mail.ReadWrite', 'User.Read'], descricao: 'salva uma resposta em Rascunhos, sem enviar (quem recebe vem do e-mail original)', params: { id: P_ID_EMAIL, texto: P_TEXTO, todos: P_TODOS },
    resumo: (a) => `Salvar rascunho (sem enviar) de resposta ${sim(a, 'todos') ? 'a todos do' : 'ao remetente do'} e-mail ${s(a, 'id')}; quem recebe vem do e-mail original. Texto: "${s(a, 'texto')}"`,
    preparar: (c, a) => cartaoDaResposta(c, a, false),
    async run(c, a) {
      const r = await rascunhoDeResposta(c, precisa(a, 'id', 2000), inteiro(a, 'texto', MAX_EMAIL), sim(a, 'todos'));
      return { texto: `Rascunho de resposta salvo, nada foi enviado. Iria para: ${destinoDe(r)}. id=${d(r.id, 512)}`, url: r.webLink ?? null, deFora: true, privado: true };
    },
  },
  {
    id: 'email.enviar', risco: 'enviar', escopos: ['Mail.Send'], descricao: 'envia um e-mail novo em nome da pessoa', params: { para: P_PARA, cc: P_CC, assunto: P_ASSUNTO, texto: P_TEXTO },
    resumo: (a) => `Enviar e-mail para ${emLista(a, 'para') || '(sem destinatário)'}${emLista(a, 'cc') ? `, cópia para ${emLista(a, 'cc')}` : ''}. Assunto: "${umaLinha(s(a, 'assunto'))}". Texto: "${s(a, 'texto')}"`,
    async run(c, a) {
      const para = destinatarios(a, 'para'); const cc = destinatarios(a, 'cc');
      if (!para.length) throw new ErroAcao('falta "para"');
      const assunto = assuntoDe(a);
      await c.http(`${GRAPH}/me/sendMail`, { method: 'POST', kind: 'write', body: { message: {
        subject: assunto, body: { contentType: 'Text', content: inteiro(a, 'texto', MAX_EMAIL) }, toRecipients: paraRecip(para), ...(cc.length ? { ccRecipients: paraRecip(cc) } : {}),
      } } });
      return { texto: `O serviço aceitou o envio para ${para.join(', ')}${cc.length ? ` (cópia: ${cc.join(', ')})` : ''}, assunto "${assunto}".`, url: null };
    },
  },
  {
    id: 'email.responder', risco: 'enviar', escopos: ['Mail.ReadWrite', 'Mail.Send', 'User.Read'], descricao: 'responde a um e-mail; quem recebe vem do próprio e-mail, nunca do agente', params: { id: P_ID_EMAIL, texto: P_TEXTO, todos: P_TODOS },
    resumo: (a) => `Responder ${sim(a, 'todos') ? 'a todos do' : 'ao remetente do'} e-mail ${s(a, 'id')}; quem recebe vem do e-mail original. Texto: "${s(a, 'texto')}"`,
    preparar: (c, a) => cartaoDaResposta(c, a, true),
    async run(c, a) {
      const r = await rascunhoDeResposta(c, precisa(a, 'id', 2000), inteiro(a, 'texto', MAX_EMAIL), sim(a, 'todos'));
      try { await c.http(`${GRAPH}/me/messages/${seg(r.id)}/send`, { method: 'POST', kind: 'write' }); } catch (e) {
        throw comAviso(e, `Se não saiu, a resposta está em Rascunhos (id=${d(r.id, 512)}): confira lá antes de repetir`);
      }
      return { texto: `O serviço aceitou a resposta para ${destinoDe(r)}.`, url: null, deFora: true, privado: true };
    },
  },
  {
    // Rascunho não pede confirmação, e o cartão só vê os parâmetros: sem "para", um rascunho escrito a mando de um e-mail
    // malicioso sairia com um clique às cegas. Quem recebe vai no cartão, e o que foi mostrado é conferido com o rascunho.
    id: 'email.enviar_rascunho', risco: 'enviar', escopos: ['Mail.ReadWrite', 'Mail.Send'], descricao: 'envia um rascunho que já existe, como está; diga em "para" todos os destinatários dele', rotulo: 'envia um rascunho que já existe, como está',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do rascunho' }, para: { tipo: 'lista', obrigatorio: true, descricao: 'todos os e-mails que o rascunho alcança (para, cópia e cópia oculta): aparecem no cartão de confirmação e são conferidos com o rascunho antes de enviar' } },
    resumo: (a) => `Enviar o rascunho ${s(a, 'id')} para ${emLista(a, 'para') || '(sem destinatário)'}, como está salvo no Outlook. O sistema confere estes destinatários com o rascunho; o texto é o que está lá`,
    async preparar(c, a) {
      const id = precisa(a, 'id', 2000);
      const ditos = ditosDoRascunho(a);
      const r = await lerRascunho(c, id);
      conferirDestinatarios(ditos, r.reais);
      const linha = (rot: string, l: any) => (l?.length ? [`${rot}: ${soEnderecos(l)}.`] : []);
      return { args: { ...a, visto: r.marca }, detalhe: [
        ...linha('Vai para', r.m.toRecipients), ...linha('Em cópia', r.m.ccRecipients), ...linha('Em cópia oculta', r.m.bccRecipients),
        `Assunto: "${d(r.m.subject, MAX_ASSUNTO)}".`, ...(r.anexos.length ? [`Anexos: ${r.anexos.map((x) => d(x, 160)).join(', ')}.`] : []),
        `Texto do rascunho${r.corpo.length > MAX_EMAIL ? ` (só os primeiros ${MAX_EMAIL} caracteres; o resto está no rascunho)` : r.corpo.length > TEXTO_LONGO ? ` (${r.corpo.length} caracteres: abra "Ver o texto inteiro" no cartão antes de confirmar)` : ''}: "${d(r.corpo, MAX_EMAIL)}"`,
      ].join('\n') };
    },
    async run(c, a) {
      const id = precisa(a, 'id', 2000);
      const ditos = ditosDoRascunho(a);
      const r = await lerRascunho(c, id);
      conferirDestinatarios(ditos, r.reais);
      // o clique envia o que a pessoa leu: mudou depois do cartão, ela precisa ver de novo
      if (a.visto !== undefined && a.visto !== r.marca) throw new ErroAcao('o rascunho mudou depois do cartão de confirmação: nada foi enviado; peça de novo, para a pessoa ver como ele está agora');
      await c.http(`${GRAPH}/me/messages/${seg(id)}/send`, { method: 'POST', kind: 'write' });
      return { texto: `O serviço aceitou o envio do rascunho para ${destinoDe(r.m)}.`, url: null, deFora: true, privado: true };
    },
  },
  {
    id: 'email.mover', risco: 'organizar', escopos: ['Mail.ReadWrite'], descricao: 'move um e-mail para outra pasta (o id muda: o novo vem na resposta); para a lixeira ou o lixo eletrônico, use email.apagar', rotulo: 'move um e-mail para outra pasta',
    params: { id: P_ID_EMAIL, pasta: { tipo: 'texto', obrigatorio: true, descricao: 'nome ou id da pasta de destino' } },
    resumo: (a) => `Mover o e-mail ${s(a, 'id')} para a pasta "${s(a, 'pasta')}"`,
    async preparar(c, a) {
      const destino = await destinoDeMover(c, precisa(a, 'pasta', 400));
      const email = await emailNoCartao(c, precisa(a, 'id', 2000));
      return { args: { ...a, pasta: destino.id }, detalhe: `${email}\nVai para a pasta "${d(destino.nome, 200)}".` };
    },
    async run(c, a) {
      const id = precisa(a, 'id', 2000);
      const destino = await destinoDeMover(c, precisa(a, 'pasta', 400));
      const m = await c.http(`${GRAPH}/me/messages/${seg(id)}/move`, { method: 'POST', kind: 'write', body: { destinationId: destino.id } });
      return { texto: `E-mail movido. Novo id=${String(m.id ?? '')}`, url: m.webLink ?? null };
    },
  },
  {
    id: 'email.apagar', risco: 'apagar', escopos: ['Mail.ReadWrite'], descricao: 'manda um e-mail para Itens Excluídos (dá para recuperar de lá)', params: { id: P_ID_EMAIL },
    resumo: (a) => `Apagar o e-mail ${s(a, 'id')}: ele vai para Itens Excluídos e dá para recuperar de lá`,
    preparar: async (c, a) => ({ detalhe: await emailNoCartao(c, precisa(a, 'id', 2000)) }),
    async run(c, a) {
      // mover é o que a documentação garante que cai em Itens Excluídos (api/message-move); a de DELETE não diz para onde vai
      const m = await c.http(`${GRAPH}/me/messages/${seg(precisa(a, 'id', 2000))}/move`, { method: 'POST', kind: 'write', body: { destinationId: 'deleteditems' } });
      return { texto: `E-mail em Itens Excluídos. Novo id=${String(m.id ?? '')}`, url: m.webLink ?? null };
    },
  },
];

// ------------------------------------------------------------------------------------------------- agenda
async function agendaId(c: CtxAcao, valor: string): Promise<string> {
  const v = valor.trim();
  if (pareceId(v)) return v;
  const todas = await paginas(c, `${GRAPH}/me/calendars?${qs({ $select: 'id,name', $top: 100 })}`);
  const certo = todas.filter((x) => String(x.id) === v || fold(String(x.name ?? '')) === fold(v));
  if (certo.length === 1) return String(certo[0].id);
  throw new ErroAcao(certo.length ? `mais de uma agenda chamada "${d(v, 60)}"` : `não achei a agenda "${d(v, 60)}"`, todas.map((x) => d(x.name, 120)));
}
/** Reunião online com o que esta agenda permite: Teams em conta de trabalho, outro serviço em conta pessoal. */
async function provedorOnline(c: CtxAcao, agenda: string | null): Promise<string> {
  const cal = await c.http(`${GRAPH}${agenda ? `/me/calendars/${seg(agenda)}` : '/me/calendar'}?${qs({ $select: 'allowedOnlineMeetingProviders,defaultOnlineMeetingProvider' })}`);
  const pode = ((cal.allowedOnlineMeetingProviders ?? []) as unknown[]).map(String).filter((p) => p !== 'unknown');
  if (pode.includes(String(cal.defaultOnlineMeetingProvider))) return String(cal.defaultOnlineMeetingProvider);
  if (pode.length) return pode[0];
  throw new ErroAcao('esta agenda não permite reunião online: crie sem "online"');
}
function depoisDe(inicio: { dateTime: string; timeZone: string }, fim: { dateTime: string; timeZone: string }): void {
  if (inicio.timeZone === fim.timeZone && fim.dateTime <= inicio.dateTime) throw new ErroAcao('"fim" precisa ser depois de "inicio"');
}
const convida = (a: Args): boolean => lista(a, 'participantes', 500).length > 0;
const horarioDe = (e: any, tz: string): string => (e.isAllDay ? `${String(e.start?.dateTime ?? '').slice(0, 10)} dia todo` : `${dataHora(tz, emUtc(e.start?.dateTime))} até ${dataHora(tz, emUtc(e.end?.dateTime))}`);
/** Em UTC e convertido aqui, como em agenda.listar. */
const fichaEvento = (c: CtxAcao, id: string): Promise<any> => c.http(`${GRAPH}/me/events/${seg(id)}?${qs({ $select: 'subject,start,end,isAllDay,type,isOrganizer,organizer,attendees' })}`, { headers: { Prefer: 'outlook.timezone="UTC"' } });
const eventoNoCartao = (e: any, tz: string): string[] => [
  `Compromisso: "${d(e.subject, 300)}", ${horarioDe(e, tz)}.`, `Organiza: ${quem(e.organizer?.emailAddress)}.`, e.attendees?.length ? `Participantes: ${varios(e.attendees, 50)}.` : 'Sem participantes.',
  // cancelar a série apaga todas: o id de agenda.listar é o de uma ocorrência, mas nada obriga o agente a usar esse
  ...(e.type === 'seriesMaster' ? ['É uma série: vale para todas as ocorrências.'] : e.type === 'occurrence' || e.type === 'exception' ? ['Faz parte de uma série: muda só esta ocorrência.'] : []),
];
/** Confere a mudança antes de chamar qualquer coisa: o erro aparece antes do cartão, não depois do clique. */
function mudancaDoEvento(c: CtxAcao, a: Args): { campos: Record<string, unknown>; descricao?: string; online: boolean; avisa: boolean } {
  const fuso = fusoDe(c, a);
  const inicio = txt(a, 'inicio') ? quando(a, 'inicio', fuso) : undefined; const fim = txt(a, 'fim') ? quando(a, 'fim', fuso) : undefined;
  if (inicio && fim) depoisDe(inicio, fim);
  const convidados = destinatarios(a, 'participantes');
  const local = txt(a, 'local', 300); const descricao = opcional(a, 'descricao', MAX_DESCRICAO); const online = sim(a, 'online');
  const campos: Record<string, unknown> = {
    ...(txt(a, 'titulo') !== undefined ? { subject: assuntoDe(a, 'titulo') } : {}), ...(inicio ? { start: inicio } : {}), ...(fim ? { end: fim } : {}),
    ...(local !== undefined ? { location: { displayName: umaLinha(local) } } : {}),
    ...(convidados.length ? { attendees: convidados.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
  };
  if (!Object.keys(campos).length && descricao === undefined && !online) throw new ErroAcao('diga o que mudar: titulo, inicio, fim, local, descricao, participantes ou online');
  return { campos, descricao, online, avisa: convidados.length > 0 || sim(a, 'avisar_participantes') };
}
/** O risco é decidido só pelos parâmetros: alterar reunião de quem organiza avisa todos mesmo sem citar participantes. */
function exigeAviso(atual: any, avisa: boolean): void {
  const hoje = (atual.attendees ?? []) as any[];
  if (hoje.length && atual.isOrganizer !== false && !avisa) throw new ErroAcao(`este compromisso tem ${hoje.length} participante(s) e a mudança os avisa: repita com avisar_participantes=true`, hoje.slice(0, 30).map((x) => quem(x?.emailAddress)));
}
const P_INICIO: Param = { tipo: 'texto', descricao: 'início, AAAA-MM-DDTHH:MM' };
const P_FIM: Param = { tipo: 'texto', descricao: 'fim, AAAA-MM-DDTHH:MM' };
const P_FUSO: Param = { tipo: 'texto', descricao: 'fuso das horas (padrão: o da pessoa), ex.: America/Sao_Paulo' };
const P_LOCAL: Param = { tipo: 'texto', descricao: 'local' };
const P_DESC: Param = { tipo: 'texto', descricao: 'descrição' };
const P_ONLINE: Param = { tipo: 'booleano', descricao: 'true = reunião online' };
const eventoEmTexto = (a: Args): string => [
  s(a, 'inicio') && `de ${s(a, 'inicio')}`, s(a, 'fim') && `até ${s(a, 'fim')}`, s(a, 'fuso') && `(fuso ${s(a, 'fuso')})`, s(a, 'local') && `em "${umaLinha(s(a, 'local'))}"`, sim(a, 'online') && 'reunião online',
  s(a, 'descricao') && `descrição: "${s(a, 'descricao')}"`,
].filter(Boolean).join(', ');

const ACOES_AGENDA: Acao[] = [
  {
    id: 'agenda.calendarios', risco: 'ler', escopos: ESCOPO_LER_AGENDA, descricao: 'lista as agendas da conta', params: {},
    resumo: () => 'Listar as agendas',
    async run(c) {
      const todas = await paginas(c, `${GRAPH}/me/calendars?${qs({ $select: 'id,name,isDefaultCalendar,canEdit,owner', $top: 100 })}`);
      return lido(todas.length ? todas.map((x) => `- ${d(x.name, 120)}${x.isDefaultCalendar ? ' (principal)' : ''} | ${x.canEdit === false ? 'só leitura' : 'pode editar'} | de ${quem(x.owner)} | id=${d(x.id, 512)}`).join('\n') : 'Nenhuma agenda encontrada.');
    },
  },
  {
    id: 'agenda.listar', risco: 'ler', escopos: ESCOPO_LER_AGENDA, descricao: 'lista compromissos de um período (datas passadas valem; sem período, os próximos 7 dias), com participantes e descrição curta',
    params: {
      desde: { tipo: 'texto', descricao: 'data inicial, AAAA-MM-DD' }, ate: { tipo: 'texto', descricao: 'data final, AAAA-MM-DD' }, agenda: { tipo: 'texto', descricao: 'nome ou id da agenda (padrão: a principal)' },
      limite: { tipo: 'numero', descricao: 'quantos por página (padrão 50, até 200)' }, cursor: { tipo: 'texto', descricao: 'continuação devolvida pela chamada anterior' },
    },
    resumo: (a) => `Ver a agenda${s(a, 'desde') ? ` desde ${s(a, 'desde')}` : ''}${s(a, 'ate') ? ` até ${s(a, 'ate')}` : ''}`,
    async run(c, a) {
      const cur = await abreCursor(c, a, 'agenda');
      let url: string;
      if (cur) url = cur.u;
      else {
        const p = periodo(a, c.tz);
        const hoje = localParts(c.tz, Date.now());
        const desde = p.desde ?? (p.ate !== undefined ? p.ate - 7 * DIA_MS : zonedToUtc(c.tz, hoje.y, hoje.m, hoje.d, 0, 0));
        const ate = p.ate ?? desde + 7 * DIA_MS;
        const agenda = txt(a, 'agenda', 400)?.trim();
        const base = agenda ? `/me/calendars/${seg(await agendaId(c, agenda))}` : '/me';
        url = `${GRAPH}${base}/calendarView?${qs({ startDateTime: iso(desde), endDateTime: iso(ate), $select: SEL_EVENTO, $orderby: 'start/dateTime', $top: num(a, 'limite', 50, 200) })}`;
      }
      // em UTC e convertido aqui: o cabeçalho não se repete sozinho nas páginas seguintes
      const j = await c.http(url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      const linhas = ((j.value ?? []) as any[]).map((e) => [
        `- id=${d(e.id, 512)}`, horarioDe(e, c.tz), d(e.subject, 200),
        ...(e.isCancelled ? ['cancelado'] : []), ...(e.location?.displayName ? [`local: ${d(e.location.displayName, 120)}`] : []), ...(e.isOnlineMeeting ? ['online'] : []),
        `organiza: ${quem(e.organizer?.emailAddress)}`, ...(e.attendees?.length ? [`participantes: ${varios(e.attendees, 12)}`] : []), ...(e.bodyPreview ? [`descrição: ${d(e.bodyPreview, 300)}`] : []),
      ].join(' | '));
      const cursor = proximo(j, 'agenda');
      const v = caber(linhas);
      return lido(`${v.linhas.length ? `${v.linhas.length} compromisso(s):\n${v.linhas.join('\n')}` : 'Nenhum compromisso neste período.'}${v.nota}${rodape(cursor)}`);
    },
  },
  {
    id: 'agenda.criar', risco: (a) => (convida(a) ? 'enviar' : 'organizar'), escopos: ['Calendars.ReadWrite'], descricao: 'cria um compromisso; com participantes, o convite sai para eles na hora',
    params: {
      titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título' }, inicio: { ...P_INICIO, obrigatorio: true }, fim: { ...P_FIM, obrigatorio: true }, fuso: P_FUSO,
      participantes: { tipo: 'lista', descricao: 'e-mails de quem recebe o convite' }, local: P_LOCAL, descricao: P_DESC, online: P_ONLINE, agenda: { tipo: 'texto', descricao: 'nome ou id da agenda (padrão: a principal)' },
    },
    resumo: (a) => `Criar na agenda "${umaLinha(s(a, 'titulo'))}"${eventoEmTexto(a) ? `, ${eventoEmTexto(a)}` : ''}${convida(a) ? `. O convite será enviado para ${emLista(a, 'participantes')}` : ', sem convidar ninguém'}`,
    async preparar(c, a) {
      const nome = txt(a, 'agenda', 400)?.trim();
      if (!nome) return {};
      const agenda = await agendaId(c, nome);
      const cal = await c.http(`${GRAPH}/me/calendars/${seg(agenda)}?${qs({ $select: 'name' })}`);
      return { args: { ...a, agenda }, detalhe: `Na agenda "${d(cal.name, 120)}".` };
    },
    async run(c, a) {
      const fuso = fusoDe(c, a);
      const inicio = quando(a, 'inicio', fuso); const fim = quando(a, 'fim', fuso);
      depoisDe(inicio, fim);
      const convidados = destinatarios(a, 'participantes');
      const local = umaLinha(txt(a, 'local', 300) ?? ''); const descricao = opcional(a, 'descricao', MAX_DESCRICAO);
      const nome = txt(a, 'agenda', 400)?.trim();
      const agenda = nome ? await agendaId(c, nome) : null;
      const e = await c.http(`${GRAPH}${agenda ? `/me/calendars/${seg(agenda)}/events` : '/me/events'}`, { method: 'POST', kind: 'write', body: {
        subject: assuntoDe(a, 'titulo'), start: inicio, end: fim,
        ...(convidados.length ? { attendees: convidados.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
        ...(local ? { location: { displayName: local } } : {}), ...(descricao ? { body: { contentType: 'text', content: descricao } } : {}),
        ...(sim(a, 'online') ? { isOnlineMeeting: true, onlineMeetingProvider: await provedorOnline(c, agenda) } : {}),
      } });
      return { texto: `Compromisso criado${convidados.length ? `; convite enviado para ${convidados.join(', ')}` : ''}. id=${String(e.id ?? '')}${e.onlineMeeting?.joinUrl ? `. Entrar na reunião: ${String(e.onlineMeeting.joinUrl)}` : ''}`, url: e.webLink ?? null };
    },
  },
  {
    id: 'agenda.editar', risco: (a) => (convida(a) || sim(a, 'avisar_participantes') ? 'enviar' : 'organizar'), escopos: ['Calendars.ReadWrite'],
    descricao: 'altera um compromisso; se ele tem participantes, eles são avisados: isso precisa de avisar_participantes=true ou da nova lista em participantes', rotulo: 'altera um compromisso; se ele tem participantes, eles são avisados',
    params: {
      id: { tipo: 'texto', obrigatorio: true, descricao: 'id do compromisso (vem de agenda.listar)' }, titulo: { tipo: 'texto', descricao: 'título novo' }, inicio: P_INICIO, fim: P_FIM, fuso: P_FUSO,
      participantes: { tipo: 'lista', descricao: 'a lista inteira de participantes depois da mudança (substitui a atual)' }, avisar_participantes: { tipo: 'booleano', descricao: 'true = os participantes de hoje recebem o aviso da mudança' },
      local: P_LOCAL, descricao: P_DESC, online: P_ONLINE,
    },
    resumo: (a) => `Alterar o compromisso ${s(a, 'id')}${s(a, 'titulo') ? `: título "${umaLinha(s(a, 'titulo'))}"` : ''}${eventoEmTexto(a) ? `, ${eventoEmTexto(a)}` : ''}${convida(a) ? `. Participantes passam a ser ${emLista(a, 'participantes')}, e eles recebem o aviso` : sim(a, 'avisar_participantes') ? '. Os participantes recebem o aviso da mudança' : ''}`,
    async preparar(c, a) {
      const id = precisa(a, 'id', 2000);
      const { avisa } = mudancaDoEvento(c, a);
      const e = await fichaEvento(c, id);
      exigeAviso(e, avisa);
      return { detalhe: eventoNoCartao(e, c.tz).join('\n') };
    },
    async run(c, a) {
      const id = precisa(a, 'id', 2000);
      const { campos, descricao, online, avisa } = mudancaDoEvento(c, a);
      const atual = await c.http(`${GRAPH}/me/events/${seg(id)}?${qs({ $select: 'attendees,isOrganizer,isOnlineMeeting,body' })}`);
      exigeAviso(atual, avisa);
      let nota = '';
      if (descricao !== undefined) {
        // api/event-update: em reunião online, preservar o bloco da reunião que está no corpo
        if (atual.isOnlineMeeting) { campos.body = { contentType: 'HTML', content: emCimaDoHtml(descricao, atual.body?.content) }; nota = ' A reunião é online: o texto novo entrou acima do anterior, para não apagar o endereço da reunião.'; }
        else campos.body = { contentType: 'text', content: descricao };
      }
      if (online) { campos.isOnlineMeeting = true; campos.onlineMeetingProvider = await provedorOnline(c, null); }
      const e = await c.http(`${GRAPH}/me/events/${seg(id)}`, { method: 'PATCH', kind: 'write', body: campos });
      return { texto: `Compromisso alterado${avisa ? '; os participantes recebem o aviso' : ''}.${nota}`, url: e.webLink ?? null };
    },
  },
  {
    id: 'agenda.cancelar', risco: 'apagar', escopos: ['Calendars.ReadWrite'], descricao: 'tira um compromisso da agenda; em reunião que a pessoa organiza, os participantes recebem o cancelamento',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do compromisso' } },
    resumo: (a) => `Cancelar o compromisso ${s(a, 'id')}: ele sai da agenda e, se você organiza a reunião, os participantes recebem o cancelamento`,
    async preparar(c, a) {
      const e = await fichaEvento(c, precisa(a, 'id', 2000));
      const quemSabe = e.isOrganizer === false ? 'Você não organiza esta reunião: ela só sai da sua agenda.' : e.attendees?.length ? 'Você organiza esta reunião: os participantes recebem o cancelamento.' : '';
      return { detalhe: [...eventoNoCartao(e, c.tz), ...(quemSabe ? [quemSabe] : [])].join('\n') };
    },
    async run(c, a) {
      await c.http(`${GRAPH}/me/events/${seg(precisa(a, 'id', 2000))}`, { method: 'DELETE', kind: 'write' });
      return { texto: 'Compromisso cancelado.', url: null };
    },
  },
];

// ------------------------------------------------------------------------------------------------- arquivos
const falhaArquivo = (status: number): ProviderError => {
  if (status === 401 || status === 403) return new ProviderError('forbidden', 'acesso recusado pelo serviço (sem permissão para o arquivo)', { status });
  if (status === 404) return new ProviderError('not_found', 'arquivo não encontrado (apagado ou sem acesso)', { status });
  return new ProviderError('unavailable', `o serviço respondeu ${status}`, { status });
};
/** Endereço pré-autenticado do Graph: sem o token (driveitem-get-content), e o tamanho é conferido enquanto chega. */
async function baixar(url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new ProviderError('unavailable', 'o serviço devolveu um endereço de download inesperado');
  let res: Response;
  try { res = await fetchWithPolicy(() => fetch(url, { signal: AbortSignal.timeout(30_000) }), { budgetMs: 60_000 }); } catch { throw new ProviderError('unavailable', 'o serviço não respondeu'); }
  if (!res.ok) throw falhaArquivo(res.status);
  const grande = () => new ErroAcao('arquivo grande demais (mais de 15 MB): nada foi lido');
  // sem esperar o cancelamento: quem pediu já tem a resposta
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) { void res.body?.cancel().catch(() => undefined); throw grande(); }
  const pedacos: Uint8Array[] = []; let total = 0;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw grande(); }
    pedacos.push(value);
  }
  return Buffer.concat(pedacos);
}
/** Envio de uma vez para a sessão criada: sem o token, senão o serviço pode recusar (driveitem-createuploadsession). */
async function subir(uploadUrl: string, bytes: Buffer): Promise<any> {
  if (!uploadUrl.startsWith('https://')) throw new ProviderError('unavailable', 'o serviço devolveu um endereço de envio inesperado');
  let res: Response;
  try {
    res = await fetchWithPolicy(() => fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) }), { kind: 'write' });
  } catch (e) {
    throw new ProviderError('unavailable', e instanceof NetworkFailure && e.unknownOutcome ? 'o serviço não confirmou (pode ter feito ou não): confira lá antes de repetir' : 'o serviço não respondeu');
  }
  if (res.status !== 200 && res.status !== 201) throw falhaArquivo(res.status);
  return res.json().catch(() => ({}));
}
/**
 * A busca no OneDrive às vezes responde 500 por um instante (visto no Testar). Além das repetições rápidas de cada chamada
 * (lib/http.ts), a busca inteira tenta até 3 vezes, com espera crescente e teto, cada vez com o próprio client-request-id
 * (best-practices-concept: é o que o suporte da Microsoft procura). O registro leva o código e os ids, nunca o que foi procurado.
 */
const TENTATIVAS_BUSCA = 3;
const ESPERAS_BUSCA = [1000, 3000];
const TETO_ESPERA_BUSCA = 8000;
async function buscaComTentativas(c: CtxAcao, url: string): Promise<any> {
  const ids: string[] = [];
  for (let i = 1; ; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    try { return await c.http(url, { headers: { 'client-request-id': id } }); } catch (e) {
      const status = e instanceof ProviderError ? e.status : null;
      if (status === null || status < 500) throw e;
      if (i >= TENTATIVAS_BUSCA) {
        console.warn(`[conexoes] arquivos.buscar: o OneDrive respondeu ${status} nas ${i} tentativas (client-request-id: ${ids.join(', ')})`);
        throw new ProviderError('unavailable', `o OneDrive respondeu ${status} nas ${i} tentativas; tente de novo daqui a pouco (código para o suporte da Microsoft: ${id})`, { status });
      }
      await esperar(Math.min(ESPERAS_BUSCA[i - 1] ?? TETO_ESPERA_BUSCA, TETO_ESPERA_BUSCA));
    }
  }
}

const EXT_TEXTO = /\.(txt|md|csv|tsv|json|xml|html?|log)$/i;
/** Caminho dentro do OneDrive: sem subir pasta e sem os caracteres que o OneDrive recusa. */
function caminhoSeguro(valor: string): string[] {
  const partes = valor.replace(/\\/g, '/').split('/').map((p) => p.trim()).filter(Boolean);
  if (!partes.length) throw new ErroAcao('falta "caminho"');
  for (const p of partes) if (p === '.' || p === '..' || /["*:<>?|\u0000-\u001f]/.test(p)) throw new ErroAcao(`"caminho" tem um trecho inválido: "${d(p, 60)}"`);
  if (!EXT_TEXTO.test(partes.at(-1)!)) throw new ErroAcao('"caminho" precisa terminar num arquivo de texto: .txt, .md, .csv, .tsv, .json, .xml, .html ou .log');
  return partes;
}

const ACOES_ARQUIVOS: Acao[] = [
  {
    id: 'arquivos.buscar', risco: 'ler', escopos: ['Files.Read.All'], descricao: 'procura no OneDrive, inclusive o que foi compartilhado com a pessoa',
    params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'nome ou palavras do arquivo' }, limite: { tipo: 'numero', descricao: 'quantos por página (padrão 25, até 100)' }, cursor: { tipo: 'texto', descricao: 'continuação devolvida pela busca anterior' } },
    resumo: (a) => `Procurar arquivos com "${s(a, 'texto')}"`,
    async run(c, a) {
      const cur = await abreCursor(c, a, 'arquivos');
      const url = cur ? cur.u : `${GRAPH}/me/drive/search(q='${enc(odata(precisa(a, 'texto', 200)))}')?${qs({ $select: SEL_ARQUIVO, $top: num(a, 'limite', 25, 100) })}`;
      const j = await buscaComTentativas(c, url);
      const linhas = ((j.value ?? []) as any[]).map((x) => {
        // compartilhado: o item que vale é o de remoteItem, no drive de quem compartilhou (api/driveitem-search)
        const r = x.remoteItem ?? null;
        const drive = r?.parentReference?.driveId ?? x.parentReference?.driveId;
        return [
          `- id=${d(r?.id ?? x.id, 512)}`, ...(drive ? [`drive_id=${d(drive, 256)}`] : []), d(x.name ?? r?.name, 200), (x.folder ?? r?.folder) ? 'pasta' : `${Math.max(1, Math.round(Number(x.size ?? r?.size ?? 0) / 1024))} KB`,
          ...(r ? ['compartilhado'] : []), `alterado em ${dataHora(c.tz, Date.parse(x.lastModifiedDateTime ?? r?.lastModifiedDateTime))}`, ...(x.webUrl ?? r?.webUrl ? [`endereço: ${d(x.webUrl ?? r?.webUrl, 400)}`] : []),
        ].join(' | ');
      });
      const cursor = proximo(j, 'arquivos');
      const v = caber(linhas);
      return lido(`${v.linhas.length ? `${v.linhas.length} arquivo(s):\n${v.linhas.join('\n')}` : 'Nenhum arquivo encontrado.'}${v.nota}${rodape(cursor)}`);
    },
  },
  {
    id: 'arquivos.ler', risco: 'ler', escopos: ['Files.Read.All'], descricao: 'lê o texto de um arquivo de até 15 MB (Word, Excel, PowerPoint, PDF com texto, CSV, texto), até 20.000 caracteres',
    params: { id: { tipo: 'texto', obrigatorio: true, descricao: 'id do arquivo (vem de arquivos.buscar)' }, drive_id: { tipo: 'texto', descricao: 'drive_id que veio junto, obrigatório em arquivo compartilhado' } },
    resumo: (a) => `Ler o arquivo ${s(a, 'id')}`,
    async run(c, a) {
      const item = async (id: string, drive?: string) => c.http(`${GRAPH}${drive ? `/drives/${seg(drive)}` : '/me/drive'}/items/${seg(id)}?${qs({ $select: 'id,name,size,file,folder,remoteItem,@microsoft.graph.downloadUrl' })}`);
      const pedido = precisa(a, 'id', 1000);
      let m = await item(pedido, txt(a, 'drive_id', 500)?.trim() || undefined);
      // atalho no próprio drive para um item compartilhado: o conteúdo está no drive de origem
      if (!m['@microsoft.graph.downloadUrl'] && m.remoteItem?.id && m.remoteItem?.parentReference?.driveId) m = await item(String(m.remoteItem.id), String(m.remoteItem.parentReference.driveId));
      const nome = String(m.name ?? 'arquivo');
      // o erro cita o id pedido, não o nome: quem compartilha a pasta escolhe o nome, e ele chegaria ao agente como texto do sistema
      const qual = `id=${d(pedido, 200)}`;
      if (m.folder) throw new ErroAcao(`o item ${qual} é uma pasta, não um arquivo`);
      if (Number(m.size ?? 0) > MAX_BYTES) throw new ErroAcao('arquivo grande demais (mais de 15 MB): nada foi lido');
      const url = m['@microsoft.graph.downloadUrl'];
      if (typeof url !== 'string' || !url) throw new ErroAcao(`o arquivo ${qual} não tem conteúdo para baixar por aqui`);
      const doc = await readDocument(nome, String(m.file?.mimeType ?? ''), await baixar(url));
      if (doc.status !== 'ok') throw new ErroAcao(`não deu para ler o arquivo ${qual}: ${d(doc.detail ?? doc.status, 200)}`);
      const texto = doc.sheets?.length ? doc.sheets.map((x) => sheetText(x, 200).replace(/\n/g, ' // ')).join(' // ') : doc.text;
      return lido(`Arquivo ${d(nome, 200)}${texto.length > MAX_DOC ? ` (só os primeiros ${MAX_DOC} caracteres)` : ''}: ${d(texto, MAX_DOC)}`);
    },
  },
  {
    id: 'arquivos.criar', risco: 'organizar', escopos: ['Files.ReadWrite'], descricao: 'cria um arquivo de texto pequeno no OneDrive da pessoa; não sobrescreve: se o nome existir, cria com outro nome',
    params: { caminho: { tipo: 'texto', obrigatorio: true, descricao: 'pasta e nome, ex.: Relatórios/2026/resumo.txt' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'conteúdo do arquivo' } },
    resumo: (a) => `Criar no OneDrive o arquivo "${umaLinha(s(a, 'caminho'))}" com o conteúdo: "${s(a, 'texto')}"`,
    async run(c, a) {
      const partes = caminhoSeguro(precisa(a, 'caminho', 600));
      const bytes = Buffer.from(inteiro(a, 'texto', MAX_ARQUIVO), 'utf8');
      // `CtxAcao.http` só manda JSON: conteúdo cru vai pela sessão de envio; `rename` nunca sobrescreve
      const sessao = await c.http(`${GRAPH}/me/drive/items/root:/${partes.map(enc).join('/')}:/createUploadSession`, { method: 'POST', kind: 'write', body: { item: { '@microsoft.graph.conflictBehavior': 'rename', name: partes.at(-1) } } });
      if (typeof sessao.uploadUrl !== 'string') throw new ProviderError('unavailable', 'o serviço não abriu o envio do arquivo');
      const f = await subir(sessao.uploadUrl, bytes);
      return { texto: `Arquivo criado no OneDrive: ${d(f.name ?? partes.at(-1), 200)}${f.id ? ` (id=${d(f.id, 512)})` : ''}.`, url: f.webUrl ?? null };
    },
  },
];

// ------------------------------------------------------------------------------------------------- pessoas
const ACOES_PESSOAS: Acao[] = [
  {
    id: 'pessoas.buscar', risco: 'ler', escopos: ['People.Read'], descricao: 'acha o e-mail de alguém pelo nome, entre as pessoas com quem a conta se relaciona',
    params: { texto: { tipo: 'texto', obrigatorio: true, descricao: 'nome ou e-mail' }, limite: { tipo: 'numero', descricao: 'quantos (padrão 10, até 25)' } },
    resumo: (a) => `Procurar a pessoa "${s(a, 'texto')}"`,
    async run(c, a) {
      const termo = precisa(a, 'texto', 120).replace(/["\\\s]+/g, ' ').trim();
      if (!termo) throw new ErroAcao('falta "texto"');
      const j = await c.http(`${GRAPH}/me/people?${qs({ $search: `"${termo}"`, $select: SEL_PESSOA, $top: num(a, 'limite', 10, 25) })}`);
      const linhas = ((j.value ?? []) as any[]).map((p) => {
        const end = ((p.scoredEmailAddresses ?? []) as any[]).map((e) => d(e.address, 120)).filter(Boolean);
        return [`- ${d(p.displayName, 120)}`, end.length ? end.join(', ') : p.userPrincipalName ? d(p.userPrincipalName, 120) : 'sem e-mail', ...(p.jobTitle ? [d(p.jobTitle, 100)] : []), ...(p.companyName ? [d(p.companyName, 100)] : []), ...(p.department ? [d(p.department, 100)] : [])].join(' | ');
      });
      return lido(linhas.length ? linhas.join('\n') : 'Ninguém encontrado com esse nome.');
    },
  },
];

// ------------------------------------------------------------------------------------------------- Teams
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rotuloChat = (ch: any): string => (ch.topic ? d(ch.topic, 120) : ((ch.members ?? []) as any[]).map((m) => d(m.displayName ?? m.email, 80)).filter(Boolean).join(', ') || 'conversa');
/** Até 5 páginas de 50 conversas (chat-list: $top até 50), das mais recentes para as antigas: quem procura pelo nome quase sempre fala de uma recente. */
const PAGINAS_DE_CONVERSAS = 5;
/** "Ana e Bia", "Ana, Bia", "Ana & Bia": as pessoas de um grupo sem nome. */
const pessoasDe = (v: string): string[] => v.split(/\s*(?:,|;|&|\s+e\s+|\s+and\s+)\s*/i).map((x) => fold(x.trim())).filter(Boolean);
const eDela = (m: any, nome: string): boolean => fold(String(m.displayName ?? '')) === nome || fold(String(m.email ?? '')) === nome;
/**
 * Id da conversa, ou o nome exato: o tópico, a outra pessoa de uma conversa 1:1, ou as pessoas de um grupo sem nome ("Ana e Bia":
 * o grupo com exatamente elas e a própria conta). Com dúvida, devolve as opções. Chat.ReadBasic basta (chat-list).
 */
async function chatDe(c: CtxAcao, valor: string): Promise<string> {
  const v = valor.trim();
  if (/^19:/.test(v)) return v;
  const url = (ordem: boolean) => `${GRAPH}/me/chats?${qs({ $expand: 'members', $orderby: ordem ? 'lastMessagePreview/createdDateTime desc' : undefined, $top: 50 })}`;
  // a ordem pela última mensagem pode depender da leitura do Teams: recusada, vale a ordem do serviço
  let chats: any[];
  try { chats = await paginas(c, url(true), PAGINAS_DE_CONVERSAS); } catch (e) {
    if (!recusou(e)) throw e;
    chats = await paginas(c, url(false), PAGINAS_DE_CONVERSAS);
  }
  const f = fold(v);
  const nomes = pessoasDe(v);
  const membros = (ch: any): any[] => (ch.members ?? []) as any[];
  // grupo: cada pessoa dita é um participante diferente, e só sobra a própria conta (o $expand traz até 25 participantes)
  const doGrupo = (ch: any): boolean => {
    const ms = membros(ch);
    if (ch.chatType !== 'group' || ms.length !== nomes.length + 1) return false;
    const usados = new Set<number>();
    return nomes.every((n) => { const k = ms.findIndex((m, i) => !usados.has(i) && eDela(m, n)); if (k < 0) return false; usados.add(k); return true; });
  };
  const certo = chats.filter((ch) => fold(String(ch.topic ?? '')) === f || (ch.chatType === 'oneOnOne' && membros(ch).some((m) => eDela(m, f))) || (!ch.topic && doGrupo(ch)));
  if (certo.length === 1) return String(certo[0].id);
  // sem acerto exato: as conversas em que aparece alguém dito ajudam mais que a lista inteira
  const comAlguem = chats.filter((ch) => nomes.some((n) => membros(ch).some((m) => eDela(m, n))));
  const opcoes = certo.length ? certo : comAlguem.length ? comAlguem : chats;
  throw new ErroAcao(certo.length ? `mais de uma conversa com "${d(v, 60)}"` : `não achei a conversa "${d(v, 60)}": use o id de teams.conversas, ou teams.nova_conversa`, opcoes.slice(0, 30).map((ch) => `${rotuloChat(ch)} (${d(ch.id, 200)})`));
}
async function timeDe(c: CtxAcao, valor: string): Promise<string> {
  const v = valor.trim();
  if (GUID.test(v)) return v;
  const todos = await paginas(c, `${GRAPH}/me/joinedTeams`);
  const certo = todos.filter((t) => fold(String(t.displayName ?? '')) === fold(v));
  if (certo.length === 1) return String(certo[0].id);
  throw new ErroAcao(certo.length ? `mais de um time chamado "${d(v, 60)}"` : `não achei o time "${d(v, 60)}"`, todos.map((t) => d(t.displayName, 120)));
}
const urlCanais = (time: string) => `${GRAPH}/teams/${seg(time)}/channels?${qs({ $select: 'id,displayName,description,membershipType' })}`;
async function canalDe(c: CtxAcao, time: string, valor: string): Promise<string> {
  const v = valor.trim();
  if (/^19:/.test(v)) return v;
  const todos = await paginas(c, urlCanais(time));
  const certo = todos.filter((x) => fold(String(x.displayName ?? '')) === fold(v));
  if (certo.length === 1) return String(certo[0].id);
  throw new ErroAcao(certo.length ? `mais de um canal chamado "${d(v, 60)}"` : `não achei o canal "${d(v, 60)}"`, todos.map((x) => d(x.displayName, 120)));
}
/** Nome e participantes da conversa. Pelo endereço de membros, porque o $expand=members para em 25 (chat-list). */
async function fichaChat(c: CtxAcao, id: string): Promise<any> {
  const [ch, members] = await Promise.all([c.http(`${GRAPH}/chats/${seg(id)}`), paginas(c, `${GRAPH}/chats/${seg(id)}/members`)]);
  return { ...ch, members };
}
const TIPO_DE_CHAT: Record<string, string> = { oneOnOne: 'conversa direta', group: 'grupo', meeting: 'conversa de reunião' };
function chatNoCartao(ch: any): string {
  const pessoas = (ch.members ?? []) as any[];
  const nomes = pessoas.slice(0, 50).map((m) => quem({ name: m.displayName, address: m.email })).join(', ');
  return `Conversa: "${rotuloChat(ch)}" (${TIPO_DE_CHAT[String(ch.chatType)] ?? 'conversa'}).\nParticipantes: ${nomes}${pessoas.length > 50 ? ` e mais ${pessoas.length - 50}` : ''}.`;
}
/** Sempre em HTML, com o texto escapado: em "text", o Teams junta as linhas; e nada do texto vira marcação. */
const corpoTeams = (texto: string) => ({ body: { contentType: 'html', content: emHtml(texto) } });
const P_CHAT: Param = { tipo: 'texto', obrigatorio: true, descricao: 'id da conversa (de teams.conversas) ou o nome exato dela' };
const P_TEXTO_TEAMS: Param = { tipo: 'texto', obrigatorio: true, descricao: 'mensagem, sem formatação' };
const P_TIME: Param = { tipo: 'texto', obrigatorio: true, descricao: 'nome exato ou id do time (de teams.times)' };
const remetente = (m: any): string => d(m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'sistema', 80);
/** Para o agente: o conteúdo das conversas depende da etapa de leitura, que na empresa costuma pedir o administrador. */
const SEM_PREVIA = '\n(Sem a prévia da última mensagem: ler o conteúdo das conversas do Teams ainda não foi liberado nesta conta. Na empresa, isso costuma precisar da aprovação do administrador; a pessoa pede em Conexões › Microsoft 365.)';
const urlConversas = (limite: number, previa: boolean, ordem = true) => `${GRAPH}/me/chats?${qs({ $expand: previa ? 'members,lastMessagePreview' : 'members', $orderby: ordem ? 'lastMessagePreview/createdDateTime desc' : undefined, $top: limite })}`;
const FORA_DE_ORDEM = '\n(Esta lista não vem das mais recentes para as mais antigas: essa ordem depende da leitura do Teams, ainda não liberada nesta conta.)';
const recusou = (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden' && e.status === 403;

const ACOES_TEAMS: Acao[] = [
  {
    // Chat.ReadBasic lista as conversas e quem está nelas (chat-list); a prévia da última mensagem é conteúdo, e vem com Chat.Read
    id: 'teams.conversas', risco: 'ler', escopos: ['Chat.ReadBasic'], trabalho: true, descricao: 'lista as conversas do Teams, das mais recentes para as mais antigas (com a prévia da última mensagem quando a leitura do Teams está liberada)',
    rotulo: 'lista as conversas do Teams, das mais recentes para as mais antigas',
    params: { limite: { tipo: 'numero', descricao: 'quantas por página (padrão 25, até 50)' }, cursor: { tipo: 'texto', descricao: 'continuação devolvida pela chamada anterior' } },
    resumo: () => 'Listar as conversas do Teams',
    async run(c, a) {
      const cur = await abreCursor(c, a, 'teams.conversas');
      // a continuação repete o pedido da primeira página: a prévia vem nela só se veio na primeira
      const daConta = tem(c, 'Chat.Read');
      let previa = cur ? /lastMessagePreview/.test(new URL(cur.u).searchParams.get('$expand') ?? '') : daConta !== false;
      let ordem = true;
      const limite = num(a, 'limite', 25, 50);
      const pedir = () => c.http(urlConversas(limite, previa, ordem));
      let j: any;
      if (cur) j = await c.http(cur.u);
      else {
        try { j = await pedir(); } catch (e) {
          // a conta que deu a leitura e mesmo assim foi recusada: a recusa é de verdade
          if (!recusou(e) || (previa && daConta === true)) throw e;
          // sem saber o que a conta deu, a recusa pode ser só da prévia: a lista vem sem ela
          if (previa) { previa = false; try { j = await pedir(); } catch (e2) { if (!recusou(e2)) throw e2; } }
          // sem a leitura, a ordem pela última mensagem também pode ser recusada: a lista vem na ordem do serviço
          if (!j) { ordem = false; j = await pedir(); }
        }
      }
      const linhas = ((j.value ?? []) as any[]).map((ch) => {
        const u = ch.lastMessagePreview;
        return [`- chat=${d(ch.id, 300)}`, ch.chatType === 'oneOnOne' ? '1:1' : ch.chatType === 'group' ? 'grupo' : ch.chatType === 'meeting' ? 'reunião' : d(ch.chatType, 20), rotuloChat(ch),
          ...(u && !u.isDeleted && u.messageType === 'message' ? [`última: ${dataHora(c.tz, Date.parse(u.createdDateTime))} ${remetente(u)}: ${d(corpoDe(u.body), 200)}`] : [])].join(' | ');
      });
      const cursor = proximo(j, 'teams.conversas');
      const v = caber(linhas);
      return lido(`${v.linhas.length ? `${v.linhas.length} conversa(s):\n${v.linhas.join('\n')}` : 'Nenhuma conversa encontrada.'}${v.nota}${previa ? '' : SEM_PREVIA}${ordem ? '' : FORA_DE_ORDEM}${rodape(cursor)}`);
    },
  },
  {
    id: 'teams.ler', risco: 'ler', escopos: ['Chat.Read'], trabalho: true, descricao: 'lê as últimas mensagens de uma conversa do Teams, em texto',
    params: {
      chat: P_CHAT, limite: { tipo: 'numero', descricao: 'quantas (padrão 20, até 50)' },
      desde: { tipo: 'texto', descricao: 'só o que chegou ou mudou desde esta data (AAAA-MM-DD, ou data e hora): use sempre que o pedido tiver um período, como "Dados desde" nas rotinas' },
      cursor: { tipo: 'texto', descricao: 'mensagens mais antigas: continuação devolvida pela chamada anterior' },
    },
    resumo: (a) => `Ler a conversa do Teams ${s(a, 'chat')}${s(a, 'desde') ? ` desde ${s(a, 'desde')}` : ''}`,
    async run(c, a) {
      const cur = await abreCursor(c, a, 'teams.ler');
      // com período, o intervalo de datas vai na própria consulta (a Microsoft pede isso de quem procura mensagens novas).
      // O filtro só vale com a ordem pela mesma data (chat-list-messages: lastModifiedDateTime aceita gt e lt)
      const desde = cur ? undefined : instante(a, 'desde', c.tz, false);
      const q = desde !== undefined
        ? { $top: num(a, 'limite', 20, 50), $orderby: 'lastModifiedDateTime desc', $filter: `lastModifiedDateTime gt ${iso(desde)}` }
        : { $top: num(a, 'limite', 20, 50), $orderby: 'createdDateTime desc' };
      const j = await c.http(cur ? cur.u : `${GRAPH}/me/chats/${seg(await chatDe(c, precisa(a, 'chat', 400)))}/messages?${qs(q)}`);
      // vêm da mais nova para a mais antiga: se não couber, ficam as novas; o agente lê em ordem de conversa
      const v = caber(((j.value ?? []) as any[]).filter((m) => m.messageType === 'message' && !m.deletedDateTime).map((m) => {
        const anexos = ((m.attachments ?? []) as any[]).map((x) => d(x.name, 120)).filter(Boolean);
        return `- ${dataHora(c.tz, Date.parse(m.createdDateTime))} ${remetente(m)}: ${d(corpoDe(m.body), 2000)}${anexos.length ? ` (anexos: ${anexos.join(', ')})` : ''}`;
      }));
      const cursor = proximo(j, 'teams.ler');
      return lido(`${v.linhas.length ? [...v.linhas].reverse().join('\n') : 'Nenhuma mensagem de pessoas nesta página.'}${v.nota}${rodape(cursor)}`);
    },
  },
  {
    // achar a conversa e os participantes dela pede só Chat.ReadBasic (chat-list, chat-get, chat-list-members)
    id: 'teams.enviar', risco: 'enviar', escopos: ['ChatMessage.Send', 'Chat.ReadBasic'], trabalho: true, descricao: 'manda uma mensagem numa conversa do Teams que já existe', params: { chat: P_CHAT, texto: P_TEXTO_TEAMS },
    resumo: (a) => `Enviar no Teams, na conversa ${s(a, 'chat')}, a mensagem: "${s(a, 'texto')}"`,
    async preparar(c, a) {
      inteiro(a, 'texto', MAX_TEAMS);
      const pedido = precisa(a, 'chat', 400);
      const id = await chatDe(c, pedido);
      const ch = await fichaChat(c, id);
      // o nome de um grupo qualquer participante muda: quem o renomeou escolheria para onde a mensagem vai
      const peloNomeDoGrupo = id !== pedido && !!ch.topic && fold(String(ch.topic)) === fold(pedido);
      return { args: { ...a, chat: id }, detalhe: chatNoCartao(ch), ...(peloNomeDoGrupo ? { confirmar: 'o nome de um grupo é escolhido por quem participa dele' } : {}) };
    },
    async run(c, a) {
      const texto = inteiro(a, 'texto', MAX_TEAMS);
      const m = await c.http(`${GRAPH}/chats/${seg(await chatDe(c, precisa(a, 'chat', 400)))}/messages`, { method: 'POST', kind: 'write', body: corpoTeams(texto) });
      return { texto: 'Mensagem enviada no Teams.', url: m.webUrl ?? null };
    },
  },
  {
    id: 'teams.nova_conversa', risco: 'enviar', escopos: ['Chat.Create', 'ChatMessage.Send', 'User.Read'], trabalho: true, descricao: 'manda mensagem a uma pessoa pelo e-mail: acha a conversa 1:1 ou cria, se não houver',
    params: { para: { tipo: 'texto', obrigatorio: true, descricao: 'e-mail de login da pessoa no Teams' }, texto: P_TEXTO_TEAMS },
    resumo: (a) => `Enviar no Teams, em conversa direta com ${umaLinha(s(a, 'para'))}, a mensagem: "${s(a, 'texto')}"`,
    async run(c, a) {
      const destino = destinatarios(a, 'para');
      if (destino.length !== 1) throw new ErroAcao('"para" precisa ser um único e-mail');
      const texto = inteiro(a, 'texto', MAX_TEAMS);
      const eu = await c.http(`${GRAPH}/me?${qs({ $select: 'id,mail,userPrincipalName' })}`);
      const membro = (usuario: string) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `${GRAPH}/users('${odata(usuario)}')` });
      let chat: any;
      try { chat = await c.http(`${GRAPH}/chats`, { method: 'POST', kind: 'write', body: { chatType: 'oneOnOne', members: [membro(String(eu.id)), membro(destino[0])] } }); } catch (e) {
        // outra organização: o Graph só aceita essa pessoa pelo id e pelo tenantId dela (chat-post), nunca pelo e-mail; empresa com
        // mais de um domínio cai aqui só se o serviço recusar, por isso a conferência vem depois da recusa, não antes
        const dominio = (x: unknown) => String(x ?? '').split('@')[1]?.toLowerCase() ?? '';
        const meus = new Set([dominio(eu?.mail), dominio(eu?.userPrincipalName)].filter(Boolean));
        if (e instanceof ProviderError && [400, 403, 404].includes(e.status ?? 0) && meus.size && !meus.has(dominio(destino[0]))) {
          throw new ErroAcao(`"${destino[0]}" parece ser de outra organização: daqui, o Teams só abre conversa nova com pessoas da mesma empresa da conta. Se já existe uma conversa com essa pessoa, use teams.enviar com o nome dela; se não, mande um e-mail (email.enviar). Nada foi enviado`);
        }
        if (e instanceof ProviderError && (e.status === 400 || e.status === 404)) throw new ErroAcao(`o Teams não abriu conversa com "${destino[0]}": precisa ser o e-mail de login da pessoa (${e.message})`);
        throw e;
      }
      const m = await c.http(`${GRAPH}/chats/${seg(chat.id)}/messages`, { method: 'POST', kind: 'write', body: corpoTeams(texto) });
      return { texto: `Mensagem enviada no Teams para ${destino[0]}. chat=${String(chat.id)}`, url: m.webUrl ?? chat.webUrl ?? null };
    },
  },
  {
    id: 'teams.times', risco: 'ler', escopos: ['Team.ReadBasic.All'], trabalho: true, descricao: 'lista os times de que a pessoa participa', params: {},
    resumo: () => 'Listar os times do Teams',
    async run(c) {
      const todos = await paginas(c, `${GRAPH}/me/joinedTeams`);
      return lido(todos.length ? todos.map((t) => `- ${d(t.displayName, 120)}${t.isArchived ? ' (arquivado)' : ''} | time=${d(t.id, 80)}${t.description ? ` | ${d(t.description, 200)}` : ''}`).join('\n') : 'Nenhum time encontrado.');
    },
  },
  {
    id: 'teams.canais', risco: 'ler', escopos: ['Team.ReadBasic.All', 'Channel.ReadBasic.All'], trabalho: true, descricao: 'lista os canais de um time', params: { time: P_TIME },
    resumo: (a) => `Listar os canais do time ${s(a, 'time')}`,
    async run(c, a) {
      const todos = await paginas(c, urlCanais(await timeDe(c, precisa(a, 'time', 300))));
      return lido(todos.length ? todos.map((x) => `- ${d(x.displayName, 120)} | canal=${d(x.id, 200)}${x.description ? ` | ${d(x.description, 200)}` : ''}`).join('\n') : 'Nenhum canal encontrado.');
    },
  },
  {
    // ChannelMessage.Read.All sempre exige o administrador (permissions-reference): etapa opcional, a última do login encadeado
    id: 'teams.ler_canal', risco: 'ler', escopos: ['ChannelMessage.Read.All', 'Team.ReadBasic.All', 'Channel.ReadBasic.All'], trabalho: true,
    descricao: 'lê as mensagens mais recentes de um canal de um time do Teams, em texto (sem as respostas)', rotulo: 'lê as mensagens de um canal do Teams',
    params: { time: P_TIME, canal: { tipo: 'texto', obrigatorio: true, descricao: 'nome exato ou id do canal (de teams.canais)' }, limite: { tipo: 'numero', descricao: 'quantas (padrão 20, até 50)' } },
    resumo: (a) => `Ler o canal ${s(a, 'canal')} do time ${s(a, 'time')} no Teams`,
    async run(c, a) {
      const time = await timeDe(c, precisa(a, 'time', 300));
      const canal = await canalDe(c, time, precisa(a, 'canal', 300));
      // channel-list-messages: $top até 50; a ordem é a da última mudança de cada assunto (mensagem e respostas)
      const j = await c.http(`${GRAPH}/teams/${seg(time)}/channels/${seg(canal)}/messages?${qs({ $top: num(a, 'limite', 20, 50) })}`);
      const v = caber(((j.value ?? []) as any[]).filter((m) => m.messageType === 'message' && !m.deletedDateTime).map((m) => {
        const assunto = m.subject ? ` [${d(m.subject, 120)}]` : '';
        return `- ${dataHora(c.tz, Date.parse(m.createdDateTime))} ${remetente(m)}${assunto}: ${d(corpoDe(m.body), 2000)}`;
      }));
      return lido(v.linhas.length ? `${v.linhas.join('\n')}${v.nota}` : 'Nenhuma mensagem de pessoas neste canal.');
    },
  },
  {
    id: 'teams.enviar_canal', risco: 'enviar', escopos: ['ChannelMessage.Send', 'Team.ReadBasic.All', 'Channel.ReadBasic.All'], trabalho: true, descricao: 'publica uma mensagem num canal do Teams',
    params: { time: P_TIME, canal: { tipo: 'texto', obrigatorio: true, descricao: 'nome exato ou id do canal (de teams.canais)' }, texto: P_TEXTO_TEAMS },
    resumo: (a) => `Publicar no Teams, no canal ${s(a, 'canal')} do time ${s(a, 'time')}, a mensagem: "${s(a, 'texto')}"`,
    async preparar(c, a) {
      inteiro(a, 'texto', MAX_TEAMS);
      const time = await timeDe(c, precisa(a, 'time', 300));
      const canal = await canalDe(c, time, precisa(a, 'canal', 300));
      const [t, x] = await Promise.all([c.http(`${GRAPH}/teams/${seg(time)}?${qs({ $select: 'displayName' })}`), c.http(`${GRAPH}/teams/${seg(time)}/channels/${seg(canal)}?${qs({ $select: 'displayName,membershipType' })}`)]);
      // a lista de membros do canal pede permissão de administrador: fica o que a documentação garante sobre quem vê
      const quemVe = x.membershipType === 'private' || x.membershipType === 'shared' ? 'só quem participa do canal' : 'todos do time';
      return { args: { ...a, time, canal }, detalhe: `Time: "${d(t.displayName, 120)}".\nCanal: "${d(x.displayName, 120)}".\nQuem vê: ${quemVe}.` };
    },
    async run(c, a) {
      const texto = inteiro(a, 'texto', MAX_TEAMS);
      const time = await timeDe(c, precisa(a, 'time', 300));
      const canal = await canalDe(c, time, precisa(a, 'canal', 300));
      const m = await c.http(`${GRAPH}/teams/${seg(time)}/channels/${seg(canal)}/messages`, { method: 'POST', kind: 'write', body: corpoTeams(texto) });
      return { texto: 'Mensagem publicada no canal.', url: m.webUrl ?? null };
    },
  },
];

export const ACOES_MICROSOFT: Acao[] = [...ACOES_EMAIL, ...ACOES_AGENDA, ...ACOES_ARQUIVOS, ...ACOES_PESSOAS, ...ACOES_TEAMS];

/**
 * Permissões delegadas que cobrem as ações e o espelho de tarefas (Tasks.ReadWrite, escrita/microsoft.ts), pedidas em etapas
 * (sso.ts), porque "não exige administrador" na tabela oficial (permissions-reference) não quer dizer que o usuário comum consiga
 * autorizar: a política padrão dos tenants novos, "Let Microsoft manage your consent settings", deixa o usuário autorizar quase
 * tudo, MENOS a lista de FORA_DO_CONSENTIMENTO_DO_USUARIO (manage-app-consent-policies, conferido em 08/11/2026). Pedir tudo de
 * uma vez fazia a conexão de uma empresa típica nem completar sem o administrador.
 *   A (base e trabalho): o que a política padrão deixa o próprio usuário autorizar. Enviar e-mail, criar arquivo no OneDrive e,
 *     em conta de trabalho, ver e mandar mensagens no Teams.
 *   B (leitura, e Chat.Read em conta de trabalho): ler e organizar. Está na lista de exceções: na empresa, costuma precisar do
 *     administrador, que aprova pelo link que a tela de Conexões monta (sso.ts, linkAdministrador). Conta pessoal autoriza sozinha.
 *   C (canais, opcional): ler mensagens de canal. ChannelMessage.Read.All sempre exige o administrador.
 * Cada ação diz a que precisa, e o serviço confere pelo nome: o que a conta já deu continua valendo, e a falta de uma etapa só
 * tira as ações dela.
 */
export const ESCOPOS_MICROSOFT: { base: string[]; trabalho: string[]; leitura: string[]; leituraTrabalho: string[]; canais: string[] } = {
  base: ['User.Read', 'Mail.Send', 'Files.ReadWrite'],
  trabalho: ['Chat.ReadBasic', 'Chat.Create', 'ChatMessage.Send', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'],
  leitura: ['Mail.Read', 'Mail.ReadWrite', 'Calendars.Read', 'Calendars.ReadWrite', 'Files.Read.All', 'Tasks.ReadWrite', 'People.Read'],
  leituraTrabalho: ['Chat.Read'],
  canais: ['ChannelMessage.Read.All'],
};

/**
 * Permissões do Microsoft Graph que a política padrão gerenciada pela Microsoft NÃO deixa o usuário comum autorizar
 * (https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-app-consent-policies, "Microsoft recommended user
 * consent policy", conferido em 08/11/2026). A Microsoft atualiza essa lista sozinha: o teste confere que a etapa A não pede
 * nenhuma delas.
 */
export const FORA_DO_CONSENTIMENTO_DO_USUARIO = [
  'Files.Read.All', 'Files.ReadWrite.All', 'Sites.Read.All', 'Sites.ReadWrite.All', 'Mail.Read', 'Mail.ReadWrite', 'Mail.ReadBasic', 'Mail.Read.Shared',
  'Mail.ReadBasic.Shared', 'Mail.ReadWrite.Shared', 'MailboxItem.Read', 'Calendars.Read', 'Calendars.ReadBasic', 'Calendars.ReadWrite', 'Calendars.Read.Shared',
  'Calendars.ReadWrite.Shared', 'Chat.Read', 'Chat.ReadWrite', 'OnlineMeetings.Read', 'OnlineMeetings.ReadWrite', 'MailBoxFolder.Read', 'MailBoxFolder.ReadWrite',
  'MailBoxSettings.Read', 'MailBoxSettings.ReadWrite', 'Contacts.ReadWrite', 'Contacts.Read.Shared', 'Contacts.ReadWrite.Shared', 'Tasks.Read', 'Tasks.Read.Shared',
  'Tasks.ReadWrite', 'Tasks.ReadWrite.Shared', 'People.Read',
];
