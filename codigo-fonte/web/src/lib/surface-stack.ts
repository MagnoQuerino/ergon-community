/**
 * Pilha das superfícies temporárias abertas (gavetas, janelas, diálogos, o menu): a regra de quem responde ao
 * Escape e ao clique fora, sem DOM (testável). O hook que liga isto à tela fica em surface.ts.
 *
 * Antes havia oito ouvintes de Escape independentes: um Escape podia fechar duas camadas ou a de baixo (com o perfil
 * do agente aberto sobre o Modo Foco, fechava o Modo Foco e deixava o perfil). Agora só a de cima responde.
 */
export type CloseWhy = 'escape' | 'outside' | 'button' | 'back';

export interface SurfaceEntry {
  id: number;
  /** bloqueia o resto da página: o Tab fica dentro, o fundo não responde */
  modal: boolean;
  /** dispensável com um clique fora (gavetas de consulta); confirmações críticas, não */
  outside: boolean;
  /** responde ao Escape */
  escape: boolean;
  /** modos de tela (Modo Foco): o Escape digitado num campo de texto é do campo, não do modo */
  ignoreFromInputs: boolean;
  /**
   * painel lateral de consulta (o card aberto): o clique fora num card, menu ou link faz o que ele faz — abrir o outro
   * card, ir para a área — em vez de só fechar o painel. Clique fora em área vazia fecha, como antes.
   */
  passThrough?: boolean;
}

export class SurfaceStack<E extends SurfaceEntry = SurfaceEntry> {
  private items: E[] = [];
  push(e: E): void { this.remove(e.id); this.items.push(e); }
  remove(id: number): void { this.items = this.items.filter((x) => x.id !== id); }
  top(): E | undefined { return this.items[this.items.length - 1]; }
  get size(): number { return this.items.length; }
  ids(): number[] { return this.items.map((x) => x.id); }

  /** Quem fecha com este Escape (só a de cima; nunca duas). null = o Escape segue para a página (a cidade, o campo). */
  onEscape(fromTextField: boolean): E | null {
    const t = this.top();
    if (!t || !t.escape) return null;
    if (t.ignoreFromInputs && fromTextField) return null;
    return t;
  }

  /**
   * Quem fecha com este clique: a de cima, se for dispensável e o clique começou E terminou fora dela (arrastar para
   * selecionar um texto e soltar fora não fecha). Clique num gatilho marcado (o botão que abre/fecha) não conta.
   */
  onOutsideClick(downInsideTop: boolean, upInsideTop: boolean, onKeepElement: boolean, onInteractive = false): E | null {
    const t = this.top();
    if (!t || !t.outside || downInsideTop || upInsideTop || onKeepElement) return null;
    if (t.passThrough && onInteractive) return null; // o card, o menu ou o link clicado assume (antes: o 1º clique só fechava)
    return t;
  }

  /** O Tab fica dentro da de cima quando ela é modal. */
  trapsTab(): boolean { return !!this.top()?.modal; }

  /** Há uma janela modal aberta (o que fica atrás dela, como a dica da tela, não recebe clique). */
  hasModal(): boolean { return this.items.some((x) => x.modal); }
}
