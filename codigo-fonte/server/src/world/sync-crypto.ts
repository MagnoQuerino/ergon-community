/**
 * Criptografia do World Sync no APARELHO. O servidor do World recebe só
 * cifrado, envelopes opacos e assinaturas; a chave do workspace (DEK do Sync) nunca sai em claro do aparelho.
 *
 * - Envelope por aparelho: X25519 efêmera + HKDF-SHA256 → AES-256-GCM (amarrado ao workspace e à versão da chave).
 * - Envelope de recuperação: scrypt da frase de recuperação da pessoa → AES-256-GCM (aparelho novo sem nenhum outro
 *   ligado).
 * - Alteração: AES-256-GCM com a DEK; dados associados = workspace, operação, versão da chave e do esquema.
 * - Assinatura: Ed25519 do aparelho sobre o envelope canônico (o servidor confere quem mandou o quê).
 */
import crypto from 'node:crypto';

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

interface SealedChange { operationId: string; expectedVersion: number; schemaVersion: number; keyVersion: number; kind: 'change' | 'snapshot' | 'rotation'; ciphertext: string; nonce: string; sha256: string; signature: string }

const canonical = (ws: string, c: Omit<SealedChange, 'ciphertext' | 'nonce' | 'signature'>): string =>
  `ergon-sync-v1|${ws}|${c.expectedVersion}|${c.operationId}|${c.schemaVersion}|${c.keyVersion}|${c.kind}|${c.sha256}`;

/** Cifra e assina uma alteração (o aparelho faz isto antes de enviar; o servidor não tem como abrir). */
export function sealChange(dek: Buffer, ws: string, body: unknown, meta: { operationId: string; expectedVersion: number; schemaVersion: number; keyVersion: number; kind?: SealedChange['kind'] }, signingKeyPkcs8B64: string): SealedChange {
  const kind = meta.kind ?? 'change';
  const e = gcm(dek, Buffer.from(JSON.stringify(body)), `ergon/sync-change/v1|${ws}|${meta.operationId}|${meta.keyVersion}|${meta.schemaVersion}`);
  const sha256 = crypto.createHash('sha256').update(unb64(e.ct)).digest('hex');
  const base = { operationId: meta.operationId, expectedVersion: meta.expectedVersion, schemaVersion: meta.schemaVersion, keyVersion: meta.keyVersion, kind, sha256 };
  const priv = crypto.createPrivateKey({ key: unb64(signingKeyPkcs8B64), format: 'der', type: 'pkcs8' });
  return { ...base, ciphertext: e.ct, nonce: e.nonce, signature: b64(crypto.sign(null, Buffer.from(canonical(ws, base)), priv)) };
}
export function openChange<T = unknown>(dek: Buffer, ws: string, c: { operationId: string; keyVersion: number; schemaVersion: number; ciphertext: string; nonce: string }): T {
  return JSON.parse(ungcm(dek, c.nonce, c.ciphertext, `ergon/sync-change/v1|${ws}|${c.operationId}|${c.keyVersion}|${c.schemaVersion}`).toString('utf8')) as T;
}
