/**
 * Configuração de IA: a face do Ergon para o motor que roda por baixo (o usuário nunca precisa saber o nome).
 * Contas (Nous Portal, assinatura do ChatGPT) conectadas por código, modelo padrão, catálogo de modelos com o
 * preço publicado, skills da biblioteca e ferramentas ligadas para os agentes. Tudo que vem do motor passa
 * por aqui, com cache curto e erros em português.
 */
import type { Config } from '../config.ts';
import { HttpError } from '../lib/util.ts';
import { TOOLS, platformToolsets, setPlatformToolsets, toolStatus, type ToolDef } from './characters.ts';
import type { HermesClient, HermesControlClient, LoginPoll, LoginStart, ModelOptions, SkillInfo } from './hermes.ts';

export type Billing = 'subscription' | 'credits' | 'api' | 'none';
export interface AccountDef { id: string; name: string; billing: Billing; about: string; site: string }

/** Contas que o usuário conecta pelo Ergon (login por código, no navegador dele). */
export const ACCOUNTS: AccountDef[] = [
  { id: 'nous', name: 'Nous Portal', billing: 'credits', site: 'https://portal.nousresearch.com',
    about: 'A melhor escolha para o Ergon: uma assinatura com os principais modelos do mercado (Claude, GPT, Gemini, DeepSeek…), plano grátis com modelos gratuitos e um modelo por agente — o mais forte para quem pensa, o mais econômico para quem organiza. O consumo sai dos créditos da assinatura.' },
  { id: 'openai-codex', name: 'ChatGPT (assinatura)', billing: 'subscription', site: 'https://chatgpt.com',
    about: 'Usa a assinatura do ChatGPT que você já paga (Plus, Pro ou Business): sem custo por token, valem a mensalidade e os limites do plano.' },
];
const billingOf = (provider: string | null | undefined): Billing =>
  !provider ? 'none' : ACCOUNTS.find((a) => a.id === provider)?.billing ?? 'api';

const VENDORS: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', 'x-ai': 'xAI', deepseek: 'DeepSeek', qwen: 'Qwen', moonshotai: 'Moonshot',
  minimax: 'MiniMax', 'z-ai': 'Z.ai', xiaomi: 'Xiaomi', tencent: 'Tencent', stepfun: 'StepFun', nvidia: 'NVIDIA', meta: 'Meta',
  mistralai: 'Mistral', upstage: 'Upstage', sakana: 'Sakana', inception: 'Inception', poolside: 'Poolside', meituan: 'Meituan',
  reflection: 'Reflection', ornith: 'Ornith', stealth: 'Experimental',
};

