/**
 * Navegador ao vivo com "Assumir o controle" (rc.41).
 *
 * Enquanto um agente usa o navegador, a pessoa vê a tela dele dentro do Ergon e pode assumir o mouse e o teclado naquela
 * mesma sessão (login, captcha, segundo fator, confirmar algo sensível), e depois devolver ao agente.
 *
 * Caminho: tela da pessoa ⇄ (WebSocket, sessão dela) ⇄ este serviço ⇄ (WebSocket, token da ponte) ⇄ ponte de controle do
 * motor ⇄ (túnel, 127.0.0.1 do contêiner) ⇄ transmissão do agent-browser (hermes/plugins/ergon_bridge/navegador.py).
 * O endereço e o token do motor nunca saem daqui: a tela só conhece /api/runs/<id>/navegador/….
 *
 * O que este serviço garante:
 * - quem vê: numa conversa, só a pessoa dona dela; num card, quem é do workspace. Com alguém no controle, SÓ essa pessoa
 *   recebe os quadros (ela pode estar digitando um código de verificação à vista): os outros veem que ela está no controle;
 * - quem mexe: só quem assumiu, e só pela ligação que assumiu. Ninguém manda entrada com o agente no controle;
 * - do motor para a tela passa só o que é da tela (quadro JPEG, tamanho do viewport, endereço e título). A transmissão do
 *   agent-browser também traz os comandos do agente e os resultados deles (o que ele leu da página): isso NUNCA é repassado;
 * - da tela para o motor passa só mouse, teclado e toque, conferidos campo a campo e com as coordenadas dentro do viewport;
 * - limites: quadros por segundo, banda por espectador, eventos de entrada por segundo, espectadores por execução;
 * - nada do que a pessoa digita é guardado: nem em registro, nem na auditoria (que só diz "assumiu" e "devolveu");
 * - a tomada de controle acaba sozinha: 10 min sem a pessoa mexer, 30 min no total, a ligação dela caiu, a sessão dela
 *   trancou ou acabou, ou a execução terminou. O motor tem o próprio prazo, para o caso de este servidor parar.
 */
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { Db } from '../db/db.ts';
import { log, scrub } from '../lib/log.ts';
import { HttpError, clip } from '../lib/util.ts';
import type { AuthContext } from './auth.ts';
import { audit, type Bus } from './bus.ts';
import type { HermesControlClient } from './hermes.ts';

// ---------------------------------------------------------------------------------------------- protocolo (puro)

export interface Tela { largura: number; altura: number }
/** O que a transmissão do motor manda e a tela pode receber. Todo o resto (comandos e resultados do agente) é descartado. */
export type DoMotor =
  | { tipo: 'quadro'; jpeg: Buffer; tela: Tela }
  | { tipo: 'pagina'; url: string; titulo: string };

/** Um quadro maior que isto não é um viewport de navegador (1280×720 em JPEG fica em dezenas de KB): descartado. */
export const QUADRO_MAX_BYTES = 3 * 1024 * 1024;
const dimensao = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 16 && v <= 8192 ? Math.round(v) : null);
const telaDe = (l: unknown, a: unknown): Tela | null => { const largura = dimensao(l), altura = dimensao(a); return largura && altura ? { largura, altura } : null; };

/**
 * O tamanho de um JPEG, lido do cabeçalho dele (o marcador SOF). É o tamanho de verdade do viewport, em pixels da página:
 * a transmissão diz "1280×720" (o tamanho da janela), mas a área da página é menor (1280×577, medido: a janela do
 * Chromium conta a moldura), e é nela que os cliques valem. A escala da tela da pessoa sai daqui.
 */
export function tamanhoDoJpeg(b: Buffer): Tela | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const n = b.readUInt16BE(i + 2);
    if (n < 2) return null;
    // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return telaDe(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    i += 2 + n;
  }
  return null;
}

/**
 * O endereço que a barra mostra (só leitura): só a origem e o caminho — sem usuário e senha embutidos, sem a consulta
 * ("?…": pode levar o código ou o token de um login OAuth, e quem assiste não precisa ver) e sem o trecho depois de "#".
 */
export function enderecoParaTela(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol === 'about:' ? clip(raw, 60) : u.protocol;
    return clip(`${u.protocol}//${u.host}${u.pathname}`, 300);
  } catch { return ''; }
}

export function lerDoMotor(texto: string): DoMotor | null {
  let m: any;
  try { m = JSON.parse(texto); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'frame' && typeof m.data === 'string' && m.data.length > 0 && m.data.length <= QUADRO_MAX_BYTES * 1.4) {
    const jpeg = Buffer.from(m.data, 'base64');
    // só JPEG de verdade segue para a tela (ela desenha como imagem; nada do motor vira HTML)
    if (jpeg.length > QUADRO_MAX_BYTES) return null;
    const tela = tamanhoDoJpeg(jpeg);
    return tela ? { tipo: 'quadro', jpeg, tela } : null;
  }
  if (m.type === 'tabs' && Array.isArray(m.tabs)) {
    const ativa = m.tabs.find((t: any) => t && t.active === true) ?? m.tabs[0];
    if (!ativa || typeof ativa !== 'object') return null;
    return { tipo: 'pagina', url: enderecoParaTela(ativa.url), titulo: typeof ativa.title === 'string' ? clip(ativa.title.replace(/[\u0000-\u001f\u007f]/g, ' '), 200) : '' };
  }
  return null;
}

