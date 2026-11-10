/**
 * O título do card: curto e contextual ("E-mail de boas-vindas para a Ana", "Varredura de 1 semana do Teams e do
 * WhatsApp"), nunca a mensagem crua da pessoa quando ela é vaga — já houve um card chamado "?".
 *
 * De onde vem: o objetivo do plano da coordenação (padrão). Sem plano, um título tirado do contexto: o que o agente
 * pediu ao colega (primeira frase), se diz alguma coisa; a mensagem da pessoa; e, por fim, um provisório neutro
 * ("Pedido na conversa com Aristóteles"), que a coordenação pode trocar quando entende melhor (e a pessoa também).
 *
 * Quem renomeia sozinho: só a coordenação (pela linha [[titulo card="N" novo="…"]]) ou o sistema, e só em card da
 * equipe cujo título a pessoa não escolheu. Título que a pessoa escolheu (criou a tarefa, editou o nome, pediu
 * "renomeie o #12 para …") fica: title_source = 'pessoa'. Cada troca fica no histórico do card.
 */
import type { Db } from '../db/db.ts';
import { clip, fold, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { attrs } from './routine-proposals.ts';

/** De onde veio o título: escolhido pela pessoa, dado pela equipe (plano ou renomeação) ou provisório. */
export type TitleSource = 'pessoa' | 'equipe' | 'provisorio';

/** Palavras que não dizem do que se trata: confirmações, pedidos genéricos, pronomes e cumprimentos. */
const VAZIAS = new Set([
  'ok', 'okay', 'sim', 'nao', 'isso', 'isto', 'esse', 'essa', 'este', 'esta', 'aquilo', 'aquele', 'aquela', 'disso', 'nisso', 'dele', 'dela',
  'faz', 'faca', 'fazer', 'feito', 'pode', 'podes', 'manda', 'mande', 'ver', 'vai', 'bora', 'vamos', 'segue', 'siga', 'continua', 'continue',
  'beleza', 'blz', 'certo', 'show', 'perfeito', 'otimo', 'valeu', 'obrigado', 'obrigada', 'entao', 'agora', 'logo', 'rapido', 'ainda',
  'por', 'favor', 'pfv', 'pra', 'para', 'com', 'sem', 'que', 'mais', 'outro', 'outra', 'tudo', 'assim', 'mesmo', 'tambem', 'tbm', 'aqui', 'ali',
  'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tranquilo', 'resolve', 'resolva', 'cuida', 'cuide', 'tenta', 'tente', 'era', 'seria',
  'como', 'qual', 'quais', 'onde', 'quando', 'porque', 'pois', 'hein', 'entendi', 'entendido', 'combinado', 'fechado', 'pronto',
  'ser', 'tem', 'ter', 'vou', 'dos', 'das', 'nos', 'nas', 'uns', 'umas', 'voce', 'ele', 'ela', 'eles', 'elas', 'meu', 'minha', 'seu', 'sua',
  // pedidos de ajuda, de seguir ou de repetir, que não dizem sobre o quê ("me ajuda", "tenta de novo", "pode seguir")
  'mim', 'pro', 'pros', 'pras', 'quero', 'queria', 'ajuda', 'ajude', 'ajudar', 'consegue', 'consegues', 'conseguir', 'conseguiu', 'seguir',
  'pedi', 'pedir', 'fala', 'fale', 'falar', 'resto', 'toca', 'tocar', 'urgente', 'urgencia', 'novo', 'nova', 'novamente',
  'continuar', 'mandar', 'mandou', 'deu', 'cade', 'aprovado', 'aprovada', 'aprova', 'aprove', 'bala', 'novidade', 'novidades', 'alguma', 'algum',
  'algo', 'nada', 'coisa', 'coisas', 'negocio', 'olha', 'olhe', 'veja', 'fiz', 'fazendo', 'tentar', 'tentou', 'dai', 'daqui', 'sei', 'claro',
  'top', 'legal', 'massa', 'vlw', 'tmj', 'poderia', 'precisa', 'preciso', 'acabou', 'terminou', 'oque', 'porfavor',
  // o que já foi dito, de onde parou, refazer ("faz aquilo que te falei", "continua de onde parou", "refaça por favor")
  'falei', 'falou', 'falamos', 'disse', 'dito', 'combinamos', 'combinei', 'conversamos', 'parou', 'parei', 'parado', 'refaca', 'refaz',
  'refazer', 'refiz', 'repete', 'repita', 'repetir', 'aham', 'uhum', 'hum', 'hmm', 'sobre', 'antes', 'depois', 'ontem', 'hoje', 'amanha', 'fica',
  'ficou', 'ficar', 'termina', 'terminar', 'acabar', 'certinho', 'certeza', 'serio', 'espera', 'esperando', 'aguardo', 'aguardando', 'gente',
  // inglês: as mesmas confirmações, pedidos genéricos, pronomes e cumprimentos ("yes", "do it", "can you help?", "try again")
  'yes', 'yeah', 'yep', 'nope', 'this', 'that', 'these', 'those', 'the', 'and', 'but', 'its', 'it\'s', 'thing', 'things', 'stuff', 'something', 'anything', 'nothing',
  'please', 'pls', 'thanks', 'thank', 'thx', 'can', 'could', 'would', 'will', 'you', 'your', 'him', 'her', 'them', 'they', 'his', 'our', 'mine', 'for', 'with', 'without',
  'make', 'doing', 'did', 'does', 'done', 'just', 'now', 'right', 'away', 'asap', 'again', 'try', 'retry', 'help', 'need', 'want', 'wanted', 'let', 'lets', 'keep', 'going',
  'continue', 'carry', 'proceed', 'follow', 'what', 'which', 'where', 'when', 'why', 'how', 'who', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'great',
  'perfect', 'cool', 'nice', 'sure', 'okay', 'alright', 'fine', 'got', 'understood', 'agreed', 'deal', 'sounds', 'like', 'there', 'here', 'about', 'said', 'told',
  'talked', 'discussed', 'earlier', 'before', 'after', 'yesterday', 'today', 'tomorrow', 'stopped', 'left', 'off', 'redo', 'repeat', 'finish', 'wait', 'waiting',
  'any', 'some', 'all', 'rest', 'more', 'other', 'another', 'same', 'too', 'also', 'still', 'yet', 'urgent', 'quick', 'quickly', 'update', 'news', 'approved', 'approve',
]);

/**
 * Palavras que, sozinhas, também não dizem do que se trata ("Atender o pedido", "Resposta", "Qual o status?"), mas com
 * um número ou outra palavra de assunto dizem ("Status do pedido 4521", "Resposta da tarefa 88", "Resposta ao Pedro").
 */
const GENERICAS = new Set([
  'pedido', 'pedidos', 'status', 'andamento', 'situacao', 'retorno', 'resultado', 'entrega', 'entregar', 'tarefa', 'card', 'resposta', 'responder',
  'trabalho', 'atender', 'atendimento', 'demanda', 'usuario', 'pessoa', 'duvida', 'duvidas', 'pergunta', 'assunto', 'solicitacao',
  // inglês
  'request', 'requests', 'order', 'orders', 'progress', 'situation', 'result', 'results', 'delivery', 'deliver', 'task', 'tasks', 'answer', 'reply', 'respond',
  'response', 'work', 'job', 'user', 'question', 'questions', 'issue', 'topic', 'subject', 'ticket',
]);

/**
 * Quantas palavras dizem do que se trata: as de assunto e, quando há alguma (ou um número que identifica), também as
 * genéricas e o número. 0: nada ("?", "ok", "faz isso", "Atender o pedido").
 */
export function subjectWords(s: string | null | undefined): number {
  const words = fold(s ?? '').split(/[^a-z0-9]+/).filter(Boolean);
  const especificas = words.filter((w) => w.length > 2 && !/^\d+$/.test(w) && !VAZIAS.has(w) && !GENERICAS.has(w)).length;
  const genericas = words.filter((w) => GENERICAS.has(w)).length;
  // número que identifica: 3 dígitos ou mais ("4521") ou junto de uma genérica ("tarefa 88"); "1" sozinho não
  const numero = words.some((w) => /^\d+$/.test(w) && (w.length >= 3 || genericas > 0));
  if (!especificas && !numero) return 0;
  return especificas + genericas + (numero ? 1 : 0);
}

/**
 * Título vago: não sobra nenhuma palavra que diga do que se trata ("?", "ok", "faz isso", "me ajuda", "tenta de
 * novo", "Atender o pedido"), ou é uma pergunta curta com no máximo uma palavra de assunto ("consegue?", "e o resto?").
 */
export function vagueTitle(s: string | null | undefined): boolean {
  const raw = (s ?? '').trim();
  const n = subjectWords(raw);
  if (!n) return true;
  return /\?\s*$/.test(raw) && fold(raw).split(/[^a-z0-9]+/).filter(Boolean).length <= 3 && n <= 1;
}

/** A primeira frase (o pedido ao colega costuma vir com detalhes depois): "Levantar preços. Depois…" → "Levantar preços". */
const firstSentence = (s: string): string => s.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? s;

/** Uma linha, até max caracteres, cortada em palavra (com "…" quando corta), sem pontuação solta no fim. */
export function cutTitle(text: string, max = 90): string {
  const line = text.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]/g, ' ').replace(/\[imagem: [^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(?:oi|ola|olá|bom dia|boa tarde|boa noite|hi|hello|hey|good morning|good afternoon|good evening)[,!.\s]+/i, '');
  const short = line.length <= max ? line : (() => {
    const space = line[max] === ' ' ? max : line.lastIndexOf(' ', max);
    return `${(space >= max / 2 ? line.slice(0, space) : line.slice(0, max)).replace(/[\s,;:.!?…–—-]+$/, '')}…`;
  })();
  return short.replace(/[\s,;:.!]+$/, '');
}

/** O provisório neutro, tirado da conversa: a coordenação troca ao planejar. */
export const provisionalTitle = (agentName: string | null | undefined): string => `Pedido na conversa com ${agentName || 'a equipe'}`;

/**
 * O título de um card que nasce na conversa: o objetivo do plano, se diz alguma coisa; senão o primeiro candidato com
 * assunto (o que o agente pediu ao colega, a mensagem da pessoa); nenhum, o provisório. source: 'equipe' quando veio do plano.
 */
export function cardTitle(opts: { plan?: string | null; candidates?: Array<string | null | undefined>; agentName?: string | null }): { title: string; source: TitleSource } {
  if (opts.plan && !vagueTitle(opts.plan)) return { title: cutTitle(opts.plan, 200), source: 'equipe' };
  // sem plano, o texto da conversa só vira título com pelo menos duas palavras de assunto: "faz isso pra mim",
  // "refaça por favor" ou só "Orçamento" não dizem o bastante (vai o próximo candidato ou o provisório)
  for (const c of opts.candidates ?? []) {
    const one = c ? cutTitle(firstSentence(c), 90) : '';
    if (one && !vagueTitle(one) && subjectWords(one) >= 2) return { title: one, source: 'provisorio' };
  }
  return { title: provisionalTitle(opts.agentName), source: 'provisorio' };
}

export interface Rename { number: number; title: string }

/**
 * [[titulo card="12" novo="Título curto e contextual"]] na resposta da coordenação (também [[renomear-card numero="12"
 * titulo="…"]], card=12 sem aspas e o título entre aspas solto). Até 10 por resposta.
 */
export function parseRenames(text: string | null | undefined): Rename[] {
  const out: Rename[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*(?:titulo|título|renomear-card)\b((?:[^\]]|\](?!\]))*)\]\]/gi)) {
    const body = m[1];
    const a = attrs(body);
    const n = Number((a.card ?? a.numero ?? body.match(/(?:card|numero|número)\s*=\s*#?(\d{1,6})\b/i)?.[1] ?? body.match(/#(\d{1,6})\b/)?.[1] ?? '').replace(/^#/, ''));
    const loose = body.replace(/[a-zA-Zçãõéêíóú-]+\s*=\s*["“][^"”]*["”]/g, ' ').match(/["“]([^"”]{2,200})["”]/)?.[1];
    const title = (a.novo ?? a.titulo ?? a.para ?? a.nome ?? loose ?? '').replace(/\s+/g, ' ').trim();
    if (Number.isInteger(n) && n > 0 && title && !out.some((r) => r.number === n)) out.push({ number: n, title: clip(title, 200) });
    if (out.length >= 10) break;
  }
  return out;
}

export type RenameResult = 'renomeado' | 'igual' | 'pessoa' | 'vago' | 'fora';

/**
 * Card de antes da marca (title_source NULL): a pessoa trocou o título? A migração 0039 só lê o histórico em claro;
 * com a proteção por campo ligada, o registro está cifrado e só aqui (com a chave aberta) dá para ler. Aprovar,
 * devolver, concluir ou mudar o prazo não contam: só a mudança do título.
 */
function renamedByPerson(db: Db, taskId: string): boolean {
  return db.all<{ evidence: string | null }>(
    "SELECT evidence FROM audit_events WHERE target_type = 'task' AND target_id = ? AND actor_type = 'user' AND action = 'task.update'", taskId)
    .some((e) => { try { const x = JSON.parse(e.evidence ?? 'null') as Record<string, unknown> | null; return !!x && typeof x === 'object' && 'titulo' in x; } catch { return false; } });
}

/**
 * A coordenação (ou o sistema) troca o título de um card da equipe. Não troca: título escolhido pela pessoa, card fora
 * do quadro da equipe (as suas tarefas, um quadro de outro aplicativo), cancelado, concluído ou título vago.
 */
export function renameCard(db: Db, bus: Bus | null, workspaceId: string, by: { agentId: string | null; name: string }, number: number, wanted: string): { result: RenameResult; taskId?: string; from?: string; to?: string } {
  const t = db.get<{ id: string; title: string; title_source: string | null; archived: number; completed: number; audience: string; origin: string }>(
    `SELECT t.id, t.title, t.title_source, t.archived, t.completed, b.audience, b.origin FROM tasks t JOIN boards b ON b.id = t.board_id
      WHERE t.workspace_id = ? AND t.number = ?`, workspaceId, number);
  if (!t || Number(t.archived) || Number(t.completed) || t.audience !== 'team' || t.origin !== 'native') return { result: 'fora' };
  // o mesmo nome que já está (a coordenação repetiu o que a pessoa acabou de dar): nada a fazer nem a registrar
  if (cutTitle(wanted, 200) === t.title) return { result: 'igual', taskId: t.id };
  if (t.title_source === 'pessoa' || (t.title_source === null && renamedByPerson(db, t.id))) {
    if (t.title_source === null) db.run("UPDATE tasks SET title_source = 'pessoa' WHERE id = ?", t.id);
    return { result: 'pessoa', taskId: t.id };
  }
  const to = cutTitle(wanted, 200);
  if (!to || vagueTitle(to)) return { result: 'vago', taskId: t.id };
  if (to === t.title) return { result: 'igual', taskId: t.id };
  db.tx(() => {
    db.run("UPDATE tasks SET title = ?, title_source = 'equipe', revision = revision + 1, updated_at = ? WHERE id = ?", db.seal(workspaceId, to), now(), t.id);
    audit(db, null, { workspaceId, actorType: by.agentId ? 'agent' : 'system', actorId: by.agentId ?? 'ergon', action: 'task.title', targetType: 'task', targetId: t.id,
      evidence: { de: t.title, para: to, por: by.name }, result: `título alterado de “${t.title}” para “${to}” (${by.name})` });
  });
  bus?.publish(workspaceId, 'tasks.changed', { id: t.id });
  return { result: 'renomeado', taskId: t.id, from: t.title, to };
}
