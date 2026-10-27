/**
 * Senhas: Argon2id para guardar (as antigas em scrypt continuam valendo e são reconvertidas no próximo
 * login) e uma régua de força baseada em dicionários (português e comuns), sem regras chatas de símbolo:
 * frase-senha longa e difícil de adivinhar.
 */
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as ptBr from '@zxcvbn-ts/language-pt-br';
import { HttpError, verifyPassword as verifyScrypt } from '../lib/util.ts';
import { KDF_STRONG, argon2id, b64u, fromB64u, randomKey, timingSafeEq, type KdfParams } from './crypto.ts';

export async function hashPassword(password: string, p: KdfParams = KDF_STRONG): Promise<string> {
  const salt = randomKey().subarray(0, 16);
  const h = await argon2id(password, salt, p);
  return `argon2id$m=${p.memoryKiB},t=${p.passes},p=${p.parallelism}$${b64u(salt)}$${b64u(h)}`;
}

/** Confere a senha. `rehash` = guardado em formato antigo ou mais fraco que o atual: regravar. */
export async function checkPassword(password: string, stored: string, current: KdfParams = KDF_STRONG): Promise<{ ok: boolean; rehash: boolean }> {
  if (stored.startsWith('scrypt$')) { const ok = verifyScrypt(password, stored); return { ok, rehash: ok }; }
  const m = stored.match(/^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/);
  if (!m) return { ok: false, rehash: false };
  const p: KdfParams = { alg: 'argon2id', memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) };
  const h = await argon2id(password, fromB64u(m[4]), p);
  const ok = timingSafeEq(h, fromB64u(m[5]));
  return { ok, rehash: ok && (p.memoryKiB < current.memoryKiB || p.passes < current.passes) };
}

let zx: ZxcvbnFactory | null = null;
const meter = () => (zx ??= new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...ptBr.dictionary }, graphs: common.adjacencyGraphs, translations: ptBr.translations,
}));

export const MIN_PASSWORD = 12;
/** Régua: pelo menos 12 caracteres e nota ≥ 3 de 4 (difícil de adivinhar). Explica em português o que falta. */
export function assertStrongPassword(password: string, context: string[] = []): void {
  if (password.length < MIN_PASSWORD) throw new HttpError(400, 'weak_password', `Use pelo menos ${MIN_PASSWORD} caracteres. Uma frase de 3 ou 4 palavras é fácil de lembrar e difícil de adivinhar.`);
  if (password.length > 200) throw new HttpError(400, 'weak_password', 'Senha longa demais (máximo de 200 caracteres).');
  const r = meter().check(password, ['ergon', ...context]);
  if (r.score < 3) {
    const why = r.feedback.warning ? `${r.feedback.warning} ` : '';
    throw new HttpError(400, 'weak_password', `Senha fácil de adivinhar. ${why}Tente uma frase com palavras que não combinem entre si.`.trim());
  }
}
export function passwordScore(password: string): number { return meter().check(password).score; }
