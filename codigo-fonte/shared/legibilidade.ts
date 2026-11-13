// Cores ilegíveis em pacotes da comunidade (skins, temas da cidade e equipes) são corrigidas sozinhas, em vez de o
// pacote ser recusado: o sistema segue a forma, não o conteúdo (decisão 13 do plano de contraste). O validador
// (server/src/services/ergon-package.ts) chama legibilizarPacote, guarda a versão corrigida e devolve a lista do que
// ajustou, que a prévia da loja mostra. A Cidade aplica a mesma correção na hora de desenhar (web/src/iso/skin.ts), o
// que cobre também as skins oficiais e o que já estava instalado.
//
// O que é corrigido, e como (sempre mexendo só na luz do fundo, o tom fica):
//   - etiquetas da Cidade: o texto (a cor de contorno) sobre o papiro (os dois tons) e sobre o laranja de
//     "esperando você" ≥ 4,5:1;
//   - tema da cidade que troca o contorno: o contorno escurece ou clareia até se ler sobre o papiro e o laranja;
//   - cor de agente de uma equipe em que nem a letra escura nem a branca chega a 4,5:1 (readableOn).
import { MIN_TEXTO, contrast, ensureContrast, readableOn } from './contraste.ts';
import { deriveThemeColors, type SkinData } from './skin.ts';

export type ModoDaCidade = 'dia' | 'noite';
export interface AjusteDeCor {
  /** etiqueta (papiro), espera (o laranja de "esperando você"), contorno (o texto da etiqueta) ou retrato (cor de agente) */
  onde: 'etiqueta' | 'espera' | 'contorno' | 'retrato';
  de: string;
  para: string;
  tema?: ModoDaCidade;
  /** o agente, quando é retrato */
  quem?: string;
}

/** As cores de fábrica das etiquetas da Cidade (web/src/iso/theme.ts; o teste da Cidade confere que batem). */
export const ETIQUETAS_DE_FABRICA: Record<ModoDaCidade, { outline: string; papyrus: [string, string]; marks: { attention: string; working: string; waiting: string; select: string } }> = {
  dia: { outline: '#2a2230', papyrus: ['#f3e7c3', '#d4c294'], marks: { attention: '#e3b341', working: '#4a9d91', waiting: '#e07b52', select: '#2f7f75' } },
  noite: { outline: '#16111d', papyrus: ['#ecdfb9', '#c9b88b'], marks: { attention: '#e3b341', working: '#73b6aa', waiting: '#e07b52', select: '#73b6aa' } },
};

const HEX6 = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown): v is string => typeof v === 'string' && HEX6.test(v);
const par = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && hex(v[0]) && hex(v[1]);

/**
 * Etiqueta da Cidade legível: o texto (contorno) sobre os dois tons de papiro e sobre o laranja de espera, ≥ 4,5:1.
 * Ajusta o fundo da etiqueta (só a luz); o contorno, que desenha a cidade inteira, fica.
 */
export function etiquetasLegiveis(outline: string, papyrus: [string, string], waiting: string, tema?: ModoDaCidade):
  { papyrus: [string, string]; waiting: string; ajustes: AjusteDeCor[] } {
  const ajustes: AjusteDeCor[] = [];
  const fundo = (c: string, onde: AjusteDeCor['onde']) => {
    if (contrast(outline, c) >= MIN_TEXTO) return c;
    const novo = ensureContrast(outline, c);
    ajustes.push({ onde, de: c, para: novo, ...(tema ? { tema } : {}) });
    return novo;
  };
  return { papyrus: [fundo(papyrus[0], 'etiqueta'), fundo(papyrus[1], 'etiqueta')], waiting: fundo(waiting, 'espera'), ajustes };
}

