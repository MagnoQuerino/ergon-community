import { Ajv } from 'ajv';
import { clip, fold } from '../lib/util.ts';

/**
 * Interpretação estruturada de uma mensagem. Produzida pelo interpretador determinístico (regras)
 * ou, no futuro, por modelo; em ambos os casos validada por schema antes de qualquer efeito.
 * O interpretador nunca escreve no banco: só propõe. A política (decide) aplica permissões.
 */
export interface Interpretation {
  category: 'informacao' | 'ideia' | 'demanda' | 'resposta' | 'mudanca' | 'conclusao' | 'pergunta' | 'comando';
  evidence: string[];
  proposed_action: 'nenhuma' | 'criar_tarefa' | 'atualizar_tarefa' | 'concluir_tarefa' | 'listar_pendencias' | 'propor_regra' | 'esclarecer';
  candidate_subject: string | null;
  needs_clarification: boolean;
  explicit_intent: boolean;
  task_title: string | null;
  target_task_number: number | null;
  interpreter: 'regras' | 'modelo';
}

export const INTERPRETATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'evidence', 'proposed_action', 'candidate_subject', 'needs_clarification', 'explicit_intent', 'task_title', 'target_task_number', 'interpreter'],
  properties: {
    category: { enum: ['informacao', 'ideia', 'demanda', 'resposta', 'mudanca', 'conclusao', 'pergunta', 'comando'] },
    evidence: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
    proposed_action: { enum: ['nenhuma', 'criar_tarefa', 'atualizar_tarefa', 'concluir_tarefa', 'listar_pendencias', 'propor_regra', 'esclarecer'] },
    candidate_subject: { type: ['string', 'null'], maxLength: 120 },
    needs_clarification: { type: 'boolean' },
    explicit_intent: { type: 'boolean' },
    task_title: { type: ['string', 'null'], maxLength: 200 },
    target_task_number: { type: ['integer', 'null'], minimum: 1 },
    interpreter: { enum: ['regras', 'modelo'] },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateFn = ajv.compile(INTERPRETATION_SCHEMA);

/** Valida saída de interpretação (de qualquer origem). Inválida → null, nunca efeito parcial. */
export function validateInterpretation(x: unknown): Interpretation | null {
  return validateFn(x) ? (x as Interpretation) : null;
}

const RX = {
  cmdTask: /^\s*(?:\/tarefa|\/task)\s+(.{3,})$/is,
  createTask: /^\s*(?:por favor,?\s*)?(?:crie|criar|cria|abra|abrir|registre|registrar|adicione|adicionar)\s+(?:uma\s+|a\s+)?(?:nova\s+)?tarefa\s*(?:para|:|-|de)?\s*(.{3,})$/is,
  // "create a task to …", "please add a new task: …", "open a task for …"
  createTaskEn: /^\s*(?:please,?\s*)?(?:create|add|open|log|make|register)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:task|to-?do)\s*(?:to|for|:|-|about|called)?\s*(.{3,})$/is,
  newTask: /^\s*(?:nova\s+tarefa|tarefa|new\s+task|task)\s*:\s*(.{3,})$/is,
  pending: /^\s*\/?pendencias\s*$|^\s*\/pendencias\b|\b(?:quais\s+(?:sao\s+)?(?:as\s+)?pendencias|o\s+que\s+(?:esta|ta)\s+pendente|lista(?:r)?\s+(?:as\s+)?pendencias)/i,
  pendingEn: /^\s*\/?pending\s*$|\b(?:what(?:'s|\s+is|\s+are)\s+(?:still\s+)?(?:pending|open|outstanding)|(?:list|show)\s+(?:me\s+)?(?:the\s+|my\s+|all\s+)?(?:pending|open|outstanding)\s+(?:tasks|items)|what\s+do\s+i\s+(?:still\s+)?have\s+pending)\b/i,
  // "a partir de agora…", "from now on…", "whenever a client writes…" ("whenever you can" é "quando puder", não regra)
  ruleMarker: /\b(?:a\s+partir\s+de\s+agora|daqui\s+(?:pra|para)\s+frente|sempre\s+que|nunca\s+mais|regra\s*:|from\s+now\s+on|going\s+forward|from\s+here\s+on|whenever(?!\s+(?:you\s+can|possible|you\s+get\s+a\s+chance|you're\s+ready|you\s+have\s+time))|every\s+time\s+(?:that\s+)?(?:i|you|someone|a|an|the)\b|never\s+again|rule\s*:)/i,
  taskRef: /#(\d{1,6})\b/,
  // só verbo de nome: "renomeie / corrija o #12…", "mude / troque / altere o nome (ou o título) do card 12…". "mude o #12
  // para a Hipátia" ou "mova o card 12 para Em andamento" não é o nome: fica com o agente da conversa (ou a coordenação)
  rename: /\b(?:renomei[ae]|renomear|corrij[ae]|corrigir|(?:mud[ae]|mudar|troque|troca|trocar|alter[ae]|alterar)\s+(?:o\s+|a\s+)?(?:nome|titulo)\b).*?(?:#\s*|\b(?:card|cartao|tarefa)\s+(?:n[o.º°]?\s*)?#?)(\d{1,6})\b.*?\bpara\s+["“]?(.{3,}?)["”]?\s*$/is,
  // "rename #12 to …", "change the title of card 12 to …" ("move card 12 to In progress" não é o nome)
  renameEn: /\b(?:rename|retitle|(?:change|fix|correct|update)\s+(?:the\s+)?(?:name|title)\b).*?(?:#\s*|\b(?:card|task)\s+(?:no\.?\s*|number\s+)?#?)(\d{1,6})\b.*?\bto\s+["“]?(.{3,}?)["”]?\s*$/is,
  done: /\b(?:conclui|concluido|concluida|finalizei|finalizado|finalizada|terminei|esta\s+feito|ta\s+feito|feito|pronto)\b/i,
  // inglês: só quando a pessoa afirma a conclusão — "I finished #12", "we've completed #4", "#12 is done", "mark #12 as
  // done", "#12 done". "done" solto aparece em pedido de trabalho ("make sure #12 gets done", "when you're done with #11")
  doneEn: /\b(?:i|we)(?:'ve)?(?:\s+(?:have|just|already|now|finally))*\s+(?:finished|completed|done|wrapped\s+up)\b|\b(?:i'm|i\s+am|we're|we\s+are)\s+(?:all\s+)?(?:done|finished)\s+with\b|#\d{1,6}\s+(?:is|'s|has\s+been|was)\s+(?:now\s+|already\s+|all\s+)?(?:done|finished|complete|completed)\b|\b(?:mark|move)\s+(?:card\s+|task\s+)?#\d{1,6}\s+(?:as\s+|to\s+)?(?:done|complete|completed|finished)\b|^\s*(?:card\s+|task\s+)?#\d{1,6}\s+(?:done|finished|complete|completed)\s*[.!]*\s*$|^\s*(?:done|finished|completed)\s+(?:with\s+)?#\d{1,6}\s*[.!]*\s*$/i,
  // o que ainda vai ser feito, ou pede que seja: "#12 needs to be done", "make sure #12 gets done by Friday", "have you
  // finished #4"; em português, "o #12 precisa ser feito até sexta", "quando estiver pronto", "deixe o #12 pronto"
  doneNot: /\b(?:(?:needs?|has|have)\s+to\s+(?:be|get)|(?:must|should|will)\s+(?:be|get)|make\s+sure|ensure|get(?:s|ting)?\b[^.!?]{0,30}\bdone|when\s+(?:you're|you\s+are|it's|it\s+is|i'm|i\s+am)|once\s+(?:you're|you\s+are|it's|it\s+is)|have\s+you|did\s+you|has\s+(?:it|#)|precisa(?:m)?\s+(?:ser|estar|ficar)|tem\s+(?:que|de)\s+(?:ser|estar|ficar)|deve(?:m|ria)?\s+(?:ser|estar|ficar)|vai\s+(?:ser|estar|ficar)|(?:quando|depois\s+que|logo\s+que)\b[^.!?]{0,25}\b(?:estiver|ficar|for|terminar|terminarem)\b|assim\s+que|deix[ae]\w*\s+(?:o\s+|a\s+)?(?:#|card|tarefa)[^.!?]{0,20}\b(?:pronto|feito|concluido)|garant\w+|certifique)/i,
  demand: /\b(?:preciso|precisamos|precisa|pode(?:ria)?s?|consegue|favor|por\s+favor|solicito|gostaria\s+que|providenci\w*|envi(?:e|ar)|agend(?:e|ar)|revis(?:e|ar)|prepar(?:e|ar)|fa(?:ca|zer)|lembr(?:e|ar)\s+de|nao\s+esquec\w+|organiz(?:e|ar)|ajud(?:e|ar))\b/i,
  demandEn: /\b(?:i\s+need|we\s+need|(?:can|could|would)\s+you|please|i'd\s+like\s+(?:you\s+)?to|i\s+would\s+like\s+(?:you\s+)?to|make\s+sure|send|schedule|review|prepare|draft|remind\s+me|don't\s+forget|organi[sz]e|help\s+(?:me|us)|set\s+up|follow\s+up)\b/i,
  idea: /\b(?:e\s+se|ideia|poderiamos|talvez|que\s+tal|brainstorm|imagin\w+|what\s+if|idea|we\s+could|maybe|perhaps|how\s+about)\b/i,
  ack: /^(?:ok|okay|blz|beleza|obrigad[oa]|valeu|show|perfeito|certo|entendido|recebido|bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi|thanks|thank\s+you|thx|great|perfect|got\s+it|understood|noted|sure|cool|nice|good\s+morning|good\s+afternoon|good\s+evening|hi|hello|hey)[\s!.👍🙏]*$/i,
};
/** cumprimento no começo, que não entra no título ("Oi, …", "Hi, …") */
const SAUDACAO = /^(?:oi|ola|bom dia|boa tarde|boa noite|hi|hello|hey|good morning|good afternoon|good evening)[,!.\s]+/i;

function cleanTitle(s: string): string {
  return clip(s.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, ''), 200);
}

/** Interpretador determinístico (sem modelo). Rotulado como 'regras' em toda a interface. */
export function interpretRules(text: string): Interpretation {
  const raw = text.normalize('NFC').trim();
  const t = fold(raw).replace(/[’‘]/g, "'"); // mesmo comprimento que raw para texto NFC usual (títulos são recortados de raw)
  const base: Interpretation = {
    category: 'informacao', evidence: [], proposed_action: 'nenhuma', candidate_subject: null,
    needs_clarification: false, explicit_intent: false, task_title: null, target_task_number: null, interpreter: 'regras',
  };
  const ev = (s: string) => clip(s, 160);
  const offsetTitle = (m: RegExpMatchArray) => cleanTitle(raw.slice(raw.length - m[1].length));

  let m = t.match(RX.cmdTask) ?? t.match(RX.createTask) ?? t.match(RX.createTaskEn) ?? t.match(RX.newTask);
  if (m) {
    const title = offsetTitle(m);
    return { ...base, category: 'comando', proposed_action: 'criar_tarefa', explicit_intent: true, task_title: title, candidate_subject: clip(title, 120), evidence: [ev(raw)] };
  }
  if (RX.pending.test(t) || RX.pendingEn.test(t)) return { ...base, category: 'comando', proposed_action: 'listar_pendencias', explicit_intent: true, evidence: [ev(raw)] };

  m = t.match(RX.rename) ?? t.match(RX.renameEn);
  if (m) {
    const titleRaw = raw.slice(raw.length - m[2].length - (raw.trimEnd().match(/["”]$/) ? 1 : 0)).replace(/["“”]/g, '');
    return { ...base, category: 'mudanca', proposed_action: 'atualizar_tarefa', explicit_intent: true, target_task_number: Number(m[1]), task_title: cleanTitle(titleRaw), evidence: [ev(raw)] };
  }
  if (RX.ruleMarker.test(t)) return { ...base, category: 'mudanca', proposed_action: 'propor_regra', evidence: [ev(raw)], needs_clarification: true };

  const ref = t.match(RX.taskRef);
  // concluir o card na hora só quando a pessoa diz que concluiu: nunca em pergunta ("o #12 está pronto?", "is #12 done?")
  // nem no que ainda vai ser feito
  if (ref && (RX.done.test(t) || RX.doneEn.test(t)) && !/\?\s*$/.test(t) && !RX.doneNot.test(t)) {
    return { ...base, category: 'conclusao', proposed_action: 'concluir_tarefa', target_task_number: Number(ref[1]), explicit_intent: true, evidence: [ev(raw)] };
  }
  if (RX.ack.test(t) || t.length < 4) return { ...base, category: 'resposta', evidence: [ev(raw)] };

  const isQuestion = /\?\s*$/.test(t);
  if (RX.demand.test(t) || RX.demandEn.test(t)) {
    const title = cleanTitle(raw.replace(SAUDACAO, ''));
    // Pergunta com verbo de pedido ("pode me ajudar?") é demanda, mas pode precisar de esclarecimento.
    const short = tokensCount(t) < 4;
    return {
      ...base, category: 'demanda', proposed_action: short ? 'esclarecer' : 'criar_tarefa', needs_clarification: short,
      task_title: short ? null : title, candidate_subject: clip(title, 120), evidence: [ev(raw)], explicit_intent: false,
    };
  }
  if (RX.idea.test(t)) return { ...base, category: 'ideia', evidence: [ev(raw)] };
  if (isQuestion) return { ...base, category: 'pergunta', evidence: [ev(raw)] };
  return { ...base, evidence: [ev(raw)] };
}

function tokensCount(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 2).length;
}

export interface PolicyContext {
  profileCreates: 'demands' | 'explicit_only';
  /** quem fala pode comandar (proprietário autenticado, identidade externa autorizada) */
  canCommand: boolean;
  /** canal só observa (ex.: WhatsApp monitorado): demandas implícitas não viram tarefas */
  observeOnly: boolean;
  /** canal lido por escolha do usuário (filtros): pedidos identificados viram card para a equipe, sem dar poder de comando a quem escreveu */
  createsDemands?: boolean;
  /**
   * false (conversa com um agente): o pedido implícito não vira card por regras — o agente da conversa cuida dele
   * (faz, pede ajuda ou, se é o coordenador, planeja). Antes, virava card e a fila respondia de novo.
   */
  implicitDemands?: boolean;
}

export type Decision =
  | { kind: 'none'; reason: string }
  | { kind: 'create_task'; title: string; reason: string }
  | { kind: 'update_task'; number: number; title: string; reason: string }
  | { kind: 'complete_task'; number: number; reason: string; requiresConfirmation: boolean }
  | { kind: 'list_pending'; reason: string }
  | { kind: 'propose_rule'; text: string; reason: string }
  | { kind: 'clarify'; reason: string };

/** Política: permissões aplicadas pelo sistema, não pelo texto da mensagem nem pelo prompt. */
export function decide(i: Interpretation, ctx: PolicyContext, text: string): Decision {
  switch (i.proposed_action) {
    case 'criar_tarefa':
      if (!i.task_title) return { kind: 'clarify', reason: 'sem título' };
      if (i.explicit_intent) {
        if (!ctx.canCommand) return { kind: 'none', reason: 'comando de identidade sem permissão de comando' };
        return { kind: 'create_task', title: i.task_title, reason: 'pedido explícito' };
      }
      if (ctx.observeOnly) return { kind: 'none', reason: 'canal em observação: demanda registrada no log, sem tarefa automática' };
      if (ctx.implicitDemands === false) return { kind: 'none', reason: 'o agente da conversa cuida do pedido' };
      if (ctx.profileCreates === 'explicit_only') return { kind: 'clarify', reason: 'perfil não cria tarefa sem pedido explícito' };
      if (!ctx.canCommand && !ctx.createsDemands) return { kind: 'none', reason: 'origem sem permissão para criar tarefas' };
      return { kind: 'create_task', title: i.task_title, reason: ctx.canCommand ? 'demanda identificada pelo perfil central' : 'pedido identificado numa conversa lida (card para a triagem)' };
    case 'atualizar_tarefa':
      if (!ctx.canCommand || i.target_task_number === null || !i.task_title) return { kind: 'none', reason: 'sem permissão ou referência' };
      return { kind: 'update_task', number: i.target_task_number, title: i.task_title, reason: 'correção explícita de card' };
    case 'concluir_tarefa':
      if (i.target_task_number === null) return { kind: 'clarify', reason: 'sem referência' };
      return { kind: 'complete_task', number: i.target_task_number, reason: 'conclusão informada', requiresConfirmation: !ctx.canCommand || ctx.observeOnly };
    case 'listar_pendencias':
      return ctx.canCommand ? { kind: 'list_pending', reason: 'consulta explícita' } : { kind: 'none', reason: 'sem permissão' };
    case 'propor_regra':
      return ctx.canCommand ? { kind: 'propose_rule', text: clip(text.trim(), 500), reason: 'regra futura proposta (requer confirmação)' } : { kind: 'none', reason: 'sem permissão' };
    case 'esclarecer':
      if (ctx.implicitDemands === false) return { kind: 'none', reason: 'o agente da conversa pergunta o que falta' };
      return { kind: 'clarify', reason: 'mensagem ambígua' };
    default:
      return { kind: 'none', reason: `categoria ${i.category}: sem ação` };
  }
}
