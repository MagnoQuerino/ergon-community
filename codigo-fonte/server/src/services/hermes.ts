/**
 * Cliente do Hermes Agent (o motor de IA por baixo do Ergon; o nome nunca aparece para o usuário).
 * API server (v0.22.2, conferido no contêiner): /health, POST /v1/runs (input, instructions, model, provider;
 * Idempotency-Key, X-Hermes-Session-Key), GET /v1/runs/{id}, POST /v1/runs/{id}/stop, GET /v1/toolsets,
 * GET /api/model/options. A chave fica só no servidor Ergon; o navegador nunca a recebe.
 * Contas, modelo padrão e skills passam pela ponte de controle do plugin (HttpHermesControl, abaixo).
 */
export interface RemoteRun {
  status: string;
  output: string | null;
  error: string | null;
  sessionId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  /** modelo que rodou, quando o motor informa */
  model?: string | null;
  /** quem atendeu de fato (conta e modelo), quando o motor informa ao terminar: depois de uma troca para um modelo reserva,
   *  é o reserva (o campo `model` só repete o que foi pedido) */
  served?: { provider: string | null; model: string | null } | null;
}

export interface Toolset { name: string; label: string; enabled: boolean; configured: boolean; tools: string[] }
export interface ModelProvider {
  slug: string; name: string; current: boolean; authenticated: boolean; models: string[];
  /** preço publicado por milhão de tokens (texto do provedor, ex.: "$2.00"), quando houver */
  pricing: Record<string, { input?: string; output?: string; free?: boolean }>;
}
export interface ModelOptions { model: string | null; provider: string | null; providers: ModelProvider[] }

export interface StartRun {
  input: string; instructions: string; sessionKey: string; idempotencyKey: string;
  /** modelo do agente; vazio = modelo padrão da conta */
  model?: string | null; provider?: string | null;
  /** imagens anexadas pela pessoa (visão do modelo): vão como partes da mensagem, em data URL */
  images?: Array<{ mime: string; base64: string }>;
  /** equipe nativa (rc.27): o perfil do agente no motor; a execução vai para /p/<perfil>/v1/runs. Vazio = o perfil padrão */
  profile?: string | null;
}

/** O nome de um perfil de agente no motor (o mesmo formato que o plugin aceita). */
export const PERFIL_NOME = /^erg-[0-9a-f]{20}$/;
/** O começo do caminho da API do motor para um perfil ('' = o perfil padrão). */
export const prefixoDoPerfil = (profile: string | null | undefined): string => (profile && PERFIL_NOME.test(profile) ? `/p/${profile}` : '');

/**
 * Evento da execução, ao vivo (GET /v1/runs/{id}/events, SSE, conferido no Hermes v0.22.2): message.delta (texto
 * chegando), message.interim (comentário no meio), tool.started / tool.completed (ferramenta), subagent.start, e os
 * terminais run.completed / run.failed / run.cancelled. O estado final continua vindo de GET /v1/runs/{id}.
 */
export interface RunEvent {
  event: string; delta?: string; text?: string; tool?: string; preview?: string; duration?: number; error?: boolean;
  /** approval.request / approval.responded (rc.27, aprovações nativas): o pedido, o comando, por que pede e as escolhas */
  requestId?: string; command?: string; description?: string; patternKey?: string; choices?: string[]; choice?: string;
}

export interface HermesClient {
  health(): Promise<{ ok: boolean; detail: string }>;
  startRun(p: StartRun): Promise<{ runId: string; replayed: boolean }>;
  /** profile: o perfil em que a execução começou (as rotas dela ficam sob o mesmo /p/<perfil>/) */
  getRun(runId: string, profile?: string | null): Promise<RemoteRun>;
  stop(runId: string, profile?: string | null): Promise<{ accepted: boolean; detail: string }>;
  /** Orientar sem interromper (POST /v1/runs/{id}/steer, conferido no Hermes v0.22.2): o texto entra no trabalho em
   *  andamento na próxima volta do agente. true = recebida; false = o trabalho não aceita agora (já terminou, ainda não
   *  começou). Sem suporte = ausente. profile: o perfil em que a execução começou. */
  steer?(runId: string, text: string, profile?: string | null): Promise<boolean>;
  /**
   * Responde a um pedido de aprovação da execução (POST /v1/runs/{id}/approval, conferido no Hermes v0.22.2): choice once,
   * session, always ou deny; requestId = o pedido (approval.request). Devolve quantos pedidos foram resolvidos (0 = o motor
   * já não esperava: o prazo acabou ou o trabalho terminou). Sem suporte = ausente.
   */
  approve?(runId: string, choice: 'once' | 'session' | 'always' | 'deny', requestId: string | null, profile?: string | null): Promise<number>;
  /** acompanha a execução ao vivo até o fim (ou até `signal`); sem suporte = sem efeito */
  events?(runId: string, onEvent: (e: RunEvent) => void, signal: AbortSignal, profile?: string | null): Promise<void>;
  toolsets?(): Promise<Toolset[]>;
  modelOptions?(refresh?: boolean): Promise<ModelOptions>;
}

/**
 * A ponte de controle ainda não está ouvindo: logo depois de o motor ficar "aberto" (o contêiner subiu e a API respondeu),
 * o plugin pode ainda não ter aberto a porta da ponte, ou o nome do contêiner ainda não resolve. O pedido nem chegou lá,
 * então tentar de novo em seguida é seguro (o ensaio da rc.27 via "erro interno" em Contas de IA nesse intervalo). Tempo
 * esgotado NÃO entra: o pedido pode ter chegado.
 */
const NAO_CHEGOU = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
export function pedidoNaoChegou(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { code?: string; errors?: Array<{ code?: string }> } } | null;
  if (!e || e.name === 'TimeoutError' || e.name === 'AbortError') return false;
  const codigos = [e.code, e.cause?.code, ...(e.cause?.errors ?? []).map((x) => x?.code)];
  return codigos.some((c) => !!c && NAO_CHEGOU.has(c));
}
/** as esperas entre as tentativas quando a ponte ainda não ouve (no total, uns 3,5 s) */
export const ESPERAS_PONTE = [500, 1000, 2000];
export async function fetchPonte(url: string, init: RequestInit, esperas: readonly number[] = ESPERAS_PONTE): Promise<Response> {
  for (let i = 0; ; i++) {
    try { return await fetch(url, init); } catch (err) {
      if (i >= esperas.length || !pedidoNaoChegou(err) || init.signal?.aborted) throw err;
      await new Promise((ok) => setTimeout(ok, esperas[i]));
    }
  }
}

export class HermesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Conversar pelo Telegram e pelo Discord: o motivo de uma recusa da ponte (a tela traduz pelo código). */
export type CodigoCanal = 'formato' | 'codigo' | 'tentativas' | 'motor';
export class CanalErro extends Error {
  readonly code: CodigoCanal;
  constructor(code: CodigoCanal, message: string) { super(message); this.code = code; }
}
/** Um canal no motor: o código do bot guardado (nunca o valor), a situação da conexão e quem está ligado. */
export interface CanalNoMotor { configurado: boolean; estado: string | null; erro: string | null; ligados: Array<{ user_id: string; user_name: string }> }
export type NomeCanal = 'telegram' | 'discord';

const RUN_ID = /^run_[A-Za-z0-9_-]{3,64}$/;

