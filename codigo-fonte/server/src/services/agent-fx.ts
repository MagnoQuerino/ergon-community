/**
 * Efeito pessoal de cada agente, escolhido entre os efeitos dos Pacotes instalados (só aparência: não muda
 * competência, ferramenta, modelo nem capacidade). Três estados, sem ambiguidade:
 *   - herdar (sem linha ou 'inherit'): vale o que os pacotes já definem pelos alvos deles (todos, nome, personagem);
 *   - 'off': nenhum efeito de pacote neste agente;
 *   - 'custom': só o efeito escolhido (substitui os dos alvos, para não aplicar duas vezes).
 * O vínculo é por agente (id), então renomear não perde a escolha. Pacote desinstalado: quem usava volta a herdar,
 * de forma explícita (releasePackageFx), e o agente fica como está.
 */
import type { Db } from '../db/db.ts';
import { HttpError, now } from '../lib/util.ts';
import type { PackageData, Target } from './ergon-package.ts';

export const FX_LABEL: Record<string, string> = { aura: 'Aura', celestial_glow: 'Brilho celeste', fire_circle: 'Círculo de fogo', fire_trail: 'Rastro de fogo' };

/** `target`: a quem o pacote já aplica o efeito (herdar = esses alvos), para a prévia da criação mostrar o que vai valer. */
export interface FxOption { id: string; packageId: string; item: number; title: string; effect: string; label: string; color: string; intensity: number; target: Target }
export type FxChoice = { mode: 'inherit' } | { mode: 'off' } | { mode: 'custom'; option: string };
export interface FxEffect { agentId: string; effect: string; color: string; intensity: number }

/** Efeitos utilizáveis: os dos pacotes de efeito instalados e ativos neste workspace (a loja é outro caminho). */
export function fxOptions(db: Db, workspaceId: string): FxOption[] {
  const rows = db.all<{ id: string; title: string; data: string }>("SELECT id, title, data FROM installed_packages WHERE workspace_id = ? AND status = 'active' AND kind = 'fx' ORDER BY installed_at", workspaceId);
  return rows.flatMap((r) => {
    let d: PackageData; try { d = JSON.parse(r.data) as PackageData; } catch { return []; }
    return (d.effects ?? []).map((e, item) => ({ id: `${r.id}:${item}`, packageId: r.id, item, title: r.title, effect: e.effect, label: FX_LABEL[e.effect] ?? e.effect, color: e.color, intensity: e.intensity, target: e.target }));
  });
}

/** Valida e grava a escolha (dentro da transação de quem chama, quando houver). */
export function setAgentFx(db: Db, workspaceId: string, agentId: string, c: FxChoice): void {
  if (!db.get('SELECT 1 AS x FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId)) throw new HttpError(404, 'not_found', 'agente não encontrado');
  if (c.mode === 'inherit') { db.run('DELETE FROM agent_fx WHERE workspace_id = ? AND agent_id = ?', workspaceId, agentId); return; }
  let pkg: string | null = null; let item: number | null = null;
  if (c.mode === 'custom') {
    const opt = fxOptions(db, workspaceId).find((o) => o.id === c.option);
    if (!opt) throw new HttpError(409, 'fx_unavailable', 'Este efeito não está instalado (ou o pacote foi removido): escolha outro em Pacotes.');
    pkg = opt.packageId; item = opt.item;
  }
  db.run(`INSERT INTO agent_fx (workspace_id, agent_id, mode, package_id, item, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, agent_id) DO UPDATE SET mode = excluded.mode, package_id = excluded.package_id, item = excluded.item, updated_at = excluded.updated_at`,
  workspaceId, agentId, c.mode, pkg, item, now());
}

export function agentFxChoice(db: Db, workspaceId: string, agentId: string): { mode: 'inherit' | 'off' | 'custom'; option: string | null } {
  const r = db.get<{ mode: 'inherit' | 'off' | 'custom'; package_id: string | null; item: number | null }>('SELECT mode, package_id, item FROM agent_fx WHERE workspace_id = ? AND agent_id = ?', workspaceId, agentId);
  if (!r) return { mode: 'inherit', option: null };
  return { mode: r.mode, option: r.mode === 'custom' ? `${r.package_id}:${Number(r.item)}` : null };
}

/** Aplica as escolhas pessoais sobre os efeitos dos alvos dos pacotes (precedência: pessoal > alvos). */
export function applyAgentFx(db: Db, workspaceId: string, fromTargets: FxEffect[]): FxEffect[] {
  const rows = db.all<{ agent_id: string; mode: string; package_id: string | null; item: number | null }>("SELECT agent_id, mode, package_id, item FROM agent_fx WHERE workspace_id = ? AND mode <> 'inherit'", workspaceId);
  if (!rows.length) return fromTargets;
  const opts = new Map(fxOptions(db, workspaceId).map((o) => [o.id, o]));
  const personal = new Map<string, FxEffect | null>();
  for (const r of rows) {
    if (r.mode === 'off') { personal.set(r.agent_id, null); continue; }
    const o = opts.get(`${r.package_id}:${Number(r.item)}`);
    if (o) personal.set(r.agent_id, { agentId: r.agent_id, effect: o.effect, color: o.color, intensity: o.intensity }); // item sumiu: herda
  }
  const out = fromTargets.filter((e) => !personal.has(e.agentId));
  for (const e of personal.values()) if (e) out.push(e);
  return out;
}

/** Pacote desinstalado: quem tinha um efeito dele volta a herdar o padrão da cidade (explícito, com o número). */
export function releasePackageFx(db: Db, workspaceId: string, packageId: string): number {
  return Number(db.run('DELETE FROM agent_fx WHERE workspace_id = ? AND package_id = ?', workspaceId, packageId).changes ?? 0);
}