/** Um evento para a transmissão do agent-browser (Input.dispatchMouseEvent / KeyEvent / TouchEvent). */
export type ParaMotor = Record<string, string | number | Array<{ x: number; y: number; id: number }>>;
const BOTOES = ['left', 'middle', 'right'] as const;
const MOUSE = { mv: 'mouseMoved', dn: 'mousePressed', up: 'mouseReleased', wh: 'mouseWheel' } as const;
const TOQUE = { s: 'touchStart', m: 'touchMove', e: 'touchEnd', c: 'touchCancel' } as const;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const entre = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const inteiro = (v: unknown, min: number, max: number, padrao = 0): number => { const n = num(v); return n === null ? padrao : entre(Math.round(n), min, max); };
/** Alt=1, Ctrl=2, Meta=4, Shift=8 (os do protocolo do Chromium) */
const modificadores = (v: unknown) => inteiro(v, 0, 15);
/** nomes de tecla (KeyboardEvent.key/code): letras, dígitos e pouco mais; nada de controle */
const NOME_DE_TECLA = /^[A-Za-z0-9]{1,24}$/;
/** texto digitado de uma vez (colar, teclado do celular, acento composto): até aqui por mensagem */
export const TEXTO_MAX = 2000;
const semControle = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

const tecla = (eventType: string, key: string, code: string, text: string, vk: number, mods: number): ParaMotor =>
  // todos os campos sempre presentes: a transmissão repassa "ausente" como null e o Chromium recusa o evento (medido)
  ({ type: 'input_keyboard', eventType, key, code, text, windowsVirtualKeyCode: vk, modifiers: mods });

/**
 * Confere e traduz o que veio da tela da pessoa. Devolve os eventos para o motor, ou null se a mensagem não é entrada
 * válida (descartada, sem erro para quem mandou). As coordenadas chegam em pixels do viewport e são presas dentro dele.
 */
export function entradaDaPessoa(m: unknown, tela: Tela | null): ParaMotor[] | null {
  if (!m || typeof m !== 'object' || !tela) return null;
  const e = m as Record<string, unknown>;
  const ponto = (o: Record<string, unknown>): { x: number; y: number } | null => {
    const x = num(o.x), y = num(o.y);
    return x === null || y === null ? null : { x: entre(Math.round(x), 0, tela.largura - 1), y: entre(Math.round(y), 0, tela.altura - 1) };
  };
  if (e.t === 'm') {
    const tipo = MOUSE[e.e as keyof typeof MOUSE];
    const p = ponto(e);
    if (!tipo || !p) return null;
    const botao = tipo === 'mousePressed' || tipo === 'mouseReleased' ? BOTOES[inteiro(e.b, 0, 2)] : 'none';
    return [{ type: 'input_mouse', eventType: tipo, x: p.x, y: p.y, button: botao, clickCount: botao === 'none' ? 0 : inteiro(e.c, 1, 3, 1),
      deltaX: tipo === 'mouseWheel' ? inteiro(e.dx, -2000, 2000) : 0, deltaY: tipo === 'mouseWheel' ? inteiro(e.dy, -2000, 2000) : 0, modifiers: modificadores(e.k) }];
  }
  if (e.t === 'k') {
    if (e.e !== 'dn' && e.e !== 'up') return null;
    const key = typeof e.key === 'string' ? e.key : '', code = typeof e.code === 'string' ? e.code : '';
    // tecla de um caractere só (com Ctrl ou ⌘: um atalho, como Ctrl+A) ou tecla com nome (Enter, Backspace, ArrowLeft…)
    const umCaractere = [...key].length === 1 && semControle(key);
    if (!(umCaractere || NOME_DE_TECLA.test(key)) || (code !== '' && !NOME_DE_TECLA.test(code))) return null;
    const mods = modificadores(e.k), vk = inteiro(e.vk, 0, 255);
    const atalho = (mods & 6) !== 0;
    const texto = e.e === 'dn' ? (key === 'Enter' ? '\r' : umCaractere && !atalho ? key : '') : '';
    return [tecla(e.e === 'up' ? 'keyUp' : texto ? 'keyDown' : 'rawKeyDown', key, code, texto, vk, mods)];
  }
  if (e.t === 'txt') {
    // texto pronto (digitado, colado, composto): uma tecla por caractere, sem código (vale para qualquer teclado)
    if (typeof e.s !== 'string' || !e.s || e.s.length > TEXTO_MAX) return null;
    const out: ParaMotor[] = [];
    for (const c of e.s.replace(/\r\n?/g, '\n')) {
      if (c === '\n') { out.push(tecla('keyDown', 'Enter', 'Enter', '\r', 13, 0), tecla('keyUp', 'Enter', 'Enter', '', 13, 0)); continue; }
      if (c === '\t') { out.push(tecla('rawKeyDown', 'Tab', 'Tab', '', 9, 0), tecla('keyUp', 'Tab', 'Tab', '', 9, 0)); continue; }
      if (!semControle(c)) continue;
      out.push(tecla('keyDown', c, '', c, 0, 0), tecla('keyUp', c, '', '', 0, 0));
    }
    return out.length ? out : null;
  }
  if (e.t === 'q') {
    const tipo = TOQUE[e.e as keyof typeof TOQUE];
    if (!tipo || !Array.isArray(e.p) || e.p.length > 5) return null;
    const pontos: Array<{ x: number; y: number; id: number }> = [];
    for (const raw of e.p) {
      const p = raw && typeof raw === 'object' ? ponto(raw as Record<string, unknown>) : null;
      if (!p) return null;
      pontos.push({ ...p, id: inteiro((raw as Record<string, unknown>).id, 0, 20) });
    }
    return [{ type: 'input_touch', eventType: tipo, touchPoints: pontos, modifiers: modificadores(e.k) }];
  }
  return null;
}

