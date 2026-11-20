/**
 * Um Ergon World de mentira, só para os testes do cliente (server/src/world): implementa as rotas que o cliente chama,
 * com as mesmas respostas e os mesmos erros do contrato público (contas, aparelhos com prova de posse, autorização,
 * plano, créditos, Jobs e o Sync de envelopes cifrados). O serviço de verdade é privado e não mora neste repositório.
 * O estado fica fora do servidor HTTP: fechar e abrir de novo na mesma porta simula o World fora do ar e de volta.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { wrapForDevice } from '../src/world/sync-crypto.ts';
import { validatePackage } from '../src/services/ergon-package.ts';

/** a mesma conferência de world/src/hermes-task.ts (pacote do adaptador hermes_task), escrita à parte */
function checkHermesTask(s: Record<string, unknown>): string | null {
  if (typeof s.instructions !== 'string' || !s.instructions.trim()) return 'hermes_task: faltam as instruções';
  if (s.instructions.length > 20_000) return 'hermes_task: instruções longas demais';
  if (s.context !== undefined && (typeof s.context !== 'string' || s.context.length > 100_000)) return 'hermes_task: contexto longo demais';
  if (s.model !== undefined && s.model !== null) {
    if (typeof s.model === 'string') { if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(s.model)) return 'hermes_task: modelo inválido'; }
    else if (typeof s.model === 'object' && !Array.isArray(s.model)) {
      const o = s.model as Record<string, unknown>;
      if (Object.keys(o).some((k) => k !== 'provider' && k !== 'id')) return 'hermes_task: modelo inválido';
      if (typeof o.provider !== 'string' || !/^[a-z0-9][a-z0-9-]{1,29}$/.test(o.provider)) return 'hermes_task: provedor do modelo inválido';
      if (typeof o.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(o.id)) return 'hermes_task: modelo inválido';
    } else return 'hermes_task: modelo inválido';
  }
  if (s.maxOutputTokens !== undefined && (!Number.isInteger(s.maxOutputTokens) || (s.maxOutputTokens as number) < 1 || (s.maxOutputTokens as number) > 32_768)) return 'hermes_task: limite de saída inválido';
  if (s.profile !== undefined) {
    if (!s.profile || typeof s.profile !== 'object' || Array.isArray(s.profile)) return 'hermes_task: perfil inválido';
    const p = s.profile as Record<string, unknown>;
    if (Object.keys(p).some((k) => k !== 'name' && k !== 'systemPrompt')) return 'hermes_task: perfil inválido';
    if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 80)) return 'hermes_task: nome do perfil inválido';
    if (p.systemPrompt !== undefined && (typeof p.systemPrompt !== 'string' || p.systemPrompt.length > 8_000)) return 'hermes_task: instruções do perfil longas demais';
  }
  return null;
}

interface Account { id: string; email: string; password: string; displayName: string; emailVerified: boolean; locale?: string }
interface Device { id: string; accountId: string; name: string; publicKey: string; syncPublicKey: string; challenge: string; status: 'pending' | 'active' | 'revoked'; session: string | null; lastSeenAt: string }
interface Workspace { id: string; owner: string; label: string | null; plan: string | null; head: number; changes: Array<Record<string, unknown>>; envelopes: Map<string, { keyVersion: number; wrapped: string }>; recovery: { keyVersion: number; wrapped: string } | null;
  /** quem entrou por convite (o dono fica em owner); papel e desde quando (world/src/sync.ts) */
  members?: Map<string, { role: 'admin' | 'editor' | 'viewer'; since: string }>;
  invites?: Array<{ id: string; role: string; tokenHash: string; expiresAt: number; createdAt: string; accepted: boolean }>;
  /** vagas do plano (padrão: 3 com plano, 0 sem) */
  seats?: number;
  /** alguém saiu: a chave precisa girar antes de novas mudanças */
  rotationRequired?: boolean;
  /** de onde vem o plano: 'stripe' (pago) ou 'cortesia' (dado pela equipe, sem assinatura); null sem plano */
  source?: 'stripe' | 'cortesia' | null;
  /** extrato de Dracmas (GET /v1/wallet/statement) */
  statement?: Array<{ id: string; kind: string; delta: string; amount: string; createdAt: string; meta?: Record<string, unknown> }>;
  /** saldo disponível (padrão: ₯ 1.000 com plano, 0 sem) */
  balance?: string;
  /** moeda da assinatura (padrão brl) e quando chega a próxima franquia mensal (aditivo pedido ao World: next_grant_at) */
  currency?: 'brl' | 'usd' | 'eur';
  nextGrantAt?: string | null;
  /** registro do que aconteceu no workspace (aditivo pedido ao World: GET /v1/workspaces/:id/activity), mais velho primeiro */
  activity?: Array<{ id: string; at: string; action: string; actor: string | null; target: string | null; detail: Record<string, string> }>;
  /** versão atual da chave (padrão 1); sobe a cada giro (mudança kind 'rotation') */
  keyVersion?: number;
  /** envelopes de recuperação por conta (o primeiro também em recovery, como antes) */
  recoveries?: Map<string, { keyVersion: number; wrapped: string }>;
  /** a assinatura (itens do Stripe) e a recarga automática */
  sub?: { items: Array<{ sku: string; quantity: number }> } | null;
  autotopup?: Record<string, unknown> | null;
  budgets?: Map<string, string | null> }
type Role = 'owner' | 'admin' | 'editor' | 'viewer';
const RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
/** Jobs ao mesmo tempo por nível (world/src/catalog.ts) */
const SLOTS: Record<string, number> = { sync: 2, pro: 5, team: 12 };
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

interface Owner { holder: 'local' | 'world'; deviceId: string | null; generation: number; leaseUntil: number; jobId: string | null }
interface Handoff { id: string; ws: string; card: string; accountId: string; deviceId: string; intent: string; status: 'preparing' | 'staged' | 'committed' | 'rejected' | 'expired'; generation: number; adapter: string; routineRef: string; cardState: string; jobId: string | null; reason: string | null; checksum: string | null; pkg: unknown; expiresAt: number }
interface HJob { id: string; ws: string; accountId: string; state: string; reason: string | null; result: string | null; routineRef: string; spec: unknown; queuedAt: string;
  adapter: string; handoffId: string | null; modelFallback: unknown; recoveryOf: string | null; recoveryRound: number; recoveryLog: Array<{ round: number; reason: string; at: string }>; recoveredBy: string | null; runAfter: string | null }

const hex = (n: number) => crypto.randomBytes(n).toString('hex');
/** JSON canônico, escrito à parte (como no World): o cliente tem de chegar ao mesmo sha256 sem copiar daqui */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
const checksumOf = (pkg: unknown) => `sha256:${crypto.createHash('sha256').update(canonical(pkg)).digest('hex')}`;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'rejected'];
const CARD_RE = /^[A-Za-z0-9_:.-]{1,120}$/;

