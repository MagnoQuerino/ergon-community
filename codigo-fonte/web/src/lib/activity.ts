import { api } from './api.ts';

const BEAT_MS = 60_000;
const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Trava por inatividade: só mouse/teclado de verdade contam (recargas automáticas não). Avisa o servidor no
 * máximo 1×/min e tranca a tela aqui também quando o tempo passa (o servidor tranca do lado dele).
 */
export function startActivity(idleMinutes: number, onIdle: () => void): () => void {
  let last = Date.now();
  let sent = Date.now();
  const mark = () => {
    last = Date.now();
    if (last - sent >= BEAT_MS) { sent = last; void api.post('/api/session/activity').catch(() => {}); }
  };
  for (const e of EVENTS) addEventListener(e, mark, { passive: true });
  const timer = window.setInterval(() => { if (idleMinutes > 0 && Date.now() - last > idleMinutes * 60_000) onIdle(); }, 15_000);
  return () => { for (const e of EVENTS) removeEventListener(e, mark); clearInterval(timer); };
}
