/**
 * Trabalho contínuo: o que os comandos /goal, /loop, /heartbeat, /btw e /review do motor fazem nas outras portas (terminal,
 * aplicativo dele, canais) e que não passa pela API. Aqui a pessoa tem o equivalente numa conversa ou num card:
 *
 *  - Meta com juiz (/meta, /goal): o trabalho só termina quando o critério for cumprido. A cada resposta do agente, o juiz
 *    do PRÓPRIO motor (hermes_cli/goals.py, judge_goal, pela ponte de controle) diz se cumpriu; se não, o agente recebe o
 *    texto de continuação do motor e segue, até cumprir, travar ou acabarem as rodadas. Custa: uma chamada do juiz e uma
 *    nova rodada do agente a cada volta.
 *  - Repetir até cumprir (/repetir, /loop): o mesmo pedido volta ao agente a cada intervalo, até o critério (se houver) ser
 *    cumprido, as rodadas acabarem ou você parar.
 *  - Checagem periódica (/checagem, /heartbeat): um pedido que volta a cada intervalo enquanto o trabalho está parado.
 *  - Comentar sem interromper (/comentar, /btw): o comentário entra no trabalho em andamento sem pará-lo (steer do motor).
 *  - Revisão independente (/revisao, /review): um colega que não fez o trabalho revisa numa sessão separada, com o pedido
 *    de revisão do próprio motor (agent/review_engine.py, build_review_task), e o parecer volta para a conversa ou o card.
 *
 * /loop e /heartbeat do motor dependem de quem conduz a sessão (o terminal ou o canal); na API não há quem conduza, então o
 * relógio é o do Ergon (alternativa da decisão 2). Os nomes originais dos comandos valem em qualquer idioma.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import type { HermesClient, HermesControlClient, VereditoMeta } from './hermes.ts';
import type { RunExecutor, RunRow, RunStatus } from './runs.ts';

export type TipoComando = 'meta' | 'repetir' | 'checagem' | 'comentar' | 'revisao';
export type Alvo = { conversationId: string; taskId?: undefined } | { taskId: string; conversationId?: undefined };
export interface ComandoRow {
  id: string; workspace_id: string; user_id: string; conversation_id: string | null; task_id: string | null;
  kind: 'meta' | 'repetir' | 'checagem' | 'revisao'; texto: string; criterio: string | null; intervalo_s: number | null; max_rodadas: number; rodadas: number;
  status: 'ativo' | 'cumprido' | 'esgotado' | 'bloqueado' | 'parado'; nota: string | null; proxima_em: string | null; run_id: string | null; created_at: string; updated_at: string;
}

/** Os nomes de cada comando: os do Ergon em português e em inglês, e os originais do motor. */
const NOMES: Record<TipoComando, string[]> = {
  meta: ['meta', 'goal', 'objetivo'],
  repetir: ['repetir', 'loop', 'repeat', 'repita'],
  checagem: ['checagem', 'heartbeat', 'hb', 'check', 'checar', 'conferir'],
  comentar: ['comentar', 'btw', 'comment', 'comentario', 'steer'],
  revisao: ['revisao', 'review', 'revisar', 'revise'],
};
const PARAR = ['parar', 'stop', 'pare', 'cancelar', 'cancel', 'clear', 'off'];
export const INTERVALO_MIN_S = 60;
export const INTERVALO_MAX_S = 7 * 86400;
export const INTERVALO_PADRAO_S = 30 * 60;
// meta: 20, o mesmo do motor (goals.max_turns); repetir e checagem são o freio de um laço que a pessoa iniciou
export const RODADAS_PADRAO: Record<'meta' | 'repetir' | 'checagem', number> = { meta: 20, repetir: 12, checagem: 24 };
export const RODADAS_MAX = 50;
export const KEY_REVISAO = 'comando-revisao-';
const KEY_RODADA = 'cmd';

