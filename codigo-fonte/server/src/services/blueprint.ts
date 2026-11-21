/**
 * Esqueleto do workspace (shared/blueprint.ts): exportar a forma do workspace e aplicar a de outro.
 *
 * Dois usos, com regras diferentes:
 * - ARQUIVO (Exportar, Loja, pacote): nunca leva segredos, conexões, ferramentas liberadas, modelo/conta de IA,
 *   histórico, membros nem direitos comerciais. Aplicar cria agentes SEM ferramentas e sem modelo próprio, mantém a
 *   coordenação no cargo (muda só nome, história, instruções e aparência), pula o agente que já existe e instala as
 *   rotinas PAUSADAS (sem repetir a que já está instalada): nada liga sozinho.
 * - SINCRONIA do workspace (world/sync-local.ts, cifrada de ponta a ponta), aplicada SÓ quando vem de um aparelho da
 *   conta DONA do workspace (o World diz o autor de cada mudança; o esqueleto de um colaborador é ignorado): leva também a parte
 *   privada (BlueprintSync) e quem recebe CONCILIA pela identidade estável (`ref`: o id no aparelho de origem, gravado em
 *   agents.sync_ref / routines.sync_ref): cria o que falta, atualiza o que mudou (papel, instruções, competências,
 *   ferramentas, aparência, setor, modelo), arquiva o que saiu — sem duplicar e sem tocar no que é deste aparelho
 *   (execuções, conversas, histórico). Os setores do esqueleto (nome, descrição, instruções) valem aqui também.
 *   Na NUVEM do World (um gêmeo da equipe do computador), as rotinas ficam no estado do computador (ativas = ativas):
 *   quem executa cada horário é decidido pela posse (world/nuvem.ts), nunca os dois. Num COMPUTADOR que recebe de outro
 *   computador, a rotina nova chega PAUSADA (os dois executariam o mesmo horário, e as contas ligadas são de cada
 *   aparelho) e a que já existe mantém o estado escolhido aqui.
 *   Modelo de IA: na nuvem, só o do Ergon AI viaja (decisão de produto: a chave própria da pessoa não sai do computador
 *   nesta versão); outro modelo vira o padrão da equipe lá, que é o Ergon AI.
 */
import { BLUEPRINT_FORMAT, BLUEPRINT_VERSION, validateBlueprint, type Blueprint, type BlueprintAgent, type BlueprintSync, type BlueprintSyncRoutine, type BlueprintTrigger } from '../../../shared/blueprint.ts';
import type { Db } from '../db/db.ts';
import { HttpError, id, now } from '../lib/util.ts';
import { VERSION } from '../version.ts';
import { APELIDOS_ERGON_AI } from './ai.ts';
import { audit, type Bus } from './bus.ts';
import { archiveAgent, createAgent, reactivateAgent, updateAgent, type AgentLimits } from './capacity.ts';
import { TOOLS } from './characters.ts';
import type { Routines } from './routines.ts';
import { getSetting, listSectors, setSetting } from './sectors.ts';
import { createStructure, listStructures } from './structures.ts';
import { COORDINATOR_TOOLS } from './team.ts';

interface AgentRow {
  id: string; sync_ref: string | null; name: string; role: string; color: string; char_key: string | null; bio: string | null; charter: string | null; skills: string | null;
  tools: string | null; hermes_skills: string | null; model: string | null; provider: string | null; look_seed: number | null; coordinator: number; status: string; sector_key: string;
}

const list = (s: string | null, max = 30): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max) : []; } catch { return []; } };
const cut = (s: string | null | undefined, n: number): string | null => (s ? s.slice(0, n) : null);
const AGENT_SQL = `SELECT a.id, a.sync_ref, a.name, a.role, a.color, a.char_key, a.bio, a.charter, a.skills, a.tools, a.hermes_skills, a.model, a.provider, a.look_seed, a.coordinator, a.status,
    p.key AS sector_key FROM agents a JOIN profiles p ON p.id = a.profile_id AND p.workspace_id = a.workspace_id WHERE a.workspace_id = ?`;
