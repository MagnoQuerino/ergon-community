/**
 * Controle do computador (rc.42): o agente usa a área de trabalho da pessoa — move o mouse, clica, digita, abre programas.
 *
 * O motor roda num contêiner e não tem tela. Quem mexe no computador é o Ergon Desktop (o aplicativo da pessoa, no
 * hospedeiro), que abre daqui de dentro um WebSocket para este serviço com a sessão da própria pessoa (o cookie da janela
 * do Ergon, origem do Ergon, só 127.0.0.1): nenhuma porta nova é aberta no computador, nada fica exposto na rede.
 *
 *   ferramenta computer_use do motor → provedor "ergon" (hermes/plugins/computer_use_ergon) → POST
 *   /internal/bridge/v1/computador (token da ponte) → ESTE SERVIÇO (decide, pergunta, registra) → WebSocket do aparelho
 *   → Ergon Desktop (desktop/src-tauri/src/computador) → mouse, teclado e captura de tela do sistema
 *
 * O que este serviço garante:
 * - desligado por padrão; ligar é da pessoa (cartão "Ativar acesso total?" na primeira vez que um agente precisa, ou na tela
 *   de Configurações). Quem administra bloqueia para o workspace (vale acima de tudo);
 * - "Assumir o controle" (na barra do Ergon, no selo da área de trabalho, ou mexendo o mouse de verdade, ou a tecla de
 *   pânico) para o agente na hora: nada mais chega ao aparelho até a pessoa conceder de novo;
 * - as ações sempre protegidas (o mesmo princípio de "Liberar tudo" nas Conexões): digitar o que parece senha, chave ou
 *   número de cartão, apagar de vez, abrir o cofre de senhas — pedem o clique da pessoa toda vez, mesmo com acesso total;
 * - o registro guarda cada ação (clique e onde, quantos caracteres digitados, qual programa), nunca o texto digitado; as
 *   capturas de tela passam para o agente e não são guardadas;
 * - na nuvem não há área de trabalho: a ferramenta responde isso ao agente, sem perguntar nada à pessoa.
 */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { Db } from '../db/db.ts';
import { log } from '../lib/log.ts';
import { HttpError, clip } from '../lib/util.ts';
import type { AuthContext } from './auth.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting, setSetting } from './sectors.ts';

// ---------------------------------------------------------------------------------------------- política (pura)

/** desligado (padrão) · cada_acao: confirma cada ação que mexe · total: acesso total (as protegidas ainda perguntam) */
export type Modo = 'desligado' | 'cada_acao' | 'total';
export const MODOS: readonly Modo[] = ['desligado', 'cada_acao', 'total'];
export type Decisao = 'direto' | 'confirmar' | 'ativar' | 'recusar';

/** As ações da ferramenta computer_use do motor (tools/computer_use/schema.py). */
export const ACOES = ['capture', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'type', 'key', 'set_value', 'wait', 'list_apps', 'list_windows', 'focus_app'] as const;
export type Acao = (typeof ACOES)[number];
/** só olham: não mexem em nada (mas também só com o recurso ligado) */
const LEITURA = new Set<Acao>(['capture', 'wait', 'list_apps', 'list_windows']);

const SEGREDO = [
  /(?:senha|password|passwd|pwd|passphrase|token|secret|segredo|api[_-]?key|chave)\s*[:=]/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];
const APAGAR_DE_VEZ = [
  /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+/i, /\bdel\s+(?:\/[a-z]\s*)*\/[fsq]\b/i, /\brmdir\s+\/s\b/i, /\brd\s+\/s\b/i, /\bformat(?:\.com)?\s+[a-z]:/i,
  /\bRemove-Item\b[^\n]*-(?:Recurse|Force)\b/i, /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, /\bTRUNCATE\s+TABLE\b/i, /\bshred\b/i, /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+[^\n]*of=\/dev\//i, /\bgit\s+push\b[^\n]*(?:--force|\s-f\b)/i, /\bgh\s+repo\s+delete\b/i, /\bglab\s+repo\s+delete\b/i,
];
const PAGAMENTO = [/\b(?:cvv|cvc|c[oó]digo de seguran[cç]a)\b/i];
const COFRE_DE_SENHAS = /1password|bitwarden|keepass|lastpass|dashlane|enpass|proton\s*pass|keychain|acesso [àa]s chaves|gerenciador de senhas|password manager|credential manager|gerenciador de credenciais|seahorse/i;

function luhn(digitos: string): boolean {
  let soma = 0; let dobra = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = digitos.charCodeAt(i) - 48;
    if (dobra) { d *= 2; if (d > 9) d -= 9; }
    soma += d; dobra = !dobra;
  }
  return soma % 10 === 0;
}
/** Um número de cartão (13 a 19 dígitos, com espaços ou traços, que passa no dígito verificador). */
export function pareceCartao(texto: string): boolean {
  for (const m of texto.matchAll(/(?:\d[ -]?){12,18}\d/g)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) return true; }
  return false;
}
/** Uma palavra só, longa, misturando maiúsculas, minúsculas, números e símbolos: o jeito de uma senha. */
export function pareceSenha(texto: string): boolean {
  const t = texto.trim();
  if (t.length < 10 || t.length > 128 || /\s/.test(t) || /^https?:\/\//i.test(t)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
  return classes >= 3 && !/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t);
}
const combo = (keys: string) => new Set(keys.toLowerCase().split(/\s*[+-]\s*/).map((k) => ({ control: 'ctrl', command: 'cmd', option: 'alt', del: 'delete' } as Record<string, string>)[k] ?? k).filter(Boolean));

