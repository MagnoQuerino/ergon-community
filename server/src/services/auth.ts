import type { Db } from '../db/db.ts';
import { HttpError, id, now, randomToken, sha256 } from '../lib/util.ts';
import type { KdfParams } from '../security/crypto.ts';
import { assertStrongPassword, checkPassword, hashPassword } from '../security/password.ts';
import { createWorkspace } from './seed.ts';

export const SESSION_COOKIE = 'ergon_session';
const SESSION_DAYS = 7;
/** Ações sensíveis pedem a senha (ou passkey) de novo se a última confirmação passou disto. */
export const REAUTH_MS = 5 * 60_000;

export interface AuthContext {
  userId: string;
  username: string;
  displayName: string;
  workspaceId: string;
  role: 'owner' | 'member';
  csrf: string;
  tokenHash: string;
  /** fim da sessão (ISO) */
  expiresAt?: string;
  /** tela trancada por inatividade: só destrancar, sair e o estado respondem */
  locked: boolean;
  /** última autenticação forte (login, destrancar, confirmação) */
  authAt: number;
}

export function needsSetup(db: Db): boolean {
  return !db.get('SELECT 1 AS x FROM users LIMIT 1');
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function validateUsername(username: string): void {
  if (!USERNAME.test(username)) throw new HttpError(400, 'username', 'usuário: 3–32 caracteres minúsculos, números, ponto, hífen ou sublinhado');
}

/** Primeiro uso: cria o proprietário e o workspace de demonstração. Só funciona com o banco vazio. */
export async function setupOwner(db: Db, input: { username: string; password: string; displayName: string }, slotsPerFloor: number, kdf: KdfParams) {
  validateUsername(input.username);
  assertStrongPassword(input.password, [input.username, input.displayName]);
  const hash = await hashPassword(input.password, kdf);
  return db.tx(() => {
    if (!needsSetup(db)) throw new HttpError(409, 'already_setup', 'o proprietário já foi criado');
    const userId = insertUser(db, input, hash);
    // a primeira conta administra a instalação (pessoas, trancamento, backup); não lê os dados de ninguém
    db.run('UPDATE users SET is_admin = 1 WHERE id = ?', userId);
    const seed = createWorkspace(db, 'Ergon Local', { demo: true, slotsPerFloor, welcome: true });
    db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", seed.workspaceId, userId, now());
    return { userId, workspaceId: seed.workspaceId };
  });
}

function insertUser(db: Db, input: { username: string; displayName: string }, hash: string, userId = id('usr')): string {
  const display = (input.displayName || input.username).trim().slice(0, 60);
  db.run('INSERT INTO users (id, username, display_name, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId, input.username, display, hash, now(), now());
  return userId;
}

/** Conta nova (`userId` reservado antes: a chave pessoal nasce com ele, antes da linha no banco). */
export async function createUser(db: Db, input: { username: string; password: string; displayName: string }, kdf: KdfParams, userId?: string): Promise<string> {
  validateUsername(input.username);
  assertStrongPassword(input.password, [input.username, input.displayName]);
  return insertUser(db, input, await hashPassword(input.password, kdf), userId);
}

let dummyHash: Promise<string> | null = null;

/** Confere usuário e senha (custo igual para usuário inexistente). Regrava o hash em formato antigo/fraco. */
export async function checkCredentials(db: Db, username: string, password: string, kdf: KdfParams): Promise<{ userId: string; workspaceId: string }> {
  const user = db.get<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE username = ?', username);
  if (!user) { await checkPassword(password, await (dummyHash ??= hashPassword('dummy-password-for-timing', kdf)), kdf); throw new HttpError(401, 'invalid_login', 'usuário ou senha inválidos'); }
  const r = await checkPassword(password, user.password_hash, kdf);
  if (!r.ok) throw new HttpError(401, 'invalid_login', 'usuário ou senha inválidos');
  if (r.rehash) db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password, kdf), user.id);
  const membership = db.get<{ workspace_id: string }>(
    "SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1", user.id);
  if (!membership) throw new HttpError(403, 'no_workspace', 'usuário sem workspace');
  return { userId: user.id, workspaceId: membership.workspace_id };
}

export async function setUserPassword(db: Db, userId: string, password: string, kdf: KdfParams, context: string[] = []): Promise<void> {
  assertStrongPassword(password, context);
  db.run('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?', await hashPassword(password, kdf), now(), userId);
}

export function defaultWorkspace(db: Db, userId: string): string {
  const m = db.get<{ workspace_id: string }>(
    "SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1", userId);
  if (!m) throw new HttpError(403, 'no_workspace', 'usuário sem workspace');
  return m.workspace_id;
}

