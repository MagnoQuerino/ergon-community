// Busca nas listas de workspaces (o seletor da barra de cima e Configurações › Workspace): pelo nome, sem caixa e sem
// acento. A caixa de busca só aparece a partir de BUSCA_WS_A_PARTIR workspaces; com poucos, a lista cabe de olho.
export const BUSCA_WS_A_PARTIR = 6;

export const mostraBuscaWs = (quantos: number): boolean => quantos >= BUSCA_WS_A_PARTIR;

const dobrar = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Os workspaces cujo nome contém o que foi digitado, na ordem de antes; busca vazia devolve todos. */
export function filtrarWorkspaces<T extends { name: string }>(lista: readonly T[], busca: string): T[] {
  const q = dobrar(busca);
  if (!q) return [...lista];
  return lista.filter((w) => dobrar(w.name).includes(q));
}

/** Setas no resultado: anda delta casas e dá a volta nas pontas; sem resultado, 0. */
export function moverAtivo(atual: number, quantos: number, delta: number): number {
  if (quantos <= 0) return 0;
  return (((atual + delta) % quantos) + quantos) % quantos;
}
