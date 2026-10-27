/**
 * Chaves do Ergon. Hierarquia (igual no local e na nuvem; só muda a ORIGEM):
 *
 *   origem  →  chave mestra (MK)  →  chave de cada workspace (DEK)  →  dados
 *
 * Local: a MK (aleatória, 256 bits) nunca fica gravada aberta. O "keyring" (arquivo no volume de dados,
 * fora do banco) guarda a MK cifrada várias vezes: pela senha de cada usuário (Argon2id), pela frase de
 * recuperação (24 palavras, mostrada uma vez) e, se o usuário quiser, por uma chave aleatória que o
 * computador guarda no cofre do sistema (destrancar sozinho ao entrar). Trocar a senha só recifra a MK.
 * Sem trancamento (escolha do usuário, padrão no local): a chave de um embrulho "aberto" fica num arquivo ao lado dos
 * dados (unlock.key); o Ergon abre sozinho ao reiniciar e a proteção passa a ser a do computador.
 * Nuvem: a origem passa a ser um cofre de chaves gerenciado (KMS), por cliente — `WorkspaceKeySource`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/portuguese.js';
import { HttpError, id, now } from '../lib/util.ts';
import { KDF_STRONG, argon2id, b64u, decrypt, encrypt, fromB64u, hkdf, randomKey, timingSafeEq, type KdfParams } from './crypto.ts';

/** 'mk': chave pessoal embrulhada pela MK — só enquanto há uma pessoa só na instalação (ver Vault). */
export type WrapType = 'password' | 'recovery' | 'auto' | 'mk';
export interface Wrap {
  id: string; type: WrapType;
  /** 'open': embrulho do acesso sem trancamento (chave em unlock.key); sem isto, é o do ajudante do computador */
  purpose?: 'open';
  /** dono da senha (o banco ainda está fechado quando a senha chega: o usuário fica aqui, sem segredo) */
  userId?: string; username?: string;
  salt?: string; kdf?: KdfParams; blob: string; createdAt: string; label?: string;
}
/**
 * Parte de uma pessoa no keyring: a chave pessoal (PK) embrulhada pela senha, pela frase e (opcional) pelo cofre do
 * sistema dela; `mk` é a MK cifrada pela PK (quem abre a própria parte também abre a instalação depois de reiniciar).
 */
export interface PersonEntry { username: string; check: string; mk: string; wraps: Wrap[]; createdAt: string }
export interface KeyringFile { v: 1 | 2; createdAt: string; check: string; wraps: Wrap[]; people?: Record<string, PersonEntry> }

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().trim();

/** Frase de recuperação: 24 palavras (lista oficial BIP-39 em português), 256 bits de entropia. */
export const RECOVERY_WORDS = 24;
export function newRecoveryPhrase(): string { return generateMnemonic(wordlist, 256); }
/** Aceita a frase como a pessoa digitar: acentos, maiúsculas e espaços extras não importam. */
export function normalizePhrase(input: string): string | null {
  const byFold = new Map(wordlist.map((w) => [fold(w), w]));
  const words = input.split(/\s+/).map((w) => byFold.get(fold(w))).filter((w): w is string => !!w);
  const phrase = words.join(' ');
  return words.length === RECOVERY_WORDS && validateMnemonic(phrase, wordlist) ? phrase : null;
}
const phraseSecret = (phrase: string) => Buffer.from(mnemonicToEntropy(phrase, wordlist)).toString('hex');

