/**
 * Conta do Ergon World na instalação local: criar a conta ou entrar (e-mail e senha, direto na API de contas do World),
 * registrar este computador como aparelho (chave Ed25519 gerada aqui; a privada nunca sai, cifrada com a chave da
 * pessoa) e ligar a conta ao perfil local. O acesso local continua o mesmo: a conta do World não substitui o login.
 * A senha só vai ao World quando a pessoa a digita para a conta do World (ou escolhe reaproveitar a do Ergon, conferida
 * aqui antes), uma vez, por HTTPS; a chave pessoal local nunca vai.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { CLOSED_VALUE, SEALED_PREFIX } from '../security/fields.ts';
import { instanceSetting, setInstanceSetting } from '../services/security.ts';
import type { WorldConfig } from './config.ts';

const nowIso = () => new Date().toISOString();

export interface LinkRow { user_id: string; workspace_id: string; account_id: string; device_id: string; account_email: string | null; email_verified: number; device_keys: string; session_token: string; authorized_until: string | null; entitlement: string | null; bound_workspace_id: string | null; status: string }

/** Migrações próprias do módulo World local (w0001…), registradas em world_migrations. */
export function migrateWorldLocal(db: Db, dir = path.join(import.meta.dirname, 'migrations')): string[] {
  db.raw.exec('CREATE TABLE IF NOT EXISTS world_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.all<{ name: string }>('SELECT name FROM world_migrations').map((r) => r.name));
  const out: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^w\d{4}_.+\.sql$/.test(x)).sort()) {
    if (done.has(f)) continue;
    db.raw.exec('BEGIN');
    try { db.raw.exec(fs.readFileSync(path.join(dir, f), 'utf8')); db.run('INSERT INTO world_migrations (name, applied_at) VALUES (?, ?)', f, nowIso()); db.raw.exec('COMMIT'); }
    catch (e) { db.raw.exec('ROLLBACK'); throw e; }
    out.push(f);
  }
  return out;
}

export class WorldClient {
  readonly cfg: WorldConfig;
  readonly fetchImpl: typeof fetch;
  /** limite de pedidos do World (429 rate_limited): até quando esta credencial espera, sem chamar de novo */
  private backoff = new Map<string, number>();
  constructor(cfg: WorldConfig, fetchImpl: typeof fetch = fetch) { this.cfg = cfg; this.fetchImpl = fetchImpl; }

  private static limited(untilMs: number): HttpError {
    return Object.assign(new HttpError(429, 'rate_limited', 'O Ergon World pediu uma pausa. Tente de novo em instantes.'), { retryAfter: Math.max(1, Math.ceil((untilMs - Date.now()) / 1000)) });
  }

