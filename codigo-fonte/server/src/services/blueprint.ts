/**
 * Esqueleto do workspace (shared/blueprint.ts): exportar a forma do workspace e aplicar a de outro.
 * Exportar nunca leva segredos, conexões, ferramentas liberadas, modelo/conta de IA, histórico, membros nem
 * direitos comerciais. Aplicar cria agentes SEM ferramentas e sem modelo próprio, mantém a coordenação no cargo
 * (muda só nome, história, instruções e aparência) e instala as rotinas PAUSADAS: nada liga sozinho.
 */
import { BLUEPRINT_FORMAT, BLUEPRINT_VERSION, validateBlueprint, type Blueprint, type BlueprintTrigger } from '../../../shared/blueprint.ts';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { VERSION } from '../version.ts';
import type { Bus } from './bus.ts';
import { createAgent, updateAgent, type AgentLimits } from './capacity.ts';
import type { Routines } from './routines.ts';
import { listSectors } from './sectors.ts';
import { createStructure, listStructures } from './structures.ts';

interface AgentRow { name: string; role: string; color: string; char_key: string | null; bio: string | null; charter: string | null; skills: string | null; look_seed: number | null; coordinator: number; sector_key: string }

const list = (s: string | null): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 30) : []; } catch { return []; } };
const cut = (s: string | null | undefined, n: number): string | null => (s ? s.slice(0, n) : null);

export function exportBlueprint(db: Db, routines: Routines, workspaceId: string): Blueprint {
  const ws = db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', workspaceId);
  if (!ws) throw new HttpError(404, 'not_found', 'workspace não encontrado');
  const sectors = listSectors(db, workspaceId).map((s) => ({
    key: s.key, name: s.name.slice(0, 80), description: cut(s.description, 600), instructions: (s.instructions ?? '').slice(0, 4000),
    createsTasks: s.creates_tasks === 'explicit_only' ? 'explicit_only' as const : 'demands' as const,
  }));
  const agents = db.all<AgentRow>(
    `SELECT a.name, a.role, a.color, a.char_key, a.bio, a.charter, a.skills, a.look_seed, a.coordinator, p.key AS sector_key
       FROM agents a JOIN profiles p ON p.id = a.profile_id AND p.workspace_id = a.workspace_id
      WHERE a.workspace_id = ? AND a.status = 'active' ORDER BY a.coordinator DESC, a.created_at, a.rowid`, workspaceId,
  ).map((a) => ({
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
  const v = validateBlueprint(bp);
  if (!v.ok) throw new HttpError(500, 'blueprint', `esqueleto gerado não confere: ${v.errors.slice(0, 3).join('; ')}`);
  return bp;
}

function cleanTrigger(t: unknown): BlueprintTrigger {
  const x = t as { kind?: string; days?: unknown; time?: unknown; tz?: unknown } | null;
  if (x?.kind === 'schedule' && Array.isArray(x.days) && typeof x.time === 'string') {
    return { kind: 'schedule', days: x.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).slice(0, 7) as number[], time: x.time, ...(typeof x.tz === 'string' ? { tz: x.tz } : {}) };
  }
  return { kind: 'manual' };
}

export interface BlueprintPlan {
  coordinator: { from: string; to: string } | null;
  agents: Array<{ name: string; role: string; sector: string }>;
  routines: Array<{ name: string; template: string; status: 'paused' }>;
  structures: Array<{ kind: string; name: string }>;
  skipped: string[];
}

/** Prévia (apply=false) ou aplicação do esqueleto no workspace. Nada liga sozinho: rotinas entram pausadas. */
export function importBlueprint(db: Db, bus: Bus, routines: Routines, workspaceId: string, userId: string, input: unknown, apply: boolean, limits: AgentLimits): BlueprintPlan & { applied: boolean } {
  const v = validateBlueprint(input);
  if (!v.ok) throw new HttpError(400, 'blueprint_invalid', `Esqueleto recusado: ${v.errors.slice(0, 5).join('; ')}`);
  const bp = v.blueprint;
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
  const library = new Set((routines.library(workspaceId) as { routines: Array<{ key: string; available?: boolean }> }).routines.filter((r) => r.available !== false).map((r) => r.key));
  for (const r of bp.routines) {
    if (!library.has(r.template)) { plan.skipped.push(`rotina "${r.name}": modelo ${r.template} não existe nesta versão`); continue; }
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
  for (const s of bp.structures) {
    if (kinds.has(`${s.kind}@${s.i},${s.j}`)) continue;
    try { createStructure(db, bus, workspaceId, userId, { kind: s.kind, i: s.i, j: s.j, name: s.name }); } catch (e) { plan.skipped.push(`construção "${s.name}": ${(e as Error).message}`); }
  }
  return { ...plan, applied: true };
}