/** Arquivo do keyring (volume de dados; legível só pelo servidor). Gravação atômica. */
export class Keyring {
  readonly file: string;
  private readonly kdf: KdfParams;
  constructor(dataDir: string, kdf: KdfParams = KDF_STRONG) { this.file = path.join(dataDir, 'keyring.json'); this.kdf = kdf; }
  exists(): boolean { return fs.existsSync(this.file); }
  load(): KeyringFile { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as KeyringFile; }
  save(k: KeyringFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(k, null, 1), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  static check(mk: Buffer): string { return b64u(hkdf(mk, 'ergon/keyring-check/v1').subarray(0, 16)); }
  static personCheck(pk: Buffer): string { return b64u(hkdf(pk, 'ergon/person-check/v1').subarray(0, 16)); }
  verify(k: KeyringFile, mk: Buffer): boolean { return timingSafeEq(Buffer.from(k.check), Buffer.from(Keyring.check(mk))); }

  // `scope` entra no contexto (AAD): "keyring" para a MK, "person/<usuário>" para a chave de cada pessoa — um
  // embrulho não serve no lugar de outro
  async wrapSecret(key: Buffer, type: 'password' | 'recovery', secret: string, user?: { id: string; username: string }, scope = 'keyring'): Promise<Wrap> {
    const salt = randomKey().subarray(0, 16);
    const kek = await argon2id(secret, salt, this.kdf);
    const wid = id('wrp');
    return { id: wid, type, userId: user?.id, username: user?.username, salt: b64u(salt), kdf: this.kdf, blob: b64u(encrypt(kek, key, `${scope}/${wid}`)), createdAt: now() };
  }
  wrapKey(key: Buffer, kek: Buffer, type: 'auto' | 'mk', label: string, purpose?: 'open', scope = 'keyring'): Wrap {
    const wid = id('wrp');
    return { id: wid, type, blob: b64u(encrypt(kek, key, `${scope}/${wid}`)), createdAt: now(), label, ...(purpose ? { purpose } : {}) };
  }
  async openSecret(w: Wrap, secret: string, scope = 'keyring'): Promise<Buffer | null> {
    if (!w.salt || !w.kdf) return null;
    const kek = await argon2id(secret, fromB64u(w.salt), w.kdf);
    try { return decrypt(kek, fromB64u(w.blob), `${scope}/${w.id}`); } catch { return null; }
  }
  openKey(w: Wrap, kek: Buffer, scope = 'keyring'): Buffer | null {
    try { return decrypt(kek, fromB64u(w.blob), `${scope}/${w.id}`); } catch { return null; }
  }
}

/** A parte da pessoa está fechada (ela ainda não entrou desde que o Ergon reiniciou): não se lê nem se grava. */
export class PersonSealedError extends HttpError {
  readonly userId: string;
  constructor(userId: string) { super(423, 'person_sealed', 'Digite a sua senha para abrir os seus dados.'); this.userId = userId; }
}
const personScope = (userId: string) => `person/${userId}`;

/**
 * Origem das chaves de workspace. Local: embrulhadas pela MK. Nuvem: por um KMS (uma chave por cliente;
 * implementação futura com o mesmo contrato). Síncrona de propósito: o banco decifra campos na leitura;
 * na nuvem, as DEKs de um cliente são desembrulhadas ao ativar o cliente e ficam em memória.
 */
export interface WorkspaceKeySource {
  readonly name: string;
  wrapDek(workspaceId: string, dek: Buffer): string;
  unwrapDek(workspaceId: string, wrapped: string): Buffer;
  /** chave para dados sem workspace (ex.: auditoria de sistema) */
  instanceKey(): Buffer;
}

export class LocalKeySource implements WorkspaceKeySource {
  readonly name = 'local';
  private readonly wrapKey: Buffer;
  private readonly inst: Buffer;
  constructor(mk: Buffer) { this.wrapKey = hkdf(mk, 'ergon/dek-wrap/v1'); this.inst = hkdf(mk, 'ergon/instance-fields/v1'); }
  wrapDek(ws: string, dek: Buffer): string { return `lk1.${b64u(encrypt(this.wrapKey, dek, `dek/${ws}`))}`; }
  unwrapDek(ws: string, wrapped: string): Buffer {
    if (!wrapped.startsWith('lk1.')) throw new Error('chave de workspace em formato desconhecido');
    return decrypt(this.wrapKey, fromB64u(wrapped.slice(4)), `dek/${ws}`);
  }
  instanceKey(): Buffer { return this.inst; }
}

/**
 * Local com várias pessoas: a DEK de cada workspace é embrulhada pela chave pessoal (PK) de quem é dono dele, não pela
 * MK. Quem tem só a MK (outra pessoa, o arquivo do acesso sem trancamento) abre o banco, mas não o conteúdo. Formato
 * `pk1.<usuário>.<cifrado>`; DEKs antigas (`lk1.`, pela MK) ainda abrem, para a migração reembrulhá-las.
 */
export class PersonKeySource implements WorkspaceKeySource {
  readonly name = 'person';
  private readonly vault: Vault;
  private readonly ownerOf: (workspaceId: string) => string | null;
  private readonly legacy: LocalKeySource;
  /** workspace sendo criado agora (antes de existir o vínculo de dono): de quem ele é */
  private creator: string | null = null;
  constructor(vault: Vault, mk: Buffer, ownerOf: (workspaceId: string) => string | null) {
    this.vault = vault; this.ownerOf = ownerOf; this.legacy = new LocalKeySource(mk);
  }
  /** Cria o workspace de uma pessoa: as DEKs que nascerem em `fn` (antes do vínculo de dono) são dela. */
  withCreator<T>(userId: string, fn: () => T): T {
    const before = this.creator; this.creator = userId;
    try { return fn(); } finally { this.creator = before; }
  }
  private owner(ws: string): string {
    const u = this.ownerOf(ws) ?? this.creator;
    if (!u) throw new HttpError(500, 'workspace_owner', 'workspace sem dono');
    return u;
  }
  private pk(userId: string): Buffer {
    const pk = this.vault.personKey(userId);
    if (!pk) throw new PersonSealedError(userId);
    return pk;
  }
  wrapDek(ws: string, dek: Buffer): string {
    const u = this.owner(ws);
    return `pk1.${u}.${b64u(encrypt(hkdf(this.pk(u), 'ergon/dek-wrap/v2'), dek, `dek/${ws}`))}`;
  }
  unwrapDek(ws: string, wrapped: string): Buffer {
    if (wrapped.startsWith('lk1.')) return this.legacy.unwrapDek(ws, wrapped);
    const m = /^pk1\.(usr_[a-f0-9]{32})\.(.+)$/.exec(wrapped);
    if (!m) throw new Error('chave de workspace em formato desconhecido');
    return decrypt(hkdf(this.pk(m[1]), 'ergon/dek-wrap/v2'), fromB64u(m[2]), `dek/${ws}`);
  }
  /** Pessoa da DEK gravada (null: DEK antiga, da MK). */
  static personOf(wrapped: string): string | null { return /^pk1\.(usr_[a-f0-9]{32})\./.exec(wrapped)?.[1] ?? null; }
  instanceKey(): Buffer { return this.legacy.instanceKey(); }
}

export type VaultState = 'unprotected' | 'sealed' | 'open';

/**
 * Cofre da instância: estado (sem proteção / selado / aberto), destrancar por senha, frase ou chave do
 * cofre do sistema, e as subchaves derivadas da MK (banco, volume do motor de IA, campos).
 * Depois de aberto, a MK fica só na memória do processo: os agentes seguem trabalhando com a tela trancada.
 */
export class Vault {
  readonly keyring: Keyring;
  private mk: Buffer | null = null;
  private pendingPhrase: { phrase: string; at: number } | null = null;

