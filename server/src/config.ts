import fs from 'node:fs';
import path from 'node:path';
import { KDF_STRONG, KDF_TEST, type KdfParams } from './security/crypto.ts';

export type ExecutorMode = 'simulated' | 'hermes';
/**
 * Distribuição: 'proprietary' carrega o módulo opcional em server/src/world, se existir; a Community não traz esse
 * módulo e funciona sem rede. Não confundir com `mode`
 * (local/cloud), que trata do antigo motor hospedado.
 */
export type Distribution = 'proprietary' | 'community';

export interface Config {
  /** local (um computador, dados cifrados com a senha) ou cloud (serviço hospedado; 2º fator obrigatório) */
  mode: 'local' | 'cloud';
  /** proprietária (padrão) ou Community; ver Distribution */
  distribution: Distribution;
  /** loja: pasta dos pacotes oficiais embutidos, índice público dos modelos da comunidade e o fetch (testes) */
  catalogDir?: string;
  communityCatalogUrl?: string;
  catalogFetch?: typeof fetch;
  /** endereço pelo qual as pessoas abrem o Ergon (passkeys exigem nome, não IP; padrão http://localhost:<porta>) */
  publicUrl: string;
  /** custo do Argon2id (senhas e frase); testes usam o perfil leve */
  kdf: KdfParams;
  /** receptor do cofre do motor de IA (gocryptfs no contêiner dele) */
  hermesVaultUrl: string | null;
  /** manifesto da versão publicada (aviso de atualização); vazio = não consulta */
  updateUrl: string | null;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  filesDir: string;
  backupsDir: string;
  webDir: string | null;
  allowedOrigins: string[];
  cookieSecure: boolean;
  setupToken: string | null;
  executor: ExecutorMode;
  hermesUrl: string;
  hermesApiKey: string | null;
  /** ponte de controle do plugin do Ergon no contêiner do motor (contas, modelo padrão, skills) */
  hermesControlUrl: string | null;
  /** gerente de motores (um motor de IA por pessoa); vazio = um motor só para todos */
  motorManagerUrl: string | null;
  /** motor de uma pessoa sem uso por este tempo desliga sozinho (volta quando ela precisar) */
  motorIdleMinutes: number;
  /** login com a conta (SSO parametrizado, sso.ts). Microsoft: app público no Entra (PKCE, sem segredo). */
  msClientId: string | null;
  /** Google: cliente OAuth "Aplicativo da Web" no Google Cloud (PKCE + segredo, que fica em ergon.env) */
  googleClientId: string | null;
  googleClientSecret: string | null;
  /** app do Google em modo de teste (o normal numa instalação própria): a autorização vale 7 dias */
  googleTesting: boolean;
  /** endereço base de volta do login (padrão http://localhost:<porta>), se o Ergon for aberto por outro endereço */
  oauthRedirectBase: string | null;
  bridgeToken: string | null;
  /** ajudante do computador (fora do Docker): guarda a chave do destrancar sozinho no cofre do sistema */
  agentToken: string | null;
  /** teto de processos ao mesmo tempo por workspace (na nuvem, o do plano); 0 = sem teto: vale a escolha do usuário */
  maxConcurrentRuns: number;
  runTimeoutSeconds: number;
  /** quem pesquisa na web ou executa código: ler várias páginas leva mais que uma resposta */
  longRunTimeoutSeconds: number;
  maxRunAttempts: number;
  dailyRunLimit: number;
  maxInputChars: number;
  /** contexto que o próprio Ergon monta para uma execução (fatos de rotina, card da equipe); o texto digitado usa maxInputChars */
  maxContextChars: number;
  /** contexto das rotinas que leem documentos (revisor, secretário, comparador…): o texto dos arquivos precisa caber */
  maxDocumentChars: number;
  maxConversationMessages: number;
  slotsPerFloor: number;
  /** rodadas máximas da revisão socrática (perguntas → respostas) */
  reviewMaxRounds: number;
  maxFloors: number;
  /**
   * agentes ativos por workspace: só na nuvem, conforme o plano (0 = sem limite). No local não há limite — a
   * cidade cresce sozinha quando falta vaga.
   */
  maxAgents: number;
  /** sem vaga para um agente novo, a cidade cresce sozinha (padrão no local; desligue para controlar a capacidade à mão) */
  autoGrow: boolean;
  /** por arquivo enviado (padrão 50 MB). No local o total não tem limite: usa o disco do usuário */
  maxUploadBytes: number;
  /** total de arquivos por workspace: só na nuvem, conforme o plano (0 = sem limite) */
  maxStorageBytes: number;
  fixturesEnabled: boolean;
  fixturesDir: string;
  teams: { enabled: boolean; tenantId: string | null; allowedUsers: string[]; botId: string | null };
  whatsapp: { enabled: boolean; ownerIds: string[]; monitoredChats: string[]; sendEnabled: boolean };
  simulatedDelayMs: number;
  workerTickMs: number;
  leaseSeconds: number;
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? def : Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`valor inválido: ${v} (esperado ${min}..${max})`);
  return n;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase());
}

