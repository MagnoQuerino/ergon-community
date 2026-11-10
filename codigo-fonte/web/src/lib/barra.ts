// Barra de cima da Cidade: o que se escolhe (estruturas), o que se acompanha (indicadores) e as ferramentas, tudo em
// pílulas do mesmo tamanho. Faltando espaço, a barra se adapta em degraus, sem empilhar nem deformar:
//   0. tudo com texto;
//   1. as ferramentas ficam só com o ícone (o nome segue no title e no aria-label);
//   2. os indicadores ficam compactos (ícone + número);
//   3. as ferramentas entram no botão "Mais";
//   4. janela de celular: o Localizar fica só com o ícone (o nome segue no aria-label);
//   5. último recurso (janela bem estreita, 320 px): o indicador de menor prioridade (entregas) entra no "Mais".
// A decisão é pura (testável); quem mede é o componente (CityBar.tsx), antes de pintar. Os textos saem no idioma atual
// (quem chama redesenha na troca: CityBar e AmbienteView usam useT()).
import { fmtNumero, t } from '../i18n/index.ts';

export const NIVEL_MAX = 5;

/** O próximo degrau: sobe enquanto o que a barra precisa não cabe no que ela tem. */
export function proximoNivel(nivel: number, precisa: number, tem: number): number {
  return precisa > tem + 0.5 && nivel < NIVEL_MAX ? nivel + 1 : nivel;
}

/** Modo da cidade: um botão só, com ícone próprio (nada a ver com o Modo Foco). */
export interface ModoCidade { icon: 'walk' | 'stand'; label: string; title: string }
export function modoCidade(calmo: boolean): ModoCidade {
  return calmo
    ? { icon: 'stand', label: t('cidade.barra.modoCalmo'), title: t('cidade.barra.modoCalmoDica') }
    : { icon: 'walk', label: t('cidade.barra.cidadeViva'), title: t('cidade.barra.cidadeVivaDica') };
}

/** Degrau 5: os indicadores que ficam à vista e os que entram no menu "Mais" (só as entregas; o resto nunca sai). */
export function noMenuMais<T extends { key: string }>(track: T[], nivel: number): [T[], T[]] {
  if (nivel < 5) return [track, []];
  return [track.filter((t) => t.key !== 'entregas'), track.filter((t) => t.key === 'entregas')];
}

/** O que a barra acompanha (o resumo do trabalho da equipe). */
export interface Indicador { key: 'trabalho' | 'voce' | 'entregas'; icon: string; texto: string; curto: string; title: string; atencao?: boolean }
export function indicadores(o: { busy: number; limit: number | null; decisoes: number; entregas: number }): Indicador[] {
  const out: Indicador[] = [{
    key: 'trabalho', icon: 'layers', curto: fmtNumero(o.busy), title: t('cidade.barra.emAndamentoDica'),
    texto: o.limit !== null ? t('cidade.barra.emAndamentoDe', { n: o.busy, limite: fmtNumero(o.limit) }) : t('cidade.barra.emAndamento', { n: o.busy }),
  }];
  if (o.decisoes > 0) out.push({ key: 'voce', icon: 'bell', texto: t('cidade.barra.precisaDeVoce', { n: o.decisoes }), curto: fmtNumero(o.decisoes), title: t('cidade.barra.precisaDeVoceDica'), atencao: true });
  if (o.entregas > 0) out.push({ key: 'entregas', icon: 'check', texto: t('cidade.barra.entregas', { n: o.entregas }), curto: fmtNumero(o.entregas), title: t('cidade.barra.entregasDica') });
  return out;
}

/** O endereço pede os créditos da música (#configuracao?creditos), sem confundir com outra palavra que comece igual. */
export const pedeCreditos = (hash: string) => /[?&]creditos(?:$|&)/.test(hash);
