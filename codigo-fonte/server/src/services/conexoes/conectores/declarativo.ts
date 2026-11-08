/**
 * Conector por dados: um aplicativo novo é uma definição (endereço, autenticação e, para cada ação, método, caminho,
 * parâmetros, corpo e como ler a resposta), sem programa próprio. O mesmo motor valida parâmetros, autentica, trata erro
 * no corpo, limpa texto de terceiros e devolve ao agente, tanto na leitura quanto na escrita.
 *
 * Moldes: "{nome}" é trocado pelo parâmetro. No caminho entra codificado; na consulta e no corpo entra o valor (um molde
 * que é só "{nome}" mantém o tipo, e sem o parâmetro a chave some). Nas linhas de resposta, "{a.b}" lê do item e passa por
 * neutral(): texto de terceiros nunca vira linha de controle.
 */
import crypto from 'node:crypto';
import { clip } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { contaConferida, request, type ContaConferida } from '../../task-providers.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Http, type Param, type Resultado, type Risco } from '../tipos.ts';

export interface CampoCredencial { name: string; label: string; secret?: boolean; placeholder?: string; pattern?: RegExp; patternHelp?: string; /** pode ficar em branco (ex.: endereço de instalação própria) */ opcional?: boolean }
export type Credenciais = Record<string, string>;
/** Na ajuda da tela: um link com rótulo, ou um texto com o botão de copiar. */
export type AjudaExtra = { rotulo: string; url: string } | { rotulo: string; copiar: string };
export type Autenticacao =
  | { tipo: 'bearer'; campo?: string }
  /** cabeçalhos próprios (ex.: "Bot <token>", X-Auth-Token) */
  | { tipo: 'cabecalhos'; cabecalhos: (c: Credenciais) => Record<string, string> }
  | { tipo: 'basic'; usuario: (c: Credenciais) => string; senha: (c: Credenciais) => string }
  /** a credencial vai como parâmetro em toda chamada (ex.: RD Station CRM) */
  | { tipo: 'consulta'; parametro: string; campo?: string }
  /** credencial de aplicativo trocada por um acesso temporário, guardado até vencer (ex.: Zendesk) */
  | { tipo: 'cliente'; tokenUrl: (c: Credenciais) => string; id: (c: Credenciais) => string; segredo: (c: Credenciais) => string; escopo?: string }
  /** a credencial já vai no endereço base ou no corpo (ex.: Telegram, Omie) */
  | { tipo: 'nenhuma' };

export interface AcaoDecl {
  id: string;
  descricao: string;
  /** ver Acao.rotulo */
  rotulo?: string;
  risco: Risco | ((a: Args) => Risco);
  params: Record<string, Param>;
  /** o que vai acontecer, por extenso, com destinatário e texto inteiro: é o que a pessoa lê no cartão de confirmação */
  resumo: string | ((a: Args) => string);
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  caminho: string;
  consulta?: Record<string, string | number | boolean>;
  corpo?: unknown | ((a: Args, c: Credenciais) => unknown);
  cabecalhos?: Record<string, string>;
  /** troca nome por id, escolhe a opção certa, ou recusa com as opções: pode chamar o serviço */
  antes?: (ctx: CtxAcao, a: Args) => Promise<Args>;
  /** o que o cartão de confirmação precisa mostrar quando os parâmetros são só ids: ver Acao.preparar */
  preparar?: Acao['preparar'];
  /** leitura que não pode repetir em erro do serviço (a Omie bloqueia depois de poucos pedidos errados) */
  semRepetir?: boolean;
  /** onde está a lista na resposta ("data.items"; "" = a própria resposta) */
  lista?: string;
  /** como escrever cada item */
  linha?: string | ((x: any) => string);
  /** texto do resultado quando não há lista */
  texto?: string | ((j: any, a: Args) => string);
  /** o cursor da próxima página, na resposta; volta como o parâmetro `cursor` */
  proximo?: (j: any, a: Args) => string | null | undefined;
  /** nome do parâmetro de consulta que recebe o cursor */
  paramCursor?: string;
  url?: (j: any) => string | null | undefined;
}