export class FakeWorld {
  accounts = new Map<string, Account>();
  idTokens = new Map<string, { accountId: string; exp: number }>();
  devices = new Map<string, Device>();
  workspaces = new Map<string, Workspace>();
  bindings: Array<{ accountId: string; localPersonId: string }> = [];
  // "Rodar na nuvem" (world/src/handoffs.ts): dono de cada cartão (a geração é o fencing token), transferências, Jobs
  owners = new Map<string, Owner>();
  handoffs = new Map<string, Handoff>();
  hjobs = new Map<string, HJob>();
  effects = new Set<string>();
  adapters = ['web_feed', 'hermes_task'];
  /** o que GET /v1/compat anuncia */
  features = ['web_feed', 'hermes_task', 'model_grant', 'recovery', 'job_policy'];
  /** chaves delegadas do modelo (por transferência; passam ao Job no aceite e às rodadas de recuperação) */
  grants = new Map<string, { provider: string; model: string; apiKey: string }>();
  /** cada checkout pedido (workspace e itens), para os testes conferirem o carrinho */
  /** workspaces desativados pelo app (apagados no computador) */
  deactivated = new Set<string>();
  checkouts: Array<{ ws: string; items: Array<{ sku: string; quantity: number }> }> = [];
  /**
   * Loja colaborativa (world/src/marketplace.ts): criadores, itens com versões, licenças grátis. Só grátis: preço
   * diferente de zero é recusado. GET /v1/marketplace/mine: as publicações da conta.
   */
  creators = new Map<string, { namespace: string; displayName: string; official: boolean }>();
  mkItems = new Map<string, { id: string; packageId: string; kind: string; title: string; summary: string; creator: string; status: string; latest: string | null;
    versions: Array<{ version: string; artifact: Buffer; sha256: string; verified: boolean; status: string; createdAt: string; reason?: string }> }>();
  licenses = new Set<string>();
  /** a moderação decide (aprovar publica a última versão) */
  moderate(itemId: string, decision: 'approve' | 'reject', reason = 'ok'): void {
    const i = this.mkItems.get(itemId)!; const v = i.versions.at(-1)!;
    if (decision === 'approve') { v.status = 'approved'; i.status = 'published'; i.latest = v.version; }
    else { v.status = 'rejected'; v.reason = reason; i.status = i.latest ? 'published' : 'rejected'; }
  }
  /** um item OFICIAL publicado pela equipe (painel interno), já na vitrine */
  publishOfficial(artifact: Buffer): string {
    const p = validatePackage(artifact);
    const id = `itm_${hex(12)}`;
    this.mkItems.set(id, { id, packageId: p.manifest.package_id, kind: p.manifest.kind, title: p.manifest.title, summary: p.manifest.summary, creator: 'oficial', status: 'published', latest: p.manifest.version,
      versions: [{ version: p.manifest.version, artifact, sha256: p.sha256, verified: true, status: 'approved', createdAt: new Date().toISOString() }] });
    return id;
  }
  /**
   * Nuvem ("Subir o WS para o World", world/src/cloud.ts e cloud-boot.ts): por workspace, o token de partida do
   * contêiner, a chave do cofre dele, o aparelho-nuvem, o que ele contou (estado, instalação no relé, atividade) e os
   * sinais do computador (aberto/fechado). `nuvem(sws)` ativa e devolve o token de partida.
   */
  clouds = new Map<string, { bootToken: string; vaultKey: string | null; deviceId: string | null; states: string[]; relay: string | null; active: boolean; presence: boolean[] }>();
  nuvem(sws: string): string { const bootToken = `${sws}.${hex(16)}`; this.clouds.set(sws, { bootToken, vaultKey: null, deviceId: null, states: [], relay: null, active: false, presence: [] }); return bootToken; }
  /** giros de chave recebidos (mudança kind rotation): de qual workspace, para que versão, por quem */
  rotations: Array<{ ws: string; keyVersion: number; by: string }> = [];
  /** provedores aceitos por delegação (WORLD_DELEGATED_PROVIDERS, padrão) */
  delegated = ['openai', 'anthropic', 'deepseek', 'openrouter'];
  /** protocolo de recuperação por workspace (ausente = ligado) */
  policies = new Map<string, boolean>();
  /** papel da conta no workspace (ausente = owner, o dono) */
  roles = new Map<string, string>();
  /** os próximos N pedidos com sessão recebem 429 rate_limited com Retry-After */
  /** o World recusa criar ou comprar sem o e-mail confirmado (403 email_unverified); desligado nos testes antigos */
  requireVerifiedEmail = false;
  /** credenciais do Ergon AI emitidas (POST /v1/ai/credentials) */
  aiTokens = new Set<string>();
  /** GET /v1/ai/models: só modelos da marca Ergon (id, nome, descrição); um teste troca para simular o catálogo de antes */
  aiModels: Array<{ id: string; name?: string; description?: string }> = [
    { id: 'ergon-ai', name: 'Ergon AI', description: 'Rápido, para o dia a dia' },
    { id: 'ergon-ai-sinapse', name: 'Ergon AI Sinapse', description: 'Pensa antes de responder' },
  ];
  /** Confirma o e-mail da conta por fora do aplicativo (o link de um clique do e-mail, no site). */
  confirmEmail(email: string): void { [...this.accounts.values()].find((a) => a.email === email)!.emailVerified = true; }
  rateLimitNext = 0;
  leaseMs = 90_000;
  /** o próximo pedido que casar é processado, mas a resposta se perde (a conexão cai) */
  dropResponse: RegExp | null = null;
  /** chamado logo antes de processar um aceite (commit): para mudar a posse no meio, como outro computador faria */
  onCommit: ((h: { ws: string; card: string }) => void) | null = null;
  /** cada pedido recebido (método, caminho e corpo), para os testes conferirem o que saiu do aparelho */
  log: Array<{ method: string; path: string; body: any; auth: string | null }> = [];
  /** quantos aparelhos com sessão ao mesmo tempo */
  sessionLimit = 2;
  server: http.Server | null = null;
  port = 0;

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  async start(port = this.port): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.server!.listen(port, '127.0.0.1', ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  async stop(): Promise<void> {
    const s = this.server; this.server = null;
    if (s) { s.closeAllConnections(); await new Promise<void>((ok) => s.close(() => ok())); }
  }

  /** Simula o pagamento confirmado (o webhook do Stripe no World de verdade). */
  activate(ws: string, plan = 'world_pro', seats?: number): void { const w = this.workspaces.get(ws)!; w.plan = plan; w.sub ??= { items: [{ sku: plan, quantity: 1 }] }; if (seats !== undefined) w.seats = seats; }
  /**
   * Workspace criado do lado do servidor, antes de qualquer computador (world/src/web.ts no primeiro checkout do site;
   * admin/cortesia.ts em "Criar workspace e conceder"): a conta é a dona, sem aparelho principal, sem envelope de chave
   * nenhum, nada enviado (head 0) e a chave na versão 1. Com source 'cortesia', o plano vem concedido.
   */
  serverWorkspace(accountId: string, o: { plan?: string; source?: 'stripe' | 'cortesia'; label?: string } = {}): string {
    const w: Workspace = { id: `sws_${hex(16)}`, owner: accountId, label: o.label ?? 'Meu workspace', plan: null, head: 0, changes: [], envelopes: new Map(), recovery: null };
    this.workspaces.set(w.id, w);
    if (o.source === 'cortesia') this.cortesia(w.id, o.plan ?? 'world_pro');
    else if (o.plan) this.activate(w.id, o.plan);
    return w.id;
  }
  /** Uma linha no registro do workspace (o World grava em audit_log; aqui, só o que a rota de atividade devolve). */
  registrar(ws: string, action: string, actor: string | null, target: string | null = null, detail: Record<string, string> = {}): void {
    (this.workspaces.get(ws)!.activity ??= []).push({ id: `act_${hex(6)}`, at: new Date().toISOString(), action, actor, target, detail });
  }
  /** Plano cortesia (painel interno do World): ativo, sem assinatura; o crédito entra no extrato como 'cortesia'. */
  cortesia(ws: string, plan = 'world_pro', creditos = '500.000000'): void {
    const w = this.workspaces.get(ws)!; w.plan = plan; w.source = 'cortesia'; w.sub = null;
    (w.statement ??= []).push({ id: `led_${hex(6)}`, kind: 'cortesia', delta: creditos, amount: creditos, createdAt: new Date().toISOString() });
  }
  /** O executor do World: o Job passa a rodar (ou termina, com o resultado cifrado para os aparelhos da pessoa). */
  runJob(jobId: string, state: 'running' | 'succeeded' | 'failed', result?: unknown, reason = 'a fonte não respondeu'): string | null {
    const j = this.hjobs.get(jobId)!; j.state = state;
    if (state === 'failed') { j.reason = reason; return this.recover(j, reason); }
    if (state !== 'succeeded') return null;
    let out = result ?? {};
    if (j.adapter === 'hermes_task') {
      // como o world-runner: o modelo pedido, com a chave delegada viva; sem ela (ou provedor não aceito), o Ergon AI
      const spec = (j.spec ?? {}) as { model?: { provider: string; id: string } };
      const asked = spec.model ?? null;
      const g = j.handoffId ? this.grants.get(j.handoffId) : undefined;
      const allowed = !!asked && this.delegated.includes(asked.provider);
      let model = { provider: 'ergon-ai', id: 'ergon-ai' };
      if (asked && asked.provider !== 'ergon-ai') {
        if (g && allowed && g.provider === asked.provider) model = { provider: g.provider, id: g.model };
        else j.modelFallback = { from: asked, to: model, reason: !allowed ? 'provedor não aceito na nuvem' : g ? 'chave de outro provedor' : 'sem chave do provedor para a nuvem' };
      }
      out = { kind: 'hermes_task', output: typeof result === 'string' ? result : String((result as { output?: unknown })?.output ?? ''), model, modelFallback: j.modelFallback ?? null, usage: null, finishedAt: new Date().toISOString() };
      if (j.handoffId) this.grants.delete(j.handoffId); // a chave some no fim do Job
    }
    const key = crypto.randomBytes(32); const n = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, n); c.setAAD(Buffer.from(`ergon/job-result/v1|${jobId}`));
    const ct = Buffer.concat([c.update(JSON.stringify(out)), c.final(), c.getAuthTag()]);
    const devs = [...this.devices.values()].filter((d) => d.accountId === j.accountId && d.status === 'active');
    j.result = JSON.stringify({ v: 1, nonce: n.toString('base64'), ct: ct.toString('base64'), keys: Object.fromEntries(devs.map((d) => [d.id, wrapForDevice(key, d.syncPublicKey, `job:${jobId}`, 1)])) });
    return null;
  }
  /** Protocolo de recuperação (world/src/jobs.ts, recoverTx): falhou → rodada nova (até 3), o cartão passa para ela. */
  private recover(j: HJob, reason: string): string | null {
    if (j.recoveryRound >= 3 || /saldo|plano do world|cancelad|pacote inv[aá]lido|job_spec/i.test(reason) || this.policies.get(j.ws) === false) return null;
    const round = j.recoveryRound + 1;
    const n: HJob = { ...j, id: `job_${hex(16)}`, state: 'queued', reason: null, result: null, queuedAt: new Date().toISOString(), recoveryOf: j.recoveryOf ?? j.id, recoveryRound: round,
      recoveryLog: [...j.recoveryLog, { round: j.recoveryRound, reason: reason.slice(0, 300), at: new Date().toISOString() }], recoveredBy: null, runAfter: new Date(Date.now() + 60_000).toISOString() };
    this.hjobs.set(n.id, n);
    j.recoveredBy = n.id;
    for (const o of this.owners.values()) if (o.holder === 'world' && o.jobId === j.id) o.jobId = n.id;
    return n.id;
  }
  /** Outro computador assume o cartão (a posse local deste venceu): o próximo aceite daqui é recusado. */
  takeOver(ws: string, card: string): void { const o = this.owners.get(`${ws}|${card}`)!; o.deviceId = `dev_${hex(16)}`; o.generation += 1; o.leaseUntil = Date.now() + this.leaseMs; }
  calls(path: string): number { return this.log.filter((x) => x.path.split('?')[0] === path).length; }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const u = new URL(req.url ?? '/', 'http://x');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '') || null;
    this.log.push({ method: req.method ?? 'GET', path: u.pathname + u.search, body, auth: bearer });
    const send = (status: number, j: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(j)); };
    if (bearer && this.rateLimitNext > 0) { this.rateLimitNext--; send(429, { error: 'rate_limited', message: 'slow down' }, { 'retry-after': '120' }); return; }
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => send(status, { error, message: error, ...extra });
    try {
      const out = this.route(req.method ?? 'GET', u, body, bearer);
      if (this.dropResponse?.test(`${req.method} ${u.pathname}`)) { this.dropResponse = null; res.destroy(); return; }
      if ('fail' in out) fail(out.fail[0], out.fail[1], out.fail[2]);
      else if ('raw' in out) { res.writeHead(200, { 'content-type': 'application/x-ergon', ...out.headers }); res.end(out.raw); }
      else send(out.status ?? 200, out.json);
    } catch (e) { fail(500, 'internal', { detail: String(e) }); }
  }

  private session(bearer: string | null): Device | null {
    return [...this.devices.values()].find((d) => d.status === 'active' && d.session && d.session === bearer) ?? null;
  }
  private connected(accountId: string): Device[] { return [...this.devices.values()].filter((d) => d.accountId === accountId && d.status === 'active' && d.session && (d as Device & { kind?: string }).kind !== 'cloud'); }

  private route(method: string, u: URL, b: any, bearer: string | null): { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] } | { raw: Buffer; headers: Record<string, string> } {
    const p = u.pathname;
    const key = `${method} ${p}`;
    // ---------------------------------------------------------------- contas
    if (key === 'POST /v1/accounts') {
      if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email) || typeof b.password !== 'string' || b.password.length < 10) return { fail: [400, 'invalid_request'] };
      if ([...this.accounts.values()].some((a) => a.email === b.email)) return { fail: [409, 'email_in_use'] };
      // idioma dos e-mails da conta (aditivo; fora da lista, o World recusa o pedido)
      if (b.locale !== undefined && !['pt', 'en', 'es', 'fr', 'de', 'hi', 'zh'].includes(b.locale)) return { fail: [400, 'invalid_request'] };
      const a: Account = { id: `acc_${hex(16)}`, email: b.email, password: b.password, displayName: String(b.displayName ?? ''), emailVerified: false, ...(b.locale ? { locale: b.locale } : {}) };
      this.accounts.set(a.id, a);
      return { status: 201, json: { accountId: a.id, idToken: this.token(a.id), emailVerified: false } };
    }
    if (key === 'POST /v1/accounts/login') {
      const a = [...this.accounts.values()].find((x) => x.email === b.email);
      if (!a || a.password !== b.password) return { fail: [401, 'invalid_credentials'] };
      return { json: { accountId: a.id, idToken: this.token(a.id), emailVerified: a.emailVerified } };
    }
    if (key === 'POST /v1/accounts/email/verify') {
      const a = [...this.accounts.values()].find((x) => x.email === b.email);
      if (!a || b.code !== '123456') return { fail: [400, 'invalid_code'] };
      a.emailVerified = true;
      return { json: { emailVerified: true } };
    }
    if (key === 'POST /v1/accounts/email/resend' || key === 'POST /v1/accounts/password/forgot') return { status: 202, json: {} };
    if (key === 'POST /v1/accounts/password/reset') {
      const a = [...this.accounts.values()].find((x) => x.email === b.email);
      if (!a || b.code !== '123456') return { fail: [400, 'invalid_code'] };
      a.password = b.password;
      return { json: { ok: true } };
    }
    // ---------------------------------------------------------------- aparelhos (prova de posse da chave Ed25519)
    if (key === 'POST /v1/devices/register') {
      const t = this.idTokens.get(b.idToken);
      if (!t || t.exp < Date.now()) return { fail: [401, 'invalid_token'] };
      this.idTokens.delete(b.idToken); // uso único
      const on = this.connected(t.accountId);
      if (b.endSessionsOf) { const d = this.devices.get(b.endSessionsOf); if (d && d.accountId === t.accountId) d.session = null; }
      if (!b.endSessionsOf && on.length >= this.sessionLimit) {
        this.idTokens.set(b.idToken, t); // o pedido recusado não gasta o token
        return { fail: [409, 'session_limit', { devices: on.map((d) => ({ id: d.id, name: d.name, lastSeenAt: d.lastSeenAt })) }] };
      }
      crypto.createPublicKey({ key: Buffer.from(b.publicKey, 'base64'), format: 'der', type: 'spki' });
      const d: Device = { id: `dev_${hex(16)}`, accountId: t.accountId, name: String(b.name), publicKey: b.publicKey, syncPublicKey: b.syncPublicKey, challenge: hex(24), status: 'pending', session: null, lastSeenAt: new Date().toISOString() };
      this.devices.set(d.id, d);
      return { json: { deviceId: d.id, challenge: d.challenge, accountId: t.accountId } };
    }
    if (key === 'POST /v1/devices/confirm') {
      const d = this.devices.get(b.deviceId);
      if (!d || d.status !== 'pending') return { fail: [400, 'invalid_device'] };
      const pub = crypto.createPublicKey({ key: Buffer.from(d.publicKey, 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(d.challenge), pub, Buffer.from(String(b.signature), 'base64'))) return { fail: [401, 'bad_signature'] };
      d.status = 'active'; d.session = `ses_${hex(24)}`;
      return { json: { sessionToken: d.session } };
    }
    // ---------------------------------------------------------------- nuvem: partida do contêiner (token de partida, sem sessão)
    if (p.startsWith('/v1/cloud/boot') && method === 'POST') {
      const c = [...this.clouds.entries()].find(([, x]) => x.bootToken === b.bootToken);
      if (!c) return { fail: [401, 'boot_token'] };
      const [sws, cl] = c; const w = this.workspaces.get(sws)!;
      if (p === '/v1/cloud/boot/vault') return { json: { vaultKey: cl.vaultKey } };
      if (p === '/v1/cloud/boot/key') { if (cl.vaultKey && b.replace !== true) return { fail: [409, 'key_exists'] }; cl.vaultKey = String(b.key); return { json: { ok: true } }; }
      if (p === '/v1/cloud/boot/state') { cl.states.push(b.detail ? `${b.state}: ${b.detail}` : String(b.state)); return { json: { ok: true } }; }
      if (p === '/v1/cloud/boot') {
        crypto.createPublicKey({ key: Buffer.from(b.publicKey, 'base64'), format: 'der', type: 'spki' });
        // um aparelho-nuvem por workspace: o de antes (disco novo) é revogado
        if (cl.deviceId) { const antes = this.devices.get(cl.deviceId); if (antes) { antes.status = 'revoked'; antes.session = null; } }
        const d: Device = { id: `dev_${hex(16)}`, accountId: w.owner, name: 'Ergon World (nuvem)', publicKey: b.publicKey, syncPublicKey: b.syncPublicKey, challenge: hex(24), status: 'pending', session: null, lastSeenAt: new Date().toISOString(), kind: 'cloud', cloudWs: sws } as Device;
        this.devices.set(d.id, d); cl.deviceId = d.id;
        return { json: { deviceId: d.id, challenge: d.challenge, accountId: w.owner, workspaceId: sws, label: w.label, accountEmail: this.accounts.get(w.owner)?.email ?? null, vaultKey: cl.vaultKey } };
      }
    }
    // daqui em diante, só com a sessão de um aparelho
    const dev = this.session(bearer);
    if (key === 'GET /v1/compat') return { json: { api: 'v1', version: 'fake', features: this.features, extra: { ignored: true } } };
    if (key === 'GET /v1/catalog') return { json: { dracmaIssue: '1', items: [{ sku: 'world_pro', kind: 'plan', name: 'Pro', priceCents: '4900', sellable: true, tier: 'pro', interval: 'month', people: 3, jobSlots: 5, monthlyDracmas: '1000' }] } };
    if (key === 'GET /v1/marketplace/items') {
      const q = (u.searchParams.get('search') ?? '').toLowerCase(); const kind = u.searchParams.get('kind');
      const list = [...this.mkItems.values()].filter((i) => i.status === 'published' && (!kind || i.kind === kind) && (!q || `${i.title} ${i.summary}`.toLowerCase().includes(q)));
      return { json: list.map((i) => { const c = this.creators.get(i.creator); const off = i.creator === 'oficial' || !!c?.official;
        return { id: i.id, packageId: i.packageId, kind: i.kind, title: i.title, summary: i.summary, priceCents: '0', version: i.latest, creator: off ? 'Ergon' : c?.displayName ?? '', official: off, badge: off ? 'Oficial' : 'Comunidade',
          verified: !!i.versions.find((v) => v.version === i.latest)?.verified }; }) };
    }
    if (key === 'GET /v1/marketplace/download') {
      const [itemId, version, accountId, exp] = Buffer.from(u.searchParams.get('token') ?? '', 'base64url').toString('utf8').split('|');
      if (Number(exp) < Date.now() / 1000) return { fail: [401, 'token'] };
      const i = this.mkItems.get(itemId); const v = i?.versions.find((x) => x.version === version);
      if (!i || !v || i.status !== 'published' || v.status !== 'approved' || !this.licenses.has(`${accountId}|${itemId}`)) return { fail: [404, 'item'] };
      return { raw: v.artifact, headers: { 'x-sha256': v.sha256 } };
    }
    // Ergon AI: a credencial curta abre só a lista de modelos (o proxy de verdade é outro serviço)
    if (key === 'GET /v1/ai/models' && bearer && this.aiTokens.has(bearer)) return { json: { data: this.aiModels } };
    if (!dev) return { fail: [401, 'unauthenticated'] };
    dev.lastSeenAt = new Date().toISOString();
    const acc = this.accounts.get(dev.accountId)!;
    /** o papel da conta no workspace (o dono pode ter o papel trocado nos testes por roles) */
    const roleIn = (w: Workspace, accountId: string): Role | null => (w.owner === accountId ? (this.roles.get(accountId) as Role | undefined) ?? 'owner' : w.members?.get(accountId)?.role ?? null);
    const mine = (id: string | null) => { const w = id ? this.workspaces.get(id) : undefined; return w && roleIn(w, acc.id) ? w : null; };
    const owned = (id: string | null) => { const w = id ? this.workspaces.get(id) : undefined; return w && w.owner === acc.id ? w : null; };
    // e-mail confirmado antes de criar ou comprar (docs/CONTRATO_PUBLICO.md); ligado nos testes que pedem
    if (this.requireVerifiedEmail && !acc.emailVerified && method === 'POST') {
      const criar = ['/v1/billing/checkout', '/v1/sync/workspaces', '/v1/sync/invites/accept', '/v1/marketplace/creators', '/v1/marketplace/items'].includes(p)
        || /^\/v1\/sync\/workspaces\/sws_[a-f0-9]{32}\/invites$/.test(p) || /^\/v1\/marketplace\/items\/[^/]+\/submit$/.test(p);
      // usar: dispensa quem já é membro de um workspace com plano vigente
      const usar = p === '/v1/ai/credentials' && ![...this.workspaces.values()].some((w) => w.plan && roleIn(w, acc.id));
      if (criar || usar) return { fail: [403, 'email_unverified', { message: 'Confirme o seu e-mail para continuar.' }] };
    }
    // ---------------------------------------------------------------- nuvem: estado, posse do computador, o que o contêiner conta
    if (key === 'GET /v1/cloud') {
      const sws = u.searchParams.get('workspace'); const cl = sws ? this.clouds.get(sws) : undefined;
      if (!mine(sws)) return { fail: [404, 'not_found'] };
      return { json: { active: !!cl, appState: cl?.states.at(-1) ?? null, relayStandby: cl?.relay ?? null, runtime: cl ? 'rodando' : null } };
    }
    if (key === 'POST /v1/cloud/presence') {
      const cl = this.clouds.get(b.workspaceId);
      if (!mine(b.workspaceId) || !cl) return { fail: [409, 'no_cloud'] };
      if ((dev as Device & { kind?: string }).kind !== 'cloud') cl.presence.push(b.open !== false);
      return { json: { ok: true, pcHoldsForSeconds: 120 } };
    }
    if (key === 'POST /v1/cloud/app-state') {
      const d = dev as Device & { kind?: string; cloudWs?: string }; const cl = d.cloudWs ? this.clouds.get(d.cloudWs) : undefined;
      if (d.kind !== 'cloud' || !cl) return { fail: [403, 'not_cloud'] };
      cl.states.push(b.detail ? `${b.state}: ${b.detail}` : String(b.state)); cl.active = b.active === true;
      if (typeof b.relayInstallationId === 'string') cl.relay = b.relayInstallationId;
      return { json: { ok: true } };
    }
    if (key === 'POST /v1/ai/credentials') {
      if (!mine(b.workspaceId)) return { fail: [404, 'sync_workspace'] };
      const token = `eai_${hex(16)}`; this.aiTokens.add(token);
      return { json: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
    }
    if (key === 'POST /v1/bindings') { this.bindings.push({ accountId: acc.id, localPersonId: b.localPersonId }); return { json: { ok: true } }; }
    if (key === 'POST /v1/authorize') {
      const workspaces = [...this.workspaces.values()].filter((w) => roleIn(w, acc.id) && !this.deactivated.has(w.id)).map((w) => ({ workspaceId: w.id, label: w.label, role: roleIn(w, acc.id), status: w.plan ? 'active' : 'none', plan_sku: w.plan, source: w.plan ? w.source ?? 'stripe' : null }));
      return { json: { authorizedUntil: new Date(Date.now() + 900_000).toISOString(), account: { email: acc.email, emailVerified: acc.emailVerified }, workspaces } };
    }
    if (key === 'GET /v1/devices') return { json: [...this.devices.values()].filter((d) => d.accountId === acc.id && d.status !== 'pending').map((d) => ({ id: d.id, name: d.name, status: d.status, current: d === dev, connected: !!d.session, lastSeenAt: d.lastSeenAt })) };
    let m = /^\/v1\/devices\/(dev_[a-f0-9]{32})$/.exec(p);
    if (m && method === 'DELETE') { const d = this.devices.get(m[1]); if (!d || d.accountId !== acc.id) return { fail: [404, 'not_found'] }; d.status = 'revoked'; d.session = null; return { json: { ok: true } }; }
    m = /^\/v1\/devices\/(dev_[a-f0-9]{32})\/end-sessions$/.exec(p);
    if (m && method === 'POST') { const d = this.devices.get(m[1]); if (d && d.accountId === acc.id) d.session = null; return { json: { ok: true } }; }
    // ---------------------------------------------------------------- plano, créditos e Jobs (respostas do servidor)
    if (key === 'GET /v1/billing/state') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] };
      const role = roleIn(w, acc.id); const own = w.owner === acc.id;
      const tier = w.plan ? w.plan.replace(/^world_/, '').replace(/_annual$/, '') : null;
      return { json: { workspaceId: w.id, role: own ? 'owner' : role, entitlement: { status: w.plan ? 'active' : 'none', plan_sku: w.plan, tier, people: this.seatsOf(w), job_slots: w.plan ? SLOTS[tier!] ?? 5 : 0, effective_until: null, grace_until: null, source: w.plan ? w.source ?? 'stripe' : null,
        ...(w.nextGrantAt !== undefined ? { next_grant_at: w.nextGrantAt } : {}) }, seatsUsed: this.used(w),
        subscription: own && w.sub ? { status: 'active', plan: w.plan, periodEnd: null, cancelAt: null, currency: w.currency ?? 'brl' } : null, items: own ? w.sub?.items ?? [] : [], invoices: [] } };
    }
    if (key === 'GET /v1/wallet/statement') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] };
      // páginas como no World: ?limit= (até 200) e ?cursor= (o id da última linha da página anterior)
      const all = [...(w.statement ?? [])].reverse(); const lim = Math.min(Math.max(Number(u.searchParams.get('limit') ?? 50) || 50, 1), 200);
      const cur = u.searchParams.get('cursor'); const from = cur ? all.findIndex((x) => x.id === cur) + 1 : 0;
      const page = all.slice(from, from + lim);
      return { json: { next: from + lim < all.length ? page.at(-1)!.id : null, entries: page } };
    }
    if (key === 'POST /v1/billing/checkout') {
      const w = owned(b.workspaceId); if (!w) return { fail: [404, 'not_found'] };
      // plano com vagas adicionais (seats) e pacotes de Jobs (jobPacks) numa assinatura só; recarga é pagamento à parte
      const sku = String(b.sku ?? ''); const extra = [b.seats, b.jobPacks].filter((x) => x !== undefined && x !== null);
      if (extra.some((x) => !Number.isInteger(x) || x < 0 || x > 1000)) return { fail: [400, 'addon'] };
      if (!sku.startsWith('world_') && extra.some((x) => x > 0)) return { fail: [400, 'addon', { message: 'pessoas e Jobs vão junto de um plano' }] };
      if (sku.startsWith('world_') && w.sub) return { fail: [409, 'has_subscription'] };
      const items = [{ sku, quantity: 1 }, ...this.addons(sku, b.seats ?? 0, b.jobPacks ?? 0)];
      this.checkouts.push({ ws: w.id, items });
      return { json: { url: `https://checkout.stripe.com/c/pay/cs_test_${hex(8)}?ws=${w.id}&sku=${items.map((i) => `${i.sku}x${i.quantity}`).join(',')}` } };
    }
    if (key === 'POST /v1/billing/change/preview' || key === 'POST /v1/billing/change/confirm') {
      const w = owned(b.workspaceId); if (!w) return { fail: [404, 'sync_workspace'] };
      if (!w.sub) return { fail: [409, 'no_subscription'] };
      const cur = (pre: string) => w.sub!.items.find((i) => i.sku.startsWith(pre))?.quantity ?? 0;
      const plan = typeof b.plan === 'string' ? b.plan : w.plan; const seats = b.seats ?? cur('addon_seat_'); const jobPacks = b.jobPacks ?? cur('addon_jobs_5');
      if (plan === w.plan && seats === cur('addon_seat_') && jobPacks === cur('addon_jobs_5')) return { fail: [400, 'no_change'] };
      const upgrade = plan !== w.plan || seats > cur('addon_seat_') || jobPacks > cur('addon_jobs_5');
      if (key.endsWith('preview')) return { json: { upgrade, prorationDate: 1_700_000_000, amountDueCents: upgrade ? '2490' : '0', currency: 'brl', effective: upgrade ? 'agora, depois do pagamento confirmado' : 'no próximo ciclo (o período atual já foi pago)' } };
      if (typeof b.idempotencyKey !== 'string' || !Number.isInteger(b.prorationDate)) return { fail: [400, 'invalid'] };
      // os adicionais acompanham o período do plano (mensal ou anual), como no World
      w.plan = plan; w.sub.items = [{ sku: String(plan), quantity: 1 }, ...this.addons(String(plan), seats, jobPacks)];
      w.seats = 3 + seats;
      return { json: { upgrade, status: 'active', pendingUpdate: false } };
    }
    if (key === 'PUT /v1/wallet/autotopup') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] };
      if (roleIn(w, acc.id) !== 'owner') return { fail: [403, 'not_owner'] };
      if (typeof b.enabled !== 'boolean') return { fail: [400, 'invalid'] };
      if (b.enabled && (!b.topupSku || !(b.monthlyCapCents >= 1990) || !(b.thresholdDracmas >= 1))) return { fail: [400, 'recharge_policy'] };
      w.autotopup = { ...b }; return { json: { ok: true } };
    }
    m = /^\/v1\/workspaces\/(sws_[a-f0-9]{32})\/budgets(?:\/(acc_[a-f0-9]{32}))?$/.exec(p);
    if (m) {
      const w = mine(m[1]); if (!w) return { fail: [404, 'sync_workspace'] };
      const manager = RANK[roleIn(w, acc.id)!] >= RANK.admin; w.budgets ??= new Map();
      if (method === 'GET') {
        const all = [[w.owner, 'owner'] as const, ...[...(w.members ?? new Map()).entries()].map(([id, x]) => [id, x.role] as const)].filter(([id]) => manager || id === acc.id);
        return { json: { manager, period: 'mês-calendário (horário de Salvador)', members: all.map(([id, role]) => ({ accountId: id, role, name: this.accounts.get(id)?.displayName || null, email: this.accounts.get(id)?.email ?? null, me: id === acc.id, cap: w.budgets!.get(id) ?? null, used: '0.000000' })) } };
      }
      if (method === 'PUT' && m[2]) {
        if (!manager) return { fail: [403, 'sync_forbidden'] };
        if (!roleIn(w, m[2])) return { fail: [404, 'sync_workspace'] };
        w.budgets.set(m[2], b.capDracmas === null ? null : `${Number(b.capDracmas).toFixed(6)}`);
        this.registrar(w.id, 'budget.set', acc.id, m[2], { cap: w.budgets.get(m[2]) ?? 'livre' });
        return { json: { ok: true, cap: w.budgets.get(m[2]) } };
      }
    }
    if (key === 'GET /v1/wallet') { const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] }; return { json: { available: w.balance ?? (w.plan ? '1000.000000' : '0.000000'), reserved: '0.000000', lots: [] } }; }
    // os Jobs do mês no workspace (aditivo pedido ao World): quantos, quantos terminaram bem, falharam e foram recuperados
    if (key === 'GET /v1/jobs/stats') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'sync_workspace'] };
      const since = Date.parse(u.searchParams.get('since') ?? '') || 0;
      const js = [...this.hjobs.values()].filter((j) => j.ws === w.id && Date.parse(j.queuedAt) >= since && !j.recoveryOf);
      const fim = (j: HJob): HJob => { let x = j; while (x.recoveredBy && this.hjobs.get(x.recoveredBy)) x = this.hjobs.get(x.recoveredBy)!; return x; };
      return { json: { since: new Date(since).toISOString(), total: js.length, succeeded: js.filter((j) => fim(j).state === 'succeeded').length, failed: js.filter((j) => fim(j).state === 'failed').length, recovered: js.filter((j) => !!j.recoveredBy && fim(j).state === 'succeeded').length } };
    }
    // o registro do workspace (aditivo pedido ao World): só quem administra; nomes das pessoas, nunca e-mails de quem não é membro
    m = /^\/v1\/workspaces\/(sws_[a-f0-9]{32})\/activity$/.exec(p);
    if (m && method === 'GET') {
      const w = mine(m[1]); if (!w) return { fail: [404, 'sync_workspace'] };
      if (RANK[roleIn(w, acc.id)!] < RANK.admin) return { fail: [403, 'sync_forbidden'] };
      const lim = Math.min(Math.max(Number(u.searchParams.get('limit') ?? 50) || 50, 1), 100);
      const quem = (id: string | null) => (id ? { accountId: id, name: this.accounts.get(id)?.displayName || null } : null);
      return { json: { entries: [...(w.activity ?? [])].reverse().slice(0, lim).map((x) => ({ id: x.id, at: x.at, action: x.action, actor: quem(x.actor), target: quem(x.target), detail: x.detail })) } };
    }
    if (key === 'GET /v1/jobs') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] };
      const jobs = [...this.hjobs.values()].filter((j) => j.ws === w.id && !TERMINAL.includes(j.state)).map((j) => ({ id: j.id, state: j.state, routineRef: j.routineRef, queuedAt: j.queuedAt, startedAt: null, mine: j.accountId === acc.id }));
      return { json: { slots: w.plan ? 5 : 0, running: jobs.filter((j) => j.state === 'running').length, jobs } };
    }
    m = /^\/v1\/workspaces\/(sws_[a-f0-9]{32})\/job-policy$/.exec(p);
    if (m) {
      const w = mine(m[1]); if (!w) return { fail: [404, 'sync_workspace'] };
      if (method === 'GET') return { json: { recovery: this.policies.get(w.id) ?? true, recoveryRounds: 3 } };
      if (method === 'PUT') {
        if (typeof b.recovery !== 'boolean') return { fail: [400, 'policy'] };
        if (!['owner', 'admin'].includes(this.roles.get(acc.id) ?? 'owner')) return { fail: [403, 'sync_forbidden'] };
        this.policies.set(w.id, b.recovery);
        this.registrar(w.id, 'jobs.policy', acc.id, null, { recovery: String(b.recovery) });
        return { json: { recovery: b.recovery, recoveryRounds: 3 } };
      }
    }
    const mk = this.marketRoutes(method, p, b, acc.id);
    if (mk) return mk;
    const handoff = this.handoffRoutes(method, p, u, b, dev, acc.id, mine);
    if (handoff) return handoff;
    // ---------------------------------------------------------------- Sync: o World guarda envelopes e mudanças cifradas
    if (key === 'POST /v1/sync/workspaces') {
      if (b.label !== undefined && (typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length > 60)) return { fail: [400, 'label'] };
      const w: Workspace = { id: `sws_${hex(16)}`, owner: acc.id, label: typeof b.label === 'string' ? b.label.trim() : null, plan: null, head: 0, changes: [], envelopes: new Map(), recovery: null };
      this.workspaces.set(w.id, w);
      return { json: { workspaceId: w.id, keyVersion: 1 } };
    }
    if (key === 'GET /v1/plans') return { json: { plans: [] } };
    m = /^\/v1\/sync\/workspaces\/(sws_[a-f0-9]{32})\/deactivate$/.exec(p);
    if (m && method === 'POST') { const w = mine(m[1]); if (!w) return { fail: [404, 'sync_workspace'] }; this.deactivated.add(w.id); return { json: { ok: true } }; }
    m = /^\/v1\/sync\/workspaces\/(sws_[a-f0-9]{32})\/label$/.exec(p);
    if (m && method === 'PUT') {
      const w = mine(m[1]); if (!w) return { fail: [404, 'sync_workspace'] };
      if (typeof b.label !== 'string' || !b.label.trim() || b.label.trim().length > 60) return { fail: [400, 'label'] };
      w.label = b.label.trim(); return { json: { label: w.label } };
    }
    const members = this.memberRoutes(method, p, b, acc.id, roleIn);
    if (members) return members;
    m = /^\/v1\/sync\/workspaces\/(sws_[a-f0-9]{32})\/(envelopes|envelope|devices-needing-key|changes)$/.exec(p);
    if (m) {
      const w = mine(m[1]); if (!w) return { fail: [404, 'not_found'] };
      const role = roleIn(w, acc.id)!; const kv = w.keyVersion ?? 1;
      if (m[2] === 'envelopes' && method === 'PUT') {
        if (b.keyVersion !== kv) return { fail: [409, 'key_version'] };
        if (b.kind === 'recovery') { w.recovery = { keyVersion: b.keyVersion, wrapped: b.wrapped }; (w.recoveries ??= new Map()).set(acc.id, w.recovery); }
        else {
          const d = this.devices.get(b.deviceId); if (!d || d.status !== 'active') return { fail: [400, 'invalid_device'] };
          // para aparelho de outra pessoa: só quem administra, e só para membro atual
          if (d.accountId !== acc.id && (RANK[role] < RANK.admin || !roleIn(w, d.accountId))) return { fail: [403, 'sync_forbidden'] };
          w.envelopes.set(d.id, { keyVersion: b.keyVersion, wrapped: b.wrapped });
        }
        return { json: { ok: true } };
      }
      if (m[2] === 'envelope') {
        // só a versão atual da chave (world/src/sync.ts myEnvelope): depois de um giro, o envelope velho não serve
        const e = u.searchParams.get('kind') === 'recovery' ? (w.recoveries?.get(acc.id) ?? (w.owner === acc.id ? w.recovery : null)) : w.envelopes.get(dev.id);
        return e && e.keyVersion === kv ? { json: e } : { fail: [404, 'no_envelope'] };
      }
      if (m[2] === 'devices-needing-key') {
        const admin = RANK[role] >= RANK.admin;
        const devices = [...this.devices.values()].filter((d) => (d.accountId === acc.id || (admin && roleIn(w, d.accountId))) && d.status === 'active' && w.envelopes.get(d.id)?.keyVersion !== kv && ((d as Device & { kind?: string; cloudWs?: string }).kind !== 'cloud' || (d as Device & { cloudWs?: string }).cloudWs === w.id)).map((d) => ({ deviceId: d.id, accountId: d.accountId, syncPublicKey: d.syncPublicKey }));
        return { json: { keyVersion: kv, devices } };
      }
      if (m[2] === 'changes' && method === 'POST') {
        if (!w.plan) return { fail: [402, 'world_inactive'] };
        if (RANK[role] < RANK[b.kind === 'rotation' ? 'admin' : 'editor']) return { fail: [403, 'sync_forbidden'] };
        if (b.kind === 'rotation') { if (b.keyVersion !== kv + 1) return { fail: [409, 'key_version'] }; }
        else {
          if (w.rotationRequired) return { fail: [409, 'rotation_required'] };
          if (b.keyVersion !== kv) return { fail: [409, 'key_version'] };
        }
        if (b.expectedVersion !== w.head) return { fail: [409, 'version_conflict'] };
        // o World confere quem assinou (o envelope canônico), sem conseguir abrir o conteúdo
        const canon = `ergon-sync-v1|${w.id}|${b.expectedVersion}|${b.operationId}|${b.schemaVersion}|${b.keyVersion}|${b.kind}|${b.sha256}`;
        const pub = crypto.createPublicKey({ key: Buffer.from(dev.publicKey, 'base64'), format: 'der', type: 'spki' });
        if (!crypto.verify(null, Buffer.from(canon), pub, Buffer.from(String(b.signature), 'base64'))) return { fail: [400, 'bad_signature'] };
        if (crypto.createHash('sha256').update(Buffer.from(b.ciphertext, 'base64')).digest('hex') !== b.sha256) return { fail: [400, 'bad_hash'] };
        w.head += 1;
        w.changes.push({ version: w.head, operationId: b.operationId, keyVersion: b.keyVersion, schemaVersion: b.schemaVersion, kind: b.kind, ciphertext: b.ciphertext, nonce: b.nonce, deviceId: dev.id });
        if (b.kind === 'rotation') { w.keyVersion = b.keyVersion; w.rotationRequired = false; this.rotations.push({ ws: w.id, keyVersion: b.keyVersion, by: acc.id }); }
        return { json: { version: w.head } };
      }
      if (m[2] === 'changes' && method === 'GET') {
        const since = Number(u.searchParams.get('since') ?? 0);
        return { json: { head: w.head, keyVersion: kv, changes: w.changes.filter((c) => (c.version as number) > since).slice(0, 50) } };
      }
    }
    return { fail: [404, 'not_found'] };
  }

  private marketRoutes(method: string, p: string, b: any, me: string): { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] } | null {
    if (method === 'POST' && p === '/v1/marketplace/creators') {
      if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(b.namespace)) || b.namespace === 'oficial') return { fail: [400, 'namespace'] };
      if ([...this.creators.entries()].some(([a, c]) => a !== me && c.namespace === b.namespace)) return { fail: [409, 'namespace_taken'] };
      this.creators.set(me, { namespace: b.namespace, displayName: String(b.displayName ?? '').slice(0, 60), official: false });
      return { json: { namespace: b.namespace } };
    }
    if (method === 'GET' && p === '/v1/marketplace/mine') {
      const c = this.creators.get(me);
      return { json: { creator: c ? { namespace: c.namespace, displayName: c.displayName } : null, items: [...this.mkItems.values()].filter((i) => i.creator === me).map((i) => ({
        id: i.id, packageId: i.packageId, kind: i.kind, title: i.title, summary: i.summary, status: i.status, latestVersion: i.latest,
        versions: i.versions.map((v) => ({ version: v.version, status: v.status, verified: v.verified, createdAt: v.createdAt, ...(v.reason ? { reason: v.reason } : {}) })) })) } };
    }
    if (method === 'POST' && p === '/v1/marketplace/items') {
      if (![undefined, null, 0, '0'].includes(b.priceCents)) return { fail: [400, 'free_only'] };
      const c = this.creators.get(me); if (!c) return { fail: [403, 'creator'] };
      let pk; try { pk = validatePackage(Buffer.from(String(b.artifactB64 ?? ''), 'base64')); } catch (e) { return { fail: [400, 'package_invalid', { detail: String(e) }] }; }
      if (!pk.manifest.package_id.startsWith(`comunidade.${c.namespace}.`)) return { fail: [400, 'package_id'] };
      let i = [...this.mkItems.values()].find((x) => x.packageId === pk.manifest.package_id);
      if (i && i.creator !== me) return { fail: [403, 'package_owner'] };
      if (!i) { i = { id: `itm_${hex(12)}`, packageId: pk.manifest.package_id, kind: pk.manifest.kind, title: pk.manifest.title, summary: pk.manifest.summary, creator: me, status: 'draft', latest: null, versions: [] }; this.mkItems.set(i.id, i); }
      if (i.versions.some((v) => v.version === pk.manifest.version)) return { fail: [409, 'version_exists'] };
      i.versions.push({ version: pk.manifest.version, artifact: Buffer.from(String(b.artifactB64), 'base64'), sha256: pk.sha256, verified: pk.verified, status: 'pending', createdAt: new Date().toISOString() });
      return { json: { itemId: i.id, version: pk.manifest.version, verified: pk.verified } };
    }
    const m = /^\/v1\/marketplace\/items\/(itm_[A-Za-z0-9]+)\/(submit|acquire|download-token)$/.exec(p);
    if (m && method === 'POST') {
      const i = this.mkItems.get(m[1]); if (!i) return { fail: [404, 'item'] };
      if (m[2] === 'submit') { if (i.creator !== me) return { fail: [404, 'item'] }; i.status = 'in_review'; return { json: { status: 'in_review' } }; }
      if (i.status !== 'published') return { fail: [404, 'item'] };
      if (m[2] === 'acquire') { this.licenses.add(`${me}|${i.id}`); return { json: { licensed: true, checkoutUrl: null } }; }
      if (!this.licenses.has(`${me}|${i.id}`)) return { fail: [403, 'license'] };
      const exp = Math.floor(Date.now() / 1000) + 300;
      return { json: { token: Buffer.from(`${i.id}|${i.latest}|${me}|${exp}`).toString('base64url'), expiresAt: new Date(exp * 1000).toISOString() } };
    }
    return null;
  }

  /** vagas e pacotes de Jobs no período do plano: no anual, os skus _annual (world/src/catalog.ts) */
  private addons(plan: string, seats: number, jobPacks: number): Array<{ sku: string; quantity: number }> {
    const annual = plan.endsWith('_annual'); const tier = plan.replace(/^world_/, '').replace(/_annual$/, ''); const sfx = annual ? '_annual' : '';
    return [...(seats ? [{ sku: `addon_seat_${tier}${sfx}`, quantity: seats }] : []), ...(jobPacks ? [{ sku: `addon_jobs_5${sfx}`, quantity: jobPacks }] : [])];
  }
  private seatsOf(w: Workspace): number { return w.plan ? w.seats ?? 3 : 0; }
  private pending(w: Workspace) { return (w.invites ?? []).filter((i) => !i.accepted && i.expiresAt > Date.now()); }
  private used(w: Workspace): number { return 1 + (w.members?.size ?? 0) + this.pending(w).length; }

  // ---------------------------------------------------------------- pessoas no workspace (mesmas regras de world/src/sync.ts)
  private memberRoutes(method: string, p: string, b: any, me: string, roleIn: (w: Workspace, a: string) => Role | null): { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] } | null {
    if (method === 'POST' && p === '/v1/sync/invites/accept') {
      const t = typeof b.token === 'string' ? sha(b.token) : '';
      const w = [...this.workspaces.values()].find((x) => this.pending(x).some((i) => i.tokenHash === t));
      const inv = w && this.pending(w).find((i) => i.tokenHash === t);
      if (!w || !inv) return { fail: [404, 'invite'] };
      if (!w.plan) return { fail: [402, 'world_inactive'] };
      if (1 + (w.members?.size ?? 0) >= this.seatsOf(w) && !roleIn(w, me)) return { fail: [409, 'seats'] };
      inv.accepted = true;
      if (w.owner !== me) (w.members ??= new Map()).set(me, { role: inv.role as 'editor', since: new Date().toISOString() });
      this.registrar(w.id, 'sync.member.join', me, null, { role: inv.role });
      return { json: { workspaceId: w.id, role: inv.role } };
    }
    const m = /^\/v1\/sync\/workspaces\/(sws_[a-f0-9]{32})\/(members|invites|transfer)(?:\/([A-Za-z0-9_]+))?(\/role)?$/.exec(p);
    if (!m) return null;
    const w = this.workspaces.get(m[1]); const my = w ? roleIn(w, me) : null;
    if (!w || !my) return { fail: [404, 'sync_workspace'] };
    const admin = RANK[my] >= RANK.admin; const sub = m[3];
    if (m[2] === 'members' && method === 'GET' && !sub) {
      const rows = [{ id: w.owner, role: 'owner', since: '2026-01-01T00:00:00.000Z' }, ...[...(w.members ?? new Map()).entries()].map(([id, x]) => ({ id, role: x.role, since: x.since }))];
      return { json: { myRole: my, seats: this.seatsOf(w),
        members: rows.map((r) => ({ accountId: r.id, name: this.accounts.get(r.id)?.displayName || null, email: admin || r.id === me ? this.accounts.get(r.id)?.email ?? null : null, role: r.role, since: r.since, me: r.id === me })),
        invites: admin ? this.pending(w).map((i) => ({ id: i.id, role: i.role, expiresAt: new Date(i.expiresAt).toISOString(), createdAt: i.createdAt })) : [] } };
    }
    if (m[2] === 'invites' && method === 'POST' && !sub) {
      if (!admin) return { fail: [403, 'sync_forbidden'] };
      if (!w.plan) return { fail: [402, 'world_inactive'] };
      if (this.used(w) >= this.seatsOf(w)) return { fail: [409, 'seats'] };
      const role = ['admin', 'editor', 'viewer'].includes(b.role) ? b.role : 'editor';
      const token = crypto.randomBytes(24).toString('base64url'); const expiresAt = Date.now() + 7 * 86_400_000;
      (w.invites ??= []).push({ id: `inv_${hex(16)}`, role, tokenHash: sha(token), expiresAt, createdAt: new Date().toISOString(), accepted: false });
      return { json: { token, expiresAt: new Date(expiresAt).toISOString() } };
    }
    if (m[2] === 'invites' && method === 'DELETE' && sub) {
      if (!admin) return { fail: [403, 'sync_forbidden'] };
      const i = this.pending(w).find((x) => x.id === sub); if (!i) return { fail: [404, 'invite'] };
      i.expiresAt = Date.now() - 1; return { json: { ok: true } };
    }
    if (m[2] === 'members' && sub && m[4] && method === 'PUT') {
      if (!['admin', 'editor', 'viewer'].includes(b.role)) return { fail: [400, 'role'] };
      if (!admin) return { fail: [403, 'sync_forbidden'] };
      const target = roleIn(w, sub); if (!target) return { fail: [404, 'sync_workspace'] };
      if (target === 'owner' || sub === w.owner) return { fail: [409, 'owner'] };
      if (my !== 'owner' && (target === 'admin' || b.role === 'admin')) return { fail: [403, 'sync_forbidden'] };
      w.members!.get(sub)!.role = b.role; this.registrar(w.id, 'sync.member.role', me, sub, { role: b.role }); return { json: { role: b.role } };
    }
    if (m[2] === 'members' && sub && !m[4] && method === 'DELETE') {
      if (!admin) return { fail: [403, 'sync_forbidden'] };
      if (sub === w.owner) return { fail: [409, 'owner'] };
      if (!roleIn(w, sub)) return { fail: [404, 'sync_workspace'] };
      w.members!.delete(sub);
      for (const d of this.devices.values()) if (d.accountId === sub) w.envelopes.delete(d.id);
      w.recoveries?.delete(sub);
      this.registrar(w.id, 'sync.member.remove', me, sub);
      w.rotationRequired = true; return { json: { ok: true } };
    }
    if (m[2] === 'transfer' && !sub && method === 'POST') {
      if (my !== 'owner' || w.owner !== me) return { fail: [403, 'sync_forbidden'] };
      const to = String(b.toAccountId ?? ''); if (!w.members?.has(to)) return { fail: [404, 'sync_workspace'] };
      w.members.delete(to); w.members.set(me, { role: 'admin', since: new Date().toISOString() }); w.owner = to;
      return { json: { ok: true } };
    }
    return { fail: [404, 'not_found'] };
  }

  // ---------------------------------------------------------------- "Rodar na nuvem" (mesmas regras de world/src/handoffs.ts)
  private handoffRoutes(method: string, p: string, u: URL, b: any, dev: Device, accountId: string, mine: (id: string | null) => Workspace | null): { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] } | null {
    type Out = { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] };
    const plan = (ws: unknown): Workspace | Out => {
      const w = mine(typeof ws === 'string' ? ws : null);
      if (!w) return { fail: [404, 'sync_workspace'] };
      if (!w.plan) return { fail: [402, 'jobs_not_in_plan'] };
      return w;
    };
    const isOut = (x: Workspace | Out): x is Out => 'fail' in x;
    const owner = (ws: string, card: string) => this.owners.get(`${ws}|${card}`) ?? null;
    const holdLocal = (ws: string, card: string, expected?: number) => {
      const o = owner(ws, card);
      if (!o) { this.owners.set(`${ws}|${card}`, { holder: 'local', deviceId: dev.id, generation: 1, leaseUntil: Date.now() + this.leaseMs, jobId: null }); return { ok: true, generation: 1, holder: 'local' }; }
      if (o.holder === 'local' && o.deviceId === dev.id && (expected === undefined || expected === o.generation)) { o.leaseUntil = Date.now() + this.leaseMs; return { ok: true, generation: o.generation, holder: 'local' }; }
      if (o.holder === 'local' && o.deviceId !== dev.id && o.leaseUntil <= Date.now() && expected === undefined) { o.deviceId = dev.id; o.generation += 1; o.leaseUntil = Date.now() + this.leaseMs; return { ok: true, generation: o.generation, holder: 'local' }; }
      return { ok: false, generation: o.generation, holder: o.holder === 'world' ? 'world' : 'other_device', jobId: o.jobId };
    };
    const view = (h: Handoff) => {
      const o = owner(h.ws, h.card);
      // com o protocolo de recuperação, segue a rodada mais recente
      const jobId = (o?.holder === 'world' && o.jobId) || h.jobId; const j = jobId ? this.hjobs.get(jobId) : null;
      return { handoffId: h.id, workspaceId: h.ws, cardRef: h.card, status: h.status, reason: h.reason, jobId, jobState: j?.state ?? null, recoveryRound: j?.recoveryRound ?? 0, owner: o ? { holder: o.holder, generation: o.generation } : null, futureField: 'ignorado' };
    };
    const mineH = (id: string) => { const h = this.handoffs.get(id); return h && h.accountId === accountId ? h : null; };
    if (method === 'POST' && p === '/v1/jobs/handoffs/prepare') {
      const w = plan(b.workspaceId); if (isOut(w)) return w;
      if (typeof b.cardRef !== 'string' || !CARD_RE.test(b.cardRef)) return { fail: [400, 'card_ref'] };
      if (typeof b.intentKey !== 'string' || !/^[A-Za-z0-9_:.-]{8,80}$/.test(b.intentKey)) return { fail: [400, 'intent_key'] };
      const intent = `${accountId}:${b.intentKey}`;
      const prev = [...this.handoffs.values()].find((h) => h.intent === intent);
      if (prev) return { json: view(prev) };
      if (b.cardState === 'running_local') return { fail: [409, 'checkpoint_required'] };
      if (!['queued_local', 'waiting_external', 'waiting_user'].includes(b.cardState)) return { fail: [409, 'not_portable'] };
      if (!this.adapters.includes(b.adapter)) return { fail: [409, 'no_remote_executor'] };
      const own = holdLocal(w.id, b.cardRef);
      if (!own.ok) return { fail: [409, own.holder === 'world' ? 'already_remote' : 'card_owned_elsewhere', { holder: own.holder }] };
      for (const h of this.handoffs.values()) if (h.ws === w.id && h.card === b.cardRef && ['preparing', 'staged'].includes(h.status) && h.expiresAt < Date.now()) h.status = 'expired';
      if ([...this.handoffs.values()].some((h) => h.ws === w.id && h.card === b.cardRef && ['preparing', 'staged'].includes(h.status))) return { fail: [409, 'handoff_open'] };
      const h: Handoff = { id: `hof_${hex(16)}`, ws: w.id, card: b.cardRef, accountId, deviceId: dev.id, intent, status: 'preparing', generation: own.generation, adapter: b.adapter, routineRef: String(b.routineRef ?? b.cardRef).slice(0, 80), cardState: b.cardState, jobId: null, reason: null, checksum: null, pkg: null, expiresAt: Date.now() + 30 * 60_000 };
      this.handoffs.set(h.id, h);
      return { json: view(h) };
    }
    let m = /^\/v1\/jobs\/handoffs\/(hof_[a-f0-9]{32})(?:\/(stage|commit|model-grant))?$/.exec(p);
    if (m) {
      const h = mineH(m[1]); if (!h) return { fail: [404, 'handoff'] };
      if (method === 'GET' && !m[2]) return { json: view(h) };
      if (method === 'POST' && m[2] === 'stage') {
        if (h.status !== 'preparing' && h.status !== 'staged') return { fail: [409, 'handoff_state'] };
        if (h.expiresAt < Date.now()) return { fail: [410, 'handoff_expired'] };
        if (b.sequence !== 1 || typeof b.stageId !== 'string' || !b.stageId) return { fail: [400, 'stage'] };
        if (checksumOf(b.package) !== b.checksum) return { fail: [400, 'checksum'] };
        let pkg: Record<string, unknown> = b.package;
        if (h.adapter === 'hermes_task') {
          // world/src/hermes-task.ts: campos desconhecidos são descartados (o World guarda só os conhecidos); o resto é conferido
          pkg = Object.fromEntries(Object.entries(pkg ?? {}).filter(([k]) => ['instructions', 'context', 'model', 'maxOutputTokens', 'profile'].includes(k)));
          const bad = checkHermesTask(pkg);
          if (bad) return { fail: [400, 'job_spec', { detail: bad }] };
        } else {
          const urls = b.package?.urls;
          if (!Array.isArray(urls) || !urls.length || urls.length > 10 || urls.some((x: unknown) => typeof x !== 'string' || !x.startsWith('https://'))) return { fail: [400, 'job_spec'] };
        }
        if (h.checksum && h.checksum !== b.checksum) return { fail: [409, 'checkpoint_conflict'] };
        h.status = 'staged'; h.checksum = b.checksum; h.pkg = pkg;
        return { json: view(h) };
      }
      if (method === 'POST' && m[2] === 'model-grant') {
        if (h.deviceId !== dev.id) return { fail: [403, 'not_card_device'] };
        if (h.status !== 'preparing' && h.status !== 'staged') return { fail: [409, 'handoff_state'] };
        if (h.adapter !== 'hermes_task') return { fail: [400, 'adapter'] };
        if (typeof b.provider !== 'string' || !this.delegated.includes(b.provider)) return { fail: [400, 'provider_not_allowed'] };
        if (typeof b.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(b.model)) return { fail: [400, 'model'] };
        if (typeof b.apiKey !== 'string' || !/^[\x21-\x7e]{8,500}$/.test(b.apiKey)) return { fail: [400, 'api_key'] };
        const o = owner(h.ws, h.card);
        if (!o || o.holder !== 'local' || o.deviceId !== dev.id) return { fail: [409, 'fenced'] };
        this.grants.set(h.id, { provider: b.provider, model: b.model, apiKey: b.apiKey });
        return { json: { handoffId: h.id, provider: b.provider, model: b.model, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
      }
      if (method === 'POST' && m[2] === 'commit') {
        if (h.status === 'committed') return { json: view(h) };
        if (this.onCommit) { const f = this.onCommit; this.onCommit = null; f(h); }
        if (h.status !== 'staged') return { fail: [409, h.status === 'preparing' ? 'checkpoint_missing' : 'handoff_state'] };
        if (h.expiresAt < Date.now()) return { fail: [410, 'handoff_expired'] };
        const o = owner(h.ws, h.card);
        if (!o || o.holder !== 'local' || o.deviceId !== dev.id || o.generation !== Number(b.expectedGeneration) || o.generation !== h.generation) {
          h.status = 'rejected'; h.reason = 'posse do cartão mudou';
          return { fail: [409, 'fenced'] };
        }
        const j: HJob = { id: `job_${hex(16)}`, ws: h.ws, accountId, state: 'queued', reason: null, result: null, routineRef: h.routineRef, spec: h.pkg, queuedAt: new Date().toISOString(),
          adapter: h.adapter, handoffId: h.id, modelFallback: null, recoveryOf: null, recoveryRound: 0, recoveryLog: [], recoveredBy: null, runAfter: null };
        this.hjobs.set(j.id, j);
        o.holder = 'world'; o.deviceId = null; o.leaseUntil = 0; o.jobId = j.id; o.generation += 1;
        h.status = 'committed'; h.jobId = j.id;
        return { json: view(h) };
      }
    }
    if (method === 'POST' && p === '/v1/jobs/heartbeats') {
      const w = plan(b.workspaceId); if (isOut(w)) return w;
      if (!Array.isArray(b.cards) || b.cards.length > 200) return { fail: [400, 'cards'] };
      return { json: { leaseSeconds: this.leaseMs / 1000, cards: b.cards.map((x: { cardRef: string; generation?: number }) => ({ cardRef: x.cardRef, ...holdLocal(w.id, x.cardRef, x.generation) })) } };
    }
    if (method === 'POST' && p === '/v1/jobs/cards/effects') {
      const w = plan(b.workspaceId); if (isOut(w)) return w;
      const o = owner(w.id, b.cardRef);
      if (!o || o.holder !== 'local' || o.deviceId !== dev.id || o.generation !== Number(b.generation) || o.leaseUntil <= Date.now()) return { fail: [409, 'fenced', { holder: o?.holder ?? null, generation: o?.generation ?? null }] };
      const k = `${w.id}|${b.cardRef}|${b.effectKey}`;
      const first = !this.effects.has(k); this.effects.add(k);
      return { json: { first } };
    }
    if (method === 'POST' && p === '/v1/jobs/cards/claim') {
      const w = plan(b.workspaceId); if (isOut(w)) return w;
      const o = owner(w.id, b.cardRef); if (!o) return { fail: [404, 'card'] };
      if (o.holder === 'local' && o.deviceId === dev.id) return { json: { holder: 'local', generation: o.generation } };
      if (o.generation !== Number(b.expectedGeneration)) return { fail: [409, 'fenced', { generation: o.generation }] };
      if (o.holder === 'world') { const j = o.jobId ? this.hjobs.get(o.jobId) : null; if (j && !TERMINAL.includes(j.state)) return { fail: [409, 'remote_running'] }; }
      else if (o.leaseUntil > Date.now()) return { fail: [409, 'card_owned_elsewhere'] };
      o.holder = 'local'; o.deviceId = dev.id; o.jobId = null; o.generation += 1; o.leaseUntil = Date.now() + this.leaseMs;
      return { json: { holder: 'local', generation: o.generation } };
    }
    if (method === 'GET' && p === '/v1/jobs/cards') {
      const w = plan(u.searchParams.get('workspace')); if (isOut(w)) return w;
      return { json: [...this.owners.entries()].filter(([k]) => k.startsWith(`${w.id}|`)).map(([k, o]) => {
        const j = o.jobId ? this.hjobs.get(o.jobId) : null;
        return { cardRef: k.slice(w.id.length + 1), holder: o.holder === 'world' ? 'world' : o.deviceId === dev.id ? 'this_device' : 'other_device', generation: o.generation, active: o.holder === 'world' ? !TERMINAL.includes(j?.state ?? '') : o.leaseUntil > Date.now(), jobId: o.jobId, jobState: j?.state ?? null, recoveryRound: j?.recoveryRound ?? 0 };
      }) };
    }
    m = /^\/v1\/jobs\/(job_[a-f0-9]{32})$/.exec(p);
    if (m && method === 'GET') {
      const j = this.hjobs.get(m[1]); if (!j || j.accountId !== accountId) return { fail: [404, 'job'] };
      return { json: { id: j.id, state: j.state, reason: j.reason, adapter: j.adapter, result: j.result, modelFallback: j.modelFallback ?? null,
        recovery: { round: j.recoveryRound, of: j.recoveryOf, next: j.recoveredBy, runAfter: j.runAfter, log: j.recoveryLog } } };
    }
    return null;
  }

  private token(accountId: string): string {
    const t = `idt_${hex(20)}`;
    this.idTokens.set(t, { accountId, exp: Date.now() + 5 * 60_000 });
    return t;
  }
}