/** "anthropic/claude-sonnet-5.5" → "Claude Sonnet 5.5"; "openai/gpt-6-luna:free" → "GPT 6 Luna (grátis)". */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'modelo padrão';
  const [base, tag] = id.split(':');
  const name = (base.includes('/') ? base.split('/').slice(1).join('/') : base)
    .split(/[-_]/).filter(Boolean)
    .map((w) => (/^(gpt|glm|kimi|hy\d*|mimo)$/i.test(w) ? w.toUpperCase() : /^v?\d/.test(w) ? w.toUpperCase().replace(/^V(?=\d)/, 'V') : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
  const suffix = tag === 'free' ? ' (grátis)' : tag === 'US' ? ' (servidores nos EUA)' : tag ? ` (${tag})` : '';
  return name + suffix;
}
export const vendorOf = (id: string): string => VENDORS[id.split('/')[0]] ?? (id.includes('/') ? id.split('/')[0] : '');

const price = (s: string | undefined): number | null => { const n = s ? Number(String(s).replace(/[^0-9.]/g, '')) : NaN; return Number.isFinite(n) ? n : null; };
/** Faixa pelo preço publicado de entrada (US$ por milhão de tokens): orienta a escolha, não é estimativa de gasto. */
export function tierOf(inputPerM: number | null, free: boolean): 'grátis' | 'econômico' | 'intermediário' | 'ponta' | null {
  if (free) return 'grátis';
  if (inputPerM === null) return null;
  return inputPerM <= 0.5 ? 'econômico' : inputPerM <= 3 ? 'intermediário' : 'ponta';
}

export interface ModelEntry { id: string; label: string; vendor: string; input: number | null; output: number | null; tier: ReturnType<typeof tierOf> }
export interface ModelCatalog {
  default: { provider: string | null; model: string | null; label: string };
  providers: Array<{ id: string; name: string; billing: Billing; models: ModelEntry[] }>;
}
export interface AiStatus {
  executor: 'real' | 'simulated';
  /** a ponte de controle responde (contas, modelo padrão, skills) */
  available: boolean;
  accounts: Array<AccountDef & { connected: boolean; detail: string }>;
  default: { provider: string | null; model: string | null; label: string; billing: Billing };
}

export class AiService {
  private readonly cfg: Config;
  private readonly hermes: HermesClient | null;
  private readonly control: HermesControlClient | null;
  private models: { at: number; data: ModelOptions } | null = null;
  private skillsCache: { at: number; data: SkillInfo[] } | null = null;
  private def: { at: number; provider: string | null; model: string | null } | null = null;
  /** sessões de login abertas por este servidor (o código só é mostrado a quem pediu) */
  private logins = new Map<string, { provider: string; workspaceId: string; at: number }>();
  /** de qual motor é (um motor por pessoa: a pessoa; um motor só: "_") */
  readonly scope: string;

  constructor(cfg: Config, hermes: HermesClient | null, control: HermesControlClient | null, scope = '_') {
    this.cfg = cfg; this.hermes = hermes; this.control = control; this.scope = scope;
  }

  private need(): HermesControlClient {
    if (!this.control) throw new HttpError(503, 'ai_unavailable', 'Configuração de IA indisponível: o motor de IA não está ligado nesta instalação.');
    return this.control;
  }

  /** Lê, em segundo plano, quais ferramentas de IA estão ligadas para os agentes. */
  async refreshToolsets(): Promise<void> {
    if (!this.hermes?.toolsets) return;
    try { setPlatformToolsets((await this.hermes.toolsets()).filter((t) => t.enabled).map((t) => t.name), this.scope); } catch { /* fica o último estado lido */ }
  }

  /** Modelo padrão da conta (cache de 60 s; usado também para saber se há custo por uso). */
  async defaultModel(force = false): Promise<{ provider: string | null; model: string | null }> {
    if (!force && this.def && Date.now() - this.def.at < 60_000) return this.def;
    let v: { provider: string | null; model: string | null } = { provider: null, model: null };
    try {
      if (this.control) v = await this.control.modelInfo();
      else if (this.hermes?.modelOptions) { const o = await this.modelOptions(); v = { provider: o.provider, model: o.model }; }
    } catch { if (this.def) return this.def; }
    this.def = { at: Date.now(), ...v };
    return v;
  }

  billing(): Billing { return billingOf(this.def?.provider); }
  /** último modelo padrão lido (sem rede): o executor registra em cada execução sem modelo próprio */
  cachedDefault(): string | null { return this.def?.model ?? null; }

  async status(): Promise<AiStatus> {
    const executor = this.cfg.executor === 'hermes' ? 'real' as const : 'simulated' as const;
    const available = this.control ? await this.control.health() : false;
    let accounts = ACCOUNTS.map((a) => ({ ...a, connected: false, detail: available ? 'não conectada' : 'indisponível nesta instalação' }));
    if (available) {
      try {
        const st = await this.control!.accounts();
        accounts = ACCOUNTS.map((a) => {
          const s = st.find((x) => x.id === a.id);
          const detail = !s?.connected ? 'não conectada' : s.freeTier ? 'conectada (plano gratuito)' : s.tier ? `conectada (plano ${s.tier})` : 'conectada';
          return { ...a, connected: !!s?.connected, detail };
        });
      } catch { /* mantém "não conectada" */ }
    }
    const d = await this.defaultModel(true);
    return { executor, available, accounts, default: { ...d, label: modelLabel(d.model), billing: billingOf(d.provider) } };
  }

  private async modelOptions(refresh = false): Promise<ModelOptions> {
    if (!refresh && this.models && Date.now() - this.models.at < 5 * 60_000) return this.models.data;
    if (!this.hermes?.modelOptions) throw new HttpError(503, 'ai_unavailable', 'Catálogo de modelos indisponível: o motor de IA não está ligado.');
    try {
      const data = await this.hermes.modelOptions(refresh);
      this.models = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (this.models) return this.models.data;
      throw new HttpError(503, 'ai_unavailable', `Catálogo de modelos indisponível: ${err instanceof Error ? err.message : 'falha'}`);
    }
  }

  /** Modelos das contas conectadas, com o preço publicado por milhão de tokens. */
  async catalog(refresh = false): Promise<ModelCatalog> {
    const o = await this.modelOptions(refresh);
    const providers = o.providers.filter((p) => p.authenticated && p.models.length).map((p) => ({
      id: p.slug, name: ACCOUNTS.find((a) => a.id === p.slug)?.name ?? p.name, billing: billingOf(p.slug),
      models: p.models.map((m) => {
        const pr = p.pricing[m] ?? {};
        const input = price(pr.input); const output = price(pr.output);
        const free = pr.free === true || m.endsWith(':free');
        return { id: m, label: modelLabel(m), vendor: vendorOf(m), input, output, tier: tierOf(input, free) };
      }),
    }));
    return { default: { provider: o.provider, model: o.model, label: modelLabel(o.model) }, providers };
  }

  /** Confere se um modelo existe numa conta conectada (antes de gravar no agente). */
  async assertModel(provider: string, model: string): Promise<void> {
    const c = await this.catalog();
    const p = c.providers.find((x) => x.id === provider);
    if (!p) throw new HttpError(400, 'provider', 'essa conta não está conectada');
    if (!p.models.some((m) => m.id === model)) throw new HttpError(400, 'model', 'modelo não encontrado nessa conta');
  }

  async setDefault(provider: string, model: string, confirm: boolean): Promise<{ ok: boolean; confirmMessage: string | null }> {
    await this.assertModel(provider, model);
    const r = await this.need().setDefaultModel(provider, model, confirm);
    if (r.ok) { this.def = null; this.models = null; await this.defaultModel(true); }
    return r;
  }

  async skills(): Promise<SkillInfo[]> {
    if (this.skillsCache && Date.now() - this.skillsCache.at < 10 * 60_000) return this.skillsCache.data;
    if (!this.control) return [];
    try {
      const data = (await this.control.skills()).filter((s) => s.enabled);
      this.skillsCache = { at: Date.now(), data };
      return data;
    } catch { return this.skillsCache?.data ?? []; }
  }

  /** Catálogo de ferramentas com o estado real (ligada para os agentes ou não). */
  tools(ctx: { channels?: boolean } = {}): Array<ToolDef & { platform: boolean }> {
    const on = new Set(platformToolsets(this.scope).enabled);
    return Object.values(TOOLS).map((t) => ({ ...toolStatus(t, { ...ctx, scope: this.scope }), platform: t.kind === 'ia' ? on.has(t.toolset ?? '') : true }));
  }

  /** Liga/desliga ferramentas de IA para os agentes (seguras, e as que executam código só depois da senha). */
  async setPlatformTools(toolIds: string[]): Promise<string[]> {
    const toolsets = [...new Set(toolIds.map((t) => TOOLS[t]).filter((t) => t?.kind === 'ia' && (t.safe || t.guarded) && t.toolset).map((t) => t!.toolset!))];
    const enabled = await this.need().setApiToolsets(toolsets);
    setPlatformToolsets(enabled, this.scope);
    return enabled;
  }

  // ---------------- login das contas (código no navegador do usuário) ----------------
  async startLogin(workspaceId: string, provider: string): Promise<LoginStart & { provider: string }> {
    if (!ACCOUNTS.some((a) => a.id === provider)) throw new HttpError(400, 'provider', 'conta desconhecida');
    const r = await this.need().startLogin(provider);
    if (!r.sessionId || !r.userCode || !r.verificationUrl) throw new HttpError(502, 'login', 'o provedor não devolveu o código de acesso; tente de novo');
    if (!/^https:\/\//.test(r.verificationUrl)) throw new HttpError(502, 'login', 'endereço de login inesperado');
    for (const [k, v] of this.logins) if (Date.now() - v.at > 20 * 60_000) this.logins.delete(k);
    this.logins.set(r.sessionId, { provider, workspaceId, at: Date.now() });
    return { ...r, provider };
  }

  private session(workspaceId: string, sessionId: string): { provider: string } {
    const s = this.logins.get(sessionId);
    if (!s || s.workspaceId !== workspaceId) throw new HttpError(404, 'login', 'sessão de login não encontrada ou expirada');
    return s;
  }

  async pollLogin(workspaceId: string, sessionId: string): Promise<LoginPoll & { starterModel?: string | null }> {
    const s = this.session(workspaceId, sessionId);
    const r = await this.need().pollLogin(s.provider, sessionId);
    if (r.status !== 'pending') {
      this.logins.delete(sessionId);
      if (r.status === 'approved') {
        this.models = null; this.def = null; this.skillsCache = null;
        return { ...r, starterModel: await this.starterModel(s.provider).catch(() => null) };
      }
    }
    return r;
  }

  /**
   * Modelo para começar: logo depois de conectar uma conta, se ainda não há modelo padrão, escolhe um dessa conta para
   * a equipe não ficar "sem modelo". No plano gratuito, um modelo grátis; senão, na ordem: intermediário, econômico,
   * grátis, sem preço publicado (assinatura). Nunca um "de ponta" (pede confirmação de custo). Troca em Configurações.
   */
  private async starterModel(provider: string): Promise<string | null> {
    if ((await this.defaultModel(true)).model) return null;
    const p = (await this.catalog(true)).providers.find((x) => x.id === provider);
    if (!p?.models.length) return null;
    const gratuito = (await this.need().accounts().catch(() => [])).find((a) => a.id === provider)?.freeTier === true;
    const ordem: Array<ModelEntry['tier']> = gratuito ? ['grátis'] : ['intermediário', 'econômico', 'grátis', null];
    const m = ordem.map((t) => p.models.find((x) => x.tier === t)).find(Boolean);
    if (!m) return null;
    const r = await this.need().setDefaultModel(provider, m.id, false);
    if (!r.ok) return null;
    this.def = null; this.models = null;
    await this.defaultModel(true);
    return m.label;
  }

  async cancelLogin(workspaceId: string, sessionId: string): Promise<void> {
    this.session(workspaceId, sessionId);
    this.logins.delete(sessionId);
    await this.need().cancelLogin(sessionId).catch(() => {});
  }

  async disconnect(provider: string): Promise<void> {
    if (!ACCOUNTS.some((a) => a.id === provider)) throw new HttpError(400, 'provider', 'conta desconhecida');
    await this.need().disconnect(provider);
    this.models = null; this.def = null;
  }
}
