import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import path from 'node:path';
import { FieldCipher, SEALED_PREFIX } from '../security/fields.ts';
import type { WorkspaceKeySource } from '../security/keys.ts';

export type SqlValue = null | number | bigint | string | Buffer | Uint8Array;
export type Row = Record<string, SqlValue>;

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

/**
 * Uma conexão por processo: SQLite tem um escritor por vez, e o servidor é o único escritor.
 * Transações curtas, nunca com chamada de rede ou modelo dentro.
 *
 * Segurança: com `key`, o arquivo inteiro é cifrado (SQLite3 Multiple Ciphers, formato SQLCipher 4, chave
 * bruta de 256 bits derivada da chave mestra). Com `setCipher`, campos sensíveis são gravados cifrados
 * pela chave do workspace (`seal`) e decifrados sozinhos na leitura — a camada que vai para a nuvem.
 */
export class Db {
  readonly raw: Database.Database;
  private depth = 0;
  private cipher: FieldCipher | null = null;
  /**
   * A parte dona do workspace está aberta? (várias pessoas: a de quem ainda não entrou depois de reiniciar fica
   * fechada). Consultas de fundo filtram por `ws_open(workspace_id)`; o app troca a regra (padrão: tudo aberto).
   */
  workspaceOpen: (workspaceId: string | null) => boolean = () => true;

  constructor(file: string, opts: { key?: Buffer } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new Database(file);
    if (opts.key) Db.applyKey(this.raw, opts.key);
    // lê algo de verdade: chave errada falha aqui ("file is not a database"), não no meio do trabalho
    this.raw.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.function('ws_open', { deterministic: false }, (ws: unknown) => (this.workspaceOpen(typeof ws === 'string' ? ws : null) ? 1 : 0));
  }

  private static applyKey(raw: Database.Database, key: Buffer): void {
    raw.pragma("cipher = 'sqlcipher'");
    raw.pragma('legacy = 4');
    raw.pragma(`key = "x'${key.toString('hex')}'"`);
  }

  /** Arquivo de banco cifrado? (o cabeçalho de um SQLite em claro é "SQLite format 3\0") */
  static isEncryptedFile(file: string): boolean {
    if (!fs.existsSync(file) || fs.statSync(file).size < 16) return false;
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b.toString('latin1') !== 'SQLite format 3\u0000'; } finally { fs.closeSync(fd); }
  }

  /** Cifra no lugar um banco em claro (proteção de uma instalação antiga). WAL não permite: alterna um instante. */
  encryptInPlace(key: Buffer): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
    this.raw.pragma('journal_mode = DELETE');
    this.raw.pragma("cipher = 'sqlcipher'");
    this.raw.pragma('legacy = 4');
    this.raw.pragma(`rekey = "x'${key.toString('hex')}'"`);
    this.raw.pragma('journal_mode = WAL');
  }

  /** Liga a cifra por campo (chaves de workspace na tabela workspace_keys). */
  setCipher(keys: WorkspaceKeySource): FieldCipher {
    this.cipher = new FieldCipher(keys, {
      getWrapped: (ws) => (this.raw.prepare('SELECT wrapped FROM workspace_keys WHERE workspace_id = ?').get(ws) as { wrapped: string } | undefined)?.wrapped ?? null,
      putWrapped: (ws, wrapped, source) => { this.raw.prepare('INSERT INTO workspace_keys (workspace_id, wrapped, key_source, created_at) VALUES (?, ?, ?, ?)').run(ws, wrapped, source, new Date().toISOString()); },
    });
    return this.cipher;
  }
  get fieldCipher(): FieldCipher | null { return this.cipher; }

  /** Valor sensível para gravar: cifrado pela chave do workspace (sem cifra ligada, volta igual). */
  seal<T extends string | null | undefined>(workspaceId: string | null | undefined, value: T): T {
    return (this.cipher && typeof value === 'string' && value.length ? this.cipher.seal(workspaceId, value) : value) as T;
  }

  private openRow<T>(row: T): T {
    if (!this.cipher || !row || typeof row !== 'object') return row;
    const r = row as Record<string, unknown>;
    for (const k in r) { const v = r[k]; if (typeof v === 'string' && v.startsWith(SEALED_PREFIX)) r[k] = this.cipher.open(v); }
    return row;
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.openRow(this.raw.prepare(sql).get(...params) as T | undefined);
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    const rows = this.raw.prepare(sql).all(...params) as T[];
    if (this.cipher) for (const r of rows) this.openRow(r);
    return rows;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  /** BEGIN IMMEDIATE: reserva o escritor antes de ler, para checagens de capacidade sem corrida. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* já encerrada */ }
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  /** Aplica as migrações que faltam, em ordem. `until` (testes): para naquela, como um banco de uma versão antiga. */
  migrate(opts: { until?: string } = {}): string[] {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const done = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (opts.until && f > opts.until) break;
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
      });
      applied.push(f);
    }
    return applied;
  }

  /** Cópia consistente do banco (VACUUM INTO), segura com o servidor em execução. Sai cifrada com a mesma chave. */
  backupTo(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) throw new Error('arquivo de backup já existe');
    this.raw.prepare('VACUUM INTO ?').run(file);
  }

  /** Confere um arquivo de banco (cópia de backup): abre, roda quick_check e lista as migrações. Não muda o modo do diário. */
  static checkFile(file: string, key?: Buffer | null): { ok: boolean; detail: string; migrations: string[] } {
    let raw: Database.Database | null = null;
    try {
      raw = new Database(file, { fileMustExist: true });
      if (key) Db.applyKey(raw, key);
      const r = String(raw.pragma('quick_check', { simple: true }));
      const migrations = (raw.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map((x) => x.name);
      return { ok: r === 'ok', detail: r, migrations };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, migrations: [] };
    } finally { raw?.close(); }
  }

  close(): void {
    this.raw.close();
  }
}
