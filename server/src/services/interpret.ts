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
  newTask: /^\s*(?:nova\s+tarefa|tarefa)\s*:\s*(.{3,})$/is,
  pending: /^\s*\/?pendencias\s*$|^\s*\/pendencias\b|\b(?:quais\s+(?:sao\s+)?(?:as\s+)?pendencias|o\s+que\s+(?:esta|ta)\s+pendente|lista(?:r)?\s+(?:as\s+)?pendencias)/i,
  ruleMarker: /\b(?:a\s+partir\s+de\s+agora|daqui\s+(?:pra|para)\s+frente|sempre\s+que|nunca\s+mais|regra\s*:)/i,
  taskRef: /#(\d{1,6})\b/,
  rename: /\b(?:renomei[ea]|corrij[ea]|altere|mude|troque)\b.*?#(\d{1,6}).*?\bpara\s+["“]?(.{3,}?)["”]?\s*$/is,
  done: /\b(?:conclui|concluido|concluida|finalizei|finalizado|finalizada|terminei|esta\s+feito|ta\s+feito|feito|pronto)\b/i,
  demand: /\b(?:preciso|precisamos|precisa|pode(?:ria)?s?|consegue|favor|por\s+favor|solicito|gostaria\s+que|providenci\w*|envi(?:e|ar)|agend(?:e|ar)|revis(?:e|ar)|prepar(?:e|ar)|fa(?:ca|zer)|lembr(?:e|ar)\s+de|nao\s+esquec\w+|organiz(?:e|ar)|ajud(?:e|ar))\b/i,
  idea: /\b(?:e\s+se|ideia|poderiamos|talvez|que\s+tal|brainstorm|imagin\w+)\b/i,
  ack: /^(?:ok|okay|blz|beleza|obrigad[oa]|valeu|show|perfeito|certo|entendido|recebido|bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi)[\s!.👍🙏]*$/i,
};

function cleanTitle(s: string): string {
  return clip(s.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, ''), 200);
}

/** Interpretador determinístico (sem modelo). Rotulado como 'regras' em toda a interface. */
export function interpretRules(text: string): Interpretation {
  const raw = text.normalize('NFC').trim();
  const t = fold(raw); // mesmo comprimento que raw para texto NFC usual (títulos são recortados de raw)
  const base: Interpretation = {
    category: 'informacao', evidence: [], proposed_action: 'nenhuma', candidate_subject: null,
    needs_clarification: false, explicit_intent: false, task_title: null, target_task_number: null, interpreter: 'regras',
  };
  const ev = (s: string) => clip(s, 160);
  const offsetTitle = (m: RegExpMatchArray) => cleanTitle(raw.slice(raw.length - m[1].length));

  let m = t.match(RX.cmdTask) ?? t.match(RX.createTask) ?? t.match(RX.newTask);
  if (m) {
    const title = offsetTitle(m);
    return { ...base, category: 'comando', proposed_action: 'criar_tarefa', explicit_intent: true, task_title: title, candidate_subject: clip(title, 120), evidence: [ev(raw)] };
  }
  if (RX.pending.test(t)) return { ...base, category: 'comando', proposed_action: 'listar_pendencias', explicit_intent: true, evidence: [ev(raw)] };

  m = t.match(RX.rename);
  if (m) {
    const titleRaw = raw.slice(raw.length - m[2].length - (raw.trimEnd().match(/["”]$/) ? 1 : 0)).replace(/["“”]/g, '');
    return { ...base, category: 'mudanca', proposed_action: 'atualizar_tarefa', explicit_intent: true, target_task_number: Number(m[1]), task_title: cleanTitle(titleRaw), evidence: [ev(raw)] };
  }
  if (RX.ruleMarker.test(t)) return { ...base, category: 'mudanca', proposed_action: 'propor_regra', evidence: [ev(raw)], needs_clarification: true };

  const ref = t.match(RX.taskRef);
  if (ref && RX.done.test(t)) {
    return { ...base, category: 'conclusao', proposed_action: 'concluir_tarefa', target_task_number: Number(ref[1]), explicit_intent: true, evidence: [ev(raw)] };
  }
  if (RX.ack.test(t) || t.length < 4) return { ...base, category: 'resposta', evidence: [ev(raw)] };

  const isQuestion = /\?\s*$/.test(t);
  if (RX.demand.test(t)) {
    const title = cleanTitle(raw.replace(/^(?:oi|ola|bom dia|boa tarde|boa noite)[,!.\s]+/i, ''));
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
