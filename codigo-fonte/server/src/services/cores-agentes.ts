/**
 * As cores da equipe (rc.43, shared/cor-agente.ts): cada agente do workspace com uma cor só dele, na ordem de chegada
 * (created_at, id), contando também os arquivados para que ninguém troque de cor quando outro sai.
 */
import type { Db } from '../db/db.ts';
import { distribuirCores, PALETA_AGENTES, type CorDoAgente } from '../../../shared/cor-agente.ts';

export function coresDaEquipe(db: Db, ws: string): Map<string, CorDoAgente> {
  const ids = db.all<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? ORDER BY created_at, id', ws).map((r) => r.id);
  const out = new Map<string, CorDoAgente>();
  for (const [id, i] of distribuirCores(ids)) out.set(id, PALETA_AGENTES[i]);
  return out;
}
