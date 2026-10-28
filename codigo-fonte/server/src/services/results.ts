/**
 * Contrato de resultado: um card da equipe só é concluído com evidência. Cada execução da fila gera um registro
 * (task_results, um por execução) com o tipo de trabalho, os critérios aplicados, as evidências e a decisão — e o
 * card segue o estado real do trabalho:
 *
 *   solicitada → processamento → resultado produzido → validação → concluída
 *   (ou: aguardando informações · falha · revisão necessária · aguardando aprovação)
 *
 * Execução concluída não é trabalho concluído. O texto do modelo nunca basta sozinho: "concluído" sem conteúdo,
 * resposta simulada, pergunta pendente, entregável ausente ou número não conferido deixam o card aberto, com o
 * motivo. Ação externa (enviar, pagar, publicar…) nunca é presumida: espera a sua confirmação. Conclusão humana é
 * soberana e nunca é desfeita por aqui.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { saveArtifact } from './artifacts.ts';
import { linkFile, taskFiles, type Operations, type OperationRow } from './operations.ts';
import type { RunRow, RunStatus } from './runs.ts';
import { getTask, updateTask, type Actor } from './tasks.ts';
import { questionIn } from './purpose.ts';

export type ResultKind = 'informativo' | 'documental' | 'dados' | 'externo';
export type ResultState = 'validado' | 'reprovado' | 'aguardando_aprovacao' | 'aguardando_info' | 'sem_confirmacao' | 'falha' | 'confirmado_humano' | 'devolvido';
export type WorkState = 'solicitada' | 'processamento' | 'resultado' | 'validacao' | 'concluida' | 'aguardando_info' | 'falha' | 'revisao' | 'aguardando_aprovacao';
export interface Criterion { id: string; label: string; ok: boolean; detail?: string }
export interface ResultRow {
  id: string; workspace_id: string; task_id: string; run_id: string | null; kind: ResultKind; state: ResultState;
  criteria: string; evidence: string; justification: string; decided_by: string; created_at: string; decided_at: string | null;
}

export const WORK_LABEL: Record<WorkState, string> = {
  solicitada: 'Solicitada', processamento: 'Em processamento', resultado: 'Resultado produzido', validacao: 'Em validação', concluida: 'Concluída',
  aguardando_info: 'Aguardando informações', falha: 'Falha', revisao: 'Revisão necessária', aguardando_aprovacao: 'Aguardando aprovação',
};
export const KIND_LABEL: Record<ResultKind, string> = {
  informativo: 'Informativo (a resposta basta)', documental: 'Documental (exige um documento entregue)',
  dados: 'Dados (números calculados do arquivo)', externo: 'Externo (exige confirmação da fonte)',
};
/** Coluna do quadro de cada estado: revisão, espera e falha ficam em andamento (o estado real aparece no card). */
const COLUMN: Record<WorkState, string> = {
  solicitada: 'A fazer', processamento: 'Em andamento', resultado: 'Em andamento', validacao: 'Em andamento', concluida: 'Concluído',
  aguardando_info: 'Em andamento', falha: 'Em andamento', revisao: 'Em andamento', aguardando_aprovacao: 'Em andamento',
};
const WORK_OF: Record<ResultState, WorkState> = {
  validado: 'concluida', confirmado_humano: 'concluida', aguardando_aprovacao: 'aguardando_aprovacao', sem_confirmacao: 'aguardando_aprovacao',
  aguardando_info: 'aguardando_info', reprovado: 'revisao', falha: 'falha', devolvido: 'solicitada',
};

