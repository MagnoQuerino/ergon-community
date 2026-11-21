/**
 * World Sync — os quadros da pessoa e o que vai dentro do cartão (rc.41), no mesmo log cifrado do conteúdo
 * (sync-content.ts chama este módulo). Identidade estável: tudo viaja pelo id.
 *
 * QUADRO ('board'): nome, colunas (na ordem), campos próprios e as lápides do que foi apagado.
 * - O quadro de entrada ("Minhas tarefas") existe em cada aparelho com um id diferente: viaja marcado como `entry` e
 *   casa com o de entrada daqui. As colunas de fábrica dele casam pelo código ("k:todo"); as outras, pelo id.
 * - Sem conflito para a pessoa decidir: colunas e campos se unem (o que um aparelho criou aparece no outro; o que foi
 *   apagado tem lápide e não volta); nome e ordem valem os do lado que mudou por último (boards.updated_at).
 * - Apagar coluna ou quadro: os cards daqui vão para o mesmo destino que foram lá, nunca se perdem. Acontece depois das
 *   tarefas da mesma mudança (que já chegam no lugar novo); o card que só foi movido por isso não vira conflito.
 *
 * CARTÃO ('card', um por tarefa): valores dos campos, subtarefas, links, pessoas, comentários e referências de anexo.
 * - Cada item tem id e data: une por id (nunca duplica), vale o mais recente, e o apagado tem lápide.
 * - Pessoa viaja como "eu" (quem sincroniza) ou pelo nome de usuário; anexo viaja só como referência (o arquivo pode não
 *   estar no outro aparelho: aparece o nome, sem abrir).
 *
 * A base (sync_bases) é o resumo do que este aparelho e o World têm em comum, amarrada ao workspace World (ligado a
 * outro, tudo vai de novo). Tudo o que chega é conferido aqui antes de tocar no banco (tipos, tamanhos, http/https).
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';
import { PALETA, removerCampo, TIPOS_CAMPO, type Opcao, type TipoCampo } from '../services/campos.ts';
import { COMENTARIO_MAX, conferirUrl } from '../services/cartao.ts';
import { userBoard } from '../services/tasks.ts';

export interface PColumn { id: string; name: string; key: string | null }
export interface PField { id: string; name: string; type: TipoCampo; options: Opcao[]; show: boolean; at: string }
export interface PGone { ref: string; to: string | null; at: string }
export interface PBoard {
  id: string; entry: boolean; name: string; updatedAt: string; columns: PColumn[]; goneColumns: PGone[]; fields: PField[]; goneFields: PGone[];
  /** quadro apagado: para onde foram os cards (null = o quadro de entrada) */
  deleted: { to: string | null; at: string } | null;
}
export interface PCard {
  /** o id da tarefa */
  id: string;
  values: Array<{ id: string; v: unknown; at: string }>;
  subtasks: Array<{ id: string; title: string; done: boolean; pos: number; at: string }>;
  links: Array<{ id: string; url: string; title: string; at: string }>;
  people: Array<{ id: string; at: string }>;
  /**
   * `acc`: a conta World de quem escreveu (de pessoa; null se de agente ou sem conta ligada). Só vira "meu" aqui se for a
   * MINHA conta. `me` fica no formato por compatibilidade e sai sempre falso: dito por outro aparelho (de outra pessoa,
   * no workspace compartilhado), ele faria o comentário de alguém virar meu.
   */
  comments: Array<{ id: string; by: 'user' | 'agent'; name: string; me: boolean; acc?: string | null; body: string; at: string }>;
  files: Array<{ id: string; artifactId: string; name: string; at: string }>;
  gone: Array<{ id: string; at: string }>;
}
type Resultado = 'added' | 'updated' | 'skipped';
/** o que este módulo precisa das tarefas (sync-content.ts): o resumo de agora e a base, para mover um card sem criar conflito */
export interface GanchosTarefa { resumo: (ws: string, taskId: string) => string | null; base: (ws: string, taskId: string) => string | null; fixarBase: (ws: string, taskId: string, h: string) => void }

const INTOCADO = '1970-01-01T00:00:00.000Z';
const sha = (x: unknown) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const HEX = '[a-f0-9]{32}';
const eId = (v: unknown, p: string) => typeof v === 'string' && new RegExp(`^${p}_${HEX}$`).test(v);
const str = (v: unknown, max: number, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const data = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v);
const lista = (v: unknown, max: number): v is Array<Record<string, unknown>> => Array.isArray(v) && v.length <= max && v.every((x) => x && typeof x === 'object');
const eRef = (v: unknown) => typeof v === 'string' && new RegExp(`^(k:(todo|doing|with_you|done)|col_${HEX})$`).test(v);
export const refColuna = (c: { id: string; key?: string | null; system_key?: string | null }) => { const k = c.key ?? c.system_key; return k ? `k:${k}` : c.id; };

// ---------------------------------------------------------------- conferência do que chega decifrado
const lapides = (v: unknown, ref: (r: unknown) => boolean, max: number): PGone[] | null =>
  lista(v, max) && v.every((g) => ref(g.ref) && (g.to === null || typeof g.to === 'string' && g.to.length <= 80) && data(g.at)) ? v.map((g) => ({ ref: g.ref as string, to: g.to as string | null, at: g.at as string })) : null;