  constructor(dataDir: string, kdf: KdfParams = KDF_STRONG) { this.keyring = new Keyring(dataDir, kdf); }

  state(): VaultState { return !this.keyring.exists() ? 'unprotected' : this.mk ? 'open' : 'sealed'; }
  private need(): Buffer { if (!this.mk) throw new HttpError(423, 'sealed', 'o Ergon está trancado'); return this.mk; }
  dbKey(): Buffer { return hkdf(this.need(), 'ergon/db/v1'); }
  /** chave do volume cifrado do motor de IA (gocryptfs), em hexadecimal */
  hermesKey(): string { return hkdf(this.need(), 'ergon/hermes-vault/v1').toString('hex'); }
  keySource(): WorkspaceKeySource { return new LocalKeySource(this.need()); }

  info(): { protected: boolean; recovery: boolean; auto: Array<{ id: string; label: string; createdAt: string }>; users: string[] } {
    if (!this.keyring.exists()) return { protected: false, recovery: false, auto: [], users: [] };
    const k = this.keyring.load();
    return {
      protected: true, recovery: k.wraps.some((w) => w.type === 'recovery'),
      auto: k.wraps.filter((w) => w.type === 'auto' && w.purpose !== 'open').map((w) => ({ id: w.id, label: w.label ?? '', createdAt: w.createdAt })),
      users: k.wraps.filter((w) => w.type === 'password').map((w) => w.username ?? ''),
    };
  }

  private adopt(mk: Buffer): void {
    const k = this.keyring.load();
    if (!this.keyring.verify(k, mk)) throw new HttpError(500, 'keyring', 'chave mestra não confere com o keyring');
    this.mk = mk;
  }

