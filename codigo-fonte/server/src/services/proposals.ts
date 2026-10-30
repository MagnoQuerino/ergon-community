/**
 * Propostas da coordenação: reorganizar a equipe conversando. O coordenador (ou a própria frase do usuário,
 * por regras) propõe mudar alguém de setor ou criar um agente; nada muda até o usuário aplicar.
 * Formato que o modelo usa (instruções em runs.ts, PROPOSAL_HELP):
 *   [[mover agente="Fídias" setor="Comunicação"]]
 *   [[novo-agente nome="Temístocles" papel="Vendas e propostas comerciais" setor="automático"]]
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { archiveAgent, createAgent, reactivateAgent, updateAgent, type AgentLimits } from './capacity.ts';
import { FIXED_MSG } from './team.ts';
import { TOOLS } from './characters.ts';
import { attrs, describeRoutineProposal, type RoutineProposal } from './routine-proposals.ts';
import { createSector, moveToSector, sectorByName, updateSector } from './sectors.ts';
import { createTask, defaultBoard, userBoard } from './tasks.ts';

export type Proposal =
  | { kind: 'sector'; agent: string; sector: string }
  | { kind: 'create_agent'; name: string; role: string; sector: string }
  | { kind: 'tools'; agent: string; tool: string; action: 'dar' | 'tirar' }
  /** um agente precisa de uma ferramenta que executa código: só vale com a senha do usuário */
  | { kind: 'permission'; agent: string; tool: string; reason: string; origin?: string }
  /** pedido de ligar uma ferramenta protegida feito a outro agente: passou à coordenação (a senha é pedida lá) */
  | { kind: 'handoff'; coordinatorId: string; coordinator: string; conversationId: string; agent: string; tool: string }
  /** criar ou ajustar uma rotina (pela conversa com a coordenação ou pela recomendação semanal) */
  | RoutineProposal
  /** pergunta com opções que o agente faz na conversa; a resposta volta como mensagem do usuário */
  | { kind: 'question'; question: string; options: string[] }
  /** personalização completa: qualquer agente (nome, função, setor, instruções, métodos, bio) */
  | { kind: 'edit_agent'; agent: string; changes: { name?: string; role?: string; sector?: string; charter?: string; skills?: string[]; bio?: string } }
  | { kind: 'deactivate_agent'; agent: string; reason: string }
  | { kind: 'reactivate_agent'; agent: string }
  | { kind: 'sector_edit'; sector: string; changes: { name?: string; description?: string; instructions?: string } }
  | { kind: 'sector_new'; name: string; description: string }
  /** tarefa proposta por uma rotina (planejador, secretário, radar de compromissos…): só entra no quadro aprovada */
  | { kind: 'task'; title: string; detail: string; assignee: string | null; due: string | null; origin: string; routine: string }
  /** lançamentos lidos dos documentos pelo Ergon e classificados pelo agente: só ficam registrados aprovados */
  | { kind: 'ledger'; routine: string; items: LedgerItem[] }
  /** tirar um card do quadro da equipe: o coordenador propõe (ou você pede na conversa); só sai com a sua aprovação */
  | { kind: 'delete_task'; number: number; reason: string };

export interface LedgerItem { n: number; data: string; descricao: string; valor: number; documento: string; categoria: string; centro: string; confianca: string }

/** De onde veio a tarefa proposta: uma rotina ou uma conversa (lembrete com data pedido a um agente). */
const byWho = (src: string) => (src.startsWith('conversa com ') ? `na ${src}` : `pela rotina ${src}`);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * [[propor-tarefa titulo="..." responsavel="Nome ou você" prazo="AAAA-MM-DD" detalhe="..." origem="E3"]] na resposta de
 * uma rotina (no máximo 12). O título é obrigatório; prazo fora do formato é descartado (a tarefa fica sem prazo).
 */
export function parseTaskProposals(text: string | null, routine: string): Proposal[] {
  const out: Proposal[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*propor-tarefa\b([^\]]{0,1500})\]\]/gi)) {
    const a = attrs(m[1]);
    const title = clip((a.titulo ?? '').replace(/\s+/g, ' ').trim(), 200);
    if (!title) continue;
    const who = (a.responsavel ?? '').trim();
    const due = (a.prazo ?? '').trim();
    out.push({ kind: 'task', title, detail: clip(a.detalhe ?? '', 1500), assignee: who && !/^(voc[eê]|eu|usu[aá]rio|-)$/i.test(who) ? clip(who, 60) : null,
      due: ISO_DAY.test(due) && !Number.isNaN(Date.parse(`${due}T12:00:00Z`)) ? due : null, origin: clip(a.origem ?? '', 80), routine: clip(routine, 60) });
    if (out.length >= 12) break;
  }
  return out;
}

/** [[categoria lancamento="L3" categoria="Fornecedores" centro="Laboratório"]] (a classificação que o agente sugere). */
export function parseCategories(text: string | null): Map<number, { categoria: string; centro: string }> {
  const out = new Map<number, { categoria: string; centro: string }>();
  for (const m of (text ?? '').matchAll(/\[\[\s*categoria\b([^\]]{0,400})\]\]/gi)) {
    const a = attrs(m[1]); const n = Number((a.lancamento ?? '').replace(/^L/i, ''));
    if (Number.isInteger(n) && n > 0 && a.categoria) out.set(n, { categoria: clip(a.categoria, 60), centro: clip(a.centro ?? '', 60) });
    if (out.size >= 3000) break;
  }
  return out;
}

