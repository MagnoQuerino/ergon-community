import crypto from 'node:crypto';
import { emPt, type Texto } from './textos.ts';

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

/** Senhas guardadas em scrypt pelas versões antigas: só conferir (security/password.ts regrava em Argon2id). */
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
  /** o texto com código e valores (lib/textos.ts), para a tela traduzir; sem ele, o tratador reconhece pelo texto */
  readonly texto: Texto | null;
  constructor(status: number, code: string, message: string | Texto) {
    super(typeof message === 'string' ? message : emPt(message));
    this.status = status;
    this.code = code;
    this.texto = typeof message === 'string' ? null : message;
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

/** URL para log: valores de parâmetros sensíveis (código de autorização, tokens, segredos) viram [redigido]. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:code|state|session_state|token|access_token|refresh_token|id_token|client_secret|password|senha)=)[^&#]*/gi, '$1[redigido]');
}
