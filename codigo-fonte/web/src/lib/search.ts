const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Nota de um texto na busca rápida: todas as palavras precisam aparecer (sem acento, sem caixa). -1 = não serve;
 * 2 = o texto começa com a primeira palavra; 1 = alguma palavra do texto começa com ela; 0 = aparece no meio.
 */
export function rank(q: string, text: string): number {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const t = fold(text);
  if (!words.length || !words.every((w) => t.includes(w))) return -1;
  return t.startsWith(words[0]) ? 2 : t.split(/[^a-z0-9#]+/).some((p) => p.startsWith(words[0])) ? 1 : 0;
}
