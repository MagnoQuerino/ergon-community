/**
 * Cache com descarte (o menos usado sai primeiro). Ler renova a entrada; a capacidade pode crescer com o que está na
 * tela (`reserve`), para que uma cidade maior que o cache não refaça tudo a cada quadro.
 */
export class Lru<V> {
  private readonly m = new Map<string, V>();
  max: number;
  readonly base: number;
  constructor(max: number) { this.max = max; this.base = max; }
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  has(k: string): boolean { return this.m.has(k); }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); this.trim(); }
  /** Garante lugar para pelo menos `n` entradas (nunca abaixo da capacidade de base). */
  reserve(n: number): void { this.max = Math.max(this.base, Math.ceil(n)); this.trim(); }
  private trim(): void { while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
  get size(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
}
