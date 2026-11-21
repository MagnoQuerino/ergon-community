/**
 * Blocos visuais (rc.42): o que o agente mostra embutido na conversa — métrica, gráfico, tabela, comparativo, prazo,
 * meta, enquete, relatório — como JSON declarativo, nunca HTML nem script. O mesmo formato vale na conversa direta,
 * nas salas, no diálogo de detalhes das entregas e no documento (.md): vai no próprio texto da mensagem, numa cerca
 *
 *     ```ergon-visual
 *     {"tipo":"kpi","rotulo":"Gastos de novembro","valor":18420.5,"formato":"moeda", "fontes":[...]}
 *     ```
 *
 * e por isso anda junto com o texto em tudo que já carrega mensagens (a sincronia das salas e do World, a busca, a cópia).
 * Este módulo é puro (sem Node nem DOM): o servidor valida e normaliza com ele, a tela desenha a partir do resultado, o
 * fallback em texto e o PNG dos canais saem dele. Ver docs/BLOCOS-VISUAIS.md.
 */

import { PICTOGRAMAS, type Pictograma } from './pictogramas.ts';

/** O prefixo das cercas de bloco visual: ```ergon-<tipo> (a convenção dos blocos no Markdown, a mesma do documento dos
 * Entregáveis: web/src/lib/documento.ts, registrarBlocoVisual). O tipo com "_" vai com "-" (```ergon-linha-do-tempo). */
export const PREFIXO = 'ergon-';
/** A cerca genérica (o tipo dentro do JSON), aceita na leitura; a normalização grava a do tipo. */
export const CERCA = 'ergon-visual';
/** O voto de uma enquete é uma mensagem da pessoa com esta cerca (anda pela mesma sincronia das mensagens). */
export const CERCA_VOTO = 'ergon-voto';
/** limites: o JSON de um bloco, os blocos de uma mensagem, o total de JSON de uma mensagem */
export const LIMITES = { jsonBloco: 24_000, blocosPorMensagem: 8, jsonMensagem: 64_000, relatorioJson: 60_000 } as const;

// ------------------------------------------------------------------------------------------------- tipos

export type Formato = 'numero' | 'inteiro' | 'moeda' | 'percentual' | 'compacto' | 'data' | 'texto';
/** BRL, USD, EUR e, desde a rc.44, CNY (yuan) e INR (rupia; em en-IN e hi sai em lakh e crore) */
export type Moeda = 'BRL' | 'USD' | 'EUR' | 'CNY' | 'INR';
export type Tom = 'bom' | 'ruim' | 'atencao' | 'neutro' | 'marca';

/** De onde veio o dado: uma conexão (com a conta e o período), um documento, um site, um cálculo do agente, a conversa. */
export type TipoFonte = 'conexao' | 'documento' | 'site' | 'calculo' | 'conversa';
export interface Fonte { tipo: TipoFonte; titulo: string; url?: string; id?: string; periodo?: string }
/** O chip de um objeto citado (o mesmo formato das referências dos modelos de entrega). */
export interface Referencia { tipo: TipoRef; titulo: string; url: string | null; id: string | null }
export const TIPOS_REF = ['email', 'documento', 'arquivo', 'evento', 'tarefa', 'pr', 'issue', 'mensagem', 'conversa', 'card', 'pagina'] as const;
export type TipoRef = (typeof TIPOS_REF)[number];
/** Imagem: um arquivo dos Documentos (art_…) ou um endereço https (a tela busca pelo servidor, nunca direto). */
export interface Imagem { src: string; alt: string; legenda?: string }
/** O resumo ao lado do mini visual: número grande, até 3 linhas de destaque. */
export interface Lado { numero?: string; rotulo?: string; linhas?: string[] }

interface Base {
  titulo?: string; subtitulo?: string; nota?: string;
  fontes?: Fonte[];
  /** o agente declara que é estimativa: dispensa a fonte e aparece marcado */
  estimativa?: boolean;
  /** compacto: no tamanho de uma mensagem, com o resumo ao lado */
  lado?: Lado;
}
export interface DadosKpi { rotulo: string; valor: number; formato?: Formato; moeda?: Moeda; unidade?: string; variacao?: number; comparacao?: string; bom?: 'alta' | 'baixa'; meta?: number; serie?: number[] }
export interface Serie { nome: string; valores: Array<number | null> }
export interface Coluna { titulo: string; formato?: Formato; moeda?: Moeda; alinhar?: 'esquerda' | 'centro' | 'direita' }
export type Celula = string | number | null;
export type EstadoMarco = 'feito' | 'em_dia' | 'atrasado' | 'risco' | 'previsto';
export interface Marco { data: string; titulo: string; detalhe?: string; estado?: EstadoMarco }
export interface Opcao { nome: string; subtitulo?: string; valor?: number; pros?: string[]; contras?: string[]; recomendada?: boolean }
export interface Faixa { ate: number; tom: 'ruim' | 'ok' | 'bom'; rotulo?: string }
export interface Voto { opcao: number; quem: string }
export interface Secao { titulo: string; texto?: string; blocos?: Bloco[] }

