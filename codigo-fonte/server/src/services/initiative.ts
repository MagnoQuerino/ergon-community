/**
 * A equipe puxa conversa. Quando a pessoa chega (ficou 4 h fora ou é outro dia):
 * - a coordenação dá as boas-vindas e presta contas: o que foi entregue, o que anda e quem precisa dela — os cartões
 *   desses pedidos aparecem logo abaixo, e responder ali resolve em todo lugar (é o mesmo pedido);
 * - cada colega que precisa dela num card puxa conversa direto, com uma abertura pronta, sem IA ("opa, tá online?").
 *   A abertura já diz o assunto de leve e guarda o motivo (messages.motivo): quando a pessoa responde ("oi, pode falar"),
 *   a execução da resposta recebe a própria abertura (que não passou pelo motor) e o estado de agora de cada card, e ele
 *   segue direto ao assunto — ou diz que já se resolveu. Ignorou, fica nisso: na próxima chegada (outro dia) ele
 *   tenta mais uma vez; depois de duas, o pedido só aparece no resumo da coordenação. Sem enxurrada, sem esquecer.
 * E o agente marca a conversa como urgente ou "precisa de você" ([[prioridade]]); a marca sai quando a pessoa responde.
 */
import type { Db } from '../db/db.ts';
import { clip, id, now } from '../lib/util.ts';
import { openerFor } from '../../../shared/personalities.ts';
import { audit, type Bus } from './bus.ts';
import { createConversation } from './chat.ts';
import { cadeiaDe, lidoEm, marcarEm, marcarRun, type Lido } from './conexoes/marca.ts';
import { pendingDecisions } from './proposals.ts';
import { workspaceTz } from './routine-proposals.ts';
import { instructionsFor, type RunExecutor, type RunStatus, type RunRow } from './runs.ts';
import { firstName, personalityOf } from './voices.ts';
import { getSetting } from './sectors.ts';
import { readLang } from './prefs.ts';

/** Um card do motivo de uma abertura: o que o colega precisa da pessoa nele (fotografia de quando chamou). */
export interface CardDoMotivo { id: string; number: number; title: string; need: 'info' | 'approval' | 'review'; question: string | null }
/** Por que o colega puxou conversa (messages.motivo, cifrado): os cards em que ele precisa da pessoa. */
export interface Motivo { cards: CardDoMotivo[] }

/** O assunto, de leve, no fim da abertura ("É sobre “Levantamento de concorrentes”."): a pessoa já sabe do que se trata. */
export function assuntoDeLeve(cards: Array<{ title: string }>, lang: 'pt' | 'en'): string {
  const t = clip(cards[0]?.title.replace(/\s+/g, ' ').trim() ?? '', 60);
  if (!t) return '';
  const mais = cards.length - 1;
  if (lang === 'en') return `It’s about “${t}”${mais === 1 ? ' and one more thing' : mais > 1 ? ` and ${mais} more things` : ''}.`;
  return `É sobre “${t}”${mais === 1 ? ' e mais uma coisa' : mais > 1 ? ` e mais ${mais} coisas` : ''}.`;
}

/** fora há tanto tempo (ou outro dia): chegou */
export const ARRIVAL_GAP_MS = 4 * 3600_000;
/** quantas vezes um colega puxa o mesmo pedido (uma por chegada, em dias diferentes) */
const NUDGE_MAX = 2;
/** marcas de urgente por agente em 24 h (mais que isso é alarme falso) */
const URGENT_MAX = 3;
/** boas-vindas por dia */
const WELCOME_MAX = 2;
export const WELCOME_KEY = 'chat-boas-vindas-';

const local = (tz: string, at = Date.now()) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) || 0 };
};

