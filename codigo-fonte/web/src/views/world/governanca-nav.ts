// O item "Governança" do menu da esquerda (lido pelo App.tsx, se o módulo do World estiver nesta instalação): aberto
// no World Team para quem administra, trancado (com o convite para o Team) nos outros planos, ausente para os demais.
import { acessoGovernanca, type AcessoGov } from './governanca.ts';
import { useWorldVivo } from './vivo.ts';

export function useGovernancaNav(): AcessoGov {
  const v = useWorldVivo();
  return acessoGovernanca(v.bound, v.bill);
}