export function checkBoard(x: Record<string, unknown>): PBoard | null {
  if (!x || !eId(x.id, 'brd') || typeof x.entry !== 'boolean' || !data(x.updatedAt)) return null;
  const del = x.deleted as { to?: unknown; at?: unknown } | null;
  if (del !== null && !(del && typeof del === 'object' && (del.to === null || eId(del.to, 'brd')) && data(del.at))) return null;
  if (!str(x.name, 120, del ? 0 : 1) || !lista(x.columns, 60) || !lista(x.fields, 60)) return null;
  const chaves = ['todo', 'doing', 'with_you', 'done'];
  if (!x.columns.every((c) => eId(c.id, 'col') && str(c.name, 80, 1) && (c.key === null || chaves.includes(String(c.key))))) return null;
  const opcoes = (o: unknown) => lista(o, 60) && o.every((p) => eId(p.id, 'opt') && str(p.name, 80, 1) && (PALETA as readonly string[]).includes(String(p.color)));
  if (!x.fields.every((f) => eId(f.id, 'cmp') && str(f.name, 80, 1) && (TIPOS_CAMPO as readonly string[]).includes(String(f.type)) && opcoes(f.options) && typeof f.show === 'boolean' && data(f.at))) return null;
  const goneColumns = lapides(x.goneColumns, eRef, 500); const goneFields = lapides(x.goneFields, (r) => eId(r, 'cmp'), 500);
  if (!goneColumns || !goneFields) return null;
  // sem repetir coluna nem campo (um registro montado à mão não cria duas vezes)
  if (new Set(x.columns.map((c) => refColuna(c as unknown as PColumn))).size !== x.columns.length || new Set(x.fields.map((f) => f.id)).size !== x.fields.length) return null;
  return {
    id: x.id as string, entry: x.entry, name: x.name as string, updatedAt: x.updatedAt as string, deleted: del ? { to: del.to as string | null, at: del.at as string } : null,
    columns: x.columns.map((c) => ({ id: c.id as string, name: c.name as string, key: (c.key as string | null) ?? null })), goneColumns,
    fields: x.fields.map((f) => ({ id: f.id as string, name: f.name as string, type: f.type as TipoCampo, show: f.show as boolean, at: f.at as string,
      options: (f.options as Opcao[]).map((o) => ({ id: o.id, name: o.name, color: o.color })) })), goneFields,
  };
}
const ePessoa = (v: unknown) => typeof v === 'string' && /^p:[^\s\u0000-\u001f]{1,80}$/.test(v);
const eValor = (v: unknown): boolean => v === null || typeof v === 'number' && Number.isFinite(v) || str(v, 2000) || Array.isArray(v) && v.length <= 60 && v.every((s) => str(s, 80))
  || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && str((v as { u?: unknown }).u, 80));
const urlBoa = (u: unknown) => { try { return str(u, 2100, 1) && conferirUrl(u) === u; } catch { return false; } };
export function checkCard(x: Record<string, unknown>): PCard | null {
  if (!x || !eId(x.id, 'tsk') || !lista(x.values, 60) || !lista(x.subtasks, 300) || !lista(x.links, 100) || !lista(x.people, 100) || !lista(x.comments, 2000) || !lista(x.files, 100) || !lista(x.gone, 5000)) return null;
  const ok = x.values.every((v) => eId(v.id, 'cmp') && eValor(v.v) && data(v.at))
    && x.subtasks.every((s) => eId(s.id, 'sub') && str(s.title, 400, 1) && typeof s.done === 'boolean' && Number.isInteger(s.pos) && (s.pos as number) >= 0 && (s.pos as number) < 100_000 && data(s.at))
    && x.links.every((l) => eId(l.id, 'url') && urlBoa(l.url) && str(l.title, 240) && data(l.at))
    && x.people.every((p) => ePessoa(p.id) && data(p.at))
    && x.comments.every((c) => eId(c.id, 'cmt') && (c.by === 'user' || c.by === 'agent') && str(c.name, 200, 1) && typeof c.me === 'boolean' && (c.acc === undefined || c.acc === null || (typeof c.acc === 'string' && /^acc_[A-Za-z0-9]{6,64}$/.test(c.acc))) && str(c.body, COMENTARIO_MAX * 4, 1) && [...(c.body as string)].length <= COMENTARIO_MAX && data(c.at))
    && x.files.every((f) => eId(f.id, 'anx') && eId(f.artifactId, 'art') && str(f.name, 400, 1) && data(f.at))
    && x.gone.every((g) => (ePessoa(g.id) || /^(sub|url|cmt|anx)_[a-f0-9]{32}$/.test(String(g.id))) && data(g.at));
  if (!ok) return null;
  return {
    id: x.id as string,
    values: x.values.map((v) => ({ id: v.id as string, v: v.v, at: v.at as string })),
    subtasks: x.subtasks.map((s) => ({ id: s.id as string, title: s.title as string, done: s.done as boolean, pos: s.pos as number, at: s.at as string })),
    links: x.links.map((l) => ({ id: l.id as string, url: l.url as string, title: l.title as string, at: l.at as string })),
    people: x.people.map((p) => ({ id: p.id as string, at: p.at as string })),
    comments: x.comments.map((c) => ({ id: c.id as string, by: c.by as 'user' | 'agent', name: c.name as string, me: false, acc: (c.acc as string | null | undefined) ?? null, body: c.body as string, at: c.at as string })),
    files: x.files.map((f) => ({ id: f.id as string, artifactId: f.artifactId as string, name: f.name as string, at: f.at as string })),
    gone: x.gone.map((g) => ({ id: g.id as string, at: g.at as string })),
  };
}

