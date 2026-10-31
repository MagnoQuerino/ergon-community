/**
 * Navegação por grade: cada andar (e a cidade) vira uma grade de células livres ou bloqueadas a partir das
 * caixas dos objetos — mesas, paredes, móveis, escadas, prédios, água. A* com 8 vizinhos (sem cortar quinas)
 * e alisamento por linha de visada. Um prédio novo não precisa de rotas desenhadas à mão: basta declarar os
 * objetos (com caixa) e as portas; a grade sai deles.
 */
import { type Box, type Vec2 } from './geom.ts';

const SQ2 = Math.SQRT2;

export class NavGrid {
  readonly x0: number; readonly z0: number; readonly res: number;
  readonly w: number; readonly h: number;
  readonly blocked: Uint8Array;

  constructor(bounds: Box, res: number) {
    this.res = res; this.x0 = bounds.x0; this.z0 = bounds.z0;
    this.w = Math.max(1, Math.ceil((bounds.x1 - bounds.x0) / res));
    this.h = Math.max(1, Math.ceil((bounds.z1 - bounds.z0) / res));
    this.blocked = new Uint8Array(this.w * this.h);
  }

  private ci(x: number): number { return Math.floor((x - this.x0) / this.res); }
  private cj(z: number): number { return Math.floor((z - this.z0) / this.res); }
  center(i: number, j: number): Vec2 { return [this.x0 + (i + 0.5) * this.res, this.z0 + (j + 0.5) * this.res]; }
  inside(i: number, j: number): boolean { return i >= 0 && j >= 0 && i < this.w && j < this.h; }
  isFreeCell(i: number, j: number): boolean { return this.inside(i, j) && !this.blocked[j * this.w + i]; }
  free(x: number, z: number): boolean { return this.isFreeCell(this.ci(x), this.cj(z)); }

