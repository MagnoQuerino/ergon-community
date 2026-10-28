/**
 * Cifra por campo, com a chave do workspace (DEK). É a camada que vai para a nuvem: funciona em qualquer
 * banco (lá, Postgres compartilhado entre clientes). No local soma-se ao SQLCipher (arquivo inteiro cifrado).
 *
 * Formato do valor gravado: `ev1.<kid>.<base64url(nonce‖cifrado‖etiqueta)>`, kid = id do workspace ou "_"
 * (instância). O contexto (`ev1.<kid>`) entra como AAD: um valor não decifra com a chave de outro workspace.
 * Leitura: o Db decifra sozinho todo valor que começa com `ev1.` (os pontos de escrita chamam `seal`).
 */
import { b64u, decrypt, encrypt, fromB64u, randomKey } from './crypto.ts';
import { PersonSealedError, type WorkspaceKeySource } from './keys.ts';

export const SEALED_PREFIX = 'ev1.';
/** Lido de uma parte fechada (a pessoa ainda não entrou desde que o Ergon reiniciou): nunca é gravado de volta. */
export const CLOSED_VALUE = '[fechado]';
const KID = /^(ws_[a-f0-9]{32}|_)$/;

/** Onde as DEKs embrulhadas ficam (tabela workspace_keys); implementado pelo Db, sem decifrar nada. */
export interface DekStore {
  getWrapped(workspaceId: string): string | null;
  putWrapped(workspaceId: string, wrapped: string, source: string): void;
}

export class FieldCipher {
  private readonly keys: WorkspaceKeySource;
  private readonly store: DekStore;
  private cache = new Map<string, Buffer>();
  private warned = false;
  constructor(keys: WorkspaceKeySource, store: DekStore) { this.keys = keys; this.store = store; }
  get source(): WorkspaceKeySource { return this.keys; }
  /** Esquece as chaves de workspaces que saíram (conta removida). */
  forget(workspaceId: string): void { this.cache.delete(workspaceId); }

  /** DEK do workspace: criada na primeira vez, embrulhada pela origem de chaves e guardada no banco. */
  dek(kid: string): Buffer {
    if (kid === '_') return this.keys.instanceKey();
    const hit = this.cache.get(kid);
    if (hit) return hit;
    const wrapped = this.store.getWrapped(kid);
    let dek: Buffer;
    if (wrapped) dek = this.keys.unwrapDek(kid, wrapped);
    else { dek = randomKey(); this.store.putWrapped(kid, this.keys.wrapDek(kid, dek), this.keys.name); }
    this.cache.set(kid, dek);
    return dek;
  }

  /** A chave do workspace está disponível agora? (parte da pessoa aberta, ou dados sem pessoa) */
  canOpen(workspaceId: string | null | undefined): boolean {
    const kid = workspaceId && KID.test(workspaceId) ? workspaceId : '_';
    try { this.dek(kid); return true; } catch { return false; }
  }

  seal(workspaceId: string | null | undefined, value: string): string {
    if (value.startsWith(SEALED_PREFIX)) return value;
    const kid = workspaceId && KID.test(workspaceId) ? workspaceId : '_';
    return `${SEALED_PREFIX}${kid}.${b64u(encrypt(this.dek(kid), Buffer.from(value, 'utf8'), `${SEALED_PREFIX}${kid}`))}`;
  }

  open(value: string): string {
    const dot = value.indexOf('.', SEALED_PREFIX.length);
    const kid = value.slice(SEALED_PREFIX.length, dot);
    try {
      if (dot < 0 || !KID.test(kid)) throw new Error('formato');
      return decrypt(this.dek(kid), fromB64u(value.slice(dot + 1)), `${SEALED_PREFIX}${kid}`).toString('utf8');
    } catch (e) {
      // parte fechada: quem lê (só tarefas de fundo; a interface responde 423 antes) recebe um marcador, e gravar
      // qualquer coisa naquele workspace falha (seal precisa da chave) — nada vira lixo por cima do dado
      if (e instanceof PersonSealedError) return CLOSED_VALUE;
      if (!this.warned) { this.warned = true; console.error('[ergon] campo cifrado ilegível (chave errada ou dado corrompido)'); }
      return '[dado cifrado ilegível]';
    }
  }

  /** Arquivos (anexos, tokens das integrações, sessão do WhatsApp): mesma DEK, AAD = nome lógico do arquivo. */
  sealBytes(workspaceId: string | null, data: Buffer, name: string): Buffer {
    const kid = workspaceId && KID.test(workspaceId) ? workspaceId : '_';
    return Buffer.concat([Buffer.from(`EF1${kid.padEnd(35, ' ')}`, 'latin1'), encrypt(this.dek(kid), data, `file/${kid}/${name}`)]);
  }
  openBytes(data: Buffer, name: string): Buffer {
    if (!FieldCipher.isSealedBytes(data)) return data; // arquivo de antes da proteção
    const kid = data.subarray(3, 38).toString('latin1').trim();
    return decrypt(this.dek(kid), data.subarray(38), `file/${kid}/${name}`);
  }
  static isSealedBytes(data: Buffer): boolean { return data.length > 38 && data.subarray(0, 3).toString('latin1') === 'EF1'; }
}