/**
 * O que a ação é. protegida = o motivo (sempre pede o clique da pessoa, acima de "Liberar tudo" e do acesso total).
 * Os padrões olham só o que o agente mandou; o texto não vai a registro nenhum.
 */
export function classificar(acao: Acao, args: Record<string, unknown>): { leitura: boolean; protegida: string | null } {
  if (LEITURA.has(acao)) return { leitura: true, protegida: null };
  const texto = typeof args.text === 'string' ? args.text : typeof args.value === 'string' ? args.value : '';
  if (texto) {
    if (pareceCartao(texto) || PAGAMENTO.some((r) => r.test(texto))) return { leitura: false, protegida: 'pagamento' };
    if (SEGREDO.some((r) => r.test(texto)) || pareceSenha(texto)) return { leitura: false, protegida: 'segredo' };
    if (APAGAR_DE_VEZ.some((r) => r.test(texto))) return { leitura: false, protegida: 'apagar' };
  }
  if (acao === 'key' && typeof args.keys === 'string') {
    const k = combo(args.keys);
    if (k.has('shift') && (k.has('delete') || (k.has('cmd') && k.has('backspace')))) return { leitura: false, protegida: 'apagar' };
  }
  if (acao === 'focus_app' && typeof args.app === 'string' && COFRE_DE_SENHAS.test(args.app)) return { leitura: false, protegida: 'segredo' };
  return { leitura: false, protegida: null };
}

/**
 * A decisão de uma ação. Ordem: o bloqueio de quem administra; o recurso desligado (pergunta "Ativar acesso total?", a
 * menos que a pessoa tenha dito "não perguntar novamente"); as protegidas (sempre o cartão); o acesso total ou "só desta
 * vez"; e, confirmando cada ação, só as que olham seguem direto — ou todas, com "Liberar tudo" das Conexões ligado.
 */
export function decidir(x: { bloqueado: boolean; modo: Modo; naoPerguntar: boolean; liberarTudo: boolean; leitura: boolean; protegida: boolean; umaVez: boolean }): Decisao {
  if (x.bloqueado) return 'recusar';
  if (x.modo === 'desligado' && !x.umaVez) return x.naoPerguntar ? 'recusar' : 'ativar';
  if (x.protegida) return 'confirmar';
  if (x.modo === 'total' || x.umaVez || x.leitura) return 'direto';
  return x.liberarTudo ? 'direto' : 'confirmar';
}

/** O que vai ao registro: o tipo e onde, nunca o conteúdo digitado. */
export function resumoParaRegistro(acao: Acao, a: Record<string, unknown>): string {
  const xy = Array.isArray(a.coordinate) && a.coordinate.length === 2 ? ` em ${Number(a.coordinate[0])}, ${Number(a.coordinate[1])}` : typeof a.element === 'number' ? ` no item ${a.element}` : '';
  switch (acao) {
    case 'click': return `clicou${xy}`;
    case 'double_click': return `clicou duas vezes${xy}`;
    case 'right_click': return `clicou com o botão direito${xy}`;
    case 'middle_click': return `clicou com o botão do meio${xy}`;
    case 'drag': return 'arrastou';
    case 'scroll': return `rolou para ${({ up: 'cima', down: 'baixo', left: 'a esquerda', right: 'a direita' } as Record<string, string>)[String(a.direction)] ?? 'baixo'}${xy}`;
    case 'type': return `digitou ${typeof a.text === 'string' ? [...a.text].length : 0} caracteres`;
    case 'set_value': return 'escolheu um valor';
    case 'key': return `apertou ${clip(String(a.keys ?? ''), 40).replace(/[^\w+\- ]/g, '')}`;
    case 'focus_app': return `abriu ${clip(String(a.app ?? ''), 60).replace(/[\u0000-\u001f]/g, '')}`;
    default: return acao;
  }
}

/** O texto curto que o cartão mostra à pessoa (o que o agente quer fazer); a digitação aparece só como "digitar". */
export function resumoParaCartao(acao: Acao, a: Record<string, unknown>, protegida: string | null): string {
  if (protegida === 'segredo') return acao === 'focus_app' ? 'abrir o cofre de senhas' : 'digitar uma senha ou chave';
  if (protegida === 'pagamento') return 'digitar dados de pagamento';
  if (protegida === 'apagar') return 'apagar de vez';
  return resumoParaRegistro(acao, a);
}

const inteiro = (v: unknown, max = 100_000) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const par = (v: unknown) => Array.isArray(v) && v.length === 2 && inteiro(v[0]) && inteiro(v[1]);
const BOTAO = new Set(['left', 'right', 'middle']);
const MODIFICADORES = new Set(['cmd', 'shift', 'option', 'alt', 'ctrl', 'fn', 'win', 'windows', 'super', 'meta']);
const DIRECAO = new Set(['up', 'down', 'left', 'right']);
export const TEXTO_MAX = 4000;

/**
 * Confere o que o motor pede e devolve só os campos que o aparelho entende (o resto do pedido fica aqui). Um pedido fora
 * do formato não chega ao computador da pessoa.
 */