const has = (t: string, stems: string[]) => stems.some((s) => new RegExp(`(^|[^a-z])${s}`).test(t));
const DATA = ['analis', 'analiz', 'indicador', 'desempenho', 'planilh', 'dados', 'metric', 'estatistic', 'relatori', 'kpi', 'csv', 'percentu', 'contag', 'calcul', 'resumo'];
// Só verbos de ação (infinitivo e imperativo). Radicais soltos pegavam substantivos e adjetivos: "dados públicos" e
// "páginas públicas" (publi[cq]) faziam uma pesquisa virar "ação externa à espera de confirmação", e a resposta não
// voltava a quem pediu; "agenda", "telefone", "compra" e "versão paga" também caíam aqui.
const EXTERNAL = ['enviar\\b', 'envie\\b', 'mandar\\b', 'mande\\b', 'publicar', 'publique', 'postar\\b', 'poste\\b', 'agendar\\b', 'agende\\b',
  'marcar (uma )?reuniao', 'pagar\\b', 'pague\\b', 'quitar', 'transferir', 'transfira', 'comprar\\b', 'compre\\b', 'contratar\\b', 'contrate\\b',
  'ligar para', 'telefonar', 'cadastrar\\b', 'cadastre\\b', 'responder (ao|a|o) (cliente|fornecedor)', 'protocolar', 'submeter', 'assinar'];
const DOCUMENT = ['relatori', 'document', 'propost', 'redig', 'redac', 'escrev', 'texto', 'plano', 'apresentac', 'roteiro', 'artigo', 'carta', 'comunicado', 'parecer', 'manual', 'politica', 'procedimento', 'ata\\b', 'e-?mail', 'resumo', 'minuta', 'contrato', 'briefing', 'post\\b'];

/** Tipo de trabalho, pelas palavras do pedido e pelos arquivos que vieram com ele (sem modelo). */
export function classifyTask(text: string, hasCsvInput: boolean): ResultKind {
  const t = fold(text);
  if (hasCsvInput && has(t, DATA)) return 'dados';
  if (has(t, EXTERNAL)) return 'externo';
  if (has(t, DOCUMENT)) return 'documental';
  return 'informativo';
}

const SIMULATED = '[Simulação — sem modelo de IA]';
/** "Concluído.", "Feito!", "Tarefa realizada com sucesso" — alegação de conclusão sem o trabalho. */
const CLAIM = /^(ok[.!]?\s*)?((a )?tarefa |o trabalho |tudo )?(foi )?(conclu[ií]d[ao]|feit[ao]|pront[ao]|realizad[ao]|finalizad[ao]|entregue|resolvid[ao]|done)( com sucesso)?[.!]*$/i;
const words = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const control = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
const MIN_WORDS: Record<ResultKind, number> = { informativo: 25, documental: 120, dados: 0, externo: 25 };

/**
 * O documento como entrega: sem linhas de controle e sem a frase de conversa antes do título ("Segue o documento…"),
 * quando o título aparece logo no começo. Sem título perto do começo, o texto fica inteiro.
 */
export function deliverableBody(raw: string): string {
  const s = raw.replace(/\[\[[^\]]*\]\]\s*/g, '').trim();
  const lines = s.split(/\r?\n/);
  const h = lines.findIndex((l) => /^#{1,3}\s+\S/.test(l));
  if (h > 0 && h <= 3 && lines.slice(0, h).join(' ').trim().length <= 200) return lines.slice(h).join('\n').trim();
  return s;
}

export class Results {
  private readonly db: Db; private readonly bus: Bus; private readonly ops: Operations;
  private readonly cfg: { filesDir: string; maxUploadBytes: number; storageQuota: number };
  constructor(db: Db, bus: Bus, ops: Operations, cfg: { filesDir: string; maxUploadBytes: number; storageQuota: number }) {
    this.db = db; this.bus = bus; this.ops = ops; this.cfg = cfg;
  }

  latest(workspaceId: string, taskId: string): (ResultRow & { criteriaList: Criterion[]; evidenceData: Record<string, unknown> }) | null {
    const r = this.db.get<ResultRow>('SELECT * FROM task_results WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', workspaceId, taskId);
    if (!r) return null;
    const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
    return { ...r, criteriaList: parse<Criterion[]>(r.criteria, []), evidenceData: parse<Record<string, unknown>>(r.evidence, {}) };
  }

  kindOf(workspaceId: string, taskId: string): ResultKind {
    const t = getTask(this.db, workspaceId, taskId);
    return classifyTask(`${t.title} ${t.description}`, !!this.ops.csvInput(workspaceId, taskId));
  }

