/**
 * Quantos trabalhos andam ao mesmo tempo. Conversa com você nunca espera: não entra no limite (antes, uma pesquisa
 * longa de um agente travava a conversa com outro). Processos entram: cards da fila,
 * rotinas, revisões, delegações e análises. O que passa do limite não é recusado: espera a vez (cards em "A fazer",
 * na ordem da fila; o resto, na fila do executor).
 */
import os from 'node:os';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { getSetting } from './sectors.ts';

/** Execuções que são conversa com você (mensagem, continuação depois de autorizar, preparo de rotina, rascunho de agente, entrega de um pedido). */
const CONVERSATION_KEYS = ['chat-', 'perm-', 'setup-', 'draft-', 'entrega-'];
export const isConversationKey = (key: string): boolean => CONVERSATION_KEYS.some((p) => key.startsWith(p));
/** Condição SQL (sobre runs) das execuções que são processo. */
export const PROCESS_SQL = `NOT (${CONVERSATION_KEYS.map((p) => `idempotency_key LIKE '${p}%'`).join(' OR ')})`;

export const SETTING = 'runs.max_processes';
/** teto do que a tela aceita como número (acima disso, "sem limite") */
export const MAX_CHOICE = 32;

/**
 * Padrão desta máquina: um processo a cada 4 GB de memória, sem passar do número de núcleos nem de 6. Dentro do Docker,
 * a memória é a que o Docker recebeu (é dela que o motor de IA vive), não a do computador inteiro.
 */
export function machineDefault(memBytes = os.totalmem(), cpus = os.availableParallelism()): number {
  return Math.max(1, Math.min(Math.floor(memBytes / 1024 ** 3 / 4), cpus, 6));
}

export type Choice = 'auto' | 'ilimitado' | number;
export const parseChoice = (v: string | null): Choice => {
  if (v === 'ilimitado') return 'ilimitado';
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CHOICE ? n : 'auto';
};

export interface ProcessLimit {
  /** null = sem limite */
  limit: number | null;
  choice: Choice;
  /** padrão desta máquina (o que "automático" usa) */
  machine: number;
  /** teto de quem opera o Ergon (na nuvem, o plano); null = sem teto */
  cap: number | null;
  memoryGb: number; cpus: number;
}

/** Limite de processos ao mesmo tempo no workspace: a sua escolha (ou o padrão da máquina), sob o teto do plano. */
export function processLimit(db: Db, cfg: Pick<Config, 'maxConcurrentRuns'>, workspaceId: string): ProcessLimit {
  const choice = parseChoice(getSetting(db, workspaceId, SETTING));
  const machine = machineDefault();
  const cap = cfg.maxConcurrentRuns > 0 ? cfg.maxConcurrentRuns : null;
  const wanted = choice === 'auto' ? machine : choice === 'ilimitado' ? null : choice;
  const limit = cap === null ? wanted : wanted === null ? cap : Math.min(wanted, cap);
  return { limit, choice, machine, cap, memoryGb: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10, cpus: os.availableParallelism() };
}

/** Processos do workspace trabalhando agora (esperando a sua decisão não ocupa vaga: não gasta o motor). */
export function runningProcesses(db: Db, workspaceId: string): number {
  return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'running' AND ${PROCESS_SQL}`, workspaceId)?.n ?? 0);
}
