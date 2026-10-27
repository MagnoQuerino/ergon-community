import { randomInt } from 'node:crypto';
import type { Db } from '../db/db.ts';
import { HttpError, id, notFound, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { typeOf } from '../../../shared/city.ts';
import type { Config } from '../config.ts';
import { CHARACTERS, TOOLS, characterColumns } from './characters.ts';
import { COORDINATOR_ONLY, COORDINATOR_ROLE, COORDINATOR_SECTOR, COORDINATOR_TOOLS, FIXED_MSG, activeTeam, coordinatorFocus, coordinatorOf, routeTo } from './team.ts';
import { SECTORS, autoSector, listSectors, sectorByKey } from './sectors.ts';
import { onboardingChoice, presetByKey } from './team-presets.ts';
import { addStructureFloor, growForAgent } from './structures.ts';

/**
 * Limites de agentes. Local: quantos quiser — sem vaga, a cidade cresce sozinha. Nuvem: conforme o plano
 * (`ERGON_MAX_AGENTS`; 0 = sem limite). O Coordenador conta como um agente, mas nunca sai.
 */
export interface AgentLimits { autoGrow: boolean; maxFloors: number; maxActive: number }
export const limitsFor = (cfg: Pick<Config, 'mode' | 'maxFloors' | 'maxAgents' | 'autoGrow'>): AgentLimits =>
  ({ autoGrow: cfg.autoGrow && cfg.mode === 'local', maxFloors: cfg.maxFloors, maxActive: cfg.mode === 'cloud' ? cfg.maxAgents : 0 });

function checkPlan(db: Db, workspaceId: string, limits?: AgentLimits): void {
  if (!limits?.maxActive) return;
  const n = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", workspaceId)?.n ?? 0);
  if (n >= limits.maxActive) throw new HttpError(409, 'plan_limit', `O seu plano comporta ${limits.maxActive} agentes ativos: desative um ou mude de plano.`);
}


export interface CapacityInfo {
  slots: number;
  active: number;
  free: number;
  floors: Array<{ id: string; building_id: string; level: number; name: string; slots: number; active: number; origin: string }>;
  maxFloors: number;
  note: string;
}

export function capacityInfo(db: Db, workspaceId: string, maxFloors: number): CapacityInfo {
  const floors = db.all<{ id: string; building_id: string; level: number; name: string; slots: number; origin: string; active: number }>(
    `SELECT f.id, f.building_id, f.level, f.name, f.slots, f.origin,
            (SELECT COUNT(*) FROM agents a WHERE a.floor_id = f.id AND a.status = 'active') AS active
       FROM floors f JOIN buildings b ON b.id = f.building_id
      WHERE f.workspace_id = ? AND f.removed_at IS NULL ORDER BY b.created_at, b.rowid, f.level`, workspaceId);
  const slots = floors.reduce((s, f) => s + Number(f.slots), 0);
  const active = floors.reduce((s, f) => s + Number(f.active), 0);
  return {
    slots, active, free: Math.max(0, slots - active), floors, maxFloors,
    note: 'Capacidade = vagas dos andares das estruturas. Não aumenta execuções concorrentes, tokens nem processos.',
  };
}

/** Traduz erros dos gatilhos de capacidade em respostas HTTP claras. */
function mapCapacityError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('capacity_exceeded')) throw new HttpError(409, 'capacity_exceeded', 'Capacidade de habitantes esgotada: adicione um andar ou uma estrutura (grátis na versão local) ou desative um agente.');
  if (msg.includes('floor_full')) throw new HttpError(409, 'floor_full', 'Este andar está cheio.');
  if (msg.includes('invalid_floor')) throw new HttpError(400, 'invalid_floor', 'Andar inválido para este workspace.');
  if (msg.includes('floor_occupied')) throw new HttpError(409, 'floor_occupied', 'Andar ocupado: mude os residentes de lugar ou desative-os antes.');
  throw err;
}

/**
 * Andar com vaga: o pedido, ou o primeiro com vaga na construção escolhida, ou o primeiro com vaga na cidade. Com
 * `grow` (versão local), sem vaga a construção escolhida ganha um andar ou a cidade cresce sozinha.
 */