  /** Muda o estado real do card (e a coluna correspondente; "concluída" conclui). Conclusão humana não é tocada. */
  setWorkState(workspaceId: string, taskId: string, state: WorkState, note?: string, by: Actor = { type: 'system', id: 'ergon' }): void {
    const t = this.db.get<{ board_id: string; column_id: string; completed: number; completed_by: string | null; work_state: string | null }>(
      'SELECT board_id, column_id, completed, completed_by, work_state FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
    if (!t) return;
    if (Number(t.completed) && state !== 'concluida') return; // concluída (por você ou com evidência): não volta sozinha
    if (t.work_state !== state) {
      this.db.run('UPDATE tasks SET work_state = ?, updated_at = ? WHERE id = ?', state, now(), taskId);
      audit(this.db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'task.work_state', targetType: 'task', targetId: taskId,
        evidence: { de: t.work_state, para: state }, result: note ? `${WORK_LABEL[state]} — ${note}` : WORK_LABEL[state] });
    }
    const colId = this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND name = ? ORDER BY position LIMIT 1', t.board_id, COLUMN[state])?.id;
    const patch: { columnId?: string; completed?: boolean } = {};
    if (colId && colId !== t.column_id) patch.columnId = colId;
    if (state === 'concluida' && !Number(t.completed)) patch.completed = true;
    // concluir por decisão sua fica registrado como conclusão humana (e nada automático a desfaz depois)
    if (Object.keys(patch).length) updateTask(this.db, null, workspaceId, by, taskId, patch);
    this.bus.publish(workspaceId, 'tasks.changed', { id: taskId });
  }

