/**
 * Entregáveis (rc.42): como um documento .md aparece na tela, no papel e no PDF. O arquivo continua Markdown puro; o
 * que muda é a leitura — a identidade do workspace (nome, cores, logo) e o modelo de documento (margens, fonte,
 * cabeçalho, rodapé, paginação, capa, regras ABNT). A tela (web) e o PDF (servidor) leem daqui as mesmas regras, para o
 * que se vê ser o que se imprime.
 */

export type Fonte = 'sans' | 'serif';
export type Paginacao = 'nenhuma' | 'rodape' | 'topo';

export interface Identidade {
  /** nome da empresa ou marca (vazio: só o logo, ou o Ergon) */
  nome: string;
  /** cor dos títulos e dos detalhes (#rrggbb) */
  corPrimaria: string;
  /** cor de destaque: fio do cabeçalho, marcador da citação */
  corDestaque: string;
  /** há logo próprio enviado (a imagem fica no servidor) */
  logo: { w: number; h: number; versao: string } | null;
  /** o emblema do Ergon no cabeçalho (desligável) */
  mostrarErgon: boolean;
}

export interface Capa {
  ligada: boolean;
  instituicao: string;
  autor: string;
  subtitulo: string;
  local: string;
  ano: string;
}

export interface ModeloDoc {
  id: string;
  nome: string;
  /** de onde veio (o original de que foi copiado) */
  base: 'ergon' | 'abnt' | 'livre';
  fonte: Fonte;
  /** em pontos */
  tamanho: number;
  entrelinha: number;
  /** em centímetros */
  margens: { topo: number; direita: number; base: number; esquerda: number };
  cabecalho: { mostrar: boolean; texto: string; logo: boolean };
  rodape: { mostrar: boolean; texto: string };
  paginacao: Paginacao;
  /** a partir de que página o número aparece (ABNT: conta desde a capa, mostra depois dela) */
  numeroDesde: number;
  capa: Capa;
  /** 1, 1.1, 1.1.1 nos títulos */
  numerarTitulos: boolean;
  /** recuo de 1,25 cm na primeira linha do parágrafo */
  recuo: boolean;
  justificar: boolean;
  /** citação longa ABNT: recuo de 4 cm, letra menor, espaço simples */
  citacaoAbnt: boolean;
  /** original do Ergon (não muda; dá para copiar) */
  original?: boolean;
}

export const ERGON_CORES = { primaria: '#1D184B', destaque: '#B88B5B', tinta: '#1d2a33', suave: '#686760', linha: '#e3d9c8', fundoTabela: '#f8f3ea' } as const;

export const IDENTIDADE_PADRAO: Identidade = { nome: '', corPrimaria: ERGON_CORES.primaria, corDestaque: ERGON_CORES.destaque, logo: null, mostrarErgon: true };

const CAPA_VAZIA: Capa = { ligada: false, instituicao: '', autor: '', subtitulo: '', local: '', ano: '' };

/** Os originais: o padrão do Ergon e o ABNT (NBR 14724: margens 3/2/3/2, 12 pt, 1,5, número no alto à direita). */
export const MODELOS_ORIGINAIS: readonly ModeloDoc[] = [
  {
    id: 'ergon', nome: 'Ergon', base: 'ergon', fonte: 'sans', tamanho: 11, entrelinha: 1.45,
    margens: { topo: 2.5, direita: 2.2, base: 2.2, esquerda: 2.2 },
    cabecalho: { mostrar: true, texto: '{empresa}', logo: true }, rodape: { mostrar: true, texto: '{titulo}' },
    paginacao: 'rodape', numeroDesde: 1, capa: CAPA_VAZIA, numerarTitulos: false, recuo: false, justificar: false, citacaoAbnt: false, original: true,
  },
  {
    id: 'abnt', nome: 'ABNT', base: 'abnt', fonte: 'serif', tamanho: 12, entrelinha: 1.5,
    margens: { topo: 3, direita: 2, base: 2, esquerda: 3 },
    cabecalho: { mostrar: false, texto: '', logo: false }, rodape: { mostrar: false, texto: '' },
    paginacao: 'topo', numeroDesde: 2, capa: { ...CAPA_VAZIA, ligada: true }, numerarTitulos: true, recuo: true, justificar: true, citacaoAbnt: true, original: true,
  },
];

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, min: number, max: number, def: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : def;
};
const txt = (v: unknown, max: number, def = '') => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : def);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