/** "5m", "2h", "90s", "1d", "30 min", "a cada 2 horas", "every 10 minutes" → segundos (null = não é um intervalo). */
export function parseIntervalo(s: string): number | null {
  const m = /^(\d{1,5})\s*(s|seg|segundos?|seconds?|secs?|m|min|mins?|minutos?|minutes?|h|hr|hrs?|horas?|hours?|d|dias?|days?)$/i.exec(fold(s.trim()));
  if (!m) return null;
  const u = m[2][0];
  const mult = u === 's' ? 1 : u === 'm' ? 60 : u === 'h' ? 3600 : 86400;
  return Number(m[1]) * mult;
}

export interface ComandoLido { tipo: TipoComando; texto: string; intervaloS: number | null; criterio: string | null; parar: boolean }
/**
 * Um atalho digitado na conversa: "/meta entregar o relatório com três seções", "/repetir 30m confira a caixa de entrada
 * até: chegar a resposta do cliente", "/heartbeat every 2h veja se o site está no ar", "/btw use o tom formal",
 * "/review confira os números", "/meta parar". null = não é um comando (a mensagem segue normal).
 */
export function parseComando(text: string): ComandoLido | null {
  const m = /^\/([\p{L}]{2,12})(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!m) return null;
  const nome = fold(m[1]);
  const tipo = (Object.keys(NOMES) as TipoComando[]).find((t) => NOMES[t].includes(nome));
  if (!tipo) return null;
  let resto = (m[2] ?? '').trim();
  if (PARAR.includes(fold(resto))) return { tipo, texto: '', intervaloS: null, criterio: null, parar: true };
  let intervaloS: number | null = null;
  let criterio: string | null = null;
  if (tipo === 'repetir' || tipo === 'checagem') {
    const i = /^(?:(?:a cada|cada|every)\s+)?(\d{1,5}\s*[\p{L}]{1,8})\s+([\s\S]+)$/iu.exec(resto);
    const seg = i ? parseIntervalo(i[1]) : null;
    if (i && seg) { intervaloS = seg; resto = i[2].trim(); }
  }
  if (tipo === 'repetir') {
    const c = /^([\s\S]*?)\s+(?:até|ate|until)\s*:\s*([\s\S]+)$/iu.exec(resto);
    if (c) { resto = c[1].trim(); criterio = c[2].trim(); }
  }
  return { tipo, texto: resto, intervaloS, criterio, parar: false };
}

type Lingua = 'pt' | 'en';
const TX = {
  metaInicio: { pt: (m: string) => `Trabalhe até cumprir esta meta: ${m}`, en: (m: string) => `Work until this goal is met: ${m}` },
  metaSegue: { pt: (m: string, por: string) => `Ainda não cumpriu a meta (${por}). Continue: ${m}`, en: (m: string, por: string) => `The goal is not met yet (${por}). Keep going: ${m}` },
  revisaoDe: { pt: (quem: string) => `Revisão independente, por ${quem}:`, en: (quem: string) => `Independent review, by ${quem}:` },
  revisaoFalhou: { pt: () => 'A revisão independente não terminou. Você pode pedir de novo.', en: () => 'The independent review did not finish. You can ask again.' },
  comentario: { pt: (t: string) => `Comentário entregue sem interromper: ${t}`, en: (t: string) => `Comment delivered without interrupting: ${t}` },
} as const;

export interface ComandosDeps {
  /** envia um texto à conversa como a pessoa (uma nova rodada do agente); nota: instrução extra só para o agente */
  enviar: (ws: string, userId: string, conversationId: string, texto: string, chave: string, nota: string | null) => { runId: string | null };
  /** devolve o card à equipe com uma instrução (nova rodada no mesmo card) */
  devolver: (ws: string, userId: string, taskId: string, texto: string) => { runId: string | null };
  control: (ws: string) => HermesControlClient | null;
  hermes: (ws: string) => HermesClient | null;
}

export class Comandos {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly executor: RunExecutor;
  private readonly d: ComandosDeps;
  /** só para testes: o juiz (no lugar do juiz do motor) e o relógio */
  juiz: ((ws: string, meta: string, resposta: string) => Promise<VereditoMeta>) | null = null;
  private agora: () => number = () => Date.now();
  private julgando = new Set<string>();

