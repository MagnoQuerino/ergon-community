/**
 * Pacote `.ergon` (docs/FORMATOS_ERGON.md): ZIP com manifest.json (versão 2) + dados JSON + imagens de prévia.
 * Pacotes VISUAIS e de equipe são SÓ DADOS: nada de script, HTML, SVG ou programa, nenhuma permissão, nenhuma
 * credencial. Skill/plugin têm contrato próprio (permissões declaradas, revisão e isolamento) e não são instalados
 * por esta versão. A validação é do mesmo código no aparelho, na Community e na loja.
 *
 * Defesas: caminho relativo simples (sem "..", barra invertida, absoluto, Unicode ambíguo), sem link simbólico,
 * sem nomes repetidos (mesmo trocando maiúsculas), limites de quantidade, tamanho e taxa de compressão (bomba de
 * ZIP), extensões permitidas + assinatura real dos bytes (PNG/WebP), dimensão de imagem, hash de cada parte
 * conferido contra o manifesto, nada fora do manifesto, e assinatura Ed25519 opcional (oficial = verificado).
 */
import crypto from 'node:crypto';
import { validateBlueprint, type Blueprint } from '../../../shared/blueprint.ts';
import { readZip } from '../lib/zip.ts';

export const PACKAGE_KINDS = ['city-theme', 'building-pack', 'character-look', 'clothing', 'accessory', 'fx', 'pet', 'team-blueprint', 'routine-blueprint', 'skill', 'plugin'] as const;
export type PackageKind = typeof PACKAGE_KINDS[number];
const EXEC_KINDS = new Set<PackageKind>(['skill', 'plugin']);
/** tipos que esta versão instala (o resto valida, mas fica para versões seguintes) */
export const INSTALLABLE = new Set<PackageKind>(['city-theme', 'character-look', 'fx', 'pet', 'team-blueprint']);

const LIMITS = { bytes: 20 * 1024 * 1024, entries: 200, total: 40 * 1024 * 1024, ratio: 100, imagePx: 1024, depth: 4 };
const EXT = /\.(json|png|webp)$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,3}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9-]{1,30}\.[a-z0-9][a-z0-9-]{1,40}$/;
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;

export interface Component { path: string; sha256: string; size: number; type: 'application/json' | 'image/png' | 'image/webp' }
export interface Manifest {
  manifest_version: 2; package_id: string; version: string; title: string; summary: string; creator_id: string; license: string;
  ergon: { min: string; max?: string }; kind: PackageKind; components: Component[]; preview?: string[]; tags?: string[];
  dependencies?: Array<{ package_id: string; range: string; optional?: boolean }>;
  capability_requirements?: { render2d?: number; max_particles?: number };
  permissions?: { scopes: string[]; network?: string[]; reason: string } | null;
  signature?: { alg: 'ed25519'; key_id: string; sig: string };
}
export type Target = { all: true } | { agentName: string } | { charKey: string };
export interface PackageData {
  theme?: { base: 'dia' | 'noite'; colors: Record<string, string> };
  effects?: Array<{ target: Target; effect: 'aura' | 'fire_circle' | 'celestial_glow' | 'fire_trail'; color: string; intensity: number }>;
  pets?: Array<{ target: Target; species: 'gato' | 'coruja' | 'cao' | 'tartaruga'; color: string }>;
  looks?: Array<{ target: Target; seed: number }>;
  blueprint?: Blueprint;
}
export interface ValidatedPackage { manifest: Manifest; data: PackageData; assets: Record<string, Buffer>; verified: boolean; keyId: string | null; sha256: string; installable: boolean }

export class PackageError extends Error { readonly problems: string[]; constructor(problems: string[]) { super(`pacote recusado: ${problems.slice(0, 4).join('; ')}`); this.problems = problems; } }

