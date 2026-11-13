/**
 * Card inteiro clicável: clicar em qualquer ponto do card abre o que ele mostra (a edição da rotina, a prévia do
 * arquivo, o card da tarefa), sem precisar mirar no botãozinho certo. Os botões, campos e menus de dentro continuam
 * fazendo só o que fazem; arrastar para selecionar um texto não abre nada; um clique que vem de um painel aberto por
 * cima (desenhado fora do card, mas filho dele no React) também não.
 *
 * Teclado: o card não vira um botão gigante (um botão por fora esconderia os de dentro de quem usa leitor de tela).
 * O título do card é um botão de verdade (classe `card-open`), que recebe o foco, abre com Enter ou Espaço e acende o
 * contorno do card inteiro. Onde o card não tem nada clicável dentro (uma linha da lista de tarefas), o próprio card
 * recebe o foco: aí vale `cardKey`, que só abre quando a tecla é no card, e não num campo de dentro.
 */

import { wasDismissClick } from './surface-stack.ts';

/** O que, dentro do card, tem o próprio clique: o card não abre por cima dele. */
export const CARD_SKIP = [
  // um formulário dentro do card (responder ali mesmo, renomear): errar o campo por pouco não abre nada por cima
  'a[href]', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'details', 'option', 'video', 'audio', 'form',
  '[contenteditable=""]', '[contenteditable="true"]',
  '[role="button"]', '[role="link"]', '[role="menu"]', '[role="menuitem"]', '[role="dialog"]', '[role="alertdialog"]',
  '[role="switch"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]', '[role="option"]', '[role="slider"]',
  '[data-card-skip]',
].join(', ');

/** O mínimo de um elemento que a decisão usa (o DOM de verdade, ou um de mentira nos testes). */
export interface CardNode { closest(selector: string): CardNode | null; contains(other: CardNode | null): boolean }

/**
 * Abre ou não: `card` é o card (quem tem o clique), `target` é onde o clique caiu, `selected` é o texto selecionado na
 * página naquele instante. Só abre se o clique foi no próprio card ou em algo dele sem clique próprio.
 */
export function cardShouldOpen(card: CardNode, target: CardNode | null, selected = ''): boolean {
  // fora do card no DOM: veio de um painel aberto por cima (um portal), que é filho do card só no React
  if (!target || !card.contains(target)) return false;
  // terminou de arrastar uma seleção de texto: a pessoa queria copiar, não abrir
  if (selected.trim()) return false;
  const hit = target.closest(CARD_SKIP);
  // o próprio card pode ser um botão (role="button"); o que conta é algo clicável DENTRO dele
  return !hit || hit === card || !card.contains(hit);
}

/** O mínimo de uma seleção de texto que a decisão usa (a do navegador, ou uma de mentira nos testes). */
export interface SelectionLike { isCollapsed: boolean; toString(): string; anchorNode: unknown; focusNode: unknown; containsNode?(node: never, partly: boolean): boolean }

/**
 * O texto selecionado que toca ESTE card (vazio se a seleção está em outro ponto da página). Só a seleção do próprio
 * card impede de abrir: no Edge/Chrome, clicar num card arrastável (o do quadro, a linha da lista, o item de
 * Documentos) ou com user-select:none (o card do agente) não desfaz uma seleção que já existia em outro lugar; olhar a
 * página inteira deixava esses cards sem abrir até a pessoa clicar num texto comum.
 */
export function selectionIn(card: CardNode, sel: SelectionLike | null | undefined): string {
  if (!sel || sel.isCollapsed) return '';
  const text = sel.toString();
  if (!text.trim()) return '';
  let touches = card.contains(sel.anchorNode as CardNode | null) || card.contains(sel.focusNode as CardNode | null);
  // a seleção atravessa o card de ponta a ponta (começa antes e termina depois dele)
  if (!touches && sel.containsNode) { try { touches = sel.containsNode(card as never, true); } catch { touches = false; } }
  return touches ? text : '';
}

/** O texto selecionado agora dentro do card (vazio sem janela, como nos testes, ou se o navegador não deixar ler). */
function selectedText(card: CardNode): string {
  try { return typeof window === 'undefined' ? '' : selectionIn(card, window.getSelection()); } catch { return ''; }
}

/**
 * A seleção que já existia quando o botão do mouse desceu. Clicar em cima de um texto já selecionado (o duplo clique
 * seleciona a palavra) é um clique, não o fim de uma seleção: o navegador só desfaz a seleção depois do clique, e o
 * card não abria (nem fechava) até um 2º clique. Só a seleção que NASCEU neste clique (arrastar) impede de abrir.
 */
let selAtDown = '';
let watching = false;
function watchSelection(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('pointerdown', () => { try { selAtDown = String(window.getSelection() ?? ''); } catch { selAtDown = ''; } }, true);
}

/** O texto selecionado que conta para não abrir: o do card, se não é o mesmo que já estava selecionado antes do clique. */
export function newSelection(inCard: string, atDown: string): string {
  return inCard && inCard === atDown ? '' : inCard;
}

interface ClickLike { button: number; detail?: number; defaultPrevented: boolean; currentTarget: unknown; target: unknown; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; nativeEvent?: unknown }

/**
 * O clique do card: `onClick={cardClick(abrir)}`. Só o botão principal do mouse, sem Ctrl/Shift (que selecionam).
 * Duplo clique conta como um: o 2º clique (detail 2) não faz nada — quem não é técnico dá duplo clique em cards, e a
 * linha que abre e fecha (Pessoas) abria e fechava na hora.
 * O clique fora que fechou um menu ou uma gaveta abre o card no mesmo clique; só não abre quando fechar perguntou se
 * descarta o que foi digitado, ou quando a janela era modal (surface-stack.ts, swallowsDismissClick).
 */
export function cardClick(open: () => void) {
  watchSelection();
  return (e: ClickLike) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if ((e.detail ?? 1) > 1) return;
    if (wasDismissClick(e.nativeEvent ?? e)) return;
    const card = e.currentTarget as CardNode;
    if (cardShouldOpen(card, e.target as CardNode, newSelection(selectedText(card), selAtDown))) open();
  };
}

interface KeyLike { key: string; target: unknown; currentTarget: unknown; repeat?: boolean; preventDefault(): void }

/** Enter ou Espaço com o foco NO card (não num campo ou botão de dentro, que fazem o deles). */
export function cardKeyOpens(e: { key: string; target: unknown; currentTarget: unknown; repeat?: boolean }): boolean {
  return e.target === e.currentTarget && !e.repeat && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar');
}

/** O teclado do card que recebe o foco: `onKeyDown={cardKey(abrir)}`. */
export function cardKey(open: () => void) {
  return (e: KeyLike) => {
    if (!cardKeyOpens(e)) return;
    e.preventDefault(); // Espaço não rola a página
    open();
  };
}