  /** Destrancar com a senha (o usuário vem do keyring: o banco ainda está fechado). Abre também a parte dela. */
  async unsealPassword(username: string, password: string): Promise<{ userId: string } | null> {
    const k = this.keyring.load();
    // a parte da pessoa primeiro: a senha abre a chave pessoal e, pela MK guardada nela, a instalação
    for (const [uid, e] of Object.entries(k.people ?? {}).filter(([, e]) => e.username === username)) {
      const pk = await this.openPersonWrap(uid, e, 'password', password);
      if (pk) { this.adopt(this.mkFromPerson(uid, e, pk)); this.adoptPerson(uid, e, pk); this.openPeopleByMk(); return { userId: uid }; }
    }
    for (const w of k.wraps.filter((x) => x.type === 'password' && x.username === username)) {
      const mk = await this.keyring.openSecret(w, password);
      if (mk) { this.adopt(mk); this.openPeopleByMk(); return { userId: w.userId! }; }
    }
    return null;
  }
  /** Destrancar com a frase: a frase pessoal (abre a parte da pessoa e a instalação) ou a da instalação (versões antigas). */
  async unsealRecovery(input: string): Promise<boolean> {
    const phrase = normalizePhrase(input);
    if (!phrase) return false;
    const k = this.keyring.load();
    for (const [uid, e] of Object.entries(k.people ?? {})) {
      const pk = await this.openPersonWrap(uid, e, 'recovery', phraseSecret(phrase));
      if (pk) { this.adopt(this.mkFromPerson(uid, e, pk)); this.adoptPerson(uid, e, pk); this.openPeopleByMk(); return true; }
    }
    const w = k.wraps.find((x) => x.type === 'recovery');
    const mk = w ? await this.keyring.openSecret(w, phraseSecret(phrase)) : null;
    if (!mk) return false;
    this.adopt(mk);
    this.openPeopleByMk();
    return true;
  }

  // ---------- a parte de cada pessoa (chave pessoal, PK) ----------
  // Só na memória do processo, como a MK: aberta, os agentes da pessoa seguem trabalhando com a tela trancada.
  private readonly pks = new Map<string, Buffer>();
  private readonly pendingPersonPhrase = new Map<string, { phrase: string; at: number }>();
  private peopleOf(k?: KeyringFile): Record<string, PersonEntry> { return (k ?? (this.keyring.exists() ? this.keyring.load() : null))?.people ?? {}; }
  hasPerson(userId: string): boolean { return !!this.peopleOf()[userId]; }
  personKey(userId: string): Buffer | null { return this.pks.get(userId) ?? null; }
  personOpen(userId: string): boolean { return this.pks.has(userId); }
  /** Mais de uma pessoa: as chaves pessoais não se abrem mais pela MK (isolamento entre elas). */
  multiPerson(): boolean { return Object.keys(this.peopleOf()).length > 1; }
  personHasRecovery(userId: string): boolean { return !!this.peopleOf()[userId]?.wraps.some((w) => w.type === 'recovery'); }
  /** Origem das chaves de workspace pela pessoa dona (ver PersonKeySource). */
  personKeySource(ownerOf: (workspaceId: string) => string | null): PersonKeySource { return new PersonKeySource(this, this.need(), ownerOf); }
  /** Chave do cofre do motor de IA da pessoa (gocryptfs), em hexadecimal. */
  motorKey(userId: string): string {
    const pk = this.pks.get(userId);
    if (!pk) throw new PersonSealedError(userId);
    return hkdf(pk, 'ergon/motor-vault/v1').toString('hex');
  }

  private adoptPerson(userId: string, e: PersonEntry, pk: Buffer): void {
    if (!timingSafeEq(Buffer.from(e.check), Buffer.from(Keyring.personCheck(pk)))) throw new HttpError(500, 'keyring', 'chave pessoal não confere com o keyring');
    this.pks.set(userId, pk);
  }
  private mkFromPerson(userId: string, e: PersonEntry, pk: Buffer): Buffer {
    return decrypt(hkdf(pk, 'ergon/person-mk/v1'), fromB64u(e.mk), `${personScope(userId)}/mk`);
  }
  private async openPersonWrap(userId: string, e: PersonEntry, type: 'password' | 'recovery', secret: string): Promise<Buffer | null> {
    for (const w of e.wraps.filter((x) => x.type === type)) {
      const pk = await this.keyring.openSecret(w, secret, personScope(userId));
      if (pk) return pk;
    }
    return null;
  }