/** Diretório central do ZIP: nomes crus, tamanhos e atributos (para link simbólico e taxa de compressão). */
function centralDirectory(buf: Buffer): Array<{ name: string; comp: number; size: number; mode: number; utf8: boolean }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new PackageError(['ZIP sem diretório central']);
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new PackageError(['diretório central corrompido']);
    const flags = buf.readUInt16LE(p + 8); const comp = buf.readUInt32LE(p + 20); const size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28); const el = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    out.push({ name: buf.subarray(p + 46, p + 46 + nl).toString('utf8'), comp, size, mode: (ext >>> 16) & 0xffff, utf8: !!(flags & 0x800) });
    p += 46 + nl + el + cl;
  }
  return out;
}

const canonicalManifest = (m: Manifest) => { const { signature: _s, ...rest } = m; void _s; return JSON.stringify(rest, Object.keys(rest).sort()); };
export const manifestDigest = (m: Manifest) => crypto.createHash('sha256').update(canonicalManifest(m)).digest();

function checkTarget(t: unknown, p: string, e: string[]) {
  const x = t as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return void e.push(`${p}: alvo inválido`);
  const keys = Object.keys(x);
  if (keys.length !== 1 || !(x.all === true || (typeof x.agentName === 'string' && x.agentName.length <= 60) || (typeof x.charKey === 'string' && /^[a-z0-9_-]{1,40}$/.test(x.charKey)))) e.push(`${p}: alvo inválido`);
}
function checkData(kind: PackageKind, d: Record<string, unknown>, e: string[]) {
  const only = (keys: string[]) => { for (const k of Object.keys(d)) if (!keys.includes(k)) e.push(`dados: campo ${k} não permitido para ${kind}`); };
  if (kind === 'city-theme') {
    only(['theme']);
    const t = d.theme as Record<string, unknown> | undefined;
    if (!t || !['dia', 'noite'].includes(String(t.base)) || typeof t.colors !== 'object' || !t.colors) return void e.push('tema: base e cores obrigatórias');
    for (const [k, v] of Object.entries(t.colors as Record<string, unknown>)) if (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(k) || typeof v !== 'string' || !HEX.test(v)) e.push(`tema: cor ${k} inválida`);
  } else if (kind === 'fx') {
    only(['effects']);
    if (!Array.isArray(d.effects) || !d.effects.length || d.effects.length > 50) return void e.push('efeitos: 1 a 50');
    d.effects.forEach((x: Record<string, unknown>, i) => { checkTarget(x.target, `efeito ${i}`, e); if (!['aura', 'fire_circle', 'celestial_glow', 'fire_trail'].includes(String(x.effect))) e.push(`efeito ${i}: tipo inválido`); if (typeof x.color !== 'string' || !HEX.test(x.color)) e.push(`efeito ${i}: cor`); if (typeof x.intensity !== 'number' || x.intensity < 0 || x.intensity > 1) e.push(`efeito ${i}: intensidade 0..1`); });
  } else if (kind === 'pet') {
    only(['pets']);
    if (!Array.isArray(d.pets) || !d.pets.length || d.pets.length > 50) return void e.push('pets: 1 a 50');
    d.pets.forEach((x: Record<string, unknown>, i) => { checkTarget(x.target, `pet ${i}`, e); if (!['gato', 'coruja', 'cao', 'tartaruga'].includes(String(x.species))) e.push(`pet ${i}: espécie`); if (typeof x.color !== 'string' || !HEX.test(x.color)) e.push(`pet ${i}: cor`); });
  } else if (kind === 'character-look') {
    only(['looks']);
    if (!Array.isArray(d.looks) || !d.looks.length || d.looks.length > 200) return void e.push('aparências: 1 a 200');
    d.looks.forEach((x: Record<string, unknown>, i) => { checkTarget(x.target, `aparência ${i}`, e); if (!Number.isInteger(x.seed) || (x.seed as number) < 0 || (x.seed as number) > 2 ** 31 - 1) e.push(`aparência ${i}: semente`); });
  } else if (kind === 'team-blueprint') {
    only(['blueprint']);
    const v = validateBlueprint(d.blueprint);
    if (!v.ok) e.push(...v.errors.slice(0, 10).map((x) => `equipe: ${x}`));
  }
}

