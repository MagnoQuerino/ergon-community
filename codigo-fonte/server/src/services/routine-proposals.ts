/**
 * Rotinas propostas por conversa ou por recomendação. A coordenação não escreve código: compõe operações do Ergon
 * (fontes de coleta, condição, agente, entrega) numa linha de controle, e nada vale até o usuário aplicar.
 *   [[propor-rotina nome="…" quando="sexta 17h" agente="Hesíodo" fontes="tarefas.paradas,decisoes" condicao="sinal" instrucao="…"]]
 *   [[sugerir-rotina … mensagem="tom de colega" motivo="a evidência"]]   (recomendação semanal)
 *   [[ajustar-rotina rotina="Briefing Diário" quando="…" ajuste="o que muda"]]
 *   [[reapresentar-rotina id="apr_…"]]   (traz de volta uma recusada, sem refazer a análise)
 * Recusadas ficam guardadas (base de recusas): não voltam por conta própria.
 */
import type { Db } from '../db/db.ts';
import { clip, fold } from '../lib/util.ts';
import { CATALOG, SOURCES, isSource, templateByKey, type Condition, type Deliver, type SourceId, type Trigger } from './routine-catalog.ts';
import { DEFAULT_TZ, parseWhen, scheduleText, validTz } from './routine-time.ts';
import { getSetting } from './sectors.ts';

export interface RoutineSpec {
  name: string;
  /** modelo da biblioteca (as fontes, a instrução e a condição vêm dele) ou null para rotina criada na conversa */
  template: string | null;
  trigger: Trigger;
  agent: string;
  sources: SourceId[];
  condition: Condition;
  instruction: string;
  /** ajuste sobre o modelo ("ignore comunicações pessoais") */
  extra: string;
  deliver: Deliver[];
}

export type RoutineProposal =
  | { kind: 'routine'; origin: 'chat' | 'recommendation'; spec: RoutineSpec; pitch: string; reason: string; again?: boolean }
  | { kind: 'routine_edit'; routineId: string; routineName: string; changes: RoutineChanges; note: string };
export interface RoutineChanges { name?: string; trigger?: Trigger; extra?: string; sources?: SourceId[]; condition?: Condition }

export function workspaceTz(db: Db, workspaceId: string): string {
  const tz = getSetting(db, workspaceId, 'tz');
  return validTz(tz) ? tz : DEFAULT_TZ;
}

/** Atributos de uma linha de controle (aspas retas ou curvas; valores longos). */
export function attrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/([a-zA-Zçãõéêíóú-]+)\s*=\s*["“]([^"”]*)["”]/g)) out[fold(m[1])] = m[2].trim();
  return out;
}

const CONDITIONS: Condition[] = ['sempre', 'novidades', 'sinal'];
const sourcesOf = (s: string | undefined): SourceId[] =>
  [...new Set((s ?? '').split(/[,;]/).map((x) => fold(x).trim().replace(/\s+/g, '_')).filter(isSource))];
const deliverOf = (s: string | undefined): Deliver[] => {
  const d = (s ?? '').split(/[,;]/).map((x) => fold(x).trim()).filter((x): x is Deliver => x === 'conversa' || x === 'arquivo');
  return d.length ? [...new Set(d)] : ['conversa', 'arquivo'];
};

/** Monta (e valida) a rotina de uma proposta. Sem nome, ou sem modelo e sem instrução, não vira proposta. */
export function specFrom(a: Record<string, string>, tz: string): RoutineSpec | null {
  const t = a.modelo ? templateByKey(fold(a.modelo).trim().replace(/\s+/g, '-')) : undefined;
  const tpl = t?.available ? t : undefined;
  const d = tpl?.defaults;
  const name = clip((a.nome || tpl?.name || '').replace(/\s+/g, ' '), 60).trim();
  const instruction = clip(a.instrucao ?? '', 1500).trim();
  if (!name || (!d && instruction.length < 10)) return null;
  const sources = sourcesOf(a.fontes);
  const cond = fold(a.condicao ?? '') as Condition;
  return {
    name, template: tpl?.key ?? null,
    trigger: a.quando ? parseWhen(a.quando, tz) : d?.trigger.kind === 'schedule' ? { ...d.trigger, tz } : { kind: 'manual' },
    agent: clip(a.agente || d?.config.agent || 'coordenacao', 60),
    sources: sources.length ? sources : d?.config.sources ?? ['tarefas.andamento', 'decisoes'],
    condition: CONDITIONS.includes(cond) ? cond : d?.config.condition ?? 'sempre',
    // partindo de um modelo, o texto da proposta é um ajuste; numa rotina nova, é o próprio trabalho
    instruction: d ? d.config.instruction : instruction,
    extra: d ? clip(a.ajuste || instruction, 600) : '',
    deliver: deliverOf(a.entrega),
  };
}

