/**
 * Instalar, listar e desfazer pacotes .ergon no workspace (docs/FORMATOS_ERGON.md). Só dados: tema da cidade,
 * efeitos e pets dos personagens, aparência (semente) e esqueleto de equipe. Nada executa, nada ganha ferramenta ou
 * credencial. Desfazer devolve exatamente o que o pacote mudou; conversas, tarefas e rotinas da pessoa ficam.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id, now } from '../lib/util.ts';
import type { AgentLimits } from './capacity.ts';
import { archiveAgent } from './capacity.ts';
import type { Bus } from './bus.ts';
import { importBlueprint } from './blueprint.ts';
import { PackageError, validatePackage, type PackageData, type Target, type ValidatedPackage } from './ergon-package.ts';
import type { Routines } from './routines.ts';

type Names = Record<string, { name: string; bio: string | null; personality?: string | null }>;
interface Row { id: string; package_id: string; version: string; kind: string; title: string; verified: number; sha256: string; data: string; assets: string | null; previous: string | null; status: string; installed_at: string }

export class Packages {
  readonly db: Db; readonly bus: Bus; readonly routines: Routines; readonly limits: AgentLimits; readonly officialKeys: Record<string, string>;
  constructor(db: Db, bus: Bus, routines: Routines, limits: AgentLimits, officialKeys: Record<string, string> = {}) { this.db = db; this.bus = bus; this.routines = routines; this.limits = limits; this.officialKeys = officialKeys; }

  private check(buf: Buffer): ValidatedPackage {
    try { return validatePackage(buf, this.officialKeys); }
    catch (e) { if (e instanceof PackageError) throw new HttpError(400, 'package_invalid', e.message); throw e; }
  }
  private agentsOf(ws: string, t: Target): Array<{ id: string; name: string; look_seed: number | null }> {
    const all = this.db.all<{ id: string; name: string; char_key: string | null; look_seed: number | null }>("SELECT id, name, char_key, look_seed FROM agents WHERE workspace_id = ? AND status = 'active'", ws);
    if ('all' in t) return all;
    if ('agentName' in t) return all.filter((a) => a.name.toLowerCase() === t.agentName.toLowerCase());
    return all.filter((a) => a.char_key === t.charKey);
  }

  /** Veste os agentes com os personagens da skin (nome e bio); devolve o que eles eram antes. */
  private applyCharacters(ws: string, d: PackageData): Names {
    const before: Names = {};
    for (const c of d.skin?.characters ?? []) for (const a of this.agentsOf(ws, { charKey: c.charKey })) {
      const cur = this.db.get<{ name: string; bio: string | null; personality: string | null }>('SELECT name, bio, personality FROM agents WHERE id = ? AND workspace_id = ?', a.id, ws)!;
      if (!(a.id in before)) before[a.id] = cur;
      this.db.run('UPDATE agents SET name = ?, bio = ? WHERE id = ? AND workspace_id = ?', c.name, c.bio, a.id, ws);
      // o jeito de falar do personagem (padrão do agente; a escolha de cada pessoa continua valendo por cima)
      if (c.personality) this.db.run('UPDATE agents SET personality = ? WHERE id = ? AND workspace_id = ?', c.personality, a.id, ws);
    }
    return before;
  }
  private restoreNames(ws: string, names: Names | undefined): void {
    for (const [aid, v] of Object.entries(names ?? {})) {
      this.db.run('UPDATE agents SET name = ?, bio = ? WHERE id = ? AND workspace_id = ?', v.name, v.bio, aid, ws);
      if (v.personality !== undefined) this.db.run('UPDATE agents SET personality = ? WHERE id = ? AND workspace_id = ?', v.personality, aid, ws);
    }
  }
  private activeSkin(ws: string): Row | undefined {
    return this.db.get<Row>("SELECT * FROM installed_packages WHERE workspace_id = ? AND kind = 'skin' AND status = 'active'", ws);
  }

  /** Prévia: o que muda, se é verificado, se esta versão instala. Nada é gravado. */
  preview(ws: string, buf: Buffer) {
    const p = this.check(buf);
    const d = p.data;
    const changes: string[] = [];
    if (d.theme) changes.push(`tema da cidade (${Object.keys(d.theme.colors).length} cores sobre o ${d.theme.base})`);
    for (const e of d.effects ?? []) changes.push(`efeito ${e.effect} em ${this.agentsOf(ws, e.target).map((a) => a.name).join(', ') || 'ninguém (alvo não existe aqui)'}`);
    for (const e of d.pets ?? []) changes.push(`pet ${e.species} com ${this.agentsOf(ws, e.target).map((a) => a.name).join(', ') || 'ninguém'}`);
    for (const e of d.looks ?? []) changes.push(`aparência nova para ${this.agentsOf(ws, e.target).map((a) => a.name).join(', ') || 'ninguém'}`);
    if (d.blueprint) changes.push(`equipe: ${d.blueprint.agents.length} agentes, ${d.blueprint.routines.length} rotinas (pausadas)`);
    if (d.skin) {
      changes.push(`skin da cidade "${d.skin.name}": cores de dia e de noite, prédios, roupas e decoração (só aparência)`);
      for (const c of d.skin.characters) for (const a of this.agentsOf(ws, { charKey: c.charKey })) changes.push(`${a.name} aparece como ${c.name} (nome e bio; a função continua a mesma)`);
    }
    return { packageId: p.manifest.package_id, version: p.manifest.version, kind: p.manifest.kind, title: p.manifest.title, summary: p.manifest.summary, verified: p.verified,
      installable: p.installable, reason: p.installable ? null : 'Este tipo de pacote ainda não é instalado nesta versão (skills e plugins pedem revisão e isolamento próprios).', changes };
  }

  install(ws: string, userId: string, buf: Buffer) {
    const p = this.check(buf);
    if (!p.installable) throw new HttpError(409, 'package_kind', 'Este tipo de pacote ainda não é instalado nesta versão.');
    const same = this.db.get<{ id: string }>("SELECT id FROM installed_packages WHERE workspace_id = ? AND sha256 = ? AND status = 'active'", ws, p.sha256);
    if (same) return { id: same.id, alreadyInstalled: true };
    const d = p.data; const previous: Record<string, unknown> = {};
    const pid = id('pkg');
    if (p.manifest.kind === 'city-theme') {
      // um tema por vez: o anterior sai (e volta se este for desfeito)
      const cur = this.db.get<{ id: string }>("SELECT id FROM installed_packages WHERE workspace_id = ? AND kind = 'city-theme' AND status = 'active'", ws);
      if (cur) { this.db.run("UPDATE installed_packages SET status = 'removed', removed_at = ? WHERE id = ?", now(), cur.id); previous.theme = cur.id; }
    }
    if (p.manifest.kind === 'skin') {
      // uma skin por vez: a anterior sai (devolvendo os nomes) e volta se esta for desfeita
      const cur = this.activeSkin(ws);
      if (cur) {
        this.restoreNames(ws, (JSON.parse(cur.previous ?? '{}') as { names?: Names }).names);
        this.db.run("UPDATE installed_packages SET status = 'removed', removed_at = ? WHERE id = ?", now(), cur.id);
        previous.skin = cur.id;
      }
      previous.names = this.applyCharacters(ws, d);
    }
    if (p.manifest.kind === 'character-look') {
      const seeds: Record<string, number | null> = {};
      for (const l of d.looks ?? []) for (const a of this.agentsOf(ws, l.target)) { if (!(a.id in seeds)) seeds[a.id] = a.look_seed; this.db.run('UPDATE agents SET look_seed = ? WHERE id = ? AND workspace_id = ?', l.seed, a.id, ws); }
      previous.seeds = seeds;
    }
    if (p.manifest.kind === 'team-blueprint') {
      const coord = this.db.get<{ id: string; name: string; charter: string | null; bio: string | null; look_seed: number | null }>("SELECT id, name, charter, bio, look_seed FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", ws);
      const before = new Set(this.db.all<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ?', ws).map((a) => a.id));
      const routinesBefore = new Set(this.db.all<{ id: string }>('SELECT id FROM routines WHERE workspace_id = ?', ws).map((r) => r.id));
      importBlueprint(this.db, this.bus, this.routines, ws, userId, d.blueprint, true, this.limits);
      previous.coordinator = coord;
      previous.agents = this.db.all<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ?', ws).map((a) => a.id).filter((x) => !before.has(x));
      previous.routines = this.db.all<{ id: string }>('SELECT id FROM routines WHERE workspace_id = ?', ws).map((r) => r.id).filter((x) => !routinesBefore.has(x));
    }
    const assets = Object.fromEntries(Object.entries(p.assets).map(([k, v]) => [k, v.toString('base64')]));
    this.db.run(`INSERT INTO installed_packages (id, workspace_id, package_id, version, kind, title, verified, sha256, manifest, data, assets, previous, status, installed_by, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, pid, ws, p.manifest.package_id, p.manifest.version, p.manifest.kind, p.manifest.title.slice(0, 80), p.verified ? 1 : 0, p.sha256,
    JSON.stringify(p.manifest), this.db.seal(ws, JSON.stringify(d)), this.db.seal(ws, JSON.stringify(assets)), this.db.seal(ws, JSON.stringify(previous)), userId, now());
    this.bus.publish(ws, 'packages.changed');
    if (p.manifest.kind === 'skin') { this.bus.publish(ws, 'agents.changed', {}); this.bus.publish(ws, 'city.changed', {}); }
    return { id: pid, alreadyInstalled: false, verified: p.verified };
  }

  /** Desfazer: devolve o que o pacote mudou. */
  uninstall(ws: string, userId: string, packageId: string): void {
    const r = this.db.get<Row>("SELECT * FROM installed_packages WHERE id = ? AND workspace_id = ? AND status = 'active'", packageId, ws);
    if (!r) throw new HttpError(404, 'not_found', 'pacote não encontrado');
    const prev = JSON.parse(r.previous ?? '{}') as { skin?: string; names?: Names; theme?: string; seeds?: Record<string, number | null>; coordinator?: { id: string; name: string; charter: string | null; bio: string | null; look_seed: number | null }; agents?: string[]; routines?: string[] };
    if (prev.seeds) for (const [aid, seed] of Object.entries(prev.seeds)) this.db.run('UPDATE agents SET look_seed = ? WHERE id = ? AND workspace_id = ?', seed, aid, ws);
    if (prev.theme) this.db.run("UPDATE installed_packages SET status = 'active', removed_at = NULL WHERE id = ? AND workspace_id = ?", prev.theme, ws);
    if (r.kind === 'skin') {
      this.restoreNames(ws, prev.names);
      if (prev.skin) { // a skin de antes volta, com os personagens dela
        const old = this.db.get<Row>('SELECT * FROM installed_packages WHERE id = ? AND workspace_id = ?', prev.skin, ws);
        if (old) {
          this.db.run("UPDATE installed_packages SET status = 'active', removed_at = NULL WHERE id = ?", old.id);
          const oldPrev = JSON.parse(old.previous ?? '{}') as Record<string, unknown>;
          oldPrev.names = this.applyCharacters(ws, JSON.parse(old.data) as PackageData);
          this.db.run('UPDATE installed_packages SET previous = ? WHERE id = ?', this.db.seal(ws, JSON.stringify(oldPrev)), old.id);
        }
      }
    }
    if (prev.coordinator) this.db.run('UPDATE agents SET name = ?, charter = ?, bio = ?, look_seed = ? WHERE id = ? AND workspace_id = ?', prev.coordinator.name, this.db.seal(ws, prev.coordinator.charter), prev.coordinator.bio, prev.coordinator.look_seed, prev.coordinator.id, ws);
    for (const a of prev.agents ?? []) { try { archiveAgent(this.db, this.bus, ws, userId, a); } catch { /* já arquivado */ } }
    for (const rt of prev.routines ?? []) this.db.run("UPDATE routines SET status = 'archived', updated_at = ? WHERE id = ? AND workspace_id = ?", now(), rt, ws);
    this.db.run("UPDATE installed_packages SET status = 'removed', removed_at = ? WHERE id = ?", now(), packageId);
    this.bus.publish(ws, 'packages.changed');
    if (r.kind === 'skin') { this.bus.publish(ws, 'agents.changed', {}); this.bus.publish(ws, 'city.changed', {}); }
  }

  list(ws: string) {
    return this.db.all<Row>("SELECT id, package_id, version, kind, title, verified, status, installed_at FROM installed_packages WHERE workspace_id = ? ORDER BY installed_at DESC", ws)
      .map((r) => ({ id: r.id, packageId: r.package_id, version: r.version, kind: r.kind, title: r.title, verified: r.verified === 1, active: r.status === 'active', installedAt: r.installed_at }));
  }

  /** O que a cidade desenha: skin ativa (com quem veste cada personagem), tema, efeitos e pets por agente. */
  cosmetics(ws: string) {
    const sk = this.activeSkin(ws);
    let skin: { data: NonNullable<PackageData['skin']>; characters: Array<{ agentId: string; index: number }> } | null = null;
    if (sk) {
      const data = (JSON.parse(sk.data) as PackageData).skin;
      if (data) skin = { data, characters: data.characters.flatMap((c, index) => this.agentsOf(ws, { charKey: c.charKey }).map((a) => ({ agentId: a.id, index }))) };
    }
    const rows = this.db.all<Row>("SELECT id, kind, data FROM installed_packages WHERE workspace_id = ? AND status = 'active' AND kind IN ('city-theme','fx','pet') ORDER BY installed_at", ws);
    let theme: PackageData['theme'] | null = null;
    const effects: Array<{ agentId: string; effect: string; color: string; intensity: number }> = [];
    const pets: Array<{ agentId: string; species: string; color: string }> = [];
    for (const r of rows) {
      const d = JSON.parse(r.data) as PackageData;
      if (d.theme) theme = d.theme;
      for (const e of d.effects ?? []) for (const a of this.agentsOf(ws, e.target)) effects.push({ agentId: a.id, effect: e.effect, color: e.color, intensity: e.intensity });
      for (const p of d.pets ?? []) for (const a of this.agentsOf(ws, p.target)) pets.push({ agentId: a.id, species: p.species, color: p.color });
    }
    return { skin, theme, effects, pets };
  }

  asset(ws: string, packageId: string, path: string): { bytes: Buffer; type: string } {
    const r = this.db.get<Row>('SELECT assets FROM installed_packages WHERE id = ? AND workspace_id = ?', packageId, ws);
    const all = r?.assets ? JSON.parse(r.assets) as Record<string, string> : {};
    if (!Object.hasOwn(all, path)) throw new HttpError(404, 'not_found', 'imagem não encontrada');
    return { bytes: Buffer.from(all[path], 'base64'), type: path.endsWith('.webp') ? 'image/webp' : 'image/png' };
  }
}
