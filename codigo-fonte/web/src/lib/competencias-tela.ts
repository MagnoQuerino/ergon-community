// Treinar › competências (rc.29): a conta das telas da loja e das competências instaladas, sem React, para testar.
// Só dados e regras; os textos vêm do dicionário (i18n/pt/agente.ts).
import type { AgentSkill, Skill } from './types.ts';
import type { CompetenciaLoja } from './recursos.ts';

/** De onde veio: as quatro da biblioteca da equipe e as aprendidas no Treinar (só deste agente). */
export type Origem = 'equipe' | 'loja' | 'enviada' | 'criada' | 'treinar';
export const ORIGENS: readonly Origem[] = ['equipe', 'loja', 'enviada', 'criada', 'treinar'];

export interface Instalada {
  /** a chave única na lista (o nome da biblioteca, ou "treinar:" + id) */
  chave: string;
  nome: string;
  titulo: string;
  descricao: string;
  origem: Origem;
  /** ligada (e, se for do Treinar, ativa) neste agente */
  ligada: boolean;
  /** a do Treinar, com versões e ações próprias */
  treino?: AgentSkill;
}

/** "excel-author" → "Excel author": o nome técnico lido como nome. */
export function nomeLegivel(nome: string): string {
  const s = nome.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : nome;
}

/** A biblioteca da equipe e as do Treinar deste agente numa lista só; as ligadas primeiro, depois pelo nome. */
export function instaladas(biblioteca: readonly Skill[], ligadas: readonly string[], treinadas: readonly AgentSkill[]): Instalada[] {
  const deste = new Set(ligadas);
  const lib: Instalada[] = biblioteca.map((s) => ({
    chave: s.name, nome: s.name, titulo: nomeLegivel(s.name), descricao: s.description, origem: s.origem ?? 'equipe', ligada: deste.has(s.name),
  }));
  const tr: Instalada[] = treinadas.filter((s) => s.status !== 'removida').map((s) => ({
    chave: `treinar:${s.id}`, nome: s.name, titulo: s.title, descricao: s.description, origem: 'treinar', ligada: s.status === 'ativa', treino: s,
  }));
  return [...tr, ...lib].sort((a, b) => Number(b.ligada) - Number(a.ligada) || a.titulo.localeCompare(b.titulo));
}

/** Sem acento e em minúsculas, para a busca achar "reuniao" em "Reunião". */
export const dobrar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const casa = (busca: string, ...campos: string[]) => {
  const termos = dobrar(busca).split(/\s+/).filter(Boolean);
  const alvo = dobrar(campos.join(' '));
  return termos.every((t) => alvo.includes(t));
};

export interface FiltroInstaladas { busca: string; de: 'agente' | 'equipe'; origem: Origem | 'todas' }
/** "deste agente": só as ligadas nele; "equipe toda": a biblioteca inteira e as do Treinar dele. */
export function filtrarInstaladas(itens: readonly Instalada[], f: FiltroInstaladas): Instalada[] {
  return itens.filter((i) => (f.de === 'equipe' || i.ligada || (i.origem === 'treinar'))
    && (f.origem === 'todas' || i.origem === f.origem)
    && (!f.busca.trim() || casa(f.busca, i.nome, i.titulo, i.descricao)));
}
/** Quantas de cada origem (para os filtros mostrarem só as que existem). */
export function contarOrigens(itens: readonly Instalada[]): Partial<Record<Origem, number>> {
  const out: Partial<Record<Origem, number>> = {};
  for (const i of itens) out[i.origem] = (out[i.origem] ?? 0) + 1;
  return out;
}

/** As que se removem da biblioteca: as enviadas e as da loja (as que vêm com a equipe só se desligam). */
export const removivel = (i: Instalada) => i.origem === 'enviada' || i.origem === 'loja';

