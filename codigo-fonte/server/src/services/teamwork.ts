/**
 * Trabalho em equipe pelo quadro: os agentes se especializam (cada um com as suas ferramentas) e, quando
 * falta algo, pedem ajuda a quem tem — o pedido vira um card no quadro da equipe para esse colega, e o
 * repasse fica visível. O andamento automático (ligado por padrão; você pode desligar) faz os agentes pegarem as
 * tarefas de "A fazer", de cima para baixo, até o limite de trabalhos ao mesmo tempo (concurrency.ts); o resto
 * espera ali, na ordem que você der. Vale o mesmo limite diário de qualquer execução. Nada aqui chama modelo diretamente: só enfileira execuções no executor.
 *
 * Fim de execução não é fim de trabalho: quem decide se o card foi concluído é o contrato de resultado
 * (results.ts), com critérios por tipo de trabalho e evidência. Tarefa de dados com planilha anexada passa antes
 * pela análise determinística do Ergon (operations.ts): o agente recebe os números prontos e só comenta.
 *
 * O card que nasce de uma conversa leva o pedido do usuário até a entrega (purpose.ts): o plano do coordenador anda
 * etapa por etapa, cada uma com o seu agente, e no fim quem recebeu o pedido entrega na conversa.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id as newId, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting } from './sectors.ts';
import { instructionsFor, isCoordinator, type RunExecutor, type RunRow, type RunStatus } from './runs.ts';
import { createTask, defaultBoard, getTask, updateTask } from './tasks.ts';
import { activeTeam, coordinatorOf, type Member } from './team.ts';
import { filesBrief, referenceFrom, summaryText, taskFiles, type Operations } from './operations.ts';
import { classifyTask, type ResultRow, type Results } from './results.ts';
import { DELIVERY_KEY, Purpose, currentStep, parsePlan, purposeOf, questionIn, stepsOf, type StepRow } from './purpose.ts';
import { parseDue } from './due.ts';
import { workspaceTz } from './routine-proposals.ts';

export interface HelpRequest { agent: string; request: string }
/** uma rodada do ciclo de persistência (task.persist) e a decisão dela (task.persist_decision) */
interface PersistRound { round: number; kind: string; by: string; stuck: string; motivo: string; decision?: string; detail?: string }
/** quantos pedidos de ajuda numa resposta: o coordenador aciona a equipe inteira, os outros pedem a poucos colegas */
export const HELP_MAX = { agent: 3, coordinator: 12 };

/** [[pedir-ajuda agente="Hipátia" pedido="..."]] na resposta de um agente (até `max` por resposta). */
export function parseHelpRequests(text: string | null, max = HELP_MAX.agent): HelpRequest[] {
  const out: HelpRequest[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*pedir-ajuda\b([^\]]{0,1200})\]\]/gi)) {
    const agent = m[1].match(/agente\s*=\s*["“]([^"”]{1,60})["”]/i)?.[1]?.trim();
    const request = m[1].match(/pedido\s*=\s*["“]([^"”]{3,1000})["”]/i)?.[1]?.trim();
    if (agent && request) out.push({ agent, request });
    if (out.length >= max) break;
  }
  return out;
}

export interface ProcessRequest { op: string; file: string | null; referencia: string | null }

/** [[processar operacao="analise-desempenho" arquivo="tarefas.csv" referencia="2026-10-24"]] (no máximo 2 por resposta). */
export function parseProcessRequests(text: string | null): ProcessRequest[] {
  const out: ProcessRequest[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*processar\b([^\]]{0,600})\]\]/gi)) {
    const attr = (k: string) => m[1].match(new RegExp(`${k}\\s*=\\s*["“]([^"”]{1,200})["”]`, 'i'))?.[1]?.trim() ?? null;
    const op = attr('operacao');
    if (op) out.push({ op, file: attr('arquivo'), referencia: attr('referencia') });
    if (out.length >= 2) break;
  }
  return out;
}

/** Tira as linhas de controle ([[...]]) do texto mostrado ao usuário. */
export const stripControl = (s: string): string => s.replace(/\[\[\s*(processar|pedir-ajuda|pedir-permissao|liberar-ferramenta|mover|novo-agente|ferramenta|propor-rotina|sugerir-rotina|ajustar-rotina|reapresentar-rotina|configurar-rotina|perguntar|editar-agente|desativar-agente|reativar-agente|editar-setor|novo-setor|propor-tarefa|categoria|plano|etapa|apagar-card|cancelar-card|treinar|assumir)\b(?:[^\]]|\](?!\]))*\]\]\s*/gi, '').trim();
const words = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
/** etapa intermediária com menos que isto não passa adiante (vai para a conferência, com o motivo) */
const STEP_MIN_WORDS = 10;

const COLS = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluído' };
/** Ordem da fila em "A fazer": a posição que você deu (arrastando ou com Prioridade) ou a de chegada (número do card). */
export const QUEUE_ORDER = 'COALESCE(t.queue_pos, t.number), t.number';
export const MAX_ATTEMPTS = 2;
/**
 * Quem a fila automática pode pegar agora, sobre `tasks t` (com `columns c` e `agents a` ligados): em "A fazer",
 * aberto, com responsável ativo, criado na equipe (espelhado de outro aplicativo não entra), sem ajuda aberta, sem
 * execução ativa, com tentativas disponíveis desde a última devolução e no estado de quem ainda vai trabalhar.
 * O mesmo trecho decide o próximo card (next) e o que o Ambiente mostra como "pronto": a leitura não inventa fila.
 * Parâmetros: o quadro da equipe, o nome da coluna "A fazer" e o limite de tentativas.
 */
export const ELIGIBLE_SQL = `t.board_id = ? AND t.completed = 0 AND t.archived = 0 AND a.status = 'active'
          AND c.name = ? AND t.sync_origin IS NULL
          AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.parent_task_id = t.id AND k.completed = 0 AND k.archived = 0)
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
          AND (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.idempotency_key LIKE 'queue-%'
                 AND r.created_at > COALESCE((SELECT MAX(x.decided_at) FROM task_results x WHERE x.task_id = t.id AND x.state = 'devolvido'), '')) < ?
          AND COALESCE(t.work_state, 'solicitada') IN ('solicitada', 'processamento')`;
/** nome da coluna da fila (o mesmo que o agendador usa) */
export const TODO_COLUMN = 'A fazer';
/** O pedido fala de um arquivo que não veio junto: perguntar antes de gastar uma chamada de modelo. */
const MENTIONS_FILE = /(^|[^a-z])(planilh|csv|anexad|em anexo|esta tabela|este arquivo|neste arquivo|nesse arquivo|desse arquivo|deste arquivo)/;
const CLOSING: Record<string, string> = {
  dados: 'Os números acima foram calculados pelo sistema a partir do arquivo e já estão nos entregáveis do card. Escreva um comentário curto (até 150 palavras) para quem pediu: o que se destaca e o que merece atenção. Não recalcule, não estime e não invente números.',
  documental: 'Entregue o documento completo, pronto para usar, em Markdown: ele será salvo como entregável do card. Não diga apenas que terminou — o documento é a entrega.',
  externo: 'Você não executa ações fora do Ergon (enviar, pagar, publicar, agendar). Prepare tudo o que for preciso (rascunho, dados, passos) e diga exatamente o que a pessoa precisa fazer para concluir.',
  informativo: 'Responda com o resultado completo da tarefa, pronto para usar.',
};
/** etapa do meio de um plano: a entrega é para a próxima etapa, não para o usuário */
const STEP_CLOSING = 'Entregue o resultado completo da sua etapa, em texto, pronto para a próxima etapa usar. Não diga apenas que terminou.';
/**
 * Como a equipe trabalha (vai em toda etapa): até entregar, sem devolver à pessoa o problema da própria equipe. A pessoa
 * é leiga: sabe o que quer, não como resolver.
 */
