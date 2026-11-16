/**
 * Loja do Ergon World no aplicativo local (world/src/marketplace.ts): COLABORATIVA e grátis. Ninguém compra nem vende
 * (nem em reais, nem em Dracmas); qualquer Conta Ergon publica de graça. Itens publicados pela equipe têm o selo
 * "Oficial"; os outros, "Comunidade" (passam pela revisão antes de aparecer).
 *
 * - Ver a vitrine não pede conta. Abrir um item (prévia) pega a licença grátis e baixa o pacote, que passa pela mesma
 *   validação de qualquer .ergon. Visuais e equipes instalam pelo caminho de sempre (desfazer em Instalados).
 * - Competência de terceiros: a tela mostra o texto INTEIRO antes; instala só aqui, na biblioteca local, marcada "não
 *   verificada". Nunca vai para a nuvem: os cards na nuvem não levam competências locais e o World recusa referência
 *   a item da Loja nos Jobs.
 * - Publicar: o pacote é montado AQUI (arquivo .ergon, a equipe deste workspace ou uma competência), com o id do
 *   criador (comunidade.<nome>.<item>), e vai para a revisão. Nunca há preço.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { exportBlueprint } from '../services/blueprint.ts';
import { previewOf } from '../services/catalog.ts';
import { pacoteDeTexto } from '../services/competencias.ts';
import { buildPackage, PackageError, validatePackage, type Manifest, type PackageData, type ValidatedPackage } from '../services/ergon-package.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Routines } from '../services/routines.ts';
import type { PackagesHost } from '../world-hook.ts';
import type { WorldClient } from './link.ts';

const ITEM = /^itm_[A-Za-z0-9]{8,64}$/;
const MAX_PACOTE = 20 * 1024 * 1024;
const VISUAIS = ['skin', 'city-theme', 'fx', 'pet', 'character-look', 'team-blueprint'];
/** competência de terceiros: só texto de instruções (o manifesto declara, como o formato exige para skill) */
const PERMISSOES_SKILL = { scopes: [] as string[], reason: 'Competência: só instruções em texto, sem programas nem acesso.' };

interface ItemWorld { id: string; packageId: string; kind: string; title: string; summary: string; version: string; creator: string; official: boolean; badge?: string; verified: boolean }
export interface CompetenciaDaLoja { nome: string; titulo: string; descricao: string; texto: string }
interface Deps {
  app: FastifyInstance; db: Db; client: WorldClient; routines: Routines; packages: PackagesHost;
  auth: (req: FastifyRequest) => AuthContext; owner: (req: FastifyRequest) => AuthContext;
  sessionOf: (userId: string) => string;
}

const err = (e: unknown): never => { if (e instanceof PackageError) throw new HttpError(422, 'package_invalid', e.message); throw e; };
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'item';
const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/** O texto da competência guardado num pacote 'skill' (data/package.json → skill). */
export function competenciaDoPacote(v: ValidatedPackage): CompetenciaDaLoja {
  const s = (v.data as { skill?: Partial<CompetenciaDaLoja> }).skill;
  if (!s || typeof s.texto !== 'string' || !s.texto.trim()) throw new HttpError(422, 'package_invalid', 'A competência não traz o texto (SKILL.md).');
  const p = pacoteDeTexto(s.texto, 'SKILL.md');
  return { nome: p.nome, titulo: p.titulo, descricao: p.descricao, texto: p.arquivos['SKILL.md'] };
}

