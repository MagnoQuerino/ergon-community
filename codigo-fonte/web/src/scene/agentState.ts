/**
 * AgentViewState: representação visual derivada de eventos reais de execução.
 * Nenhum modelo decide movimento; personagens ociosos não geram chamadas.
 */
export type RunStatus = 'queued' | 'running' | 'waiting_user' | null;
export type Visual = 'idle' | 'attention' | 'working' | 'waiting';

export function visualFor(run: RunStatus): Visual {
  switch (run) {
    case 'queued': return 'attention';
    case 'running': return 'working';
    case 'waiting_user': return 'waiting';
    default: return 'idle';
  }
}

/** Onde a figura deve estar para cada estado: trabalhando senta à mesa; demais ficam ao lado. */
export function targetFor(v: Visual): 'seat' | 'idle' {
  return v === 'working' || v === 'waiting' ? 'seat' : 'idle';
}

export interface Mover {
  path: Array<[number, number, number]>;
  seg: number;
  t: number;
  pos: [number, number, number];
}

export const SPEED = 2.2; // unidades por segundo

export function startMove(from: [number, number, number], path: Array<[number, number, number]>): Mover {
  return { path: path.length ? path : [from], seg: 0, t: 0, pos: [...from] };
}

/** Avança o deslocamento; delta limitado (aba volta do segundo plano sem "teleporte" longo). */
export function stepMove(m: Mover, dtSeconds: number): boolean {
  let remaining = Math.min(dtSeconds, 0.1) * SPEED;
  while (remaining > 0 && m.seg < m.path.length - 1) {
    const a = m.path[m.seg]; const b = m.path[m.seg + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1e-6;
    const left = (1 - m.t) * len;
    if (remaining >= left) { remaining -= left; m.seg++; m.t = 0; }
    else { m.t += remaining / len; remaining = 0; }
  }
  if (m.seg >= m.path.length - 1) { m.pos = [...m.path[m.path.length - 1]]; return false; }
  const a = m.path[m.seg]; const b = m.path[m.seg + 1];
  m.pos = [a[0] + (b[0] - a[0]) * m.t, a[1] + (b[1] - a[1]) * m.t, a[2] + (b[2] - a[2]) * m.t];
  return true;
}
