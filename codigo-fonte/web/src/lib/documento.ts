/**
 * O documento entregue na tela (rc.42): o estilo do modelo e da identidade em variáveis de CSS, a regra de página da
 * impressão, o que mudou entre duas versões (para o realce suave) e os blocos visuais de outros módulos embutidos no
 * Markdown (```ergon-grafico …```), desenhados pelo componente de quem registrou.
 */
import type { ComponentType } from 'react';
import type { Identidade, ModeloDoc } from '../../../shared/entregaveis.ts';
import { corDeTitulo } from '../../../shared/entregaveis.ts';

export type { Identidade, ModeloDoc } from '../../../shared/entregaveis.ts';

/** As variáveis que o papel usa (tela e impressão). */
export function estiloDoPapel(m: ModeloDoc, id: Identidade): Record<string, string> {
  return {
    // i18n-ok: nomes de fonte (CSS), não texto de tela
    '--doc-fonte': m.fonte === 'serif' ? '"Times New Roman", Times, "Liberation Serif", serif' : 'Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif',
    '--doc-tam': `${m.tamanho}pt`,
    '--doc-entre': String(m.entrelinha),
    '--doc-titulo': m.citacaoAbnt ? 'var(--doc-tinta)' : corDeTitulo(id.corPrimaria),
    '--doc-marca': id.corPrimaria,
    '--doc-destaque': id.corDestaque,
    '--doc-m-topo': `${m.margens.topo}cm`, '--doc-m-dir': `${m.margens.direita}cm`, '--doc-m-base': `${m.margens.base}cm`, '--doc-m-esq': `${m.margens.esquerda}cm`,
    '--doc-recuo': m.recuo ? '1.25cm' : '0',
    '--doc-alinha': m.justificar ? 'justify' : 'left',
  };
}

const css = (s: string) => s.replace(/["\\\n\r]/g, ' ');

/**
 * A regra de página da impressão: A4, as margens do modelo e o número da página nas margens (o navegador repete em cada
 * página). ABNT: só o número, no alto à direita, a partir da 2ª folha; os outros: "3 / 12" no rodapé à direita.
 */
export function regraDePagina(m: ModeloDoc, rodape: string): string {
  const num = m.paginacao === 'topo' ? '@top-right { content: counter(page); font: 10pt var(--doc-fonte, serif); }'
    : m.paginacao === 'rodape' ? '@bottom-right { content: counter(page) " / " counter(pages); font: 8pt Arial, sans-serif; color: #686760; }' : '';
  const rod = m.rodape.mostrar && rodape ? `@bottom-left { content: "${css(rodape)}"; font: 8pt Arial, sans-serif; color: #686760; }` : '';
  const sem = m.numeroDesde > 1 || m.capa.ligada ? '@page :first { @top-right { content: none; } @bottom-right { content: none; } @bottom-left { content: none; } }' : '';
  // com cabeçalho, ele ocupa o alto da área da página (repetido pelo navegador): a margem de cima desconta a altura dele
  const topo = m.cabecalho.mostrar ? Math.max(1, Math.round((m.margens.topo - 1.3) * 10) / 10) : m.margens.topo;
  // i18n-ok: regra de CSS da página impressa, não texto de tela
  return `@page { size: A4; margin: ${topo}cm ${m.margens.direita}cm ${m.margens.base}cm ${m.margens.esquerda}cm; ${num} ${rod} } ${sem}`;
}

/**
 * Os trechos novos ou mudados de uma versão para a outra (o realce suave na tela): o trecho que não existia igual antes.
 * Trecho só movido (igual, em outro lugar) não acende.
 */
export function trechosMudados(antes: readonly string[] | null, depois: readonly string[]): Set<number> {
  if (!antes) return new Set();
  const conta = new Map<string, number>();
  for (const t of antes) conta.set(t, (conta.get(t) ?? 0) + 1);
  const out = new Set<number>();
  depois.forEach((t, i) => {
    const n = conta.get(t) ?? 0;
    if (n > 0) conta.set(t, n - 1); else if (t.trim()) out.add(i);
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ blocos visuais

/** Bloco visual embutido no Markdown: ```ergon-<tipo>\n<conteúdo>\n``` → o componente de quem registrou o tipo. */
export interface BlocoVisualProps { tipo: string; conteudo: string }
const blocos = new Map<string, ComponentType<BlocoVisualProps>>();

/** Registra o desenho de um tipo de bloco (ex.: "grafico" para ```ergon-grafico```). Sem registro: aparece como código. */
export function registrarBlocoVisual(tipo: string, c: ComponentType<BlocoVisualProps>): void { blocos.set(tipo.toLowerCase(), c); }
export function blocoVisual(lang: string): { tipo: string; Componente: ComponentType<BlocoVisualProps> } | null {
  const m = lang.toLowerCase().match(/^ergon-([a-z0-9-]{1,30})$/);
  const c = m ? blocos.get(m[1]) : undefined;
  return m && c ? { tipo: m[1], Componente: c } : null;
}

// ------------------------------------------------------------------------------------------------ revisão ao vivo

export interface AgenteNaFrente { id: string; name: string; role: string; color: string; char_key: string | null; look_seed: number | null }
export interface FrenteAoVivo {
  id: string; acao: 'revisar' | 'reescrever' | 'conferir'; especialidade: string; estado: 'espera' | 'trabalhando' | 'feito' | 'falhou';
  cor: string; blocos: number[]; conferidoAte: number; aoVivo: string | null; agente: AgenteNaFrente;
}
export interface EstadoRevisao {
  versao: number;
  ativa: { id: string; pedido: string; trechos: string[]; frentes: FrenteAoVivo[] } | null;
  pedidos: Array<{ id: string; pedido: string; trecho: string | null; estado: 'fila' | 'editando' | 'feito' | 'falhou'; erro: string | null; created_at: string; versao_n: number | null }>;
}

/** Quem está em cada trecho agora: o primeiro trecho de cada frente que trabalha leva o avatar e o rótulo. */
export function presencaPorTrecho(frentes: readonly FrenteAoVivo[]): Map<number, FrenteAoVivo> {
  const out = new Map<number, FrenteAoVivo>();
  for (const f of frentes) if (f.estado === 'trabalhando') for (const i of f.blocos) out.set(i, f);
  return out;
}

/**
 * Os trechos como a tela mostra durante a edição: o da frente que está escrevendo troca pelo texto que chega (o
 * primeiro trecho dela recebe o texto; os outros somem enquanto ela reescreve).
 */
export function trechosAoVivo(trechos: readonly string[], frentes: readonly FrenteAoVivo[]): Array<{ texto: string; escrevendo: FrenteAoVivo | null }> {
  const out = trechos.map((texto) => ({ texto, escrevendo: null as FrenteAoVivo | null }));
  for (const f of frentes) {
    if (f.estado !== 'trabalhando' || f.aoVivo === null || !f.blocos.length) continue;
    f.blocos.forEach((i, k) => { if (out[i]) out[i] = { texto: k === 0 ? f.aoVivo! : '', escrevendo: k === 0 ? f : null }; });
  }
  return out;
}