/** a identidade que viaja: a de origem (veio de outro aparelho) ou o próprio id (nasceu aqui) */
const refOf = (x: { id: string; sync_ref: string | null }) => x.sync_ref ?? x.id;
/** as ferramentas da equipe que a pessoa escolhe (Configurações › Ferramentas: 'ferramentas.<id>') */
const TEAM_TOOL_IDS = Object.values(TOOLS).filter((t) => (t.safe || t.guarded) && t.toolset).map((t) => t.id);

/**
 * As ferramentas da equipe mudaram por um esqueleto recebido (a nuvem passou a ter o que o computador escolheu): o app
 * registra aqui como levar a escolha ao motor de IA já, sem esperar a próxima partida.
 */
const aoMudarFerramentas = new WeakMap<Db, (workspaceId: string) => void>();
export function setAoMudarFerramentasDaEquipe(db: Db, fn: (workspaceId: string) => void): void { aoMudarFerramentas.set(db, fn); }

export function exportBlueprint(db: Db, routines: Routines, workspaceId: string, opts: { /** a parte privada da sincronia entre os aparelhos da pessoa */ sync?: boolean } = {}): Blueprint {
  const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', workspaceId);
  if (!ws) throw new HttpError(404, 'not_found', 'workspace não encontrado');
  const sectors = listSectors(db, workspaceId).map((s) => ({
    key: s.key, name: s.name.slice(0, 80), description: cut(s.description, 600), instructions: (s.instructions ?? '').slice(0, 4000),
    createsTasks: s.creates_tasks === 'explicit_only' ? 'explicit_only' as const : 'demands' as const,
  }));
  const rows = db.all<AgentRow>(`${AGENT_SQL} AND a.status = 'active' ORDER BY a.coordinator DESC, a.created_at, a.rowid`, workspaceId);
  const agents = rows.map((a) => ({
    name: a.name.slice(0, 60), role: a.role.slice(0, 120), sectorKey: a.sector_key, charter: cut(a.charter, 4000), bio: cut(a.bio, 2000),
    skills: list(a.skills), color: /^#[0-9a-f]{3,8}$/i.test(a.color) ? a.color : '#888888',
    lookSeed: a.look_seed === null ? null : Number(a.look_seed), coordinator: Number(a.coordinator) === 1, charKey: cut(a.char_key, 40),
  }));
  const structures = listStructures(db, workspaceId).map((s) => ({ kind: s.kind, name: s.name.slice(0, 80), i: s.i, j: s.j, floors: s.floors.length }));
  const agentNames = new Map(db.all<{ id: string; name: string }>('SELECT id, name FROM agents WHERE workspace_id = ?', workspaceId).map((a) => [a.id, a.name]));
  const routineList = (routines.list(workspaceId) as Array<{ template: string | null; name: string; status: string; agentId?: string | null; trigger: unknown }>)
    .filter((r) => r.template && r.status !== 'archived')
    .map((r) => ({ template: r.template!, name: r.name.slice(0, 120), trigger: cleanTrigger(r.trigger), agentName: (r.agentId && agentNames.get(r.agentId)) || null }));
  const bp: Blueprint = {
    format: BLUEPRINT_FORMAT, version: BLUEPRINT_VERSION, createdAt: new Date().toISOString(), ergonVersion: VERSION,
    workspace: { name: ws.name.slice(0, 80) }, sectors, agents, structures, routines: routineList,
  };
  if (opts.sync) bp.sync = exportSync(db, routines, workspaceId, rows);
  const v = validateBlueprint(bp, { sync: opts.sync });
  if (!v.ok) throw new HttpError(500, 'blueprint', `esqueleto gerado não confere: ${v.errors.slice(0, 3).join('; ')}`);
  return bp;
}

