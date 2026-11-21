/**
 * World Sync a partir do aplicativo local: o ESQUELETO do workspace (shared/blueprint.ts) e o CONTEÚDO (tarefas dos quadros
 * do Ergon, conversas e mensagens: sync-content.ts), cifrados no aparelho, enviados ao World e aplicados em outro aparelho
 * da mesma pessoa, inclusive com o principal desligado. Só o workspace local que a pessoa ligou ao World sincroniza.
 *
 * Chaves: a chave do workspace World nasce aqui, vai para o World só EMBRULHADA para cada aparelho (X25519) e, se a
 * pessoa digitar a frase, num envelope de recuperação; aqui fica cifrada com a chave da pessoa.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { HttpError, now } from '../lib/util.ts';
import { audit, type Bus } from '../services/bus.ts';
import { exportBlueprint, importBlueprint } from '../services/blueprint.ts';
import type { AgentLimits } from '../services/capacity.ts';
import type { Routines } from '../services/routines.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import { type Applied, type ContentBody, ContentSync, parseContent } from './sync-content.ts';
import { SyncAtividade } from './sync-atividade.ts';
import type { SalasSync } from './sync-salas.ts';
import { conferirNuvem } from './nuvem-fixa.ts';
import { newWorkspaceKey, openChange, openForDevice, sealChange, unwrapForDevice, unwrapForRecovery, wrapForDevice, wrapForRecovery } from './sync-crypto.ts';

interface Keys { ed25519: string; x25519: string; x25519Public: string }
interface SyncRow { sync_workspace_id: string; key_version: number; sync_key: string; last_version: number; blueprint_hash: string | null; old_keys: string | null; rotation_pending: number; recovery_key_version: number | null; updated_at: string | null; envio_pendente: string | null; giro_candidato: string | null; dono_conta: string | null }
/** a parte em envio (w0011): `chegou` = a mudança apareceu no World ao receber, sem a resposta ter chegado aqui */
interface EnvioPendente { op: string; resumo: string; chegou?: number }
interface GiroCandidato { v: number; chave: string; op: string }
export type LogSync = (o: Record<string, unknown>, msg: string) => void;
/** Um aparelho na entrega da chave: o que o World lista em devices-needing-key (kind é aditivo) */
interface Precisa { deviceId: string; accountId?: string; syncPublicKey?: string | null; kind?: string }
export interface Entrega { shared: number; failed: number; needed: number; cloud: 'entregue' | 'falhou' | 'nao_pedia'; falhas: Array<{ deviceId: string; code: string }> }
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
const codigoDe = (e: unknown): string => String((e as { code?: unknown }).code ?? ((e as { status?: unknown }).status ? `http_${(e as { status?: unknown }).status}` : 'erro'));
/** `accountId`/`deviceKind`: quem mandou, como o World registrou o aparelho que assinou (world/src/sync.ts COLS) */
type Change = { version: number; operationId: string; keyVersion: number; schemaVersion: number; kind: string; ciphertext: string; nonce: string; deviceId: string; accountId?: string; deviceKind?: string };

export class LocalSync {
  readonly db: Db; readonly links: WorldLinks; readonly client: WorldClient; readonly routines: Routines; readonly bus: Bus; readonly limits: AgentLimits; readonly content: ContentSync;
  /** dados indo ou vindo agora (o sinal da barra de cima) e a pausa pedida ao fechar o aplicativo */
  readonly atividade: SyncAtividade;
  /** o registro do servidor (cada tentativa de entrega da chave e o resultado; nunca chave, envelope ou conteúdo) */
  log: LogSync;
  /** este Ergon é a nuvem do World: o esqueleto recebido espelha a equipe do computador (services/blueprint.ts) */
  private readonly nuvem: boolean;
  /** as Salas entre os colaboradores (sync-salas.ts); sem o serviço, nada das salas vai nem vem */
  salas: SalasSync | null = null;
  constructor(d: { db: Db; links: WorldLinks; client: WorldClient; routines: Routines; bus: Bus; limits: AgentLimits; log?: LogSync; nuvem?: boolean }) { this.nuvem = d.nuvem === true; this.db = d.db; this.links = d.links; this.client = d.client; this.routines = d.routines; this.bus = d.bus; this.limits = d.limits; this.content = new ContentSync(d.db); this.atividade = new SyncAtividade(d.bus); this.log = d.log ?? (() => undefined); }

  /** mensagens novas vindas de outro aparelho (antes de a tela ser avisada): os canais não as mandam de novo */
  aoReceberMensagens: ((ws: string, messageIds: string[]) => void) | null = null;

  /**
   * As conexões (sync-conexoes.ts) vindas de outro aparelho da conta dona: o corpo já aberto com a chave do workspace. Quem
   * recebe confere o destino e abre o envelope de dentro (só o aparelho de destino consegue: aparelho()).
   */
  aoReceberConexoes: ((ws: string, x: { deviceId: string; version: number }, corpo: unknown) => void) | null = null;

  /** Este aparelho na sincronia: o id, a chave pública X25519 e abrir um pacote que veio para ele (a chave privada não sai daqui). */
  aparelho(userId: string) {
    const c = this.ctx(userId);
    return { deviceId: c.deviceId, x25519Public: c.keys.x25519Public, abrir: (sealed: string, a: { ws: string; from: string }) => openForDevice(sealed, c.keys.x25519, { ...a, to: c.deviceId }) };
  }

  /**
   * Envia UMA mudança de tipo próprio ('conexoes': só a conta dona envia e recebe, o World confere), cifrada com a chave
   * do workspace e assinada como as outras, presa à última versão recebida aqui: se outro aparelho mandou algo antes, o
   * World recusa (version_conflict) e ela vai no ciclo seguinte, depois de receber. Aceita, este aparelho avança junto.
   */
  async enviarTipo(userId: string, ws: string, kind: 'conexoes', body: unknown): Promise<number> {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    const sealed = sealChange(Buffer.from(r.sync_key, 'base64'), r.sync_workspace_id, body, { operationId: `cx_${crypto.randomBytes(9).toString('hex')}`, expectedVersion: r.last_version, schemaVersion: 1, keyVersion: r.key_version, kind, deviceId: c.deviceId }, c.keys.ed25519);
    const v = (await this.client.call<{ version: number }>('POST', `/v1/sync/workspaces/${r.sync_workspace_id}/changes`, sealed, c.session)).version;
    this.db.run('UPDATE world_sync SET last_version = ?, updated_at = ? WHERE workspace_id = ? AND last_version = ?', v, now(), ws, r.last_version);
    return v;
  }