export interface ConectorDef {
  kind: string; nome: string; site: string;
  grupo: 'conversas' | 'vendas' | 'suporte' | 'documentos' | 'financeiro';
  sobre: string;
  campos: CampoCredencial[];
  /** extras: links e textos a copiar que a tela mostra à parte (um endereço longo ou um JSON no meio dos passos ninguém lê) */
  ajuda: { url: string; passos: string; extras?: AjudaExtra[] };
  base: string | ((c: Credenciais) => string);
  auth: Autenticacao;
  /** erro dentro de uma resposta 200 (Slack: ok:false; GraphQL: errors): nunca pode parecer sucesso */
  erroNoCorpo?: (j: any) => { mensagem: string; permissao?: boolean } | null;
  /**
   * confere a credencial antes de dizer "conectado" e dá o nome da conta e, quando o serviço tem, o id dela lá (usuário,
   * bot, portal): o que diz se um token novo é da mesma conta (ver ContaConferida)
   */
  quemSou: { caminho: string | ((c: Credenciais) => string); metodo?: 'GET' | 'POST'; corpo?: unknown | ((c: Credenciais) => unknown); semRepetir?: boolean; nome: (j: any) => string; id?: (j: any) => unknown };
  acoes: AcaoDecl[];
}

/** Credencial trocada por uma conta real: nunca aparece em erro, registro ou resposta. */
const cabecalhosDe = (def: Pick<ConectorDef, 'auth'>, c: Credenciais): Record<string, string> => {
  const a = def.auth;
  if (a.tipo === 'bearer') return { Authorization: `Bearer ${c[a.campo ?? 'token']}` };
  if (a.tipo === 'cabecalhos') return a.cabecalhos(c);
  if (a.tipo === 'basic') return { Authorization: `Basic ${Buffer.from(`${a.usuario(c)}:${a.senha(c)}`).toString('base64')}` };
  return {};
};

/** Acesso temporário de quem conecta com credencial de aplicativo: um por credencial, renovado perto de vencer. */
const ACESSOS = new Map<string, { token: string; vence: number }>();
async function acessoDe(a: Extract<Autenticacao, { tipo: 'cliente' }>, c: Credenciais, renovar = false): Promise<string> {
  // o segredo entra na chave (resumido): sem ele, um segredo errado aproveitaria o acesso de quem conectou com o certo
  const url = a.tokenUrl(c); const k = `${url}|${a.id(c)}|${crypto.createHash('sha256').update(a.segredo(c)).digest('hex')}`;
  const hit = ACESSOS.get(k);
  if (!renovar && hit && hit.vence - Date.now() > 60_000) return hit.token;
  let j: any;
  try { j = await request(url, { method: 'POST', body: { grant_type: 'client_credentials', client_id: a.id(c), client_secret: a.segredo(c), ...(a.escopo ? { scope: a.escopo } : {}) }, redirect: 'error' }); } catch (e) {
    // credencial recusada na troca: não é o acesso vencido, e pedir de novo não adianta
    if (e instanceof ProviderError && e.status === 401) throw new ProviderError('forbidden', 'o serviço recusou a credencial: confira o identificador e o segredo em Conexões', { status: 403 });
    throw e;
  }
  if (typeof j.access_token !== 'string' || !j.access_token) throw new ProviderError('forbidden', 'o serviço não entregou o acesso: confira a credencial em Conexões', { status: 403 });
  if (ACESSOS.size > 200) ACESSOS.clear();
  ACESSOS.set(k, { token: j.access_token, vence: Date.now() + Number(j.expires_in ?? 1800) * 1000 });
  return j.access_token;
}

/**
 * Erro sem a credencial, onde quer que o serviço a tenha repetido: na consulta (RD Station), no endereço (Telegram) ou no
 * corpo (Omie). Vale para todo valor guardado com pelo menos 8 caracteres, cru, codificado para endereço e escapado em JSON.
 */
