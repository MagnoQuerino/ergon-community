/**
 * O trabalho atual de um card e o que só a pessoa resolve nele. Fica num módulo à parte porque a conferência de entrega
 * (results.ts), o serviço das Conexões (conexoes/servico.ts) e a equipe (teamwork.ts) usam o mesmo período: uma nova
 * tentativa da equipe vale dentro do mesmo trabalho, e o que já saiu pela conta nele não sai de novo.
 */
import type { Db } from '../db/db.ts';

/**
 * Desde quando vale o que o serviço registrou para este card: o começo do trabalho atual — a criação do card, a última
 * conclusão, ou o último pedido novo da pessoa (devolver com instrução). Falha, espera, a resposta a uma pergunta e a
 * resposta da equipe ao que travou não recomeçam: o que já saiu pela conta antes delas conta (uma nova tentativa não
 * precisa repetir o e-mail enviado). '' = desde o começo do card.
 */
export function episodioDoCard(db: Db, ws: string, taskId: string): string {
  const rows = db.all<{ state: string; evidence: string; decided_by: string; created_at: string }>(
    "SELECT state, evidence, decided_by, created_at FROM task_results WHERE workspace_id = ? AND task_id = ? AND state IN ('validado', 'confirmado_humano', 'devolvido') ORDER BY created_at DESC, rowid DESC LIMIT 100", ws, taskId);
  for (const x of rows) {
    if (x.state !== 'devolvido') return x.created_at;
    if (!x.decided_by.startsWith('usr_')) continue; // a equipe respondeu ao que travou: o mesmo trabalho
    let ev: { resposta?: unknown } = {};
    try { ev = JSON.parse(x.evidence) as { resposta?: unknown }; } catch { /* evidência ilegível: conta como pedido novo */ }
    if (ev.resposta !== true) return x.created_at;
  }
  return '';
}

/**
 * A última resposta da pessoa a uma pergunta do card dentro do trabalho atual (desde = episodioDoCard). Não recomeça o
 * trabalho, mas um envio que ela pede de novo nela ("o João não recebeu, mande de novo") é um pedido novo dela.
 */
export function respostaDaPessoa(db: Db, ws: string, taskId: string, desde: string): { texto: string; at: string } | null {
  const rows = db.all<{ evidence: string; created_at: string }>(
    "SELECT evidence, created_at FROM task_results WHERE workspace_id = ? AND task_id = ? AND state = 'devolvido' AND substr(decided_by, 1, 4) = 'usr_' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 20",
    ws, taskId, desde);
  for (const x of rows) {
    let ev: { resposta?: unknown; instrucao?: unknown } = {};
    try { ev = JSON.parse(x.evidence) as typeof ev; } catch { continue; }
    if (ev.resposta === true) return { texto: String(ev.instrucao ?? ''), at: x.created_at };
  }
  return null;
}

/**
 * Marca no histórico do card que uma ação numa conta parou no que só a pessoa resolve (o serviço grava; a conferência lê):
 * autorizar a conta de novo, uma ação que ela desligou, ou um envio que o serviço não confirmou (pode ter saído ou não).
 * Com a marca, a equipe não tenta de novo sozinha: o card vai para a pessoa, com o motivo.
 */
export const MARCA_PESSOA = 'conexao.pessoa';
export type MotivoPessoa = 'autorizar' | 'desligada' | 'incerto';
