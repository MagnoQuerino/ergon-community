/**
 * Ponto único de encaixe de um módulo opcional no servidor local. O núcleo não importa nada de server/src/world
 * diretamente: só carrega o módulo, se ele existir. A Community não traz essa pasta e funciona igual, sem rede.
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

export interface WorldStatus {
  /** o módulo opcional está nesta instalação */
  available: boolean;
  /** endereço do serviço configurado; sem ele, a instalação segue local */
  configured: boolean;
  /** última autorização online confirmada pelo serviço (ISO), quando configurado */
  lastAuthorizedAt?: string | null;
}

export interface WorldHost {
  app: FastifyInstance;
  cfg: Config;
  db: Db;
  bus: Bus;
  vault: Vault;
  /** rotas sem sessão local (ex.: volta do login da Conta Ergon) */
  publicRoutes: Set<string>;
  auth(req: FastifyRequest): AuthContext;
  owner(req: FastifyRequest): AuthContext;
  admin(req: FastifyRequest): AuthContext;
  /** ponte de controle do motor de IA do workspace (o motor da pessoa dona dele) */
  controlFor(workspaceId: string): HermesControlClient | null;
  routines: Routines;
  limits: AgentLimits;
}

export interface WorldModule {
  status(): WorldStatus;
  register(host: WorldHost): Promise<void>;
}

/** Carrega server/src/world/index.ts se existir; senão, null (Community). */
export async function loadWorld(cfg: Config, dir = path.join(import.meta.dirname, 'world')): Promise<WorldModule | null> {
  if (cfg.distribution !== 'proprietary') return null;
  const entry = path.join(dir, 'index.ts');
  if (!fs.existsSync(entry)) return null;
  const mod = await import(entry.startsWith('/') ? entry : `file:///${entry.replace(/\\/g, '/')}`) as { createWorld(cfg: Config): WorldModule };
  return mod.createWorld(cfg);
}
