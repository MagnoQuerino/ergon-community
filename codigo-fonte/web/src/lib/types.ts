export interface Floor { id: string; building_id: string; level: number; name: string; slots: number; active: number; origin: 'base' | 'simulated' | 'entitlement' }
/** Estrutura da cidade (prédio, praça, área de lazer ou bairro) no lote (i, j) do mapa. */
export interface Structure { id: string; kind: string; name: string; i: number; j: number; origin: 'base' | 'local'; floors: Array<Omit<Floor, 'building_id'>> }
export interface UsagePeriod { from: string; runs: number; runsWithTokens: number; tokensIn: number; tokensOut: number; runsWithCost: number; costUsd: number | null }
export type Billing = 'subscription' | 'credits' | 'api' | 'none';
export interface Usage {
  month: UsagePeriod; year: UsagePeriod; subscription: null | { provider: string; windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> };
  billing: Billing; costVisible: boolean; note: string; executor: 'real' | 'simulated';
}
export interface Capacity { slots: number; active: number; free: number; floors: Floor[]; maxFloors: number; note: string }
export type ToolStatus = 'disponível' | 'parcial' | 'desligada' | 'bloqueada' | 'preparado' | 'planejado';
/** Ferramenta do catálogo do Ergon com o estado real ("planejado" nunca aparece como disponível). */
/** guarded: executa código — bloqueada por padrão, liberada só com a senha */
export interface AgentTool { id: string; label: string; kind: 'ergon' | 'ia'; status: ToolStatus; note: string; safe?: boolean; guarded?: boolean; platform?: boolean }
export interface Sector { id: string; key: string; name: string; description: string | null; creates_tasks: 'demands' | 'explicit_only'; tools: string[]; skills: string[]; position: number; custom: number; members: number }
export interface Agent {
  id: string; name: string; role: string; color: string; status: 'active' | 'archived'; demo: number; floor_id: string; floor_level: number; building_id: string;
  /** chave do setor */
  profile: string; sector_name: string; run_status: 'queued' | 'running' | 'waiting_user' | null;
  /** personagem da equipe (ex.: "socrates"), bio curta, métodos, ferramentas e o modelo indicado */
  char_key: string | null; bio: string | null; skills: string[]; tools: AgentTool[]; model_hint: 'ponta' | 'intermediário' | 'econômico' | null;
  /** subagente: instruções, modelo próprio (vazio = padrão da conta) e skills da biblioteca */
  charter: string | null; model: string | null; provider: string | null; hermes_skills: string[]; deactivation_note: string | null;
  /** 1 = o Coordenador: o único cargo fixo (sempre presente; função, setor e ferramentas de coordenação não mudam) */
  coordinator: number;
  /** boneco sorteado do pacote gráfico ("Redefinir aparência"); null = o do personagem (ou pelo nome) */
  look_seed?: number | null;
  /** Último desfecho encerrado: "succeeded|<finished_at>", "failed|…" ou "cancelled|…" (reações da cena). */
  last_outcome: string | null;
}
export interface AppState {
  workspace: { id: string; name: string; demo_data: number };
  capacity: Capacity;
  agents: Agent[];
  structures: Structure[];
  sectors: Sector[];
  teamAutorun: boolean;
  /** personagens da equipe de partida com nome ou história de outro tema (0 = tema padrão) */
  themed: number;
  /** processos (cards, rotinas, revisões) seguem o limite; conversas não entram nele */
  runs: { running: number; queued: number; waiting: number; processes: number; limit: ProcessLimit; cardsWaiting: number };
  decisionsPending: number;
  executor: { mode: 'real' | 'simulated'; label: string };
  serverTime: string;
}
export interface Me {
  user: { id: string; username: string; displayName: string; avatar?: string | null }; workspaceId: string; role: string; csrf: string; workspaces: Array<{ id: string; name: string; role: string }>;
  /** tela trancada por inatividade; instalação já protegida (cifrada); minutos até trancar; 2º fatores da pessoa */
  locked: boolean; protected: boolean; idleMinutes: number; factors: { totp: boolean; passkeys: number }; mode: 'local' | 'cloud'; rpId: string; recovery: boolean;
  /** primeiro acesso: perguntar se liga o destrancar sozinho (ajudante presente, ainda sem escolha) */
  autoUnlockPrompt: boolean;
  /** várias pessoas no computador: quem administra a instalação; a parte da pessoa ainda fechada (digitar a senha); quantas contas */
  admin: boolean; personSealed: boolean; people: number;
  /** boas-vindas: 'pending' = conta nova ainda sem as perguntas iniciais */
  onboarding: 'pending' | 'done';
  prefs: Prefs;
}
/** Preferências da pessoa: dicas ligadas, dicas dispensadas e tour inicial feito. */
export interface Prefs { tips: boolean; dismissed: string[]; tourDone: boolean }
export interface OnboardingOptions {
  state: 'pending' | 'done'; choice: { use?: string; niche?: string; preset?: string; skipped?: boolean } | null;
  uses: Array<{ key: string; label: string; hint: string }>; niches: Array<{ key: string; label: string }>;
  presets: Array<{ key: string; title: string; summary: string; size: number; sectors: string[] }>;
}
export interface OnboardingResult {
  preset: { key: string; title: string; summary: string }; coordinator: string;
  team: Array<{ id: string; name: string; role: string; sector: string; sectorName: string; charKey: string | null }>;
}
export interface VersionInfo { version: string; build: string; mode: 'local' | 'cloud'; latest: { version: string; notes: string | null; url: string | null } | null; updateAvailable: boolean }
/** Estado público da entrada (antes do login). sealed: reiniciado e trancado, só senha ou frase abrem os dados. */
export interface AuthState { needsSetup: boolean; authenticated: boolean; locked: boolean; sealed: boolean; protected: boolean; mode: 'local' | 'cloud'; rpId: string; publicUrl: string; setupTokenRequired: boolean;
  /** conta nova neste computador: qualquer pessoa ('aberto'), só com convite ('convite'), ou não se aplica (null) */
  signup?: 'aberto' | 'convite' | null }