  /** Marca células cujo centro cai na caixa (com folga `m`, o raio de quem anda). */
  block(b: Box, m = 0, v = 1): void {
    const i0 = Math.max(0, Math.ceil((b.x0 - m - this.x0) / this.res - 0.5)); const i1 = Math.min(this.w - 1, Math.floor((b.x1 + m - this.x0) / this.res - 0.5));
    const j0 = Math.max(0, Math.ceil((b.z0 - m - this.z0) / this.res - 0.5)); const j1 = Math.min(this.h - 1, Math.floor((b.z1 + m - this.z0) / this.res - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.blocked[j * this.w + i] = v;
  }
  open(b: Box): void { this.block(b, 0, 0); }
  blockCircle(x: number, z: number, r: number): void {
    const i0 = Math.max(0, this.ci(x - r)); const i1 = Math.min(this.w - 1, this.ci(x + r));
    const j0 = Math.max(0, this.cj(z - r)); const j1 = Math.min(this.h - 1, this.cj(z + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const [cx, cz] = this.center(i, j);
      if (Math.hypot(cx - x, cz - z) <= r) this.blocked[j * this.w + i] = 1;
    }
  }
  /** Bloqueia por função (formas que não são caixas: arquibancada, círculos); `within` limita a varredura a uma caixa. */
  blockWhere(test: (x: number, z: number) => boolean, within?: Box): void {
    const i0 = within ? Math.max(0, Math.floor((within.x0 - this.x0) / this.res) - 1) : 0; const i1 = within ? Math.min(this.w - 1, Math.ceil((within.x1 - this.x0) / this.res) + 1) : this.w - 1;
    const j0 = within ? Math.max(0, Math.floor((within.z0 - this.z0) / this.res) - 1) : 0; const j1 = within ? Math.min(this.h - 1, Math.ceil((within.z1 - this.z0) / this.res) + 1) : this.h - 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const [x, z] = this.center(i, j); if (test(x, z)) this.blocked[j * this.w + i] = 1; }
  }

  // memória da busca reaproveitada entre chamadas (antes: três arrays do tamanho da grade a cada busca, mesmo curta)
  private buf: { gs: Float32Array; came: Int32Array; seen: Int32Array; done: Int32Array; stamp: number } | null = null;

  /** Célula livre mais próxima (busca em anéis), ou null. */
  nearestFree(x: number, z: number, maxR = 6): [number, number] | null {
    const i0 = this.ci(x); const j0 = this.cj(z);
    if (this.isFreeCell(i0, j0)) return [i0, j0];
    const R = Math.ceil(maxR / this.res);
    let best: [number, number] | null = null; let bd = Infinity;
    for (let r = 1; r <= R; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = i0 + di; const j = j0 + dj;
        if (!this.isFreeCell(i, j)) continue;
        const [cx, cz] = this.center(i, j); const d = Math.hypot(cx - x, cz - z);
        if (d < bd) { bd = d; best = [i, j]; }
      }
      if (best) return best;
    }
    return null;
  }

  /** Linha reta livre entre dois pontos (amostragem fina: não atravessa quinas). */
  lineFree(a: Vec2, b: Vec2): boolean {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / (this.res * 0.35)));
    for (let k = 0; k <= n; k++) {
      const t = k / n; const x = a[0] + (b[0] - a[0]) * t; const z = a[1] + (b[1] - a[1]) * t;
      if (!this.free(x, z)) return false;
    }
    return true;
  }

  /**
   * Caminho de `from` a `to`. As pontas podem estar em células bloqueadas (assento atrás da mesa, banco):
   * a busca parte e chega da célula livre mais próxima e o caminho termina exatamente no ponto pedido.
   * null = sem caminho.
   */
  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const s = this.nearestFree(from[0], from[1]); const g = this.nearestFree(to[0], to[1]);
    if (!s || !g) return null;
    const W = this.w; const N = W * this.h;
    const si = s[1] * W + s[0]; const gi = g[1] * W + g[0];
    // marca da busca atual: uma célula só vale se foi tocada nesta busca (sem preencher a grade inteira)
    if (!this.buf) this.buf = { gs: new Float32Array(N), came: new Int32Array(N), seen: new Int32Array(N), done: new Int32Array(N), stamp: 0 };
    const B = this.buf;
    if (B.stamp >= 0x7ffffffe) { B.seen.fill(0); B.done.fill(0); B.stamp = 0; }
    const st = ++B.stamp;
    const G = (i: number) => (B.seen[i] === st ? B.gs[i] : Infinity);
    const setG = (i: number, v: number, from: number) => { B.seen[i] = st; B.gs[i] = v; B.came[i] = from; };
    const came = (i: number) => (B.seen[i] === st ? B.came[i] : -1);
    const heap = new MinHeap();
    const hx = (i: number) => { const di = Math.abs((i % W) - g[0]); const dj = Math.abs(Math.floor(i / W) - g[1]); return (Math.max(di, dj) - Math.min(di, dj)) + SQ2 * Math.min(di, dj); };
    setG(si, 0, -1); heap.push(si, hx(si));
    let found = si === gi;
    while (!found && heap.size) {
      const cur = heap.pop();
      if (B.done[cur] === st) continue;
      B.done[cur] = st;
      if (cur === gi) { found = true; break; }
      const ci = cur % W; const cj = (cur - ci) / W;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di; const nj = cj + dj;
        if (!this.isFreeCell(ni, nj)) continue;
        if (di && dj && (!this.isFreeCell(ci + di, cj) || !this.isFreeCell(ci, cj + dj))) continue; // sem cortar quina
        const nidx = nj * W + ni; if (B.done[nidx] === st) continue;
        const ng = G(cur) + (di && dj ? SQ2 : 1);
        if (ng < G(nidx)) { setG(nidx, ng, cur); heap.push(nidx, ng + hx(nidx)); }
      }
    }
    if (!found) return null;
    const cells: Vec2[] = [];
    for (let c = gi; c !== -1; c = came(c)) { cells.push(this.center(c % W, Math.floor(c / W))); if (c === si) break; }
    cells.reverse();
    // alisamento: de cada ponto, pula para o mais distante que se vê em linha reta
    const raw: Vec2[] = [from, ...cells, to];
    const out: Vec2[] = [from];
    let k = 0;
    while (k < raw.length - 1) {
      let far = k + 1;
      for (let m = raw.length - 1; m > k + 1; m--) {
        // as pontas (fora da grade livre) só ligam ao vizinho imediato da busca
        if ((k === 0 && !this.free(from[0], from[1])) || (m === raw.length - 1 && !this.free(to[0], to[1]))) continue;
        if (this.lineFree(raw[k], raw[m])) { far = m; break; }
      }
      out.push(raw[far]); k = far;
    }
    return dedupe(out);
  }
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-4) out.push(p);
  return out;
}

class MinHeap {
  private ids: number[] = []; private keys: number[] = [];
  get size(): number { return this.ids.length; }
  push(id: number, key: number): void {
    const a = this.ids; const k = this.keys; a.push(id); k.push(key);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [a[p], a[i]] = [a[i], a[p]]; [k[p], k[i]] = [k[i], k[p]]; i = p; }
  }
  pop(): number {
    const a = this.ids; const k = this.keys; const top = a[0];
    const lastId = a.pop()!; const lastK = k.pop()!;
    if (a.length) {
      a[0] = lastId; k[0] = lastK; let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1; let m = i;
        if (l < a.length && k[l] < k[m]) m = l; if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [k[m], k[i]] = [k[i], k[m]]; i = m;
      }
    }
    return top;
  }
}
