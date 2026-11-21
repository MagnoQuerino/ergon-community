/**
 * Os quadros da pessoa (rc.41): vários quadros criados no Ergon, com colunas livres (criar, renomear, reordenar e apagar;
 * nenhuma fixa). Só os quadros nativos da pessoa: o da equipe é dos agentes (colunas com código, services/colunas.ts) e
 * os espelhados têm as colunas do aplicativo de origem.
 *
 * - O primeiro quadro da pessoa ("Minhas tarefas", userBoard) é o de entrada (o que chega pelo chat e pelos canais) e não
 *   se apaga; os outros apagam levando os cards para outro quadro da pessoa (nada se perde).
 * - Apagar uma coluna leva os cards para outra coluna do mesmo quadro; a última coluna não se apaga.
 * - Entre aparelhos (world/sync-content.ts): toda mudança marca o quadro (updated_at: vale a mais recente) e o que se
 *   apaga deixa uma lápide com o destino dos cards, para o outro aparelho fazer o mesmo em vez de devolver o que sumiu.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { userBoard } from './tasks.ts';
import { camposDoQuadro, removerCampo, tocarQuadro } from './campos.ts';

export const NOME_QUADRO_MAX = 60;
export const NOME_COLUNA_MAX = 40;
export const QUADROS_MAX = 50;
export const COLUNAS_MAX = 20;
/** as colunas de um quadro novo (a pessoa muda à vontade) */
export const COLUNAS_INICIAIS = ['A fazer', 'Fazendo', 'Feito'];

interface Quem { userId: string; workspaceId: string }

const limpar = (s: string, max: number, oque: string) => {
  const n = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'invalid', `Dê um nome ${oque}.`);
  if (n.length > max) throw new HttpError(400, 'invalid', `Nome ${oque} com até ${max} letras.`);
  return n;
};

/** O quadro, se for um quadro nativo da pessoa neste workspace (senão, 404 ou 409). */
function quadroDaPessoa(db: Db, ws: string, boardId: string) {
  const b = db.get<{ id: string; name: string; origin: string; audience: string }>('SELECT id, name, origin, audience FROM boards WHERE id = ? AND workspace_id = ?', boardId, ws);
  if (!b) throw new HttpError(404, 'not_found', 'quadro não encontrado');
  if (b.audience !== 'user') throw new HttpError(409, 'equipe', 'O quadro da equipe é organizado pelos agentes.');
  if (b.origin !== 'native') throw new HttpError(409, 'espelho', 'Num quadro espelhado, o quadro e as colunas vêm do aplicativo de origem.');
  return b;
}

function colunaDaPessoa(db: Db, ws: string, columnId: string) {
  const c = db.get<{ id: string; board_id: string; name: string; position: number }>('SELECT id, board_id, name, position FROM columns WHERE id = ? AND workspace_id = ?', columnId, ws);
  if (!c) throw new HttpError(404, 'not_found', 'coluna não encontrada');
  quadroDaPessoa(db, ws, c.board_id);
  return c;
}

/** Reescreve as posições 0..n-1 na ordem dada (ids da mesma coluna ficam como estão). */
function renumerar(db: Db, boardId: string, ordem: string[]) {
  ordem.forEach((cid, i) => db.run('UPDATE columns SET position = ? WHERE id = ? AND board_id = ?', i, cid, boardId));
}
/**
 * Como uma coluna se chama entre aparelhos: o id, ou "k:<código>" nas colunas de fábrica do quadro de entrada (cada
 * aparelho cria as suas, com ids diferentes; o código é o mesmo).
 */
export const refDaColuna = (c: { id: string; system_key?: string | null }) => (c.system_key ? `k:${c.system_key}` : c.id);
const refPorId = (db: Db, columnId: string) => refDaColuna(db.get<{ id: string; system_key: string | null }>('SELECT id, system_key FROM columns WHERE id = ?', columnId)!);
const colunasDe = (db: Db, boardId: string) => db.all<{ id: string; name: string }>('SELECT id, name FROM columns WHERE board_id = ? ORDER BY position, rowid', boardId);

