/**
 * Loja de pacotes do Ergon (docs/FORMATOS_ERGON.md §Loja), sem conta e sem pagamento:
 *
 * - **Oficiais:** vêm com o Ergon (`server/catalogo/oficiais/*.ergon`), assinados pela chave oficial ("verificado"),
 *   e funcionam sem internet.
 * - **Modelos da comunidade:** um índice público (JSON) com pacotes enviados por quem usa o Ergon. Só é lido quando a
 *   pessoa pede ("Carregar modelos da comunidade"): nada sai do computador sozinho. Sem internet, a lista não carrega e
 *   tudo o que já foi instalado continua funcionando. Cada pacote baixado precisa ter o tamanho e o SHA-256 do índice
 *   e vir do mesmo endereço do índice; depois passa pela mesma validação de qualquer .ergon (sem assinatura oficial,
 *   aparece como "não verificado").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { PACKAGE_KINDS, PackageError, validatePackage, type ValidatedPackage } from './ergon-package.ts';
import type { Packages } from './packages.ts';

/** Chave pública oficial dos pacotes do Ergon (Ed25519, SPKI em base64), por key_id. Outras entram por ERGON_PACKAGE_KEYS. */
export const OFFICIAL_KEYS: Record<string, string> = {
  'ergon-oficial-2026': 'MCowBQYDK2VwAyEAWpdDKrIsv7LSjovZUHnTQ2iezzFAIswXHXsz5mz8a8k=',
};
export const COMMUNITY_INDEX_URL = 'https://raw.githubusercontent.com/MagnoQuerino/ergon-community/main/catalogo/index.json';

/** Prévia de um pacote para a galeria: tiradas dos dados dele (cores, personagens, membros, o efeito ou o pet), sem
 *  executar nada; e quantas imagens de prévia ele traz (servidas por /api/packages/catalog/official/:id/preview/:n). */
export interface CatalogPreview {
  swatches: string[]; names: string[]; tagline?: string;
  fx?: { effect: string; color: string; intensity: number }; pet?: { species: string; color: string };
  images: number; tags: string[];
  /** para desenhar a prévia da cidade: a skin inteira (até 200 KB, já validada) ou as cores do tema */
  skin?: unknown; theme?: { base: 'dia' | 'noite'; colors: Record<string, string> };
  /** para a prévia da equipe: quem vem nela, por setor */
  agents?: Array<{ name: string; role: string; color: string; charKey: string | null; coordinator: boolean }>; sectors?: string[];
}
export interface CatalogItem { id: string; version: string; title: string; summary: string; kind: string; verified: boolean; installed: boolean; author?: string; preview?: CatalogPreview }

const COR = /^#[0-9a-f]{3,8}$/i;
const cor = (x: unknown): string | null => (typeof x === 'string' && COR.test(x) ? x : null);
const nada = (x: string | null): x is string => !!x;
export function previewOf(v: ValidatedPackage): CatalogPreview {
  const d = v.data;
  let swatches: string[] = []; let names: string[] = []; let tagline: string | undefined;
  if (d.skin) {
    const sd = d.skin.palette.dia.seeds;
    swatches = [sd.sky, sd.ground, sd.wall, sd.roof, sd.accent, sd.foliage].map(cor).filter(nada);
    names = d.skin.characters.map((c) => c.name);
    tagline = d.skin.tagline;
  } else if (d.theme) {
    swatches = Object.values(d.theme.colors).map(cor).filter(nada).slice(0, 6);
  }
  if (d.blueprint) { names = d.blueprint.agents.map((a) => a.name); swatches = d.blueprint.agents.map((a) => cor(a.color)).filter(nada); }
  const fx = d.effects?.[0]; const pet = d.pets?.[0];
  if (fx) swatches.push(...d.effects!.map((e) => cor(e.color)).filter(nada));
  if (pet) swatches.push(...d.pets!.map((p) => cor(p.color)).filter(nada));
  return {
    swatches: [...new Set(swatches)].slice(0, 6), names: names.slice(0, 10), ...(tagline ? { tagline } : {}),
    ...(fx ? { fx: { effect: fx.effect, color: fx.color, intensity: fx.intensity } } : {}),
    ...(pet ? { pet: { species: pet.species, color: pet.color } } : {}),
    ...(d.skin ? { skin: d.skin } : {}),
    ...(d.theme ? { theme: d.theme } : {}),
    ...(d.blueprint ? { agents: d.blueprint.agents.slice(0, 24).map((a) => ({ name: a.name, role: a.role, color: a.color, charKey: a.charKey, coordinator: a.coordinator })), sectors: d.blueprint.sectors.map((x) => x.name).slice(0, 12) } : {}),
    images: (v.manifest.preview ?? []).filter((p) => v.assets[p]).length, tags: (v.manifest.tags ?? []).slice(0, 8),
  };
}
interface IndexEntry { id: string; version: string; title: string; summary: string; kind: string; author: string; path: string; sha256: string; size: number }

