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

/**
 * Aviso de versão nova: lê o manifesto publicado (ERGON_UPDATE_URL, ex.: latest.json da página de versões) no
 * máximo a cada 6 h. Só avisa — atualizar é decisão da pessoa (no computador: "ergon atualizar").
 */
export class UpdateCheck {
  private cache: { at: number; latest: Release | null } | null = null;
  private url: string | null;
  constructor(url: string | null) { this.url = url; }
  async latest(): Promise<Release | null> {
    if (!this.url) return null;
    if (this.cache && Date.now() - this.cache.at < 6 * 3600_000) return this.cache.latest;
    let latest: Release | null = null;
    try {
      const r = await fetch(this.url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = (await r.json()) as Partial<Release> & { published_at?: string };
        if (typeof j.version === 'string' && /^v?\d+\.\d+\.\d+(-[\w.]+)?$/.test(j.version)) {
          latest = { version: j.version.replace(/^v/, ''), notes: typeof j.notes === 'string' ? j.notes.slice(0, 2000) : null, url: typeof j.url === 'string' && j.url.startsWith('https://') ? j.url : null, publishedAt: j.publishedAt ?? j.published_at ?? null };
        }
      }
    } catch { /* sem rede: tenta de novo depois */ }
    this.cache = { at: Date.now(), latest };
    return latest;
  }
}