export class HttpHermesClient implements HermesClient {
  private readonly baseUrl: string;
  private readonly key: string | null;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, key: string | null, timeoutMs = 15000) {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('endereço do motor de IA inválido (ERGON_HERMES_URL)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
    // as mensagens destes erros vão para o pedido (a tela): "a equipe de IA", nunca as peças por dentro
    if (!this.key) throw new HermesError(503, 'a equipe de IA está sem a chave de acesso nesta instalação');
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HermesError(503, 'a equipe de IA não respondeu');
    }
    let json: Record<string, unknown> = {};
    try {
      const t = await res.text();
      json = t ? (JSON.parse(t) as Record<string, unknown>) : {};
    } catch { json = {}; }
    if (!res.ok) {
      const err = json.error as Record<string, unknown> | string | undefined;
      const msg = (typeof err === 'object' && err ? String(err.message ?? '') : String(err ?? '')) || (res.status >= 500 ? 'a equipe de IA teve um problema agora; tente de novo' : 'a equipe de IA recusou o pedido');
      throw new HermesError(res.status, friendly(msg).slice(0, 300));
    }
    return { status: res.status, json, headers: res.headers };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(this.baseUrl + '/health', { signal: AbortSignal.timeout(4000) });
      // o detalhe vai para a Saúde ("fora do ar agora (…)"): sem código nem erro de rede
      if (!res.ok) return { ok: false, detail: res.status >= 500 ? 'com um problema' : 'recusou a conferência' };
      return { ok: true, detail: 'a equipe de IA respondeu' };
    } catch {
      return { ok: false, detail: 'sem resposta' };
    }
  }

  async startRun(p: StartRun) {
    const body: Record<string, unknown> = { input: p.input, instructions: p.instructions };
    // com imagem: a mensagem vai em partes (texto + image_url), o formato de visão que o motor entende
    if (p.images?.length) {
      body.input = [{ role: 'user', content: [{ type: 'text', text: p.input },
        ...p.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }))] }];
    }
    if (p.model) body.model = p.model;
    if (p.model && p.provider) body.provider = p.provider;
    const r = await this.call('POST', `${prefixoDoPerfil(p.profile)}/v1/runs`, body, {
      'Idempotency-Key': p.idempotencyKey,
      'X-Hermes-Session-Key': p.sessionKey,
    });
    const runId = r.json.run_id;
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new HermesError(502, 'a equipe de IA não começou o pedido direito; tente de novo');
    return { runId, replayed: r.headers.get('idempotency-replayed') === 'true' || r.json.replayed === true };
  }

  async events(runId: string, onEvent: (e: RunEvent) => void, signal: AbortSignal, profile?: string | null): Promise<void> {
    if (!RUN_ID.test(runId) || !this.key) return;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${prefixoDoPerfil(profile)}/v1/runs/${runId}/events`, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'text/event-stream' }, signal });
    } catch { return; }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (typeof e.event !== 'string') continue;
          const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
          onEvent({ event: e.event, delta: str(e.delta), text: str(e.text), tool: str(e.tool), preview: str(e.preview), duration: typeof e.duration === 'number' ? e.duration : undefined, error: e.error === true || (typeof e.error === 'string' && !!e.error),
            requestId: str(e.request_id), command: str(e.command), description: str(e.description), patternKey: str(e.pattern_key), choice: str(e.choice),
            choices: Array.isArray(e.choices) ? e.choices.filter((c): c is string => typeof c === 'string').slice(0, 6) : undefined });
          if (/^run\.(completed|failed|cancelled)$/.test(e.event)) return;
        }
      }
    } catch { /* conexão caiu ou parada pedida: o estado final vem da consulta normal */ }
    finally { try { await reader.cancel(); } catch { /* já fechado */ } }
  }

  async approve(runId: string, choice: 'once' | 'session' | 'always' | 'deny', requestId: string | null, profile?: string | null): Promise<number> {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    try {
      const { json } = await this.call('POST', `${prefixoDoPerfil(profile)}/v1/runs/${runId}/approval`, { choice, ...(requestId ? { request_id: requestId } : {}) });
      return Number(json.resolved) || 0;
    } catch (e) {
      // 404/409: a execução não espera mais (terminou, o prazo do pedido acabou)
      if (e instanceof HermesError && (e.status === 404 || e.status === 409)) return 0;
      throw e;
    }
  }

  async getRun(runId: string, profile?: string | null): Promise<RemoteRun> {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    const { json } = await this.call('GET', `${prefixoDoPerfil(profile)}/v1/runs/${runId}`);
    const usage = (json.usage ?? null) as Record<string, unknown> | null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      status: String(json.status ?? 'unknown'),
      output: typeof json.output === 'string' ? json.output : null,
      error: json.error ? String(typeof json.error === 'object' ? JSON.stringify(json.error) : json.error).slice(0, 500) : null,
      sessionId: typeof json.session_id === 'string' ? json.session_id : null,
      // ausente ≠ zero: só registra custo/tokens quando o provedor informa
      usage: usage ? {
        inputTokens: num(usage.input_tokens ?? usage.prompt_tokens),
        outputTokens: num(usage.output_tokens ?? usage.completion_tokens),
        costUsd: num(usage.cost ?? usage.cost_usd),
      } : null,
      model: typeof json.model === 'string' ? json.model : null,
      served: parseServed(json.runtime),
    };
  }

  async steer(runId: string, text: string, profile?: string | null): Promise<boolean> {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    try {
      const { json } = await this.call('POST', `${prefixoDoPerfil(profile)}/v1/runs/${runId}/steer`, { input: text });
      return json.accepted === true;
    } catch (e) {
      // 409: o trabalho não está recebendo orientação agora (terminou, parando, ainda não começou); 404: o motor não o conhece mais
      if (e instanceof HermesError && (e.status === 409 || e.status === 404)) return false;
      throw e;
    }
  }

  async toolsets(): Promise<Toolset[]> {
    const { json } = await this.call('GET', '/v1/toolsets');
    const raw = json as unknown;
    const arr = (Array.isArray(raw) ? raw : ((json.data ?? json.toolsets ?? []) as unknown[])) as Array<Record<string, unknown>>;
    return arr.map((t) => ({ name: String(t.name), label: String(t.label ?? t.name), enabled: t.enabled === true, configured: t.configured !== false, tools: Array.isArray(t.tools) ? t.tools.map(String) : [] }));
  }

  async modelOptions(refresh = false): Promise<ModelOptions> {
    const { json } = await this.call('GET', `/api/model/options${refresh ? '?refresh=true' : ''}`);
    return parseModelOptions(json);
  }

  async stop(runId: string, profile?: string | null) {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    const { json } = await this.call('POST', `${prefixoDoPerfil(profile)}/v1/runs/${runId}/stop`, {});
    return { accepted: true, detail: String(json.status ?? 'stopping') };
  }
}

/** O par (conta, modelo) que atendeu a execução, como o motor informa no estado final (`runtime`). */
export function parseServed(raw: unknown): { provider: string | null; model: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null);
  const provider = s(r.provider), model = s(r.model);
  return provider || model ? { provider, model } : null;
}

export function parseModelOptions(json: Record<string, unknown>): ModelOptions {
  const providers = (Array.isArray(json.providers) ? json.providers : []) as Array<Record<string, unknown>>;
  return {
    model: typeof json.model === 'string' ? json.model : null,
    provider: typeof json.provider === 'string' ? json.provider : null,
    providers: providers.map((p) => ({
      slug: String(p.slug), name: String(p.name ?? p.slug), current: p.is_current === true, authenticated: p.authenticated === true,
      models: Array.isArray(p.models) ? p.models.map(String) : [],
      pricing: (p.pricing && typeof p.pricing === 'object' ? p.pricing : {}) as ModelProvider['pricing'],
    })),
  };
}

/** Mensagens de erro do motor, sem o nome dele (o usuário não precisa saber o que roda por baixo): "a equipe de IA". */
export function friendly(msg: string): string {
  return msg.replace(/run `hermes [^`]+`/gi, 'conecte a conta em Conexões').replace(/\bHermes( Agent)?\b/gi, 'a equipe de IA');
}

/** Estados remotos → estados Ergon. 'unknown' (dono reiniciado) exige reconciliação, não repetição. */
export function mapRemoteStatus(s: string): 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' {
  switch (s) {
    case 'completed': return 'succeeded';
    case 'failed': case 'interrupted': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'waiting_for_approval': case 'waiting_for_clarification': return 'waiting_user';
    case 'unknown': return 'unknown';
    default: return 'running';
  }
}

// ---------------------------------------------------------------- ponte de controle (plugin do Ergon)

export interface AccountStatus { id: string; name: string; connected: boolean; freeTier: boolean | null; tier: string | null; expiresAt: string | null }
export interface LoginStart { sessionId: string; userCode: string | null; verificationUrl: string | null; expiresAt: string | null; pollSeconds: number }
export interface LoginPoll { status: string; error: string | null; email: string | null; model: string | null }
export interface SkillInfo { name: string; description: string; category: string; enabled: boolean }

