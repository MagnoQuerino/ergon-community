/**
 * Se a sincronia com o Ergon World está mexendo em dados agora (enviando ou recebendo de verdade: a conferência de
 * cada minuto sem nada novo não conta) e a pausa pedida ao fechar o aplicativo.
 *
 * - A barra de cima mostra um sinal discreto enquanto há dados indo ou vindo (evento "sync.changed" no workspace).
 * - Fechar o aplicativo nesse meio: a página avisa; se a pessoa insistir, pede a pausa, que espera o passo atual
 *   terminar (cada mudança aplicada é um ponto seguro: sync-local.ts) e não deixa a sincronia automática começar outro.
 * - A pausa vale até a página abrir de novo (retomar), até o servidor reiniciar ou por 2 min, o que vier antes (fechar a
 *   janela não desliga o servidor: passado o fechamento, a sincronia segue normal; desligar o computador sai pelo
 *   encerramento do servidor, que espera o passo em andamento e envia o que faltou).
 */
import type { Bus } from '../services/bus.ts';

export type FaseSync = 'enviando' | 'recebendo';
export interface EstadoSync { ativo: boolean; fase: FaseSync | null; desde: string | null; pausada: boolean }

const PAUSA_MAX_MS = 30 * 60_000;
const PAUSA_PADRAO_MS = 2 * 60_000;

export class SyncAtividade {
  private ativos = new Map<string, Array<{ fase: FaseSync; desde: number }>>();
  private pausaAte = 0;
  private esperando = new Set<() => void>();
  private readonly bus: Bus | null; private readonly agora: () => number;
  constructor(bus: Bus | null, agora: () => number = Date.now) { this.bus = bus; this.agora = agora; }

  estado(ws: string): EstadoSync {
    const l = this.ativos.get(ws) ?? [];
    const p = l[l.length - 1];
    return { ativo: l.length > 0, fase: p?.fase ?? null, desde: l[0] ? new Date(l[0].desde).toISOString() : null, pausada: this.pausada() };
  }

  algumAtivo(): boolean { return [...this.ativos.values()].some((l) => l.length > 0); }
  pausada(): boolean { return this.agora() < this.pausaAte; }

  /** Marca o trecho em que dados vão ou vêm; termina (com erro ou não) e a marca sai. */
  async envolver<T>(ws: string, fase: FaseSync, fn: () => Promise<T>): Promise<T> {
    const item = { fase, desde: this.agora() };
    const l = this.ativos.get(ws) ?? []; l.push(item); this.ativos.set(ws, l);
    this.avisar(ws);
    try { return await fn(); }
    finally {
      const i = l.indexOf(item); if (i >= 0) l.splice(i, 1);
      if (!l.length) this.ativos.delete(ws);
      this.avisar(ws);
      if (!this.algumAtivo()) for (const f of [...this.esperando]) f();
    }
  }

  /**
   * Pausa: a sincronia automática não começa outro passo; espera o que está em andamento terminar (até `esperaMs`).
   * `concluida` = nada ficou pela metade (o que ficar, retoma do último ponto seguro na próxima vez).
   */
  async pausar(esperaMs = 30_000, duracaoMs = PAUSA_PADRAO_MS): Promise<{ concluida: boolean }> {
    this.pausaAte = this.agora() + Math.min(Math.max(duracaoMs, 0), PAUSA_MAX_MS);
    for (const ws of this.ativos.keys()) this.avisar(ws);
    if (!this.algumAtivo()) return { concluida: true };
    const ok = await new Promise<boolean>((res) => {
      const f = () => { clearTimeout(t); this.esperando.delete(f); res(true); };
      const t = setTimeout(() => { this.esperando.delete(f); res(false); }, esperaMs);
      t.unref?.();
      this.esperando.add(f);
    });
    return { concluida: ok };
  }

  retomar(): void { this.pausaAte = 0; }

  private avisar(ws: string) {
    try { this.bus?.publish(ws, 'sync.changed', { ...this.estado(ws) }); } catch { /* a tela não segura a sincronia */ }
  }
}