/** [[pedir-permissao ferramenta="terminal" motivo="..."]] na resposta de qualquer agente (um por resposta). */
export function parsePermissionRequests(text: string | null, agent: string): Proposal[] {
  for (const m of (text ?? '').matchAll(/\[\[\s*pedir-permissao\b([^\]]{0,600})\]\]/gi)) {
    const tool = toolId(attr(m[1], 'ferramenta') ?? '');
    if (!tool || !TOOLS[tool]?.guarded) continue;
    const reason = (m[1].match(/motivo\s*=\s*["“]([^"”]{3,400})["”]/i)?.[1] ?? '').trim();
    return [{ kind: 'permission', agent, tool, reason: reason || 'executar o seu pedido' }];
  }
  return [];
}

/** [[liberar-ferramenta ferramenta="terminal" agente="Nome" motivo="..."]] (um por resposta); agente vazio = a equipe. */
export function parseToolRelease(text: string | null): { tool: string; agent: string; reason: string } | null {
  for (const m of (text ?? '').matchAll(/\[\[\s*liberar-ferramenta\b([^\]]{0,600})\]\]/gi)) {
    const tool = toolId(attr(m[1], 'ferramenta') ?? '');
    if (!tool || !TOOLS[tool]?.guarded) continue;
    const who = (attr(m[1], 'agente') ?? '').trim();
    const reason = (m[1].match(/motivo\s*=\s*["“]([^"”]{3,400})["”]/i)?.[1] ?? '').trim();
    return { tool, agent: /^(a\s+)?equipe$|^todos$|^-$/i.test(who) ? '' : clip(who, 60), reason: reason || 'pedido seu na conversa' };
  }
  return null;
}

const attr = (s: string, k: string): string | null => {
  const m = s.match(new RegExp(`${k}\\s*=\\s*["“]([^"”]{1,120})["”]`, 'i'));
  return m ? m[1].trim() : null;
};

/**
 * Propostas escritas pelo coordenador na resposta (até 15: dá para refazer a equipe inteira de uma vez, por
 * exemplo trocar tudo para outro tema).
 */
export function parseProposals(text: string | null): Proposal[] {
  const out: Proposal[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*(editar-agente|desativar-agente|reativar-agente|editar-setor|novo-setor)\b([\s\S]{0,4000}?)\]\]/gi)) {
    const kind = m[1].toLowerCase(); const a = attrs(m[2]);
    if (kind === 'editar-agente' && a.agente) {
      const c: Extract<Proposal, { kind: 'edit_agent' }>['changes'] = {};
      if (a.nome) c.name = clip(a.nome, 40);
      if (a.papel || a.funcao) c.role = clip(a.papel || a.funcao, 80);
      if (a.setor) c.sector = clip(a.setor, 60);
      if (a.instrucoes) c.charter = clip(a.instrucoes, 4000);
      if (a.metodos) c.skills = a.metodos.split(/[;|]/).map((x) => clip(x.trim(), 80)).filter(Boolean).slice(0, 12);
      if (a.bio) c.bio = clip(a.bio, 600);
      if (Object.keys(c).length) out.push({ kind: 'edit_agent', agent: a.agente, changes: c });
    } else if (kind === 'desativar-agente' && a.agente) out.push({ kind: 'deactivate_agent', agent: a.agente, reason: clip(a.motivo ?? '', 200) });
    else if (kind === 'reativar-agente' && a.agente) out.push({ kind: 'reactivate_agent', agent: a.agente });
    else if (kind === 'editar-setor' && a.setor) {
      const c: Extract<Proposal, { kind: 'sector_edit' }>['changes'] = {};
      if (a.nome) c.name = clip(a.nome, 60);
      if (a.descricao) c.description = clip(a.descricao, 300);
      if (a.instrucoes) c.instructions = clip(a.instrucoes, 2000);
      if (Object.keys(c).length) out.push({ kind: 'sector_edit', sector: a.setor, changes: c });
    } else if (kind === 'novo-setor' && a.nome) out.push({ kind: 'sector_new', name: clip(a.nome, 60), description: clip(a.descricao ?? '', 300) });
    if (out.length >= 15) return out;
  }
  // cancelar um card (o nome antigo, apagar-card, continua valendo)
  for (const m of (text ?? '').matchAll(/\[\[\s*(?:cancelar|apagar)-card\b([^\]]{0,600})\]\]/gi)) {
    const a = attrs(m[1]); const n = Number((a.numero ?? a.card ?? '').replace(/^#/, ''));
    if (Number.isInteger(n) && n > 0) out.push({ kind: 'delete_task', number: n, reason: clip(a.motivo ?? '', 200) });
    if (out.length >= 15) return out;
  }
  for (const m of (text ?? '').matchAll(/\[\[\s*(mover|novo-agente|ferramenta)\b([^\]]{0,400})\]\]/gi)) {
    const kind = m[1].toLowerCase(); const body = m[2];
    if (kind === 'ferramenta') {
      const agent = attr(body, 'agente'); const tool = attr(body, 'ferramenta'); const action = fold(attr(body, 'acao') ?? 'dar');
      const id = tool ? toolId(tool) : null;
      const give = !action.startsWith('tir');
      // liberar ferramenta que executa código nunca é um clique: vira pedido de permissão (com a senha), como
      // quando o próprio agente pede; tirar continua simples
      if (agent && id && give && TOOLS[id]?.guarded) out.push({ kind: 'permission', agent, tool: id, reason: 'a coordenação propôs liberar' });
      else if (agent && id) out.push({ kind: 'tools', agent, tool: id, action: give ? 'dar' : 'tirar' });
    } else if (kind === 'mover') {
      const agent = attr(body, 'agente'); const sector = attr(body, 'setor');
      if (agent && sector) out.push({ kind: 'sector', agent, sector });
    } else {
      const name = attr(body, 'nome'); const role = attr(body, 'papel'); const sector = attr(body, 'setor') ?? 'automático';
      if (name && role) out.push({ kind: 'create_agent', name, role, sector });
    }
    if (out.length >= 15) break;
  }
  return out;
}