  /**
   * Chamada ao World. Sem rede → 503 world_offline (nada foi alterado). Limite de pedidos (429): espera o Retry-After
   * (no máximo 10 min) sem chamar de novo com a mesma credencial; nunca insiste em seguida.
   */
  async call<T = Record<string, unknown>>(method: string, p: string, body?: unknown, session?: string | null): Promise<T> {
    if (!this.cfg.url) throw new HttpError(503, 'world_unconfigured', 'O Ergon World não está configurado nesta instalação.');
    const cred = session ?? '';
    const wait = this.backoff.get(cred);
    if (wait && wait > Date.now()) throw WorldClient.limited(wait);
    if (wait) this.backoff.delete(cred);
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.cfg.url}${p}`, {
        method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: `Bearer ${session}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new HttpError(503, 'world_offline', 'Sem conexão com o Ergon World agora. Tente de novo.'); }
    const j = await r.json().catch(() => ({})) as { error?: string; message?: string };
    if (r.status === 429) {
      const ra = Number.parseInt(r.headers.get('retry-after') ?? '', 10);
      const until = Date.now() + Math.min(600, Number.isFinite(ra) && ra > 0 ? ra : 30) * 1000;
      this.backoff.set(cred, until);
      throw WorldClient.limited(until);
    }
    // e-mail da conta ainda não confirmado (criar ou comprar no World): a mesma frase curta em toda rota
    if (j.error === 'email_unverified') throw Object.assign(new HttpError(403, 'email_unverified', EMAIL_UNVERIFIED), { detail: j });
    if (!r.ok) throw Object.assign(new HttpError(r.status === 401 ? 401 : r.status >= 500 ? 503 : r.status, j.error ?? 'world_error', j.message ?? `World respondeu ${r.status}`), { detail: j });
    return j as T;
  }

  /** Baixa um arquivo do World (o pacote da Loja), com teto de tamanho; devolve os bytes e o SHA-256 que ele declarou. */
  async raw(p: string, max: number): Promise<{ bytes: Buffer; sha256: string | null }> {
    if (!this.cfg.url) throw new HttpError(503, 'world_unconfigured', 'O Ergon World não está configurado nesta instalação.');
    let r: Response;
    try { r = await this.fetchImpl(`${this.cfg.url}${p}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new HttpError(503, 'world_offline', 'Sem conexão com o Ergon World agora. Tente de novo.'); }
    if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string; message?: string }; throw new HttpError(r.status >= 500 ? 503 : r.status === 401 ? 400 : r.status, j.error ?? 'world_error', j.message ?? `World respondeu ${r.status}`); }
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > max) throw new HttpError(413, 'too_large', 'pacote grande demais');
    return { bytes, sha256: r.headers.get('x-sha256') };
  }
}

/** Identificador desta instalação (aleatório, sem dados da máquina). */
function installationId(db: Db): string {
  let v = instanceSetting(db, 'world_installation_id');
  if (!v) { v = crypto.randomBytes(18).toString('base64url'); setInstanceSetting(db, 'world_installation_id', v); }
  return v;
}

/** A frase do erro `email_unverified` do World (403), igual em toda rota que cria ou compra. */
export const EMAIL_UNVERIFIED = 'Confirme o seu e-mail para continuar.';

export interface ConnectedDevice { id: string; name: string; lastSeenAt: string | null }
/** a conta do World: nova (com o nome) ou que já existe */
export interface AccountInput { kind: 'signup' | 'login'; email: string; password: string; displayName?: string; locale?: WorldLocale }
/** Idiomas dos e-mails da conta no World (POST /v1/accounts aceita `locale`; padrão português). */
export type WorldLocale = 'pt' | 'en' | 'es' | 'fr' | 'de' | 'hi' | 'zh';
const LOCALES: readonly WorldLocale[] = ['pt', 'en', 'es', 'fr', 'de', 'hi', 'zh'];
/**
 * O idioma da tela (ou do Accept-Language) no formato do World: 'pt-BR' → pt, 'en-US' → en, 'zh-Hant' → zh. Lista de
 * preferências: vale o primeiro que o World conhece. Sem nenhum conhecido: undefined (o World usa português).
 */
export function worldLocale(...prefs: Array<string | null | undefined>): WorldLocale | undefined {
  for (const p of prefs) {
    for (const part of String(p ?? '').split(',')) {
      const base = part.split(';')[0].trim().toLowerCase().split(/[-_]/)[0];
      if ((LOCALES as readonly string[]).includes(base)) return base as WorldLocale;
    }
  }
  return undefined;
}
/** aparelho a liberar quando a conta já está no limite (2 com sessão / 4 cadastrados) */
export interface DeviceChoice { endSessionsOf?: string; replaceDeviceId?: string }
interface AccountReply { accountId: string; idToken: string; emailVerified: boolean }

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** o token da conta vale 5 minutos no World: para escolher qual aparelho liberar, guardamos um pouco menos */
const PENDING_MS = 4 * 60_000;

export function checkAccountInput(a: AccountInput): void {
  if (!EMAIL.test(a.email)) throw new HttpError(400, 'invalid_email', 'E-mail inválido.');
  if (a.password.length < 10) throw new HttpError(400, 'password_short', 'A senha precisa de 10 caracteres ou mais.');
  if (a.kind === 'signup' && !a.displayName?.trim()) throw new HttpError(400, 'invalid_name', 'Informe o nome.');
}

export class WorldLinks {
  readonly db: Db;
  readonly cfg: WorldConfig;
  readonly client: WorldClient;
  /** login recusado por limite: quais aparelhos, para a pessoa escolher (15 min) */
  private limits = new Map<string, { at: number; kind: 'session_limit' | 'device_limit'; devices: ConnectedDevice[] }>();
  /** a conta já respondeu, falta só o aparelho caber: o token curto da conta, na memória, por poucos minutos */
  private pending = new Map<string, { at: number; idToken: string; email: string; emailVerified: boolean; sealWs: string }>();
  constructor(db: Db, cfg: WorldConfig, client: WorldClient) { this.db = db; this.cfg = cfg; this.client = client; }

  get(userId: string): LinkRow | null { return this.db.get<LinkRow>("SELECT * FROM world_links WHERE user_id = ? AND status = 'active'", userId) ?? null; }

  /** O último login desta pessoa foi recusado por limite: qual (sessões ou cadastro) e quais aparelhos (ou null). */
  limit(userId: string): { kind: 'session_limit' | 'device_limit'; devices: ConnectedDevice[]; canRetry: boolean } | null {
    const l = this.limits.get(userId);
    if (!l || Date.now() - l.at >= 15 * 60_000) return null;
    const p = this.pending.get(userId);
    return { kind: l.kind, devices: l.devices, canRetry: !!p && Date.now() - p.at < PENDING_MS };
  }

  /**
   * Conecta esta pessoa a uma conta do World: cria a conta ou entra com ela, registra este computador e liga ao perfil
   * local. `sealWs`: o workspace cuja chave (a da pessoa) cifra as chaves do aparelho e a sessão.
   */
  async connect(userId: string, sealWs: string, account: AccountInput, choice: DeviceChoice = {}): Promise<LinkRow> {
    checkAccountInput(account);
    const email = account.email.trim().toLowerCase();
    const body = account.kind === 'signup'
      ? { email, password: account.password, displayName: account.displayName!.trim().slice(0, 80), ...(account.locale ? { locale: account.locale } : {}) }
      : { email, password: account.password };
    const r = await this.client.call<AccountReply>('POST', account.kind === 'signup' ? '/v1/accounts' : '/v1/accounts/login', body);
    return this.registerDevice(userId, sealWs, { idToken: r.idToken, email, emailVerified: r.emailVerified === true }, choice);
  }

  /** Depois de um limite de aparelhos: tenta de novo liberando o aparelho escolhido, sem pedir a senha outra vez. */
  async retryDevice(userId: string, choice: DeviceChoice): Promise<LinkRow> {
    const p = this.pending.get(userId);
    if (!p || Date.now() - p.at >= PENDING_MS) { this.pending.delete(userId); throw new HttpError(409, 'world_login_again', 'Entre de novo com o e-mail e a senha do Ergon World.'); }
    return this.registerDevice(userId, p.sealWs, p, choice);
  }

  /**
   * Nuvem do Ergon World (ERGON_MODE=cloud, world/nuvem.ts): este contêiner entra na conta do dono do workspace como o
   * aparelho "nuvem", com o token de partida que o World deu ao orquestrador (sem e-mail e sem senha de ninguém). As
   * chaves nascem aqui e ficam no disco deste workspace, cifradas pelo cofre, como num computador.
   */
  async connectCloud(userId: string, sealWs: string, bootToken: string): Promise<{ link: LinkRow; syncWorkspaceId: string; label: string | null }> {
    const ed = crypto.generateKeyPairSync('ed25519'); const x = crypto.generateKeyPairSync('x25519');
    const pub = (k: crypto.KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
    const reg = await this.client.call<{ deviceId: string; challenge: string; accountId: string; workspaceId: string; label: string | null; accountEmail: string | null }>('POST', '/v1/cloud/boot',
      { bootToken, installationId: installationId(this.db), publicKey: pub(ed.publicKey), syncPublicKey: pub(x.publicKey) });
    const conf = await this.client.call<{ sessionToken: string }>('POST', '/v1/devices/confirm', { deviceId: reg.deviceId, signature: crypto.sign(null, Buffer.from(reg.challenge), ed.privateKey).toString('base64') });
    const link = await this.finishDevice(userId, sealWs, reg, conf.sessionToken, { ed, x }, { email: reg.accountEmail ?? '', emailVerified: true });
    return { link, syncWorkspaceId: reg.workspaceId, label: reg.label };
  }

  private async registerDevice(userId: string, sealWs: string, acc: { idToken: string; email: string; emailVerified: boolean }, choice: DeviceChoice): Promise<LinkRow> {
    for (const d of [choice.endSessionsOf, choice.replaceDeviceId]) if (d !== undefined && !/^dev_[a-f0-9]{32}$/.test(d)) throw new HttpError(400, 'invalid', 'aparelho inválido');
    const ed = crypto.generateKeyPairSync('ed25519'); const x = crypto.generateKeyPairSync('x25519');
    const pub = (k: crypto.KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
    let reg: { deviceId: string; challenge: string; accountId: string };
    let conf: { sessionToken: string };
    try {
      reg = await this.client.call('POST', '/v1/devices/register', {
        idToken: acc.idToken, installationId: installationId(this.db), name: `${os.hostname().slice(0, 40)} · Ergon`, publicKey: pub(ed.publicKey), syncPublicKey: pub(x.publicKey),
        ...(choice.endSessionsOf ? { endSessionsOf: choice.endSessionsOf } : {}), ...(choice.replaceDeviceId ? { replaceDeviceId: choice.replaceDeviceId } : {}) });
      const sig = crypto.sign(null, Buffer.from(reg.challenge), ed.privateKey).toString('base64');
      conf = await this.client.call('POST', '/v1/devices/confirm', { deviceId: reg.deviceId, signature: sig });
    } catch (e) {
      // limite de aparelhos com sessão: guarda quais estão conectados para a pessoa escolher qual encerrar
      const d = (e as { detail?: { devices?: ConnectedDevice[] } }).detail;
      const code = (e as HttpError).code;
      if ((code === 'session_limit' || code === 'device_limit') && Array.isArray(d?.devices)) {
        this.limits.set(userId, { at: Date.now(), kind: code, devices: d.devices.slice(0, 10) });
        if (!this.pending.has(userId)) this.pending.set(userId, { at: Date.now(), ...acc, sealWs });
      }
      throw e;
    }
    this.limits.delete(userId); this.pending.delete(userId);
    return this.finishDevice(userId, sealWs, reg, conf.sessionToken, { ed, x }, acc);
  }

  /** Aparelho confirmado: liga a pessoa local, lê o plano e grava o vínculo (chaves e sessão cifradas com a chave dela). */
  private async finishDevice(userId: string, sealWs: string, reg: { deviceId: string; accountId: string }, sessionToken: string, k: { ed: crypto.KeyPairKeyObjectResult; x: crypto.KeyPairKeyObjectResult },
    acc: { email: string; emailVerified: boolean }): Promise<LinkRow> {
    const { ed, x } = k; const conf = { sessionToken };
    const pub = (key: crypto.KeyObject) => key.export({ format: 'der', type: 'spki' }).toString('base64');
    const priv = (key: crypto.KeyObject) => key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    await this.client.call('POST', '/v1/bindings', { localPersonId: userId }, conf.sessionToken);
    const au = await this.client.call<{ authorizedUntil: string; account?: { email: string | null; emailVerified?: unknown }; workspaces?: unknown[] }>('POST', '/v1/authorize', {}, conf.sessionToken);
    // o authorize diz (aditivo) se o e-mail está confirmado; sem o campo, vale o que o cadastro ou o login disse
    const verified = typeof au.account?.emailVerified === 'boolean' ? au.account.emailVerified : acc.emailVerified;
    const keys = JSON.stringify({ ed25519: priv(ed.privateKey), x25519: priv(x.privateKey), ed25519Public: pub(ed.publicKey), x25519Public: pub(x.publicKey) });
    this.db.run(`INSERT INTO world_links (user_id, workspace_id, account_id, device_id, account_email, email_verified, device_keys, session_token, authorized_until, entitlement, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET workspace_id = excluded.workspace_id, account_id = excluded.account_id, device_id = excluded.device_id, account_email = excluded.account_email,
        email_verified = excluded.email_verified, device_keys = excluded.device_keys, session_token = excluded.session_token, authorized_until = excluded.authorized_until,
        entitlement = excluded.entitlement, bound_workspace_id = NULL, status = 'active', updated_at = excluded.updated_at`,
    userId, sealWs, reg.accountId, reg.deviceId, au.account?.email ?? acc.email, verified ? 1 : 0, this.db.seal(sealWs, keys), this.db.seal(sealWs, conf.sessionToken), au.authorizedUntil,
    JSON.stringify(au.workspaces ?? []), nowIso(), nowIso());
    this.db.run('DELETE FROM world_bound WHERE user_id = ?', userId); // conectar de novo zera as ligações antigas
    return this.get(userId)!;
  }

  /** Sessão do aparelho da pessoa (decifrada só se a parte dela estiver aberta). */
  session(userId: string): string | null {
    const l = this.get(userId);
    if (!l || l.session_token.startsWith(SEALED_PREFIX) || l.session_token === CLOSED_VALUE) return null;
    return l.session_token;
  }

  /** O workspace local ligado ao World desta pessoa (só ele tem o plano e sincroniza), ou null. */
  /** Os workspaces locais da pessoa ligados ao World (links por conta: quantos quiser; o plano diz quantos têm direito). */
  boundList(userId: string): string[] { return this.db.all<{ workspace_id: string }>('SELECT workspace_id FROM world_bound WHERE user_id = ? ORDER BY created_at, workspace_id', userId).map((r) => r.workspace_id); }
  /** O primeiro ligado (para o que é da pessoa e não de um workspace, como o Ergon AI no motor). */
  bound(userId: string): string | null { return this.boundList(userId)[0] ?? null; }
  isBound(userId: string, ws: string): boolean { return !!this.db.get('SELECT 1 FROM world_bound WHERE user_id = ? AND workspace_id = ?', userId, ws); }
  setBound(userId: string, ws: string, on = true): void {
    if (on) this.db.run('INSERT OR IGNORE INTO world_bound (user_id, workspace_id, created_at) VALUES (?, ?, ?)', userId, ws, nowIso());
    else this.db.run('DELETE FROM world_bound WHERE user_id = ? AND workspace_id = ?', userId, ws);
  }
  /** A pessoa local dona da ligação de um workspace (para os canais e o nome no World). */
  ownerOfBound(ws: string): string | null {
    return this.db.get<{ user_id: string }>("SELECT b.user_id FROM world_bound b JOIN world_links l ON l.user_id = b.user_id AND l.status = 'active' WHERE b.workspace_id = ? LIMIT 1", ws)?.user_id ?? null;
  }
  markEmailVerified(userId: string): void { this.setEmailVerified(userId, true); }
  setEmailVerified(userId: string, v: boolean): void { this.db.run('UPDATE world_links SET email_verified = ?, updated_at = ? WHERE user_id = ?', v ? 1 : 0, nowIso(), userId); }

  /** Renova o resumo do plano com o World (só leitura); aparelho revogado no World → vínculo local cai. */
  async renew(userId: string): Promise<string | null> {
    const s = this.session(userId);
    if (!s) return null;
    try {
      const au = await this.client.call<{ authorizedUntil: string; account?: { emailVerified?: unknown }; workspaces?: unknown[] }>('POST', '/v1/authorize', {}, s);
      this.db.run('UPDATE world_links SET authorized_until = ?, entitlement = ?, updated_at = ? WHERE user_id = ?', au.authorizedUntil, JSON.stringify(au.workspaces ?? []), nowIso(), userId);
      // confirmou pelo link do e-mail (ou o World voltou a pedir): o aplicativo segue o World, sem novo login
      if (typeof au.account?.emailVerified === 'boolean') this.setEmailVerified(userId, au.account.emailVerified);
      return au.authorizedUntil;
    } catch (e) {
      if ((e as HttpError).status === 401) this.db.run("UPDATE world_links SET status = 'revoked', authorized_until = NULL, updated_at = ? WHERE user_id = ?", nowIso(), userId);
      throw e;
    }
  }

  /**
   * Desconecta deste computador: o aparelho sai da conta (se houver rede) e o vínculo local some, com a ligação do
   * workspace e o estado do Sync dele. Os dados locais ficam como estão.
   */
  async unlink(userId: string): Promise<void> {
    const l = this.db.get<LinkRow>('SELECT * FROM world_links WHERE user_id = ?', userId); const s = this.session(userId);
    if (l && s && l.status === 'active') await this.client.call('DELETE', `/v1/devices/${l.device_id}`, undefined, s).catch(() => undefined); // offline: o aparelho fica para revogar no outro aparelho
    for (const ws of this.boundList(userId)) forgetWorkspace(this.db, ws);
    this.db.run('DELETE FROM world_bound WHERE user_id = ?', userId);
    this.db.run('DELETE FROM world_links WHERE user_id = ?', userId);
    this.limits.delete(userId); this.pending.delete(userId);
  }
}

/** Tira do workspace local o que o ligava ao World (o id do workspace World, o estado do Sync e dos cartões na nuvem). Dados locais ficam. */
export function forgetWorkspace(db: Db, ws: string): void {
  for (const t of ['world_sync_conflicts', 'world_sync_records', 'world_sync', 'world_workspace_ids', 'world_cards', 'world_cloud_results']) db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, ws);
  // sem o World, nada fica preso "na nuvem": os cartões voltam a ser deste computador
  db.run("DELETE FROM remote_work WHERE workspace_id = ? AND holder = 'world'", ws);
}