  /**
   * Cria a chave pessoal (conta nova, ou a primeira senha digitada numa instalação de antes desta versão). Com uma
   * pessoa só, a MK também abre a parte dela (nada muda para quem usa sozinho). A partir da segunda, ninguém mais se
   * abre pela MK: cada parte só pela senha, pela frase ou pelo cofre do sistema da própria pessoa — por isso quem já
   * está aqui precisa ter a frase pessoal antes.
   */
  async createPerson(user: { id: string; username: string }, password: string): Promise<void> {
    const mk = this.need();
    const k = this.keyring.load();
    const others = Object.entries(k.people ?? {});
    if (k.people?.[user.id]) throw new HttpError(409, 'person_exists', 'a pessoa já tem a chave dela');
    if (others.some(([, e]) => !e.wraps.some((w) => w.type === 'recovery'))) {
      throw new HttpError(409, 'others_without_phrase', 'Quem já usa este computador precisa gerar a frase pessoal antes de outra pessoa criar conta.');
    }
    const pk = randomKey();
    const scope = personScope(user.id);
    const wraps: Wrap[] = [await this.keyring.wrapSecret(pk, 'password', password, user, scope)];
    if (!others.length) wraps.push(this.keyring.wrapKey(pk, hkdf(mk, 'ergon/person-wrap/v1'), 'mk', 'instalação com uma pessoa só', undefined, scope));
    const people: Record<string, PersonEntry> = {};
    // a segunda pessoa chegou: as partes de quem já estava deixam de abrir pela MK
    for (const [uid, e] of others) people[uid] = { ...e, wraps: e.wraps.filter((w) => w.type !== 'mk') };
    people[user.id] = { username: user.username, check: Keyring.personCheck(pk), mk: b64u(encrypt(hkdf(pk, 'ergon/person-mk/v1'), mk, `${scope}/mk`)), wraps, createdAt: now() };
    this.keyring.save({ ...k, v: 2, people });
    this.pks.set(user.id, pk);
  }

  /** Abre a parte da pessoa com a senha (a MK já aberta). */
  async openPerson(userId: string, password: string): Promise<boolean> {
    if (this.pks.has(userId)) return true;
    const e = this.peopleOf()[userId];
    if (!e) return false;
    const pk = await this.openPersonWrap(userId, e, 'password', password);
    if (!pk) return false;
    this.adoptPerson(userId, e, pk);
    this.aloneAgain(); // a última pessoa que sobrou, se a conta de outra saiu com ela fechada
    return true;
  }

  /** Uma pessoa só: abre a parte dela pela MK (ao subir sem trancamento, ou depois de destrancar). */
  openPeopleByMk(): number {
    if (!this.mk || !this.keyring.exists()) return 0;
    let n = 0;
    for (const [uid, e] of Object.entries(this.peopleOf())) {
      if (this.pks.has(uid)) continue;
      for (const w of e.wraps.filter((x) => x.type === 'mk')) {
        const pk = this.keyring.openKey(w, hkdf(this.mk, 'ergon/person-wrap/v1'), personScope(uid));
        if (pk) { this.adoptPerson(uid, e, pk); n++; break; }
      }
    }
    return n;
  }

  /** Senha nova da pessoa: reembrulha a parte dela e o acesso à instalação (a parte precisa estar aberta). */
  async setPersonPassword(user: { id: string; username: string }, password: string): Promise<void> {
    const k = this.keyring.load();
    const e = k.people?.[user.id];
    if (e) {
      const pk = this.pks.get(user.id);
      if (!pk) throw new PersonSealedError(user.id);
      const w = await this.keyring.wrapSecret(pk, 'password', password, user, personScope(user.id));
      k.people![user.id] = { ...e, wraps: [...e.wraps.filter((x) => x.type !== 'password'), w] };
      this.keyring.save(k);
    }
    await this.setPassword(user, password);
  }

