/**
 * O aviso de "controle devolvido" (rc.43): quando o navegador ao vivo (ou o computador) voltou sozinho ao agente — prazo
 * vencido, tempo sem uso, aba fechada, sessão trancada —, a pessoa que estava no controle vê um aviso discreto na próxima
 * vez que abrir o Ergon. Lido da auditoria (o que já é registrado a cada devolução), só os dela, só os que ela ainda não
 * viu (marca por pessoa nos ajustes do workspace), dos últimos 7 dias.
 */
import type { Db } from '../db/db.ts';
import { getSetting, setSetting } from './sectors.ts';

/** as devoluções que não foram a pessoa que fez nem o fim do trabalho */
export const MOTIVOS_AUTOMATICOS = ['ocioso', 'teto', 'queda', 'sessao', 'prazo'] as const;
const ACOES = ['navegador.devolveu', 'computador.devolveu'] as const;
const JANELA_MS = 7 * 24 * 3600_000;
const chave = (userId: string) => `controle.devolvido_visto:${userId}`;

export interface AvisoDevolvido { id: string; recurso: 'navegador' | 'computador'; motivo: string; agente: string | null; agentId: string | null; quando: string; conversa: string | null; sala: boolean; tarefa: string | null }

export function avisosDevolvidos(db: Db, ws: string, userId: string, agora = Date.now()): AvisoDevolvido[] {
  const desde = [getSetting(db, ws, chave(userId)) ?? '', new Date(agora - JANELA_MS).toISOString()].sort().pop()!;
  const rows = db.all<{ id: string; action: string; target_id: string | null; evidence: string | null; created_at: string }>(
    `SELECT id, action, target_id, evidence, created_at FROM audit_events
      WHERE workspace_id = ? AND actor_id = ? AND actor_type = 'system' AND action IN (${ACOES.map(() => '?').join(', ')}) AND created_at > ?
      ORDER BY created_at DESC LIMIT 20`, ws, userId, ...ACOES, desde);
  const out: AvisoDevolvido[] = [];
  for (const r of rows) {
    let ev: { motivo?: unknown; agentId?: unknown } = {};
    try { ev = JSON.parse(r.evidence ?? '{}') as typeof ev; } catch { /* sem evidência: fora */ }
    const motivo = String(ev.motivo ?? '');
    if (!(MOTIVOS_AUTOMATICOS as readonly string[]).includes(motivo)) continue;
    const run = r.target_id ? db.get<{ conversation_id: string | null; task_id: string | null; agent_id: string }>('SELECT conversation_id, task_id, agent_id FROM runs WHERE id = ? AND workspace_id = ?', r.target_id, ws) : undefined;
    const agentId = typeof ev.agentId === 'string' ? ev.agentId : run?.agent_id ?? null;
    const agente = agentId ? db.get<{ name: string }>('SELECT name FROM agents WHERE id = ? AND workspace_id = ?', agentId, ws)?.name ?? null : null;
    const sala = run?.conversation_id ? Number(db.get<{ sala: number }>('SELECT sala FROM conversations WHERE id = ? AND workspace_id = ?', run.conversation_id, ws)?.sala ?? 0) === 1 : false;
    out.push({ id: r.id, recurso: r.action.startsWith('computador') ? 'computador' : 'navegador', motivo, agente, agentId, quando: r.created_at, conversa: run?.conversation_id ?? null, sala, tarefa: run?.task_id ?? null });
    if (out.length >= 3) break;
  }
  return out;
}

/** a pessoa viu (ou já estava vendo na hora): até agora, nada mais aparece */
export function marcarDevolvidoVisto(db: Db, ws: string, userId: string, quando = new Date().toISOString()): void {
  setSetting(db, ws, chave(userId), quando);
}
