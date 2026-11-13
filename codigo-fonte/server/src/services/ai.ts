/**
 * Configuração de IA: a face do Ergon para o motor que roda por baixo (o usuário nunca precisa saber o nome).
 * Contas (Nous Portal, assinatura do ChatGPT) conectadas por código, modelo padrão, catálogo de modelos com o
 * preço publicado, skills da biblioteca e ferramentas ligadas para os agentes. Tudo que vem do motor passa
 * por aqui, com cache curto e erros em português.
 */
import type { Config } from '../config.ts';
import { HttpError } from '../lib/util.ts';
import { BENEFICIOS_DA_PLATAFORMA, TOOLS, platformToolsets, setPlatformToolsets, toolStatus, type ToolDef } from './characters.ts';
import { PERFIL_RE, type AuxModels, type ByokCatalog, type ByokCustomInput, type HermesClient, type HermesControlClient, type LoginPoll, type LoginStart, type ModelOptions, type SkillInfo } from './hermes.ts';
import { tx } from '../lib/textos.ts';
import type { Db } from '../db/db.ts';
import { sincronizarCompactacao, sincronizarPassos } from './custo.ts';
import { sincronizarAjustes, sincronizarPausa } from './ajustes-motor.ts';
import type { AjustesMotor, CotaConta } from './hermes.ts';

export type Billing = 'subscription' | 'credits' | 'api' | 'none';
export interface AccountDef { id: string; name: string; billing: Billing; about: string; site: string }

/** Contas que o usuário conecta pelo Ergon (login por código, no navegador dele). */
export const ACCOUNTS: AccountDef[] = [
  { id: 'nous', name: 'Nous Portal', billing: 'credits', site: 'https://portal.nousresearch.com',
    about: 'A melhor escolha para o Ergon: uma assinatura com os principais modelos do mercado (Claude, GPT, Gemini, DeepSeek…), plano grátis com modelos gratuitos e um modelo por agente — o mais forte para quem pensa, o mais econômico para quem organiza. O consumo sai dos créditos da assinatura.' },
  { id: 'openai-codex', name: 'ChatGPT (assinatura)', billing: 'subscription', site: 'https://chatgpt.com',
    about: 'Usa a assinatura do ChatGPT que você já paga (Plus, Pro ou Business): sem custo por token, valem a mensalidade e os limites do plano.' },
];
/** conjunto do motor que leva as Conexões (o plugin do Ergon) */
export const CONEXOES = 'ergon_conexoes';

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
  /** chave própria: quais provedores estão ligados (o valor da chave nunca sai do motor) */
  byok: ByokCatalog['providers'];
  /** endpoints próprios (OpenAI-compatível, LM Studio, Ollama) ligados */
  byokCustom: ByokCatalog['custom'];
}

/** A chave da linha dos ajudantes temporários em "Modelos por tarefa" (no motor, delegation.provider/model). */
export const TAREFA_AJUDANTES = 'delegation';
/** As tarefas de apoio que o botão da economia preenche: resumir a conversa, dar nome à conversa e ver imagens. */
export const TAREFAS_ECONOMIA = ['compression', 'title_generation', 'vision'] as const;

/** A conta de onde sai o custo de um modelo. */
export interface ContaDoCusto { id: string; name: string; billing: Billing }
export interface ModeloEscolhido { provider: string; model: string; label: string; tier: ModelEntry['tier']; input: number | null; output: number | null }
export interface TaskModelRow {
  /** a chave da tarefa no motor (vision, compression… e as que os plugins registrarem); 'delegation' = os ajudantes */
  task: string;
  kind: 'apoio' | 'ajudantes';
  /** a escolha gravada; os dois nulos = usa o principal (nos ajudantes: o modelo do agente que pediu a ajuda) */
  provider: string | null; model: string | null;
  /** o modelo que roda de fato nessa tarefa (o escolhido, ou o principal) e a conta de onde sai o custo dele */
  runs: { provider: string | null; model: string | null; label: string; account: ContaDoCusto | null };
  /** tarefa registrada por um complemento: o nome e a explicação que ele declarou */
  declared?: { label: string; hint: string; by: string; follows: string | null };
}
export interface TaskModels {
  /** false = a equipe de IA desta instalação ainda não tem os modelos por tarefa (chega ao atualizar) */
  supported: boolean;
  main: { provider: string | null; model: string | null; label: string; account: ContaDoCusto | null };
  tasks: TaskModelRow[];
}
export interface TaskModelChange { task: string; provider: string | null; model: string | null }
export interface EconomySuggestion {
  /** o modelo econômico escolhido para as tarefas de texto (null = nada a sugerir; ver `reason`) */
  model: (ModeloEscolhido & { account: ContaDoCusto }) | null;
  /** o que muda se aplicar, tarefa por tarefa: de qual modelo e conta para qual */
  changes: Array<{ task: string; from: TaskModelRow['runs']; to: ModeloEscolhido & { account: ContaDoCusto } }>;
  /** tarefas que ficam como estão: 'same' = já usa esse modelo; 'vision' = não se sabe de um modelo econômico que veja imagens */
  kept: Array<{ task: string; reason: 'same' | 'vision' }>;
  /** sem sugestão: 'unsupported' (a equipe de IA ainda não tem o recurso), 'none' (nenhum modelo econômico nas contas),
   *  'main' (o modelo principal já é tão barato quanto o mais econômico) */
  reason: 'unsupported' | 'none' | 'main' | null;
}

