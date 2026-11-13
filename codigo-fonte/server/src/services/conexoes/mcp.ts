/**
 * Cliente MCP (Model Context Protocol) do servidor do Ergon, pelo transporte "Streamable HTTP": um POST por mensagem
 * JSON-RPC, resposta em JSON ou em eventos (text/event-stream), e a sessão no cabeçalho Mcp-Session-Id. É o Ergon quem
 * fala com o servidor MCP do aplicativo (a credencial fica aqui, como nas outras Conexões): o motor de IA recebe só o
 * resultado, e cada ferramenta passa pela mesma regra das outras ações (regra.ts), com risco, ajuste e cartão.
 *
 * Usado pelo GoHighLevel (conectores/gohighlevel.ts) pelo `transporte` de um conector por dados (declarativo.ts): o
 * caminho "/ferramentas" lista as ferramentas e "/ferramenta/<nome>" chama uma, com os argumentos no corpo.
 *
 * Os argumentos vão pelo esquema que o próprio servidor publica (tools/list): o conector diz o que quer pelo nome lógico
 * (contactId, query) e aqui ele vira o nome que a ferramenta pede, solto ou dentro de um grupo (path_contactId,
 * body.contactId, pipeline_stage_id). Um servidor que muda a grafia não quebra a ação; um que tira o campo de uma escrita
 * faz a ação parar antes de escrever, com o motivo (nunca escreve outra coisa do que o cartão mostrou).
 *
 * Especificação: modelcontextprotocol.io/specification/2025-06-18/basic/transports (Streamable HTTP, sessão, 404 = sessão
 * vencida) e .../server/tools (tools/list com cursor, tools/call, isError, structuredContent).
 */
import crypto from 'node:crypto';
import { clip } from '../../lib/util.ts';
import { NetworkFailure, fetchWithPolicy, retryHint } from '../../lib/http.ts';
import { ProviderError } from '../mirror.ts';
import { neutral } from '../operations.ts';
import { ErroAcao, type Http, type Risco } from './tipos.ts';

export const MCP_VERSAO = '2025-06-18';

export interface FerramentaMcp { name: string; description?: string; inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] } }

export interface ServidorMcp {
  /** endereço fixo do servidor (nunca vem da pessoa nem do modelo) */
  url: string;
  /** cabeçalhos de cada pedido: a credencial e, quando o serviço pede, a conta (ex.: locationId) */
  cabecalhos: Record<string, string>;
  /** valores que nunca aparecem num erro */
  segredos: string[];
  /** nome do serviço, para as mensagens */
  nome: string;
  /** o que dizer quando a ferramenta não está na lista do servidor (em geral, falta uma permissão na credencial) */
  semFerramenta?: (nome: string) => string;
}

interface Sessao { id: string | null; protocolo: string; ferramentas: FerramentaMcp[] | null; vence: number }
/** Uma sessão por credencial (resumida: o valor nunca fica como chave), renovada a cada 10 minutos ou quando o servidor a esquece. */
const SESSOES = new Map<string, Sessao>();
const DURA_MS = 10 * 60_000;
/** Testes: começa sem sessão guardada. */
export const esquecerSessoesMcp = (): void => SESSOES.clear();

const chaveDe = (s: ServidorMcp) => crypto.createHash('sha256').update(`${s.url}|${JSON.stringify(s.cabecalhos)}`).digest('hex');
const semSegredo = (s: ServidorMcp, t: string) => [...s.segredos].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length).reduce((r, x) => r.split(x).join('***'), t);

/** A mensagem JSON-RPC com o id pedido, numa resposta em JSON (uma ou várias) ou em eventos. */
function respostaDe(corpo: string, tipo: string, id: number): any {
  const lidas: any[] = [];
  if (/text\/event-stream/i.test(tipo)) {
    for (const evento of corpo.split(/\r?\n\r?\n/)) {
      const dados = evento.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!dados.trim()) continue;
      try { lidas.push(JSON.parse(dados)); } catch { /* evento que não é JSON: ignora */ }
    }
  } else if (corpo.trim()) {
    try { const j = JSON.parse(corpo); lidas.push(...(Array.isArray(j) ? j : [j])); } catch { /* cai no erro abaixo */ }
  }
  return lidas.find((m) => m && typeof m === 'object' && m.id === id) ?? null;
}

