/**
 * Backup completo e restauração. Um backup é uma pasta `ergon-<data>` com:
 *
 *   db.sqlite      cópia consistente do banco (VACUUM INTO); com o Ergon protegido, cifrada com a mesma chave
 *   keyring.json   a chave mestra embrulhada pela senha e pela frase daquele momento (sem ele o banco não abre)
 *   files/         anexos e entregas, como estão no disco (com o Ergon protegido, cifrados pela chave do workspace)
 *   secrets/       credenciais das conexões e a sessão do WhatsApp (idem)
 *   manifest.json  versão, contagens e o SHA-256 de cada arquivo: a restauração confere tudo antes de mexer em nada
 *
 * Fica de fora a chave do acesso sem trancamento (unlock.key): o backup só abre com a senha ou a frase de
 * recuperação daquele momento. A criação é síncrona do começo ao fim: o servidor é o único escritor do volume e
 * nada grava no meio da cópia. A restauração roda com o servidor parado (restore-cli.ts) e nunca apaga: o que
 * estava no lugar vai para `backups/pre-restore-<data>`, e `desfazer` traz de volta.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../db/db.ts';

export const BACKUP_FORMAT = 2;
export interface BackupEntry { path: string; bytes: number; sha256: string }
export interface BackupManifest {
  format: number; app: 'ergon'; createdAt: string; version: string; encrypted: boolean;
  /** migrações aplicadas no banco copiado (restaurar numa versão mais nova aplica as que faltarem) */
  migrations: string[];
  /** identidade da chave mestra (não é segredo): diz se o backup é desta instalação */
  keyringCheck: string | null;
  counts: { artifacts: number; files: number; secrets: number; bytes: number };
  /** anexos registrados no banco cujo arquivo já faltava no disco antes do backup (dito, não escondido) */
  missing: string[];
  entries: BackupEntry[];
}
export interface DataPaths { dataDir: string; dbPath: string; filesDir: string; backupsDir: string }

// nomes que o Windows aceita (o backup é copiado para fora do volume); ".." e "." são recusados à parte
const SAFE_ENTRY = /^(db\.sqlite|keyring\.json|(files|secrets)(\/[^/\\\u0000-\u001f<>:"|?*]+)+)$/;
/** o que a restauração troca, nesta ordem; tudo dentro da pasta de dados */
const ITEMS = ['db', 'files', 'secrets', 'keyring.json'] as const;

export function sha256File(file: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { let n: number; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** Arquivos comuns sob `root` (caminhos relativos com "/"); atalhos e arquivos temporários ficam de fora. */
function walk(root: string, rel = ''): string[] {
  const dir = rel ? path.join(root, rel) : root;
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(r);
  }
  return out.sort();
}

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o600);
}

const keyringCheckOf = (file: string): string | null => {
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as { check?: string }).check ?? null; } catch { return null; }
};

