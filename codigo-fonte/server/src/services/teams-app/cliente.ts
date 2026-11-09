/**
 * Cliente WebSocket do serviço do Teams (relé): conexão de SAÍDA iniciada pelo Ergon (nada de porta aberta no
 * computador da pessoa), autenticada a cada conexão pela assinatura Ed25519 da instalação sobre o desafio do relé.
 * Reconecta com backoff (1 s, 2 s, 4 s … 60 s, ±20%), responde ao ping e reconecta se o ping some por 60 s, e reenvia
 * com o mesmo id o que ficou sem confirmação em 30 s (contrato, 2.2 a 2.5).
 */
import { MAX_QUADRO, SUBPROTOCOLO, esperaDaTentativa, mensagemAuth, reacaoAoFechar, PROTOCOLO } from './protocolo.ts';

export type EstadoConexao = 'offline' | 'connecting' | 'connected';
export type Quadro = Record<string, unknown> & { type: string };
export interface Ack { type: 'ack'; id: string; ok: boolean; error?: { code: string; message?: string }; [k: string]: unknown }

export class ErroDoRele extends Error {
  readonly code: string; readonly detalhe: Record<string, unknown>;
  constructor(code: string, detalhe: Record<string, unknown> = {}) { super(code); this.code = code; this.detalhe = detalhe; }
}

export interface OpcoesCliente {
  url: string;
  installationId: () => string;
  assinar: (mensagem: string) => string;
  pessoas: () => Array<{ personRef: string; open: boolean }>;
  /** quadros do relé (entregas, controle); os acks dos pedidos daqui e o ping ficam com o cliente */
  aoQuadro: (f: Quadro) => void;
  aoPronto: (ready: Quadro) => void;
  /** a conexão fechou com um código que não é só reconectar (assinatura, revogada, desconhecida, versão, substituída) */
  aoParar: (code: number) => void;
  aoEstado?: (e: EstadoConexao) => void;
  /** testes: backoff e prazos menores */
  ajustes?: { baseMs?: number; tetoMs?: number; reenvioMs?: number; semPingMs?: number; zerarAposMs?: number };
  /** o relógio deste computador (testes: adiantado ou atrasado) */
  agora?: () => number;
}

interface Pendente { quadro: Quadro; resolve: (a: Ack) => void; reject: (e: Error) => void; reenvio: NodeJS.Timeout | null; prazo: NodeJS.Timeout | null }

export class ClienteRele {
  estado: EstadoConexao = 'offline';
  private readonly o: OpcoesCliente;
  private ws: WebSocket | null = null;
  private tentativa = 0;
  private timer: NodeJS.Timeout | null = null;
  private vigia: NodeJS.Timeout | null = null;
  private conectadoEm = 0;
  private ligado = false;
  private pendentes = new Map<string, Pendente>();
  constructor(o: OpcoesCliente) { this.o = o; }

  private aj(k: 'baseMs' | 'tetoMs' | 'reenvioMs' | 'semPingMs' | 'zerarAposMs', padrao: number) { return this.o.ajustes?.[k] ?? padrao; }
  private mudar(e: EstadoConexao) { if (this.estado !== e) { this.estado = e; this.o.aoEstado?.(e); } }

