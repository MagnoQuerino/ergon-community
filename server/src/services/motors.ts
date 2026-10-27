/**
 * Um motor de IA por pessoa. Cada conta tem o próprio contêiner do motor, com cofre próprio (chave
 * derivada da chave pessoal dela) e a própria conta de IA: um agente com Terminal ou Executar código não alcança os
 * dados de outra pessoa, e o consumo de IA é de quem pediu. O gerente de motores — o único contêiner com acesso ao
 * Docker — cria, liga e desliga os contêineres; aqui o Ergon escolhe o motor de cada workspace, entrega a chave do
 * cofre quando a pessoa abre a parte dela e reconhece qual motor está chamando a ponte (um token por motor, derivado
 * do da instalação; nenhum motor tem o da instalação).
 *
 * Sem gerente configurado (ERGON_MOTOR_MANAGER_URL vazio): um motor só para todos, como antes.
 */
import crypto from 'node:crypto';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { safeEqual } from '../lib/util.ts';
import type { Vault } from '../security/keys.ts';
import { AiService } from './ai.ts';
import { setMotorScope } from './characters.ts';
import { HttpHermesClient, HttpHermesControl, type HermesClient, type HermesControlClient } from './hermes.ts';
import { isAdmin, type WorkspaceOwners } from './people.ts';
import { instanceSetting, setInstanceSetting } from './security.ts';

/** Nome do contêiner do motor da pessoa (é também o endereço dele na rede interna). */
export const motorName = (userId: string): string => `ergon-motor-${userId.slice(4)}`;
/** Segredos de cada motor, derivados do token da instalação (o Ergon e o gerente calculam igual; o motor só tem o dele). */
export function motorSecret(master: string, purpose: 'bridge' | 'api' | 'dashboard', userId: string): string {
  return crypto.createHmac('sha256', master).update(`ergon/motor-${purpose}/${userId}`).digest('hex');
}

export type MotorState = 'desligado' | 'ligando' | 'aberto' | 'erro';
interface MotorClients { hermes: HermesClient | null; control: HermesControlClient | null }

export interface MotorDeps {
  cfg: Config; db: Db; vault: Vault; owners: WorkspaceOwners;
  /** o motor de antes (um motor só): usado quando não há gerente */
  legacy: MotorClients;
  /** testes: clientes por pessoa (sem rede) */
  clients?: (userId: string) => MotorClients;
  /** testes: no lugar do fetch (gerente e receptor do cofre) */
  fetch?: typeof fetch;
}