function valoresDe(c: Credenciais): string[] {
  const v = new Set<string>();
  for (const x of Object.values(c)) if (typeof x === 'string' && x.length >= 8) { v.add(x); v.add(encodeURIComponent(x)); v.add(JSON.stringify(x).slice(1, -1)); }
  return [...v].sort((a, b) => b.length - a.length); // o mais longo primeiro: um segredo pode conter outro
}

/** Chamada autenticada ao conector: o caminho é relativo ao endereço base, que nunca vem do modelo. */
export function httpDoConector(def: Pick<ConectorDef, 'auth' | 'base' | 'erroNoCorpo'>, c: Credenciais): Http {
  const base = (typeof def.base === 'function' ? def.base(c) : def.base).replace(/\/+$/, '');
  const segredos = valoresDe(c);
  const limpar = (t: string) => segredos.reduce((r, s) => r.split(s).join('***'), t);
  const http = chamadaDoConector(def, c, base, segredos, limpar);
  return async (caminho, init = {}) => {
    try { return await http(caminho, init); } catch (e) {
      if (e instanceof Error) e.message = limpar(e.message);
      throw e;
    }
  };
}

function chamadaDoConector(def: Pick<ConectorDef, 'auth' | 'erroNoCorpo'>, c: Credenciais, base: string, segredos: string[], limpar: (t: string) => string): Http {
  return async (caminho, init = {}) => {
    if (!caminho.startsWith('/')) throw new ErroAcao('endereço fora do serviço');
    const a = def.auth;
    // parâmetro de credencial: nunca aparece em erro, porque request() não repete o endereço
    const destino = a.tipo === 'consulta' ? `${base}${caminho}${caminho.includes('?') ? '&' : '?'}${encodeURIComponent(a.parametro)}=${encodeURIComponent(c[a.campo ?? 'token'] ?? '')}` : `${base}${caminho}`;
    // redirecionamento nunca: fetch mantém cabeçalhos próprios (X-Auth-Token, PRIVATE-TOKEN) ao mudar de domínio, e a credencial iria junto
    const chama = async (renovar: boolean) => request(destino, { ...init, redirect: 'error', segredos, headers: { ...cabecalhosDe(def, c), ...(a.tipo === 'cliente' ? { Authorization: `Bearer ${await acessoDe(a, c, renovar)}` } : {}), ...init.headers } });
    let j: any;
    try { j = await chama(false); } catch (e) {
      if (!(a.tipo === 'cliente' && e instanceof ProviderError && e.status === 401)) throw e;
      j = await chama(true); // o acesso temporário venceu antes da hora: 401 não fez nada, repetir é seguro
    }
    const e = def.erroNoCorpo?.(j);
    // sem a credencial antes do corte: pela metade, ela não seria reconhecida
    if (e) throw e.permissao ? new ProviderError('forbidden', `o serviço recusou: ${clip(limpar(e.mensagem), 200)}`, { status: 403 }) : new ProviderError('unavailable', `o serviço respondeu com erro: ${clip(limpar(e.mensagem), 200)}`);
    return j;
  };
}

/** Confere a credencial no serviço: o nome da conta e o id dela, quando o serviço tem. */
export async function contaDoConector(def: ConectorDef, c: Credenciais): Promise<ContaConferida> {
  const http = httpDoConector(def, c);
  const q = def.quemSou;
  const corpo = typeof q.corpo === 'function' ? (q.corpo as (x: Credenciais) => unknown)(c) : q.corpo;
  const j = await http(typeof q.caminho === 'function' ? q.caminho(c) : q.caminho, { method: q.metodo ?? 'GET', kind: q.semRepetir ? 'write' : 'read', ...(corpo !== undefined ? { body: corpo } : {}) });
  return contaConferida(clip(String(q.nome(j) || def.nome), 120), q.id?.(j));
}
/** Só o nome da conta (o que a tela mostra). */
export const conferirConector = async (def: ConectorDef, c: Credenciais): Promise<string> => (await contaDoConector(def, c)).nome;