  /** Começa (ou volta) a manter a conexão. */
  ligar(): void {
    this.ligado = true;
    if (this.ws || this.timer) return;
    this.abrir();
  }
  /** Para de vez nesta sessão (sem reconectar), até ligar de novo. */
  desligar(): void {
    this.ligado = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.fechar(1000);
    this.rejeitarPendentes();
    this.mudar('offline');
  }
  /** Reconecta depois de `ms` (ex.: 4401 tenta de novo só depois de 10 min). */
  agendar(ms: number): void {
    this.ligado = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (this.ligado && !this.ws) this.abrir(); }, ms);
    this.timer.unref?.();
  }

  private abrir(): void {
    this.mudar('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.o.url, SUBPROTOCOLO); } catch { this.depoisDeFechar(1006); return; }
    this.ws = ws;
    let autenticado = false;
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let f: Quadro;
      try { f = JSON.parse(ev.data) as Quadro; } catch { return; }
      if (!f || typeof f.type !== 'string') return;
      if (f.type === 'hello') {
        // a hora do próprio relé (contrato 12.8): o relógio deste computador fora da hora não derruba a conexão; o nonce
        // de 32 bytes já faz cada autenticação ser nova
        const st = typeof f.serverTime === 'string' && Number.isFinite(Date.parse(f.serverTime)) ? f.serverTime : null;
        const ts = st ?? new Date((this.o.agora ?? Date.now)()).toISOString(); const id = this.o.installationId();
        this.cru({ type: 'auth', v: PROTOCOLO, installationId: id, ts, sig: this.o.assinar(mensagemAuth(id, String(f.nonce ?? ''), ts)), persons: this.o.pessoas() });
        this.rearmarVigia();
        return;
      }
      if (f.type === 'ready') {
        autenticado = true; this.conectadoEm = Date.now(); this.mudar('connected');
        this.rearmarVigia();
        // o que ficou sem confirmação na conexão anterior vai de novo, com o mesmo id, ANTES de reconciliar: um
        // link.confirm cujo ack se perdeu na queda se resolve, em vez de o vínculo novo parecer desconhecido (contrato 12.10)
        for (const p of this.pendentes.values()) if (this.cru(p.quadro)) this.armarReenvio(p);
        try { this.o.aoPronto(f); } catch { /* o dono trata */ }
        return;
      }
      if (f.type === 'ping') { this.cru({ type: 'pong', t: f.t }); this.rearmarVigia(); return; }
      if (f.type === 'ack' && typeof f.id === 'string' && this.pendentes.has(f.id)) {
        const p = this.pendentes.get(f.id)!; this.pendentes.delete(f.id); this.limpar(p);
        p.resolve(f as unknown as Ack);
        return;
      }
      if (!autenticado) return;
      try { this.o.aoQuadro(f); } catch { /* o dono trata */ }
    };
    ws.onclose = (ev) => { if (this.ws === ws) { this.ws = null; this.depoisDeFechar(ev.code); } };
    ws.onerror = () => { /* o onclose vem em seguida */ };
  }

  private depoisDeFechar(code: number): void {
    if (this.vigia) { clearTimeout(this.vigia); this.vigia = null; }
    // ficou de pé por um bom tempo: a próxima tentativa começa do início
    if (this.conectadoEm && Date.now() - this.conectadoEm >= this.aj('zerarAposMs', 60_000)) this.tentativa = 0;
    this.conectadoEm = 0;
    this.mudar('offline');
    for (const p of this.pendentes.values()) if (p.reenvio) { clearTimeout(p.reenvio); p.reenvio = null; }
    if (!this.ligado) return;
    const r = reacaoAoFechar(code);
    // parou de vez (revogada, versão, substituída, assinatura): quem esperava resposta não fica esperando para sempre
    if (r.acao !== 'reconectar') { this.ligado = false; this.rejeitarPendentes(); this.o.aoParar(code); return; }
    this.agendar(r.esperaMs ?? esperaDaTentativa(this.tentativa++, this.aj('baseMs', 1000), this.aj('tetoMs', 60_000)));
  }

  private rearmarVigia(): void {
    if (this.vigia) clearTimeout(this.vigia);
    this.vigia = setTimeout(() => { this.vigia = null; this.fechar(4000); }, this.aj('semPingMs', 60_000));
    this.vigia.unref?.();
  }

  private fechar(code: number): void {
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(code); } catch { /* já fechando */ }
    if (code === 1000) { this.ws = null; if (this.vigia) { clearTimeout(this.vigia); this.vigia = null; } for (const p of this.pendentes.values()) this.limpar(p); }
  }

  private cru(f: Quadro): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const s = JSON.stringify(f);
    if (Buffer.byteLength(s) > MAX_QUADRO) throw new ErroDoRele('too_large');
    ws.send(s);
    return true;
  }

  /** Quadro sem confirmação (typing, person.state). false = sem conexão agora. */
  enviar(f: Quadro): boolean { return this.estado === 'connected' && this.cru(f); }

  /**
   * Quadro com id: espera o ack. Sem ack em 30 s, reenvia o mesmo quadro (mesmo id) enquanto a conexão durar; na
   * reconexão vai de novo. `prazoMs`: desiste (para pedidos da tela, que não podem esperar para sempre).
   */
  pedir(f: Quadro & { id: string }, prazoMs?: number): Promise<Ack> {
    if (this.estado !== 'connected') return Promise.reject(new ErroDoRele('offline'));
    const velho = this.pendentes.get(f.id);
    if (velho) return new Promise((resolve, reject) => { const r0 = velho.resolve; const j0 = velho.reject; velho.resolve = (a) => { r0(a); resolve(a); }; velho.reject = (e) => { j0(e); reject(e); }; });
    return new Promise<Ack>((resolve, reject) => {
      const p: Pendente = { quadro: f, resolve, reject, reenvio: null, prazo: null };
      if (prazoMs) { p.prazo = setTimeout(() => { this.pendentes.delete(f.id); this.limpar(p); reject(new ErroDoRele('timeout')); }, prazoMs); p.prazo.unref?.(); }
      this.pendentes.set(f.id, p);
      if (!this.cru(f)) { this.pendentes.delete(f.id); this.limpar(p); reject(new ErroDoRele('offline')); return; }
      this.armarReenvio(p);
    });
  }

  private armarReenvio(p: Pendente): void {
    if (p.reenvio) clearTimeout(p.reenvio);
    p.reenvio = setTimeout(() => { p.reenvio = null; if (this.pendentes.has(String(p.quadro.id)) && this.cru(p.quadro)) this.armarReenvio(p); }, this.aj('reenvioMs', 30_000));
    p.reenvio.unref?.();
  }

  /** Quantos pedidos esperam ack (a saída não manda o mesmo id duas vezes). */
  emVoo(id: string): boolean { return this.pendentes.has(id); }

  private limpar(p: Pendente): void { if (p.reenvio) clearTimeout(p.reenvio); if (p.prazo) clearTimeout(p.prazo); p.reenvio = null; p.prazo = null; }

  private rejeitarPendentes(): void {
    const todos = [...this.pendentes.values()];
    this.pendentes.clear();
    for (const p of todos) { this.limpar(p); p.reject(new ErroDoRele('offline')); }
  }

  /** Desliga e rejeita o que esperava (servidor desligando). */
  encerrar(): void { this.desligar(); }
}