const findRoutine = (db: Db, ws: string, name: string) => {
  const n = fold(name).trim();
  const all = db.all<{ id: string; name: string }>("SELECT id, name FROM routines WHERE workspace_id = ? AND status != 'archived' ORDER BY created_at", ws);
  return all.find((r) => fold(r.name) === n) ?? all.find((r) => fold(r.name).includes(n) || n.includes(fold(r.name)));
};

/**
 * Propostas de rotina numa resposta da coordenação (no máximo 3 novas, 3 ajustes). `origin` diz se veio de um
 * pedido na conversa ou da recomendação semanal.
 */
export function routineProposalsFrom(db: Db, workspaceId: string, text: string | null, origin: 'chat' | 'recommendation'): RoutineProposal[] {
  const tz = workspaceTz(db, workspaceId);
  const out: RoutineProposal[] = [];
  let made = 0; let edits = 0;
  for (const m of (text ?? '').matchAll(/\[\[\s*(propor-rotina|sugerir-rotina|ajustar-rotina|reapresentar-rotina)\b([\s\S]{0,4000}?)\]\]/gi)) {
    const kind = m[1].toLowerCase(); const a = attrs(m[2]);
    if ((kind === 'propor-rotina' || kind === 'sugerir-rotina') && made < 3) {
      const spec = specFrom(a, tz);
      if (!spec) continue;
      out.push({ kind: 'routine', origin: kind === 'sugerir-rotina' ? 'recommendation' : origin, spec, pitch: clip(a.mensagem ?? '', 700), reason: clip(a.motivo ?? '', 400) });
      made++;
    } else if (kind === 'ajustar-rotina' && edits < 3) {
      const r = a.rotina ? findRoutine(db, workspaceId, a.rotina) : undefined;
      if (!r) continue;
      const changes: RoutineChanges = {};
      if (a.nome) changes.name = clip(a.nome, 60);
      if (a.quando) changes.trigger = parseWhen(a.quando, tz);
      if (a.ajuste || a.instrucao) changes.extra = clip(a.ajuste || a.instrucao, 600);
      const s = sourcesOf(a.fontes); if (s.length) changes.sources = s;
      const c = fold(a.condicao ?? '') as Condition; if (CONDITIONS.includes(c)) changes.condition = c;
      if (!Object.keys(changes).length) continue;
      out.push({ kind: 'routine_edit', routineId: r.id, routineName: r.name, changes, note: clip(a.motivo ?? '', 300) });
      edits++;
    } else if (kind === 'reapresentar-rotina' && a.id && /^apr_[a-f0-9]{32}$/.test(a.id)) {
      const old = db.get<{ payload: string }>("SELECT payload FROM agent_proposals WHERE id = ? AND workspace_id = ? AND kind = 'routine' AND status = 'rejected'", a.id, workspaceId);
      if (old) out.push({ ...(JSON.parse(old.payload) as Extract<RoutineProposal, { kind: 'routine' }>), again: true });
    }
  }
  return out;
}

const agentName = (db: Db, ws: string, key: string): string =>
  db.get<{ name: string }>("SELECT name FROM agents WHERE workspace_id = ? AND status = 'active' AND (char_key = ? OR name = ?) LIMIT 1", ws, key, key)?.name ?? key;

const CONDITION_TEXT: Record<Condition, string> = { sempre: 'sempre analisa', novidades: 'só usa o modelo se algo mudou', sinal: 'só usa o modelo quando acha algo que pede atenção' };