  /** Frase pessoal nova: mostrada uma vez; só vale depois que a pessoa confirma 3 palavras. */
  newPersonRecovery(userId: string): { phrase: string; ask: number[] } {
    if (!this.pks.has(userId)) throw new PersonSealedError(userId);
    const phrase = newRecoveryPhrase();
    this.pendingPersonPhrase.set(userId, { phrase, at: Date.now() });
    const ask = new Set<number>();
    while (ask.size < 3) ask.add(1 + crypto.randomInt(RECOVERY_WORDS));
    return { phrase, ask: [...ask].sort((a, b) => a - b) };
  }
  async confirmPersonRecovery(userId: string, answers: Record<string, string>): Promise<boolean> {
    const p = this.pendingPersonPhrase.get(userId);
    if (!p || Date.now() - p.at > 30 * 60_000) throw new HttpError(409, 'no_pending', 'gere a frase de novo');
    const words = p.phrase.split(' ');
    const entries = Object.entries(answers);
    if (entries.length < 3 || entries.some(([pos, w]) => fold(words[Number(pos) - 1] ?? '\u0000') !== fold(w))) return false;
    const pk = this.pks.get(userId);
    if (!pk) throw new PersonSealedError(userId);
    const k = this.keyring.load();
    const e = k.people?.[userId];
    if (!e) throw new HttpError(409, 'no_person', 'a pessoa ainda não tem a chave dela');
    const w = await this.keyring.wrapSecret(pk, 'recovery', phraseSecret(p.phrase), { id: userId, username: e.username }, personScope(userId));
    k.people![userId] = { ...e, wraps: [...e.wraps.filter((x) => x.type !== 'recovery'), w] };
    // a frase da instalação (versões antigas, de uma pessoa só) deixa de valer: a pessoal abre a parte e a instalação
    k.wraps = k.wraps.filter((x) => x.type !== 'recovery');
    this.keyring.save(k);
    this.pendingPersonPhrase.delete(userId);
    return true;
  }
  /** Confere a frase de uma pessoa com o Ergon aberto (senha esquecida): abre a parte dela. */
  async openPersonRecovery(userId: string, input: string): Promise<boolean> {
    const phrase = normalizePhrase(input);
    const e = this.peopleOf()[userId];
    if (!phrase || !e) return false;
    if (!e.wraps.some((w) => w.type === 'recovery')) {
      // ainda sem frase pessoal (instalação de uma pessoa só): vale a frase da instalação, e a MK abre a parte
      if (!(await this.checkRecovery(input))) return false;
      return this.openPeopleByMk() > 0 || this.pks.has(userId);
    }
    const pk = await this.openPersonWrap(userId, e, 'recovery', phraseSecret(phrase));
    if (!pk) return false;
    this.adoptPerson(userId, e, pk);
    return true;
  }

  /** Abrir a parte sozinha pelo cofre do sistema da conta do computador da pessoa (o ajudante guarda a chave). */
  enrollPersonAuto(userId: string, label: string): { id: string; key: string } {
    const pk = this.pks.get(userId);
    if (!pk) throw new PersonSealedError(userId);
    const kek = randomKey();
    const k = this.keyring.load();
    const e = k.people?.[userId];
    if (!e) throw new HttpError(409, 'no_person', 'a pessoa ainda não tem a chave dela');
    const w = this.keyring.wrapKey(pk, kek, 'auto', label.slice(0, 60), undefined, personScope(userId));
    k.people![userId] = { ...e, wraps: [...e.wraps.filter((x) => x.type !== 'auto'), w] };
    this.keyring.save(k);
    return { id: w.id, key: kek.toString('hex') };
  }
  disablePersonAuto(userId: string): number {
    const k = this.keyring.load();
    const e = k.people?.[userId];
    if (!e) return 0;
    const before = e.wraps.length;
    k.people![userId] = { ...e, wraps: e.wraps.filter((x) => x.type !== 'auto') };
    this.keyring.save(k);
    return before - k.people![userId].wraps.length;
  }
  /** Com a instalação aberta: a chave do cofre do sistema abre a parte de uma pessoa. Devolve quem abriu. */
  openPersonAuto(keyHex: string): string | null {
    if (!this.mk || !/^[0-9a-f]{64}$/i.test(keyHex)) return null;
    const kek = Buffer.from(keyHex, 'hex');
    for (const [uid, e] of Object.entries(this.peopleOf())) {
      for (const w of e.wraps.filter((x) => x.type === 'auto')) {
        const pk = this.keyring.openKey(w, kek, personScope(uid));
        if (pk) { this.adoptPerson(uid, e, pk); return uid; }
      }
    }
    return null;
  }
  personAutoIds(userId: string): string[] { return (this.peopleOf()[userId]?.wraps ?? []).filter((w) => w.type === 'auto').map((w) => w.id); }

