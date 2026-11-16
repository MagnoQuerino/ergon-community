/**
 * World Sync — segunda fatia: o CONTEÚDO do workspace. Tarefas dos quadros do Ergon, conversas e mensagens da pessoa vão
 * em mudanças cifradas incrementais no mesmo log do esqueleto (sync-local.ts).
 * - Mensagem não muda depois de gravada: só se acrescenta, une sem conflito.
 * - Tarefa e conversa: conciliação em três vias contra a base (o resumo do que os dois lados tinham em comum). Mudou só
 *   de um lado, vale esse lado; mudou dos dois, nada é sobrescrito: vira conflito para a pessoa decidir ("manter a minha"
 *   envia a daqui no próximo envio; "ficar com a do outro aparelho" aplica a de lá). Registro em conflito não é enviado.
 * - Tarefa recebida guarda o aparelho de origem: o andamento automático só a trabalha no aparelho onde ela nasceu.
 * Fora desta fatia: tarefas espelhadas (cada aparelho lê da fonte), simulações, execuções, passos e arquivos.
 * Todo registro decifrado é conferido aqui (tipos, tamanhos, valores) antes de tocar no banco: o World não lê o conteúdo
 * e não pode garantir o formato.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { HttpError, id, now } from '../lib/util.ts';
import { defaultBoard, userBoard } from '../services/tasks.ts';
import { chavePeloNome } from '../services/colunas.ts';

export interface PTask {
  id: string; number: number; audience: 'team' | 'user'; column: string; agent: string | null; title: string; description: string;
  purpose: string | null; origin: string; completed: boolean; completedAt: string | null; completedBy: string | null; archived: boolean;
  dueOn: string | null; priority: number; workState: string | null; conversationId: string | null; createdAt: string; updatedAt: string;
}
export interface PConversation { id: string; agent: string; title: string; purpose: string | null; createdAt: string }
export interface PMessage { id: string; conversationId: string; role: 'user' | 'agent' | 'system'; content: string; mode: string; createdAt: string }
export interface ContentBody { type: 'content'; tasks: PTask[]; conversations: PConversation[]; messages: PMessage[] }
type Kind = 'task' | 'conversation' | 'message';
type Rec = PTask | PConversation | PMessage;
interface Pending { kind: Kind; rec: Rec; hash: string }
export interface Applied { added: number; updated: number; conflicts: number; skipped: number }

const ORIGINS = ['manual', 'chat', 'teams', 'whatsapp'];
const WORK = ['solicitada', 'processamento', 'resultado', 'validacao', 'concluida', 'aguardando_info', 'falha', 'revisao', 'aguardando_aprovacao'];
const BY = ['human', 'external', 'agent'];
const ROLES = ['user', 'agent', 'system'];
const MODES = ['real', 'simulated', 'local'];
/** Até ~1 MB de JSON por mudança (cifrado em base64 fica abaixo dos 2 MB que o World aceita). */
const CHUNK = 1_000_000;

/** O número do card é local (cada aparelho numera o seu): fica fora do resumo. */
const hashOf = (kind: Kind, r: Rec) => crypto.createHash('sha256').update(JSON.stringify(kind === 'task' ? { ...r, number: undefined } : r)).digest('hex');

const TASK_SQL = `SELECT t.id, t.number, b.audience, c.name AS column_name, a.name AS agent_name, t.title, t.description, t.purpose, t.origin,
    t.completed, t.completed_at, t.completed_by, t.archived, t.due_on, t.priority, t.work_state, t.conversation_id, t.created_at, t.updated_at
  FROM tasks t JOIN boards b ON b.id = t.board_id JOIN columns c ON c.id = t.column_id LEFT JOIN agents a ON a.id = t.agent_id
  WHERE t.workspace_id = ? AND b.origin = 'native' AND t.is_fixture = 0 AND t.origin IN ('manual', 'chat', 'teams', 'whatsapp')`;
interface TaskRow {
  id: string; number: number; audience: 'team' | 'user'; column_name: string; agent_name: string | null; title: string; description: string; purpose: string | null;
  origin: string; completed: number; completed_at: string | null; completed_by: string | null; archived: number; due_on: string | null; priority: number;
  work_state: string | null; conversation_id: string | null; created_at: string; updated_at: string;
}
const toTask = (r: TaskRow): PTask => ({
  id: r.id, number: r.number, audience: r.audience, column: r.column_name, agent: r.agent_name, title: r.title, description: r.description, purpose: r.purpose ?? null,
  origin: r.origin, completed: !!r.completed, completedAt: r.completed_at, completedBy: r.completed_by, archived: !!r.archived, dueOn: r.due_on, priority: r.priority,
  workState: r.work_state, conversationId: r.conversation_id, createdAt: r.created_at, updatedAt: r.updated_at,
});
const CONV_SQL = `SELECT c.id, a.name AS agent, c.title, c.purpose, c.created_at AS createdAt FROM conversations c JOIN agents a ON a.id = c.agent_id
  WHERE c.workspace_id = ? AND c.owner_user_id = ?`;