const MAX_INDEX = 512 * 1024;
const MAX_PACKAGE = 5 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9-]{1,40}$/;
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

export class Catalog {
  readonly db: Db; readonly packages: Packages; readonly keys: Record<string, string>; readonly dir: string; readonly indexUrl: string;
  readonly fetchImpl: typeof fetch;
  private cache: { at: number; entries: IndexEntry[] } | null = null;
  constructor(o: { db: Db; packages: Packages; keys: Record<string, string>; dir?: string; indexUrl?: string; fetchImpl?: typeof fetch }) {
    this.db = o.db; this.packages = o.packages; this.keys = o.keys; this.fetchImpl = o.fetchImpl ?? fetch;
    this.dir = o.dir ?? path.resolve(import.meta.dirname, '..', '..', 'catalogo', 'oficiais');
    this.indexUrl = o.indexUrl ?? COMMUNITY_INDEX_URL;
  }

  private installed(ws: string): Set<string> {
    return new Set(this.db.all<{ package_id: string }>("SELECT package_id FROM installed_packages WHERE workspace_id = ? AND status = 'active'", ws).map((r) => r.package_id));
  }

  /** Pacotes oficiais que vêm com o Ergon (os que não validarem com a chave oficial ficam de fora). */
  private officialFiles(): Array<{ file: string; buf: Buffer; id: string }> {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith('.ergon')).sort()) {
      const buf = fs.readFileSync(path.join(this.dir, f));
      try { const v = validatePackage(buf, this.keys); if (v.verified) out.push({ file: f, buf, id: v.manifest.package_id }); } catch { /* pacote corrompido não aparece */ }
    }
    return out;
  }

  official(ws: string): CatalogItem[] {
    const inst = this.installed(ws);
    return this.officialFiles().map(({ buf }) => {
      const v = validatePackage(buf, this.keys);
      return { id: v.manifest.package_id, version: v.manifest.version, title: v.manifest.title, summary: v.manifest.summary, kind: v.manifest.kind, verified: v.verified, installed: inst.has(v.manifest.package_id), preview: previewOf(v) };
    });
  }

  /** Imagem de prévia n de um pacote oficial (só PNG/WebP de dentro do pacote validado). */
  officialPreview(id: string, n: number): { bytes: Buffer; type: string } {
    const f = this.officialFiles().find((x) => x.id === id);
    if (!f) throw new HttpError(404, 'not_found', 'pacote oficial não encontrado nesta versão');
    const v = validatePackage(f.buf, this.keys);
    const p = (v.manifest.preview ?? []).filter((x) => v.assets[x])[n];
    if (!p) throw new HttpError(404, 'not_found', 'sem essa imagem de prévia');
    return { bytes: v.assets[p], type: p.endsWith('.webp') ? 'image/webp' : 'image/png' };
  }

  installOfficial(ws: string, userId: string, id: string) {
    const f = this.officialFiles().find((x) => x.id === id);
    if (!f) throw new HttpError(404, 'not_found', 'pacote oficial não encontrado nesta versão');
    return this.packages.install(ws, userId, f.buf);
  }

  /** Lê o índice público, só quando a pessoa pede. Sem internet: 503 com mensagem amigável. */
  private async index(force = false): Promise<IndexEntry[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.entries;
    const u = new URL(this.indexUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new HttpError(500, 'catalog_url', 'endereço do catálogo inválido');
    let r: Response;
    try { r = await this.fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }); }
    catch { throw new HttpError(503, 'offline', 'Sem conexão com a internet agora: os modelos da comunidade aparecem quando houver conexão. O que você já instalou continua funcionando.'); }
    if (!r.ok) throw new HttpError(503, 'catalog_unavailable', 'O catálogo da comunidade não respondeu agora. Tente mais tarde.');
    const raw = Buffer.from(await r.arrayBuffer());
    if (raw.length > MAX_INDEX) throw new HttpError(502, 'catalog_invalid', 'catálogo da comunidade grande demais');
    let j: { version?: unknown; packages?: unknown };
    try { j = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(502, 'catalog_invalid', 'catálogo da comunidade ilegível'); }
    if (j.version !== 1 || !Array.isArray(j.packages)) throw new HttpError(502, 'catalog_invalid', 'catálogo da comunidade em formato desconhecido');
    const entries: IndexEntry[] = [];
    for (const p of j.packages.slice(0, 500) as Array<Record<string, unknown>>) {
      const id = String(p.id ?? ''); const rel = String(p.path ?? ''); const sha = String(p.sha256 ?? '');
      if (!ID.test(id) || !/^[a-z0-9][a-z0-9._/-]{0,200}\.ergon$/.test(rel) || rel.includes('..') || !/^[a-f0-9]{64}$/.test(sha)) continue;
      if (!PACKAGE_KINDS.includes(String(p.kind) as never) || !Number.isInteger(p.size) || (p.size as number) <= 0 || (p.size as number) > MAX_PACKAGE) continue;
      entries.push({ id, version: clip(p.version, 20), title: clip(p.title, 80), summary: clip(p.summary, 300), kind: String(p.kind), author: clip(p.author, 60), path: rel, sha256: sha, size: p.size as number });
    }
    this.cache = { at: Date.now(), entries };
    return entries;
  }

  async community(ws: string, force = false): Promise<CatalogItem[]> {
    const inst = this.installed(ws);
    return (await this.index(force)).map((e) => ({ id: e.id, version: e.version, title: e.title, summary: e.summary, kind: e.kind, author: e.author, verified: false, installed: inst.has(e.id) }));
  }

  /** Baixa do MESMO endereço do índice, confere tamanho e SHA-256 do índice e instala com a validação de sempre. */
  async installCommunity(ws: string, userId: string, id: string) {
    const e = (await this.index()).find((x) => x.id === id);
    if (!e) throw new HttpError(404, 'not_found', 'modelo não encontrado no catálogo da comunidade');
    const url = new URL(e.path, this.indexUrl);
    if (url.origin !== new URL(this.indexUrl).origin) throw new HttpError(400, 'catalog_invalid', 'pacote fora do endereço do catálogo');
    let r: Response;
    try { r = await this.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new HttpError(503, 'offline', 'Sem conexão com a internet agora: tente instalar quando houver conexão.'); }
    if (!r.ok) throw new HttpError(503, 'catalog_unavailable', 'O pacote não pôde ser baixado agora.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== e.size || crypto.createHash('sha256').update(buf).digest('hex') !== e.sha256) throw new HttpError(422, 'package_mismatch', 'O pacote baixado não confere com o catálogo (tamanho ou SHA-256): nada foi instalado.');
    try { const v = validatePackage(buf, this.keys); if (v.manifest.package_id !== e.id) throw new PackageError(['o pacote não é o do catálogo']); }
    catch (err) { throw new HttpError(422, 'package_invalid', (err as Error).message); }
    return this.packages.install(ws, userId, buf);
  }
}