function exportSync(db: Db, routines: Routines, workspaceId: string, rows: AgentRow[]): BlueprintSync {
  const agents = rows.map((a) => ({
    ref: refOf(a), name: a.name.slice(0, 60), tools: list(a.tools).filter((t) => TOOLS[t]), hermesSkills: list(a.hermes_skills, 200).filter((s) => s.length <= 80),
    model: cut(a.model, 120), provider: a.model ? cut(a.provider, 80) : null,
  }));
  const rts = routines.paraEspelho(workspaceId).map((r) => ({ ...r, name: r.name.slice(0, 120), trigger: cleanTrigger(r.trigger) }));
  const teamTools = TEAM_TOOL_IDS.flatMap((t) => {
    const v = getSetting(db, workspaceId, `ferramentas.${t}`);
    return v === 'ligado' || v === 'desligado' ? [{ id: t, state: v as 'ligado' | 'desligado' }] : [];
  });
  return { agents, routines: rts, teamTools };
}

function cleanTrigger(t: unknown): BlueprintTrigger {
  const x = t as { kind?: string; days?: unknown; time?: unknown; tz?: unknown } | null;
  if (x?.kind === 'schedule' && Array.isArray(x.days) && typeof x.time === 'string') {
    return { kind: 'schedule', days: x.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).slice(0, 7) as number[], time: x.time, ...(typeof x.tz === 'string' ? { tz: x.tz } : {}) };
  }
  return { kind: 'manual' };
}

interface BlueprintPlan {
  coordinator: { from: string; to: string } | null;
  agents: Array<{ name: string; role: string; sector: string }>;
  routines: Array<{ name: string; template: string; status: 'paused' | 'active' }>;
  structures: Array<{ kind: string; name: string }>;
  skipped: string[];
  /** sincronia: o que muda no que já existe e o que sai */
  updated?: string[]; archived?: string[]; sectors?: string[];
}

export interface ImportOpts {
  /** veio da sincronia cifrada entre os aparelhos da pessoa: concilia pela identidade (e aceita a parte privada) */
  sync?: boolean;
  /** este Ergon é a nuvem do World (o gêmeo da equipe do computador): rotinas no estado do computador, sobras arquivadas */
  nuvem?: boolean;
  /**
   * as ferramentas que executam código (Terminal, Executar código) podem ligar por este esqueleto: só na nuvem do próprio
   * dono. Fora dela, a que chega e não está ligada aqui fica desligada, esperando a confirmação com a senha neste aparelho
   * (guardadasPendentes); desligar continua valendo.
   */
  ligarGuardadas?: boolean;
}

