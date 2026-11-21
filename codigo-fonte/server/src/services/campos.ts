/**
 * Campos próprios dos quadros da pessoa (rc.41): cada quadro define os seus (texto, número, data, lista de opções,
 * etiquetas e pessoa) e cada tarefa guarda um valor por campo, conferido pelo tipo.
 *
 * - Valem nos quadros da pessoa, nativos ou espelhados (no espelhado ficam só no Ergon: nada vai para o aplicativo de
 *   origem). O quadro da equipe é dos agentes e não tem campos.
 * - Lista de opções e etiquetas guardam o id da opção (renomear ou recolorir a opção não toca nas tarefas); a cor é uma
 *   chave de uma paleta fixa, que a tela pinta com as cores do tema.
 * - "Mostrar no cartão": as etiquetas aparecem sempre; dos outros campos, até MOSTRAR_MAX por quadro.
 * - Nome, opções e valores são texto da pessoa: cifrados com a chave do workspace.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import type { Bus } from './bus.ts';
import { validDue } from './due.ts';

export const TIPOS_CAMPO = ['text', 'number', 'date', 'select', 'labels', 'person'] as const;
export type TipoCampo = typeof TIPOS_CAMPO[number];
/** a paleta das opções: nomes das cores de função do tema (web/src/styles.css), nunca uma cor solta */
export const PALETA = ['neutro', 'info', 'agua', 'sucesso', 'atencao', 'urgente', 'perigo', 'marca', 'dourado'] as const;
export type CorOpcao = typeof PALETA[number];
export const CAMPOS_MAX = 20;
export const OPCOES_MAX = 30;
export const NOME_CAMPO_MAX = 40;
export const NOME_OPCAO_MAX = 40;
export const TEXTO_CAMPO_MAX = 500;
export const ETIQUETAS_MAX = 12;
/** campos (fora as etiquetas) que podem aparecer no cartão do quadro */
export const MOSTRAR_MAX = 2;

export interface Opcao { id: string; name: string; color: CorOpcao }
export interface Campo { id: string; boardId: string; name: string; type: TipoCampo; options: Opcao[]; position: number; showOnCard: boolean; updatedAt: string }
export type ValorCampo = string | number | string[] | null;
interface Quem { userId: string; workspaceId: string }
interface Linha { id: string; board_id: string; name: string; type: TipoCampo; options: string; position: number; show_on_card: number; updated_at: string }

const lerOpcoes = (s: string): Opcao[] => { try { const v = JSON.parse(s) as Opcao[]; return Array.isArray(v) ? v : []; } catch { return []; } };
const paraCampo = (r: Linha): Campo => ({ id: r.id, boardId: r.board_id, name: r.name, type: r.type, options: lerOpcoes(r.options), position: r.position, showOnCard: !!r.show_on_card, updatedAt: r.updated_at });
const temOpcoes = (t: TipoCampo) => t === 'select' || t === 'labels';

const limpar = (s: unknown, max: number, oque: string) => {
  const n = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'invalid', `Dê um nome ${oque}.`);
  if (n.length > max) throw new HttpError(400, 'invalid', `Nome ${oque} com até ${max} letras.`);
  return n;
};

/** O quadro que pode ter campos: da pessoa (nativo ou espelhado) neste workspace. */
function quadroComCampos(db: Db, ws: string, boardId: string) {
  const b = db.get<{ id: string; audience: string; origin: string }>('SELECT id, audience, origin FROM boards WHERE id = ? AND workspace_id = ?', boardId, ws);
  if (!b) throw notFound('quadro');
  if (b.audience !== 'user') throw new HttpError(409, 'equipe', 'O quadro da equipe é organizado pelos agentes.');
  return b;
}

/** O quadro mudou (nome, colunas, campos): entre aparelhos vale a versão mais recente (world/sync-content.ts). */
export function tocarQuadro(db: Db, boardId: string, quando = now()) { db.run('UPDATE boards SET updated_at = ? WHERE id = ?', quando, boardId); }

