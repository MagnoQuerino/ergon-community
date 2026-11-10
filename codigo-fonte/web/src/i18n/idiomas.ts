// Os idiomas da tela. Um idioma novo: acrescentar aqui, criar a pasta dele (copiar en/ e traduzir) e juntá-la em
// index.ts. O TypeScript acusa qualquer chave que faltar.

export type Idioma = 'pt-BR' | 'en';
export const IDIOMAS: readonly Idioma[] = ['pt-BR', 'en'];
export const IDIOMA_PADRAO: Idioma = 'pt-BR';

/**
 * O inglês só aparece para a pessoa quando todas as telas estiverem traduzidas. Enquanto for false: o seletor de idioma
 * fica escondido e o idioma do navegador não troca nada (a tela abre em português). Uma escolha já guardada continua
 * valendo (é como as equipes de tradução conferem o inglês: localStorage 'ergon.idioma' = 'en').
 */
export const IDIOMA_INGLES_LIBERADO = true;

/** O nome de cada idioma escrito nele mesmo (igual nas duas telas: quem não lê a língua atual acha a sua). */
export const NOME_DO_IDIOMA: Record<Idioma, string> = { 'pt-BR': 'Português', en: 'English' };

export const ehIdioma = (v: unknown): v is Idioma => v === 'pt-BR' || v === 'en';

/** O idioma que um navegador pede: português se a língua dele começa com "pt"; inglês nos outros casos. */
export function idiomaDoNavegador(lingua: string | null | undefined): Idioma {
  return /^pt\b/i.test((lingua ?? '').trim()) ? 'pt-BR' : 'en';
}
