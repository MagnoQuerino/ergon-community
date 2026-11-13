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
 * A versão mais antiga para a qual o Ergon Desktop volta pelo próprio aplicativo: a 1.1.0-rc.27. Ela muda a base da equipe
 * (cada agente vira um perfil do motor, com memória, competências e conversas próprias; migração 4 do cofre): numa versão
 * anterior, a equipe não acharia os agentes onde eles passaram a morar. Para voltar ao que era antes dela, o caminho é o
 * backup feito na atualização. (Até a rc.26 a mínima era a 1.1.0-rc.24: antes dela, o gerente
 * de motores nunca recriava o motor de cada pessoa quando a versão mudava: numa volta para uma anterior, só o núcleo
 * voltaria e a equipe seguiria na imagem de agora (e a 1.1.0-rc.14 já tinha trocado Docker por Podman dentro do
 * ambiente do Windows). O aplicativo tem a mesma trava (desktop/src-tauri/src/atualizacao.rs, VOLTA_MINIMA; um teste
 * confere que as duas andam juntas). Uma versão que mude os dados de um jeito que as anteriores não abram sobe este
 * valor (e o do aplicativo) para ela mesma.)
 */
export const VOLTA_MINIMA = '1.1.0-rc.27';

/**
 * Dá para voltar a esta versão pelo aplicativo? 'pode': ela tem, publicado, o pacote assinado do canal; 'antiga':
 * anterior à VOLTA_MINIMA; 'sem-pacote': saiu sem o pacote assinado do canal (só pelo instalador da página dela).
 * Quem decide de verdade é o aplicativo, que confere o pacote assinado antes de trocar.
 */
export type Rollback = 'pode' | 'antiga' | 'sem-pacote';

/** Uma versão publicada, para a lista de Configurações › Atualizações (voltar para uma anterior). */
export interface ReleaseItem { version: string; url: string | null; publishedAt: string | null; prerelease: boolean; rollback: Rollback }

/** O que a lista diz sobre voltar a uma versão (função pura: testável). */
export function rollbackOf(version: string, assets: string[], channel: 'teste' | 'estavel'): Rollback {
  if (newer(VOLTA_MINIMA, version)) return 'antiga';
  const m = `manifesto-${channel}.json`;
  return assets.includes(m) && assets.includes(`${m}.sig`) ? 'pode' : 'sem-pacote';
}
/**
 * No Ergon Desktop, "Voltar para esta versão" vale só para as DUAS versões publicadas logo antes da instalada (decisão de
 * 09/11): a tela corta a lista nelas (web/src/lib/atualizacoes.ts, anteriores) e o aplicativo confere de novo pelo
 * manifesto assinado do canal ("recentes", desktop/src-tauri/src/atualizacao.rs, fora_das_duas_anteriores). Fora do
 * Desktop (servidor, Linux), a lista segue com até LISTA_ANTERIORES versões, cada uma com a página do instalador.
 */
export const LISTA_ANTERIORES = 12;
/** Quantas versões o manifesto do canal carrega em "recentes" (scripts/distribuicao/manifesto.mjs, RECENTES). */
export const RECENTES_DO_CANAL = 12;
/** O que a lista diz sobre voltar: o Rollback, ou 'instalada-fora' (a instalada já não está entre as publicadas recentemente). */
export type RollbackNaLista = Rollback | 'instalada-fora';
const maisNovaPrimeiro = (a: { version: string }, b: { version: string }) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0);
/**
 * As versões anteriores à instalada, a mais nova primeiro (função pura: testável). Se a instalada já não está entre as
 * RECENTES_DO_CANAL mais novas publicadas (a página dela saiu, ou ficou para trás), o aplicativo recusaria sempre a
 * volta: a lista não oferece o botão e diz por quê ('instalada-fora'); a página de cada versão segue com o instalador.
 */
export function anterioresParaVoltar<T extends { version: string; rollback?: Rollback }>(releases: T[], atual: string = VERSION): Array<Omit<T, 'rollback'> & { rollback?: RollbackNaLista }> {
  const ordenadas = [...releases].sort(maisNovaPrimeiro);
  const i = ordenadas.findIndex((x) => !newer(x.version, atual) && !newer(atual, x.version));
  const fora = ordenadas.length > 0 && (i < 0 || i >= RECENTES_DO_CANAL);
  return ordenadas.filter((x) => newer(atual, x.version)).slice(0, LISTA_ANTERIORES)
    .map((x) => (fora && x.rollback === 'pode' ? { ...x, rollback: 'instalada-fora' as const } : x));
}
export interface UpdateState { latest: Release | null; releases: ReleaseItem[]; checkedAt: string | null }

const VERSION_TAG = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * As notas sem os comentários HTML: o campo de segurança obrigatória (<!-- seguranca: motivo -->, scripts/distribuicao/
 * manifesto.mjs) e outras marcas para a publicação não aparecem na tela.
 */
export const semComentarios = (s: string): string => (s.includes('<!--') ? s.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim() : s);

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

  private api(): string | null {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\//.exec(this.url ?? '');
    return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=40` : null;
  }

  private async fromApi(): Promise<UpdateState | null> {
    const u = this.api();
    if (!u) return null;
    const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return null;
    const list = (await r.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; html_url?: string; body?: string | null; published_at?: string | null; assets?: Array<{ name?: unknown } | null> }>;
    if (!Array.isArray(list)) return null;
    // pré-versão instalada = canal de teste (vê as pré-versões); versão final = só as finais
    const teste = this.current.includes('-');
    const items = list
      .filter((x) => !x.draft && typeof x.tag_name === 'string' && VERSION_TAG.test(x.tag_name) && (teste || !x.prerelease))
      .map((x) => {
        const version = x.tag_name!.replace(/^v/, '');
        // o pacote assinado de cada versão fica anexado a ela, com o nome do canal (o mesmo que esta instalação segue)
        const assets = Array.isArray(x.assets) ? x.assets.map((a) => (typeof a?.name === 'string' ? a.name : '')) : [];
        return { version, url: typeof x.html_url === 'string' && x.html_url.startsWith('https://') ? x.html_url : null, publishedAt: x.published_at ?? null, prerelease: !!x.prerelease,
          rollback: rollbackOf(version, assets, teste ? 'teste' : 'estavel'), notes: typeof x.body === 'string' ? semComentarios(x.body).slice(0, 2000) : null };
      })
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
    return { version: j.version.replace(/^v/, ''), notes: typeof j.notes === 'string' ? semComentarios(j.notes).slice(0, 2000) : null, url: typeof j.url === 'string' && j.url.startsWith('https://') ? j.url : null, publishedAt: j.publishedAt ?? j.published_at ?? null };
  }
}