function secret(v: string | undefined, minLen: number, name: string): string | null {
  if (!v) return null;
  if (v.length < minLen) throw new Error(`${name} precisa ter ao menos ${minLen} caracteres`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(env.ERGON_DATA_DIR ?? './.data');
  const port = int(env.ERGON_PORT, 8787, 1, 65535);
  const executor = (env.ERGON_EXECUTOR ?? 'simulated') as ExecutorMode;
  if (executor !== 'simulated' && executor !== 'hermes') throw new Error('ERGON_EXECUTOR deve ser simulated ou hermes');
  const mode = (env.ERGON_MODE ?? 'local') as Config['mode'];
  // sem ERGON_DISTRIBUTION: proprietary só quando o módulo opcional (server/src/world) está presente
  const distribution = (env.ERGON_DISTRIBUTION || (fs.existsSync(path.join(import.meta.dirname, 'world')) ? 'proprietary' : 'community')) as Distribution;
  if (distribution !== 'proprietary' && distribution !== 'community') throw new Error('ERGON_DISTRIBUTION deve ser proprietary ou community');
  if (mode !== 'local' && mode !== 'cloud') throw new Error('ERGON_MODE deve ser local ou cloud');
  const publicUrl = (env.ERGON_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(publicUrl)) throw new Error('ERGON_PUBLIC_URL inválida (ex.: http://localhost:8787)');
  const cfg: Config = {
    mode, distribution, publicUrl,
    communityCatalogUrl: env.ERGON_COMMUNITY_CATALOG_URL?.startsWith('https://') ? env.ERGON_COMMUNITY_CATALOG_URL : undefined,
    kdf: env.ERGON_KDF === 'test' ? KDF_TEST : KDF_STRONG,
    hermesVaultUrl: env.ERGON_HERMES_VAULT_URL || null,
    updateUrl: env.ERGON_UPDATE_URL?.startsWith('https://') ? env.ERGON_UPDATE_URL : null,
    host: env.ERGON_HOST ?? '127.0.0.1',
    port,
    dataDir,
    dbPath: path.join(dataDir, 'db', 'ergon.sqlite'),
    filesDir: path.join(dataDir, 'files'),
    backupsDir: path.join(dataDir, 'backups'),
    webDir: env.ERGON_WEB_DIR ? path.resolve(env.ERGON_WEB_DIR) : null,
    allowedOrigins: list(env.ERGON_ALLOWED_ORIGINS).length
      ? list(env.ERGON_ALLOWED_ORIGINS)
      : [...new Set([publicUrl, `http://localhost:${port}`, `http://127.0.0.1:${port}`])],
    cookieSecure: bool(env.ERGON_COOKIE_SECURE, false),
    setupToken: env.ERGON_SETUP_TOKEN || null,
    executor,
    hermesUrl: env.ERGON_HERMES_URL ?? 'http://hermes:8642',
    hermesApiKey: secret(env.ERGON_HERMES_API_KEY, 8, 'ERGON_HERMES_API_KEY'),
    hermesControlUrl: env.ERGON_HERMES_CONTROL_URL || null,
    motorManagerUrl: env.ERGON_MOTOR_MANAGER_URL && /^https?:\/\/[\w.-]+(:\d+)?$/.test(env.ERGON_MOTOR_MANAGER_URL) ? env.ERGON_MOTOR_MANAGER_URL : null,
    motorIdleMinutes: int(env.ERGON_MOTOR_IDLE_MINUTES, 120, 10, 7 * 24 * 60),
    msClientId: env.ERGON_MS_CLIENT_ID && /^[0-9a-f-]{36}$/i.test(env.ERGON_MS_CLIENT_ID) ? env.ERGON_MS_CLIENT_ID : null,
    googleClientId: env.ERGON_GOOGLE_CLIENT_ID && /^[\w-]+\.apps\.googleusercontent\.com$/.test(env.ERGON_GOOGLE_CLIENT_ID) ? env.ERGON_GOOGLE_CLIENT_ID : null,
    googleClientSecret: secret(env.ERGON_GOOGLE_CLIENT_SECRET, 16, 'ERGON_GOOGLE_CLIENT_SECRET'),
    googleTesting: env.ERGON_GOOGLE_TESTING !== '0',
    oauthRedirectBase: env.ERGON_OAUTH_REDIRECT_BASE && /^https?:\/\/[\w.:-]+$/.test(env.ERGON_OAUTH_REDIRECT_BASE) ? env.ERGON_OAUTH_REDIRECT_BASE : null,
    bridgeToken: secret(env.ERGON_BRIDGE_TOKEN, 24, 'ERGON_BRIDGE_TOKEN'),
    agentToken: secret(env.ERGON_AGENT_TOKEN, 24, 'ERGON_AGENT_TOKEN'),
    // conversas não entram no limite; processos seguem a escolha do usuário (padrão: pela memória da máquina)
    maxConcurrentRuns: int(env.ERGON_MAX_CONCURRENT_RUNS, 0, 0, 64),
    runTimeoutSeconds: int(env.ERGON_RUN_TIMEOUT_SECONDS, 180, 5, 3600),
    longRunTimeoutSeconds: int(env.ERGON_LONG_RUN_TIMEOUT_SECONDS, 600, 5, 3600),
    maxRunAttempts: int(env.ERGON_MAX_RUN_ATTEMPTS, 2, 1, 5),
    dailyRunLimit: int(env.ERGON_DAILY_RUN_LIMIT, 100, 1, 100000),
    maxInputChars: int(env.ERGON_MAX_INPUT_CHARS, 4000, 100, 50000),
    maxContextChars: int(env.ERGON_MAX_CONTEXT_CHARS, 16000, 1000, 100000),
    maxDocumentChars: int(env.ERGON_MAX_DOCUMENT_CHARS, 60000, 4000, 200000),
    maxConversationMessages: int(env.ERGON_MAX_CONVERSATION_MESSAGES, 400, 10, 100000),
    slotsPerFloor: int(env.ERGON_SLOTS_PER_FLOOR, 6, 1, 50), // 6 = as mesas de cada planta da Stoa
    reviewMaxRounds: int(env.ERGON_REVIEW_MAX_ROUNDS, 2, 1, 5),
    maxFloors: int(env.ERGON_MAX_FLOORS, 12, 1, 40), // teto técnico por prédio; cada tipo tem o seu máximo (shared/city.ts)
    maxAgents: int(env.ERGON_MAX_AGENTS, 0, 0, 10000),
    autoGrow: bool(env.ERGON_AUTOGROW, mode === 'local'),
    maxUploadBytes: int(env.ERGON_MAX_UPLOAD_BYTES, 50 * 1024 * 1024, 1024, 500 * 1024 * 1024),
    maxStorageBytes: int(env.ERGON_MAX_STORAGE_MB, 0, 0, 10_000_000) * 1024 * 1024,
    fixturesEnabled: bool(env.ERGON_FIXTURES_ENABLED, true),
    fixturesDir: path.resolve(env.ERGON_FIXTURES_DIR ?? path.join(import.meta.dirname, '..', '..', 'fixtures')),
    teams: {
      enabled: bool(env.ERGON_TEAMS_ENABLED, false),
      tenantId: env.ERGON_TEAMS_TENANT_ID || null,
      allowedUsers: list(env.ERGON_TEAMS_ALLOWED_USERS),
      botId: env.ERGON_TEAMS_BOT_ID || null,
    },
    whatsapp: {
      enabled: bool(env.ERGON_WHATSAPP_ENABLED, false),
      ownerIds: list(env.ERGON_WHATSAPP_OWNER_IDS),
      monitoredChats: list(env.ERGON_WHATSAPP_MONITORED_CHATS),
      sendEnabled: bool(env.ERGON_WHATSAPP_SEND_ENABLED, false),
    },
    simulatedDelayMs: int(env.ERGON_SIMULATED_DELAY_MS, 1200, 0, 60000),
    workerTickMs: int(env.ERGON_WORKER_TICK_MS, 500, 20, 60000),
    leaseSeconds: int(env.ERGON_LEASE_SECONDS, 30, 2, 600),
  };
  // nuvem: nada de recurso só-local nem de padrão inseguro — falha ao subir, dizendo o que ajustar
  if (mode === 'cloud') {
    const fix: string[] = [];
    if (!publicUrl.startsWith('https://')) fix.push('ERGON_PUBLIC_URL com https://');
    if (!cfg.cookieSecure) fix.push('ERGON_COOKIE_SECURE=true');
    if (!cfg.setupToken || cfg.setupToken.length < 24) fix.push('ERGON_SETUP_TOKEN com 24+ caracteres (ninguém de fora cria o proprietário)');
    if (cfg.fixturesEnabled) fix.push('ERGON_FIXTURES_ENABLED=false');
    if (cfg.whatsapp.enabled) fix.push('ERGON_WHATSAPP_ENABLED=false (WhatsApp por QR é só local; na nuvem, a API oficial)');
    if (fix.length) throw new Error(`modo nuvem: ajuste ${fix.join('; ')}`);
  }
  return { ...cfg, ...overrides };
}
