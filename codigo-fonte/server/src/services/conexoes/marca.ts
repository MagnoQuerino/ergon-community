/**
 * O que chegou de fora a cada execução (e-mail, página, mensagem recebida, dado de uma conta), marcado pelo sistema e
 * nunca pelo modelo; a regra (regra.ts) lê esta marca. Chaves de conteudo_externo: a sessão do motor, conv:<id> e
 * task:<id>. A marca de uma execução vale para a sessão, a conversa e o card dela, e para a cadeia que a originou: o
 * card pai, a execução que abriu o card e as conversas deles (o resultado sobe por esse caminho).
 * Fica fora do serviço das Conexões para quem só monta texto (pedidos, boas-vindas, rotinas) consultar e marcar também.
 */
import type { Db } from '../../db/db.ts';
import { clip, now } from '../../lib/util.ts';
import { sessionKeyFor, type RunRow } from '../runs.ts';

type ChaveRun = Pick<RunRow, 'id' | 'workspace_id' | 'agent_id' | 'conversation_id' | 'task_id'>;
export interface Lido { deFora: boolean; privado: boolean }

/** origin_run_id de um card de lote leva o grupo depois de ":" (purpose.attach): o id da execução é o que vem antes. */
export const runDeOrigem = (x: string | null): string | null => (x ? x.split(':')[0] : null);

function chavesDe(db: Db, r: ChaveRun): string[] {
  const out = [sessionKeyFor(r)];
  if (r.conversation_id) out.push(`conv:${r.conversation_id}`);
  if (r.task_id) {
    out.push(`task:${r.task_id}`);
    const c = db.get<{ c: string | null }>('SELECT conversation_id AS c FROM tasks WHERE id = ?', r.task_id)?.c;
    if (c) out.push(`conv:${c}`); // o resultado do card é entregue naquela conversa
  }
  return out;
}

/** As chaves da execução (ou, sem execução, só as do card) e as da cadeia que a originou. */
export function cadeiaDe(db: Db, r: ChaveRun | null, taskId: string | null = r?.task_id ?? null): string[] {
  const chaves = new Set<string>(r ? chavesDe(db, r) : []);
  const pendentes: Array<string | null> = [taskId];
  const vistos = new Set<string>();
  for (let i = 0; pendentes.length && i < 12; i++) {
    const tid = pendentes.pop();
    if (!tid || vistos.has(tid)) continue;
    vistos.add(tid);
    chaves.add(`task:${tid}`);
    const t = db.get<{ parent_task_id: string | null; origin_run_id: string | null; conversation_id: string | null }>('SELECT parent_task_id, origin_run_id, conversation_id FROM tasks WHERE id = ?', tid);
    if (!t) continue;
    if (t.conversation_id) chaves.add(`conv:${t.conversation_id}`);
    pendentes.push(t.parent_task_id);
    const oid = runDeOrigem(t.origin_run_id);
    const o = oid ? db.get<ChaveRun>('SELECT id, workspace_id, agent_id, conversation_id, task_id FROM runs WHERE id = ?', oid) : null;
    if (o) { for (const k of chavesDe(db, o)) chaves.add(k); pendentes.push(o.task_id); }
  }
  return [...chaves];
}

export function lidoEm(db: Db, chaves: string[]): Lido {
  if (!chaves.length) return { deFora: false, privado: false };
  const row = db.get<{ n: number; p: number | null }>(`SELECT COUNT(*) AS n, MAX(privado) AS p FROM conteudo_externo WHERE chave IN (${chaves.map(() => '?').join(', ')})`, ...chaves);
  return { deFora: Number(row?.n ?? 0) > 0, privado: Number(row?.p ?? 0) > 0 };
}

export function marcarEm(db: Db, workspaceId: string, chaves: string[], o: { privado: boolean; motivo: string }): void {
  for (const k of chaves) {
    db.run(`INSERT INTO conteudo_externo (chave, workspace_id, privado, motivo, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chave) DO UPDATE SET privado = MAX(privado, excluded.privado)`, k, workspaceId, o.privado ? 1 : 0, clip(o.motivo, 80), now());
  }
}

/** Marca a execução e a cadeia dela (o card pai que recebe o resultado do filho também passa a confirmar o envio). */
export const marcarRun = (db: Db, r: ChaveRun, o: { privado: boolean; motivo: string }): void => marcarEm(db, r.workspace_id, cadeiaDe(db, r), o);
/** O que chegou a um card, pela mesma cadeia. */
export const cardLeu = (db: Db, taskId: string): Lido => lidoEm(db, cadeiaDe(db, null, taskId));