export type Bloco = Base & (
  | ({ tipo: 'kpi' } & DadosKpi)
  | { tipo: 'kpis'; itens: DadosKpi[] }
  | { tipo: 'nota'; rotulo?: string; valor: number; escala?: number; legenda?: string }
  | { tipo: 'barras'; categorias: string[]; series: Serie[]; formato?: Formato; moeda?: Moeda; horizontal?: boolean; empilhado?: boolean; destaque?: number; meta?: number }
  | { tipo: 'linhas'; categorias: string[]; series: Serie[]; formato?: Formato; moeda?: Moeda; area?: boolean; meta?: number }
  | { tipo: 'pizza'; fatias: Array<{ rotulo: string; valor: number }>; rosca?: boolean; formato?: Formato; moeda?: Moeda; centro?: { valor: string; rotulo?: string } }
  | { tipo: 'tabela'; colunas: Coluna[]; linhas: Celula[][]; totais?: boolean | Celula[]; destaques?: Array<{ linha: number; coluna: number; tom: Tom }>; ordenavel?: boolean; negrito?: number[] }
  | { tipo: 'comparativo'; opcoes: Opcao[]; formato?: Formato; moeda?: Moeda }
  | { tipo: 'versus'; a: { rotulo: string; valor: number; legenda?: string }; b: { rotulo: string; valor: number; legenda?: string }; formato?: Formato; moeda?: Moeda; melhor?: 'a' | 'b'; pontas?: [string, string] }
  | { tipo: 'placar'; itens: Array<{ rotulo: string; nota: number }>; escala?: number }
  | { tipo: 'linha_do_tempo'; marcos: Marco[]; hoje?: string }
  | { tipo: 'progresso'; itens: Array<{ rotulo: string; atual: number; meta: number; formato?: Formato; moeda?: Moeda; prazo?: string }>; estilo?: 'barra' | 'anel' }
  | { tipo: 'checklist'; itens: Array<{ texto: string; estado: 'feito' | 'andamento' | 'pendente' | 'bloqueado' }> }
  | { tipo: 'status'; itens: Array<{ rotulo: string; estado: 'ok' | 'atencao' | 'erro' | 'parado'; detalhe?: string }> }
  | { tipo: 'semaforo'; itens: Array<{ rotulo: string; cor: 'verde' | 'amarelo' | 'vermelho'; detalhe?: string }> }
  | { tipo: 'pessoa'; nome: string; cargo?: string; empresa?: string; email?: string; telefone?: string; site?: string; local?: string; foto?: Imagem; tags?: string[] }
  | { tipo: 'aviso'; tom: 'info' | 'dica' | 'alerta' | 'risco' | 'sucesso'; texto: string }
  | { tipo: 'galeria'; imagens: Imagem[] }
  | { tipo: 'link'; url: string; descricao?: string; imagem?: string }
  | { tipo: 'arquivo'; id: string }
  | { tipo: 'mapa'; endereco: string; lat?: number; lng?: number }
  | { tipo: 'referencias'; itens: Referencia[] }
  | { tipo: 'ficha'; imagem?: Imagem; linhas: Array<{ parametro: string; valor: string; destaque?: boolean }>; cabecalho?: [string, string] }
  | { tipo: 'medidor'; valor: number; min?: number; max?: number; faixas?: Faixa[]; formato?: Formato; rotulo?: string; tendencia?: number; estilo?: 'arco' | 'termometro' }
  | { tipo: 'sparkline'; rotulo: string; serie: number[]; formato?: Formato; moeda?: Moeda; bom?: 'alta' | 'baixa' }
  | { tipo: 'icones'; valor: number; total: number; icone?: Pictograma; rotulo: string }
  | { tipo: 'funil'; etapas: Array<{ rotulo: string; valor: number }>; formato?: Formato; moeda?: Moeda }
  | { tipo: 'calor'; linhas: string[]; colunas: string[]; valores: number[][]; formato?: Formato }
  | { tipo: 'enquete'; id: string; pergunta: string; opcoes: string[]; votos?: Voto[]; encerrada?: boolean; decisao?: number; eleitores?: number }
  | { tipo: 'decisao'; escolha: string; votos?: number; total?: number; porque?: string; proximos?: string[] }
  | { tipo: 'matriz'; itens: Array<{ rotulo: string; x: number; y: number }>; eixos?: [string, string]; quadrantes?: [string, string, string, string] }
  | { tipo: 'fontes'; itens: Fonte[] }
  | { tipo: 'relatorio'; id: string; versao: number; resumo?: string; destaques?: Bloco[]; secoes: Secao[] }
);
export type TipoBloco = Bloco['tipo'];
export type BlocoDe<T extends TipoBloco> = Extract<Bloco, { tipo: T }>;

/** Os blocos de dado: sem fonte (ou "estimativa") o servidor recusa. */
export const PEDEM_FONTE: ReadonlySet<TipoBloco> = new Set<TipoBloco>(['kpi', 'kpis', 'nota', 'barras', 'linhas', 'pizza', 'tabela', 'comparativo', 'versus', 'placar',
  'linha_do_tempo', 'progresso', 'status', 'semaforo', 'ficha', 'medidor', 'sparkline', 'icones', 'funil', 'calor', 'matriz', 'relatorio']);

// ------------------------------------------------------------------------------------------------- validação

/** O que o servidor confere além da forma: o id interno existe neste workspace? */
export interface Conferencia { idValido?: (id: string) => boolean; dominios?: string[]; novoId?: () => string }
export type Resultado = { ok: true; bloco: Bloco; avisos: string[] } | { ok: false; erros: string[] };

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** uma linha de texto: sem quebra, sem caractere de controle, aparada */
const limpa = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
const DATA = /^\d{4}-\d{2}-\d{2}$/;
export const ID_INTERNO = /^(art|tsk|cnv)_[A-Za-z0-9_-]{6,64}$/;
const ID_ARQUIVO = /^art_[A-Za-z0-9_-]{6,64}$/;
const FORMATOS: readonly Formato[] = ['numero', 'inteiro', 'moeda', 'percentual', 'compacto', 'data', 'texto'];
const MOEDAS: readonly Moeda[] = ['BRL', 'USD', 'EUR', 'CNY', 'INR'];
const TIPOS_FONTE: readonly TipoFonte[] = ['conexao', 'documento', 'site', 'calculo', 'conversa'];

