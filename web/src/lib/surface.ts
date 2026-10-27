import { useEffect, useRef, type RefObject } from 'react';
import { SurfaceStack, type CloseWhy, type SurfaceEntry } from './surface-stack.ts';

export type { CloseWhy } from './surface-stack.ts';

/**
 * Superfícies temporárias (gavetas, janelas, diálogos, o menu) com o mesmo comportamento em todo o Ergon:
 * - Escape fecha só a de cima (os campos de texto de um Modo de tela ficam com o Escape deles);
 * - clique fora fecha as dispensáveis, só se começou e terminou fora; gatilhos com data-keep-surface não contam;
 * - fechar passa por onClose(why): quem tem edição pendente grava antes ou pergunta, e decide se fecha;
 * - foco: entra na superfície ao abrir, volta a quem abriu ao fechar; o modal prende o Tab.
 */
interface Live extends SurfaceEntry { el: () => HTMLElement | null; request: (why: CloseWhy) => void }

const stack = new SurfaceStack<Live>();
let seq = 0;
let installed = false;
let downTop: { id: number; inside: boolean } | null = null;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';
/** o que faz alguma coisa ao ser clicado: um card, um item do menu, um link, um botão, um campo */
const INTERACTIVE = 'a[href], button, [role="button"], [role="tab"], input, select, textarea, label, summary, [tabindex]:not([tabindex="-1"]), [data-opens]';
const isTextField = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // captura na janela: roda antes dos ouvintes da página (a cidade também usa o Escape); quem fecha, para o evento
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      const t = stack.onEscape(isTextField(e.target));
      if (t) { e.preventDefault(); e.stopImmediatePropagation(); t.request('escape'); return; }
      if (stack.trapsTab()) e.stopImmediatePropagation(); // modal que não fecha com Esc: nada atrás dele responde
      return;
    }
    if (e.key === 'Tab' && stack.trapsTab()) {
      const el = stack.top()?.el();
      if (!el) return;
      const list = focusables(el);
      if (!list.length) { e.preventDefault(); el.focus(); return; }
      const first = list[0]; const last = list[list.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    }
  }, true);
  window.addEventListener('pointerdown', (e) => {
    const t = stack.top();
    downTop = t ? { id: t.id, inside: !!t.el()?.contains(e.target as Node) } : null;
  }, true);
  window.addEventListener('click', (e) => {
    const t = stack.top(); const d = downTop; downTop = null;
    if (!t || !d || d.id !== t.id) return;
    const target = e.target as Element | null;
    const keep = !!target?.closest?.('[data-keep-surface]');
    const interactive = !!target?.closest?.(INTERACTIVE);
    // clique dentro de outra superfície por cima (ex.: um menu do navegador) não chega aqui; dentro da de cima, fica
    if (stack.onOutsideClick(d.inside, !!t.el()?.contains(target as Node), keep, interactive)) t.request('outside');
  }, true);
}

export interface SurfaceOptions {
  /** fechar: a superfície decide (gravar antes, perguntar); why diz o que pediu */
  onClose: (why: CloseWhy) => void;
  modal?: boolean;
  outside?: boolean;
  escape?: boolean;
  ignoreFromInputs?: boolean;
  /** leva o foco para dentro ao abrir (padrão: sim) */
  autoFocus?: boolean;
  /** false = registrada mas fora da pilha (ex.: painel embutido numa tela, não flutuante) */
  active?: boolean;
  /** painel de consulta: clique fora num card, menu ou link faz o que ele faz, em vez de só fechar (surface-stack.ts) */
  passThrough?: boolean;
}

export function useSurface(ref: RefObject<HTMLElement | null>, opts: SurfaceOptions): void {
  const close = useRef(opts.onClose);
  close.current = opts.onClose;
  const active = opts.active !== false;
  const modal = !!opts.modal; const outside = !!opts.outside; const passThrough = !!opts.passThrough; const escape = opts.escape !== false; const ignore = !!opts.ignoreFromInputs; const autoFocus = opts.autoFocus !== false;
  useEffect(() => {
    if (!active) return;
    install();
    const id = ++seq;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push({ id, modal, outside, escape, ignoreFromInputs: ignore, passThrough, el: () => ref.current, request: (why) => close.current(why) });
    if (autoFocus) {
      // depois de pintar: o conteúdo (e o que carrega) já está lá
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el || el.contains(document.activeElement)) return;
        const want = el.querySelector<HTMLElement>('[data-autofocus]') ?? (modal ? focusables(el)[0] : null) ?? el;
        if (want === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        want.focus({ preventScroll: true });
      });
    }
    return () => {
      stack.remove(id);
      const el = ref.current;
      // devolve o foco a quem abriu, se ele ainda existe e o foco estava dentro (ou se perdeu no body)
      const lost = !document.activeElement || document.activeElement === document.body || (el?.contains(document.activeElement) ?? false);
      if (opener && opener.isConnected && lost) requestAnimationFrame(() => opener.focus({ preventScroll: true }));
    };
  }, [active, modal, outside, escape, ignore, autoFocus, passThrough]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Fechar com algo digitado e não salvo: pergunta (só aí; fechar sem pendência nunca pergunta). true = pode fechar.
 */
export const keepTyped = (dirty: boolean, what: string): boolean => !dirty || window.confirm(`Descartar ${what}?`);

/** Quantas superfícies estão abertas (testes e depuração). */
export const openSurfaces = (): number => stack.size;
