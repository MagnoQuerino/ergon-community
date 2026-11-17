/**
 * Rotas de Conexões › "Conversar com a equipe" pelo Teams e pelos bots do Ergon no Discord e no Telegram (contrato,
 * 7.2). As do Teams são da pessoa dona do workspace; as dos bots, de qualquer membro (cada conta ligada é de um membro e
 * age como ele). Ligar uma conta pelo código equivale a cadastrar um aparelho novo que manda na equipe: confirmar pede a
 * mesma verificação de identidade das autorizações (senha; passkey também serve).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { S } from '../../lib/schemas.ts';
import type { AuthContext } from '../auth.ts';
import type { Plataforma } from './armazenamento.ts';
import type { TeamsApp } from './servico.ts';

interface TeamsAppRoutesDeps {
  teamsApp: TeamsApp;
  owner: (req: FastifyRequest) => AuthContext;
  admin: (req: FastifyRequest) => AuthContext;
  /** qualquer membro do workspace (os bots oficiais: cada conta ligada é de um membro e age como ele); padrão: owner */
  member?: (req: FastifyRequest) => AuthContext;
  /** a verificação de /api/proposals/:id/authorize (secApi.verify) */
  verify: (req: FastifyRequest, ctx: AuthContext, body: { password?: string; code?: string; key?: string; response?: Record<string, unknown> }) => Promise<void>;
}

const vinculoParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^bnd_[A-Za-z0-9_-]{8,40}$' } } };
const claimId = { type: 'string', pattern: '^clm_[A-Za-z0-9_-]{8,40}$' };
/** A plataforma de onde a pessoa liga (só muda os textos de erro: quem decide é a conta que pediu o código). */
const canal = { type: 'string', enum: ['teams', 'discord', 'telegram'] };

export function registerTeamsAppRoutes(app: FastifyInstance, d: TeamsAppRoutesDeps): void {
  const { teamsApp: t, owner, admin, verify } = d;
  const member = d.member ?? owner;
  // bots oficiais (Telegram, Discord): cada membro liga as próprias contas, com um clique, e desliga quando quiser
  const platParams = { type: 'object', required: ['plat'], properties: { plat: { type: 'string', enum: ['telegram', 'discord'] } } };
  const platVinculo = { type: 'object', required: ['plat', 'id'], properties: { plat: platParams.properties.plat, id: vinculoParams.properties.id } };
  app.get('/api/canais-oficiais/:plat', { schema: { params: platParams } }, async (req) => {
    const a = member(req);
    return t.estadoBot(a.userId, (req.params as { plat: 'telegram' | 'discord' }).plat);
  });
  app.post('/api/canais-oficiais/:plat/start', { schema: { params: platParams } }, async (req) => {
    const a = member(req);
    return t.iniciarBot(a.userId, a.workspaceId, (req.params as { plat: 'telegram' | 'discord' }).plat, a.displayName || a.username);
  });
  app.delete('/api/canais-oficiais/:plat/accounts/:id', { schema: { params: platVinculo } }, async (req) => {
    const a = member(req);
    const p = req.params as { plat: 'telegram' | 'discord'; id: string };
    await t.revogarBot(a.userId, p.plat, p.id);
    return {};
  });
  app.get('/api/teams-app', async (req) => {
    const a = owner(req);
    return { ...t.estado(a.userId), ...(isAdminSafe(admin, req) ? { relay: { fromEnv: t.enderecoDoAmbiente(), url: t.base() } } : {}) };
  });
  app.post('/api/teams-app/enabled', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' }, canal } } },
  }, async (req) => {
    const b = req.body as { enabled: boolean; canal?: Plataforma };
    const a = (b.canal ?? 'teams') === 'teams' ? owner(req) : member(req);
    return t.setEnabled(a.userId, a.workspaceId, b.enabled, b.canal ?? 'teams');
  });
  app.post('/api/teams-app/claim', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: S.str(20, 1), canal } } },
  }, async (req) => {
    // a conta do Discord pelo código (o caminho do bot no ar): qualquer membro liga a dele; Teams, só a pessoa dona
    const b = req.body as { code: string; canal?: Plataforma };
    const a = (b.canal ?? 'teams') === 'teams' ? owner(req) : member(req);
    const r = await t.claim(a.userId, a.workspaceId, b.code, b.canal ?? 'teams');
    // o código era de uma conta do Teams, pedido pela tela de um bot por quem não é dono: não vale
    if (r.canal === 'teams' && (b.canal ?? 'teams') !== 'teams') { owner(req); }
    return r;
  });
  app.post('/api/teams-app/confirm', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['claimId'], properties: {
      claimId, password: S.str(200, 1), code: S.str(10, 6), key: S.str(80, 6), response: { type: 'object' }, ciente: { type: 'boolean' } } } },
  }, async (req) => {
    const b = req.body as { claimId: string; password?: string; code?: string; key?: string; response?: Record<string, unknown>; ciente?: boolean };
    const a = t.platDoClaim(b.claimId) === 'teams' ? owner(req) : member(req);
    // conta do Teams que não foi conferida como a da pessoa: sem a escolha consciente, nem chega a pedir a senha
    t.exigirCiente(a.userId, b.claimId, b.ciente);
    await verify(req, a, { password: b.password, code: b.code, key: b.key, response: b.response });
    return t.confirm(a.userId, a.workspaceId, b.claimId, a.displayName || a.username, b.ciente);
  });
  app.post('/api/teams-app/cancel', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['claimId'], properties: { claimId } } },
  }, async (req) => { const a = owner(req); await t.cancel(a.userId, (req.body as { claimId: string }).claimId); return {}; });
  app.patch('/api/teams-app/bindings/:id', {
    schema: { params: vinculoParams, body: { type: 'object', additionalProperties: false, properties: { notices: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const notices = (req.body as { notices?: boolean }).notices;
    const id = (req.params as { id: string }).id;
    if (notices === undefined) return { binding: (t.estado(a.userId).bindings as Array<{ id: string }>).find((x) => x.id === id) ?? null };
    return t.setNotices(a.userId, a.workspaceId, id, notices);
  });
  app.delete('/api/teams-app/bindings/:id', { schema: { params: vinculoParams } }, async (req) => {
    const a = owner(req);
    await t.revoke(a.userId, (req.params as { id: string }).id);
    return {};
  });
  // ajuste da instalação: o endereço do serviço do Teams, quando o ambiente não define (pessoa administradora)
  app.put('/api/teams-app/relay-url', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] } } } },
  }, async (req) => {
    admin(req);
    const url = (req.body as { url: string | null }).url;
    t.definirEndereco(url && url.trim() ? url.trim() : null);
    return { url: t.base() };
  });
}

function isAdminSafe(admin: (req: FastifyRequest) => AuthContext, req: FastifyRequest): boolean {
  try { admin(req); return true; } catch { return false; }
}