function pickFloor(db: Db, workspaceId: string, floorId?: string | null, structureId?: string | null, grow?: { bus: Bus; actor: string; limits: AgentLimits }): string {
  if (floorId) return floorId; // o gatilho valida pertencimento e lotação
  const f = db.get<{ id: string }>(
    `SELECT f.id FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.workspace_id = ? AND f.removed_at IS NULL AND b.removed_at IS NULL
        AND (? IS NULL OR f.building_id = ?)
        AND (SELECT COUNT(*) FROM agents a WHERE a.floor_id = f.id AND a.status = 'active') < f.slots
      ORDER BY b.created_at, b.rowid, f.level LIMIT 1`, workspaceId, structureId ?? null, structureId ?? null);
  if (!f && grow?.limits.autoGrow) {
    if (!structureId) return growForAgent(db, grow.bus, workspaceId, grow.actor, grow.limits.maxFloors);
    try { return addStructureFloor(db, grow.bus, workspaceId, grow.actor, structureId, grow.limits.maxFloors); } catch { /* chegou ao máximo de andares: segue para a mensagem */ }
  }
  if (!f) {
    if (structureId) throw new HttpError(409, 'structure_full', 'Esta construção está cheia: adicione um andar a ela ou escolha "automática".');
    throw new HttpError(409, 'capacity_exceeded', 'Capacidade de habitantes esgotada: adicione um andar ou uma estrutura (grátis na versão local) ou desative um agente.');
  }
  return f.id;
}

const COLORS = ['#2f6f8f', '#8a5a2b', '#c2603a', '#3f7d4e', '#6b4f8f', '#a33b4c', '#2d5f5a', '#b07d1f', '#4a5a8c', '#7a6a3a'];

export interface AgentInput {
  name: string; role: string;
  /** chave do setor ou 'auto' (a coordenação escolhe pelo papel) */
  sectorKey?: string; profileKey?: string;
  /** construção escolhida (sem andar) ou nada = automática */
  structureId?: string | null; floorId?: string | null; color?: string | null;
  charter?: string | null; skills?: string[]; tools?: string[]; hermesSkills?: string[];
  model?: string | null; provider?: string | null;
}

/** Instruções iniciais de um agente novo (o usuário edita depois, ou pede à coordenação que escreva). */
export function defaultCharter(role: string, sectorName: string, sectorDescription: string | null): string {
  return `Você é responsável por: ${role}. Trabalha no setor ${sectorName}${sectorDescription ? ` (${sectorDescription.replace(/\.$/, '')})` : ''}. ` +
    'Entregue resultados prontos para usar e diga o que depende de outras pessoas. Se o pedido for vago, faça uma pergunta curta antes de começar. ' +
    'Quando outro colega da equipe for mais indicado, diga quem e por quê.';
}

const cleanList = (xs: string[] | undefined, max: number, len: number): string[] =>
  [...new Set((xs ?? []).map((x) => String(x).trim()).filter((x) => x && x.length <= len))].slice(0, max);

