import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { normalizeBridge, normalizeTeamsActivity, normalizeWhatsAppMessage, type BridgePayload } from './connectors/normalize.ts';
import type { Db } from './db/db.ts';
import { HttpError, fold, id as newId, notFound, now, redactUrl, safeEqual } from './lib/util.ts';
import { listArtifacts, openArtifact, saveArtifact } from './services/artifacts.ts';
import { createBackup } from './services/backup.ts';
import { diagnostics, healthPanel } from './services/health.ts';
import { log, setLog } from './lib/log.ts';
import { S, idParams, strList } from './lib/schemas.ts';
import { registerIntegrationRoutes } from './routes/integracoes.ts';
import {
  SESSION_COOKIE, checkCredentials, extendSession, logout, needsSetup, resolveSession, setupOwner, switchWorkspace, touchSession, userFactors, requireRecentAuth, type AuthContext,
} from './services/auth.ts';
import { PersonKeySource, Vault } from './security/keys.ts';
import { WorkspaceOwners, isAdmin, openPersonWithPassword, signupPolicy } from './services/people.ts';
import { registerPeopleRoutes } from './routes/pessoas.ts';
import { throttle } from './security/factors.ts';
import { BUILD, UpdateCheck, VERSION, newer } from './version.ts';
import { HermesVaultKeeper, SESSION_DAYS_LOCKED, SESSION_DAYS_OPEN, applyLockChoice, canonicalHostHook, finishPasswordLogin, idleMinutes, protectInstance, registerSecurityRoutes, rpConfig, sessionDays } from './services/security.ts';
import { Bus, audit } from './services/bus.ts';
import { addSimulatedFloor, archiveAgent, capacityInfo, createAgent, ensureCoordinator, limitsFor, reactivateAgent, removeFloor, restoreDefaultTheme, themedCharacters, themedSectors, updateAgent } from './services/capacity.ts';
import { createConversation, listConversations, listMessages, recentConversations, sendMessage, sendQueued } from './services/chat.ts';
import { connectionStatuses } from './services/connections.ts';
import { routeTeamTask } from './services/actions.ts';
import { HttpHermesClient, HttpHermesControl, type HermesClient, type HermesControlClient } from './services/hermes.ts';
import type { AiService } from './services/ai.ts';
import { Motors } from './services/motors.ts';
import { Integrations, setIntegration, type IntegrationKind } from './services/integrations.ts';
import { WhatsAppReader } from './services/whatsapp.ts';
import { answerQuestion, decideProposal, grantPermission, listProposals, parsePermissionRequests, parseProposals, parseTaskProposals, parseToolRelease, pendingCount, pendingDecisions, reconsiderProposal, recordProposals, type Proposal } from './services/proposals.ts';
import { stepsOf, type RequestPayload } from './services/purpose.ts';
import { Routines, upgradeBriefingSources } from './services/routines.ts';
import { activeTeam, coordinatorOf } from './services/team.ts';
import { parseDue } from './services/due.ts';
import { workspaceTz } from './services/routine-proposals.ts';
import { cardDocuments, inboxForChat } from './services/routine-sources.ts';
import { TRAINING_KEY, Trainings } from './services/trainings.ts';
import { NICHES, PRESETS, USES, applyOnboarding, onboardingChoice, onboardingOptions, onboardingState, skipOnboarding } from './services/team-presets.ts';
import { createOwnWorkspace, deleteWorkspace, listWorkspaces, renameWorkspace } from './services/workspaces.ts';
import { readPrefs, writePrefs } from './services/prefs.ts';
import { isSource } from './services/routine-catalog.ts';
import { Teamwork } from './services/teamwork.ts';
import { MAX_CHOICE, PROCESS_SQL, SETTING as PROCESS_SETTING } from './services/concurrency.ts';
import { AccountReader } from './services/account-reader.ts';
import { Operations, taskFiles, linkFile } from './services/operations.ts';
import { KIND_LABEL, Results, WORK_LABEL, type WorkState } from './services/results.ts';
import { autoSector, ensureSectors, listSectors, sectorByKey, setSetting } from './services/sectors.ts';
import { findConnection, ingestEvent, syncConfiguredIdentities, upsertIdentity } from './services/ingest.ts';
import { FixtureTaskProvider, importBoards } from './services/mirror.ts';
import { RunExecutor, draftPrompt, instructionsFor, isCoordinator, parseDraft } from './services/runs.ts';
import { ReviewService } from './services/review.ts';
import { GUARDED_TOOLSETS, TOOLS, grantDataTool, motorScope, platformToolsets, toolStatus, toolsetsFor, upgradeDemoTeam } from './services/characters.ts';
import { addStructureFloor, createStructure, ensureCity, listStructures, moveStructure, removeStructure, renameStructure } from './services/structures.ts';
import { usageSummary } from './services/usage.ts';
import { boardAudience, boardView, createTask, decideLinkProposal, defaultBoard, ensureBoards, getTask, taskLog, updateTask, userBoard } from './services/tasks.ts';
import { USER_COLUMNS } from './services/seed.ts';
import { loadWorld } from './world-hook.ts';
import { exportBlueprint, importBlueprint } from './services/blueprint.ts';
import { Packages } from './services/packages.ts';
import { Catalog, OFFICIAL_KEYS } from './services/catalog.ts';
import { buildPackage, validatePackage } from './services/ergon-package.ts';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
}

export interface AppDeps {
  cfg: Config;
  db: Db;
  hermes?: HermesClient | null;
  /** ponte de controle do plugin (contas, modelo padrão, skills); testes passam um falso */
  control?: HermesControlClient | null;
  /** cofre de chaves da instância (aberto pelo index.ts ou pelo portão de destrancar) */
  vault?: Vault;
  bus?: Bus;
  /** testes: clientes do motor de cada pessoa e o fetch do gerente (um motor por pessoa, sem rede) */
  motorClients?: (userId: string) => { hermes: HermesClient | null; control: HermesControlClient | null };
  motorFetch?: typeof fetch;
}

export interface ErgonApp {
  app: FastifyInstance;
  executor: RunExecutor;
  reviews: ReviewService;
  teamwork: Teamwork;
  operations: Operations;
  results: Results;
  routines: Routines;
  trainings: Trainings;
  ai: AiService;
  integrations: Integrations;
  whatsapp: WhatsAppReader;
  bus: Bus;
  db: Db;
  vault: Vault;
  hermesVault: HermesVaultKeeper;
  motors: Motors;
  /** liga os trabalhos em segundo plano (ferramentas, espelhos, fila da equipe, WhatsApp, cofre do motor) */
  startBackground(): void;
  stopBackground(): Promise<void>;
}

// volta do login com a conta (Microsoft, Google): o navegador chega sem o cookie (SameSite=Strict); o "state" de uso único autentica
const PUBLIC_API = new Set(['/api/health', '/api/distribution', '/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/auth/register', '/api/integrations/microsoft/callback', '/api/integrations/google/callback',
  '/api/auth/login/totp', '/api/auth/passkey/options', '/api/auth/passkey', '/api/auth/recover', '/api/agent/hello', '/api/agent/auto-unlock/claim', '/api/agent/open']);
// com a tela trancada por inatividade, só isto responde (o resto devolve 423 até destrancar)
const LOCKED_OK = new Set(['/api/me', '/api/session/unlock', '/api/session/reauth/options', '/api/session/activity', '/api/auth/logout', '/api/events']);
// nuvem: quem ainda não tem 2º fator só cadastra autenticador ou passkey (428 enroll_2fa)
const ENROLL_OK = new Set([...LOCKED_OK, '/api/security/status', '/api/security/totp/start', '/api/security/totp/confirm', '/api/security/passkeys/options', '/api/security/passkeys', '/api/state']);
// instalação antiga ainda sem criptografia: depois do login, só a proteção e o básico respondem (428)
const UNPROTECTED_OK = new Set([...LOCKED_OK, '/api/security/protect', '/api/security/status', '/api/security/recovery/confirm', '/api/state']);

/** arquivo escolhido para uma rotina (do Ergon ou da nuvem) */
const fileRefSchema = { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { enum: ['ergon', 'microsoft', 'google'] }, id: { type: 'string', minLength: 4, maxLength: 200 }, name: { type: 'string', maxLength: 200 } } };
/** o que a rotina acompanha: listas de texto/endereços ou arquivos escolhidos */
const paramsSchema = { type: 'object', maxProperties: 10, additionalProperties: { type: 'array', maxItems: 30, items: { anyOf: [{ type: 'string', maxLength: 400 }, fileRefSchema] } } };
/** prazo da tarefa: AAAA-MM-DD ou null (tira o prazo) */
const dueSchema = { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] };