/** Prévia em texto (o cartão de aprovação mostra isto). */
export function describeRoutineProposal(db: Db, workspaceId: string, p: RoutineProposal): string {
  if (p.kind === 'routine_edit') {
    const c = p.changes;
    const parts = [c.name && `nome "${c.name}"`, c.trigger && `quando: ${scheduleText(c.trigger)}`, c.sources && `olha: ${c.sources.map((s) => SOURCES[s].split(' (')[0].toLowerCase()).join('; ')}`,
      c.condition && CONDITION_TEXT[c.condition], c.extra && `ajuste: ${c.extra}`].filter(Boolean);
    return `Ajustar a rotina ${p.routineName} — ${parts.join(' · ')}`;
  }
  const s = p.spec; const tpl = s.template ? templateByKey(s.template) : undefined;
  const lines = [
    p.again ? 'De novo (recusada antes):' : '',
    p.pitch,
    `Rotina ${tpl ? `${tpl.name} (da biblioteca)` : 'nova'}: "${s.name}" · ${scheduleText(s.trigger)} · executa: ${agentName(db, workspaceId, s.agent)}`,
    `Olha: ${s.sources.map((x) => SOURCES[x].split(' (')[0].toLowerCase()).join('; ')} · ${CONDITION_TEXT[s.condition]} · entrega: ${s.deliver.map((d) => (d === 'conversa' ? 'na conversa' : 'em arquivo')).join(' e ')}`,
    tpl ? (s.extra ? `Ajuste: ${s.extra}` : '') : `Trabalho: ${clip(s.instruction, 300)}`,
    p.reason ? `Por quê: ${p.reason}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** O que a coordenação precisa saber para criar, ajustar e reapresentar rotinas (vai nas instruções dela). */
export function routineContextFor(db: Db, workspaceId: string): string {
  const mine = db.all<{ name: string; trigger: string; status: string }>("SELECT name, trigger, status FROM routines WHERE workspace_id = ? AND status != 'archived' ORDER BY created_at LIMIT 20", workspaceId);
  const refused = db.all<{ id: string; summary: string; decided_at: string }>(
    "SELECT id, summary, decided_at FROM agent_proposals WHERE workspace_id = ? AND kind = 'routine' AND status = 'rejected' ORDER BY decided_at DESC LIMIT 6", workspaceId);
  const ready = CATALOG.filter((t) => t.available);
  return [
    'Rotinas: trabalhos recorrentes que o Ergon executa sozinho (coleta os dados por código e chama um agente só para o que pede análise).',
    mine.length ? `Rotinas deste workspace: ${mine.map((r) => `${r.name} (${scheduleText(JSON.parse(r.trigger) as Trigger)}${r.status === 'paused' ? ', pausada' : ''})`).join('; ')}.` : 'Ainda não há rotinas ativas.',
    'Quando o usuário pedir uma rotina (ou mudar uma), mostre antes uma prévia curta: o que faz, quando, o que olha, quem executa e o que entrega. Depois escreva UMA linha de controle; nada vale até o usuário aplicar:',
    '[[propor-rotina nome="Nome curto" quando="seg a sex 08:00" agente="Nome do agente" fontes="id,id" condicao="sempre|novidades|sinal" entrega="conversa,arquivo" instrucao="o trabalho, em 2 a 5 frases"]]',
    `Para partir de um modelo pronto, acrescente modelo="chave" (e use instrucao só para o ajuste): ${ready.map((t) => `${t.key} (${t.name})`).join(', ')}.`,
    '[[ajustar-rotina rotina="Nome da rotina" quando="..." fontes="..." ajuste="o que muda no trabalho"]] (só o que mudar)',
    `Fontes permitidas (a coleta é do Ergon; você não cria operações novas nem executa código): ${Object.entries(SOURCES).map(([k, v]) => `${k} = ${v}`).join('; ')}.`,
    'condicao: sempre; novidades = só usa o modelo se algo mudou; sinal = só quando a coleta acha algo que pede atenção (economiza créditos).',
    'O que depende de e-mail, WhatsApp, documentos ou web ainda não pode virar rotina: diga que chega nas próximas fases.',
    refused.length ? `Sugestões de rotina recusadas (não proponha de novo por conta própria; se o usuário pedir uma delas de volta, escreva [[reapresentar-rotina id="..."]]):\n${refused.map((r) => `- ${r.id}: ${clip(r.summary.replace(/\s+/g, ' '), 160)} (recusada em ${r.decided_at.slice(0, 10)})`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}