  /** Conta removida: a parte dela some do keyring (o conteúdo fica ilegível na hora) e a senha dela não abre mais nada. */
  removePerson(userId: string): void {
    const k = this.keyring.load();
    const people = { ...(k.people ?? {}) };
    delete people[userId];
    this.keyring.save({ ...k, people, wraps: k.wraps.filter((w) => w.userId !== userId) });
    this.pks.delete(userId);
    this.pendingPersonPhrase.delete(userId);
    this.aloneAgain();
  }
  /**
   * Voltou a ser uma pessoa só (as outras contas saíram): não há mais de quem isolar, e a parte dela volta a abrir pela
   * MK como no começo (sem trancamento, abre sozinha ao reiniciar). Só com a parte aberta (é a chave dela que se embrulha).
   */
  aloneAgain(): boolean {
    if (!this.mk || !this.keyring.exists()) return false;
    const k = this.keyring.load();
    const people = Object.entries(k.people ?? {});
    if (people.length !== 1) return false;
    const [uid, e] = people[0];
    const pk = this.pks.get(uid);
    if (!pk || e.wraps.some((w) => w.type === 'mk')) return false;
    const w = this.keyring.wrapKey(pk, hkdf(this.mk, 'ergon/person-wrap/v1'), 'mk', 'instalação com uma pessoa só', undefined, personScope(uid));
    this.keyring.save({ ...k, people: { [uid]: { ...e, wraps: [...e.wraps, w] } } });
    return true;
  }

  /** Resumo por pessoa (sem segredo): para a tela e o diagnóstico. */
  peopleInfo(): Array<{ userId: string; username: string; recovery: boolean; auto: boolean; open: boolean; byMk: boolean }> {
    return Object.entries(this.peopleOf()).map(([userId, e]) => ({
      userId, username: e.username, recovery: e.wraps.some((w) => w.type === 'recovery'), auto: e.wraps.some((w) => w.type === 'auto'),
      open: this.pks.has(userId), byMk: e.wraps.some((w) => w.type === 'mk'),
    }));
  }
  /** Confere a frase sem mudar o estado (recuperar a senha com o Ergon já aberto). */
  async checkRecovery(input: string): Promise<boolean> {
    const phrase = normalizePhrase(input);
    if (!phrase || !this.keyring.exists()) return false;
    const w = this.keyring.load().wraps.find((x) => x.type === 'recovery');
    const mk = w ? await this.keyring.openSecret(w, phraseSecret(phrase)) : null;
    return !!mk && this.keyring.verify(this.keyring.load(), mk);
  }
  /** Chave do cofre do sistema (ajudante): a da instalação, ou a da parte de uma pessoa (que também abre a instalação). */
  unsealAuto(keyHex: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) return false;
    const kek = Buffer.from(keyHex, 'hex');
    const k = this.keyring.load();
    for (const w of k.wraps.filter((x) => x.type === 'auto')) {
      const mk = this.keyring.openKey(w, kek);
      if (mk) { if (!this.mk) this.adopt(mk); this.openPeopleByMk(); return true; }
    }
    for (const [uid, e] of Object.entries(k.people ?? {})) {
      for (const w of e.wraps.filter((x) => x.type === 'auto')) {
        const pk = this.keyring.openKey(w, kek, personScope(uid));
        if (!pk) continue;
        if (!this.mk) this.adopt(this.mkFromPerson(uid, e, pk));
        this.adoptPerson(uid, e, pk);
        this.openPeopleByMk();
        return true;
      }
    }
    return false;
  }

  /** Proteger: cria a MK e o keyring com a senha do usuário. A frase vem a seguir (newRecovery + confirm). */
  async protect(user: { id: string; username: string }, password: string): Promise<void> {
    if (this.keyring.exists()) throw new HttpError(409, 'already_protected', 'o Ergon já está protegido');
    const mk = randomKey();
    const w = await this.keyring.wrapSecret(mk, 'password', password, user);
    this.keyring.save({ v: 1, createdAt: now(), check: Keyring.check(mk), wraps: [w] });
    this.mk = mk;
  }

  /** Senha nova (ou de outro usuário): substitui o embrulho daquele usuário. */
  async setPassword(user: { id: string; username: string }, password: string): Promise<void> {
    const mk = this.need();
    const k = this.keyring.load();
    const w = await this.keyring.wrapSecret(mk, 'password', password, user);
    k.wraps = [...k.wraps.filter((x) => !(x.type === 'password' && x.userId === user.id)), w];
    this.keyring.save(k);
  }