const AUTONOMY = 'Trabalhe até entregar. O que as etapas anteriores e os colegas entregaram está acima, completo. Se faltar uma ferramenta ou um conhecimento que um colega tem, peça ajuda (veja suas instruções): o colega entra como uma etapa deste mesmo card e você continua depois, com a entrega dele. Se algo chegou incompleto ou inconsistente, resolva com a equipe — nunca pergunte à pessoa como resolver um problema do trabalho. A pessoa é leiga: pergunte a ela, numa linha [[perguntar pergunta="..."]], só uma decisão sobre o que ela quer, que só ela pode dar e sem a qual não dá para entregar (em linguagem simples, de preferência com opções). Dado que falta e não é essencial fica como [PREENCHER] na entrega, com a lista do que falta no fim.';
/** texto que cabe numa execução (o executor ainda limita pelo contexto configurado, config.ts) */
const TEXTO_MAX = 400_000;
/** do texto acima, quanto vai para o que as etapas anteriores entregaram */
const PLAN_BUDGET = 240_000;
/** a partir deste tamanho, a entrega de uma etapa também fica como arquivo do card */
const STEP_FILE_CHARS = 1500;
/** ciclo de persistência: rodadas por card em 24 h — 2 com a coordenação, 2 com o reforço; depois, a pessoa fica sabendo */
export const PERSIST_ROUNDS = 4;
export const PERSIST_KEY = 'triagem-';
/** etapas de ajuda que um card pode ganhar; além disso, o ciclo de persistência decide outra saída */
export const HELP_STEPS_MAX = 4;
/** modelos que a equipe trata como os mais fortes (pelo nome escolhido para o agente) */
const STRONG_MODEL = /opus|gpt-5(?![\w.-]*(mini|nano))|(^|[^a-z0-9])o3([^a-z0-9]|$)|gemini-[\d.]+-pro|grok-4|deepseek-r1|qwen3-max|405b|[^a-z]large/i;

/**
 * O reforço do ciclo de persistência: quem tem o modelo mais forte da equipe (pelo modelo escolhido para o agente);
 * sem indicação, Platão; por fim, a coordenação. Nunca quem acabou de travar.
 */
export function strongestOf(db: Db, workspaceId: string, team: Member[], except: string[]): Member | undefined {
  const pool = team.filter((m) => !except.includes(m.id));
  const models = new Map(db.all<{ id: string; model: string | null }>('SELECT id, model FROM agents WHERE workspace_id = ?', workspaceId).map((a) => [a.id, a.model ?? '']));
  return pool.find((m) => STRONG_MODEL.test(models.get(m.id) ?? '')) ?? pool.find((m) => m.char_key === 'platao' || fold(m.name) === 'platao')
    ?? coordinatorOf(pool) ?? pool[0];
}