export const cor = (v: unknown, def: string): string => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : def);

/** Qualquer entrada vira um modelo válido (o que falta vem do original da base). */
export function normalizarModelo(x: Record<string, unknown>, id: string): ModeloDoc {
  const base = x.base === 'abnt' || x.base === 'livre' ? x.base : 'ergon';
  const o = MODELOS_ORIGINAIS.find((m) => m.id === (base === 'livre' ? 'ergon' : base))!;
  const m = (x.margens ?? {}) as Record<string, unknown>;
  const c = (x.cabecalho ?? {}) as Record<string, unknown>;
  const r = (x.rodape ?? {}) as Record<string, unknown>;
  const k = (x.capa ?? {}) as Record<string, unknown>;
  return {
    id, nome: txt(x.nome, 60) || o.nome, base,
    fonte: x.fonte === 'serif' || x.fonte === 'sans' ? x.fonte : o.fonte,
    tamanho: num(x.tamanho, 9, 16, o.tamanho), entrelinha: num(x.entrelinha, 1, 2.5, o.entrelinha),
    margens: { topo: num(m.topo, 1, 5, o.margens.topo), direita: num(m.direita, 1, 5, o.margens.direita), base: num(m.base, 1, 5, o.margens.base), esquerda: num(m.esquerda, 1, 5, o.margens.esquerda) },
    cabecalho: { mostrar: bool(c.mostrar, o.cabecalho.mostrar), texto: txt(c.texto, 120, o.cabecalho.texto), logo: bool(c.logo, o.cabecalho.logo) },
    rodape: { mostrar: bool(r.mostrar, o.rodape.mostrar), texto: txt(r.texto, 120, o.rodape.texto) },
    paginacao: x.paginacao === 'nenhuma' || x.paginacao === 'rodape' || x.paginacao === 'topo' ? x.paginacao : o.paginacao,
    numeroDesde: Math.round(num(x.numeroDesde, 1, 5, o.numeroDesde)),
    capa: { ligada: bool(k.ligada, o.capa.ligada), instituicao: txt(k.instituicao, 160), autor: txt(k.autor, 160), subtitulo: txt(k.subtitulo, 200), local: txt(k.local, 80), ano: txt(k.ano, 10) },
    numerarTitulos: bool(x.numerarTitulos, o.numerarTitulos), recuo: bool(x.recuo, o.recuo), justificar: bool(x.justificar, o.justificar), citacaoAbnt: bool(x.citacaoAbnt, o.citacaoAbnt),
  };
}

/** "{empresa} · {titulo}" → texto do cabeçalho/rodapé. */
export function preencher(modelo: string, v: { titulo: string; empresa: string; data: string }): string {
  return modelo.replace(/\{(titulo|empresa|data)\}/g, (_, k: 'titulo' | 'empresa' | 'data') => v[k]).replace(/\s*[·|-]\s*$/, '').replace(/^\s*[·|-]\s*/, '').trim();
}

/** Título do documento: o primeiro # do texto, senão o nome do arquivo sem a extensão e sem o código da execução. */
export function tituloDoDocumento(md: string, filename: string): string {
  const h = md.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1];
  if (h) return h.replace(/[*_`]/g, '').trim().slice(0, 200);
  return filename.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/-[0-9a-f]{8}$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 200) || filename;
}

/** Seção de referências (ABNT: alinhada à esquerda, espaço simples, separadas por uma linha em branco). */
export const REFERENCIAS = /^(refer[êe]ncias(\s+bibliogr[áa]ficas)?|bibliografia|references)$/i;

/** Numeração progressiva dos títulos (NBR 6024): o # do título do documento fica de fora; ## vira 1, ### vira 1.1. */
export function numeracao(levels: number[]): string[] {
  const top = levels.filter((l) => l > 1).length ? Math.min(...levels.filter((l) => l > 1)) : 2;
  const cont: number[] = [];
  return levels.map((l) => {
    if (l < top) return '';
    const d = l - top;
    cont.length = d + 1;
    cont[d] = (cont[d] ?? 0) + 1;
    for (let i = 0; i < d; i++) cont[i] ??= 1;
    return cont.slice(0, d + 1).join('.');
  });
}

/** Cor legível sobre branco: abaixo de 4,5:1, os títulos ficam na tinta do Ergon (a marca segue nos detalhes). */
export function corDeTitulo(hex: string): string {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (lum + 0.05) >= 4.5 ? hex : ERGON_CORES.tinta;
}
