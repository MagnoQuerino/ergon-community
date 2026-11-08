/**
 * Rotas de Conexões: contas (Microsoft, Google), apps de tarefas por credencial, espelho de listas, WhatsApp por QR
 * e a confirmação de canal real. Saíram de app.ts sem mudar nada do comportamento.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { S, idParams, strList } from '../lib/schemas.ts';
import { HttpError, notFound, now } from '../lib/util.ts';
import type { AuthContext } from '../services/auth.ts';
import { audit, type Bus } from '../services/bus.ts';
import { INTEGRATIONS, TASK_KINDS, TOKEN_KINDS, integrationRow, setIntegration, settingsOf, type IntegrationKind, type Integrations } from '../services/integrations.ts';
import { importBoards } from '../services/mirror.ts';
import { SSO_KINDS, type SsoKind } from '../services/sso.ts';
import { filtersOf, risksAccepted, WA_RISKS_VERSION, type WhatsAppReader } from '../services/whatsapp.ts';

export interface IntegrationRoutesDeps {
  db: Db; bus: Bus; integrations: Integrations; whatsapp: WhatsAppReader;
  /** sessão válida (qualquer membro) */ auth: (req: FastifyRequest) => AuthContext;
  /** sessão do dono do workspace */ owner: (req: FastifyRequest) => AuthContext;
}