export interface SecurityStatus {
  mode: 'local' | 'cloud'; protected: boolean; recovery: boolean; autoUnlock: Array<{ id: string; label: string; createdAt: string }>;
  /** trancamento: desligado = abre sozinho ao reiniciar (a proteção é a do computador); na nuvem é sempre ligado */
  lock: { enabled: boolean; forced: boolean; sessionDays: number };
  totp: boolean; passkeys: Array<{ id: string; name: string; created_at: string; last_used_at: string | null }>; idleMinutes: number; rpId: string; publicUrl: string; minPassword: number; motorVault: boolean;
  /** ajudante do computador (guarda a chave do destrancar sozinho no cofre do sistema) */
  agent: { label: string; platform: string } | null; agentConfigured: boolean; autoUnlockPending: boolean; autoUnlockAsked: string | null;
  sessions: Array<{ id: string; created_at: string; last_seen_at: string | null; user_agent: string | null; ip: string | null; current: number }>; recentAuth: boolean;
  /** várias pessoas: quantas contas e se as partes já estão isoladas (cada uma só abre pela própria pessoa) */
  people?: { count: number; isolated: boolean };
}
/** Pessoas neste computador (só quem administra vê): sem nada do conteúdo de ninguém. */
export interface PeopleInfo {
  signup: 'aberto' | 'convite'; isolated: boolean; invites: Array<{ id: string; created_at: string; expires_at: string }>;
  people: Array<{ id: string; username: string; displayName: string; createdAt: string; lastSeen: string | null; admin: boolean; phrase: boolean; open: boolean; migrated: boolean }>;
}
export interface BoardSummary { id: string; name: string; origin: 'native' | 'mirror'; audience: 'team' | 'user'; source: string | null; sync_state: string | null; last_synced_at: string | null; last_error: string | null }
export interface Column { id: string; name: string; position: number }
/** Trabalhos ao mesmo tempo: a sua escolha (ou o padrão da máquina), sob o teto do plano. limit null = sem limite. */
export interface ProcessLimit {
  limit: number | null; choice: 'auto' | 'ilimitado' | number; machine: number; cap: number | null; memoryGb: number; cpus: number;
}
export interface TaskCard {
  id: string; number: number; column_id: string; agent_id: string | null; title: string; description: string; completed: number;
  completed_by: string | null; origin: string; is_fixture: number; revision: number; link_state: string | null; link_conflict: string | null; proposals: number;
  external_assignee: string | null; parent_task_id: string | null; run_status: string | null; handoffs: number; is_help: number; team_number: number | null; team_agent_id: string | null;
  updated_at: string;
  /** prazo (AAAA-MM-DD) ou null */
  due_on: string | null;
  /** quadro do card de origem: 'user' = você enviou à equipe; 'team' = um agente pediu ajuda */
  parent_audience: 'user' | 'team' | null;
  /** estado real do trabalho (cards da equipe) e arquivos do card */
  work_state: string | null; requires_approval: number; inputs: number; deliverables: number;
  /** fila da equipe: marcado como prioridade (vai ao topo) */
  priority?: number;
}
export interface BoardView { board: BoardSummary; columns: Column[]; tasks: TaskCard[] }
/** queued: 1 = na fila da conversa (Ctrl+Enter); vai para o agente quando ele terminar */
export interface Message { id: string; role: 'user' | 'agent' | 'system'; content: string; mode: 'real' | 'simulated' | 'local'; run_id: string | null; created_at: string; run_status: string | null; queued?: number }
/** purpose: conversa aberta por uma rotina ("routine:<id>", "routine-recommend"); null = conversa comum com o agente */
export interface Conversation { id: string; agent_id: string; title: string; created_at: string; last_at: string | null; purpose?: string | null }
/** atalho de conversas: last_user_at = a última vez que VOCÊ escreveu nela (o que os agentes escrevem sozinhos não conta) */
export interface RecentConversation { id: string; agent_id: string; title: string; created_at: string; last_user_at: string; last_at: string | null }
/** Rótulo curto de cada tipo de proposta (cartões da conversa e "aguardando você"). */
export const PROPOSAL_KIND: Record<string, string> = {
  question: 'pergunta', routine: 'rotina', routine_edit: 'ajuste de rotina', sector: 'setor', create_agent: 'novo agente', tools: 'ferramenta',
  permission: 'permissão', edit_agent: 'agente', deactivate_agent: 'desativar', reactivate_agent: 'reativar', sector_edit: 'setor', sector_new: 'novo setor',
  task: 'tarefa proposta', ledger: 'lançamentos', delete_task: 'cancelar card', info_request: 'pedido do card',
};
export interface Proposal { id: string; conversation_id: string | null; run_id: string | null; kind: 'sector' | 'create_agent' | 'tools' | 'permission' | 'routine' | 'routine_edit' | 'question' | 'edit_agent' | 'deactivate_agent' | 'reactivate_agent' | 'sector_edit' | 'sector_new' | 'task' | 'ledger' | 'delete_task' | 'info_request'; summary: string; status: 'proposed' | 'applied' | 'rejected' | 'failed'; result: string | null; created_at: string; payload?: string | null }
export interface ModelEntry { id: string; label: string; vendor: string; input: number | null; output: number | null; tier: 'grátis' | 'econômico' | 'intermediário' | 'ponta' | null }
export interface ModelCatalog { default: { provider: string | null; model: string | null; label: string }; providers: Array<{ id: string; name: string; billing: Billing; models: ModelEntry[] }> }
export interface AiStatus {
  executor: 'real' | 'simulated'; available: boolean;
  /** motor de IA da pessoa: conta nova fica "ligando" por até ~1 min */
  motor?: { state: 'desligado' | 'ligando' | 'aberto' | 'erro'; error: string | null };
  accounts: Array<{ id: string; name: string; billing: Billing; about: string; site: string; connected: boolean; detail: string }>;
  default: { provider: string | null; model: string | null; label: string; billing: Billing };
}
export interface Skill { name: string; description: string; category: string; enabled: boolean }
export interface Integration {
  kind: string; name: string;
  /** oauth: login com a conta · qr: WhatsApp · token: credencial colada · soon: ainda não (motivo em "soon") */
  auth: 'oauth' | 'qr' | 'token' | 'soon'; group: 'contas' | 'tarefas' | 'conversas'; about: string; tasks: boolean; site: string; soon: string | null;
  help: { url: string; steps: string } | null; fields: Array<{ name: string; label: string; secret: boolean; placeholder: string }>;
  state: 'off' | 'pending' | 'connected' | 'error'; account: string | null;
  connectedAt: string | null; lastSyncAt: string | null; error: string | null; ready: boolean;
  /** Google com o app em modo de teste: até quando a autorização vale (depois, entrar de novo) */
  renewBy?: string | null;
  /** login com a conta: o que falta registrar e onde está o guia */
  setup: { needs: string; doc: string; place: string } | null;
  live: { status: string; qr: string | null; me: string | null; error: string | null; read: number; seen: number } | null;
}
export type View = 'ambiente' | 'agentes' | 'tarefas' | 'equipe' | 'rotinas' | 'conexoes' | 'configuracao' | 'atividade' | 'ajuda';

