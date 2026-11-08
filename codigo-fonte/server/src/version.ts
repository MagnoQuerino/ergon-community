/**
 * Versão única do Ergon: a do package.json da raiz. É a mesma no servidor, na interface (gravada no build),
 * na imagem publicada e na nuvem — local e nuvem recebem a mesma versão. BUILD é o commit, gravado pela imagem.
 */
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
export const VERSION: string = pkg.version;
export const BUILD: string = /^[\w.-]{1,40}$/.test(process.env.ERGON_BUILD ?? '') ? process.env.ERGON_BUILD! : 'dev';

export interface Release { version: string; notes: string | null; url: string | null; publishedAt: string | null }

/** Compara versões x.y.z (pré-lançamento "-beta.n" conta como anterior à final). */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, '').split('-'); return { n: core.split('.').map((x) => Number(x) || 0), pre: pre ?? null }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

/** Uma versão publicada, para a lista de Configurações › Atualizações (voltar para uma anterior). */
export interface ReleaseItem { version: string; url: string | null; publishedAt: string | null; prerelease: boolean }
export interface UpdateState { latest: Release | null; releases: ReleaseItem[]; checkedAt: string | null }

const VERSION_TAG = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * Aviso de versão nova: consulta a página de versões publicada (ERGON_UPDATE_URL, ex.: latest.json da página de
 * versões do GitHub) só quando a interface pede — ao abrir o Ergon, se a pessoa não desligou o aviso, ou no botão
 * "Verificar agora" —, no máximo uma vez por minuto. Pela API de versões do GitHub vêm também as pré-versões (quem
 * está numa pré-versão segue o canal de teste; o latest.json de releases/latest só enxerga as finais) e as versões
 * anteriores. Sem a API, o latest.json. Só avisa: atualizar é decisão da pessoa.
 */
export class UpdateCheck {
  private cache: (UpdateState & { at: number }) | null = null;
  private url: string | null;
  private current: string;
  constructor(url: string | null, current: string = VERSION) { this.url = url; this.current = current; }

  /** O que já foi consultado (sem ir à rede). */
  cached(): UpdateState { return this.cache ? { latest: this.cache.latest, releases: this.cache.releases, checkedAt: this.cache.checkedAt } : { latest: null, releases: [], checkedAt: null }; }

  async check(): Promise<UpdateState> {
    if (!this.url) return this.cached();
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cached();
    let st: UpdateState | null = await this.fromApi().catch(() => null);
    if (!st) st = { latest: await this.fromManifest().catch(() => null), releases: [], checkedAt: null };
    // sem rede: guarda a tentativa (tenta de novo depois) e mantém a lista que já tinha
    const ok = !!st.latest || st.releases.length > 0;
    this.cache = { at: Date.now(), latest: ok ? st.latest : this.cache?.latest ?? null, releases: st.releases.length ? st.releases : this.cache?.releases ?? [], checkedAt: ok ? new Date().toISOString() : this.cache?.checkedAt ?? null };
    return this.cached();
  }

  /** compatível com o uso antigo: a versão publicada mais nova do canal */
  async latest(): Promise<Release | null> { return (await this.check()).latest; }

  private api(): string | null {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\//.exec(this.url ?? '');
    return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=40` : null;
  }

  private async fromApi(): Promise<UpdateState | null> {
    const u = this.api();
    if (!u) return null;
    const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const list = (await r.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; html_url?: string; body?: string | null; published_at?: string | null }>;
    if (!Array.isArray(list)) return null;
    // pré-versão instalada = canal de teste (vê as pré-versões); versão final = só as finais
    const teste = this.current.includes('-');
    const items = list
      .filter((x) => !x.draft && typeof x.tag_name === 'string' && VERSION_TAG.test(x.tag_name) && (teste || !x.prerelease))
      .map((x) => ({ version: x.tag_name!.replace(/^v/, ''), url: typeof x.html_url === 'string' && x.html_url.startsWith('https://') ? x.html_url : null, publishedAt: x.published_at ?? null, prerelease: !!x.prerelease, notes: typeof x.body === 'string' ? x.body.slice(0, 2000) : null }))
      .sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
    const top = items[0];
    return {
      latest: top ? { version: top.version, notes: top.notes, url: top.url, publishedAt: top.publishedAt } : null,
      releases: items.map(({ notes: _n, ...x }) => x),
      checkedAt: null,
    };
  }

  private async fromManifest(): Promise<Release | null> {
    const r = await fetch(this.url!, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<Release> & { published_at?: string };
    if (typeof j.version !== 'string' || !VERSION_TAG.test(j.version)) return null;
    return { version: j.version.replace(/^v/, ''), notes: typeof j.notes === 'string' ? j.notes.slice(0, 2000) : null, url: typeof j.url === 'string' && j.url.startsWith('https://') ? j.url : null, publishedAt: j.publishedAt ?? j.published_at ?? null };
  }
}