export function camposDoQuadro(db: Db, ws: string, boardId: string): Campo[] {
  return db.all<Linha>('SELECT id, board_id, name, type, options, position, show_on_card, updated_at FROM board_fields WHERE board_id = ? AND workspace_id = ? ORDER BY position, rowid', boardId, ws).map(paraCampo);
}
function campo(db: Db, ws: string, fieldId: string): Campo {
  const r = db.get<Linha>('SELECT id, board_id, name, type, options, position, show_on_card, updated_at FROM board_fields WHERE id = ? AND workspace_id = ?', fieldId, ws);
  if (!r) throw notFound('campo');
  return paraCampo(r);
}

/** Confere as opções que a tela manda: nome, cor da paleta, sem repetir; opção sem id ganha um (as que já têm, ficam). */
export function conferirOpcoes(entrada: unknown, antes: Opcao[] = []): Opcao[] {
  if (!Array.isArray(entrada)) throw new HttpError(400, 'invalid', 'opções: uma lista');
  if (entrada.length > OPCOES_MAX) throw new HttpError(400, 'invalid', `Até ${OPCOES_MAX} opções por campo.`);
  const vistos = new Set<string>(); const nomes = new Set<string>();
  return entrada.map((o: { id?: unknown; name?: unknown; color?: unknown }) => {
    const name = limpar(o?.name, NOME_OPCAO_MAX, 'à opção');
    if (nomes.has(name.toLowerCase())) throw new HttpError(400, 'invalid', `Opção repetida: ${name}.`);
    nomes.add(name.toLowerCase());
    const color = (PALETA as readonly string[]).includes(String(o?.color)) ? o.color as CorOpcao : 'neutro';
    // id que a tela devolve só vale se já era deste campo (ou no formato, vindo de outro aparelho); senão, um novo
    const oid = typeof o?.id === 'string' && /^opt_[a-f0-9]{32}$/.test(o.id) && !vistos.has(o.id) && (antes.length === 0 || antes.some((a) => a.id === o.id)) ? o.id : id('opt');
    vistos.add(oid);
    return { id: oid, name, color };
  });
}

function renumerar(db: Db, boardId: string, ordem: string[]) { ordem.forEach((fid, i) => db.run('UPDATE board_fields SET position = ? WHERE id = ? AND board_id = ?', i, fid, boardId)); }
function conferirMostrar(db: Db, ws: string, boardId: string, menos?: string) {
  const n = camposDoQuadro(db, ws, boardId).filter((c) => c.showOnCard && c.type !== 'labels' && c.id !== menos).length;
  if (n >= MOSTRAR_MAX) throw new HttpError(409, 'limite', `Até ${MOSTRAR_MAX} campos aparecem no cartão (as etiquetas aparecem sempre): tire um antes.`);
}