/** [[treinar agente="Platão" competencia="..." pedido="..." links="https://..."]] na resposta da coordenação. */
export function parseTrainRequests(text: string | null): Array<{ agent: string; title: string; request: string; links: string[] }> {
  const out: Array<{ agent: string; title: string; request: string; links: string[] }> = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*treinar\b([\s\S]{0,8000}?)\]\]/gi)) {
    const attr = (k: string) => m[1].match(new RegExp(`${k}\\s*=\\s*["“]([^"”]*)["”]`, 'i'))?.[1]?.trim() ?? '';
    const agent = attr('agente'); const request = attr('pedido'); const title = attr('competencia');
    if (agent && (request || title)) out.push({ agent, title: clip(title, 120), request: request || title, links: attr('links').split(/[\s,;]+/).filter((l) => /^https?:\/\//i.test(l)) });
    if (out.length >= 3) break;
  }
  return out;
}

export class Teamwork {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor;
  private readonly results: Results; private readonly ops: Operations; private readonly filesDir: string;
  private timer: NodeJS.Timeout | null = null;
  /** o fio do pedido: conversa de origem, entrega e pedidos repassados (purpose.ts) */
  readonly purpose: Purpose;
  /** conversa livre de novo (o app entrega o que ficou pronto ou manda a próxima mensagem da fila) */
  onIdle: ((workspaceId: string, conversationId: string) => void) | null = null;

  constructor(db: Db, bus: Bus, executor: RunExecutor, results: Results, ops: Operations, filesDir: string) {
    this.db = db; this.bus = bus; this.executor = executor; this.results = results; this.ops = ops; this.filesDir = filesDir;
    this.purpose = new Purpose(db, bus, executor);
    executor.onFinish((r, status, output) => this.finished(r, status, output));
  }

  start(everyMs = 4000): void { if (!this.timer) { this.timer = setInterval(() => this.tick(), everyMs); this.timer.unref?.(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Andamento automático: ligado por padrão (as automações começam ligadas); só "0" — você desligou — para. */
  autorun(workspaceId: string): boolean { return getSetting(this.db, workspaceId, 'team.autorun') !== '0'; }

  private column(boardId: string, name: string): string | null {
    return this.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND name = ? ORDER BY position LIMIT 1', boardId, name)?.id ?? null;
  }

  /** Cria os cards de ajuda pedidos por um agente (o repasse fica no log de cada card). */
  createHelpCards(r: RunRow, requests: HelpRequest[]): Array<{ number: number; to: string }> {
    const ws = r.workspace_id;
    const from = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? 'Agente';
    const team = this.db.all<{ id: string; name: string; char_key: string | null; skey: string }>(
      "SELECT a.id, a.name, a.char_key, p.key AS skey FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ? AND a.status = 'active'", ws);
    const coordId = coordinatorOf(activeTeam(this.db, ws))?.id;
    const coord = team.find((a) => a.id === coordId);
    const parent = r.task_id ? this.db.get<{ number: number }>('SELECT number FROM tasks WHERE id = ?', r.task_id) : undefined;
    const made: Array<{ number: number; to: string }> = [];
    for (const h of requests) {
      const n = fold(h.agent);
      const helper = team.find((a) => fold(a.name) === n) ?? team.find((a) => fold(a.name).startsWith(n));
      const to = helper && helper.id !== r.agent_id ? helper : coord;
      if (!to || to.id === r.agent_id) continue;
      const t = createTask(this.db, null, ws, { type: 'agent', id: r.agent_id }, {
        title: clip(`Ajuda a ${from}: ${h.request}`, 90),
        description: `${h.request}\n\nPedido por ${from}${parent ? ` (tarefa #${parent.number})` : r.conversation_id ? ' numa conversa' : ''}.${to !== helper ? ` ${h.agent} não está ativo: a coordenação faz a triagem.` : ''}`,
        boardId: defaultBoard(this.db, ws).id, columnId: this.column(defaultBoard(this.db, ws).id, COLS.todo) ?? undefined,
        agentId: to.id, origin: 'chat',
      });
      if (r.task_id) this.db.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', r.task_id, t.id);
      // pedido feito na conversa: a resposta do colega volta para lá, e quem pediu entrega
      else if (r.kind === 'chat' && r.conversation_id) this.purpose.attach(ws, t.id, r);
      audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.handoff', targetType: 'task', targetId: t.id,
        evidence: { from, to: to.name, request: clip(h.request, 400), conversationId: r.conversation_id, parentTaskId: r.task_id }, result: `${from} pediu ajuda a ${to.name}` });
      made.push({ number: Number(t.number), to: to.name });
    }
    if (made.length) {
      if (r.conversation_id) {
        this.purpose.note(ws, r.conversation_id, `Sistema — ${from} pediu ajuda (${made.length}):\n${made.map((m) => `card #${m.number} para ${m.to}`).join('\n')}\nAs respostas voltam aqui e ${from} entrega.`);
      }
      this.bus.publish(ws, 'tasks.changed', {});
    }
    return made;
  }

  private finished(r: RunRow, status: RunStatus, output: string | null): void {
    if (r.idempotency_key.startsWith('training-')) return; // treinamento: quem cuida é o Treinar
    // card cancelado enquanto o agente trabalhava: nada continua (próxima etapa, pedido de ajuda, conferência, entrega)
    if (r.task_id && Number(this.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', r.task_id)?.archived)) return;
    // o ciclo de persistência decidiu como o card segue (responder, pôr um colega numa etapa, assumir ou perguntar)
    if (r.idempotency_key.startsWith(PERSIST_KEY)) { this.persisted(r, status, output); return; }
    const ws = r.workspace_id;
    const coord = isCoordinator(this.db.get<{ coordinator: number }>('SELECT coordinator FROM agents WHERE id = ?', r.agent_id) ?? { coordinator: 0 });
    const help = status === 'succeeded' ? parseHelpRequests(output, coord ? HELP_MAX.coordinator : HELP_MAX.agent) : [];
    const queue = r.idempotency_key.startsWith('queue-') && !!r.task_id;
    if (status === 'succeeded' && r.kind === 'chat' && r.conversation_id && !r.task_id) {
      // uma entrega, um card: o plano do coordenador ou, sem plano, os colegas pedidos viram as etapas de um card só
      // (antes, cada pedido de ajuda virava um card); quem recebeu o pedido entrega na conversa
      const plan = coord ? parsePlan(output) : null;
      if (plan) this.startPlan(r, plan);
      else if (help.length) {
        this.startPlan(r, { objective: clip((purposeOf(this.db, r) || help[0].request).replace(/\s+/g, ' ').trim(), 90), steps: help.map((h) => ({ agent: h.agent, task: h.request })) });
      }
    } else if (help.length && !queue) this.createHelpCards(r, help); // outros canais (rotina): como sempre
    if (r.idempotency_key.startsWith(DELIVERY_KEY) && status === 'succeeded') this.bus.publish(ws, 'tasks.changed', {});
    if (!queue || !r.task_id) return;
    // o agente pediu um processamento ao Ergon: executa (com as permissões conferidas) antes de avaliar
    if (status === 'succeeded') {
      for (const p of parseProcessRequests(output)) {
        try { this.ops.run(ws, { taskId: r.task_id, agentId: r.agent_id, op: p.op, file: p.file, referencia: p.referencia }); }
        catch (err) {
          audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'operation.refused', targetType: 'task', targetId: r.task_id,
            evidence: { op: p.op, file: p.file }, result: err instanceof Error ? err.message : 'recusado' });
        }
      }
    }
    if (status === 'succeeded' && help.length) {
      // pedido de ajuda dentro de um card: o colega vira uma etapa deste mesmo card, antes de quem pediu
      if (this.helpSteps(r, help)) return;
      // não cabe mais etapa de ajuda (ou é a ajuda pedida de volta a quem pediu): a equipe decide outra saída
      if (this.persist(r, { kind: 'ajuda', text: help.map((h) => `${h.agent}: ${h.request}`).join('\n') })) return;
    }
    // pergunta à pessoa: antes, a equipe confere se é mesmo uma decisão dela ou um problema que ela mesma resolve
    if (status === 'succeeded' && /\[\[\s*perguntar\b/i.test(output ?? '') && this.persist(r, { kind: 'pergunta', text: questionIn(output) ?? '' })) return;
    this.settle(r, status, output);
  }

  /**
   * O fim de uma execução de um card: a etapa do meio que entregou passa adiante; a última (ou a que parou) vai para a
   * conferência do card. O que não passou (ou falhou) volta para a equipe pelo ciclo de persistência antes de chegar à
   * pessoa.
   */
  private settle(r: RunRow, status: RunStatus, output: string | null): void {
    const ws = r.workspace_id;
    if (!r.task_id) return;
    const steps = stepsOf(this.db, r.task_id);
    if (steps.length && this.advance(r, status, output, steps)) return;
    // fim de execução não é fim de trabalho: o contrato de resultado decide, com evidência
    const res = this.results.evaluate(r, status, output, steps.length ? { words: this.planWords(steps) } : null);
    if (!res) return;
    if (steps.length) this.closeStep(r, steps, res, output);
    // não passou na conferência ou a execução falhou (não foi você que parou): a equipe tenta outra estratégia
    if ((res.state === 'reprovado' || (res.state === 'falha' && status === 'failed')) && this.persist(r, { kind: res.state, text: res.justification })) return;
    const ho =this.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.handoff' ORDER BY created_at LIMIT 1", r.task_id);
    const ev = ho ? JSON.parse(ho.evidence) as { from: string; to: string; conversationId: string | null; parentTaskId: string | null } : null;
    const me = this.db.get<{ number: number }>('SELECT number FROM tasks WHERE id = ?', r.task_id);
    if (ev?.parentTaskId) {
      // card de ajuda a outro card: o resultado (ou o motivo de não ter vindo) vai para o card de quem pediu
      if (res.state === 'validado') this.helpToParent(ws, r.agent_id, ev as { from: string; to: string; parentTaskId: string }, me?.number ?? null, clip(stripControl(output ?? ''), PLAN_BUDGET));
      else audit(this.db, null, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'task.help_not_done', targetType: 'task', targetId: ev.parentTaskId,
        evidence: { from: ev.to, card: me?.number ?? null, state: res.state }, result: `${ev.to} não respondeu ao pedido de ${ev.from} (${res.state})` });
    }
    // card de uma conversa: concluído, quem recebeu o pedido entrega; parado, o agente da conversa repassa o pedido lá
    if (res.state === 'validado') this.purpose.cardDone(ws, r.task_id, ev);
    else this.purpose.relay(ws, r.task_id, res, output, r.agent_id, ev);
  }

  /**
   * Pedido de ajuda dentro de um card (uma entrega, um card): cada colega pedido entra como uma etapa deste card, logo
   * antes da etapa de quem pediu, que volta depois com o que eles entregaram. Card sem plano ganha as etapas agora.
   * false: ninguém válido para ajudar, ajuda pedida de volta a quem pediu ou o card já tem etapas de ajuda demais (o
   * ciclo de persistência decide outra saída).
   */
  private helpSteps(r: RunRow, requests: HelpRequest[], note?: { by: string; text: string }): boolean {
    const ws = r.workspace_id; const taskId = r.task_id;
    if (!taskId) return false;
    const t = getTask(this.db, ws, taskId);
    const team = activeTeam(this.db, ws);
    const steps = stepsOf(this.db, taskId);
    const cur = currentStep(steps);
    const owner = cur?.agent_id ?? t.agent_id ?? r.agent_id;
    const ownerName = team.find((m) => m.id === owner)?.name ?? 'o responsável';
    // quem está esperando por esta etapa (a etapa seguinte): pedir ajuda de volta a ele é o pingue-pongue que trava
    const waiting = cur ? steps.find((s) => s.position > cur.position && s.status !== 'feita')?.agent_id : undefined;
    const used = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.help_step'", taskId)?.n ?? 0);
    const room = Math.max(0, HELP_STEPS_MAX - used);
    const helpers: Array<{ m: Member; request: string }> = [];
    for (const h of requests) {
      const n = fold(h.agent);
      const m = team.find((a) => fold(a.name) === n) ?? team.find((a) => fold(a.name).startsWith(n));
      if (!m || m.id === owner || m.id === waiting || helpers.some((x) => x.m.id === m.id)) continue;
      helpers.push({ m, request: h.request });
    }
    if (!helpers.length || helpers.length > room) return false;
    // a ajuda é para o responsável da etapa (também quando quem decidiu foi o ciclo de persistência)
    const asker = r.idempotency_key.startsWith(PERSIST_KEY) ? ownerName : team.find((m) => m.id === r.agent_id)?.name ?? ownerName;
    const at = cur?.position ?? 1;
    const ts = now();
    // a orientação de quem decidiu vai na etapa do responsável: ele a recebe quando voltar, depois dos colegas
    const ownerTitle = `${cur?.title ?? t.title}${note ? `\nOrientação de ${note.by}: ${note.text}` : ''}`;
    this.db.tx(() => {
      if (!steps.length) {
        // card sem plano: o trabalho do responsável vira a etapa que continua, depois dos colegas
        this.db.run('INSERT INTO task_steps (id, workspace_id, task_id, position, agent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newId('stp'), ws, taskId, 1, owner, this.db.seal(ws, ownerTitle), 'pendente', ts);
      } else if (cur && note) this.db.run('UPDATE task_steps SET title = ? WHERE id = ?', this.db.seal(ws, ownerTitle), cur.id);
      // abre espaço antes da etapa da vez (em dois passos: a posição é única por card)
      this.db.run('UPDATE task_steps SET position = position + 100000 WHERE task_id = ? AND position >= ?', taskId, at);
      this.db.run('UPDATE task_steps SET position = position - 100000 + ? WHERE task_id = ? AND position >= ?', helpers.length, taskId, 100000 + at);
      this.db.run("UPDATE task_steps SET status = 'pendente' WHERE task_id = ? AND position = ?", taskId, at + helpers.length);
      helpers.forEach((x, i) => this.db.run(
        'INSERT INTO task_steps (id, workspace_id, task_id, position, agent_id, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId('stp'), ws, taskId, at + i, x.m.id, this.db.seal(ws, `Ajuda a ${asker}: ${x.request}`), i === 0 ? 'em_andamento' : 'pendente', ts));
    });
    updateTask(this.db, null, ws, { type: 'system', id: 'ergon' }, taskId, { agentId: helpers[0].m.id });
    for (const [i, x] of helpers.entries()) {
      audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.help_step', targetType: 'task', targetId: taskId,
        evidence: { runId: r.id, from: asker, to: x.m.name, step: at + i, request: clip(x.request, 4000) },
        result: `${asker} pediu ajuda a ${x.m.name}: entra como etapa ${at + i} deste card${i === helpers.length - 1 ? `; depois ${ownerName} continua` : ''}` });
    }
    this.bus.publish(ws, 'tasks.changed', { id: taskId });
    try { this.work(ws, taskId, null); } catch { this.results.setWorkState(ws, taskId, 'solicitada', `etapa de ajuda de ${helpers[0].m.name}: esperando a vez`); }
    return true;
  }

  /** As rodadas do ciclo de persistência do card nas últimas 24 h, com a decisão de cada uma (quando já houve). */
  private persistRounds(taskId: string): PersistRound[] {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const rows = this.db.all<{ action: string; evidence: string }>(
      "SELECT action, evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action IN ('task.persist', 'task.persist_decision') AND created_at > ? ORDER BY created_at", taskId, since);
    const out: PersistRound[] = [];
    for (const r of rows) {
      let e: Record<string, unknown>; try { e = JSON.parse(r.evidence) as Record<string, unknown>; } catch { continue; }
      if (r.action === 'task.persist') out.push({ round: Number(e.round), kind: String(e.kind ?? ''), by: String(e.by ?? ''), stuck: String(e.stuck ?? ''), motivo: String(e.motivo ?? '') });
      else { const x = out.find((o) => o.round === Number(e.round)); if (x) { x.decision = String(e.decision ?? ''); x.detail = String(e.detail ?? ''); } }
    }
    return out;
  }

  /**
   * Ciclo de persistência: o que travou um card (pergunta sobre o trabalho, entrega reprovada na conferência, falha,
   * ajuda que não cabe mais) volta para a equipe resolver, em vez de virar problema da pessoa. Rodadas 1–2: a
   * coordenação decide; 3–4: o reforço (o modelo mais forte) monta uma estratégia nova com o histórico. Depois disso, ou
   * sem ninguém para decidir, false: segue o caminho de sempre e a pessoa fica sabendo.
   */
  private persist(r: RunRow, why: { kind: 'pergunta' | 'ajuda' | 'reprovado' | 'falha'; text: string }): boolean {
    const ws = r.workspace_id; const taskId = r.task_id;
    // sem modelo real (simulação), não há trabalho para a equipe refazer: segue o caminho de sempre
    if (!taskId || this.executor.mode !== 'real') return false;
    // ligado por padrão (as automações começam ligadas); só o desligado gravado por você para
    if (getSetting(this.db, ws, 'team.persist') === '0') return false;
    const rounds = this.persistRounds(taskId);
    if (rounds.length >= PERSIST_ROUNDS) return false;
    const team = activeTeam(this.db, ws);
    const coord = coordinatorOf(team);
    const reinforce = rounds.length >= 2 || coord?.id === r.agent_id;
    const who = reinforce ? strongestOf(this.db, ws, team, [r.agent_id]) : coord;
    if (!who || who.id === r.agent_id) return false;
    const stuck = team.find((m) => m.id === r.agent_id)?.name ?? 'o agente';
    const round = rounds.length + 1;
    const input = this.persistBrief(ws, taskId, { who, coord, stuck, why, round, rounds, reinforce });
    try {
      this.executor.enqueue({
        workspaceId: ws, agentId: who.id, taskId, kind: 'subtask', input: clip(input, TEXTO_MAX), maxInput: TEXTO_MAX,
        instructions: instructionsFor(this.db, ws, who.id, 'Canal: ciclo de persistência da equipe. Você decide como o card segue até a entrega, sem devolver à pessoa o problema da equipe.'),
        idempotencyKey: `${PERSIST_KEY}${r.id}`,
      });
    } catch { return false; } // limite diário, por exemplo: segue o caminho de sempre
    const label = { pergunta: 'quis perguntar à pessoa', ajuda: 'pediu uma ajuda que não cabe mais no card', reprovado: 'teve a entrega reprovada na conferência', falha: 'não conseguiu terminar (falha)' }[why.kind];
    this.results.setWorkState(ws, taskId, 'processamento', reinforce ? `${coord?.name ?? 'A coordenação'} chamou ${who.name} para uma nova estratégia` : `${who.name} está resolvendo com a equipe`);
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: who.id, action: 'task.persist', targetType: 'task', targetId: taskId,
      evidence: { runId: r.id, round, kind: why.kind, by: who.name, stuck, motivo: clip(why.text, 4000) },
      result: `Rodada ${round} de ${PERSIST_ROUNDS}: ${stuck} ${label}; ${reinforce ? `${who.name} entra como reforço para montar uma nova estratégia` : `${who.name} resolve com a equipe`}` });
    this.bus.publish(ws, 'tasks.changed', { id: taskId });
    return true;
  }

  /** O que quem decide recebe: o card inteiro, o que travou, as rodadas anteriores e as saídas possíveis. */
  private persistBrief(ws: string, taskId: string, c: { who: Member; coord: Member | undefined; stuck: string; why: { kind: string; text: string }; round: number;
    rounds: PersistRound[]; reinforce: boolean }): string {
    const t = getTask(this.db, ws, taskId);
    const purpose = this.db.get<{ purpose: string | null }>('SELECT purpose FROM tasks WHERE id = ?', taskId)?.purpose;
    const names = new Map(activeTeam(this.db, ws).map((m) => [m.id, m.name]));
    const steps = stepsOf(this.db, taskId);
    const each = steps.length ? Math.floor(PLAN_BUDGET / steps.length) : 0;
    const files = filesBrief(this.db, this.filesDir, ws, taskId);
    const what = { pergunta: `quis perguntar à pessoa: “${c.why.text}”`, ajuda: `pediu ajuda e o pedido não cabe mais neste card (já tem etapas de ajuda demais ou é a ajuda pedida de volta a quem pediu):\n${c.why.text}`,
      reprovado: `entregou, mas a conferência reprovou: ${c.why.text}`, falha: `não conseguiu terminar: ${c.why.text}` }[c.why.kind] ?? c.why.text;
    return [
      c.reinforce
        ? `Você é ${c.who.name}. ${c.coord && c.coord.id !== c.who.id ? `${c.coord.name}, que coordena a equipe, chamou você` : 'A equipe chamou você'} como reforço para montar uma estratégia NOVA para este card (rodada ${c.round} de ${PERSIST_ROUNDS}): as tentativas anteriores não resolveram.`
        : `Você coordena a equipe. Um card travou e você decide como ele segue até a entrega (rodada ${c.round} de ${PERSIST_ROUNDS}).`,
      '',
      `Card #${t.number}: ${t.title}`,
      purpose ? `Pedido do usuário (o objetivo): “${clip(purpose, 4000)}”` : clip(t.description, 4000),
      steps.length ? `\nEtapas do card:\n${steps.map((s) => `${s.position}. ${names.get(s.agent_id) ?? 'Agente'} — ${s.title} [${s.status}]${s.output ? `\n${clip(stripControl(s.output), each)}` : ''}`).join('\n\n')}` : '',
      files ? `\n${files}` : '',
      `\nO que travou: ${c.stuck} ${what}`,
      c.rounds.length ? `\nRodadas anteriores (não repita o que não funcionou):\n${c.rounds.map((x) => `- Rodada ${x.round}: ${x.stuck} (${x.kind}) → ${x.by} decidiu ${x.decision ?? '—'}${x.detail ? `: ${clip(x.detail, 1200)}` : ''}`).join('\n')}` : '',
      '',
      'Regras: o usuário quer a entrega pronta, e rápido. Ele é leigo: sabe o que quer, não como resolver. A equipe resolve sozinha — nunca devolva a ele um problema do trabalho (texto cortado, formato, ferramenta, quem faz o quê, como resolver). Dado que falta e não é essencial: a entrega sai com [PREENCHER] e a lista do que falta.',
      'Responda com UMA destas saídas:',
      `a) A instrução para ${c.stuck} seguir agora, completa (se ela precisar de um texto que já está acima, copie o texto inteiro na instrução). Só texto, sem linha de controle.`,
      `b) Uma linha [[pedir-ajuda agente="Nome" pedido="..."]] para pôr um colega (que não seja ${c.stuck}) a fazer o que falta antes de ${c.stuck} continuar — ele entra como uma etapa deste mesmo card —, seguida da instrução para ${c.stuck}.`,
      `c) A linha [[assumir]] e, abaixo dela, a entrega completa da etapa de ${c.stuck}, feita por você — quando for mais rápido você mesmo fazer.`,
      'd) Só se for indispensável — uma decisão sobre o que o usuário quer, que só ele pode dar e sem a qual não dá para entregar: [[perguntar pergunta="..."]], em linguagem simples, de preferência com opções.',
    ].filter(Boolean).join('\n');
  }

  /** A decisão do ciclo de persistência chegou: o card segue por ela. */
  private persisted(r: RunRow, status: RunStatus, output: string | null): void {
    const ws = r.workspace_id; const taskId = r.task_id;
    if (!taskId) return;
    const orig = this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', r.idempotency_key.slice(PERSIST_KEY.length));
    const round = this.persistRounds(taskId).at(-1)?.round ?? 0;
    const who = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? 'A coordenação';
    const text = output ?? '';
    const decide = (decision: string, detail: string, result: string) => audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id,
      action: 'task.persist_decision', targetType: 'task', targetId: taskId, evidence: { runId: r.id, round, decision, detail: clip(detail, 4000) }, result });
    if (status !== 'succeeded' || !text.trim()) {
      decide('sem decisão', status, `${who} não chegou a uma decisão (${status}): o card segue como estava`);
      // a decisão não veio: o que travou segue o caminho de sempre (a pessoa fica sabendo)
      if (orig && /\[\[\s*perguntar\b/i.test(orig.output ?? '')) this.settle(orig, 'succeeded', orig.output);
      else {
        this.results.restoreWorkState(ws, taskId);
        const res = this.results.latest(ws, taskId);
        if (res) this.purpose.relay(ws, taskId, res, orig?.output ?? null, orig?.agent_id ?? r.agent_id, null);
      }
      return;
    }
    const question = /\[\[\s*perguntar\b/i.test(text) ? questionIn(text) : null;
    if (question) {
      decide('perguntar à pessoa', question, `${who} concluiu que só a pessoa decide: “${clip(question, 200)}”`);
      this.settle(r, 'succeeded', `[[perguntar pergunta="${question.replace(/"/g, "'")}"]]`);
      return;
    }
    if (/\[\[\s*assumir\s*\]\]/i.test(text)) {
      const body = text.replace(/\[\[\s*assumir\s*\]\]/i, '').trim();
      decide('assumir', body, `${who} assumiu e fez a etapa`);
      this.settle(r, 'succeeded', body);
      return;
    }
    const help = parseHelpRequests(text, HELP_MAX.agent);
    const instruction = stripControl(text);
    if (help.length && this.helpSteps(r, help, instruction ? { by: who, text: instruction } : undefined)) {
      decide('pôr um colega numa etapa', `${help.map((h) => `${h.agent}: ${h.request}`).join('; ')}${instruction ? ` — ${instruction}` : ''}`, `${who} pôs ${help.map((h) => h.agent).join(', ')} numa etapa deste card`);
      return;
    }
    if (!instruction) { decide('sem decisão', text, `${who} não deu uma instrução utilizável: o card segue como estava`); this.results.restoreWorkState(ws, taskId); return; }
    decide('instruir', instruction, `${who} respondeu e o trabalho segue`);
    this.results.teamAnswer(ws, taskId, instruction, who);
    try { this.work(ws, taskId, null); } catch { this.results.setWorkState(ws, taskId, 'solicitada', `${who} respondeu: esperando a vez`); }
  }

  /** Começa o plano do coordenador: o card nasce com as etapas e a primeira já vai para o agente dela. */
  private startPlan(r: RunRow, plan: NonNullable<ReturnType<typeof parsePlan>>): void {
    const ws = r.workspace_id;
    const board = defaultBoard(this.db, ws).id;
    const made = this.purpose.createPlan(r, plan, (x) => createTask(this.db, null, ws, { type: 'agent', id: r.agent_id }, {
      title: x.title, description: x.description, boardId: board, columnId: this.column(board, COLS.todo) ?? undefined, agentId: x.agentId, origin: 'chat',
      dueOn: parseDue(x.purpose || x.title, workspaceTz(this.db, ws)), // "até sexta" no pedido: o card já nasce com o prazo
    }));
    if (!made) return;
    this.bus.publish(ws, 'tasks.changed', { id: made.taskId });
    try { this.work(ws, made.taskId, null); } catch { /* fica em "A fazer": a fila pega quando puder */ }
  }

  /** Palavras que as etapas já feitas entregaram (a conferência do card soma o plano inteiro). */
  private planWords(steps: StepRow[]): number {
    return steps.filter((s) => s.status === 'feita').reduce((n, s) => n + words(stripControl(s.output ?? '')), 0);
  }

  /**
   * Etapa do meio que entregou: guarda a entrega, passa o card ao agente da próxima etapa e já põe para trabalhar.
   * Pergunta ao usuário, pedido de ajuda, falha ou entrega curta demais não passam adiante (false: a conferência decide).
   */
  private advance(r: RunRow, status: RunStatus, output: string | null, steps: StepRow[]): boolean {
    const cur = currentStep(steps);
    if (!cur || status !== 'succeeded' || cur.position === steps[steps.length - 1].position) return false;
    if (/\[\[\s*perguntar\b/i.test(output ?? '') || words(stripControl(output ?? '')) < STEP_MIN_WORDS) return false;
    const next = steps.find((s) => s.position > cur.position && s.status !== 'feita');
    if (!next) return false;
    const ws = r.workspace_id; const taskId = r.task_id!;
    this.db.tx(() => {
      this.db.run("UPDATE task_steps SET status = 'feita', output = ?, run_id = ?, done_at = ? WHERE id = ?", this.db.seal(ws, clip(output ?? '', TEXTO_MAX)), r.id, now(), cur.id);
      this.db.run("UPDATE task_steps SET status = 'em_andamento' WHERE id = ?", next.id);
    });
    const name = (agentId: string) => this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? 'o agente';
    // entrega longa (um documento, uma pesquisa): fica também como arquivo do card — aberta inteira, por você e pela equipe
    const body = stripControl(output ?? '');
    if (body.length >= STEP_FILE_CHARS) {
      const n = Number(this.db.get<{ number: number }>('SELECT number FROM tasks WHERE id = ?', taskId)?.number ?? 0);
      this.results.saveDeliverable(ws, taskId, n, r.id, body, output ?? '', `etapa${cur.position}-${fold(name(cur.agent_id)).replace(/[^a-z0-9]+/g, '-')}`);
    }
    updateTask(this.db, null, ws, { type: 'system', id: 'ergon' }, taskId, { agentId: next.agent_id });
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: r.agent_id, action: 'task.step_done', targetType: 'task', targetId: taskId,
      evidence: { runId: r.id, step: cur.position, of: steps.length, output: clip(stripControl(output ?? ''), 1500) },
      result: `${name(r.agent_id)} entregou a etapa ${cur.position} de ${steps.length}; agora é com ${name(next.agent_id)}` });
    try { this.work(ws, taskId, null); }
    catch { this.results.setWorkState(ws, taskId, 'solicitada', `etapa ${next.position} de ${steps.length}: esperando a vez`); }
    return true;
  }

  /** Última etapa (ou a que parou) depois da conferência: guarda o que veio e marca a situação da etapa. */
  private closeStep(r: RunRow, steps: StepRow[], res: ResultRow, output: string | null): void {
    const cur = currentStep(steps);
    if (!cur) return;
    const done = ['validado', 'aguardando_aprovacao', 'sem_confirmacao'].includes(res.state);
    const status = done ? 'feita' : res.state === 'falha' ? 'falhou' : 'em_andamento';
    this.db.run('UPDATE task_steps SET status = ?, output = COALESCE(?, output), run_id = ?, done_at = ? WHERE id = ?',
      status, output ? this.db.seal(r.workspace_id, clip(output, TEXTO_MAX)) : null, r.id, done ? now() : null, cur.id);
  }

  /** A resposta do colega vai para o card de quem pediu, que volta à fila quando não espera mais nenhuma ajuda. */
  private helpToParent(ws: string, agentId: string, ev: { from: string; to: string; parentTaskId: string }, card: number | null, text: string): void {
    audit(this.db, null, { workspaceId: ws, actorType: 'agent', actorId: agentId, action: 'task.help_result', targetType: 'task', targetId: ev.parentTaskId,
      evidence: { from: ev.to, card, output: text }, result: `${ev.to} respondeu ao pedido de ${ev.from}` });
    const open = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', ev.parentTaskId);
    if (Number(open?.n)) return;
    this.results.setWorkState(ws, ev.parentTaskId, 'solicitada', 'a ajuda dos colegas chegou'); // volta à fila de quem pediu
    // card de uma conversa (o plano): segue na hora, sem esperar a fila
    if (this.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND conversation_id IS NOT NULL', ev.parentTaskId)) {
      try { this.work(ws, ev.parentTaskId, null); } catch { /* fica na fila */ }
    }
  }

  /**
   * Card aprovado por você (ele não se validou sozinho: esperava confirmação, aprovação ou foi reprovado). Card de
   * ajuda: o card de quem pediu volta à fila com a resposta — antes, aprovado à mão, ficava "em andamento" para sempre.
   * Card de uma conversa: quem recebeu o pedido entrega.
   */
  helpApproved(ws: string, taskId: string): void {
    const ho = this.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.handoff' ORDER BY created_at LIMIT 1", taskId);
    const ev = ho ? JSON.parse(ho.evidence) as { from: string; to: string; conversationId: string | null; parentTaskId: string | null } : null;
    const steps = stepsOf(this.db, taskId);
    const cur = currentStep(steps);
    if (cur) this.db.run("UPDATE task_steps SET status = 'feita', done_at = ? WHERE id = ?", now(), cur.id); // aprovado: o plano está entregue
    if (ev?.parentTaskId) {
      const last = this.db.get<{ agent_id: string; output: string | null }>("SELECT agent_id, output FROM runs WHERE task_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1", taskId);
      const me = this.db.get<{ number: number; agent_id: string }>('SELECT number, agent_id FROM tasks WHERE id = ?', taskId);
      this.helpToParent(ws, last?.agent_id ?? me?.agent_id ?? '', ev as { from: string; to: string; parentTaskId: string }, me?.number ?? null,
        clip(stripControl(last?.output ?? '') || 'aprovado por você, sem texto do colega', PLAN_BUDGET));
    }
    this.purpose.cardDone(ws, taskId, ev);
  }

  /**
   * A resposta do usuário a um card que espera por ele — na conversa, em "aguardando você" ou no próprio card:
   * responder à pergunta, aprovar, devolver com instrução, tentar de novo ou deixar como está. O que muda o trabalho já
   * o põe para andar, sem esperar a fila. A resposta escrita aparece na conversa de origem como do usuário.
   */
  respond(ws: string, userId: string, taskId: string, action: 'answer' | 'approve' | 'return' | 'retry' | 'dismiss', text: string | null): { result: string; runId: string | null } {
    const t = getTask(this.db, ws, taskId);
    const user = { type: 'user' as const, id: userId };
    if (action === 'dismiss') {
      this.purpose.closeRequests(ws, taskId, 'deixado como está', 'rejected');
      return { result: 'O card fica como está.', runId: null };
    }
    let result: string; let runId: string | null = null;
    if (action === 'approve') {
      result = this.results.decide(ws, user, taskId, 'aprovar', null).justification;
      this.helpApproved(ws, taskId);
    } else if (action === 'retry') {
      runId = this.work(ws, taskId, userId);
      result = runId ? 'Posto para trabalhar de novo.' : this.results.latest(ws, taskId)?.justification ?? 'Não deu para pôr para trabalhar agora.';
    } else {
      result = this.results.decide(ws, user, taskId, action === 'answer' ? 'responder' : 'devolver', text).justification;
      try { runId = this.work(ws, taskId, userId); } catch { /* ocupado ou esperando ajuda: a fila retoma */ }
    }
    this.purpose.closeRequests(ws, taskId, result);
    const conv = this.db.get<{ conversation_id: string | null }>('SELECT conversation_id FROM tasks WHERE id = ?', t.id)?.conversation_id;
    if (conv && text && (action === 'answer' || action === 'return')) this.purpose.userSaid(ws, conv, userId, text.trim());
    return { result, runId };
  }

  /**
   * Põe para trabalhar os próximos cards da fila de cada workspace com andamento automático ligado, até encher as vagas
   * de processo (o limite de trabalhos ao mesmo tempo). O resto espera em "A fazer", na ordem da fila.
   */
  tick(): void {
    const wss = this.db.all<{ workspace_id: string }>(
      "SELECT id AS workspace_id FROM workspaces WHERE ws_open(id) AND id NOT IN (SELECT workspace_id FROM workspace_settings WHERE key = 'team.autorun' AND value = '0')");
    for (const { workspace_id: ws } of wss) {
      try { for (let i = 0; i < 8 && this.next(ws); i++) { /* até 8 por passo; o próximo passo continua */ } }
      catch { /* limite diário, etc.: tenta no próximo passo */ }
    }
    this.sweep();
  }

  /**
   * Conversas com algo esperando que ela fique livre — a entrega de um pedido já pronto ou a próxima mensagem da fila
   * (Ctrl+Enter) — mesmo depois de um reinício ou de um limite diário que passou. Independe do andamento automático:
   * foi o usuário quem pediu.
   */
  private sweep(): void {
    if (!this.onIdle) return;
    const convs = this.db.all<{ ws: string; c: string }>(
      `SELECT DISTINCT m.workspace_id AS ws, m.conversation_id AS c FROM messages m WHERE m.queued = 1 AND ws_open(m.workspace_id)
       UNION SELECT DISTINCT t.workspace_id, t.conversation_id FROM tasks t
        WHERE t.conversation_id IS NOT NULL AND t.origin_run_id IS NOT NULL AND t.completed = 1 AND t.archived = 0 AND ws_open(t.workspace_id)
          AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.idempotency_key = '${DELIVERY_KEY}' || t.origin_run_id) LIMIT 50`);
    for (const x of convs) {
      if (this.purpose.busy(x.c)) continue;
      try { this.onIdle(x.ws, x.c); } catch { /* tenta no próximo passo */ }
    }
  }

  next(workspaceId: string): string | null {
    if (!this.autorun(workspaceId)) return null; // desligado: nada anda sozinho
    if (this.executor.processRoom(workspaceId) <= 0) return null; // sem vaga: o card espera em "A fazer"
    const board = defaultBoard(this.db, workspaceId).id;
    const t = this.db.get<{ id: string; number: number; title: string; description: string; agent_id: string; attempts: number }>(
      `SELECT t.id, t.number, t.title, t.description, t.agent_id,
              (SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.idempotency_key LIKE 'queue-%') AS attempts
         FROM tasks t JOIN columns c ON c.id = t.column_id JOIN agents a ON a.id = t.agent_id
        WHERE t.workspace_id = ? AND ${ELIGIBLE_SQL}
        ORDER BY ${QUEUE_ORDER} LIMIT 1`,
      workspaceId, board, COLS.todo, MAX_ATTEMPTS);
    if (!t) return null;
    return this.work(workspaceId, t.id, null);
  }

  /**
   * Põe um card da equipe para trabalhar: pela fila (andamento automático) ou pelo botão "Pôr para trabalhar" (você,
   * mesmo com o andamento automático desligado). Tarefa de dados: o Ergon roda a análise antes; arquivo ausente ou
   * inválido para aqui, sem gastar chamada de modelo. Devolve a execução criada (null = nada a executar agora).
   */
  work(workspaceId: string, taskId: string, userId: string | null): string | null {
    const task = getTask(this.db, workspaceId, taskId);
    const board = this.db.get<{ audience: string }>('SELECT audience FROM boards WHERE id = ?', task.board_id);
    if (board?.audience !== 'team') throw new HttpError(409, 'not_team', 'Só cards do quadro da equipe vão para a fila dos agentes.');
    if (Number(task.completed) || Number(task.archived)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (this.db.get("SELECT 1 AS x FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user')", taskId)) throw new HttpError(409, 'busy', 'O agente já está trabalhando neste card.');
    if (this.db.get('SELECT 1 AS x FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', taskId)) throw new HttpError(409, 'waiting_help', 'Este card espera a ajuda de um colega (veja os cards ligados).');
    const agent = task.agent_id ? this.db.get<{ id: string; name: string; status: string; tools: string | null }>('SELECT id, name, status, tools FROM agents WHERE id = ?', task.agent_id) : undefined;
    if (!agent || agent.status !== 'active') throw new HttpError(409, 'no_agent', 'Este card não tem um responsável ativo.');
    let agentId = agent.id;
    const actor = userId ? { type: 'user' as const, id: userId } : { type: 'system' as const, id: 'ergon' };
    const text = `${task.title} ${task.description}`;
    const csv = this.ops.csvInput(workspaceId, taskId);
    const kind = classifyTask(text, !!csv);
    // pedido que fala de planilha/arquivo, sem arquivo nenhum: pergunta antes de gastar o modelo. Qualquer anexo conta —
    // antes só o CSV contava, e "revisar a proposta anexada" com um PDF ou Word anexado parava aqui
    const anyFile = taskFiles(this.db, workspaceId, taskId).some((f) => f.role === 'entrada');
    if (!anyFile && MENTIONS_FILE.test(fold(text)) && !this.results.pendingInstruction(workspaceId, taskId)) {
      const res = this.results.needInput(workspaceId, taskId, kind, 'O pedido fala de uma planilha ou arquivo, mas nada foi anexado ao card. Anexe o arquivo no card e ponha para trabalhar.', 'aguardando_info', null, actor.id);
      this.purpose.relay(workspaceId, taskId, res, null, agentId); // card de uma conversa: o pedido do arquivo aparece lá
      return null;
    }
    let opNote = '';
    if (kind === 'dados') {
      // a análise é de quem tem a ferramenta: se o responsável não tem, o Ergon passa a quem tem
      const tools = (() => { try { return JSON.parse(agent.tools ?? '[]') as string[]; } catch { return []; } })();
      if (!tools.includes('dados')) {
        const team = activeTeam(this.db, workspaceId);
        const holder = team.find((m) => m.tools.includes('dados') && !m.coordinator) ?? team.find((m) => m.tools.includes('dados'));
        if (!holder) {
          this.results.needInput(workspaceId, taskId, kind, 'Ninguém na equipe tem a ferramenta "Análise de dados". Dê a ferramenta a um agente (Equipe → editar agente) e ponha para trabalhar.', 'reprovado', null, actor.id);
          return null;
        }
        updateTask(this.db, null, workspaceId, { type: 'system', id: 'ergon' }, taskId, { agentId: holder.id });
        audit(this.db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'task.reassign', targetType: 'task', targetId: taskId,
          evidence: { from: agent.name, to: holder.name, reason: 'dados' }, result: `${holder.name} assume: tem a ferramenta Análise de dados` });
        agentId = holder.id;
      }
      this.results.setWorkState(workspaceId, taskId, 'processamento', 'o sistema está analisando o arquivo');
      const op = this.ops.run(workspaceId, { taskId, agentId, op: 'analise-desempenho', referencia: referenceFrom(text) });
      if (op.status === 'erro') {
        this.results.needInput(workspaceId, taskId, kind, `O arquivo não pôde ser analisado: ${op.error} Corrija a planilha, anexe de novo e ponha para trabalhar.`, 'aguardando_info', op.id, actor.id);
        return null;
      }
      opNote = `\nResultado da análise feita pelo sistema (números já calculados):\n${summaryText(op.result ? JSON.parse(op.result) as Record<string, unknown> : null)}\nEntregáveis já gerados e ligados ao card: relatório (Markdown) e indicadores (CSV).`;
    }
    return this.enqueue(workspaceId, { id: task.id, number: Number(task.number), title: task.title, description: task.description }, agentId, kind, opNote, actor);
  }

  /** Cards esperando a vez em "A fazer" (sem execução ativa), na ordem da fila. */
  queue(workspaceId: string): Array<{ id: string; k: number; priority: number }> {
    const board = defaultBoard(this.db, workspaceId).id;
    return this.db.all<{ id: string; k: number; priority: number }>(
      `SELECT t.id, COALESCE(t.queue_pos, t.number) AS k, t.priority FROM tasks t JOIN columns c ON c.id = t.column_id
        WHERE t.workspace_id = ? AND t.board_id = ? AND c.name = ? AND t.completed = 0 AND t.archived = 0
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
        ORDER BY ${QUEUE_ORDER}`, workspaceId, board, COLS.todo);
  }

  /** Onde o card está na fila (null = não está esperando em "A fazer"). */
  queueInfo(workspaceId: string, taskId: string): { position: number; total: number } | null {
    const q = this.queue(workspaceId);
    const i = q.findIndex((x) => x.id === taskId);
    return i < 0 ? null : { position: i + 1, total: q.length };
  }

  /**
   * Você ordena a fila: "Prioridade" marca o card e o leva ao topo (tirar a marca não o move); arrastar o põe antes
   * de outro card (before) ou no fim (before: null); subir e descer trocam com o vizinho (o mesmo, sem arrastar).
   * Os agentes pegam de cima para baixo.
   */
  arrange(workspaceId: string, taskId: string, userId: string, input: { priority?: boolean; before?: string | null; move?: 'up' | 'down' }): { priority: boolean; position: number | null } {
    const task = getTask(this.db, workspaceId, taskId);
    if (task.board_id !== defaultBoard(this.db, workspaceId).id) throw new HttpError(409, 'not_team', 'Só os cards do quadro da equipe têm fila.');
    if (Number(task.completed)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (input.move) {
      const all = this.queue(workspaceId);
      const i = all.findIndex((q) => q.id === taskId);
      if (i < 0) throw new HttpError(409, 'not_queued', 'Este card não está esperando em "A fazer".');
      const before = input.move === 'up' ? (i > 0 ? all[i - 1].id : undefined) : i < all.length - 1 ? all[i + 2]?.id ?? null : undefined;
      input = { priority: input.priority, before }; // undefined: já está na ponta, nada muda
    }
    const rest = this.queue(workspaceId).filter((q) => q.id !== taskId);
    let pos: number | undefined;
    if (input.priority) pos = rest.length ? rest[0].k - 1 : Number(task.number);
    else if (input.before === null) pos = rest.length ? rest[rest.length - 1].k + 1 : Number(task.number);
    else if (input.before) {
      const i = rest.findIndex((q) => q.id === input.before);
      if (i < 0) throw new HttpError(409, 'not_queued', 'O outro card não está esperando em "A fazer".');
      pos = i === 0 ? rest[0].k - 1 : (rest[i - 1].k + rest[i].k) / 2;
    }
    const priority = input.priority ?? Boolean(Number(task.priority));
    this.db.run('UPDATE tasks SET priority = ?, queue_pos = COALESCE(?, queue_pos), updated_at = ? WHERE id = ?', priority ? 1 : 0, pos ?? null, now(), taskId);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'task.queue', targetType: 'task', targetId: taskId,
      evidence: { priority, moved: pos !== undefined }, result: input.priority ? 'prioridade: topo da fila' : input.priority === false ? 'sem prioridade' : 'ordem da fila mudada' });
    this.bus.publish(workspaceId, 'tasks.changed', { id: taskId });
    const at = this.queue(workspaceId).findIndex((q) => q.id === taskId);
    return { priority, position: at < 0 ? null : at + 1 };
  }

  private enqueue(workspaceId: string, t: { id: string; number: number; title: string; description: string }, agentId: string, kind: string, opNote: string,
    actor: { type: 'user' | 'system'; id: string }): string {
    const attempts = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)?.n ?? 0);
    const results = this.db.all<{ evidence: string }>("SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.help_result' ORDER BY created_at", t.id)
      .map((e) => { try { const v = JSON.parse(e.evidence) as { from: string; output: string }; return `${v.from}: ${v.output}`; } catch { return ''; } }).filter(Boolean);
    const back = this.results.pendingReturn(workspaceId, t.id);
    const files = filesBrief(this.db, this.filesDir, workspaceId, t.id);
    const plan = this.planBrief(workspaceId, t.id);
    const closing = plan && !plan.last ? STEP_CLOSING : CLOSING[kind] ?? CLOSING.informativo;
    const input = [
      `Tarefa #${t.number}: ${t.title}`, plan ? plan.text : t.description,
      files ? `\n${files}` : '',
      results.length ? `\nAjuda que você recebeu dos colegas:\n${results.join('\n\n')}` : '',
      back ? (back.team ? `\n${back.team}, da equipe, respondeu ao que travou — siga isto: ${back.text}`
        : back.answer ? `\nA pessoa respondeu à sua pergunta: ${back.text}` : `\nA pessoa devolveu o trabalho com esta instrução (atenda antes de entregar): ${back.text}`) : '',
      opNote,
      `\n${closing} ${AUTONOMY}`,
    ].filter(Boolean).join('\n');
    const run = this.executor.enqueue({
      workspaceId, agentId, taskId: t.id, kind: 'subtask', input: clip(input, TEXTO_MAX), maxInput: TEXTO_MAX,
      instructions: instructionsFor(this.db, workspaceId, agentId, 'Canal: quadro da equipe. Responda com o resultado da tarefa.'),
      idempotencyKey: `queue-${t.id}-${attempts + 1}`,
    });
    if (plan) this.db.run("UPDATE task_steps SET status = 'em_andamento', run_id = ? WHERE id = ?", run.id, plan.stepId);
    this.results.setWorkState(workspaceId, t.id, 'processamento', actor.type === 'user' ? 'posta para trabalhar por você' : 'pegou da fila');
    audit(this.db, this.bus, { workspaceId, actorType: actor.type, actorId: actor.id, action: 'task.queue_start', targetType: 'task', targetId: t.id, evidence: { runId: run.id, kind },
      result: actor.type === 'user' ? 'posta para trabalhar (botão)' : 'pegou da fila (andamento automático)' });
    return run.id;
  }

  /**
   * Card com plano: o que a etapa da vez recebe — o pedido do usuário, o plano inteiro (com a sua etapa marcada) e o
   * que as etapas anteriores entregaram. null = card sem etapas.
   */
  private planBrief(workspaceId: string, taskId: string): { text: string; stepId: string; last: boolean } | null {
    const steps = stepsOf(this.db, taskId);
    const cur = currentStep(steps);
    if (!cur) return null;
    const names = new Map(activeTeam(this.db, workspaceId).map((m) => [m.id, m.name]));
    const name = (id: string) => names.get(id) ?? this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', id)?.name ?? 'Agente';
    const purpose = this.db.get<{ purpose: string | null }>('SELECT purpose FROM tasks WHERE id = ?', taskId)?.purpose;
    const done = steps.filter((s) => s.status === 'feita' && s.output);
    const each = done.length ? Math.floor(PLAN_BUDGET / done.length) : 0;
    const last = cur.position === steps[steps.length - 1].position;
    const text = [
      purpose ? `Pedido do usuário (o objetivo de todo o plano): “${clip(purpose, 8000)}”` : '',
      `Plano deste card, em ${steps.length} etapa(s):`,
      ...steps.map((s) => `${s.position}. ${name(s.agent_id)} — ${s.title}${s.id === cur.id ? '   ← a sua etapa' : s.status === 'feita' ? ' (feita)' : ''}`),
      done.length ? `\nO que as etapas anteriores entregaram:\n${done.map((s) => `[${s.position}. ${name(s.agent_id)}]\n${clip(stripControl(s.output ?? ''), each)}`).join('\n\n')}` : '',
      `\nSua etapa (${cur.position} de ${steps.length}): ${cur.title}. Faça só a sua etapa${last ? '; ela é a última antes da entrega ao usuário, que a coordenação faz na conversa.' : ' e entregue o resultado completo dela: a próxima etapa continua a partir do que você entregar.'}`,
    ].filter(Boolean).join('\n');
    return { text, stepId: cur.id, last };
  }
}