export class Motors {
  readonly perPerson: boolean;
  private readonly d: MotorDeps;
  private readonly master: string;
  private readonly people = new Map<string, MotorClients & { ai: AiService }>();
  private readonly legacyAi: AiService;
  private readonly states = new Map<string, { state: MotorState; error: string | null; at: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly lastUse = new Map<string, number>();

  constructor(d: MotorDeps) {
    this.d = d;
    this.master = d.cfg.bridgeToken ?? '';
    this.perPerson = !!d.cfg.motorManagerUrl && !!d.cfg.bridgeToken && d.cfg.mode === 'local';
    this.legacyAi = new AiService(d.cfg, d.legacy.hermes, d.legacy.control);
    setMotorScope((ws) => this.scope(ws));
  }

  /** De qual motor é o workspace: a pessoa dona dele (um motor por pessoa) ou "_" (um motor só). */
  scope(workspaceId: string | null | undefined): string {
    if (!this.perPerson || !workspaceId) return '_';
    return this.d.owners.of(workspaceId) ?? '_';
  }
  private forUser(userId: string): MotorClients & { ai: AiService } {
    let m = this.people.get(userId);
    if (!m) {
      const name = motorName(userId);
      const c = this.d.clients?.(userId) ?? {
        hermes: new HttpHermesClient(`http://${name}:8642`, motorSecret(this.master, 'api', userId)),
        control: new HttpHermesControl(`http://${name}:8643`, motorSecret(this.master, 'bridge', userId)),
      };
      m = { ...c, ai: new AiService(this.d.cfg, c.hermes, c.control, userId) };
      this.people.set(userId, m);
    }
    return m;
  }
  private of(workspaceId: string): (MotorClients & { ai: AiService }) | null {
    const s = this.scope(workspaceId);
    return s === '_' ? (this.perPerson ? null : { ...this.d.legacy, ai: this.legacyAi }) : this.forUser(s);
  }
  hermes(workspaceId: string): HermesClient | null { return this.of(workspaceId)?.hermes ?? null; }
  control(workspaceId: string): HermesControlClient | null { return this.of(workspaceId)?.control ?? null; }
  /** Configuração de IA (contas, modelo padrão, ferramentas) do motor do workspace. */
  ai(workspaceId: string): AiService { return this.of(workspaceId)?.ai ?? this.legacyAi; }
  /** Os motores que estão abertos agora (para atualizar ferramentas e modelo em segundo plano). */
  openAis(): AiService[] {
    if (!this.perPerson) return [this.legacyAi];
    return [...this.states].filter(([, s]) => s.state === 'aberto').map(([u]) => this.forUser(u).ai);
  }

  /** Quem está chamando a ponte: a pessoa dona do motor, "_" (um motor só, token da instalação) ou null. */
  identify(token: unknown): string | null {
    if (typeof token !== 'string' || !this.master) return null;
    if (!this.perPerson) return safeEqual(token, this.master) ? '_' : null;
    for (const { id } of this.d.db.all<{ id: string }>('SELECT id FROM users')) if (safeEqual(token, motorSecret(this.master, 'bridge', id))) return id;
    return null;
  }
  /** O motor pode agir sobre este workspace? (o da própria pessoa; com um motor só, qualquer um) */
  allows(motor: string, workspaceId: string): boolean {
    return motor === '_' ? !this.perPerson : this.d.owners.of(workspaceId) === motor;
  }

  state(userId: string): { state: MotorState; error: string | null } {
    if (!this.perPerson) return { state: 'aberto', error: null };
    const s = this.states.get(userId);
    return { state: s?.state ?? 'desligado', error: s?.error ?? null };
  }
  states_(): Array<{ userId: string; state: MotorState; error: string | null }> {
    return [...this.states].map(([userId, s]) => ({ userId, state: s.state, error: s.error }));
  }
  private set(userId: string, state: MotorState, error: string | null = null): void { this.states.set(userId, { state, error, at: Date.now() }); }
  touch(workspaceId: string): void { const s = this.scope(workspaceId); if (s !== '_') this.lastUse.set(s, Date.now()); }

  /** Pronto para trabalhar? Se não, já manda ligar (sem esperar). Usado pela fila, a cada passo. */
  ready(workspaceId: string): boolean {
    if (!this.perPerson) return true;
    const u = this.scope(workspaceId);
    if (u === '_') return false;
    this.touch(workspaceId);
    if (this.state(u).state === 'aberto') return true;
    void this.ensure(u).catch(() => undefined);
    return false;
  }

  private call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const f = this.d.fetch ?? fetch;
    return f(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  }
  private async manager(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await this.call(`${this.d.cfg.motorManagerUrl}${path}`, {
      method, headers: { 'X-Ergon-Manager-Token': this.master, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 120_000,
    });
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    if (!r.ok) throw new Error(String(j.error ?? `gerente de motores respondeu ${r.status}`));
    return j;
  }

  /**
   * Liga o motor da pessoa (cria na primeira vez) e abre o cofre dele com a chave derivada da chave pessoal. A pessoa
   * precisa estar com a parte aberta. A primeira conta herda o motor de antes (o mesmo cofre): a senha do cofre troca
   * da chave da instalação para a dela, uma vez.
   */
  ensure(userId: string): Promise<void> {
    if (!this.perPerson) return Promise.resolve();
    const running = this.pending.get(userId);
    if (running) return running;
    const p = this.doEnsure(userId).finally(() => this.pending.delete(userId));
    this.pending.set(userId, p);
    return p;
  }
  private async doEnsure(userId: string): Promise<void> {
    const { db, vault } = this.d;
    if (!vault.personOpen(userId)) { this.set(userId, 'desligado', 'a parte da pessoa está fechada'); return; }
    this.set(userId, 'ligando');
    try {
      const legacyOwner = instanceSetting(db, 'motor_legacy_owner');
      const adoptLegacy = isAdmin(db, userId) && (!legacyOwner || legacyOwner === userId);
      const r = await this.manager('POST', `/v1/motors/${userId}/ensure`, { adoptLegacy });
      if (r.adopted && legacyOwner !== userId) setInstanceSetting(db, 'motor_legacy_owner', userId);
      const rekey = instanceSetting(db, 'motor_legacy_owner') === userId && !instanceSetting(db, 'motor_legacy_rekeyed');
      await this.unlockVault(userId, rekey ? vault.hermesKey() : undefined);
      if (rekey) setInstanceSetting(db, 'motor_legacy_rekeyed', new Date().toISOString());
      this.set(userId, 'aberto');
      this.lastUse.set(userId, Date.now());
      const ai = this.forUser(userId).ai;
      void ai.refreshToolsets(); void ai.defaultModel().catch(() => null);
    } catch (e) {
      this.set(userId, 'erro', (e as Error).message.slice(0, 300));
      throw e;
    }
  }
  /** O receptor do cofre sobe junto com o contêiner: espera ele responder (até ~2 min) e entrega a chave. */
  private async unlockVault(userId: string, previous?: string): Promise<void> {
    const base = `http://${motorName(userId)}:8644`;
    const h = { 'X-Ergon-Bridge-Token': motorSecret(this.master, 'bridge', userId), 'Content-Type': 'application/json' };
    let last = 'o cofre do motor não respondeu';
    for (let i = 0; i < 60; i++) {
      try {
        const st = await this.call(`${base}/status`, { headers: h, timeoutMs: 3000 }).then((r) => r.json() as Promise<{ sealed?: boolean }>);
        if (!st.sealed) return;
        const r = await this.call(`${base}/unlock`, { method: 'POST', headers: h, body: JSON.stringify({ key: this.d.vault.motorKey(userId), ...(previous ? { previous } : {}) }), timeoutMs: 30 * 60_000 });
        const j = await r.json().catch(() => ({})) as { error?: string };
        if (r.ok) return;
        throw new Error(j.error ?? `cofre do motor respondeu ${r.status}`);
      } catch (e) {
        // receptor ainda subindo (sem resposta) ou o motor já em execução (o receptor fecha depois de abrir)
        last = (e as Error).message;
        if (/não confere|inválid|falha ao montar|não consegui/.test(last)) throw e;
        if (i > 3 && /fetch failed|ECONNREFUSED|timeout|aborted/i.test(last)) {
          // depois de aberto o receptor some: confere se o motor já responde pela API
          const ok = await this.forUser(userId).hermes?.health().then((x) => x.ok).catch(() => false);
          if (ok) return;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(last);
  }

  async stop(userId: string): Promise<void> {
    if (!this.perPerson) return;
    await this.manager('POST', `/v1/motors/${userId}/stop`);
    this.set(userId, 'desligado');
  }
  /** Conta removida: o contêiner e o cofre dela saem (o cofre de antes, herdado, também). */
  async remove(userId: string): Promise<void> {
    if (!this.perPerson) return;
    await this.manager('DELETE', `/v1/motors/${userId}`);
    this.states.delete(userId); this.people.delete(userId); this.lastUse.delete(userId);
  }
  /** Desliga o motor de quem não usa há algum tempo (sem trabalho na fila); volta quando a pessoa precisar. */
  async stopIdle(now = Date.now()): Promise<string[]> {
    if (!this.perPerson) return [];
    const stopped: string[] = [];
    for (const [userId, s] of this.states) {
      if (s.state !== 'aberto') continue;
      if (now - (this.lastUse.get(userId) ?? s.at) < this.d.cfg.motorIdleMinutes * 60_000) continue;
      const busy = this.d.db.get(`SELECT 1 AS x FROM runs r JOIN memberships m ON m.workspace_id = r.workspace_id AND m.role = 'owner'
        WHERE m.user_id = ? AND r.status IN ('queued', 'running', 'waiting_user') LIMIT 1`, userId);
      if (busy) continue;
      try { await this.stop(userId); stopped.push(userId); } catch { /* tenta de novo na próxima volta */ }
    }
    return stopped;
  }
}