/**
 * O que o plugin do Ergon no motor diz de si (GET /ergon/v1/health): versão do plugin, versão da configuração do cofre e
 * as capacidades. Plugin antigo responde só {ok, dashboard}: capacidades = null (não se sabe).
 */
export interface MotorInfo {
  ok: boolean; pluginVersion: string | null; vaultConfig: number | null; capacidades: string[] | null;
  /**
   * o cofre recebeu a cópia dos dados de antes dele (o volume antigo, sem cifra)? true/false pela marca do cofre; null =
   * não se sabe (plugin de antes, ou sem marca). Só com true o volume antigo pode sair.
   */
  dadosAntigos?: boolean | null;
}
/** capacidade (rc.27): as rotinas com horário ficam no agendador do motor, no perfil do agente (/ergon/v1/rotinas) */
export const CAPACIDADE_ROTINAS = 'rotinas';
/** O job de uma rotina no agendador do motor, como o plugin informa. */
export interface JobDaRotina { rotina: string; jobId: string | null; proxima: string | null; ultima: string | null; ultimoEstado: string | null; pausada: boolean; agenda: string | null }
/** O que o Ergon pede para o job de uma rotina: no perfil do agente, nestes dias (0 = domingo) e hora, no fuso da pessoa. */
export interface PedidoDeRotina { perfil: string; antes?: string | null; nome: string; dias: number[]; hora: string; fuso: string; ligada: boolean }
export function parseJobDaRotina(j: unknown): JobDaRotina {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const s = (v: unknown, n = 64) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const iso = (v: unknown) => { const x = s(v); return x && Number.isFinite(Date.parse(x)) ? new Date(Date.parse(x)).toISOString() : null; };
  const job = s(o.job_id, 12);
  return { rotina: s(o.rotina, 40) ?? '', jobId: job && /^[a-f0-9]{12}$/.test(job) ? job : null, proxima: iso(o.proxima), ultima: iso(o.ultima), ultimoEstado: s(o.ultimo_estado, 40), pausada: o.pausada === true, agenda: s(o.agenda, 80) };
}
/** O que o Ergon pede para o perfil de um agente (PUT /ergon/v1/perfis/<nome>): tudo o que é do agente e não do pedido. */
export interface PedidoDePerfil {
  /** identidade, função e instruções do agente (o SOUL.md do perfil) */
  alma: string;
  /** conjuntos de ferramentas do motor que o agente pode usar (o perfil fica com os que a pessoa ligou para a equipe) */
  ferramentas: string[];
  memoria: boolean; busca: boolean;
  ajudantes: { ligado: boolean; max: number };
  modelo: { provider: string; model: string } | null;
  /** competências do agente (as aprendidas no Treinar e as da biblioteca atribuídas): moram no perfil */
  competencias: string[];
}
/** A memória longa de um agente: o que ele sabe da pessoa, as notas dele e o que espera aprovação. */
export interface MemoriaDoAgente {
  notas: string; pessoa: string;
  pendentes: Array<{ id: string; criado: number | null; alvo: 'pessoa' | 'notas'; itens: Array<{ acao: string; texto: string; antes: string }> }>;
}
export function parseMemoria(j: unknown): MemoriaDoAgente {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const txt = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  const pend = Array.isArray(o.pendentes) ? o.pendentes : [];
  return {
    notas: txt(o.notas, 20_000), pessoa: txt(o.pessoa, 20_000),
    pendentes: pend.slice(0, 100).filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && /^[A-Za-z0-9_-]{1,40}$/.test(String((p as { id?: unknown }).id ?? ''))).map((p) => ({
      id: String(p.id), criado: typeof p.criado === 'number' && Number.isFinite(p.criado) ? p.criado : null, alvo: p.alvo === 'pessoa' ? 'pessoa' as const : 'notas' as const,
      itens: (Array.isArray(p.itens) ? p.itens : []).slice(0, 20).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i) => ({ acao: txt(i.acao, 20), texto: txt(i.texto, 4000), antes: txt(i.antes, 4000) })),
    })),
  };
}
/** capacidade que diz que o motor tem as ferramentas das Conexões */
export const CAPACIDADE_CONEXOES = 'conexoes';
/** capacidade que diz que, com a proteção ligada em Conexões, o plugin pede a aprovação da pessoa (sem ela, só barra) */
export const CAPACIDADE_APROVAR_DEPOIS_DE_LER = 'aprovar_depois_de_ler';
/** Chaves que a pessoa guardou para a equipe por um cartão: só nomes (nunca valores); sudo: há senha de administrador guardada */
export interface ChavesGuardadas { chaves: Array<{ nome: string; motivo: string; quando: string; agente: string }>; sudo: boolean }
export interface VereditoMeta { veredito: 'done' | 'continue' | 'blocked' | 'wait' | 'skipped'; motivo: string; continuar: string; semJuiz: boolean }
export function parseMotorInfo(j: Record<string, unknown>): MotorInfo {
  const caps = Array.isArray(j.capacidades) ? j.capacidades.filter((x): x is string => typeof x === 'string').slice(0, 50) : null;
  const vc = typeof j.vault_config === 'number' ? j.vault_config : typeof j.vault_config === 'string' && /^\d+$/.test(j.vault_config) ? Number(j.vault_config) : null;
  return { ok: j.ok === true && j.dashboard === true, pluginVersion: typeof j.plugin_version === 'string' ? j.plugin_version.slice(0, 40) : null, vaultConfig: vc, capacidades: caps,
    dadosAntigos: typeof j.dados_antigos === 'boolean' ? j.dados_antigos : null };
}

