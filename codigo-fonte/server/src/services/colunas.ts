/**
 * Colunas dos quadros do sistema por um código fixo (system_key), nunca pelo nome: o nome é o que a pessoa vê (e pode
 * aparecer em outro idioma ou ser renomeado); o código é o que o sistema usa para andar com os cards.
 *
 *   todo     → "A fazer"       (a fila da equipe)
 *   doing    → "Em andamento"  ("Fazendo" no quadro da pessoa)
 *   with_you → "Com você"      (o que espera a aprovação da pessoa; só no quadro da equipe)
 *   done     → "Concluído"     ("Feito" no quadro da pessoa)
 *
 * Quadro antigo sem o código (antes da migração 0040, ou trazido de um backup antigo): acha pelo nome de fábrica, em
 * português ou em inglês, e grava o código (marcarColunas), uma vez.
 */
import type { Db } from '../db/db.ts';
import { fold } from '../lib/util.ts';

export type ChaveColuna = 'todo' | 'doing' | 'with_you' | 'done';
export const CHAVES_COLUNA: readonly ChaveColuna[] = ['todo', 'doing', 'with_you', 'done'];

/** Os nomes de fábrica de cada coluna, nos dois idiomas (para os quadros sem código e para o que vem de outro aparelho). */
const NOMES: Record<'team' | 'user', Partial<Record<ChaveColuna, string[]>>> = {
  team: { todo: ['A fazer', 'To do'], doing: ['Em andamento', 'In progress'], with_you: ['Com você', 'With you'], done: ['Concluído', 'Done'] },
  user: { todo: ['A fazer', 'To do'], doing: ['Fazendo', 'Doing', 'In progress'], done: ['Feito', 'Done'] },
};

/** O código de uma coluna pelo nome de fábrica (qualquer idioma), ou null. */
export function chavePeloNome(nome: string, quadro: 'team' | 'user' = 'team'): ChaveColuna | null {
  const n = fold(nome).trim();
  for (const k of CHAVES_COLUNA) if (NOMES[quadro][k]?.some((x) => fold(x) === n)) return k;
  return null;
}

/** A coluna do quadro com aquele código (a primeira, pela posição), ou null. Sem o código gravado: pelo nome de fábrica. */
export function colunaPorChave(db: Db, boardId: string, chave: ChaveColuna): string | null {
  const c = db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND system_key = ? ORDER BY position LIMIT 1', boardId, chave);
  if (c) return c.id;
  const b = db.get<{ audience: string; origin: string }>('SELECT audience, origin FROM boards WHERE id = ?', boardId);
  if (!b || b.origin !== 'native') return null;
  const nomes = NOMES[b.audience === 'user' ? 'user' : 'team'][chave] ?? [];
  const todas = db.all<{ id: string; name: string; system_key: string | null }>('SELECT id, name, system_key FROM columns WHERE board_id = ? ORDER BY position', boardId);
  return todas.find((x) => !x.system_key && nomes.some((n) => fold(n) === fold(x.name)))?.id ?? null;
}

/** O código de uma coluna (null: coluna da pessoa ou de um quadro espelhado). */
export function chaveDaColuna(db: Db, columnId: string | null | undefined): ChaveColuna | null {
  if (!columnId) return null;
  return (db.get<{ k: string | null }>('SELECT system_key AS k FROM columns WHERE id = ?', columnId)?.k ?? null) as ChaveColuna | null;
}

/**
 * Grava o código nas colunas de fábrica dos quadros do sistema de um workspace que ainda não têm (pelo nome, nos dois
 * idiomas). Idempotente; um código por quadro. Devolve quantas colunas marcou.
 */
export function marcarColunas(db: Db, workspaceId: string): number {
  let n = 0;
  const quadros = db.all<{ id: string; audience: string }>("SELECT id, audience FROM boards WHERE workspace_id = ? AND origin = 'native'", workspaceId);
  for (const b of quadros) {
    const cols = db.all<{ id: string; name: string; system_key: string | null }>('SELECT id, name, system_key FROM columns WHERE board_id = ? ORDER BY position, rowid', b.id);
    const usadas = new Set(cols.map((c) => c.system_key).filter(Boolean));
    for (const c of cols) {
      if (c.system_key) continue;
      const k = chavePeloNome(c.name, b.audience === 'user' ? 'user' : 'team');
      if (!k || usadas.has(k)) continue;
      db.run('UPDATE columns SET system_key = ? WHERE id = ?', k, c.id);
      usadas.add(k); n++;
    }
  }
  return n;
}