export function criarCampo(db: Db, bus: Bus | null, q: Quem, boardId: string, x: { name: string; type: TipoCampo; options?: unknown; showOnCard?: boolean }): Campo {
  quadroComCampos(db, q.workspaceId, boardId);
  const name = limpar(x.name, NOME_CAMPO_MAX, 'ao campo');
  if (!(TIPOS_CAMPO as readonly string[]).includes(x.type)) throw new HttpError(400, 'invalid', 'tipo de campo desconhecido');
  const atuais = camposDoQuadro(db, q.workspaceId, boardId);
  if (atuais.length >= CAMPOS_MAX) throw new HttpError(409, 'limite', `Até ${CAMPOS_MAX} campos por quadro.`);
  if (atuais.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'repetido', `Já existe um campo chamado “${name}” neste quadro.`);
  const options = temOpcoes(x.type) ? conferirOpcoes(x.options ?? []) : [];
  const mostrar = x.type === 'labels' ? true : !!x.showOnCard;
  if (mostrar && x.type !== 'labels') conferirMostrar(db, q.workspaceId, boardId);
  const fid = id('cmp'); const ts = now();
  db.tx(() => {
    db.run('INSERT INTO board_fields (id, workspace_id, board_id, name, type, options, position, show_on_card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      fid, q.workspaceId, boardId, db.seal(q.workspaceId, name), x.type, db.seal(q.workspaceId, JSON.stringify(options)), atuais.length, mostrar ? 1 : 0, ts, ts);
    tocarQuadro(db, boardId, ts);
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return campo(db, q.workspaceId, fid);
}

export function mudarCampo(db: Db, bus: Bus | null, q: Quem, fieldId: string, x: { name?: string; options?: unknown; position?: number; showOnCard?: boolean }): Campo {
  const c = campo(db, q.workspaceId, fieldId);
  quadroComCampos(db, q.workspaceId, c.boardId);
  const ts = now();
  db.tx(() => {
    if (x.name !== undefined) {
      const name = limpar(x.name, NOME_CAMPO_MAX, 'ao campo');
      if (camposDoQuadro(db, q.workspaceId, c.boardId).some((o) => o.id !== c.id && o.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'repetido', `Já existe um campo chamado “${name}” neste quadro.`);
      db.run('UPDATE board_fields SET name = ? WHERE id = ?', db.seal(q.workspaceId, name), c.id);
    }
    if (x.options !== undefined) {
      if (!temOpcoes(c.type)) throw new HttpError(400, 'invalid', 'Só lista de opções e etiquetas têm opções.');
      db.run('UPDATE board_fields SET options = ? WHERE id = ?', db.seal(q.workspaceId, JSON.stringify(conferirOpcoes(x.options, c.options))), c.id);
    }
    if (x.showOnCard !== undefined && c.type !== 'labels' && x.showOnCard !== c.showOnCard) {
      if (x.showOnCard) conferirMostrar(db, q.workspaceId, c.boardId, c.id);
      db.run('UPDATE board_fields SET show_on_card = ? WHERE id = ?', x.showOnCard ? 1 : 0, c.id);
    }
    if (x.position !== undefined) {
      const ordem = camposDoQuadro(db, q.workspaceId, c.boardId).map((o) => o.id).filter((o) => o !== c.id);
      ordem.splice(Math.max(0, Math.min(ordem.length, Math.trunc(x.position))), 0, c.id);
      renumerar(db, c.boardId, ordem);
    }
    db.run('UPDATE board_fields SET updated_at = ? WHERE id = ?', ts, c.id);
    tocarQuadro(db, c.boardId, ts);
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return campo(db, q.workspaceId, fieldId);
}

/** Tira o campo e os valores dele (sem transação própria: quem chama abre). A lápide avisa os outros aparelhos. */
export function removerCampo(db: Db, ws: string, c: { id: string; boardId: string }, quando = now()) {
  db.run('DELETE FROM task_field_values WHERE field_id = ? AND workspace_id = ?', c.id, ws);
  db.run('DELETE FROM board_fields WHERE id = ? AND workspace_id = ?', c.id, ws);
  db.run("INSERT OR REPLACE INTO board_tombstones (workspace_id, kind, ref, board_id, moved_to, deleted_at) VALUES (?, 'field', ?, ?, NULL, ?)", ws, c.id, c.boardId, quando);
}

export function apagarCampo(db: Db, bus: Bus | null, q: Quem, fieldId: string) {
  const c = campo(db, q.workspaceId, fieldId);
  quadroComCampos(db, q.workspaceId, c.boardId);
  db.tx(() => {
    removerCampo(db, q.workspaceId, c);
    renumerar(db, c.boardId, camposDoQuadro(db, q.workspaceId, c.boardId).map((o) => o.id));
    tocarQuadro(db, c.boardId);
  });
  bus?.publish(q.workspaceId, 'tasks.changed', {});
  return { ok: true };
}

/** Confere um valor pelo tipo do campo; null (ou vazio) tira o valor. Devolve o valor a guardar. */
export function conferirValor(db: Db, ws: string, c: Campo, v: unknown): ValorCampo {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return null;
  switch (c.type) {
    case 'text': {
      if (typeof v !== 'string') break;
      const s = v.trim();
      if (s.length > TEXTO_CAMPO_MAX) throw new HttpError(400, 'invalid', `“${c.name}”: até ${TEXTO_CAMPO_MAX} caracteres.`);
      return s || null;
    }
    case 'number':
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15) return v;
      break;
    case 'date':
      if (typeof v === 'string' && validDue(v)) return v;
      break;
    case 'select':
      if (typeof v === 'string' && c.options.some((o) => o.id === v)) return v;
      break;
    case 'labels': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !c.options.some((o) => o.id === x))) break;
      const unicos = [...new Set(v as string[])];
      if (unicos.length > ETIQUETAS_MAX) throw new HttpError(400, 'invalid', `Até ${ETIQUETAS_MAX} etiquetas por tarefa.`);
      // na ordem das opções do campo: o cartão mostra sempre igual
      return c.options.filter((o) => unicos.includes(o.id)).map((o) => o.id);
    }
    case 'person':
      if (typeof v === 'string' && db.get('SELECT 1 AS x FROM memberships WHERE workspace_id = ? AND user_id = ?', ws, v)) return v;
      break;
  }
  const esperado: Record<TipoCampo, string> = { text: 'um texto', number: 'um número', date: 'uma data (AAAA-MM-DD)', select: 'uma das opções', labels: 'etiquetas da lista', person: 'uma pessoa do workspace' };
  throw new HttpError(400, 'invalid', `“${c.name}” espera ${esperado[c.type]}.`);
}

/** Grava o valor de um campo numa tarefa do mesmo quadro do campo. */
export function definirValor(db: Db, bus: Bus | null, q: Quem, taskId: string, fieldId: string, valor: unknown) {
  const t = db.get<{ board_id: string }>('SELECT board_id FROM tasks WHERE id = ? AND workspace_id = ?', taskId, q.workspaceId);
  if (!t) throw notFound('tarefa');
  const c = campo(db, q.workspaceId, fieldId);
  if (c.boardId !== t.board_id) throw new HttpError(409, 'outro_quadro', 'Este campo é de outro quadro.');
  const v = conferirValor(db, q.workspaceId, c, valor);
  db.run(`INSERT INTO task_field_values (workspace_id, task_id, field_id, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (task_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  q.workspaceId, taskId, fieldId, v === null ? null : db.seal(q.workspaceId, JSON.stringify(v)), now());
  bus?.publish(q.workspaceId, 'tasks.changed', { id: taskId });
  return { fieldId, value: v };
}

/** Os valores das tarefas (por tarefa → campo → valor), só de campos que existem. */
export function valoresDe(db: Db, ws: string, taskIds: string[]): Map<string, Record<string, ValorCampo>> {
  const out = new Map<string, Record<string, ValorCampo>>();
  for (let i = 0; i < taskIds.length; i += 400) {
    const parte = taskIds.slice(i, i + 400);
    for (const r of db.all<{ task_id: string; field_id: string; value: string | null }>(
      `SELECT v.task_id, v.field_id, v.value FROM task_field_values v JOIN board_fields f ON f.id = v.field_id
        WHERE v.workspace_id = ? AND v.value IS NOT NULL AND v.task_id IN (${parte.map(() => '?').join(',')})`, ws, ...parte)) {
      try { (out.get(r.task_id) ?? out.set(r.task_id, {}).get(r.task_id)!)[r.field_id] = JSON.parse(r.value!) as ValorCampo; } catch { /* valor ilegível: fica sem */ }
    }
  }
  return out;
}
