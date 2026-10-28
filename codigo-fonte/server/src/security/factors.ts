/**
 * Segundos fatores e freio contra tentativas.
 * - Autenticador (TOTP, RFC 6238): códigos de 6 dígitos a cada 30 s, sem internet; o mesmo código não vale
 *   duas vezes.
 * - Passkeys (WebAuthn): Windows Hello, Touch ID, celular ou chave física, com verificação do usuário
 *   (digital, rosto ou PIN). O endereço precisa ser um nome (localhost ou o domínio), nunca um IP.
 * - Freio progressivo: depois de 5 erros, espera crescente (30 s, 1 min, 2 min… até 1 h) por usuário/endereço.
 * Tudo igual no local e na nuvem; na nuvem o autenticador ou a passkey são obrigatórios.
 */
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { HttpError } from '../lib/util.ts';

// ---------------------------------------------------------------- autenticador (TOTP)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(s: string): Buffer {
  let bits = 0; let value = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = (): string => base32(crypto.randomBytes(20));
export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export const totpUri = (secret: string, account: string, issuer = 'Ergon') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const usedCounters = new Map<string, number>();
/** Confere o código (janela de ±30 s). Devolve false para código errado ou já usado. */
export function verifyTotp(userId: string, secret: string, code: string, nowMs = Date.now()): boolean {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const t = Math.floor(nowMs / 30_000);
  for (const d of [0, -1, 1]) {
    const want = Buffer.from(totpAt(secret, t + d));
    if (crypto.timingSafeEqual(want, Buffer.from(c))) {
      if ((usedCounters.get(userId) ?? -1) >= t + d) return false; // mesmo código de novo: recusa
      usedCounters.set(userId, t + d);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- freio progressivo
interface Strike { fails: number; until: number }
const strikes = new Map<string, Strike>();
export const throttle = {
  /** Lança 429 enquanto a espera não passou. */
  check(key: string, nowMs = Date.now()): void {
    const s = strikes.get(key);
    if (s && s.until > nowMs) {
      const secs = Math.ceil((s.until - nowMs) / 1000);
      throw new HttpError(429, 'throttled', `Muitas tentativas erradas. Espere ${secs >= 60 ? `${Math.ceil(secs / 60)} min` : `${secs} s`} e tente de novo.`);
    }
  },
  fail(key: string, nowMs = Date.now()): void {
    const s = strikes.get(key) ?? { fails: 0, until: 0 };
    s.fails++;
    if (s.fails >= 5) s.until = nowMs + Math.min(3_600_000, 30_000 * 2 ** (s.fails - 5));
    strikes.set(key, s);
    if (strikes.size > 5000) for (const [k, v] of strikes) if (v.until < nowMs) strikes.delete(k);
  },
  ok(key: string): void { strikes.delete(key); },
  reset(): void { strikes.clear(); },
};

// ---------------------------------------------------------------- passkeys (WebAuthn)
export interface PasskeyRow { id: string; credential_id: string; public_key: string; counter: number; transports: string | null; name: string }
export interface RpConfig { rpID: string; origin: string; rpName: string }

/** Desafios pendentes (5 min, uso único), por propósito: cadastrar, entrar, confirmar identidade. */
const challenges = new Map<string, { challenge: string; userId: string | null; purpose: string; at: number }>();
function remember(key: string, challenge: string, userId: string | null, purpose: string) {
  for (const [k, v] of challenges) if (Date.now() - v.at > 5 * 60_000) challenges.delete(k);
  challenges.set(key, { challenge, userId, purpose, at: Date.now() });
}
function take(key: string, purpose: string) {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || c.purpose !== purpose || Date.now() - c.at > 5 * 60_000) throw new HttpError(400, 'challenge', 'pedido de passkey expirado; tente de novo');
  return c;
}

export async function passkeyRegisterOptions(rp: RpConfig, user: { id: string; username: string; displayName: string }, existing: PasskeyRow[], key: string) {
  const opts = await generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID, userName: user.username, userDisplayName: user.displayName,
    userID: new Uint8Array(Buffer.from(user.id)), attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(key, opts.challenge, user.id, 'register');
  return opts;
}

export async function passkeyRegisterVerify(rp: RpConfig, key: string, response: unknown) {
  const c = take(key, 'register');
  const r = await verifyRegistrationResponse({
    response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
    expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
  }).catch((e: Error) => { throw new HttpError(400, 'passkey', `passkey recusada: ${e.message}`); });
  if (!r.verified) throw new HttpError(400, 'passkey', 'passkey não confirmada');
  const cred = r.registrationInfo.credential;
  return { userId: c.userId!, credentialId: cred.id, publicKey: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: cred.transports ?? [] };
}

export async function passkeyAuthOptions(rp: RpConfig, key: string, userId: string | null, allow: PasskeyRow[], purpose = 'login') {
  const opts = await generateAuthenticationOptions({
    rpID: rp.rpID, userVerification: 'required',
    allowCredentials: allow.length ? allow.map((p) => ({ id: p.credential_id, transports: p.transports ? JSON.parse(p.transports) : undefined })) : undefined,
  });
  remember(key, opts.challenge, userId, purpose);
  return opts;
}

/** Confere a assinatura; `find` busca a passkey pelo id que o navegador devolveu. */
export async function passkeyAuthVerify(rp: RpConfig, key: string, response: { id?: string } & Record<string, unknown>, find: (credentialId: string) => (PasskeyRow & { user_id: string }) | undefined, purpose = 'login') {
  const c = take(key, purpose);
  const row = response.id ? find(String(response.id)) : undefined;
  if (!row || (c.userId && row.user_id !== c.userId)) throw new HttpError(401, 'passkey', 'passkey não reconhecida');
  const r = await verifyAuthenticationResponse({
    response: response as unknown as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
    expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    credential: { id: row.credential_id, publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')), counter: Number(row.counter), transports: row.transports ? JSON.parse(row.transports) : undefined },
  }).catch((e: Error) => { throw new HttpError(401, 'passkey', `passkey recusada: ${e.message}`); });
  if (!r.verified) throw new HttpError(401, 'passkey', 'passkey não confirmada');
  return { userId: row.user_id, passkeyId: row.id, newCounter: r.authenticationInfo.newCounter };
}
