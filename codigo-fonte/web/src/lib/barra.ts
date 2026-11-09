// Barra de cima da Cidade: o que se escolhe (estruturas), o que se acompanha (indicadores) e as ferramentas, tudo em
// pílulas do mesmo tamanho. Faltando espaço, a barra se adapta em degraus, sem empilhar nem deformar:
//   0. tudo com texto;
//   1. as ferramentas ficam só com o ícone (o nome segue no title e no aria-label);
//   2. os indicadores ficam compactos (ícone + número);
//   3. as ferramentas entram no botão "Mais";
//   4. janela de celular: o Localizar fica só com o ícone (o nome segue no aria-label);
//   5. último recurso (janela bem estreita, 320 px): o indicador de menor prioridade (entregas) entra no "Mais".
// A decisão é pura (testável); quem mede é o componente (CityBar.tsx), antes de pintar.

export const NIVEL_MAX = 5;

/** O próximo degrau: sobe enquanto o que a barra precisa não cabe no que ela tem. */
export function proximoNivel(nivel: number, precisa: number, tem: number): number {
  return precisa > tem + 0.5 && nivel < NIVEL_MAX ? nivel + 1 : nivel;
}

/** Modo da cidade: um botão só, com ícone próprio (nada a ver com o Modo Foco). */
export interface ModoCidade { icon: 'walk' | 'stand'; label: string; title: string }
export function modoCidade(calmo: boolean): ModoCidade {
  return calmo
    ? { icon: 'stand', label: 'Modo calmo', title: 'Modo calmo: sem passeios nem lazer; o trabalho, as etiquetas e as decisões continuam à vista. Clique para a cidade viva.' }
    : { icon: 'walk', label: 'Cidade viva', title: 'Cidade viva: passeios e lazer. Clique para o modo calmo (menos movimento, o trabalho continua à vista).' };
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
    key: 'trabalho', icon: 'layers', texto: `${o.busy} em andamento${o.limit !== null ? ` de ${o.limit}` : ''}`, curto: String(o.busy),
    title: 'Central de Trabalho: o que está em andamento, o que espera e por quê',
  }];
  if (o.decisoes > 0) out.push({ key: 'voce', icon: 'bell', texto: `${o.decisoes} precisa${o.decisoes === 1 ? '' : 'm'} de você`, curto: String(o.decisoes), title: 'Aguardando você: responder, aprovar ou devolver', atencao: true });
  if (o.entregas > 0) out.push({ key: 'entregas', icon: 'check', texto: `${o.entregas} entrega${o.entregas === 1 ? '' : 's'}`, curto: String(o.entregas), title: 'Entregas recentes' });
  return out;
}

/** O endereço pede os créditos da música (#configuracao?creditos), sem confundir com outra palavra que comece igual. */
export const pedeCreditos = (hash: string) => /[?&]creditos(?:$|&)/.test(hash);
