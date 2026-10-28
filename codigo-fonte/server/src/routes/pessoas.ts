/**
 * Pessoas neste computador: criar conta pela tela de entrada (aberto ou com convite), a lista e os
 * convites para quem administra, e remover conta (a pessoa, ou quem administra). Quem administra não lê os dados de
 * ninguém: vê só quem tem conta, quando entrou e se a frase pessoal já foi gerada.
 */
import type { FastifyInstance } from 'fastify';
import { HttpError, now } from '../lib/util.ts';
import { throttle } from '../security/factors.ts';
import { SESSION_COOKIE, createSession, requireRecentAuth } from '../services/auth.ts';
import { audit } from '../services/bus.ts';
import { createInvite, isAdmin, listInvites, registerPerson, removePersonData, revokeInvite, signupPolicy } from '../services/people.ts';
import { sessionDays, setInstanceSetting, type SecurityDeps } from '../services/security.ts';

const str = (max: number, min = 0) => ({ type: 'string', minLength: min, maxLength: max });

export function registerPeopleRoutes(app: FastifyInstance, d: SecurityDeps & { upkeep: (userId: string) => void; removeMotor: (userId: string) => Promise<void> }): void {
  const { db, vault, cfg } = d;

  // Conta nova neste computador (tela de entrada). Devolve a frase da pessoa (mostrada uma vez; vale depois de confirmada).
  app.post('/api/auth/register', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: {
      username: str(32, 3), password: str(200, 1), displayName: str(60), invite: str(20) } } },
  }, async (req, reply) => {
    const b = req.body as { username: string; password: string; displayName?: string; invite?: string };
    const keys = d.people.keys();
    if (cfg.mode !== 'local' || !keys) throw new HttpError(404, 'not_found', 'rota não encontrada');
    throttle.check(`register:${req.ip}`);
    let r;
    try {
      r = await registerPerson({ db, vault, keys, owners: d.people.owners, cfg }, { username: b.username, password: b.password, displayName: (b.displayName ?? '').trim() || b.username, invite: b.invite });
    } catch (e) { if ((e as HttpError).code === 'invite') throttle.fail(`register:${req.ip}`); throw e; }
    throttle.ok(`register:${req.ip}`);
    d.upkeep(r.userId);
    audit(db, d.bus, { workspaceId: r.workspaceId, actorType: 'user', actorId: r.userId, action: 'people.register', evidence: { policy: signupPolicy(db) }, result: 'conta criada neste computador (chave pessoal própria)' });
    const days = sessionDays(cfg, vault);
    d.setCookie(reply, createSession(db, r.userId, r.workspaceId, { ua: String(req.headers['user-agent'] ?? ''), ip: req.ip }, days).token, days);
    return { ok: true, recovery: vault.newPersonRecovery(r.userId) };
  });

  // Quem administra: pessoas, política de conta nova e convites ---------------------------------------------------
  app.get('/api/people', async (req) => {
    d.admin(req);
    const keys = vault.peopleInfo();
    const rows = db.all<{ id: string; username: string; display_name: string; created_at: string; is_admin: number; last_seen: string | null }>(
      `SELECT u.id, u.username, u.display_name, u.created_at, u.is_admin, (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u ORDER BY u.created_at`);
    return {
      signup: signupPolicy(db), isolated: vault.multiPerson(), invites: listInvites(db),
      people: rows.map((u) => {
        const k = keys.find((x) => x.userId === u.id);
        return { id: u.id, username: u.username, displayName: u.display_name, createdAt: u.created_at, lastSeen: u.last_seen, admin: !!u.is_admin,
          phrase: !!k?.recovery, open: !!k?.open, migrated: !!k };
      }),
    };
  });
  app.put('/api/people/signup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['policy'], properties: { policy: { enum: ['aberto', 'convite'] } } } },
  }, async (req) => {
    const a = d.admin(req);
    const policy = (req.body as { policy: 'aberto' | 'convite' }).policy;
    setInstanceSetting(db, 'signup', policy);
    audit(db, d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'people.signup', evidence: { policy },
      result: policy === 'aberto' ? 'qualquer pessoa neste computador pode criar conta' : 'conta nova só com convite' });
    return { signup: policy };
  });
  app.post('/api/people/invites', async (req) => {
    const a = d.admin(req); requireRecentAuth(a);
    const inv = createInvite(db, a.userId);
    audit(db, d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'people.invite', evidence: { expiresAt: inv.expiresAt }, result: 'convite criado (uso único)' });
    return inv;
  });
  app.delete('/api/people/invites/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^inv_[a-f0-9]{32}$' } } } } }, async (req) => {
    d.admin(req);
    return { ok: revokeInvite(db, (req.params as { id: string }).id) };
  });

  // Remover conta: a própria pessoa, ou quem administra (a de outra pessoa). Pede a identidade confirmada há pouco
  // e o usuário digitado de novo. Quem administra não sai (os ajustes da instalação ficariam sem dono).
  const remove = (actor: { userId: string; workspaceId: string }, target: { id: string; username: string }) => {
    if (isAdmin(db, target.id)) throw new HttpError(409, 'admin_stays', 'A conta que administra o Ergon neste computador não pode ser removida.');
    const out = removePersonData(db, vault, d.people.owners, cfg, target.id);
    // o motor dela (contêiner e cofre) sai pelo gerente; se ele não responder agora, o cofre já não abre (a chave saiu)
    void d.removeMotor(target.id).catch(() => undefined);
    if (actor.userId !== target.id) {
      audit(db, d.bus, { workspaceId: actor.workspaceId, actorType: 'user', actorId: actor.userId, action: 'people.remove', evidence: { username: target.username, ...out, at: now() },
        result: 'conta removida: a chave saiu primeiro (conteúdo ilegível), depois os dados e os arquivos' });
    }
    return out;
  };
  const confirmBody = { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: str(32, 1) } };
  app.delete('/api/people/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^usr_[a-f0-9]{32}$' } } }, body: confirmBody } }, async (req) => {
    const a = d.admin(req); requireRecentAuth(a);
    const u = db.get<{ id: string; username: string }>('SELECT id, username FROM users WHERE id = ?', (req.params as { id: string }).id);
    if (!u) throw new HttpError(404, 'not_found', 'conta não encontrada');
    if ((req.body as { confirm: string }).confirm !== u.username) throw new HttpError(400, 'confirm', 'Digite o usuário da conta para confirmar.');
    return { ok: true, ...remove(a, u) };
  });
  app.delete('/api/me/account', { schema: { body: confirmBody } }, async (req, reply) => {
    const a = d.auth(req); requireRecentAuth(a);
    if ((req.body as { confirm: string }).confirm !== a.username) throw new HttpError(400, 'confirm', 'Digite o seu usuário para confirmar.');
    const out = remove(a, { id: a.userId, username: a.username });
    reply.clearCookie(`${SESSION_COOKIE}_${cfg.port}`, { path: '/' });
    return { ok: true, ...out };
  });
}