const toConv = (r: PConversation): PConversation => ({ id: r.id, agent: r.agent, title: r.title, purpose: r.purpose ?? null, createdAt: r.createdAt });

// ---------------------------------------------------------------- conferência do que chega decifrado
const isId = (v: unknown, p: string) => typeof v === 'string' && new RegExp(`^${p}_[A-Za-z0-9]{8,64}$`).test(v);
const str = (v: unknown, max: number, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const strOrNull = (v: unknown, max: number) => v === null || str(v, max);
const date = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}/.test(v);
function checkTask(x: Record<string, unknown>): PTask | null {
  const ok = isId(x.id, 'tsk') && Number.isInteger(x.number) && (x.number as number) > 0 && ['team', 'user'].includes(String(x.audience)) && str(x.column, 80, 1)
    && strOrNull(x.agent, 80) && str(x.title, 500, 1) && str(x.description, 20_000) && strOrNull(x.purpose, 8000) && ORIGINS.includes(String(x.origin))
    && typeof x.completed === 'boolean' && (x.completedAt === null || date(x.completedAt)) && (x.completedBy === null || BY.includes(String(x.completedBy)))
    && typeof x.archived === 'boolean' && (x.dueOn === null || (typeof x.dueOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.dueOn)))
    && Number.isInteger(x.priority) && Math.abs(x.priority as number) <= 100 && (x.workState === null || WORK.includes(String(x.workState)))
    && (x.conversationId === null || isId(x.conversationId, 'cnv')) && date(x.createdAt) && date(x.updatedAt);
  return ok ? toTask({ id: x.id, number: x.number, audience: x.audience, column_name: x.column, agent_name: x.agent, title: x.title, description: x.description, purpose: x.purpose,
    origin: x.origin, completed: x.completed ? 1 : 0, completed_at: x.completedAt, completed_by: x.completedBy, archived: x.archived ? 1 : 0, due_on: x.dueOn, priority: x.priority,
    work_state: x.workState, conversation_id: x.conversationId, created_at: x.createdAt, updated_at: x.updatedAt } as unknown as TaskRow) : null;
}
function checkConv(x: Record<string, unknown>): PConversation | null {
  return isId(x.id, 'cnv') && str(x.agent, 80, 1) && str(x.title, 200, 1) && strOrNull(x.purpose, 8000) && date(x.createdAt) ? toConv(x as unknown as PConversation) : null;
}
function checkMsg(x: Record<string, unknown>): PMessage | null {
  return isId(x.id, 'msg') && isId(x.conversationId, 'cnv') && ROLES.includes(String(x.role)) && str(x.content, 100_000) && MODES.includes(String(x.mode)) && date(x.createdAt)
    ? { id: x.id as string, conversationId: x.conversationId as string, role: x.role as PMessage['role'], content: x.content as string, mode: x.mode as string, createdAt: x.createdAt as string } : null;
}
/** Corpo decifrado de uma mudança de conteúdo; formato inesperado é recusado inteiro (não aplica pela metade). */
export function parseContent(body: unknown): ContentBody | null {
  const b = body as Record<string, unknown> | null;
  if (!b || b.type !== 'content' || !Array.isArray(b.tasks) || !Array.isArray(b.conversations) || !Array.isArray(b.messages)) return null;
  const tasks = b.tasks.map((x) => checkTask(x as Record<string, unknown>)); const conversations = b.conversations.map((x) => checkConv(x as Record<string, unknown>));
  const messages = b.messages.map((x) => checkMsg(x as Record<string, unknown>));
  if (tasks.includes(null) || conversations.includes(null) || messages.includes(null)) return null;
  return { type: 'content', tasks: tasks as PTask[], conversations: conversations as PConversation[], messages: messages as PMessage[] };
}