export const ORIGIN_LABEL: Record<string, string> = {
  manual: 'manual', chat: 'conversa', teams: 'Teams', whatsapp: 'WhatsApp', mirror: 'espelho', demo: 'demonstração',
};
export const SOURCE_LABEL: Record<string, string> = {
  microsoft: 'Microsoft', google: 'Google Tasks', asana: 'Asana', todoist: 'Todoist', trello: 'Trello', jira: 'Jira', clickup: 'ClickUp', monday: 'monday.com',
  notion: 'Notion', linear: 'Linear', airtable: 'Airtable', smartsheet: 'Smartsheet', pipefy: 'Pipefy', github: 'GitHub Projects',
};

/** Remove as linhas de controle ([[...]]) que os agentes escrevem para o Ergon aplicar. */
export const stripControl = (s: string): string => s.replace(/\[\[\s*(pedir-ajuda|pedir-permissao|mover|novo-agente|ferramenta|propor-rotina|sugerir-rotina|ajustar-rotina|reapresentar-rotina|configurar-rotina|perguntar|editar-agente|desativar-agente|reativar-agente|editar-setor|novo-setor|propor-tarefa|categoria|plano|etapa|apagar-card|cancelar-card)\b[^\]]*\]\]\s*/gi, '').trim();

// Rotinas -------------------------------------------------------------------------------------------------
export type RoutineTrigger = { kind: 'manual' } | { kind: 'schedule'; days: number[]; time: string; tz?: string };
/** arquivo escolhido para uma rotina: do Ergon (Atividade › Arquivos) ou do OneDrive/Google Drive */
export interface FileRef { kind: 'ergon' | 'microsoft' | 'google'; id: string; name: string }
export type ParamValues = Record<string, Array<string | FileRef>>;
/** o que a rotina acompanha (configurado uma vez) */
export interface ParamSpec { key: string; label: string; kind: 'lista' | 'urls' | 'arquivos'; placeholder?: string; hint?: string; required?: boolean; max?: number }
/** o que a rotina pede na hora de executar */
export interface InputSpec { text?: { label: string; placeholder: string; required?: boolean }; files?: { label: string; required?: boolean; max?: number; accept?: string }; oneOf?: boolean }
export interface RoutineTemplate {
  key: string; name: string; category: string; benefit: string; produces: string; examines: string;
  needs: Array<{ id: string; label: string; ok: boolean }>; agents: string[]; agentNames: string[];
  modes: Array<'manual' | 'schedule' | 'event' | 'condition'>; approvals: string; privateData: boolean; phase: number; available: boolean;
  sample?: string; schedule: string | null; defaultTrigger: RoutineTrigger | null; sources: string[]; installed: Array<{ id: string; status: string }>;
  input?: InputSpec; params?: ParamSpec[]; proposes?: 'tarefas' | 'lancamentos'; outputs?: string[];
}
export interface RoutineLibrary { categories: Record<string, string>; routines: RoutineTemplate[] }
export type RoutineRunStatus = 'queued' | 'gathering' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'cancelled' | 'missed';
export interface Routine {
  id: string; name: string; template: string | null; templateName: string | null; category: string; categoryLabel: string;
  status: 'setup' | 'active' | 'paused'; version: number; conversationId: string | null; agentId: string | null; agentName: string | null; hasSetup: boolean;
  trigger: RoutineTrigger; schedule: string; nextRunAt: string | null; lastRunAt: string | null; running: boolean;
  last: { id: string; status: RoutineRunStatus; summary: string | null; finished_at: string | null; created_at: string; error: string | null } | null;
  config: { sources: string[]; sourceLabels: string[]; condition: 'sempre' | 'novidades' | 'sinal'; instruction: string; extra: string; deliver: string[]; staleDays: number; params: ParamValues };
  /** o que pede ao executar, o que acompanha e o que falta configurar */
  input: InputSpec | null; paramSpecs: ParamSpec[]; missing: string[]; outputs: string[]; proposes: 'tarefas' | 'lancamentos' | null;
}
export interface CloudFile { provider: 'microsoft' | 'google'; id: string; name: string; size: number; modified: string | null; mime: string; folder: string }
export interface ArtifactRow { id: string; filename: string; mime: string; size: number; task_id: string | null; created_at: string }
export type RoutineDeliverable = { type: 'conversa'; id: string } | { type: 'arquivo'; id: string; name: string };
export interface RoutineRun {
  id: string; routine_id: string; name: string; version: number; trigger: 'manual' | 'schedule' | 'chat'; slot: string | null; status: RoutineRunStatus;
  mode: 'real' | 'simulated' | 'local' | null; run_id: string | null; summary: string | null; deliverables: RoutineDeliverable[]; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; tokens: number | null; cost: number | null; agent: string | null;
  /** conferência da entrega (contrato de evidência) */
  verdict: 'validado' | 'parcial' | 'reprovado' | null;
}
/** o que a conferência prova, nível a nível (nenhum é "a análise está certa") */
export interface EvidenceLevels {
  coleta: 'completa' | 'parcial' | 'sem_fontes'; citacoes: 'conferidas' | 'com_erro' | 'sem_modelo'; numeros: 'conferidos' | 'com_erro' | 'nao_conferidos';
  cobertura: 'completa' | 'completada_pelo_ergon' | 'nao_se_aplica'; analise: 'nao_verificada'; humano: 'revisao_necessaria' | 'opcional';
}
export interface RoutineSourceRead { account: 'microsoft' | 'google'; what: 'agenda' | 'email' | 'tarefas' | 'arquivos'; status: 'ok' | 'nao_conectada' | 'sem_permissao' | 'expirada' | 'erro'; label: string | null; count: number; ms: number; detail?: string; truncated?: boolean }
export interface RoutineRunDetail extends RoutineRun {
  facts: string | null; output: string | null;
  checks: { verdict: RoutineRun['verdict']; criteria: Array<{ id: string; label: string; ok: boolean; detail?: string }>; reads: RoutineSourceRead[]; warnings: string[]; panel: string; levels: EvidenceLevels | null } | null;
  /** o pedido desta execução (texto e arquivos) */
  params: string | null;
}
export interface RoutineSetupState {
  routine: Routine;
  template: { name: string; benefit: string; produces: string; approvals: string; sample: string | null; sources: string[] } | null;
  setup: {
    status: 'studying' | 'asking' | 'adapting' | 'ready' | 'failed'; conversationId: string; agentId: string | null; pendingQuestions: number; error: string | null;
    adapted: { source: 'ia' | 'ergon'; summary: string; noted: string; changes: string[]; schedule: string } | null;
  } | null;
  firstRun: { id: string; status: RoutineRunStatus; mode: string | null; summary: string | null; output: string | null; error: string | null; deliverables: RoutineDeliverable[] } | null;
}
export interface RecommendState { enabled: boolean; next: string | null; last: string | null; needsAi: boolean }
/** O que um card que espera você pede: informação, aprovação (ou confirmação), uma decisão ou nova tentativa. */
export type Need = 'info' | 'approval' | 'review' | 'retry';
/** Pedido de um card repassado na conversa pelo agente dela (cartão para responder ali mesmo). */
export interface RequestPayload { taskId: string; number: number; title: string; need: Need; agent: string; question: string | null; excerpt: string | null }
export interface Decisions {
  proposals: Array<{ id: string; kind: Proposal['kind']; summary: string; created_at: string; conversation_id: string | null; agent_id: string | null; agent_name: string | null; purpose: string | null }>;
  waiting: Array<{ id: string; conversation_id: string | null; agent_id: string; agent_name: string; created_at: string }>;
  /** cards da equipe parados à espera de você */
  cards: Array<{ id: string; number: number; title: string; work_state: string; agent_id: string | null; agent_name: string | null; updated_at: string; need: Need; question: string | null; external: boolean; justification: string | null }>;
  linkList: Array<{ id: string; task_id: string; number: number; title: string; related_number: number; related_title: string; reason: string }>;
  ruleList: Array<{ id: string; text: string; created_at: string }>;
  total: number;
  links: number; rules: number; refusedRoutines: Array<{ id: string; summary: string; decided_at: string }>;
}

