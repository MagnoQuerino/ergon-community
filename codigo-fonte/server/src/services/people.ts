/**
 * Várias pessoas no mesmo computador. Cada conta tem workspace e chave pessoal próprios; a chave
 * de cada workspace é embrulhada pela chave de quem é dono dele (PersonKeySource). Aqui: de quem é cada workspace,
 * abrir a parte de uma pessoa (e migrar as chaves de antes desta versão), criar conta, convites e remover conta.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, id, now, sha256 } from '../lib/util.ts';
import { PersonKeySource, type Vault } from '../security/keys.ts';
import { assertStrongPassword } from '../security/password.ts';
import { createUser, validateUsername } from './auth.ts';
import { createWorkspace } from './seed.ts';
import { instanceSetting } from './security.ts';

/** Dono de cada workspace (a pessoa cuja chave embrulha a DEK dele). Lembrado; esquece quando contas nascem ou saem. */
export class WorkspaceOwners {
  private readonly db: Db;
  private readonly cache = new Map<string, string>();
  constructor(db: Db) { this.db = db; }
  of = (ws: string): string | null => {
    const hit = this.cache.get(ws);
    if (hit) return hit;
    const r = this.db.raw.prepare("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(ws) as { user_id: string } | undefined;
    if (r) this.cache.set(ws, r.user_id);
    return r?.user_id ?? null;
  };
  /** Workspaces de que a pessoa é dona. */
  owned(userId: string): string[] {
    return (this.db.raw.prepare("SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner' ORDER BY created_at").all(userId) as Array<{ workspace_id: string }>).map((r) => r.workspace_id);
  }
  forget(): void { this.cache.clear(); }
}

export const isAdmin = (db: Db, userId: string): boolean => !!db.get<{ a: number }>('SELECT is_admin AS a FROM users WHERE id = ?', userId)?.a;

/** Chaves antigas (pela MK) dos workspaces da pessoa passam a ser embrulhadas pela chave dela. O conteúdo não muda. */
export function rewrapPersonDeks(db: Db, keys: PersonKeySource, owners: WorkspaceOwners, userId: string): number {
  let n = 0;
  db.tx(() => {
    for (const ws of owners.owned(userId)) {
      const row = db.raw.prepare('SELECT wrapped FROM workspace_keys WHERE workspace_id = ?').get(ws) as { wrapped: string } | undefined;
      if (!row || PersonKeySource.personOf(row.wrapped) === userId) continue;
      const dek = keys.unwrapDek(ws, row.wrapped);
      db.raw.prepare('UPDATE workspace_keys SET wrapped = ?, key_source = ? WHERE workspace_id = ?').run(keys.wrapDek(ws, dek), keys.name, ws);
      n++;
    }
  });
  return n;
}

/**
 * A senha certa chegou (entrar, destrancar a tela, destrancar o Ergon): abre a parte da pessoa. Numa instalação de
 * antes desta versão, a chave pessoal nasce aqui e as chaves dos workspaces dela passam a depender dela.
 */
export async function openPersonWithPassword(db: Db, vault: Vault, keys: PersonKeySource | null, owners: WorkspaceOwners, user: { id: string; username: string }, password: string): Promise<boolean> {
  if (vault.state() !== 'open' || !keys) return vault.state() === 'unprotected';
  if (vault.hasPerson(user.id)) return vault.openPerson(user.id, password);
  await vault.createPerson(user, password);
  rewrapPersonDeks(db, keys, owners, user.id);
  return true;
}

// ---------------------------------------------------------------- contas novas
/** Quem pode criar conta neste computador: qualquer pessoa (padrão) ou só com convite do administrador. */
export type SignupPolicy = 'aberto' | 'convite';
export const signupPolicy = (db: Db): SignupPolicy => (instanceSetting(db, 'signup') === 'convite' ? 'convite' : 'aberto');

const INVITE_DAYS = 7;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I: lido em voz alta sem confusão
const normalizeInvite = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Convite de uso único (7 dias): o código aparece uma vez; no banco fica só o resumo. */
export function createInvite(db: Db, adminId: string): { code: string; expiresAt: string } {
  const raw = Array.from(crypto.randomBytes(8), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString();
  db.run('INSERT INTO invites (id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', id('inv'), sha256(raw), adminId, now(), expiresAt);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}
export function listInvites(db: Db): Array<{ id: string; created_at: string; expires_at: string }> {
  return db.all('SELECT id, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC', now());
}
export function revokeInvite(db: Db, inviteId: string): boolean {
  return db.run('DELETE FROM invites WHERE id = ? AND used_at IS NULL', inviteId).changes > 0;
}

export interface RegisterDeps { db: Db; vault: Vault; keys: PersonKeySource; owners: WorkspaceOwners; cfg: Config }
/**
 * Conta nova neste computador: chave pessoal, conta, workspace próprio (com as boas-vindas) e a frase dela, mostrada
 * uma vez. A instalação precisa estar aberta; quem já usa o computador precisa ter a frase pessoal (a partir de agora,
 * a parte de cada um só abre pela senha ou frase da própria pessoa).
 */
export async function registerPerson(d: RegisterDeps, input: { username: string; password: string; displayName: string; invite?: string }): Promise<{ userId: string; workspaceId: string }> {
  const { db, vault, cfg } = d;
  if (cfg.mode !== 'local') throw new HttpError(404, 'not_found', 'rota não encontrada');
  if (vault.state() !== 'open') throw new HttpError(423, 'sealed', 'O Ergon está trancado: quem já tem conta precisa abrir antes.');
  validateUsername(input.username);
  assertStrongPassword(input.password, [input.username, input.displayName]);
  if (db.get('SELECT 1 AS x FROM users WHERE username = ?', input.username)) throw new HttpError(409, 'username_taken', 'Esse usuário já existe neste computador. Escolha outro.');
  // convite primeiro: sem ele, quem chega não fica sabendo nada de quem já usa o computador
  let invite: { id: string } | undefined;
  if (signupPolicy(db) === 'convite') {
    invite = input.invite ? db.get<{ id: string }>('SELECT id FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(normalizeInvite(input.invite)), now()) : undefined;
    if (!invite) throw new HttpError(403, 'invite', 'Neste computador, conta nova precisa de um convite de quem administra o Ergon. Confira o código.');
  }
  const pending = vault.peopleInfo().filter((p) => !p.recovery);
  // quem é de antes desta versão (sem chave pessoal ainda) entra uma vez com a senha, e gera a frase dela
  const legacy = db.all<{ username: string }>('SELECT username FROM users').filter((u) => !vault.peopleInfo().some((p) => p.username === u.username));
  if (pending.length || legacy.length) {
    const who = [...pending.map((p) => p.username), ...legacy.map((u) => u.username)].join(', ');
    throw new HttpError(409, 'others_without_phrase', `Antes de criar outra conta aqui, ${who} precisa entrar e gerar a frase pessoal (Configurações › Segurança).`);
  }
  const userId = id('usr');
  await vault.createPerson({ id: userId, username: input.username }, input.password);
  try {
    await createUserRow(db, input, cfg, userId, d, invite?.id);
    await vault.setPassword({ id: userId, username: input.username }, input.password); // a senha também abre a instalação
  } catch (e) {
    vault.removePerson(userId); // nada pela metade: a chave sai junto
    throw e;
  }
  d.owners.forget();
  return { userId, workspaceId: d.owners.owned(userId)[0] };
}

async function createUserRow(db: Db, input: { username: string; password: string; displayName: string }, cfg: Config, userId: string, d: RegisterDeps, inviteId?: string): Promise<string> {
  await createUser(db, input, cfg.kdf, userId); // hash da senha fora da transação (lento de propósito)
  try {
    return db.tx(() => {
      const seed = d.keys.withCreator(userId, () => createWorkspace(db, 'Ergon Local', { demo: true, slotsPerFloor: cfg.slotsPerFloor, welcome: true }));
      db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", seed.workspaceId, userId, now());
      if (inviteId) db.run('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?', now(), userId, inviteId);
      return seed.workspaceId;
    });
  } catch (e) {
    db.run('DELETE FROM users WHERE id = ?', userId);
    throw e;
  }
}

// ---------------------------------------------------------------- remover conta
/**
 * Remove uma conta de vez: primeiro a chave (o conteúdo fica ilegível na hora), depois as chaves dos workspaces, as
 * linhas, os arquivos e as credenciais. O motor dela (contêiner e cofre) sai pelo gerente de motores, quem chama.
 */
export function removePersonData(db: Db, vault: Vault, owners: WorkspaceOwners, cfg: Config, userId: string): { workspaces: number; rows: number; files: number } {
  const workspaces = owners.owned(userId);
  vault.removePerson(userId);
  let rows = 0;
  const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  const cols = (t: string) => (db.raw.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as Array<{ name: string }>).map((c) => c.name);
  // chaves estrangeiras desligadas só durante a limpeza (a ordem entre tabelas não importa); conferidas no fim
  db.raw.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      for (const ws of workspaces) {
        for (const t of tables) if (cols(t).includes('workspace_id')) rows += db.run(`DELETE FROM ${JSON.stringify(t)} WHERE workspace_id = ?`, ws).changes;
        rows += db.run('DELETE FROM workspaces WHERE id = ?', ws).changes;
      }
      for (const t of tables) if (t !== 'users' && t !== 'invites' && cols(t).includes('user_id')) rows += db.run(`DELETE FROM ${JSON.stringify(t)} WHERE user_id = ?`, userId).changes;
      rows += db.run('DELETE FROM users WHERE id = ?', userId).changes;
    });
    const broken = db.raw.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`limpeza deixou ${broken.length} referências soltas`);
  } finally { db.raw.exec('PRAGMA foreign_keys = ON'); }
  for (const ws of workspaces) db.fieldCipher?.forget(ws);
  let files = 0;
  for (const ws of workspaces) {
    const dir = path.join(cfg.filesDir, ws);
    if (fs.existsSync(dir)) { files += fs.readdirSync(dir).length; fs.rmSync(dir, { recursive: true, force: true }); }
    const sec = path.join(cfg.dataDir, 'secrets');
    if (fs.existsSync(sec)) for (const f of fs.readdirSync(sec).filter((x) => x.startsWith(`${ws}-`))) { fs.rmSync(path.join(sec, f), { recursive: true, force: true }); files++; }
  }
  owners.forget();
  return { workspaces: workspaces.length, rows, files };
}
