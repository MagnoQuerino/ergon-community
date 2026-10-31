/**
 * Arrastar um agente pelo boneco até um setor ou uma construção (atalho; "Mover para…" faz o mesmo sem arrastar).
 * O estado da operação (qual agente, sobre qual destino) fica aqui, fora dos cards: a grade virtualizada pode
 * desmontar o card de origem no meio do arraste sem perder nada nem trocar de agente. Os ouvintes ficam na janela.
 * Mouse e caneta começam depois de um pequeno movimento (um clique continua abrindo o perfil); no toque, segurar um
 * instante começa o arraste — sem isso a página rola normalmente. Esc cancela; soltar fora, ou na origem, não muda nada.
 */
import { useSyncExternalStore } from 'react';
import type { TeamAgent } from './teamData.ts';

export type DropTarget = { kind: 'sector'; id: string; name: string } | { kind: 'structure'; id: string; name: string } | { kind: 'tray'; id: ''; name: string };
interface DragState { agent: TeamAgent }

let state: DragState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
/** O agente sendo arrastado agora (ou nenhum): só muda no começo e no fim, não a cada movimento. */
export function useDragging(): TeamAgent | null { return useSyncExternalStore(subscribe, () => state?.agent ?? null, () => null); }

/** Destino sob o ponteiro: o elemento com data-drop-kind mais próximo. */
export function targetAt(x: number, y: number): { el: HTMLElement; t: DropTarget } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop-kind]');
  if (!el) return null;
  const kind = el.dataset.dropKind as DropTarget['kind'];
  return { el, t: { kind, id: (el.dataset.dropId ?? '') as '', name: el.dataset.dropName ?? '' } as DropTarget };
}

/** O destino aceita este agente? (o servidor confere de novo; isto só orienta o destaque) */
export function dropProblem(a: TeamAgent, t: DropTarget): string | null {
  if (t.kind === 'tray') return null;
  if (t.kind === 'sector') {
    if (a.sector_key === t.id) return 'já está neste setor';
    if (a.coordinator) return 'o Coordenador não muda de setor';
    return null;
  }
  if (a.building_id === t.id) return 'já mora aqui';
  if (a.status !== 'active') return 'desativado: reative antes';
  return null;
}

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

/**
 * Começa a observar um gesto no boneco. `onDrop` recebe o destino válido (a mesma ação de "Mover para…");
 * soltar na bandeja ("Mover para…") chama `onTray`.
 */
export function beginDrag(e: React.PointerEvent<HTMLElement>, agent: TeamAgent, h: { onDrop: (a: TeamAgent, t: DropTarget) => void; onTray: (a: TeamAgent) => void; onRefuse?: (a: TeamAgent, why: string) => void; disabled?: boolean }): void {
  if (h.disabled || state || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const sx = e.clientX; const sy = e.clientY; const touch = e.pointerType === 'touch';
  const scroller = scrollParent(e.currentTarget);
  let active = false; let over: { el: HTMLElement; t: DropTarget } | null = null; let x = sx; let y = sy;
  let hold = 0; let raf = 0;
  const ghost = () => document.getElementById('drag-ghost');
  const paint = () => {
    const g = ghost(); if (g) g.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
    const hit = targetAt(x, y);
    if (over?.el !== hit?.el) { over?.el.classList.remove('is-drop-over', 'is-drop-bad'); over = hit; }
    const problem = over ? dropProblem(agent, over.t) : null;
    if (over) { over.el.classList.toggle('is-drop-over', !problem); over.el.classList.toggle('is-drop-bad', !!problem); }
    const hint = document.getElementById('drag-ghost-hint');
    if (hint) hint.textContent = !over ? 'Solte num setor ou numa construção' : problem ? `Não: ${problem}` : over.t.kind === 'tray' ? 'Escolher o destino…' : `Mover para ${over.t.name}`;
  };
  const autoscroll = () => {
    raf = 0; if (!active) return;
    const edge = 64; const r = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
    const dy = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0;
    if (dy) { scroller.scrollBy(0, dy); paint(); }
    raf = requestAnimationFrame(autoscroll);
  };
  const start = () => {
    active = true; state = { agent }; emit();
    document.body.classList.add('is-dragging');
    requestAnimationFrame(paint); raf = requestAnimationFrame(autoscroll);
  };
  const stopScroll = (ev: TouchEvent) => { if (active) ev.preventDefault(); };
  const swallowClick = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
  const end = (drop: boolean) => {
    clearTimeout(hold); if (raf) cancelAnimationFrame(raf);
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel); removeEventListener('keydown', key, true);
    removeEventListener('touchmove', stopScroll);
    if (!active) return;
    over?.el.classList.remove('is-drop-over', 'is-drop-bad');
    const t = over?.t; const problem = t ? dropProblem(agent, t) : null; const ok = drop && t && !problem;
    active = false; state = null; emit(); document.body.classList.remove('is-dragging');
    // o clique que vem depois de soltar não abre o perfil
    addEventListener('click', swallowClick, { capture: true, once: true }); setTimeout(() => removeEventListener('click', swallowClick, { capture: true }), 0);
    if (ok && t) { if (t.kind === 'tray') h.onTray(agent); else h.onDrop(agent, t); }
    // soltou num destino que não aceita: diz por quê ("já está aqui" não precisa de aviso)
    else if (drop && t && problem && !problem.startsWith('já')) h.onRefuse?.(agent, problem);
  };
  const move = (ev: PointerEvent) => {
    x = ev.clientX; y = ev.clientY;
    if (!active) {
      const far = Math.hypot(x - sx, y - sy) > (touch ? 10 : 6);
      if (touch) { if (far) end(false); return; } // rolou antes de segurar: é rolagem
      if (far) start(); else return;
    }
    paint();
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && active) { ev.preventDefault(); ev.stopPropagation(); end(false); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel); addEventListener('keydown', key, true);
  if (touch) { addEventListener('touchmove', stopScroll, { passive: false }); hold = window.setTimeout(start, 380); }
}
