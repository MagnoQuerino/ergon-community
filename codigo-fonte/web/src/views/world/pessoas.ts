// Pessoas no Ergon World: quem pode o quê na tela (as mesmas regras do World, em world/src/sync.ts; o World confere de
// novo e é quem decide). Puro, sem tela, para os testes (pessoas.test.ts).
export type Papel = 'owner' | 'admin' | 'editor' | 'viewer';
export interface Pessoa { accountId: string; name: string | null; email: string | null; role: Papel; since: string; me: boolean }
export interface Convite { id: string; role: Papel; expiresAt: string; createdAt: string }
export interface Membros { myRole: Papel | null; seats: number; members: Pessoa[]; invites: Convite[]; awaitingKey?: string[] }

const ADMIN: ReadonlyArray<Papel | null> = ['owner', 'admin'];
/** Administra: convida, troca papéis (com limites), tira pessoas, cancela convites, define tetos. */
export const administra = (eu: Papel | null): boolean => ADMIN.includes(eu);

/** Os papéis que eu posso dar num convite: só o dono convida quem administra. */
export function papeisDoConvite(eu: Papel | null): Papel[] {
  if (eu === 'owner') return ['admin', 'editor', 'viewer'];
  if (eu === 'admin') return ['editor', 'viewer'];
  return [];
}

/**
 * Os papéis para os quais eu posso mudar esta pessoa (vazio = sem seletor). O dono só muda por transferência; ninguém
 * muda o próprio papel aqui; quem administra (sem ser dono) não mexe em outro admin nem promove a admin.
 */
export function papeisPara(eu: Papel | null, p: Pessoa): Papel[] {
  if (p.me || p.role === 'owner') return [];
  if (eu === 'owner') return ['admin', 'editor', 'viewer'];
  if (eu === 'admin') return p.role === 'admin' ? [] : ['editor', 'viewer'];
  return [];
}

/** Tirar do workspace: nunca o dono, nunca a si mesmo; quem administra (sem ser dono) não tira outro admin. */
export const podeTirar = (eu: Papel | null, p: Pessoa): boolean => !p.me && p.role !== 'owner' && (eu === 'owner' || (eu === 'admin' && p.role !== 'admin'));

/** Transferir a titularidade: só o dono, para outra pessoa que já está no workspace. */
export const podeTransferir = (eu: Papel | null, p: Pessoa): boolean => eu === 'owner' && !p.me && p.role !== 'owner';

/** Vagas: cada pessoa e cada convite pendente ocupam uma (quem não administra não vê os convites). */
export const vagas = (m: Membros): { usadas: number; total: number; livres: number } => {
  const usadas = m.members.length + m.invites.length;
  return { usadas, total: m.seats, livres: Math.max(0, m.seats - usadas) };
};

/** A inicial do avatar: do nome, do e-mail ou um ponto. */
export const inicial = (p: Pick<Pessoa, 'name' | 'email'>): string => ((p.name ?? '').trim() || (p.email ?? '').trim() || '·').charAt(0).toLocaleUpperCase();

/** O código de convite: o que a pessoa cola (com espaços, quebras ou um "ergon://convite/" na frente). */
export const limparCodigo = (v: string): string => v.trim().replace(/^.*\/convite\//, '').replace(/\s+/g, '');
export const codigoValido = (v: string): boolean => /^[A-Za-z0-9_-]{16,128}$/.test(limparCodigo(v));