// ---------------------------------------------------------------------------------------------------------- moldes
const pegar = (x: unknown, caminho: string): unknown => caminho.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), x);
const SO_MOLDE = /^\{([\w.]+)\}$/;
const vazio = (v: unknown) => v === undefined || v === null || v === '';

function molde(v: unknown, a: Args): unknown {
  if (typeof v === 'string') {
    const so = SO_MOLDE.exec(v);
    if (so) return a[so[1]];
    return v.replace(/\{([\w.]+)\}/g, (_m, k: string) => (vazio(a[k]) ? '' : String(a[k])));
  }
  if (Array.isArray(v)) return v.map((x) => molde(x, a)).filter((x) => !vazio(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = molde(x, a);
      // o que ficou vazio por falta de parâmetro some; um vazio escrito na definição (ex.: parse: []) fica
      const tinha = Array.isArray(x) ? x.length > 0 : !!x && typeof x === 'object' && Object.keys(x).length > 0;
      const esvaziou = tinha && (Array.isArray(r) ? !r.length : !!r && typeof r === 'object' && !Object.keys(r).length);
      if (!vazio(r) && !esvaziou) out[k] = r;
    }
    return out;
  }
  return v;
}

/** Linha de resposta: valores de terceiros limpos e curtos. */
export function linhaDe(m: string, x: unknown, max = 400): string {
  return m.replace(/\{([\w.]+)\}/g, (_m, k: string) => { const v = pegar(x, k); return vazio(v) ? '' : neutral(clip(String(v).replace(/\s+/g, ' '), max), max + 2); }).replace(/\s+/g, ' ').trim();
}

/** Parâmetros conferidos e nos tipos certos, com padrão e teto. */
function normalizar(params: Record<string, Param>, a: Args): Args {
  const out: Args = {};
  for (const [k, p] of Object.entries(params)) {
    let v = a[k];
    if (vazio(v)) { if (p.padrao !== undefined) out[k] = p.padrao; continue; }
    if (p.tipo === 'numero') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ErroAcao(`"${k}" precisa ser um número`);
      v = p.max !== undefined ? Math.min(n, p.max) : n;
    } else if (p.tipo === 'booleano') v = v === true || v === 'true' || v === 'sim';
    else if (p.tipo === 'lista') v = Array.isArray(v) ? v.map(String) : String(v).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
    else if (typeof v !== 'string' && typeof v !== 'number') throw new ErroAcao(`"${k}" precisa ser texto`);
    else {
      v = String(v);
      // cortar em silêncio mandaria menos do que o cartão mostrou
      if ((v as string).length > (p.max ?? TEXTO_MAX)) throw new ErroAcao(`"${k}" tem ${(v as string).length} caracteres, e o limite é ${p.max ?? TEXTO_MAX}: encurte ou divida (nada foi feito)`);
    }
    if (p.opcoes && !p.opcoes.includes(String(v))) throw new ErroAcao(`"${k}" precisa ser uma destas opções`, p.opcoes);
    out[k] = v;
  }
  if (!vazio(a.cursor)) out.cursor = String(a.cursor);
  return out;
}

const TEXTO_MAX = 100_000;
const P_CURSOR: Param = { tipo: 'texto', descricao: 'continua de onde parou: use o que veio em "cursor" na resposta anterior' };

