// Realce de código mínimo para a prévia de arquivo (sem biblioteca): comentários, textos, números e palavras-chave.
// Só gera pedaços de texto com uma classe; o React escapa tudo.
export type Pedaco = { t: string; c?: 'com' | 'str' | 'num' | 'kw' };

// i18n-ok: as palavras-chave das linguagens (código, não texto de tela)
const KW: Record<string, string> = {
  // i18n-ok: palavras-chave
  js: 'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false this',
  // i18n-ok: palavras-chave
  ts: 'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false this interface type enum implements readonly as keyof',
  // i18n-ok: palavras-chave
  py: 'def return if elif else for while in not and or is None True False class import from as with try except finally raise lambda yield async await pass break continue global',
  // i18n-ok: palavras-chave
  sql: 'select from where and or not insert into values update set delete create table index join left right inner outer on group by order having limit as distinct null is in like between case when then else end',
  // i18n-ok: palavras-chave
  sh: 'if then else fi for do done while case esac function in export local return echo',
};
const COMENTARIO: Record<string, RegExp> = { py: /#[^\n]*/y, sh: /#[^\n]*/y, sql: /--[^\n]*/y, yaml: /#[^\n]*/y };

export function realcar(codigo: string, lang: string): Pedaco[] {
  const kw = new Set((KW[lang] ?? KW.ts).split(' '));
  const sqlish = lang === 'sql';
  const out: Pedaco[] = [];
  let i = 0; let texto = '';
  const solta = () => { if (texto) { out.push({ t: texto }); texto = ''; } };
  const tenta = (re: RegExp, c: Pedaco['c']) => { re.lastIndex = i; const m = re.exec(codigo); if (m && m.index === i && m[0]) { solta(); out.push({ t: m[0], c }); i += m[0].length; return true; } return false; };
  while (i < codigo.length) {
    if ((COMENTARIO[lang] && tenta(COMENTARIO[lang], 'com')) || (!COMENTARIO[lang] && (tenta(/\/\/[^\n]*/y, 'com') || tenta(/\/\*[\s\S]*?(\*\/|$)/y, 'com')))) continue;
    if (tenta(/"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y, 'str')) continue;
    if (tenta(/\b\d[\d_.]*(e[+-]?\d+)?\b/iy, 'num')) continue;
    const w = /[A-Za-z_]\w*/y; w.lastIndex = i; const m = w.exec(codigo);
    if (m && m.index === i) { if (kw.has(sqlish ? m[0].toLowerCase() : m[0])) { solta(); out.push({ t: m[0], c: 'kw' }); } else texto += m[0]; i += m[0].length; continue; }
    texto += codigo[i++];
  }
  solta();
  return out;
}
