// Os idiomas da tela. Um idioma novo: acrescentar aqui (a lista, o nome, a reserva e o locale), criar a pasta dele e
// juntá-la em index.ts (COMO-TRADUZIR.md). O português (pt/) é a origem e o inglês (en/) é completo, conferido pelo
// TypeScript. Os outros podem ser PARCIAIS: a chave que ainda não tem tradução cai na reserva (o inglês), nunca na
// chave crua; completude.test.ts mede o que cada um já cobre e exige as áreas principais.

export type Idioma = 'pt-BR' | 'en' | 'en-IN' | 'zh-CN' | 'hi';
/** A ordem do seletor. A mesma lista no servidor (server/src/services/prefs.ts): seletor.test.ts confere. */
export const IDIOMAS: readonly Idioma[] = ['pt-BR', 'en', 'en-IN', 'zh-CN', 'hi'];
export const IDIOMA_PADRAO: Idioma = 'pt-BR';

/** O nome de cada idioma escrito nele mesmo (igual em todas as telas: quem não lê a língua atual acha a sua). */
export const NOME_DO_IDIOMA: Record<Idioma, string> = { 'pt-BR': 'Português', en: 'English', 'en-IN': 'English (India)', 'zh-CN': '简体中文', hi: 'हिन्दी' };

/**
 * De onde vem o texto que o idioma ainda não tem: en-IN usa o inglês inteiro (só número, data e moeda mudam: lakh e
 * crore); chinês e hindi, o inglês. O português e o inglês são completos (null: não precisam).
 */
export const RESERVA: Record<Idioma, Idioma | null> = { 'pt-BR': null, en: null, 'en-IN': 'en', 'zh-CN': 'en', hi: 'en' };

/** O locale do Intl: números, datas, moeda e plural. hi-IN e en-IN agrupam em lakh e crore (12,34,567). */
export const LOCALE: Record<Idioma, string> = { 'pt-BR': 'pt-BR', en: 'en', 'en-IN': 'en-IN', 'zh-CN': 'zh-CN', hi: 'hi-IN' };

/** A fonte que o idioma pede além das do sistema (carregada só quando o idioma é escolhido: lib/fontes.ts). */
export const ESCRITA: Record<Idioma, 'latina' | 'cjk' | 'devanagari'> = { 'pt-BR': 'latina', en: 'latina', 'en-IN': 'latina', 'zh-CN': 'cjk', hi: 'devanagari' };

const TODOS = new Set<string>(IDIOMAS);
export const ehIdioma = (v: unknown): v is Idioma => typeof v === 'string' && TODOS.has(v);

/** Para o que só existe em português e inglês (os termos de uso, os textos do World): o português ou o inglês. */
export const textoEm = (l: Idioma): 'pt-BR' | 'en' => (l === 'pt-BR' ? 'pt-BR' : 'en');

// as línguas da Índia que ainda não têm tela própria: quem as usa no sistema lê o inglês da Índia (lakh, crore, ₹)
const DA_INDIA = /^(bn|mr|ta|te|gu|kn|ml|pa|or|as|ur|ne|sa|kok|mai|sd)\b/i;

/**
 * O idioma do sistema ou do navegador no primeiro uso (antes de qualquer escolha). Aceita uma língua ("pt-BR") ou a
 * lista do navegador (navigator.languages): vale a primeira que a tela sabe falar.
 *   pt* → Português · zh* → 简体中文 (o chinês tradicional lê o simplificado melhor que o inglês) · hi* → हिन्दी ·
 *   en-IN e as outras línguas da Índia → English (India) · o resto → English.
 */
export function idiomaDoNavegador(linguas: string | readonly (string | null | undefined)[] | null | undefined): Idioma {
  const lista = (Array.isArray(linguas) ? linguas : [linguas]).map((l) => String(l ?? '').trim()).filter(Boolean);
  for (const l of lista) {
    if (/^pt\b/i.test(l)) return 'pt-BR';
    if (/^zh\b/i.test(l)) return 'zh-CN';
    if (/^hi\b/i.test(l)) return 'hi';
    if (/^en-IN\b/i.test(l) || DA_INDIA.test(l)) return 'en-IN';
    if (/^en\b/i.test(l)) return 'en';
  }
  return 'en';
}
