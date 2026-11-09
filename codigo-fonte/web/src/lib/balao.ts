// Balões da barra de cima (Estado, Workspace, Música, Conta e a gaveta Aguardando você): um aberto por vez.
// Os botões deles têm data-keep-surface (clicar num não conta como "clique fora" do outro), então quem fecha o
// anterior é este armazém: abrir um fecha o que estava aberto, sem um ficar por cima do outro.
import { useSyncExternalStore } from 'react';

export type Balao = 'estado' | 'workspace' | 'musica' | 'conta' | 'decisoes';

let atual: Balao | null = null;
const subs = new Set<() => void>();

export function balaoAberto(): Balao | null { return atual; }

/** Abre um (fechando o que estiver aberto) ou, com null, fecha todos. */
export function abrirBalao(b: Balao | null): void {
  if (atual === b) return;
  atual = b;
  subs.forEach((f) => f());
}

/** Fecha só se for ele o aberto (fechar um não fecha o outro que abriu depois). */
export function fecharBalao(b: Balao): void { if (atual === b) abrirBalao(null); }

/** Como um useState(boolean) para um balão, mas compartilhado: abrir este fecha os outros. */
export function useBalao(b: Balao): [boolean, (v: boolean | ((aberto: boolean) => boolean)) => void] {
  const aberto = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => atual === b, () => false);
  const set = (v: boolean | ((aberto: boolean) => boolean)) => {
    const quer = typeof v === 'function' ? v(atual === b) : v;
    if (quer) abrirBalao(b); else fecharBalao(b);
  };
  return [aberto, set];
}
