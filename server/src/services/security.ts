/**
 * Segurança da instância: proteger (chave mestra, banco cifrado, campos e arquivos cifrados, frase de
 * recuperação), trava por inatividade, entrega da chave ao cofre do motor de IA e as rotas de segurança.
 * Local e nuvem compartilham tudo; muda a origem das chaves (keys.ts) e a política de 2º fator (cfg.mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, now, randomToken, safeEqual } from '../lib/util.ts';
import { FieldCipher, SEALED_PREFIX } from '../security/fields.ts';
import type { PersonKeySource, Vault } from '../security/keys.ts';
import {
  newTotpSecret, passkeyAuthOptions, passkeyAuthVerify, passkeyRegisterOptions, passkeyRegisterVerify, throttle, totpUri, verifyTotp,
  type PasskeyRow, type RpConfig,
} from '../security/factors.ts';
import { passwordScore, MIN_PASSWORD } from '../security/password.ts';
import {
  checkCredentials, createSession, defaultWorkspace, finishSecondFactor, markAuthenticated, peekSecondFactor, requireRecentAuth,
  setUserPassword, startSecondFactor, userFactors, type AuthContext,
} from './auth.ts';
import { audit, type Bus } from './bus.ts';
import { isAdmin, openPersonWithPassword, type WorkspaceOwners } from './people.ts';

/** Colunas sensíveis cifradas com a chave do workspace (a lista que vai para a nuvem). */
export const SEALED_COLUMNS: Array<{ table: string; cols: string[] }> = [
  { table: 'messages', cols: ['content'] },
  { table: 'runs', cols: ['input', 'instructions', 'output'] },
  { table: 'tasks', cols: ['title', 'description'] },
  { table: 'audit_events', cols: ['evidence', 'result'] },
  { table: 'source_events', cols: ['text_excerpt', 'actor_display'] },
  { table: 'outbox', cols: ['body'] },
  { table: 'rules', cols: ['text'] },
  { table: 'agent_proposals', cols: ['payload', 'summary', 'result'] },
  { table: 'agents', cols: ['charter'] },
  { table: 'integrations', cols: ['account_label'] },
];

