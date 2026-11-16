/**
 * "Rodar na nuvem" (RC30 / 30.5H1) do lado do aplicativo: um cartão na fila ou em espera vai para o Ergon World sem
 * perder progresso e sem dois executores ao mesmo tempo. O contrato é o do World (world/src/handoffs.ts):
 *
 *   1. prepare  → a intenção (chave estável, gravada aqui ANTES de sair: depois de uma queda, a mesma)
 *   2. stage    → o pacote de continuação com o checksum do JSON canônico
 *   3. commit   → CAS na geração do dono local; só com este aceite o cartão deixa de rodar aqui
 *   4. GET      → resposta perdida: consulta a transferência e segue o estado dela (nunca abre outra intenção)
 *
 * Local primeiro: cartão que nunca foi à nuvem não fala com o World (nem para pedir licença). Vão as rotinas de radar
 * (fontes públicas: o adaptador web_feed do World) e os cards do quadro da equipe esperando em "A fazer" (o adaptador
 * hermes_task: o mesmo pedido que o agente receberia aqui, com o modelo dele; a chave própria do provedor vai junto, e
 * sem ela o World roda no Ergon AI e avisa). O protocolo de recuperação do World pode criar rodadas novas de um Job que
 * falhou: o cartão segue a rodada mais recente (`recovery.next`) até o fim. O que o World oferece vem de /v1/compat.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { HttpError, now } from '../lib/util.ts';
import type { Bus } from '../services/bus.ts';
import type { CloudTaskBrief } from '../services/teamwork.ts';
import type { CloudTasksHost } from '../world-hook.ts';
import { setRemoteHolder } from '../services/remote-work.ts';
import type { ParamValues, SourceId } from '../services/routine-catalog.ts';
import { webQueries } from '../services/routine-sources.ts';
import type { Routines } from '../services/routines.ts';
import { sourcesEligibility } from './jobs-eligibility.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import { unwrapForDevice } from './sync-crypto.ts';

/** JSON canônico (chaves ordenadas, sem espaços, chaves sem valor fora): o mesmo do World, para o mesmo sha256. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const packageChecksum = (pkg: unknown): string => `sha256:${crypto.createHash('sha256').update(canonicalJson(pkg)).digest('hex')}`;

/** estados do cartão que podem ir agora (o World recusa os outros) */
export const HANDOFF_STATES = ['queued_local', 'waiting_external', 'waiting_user'] as const;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'rejected'];
export const CARD_REF = /^(rotina:rtn_[a-f0-9]{32}|card:tsk_[a-f0-9]{32})$/;

export type Badge = 'na_fila' | 'trabalhando' | 'concluido' | 'falhou' | 'recuperando';
/** o estado do Job do World → o selo discreto do cartão (rodada de recuperação em andamento: "recuperando") */
export function badgeOf(jobState: string | null, recoveryRound = 0): Badge {
  if (jobState === 'succeeded') return 'concluido';
  if (jobState && ['failed', 'cancelled', 'rejected'].includes(jobState)) return 'falhou';
  if (recoveryRound > 0) return 'recuperando';
  if (jobState === 'running' || jobState === 'cancel_requested') return 'trabalhando';
  return 'na_fila';
}

/** limites do pacote hermes_task (world/src/hermes-task.ts) */
export const TASK_LIMITS = { instructions: 20_000, context: 100_000, systemPrompt: 8_000, profileName: 80 };
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
/** provedores com chave de API que o World aceita por delegação (WORLD_DELEGATED_PROVIDERS, padrão) */
export const DELEGATED = ['openai', 'anthropic', 'deepseek', 'openrouter'];
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * O modelo do agente no formato do World: { provider, id }. Sem modelo nem provedor: null (o World escolhe no Ergon AI).
 * Provedor que o World não reconhece vai com um nome neutro: lá ele cai no Ergon AI e diz por quê.
 */