// ---------------------------------------------------------------- resumos (iguais nos dois aparelhos quando o conteúdo é o mesmo)
const porChave = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
export const hashBoard = (b: PBoard) => sha(b.deleted ? { id: b.id, apagado: b.deleted.at } : {
  id: b.entry ? 'entry' : b.id, name: b.name, at: b.updatedAt, cols: b.columns.map((c) => [refColuna(c), c.name]), campos: b.fields.map((f) => [f.id, f.at]),
  semCols: porChave(b.goneColumns, (g) => g.ref).map((g) => [g.ref, g.at]), semCampos: porChave(b.goneFields, (g) => g.ref).map((g) => [g.ref, g.at]),
});
/** A base de um quadro: pelo id; a do quadro de entrada, por um nome fixo (o id dele é de cada aparelho). */
export const chaveBoard = (b: PBoard) => (b.entry ? 'entry' : b.id);
/** Itens por id e data: com os mesmos pares, os dois aparelhos têm o mesmo cartão (cada item vale pela versão mais recente). */
export const hashCard = (c: PCard) => sha({
  itens: porChave([...c.values, ...c.subtasks, ...c.links, ...c.people, ...c.comments, ...c.files].map((i) => [i.id, i.at] as [string, string]), (i) => i[0]),
  sem: porChave(c.gone.map((g) => [g.id, g.at] as [string, string]), (g) => g[0]),
});

export class QuadrosSync {
  readonly db: Db; private readonly tarefas: GanchosTarefa;
  constructor(db: Db, tarefas: GanchosTarefa) { this.db = db; this.tarefas = tarefas; }

  // ---- base: amarrada ao workspace World (ligado a outro, world_sync muda e tudo vai de novo)
  private sal(ws: string) { return this.db.get<{ s: string }>('SELECT sync_workspace_id AS s FROM world_sync WHERE workspace_id = ?', ws)?.s ?? ''; }
  private bases(ws: string, kind: 'board' | 'card') {
    const sal = `${this.sal(ws)}|`;
    return new Map(this.db.all<{ r: string; h: string }>('SELECT record_id AS r, base_hash AS h FROM sync_bases WHERE workspace_id = ? AND kind = ?', ws, kind)
      .filter((x) => x.h.startsWith(sal)).map((x) => [x.r, x.h.slice(sal.length)]));
  }
  fixarBase(ws: string, kind: 'board' | 'card', rid: string, h: string) {
    this.db.run('INSERT INTO sync_bases (workspace_id, kind, record_id, base_hash) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, kind, record_id) DO UPDATE SET base_hash = excluded.base_hash', ws, kind, rid, `${this.sal(ws)}|${h}`);
  }

  // ================================================================ quadros
  private entrada(ws: string) { return userBoard(this.db, ws).id; }
  private quadroLocal(ws: string, boardId: string) {
    return this.db.get<{ id: string; name: string; created_at: string; updated_at: string | null }>("SELECT id, name, created_at, updated_at FROM boards WHERE id = ? AND workspace_id = ? AND origin = 'native' AND audience = 'user'", boardId, ws);
  }
  private colunas(boardId: string) { return this.db.all<{ id: string; name: string; system_key: string | null }>('SELECT id, name, system_key FROM columns WHERE board_id = ? ORDER BY position, rowid', boardId); }
  private campos(ws: string, boardId: string) {
    return this.db.all<{ id: string; name: string; type: TipoCampo; options: string; show_on_card: number; updated_at: string }>(
      'SELECT id, name, type, options, show_on_card, updated_at FROM board_fields WHERE board_id = ? AND workspace_id = ? ORDER BY position, rowid', boardId, ws);
  }
  private lapidesDe(ws: string, kind: 'column' | 'field', boardId: string): PGone[] {
    return this.db.all<{ ref: string; moved_to: string | null; deleted_at: string }>('SELECT ref, moved_to, deleted_at FROM board_tombstones WHERE workspace_id = ? AND kind = ? AND board_id = ?', ws, kind, boardId)
      .map((t) => ({ ref: t.ref, to: t.moved_to, at: t.deleted_at }));
  }
  private montarQuadro(ws: string, b: { id: string; name: string; created_at: string; updated_at: string | null }, entrada: string): PBoard {
    const entry = b.id === entrada;
    return {
      id: b.id, entry, name: b.name, deleted: null,
      // quadro em que a pessoa nunca mexeu: a mesma data em todo aparelho (dois quadros de entrada de fábrica já nascem iguais, sem ida e volta)
      updatedAt: b.updated_at ?? INTOCADO,
      // só o quadro de entrada tem colunas de fábrica (com código)
      columns: this.colunas(b.id).map((c) => ({ id: c.id, name: c.name, key: entry ? c.system_key : null })), goneColumns: this.lapidesDe(ws, 'column', b.id),
      fields: this.campos(ws, b.id).map((f) => { let o: Opcao[] = []; try { o = JSON.parse(f.options) as Opcao[]; } catch { /* sem opções */ } return { id: f.id, name: f.name, type: f.type, options: o, show: !!f.show_on_card, at: f.updated_at }; }),
      goneFields: this.lapidesDe(ws, 'field', b.id),
    };
  }