/**
 * O primeiro modelo de uma lista pela ordem das faixas de preço (a mesma régua do "modelo para começar"): dentro da
 * faixa, o de menor preço publicado de entrada (empate: o de menor saída). `null` na ordem = sem preço publicado.
 */
export function porFaixa<T extends { tier: ModelEntry['tier']; input: number | null; output: number | null }>(models: T[], ordem: Array<ModelEntry['tier']>, maisBarato = false): T | null {
  for (const faixa of ordem) {
    const dela = models.filter((m) => m.tier === faixa);
    if (!dela.length) continue;
    if (!maisBarato) return dela[0];
    return [...dela].sort((a, b) => (a.input ?? 0) - (b.input ?? 0) || (a.output ?? 0) - (b.output ?? 0))[0];
  }
  return null;
}
/** Para começar (o modelo principal): intermediário > econômico > grátis > sem preço; no plano gratuito, só grátis. */
export const ORDEM_PARA_COMECAR: Array<ModelEntry['tier']> = ['intermediário', 'econômico', 'grátis', null];
/** Para as tarefas de apoio (economia): econômico > grátis > intermediário; nunca o de ponta nem o sem preço publicado. */
export const ORDEM_ECONOMIA: Array<ModelEntry['tier']> = ['econômico', 'grátis', 'intermediário'];
const SO_GRATIS: Array<ModelEntry['tier']> = ['grátis'];

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
    if (!this.control) throw new HttpError(503, 'ai_unavailable', 'Configuração de IA indisponível: a equipe de IA não está ligada nesta instalação.');
    return this.control;
  }

  /** Lê, em segundo plano, quais ferramentas de IA estão ligadas para os agentes (e quais o motor tem, ligadas ou não). */
  async refreshToolsets(): Promise<void> {
    if (!this.hermes?.toolsets) return;
    try {
      const all = await this.hermes.toolsets();
      setPlatformToolsets(all.filter((t) => t.enabled).map((t) => t.name), this.scope, all.map((t) => t.name));
    } catch { /* fica o último estado lido */ }
  }

  /**
   * Benefícios ligados por padrão (regra do dono, 12/11; ausente = ligado), a generalização das Conexões: ao abrir o motor,
   * cada conjunto-benefício da plataforma (BENEFICIOS_DA_PLATAFORMA: as Conexões e os que a imagem da rc.27 traz) que o motor
   * aceita e não está ligado é ligado — a menos que a pessoa o tenha desligado ('ferramentas.<id>' = 'desligado', gravado em
   * Configurações › Ferramentas). E o contrário: o que a pessoa desligou e o motor trouxe ligado de novo (recriado, migração
   * do cofre) volta a ficar desligado. Os que executam código nunca entram aqui. Devolve os conjuntos que mudaram, ou null
   * (sem a ponte de controle).
   */
  async ensureBeneficios(desligadosPelaPessoa: ReadonlySet<string>, ids: readonly string[] = BENEFICIOS_DA_PLATAFORMA): Promise<{ ligou: string[]; desligou: string[] } | null> {
    if (!this.control) return null;
    const cur = await this.control.apiToolsets();
    const conjunto = (id: string) => (TOOLS[id]?.safe ? TOOLS[id].toolset : undefined);
    const tirar = [...desligadosPelaPessoa].map(conjunto).filter((t): t is string => !!t && cur.enabled.includes(t));
    const por = ids.filter((id) => !desligadosPelaPessoa.has(id)).map(conjunto).filter((t): t is string => !!t && cur.safe.includes(t) && !cur.enabled.includes(t));
    if (!tirar.length && !por.length) return { ligou: [], desligou: [] };
    const enabled = await this.control.setApiToolsets([...new Set([...cur.enabled.filter((t) => !tirar.includes(t)), ...por])]);
    setPlatformToolsets(enabled, this.scope);
    return { ligou: por.filter((t) => enabled.includes(t)), desligou: tirar.filter((t) => !enabled.includes(t)) };
  }

  /**
   * Passos por pedido: deixa o motor com o que vale para os workspaces dele (a escolha mais recente; sem escolha, o que
   * ele tem, salvo valor fora do intervalo ou o 20 de antes, que vão a 90). Devolve o valor que o motor ficou, ou null se o motor não tem
   * a ponte dos passos (versão anterior). Erro de rede sobe.
   */
  async sincronizarPassos(db: Db, workspaceIds: string[]): Promise<number | null> {
    return sincronizarPassos(db, this.control, workspaceIds);
  }

  /** Resumir as conversas longas mais cedo: o motor fica com a escolha mais recente dos workspaces dele (sem escolha, com o
   *  que tem). Devolve o que o motor ficou, ou null se ele não tem a ponte da compactação. Erro de rede sobe. */
  async sincronizarCompactacao(db: Db, workspaceIds: string[]): Promise<boolean | null> {
    return sincronizarCompactacao(db, this.control, workspaceIds);
  }

  /**
   * Ajustes da equipe que são configuração do motor (ajustes-motor.ts): modelos reserva, não treinar com os dados, busca
   * privada, arrumar competências sem uso, e o idioma das mensagens do motor. O motor fica com as escolhas mais recentes
   * dos workspaces dele. Devolve como ficou, ou null se o motor não tem a ponte dos ajustes. Erro de rede sobe.
   */
  async sincronizarAjustes(db: Db, workspaceIds: string[], idioma?: 'pt' | 'en'): Promise<AjustesMotor | null> {
    // o catálogo de modelos diz quais contas estão conectadas (a reserva automática sai dele); sem ele, a reserva não é mexida
    const opcoes = await this.modelOptions().catch(() => null);
    return sincronizarAjustes(db, this.control, workspaceIds, { opcoes, idioma });
  }
  /** Pausa da equipe: a parada geral do motor igual à escolha. null = motor sem a ponte da pausa. Erro de rede sobe. */
  async sincronizarPausa(db: Db, workspaceIds: string[]): Promise<boolean | null> {
    return sincronizarPausa(db, this.control, workspaceIds);
  }
  /** Limites e saldo da conta de IA, lidos do provedor pelo motor (guardados 5 min aqui também). null = motor sem a ponte. */
  private cotaCache: { at: number; data: CotaConta[] | null } | null = null;
  async cota(atualizar = false): Promise<CotaConta[] | null> {
    if (!atualizar && this.cotaCache && Date.now() - this.cotaCache.at < 5 * 60_000) return this.cotaCache.data;
    if (!this.control?.cota) return null;
    try {
      const data = await this.control.cota(atualizar);
      this.cotaCache = { at: Date.now(), data };
      return data;
    } catch { return this.cotaCache?.data ?? null; }
  }
  /** as contas conectadas e os modelos de cada uma, para a pessoa montar a lista de modelos reserva */
  async opcoesDeReserva(): Promise<{ principal: { provider: string | null; model: string | null }; contas: Array<{ id: string; name: string; billing: Billing; models: Array<{ id: string; label: string }> }> }> {
    const o = await this.modelOptions().catch(() => null);
    return {
      principal: { provider: o?.provider ?? null, model: o?.model ?? null },
      contas: (o?.providers ?? []).filter((x) => x.authenticated && x.models.length).map((x) => ({
        id: x.slug, name: ACCOUNTS.find((a) => a.id === x.slug)?.name ?? x.name, billing: billingOf(x.slug),
        models: x.models.slice(0, 400).map((m) => ({ id: m, label: modelLabel(m) })) })),
    };
  }
  /** conta do modelo padrão já lida (sem rede) */
  cachedDefaultProvider(): string | null { return this.def?.provider ?? null; }

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
    const cat: ByokCatalog = available && this.control?.byok ? await this.control.byok().catch(() => ({ providers: [], custom: [] })) : { providers: [], custom: [] };
    return { executor, available, accounts, default: { ...d, label: modelLabel(d.model), billing: billingOf(d.provider) },
      byok: cat.providers, byokCustom: cat.custom };
  }

  private async modelOptions(refresh = false): Promise<ModelOptions> {
    if (!refresh && this.models && Date.now() - this.models.at < 5 * 60_000) return this.models.data;
    if (!this.hermes?.modelOptions) throw new HttpError(503, 'ai_unavailable', 'Catálogo de modelos indisponível: a equipe de IA não está ligada.');
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

  // ---------------- modelos por tarefa (tarefas de apoio do motor e ajudantes temporários) ----------------
  /** Chamada ao motor com o erro dele virando mensagem para a pessoa (e não "erro interno"). */
  private async noMotor<T>(f: () => Promise<T>): Promise<T> {
    try { return await f(); } catch (e) {
      if (e instanceof HttpError) throw e;
      const st = (e as { status?: number }).status;
      if (st && st >= 400 && st < 500 && st !== 404) throw new HttpError(400, 'task_model', (e as Error).message);
      throw new HttpError(503, 'ai_unavailable', tx('erro.modeloTarefaNaoGravado'));
    }
  }
  private perfil(perfil: string | null | undefined): string | null {
    if (!perfil) return null;
    if (!PERFIL_RE.test(perfil)) throw new HttpError(400, 'profile', 'perfil inválido');
    return perfil;
  }
  private conta(cat: ModelCatalog | null, provider: string | null): ContaDoCusto | null {
    if (!provider) return null;
    const p = cat?.providers.find((x) => x.id === provider);
    return { id: provider, name: p?.name ?? ACCOUNTS.find((a) => a.id === provider)?.name ?? provider, billing: p?.billing ?? billingOf(provider) };
  }

  /**
   * Modelos por tarefa: TODAS as tarefas de apoio que o motor devolver (as dele e as que os complementos registrarem),
   * cada uma com o modelo escolhido (ou "usa o principal") e a conta de onde sai o custo, mais a linha dos ajudantes
   * temporários. `perfil`: o perfil do agente no motor; sem ele, vale o do motor (hoje, um por pessoa).
   */
  async taskModels(perfil?: string | null): Promise<TaskModels> {
    const pf = this.perfil(perfil);
    const c = this.control;
    const cat = await this.catalog().catch(() => null);
    const semRecurso = async (): Promise<TaskModels> => {
      const d = await this.defaultModel();
      return { supported: false, main: { ...d, label: modelLabel(d.model), account: this.conta(cat, d.provider) }, tasks: [] };
    };
    if (!c?.auxModels) return semRecurso();
    const aux: AuxModels | null = await this.noMotor(() => c.auxModels!(pf));
    if (!aux) return semRecurso();
    const main = { ...aux.main, label: modelLabel(aux.main.model), account: this.conta(cat, aux.main.provider) };
    const roda = (provider: string | null, model: string | null): TaskModelRow['runs'] =>
      (provider && model ? { provider, model, label: modelLabel(model), account: this.conta(cat, provider) } : { provider: main.provider, model: main.model, label: main.label, account: main.account });
    const tasks: TaskModelRow[] = aux.tasks.filter((t) => t.task !== TAREFA_AJUDANTES).map((t) => ({
      task: t.task, kind: 'apoio' as const, provider: t.provider, model: t.model,
      // tarefa de complemento que segue outra e não tem modelo próprio: roda onde a outra roda
      runs: t.provider ? roda(t.provider, t.model) : roda(t.effective?.provider ?? null, t.effective?.model ?? null),
      ...(t.label || t.plugin ? { declared: { label: t.label ?? t.task, hint: t.hint ?? '', by: t.plugin ?? '', follows: t.inheritFrom ?? null } } : {}),
    }));
    const del = c.delegacao ? await c.delegacao(pf).catch(() => null) : null;
    if (del) tasks.push({ task: TAREFA_AJUDANTES, kind: 'ajudantes', provider: del.provider, model: del.model, runs: roda(del.provider, del.model) });
    return { supported: true, main, tasks };
  }

  /**
   * Grava o modelo de uma ou mais tarefas (provider e model nulos = voltar a usar o principal). Para na primeira que
   * pedir confirmação de custo (modelo caro) e devolve a pergunta; as anteriores já ficaram gravadas (`applied`).
   */
  async setTaskModels(changes: TaskModelChange[], confirm: boolean, perfil?: string | null): Promise<{ ok: boolean; confirmMessage: string | null; applied: string[] }> {
    const pf = this.perfil(perfil);
    const c = this.need();
    for (const ch of changes) {
      if (!ch.provider !== !ch.model) throw new HttpError(400, 'model', 'escolha a conta e o modelo, ou nenhum dos dois');
      if (ch.provider && ch.model) await this.assertModel(ch.provider, ch.model);
    }
    // a leitura diz se este motor tem o recurso: o de antes aceitaria a gravação como se fosse o modelo principal
    const aux = c.auxModels && c.setAuxModel ? await this.noMotor(() => c.auxModels!(pf)) : null;
    if (!aux) throw new HttpError(409, 'task_models_unsupported', tx('erro.modelosTarefaNaoChegou'));
    const conhecidas = new Set(aux.tasks.map((t) => t.task));
    for (const ch of changes) {
      if (ch.task !== TAREFA_AJUDANTES && !conhecidas.has(ch.task)) throw new HttpError(400, 'task', tx('erro.tarefaDeApoioDesconhecida'));
    }
    const applied: string[] = [];
    for (const ch of changes) {
      if (ch.task === TAREFA_AJUDANTES) {
        const ok = c.setDelegacao ? await this.noMotor(() => c.setDelegacao!(ch.provider, ch.model, pf)) : null;
        if (!ok) throw new HttpError(409, 'task_models_unsupported', tx('erro.modelosTarefaNaoChegou'));
      } else {
        const r = await this.noMotor(() => c.setAuxModel!(ch.task, ch.provider, ch.model, confirm, pf));
        if (!r.ok) {
          if (r.confirmMessage) return { ok: false, confirmMessage: r.confirmMessage, applied };
          throw new HttpError(503, 'ai_unavailable', tx('erro.modeloTarefaNaoGravado'));
        }
      }
      applied.push(ch.task);
    }
    return { ok: true, confirmMessage: null, applied };
  }

  /**
   * Sugestão de economia: resumir a conversa, dar nome à conversa e ver imagens com o modelo mais barato das contas
   * conectadas (econômico > grátis > intermediário; conta no plano gratuito, só grátis; nunca o de ponta). Ver imagens
   * só recebe um modelo que o motor sabe que enxerga imagens. Só diz o que mudaria: quem aplica é a pessoa.
   */
  async economySuggestion(perfil?: string | null): Promise<EconomySuggestion> {
    const tm = await this.taskModels(perfil);
    if (!tm.supported) return { model: null, changes: [], kept: [], reason: 'unsupported' };
    const cat = await this.catalog();
    const contas = await this.need().accounts().catch(() => []);
    const gratuita = (id: string) => contas.find((a) => a.id === id)?.freeTier === true;
    // os candidatos de cada conta (pela régua dela) e, entre as contas, o mais barato; empate: a conta do principal
    const todos = cat.providers.flatMap((p) => p.models
      .filter((m) => (gratuita(p.id) ? SO_GRATIS : ORDEM_ECONOMIA).includes(m.tier))
      .map((m) => ({ provider: p.id, model: m.id, label: m.label, tier: m.tier, input: m.input, output: m.output, account: { id: p.id, name: p.name, billing: p.billing } })));
    const ordenar = (faixa: ModelEntry['tier']) => todos.filter((m) => m.tier === faixa)
      .sort((a, b) => (a.input ?? 0) - (b.input ?? 0) || (a.output ?? 0) - (b.output ?? 0) || Number(b.provider === tm.main.provider) - Number(a.provider === tm.main.provider));
    const fila = ORDEM_ECONOMIA.flatMap(ordenar);
    const escolhido = fila[0] ?? null;
    if (!escolhido) return { model: null, changes: [], kept: [], reason: 'none' };
    // o principal já é tão barato quanto (mesmo modelo, ou preço publicado menor ou igual): nada a ganhar
    const principal = cat.providers.find((p) => p.id === tm.main.provider)?.models.find((m) => m.id === tm.main.model);
    const precoDe = (m: { tier: ModelEntry['tier']; input: number | null }) => (m.tier === 'grátis' ? 0 : m.input);
    const pPrincipal = principal ? precoDe(principal) : null;
    const pEscolhido = precoDe(escolhido);
    if ((tm.main.provider === escolhido.provider && tm.main.model === escolhido.model) || (pPrincipal !== null && pEscolhido !== null && pPrincipal <= pEscolhido)) {
      return { model: null, changes: [], kept: [], reason: 'main' };
    }
    // ver imagens: o primeiro da fila que o motor sabe que enxerga imagens
    let paraImagens: typeof escolhido | null = null;
    const alvo = tm.tasks.filter((t) => (TAREFAS_ECONOMIA as readonly string[]).includes(t.task));
    if (alvo.some((t) => t.task === 'vision')) {
      const cand = fila.slice(0, 20);
      const ve = this.control?.modelosVisao ? await this.control.modelosVisao(cand.map((m) => ({ provider: m.provider, model: m.model }))).catch(() => null) : null;
      paraImagens = ve ? cand.find((_, i) => ve[i] === true) ?? null : null;
    }
    const changes: EconomySuggestion['changes'] = []; const kept: EconomySuggestion['kept'] = [];
    for (const t of alvo) {
      const to = t.task === 'vision' ? paraImagens : escolhido;
      if (!to) { kept.push({ task: t.task, reason: 'vision' }); continue; }
      if (t.runs.provider === to.provider && t.runs.model === to.model) { kept.push({ task: t.task, reason: 'same' }); continue; }
      changes.push({ task: t.task, from: t.runs, to });
    }
    return { model: escolhido, changes, kept, reason: null };
  }

  /** A biblioteca mudou (instalada da loja, enviada, removida): a próxima leitura vai ao motor. */
  esquecerCompetencias(): void { this.skillsCache = null; }

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
    const m = porFaixa(p.models, gratuito ? SO_GRATIS : ORDEM_PARA_COMECAR);
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

  /** Chave própria: o motor confere a chave no provedor e grava; sem modelo padrão, já escolhe um para começar. */
  async setByok(provider: string, key: string): Promise<{ verified: boolean; starterModel: string | null }> {
    const c = this.need();
    if (!c.setByok) throw new HttpError(503, 'ai_unavailable', 'esta versão da equipe de IA não aceita chave própria');
    const r = await c.setByok(provider, key.trim()).catch((e: unknown) => {
      // recusa do motor/provedor (chave errada, formato): vira mensagem para a pessoa, não "erro interno"
      const st = (e as { status?: number }).status;
      throw st && st < 500 ? new HttpError(400, 'byok', (e as Error).message) : e;
    });
    this.models = null; this.def = null;
    return { ...r, starterModel: await this.starterModel(provider).catch(() => null) };
  }
  async removeByok(provider: string): Promise<void> {
    const c = this.need();
    if (!c.removeByok) throw new HttpError(503, 'ai_unavailable', 'esta versão da equipe de IA não aceita chave própria');
    await c.removeByok(provider);
    this.models = null; this.def = null;
  }

  /** Endpoint próprio (OpenAI-compatível): o motor confere o endereço, lista os modelos e cadastra. */
  async addByokCustom(c0: ByokCustomInput): Promise<{ id: string; models: number; starterModel: string | null }> {
    const c = this.need();
    if (!c.addByokCustom) throw new HttpError(503, 'ai_unavailable', 'esta versão da equipe de IA não aceita endereço próprio');
    const r = await c.addByokCustom(c0).catch((e: unknown) => {
      const st = (e as { status?: number }).status;
      throw st && st < 500 ? new HttpError(400, 'byok', (e as Error).message) : e;
    });
    this.models = null; this.def = null;
    return { ...r, starterModel: await this.starterModel(r.id).catch(() => null) };
  }
  async removeByokCustom(id: string): Promise<void> {
    const c = this.need();
    if (!c.removeByokCustom) throw new HttpError(503, 'ai_unavailable', 'esta versão da equipe de IA não aceita endereço próprio');
    await c.removeByokCustom(id);
    this.models = null; this.def = null;
  }

  async disconnect(provider: string): Promise<void> {
    if (!ACCOUNTS.some((a) => a.id === provider)) throw new HttpError(400, 'provider', 'conta desconhecida');
    await this.need().disconnect(provider);
    this.models = null; this.def = null;
  }
}
