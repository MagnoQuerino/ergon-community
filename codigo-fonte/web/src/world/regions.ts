/**
 * Regiões da cidade para o zoom distante (docs/CIDADE_ESCALA.md): blocos de R×R lotes com quantas construções,
 * agentes, quantos trabalhando e quantos esperando você. Puro (testado): as somas batem com os totais, e a chave de
 * uma região só depende dos lotes, então fica estável quando a cidade cresce.
 */
import { CELL } from '../../../shared/city.ts';

export interface RegionInput { id: string; i: number; j: number; w: number; d: number }
export interface Occ { agents: number; working: number; waiting: number }
export interface Region { key: string; ri: number; rj: number; structures: number; agents: number; working: number; waiting: number; x: number; z: number }

/** Lado da região em lotes para o zoom: grande o bastante para os rótulos não se encavalarem. */
export function regionSize(k: number, minPx = 150): number {
  // um lote ocupa ~320 px do mundo na diagonal da tela (2 × 8 unidades × 20 px)
  for (const r of [4, 8, 16, 32, 64]) if (r * 320 * k >= minPx) return r;
  return 128;
}

export function regionsOf(items: RegionInput[], occ: Map<string, Occ>, R: number): Region[] {
  const by = new Map<string, Region & { sx: number; sz: number; n: number }>();
  for (const s of items) {
    const ci = s.i + s.w / 2; const cj = s.j + s.d / 2;
    const ri = Math.floor(ci / R); const rj = Math.floor(cj / R); const key = `${R}:${ri},${rj}`;
    let r = by.get(key);
    if (!r) { r = { key, ri, rj, structures: 0, agents: 0, working: 0, waiting: 0, x: 0, z: 0, sx: 0, sz: 0, n: 0 }; by.set(key, r); }
    const o = occ.get(s.id);
    r.structures++; r.sx += ci * CELL; r.sz += cj * CELL; r.n++;
    if (o) { r.agents += o.agents; r.working += o.working; r.waiting += o.waiting; }
  }
  return [...by.values()].map(({ sx, sz, n, ...r }) => ({ ...r, x: sx / n, z: sz / n })).sort((a, b) => a.rj - b.rj || a.ri - b.ri);
}