/** Saúde do Ergon (Configurações › Saúde): os quatro estados, do melhor para o pior. */
export type Saude = 'operacional' | 'limitado' | 'atencao' | 'indisponivel';
export interface PainelSaude { estado: Saude; rotulo: string; resumo: string; componentes: Array<{ id: string; nome: string; estado: Saude; detalhe: string }>; geradoEm: string }
// Treinar: competências que a pessoa ensina a um agente (revisadas e aprovadas antes de valer; só do agente)
export interface TrainingSources {
  files: Array<{ id: string; name: string; status: 'lido' | 'sem_texto' | 'nao_suportado' | 'erro'; chars: number; detail?: string }>;
  links: Array<{ url: string; status: 'pendente' | 'lido' | 'falhou'; chars: number; detail?: string }>;
}
export interface Training {
  id: string; agentId: string; skillName: string; skillId: string | null; status: 'executando' | 'em_revisao' | 'falhou' | 'aprovado' | 'descartado';
  title: string; request: string; sources: TrainingSources; draft: Record<string, string> | null; summary: string | null; problems: string[];
  error: string | null; createdAt: string; decidedAt: string | null;
}
export interface AgentSkill {
  id: string; agentId: string; name: string; title: string; description: string; status: 'ativa' | 'desativada' | 'removida'; version: number;
  createdAt: string; updatedAt: string; uses: number; lastUsedAt: string | null; files: Record<string, string>;
  versions: Array<{ version: number; createdAt: string; trainingId: string | null; sources: TrainingSources }>;
}
export interface TrainingList { skills: AgentSkill[]; trainings: Training[] }
