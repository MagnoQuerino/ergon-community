/**
 * Protocolo Ergon ↔ serviço do Teams (relé), v1 (contrato "App público do Teams", seção 2). Só funções puras: ids,
 * código de ligação, assinatura da instalação, conteúdo selado (2.6), HMACs da instância e o que fazer com cada código
 * de fechamento. Não importa nada do módulo opcional da nuvem: vale igual na edição Community.
 */
import crypto from 'node:crypto';

export const PROTOCOLO = 1;
export const SUBPROTOCOLO = 'ergon-teams.v1';
export const MAX_QUADRO = 128 * 1024;
export const MAX_TEXTO_SAIDA = 20_000;
export const MAX_CARTAO = 28 * 1024;

export const ID_VINCULO = /^bnd_[A-Za-z0-9_-]{8,40}$/;
export const ID_CLAIM = /^clm_[A-Za-z0-9_-]{8,40}$/;
export const ID_INSTALACAO = /^ins_[A-Za-z0-9_-]{8,40}$/;

/** Alfabeto do código de ligação (1.2): sem 0 O 1 I L. */
export const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Aceita minúsculas, espaços e hífen; devolve as 8 letras/números em maiúsculas, ou null se não for um código. */
export function normalizarCodigo(entrada: string): string | null {
  const c = entrada.toUpperCase().replace(/[\s-]+/g, '');
  if (c.length !== 8) return null;
  for (const ch of c) if (!ALFABETO_CODIGO.includes(ch)) return null;
  return c;
}