  /** Os quadros da pessoa (e os apagados) que mudaram desde a última concordância. */
  pendingBoards(ws: string): Array<{ rec: PBoard; hash: string }> {
    const bases = this.bases(ws, 'board'); const entrada = this.entrada(ws); const out: Array<{ rec: PBoard; hash: string }> = [];
    const add = (rec: PBoard) => { const hash = hashBoard(rec); if (bases.get(chaveBoard(rec)) !== hash) out.push({ rec, hash }); };
    for (const b of this.db.all<{ id: string; name: string; created_at: string; updated_at: string | null }>(
      "SELECT id, name, created_at, updated_at FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user' ORDER BY created_at, rowid", ws)) add(this.montarQuadro(ws, b, entrada));
    for (const t of this.db.all<{ ref: string; moved_to: string | null; deleted_at: string }>("SELECT ref, moved_to, deleted_at FROM board_tombstones WHERE workspace_id = ? AND kind = 'board'", ws))
      add({ id: t.ref, entry: false, name: '', updatedAt: t.deleted_at, columns: [], goneColumns: [], fields: [], goneFields: [], deleted: { to: t.moved_to, at: t.deleted_at } });
    return out;
  }

  /** Onde fica, aqui, a tarefa que veio com este quadro (null = o de entrada); quadro que não existe ou foi apagado: o destino da lápide ou o de entrada. */
  quadroDaTarefa(ws: string, boardId: string | null | undefined): string {
    if (!boardId) return this.entrada(ws);
    if (this.quadroLocal(ws, boardId)) return boardId;
    const t = this.db.get<{ moved_to: string | null }>("SELECT moved_to FROM board_tombstones WHERE workspace_id = ? AND kind = 'board' AND ref = ?", ws, boardId);
    return t?.moved_to && this.quadroLocal(ws, t.moved_to) ? t.moved_to : this.entrada(ws);
  }
  /** A coluna daqui para a referência que viajou (id ou "k:código"); coluna apagada: o destino da lápide. null: não achou. */
  colunaPorRef(ws: string, boardId: string, ref: string | null | undefined, pulos = 0): string | null {
    if (!ref) return null;
    const c = ref.startsWith('k:') ? this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND system_key = ? ORDER BY position LIMIT 1', boardId, ref.slice(2))
      : this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND id = ?', boardId, ref);
    if (c) return c.id;
    const t = this.db.get<{ moved_to: string | null }>("SELECT moved_to FROM board_tombstones WHERE workspace_id = ? AND kind = 'column' AND board_id = ? AND ref = ?", ws, boardId, ref);
    return t?.moved_to && pulos < 5 ? this.colunaPorRef(ws, boardId, t.moved_to, pulos + 1) : null;
  }

  /** Move cards por causa do que foi apagado no outro aparelho; o card que estava igual à base continua igual a ela (não vira conflito nem volta). */
  private mover(ws: string, taskIds: string[], mudar: (taskId: string) => void) {
    for (const tid of taskIds) {
      const antes = this.tarefas.resumo(ws, tid); const igual = antes !== null && this.tarefas.base(ws, tid) === antes;
      mudar(tid);
      const depois = this.tarefas.resumo(ws, tid);
      if (igual && depois) this.tarefas.fixarBase(ws, tid, depois);
    }
  }
  private lapide(ws: string, kind: 'board' | 'column' | 'field', boardId: string, g: PGone) {
    this.db.run(`INSERT INTO board_tombstones (workspace_id, kind, ref, board_id, moved_to, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, kind, board_id, ref) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`, ws, kind, g.ref, boardId, g.to, g.at);
  }

