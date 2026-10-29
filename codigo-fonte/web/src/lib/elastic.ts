/**
 * Rolagem com elástico: ao chegar ao fim (ou ao começo) de uma área que rola, a roda do mouse ou o trackpad ainda
 * puxam o conteúdo um pouco, com resistência, e ele volta como uma mola — em vez de parar seco. Vale para qualquer
 * área que rola (painéis, listas, colunas do quadro), sem marcar uma por uma. A cidade (canvas) usa a roda para o
 * zoom e fica de fora; quem pede menos movimento no sistema não vê o efeito. No toque, o navegador já faz o dele.
 */

/** Puxada máxima, em px. */
export const MAX_PULL = 28;

/** Resistência: quanto mais já puxou, menos cada giro da roda puxa (nunca passa de MAX_PULL). */
export function pull(current: number, delta: number): number {
  const sign = Math.sign(delta) || Math.sign(current);
  const room = 1 - Math.min(1, Math.abs(current) / MAX_PULL);
  const next = current + delta * 0.18 * room * room;
  return sign * Math.min(MAX_PULL, Math.abs(next));
}

export interface Box { scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number }

/** A área já está no fim na direção do giro? (1 px de folga para o arredondamento do navegador) */
export function atEdge(b: Box, axis: 'y' | 'x', delta: number): boolean {
  if (axis === 'y') return delta > 0 ? b.scrollTop + b.clientHeight >= b.scrollHeight - 1 : b.scrollTop <= 1;
  return delta > 0 ? b.scrollLeft + b.clientWidth >= b.scrollWidth - 1 : b.scrollLeft <= 1;
}

const scrolls = (el: Element, axis: 'y' | 'x'): boolean => {
  const s = getComputedStyle(el);
  const o = axis === 'y' ? s.overflowY : s.overflowX;
  if (o !== 'auto' && o !== 'scroll') return false;
  return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
};

/** A área segura a rolagem nesse eixo no fim (não passa adiante)? */
const holds = (el: Element, axis: 'y' | 'x'): boolean => {
  const s = getComputedStyle(el);
  return (axis === 'y' ? s.overscrollBehaviorY : s.overscrollBehaviorX) !== 'auto';
};

/** Liga o elástico na página inteira (uma vez). Devolve como desligar. */
export function installElastic(): () => void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let target: HTMLElement | null = null;
  let amount = 0;
  let axis: 'y' | 'x' = 'y';
  let timer = 0;
  const apply = (el: HTMLElement, v: number) => el.style.setProperty('--pull', `${v.toFixed(1)}px`);
  const release = () => {
    const el = target;
    if (!el) return;
    el.dataset.pull = `${axis}-solta`;
    apply(el, 0);
    window.setTimeout(() => { if (target === el && amount === 0) { delete el.dataset.pull; el.style.removeProperty('--pull'); target = null; } }, 380);
    amount = 0;
  };
  const onWheel = (e: WheelEvent) => {
    if (reduce.matches || e.defaultPrevented || e.ctrlKey) return;
    const start = e.target instanceof Element ? e.target : null;
    // painéis laterais e janelas ficam de fora: mover o conteúdo inteiro de uma camada fixa fazia o painel ficar em
    // branco por um instante no fim da rolagem (detalhe das rotinas longas)
    if (!start || start.closest('canvas, [data-no-elastic], select, textarea, .drawer, [role="dialog"]')) return;
    const ax: 'y' | 'x' = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey ? 'x' : 'y';
    const delta = ax === 'x' ? (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) : e.deltaY;
    if (!delta) return;
    // a primeira área que rola nesse eixo recebe o giro; no fim dela, se ela deixa a rolagem passar (só painéis e
    // janelas seguram: overscroll contain no styles.css), quem recebe é a de trás, como no navegador
    let el: Element | null = start;
    for (;;) {
      while (el && el !== document.documentElement && !scrolls(el, ax)) el = el.parentElement;
      if (!el || el === document.documentElement || !(el instanceof HTMLElement)) return;
      if (!atEdge(el, ax, delta)) { if (target === el && amount) release(); return; }
      if (holds(el, ax)) break;
      el = el.parentElement;
    }
    if (target && target !== el) { delete target.dataset.pull; target.style.removeProperty('--pull'); amount = 0; }
    target = el; axis = ax;
    amount = pull(amount, -delta);
    el.dataset.pull = axis;
    apply(el, amount);
    window.clearTimeout(timer);
    timer = window.setTimeout(release, 140);
  };
  addEventListener('wheel', onWheel, { passive: true });
  return () => { removeEventListener('wheel', onWheel); window.clearTimeout(timer); };
}