export function criarQuadro(db: Db, bus: Bus | null, q: Quem, nome: string, colunas: string[] = COLUNAS_INICIAIS) {
  const name = limpar(nome, NOME_QUADRO_MAX, 'ao quadro');
  if ((db.get<{ n: number }>("SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user'", q.workspaceId)?.n ?? 0) >= QUADROS_MAX)
    throw new HttpError(409, 'limite', `Até ${QUADROS_MAX} quadros por workspace.`);
  const cols = colunas.map((c) => limpar(c, NOME_COLUNA_MAX, 'à coluna')).slice(0, COLUNAS_MAX);
  if (!cols.length) throw new HttpError(400, 'invalid', 'Um quadro precisa de pelo menos uma coluna.');
  const bid = id('brd');
  db.tx(() => {
    const ts = now();
    db.run("INSERT INTO boards (id, workspace_id, name, origin, audience, created_at, updated_at) VALUES (?, ?, ?, 'native', 'user', ?, ?)", bid, q.workspaceId, name, ts, ts);
    cols.forEach((c, i) => db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', id('col'), q.workspaceId, bid, c, i));
    audit(db, null, { workspaceId: q.workspaceId, actorType: 'user', actorId: q.userId, action: 'quadro.criar', targetType: 'board', targetId: bid, result: name });
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { id: bid, name, columns: colunasDe(db, bid) };
}

export function renomearQuadro(db: Db, bus: Bus | null, q: Quem, boardId: string, nome: string) {
  quadroDaPessoa(db, q.workspaceId, boardId);
  const name = limpar(nome, NOME_QUADRO_MAX, 'ao quadro');
  db.run('UPDATE boards SET name = ?, updated_at = ? WHERE id = ?', name, now(), boardId);
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { id: boardId, name };
}

/** Apaga um quadro da pessoa levando os cards (com subtarefas e tudo) para outro quadro dela, na primeira coluna. */
export function apagarQuadro(db: Db, bus: Bus | null, q: Quem, boardId: string, destino?: string | null) {
  const b = quadroDaPessoa(db, q.workspaceId, boardId);
  const entrada = userBoard(db, q.workspaceId).id;
  if (boardId === entrada) throw new HttpError(409, 'entrada', `“${b.name}” é o quadro de entrada (recebe o que chega pelo chat e pelos canais): renomeie se quiser, mas ele fica.`);
  const alvo = destino ?? entrada;
  if (alvo === boardId) throw new HttpError(400, 'invalid', 'Escolha outro quadro para os cards.');
  quadroDaPessoa(db, q.workspaceId, alvo);
  const col = colunasDe(db, alvo)[0];
  if (!col) throw new HttpError(409, 'sem_coluna', 'O quadro de destino não tem colunas.');
  let movidos = 0;
  db.tx(() => {
    movidos = db.run('UPDATE tasks SET board_id = ?, column_id = ?, revision = revision + 1, updated_at = ? WHERE board_id = ? AND workspace_id = ?', alvo, col.id, now(), boardId, q.workspaceId).changes;
    // os campos são do quadro: saem com ele (e os valores deles nos cards que mudaram de quadro)
    for (const c of camposDoQuadro(db, q.workspaceId, boardId)) removerCampo(db, q.workspaceId, c);
    db.run('DELETE FROM board_tombstones WHERE workspace_id = ? AND board_id = ?', q.workspaceId, boardId);
    db.run('DELETE FROM columns WHERE board_id = ?', boardId);
    db.run('DELETE FROM boards WHERE id = ?', boardId);
    // destino null = o quadro de entrada (o id dele é diferente em cada aparelho)
    db.run("INSERT OR REPLACE INTO board_tombstones (workspace_id, kind, ref, board_id, moved_to, deleted_at) VALUES (?, 'board', ?, ?, ?, ?)", q.workspaceId, boardId, boardId, alvo === entrada ? null : alvo, now());
    audit(db, null, { workspaceId: q.workspaceId, actorType: 'user', actorId: q.userId, action: 'quadro.apagar', targetType: 'board', targetId: boardId, evidence: { destino: alvo, cards: movidos }, result: b.name });
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { ok: true, movidos, destino: alvo };
}

export function criarColuna(db: Db, bus: Bus | null, q: Quem, boardId: string, nome: string, posicao?: number) {
  quadroDaPessoa(db, q.workspaceId, boardId);
  const name = limpar(nome, NOME_COLUNA_MAX, 'à coluna');
  const ordem = colunasDe(db, boardId).map((c) => c.id);
  if (ordem.length >= COLUNAS_MAX) throw new HttpError(409, 'limite', `Até ${COLUNAS_MAX} colunas por quadro.`);
  const cid = id('col');
  db.tx(() => {
    db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', cid, q.workspaceId, boardId, name, ordem.length);
    const p = posicao === undefined ? ordem.length : Math.max(0, Math.min(ordem.length, Math.trunc(posicao)));
    ordem.splice(p, 0, cid); renumerar(db, boardId, ordem);
    tocarQuadro(db, boardId);
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { id: cid, name, columns: colunasDe(db, boardId) };
}

export function mudarColuna(db: Db, bus: Bus | null, q: Quem, columnId: string, x: { name?: string; position?: number }) {
  const c = colunaDaPessoa(db, q.workspaceId, columnId);
  db.tx(() => {
    if (x.name !== undefined) db.run('UPDATE columns SET name = ? WHERE id = ?', limpar(x.name, NOME_COLUNA_MAX, 'à coluna'), columnId);
    if (x.position !== undefined) {
      const ordem = colunasDe(db, c.board_id).map((y) => y.id).filter((y) => y !== columnId);
      ordem.splice(Math.max(0, Math.min(ordem.length, Math.trunc(x.position))), 0, columnId);
      renumerar(db, c.board_id, ordem);
    }
    tocarQuadro(db, c.board_id);
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { columns: colunasDe(db, c.board_id) };
}

/** Apaga a coluna levando os cards para outra do mesmo quadro (a da esquerda, se não disser qual). */
export function apagarColuna(db: Db, bus: Bus | null, q: Quem, columnId: string, destino?: string | null) {
  const c = colunaDaPessoa(db, q.workspaceId, columnId);
  const cols = colunasDe(db, c.board_id);
  if (cols.length < 2) throw new HttpError(409, 'ultima', 'Um quadro precisa de pelo menos uma coluna.');
  const i = cols.findIndex((y) => y.id === columnId);
  const alvo = destino ?? cols[i > 0 ? i - 1 : 1].id;
  if (alvo === columnId || !cols.some((y) => y.id === alvo)) throw new HttpError(400, 'invalid', 'Escolha outra coluna deste quadro para os cards.');
  let movidos = 0;
  db.tx(() => {
    const ref = refPorId(db, columnId);
    movidos = db.run('UPDATE tasks SET column_id = ?, revision = revision + 1, updated_at = ? WHERE column_id = ? AND workspace_id = ?', alvo, now(), columnId, q.workspaceId).changes;
    db.run('DELETE FROM columns WHERE id = ?', columnId);
    db.run("INSERT OR REPLACE INTO board_tombstones (workspace_id, kind, ref, board_id, moved_to, deleted_at) VALUES (?, 'column', ?, ?, ?, ?)", q.workspaceId, ref, c.board_id, refPorId(db, alvo), now());
    tocarQuadro(db, c.board_id);
    renumerar(db, c.board_id, cols.filter((y) => y.id !== columnId).map((y) => y.id));
    audit(db, null, { workspaceId: q.workspaceId, actorType: 'user', actorId: q.userId, action: 'coluna.apagar', targetType: 'board', targetId: c.board_id, evidence: { destino: alvo, cards: movidos }, result: c.name });
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { ok: true, movidos, columns: colunasDe(db, c.board_id) };
}
