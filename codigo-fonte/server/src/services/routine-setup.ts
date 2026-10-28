/**
 * Ativação adaptativa das rotinas: antes de a rotina começar, a coordenação estuda em silêncio com o que o usuário
 * trabalha, como trabalha e como se comunica, e ajusta o foco, o tom, o formato e o horário ao caso dele — para a
 * rotina funcionar bem de primeira sem ninguém configurar nada. Este módulo junta o que o Ergon sabe (por código),
 * monta o pedido à coordenação, lê a resposta e, sem conta de IA, faz o melhor ajuste possível sozinho.
 *
 * Linhas que a coordenação escreve (nada além disto muda a rotina):
 *   [[configurar-rotina quando="seg a sex 07:45" ajuste="foco e formato para este usuário" parada="3" resumo="o que mudou"]]
 *   [[perguntar pergunta="…" opcoes="A|B|C"]]   (só se a escolha mudar muito o resultado e os dados não derem pista)
 */
import type { Db } from '../db/db.ts';
import { clip, fold } from '../lib/util.ts';
import { SOURCES, type RoutineTemplate, type Trigger } from './routine-catalog.ts';
import { attrs } from './routine-proposals.ts';
import { localParts, parseWhen, scheduleText } from './routine-time.ts';

/** Palavras que não dizem nada sobre o trabalho (para achar os temas nos títulos). */
const STOP = new Set(('a o os as de da do das dos e em no na nos nas para pra por com sem um uma uns umas que se ao aos à às ' +
  'fazer ver revisar enviar mandar pedir verificar conferir criar novo nova sobre mais até cada todo toda todos todas').split(' '));

export interface Profile {
  facts: string;
  /** hora local em que o usuário costuma começar (pela primeira atividade de cada dia), se der para saber */
  startHour: number | null;
  /** dias da semana em que ele costuma trabalhar */
  weekdays: number[];
  themes: string[];
  connected: string[];
  /** quanto dá para saber: nada (instalação nova), pouco, bastante */
  richness: 'nada' | 'pouco' | 'bastante';
}

const q = (s: string, n = 120) => `"${clip(s.replace(/\s+/g, ' ').trim(), n)}"`;

