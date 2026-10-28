import type { Db } from '../db/db.ts';
import { id, now } from '../lib/util.ts';

export interface BusEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

type Listener = (e: BusEvent) => void;

/**
 * Eventos de interface por workspace (SSE). Não substituem o banco: o cliente reconecta,
 * informa o último seq visto e, se houver lacuna, recarrega o estado por snapshot.
 */
export class Bus {
  private seq = 0;
  private listeners = new Map<string, Set<Listener>>();
  private recent = new Map<string, BusEvent[]>();

  publish(workspaceId: string, type: string, data: Record<string, unknown> = {}): void {
    const e: BusEvent = { seq: ++this.seq, type, data };
    const buf = this.recent.get(workspaceId) ?? [];
    buf.push(e);
    if (buf.length > 200) buf.shift();
    this.recent.set(workspaceId, buf);
    for (const l of this.listeners.get(workspaceId) ?? []) {
      try { l(e); } catch { /* ouvinte desconectado */ }
    }
  }

  subscribe(workspaceId: string, l: Listener): () => void {
    const set = this.listeners.get(workspaceId) ?? new Set();
    set.add(l);
    this.listeners.set(workspaceId, set);
    return () => set.delete(l);
  }

  /** Eventos após `after`, ou null quando o buffer não cobre a lacuna (cliente deve recarregar). */
  since(workspaceId: string, after: number): BusEvent[] | null {
    const buf = this.recent.get(workspaceId) ?? [];
    if (after >= this.seq) return [];
    if (buf.length === 0 || buf[0].seq > after + 1) return null;
    return buf.filter((e) => e.seq > after);
  }

  listenerCount(workspaceId: string): number {
    return this.listeners.get(workspaceId)?.size ?? 0;
  }
}

export interface AuditInput {
  workspaceId: string;
  actorType: 'user' | 'agent' | 'system' | 'connector';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  evidence?: Record<string, unknown> | null;
  result: string;
}

/** Registro de ação com evidência mínima autorizada. Nunca recebe raciocínio de modelo. */
export function audit(db: Db, bus: Bus | null, a: AuditInput): string {
  const auditId = id('aud');
  db.run(
    `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, evidence, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    auditId, a.workspaceId, a.actorType, a.actorId ?? null, a.action, a.targetType ?? null, a.targetId ?? null,
    db.seal(a.workspaceId, a.evidence ? JSON.stringify(a.evidence) : null), db.seal(a.workspaceId, a.result), now(),
  );
  bus?.publish(a.workspaceId, 'audit.created', { id: auditId, action: a.action, targetType: a.targetType ?? null, targetId: a.targetId ?? null });
  return auditId;
}
