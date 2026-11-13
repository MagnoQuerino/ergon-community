/**
 * Rotas de Conexões: contas (Microsoft, Google), apps de tarefas por credencial, espelho de listas e WhatsApp por QR.
 * A Microsoft entra em etapas (sso.ts), e o "conectando…" vence em 10 minutos (Integrations.list).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { S, idParams, strList } from '../lib/schemas.ts';
import { HttpError, notFound, now } from '../lib/util.ts';
import type { AuthContext } from '../services/auth.ts';
import { audit, type Bus } from '../services/bus.ts';
import { INTEGRATIONS, PRECISA_ADMINISTRADOR, TASK_KINDS, consentimentoDe, exigeAdministrador, TOKEN_KINDS, integrationRow, limparEtapas, marcarBaseBloqueada, marcarConectando, marcarEtapa, motivoDoProvedor, setIntegration, settingsOf, voltaDoConectando, workspaceDoEstadoAdmin, type IntegrationKind, type Integrations } from '../services/integrations.ts';
import { paraTela } from '../lib/texto-tela.ts';
import { ProviderError, importBoards } from '../services/mirror.ts';
import { ETAPAS, SSO_KINDS, isEtapa, type Etapa, type SsoKind } from '../services/sso.ts';
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
  // Microsoft em etapas (sso.ts): { etapa } pede só uma delas ("Liberar leitura", "Já aprovaram? Conectar de novo")
  const ssoParam = { type: 'object', required: ['kind'], properties: { kind: { enum: SSO_KINDS } } };
  app.post('/api/integrations/:kind/start', { schema: { params: ssoParam } }, async (req) => {
    const a = owner(req);
    const kind = (req.params as { kind: SsoKind }).kind;
    const pedida = (req.body as { etapa?: unknown } | undefined)?.etapa;
    if (pedida !== undefined && (kind !== 'microsoft' || !isEtapa(pedida))) throw new HttpError(400, 'etapa', 'etapa inválida');
    const etapa: Etapa = isEtapa(pedida) ? pedida : 'base';
    const conectada = integrationRow(db, a.workspaceId, kind).state === 'connected';
    if (etapa !== 'base' && !conectada) throw new HttpError(409, 'not_connected', 'Conecte a conta Microsoft primeiro: clique em "Entrar com a Microsoft".');
    const url = integrations.sso.start(kind, a.workspaceId, a.userId, { etapa });
    // autorizar de novo com a conta já ligada: ela continua funcionando enquanto a pessoa decide
    if (!conectada) marcarConectando(db, a.workspaceId, kind);
    if (etapa !== 'base') marcarEtapa(db, a.workspaceId, etapa, { estado: 'pedido' });
    return { url };
  });
  app.get('/api/integrations/:kind/callback', { schema: { params: ssoParam } }, async (req, reply) => {
    const kind = (req.params as { kind: SsoKind }).kind;
    const q = req.query as { state?: string; code?: string; error?: string; error_description?: string; admin_consent?: string };
    const back = (status: string) => reply.redirect(`/#conexoes?${kind}=${encodeURIComponent(status)}`);
    // o que a tela mostra (marcas das etapas, last_error) é o motivo em português; o erro cru vai só para a evidência da auditoria
    const motivoDe = () => motivoDoProvedor(kind, q.error, q.error_description);
    // volta do pedido ao administrador (v2-admin-consent): só um atalho, para quando quem aprova é a própria pessoa, neste
    // computador. A conexão não depende dela: na tela, "Já aprovaram? Conectar de novo" faz o login da etapa
    if (kind === 'microsoft' && q.admin_consent !== undefined) {
      const [base, etapa] = String(q.state ?? '').slice(0, 120).split('.');
      const ws = workspaceDoEstadoAdmin(db, base ?? '');
      if (ws && (etapa === 'leitura' || etapa === 'canais')) {
        marcarEtapa(db, ws, etapa, q.error ? { estado: 'bloqueado', erro: 'O administrador não aprovou o pedido.' } : { estado: 'aprovado' });
        // o link de uma etapa pede também as anteriores (sso.ts, escoposDaEtapa): aprovado, o Teams (e a leitura, no link dos
        // canais) que esperavam o administrador também ficam aprovados, e a tela e o agente param de mandar pedir a ele
        if (!q.error) {
          const marcas = consentimentoDe(integrationRow(db, ws, 'microsoft')).etapas ?? {};
          for (const e of ETAPAS.slice(1, ETAPAS.indexOf(etapa))) if (marcas[e] && marcas[e]!.estado !== 'aprovado') marcarEtapa(db, ws, e, { estado: 'aprovado' });
        }
        audit(db, bus, { workspaceId: ws, actorType: 'connector', action: 'integration.admin_consent', targetType: 'integration', targetId: kind, evidence: { etapa, error: q.error ?? null, description: (q.error_description ?? '').slice(0, 300) }, result: q.error ? 'o administrador não aprovou' : 'o administrador aprovou' });
        bus.publish(ws, 'integrations.changed', { kind });
        // sem conta conectada (o pedido do primeiro acesso, no cartão desconectado): o botão que existe é "Já aprovaram? Entrar de novo"
        return back(q.error ? 'admin-recusou' : integrations.secrets.read(ws, kind) ? 'admin-aprovou' : 'admin-aprovou-base');
      }
      // o pedido não é de nenhum Ergon deste computador (por exemplo, quem aprovou também usa o Ergon): aviso neutro
      return back(q.error ? 'admin-recusou-outro' : 'admin-aprovou-outro');
    }
    /** Não concluiu: quem cancelou não fica preso em "conectando", e o motivo da Microsoft ou do Google fica registrado. */
    const naoConcluiu = (ws: string | null, motivo: string, etapa: Etapa | null, semErro = false) => {
      if (!ws) return;
      const r = integrationRow(db, ws, kind);
      // volta ao estado de antes: uma conexão caída que tentou reconectar e desistiu continua caída (não vira "conectada").
      // semErro: um passo esperado (o pedido ao administrador, que o cartão explica), nada em vermelho
      if (r.state === 'pending') {
        const volta = voltaDoConectando(r, !!integrations.secrets.read(ws, kind), motivo.slice(0, 300));
        setIntegration(db, ws, kind, semErro ? { ...volta, last_error: null } : volta);
      }
      // etapa depois da base que voltou sem ser dada: na leitura e nos canais, a tela mostra o pedido ao administrador (recusar ou não
      // poder autorizar dá no mesmo para a pessoa); no Teams, "Tentar de novo", a não ser que a empresa exija o administrador.
      // Cada etapa pede também as anteriores: a que exige o administrador leva junto as seguintes, que ficam com o pedido pronto
      // (sem mandar a pessoa a outra página que daria no mesmo). O que já foi dado continua valendo
      if (kind === 'microsoft' && etapa && etapa !== 'base') {
        const admin = exigeAdministrador(q.error, q.error_description);
        marcarEtapa(db, ws, etapa, { estado: 'bloqueado', erro: motivo.slice(0, 300), ...(admin ? { admin: true } : {}) });
        // herdada: as seguintes não foram pedidas; o encadeamento ainda as tenta depois da aprovação (etapaJaRecusada)
        if (admin) for (const e of ETAPAS.slice(ETAPAS.indexOf(etapa) + 1)) marcarEtapa(db, ws, e, { estado: 'bloqueado', erro: null, admin: true, herdada: true });
      }
      audit(db, bus, { workspaceId: ws, actorType: 'connector', action: 'integration.connect.error', targetType: 'integration', targetId: kind, evidence: { etapa, error: q.error ?? null, description: (q.error_description ?? '').slice(0, 300) }, result: motivo.slice(0, 200) });
      bus.publish(ws, 'integrations.changed', { kind });
    };
    const quem = q.state ? integrations.sso.workspaceOf(String(q.state).slice(0, 200)) : null;
    // etapa depois da primeira recusada ou com erro: a conexão das anteriores continua valendo
    const etapa = q.state ? integrations.sso.stageOf(String(q.state).slice(0, 200)) : null;
    // o Teams que a empresa só libera com o administrador: o aviso diz isso (e o cartão mostra o pedido), não "não terminou"
    const parcial = (e: Etapa | null) => (e === 'leitura' ? 'sem-leitura' : e === 'canais' ? 'sem-canais'
      : e === 'trabalho' ? (exigeAdministrador(q.error, q.error_description) ? 'precisa-admin' : 'parcial') : null);
    if (q.error || !q.code || !q.state) {
      // a empresa não deixa a pessoa autorizar sozinha nem o primeiro passo: o cartão desconectado já mostra o pedido ao administrador
      const precisaAdmin = kind === 'microsoft' && (!etapa || etapa === 'base') && (q.error === 'consent_required' || PRECISA_ADMINISTRADOR.test(q.error_description ?? ''));
      if (precisaAdmin && quem && !integrations.secrets.read(quem, kind)) {
        naoConcluiu(quem, 'A sua empresa exige que o administrador aprove o Ergon antes do primeiro acesso.', null, true);
        marcarBaseBloqueada(db, quem, motivoDe());
        return back('admin-base');
      }
      naoConcluiu(quem, motivoDe(), etapa);
      return back(parcial(etapa) ?? (q.error === 'access_denied' ? 'recusado' : 'erro'));
    }
    try {
      // a conta de antes deste workspace: se entrar outra, as marcas das etapas dela (aprovado, bloqueado…) não valem mais
      const contaAntes = quem && kind === 'microsoft' ? integrations.secrets.read<{ account?: string }>(quem, kind)?.account ?? null : null;
      const r = await integrations.sso.finish(kind, String(q.state).slice(0, 200), String(q.code).slice(0, 4000));
      if (kind === 'microsoft' && contaAntes && contaAntes !== r.account) limparEtapas(db, r.workspaceId);
      if (kind === 'microsoft') marcarBaseBloqueada(db, r.workspaceId, null);
      integrations.markSso(kind, r.workspaceId, r.userId, r.account);
      if (kind === 'microsoft' && r.etapa !== 'base') marcarEtapa(db, r.workspaceId, r.etapa, null);
      if (r.next && r.proxima) { marcarEtapa(db, r.workspaceId, r.proxima, { estado: 'pedido' }); return reply.redirect(r.next); }
      // tudo o que a pessoa pode dar já foi dado; os canais (opcionais) esperam o administrador, e a tela mostra o pedido pronto
      return back(r.semCanais ? 'sem-canais' : 'conectado');
    } catch (e) {
      // o erro da troca do código (rede, código do provedor) só passa se já for para a pessoa
      const m = paraTela(e instanceof Error ? e.message : null);
      naoConcluiu(quem, m ? `O login não terminou: ${m}` : 'O login não terminou. Tente de novo.', etapa);
      return back(parcial(etapa) ?? 'erro');
    }
  });

  // Listas e quadros de um aplicativo conectado (para escolher no menu Tarefas)
  app.get('/api/integrations/:kind/lists', { schema: { params: kindParam } }, async (req) => {
    const a = auth(req);
    const kind = (req.params as { kind: IntegrationKind }).kind;
    try { return { lists: await integrations.provider(a.workspaceId, kind).listBoards() }; } catch (err) {
      if (err instanceof HttpError) throw err;
      // o cartão mostra o last_error: o motivo do serviço só passa sem código cru (o técnico vai para o registro)
      // a reserva segue o tipo da falha: acesso recusado pede conectar de novo (não "tente de novo")
      const tipo = err instanceof ProviderError ? err.kind : null;
      const reserva = tipo === 'forbidden' ? 'o serviço recusou o acesso: conecte a conta de novo em Conexões'
        : tipo === 'not_found' ? 'o serviço não encontrou as listas (ou a conta não tem acesso a elas)'
        : 'o serviço não deixou ler as listas agora; tente de novo daqui a pouco';
      const motivo = paraTela(err instanceof Error ? err.message : null, reserva);
      if (err instanceof Error && motivo !== err.message) req.log.warn({ erro: err.message.slice(0, 300) }, 'listas do aplicativo: erro técnico');
      setIntegration(db, a.workspaceId, kind, { last_error: motivo });
      throw new HttpError(502, 'provider', motivo);
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
}