/** Cifra o que foi gravado antes da proteção (instalação antiga ou dados de demonstração do 1º uso). */
export function sealExisting(db: Db): number {
  let n = 0;
  db.tx(() => {
    for (const { table, cols } of SEALED_COLUMNS) {
      for (const col of cols) {
        const rows = db.raw.prepare(`SELECT rowid AS rid, workspace_id AS ws, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND substr(${col}, 1, 4) <> ?`).all(SEALED_PREFIX) as Array<{ rid: number; ws: string | null; v: string }>;
        for (const r of rows) { db.run(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`, db.seal(r.ws, String(r.v)), r.rid); n++; }
      }
    }
  });
  return n;
}

/** Cifra anexos e credenciais gravados em disco antes da proteção (mesma DEK do workspace). */
export function sealFilesAtRest(cfg: Config, cipher: FieldCipher): number {
  let n = 0;
  const seal = (file: string, ws: string | null, name: string) => {
    const data = fs.readFileSync(file);
    if (FieldCipher.isSealedBytes(data)) return;
    fs.writeFileSync(`${file}.tmp`, cipher.sealBytes(ws, data, name), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    n++;
  };
  if (fs.existsSync(cfg.filesDir)) {
    for (const ws of fs.readdirSync(cfg.filesDir).filter((d) => /^ws_[a-f0-9]{32}$/.test(d))) {
      for (const f of fs.readdirSync(path.join(cfg.filesDir, ws)).filter((x) => /^art_[a-f0-9]{32}$/.test(x))) seal(path.join(cfg.filesDir, ws, f), ws, f);
    }
  }
  const sec = path.join(cfg.dataDir, 'secrets');
  if (fs.existsSync(sec)) {
    for (const f of fs.readdirSync(sec)) {
      const full = path.join(sec, f);
      const m = f.match(/^(ws_[a-f0-9]{32})-([a-z]+)(\.json)?$/);
      if (!m) continue;
      if (fs.statSync(full).isDirectory()) { for (const g of fs.readdirSync(full)) seal(path.join(full, g), m[1], `${m[2]}/${g}`); } else seal(full, m[1], `${m[2]}.json`);
    }
  }
  return n;
}

// ---------------------------------------------------------------- configurações da instância
export function instanceSetting(db: Db, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM instance_settings WHERE key = ?', key)?.value ?? null;
}
export function setInstanceSetting(db: Db, key: string, value: string): void {
  db.run(`INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, key, value, now());
}
/**
 * Trancamento (local): desligado por padrão — o Ergon abre sozinho ao reiniciar e a sessão dura 90 dias; a proteção
 * é a do computador. Ligado: ao reiniciar pede a senha e a sessão dura 7 dias. Na nuvem é sempre ligado.
 */
export const SESSION_DAYS_LOCKED = 7;
export const SESSION_DAYS_OPEN = 90;
export const sessionDays = (cfg: Config, vault: Vault): number => (cfg.mode === 'local' && vault.openAccess() ? SESSION_DAYS_OPEN : SESSION_DAYS_LOCKED);

/**
 * Aplica a escolha (ou o padrão) do trancamento com o Ergon aberto. Instalação **nova** (proteção feita agora, no
 * primeiro uso): padrão desligado. Instalação **já protegida** ao chegar nesta versão (`upgrade`): continua trancada
 * como sempre esteve — atualizar nunca afrouxa a segurança sem o usuário escolher. Escolha "desligado" com a chave
 * sumida (backup restaurado, arquivo apagado): refaz a chave.
 */
export function applyLockChoice(db: Db, vault: Vault, cfg: Config, bus: Bus | null, opts: { upgrade?: boolean } = {}): void {
  if (cfg.mode !== 'local' || vault.state() !== 'open') return;
  const choice = instanceSetting(db, 'lock_choice');
  if (choice === 'ligado') return;
  const owner = db.get<{ workspace_id: string; user_id: string }>("SELECT workspace_id, user_id FROM memberships WHERE role = 'owner' ORDER BY created_at LIMIT 1");
  if (!choice && opts.upgrade) {
    setInstanceSetting(db, 'lock_choice', 'ligado');
    if (owner) audit(db, bus, { workspaceId: owner.workspace_id, actorType: 'system', actorId: 'ergon', action: 'security.lock.kept', evidence: { reason: 'atualização' },
      result: 'trancamento mantido ligado (instalação protegida antes desta versão): para abrir sozinho, desligue em Configurações › Segurança' });
    return;
  }
  if (!vault.openAccess()) vault.enableOpenAccess();
  if (!choice) {
    setInstanceSetting(db, 'lock_choice', 'desligado');
    if (owner) audit(db, bus, { workspaceId: owner.workspace_id, actorType: 'system', actorId: 'ergon', action: 'security.lock.off', evidence: { reason: 'padrão' },
      result: 'trancamento desligado (padrão no computador): o Ergon abre sozinho ao reiniciar; a proteção é a do computador' });
  }
}

/** Trava por inatividade: 0 = desligada (padrão). O usuário liga em Configurações › Segurança e escolhe o tempo. */
export const idleMinutes = (db: Db): number => Number(instanceSetting(db, 'idle_minutes') ?? 0);
export const IDLE_MAX_MINUTES = 24 * 60;

export function rpConfig(cfg: Config): RpConfig {
  const u = new URL(cfg.publicUrl);
  return { rpID: u.hostname, origin: u.origin, rpName: 'Ergon' };
}

/**
 * Proteger a instância: chave mestra nova, keyring com a senha, banco cifrado no lugar, campos e arquivos
 * antigos cifrados. Devolve a frase de recuperação (mostrada UMA vez; vale depois de confirmada).
 */
export async function protectInstance(db: Db, vault: Vault, cfg: Config, user: { id: string; username: string }, password: string,
  ownerOf: (workspaceId: string) => string | null = () => user.id): Promise<{ phrase: string; ask: number[] }> {
  await vault.protect(user, password);
  if (cfg.dbPath !== ':memory:') db.encryptInPlace(vault.dbKey());
  // local: a chave dos workspaces é a da pessoa (com uma pessoa só, a da instalação também abre a dela)
  const local = cfg.mode === 'local';
  if (local) await vault.createPerson(user, password);
  const cipher = db.setCipher(local ? vault.personKeySource(ownerOf) : vault.keySource());
  sealExisting(db);
  sealFilesAtRest(cfg, cipher);
  return local ? vault.newPersonRecovery(user.id) : vault.newRecovery();
}

/**
 * Cofre do motor de IA (gocryptfs no contêiner dele): enquanto o Ergon está aberto, garante que o volume
 * do motor foi destrancado — ao subir, e de novo se o contêiner do motor reiniciar.
 */
export class HermesVaultKeeper {
  private readonly cfg: Config; private readonly vault: Vault;
  private timer: NodeJS.Timeout | null = null;
  state: 'desligado' | 'aguardando' | 'aberto' | 'erro' = 'desligado';
  lastError: string | null = null;
  constructor(cfg: Config, vault: Vault) { this.cfg = cfg; this.vault = vault; }
  start(everyMs = 10_000): void {
    if (!this.cfg.hermesVaultUrl || this.timer) return;
    const tick = () => { void this.ensure(); };
    tick();
    this.timer = setInterval(tick, everyMs); this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private busy = false;
  async ensure(): Promise<void> {
    // abrir o cofre pela primeira vez pode levar minutos (cópia dos dados antigos, configuração): uma vez só
    if (this.busy || !this.cfg.hermesVaultUrl || !this.cfg.bridgeToken || this.vault.state() !== 'open') return;
    this.busy = true;
    try { await this.tryOpen(); } finally { this.busy = false; }
  }
  private async tryOpen(): Promise<void> {
    const h = { 'X-Ergon-Bridge-Token': this.cfg.bridgeToken!, 'Content-Type': 'application/json' };
    try {
      const st = await fetch(`${this.cfg.hermesVaultUrl}/status`, { headers: h, signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ sealed?: boolean }>);
      if (!st.sealed) { this.state = 'aberto'; return; }
      this.state = 'aguardando';
      const r = await fetch(`${this.cfg.hermesVaultUrl}/unlock`, { method: 'POST', headers: h, body: JSON.stringify({ key: this.vault.hermesKey() }), signal: AbortSignal.timeout(30 * 60_000) });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) { this.state = 'erro'; this.lastError = j.error ?? `cofre respondeu ${r.status}`; return; }
      this.state = 'aberto'; this.lastError = null;
    } catch {
      // sem resposta do receptor: o motor já está rodando (cofre aberto) ou o contêiner não existe
      if (this.state === 'aguardando') this.state = 'aberto';
    }
  }
}

// ---------------------------------------------------------------- rotas
export interface SecurityDeps {
  cfg: Config; db: Db; bus: Bus; vault: Vault;
  setCookie: (reply: FastifyReply, token: string, days?: number) => void;
  auth: (req: FastifyRequest) => AuthContext;
  owner: (req: FastifyRequest) => AuthContext;
  /** quem administra o Ergon neste computador (ajustes da instalação) */
  admin: (req: FastifyRequest) => AuthContext;
  /** várias pessoas: chaves pessoais, de quem é cada workspace, e o que roda quando a parte de alguém abre */
  people: { keys: () => PersonKeySource | null; owners: WorkspaceOwners; opened: (userId: string) => void; sealed: (a: { userId: string }) => boolean };
}

const S = {
  str: (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max }),
};

/**
 * Passkeys só valem no nome cadastrado ("localhost"): quem abre a interface por 127.0.0.1 é levado para
 * localhost (mesma máquina, mesma porta). Só navegação; a API não é redirecionada.
 */
export function canonicalHostHook(cfg: Config) {
  const pub = new URL(cfg.publicUrl);
  const alias = `127.0.0.1:${pub.port || '80'}`;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'GET' || pub.hostname !== 'localhost' || req.headers.host !== alias) return;
    if (req.url.startsWith('/api/') || req.url.startsWith('/internal/')) return;
    return reply.redirect(`${pub.origin}${req.url}`, 302);
  };
}
const ipOf = (req: FastifyRequest) => req.ip ?? 'local';
const meta = (req: FastifyRequest) => ({ ua: String(req.headers['user-agent'] ?? ''), ip: ipOf(req) });

function passkeysOf(db: Db, userId: string): PasskeyRow[] {
  return db.all<PasskeyRow>('SELECT id, credential_id, public_key, counter, transports, name FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);
}
const findPasskey = (db: Db) => (credentialId: string) =>
  db.get<PasskeyRow & { user_id: string }>('SELECT id, user_id, credential_id, public_key, counter, transports, name FROM passkeys WHERE credential_id = ?', credentialId);

/**
 * Conclui um login (senha certa): sem 2º fator ligado (e permitido pela política), cria a sessão; com 2º
 * fator, devolve o desafio e os métodos. Na nuvem o 2º fator é obrigatório.
 */
export function finishPasswordLogin(d: SecurityDeps, req: FastifyRequest, reply: FastifyReply, who: { userId: string; workspaceId: string }) {
  const f = userFactors(d.db, who.userId);
  if (f.totp || f.passkeys) {
    return { ok: false, need2fa: true, challenge: startSecondFactor(who.userId, who.workspaceId), methods: { totp: f.totp, passkey: f.passkeys > 0 } };
  }
  // nuvem sem 2º fator: a sessão nasce restrita (só cadastra autenticador ou passkey; ver ENROLL_OK no app)
  const days = sessionDays(d.cfg, d.vault);
  const s = createSession(d.db, who.userId, who.workspaceId, meta(req), days);
  d.setCookie(reply, s.token, days);
  return d.cfg.mode === 'cloud' ? { ok: true, enroll2fa: true } : { ok: true };
}

/** Ajudante do computador visto há pouco (ele avisa a cada poucos segundos); pedido de ligar vale 10 min. */
const AGENT_FRESH_MS = 30_000;
const REQUEST_MS = 10 * 60_000;

export function registerSecurityRoutes(app: FastifyInstance, d: SecurityDeps): {
  autoUnlockPrompt: () => boolean;
  /** confirma a identidade agora (senha + código do autenticador, ou passkey); usado por autorizações na conversa */
  verify: (req: FastifyRequest, ctx: AuthContext, body: { password?: string; code?: string; key?: string; response?: Record<string, unknown> }) => Promise<void>;
} {
  const { db, vault, cfg } = d;
  // Ajudante do computador (roda fora do Docker, na conta da pessoa): presença e pedido de ligar, só na memória
  let agent: { at: number; label: string; platform: string } | null = null;
  let enrollRequest: { at: number; userId: string } | null = null;
  const agentPresent = () => !!agent && Date.now() - agent.at < AGENT_FRESH_MS;
  const agentAuth = (req: FastifyRequest) => {
    const t = req.headers['x-ergon-agent-token'];
    if (!cfg.agentToken || cfg.mode !== 'local') throw new HttpError(404, 'agent_off', 'ajudante desligado nesta instalação');
    if (typeof t !== 'string' || !safeEqual(t, cfg.agentToken)) throw new HttpError(401, 'agent_auth', 'token do ajudante inválido');
  };
  const rp = () => rpConfig(cfg);
  const userRow = (id: string) => db.get<{ id: string; username: string; display_name: string; totp_secret: string | null; totp_enabled: number }>(
    'SELECT id, username, display_name, totp_secret, totp_enabled FROM users WHERE id = ?', id)!;

  // ---------- login: 2º fator ----------
  app.post('/api/auth/login/totp', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['challenge', 'code'], properties: { challenge: S.str(100, 10), code: S.str(10, 6) } } },
  }, async (req, reply) => {
    const b = req.body as { challenge: string; code: string };
    const p = peekSecondFactor(b.challenge);
    throttle.check(`totp:${p.userId}`);
    const u = userRow(p.userId);
    if (!u.totp_enabled || !u.totp_secret || !verifyTotp(u.id, u.totp_secret, b.code)) { throttle.fail(`totp:${p.userId}`); throw new HttpError(401, 'invalid_code', 'código inválido ou já usado'); }
    throttle.ok(`totp:${p.userId}`);
    finishSecondFactor(b.challenge);
    d.setCookie(reply, createSession(db, p.userId, p.workspaceId, meta(req), sessionDays(cfg, vault)).token, sessionDays(cfg, vault));
    return { ok: true };
  });

  // passkey: como 2º fator (com challenge) ou sozinha (sem senha; a passkey já verifica a pessoa)
  app.post('/api/auth/passkey/options', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { challenge: S.str(100, 10) } } },
  }, async (req) => {
    const b = req.body as { challenge?: string };
    const userId = b.challenge ? peekSecondFactor(b.challenge).userId : null;
    const key = `login:${randomToken(18)}`;
    return { key, options: await passkeyAuthOptions(rp(), key, userId, userId ? passkeysOf(db, userId) : []) };
  });
  app.post('/api/auth/passkey', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['key', 'response'], properties: { key: S.str(80, 6), challenge: S.str(100, 10), response: { type: 'object' } } } },
  }, async (req, reply) => {
    const b = req.body as { key: string; challenge?: string; response: Record<string, unknown> };
    throttle.check(`passkey:${ipOf(req)}`);
    let r;
    try { r = await passkeyAuthVerify(rp(), b.key, b.response, findPasskey(db)); } catch (e) { throttle.fail(`passkey:${ipOf(req)}`); throw e; }
    db.run('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', r.newCounter, now(), r.passkeyId);
    if (b.challenge) { const p = peekSecondFactor(b.challenge); if (p.userId !== r.userId) throw new HttpError(401, 'passkey', 'passkey de outro usuário'); finishSecondFactor(b.challenge); }
    // sem senha não há a chave da pessoa: depois de reiniciar, a primeira entrada é com a senha (depois, a passkey basta)
    if (d.people.sealed({ userId: r.userId })) throw new HttpError(409, 'need_password', 'O Ergon reiniciou: entre com a senha uma vez para abrir os seus dados. Depois, a passkey volta a bastar.');
    d.setCookie(reply, createSession(db, r.userId, defaultWorkspace(db, r.userId), meta(req), sessionDays(cfg, vault)).token, sessionDays(cfg, vault));
    return { ok: true };
  });

  // ---------- recuperar a conta com a frase (senha esquecida) ----------
  app.post('/api/auth/recover', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'phrase', 'newPassword'], properties: { username: S.str(32, 3), phrase: S.str(400, 20), newPassword: S.str(200, 1) } } },
  }, async (req, reply) => {
    const b = req.body as { username: string; phrase: string; newPassword: string };
    throttle.check(`recover:${ipOf(req)}`);
    const u = db.get<{ id: string; username: string; display_name: string }>('SELECT id, username, display_name FROM users WHERE username = ?', b.username);
    // com chave pessoal: a frase dela abre a parte dela; antes desta versão: a frase da instalação
    const person = !!u && !!d.people.keys() && vault.hasPerson(u.id);
    const ok = !!u && (person ? await vault.openPersonRecovery(u.id, b.phrase) : await vault.checkRecovery(b.phrase));
    if (!u || !ok) { throttle.fail(`recover:${ipOf(req)}`); throw new HttpError(401, 'invalid_phrase', 'frase de recuperação ou usuário não conferem'); }
    throttle.ok(`recover:${ipOf(req)}`);
    await setUserPassword(db, u.id, b.newPassword, cfg.kdf, [u.username, u.display_name]);
    if (person) await vault.setPersonPassword({ id: u.id, username: u.username }, b.newPassword);
    else {
      await vault.setPassword({ id: u.id, username: u.username }, b.newPassword);
      await openPersonWithPassword(db, vault, d.people.keys(), d.people.owners, { id: u.id, username: u.username }, b.newPassword);
    }
    d.people.opened(u.id);
    db.run('DELETE FROM sessions WHERE user_id = ?', u.id); // senha nova derruba as sessões antigas
    audit(db, d.bus, { workspaceId: defaultWorkspace(db, u.id), actorType: 'user', actorId: u.id, action: 'security.recover', result: 'senha redefinida com a frase de recuperação' });
    d.setCookie(reply, createSession(db, u.id, defaultWorkspace(db, u.id), meta(req), sessionDays(cfg, vault)).token, sessionDays(cfg, vault));
    return { ok: true };
  });

  // ---------- sessão: atividade, destrancar, confirmar identidade ----------
  app.post('/api/session/activity', async (req) => { d.auth(req); return { ok: true }; });

  const strongAuth = async (req: FastifyRequest, ctx: AuthContext, b: { password?: string; code?: string; key?: string; response?: Record<string, unknown> }) => {
    throttle.check(`unlock:${ctx.userId}`);
    try {
      if (b.response && b.key) {
        // a passkey confirma a pessoa, mas não traz a chave dela: depois de reiniciar, a primeira vez é com a senha
        if (d.people.sealed(ctx)) throw new HttpError(409, 'need_password', 'O Ergon reiniciou: digite a senha uma vez para abrir os seus dados.');
        const r = await passkeyAuthVerify(rp(), b.key, b.response, findPasskey(db), 'reauth');
        if (r.userId !== ctx.userId) throw new HttpError(401, 'passkey', 'passkey de outro usuário');
        db.run('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', r.newCounter, now(), r.passkeyId);
      } else {
        if (!b.password) throw new HttpError(400, 'password', 'digite a senha');
        // o autenticador vale no login; depois, para destrancar e confirmar, basta a senha (ou a passkey)
        await checkCredentials(db, ctx.username, b.password, cfg.kdf);
        if (!(await openPersonWithPassword(db, vault, d.people.keys(), d.people.owners, { id: ctx.userId, username: ctx.username }, b.password))) {
          throw new HttpError(409, 'person_key', 'A senha confere, mas não abriu os dados desta conta. Use "Esqueci a senha" com a sua frase de recuperação.');
        }
        d.people.opened(ctx.userId);
      }
    } catch (e) { throttle.fail(`unlock:${ctx.userId}`); throw e; }
    throttle.ok(`unlock:${ctx.userId}`);
    markAuthenticated(db, ctx.tokenHash);
  };
  const strongBody = { type: 'object', additionalProperties: false, properties: { password: S.str(200, 1), code: S.str(10, 6), key: S.str(80, 6), response: { type: 'object' } } };
  app.post('/api/session/unlock', { schema: { body: strongBody } }, async (req) => {
    const ctx = d.auth(req);
    await strongAuth(req, ctx, req.body as Record<string, never>);
    return { ok: true };
  });
  app.post('/api/session/reauth/options', async (req) => {
    const ctx = d.auth(req);
    const key = `reauth:${ctx.tokenHash.slice(0, 16)}`;
    return { key, options: await passkeyAuthOptions(rp(), key, ctx.userId, passkeysOf(db, ctx.userId), 'reauth') };
  });

  // ---------- estado e ajustes de segurança ----------
  app.get('/api/security/status', async (req) => {
    const ctx = d.auth(req);
    const u = userRow(ctx.userId);
    const info = vault.info();
    const person = !!d.people.keys() && vault.hasPerson(ctx.userId);
    const mine = person ? vault.peopleInfo().find((x) => x.userId === ctx.userId) : null;
    return {
      mode: cfg.mode, protected: info.protected, recovery: person ? !!mine?.recovery : info.recovery,
      autoUnlock: person ? (mine?.auto ? [{ id: vault.personAutoIds(ctx.userId)[0], label: 'cofre do sistema deste computador', createdAt: '' }] : []) : info.auto,
      people: { count: vault.peopleInfo().length, isolated: vault.multiPerson() },
      totp: !!u.totp_enabled, passkeys: db.all('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at', ctx.userId),
      lock: { enabled: cfg.mode !== 'local' || !vault.openAccess(), forced: cfg.mode !== 'local', sessionDays: sessionDays(cfg, vault) },
      idleMinutes: db.get<{ m: number | null }>('SELECT idle_minutes AS m FROM users WHERE id = ?', ctx.userId)?.m ?? idleMinutes(db), rpId: rp().rpID, publicUrl: cfg.publicUrl, minPassword: MIN_PASSWORD, motorVault: !!cfg.hermesVaultUrl,
      agent: agentPresent() ? { label: agent!.label, platform: agent!.platform } : null, agentConfigured: !!cfg.agentToken,
      autoUnlockPending: !!enrollRequest && Date.now() - enrollRequest.at < REQUEST_MS, autoUnlockAsked: instanceSetting(db, 'auto_unlock_asked'),
      sessions: db.all(`SELECT substr(token_hash, 1, 12) AS id, created_at, last_seen_at, user_agent, ip, token_hash = ? AS current FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`, ctx.tokenHash, ctx.userId, now()),
      recentAuth: Date.now() - ctx.authAt < 5 * 60_000,
    };
  });

  // Proteger uma instalação antiga (sem criptografia): confere a senha atual; senha fraca exige uma nova.
  app.post('/api/security/protect', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: S.str(200, 1), newPassword: S.str(200, 1) } } },
  }, async (req) => {
    const ctx = d.admin(req);
    if (vault.info().protected) throw new HttpError(409, 'already_protected', 'o Ergon já está protegido');
    const b = req.body as { password: string; newPassword?: string };
    throttle.check(`protect:${ctx.userId}`);
    try { await checkCredentials(db, ctx.username, b.password, cfg.kdf); } catch (e) { throttle.fail(`protect:${ctx.userId}`); throw e; }
    let pass = b.password;
    if (b.newPassword) { await setUserPassword(db, ctx.userId, b.newPassword, cfg.kdf, [ctx.username]); pass = b.newPassword; }
    else if (b.password.length < MIN_PASSWORD || passwordScore(b.password) < 3) {
      throw new HttpError(400, 'weak_password_change', 'A senha atual é fraca para proteger os dados. Escolha uma senha nova (uma frase de 3 ou 4 palavras).');
    }
    const r = await protectInstance(db, vault, cfg, { id: ctx.userId, username: ctx.username }, pass, d.people.owners.of);
    markAuthenticated(db, ctx.tokenHash);
    applyLockChoice(db, vault, cfg, d.bus); // padrão no computador: sem trancamento
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.protect', result: 'dados cifrados (banco, campos e arquivos)' });
    return { ok: true, recovery: r };
  });

  app.post('/api/security/recovery/new', async (req) => {
    const person = !!d.people.keys();
    const ctx = person ? d.auth(req) : d.owner(req); requireRecentAuth(ctx);
    if (person && !vault.hasPerson(ctx.userId)) throw new HttpError(409, 'person_key', 'Entre de novo com a senha para criar a sua chave antes da frase.');
    return person ? vault.newPersonRecovery(ctx.userId) : vault.newRecovery();
  });
  app.post('/api/security/recovery/confirm', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['answers'], properties: { answers: { type: 'object', maxProperties: 5, additionalProperties: S.str(40, 1) } } } },
  }, async (req) => {
    const person = !!d.people.keys() && vault.state() === 'open';
    const ctx = person ? d.auth(req) : d.owner(req);
    const answers = (req.body as { answers: Record<string, string> }).answers;
    const ok = person && vault.hasPerson(ctx.userId) ? await vault.confirmPersonRecovery(ctx.userId, answers) : await vault.confirmRecovery(answers);
    if (!ok) throw new HttpError(400, 'wrong_words', 'As palavras não conferem. Confira a frase anotada.');
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.recovery', result: 'frase de recuperação confirmada (a anterior deixou de valer)' });
    return { ok: true };
  });

  app.post('/api/security/password', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['current', 'next'], properties: { current: S.str(200, 1), next: S.str(200, 1) } } },
  }, async (req) => {
    const ctx = d.auth(req);
    const b = req.body as { current: string; next: string };
    throttle.check(`unlock:${ctx.userId}`);
    try { await checkCredentials(db, ctx.username, b.current, cfg.kdf); } catch (e) { throttle.fail(`unlock:${ctx.userId}`); throw e; }
    const me = { id: ctx.userId, username: ctx.username };
    await openPersonWithPassword(db, vault, d.people.keys(), d.people.owners, me, b.current);
    await setUserPassword(db, ctx.userId, b.next, cfg.kdf, [ctx.username, ctx.displayName]);
    if (vault.state() === 'open') await (vault.hasPerson(ctx.userId) ? vault.setPersonPassword(me, b.next) : vault.setPassword(me, b.next));
    db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', ctx.userId, ctx.tokenHash);
    markAuthenticated(db, ctx.tokenHash);
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.password', result: 'senha alterada; outras sessões encerradas' });
    return { ok: true };
  });

  app.put('/api/security/idle', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['minutes'], properties: { minutes: { type: 'integer', minimum: 0, maximum: IDLE_MAX_MINUTES } } } },
  }, async (req) => {
    const ctx = cfg.mode === 'local' ? d.auth(req) : d.owner(req);
    const m = (req.body as { minutes: number }).minutes;
    // local: vale para a pessoa (cada uma escolhe a sua); a instalação guarda o padrão de quem ainda não escolheu
    if (cfg.mode === 'local') db.run('UPDATE users SET idle_minutes = ? WHERE id = ?', m, ctx.userId);
    else setInstanceSetting(db, 'idle_minutes', String(m));
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.idle', evidence: { minutes: m }, result: m ? `trava por inatividade ligada (${m} min)` : 'trava por inatividade desligada' });
    return { minutes: m };
  });

  app.delete('/api/security/sessions/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{12}$' } } } } }, async (req) => {
    const ctx = d.auth(req);
    const r = db.run('DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 12) = ? AND token_hash <> ?', ctx.userId, (req.params as { id: string }).id, ctx.tokenHash);
    return { ok: r.changes > 0 };
  });

  // ---------- autenticador ----------
  // cadastro em andamento, por pessoa (vários usuários podem configurar ao mesmo tempo; 10 min)
  const pendingTotp = new Map<string, { secret: string; at: number }>();
  app.post('/api/security/totp/start', async (req) => {
    const ctx = d.auth(req); requireRecentAuth(ctx);
    const secret = newTotpSecret();
    pendingTotp.set(ctx.userId, { secret, at: Date.now() });
    const uri = totpUri(secret, ctx.username);
    const qr = await (await import('qrcode')).toDataURL(uri, { margin: 1, width: 220 });
    return { secret, uri, qr };
  });
  app.post('/api/security/totp/confirm', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: S.str(10, 6) } } },
  }, async (req) => {
    const ctx = d.auth(req);
    const p = pendingTotp.get(ctx.userId);
    if (!p || Date.now() - p.at > 10 * 60_000) { pendingTotp.delete(ctx.userId); throw new HttpError(409, 'no_pending', 'comece de novo'); }
    if (!verifyTotp(ctx.userId, p.secret, (req.body as { code: string }).code)) throw new HttpError(400, 'invalid_code', 'código não confere; veja o relógio do celular e tente o próximo código');
    db.run('UPDATE users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?', db.seal(null, p.secret), ctx.userId);
    pendingTotp.delete(ctx.userId);
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.totp.on', result: 'autenticador ligado' });
    return { ok: true };
  });
  app.delete('/api/security/totp', async (req) => {
    const ctx = d.auth(req); requireRecentAuth(ctx);
    if (cfg.mode === 'cloud' && !passkeysOf(db, ctx.userId).length) throw new HttpError(409, 'need_factor', 'Na nuvem é preciso ter pelo menos uma passkey antes de desligar o autenticador.');
    db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?', ctx.userId);
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.totp.off', result: 'autenticador desligado' });
    return { ok: true };
  });

  // ---------- passkeys ----------
  app.post('/api/security/passkeys/options', async (req) => {
    const ctx = d.auth(req); requireRecentAuth(ctx);
    const key = `register:${ctx.tokenHash.slice(0, 16)}`;
    return { key, options: await passkeyRegisterOptions(rp(), { id: ctx.userId, username: ctx.username, displayName: ctx.displayName }, passkeysOf(db, ctx.userId), key) };
  });
  app.post('/api/security/passkeys', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['key', 'name', 'response'], properties: { key: S.str(80, 6), name: S.str(60, 1), response: { type: 'object' } } } },
  }, async (req) => {
    const ctx = d.auth(req);
    const b = req.body as { key: string; name: string; response: Record<string, unknown> };
    const r = await passkeyRegisterVerify(rp(), b.key, b.response);
    if (r.userId !== ctx.userId) throw new HttpError(400, 'passkey', 'pedido de outro usuário');
    db.run('INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `psk_${r.credentialId.slice(0, 24)}`, ctx.userId, r.credentialId, r.publicKey, r.counter, JSON.stringify(r.transports), b.name.trim().slice(0, 60), now());
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.passkey.add', evidence: { name: b.name }, result: 'passkey cadastrada' });
    return { ok: true };
  });
  app.delete('/api/security/passkeys/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^psk_[\\w-]{1,40}$' } } } } }, async (req) => {
    const ctx = d.auth(req); requireRecentAuth(ctx);
    const left = passkeysOf(db, ctx.userId).length - 1;
    if (cfg.mode === 'cloud' && left < 1 && !userFactors(db, ctx.userId).totp) throw new HttpError(409, 'need_factor', 'Na nuvem é preciso manter um autenticador ou outra passkey.');
    db.run('DELETE FROM passkeys WHERE id = ? AND user_id = ?', (req.params as { id: string }).id, ctx.userId);
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.passkey.remove', result: 'passkey removida' });
    return { ok: true };
  });

  // ---------- trancamento (local): desligar delega o acesso à segurança do computador ----------
  app.put('/api/security/lock', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } } },
  }, async (req) => {
    const ctx = d.admin(req);
    const on = (req.body as { enabled: boolean }).enabled;
    if (cfg.mode !== 'local') throw new HttpError(409, 'cloud', 'Na nuvem o trancamento é sempre ligado.');
    if (vault.state() !== 'open') throw new HttpError(409, 'not_protected', 'proteja o Ergon antes');
    if (!on) requireRecentAuth(ctx); // desligar reduz a proteção: confirme que é você
    if (on) {
      vault.disableOpenAccess();
      // as sessões longas do "sem trancamento" voltam ao limite normal
      db.run('UPDATE sessions SET expires_at = ? WHERE expires_at > ?', new Date(Date.now() + SESSION_DAYS_LOCKED * 86400_000).toISOString(), new Date(Date.now() + SESSION_DAYS_LOCKED * 86400_000).toISOString());
    } else vault.enableOpenAccess();
    setInstanceSetting(db, 'lock_choice', on ? 'ligado' : 'desligado');
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: on ? 'security.lock.on' : 'security.lock.off',
      result: on ? 'trancamento ligado: ao reiniciar, o Ergon pede a senha' : 'trancamento desligado: o Ergon abre sozinho; a proteção é a do computador' });
    return { enabled: on, sessionDays: sessionDays(cfg, vault) };
  });

  // ---------- destrancar sozinho: botão na tela + ajudante do computador ----------
  // O Ergon roda no Docker e não alcança o cofre do sistema (DPAPI, Chaves, libsecret). Quem guarda a chave é o
  // ajudante (ergon.ps1/ergon.sh "ajudante", iniciado ao entrar no computador): ele avisa que está ali, busca a
  // chave quando a pessoa liga o botão e destranca o Ergon depois de reiniciar. Desligar apaga a chave do keyring.
  app.post('/api/security/auto-unlock', async (req) => {
    const ctx = d.people.keys() ? d.auth(req) : d.owner(req); requireRecentAuth(ctx);
    if (cfg.mode === 'cloud') throw new HttpError(409, 'cloud', 'na nuvem não há destrancar sozinho (a chave fica no serviço de chaves)');
    if (vault.state() !== 'open') throw new HttpError(409, 'not_protected', 'proteja o Ergon antes');
    if (!cfg.agentToken) throw new HttpError(409, 'agent_missing', 'O ajudante do computador não está configurado nesta instalação (ele vem com o instalador do Ergon).');
    // o pedido espera o ajudante por até 10 min (logo depois de reiniciar ele leva alguns segundos para aparecer)
    enrollRequest = { at: Date.now(), userId: ctx.userId };
    setInstanceSetting(db, 'auto_unlock_asked', 'ligar');
    return { ok: true, pending: true };
  });
  app.delete('/api/security/auto-unlock', async (req) => {
    const person = !!d.people.keys();
    const ctx = person ? d.auth(req) : d.owner(req); requireRecentAuth(ctx);
    enrollRequest = null;
    // a da pessoa; quem administra também desliga a da instalação (de versões antigas)
    const n = (person ? vault.disablePersonAuto(ctx.userId) : 0) + (!person || isAdmin(db, ctx.userId) ? vault.disableAuto() : 0);
    setInstanceSetting(db, 'auto_unlock_asked', 'desligar');
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.auto_unlock.off', result: `destrancar sozinho desligado (${n})` });
    return { ok: true, removed: n };
  });
  // aviso do primeiro acesso: a pessoa escolheu (ligar já foi pedido acima; aqui fica "agora não")
  app.post('/api/security/auto-unlock/asked', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { enum: ['desligar'] } } } },
  }, async (req) => {
    const ctx = d.owner(req);
    setInstanceSetting(db, 'auto_unlock_asked', 'desligar');
    audit(db, d.bus, { workspaceId: ctx.workspaceId, actorType: 'user', actorId: ctx.userId, action: 'security.auto_unlock.declined', result: 'destrancar sozinho deixado desligado (escolha no primeiro acesso)' });
    return { ok: true };
  });

  // ajudante: "estou aqui" a cada poucos segundos; a resposta diz se há pedido para ligar e quais chaves valem
  app.post('/api/agent/hello', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { label: S.str(80, 1), platform: S.str(20, 1), keyId: S.str(40, 1),
      keyIds: { type: 'array', maxItems: 20, items: S.str(40, 1) } } } },
  }, async (req) => {
    agentAuth(req);
    const b = req.body as { label?: string; platform?: string; keyId?: string; keyIds?: string[] };
    agent = { at: Date.now(), label: (b.label ?? agent?.label ?? 'este computador').slice(0, 80), platform: (b.platform ?? agent?.platform ?? '').slice(0, 20) };
    const open = vault.state() === 'open';
    const ids = open ? [...vault.info().auto.map((a) => a.id), ...vault.peopleInfo().flatMap((p) => vault.personAutoIds(p.userId))] : [];
    // várias pessoas: as chaves guardadas no cofre do sistema cuja parte ainda está fechada (o ajudante abre cada uma)
    const closed = open ? vault.peopleInfo().filter((p) => !p.open).flatMap((p) => vault.personAutoIds(p.userId)) : [];
    const mine = [...new Set([...(b.keyIds ?? []), ...(b.keyId ? [b.keyId] : [])])];
    return { enroll: !!enrollRequest && Date.now() - enrollRequest.at < REQUEST_MS, keyValid: b.keyId ? ids.includes(b.keyId) : null,
      invalid: open ? mine.filter((x) => !ids.includes(x)) : [], closed: mine.filter((x) => closed.includes(x)) };
  });
  // ajudante: abre a parte de uma pessoa com a chave guardada no cofre do sistema (a instalação já aberta)
  app.post('/api/agent/open', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  }, async (req) => {
    agentAuth(req);
    throttle.check('agent-open');
    const who = vault.openPersonAuto((req.body as { key: string }).key);
    if (!who) { throttle.fail('agent-open'); throw new HttpError(401, 'invalid_key', 'chave do abrir sozinho não confere (foi desligada?)'); }
    throttle.ok('agent-open');
    d.people.opened(who);
    return { ok: true };
  });
  app.post('/api/agent/auto-unlock/claim', async (req) => {
    agentAuth(req);
    if (!enrollRequest || Date.now() - enrollRequest.at > REQUEST_MS) throw new HttpError(409, 'no_request', 'ninguém pediu para ligar');
    if (vault.state() !== 'open') throw new HttpError(409, 'not_open', 'o Ergon está trancado');
    const who = enrollRequest.userId;
    enrollRequest = null;
    const label = agent?.label ?? 'este computador';
    // com chave pessoal: a chave abre a parte de quem pediu (e a instalação); sem: a da instalação, como antes
    let r: { id: string; key: string };
    if (d.people.keys() && vault.hasPerson(who)) r = vault.enrollPersonAuto(who, label);
    else { vault.disableAuto(); r = vault.enrollAuto(label); } // uma chave por instalação: a nova substitui a anterior
    const ws = db.get<{ workspace_id: string }>("SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", who)?.workspace_id;
    if (ws) audit(db, d.bus, { workspaceId: ws, actorType: 'user', actorId: who, action: 'security.auto_unlock.on', evidence: { label }, result: 'abrir sozinho ligado (chave no cofre do sistema deste computador)' });
    return r;
  });

  return {
    verify: strongAuth,
    /** Aviso do primeiro acesso: instalação local protegida, com ajudante configurado, ainda desligado e sem escolha feita. */
    // sem trancamento o Ergon já abre sozinho: o aviso do "destrancar sozinho" não faz sentido
    autoUnlockPrompt: () => cfg.mode === 'local' && !!cfg.agentToken && vault.state() === 'open' && !vault.openAccess() && !vault.info().auto.length && !instanceSetting(db, 'auto_unlock_asked'),
  };
}
