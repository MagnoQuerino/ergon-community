/**
 * O idioma de um texto, pelas palavras de ligação (sem modelo): "the", "to", "my", "please" contra "o", "de", "para",
 * "que". Serve às conferências que valem nas duas línguas, para uma leitura do inglês não valer num texto em português
 * ("o post do Teams" não é "post on Teams") e vice-versa. Sem maioria clara: null (as duas leituras continuam valendo).
 * Ficam de fora as palavras das duas línguas ("a", "me", "as", "no", "do", "com" de ".com").
 */
const EN = new Set(['the', 'to', 'and', 'of', 'is', 'are', 'was', 'were', 'my', 'your', 'our', 'their', 'please', 'with', 'from', 'this', 'that', 'it',
  'for', 'on', 'in', 'you', 'i', 'we', 'can', 'could', 'would', 'be', 'have', 'has', 'will', 'what', 'how', 'an', 'at', 'by', 'about', 'all', 'any', 'there']);
const PT = new Set(['o', 'os', 'de', 'da', 'dos', 'das', 'que', 'e', 'para', 'pra', 'com', 'na', 'nos', 'nas', 'em', 'um', 'uma', 'por', 'meu', 'minha',
  'meus', 'minhas', 'voce', 'voces', 'se', 'nao', 'ao', 'aos', 'pelo', 'pela', 'esse', 'essa', 'isso', 'este', 'esta', 'eu', 'ele', 'ela', 'sobre', 'mais', 'foi']);

export type Idioma = 'pt' | 'en' | null;

export function idioma(texto: string): Idioma {
  let en = 0; let pt = 0;
  for (const bruto of texto.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().split(/\s+/)) {
    const w = bruto.replace(/^[^a-z]+|[^a-z]+$/g, '');
    if (!w || /[^a-z']/.test(w)) continue; // "monday.com", "e-mail": não são palavras de ligação
    if (EN.has(w)) en++;
    else if (PT.has(w)) pt++;
  }
  return en > pt ? 'en' : pt > en ? 'pt' : null;
}

/**
 * Nomes de aplicativos que também são palavras comuns do inglês: "the sales teams" (os times), "on Monday" (o dia),
 * "the notion that…" (a ideia), "linear growth". Num pedido, só valem como o aplicativo quando a forma não deixa dúvida:
 * "Microsoft Teams", a maiúscula da marca no texto original ("on Teams", "in Notion"), "monday.com", o lugar dito em
 * português ("no teams", "pelo monday": o dia em português é "segunda") ou o que é do aplicativo logo depois ("teams
 * chat", "notion page"). Fora disso, a palavra vira "xxxxx" no texto já dobrado (o comprimento não muda).
 */
const LUGAR_PT = /\b(no|na|nos|nas|pelo|pela|do|da|dos|das|ao|o|em|pro|pra|para o|para a|via)\s+$/;
const COMUM: Record<string, { lugarEn?: RegExp; depois: RegExp; maiuscula: boolean; marca?: RegExp }> = {
  teams: {
    maiuscula: true,
    lugarEn: /\b(on|via|through|using|over|into)\s+$|\b(messages?|chats?|conversations?|channels?|mensage(m|ns)|conversas?|canais|canal)\s+(in|on|from|do|no|pelo)\s+$/,
    depois: /^\s+(chats?|channels?|canal|canais|app|apps|messages?|conversations?|groups?|calls?|meetings?|mensage(m|ns)|conversas?|reuniao|reunioes|grupos?)\b/,
    marca: /\bmicrosoft\s+$/,
  },
  monday: {
    maiuscula: false, // "on Monday" vem com maiúscula: o dia da semana
    depois: /^(\.com\b|\s+(boards?|items?|workspaces?|accounts?|app|quadros?|itens))/,
  },
  notion: { maiuscula: true, depois: /^\s+(pages?|databases?|workspaces?|docs?|paginas?|bases?|notes?)\b/ },
  linear: { maiuscula: true, depois: /^\s+(issues?|projects?|boards?|tickets?|cycles?|workspaces?|team)\b/ },
};

/** O texto dobrado (fold) com as palavras comuns que não são o aplicativo trocadas por "x" (posições iguais às do original). */
export function semNomeComum(original: string, dobrado: string): string {
  if (original.length !== dobrado.length) return dobrado;
  return dobrado.replace(/\b(teams|monday|notion|linear)\b/g, (w, _g, at: number) => {
    const r = COMUM[w];
    const antes = dobrado.slice(Math.max(0, at - 40), at);
    const depois = dobrado.slice(at + w.length, at + w.length + 30);
    const orig = original.slice(at, at + w.length);
    if (r.marca?.test(antes)) return w;
    if (/^\s+of\b/.test(depois) && !/^[A-Z]/.test(orig)) return 'x'.repeat(w.length);
    if (r.maiuscula && /^[A-Z]/.test(orig)) return w;
    if (r.depois.test(depois)) return w;
    if (LUGAR_PT.test(antes)) return w;
    if (r.lugarEn?.test(antes)) return w;
    return 'x'.repeat(w.length);
  });
}
