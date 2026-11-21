/**
 * Buscar uma página ou uma imagem da internet para a pré-visualização de link (título, descrição e imagem) sem abrir
 * caminho para dentro da rede da pessoa (SSRF). Regras:
 *   - só http e https, nas portas 80 e 443, sem usuário:senha no endereço;
 *   - o nome é resolvido aqui e TODOS os endereços têm de ser públicos (nada de 127/8, 10/8, 172.16/12, 192.168/16,
 *     169.254/16 — a nuvem guarda credenciais ali —, 100.64/10, ::1, fc00::/7, fe80::/10, IPv4 dentro de IPv6…); a
 *     conexão vai ao endereço já conferido (o nome não é resolvido de novo: sem "DNS rebinding");
 *   - no máximo 3 redirecionamentos, cada um conferido de novo;
 *   - tempo limite total e tamanho máximo (o corpo é cortado e a busca desiste ao passar).
 * Os cookies e as credenciais da pessoa nunca vão: é uma busca anônima do servidor.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class Recusado extends Error {
  readonly motivo: string;
  constructor(motivo: string) { super(motivo); this.motivo = motivo; }
}

const v4 = (ip: string) => ip.split('.').map(Number);
/** endereço que não é da internet pública */
export function ipPrivado(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = v4(ip);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const mapeado = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapeado) return ipPrivado(mapeado[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) {
      const [, h1, h2] = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(x)!;
      const n1 = parseInt(h1, 16); const n2 = parseInt(h2, 16);
      return ipPrivado(`${n1 >> 8}.${n1 & 255}.${n2 >> 8}.${n2 & 255}`);
    }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8') || x.startsWith('100:');
  }
  return true;
}

export interface OpcoesBusca {
  tempoMs?: number; maxBytes?: number; aceitar?: RegExp;
  /** testes: resolver próprio e endereços de teste aceitos (nunca em produção) */
  resolver?: (host: string) => Promise<string[]>;
  confiarEm?: string[];
}
export interface Resposta { url: string; status: number; tipo: string; corpo: Buffer }

/** O endereço é aceitável? Devolve o URL normalizado ou lança Recusado. */
export function conferirUrl(u: string): URL {
  let x: URL;
  try { x = new URL(u); } catch { throw new Recusado('endereço inválido'); }
  if (!['http:', 'https:'].includes(x.protocol)) throw new Recusado('só http e https');
  if (x.username || x.password) throw new Recusado('endereço com usuário e senha');
  if (x.port && !['80', '443'].includes(x.port)) throw new Recusado('porta não permitida');
  const host = x.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$/i.test(host)) throw new Recusado('endereço interno');
  if (net.isIP(host) && ipPrivado(host)) throw new Recusado('endereço interno');
  return x;
}

async function resolverPublico(host: string, o: OpcoesBusca): Promise<string> {
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) {
    if (ipPrivado(h) && !o.confiarEm?.includes(h)) throw new Recusado('endereço interno');
    return h;
  }
  let ips: string[];
  try { ips = o.resolver ? await o.resolver(h) : (await dns.lookup(h, { all: true, verbatim: true })).map((a) => a.address); } catch { throw new Recusado('nome não encontrado'); }
  if (!ips.length) throw new Recusado('nome não encontrado');
  // todos públicos: um nome que aponta também para dentro é recusado inteiro
  if (ips.some((ip) => ipPrivado(ip) && !o.confiarEm?.includes(ip))) throw new Recusado('endereço interno');
  return ips[0];
}