/** Faz o backup completo em `backupsDir/ergon-<data>` e confere o que gravou (banco íntegro, hashes). */
export function createBackup(db: Db, p: DataPaths, meta: { version: string; dbKey: Buffer | null }): { name: string; dir: string; manifest: BackupManifest } {
  const name = `ergon-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = path.join(p.backupsDir, name);
  const part = `${dir}.parcial`;
  // backup interrompido antes (processo morto no meio): cópia incompleta, nunca usada — some agora
  if (fs.existsSync(p.backupsDir)) for (const e of fs.readdirSync(p.backupsDir)) if (/^ergon-[\w-]+\.parcial$/.test(e)) fs.rmSync(path.join(p.backupsDir, e), { recursive: true, force: true });
  if (fs.existsSync(dir) || fs.existsSync(part)) throw new Error('já existe um backup com este nome');
  fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  try {
    db.backupTo(path.join(part, 'db.sqlite'));
    const kr = path.join(p.dataDir, 'keyring.json');
    if (fs.existsSync(kr)) copy(kr, path.join(part, 'keyring.json'));
    const sec = path.join(p.dataDir, 'secrets');
    let files = 0; let secrets = 0;
    for (const f of walk(p.filesDir)) { copy(path.join(p.filesDir, f), path.join(part, 'files', f)); files++; }
    for (const f of walk(sec)) { copy(path.join(sec, f), path.join(part, 'secrets', f)); secrets++; }
    const arts = db.raw.prepare('SELECT workspace_id AS ws, storage_key AS k FROM artifacts').all() as Array<{ ws: string; k: string }>;
    const missing = arts.filter((a) => !fs.existsSync(path.join(part, 'files', a.ws, a.k))).map((a) => `${a.ws}/${a.k}`);
    const encrypted = Db.isEncryptedFile(path.join(part, 'db.sqlite'));
    const check = Db.checkFile(path.join(part, 'db.sqlite'), encrypted ? meta.dbKey : null);
    if (!check.ok) throw new Error(`a cópia do banco não passou na conferência: ${check.detail}`);
    for (const x of ['-wal', '-shm']) fs.rmSync(path.join(part, `db.sqlite${x}`), { force: true });
    const entries = walk(part).map((rel) => {
      const f = path.join(part, rel);
      return { path: rel, bytes: fs.statSync(f).size, sha256: sha256File(f) };
    });
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, app: 'ergon', createdAt: new Date().toISOString(), version: meta.version, encrypted,
      migrations: check.migrations, keyringCheck: fs.existsSync(kr) ? keyringCheckOf(kr) : null,
      counts: { artifacts: arts.length, files, secrets, bytes: entries.reduce((n, e) => n + e.bytes, 0) },
      missing, entries,
    };
    fs.writeFileSync(path.join(part, 'manifest.json'), JSON.stringify(manifest, null, 1), { mode: 0o600 });
    const v = verifyBackup(part);
    if (!v.ok) throw new Error(`o backup gravado não confere: ${v.problems.slice(0, 3).join('; ')}`);
    fs.renameSync(part, dir);
    return { name, dir, manifest };
  } catch (e) {
    fs.rmSync(part, { recursive: true, force: true }); // só a cópia incompleta deste backup
    throw e;
  }
}

/** Confere uma pasta de backup: manifesto, caminhos permitidos, tamanho e SHA-256 de cada arquivo. */
export function verifyBackup(dir: string): { ok: boolean; problems: string[]; manifest: BackupManifest | null } {
  let m: BackupManifest;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest; } catch { return { ok: false, problems: ['manifest.json ausente ou ilegível'], manifest: null }; }
  if (m.app !== 'ergon' || m.format !== BACKUP_FORMAT || !Array.isArray(m.entries)) return { ok: false, problems: [`formato de backup desconhecido (${m.format})`], manifest: null };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of m.entries) {
    if (typeof e.path !== 'string' || !SAFE_ENTRY.test(e.path) || e.path.split('/').some((s) => s === '..' || s === '.') || seen.has(e.path)) { problems.push(`caminho não permitido: ${String(e.path).slice(0, 80)}`); continue; }
    seen.add(e.path);
    const f = path.join(dir, ...e.path.split('/'));
    let st: fs.Stats;
    try { st = fs.lstatSync(f); } catch { problems.push(`falta ${e.path}`); continue; }
    if (!st.isFile()) problems.push(`não é um arquivo comum: ${e.path}`);
    else if (st.size !== e.bytes) problems.push(`tamanho diferente: ${e.path}`);
    else if (sha256File(f) !== e.sha256) problems.push(`conteúdo diferente: ${e.path}`);
  }
  if (!seen.has('db.sqlite')) problems.push('o backup não tem o banco');
  return { ok: problems.length === 0, problems, manifest: m };
}

export type KeyRelation = 'mesma' | 'outra' | 'nova' | 'sem';
/** A chave do backup é a desta instalação? 'outra': o cofre do motor daqui foi feito com outra chave. */
export function keyRelation(p: DataPaths, backupCheck: string | null): KeyRelation {
  if (!backupCheck) return 'sem';
  const cur = keyringCheckOf(path.join(p.dataDir, 'keyring.json'));
  return !cur ? 'nova' : cur === backupCheck ? 'mesma' : 'outra';
}

export interface RestoreResult { pre: string; items: string[]; keyring: KeyRelation; from: string; version: string | null; migrations: number }

/**
 * Troca os dados pelos do backup, com o servidor parado. 1) copia e confere tudo numa área de preparo no mesmo
 * volume (falhar aqui não toca em nada); 2) move o atual para `backups/pre-restore-<data>` e põe o restaurado no
 * lugar (renomear é instantâneo; se algo falhar no meio, volta como estava). A chave do acesso sem trancamento fica
 * onde está (é desta máquina) e uma cópia vai junto para o pre-restore.
 *
 * `src`: pasta de backup (formato 2) ou um backup antigo `.sqlite` (só banco e keyring: arquivos e conexões atuais
 * ficam como estão).
 */
export function applyRestore(src: string, p: DataPaths, stamp = new Date().toISOString().replace(/[:.]/g, '-')): RestoreResult {
  const legacy = fs.statSync(src).isFile();
  const staging = path.join(p.dataDir, `.restaurando-${stamp}`);
  const pre = path.join(p.backupsDir, `pre-restore-${stamp}`);
  // restauração interrompida na cópia (antes da troca): a área de preparo sobrou, os dados nem foram tocados
  for (const e of fs.readdirSync(p.dataDir)) if (/^\.restaurando-[\w-]+$/.test(e)) fs.rmSync(path.join(p.dataDir, e), { recursive: true, force: true });
  if (fs.existsSync(staging) || fs.existsSync(pre)) throw new Error('restauração com o mesmo carimbo já existe');
  let check: string | null; let version: string | null = null; let migrations = 0;
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const dbTo = path.join(staging, 'db', path.basename(p.dbPath));
    if (legacy) {
      copy(src, dbTo);
      const kr = `${src}.keyring.json`;
      check = fs.existsSync(kr) ? keyringCheckOf(kr) : null;
      if (fs.existsSync(kr)) copy(kr, path.join(staging, 'keyring.json'));
    } else {
      const v = verifyBackup(src);
      if (!v.ok) throw new Error(`o backup não confere (nada foi alterado): ${v.problems.slice(0, 5).join('; ')}`);
      const m = v.manifest!;
      check = m.keyringCheck; version = m.version; migrations = m.migrations.length;
      for (const e of m.entries) {
        const to = e.path === 'db.sqlite' ? dbTo : path.join(staging, ...e.path.split('/'));
        copy(path.join(src, ...e.path.split('/')), to);
        if (sha256File(to) !== e.sha256) throw new Error(`a cópia de ${e.path} saiu diferente (disco cheio?)`);
      }
      fs.mkdirSync(path.join(staging, 'files'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(staging, 'secrets'), { recursive: true, mode: 0o700 });
    }
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true }); // só a área de preparo desta restauração
    throw e;
  }
  const keyring = keyRelation(p, check);
  const items = ITEMS.filter((it) => fs.existsSync(path.join(staging, it)));
  fs.mkdirSync(pre, { recursive: true, mode: 0o700 });
  // diário antes da troca: se o processo morrer entre uma renomeação e outra, "desfazer" sabe o que juntar
  const journal = (estado: 'trocando' | 'feito', moved: string[]) => fs.writeFileSync(path.join(pre, 'restauracao.json'),
    JSON.stringify({ at: new Date().toISOString(), estado, from: path.basename(src), version, items: moved, placed: items, keyring }, null, 1), { mode: 0o600 });
  journal('trocando', items.filter((it) => fs.existsSync(path.join(p.dataDir, it))));
  const moved: string[] = []; const placed: string[] = [];
  try {
    for (const it of items) { const cur = path.join(p.dataDir, it); if (fs.existsSync(cur)) { fs.renameSync(cur, path.join(pre, it)); moved.push(it); } }
    for (const it of items) { fs.renameSync(path.join(staging, it), path.join(p.dataDir, it)); placed.push(it); }
  } catch (e) {
    let back = true;
    for (const it of placed.reverse()) try { fs.renameSync(path.join(p.dataDir, it), path.join(staging, it)); } catch { back = false; }
    for (const it of moved.reverse()) try { fs.renameSync(path.join(pre, it), path.join(p.dataDir, it)); } catch { back = false; }
    // voltou tudo: o diário sai; não voltou: fica "trocando" (o servidor não sobe e "desfazer" junta o resto)
    if (back) fs.rmSync(path.join(pre, 'restauracao.json'), { force: true });
    throw new Error(back ? `a troca falhou e os dados atuais voltaram ao lugar: ${(e as Error).message}`
      : `a troca falhou e não deu para voltar tudo (${(e as Error).message}); nada foi apagado: rode "desfazer-restauracao ${path.basename(pre)}"`);
  }
  const unlock = path.join(p.dataDir, 'unlock.key');
  if (fs.existsSync(unlock)) copy(unlock, path.join(pre, 'unlock.key'));
  journal('feito', moved);
  fs.rmSync(staging, { recursive: true, force: true }); // já vazia (só pastas)
  return { pre, items, keyring, from: path.basename(src), version, migrations };
}

/**
 * Restauração que parou no meio da troca (processo morto entre uma renomeação e outra)? O servidor não deve subir
 * assim: sem o banco no lugar, viraria uma instalação nova e vazia por cima dos dados guardados.
 */
export function unfinishedRestore(backupsDir: string): string | null {
  if (!fs.existsSync(backupsDir)) return null;
  for (const e of fs.readdirSync(backupsDir).filter((x) => /^pre-restore-[\w-]+$/.test(x)).sort().reverse()) {
    try { if ((JSON.parse(fs.readFileSync(path.join(backupsDir, e, 'restauracao.json'), 'utf8')) as { estado?: string }).estado === 'trocando') return e; } catch { /* sem diário: restauração antiga ou concluída */ }
  }
  return null;
}

/** Desfaz uma restauração: o que ela pôs no lugar vai para `backups/desfeito-<data>` e o anterior volta. */
export function undoRestore(pre: string, p: DataPaths, stamp = new Date().toISOString().replace(/[:.]/g, '-')): { items: string[]; aside: string; motor: boolean } {
  const info = JSON.parse(fs.readFileSync(path.join(pre, 'restauracao.json'), 'utf8')) as { items: string[]; placed: string[] };
  const aside = path.join(p.backupsDir, `desfeito-${stamp}`);
  fs.mkdirSync(aside, { recursive: true, mode: 0o700 });
  // tolera troca pela metade (processo morto no meio): só move o que de fato está em cada lugar
  const known = (x: string) => (ITEMS as readonly string[]).includes(x);
  for (const it of info.placed.filter(known)) {
    const cur = path.join(p.dataDir, it);
    // na troca pela metade, o item ainda no lugar pode ser o original (não foi movido): esse fica
    if (fs.existsSync(cur) && (info.items.includes(it) ? fs.existsSync(path.join(pre, it)) : true)) fs.renameSync(cur, path.join(aside, it));
  }
  for (const it of info.items.filter(known)) { const from = path.join(pre, it); if (fs.existsSync(from)) fs.renameSync(from, path.join(p.dataDir, it)); }
  // a chave do sem trancamento de antes (abrir o restaurado pode ter feito uma nova, para a chave dele)
  const unlock = path.join(p.dataDir, 'unlock.key');
  if (fs.existsSync(path.join(pre, 'unlock.key'))) {
    if (fs.existsSync(unlock)) fs.renameSync(unlock, path.join(aside, 'unlock.key'));
    fs.renameSync(path.join(pre, 'unlock.key'), unlock);
  }
  // desfeita: o diário deixa de valer (o servidor volta a poder subir)
  fs.renameSync(path.join(pre, 'restauracao.json'), path.join(pre, 'restauracao-desfeita.json'));
  // cofre do motor guardado na restauração (backup de outra instalação): o lançador traz de volta (motor-volta)
  return { items: info.items, aside, motor: fs.existsSync(path.join(pre, 'motor')) };
}

/**
 * Cofre do motor feito com outra chave (restaurar o backup de outra instalação): o conteúdo vai inteiro para
 * `dest` (no volume de dados, conferido arquivo por arquivo) e o cofre fica vazio — o motor cria um novo com a chave
 * restaurada. A memória antiga do motor fica guardada em `dest`, não apagada.
 */
export function moveVaultAside(vaultDir: string, dest: string): number {
  if (fs.existsSync(dest)) throw new Error('o destino do cofre antigo já existe; nada foi movido');
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  let n: number;
  try { n = copyTreeExact(vaultDir, dest); } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true }); // só a cópia incompleta
    throw new Error(`${(e as Error).message}; o cofre do motor ficou como estava`);
  }
  for (const e of fs.readdirSync(vaultDir)) fs.rmSync(path.join(vaultDir, e), { recursive: true, force: true });
  return n;
}

/** Desfazer do cofre do motor: o atual vai para `aside` e o guardado em `src` volta, igual (dono e permissões). */
export function moveVaultBack(src: string, vaultDir: string, aside: string): number {
  moveVaultAside(vaultDir, aside);
  let n = 0;
  for (const e of fs.readdirSync(src)) n += copyTreeExact(path.join(src, e), path.join(vaultDir, e));
  return n;
}

/**
 * Copia uma árvore inteira mantendo atalhos, permissões e (como root) o dono: o gocryptfs mostra ao motor os do
 * disco. Cada arquivo é conferido por SHA-256. `to` não pode existir.
 */
function copyTreeExact(from: string, to: string): number {
  const root = process.getuid?.() === 0;
  let n = 0;
  const rec = (src: string, dst: string) => {
    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { mode: 0o700 });
      for (const e of fs.readdirSync(src)) rec(path.join(src, e), path.join(dst, e));
    } else if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dst); n++;
      if (root) fs.lchownSync(dst, st.uid, st.gid);
      return;
    } else if (st.isFile()) {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); n++;
      if (sha256File(dst) !== sha256File(src)) throw new Error(`a cópia de ${path.basename(src)} saiu diferente`);
    } else throw new Error(`tipo de arquivo inesperado no cofre do motor: ${path.basename(src)}`);
    if (root) fs.chownSync(dst, st.uid, st.gid);
    fs.chmodSync(dst, st.mode & 0o7777); // pastas por último: os filhos já foram copiados
  };
  rec(from, to);
  return n;
}