/** Balde de fichas: `porSegundo` de vazão, `rajada` de folga. */
export class Balde {
  private fichas: number;
  private visto: number;
  private readonly porSegundo: number;
  private readonly rajada: number;
  constructor(porSegundo: number, rajada: number, agora = Date.now()) { this.porSegundo = porSegundo; this.rajada = rajada; this.fichas = rajada; this.visto = agora; }
  gastar(n = 1, agora = Date.now()): boolean {
    this.fichas = Math.min(this.rajada, this.fichas + ((agora - this.visto) / 1000) * this.porSegundo);
    this.visto = agora;
    if (this.fichas < n) return false;
    this.fichas -= n;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------- quem está no controle

export type Motivo = 'pessoa' | 'ocioso' | 'teto' | 'queda' | 'sessao' | 'fim' | 'prazo' | 'navegador';
export interface Controle { userId: string; nome: string; ligacao: string; desde: number; mexeu: number }
export const OCIOSO_MS = 10 * 60_000;
export const TETO_MS = 30 * 60_000;
/** a ligação de quem controla caiu (rede, recarregou a página): este tempo para voltar antes de o controle ir embora */
export const QUEDA_MS = 20_000;

/**
 * A máquina de estados de uma execução: com o agente (padrão) ou com UMA pessoa. Pura (o relógio vem de fora), para o
 * teste percorrer os prazos sem esperar.
 */
export class Posse {
  controle: Controle | null = null;
  /** quando a ligação de quem controla caiu (null = está ligada) */
  caiuEm: number | null = null;

  assumir(quem: { userId: string; nome: string; ligacao: string }, agora: number): 'ok' | 'ocupado' {
    if (this.controle && this.controle.userId !== quem.userId) return 'ocupado';
    // a mesma pessoa de novo (outra aba, ou voltou depois de cair): o controle passa para a ligação nova, sem zerar o teto
    this.controle = { ...quem, desde: this.controle?.desde ?? agora, mexeu: agora };
    this.caiuEm = null;
    return 'ok';
  }
  /** só quem assumiu, pela ligação que assumiu */
  podeMexer(userId: string, ligacao: string): boolean { return !!this.controle && this.controle.userId === userId && this.controle.ligacao === ligacao; }
  mexeu(agora: number): void { if (this.controle) this.controle.mexeu = agora; }
  ligacaoCaiu(ligacao: string, agora: number): void { if (this.controle?.ligacao === ligacao) this.caiuEm = agora; }
  devolver(): Controle | null { const c = this.controle; this.controle = null; this.caiuEm = null; return c; }
  /** por que o controle deve voltar ao agente agora, se deve */
  vencido(agora: number): Motivo | null {
    const c = this.controle;
    if (!c) return null;
    if (agora - c.desde >= TETO_MS) return 'teto';
    if (agora - c.mexeu >= OCIOSO_MS) return 'ocioso';
    if (this.caiuEm !== null && agora - this.caiuEm >= QUEDA_MS) return 'queda';
    return null;
  }
  /** até quando vale sem a pessoa mexer (para a tela mostrar) */
  ate(): number | null { const c = this.controle; return c ? Math.min(c.mexeu + OCIOSO_MS, c.desde + TETO_MS) : null; }
}

// ---------------------------------------------------------------------------------------------- o serviço

export const QUADROS_POR_SEGUNDO = 12;
/** banda por espectador (os quadros): sustentada e de rajada */
export const BANDA_BYTES_S = 1_500_000;
const BANDA_RAJADA = 3_000_000;
/** quanto pode ficar na fila de envio de um espectador lento antes de pular quadros */
const FILA_MAX_BYTES = 1_000_000;
const MOVIMENTOS_POR_SEGUNDO = 60;
const TECLAS_POR_SEGUNDO = 200;
export const ESPECTADORES_POR_EXECUCAO = 4;
const LIGACOES_POR_PESSOA = 3;
const BILHETE_MS = 30_000;
/** o prazo que o motor recebe a cada renovação (ele devolve sozinho se este servidor parar de renovar) */
const PRAZO_NO_MOTOR_S = 120;
const RENOVAR_MS = 45_000;
const RELOGIO_MS = 5_000;

/** O mínimo de uma execução que este serviço precisa (RunRow tem tudo isto). */
export interface ExecucaoNav {
  id: string; workspace_id: string; agent_id: string; conversation_id: string | null; task_id: string | null;
  status: string; hermes_session_id: string | null;
}
const EM_ANDAMENTO = new Set(['running', 'waiting_user']);

export interface EstadoNav {
  runId: string; ativo: boolean;
  /** 'agente', 'voce' (quem pergunta está no controle) ou 'outra' (outra pessoa do workspace está) */
  controle: 'agente' | 'voce' | 'outra';
  /** o nome de quem está no controle, quando é outra pessoa */
  quem: string | null;
  /** até quando o controle vale sem a pessoa mexer (ISO) */
  ate: string | null;
  /** por que o controle voltou ao agente da última vez (a tela avisa: prazo, queda…) */
  motivo: Motivo | null;
}

interface Espectador { id: string; ws: WebSocket; userId: string; nome: string; tokenHash: string; cookie: string; banda: Balde; movimentos: Balde; teclas: Balde; atrasado: boolean }
interface Sala {
  run: ExecucaoNav;
  ativo: boolean;
  posse: Posse;
  motivo: Motivo | null;
  espectadores: Map<string, Espectador>;
  acima: WebSocket | null;
  abrindo: boolean;
  tela: Tela | null;
  pagina: { url: string; titulo: string } | null;
  quadro: Buffer | null;
  enviadoEm: number;
  pendente: NodeJS.Timeout | null;
  renovadoEm: number;
}
interface Bilhete { runId: string; userId: string; tokenHash: string; vence: number }
/** bilhetes ainda não usados (cada um vale BILHETE_MS): por pessoa e no total */
export const BILHETES_POR_PESSOA = 30; export const BILHETES_MAX = 5000;

export interface DepsNavegador {
  db: Db;
  bus: Bus;
  /** as origens de onde a tela pode abrir a transmissão (cfg.allowedOrigins) */
  origens: readonly string[];
  /** a ponte de controle do motor do workspace */
  controle: (workspaceId: string) => HermesControlClient | null;
  /** a execução, pelo id (qualquer workspace: quem chama confere) */
  execucao: (runId: string) => ExecucaoNav | null;
  /** a sessão do cookie, se vale agora: existe, não venceu, não está trancada, a parte da pessoa está aberta */
  sessao: (cookieHeader: string | undefined) => AuthContext | null;
  /** quem pode ver esta execução (lança 404 se não) */
  podeVer: (a: AuthContext, run: ExecucaoNav) => void;
}

export class Navegador {
  private readonly salas = new Map<string, Sala>();
  private readonly bilhetes = new Map<string, Bilhete>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  private relogio: NodeJS.Timeout | null = null;
  private agora: () => number = Date.now;
  private readonly d: DepsNavegador;

  constructor(d: DepsNavegador) { this.d = d; }

  /** só para os testes: o relógio dos prazos */
  usarRelogio(fn: () => number): void { this.agora = fn; }

  private sala(run: ExecucaoNav): Sala {
    let s = this.salas.get(run.id);
    if (!s) {
      s = { run, ativo: false, posse: new Posse(), motivo: null, espectadores: new Map(), acima: null, abrindo: false, tela: null, pagina: null, quadro: null, enviadoEm: 0, pendente: null, renovadoEm: 0 };
      this.salas.set(run.id, s);
    }
    if (!this.relogio) { this.relogio = setInterval(() => this.volta(), RELOGIO_MS); this.relogio.unref?.(); }
    return s;
  }

  private publicar(s: Sala): void {
    this.d.bus.publish(s.run.workspace_id, 'runs.live', { id: s.run.id, conversationId: s.run.conversation_id, taskId: s.run.task_id, navegador: true });
    for (const e of s.espectadores.values()) this.mandar(e, { t: 'estado', ...this.estadoPara(s.run, e.userId) });
  }

  // ---------- o motor avisa (POST /internal/bridge/v1/navegador)
  aviso(run: ExecucaoNav, evento: 'ativo' | 'fim' | 'devolvido', motivo?: string): void {
    if (evento === 'ativo') {
      if (!EM_ANDAMENTO.has(run.status)) return;
      const s = this.sala(run);
      s.run = run;
      if (!s.ativo) { s.ativo = true; this.publicar(s); }
      return;
    }
    const s = this.salas.get(run.id);
    if (!s) return;
    if (evento === 'devolvido') { this.soltar(s, motivo === 'prazo' ? 'prazo' : 'navegador', false); return; }
    this.encerrar(s, 'navegador');
  }

  /** a execução terminou (RunExecutor.onFinish): fecha tudo */
  execucaoTerminou(runId: string): void {
    const s = this.salas.get(runId);
    if (s) this.encerrar(s, 'fim');
  }

  private encerrar(s: Sala, motivo: Motivo): void {
    this.soltar(s, motivo, motivo !== 'fim' && motivo !== 'navegador');
    s.ativo = false;
    for (const e of s.espectadores.values()) { this.mandar(e, { t: 'fim' }); try { e.ws.close(1000, 'fim'); } catch { /* já fechada */ } }
    s.espectadores.clear();
    this.fecharAcima(s);
    this.salas.delete(s.run.id);
    this.d.bus.publish(s.run.workspace_id, 'runs.live', { id: s.run.id, conversationId: s.run.conversation_id, taskId: s.run.task_id, navegador: true });
  }

  // ---------- estado para a tela
  estadoPara(run: ExecucaoNav, userId: string): EstadoNav {
    const s = this.salas.get(run.id);
    const c = s?.posse.controle ?? null;
    const ate = s?.posse.ate() ?? null;
    return {
      runId: run.id, ativo: !!s?.ativo && EM_ANDAMENTO.has(run.status),
      controle: !c ? 'agente' : c.userId === userId ? 'voce' : 'outra', quem: c && c.userId !== userId ? c.nome : null,
      ate: c && c.userId === userId && ate ? new Date(ate).toISOString() : null, motivo: c ? null : s?.motivo ?? null,
    };
  }

  /** As execuções com navegador aberto agora, das que a pessoa pode ver (a tela escolhe a da conversa ou do card). */
  ativas(workspaceId: string): ExecucaoNav[] {
    return [...this.salas.values()].filter((s) => s.ativo && s.run.workspace_id === workspaceId).map((s) => s.run);
  }

  // ---------- bilhete para abrir a transmissão (pedido por uma rota com sessão, origem e CSRF conferidos)
  bilhete(a: AuthContext, run: ExecucaoNav): string {
    const s = this.salas.get(run.id);
    if (!s?.ativo) throw new HttpError(409, 'navegador_fechado', 'O navegador deste trabalho não está aberto agora.');
    const agora = Date.now();
    for (const [k, b] of this.bilhetes) if (b.vence <= agora) this.bilhetes.delete(k);
    // por pessoa (uma pessoa enchendo não tira a vez das outras) e um teto geral bem maior
    let daPessoa = 0; for (const b of this.bilhetes.values()) if (b.userId === a.userId) daPessoa++;
    if (daPessoa >= BILHETES_POR_PESSOA || this.bilhetes.size >= BILHETES_MAX) throw new HttpError(429, 'muitos_pedidos', 'Muitos pedidos de uma vez. Tente de novo em instantes.');
    const valor = crypto.randomBytes(32).toString('base64url');
    this.bilhetes.set(valor, { runId: run.id, userId: a.userId, tokenHash: a.tokenHash, vence: agora + BILHETE_MS });
    return valor;
  }

  // ---------- assumir e devolver (rotas com sessão, origem e CSRF conferidos)
  async assumir(a: AuthContext, run: ExecucaoNav, ligacao: string): Promise<EstadoNav> {
    const s = this.salas.get(run.id);
    if (!s?.ativo || !EM_ANDAMENTO.has(run.status)) throw new HttpError(409, 'navegador_fechado', 'O navegador deste trabalho não está aberto agora.');
    const e = s.espectadores.get(ligacao);
    // só assume quem está vendo a tela, pela própria ligação
    if (!e || e.userId !== a.userId) throw new HttpError(409, 'navegador_sem_tela', 'Abra a tela do navegador para assumir o controle.');
    if (s.posse.controle && s.posse.controle.userId !== a.userId) throw new HttpError(409, 'navegador_ocupado', `${s.posse.controle.nome} está no controle do navegador agora.`);
    const ja = !!s.posse.controle;
    const ctl = this.d.controle(run.workspace_id);
    if (!ctl?.recursos || !run.hermes_session_id) throw new HttpError(503, 'navegador_motor', 'A equipe de IA não respondeu agora. Tente de novo.');
    // primeiro o motor (o agente para de mexer e de ler); só então a pessoa recebe o controle aqui
    const r = await ctl.recursos('PUT', 'navegador/controle', { sessao: run.hermes_session_id, pessoa: true, prazo_s: PRAZO_NO_MOTOR_S });
    if (r.status !== 200 || r.json?.controle !== 'pessoa') {
      if (r.status === 404) { this.encerrar(s, 'navegador'); throw new HttpError(409, 'navegador_fechado', 'O navegador deste trabalho não está aberto agora.'); }
      // o agente estava no meio de uma ação no navegador (que lê a página) e ela não terminou a tempo: o motor desfez a
      // tomada, para a pessoa não digitar com uma leitura em curso (navegador.py esperar_em_curso)
      if (r.status === 409) throw new HttpError(409, 'navegador_agente_agindo', 'O agente está terminando uma ação no navegador. Tente de novo em alguns segundos.');
      throw new HttpError(503, 'navegador_motor', 'A equipe de IA não respondeu agora. Tente de novo.');
    }
    if (s.posse.assumir({ userId: a.userId, nome: a.displayName, ligacao }, this.agora()) !== 'ok') {
      throw new HttpError(409, 'navegador_ocupado', 'Outra pessoa está no controle do navegador agora.');
    }
    s.motivo = null;
    s.renovadoEm = this.agora();
    if (!ja) {
      audit(this.d.db, this.d.bus, { workspaceId: run.workspace_id, actorType: 'user', actorId: a.userId, action: 'navegador.assumiu', targetType: 'run', targetId: run.id,
        evidence: { agentId: run.agent_id, taskId: run.task_id }, result: 'Você assumiu o controle do navegador do agente' });
      log.info({ runId: run.id, userId: a.userId }, 'navegador: a pessoa assumiu o controle');
    }
    this.publicar(s);
    return this.estadoPara(run, a.userId);
  }

  async devolver(a: AuthContext, run: ExecucaoNav): Promise<EstadoNav & { senhas: number }> {
    const s = this.salas.get(run.id);
    if (!s?.posse.controle) return { ...this.estadoPara(run, a.userId), senhas: 0 };
    if (s.posse.controle.userId !== a.userId) throw new HttpError(409, 'navegador_ocupado', `${s.posse.controle.nome} está no controle do navegador agora.`);
    const senhas = await this.soltar(s, 'pessoa', true);
    return { ...this.estadoPara(run, a.userId), senhas };
  }

  /** O controle volta ao agente: aqui (na hora) e no motor (se `noMotor`; quando foi o motor que avisou, não precisa). */
  private soltar(s: Sala, motivo: Motivo, noMotor: boolean): Promise<number> {
    const c = s.posse.devolver();
    if (!c) return Promise.resolve(0);
    s.motivo = motivo === 'pessoa' ? null : motivo;
    const texto: Record<Motivo, string> = {
      pessoa: 'Você concedeu o controle do navegador ao agente', ocioso: 'O navegador voltou ao agente: 10 minutos sem uso', teto: 'O navegador voltou ao agente: o tempo máximo acabou',
      queda: 'O navegador voltou ao agente: a tela foi fechada', sessao: 'O navegador voltou ao agente: a sessão foi trancada ou encerrada',
      fim: 'O navegador voltou ao agente: o trabalho terminou', prazo: 'O navegador voltou ao agente: o prazo acabou', navegador: 'O navegador voltou ao agente: ele foi fechado',
    };
    audit(this.d.db, this.d.bus, { workspaceId: s.run.workspace_id, actorType: motivo === 'pessoa' ? 'user' : 'system', actorId: c.userId, action: 'navegador.devolveu', targetType: 'run', targetId: s.run.id,
      evidence: { agentId: s.run.agent_id, taskId: s.run.task_id, motivo, segundos: Math.round((this.agora() - c.desde) / 1000) }, result: texto[motivo] });
    log.info({ runId: s.run.id, userId: c.userId, motivo }, 'navegador: o controle voltou ao agente');
    this.publicar(s);
    if (!noMotor) return Promise.resolve(0);
    const ctl = this.d.controle(s.run.workspace_id);
    if (!ctl?.recursos || !s.run.hermes_session_id) return Promise.resolve(0);
    // o motor apaga a senha que ficou digitada e não foi enviada, e libera as ferramentas do agente; se não responder,
    // o prazo dele mesmo devolve (o servidor já parou de renovar)
    return ctl.recursos('PUT', 'navegador/controle', { sessao: s.run.hermes_session_id, pessoa: false })
      .then((r) => (r.status === 200 && Number.isInteger(r.json?.senhas) ? Math.max(0, Number(r.json.senhas)) : 0))
      .catch((err) => { log.warn({ runId: s.run.id, erro: scrub(err instanceof Error ? err.message : String(err)) }, 'navegador: o motor não confirmou a devolução'); return 0; });
  }

  /** O relógio: prazos da tomada de controle, renovação no motor, sessão de cada espectador, quadro pendente dos lentos. */
  private volta(): void {
    const agora = this.agora();
    for (const s of [...this.salas.values()]) {
      for (const e of [...s.espectadores.values()]) {
        const a = this.d.sessao(e.cookie);
        if (!a || a.userId !== e.userId || a.tokenHash !== e.tokenHash || a.workspaceId !== s.run.workspace_id) {
          if (s.posse.controle?.ligacao === e.id) void this.soltar(s, 'sessao', true);
          try { e.ws.close(4401, 'sessao'); } catch { /* já fechada */ }
        }
      }
      const run = this.d.execucao(s.run.id);
      if (!run || !EM_ANDAMENTO.has(run.status)) { this.encerrar(s, 'fim'); continue; }
      s.run = run;
      const motivo = s.posse.vencido(agora);
      if (motivo) { void this.soltar(s, motivo, true); continue; }
      if (s.posse.controle && agora - s.renovadoEm >= RENOVAR_MS) {
        s.renovadoEm = agora;
        const ctl = this.d.controle(run.workspace_id);
        if (ctl?.recursos && run.hermes_session_id) {
          void ctl.recursos('PUT', 'navegador/controle', { sessao: run.hermes_session_id, pessoa: true, prazo_s: PRAZO_NO_MOTOR_S })
            .then((r) => { if (r.status === 404) this.encerrar(s, 'navegador'); }).catch(() => undefined);
        }
      }
      if (!s.espectadores.size && !s.posse.controle) this.fecharAcima(s);
    }
    if (!this.salas.size && this.relogio) { clearInterval(this.relogio); this.relogio = null; }
  }

  // ---------- a ligação com a tela da pessoa
  /** O pedido de upgrade é desta rota? (app.ts liga em server.on('upgrade')) */
  static caminho(url: string | undefined): string | null {
    const m = /^\/api\/runs\/(run_[0-9a-f]{32})\/navegador\/fluxo(?:\?|$)/.exec(url ?? '');
    return m ? m[1] : null;
  }

  /**
   * Abre a transmissão para a tela da pessoa. Confere, nesta ordem: a origem (tem de vir, e ser uma das do Ergon: é o que
   * impede outra página de abrir o WebSocket com o cookie da pessoa), a sessão do cookie, o bilhete (uso único, pedido
   * há pouco por uma rota com CSRF, da mesma sessão e desta execução), a execução (do workspace da sessão, à vista de
   * quem pede) e os limites.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const recusar = (status: number, motivo: string) => {
      try { socket.write(`HTTP/1.1 ${status} ${motivo}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* socket fechado */ }
      socket.destroy();
    };
    const runId = Navegador.caminho(req.url);
    if (!runId) return recusar(404, 'Not Found');
    const origem = req.headers.origin;
    if (typeof origem !== 'string' || !this.d.origens.includes(origem)) return recusar(403, 'Forbidden');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return recusar(403, 'Forbidden');
    const a = this.d.sessao(req.headers.cookie);
    if (!a) return recusar(401, 'Unauthorized');
    const valor = new URL(req.url ?? '', 'http://x').searchParams.get('bilhete') ?? '';
    const b = this.bilhetes.get(valor);
    this.bilhetes.delete(valor);
    if (!b || b.vence <= Date.now() || b.runId !== runId || b.userId !== a.userId || b.tokenHash !== a.tokenHash) return recusar(403, 'Forbidden');
    const run = this.d.execucao(runId);
    if (!run || run.workspace_id !== a.workspaceId) return recusar(404, 'Not Found');
    try { this.d.podeVer(a, run); } catch { return recusar(404, 'Not Found'); }
    const s = this.salas.get(runId);
    if (!s?.ativo || !EM_ANDAMENTO.has(run.status)) return recusar(409, 'Conflict');
    if (s.espectadores.size >= ESPECTADORES_POR_EXECUCAO) return recusar(429, 'Too Many Requests');
    let daPessoa = 0;
    for (const x of this.salas.values()) for (const e of x.espectadores.values()) if (e.userId === a.userId) daPessoa++;
    if (daPessoa >= LIGACOES_POR_PESSOA) return recusar(429, 'Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.entrou(s, ws, a, req.headers.cookie ?? ''));
  }