// ---------------------------------------------------------------- loja
/** As que a pessoa costuma procurar primeiro (documentos de escritório, atas, revisão semanal). */
export const DESTAQUE = ['docx', 'xlsx', 'pdf', 'powerpoint', 'meeting-action-items', 'weekly-review-planning', 'document-to-action-items', 'excel-author', 'pptx-author'];

/** As categorias da vitrine, das que têm mais competências para as que têm menos. */
export function categoriasDaLoja(lista: readonly CompetenciaLoja[]): Array<{ categoria: string; n: number }> {
  const n = new Map<string, number>();
  for (const c of lista) if (c.categoria) n.set(c.categoria, (n.get(c.categoria) ?? 0) + 1);
  return [...n].map(([categoria, k]) => ({ categoria, n: k })).sort((a, b) => b.n - a.n || a.categoria.localeCompare(b.categoria));
}

export interface FiltroLoja { busca: string; categoria: string | null }
/** A vitrine: a busca local (enquanto a pessoa digita) e a categoria; as em destaque e as não instaladas primeiro. */
export function filtrarLoja(lista: readonly CompetenciaLoja[], f: FiltroLoja): CompetenciaLoja[] {
  return lista.filter((c) => (!f.categoria || c.categoria === f.categoria) && (!f.busca.trim() || casa(f.busca, c.nome, c.descricao, c.categoria)))
    .sort((a, b) => Number(a.instalada) - Number(b.instalada) || Number(DESTAQUE.includes(b.nome)) - Number(DESTAQUE.includes(a.nome)) || a.nome.localeCompare(b.nome));
}
/** Os destaques da vitrine (sem busca nem categoria): os conhecidos que ainda não estão instalados. */
export function destaques(lista: readonly CompetenciaLoja[], max = 4): CompetenciaLoja[] {
  return DESTAQUE.map((n) => lista.find((c) => c.nome === n && !c.instalada)).filter((c): c is CompetenciaLoja => !!c).slice(0, max);
}
/** A grade da vitrine: a lista sem os destaques (que aparecem à parte). O "Mostrar mais" conta o que falta nela. */
export function gradeDaLoja(lista: readonly CompetenciaLoja[], emDestaque: readonly CompetenciaLoja[]): CompetenciaLoja[] {
  return lista.filter((c) => !emDestaque.includes(c));
}
/** Selo de confiança: as oficiais e as de fontes confiáveis são "verificadas". */
export const verificada = (c: Pick<CompetenciaLoja, 'confianca'>) => c.confianca === 'builtin' || c.confianca === 'trusted';

/** O ícone de cada categoria (os nomes das categorias vêm da equipe de IA, em inglês). */
export function iconeDaCategoria(cat: string): string {
  const c = cat.toLowerCase();
  if (/financ|account|money/.test(c)) return 'coins';
  if (/research|search|science/.test(c)) return 'search';
  if (/creative|design|media|image|video|art/.test(c)) return 'palette';
  if (/data|analy|ml|stat/.test(c)) return 'chart';
  if (/dev|software|code|engineer|github/.test(c)) return 'code';
  if (/market|social|communic|email|sales/.test(c)) return 'megaphone';
  if (/secur|legal|compli/.test(c)) return 'shield';
  if (/health|bio|med/.test(c)) return 'flask';
  if (/product|office|doc|note/.test(c)) return 'file';
  if (/educ|learn|teach/.test(c)) return 'book';
  return 'bulb';
}

// ---------------------------------------------------------------- adicionar
/** O arquivo que a pessoa escolheu é uma competência pronta (e não material de estudo). */
export const ehArquivoDeCompetencia = (nome: string) => /(^|[\\/])skill\.md$/i.test(nome) || /\.zip$/i.test(nome);
/** O tipo de envio pelo nome do arquivo: texto (SKILL.md ou outro .md/.txt) ou pasta compactada. */
export const tipoDoArquivo = (nome: string): 'zip' | 'texto' | null => (/\.zip$/i.test(nome) ? 'zip' : /\.(md|markdown|txt)$/i.test(nome) ? 'texto' : null);