let proximoId = 1;
async function enviar(s: ServidorMcp, sessao: Sessao | null, metodo: string, params: unknown, kind: 'read' | 'write', notificacao = false): Promise<{ resposta: any; sessaoId: string | null; status: number }> {
  const id = proximoId++;
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...s.cabecalhos,
    ...(sessao ? { 'MCP-Protocol-Version': sessao.protocolo } : {}), ...(sessao?.id ? { 'Mcp-Session-Id': sessao.id } : {}),
  };
  const corpo = JSON.stringify(notificacao ? { jsonrpc: '2.0', method: metodo, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id, method: metodo, ...(params ? { params } : {}) });
  let res: Response;
  try {
    // redirecionamento nunca: a credencial iria junto para outro endereço
    res = await fetchWithPolicy(() => fetch(s.url, { method: 'POST', headers, body: corpo, redirect: 'error', signal: AbortSignal.timeout(30_000) }), { kind });
  } catch (e) {
    throw new ProviderError('unavailable', e instanceof NetworkFailure && e.unknownOutcome ? 'o serviço não confirmou (pode ter feito ou não): confira lá antes de repetir' : 'o serviço não respondeu');
  }
  const sessaoId = res.headers.get('mcp-session-id');
  if (res.status === 404 && sessao?.id) return { resposta: null, sessaoId, status: 404 }; // sessão vencida: nada foi feito
  const texto = await res.text().catch(() => '');
  const motivo = () => { const m = semSegredo(s, texto.trimStart().startsWith('<') ? '' : texto).replace(/\s+/g, ' ').trim(); return m ? ` (${neutral(clip(m, 160), 170)})` : ''; };
  if (res.status === 401 || res.status === 403) throw new ProviderError('forbidden', `o ${s.nome} recusou a chave (inválida, vencida ou sem permissão)${motivo()}`, { status: res.status });
  if (res.status === 429) throw new ProviderError('unavailable', `limite de uso do ${s.nome} atingido; ${retryHint(res)}`);
  if (!res.ok) throw new ProviderError('unavailable', `o ${s.nome} respondeu ${res.status}${motivo()}`, { status: res.status });
  if (notificacao) return { resposta: null, sessaoId, status: res.status };
  const r = respostaDe(texto, res.headers.get('content-type') ?? '', id);
  if (!r) throw new ProviderError('unavailable', `resposta inesperada do ${s.nome}`);
  if (r.error) {
    const msg = neutral(clip(semSegredo(s, String(r.error.message ?? 'erro')), 200), 210);
    // parâmetro recusado: o agente corrige; o resto é do serviço
    if (r.error.code === -32602) throw new ErroAcao(`o ${s.nome} recusou os dados: ${msg} (nada foi feito)`);
    throw new ProviderError(/auth|token|unauthori|forbidden|permission|scope/i.test(msg) ? 'forbidden' : 'unavailable', `o ${s.nome} respondeu com erro: ${msg}`);
  }
  return { resposta: r.result ?? {}, sessaoId, status: res.status };
}

async function abrir(s: ServidorMcp): Promise<Sessao> {
  const k = chaveDe(s);
  const hit = SESSOES.get(k);
  if (hit && hit.vence > Date.now()) return hit;
  const { resposta, sessaoId } = await enviar(s, null, 'initialize', { protocolVersion: MCP_VERSAO, capabilities: {}, clientInfo: { name: 'ergon', version: '1' } }, 'read');
  const sessao: Sessao = { id: sessaoId, protocolo: typeof resposta?.protocolVersion === 'string' ? resposta.protocolVersion : MCP_VERSAO, ferramentas: null, vence: Date.now() + DURA_MS };
  await enviar(s, sessao, 'notifications/initialized', null, 'read', true);
  if (SESSOES.size > 200) SESSOES.clear();
  SESSOES.set(k, sessao);
  return sessao;
}

/** Um pedido na sessão; sessão esquecida pelo servidor (404) abre outra e repete uma vez: o 404 diz que nada foi feito. */
async function naSessao(s: ServidorMcp, metodo: string, params: unknown, kind: 'read' | 'write'): Promise<{ resposta: any; sessao: Sessao }> {
  for (let i = 0; i < 2; i++) {
    const sessao = await abrir(s);
    const r = await enviar(s, sessao, metodo, params, kind);
    if (r.status !== 404) return { resposta: r.resposta, sessao };
    SESSOES.delete(chaveDe(s));
  }
  throw new ProviderError('unavailable', `o ${s.nome} perdeu a sessão duas vezes seguidas; tente daqui a pouco`);
}

