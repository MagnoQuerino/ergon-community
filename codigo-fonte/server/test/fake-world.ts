/**
 * Um Ergon World de mentira, só para os testes do cliente (server/src/world): implementa as rotas que o cliente chama,
 * com as mesmas respostas e os mesmos erros do contrato público (contas, aparelhos com prova de posse, autorização,
 * plano, créditos, Jobs e o Sync de envelopes cifrados). O serviço de verdade é privado e não mora neste repositório.
 * O estado fica fora do servidor HTTP: fechar e abrir de novo na mesma porta simula o World fora do ar e de volta.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Account { id: string; email: string; password: string; displayName: string; emailVerified: boolean }
interface Device { id: string; accountId: string; name: string; publicKey: string; syncPublicKey: string; challenge: string; status: 'pending' | 'active' | 'revoked'; session: string | null; lastSeenAt: string }
interface Workspace { id: string; owner: string; plan: string | null; head: number; changes: Array<Record<string, unknown>>; envelopes: Map<string, { keyVersion: number; wrapped: string }>; recovery: { keyVersion: number; wrapped: string } | null }

const hex = (n: number) => crypto.randomBytes(n).toString('hex');

export class FakeWorld {
  accounts = new Map<string, Account>();
  idTokens = new Map<string, { accountId: string; exp: number }>();
  devices = new Map<string, Device>();
  workspaces = new Map<string, Workspace>();
  bindings: Array<{ accountId: string; localPersonId: string }> = [];
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
  activate(ws: string, plan = 'world_pro'): void { this.workspaces.get(ws)!.plan = plan; }
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
    const send = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => send(status, { error, message: error, ...extra });
    try {
      const out = this.route(req.method ?? 'GET', u, body, bearer);
      if ('fail' in out) fail(out.fail[0], out.fail[1], out.fail[2]);
      else send(out.status ?? 200, out.json);
    } catch (e) { fail(500, 'internal', { detail: String(e) }); }
  }

  private session(bearer: string | null): Device | null {
    return [...this.devices.values()].find((d) => d.status === 'active' && d.session && d.session === bearer) ?? null;
  }
  private connected(accountId: string): Device[] { return [...this.devices.values()].filter((d) => d.accountId === accountId && d.status === 'active' && d.session); }

  private route(method: string, u: URL, b: any, bearer: string | null): { status?: number; json: unknown } | { fail: [number, string, Record<string, unknown>?] } {
    const p = u.pathname;
    const key = `${method} ${p}`;
    // ---------------------------------------------------------------- contas
    if (key === 'POST /v1/accounts') {
      if (typeof b.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email) || typeof b.password !== 'string' || b.password.length < 10) return { fail: [400, 'invalid_request'] };
      if ([...this.accounts.values()].some((a) => a.email === b.email)) return { fail: [409, 'email_in_use'] };
      const a: Account = { id: `acc_${hex(16)}`, email: b.email, password: b.password, displayName: String(b.displayName ?? ''), emailVerified: false };
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
    // daqui em diante, só com a sessão de um aparelho
    const dev = this.session(bearer);
    if (key === 'GET /v1/catalog') return { json: { dracmaIssue: '1', items: [{ sku: 'world_pro', kind: 'plan', name: 'Pro', priceCents: '4900', sellable: true, tier: 'pro', interval: 'month', people: 3, jobSlots: 5, monthlyDracmas: '1000' }] } };
    if (!dev) return { fail: [401, 'unauthenticated'] };
    dev.lastSeenAt = new Date().toISOString();
    const acc = this.accounts.get(dev.accountId)!;
    const mine = (id: string | null) => { const w = id ? this.workspaces.get(id) : undefined; return w && w.owner === acc.id ? w : null; };
    if (key === 'POST /v1/bindings') { this.bindings.push({ accountId: acc.id, localPersonId: b.localPersonId }); return { json: { ok: true } }; }
    if (key === 'POST /v1/authorize') {
      const workspaces = [...this.workspaces.values()].filter((w) => w.owner === acc.id).map((w) => ({ workspaceId: w.id, role: 'owner', status: w.plan ? 'active' : 'none', plan_sku: w.plan }));
      return { json: { authorizedUntil: new Date(Date.now() + 900_000).toISOString(), account: { email: acc.email }, workspaces } };
    }
    if (key === 'GET /v1/devices') return { json: [...this.devices.values()].filter((d) => d.accountId === acc.id && d.status !== 'pending').map((d) => ({ id: d.id, name: d.name, status: d.status, current: d === dev, connected: !!d.session, lastSeenAt: d.lastSeenAt })) };
    let m = /^\/v1\/devices\/(dev_[a-f0-9]{32})$/.exec(p);
    if (m && method === 'DELETE') { const d = this.devices.get(m[1]); if (!d || d.accountId !== acc.id) return { fail: [404, 'not_found'] }; d.status = 'revoked'; d.session = null; return { json: { ok: true } }; }
    m = /^\/v1\/devices\/(dev_[a-f0-9]{32})\/end-sessions$/.exec(p);
    if (m && method === 'POST') { const d = this.devices.get(m[1]); if (d && d.accountId === acc.id) d.session = null; return { json: { ok: true } }; }
    // ---------------------------------------------------------------- plano, créditos e Jobs (respostas do servidor)
    if (key === 'GET /v1/billing/state') {
      const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] };
      return { json: { workspaceId: w.id, role: 'owner', entitlement: { status: w.plan ? 'active' : 'none', plan_sku: w.plan, tier: w.plan ? 'pro' : null, people: w.plan ? 3 : 0, job_slots: w.plan ? 5 : 0, effective_until: null, grace_until: null }, seatsUsed: 1, subscription: null, items: [], invoices: [] } };
    }
    if (key === 'POST /v1/billing/checkout') {
      const w = mine(b.workspaceId); if (!w) return { fail: [404, 'not_found'] };
      return { json: { url: `https://checkout.stripe.com/c/pay/cs_test_${hex(8)}?ws=${w.id}&sku=${b.sku}` } };
    }
    if (key === 'GET /v1/wallet') { const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] }; return { json: { available: w.plan ? '1000.000000' : '0.000000', reserved: '0.000000', lots: [] } }; }
    if (key === 'GET /v1/jobs') { const w = mine(u.searchParams.get('workspace')); if (!w) return { fail: [404, 'not_found'] }; return { json: { slots: w.plan ? 5 : 0, running: 0, jobs: [] } }; }
    // ---------------------------------------------------------------- Sync: o World guarda envelopes e mudanças cifradas
    if (key === 'POST /v1/sync/workspaces') {
      const w: Workspace = { id: `sws_${hex(16)}`, owner: acc.id, plan: null, head: 0, changes: [], envelopes: new Map(), recovery: null };
      this.workspaces.set(w.id, w);
      return { json: { workspaceId: w.id, keyVersion: 1 } };
    }
    m = /^\/v1\/sync\/workspaces\/(sws_[a-f0-9]{32})\/(envelopes|envelope|devices-needing-key|changes)$/.exec(p);
    if (m) {
      const w = mine(m[1]); if (!w) return { fail: [404, 'not_found'] };
      if (m[2] === 'envelopes' && method === 'PUT') {
        if (b.kind === 'recovery') w.recovery = { keyVersion: b.keyVersion, wrapped: b.wrapped };
        else { const d = this.devices.get(b.deviceId); if (!d || d.accountId !== acc.id) return { fail: [400, 'invalid_device'] }; w.envelopes.set(d.id, { keyVersion: b.keyVersion, wrapped: b.wrapped }); }
        return { json: { ok: true } };
      }
      if (m[2] === 'envelope') {
        const e = u.searchParams.get('kind') === 'recovery' ? w.recovery : w.envelopes.get(dev.id);
        return e ? { json: e } : { fail: [404, 'no_envelope'] };
      }
      if (m[2] === 'devices-needing-key') {
        const devices = [...this.devices.values()].filter((d) => d.accountId === acc.id && d.status === 'active' && !w.envelopes.has(d.id)).map((d) => ({ deviceId: d.id, syncPublicKey: d.syncPublicKey }));
        return { json: { keyVersion: 1, devices } };
      }
      if (m[2] === 'changes' && method === 'POST') {
        if (!w.plan) return { fail: [402, 'world_inactive'] };
        if (b.expectedVersion !== w.head) return { fail: [409, 'version_conflict'] };
        // o World confere quem assinou (o envelope canônico), sem conseguir abrir o conteúdo
        const canon = `ergon-sync-v1|${w.id}|${b.expectedVersion}|${b.operationId}|${b.schemaVersion}|${b.keyVersion}|${b.kind}|${b.sha256}`;
        const pub = crypto.createPublicKey({ key: Buffer.from(dev.publicKey, 'base64'), format: 'der', type: 'spki' });
        if (!crypto.verify(null, Buffer.from(canon), pub, Buffer.from(String(b.signature), 'base64'))) return { fail: [400, 'bad_signature'] };
        if (crypto.createHash('sha256').update(Buffer.from(b.ciphertext, 'base64')).digest('hex') !== b.sha256) return { fail: [400, 'bad_hash'] };
        w.head += 1;
        w.changes.push({ version: w.head, operationId: b.operationId, keyVersion: b.keyVersion, schemaVersion: b.schemaVersion, kind: b.kind, ciphertext: b.ciphertext, nonce: b.nonce, deviceId: dev.id });
        return { json: { version: w.head } };
      }
      if (m[2] === 'changes' && method === 'GET') {
        const since = Number(u.searchParams.get('since') ?? 0);
        return { json: { head: w.head, changes: w.changes.filter((c) => (c.version as number) > since).slice(0, 50) } };
      }
    }
    return { fail: [404, 'not_found'] };
  }

  private token(accountId: string): string {
    const t = `idt_${hex(20)}`;
    this.idTokens.set(t, { accountId, exp: Date.now() + 5 * 60_000 });
    return t;
  }
}
