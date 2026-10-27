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
}

export interface HermesClient {
  health(): Promise<{ ok: boolean; detail: string }>;
  startRun(p: StartRun): Promise<{ runId: string; replayed: boolean }>;
  getRun(runId: string): Promise<RemoteRun>;
  stop(runId: string): Promise<{ accepted: boolean; detail: string }>;
  toolsets?(): Promise<Toolset[]>;
  modelOptions?(refresh?: boolean): Promise<ModelOptions>;
}

export class HermesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
    if (!this.key) throw new HermesError(503, 'motor de IA sem chave configurada (ERGON_HERMES_API_KEY)');
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HermesError(503, 'o motor de IA não respondeu');
    }
    let json: Record<string, unknown> = {};
    try {
      const t = await res.text();
      json = t ? (JSON.parse(t) as Record<string, unknown>) : {};
    } catch { json = {}; }
    if (!res.ok) {
      const err = json.error as Record<string, unknown> | string | undefined;
      const msg = (typeof err === 'object' && err ? String(err.message ?? '') : String(err ?? '')) || `Hermes respondeu ${res.status}`;
      throw new HermesError(res.status, friendly(msg).slice(0, 300));
    }
    return { status: res.status, json, headers: res.headers };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(this.baseUrl + '/health', { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, detail: `respondeu ${res.status}` };
      return { ok: true, detail: 'motor de IA respondeu' };
    } catch {
      return { ok: false, detail: 'motor de IA inacessível' };
    }
  }

  async startRun(p: StartRun) {
    const body: Record<string, unknown> = { input: p.input, instructions: p.instructions };
    if (p.model) body.model = p.model;
    if (p.model && p.provider) body.provider = p.provider;
    const r = await this.call('POST', '/v1/runs', body, {
      'Idempotency-Key': p.idempotencyKey,
      'X-Hermes-Session-Key': p.sessionKey,
    });
    const runId = r.json.run_id;
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new HermesError(502, 'o motor de IA não devolveu uma execução válida');
    return { runId, replayed: r.headers.get('idempotency-replayed') === 'true' || r.json.replayed === true };
  }

  async getRun(runId: string): Promise<RemoteRun> {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    const { json } = await this.call('GET', `/v1/runs/${runId}`);
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
    };
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

  async stop(runId: string) {
    if (!RUN_ID.test(runId)) throw new HermesError(400, 'execução inválida');
    const { json } = await this.call('POST', `/v1/runs/${runId}/stop`, {});
    return { accepted: true, detail: String(json.status ?? 'stopping') };
  }
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

/** Mensagens de erro do motor, sem o nome dele (o usuário não precisa saber o que roda por baixo). */
export function friendly(msg: string): string {
  return msg.replace(/run `hermes [^`]+`/gi, 'conecte a conta em Conexões').replace(/\bHermes( Agent)?\b/gi, 'motor de IA');
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

export interface HermesControlClient {
  health(): Promise<boolean>;
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
  /** Treinar: as operações de competência (skill) que o Ergon faz pela ponte; ausente = motor sem suporte */
  skills_?: SkillControl;
  /** Endpoint próprio "ergon-ai" do motor (módulo opcional; sem uso na Community) */
  ergonAi?(c: { baseUrl: string; apiKey: string; models: string[]; makeDefault: boolean }): Promise<void>;
  removeErgonAi?(): Promise<void>;
}

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
 * Cliente da ponte de controle (rede interna do Docker, token da ponte). O plugin só deixa passar uma lista
 * fechada de rotas do painel interno do Hermes; aqui ficam os formatos que o Ergon usa.
 */
export class HttpHermesControl implements HermesControlClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  constructor(baseUrl: string, token: string | null) { this.baseUrl = baseUrl.replace(/\/+$/, ''); this.token = token; }

  private async call(method: string, path: string, body?: unknown, timeoutMs = 25000): Promise<any> {
    if (!this.token) throw new HermesError(503, 'ponte de controle sem token (ERGON_BRIDGE_TOKEN)');
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Ergon-Bridge-Token': this.token },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new HermesError(503, 'o motor de IA não respondeu (configuração)'); }
    const text = await res.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      const d = json?.detail ?? json?.error ?? `erro ${res.status}`;
      throw new HermesError(res.status, friendly(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300));
    }
    return json;
  }

  async health() { try { const j = await this.call('GET', '/ergon/v1/health', undefined, 5000); return j.ok === true && j.dashboard === true; } catch { return false; } }

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
  readonly skills_: SkillControl = {
    learnPrompt: async (request) => String((await this.call('POST', '/ergon/v1/learn-prompt', { request })).prompt ?? ''),
    pending: async (ids, name) => ((await this.call('POST', '/ergon/v1/skills/pending', { ids, ...(name ? { name } : {}) })).records ?? []) as PendingSkillWrite[],
    apply: async (ids, name) => ((await this.call('POST', '/ergon/v1/skills/apply', { ids, name }, 120000)).files ?? {}) as Record<string, string>,
    discard: async (ids) => { await this.call('POST', '/ergon/v1/skills/discard', { ids }); },
    files: async (name) => ((await this.call('POST', '/ergon/v1/skills/files', { name })).files ?? {}) as Record<string, string>,
    restore: async (name, files) => ((await this.call('POST', '/ergon/v1/skills/restore', { name, files }, 120000)).files ?? {}) as Record<string, string>,
    remove: async (name) => { await this.call('POST', '/ergon/v1/skills/remove', { name }); },
  };

  async media(path: string): Promise<{ data: Buffer; mime: string }> {
    if (!this.token) throw new HermesError(503, 'ponte de controle sem token (ERGON_BRIDGE_TOKEN)');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/ergon/v1/media?path=${encodeURIComponent(path)}`, { headers: { 'X-Ergon-Bridge-Token': this.token }, signal: AbortSignal.timeout(20000) });
    } catch { throw new HermesError(503, 'o motor de IA não respondeu (imagem)'); }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|webp)$/.test(mime)) throw new HermesError(res.ok ? 502 : res.status, 'imagem não encontrada no motor de IA');
    return { data: Buffer.from(await res.arrayBuffer()), mime };
  }
}
