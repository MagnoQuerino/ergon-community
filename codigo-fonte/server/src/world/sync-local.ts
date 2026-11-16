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
import type { Bus } from '../services/bus.ts';
import { exportBlueprint, importBlueprint } from '../services/blueprint.ts';
import type { AgentLimits } from '../services/capacity.ts';
import type { Routines } from '../services/routines.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import { type Applied, type ContentBody, ContentSync, parseContent } from './sync-content.ts';
import { newWorkspaceKey, openChange, sealChange, unwrapForDevice, unwrapForRecovery, wrapForDevice, wrapForRecovery } from './sync-crypto.ts';

interface Keys { ed25519: string; x25519: string; x25519Public: string }
interface SyncRow { sync_workspace_id: string; key_version: number; sync_key: string; last_version: number; blueprint_hash: string | null; old_keys: string | null; rotation_pending: number; recovery_key_version: number | null }
type Change = { version: number; operationId: string; keyVersion: number; schemaVersion: number; kind: string; ciphertext: string; nonce: string; deviceId: string };

export class LocalSync {
  readonly db: Db; readonly links: WorldLinks; readonly client: WorldClient; readonly routines: Routines; readonly bus: Bus; readonly limits: AgentLimits; readonly content: ContentSync;
  constructor(d: { db: Db; links: WorldLinks; client: WorldClient; routines: Routines; bus: Bus; limits: AgentLimits }) { this.db = d.db; this.links = d.links; this.client = d.client; this.routines = d.routines; this.bus = d.bus; this.limits = d.limits; this.content = new ContentSync(d.db); }