/** A ação pronta, no contrato comum das conexões. */
export function acaoDe(d: AcaoDecl): Acao {
  return {
    id: d.id, descricao: d.descricao, ...(d.rotulo ? { rotulo: d.rotulo } : {}), risco: d.risco,
    params: d.proximo ? { ...d.params, cursor: P_CURSOR } : d.params,
    resumo: (a) => (typeof d.resumo === 'function' ? d.resumo(a) : String(molde(d.resumo, a) ?? d.id)),
    ...(d.preparar ? { preparar: d.preparar } : {}),
    async run(ctx, bruto): Promise<Resultado> {
      let a = normalizar(d.params, bruto);
      if (d.antes) a = await d.antes(ctx, a);
      const caminho = d.caminho.replace(/\{(\w+)\}/g, (_m, k: string) => {
        if (vazio(a[k])) throw new ErroAcao(`falta "${k}"`);
        return seg(a[k]);
      });
      const consulta = new URLSearchParams();
      for (const [k, v] of Object.entries((d.consulta ? molde(d.consulta, a) : {}) as Record<string, unknown>)) {
        for (const item of Array.isArray(v) ? v : [v]) consulta.append(k, String(item));
      }
      if (d.proximo && a.cursor) consulta.set(d.paramCursor ?? 'cursor', String(a.cursor));
      const qs = consulta.toString();
      const risco = typeof d.risco === 'function' ? d.risco(a) : d.risco;
      const corpo = typeof d.corpo === 'function' ? (d.corpo as (x: Args, c: Credenciais) => unknown)(a, ctx.creds ?? {}) : d.corpo !== undefined ? molde(d.corpo, a) : undefined;
      const j = await ctx.http(`${caminho}${qs ? `?${qs}` : ''}`, { method: d.metodo, kind: risco === 'ler' && !d.semRepetir ? 'read' : 'write', ...(corpo !== undefined ? { body: corpo } : {}), ...(d.cabecalhos ? { headers: d.cabecalhos } : {}) });
      const le = risco === 'ler';
      const prox = d.proximo?.(j, a);
      let texto: string;
      if (d.lista !== undefined) {
        const itens = (d.lista ? pegar(j, d.lista) : j) as unknown[];
        const l = Array.isArray(itens) ? itens : [];
        const fmt = d.linha ?? '{id}';
        texto = l.length ? l.map((x) => `- ${typeof fmt === 'function' ? fmt(x) : linhaDe(fmt, x)}`).join('\n') : 'nada encontrado';
      } else if (typeof d.texto === 'function') texto = d.texto(j, a);
      else if (d.texto) texto = linhaDe(d.texto, { ...a, ...(j && typeof j === 'object' ? j : {}) }, 2000);
      else texto = 'feito';
      if (prox) texto += `\ncursor: ${String(prox)}`;
      return { texto, url: d.url?.(j) ?? null, ...(le ? { deFora: true, privado: true } : {}) };
    },
  };
}

/** Host informado pela pessoa (instalação própria ou subdomínio): só o nome, e nunca um endereço interno. */
export function hostSeguro(valor: string, sufixo?: RegExp): string {
  const bruto = String(valor ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (/[\\@]/.test(bruto)) throw new ErroAcao('endereço inválido: use só o nome, como empresa.exemplo.com');
  // quem cola o endereço de uma página quer dizer o domínio: a credencial continua indo só a ele
  const h = bruto.replace(/[/?#].*$/, '').toLowerCase();
  if (!/^[a-z0-9.-]{3,253}(:\d{2,5})?$/.test(h) || !h.includes('.')) throw new ErroAcao('endereço inválido: use só o nome, como empresa.exemplo.com');
  // o que o navegador e o fetch entendem: 127.1, 0x7f.0.0.1, 2130706433 e "localhost." viram o endereço de verdade
  let nome: string;
  try { nome = new URL(`https://${h}/`).hostname.replace(/\.$/, ''); } catch { throw new ErroAcao('endereço inválido: use só o nome, como empresa.exemplo.com'); }
  if (/^(localhost|.*\.local|.*\.internal|.*\.intranet|.*\.lan|.*\.home|.*\.corp|.*\.localhost)$/.test(nome) || /^\d{1,3}(\.\d{1,3}){3}$/.test(nome) || nome.startsWith('[')) throw new ErroAcao('endereço interno não é aceito: use o endereço público do serviço');
  if (sufixo && !sufixo.test(nome)) throw new ErroAcao('endereço inválido para este serviço');
  return h.includes(':') ? `${nome}:${h.split(':')[1]}` : nome;
}