  /** Frase nova: mostrada uma vez; só vale depois que a pessoa confirma 3 palavras (confirmRecovery). */
  newRecovery(): { phrase: string; ask: number[] } {
    this.need();
    const phrase = newRecoveryPhrase();
    this.pendingPhrase = { phrase, at: Date.now() };
    const ask = new Set<number>();
    while (ask.size < 3) ask.add(1 + crypto.randomInt(RECOVERY_WORDS));
    return { phrase, ask: [...ask].sort((a, b) => a - b) };
  }
  async confirmRecovery(answers: Record<string, string>): Promise<boolean> {
    const p = this.pendingPhrase;
    if (!p || Date.now() - p.at > 30 * 60_000) throw new HttpError(409, 'no_pending', 'gere a frase de novo');
    const words = p.phrase.split(' ');
    const entries = Object.entries(answers);
    if (entries.length < 3 || entries.some(([pos, w]) => fold(words[Number(pos) - 1] ?? '\u0000') !== fold(w))) return false;
    const mk = this.need();
    const k = this.keyring.load();
    const w = await this.keyring.wrapSecret(mk, 'recovery', phraseSecret(p.phrase));
    k.wraps = [...k.wraps.filter((x) => x.type !== 'recovery'), w];
    this.keyring.save(k);
    this.pendingPhrase = null;
    return true;
  }

  /** Destrancar sozinho (cofre do sistema): devolve a chave UMA vez; o lançador a guarda no computador. */
  enrollAuto(label: string): { id: string; key: string } {
    const mk = this.need();
    const kek = randomKey();
    const k = this.keyring.load();
    const w = this.keyring.wrapKey(mk, kek, 'auto', label.slice(0, 60));
    k.wraps = [...k.wraps, w];
    this.keyring.save(k);
    return { id: w.id, key: kek.toString('hex') };
  }
  disableAuto(wrapId?: string): number {
    const k = this.keyring.load();
    const before = k.wraps.length;
    k.wraps = k.wraps.filter((x) => !(x.type === 'auto' && x.purpose !== 'open' && (!wrapId || x.id === wrapId)));
    this.keyring.save(k);
    return before - k.wraps.length;
  }

  // ---------- sem trancamento: a chave fica ao lado dos dados ----------
  private openFile(): string { return path.join(path.dirname(this.keyring.file), 'unlock.key'); }
  private openKeyHex(): string | null {
    try { const s = fs.readFileSync(this.openFile(), 'utf8').trim(); return /^[0-9a-f]{64}$/i.test(s) ? s : null; } catch { return null; }
  }
  private openMemo: boolean | null = null;
  /** Ligado = existe o arquivo e um embrulho "aberto" que ele abre (lembrado; muda só pelos métodos abaixo). */
  openAccess(): boolean {
    if (this.openMemo !== null) return this.openMemo;
    const hex = this.openKeyHex();
    if (!hex || !this.keyring.exists()) return (this.openMemo = false);
    const kek = Buffer.from(hex, 'hex');
    return (this.openMemo = this.keyring.load().wraps.some((w) => w.type === 'auto' && w.purpose === 'open' && !!this.keyring.openKey(w, kek)));
  }
  /** Desliga o trancamento (Ergon aberto): embrulho novo, chave gravada só para o servidor (0600), troca atômica. */
  enableOpenAccess(): void {
    const mk = this.need();
    const kek = randomKey();
    const k = this.keyring.load();
    k.wraps = [...k.wraps.filter((x) => !(x.type === 'auto' && x.purpose === 'open')), this.keyring.wrapKey(mk, kek, 'auto', 'sem trancamento (chave neste computador)', 'open')];
    const f = this.openFile();
    fs.writeFileSync(`${f}.tmp`, kek.toString('hex'), { mode: 0o600 });
    this.keyring.save(k);
    fs.renameSync(`${f}.tmp`, f);
    this.openMemo = true;
  }
  /** Liga o trancamento: o embrulho aberto sai do keyring e a chave é apagada do disco. */
  disableOpenAccess(): void {
    if (this.keyring.exists()) {
      const k = this.keyring.load();
      k.wraps = k.wraps.filter((x) => !(x.type === 'auto' && x.purpose === 'open'));
      this.keyring.save(k);
    }
    fs.rmSync(this.openFile(), { force: true });
    this.openMemo = false;
  }
  /** Ao iniciar: sem trancamento, abre sozinho (a chave ao lado dos dados). */
  unsealOpenAccess(): boolean {
    const hex = this.openKeyHex();
    if (!hex) return false;
    const kek = Buffer.from(hex, 'hex');
    for (const w of this.keyring.load().wraps.filter((x) => x.type === 'auto' && x.purpose === 'open')) {
      const mk = this.keyring.openKey(w, kek);
      // abre a instalação; com uma pessoa só, a parte dela também (com várias, cada uma abre a sua ao entrar)
      if (mk) { this.adopt(mk); this.openPeopleByMk(); return true; }
    }
    return false;
  }
}