  private ctx(userId: string) {
    const l = this.links.get(userId); const s = this.links.session(userId);
    if (!l || !s) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World para sincronizar.');
    return { session: s, deviceId: l.device_id, keys: JSON.parse(l.device_keys) as Keys };
  }
  private row(ws: string) { return this.db.get<SyncRow>('SELECT * FROM world_sync WHERE workspace_id = ?', ws); }

  /**
   * A chave do workspace em uso. Com a parte da pessoa fechada (o Ergon reiniciou e ela ainda não entrou), o banco
   * devolve um marcador no lugar do valor: nunca vira "chave" (embrulhar isso para outro aparelho o deixaria com uma
   * chave que não abre nada).
   */
  private dek(r: SyncRow): Buffer {
    const k = Buffer.from(r.sync_key, 'base64');
    if (k.length !== 32 || k.toString('base64') !== r.sync_key) throw new HttpError(423, 'sync_key_closed', 'A chave da sincronia está fechada agora: entre no Ergon para abrir.');
    return k;
  }

  private pendente(r: SyncRow): EnvioPendente | null {
    if (!r.envio_pendente) return null;
    try { const x = JSON.parse(r.envio_pendente) as EnvioPendente; return typeof x.op === 'string' && typeof x.resumo === 'string' ? x : null; } catch { return null; }
  }
  private candidato(r: SyncRow): GiroCandidato | null {
    if (!r.giro_candidato) return null;
    try { const x = JSON.parse(r.giro_candidato) as GiroCandidato; return Number.isInteger(x.v) && typeof x.op === 'string' && Buffer.from(String(x.chave), 'base64').length === 32 ? x : null; } catch { return null; }
  }
  /** As mudanças depois de `since`, juntando as páginas do World. */
  private async mudancas(session: string, sws: string, since: number): Promise<{ changes: Change[]; head: number; worldKey: number; dono: string | null }> {
    const changes: Change[] = []; let head = since; let worldKey = 0; let dono: string | null = null;
    for (let i = 0; i < 1000; i++) { // o World entrega em páginas
      const p = await this.client.call<{ head: number; keyVersion?: number; ownerAccountId?: unknown; changes: Change[] }>('GET', `/v1/sync/workspaces/${sws}/changes?since=${since}`, undefined, session);
      head = p.head; changes.push(...p.changes); worldKey = Math.max(worldKey, p.keyVersion ?? 0);
      if (typeof p.ownerAccountId === 'string' && p.ownerAccountId) dono = p.ownerAccountId;
      const ultima = p.changes.length ? p.changes[p.changes.length - 1].version : since;
      // página vazia, fim alcançado ou página que não anda (World com defeito): para (nunca gira no mesmo lugar)
      if (!p.changes.length || ultima >= p.head || ultima <= since) break;
      since = ultima;
    }
    return { changes, head, worldKey, dono };
  }