export interface HermesControlClient {
  health(): Promise<boolean>;
  /** versão e capacidades do plugin (ausente = cliente antigo, não se sabe) */
  info?(): Promise<MotorInfo>;
  accounts(): Promise<AccountStatus[]>;
  startLogin(provider: string): Promise<LoginStart>;
  pollLogin(provider: string, sessionId: string): Promise<LoginPoll>;
  cancelLogin(sessionId: string): Promise<void>;
  disconnect(provider: string): Promise<void>;
  modelInfo(): Promise<{ model: string | null; provider: string | null }>;
  setDefaultModel(provider: string, model: string, confirm: boolean): Promise<{ ok: boolean; confirmMessage: string | null }>;
  skills(): Promise<SkillInfo[]>;
  apiToolsets(): Promise<{ enabled: string[]; safe: string[] }>;
  setApiToolsets(enabled: string[]): Promise<string[]>;
  /** imagem gerada pelo motor (só da pasta das geradas; a ponte confere) */
  media?(path: string): Promise<{ data: Buffer; mime: string }>;
  /** Custo: as chamadas ao modelo de uma sessão do motor, desde um instante (ms desde 1970), com o tamanho de cada parte
   *  e o total informado pelo provedor, e o relógio do motor na resposta (plugin 0.4.0+; ausente ou 404 = sem a medição) */
  medicao?(sessao: string, desdeMs: number): Promise<MedicaoSessao>;
  /** Passos por pedido (agent.max_turns) do motor; null = não se sabe (plugin 0.4.0+) */
  passos?(): Promise<number | null>;
  setPassos?(n: number): Promise<number>;
  /** Resumir as conversas longas mais cedo (compression.threshold_tokens no motor): ligado ou não; null = não se sabe
   *  (plugin com a capacidade compactacao, rc.26; o anterior responde 404) */
  compactacao?(): Promise<boolean | null>;
  setCompactacao?(ligada: boolean): Promise<boolean | null>;
  /**
   * Modelos por tarefa (plugin com a capacidade modelos_tarefa, rc.27; o anterior responde 404 = null): o modelo de cada
   * tarefa de apoio do motor (resumir a conversa, dar nome, ver imagens… e as que os plugins registrarem) e o modelo
   * principal. `perfil` = o perfil do agente no motor (/p/<perfil>/...); sem ele, o do motor.
   */
  auxModels?(perfil?: string | null): Promise<AuxModels | null>;
  /** grava o modelo de uma tarefa de apoio; provider e model nulos = usar o principal */
  setAuxModel?(task: string, provider: string | null, model: string | null, confirm: boolean, perfil?: string | null): Promise<{ ok: boolean; confirmMessage: string | null }>;
  /** o modelo dos ajudantes temporários (delegation.provider/model); os dois nulos = o de quem pediu a ajuda */
  delegacao?(perfil?: string | null): Promise<{ provider: string | null; model: string | null } | null>;
  setDelegacao?(provider: string | null, model: string | null, perfil?: string | null): Promise<boolean | null>;
  /** para cada modelo: aceita imagem? (true/false pelo que o motor sabe; null = não se sabe) */
  modelosVisao?(modelos: Array<{ provider: string; model: string }>): Promise<Array<boolean | null> | null>;
  /** Ajustes do motor que a pessoa escolhe (rc.27, capacidade "ajustes"): modelos reserva, não treinar com os dados, busca
   *  privada, arrumar competências sem uso e o idioma das mensagens do motor. null = motor de antes (404). */
  ajustes?(): Promise<AjustesMotor | null>;
  /** grava só o que veio; devolve como ficou. Busca privada num motor sem a busca direta: HermesError 409. */
  setAjustes?(patch: AjustesPatch): Promise<AjustesMotor | null>;
  /** Limites e saldo da conta de IA, lidos do provedor pelo motor (capacidade "cota"); null = motor de antes */
  cota?(atualizar?: boolean): Promise<CotaConta[] | null>;
  /** Pausa do trabalho novo no motor (a parada geral do Hermes; capacidade "pausa"); null = motor de antes */
  pausa?(): Promise<boolean | null>;
  setPausa?(pausada: boolean): Promise<boolean | null>;
  /** Treinar: as operações de competência (skill) que o Ergon faz pela ponte; ausente = motor sem suporte */
  skills_?: SkillControl;
  /** Treinar dentro do perfil de um agente (rc.27): a competência mora com ele; ausente = só o perfil padrão */
  skillsDe?(perfil: string): SkillControl;
  /** Equipe nativa (rc.27): cria ou atualiza o perfil de um agente no motor (idempotente); ausente = motor sem perfis */
  perfil?(nome: string, pedido: PedidoDePerfil): Promise<{ criado: boolean; mudou: string[] }>;
  /** Rotinas no agendador do motor (rc.27, capacidade "rotinas"): o job da rotina no perfil do agente (idempotente), tirar,
   *  rodar agora (no próximo tique do agendador) e os jobs de um perfil. Ausente = motor sem a capacidade. */
  rotina?(id: string, pedido: PedidoDeRotina): Promise<JobDaRotina>;
  removerRotina?(id: string, perfil: string): Promise<boolean>;
  rodarRotina?(id: string, perfil: string): Promise<JobDaRotina>;
  rotinasDoPerfil?(perfil: string): Promise<JobDaRotina[]>;
  /** A memória longa do agente e as anotações em espera; aprovar ou recusar uma delas */
  memoria?(perfil: string): Promise<MemoriaDoAgente>;
  decidirMemoria?(perfil: string, id: string, aprovar: boolean): Promise<void>;
  /** Capacidades da equipe (rc.27, capacidade "recursos" do plugin): rotas fechadas /ergon/v1/<sub>. Devolve o código e o
   *  corpo como vieram (o 404 de um plugin anterior e o 409 da varredura chegam aqui, não como exceção). */
  recursos?(method: 'GET' | 'PUT' | 'POST' | 'DELETE', sub: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; json: any }>;
  /** Endpoint próprio "ergon-ai" do motor (módulo opcional; sem uso na Community) */
  ergonAi?(c: { baseUrl: string; apiKey: string; models: string[]; makeDefault: boolean }): Promise<void>;
  removeErgonAi?(): Promise<void>;
  /** Chave própria (BYOK): o catálogo de provedores do próprio motor (quais estão ligadas, nunca o valor), gravar (o
   *  motor confere a chave no provedor antes), apagar; e endpoints próprios compatíveis com a OpenAI ("outro", LM
   *  Studio, Ollama). Ausente = motor sem suporte. */
  byok?(): Promise<ByokCatalog>;
  setByok?(provider: string, key: string): Promise<{ verified: boolean }>;
  removeByok?(provider: string): Promise<void>;
  addByokCustom?(c: ByokCustomInput): Promise<{ id: string; models: number }>;
  removeByokCustom?(id: string): Promise<void>;
  /** Chaves guardadas para a equipe por um cartão (plugin 0.5.0+): listar nomes, gravar o valor que a pessoa digitou
   *  (vai direto ao cofre do motor; nunca volta), apagar. sudo: a senha de administrador guardada. Ausente = sem suporte. */
  chavesGuardadas?(): Promise<ChavesGuardadas>;
  guardarChave?(c: { nome: string; valor: string; motivo?: string; agente?: string; sudo?: boolean }): Promise<void>;
  apagarChave?(nome: string): Promise<boolean>;
  /** Meta com juiz: o juiz do próprio motor diz se o critério foi cumprido (chama o modelo auxiliar: custa) */
  julgarMeta?(meta: string, resposta: string): Promise<VereditoMeta>;
  /** Revisão independente: o pedido de revisão do próprio motor, a partir do trecho recente do trabalho */
  pedidoRevisao?(mensagens: Array<{ role: 'user' | 'assistant'; text: string }>, foco: string): Promise<{ titulo: string; pedido: string }>;
  /** Conversar pelo Telegram e pelo Discord (plugin com a capacidade "canais", rc.27): a situação, guardar o código do bot
   *  no motor (o gateway reinicia), confirmar o código de pareamento que a pessoa recebeu no canal e desligar. Ausente =
   *  motor sem suporte. */
  canais?(): Promise<Record<NomeCanal, CanalNoMotor>>;
  setCanal?(canal: NomeCanal, token: string): Promise<void>;
  parearCanal?(canal: NomeCanal, codigo: string): Promise<{ userId: string; userName: string; chatId: string }>;
  removerCanal?(canal: NomeCanal): Promise<void>;
}

/**
 * Uma chamada ao modelo, medida pelo plugin do motor (pre_api_request/post_api_request): tamanhos em caracteres do que foi
 * de verdade ao provedor — o prompt de sistema inteiro (dentro dele, a memória e a lista de competências), as definições
 * das ferramentas, a conversa — e o total que o provedor informou (null = não informou). Nada do conteúdo.
 */
export interface ChamadaMedida {
  /** t: o relógio do motor (segundos); n: o número da chamada no pedido (recomeça a cada pedido); turno: a marca do pedido
   *  no motor (as chamadas de um mesmo pedido têm a mesma; vazio = não informada) */
  t: number; n: number; turno: string; sistema: number; memoria: number; competencias: number; ferramentas: number; ferramentasExato: boolean;
  nFerramentas: number; conversa: number; imagens: number; modelo: string;
  /** o tamanho (caracteres) do resumo da conversa que foi nessa chamada: o motor compactou a parte antiga da conversa
   *  (rc.26); 0 = sem resumo; ausente = motor que não informa */
  resumo?: number;
  uso: { entrada: number; cacheLido: number; cacheGravado: number; saida: number } | null;
}
const inteiro = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
export function parseChamadas(j: unknown): ChamadaMedida[] {
  const arr = j && typeof j === 'object' && Array.isArray((j as { chamadas?: unknown }).chamadas) ? (j as { chamadas: unknown[] }).chamadas : [];
  return arr.slice(-200).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((x) => {
    const u = x.uso && typeof x.uso === 'object' ? x.uso as Record<string, unknown> : null;
    return {
      t: typeof x.t === 'number' && Number.isFinite(x.t) ? x.t : 0, n: inteiro(x.n), turno: typeof x.turno === 'string' ? x.turno.slice(0, 64) : '', sistema: inteiro(x.sistema), memoria: inteiro(x.memoria),
      competencias: inteiro(x.competencias), ferramentas: inteiro(x.ferramentas), ferramentasExato: x.ferramentas_exato === true,
      nFerramentas: inteiro(x.n_ferramentas), conversa: inteiro(x.conversa), imagens: inteiro(x.imagens), modelo: typeof x.modelo === 'string' ? x.modelo.slice(0, 120) : '',
      ...(typeof x.resumo === 'number' ? { resumo: inteiro(x.resumo) } : {}),
      uso: u && inteiro(u.entrada) ? { entrada: inteiro(u.entrada), cacheLido: inteiro(u.cache_lido), cacheGravado: inteiro(u.cache_gravado), saida: inteiro(u.saida) } : null,
    };
  });
}
/** A resposta de /ergon/v1/medicao: as chamadas e o relógio do motor na hora da resposta (ms; null = não informou). */
export interface MedicaoSessao { chamadas: ChamadaMedida[]; agoraMs: number | null }
export function parseMedicao(j: unknown): MedicaoSessao {
  const agora = j && typeof j === 'object' ? (j as { agora?: unknown }).agora : null;
  return { chamadas: parseChamadas(j), agoraMs: typeof agora === 'number' && Number.isFinite(agora) && agora > 0 ? agora * 1000 : null };
}