export class ContentSync {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  private task(ws: string, taskId: string): PTask | null { const r = this.db.get<TaskRow>(`${TASK_SQL} AND t.id = ?`, ws, taskId); return r ? toTask(r) : null; }
  private conv(ws: string, userId: string, convId: string): PConversation | null { const r = this.db.get<PConversation>(`${CONV_SQL} AND c.id = ?`, ws, userId, convId); return r ? toConv(r) : null; }
  private base(ws: string, kind: Kind, rid: string): string | null { return this.db.get<{ h: string }>('SELECT base_hash AS h FROM world_sync_records WHERE workspace_id = ? AND kind = ? AND record_id = ?', ws, kind, rid)?.h ?? null; }
  private setBase(ws: string, kind: Kind, rid: string, h: string) {
    this.db.run('INSERT INTO world_sync_records (workspace_id, kind, record_id, base_hash) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, kind, record_id) DO UPDATE SET base_hash = excluded.base_hash', ws, kind, rid, h);
  }

  /** O que mudou aqui desde a última concordância (e ainda não foi enviado); registro em conflito espera a decisão. */
  pending(ws: string, userId: string): Pending[] {
    const open = new Set(this.db.all<{ k: string }>("SELECT kind || ':' || record_id AS k FROM world_sync_conflicts WHERE workspace_id = ?", ws).map((r) => r.k));
    const bases = new Map(this.db.all<{ k: string; h: string }>("SELECT kind || ':' || record_id AS k, base_hash AS h FROM world_sync_records WHERE workspace_id = ? AND kind IN ('task', 'conversation')", ws).map((r) => [r.k, r.h]));
    const out: Pending[] = [];
    const add = (kind: Kind, rec: Rec) => { const k = `${kind}:${rec.id}`; const hash = hashOf(kind, rec); if (!open.has(k) && bases.get(k) !== hash) out.push({ kind, rec, hash }); };
    for (const c of this.db.all<PConversation>(CONV_SQL, ws, userId)) add('conversation', toConv(c));
    for (const r of this.db.all<{ id: string; conversationId: string; role: PMessage['role']; content: string; mode: string; createdAt: string }>(
      `SELECT m.id, m.conversation_id AS conversationId, m.role, m.content, m.mode, m.created_at AS createdAt FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = ? AND c.owner_user_id = ? AND m.queued = 0
          AND NOT EXISTS (SELECT 1 FROM world_sync_records s WHERE s.workspace_id = m.workspace_id AND s.kind = 'message' AND s.record_id = m.id)
        ORDER BY m.created_at`, ws, userId)) {
      const rec: PMessage = { id: r.id, conversationId: r.conversationId, role: r.role, content: r.content, mode: r.mode, createdAt: r.createdAt };
      out.push({ kind: 'message', rec, hash: hashOf('message', rec) });
    }
    for (const t of this.db.all<TaskRow>(`${TASK_SQL} ORDER BY t.number`, ws)) add('task', toTask(t));
    return out;
  }

  /** Divide o que vai em mudanças de até ~1 MB (conversas antes das mensagens, tarefas por último). */
  chunks(items: Pending[]): Array<{ body: ContentBody; items: Pending[] }> {
    const out: Array<{ body: ContentBody; items: Pending[] }> = [];
    let cur: { body: ContentBody; items: Pending[] } | null = null; let size = 0;
    for (const it of items) {
      const n = JSON.stringify(it.rec).length;
      if (n > CHUNK) continue; // um registro sozinho maior que o limite não cabe numa mudança: fica aqui (raro: textos já têm teto)
      if (!cur || size + n > CHUNK) { cur = { body: { type: 'content', tasks: [], conversations: [], messages: [] }, items: [] }; out.push(cur); size = 0; }
      if (it.kind === 'task') cur.body.tasks.push(it.rec as PTask); else if (it.kind === 'conversation') cur.body.conversations.push(it.rec as PConversation); else cur.body.messages.push(it.rec as PMessage);
      cur.items.push(it); size += n;
    }
    return out;
  }

  /** Enviado e aceito pelo World: passa a ser a base. */
  sent(ws: string, items: Pending[]) { this.db.tx(() => { for (const it of items) this.setBase(ws, it.kind, it.rec.id, it.hash); }); }