export async function ferramentasMcp(s: ServidorMcp): Promise<FerramentaMcp[]> {
  const sessao = await abrir(s);
  if (sessao.ferramentas) return sessao.ferramentas;
  const todas: FerramentaMcp[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const { resposta } = await naSessao(s, 'tools/list', cursor ? { cursor } : {}, 'read');
    for (const f of Array.isArray(resposta?.tools) ? resposta.tools : []) if (f && typeof f.name === 'string') todas.push(f);
    cursor = typeof resposta?.nextCursor === 'string' && resposta.nextCursor ? resposta.nextCursor : undefined;
    if (!cursor) break;
  }
  // a lista fica com a sessão em que foi lida (a mesma chave): uma sessão nova lê de novo
  const atual = SESSOES.get(chaveDe(s));
  if (atual) atual.ferramentas = todas;
  return todas;
}

/** O que a ferramenta devolveu: o conteúdo estruturado, o JSON do texto, ou o texto. Erro da ferramenta vira erro da ação. */
export function resultadoMcp(r: any, nome: string): any {
  const textos = (Array.isArray(r?.content) ? r.content : []).filter((c: any) => c?.type === 'text' && typeof c.text === 'string').map((c: any) => c.text as string);
  if (r?.isError) throw new ErroAcao(`a ferramenta "${nome}" recusou: ${neutral(clip(textos.join(' ') || 'sem motivo', 300), 310)}`);
  if (r?.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;
  const junto = textos.join('\n');
  try { return junto ? JSON.parse(junto) : {}; } catch { return { texto: junto }; }
}

// ------------------------------------------------------------------------------------------- argumentos pelo esquema
const norma = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
/** path_contactId, query_locationId, body_message: o prefixo do grupo não conta no nome. */
const semGrupo = (k: string) => k.replace(/^(path|query|body|header|params?)[_.]/i, '');
const GRUPOS = new Set(['body', 'query', 'path', 'params', 'requestbody', 'data', 'input']);

export interface ArgLogico { nomes: string[]; valor: unknown; /** sem lugar no esquema, a ação para (escrita) em vez de seguir sem ele */ precisa?: boolean }

/**
 * Os argumentos lógicos no formato do esquema da ferramenta. Sem esquema conhecido, vão com o primeiro nome. Um argumento
 * lógico vazio não vai. Sem lugar para um que `precisa`: ErroAcao, antes de qualquer escrita.
 */
export function argumentosPeloEsquema(f: FerramentaMcp | undefined, logicos: ArgLogico[]): Record<string, unknown> {
  const props = f?.inputSchema?.properties && typeof f.inputSchema.properties === 'object' ? f.inputSchema.properties : null;
  const out: Record<string, any> = {};
  const vazio = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  // os lugares possíveis: o nome solto e o de dentro de cada grupo (body.contactId)
  const lugares: Array<{ caminho: string[]; nome: string }> = [];
  for (const [k, p] of Object.entries(props ?? {})) {
    lugares.push({ caminho: [k], nome: norma(semGrupo(k)) });
    if (GRUPOS.has(norma(k)) && p && typeof p === 'object' && p.properties && typeof p.properties === 'object') {
      for (const filho of Object.keys(p.properties)) lugares.push({ caminho: [k, filho], nome: norma(filho) });
    }
  }
  for (const a of logicos) {
    if (vazio(a.valor)) continue;
    if (!props) { out[a.nomes[0]] = a.valor; continue; }
    const procurados = a.nomes.map(norma);
    const lugar = procurados.map((n) => lugares.find((l) => l.nome === n)).find(Boolean);
    if (!lugar) {
      if (a.precisa) throw new ErroAcao(`a ferramenta "${f?.name}" não tem mais o campo "${a.nomes[0]}" (o serviço mudou): nada foi feito`);
      continue;
    }
    if (lugar.caminho.length === 1) out[lugar.caminho[0]] = a.valor;
    else { out[lugar.caminho[0]] = { ...(out[lugar.caminho[0]] ?? {}), [lugar.caminho[1]]: a.valor }; }
  }
  return out;
}

// -------------------------------------------------------------------------------------------- consulta ou escrita
/*
 * A mesma regra do complemento do motor para os conectores prontos (hermes/plugins/ergon_bridge, _mcp_consulta): só é
 * consulta o que começa por um verbo de leitura E não tem, em nenhuma outra parte do nome, palavra que muda dados. Na
 * dúvida, escrita. Os nomes com hífen ("contacts_get-contact") contam como palavras separadas, e o primeiro grupo antes
 * de "_" que é o assunto (contacts, conversations) não conta como verbo.
 */
const CONSULTA = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'query', 'describe', 'view', 'lookup', 'count', 'show',
  'whoami', 'retrieve', 'browse', 'preview', 'inspect', 'status', 'info', 'ping', 'help']);