  /**
   * Aplica um quadro que veio de outro aparelho. O que apaga (coluna, quadro) volta em `depois`, para rodar quando as
   * tarefas da mesma mudança já estiverem no lugar novo.
   */
  applyBoard(ws: string, r: PBoard): { res: Resultado; depois: Array<() => void> } {
    const depois: Array<() => void> = [];
    const entrada = this.entrada(ws);
    const base = () => this.fixarBase(ws, 'board', chaveBoard(r), hashBoard(r));
    if (r.deleted) {
      if (r.entry) return { res: 'skipped', depois };
      this.lapide(ws, 'board', r.id, { ref: r.id, to: r.deleted.to, at: r.deleted.at });
      base();
      if (!this.quadroLocal(ws, r.id) || r.id === entrada) return { res: 'skipped', depois };
      depois.push(() => this.apagarQuadro(ws, r.id, r.deleted!.to));
      return { res: 'updated', depois };
    }
    const lid = r.entry ? entrada : r.id;
    // apagado aqui: a lápide daqui vai no próximo envio e o outro aparelho apaga o dele
    if (!r.entry && this.db.get("SELECT 1 AS x FROM board_tombstones WHERE workspace_id = ? AND kind = 'board' AND ref = ?", ws, r.id)) return { res: 'skipped', depois };
    let local = this.quadroLocal(ws, lid);
    let res: Resultado = 'updated';
    if (!local) {
      if (this.db.get('SELECT 1 AS x FROM boards WHERE id = ?', lid)) return { res: 'skipped', depois }; // o id existe fora dos quadros da pessoa (não deveria)
      // criado agora (não na data de lá): o quadro de entrada daqui continua sendo o primeiro
      this.db.run("INSERT INTO boards (id, workspace_id, name, origin, audience, created_at, updated_at) VALUES (?, ?, ?, 'native', 'user', ?, ?)", lid, ws, r.name, now(), r.updatedAt);
      local = this.quadroLocal(ws, lid)!; res = 'added';
    }
    const meu = this.montarQuadro(ws, local, entrada);
    const hr = hashBoard(r); const hm = hashBoard(meu);
    if (hr === hm) { base(); return { res: 'skipped', depois }; }
    // vale o lado que mudou por último; empate (raro): o desempate é o mesmo nos dois aparelhos
    const deLa = res === 'added' || r.updatedAt > meu.updatedAt || (r.updatedAt === meu.updatedAt && hr > hm);
    let soAqui = false; // este aparelho tem algo que o outro não mandou: a união vai de volta

    // ---- colunas
    const cols = this.colunas(lid); const porRef = new Map(cols.map((c) => [refColuna(c), c]));
    const semAqui = new Map(meu.goneColumns.map((g) => [g.ref, g])); const semLa = new Map(r.goneColumns.map((g) => [g.ref, g]));
    for (const g of r.goneColumns) this.lapide(ws, 'column', lid, g);
    let fim = cols.length;
    for (const c of r.columns) {
      const ref = refColuna(c); const l = porRef.get(ref);
      if (l) { if (deLa && l.name !== c.name) this.db.run('UPDATE columns SET name = ? WHERE id = ?', c.name, l.id); continue; }
      if (semAqui.has(ref)) { soAqui = true; continue; }
      if (this.db.get('SELECT 1 AS x FROM columns WHERE id = ?', c.id)) continue;
      this.db.run('INSERT INTO columns (id, workspace_id, board_id, name, position, system_key) VALUES (?, ?, ?, ?, ?, ?)', c.id, ws, lid, c.name, fim++, r.entry ? c.key : null);
    }
    const refsLa = new Set(r.columns.map(refColuna));
    if (cols.some((c) => !refsLa.has(refColuna(c)) && !semLa.has(refColuna(c))) || meu.goneColumns.some((g) => !semLa.has(g.ref))) soAqui = true;
    if (deLa) {
      // a ordem de lá; o que só existe aqui fica no fim, na ordem em que estava
      const ordem = r.columns.map(refColuna); const lugar = (c: { id: string; system_key: string | null }) => { const i = ordem.indexOf(refColuna(c)); return i < 0 ? ordem.length : i; };
      [...this.colunas(lid)].map((c, i) => ({ c, i })).sort((a, b) => lugar(a.c) - lugar(b.c) || a.i - b.i).forEach((x, i) => this.db.run('UPDATE columns SET position = ? WHERE id = ?', i, x.c.id));
      if (local.name !== r.name) this.db.run('UPDATE boards SET name = ? WHERE id = ?', r.name, lid);
    }
    for (const g of r.goneColumns) if (porRef.has(g.ref)) depois.push(() => this.apagarColuna(ws, lid, g));

    // ---- campos (por id; de cada um vale a versão mais recente)
    const campos = this.campos(ws, lid); const campoPorId = new Map(campos.map((f) => [f.id, f]));
    const camposSemAqui = new Set(meu.goneFields.map((g) => g.ref)); const camposSemLa = new Set(r.goneFields.map((g) => g.ref));
    let pos = campos.length;
    for (const f of r.fields) {
      const l = campoPorId.get(f.id);
      if (!l) {
        if (camposSemAqui.has(f.id)) { soAqui = true; continue; }
        if (this.db.get('SELECT 1 AS x FROM board_fields WHERE id = ?', f.id)) continue;
        this.db.run('INSERT INTO board_fields (id, workspace_id, board_id, name, type, options, position, show_on_card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          f.id, ws, lid, this.db.seal(ws, f.name), f.type, this.db.seal(ws, JSON.stringify(f.options)), pos++, f.show ? 1 : 0, f.at, f.at);
      } else if (f.at > l.updated_at) {
        this.db.run('UPDATE board_fields SET name = ?, options = ?, show_on_card = ?, updated_at = ? WHERE id = ?', this.db.seal(ws, f.name), this.db.seal(ws, JSON.stringify(f.options)), f.show ? 1 : 0, f.at, f.id);
      } else if (f.at < l.updated_at) soAqui = true;
    }
    for (const g of r.goneFields) { if (campoPorId.has(g.ref)) removerCampo(this.db, ws, { id: g.ref, boardId: lid }, g.at); else this.lapide(ws, 'field', lid, g); }
    const idsLa = new Set(r.fields.map((f) => f.id));
    if (campos.some((f) => !idsLa.has(f.id) && !camposSemLa.has(f.id)) || meu.goneFields.some((g) => !camposSemLa.has(g.ref))) soAqui = true;
    if (deLa) {
      const ordem = r.fields.map((f) => f.id);
      this.campos(ws, lid).map((f, i) => ({ f, i })).sort((a, b) => ((ordem.indexOf(a.f.id) + 1) || 1e6) - ((ordem.indexOf(b.f.id) + 1) || 1e6) || a.i - b.i)
        .forEach((x, i) => this.db.run('UPDATE board_fields SET position = ? WHERE id = ?', i, x.f.id));
    }
    // a união (algo daqui que o outro não tem) é mais nova que os dois lados: o outro aparelho fica com ela inteira
    if (deLa) this.db.run('UPDATE boards SET updated_at = ? WHERE id = ?', soAqui ? now() : r.updatedAt, lid);
    base();
    return { res, depois };
  }

  private apagarColuna(ws: string, boardId: string, g: PGone) {
    const cols = this.colunas(boardId); const alvo = cols.find((c) => refColuna(c) === g.ref);
    if (!alvo || cols.length < 2) return; // a última coluna fica (o quadro precisa de uma)
    const destino = this.colunaPorRef(ws, boardId, g.to);
    const para = destino && destino !== alvo.id ? destino : cols.find((c) => c.id !== alvo.id)!.id;
    const ts = now();
    this.mover(ws, this.db.all<{ id: string }>('SELECT id FROM tasks WHERE column_id = ? AND workspace_id = ?', alvo.id, ws).map((t) => t.id),
      (tid) => this.db.run('UPDATE tasks SET column_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?', para, ts, tid));
    this.db.run('DELETE FROM columns WHERE id = ?', alvo.id);
    this.colunas(boardId).forEach((c, i) => this.db.run('UPDATE columns SET position = ? WHERE id = ?', i, c.id));
  }
  private apagarQuadro(ws: string, boardId: string, para: string | null) {
    if (!this.quadroLocal(ws, boardId) || boardId === this.entrada(ws)) return;
    const destino = para && para !== boardId && this.quadroLocal(ws, para) ? para : this.entrada(ws);
    const col = this.colunas(destino)[0];
    if (!col) return;
    const ts = now();
    this.mover(ws, this.db.all<{ id: string }>('SELECT id FROM tasks WHERE board_id = ? AND workspace_id = ?', boardId, ws).map((t) => t.id),
      (tid) => this.db.run('UPDATE tasks SET board_id = ?, column_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?', destino, col.id, ts, tid));
    for (const f of this.campos(ws, boardId)) removerCampo(this.db, ws, { id: f.id, boardId });
    this.db.run("DELETE FROM board_tombstones WHERE workspace_id = ? AND board_id = ? AND kind <> 'board'", ws, boardId);
    this.db.run('DELETE FROM columns WHERE board_id = ?', boardId);
    this.db.run('DELETE FROM boards WHERE id = ?', boardId);
  }

  // ================================================================ cartões
  /** id de pessoa como viaja: "p:me" (quem sincroniza) ou "p:<nome de usuário>"; null: a conta não existe mais aqui */
  private pessoaParaFora(ws: string, eu: string, userId: string): string | null {
    if (userId === eu) return 'p:me';
    const u = this.db.get<{ username: string }>('SELECT u.username FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ? AND m.workspace_id = ?', userId, ws)?.username;
    return u ? `p:${u}` : null;
  }
  /** a conta daqui para o id que viajou; null: não há conta com esse nome neste aparelho */
  private pessoaDeFora(ws: string, eu: string, pid: string): string | null {
    if (pid === 'p:me') return eu;
    return this.db.get<{ id: string }>('SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.username = ? AND m.workspace_id = ?', pid.slice(2), ws)?.id ?? null;
  }
  /** a conta World de uma pessoa daqui (a ligação dela ao World), ou null */
  private contaWorld(userId: string | null): string | null {
    return userId ? this.db.get<{ a: string }>("SELECT account_id AS a FROM world_links WHERE user_id = ? AND account_id IS NOT NULL", userId)?.a ?? null : null;
  }
  private tipoDoCampo(fieldId: string) { return this.db.get<{ type: string }>('SELECT type FROM board_fields WHERE id = ?', fieldId)?.type ?? null; }

  private montarCartao(ws: string, eu: string, taskId: string): PCard {
    const c: PCard = { id: taskId, values: [], subtasks: [], links: [], people: [], comments: [], files: [], gone: [] };
    for (const v of this.db.all<{ field_id: string; value: string | null; updated_at: string }>('SELECT field_id, value, updated_at FROM task_field_values WHERE task_id = ? AND workspace_id = ?', taskId, ws)) {
      let val: unknown = null; try { val = v.value === null ? null : JSON.parse(v.value); } catch { /* ilegível: vai vazio */ }
      // campo de pessoa: a conta daqui vira "eu" ou o nome de usuário (o id é de cada aparelho)
      if (typeof val === 'string' && /^usr_/.test(val) && this.tipoDoCampo(v.field_id) === 'person') { const p = this.pessoaParaFora(ws, eu, val); val = p ? { u: p.slice(2) } : null; }
      c.values.push({ id: v.field_id, v: val, at: v.updated_at });
    }
    for (const s of this.db.all<{ id: string; title: string; done: number; position: number; updated_at: string }>('SELECT id, title, done, position, updated_at FROM task_subtasks WHERE task_id = ? AND workspace_id = ? ORDER BY position, rowid', taskId, ws))
      c.subtasks.push({ id: s.id, title: s.title, done: !!s.done, pos: s.position, at: s.updated_at });
    for (const l of this.db.all<{ id: string; url: string; title: string; updated_at: string }>('SELECT id, url, title, updated_at FROM task_urls WHERE task_id = ? AND workspace_id = ? ORDER BY created_at, rowid', taskId, ws))
      c.links.push({ id: l.id, url: l.url, title: l.title, at: l.updated_at });
    for (const p of this.db.all<{ user_id: string; created_at: string }>('SELECT user_id, created_at FROM task_people WHERE task_id = ? AND workspace_id = ?', taskId, ws)) {
      const pid = this.pessoaParaFora(ws, eu, p.user_id); if (pid) c.people.push({ id: pid, at: p.created_at });
    }
    for (const p of this.db.all<{ username: string; created_at: string }>('SELECT username, created_at FROM task_people_remote WHERE task_id = ? AND workspace_id = ?', taskId, ws))
      if (!c.people.some((x) => x.id === `p:${p.username}`)) c.people.push({ id: `p:${p.username}`, at: p.created_at });
    for (const m of this.db.all<{ id: string; author_type: 'user' | 'agent'; author_user_id: string | null; author_name: string; body: string; created_at: string }>(
      'SELECT id, author_type, author_user_id, author_name, body, created_at FROM task_comments WHERE task_id = ? AND workspace_id = ? ORDER BY created_at, rowid', taskId, ws))
      c.comments.push({ id: m.id, by: m.author_type, name: m.author_name, me: false, acc: m.author_type === 'user' ? this.contaWorld(m.author_user_id) : null, body: m.body, at: m.created_at });
    for (const f of this.db.all<{ id: string; artifact_id: string; filename: string; created_at: string }>('SELECT id, artifact_id, filename, created_at FROM task_attachments WHERE task_id = ? AND workspace_id = ? ORDER BY created_at, rowid', taskId, ws))
      c.files.push({ id: f.id, artifactId: f.artifact_id, name: f.filename, at: f.created_at });
    for (const g of this.db.all<{ item_id: string; deleted_at: string }>('SELECT item_id, deleted_at FROM card_tombstones WHERE task_id = ? AND workspace_id = ?', taskId, ws)) {
      const gid = /^p:usr_/.test(g.item_id) ? this.pessoaParaFora(ws, eu, g.item_id.slice(2)) : g.item_id;
      if (gid && !c.people.some((p) => p.id === gid)) c.gone.push({ id: gid, at: g.deleted_at });
    }
    return c;
  }

  /** Os cartões (das tarefas que sincronizam) com algo dentro que mudou desde a última concordância. */
  pendingCards(ws: string, eu: string, taskIds: Set<string>): Array<{ rec: PCard; hash: string }> {
    const bases = this.bases(ws, 'card');
    const com = new Set<string>();
    for (const t of ['task_field_values', 'task_subtasks', 'task_urls', 'task_people', 'task_people_remote', 'task_comments', 'task_attachments', 'card_tombstones'])
      for (const r of this.db.all<{ t: string }>(`SELECT DISTINCT task_id AS t FROM ${t} WHERE workspace_id = ?`, ws)) com.add(r.t);
    const out: Array<{ rec: PCard; hash: string }> = [];
    for (const tid of com) {
      if (!taskIds.has(tid)) continue;
      const rec = this.montarCartao(ws, eu, tid); const hash = hashCard(rec);
      if (bases.get(tid) !== hash) out.push({ rec, hash });
    }
    return out;
  }

  /** Une o cartão que veio com o daqui: por id, o mais recente; o apagado não volta. Nunca duplica. */
  applyCard(ws: string, eu: string, r: PCard): Resultado {
    if (!this.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND workspace_id = ?', r.id, ws)) return 'skipped';
    const antes = hashCard(this.montarCartao(ws, eu, r.id));
    const hr = hashCard(r);
    if (antes === hr) { this.fixarBase(ws, 'card', r.id, hr); return 'skipped'; }
    const db = this.db; const tid = r.id;
    // lápides daqui, pelo id como viaja
    const sem = new Map<string, string>();
    for (const g of db.all<{ item_id: string; deleted_at: string }>('SELECT item_id, deleted_at FROM card_tombstones WHERE task_id = ?', tid)) {
      const k = /^p:usr_/.test(g.item_id) ? this.pessoaParaFora(ws, eu, g.item_id.slice(2)) : g.item_id; if (k) sem.set(k, g.deleted_at);
    }
    /** a lápide daqui para o id que viajou (pessoa com conta aqui: pelo id da conta, como a tela grava) */
    const chaveLapide = (wid: string) => { if (!wid.startsWith('p:')) return wid; const u = this.pessoaDeFora(ws, eu, wid); return u ? `p:${u}` : wid; };
    const porLapide = (wid: string, at: string) => db.run(`INSERT INTO card_tombstones (workspace_id, task_id, item_id, deleted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, item_id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`, ws, tid, chaveLapide(wid), at);
    const tirarLapide = (wid: string) => db.run('DELETE FROM card_tombstones WHERE task_id = ? AND item_id = ?', tid, chaveLapide(wid));
    /** o item que chegou entra? (não, se foi apagado aqui depois da versão que veio) */
    const entra = (wid: string, at: string) => { const s = sem.get(wid); if (s !== undefined && s >= at) return false; if (s !== undefined) tirarLapide(wid); return true; };
    const TABELA: Record<string, [string, string]> = { sub: ['task_subtasks', 'updated_at'], url: ['task_urls', 'updated_at'], cmt: ['task_comments', 'created_at'], anx: ['task_attachments', 'created_at'] };

    // ---- o que foi apagado lá
    for (const g of r.gone) {
      if (g.id.startsWith('p:')) {
        const u = this.pessoaDeFora(ws, eu, g.id);
        const l = u ? db.get<{ at: string }>('SELECT created_at AS at FROM task_people WHERE task_id = ? AND user_id = ?', tid, u) : db.get<{ at: string }>('SELECT created_at AS at FROM task_people_remote WHERE task_id = ? AND username = ?', tid, g.id.slice(2));
        if (l && l.at > g.at) continue; // atribuída de novo aqui, depois
        if (u) db.run('DELETE FROM task_people WHERE task_id = ? AND user_id = ?', tid, u);
        db.run('DELETE FROM task_people_remote WHERE task_id = ? AND username = ?', tid, g.id.slice(2));
      } else {
        const [tabela, col] = TABELA[g.id.slice(0, 3)];
        const l = db.get<{ at: string }>(`SELECT ${col} AS at FROM ${tabela} WHERE id = ? AND task_id = ?`, g.id, tid);
        if (l && l.at > g.at) continue;
        db.run(`DELETE FROM ${tabela} WHERE id = ? AND task_id = ?`, g.id, tid);
      }
      porLapide(g.id, g.at);
    }
    // ---- valores (um por campo; vazio também é um valor)
    for (const v of r.values) {
      // só campo do quadro desta tarefa (o id de um campo de outro quadro ou workspace é descartado)
      if (!db.get('SELECT 1 AS x FROM board_fields f JOIN tasks t ON t.board_id = f.board_id AND t.workspace_id = f.workspace_id WHERE f.id = ? AND t.id = ? AND f.workspace_id = ?', v.id, tid, ws)) continue;
      const l = db.get<{ at: string }>('SELECT updated_at AS at FROM task_field_values WHERE task_id = ? AND field_id = ?', tid, v.id);
      if (l && l.at >= v.at) continue;
      let val = v.v;
      const nome = val && typeof val === 'object' && !Array.isArray(val) ? (val as { u: string }).u : null;
      // pessoa: a conta daqui com esse nome; sem conta aqui, fica como veio (não se perde na volta)
      if (nome !== null) val = this.pessoaDeFora(ws, eu, `p:${nome}`) ?? val;
      db.run(`INSERT INTO task_field_values (workspace_id, task_id, field_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (task_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, ws, tid, v.id, val === null ? null : db.seal(ws, JSON.stringify(val)), v.at);
    }
    for (const s of r.subtasks) {
      const l = db.get<{ at: string; t: string }>('SELECT updated_at AS at, task_id AS t FROM task_subtasks WHERE id = ?', s.id);
      if (l ? (l.t !== tid || l.at >= s.at) : !entra(s.id, s.at)) continue;
      if (l) db.run('UPDATE task_subtasks SET title = ?, done = ?, position = ?, updated_at = ? WHERE id = ?', db.seal(ws, s.title), s.done ? 1 : 0, s.pos, s.at, s.id);
      else db.run('INSERT INTO task_subtasks (id, workspace_id, task_id, title, done, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', s.id, ws, tid, db.seal(ws, s.title), s.done ? 1 : 0, s.pos, s.at, s.at);
    }
    for (const k of r.links) {
      const l = db.get<{ at: string; t: string }>('SELECT updated_at AS at, task_id AS t FROM task_urls WHERE id = ?', k.id);
      if (l ? (l.t !== tid || l.at >= k.at) : !entra(k.id, k.at)) continue;
      if (l) db.run('UPDATE task_urls SET url = ?, title = ?, updated_at = ? WHERE id = ?', db.seal(ws, k.url), db.seal(ws, k.title), k.at, k.id);
      else db.run('INSERT INTO task_urls (id, workspace_id, task_id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', k.id, ws, tid, db.seal(ws, k.url), db.seal(ws, k.title), k.at, k.at);
    }
    for (const p of r.people) {
      const u = this.pessoaDeFora(ws, eu, p.id);
      const l = u ? db.get<{ at: string }>('SELECT created_at AS at FROM task_people WHERE task_id = ? AND user_id = ?', tid, u) : db.get<{ at: string }>('SELECT created_at AS at FROM task_people_remote WHERE task_id = ? AND username = ?', tid, p.id.slice(2));
      if (l ? l.at >= p.at : !entra(p.id, p.at)) continue;
      if (u) db.run('INSERT INTO task_people (workspace_id, task_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (task_id, user_id) DO UPDATE SET created_at = excluded.created_at', ws, tid, u, p.at);
      else db.run('INSERT INTO task_people_remote (workspace_id, task_id, username, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (task_id, username) DO UPDATE SET created_at = excluded.created_at', ws, tid, p.id.slice(2), p.at);
    }
    const minhaConta = this.contaWorld(eu);
    for (const m of r.comments) {
      // comentário não muda depois de escrito: o que já está aqui fica como está
      if (db.get('SELECT 1 AS x FROM task_comments WHERE id = ?', m.id) || !entra(m.id, m.at)) continue;
      const agente = m.by === 'agent' ? db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND name = ?', ws, m.name)?.id ?? null : null;
      db.run('INSERT INTO task_comments (id, workspace_id, task_id, author_type, author_user_id, author_agent_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        m.id, ws, tid, m.by, m.by === 'user' && !!m.acc && m.acc === minhaConta ? eu : null, agente, db.seal(ws, m.name), db.seal(ws, m.body), m.at);
    }
    for (const f of r.files) {
      if (db.get('SELECT 1 AS x FROM task_attachments WHERE id = ?', f.id) || !entra(f.id, f.at)) continue;
      // o mesmo arquivo anexado nos dois aparelhos, cada um com o seu id: fica um só (o de menor id, igual nos dois lados)
      const outro = db.get<{ id: string }>('SELECT id FROM task_attachments WHERE task_id = ? AND artifact_id = ?', tid, f.artifactId);
      if (outro && outro.id < f.id) { porLapide(f.id, f.at); continue; }
      if (outro) { db.run('DELETE FROM task_attachments WHERE id = ?', outro.id); porLapide(outro.id, f.at); }
      db.run('INSERT INTO task_attachments (id, workspace_id, task_id, artifact_id, filename, created_at) VALUES (?, ?, ?, ?, ?, ?)', f.id, ws, tid, f.artifactId, db.seal(ws, f.name), f.at);
    }
    // a base é o que o World tem (o que veio): se o daqui ficou diferente (união), vai de volta no próximo envio
    this.fixarBase(ws, 'card', r.id, hr);
    return antes === hashCard(this.montarCartao(ws, eu, r.id)) ? 'skipped' : 'updated';
  }
}
