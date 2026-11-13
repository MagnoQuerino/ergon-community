// Modelos por tarefa: a lógica da seção (components/ModelosPorTarefa.tsx), sem tela, para o teste conferir.
// A lista vem do servidor (/api/ai/task-models) com TODAS as tarefas de apoio que a equipe de IA tiver; aqui ficam o
// nome claro e a explicação de cada uma (dicionário), o resumo da seção e o que a sugestão de economia manda gravar.
import type { Chave } from '../i18n/index.ts';
import type { Billing, ModelEntry } from './types.ts';

export interface ContaDoCusto { id: string; name: string; billing: Billing }
export interface OndeRoda { provider: string | null; model: string | null; label: string; account: ContaDoCusto | null }
export interface TaskModelRow {
  task: string; kind: 'apoio' | 'ajudantes';
  /** a escolha gravada; os dois nulos = usa o principal */
  provider: string | null; model: string | null;
  runs: OndeRoda;
  /** tarefa trazida por um complemento: o nome e a explicação que ele declarou (não passam pelo dicionário) */
  declared?: { label: string; hint: string; by: string; follows: string | null };
}
export interface TaskModels { supported: boolean; main: OndeRoda; tasks: TaskModelRow[] }
export interface ModeloSugerido { provider: string; model: string; label: string; tier: ModelEntry['tier']; input: number | null; output: number | null; account: ContaDoCusto }
export interface EconomySuggestion {
  model: ModeloSugerido | null;
  changes: Array<{ task: string; from: OndeRoda; to: ModeloSugerido }>;
  kept: Array<{ task: string; reason: 'same' | 'vision' }>;
  reason: 'unsupported' | 'none' | 'main' | null;
}
export interface TaskModelChange { task: string; provider: string | null; model: string | null }

/** A linha dos ajudantes temporários (a mesma chave do servidor). */
export const TAREFA_AJUDANTES = 'delegation';

/** O nome e a explicação de cada tarefa conhecida, nos dicionários (pt/conexoes.ts e en/conexoes.ts). */
export const TEXTO_DA_TAREFA = {
  vision: { nome: 'conexoes.tarefa.vision.nome', oque: 'conexoes.tarefa.vision.oque' },
  compression: { nome: 'conexoes.tarefa.compression.nome', oque: 'conexoes.tarefa.compression.oque' },
  skills_hub: { nome: 'conexoes.tarefa.skills_hub.nome', oque: 'conexoes.tarefa.skills_hub.oque' },
  approval: { nome: 'conexoes.tarefa.approval.nome', oque: 'conexoes.tarefa.approval.oque' },
  mcp: { nome: 'conexoes.tarefa.mcp.nome', oque: 'conexoes.tarefa.mcp.oque' },
  title_generation: { nome: 'conexoes.tarefa.title_generation.nome', oque: 'conexoes.tarefa.title_generation.oque' },
  review: { nome: 'conexoes.tarefa.review.nome', oque: 'conexoes.tarefa.review.oque' },
  voice_chat: { nome: 'conexoes.tarefa.voice_chat.nome', oque: 'conexoes.tarefa.voice_chat.oque' },
  triage_specifier: { nome: 'conexoes.tarefa.triage_specifier.nome', oque: 'conexoes.tarefa.triage_specifier.oque' },
  kanban_decomposer: { nome: 'conexoes.tarefa.kanban_decomposer.nome', oque: 'conexoes.tarefa.kanban_decomposer.oque' },
  profile_describer: { nome: 'conexoes.tarefa.profile_describer.nome', oque: 'conexoes.tarefa.profile_describer.oque' },
  curator: { nome: 'conexoes.tarefa.curator.nome', oque: 'conexoes.tarefa.curator.oque' },
  background_review: { nome: 'conexoes.tarefa.background_review.nome', oque: 'conexoes.tarefa.background_review.oque' },
  delegation: { nome: 'conexoes.tarefa.delegation.nome', oque: 'conexoes.tarefa.delegation.oque' },
} as const satisfies Record<string, { nome: Chave; oque: Chave }>;
export type TarefaConhecida = keyof typeof TEXTO_DA_TAREFA;
const conhecida = (task: string): task is TarefaConhecida => Object.prototype.hasOwnProperty.call(TEXTO_DA_TAREFA, task);

/**
 * O nome e a explicação de uma tarefa: do dicionário (as conhecidas); o que o complemento declarou (as dele, sem
 * tradução); e, sem nada disso, a própria chave — a tarefa aparece de qualquer jeito, nunca é escondida.
 */
export function textoDaTarefa(row: Pick<TaskModelRow, 'task' | 'declared'>): { nome: { chave: Chave } | { texto: string }; oque: { chave: Chave } | { texto: string } | null } {
  if (conhecida(row.task)) { const x = TEXTO_DA_TAREFA[row.task]; return { nome: { chave: x.nome }, oque: { chave: x.oque } }; }
  if (row.declared) return { nome: { texto: row.declared.label || row.task }, oque: row.declared.hint ? { texto: row.declared.hint } : null };
  return { nome: { texto: row.task }, oque: null };
}

/** Quantas tarefas têm modelo próprio (o resumo da seção recolhida). */
export const comModeloProprio = (tm: TaskModels | null): number => (tm?.tasks ?? []).filter((t) => !!t.provider && !!t.model).length;

/** O que gravar ao aplicar a sugestão de economia: exatamente o que a pessoa viu na prévia. */
export const mudancasDaEconomia = (s: EconomySuggestion): TaskModelChange[] => s.changes.map((c) => ({ task: c.task, provider: c.to.provider, model: c.to.model }));

/**
 * O que a prévia da economia mostra: 'mudancas' (há o que aplicar), ou por que não há nada a aplicar — 'atualizar'
 * (a equipe de IA ainda não tem o recurso), 'semModelo' (nenhum modelo econômico nas contas), 'principal' (o principal
 * já é o mais barato), 'jaEsta' (as tarefas já usam o econômico).
 */
export function situacaoDaEconomia(s: EconomySuggestion): 'mudancas' | 'atualizar' | 'semModelo' | 'principal' | 'jaEsta' {
  if (s.reason === 'unsupported') return 'atualizar';
  if (s.reason === 'none') return 'semModelo';
  if (s.reason === 'main') return 'principal';
  return s.changes.length ? 'mudancas' : 'jaEsta';
}

/** O endereço da lista e da sugestão: do agente (perfil) ou, sem perfil, da equipe da pessoa. */
export const enderecoDaLista = (perfil?: string | null): string => `/api/ai/task-models${perfil ? `?perfil=${encodeURIComponent(perfil)}` : ''}`;
export const enderecoDaEconomia = (perfil?: string | null): string => `/api/ai/task-models/economy${perfil ? `?perfil=${encodeURIComponent(perfil)}` : ''}`;