export function pedidoParaOAparelho(acaoRaw: unknown, args: Record<string, unknown>): { acao: Acao; args: Record<string, unknown> } | { erro: string } {
  const acao = String(acaoRaw ?? '').trim().toLowerCase() as Acao;
  if (!ACOES.includes(acao)) return { erro: `ação desconhecida: ${clip(String(acaoRaw ?? ''), 30)}` };
  const o: Record<string, unknown> = {};
  if (args.coordinate !== undefined && args.coordinate !== null) { if (!par(args.coordinate)) return { erro: 'coordinate deve ser [x, y] em pixels da captura' }; o.coordinate = args.coordinate; }
  if (args.element !== undefined && args.element !== null) return { erro: 'este computador não numera os itens da tela: use coordinate [x, y] da última captura (mode "vision")' };
  if (args.button !== undefined) { if (!BOTAO.has(String(args.button))) return { erro: 'button inválido' }; o.button = args.button; }
  if (args.modifiers !== undefined) {
    if (!Array.isArray(args.modifiers) || args.modifiers.length > 4 || !args.modifiers.every((m) => MODIFICADORES.has(String(m)))) return { erro: 'modifiers inválido' };
    o.modifiers = args.modifiers.map(String);
  }
  switch (acao) {
    case 'click': case 'double_click': case 'right_click': case 'middle_click':
      if (!o.coordinate) return { erro: `${acao} precisa de coordinate [x, y]` };
      break;
    case 'drag':
      if (!par(args.from_coordinate) || !par(args.to_coordinate)) return { erro: 'drag precisa de from_coordinate e to_coordinate' };
      o.from_coordinate = args.from_coordinate; o.to_coordinate = args.to_coordinate;
      break;
    case 'scroll':
      o.direction = DIRECAO.has(String(args.direction)) ? args.direction : 'down';
      o.amount = inteiro(args.amount, 50) ? args.amount : 3;
      break;
    case 'type': case 'set_value': {
      const t = acao === 'type' ? args.text : args.value;
      if (typeof t !== 'string' || !t) return { erro: `${acao} precisa de ${acao === 'type' ? 'text' : 'value'}` };
      if (t.length > TEXTO_MAX) return { erro: `texto longo demais (máximo ${TEXTO_MAX} caracteres por vez)` };
      o.text = t;
      break;
    }
    case 'key':
      if (typeof args.keys !== 'string' || !/^[A-Za-z0-9+\-_ ]{1,60}$/.test(args.keys)) return { erro: 'keys inválido (ex.: "ctrl+s", "return")' };
      o.keys = args.keys;
      break;
    case 'focus_app':
      if (typeof args.app !== 'string' || !/^[^\u0000-\u001f"'`$;&|<>\\]{1,120}$/.test(args.app)) return { erro: 'app inválido' };
      o.app = args.app.trim();
      break;
    case 'wait':
      o.seconds = typeof args.seconds === 'number' && args.seconds >= 0 ? Math.min(args.seconds, 10) : 1;
      break;
    case 'capture':
      if (args.mode === 'ax') return { erro: 'este computador não lê a árvore de acessibilidade: use mode "vision"' };
      break;
    default:
  }
  return { acao, args: o };
}

/** Do aparelho para o motor passa só o que a ferramenta entende (a captura vai inteira, só para o agente). */
export function respostaDoAparelho(r: unknown): Record<string, unknown> {
  if (!r || typeof r !== 'object') return { ok: false, error: 'resposta inválida do Ergon Desktop' };
  const x = r as Record<string, unknown>;
  const o: Record<string, unknown> = { ok: x.ok === true };
  if (typeof x.message === 'string') o.message = clip(x.message, 500);
  if (typeof x.error === 'string') o.error = clip(x.error, 500);
  if (typeof x.code === 'string' && /^[a-z_]{1,40}$/.test(x.code)) o.code = x.code;
  if (typeof x.png_b64 === 'string' && x.png_b64.length <= IMAGEM_MAX && /^[A-Za-z0-9+/=]+$/.test(x.png_b64.slice(0, 200))) o.png_b64 = x.png_b64;
  if (typeof x.mime === 'string' && /^image\/(png|jpeg)$/.test(x.mime)) o.mime = x.mime;
  for (const k of ['width', 'height'] as const) if (inteiro(x[k], 20000)) o[k] = x[k];
  for (const k of ['apps', 'windows'] as const) {
    if (Array.isArray(x[k])) o[k] = (x[k] as unknown[]).slice(0, 200).filter((i) => i && typeof i === 'object').map((i) => {
      const it = i as Record<string, unknown>;
      return { name: clip(String(it.name ?? ''), 120), ...(inteiro(it.pid, 10_000_000) ? { pid: it.pid } : {}), ...(typeof it.title === 'string' ? { title: clip(it.title, 200) } : {}) };
    });
  }
  return o;
}
/** uma captura de tela em base64 (8 MB): bem acima de uma tela 4K em PNG reduzida a 1600 px */
export const IMAGEM_MAX = 8 * 1024 * 1024;

/** Permissões do sistema que o aparelho conta ao chegar; `passo` é a instrução única que a tela mostra quando falta. */
export interface Permissoes { entrada: boolean; tela: boolean; passo: string | null }
export function permissoesDe(v: unknown): Permissoes {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const passo = typeof p.passo === 'string' && /^[a-z_]{1,40}$/.test(p.passo) ? p.passo : null;
  return { entrada: p.entrada !== false, tela: p.tela !== false, passo };
}

// ---------------------------------------------------------------------------------------------- mensagens ao agente

export const MSG = {
  nuvem: 'Na nuvem não há área de trabalho: o controle do computador só funciona com o Ergon Desktop aberto no computador da pessoa. Faça o trabalho por outro caminho (Conexões, navegador) ou diga em uma frase que isso precisa ser feito no computador dela.',
  bloqueado: 'Quem administra este workspace bloqueou o controle do computador. Não tente outro caminho para mexer no computador da pessoa: diga em uma frase o que você faria.',
  desligado: 'A pessoa deixou o controle do computador desligado. Não insista nem tente outro caminho para mexer no computador dela: continue sem isso e diga em uma frase o que ficou faltando.',
  recusou: 'A pessoa preferiu não liberar agora. Continue sem mexer no computador dela e diga em uma frase o que ficou faltando.',
  semAparelho: 'O Ergon Desktop não está aberto no computador da pessoa (é por ele que o computador é controlado). Peça em uma frase para ela abrir o Ergon Desktop e tente de novo depois.',
  permissao: 'O sistema do computador ainda não deu ao Ergon Desktop a permissão de controlar o mouse e o teclado ou de ver a tela. A pessoa já vê na tela o passo para liberar; espere ela liberar e tente de novo.',
  pessoa: 'A pessoa assumiu o controle do computador e está usando agora. Não aja nem capture a tela até ela conceder o controle de volta; não tente contornar por outro caminho. Para continuar esperando, chame de novo em instantes.',
  semResposta: 'A pessoa ainda não respondeu ao pedido na tela dela. Para continuar esperando, chame a mesma ação de novo; se não for urgente, siga com o resto e diga em uma frase o que espera dela.',
  recusouAcao: 'A pessoa não permitiu esta ação no computador. Não tente de novo do mesmo jeito nem por outro caminho; diga em uma frase o que você ia fazer.',
  caiu: 'O Ergon Desktop não respondeu a tempo. Capture a tela de novo para ver como ficou antes de continuar.',
} as const;

// ---------------------------------------------------------------------------------------------- o serviço

/** quanto o pedido do motor espera a pessoa decidir no cartão (como o navegador: 240 s); depois, o agente chama de novo */
export const esperaMs = (): number => Number(process.env.ERGON_COMPUTADOR_ESPERA_MS ?? 240_000);
const acaoMs = (): number => Number(process.env.ERGON_COMPUTADOR_ACAO_MS ?? 30_000);
/** sem ação há este tempo, o computador deixa de estar "em uso" (a borda e o selo somem) */
export const EM_USO_MS = Number(process.env.ERGON_COMPUTADOR_EM_USO_MS ?? 15_000);
const PEDIDO_VALE_MS = 10 * 60_000;
const SESSAO_CONFERE_MS = 30_000;

export interface ExecucaoPC { id: string; workspace_id: string; agent_id: string; conversation_id: string | null; task_id: string | null }
interface Aparelho {
  id: string; ws: WebSocket; userId: string; workspaceId: string; tokenHash: string; cookie: string; nome: string;
  so: string; versao: string; permissoes: Permissoes; tela: { largura: number; altura: number } | null;
  esperando: Map<string, (r: Record<string, unknown>) => void>;
}
interface Uso { runId: string; workspaceId: string; agente: string; desde: number; ultima: number; resumo: string }
interface Controle { quem: 'agente' | 'pessoa'; motivo: string | null; desde: number }
export type Escolha = 'ativar' | 'uma_vez' | 'agora_nao' | 'permitir' | 'recusar';
interface Pedido {
  id: string; tipo: 'ativar' | 'confirmar'; workspaceId: string; userId: string; runId: string; agente: string; resumo: string; protegida: string | null;
  criado: number; esperas: Array<(e: Escolha) => void>;
}

export interface DepsComputador {
  db: Db; bus: Bus;
  /** cfg.allowedOrigins: de onde o aparelho pode abrir a ligação (o aplicativo manda a origem do Ergon local) */
  origens: readonly string[];
  /** a sessão do cookie, se vale agora (a mesma conferência da tela) */
  sessao: (cookieHeader: string | undefined) => AuthContext | null;
  /** sem área de trabalho (servidor na nuvem) */
  nuvem: boolean;
  /** "Liberar tudo, por minha conta" (Conexões; o do workspace ou o da pessoa): também tira a confirmação de cada ação no computador */
  liberarTudo: (workspaceId: string, userId: string) => boolean;
  /** de quem é a execução (a dona da conversa; num card, null) */
  donoDe: (run: ExecucaoPC) => string | null;
  /** a pessoa é deste workspace? */
  membro: (workspaceId: string, userId: string) => boolean;
  nomeDoAgente: (run: ExecucaoPC) => string;
}

export interface EstadoComputador {
  disponivel: boolean;
  aparelho: { conectado: boolean; so: string | null; permissoes: Permissoes | null };
  modo: Modo; naoPerguntar: boolean; bloqueado: boolean; liberarTudo: boolean; administra: boolean;
  controle: 'agente' | 'pessoa'; motivo: string | null;
  emUso: { agente: string; desde: string; resumo: string } | null;
  /** recurso: do que é o cartão ("computador" aqui; o mesmo cartão "Ativar acesso total?" serve a outros recursos) */
  pedidos: Array<{ id: string; tipo: 'ativar' | 'confirmar'; recurso: 'computador'; agente: string; resumo: string; protegida: string | null }>;
}

export class Computador {
  private readonly aparelhos = new Map<string, Aparelho>();   // userId → aparelho (o mais recente vale)
  private readonly usos = new Map<string, Uso>();              // userId → uso agora
  private readonly controles = new Map<string, Controle>();    // userId → com quem está
  private readonly pedidos = new Map<string, Pedido>();
  private readonly umaVez = new Set<string>();                 // runIds com "Só desta vez"
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: IMAGEM_MAX + 64 * 1024, perMessageDeflate: false });
  private relogio: NodeJS.Timeout | null = null;
  private readonly d: DepsComputador;

  constructor(d: DepsComputador) { this.d = d; }

  // ---------- ajustes (por pessoa no workspace; o bloqueio é do workspace)
  modo(ws: string, userId: string): Modo { const m = getSetting(this.d.db, ws, `computador.modo:${userId}`) as Modo | null; return m && MODOS.includes(m) ? m : 'desligado'; }
  naoPerguntar(ws: string, userId: string): boolean { return getSetting(this.d.db, ws, `computador.nao_perguntar:${userId}`) === '1'; }
  bloqueado(ws: string): boolean { return getSetting(this.d.db, ws, 'computador.bloqueado') === '1'; }

  definirModo(a: AuthContext, modo: Modo, naoPerguntar?: boolean): void {
    if (this.bloqueado(a.workspaceId) && modo !== 'desligado') throw new HttpError(409, 'bloqueado', 'Quem administra bloqueou o controle do computador neste workspace.');
    setSetting(this.d.db, a.workspaceId, `computador.modo:${a.userId}`, modo);
    if (naoPerguntar !== undefined) setSetting(this.d.db, a.workspaceId, `computador.nao_perguntar:${a.userId}`, naoPerguntar ? '1' : '0');
    audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'computador.modo', evidence: { modo }, result: { desligado: 'controle do computador desligado', cada_acao: 'controle do computador: confirmar cada ação', total: 'controle do computador: acesso total' }[modo] });
    if (modo === 'desligado') this.assumir(a.userId, 'desligou');
    this.avisar(a.workspaceId);
  }

  /**
   * O "Ativar acesso total?" de Mãos na massa (POST /api/acesso-total, ramo claude/rc42-maos): a mesma ativação põe o
   * computador da pessoa em "total". Bloqueado por quem administra ou na nuvem: fica como está, sem derrubar a ativação.
   */
  aoAtivarAcessoTotal(a: AuthContext): void {
    if (this.d.nuvem || this.bloqueado(a.workspaceId) || this.modo(a.workspaceId, a.userId) === 'total') return;
    this.definirModo(a, 'total');
  }

  definirBloqueio(a: AuthContext, bloqueado: boolean): void {
    if (a.role !== 'owner') throw new HttpError(403, 'forbidden', 'Só quem administra o workspace bloqueia o controle do computador.');
    setSetting(this.d.db, a.workspaceId, 'computador.bloqueado', bloqueado ? '1' : '0');
    audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'computador.bloqueio', evidence: { bloqueado }, result: bloqueado ? 'controle do computador bloqueado no workspace' : 'controle do computador liberado no workspace' });
    if (bloqueado) {
      for (const p of [...this.pedidos.values()]) if (p.workspaceId === a.workspaceId) this.responderPedido(p, 'recusar');
      for (const [userId, u] of this.usos) if (u.workspaceId === a.workspaceId) this.assumir(userId, 'bloqueado');
    }
    this.avisar(a.workspaceId);
  }

  estado(a: AuthContext): EstadoComputador {
    const ap = this.aparelhos.get(a.userId);
    const uso = this.usoVivo(a.userId);
    const c = this.controles.get(a.userId);
    return {
      disponivel: !this.d.nuvem,
      aparelho: { conectado: !!ap, so: ap?.so ?? null, permissoes: ap?.permissoes ?? null },
      modo: this.modo(a.workspaceId, a.userId), naoPerguntar: this.naoPerguntar(a.workspaceId, a.userId), bloqueado: this.bloqueado(a.workspaceId),
      liberarTudo: this.d.liberarTudo(a.workspaceId, a.userId), administra: a.role === 'owner',
      controle: c?.quem ?? 'agente', motivo: c?.motivo ?? null,
      emUso: uso && uso.workspaceId === a.workspaceId ? { agente: uso.agente, desde: new Date(uso.desde).toISOString(), resumo: uso.resumo } : null,
      pedidos: [...this.pedidos.values()].filter((p) => p.userId === a.userId && p.workspaceId === a.workspaceId).map((p) => ({ id: p.id, tipo: p.tipo, recurso: 'computador' as const, agente: p.agente, resumo: p.resumo, protegida: p.protegida })),
    };
  }

  // ---------- Assumir / Conceder
  /** A pessoa assume: nada mais chega ao aparelho até ela conceder. O pedido em curso no aparelho é parado. */
  assumir(userId: string, motivo: string): void {
    const antes = this.controles.get(userId)?.quem;
    this.controles.set(userId, { quem: 'pessoa', motivo, desde: Date.now() });
    const ap = this.aparelhos.get(userId);
    if (ap) this.mandar(ap, { t: 'parar' });
    const uso = this.usos.get(userId);
    if (antes !== 'pessoa' && uso) audit(this.d.db, this.d.bus, { workspaceId: uso.workspaceId, actorType: 'user', actorId: userId, action: 'computador.assumiu', targetType: 'run', targetId: uso.runId, evidence: { motivo }, result: 'a pessoa assumiu o controle do computador' });
    this.atualizarAparelho(userId);
    this.avisarPessoa(userId);
  }

  conceder(userId: string): void {
    const c = this.controles.get(userId);
    if (!c || c.quem !== 'pessoa') return;
    this.controles.set(userId, { quem: 'agente', motivo: null, desde: Date.now() });
    const uso = this.usos.get(userId);
    if (uso) audit(this.d.db, this.d.bus, { workspaceId: uso.workspaceId, actorType: 'user', actorId: userId, action: 'computador.concedeu', targetType: 'run', targetId: uso.runId, result: 'a pessoa concedeu o controle do computador de volta' });
    this.atualizarAparelho(userId);
    this.avisarPessoa(userId);
  }

  // ---------- cartões
  responder(a: AuthContext, pedidoId: string, escolha: Escolha, naoPerguntar = false): void {
    const p = this.pedidos.get(pedidoId);
    if (!p || p.userId !== a.userId || p.workspaceId !== a.workspaceId) throw new HttpError(404, 'not_found', 'pedido não encontrado');
    if (p.tipo === 'ativar' && !['ativar', 'uma_vez', 'agora_nao'].includes(escolha)) throw new HttpError(400, 'validation', 'escolha inválida');
    if (p.tipo === 'confirmar' && !['permitir', 'recusar'].includes(escolha)) throw new HttpError(400, 'validation', 'escolha inválida');
    if (p.tipo === 'ativar') {
      if (escolha === 'ativar') this.definirModo(a, 'total', naoPerguntar || undefined);
      else if (escolha === 'uma_vez') this.umaVez.add(p.runId);
      else if (naoPerguntar) setSetting(this.d.db, a.workspaceId, `computador.nao_perguntar:${a.userId}`, '1');
      audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'computador.ativacao', targetType: 'run', targetId: p.runId, evidence: { escolha, naoPerguntar }, result: { ativar: 'acesso total ativado', uma_vez: 'liberado só para este trabalho', agora_nao: 'não liberado agora' }[escolha as 'ativar' | 'uma_vez' | 'agora_nao'] });
    } else {
      audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: escolha === 'permitir' ? 'computador.permitiu' : 'computador.recusou', targetType: 'run', targetId: p.runId, evidence: { acao: p.resumo, protegida: p.protegida }, result: escolha === 'permitir' ? `permitiu: ${p.resumo}` : `recusou: ${p.resumo}` });
    }
    this.responderPedido(p, escolha);
  }

  private responderPedido(p: Pedido, e: Escolha): void {
    this.pedidos.delete(p.id);
    for (const f of p.esperas) f(e);
    this.avisar(p.workspaceId);
  }

  /** Espera a pessoa decidir (o mesmo pedido, se o agente chamar de novo); null = ainda não respondeu. */
  private perguntar(base: Omit<Pedido, 'id' | 'criado' | 'esperas'>, espera = esperaMs()): Promise<Escolha | null> {
    let p = [...this.pedidos.values()].find((x) => x.runId === base.runId && x.tipo === base.tipo && x.resumo === base.resumo);
    if (!p) {
      p = { ...base, id: `cmp_${crypto.randomBytes(16).toString('hex')}`, criado: Date.now(), esperas: [] };
      this.pedidos.set(p.id, p);
      this.avisar(base.workspaceId);
    }
    const pedido = p;
    return new Promise((ok) => {
      const t = setTimeout(() => { pedido.esperas = pedido.esperas.filter((f) => f !== fim); ok(null); }, espera);
      const fim = (e: Escolha) => { clearTimeout(t); ok(e); };
      pedido.esperas.push(fim);
    });
  }

  // ---------- do motor
  /** Qual aparelho serve esta execução: o da dona da conversa; num card, o de quem do workspace estiver com o Ergon Desktop aberto. */
  private aparelhoPara(run: ExecucaoPC): Aparelho | null {
    const dono = this.d.donoDe(run);
    if (dono) { const ap = this.aparelhos.get(dono); return ap && this.d.membro(run.workspace_id, dono) ? ap : null; }
    const daqui = [...this.aparelhos.values()].filter((ap) => this.d.membro(run.workspace_id, ap.userId));
    return daqui.find((ap) => ap.workspaceId === run.workspace_id) ?? daqui[0] ?? null;
  }

  async doMotor(run: ExecucaoPC, acaoRaw: unknown, argsRaw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recusa = (code: string, error: string) => ({ ok: false, code, error });
    if (this.d.nuvem) return recusa('sem_area_de_trabalho', MSG.nuvem);
    const ped = pedidoParaOAparelho(acaoRaw, argsRaw ?? {});
    if ('erro' in ped) return recusa('invalid', ped.erro);
    const ws = run.workspace_id;
    if (this.bloqueado(ws)) return recusa('bloqueado', MSG.bloqueado);
    const ap = this.aparelhoPara(run);
    if (!ap) return recusa('sem_aparelho', MSG.semAparelho);
    const userId = ap.userId;
    if (!ap.permissoes.entrada || !ap.permissoes.tela) return recusa('permissao', MSG.permissao);
    if (this.controles.get(userId)?.quem === 'pessoa') return recusa('human_has_control', MSG.pessoa);
    const c = classificar(ped.acao, ped.args);
    const agente = this.d.nomeDoAgente(run);
    const base = { workspaceId: ws, userId, runId: run.id, agente, protegida: c.protegida };
    const dec = decidir({ bloqueado: false, modo: this.modo(ws, userId), naoPerguntar: this.naoPerguntar(ws, userId), liberarTudo: this.d.liberarTudo(ws, userId), leitura: c.leitura, protegida: !!c.protegida, umaVez: this.umaVez.has(run.id) });
    if (dec === 'recusar') return recusa('desligado', MSG.desligado);
    if (dec === 'ativar') {
      const e = await this.perguntar({ ...base, tipo: 'ativar', resumo: 'usar este computador', protegida: null });
      if (e === null) return recusa('sem_resposta', MSG.semResposta);
      if (e === 'agora_nao' || e === 'recusar') return recusa('recusou', MSG.recusou);
      // acabou de ativar: a protegida ainda pergunta
      if (c.protegida) return this.doMotor(run, ped.acao, ped.args);
    } else if (dec === 'confirmar') {
      const e = await this.perguntar({ ...base, tipo: 'confirmar', resumo: resumoParaCartao(ped.acao, ped.args, c.protegida) });
      if (e === null) return recusa('sem_resposta', MSG.semResposta);
      if (e !== 'permitir') return recusa('recusou_acao', MSG.recusouAcao);
    }
    // a espera pode ter levado minutos: confere de novo
    const agora = this.aparelhos.get(userId);
    if (!agora) return recusa('sem_aparelho', MSG.semAparelho);
    if (this.bloqueado(ws)) return recusa('bloqueado', MSG.bloqueado);
    if (this.controles.get(userId)?.quem === 'pessoa') return recusa('human_has_control', MSG.pessoa);
    this.marcarUso(userId, run, agente, c.leitura ? null : resumoParaRegistro(ped.acao, ped.args));
    const r = await this.pedirAoAparelho(agora, ped.acao, ped.args);
    // a pessoa assumiu enquanto a ação rodava: o resultado é descartado (pode mostrar o que ela fazia)
    if (this.controles.get(userId)?.quem === 'pessoa') return recusa('human_has_control', MSG.pessoa);
    if (!c.leitura) {
      audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'agent', actorId: run.agent_id, action: `computador.${ped.acao}`, targetType: 'run', targetId: run.id,
        evidence: { acao: resumoParaRegistro(ped.acao, ped.args), ok: r.ok === true, ...(c.protegida ? { protegida: c.protegida } : {}) }, result: `${agente} ${resumoParaRegistro(ped.acao, ped.args)}` });
    }
    return r;
  }

  private pedirAoAparelho(ap: Aparelho, acao: Acao, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = crypto.randomBytes(12).toString('base64url');
    return new Promise((ok) => {
      const t = setTimeout(() => { ap.esperando.delete(id); ok({ ok: false, code: 'timeout', error: MSG.caiu }); }, acaoMs());
      ap.esperando.set(id, (r) => { clearTimeout(t); ok(respostaDoAparelho(r)); });
      if (!this.mandar(ap, { t: 'acao', id, acao, args })) { clearTimeout(t); ap.esperando.delete(id); ok({ ok: false, code: 'sem_aparelho', error: MSG.semAparelho }); }
    });
  }

  private marcarUso(userId: string, run: ExecucaoPC, agente: string, resumo: string | null): void {
    const u = this.usos.get(userId);
    const agora = Date.now();
    const novo = !u || u.runId !== run.id || agora - u.ultima > EM_USO_MS;
    this.usos.set(userId, { runId: run.id, workspaceId: run.workspace_id, agente, desde: novo ? agora : u!.desde, ultima: agora, resumo: resumo ?? u?.resumo ?? '' });
    if (novo) { this.atualizarAparelho(userId); this.avisarPessoa(userId); }
    else if (resumo) this.avisarPessoa(userId);
    this.ligarRelogio();
  }

  private usoVivo(userId: string): Uso | null {
    const u = this.usos.get(userId);
    return u && Date.now() - u.ultima <= EM_USO_MS ? u : null;
  }

  private ligarRelogio(): void {
    if (this.relogio) return;
    this.relogio = setInterval(() => this.passo(), 2000);
    this.relogio.unref();
  }

  /** O que vence sozinho: o "em uso" parado, os pedidos esquecidos, as sessões dos aparelhos. */
  passo(): void {
    const agora = Date.now();
    for (const [userId, u] of this.usos) if (agora - u.ultima > EM_USO_MS) { this.usos.delete(userId); this.atualizarAparelho(userId); this.avisarPessoa(userId); }
    for (const p of [...this.pedidos.values()]) if (agora - p.criado > PEDIDO_VALE_MS) this.responderPedido(p, p.tipo === 'ativar' ? 'agora_nao' : 'recusar');
    if (!this.usos.size && !this.pedidos.size && !this.aparelhos.size && this.relogio) { clearInterval(this.relogio); this.relogio = null; }
  }

  execucaoTerminou(runId: string): void {
    this.umaVez.delete(runId);
    for (const p of [...this.pedidos.values()]) if (p.runId === runId) this.responderPedido(p, p.tipo === 'ativar' ? 'agora_nao' : 'recusar');
    for (const [userId, u] of this.usos) if (u.runId === runId) { this.usos.delete(userId); this.atualizarAparelho(userId); this.avisarPessoa(userId); }
  }

  // ---------- o aparelho (Ergon Desktop)
  static caminho(url: string | undefined): boolean { return /^\/api\/computador\/aparelho(?:\?|$)/.test(url ?? ''); }

  /**
   * O Ergon Desktop abre a ligação. Confere: a origem (tem de ser a do Ergon: impede outra página de abrir com o cookie da
   * pessoa), que não veio de outro site, a sessão do cookie (viva, destrancada). Uma ligação por pessoa: a nova fecha a velha.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const recusar = (status: number, motivo: string) => {
      try { socket.write(`HTTP/1.1 ${status} ${motivo}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* fechado */ }
      socket.destroy();
    };
    if (this.d.nuvem) return recusar(404, 'Not Found');
    const origem = req.headers.origin;
    if (typeof origem !== 'string' || !this.d.origens.includes(origem)) return recusar(403, 'Forbidden');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return recusar(403, 'Forbidden');
    const a = this.d.sessao(req.headers.cookie);
    if (!a) return recusar(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.chegou(ws, a, req.headers.cookie ?? ''));
  }

  private chegou(ws: WebSocket, a: AuthContext, cookie: string): void {
    const velho = this.aparelhos.get(a.userId);
    if (velho) { try { velho.ws.close(4000, 'outra ligação'); } catch { /* já fechado */ } }
    const ap: Aparelho = { id: crypto.randomBytes(9).toString('base64url'), ws, userId: a.userId, workspaceId: a.workspaceId, tokenHash: a.tokenHash, cookie, nome: a.displayName,
      so: '', versao: '', permissoes: { entrada: true, tela: true, passo: null }, tela: null, esperando: new Map() };
    this.aparelhos.set(a.userId, ap);
    const confere = setInterval(() => { const s = this.d.sessao(ap.cookie); if (!s || s.tokenHash !== ap.tokenHash) ws.close(4001, 'sessão'); }, SESSAO_CONFERE_MS);
    confere.unref();
    ws.on('message', (dados, binario) => { if (!binario) this.doAparelho(ap, dados.toString()); });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      clearInterval(confere);
      for (const f of ap.esperando.values()) f({ ok: false, code: 'sem_aparelho', error: MSG.semAparelho });
      ap.esperando.clear();
      if (this.aparelhos.get(a.userId) === ap) { this.aparelhos.delete(a.userId); this.avisarPessoa(a.userId); }
    });
    this.mandar(ap, { t: 'ola', ...this.estadoDoAparelho(a.userId) });
    this.ligarRelogio();
    this.avisarPessoa(a.userId);
  }

  private doAparelho(ap: Aparelho, texto: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(texto); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ola': case 'permissoes':
        ap.so = typeof m.so === 'string' && /^(linux|macos|windows)$/.test(m.so) ? m.so : ap.so;
        ap.versao = typeof m.versao === 'string' ? clip(m.versao, 40) : ap.versao;
        ap.permissoes = permissoesDe(m.permissoes);
        if (m.tela && typeof m.tela === 'object') { const t = m.tela as Record<string, unknown>; if (inteiro(t.largura, 20000) && inteiro(t.altura, 20000)) ap.tela = { largura: Number(t.largura), altura: Number(t.altura) }; }
        this.avisarPessoa(ap.userId);
        break;
      case 'resposta': {
        const id = typeof m.id === 'string' ? m.id : '';
        const f = ap.esperando.get(id);
        if (f) { ap.esperando.delete(id); f((m.r ?? {}) as Record<string, unknown>); }
        break;
      }
      case 'assumir':
        this.assumir(ap.userId, typeof m.motivo === 'string' && /^(mouse|teclado|panico|botao)$/.test(m.motivo) ? m.motivo : 'botao');
        break;
      case 'conceder':
        this.conceder(ap.userId);
        break;
      default:
    }
  }

  private estadoDoAparelho(userId: string): Record<string, unknown> {
    const u = this.usoVivo(userId);
    return { emUso: !!u, agente: u?.agente ?? null, controle: this.controles.get(userId)?.quem ?? 'agente' };
  }
  private atualizarAparelho(userId: string): void { const ap = this.aparelhos.get(userId); if (ap) this.mandar(ap, { t: 'estado', ...this.estadoDoAparelho(userId) }); }
  private mandar(ap: Aparelho, obj: unknown): boolean {
    if (ap.ws.readyState !== WebSocket.OPEN) return false;
    try { ap.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // ---------- avisos à tela (SSE do workspace)
  private avisar(ws: string): void { this.d.bus.publish(ws, 'computador.changed', {}); }
  private avisarPessoa(userId: string): void {
    const wss = new Set<string>();
    const ap = this.aparelhos.get(userId); if (ap) wss.add(ap.workspaceId);
    const u = this.usos.get(userId); if (u) wss.add(u.workspaceId);
    for (const p of this.pedidos.values()) if (p.userId === userId) wss.add(p.workspaceId);
    for (const ws of wss) this.avisar(ws);
  }

  fechar(): void {
    if (this.relogio) { clearInterval(this.relogio); this.relogio = null; }
    for (const ap of this.aparelhos.values()) { try { ap.ws.terminate(); } catch { /* já fechado */ } }
    this.aparelhos.clear();
    for (const p of [...this.pedidos.values()]) this.responderPedido(p, 'recusar');
    this.wss.close();
    log.info({ servico: 'computador' }, 'controle do computador encerrado');
  }
}