/** os domínios dos aplicativos das Conexões (os mesmos dos modelos de entrega): só eles viram chip de referência */
export const DOMINIOS_REF = [
  'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'teams.microsoft.com', 'teams.live.com', 'sharepoint.com', 'onedrive.live.com', '1drv.ms', 'planner.cloud.microsoft', 'tasks.office.com', 'to-do.office.com',
  'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com', 'meet.google.com', 'sheets.google.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'app.asana.com', 'trello.com', 'notion.so', 'app.clickup.com', 'monday.com', 'atlassian.net', 'linear.app', 'app.pipefy.com',
  'slack.com', 'discord.com', 'web.whatsapp.com', 'wa.me', 't.me', 'app.hubspot.com', 'asaas.com', 'app.omie.com.br', 'app.smartsheet.com', 'figma.com', 'dropbox.com',
  'zendesk.com', 'freshdesk.com', 'app.intercom.com', 'app.gohighlevel.com', 'pipedrive.com', 'app.rdstation.com',
];
/** http(s), sem usuário:senha; `dominios` restringe o host (as referências) */
export function urlSegura(u: string, dominios?: readonly string[]): boolean {
  let x: URL;
  try { x = new URL(u); } catch { return false; }
  if (!['https:', 'http:'].includes(x.protocol) || x.username || x.password || u.length > 2000) return false;
  if (!dominios) return true;
  const host = x.hostname.toLowerCase();
  return dominios.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Leitor com caminho: junta os erros com o lugar exato ("series[1].valores[3]: ...") para o agente corrigir. */
class Leitor {
  erros: string[] = [];
  avisos: string[] = [];
  readonly c: Conferencia;
  constructor(c: Conferencia) { this.c = c; }
  erro(onde: string, msg: string) { if (this.erros.length < 20) this.erros.push(`${onde ? `${onde}: ` : ''}${msg}`); }

  texto(o: Obj, k: string, onde: string, max: number, obrig = false, min = 1): string | undefined {
    const v = o[k];
    if (v === undefined || v === null || v === '') { if (obrig) this.erro(`${onde}${k}`, 'obrigatório'); return undefined; }
    if (typeof v !== 'string' && typeof v !== 'number') { this.erro(`${onde}${k}`, 'deve ser texto'); return undefined; }
    const s = limpa(String(v));
    if (s.length < min) { this.erro(`${onde}${k}`, `pelo menos ${min} caracteres`); return undefined; }
    if (s.length > max) { this.erro(`${onde}${k}`, `${s.length} caracteres; o máximo é ${max}. Encurte`); return undefined; }
    return s;
  }
  /** texto com parágrafos (o corpo de uma seção, o aviso) */
  paragrafo(o: Obj, k: string, onde: string, max: number, obrig = false): string | undefined {
    const v = o[k];
    if (v === undefined || v === null || v === '') { if (obrig) this.erro(`${onde}${k}`, 'obrigatório'); return undefined; }
    if (typeof v !== 'string') { this.erro(`${onde}${k}`, 'deve ser texto'); return undefined; }
    const s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (s.length > max) { this.erro(`${onde}${k}`, `${s.length} caracteres; o máximo é ${max}`); return undefined; }
    if (/```/.test(s)) { this.erro(`${onde}${k}`, 'sem blocos de código aqui: ponha o visual em blocos[]'); return undefined; }
    return s;
  }
  num(o: Obj, k: string, onde: string, obrig = false, min = -1e15, max = 1e15): number | undefined {
    const v = o[k];
    if (v === undefined || v === null) { if (obrig) this.erro(`${onde}${k}`, 'obrigatório (um número)'); return undefined; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.erro(`${onde}${k}`, `deve ser número (sem aspas, ponto como decimal): veio ${JSON.stringify(v).slice(0, 30)}`); return undefined; }
    if (v < min || v > max) { this.erro(`${onde}${k}`, `fora do intervalo ${min}..${max}`); return undefined; }
    return v;
  }
  int(o: Obj, k: string, onde: string, min: number, max: number, obrig = false): number | undefined {
    const n = this.num(o, k, onde, obrig, min, max);
    if (n !== undefined && !Number.isInteger(n)) { this.erro(`${onde}${k}`, 'deve ser inteiro'); return undefined; }
    return n;
  }
  bool(o: Obj, k: string, onde: string): boolean | undefined {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') { this.erro(`${onde}${k}`, 'deve ser true ou false'); return undefined; }
    return v;
  }
  um<T extends string>(o: Obj, k: string, onde: string, opcoes: readonly T[], obrig = false): T | undefined {
    const v = o[k];
    if (v === undefined || v === null) { if (obrig) this.erro(`${onde}${k}`, `obrigatório: ${opcoes.join(', ')}`); return undefined; }
    if (!opcoes.includes(v as T)) { this.erro(`${onde}${k}`, `use ${opcoes.join(', ')}`); return undefined; }
    return v as T;
  }
  data(o: Obj, k: string, onde: string, obrig = false): string | undefined {
    const s = this.texto(o, k, onde, 10, obrig);
    if (s === undefined) return undefined;
    if (!DATA.test(s) || Number.isNaN(Date.parse(`${s}T12:00:00Z`))) { this.erro(`${onde}${k}`, 'data no formato AAAA-MM-DD'); return undefined; }
    return s;
  }
  lista(o: Obj, k: string, onde: string, min: number, max: number, obrig = true): unknown[] | undefined {
    const v = o[k];
    if (v === undefined || v === null) { if (obrig) this.erro(`${onde}${k}`, `obrigatório (lista de ${min} a ${max})`); return undefined; }
    if (!Array.isArray(v)) { this.erro(`${onde}${k}`, 'deve ser uma lista'); return undefined; }
    if (v.length < min || v.length > max) { this.erro(`${onde}${k}`, `${v.length} itens; use de ${min} a ${max}`); return v.length < min ? undefined : v.slice(0, max); }
    return v;
  }
  textos(o: Obj, k: string, onde: string, min: number, max: number, maxCar: number, obrig = true): string[] | undefined {
    const xs = this.lista(o, k, onde, min, max, obrig);
    if (!xs) return undefined;
    return xs.map((x, i) => this.texto({ v: x }, 'v', '', maxCar, true) ?? (this.erros.push(`${onde}${k}[${i}]: confira o texto`), ''));
  }
  nums(o: Obj, k: string, onde: string, min: number, max: number, nulos = false): Array<number | null> | undefined {
    const xs = this.lista(o, k, onde, min, max);
    if (!xs) return undefined;
    return xs.map((x, i) => {
      if (x === null && nulos) return null;
      if (typeof x !== 'number' || !Number.isFinite(x)) { this.erro(`${onde}${k}[${i}]`, `deve ser número: veio ${JSON.stringify(x).slice(0, 20)}`); return 0; }
      return x;
    });
  }
  obj(o: Obj, k: string, onde: string, obrig = false): Obj | undefined {
    const v = o[k];
    if (v === undefined || v === null) { if (obrig) this.erro(`${onde}${k}`, 'obrigatório'); return undefined; }
    if (!ehObj(v)) { this.erro(`${onde}${k}`, 'deve ser um objeto {…}'); return undefined; }
    return v;
  }
  objs(o: Obj, k: string, onde: string, min: number, max: number, obrig = true): Array<[Obj, string]> {
    const xs = this.lista(o, k, onde, min, max, obrig) ?? [];
    return xs.flatMap((x, i): Array<[Obj, string]> => {
      if (!ehObj(x)) { this.erro(`${onde}${k}[${i}]`, 'deve ser um objeto {…}'); return []; }
      return [[x, `${onde}${k}[${i}].`]];
    });
  }
  imagem(o: Obj, k: string, onde: string, obrig = false): Imagem | undefined {
    const x = this.obj(o, k, onde, obrig);
    if (!x) return undefined;
    return this.imagemDe(x, `${onde}${k}.`);
  }
  imagemDe(x: Obj, onde: string): Imagem | undefined {
    const src = this.texto(x, 'src', onde, 2000, true);
    const alt = this.texto(x, 'alt', onde, 200, true);
    const legenda = this.texto(x, 'legenda', onde, 140);
    if (src && !ID_ARQUIVO.test(src) && !(urlSegura(src) && src.startsWith('https://'))) { this.erro(`${onde}src`, 'um arquivo dos Documentos (art_…) ou um endereço https'); return undefined; }
    if (src && ID_ARQUIVO.test(src) && this.c.idValido && !this.c.idValido(src)) { this.erro(`${onde}src`, 'o arquivo não existe neste workspace'); return undefined; }
    return src && alt ? { src, alt, ...(legenda ? { legenda } : {}) } : undefined;
  }
  formato(o: Obj, onde: string): { formato?: Formato; moeda?: Moeda } {
    const formato = this.um(o, 'formato', onde, FORMATOS);
    const moeda = this.um(o, 'moeda', onde, MOEDAS);
    return { ...(formato ? { formato } : {}), ...(moeda ? { moeda } : {}) };
  }
  fontes(o: Obj, k: string, onde: string, max = 12): Fonte[] | undefined {
    if (o[k] === undefined || o[k] === null) return undefined;
    return this.objs(o, k, onde, 0, max).flatMap(([x, aqui]): Fonte[] => {
      const tipo = this.um(x, 'tipo', aqui, TIPOS_FONTE, true);
      const titulo = this.texto(x, 'titulo', aqui, 90, true, 2);
      const periodo = this.texto(x, 'periodo', aqui, 60);
      const url = this.texto(x, 'url', aqui, 2000);
      const id = this.texto(x, 'id', aqui, 80);
      if (url && !urlSegura(url)) { this.erro(`${aqui}url`, 'só http(s), sem usuário e senha'); return []; }
      if (id && (!ID_INTERNO.test(id) || (this.c.idValido && !this.c.idValido(id)))) { this.erro(`${aqui}id`, 'não existe neste workspace (art_…, tsk_…, cnv_…)'); return []; }
      if (!tipo || !titulo) return [];
      return [{ tipo, titulo, ...(url ? { url } : {}), ...(id && !url ? { id } : {}), ...(periodo ? { periodo } : {}) }];
    });
  }
  referencias(o: Obj, k: string, onde: string): Referencia[] {
    return this.objs(o, k, onde, 1, 12).flatMap(([x, aqui]): Referencia[] => {
      const tipo = this.um(x, 'tipo', aqui, TIPOS_REF, true);
      const titulo = this.texto(x, 'titulo', aqui, 80, true, 2);
      const url = this.texto(x, 'url', aqui, 2000);
      const rid = this.texto(x, 'id', aqui, 80);
      if (!url && !rid) { this.erro(aqui.slice(0, -1), 'falta url (o link que a ferramenta devolveu) ou id (art_…, tsk_…, cnv_…)'); return []; }
      if (url && !urlSegura(url, [...DOMINIOS_REF, ...(this.c.dominios ?? [])])) { this.erro(`${aqui}url`, 'só o link do próprio aplicativo (o que a ferramenta devolveu), com https'); return []; }
      if (rid && !url && (!ID_INTERNO.test(rid) || (this.c.idValido && !this.c.idValido(rid)))) { this.erro(`${aqui}id`, 'não existe neste workspace'); return []; }
      return tipo && titulo ? [{ tipo, titulo, url: url ?? null, id: url ? null : rid ?? null }] : [];
    });
  }
  kpi(x: Obj, onde: string): DadosKpi | undefined {
    const rotulo = this.texto(x, 'rotulo', onde, 60, true);
    const valor = this.num(x, 'valor', onde, true);
    const unidade = this.texto(x, 'unidade', onde, 14);
    const variacao = this.num(x, 'variacao', onde, false, -1e6, 1e6);
    const comparacao = this.texto(x, 'comparacao', onde, 40);
    const bom = this.um(x, 'bom', onde, ['alta', 'baixa'] as const);
    const meta = this.num(x, 'meta', onde);
    const serie = x.serie === undefined ? undefined : (this.nums(x, 'serie', onde, 2, 60) as number[] | undefined);
    if (rotulo === undefined || valor === undefined) return undefined;
    return { rotulo, valor, ...this.formato(x, onde), ...(unidade ? { unidade } : {}), ...(variacao !== undefined ? { variacao } : {}), ...(comparacao ? { comparacao } : {}),
      ...(bom ? { bom } : {}), ...(meta !== undefined ? { meta } : {}), ...(serie ? { serie } : {}) };
  }
  series(x: Obj, onde: string, n: number, max: number): Serie[] {
    return this.objs(x, 'series', onde, 1, max).flatMap(([s, aqui]): Serie[] => {
      const nome = this.texto(s, 'nome', aqui, 40, true);
      const valores = this.nums(s, 'valores', aqui, 1, 60, true);
      if (valores && valores.length !== n) this.erro(`${aqui}valores`, `${valores.length} valores para ${n} categorias: um por categoria (null onde não há)`);
      return nome && valores ? [{ nome, valores }] : [];
    });
  }
}

const TIPOS: readonly TipoBloco[] = ['kpi', 'kpis', 'nota', 'barras', 'linhas', 'pizza', 'tabela', 'comparativo', 'versus', 'placar', 'linha_do_tempo', 'progresso', 'checklist',
  'status', 'semaforo', 'pessoa', 'aviso', 'galeria', 'link', 'arquivo', 'mapa', 'referencias', 'ficha', 'medidor', 'sparkline', 'icones', 'funil', 'calor', 'enquete', 'decisao',
  'matriz', 'fontes', 'relatorio'];
export const TODOS_OS_TIPOS = TIPOS;

/** A linguagem da cerca de um tipo (linha_do_tempo → ergon-linha-do-tempo). */
export const langDoTipo = (t: TipoBloco): string => `${PREFIXO}${t.replace(/_/g, '-')}`;
/** O tipo de uma linguagem de cerca: null quando não é bloco visual; '' na cerca genérica (o tipo vem no JSON). */
export function tipoDoLang(lang: string): TipoBloco | '' | null {
  const l = lang.toLowerCase();
  if (l === CERCA) return '';
  if (!l.startsWith(PREFIXO)) return null;
  const t = l.slice(PREFIXO.length).replace(/-/g, '_') as TipoBloco;
  return TIPOS.includes(t) ? t : null;
}
/** O JSON de uma cerca com o tipo dela (o da linguagem vale; um "tipo" diferente no JSON é erro). */
export function comTipo(lang: string, valor: unknown): unknown {
  const t = tipoDoLang(lang);
  if (!t || !valor || typeof valor !== 'object' || Array.isArray(valor)) return valor;
  const o = valor as Record<string, unknown>;
  return o.tipo === undefined ? { tipo: t, ...o } : o.tipo === t ? o : { ...o, tipo: `${String(o.tipo)} (a cerca diz ${t})` };
}

function corpo(L: Leitor, o: Obj, tipo: TipoBloco, onde: string, profundidade: number): Obj | undefined {
  const r = (v: Obj | undefined) => v;
  switch (tipo) {
    case 'kpi': return L.kpi(o, onde) as unknown as Obj;
    case 'kpis': {
      const itens = L.objs(o, 'itens', onde, 2, 6).map(([x, aqui]) => L.kpi(x, aqui)).filter(Boolean);
      return { itens };
    }
    case 'nota': {
      const escala = L.num(o, 'escala', onde, false, 1, 1000) ?? 10;
      const valor = L.num(o, 'valor', onde, true, 0, escala);
      return r({ rotulo: L.texto(o, 'rotulo', onde, 70), valor, escala, legenda: L.texto(o, 'legenda', onde, 90) });
    }
    case 'barras': case 'linhas': {
      const categorias = L.textos(o, 'categorias', onde, tipo === 'linhas' ? 2 : 1, tipo === 'linhas' ? 60 : 24, 30) ?? [];
      const series = L.series(o, onde, categorias.length, tipo === 'linhas' ? 5 : 6);
      const meta = L.num(o, 'meta', onde);
      if (tipo === 'barras') {
        const destaque = L.int(o, 'destaque', onde, 0, Math.max(0, categorias.length - 1));
        return { categorias, series, ...L.formato(o, onde), horizontal: L.bool(o, 'horizontal', onde), empilhado: L.bool(o, 'empilhado', onde), destaque, meta };
      }
      return { categorias, series, ...L.formato(o, onde), area: L.bool(o, 'area', onde), meta };
    }
    case 'pizza': {
      const fatias = L.objs(o, 'fatias', onde, 1, 8).flatMap(([x, aqui]) => {
        const rotulo = L.texto(x, 'rotulo', aqui, 40, true); const valor = L.num(x, 'valor', aqui, true, 0);
        return rotulo !== undefined && valor !== undefined ? [{ rotulo, valor }] : [];
      });
      if (fatias.length && fatias.every((f) => f.valor === 0)) L.erro(`${onde}fatias`, 'todos os valores são zero');
      const c = L.obj(o, 'centro', onde);
      const centro = c ? { valor: L.texto(c, 'valor', `${onde}centro.`, 12, true), rotulo: L.texto(c, 'rotulo', `${onde}centro.`, 24) } : undefined;
      return { fatias, rosca: L.bool(o, 'rosca', onde), ...L.formato(o, onde), centro };
    }
    case 'tabela': {
      const colunas = L.objs(o, 'colunas', onde, 1, 10).flatMap(([x, aqui]) => {
        const titulo = L.texto(x, 'titulo', aqui, 40, true);
        return titulo !== undefined ? [{ titulo, ...L.formato(x, aqui), alinhar: L.um(x, 'alinhar', aqui, ['esquerda', 'centro', 'direita'] as const) }] : [];
      });
      const n = colunas.length;
      const celula = (v: unknown, aqui: string): Celula => {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') { const s = limpa(v); if (s.length > 200) L.erro(aqui, 'célula com mais de 200 caracteres'); return s.slice(0, 200); }
        L.erro(aqui, 'célula deve ser texto, número ou null'); return null;
      };
      const linhas = (L.lista(o, 'linhas', onde, 1, 200) ?? []).map((l, i) => {
        if (!Array.isArray(l)) { L.erro(`${onde}linhas[${i}]`, 'cada linha é uma lista de células'); return []; }
        if (l.length !== n) L.erro(`${onde}linhas[${i}]`, `${l.length} células para ${n} colunas`);
        return l.slice(0, n).map((c, j) => celula(c, `${onde}linhas[${i}][${j}]`));
      });
      // números de moeda/percentual escritos como texto ("R$ 1.200"): o agente manda o número e a coluna formata
      colunas.forEach((c, j) => {
        if (c.formato && ['moeda', 'percentual', 'numero', 'inteiro', 'compacto'].includes(c.formato) && linhas.some((l) => typeof l[j] === 'string' && /\d/.test(String(l[j])))) {
          L.erro(`${onde}colunas[${j}]`, `coluna ${c.formato}: mande os valores como número (1200.5), não como texto; a tela formata`);
        }
        if (c.formato === 'data' && linhas.some((l) => l[j] !== null && !(typeof l[j] === 'string' && DATA.test(String(l[j]))))) L.erro(`${onde}colunas[${j}]`, 'coluna data: valores AAAA-MM-DD');
      });
      let totais: boolean | Celula[] | undefined;
      if (Array.isArray(o.totais)) { totais = o.totais.slice(0, n).map((c, j) => celula(c, `${onde}totais[${j}]`)); if (o.totais.length !== n) L.erro(`${onde}totais`, `${o.totais.length} células para ${n} colunas`); }
      else totais = L.bool(o, 'totais', onde);
      const destaques = o.destaques === undefined ? undefined : L.objs(o, 'destaques', onde, 0, 40).flatMap(([x, aqui]) => {
        const linha = L.int(x, 'linha', aqui, 0, Math.max(0, linhas.length - 1), true); const coluna = L.int(x, 'coluna', aqui, 0, Math.max(0, n - 1), true);
        const tom = L.um(x, 'tom', aqui, ['bom', 'ruim', 'atencao', 'neutro', 'marca'] as const, true);
        return linha !== undefined && coluna !== undefined && tom ? [{ linha, coluna, tom }] : [];
      });
      const negrito = o.negrito === undefined ? undefined : (L.nums(o, 'negrito', onde, 0, n) as number[] | undefined)?.filter((j) => Number.isInteger(j) && j >= 0 && j < n);
      return { colunas, linhas, totais, destaques, ordenavel: L.bool(o, 'ordenavel', onde), negrito };
    }
    case 'comparativo': {
      const opcoes = L.objs(o, 'opcoes', onde, 2, 3).flatMap(([x, aqui]) => {
        const nome = L.texto(x, 'nome', aqui, 50, true);
        const pros = x.pros === undefined ? undefined : L.textos(x, 'pros', aqui, 0, 6, 90);
        const contras = x.contras === undefined ? undefined : L.textos(x, 'contras', aqui, 0, 6, 90);
        return nome !== undefined ? [{ nome, subtitulo: L.texto(x, 'subtitulo', aqui, 80), valor: L.num(x, 'valor', aqui), pros, contras, recomendada: L.bool(x, 'recomendada', aqui) }] : [];
      });
      return { opcoes, ...L.formato(o, onde) };
    }
    case 'versus': {
      const lado = (k: 'a' | 'b') => {
        const x = L.obj(o, k, onde, true); if (!x) return undefined;
        const aqui = `${onde}${k}.`;
        const rotulo = L.texto(x, 'rotulo', aqui, 50, true); const valor = L.num(x, 'valor', aqui, true);
        return rotulo !== undefined && valor !== undefined ? { rotulo, valor, legenda: L.texto(x, 'legenda', aqui, 60) } : undefined;
      };
      const pontas = o.pontas === undefined ? undefined : L.textos(o, 'pontas', onde, 2, 2, 30);
      return { a: lado('a'), b: lado('b'), ...L.formato(o, onde), melhor: L.um(o, 'melhor', onde, ['a', 'b'] as const), pontas };
    }
    case 'placar': {
      const escala = L.num(o, 'escala', onde, false, 1, 1000) ?? 10;
      const itens = L.objs(o, 'itens', onde, 1, 10).flatMap(([x, aqui]) => {
        const rotulo = L.texto(x, 'rotulo', aqui, 60, true); const nota = L.num(x, 'nota', aqui, true, 0, escala);
        return rotulo !== undefined && nota !== undefined ? [{ rotulo, nota }] : [];
      });
      return { itens, escala };
    }
    case 'linha_do_tempo': {
      const marcos = L.objs(o, 'marcos', onde, 1, 12).flatMap(([x, aqui]) => {
        const data = L.data(x, 'data', aqui, true); const titulo = L.texto(x, 'titulo', aqui, 60, true);
        return data && titulo ? [{ data, titulo, detalhe: L.texto(x, 'detalhe', aqui, 120), estado: L.um(x, 'estado', aqui, ['feito', 'em_dia', 'atrasado', 'risco', 'previsto'] as const) }] : [];
      });
      return { marcos, hoje: L.data(o, 'hoje', onde) };
    }
    case 'progresso': {
      const itens = L.objs(o, 'itens', onde, 1, 6).flatMap(([x, aqui]) => {
        const rotulo = L.texto(x, 'rotulo', aqui, 60, true); const atual = L.num(x, 'atual', aqui, true); const meta = L.num(x, 'meta', aqui, true);
        if (meta === 0) L.erro(`${aqui}meta`, 'a meta não pode ser zero');
        return rotulo !== undefined && atual !== undefined && meta !== undefined ? [{ rotulo, atual, meta, ...L.formato(x, aqui), prazo: L.data(x, 'prazo', aqui) }] : [];
      });
      return { itens, estilo: L.um(o, 'estilo', onde, ['barra', 'anel'] as const) };
    }
    case 'checklist': return { itens: L.objs(o, 'itens', onde, 1, 20).flatMap(([x, aqui]) => {
      const texto = L.texto(x, 'texto', aqui, 120, true); const estado = L.um(x, 'estado', aqui, ['feito', 'andamento', 'pendente', 'bloqueado'] as const, true);
      return texto && estado ? [{ texto, estado }] : [];
    }) };
    case 'status': return { itens: L.objs(o, 'itens', onde, 1, 12).flatMap(([x, aqui]) => {
      const rotulo = L.texto(x, 'rotulo', aqui, 60, true); const estado = L.um(x, 'estado', aqui, ['ok', 'atencao', 'erro', 'parado'] as const, true);
      return rotulo && estado ? [{ rotulo, estado, detalhe: L.texto(x, 'detalhe', aqui, 90) }] : [];
    }) };
    case 'semaforo': return { itens: L.objs(o, 'itens', onde, 1, 8).flatMap(([x, aqui]) => {
      const rotulo = L.texto(x, 'rotulo', aqui, 60, true); const cor = L.um(x, 'cor', aqui, ['verde', 'amarelo', 'vermelho'] as const, true);
      return rotulo && cor ? [{ rotulo, cor, detalhe: L.texto(x, 'detalhe', aqui, 90) }] : [];
    }) };
    case 'pessoa': {
      const email = L.texto(o, 'email', onde, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) L.erro(`${onde}email`, 'e-mail inválido');
      const telefone = L.texto(o, 'telefone', onde, 30);
      if (telefone && !/^[+()\d\s.-]{6,30}$/.test(telefone)) L.erro(`${onde}telefone`, 'só dígitos, espaço, +, (, ), - e .');
      const site = L.texto(o, 'site', onde, 300);
      if (site && !(urlSegura(site) && site.startsWith('https://'))) L.erro(`${onde}site`, 'endereço https');
      return { nome: L.texto(o, 'nome', onde, 60, true), cargo: L.texto(o, 'cargo', onde, 60), empresa: L.texto(o, 'empresa', onde, 60), email, telefone, site,
        local: L.texto(o, 'local', onde, 80), foto: L.imagem(o, 'foto', onde), tags: o.tags === undefined ? undefined : L.textos(o, 'tags', onde, 0, 6, 24) };
    }
    case 'aviso': return { tom: L.um(o, 'tom', onde, ['info', 'dica', 'alerta', 'risco', 'sucesso'] as const, true), texto: L.paragrafo(o, 'texto', onde, 600, true) };
    case 'galeria': return { imagens: L.objs(o, 'imagens', onde, 1, 12).map(([x, aqui]) => L.imagemDe(x, aqui)).filter(Boolean) };
    case 'link': {
      const url = L.texto(o, 'url', onde, 2000, true);
      if (url && !urlSegura(url)) L.erro(`${onde}url`, 'só http(s), sem usuário e senha');
      const imagem = L.texto(o, 'imagem', onde, 2000);
      if (imagem && !(urlSegura(imagem) && imagem.startsWith('https://'))) L.erro(`${onde}imagem`, 'endereço https');
      return { url, descricao: L.texto(o, 'descricao', onde, 240), imagem };
    }
    case 'arquivo': {
      const id = L.texto(o, 'id', onde, 80, true);
      if (id && (!ID_ARQUIVO.test(id) || (L.c.idValido && !L.c.idValido(id)))) L.erro(`${onde}id`, 'um arquivo dos Documentos (art_…) que exista neste workspace');
      return { id };
    }
    case 'mapa': return { endereco: L.texto(o, 'endereco', onde, 200, true), lat: L.num(o, 'lat', onde, false, -90, 90), lng: L.num(o, 'lng', onde, false, -180, 180) };
    case 'referencias': return { itens: L.referencias(o, 'itens', onde) };
    case 'ficha': {
      const linhas = L.objs(o, 'linhas', onde, 1, 20).flatMap(([x, aqui]) => {
        const parametro = L.texto(x, 'parametro', aqui, 50, true); const valor = L.texto(x, 'valor', aqui, 120, true);
        return parametro && valor ? [{ parametro, valor, destaque: L.bool(x, 'destaque', aqui) }] : [];
      });
      const cabecalho = o.cabecalho === undefined ? undefined : L.textos(o, 'cabecalho', onde, 2, 2, 30);
      return { imagem: L.imagem(o, 'imagem', onde), linhas, cabecalho };
    }
    case 'medidor': {
      const min = L.num(o, 'min', onde) ?? 0; const max = L.num(o, 'max', onde) ?? 100;
      if (max <= min) L.erro(`${onde}max`, 'deve ser maior que min');
      const valor = L.num(o, 'valor', onde, true);
      if (valor !== undefined && (valor < min || valor > max)) L.erro(`${onde}valor`, `fora de ${min}..${max}`);
      const faixas = o.faixas === undefined ? undefined : L.objs(o, 'faixas', onde, 2, 5).flatMap(([x, aqui]) => {
        const ate = L.num(x, 'ate', aqui, true, min, max); const tom = L.um(x, 'tom', aqui, ['ruim', 'ok', 'bom'] as const, true);
        return ate !== undefined && tom ? [{ ate, tom, rotulo: L.texto(x, 'rotulo', aqui, 20) }] : [];
      });
      if (faixas && faixas.some((f, i) => i > 0 && f.ate <= faixas[i - 1].ate)) L.erro(`${onde}faixas`, 'em ordem crescente de "ate"');
      return { valor, min, max, faixas, formato: L.um(o, 'formato', onde, FORMATOS), rotulo: L.texto(o, 'rotulo', onde, 40), tendencia: L.num(o, 'tendencia', onde), estilo: L.um(o, 'estilo', onde, ['arco', 'termometro'] as const) };
    }
    case 'sparkline': return { rotulo: L.texto(o, 'rotulo', onde, 60, true), serie: L.nums(o, 'serie', onde, 2, 60), ...L.formato(o, onde), bom: L.um(o, 'bom', onde, ['alta', 'baixa'] as const) };
    case 'icones': {
      const total = L.int(o, 'total', onde, 1, 20, true); const valor = L.num(o, 'valor', onde, true, 0, total ?? 20);
      return { valor, total, icone: L.um(o, 'icone', onde, PICTOGRAMAS), rotulo: L.texto(o, 'rotulo', onde, 90, true) };
    }
    case 'funil': return { etapas: L.objs(o, 'etapas', onde, 2, 7).flatMap(([x, aqui]) => {
      const rotulo = L.texto(x, 'rotulo', aqui, 40, true); const valor = L.num(x, 'valor', aqui, true, 0);
      return rotulo !== undefined && valor !== undefined ? [{ rotulo, valor }] : [];
    }), ...L.formato(o, onde) };
    case 'calor': {
      const linhas = L.textos(o, 'linhas', onde, 1, 8, 16) ?? []; const colunas = L.textos(o, 'colunas', onde, 1, 24, 8) ?? [];
      const valores = (L.lista(o, 'valores', onde, 1, 8) ?? []).map((l, i) => {
        if (!Array.isArray(l) || l.length !== colunas.length) { L.erro(`${onde}valores[${i}]`, `uma lista de ${colunas.length} números (uma por coluna)`); return []; }
        return l.map((v, j) => (typeof v === 'number' && Number.isFinite(v) ? v : (L.erro(`${onde}valores[${i}][${j}]`, 'deve ser número'), 0)));
      });
      if (valores.length !== linhas.length) L.erro(`${onde}valores`, `${valores.length} linhas de valores para ${linhas.length} rótulos de linha`);
      return { linhas, colunas, valores, formato: L.um(o, 'formato', onde, FORMATOS) };
    }
    case 'enquete': {
      const opcoes = L.textos(o, 'opcoes', onde, 2, 6, 60) ?? [];
      let eid = L.texto(o, 'id', onde, 40);
      if (eid && !/^[a-z0-9_-]{3,40}$/i.test(eid)) { L.erro(`${onde}id`, 'letras, números, _ e -'); eid = undefined; }
      const votos = o.votos === undefined ? undefined : L.objs(o, 'votos', onde, 0, 60).flatMap(([x, aqui]) => {
        const opcao = L.int(x, 'opcao', aqui, 0, Math.max(0, opcoes.length - 1), true); const quem = L.texto(x, 'quem', aqui, 60, true);
        return opcao !== undefined && quem ? [{ opcao, quem }] : [];
      });
      return { id: eid ?? L.c.novoId?.() ?? `enq_${Math.random().toString(36).slice(2, 10)}`, pergunta: L.texto(o, 'pergunta', onde, 140, true), opcoes, votos,
        encerrada: L.bool(o, 'encerrada', onde), decisao: L.int(o, 'decisao', onde, 0, Math.max(0, opcoes.length - 1)), eleitores: L.int(o, 'eleitores', onde, 1, 500) };
    }
    case 'decisao': {
      const votos = L.int(o, 'votos', onde, 0, 1000); const total = L.int(o, 'total', onde, 1, 1000);
      if (votos !== undefined && total !== undefined && votos > total) L.erro(`${onde}votos`, 'maior que o total');
      return { escolha: L.texto(o, 'escolha', onde, 90, true), votos, total, porque: L.texto(o, 'porque', onde, 200), proximos: o.proximos === undefined ? undefined : L.textos(o, 'proximos', onde, 0, 4, 90) };
    }
    case 'matriz': return {
      itens: L.objs(o, 'itens', onde, 1, 12).flatMap(([x, aqui]) => {
        const rotulo = L.texto(x, 'rotulo', aqui, 30, true); const px = L.num(x, 'x', aqui, true, 0, 10); const py = L.num(x, 'y', aqui, true, 0, 10);
        return rotulo !== undefined && px !== undefined && py !== undefined ? [{ rotulo, x: px, y: py }] : [];
      }),
      eixos: o.eixos === undefined ? undefined : L.textos(o, 'eixos', onde, 2, 2, 20),
      quadrantes: o.quadrantes === undefined ? undefined : L.textos(o, 'quadrantes', onde, 4, 4, 24),
    };
    case 'fontes': return { itens: L.fontes(o, 'itens', onde, 20) ?? (L.erro(`${onde}itens`, 'obrigatório'), []) };
    case 'relatorio': {
      if (profundidade > 0) { L.erro(onde.slice(0, -1) || 'tipo', 'relatório dentro de relatório não'); return undefined; }
      const blocos = (x: Obj, k: string, aqui: string, max: number) => (x[k] === undefined ? undefined
        : L.objs(x, k, aqui, 0, max).flatMap(([b, onde2]) => { const v = lerBloco(L, b, onde2, profundidade + 1); return v ? [v] : []; }));
      let rid = L.texto(o, 'id', onde, 40);
      if (rid && !/^[a-z0-9_-]{3,40}$/i.test(rid)) { L.erro(`${onde}id`, 'letras, números, _ e -'); rid = undefined; }
      const secoes = L.objs(o, 'secoes', onde, 1, 12).flatMap(([x, aqui]) => {
        const titulo = L.texto(x, 'titulo', aqui, 80, true);
        return titulo ? [{ titulo, texto: L.paragrafo(x, 'texto', aqui, 4000), blocos: blocos(x, 'blocos', aqui, 6) }] : [];
      });
      return { id: rid ?? L.c.novoId?.() ?? `rel_${Math.random().toString(36).slice(2, 10)}`, versao: L.int(o, 'versao', onde, 1, 999) ?? 1, resumo: L.paragrafo(o, 'resumo', onde, 400),
        destaques: blocos(o, 'destaques', onde, 2), secoes };
    }
  }
}

/** tira as chaves vazias (undefined) do resultado: o JSON normalizado fica curto e estável */
function semVazios<T>(v: T): T {
  if (Array.isArray(v)) return v.map(semVazios) as T;
  if (ehObj(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, semVazios(x)])) as T;
  return v;
}

function lerBloco(L: Leitor, o: Obj, onde: string, profundidade: number): Bloco | undefined {
  const antes = L.erros.length;
  const tipo = L.um(o, 'tipo', onde, TIPOS, true);
  if (!tipo) return undefined;
  const base = {
    titulo: L.texto(o, 'titulo', onde, 90), subtitulo: L.texto(o, 'subtitulo', onde, 160), nota: L.texto(o, 'nota', onde, 240),
    fontes: L.fontes(o, 'fontes', onde), estimativa: L.bool(o, 'estimativa', onde),
    lado: (() => {
      const x = L.obj(o, 'lado', onde); if (!x) return undefined;
      const aqui = `${onde}lado.`;
      return { numero: L.texto(x, 'numero', aqui, 14), rotulo: L.texto(x, 'rotulo', aqui, 40), linhas: x.linhas === undefined ? undefined : L.textos(x, 'linhas', aqui, 0, 3, 80) };
    })(),
  };
  const c = corpo(L, o, tipo, onde, profundidade);
  // origem e fontes sempre (rc.42): todo dado diz de onde veio; sem fonte, só declarando estimativa
  if (PEDEM_FONTE.has(tipo) && !base.fontes?.length && base.estimativa !== true) {
    L.erro(`${onde}fontes`, 'diga de onde veio o dado: [{tipo: conexao|documento|site|calculo|conversa, titulo (ex. "Outlook · suporte@"), periodo, url ou id}]; se for estimativa, mande "estimativa": true');
  }
  if (L.erros.length > antes || !c) return undefined;
  // a ordem do JSON gravado: o título, o corpo do bloco, e o rodapé (nota, fontes) por último
  const { titulo, subtitulo, ...pe } = base;
  return semVazios({ tipo, titulo, subtitulo, ...c, ...pe }) as Bloco;
}

/** Valida e normaliza um bloco (objeto já lido do JSON). */
export function validarBloco(v: unknown, c: Conferencia = {}): Resultado {
  const L = new Leitor(c);
  if (!ehObj(v)) return { ok: false, erros: ['o bloco deve ser um objeto JSON {"tipo": …}'] };
  const b = lerBloco(L, v, '', 0);
  if (!b || L.erros.length) return { ok: false, erros: L.erros.length ? L.erros : ['bloco inválido'] };
  const tam = JSON.stringify(b).length;
  if (tam > (b.tipo === 'relatorio' ? LIMITES.relatorioJson : LIMITES.jsonBloco)) return { ok: false, erros: [`o bloco tem ${tam} caracteres de JSON; divida em blocos menores`] };
  return { ok: true, bloco: b, avisos: L.avisos };
}

/** Lê o texto de uma cerca (JSON); erro de sintaxe vira mensagem útil. */
export function lerJson(texto: string): { ok: true; valor: unknown } | { ok: false; erro: string } {
  if (texto.length > LIMITES.relatorioJson + 4000) return { ok: false, erro: 'JSON grande demais' };
  try { return { ok: true, valor: JSON.parse(texto) }; } catch (e) { return { ok: false, erro: `JSON inválido: ${(e as Error).message.slice(0, 120)}` }; }
}