  private mandar(e: Espectador, obj: unknown): void {
    if (e.ws.readyState === WebSocket.OPEN) { try { e.ws.send(JSON.stringify(obj)); } catch { /* fechando */ } }
  }

  private entrou(s: Sala, ws: WebSocket, a: AuthContext, cookie: string): void {
    const agora = Date.now();
    const e: Espectador = { id: crypto.randomBytes(12).toString('base64url'), ws, userId: a.userId, nome: a.displayName, tokenHash: a.tokenHash, cookie,
      banda: new Balde(BANDA_BYTES_S, BANDA_RAJADA, agora), movimentos: new Balde(MOVIMENTOS_POR_SEGUNDO, MOVIMENTOS_POR_SEGUNDO, agora), teclas: new Balde(TECLAS_POR_SEGUNDO, TECLAS_POR_SEGUNDO * 2, agora), atrasado: false };
    s.espectadores.set(e.id, e);
    this.mandar(e, { t: 'ola', ligacao: e.id, ...this.estadoPara(s.run, e.userId) });
    if (s.tela) this.mandar(e, { t: 'tela', ...s.tela });
    if (s.pagina && this.podeReceberTela(s, e)) this.mandar(e, { t: 'pagina', ...s.pagina });
    if (s.quadro) this.quadroPara(s, e, s.quadro);
    ws.on('message', (dados, binario) => { if (!binario) this.daPessoa(s, e, dados.toString()); });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      s.espectadores.delete(e.id);
      s.posse.ligacaoCaiu(e.id, this.agora());
    });
    this.ligarAcima(s);
  }

  /** Com alguém no controle, só essa pessoa vê a tela (pode haver um código de verificação à vista). */
  private podeReceberTela(s: Sala, e: Espectador): boolean { const c = s.posse.controle; return !c || c.userId === e.userId; }

  private daPessoa(s: Sala, e: Espectador, texto: string): void {
    // o conteúdo NUNCA vai para registro (pode ser a senha da pessoa)
    if (!s.posse.podeMexer(e.userId, e.id) || !s.acima || s.acima.readyState !== WebSocket.OPEN) return;
    let m: unknown;
    try { m = JSON.parse(texto); } catch { return; }
    const eventos = entradaDaPessoa(m, s.tela);
    if (!eventos) return;
    const movimento = (m as { t?: string; e?: string }).t === 'm' && (m as { e?: string }).e === 'mv';
    if (!(movimento ? e.movimentos.gastar(1) : e.teclas.gastar(eventos.length))) return;
    s.posse.mexeu(this.agora());
    for (const ev of eventos) { try { s.acima.send(JSON.stringify(ev)); } catch { return; } }
  }

  // ---------- a ligação com o motor (uma por execução assistida)
  private ligarAcima(s: Sala): void {
    if (s.acima || s.abrindo) return;
    const ctl = this.d.controle(s.run.workspace_id);
    const alvo = s.run.hermes_session_id ? ctl?.fluxoNavegador?.(s.run.hermes_session_id) ?? null : null;
    if (!alvo) return;
    s.abrindo = true;
    const acima = new WebSocket(alvo.url, { headers: alvo.headers, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 8000 });
    acima.on('open', () => { s.abrindo = false; s.acima = acima; if (!s.espectadores.size && !s.posse.controle) this.fecharAcima(s); });
    acima.on('message', (dados, binario) => { if (!binario) this.doMotor(s, dados.toString()); });
    const caiu = () => {
      s.abrindo = false;
      if (s.acima === acima) s.acima = null;
      // o navegador fechou (ou o motor caiu): quem assiste tenta de novo dali a pouco, se ele ainda existir
      if (this.salas.get(s.run.id) === s && s.espectadores.size) { const t = setTimeout(() => { if (this.salas.get(s.run.id) === s && s.espectadores.size) this.ligarAcima(s); }, 2000); t.unref?.(); }
    };
    acima.on('close', caiu);
    acima.on('error', () => undefined);
    acima.on('unexpected-response', (_rq, res) => { res.resume(); if (res.statusCode === 404) this.encerrar(s, 'navegador'); else caiu(); });
  }

  private fecharAcima(s: Sala): void {
    if (s.pendente) { clearTimeout(s.pendente); s.pendente = null; }
    const a = s.acima;
    s.acima = null;
    if (a) { try { a.close(); } catch { /* já fechada */ } }
  }

  private doMotor(s: Sala, texto: string): void {
    const m = lerDoMotor(texto);
    if (!m) return;
    if (m.tipo === 'pagina') {
      if (s.pagina && s.pagina.url === m.url && s.pagina.titulo === m.titulo) return;
      s.pagina = { url: m.url, titulo: m.titulo };
      for (const e of s.espectadores.values()) if (this.podeReceberTela(s, e)) this.mandar(e, { t: 'pagina', ...s.pagina });
      return;
    }
    this.mudouTela(s, m.tela);
    s.quadro = m.jpeg;
    // no máximo QUADROS_POR_SEGUNDO: o quadro que chega cedo demais espera a vez (o último sempre sai, nunca o do meio)
    const espera = 1000 / QUADROS_POR_SEGUNDO - (Date.now() - s.enviadoEm);
    if (espera <= 0) this.distribuir(s);
    else if (!s.pendente) { s.pendente = setTimeout(() => { s.pendente = null; this.distribuir(s); }, espera); s.pendente.unref?.(); }
  }

  private mudouTela(s: Sala, tela: Tela): void {
    if (s.tela && s.tela.largura === tela.largura && s.tela.altura === tela.altura) return;
    s.tela = tela;
    for (const e of s.espectadores.values()) this.mandar(e, { t: 'tela', ...tela });
  }

  private distribuir(s: Sala): void {
    if (!s.quadro) return;
    s.enviadoEm = Date.now();
    let alguemAtrasado = false;
    for (const e of s.espectadores.values()) { this.quadroPara(s, e, s.quadro); alguemAtrasado ||= e.atrasado; }
    // quem ficou sem este quadro (lento ou acima da banda) recebe o mais recente quando puder, mesmo com a página parada
    if (alguemAtrasado && !s.pendente) { s.pendente = setTimeout(() => { s.pendente = null; this.distribuir(s); }, 300); s.pendente.unref?.(); }
  }

  private quadroPara(s: Sala, e: Espectador, jpeg: Buffer): void {
    if (e.ws.readyState !== WebSocket.OPEN || !this.podeReceberTela(s, e)) { e.atrasado = false; return; }
    if (e.ws.bufferedAmount > FILA_MAX_BYTES || !e.banda.gastar(jpeg.length)) { e.atrasado = true; return; }
    e.atrasado = false;
    try { e.ws.send(jpeg, { binary: true }); } catch { /* fechando */ }
  }

  /** Desliga tudo (o servidor está parando). */
  fechar(): void {
    if (this.relogio) { clearInterval(this.relogio); this.relogio = null; }
    for (const s of [...this.salas.values()]) this.encerrar(s, 'fim');
    this.wss.close();
  }
}
