/**
 * Estado real do trabalho num card da equipe (o servidor decide; aqui só o nome e a cor). Execução terminada não é
 * trabalho concluído: "concluída" só com evidência, ou com a sua aprovação.
 *
 * Na tela, os 9 estados internos viram 5 (Na fila, Em andamento, Precisa de você, Com problema, Concluída); o estado
 * interno fica nos detalhes técnicos do card. O tipo de trabalho (informativo, documental…) não aparece mais.
 */
import { t, type Chave } from '../i18n/index.ts';

export type WorkState = 'solicitada' | 'processamento' | 'resultado' | 'validacao' | 'concluida' | 'aguardando_info' | 'falha' | 'revisao' | 'aguardando_aprovacao';
export type Display = 'fila' | 'andamento' | 'voce' | 'problema' | 'concluida';

const DISPLAY_OF: Record<WorkState, Display> = {
  solicitada: 'fila', processamento: 'andamento', resultado: 'andamento', validacao: 'andamento', concluida: 'concluida',
  aguardando_info: 'voce', aguardando_aprovacao: 'voce', revisao: 'problema', falha: 'problema',
};

/**
 * Uma tabela de rótulos que sempre lê o idioma atual: cada valor vem do dicionário na hora em que é lido (trocar o
 * idioma troca o rótulo, sem recarregar). Quem usa continua lendo `TABELA[estado]` como antes.
 */
function rotulos<K extends string>(chaves: Record<K, Chave>): Readonly<Record<K, string>> {
  const ler = t as (c: Chave) => string;
  const o = {} as Record<K, string>;
  for (const k of Object.keys(chaves) as K[]) Object.defineProperty(o, k, { get: () => ler(chaves[k]), enumerable: true });
  return o;
}

/**
 * O selo do card no quadro, com as mesmas palavras da situação nos detalhes da tarefa (server/src/services/resumo-tarefa.ts):
 * quem bate o olho no quadro e abre o card lê a mesma coisa.
 */
export const SITUACAO_LABEL: Readonly<Record<WorkState, string>> = rotulos<WorkState>({
  solicitada: 'quadro.situacao.naFila', processamento: 'quadro.situacao.trabalhando', resultado: 'quadro.situacao.trabalhando',
  validacao: 'quadro.situacao.trabalhando', concluida: 'quadro.situacao.feito', aguardando_info: 'quadro.situacao.precisaDeVoce',
  aguardando_aprovacao: 'quadro.situacao.esperandoAprovacao', revisao: 'quadro.situacao.precisaDecisao', falha: 'quadro.situacao.naoFeito',
});
export const situacaoDe = (s: string | null | undefined): string => SITUACAO_LABEL[(s ?? 'solicitada') as WorkState] ?? SITUACAO_LABEL.solicitada;

/** Cor do selo: o que pede você (aviso), o que deu errado (erro), o que está pronto (ok). */
export const DISPLAY_BADGE: Record<Display, string> = { fila: '', andamento: 'badge--warn', voce: 'badge--rec', problema: 'badge--err', concluida: 'badge--ok' };

export const displayOf = (s: string | null | undefined): Display => DISPLAY_OF[(s ?? 'solicitada') as WorkState] ?? 'fila';

/** Nome interno de cada estado (detalhes técnicos e histórico). */
export const WORK_LABEL: Readonly<Record<WorkState, string>> = rotulos<WorkState>({
  solicitada: 'quadro.estado.solicitada', processamento: 'quadro.estado.processamento', resultado: 'quadro.estado.resultado',
  validacao: 'quadro.estado.validacao', concluida: 'quadro.estado.concluida', aguardando_info: 'quadro.estado.aguardandoInfo',
  falha: 'quadro.estado.falha', revisao: 'quadro.estado.revisao', aguardando_aprovacao: 'quadro.estado.aguardandoAprovacao',
});

/**
 * "Há quanto tempo", curto, para a coluna estreita Atualizada da lista: agora · há 5 min · há 3 h · ontem · há 12 dias
 * (just now · 5 min ago · 3 h ago · yesterday · 12 days ago). O relógio adiantado não vira "daqui a".
 */
export function haQuantoTempo(iso: string, agora: number = Date.now()): string {
  const quando = Date.parse(iso);
  if (!Number.isFinite(quando)) return '';
  const min = Math.max(0, Math.round((agora - quando) / 60_000));
  if (min < 1) return t('quadro.lista.agora');
  if (min < 60) return t('quadro.lista.haMin', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('quadro.lista.haHoras', { n: h });
  const d = Math.round(h / 24);
  return d === 1 ? t('quadro.lista.ontem') : t('quadro.lista.haDias', { n: d });
}