  /**
   * A conta World dona do workspace: a que o World disse no último pull (guardada) ou, sem ela ainda, a da lista de
   * membros. Sem resposta, null (quem chama trata como "não é o dono": nada da equipe vai nem vem).
   */
  private async donoDe(userId: string, ws: string, r: SyncRow): Promise<string | null> {
    if (r.dono_conta) return r.dono_conta;
    try {
      const m = await this.client.call<{ members?: Array<{ accountId?: unknown; role?: unknown }> }>('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/members`, undefined, this.ctx(userId).session);
      const dono = m.members?.find((x) => x.role === 'owner' && typeof x.accountId === 'string')?.accountId as string | undefined;
      if (!dono) return null;
      this.db.run('UPDATE world_sync SET dono_conta = ? WHERE workspace_id = ?', dono, ws);
      return dono;
    } catch { return null; }
  }

  /** Todas as chaves que este aparelho conhece (a atual e as de antes de cada giro), por versão. */
  private keyring(r: SyncRow): Map<number, Buffer> {
    const m = new Map<number, Buffer>();
    for (const [v, k] of Object.entries(r.old_keys ? JSON.parse(r.old_keys) as Record<string, string> : {})) m.set(Number(v), Buffer.from(k, 'base64'));
    m.set(r.key_version, Buffer.from(r.sync_key, 'base64'));
    return m;
  }
  private saveKeys(ws: string, keyVersion: number, dek: Buffer, ring: Map<number, Buffer>) {
    const old = Object.fromEntries([...ring].filter(([v]) => v !== keyVersion).sort((a, b) => a[0] - b[0]).map(([v, k]) => [String(v), k.toString('base64')]));
    this.db.run('UPDATE world_sync SET key_version = ?, sync_key = ?, old_keys = ?, updated_at = ? WHERE workspace_id = ?',
      keyVersion, this.db.seal(ws, dek.toString('base64')), Object.keys(old).length ? this.db.seal(ws, JSON.stringify(old)) : null, now(), ws);
  }

  status(ws: string) {
    const r = this.row(ws);
    if (r) {
      return { enabled: true, syncWorkspaceId: r.sync_workspace_id, keyVersion: r.key_version, lastVersion: r.last_version, conflicts: this.content.openConflicts(ws),
        rotationPending: !!r.rotation_pending, recoveryOutdated: r.recovery_key_version != null && r.recovery_key_version < r.key_version,
        // a última vez que este computador enviou ou recebeu (para o Estado do Ergon)
        lastSyncAt: r.updated_at ?? null };
    }
    const w = this.db.get<{ sync_workspace_id: string; origin: 'created' | 'joined' }>('SELECT sync_workspace_id, origin FROM world_workspace_ids WHERE workspace_id = ?', ws);
    return { enabled: false, syncWorkspaceId: w?.sync_workspace_id ?? null, origin: w?.origin ?? null };
  }

  /** O nome do workspace local, que o World mostra no lugar do código (1 a 60 caracteres). */
  labelOf(ws: string): { label?: string } {
    const n = (this.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', ws)?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return n ? { label: n } : {};
  }

  /** O workspace World deste workspace local (com ou sem a sincronização ligada), ou null. */
  worldId(ws: string): string | null {
    return this.row(ws)?.sync_workspace_id ?? this.db.get<{ sync_workspace_id: string }>('SELECT sync_workspace_id FROM world_workspace_ids WHERE workspace_id = ?', ws)?.sync_workspace_id ?? null;
  }

  /**
   * Garante o workspace World deste workspace local SEM ligar a sincronização: é onde ficam os créditos (o saldo é
   * sempre de um workspace) e para onde se assina o plano. Ligar o Sync depois usa o mesmo.
   */
  async ensureWorld(userId: string, ws: string): Promise<string> {
    const cur = this.worldId(ws);
    if (cur) return cur;
    const w = await this.client.call<{ workspaceId: string }>('POST', '/v1/sync/workspaces', this.labelOf(ws), this.ctx(userId).session);
    this.db.run("INSERT INTO world_workspace_ids (workspace_id, sync_workspace_id, created_at, origin) VALUES (?, ?, ?, 'created')", ws, w.workspaceId, now());
    return w.workspaceId;
  }

  /** Liga este workspace local a um workspace World que já existe na conta (criado em outro computador). */
  adopt(ws: string, syncWorkspaceId: string): void {
    this.db.run(`INSERT INTO world_workspace_ids (workspace_id, sync_workspace_id, created_at, origin) VALUES (?, ?, ?, 'joined')
      ON CONFLICT (workspace_id) DO UPDATE SET sync_workspace_id = excluded.sync_workspace_id, origin = 'joined'`, ws, syncWorkspaceId, now());
  }

  /**
   * Em que pé está a chave de um workspace World que este computador adotou (criado em outro lugar):
   * - 'mine': este aparelho já tem envelope (alguém entregou a chave): é só entrar;
   * - 'first': ninguém tem chave ainda (o workspace nasceu no servidor: primeiro checkout do site ou cortesia concedida
   *   pela equipe) e a pessoa é dona ou admin: a chave nasce aqui, como num workspace criado por este computador;
   * - 'handover': a chave já existe em outro aparelho: espera a entrega (ou usa a frase de recuperação). Também para quem
   *   não administra: só dono ou admin cria a primeira chave, e de fora não dá para saber se outra pessoa já a criou.
   * O World não diz "há envelopes" com todas as letras; sem chave ainda é: nenhum envelope deste aparelho, nenhum de
   * recuperação, nada enviado (head 0), a chave na versão 1 (nunca girou) e nenhum outro aparelho ativo da pessoa com
   * envelope (devices-needing-key). Na dúvida (erro do World), vale 'handover': nunca nasce uma segunda chave.
   */
  async keyState(userId: string, syncWorkspaceId: string): Promise<'mine' | 'first' | 'handover'> {
    const c = this.ctx(userId); const base = `/v1/sync/workspaces/${syncWorkspaceId}`;
    const missing = (p: Promise<unknown>) => p.then(() => false, (e: HttpError) => { if (e.status === 404) return true; throw e; });
    try {
      if (!(await missing(this.client.call('GET', `${base}/envelope`, undefined, c.session)))) return 'mine';
      if (!(await missing(this.client.call('GET', `${base}/envelope?kind=recovery`, undefined, c.session)))) return 'handover';
      const p = await this.client.call<{ head: number; keyVersion?: number }>('GET', `${base}/changes?since=0`, undefined, c.session);
      if (p.head !== 0 || (p.keyVersion ?? 1) !== 1) return 'handover';
      const m = await this.client.call<{ myRole?: string }>('GET', `${base}/members`, undefined, c.session);
      if (m.myRole !== 'owner' && m.myRole !== 'admin') return 'handover';
      // outro computador da pessoa pode ter ligado sem enviar nada nem guardar frase: aparelho ativo dela que não está
      // na lista "precisa da chave" já tem envelope (o aplicativo sempre registra o aparelho com chave de Sync)
      const need = await this.client.call<{ devices: Array<{ deviceId: string }> }>('GET', `${base}/devices-needing-key`, undefined, c.session);
      const mineAll = await this.client.call<Array<{ id: string; status: string }>>('GET', '/v1/devices', undefined, c.session);
      const needing = new Set(need.devices.map((d) => d.deviceId));
      return mineAll.some((d) => d.status === 'active' && d.id !== c.deviceId && !needing.has(d.id)) ? 'handover' : 'first';
    } catch (e) {
      if ((e as HttpError).code === 'world_offline') throw e;
      return 'handover';
    }
  }

  /** Cria a chave do workspace (versão dada) e grava o primeiro envelope deste aparelho (e o de recuperação, com a frase). */
  private async createKey(userId: string, ws: string, syncWorkspaceId: string, keyVersion: number, recoveryPhrase?: string) {
    const c = this.ctx(userId); const dek = newWorkspaceKey();
    await this.client.call('PUT', `/v1/sync/workspaces/${syncWorkspaceId}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion, wrapped: wrapForDevice(dek, c.keys.x25519Public, syncWorkspaceId, keyVersion) }, c.session);
    if (recoveryPhrase) await this.client.call('PUT', `/v1/sync/workspaces/${syncWorkspaceId}/envelopes`, { kind: 'recovery', keyVersion, wrapped: wrapForRecovery(dek, recoveryPhrase, syncWorkspaceId, keyVersion) }, c.session);
    this.db.run('INSERT INTO world_sync (workspace_id, user_id, sync_workspace_id, key_version, sync_key, last_version, updated_at, recovery_key_version) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      ws, userId, syncWorkspaceId, keyVersion, this.db.seal(ws, dek.toString('base64')), now(), recoveryPhrase ? keyVersion : null);
    return this.status(ws);
  }

  /**
   * Liga o Sync neste workspace (World ativo exigido no servidor). Frase opcional = envelope de recuperação.
   * Num workspace adotado (criado em outro computador ou no servidor), a chave só nasce aqui se ainda não existir e a
   * pessoa administrar o workspace; se já existir, entra com ela (este aparelho já a recebeu) ou espera a entrega.
   */
  async enable(userId: string, ws: string, recoveryPhrase?: string) {
    // já sincroniza (conectar ao World liga a sincronia sozinho): a frase dada agora vira a de recuperação
    if (this.row(ws)) { if (recoveryPhrase) await this.setRecovery(userId, ws, recoveryPhrase); return this.status(ws); }
    const c = this.ctx(userId);
    const joined = this.db.get<{ origin: string; sync_workspace_id: string }>('SELECT origin, sync_workspace_id FROM world_workspace_ids WHERE workspace_id = ?', ws);
    if (joined?.origin === 'joined') {
      const st = await this.keyState(userId, joined.sync_workspace_id);
      if (st === 'first') return this.createKey(userId, ws, joined.sync_workspace_id, 1, recoveryPhrase);
      if (st === 'mine') return this.join(userId, ws, joined.sync_workspace_id, recoveryPhrase);
      throw new HttpError(409, 'sync_join', 'Este workspace já sincroniza em outro computador: entre nele com a frase de recuperação ou autorize por lá.');
    }
    const known = this.worldId(ws); // já existe (créditos/plano antes da sincronização): a chave nasce agora, versão 1
    const w = known ? { workspaceId: known, keyVersion: 1 } : await this.client.call<{ workspaceId: string; keyVersion: number }>('POST', '/v1/sync/workspaces', this.labelOf(ws), c.session);
    return this.createKey(userId, ws, w.workspaceId, w.keyVersion, recoveryPhrase);
  }

  /** Neste aparelho (outro computador da pessoa): entra num workspace World que já existe, pegando a chave. */
  async join(userId: string, ws: string, syncWorkspaceId: string, recoveryPhrase?: string) {
    const c = this.ctx(userId);
    let env: { keyVersion: number; wrapped: string }; let dek: Buffer; let viaRecovery = false;
    try {
      env = await this.client.call('GET', `/v1/sync/workspaces/${syncWorkspaceId}/envelope`, undefined, c.session);
      dek = unwrapForDevice(env.wrapped, c.keys.x25519, syncWorkspaceId, env.keyVersion);
    } catch (e) {
      if ((e as HttpError).status !== 404) throw e;
      // ninguém tem a chave ainda (workspace criado no servidor): quem administra cria aqui, num clique
      if (this.worldId(ws) === syncWorkspaceId && !this.row(ws)) {
        const st = await this.keyState(userId, syncWorkspaceId);
        if (st === 'first') return this.createKey(userId, ws, syncWorkspaceId, 1, recoveryPhrase);
      }
      if (!recoveryPhrase) throw e;
      env = await this.client.call('GET', `/v1/sync/workspaces/${syncWorkspaceId}/envelope?kind=recovery`, undefined, c.session);
      try { dek = unwrapForRecovery(env.wrapped, recoveryPhrase, syncWorkspaceId, env.keyVersion); } catch { throw new HttpError(400, 'recovery', 'frase de recuperação não abre a chave deste workspace'); }
      viaRecovery = true;
      await this.client.call('PUT', `/v1/sync/workspaces/${syncWorkspaceId}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: env.keyVersion, wrapped: wrapForDevice(dek, c.keys.x25519Public, syncWorkspaceId, env.keyVersion) }, c.session);
    }
    this.db.run(`INSERT INTO world_sync (workspace_id, user_id, sync_workspace_id, key_version, sync_key, last_version, updated_at, recovery_key_version) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET sync_workspace_id = excluded.sync_workspace_id, key_version = excluded.key_version, sync_key = excluded.sync_key, last_version = 0, blueprint_hash = NULL,
        updated_at = excluded.updated_at, old_keys = NULL, rotation_pending = 0, recovery_key_version = excluded.recovery_key_version, envio_pendente = NULL, giro_candidato = NULL`,
    ws, userId, syncWorkspaceId, env.keyVersion, this.db.seal(ws, dek.toString('base64')), now(), viaRecovery ? env.keyVersion : null);
    this.adopt(ws, syncWorkspaceId);
    // outro workspace World: as bases e os conflitos do anterior não valem mais
    this.db.run('DELETE FROM world_sync_records WHERE workspace_id = ?', ws); this.db.run('DELETE FROM world_sync_conflicts WHERE workspace_id = ?', ws);
    return this.status(ws);
  }