export function createAgent(db: Db, bus: Bus, workspaceId: string, actorUserId: string, input: AgentInput, limits?: AgentLimits): { id: string; sector: string; sectorReason: string | null } {
  const name = input.name.trim();
  const role = input.role.trim();
  if (!name || name.length > 40) throw new HttpError(400, 'name', 'nome: 1–40 caracteres');
  if (!role || role.length > 80) throw new HttpError(400, 'role', 'papel: 1–80 caracteres');
  const color = input.color && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : COLORS[Math.floor(Math.random() * COLORS.length)];
  const wanted = input.sectorKey ?? input.profileKey ?? 'auto';
  const auto = wanted === 'auto' ? autoSector(role) : null;
  try {
    const out = db.tx(() => {
      if (db.get("SELECT 1 AS x FROM agents WHERE workspace_id = ? AND status = 'active' AND lower(name) = lower(?)", workspaceId, name)) {
        throw new HttpError(409, 'name_taken', `Já existe um agente ativo chamado ${name}.`);
      }
      checkPlan(db, workspaceId, limits);
      const sector = sectorByKey(db, workspaceId, auto?.key ?? wanted);
      const floorId = pickFloor(db, workspaceId, input.floorId, input.structureId, limits ? { bus, actor: actorUserId, limits } : undefined);
      const agentId = id('agt');
      // ferramentas que executam código nunca vêm de graça: só por autorização com a senha (permissão na conversa ou perfil);
      // encaminhar as demandas é só do Coordenador
      const tools = (input.tools?.length ? cleanList(input.tools, 20, 30).filter((t) => TOOLS[t]) : sector.tools)
        .filter((t) => !TOOLS[t]?.guarded && !COORDINATOR_ONLY.includes(t));
      const skills = input.skills?.length ? cleanList(input.skills, 12, 80) : sector.skills.slice(0, 3);
      const charter = input.charter?.trim() ? input.charter.trim().slice(0, 4000) : defaultCharter(role, sector.name, sector.description);
      db.run(
        `INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at, charter, skills, tools, hermes_skills, model, provider, look_seed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        agentId, workspaceId, floorId, sector.id, name, role, color, now(), db.seal(workspaceId, charter), JSON.stringify(skills), JSON.stringify(tools),
        JSON.stringify(cleanList(input.hermesSkills, 20, 80)), input.model ?? null, input.model ? input.provider ?? null : null,
        // agente novo nasce com um boneco sorteado do pacote gráfico (a equipe pode crescer sem bonecos repetidos)
        randomInt(1, 2147483647));
      audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'agent.create', targetType: 'agent', targetId: agentId,
        evidence: { name, role, sector: sector.key, auto: auto?.reason ?? null }, result: 'ok' });
      return { id: agentId, sector: sector.name, sectorReason: auto?.reason ?? null };
    });
    bus.publish(workspaceId, 'agents.changed', { id: out.id });
    return out;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapCapacityError(err);
  }
}

export interface AgentPatch {
  name?: string; role?: string; sectorKey?: string; charter?: string; skills?: string[]; tools?: string[]; hermesSkills?: string[];
  /** null = volta ao modelo padrão da conta */
  model?: string | null; provider?: string | null; color?: string; structureId?: string;
  /** apresentação curta que aparece no perfil (os temas trocam nomes e bios) */
  bio?: string | null;
  /** boneco sorteado do pacote gráfico ("Redefinir aparência"); null = volta ao do personagem */
  lookSeed?: number | null;
}

/** Edita o subagente (o motor recebe tudo isso a cada execução: instruções, ferramentas, skills e modelo). */
export function updateAgent(db: Db, bus: Bus, workspaceId: string, actorUserId: string, agentId: string, p: AgentPatch): void {
  try {
    db.tx(() => {
      const a = db.get<{ name: string; status: string; floor_id: string; coordinator: number }>('SELECT name, status, floor_id, coordinator FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
      if (!a) throw notFound('agente');
      // o cargo fixo: função, setor e ferramentas de coordenação não mudam; o resto (nome, história, foco…) é livre
      if (Number(a.coordinator) === 1) {
        if (p.role !== undefined && p.role.trim() !== COORDINATOR_ROLE) throw new HttpError(409, 'fixed_role', FIXED_MSG.role);
        if (p.sectorKey !== undefined && p.sectorKey !== COORDINATOR_SECTOR) throw new HttpError(409, 'fixed_sector', FIXED_MSG.sector);
        if (p.tools !== undefined && COORDINATOR_TOOLS.some((t) => !p.tools!.includes(t))) throw new HttpError(409, 'fixed_tools', FIXED_MSG.tools);
      } else if (p.tools?.some((t) => COORDINATOR_ONLY.includes(t))) throw new HttpError(409, 'coordinator_only', FIXED_MSG.only);
      const sets: string[] = []; const vals: Array<string | null> = []; const changed: string[] = [];
      const set = (col: string, v: string | null, label: string) => { sets.push(`${col} = ?`); vals.push(v); changed.push(label); };
      if (p.name !== undefined) {
        const n = p.name.trim();
        if (!n || n.length > 40) throw new HttpError(400, 'name', 'nome: 1–40 caracteres');
        if (db.get("SELECT 1 AS x FROM agents WHERE workspace_id = ? AND status = 'active' AND lower(name) = lower(?) AND id <> ?", workspaceId, n, agentId)) throw new HttpError(409, 'name_taken', `Já existe um agente ativo chamado ${n}.`);
        set('name', n, 'nome');
      }
      if (p.role !== undefined) { const r = p.role.trim(); if (!r || r.length > 80) throw new HttpError(400, 'role', 'papel: 1–80 caracteres'); set('role', r, 'papel'); }
      if (p.sectorKey !== undefined) set('profile_id', sectorByKey(db, workspaceId, p.sectorKey).id, 'setor');
      if (p.charter !== undefined) set('charter', db.seal(workspaceId, p.charter.trim().slice(0, 4000) || null), 'instruções');
      if (p.skills !== undefined) set('skills', JSON.stringify(cleanList(p.skills, 12, 80)), 'métodos');
      if (p.tools !== undefined) set('tools', JSON.stringify(cleanList(p.tools, 20, 30).filter((t) => TOOLS[t])), 'ferramentas');
      if (p.hermesSkills !== undefined) set('hermes_skills', JSON.stringify(cleanList(p.hermesSkills, 20, 80)), 'skills');
      if (p.model !== undefined) { set('model', p.model || null, 'modelo'); set('provider', p.model ? p.provider ?? null : null, 'conta do modelo'); }
      if (p.color !== undefined && /^#[0-9a-f]{6}$/i.test(p.color)) set('color', p.color, 'cor');
      if (p.bio !== undefined) set('bio', (p.bio ?? '').trim().slice(0, 600) || null, 'bio');
      if (p.lookSeed !== undefined) set('look_seed', p.lookSeed === null ? null : String(Math.trunc(p.lookSeed)), 'aparência');
      // renomeado: as conversas com o título padrão acompanham o nome novo
      if (p.name !== undefined && p.name.trim() !== a.name) db.run('UPDATE conversations SET title = ? WHERE agent_id = ? AND title = ?', `Conversa com ${p.name.trim()}`, agentId, `Conversa com ${a.name}`);
      if (p.structureId !== undefined) {
        const cur = db.get<{ building_id: string }>('SELECT building_id FROM floors WHERE id = ?', a.floor_id);
        if (cur?.building_id !== p.structureId) set('floor_id', a.status === 'active' ? pickFloor(db, workspaceId, null, p.structureId) : a.floor_id, 'construção');
      }
      if (!sets.length) return;
      db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`, ...vals, agentId, workspaceId);
      audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'agent.update', targetType: 'agent', targetId: agentId, evidence: { changed: [...new Set(changed)] }, result: 'ok' });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapCapacityError(err);
  }
  bus.publish(workspaceId, 'agents.changed', { id: agentId });
}

