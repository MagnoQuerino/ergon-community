/**
 * Portão de destrancar: com o Ergon protegido, depois de reiniciar o processo não tem a chave mestra — o banco
 * cifrado nem abre. Este servidor mínimo serve só a interface (para a tela de destrancar) e três formas de
 * abrir: senha, frase de recuperação (com senha nova) ou a chave do cofre do sistema (o lançador do
 * computador, se a pessoa ligou "destrancar sozinho"). Aberto, ele entrega o banco ao servidor completo.
 */
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Db } from './db/db.ts';
import { HttpError } from './lib/util.ts';
import { throttle } from './security/factors.ts';
import type { Vault } from './security/keys.ts';
import { SESSION_COOKIE, checkCredentials, createSession, defaultWorkspace, setUserPassword, startSecondFactor, userFactors } from './services/auth.ts';
import { canonicalHostHook, rpConfig, sessionDays } from './services/security.ts';
import { VERSION } from './version.ts';

/** Monta o portão (sem escutar): `done` resolve com o banco aberto depois de destrancar. */
export async function buildGate(cfg: Config, vault: Vault, openDb: () => Db): Promise<{ app: FastifyInstance; done: Promise<Db> }> {
  const app = Fastify({ logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.ERGON_LOG_LEVEL ?? 'info' }, bodyLimit: 16 * 1024 });
  await app.register(fastifyCookie);
  const COOKIE = `${SESSION_COOKIE}_${cfg.port}`;
  let opened: ((db: Db) => void) | null = null;
  const done = new Promise<Db>((resolve) => { opened = resolve; });
  let db: Db | null = null;

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.validation) return reply.status(400).send({ error: 'validation', message: err.message });
    return reply.status(500).send({ error: 'internal', message: 'erro interno' });
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer'); reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });
  app.addHook('onRequest', canonicalHostHook(cfg));
  app.addHook('onRequest', async (req) => {
    if (req.method !== 'POST') return;
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'origin', 'origem não permitida');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'origin', 'requisição entre sites bloqueada');
  });

  /** Abre o banco uma vez (já destrancado o cofre). */
  const open = (): Db => { if (!db) { db = openDb(); db.migrate(); } return db; };
  const handOver = () => setImmediate(() => opened!(open()));
  const meta = (req: FastifyRequest) => ({ ua: String(req.headers['user-agent'] ?? ''), ip: req.ip });
  const login = (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const d = open();
    const ws = defaultWorkspace(d, userId);
    const f = userFactors(d, userId);
    if (f.totp || f.passkeys) return { ok: false, need2fa: true, challenge: startSecondFactor(userId, ws), methods: { totp: f.totp, passkey: f.passkeys > 0 } };
    const days = sessionDays(cfg, vault);
    const s = createSession(d, userId, ws, meta(req), days);
    reply.setCookie(COOKIE, s.token, { httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/', maxAge: days * 86400 });
    return { ok: true };
  };

  app.get('/api/health', async () => ({ ok: true, service: 'ergon', version: VERSION, sealed: true }));
  app.get('/api/auth/state', async () => ({
    needsSetup: false, authenticated: false, locked: false, sealed: true, protected: true, mode: cfg.mode,
    rpId: rpConfig(cfg).rpID, publicUrl: cfg.publicUrl, recovery: vault.info().recovery, setupTokenRequired: false,
  }));

  const str = (max: number, min = 1) => ({ type: 'string', minLength: min, maxLength: max });
  app.post('/api/unseal', { schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: str(32), password: str(200) } } } }, async (req, reply) => {
    const b = req.body as { username: string; password: string };
    throttle.check(`unseal:${req.ip}`); throttle.check(`unseal:${b.username}`);
    const r = vault.state() === 'open' ? null : await vault.unsealPassword(b.username, b.password);
    if (vault.state() !== 'open' || (!r && !db)) { throttle.fail(`unseal:${req.ip}`); throttle.fail(`unseal:${b.username}`); throw new HttpError(401, 'invalid_login', 'usuário ou senha inválidos'); }
    throttle.ok(`unseal:${b.username}`);
    const who = await checkCredentials(open(), b.username, b.password, cfg.kdf); // confere também o cadastro
    const out = login(req, reply, who.userId);
    handOver();
    return out;
  });

  app.post('/api/unseal/recovery', { schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'phrase', 'newPassword'], properties: { username: str(32), phrase: str(400, 20), newPassword: str(200) } } } }, async (req, reply) => {
    const b = req.body as { username: string; phrase: string; newPassword: string };
    throttle.check(`unseal:${req.ip}`);
    if (!(await vault.unsealRecovery(b.phrase))) { throttle.fail(`unseal:${req.ip}`); throw new HttpError(401, 'invalid_phrase', 'frase de recuperação não confere'); }
    const d = open();
    const u = d.get<{ id: string; username: string; display_name: string }>('SELECT id, username, display_name FROM users WHERE username = ?', b.username);
    if (!u) throw new HttpError(404, 'user', 'usuário não encontrado (o Ergon foi destrancado; entre com outro usuário)');
    // com chave pessoal, a frase precisa ser da própria conta (a de outra pessoa abre o Ergon, não troca a senha desta)
    if (vault.hasPerson(u.id) && !vault.personOpen(u.id)) throw new HttpError(401, 'invalid_phrase', 'esta frase não é da conta informada');
    await setUserPassword(d, u.id, b.newPassword, cfg.kdf, [u.username, u.display_name]);
    if (vault.hasPerson(u.id)) await vault.setPersonPassword({ id: u.id, username: u.username }, b.newPassword);
    else await vault.setPassword({ id: u.id, username: u.username }, b.newPassword);
    d.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    const out = login(req, reply, u.id);
    handOver();
    return out;
  });

  // chave do cofre do sistema (lançador do computador): só destranca, não cria sessão
  app.post('/api/unseal/auto', { schema: { body: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } } }, async (req) => {
    throttle.check(`unseal-auto:${req.ip}`);
    if (!vault.unsealAuto((req.body as { key: string }).key)) { throttle.fail(`unseal-auto:${req.ip}`); throw new HttpError(401, 'invalid_key', 'chave do destrancar sozinho não confere (foi desligada?)'); }
    open();
    handOver();
    return { ok: true };
  });

  app.all('/api/*', async () => { throw new HttpError(423, 'sealed', 'O Ergon está trancado: digite a senha para abrir.'); });
  app.all('/internal/*', async () => { throw new HttpError(423, 'sealed', 'trancado'); });

  if (cfg.webDir && fs.existsSync(path.join(cfg.webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: cfg.webDir, prefix: '/', index: ['index.html'],
      setHeaders: (res, filePath) => { if (path.basename(filePath) === 'index.html') res.header('Cache-Control', 'no-cache'); },
    });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/assets/') ? reply.status(404).send({ error: 'not_found' }) : reply.header('Cache-Control', 'no-cache').sendFile('index.html')));
  }

  return { app, done };
}

/** Escuta na porta do Ergon até destrancar; devolve o banco aberto ao servidor completo. */
export async function runGate(cfg: Config, vault: Vault, openDb: () => Db): Promise<Db> {
  const { app, done } = await buildGate(cfg, vault, openDb);
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info('Ergon trancado: aguardando senha, frase de recuperação ou o destrancar sozinho');
  const out = await done;
  await app.close();
  return out;
}