/** Uma tarefa de apoio do motor e o modelo dela. provider/model nulos = usa o principal ("auto" no motor). */
export interface AuxTaskRow {
  task: string; provider: string | null; model: string | null;
  /** tarefa registrada por um plugin: o nome e a explicação que o plugin declarou, e de quem ela herda */
  label?: string; hint?: string; plugin?: string; inheritFrom?: string | null;
  /** tarefa de plugin que herda de outra e não tem modelo próprio: para onde ela resolve agora */
  effective?: { provider: string | null; model: string | null };
}
export interface AuxModels { tasks: AuxTaskRow[]; main: { provider: string | null; model: string | null } }
const TAREFA_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const rota = (provider: unknown, model: unknown): { provider: string | null; model: string | null } => {
  const p = typeof provider === 'string' ? provider.trim() : '';
  const m = typeof model === 'string' ? model.trim() : '';
  // "auto" (ou vazio) é o jeito de o motor dizer "usa o principal"; modelo sem conta também não fixa nada
  return !p || p === 'auto' || !m ? { provider: null, model: null } : { provider: p.slice(0, 41), model: m.slice(0, 160) };
};
export function parseAuxModels(j: unknown): AuxModels {
  const o = j && typeof j === 'object' ? j as Record<string, unknown> : {};
  const main = o.main && typeof o.main === 'object' ? o.main as Record<string, unknown> : {};
  const vistos = new Set<string>();
  const tasks: AuxTaskRow[] = [];
  for (const x of (Array.isArray(o.tasks) ? o.tasks : []).slice(0, 200)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const task = typeof r.task === 'string' ? r.task : '';
    if (!TAREFA_RE.test(task) || vistos.has(task)) continue;
    vistos.add(task);
    const ef = r.effective && typeof r.effective === 'object' ? r.effective as Record<string, unknown> : null;
    tasks.push({
      task, ...rota(r.provider, r.model),
      ...(typeof r.label === 'string' && r.label ? { label: r.label.slice(0, 80) } : {}),
      ...(typeof r.hint === 'string' && r.hint ? { hint: r.hint.slice(0, 240) } : {}),
      ...(typeof r.plugin === 'string' && r.plugin ? { plugin: r.plugin.slice(0, 80) } : {}),
      ...(typeof r.inherit_from === 'string' && r.inherit_from ? { inheritFrom: r.inherit_from.slice(0, 64) } : {}),
      ...(ef ? { effective: rota(ef.provider, ef.model) } : {}),
    });
  }
  return { tasks, main: { provider: pick(main, 'provider'), model: pick(main, 'model') } };
}
/** O caminho de uma rota de modelo no motor: do perfil do agente (/p/<perfil>/...) ou, sem perfil, do próprio motor. */
export const PERFIL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function rotaDoPerfil(perfil: string | null | undefined, path: string): string {
  if (!perfil) return path;
  if (!PERFIL_RE.test(perfil)) throw new HermesError(400, 'perfil inválido');
  return `/p/${perfil}${path}`;
}

export interface ModeloReserva { provider: string; model: string }
/** O que vale no motor (GET /ergon/v1/ajustes). */
export interface AjustesMotor {
  reserva: ModeloReserva[]; naoTreinar: boolean; buscaPrivada: boolean;
  /** o motor tem com o que buscar direto (sem isso, ligar a busca privada deixaria a equipe sem busca: ele recusa) */
  buscaPrivadaDisponivel: boolean; arrumarCompetencias: boolean; idioma: string;
  /** anotar na memória depois da conversa (a revisão de fundo do motor, só a parte de memória); undefined = motor de antes */
  anotarMemoria?: boolean;
  /** a profundidade do raciocínio gravada no motor (agent.reasoning_effort; '' = a do modelo); undefined = motor de antes */
  raciocinio?: string;
}
/** A profundidade do raciocínio que a tela oferece ('modelo' = a do próprio modelo; no motor, ''). */
export type Raciocinio = 'high' | 'medium' | 'low' | 'modelo';
export interface AjustesPatch { reserva?: ModeloReserva[]; naoTreinar?: boolean; buscaPrivada?: boolean; arrumarCompetencias?: boolean; anotarMemoria?: boolean; raciocinio?: Raciocinio; idioma?: 'pt' | 'en' }
export function parseAjustes(j: unknown): AjustesMotor | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (!Array.isArray(o.reserva) || typeof o.nao_treinar !== 'boolean') return null;
  const reserva = o.reserva.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({ provider: String(e.provider ?? '').slice(0, 60), model: String(e.model ?? '').slice(0, 160) })).filter((e) => e.provider && e.model).slice(0, 5);
  return { reserva, naoTreinar: o.nao_treinar, buscaPrivada: o.busca_privada === true, buscaPrivadaDisponivel: o.busca_privada_disponivel === true,
    arrumarCompetencias: o.arrumar_competencias === true, idioma: typeof o.idioma === 'string' ? o.idioma.slice(0, 12) : 'en',
    ...(typeof o.anotar_memoria === 'boolean' ? { anotarMemoria: o.anotar_memoria } : {}),
    ...(typeof o.raciocinio === 'string' ? { raciocinio: o.raciocinio.slice(0, 12) } : {}) };
}
/** Uma janela de limite da conta: quanto já foi usado (0 a 100) e quando renova. */
export interface CotaJanela { tipo: 'sessao' | 'semana' | 'semana_modelo' | 'assinatura' | 'chave' | 'outro'; rotulo: string; usado: number; renovaEm: string | null; escopo: 'conta' | 'modelo' }
export interface CotaConta { provedor: string; plano: string | null; janelas: CotaJanela[]; saldoUsd: number | null; saldoIlimitado: boolean; renovaEm: string | null; lidoEm: string | null }
const TIPOS_JANELA = new Set(['sessao', 'semana', 'semana_modelo', 'assinatura', 'chave', 'outro']);
export function parseCota(j: unknown): CotaConta[] {
  const arr = j && typeof j === 'object' && Array.isArray((j as { contas?: unknown }).contas) ? (j as { contas: unknown[] }).contas : [];
  const txt = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  return arr.slice(0, 6).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((c) => ({
    provedor: txt(c.provedor, 40) ?? '', plano: txt(c.plano, 40),
    janelas: (Array.isArray(c.janelas) ? c.janelas : []).slice(0, 8).filter((w): w is Record<string, unknown> => !!w && typeof w === 'object' && typeof (w as Record<string, unknown>).usado === 'number' && Number.isFinite((w as Record<string, unknown>).usado))
      .map((w) => ({ tipo: (TIPOS_JANELA.has(String(w.tipo)) ? String(w.tipo) : 'outro') as CotaJanela['tipo'], rotulo: txt(w.rotulo, 40) ?? '',
        usado: Math.max(0, Math.min(100, Number(w.usado))), renovaEm: txt(w.renova_em, 40), escopo: w.escopo === 'modelo' ? 'modelo' as const : 'conta' as const })),
    saldoUsd: typeof c.saldo_usd === 'number' && Number.isFinite(c.saldo_usd) ? c.saldo_usd : null, saldoIlimitado: c.saldo_ilimitado === true,
    renovaEm: txt(c.renova_em, 40), lidoEm: txt(c.lido_em, 40),
  }));
}

