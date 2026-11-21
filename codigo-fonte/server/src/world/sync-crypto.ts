/**
 * Criptografia do World Sync no APARELHO. O servidor do World recebe só
 * cifrado, envelopes opacos e assinaturas; a chave do workspace (DEK do Sync) nunca sai em claro do aparelho.
 *
 * - Envelope por aparelho: X25519 efêmera + HKDF-SHA256 → AES-256-GCM (amarrado ao workspace e à versão da chave).
 * - Envelope de recuperação: scrypt da frase de recuperação da pessoa → AES-256-GCM (aparelho novo sem nenhum outro
 *   ligado). Ou, se a pessoa escolher (rc.42), Argon2id da senha do Ergon World com rótulo e sal próprios → AES-256-GCM
 *   (formato v2, `by: 'world'`). A troca, dita na tela: o World guarda este envelope E vê a senha no login, então em
 *   tese conseguiria abri-lo; a frase não tem essa troca. A derivação é separada de qualquer outra feita com a senha.
 * - Alteração: AES-256-GCM com a DEK; dados associados = workspace, operação, versão da chave e do esquema e, no formato
 *   v2 (rc.41), também o TIPO da mudança e o APARELHO que a mandou: o World (que guarda e entrega) não consegue reetiquetar
 *   uma mudança como de outro tipo nem como de outro aparelho. O formato v1 ainda abre para os tipos que já existiam
 *   (mudanças gravadas antes); 'conexoes' só abre no v2.
 * - Assinatura: Ed25519 do aparelho sobre o envelope canônico (o servidor confere quem mandou o quê).
 */
import crypto from 'node:crypto';
import { argon2id, type KdfParams } from '../security/crypto.ts';

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

export const newWorkspaceKey = (): Buffer => crypto.randomBytes(32);

function gcm(key: Buffer, plain: Buffer, aad: string) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { nonce: b64(nonce), ct: b64(Buffer.concat([ct, c.getAuthTag()])) };
}
function ungcm(key: Buffer, nonce: string, ctTag: string, aad: string): Buffer {
  const raw = unb64(ctTag);
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(nonce)); d.setAAD(Buffer.from(aad)); d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
}

export function wrapForDevice(dek: Buffer, devicePublicSpkiB64: string, ws: string, keyVersion: number): string {
  const devPub = crypto.createPublicKey({ key: unb64(devicePublicSpkiB64), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: devPub });
  const ephPub = eph.publicKey.export({ format: 'der', type: 'spki' });
  const kek = Buffer.from(crypto.hkdfSync('sha256', shared, ephPub, `ergon/sync-envelope/v1|${ws}|${keyVersion}`, 32));
  const e = gcm(kek, dek, `ergon/sync-envelope/v1|${ws}|${keyVersion}`);
  return JSON.stringify({ v: 1, kind: 'device', eph: b64(ephPub), ...e });
}
export function unwrapForDevice(wrapped: string, devicePrivatePkcs8B64: string, ws: string, keyVersion: number): Buffer {
  const w = JSON.parse(wrapped) as { eph: string; nonce: string; ct: string };
  const priv = crypto.createPrivateKey({ key: unb64(devicePrivatePkcs8B64), format: 'der', type: 'pkcs8' });
  const ephPub = crypto.createPublicKey({ key: unb64(w.eph), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: ephPub });
  const kek = Buffer.from(crypto.hkdfSync('sha256', shared, unb64(w.eph), `ergon/sync-envelope/v1|${ws}|${keyVersion}`, 32));
  return ungcm(kek, w.nonce, w.ct, `ergon/sync-envelope/v1|${ws}|${keyVersion}`);
}