  private ctx(userId: string) {
    const l = this.links.get(userId); const s = this.links.session(userId);
    if (!l || !s) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World para sincronizar.');
    return { session: s, deviceId: l.device_id, keys: JSON.parse(l.device_keys) as Keys };
  }
  private row(ws: string) { return this.db.get<SyncRow>('SELECT * FROM world_sync WHERE workspace_id = ?', ws); }

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
        rotationPending: !!r.rotation_pending, recoveryOutdated: r.recovery_key_version != null && r.recovery_key_version < r.key_version };
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

  /** Liga o Sync neste workspace (World ativo exigido no servidor). Frase opcional = envelope de recuperação. */
  async enable(userId: string, ws: string, recoveryPhrase?: string) {
    if (this.row(ws)) return this.status(ws);
    const c = this.ctx(userId);
    const origin = this.db.get<{ origin: string }>('SELECT origin FROM world_workspace_ids WHERE workspace_id = ?', ws)?.origin;
    if (origin === 'joined') throw new HttpError(409, 'sync_join', 'Este workspace já sincroniza em outro computador: entre nele com a frase de recuperação ou autorize por lá.');
    const known = this.worldId(ws); // já existe (créditos/plano antes da sincronização): a chave nasce agora, versão 1
    const w = known ? { workspaceId: known, keyVersion: 1 } : await this.client.call<{ workspaceId: string; keyVersion: number }>('POST', '/v1/sync/workspaces', this.labelOf(ws), c.session);
    const dek = newWorkspaceKey();
    await this.client.call('PUT', `/v1/sync/workspaces/${w.workspaceId}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: w.keyVersion, wrapped: wrapForDevice(dek, c.keys.x25519Public, w.workspaceId, w.keyVersion) }, c.session);
    if (recoveryPhrase) await this.client.call('PUT', `/v1/sync/workspaces/${w.workspaceId}/envelopes`, { kind: 'recovery', keyVersion: w.keyVersion, wrapped: wrapForRecovery(dek, recoveryPhrase, w.workspaceId, w.keyVersion) }, c.session);
    this.db.run('INSERT INTO world_sync (workspace_id, user_id, sync_workspace_id, key_version, sync_key, last_version, updated_at, recovery_key_version) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      ws, userId, w.workspaceId, w.keyVersion, this.db.seal(ws, dek.toString('base64')), now(), recoveryPhrase ? w.keyVersion : null);
    return this.status(ws);
  }

  /** Neste aparelho (outro computador da pessoa): entra num workspace World que já existe, pegando a chave. */
  async join(userId: string, ws: string, syncWorkspaceId: string, recoveryPhrase?: string) {
    const c = this.ctx(userId);
    let env: { keyVersion: number; wrapped: string }; let dek: Buffer; let viaRecovery = false;
    try {
      env = await this.client.call('GET', `/v1/sync/workspaces/${syncWorkspaceId}/envelope`, undefined, c.session);
      dek = unwrapForDevice(env.wrapped, c.keys.x25519, syncWorkspaceId, env.keyVersion);
    } catch (e) {
      if (!recoveryPhrase || (e as HttpError).status !== 404) throw e;
      env = await this.client.call('GET', `/v1/sync/workspaces/${syncWorkspaceId}/envelope?kind=recovery`, undefined, c.session);
      try { dek = unwrapForRecovery(env.wrapped, recoveryPhrase, syncWorkspaceId, env.keyVersion); } catch { throw new HttpError(400, 'recovery', 'frase de recuperação não abre a chave deste workspace'); }
      viaRecovery = true;
      await this.client.call('PUT', `/v1/sync/workspaces/${syncWorkspaceId}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: env.keyVersion, wrapped: wrapForDevice(dek, c.keys.x25519Public, syncWorkspaceId, env.keyVersion) }, c.session);
    }
    this.db.run(`INSERT INTO world_sync (workspace_id, user_id, sync_workspace_id, key_version, sync_key, last_version, updated_at, recovery_key_version) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET sync_workspace_id = excluded.sync_workspace_id, key_version = excluded.key_version, sync_key = excluded.sync_key, last_version = 0, blueprint_hash = NULL,
        updated_at = excluded.updated_at, old_keys = NULL, rotation_pending = 0, recovery_key_version = excluded.recovery_key_version`,
    ws, userId, syncWorkspaceId, env.keyVersion, this.db.seal(ws, dek.toString('base64')), now(), viaRecovery ? env.keyVersion : null);
    this.adopt(ws, syncWorkspaceId);
    // outro workspace World: as bases e os conflitos do anterior não valem mais
    this.db.run('DELETE FROM world_sync_records WHERE workspace_id = ?', ws); this.db.run('DELETE FROM world_sync_conflicts WHERE workspace_id = ?', ws);
    return this.status(ws);
  }

  /** Embrulha a chave para os outros aparelhos da pessoa que ainda não a têm (feito por qualquer aparelho que tenha). */
  async share(userId: string, ws: string) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId); const dek = Buffer.from(r.sync_key, 'base64');
    const need = await this.client.call<{ keyVersion: number; devices: Array<{ deviceId: string; syncPublicKey: string }> }>('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/devices-needing-key`, undefined, c.session);
    for (const d of need.devices) await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'device', deviceId: d.deviceId, keyVersion: need.keyVersion, wrapped: wrapForDevice(dek, d.syncPublicKey, r.sync_workspace_id, need.keyVersion) }, c.session);
    return { shared: need.devices.length };
  }

  /**
   * Envia o que mudou aqui: o esqueleto (só se a equipe mudou) e o conteúdo novo ou alterado, em mudanças cifradas e
   * assinadas, cada uma presa à versão anterior. Outro aparelho enviou antes: recusa, para receber e decidir primeiro.
   */
  async push(userId: string, ws: string) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId); const dek = Buffer.from(r.sync_key, 'base64');
    let version = r.last_version; const sent = { tasks: 0, conversations: 0, messages: 0 };
    const send = async (body: unknown, kind: 'snapshot' | 'change', prefix: string) => {
      const sealed = sealChange(dek, r.sync_workspace_id, body, { operationId: `${prefix}_${crypto.randomBytes(9).toString('hex')}`, expectedVersion: version, schemaVersion: 1, keyVersion: r.key_version, kind }, c.keys.ed25519);
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
      this.db.run('UPDATE world_sync SET last_version = ?, updated_at = ? WHERE workspace_id = ?', version, now(), ws);
    };
    const bp = exportBlueprint(this.db, this.routines, ws); const bh = blueprintHash(bp);
    if (bh !== r.blueprint_hash) { await send({ type: 'blueprint', blueprint: bp }, 'snapshot', 'bp'); this.db.run('UPDATE world_sync SET blueprint_hash = ? WHERE workspace_id = ?', bh, ws); }
    for (const part of this.content.chunks(this.content.pending(ws, userId))) {
      await send(part.body, 'change', 'ct');
      this.content.sent(ws, part.items);
      sent.tasks += part.body.tasks.length; sent.conversations += part.body.conversations.length; sent.messages += part.body.messages.length;
    }
    return { version, sent };
  }

  /**
   * Recebe o que os outros aparelhos enviaram desde a última vez: o último esqueleto (prévia; com apply, aplica com as
   * rotinas pausadas) e o conteúdo (com apply, une mensagens e concilia tarefas e conversas; o que mudou dos dois lados
   * vira conflito para a pessoa decidir). Formato inesperado depois de decifrar é recusado, sem aplicar nada.
   */
  async pull(userId: string, ws: string, apply: boolean) {
    let r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    const changes: Change[] = []; let head = r.last_version; let since = r.last_version; let worldKey = r.key_version;
    for (let i = 0; i < 1000; i++) { // o World entrega em páginas
      const p = await this.client.call<{ head: number; keyVersion?: number; changes: Change[] }>('GET', `/v1/sync/workspaces/${r.sync_workspace_id}/changes?since=${since}`, undefined, c.session);
      head = p.head; changes.push(...p.changes); worldKey = Math.max(worldKey, p.keyVersion ?? 0);
      if (!p.changes.length || p.changes[p.changes.length - 1].version >= p.head) break;
      since = p.changes[p.changes.length - 1].version;
    }
    // a chave girou (alguém saiu): pega a nova no envelope deste aparelho e, nos giros, as anteriores
    if (Math.max(worldKey, ...changes.map((x) => x.keyVersion)) > r.key_version) { await this.refreshKey(userId, ws); r = this.row(ws)!; }
    const ring = this.learnKeys(ws, r, changes);
    const open = <T>(x: Change): T => {
      const k = ring.get(x.keyVersion);
      if (!k) throw new HttpError(409, 'key_pending', 'A chave nova do workspace ainda não chegou a este computador.');
      return openChange<T>(k, r.sync_workspace_id, x);
    };
    const others = changes.filter((x) => x.deviceId !== c.deviceId);
    const last = [...others].reverse().find((x) => x.kind === 'snapshot');
    const contents: ContentBody[] = [];
    for (const x of others.filter((y) => y.kind === 'change')) {
      const body = parseContent(open(x));
      if (!body) throw new HttpError(422, 'sync_invalid', `uma mudança recebida (versão ${x.version}) não está no formato esperado: nada foi aplicado`);
      contents.push(body);
    }
    const incoming = { tasks: contents.reduce((n, b) => n + b.tasks.length, 0), conversations: contents.reduce((n, b) => n + b.conversations.length, 0), messages: contents.reduce((n, b) => n + b.messages.length, 0) };
    let plan: unknown = null;
    if (last) plan = importBlueprint(this.db, this.bus, this.routines, ws, userId, open<{ type: string; blueprint: unknown }>(last).blueprint, apply, this.limits);
    if (!apply) return { head, preview: plan, incoming, applied: false };
    if (last) this.db.run('UPDATE world_sync SET blueprint_hash = ? WHERE workspace_id = ?', blueprintHash(exportBlueprint(this.db, this.routines, ws)), ws);
    const total: Applied = { added: 0, updated: 0, conflicts: 0, skipped: 0 };
    for (const [i, body] of contents.entries()) {
      const origin = others.filter((y) => y.kind === 'change')[i].deviceId;
      const n = this.content.apply(ws, userId, body, origin);
      for (const k of Object.keys(total) as Array<keyof Applied>) total[k] += n[k];
    }
    this.db.run('UPDATE world_sync SET last_version = ?, updated_at = ? WHERE workspace_id = ?', head, now(), ws);
    if (incoming.tasks) this.bus.publish(ws, 'tasks.changed', {});
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
      if ((e as HttpError).status === 404) throw new HttpError(409, 'key_pending', 'A chave nova do workspace ainda não chegou a este computador.');
      throw e;
    }
    if (env.keyVersion <= r.key_version) return r.key_version;
    const dek = unwrapForDevice(env.wrapped, c.keys.x25519, r.sync_workspace_id, env.keyVersion);
    this.saveKeys(ws, env.keyVersion, dek, this.keyring(r));
    this.db.run('UPDATE world_sync SET rotation_pending = 0 WHERE workspace_id = ?', ws);
    return env.keyVersion;
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
    if ((p.keyVersion ?? r.key_version) > r.key_version) { // outro computador já girou: só pega a chave nova
      await this.refreshKey(userId, ws);
      return { rotated: false, keyVersion: this.row(ws)!.key_version, shared: (await this.share(userId, ws)).shared };
    }
    const next = r.key_version + 1; const dek = newWorkspaceKey();
    const previousKeys = Object.fromEntries([...ring].map(([v, k]) => [String(v), k.toString('base64')]));
    const sealed = sealChange(dek, r.sync_workspace_id, { type: 'rotation', previousKeys }, { operationId: `rot_${crypto.randomBytes(9).toString('hex')}`, expectedVersion: p.head, schemaVersion: 1, keyVersion: next, kind: 'rotation' }, c.keys.ed25519);
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
    this.db.run('UPDATE world_sync SET rotation_pending = 0, last_version = CASE WHEN last_version = ? THEN ? ELSE last_version END, updated_at = ? WHERE workspace_id = ?', p.head, version, now(), ws);
    await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'device', deviceId: c.deviceId, keyVersion: next, wrapped: wrapForDevice(dek, c.keys.x25519Public, r.sync_workspace_id, next) }, c.session);
    if (recoveryPhrase) await this.setRecovery(userId, ws, recoveryPhrase);
    const shared = (await this.share(userId, ws).catch(() => ({ shared: 0 }))).shared;
    return { rotated: true, keyVersion: next, shared };
  }

  /** Envelope de recuperação para a chave atual (depois de um giro, a frase antiga só abria a chave anterior). */
  async setRecovery(userId: string, ws: string, recoveryPhrase: string) {
    const r = this.row(ws); if (!r) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
    const c = this.ctx(userId);
    await this.client.call('PUT', `/v1/sync/workspaces/${r.sync_workspace_id}/envelopes`, { kind: 'recovery', keyVersion: r.key_version, wrapped: wrapForRecovery(Buffer.from(r.sync_key, 'base64'), recoveryPhrase, r.sync_workspace_id, r.key_version) }, c.session);
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

/** A hora em que o esqueleto foi gerado fica fora do resumo: só a equipe em si conta. */
const blueprintHash = (bp: object) => crypto.createHash('sha256').update(JSON.stringify({ ...bp, createdAt: undefined })).digest('hex');