function pedido(x: URL, ip: string, o: Required<Pick<OpcoesBusca, 'maxBytes'>> & { fim: number }): Promise<{ status: number; tipo: string; local: string | null; corpo: Buffer }> {
  return new Promise((ok, falha) => {
    const lib = x.protocol === 'https:' ? https : http;
    const resto = Math.max(1, o.fim - Date.now());
    const req = lib.request({
      host: ip, port: x.port || (x.protocol === 'https:' ? 443 : 80), path: `${x.pathname}${x.search}`, method: 'GET', servername: net.isIP(x.hostname) ? undefined : x.hostname,
      headers: { host: x.host, 'user-agent': 'Mozilla/5.0 (compatible; ErgonPreview/1.0)', accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6' },
      timeout: resto, agent: false,
      // a conexão vai ao IP conferido; o nome não é resolvido de novo
      lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, ip, net.isIPv6(ip) ? 6 : 4),
    }, (res) => {
      const partes: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > o.maxBytes) { partes.push(c.subarray(0, Math.max(0, o.maxBytes - (n - c.length)))); res.destroy(); return; } partes.push(c); });
      const acabou = () => ok({ status: res.statusCode ?? 0, tipo: String(res.headers['content-type'] ?? ''), local: typeof res.headers.location === 'string' ? res.headers.location : null, corpo: Buffer.concat(partes) });
      res.on('end', acabou); res.on('close', acabou);
      res.on('error', () => acabou());
    });
    const timer = setTimeout(() => req.destroy(new Recusado('tempo esgotado')), resto);
    req.on('timeout', () => req.destroy(new Recusado('tempo esgotado')));
    req.on('error', (e) => { clearTimeout(timer); falha(e instanceof Recusado ? e : new Recusado('não respondeu')); });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** GET seguro: segue até 3 redirecionamentos, cada um conferido; corta no tamanho máximo. */
export async function buscarSeguro(url: string, o: OpcoesBusca = {}): Promise<Resposta> {
  const fim = Date.now() + (o.tempoMs ?? 5000); const maxBytes = o.maxBytes ?? 512 * 1024;
  let x = conferirUrl(url);
  for (let salto = 0; salto <= 3; salto++) {
    const ip = await resolverPublico(x.hostname, o);
    const r = await pedido(x, ip, { maxBytes, fim });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.local) {
      x = conferirUrl(new URL(r.local, x).toString());
      continue;
    }
    if (o.aceitar && !o.aceitar.test(r.tipo)) throw new Recusado('tipo de conteúdo não aceito');
    return { url: x.toString(), status: r.status, tipo: r.tipo, corpo: r.corpo };
  }
  throw new Recusado('redirecionamentos demais');
}

// ------------------------------------------------------------------------------------------------ metadados da página

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', ordm: 'º', ordf: 'ª', deg: '°' };
// as letras acentuadas com nome (&aacute; &Ccedil; &otilde;…)
for (const [l, acentos] of Object.entries({ a: 'acute grave circ tilde uml', e: 'acute grave circ uml', i: 'acute grave circ uml', o: 'acute grave circ tilde uml', u: 'acute grave circ uml', c: 'cedil', n: 'tilde' })) {
  const marca: Record<string, string> = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327' };
  for (const a of acentos.split(' ')) { ENT[`${l}${a}`] = `${l}${marca[a]}`.normalize('NFC'); ENT[`${l.toUpperCase()}${a}`] = `${l.toUpperCase()}${marca[a]}`.normalize('NFC'); }
}
const entidades = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
});
const limpo = (s: string | undefined, max: number) => (s ? entidades(s).replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface Metadados { titulo: string; descricao: string; imagem: string | null; site: string }
/** O título, a descrição, a imagem e o nome do site (Open Graph, Twitter e o <title>), só como texto. */
export function metadadosDe(html: string, base: string): Metadados {
  const cab = html.slice(0, 200_000);
  const metas = [...cab.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, a: string) => new RegExp(`\\b${a}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find((x) => x !== undefined);
  const meta = (...nomes: string[]) => {
    for (const n of nomes) {
      const t = metas.find((m) => (attr(m, 'property') ?? attr(m, 'name') ?? '').toLowerCase() === n);
      const v = t ? attr(t, 'content') : undefined;
      if (v) return v;
    }
    return undefined;
  };
  const titulo = limpo(meta('og:title', 'twitter:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cab)?.[1], 140);
  const descricao = limpo(meta('og:description', 'twitter:description', 'description'), 300);
  let imagem: string | null = null;
  const im = meta('og:image:secure_url', 'og:image', 'twitter:image');
  if (im) { try { const u = new URL(entidades(im), base); if (u.protocol === 'https:' || u.protocol === 'http:') imagem = u.toString(); } catch { /* sem imagem */ } }
  let site = limpo(meta('og:site_name', 'application-name'), 60);
  if (!site) { try { site = new URL(base).hostname.replace(/^www\./, ''); } catch { site = ''; } }
  return { titulo, descricao, imagem, site };
}