export function registerIntegrationRoutes(app: FastifyInstance, d: IntegrationRoutesDeps): void {
  const { db, bus, integrations, whatsapp, auth, owner } = d;
  const kindParam = { type: 'object', required: ['kind'], properties: { kind: { enum: INTEGRATIONS.filter((i) => i.auth !== 'soon').map((i) => i.kind) } } };
  app.get('/api/integrations', async (req) => { const a = auth(req); return integrations.list(a.workspaceId, a.role === 'owner' ? a.userId : null); });

  // credencial colada: { token } ou { credentials: { token, key, site, email } } conforme o app. Campo em branco conta como
  // não preenchido (connectToken pula o opcional e pede o obrigatório pelo nome), não como erro de formato
  app.post('/api/integrations/:kind/token', {
    schema: { params: { type: 'object', required: ['kind'], properties: { kind: { enum: TOKEN_KINDS } } },
      body: { type: 'object', additionalProperties: false, properties: { token: S.str(2000, 1), credentials: { type: 'object', maxProperties: 5, additionalProperties: S.str(2000) } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { token?: string; credentials?: Record<string, string> };
    const account = await integrations.connectToken(a.workspaceId, a.userId, (req.params as { kind: IntegrationKind }).kind, { ...(b.token ? { token: b.token } : {}), ...b.credentials });
    return { ok: true, account };
  });

  app.delete('/api/integrations/:kind', { schema: { params: kindParam } }, async (req) => {
    const a = owner(req);
    const kind = (req.params as { kind: IntegrationKind }).kind;
    if (kind === 'whatsapp') await whatsapp.logout(a.workspaceId, a.userId);
    else integrations.disconnect(a.workspaceId, a.userId, kind);
    return { ok: true };
  });

  // Login com a conta (SSO parametrizado: Microsoft, Google). A volta vem por redirecionamento do navegador.
  const ssoParam = { type: 'object', required: ['kind'], properties: { kind: { enum: SSO_KINDS } } };
  app.post('/api/integrations/:kind/start', { schema: { params: ssoParam } }, async (req) => {
    const a = owner(req);
    const kind = (req.params as { kind: SsoKind }).kind;
    const url = integrations.sso.start(kind, a.workspaceId, a.userId);
    // autorizar de novo com a conta já ligada: ela continua funcionando enquanto a pessoa decide
    if (integrationRow(db, a.workspaceId, kind).state !== 'connected') setIntegration(db, a.workspaceId, kind, { state: 'pending', last_error: null });
    return { url };
  });
  app.get('/api/integrations/:kind/callback', { schema: { params: ssoParam } }, async (req, reply) => {
    const kind = (req.params as { kind: SsoKind }).kind;
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
    const back = (status: string) => reply.redirect(`/#conexoes?${kind}=${encodeURIComponent(status)}`);
    /** Não concluiu: quem cancelou não fica preso em "conectando", e o motivo da Microsoft ou do Google fica registrado. */
    const naoConcluiu = (ws: string | null, motivo: string) => {
      if (!ws) return;
      const r = integrationRow(db, ws, kind);
      if (r.state === 'pending') setIntegration(db, ws, kind, { state: integrations.secrets.read(ws, kind) ? 'connected' : 'off', last_error: motivo.slice(0, 300) });
      audit(db, bus, { workspaceId: ws, actorType: 'connector', action: 'integration.connect.error', targetType: 'integration', targetId: kind, evidence: { error: q.error ?? null, description: (q.error_description ?? '').slice(0, 300) }, result: motivo.slice(0, 200) });
    };
    const quem = q.state ? integrations.sso.workspaceOf(String(q.state).slice(0, 200)) : null;
    // segunda etapa (Microsoft, conta de trabalho/escola) recusada ou com erro: a conexão da primeira continua valendo
    const stage = q.state ? integrations.sso.stageOf(String(q.state).slice(0, 200)) : null;
    if (q.error || !q.code || !q.state) {
      naoConcluiu(quem, q.error === 'access_denied' ? 'A autorização foi recusada na página da conta.' : `A conta não concluiu o login: ${q.error ?? 'sem resposta'}${q.error_description ? ` (${q.error_description.split('\n')[0]})` : ''}`);
      return back(stage === 'work' ? 'parcial' : q.error === 'access_denied' ? 'recusado' : 'erro');
    }
    try {
      const r = await integrations.sso.finish(kind, String(q.state).slice(0, 200), String(q.code).slice(0, 4000));
      integrations.markSso(kind, r.workspaceId, r.userId, r.account);
      return r.next ? reply.redirect(r.next) : back('conectado');
    } catch (e) {
      naoConcluiu(quem, `O login não terminou: ${e instanceof Error ? e.message : 'erro'}`);
      return back(stage === 'work' ? 'parcial' : 'erro');
    }
  });

  // Listas e quadros de um aplicativo conectado (para escolher no menu Tarefas)
  app.get('/api/integrations/:kind/lists', { schema: { params: kindParam } }, async (req) => {
    const a = auth(req);
    const kind = (req.params as { kind: IntegrationKind }).kind;
    try { return { lists: await integrations.provider(a.workspaceId, kind).listBoards() }; } catch (err) {
      if (err instanceof HttpError) throw err;
      setIntegration(db, a.workspaceId, kind, { last_error: err instanceof Error ? err.message : 'falha' });
      throw new HttpError(502, 'provider', err instanceof Error ? err.message : 'o serviço não respondeu');
    }
  });

  // Espelhar uma lista escolhida (cria ou atualiza o quadro; depois o espelho segue sozinho a cada 5 min)
  app.post('/api/boards/mirror', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['kind', 'listId'], properties: { kind: { enum: TASK_KINDS }, listId: S.str(200, 1) } } },
  }, async (req) => {
    const a = auth(req);
    const b = req.body as { kind: IntegrationKind; listId: string };
    const row = integrationRow(db, a.workspaceId, b.kind);
    const rep = await importBoards(db, bus, a.workspaceId, row.id, a.userId, integrations.provider(a.workspaceId, b.kind), [b.listId]);
    setIntegration(db, a.workspaceId, b.kind, { last_sync_at: now() });
    const r = rep.boards[0];
    if (r?.state === 'error') throw new HttpError(502, 'mirror', r.error ?? 'falha ao ler a lista');
    return { boardId: r?.boardId, report: r };
  });
  app.post('/api/boards/:id/sync', { schema: { params: idParams('brd') } }, async (req) => {
    const a = auth(req);
    const b = db.get<{ connection_id: string; external_id: string; kind: IntegrationKind }>(
      "SELECT b.connection_id, b.external_id, i.kind FROM boards b JOIN integrations i ON i.id = b.connection_id WHERE b.id = ? AND b.workspace_id = ? AND b.origin = 'mirror'",
      (req.params as { id: string }).id, a.workspaceId);
    if (!b) throw notFound('quadro ligado');
    const rep = await importBoards(db, bus, a.workspaceId, b.connection_id, a.userId, integrations.provider(a.workspaceId, b.kind), [b.external_id]);
    return rep.boards[0];
  });

  // WhatsApp por QR (com filtros; envio só quando pedido). Experimental: conectar pela primeira vez pede o aceite das
  // informações e dos riscos (cliente não oficial); o aceite fica gravado no workspace e na auditoria.
  app.post('/api/integrations/whatsapp/start', async (req) => {
    const a = owner(req);
    const row = integrationRow(db, a.workspaceId, 'whatsapp');
    if (!risksAccepted(settingsOf(row))) {
      if ((req.body as { aceitoRiscos?: unknown } | undefined)?.aceitoRiscos !== true) {
        throw new HttpError(409, 'risks_not_accepted', 'O WhatsApp é experimental: antes de conectar, leia as informações e os riscos e confirme.');
      }
      setIntegration(db, a.workspaceId, 'whatsapp', { settings: { ...settingsOf(row), riscos: { versao: WA_RISKS_VERSION, aceitoEm: now(), por: a.userId } } });
      audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'integration.whatsapp.risks_accepted', evidence: { versao: WA_RISKS_VERSION }, result: 'informações e riscos do WhatsApp experimental aceitos' });
    }
    await whatsapp.start(a.workspaceId, a.userId);
    return whatsapp.state(a.workspaceId);
  });
  // aceite novo com a conexão já ligada (o texto dos riscos mudou): só grava, sem reconectar
  app.post('/api/integrations/whatsapp/aceitar-riscos', async (req) => {
    const a = owner(req);
    const row = integrationRow(db, a.workspaceId, 'whatsapp');
    setIntegration(db, a.workspaceId, 'whatsapp', { settings: { ...settingsOf(row), riscos: { versao: WA_RISKS_VERSION, aceitoEm: now(), por: a.userId } } });
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'integration.whatsapp.risks_accepted', evidence: { versao: WA_RISKS_VERSION }, result: 'informações e riscos aceitos' });
    bus.publish(a.workspaceId, 'integrations.changed', { kind: 'whatsapp' });
    return { ok: true };
  });
  app.post('/api/integrations/whatsapp/stop', async (req) => {
    const a = owner(req);
    await whatsapp.stop(a.workspaceId);
    if (integrationRow(db, a.workspaceId, 'whatsapp').state === 'pending') setIntegration(db, a.workspaceId, 'whatsapp', { state: 'off' });
    return whatsapp.state(a.workspaceId);
  });
  app.get('/api/integrations/whatsapp', async (req) => {
    const a = auth(req);
    const row = integrationRow(db, a.workspaceId, 'whatsapp');
    return { ...whatsapp.state(a.workspaceId), experimental: true, riscosAceitos: risksAccepted(settingsOf(row)), filters: filtersOf(settingsOf(row)), chats: whatsapp.chats(a.workspaceId), labels: whatsapp.labelNames(a.workspaceId) };
  });
  app.put('/api/integrations/whatsapp/filters', {
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      direct: { type: 'boolean' }, groups: { type: 'boolean' }, cards: { type: 'boolean' }, labels: strList(50, 80), exceptions: strList(100, 120) } } },
  }, async (req) => {
    const a = owner(req);
    const row = integrationRow(db, a.workspaceId, 'whatsapp');
    const f = filtersOf({ ...settingsOf(row), ...(req.body as object) });
    setIntegration(db, a.workspaceId, 'whatsapp', { settings: { ...settingsOf(row), ...f } });
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'integration.whatsapp.filters', evidence: { ...f }, result: 'filtros atualizados' });
    bus.publish(a.workspaceId, 'integrations.changed', { kind: 'whatsapp' });
    return f;
  });

  // Confirmação humana de teste real no canal: única forma de chegar a "conectado".
  app.post('/api/connections/:id/validate', { schema: { params: idParams('con') } }, async (req) => {
    const a = owner(req);
    const id = (req.params as { id: string }).id;
    const c = db.get<{ kind: string; mode: string; last_real_event_at: string | null }>('SELECT kind, mode, last_real_event_at FROM connections WHERE id = ? AND workspace_id = ?', id, a.workspaceId);
    if (!c) throw notFound('conexão');
    if (c.mode !== 'real' || !['teams', 'whatsapp'].includes(c.kind)) throw new HttpError(409, 'not_validatable', 'somente conexões reais de canal');
    if (!c.last_real_event_at) throw new HttpError(409, 'no_events', 'nenhum evento recebido pela ponte ainda');
    db.run('UPDATE connections SET validated_at = ?, validated_by = ? WHERE id = ?', now(), a.userId, id);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'connection.validate', targetType: 'connection', targetId: id, evidence: { kind: c.kind, lastRealEventAt: c.last_real_event_at }, result: 'confirmado pelo proprietário' });
    return { ok: true };
  });
}