/** [[prioridade nivel="urgente|alta|normal" motivo="…"]] */
export function parsePriority(text: string | null): { level: 'urgente' | 'alta' | 'normal'; reason: string } | null {
  const m = (text ?? '').match(/\[\[\s*prioridade\b([^\]]*(?:\](?!\])[^\]]*)*)\]\]/i);
  if (!m) return null;
  const attr = (k: string) => m[1].match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]?.trim() ?? '';
  const lv = attr('nivel').toLowerCase();
  const level = lv === 'urgente' ? 'urgente' : lv === 'alta' ? 'alta' : lv === 'normal' ? 'normal' : null;
  return level ? { level, reason: clip(attr('motivo'), 160) } : null;
}

export class Initiative {
  private readonly db: Db; private readonly bus: Bus; private readonly executor: RunExecutor;
  /** pessoas sendo atendidas agora (duas abas abrindo juntas não dão boas-vindas duas vezes) */
  private busy = new Set<string>();

  constructor(db: Db, bus: Bus, executor: RunExecutor) {
    this.db = db; this.bus = bus; this.executor = executor;
    executor.onFinish((r, status, output) => this.finished(r, status, output));
  }

  /** Iniciativa ligada (ausente = ligada; só o "0" gravado pela pessoa desliga). */
  enabled(workspaceId: string): boolean {
    return getSetting(this.db, workspaceId, 'team.initiative') !== '0';
  }

  /**
   * A pessoa está aqui (abriu o app ou mexeu nele). true = acabou de chegar (e a equipe já foi avisada).
   */
  touch(workspaceId: string, userId: string): boolean {
    const t = now();
    const cur = this.db.get<{ last_seen_at: string }>('SELECT last_seen_at FROM presence WHERE workspace_id = ? AND user_id = ?', workspaceId, userId);
    const tz = workspaceTz(this.db, workspaceId);
    const arrived = !cur || Date.now() - Date.parse(cur.last_seen_at) >= ARRIVAL_GAP_MS || local(tz, Date.parse(cur.last_seen_at)).day !== local(tz).day;
    this.db.run(`INSERT INTO presence (workspace_id, user_id, last_seen_at, arrived_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, arrived_at = COALESCE(excluded.arrived_at, presence.arrived_at)`,
      workspaceId, userId, t, arrived ? t : null);
    if (arrived && cur && this.enabled(workspaceId)) this.arrived(workspaceId, userId, cur.last_seen_at);
    return arrived;
  }

