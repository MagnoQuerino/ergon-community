/**
 * Ponto único de encaixe do cliente do Ergon World no servidor local. O núcleo não importa nada de server/src/world
 * diretamente: só carrega o módulo, se ele existir. Sem o endereço do World, o módulo só responde o estado e a
 * instalação segue 100% local.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import type { Bus } from './services/bus.ts';
import type { AuthContext } from './services/auth.ts';
import type { Vault } from './security/keys.ts';
import type { HermesControlClient } from './services/hermes.ts';
import type { AgentLimits } from './services/capacity.ts';
import type { Routines } from './services/routines.ts';
import type { CloudTaskBrief } from './services/teamwork.ts';

/**
 * Cards do quadro que rodam na nuvem (agente com o modelo da pessoa): o que o card mandaria ao agente, o aceite, a
 * resposta de volta no mesmo card e a chave do provedor do agente (lida só aqui no servidor; nunca vai à tela nem ao log).
 */
export interface CloudTasksHost {
  brief(workspaceId: string, taskId: string): CloudTaskBrief;
  handedOff(workspaceId: string, taskId: string): void;
  finished(workspaceId: string, taskId: string, r: { key: string; agentId: string; input: string; status: 'succeeded' | 'failed'; output: string | null; error: string | null; model: string | null }): void;
  /** a chave própria do provedor (OpenAI, Anthropic, DeepSeek, OpenRouter) guardada neste computador; null: não há */
  providerKey(workspaceId: string, provider: string): string | null;
  /** o modelo padrão da equipe (para o agente sem modelo próprio) */
  defaultModel(workspaceId: string): { provider: string | null; model: string | null };
  /** uma linha curta no histórico do card */
  note(workspaceId: string, taskId: string, action: string, text: string): void;
}

export interface WorldStatus {
  /** o módulo opcional está nesta instalação */
  available: boolean;
  /** endereço do serviço configurado; sem ele, a instalação segue local */
  configured: boolean;
}

export interface WorldHost {
  app: FastifyInstance;
  cfg: Config;
  db: Db;
  bus: Bus;
  vault: Vault;
  /** rotas sem sessão local */
  publicRoutes: Set<string>;
  auth(req: FastifyRequest): AuthContext;
  owner(req: FastifyRequest): AuthContext;
  admin(req: FastifyRequest): AuthContext;
  /** ponte de controle do motor de IA do workspace (o motor da pessoa dona dele) */
  controlFor(workspaceId: string): HermesControlClient | null;
  routines: Routines;
  limits: AgentLimits;
  /** cards do quadro na nuvem; ausente = só as rotinas vão */
  tasks?: CloudTasksHost;
  /** pacotes .ergon (a Loja do World instala pelo mesmo caminho e com a mesma validação) */
  packages?: PackagesHost;
}

/** O que a Loja do World usa dos pacotes locais: as chaves oficiais, a prévia e a instalação de sempre. */
export interface PackagesHost {
  keys: Record<string, string>;
  preview(workspaceId: string, buf: Buffer): unknown;
  install(workspaceId: string, userId: string, buf: Buffer): unknown;
}

export interface WorldModule {
  status(): WorldStatus;
  register(host: WorldHost): Promise<void>;
}

/** Carrega server/src/world/index.ts se existir; senão, null. */
export async function loadWorld(cfg: Config, dir = path.join(import.meta.dirname, 'world')): Promise<WorldModule | null> {
  const entry = path.join(dir, 'index.ts');
  if (!fs.existsSync(entry)) return null;
  const mod = await import(entry.startsWith('/') ? entry : `file:///${entry.replace(/\\/g, '/')}`) as { createWorld(cfg: Config): WorldModule };
  return mod.createWorld(cfg);
}