  constructor(db: Db, bus: Bus, executor: RunExecutor, deps: ComandosDeps) {
    this.db = db; this.bus = bus; this.executor = executor; this.d = deps;
    executor.onFinish((r, status, output) => { void this.execucaoTerminou(r, status, output).catch(() => undefined); });
  }
  setClock(fn: (() => number) | null): void { this.agora = fn ?? (() => Date.now()); }

  private lingua(userId: string): Lingua { return this.db.get<{ lang: string | null }>('SELECT lang FROM users WHERE id = ?', userId)?.lang === 'en' ? 'en' : 'pt'; }
  private onde(alvo: Alvo): { sql: string; arg: string } { return alvo.conversationId ? { sql: 'conversation_id = ?', arg: alvo.conversationId } : { sql: 'task_id = ?', arg: alvo.taskId! }; }
  private conferirAlvo(ws: string, userId: string, alvo: Alvo): void {
    if (alvo.conversationId) {
      if (!this.db.get('SELECT 1 AS x FROM conversations WHERE id = ? AND workspace_id = ? AND owner_user_id = ?', alvo.conversationId, ws, userId)) throw notFound('conversa');
    } else if (!this.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND workspace_id = ? AND archived = 0', alvo.taskId!, ws)) throw notFound('card');
  }
  private avisar(c: Pick<ComandoRow, 'workspace_id' | 'conversation_id' | 'task_id'>): void {
    this.bus.publish(c.workspace_id, 'comandos.changed', { conversationId: c.conversation_id, taskId: c.task_id });
  }
  private mudar(cmdId: string, campos: Partial<Pick<ComandoRow, 'status' | 'nota' | 'rodadas' | 'proxima_em' | 'run_id'>>, ws: string): void {
    const sets: string[] = ['updated_at = ?']; const args: Array<string | number | null> = [now()];
    for (const [k, v] of Object.entries(campos)) { sets.push(`${k} = ?`); args.push(k === 'nota' && typeof v === 'string' ? this.db.seal(ws, clip(v, 20_000)) : (v as string | number | null)); }
    this.db.run(`UPDATE comandos SET ${sets.join(', ')} WHERE id = ?`, ...args, cmdId);
  }
  private nota(ws: string, conversationId: string, texto: string): void {
    this.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'system', ?, 'local', ?)",
      id('msg'), ws, conversationId, this.db.seal(ws, clip(texto, 100_000)), now());
    this.bus.publish(ws, 'messages.changed', { conversationId });
  }

  /** O que está ligado (e o que terminou há pouco) nesta conversa ou neste card: a tela mostra com o botão de parar. */
  listar(ws: string, alvo: Alvo): Array<Omit<ComandoRow, 'workspace_id' | 'user_id'>> {
    const o = this.onde(alvo);
    return this.db.all<ComandoRow>(`SELECT * FROM comandos WHERE workspace_id = ? AND ${o.sql} ORDER BY (status = 'ativo') DESC, updated_at DESC LIMIT 12`, ws, o.arg)
      .map(({ workspace_id: _w, user_id: _u, ...c }) => c);
  }

  parar(ws: string, userId: string, cmdId: string): void {
    const c = this.db.get<ComandoRow>('SELECT * FROM comandos WHERE id = ? AND workspace_id = ?', cmdId, ws);
    if (!c) throw notFound('comando');
    // conversa é de uma pessoa só: quem não é dona dela não para o comando (o card é da equipe toda)
    if (c.conversation_id && !this.db.get('SELECT 1 AS x FROM conversations WHERE id = ? AND workspace_id = ? AND owner_user_id = ?', c.conversation_id, ws, userId)) throw notFound('comando');
    if (c.status !== 'ativo') return;
    this.mudar(c.id, { status: 'parado', proxima_em: null }, ws);
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: `comando.${c.kind}.parado`, targetType: c.task_id ? 'task' : 'conversation', targetId: c.task_id ?? c.conversation_id, result: 'parado por você' });
    this.avisar(c);
  }
  pararTipo(ws: string, userId: string, alvo: Alvo, kind: TipoComando): number {
    const o = this.onde(alvo);
    const ativos = this.db.all<{ id: string }>(`SELECT id FROM comandos WHERE workspace_id = ? AND ${o.sql} AND kind = ? AND status = 'ativo'`, ws, o.arg, kind);
    for (const a of ativos) this.parar(ws, userId, a.id);
    return ativos.length;
  }

  private criar(ws: string, userId: string, alvo: Alvo, kind: ComandoRow['kind'], texto: string, o: { criterio?: string | null; intervaloS?: number | null; max?: number | null }): ComandoRow {
    const cmdId = id('cmd');
    const intervalo = kind === 'meta' || kind === 'revisao' ? null : Math.min(INTERVALO_MAX_S, Math.max(INTERVALO_MIN_S, Math.round(o.intervaloS ?? INTERVALO_PADRAO_S)));
    const max = kind === 'revisao' ? 1 : Math.min(RODADAS_MAX, Math.max(1, Math.round(o.max ?? RODADAS_PADRAO[kind])));
    this.db.tx(() => {
      // um de cada tipo por conversa ou card: o novo troca o anterior
      const w = this.onde(alvo);
      this.db.run(`UPDATE comandos SET status = 'parado', proxima_em = NULL, updated_at = ? WHERE workspace_id = ? AND ${w.sql} AND kind = ? AND status = 'ativo'`, now(), ws, w.arg, kind);
      this.db.run(`INSERT INTO comandos (id, workspace_id, user_id, conversation_id, task_id, kind, texto, criterio, intervalo_s, max_rodadas, status, proxima_em, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativo', ?, ?, ?)`,
        cmdId, ws, userId, alvo.conversationId ?? null, alvo.taskId ?? null, kind, this.db.seal(ws, texto), o.criterio ? this.db.seal(ws, clip(o.criterio, 2000)) : null, intervalo, max,
        intervalo ? new Date(this.agora() + intervalo * 1000).toISOString() : null, now(), now());
    });
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: `comando.${kind}`, targetType: alvo.taskId ? 'task' : 'conversation', targetId: alvo.taskId ?? alvo.conversationId,
      evidence: { kind, intervalo, max }, result: clip(texto, 200) });
    const c = this.db.get<ComandoRow>('SELECT * FROM comandos WHERE id = ?', cmdId)!;
    this.avisar(c);
    return c;
  }

  /** Dispara uma rodada: na conversa, como mensagem da pessoa; no card, devolvendo o card à equipe com a instrução. */
  private rodada(c: ComandoRow, visivel: string, nota: string | null, n: number | 'i' = c.rodadas + 1): string | null {
    // a chave de cada rodada é única (reenvio da mesma rodada não duplica; a rodada seguinte nunca se confunde com ela)
    const chave = `${KEY_RODADA}-${c.id.replace(/[^A-Za-z0-9]/g, '').slice(-24)}-${n}`;
    if (c.conversation_id) return this.d.enviar(c.workspace_id, c.user_id, c.conversation_id, visivel, chave, nota).runId;
    return this.d.devolver(c.workspace_id, c.user_id, c.task_id!, nota ? `${visivel}\n\n${nota}` : visivel).runId;
  }

  /**
   * Executa um comando (da tela ou do atalho digitado). Devolve o que a tela precisa dizer: o tipo, o que aconteceu
   * (codigo) e, quando há, a execução que começou.
   */
  async executar(ws: string, userId: string, alvo: Alvo, cmd: { tipo: TipoComando; texto?: string; intervaloS?: number | null; criterio?: string | null; max?: number | null; parar?: boolean }):
  Promise<{ tipo: TipoComando; codigo: 'ligado' | 'parado' | 'nada_a_parar' | 'entregue' | 'sem_trabalho' | 'pedida'; id?: string; runId?: string | null }> {
    this.conferirAlvo(ws, userId, alvo);
    const texto = clip((cmd.texto ?? '').trim(), 4000);
    if (cmd.parar) return { tipo: cmd.tipo, codigo: this.pararTipo(ws, userId, alvo, cmd.tipo) ? 'parado' : 'nada_a_parar' };
    if (cmd.tipo === 'comentar') {
      if (!texto) throw new HttpError(400, 'texto', 'Escreva o comentário.');
      return { tipo: 'comentar', codigo: (await this.comentar(ws, userId, alvo, texto)) ? 'entregue' : 'sem_trabalho' };
    }
    if (cmd.tipo === 'revisao') {
      const r = await this.revisar(ws, userId, alvo, texto);
      return { tipo: 'revisao', codigo: 'pedida', id: r.id, runId: r.runId };
    }
    if (!texto) throw new HttpError(400, 'texto', cmd.tipo === 'meta' ? 'Escreva o critério: como saber que o trabalho terminou.' : 'Escreva o pedido que deve voltar a cada intervalo.');
    const c = this.criar(ws, userId, alvo, cmd.tipo, texto, { criterio: cmd.criterio, intervaloS: cmd.intervaloS, max: cmd.max });
    let runId: string | null = null;
    // a primeira rodada sai agora. Na conversa: como mensagem sua. No card: a meta vale a partir da próxima entrega (o card
    // pode estar no meio do trabalho); repetir e checagem esperam o primeiro intervalo.
    if (c.conversation_id) {
      try {
        runId = this.rodada(c, cmd.tipo === 'meta' ? TX.metaInicio[this.lingua(userId)](texto) : texto, null, cmd.tipo === 'meta' ? 'i' : 1);
        if (cmd.tipo !== 'meta') this.mudar(c.id, { rodadas: 1, run_id: runId }, ws);
        else this.mudar(c.id, { run_id: runId }, ws);
      } catch { /* o agente está respondendo agora: a rodada sai no próximo passo (meta: na próxima resposta dele) */ }
    }
    return { tipo: cmd.tipo, codigo: 'ligado', id: c.id, runId };
  }

  /** Comentar sem interromper: entra no trabalho em andamento desta conversa ou deste card. false = não há trabalho agora. */
  async comentar(ws: string, userId: string, alvo: Alvo, texto: string): Promise<boolean> {
    const o = this.onde(alvo);
    const r = this.db.get<RunRow>(`SELECT * FROM runs WHERE workspace_id = ? AND ${o.sql} AND status IN ('running', 'waiting_user') AND mode = 'real' AND hermes_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, ws, o.arg);
    if (!r) return false;
    // o mesmo caminho de "Orientar sem interromper" (RunExecutor.steer → HermesClient.steer, no perfil em que a execução
    // começou): um só jeito de falar com o trabalho em andamento. 409 = o trabalho não recebe agora (terminou, parando,
    // esperando a pessoa) ou o motor não tem a rota
    try { await this.executor.steer(ws, r.id, userId, clip(texto, 4000)); }
    catch (e) { if (e instanceof HttpError && e.status === 409) return false; throw e; }
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'comando.comentar', targetType: 'run', targetId: r.id, evidence: { run: r.id }, result: clip(texto, 300) });
    if (r.conversation_id) this.nota(ws, r.conversation_id, TX.comentario[this.lingua(userId)](texto));
    if (r.task_id) this.bus.publish(ws, 'tasks.changed', { id: r.task_id });
    return true;
  }

  /** O trecho recente do trabalho, para o revisor: as últimas mensagens da conversa, ou o pedido e a última entrega do card. */
  private trecho(ws: string, alvo: Alvo): Array<{ role: 'user' | 'assistant'; text: string }> {
    if (alvo.conversationId) {
      return this.db.all<{ role: string; content: string }>("SELECT role, content FROM messages WHERE workspace_id = ? AND conversation_id = ? AND role IN ('user', 'agent') ORDER BY created_at DESC, rowid DESC LIMIT 10", ws, alvo.conversationId)
        .reverse().map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, text: clip(m.content ?? '', 12_000) })).filter((m) => m.text.trim());
    }
    const t = this.db.get<{ title: string; description: string | null }>('SELECT title, description FROM tasks WHERE id = ? AND workspace_id = ?', alvo.taskId!, ws);
    const out = this.db.get<{ output: string | null }>("SELECT output FROM runs WHERE workspace_id = ? AND task_id = ? AND status = 'succeeded' AND review_id IS NULL AND output IS NOT NULL ORDER BY finished_at DESC LIMIT 1", ws, alvo.taskId!);
    return [{ role: 'user' as const, text: clip(`${t?.title ?? ''}\n\n${t?.description ?? ''}`.trim(), 12_000) }, ...(out?.output ? [{ role: 'assistant' as const, text: clip(out.output, 12_000) }] : [])].filter((m) => m.text);
  }

  /** Quem revisa: um colega ativo que não fez o trabalho (de preferência quem tem a Revisão; senão a coordenação; senão outro). */
  private revisor(ws: string, autor: string | null): { id: string; name: string } | null {
    const todos = this.db.all<{ id: string; name: string; tools: string | null; coordinator: number | null }>("SELECT id, name, tools, coordinator FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at, rowid", ws)
      .filter((a) => a.id !== autor);
    const tem = (a: { tools: string | null }) => { try { return (JSON.parse(a.tools ?? '[]') as string[]).includes('revisao'); } catch { return false; } };
    return todos.find((a) => tem(a) && !Number(a.coordinator)) ?? todos.find(tem) ?? todos.find((a) => Number(a.coordinator)) ?? todos[0] ?? null;
  }

  async revisar(ws: string, userId: string, alvo: Alvo, foco: string): Promise<{ id: string; runId: string }> {
    const trecho = this.trecho(ws, alvo);
    if (!trecho.some((m) => m.role === 'assistant')) throw new HttpError(409, 'sem_trabalho', 'Ainda não há trabalho entregue aqui para revisar.');
    const autor = alvo.conversationId ? this.db.get<{ agent_id: string }>('SELECT agent_id FROM conversations WHERE id = ?', alvo.conversationId)?.agent_id ?? null
      : this.db.get<{ agent_id: string | null }>('SELECT agent_id FROM tasks WHERE id = ?', alvo.taskId!)?.agent_id ?? null;
    const rev = this.revisor(ws, autor);
    if (!rev) throw new HttpError(409, 'sem_revisor', 'Não há outro colega ativo na equipe para revisar.');
    // o pedido de revisão do próprio motor; sem a ponte (motor desligado ou de antes), o mesmo trecho com um pedido simples
    let pedido: string;
    const control = this.d.control(ws);
    try {
      if (!control?.pedidoRevisao) throw new Error('sem ponte');
      pedido = (await control.pedidoRevisao(trecho, foco)).pedido;
    } catch {
      pedido = ['Faça uma revisão independente e completa do trabalho abaixo: o que ele faz, se está correto e completo, os defeitos e riscos concretos, o que você conferiu e o que só leu, e um veredito claro com os próximos passos.',
        '', ...trecho.map((m) => `[${m.role === 'user' ? 'PESSOA' : 'AGENTE'}]\n${m.text}\n`), ...(foco ? ['Foco pedido pela pessoa:', foco] : [])].join('\n');
    }
    const c = this.criar(ws, userId, alvo, 'revisao', foco || '—', {});
    // sessão separada: a execução não é da conversa nem do card (o revisor não herda o contexto de quem fez)
    const run = this.executor.enqueue({ workspaceId: ws, agentId: rev.id, kind: 'chat', input: pedido, maxInput: 200_000,
      instructions: 'Você é o revisor independente deste trabalho: não foi você quem fez. Seja direto e específico; não suavize os achados. Responda no idioma do trabalho revisado.',
      idempotencyKey: `${KEY_REVISAO}${c.id}` });
    this.mudar(c.id, { run_id: run.id, nota: rev.name }, ws);
    return { id: c.id, runId: run.id };
  }

  private async julgar(ws: string, meta: string, resposta: string): Promise<VereditoMeta> {
    if (this.juiz) return this.juiz(ws, meta, resposta);
    const control = this.d.control(ws);
    if (!control?.julgarMeta) return { veredito: 'continue', motivo: '', continuar: '', semJuiz: true };
    try { return await control.julgarMeta(meta, resposta); } catch { return { veredito: 'continue', motivo: '', continuar: '', semJuiz: true }; }
  }

  /** Uma execução terminou: o parecer de uma revisão volta para onde foi pedida; a meta (ou o critério do repetir) é julgada. */
  async execucaoTerminou(r: RunRow, status: RunStatus, output: string | null): Promise<void> {
    if (r.idempotency_key.startsWith(KEY_REVISAO)) return this.revisaoTerminou(r, status, output);
    if (status !== 'succeeded' || !output?.trim() || r.review_id) return;
    const alvo = r.kind === 'chat' && r.conversation_id ? { sql: 'conversation_id = ?', arg: r.conversation_id } : r.task_id ? { sql: 'task_id = ?', arg: r.task_id } : null;
    if (!alvo) return;
    const ativos = this.db.all<ComandoRow>(`SELECT * FROM comandos WHERE workspace_id = ? AND ${alvo.sql} AND status = 'ativo' AND (kind = 'meta' OR (kind = 'repetir' AND criterio IS NOT NULL))`, r.workspace_id, alvo.arg);
    for (const c of ativos) {
      if (this.julgando.has(c.id)) continue;
      this.julgando.add(c.id);
      try { await this.julgarRodada(c, output); } finally { this.julgando.delete(c.id); }
    }
  }

  private async julgarRodada(c: ComandoRow, output: string): Promise<void> {
    const ws = c.workspace_id;
    const criterio = c.kind === 'meta' ? c.texto : c.criterio!;
    const v = await this.julgar(ws, criterio, output);
    const atual = this.db.get<ComandoRow>('SELECT * FROM comandos WHERE id = ?', c.id);
    if (!atual || atual.status !== 'ativo') return; // você parou enquanto o juiz lia
    if (v.semJuiz) {
      // sem juiz não há como saber se cumpriu: para aqui, em vez de gastar rodadas no escuro
      this.mudar(c.id, { status: 'bloqueado', nota: 'sem_juiz', proxima_em: null }, ws);
    } else if (v.veredito === 'done') {
      this.mudar(c.id, { status: 'cumprido', nota: v.motivo, proxima_em: null }, ws);
    } else if (v.veredito === 'blocked') {
      this.mudar(c.id, { status: 'bloqueado', nota: v.motivo, proxima_em: null }, ws);
    } else if (c.kind === 'meta') {
      if (atual.rodadas + 1 > atual.max_rodadas) {
        this.mudar(c.id, { status: 'esgotado', nota: v.motivo }, ws);
      } else {
        this.mudar(c.id, { rodadas: atual.rodadas + 1, nota: v.motivo }, ws);
        try {
          const runId = this.rodada(atual, TX.metaSegue[this.lingua(c.user_id)](c.texto, v.motivo || '…'), v.continuar || null, atual.rodadas + 1);
          this.mudar(c.id, { run_id: runId }, ws);
        } catch { this.mudar(c.id, { status: 'bloqueado', nota: 'sem_rodada' }, ws); }
      }
    } else {
      this.mudar(c.id, { nota: v.motivo }, ws); // repetir: o relógio traz a próxima rodada
    }
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: `comando.${c.kind}.juiz`, targetType: c.task_id ? 'task' : 'conversation', targetId: c.task_id ?? c.conversation_id,
      evidence: { veredito: v.veredito, semJuiz: v.semJuiz, rodada: atual.rodadas }, result: clip(v.semJuiz ? 'o juiz não respondeu' : `${v.veredito}: ${v.motivo}`, 300) });
    this.avisar(c);
  }

  private revisaoTerminou(r: RunRow, status: RunStatus, output: string | null): void {
    const c = this.db.get<ComandoRow>("SELECT * FROM comandos WHERE id = ? AND kind = 'revisao'", r.idempotency_key.slice(KEY_REVISAO.length));
    if (!c || c.status !== 'ativo') return;
    const quem = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? '';
    const l = this.lingua(c.user_id);
    if (status === 'succeeded' && output?.trim()) {
      this.mudar(c.id, { status: 'cumprido', nota: `${quem}\n${output}`, rodadas: 1 }, c.workspace_id);
      if (c.conversation_id) this.nota(c.workspace_id, c.conversation_id, `${TX.revisaoDe[l](quem)}\n\n${output}`);
      else audit(this.db, this.bus, { workspaceId: c.workspace_id, actorType: 'agent', actorId: r.agent_id, action: 'comando.revisao.parecer', targetType: 'task', targetId: c.task_id, evidence: { runId: r.id, output: clip(output, 1500) }, result: `revisão independente, por ${quem}` });
    } else {
      this.mudar(c.id, { status: 'bloqueado', nota: `${quem}\n${TX.revisaoFalhou[l]()}` }, c.workspace_id);
      if (c.conversation_id) this.nota(c.workspace_id, c.conversation_id, TX.revisaoFalhou[l]());
    }
    if (c.task_id) this.bus.publish(c.workspace_id, 'tasks.changed', { id: c.task_id });
    this.avisar(c);
  }

  /** O relógio: repetir e checagem que venceram disparam mais uma rodada (se o trabalho estiver parado e o cofre aberto). */
  tick(): number {
    const t = new Date(this.agora()).toISOString();
    let n = 0;
    for (const c of this.db.all<ComandoRow>("SELECT * FROM comandos WHERE status = 'ativo' AND kind IN ('repetir', 'checagem') AND proxima_em IS NOT NULL AND proxima_em <= ? ORDER BY proxima_em LIMIT 20", t)) {
      if (!this.db.workspaceOpen(c.workspace_id)) continue;
      const aberto = this.db.get<ComandoRow>('SELECT * FROM comandos WHERE id = ?', c.id)!; // texto decifrado
      const w = aberto.conversation_id ? { sql: 'conversation_id = ?', arg: aberto.conversation_id } : { sql: 'task_id = ?', arg: aberto.task_id! };
      const proxima = new Date(this.agora() + (aberto.intervalo_s ?? INTERVALO_PADRAO_S) * 1000).toISOString();
      if (aberto.rodadas >= aberto.max_rodadas) { this.mudar(aberto.id, { status: 'esgotado', proxima_em: null }, aberto.workspace_id); this.avisar(aberto); continue; }
      // o trabalho ainda anda: esta volta passa (a checagem é para quando está parado; o repetir não empilha pedidos)
      if (this.db.get(`SELECT 1 AS x FROM runs WHERE workspace_id = ? AND ${w.sql} AND status IN ('queued', 'running', 'waiting_user')`, aberto.workspace_id, w.arg)) {
        this.mudar(aberto.id, { proxima_em: proxima }, aberto.workspace_id);
        continue;
      }
      try {
        const runId = this.rodada(aberto, aberto.texto, null);
        this.mudar(aberto.id, { rodadas: aberto.rodadas + 1, proxima_em: proxima, run_id: runId }, aberto.workspace_id);
        n++;
      } catch (e) {
        // o card saiu do quadro, a conversa encheu…: para, dizendo por quê (o texto do erro é do próprio Ergon)
        this.mudar(aberto.id, { status: 'bloqueado', proxima_em: null, nota: e instanceof HttpError ? e.message : 'sem_rodada' }, aberto.workspace_id);
      }
      this.avisar(aberto);
    }
    return n;
  }
}
