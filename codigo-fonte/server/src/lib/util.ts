import crypto from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(expected, got);
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'recurso') => new HttpError(404, 'not_found', `${what} não encontrado`);

/** Remove acentos e normaliza para comparação de texto. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Mascara identificadores externos (telefone, IDs) para logs e interface. */
export function maskId(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.length <= 6) return '•••';
  return `${s.slice(0, 3)}•••${s.slice(-3)}`;
}

/** URL para log: valores de parâmetros sensíveis (código de autorização, tokens, segredos) viram [redigido]. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:code|state|session_state|token|access_token|refresh_token|id_token|client_secret|password|senha)=)[^&#]*/gi, '$1[redigido]');
}