export function registerLoja(d: Deps): void {
  const { app, db, client, routines, packages, auth, owner, sessionOf } = d;
  /** pacotes baixados para a prévia, até a pessoa decidir (10 min, por workspace e item) */
  const abertos = new Map<string, { at: number; bytes: Buffer }>();
  const guardar = (k: string, bytes: Buffer) => {
    for (const [x, v] of abertos) if (Date.now() - v.at > 10 * 60_000) abertos.delete(x);
    if (abertos.size > 50) abertos.delete(abertos.keys().next().value!);
    abertos.set(k, { at: Date.now(), bytes });
  };
  const itemDe = (req: FastifyRequest) => { const id = String((req.params as { id?: string }).id ?? ''); if (!ITEM.test(id)) throw new HttpError(400, 'invalid', 'item inválido'); return id; };

  /** Licença grátis + link curto + download, conferindo o SHA-256 que o World declara. */
  const baixar = async (userId: string, id: string): Promise<Buffer> => {
    const s = sessionOf(userId);
    await client.call('POST', `/v1/marketplace/items/${id}/acquire`, {}, s);
    const tk = await client.call<{ token: string }>('POST', `/v1/marketplace/items/${id}/download-token`, {}, s);
    const r = await client.raw(`/v1/marketplace/download?token=${encodeURIComponent(tk.token)}`, MAX_PACOTE);
    const sha = (await import('node:crypto')).createHash('sha256').update(r.bytes).digest('hex');
    if (r.sha256 && r.sha256 !== sha) throw new HttpError(422, 'package_mismatch', 'O pacote baixado não confere com a Loja: nada foi instalado.');
    return r.bytes;
  };

  // ---------------------------------------------------------------- a vitrine (sem conta)
  app.get('/api/loja/itens', async (req) => {
    auth(req);
    const q = req.query as { busca?: string; tipo?: string };
    const qs = new URLSearchParams();
    if (q.busca) qs.set('search', String(q.busca).slice(0, 60));
    if (q.tipo && /^[a-z-]{2,30}$/.test(q.tipo)) qs.set('kind', q.tipo);
    try {
      const rows = await client.call<ItemWorld[]>('GET', `/v1/marketplace/items${qs.size ? `?${qs}` : ''}`);
      return { disponivel: true, itens: (Array.isArray(rows) ? rows : []).map((r) => ({
        id: r.id, packageId: r.packageId, kind: r.kind, title: r.title, summary: r.summary, version: r.version, creator: r.creator,
        official: !!r.official, verified: !!r.verified,
      })) };
    } catch (e) {
      if ((e as HttpError).status === 503 || (e as HttpError).status === 429) return { disponivel: false, erro: (e as Error).message, itens: [] };
      throw e;
    }
  });

  // ---------------------------------------------------------------- abrir (prévia) e instalar
  app.post('/api/loja/itens/:id/abrir', async (req) => {
    const a = owner(req); const id = itemDe(req);
    const bytes = await baixar(a.userId, id);
    let v: ValidatedPackage;
    try { v = validatePackage(bytes, packages.keys); } catch (e) { return err(e); }
    guardar(`${a.workspaceId}|${id}`, bytes);
    const base = { id, packageId: v.manifest.package_id, kind: v.manifest.kind, title: v.manifest.title, summary: v.manifest.summary, version: v.manifest.version, verified: v.verified };
    if (v.manifest.kind === 'skill') return { ...base, competencia: competenciaDoPacote(v) };
    return { ...base, previa: packages.preview(a.workspaceId, bytes), preview: previewOf(v) };
  });
  app.post('/api/loja/itens/:id/instalar', async (req) => {
    const a = owner(req); const id = itemDe(req);
    const bytes = abertos.get(`${a.workspaceId}|${id}`)?.bytes ?? await baixar(a.userId, id);
    let v: ValidatedPackage;
    try { v = validatePackage(bytes, packages.keys); } catch (e) { return err(e); }
    // competência: a tela mostra o texto inteiro e instala pelo caminho das competências enviadas (só neste computador)
    if (!VISUAIS.includes(v.manifest.kind)) throw new HttpError(409, 'package_kind', 'Este tipo se instala depois de ler o texto inteiro, em Competências.');
    return packages.install(a.workspaceId, a.userId, bytes);
  });

  // ---------------------------------------------------------------- quem publica
  /**
   * As publicações da pessoa e as versões de cada uma. O World ainda não tem esta consulta (GET /v1/marketplace/mine
   * não existe em world/src/marketplace.ts): enquanto não tiver, a tela diz que a lista não está disponível.
   */
  app.get('/api/loja/minhas', async (req) => {
    const a = auth(req);
    try { return { disponivel: true, ...(await client.call<{ creator: unknown; items: unknown[] }>('GET', '/v1/marketplace/mine', undefined, sessionOf(a.userId))) }; }
    catch (e) { if ((e as HttpError).status === 404) return { disponivel: false, creator: null, items: [] }; throw e; }
  });
  app.post('/api/loja/criador', async (req) => {
    const a = auth(req); const b = (req.body ?? {}) as { namespace?: unknown; nome?: unknown };
    const ns = texto(b.namespace, 31).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(ns) || ns === 'oficial') throw new HttpError(400, 'namespace', 'Nome de criador: letras minúsculas, números e hífen (2 a 31).');
    const nome = texto(b.nome, 60);
    if (!nome) throw new HttpError(400, 'invalid', 'Informe o nome que aparece na Loja.');
    return client.call('POST', '/v1/marketplace/creators', { namespace: ns, displayName: nome }, sessionOf(a.userId));
  });

  /** Monta o pacote a publicar com o id do criador. fonte: arquivo .ergon, a equipe deste workspace ou uma competência. */
  const montar = async (a: AuthContext, b: Record<string, unknown>): Promise<{ bytes: Buffer; v: ValidatedPackage }> => {
    const ns = texto(b.namespace, 31);
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(ns)) throw new HttpError(409, 'creator_required', 'Crie o seu perfil de criador antes de publicar.');
    const titulo = texto(b.titulo, 80); const resumo = texto(b.resumo, 600);
    if (!titulo) throw new HttpError(400, 'invalid', 'Dê um título.');
    if (resumo.length < 10) throw new HttpError(400, 'invalid', 'Escreva um resumo (10 caracteres ou mais).');
    const versao = texto(b.versao, 14) || '1.0.0';
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(versao)) throw new HttpError(400, 'invalid', 'Versão no formato 1.0.0.');
    const nome = slug(texto(b.nome, 60) || titulo);
    const packageId = `comunidade.${ns}.${nome}`;
    const tags = Array.isArray(b.tags) ? b.tags.map((x) => slug(String(x))).filter(Boolean).slice(0, 8) : [];
    const m = (kind: Manifest['kind'], extra: Partial<Manifest> = {}) => ({ package_id: packageId, version: versao, title: titulo, summary: resumo, creator_id: ns, license: 'CC-BY-4.0',
      ergon: { min: '1.1.0' }, kind, ...(tags.length ? { tags } : {}), ...extra });
    let bytes: Buffer;
    const fonte = String(b.fonte ?? '');
    try {
      if (fonte === 'arquivo') {
        const raw = Buffer.from(String(b.arquivo ?? ''), 'base64');
        if (!raw.length || raw.length > MAX_PACOTE) throw new HttpError(400, 'invalid', 'Escolha um arquivo .ergon.');
        const src = validatePackage(raw, packages.keys);
        if (!VISUAIS.includes(src.manifest.kind)) throw new HttpError(400, 'invalid', 'Esse arquivo não é um visual nem uma equipe.');
        const imgs = Object.fromEntries(Object.entries(src.assets));
        bytes = await buildPackage(m(src.manifest.kind, src.manifest.preview?.length ? { preview: src.manifest.preview.filter((p) => imgs[p]) } : {}), src.data as PackageData, imgs);
      } else if (fonte === 'equipe') {
        bytes = await buildPackage(m('team-blueprint'), { blueprint: exportBlueprint(db, routines, a.workspaceId) as PackageData['blueprint'] });
      } else if (fonte === 'competencia') {
        const p = pacoteDeTexto(String(b.texto ?? ''), 'SKILL.md');
        bytes = await buildPackage(m('skill', { permissions: PERMISSOES_SKILL }), { skill: { nome: p.nome, titulo: p.titulo, descricao: p.descricao, texto: p.arquivos['SKILL.md'] } } as unknown as PackageData);
      } else throw new HttpError(400, 'invalid', 'Escolha o que publicar.');
      return { bytes, v: validatePackage(bytes, packages.keys) };
    } catch (e) { return err(e); }
  };
  const resumoDe = (v: ValidatedPackage) => ({
    packageId: v.manifest.package_id, kind: v.manifest.kind, title: v.manifest.title, summary: v.manifest.summary, version: v.manifest.version,
    ...(v.manifest.kind === 'skill' ? { competencia: competenciaDoPacote(v) } : { preview: previewOf(v) }),
  });
  app.post('/api/loja/publicar/previa', { bodyLimit: 28 * 1024 * 1024 }, async (req) => {
    const a = owner(req);
    const { v } = await montar(a, (req.body ?? {}) as Record<string, unknown>);
    return resumoDe(v);
  });
  /** Envia (sempre grátis: nenhum preço sai daqui) e pede a revisão. */
  app.post('/api/loja/publicar', { bodyLimit: 28 * 1024 * 1024 }, async (req) => {
    const a = owner(req); const s = sessionOf(a.userId);
    const { bytes, v } = await montar(a, (req.body ?? {}) as Record<string, unknown>);
    const up = await client.call<{ itemId: string; version: string }>('POST', '/v1/marketplace/items', { artifactB64: bytes.toString('base64') }, s);
    const sub = await client.call<{ status: string }>('POST', `/v1/marketplace/items/${up.itemId}/submit`, {}, s);
    return { ...resumoDe(v), itemId: up.itemId, version: up.version, status: sub.status };
  });
}
