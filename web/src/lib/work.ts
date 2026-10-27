/**
 * Estado real do trabalho num card da equipe (o servidor decide; aqui só o nome e a cor). Execução terminada não é
 * trabalho concluído: "concluída" só com evidência, ou com a sua aprovação.
 *
 * Na tela, os 9 estados internos viram 5 (Na fila, Em andamento, Precisa de você, Com problema, Concluída); o estado
 * interno fica nos detalhes técnicos do card. O tipo de trabalho (informativo, documental…) não aparece mais.
 */
export type WorkState = 'solicitada' | 'processamento' | 'resultado' | 'validacao' | 'concluida' | 'aguardando_info' | 'falha' | 'revisao' | 'aguardando_aprovacao';
export type Display = 'fila' | 'andamento' | 'voce' | 'problema' | 'concluida';

export const DISPLAY_OF: Record<WorkState, Display> = {
  solicitada: 'fila', processamento: 'andamento', resultado: 'andamento', validacao: 'andamento', concluida: 'concluida',
  aguardando_info: 'voce', aguardando_aprovacao: 'voce', revisao: 'problema', falha: 'problema',
};

export const DISPLAY_LABEL: Record<Display, string> = {
  fila: 'Na fila', andamento: 'Em andamento', voce: 'Precisa de você', problema: 'Com problema', concluida: 'Concluída',
};

/** Cor do selo: o que pede você (aviso), o que deu errado (erro), o que está pronto (ok). */
export const DISPLAY_BADGE: Record<Display, string> = { fila: '', andamento: 'badge--warn', voce: 'badge--rec', problema: 'badge--err', concluida: 'badge--ok' };

export const displayOf = (s: string | null | undefined): Display => DISPLAY_OF[(s ?? 'solicitada') as WorkState] ?? 'fila';

/** Nome interno de cada estado (detalhes técnicos e histórico). */
export const WORK_LABEL: Record<WorkState, string> = {
  solicitada: 'Solicitada', processamento: 'Em processamento', resultado: 'Resultado produzido', validacao: 'Em validação', concluida: 'Concluída',
  aguardando_info: 'Aguardando informações', falha: 'Falha', revisao: 'Revisão necessária', aguardando_aprovacao: 'Aguardando aprovação',
};

export const RESULT_LABEL: Record<string, string> = {
  validado: 'validado', reprovado: 'não passou', aguardando_aprovacao: 'aguarda sua aprovação', aguardando_info: 'aguarda informação',
  sem_confirmacao: 'sem confirmação externa', falha: 'falhou', confirmado_humano: 'aprovado por você', devolvido: 'devolvido por você',
};