export interface ByokCatalog {
  providers: Array<{ id: string; name: string; url: string | null; connected: boolean }>;
  custom: Array<{ id: string; name: string; baseUrl: string; model: string }>;
}
export interface ByokCustomInput { kind: 'outro' | 'lmstudio' | 'ollama'; name: string; baseUrl: string; key?: string }

/** Uma escrita de competência em espera no motor (trava de aprovação nativa: skills.write_approval). */
export interface PendingSkillWrite {
  id: string; action: string; name: string; content?: string; category?: string; file_path?: string; file_content?: string;
  old_string?: string; new_string?: string; replace_all?: boolean;
}
/** Treinar pela ponte de controle (rotas /ergon/v1/learn-prompt e /ergon/v1/skills/*, só com o token da ponte). */
export interface SkillControl {
  /** o turno do /learn do próprio motor (build_learn_prompt) para o pedido */
  learnPrompt(request: string): Promise<string>;
  /** escritas em espera: pelos ids e/ou todas as desta competência (nome), na ordem em que foram feitas */
  pending(ids: string[], name?: string): Promise<PendingSkillWrite[]>;
  /** aplica as escritas em espera (na ordem), com o nome forçado e marcada como privada; devolve os arquivos finais */
  apply(ids: string[], name: string): Promise<Record<string, string>>;
  discard(ids: string[]): Promise<void>;
  files(name: string): Promise<Record<string, string>>;
  /** grava de novo uma versão guardada (restaurar) */
  restore(name: string, files: Record<string, string>): Promise<Record<string, string>>;
  remove(name: string): Promise<void>;
}

const pick = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const k of keys) { const v = o[k]; if (typeof v === 'string' && v) return v; }
  return null;
};

/**
 * Cliente da ponte de controle (rede interna dos contêineres, token da ponte). O plugin só deixa passar uma lista
 * fechada de rotas do painel interno do Hermes; aqui ficam os formatos que o Ergon usa.
 */