const MUDA = new Set(['create', 'add', 'insert', 'update', 'upsert', 'edit', 'modify', 'patch', 'set', 'put', 'write', 'save', 'delete', 'remove',
  'destroy', 'erase', 'purge', 'clear', 'drop', 'archive', 'unarchive', 'move', 'rename', 'send', 'reply', 'forward', 'publish',
  'share', 'invite', 'assign', 'unassign', 'mark', 'close', 'reopen', 'approve', 'reject', 'submit', 'cancel', 'complete', 'resolve',
  'toggle', 'enable', 'disable', 'execute', 'exec', 'trigger', 'deploy', 'upload', 'import', 'transfer', 'pay', 'charge', 'refund',
  'subscribe', 'unsubscribe', 'grant', 'revoke', 'restore', 'kick', 'ban', 'mute', 'and', 'or', 'post', 'book', 'schedule', 'merge', 'void']);
const APAGA = new Set(['delete', 'remove', 'destroy', 'erase', 'purge', 'drop', 'cancel', 'void', 'refund']);
const ENVIA = new Set(['send', 'reply', 'forward', 'publish', 'post', 'share', 'invite', 'assign', 'email', 'sms', 'whatsapp', 'notify', 'charge', 'pay', 'transfer', 'book', 'schedule']);

const palavras = (nome: string): string[] =>
  nome.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** As palavras da ação: no nome "assunto_verbo-objeto" (contacts_get-contact), o assunto antes do primeiro "_" sai. */
function acaoDoNome(nome: string): string[] {
  const p = palavras(nome);
  const i = nome.indexOf('_');
  if (i > 0 && /-/.test(nome.slice(i + 1))) { const resto = palavras(nome.slice(i + 1)); if (resto.length) return resto; }
  return p;
}

export function consultaMcp(nome: string): boolean {
  const p = acaoDoNome(nome);
  if (!p.length) return false;
  if (p[0] === 'resolve' && p[p.length - 1] === 'id') return !p.slice(1).some((x) => MUDA.has(x));
  return CONSULTA.has(p[0]) && !p.slice(1).some((x) => MUDA.has(x));
}

/** O risco de uma ferramenta pelo nome: consulta lê; apagar, cancelar e estornar apagam; mandar a alguém envia; o resto organiza. */
export function riscoMcp(nome: string): Risco {
  if (consultaMcp(nome)) return 'ler';
  const p = palavras(nome);
  if (p.some((x) => APAGA.has(x))) return 'apagar';
  if (p.some((x) => ENVIA.has(x))) return 'enviar';
  return 'organizar';
}

// ---------------------------------------------------------------------------------------------- o transporte
/**
 * O `Http` das Conexões em cima do MCP: "/ferramentas" devolve a lista; "/ferramenta/<nome>" chama, com `body` = os
 * argumentos lógicos ({ args: ArgLogico[] }) ou já prontos ({ argumentos }). Escrita (`kind: 'write'`) nunca repete às cegas.
 */
export function transporteMcp(s: ServidorMcp): Http {
  return async (caminho, init = {}) => {
    const kind = init.kind ?? 'read';
    if (caminho === '/ferramentas') return { ferramentas: await ferramentasMcp(s) };
    const m = /^\/ferramenta\/([A-Za-z0-9_.:-]{1,120})$/.exec(caminho);
    if (!m) throw new ErroAcao('endereço fora do serviço');
    const nome = m[1];
    const lista = await ferramentasMcp(s);
    const f = lista.find((x) => x.name === nome);
    if (!f) throw new ErroAcao(s.semFerramenta?.(nome) ?? `o ${s.nome} não oferece a ferramenta "${nome}" para esta conta (nada foi feito)`);
    const b = (init.body ?? {}) as { args?: ArgLogico[]; argumentos?: Record<string, unknown> };
    const argumentos = b.argumentos ?? argumentosPeloEsquema(f, b.args ?? []);
    const { resposta } = await naSessao(s, 'tools/call', { name: nome, arguments: argumentos }, kind);
    return resultadoMcp(resposta, nome);
  };
}