/** Segundos fatores ligados para o usuário (autenticador, passkeys). */
export function userFactors(db: Db, userId: string): { totp: boolean; passkeys: number } {
  const u = db.get<{ totp_enabled: number }>('SELECT totp_enabled FROM users WHERE id = ?', userId);
  const p = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', userId);
  return { totp: !!u?.totp_enabled, passkeys: Number(p?.n ?? 0) };
}

// ---------------------------------------------------------------- login em duas etapas (2º fator pendente)
const pending = new Map<string, { userId: string; workspaceId: string; at: number }>();
/** Senha certa, falta o 2º fator: guarda por 5 min e devolve um identificador de uso único. */
export function startSecondFactor(userId: string, workspaceId: string): string {
  for (const [k, v] of pending) if (Date.now() - v.at > 5 * 60_000) pending.delete(k);
  const challenge = randomToken(24);
  pending.set(challenge, { userId, workspaceId, at: Date.now() });
  return challenge;
}
export function peekSecondFactor(challenge: string): { userId: string; workspaceId: string } {
  const p = pending.get(challenge);
  if (!p || Date.now() - p.at > 5 * 60_000) throw new HttpError(401, 'second_factor_expired', 'login expirado; digite a senha de novo');
  return p;
}
export function finishSecondFactor(challenge: string): void { pending.delete(challenge); }

// ---------------------------------------------------------------- sessões
export function createSession(db: Db, userId: string, workspaceId: string, meta: { ua?: string; ip?: string } = {}, days = SESSION_DAYS): { token: string; csrf: string } {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const ts = now();
  const expires = new Date(Date.now() + days * 86400_000).toISOString();
  db.run(`INSERT INTO sessions (token_hash, user_id, workspace_id, csrf_token, created_at, expires_at, last_seen_at, auth_at, user_agent, ip)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token), userId, workspaceId, csrf, ts, expires, ts, ts, (meta.ua ?? '').slice(0, 200), (meta.ip ?? '').slice(0, 64));
  return { token, csrf };
}

/** Sessão → contexto. A membership é revalidada a cada requisição; workspace nunca vem do corpo. */
export function resolveSession(db: Db, token: string | undefined, idleMinutes = 0): AuthContext | null {
  if (!token || token.length > 200) return null;
  const tokenHash = sha256(token);
  const row = db.get<{ user_id: string; workspace_id: string; csrf_token: string; expires_at: string; username: string; display_name: string; role: string | null; last_seen_at: string | null; auth_at: string | null; idle: number | null }>(
    `SELECT s.user_id, s.workspace_id, s.csrf_token, s.expires_at, s.last_seen_at, s.auth_at, u.username, u.display_name, m.role, u.idle_minutes AS idle
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
      WHERE s.token_hash = ?`, tokenHash);
  if (!row || !row.role) return null;
  if (row.expires_at < now()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return null;
  }
  const seen = Date.parse(row.last_seen_at ?? row.auth_at ?? '') || 0;
  const idle = row.idle ?? idleMinutes;
  return {
    userId: row.user_id, username: row.username, displayName: row.display_name, workspaceId: row.workspace_id,
    role: row.role as 'owner' | 'member', csrf: row.csrf_token, tokenHash, expiresAt: row.expires_at,
    locked: idle > 0 && Date.now() - seen > idle * 60_000,
    authAt: Date.parse(row.auth_at ?? '') || 0,
  };
}

/** Estende a sessão (sem trancamento, ela se renova com o uso). */
export function extendSession(db: Db, tokenHash: string, days: number): void {
  db.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(Date.now() + days * 86400_000).toISOString(), tokenHash);
}

/** Atividade de verdade (escrita ou sinal de mouse/teclado): adia a trava por inatividade. */
export function touchSession(db: Db, tokenHash: string): void {
  db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now(), tokenHash);
}
/** Autenticação forte agora (destrancar, confirmar identidade). */
export function markAuthenticated(db: Db, tokenHash: string): void {
  const ts = now();
  db.run('UPDATE sessions SET last_seen_at = ?, auth_at = ? WHERE token_hash = ?', ts, ts, tokenHash);
}
export function requireRecentAuth(ctx: AuthContext): void {
  if (Date.now() - ctx.authAt > REAUTH_MS) throw new HttpError(401, 'reauth', 'Confirme a sua identidade para continuar.');
}

export function logout(db: Db, tokenHash: string): void {
  db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
}

export function switchWorkspace(db: Db, ctx: AuthContext, workspaceId: string): void {
  const m = db.get('SELECT 1 AS x FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, ctx.userId);
  if (!m) throw new HttpError(404, 'not_found', 'workspace não encontrado');
  db.run('UPDATE sessions SET workspace_id = ? WHERE token_hash = ?', workspaceId, ctx.tokenHash);
}
