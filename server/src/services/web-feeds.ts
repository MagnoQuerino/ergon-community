/**
 * Fontes públicas para os radares (notícias, regulatório, concorrência), lidas por código: busca de notícias (RSS do
 * Google Notícias) e feeds RSS/Atom que o usuário indicar. Só HTTPS, nunca endereços internos (rede local, nuvem,
 * localhost), redirecionamentos conferidos de novo, tempo e tamanho limitados. Título, fonte, data e link — o que
 * o agente cita tem de estar aqui (a conferência confere os links).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { clip } from '../lib/util.ts';
import { fetchWithPolicy } from '../lib/http.ts';
import { xmlText } from './doc-text.ts';
import { neutral } from './operations.ts';

export interface FeedItem { title: string; link: string; source: string; at: string | null; summary: string }
export interface FeedRead { label: string; url: string; status: 'ok' | 'erro' | 'bloqueado'; count: number; detail?: string; ms: number }

const MAX_BYTES = 2 * 1024 * 1024; const TIMEOUT = 12_000;

/** Endereço privado, local ou reservado (não pode ser buscado pelo servidor). */
export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateAddress(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

/** Confere o endereço (HTTPS, sem credenciais, sem porta estranha, nome que resolve para fora). */
export async function checkUrl(raw: string, lookup: (h: string) => Promise<string[]> = defaultLookup): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FeedError('bloqueado', 'endereço inválido'); }
  if (u.protocol !== 'https:') throw new FeedError('bloqueado', 'só endereços https');
  if (u.username || u.password) throw new FeedError('bloqueado', 'endereço com usuário e senha');
  if (u.port && u.port !== '443') throw new FeedError('bloqueado', 'porta não permitida');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FeedError('bloqueado', 'endereço interno');
  const ips = net.isIP(host) ? [host] : await lookup(host).catch(() => { throw new FeedError('erro', 'o endereço não existe'); });
  if (!ips.length || ips.some(privateAddress)) throw new FeedError('bloqueado', 'endereço interno ou reservado');
  return u;
}
const defaultLookup = async (h: string) => (await dns.lookup(h, { all: true })).map((a) => a.address);

export class FeedError extends Error { readonly kind: 'erro' | 'bloqueado'; constructor(kind: 'erro' | 'bloqueado', m: string) { super(m); this.kind = kind; } }

/** Busca com os limites (redirecionamento conferido a cada salto). */
export async function safeFetch(raw: string, lookup?: (h: string) => Promise<string[]>): Promise<string> {
  let url = await checkUrl(raw, lookup);
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    const at = url;
    try { res = await fetchWithPolicy(() => fetch(at, { redirect: 'manual', headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', 'User-Agent': 'Ergon/0.2 (radar de rotinas)' }, signal: AbortSignal.timeout(TIMEOUT) }), { attempts: 2, budgetMs: 15_000 }); }
    catch { throw new FeedError('erro', 'a fonte não respondeu'); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = await checkUrl(new URL(res.headers.get('location')!, url).toString(), lookup); continue; }
    if (!res.ok) throw new FeedError('erro', `a fonte respondeu ${res.status}`);
    const reader = res.body?.getReader(); if (!reader) return '';
    const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BYTES) { await reader.cancel(); throw new FeedError('erro', 'resposta grande demais'); } chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new FeedError('erro', 'redirecionamentos demais');
}

const strip = (s: string) => xmlText(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const get = (b: string, k: string) => b.match(new RegExp(`<${k}\\b[^>]*>([\\s\\S]*?)</${k}>`, 'i'))?.[1];

/** link citável: https, sem espaço nem colchetes (não vira linha de controle) */
const SAFE_LINK = /^https:\/\/[^\s<>"[\]]{4,600}$/;

/** RSS 2.0 ou Atom → itens (título, link, fonte, data, resumo curto). */
export function parseFeed(xml: string, fallbackSource: string): FeedItem[] {
  const out: FeedItem[] = [];
  const channel = strip(get(xml, 'title') ?? '') || fallbackSource;
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = strip(get(b, 'title') ?? ''); const link = strip(get(b, 'link') ?? '') || (b.match(/<guid[^>]*>(https:[^<]+)<\/guid>/i)?.[1] ?? '');
    const src = strip(get(b, 'source') ?? '') || channel;
    const d = Date.parse(strip(get(b, 'pubDate') ?? get(b, 'dc:date') ?? ''));
    if (title && SAFE_LINK.test(link)) out.push({ title, link, source: src, at: Number.isFinite(d) ? new Date(d).toISOString() : null, summary: clip(strip(get(b, 'description') ?? ''), 280) });
  }
  for (const m of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const b = m[0];
    const title = strip(get(b, 'title') ?? ''); const link = b.match(/<link\b[^>]*href="(https:[^"]+)"/i)?.[1] ?? '';
    const d = Date.parse(strip(get(b, 'published') ?? get(b, 'updated') ?? ''));
    if (title && SAFE_LINK.test(xmlText(link))) out.push({ title, link: xmlText(link), source: channel, at: Number.isFinite(d) ? new Date(d).toISOString() : null, summary: clip(strip(get(b, 'summary') ?? get(b, 'content') ?? ''), 280) });
  }
  return out;
}

/** Busca de notícias (Google Notícias, em português do Brasil) dos últimos dias. */
export const newsUrl = (q: string, days = 7) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

/** Lê as buscas e os feeds; cada um registra o resultado (para a conferência), um com problema não para os outros. */
export async function readFeeds(list: Array<{ label: string; url: string }>, since: string | null, opts: { max?: number; fetcher?: (u: string) => Promise<string> } = {}): Promise<{ items: Array<FeedItem & { from: string }>; reads: FeedRead[] }> {
  const fetcher = opts.fetcher ?? ((u: string) => safeFetch(u));
  const reads: FeedRead[] = []; const items: Array<FeedItem & { from: string }> = []; const seen = new Set<string>();
  for (const f of list.slice(0, 15)) {
    const t0 = Date.now();
    try {
      const xml = await fetcher(f.url);
      const got = parseFeed(xml, f.label).filter((i) => !since || !i.at || i.at >= since);
      let n = 0;
      for (const i of got) {
        const k = i.title.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^a-z0-9à-ú]+/g, ' ').trim();
        if (seen.has(k)) continue; seen.add(k); items.push({ ...i, from: f.label }); n++;
      }
      reads.push({ label: f.label, url: f.url, status: 'ok', count: n, ms: Date.now() - t0 });
    } catch (err) {
      reads.push({ label: f.label, url: f.url, status: err instanceof FeedError ? err.kind : 'erro', count: 0, ms: Date.now() - t0, detail: clip(err instanceof Error ? err.message : String(err), 120) });
    }
  }
  items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return { items: items.slice(0, opts.max ?? 40), reads };
}

const brdt = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : 's/ data');
/** Linha de fato de uma notícia: tudo de terceiros neutralizado (sem linhas de controle). */
export const feedLine = (i: FeedItem & { from: string }) =>
  `${brdt(i.at)} · ${neutral(clip(i.title, 160), 162)} · ${neutral(clip(i.source, 50), 52)} · busca: ${neutral(i.from, 60)} · ${i.link}${i.summary && !i.summary.startsWith(i.title.slice(0, 30)) ? ` · resumo: ${neutral(clip(i.summary, 200), 202)}` : ''}`;