/** Frase do usuário para a coordenação, por regras: "mova a Fídias para o setor de comunicação". */
export function parseChatCommand(text: string): Proposal | null {
  const t = text.trim();
  const mv = t.match(/^(?:por favor,?\s*)?(?:mova|mover|mude|mudar|transfira|transferir|passe|passar|coloque|colocar)\s+(?:o\s+|a\s+)?(.{2,40}?)\s+(?:para|pro|pra)\s+(?:o\s+|a\s+)?(?:setor\s+(?:de\s+|da\s+|do\s+)?)?(.{3,60}?)[.!]?$/i);
  if (mv) return { kind: 'sector', agent: mv[1].trim(), sector: mv[2].trim() };
  const rn = t.match(/^(?:por favor,?\s*)?(?:renomeie|renomear|mude o nome d[oae]s?|troque o nome d[oae]s?)\s+(?:o\s+|a\s+)?(.{2,40}?)\s+(?:para|pra)\s+["“]?([^"”.!]{2,40})["”]?[.!]?$/i);
  if (rn) return { kind: 'edit_agent', agent: rn[1].trim(), changes: { name: rn[2].trim() } };
  const nw = t.match(/^(?:por favor,?\s*)?(?:crie|criar|contrate|contratar|adicione|adicionar)\s+(?:um\s+|uma\s+)?(?:novo\s+|nova\s+)?agente\s+(?:chamad[oa]\s+)?["“]?([^"”,—–-]{2,40}?)["”]?\s*(?:,|—|–|-|para|como|que\s+cuide\s+de)\s*(.{3,80}?)[.!]?$/i);
  if (nw) return { kind: 'create_agent', name: nw[1].trim(), role: nw[2].trim(), sector: 'automático' };
  // "cancele / pare / apague o card 12" ("para o card 12…" fica de fora: começa muita frase que não é ordem)
  const del = t.match(/^(?:por favor,?\s*)?(?:cancele|cancela|cancelar|pare|parar|interrompa|interromper|apague|apagar|exclua|excluir|delete|deletar|remova|remover)\s+(?:o\s+|a\s+)?(?:card|tarefa|cart[aã]o)\s*(?:n[º°o.]?\s*)?#?(\d{1,6})\b(?:\s*[,.:;—–-]?\s*(?:porque|pois|motivo:?)?\s*(.{0,200}))?$/i);
  if (del) return { kind: 'delete_task', number: Number(del[1]), reason: clip((del[2] ?? '').replace(/[.!]$/, '').trim(), 200) };
  return null;
}

/** "web", "Pesquisa na web" → id do catálogo. */
function toolId(s: string): string | null {
  const n = fold(s).trim();
  if (TOOLS[n]) return n;
  return Object.values(TOOLS).find((t) => fold(t.label) === n || fold(t.label).includes(n))?.id ?? null;
}

function findAgent(db: Db, workspaceId: string, name: string): { id: string; name: string } | undefined {
  const n = fold(name).replace(/^(o|a)\s+/, '');
  const all = db.all<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active'", workspaceId);
  return all.find((a) => fold(a.name) === n) ?? all.find((a) => fold(a.name).startsWith(n) || n.startsWith(fold(a.name)));
}

const findAny = (db: Db, workspaceId: string, name: string, status: 'active' | 'archived') => {
  const n = fold(name).replace(/^(o|a)\s+/, '');
  const all = db.all<{ id: string; name: string }>('SELECT id, name FROM agents WHERE workspace_id = ? AND status = ?', workspaceId, status);
  return all.find((a) => fold(a.name) === n) ?? all.find((a) => fold(a.name).startsWith(n) || n.startsWith(fold(a.name)));
};

function describe(db: Db, workspaceId: string, p: Proposal): string {
  if (p.kind === 'edit_agent') {
    const c = p.changes; const who = findAgent(db, workspaceId, p.agent)?.name ?? p.agent;
    const parts = [c.name && `nome → ${c.name}`, c.role && `função → ${c.role}`, c.sector && `setor → ${sectorByName(db, workspaceId, c.sector)?.name ?? c.sector}`,
      c.charter && 'instruções novas', c.skills && `métodos: ${c.skills.join('; ')}`, c.bio && 'bio nova'].filter(Boolean);
    return `Mudar ${who}: ${parts.join(' · ')}${c.charter ? `\nInstruções: ${clip(c.charter, 400)}` : ''}`;
  }
  if (p.kind === 'deactivate_agent') return `Desativar ${findAgent(db, workspaceId, p.agent)?.name ?? p.agent}${p.reason ? `: ${p.reason}` : ''} (as tarefas abertas passam a colegas)`;
  if (p.kind === 'reactivate_agent') return `Reativar ${findAny(db, workspaceId, p.agent, 'archived')?.name ?? p.agent}`;
  if (p.kind === 'sector_edit') {
    const s = sectorByName(db, workspaceId, p.sector);
    return `Mudar o setor ${s?.name ?? p.sector}: ${[p.changes.name && `nome → ${p.changes.name}`, p.changes.description && `descrição: ${p.changes.description}`, p.changes.instructions && 'instruções novas'].filter(Boolean).join(' · ')}`;
  }
  if (p.kind === 'sector_new') return `Criar o setor ${p.name}${p.description ? `: ${p.description}` : ''}`;
  if (p.kind === 'routine' || p.kind === 'routine_edit') return describeRoutineProposal(db, workspaceId, p);
  if (p.kind === 'question') return p.question;
  if (p.kind === 'delete_task') {
    const t = db.get<{ title: string }>('SELECT title FROM tasks WHERE workspace_id = ? AND number = ?', workspaceId, p.number);
    return `Cancelar o card #${p.number}${t ? ` “${clip(t.title, 90)}”` : ''}${p.reason ? `: ${p.reason}` : ''} (o trabalho para e o card sai do quadro; o histórico fica)`;
  }
  if (p.kind === 'task') {
    const who = p.assignee ? findAgent(db, workspaceId, p.assignee)?.name ?? p.assignee : null;
    return `Criar a tarefa "${p.title}"${who ? ` para ${who}` : ' (sua)'}${p.due ? `, prazo ${p.due.slice(8, 10)}/${p.due.slice(5, 7)}` : ''} — proposta ${byWho(p.routine)}${p.origin ? ` (de ${p.origin})` : ''}${p.detail ? `\n${clip(p.detail, 300)}` : ''}`;
  }
  if (p.kind === 'ledger') {
    const ent = p.items.filter((i) => i.valor > 0).reduce((x, i) => x + i.valor, 0); const sai = p.items.filter((i) => i.valor < 0).reduce((x, i) => x + i.valor, 0);
    const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return `Registrar ${p.items.length} lançamento(s) lidos pela rotina ${p.routine}: entradas ${brl(ent)}, saídas ${brl(Math.abs(sai))}${p.items.some((i) => i.confianca === 'baixa') ? ' (há lançamentos lidos de PDF: confira antes)' : ''}`;
  }
  if (p.kind === 'sector') {
    const s = sectorByName(db, workspaceId, p.sector);
    return `Mover ${findAgent(db, workspaceId, p.agent)?.name ?? p.agent} para o setor ${s?.name ?? p.sector}`;
  }
  if (p.kind === 'tools') return `${p.action === 'dar' ? 'Liberar' : 'Tirar'} ${TOOLS[p.tool]?.label ?? p.tool} ${p.action === 'dar' ? 'para' : 'de'} ${findAgent(db, workspaceId, p.agent)?.name ?? p.agent}`;
  if (p.kind === 'permission') return p.agent ? `${p.agent} pede permissão para usar ${TOOLS[p.tool]?.label ?? p.tool}: ${p.reason}` : `Ligar ${TOOLS[p.tool]?.label ?? p.tool} para a equipe: ${p.reason}`;
  if (p.kind === 'handoff') return `Pedido passado a ${p.coordinator}: ligar ${TOOLS[p.tool]?.label ?? p.tool}${p.agent ? ` para ${p.agent}` : ' para a equipe'}. A senha é pedida na conversa com ${p.coordinator}.`;
  return `Criar o agente ${p.name} — ${p.role} (setor: ${/^autom/i.test(fold(p.sector)) ? 'automático' : sectorByName(db, workspaceId, p.sector)?.name ?? p.sector})`;
}

export function recordProposals(db: Db, bus: Bus, workspaceId: string, ctx: { conversationId: string | null; runId: string | null }, items: Proposal[]): number {
  if (!items.length) return 0;
  db.tx(() => {
    for (const p of items) {
      db.run(`INSERT INTO agent_proposals (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id('apr'), workspaceId, ctx.conversationId, ctx.runId, p.kind, db.seal(workspaceId, JSON.stringify(p)),
        db.seal(workspaceId, clip(describe(db, workspaceId, p), ['routine', 'routine_edit', 'edit_agent'].includes(p.kind) ? 1200 : 300)),
        // o aviso de pedido passado à coordenação não espera decisão (a senha é pedida lá)
        p.kind === 'handoff' ? 'applied' : 'proposed', now());
    }
  });
  bus.publish(workspaceId, 'proposals.changed', { conversationId: ctx.conversationId });
  if (ctx.conversationId) bus.publish(workspaceId, 'messages.changed', { conversationId: ctx.conversationId });
  return items.length;
}

/**
 * Traz de volta uma sugestão de rotina recusada, do jeito que estava (sem refazer a análise), para nova decisão.
 */
export function reconsiderProposal(db: Db, bus: Bus, workspaceId: string, userId: string, proposalId: string): { id: string } {
  const row = db.get<{ kind: string; payload: string; status: string; conversation_id: string | null }>(
    'SELECT kind, payload, status, conversation_id FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
  if (!row || row.kind !== 'routine') throw notFound('sugestão de rotina');
  if (row.status !== 'rejected') throw new HttpError(409, 'not_rejected', 'só sugestões recusadas podem ser reapresentadas');
  const p = { ...(JSON.parse(row.payload) as Extract<Proposal, { kind: 'routine' }>), again: true };
  // já voltou e está esperando decisão: não duplica
  const pending = db.all<{ payload: string }>("SELECT payload FROM agent_proposals WHERE workspace_id = ? AND kind = 'routine' AND status = 'proposed'", workspaceId)
    .some((x) => (JSON.parse(x.payload) as { spec?: { name?: string } }).spec?.name === p.spec.name);
  if (pending) throw new HttpError(409, 'pending', 'Esta sugestão já está esperando a sua decisão.');
  recordProposals(db, bus, workspaceId, { conversationId: row.conversation_id, runId: null }, [p]);
  const fresh = db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE workspace_id = ? AND kind = 'routine' AND status = 'proposed' ORDER BY created_at DESC, rowid DESC LIMIT 1", workspaceId);
  audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: 'proposal.reconsider', targetType: 'proposal', targetId: proposalId, result: 'sugestão reapresentada' });
  return { id: fresh?.id ?? '' };
}

/** Cards da equipe parados à espera do usuário: uma informação, uma aprovação (ou confirmação) ou uma decisão. */
const WAITING_STATES = ['aguardando_info', 'aguardando_aprovacao', 'revisao'];

/**
 * "Aguardando você": tudo o que espera o usuário dentro da plataforma, num lugar só — propostas da equipe (inclusive
 * cancelar card), perguntas, permissões, cards que pedem informação, aprovação ou decisão, vínculos, regras e execuções
 * paradas numa pergunta. Cada item traz o que é preciso para decidir ali mesmo. Antes, os cards que esperavam o
 * usuário não entravam na conta, e vínculos e regras só levavam para outra tela.
 */
export function pendingDecisions(db: Db, workspaceId: string) {
  const proposals = db.all<{ id: string; kind: string; summary: string; created_at: string; conversation_id: string | null; agent_id: string | null; agent_name: string | null; purpose: string | null }>(
    `SELECT p.id, p.kind, p.summary, p.created_at, p.conversation_id, c.agent_id, a.name AS agent_name, c.purpose
       FROM agent_proposals p LEFT JOIN conversations c ON c.id = p.conversation_id LEFT JOIN agents a ON a.id = c.agent_id
      WHERE p.workspace_id = ? AND p.status = 'proposed' AND p.kind <> 'info_request' ORDER BY p.created_at DESC LIMIT 50`, workspaceId);
  const waiting = db.all<{ id: string; conversation_id: string | null; agent_id: string; agent_name: string; created_at: string }>(
    `SELECT r.id, r.conversation_id, r.agent_id, a.name AS agent_name, r.created_at FROM runs r JOIN agents a ON a.id = r.agent_id
      WHERE r.workspace_id = ? AND r.status = 'waiting_user' ORDER BY r.created_at`, workspaceId);
  const cards = db.all<{ id: string; number: number; title: string; work_state: string; agent_id: string | null; agent_name: string | null; updated_at: string; result_state: string | null; evidence: string | null; justification: string | null }>(
    `SELECT t.id, t.number, t.title, t.work_state, t.agent_id, a.name AS agent_name, t.updated_at,
            x.state AS result_state, x.evidence, x.justification
       FROM tasks t JOIN boards b ON b.id = t.board_id LEFT JOIN agents a ON a.id = t.agent_id
       LEFT JOIN task_results x ON x.id = (SELECT y.id FROM task_results y WHERE y.task_id = t.id ORDER BY y.created_at DESC, y.rowid DESC LIMIT 1)
      WHERE t.workspace_id = ? AND b.audience = 'team' AND t.completed = 0 AND t.archived = 0 AND t.work_state IN (${WAITING_STATES.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))
      ORDER BY t.updated_at DESC LIMIT 50`, workspaceId, ...WAITING_STATES)
    .map(({ evidence, ...c }) => {
      let ev: { pergunta?: string | null } = {};
      try { ev = JSON.parse(evidence ?? '{}'); } catch { /* sem evidência legível */ }
      const need = c.work_state === 'aguardando_info' ? 'info' : c.work_state === 'revisao' ? 'review' : 'approval';
      return { ...c, need, question: need === 'info' ? ev.pergunta ?? null : null, external: c.result_state === 'sem_confirmacao' };
    });
  const linkList = db.all<{ id: string; task_id: string; number: number; title: string; related_number: number; related_title: string; reason: string }>(
    `SELECT p.id, p.task_id, t.number, t.title, r.number AS related_number, r.title AS related_title, p.reason
       FROM link_proposals p JOIN tasks t ON t.id = p.task_id JOIN tasks r ON r.id = p.related_task_id
      WHERE p.workspace_id = ? AND p.status = 'proposed' AND t.archived = 0 ORDER BY p.created_at DESC LIMIT 30`, workspaceId);
  const ruleList = db.all<{ id: string; text: string; created_at: string }>("SELECT id, text, created_at FROM rules WHERE workspace_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 30", workspaceId);
  const refused = db.all<{ id: string; summary: string; decided_at: string }>(
    "SELECT id, summary, decided_at FROM agent_proposals WHERE workspace_id = ? AND kind = 'routine' AND status = 'rejected' ORDER BY decided_at DESC LIMIT 10", workspaceId);
  return { proposals, waiting, cards, links: linkList.length, rules: ruleList.length, linkList, ruleList, refusedRoutines: refused,
    total: proposals.length + waiting.length + cards.length + linkList.length + ruleList.length };
}

/** Quantos itens esperam o usuário (o número do topo): o mesmo que a lista de pendingDecisions. */
export function pendingCount(db: Db, workspaceId: string): number {
  const n = (sql: string, ...args: string[]) => Number(db.get<{ n: number }>(sql, ...args)?.n ?? 0);
  return n("SELECT COUNT(*) AS n FROM agent_proposals WHERE workspace_id = ? AND status = 'proposed' AND kind <> 'info_request'", workspaceId)
    + n("SELECT COUNT(*) AS n FROM runs WHERE workspace_id = ? AND status = 'waiting_user'", workspaceId)
    + n(`SELECT COUNT(*) AS n FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.workspace_id = ? AND b.audience = 'team' AND t.completed = 0 AND t.archived = 0
          AND t.work_state IN (${WAITING_STATES.map(() => '?').join(', ')}) AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.status IN ('queued', 'running', 'waiting_user'))`, workspaceId, ...WAITING_STATES)
    + n("SELECT COUNT(*) AS n FROM link_proposals p JOIN tasks t ON t.id = p.task_id WHERE p.workspace_id = ? AND p.status = 'proposed' AND t.archived = 0", workspaceId)
    + n("SELECT COUNT(*) AS n FROM rules WHERE workspace_id = ? AND status = 'proposed'", workspaceId);
}

/**
 * Resposta a uma pergunta com opções. Quando a última pergunta daquela rodada é respondida, devolve o texto que
 * vai como mensagem do usuário para o agente continuar (todas as respostas juntas, numa mensagem só).
 */
export function answerQuestion(db: Db, bus: Bus, workspaceId: string, userId: string, proposalId: string, answer: string): { conversationId: string; message: string | null; batch: string } {
  const row = db.get<{ kind: string; payload: string; status: string; conversation_id: string | null; run_id: string | null }>(
    'SELECT kind, payload, status, conversation_id, run_id FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
  if (!row || row.kind !== 'question' || !row.conversation_id) throw notFound('pergunta');
  if (row.status !== 'proposed') throw new HttpError(409, 'decided', 'esta pergunta já foi respondida');
  const a = clip(answer.trim(), 300);
  if (!a) throw new HttpError(400, 'empty', 'resposta vazia');
  db.run("UPDATE agent_proposals SET status = 'applied', result = ?, decided_at = ? WHERE id = ?", db.seal(workspaceId, a), now(), proposalId);
  audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: 'question.answer', targetType: 'proposal', targetId: proposalId, result: 'respondida' });
  bus.publish(workspaceId, 'proposals.changed', { conversationId: row.conversation_id });
  const batch = row.run_id ?? proposalId;
  const open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_proposals WHERE conversation_id = ? AND kind = 'question' AND status = 'proposed' AND COALESCE(run_id, id) = ?", row.conversation_id, batch);
  if (Number(open?.n ?? 0) > 0) return { conversationId: row.conversation_id, message: null, batch };
  const answered = db.all<{ payload: string; result: string }>("SELECT payload, result FROM agent_proposals WHERE conversation_id = ? AND kind = 'question' AND status = 'applied' AND COALESCE(run_id, id) = ? ORDER BY created_at, rowid", row.conversation_id, batch);
  const lines = answered.map((x) => `- ${(JSON.parse(x.payload) as { question: string }).question} → ${x.result}`);
  return { conversationId: row.conversation_id, message: lines.length > 1 ? `Minhas respostas:\n${lines.join('\n')}` : `Minha resposta: ${lines[0]?.replace(/^- /, '') ?? a}`, batch };
}

export function listProposals(db: Db, workspaceId: string, conversationId?: string | null) {
  return db.all(
    `SELECT id, conversation_id, run_id, kind, summary, status, result, created_at, decided_at, CASE WHEN kind IN ('question', 'info_request', 'handoff') THEN payload END AS payload FROM agent_proposals
      WHERE workspace_id = ? ${conversationId ? 'AND (conversation_id = ? OR id IN (SELECT proposal_id FROM proposal_links WHERE conversation_id = ?))' : ''} ORDER BY created_at DESC LIMIT 50`,
    ...(conversationId ? [workspaceId, conversationId, conversationId] : [workspaceId]));
}

/**
 * Autoriza um pedido de permissão (a senha já foi conferida por quem chama): libera a ferramenta para o agente que
 * pediu e liga o conjunto no motor. Devolve o que o chamador precisa para o agente continuar a conversa.
 */
export async function grantPermission(db: Db, bus: Bus, workspaceId: string, userId: string, proposalId: string, enable: (toolId: string) => Promise<void>):
  Promise<{ status: 'applied' | 'failed'; result: string; conversationId: string | null; agentId: string | null; tool: string; origin: string | null }> {
  const row = db.get<{ kind: string; payload: string; status: string; conversation_id: string | null }>(
    'SELECT kind, payload, status, conversation_id FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
  if (!row || row.kind !== 'permission') throw notFound('pedido de permissão');
  if (row.status !== 'proposed') throw new HttpError(409, 'decided', 'este pedido já foi decidido');
  const p = JSON.parse(row.payload) as Extract<Proposal, { kind: 'permission' }>;
  // sem agente: só liga para a equipe (cada um usa se tiver no perfil)
  const a = p.agent ? findAgent(db, workspaceId, p.agent) : undefined;
  let status: 'applied' | 'failed' = 'applied';
  let result: string;
  try {
    if (p.agent && !a) throw new HttpError(404, 'agent', `não encontrei o agente "${p.agent}"`);
    await enable(p.tool);
    if (a) {
      const cur = JSON.parse(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', a.id)?.tools ?? '[]') as string[];
      if (!cur.includes(p.tool)) updateAgent(db, bus, workspaceId, userId, a.id, { tools: [...cur, p.tool] });
      result = `${TOOLS[p.tool]?.label ?? p.tool} liberada para ${a.name}`;
    } else result = `${TOOLS[p.tool]?.label ?? p.tool} ligada para a equipe`;
  } catch (err) { status = 'failed'; result = err instanceof Error ? err.message : 'falha'; }
  db.run('UPDATE agent_proposals SET status = ?, result = ?, decided_at = ? WHERE id = ?', status, db.seal(workspaceId, clip(result, 300)), now(), proposalId);
  audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: `permission.${status}`, targetType: 'proposal', targetId: proposalId, evidence: { agent: p.agent, tool: p.tool, reason: p.reason }, result });
  bus.publish(workspaceId, 'proposals.changed', { conversationId: row.conversation_id });
  return { status, result, conversationId: row.conversation_id, agentId: a?.id ?? null, tool: p.tool, origin: p.origin ?? null };
}

/** Quem aplica as propostas de rotina (o serviço de rotinas, ligado pelo app). */
export interface ProposalHooks {
  routine?: (p: RoutineProposal) => string; ledger?: (p: Extract<Proposal, { kind: 'ledger' }>, userId: string) => string; limits?: AgentLimits;
  /** cancelar um card (para o trabalho dele, fecha os pedidos abertos e tira do quadro); devolve o resultado em texto */
  deleteTask?: (number: number, reason: string) => string;
}

export function decideProposal(db: Db, bus: Bus, workspaceId: string, userId: string, proposalId: string, decision: 'apply' | 'reject', hooks: ProposalHooks = {}): { status: string; result: string } {
  const row = db.get<{ kind: string; payload: string; status: string; conversation_id: string | null }>(
    'SELECT kind, payload, status, conversation_id FROM agent_proposals WHERE id = ? AND workspace_id = ?', proposalId, workspaceId);
  if (!row) throw notFound('proposta');
  if (row.status !== 'proposed') throw new HttpError(409, 'decided', 'esta proposta já foi decidida');
  const p = JSON.parse(row.payload) as Proposal;
  if (p.kind === 'permission' && decision === 'apply') throw new HttpError(400, 'needs_password', 'Para liberar, autorize com a sua senha no próprio cartão.');
  if (row.kind === 'info_request') throw new HttpError(400, 'respond', 'Responda pelo próprio cartão (responder, aprovar ou devolver).');
  let status: 'applied' | 'rejected' | 'failed' = 'rejected';
  let result = 'recusada';
  if (decision === 'apply') {
    try {
      if (p.kind === 'permission') {
        throw new HttpError(400, 'needs_password', 'autorize com a senha');
      } else if (p.kind === 'question') {
        throw new HttpError(400, 'answer', 'Responda escolhendo uma das opções no cartão.');
      } else if (p.kind === 'edit_agent') {
        const a = findAgent(db, workspaceId, p.agent);
        if (!a) throw new HttpError(404, 'agent', `não encontrei o agente "${p.agent}"`);
        // o Coordenador é o único cargo fixo: num tema inteiro, nome, bio e foco dele mudam; função e setor ficam
        const fixed = Number(db.get<{ c: number }>('SELECT coordinator AS c FROM agents WHERE id = ?', a.id)?.c) === 1;
        const c = fixed ? { ...p.changes, role: undefined, sector: undefined } : p.changes;
        const kept = fixed && (p.changes.role || p.changes.sector);
        if (fixed && !c.name && !c.charter && !c.skills && !c.bio) throw new HttpError(409, 'fixed_role', FIXED_MSG.role);
        const s = c.sector ? sectorByName(db, workspaceId, c.sector) : undefined;
        if (c.sector && !s) throw new HttpError(404, 'sector', `não encontrei o setor "${c.sector}"`);
        updateAgent(db, bus, workspaceId, userId, a.id, { name: c.name, role: c.role, sectorKey: s?.key, charter: c.charter, skills: c.skills, bio: c.bio });
        result = `${c.name && c.name !== a.name ? `${a.name} agora é ${c.name}` : `${a.name} atualizado`}${c.role ? ` (${c.role})` : ''}${kept ? ' — Coordenador: função e setor são fixos e ficaram como estavam' : ''}`;
      } else if (p.kind === 'deactivate_agent') {
        const a = findAgent(db, workspaceId, p.agent);
        if (!a) throw new HttpError(404, 'agent', `não encontrei o agente "${p.agent}"`);
        const r = archiveAgent(db, bus, workspaceId, userId, a.id);
        result = `${a.name} desativado${r.redistributed.length ? `; ${r.redistributed.length} tarefa(s) passaram a colegas` : ''}`;
      } else if (p.kind === 'reactivate_agent') {
        const a = findAny(db, workspaceId, p.agent, 'archived');
        if (!a) throw new HttpError(404, 'agent', `não encontrei um agente desativado chamado "${p.agent}"`);
        reactivateAgent(db, bus, workspaceId, userId, a.id, null, hooks.limits);
        result = `${a.name} de volta à equipe`;
      } else if (p.kind === 'sector_edit') {
        const s = sectorByName(db, workspaceId, p.sector);
        if (!s) throw new HttpError(404, 'sector', `não encontrei o setor "${p.sector}"`);
        const r = updateSector(db, bus, workspaceId, { type: 'user', id: userId }, s.key, p.changes);
        result = `setor ${r.name} atualizado`;
      } else if (p.kind === 'sector_new') {
        const r = createSector(db, bus, workspaceId, { type: 'user', id: userId }, { name: p.name, description: p.description });
        result = `setor ${r.name} criado`;
      } else if (p.kind === 'routine' || p.kind === 'routine_edit') {
        if (!hooks.routine) throw new HttpError(503, 'routines', 'rotinas indisponíveis');
        result = hooks.routine(p);
      } else if (p.kind === 'task') {
        // com responsável da equipe vai para o quadro da equipe (vira trabalho dele); sem, fica nas suas tarefas
        const a = p.assignee ? findAgent(db, workspaceId, p.assignee) : undefined;
        const t = createTask(db, bus, workspaceId, { type: 'user', id: userId }, {
          title: p.title, description: [p.detail, `Proposta ${byWho(p.routine)}${p.origin ? ` (origem: ${p.origin})` : ''} e aprovada por você.`].filter(Boolean).join('\n\n'),
          boardId: a ? defaultBoard(db, workspaceId).id : userBoard(db, workspaceId).id, agentId: a?.id ?? null, origin: 'chat', dueOn: p.due,
        });
        result = `tarefa #${t.number} criada${a ? ` para ${a.name}` : ' nas suas tarefas'}${p.assignee && !a ? ` (não achei "${p.assignee}" na equipe)` : ''}`;
      } else if (p.kind === 'ledger') {
        if (!hooks.ledger) throw new HttpError(503, 'routines', 'rotinas indisponíveis');
        result = hooks.ledger(p, userId);
      } else if (p.kind === 'delete_task') {
        if (!hooks.deleteTask) throw new HttpError(503, 'tasks', 'quadro indisponível');
        result = hooks.deleteTask(p.number, p.reason);
      } else if (p.kind === 'tools') {
        // propostas antigas (antes da regra acima) também não liberam código sem a senha
        if (p.action === 'dar' && TOOLS[p.tool]?.guarded) throw new HttpError(400, 'needs_password', 'Ferramenta que executa código só com a sua senha: peça de novo ao agente para ele pedir permissão.');
        const a = findAgent(db, workspaceId, p.agent);
        if (!a) throw new HttpError(404, 'agent', `não encontrei o agente "${p.agent}"`);
        const cur = JSON.parse(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', a.id)?.tools ?? '[]') as string[];
        const next = p.action === 'dar' ? [...new Set([...cur, p.tool])] : cur.filter((t) => t !== p.tool);
        updateAgent(db, bus, workspaceId, userId, a.id, { tools: next });
        result = `${TOOLS[p.tool]?.label ?? p.tool} ${p.action === 'dar' ? 'liberada para' : 'retirada de'} ${a.name}`;
      } else if (p.kind === 'sector') {
        const a = findAgent(db, workspaceId, p.agent);
        if (!a) throw new HttpError(404, 'agent', `não encontrei o agente "${p.agent}"`);
        const s = sectorByName(db, workspaceId, p.sector);
        if (!s) throw new HttpError(404, 'sector', `não encontrei o setor "${p.sector}"`);
        const r = moveToSector(db, bus, workspaceId, { type: 'user', id: userId }, a.id, s.key);
        result = `${r.name} agora está no setor ${r.sector}`;
      } else if (p.kind === 'handoff') {
        throw new HttpError(409, 'decided', 'aviso: a autorização é feita na conversa com a coordenação');
      } else {
        const auto = /^autom/i.test(fold(p.sector));
        const s = auto ? null : sectorByName(db, workspaceId, p.sector);
        const r = createAgent(db, bus, workspaceId, userId, { name: p.name, role: p.role, sectorKey: s?.key ?? 'auto' }, hooks.limits);
        result = `${p.name} criado no setor ${r.sector}${r.sectorReason ? ` (${r.sectorReason})` : ''}`;
      }
      status = 'applied';
    } catch (err) {
      status = 'failed';
      result = err instanceof Error ? err.message : 'falha';
    }
  }
  db.run('UPDATE agent_proposals SET status = ?, result = ?, decided_at = ? WHERE id = ?', status, db.seal(workspaceId, clip(result, 300)), now(), proposalId);
  // recusada, a sugestão de rotina fica na base de recusas (não volta sozinha; pode ser reapresentada)
  audit(db, bus, { workspaceId, actorType: 'user', actorId: userId, action: `proposal.${status}`, targetType: 'proposal', targetId: proposalId, evidence: p, result });
  bus.publish(workspaceId, 'proposals.changed', { conversationId: row.conversation_id });
  if (row.conversation_id) bus.publish(workspaceId, 'messages.changed', { conversationId: row.conversation_id });
  return { status, result };
}