/** Valida um .ergon inteiro. officialKeys: chaves públicas Ed25519 (SPKI base64) da loja oficial por key_id. */
export function validatePackage(buf: Buffer, officialKeys: Record<string, string> = {}): ValidatedPackage {
  const e: string[] = [];
  if (buf.length > LIMITS.bytes) throw new PackageError([`pacote acima de ${LIMITS.bytes / 1024 / 1024} MB`]);
  const cd = centralDirectory(buf);
  if (cd.length > LIMITS.entries) throw new PackageError([`mais de ${LIMITS.entries} arquivos`]);
  const seen = new Set<string>(); let total = 0;
  for (const x of cd) {
    const nfc = x.name.normalize('NFC');
    if (x.name !== nfc || /[^\x20-\x7e]/.test(x.name)) e.push(`${JSON.stringify(x.name)}: nome com caractere não permitido`);
    if (x.name.endsWith('/')) continue; // pasta
    if (x.name.includes('\\') || x.name.startsWith('/') || x.name.split('/').includes('..') || /^[a-zA-Z]:/.test(x.name)) e.push(`${x.name}: caminho perigoso`);
    else if (!NAME.test(x.name)) e.push(`${x.name}: nome fora do padrão (minúsculas, números, . _ -; até 4 níveis)`);
    if ((x.mode & 0xf000) === 0xa000) e.push(`${x.name}: link simbólico não é permitido`);
    if (seen.has(x.name.toLowerCase())) e.push(`${x.name}: nome repetido`);
    seen.add(x.name.toLowerCase());
    if (x.name !== 'manifest.json' && !EXT.test(x.name)) e.push(`${x.name}: tipo de arquivo não permitido (só json, png, webp)`);
    total += x.size;
    if (x.comp > 0 && x.size / x.comp > LIMITS.ratio) e.push(`${x.name}: compressão suspeita (bomba de ZIP)`);
  }
  if (total > LIMITS.total) e.push('conteúdo descompactado grande demais');
  if (e.length) throw new PackageError(e);
  let files: Map<string, { read: () => Buffer }>;
  try { files = readZip(buf); } catch (err) { throw new PackageError([(err as Error).message]); }
  const mf = files.get('manifest.json');
  if (!mf) throw new PackageError(['falta manifest.json na raiz']);
  let m: Manifest;
  try { m = JSON.parse(mf.read().toString('utf8')); } catch { throw new PackageError(['manifest.json ilegível']); }
  // ---- manifesto
  if (m.manifest_version !== 2) e.push('manifest_version precisa ser 2');
  if (!ID.test(String(m.package_id))) e.push('package_id no formato espaço.criador.nome');
  if (!SEMVER.test(String(m.version))) e.push('version semver (1.2.3)');
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80) e.push('title obrigatório (até 80)');
  if (typeof m.summary !== 'string' || m.summary.length > 600) e.push('summary até 600');
  if (/<script|javascript:|<iframe|on\w+=/i.test(`${m.title} ${m.summary}`)) e.push('texto com conteúdo ativo');
  if (!PACKAGE_KINDS.includes(m.kind)) e.push('kind desconhecido');
  if (!SEMVER.test(String(m.ergon?.min))) e.push('ergon.min obrigatório');
  if (EXEC_KINDS.has(m.kind)) { if (!m.permissions || !Array.isArray(m.permissions.scopes) || !m.permissions.reason) e.push(`${m.kind}: permissões declaradas obrigatórias`); }
  else if (m.permissions) e.push('pacote visual/equipe não pede permissões');
  if (!Array.isArray(m.components) || !m.components.length) e.push('components obrigatório');
  const declared = new Set<string>(); const assets: Record<string, Buffer> = {}; let data: PackageData = {};
  for (const c of m.components ?? []) {
    declared.add(c.path);
    const f = files.get(c.path);
    if (!f) { e.push(`${c.path}: declarado e ausente`); continue; }
    const bytes = f.read();
    if (bytes.length !== c.size) e.push(`${c.path}: tamanho diferente do manifesto`);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== c.sha256) e.push(`${c.path}: sha256 não confere`);
    if (c.type === 'application/json') {
      if (!c.path.endsWith('.json')) e.push(`${c.path}: tipo declarado não bate com a extensão`);
      try { const j = JSON.parse(bytes.toString('utf8')); if (c.path === 'data/package.json') data = j; } catch { e.push(`${c.path}: JSON inválido`); }
    } else if (c.type === 'image/png') {
      if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.subarray(12, 16).toString() !== 'IHDR') e.push(`${c.path}: não é PNG de verdade`);
      else if (bytes.readUInt32BE(16) > LIMITS.imagePx || bytes.readUInt32BE(20) > LIMITS.imagePx) e.push(`${c.path}: imagem acima de ${LIMITS.imagePx}px`);
      else assets[c.path] = bytes;
    } else if (c.type === 'image/webp') {
      if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP') e.push(`${c.path}: não é WebP de verdade`);
      else assets[c.path] = bytes;
    } else e.push(`${c.path}: tipo não permitido`);
  }
  for (const name of files.keys()) if (name !== 'manifest.json' && !name.endsWith('/') && !declared.has(name)) e.push(`${name}: arquivo fora do manifesto`);
  if (!EXEC_KINDS.has(m.kind)) { if (!declared.has('data/package.json')) e.push('falta data/package.json'); else checkData(m.kind, data as Record<string, unknown>, e); }
  // ---- assinatura (opcional): oficial = verificado; sem assinatura = "não verificado"; assinatura inválida = recusa
  let verified = false; let keyId: string | null = null;
  if (m.signature) {
    const key = officialKeys[m.signature.key_id];
    if (!key) e.push('assinatura de chave desconhecida');
    else {
      const ok = crypto.verify(null, manifestDigest(m), crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(m.signature.sig, 'base64'));
      if (!ok) e.push('assinatura não confere (pacote alterado?)'); else { verified = true; keyId = m.signature.key_id; }
    }
  }
  if (e.length) throw new PackageError(e);
  return { manifest: m, data, assets, verified, keyId, sha256: crypto.createHash('sha256').update(buf).digest('hex'), installable: INSTALLABLE.has(m.kind) };
}

/** Monta um .ergon (exportar o que a pessoa personalizou; também usado nos testes e na loja). */
export async function buildPackage(m: Omit<Manifest, 'components' | 'signature' | 'manifest_version'>, data: PackageData | null, images: Record<string, Buffer> = {}, sign?: { keyId: string; privatePkcs8B64: string }): Promise<Buffer> {
  const { writeZip } = await import('../lib/zip.ts');
  const files: Array<{ name: string; data: Buffer }> = [];
  const components: Component[] = [];
  const add = (path: string, bytes: Buffer, type: Component['type']) => { files.push({ name: path, data: bytes }); components.push({ path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, type }); };
  if (data) add('data/package.json', Buffer.from(JSON.stringify(data)), 'application/json');
  for (const [p, b] of Object.entries(images)) add(p, b, p.endsWith('.webp') ? 'image/webp' : 'image/png');
  const manifest: Manifest = { manifest_version: 2, ...m, components };
  if (sign) manifest.signature = { alg: 'ed25519', key_id: sign.keyId, sig: crypto.sign(null, manifestDigest(manifest), crypto.createPrivateKey({ key: Buffer.from(sign.privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64') };
  return writeZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...files]);
}