export class HttpHermesControl implements HermesControlClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  constructor(baseUrl: string, token: string | null) { this.baseUrl = baseUrl.replace(/\/+$/, ''); this.token = token; }

  private async call(method: string, path: string, body?: unknown, timeoutMs = 25000): Promise<any> {
    // a mensagem vai para a tela (Contas de IA, Treinar): sem as peças por dentro
    if (!this.token) throw new HermesError(503, 'a configuração da equipe de IA não está disponível nesta instalação');
    let res: Response;
    try {
      res = await fetchPonte(this.baseUrl + path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Ergon-Bridge-Token': this.token },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new HermesError(503, 'a equipe de IA não respondeu agora'); }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const d = json?.detail ?? json?.error ?? (res.status >= 500 ? 'a equipe de IA teve um problema agora; tente de novo' : 'a equipe de IA recusou o pedido');
      throw new HermesError(res.status, friendly(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300));
    }
    return json;
  }

  async recursos(method: 'GET' | 'PUT' | 'POST' | 'DELETE', sub: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; json: any }> {
    if (!this.token) throw new HermesError(503, 'a configuração da equipe de IA não está disponível nesta instalação');
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
    let res: Response;
    try {
      // instalar uma competência ou um conector e transcrever um áudio levam mais tempo
      res = await fetchPonte(`${this.baseUrl}/ergon/v1/${sub}${q}`, {
        method, headers: { 'Content-Type': 'application/json', 'X-Ergon-Bridge-Token': this.token },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(/instalar|voz/.test(sub) ? 300000 : 30000),
      });
    } catch { throw new HermesError(503, 'a equipe de IA não respondeu agora'); }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, json };
  }

  async health() { return (await this.info()).ok; }
  async info(): Promise<MotorInfo> {
    try { return parseMotorInfo(await this.call('GET', '/ergon/v1/health', undefined, 5000)); } catch { return { ok: false, pluginVersion: null, vaultConfig: null, capacidades: null }; }
  }

  async accounts(): Promise<AccountStatus[]> {
    const j = await this.call('GET', '/api/providers/oauth');
    return (Array.isArray(j.providers) ? j.providers : []).filter((p: any) => p.id === 'nous' || p.id === 'openai-codex').map((p: any) => ({
      id: String(p.id), name: String(p.name), connected: p.status?.logged_in === true,
      freeTier: typeof p.status?.free_tier === 'boolean' ? p.status.free_tier : null,
      tier: typeof p.status?.account_tier === 'string' ? p.status.account_tier : null,
      expiresAt: typeof p.status?.expires_at === 'string' ? p.status.expires_at : null,
    }));
  }

  async startLogin(provider: string): Promise<LoginStart> {
    const j = await this.call('POST', `/api/providers/oauth/${encodeURIComponent(provider)}/start`, {});
    const secs = Number(j.expires_in);
    return {
      sessionId: String(j.session_id ?? ''), userCode: pick(j, 'user_code', 'code'),
      verificationUrl: pick(j, 'verification_url', 'verification_uri_complete', 'verification_uri', 'url'),
      expiresAt: Number.isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000).toISOString() : pick(j, 'expires_at'),
      pollSeconds: Math.min(15, Math.max(2, Number(j.poll_interval) || 5)),
    };
  }

  async pollLogin(provider: string, sessionId: string): Promise<LoginPoll> {
    const j = await this.call('GET', `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}`);
    return { status: String(j.status ?? 'unknown'), error: pick(j, 'error_message'), email: pick(j, 'account_email'), model: pick(j, 'model') };
  }

  async cancelLogin(sessionId: string) { await this.call('DELETE', `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`); }
  async disconnect(provider: string) { await this.call('DELETE', `/api/providers/oauth/${encodeURIComponent(provider)}`); }

  async byok(): Promise<ByokCatalog> { const j = await this.call('GET', '/ergon/v1/byok'); return { providers: Array.isArray(j.providers) ? j.providers : [], custom: Array.isArray(j.custom) ? j.custom : [] }; }
  async addByokCustom(c: ByokCustomInput) { const j = await this.call('POST', '/ergon/v1/byok/custom', c, 60000); return { id: String(j.id), models: Number(j.models) || 0 }; }
  async removeByokCustom(id: string) { await this.call('DELETE', '/ergon/v1/byok/custom/' + encodeURIComponent(id)); }
  async setByok(provider: string, key: string) { const j = await this.call('PUT', '/ergon/v1/byok', { provider, key }); return { verified: j.verified === true }; }
  async removeByok(provider: string) { await this.call('DELETE', `/ergon/v1/byok/${encodeURIComponent(provider)}`); }

  async modelInfo() { const j = await this.call('GET', '/api/model/info'); return { model: pick(j, 'model'), provider: pick(j, 'provider') }; }

  async setDefaultModel(provider: string, model: string, confirm: boolean) {
    const j = await this.call('POST', '/api/model/set', { provider, model, confirm_expensive_model: confirm });
    if (j.confirm_required) return { ok: false, confirmMessage: friendly(String(j.confirm_message ?? 'modelo caro: confirme')) };
    return { ok: j.ok !== false, confirmMessage: null };
  }

  async skills(): Promise<SkillInfo[]> {
    const j = await this.call('GET', '/api/skills');
    return (Array.isArray(j) ? j : []).map((s: any) => ({ name: String(s.name), description: String(s.description ?? ''), category: String(s.category ?? 'outras'), enabled: s.enabled !== false }));
  }

  async apiToolsets() { const j = await this.call('GET', '/ergon/v1/api-toolsets'); return { enabled: (j.enabled ?? []).map(String), safe: (j.safe ?? []).map(String) }; }
  async ergonAi(c: { baseUrl: string; apiKey: string; models: string[]; makeDefault: boolean }) {
    await this.call('POST', '/api/providers/custom-endpoints', { base_url: c.baseUrl, api_key: c.apiKey, model: c.models[0], models: c.models, make_default: c.makeDefault });
  }
  async removeErgonAi() { await this.call('DELETE', '/api/providers/custom-endpoints/ergon-ai'); }
  async setApiToolsets(enabled: string[]) { const j = await this.call('PUT', '/ergon/v1/api-toolsets', { enabled }); return (j.enabled ?? []).map(String); }
  /** As rotas do Treinar; com `perfil`, valem na pasta do perfil do agente (rc.27). */
  private skillsCom(perfil: string | null): SkillControl {
    const p = perfil && PERFIL_NOME.test(perfil) ? { perfil } : {};
    return {
      learnPrompt: async (request) => String((await this.call('POST', '/ergon/v1/learn-prompt', { request })).prompt ?? ''),
      pending: async (ids, name) => ((await this.call('POST', '/ergon/v1/skills/pending', { ids, ...(name ? { name } : {}), ...p })).records ?? []) as PendingSkillWrite[],
      apply: async (ids, name) => ((await this.call('POST', '/ergon/v1/skills/apply', { ids, name, ...p }, 120000)).files ?? {}) as Record<string, string>,
      discard: async (ids) => { await this.call('POST', '/ergon/v1/skills/discard', { ids, ...p }); },
      files: async (name) => ((await this.call('POST', '/ergon/v1/skills/files', { name, ...p })).files ?? {}) as Record<string, string>,
      restore: async (name, files) => ((await this.call('POST', '/ergon/v1/skills/restore', { name, files, ...p }, 120000)).files ?? {}) as Record<string, string>,
      remove: async (name) => { await this.call('POST', '/ergon/v1/skills/remove', { name, ...p }); },
    };
  }
  readonly skills_: SkillControl = this.skillsCom(null);
  skillsDe(perfil: string): SkillControl { return this.skillsCom(perfil); }

  async perfil(nome: string, pedido: PedidoDePerfil): Promise<{ criado: boolean; mudou: string[] }> {
    if (!PERFIL_NOME.test(nome)) throw new HermesError(400, 'perfil inválido');
    const j = await this.call('PUT', `/ergon/v1/perfis/${nome}`, pedido, 60000);
    return { criado: j.criado === true, mudou: Array.isArray(j.mudou) ? j.mudou.map(String) : [] };
  }
  async rotina(id: string, pedido: PedidoDeRotina): Promise<JobDaRotina> {
    if (!/^rtn_[0-9a-f]{32}$/.test(id) || !PERFIL_NOME.test(pedido.perfil)) throw new HermesError(400, 'rotina inválida');
    return parseJobDaRotina(await this.call('PUT', `/ergon/v1/rotinas/${id}`, pedido, 30000));
  }
  async removerRotina(id: string, perfil: string): Promise<boolean> {
    if (!/^rtn_[0-9a-f]{32}$/.test(id) || !PERFIL_NOME.test(perfil)) throw new HermesError(400, 'rotina inválida');
    return (await this.call('DELETE', `/ergon/v1/rotinas/${id}?perfil=${perfil}`, undefined, 30000)).removida === true;
  }
  async rodarRotina(id: string, perfil: string): Promise<JobDaRotina> {
    if (!/^rtn_[0-9a-f]{32}$/.test(id) || !PERFIL_NOME.test(perfil)) throw new HermesError(400, 'rotina inválida');
    return parseJobDaRotina(await this.call('POST', `/ergon/v1/rotinas/${id}/rodar`, { perfil }, 30000));
  }
  async rotinasDoPerfil(perfil: string): Promise<JobDaRotina[]> {
    if (!PERFIL_NOME.test(perfil)) throw new HermesError(400, 'perfil inválido');
    const j = await this.call('GET', `/ergon/v1/rotinas?perfil=${perfil}`, undefined, 30000);
    return (Array.isArray(j.rotinas) ? j.rotinas : []).slice(0, 500).map(parseJobDaRotina);
  }
  async memoria(perfil: string): Promise<MemoriaDoAgente> {
    if (!PERFIL_NOME.test(perfil)) throw new HermesError(400, 'perfil inválido');
    return parseMemoria(await this.call('GET', `/ergon/v1/perfis/${perfil}/memoria`, undefined, 15000));
  }
  async decidirMemoria(perfil: string, id: string, aprovar: boolean): Promise<void> {
    if (!PERFIL_NOME.test(perfil)) throw new HermesError(400, 'perfil inválido');
    await this.call('POST', `/ergon/v1/perfis/${perfil}/memoria/pendentes`, { id, aprovar }, 30000);
  }

  async medicao(sessao: string, desdeMs: number): Promise<MedicaoSessao> {
    const q = new URLSearchParams({ sessao, desde: String(Math.max(0, desdeMs) / 1000) });
    return parseMedicao(await this.call('GET', `/ergon/v1/medicao?${q}`, undefined, 10000));
  }
  async passos(): Promise<number | null> {
    const j = await this.call('GET', '/ergon/v1/passos', undefined, 10000);
    return Number.isInteger(j.max_turns) ? j.max_turns : null;
  }
  async setPassos(n: number): Promise<number> {
    const j = await this.call('PUT', '/ergon/v1/passos', { max_turns: n }, 15000);
    return Number.isInteger(j.max_turns) ? j.max_turns : n;
  }
  // motor com o plugin anterior (sem a capacidade compactacao): a rota não existe e ele responde 404 — isso é "não se
  // sabe" (null), não erro: a tela diz que a escolha ainda não chegou e o passo de fundo não insiste como se fosse falha
  async compactacao(): Promise<boolean | null> {
    try {
      const j = await this.call('GET', '/ergon/v1/compactacao', undefined, 10000);
      return typeof j.ligada === 'boolean' ? j.ligada : null;
    } catch (e) { if (e instanceof HermesError && e.status === 404) return null; throw e; }
  }
  async setCompactacao(ligada: boolean): Promise<boolean | null> {
    try {
      const j = await this.call('PUT', '/ergon/v1/compactacao', { ligada }, 15000);
      return typeof j.ligada === 'boolean' ? j.ligada : ligada;
    } catch (e) { if (e instanceof HermesError && e.status === 404) return null; throw e; }
  }

  // Modelos por tarefa. Motor com o plugin anterior (sem a capacidade modelos_tarefa): as rotas de leitura não estão
  // liberadas e a ponte responde 404 — isso é "este motor ainda não sabe" (null), não erro. Gravar o modelo de uma tarefa
  // usa a rota /api/model/set, que o plugin anterior aceitava só para o principal (e gravaria por cima dele): quem chama
  // confere antes que a leitura (auxModels) respondeu.
  private async ou404<T>(f: () => Promise<T>): Promise<T | null> {
    try { return await f(); } catch (e) { if (e instanceof HermesError && e.status === 404) return null; throw e; }
  }
  async auxModels(perfil?: string | null): Promise<AuxModels | null> {
    return this.ou404(async () => parseAuxModels(await this.call('GET', rotaDoPerfil(perfil, '/api/model/auxiliary'), undefined, 15000)));
  }
  async setAuxModel(task: string, provider: string | null, model: string | null, confirm: boolean, perfil?: string | null) {
    const usarPrincipal = !provider || !model;
    const j = await this.call('POST', rotaDoPerfil(perfil, '/api/model/set'), {
      scope: 'auxiliary', task, provider: usarPrincipal ? 'auto' : provider, model: usarPrincipal ? '' : model, confirm_expensive_model: confirm,
    });
    if (j.confirm_required) return { ok: false, confirmMessage: friendly(String(j.confirm_message ?? 'modelo caro: confirme')) };
    return { ok: j.ok !== false, confirmMessage: null };
  }
  async delegacao(perfil?: string | null): Promise<{ provider: string | null; model: string | null } | null> {
    return this.ou404(async () => {
      const j = await this.call('GET', rotaDoPerfil(perfil, '/ergon/v1/delegacao'), undefined, 15000);
      const p = pick(j, 'provider'); const m = pick(j, 'model');
      return p && m ? { provider: p, model: m } : { provider: null, model: null };
    });
  }
  async setDelegacao(provider: string | null, model: string | null, perfil?: string | null): Promise<boolean | null> {
    const fixo = !!provider && !!model;
    return this.ou404(async () => (await this.call('PUT', rotaDoPerfil(perfil, '/ergon/v1/delegacao'), { provider: fixo ? provider : '', model: fixo ? model : '' }, 15000)).ok !== false);
  }
  async modelosVisao(modelos: Array<{ provider: string; model: string }>): Promise<Array<boolean | null> | null> {
    return this.ou404(async () => {
      const j = await this.call('POST', '/ergon/v1/modelos/visao', { modelos: modelos.slice(0, 40) }, 15000);
      const v = Array.isArray(j.visao) ? j.visao : [];
      return modelos.map((_, i) => (typeof v[i] === 'boolean' ? v[i] : null));
    });
  }

  // rc.27: rotas novas da ponte; num motor de antes (plugin sem a capacidade) a rota responde 404 = "não se sabe" (null)
  private async ouNull<T>(f: () => Promise<T>): Promise<T | null> {
    try { return await f(); } catch (e) { if (e instanceof HermesError && e.status === 404) return null; throw e; }
  }
  async ajustes(): Promise<AjustesMotor | null> { return this.ouNull(async () => parseAjustes(await this.call('GET', '/ergon/v1/ajustes', undefined, 10000))); }
  async setAjustes(p: AjustesPatch): Promise<AjustesMotor | null> {
    const body = { ...(p.reserva ? { reserva: p.reserva } : {}), ...(p.naoTreinar !== undefined ? { nao_treinar: p.naoTreinar } : {}),
      ...(p.buscaPrivada !== undefined ? { busca_privada: p.buscaPrivada } : {}), ...(p.arrumarCompetencias !== undefined ? { arrumar_competencias: p.arrumarCompetencias } : {}),
      ...(p.anotarMemoria !== undefined ? { anotar_memoria: p.anotarMemoria } : {}), ...(p.raciocinio ? { raciocinio: p.raciocinio === 'modelo' ? '' : p.raciocinio } : {}),
      ...(p.idioma ? { idioma: p.idioma } : {}) };
    return this.ouNull(async () => parseAjustes(await this.call('PUT', '/ergon/v1/ajustes', body, 20000)));
  }
  async cota(atualizar = false): Promise<CotaConta[] | null> { return this.ouNull(async () => parseCota(await this.call('GET', `/ergon/v1/cota${atualizar ? '?atualizar=1' : ''}`, undefined, 40000))); }
  async pausa(): Promise<boolean | null> { return this.ouNull(async () => { const j = await this.call('GET', '/ergon/v1/pausa', undefined, 8000); return typeof j.pausada === 'boolean' ? j.pausada : null; }); }
  async setPausa(pausada: boolean): Promise<boolean | null> { return this.ouNull(async () => { const j = await this.call('PUT', '/ergon/v1/pausa', { pausada }, 10000); return typeof j.pausada === 'boolean' ? j.pausada : null; }); }

  async chavesGuardadas(): Promise<ChavesGuardadas> {
    const j = await this.call('GET', '/ergon/v1/chaves', undefined, 10000);
    const lista = Array.isArray(j.chaves) ? j.chaves : [];
    return { sudo: j.sudo === true, chaves: lista.filter((c: any) => c && /^[A-Z][A-Z0-9_]{2,60}$/.test(String(c.nome)))
      .map((c: any) => ({ nome: String(c.nome), motivo: String(c.motivo ?? '').slice(0, 300), quando: String(c.quando ?? '').slice(0, 40), agente: String(c.agente ?? '').slice(0, 60) })) };
  }
  async guardarChave(c: { nome: string; valor: string; motivo?: string; agente?: string; sudo?: boolean }): Promise<void> {
    await this.call('PUT', '/ergon/v1/chaves', c.sudo ? { sudo: true, valor: c.valor } : { nome: c.nome, valor: c.valor, motivo: c.motivo ?? '', agente: c.agente ?? '' }, 15000);
  }
  async apagarChave(nome: string): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(nome)) throw new HermesError(400, 'nome de chave inválido');
    return (await this.call('DELETE', `/ergon/v1/chaves/${nome}`, undefined, 15000)).apagada === true;
  }
  async julgarMeta(meta: string, resposta: string): Promise<VereditoMeta> {
    const j = await this.call('POST', '/ergon/v1/meta/julgar', { meta: meta.slice(0, 4000), resposta: resposta.slice(0, 60000) }, 120000);
    const v = String(j.veredito ?? 'continue');
    return { veredito: (['done', 'continue', 'blocked', 'wait', 'skipped'].includes(v) ? v : 'continue') as VereditoMeta['veredito'],
      motivo: String(j.motivo ?? '').slice(0, 600), continuar: String(j.continuar ?? '').slice(0, 6000), semJuiz: j.sem_juiz === true };
  }
  async pedidoRevisao(mensagens: Array<{ role: 'user' | 'assistant'; text: string }>, foco: string): Promise<{ titulo: string; pedido: string }> {
    const j = await this.call('POST', '/ergon/v1/revisao/pedido', { mensagens: mensagens.slice(-10).map((m) => ({ role: m.role, text: m.text.slice(0, 12000) })), foco: foco.slice(0, 2000) }, 30000);
    return { titulo: String(j.titulo ?? '').slice(0, 200), pedido: String(j.pedido ?? '') };
  }

  /** Rotas dos canais: a recusa vem com um código (formato do código do bot, código de pareamento, tentativas). */
  private async canal(method: string, path: string, body?: unknown): Promise<any> {
    try { return await this.call(method, path, body, 30000); } catch (e) {
      if (!(e instanceof HermesError)) throw e;
      if (e.status === 400 && /formato/.test(e.message)) throw new CanalErro('formato', 'Esse não parece o código do bot. Copie de novo, inteiro.');
      if (e.status === 400 || e.status === 404) throw new CanalErro('codigo', 'Código não encontrado ou vencido. Mande uma mensagem nova ao bot para receber outro.');
      if (e.status === 429) throw new CanalErro('tentativas', 'Muitas tentativas com código errado. Espere uma hora e tente de novo.');
      throw new CanalErro('motor', 'A equipe não respondeu agora. Tente de novo em instantes.');
    }
  }
  async canais(): Promise<Record<NomeCanal, CanalNoMotor>> {
    const j = await this.canal('GET', '/ergon/v1/canais');
    const um = (x: any): CanalNoMotor => ({
      configurado: x?.configurado === true, estado: typeof x?.estado === 'string' ? x.estado : null, erro: typeof x?.erro === 'string' ? x.erro : null,
      ligados: Array.isArray(x?.ligados) ? x.ligados.map((l: any) => ({ user_id: String(l?.user_id ?? ''), user_name: String(l?.user_name ?? '') })) : [],
    });
    return { telegram: um(j?.canais?.telegram), discord: um(j?.canais?.discord) };
  }
  async setCanal(canal: NomeCanal, token: string) { await this.canal('PUT', `/ergon/v1/canais/${canal}`, { token }); }
  async parearCanal(canal: NomeCanal, codigo: string) {
    const j = await this.canal('POST', `/ergon/v1/canais/${canal}/parear`, { codigo });
    return { userId: String(j.user_id ?? ''), userName: String(j.user_name ?? ''), chatId: String(j.chat_id ?? j.user_id ?? '') };
  }
  async removerCanal(canal: NomeCanal) { await this.canal('DELETE', `/ergon/v1/canais/${canal}`); }

  async media(path: string): Promise<{ data: Buffer; mime: string }> {
    if (!this.token) throw new HermesError(503, 'a configuração da equipe de IA não está disponível nesta instalação');
    let res: Response;
    try {
      res = await fetchPonte(`${this.baseUrl}/ergon/v1/media?path=${encodeURIComponent(path)}`, { headers: { 'X-Ergon-Bridge-Token': this.token }, signal: AbortSignal.timeout(20000) });
    } catch { throw new HermesError(503, 'a equipe de IA não entregou a imagem a tempo'); }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(mime)) throw new HermesError(res.ok ? 502 : res.status, 'a equipe de IA não encontrou a imagem gerada');
    return { data: Buffer.from(await res.arrayBuffer()), mime };
  }
}