export function wrapForRecovery(dek: Buffer, recoverySecret: string, ws: string, keyVersion: number): string {
  const salt = crypto.randomBytes(16);
  const kek = crypto.scryptSync(recoverySecret.normalize('NFKD'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return JSON.stringify({ v: 1, kind: 'recovery', salt: b64(salt), ...gcm(kek, dek, `ergon/sync-recovery/v1|${ws}|${keyVersion}`) });
}
export function unwrapForRecovery(wrapped: string, recoverySecret: string, ws: string, keyVersion: number): Buffer {
  const w = JSON.parse(wrapped) as { salt: string; nonce: string; ct: string };
  const kek = crypto.scryptSync(recoverySecret.normalize('NFKD'), unb64(w.salt), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ungcm(kek, w.nonce, w.ct, `ergon/sync-recovery/v1|${ws}|${keyVersion}`);
}

/** Segredo do envelope pela senha do World: rótulo próprio (nem o do login, nem o da recuperação local). */
const worldSyncSecret = (password: string) => `ergon/sync-recovery-world/v1\n${password}`;
const worldAad = (ws: string, keyVersion: number) => `ergon/sync-recovery-world/v1|${ws}|${keyVersion}`;
/** Com o que um envelope de recuperação abre (o formato antigo, sem `by`, é o da frase). */
export function recoveryKindOf(wrapped: string): 'phrase' | 'world' {
  try { return (JSON.parse(wrapped) as { by?: unknown }).by === 'world' ? 'world' : 'phrase'; } catch { return 'phrase'; }
}
export async function wrapForRecoveryWorld(dek: Buffer, password: string, ws: string, keyVersion: number, kdf: KdfParams): Promise<string> {
  const salt = crypto.randomBytes(16);
  const kek = await argon2id(worldSyncSecret(password), salt, kdf);
  return JSON.stringify({ v: 2, kind: 'recovery', by: 'world', salt: b64(salt), kdf, ...gcm(kek, dek, worldAad(ws, keyVersion)) });
}
/**
 * Abre o envelope pela senha do World. Os parâmetros do Argon2id vêm do envelope (que o World entrega): só dentro de
 * limites, para um envelope adulterado não pedir memória ou tempo sem fim a este computador.
 */
export async function unwrapForRecoveryWorld(wrapped: string, password: string, ws: string, keyVersion: number): Promise<Buffer> {
  const w = JSON.parse(wrapped) as { v?: number; by?: string; salt?: string; nonce?: string; ct?: string; kdf?: Partial<KdfParams> };
  const k = w.kdf ?? {};
  const ok = (n: unknown, min: number, max: number) => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
  if (w.v !== 2 || w.by !== 'world' || typeof w.salt !== 'string' || typeof w.nonce !== 'string' || typeof w.ct !== 'string'
    || k.alg !== 'argon2id' || !ok(k.memoryKiB, 1024, 1_048_576) || !ok(k.passes, 1, 10) || !ok(k.parallelism, 1, 4)) throw new Error('envelope de recuperação em formato desconhecido');
  const kek = await argon2id(worldSyncSecret(password), unb64(w.salt), k as KdfParams);
  return ungcm(kek, w.nonce, w.ct, worldAad(ws, keyVersion));
}

interface SealedChange { operationId: string; expectedVersion: number; schemaVersion: number; keyVersion: number; kind: 'change' | 'snapshot' | 'rotation' | 'conexoes'; ciphertext: string; nonce: string; sha256: string; signature: string }

const aadV1 = (ws: string, c: { operationId: string; keyVersion: number; schemaVersion: number }) => `ergon/sync-change/v1|${ws}|${c.operationId}|${c.keyVersion}|${c.schemaVersion}`;
const aadV2 = (ws: string, c: { operationId: string; keyVersion: number; schemaVersion: number; kind: string; deviceId: string }) =>
  `ergon/sync-change/v2|${ws}|${c.operationId}|${c.keyVersion}|${c.schemaVersion}|${c.kind}|${c.deviceId}`;
/** os tipos de antes do formato v2: o que foi gravado no formato antigo continua abrindo (os novos só no v2) */
const KINDS_V1 = new Set(['change', 'snapshot', 'rotation']);

const canonical = (ws: string, c: Omit<SealedChange, 'ciphertext' | 'nonce' | 'signature'>): string =>
  `ergon-sync-v1|${ws}|${c.expectedVersion}|${c.operationId}|${c.schemaVersion}|${c.keyVersion}|${c.kind}|${c.sha256}`;

/** Cifra e assina uma alteração (o aparelho faz isto antes de enviar; o servidor não tem como abrir). */
export function sealChange(dek: Buffer, ws: string, body: unknown, meta: { operationId: string; expectedVersion: number; schemaVersion: number; keyVersion: number; kind?: SealedChange['kind']; /** o aparelho que manda (formato v2) */ deviceId?: string }, signingKeyPkcs8B64: string): SealedChange {
  const kind = meta.kind ?? 'change';
  if (!meta.deviceId && !KINDS_V1.has(kind)) throw new Error(`mudança do tipo ${kind} só no formato v2 (com o aparelho)`);
  const e = gcm(dek, Buffer.from(JSON.stringify(body)), meta.deviceId ? aadV2(ws, { ...meta, kind, deviceId: meta.deviceId }) : aadV1(ws, meta));
  const sha256 = crypto.createHash('sha256').update(unb64(e.ct)).digest('hex');
  const base = { operationId: meta.operationId, expectedVersion: meta.expectedVersion, schemaVersion: meta.schemaVersion, keyVersion: meta.keyVersion, kind, sha256 };
  const priv = crypto.createPrivateKey({ key: unb64(signingKeyPkcs8B64), format: 'der', type: 'pkcs8' });
  return { ...base, ciphertext: e.ct, nonce: e.nonce, signature: b64(crypto.sign(null, Buffer.from(canonical(ws, base)), priv)) };
}
/**
 * Abre uma mudança. Com o tipo e o aparelho (o que o World entrega em cada mudança), tenta o formato v2 primeiro; o v1
 * só vale para os tipos que já existiam antes dele.
 */
export function openChange<T = unknown>(dek: Buffer, ws: string, c: { operationId: string; keyVersion: number; schemaVersion: number; ciphertext: string; nonce: string; kind?: string; deviceId?: string }): T {
  const kind = c.kind ?? 'change';
  if (c.deviceId) {
    try { return JSON.parse(ungcm(dek, c.nonce, c.ciphertext, aadV2(ws, { ...c, kind, deviceId: c.deviceId })).toString('utf8')) as T; }
    catch (e) { if (!KINDS_V1.has(kind)) throw e; }
  } else if (!KINDS_V1.has(kind)) throw new Error(`mudança do tipo ${kind} sem o aparelho que a mandou`);
  return JSON.parse(ungcm(dek, c.nonce, c.ciphertext, aadV1(ws, c)).toString('utf8')) as T;
}

/**
 * Pacote para UM aparelho, dentro de uma mudança já cifrada com a chave do workspace (as conexões do dono a caminho do
 * aparelho-nuvem e os acessos renovados de volta ao computador: sync-conexoes.ts). Quem tem a chave do workspace (um
 * colaborador, outro computador) abre a mudança, mas não este envelope: X25519 efêmera com a chave pública do destino +
 * HKDF-SHA256 → AES-256-GCM. Os dados associados amarram o workspace, quem envia e para quem: o mesmo envelope copiado
 * para outro workspace, outro remetente ou outro destino não abre (e a adulteração de qualquer byte também não).
 */
const pacoteAad = (c: { ws: string; from: string; to: string }) => `ergon/sync-pacote/v1|${c.ws}|${c.from}|${c.to}`;
export function sealForDevice(plain: Buffer, devicePublicSpkiB64: string, c: { ws: string; from: string; to: string }): string {
  const devPub = crypto.createPublicKey({ key: unb64(devicePublicSpkiB64), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = eph.publicKey.export({ format: 'der', type: 'spki' });
  const kek = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: devPub }), ephPub, pacoteAad(c), 32));
  return JSON.stringify({ v: 1, kind: 'pacote', eph: b64(ephPub), ...gcm(kek, plain, pacoteAad(c)) });
}
export function openForDevice(sealed: string, devicePrivatePkcs8B64: string, c: { ws: string; from: string; to: string }): Buffer {
  const w = JSON.parse(sealed) as { v?: number; kind?: string; eph: string; nonce: string; ct: string };
  if (w.v !== 1 || w.kind !== 'pacote' || typeof w.eph !== 'string' || typeof w.nonce !== 'string' || typeof w.ct !== 'string') throw new Error('pacote em formato desconhecido');
  const priv = crypto.createPrivateKey({ key: unb64(devicePrivatePkcs8B64), format: 'der', type: 'pkcs8' });
  const ephPub = crypto.createPublicKey({ key: unb64(w.eph), format: 'der', type: 'spki' });
  const kek = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: priv, publicKey: ephPub }), unb64(w.eph), pacoteAad(c), 32));
  return ungcm(kek, w.nonce, w.ct, pacoteAad(c));
}