  /** Grava a decisão (uma por execução: repetir não duplica) e leva o card ao estado que ela determina. */
  private record(workspaceId: string, taskId: string, runId: string | null, kind: ResultKind, state: ResultState, criteria: Criterion[],
    evidence: Record<string, unknown>, justification: string, decidedBy: string): ResultRow {
    const rid = id('res');
    const ts = now();
    const inserted = this.db.tx(() => {
      const r = this.db.run(`INSERT OR IGNORE INTO task_results (id, workspace_id, task_id, run_id, kind, state, criteria, evidence, justification, decided_by, created_at, decided_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rid, workspaceId, taskId, runId, kind, state, JSON.stringify(criteria), this.db.seal(workspaceId, JSON.stringify(evidence)), this.db.seal(workspaceId, justification), decidedBy, ts, ts);
      if (!r.changes) return false;
      audit(this.db, null, { workspaceId, actorType: decidedBy.startsWith('usr_') ? 'user' : 'system', actorId: decidedBy, action: 'task.result', targetType: 'task', targetId: taskId,
        evidence: { resultId: rid, runId, kind, state, criteria: criteria.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`) }, result: justification });
      return true;
    });
    if (!inserted) return this.db.get<ResultRow>('SELECT * FROM task_results WHERE run_id = ?', runId)!;
    this.setWorkState(workspaceId, taskId, WORK_OF[state], justification, decidedBy.startsWith('usr_') ? { type: 'user', id: decidedBy } : undefined);
    return this.db.get<ResultRow>('SELECT * FROM task_results WHERE id = ?', rid)!;
  }

  /**
   * Avalia o fim de uma execução da fila da equipe. Idempotente pela execução (reinício do servidor não duplica nem
   * muda a decisão). Devolve null quando não há o que decidir (card já concluído por uma pessoa, ou sem card).
   * plan: card com etapas — o conteúdo conta o que todas as etapas entregaram (o resumo de 3 linhas da última etapa
   * vem depois da pesquisa e do texto completo das anteriores).
   */
  evaluate(r: RunRow, status: RunStatus, output: string | null, plan: { words: number } | null = null): ResultRow | null {
    if (!r.task_id) return null;
    const ws = r.workspace_id;
    const done = this.db.get<ResultRow>('SELECT * FROM task_results WHERE run_id = ?', r.id);
    if (done) return done;
    const task = this.db.get<{ id: string; number: number; title: string; description: string; completed: number; completed_by: string | null; requires_approval: number; archived: number }>(
      'SELECT id, number, title, description, completed, completed_by, requires_approval, archived FROM tasks WHERE id = ? AND workspace_id = ?', r.task_id, ws);
    // card cancelado: o que a execução ainda devolver não vira entrega nem pedido na conversa
    if (!task || Number(task.archived) || (Number(task.completed) && task.completed_by === 'human')) return null;
    const kind = this.kindOf(ws, task.id);
    const text = control(output ?? '');
    const simulated = r.mode === 'simulated' || text.startsWith(SIMULATED);
    const ev: Record<string, unknown> = { runId: r.id, mode: r.mode, model: r.model, status, output: clip(text, 800), words: words(text) };
    const c: Criterion[] = [{ id: 'execucao', label: 'Execução terminou sem erro', ok: status === 'succeeded', detail: status === 'succeeded' ? undefined : (r.error ?? status) }];
    if (status !== 'succeeded') {
      // o motivo está na execução já encerrada (o registro recebido é de antes do fim)
      const err = this.db.get<{ error: string | null }>('SELECT error FROM runs WHERE id = ?', r.id)?.error ?? r.error;
      c[0].detail = err ?? status;
      return this.record(ws, task.id, r.id, kind, 'falha', c, ev, `A execução ${status === 'cancelled' ? 'foi cancelada' : 'falhou'}${err ? `: ${clip(err, 160)}` : ''}. Nada foi entregue; o card continua aberto.`, 'ergon');
    }
    const asked = /\[\[\s*perguntar\b/i.test(output ?? '');
    if (asked) ev.pergunta = questionIn(output);
    const help = !!this.db.get('SELECT 1 AS x FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', task.id);
    const review = this.db.get<{ status: string }>("SELECT status FROM reviews WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1", task.id, ws);
    const pendingReview = review?.status === 'open';

    if (kind === 'dados') {
      const op = this.db.get<OperationRow>('SELECT * FROM operations WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ws, task.id);
      ev.operationId = op?.id ?? null; ev.agentComment = simulated ? 'simulado (sem modelo de IA): não entra no resultado' : clip(text, 600);
      if (!op) {
        c.push({ id: 'operacao', label: 'Análise calculada pelo Ergon a partir do arquivo', ok: false, detail: 'nenhuma análise foi executada' });
        return this.record(ws, task.id, r.id, kind, 'reprovado', c, ev, 'A tarefa pede números calculados do arquivo, mas nenhuma análise do Ergon foi executada — texto do agente não substitui o cálculo.', 'ergon');
      }
      if (op.status === 'erro') {
        c.push({ id: 'operacao', label: 'Análise calculada pelo Ergon a partir do arquivo', ok: false, detail: op.error ?? 'erro' });
        return this.record(ws, task.id, r.id, kind, 'aguardando_info', c, ev, `O arquivo não pôde ser analisado: ${op.error}. Corrija a planilha, anexe de novo e ponha para trabalhar.`, 'ergon');
      }
      c.push({ id: 'operacao', label: 'Análise calculada pelo Ergon a partir do arquivo', ok: true, detail: (() => { try { const p = JSON.parse(op.params) as { referencia: string; versao: string }; return `${OPERATION_LABEL} · referência ${p.referencia.split('-').reverse().join('/')} · ${p.versao}`; } catch { return OPERATION_LABEL; } })() });
      this.setWorkState(ws, task.id, 'resultado', `${(JSON.parse(op.outputs) as string[]).length} entregáveis gerados`);
      this.setWorkState(ws, task.id, 'validacao');
      c.push(...this.ops.verify(ws, op));
      ev.deliverables = JSON.parse(op.outputs);
    } else {
      c.push({ id: 'modelo', label: 'Resposta de um modelo de IA (não simulada)', ok: !simulated, detail: simulated ? 'modo simulado: não conta como trabalho feito' : (r.model ?? undefined) });
      const n = words(text) + (plan?.words ?? 0);
      c.push({ id: 'conteudo', label: `Conteúdo com pelo menos ${MIN_WORDS[kind]} palavras`, ok: n >= MIN_WORDS[kind], detail: plan ? `${n} palavras, somando as etapas` : `${n} palavras` });
      c.push({ id: 'alegacao', label: 'Não é só uma declaração de "concluído"', ok: !CLAIM.test(text) && n > 3 });
      c.push({ id: 'pendencias', label: 'Sem pergunta ou pedido de ajuda pendente', ok: !asked && !help, detail: asked ? 'o agente fez uma pergunta' : help ? 'esperando um colega' : undefined });
      const base = c.every((x) => x.ok);
      if (kind === 'documental' && base) {
        this.setWorkState(ws, task.id, 'resultado', 'documento produzido');
        const art = this.saveDeliverable(ws, task.id, task.number, r.id, text, output ?? '');
        c.push({ id: 'entregavel', label: 'Documento salvo e ligado ao card', ok: !!art, detail: art?.filename });
        if (art) ev.deliverables = [art.id];
        this.setWorkState(ws, task.id, 'validacao');
      }
      if (kind === 'externo') {
        c.push({ id: 'confirmacao', label: 'Confirmação da fonte externa', ok: false, detail: 'o Ergon não executa nem confirma ações fora dele; isso fica com você' });
        if (base) {
          const art = this.saveDeliverable(ws, task.id, task.number, r.id, text, output ?? '', 'preparo');
          if (art) ev.deliverables = [art.id];
          return this.record(ws, task.id, r.id, kind, 'sem_confirmacao', c, ev, 'Ação externa: o agente preparou o que podia, mas só você confirma que foi feita (enviada, paga, publicada…). Confirme no card quando estiver feito.', 'ergon');
        }
      }
    }
    const failed = c.filter((x) => !x.ok && x.id !== 'confirmacao');
    if (failed.length) {
      if (asked) return this.record(ws, task.id, r.id, kind, 'aguardando_info', c, ev, 'O agente precisa de uma informação sua antes de entregar. Responda e ponha para trabalhar de novo.', 'ergon');
      return this.record(ws, task.id, r.id, kind, 'reprovado', c, ev, `Não concluída: ${failed.map((x) => x.label.toLowerCase() + (x.detail ? ` (${x.detail})` : '')).join('; ')}.`, 'ergon');
    }
    if (Number(task.requires_approval) || pendingReview) {
      return this.record(ws, task.id, r.id, kind, 'aguardando_aprovacao', c, ev,
        pendingReview ? 'Resultado validado, mas a revisão crítica ainda não terminou: aguardando o veredito ou a sua aprovação.' : 'Resultado validado; esta tarefa exige a sua aprovação para ser concluída.', 'ergon');
    }
    return this.record(ws, task.id, r.id, kind, 'validado', c, ev, `Concluída com evidência: ${c.length} critérios atendidos${ev.deliverables ? `, ${(ev.deliverables as string[]).length} entregável(is) no card` : ''}.`, 'ergon');
  }

  /** O texto do agente como documento entregue (Markdown), ligado ao card. Idempotente pela execução. */
  private saveDeliverable(ws: string, taskId: string, number: number, runId: string, text: string, raw: string, prefix = 'resultado') {
    const name = `${prefix}-T${number}-${runId.slice(4, 12)}.md`;
    const prev = taskFiles(this.db, ws, taskId).find((f) => f.filename === name);
    if (prev) return prev;
    const owner = this.db.get<{ user_id: string }>("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", ws)?.user_id;
    if (!owner) return null;
    const body = deliverableBody(raw) || text;
    try {
      const art = saveArtifact(this.db, this.bus, this.cfg.filesDir, this.cfg.maxUploadBytes, ws, owner,
        { filename: name, mime: 'text/markdown', data: Buffer.from(body, 'utf8'), source: { kind: 'operation', id: runId } }, this.cfg.storageQuota);
      linkFile(this.db, ws, taskId, art.id, 'entregavel');
      return art;
    } catch { return null; }
  }

  /**
   * Decisão humana sobre o card da equipe: aprovar e concluir, confirmar a ação externa, devolver com instrução ou
   * responder à pergunta do agente (a resposta volta para ele como a devolução, e o card volta à fila).
   */
  decide(workspaceId: string, actor: Actor & { type: 'user' }, taskId: string, decision: 'aprovar' | 'devolver' | 'responder', note: string | null): ResultRow {
    const t = getTask(this.db, workspaceId, taskId);
    if (Number(t.completed)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (this.db.get("SELECT 1 AS x FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user')", taskId)) throw new HttpError(409, 'busy', 'O agente ainda está trabalhando neste card: espere terminar.');
    const kind = this.kindOf(workspaceId, taskId);
    const prev = this.latest(workspaceId, taskId);
    if (decision === 'devolver' || decision === 'responder') {
      const answer = decision === 'responder';
      if (!note || note.trim().length < (answer ? 1 : 3)) throw new HttpError(400, 'note', answer ? 'Escreva a resposta (ela vai para o agente).' : 'Diga o que precisa mudar (a instrução vai para o agente).');
      return this.record(workspaceId, taskId, null, kind, 'devolvido', [], { previous: prev?.id ?? null, instrucao: clip(note.trim(), 1500), ...(answer ? { resposta: true } : {}) },
        `${answer ? 'Respondida por você' : 'Devolvida com instrução'}: ${clip(note.trim(), 300)}`, actor.id!);
    }
    const crit: Criterion[] = [{ id: 'humano', label: 'Conferido e aprovado por você', ok: true }];
    const just = kind === 'externo' && prev?.state === 'sem_confirmacao' ? 'Ação externa confirmada por você.' : 'Aprovada e concluída por você.';
    return this.record(workspaceId, taskId, null, kind, 'confirmado_humano', crit, { previous: prev?.id ?? null, nota: note ? clip(note, 600) : null },
      note ? `${just} ${clip(note, 300)}` : just, actor.id!);
  }

  /**
   * O trabalho não pode começar (arquivo ausente ou inválido, ninguém com a ferramenta): registra o motivo e o card
   * espera, sem chamada de modelo. Sem execução ligada: cada tentativa fica no histórico.
   */
  needInput(workspaceId: string, taskId: string, kind: ResultKind, justification: string, state: 'aguardando_info' | 'reprovado' = 'aguardando_info', opId: string | null = null, decidedBy = 'ergon'): ResultRow {
    const crit: Criterion[] = [{ id: 'entrada', label: kind === 'dados' ? 'Arquivo de dados válido e quem saiba analisá-lo' : 'Arquivo citado no pedido anexado ao card', ok: false, detail: clip(justification, 200) }];
    return this.record(workspaceId, taskId, null, kind, state, crit, { operationId: opId }, justification, decidedBy.startsWith('usr_') ? decidedBy : 'ergon');
  }

  /** A instrução da última devolução ainda não atendida (vai para a próxima execução do agente). */
  pendingInstruction(workspaceId: string, taskId: string): string | null {
    return this.pendingReturn(workspaceId, taskId)?.text ?? null;
  }

  /** A devolução ainda não atendida, dizendo se era a resposta a uma pergunta do agente. */
  pendingReturn(workspaceId: string, taskId: string): { text: string; answer: boolean } | null {
    const r = this.latest(workspaceId, taskId);
    const text = r?.state === 'devolvido' ? String(r.evidenceData.instrucao ?? '') : '';
    // num plano, a devolução vale para a etapa em que foi feita: depois que ela passou adiante, a próxima não a recebe
    if (text && this.db.get('SELECT 1 AS x FROM task_steps WHERE task_id = ? AND done_at > ? LIMIT 1', taskId, r!.decided_at ?? r!.created_at)) return null;
    return text ? { text, answer: r?.evidenceData.resposta === true } : null;
  }

  /**
   * Recuperação no boot: execução da fila que terminou sem decisão registrada (o servidor caiu entre o fim e a
   * avaliação) é avaliada agora, uma única vez.
   */
  reconcile(): number {
    const lost = this.db.all<RunRow>(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.idempotency_key LIKE 'queue-%' AND r.status IN ('succeeded', 'failed', 'cancelled') AND t.completed = 0 AND ws_open(r.workspace_id)
        AND NOT EXISTS (SELECT 1 FROM task_results x WHERE x.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.task_id = r.task_id AND n.created_at > r.created_at)
        AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.parent_task_id = r.task_id AND k.completed = 0 AND k.archived = 0)`);
    let n = 0;
    for (const r of lost) { if (this.evaluate(r, r.status, r.output)) n++; }
    return n;
  }
}

const OPERATION_LABEL = 'Análise de desempenho por responsável';