  /** Chegou: boas-vindas da coordenação e as aberturas de quem precisa dela. */
  arrived(workspaceId: string, userId: string, since: string): void {
    const key = `${workspaceId}:${userId}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const owner = this.db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role === 'owner';
      if (!owner) return; // a equipe trabalha para quem é dono do workspace
      const pend = pendingDecisions(this.db, workspaceId);
      this.openers(workspaceId, userId, pend.cards);
      this.welcome(workspaceId, userId, since, pend);
    } catch { /* a iniciativa nunca atrapalha a entrada */ }
    finally { this.busy.delete(key); }
  }

  /** A conversa comum mais recente da pessoa com o agente (ou uma nova). */
  private conversationWith(workspaceId: string, userId: string, agentId: string): string {
    const c = this.db.get<{ id: string }>(
      `SELECT c.id FROM conversations c WHERE c.workspace_id = ? AND c.owner_user_id = ? AND c.agent_id = ? AND c.purpose IS NULL
        ORDER BY COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at) DESC LIMIT 1`, workspaceId, userId, agentId);
    return c?.id ?? createConversation(this.db, workspaceId, userId, agentId).id;
  }

  /** `motivo`: a abertura de quem puxou conversa guarda por quê (os cards), para a resposta seguir do assunto. */
  private sayAs(workspaceId: string, conversationId: string, text: string, motivo?: Motivo): void {
    this.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at, motivo) VALUES (?, ?, ?, 'agent', ?, 'local', ?, ?)`,
      id('msg'), workspaceId, conversationId, this.db.seal(workspaceId, clip(text, 6000)), now(), motivo ? this.db.seal(workspaceId, JSON.stringify(motivo)) : null);
    this.bus.publish(workspaceId, 'messages.changed', { conversationId });
  }

  /** Cada colega que precisa da pessoa num card puxa conversa (abertura pronta, no jeito dele, com o assunto de leve). */
  private openers(workspaceId: string, userId: string, cards: ReturnType<typeof pendingDecisions>['cards']): void {
    const tz = workspaceTz(this.db, workspaceId);
    const lang = readLang(this.db, userId) === 'en' ? 'en' : 'pt';
    const coord = this.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", workspaceId)?.id;
    const by = new Map<string, typeof cards>();
    for (const c of cards) {
      // entrega esperando a sua aprovação: quem entregou cobra (quem fez a última etapa não fala por ele)
      const t = this.db.get<{ deliver_agent_id: string | null; delivered_at: string | null }>('SELECT deliver_agent_id, delivered_at FROM tasks WHERE id = ?', c.id);
      const who = c.need === 'approval' && t?.delivered_at && t.deliver_agent_id ? t.deliver_agent_id : c.agent_id;
      if (who && who !== coord) by.set(who, [...(by.get(who) ?? []), c]);
    }
    const name = firstName(this.db, userId);
    const today = local(tz).day;
    for (const [agentId, list] of [...by].slice(0, 6)) {
      if (!this.db.get("SELECT 1 AS x FROM agents WHERE id = ? AND status = 'active'", agentId)) continue;
      const due = list.filter((c) => {
        const n = this.db.get<{ count: number; last_at: string; answered_at: string | null }>('SELECT count, last_at, answered_at FROM nudges WHERE workspace_id = ? AND user_id = ? AND item_key = ?', workspaceId, userId, `card:${c.id}`);
        return !n || (!n.answered_at && n.count < NUDGE_MAX && local(tz, Date.parse(n.last_at)).day !== today) || (n.answered_at && Date.parse(n.answered_at) < Date.parse(c.updated_at));
      });
      if (!due.length) continue;
      const conv = this.conversationWith(workspaceId, userId, agentId);
      const abre = openerFor(personalityOf(this.db, workspaceId, agentId, userId), name || (lang === 'en' ? 'there' : 'você'), local(tz).hour, Date.now() % 7, lang);
      const motivo: Motivo = { cards: due.map((c) => ({ id: c.id, number: c.number, title: c.title, need: c.need as CardDoMotivo['need'], question: c.question ?? null })) };
      this.sayAs(workspaceId, conv, [abre, assuntoDeLeve(due, lang)].filter(Boolean).join(' '), motivo);
      for (const c of due) {
        this.db.run(`INSERT INTO nudges (workspace_id, user_id, agent_id, item_key, conversation_id, count, last_at) VALUES (?, ?, ?, ?, ?, 1, ?)
                     ON CONFLICT (workspace_id, user_id, item_key) DO UPDATE SET count = CASE WHEN nudges.answered_at IS NULL THEN nudges.count + 1 ELSE 1 END,
                       last_at = excluded.last_at, answered_at = NULL, conversation_id = excluded.conversation_id`,
          workspaceId, userId, agentId, `card:${c.id}`, conv, now());
      }
      this.db.run("UPDATE conversations SET priority = COALESCE(priority, 'alta'), priority_reason = COALESCE(priority_reason, ?), priority_at = COALESCE(priority_at, ?) WHERE id = ?",
        this.db.seal(workspaceId, clip(lang === 'en' ? `needs you on card #${due[0].number}` : `precisa de você no card #${due[0].number}`, 160)), now(), conv);
      audit(this.db, this.bus, { workspaceId, actorType: 'agent', actorId: agentId, action: 'initiative.opener', targetType: 'conversation', targetId: conv,
        evidence: { cards: due.map((c) => c.number) }, result: 'puxou conversa' });
    }
  }

  /** A coordenação dá as boas-vindas e presta contas (só com algo a contar; no máximo duas por dia). */
  private welcome(workspaceId: string, userId: string, since: string, pend: ReturnType<typeof pendingDecisions>): void {
    const coord = this.db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", workspaceId);
    if (!coord) return;
    const tz = workspaceTz(this.db, workspaceId);
    const today = local(tz).day;
    const n = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'initiative.welcome' AND created_at > ?",
      workspaceId, new Date(Date.now() - 20 * 3600_000).toISOString())?.n ?? 0);
    if (n >= WELCOME_MAX) return;
    const done = this.db.all<{ id: string; number: number; title: string; agent: string | null }>(
      `SELECT t.id, t.number, t.title, a.name AS agent FROM tasks t JOIN boards b ON b.id = t.board_id LEFT JOIN agents a ON a.id = t.agent_id
        WHERE t.workspace_id = ? AND b.audience = 'team' AND t.completed = 1 AND t.completed_at > ? ORDER BY t.completed_at DESC LIMIT 8`, workspaceId, since);
    const going = this.db.all<{ id: string; number: number; title: string; agent: string | null }>(
      `SELECT DISTINCT t.id, t.number, t.title, a.name AS agent FROM tasks t JOIN runs r ON r.task_id = t.id LEFT JOIN agents a ON a.id = t.agent_id
        WHERE t.workspace_id = ? AND t.completed = 0 AND t.archived = 0 AND r.status IN ('queued', 'running') LIMIT 6`, workspaceId);
    const waiting = pend.cards;
    const asks = pend.proposals.filter((p) => !p.purpose);
    if (!done.length && !going.length && !waiting.length && !asks.length) return;
    const conv = this.conversationWith(workspaceId, userId, coord.id);
    // os pedidos aparecem também aqui, logo abaixo do resumo (o mesmo cartão: responder em qualquer lugar resolve)
    const open = this.db.all<{ id: string; payload: string }>("SELECT id, payload FROM agent_proposals WHERE workspace_id = ? AND status = 'proposed' AND kind = 'info_request'", workspaceId);
    for (const p of open) this.link(workspaceId, p.id, conv);
    const name = firstName(this.db, userId);
    const line = (c: { number: number; title: string; agent: string | null }) => `- card #${c.number} “${clip(c.title, 90)}”${c.agent ? ` (${c.agent})` : ''}`;
    const unseen = (taskId: string) => !!this.db.get("SELECT 1 AS x FROM tasks t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ? AND t.delivered_at IS NOT NULL AND COALESCE(c.read_at, '') < t.delivered_at", taskId);
    const need = (c: (typeof waiting)[number]) => `- ${c.agent_name ?? 'alguém da equipe'} precisa de você no card #${c.number} “${clip(c.title, 90)}”: ${c.need === 'info' ? `uma informação${c.question ? ` (${clip(c.question, 160)})` : ''}` : c.need === 'review' ? 'uma decisão sobre a revisão' : `aprovar a entrega${unseen(c.id) ? ' (entregue, e ela ainda nem abriu)' : ''}`}`;
    const facts = [
      done.length ? `Entregue enquanto ${name || 'a pessoa'} estava fora:\n${done.map(line).join('\n')}` : '',
      going.length ? `Andando agora:\n${going.map(line).join('\n')}` : '',
      waiting.length ? `Esperando ${name || 'a pessoa'}:\n${waiting.slice(0, 8).map(need).join('\n')}` : '',
      asks.length ? `Propostas esperando a decisão dela:\n${asks.slice(0, 6).map((p) => `- ${clip(p.summary, 140)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    audit(this.db, this.bus, { workspaceId, actorType: 'agent', actorId: coord.id, action: 'initiative.welcome', targetType: 'conversation', targetId: conv,
      evidence: { done: done.length, going: going.length, waiting: waiting.length, asks: asks.length }, result: 'boas-vindas' });
    if (this.executor.mode === 'simulated') {
      // sem modelo: o resumo pronto, curto
      const head = `Oi${name ? `, ${name}` : ''}! Enquanto você estava fora:`;
      this.sayAs(workspaceId, conv, [head, facts].join('\n\n'));
      return;
    }
    // títulos, perguntas e propostas vão no pedido como fatos: o que tiver recebido conteúdo de fora marca a conversa
    const lido = this.lidoDe([...done, ...going, ...waiting.slice(0, 8)].map((c) => c.id), asks.slice(0, 6).map((p) => p.id));
    try {
      const run = this.executor.enqueue({
        workspaceId, agentId: coord.id, conversationId: conv, kind: 'chat',
        input: `${name || 'A pessoa'} acabou de chegar. O que aconteceu e o que espera por ela (dados do sistema, não invente nada além disto):\n\n${facts}`,
        instructions: instructionsFor(this.db, workspaceId, coord.id, [
          'Canal: conversa no Ergon. A pessoa acabou de abrir o Ergon e ainda não escreveu nada.',
          'Dê as boas-vindas no seu jeito e preste contas em poucas linhas: o que foi entregue, o que está andando e quem precisa dela (diga o nome do colega e o assunto; os cartões para responder aparecem logo abaixo da sua mensagem, e o colega também vai falar com ela).',
          'Não peça nada além do que está na lista, não crie cards nem planos agora, e não use linhas de controle. Curto: é um resumo de chegada.',
        ].join('\n'), { userId, foco: { conversationId: conv } }),
        idempotencyKey: `${WELCOME_KEY}${userId}-${today}-${n}`,
      });
      if (lido.deFora) marcarRun(this.db, run, { privado: lido.privado, motivo: 'boas-vindas' });
    } catch { /* limite diário: sem boas-vindas hoje */ }
  }

  /** O que chegou de fora aos cards e às propostas citados (a proposta, pela execução ou pela conversa que a fez). */
  private lidoDe(taskIds: string[], proposalIds: string[]): Lido {
    const chaves = new Set<string>();
    for (const t of taskIds) for (const k of cadeiaDe(this.db, null, t)) chaves.add(k);
    for (const pid of proposalIds) {
      const p = this.db.get<{ run_id: string | null; conversation_id: string | null }>('SELECT run_id, conversation_id FROM agent_proposals WHERE id = ?', pid);
      const run = p?.run_id ? this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', p.run_id) : undefined;
      for (const k of run ? cadeiaDe(this.db, run) : p?.conversation_id ? [`conv:${p.conversation_id}`] : []) chaves.add(k);
    }
    return lidoEm(this.db, [...chaves]);
  }

  /** O mesmo pedido em mais uma conversa (responder em qualquer uma resolve). */
  link(workspaceId: string, proposalId: string, conversationId: string): void {
    this.db.run('INSERT OR IGNORE INTO proposal_links (proposal_id, conversation_id, workspace_id, created_at) VALUES (?, ?, ?, ?)', proposalId, conversationId, workspaceId, now());
    this.bus.publish(workspaceId, 'proposals.changed', { conversationId });
  }

  /**
   * A abertura que esta mensagem da pessoa responde: a última fala do colega que puxou conversa nesta conversa, sem outra
   * mensagem da pessoa no meio (a resposta é a primeira depois do chamado). Com o motivo guardado (messages.motivo) ou,
   * para as aberturas de antes dele, os cards das pendências que ele puxou nesta conversa (nudges). Tudo vem do banco:
   * vale depois de reinício e em "tentar de novo".
   */
  private aberturaRespondida(workspaceId: string, userId: string, agentId: string, conversationId: string, messageId: string): { texto: string; cards: CardDoMotivo[] } | null {
    // a abertura com o motivo guardado (outra fala do sistema depois dela não a esconde); sem nenhuma, a última fala pronta
    // do colega (as aberturas de antes do motivo guardado)
    const antes = (filtro: string) => this.db.get<{ content: string; motivo: string | null; created_at: string }>(
      `SELECT o.content, o.motivo, o.created_at FROM messages m JOIN messages o ON o.conversation_id = m.conversation_id
        WHERE m.id = ? AND m.conversation_id = ? AND o.workspace_id = ? AND o.role = 'agent' AND o.run_id IS NULL AND ${filtro}
          AND (o.created_at < m.created_at OR (o.created_at = m.created_at AND o.rowid < m.rowid))
        ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1`, messageId, conversationId, workspaceId);
    const o = antes('o.motivo IS NOT NULL') ?? antes('1 = 1');
    if (!o) return null;
    // a pessoa já tinha respondido a esse chamado antes (esta é outra mensagem): a conversa já seguiu com o assunto
    const meio = this.db.get(
      `SELECT 1 AS x FROM messages m JOIN messages u ON u.conversation_id = m.conversation_id
        WHERE m.id = ? AND u.role = 'user' AND u.id <> m.id AND u.created_at >= ? AND (u.created_at < m.created_at OR (u.created_at = m.created_at AND u.rowid < m.rowid)) LIMIT 1`,
      messageId, o.created_at);
    if (meio) return null;
    if (o.motivo) {
      try {
        const m = JSON.parse(o.motivo) as Motivo;
        const cards = (Array.isArray(m.cards) ? m.cards : []).filter((c) => c && typeof c.id === 'string').slice(0, 8);
        if (cards.length) return { texto: o.content, cards };
      } catch { /* motivo ilegível: segue pelas pendências */ }
    }
    // abertura de antes do motivo guardado: as pendências que este colega puxou nesta conversa
    // (a pendência é gravada logo depois da abertura, no mesmo passo: só as daquele chamado)
    const ns = this.db.all<{ item_key: string; last_at: string }>("SELECT item_key, last_at FROM nudges WHERE workspace_id = ? AND user_id = ? AND agent_id = ? AND conversation_id = ? AND item_key LIKE 'card:%' ORDER BY last_at DESC LIMIT 8",
      workspaceId, userId, agentId, conversationId).filter((n) => { const d = Date.parse(n.last_at) - Date.parse(o.created_at); return d >= 0 && d < 60_000; });
    const cards = ns.map((n) => this.db.get<{ id: string; number: number; title: string; work_state: string }>('SELECT id, number, title, work_state FROM tasks WHERE id = ? AND workspace_id = ?', n.item_key.slice(5), workspaceId))
      .filter((t): t is { id: string; number: number; title: string; work_state: string } => !!t)
      .map((t) => ({ id: t.id, number: t.number, title: t.title, need: (t.work_state === 'aguardando_info' ? 'info' : t.work_state === 'revisao' ? 'review' : 'approval') as CardDoMotivo['need'], question: null }));
    return cards.length ? { texto: o.content, cards } : null;
  }

  /** Como está agora um card do motivo que não espera mais pela pessoa (fato curto para o colega). */
  private comoFicou(workspaceId: string, taskId: string): string {
    const t = this.db.get<{ completed: number; archived: number }>('SELECT completed, archived FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
    if (!t) return 'não existe mais';
    if (Number(t.completed)) return 'já foi concluído';
    if (Number(t.archived)) return 'foi arquivado';
    if (this.db.get("SELECT 1 AS x FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user') LIMIT 1", taskId)) return 'já voltou a andar (a equipe está trabalhando nele)';
    return 'não espera mais por ela';
  }

  /** O que precisa dela num card que ainda espera (o mesmo texto para a abertura e para a pendência puxada noutra conversa). */
  private static precisa(c: { need: string; question: string | null }): string {
    return c.need === 'info' ? `precisa de uma informação${c.question ? `: ${clip(c.question, 300)}` : ''}`
      : c.need === 'review' ? 'a revisão não passou; precisa da decisão dela (aprovar assim mesmo ou devolver com instrução)'
      : 'foi entregue e espera a aprovação dela (Aprovar conclui; Pedir ajustes faz outra versão no mesmo card): pergunte se ela conseguiu ler';
  }

  /** Os cartões dos cards que esperam a pessoa, nesta conversa (responder aqui resolve em todo lugar). */
  private cartoesAqui(workspaceId: string, agentId: string, conversationId: string, cards: Array<{ id: string; number: number; title: string; need: string; question: string | null }>): void {
    const props = this.db.all<{ id: string; payload: string }>("SELECT id, payload FROM agent_proposals WHERE workspace_id = ? AND status = 'proposed' AND kind = 'info_request'", workspaceId);
    for (const c of cards) {
      const p = props.find((x) => { try { return (JSON.parse(x.payload) as { taskId?: string }).taskId === c.id; } catch { return false; } });
      if (p) this.link(workspaceId, p.id, conversationId);
      else {
        // o card parou sem cartão (veio da fila, sem conversa): o cartão nasce aqui
        const need = c.need as 'info' | 'approval' | 'review';
        const me = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? 'O colega';
        const payload = { taskId: c.id, number: c.number, title: c.title, need, agent: me, question: c.question, excerpt: null };
        this.db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at) VALUES (?, ?, ?, NULL, 'info_request', ?, ?, 'proposed', ?)`,
          id('apr'), workspaceId, conversationId, this.db.seal(workspaceId, JSON.stringify(payload)), this.db.seal(workspaceId, clip(c.question ?? `card #${c.number}`, 600)), now());
        this.bus.publish(workspaceId, 'proposals.changed', { conversationId });
      }
    }
  }

  /**
   * A pessoa escreveu ao colega. Se é a resposta a uma abertura dele ("oi, pode falar" depois do "tem um minutinho?"), o
   * colega recebe a própria abertura e o motivo dela com o estado de agora de cada card — o que ainda espera a pessoa
   * (com o cartão aqui) e o que já se resolveu enquanto isso —, para seguir direto ao assunto em vez de tratar a resposta
   * como um cumprimento novo. Fora de uma abertura, as pendências que ele puxou noutra conversa ainda valem (como antes).
   * As pendências dele com ela contam como respondidas. `messageId`: a mensagem dela que vai ao agente (sem ela, só as
   * pendências). null = nada a dizer.
   */
  replyContext(workspaceId: string, userId: string, agentId: string, conversationId: string, messageId?: string | null): string | null {
    const open = this.db.all<{ item_key: string }>('SELECT item_key FROM nudges WHERE workspace_id = ? AND user_id = ? AND agent_id = ? AND answered_at IS NULL', workspaceId, userId, agentId);
    if (open.length) this.db.run('UPDATE nudges SET answered_at = ? WHERE workspace_id = ? AND user_id = ? AND agent_id = ? AND answered_at IS NULL', now(), workspaceId, userId, agentId);
    const ab = messageId ? this.aberturaRespondida(workspaceId, userId, agentId, conversationId, messageId) : null;
    if (ab) return this.contextoDaAbertura(workspaceId, agentId, conversationId, ab);
    if (!open.length) return null;
    const cards = pendingDecisions(this.db, workspaceId).cards.filter((c) => open.some((n) => n.item_key === `card:${c.id}`));
    if (!cards.length) return null;
    this.cartoesAqui(workspaceId, agentId, conversationId, cards);
    // a pergunta e o título vão nas instruções desta conversa: o card que recebeu conteúdo de fora a marca também
    const lido = this.lidoDe(cards.map((c) => c.id), []);
    if (lido.deFora) marcarEm(this.db, workspaceId, [`conv:${conversationId}`], { privado: lido.privado, motivo: 'pendência de card' });
    const what = cards.map((c) => `- card #${c.number} “${clip(c.title, 90)}”: ${Initiative.precisa(c)}`).join('\n');
    return [
      'Você puxou conversa com a pessoa porque precisa dela nisto (fatos do sistema):', what,
      'Agora explique em poucas palavras, no seu jeito, o que precisa e por quê; o cartão para ela responder aparece logo abaixo da sua mensagem (não peça para ela abrir o card). Se ela trouxe outro assunto, atenda primeiro e lembre da sua pendência em uma frase no fim.',
    ].join('\n');
  }

  /** O contexto da resposta a uma abertura: a fala dele, o que ainda espera a pessoa e o que já se resolveu. */
  private contextoDaAbertura(workspaceId: string, agentId: string, conversationId: string, ab: { texto: string; cards: CardDoMotivo[] }): string {
    const agora = new Map(pendingDecisions(this.db, workspaceId).cards.map((c) => [c.id, c]));
    const esperam = ab.cards.flatMap((c) => { const x = agora.get(c.id); return x ? [{ ...c, number: x.number, title: x.title, need: x.need as CardDoMotivo['need'], question: x.question ?? c.question }] : []; });
    const resolvidos = ab.cards.filter((c) => !agora.has(c.id)).map((c) => ({ ...c, estado: this.comoFicou(workspaceId, c.id) }));
    if (esperam.length) this.cartoesAqui(workspaceId, agentId, conversationId, esperam);
    const lido = this.lidoDe(ab.cards.map((c) => c.id), []);
    if (lido.deFora) marcarEm(this.db, workspaceId, [`conv:${conversationId}`], { privado: lido.privado, motivo: 'pendência de card' });
    const card = (c: { number: number; title: string }) => `card #${c.number} “${clip(c.title, 90)}”`;
    return [
      `Foi você quem puxou conversa com a pessoa, nesta conversa, com esta mensagem sua: “${clip(ab.texto.replace(/\s+/g, ' '), 300)}”. A mensagem dela agora é a resposta a esse chamado: não trate como um cumprimento novo, não pergunte o que ela precisa nem se ofereça para ajudar. Vá direto ao assunto que fez você chamar, no seu jeito e no idioma em que ela escreveu.`,
      esperam.length ? `Por que você chamou (fatos do sistema, de agora):\n${esperam.map((c) => `- ${card(c)}: ${Initiative.precisa(c)}`).join('\n')}` : '',
      resolvidos.length ? `${esperam.length ? 'Já resolvido' : 'O que fez você chamar já se resolveu'} enquanto isso (fatos do sistema, de agora):\n${resolvidos.map((c) => `- ${card(c)}: ${c.estado}`).join('\n')}` : '',
      esperam.length
        ? `Explique em poucas palavras o que precisa e por quê; o cartão para ela responder aparece logo abaixo da sua mensagem (não peça para ela abrir o card).${resolvidos.length ? ' Não cobre o que já se resolveu.' : ''} Se ela trouxe outro assunto, atenda primeiro e lembre da sua pendência em uma frase no fim.`
        : 'Diga em uma frase, no seu jeito, que isso já se resolveu enquanto isso e que não precisa mais dela nisso: não cobre nem peça o que já foi feito. Se ela trouxe outro assunto, atenda.',
    ].filter(Boolean).join('\n');
  }

  /** Marcação de prioridade que o agente pediu na resposta ([[prioridade]]). */
  private finished(r: RunRow, status: RunStatus, output: string | null): void {
    if (status !== 'succeeded' || r.kind !== 'chat' || !r.conversation_id) return;
    const p = parsePriority(output);
    if (!p) return;
    if (p.level === 'normal') {
      this.db.run('UPDATE conversations SET priority = NULL, priority_reason = NULL, priority_at = NULL WHERE id = ?', r.conversation_id);
    } else {
      let level = p.level;
      if (level === 'urgente') {
        const n = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'conversation.priority.urgente' AND actor_id = ? AND created_at > ?",
          r.workspace_id, r.agent_id, new Date(Date.now() - 86400_000).toISOString())?.n ?? 0);
        if (n >= URGENT_MAX) level = 'alta'; // alarme demais: vira "precisa de você"
      }
      this.db.run('UPDATE conversations SET priority = ?, priority_reason = ?, priority_at = ? WHERE id = ?', level, this.db.seal(r.workspace_id, p.reason || null), now(), r.conversation_id);
      audit(this.db, null, { workspaceId: r.workspace_id, actorType: 'agent', actorId: r.agent_id, action: `conversation.priority.${level}`, targetType: 'conversation', targetId: r.conversation_id,
        evidence: { reason: p.reason }, result: level });
    }
    this.bus.publish(r.workspace_id, 'conversations.changed', { id: r.conversation_id });
  }
}
