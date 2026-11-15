/**
 * Trabalho fora deste computador ("Rodar na nuvem"): um cartão entregue a outro executor fica marcado aqui e a fila e o
 * agendador locais deixam de executá-lo. Só o módulo do World marca e desmarca (depois do aceite do World e depois de
 * trazer o cartão de volta). Sem marca, tudo local, como sempre.
 *
 * Cartões: `rotina:<id>` (uma rotina) e `card:<id>` (um card do quadro).
 */
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';

export const routineCard = (routineId: string) => `rotina:${routineId}`;
export const taskCard = (taskId: string) => `card:${taskId}`;

/** Quem executa o cartão agora, se não for este computador (null = local). */
export function remoteHolder(db: Db, workspaceId: string, cardRef: string): string | null {
  return db.get<{ holder: string }>('SELECT holder FROM remote_work WHERE workspace_id = ? AND card_ref = ?', workspaceId, cardRef)?.holder ?? null;
}

/** Marca (holder) ou desmarca (null) o cartão como executado fora daqui. */
export function setRemoteHolder(db: Db, workspaceId: string, cardRef: string, holder: string | null): void {
  if (holder === null) db.run('DELETE FROM remote_work WHERE workspace_id = ? AND card_ref = ?', workspaceId, cardRef);
  else db.run(`INSERT INTO remote_work (workspace_id, card_ref, holder, since) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, card_ref) DO UPDATE SET holder = excluded.holder`, workspaceId, cardRef, holder, now());
}