  /**
   * Embrulha a chave para os aparelhos que ainda não a têm (feito por qualquer aparelho que tenha): os da própria
   * pessoa e, para quem administra, os dos outros membros.
   * - A nuvem primeiro: é ela que fica parada em "aguardando a chave"; depois os aparelhos da própria conta.
   * - Cada aparelho é uma tentativa à parte: a falha de um (revogado nesse meio, chave pública inválida, sem permissão
   *   para o de outra pessoa) não tira a vez dos outros.
   * - Só com a chave da versão que o World pede: depois de um giro feito em outro computador, busca a nova antes; sem
   *   ela, não entrega nada (a chave velha com a etiqueta nova deixaria o outro aparelho sem ler coisa alguma).
   * - Cada tentativa e o resultado vão para o registro do servidor (aparelho e código do erro; nunca a chave).
   */
  async share(userId: string, ws: string, opts: { /** quem pediu (para o registro): a pessoa, o ciclo automático, a entrega rápida à nuvem */ motivo?: string } = {}): Promise<Entrega> {
    let r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId); const motivo = opts.motivo ?? 'pedido';
    const need = await this.client.call<{ keyVersion: number; devices: Precisa[] }>('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/devices-needing-key`, undefined, c.session);
    const lista = Array.isArray(need.devices) ? need.devices : [];
    const out: Entrega = { shared: 0, failed: 0, needed: lista.length, cloud: 'nao_pedia', falhas: [] };
    if (!lista.length) return out;
    if (need.keyVersion !== r.key_version) {
      // o World já está noutra versão da chave: pega a nova (key_pending se ela ainda não chegou a este computador)
      if (need.keyVersion > r.key_version) {
        try { await this.refreshKey(userId, ws); }
        catch (e) { this.log({ ws, motivo, esperando: lista.length, versaoDoWorld: need.keyVersion, versaoDaqui: r.key_version, erro: codigoDe(e) }, 'sincronia: este computador ainda não tem a chave nova; não há o que entregar'); throw e; }
        r = this.row(ws)!;
      }
      if (need.keyVersion !== r.key_version) throw new HttpError(409, 'key_pending', 'A chave nova do workspace ainda não chegou a este computador.');
    }
    const dek = this.dek(r);
    const nuvem = (d: Precisa) => d.kind === 'cloud';
    // World antigo (sem kind): os aparelhos da própria conta primeiro (o aparelho-nuvem é da conta do dono)
    const minha = this.links.get(userId)?.account_id ?? null;
    const peso = (d: Precisa) => (nuvem(d) ? 0 : d.accountId === undefined || d.accountId === minha ? 1 : 2);
    const ordem = lista.map((d, i) => ({ d, i })).sort((a, b) => peso(a.d) - peso(b.d) || a.i - b.i).map((x) => x.d);
    this.log({ ws, motivo, aparelhos: ordem.length, nuvem: ordem.some(nuvem), versao: need.keyVersion }, 'sincronia: entregando a chave a quem ainda não tem');
    for (const d of ordem) {
      try {
        if (typeof d.deviceId !== 'string' || typeof d.syncPublicKey !== 'string' || !d.syncPublicKey) throw new HttpError(422, 'sem_chave_publica', 'aparelho sem chave pública de sincronia');
        // a nuvem do workspace: só o aparelho-nuvem fixado na primeira vez (nuvem-fixa.ts); um novo espera a pessoa dona
        // confirmar com a senha (Conexões › Na nuvem do workspace)
        if (nuvem(d) && conferirNuvem(this.db, this.bus, ws, { deviceId: d.deviceId, syncPublicKey: d.syncPublicKey }, this.db.get<{ a: string | null }>('SELECT COALESCE(enviado_para, nuvem_aparelho) AS a FROM world_conexoes_nuvem WHERE workspace_id = ?', ws)?.a) === 'trocada')
          throw new HttpError(409, 'nuvem_trocada', 'a nuvem do workspace mudou de aparelho: espera a confirmação da pessoa dona');
        let wrapped: string;
        try { wrapped = wrapForDevice(dek, d.syncPublicKey, r.sync_workspace_id, need.keyVersion); }
        catch { throw new HttpError(422, 'chave_publica_invalida', 'a chave pública do aparelho não serve'); }
        await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'device', deviceId: d.deviceId, keyVersion: need.keyVersion, wrapped }, c.session);
        out.shared++; if (nuvem(d)) out.cloud = 'entregue';
        this.log({ ws, motivo, aparelho: d.deviceId, nuvem: nuvem(d) }, 'sincronia: chave entregue');
      } catch (e) {
        const code = codigoDe(e);
        out.failed++; out.falhas.push({ deviceId: String(d.deviceId ?? ''), code }); if (nuvem(d)) out.cloud = 'falhou';
        this.log({ ws, motivo, aparelho: String(d.deviceId ?? ''), nuvem: nuvem(d), erro: code, detalhe: String((e as Error).message ?? '').slice(0, 160) }, 'sincronia: a entrega da chave a um aparelho falhou (os outros seguem)');
        // sem rede ou o World pedindo pausa: os próximos falhariam igual; para aqui e tenta de novo no próximo ciclo
        if (code === 'world_offline' || code === 'rate_limited') { for (const x of ordem.slice(ordem.indexOf(d) + 1)) { out.failed++; out.falhas.push({ deviceId: String(x.deviceId ?? ''), code }); if (nuvem(x)) out.cloud = 'falhou'; } break; }
        // a versão da chave mudou no meio (outro computador girou agora): nada mais desta rodada serve
        if (code === 'key_version') break;
      }
    }
    return out;
  }

  /**
   * Envia o que mudou aqui: o esqueleto (só se a equipe mudou) e o conteúdo novo ou alterado, em mudanças cifradas e
   * assinadas, cada uma presa à versão anterior. Outro aparelho enviou antes: recusa, para receber e decidir primeiro.
   */
  async push(userId: string, ws: string, opts: { /** só o conteúdo (a nuvem não manda o esqueleto da equipe: quem define a equipe é o computador) */ contentOnly?: boolean } = {}) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId); const dek = this.dek(r);
    let version = r.last_version; const sent = { tasks: 0, conversations: 0, messages: 0 };
    // A parte cuja resposta se perdeu da outra vez (w0011). `chegou`: ao receber, a mudança já estava no World: o que ela
    // levava é marcado como enviado sem ir de novo (senão o mesmo conteúdo entraria duas vezes no histórico).
    let pend = this.pendente(r);
    const jaChegou = (resumo: string) => !!pend?.chegou && pend.resumo === resumo;
    const send = async (body: unknown, kind: 'snapshot' | 'change', prefix: string, resumo: string) => {
      // o código da operação sai do corpo e da versão de partida: reenviar a mesma parte do mesmo ponto repete o código,
      // e o World devolve o recibo da primeira vez em vez de gravar outra mudança
      const op = `${prefix}_${sha(`${r.sync_workspace_id}|${version}|${resumo}`).slice(0, 26)}`;
      this.db.run('UPDATE world_sync SET envio_pendente = ? WHERE workspace_id = ?', this.db.seal(ws, JSON.stringify({ op, resumo } satisfies EnvioPendente)), ws);
      const sealed = sealChange(dek, r.sync_workspace_id, body, { operationId: op, expectedVersion: version, schemaVersion: 1, keyVersion: r.key_version, kind, deviceId: c.deviceId }, c.keys.ed25519);
      try { version = (await this.client.call<{ version: number }>('POST', `/v1/sync/workspaces/${r.sync_workspace_id}/changes`, sealed, c.session)).version; }
      catch (e) {
        const code = (e as HttpError).code;
        if (code === 'version_conflict') throw new HttpError(409, 'version_conflict', 'Outro aparelho mudou o workspace antes: receba as mudanças e decida antes de enviar.');
        if (code === 'rotation_required') {
          this.db.run('UPDATE world_sync SET rotation_pending = 1 WHERE workspace_id = ?', ws);
          throw new HttpError(409, 'rotation_required', 'Alguém saiu do workspace: a chave precisa ser trocada antes de enviar.');
        }
        if (code === 'key_version') throw new HttpError(409, 'key_version', 'A chave do workspace mudou: receba as mudanças antes de enviar.');
        throw e;
      }
      // nunca anda para trás (recibo repetido de uma operação antiga, com mudanças de outros aparelhos já recebidas depois)
      this.db.run('UPDATE world_sync SET last_version = MAX(last_version, ?), updated_at = ?, envio_pendente = NULL WHERE workspace_id = ?', version, now(), ws);
      version = Math.max(version, r.last_version); pend = null;
    };
    const esquecer = () => { if (pend) { this.db.run('UPDATE world_sync SET envio_pendente = NULL WHERE workspace_id = ?', ws); pend = null; } };
    const bp = exportBlueprint(this.db, this.routines, ws, { sync: true }); const bh = blueprintHash(bp);
    // Só a conta DONA do workspace define a equipe: o computador de um colaborador nunca manda o esqueleto (que leva a
    // parte privada: ferramentas, rotinas e a configuração delas) — quem recebe também não aplicaria (receber)
    let mandarEquipe = !opts.contentOnly && bh !== r.blueprint_hash && (await this.donoDe(userId, ws, r)) === (this.links.get(userId)?.account_id ?? '');
    if (mandarEquipe && jaChegou(`bp:${bh}`)) { this.db.run('UPDATE world_sync SET blueprint_hash = ? WHERE workspace_id = ?', bh, ws); mandarEquipe = false; esquecer(); }
    const brutas = this.content.chunks(this.content.pending(ws, userId));
    const salas = this.salas ? this.salas.saida(ws, r.sync_workspace_id, this.aparelho(userId), brutas.length > 0) : null;
    // as salas (sync-salas.ts) vão na primeira parte; sem conteúdo nenhum, numa parte só delas
    if (salas) { if (brutas.length) Object.assign(brutas[0].body, salas.extra); else brutas.push({ body: { type: 'content', tasks: [], conversations: [], messages: [], ...salas.extra }, items: [] }); }
    const comSalas = brutas[0];
    let partes = brutas.map((x) => ({ ...x, resumo: `ct:${sha(JSON.stringify({ ...x.body, salas: undefined }))}${salas && x === comSalas ? `:${salas.resumo.slice(0, 16)}` : ''}` }));
    const chegada = partes.find((x) => jaChegou(x.resumo));
    if (chegada) { this.content.sent(ws, chegada.items); if (salas && chegada.body === comSalas?.body) salas.marcar(); partes = partes.filter((x) => x !== chegada); esquecer(); }
    if (!mandarEquipe && !partes.length) { if (pend?.chegou) esquecer(); return { version, sent }; } // nada a enviar: a barra de cima nem pisca
    // cada parte enviada é um ponto seguro (a versão e o "já foi" ficam gravados); cortado no meio, o que faltou vai na
    // próxima vez (o que já tinha chegado ao World e não foi marcado aqui vai de novo, e aplicar duas vezes dá no mesmo)
    return this.atividade.envolver(ws, 'enviando', async () => {
      if (mandarEquipe) { await send({ type: 'blueprint', blueprint: bp }, 'snapshot', 'bp', `bp:${bh}`); this.db.run('UPDATE world_sync SET blueprint_hash = ? WHERE workspace_id = ?', bh, ws); }
      for (const part of partes) {
        await send(part.body, 'change', 'ct', part.resumo);
        this.content.sent(ws, part.items);
        if (salas && part.body === comSalas?.body) salas.marcar();
        sent.tasks += part.body.tasks.length; sent.conversations += part.body.conversations.length; sent.messages += part.body.messages.length;
      }
      return { version, sent };
    });
  }

  /**
   * Recebe o que os outros aparelhos enviaram desde a última vez: o último esqueleto (prévia; com apply, aplica com as
   * rotinas pausadas) e o conteúdo (com apply, une mensagens e concilia tarefas e conversas; o que mudou dos dois lados
   * vira conflito para a pessoa decidir). Formato inesperado depois de decifrar é recusado, sem aplicar nada.
   */
  async pull(userId: string, ws: string, apply: boolean, opts: { /** sincronia automática no computador: com esqueleto novo de outro aparelho, não aplica nada (fica para a pessoa ver e decidir) */ holdOnBlueprint?: boolean } = {}) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    const m = await this.mudancas(c.session, r.sync_workspace_id, r.last_version);
    const changes = m.changes; const head = m.head; const worldKey = Math.max(r.key_version, m.worldKey);
    if (m.dono && m.dono !== r.dono_conta) { this.db.run('UPDATE world_sync SET dono_conta = ? WHERE workspace_id = ?', m.dono, ws); r.dono_conta = m.dono; }
    const others = changes.filter((x) => x.deviceId !== c.deviceId);
    // um envio daqui cuja resposta se perdeu e que está no World: o próximo envio marca como enviado em vez de repetir
    const pend = this.pendente(r);
    const meu = pend && !pend.chegou ? changes.find((x) => x.deviceId === c.deviceId && x.operationId === pend.op) : undefined;
    if (meu && apply) this.db.run('UPDATE world_sync SET envio_pendente = ? WHERE workspace_id = ?', this.db.seal(ws, JSON.stringify({ ...pend!, chegou: meu.version } satisfies EnvioPendente)), ws);
    const resto = () => this.receber(userId, ws, r, changes, others, head, worldKey, apply, opts);
    // dados de outro aparelho para aplicar: a barra de cima mostra a sincronia em andamento (a equipe nova que fica
    // retida para a pessoa ver não aplica nada: não acende)
    const retida = !!opts.holdOnBlueprint && others.some((x) => x.kind === 'snapshot' && doDono(r, x));
    return apply && others.length && !retida ? this.atividade.envolver(ws, 'recebendo', resto) : resto();
  }

  private async receber(userId: string, ws: string, r: SyncRow, changes: Change[], others: Change[], head: number, worldKey: number, apply: boolean, opts: { holdOnBlueprint?: boolean }) {
    // a chave girou (alguém saiu): pega a nova no envelope deste aparelho e, nos giros, as anteriores
    if (Math.max(worldKey, ...changes.map((x) => x.keyVersion)) > r.key_version) { await this.refreshKey(userId, ws); r = this.row(ws)!; }
    const ring = this.learnKeys(ws, r, changes);
    const open = <T>(x: Change): T => {
      const k = ring.get(x.keyVersion);
      if (!k) throw new HttpError(409, 'key_pending', 'A chave nova do workspace ainda não chegou a este computador.');
      return openChange<T>(k, r.sync_workspace_id, x);
    };
    // O esqueleto (a equipe, as ferramentas e as rotinas) só vale vindo de um aparelho da conta DONA do workspace: um
    // colaborador tem a chave do workspace e consegue mandar um, mas não manda na equipe (nem na da nuvem, que tem as
    // credenciais do dono). O de outra conta é ignorado e fica no registro (na nuvem, também na auditoria)
    const snaps = others.filter((x) => x.kind === 'snapshot');
    const last = [...snaps].reverse().find((x) => doDono(r, x));
    const alheios = snaps.filter((x) => !doDono(r, x));
    if (alheios.length) {
      this.log({ ws, versoes: alheios.map((x) => x.version).slice(0, 10), contas: [...new Set(alheios.map((x) => x.accountId ?? '?'))].slice(0, 5), dono: r.dono_conta ?? null, nuvem: this.nuvem }, 'sincronia: esqueleto da equipe vindo de quem não é dono do workspace (ignorado)');
      if (apply && this.nuvem) audit(this.db, this.bus, { workspaceId: ws, actorType: 'system', actorId: 'sincronia', action: 'team.sync_ignored', evidence: { versoes: alheios.map((x) => x.version).slice(0, 10), contas: [...new Set(alheios.map((x) => x.accountId ?? '?'))].slice(0, 5) }, result: 'equipe de outra conta ignorada: só a conta dona define a equipe da nuvem' });
    }
    const contents: ContentBody[] = [];
    for (const x of others.filter((y) => y.kind === 'change')) {
      const body = parseContent(open(x));
      if (!body) throw new HttpError(422, 'sync_invalid', `uma mudança recebida (versão ${x.version}) não está no formato esperado: nada foi aplicado`);
      contents.push(body);
    }
    const incoming = { tasks: contents.reduce((n, b) => n + b.tasks.length, 0), conversations: contents.reduce((n, b) => n + b.conversations.length, 0), messages: contents.reduce((n, b) => n + b.messages.length, 0) };
    let plan: unknown = null;
    if (apply && last && opts.holdOnBlueprint) return { head, preview: null as unknown, incoming, applied: false, held: true };
    // ferramentas que executam código só ligam pela sincronia na nuvem do próprio dono (o aparelho-nuvem é da conta dona);
    // num computador, chegam desligadas e esperam a confirmação com a senha aqui (services/blueprint.ts)
    if (last) plan = importBlueprint(this.db, this.bus, this.routines, ws, userId, open<{ type: string; blueprint: unknown }>(last).blueprint, apply, this.limits, { sync: true, nuvem: this.nuvem, ligarGuardadas: this.nuvem });
    if (!apply) return { head, preview: plan, incoming, applied: false };
    // as conexões vindas de outro aparelho da conta dona (sync-conexoes.ts): quem recebe confere o destino e o envelope;
    // uma que falhe não segura o resto da sincronia (fica registrada por quem recebe)
    for (const x of others.filter((y) => y.kind === 'conexoes' && doDono(r, y))) { try { this.aoReceberConexoes?.(ws, x, open(x)); } catch { /* registrado em sync-conexoes.ts */ } }
    if (last) this.db.run('UPDATE world_sync SET blueprint_hash = ? WHERE workspace_id = ?', blueprintHash(exportBlueprint(this.db, this.routines, ws, { sync: true })), ws);
    const total: Applied = { added: 0, updated: 0, conflicts: 0, skipped: 0 };
    const deOutros = others.filter((y) => y.kind === 'change');
    // cada mudança aplicada é um ponto seguro: aplicar, marcar as mensagens que vieram de outro aparelho (os canais não
    // as mandam de novo) e avançar a versão vão juntos, numa transação. Cortado no meio (aplicativo fechado à força, falta
    // de luz), a próxima vez retoma da mudança seguinte, sem repetir nada no canal
    for (const [i, body] of contents.entries()) {
      const x = deOutros[i];
      this.db.tx(() => {
        const novas = body.messages.map((m) => m.id).filter((id) => !this.db.get('SELECT 1 AS x FROM messages WHERE id = ?', id));
        const n = this.content.apply(ws, userId, body, x.deviceId);
        // as salas: anúncio de chave, pacotes selados para este aparelho e a governança (sync-salas.ts)
        if (this.salas && (body.aparelho || body.salas || body.salasGov)) { try { this.salas.entrada(ws, r.sync_workspace_id, x, body, this.aparelho(userId)); } catch (e) { this.log({ ws, erro: String((e as Error).message ?? e).slice(0, 160) }, 'salas: o que veio não foi aplicado'); } }
        for (const k of Object.keys(total) as Array<keyof Applied>) total[k] += n[k];
        try { if (novas.length) this.aoReceberMensagens?.(ws, novas); } catch { /* os canais não seguram a sincronia */ }
        this.db.run('UPDATE world_sync SET last_version = ?, updated_at = ? WHERE workspace_id = ? AND last_version < ?', x.version, now(), ws, x.version);
      });
    }
    this.db.run('UPDATE world_sync SET last_version = ?, updated_at = ? WHERE workspace_id = ?', head, now(), ws);
    // quadros e itens de cartão (sync-quadros.ts) também mudam a tela de Tarefas: chegando só eles, o aviso vai igual
    if (incoming.tasks || contents.some((b) => b.boards?.length || b.cards?.length)) this.bus.publish(ws, 'tasks.changed', {});
    if (incoming.messages || incoming.conversations) this.bus.publish(ws, 'messages.changed', {});
    return { head, preview: plan, incoming, applied: true, result: total, conflicts: this.content.openConflicts(ws) };
  }

  /** Busca a chave atual no envelope deste aparelho (depois de um giro feito em outro computador). */
  async refreshKey(userId: string, ws: string): Promise<number> {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    let env: { keyVersion: number; wrapped: string };
    try { env = await this.client.call('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/envelope`, undefined, c.session); }
    catch (e) {
      if ((e as HttpError).status !== 404) throw e;
      // o giro pode ter sido feito DAQUI com a resposta perdida no caminho: a chave nova está guardada como candidata
      const meu = await this.adotarGiro(userId, ws).catch(() => null);
      if (meu) return meu;
      throw new HttpError(409, 'key_pending', 'A chave nova do workspace ainda não chegou a este computador.');
    }
    if (env.keyVersion <= r.key_version) return r.key_version;
    const dek = unwrapForDevice(env.wrapped, c.keys.x25519, r.sync_workspace_id, env.keyVersion);
    this.saveKeys(ws, env.keyVersion, dek, this.keyring(r));
    this.db.run('UPDATE world_sync SET rotation_pending = 0, giro_candidato = NULL WHERE workspace_id = ?', ws);
    return env.keyVersion;
  }

  /**
   * Um giro pedido deste computador cuja resposta se perdeu: se a mudança de giro que está no World é a daqui (mesma
   * operação, mesma versão), a chave candidata guardada antes do pedido é a chave atual. Sem isto o workspace ficaria
   * numa versão de chave que ninguém tem. Devolve a versão adotada, ou null.
   */
  private async adotarGiro(userId: string, ws: string): Promise<number | null> {
    const r = this.row(ws); const cand = r ? this.candidato(r) : null;
    if (!r || !cand || cand.v <= r.key_version) return null;
    const c = this.ctx(userId);
    const m = await this.mudancas(c.session, r.sync_workspace_id, r.last_version);
    if (!m.changes.some((x) => x.kind === 'rotation' && x.operationId === cand.op && x.keyVersion === cand.v && x.deviceId === c.deviceId)) return null;
    const dek = Buffer.from(cand.chave, 'base64'); const ring = this.keyring(r); ring.set(cand.v, dek);
    this.saveKeys(ws, cand.v, dek, ring);
    this.db.run('UPDATE world_sync SET rotation_pending = 0, giro_candidato = NULL WHERE workspace_id = ?', ws);
    this.log({ ws, versao: cand.v }, 'sincronia: o giro da chave feito daqui estava no World (a resposta tinha se perdido); chave nova adotada');
    // o envelope deste aparelho (se falhar agora, a próxima entrega de chave o refaz: este aparelho aparece na lista)
    await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: cand.v, wrapped: wrapForDevice(dek, c.keys.x25519Public, r.sync_workspace_id, cand.v) }, c.session).catch(() => undefined);
    return cand.v;
  }

  /** Os giros trazem, cifradas com a chave nova, as chaves de antes: quem ficou continua lendo o histórico. */
  private learnKeys(ws: string, r: SyncRow, changes: Change[]): Map<number, Buffer> {
    const ring = this.keyring(r); let learned = false;
    for (const x of [...changes].filter((y) => y.kind === 'rotation').sort((a, b) => b.keyVersion - a.keyVersion)) {
      const k = ring.get(x.keyVersion); if (!k) continue;
      const body = openChange<{ type?: string; previousKeys?: Record<string, string> }>(k, r.sync_workspace_id, x);
      for (const [v, key] of Object.entries(body.previousKeys ?? {})) {
        if (!/^\d+$/.test(v) || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || ring.has(Number(v))) continue;
        ring.set(Number(v), Buffer.from(key, 'base64')); learned = true;
      }
    }
    if (learned) this.saveKeys(ws, r.key_version, ring.get(r.key_version)!, ring);
    return ring;
  }

  /**
   * Gira a chave do workspace depois que alguém saiu (dono ou admin, de um computador que tem a chave): nasce uma chave
   * nova; o giro vai ao World cifrado com ela, levando as chaves anteriores (quem ficou continua lendo o histórico; quem
   * saiu não recebe a nova); a chave nova é entregue a cada aparelho de quem ficou; o World libera os envios de novo.
   * Com a frase, o envelope de recuperação passa a abrir a chave nova.
   */
  async rotate(userId: string, ws: string, recoveryPhrase?: string) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId); const ring = this.keyring(r);
    const p = await this.client.call<{ head: number; keyVersion?: number }>('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/changes?since=${r.last_version}`, undefined, c.session);
    if ((p.keyVersion ?? r.key_version) > r.key_version) { // já girou (outro computador, ou este com a resposta perdida): só pega a chave nova
      const meu = await this.adotarGiro(userId, ws).catch(() => null);
      if (!meu) await this.refreshKey(userId, ws);
      return { rotated: !!meu, keyVersion: this.row(ws)!.key_version, shared: (await this.share(userId, ws, { motivo: 'giro' }).catch(() => ({ shared: 0 }))).shared };
    }
    const next = r.key_version + 1;
    // a chave nova fica guardada ANTES do pedido (w0011) e uma nova tentativa usa a mesma chave e a mesma operação: se o
    // World aceitou e a resposta se perdeu, nada fica numa versão de chave que ninguém tem
    const antes = this.candidato(r);
    const cand: GiroCandidato = antes?.v === next ? antes : { v: next, chave: newWorkspaceKey().toString('base64'), op: `rot_${crypto.randomBytes(9).toString('hex')}` };
    if (cand !== antes) this.db.run('UPDATE world_sync SET giro_candidato = ? WHERE workspace_id = ?', this.db.seal(ws, JSON.stringify(cand)), ws);
    const dek = Buffer.from(cand.chave, 'base64');
    const previousKeys = Object.fromEntries([...ring].map(([v, k]) => [String(v), k.toString('base64')]));
    const sealed = sealChange(dek, r.sync_workspace_id, { type: 'rotation', previousKeys }, { operationId: cand.op, expectedVersion: p.head, schemaVersion: 1, keyVersion: next, kind: 'rotation', deviceId: c.deviceId }, c.keys.ed25519);
    let version: number;
    try { version = (await this.client.call<{ version: number }>('POST', `/v1/sync/workspaces/${r.sync_workspace_id}/changes`, sealed, c.session)).version; }
    catch (e) {
      const code = (e as HttpError).code;
      if (code === 'version_conflict' || code === 'key_version') throw new HttpError(409, code, 'O workspace mudou enquanto a chave era trocada. Tente de novo.');
      if (code === 'sync_forbidden') throw new HttpError(403, 'sync_forbidden', 'Só quem administra o workspace troca a chave.');
      throw e;
    }
    // a partir daqui a chave nova vale no World: guarda antes de qualquer outra chamada
    ring.set(next, dek); this.saveKeys(ws, next, dek, ring);
    this.db.run('UPDATE world_sync SET rotation_pending = 0, giro_candidato = NULL, last_version = CASE WHEN last_version = ? THEN ? ELSE last_version END, updated_at = ? WHERE workspace_id = ?', p.head, version, now(), ws);
    await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: next, wrapped: wrapForDevice(dek, c.keys.x25519Public, r.sync_workspace_id, next) }, c.session);
    if (recoveryPhrase) await this.setRecovery(userId, ws, recoveryPhrase);
    const shared = (await this.share(userId, ws, { motivo: 'giro' }).catch(() => ({ shared: 0 }))).shared;
    return { rotated: true, keyVersion: next, shared };
  }

  /** Envelope de recuperação para a chave atual (depois de um giro, a frase antiga só abria a chave anterior). */
  async setRecovery(userId: string, ws: string, recoveryPhrase: string) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'recovery', keyVersion: r.key_version, wrapped: wrapForRecovery(this.dek(r), recoveryPhrase, r.sync_workspace_id, r.key_version) }, c.session);
    this.db.run('UPDATE world_sync SET recovery_key_version = ? WHERE workspace_id = ?', r.key_version, ws);
    return this.status(ws);
  }

  conflicts(userId: string, ws: string) { return this.content.conflicts(ws, userId); }
  resolve(userId: string, ws: string, conflictId: string, keep: 'mine' | 'theirs') {
    const out = this.content.resolve(ws, userId, conflictId, keep);
    this.bus.publish(ws, 'tasks.changed', {});
    return out;
  }
}

/** A mudança veio de um aparelho da conta dona do workspace (como o World a registrou). Dono ou autor desconhecido: não. */
const doDono = (r: SyncRow, x: Change) => !!r.dono_conta && x.accountId === r.dono_conta;

/** A hora em que o esqueleto foi gerado fica fora do resumo: só a equipe em si conta. */
const blueprintHash = (bp: object) => crypto.createHash('sha256').update(JSON.stringify({ ...bp, createdAt: undefined })).digest('hex');
