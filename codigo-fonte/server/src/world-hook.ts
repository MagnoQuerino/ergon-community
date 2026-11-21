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
import type { Integrations } from './services/integrations.ts';

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
  /** o Ergon AI guardado no motor do workspace: conferir a conexão e migrar as escolhas de modelo antigas */
  ergonAi?: ErgonAiHost;
  /** os canais externos (services/canais/externo.ts): o papel de cada membro e quem saiu do workspace no World */
  canais?: CanaisWorldHost;
  /** cria um workspace local da pessoa (baixar para este computador um workspace que está no World) */
  createWorkspace?: (userId: string, name: string) => string;
  /** os canais (Discord, Telegram, Teams) com a nuvem do Ergon World: a nuvem responde com o computador fechado */
  canaisNuvem?: CanaisNuvemHost;
  /** as conexões desta instalação: com a nuvem do Ergon World, as que a pessoa escolher vão (cifradas só para ela) ao contêiner */
  integrations?: Integrations;
  /** nuvem do Ergon World: o contêiner terminou de se preparar (workspace recebido, modelo ligado) */
  nuvemPronta?: (x: { userId: string; workspaceId: string; syncWorkspaceId: string }) => Promise<void> | void;
}

/** Os canais oficiais (services/teams-app) vistos pela nuvem do Ergon World. */
export interface CanaisNuvemHost {
  /** no computador: declara (ou tira, com null) a nuvem como quem responde pelas contas ligadas neste workspace */
  reserva(workspaceId: string, x: { installationId: string; syncWorkspaceId: string; /** o comprovante do World (só o dono recebe) */ ticket?: { exp: number; mac: string } | null } | null): void;
  /** na nuvem: o workspace está pronto; as contas ligadas no computador passam a ser atendidas aqui */
  atender(x: { userId: string; workspaceId: string; syncWorkspaceId: string }): void;
  /** há um serviço de canais configurado nesta instalação (sem ele, ninguém espera a instalação) */
  ligavel(): boolean;
  /** a instalação deste Ergon no serviço dos canais (null: ainda não ligada) */
  instalacao(): string | null;
  /** mensagens recebidas pela sincronia (outro aparelho já respondeu por elas no canal) */
  sincronizadas(workspaceId: string, messageIds: string[]): void;
  /** a equipe está atendendo alguém por um canal agora */
  ocupado(): boolean;
}

/** Os canais externos, vistos pelo World: quem fala pelo WhatsApp/Telegram/Discord fala com o papel que tem no World. */
export interface CanaisWorldHost {
  /** o World entrega a busca da lista de membros de um workspace local ligado (null: não ligado ou sem conexão) */
  ligar(buscarMembros: (workspaceId: string) => Promise<Array<{ accountId: string; role: string }> | null>): void;
  /** a lista de membros que o app acabou de buscar (tela de membros, renovação) */
  membros(workspaceId: string, membros: Array<{ accountId: string; role: string }>): void;
  /** alguém foi tirado do workspace no World: os canais dele caem na hora */
  saiu(workspaceId: string, accountId: string): void;
  /** a renovação da autorização: busca os papéis de novo */
  atualizar(workspaceId: string): void;
}

/** O Ergon AI do workspace, visto pelo World (services/ai.ts). */
export interface ErgonAiHost {
  /** os modelos que o endpoint guardado lista; null: o Ergon AI não está ligado */
  modelos(workspaceId: string): Promise<string[] | null>;
  /** o Ergon AI é o modelo padrão da equipe */
  ehPadrao(workspaceId: string): Promise<boolean>;
  /** ids antigos (deepseek-*) → apelidos da marca: o padrão, os modelos por tarefa e o modelo próprio de cada agente */
  migrar(workspaceId: string): Promise<{ padrao: boolean; tarefas: number; agentes: number }>;
}

/** O que a Loja do World usa dos pacotes locais: as chaves oficiais, a prévia e a instalação de sempre. */
export interface PackagesHost {
  keys: Record<string, string>;
  preview(workspaceId: string, buf: Buffer): unknown;
  install(workspaceId: string, userId: string, buf: Buffer): unknown;
}

export interface WorldModule {
  status(): WorldStatus;
  /** antes de abrir o banco (nuvem do Ergon World: o cofre do contêiner abre com a chave guardada no World) */
  prepare?(vault: Vault): Promise<void>;
  register(host: WorldHost): Promise<void>;
}

/** Carrega server/src/world/index.ts se existir; senão, null. */
export async function loadWorld(cfg: Config, dir = path.join(import.meta.dirname, 'world')): Promise<WorldModule | null> {
  const entry = path.join(dir, 'index.ts');
  if (!fs.existsSync(entry)) return null;
  const mod = await import(entry.startsWith('/') ? entry : `file:///${entry.replace(/\\/g, '/')}`) as { createWorld(cfg: Config): WorldModule };
  return mod.createWorld(cfg);
}