  /** Aplica o que veio de outro aparelho (já conferido por parseContent). */
  apply(ws: string, userId: string, body: ContentBody, originDevice: string): Applied {
    const n: Applied = { added: 0, updated: 0, conflicts: 0, skipped: 0 };
    this.db.tx(() => {
      for (const c of body.conversations) n[this.applyConv(ws, userId, c)]++;
      for (const m of body.messages) {
        if (this.db.get('SELECT 1 AS x FROM messages WHERE id = ?', m.id)) { this.setBase(ws, 'message', m.id, hashOf('message', m)); continue; }
        if (!this.conv(ws, userId, m.conversationId)) { n.skipped++; continue; }
        this.db.run('INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          m.id, ws, m.conversationId, m.role, m.role === 'user' ? userId : null, this.db.seal(ws, m.content), m.mode, m.createdAt);
        this.setBase(ws, 'message', m.id, hashOf('message', m)); n.added++;
      }
      for (const t of body.tasks) n[this.applyTask(ws, t, originDevice)]++;
    });
    return n;
  }

  private threeWay(ws: string, kind: 'task' | 'conversation', rid: string, local: Rec, remote: Rec): 'take' | 'same' | 'conflict' {
    const lh = hashOf(kind, local); const rh = hashOf(kind, remote);
    if (lh === rh) { this.setBase(ws, kind, rid, lh); this.db.run('DELETE FROM world_sync_conflicts WHERE workspace_id = ? AND kind = ? AND record_id = ?', ws, kind, rid); return 'same'; }
    if (this.base(ws, kind, rid) === lh) return 'take';
    this.db.run(`INSERT INTO world_sync_conflicts (id, workspace_id, kind, record_id, remote, remote_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, kind, record_id) DO UPDATE SET remote = excluded.remote, remote_hash = excluded.remote_hash, created_at = excluded.created_at`,
    id('scf'), ws, kind, rid, this.db.seal(ws, JSON.stringify(remote)), rh, now());
    return 'conflict';
  }

  private applyConv(ws: string, userId: string, c: PConversation): keyof Applied {
    const local = this.conv(ws, userId, c.id);
    const agent = this.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = ? AND status = 'active'", ws, c.agent);
    if (!local) {
      if (!agent || this.db.get('SELECT 1 AS x FROM conversations WHERE id = ?', c.id)) return 'skipped'; // sem esse agente aqui (ou de outra pessoa)
      this.db.run('INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        c.id, ws, agent.id, userId, this.db.seal(ws, c.title), `ergon:${ws}:user:${userId}:agent:${agent.id}:conv:${c.id}`, c.createdAt, c.purpose === null ? null : this.db.seal(ws, c.purpose));
      this.setBase(ws, 'conversation', c.id, hashOf('conversation', this.conv(ws, userId, c.id)!)); return 'added';
    }
    const w = this.threeWay(ws, 'conversation', c.id, local, c);
    if (w === 'same') return 'skipped';
    if (w === 'conflict') return 'conflicts';
    this.writeConv(ws, userId, c); return 'updated';
  }
  private writeConv(ws: string, userId: string, c: PConversation) {
    this.db.run('UPDATE conversations SET title = ?, purpose = ? WHERE id = ? AND workspace_id = ?', this.db.seal(ws, c.title), c.purpose === null ? null : this.db.seal(ws, c.purpose), c.id, ws);
    this.setBase(ws, 'conversation', c.id, hashOf('conversation', this.conv(ws, userId, c.id)!));
  }

  private applyTask(ws: string, t: PTask, originDevice: string): keyof Applied {
    const local = this.task(ws, t.id);
    if (!local) {
      if (this.db.get('SELECT 1 AS x FROM tasks WHERE id = ?', t.id)) return 'skipped'; // existe fora dos quadros do Ergon (não deveria)
      const board = t.audience === 'user' ? userBoard(this.db, ws).id : defaultBoard(this.db, ws).id;
      const free = !this.db.get('SELECT 1 AS x FROM tasks WHERE workspace_id = ? AND number = ?', ws, t.number);
      const number = free ? t.number : Number(this.db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE workspace_id = ?', ws)!.n);
      this.db.run(`INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, description, origin, created_at, updated_at, sync_origin)
        VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`, t.id, number, ws, board, this.column(board, t.column), this.db.seal(ws, t.title), t.origin, t.createdAt, t.updatedAt, originDevice);
      this.writeTask(ws, t, false); return 'added';
    }
    const w = this.threeWay(ws, 'task', t.id, local, t);
    if (w === 'same') return 'skipped';
    if (w === 'conflict') return 'conflicts';
    this.writeTask(ws, t, true); return 'updated';
  }
  private column(boardId: string, name: string): string {
    // pelo nome; senão, o nome de fábrica em outro idioma ("Done" de um aparelho em inglês) vale pelo código fixo da coluna
    const aud = this.db.get<{ audience: string }>('SELECT audience FROM boards WHERE id = ?', boardId)?.audience === 'user' ? 'user' : 'team';
    const chave = chavePeloNome(name, aud);
    return (this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND name = ?', boardId, name)
      ?? (chave ? this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND system_key = ?', boardId, chave) : undefined)
      ?? this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? ORDER BY position LIMIT 1', boardId)!).id;
  }
  private writeTask(ws: string, t: PTask, bump: boolean) {
    const board = t.audience === 'user' ? userBoard(this.db, ws).id : defaultBoard(this.db, ws).id;
    const agent = t.agent ? this.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = ? AND status = 'active'", ws, t.agent)?.id ?? null : null;
    const conv = t.conversationId && this.db.get('SELECT 1 AS x FROM conversations WHERE id = ? AND workspace_id = ?', t.conversationId, ws) ? t.conversationId : null;
    this.db.run(`UPDATE tasks SET board_id = ?, column_id = ?, agent_id = ?, title = ?, description = ?, purpose = ?, completed = ?, completed_at = ?, completed_by = ?,
        archived = ?, due_on = ?, priority = ?, work_state = ?, conversation_id = ?, updated_at = ?, revision = revision + ? WHERE id = ? AND workspace_id = ?`,
    board, this.column(board, t.column), agent, this.db.seal(ws, t.title), this.db.seal(ws, t.description), t.purpose === null ? null : this.db.seal(ws, t.purpose),
    t.completed ? 1 : 0, t.completedAt, t.completedBy, t.archived ? 1 : 0, t.dueOn, t.priority, t.workState, conv, t.updatedAt, bump ? 1 : 0, t.id, ws);
    this.setBase(ws, 'task', t.id, hashOf('task', this.task(ws, t.id)!));
  }

  /** Conflitos abertos, com o essencial dos dois lados para a pessoa decidir. */
  conflicts(ws: string, userId: string) {
    return this.db.all<{ id: string; kind: 'task' | 'conversation'; record_id: string; remote: string; created_at: string }>(
      'SELECT id, kind, record_id, remote, created_at FROM world_sync_conflicts WHERE workspace_id = ? ORDER BY created_at', ws).map((c) => {
      const remote = JSON.parse(c.remote) as PTask & PConversation;
      const local = c.kind === 'task' ? this.task(ws, c.record_id) : this.conv(ws, userId, c.record_id);
      const brief = (x: (PTask & PConversation) | null) => x && (c.kind === 'task'
        ? { title: x.title, column: x.column, agent: x.agent, completed: x.completed, dueOn: x.dueOn, updatedAt: x.updatedAt }
        : { title: x.title });
      return { id: c.id, kind: c.kind, recordId: c.record_id, since: c.created_at, mine: brief(local as (PTask & PConversation) | null), theirs: brief(remote) };
    });
  }

  /** "mine": a daqui vale e vai no próximo envio. "theirs": aplica a do outro aparelho aqui. */
  resolve(ws: string, userId: string, conflictId: string, keep: 'mine' | 'theirs') {
    const c = this.db.get<{ kind: 'task' | 'conversation'; record_id: string; remote: string; remote_hash: string }>(
      'SELECT kind, record_id, remote, remote_hash FROM world_sync_conflicts WHERE id = ? AND workspace_id = ?', conflictId, ws);
    if (!c) throw new HttpError(404, 'not_found', 'conflito não encontrado (já resolvido?)');
    this.db.tx(() => {
      if (keep === 'mine') this.setBase(ws, c.kind, c.record_id, c.remote_hash);
      else {
        const parsed = parseContent({ type: 'content', tasks: c.kind === 'task' ? [JSON.parse(c.remote)] : [], conversations: c.kind === 'conversation' ? [JSON.parse(c.remote)] : [], messages: [] });
        if (!parsed) throw new HttpError(422, 'invalid', 'a versão do outro aparelho não está no formato esperado');
        if (c.kind === 'task') { if (!this.task(ws, c.record_id)) throw new HttpError(404, 'not_found', 'a tarefa não existe mais aqui'); this.writeTask(ws, parsed.tasks[0], true); }
        else this.writeConv(ws, userId, parsed.conversations[0]);
      }
      this.db.run('DELETE FROM world_sync_conflicts WHERE id = ?', conflictId);
    });
    return { ok: true, kept: keep };
  }

  openConflicts(ws: string): number { return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM world_sync_conflicts WHERE workspace_id = ?', ws)?.n ?? 0); }
}