export async function buildApp(deps: AppDeps): Promise<ErgonApp> {
  const { cfg, db } = deps;
  const bus = deps.bus ?? new Bus();
  const hermes = deps.hermes !== undefined ? deps.hermes : (cfg.hermesApiKey ? new HttpHermesClient(cfg.hermesUrl, cfg.hermesApiKey) : null);
  const vault = deps.vault ?? new Vault(cfg.dataDir, cfg.kdf);
  // local: a chave de cada workspace é da pessoa dona dele (várias pessoas no mesmo computador)
  const owners = new WorkspaceOwners(db);
  const world = cfg.distribution === 'proprietary' ? await loadWorld(cfg) : null;
  if (vault.state() === 'open' && !db.fieldCipher) db.setCipher(cfg.mode === 'local' ? vault.personKeySource(owners.of) : vault.keySource());
  const personKeys = (): PersonKeySource | null => (db.fieldCipher?.source instanceof PersonKeySource ? db.fieldCipher.source : null);
  // parte fechada (a pessoa ainda não entrou depois de reiniciar): as tarefas de fundo pulam os workspaces dela
  db.workspaceOpen = (ws) => !ws || !db.fieldCipher || db.fieldCipher.canOpen(ws);
  /** A pessoa tem chave e ela ainda não foi aberta nesta execução (ou ainda nem existe: instalação de antes desta versão). */
  const personSealed = (a: { userId: string }) => !!personKeys() && vault.state() === 'open' && !vault.personOpen(a.userId);
  // trancamento: a escolha do usuário; instalação que já chega protegida mantém o que tinha (trancada)
  applyLockChoice(db, vault, cfg, bus, { upgrade: true });
  const hermesVault = new HermesVaultKeeper(cfg, vault);
  const control = deps.control !== undefined ? deps.control : (cfg.hermesControlUrl && cfg.bridgeToken ? new HttpHermesControl(cfg.hermesControlUrl, cfg.bridgeToken) : null);
  // um motor de IA por pessoa (com o gerente de motores) ou um motor só para todos
  const motors = new Motors({ cfg, db, vault, owners, legacy: { hermes, control }, clients: deps.motorClients, fetch: deps.motorFetch });
  const executor = new RunExecutor(db, bus, cfg, motors.perPerson ? (ws) => motors.hermes(ws) : hermes);
  if (motors.perPerson) executor.motorReady = (ws) => motors.ready(ws);
  const reviews = new ReviewService(db, bus, executor, cfg);
  // núcleo operacional: análise determinística de arquivos e conclusão de cards só com evidência
  const opsCfg = { filesDir: cfg.filesDir, maxUploadBytes: cfg.maxUploadBytes, storageQuota: cfg.mode === 'cloud' ? cfg.maxStorageBytes : 0 };
  const operations = new Operations(db, bus, opsCfg);
  const results = new Results(db, bus, operations, opsCfg);
  const teamwork = new Teamwork(db, bus, executor, results, operations, cfg.filesDir);
  const routines = new Routines(db, bus, executor, cfg);
  // Treinar: o /learn do motor escreve a competência em espera; o Ergon mostra, a pessoa aprova (ver trainings.ts)
  const trainings = new Trainings(db, bus, executor, cfg);
  trainings.control = (ws) => motors.control(ws)?.skills_ ?? null;
  executor.onFinish((r, status, output) => {
    if (r.idempotency_key.startsWith(TRAINING_KEY)) void trainings.finished(r, status, output).catch(() => undefined);
  });
  // sugestões da análise semanal viram decisões em "Aguardando você"
  routines.onRecommendations = (ws, conversationId, runId, items) => { recordProposals(db, bus, ws, { conversationId, runId }, items); };
  /** configuração de IA (contas, modelo, ferramentas) do motor de quem é dono do workspace */
  const aiOf = (ws: string): AiService => motors.ai(ws);
  const ai = aiOf(''); // um motor só: o mesmo para todos (testes e instalações sem gerente)
  const integrations = new Integrations(db, bus, cfg);
  // rotinas leem a agenda, os e-mails e as tarefas das contas conectadas (só leitura)
  routines.accounts = new AccountReader(db, integrations.sso, { googleTesting: cfg.googleTesting });
  executor.defaultModel = (ws) => aiOf(ws).cachedDefault();
  // imagens geradas pelos agentes chegam ao Ergon pela ponte de controle (ver RunExecutor.withMedia)
  executor.media = motors.perPerson || control?.media ? async (p, ws) => {
    const c = motors.control(ws);
    if (!c?.media) throw new Error('sem ponte');
    return c.media(p);
  } : null;
  // quem tem Mensagens dos canais, perguntado sobre e-mail ou mensagens numa conversa ou num card, recebe o que chegou
  // (lido agora). No card também: o pedido escrito na conversa vira card e a fila o executa — sem isso, ali a Aspásia
  // não via nada e pedia ajuda a um colega
  // E quem tem Arquivos, num card com documentos anexados, recebe o texto deles (antes: só nome, tipo e tamanho).
  executor.contextFor = async (r) => {
    if (r.kind !== 'chat' && r.kind !== 'subtask') return null;
    if (r.idempotency_key.startsWith(TRAINING_KEY)) return null; // o treinamento recebe só as fontes que a pessoa deu
    let tools: unknown = [];
    try { tools = JSON.parse(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', r.agent_id)?.tools ?? '[]'); } catch { /* sem ferramentas legíveis */ }
    if (!Array.isArray(tools)) return null;
    const tz = workspaceTz(db, r.workspace_id);
    const parts: string[] = [];
    if (r.kind === 'subtask' && r.task_id && tools.includes('arquivos')) {
      const files = taskFiles(db, r.workspace_id, r.task_id).filter((f) => f.role === 'entrada');
      const docs = await cardDocuments(db, cfg.filesDir, r.workspace_id, files, Math.max(2000, cfg.maxContextChars - 4000), tz);
      if (docs) {
        parts.push(docs.text);
        audit(db, null, { workspaceId: r.workspace_id, actorType: 'system', actorId: 'ergon', action: 'agent.context.documentos', targetType: 'run', targetId: r.id,
          evidence: { reads: docs.reads.map((x) => `${x.name}/${x.status}/${x.chars}`) }, result: 'documentos do card lidos para o agente' });
      }
    }
    if (tools.includes('conexoes')) {
      const got = await inboxForChat(db, cfg.filesDir, routines.accounts, r.workspace_id, r.input, tz);
      if (got) {
        parts.push(got.text);
        audit(db, null, { workspaceId: r.workspace_id, actorType: 'system', actorId: 'ergon', action: 'agent.context.mensagens', targetType: 'run', targetId: r.id,
          evidence: { reads: got.reads.map((x) => `${x.account}/${x.what}/${x.status}/${x.count}`) }, result: 'mensagens recebidas lidas para a conversa' });
      }
    }
    return parts.length ? parts.join('\n\n') : null;
  };
  db.run("UPDATE runs SET model = NULL WHERE model IS NOT NULL AND model NOT LIKE '%/%'"); // nome do motor, não do modelo
  const whatsapp = new WhatsAppReader(db, bus, cfg, integrations);
  // workspaces antigos: setores, quadros (equipe × seus) e a equipe de personagens (uma vez; preserva conversas e tarefas)
  const limits = limitsFor(cfg);
  const storageQuota = cfg.mode === 'cloud' ? cfg.maxStorageBytes : 0;
  const bootIssues: Array<{ workspace: string; error: string }> = [];
  const upkept = new Set<string>();
  // uma vez por workspace e por execução; parte fechada fica para quando a pessoa entrar (personOpened)
  const upkeep = (ws: string) => {
    if (upkept.has(ws) || !db.workspaceOpen(ws)) return;
    upkept.add(ws);
    ensureSectors(db, bus, ws); ensureBoards(db, bus, ws, USER_COLUMNS); upgradeDemoTeam(db, bus, ws, cfg.slotsPerFloor); ensureCity(db, bus, ws);
    // o cargo fixo: sempre um Coordenador ativo (uma falha aqui não impede o Ergon de abrir)
    try { ensureCoordinator(db, bus, ws, limits); } catch (err) { bootIssues.push({ workspace: ws, error: (err as Error).message }); }
    grantDataTool(db, bus, ws); // instalações antigas: quem cuida de números recebe a Análise de dados (uma vez)
    upgradeBriefingSources(db, bus, ws); // Briefing já instalado passa a ler as contas conectadas (uma vez)
  };
  for (const w of db.all<{ id: string }>('SELECT id FROM workspaces')) upkeep(w.id);
  /** A parte da pessoa acabou de abrir (entrou, destrancou): o que ficou parado nos workspaces dela volta a andar. */
  const personOpened = (userId: string) => {
    for (const ws of owners.owned(userId)) upkeep(ws);
    void motors.ensure(userId).catch(() => undefined); // o motor dela liga e o cofre dele abre com a chave dela
  };
  // execução da fila que terminou sem decisão (o servidor caiu no meio): decide agora, uma única vez
  const reconciled = results.reconcile();
  // propostas da coordenação escritas na resposta (mudar setor, criar agente, ferramentas): você aplica ou recusa
  executor.onFinish((r, status, output) => {
    if (status !== 'succeeded' || r.kind !== 'chat' || !r.conversation_id) return;
    const ag = db.get<{ name: string; coordinator: number; tools: string | null }>('SELECT a.name, a.coordinator, a.tools FROM agents a WHERE a.id = ?', r.agent_id);
    const purpose = db.get<{ purpose: string | null }>('SELECT purpose FROM conversations WHERE id = ?', r.conversation_id)?.purpose ?? null;
    if (ag && isCoordinator(ag)) {
      recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id }, parseProposals(output));
      // criar ou ajustar rotina conversando (a análise semanal grava as próprias sugestões)
      if (purpose !== 'routine-recommend' && !purpose?.startsWith('routine-setup:')) recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id }, routines.proposalsFrom(r.workspace_id, output, 'chat'));
    }
    // qualquer agente pode pedir uma ferramenta que executa código: vira cartão na conversa, autorizado com a senha
    if (ag) recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id }, parsePermissionRequests(output, ag.name));
    // lembretes com data: quem tem a ferramenta propõe a tarefa sua com prazo; entra aprovada por você
    if (ag && (JSON.parse(ag.tools ?? '[]') as string[]).includes('agenda')) recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id }, parseTaskProposals(output, `conversa com ${ag.name}`));
    // "liga o Terminal" pedido conversando: a coordenação pede a senha ali mesmo; outro agente passa o pedido à
    // coordenação, numa conversa com ela, e avisa aqui com o caminho
    const release = ag ? parseToolRelease(output) : null;
    if (ag && release) {
      const perm = (origin?: string): Proposal => ({ kind: 'permission', agent: release.agent, tool: release.tool, reason: release.reason, ...(origin ? { origin } : {}) });
      if (isCoordinator(ag)) recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id }, [perm()]);
      else {
        const coord = db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", r.workspace_id);
        const owner = db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM conversations WHERE id = ?', r.conversation_id)?.owner_user_id;
        if (coord && owner) {
          const label = TOOLS[release.tool]?.label ?? release.tool;
          const conv = createConversation(db, r.workspace_id, owner, coord.id, `Ligar ${label}`);
          db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)`,
            newId('msg'), r.workspace_id, conv.id, db.seal(r.workspace_id, `Sistema — ${ag.name} passou o seu pedido: ligar ${label}${release.agent ? ` para ${release.agent}` : ' para a equipe'}. Confirme com a sua senha abaixo.`), now());
          recordProposals(db, bus, r.workspace_id, { conversationId: conv.id, runId: null }, [perm(r.conversation_id)]);
          recordProposals(db, bus, r.workspace_id, { conversationId: r.conversation_id, runId: r.id },
            [{ kind: 'handoff', coordinatorId: coord.id, coordinator: coord.name, conversationId: conv.id, agent: release.agent, tool: release.tool }]);
          bus.publish(r.workspace_id, 'messages.changed', { conversationId: conv.id });
        }
      }
    }
  });
  // conversa livre de novo: primeiro a entrega de um pedido que ficou pronto, depois a próxima mensagem da fila (Ctrl+Enter)
  teamwork.onIdle = (ws, conversationId) => {
    if (teamwork.purpose.dispatch(ws, conversationId)) return;
    const note = routines.channelFor(conversationId);
    sendQueued(db, bus, executor, ws, conversationId, { note, plain: !!note });
  };
  executor.onFinish((r) => {
    if (!r.conversation_id) return;
    try { teamwork.onIdle?.(r.workspace_id, r.conversation_id); } catch { /* a varredura da fila tenta de novo */ }
  });
  /**
   * Cancelar um card (seu ou da equipe), pelo próprio card ou pela coordenação com a sua aprovação: o trabalho para,
   * os pedidos abertos fecham e ele sai do quadro com os cards que nasceram dele (ajuda pedida a colegas, o card
   * enviado à equipe); o histórico fica. A conversa de onde o pedido veio fica sabendo que não haverá entrega.
   */
  const cancelCard = (ws: string, userId: string, taskId: string, reason: string): { number: number; also: number[]; result: string } => {
    const t = db.get<{ id: string; number: number; board_id: string; archived: number; completed: number }>(
      'SELECT id, number, board_id, archived, completed FROM tasks WHERE workspace_id = ? AND id = ?', ws, taskId);
    if (!t || Number(t.archived)) throw new HttpError(404, 'task', 'não encontrei esse card no quadro');
    if (db.get("SELECT 1 AS x FROM boards WHERE id = ? AND origin = 'mirror'", t.board_id)) {
      throw new HttpError(409, 'mirror', 'Este card é espelho de um aplicativo: apague lá, e o Ergon acompanha sozinho.');
    }
    const also: number[] = [];
    const drop = (id: string, number: number, completed: boolean, depth: number) => {
      for (const r of db.all<{ id: string }>("SELECT id FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user')", id)) executor.requestCancel(ws, r.id, userId);
      updateTask(db, bus, ws, { type: 'user', id: userId }, id, { archived: true });
      teamwork.purpose.closeRequests(ws, id, 'card cancelado', 'rejected');
      const conv = completed ? null : teamwork.purpose.link(ws, id);
      if (conv) teamwork.purpose.note(ws, conv.conversationId, `Sistema — card #${number} cancelado por você${reason ? `: ${reason}` : ''}. O trabalho parou e não haverá entrega.`);
      if (depth >= 3) return;
      for (const c of db.all<{ id: string; number: number; completed: number }>('SELECT id, number, completed FROM tasks WHERE parent_task_id = ? AND archived = 0', id)) {
        also.push(c.number);
        drop(c.id, c.number, !!Number(c.completed), depth + 1);
      }
    };
    drop(t.id, t.number, !!Number(t.completed), 0);
    const result = `card #${t.number} cancelado${also.length ? `, com ${also.map((n) => `#${n}`).join(', ')}` : ''} (saiu do quadro; o histórico fica)`;
    audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'task.cancelled', targetType: 'task', targetId: t.id,
      evidence: { number: t.number, reason, also }, result: reason ? `${result}: ${reason}` : result });
    return { number: t.number, also, result };
  };
  /** Pela coordenação (proposta aprovada por você): o card vem pelo número. */
  const cancelCardNumber = (ws: string, userId: string, number: number, reason: string): string => {
    const t = db.get<{ id: string }>('SELECT id FROM tasks WHERE workspace_id = ? AND number = ? AND archived = 0', ws, number);
    if (!t) throw new HttpError(404, 'task', `não encontrei o card #${number} no quadro`);
    return cancelCard(ws, userId, t.id, reason).result;
  };
  const timers: NodeJS.Timeout[] = [];
  // uma rodada por vez: com serviço lento (e as novas tentativas), a rodada seguinte não se empilha sobre esta
  let mirrorsBusy = false;
  const syncMirrors = async () => {
    if (mirrorsBusy) return;
    mirrorsBusy = true;
    try { await syncMirrorsOnce(); } finally { mirrorsBusy = false; }
  };
  const syncMirrorsOnce = async () => {
    for (const b of db.all<{ id: string; workspace_id: string; connection_id: string; external_id: string; kind: IntegrationKind; last_synced_at: string | null }>(
      `SELECT b.id, b.workspace_id, b.connection_id, b.external_id, i.kind, b.last_synced_at FROM boards b JOIN integrations i ON i.id = b.connection_id
        WHERE b.origin = 'mirror' AND i.state = 'connected' AND ws_open(b.workspace_id)`)) {
      try {
        const rep = await importBoards(db, bus, b.workspace_id, b.connection_id, '', integrations.provider(b.workspace_id, b.kind), [b.external_id]);
        // a leitura automática também conta como "última leitura" da conta (antes, só a importação manual contava)
        if (rep.boards[0] && rep.boards[0].state !== 'error') setIntegration(db, b.workspace_id, b.kind, { last_sync_at: now() });
      } catch { /* fica o erro no quadro */ }
    }
  };
  const startBackground = () => {
    if (timers.length) return;
    const refreshAi = () => { for (const x of motors.openAis()) { void x.refreshToolsets(); void x.defaultModel().catch(() => null); } };
    refreshAi();
    timers.push(setInterval(refreshAi, 60_000));
    // um motor por pessoa: quem não usa há algum tempo tem o motor desligado (volta quando precisar)
    if (motors.perPerson) timers.push(setInterval(() => void motors.stopIdle(), 10 * 60_000));
    timers.push(setInterval(() => void syncMirrors(), 5 * 60_000)); // espelho automático das listas escolhidas
    for (const t of timers) t.unref?.();
    teamwork.start();
    routines.start(); // horários das rotinas ativas e a recomendação semanal (se ligada)
    // um motor só: destranca o volume cifrado dele (e de novo se ele reiniciar). Um por pessoa: cada um abre quando a
    // pessoa abre a parte dela (motors.ensure)
    if (!motors.perPerson) hermesVault.start();
    else for (const p of vault.peopleInfo().filter((x) => x.open)) void motors.ensure(p.userId).catch(() => undefined);
    whatsapp.resumeAll(); // só sessões que o usuário já pareou; nunca gera QR sozinho
  };
  const stopBackground = async () => { for (const t of timers.splice(0)) clearInterval(t); teamwork.stop(); routines.stop(); hermesVault.stop(); await whatsapp.stopAll(); };
  // nome do cookie inclui a porta: cookies não separam por porta, e instâncias locais (real/teste) não podem colidir
  const COOKIE = `${SESSION_COOKIE}_${cfg.port}`;
  const bridgeLimiter = new Limiter(120, 60_000);
  syncConfiguredIdentities(db, cfg);

  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.ERGON_LOG_LEVEL ?? 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-ergon-bridge-token"]'], censor: '[redigido]' },
      // o endereço de retorno do login (Microsoft/Google) traz o código de autorização na URL: nunca vai para o log
      serializers: {
        req: (r: { method: string; url: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) =>
          ({ method: r.method, url: redactUrl(r.url), host: r.hostname, remoteAddress: r.ip, remotePort: r.socket?.remotePort }),
      },
    },
    bodyLimit: 256 * 1024,
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  // execuções, rotinas e backup escrevem no mesmo registro (testes: quieto)
  setLog(process.env.NODE_ENV === 'test' ? null : app.log);
  for (const b of bootIssues) app.log.error(b, 'coordenador: não deu para garantir agora (tenta de novo no próximo início)');
  if (reconciled) app.log.info({ reconciled }, 'resultados de execuções recuperados no início');
  await app.register(fastifyCookie);
  app.decorateRequest('auth', null);

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: cfg.maxUploadBytes }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.validation) return reply.status(400).send({ error: 'validation', message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'request', message: err.message });
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'erro interno');
    return reply.status(500).send({ error: 'internal', message: 'erro interno' });
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });

  app.addHook('onRequest', canonicalHostHook(cfg));

  // Sessão, origem e CSRF -------------------------------------------------------------------
  const isWrite = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m);
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (isWrite(req.method)) {
      const origin = req.headers.origin;
      if (origin && !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin', 'origem não permitida');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'origin', 'requisição entre sites bloqueada');
    }
    if (PUBLIC_API.has(url)) return;
    const auth = resolveSession(db, req.cookies[COOKIE], idleMinutes(db));
    if (!auth) throw new HttpError(401, 'unauthenticated', 'faça login');
    if (isWrite(req.method)) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, auth.csrf)) throw new HttpError(403, 'csrf', 'token CSRF inválido');
    }
    if (auth.locked && !LOCKED_OK.has(url)) throw new HttpError(423, 'locked', 'Tela trancada por inatividade: digite a senha para continuar.');
    if (personSealed(auth) && !LOCKED_OK.has(url)) throw new HttpError(423, 'person_sealed', 'Digite a sua senha para abrir os seus dados.');
    if (vault.state() === 'unprotected' && !UNPROTECTED_OK.has(url)) throw new HttpError(428, 'protect_required', 'Proteja o Ergon (senha e frase de recuperação) para continuar.');
    if (cfg.mode === 'cloud' && !ENROLL_OK.has(url)) {
      const f = userFactors(db, auth.userId);
      if (!f.totp && !f.passkeys) throw new HttpError(428, 'enroll_2fa', 'Configure um autenticador ou uma passkey para continuar.');
    }
    // atividade de verdade (escritas e o sinal de mouse/teclado) adia a trava; recargas automáticas (GET) não
    if (!auth.locked && isWrite(req.method)) touchSession(db, auth.tokenHash);
    // sem trancamento, a sessão se renova com o uso (uma vez por dia): quem protege é o computador
    if (sessionDays(cfg, vault) === SESSION_DAYS_OPEN && Date.parse(auth.expiresAt ?? '') < Date.now() + (SESSION_DAYS_OPEN - 1) * 86400_000) {
      extendSession(db, auth.tokenHash, SESSION_DAYS_OPEN);
      setCookie(reply, req.cookies[COOKIE]!, SESSION_DAYS_OPEN);
    }
    req.auth = auth;
  });

  const auth = (req: FastifyRequest): AuthContext => {
    if (!req.auth) throw new HttpError(401, 'unauthenticated', 'faça login');
    return req.auth;
  };
  const owner = (req: FastifyRequest): AuthContext => {
    const a = auth(req);
    if (a.role !== 'owner') throw new HttpError(403, 'forbidden', 'somente o proprietário');
    return a;
  };
  /** Ajustes da instalação (trancamento, backup, saúde, pessoas): só quem administra o Ergon neste computador. */
  const admin = (req: FastifyRequest): AuthContext => {
    const a = auth(req);
    if (cfg.mode === 'local' ? !isAdmin(db, a.userId) : a.role !== 'owner') throw new HttpError(403, 'forbidden', 'somente quem administra o Ergon neste computador');
    return a;
  };
  const setCookie = (reply: FastifyReply, token: string, days = SESSION_DAYS_LOCKED) => reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/', maxAge: days * 86400,
  });

  // Público -------------------------------------------------------------------------------------
  app.get('/api/health', { logLevel: 'warn' }, async () => {
    db.get('SELECT 1 AS ok');
    return { ok: true, service: 'ergon', version: VERSION, build: BUILD, executor: cfg.executor };
  });

  app.get('/api/auth/state', async (req) => {
    const s = resolveSession(db, req.cookies[COOKIE], idleMinutes(db));
    return {
      needsSetup: needsSetup(db), authenticated: !!s, locked: !!s?.locked, sealed: false,
      protected: vault.state() !== 'unprotected', mode: cfg.mode, rpId: rpConfig(cfg).rpID, publicUrl: cfg.publicUrl,
      setupTokenRequired: !!cfg.setupToken,
      // conta nova neste computador (local, Ergon aberto, já com a primeira conta): 'aberto' ou 'convite'
      signup: cfg.mode === 'local' && !!personKeys() && !needsSetup(db) ? signupPolicy(db) : null,
    };
  });

  // Primeiro uso: cria o proprietário, protege tudo (chave mestra, banco e campos cifrados) e devolve a frase
  // de recuperação UMA vez (só vale depois de confirmada).
  app.post('/api/auth/setup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: {
      username: S.str(32, 3), password: S.str(200, 1), displayName: S.str(60), setupToken: S.str(200) } } },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; displayName?: string; setupToken?: string };
    if (cfg.setupToken && !safeEqual(b.setupToken ?? '', cfg.setupToken)) throw new HttpError(403, 'setup_token', 'token de configuração inválido');
    const r = await setupOwner(db, { username: b.username, password: b.password, displayName: b.displayName ?? b.username }, cfg.slotsPerFloor, cfg.kdf);
    const recovery = await protectInstance(db, vault, cfg, { id: r.userId, username: b.username }, b.password, owners.of);
    applyLockChoice(db, vault, cfg, bus); // padrão no computador: sem trancamento (Configurações › Segurança liga)
    personOpened(r.userId);
    const out = finishPasswordLogin(sec, req, reply, r) as { ok: boolean };
    if (cfg.mode === 'cloud') return { ...out, recovery };
    return { ok: true, recovery };
  });

  app.post('/api/auth/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: S.str(32, 1), password: S.str(200, 1) } } },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string };
    // freio progressivo por usuário e por endereço (5 erros → espera crescente)
    throttle.check(`login:${b.username}`); throttle.check(`login-ip:${req.ip}`);
    let who;
    try { who = await checkCredentials(db, b.username, b.password, cfg.kdf); } catch (e) { throttle.fail(`login:${b.username}`); throttle.fail(`login-ip:${req.ip}`); throw e; }
    throttle.ok(`login:${b.username}`);
    if (!(await openPersonWithPassword(db, vault, personKeys(), owners, { id: who.userId, username: b.username }, b.password))) {
      throw new HttpError(409, 'person_key', 'A senha confere, mas não abriu os dados desta conta. Use "Esqueci a senha" com a sua frase de recuperação.');
    }
    personOpened(who.userId);
    return finishPasswordLogin(sec, req, reply, who);
  });

  // Sessão -----------------------------------------------------------------------------------
  app.post('/api/auth/logout', async (req, reply) => {
    logout(db, auth(req).tokenHash);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Versão: a mesma no local e na nuvem; avisa quando sai uma nova (atualizar é decisão da pessoa)
  const updates = new UpdateCheck(cfg.updateUrl);
  app.get('/api/version', async () => {
    const latest = await updates.latest();
    return { version: VERSION, build: BUILD, mode: cfg.mode, latest, updateAvailable: !!latest && newer(latest.version, VERSION) };
  });

  app.get('/api/me', async (req) => {
    const a = auth(req);
    const workspaces = db.all('SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at', a.userId);
    const avatar = db.get<{ avatar: string | null }>('SELECT avatar FROM users WHERE id = ?', a.userId)?.avatar ?? null;
    return { user: { id: a.userId, username: a.username, displayName: a.displayName, avatar }, workspaceId: a.workspaceId, role: a.role, csrf: a.csrf, workspaces, locked: a.locked, protected: vault.state() !== 'unprotected', idleMinutes: idleMinutes(db),
      factors: userFactors(db, a.userId), mode: cfg.mode, rpId: rpConfig(cfg).rpID,
      // frase de recuperação da pessoa (várias pessoas: cada uma tem a sua)
      recovery: personKeys() ? vault.personHasRecovery(a.userId) : vault.info().recovery,
      admin: cfg.mode === 'local' ? isAdmin(db, a.userId) : a.role === 'owner', personSealed: personSealed(a), people: vault.peopleInfo().length,
      autoUnlockPrompt: isAdmin(db, a.userId) && secApi.autoUnlockPrompt(),
      onboarding: onboardingState(db, a.workspaceId), prefs: readPrefs(db, a.workspaceId, a.userId) };
  });

  // Minha conta: nome de exibição e foto de perfil (imagem pequena, só PNG/JPEG/WebP)
  app.patch('/api/me', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: S.str(60, 1) } } },
  }, async (req) => {
    const a = auth(req);
    const nome = (req.body as { displayName: string }).displayName.trim().replace(/\s+/g, ' ');
    if (!nome) throw new HttpError(400, 'displayName', 'o nome não pode ficar vazio');
    db.run('UPDATE users SET display_name = ? WHERE id = ?', nome, a.userId);
    return { displayName: nome };
  });
  app.put('/api/me/avatar', {
    bodyLimit: 400_000,
    schema: { body: { type: 'object', additionalProperties: false, required: ['image'], properties: {
      image: { type: 'string', maxLength: 300_000, pattern: '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$' } } } },
  }, async (req) => {
    db.run('UPDATE users SET avatar = ? WHERE id = ?', (req.body as { image: string }).image, auth(req).userId);
    return { ok: true };
  });
  app.delete('/api/me/avatar', async (req) => {
    db.run('UPDATE users SET avatar = NULL WHERE id = ?', auth(req).userId);
    return { ok: true };
  });

  // Preferências da pessoa: dicas (ligar, dispensar, trazer de volta) e tour inicial
  app.put('/api/me/prefs', {
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      tips: { type: 'boolean' }, tourDone: { type: 'boolean' }, resetTips: { type: 'boolean' },
      dismiss: { type: 'array', maxItems: 20, items: S.str(60, 1) } } } },
  }, async (req) => {
    const a = auth(req);
    return writePrefs(db, a.workspaceId, a.userId, req.body as { tips?: boolean; tourDone?: boolean; resetTips?: boolean; dismiss?: string[] });
  });

  // Boas-vindas: como a pessoa vai usar e em que área trabalha definem a equipe de partida (tudo editável depois)
  app.get('/api/onboarding', async (req) => {
    const a = auth(req);
    return { state: onboardingState(db, a.workspaceId), choice: onboardingChoice(db, a.workspaceId), ...onboardingOptions(),
      presets: PRESETS.map((p) => ({ key: p.key, title: p.title, summary: p.summary, size: p.agents.length, sectors: Object.values(p.sectors).map(([n]) => n) })) };
  });
  app.post('/api/onboarding', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['use', 'niche'], properties: {
      use: { enum: USES.map((u) => u.key) }, niche: { enum: NICHES.map((n) => n.key) },
      nicheOther: S.str(60), company: S.str(60), goal: S.str(300), aiConnected: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    return applyOnboarding(db, bus, a.workspaceId, a.userId, req.body as { use: string; niche: string; nicheOther?: string; company?: string; goal?: string; aiConnected?: boolean });
  });
  app.post('/api/onboarding/skip', async (req) => {
    const a = owner(req);
    skipOnboarding(db, bus, a.workspaceId, a.userId);
    return { ok: true };
  });

  const sec = { cfg, db, bus, vault, setCookie, auth, owner, admin, people: { keys: personKeys, owners, opened: personOpened, sealed: personSealed } };
  const secApi = registerSecurityRoutes(app, sec);
  registerPeopleRoutes(app, { ...sec, upkeep: personOpened, removeMotor: (u) => motors.remove(u) });

  app.post('/api/session/workspace', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['workspaceId'], properties: { workspaceId: S.id('ws') } } },
  }, async (req) => {
    switchWorkspace(db, auth(req), (req.body as { workspaceId: string }).workspaceId);
    return { ok: true };
  });
  // Workspaces da pessoa: visão geral, criar (já entra nele) e renomear
  app.get('/api/workspaces', async (req) => { const a = auth(req); return listWorkspaces(db, a.userId, a.workspaceId); });
  app.post('/api/workspaces', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: S.str(60) } } },
  }, async (req, reply) => {
    const a = auth(req);
    const ws = createOwnWorkspace(db, personKeys(), a.userId, (req.body as { name: string }).name, cfg.slotsPerFloor);
    owners.forget();
    upkeep(ws);
    switchWorkspace(db, a, ws);
    audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: a.userId, action: 'workspace.create', result: 'workspace criado' });
    return reply.code(201).send({ workspaceId: ws });
  });
  app.patch('/api/workspaces/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: S.id('ws') } },
      body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: S.str(60) } } },
  }, async (req) => {
    const a = auth(req);
    const id = (req.params as { id: string }).id;
    const name = renameWorkspace(db, a.userId, id, (req.body as { name: string }).name);
    audit(db, bus, { workspaceId: id, actorType: 'user', actorId: a.userId, action: 'workspace.rename', result: 'nome do workspace alterado' });
    return { name };
  });
  app.delete('/api/workspaces/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: S.id('ws') } },
      body: { type: 'object', additionalProperties: false, required: ['confirmName'], properties: { confirmName: S.str(60, 1) } } },
  }, async (req) => {
    const a = auth(req);
    const r = deleteWorkspace(db, cfg, a.userId, (req.params as { id: string }).id, (req.body as { confirmName: string }).confirmName);
    owners.forget();
    audit(db, bus, { workspaceId: r.next, actorType: 'user', actorId: a.userId, action: 'workspace.delete', evidence: { name: r.name }, result: 'workspace excluído (dados, arquivos e chave)' });
    return { ok: true, workspaceId: r.next };
  });

  // Estado geral (snapshot para a interface) -----------------------------------------------------
  app.get('/api/state', async (req) => {
    const a = auth(req);
    const ws = db.get<{ id: string; name: string; demo_data: number }>('SELECT id, name, demo_data FROM workspaces WHERE id = ?', a.workspaceId);
    const agents = db.all(
      `SELECT a.id, a.name, a.role, a.color, a.status, a.demo, a.floor_id, f.level AS floor_level, f.building_id, p.key AS profile, p.name AS sector_name,
              a.char_key, a.bio, a.skills, a.tools, a.model_hint, a.model, a.provider, a.hermes_skills, a.charter, a.deactivation_note, a.coordinator, a.look_seed,
              (SELECT r.status FROM runs r WHERE r.agent_id = a.id AND r.status IN ('queued', 'running', 'waiting_user') ORDER BY r.created_at LIMIT 1) AS run_status,
              (SELECT r.status || '|' || r.finished_at FROM runs r WHERE r.agent_id = a.id AND r.status IN ('succeeded', 'failed', 'cancelled')
                 AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1) AS last_outcome
         FROM agents a JOIN floors f ON f.id = a.floor_id JOIN profiles p ON p.id = a.profile_id
        WHERE a.workspace_id = ? ORDER BY a.status, f.building_id, f.level, a.created_at, a.rowid`, a.workspaceId);
    const counts = db.get<{ running: number; queued: number; waiting: number; processes: number }>(
      `SELECT SUM(status = 'running') AS running, SUM(status = 'queued') AS queued, SUM(status = 'waiting_user') AS waiting,
              SUM(status = 'running' AND ${PROCESS_SQL}) AS processes
         FROM runs WHERE workspace_id = ?`, a.workspaceId);
    const channels = integrations.connectedChannels(a.workspaceId);
    const parse = (v: unknown): string[] => { try { const x = JSON.parse(String(v ?? '[]')); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
    for (const ag of agents as Array<Record<string, unknown>>) {
      ag.skills = parse(ag.skills);
      ag.hermes_skills = parse(ag.hermes_skills);
      ag.tools = parse(ag.tools).map((t) => TOOLS[t]).filter(Boolean).map((t) => toolStatus(t, { channels, workspaceId: a.workspaceId }));
    }
    return {
      workspace: ws, capacity: capacityInfo(db, a.workspaceId, cfg.maxFloors), agents, structures: listStructures(db, a.workspaceId),
      // processos (cards, rotinas, revisões) seguem o limite; conversas não entram nele
      runs: { running: Number(counts?.running ?? 0), queued: Number(counts?.queued ?? 0), waiting: Number(counts?.waiting ?? 0),
        processes: Number(counts?.processes ?? 0), limit: executor.processLimit(a.workspaceId), cardsWaiting: teamwork.queue(a.workspaceId).length },
      // o mesmo que a lista de "aguardando você" (propostas, cards esperando você, perguntas, vínculos e regras)
      decisionsPending: pendingCount(db, a.workspaceId),
      executor: { mode: executor.mode, label: executor.mode === 'real' ? 'modelo de IA real' : 'SIMULAÇÃO — sem modelo de IA' },
      sectors: listSectors(db, a.workspaceId).map(({ instructions: _i, ...s }) => s),
      teamAutorun: teamwork.autorun(a.workspaceId),
      themed: themedCharacters(db, a.workspaceId).length + themedSectors(db, a.workspaceId).length,
      serverTime: now(),
    };
  });

  // Agentes e capacidade -------------------------------------------------------------------------
  app.get('/api/capacity', async (req) => capacityInfo(db, auth(req).workspaceId, cfg.maxFloors));

  const sectorKey = { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,30}$' };
  const modelId = { anyOf: [{ type: 'string', pattern: '^[\\w./:@+-]{1,160}$' }, { type: 'null' }] };
  const providerId = { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,40}$' };

  app.get('/api/sectors', async (req) => listSectors(db, auth(req).workspaceId));

  app.post('/api/agents', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'role'], properties: {
      name: S.str(40, 1), role: S.str(80, 1), sectorKey: { anyOf: [{ const: 'auto' }, sectorKey] }, profileKey: sectorKey,
      structureId: S.id('bld'), floorId: S.id('flr'), color: S.str(7), charter: S.str(4000), skills: strList(12, 80), tools: strList(20, 30),
      hermesSkills: strList(20, 80), model: modelId, provider: providerId } } },
  }, async (req, reply) => {
    const a = owner(req);
    const b = req.body as Parameters<typeof createAgent>[4];
    if (b.model && b.provider) await aiOf(a.workspaceId).assertModel(b.provider, b.model);
    return reply.status(201).send(createAgent(db, bus, a.workspaceId, a.userId, b, limits));
  });

  app.patch('/api/agents/:id', {
    schema: { params: idParams('agt'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: S.str(40, 1), role: S.str(80, 1), sectorKey, charter: S.str(4000), skills: strList(12, 80), tools: strList(20, 30), bio: S.str(600),
      hermesSkills: strList(20, 80), model: modelId, provider: providerId, color: S.str(7), structureId: S.id('bld'),
      lookSeed: { anyOf: [{ type: 'integer', minimum: 1, maximum: 2147483647 }, { type: 'null' }] } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as Parameters<typeof updateAgent>[5];
    // dar a um agente uma ferramenta que executa código pede a senha (confirmação de identidade recente)
    if (b.tools?.some((t) => TOOLS[t]?.guarded)) {
      const held = JSON.parse(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ? AND workspace_id = ?', (req.params as { id: string }).id, a.workspaceId)?.tools ?? '[]') as string[];
      if (b.tools.some((t) => TOOLS[t]?.guarded && !held.includes(t))) requireRecentAuth(a);
    }
    if (b.model && !b.provider) throw new HttpError(400, 'provider', 'informe a conta do modelo');
    if (b.model && b.provider) await aiOf(a.workspaceId).assertModel(b.provider, b.model);
    updateAgent(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, b);
    return { ok: true };
  });

  // Desativar (antes "arquivar"): a coordenação redistribui tarefas abertas e ferramentas exclusivas
  const deactivate = async (req: FastifyRequest) => {
    const a = owner(req);
    return { ok: true, ...archiveAgent(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id) };
  };
  app.post('/api/agents/:id/deactivate', { schema: { params: idParams('agt') } }, deactivate);
  app.post('/api/agents/:id/archive', { schema: { params: idParams('agt') } }, deactivate);

  // Janela do agente: o que ele fez (execuções com modelo e tokens) e com que tarefas está
  app.get('/api/agents/:id/activity', { schema: { params: idParams('agt') } }, async (req) => {
    const a = auth(req);
    const agentId = (req.params as { id: string }).id;
    if (!db.get('SELECT 1 AS x FROM agents WHERE id = ? AND workspace_id = ?', agentId, a.workspaceId)) throw notFound('agente');
    const runs = db.all(`SELECT id, kind, status, mode, model, tokens_in, tokens_out, cost_usd, created_at, finished_at, error FROM runs
      WHERE agent_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 20`, agentId, a.workspaceId);
    const tasks = db.all(`SELECT t.id, t.number, t.title, t.completed, c.name AS column_name FROM tasks t JOIN columns c ON c.id = t.column_id
      JOIN boards b ON b.id = t.board_id WHERE t.agent_id = ? AND t.workspace_id = ? AND t.archived = 0 AND b.audience = 'team' ORDER BY t.completed, t.number DESC LIMIT 30`, agentId, a.workspaceId);
    const totals = db.get(`SELECT COUNT(*) AS runs, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out FROM runs WHERE agent_id = ? AND workspace_id = ? AND mode = 'real'`, agentId, a.workspaceId);
    return { runs, tasks, totals };
  });

  // Escrever com a coordenação: Aristóteles redige instruções, métodos e ferramentas de um agente novo
  app.post('/api/agents/draft', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'role', 'requestId'], properties: {
      name: S.str(40, 1), role: S.str(80, 1), sectorKey: { anyOf: [{ const: 'auto' }, sectorKey] }, requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' } } } },
  }, async (req, reply) => {
    const a = owner(req);
    const b = req.body as { name: string; role: string; sectorKey?: string; requestId: string };
    const coord = coordinatorOf(activeTeam(db, a.workspaceId));
    if (!coord) throw new HttpError(409, 'no_coordinator', 'nenhum agente ativo para escrever as instruções');
    const key = !b.sectorKey || b.sectorKey === 'auto' ? autoSector(b.role).key : b.sectorKey;
    const s = sectorByKey(db, a.workspaceId, key);
    const run = executor.enqueue({
      workspaceId: a.workspaceId, agentId: coord.id, kind: 'subtask',
      input: draftPrompt({ name: b.name, role: b.role, sector: s.name, sectorDescription: s.description ?? '', tools: Object.values(TOOLS).map((t) => ({ id: t.id, label: t.label })), methods: s.skills }),
      instructions: instructionsFor(db, a.workspaceId, coord.id, 'Canal: configuração da equipe. Responda só com o JSON pedido.'),
      idempotencyKey: `draft-${b.requestId}`,
    });
    return reply.status(202).send({ runId: run.id, sectorKey: s.key, mode: run.mode });
  });

  app.get('/api/agents/draft/:id', { schema: { params: idParams('run') } }, async (req) => {
    const r = executor.get(auth(req).workspaceId, (req.params as { id: string }).id);
    if (!r.idempotency_key.startsWith('draft-')) throw notFound('rascunho');
    const done = ['succeeded', 'failed', 'cancelled'].includes(r.status);
    return { status: r.status, mode: r.mode, error: r.error, draft: r.status === 'succeeded' ? parseDraft(r.output) : null, done };
  });

  // tema padrão: os personagens da equipe de partida voltam aos nomes e histórias gregos (funções ficam)
  app.post('/api/team/restore-theme', async (req) => {
    const a = owner(req);
    return restoreDefaultTheme(db, bus, a.workspaceId, a.userId);
  });

  app.post('/api/agents/:id/reactivate', { schema: { params: idParams('agt') } }, async (req) => {
    const a = owner(req);
    reactivateAgent(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, null, limits);
    return { ok: true };
  });

  // Configuração de IA (contas, modelo padrão, modelos, skills, ferramentas) -----------------------------------
  app.get('/api/ai/status', async (req) => {
    const a = auth(req);
    const st = await aiOf(a.workspaceId).status();
    // o motor da pessoa (conta nova: ligando por até ~1 min): a tela diz o que está acontecendo e confere de novo
    const dono = owners.of(a.workspaceId);
    // só com motor por pessoa (instalação local com gerente): sem ele, "indisponível" é definitivo, não "ligando"
    const motor = motors.perPerson && dono ? motors.state(dono) : null;
    if (!st.available && motor) motors.ready(a.workspaceId);
    return { ...st, motor };
  });
  app.get('/api/ai/models', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { refresh: { enum: ['1', '0'] } } } },
  }, async (req) => aiOf(auth(req).workspaceId).catalog((req.query as { refresh?: string }).refresh === '1'));
  app.post('/api/ai/default-model', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: { provider: providerId, model: { type: 'string', pattern: '^[\\w./:@+-]{1,160}$' }, confirm: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { provider: string; model: string; confirm?: boolean };
    const r = await aiOf(a.workspaceId).setDefault(b.provider, b.model, !!b.confirm);
    if (r.ok) audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.default_model', evidence: { provider: b.provider, model: b.model }, result: 'modelo padrão alterado' });
    return r;
  });
  app.post('/api/ai/accounts/:provider/login', {
    schema: { params: { type: 'object', required: ['provider'], properties: { provider: { enum: ['nous', 'openai-codex'] } } } },
  }, async (req) => {
    const a = owner(req);
    const r = await aiOf(a.workspaceId).startLogin(a.workspaceId, (req.params as { provider: string }).provider);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.login_start', evidence: { provider: r.provider }, result: 'código de acesso gerado' });
    return r;
  });
  const sid = { type: 'object', required: ['sid'], properties: { sid: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } } };
  app.get('/api/ai/logins/:sid', { schema: { params: sid } }, async (req) => {
    const a = owner(req);
    const r = await aiOf(a.workspaceId).pollLogin(a.workspaceId, (req.params as { sid: string }).sid);
    if (r.status === 'approved') audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.login', result: 'conta de IA conectada' });
    return r;
  });
  app.delete('/api/ai/logins/:sid', { schema: { params: sid } }, async (req) => {
    const a = owner(req);
    await aiOf(a.workspaceId).cancelLogin(a.workspaceId, (req.params as { sid: string }).sid);
    return { ok: true };
  });
  app.delete('/api/ai/accounts/:provider', {
    schema: { params: { type: 'object', required: ['provider'], properties: { provider: { enum: ['nous', 'openai-codex'] } } } },
  }, async (req) => {
    const a = owner(req);
    const p = (req.params as { provider: string }).provider;
    await aiOf(a.workspaceId).disconnect(p);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.disconnect', evidence: { provider: p }, result: 'conta de IA desconectada' });
    return { ok: true };
  });
  // Chave própria (BYOK): a chave vai direto para o motor (que confere no provedor); não fica no banco nem no registro
  const byokParams = { type: 'object', required: ['provider'], properties: { provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,40}$' } } };
  app.put('/api/ai/byok/:provider', {
    schema: { params: byokParams, body: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', minLength: 20, maxLength: 300, pattern: '^\\s*[A-Za-z0-9_.-]+\\s*$' } } } },
  }, async (req) => {
    const a = owner(req);
    const p = (req.params as { provider: string }).provider;
    const r = await aiOf(a.workspaceId).setByok(p, (req.body as { key: string }).key);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.byok', evidence: { provider: p, verified: r.verified }, result: 'chave própria conectada' });
    return r;
  });
  // endpoint próprio: "outro" (https na internet), LM Studio ou Ollama (rede local); o motor confere e lista os modelos
  app.post('/api/ai/byok-custom', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'baseUrl'], properties: {
      kind: { enum: ['outro', 'lmstudio', 'ollama'] }, name: S.str(40), baseUrl: { type: 'string', minLength: 8, maxLength: 300, pattern: '^https?://\\S+$' },
      key: { type: 'string', maxLength: 400, pattern: '^[A-Za-z0-9_.:+/=-]*$' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { kind: 'outro' | 'lmstudio' | 'ollama'; name?: string; baseUrl: string; key?: string };
    const r = await aiOf(a.workspaceId).addByokCustom({ kind: b.kind, name: b.name ?? '', baseUrl: b.baseUrl, ...(b.key ? { key: b.key } : {}) });
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.byok_custom', evidence: { kind: b.kind, id: r.id, models: r.models }, result: 'endpoint próprio conectado' });
    return r;
  });
  app.delete('/api/ai/byok-custom/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^byok-[a-z0-9-]{1,40}$' } } } } }, async (req) => {
    const a = owner(req);
    const id = (req.params as { id: string }).id;
    await aiOf(a.workspaceId).removeByokCustom(id);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.byok_custom_remove', evidence: { id }, result: 'endpoint próprio removido' });
    return { ok: true };
  });
  app.delete('/api/ai/byok/:provider', { schema: { params: byokParams } }, async (req) => {
    const a = owner(req);
    const p = (req.params as { provider: string }).provider;
    await aiOf(a.workspaceId).removeByok(p);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.byok_remove', evidence: { provider: p }, result: 'chave própria removida' });
    return { ok: true };
  });
  app.get('/api/ai/tools', async (req) => { const a = auth(req); return aiOf(a.workspaceId).tools({ channels: integrations.connectedChannels(a.workspaceId) }); });
  app.put('/api/ai/tools', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: strList(20, 30) } } },
  }, async (req) => {
    const a = owner(req);
    const wanted = (req.body as { enabled: string[] }).enabled;
    // ligar uma ferramenta que executa código pede a senha (confirmação de identidade recente)
    const on = new Set(platformToolsets(motorScope(a.workspaceId)).enabled);
    if (wanted.some((t) => TOOLS[t]?.guarded && !on.has(TOOLS[t].toolset ?? ''))) requireRecentAuth(a);
    const enabled = await aiOf(a.workspaceId).setPlatformTools(wanted);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'ai.tools', evidence: { enabled }, result: 'ferramentas da equipe atualizadas' });
    bus.publish(a.workspaceId, 'agents.changed', {});
    return { enabled };
  });
  app.get('/api/ai/skills', async (req) => aiOf(auth(req).workspaceId).skills());

  // Propostas da coordenação ----------------------------------------------------------------------------------
  app.get('/api/proposals', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { conversationId: S.id('cnv') } } },
  }, async (req) => listProposals(db, auth(req).workspaceId, (req.query as { conversationId?: string }).conversationId));
  // Pedido de permissão na conversa: a senha (e o código do autenticador, se ligado) autoriza ali mesmo, e o
  // agente continua o pedido sozinho
  app.post('/api/proposals/:id/authorize', {
    schema: { params: idParams('apr'), body: { type: 'object', additionalProperties: false, properties: {
      password: S.str(200, 1), code: S.str(10, 6), key: S.str(80, 6), response: { type: 'object' } } } },
  }, async (req) => {
    const a = owner(req);
    await secApi.verify(req, a, req.body as Record<string, never>);
    const pid = (req.params as { id: string }).id;
    const g = await grantPermission(db, bus, a.workspaceId, a.userId, pid, async (toolId) => {
      const cur = Object.values(TOOLS).filter((t) => t.kind === 'ia' && platformToolsets(motorScope(a.workspaceId)).enabled.includes(t.toolset ?? '')).map((t) => t.id);
      await aiOf(a.workspaceId).setPlatformTools([...new Set([...cur, toolId])]);
    });
    if (g.status === 'applied') {
      const label = TOOLS[g.tool]?.label ?? g.tool;
      const note = (conv: string, text: string, runId: string | null) => {
        db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, run_id, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?, ?)`,
          newId('msg'), a.workspaceId, conv, db.seal(a.workspaceId, text), runId, now());
        bus.publish(a.workspaceId, 'messages.changed', { conversationId: conv });
      };
      const agentOf = (conv: string) => db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ? AND workspace_id = ?', conv, a.workspaceId)?.agent_id ?? null;
      // o agente continua de onde parou, na conversa dele: a do pedido (permissão pedida por ele) ou a de onde o
      // pedido veio (passado à coordenação, que só registra a autorização)
      const cont = g.agentId && g.conversationId && agentOf(g.conversationId) === g.agentId ? g.conversationId
        : g.agentId && g.origin && agentOf(g.origin) === g.agentId ? g.origin : null;
      const run = cont && g.agentId ? executor.enqueue({
        workspaceId: a.workspaceId, agentId: g.agentId, conversationId: cont, kind: 'chat',
        input: `O usuário autorizou agora a ferramenta ${label}. Continue o pedido anterior de onde parou, usando-a.`,
        instructions: instructionsFor(db, a.workspaceId, g.agentId, 'Canal: chat do Ergon. Quem escreve é o proprietário autenticado. Responda em texto curto.'),
        idempotencyKey: `perm-${pid}`,
      }) : null;
      if (g.conversationId && g.conversationId !== cont) note(g.conversationId, `Sistema — você autorizou: ${g.result}.`, null);
      if (cont) note(cont, `Sistema — você autorizou: ${g.result}. O agente continua o pedido.`, run?.id ?? null);
      else if (g.origin && g.origin !== g.conversationId) note(g.origin, `Sistema — você autorizou: ${g.result}.`, null);
    }
    return { status: g.status, result: g.result };
  });
  app.post('/api/proposals/:id', {
    schema: { params: idParams('apr'), body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { enum: ['apply', 'reject'] } } } },
  }, async (req) => {
    const a = owner(req);
    return decideProposal(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, (req.body as { decision: 'apply' | 'reject' }).decision,
      { routine: (p) => routines.applyProposal(a.workspaceId, a.userId, p), ledger: (p, userId) => routines.registerLedger(a.workspaceId, userId, p), limits,
        deleteTask: (n, reason) => cancelCardNumber(a.workspaceId, a.userId, n, reason) });
  });
  // pedido de um card repassado na conversa (informação, aprovação, decisão, nova tentativa): a resposta vai para o card
  const respondSchema = { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['answer', 'approve', 'return', 'retry', 'dismiss'] }, text: S.str(1500) } };
  app.post('/api/proposals/:id/respond', { schema: { params: idParams('apr'), body: respondSchema } }, async (req) => {
    const a = owner(req);
    const p = db.get<{ kind: string; payload: string; status: string }>('SELECT kind, payload, status FROM agent_proposals WHERE id = ? AND workspace_id = ?', (req.params as { id: string }).id, a.workspaceId);
    if (!p || p.kind !== 'info_request') throw notFound('pedido');
    if (p.status !== 'proposed') throw new HttpError(409, 'decided', 'este pedido já foi respondido');
    const b = req.body as { action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss'; text?: string };
    return teamwork.respond(a.workspaceId, a.userId, (JSON.parse(p.payload) as RequestPayload).taskId, b.action, b.text ?? null);
  });
  // pergunta com opções na conversa: a resposta (todas da rodada juntas) volta ao agente como mensagem sua
  app.post('/api/proposals/:id/answer', {
    schema: { params: idParams('apr'), body: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: S.str(300, 1) } } },
  }, async (req) => {
    const a = owner(req);
    const r = answerQuestion(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, (req.body as { answer: string }).answer);
    if (!r.message) return { sent: false };
    const note = routines.channelFor(r.conversationId);
    const sent = sendMessage(db, bus, executor, a.workspaceId, a.userId, r.conversationId, r.message, `respostas-${r.batch.replace(/[^A-Za-z0-9]/g, '').slice(-40)}`, cfg.maxConversationMessages, cfg.maxInputChars, { note, plain: !!note });
    if (note) routines.markAdapting(r.conversationId, sent.runId);
    return { sent: true, runId: sent.runId };
  });
  // sugestão de rotina recusada volta para decisão, do jeito que estava (sem refazer a análise)
  app.post('/api/proposals/:id/reconsider', { schema: { params: idParams('apr') } }, async (req) => {
    const a = owner(req);
    return reconsiderProposal(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id);
  });
  // "Aguardando você": tudo o que espera uma decisão, num lugar só
  app.get('/api/decisions', async (req) => pendingDecisions(db, auth(req).workspaceId));

  // Rotinas ---------------------------------------------------------------------------------------------------
  const triggerSchema = { type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { enum: ['manual', 'schedule'] }, days: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
    time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, tz: S.str(64, 1) } };
  app.get('/api/routines/library', async (req) => routines.library(auth(req).workspaceId));
  app.get('/api/routines', async (req) => routines.list(auth(req).workspaceId));
  app.post('/api/routines', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['template'], properties: {
      template: { type: 'string', pattern: '^[a-z0-9-]{3,40}$' }, trigger: triggerSchema, extra: S.str(600), tz: S.str(64, 1), staleDays: { type: 'integer', minimum: 1, maximum: 60 }, adapt: { type: 'boolean' },
      params: paramsSchema } } },
  }, async (req, reply) => {
    const a = owner(req);
    const b = req.body as { template: string; trigger?: unknown; extra?: string; tz?: string; staleDays?: number; adapt?: boolean; params?: unknown };
    return reply.status(201).send(routines.install(a.workspaceId, a.userId, b.template, b));
  });
  app.get('/api/routines/recommend', async (req) => routines.recommendState(auth(req).workspaceId));
  app.put('/api/routines/recommend', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (req) => { const a = owner(req); return routines.setRecommend(a.workspaceId, a.userId, (req.body as { enabled: boolean }).enabled); });
  app.post('/api/routines/recommend/run', async (req) => { const a = owner(req); return routines.recommendNow(a.workspaceId, a.userId); });
  app.get('/api/routines/:id', { schema: { params: idParams('rtn') } }, async (req) => routines.get(auth(req).workspaceId, (req.params as { id: string }).id));
  app.get('/api/routines/:id/setup', { schema: { params: idParams('rtn') } }, async (req) => routines.setupState(auth(req).workspaceId, (req.params as { id: string }).id));
  app.patch('/api/routines/:id', {
    schema: { params: idParams('rtn'), body: { type: 'object', additionalProperties: false, properties: {
      name: S.str(60, 1), trigger: triggerSchema, extra: S.str(600), status: { enum: ['active', 'paused'] }, staleDays: { type: 'integer', minimum: 1, maximum: 60 },
      sources: { type: 'array', maxItems: 12, items: S.str(40, 1) }, tz: S.str(64, 1), params: paramsSchema } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { name?: string; trigger?: never; extra?: string; status?: 'active' | 'paused'; staleDays?: number; sources?: string[]; tz?: string; params?: unknown };
    const onlyStatus = Object.keys(b).every((k) => k === 'status' || k === 'tz');
    return routines.update(a.workspaceId, a.userId, (req.params as { id: string }).id, { ...b, sources: b.sources?.filter(isSource) },
      onlyStatus ? (b.status === 'paused' ? 'pausada' : 'retomada') : 'editada em Rotinas');
  });
  app.delete('/api/routines/:id', { schema: { params: idParams('rtn') } }, async (req) => { const a = owner(req); return routines.archive(a.workspaceId, a.userId, (req.params as { id: string }).id); });
  app.post('/api/routines/:id/run', {
    schema: { params: idParams('rtn'), body: { type: 'object', additionalProperties: false, required: ['clientRequestId'], properties: {
      clientRequestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
      // o pedido da execução: texto (até 50 mil caracteres, ex.: ata colada) e arquivos do Ergon ou da nuvem
      input: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 50000 }, files: { type: 'array', maxItems: 12, items: fileRefSchema } } } } } },
  }, async (req, reply) => {
    const a = owner(req);
    const b = req.body as { clientRequestId: string; input?: unknown };
    return reply.status(202).send(routines.runNow(a.workspaceId, a.userId, (req.params as { id: string }).id, b.clientRequestId, b.input));
  });
  // arquivos do OneDrive/SharePoint e do Google Drive para uma rotina (pelo nome; só leitura)
  app.get('/api/routines/cloud-files', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['q'], properties: { q: S.str(80, 2) } } },
  }, async (req) => {
    const a = owner(req);
    if (!routines.accounts) return { items: [], reads: [] };
    return routines.accounts.searchFiles(a.workspaceId, (req.query as { q: string }).q);
  });
  app.post('/api/routines/:id/duplicate', { schema: { params: idParams('rtn') } }, async (req, reply) => {
    const a = owner(req); return reply.status(201).send(routines.duplicate(a.workspaceId, a.userId, (req.params as { id: string }).id));
  });
  app.get('/api/routines/:id/versions', { schema: { params: idParams('rtn') } }, async (req) => routines.versions(auth(req).workspaceId, (req.params as { id: string }).id));
  app.post('/api/routines/:id/restore', {
    schema: { params: idParams('rtn'), body: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: { type: 'integer', minimum: 1, maximum: 100000 } } } },
  }, async (req) => { const a = owner(req); return routines.restore(a.workspaceId, a.userId, (req.params as { id: string }).id, (req.body as { version: number }).version); });
  app.get('/api/routine-runs', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { routineId: S.id('rtn'), limit: { type: 'string', pattern: '^\\d{1,3}$' } } } },
  }, async (req) => {
    const qy = req.query as { routineId?: string; limit?: string };
    return routines.history(auth(req).workspaceId, { routineId: qy.routineId, limit: qy.limit ? Number(qy.limit) : 50 });
  });
  app.get('/api/routine-runs/:id', { schema: { params: idParams('rrn') } }, async (req) => routines.runDetail(auth(req).workspaceId, (req.params as { id: string }).id));

  // Andamento automático da equipe (fila do quadro; ligado por padrão, você pode desligar) ------------------------
  app.put('/api/team/autorun', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const on = (req.body as { enabled: boolean }).enabled;
    setSetting(db, a.workspaceId, 'team.autorun', on ? '1' : '0');
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'team.autorun', evidence: { enabled: on }, result: on ? 'andamento automático ligado' : 'andamento automático desligado' });
    bus.publish(a.workspaceId, 'agents.changed', {});
    return { enabled: on };
  });

  // Trabalhos ao mesmo tempo: automático (pela memória da máquina), um número ou sem limite; conversas não entram
  app.put('/api/runs/limit', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['choice'], properties: {
      choice: { anyOf: [{ enum: ['auto', 'ilimitado'] }, { type: 'integer', minimum: 1, maximum: MAX_CHOICE }] } } } },
  }, async (req) => {
    const a = owner(req);
    const choice = (req.body as { choice: 'auto' | 'ilimitado' | number }).choice;
    setSetting(db, a.workspaceId, PROCESS_SETTING, String(choice));
    const limit = executor.processLimit(a.workspaceId);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'runs.limit', evidence: { choice, limit: limit.limit, cap: limit.cap },
      result: choice === 'auto' ? `automático (${limit.machine} nesta máquina)` : choice === 'ilimitado' ? 'sem limite' : `até ${choice} ao mesmo tempo` });
    bus.publish(a.workspaceId, 'agents.changed', {});
    return limit;
  });

  app.post('/api/floors', async (req, reply) => {
    const a = owner(req);
    const floorId = addSimulatedFloor(db, bus, a.workspaceId, a.userId, cfg.slotsPerFloor, cfg.maxFloors);
    return reply.status(201).send({ id: floorId, local: true, note: 'Versão local: andar grátis. Nenhuma cobrança.' });
  });

  // Cidade: estruturas nos lotes (loja, editor do mapa) ------------------------------------------------------
  const lot = { type: 'integer', minimum: -1000, maximum: 1000 };
  app.get('/api/structures', async (req) => listStructures(db, auth(req).workspaceId));

  app.post('/api/structures', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'i', 'j'], properties: {
      kind: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,30}$' }, i: lot, j: lot, name: S.str(60) } } },
  }, async (req, reply) => {
    const a = owner(req);
    const sid = createStructure(db, bus, a.workspaceId, a.userId, req.body as { kind: string; i: number; j: number; name?: string });
    return reply.status(201).send({ id: sid, local: true, note: 'Versão local: estruturas grátis e sem limite de quantidade.' });
  });

  app.patch('/api/structures/:id', {
    schema: { params: idParams('bld'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { i: lot, j: lot, name: S.str(60, 1) } } },
  }, async (req) => {
    const a = owner(req);
    const sid = (req.params as { id: string }).id;
    const b = req.body as { i?: number; j?: number; name?: string };
    if ((b.i === undefined) !== (b.j === undefined)) throw new HttpError(400, 'lot', 'informe i e j juntos');
    if (b.i !== undefined && b.j !== undefined) moveStructure(db, bus, a.workspaceId, a.userId, sid, b.i, b.j);
    if (b.name !== undefined) renameStructure(db, bus, a.workspaceId, a.userId, sid, b.name);
    return { ok: true };
  });

  app.delete('/api/structures/:id', { schema: { params: idParams('bld') } }, async (req) => {
    const a = owner(req);
    removeStructure(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/structures/:id/floors', { schema: { params: idParams('bld') } }, async (req, reply) => {
    const a = owner(req);
    const fid = addStructureFloor(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, cfg.maxFloors);
    return reply.status(201).send({ id: fid, local: true });
  });

  // Consumo (tokens e custo informados pelo provedor; nunca estimados) -----------------------------------------
  app.get('/api/usage', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { tz: { type: 'string', pattern: '^-?[0-9]{1,4}$' } } } },
  }, async (req) => {
    const tz = Number((req.query as { tz?: string }).tz ?? 0);
    const ws = auth(req).workspaceId;
    await aiOf(ws).defaultModel().catch(() => null);
    const billing = executor.mode === 'simulated' ? 'none' as const : aiOf(ws).billing();
    return { ...usageSummary(db, ws, Math.max(-840, Math.min(840, tz)), Date.now(), billing), executor: executor.mode };
  });

  app.delete('/api/floors/:id', { schema: { params: idParams('flr') } }, async (req) => {
    const a = owner(req);
    removeFloor(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id);
    return { ok: true };
  });

  // Kanban ---------------------------------------------------------------------------------------
  app.get('/api/boards', async (req) => db.all(
    `SELECT b.id, b.name, b.origin, b.audience, b.sync_state, b.last_synced_at, b.last_error, i.kind AS source
       FROM boards b LEFT JOIN integrations i ON i.id = b.connection_id
      WHERE b.workspace_id = ? ORDER BY b.audience = 'user', b.origin, b.created_at`, auth(req).workspaceId));

  app.get('/api/boards/:id', { schema: { params: idParams('brd') } }, async (req) => boardView(db, auth(req).workspaceId, (req.params as { id: string }).id));

  // Busca rápida (Ctrl+K): cards de todos os quadros, pelo número ou por palavras do título, e rotinas pelo nome.
  // Os títulos são cifrados no banco: a busca abre os mais recentes e filtra aqui, no servidor local.
  app.get('/api/search', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['q'], properties: { q: S.str(100, 1) } } },
  }, async (req) => {
    const a = auth(req);
    const q = fold((req.query as { q: string }).q.trim());
    const num = /^#?(\d{1,7})$/.exec(q)?.[1];
    const words = q.split(/\s+/).filter(Boolean);
    const hit = (s: string) => { const f = fold(s); return words.length > 0 && words.every((w) => f.includes(w)); };
    const tasks = db.all<{ id: string; number: number; title: string; completed: number; board_id: string; audience: string; origin: string; column_name: string }>(
      `SELECT t.id, t.number, t.title, t.completed, t.board_id, b.audience, b.origin, c.name AS column_name
         FROM tasks t JOIN boards b ON b.id = t.board_id JOIN columns c ON c.id = t.column_id
        WHERE t.workspace_id = ? AND t.archived = 0 ORDER BY t.completed, t.updated_at DESC LIMIT 3000`, a.workspaceId)
      .filter((t) => (num !== undefined && String(t.number) === num) || hit(t.title)).slice(0, 12);
    const found = routines.list(a.workspaceId).filter((r) => hit(r.name)).slice(0, 6).map((r) => ({ id: r.id, name: r.name, status: r.status }));
    return { tasks, routines: found };
  });

  app.post('/api/tasks', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['title'], properties: {
      title: S.str(200, 1), description: S.str(8000), boardId: S.id('brd'), columnId: S.id('col'), agentId: S.id('agt'), dueOn: dueSchema } } },
  }, async (req, reply) => {
    const a = auth(req);
    const b = req.body as { title: string; description?: string; boardId?: string; columnId?: string; agentId?: string; dueOn?: string | null };
    // sem quadro: com responsável vai para a equipe (é um pedido a ela); sem, fica nas suas tarefas
    const boardId = b.boardId ?? (b.agentId ? defaultBoard(db, a.workspaceId).id : userBoard(db, a.workspaceId).id);
    if (b.boardId && boardAudience(db, a.workspaceId, b.boardId) === 'team' && !b.agentId) {
      throw new HttpError(409, 'team_board_auto', 'O quadro da equipe é automático: peça pela conversa ou envie uma tarefa sua à equipe.');
    }
    // sem prazo escolhido, vale o que o título disser ("pagar a conta até sexta")
    const dueOn = b.dueOn !== undefined ? b.dueOn : parseDue(b.title, workspaceTz(db, a.workspaceId));
    const t = createTask(db, bus, a.workspaceId, { type: 'user', id: a.userId }, { ...b, boardId, origin: 'manual', dueOn });
    return reply.status(201).send(t);
  });

  app.get('/api/tasks/:id', { schema: { params: idParams('tsk') } }, async (req) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    const task = getTask(db, a.workspaceId, taskId);
    const link = db.get('SELECT external_id, external_version, external_extra, sync_state, conflict, last_seen_at FROM task_links WHERE task_id = ? AND workspace_id = ?', taskId, a.workspaceId);
    const proposals = db.all(
      `SELECT p.id, p.related_task_id, t.number AS related_number, t.title AS related_title, p.reason, p.score, p.status
         FROM link_proposals p JOIN tasks t ON t.id = p.related_task_id WHERE p.task_id = ? AND p.workspace_id = ?`, taskId, a.workspaceId);
    // evidência de origem: só resumo mínimo; quem vê o card não vê o histórico completo da fonte
    const source = task.source_event_id ? db.get(
      `SELECT e.id, c.kind AS platform, e.is_fixture, e.received_at, e.status, e.text_excerpt FROM source_events e JOIN connections c ON c.id = e.connection_id
        WHERE e.id = ? AND e.workspace_id = ?`, task.source_event_id, a.workspaceId) : null;
    const runs = db.all('SELECT id, agent_id, status, mode, created_at, finished_at FROM runs WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 20', taskId, a.workspaceId);
    const files = taskFiles(db, a.workspaceId, taskId);
    const result = results.latest(a.workspaceId, taskId);
    const parse = <T>(v: string, d: T): T => { try { return JSON.parse(v) as T; } catch { return d; } };
    const ops = operations.forTask(a.workspaceId, taskId).slice(0, 10).map((o) => ({
      id: o.id, op: o.op, status: o.status, error: o.error, durationMs: o.duration_ms, createdAt: o.created_at,
      referencia: parse<{ referencia?: string }>(o.params, {}).referencia ?? null, outputs: parse<string[]>(o.outputs, []),
    }));
    const team = boardAudience(db, a.workspaceId, task.board_id) === 'team';
    const ws = (task.work_state ?? 'solicitada') as WorkState;
    const kind = team ? results.kindOf(a.workspaceId, taskId) : null;
    const work = team && kind ? {
      state: ws, label: WORK_LABEL[ws], kind, kindLabel: KIND_LABEL[kind], requiresApproval: !!Number(task.requires_approval),
      result: result ? { id: result.id, state: result.state, kind: result.kind, justification: result.justification, criteria: result.criteriaList, decidedBy: result.decided_by,
        decidedAt: result.decided_at, deliverables: Array.isArray(result.evidenceData.deliverables) ? result.evidenceData.deliverables : [], mode: result.evidenceData.mode ?? null } : null,
    } : null;
    // o fio do pedido: as etapas do plano, a conversa de onde veio (quem entrega) e a pergunta do agente, se houver
    const steps = stepsOf(db, taskId).map((x) => ({ position: x.position, agentId: x.agent_id, title: x.title, status: x.status, doneAt: x.done_at }));
    const origin = db.get<{ conversation_id: string | null; purpose: string | null; deliver_agent_id: string | null }>('SELECT conversation_id, purpose, deliver_agent_id FROM tasks WHERE id = ?', taskId);
    const conv = origin?.conversation_id ? db.get<{ id: string; agent_id: string; owner_user_id: string }>('SELECT id, agent_id, owner_user_id FROM conversations WHERE id = ?', origin.conversation_id) : null;
    const delivered = conv ? !!db.get("SELECT 1 AS x FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.delivery'", taskId) : false;
    // a pergunta que o agente fez; sem pergunta (o sistema parou o card: arquivo faltando…), o que falta
    const question = result?.state === 'aguardando_info' && typeof result.evidenceData.pergunta === 'string' ? result.evidenceData.pergunta : null;
    const missing = result?.state === 'aguardando_info' && !question ? result.justification : null;
    return { task, log: taskLog(db, a.workspaceId, taskId), link: link ?? null, proposals, source, runs, review: reviews.latest(a.workspaceId, taskId),
      files: { inputs: files.filter((x) => x.role === 'entrada'), deliverables: files.filter((x) => x.role === 'entregavel') }, operations: ops, work,
      queue: team ? teamwork.queueInfo(a.workspaceId, taskId) : null,
      column: db.get<{ name: string }>('SELECT name FROM columns WHERE id = ?', task.column_id)?.name ?? null,
      // aberto de fora do quadro ("aguardando você", uma conversa): a tela escolhe o modo pelo quadro do card
      board: db.get<{ audience: string; origin: string; source: string | null }>('SELECT b.audience, b.origin, i.kind AS source FROM boards b LEFT JOIN integrations i ON i.id = b.connection_id WHERE b.id = ?', task.board_id) ?? null,
      steps, question, missing,
      // cards que nasceram deste (ajuda pedida, o card enviado à equipe): cancelar este leva junto, e a tela avisa antes
      children: db.all<{ number: number; title: string }>('SELECT number, title FROM tasks WHERE parent_task_id = ? AND archived = 0 ORDER BY number', taskId),
      origin: conv ? { conversationId: conv.owner_user_id === a.userId ? conv.id : null, agentId: conv.agent_id, deliverAgentId: origin?.deliver_agent_id ?? conv.agent_id, purpose: origin?.purpose ?? null, delivered } : null };
  });

  // "Pôr para trabalhar": o card da equipe vai para o agente agora (com ou sem o andamento automático)
  app.post('/api/tasks/:id/work', { schema: { params: idParams('tsk') } }, async (req, reply) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    const runId = teamwork.work(a.workspaceId, taskId, a.userId);
    const r = runId ? null : results.latest(a.workspaceId, taskId);
    return reply.status(202).send({ runId, mode: executor.mode, stopped: r ? { state: r.state, justification: r.justification } : null });
  });

  // ordem da fila da equipe: Prioridade (topo) e arrastar dentro de "A fazer" (antes de outro card, ou no fim)
  app.post('/api/tasks/:id/queue', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      priority: { type: 'boolean' }, before: { anyOf: [S.id('tsk'), { type: 'null' }] }, move: { enum: ['up', 'down'] } } } },
  }, async (req) => {
    const a = auth(req);
    return teamwork.arrange(a.workspaceId, (req.params as { id: string }).id, a.userId, req.body as { priority?: boolean; before?: string | null; move?: 'up' | 'down' });
  });

  // sua decisão sobre o card da equipe: aprovar e concluir (ou confirmar a ação externa), ou devolver com instrução
  app.post('/api/tasks/:id/decision', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, required: ['decision'], properties: {
      decision: { enum: ['aprovar', 'devolver'] }, note: S.str(1500) } } },
  }, async (req) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    if (boardAudience(db, a.workspaceId, getTask(db, a.workspaceId, taskId).board_id) !== 'team') throw new HttpError(409, 'not_team', 'Nas suas tarefas, conclua pelo próprio card.');
    const b = req.body as { decision: 'aprovar' | 'devolver'; note?: string };
    const r = results.decide(a.workspaceId, { type: 'user', id: a.userId }, taskId, b.decision, b.note ?? null);
    if (r.state === 'confirmado_humano') teamwork.helpApproved(a.workspaceId, taskId); // card de ajuda: quem pediu continua; da conversa: entrega
    else teamwork.purpose.closeRequests(a.workspaceId, taskId, r.justification);
    return { state: r.state, justification: r.justification };
  });

  // a sua resposta a um card que espera você (do card, de "aguardando você" ou da conversa): já põe o trabalho para andar
  app.post('/api/tasks/:id/respond', { schema: { params: idParams('tsk'), body: respondSchema } }, async (req) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    if (boardAudience(db, a.workspaceId, getTask(db, a.workspaceId, taskId).board_id) !== 'team') throw new HttpError(409, 'not_team', 'Nas suas tarefas, conclua pelo próprio card.');
    const b = req.body as { action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss'; text?: string };
    return teamwork.respond(a.workspaceId, a.userId, taskId, b.action, b.text ?? null);
  });

  // exigir a sua aprovação antes de concluir (mesmo com o resultado validado)
  app.put('/api/tasks/:id/approval', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, required: ['required'], properties: { required: { type: 'boolean' } } } },
  }, async (req) => {
    const a = auth(req);
    const t = getTask(db, a.workspaceId, (req.params as { id: string }).id);
    const on = (req.body as { required: boolean }).required;
    db.run('UPDATE tasks SET requires_approval = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', on ? 1 : 0, new Date().toISOString(), t.id, a.workspaceId);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'task.requires_approval', targetType: 'task', targetId: t.id, evidence: { required: on },
      result: on ? 'conclusão só com a sua aprovação' : 'conclusão automática quando o resultado for validado' });
    bus.publish(a.workspaceId, 'tasks.changed', { id: t.id });
    return { required: on };
  });

  // revisão socrática: Sócrates pergunta ao responsável pela tarefa, em rodadas limitadas
  // Treinar -------------------------------------------------------------------------------------------------
  app.get('/api/agents/:id/trainings', { schema: { params: idParams('agt') } }, async (req) => {
    const a = owner(req);
    return trainings.list(a.workspaceId, (req.params as { id: string }).id);
  });
  app.post('/api/agents/:id/trainings', {
    schema: { params: idParams('agt'), body: { type: 'object', additionalProperties: false, properties: {
      request: S.str(8000), title: S.str(120), fileIds: { type: 'array', maxItems: 10, items: S.id('art') }, links: { type: 'array', maxItems: 10, items: S.str(2000) },
      skillId: S.id('skl') } } },
  }, async (req, reply) => {
    const a = owner(req);
    const b = req.body as { request?: string; title?: string; fileIds?: string[]; links?: string[]; skillId?: string };
    return reply.status(201).send(await trainings.start(a.workspaceId, a.userId, (req.params as { id: string }).id, { request: b.request ?? '', title: b.title, fileIds: b.fileIds, links: b.links, skillId: b.skillId ?? null }));
  });
  app.post('/api/trainings/:id/decision', {
    schema: { params: idParams('trn'), body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { enum: ['aprovar', 'descartar'] } } } },
  }, async (req) => {
    const a = owner(req);
    return trainings.decide(a.workspaceId, a.userId, (req.params as { id: string }).id, (req.body as { decision: 'aprovar' | 'descartar' }).decision);
  });
  app.get('/api/agent-skills/:id', { schema: { params: idParams('skl') } }, async (req) => trainings.skillView(owner(req).workspaceId, (req.params as { id: string }).id));
  app.post('/api/agent-skills/:id', {
    schema: { params: idParams('skl'), body: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { enum: ['desativar', 'ativar', 'remover', 'restaurar'] }, version: { type: 'integer', minimum: 1 } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { action: 'desativar' | 'ativar' | 'remover' | 'restaurar'; version?: number };
    return trainings.skillAction(a.workspaceId, a.userId, (req.params as { id: string }).id, b.action, b.version);
  });

  app.post('/api/tasks/:id/review', { schema: { params: idParams('tsk') } }, async (req, reply) => {
    const a = auth(req);
    const r = reviews.start(a.workspaceId, (req.params as { id: string }).id, a.userId);
    return reply.status(202).send({ ...r, maxRounds: cfg.reviewMaxRounds, mode: executor.mode });
  });

  app.patch('/api/tasks/:id', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, properties: {
      title: S.str(200, 1), description: S.str(8000), columnId: S.id('col'), agentId: { anyOf: [S.id('agt'), { type: 'null' }] },
      completed: { type: 'boolean' }, archived: { type: 'boolean' }, expectedRevision: { type: 'integer', minimum: 1 }, dueOn: dueSchema } } },
  }, async (req) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    // o quadro da equipe é dos agentes: você acompanha (e conversa), não edita
    if (boardAudience(db, a.workspaceId, getTask(db, a.workspaceId, taskId).board_id) === 'team') {
      throw new HttpError(409, 'team_board_readonly', 'O quadro da equipe é automático: para mudar algo, fale com a coordenação.');
    }
    return updateTask(db, bus, a.workspaceId, { type: 'user', id: a.userId }, taskId, req.body as object);
  });

  // Cancelar pelo próprio card (seu ou da equipe): o clique, depois de confirmar na tela, é a sua decisão
  app.post('/api/tasks/:id/cancel', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, properties: { reason: S.str(200) } } },
  }, async (req) => {
    const a = owner(req);
    return cancelCard(a.workspaceId, a.userId, (req.params as { id: string }).id, ((req.body as { reason?: string } | undefined)?.reason ?? '').trim());
  });

  // "Enviar à equipe": uma tarefa sua vira card no quadro da equipe, encaminhado pela coordenação
  app.post('/api/tasks/:id/send-to-team', { schema: { params: idParams('tsk') } }, async (req, reply) => {
    const a = auth(req);
    const src = getTask(db, a.workspaceId, (req.params as { id: string }).id);
    if (boardAudience(db, a.workspaceId, src.board_id) !== 'user') throw new HttpError(409, 'not_user_task', 'só tarefas suas podem ser enviadas à equipe');
    const already = db.get<{ number: number }>('SELECT number FROM tasks WHERE parent_task_id = ? AND archived = 0', src.id);
    if (already) throw new HttpError(409, 'already_sent', `já enviada: card #${already.number} no quadro da equipe`);
    const t = routeTeamTask(db, bus, a.workspaceId, { type: 'user', id: a.userId }, { title: src.title, description: src.description, parentTaskId: src.id, dueOn: src.due_on });
    for (const x of taskFiles(db, a.workspaceId, src.id).filter((y) => y.role === 'entrada')) linkFile(db, a.workspaceId, t.id, x.id, 'entrada');
    return reply.status(201).send(t);
  });

  app.post('/api/tasks/:id/delegate', {
    schema: { params: idParams('tsk'), body: { type: 'object', additionalProperties: false, required: ['agentId', 'instruction', 'requestId'], properties: {
      agentId: S.id('agt'), instruction: S.str(2000, 3), requestId: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' } } } },
  }, async (req, reply) => {
    const a = auth(req);
    const taskId = (req.params as { id: string }).id;
    const b = req.body as { agentId: string; instruction: string; requestId: string };
    const t = getTask(db, a.workspaceId, taskId);
    const ag = db.get<{ status: string }>('SELECT status FROM agents WHERE id = ? AND workspace_id = ?', b.agentId, a.workspaceId);
    if (!ag) throw notFound('agente');
    if (ag.status !== 'active') throw new HttpError(409, 'agent_archived', 'agente desativado');
    // subtarefa temporária: não cria habitante e passa pela mesma fila/limite de concorrência
    const run = executor.enqueue({
      workspaceId: a.workspaceId, agentId: b.agentId, taskId, kind: 'subtask',
      input: `Tarefa #${t.number}: ${t.title}\n${t.description}\n\nPedido: ${b.instruction}`,
      instructions: instructionsFor(db, a.workspaceId, b.agentId, 'Canal: delegação de tarefa no Ergon. Responda com um resultado curto.'),
      idempotencyKey: `delegate-${taskId}-${b.requestId}`,
    });
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'task.delegate', targetType: 'task', targetId: taskId, evidence: { runId: run.id, agentId: b.agentId }, result: 'enfileirada' });
    return reply.status(202).send({ runId: run.id, mode: run.mode });
  });

  app.post('/api/link-proposals/:id', {
    schema: { params: idParams('lnk'), body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { enum: ['confirmed', 'rejected', 'proposed'] } } } },
  }, async (req) => {
    const a = auth(req);
    decideLinkProposal(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, (req.body as { decision: 'confirmed' | 'rejected' | 'proposed' }).decision);
    return { ok: true };
  });

  // Conversas ---------------------------------------------------------------------------------------
  app.get('/api/conversations', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { agentId: S.id('agt') } } },
  }, async (req) => {
    const a = auth(req);
    return listConversations(db, a.workspaceId, a.userId, (req.query as { agentId?: string }).agentId);
  });

  // atalho de conversas: da que você ativou por último para a mais antiga (o que os agentes escrevem sozinhos não conta)
  app.get('/api/conversations/recent', async (req) => {
    const a = auth(req);
    return recentConversations(db, a.workspaceId, a.userId);
  });

  app.post('/api/conversations', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['agentId'], properties: { agentId: S.id('agt'), title: S.str(80) } } },
  }, async (req, reply) => {
    const a = auth(req);
    const b = req.body as { agentId: string; title?: string };
    return reply.status(201).send(createConversation(db, a.workspaceId, a.userId, b.agentId, b.title));
  });

  app.get('/api/conversations/:id/messages', { schema: { params: idParams('cnv') } }, async (req) => {
    const a = auth(req);
    return listMessages(db, a.workspaceId, a.userId, (req.params as { id: string }).id);
  });

  app.post('/api/conversations/:id/messages', {
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, required: ['text', 'clientRequestId'], properties: {
      text: S.str(cfg.maxInputChars, 1), clientRequestId: S.str(64, 8), queue: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const a = auth(req);
    const b = req.body as { text: string; clientRequestId: string; queue?: boolean };
    // na conversa de preparo de uma rotina, a coordenação recebe o contexto do preparo (e a mensagem não vira tarefa)
    const convId = (req.params as { id: string }).id;
    const note = routines.channelFor(convId);
    // queue: com o agente ainda respondendo, a mensagem espera na fila da conversa (Ctrl+Enter) em vez de ser recusada
    const r = sendMessage(db, bus, executor, a.workspaceId, a.userId, convId, b.text, b.clientRequestId, cfg.maxConversationMessages, cfg.maxInputChars, { note, plain: !!note, queue: !!b.queue });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  // Execuções -------------------------------------------------------------------------------------
  app.get('/api/runs', async (req) => db.all(
    `SELECT r.id, r.agent_id, a.name AS agent_name, r.kind, r.status, r.mode, r.error, r.conversation_id, r.task_id, r.created_at, r.started_at, r.finished_at,
            r.tokens_in, r.tokens_out, r.cost_usd, r.hermes_status
       FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 50`, auth(req).workspaceId));

  app.get('/api/runs/:id', { schema: { params: idParams('run') } }, async (req) => {
    const r = executor.get(auth(req).workspaceId, (req.params as { id: string }).id);
    const { instructions: _i, lease_owner: _l, ...rest } = r;
    return rest;
  });

  app.post('/api/runs/:id/cancel', { schema: { params: idParams('run') } }, async (req) => {
    const a = auth(req);
    const r = executor.requestCancel(a.workspaceId, (req.params as { id: string }).id, a.userId);
    return { id: r.id, status: r.status, cancelRequested: !!r.cancel_requested };
  });

  // Atividade, eventos, regras, saída -----------------------------------------------------------------
  app.get('/api/activity', async (req) => db.all(
    'SELECT id, actor_type, actor_id, action, target_type, target_id, evidence, result, created_at FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    auth(req).workspaceId));

  app.get('/api/source-events', async (req) => db.all(
    `SELECT e.id, c.kind AS platform, c.mode, e.external_id, e.event_type, e.version, e.actor_display, e.channel, e.received_at, e.is_fixture,
            e.text_excerpt, e.interpretation, e.status, e.task_id
       FROM source_events e JOIN connections c ON c.id = e.connection_id WHERE e.workspace_id = ? ORDER BY e.received_at DESC LIMIT 100`,
    auth(req).workspaceId));

  app.get('/api/outbox', async (req) => db.all(
    `SELECT o.id, c.kind AS platform, c.mode, o.body, o.status, o.created_at FROM outbox o JOIN connections c ON c.id = o.connection_id
      WHERE o.workspace_id = ? ORDER BY o.created_at DESC LIMIT 100`, auth(req).workspaceId));

  app.get('/api/rules', async (req) => db.all('SELECT id, text, status, created_at, decided_at FROM rules WHERE workspace_id = ? ORDER BY created_at DESC', auth(req).workspaceId));

  app.post('/api/rules/:id', {
    schema: { params: idParams('rul'), body: { type: 'object', additionalProperties: false, required: ['decision'], properties: { decision: { enum: ['active', 'rejected'] } } } },
  }, async (req) => {
    const a = owner(req);
    const ruleId = (req.params as { id: string }).id;
    const d = (req.body as { decision: 'active' | 'rejected' }).decision;
    const r = db.run('UPDATE rules SET status = ?, decided_at = ? WHERE id = ? AND workspace_id = ?', d, now(), ruleId, a.workspaceId);
    if (!r.changes) throw notFound('regra');
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: `rule.${d}`, targetType: 'rule', targetId: ruleId, result: 'ok' });
    bus.publish(a.workspaceId, 'rules.changed', { id: ruleId });
    return { ok: true };
  });

  app.get('/api/connections', async (req) => connectionStatuses(db, cfg, auth(req).workspaceId, hermes));

  // Integrações da conta (Microsoft, Google, WhatsApp e os apps de tarefas): routes/integracoes.ts
  registerIntegrationRoutes(app, { db, bus, integrations, whatsapp, auth, owner });

  // Fixtures: simulação local identificada (nunca chamada de "conectado") ------------------------------
  const fixtureFile = (platform: string, name: string) => {
    if (!cfg.fixturesEnabled) throw new HttpError(404, 'fixtures_disabled', 'fixtures desabilitadas');
    if (!['teams', 'whatsapp'].includes(platform) || !/^[a-z0-9-]{1,40}$/.test(name)) throw notFound('fixture');
    const file = path.join(cfg.fixturesDir, platform, `${name}.json`);
    if (!fs.existsSync(file)) throw notFound('fixture');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { description?: string; identities?: Array<{ id: string; name: string; canCommand: boolean }>; events: Array<Record<string, unknown>> };
  };

  app.get('/api/fixtures', async (req) => {
    auth(req);
    const out: Array<{ platform: string; name: string; description: string; events: number }> = [];
    for (const platform of ['teams', 'whatsapp']) {
      const dir = path.join(cfg.fixturesDir, platform);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /^[a-z0-9-]{1,40}\.json$/.test(x))) {
        const data = fixtureFile(platform, f.replace(/\.json$/, ''));
        out.push({ platform, name: f.replace(/\.json$/, ''), description: data.description ?? '', events: data.events.length });
      }
    }
    return out;
  });

  app.post('/api/fixtures/:platform/:name/replay', {
    schema: { params: { type: 'object', required: ['platform', 'name'], properties: { platform: { enum: ['teams', 'whatsapp'] }, name: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } } } },
  }, async (req) => {
    const a = owner(req);
    const { platform, name } = req.params as { platform: 'teams' | 'whatsapp'; name: string };
    const data = fixtureFile(platform, name);
    const conn = findConnection(db, a.workspaceId, platform, 'fixture');
    for (const ident of data.identities ?? []) upsertIdentity(db, conn, ident.id, ident.name, ident.canCommand);
    const results = data.events.map((ev) => {
      const e = platform === 'teams' ? normalizeTeamsActivity(ev, 'fixture-bot') : normalizeWhatsAppMessage(ev);
      return ingestEvent(db, bus, cfg, conn, e, true);
    });
    return { fixture: true, platform, name, results };
  });

  // Espelho de quadro (fixture) -------------------------------------------------------------------------
  const MIRROR_VARIANTS = ['planner-like-v1', 'planner-like-v2', 'planner-like-erro'];
  app.get('/api/mirror/preview', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { variant: { enum: MIRROR_VARIANTS } } } },
  }, async (req) => {
    auth(req);
    const variant = (req.query as { variant?: string }).variant ?? 'planner-like-v1';
    const p = new FixtureTaskProvider(cfg.fixturesDir, variant);
    try {
      return { fixture: true, provider: p.name, supports: p.supports, boards: await p.listBoards() };
    } catch (err) {
      return { fixture: true, provider: p.name, supports: p.supports, boards: [], error: err instanceof Error ? err.message : 'falha' };
    }
  });

  app.post('/api/mirror/import', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['variant', 'boards'], properties: {
      variant: { enum: MIRROR_VARIANTS }, boards: { type: 'array', minItems: 1, maxItems: 20, items: S.str(100, 1) } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { variant: string; boards: string[] };
    const conn = findConnection(db, a.workspaceId, 'mirror_fixture', 'fixture');
    return importBoards(db, bus, a.workspaceId, conn.id, a.userId, new FixtureTaskProvider(cfg.fixturesDir, b.variant), b.boards);
  });

  // Arquivos ----------------------------------------------------------------------------------------------
  app.get('/api/artifacts', async (req) => listArtifacts(db, auth(req).workspaceId));

  app.post('/api/artifacts', { bodyLimit: cfg.maxUploadBytes }, async (req, reply) => {
    const a = auth(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'content_type', 'envie application/octet-stream');
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'arquivo'));
    const mime = String(req.headers['x-file-type'] ?? 'application/octet-stream');
    const taskId = req.headers['x-task-id'] ? String(req.headers['x-task-id']) : null;
    if (taskId && !/^tsk_[a-f0-9]{32}$/.test(taskId)) throw new HttpError(400, 'task', 'tarefa inválida');
    return reply.status(201).send(saveArtifact(db, bus, cfg.filesDir, cfg.maxUploadBytes, a.workspaceId, a.userId, { filename, mime, data: req.body, taskId }, storageQuota));
  });
  // limites para a interface dizer antes de enviar (local: total sem limite, só por arquivo)
  app.get('/api/limits', async (req) => {
    const a = auth(req);
    const used = Number(db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM artifacts WHERE workspace_id = ?', a.workspaceId)?.n ?? 0);
    return { uploadBytes: cfg.maxUploadBytes, storageBytes: storageQuota || null, storageUsed: used, agents: limits.maxActive || null };
  });

  app.get('/api/artifacts/:id/download', { schema: { params: idParams('art') } }, async (req, reply) => {
    const a = auth(req);
    const f = openArtifact(db, cfg.filesDir, a.workspaceId, (req.params as { id: string }).id);
    reply.header('Content-Type', f.mime === 'application/pdf' || f.mime.startsWith('image/') ? f.mime : 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(f.data); // decifrado na memória (até o limite de upload), nunca gravado aberto
  });

  // Backup pelo script do computador (docker compose exec … backup-cli): o banco cifrado só abre neste processo
  /**
   * Backup completo (services/backup.ts): banco, keyring, arquivos e conexões numa pasta conferida por SHA-256.
   * Sem a chave do acesso sem trancamento: só abre com a senha ou a frase daquele momento.
   */
  const backupNow = () => {
    const t0 = Date.now();
    const b = createBackup(db, cfg, { version: VERSION, dbKey: vault.state() === 'open' ? vault.dbKey() : null });
    const m = b.manifest;
    // a cópia é síncrona (consistente): o tempo dela é o tempo em que o Ergon não responde (marco 8 mede)
    log.info({ backup: b.name, ms: Date.now() - t0, ...m.counts, missing: m.missing.length }, 'backup feito');
    return { file: b.name, keyring: m.keyringCheck ? 'keyring.json' : null, encrypted: m.encrypted, counts: m.counts, missing: m.missing.length, verified: true };
  };
  // Diagnóstico dos últimos eventos da ponte (só metadados, nunca o texto): com o banco cifrado, só o servidor lê
  app.get('/internal/admin/events', async (req) => {
    const token = req.headers['x-ergon-bridge-token'];
    if (!cfg.bridgeToken || typeof token !== 'string' || !safeEqual(token, cfg.bridgeToken)) throw new HttpError(401, 'bridge_auth', 'token inválido');
    return db.all(`SELECT e.received_at, c.kind, c.mode, e.is_fixture, e.event_type, e.status, e.task_id IS NOT NULL AS tarefa
      FROM source_events e JOIN connections c ON c.id = e.connection_id ORDER BY e.received_at DESC LIMIT 15`);
  });

  app.post('/internal/admin/backup', async (req) => {
    const token = req.headers['x-ergon-bridge-token'];
    if (!cfg.bridgeToken || typeof token !== 'string' || !safeEqual(token, cfg.bridgeToken)) throw new HttpError(401, 'bridge_auth', 'token inválido');
    return { ok: true, ...backupNow() };
  });

  // Saúde e diagnóstico (só o dono; tudo local, nada sai do computador) -----------------------------------------
  // um motor por pessoa: o painel de quem administra mostra o motor dela (cada pessoa vê o seu em Conexões › IA)
  const MOTOR_STATE: Record<string, string> = { aberto: 'aberto', ligando: 'aguardando', desligado: 'desligado', erro: 'erro' };
  const healthDepsFor = (a: AuthContext) => ({ db, cfg, vault, hermes: motors.perPerson ? motors.hermes(a.workspaceId) : hermes, executorMode: () => executor.mode,
    motorVault: () => (motors.perPerson ? { state: MOTOR_STATE[motors.state(a.userId).state], lastError: motors.state(a.userId).error } : { state: hermesVault.state, lastError: hermesVault.lastError }) });
  app.get('/api/saude', async (req) => healthPanel(healthDepsFor(admin(req))));
  app.get('/api/saude/diagnostico', async (req, reply) => {
    const a = admin(req);
    const d = await diagnostics(healthDepsFor(a));
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'admin.diagnostico', result: 'pacote gerado (sem conteúdo do usuário)' });
    reply.header('Content-Disposition', `attachment; filename="ergon-diagnostico-${new Date().toISOString().slice(0, 10)}.json"`);
    reply.header('Cache-Control', 'private, no-store');
    return d;
  });

  // Backup ------------------------------------------------------------------------------------------------
  app.post('/api/admin/backup', async (req) => {
    const a = admin(req);
    const b = backupNow();
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'admin.backup', evidence: { file: b.file, ...b.counts, missing: b.missing }, result: 'ok' });
    return { ok: true, ...b, dir: 'volume ergon-data: /data/backups' };
  });

  // SSE: uma conexão multiplexada por workspace ----------------------------------------------------------
  app.get('/api/events', async (req, reply) => {
    const a = auth(req);
    const after = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
    });
    const send = (e: { seq: number; type: string; data: unknown }) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    res.write('retry: 3000\n\n');
    if (after) {
      const missed = bus.since(a.workspaceId, after);
      if (missed === null) res.write('event: resync\ndata: {}\n\n');
      else missed.forEach(send);
    }
    const unsub = bus.subscribe(a.workspaceId, send);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.raw.on('close', () => { clearInterval(hb); unsub(); });
  });

  // Ponte interna Hermes → Ergon (rede Docker interna; token próprio) --------------------------------------
  /** Motor que chama a ponte (token dele); com um motor por pessoa, o token da instalação não vale aqui. */
  const bridgeMotor = (req: FastifyRequest): string => {
    const m = motors.identify(req.headers['x-ergon-bridge-token']);
    if (!m) throw new HttpError(401, 'bridge_auth', 'token da ponte inválido');
    return m;
  };
  app.post('/internal/bridge/v1/events', {
    bodyLimit: 64 * 1024,
    schema: { body: { type: 'object', required: ['schema', 'platform', 'message_id', 'text'], properties: {
      schema: { const: 'ergon.bridge.v1' }, platform: { enum: ['teams', 'whatsapp'] }, message_id: S.str(200, 1), text: S.str(8000),
      event_type: { enum: ['message', 'message_edit'] }, version: S.str(40), session_key: S.str(256), source: { type: 'object', maxProperties: 30 } } } },
  }, async (req) => {
    const motor = bridgeMotor(req);
    if (bridgeLimiter.hit(`bridge:${motor}`)) throw new HttpError(429, 'rate_limited', 'limite de eventos por minuto');
    const p = req.body as BridgePayload;
    const enabled = p.platform === 'teams' ? cfg.teams.enabled : cfg.whatsapp.enabled;
    if (!enabled) throw new HttpError(403, 'connector_disabled', 'conector desabilitado no Ergon');
    const e = normalizeBridge(p);
    // um motor por pessoa: a mensagem entra no workspace de quem é o motor
    const conn = findConnection(db, motor === '_' ? null : owners.owned(motor)[0] ?? null, p.platform, 'real');
    const r = ingestEvent(db, bus, cfg, conn, e, false);
    return { action: r.action, reply: r.reply, event_id: r.eventId, duplicate: r.duplicate, status: r.status };
  });

  // Plugin do Ergon no motor: antes de cada ferramenta, pergunta de qual agente é a sessão e o que ele pode usar.
  // Resposta mínima (nome do agente, conjuntos liberados e quem tem cada um, para o agente pedir ajuda).
  app.post('/internal/bridge/v1/tool-policy', {
    bodyLimit: 4 * 1024,
    schema: { body: { type: 'object', properties: { session_id: S.str(200), task_id: S.str(200) } } },
  }, async (req) => {
    const motor = bridgeMotor(req);
    const b = req.body as { session_id?: string; task_id?: string };
    const found = await executor.runForSession(String(b.session_id ?? ''), String(b.task_id ?? ''));
    // a sessão de outra pessoa é desconhecida para este motor (nem nome de agente, nem ferramentas)
    const run = found && motors.allows(motor, found.workspace_id) ? found : null;
    const agentId = run?.agent_id ?? null;
    const ag = agentId ? db.get<{ name: string; tools: string | null; workspace_id: string }>("SELECT name, tools, workspace_id FROM agents WHERE id = ? AND status = 'active'", agentId) : undefined;
    if (!ag) return { known: false };
    const list = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
    const holders: Record<string, string[]> = {};
    for (const o of db.all<{ name: string; tools: string | null }>("SELECT name, tools FROM agents WHERE workspace_id = ? AND status = 'active'", ag.workspace_id)) {
      for (const ts of toolsetsFor(list(o.tools), { workspaceId: ag.workspace_id })) holders[ts] = [...(holders[ts] ?? []), o.name];
    }
    // guarded: ferramentas que executam código (o plugin orienta o agente a pedir permissão, não a improvisar)
    // competências: o agente carrega só as dele (aprendidas no Treinar + as da biblioteca atribuídas, se tem Skills)
    const own = list(ag.tools).includes('habilidades') ? list(db.get<{ s: string | null }>('SELECT hermes_skills AS s FROM agents WHERE id = ?', agentId)?.s ?? null) : [];
    const skills = [...new Set([...trainings.activeSkills(agentId!).map((x) => x.name), ...own])];
    const tr = run ? trainings.forRun(run) : null;
    const training = tr && tr.status === 'executando' && run!.status !== 'succeeded' ? trainings.policy(tr) : null;
    return { known: true, agent: ag.name, toolsets: training ? ['skills', ...(training.urls.length ? ['web'] : [])] : toolsetsFor(list(ag.tools), { workspaceId: ag.workspace_id }), holders, guarded: GUARDED_TOOLSETS, skills, training };
  });

  app.post('/internal/bridge/v1/training-event', {
    bodyLimit: 64 * 1024,
    schema: { body: { type: 'object', properties: { session_id: S.str(200), task_id: S.str(200), tool: S.str(40), pending_id: S.str(40), staged: { type: 'boolean' }, skill: S.str(120),
      reads: { type: 'array', maxItems: 20, items: { type: 'object', properties: { url: S.str(2000), chars: { type: 'integer' }, ok: { type: 'boolean' }, error: S.str(300) } } } } } },
  }, async (req) => {
    const motor = bridgeMotor(req);
    const b = req.body as { session_id?: string; task_id?: string; tool?: string; pending_id?: string; staged?: boolean; skill?: string; reads?: Array<{ url: string; chars: number; ok: boolean; error?: string }> };
    const found = await executor.runForSession(String(b.session_id ?? ''), String(b.task_id ?? ''));
    const run = found && motors.allows(motor, found.workspace_id) ? found : null;
    // uso de uma competência aprendida numa conversa ou tarefa (prova de uso; só conta a do próprio agente)
    if (b.tool === 'skill_view') return { ok: !!run && !!b.skill && trainings.used(run, b.skill) };
    const tr = run ? trainings.forRun(run) : null;
    if (!tr) return { ok: false };
    trainings.event(tr, { tool: String(b.tool ?? ''), pending_id: b.pending_id, staged: b.staged, reads: b.reads });
    return { ok: true };
  });

  app.get('/internal/bridge/v1/health', async (req) => {
    bridgeMotor(req);
    return { ok: true, teams: cfg.teams.enabled, whatsapp: cfg.whatsapp.enabled };
  });

  // Esqueleto do workspace (shared/blueprint.ts): a forma, sem segredos nem direitos; aplicar instala tudo pausado ---
  app.get('/api/blueprint/export', async (req) => exportBlueprint(db, routines, owner(req).workspaceId));
  app.post('/api/blueprint/import', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['blueprint'], properties: { blueprint: { type: 'object' }, apply: { type: 'boolean' } } } },
    bodyLimit: 1_100_000,
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { blueprint: unknown; apply?: boolean };
    return importBlueprint(db, bus, routines, a.workspaceId, a.userId, b.blueprint, b.apply === true, limits);
  });

  // Pacotes .ergon (só dados: tema, efeitos, pets, aparências, equipe) — instalar, prévia, desfazer --------------
  // chave oficial do Ergon (pacotes que vêm com ele) + as que a instalação acrescentar (ERGON_PACKAGE_KEYS: id=SPKI,…)
  const officialKeys = { ...OFFICIAL_KEYS, ...Object.fromEntries((process.env.ERGON_PACKAGE_KEYS ?? '').split(',').map((x) => x.split('=')).filter((x) => x.length === 2 && x[0] && x[1])) };
  const packages = new Packages(db, bus, routines, limits, officialKeys);
  // loja: oficiais embutidos (sem internet) e modelos da comunidade (índice público, só quando a pessoa pede)
  const catalog = new Catalog({ db, packages, keys: officialKeys, dir: cfg.catalogDir, indexUrl: cfg.communityCatalogUrl, fetchImpl: cfg.catalogFetch });
  app.get('/api/packages/catalog/official', async (req) => catalog.official(auth(req).workspaceId));
  app.get('/api/packages/catalog/official/:id/preview/:n', {
    schema: { params: { type: 'object', required: ['id', 'n'], properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{2,100}$' }, n: { type: 'string', pattern: '^[0-9]$' } } } },
  }, async (req, reply) => {
    auth(req);
    const p = req.params as { id: string; n: string };
    const x = catalog.officialPreview(p.id, Number(p.n));
    return reply.header('content-type', x.type).header('cache-control', 'private, max-age=3600').header('content-security-policy', "default-src 'none'").send(x.bytes);
  });
  app.post('/api/packages/catalog/official/install', { schema: { body: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: S.str(110, 5) } } } },
    async (req) => { const a = owner(req); return catalog.installOfficial(a.workspaceId, a.userId, (req.body as { id: string }).id); });
  app.get('/api/packages/catalog/community', async (req) => catalog.community(auth(req).workspaceId, (req.query as { atualizar?: string }).atualizar === '1'));
  app.post('/api/packages/catalog/community/install', { schema: { body: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: S.str(110, 5) } } } },
    async (req) => { const a = owner(req); return catalog.installCommunity(a.workspaceId, a.userId, (req.body as { id: string }).id); });
  const ergonBody = { bodyLimit: 21 * 1024 * 1024 };
  app.addContentTypeParser('application/x-ergon', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/api/packages', async (req) => packages.list(auth(req).workspaceId));
  app.get('/api/packages/cosmetics', async (req) => packages.cosmetics(auth(req).workspaceId));
  app.post('/api/packages/preview', ergonBody, async (req) => packages.preview(owner(req).workspaceId, req.body as Buffer));
  app.post('/api/packages/install', ergonBody, async (req) => { const a = owner(req); return packages.install(a.workspaceId, a.userId, req.body as Buffer); });
  app.delete('/api/packages/:id', { schema: { params: idParams('pkg') } }, async (req) => { const a = owner(req); packages.uninstall(a.workspaceId, a.userId, (req.params as { id: string }).id); return { ok: true }; });
  // editor simples: monta um .ergon (efeito, pet ou tema) para ver na cidade, baixar e publicar; mesma validação da instalação
  app.post('/api/packages/build', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'data'], properties: {
      kind: { enum: ['fx', 'pet', 'city-theme'] }, title: S.str(60, 2), data: { type: 'object' } } } },
  }, async (req, reply) => {
    owner(req);
    const b = req.body as { kind: 'fx' | 'pet' | 'city-theme'; title: string; data: Record<string, unknown> };
    const slug = b.title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pacote';
    const buf = await buildPackage({ package_id: `comunidade.local.${slug}`, version: '1.0.0', title: b.title, summary: 'Criado no editor do Ergon', creator_id: 'local', license: 'CC-BY-4.0', ergon: { min: '0.2.0' }, kind: b.kind }, b.data as never);
    try { validatePackage(buf); } catch (e) { throw new HttpError(400, 'package_invalid', (e as Error).message); }
    return reply.header('content-type', 'application/x-ergon').header('content-disposition', `attachment; filename="${slug}.ergon"`).send(buf);
  });
  app.get('/api/packages/:id/asset', { schema: { params: idParams('pkg'), querystring: { type: 'object', required: ['path'], properties: { path: S.str(200, 3) } } } }, async (req, reply) => {
    const a = auth(req); const x = packages.asset(a.workspaceId, (req.params as { id: string }).id, (req.query as { path: string }).path);
    return reply.header('content-type', x.type).header('content-security-policy', "default-src 'none'").send(x.bytes);
  });

  // módulo opcional (server/src/world): a Community não traz esse código ---------------------------------------
  app.get('/api/distribution', async () => ({ distribution: cfg.distribution, world: world?.status() ?? { available: false } }));
  if (world) await world.register({ app, cfg, db, bus, vault, publicRoutes: PUBLIC_API, auth, owner, admin, controlFor: (ws) => motors.control(ws), routines, limits });

  // Frontend compilado --------------------------------------------------------------------------------------
  if (cfg.webDir && fs.existsSync(path.join(cfg.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: cfg.webDir, prefix: '/', index: ['index.html'], cacheControl: true, maxAge: '1h',
      // index.html nunca fica em cache: após atualizar a imagem, o navegador precisa dos nomes novos dos pacotes
      // (os antigos deixam de existir). Pacotes em /assets/ têm hash no nome e podem ficar em cache longo.
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') res.header('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // arquivo da interface que não existe (aba de uma versão anterior) é 404 de verdade, não a página inicial
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/internal/') && !req.url.startsWith('/assets/')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'rota não encontrada' });
    });
  }

  return { app, executor, reviews, teamwork, operations, results, routines, trainings, ai, integrations, whatsapp, bus, db, vault, hermesVault, motors, startBackground, stopBackground };
}

class Limiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  hit(key: string): boolean {
    const t = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    arr.push(t);
    this.hits.set(key, arr);
    return arr.length > this.max;
  }
}
