/** O que a validação dos blocos visuais confere no banco: o id interno (arquivo, card, conversa) existe neste workspace. */
import type { Db } from '../../db/db.ts';
import { ID_INTERNO, type Conferencia } from '../../../../shared/visuais/esquema.ts';

export function conferenciaDo(db: Db, ws: string): Conferencia {
  return {
    idValido: (id: string) => {
      if (!ID_INTERNO.test(id)) return false;
      const t = id.startsWith('art_') ? 'SELECT 1 AS x FROM artifacts WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL'
        : id.startsWith('tsk_') ? 'SELECT 1 AS x FROM tasks WHERE id = ? AND workspace_id = ?' : 'SELECT 1 AS x FROM conversations WHERE id = ? AND workspace_id = ?';
      return !!db.get(t, id, ws);
    },
  };
}