export function taskModel(provider: string | null | undefined, model: string | null | undefined): { provider: string; id: string } | null {
  if (!provider && !model) return null;
  const p = (provider ?? '').toLowerCase();
  const id = (model ?? '').replace(/[^A-Za-z0-9._:/@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'padrao';
  return { provider: PROVIDER_RE.test(p) ? p : 'local', id: MODEL_RE.test(id) ? id : 'padrao' };
}

/** Pacote do adaptador hermes_task a partir do card: só texto (nada de caminho deste computador), nos limites do World. */
export function taskPackage(b: CloudTaskBrief, fallback: { provider: string | null; model: string | null }): Record<string, unknown> {
  const pkg: Record<string, unknown> = { instructions: cut(b.input ?? '', TASK_LIMITS.instructions) };
  if (b.context) pkg.context = cut(b.context, TASK_LIMITS.context);
  const m = b.model?.provider || b.model?.model ? taskModel(b.model.provider, b.model.model) : taskModel(fallback.provider, fallback.model);
  if (m) pkg.model = m;
  const profile: Record<string, string> = {};
  if (b.agentName?.trim()) profile.name = cut(b.agentName.trim(), TASK_LIMITS.profileName);
  if (b.soul?.trim()) profile.systemPrompt = cut(b.soul.trim(), TASK_LIMITS.systemPrompt);
  if (Object.keys(profile).length) pkg.profile = profile;
  return pkg;
}

/** O motivo da troca para o Ergon AI, curto, para o aviso ("Rodou no Ergon AI: …"). */
export function fallbackReason(fb: unknown): string | null {
  if (!fb || typeof fb !== 'object') return null;
  const r = String((fb as { reason?: unknown }).reason ?? '').trim();
  return cut(r || 'sem o modelo do agente na nuvem', 120);
}

/** O que o World responde, em frases curtas (a dele pode vir em outro idioma). keep: a intenção segue aberta. */
const ERRORS: Record<string, [number, string, boolean?]> = {
  jobs_not_in_plan: [402, 'O plano deste workspace não inclui Jobs na nuvem.'],
  card_owned_elsewhere: [409, 'Este cartão está com outro computador.'],
  already_remote: [409, 'Este cartão já está na nuvem.'],
  checkpoint_required: [409, 'Espere esta etapa terminar.'],
  not_portable: [409, 'Este cartão não pode ir para a nuvem agora.'],
  no_remote_executor: [409, 'Este tipo de trabalho ainda não roda na nuvem.'],
  fenced: [409, 'O cartão mudou no meio do envio. Ficou neste computador.'],
  handoff_expired: [410, 'O envio expirou. Tente de novo.'],
  handoff_open: [409, 'Já há um envio em andamento para este cartão.', true],
  remote_running: [409, 'Ainda rodando na nuvem. Volta quando terminar.', true],
  checksum: [400, 'O pacote chegou diferente. Tente de novo.'],
  rate_limited: [429, 'O Ergon World pediu uma pausa. Tente de novo em instantes.', true],
};
const OFFLINE = 'Sem conexão com o Ergon World. O cartão continua aqui.';

interface Row { workspace_id: string; card_ref: string; user_id: string; status: 'preparing' | 'remote' | 'local'; intent_key: string; handoff_id: string | null; generation: number | null; job_id: string | null; job_state: string | null; result_at: string | null; checked_at: string | null;
  agent_id?: string | null; task_input?: string | null; recovery_round?: number; recovery_log?: string | null; model_fallback?: string | null }
interface HandoffView { handoffId: string; status: string; reason: string | null; jobId: string | null; jobState: string | null; recoveryRound?: number; owner: { holder: string; generation: number } | null }
interface WorldCard { cardRef: string; holder: 'world' | 'this_device' | 'other_device'; generation: number; active: boolean; jobId: string | null; jobState: string | null; recoveryRound?: number }
interface JobView { state: string; reason: string | null; result: string | null; modelFallback?: unknown; recovery?: { round?: number; next?: string | null; log?: Array<{ round: number; reason: string; at?: string }> } | null }
/** uma rodada que falhou (o que o World registrou) */
export interface RoundFailure { round: number; reason: string }
type RoutineView = ReturnType<Routines['get']>;

/** O que o cartão é aqui: em que estado está e se pode ir agora (com o motivo, se não). */
export interface CardWork { ref: string; state: string | null; eligible: boolean; reason: string | null; adapter: string | null; pkg: Record<string, unknown> | null; routineId: string | null; agentId?: string | null }
/**
 * O que a tela mostra do cartão. recovery: a rodada de recuperação (0 = a original) e quantas cabem; history: o que
 * falhou em cada rodada (no fim que falhou); fallback: o motivo curto quando rodou no Ergon AI.
 */
export interface CardView { ref: string; where: 'local' | 'preparing' | 'remote'; badge: Badge | null; jobState: string | null; canSend: boolean; reason: string | null; canClaim: boolean;
  recovery: { round: number; of: number }; history: RoundFailure[]; fallback: string | null }
/** rodadas de recuperação do World (RECOVERY_ROUNDS) */
export const RECOVERY_ROUNDS = 3;
const NO_CLOUD_TASK = 'Este tipo de trabalho ainda não roda na nuvem.';

/** Pacote do adaptador web_feed: as buscas e os feeds que a rotina lê aqui, os mesmos endereços (até 10). */
export function feedPackage(sources: readonly string[], params: ParamValues): { urls: string[] } | null {
  const urls = new Set<string>();
  for (const s of sources) { const w = webQueries(s as SourceId, params); for (const q of [...w.queries, ...w.feeds]) urls.add(q.url); }
  const list = [...urls].slice(0, 10);
  return list.length ? { urls: list } : null;
}

/** Abre o resultado cifrado para este aparelho (X25519; o World guarda sem ler). null = não veio para este aparelho. */
export function openJobResult(jobId: string, sealed: string, deviceId: string, x25519Pkcs8B64: string): unknown {
  const s = JSON.parse(sealed) as { v: number; nonce: string; ct: string; keys: Record<string, string> };
  const wrapped = s.keys?.[deviceId];
  if (!wrapped) return null;
  const key = unwrapForDevice(wrapped, x25519Pkcs8B64, `job:${jobId}`, 1);
  const raw = Buffer.from(s.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.nonce, 'base64'));
  d.setAAD(Buffer.from(`ergon/job-result/v1|${jobId}`)); d.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
}

/** Resultado do web_feed → o texto da rodada (os mesmos códigos N1… das rodadas daqui). */
export function feedResultText(r: unknown): { summary: string; output: string } {
  const x = (r ?? {}) as { items?: Array<{ title?: string; link?: string; source?: string }>; errors?: string[] };
  const items = Array.isArray(x.items) ? x.items.slice(0, 40) : [];
  const lines = items.map((i, n) => `N${n + 1} · ${String(i.title ?? '').slice(0, 200)} · ${String(i.source ?? '').slice(0, 60)}${i.link ? ` · ${String(i.link).slice(0, 500)}` : ''}`);
  const errs = (Array.isArray(x.errors) ? x.errors : []).slice(0, 5).map((e) => `Fonte não lida: ${String(e).slice(0, 120)}`);
  return { summary: items.length ? `Na nuvem: ${items.length} ${items.length === 1 ? 'item' : 'itens'}` : 'Na nuvem: nada novo', output: [...lines, ...errs].join('\n') || 'Nada novo nas fontes.' };
}

export class CloudCards {
  readonly db: Db; readonly client: WorldClient; readonly links: WorldLinks; readonly routines: Routines; readonly bus: Bus;
  /** o workspace World do workspace local ligado (null = não ligado: nada de nuvem) */
  readonly worldId: (ws: string) => string | null;
  /** leitura do World no máximo a cada tanto, por workspace (e só com cartão na nuvem) */
  readonly minMs: number;
  /** cards do quadro (o agente com o modelo da pessoa); ausente: só as rotinas */
  readonly tasks: CloudTasksHost | null;
  private lastAt = new Map<string, number>();
  /** o que o World oferece (/v1/compat), por um tempo; null = ainda não se sabe */
  private compat: { at: number; features: Set<string> } | null = null;

  constructor(d: { db: Db; client: WorldClient; links: WorldLinks; routines: Routines; bus: Bus; worldId: (ws: string) => string | null; minMs?: number; tasks?: CloudTasksHost | null }) {
    this.db = d.db; this.client = d.client; this.links = d.links; this.routines = d.routines; this.bus = d.bus; this.worldId = d.worldId; this.minMs = d.minMs ?? 20_000; this.tasks = d.tasks ?? null;
  }

  /**
   * O que o World oferece (GET /v1/compat, guardado por 10 min). World antigo, sem a rota: nada além das rotinas.
   * Sem rede: o que se soube por último (ou nada).
   */
  async features(): Promise<Set<string>> {
    if (this.compat && Date.now() - this.compat.at < 600_000) return this.compat.features;
    try {
      const c = await this.client.call<{ features?: unknown }>('GET', '/v1/compat');
      const features = new Set(Array.isArray(c.features) ? c.features.filter((x): x is string => typeof x === 'string') : []);
      this.compat = { at: Date.now(), features };
    } catch (e) {
      const st = (e as HttpError).status;
      if (st === 404 || st === 400) this.compat = { at: Date.now(), features: new Set() };
      else return this.compat?.features ?? new Set();
    }
    return this.compat.features;
  }
  /** o recurso está no World (sem a leitura ainda: não) */
  has(feature: string): boolean { return !!this.compat?.features.has(feature); }

  row(ws: string, ref: string): Row | null { return this.db.get<Row>('SELECT * FROM world_cards WHERE workspace_id = ? AND card_ref = ?', ws, ref) ?? null; }
  private save(ws: string, ref: string, userId: string, x: Partial<Omit<Row, 'workspace_id' | 'card_ref' | 'user_id'>> & { status: Row['status']; intent_key: string }): void {
    this.db.run(`INSERT INTO world_cards (workspace_id, card_ref, user_id, status, intent_key, handoff_id, generation, job_id, job_state, result_at, agent_id, task_input, recovery_round, recovery_log, model_fallback, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
      ON CONFLICT (workspace_id, card_ref) DO UPDATE SET user_id = excluded.user_id, status = excluded.status, intent_key = excluded.intent_key, handoff_id = excluded.handoff_id,
        generation = excluded.generation, job_id = excluded.job_id, job_state = excluded.job_state, result_at = excluded.result_at, agent_id = excluded.agent_id, task_input = excluded.task_input,
        recovery_round = 0, recovery_log = NULL, model_fallback = NULL, updated_at = excluded.updated_at`,
    ws, ref, userId, x.status, x.intent_key, x.handoff_id ?? null, x.generation ?? null, x.job_id ?? null, x.job_state ?? null, x.result_at ?? null, x.agent_id ?? null, this.db.seal(ws, x.task_input ?? null), now());
  }
  private patch(ws: string, ref: string, x: Partial<Row>): void {
    const keys = Object.keys(x) as Array<keyof Row>;
    if (!keys.length) return;
    this.db.run(`UPDATE world_cards SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE workspace_id = ? AND card_ref = ?`, ...keys.map((k) => x[k] ?? null), now(), ws, ref);
  }
  private drop(ws: string, ref: string): void { this.db.run('DELETE FROM world_cards WHERE workspace_id = ? AND card_ref = ?', ws, ref); }

  private ctx(userId: string, ws: string) {
    const sws = this.worldId(ws);
    if (!sws) throw new HttpError(409, 'world_not_bound', 'Este workspace não está ligado ao Ergon World.');
    const session = this.links.session(userId); const l = this.links.get(userId);
    if (!session || !l) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World para usar este recurso.');
    return { sws, session, deviceId: l.device_id, keys: JSON.parse(l.device_keys) as { x25519: string } };
  }

  /** Em que estado o cartão está aqui e se pode ir agora. Não fala com o World. */
  work(ws: string, ref: string, view?: RoutineView): CardWork {
    const base = { ref, adapter: null, pkg: null, routineId: null };
    if (!CARD_REF.test(ref)) return { ...base, state: null, eligible: false, reason: 'Cartão inválido.' };
    if (ref.startsWith('card:')) {
      const taskId = ref.slice(5);
      if (!this.tasks) return this.legacyCard(ws, taskId);
      const b = this.tasks.brief(ws, taskId);
      const state = b.state === 'completed' ? 'completed' : b.state;
      if (b.reason || !b.agentId) return { ...base, state, eligible: false, reason: b.reason ?? 'Cartão não encontrado.' };
      if (!this.has('hermes_task')) return { ...base, state, eligible: false, reason: NO_CLOUD_TASK };
      return { ref, routineId: null, agentId: b.agentId, state, eligible: true, reason: null, adapter: 'hermes_task', pkg: taskPackage(b, this.tasks.defaultModel(ws)) };
    }
    const routineId = ref.slice(7);
    let r: RoutineView;
    try { r = view ?? this.routines.get(ws, routineId); } catch { return { ...base, state: null, eligible: false, reason: 'Cartão não encontrado.' }; }
    const last = r.last?.status;
    const state = last === 'gathering' || last === 'running' ? 'running_local' : last === 'queued' ? 'queued_local' : r.trigger.kind === 'schedule' ? 'waiting_external' : 'waiting_user';
    const no = (reason: string) => ({ ...base, routineId, state, eligible: false, reason });
    if (r.status === 'setup') return no('Rotina em preparo.');
    if (r.status === 'paused') return no('Rotina pausada.');
    if (state === 'running_local') return no('Espere esta rodada terminar.');
    const el = sourcesEligibility(r.config.sources ?? []);
    if (!el.executorReady || !el.adapter) return no('Este tipo de trabalho ainda não roda na nuvem.');
    const pkg = r.missing.length ? null : feedPackage(r.config.sources ?? [], r.config.params ?? {});
    if (!pkg) return no('Falta configurar a rotina.');
    return { ref, routineId, state, eligible: true, reason: null, adapter: el.adapter, pkg };
  }

  /** Sem os cards do quadro na nuvem (instalação antiga): o motivo de sempre. */
  private legacyCard(ws: string, taskId: string): CardWork {
    const base = { ref: `card:${taskId}`, adapter: null, pkg: null, routineId: null };
    const t = this.db.get<{ completed: number; archived: number }>('SELECT completed, archived FROM tasks WHERE id = ? AND workspace_id = ?', taskId, ws);
    if (!t || Number(t.archived)) return { ...base, state: null, eligible: false, reason: 'Cartão não encontrado.' };
    if (Number(t.completed)) return { ...base, state: 'completed', eligible: false, reason: 'Já concluído.' };
    const run = this.db.get<{ status: string }>("SELECT status FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user') ORDER BY created_at DESC LIMIT 1", taskId);
    const state = run?.status === 'running' ? 'running_local' : run?.status === 'waiting_user' ? 'waiting_user' : 'queued_local';
    return { ...base, state, eligible: false, reason: state === 'running_local' ? 'Espere esta etapa terminar.' : NO_CLOUD_TASK };
  }

  private history(row: Row | null): RoundFailure[] {
    try { return (JSON.parse(row?.recovery_log ?? '[]') as RoundFailure[]).filter((x) => x && typeof x.reason === 'string').map((x) => ({ round: Number(x.round) || 0, reason: cut(x.reason, 300) })); } catch { return []; }
  }

  view(ws: string, ref: string, routine?: RoutineView): CardView {
    const row = this.row(ws, ref);
    const extra = { recovery: { round: Number(row?.recovery_round ?? 0), of: RECOVERY_ROUNDS }, history: row?.status === 'remote' && row.job_state && TERMINAL.includes(row.job_state) && row.job_state !== 'succeeded' ? this.history(row) : [], fallback: row?.model_fallback ?? null };
    if (row?.status === 'remote') return { ref, where: 'remote', badge: badgeOf(row.job_state, Number(row.recovery_round ?? 0)), jobState: row.job_state, canSend: false, reason: null, canClaim: !!row.job_state && TERMINAL.includes(row.job_state), ...extra };
    const w = this.work(ws, ref, routine);
    return { ref, where: row?.status === 'preparing' ? 'preparing' : 'local', badge: null, jobState: null, canSend: w.eligible, reason: w.reason, canClaim: false, ...extra, history: [] };
  }

  /** As rotinas do workspace (cada uma, um cartão) e os cards que já foram à nuvem. */
  list(ws: string): CardView[] {
    const out = new Map<string, CardView>();
    for (const r of this.routines.list(ws)) out.set(`rotina:${r.id}`, this.view(ws, `rotina:${r.id}`, r));
    for (const x of this.db.all<{ card_ref: string }>('SELECT card_ref FROM world_cards WHERE workspace_id = ?', ws)) if (!out.has(x.card_ref)) out.set(x.card_ref, this.view(ws, x.card_ref));
    return [...out.values()];
  }

  /** Erro do World → frase curta. Recusa definitiva: a intenção fecha e o cartão segue local, sem perder nada. */
  private fail(ws: string, ref: string, e: unknown): never {
    const code = (e as HttpError).code;
    if (code === 'world_offline') throw new HttpError(503, 'world_offline', OFFLINE);
    const m = ERRORS[code];
    if (!m?.[2]) this.drop(ws, ref);
    if (m) throw new HttpError(m[0], code, m[1]);
    if ((e as HttpError).status === 401) throw new HttpError(400, code ?? 'world_error', 'O Ergon World recusou o pedido.');
    throw e;
  }

  /** Aceito pelo World: daqui em diante o cartão é dele; a fila e o agendador daqui o pulam. */
  private accepted(ws: string, ref: string, v: HandoffView): CardView {
    this.patch(ws, ref, { status: 'remote', handoff_id: v.handoffId, job_id: v.jobId, job_state: v.jobState ?? 'queued', generation: v.owner?.generation ?? null, result_at: null, recovery_round: Number(v.recoveryRound ?? 0) });
    setRemoteHolder(this.db, ws, ref, 'world');
    if (ref.startsWith('rotina:')) this.routines.handedOff(ws, ref.slice(7));
    else if (ref.startsWith('card:')) this.tasks?.handedOff(ws, ref.slice(5));
    return this.view(ws, ref);
  }

  /** "Rodar na nuvem". */
  async send(userId: string, ws: string, ref: string): Promise<CardView> {
    const c = this.ctx(userId, ws);
    let row = this.row(ws, ref);
    if (row?.status === 'remote') throw new HttpError(409, 'already_remote', ERRORS.already_remote[1]);
    if (ref.startsWith('card:') && this.tasks) await this.features();
    // cartão que não pode ir: diz o motivo sem falar com o World
    const w = this.work(ws, ref);
    if (!w.eligible || !w.adapter || !w.pkg) throw new HttpError(409, 'not_portable', w.reason ?? ERRORS.not_portable[1]);
    const call = <T>(method: string, p: string, body?: unknown) => this.client.call<T>(method, p, body, c.session);
    let h: HandoffView | null = null;
    // intenção aberta (queda, resposta perdida): segue a mesma transferência
    if (row?.status === 'preparing' && row.handoff_id) {
      h = await call<HandoffView>('GET', `/v1/jobs/handoffs/${row.handoff_id}`).catch((e) => this.fail(ws, ref, e));
      if (h.status === 'committed') return this.accepted(ws, ref, h);
      if (h.status !== 'preparing' && h.status !== 'staged') { this.drop(ws, ref); row = null; h = null; }
    }
    if (!row || row.status !== 'preparing') {
      row = { workspace_id: ws, card_ref: ref, user_id: userId, status: 'preparing', intent_key: `int-${crypto.randomBytes(12).toString('hex')}`, handoff_id: null, generation: null, job_id: null, job_state: null, result_at: null, checked_at: null,
        agent_id: w.agentId ?? null, task_input: typeof w.pkg.instructions === 'string' ? w.pkg.instructions : null };
      this.save(ws, ref, userId, row); // gravada antes de sair: depois de uma queda, a mesma intenção
    } else if (w.agentId) this.patch(ws, ref, { agent_id: w.agentId, task_input: this.db.seal(ws, typeof w.pkg.instructions === 'string' ? w.pkg.instructions : null) });
    if (!h) {
      h = await call<HandoffView>('POST', '/v1/jobs/handoffs/prepare', { workspaceId: c.sws, cardRef: ref, cardState: w.state, adapter: w.adapter, routineRef: w.routineId ? `rotina:${w.routineId}` : ref, intentKey: row.intent_key })
        .catch((e) => this.fail(ws, ref, e));
      this.patch(ws, ref, { handoff_id: h.handoffId, generation: h.owner?.generation ?? null });
      if (h.status === 'committed') return this.accepted(ws, ref, h);
      if (h.status !== 'preparing' && h.status !== 'staged') { this.drop(ws, ref); throw new HttpError(410, 'handoff_expired', ERRORS.handoff_expired[1]); }
    }
    // o agente com o modelo da pessoa: a chave própria do provedor vai logo depois do prepare (lida aqui, só no servidor)
    if (w.adapter === 'hermes_task') await this.grant(ws, h.handoffId, w.pkg, call).catch((e) => this.fail(ws, ref, e));
    if (h.status === 'preparing') {
      await call('POST', `/v1/jobs/handoffs/${h.handoffId}/stage`, { sequence: 1, stageId: `${ref}:inicio`, safeToRetry: true, nextAction: 'rodar a rotina', package: w.pkg, checksum: packageChecksum(w.pkg) })
        .catch((e) => this.fail(ws, ref, e));
    }
    // logo antes do aceite: se começou a rodar aqui nesse meio-tempo, fica aqui (a intenção segue para a próxima vez)
    if (!this.work(ws, ref).eligible) throw new HttpError(409, 'checkpoint_required', 'Começou a rodar aqui. Ficou neste computador.');
    let done: HandoffView;
    try {
      done = await call<HandoffView>('POST', `/v1/jobs/handoffs/${h.handoffId}/commit`, { expectedGeneration: h.owner?.generation });
    } catch (e) {
      if ((e as HttpError).code !== 'world_offline' && (e as HttpError).status !== 503) this.fail(ws, ref, e);
      // a resposta do aceite se perdeu: o World decide; pergunta antes de qualquer coisa
      const v = await call<HandoffView>('GET', `/v1/jobs/handoffs/${h.handoffId}`).catch(() => null);
      if (v?.status === 'committed') return this.accepted(ws, ref, v);
      if (v && v.status !== 'preparing' && v.status !== 'staged') { this.drop(ws, ref); throw new HttpError(409, 'fenced', ERRORS.fenced[1]); }
      throw new HttpError(503, 'world_offline', OFFLINE);
    }
    return this.accepted(ws, ref, done);
  }

  /**
   * Chave do provedor do agente para a tarefa rodar com o modelo dele (POST …/model-grant). Só provedor de chave de API
   * guardada neste computador; login por assinatura nunca vai. Sem chave, ou recusada: nada — o World roda no Ergon AI e
   * avisa. A chave não entra em log nem em resposta.
   */
  private async grant(ws: string, handoffId: string, pkg: Record<string, unknown>, call: <T>(method: string, p: string, body?: unknown) => Promise<T>): Promise<void> {
    const m = pkg.model as { provider?: string; id?: string } | undefined;
    if (!m?.provider || !m.id || !DELEGATED.includes(m.provider) || !this.tasks || !this.has('model_grant')) return;
    const apiKey = this.tasks.providerKey(ws, m.provider);
    if (!apiKey) return;
    await call('POST', `/v1/jobs/handoffs/${handoffId}/model-grant`, { provider: m.provider, model: m.id, apiKey }).catch((e: HttpError) => {
      // posse perdida, envio vencido, pausa pedida: o envio para; o resto (provedor ou chave recusados) só troca de modelo
      if (['fenced', 'handoff_expired', 'world_offline', 'rate_limited', 'handoff_state'].includes(e.code)) throw e;
    });
  }

  /** Cartões deste workspace que precisam de leitura do World (na nuvem ainda sem resultado, ou com envio aberto). */
  private pending(ws: string): Row[] {
    return this.db.all<Row>(`SELECT * FROM world_cards WHERE workspace_id = ? AND ((status = 'remote' AND (result_at IS NULL OR job_state IS NULL OR job_state NOT IN ('succeeded', 'failed', 'cancelled', 'rejected')))
      OR (status = 'preparing' AND handoff_id IS NOT NULL))`, ws);
  }
  /** Há o que acompanhar no World (para a leitura periódica). */
  watched(): Array<{ user_id: string; workspace_id: string }> {
    return this.db.all<{ user_id: string; workspace_id: string }>(`SELECT DISTINCT user_id, workspace_id FROM world_cards WHERE (status = 'remote' AND result_at IS NULL) OR (status = 'preparing' AND handoff_id IS NOT NULL)`);
  }

  /**
   * Lê o World (no máximo a cada minMs, e só com cartão na nuvem): o estado de cada Job no cartão e, terminado, o
   * resultado no mesmo cartão. Envio que ficou aberto é resolvido pela consulta da transferência.
   */
  async refresh(userId: string, ws: string, force = false): Promise<void> {
    const rows = this.pending(ws);
    if (!rows.length) return;
    if (!force && Date.now() - (this.lastAt.get(ws) ?? 0) < this.minMs) return;
    this.lastAt.set(ws, Date.now());
    const c = this.ctx(userId, ws);
    const call = <T>(method: string, p: string) => this.client.call<T>(method, p, undefined, c.session);
    for (const r of rows.filter((x) => x.status === 'preparing')) {
      const v = await call<HandoffView>('GET', `/v1/jobs/handoffs/${r.handoff_id}`).catch(() => null);
      if (v?.status === 'committed') this.accepted(ws, r.card_ref, v);
      else if (v && v.status !== 'preparing' && v.status !== 'staged') this.drop(ws, r.card_ref);
    }
    if (!rows.some((x) => x.status === 'remote')) return;
    const cards = await call<WorldCard[]>('GET', `/v1/jobs/cards?workspace=${encodeURIComponent(c.sws)}`);
    let changed = false;
    for (const r of this.pending(ws).filter((x) => x.status === 'remote')) {
      const w = cards.find((x) => x.cardRef === r.card_ref);
      if (!w) continue;
      if (w.holder === 'world') {
        const round = Number(w.recoveryRound ?? r.recovery_round ?? 0);
        if (w.jobState !== r.job_state || w.generation !== r.generation || round !== Number(r.recovery_round ?? 0)) { this.patch(ws, r.card_ref, { job_state: w.jobState, job_id: w.jobId ?? r.job_id, generation: w.generation, recovery_round: round, checked_at: now() }); changed = true; }
        if (w.jobState && TERMINAL.includes(w.jobState) && !r.result_at) { await this.attach(userId, ws, { ...this.row(ws, r.card_ref)!, job_id: w.jobId ?? r.job_id, job_state: w.jobState }); changed = true; }
      }
    }
    if (changed) { this.bus.publish(ws, 'routines.changed', {}); this.bus.publish(ws, 'tasks.changed', {}); }
  }

  /**
   * O fim do Job. Falhou com rodada de recuperação criada (`recovery.next`): não é o fim — o cartão segue a rodada nova.
   * Terminou: o resultado (cifrado para os aparelhos da pessoa) entra no mesmo cartão. Card do quadro: volta a este
   * computador e a resposta entra como a de uma execução daqui (o card anda como andaria). Falha final: o cartão fica
   * "Falhou na nuvem", com o que falhou em cada rodada.
   */
  private async attach(userId: string, ws: string, r: Row): Promise<void> {
    if (!r.job_id) return;
    const c = this.ctx(userId, ws);
    const get = (id: string) => this.client.call<JobView>('GET', `/v1/jobs/${id}`, undefined, c.session);
    let jobId = r.job_id; let j = await get(jobId);
    for (let i = 0; i < 6 && j.state === 'failed' && typeof j.recovery?.next === 'string' && j.recovery.next; i++) {
      jobId = j.recovery.next;
      j = await get(jobId);
    }
    const round = Number(j.recovery?.round ?? r.recovery_round ?? 0);
    const log = Array.isArray(j.recovery?.log) ? j.recovery!.log.map((x) => ({ round: Number(x.round) || 0, reason: cut(String(x.reason ?? ''), 300) })) : this.history(r);
    if (!TERMINAL.includes(j.state)) {
      // uma rodada de recuperação nova, esperando ou rodando: o selo mostra a rodada
      this.patch(ws, r.card_ref, { job_id: jobId, job_state: j.state, recovery_round: round, recovery_log: JSON.stringify(log), checked_at: now() });
      return;
    }
    const fb = fallbackReason(j.modelFallback);
    let opened: unknown = null;
    if (j.state === 'succeeded') { try { opened = j.result ? openJobResult(jobId, j.result, c.deviceId, c.keys.x25519) : null; } catch { opened = null; } }
    const failures = j.state === 'succeeded' ? log : [...log, { round, reason: cut(String(j.reason ?? 'sem motivo informado'), 300) }];
    const fbText = fb ?? fallbackReason((opened as { modelFallback?: unknown } | null)?.modelFallback);
    const record = () => this.db.run(`INSERT OR IGNORE INTO world_cloud_results (job_id, workspace_id, user_id, card_ref, outcome, recovered, fallback, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId, ws, userId, r.card_ref, j.state === 'succeeded' ? 'concluido' : 'falhou', j.state === 'succeeded' && round > 0 ? 1 : 0, fbText, j.state === 'succeeded' ? null : cut(String(j.reason ?? ''), 300), now());
    if (r.card_ref.startsWith('card:') && this.tasks) {
      const taskId = r.card_ref.slice(5);
      if (fbText && r.model_fallback !== fbText) this.tasks.note(ws, taskId, 'task.cloud_fallback', `Rodou no Ergon AI: ${fbText}`);
      if (j.state === 'succeeded' && opened) {
        // volta a este computador primeiro (o Job terminou); sem isso a resposta espera a próxima leitura
        const back = await this.client.call<{ holder: string; generation: number }>('POST', '/v1/jobs/cards/claim', { workspaceId: c.sws, cardRef: r.card_ref, expectedGeneration: r.generation }, c.session).catch(() => null);
        if (!back) { this.patch(ws, r.card_ref, { job_id: jobId, job_state: j.state, recovery_round: round, model_fallback: fbText }); return; }
        this.patch(ws, r.card_ref, { status: 'local', generation: back.generation, job_id: jobId, job_state: j.state, result_at: now(), recovery_round: round, recovery_log: JSON.stringify(log), model_fallback: fbText });
        setRemoteHolder(this.db, ws, r.card_ref, null);
        const out = opened as { output?: unknown; model?: { provider?: string; id?: string } };
        const model = out.model?.provider && out.model.id ? `${out.model.provider}/${out.model.id}` : null;
        record();
        this.tasks.finished(ws, taskId, { key: jobId, agentId: r.agent_id ?? '', input: r.task_input ?? '', status: 'succeeded', output: typeof out.output === 'string' ? out.output : '', error: null, model });
        return;
      }
      if (j.state !== 'succeeded') this.tasks.note(ws, taskId, 'task.cloud_failed', `Falhou na nuvem: ${cut(String(j.reason ?? 'sem motivo informado'), 200)}`);
    } else if (r.card_ref.startsWith('rotina:')) {
      const text = j.state === 'succeeded'
        ? (opened ? feedResultText(opened) : { summary: 'Concluído na nuvem', output: 'O resultado foi cifrado para outro aparelho seu.' })
        : { summary: 'Falhou na nuvem', output: j.reason ? `Motivo: ${String(j.reason).slice(0, 300)}` : '' };
      try { this.routines.recordRemote(ws, r.card_ref.slice(7), { key: jobId, status: j.state === 'succeeded' ? 'succeeded' : 'failed', ...text }); } catch { /* rotina removida: o estado fica no cartão */ }
    }
    record();
    this.patch(ws, r.card_ref, { result_at: now(), job_id: jobId, job_state: j.state, recovery_round: round, recovery_log: JSON.stringify(failures), model_fallback: fbText });
  }

  /**
   * "Enquanto você esteve fora": o que chegou da nuvem desde a última vez que a pessoa viu o resumo, em números, e o
   * detalhe de cada um (sob pedido, na tela). seen: marca tudo como visto.
   */
  summary(userId: string, ws: string): { counts: { concluidos: number; recuperados: number; falharam: number; ergonAi: number }; items: Array<{ ref: string; outcome: string; recovered: boolean; fallback: string | null; reason: string | null; at: string }> } {
    const rows = this.db.all<{ card_ref: string; outcome: string; recovered: number; fallback: string | null; reason: string | null; at: string }>(
      'SELECT card_ref, outcome, recovered, fallback, reason, at FROM world_cloud_results WHERE user_id = ? AND workspace_id = ? AND seen = 0 ORDER BY at DESC LIMIT 200', userId, ws);
    return {
      counts: {
        concluidos: rows.filter((x) => x.outcome === 'concluido').length, recuperados: rows.filter((x) => Number(x.recovered)).length,
        falharam: rows.filter((x) => x.outcome === 'falhou').length, ergonAi: rows.filter((x) => x.fallback).length,
      },
      items: rows.map((x) => ({ ref: x.card_ref, outcome: x.outcome, recovered: !!Number(x.recovered), fallback: x.fallback, reason: x.reason, at: x.at })),
    };
  }
  seen(userId: string, ws: string): void { this.db.run('UPDATE world_cloud_results SET seen = 1 WHERE user_id = ? AND workspace_id = ? AND seen = 0', userId, ws); }

  /** "Trazer para este computador": só com o Job do World terminado; o cartão volta a ser local (nada volta sozinho). */
  async claim(userId: string, ws: string, ref: string): Promise<CardView> {
    const c = this.ctx(userId, ws);
    if (this.row(ws, ref)?.status !== 'remote') throw new HttpError(409, 'not_remote', 'Este cartão já está neste computador.');
    await this.refresh(userId, ws, true).catch(() => undefined);
    const row = this.row(ws, ref)!;
    const r = await this.client.call<{ holder: string; generation: number }>('POST', '/v1/jobs/cards/claim', { workspaceId: c.sws, cardRef: ref, expectedGeneration: row.generation }, c.session)
      .catch((e) => {
        const code = (e as HttpError).code;
        if (code === 'world_offline') throw new HttpError(503, 'world_offline', 'Sem conexão com o Ergon World agora. Tente de novo.');
        if (code === 'remote_running') throw new HttpError(409, code, ERRORS.remote_running[1]);
        if (code === 'fenced') throw new HttpError(409, code, 'O cartão mudou na nuvem. Tente de novo.');
        throw e;
      });
    this.patch(ws, ref, { status: 'local', generation: r.generation });
    setRemoteHolder(this.db, ws, ref, null);
    this.bus.publish(ws, 'routines.changed', {});
    return this.view(ws, ref);
  }

  // ---------------------------------------------------------------- posse local de cartão registrado no World
  /**
   * Batimento da posse local dos cartões já registrados no World (os que foram e voltaram). Os outros nunca vão ao
   * World. Devolve, por cartão, se a posse segue aqui.
   */
  async heartbeat(userId: string, ws: string, refs: string[]): Promise<Array<{ cardRef: string; ok: boolean; generation: number; holder: string }>> {
    const rows = refs.map((ref) => this.row(ws, ref)).filter((r): r is Row => r?.status === 'local');
    if (!rows.length) return [];
    const c = this.ctx(userId, ws);
    const out = await this.client.call<{ cards: Array<{ cardRef: string; ok: boolean; generation: number; holder: string }> }>('POST', '/v1/jobs/heartbeats',
      { workspaceId: c.sws, cards: rows.map((r) => ({ cardRef: r.card_ref, ...(r.generation ? { generation: r.generation } : {}) })) }, c.session);
    for (const x of out.cards) if (x.ok) this.patch(ws, x.cardRef, { generation: x.generation });
    return out.cards;
  }

  /**
   * Licença para um efeito externo (enviar, gravar fora) num cartão: cartão que nunca foi ao World não pede nada
   * (registered: false). Registrado: só o dono atual, na geração atual, e uma vez por chave (first: false = já feito,
   * não repita). Posse perdida → 409 fenced (não faça o efeito).
   */
  async effect(userId: string, ws: string, ref: string, effectKey: string): Promise<{ first: boolean; registered: boolean }> {
    const row = this.row(ws, ref);
    if (!row) return { first: true, registered: false };
    if (row.status !== 'local') throw new HttpError(409, 'fenced', 'Este cartão não está com este computador.');
    const [hb] = await this.heartbeat(userId, ws, [ref]);
    if (!hb?.ok) throw new HttpError(409, 'fenced', 'Este cartão não está com este computador.');
    const c = this.ctx(userId, ws);
    const r = await this.client.call<{ first: boolean }>('POST', '/v1/jobs/cards/effects', { workspaceId: c.sws, cardRef: ref, generation: hb.generation, effectKey }, c.session)
      .catch((e) => { if ((e as HttpError).code === 'fenced') throw new HttpError(409, 'fenced', 'Este cartão não está com este computador.'); throw e; });
    return { first: r.first, registered: true };
  }
}