// ------------------------------------------------------------------------------------------------ chaves e assinatura
export interface ChavesInstalacao {
  /** Ed25519 (assinatura) e X25519 (fila selada): privadas em pkcs8 DER base64, públicas em spki DER base64 */
  ed25519: string; ed25519Public: string; x25519: string; x25519Public: string;
  /** chave da instância para os HMACs (personRef, t dos cartões): base64url de 32 bytes */
  hmac: string;
}
export function gerarChaves(): ChavesInstalacao {
  const ed = crypto.generateKeyPairSync('ed25519'); const x = crypto.generateKeyPairSync('x25519');
  const pub = (k: crypto.KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = (k: crypto.KeyObject) => k.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return { ed25519: priv(ed.privateKey), ed25519Public: pub(ed.publicKey), x25519: priv(x.privateKey), x25519Public: pub(x.publicKey), hmac: crypto.randomBytes(32).toString('base64url') };
}
const privada = (b64: string) => crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
const publica = (b64: string) => crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

export const assinar = (k: ChavesInstalacao, mensagem: string): string => crypto.sign(null, Buffer.from(mensagem, 'utf8'), privada(k.ed25519)).toString('base64');
export const mensagemRegistro = (sign: string, box: string, ts: string) => `ergon-teams-relay|register|v1|${sign}|${box}|${ts}`;
export const mensagemAuth = (installationId: string, nonce: string, ts: string) => `ergon-teams-relay|auth|v1|${installationId}|${nonce}|${ts}`;

const hmac22 = (chave: string, texto: string) => crypto.createHmac('sha256', Buffer.from(chave, 'base64url')).update(texto, 'utf8').digest('base64url').slice(0, 22);
/** O relé nunca vê o id local da pessoa (1.6). */
export const personRefDe = (k: Pick<ChavesInstalacao, 'hmac'>, userId: string) => hmac22(k.hmac, `person|v1|${userId}`);
/** `t` dos botões do cartão (3.5): amarra a proposta ao vínculo. */
export const tokenCartao = (k: Pick<ChavesInstalacao, 'hmac'>, proposalId: string, bindingId: string) => hmac22(k.hmac, `card|v1|${proposalId}|${bindingId}`);
export function tokenConfere(k: Pick<ChavesInstalacao, 'hmac'>, proposalId: string, bindingId: string, t: unknown): boolean {
  if (typeof t !== 'string' || t.length !== 22) return false;
  const a = Buffer.from(tokenCartao(k, proposalId, bindingId)); const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A conta do Teams (ou a conta Microsoft ligada ao Ergon) como o relé a descreve no ack do `link.claim` (contrato 12.1):
 * base64url(SHA-256("ergon-teams/account/v1|" + tenantId + "|" + aadObjectId)), os dois em minúsculas.
 */
export const hashDaConta = (tenantId: string, objectId: string) =>
  crypto.createHash('sha256').update(`ergon-teams/account/v1|${tenantId.trim().toLowerCase()}|${objectId.trim().toLowerCase()}`, 'utf8').digest('base64url');

// ------------------------------------------------------------------------------------------------ conteúdo selado (2.6)
export interface Selado { v: 1; epk: string; iv: string; ct: string; tag: string }
/** Os 32 bytes da chave pública X25519 (o fim do spki DER). */
const crua = (spkiB64: string) => publica(spkiB64).export({ format: 'der', type: 'spki' }).subarray(-32);
function chaveDoSelo(z: Buffer, epkSpki: string, instSpki: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', z, Buffer.concat([crua(epkSpki), crua(instSpki)]), Buffer.from('ergon-teams-relay/seal/v1'), 32));
}
export const aadDoSelo = (deliveryId: string, installationId: string, type: string) => `${deliveryId}|${installationId}|${type}`;

/** Abre o que o relé selou para esta instalação. Qualquer alteração (ou contexto errado) lança erro. */
export function abrirSelado(k: Pick<ChavesInstalacao, 'x25519' | 'x25519Public'>, s: Selado, aad: string): unknown {
  if (!s || s.v !== 1 || typeof s.epk !== 'string' || typeof s.iv !== 'string' || typeof s.ct !== 'string' || typeof s.tag !== 'string') throw new Error('selo inválido');
  const z = crypto.diffieHellman({ privateKey: privada(k.x25519), publicKey: publica(s.epk) });
  const key = chaveDoSelo(z, s.epk, k.x25519Public);
  const iv = Buffer.from(s.iv, 'base64url'); const tag = Buffer.from(s.tag, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('selo inválido');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, 'utf8')); d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(Buffer.from(s.ct, 'base64url')), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Sela para uma instalação (o que o relé faz). Aqui só para o vetor de teste e para os testes: o Ergon nunca sela para
 * si mesmo. `fixo` (testes): efêmera e iv determinísticos.
 */
export function selar(instBoxPublic: string, valor: unknown, aad: string, fixo?: { efemera: crypto.KeyObject; iv: Buffer }): Selado {
  const eph = fixo?.efemera ?? crypto.generateKeyPairSync('x25519').privateKey;
  const epk = crypto.createPublicKey(eph).export({ format: 'der', type: 'spki' }).toString('base64');
  const z = crypto.diffieHellman({ privateKey: eph, publicKey: publica(instBoxPublic) });
  const key = chaveDoSelo(z, epk, instBoxPublic);
  const iv = fixo?.iv ?? crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(valor), 'utf8')), c.final()]);
  return { v: 1, epk, iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

// ------------------------------------------------------------------------------------------------ fechamento (2.2)
/** O que o cliente faz quando a conexão fecha com cada código. */
export type Reacao = { acao: 'reconectar'; esperaMs?: number } | { acao: 'parar'; motivo: 'assinatura' | 'revogada' | 'versao' | 'substituida' } | { acao: 'registrar_de_novo' };
export function reacaoAoFechar(code: number): Reacao {
  switch (code) {
    case 4401: return { acao: 'parar', motivo: 'assinatura' };
    case 4403: return { acao: 'parar', motivo: 'revogada' };
    case 4404: return { acao: 'registrar_de_novo' };
    case 4409: return { acao: 'parar', motivo: 'substituida' };
    case 4426: return { acao: 'parar', motivo: 'versao' };
    case 4429: return { acao: 'reconectar', esperaMs: 60_000 };
    default: return { acao: 'reconectar' };
  }
}

/** Backoff 2.3: 1 s, 2 s, 4 s … até 60 s, ±20%. `base`/`teto` ajustáveis nos testes. */
export function esperaDaTentativa(tentativa: number, base = 1000, teto = 60_000, sorte = Math.random): number {
  const ms = Math.min(teto, base * 2 ** Math.max(0, tentativa));
  return Math.round(ms * (0.8 + 0.4 * sorte()));
}

/** Endereço do relé (7.2): https em qualquer lugar; http só no próprio computador (testes). null = inválido. */
export function enderecoDoRele(v: string | null | undefined): string | null {
  if (!v) return null;
  let u: URL;
  try { u = new URL(v.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}
export const wsDoRele = (base: string) => `${base.replace(/^http/, 'ws')}/v1/ergon`;
