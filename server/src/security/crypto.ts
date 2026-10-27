/**
 * Primitivas de criptografia do Ergon (só node:crypto, sem dependência nativa):
 * - AES-256-GCM (cifra autenticada) com nonce aleatório de 96 bits e dados associados (AAD) que amarram o
 *   texto cifrado ao seu contexto (ex.: a chave de qual workspace, de qual arquivo);
 * - HKDF-SHA256 para derivar subchaves com propósito único a partir de uma chave mestra;
 * - Argon2id (lento e pesado em memória, de propósito) para derivar chave a partir de senha ou frase.
 * Mesmo código no local e na nuvem: só muda de onde vem a chave (ver keys.ts).
 */
import crypto from 'node:crypto';

export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const randomKey = (): Buffer => crypto.randomBytes(KEY_BYTES);
export const b64u = (b: Buffer): string => b.toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Cifra `plain` com `key`; saída = nonce ‖ texto cifrado ‖ etiqueta. */
export function encrypt(key: Buffer, plain: Buffer, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('chave inválida');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

/** Decifra e confere a autenticidade; qualquer alteração (ou contexto errado) lança erro. */
export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('chave inválida');
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error('dado cifrado truncado');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES)), d.final()]);
}

/** Subchave de propósito único (ex.: "ergon/db/v1"). Chaves diferentes para usos diferentes. */
export function hkdf(master: Buffer, info: string, salt = 'ergon'): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(salt), Buffer.from(info), KEY_BYTES));
}

export interface KdfParams { alg: 'argon2id'; memoryKiB: number; passes: number; parallelism: number }
/** Produção: 128 MiB e 3 passadas (~0,2–0,5 s por tentativa). Testes: perfil leve. */
export const KDF_STRONG: KdfParams = { alg: 'argon2id', memoryKiB: 131072, passes: 3, parallelism: 1 };
export const KDF_TEST: KdfParams = { alg: 'argon2id', memoryKiB: 1024, passes: 1, parallelism: 1 };

export async function argon2id(secret: string, salt: Buffer, p: KdfParams): Promise<Buffer> {
  // normaliza acentos (NFKC) para "ação" digitada em teclados diferentes dar a mesma chave
  const message = Buffer.from(secret.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) => {
    crypto.argon2('argon2id', { message, nonce: salt, parallelism: p.parallelism, tagLength: KEY_BYTES, memory: p.memoryKiB, passes: p.passes },
      (err, key) => (err ? reject(err) : resolve(Buffer.from(key))));
  });
}

export const timingSafeEq = (a: Buffer, b: Buffer): boolean => a.length === b.length && crypto.timingSafeEqual(a, b);