const ACTIVE_RUN = "('queued', 'running', 'waiting_user')";

export interface Redistribution { number: number; title: string; to: string; reason: string }
export interface ToolHandover { tool: string; label: string; to: string }

/**
 * Desativar: o agente sai da cidade (vaga liberada, histórico e conversas preservados) e a coordenação
 * redistribui as tarefas abertas dele no quadro da equipe — primeiro para colegas do mesmo setor pelas
 * palavras da tarefa, depois para o especialista de qualquer setor, por fim para a triagem da coordenação.
 * Regras do Ergon, sem modelo; tudo fica no log de cada tarefa.
 */
export function archiveAgent(db: Db, bus: Bus, workspaceId: string, actorUserId: string, agentId: string): { redistributed: Redistribution[]; tools: ToolHandover[] } {
  const moved: Redistribution[] = [];
  const handed: ToolHandover[] = [];
  db.tx(() => {
    const a = db.get<{ status: string; name: string; profile_id: string; coordinator: number }>('SELECT status, name, profile_id, coordinator FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
    if (!a) throw notFound('agente');
    if (Number(a.coordinator) === 1) throw new HttpError(409, 'fixed_coordinator', FIXED_MSG.archive);
    if (a.status === 'archived') return;
    const busy = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status IN ${ACTIVE_RUN}`, agentId);
    if (busy && Number(busy.n) > 0) throw new HttpError(409, 'agent_busy', `${a.name} está trabalhando agora: espere terminar ou cancele a execução antes de desativar.`);
    const team = db.all<{ id: string; name: string; char_key: string | null; profile_id: string; skey: string; tools: string | null }>(
      `SELECT a.id, a.name, a.char_key, a.profile_id, p.key AS skey, a.tools FROM agents a JOIN profiles p ON p.id = a.profile_id
        WHERE a.workspace_id = ? AND a.status = 'active' AND a.id <> ? ORDER BY a.created_at, a.rowid`, workspaceId, agentId);
    const members = activeTeam(db, workspaceId, agentId);
    const coordM = coordinatorOf(members);
    const coord = team.find((t) => t.id === coordM?.id) ?? team[0];
    const open = db.all<{ id: string; number: number; title: string; description: string }>(
      `SELECT t.id, t.number, t.title, t.description FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE t.workspace_id = ? AND t.agent_id = ? AND t.completed = 0 AND t.archived = 0 AND b.audience = 'team' ORDER BY t.number`, workspaceId, agentId);
    const list = (v: string | null) => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
    const mineTools = list(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', agentId)?.tools ?? null);
    // colegas do mesmo setor, do mais parecido (mais ferramentas em comum) ao menos parecido
    const sameSector = team.filter((m) => m.profile_id === a.profile_id)
      .map((m) => ({ m, overlap: list(m.tools).filter((x) => mineTools.includes(x)).length }))
      .sort((x, y) => y.overlap - x.overlap).map((x) => x.m);
    for (const t of open) {
      const route = routeTo(members, `${t.title} ${t.description}`);
      const bySpecialist = route ? team.find((m) => m.id === route.member.id) : undefined;
      const pick = (bySpecialist && sameSector.includes(bySpecialist) ? bySpecialist : undefined)
        ?? sameSector[0] ?? bySpecialist ?? coord;
      const reason = !pick ? 'sem agentes ativos' : pick === bySpecialist ? `especialista pelas palavras (${route!.words.join(', ')})`
        : sameSector.includes(pick) ? 'colega do mesmo setor' : 'triagem da coordenação';
      db.run('UPDATE tasks SET agent_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?', pick?.id ?? null, now(), t.id);
      audit(db, null, { workspaceId, actorType: 'system', actorId: coord?.id ?? null, action: 'task.reassign', targetType: 'task', targetId: t.id,
        evidence: { from: a.name, to: pick?.name ?? null, reason }, result: `${a.name} desativado: ${pick ? `tarefa passou a ${pick.name} (${reason})` : 'tarefa sem responsável'}` });
      moved.push({ number: Number(t.number), title: t.title, to: pick?.name ?? '—', reason });
    }
    // ferramentas que só este agente tinha: a coordenação passa ao colega de setor mais parecido (ou fica com ela)
    for (const tool of mineTools) {
      if (!TOOLS[tool] || team.some((m) => list(m.tools).includes(tool))) continue;
      const to = sameSector[0] ?? coord;
      if (!to) continue;
      const next = [...new Set([...list(to.tools), tool])];
      db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(next), to.id);
      to.tools = JSON.stringify(next);
      audit(db, null, { workspaceId, actorType: 'system', actorId: coord?.id ?? null, action: 'agent.tools.reassign', targetType: 'agent', targetId: to.id,
        evidence: { tool, from: a.name }, result: `${TOOLS[tool].label}: só ${a.name} tinha; passou a ${to.name}` });
      handed.push({ tool, label: TOOLS[tool].label, to: to.name });
    }
    const parts = [moved.length ? `${moved.length} tarefa(s) redistribuída(s)` : '', handed.length ? `${handed.length} ferramenta(s) repassada(s)` : ''].filter(Boolean);
    const note = parts.length ? `${parts.join(' e ')} pela coordenação` : 'sem tarefas abertas nem ferramentas exclusivas para repassar';
    db.run("UPDATE agents SET status = 'archived', archived_at = ?, deactivation_note = ? WHERE id = ?", now(), note, agentId);
    audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'agent.deactivate', targetType: 'agent', targetId: agentId, evidence: { redistributed: moved, tools: handed }, result: note });
  });
  bus.publish(workspaceId, 'agents.changed', { id: agentId });
  if (moved.length) bus.publish(workspaceId, 'tasks.changed', {});
  return { redistributed: moved, tools: handed };
}

export function reactivateAgent(db: Db, bus: Bus, workspaceId: string, actorUserId: string, agentId: string, floorId?: string | null, limits?: AgentLimits): void {
  try {
    db.tx(() => {
      const a = db.get<{ status: string; floor_id: string }>('SELECT status, floor_id FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
      if (!a) throw notFound('agente');
      if (a.status === 'active') return;
      checkPlan(db, workspaceId, limits);
      // volta ao andar original se houver vaga; senão, primeiro andar com vaga (no local, a cidade cresce se faltar)
      const free = db.get<{ ok: number }>(
        `SELECT (SELECT COUNT(*) FROM agents WHERE floor_id = f.id AND status = 'active') < f.slots AS ok
           FROM floors f WHERE f.id = ? AND f.workspace_id = ? AND f.removed_at IS NULL`, a.floor_id, workspaceId);
      const target = floorId ?? (free && Number(free.ok) ? a.floor_id : pickFloor(db, workspaceId, null, null, limits ? { bus, actor: actorUserId, limits } : undefined));
      db.run("UPDATE agents SET status = 'active', archived_at = NULL, deactivation_note = NULL, floor_id = ? WHERE id = ?", target, agentId);
      audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'agent.reactivate', targetType: 'agent', targetId: agentId, result: 'ok' });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapCapacityError(err);
  }
  bus.publish(workspaceId, 'agents.changed', { id: agentId });
}

/**
 * Expansão SIMULADA e gratuita, local: adiciona um andar. Nenhum pagamento, saldo ou
 * desconto. O cliente não altera capacidade; somente esta rota no servidor.
 */
export function addSimulatedFloor(db: Db, bus: Bus, workspaceId: string, actorUserId: string, slotsPerFloor: number, maxFloors: number): string {
  const floorId = db.tx(() => {
    const b = db.get<{ id: string; kind: string }>("SELECT id, kind FROM buildings WHERE workspace_id = ? AND kind = 'stoa' AND removed_at IS NULL ORDER BY created_at LIMIT 1", workspaceId);
    if (!b) throw notFound('construção');
    const info = db.get<{ n: number; top: number | null }>(
      'SELECT COUNT(*) AS n, MAX(level) AS top FROM floors WHERE building_id = ? AND removed_at IS NULL', b.id);
    const n = Number(info?.n ?? 0);
    const max = Math.min(maxFloors, typeOf(b.kind)?.floors.max ?? maxFloors);
    if (n >= max) throw new HttpError(409, 'max_floors', `A Stoa comporta até ${max} andares: para mais agentes, construa outra estrutura num lote livre.`);
    const level = info?.top === null || info?.top === undefined ? 0 : Number(info.top) + 1;
    const fid = id('flr');
    db.run(
      `INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'simulated', ?)`,
      fid, workspaceId, b.id, level, level === 0 ? 'Térreo' : `${level}º andar`, slotsPerFloor, now());
    audit(db, null, {
      workspaceId, actorType: 'user', actorId: actorUserId, action: 'floor.add_simulated', targetType: 'floor', targetId: fid,
      evidence: { level, slots: slotsPerFloor, payment: 'nenhum (versão local, grátis)' }, result: 'ok',
    });
    return fid;
  });
  bus.publish(workspaceId, 'agents.changed', { floor: floorId });
  return floorId;
}

export function removeFloor(db: Db, bus: Bus, workspaceId: string, actorUserId: string, floorId: string): void {
  try {
    db.tx(() => {
      const f = db.get<{ origin: string; level: number; building_id: string }>('SELECT origin, level, building_id FROM floors WHERE id = ? AND workspace_id = ? AND removed_at IS NULL', floorId, workspaceId);
      if (!f) throw notFound('andar');
      // o andar mais alto DESTA construção (cada construção tem a sua pilha)
      const top = db.get<{ top: number }>('SELECT MAX(level) AS top FROM floors WHERE building_id = ? AND removed_at IS NULL', f.building_id);
      if (Number(top?.top) !== Number(f.level)) throw new HttpError(409, 'not_top_floor', 'Remova somente o andar mais alto da construção.');
      if (f.origin === 'base') throw new HttpError(409, 'base_floor', 'Os andares que vêm com a construção não são removíveis.');
      db.run('UPDATE floors SET removed_at = ? WHERE id = ?', now(), floorId);
      audit(db, null, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'floor.remove', targetType: 'floor', targetId: floorId, result: 'ok' });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapCapacityError(err);
  }
  bus.publish(workspaceId, 'agents.changed', { floor: floorId });
}

/**
 * Garante o cargo fixo (idempotente, a cada início): exatamente um Coordenador por workspace, ativo, no setor de
 * coordenação, com a função e as ferramentas de coordenação — e só ele com o encaminhamento. Sem ninguém marcado,
 * marca quem coordena hoje (ou cria o da equipe de partida). Nome, história, aparência e foco não são tocados; as
 * instruções antigas, que traziam o protocolo junto, ficam só com o foco (o protocolo vai sempre nas instruções).
 */
export function ensureCoordinator(db: Db, bus: Bus | null, workspaceId: string, limits: AgentLimits): void {
  const fixed: string[] = [];
  const list = (v: string | null) => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  try {
    db.tx(() => {
      const sector = sectorByKey(db, workspaceId, COORDINATOR_SECTOR);
      type Row = { id: string; status: string; role: string; tools: string | null; charter: string | null; profile_id: string; floor_id: string };
      const read = () => db.get<Row>('SELECT id, status, role, tools, charter, profile_id, floor_id FROM agents WHERE workspace_id = ? AND coordinator = 1', workspaceId);
      let c = read();
      if (!c) {
        const cand = db.get<{ id: string }>(`SELECT a.id FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = ?
            ORDER BY (a.status = 'active') DESC, (a.tools LIKE '%"encaminhar"%') DESC, (p.key = 'coordenacao') DESC, (a.char_key = 'aristoteles') DESC, a.created_at, a.rowid LIMIT 1`, workspaceId);
        if (cand) db.run('UPDATE agents SET coordinator = 1 WHERE id = ?', cand.id);
        else {
          const ch = CHARACTERS.find((x) => x.key === 'aristoteles')!;
          const k = characterColumns(ch);
          const floor = pickFloor(db, workspaceId, null, null, bus ? { bus, actor: 'ergon', limits } : undefined);
          db.run(`INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, demo, created_at, char_key, bio, charter, skills, tools, model_hint, coordinator)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?, ?, 1)`,
            id('agt'), workspaceId, floor, sector.id, ch.name, COORDINATOR_ROLE, ch.color, now(), k.char_key, k.bio, db.seal(workspaceId, k.charter), k.skills, k.tools, k.model_hint);
          fixed.push('criado');
        }
        if (cand) fixed.push('marcado');
        c = read()!;
      }
      if (c.status !== 'active') {
        const free = db.get<{ ok: number }>(`SELECT (SELECT COUNT(*) FROM agents WHERE floor_id = f.id AND status = 'active') < f.slots AS ok
            FROM floors f WHERE f.id = ? AND f.removed_at IS NULL`, c.floor_id);
        const floor = free && Number(free.ok) ? c.floor_id : pickFloor(db, workspaceId, null, null, bus ? { bus, actor: 'ergon', limits } : undefined);
        db.run("UPDATE agents SET status = 'active', archived_at = NULL, deactivation_note = NULL, floor_id = ? WHERE id = ?", floor, c.id);
        fixed.push('reativado');
      }
      if (c.role !== COORDINATOR_ROLE) { db.run('UPDATE agents SET role = ? WHERE id = ?', COORDINATOR_ROLE, c.id); fixed.push('função'); }
      if (c.profile_id !== sector.id) { db.run('UPDATE agents SET profile_id = ? WHERE id = ?', sector.id, c.id); fixed.push('setor'); }
      const tools = list(c.tools);
      if (COORDINATOR_TOOLS.some((t) => !tools.includes(t))) { db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...new Set([...COORDINATOR_TOOLS, ...tools])]), c.id); fixed.push('ferramentas'); }
      const focus = coordinatorFocus(c.charter);
      if (focus !== (c.charter ?? '')) db.run('UPDATE agents SET charter = ? WHERE id = ?', db.seal(workspaceId, focus || null), c.id);
      // só o Coordenador encaminha
      for (const o of db.all<{ id: string; tools: string | null }>('SELECT id, tools FROM agents WHERE workspace_id = ? AND coordinator = 0', workspaceId)) {
        const t = list(o.tools);
        if (t.some((x) => COORDINATOR_ONLY.includes(x))) { db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(t.filter((x) => !COORDINATOR_ONLY.includes(x))), o.id); fixed.push('encaminhamento exclusivo'); }
      }
      if (fixed.length) audit(db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'agent.coordinator.ensure', targetType: 'agent', targetId: c.id, evidence: { fixed }, result: `Coordenador (cargo fixo) garantido: ${[...new Set(fixed)].join(', ')}` });
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    mapCapacityError(err);
  }
  if (fixed.length) bus?.publish(workspaceId, 'agents.changed', {});
}

/** Os cinco setores de partida com outro nome (um tema aplicado): o nome certo é o do perfil das boas-vindas ou o padrão. */
export function themedSectors(db: Db, workspaceId: string): Array<{ id: string; name: string; want: [string, string] }> {
  const choice = onboardingChoice(db, workspaceId);
  const preset = choice?.preset ? presetByKey(choice.preset) : undefined;
  const byKey = new Map(listSectors(db, workspaceId).map((x) => [x.key, x]));
  return SECTORS.flatMap((d) => {
    const cur = byKey.get(d.key);
    const want = (preset?.sectors as Record<string, [string, string]> | undefined)?.[d.key] ?? [d.name, d.description];
    return cur && cur.name !== want[0] ? [{ id: cur.id, name: cur.name, want }] : [];
  });
}

/** Personagens da equipe de partida que estão com outro nome ou outra história (um tema aplicado). */
export function themedCharacters(db: Db, workspaceId: string): Array<{ id: string; name: string; bio: string | null; key: string }> {
  return db.all<{ id: string; name: string; bio: string | null; char_key: string }>(
    'SELECT id, name, bio, char_key FROM agents WHERE workspace_id = ? AND char_key IS NOT NULL', workspaceId)
    .filter((a) => { const c = CHARACTERS.find((x) => x.key === a.char_key); return !!c && (a.name !== c.name || (a.bio ?? '') !== c.bio); })
    .map((a) => ({ id: a.id, name: a.name, bio: a.bio, key: a.char_key }));
}

/**
 * Volta ao tema padrão (Grécia clássica): cada personagem da equipe de partida recupera o nome e a história
 * originais, e os setores de partida voltam aos nomes do perfil escolhido. Funções, instruções e ferramentas ficam
 * como estão (são trabalho, não tema). Se outro
 * agente ativo já usa o nome original, aquele personagem fica como está e o motivo volta na resposta.
 */
export function restoreDefaultTheme(db: Db, bus: Bus, workspaceId: string, actorUserId: string): { restored: string[]; skipped: string[] } {
  const restored: string[] = []; const skipped: string[] = [];
  for (const a of themedCharacters(db, workspaceId)) {
    const c = CHARACTERS.find((x) => x.key === a.key)!;
    const clash = a.name !== c.name && db.get("SELECT 1 AS x FROM agents WHERE workspace_id = ? AND status = 'active' AND lower(name) = lower(?) AND id <> ?", workspaceId, c.name, a.id);
    if (clash) { skipped.push(`${a.name} (já existe outro agente chamado ${c.name})`); continue; }
    updateAgent(db, bus, workspaceId, actorUserId, a.id, { name: c.name, bio: c.bio });
    restored.push(a.name === c.name ? c.name : `${a.name} → ${c.name}`);
  }
  // os setores de partida voltam aos nomes do perfil escolhido nas boas-vindas (ou aos padrão)
  const choice = onboardingChoice(db, workspaceId);
  for (const x of themedSectors(db, workspaceId)) {
    db.run('UPDATE profiles SET name = ?, description = ?, custom = ? WHERE id = ?', x.want[0], x.want[1], choice?.preset && choice.preset !== 'geral' ? 1 : 0, x.id);
    restored.push(`setor ${x.name} → ${x.want[0]}`);
  }
  if (restored.length) { audit(db, bus, { workspaceId, actorType: 'user', actorId: actorUserId, action: 'team.theme.restore', evidence: { restored, skipped }, result: `tema padrão (Grécia clássica): ${restored.length} nome(s) e história(s) originais` }); bus.publish(workspaceId, 'agents.changed', {}); }
  return { restored, skipped };
}