/** O que o Ergon já sabe do usuário e do jeito de trabalhar dele (só dados deste workspace). */
export function studyUser(db: Db, workspaceId: string, userId: string, tz: string): Profile {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const user = db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', userId);
  const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', workspaceId);
  const integ = db.all<{ kind: string; account_label: string | null }>("SELECT kind, account_label FROM integrations WHERE workspace_id = ? AND state = 'connected'", workspaceId);
  const boards = db.all<{ name: string; origin: string; audience: string; open: number; done: number }>(
    `SELECT b.name, b.origin, b.audience, SUM(t.completed = 0 AND t.archived = 0) AS open, SUM(t.completed = 1) AS done
       FROM boards b LEFT JOIN tasks t ON t.board_id = b.id WHERE b.workspace_id = ? GROUP BY b.id ORDER BY open DESC LIMIT 8`, workspaceId);
  const tasks = db.all<{ title: string; created_at: string; origin: string; is_fixture: number }>(
    "SELECT title, created_at, origin, is_fixture FROM tasks WHERE workspace_id = ? AND created_at >= ? AND origin != 'demo' ORDER BY created_at DESC LIMIT 300", workspaceId, since);
  const msgs = db.all<{ content: string; created_at: string; agent: string }>(
    `SELECT m.content, m.created_at, a.name AS agent FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN agents a ON a.id = c.agent_id
      WHERE m.workspace_id = ? AND m.role = 'user' AND m.author_user_id = ? AND m.created_at >= ? ORDER BY m.created_at DESC LIMIT 200`, workspaceId, userId, since);
  const events = db.all<{ kind: string; n: number }>(
    'SELECT c.kind, COUNT(*) AS n FROM source_events e JOIN connections c ON c.id = e.connection_id WHERE e.workspace_id = ? AND e.received_at >= ? AND e.is_fixture = 0 GROUP BY c.kind', workspaceId, since);
  const rules = db.all<{ text: string }>("SELECT text FROM rules WHERE workspace_id = ? AND status = 'active' LIMIT 8", workspaceId);
  const custom = db.all<{ name: string; role: string }>("SELECT name, role FROM agents WHERE workspace_id = ? AND status = 'active' AND char_key IS NULL LIMIT 8", workspaceId);
  const routines = db.all<{ name: string; trigger: string }>("SELECT name, trigger FROM routines WHERE workspace_id = ? AND status IN ('active', 'paused')", workspaceId);

  // temas: palavras que mais aparecem nos títulos das tarefas e nos pedidos
  const freq = new Map<string, number>();
  for (const s of [...tasks.map((t) => t.title), ...msgs.map((m) => m.content)]) {
    for (const w of new Set(fold(s).replace(/[^a-z0-9à-ü ]/g, ' ').split(/\s+/))) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  const themes = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);

  // ritmo: hora da primeira atividade de cada dia (no fuso do usuário) e dias em que trabalha
  const firsts = new Map<string, number>(); const days = new Map<number, number>();
  for (const at of [...msgs.map((m) => m.created_at), ...tasks.filter((t) => t.origin === 'manual' || t.origin === 'chat').map((t) => t.created_at)]) {
    const p = localParts(tz, Date.parse(at)); const key = `${p.y}-${p.m}-${p.d}`; const h = p.hh + p.mm / 60;
    if (!firsts.has(key) || h < firsts.get(key)!) firsts.set(key, h);
    days.set(p.wd, (days.get(p.wd) ?? 0) + 1);
  }
  const hours = [...firsts.values()].sort((a, b) => a - b);
  const startHour = hours.length >= 3 ? hours[Math.floor(hours.length / 2)] : null;
  const weekdays = [...days].filter(([, n]) => n >= 2).map(([d]) => d).sort();
  const avgLen = msgs.length ? Math.round(msgs.reduce((s, m) => s + m.content.length, 0) / msgs.length) : 0;
  const byAgent = new Map<string, number>(); for (const m of msgs) byAgent.set(m.agent, (byAgent.get(m.agent) ?? 0) + 1);
  const label = (k: string) => ({ microsoft: 'Microsoft 365', google: 'Google', whatsapp: 'WhatsApp' } as Record<string, string>)[k] ?? k;
  const connected = integ.map((i) => label(i.kind));
  const richness = tasks.length + msgs.length >= 25 ? 'bastante' : tasks.length + msgs.length > 0 || integ.length ? 'pouco' : 'nada';

  const facts = [
    `[Quem] ${user?.display_name ?? 'usuário'} · workspace "${ws?.name ?? ''}"`,
    `[Contas conectadas] ${integ.length ? integ.map((i) => `${label(i.kind)}${i.account_label ? ` (${clip(i.account_label, 40)})` : ''}`).join(', ') : 'nenhuma ainda'}`,
    `[Quadros] ${boards.length ? boards.map((b) => `${q(b.name, 40)}${b.origin === 'mirror' ? ' (espelhado)' : ''}: ${Number(b.open ?? 0)} abertas, ${Number(b.done ?? 0)} feitas`).join('; ') : 'nenhum'}`,
    `[Tarefas em 60 dias] ${tasks.length}${tasks.length ? ` · origem: ${[...tasks.reduce((m, t) => m.set(t.origin, (m.get(t.origin) ?? 0) + 1), new Map<string, number>())].map(([o, n]) => `${o} ${n}`).join(', ')}` : ''}`,
    ...tasks.slice(0, 12).map((t) => `- ${q(t.title, 90)}`),
    `[Temas frequentes] ${themes.join(', ') || '(poucos dados)'}`,
    `[Ritmo] ${startHour !== null ? `costuma começar por volta das ${String(Math.floor(startHour)).padStart(2, '0')}:${String(Math.round((startHour % 1) * 60)).padStart(2, '0')}` : 'horário de início desconhecido'}; dias com atividade: ${weekdays.length ? weekdays.map((d) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d]).join(', ') : 'desconhecidos'}`,
    `[Como se comunica] ${msgs.length} pedidos aos agentes em 60 dias${msgs.length ? `, ${avgLen} caracteres em média; fala mais com: ${[...byAgent].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} (${n})`).join(', ')}` : ''}`,
    ...msgs.slice(0, 10).map((m) => `- ${q(m.content, 140)}`),
    `[Canais] ${events.length ? events.map((e) => `${label(e.kind)}: ${e.n} mensagens`).join(', ') : 'nenhuma mensagem recebida pelos canais'}`,
    rules.length ? `[Regras do workspace] ${rules.map((r) => q(r.text, 100)).join('; ')}` : '',
    custom.length ? `[Agentes criados pelo usuário] ${custom.map((a) => `${a.name} — ${a.role}`).join('; ')}` : '',
    routines.length ? `[Rotinas já ativas] ${routines.map((r) => `${r.name} (${scheduleText(JSON.parse(r.trigger) as Trigger)})`).join('; ')}` : '',
  ].filter(Boolean).join('\n');
  return { facts, startHour, weekdays, themes, connected, richness };
}

/** Um horário "antes de começar o dia": 15 min antes do início habitual, entre 06:00 e 11:00, em passos de 5 min. */
export function earlyTime(startHour: number | null, fallback: string): string {
  if (startHour === null) return fallback;
  const m = Math.max(6 * 60, Math.min(11 * 60, Math.round((startHour * 60 - 15) / 5) * 5));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface Adaptation { trigger?: Trigger; extra?: string; staleDays?: number; summary: string; noted: string }

/**
 * Sem conta de IA (ou se a coordenação não responder no formato): o melhor ajuste que dá para fazer com o que o
 * Ergon vê — horário antes do início do dia, foco nos temas que mais aparecem.
 */
export function heuristicAdaptation(t: RoutineTemplate, p: Profile, tz: string): Adaptation {
  const d = t.defaults!;
  const out: Adaptation = { summary: '', noted: '' };
  const notes: string[] = [];
  if (d.trigger.kind === 'schedule' && t.key === 'briefing-diario') {
    const time = earlyTime(p.startHour, d.trigger.time);
    const days = p.weekdays.some((x) => x === 0 || x === 6) && p.weekdays.length >= 6 ? [0, 1, 2, 3, 4, 5, 6] : d.trigger.days;
    out.trigger = { kind: 'schedule', days, time, tz };
    if (time !== d.trigger.time) notes.push(`chega às ${time}, um pouco antes de você costumar começar`);
    if (days.length === 7) notes.push('todos os dias, porque você também trabalha no fim de semana');
  }
  if (p.themes.length >= 3) {
    out.extra = `Dê prioridade ao que envolve: ${p.themes.slice(0, 5).join(', ')} (o que mais aparece no trabalho deste usuário).`;
    notes.push(`prioriza ${p.themes.slice(0, 3).join(', ')}`);
  }
  out.noted = p.richness === 'nada' ? 'Ainda não há muito o que ler sobre o seu jeito de trabalhar' : `Pelo que já está no Ergon${p.connected.length ? ` e nas contas conectadas (${p.connected.join(', ')})` : ''}`;
  out.summary = notes.length ? notes.join('; ') : 'começa no padrão e se ajusta conforme você usa';
  return out;
}

export interface SetupReply { config: (Adaptation & { name?: string }) | null; questions: Array<{ question: string; options: string[] }> }

/** Lê a resposta da coordenação no preparo. */
export function parseSetupReply(text: string | null, tz: string): SetupReply {
  const out: SetupReply = { config: null, questions: [] };
  for (const m of (text ?? '').matchAll(/\[\[\s*(configurar-rotina|perguntar)\b([\s\S]{0,3000}?)\]\]/gi)) {
    const a = attrs(m[2]);
    if (m[1].toLowerCase() === 'perguntar') {
      const options = (a.opcoes ?? '').split('|').map((o) => clip(o.trim(), 80)).filter(Boolean).slice(0, 4);
      if (a.pergunta && options.length >= 2 && out.questions.length < 2) out.questions.push({ question: clip(a.pergunta, 200), options });
    } else if (!out.config) {
      const stale = Number(a.parada);
      out.config = {
        trigger: a.quando ? parseWhen(a.quando, tz) : undefined,
        extra: a.ajuste ? clip(a.ajuste, 600) : undefined,
        staleDays: Number.isFinite(stale) && stale >= 1 && stale <= 60 ? Math.round(stale) : undefined,
        summary: clip(a.resumo ?? '', 200),
        name: a.nome ? clip(a.nome, 60) : undefined,
        noted: '',
      };
    }
  }
  return out;
}

/** O que a coordenação recebe como instrução no preparo (o modelo da biblioteca e as regras do jogo). */
export function setupChannel(t: RoutineTemplate, routineName: string, hint: string | null): string {
  const d = t.defaults!;
  const sched = d.trigger.kind === 'schedule' ? scheduleText({ ...d.trigger, tz: 'UTC' }) : 'quando o usuário pedir';
  return [
    `Canal: preparo da rotina "${routineName}" para este usuário, logo depois de ele ativar. Você estuda em silêncio o que já está registrado sobre ele e adapta a rotina ao caso dele, para ela funcionar bem de primeira sem ele configurar nada.`,
    `A rotina (modelo da biblioteca): ${t.benefit} Entrega: ${t.produces}`,
    `Trabalho padrão de quem executa:\n${d.config.instruction}`,
    `Fontes que ela olha: ${d.config.sources.map((s) => SOURCES[s].split(' (')[0].toLowerCase()).join('; ')}. Horário padrão: ${sched}.`,
    hint ? `O que o usuário disse ao ativar: ${hint}` : '',
    'Avalie com o que ele trabalha (temas, quadros, clientes), como trabalha (ritmo, horários, canais, equipe) e como se comunica (tamanho e tom das mensagens). Adapte o foco (o que priorizar e o que ignorar), o tom e o formato da entrega (do jeito que ele escreve), o horário (antes de ele começar) e, se fizer sentido, quantos dias sem movimento contam como tarefa parada.',
    'Escreva para o usuário 3 a 5 linhas, em tom de colega: o que você percebeu do jeito dele trabalhar e como a rotina vai funcionar para ele. Não repita os dados brutos nem cite nomes internos de sistemas.',
    'Depois, UMA linha exatamente assim (o "ajuste" é a instrução extra para quem executa, em 2 a 4 frases):',
    '[[configurar-rotina quando="seg a sex 07:45" ajuste="..." parada="3" resumo="uma frase do que muda em relação ao padrão"]]',
    'Só pergunte se uma escolha mudar muito o resultado e os dados não derem pista (no máximo 2 perguntas, cada uma com 2 a 4 opções curtas). Nesse caso NÃO escreva a configurar-rotina ainda; escreva só, uma por linha:',
    '[[perguntar pergunta="..." opcoes="opção A|opção B|opção C"]]',
    'Com poucos dados, não pergunte o que dá para decidir com bom senso: configure com o padrão e diga que a rotina vai se ajustando conforme o uso.',
    'Depois de pronta, se o usuário pedir mudanças nesta conversa, escreva de novo a configurar-rotina só com o que mudar.',
  ].filter(Boolean).join('\n');
}