/** As ferramentas que executam código e chegaram pela sincronia sem ligar aqui (esperando a confirmação com a senha). */
export interface GuardadasPendentes { equipe: string[]; agentes: Array<{ agentId: string; tool: string }> }
const PENDENTES = 'sincronia.guardadas';
export function guardadasPendentes(db: Db, ws: string): GuardadasPendentes & { itens: Array<{ tool: string; label: string; agente: string | null; agentId: string | null }> } {
  let v: GuardadasPendentes = { equipe: [], agentes: [] };
  try { const x = JSON.parse(getSetting(db, ws, PENDENTES) ?? 'null') as GuardadasPendentes | null; if (x && Array.isArray(x.equipe) && Array.isArray(x.agentes)) v = x; } catch { /* vazio */ }
  const equipe = v.equipe.filter((t) => TOOLS[t]?.guarded && getSetting(db, ws, `ferramentas.${t}`) !== 'ligado');
  const agentes = v.agentes.filter((a) => TOOLS[a.tool]?.guarded && db.get("SELECT 1 AS x FROM agents WHERE id = ? AND workspace_id = ? AND status = 'active'", a.agentId, ws)
    && !list(db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ? AND workspace_id = ?', a.agentId, ws)?.tools ?? null).includes(a.tool));
  const nome = (id: string) => db.get<{ name: string }>('SELECT name FROM agents WHERE id = ? AND workspace_id = ?', id, ws)?.name ?? null;
  return { equipe, agentes, itens: [...equipe.map((t) => ({ tool: t, label: TOOLS[t].label, agente: null, agentId: null })), ...agentes.map((a) => ({ tool: a.tool, label: TOOLS[a.tool].label, agente: nome(a.agentId), agentId: a.agentId }))] };
}
/** Esquece o que estava esperando (a pessoa decidiu: ligou com a senha ou deixou desligado). */
export function limparGuardadas(db: Db, ws: string): void { setSetting(db, ws, PENDENTES, JSON.stringify({ equipe: [], agentes: [] })); }

/** Prévia (apply=false) ou aplicação do esqueleto no workspace. Fora da sincronia, nada liga sozinho: rotinas entram pausadas. */
export function importBlueprint(db: Db, bus: Bus, routines: Routines, workspaceId: string, userId: string, input: unknown, apply: boolean, limits: AgentLimits, opts: ImportOpts = {}): BlueprintPlan & { applied: boolean } {
  const v = validateBlueprint(input, { sync: opts.sync });
  if (!v.ok) throw new HttpError(400, 'blueprint_invalid', `Esqueleto recusado: ${v.errors.slice(0, 5).join('; ')}`);
  const bp = v.blueprint;
  // da sincronia com a parte privada: concilia. Um computador de versão anterior manda sem ela: vale a regra do arquivo
  if (opts.sync && bp.sync) return conciliar(db, bus, routines, workspaceId, userId, bp as Blueprint & { sync: BlueprintSync }, apply, limits, opts.nuvem === true, opts.ligarGuardadas === true);
  const sectorKeys = new Set(listSectors(db, workspaceId).map((s) => s.key));
  const existing = new Set(db.all<{ name: string }>("SELECT name FROM agents WHERE workspace_id = ? AND status = 'active'", workspaceId).map((a) => a.name.toLowerCase()));
  const coord = db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", workspaceId);
  const plan: BlueprintPlan = { coordinator: null, agents: [], routines: [], structures: [], skipped: [] };
  const bpCoord = bp.agents.find((a) => a.coordinator);
  if (bpCoord && coord && bpCoord.name !== coord.name) plan.coordinator = { from: coord.name, to: bpCoord.name };
  for (const a of bp.agents.filter((x) => !x.coordinator)) {
    if (existing.has(a.name.toLowerCase())) { plan.skipped.push(`agente "${a.name}" já existe`); continue; }
    plan.agents.push({ name: a.name, role: a.role, sector: sectorKeys.has(a.sectorKey) ? a.sectorKey : 'auto' });
  }
  const library = new Set((routines.library(workspaceId) as { routines: Array<{ key: string }> }).routines.map((r) => r.key));
  // a mesma rotina (modelo e nome) já instalada não entra de novo: aplicar o mesmo esqueleto duas vezes dá no mesmo
  const installed = new Set(db.all<{ template_key: string; name: string }>("SELECT template_key, name FROM routines WHERE workspace_id = ? AND status != 'archived' AND template_key IS NOT NULL", workspaceId).map((r) => `${r.template_key}|${r.name.toLowerCase()}`));
  for (const r of bp.routines) {
    if (!library.has(r.template)) { plan.skipped.push(`rotina "${r.name}": modelo ${r.template} não existe nesta versão`); continue; }
    if (installed.has(`${r.template}|${r.name.toLowerCase()}`)) { plan.skipped.push(`rotina "${r.name}" já está instalada`); continue; }
    installed.add(`${r.template}|${r.name.toLowerCase()}`);
    plan.routines.push({ name: r.name, template: r.template, status: 'paused' });
  }
  const kinds = new Set(listStructures(db, workspaceId).map((s) => `${s.kind}@${s.i},${s.j}`));
  for (const s of bp.structures) if (!kinds.has(`${s.kind}@${s.i},${s.j}`)) plan.structures.push({ kind: s.kind, name: s.name });
  if (!apply) return { ...plan, applied: false };

  if (bpCoord && coord) {
    updateAgent(db, bus, workspaceId, userId, coord.id, { name: bpCoord.name, charter: bpCoord.charter ?? undefined });
    db.run('UPDATE agents SET bio = ?, look_seed = COALESCE(?, look_seed) WHERE id = ? AND workspace_id = ?', bpCoord.bio, bpCoord.lookSeed, coord.id, workspaceId);
  }
  for (const p of plan.agents) {
    const a = bp.agents.find((x) => x.name === p.name)!;
    try {
      const made = createAgent(db, bus, workspaceId, userId, { name: a.name, role: a.role, sectorKey: p.sector, charter: a.charter, skills: a.skills, color: a.color }, limits);
      db.run('UPDATE agents SET bio = ?, look_seed = ? WHERE id = ? AND workspace_id = ?', a.bio, a.lookSeed, made.id, workspaceId);
    } catch (e) { plan.skipped.push(`agente "${a.name}": ${(e as Error).message}`); }
  }
  for (const r of plan.routines) {
    const src = bp.routines.find((x) => x.name === r.name && x.template === r.template)!;
    try {
      const made = routines.install(workspaceId, userId, src.template, { trigger: src.trigger }) as { id: string };
      routines.update(workspaceId, userId, made.id, { status: 'paused' }, 'importada de um esqueleto (pausada)');
    } catch (e) { plan.skipped.push(`rotina "${r.name}": ${(e as Error).message}`); }
  }
  aplicarConstrucoes(db, bus, workspaceId, userId, bp, kinds, plan);
  return { ...plan, applied: true };
}

function aplicarConstrucoes(db: Db, bus: Bus, workspaceId: string, userId: string, bp: Blueprint, kinds: Set<string>, plan: BlueprintPlan): void {
  for (const s of bp.structures) {
    if (kinds.has(`${s.kind}@${s.i},${s.j}`)) continue;
    try { createStructure(db, bus, workspaceId, userId, { kind: s.kind, i: s.i, j: s.j, name: s.name }); } catch (e) { plan.skipped.push(`construção "${s.name}": ${(e as Error).message}`); }
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A sincronia: concilia o workspace daqui com o esqueleto de outro aparelho da pessoa pela identidade estável. A
 * primeira vez depois da atualização (agentes e rotinas sem referência, de antes), adota pelo nome (agente) ou pelo
 * modelo e nome (rotina), e as duplicatas que a versão anterior deixou saem.
 */
function conciliar(db: Db, bus: Bus, routines: Routines, ws: string, userId: string, bp: Blueprint & { sync: BlueprintSync }, apply: boolean, limits: AgentLimits, nuvem: boolean, ligarGuardadas: boolean): BlueprintPlan & { applied: boolean } {
  const plan: BlueprintPlan = { coordinator: null, agents: [], routines: [], structures: [], skipped: [], updated: [], archived: [], sectors: [] };
  // as ferramentas que executam código: fora da nuvem do dono, a que o agente daqui ainda não tem não chega ligada
  const pendentes: GuardadasPendentes = { equipe: [], agentes: [] };
  const semGuardadas = (local: AgentRow | null, x: BlueprintSync['agents'][number]) => (ligarGuardadas ? x : { ...x, tools: x.tools.filter((t) => !TOOLS[t]?.guarded || (local ? list(local.tools).includes(t) : false)) });
  // ---- setores (a chave é a identidade: renomear mantém a chave)
  const sectors = new Map(listSectors(db, ws).map((s) => [s.key, s]));
  const sectorOps: Array<() => void> = [];
  for (const s of bp.sectors) {
    const cur = sectors.get(s.key);
    if (!cur) {
      plan.sectors!.push(`setor novo: ${s.name}`);
      sectorOps.push(() => db.run(`INSERT INTO profiles (id, workspace_id, key, name, instructions, examples, creates_tasks, description, tools, skills, position, custom)
        VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, '[]', ?, 1)`, id('prf'), ws, s.key, s.name.slice(0, 60), s.instructions, s.createsTasks, s.description,
        JSON.stringify(sectors.get('central')?.tools.filter((t) => t !== 'conexoes') ?? []), sectors.size + sectorOps.length));
    } else if (cur.name !== s.name.slice(0, 60) || (cur.description ?? null) !== s.description || (cur.instructions ?? '') !== s.instructions || cur.creates_tasks !== s.createsTasks) {
      plan.sectors!.push(`setor ${s.name}`);
      // passa a ser da pessoa (como editar pela tela): o Ergon não o restaura ao iniciar
      sectorOps.push(() => db.run('UPDATE profiles SET name = ?, description = ?, instructions = ?, creates_tasks = ?, custom = 1 WHERE id = ?', s.name.slice(0, 60), s.description, s.instructions, s.createsTasks, cur.id));
    }
  }
  // ---- agentes
  const locals = db.all<AgentRow>(AGENT_SQL, ws);
  const byRef = new Map(locals.map((a) => [refOf(a), a]));
  const extra = new Map(bp.sync.agents.map((x) => [x.name.toLowerCase(), x]));
  const usados = new Set<string>();
  const coordLocal = locals.find((a) => Number(a.coordinator) === 1 && a.status === 'active');
  type Passo = { bp: BlueprintAgent; ref: string; local: AgentRow | null };
  const passos: Passo[] = [];
  for (const a of bp.agents) {
    const ref = extra.get(a.name.toLowerCase())?.ref;
    if (!ref) { plan.skipped.push(`agente "${a.name}": sem identidade no esqueleto`); continue; }
    let local: AgentRow | null = a.coordinator ? coordLocal ?? null : byRef.get(ref) ?? null;
    if (local && (usados.has(local.id) || (!a.coordinator && Number(local.coordinator) === 1))) local = null;
    // de antes da identidade: o mesmo nome, ainda sem referência (o que a versão anterior criou pelo nome)
    local ??= locals.find((x) => !usados.has(x.id) && x.status === 'active' && !x.sync_ref && Number(x.coordinator) !== 1 && x.name.toLowerCase() === a.name.toLowerCase() && !bp.sync.agents.some((y) => y.ref === x.id)) ?? null;
    if (local) usados.add(local.id);
    passos.push({ bp: a, ref, local });
    if (!local) plan.agents.push({ name: a.name, role: a.role, sector: sectors.has(a.sectorKey) || bp.sectors.some((s) => s.key === a.sectorKey) ? a.sectorKey : 'auto' });
    else if (a.coordinator && local.name !== a.name) plan.coordinator = { from: local.name, to: a.name };
    else if (local.status !== 'active' || agentPatch(local, a, semGuardadas(local, extra.get(a.name.toLowerCase())!), nuvem, true)) plan.updated!.push(a.name);
  }
  // quem saiu do outro aparelho: na nuvem, todo agente que não está no esqueleto (ela espelha o computador); num
  // computador, só o que veio de outro aparelho (o que nasceu aqui fica)
  const sair = locals.filter((x) => x.status === 'active' && Number(x.coordinator) !== 1 && !usados.has(x.id) && (nuvem || x.sync_ref !== null));
  for (const x of sair) plan.archived!.push(x.name);
  // ---- rotinas
  const localRoutines = db.all<{ id: string; sync_ref: string | null; template_key: string | null; name: string; status: string }>("SELECT id, sync_ref, template_key, name, status FROM routines WHERE workspace_id = ? AND status != 'archived' ORDER BY created_at, rowid", ws);
  const rByRef = new Map(localRoutines.map((r) => [refOf(r), r]));
  const rUsadas = new Set<string>();
  const rPassos: Array<{ src: BlueprintSyncRoutine; localId: string | null }> = [];
  for (const r of bp.sync.routines) {
    let local = rByRef.get(r.ref) ?? null;
    if (local && rUsadas.has(local.id)) local = null;
    local ??= localRoutines.find((x) => !rUsadas.has(x.id) && !x.sync_ref && x.template_key === r.template && x.name.toLowerCase() === r.name.toLowerCase() && !bp.sync.routines.some((y) => y.ref === x.id)) ?? null;
    if (local) rUsadas.add(local.id);
    rPassos.push({ src: r, localId: local?.id ?? null });
    if (!local) plan.routines.push({ name: r.name, template: r.template ?? '', status: nuvem ? r.status : 'paused' });
  }
  const rSair = localRoutines.filter((x) => !rUsadas.has(x.id) && (nuvem || x.sync_ref !== null));
  for (const x of rSair) plan.archived!.push(`rotina ${x.name}`);
  const kinds = new Set(listStructures(db, ws).map((s) => `${s.kind}@${s.i},${s.j}`));
  for (const s of bp.structures) if (!kinds.has(`${s.kind}@${s.i},${s.j}`)) plan.structures.push({ kind: s.kind, name: s.name });
  if (!apply) return { ...plan, applied: false };

  // ---- aplicar: setores primeiro (os agentes podem ir para um setor novo)
  if (sectorOps.length) { db.tx(() => { for (const op of sectorOps) op(); }); bus.publish(ws, 'agents.changed', {}); }
  const setoresAqui = new Set(listSectors(db, ws).map((s) => s.key));
  // arquivar antes de criar: libera o nome e a vaga de quem sai (um agente renomeado no outro aparelho não colide)
  for (const x of sair) {
    try { archiveAgent(db, bus, ws, userId, x.id); }
    catch (e) { plan.skipped.push(`agente "${x.name}" não saiu: ${(e as Error).message}`); }
  }
  for (const p of passos) {
    const x = extra.get(p.bp.name.toLowerCase())!;
    try {
      let local = p.local;
      if (!local) {
        const sectorKey = setoresAqui.has(p.bp.sectorKey) ? p.bp.sectorKey : 'auto';
        const made = createAgent(db, bus, ws, userId, { name: p.bp.name, role: p.bp.role, sectorKey, charter: p.bp.charter, skills: p.bp.skills, color: p.bp.color, lookSeed: p.bp.lookSeed, hermesSkills: x.hermesSkills }, limits);
        db.run('UPDATE agents SET sync_ref = ?, char_key = ? WHERE id = ? AND workspace_id = ?', made.id === p.ref ? null : p.ref, p.bp.charKey, made.id, ws);
        local = db.get<AgentRow>(`${AGENT_SQL} AND a.id = ?`, ws, made.id)!;
      } else {
        if (local.status !== 'active') reactivateAgent(db, bus, ws, userId, local.id, null, limits);
        if (refOf(local) !== p.ref) db.run('UPDATE agents SET sync_ref = ? WHERE id = ? AND workspace_id = ?', local.id === p.ref ? null : p.ref, local.id, ws);
      }
      const x2 = semGuardadas(local, x);
      for (const t of x.tools) if (!x2.tools.includes(t) && !pendentes.agentes.some((y) => y.agentId === local!.id && y.tool === t)) pendentes.agentes.push({ agentId: local.id, tool: t });
      const patch = agentPatch(local, p.bp, x2, nuvem, setoresAqui.has(p.bp.sectorKey));
      if (patch) updateAgent(db, bus, ws, userId, local.id, patch);
      if ((local.char_key ?? null) !== p.bp.charKey && !Number(local.coordinator)) db.run('UPDATE agents SET char_key = ? WHERE id = ? AND workspace_id = ?', p.bp.charKey, local.id, ws);
    } catch (e) { plan.skipped.push(`agente "${p.bp.name}": ${(e as Error).message}`); }
  }
  // ---- rotinas
  for (const x of rSair) {
    try { routines.archive(ws, userId, x.id); } catch (e) { plan.skipped.push(`rotina "${x.name}" não saiu: ${(e as Error).message}`); }
  }
  for (const p of rPassos) {
    try { routines.espelhar(ws, userId, p.localId, p.src, { estado: nuvem ? 'do_outro' : p.localId ? 'manter' : 'pausada' }); }
    catch (e) { plan.skipped.push(`rotina "${p.src.name}": ${(e as Error).message}`); }
  }
  // ---- ferramentas da equipe (a escolha da pessoa; ausente = o padrão daqui)
  let mudou = false;
  for (const t of bp.sync.teamTools) {
    if (!TEAM_TOOL_IDS.includes(t.id) || getSetting(db, ws, `ferramentas.${t.id}`) === t.state) continue;
    if (t.state === 'ligado' && TOOLS[t.id]?.guarded && !ligarGuardadas) { pendentes.equipe.push(t.id); continue; }
    setSetting(db, ws, `ferramentas.${t.id}`, t.state); mudou = true;
  }
  // o que ficou esperando a senha (o esqueleto mais recente decide: o que saiu dele deixa de esperar)
  setSetting(db, ws, PENDENTES, JSON.stringify(pendentes));
  if (pendentes.equipe.length || pendentes.agentes.length) audit(db, bus, { workspaceId: ws, actorType: 'system', actorId: 'sincronia', action: 'ai.tools_pending',
    evidence: { equipe: pendentes.equipe, agentes: pendentes.agentes.length }, result: 'ferramentas que executam código vieram desligadas da sincronia: ligam só com a confirmação (senha) neste aparelho' });
  if (mudou) {
    audit(db, bus, { workspaceId: ws, actorType: 'system', actorId: 'sincronia', action: 'ai.tools', evidence: { teamTools: bp.sync.teamTools }, result: 'ferramentas da equipe como no outro aparelho' });
    try { aoMudarFerramentas.get(db)?.(ws); } catch { /* o motor recebe na próxima abertura */ }
  }
  aplicarConstrucoes(db, bus, ws, userId, bp, kinds, plan);
  if (plan.updated!.length || plan.archived!.length || plan.agents.length) audit(db, bus, { workspaceId: ws, actorType: 'system', actorId: 'sincronia', action: 'team.sync',
    evidence: { novos: plan.agents.map((a) => a.name), mudaram: plan.updated, sairam: plan.archived, setores: plan.sectors, at: now() }, result: 'equipe como no outro aparelho' });
  return { ...plan, applied: true };
}

/** O que muda num agente daqui para ficar como no outro aparelho (null = nada). */
function agentPatch(local: AgentRow, a: BlueprintAgent, x: { tools: string[]; hermesSkills: string[]; model: string | null; provider: string | null }, nuvem: boolean, setorExiste: boolean): Parameters<typeof updateAgent>[5] | null {
  const coord = Number(local.coordinator) === 1;
  const p: Parameters<typeof updateAgent>[5] = {};
  if (local.name !== a.name) p.name = a.name;
  if (!coord && local.role !== a.role.slice(0, 80)) p.role = a.role.slice(0, 80);
  if (!coord && setorExiste && local.sector_key !== a.sectorKey) p.sectorKey = a.sectorKey;
  if ((local.charter ?? '') !== (a.charter ?? '')) p.charter = a.charter ?? '';
  if ((local.bio ?? null) !== (a.bio ? a.bio.slice(0, 600) : null)) p.bio = a.bio;
  if (!sameList(list(local.skills), a.skills.slice(0, 12))) p.skills = a.skills;
  if (/^#[0-9a-f]{6}$/i.test(a.color) && local.color !== a.color) p.color = a.color;
  if (a.lookSeed !== null && Number(local.look_seed) !== a.lookSeed) p.lookSeed = a.lookSeed;
  // a coordenação mantém as ferramentas do cargo; o resto vem como está lá
  const tools = [...new Set(coord ? [...x.tools, ...COORDINATOR_TOOLS] : x.tools)].filter((t) => TOOLS[t]).slice(0, 20);
  if (!sameList(list(local.tools), tools)) p.tools = tools;
  if (!sameList(list(local.hermes_skills, 200), x.hermesSkills)) p.hermesSkills = x.hermesSkills;
  // o modelo: na nuvem só o do Ergon AI (a chave própria da pessoa não sai do computador); outro vira o padrão (Ergon AI)
  const ergonAi = !!x.provider && (APELIDOS_ERGON_AI as readonly string[]).some((n) => x.provider === n || x.provider === `custom:${n}`);
  const model = nuvem && !ergonAi ? null : x.model;
  if ((local.model ?? null) !== model || (model && (local.provider ?? null) !== x.provider)) { p.model = model; p.provider = model ? x.provider : null; }
  return Object.keys(p).length ? p : null;
}
