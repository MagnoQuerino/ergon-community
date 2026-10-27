import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type ErgonApp } from '../src/app.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { Db } from '../src/db/db.ts';
import type { HermesClient, HermesControlClient } from '../src/services/hermes.ts';
import { Vault } from '../src/security/keys.ts';
import { KDF_TEST } from '../src/security/crypto.ts';

process.env.NODE_ENV = 'test';

// Teste não toca a rede: fora do próprio computador, a requisição falha como "sem rede" (os simuladores de cada
// teste respondem antes de chegar aqui). Antes, um endereço que o simulador esquecia — o login da Microsoft —
// escapava para o serviço de verdade.
const networkFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return Promise.reject(Object.assign(new TypeError(`teste tentou sair para a rede: ${u.host}`), { cause: { code: 'ENOTFOUND' } }));
  return networkFetch(input, init);
}) as typeof fetch;

export const ORIGIN = 'http://localhost:8787';
export const FIXTURES = path.resolve(import.meta.dirname, '..', '..', 'fixtures');

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ergon-test-'));
}

export function testConfig(dataDir: string, over: Partial<Config> = {}): Config {
  return loadConfig({ ERGON_DATA_DIR: dataDir, ERGON_SIMULATED_DELAY_MS: '0', ERGON_FIXTURES_DIR: FIXTURES, ERGON_KDF: 'test', ERGON_MAX_CONCURRENT_RUNS: '1' } as NodeJS.ProcessEnv, over);
}

export interface Harness extends ErgonApp {
  cfg: Config;
  dir: string;
  close(): Promise<void>;
}

/** Cofres abertos por pasta: reabrir a mesma pasta = servidor reiniciado depois de destrancado (MK na memória). */
const vaults = new Map<string, Vault>();

export async function harness(over: Partial<Config> = {}, opts: { dir?: string; hermes?: HermesClient | null; control?: HermesControlClient | null; vault?: Vault;
  motorClients?: (userId: string) => { hermes: HermesClient | null; control: HermesControlClient | null }; motorFetch?: typeof fetch } = {}): Promise<Harness> {
  const dir = opts.dir ?? tmpDir();
  const cfg = testConfig(dir, over);
  const vault = opts.vault ?? vaults.get(dir) ?? new Vault(dir, KDF_TEST);
  vaults.set(dir, vault);
  // como o index.ts: protegido e aberto → banco cifrado com a chave; sem proteção → em claro (o 1º uso protege)
  const db = new Db(cfg.dbPath, vault.state() === 'open' ? { key: vault.dbKey() } : {});
  db.migrate();
  const built = await buildApp({ cfg, db, vault, hermes: opts.hermes === undefined ? null : opts.hermes, control: opts.control ?? null, motorClients: opts.motorClients, motorFetch: opts.motorFetch });
  return {
    ...built, cfg, dir,
    async close() { built.executor.stop(); await built.stopBackground(); await built.app.close(); db.close(); },
  };
}

export interface Session { cookie: string; csrf: string; workspaceId: string; userId: string }

export async function req(h: ErgonApp, method: string, url: string, s?: Session | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await h.app.inject({
    method: method as 'GET',
    url,
    headers: {
      ...(s ? { cookie: s.cookie } : {}),
      ...(s && method !== 'GET' ? { 'x-csrf-token': s.csrf } : {}),
      ...(method !== 'GET' ? { origin: ORIGIN } : {}),
      ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  let json: any = null;
  try { json = res.json(); } catch { json = null; }
  return { status: res.statusCode, json, res };
}

async function sessionFrom(h: ErgonApp, setCookie: string | string[] | undefined): Promise<Session> {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('sem cookie de sessão');
  const cookie = raw.split(';')[0];
  const me = await h.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const j = me.json();
  return { cookie, csrf: j.csrf, workspaceId: j.workspaceId, userId: j.user.id };
}

/** Frase mostrada no primeiro uso (para confirmar depois, como a tela faz). */
const firstPhrase = new WeakMap<ErgonApp, { s: Session; recovery: Recovery; confirmed: boolean }>();
export interface Recovery { phrase: string; ask: number[] }
export const answersFor = (r: Recovery) => Object.fromEntries(r.ask.map((p) => [String(p), r.phrase.split(' ')[p - 1]]));

export async function setupOwner(h: ErgonApp, username = 'alexandre', password = 'senha-local-123'): Promise<Session> {
  const r = await req(h, 'POST', '/api/auth/setup', null, { username, password, displayName: 'Alexandre' });
  if (r.status !== 200) throw new Error(`setup falhou: ${r.status} ${JSON.stringify(r.json)}`);
  const s = await sessionFrom(h, r.res.headers['set-cookie']);
  if (r.json?.recovery) firstPhrase.set(h, { s, recovery: r.json.recovery, confirmed: false });
  return s;
}

/** Confirma a frase pessoal (3 palavras), como a tela do primeiro uso. */
export async function confirmPhrase(h: ErgonApp, s: Session, recovery: Recovery): Promise<void> {
  const r = await req(h, 'POST', '/api/security/recovery/confirm', s, { answers: answersFor(recovery) });
  if (r.status !== 200) throw new Error(`frase não confirmada: ${r.status} ${JSON.stringify(r.json)}`);
}

/**
 * Outra pessoa neste computador, pela tela de entrada ("Criar conta"). Quem já está aqui precisa ter a frase pessoal
 * confirmada (a partir da segunda conta, a parte de cada um só abre pela senha ou frase da própria pessoa).
 */
export async function addPerson(h: ErgonApp, username: string, password: string, displayName = username): Promise<Session & { recovery: Recovery }> {
  const first = firstPhrase.get(h);
  if (first && !first.confirmed) { await confirmPhrase(h, first.s, first.recovery); first.confirmed = true; }
  const r = await req(h, 'POST', '/api/auth/register', null, { username, password, displayName });
  if (r.status !== 200) throw new Error(`cadastro falhou: ${r.status} ${JSON.stringify(r.json)}`);
  return { ...(await sessionFrom(h, r.res.headers['set-cookie'])), recovery: r.json.recovery };
}

export async function loginAs(h: ErgonApp, username: string, password: string): Promise<Session> {
  const r = await req(h, 'POST', '/api/auth/login', null, { username, password });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status}`);
  return sessionFrom(h, r.res.headers['set-cookie']);
}

export async function drain(h: ErgonApp, ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) await h.executor.tick();
}
