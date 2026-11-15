// O encaixe do "Rodar na nuvem" nos cartões (card do quadro, rotina): o módulo do World (views/world/CardNuvem.tsx)
// entrega o item do menu e o selo; sem ele, ou fora do workspace ligado ao World, nada aparece e nada muda.
export interface NuvemNoCartao {
  /** o item do menu (ou o botão da rotina): desabilitado com o motivo curto em `motivo` */
  item: { label: string; icon: string; disabled: boolean; motivo?: string; onClick: () => void } | null;
  /** selo discreto do cartão que está na nuvem */
  selo: { texto: string; tom: 'info' | 'ok' | 'warn' } | null;
  /** o que aconteceu no último clique (ou o erro) */
  aviso: string | null;
}
export const SEM_NUVEM: NuvemNoCartao = { item: null, selo: null, aviso: null };
/** sem o módulo do World: nenhum hook, nada na tela */
export const semNuvem = (_ref: string | null): NuvemNoCartao => SEM_NUVEM;