/** Skin: as etiquetas de dia e de noite se leem; a correção vai para `palette[modo].colors` (o lugar de acertar cor). */
export function legibilizarSkin(skin: SkinData): { skin: SkinData; ajustes: AjusteDeCor[] } {
  const out = structuredClone(skin);
  const ajustes: AjusteDeCor[] = [];
  for (const tema of ['dia', 'noite'] as const) {
    const spec = out.palette[tema]; if (!spec?.seeds) continue;
    const fab = ETIQUETAS_DE_FABRICA[tema];
    const d: Record<string, unknown> = { ...deriveThemeColors(spec.seeds), ...(spec.colors ?? {}) };
    const outline = hex(d.outline) ? d.outline : fab.outline;
    const papiro = par(d.papyrus) ? d.papyrus : fab.papyrus;
    const marks = d.marks && typeof d.marks === 'object' ? d.marks as Record<string, unknown> : null;
    const espera = hex(marks?.waiting) ? marks.waiting as string : fab.marks.waiting;
    const r = etiquetasLegiveis(outline, papiro, espera, tema);
    if (!r.ajustes.length) continue;
    ajustes.push(...r.ajustes);
    const colors: Record<string, unknown> = { ...(spec.colors ?? {}) };
    if (r.papyrus[0] !== papiro[0] || r.papyrus[1] !== papiro[1]) colors.papyrus = r.papyrus;
    // as marcas vão inteiras (a Cidade troca o objeto todo): as de fábrica, as da skin por cima e o laranja corrigido
    if (r.waiting !== espera) colors.marks = { ...fab.marks, ...(marks ?? {}), waiting: r.waiting };
    spec.colors = colors;
  }
  return { skin: out, ajustes };
}

/** Tema da cidade (cores sobre o dia ou a noite): se ele troca o contorno, o contorno passa a se ler nas etiquetas. */
export function legibilizarTemaDaCidade(theme: { base: ModoDaCidade; colors: Record<string, string> }): { theme: typeof theme; ajustes: AjusteDeCor[] } {
  const fab = ETIQUETAS_DE_FABRICA[theme.base] ?? ETIQUETAS_DE_FABRICA.dia;
  const original = theme.colors.outline;
  if (!hex(original)) return { theme, ajustes: [] };
  const fundos = [...fab.papyrus, fab.marks.waiting];
  let o = original;
  // escurecer (ou clarear) para um fundo nunca desfaz o outro: os três são claros; duas voltas bastam
  for (let i = 0; i < 2; i++) for (const f of fundos) if (contrast(o, f) < MIN_TEXTO) o = ensureContrast(f, o);
  if (o === original.toLowerCase() || o === original) return { theme, ajustes: [] };
  return { theme: { ...theme, colors: { ...theme.colors, outline: o } }, ajustes: [{ onde: 'contorno', de: original, para: o, tema: theme.base }] };
}

/** Equipe: cor de agente em que nenhuma letra (escura ou branca) se lê vira o mesmo tom com outra luz. */
export function legibilizarEquipe<T extends { agents?: Array<{ name?: string; color?: string | null }> }>(bp: T): { blueprint: T; ajustes: AjusteDeCor[] } {
  const ajustes: AjusteDeCor[] = [];
  if (!Array.isArray(bp?.agents)) return { blueprint: bp, ajustes };
  const agents = bp.agents.map((a) => {
    const r = a && typeof a.color === 'string' ? readableOn(a.color) : null;
    if (!r?.adjusted) return a;
    ajustes.push({ onde: 'retrato', de: a.color as string, para: r.bg, ...(a.name ? { quem: a.name } : {}) });
    return { ...a, color: r.bg };
  });
  return { blueprint: { ...bp, agents }, ajustes };
}

/** Os dados de um pacote com as cores que não se leem corrigidas, e a lista do que mudou (vazia: nada a ajustar). */
export function legibilizarPacote<D extends { skin?: SkinData; theme?: { base: ModoDaCidade; colors: Record<string, string> }; blueprint?: unknown }>(data: D): { data: D; ajustes: AjusteDeCor[] } {
  let out = data; const ajustes: AjusteDeCor[] = [];
  if (data.skin) { const r = legibilizarSkin(data.skin); if (r.ajustes.length) { out = { ...out, skin: r.skin }; ajustes.push(...r.ajustes); } }
  if (data.theme) { const r = legibilizarTemaDaCidade(data.theme); if (r.ajustes.length) { out = { ...out, theme: r.theme }; ajustes.push(...r.ajustes); } }
  if (data.blueprint && typeof data.blueprint === 'object') {
    const r = legibilizarEquipe(data.blueprint as { agents?: Array<{ name?: string; color?: string | null }> });
    if (r.ajustes.length) { out = { ...out, blueprint: r.blueprint }; ajustes.push(...r.ajustes); }
  }
  return { data: out, ajustes };
}
