/**
 * Cliente do Ergon World no servidor local. Sem endereço do World (ERGON_WORLD_URL ou DEFAULT_WORLD_URL), nada disto
 * liga e a instalação segue 100% local. Com ele, a pessoa pode conectar uma conta do World (nova ou que já existe) e
 * escolher UM workspace local para ligar ao workspace dela no World: só esse tem o plano (créditos, Ergon AI, Jobs) e
 * sincroniza, cifrado no aparelho. Os outros workspaces, mundos e agentes continuam locais, como antes.
 *
 * O acesso local não depende do World: entrar, editar e as tarefas de fundo funcionam com ou sem conta, com ou sem
 * rede. Sem rede, só os serviços do World esperam (o Sync continua depois).
 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { HttpError } from '../lib/util.ts';
import { throttle } from '../security/factors.ts';
import { checkCredentials, defaultWorkspace } from '../services/auth.ts';
import type { WorldHost, WorldModule, WorldStatus } from '../world-hook.ts';
import { loadWorldConfig, type WorldConfig } from './config.ts';
import { forgetWorkspace, migrateWorldLocal, WorldClient, WorldLinks, type AccountInput, type DeviceChoice } from './link.ts';
import { LocalSync } from './sync-local.ts';
import { normalizeJobs, type RemoteJobsRaw, type RemotePool, type RemoteUnavailable } from './jobs-view.ts';
import { CARD_REF, CloudCards } from './cards.ts';
import { registerLoja } from './loja.ts';

/** O que o World responde nas contas, em frases curtas (a mensagem dele pode vir em outro idioma). */
const ACCOUNT_ERRORS: Record<string, [number, string]> = {
  invalid_credentials: [400, 'E-mail ou senha incorretos.'],
  email_in_use: [409, 'Já existe uma conta com este e-mail. Use Entrar.'],
  invalid_request: [400, 'Confira o e-mail e a senha (10 caracteres ou mais).'],
  too_many_attempts: [429, 'Muitas tentativas. Espere um pouco e tente de novo.'],
  account_locked: [423, 'Conta bloqueada por enquanto. Tente de novo mais tarde.'],
  email_unconfigured: [503, 'Envio de e-mail indisponível agora.'],
  invalid_code: [400, 'Código inválido ou vencido.'],
  session_limit: [409, 'Sua conta já está conectada em 2 aparelhos. Escolha um para encerrar a sessão.'],
  device_limit: [409, 'Sua conta já tem 4 aparelhos cadastrados. Escolha um para remover.'],
};
/** Erro do World nas rotas de conta, sem 401 (a tela local trataria como sessão local encerrada). */
function accountError(e: unknown): never {
  const code = (e as HttpError).code;
  const m = ACCOUNT_ERRORS[code];
  if (m) throw Object.assign(new HttpError(m[0], code, m[1]), { detail: (e as { detail?: unknown }).detail });
  if ((e as HttpError).status === 401) throw new HttpError(400, code ?? 'world_error', 'O Ergon World recusou o pedido.');
  throw e;
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const DEVICE = /^dev_[a-f0-9]{32}$/;
const SWS = /^sws_[a-f0-9]{32}$/;

export function createWorld(cfg: Config, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): WorldModule {
  const wcfg: WorldConfig = loadWorldConfig(env);
  const client = new WorldClient(wcfg, fetchImpl);
  let links: WorldLinks | null = null;
  return {
    status(): WorldStatus {
      return { available: true, configured: !!wcfg.url };
    },
    async register(h: WorldHost) {
      const { app, db } = h;
      if (wcfg.url) {
        migrateWorldLocal(db);
        links = new WorldLinks(db, wcfg, client);
      }
      const L = (): WorldLinks => { if (!links) throw new HttpError(503, 'world_unconfigured', 'O Ergon World não está configurado nesta instalação.'); return links; };
      const sessionOf = (userId: string): string => {
        const s = L().session(userId);
        if (!s) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World para usar este recurso.');
        return s;
      };
      /** os workspaces locais de que a pessoa é dona: só um deles pode ser ligado ao World */
      const ownWorkspaces = (userId: string) => db.all<{ id: string; name: string }>(
        "SELECT w.id, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner' ORDER BY w.created_at", userId);

      app.get('/api/world/status', async (req) => {
        const a = h.auth(req);
        const l = links?.get(a.userId) ?? null;
        const bound = l?.bound_workspace_id ?? null;
        return {
          available: true, configured: !!wcfg.url, service: wcfg.url ? new URL(wcfg.url).origin : null,
          me: { displayName: a.displayName },
          link: l ? {
            accountEmail: l.account_email, emailVerified: !!l.email_verified, deviceId: l.device_id, refreshedAt: l.authorized_until,
            workspaces: l.entitlement ? JSON.parse(l.entitlement) : [],
            boundWorkspaceId: bound, boundWorkspaceName: bound ? db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', bound)?.name ?? null : null,
            currentIsBound: !!bound && bound === a.workspaceId,
          } : null,
          localWorkspaces: ownWorkspaces(a.userId).map((w) => ({ ...w, current: w.id === a.workspaceId })),
          // login recusado pelo limite de aparelhos: quais estão conectados (para escolher qual encerrar)
          deviceLimit: links?.limit(a.userId) ?? null,
        };
      });
      if (!wcfg.url) return; // sem World: nada além do estado

      // ---------------------------------------------------------------- Loja (colaborativa e grátis): loja.ts
      if (h.packages) registerLoja({ app, db, client, routines: h.routines, packages: h.packages, auth: h.auth, owner: h.owner, sessionOf });

      // ---------------------------------------------------------------- conta do World
      /**
       * Conectar: conta nova (e-mail, nome, senha), conta que já existe (e-mail e senha) ou conta nova com as mesmas
       * credenciais do Ergon (o nome local, um e-mail e a senha local, conferida aqui antes de ir ao World).
       */
      app.post('/api/world/connect', async (req) => {
        const a = h.auth(req);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const mode = b.mode; const email = str(b.email, 254)?.trim() ?? '';
        const choice: DeviceChoice = { endSessionsOf: str(b.endSessionsOf, 40), replaceDeviceId: str(b.replaceDeviceId, 40) };
        let account: AccountInput;
        if (mode === 'local') {
          const pw = str(b.localPassword, 1024) ?? '';
          throttle.check(`world-local:${a.userId}`);
          try { await checkCredentials(db, a.username, pw, cfg.kdf); }
          catch { throttle.fail(`world-local:${a.userId}`); throw new HttpError(400, 'invalid_local_password', 'Senha do Ergon incorreta.'); }
          throttle.ok(`world-local:${a.userId}`);
          if (pw.length < 10) throw new HttpError(400, 'password_short', 'A senha do Ergon tem menos de 10 caracteres. Crie uma conta com outra senha.');
          account = { kind: 'signup', email, password: pw, displayName: a.displayName };
        } else if (mode === 'signup') account = { kind: 'signup', email, password: str(b.password, 1024) ?? '', displayName: str(b.displayName, 80) ?? '' };
        else if (mode === 'login') account = { kind: 'login', email, password: str(b.password, 1024) ?? '' };
        else throw new HttpError(400, 'invalid', 'Escolha criar uma conta ou entrar.');
        if (L().get(a.userId)) throw new HttpError(409, 'world_already_linked', 'Este perfil já está conectado ao Ergon World.');
        const l = await L().connect(a.userId, defaultWorkspace(db, a.userId), account, choice).catch(accountError);
        return { ok: true, accountEmail: l.account_email, emailVerified: !!l.email_verified };
      });
      /** Conta no limite de aparelhos: tenta de novo liberando o escolhido (sem digitar a senha outra vez). */
      app.post('/api/world/connect/device', async (req) => {
        const a = h.auth(req); const b = (req.body ?? {}) as Record<string, unknown>;
        const choice: DeviceChoice = { endSessionsOf: str(b.endSessionsOf, 40), replaceDeviceId: str(b.replaceDeviceId, 40) };
        if (!choice.endSessionsOf && !choice.replaceDeviceId) throw new HttpError(400, 'invalid', 'Escolha um aparelho.');
        const l = await L().retryDevice(a.userId, choice).catch(accountError);
        return { ok: true, accountEmail: l.account_email, emailVerified: !!l.email_verified };
      });
      app.post('/api/world/account/email/verify', async (req) => {
        const a = h.auth(req); const l = L().get(a.userId);
        const code = str((req.body as { code?: unknown } | undefined)?.code, 20)?.trim();
        if (!l?.account_email) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World primeiro.');
        if (!code) throw new HttpError(400, 'invalid_code', 'Informe o código.');
        await client.call('POST', '/v1/accounts/email/verify', { email: l.account_email, code }).catch(accountError);
        L().markEmailVerified(a.userId);
        return { emailVerified: true };
      });
      app.post('/api/world/account/email/resend', async (req) => {
        const l = L().get(h.auth(req).userId);
        if (!l?.account_email) throw new HttpError(428, 'world_link_required', 'Conecte ao Ergon World primeiro.');
        await client.call('POST', '/v1/accounts/email/resend', { email: l.account_email }).catch(accountError);
        return { ok: true };
      });
      app.post('/api/world/account/password/forgot', async (req) => {
        h.auth(req);
        const email = str((req.body as { email?: unknown } | undefined)?.email, 254)?.trim();
        if (!email) throw new HttpError(400, 'invalid_email', 'E-mail inválido.');
        await client.call('POST', '/v1/accounts/password/forgot', { email }).catch(accountError);
        return { ok: true };
      });
      app.post('/api/world/account/password/reset', async (req) => {
        h.auth(req); const b = (req.body ?? {}) as Record<string, unknown>;
        const email = str(b.email, 254)?.trim(); const code = str(b.code, 20)?.trim(); const password = str(b.password, 1024);
        if (!email || !code || !password) throw new HttpError(400, 'invalid', 'Informe o e-mail, o código e a senha nova.');
        if (password.length < 10) throw new HttpError(400, 'password_short', 'A senha precisa de 10 caracteres ou mais.');
        await client.call('POST', '/v1/accounts/password/reset', { email, code, password }).catch(accountError);
        return { ok: true };
      });
      app.post('/api/world/unlink', async (req) => { await L().unlink(h.auth(req).userId); return { ok: true }; });
      app.post('/api/world/refresh', async (req) => ({ refreshedAt: await L().renew(h.auth(req).userId) }));

      // ---------------------------------------------------------------- qual workspace local é o do World
      const sync = new LocalSync({ db, links: L(), client, routines: h.routines, bus: h.bus, limits: h.limits });
      /**
       * Liga UM workspace local (de que a pessoa é dona) ao World: a um workspace World novo ou a um que já existe na
       * conta (criado em outro computador; a sincronização dele entra depois, com a chave).
       */
      app.post('/api/world/bind', async (req) => {
        const a = h.auth(req); const b = (req.body ?? {}) as Record<string, unknown>;
        const ws = str(b.workspaceId, 64) ?? a.workspaceId; const sws = b.syncWorkspaceId;
        if (!ownWorkspaces(a.userId).some((w) => w.id === ws)) throw new HttpError(403, 'not_owner', 'Só um workspace seu pode ser ligado ao Ergon World.');
        const cur = L().bound(a.userId);
        if (cur && cur !== ws) throw new HttpError(409, 'already_bound', 'Outro workspace seu já está ligado ao Ergon World. Desligue-o antes.');
        if (sws !== undefined && sws !== null && (typeof sws !== 'string' || !SWS.test(sws))) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        sessionOf(a.userId);
        const known = sync.worldId(ws);
        if (typeof sws === 'string' && sws !== known) { forgetWorkspace(db, ws); sync.adopt(ws, sws); }
        else if (!known) await sync.ensureWorld(a.userId, ws);
        L().setBound(a.userId, ws);
        return { boundWorkspaceId: ws, syncWorkspaceId: sync.worldId(ws) };
      });
      /** Desliga o workspace do World neste computador: ele volta a ser só local (os dados ficam; o World guarda o dele). */
      app.delete('/api/world/bind', async (req) => {
        const a = h.auth(req); const ws = L().bound(a.userId);
        if (ws) { forgetWorkspace(db, ws); L().setBound(a.userId, null); }
        return { ok: true };
      });
      /** O workspace World do workspace atual, só se ele for o ligado ao World pela pessoa (os outros ficam locais). */
      const worldWs = (a: { userId: string; workspaceId: string }): string | null => (links?.bound(a.userId) === a.workspaceId ? sync.worldId(a.workspaceId) : null);
      const boundWs = (a: { userId: string; workspaceId: string }): string => {
        if (links?.bound(a.userId) !== a.workspaceId) throw new HttpError(409, 'world_not_bound', 'Este workspace não está ligado ao Ergon World.');
        return a.workspaceId;
      };

      // ---------------------------------------------------------------- proxies do World com a sessão da própria pessoa
      app.get('/api/world/catalog', async () => client.call('GET', '/v1/catalog'));
      app.get('/api/world/devices', async (req) => client.call('GET', '/v1/devices', undefined, sessionOf(h.auth(req).userId)));
      app.post('/api/world/devices/:id/end-sessions', async (req) => {
        const id = String((req.params as { id: string }).id);
        if (!DEVICE.test(id)) throw new HttpError(400, 'invalid', 'aparelho inválido');
        return client.call('POST', `/v1/devices/${id}/end-sessions`, {}, sessionOf(h.auth(req).userId));
      });
      // ---------------------------------------------------------------- plano do workspace World ligado
      const NONE = { workspaceId: null, role: 'owner', entitlement: { status: 'none', plan_sku: null, tier: null, people: 0, job_slots: 0, effective_until: null, grace_until: null }, seatsUsed: 0, subscription: null, items: [], invoices: [] };
      app.get('/api/world/billing', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        return w ? client.call('GET', `/v1/billing/state?workspace=${w}`, undefined, sessionOf(a.userId)) : NONE;
      });
      // Central de Trabalho, ala "Na nuvem": os Jobs do workspace no World, lidos aqui (a sessão não vai à tela), com
      // frescor próprio e no máximo uma leitura a cada 20 s por pessoa e workspace; falha não vira zero
      const jobsCache = new Map<string, { at: number; pool: RemotePool }>();
      app.get('/api/world/jobs', async (req): Promise<RemotePool | RemoteUnavailable> => {
        const a = h.auth(req); const key = `${a.userId}|${a.workspaceId}`; const hit = jobsCache.get(key);
        if (hit && Date.now() - hit.at < 20_000) return hit.pool;
        const last = hit ? { ...hit.pool, stale: true } : null;
        const w = worldWs(a);
        if (!w) return { available: false, reason: 'sem_workspace', message: 'Este workspace não está ligado ao Ergon World.', last: null };
        let session: string;
        try { session = sessionOf(a.userId); } catch { return { available: false, reason: 'sem_conta', message: 'Conecte ao Ergon World para ver os Jobs.', last }; }
        try {
          const pool = normalizeJobs(await client.call<RemoteJobsRaw>('GET', `/v1/jobs?workspace=${encodeURIComponent(w)}`, undefined, session));
          jobsCache.set(key, { at: Date.now(), pool });
          return pool;
        } catch (e) {
          const off = (e as { code?: string }).code === 'world_offline';
          return { available: false, reason: off ? 'offline' : 'erro', message: off ? 'Sem conexão com o Ergon World agora.' : 'O Ergon World não respondeu à leitura dos Jobs.', last };
        }
      });
      // ---------------------------------------------------------------- "Rodar na nuvem": cartões do workspace ligado
      // Cartão que nunca foi à nuvem não fala com o World. A leitura do World (estado do Job, resultado) é no máximo a
      // cada 20 s por workspace, e só enquanto houver cartão na nuvem.
      const minMs = Number.parseInt(env.ERGON_WORLD_CARDS_MIN_MS ?? '', 10);
      const cards = new CloudCards({ db, client, links: L(), routines: h.routines, bus: h.bus, worldId: (ws) => sync.worldId(ws), minMs: Number.isFinite(minMs) && minMs >= 0 ? minMs : 20_000, tasks: h.tasks ?? null });
      const cardRef = (v: unknown): string => {
        if (typeof v !== 'string' || !CARD_REF.test(v)) throw new HttpError(400, 'invalid', 'cartão inválido');
        return v;
      };
      // o coordenador também faz, conversando ("continua isso na nuvem"): a mesma rota, com o clique da pessoa (gestao.ts)
      const refBody = { body: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string', pattern: CARD_REF.source } } } };
      app.get('/api/world/cards', { config: { gestao: { id: 'nuvem.cartoes', area: 'rotinas', rotulo: 'Ver quais cartões podem rodar na nuvem do Ergon World e os que estão lá', aprova: false } } }, async (req) => {
        const a = h.auth(req); const ref = (req.query as { ref?: string }).ref;
        // só o workspace ligado ao World, com a conta conectada, oferece a nuvem; nos outros, nada muda
        if (!worldWs(a) || !links?.session(a.userId)) return { offer: false, stale: false, cards: [] };
        let stale = false;
        await cards.features();
        await cards.refresh(a.userId, a.workspaceId).catch(() => { stale = true; });
        return { offer: true, stale, cards: ref ? [cards.view(a.workspaceId, cardRef(ref))] : cards.list(a.workspaceId) };
      });
      app.post('/api/world/cards/send', { schema: refBody, config: { gestao: { id: 'nuvem.rodar', area: 'rotinas', rotulo: 'Rodar na nuvem do Ergon World um cartão na fila ou em espera (ref: rotina:<id> ou card:<id>)', aprova: true } } }, async (req) => {
        const a = h.owner(req); const ref = cardRef((req.body as { ref?: unknown } | undefined)?.ref);
        return cards.send(a.userId, boundWs(a), ref);
      });
      app.post('/api/world/cards/claim', { schema: refBody, config: { gestao: { id: 'nuvem.trazer', area: 'rotinas', rotulo: 'Trazer para este computador um cartão que terminou na nuvem', aprova: true } } }, async (req) => {
        const a = h.owner(req); const ref = cardRef((req.body as { ref?: unknown } | undefined)?.ref);
        return cards.claim(a.userId, boundWs(a), ref);
      });

      // "Enquanto você esteve fora": o que chegou da nuvem desde a última vez (números e, sob pedido, cada um)
      app.get('/api/world/cards/summary', async (req) => {
        const a = h.auth(req);
        if (!worldWs(a) || !links?.session(a.userId)) return { counts: { concluidos: 0, recuperados: 0, falharam: 0, ergonAi: 0 }, items: [] };
        await cards.refresh(a.userId, a.workspaceId).catch(() => undefined);
        const sm = cards.summary(a.userId, a.workspaceId);
        // o nome de cada card ou rotina, para o detalhe
        const nome = (ref: string) => ref.startsWith('card:')
          ? db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ? AND workspace_id = ?', ref.slice(5), a.workspaceId)?.title ?? null
          : db.get<{ name: string }>('SELECT name FROM routines WHERE id = ? AND workspace_id = ?', ref.slice(7), a.workspaceId)?.name ?? null;
        return { ...sm, items: sm.items.map((x) => ({ ...x, title: nome(x.ref) })) };
      });
      app.post('/api/world/cards/summary/seen', async (req) => { const a = h.auth(req); cards.seen(a.userId, a.workspaceId); return { ok: true }; });
      // protocolo de recuperação do workspace World (vem ligado): quem administra o workspace lá muda; os outros só veem
      const roleIn = (userId: string, w: string): string | null => {
        try { return (JSON.parse(links?.get(userId)?.entitlement ?? '[]') as Array<{ workspaceId?: string; role?: string }>).find((x) => x.workspaceId === w)?.role ?? null; } catch { return null; }
      };
      app.get('/api/world/job-policy', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        if (!w || !links?.session(a.userId)) return { available: false, recovery: true, canEdit: false };
        if (!(await cards.features()).has('job_policy')) return { available: false, recovery: true, canEdit: false };
        let role = roleIn(a.userId, w);
        // workspace ligado depois da última leitura do plano: o papel chega com a renovação
        if (!role) { await L().renew(a.userId).catch(() => undefined); role = roleIn(a.userId, w); }
        try {
          const p = await client.call<{ recovery?: unknown; recoveryRounds?: unknown }>('GET', `/v1/workspaces/${w}/job-policy`, undefined, sessionOf(a.userId));
          return { available: true, recovery: p.recovery !== false, rounds: Number(p.recoveryRounds) || 3, canEdit: role === 'owner' || role === 'admin' };
        } catch (e) {
          if ((e as HttpError).code === 'world_offline' || (e as HttpError).status === 429) return { available: true, stale: true, recovery: true, canEdit: false };
          throw e;
        }
      });
      app.put('/api/world/job-policy', { schema: { body: { type: 'object', additionalProperties: false, required: ['recovery'], properties: { recovery: { type: 'boolean' } } } } }, async (req) => {
        const a = h.auth(req); const w = needWorld(a);
        const recovery = (req.body as { recovery: boolean }).recovery;
        const r = await client.call<{ recovery?: unknown }>('PUT', `/v1/workspaces/${w}/job-policy`, { recovery }, sessionOf(a.userId)).catch((e: HttpError) => {
          if (e.status === 403) throw new HttpError(403, 'sync_forbidden', 'Só quem administra o workspace muda isso.');
          throw e;
        });
        return { recovery: r.recovery !== false };
      });

      // créditos (só do workspace), extrato, recarga automática (o dono), teto por pessoa (o gestor) e transferência
      app.get('/api/world/wallet', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        return w ? client.call('GET', `/v1/wallet?workspace=${w}`, undefined, sessionOf(a.userId)) : { available: '0.000000', reserved: '0.000000', lots: [] };
      });
      app.get('/api/world/wallet/statement', async (req) => {
        const a = h.auth(req); const w = worldWs(a); const cur = (req.query as { cursor?: string }).cursor;
        return w ? client.call('GET', `/v1/wallet/statement?workspace=${w}${cur ? `&cursor=${encodeURIComponent(cur)}` : ''}`, undefined, sessionOf(a.userId)) : { next: null, entries: [] };
      });
      const needWorld = (a: { userId: string; workspaceId: string }): string => {
        const w = worldWs(a);
        if (!w) throw new HttpError(409, 'world_not_bound', 'Este workspace não está ligado ao Ergon World.');
        return w;
      };
      app.put('/api/world/wallet/autotopup', async (req) => {
        const a = h.owner(req); const w = needWorld(a);
        return client.call('PUT', `/v1/wallet/autotopup?workspace=${w}`, req.body ?? {}, sessionOf(a.userId));
      });
      app.post('/api/world/wallet/transfer', async (req) => {
        const a = h.owner(req); const w = needWorld(a);
        const b = (req.body ?? {}) as { toWorkspaceId?: unknown; dracmas?: unknown; idempotencyKey?: unknown };
        if (typeof b.toWorkspaceId !== 'string' || typeof b.dracmas !== 'string' || typeof b.idempotencyKey !== 'string') throw new HttpError(400, 'invalid', 'destino, valor e chave da intenção obrigatórios');
        return client.call('POST', '/v1/wallet/transfers', { fromWorkspaceId: w, toWorkspaceId: b.toWorkspaceId, dracmas: b.dracmas, idempotencyKey: b.idempotencyKey }, sessionOf(a.userId));
      });
      app.get('/api/world/budgets', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        return w ? client.call('GET', `/v1/workspaces/${w}/budgets`, undefined, sessionOf(a.userId)) : { manager: false, period: null, members: [] };
      });
      app.put('/api/world/budgets/:account', async (req) => {
        const a = h.auth(req); const w = needWorld(a); const acc = String((req.params as { account: string }).account);
        if (!/^acc_[a-f0-9]{32}$/.test(acc)) throw new HttpError(400, 'invalid', 'pessoa inválida');
        const cap = (req.body as { capDracmas?: unknown } | undefined)?.capDracmas;
        if (cap !== null && typeof cap !== 'string') throw new HttpError(400, 'invalid', 'teto em Dracmas (texto) ou livre (null)');
        return client.call('PUT', `/v1/workspaces/${w}/budgets/${acc}`, { capDracmas: cap }, sessionOf(a.userId));
      });
      app.post('/api/world/billing/checkout', async (req) => {
        const b = (req.body ?? {}) as { sku?: unknown; seats?: unknown; jobPacks?: unknown; idempotencyKey?: unknown };
        if (typeof b.sku !== 'string' || !/^[a-z0-9_]{2,40}$/.test(b.sku) || typeof b.idempotencyKey !== 'string') throw new HttpError(400, 'invalid', 'sku e chave da intenção obrigatórios');
        // o carrinho: com um plano, vagas adicionais e pacotes de Jobs vão na mesma assinatura (o World confere)
        const qty = (v: unknown, nome: string): number | undefined => {
          if (v === undefined || v === null || v === 0) return undefined;
          if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1000) throw new HttpError(400, 'invalid', `${nome}: quantidade inválida`);
          return v as number;
        };
        const seats = qty(b.seats, 'pessoas adicionais'); const jobPacks = qty(b.jobPacks, 'pacotes de Jobs');
        const back = `${cfg.publicUrl}/?world=`;
        // plano ou recarga: são do workspace ligado ao World; quem compra é a pessoa dona
        const a = h.owner(req);
        const body = { sku: b.sku, ...(seats ? { seats } : {}), ...(jobPacks ? { jobPacks } : {}), idempotencyKey: b.idempotencyKey, successUrl: `${back}pago`, cancelUrl: `${back}cancelado`, workspaceId: needWorld(a) };
        return client.call('POST', '/v1/billing/checkout', body, sessionOf(a.userId));
      });

      // ---------------------------------------------------------------- pessoas no workspace World ligado
      // o World decide quem pode o quê (dono, admin, editor, leitor); aqui só passa adiante, com a sessão da pessoa
      const ROLE = (v: unknown): 'admin' | 'editor' | 'viewer' => {
        if (v !== 'admin' && v !== 'editor' && v !== 'viewer') throw new HttpError(400, 'invalid', 'papel inválido (admin, editor ou viewer)');
        return v;
      };
      const ACC = (v: unknown): string => { const s = String(v ?? ''); if (!/^acc_[a-f0-9]{32}$/.test(s)) throw new HttpError(400, 'invalid', 'pessoa inválida'); return s; };
      app.get('/api/world/members', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        if (!w) return { myRole: null, seats: 0, members: [], invites: [], awaitingKey: [] };
        const s = sessionOf(a.userId);
        const r = await client.call<{ myRole: string; members: Array<{ accountId: string }> }>('GET', `/v1/sync/workspaces/${w}/members`, undefined, s);
        // quem entrou e ainda espera a chave do workspace (só quem administra entrega, de um computador que a tem)
        let awaitingKey: string[] = [];
        if (['owner', 'admin'].includes(r.myRole) && sync.status(a.workspaceId).enabled) {
          const need = await client.call<{ devices: Array<{ accountId?: string }> }>('GET', `/v1/sync/workspaces/${w}/devices-needing-key`, undefined, s).catch(() => ({ devices: [] }));
          awaitingKey = [...new Set(need.devices.map((d) => d.accountId).filter((x): x is string => !!x && r.members.some((m) => m.accountId === x)))];
        }
        return { ...r, awaitingKey };
      });
      app.post('/api/world/members/invites', async (req) => {
        const a = h.auth(req); const w = needWorld(a);
        return client.call('POST', `/v1/sync/workspaces/${w}/invites`, { role: ROLE((req.body as { role?: unknown } | undefined)?.role) }, sessionOf(a.userId));
      });
      app.delete('/api/world/members/invites/:id', async (req) => {
        const a = h.auth(req); const w = needWorld(a); const id = String((req.params as { id: string }).id);
        if (!/^inv_[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'invalid', 'convite inválido');
        return client.call('DELETE', `/v1/sync/workspaces/${w}/invites/${id}`, undefined, sessionOf(a.userId));
      });
      app.put('/api/world/members/:account/role', async (req) => {
        const a = h.auth(req); const w = needWorld(a);
        return client.call('PUT', `/v1/sync/workspaces/${w}/members/${ACC((req.params as { account: string }).account)}/role`, { role: ROLE((req.body as { role?: unknown } | undefined)?.role) }, sessionOf(a.userId));
      });
      /**
       * Tirar alguém do workspace: o acesso dele cai na hora e o World exige girar a chave antes de novas mudanças. Com a
       * chave neste computador, o giro sai na hora (e a chave nova vai para quem ficou); sem ela, a resposta avisa e o
       * giro é feito no computador que sincroniza.
       */
      app.delete('/api/world/members/:account', async (req) => {
        const a = h.auth(req); const w = needWorld(a);
        await client.call('DELETE', `/v1/sync/workspaces/${w}/members/${ACC((req.params as { account: string }).account)}`, undefined, sessionOf(a.userId));
        if (!sync.status(a.workspaceId).enabled) return { ok: true, rotationRequired: true, reason: 'no_key' };
        db.run('UPDATE world_sync SET rotation_pending = 1 WHERE workspace_id = ?', a.workspaceId);
        try { return { ok: true, rotationRequired: false, ...(await sync.rotate(a.userId, a.workspaceId)) }; }
        catch (e) { return { ok: true, rotationRequired: true, reason: (e as HttpError).code ?? 'world_error' }; }
      });
      app.post('/api/world/members/transfer', async (req) => {
        const a = h.auth(req); const w = needWorld(a);
        await client.call('POST', `/v1/sync/workspaces/${w}/transfer`, { toAccountId: ACC((req.body as { toAccountId?: unknown } | undefined)?.toAccountId) }, sessionOf(a.userId));
        await L().renew(a.userId).catch(() => undefined);
        return { ok: true };
      });
      /** Aceitar um convite: o workspace World entra na lista da conta; depois, liga-se um workspace daqui a ele. */
      app.post('/api/world/invites/accept', async (req) => {
        const a = h.auth(req);
        const token = String((req.body as { token?: unknown } | undefined)?.token ?? '').trim();
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new HttpError(400, 'invalid', 'Código de convite inválido.');
        const r = await client.call<{ workspaceId: string; role: string }>('POST', '/v1/sync/invites/accept', { token }, sessionOf(a.userId));
        await L().renew(a.userId).catch(() => undefined);
        return r;
      });
      app.post('/api/world/billing/portal', async (req) => client.call('POST', '/v1/billing/portal', { returnUrl: `${cfg.publicUrl}/?world=portal` }, sessionOf(h.auth(req).userId)));
      const change = (path: string) => async (req: FastifyRequest) => {
        const a = h.owner(req); const w = needWorld(a);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const pick = Object.fromEntries(['plan', 'seats', 'jobPacks', 'prorationDate', 'idempotencyKey'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
        return client.call('POST', path, { ...pick, workspaceId: w }, sessionOf(a.userId));
      };
      app.post('/api/world/billing/change/preview', change('/v1/billing/change/preview'));
      app.post('/api/world/billing/change/confirm', change('/v1/billing/change/confirm'));
      app.post('/api/world/billing/cancel', change('/v1/billing/cancel'));

      // ---------------------------------------------------------------- Ergon AI em um clique
      // credencial do World (por aparelho+pessoa) → endpoint próprio "ergon-ai" na equipe de IA DA PRÓPRIA PESSOA; a
      // conta de IA que ela já tenha continua lá (o Ergon AI entra ao lado; "como padrão" só se ela escolher)
      const aiBase = (env.ERGON_WORLD_AI_URL || `${wcfg.url}/v1/ai`).replace(/\/+$/, '');
      app.post('/api/world/ai/connect', async (req) => {
        const a = h.auth(req);
        const makeDefault = (req.body as { makeDefault?: unknown } | undefined)?.makeDefault === true;
        const w = needWorld(a);
        const control = h.controlFor(a.workspaceId);
        if (!control?.ergonAi) throw new HttpError(503, 'motor_unavailable', 'A sua equipe de IA não está ligada agora; tente de novo em instantes.');
        const cred = await client.call<{ token: string; expiresAt: string }>('POST', '/v1/ai/credentials', { localPersonId: a.userId, workspaceId: w }, sessionOf(a.userId));
        const list = await client.call<{ data: Array<{ id: string }> }>('GET', '/v1/ai/models', undefined, cred.token);
        const models = list.data.map((m) => m.id);
        if (!models.length) throw new HttpError(503, 'ergon_ai_unavailable', 'Nenhum modelo do Ergon AI disponível agora.');
        await control.ergonAi({ baseUrl: aiBase, apiKey: cred.token, models, makeDefault });
        return { ok: true, models, default: makeDefault, expiresAt: cred.expiresAt };
      });
      app.delete('/api/world/ai', async (req) => {
        const a = h.auth(req);
        await h.controlFor(a.workspaceId)?.removeErgonAi?.().catch(() => undefined);
        await client.call('DELETE', '/v1/ai/credentials', undefined, sessionOf(a.userId)).catch(() => undefined);
        return { ok: true };
      });
      app.get('/api/world/ai/usage', async (req) => client.call('GET', '/v1/ai/usage', undefined, sessionOf(h.auth(req).userId)));

      // ---------------------------------------------------------------- World Sync: só o workspace ligado
      const phrase = (req: FastifyRequest) => { const v = (req.body as { recoveryPhrase?: unknown } | undefined)?.recoveryPhrase; return typeof v === 'string' && v.trim().length >= 20 ? v.trim() : undefined; };
      app.get('/api/world/sync', async (req) => {
        const a = h.auth(req);
        return links?.bound(a.userId) === a.workspaceId ? { bound: true, ...sync.status(a.workspaceId) } : { bound: false, enabled: false };
      });
      app.post('/api/world/sync/enable', async (req) => { const a = h.owner(req); return sync.enable(a.userId, boundWs(a), phrase(req)); });
      app.post('/api/world/sync/join', async (req) => {
        const a = h.owner(req); const ws = boundWs(a);
        const id = String((req.body as { syncWorkspaceId?: string })?.syncWorkspaceId ?? sync.worldId(ws) ?? '');
        if (!SWS.test(id)) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        return sync.join(a.userId, ws, id, phrase(req));
      });
      app.post('/api/world/sync/share', async (req) => { const a = h.owner(req); return sync.share(a.userId, boundWs(a)); });
      app.post('/api/world/sync/push', async (req) => { const a = h.owner(req); return sync.push(a.userId, boundWs(a)); });
      app.post('/api/world/sync/rotate', async (req) => { const a = h.owner(req); return sync.rotate(a.userId, boundWs(a), phrase(req)); });
      app.post('/api/world/sync/recovery', async (req) => {
        const a = h.owner(req); const p = phrase(req);
        if (!p) throw new HttpError(400, 'invalid', 'Digite a frase de recuperação.');
        return sync.setRecovery(a.userId, boundWs(a), p);
      });
      app.post('/api/world/sync/pull', async (req) => { const a = h.owner(req); return sync.pull(a.userId, boundWs(a), (req.body as { apply?: unknown } | undefined)?.apply === true); });
      app.get('/api/world/sync/conflicts', async (req) => { const a = h.owner(req); return links?.bound(a.userId) === a.workspaceId ? sync.conflicts(a.userId, a.workspaceId) : []; });
      app.post('/api/world/sync/conflicts/:id', async (req) => {
        const a = h.owner(req); const keep = (req.body as { keep?: unknown } | undefined)?.keep;
        if (keep !== 'mine' && keep !== 'theirs') throw new HttpError(400, 'invalid', 'escolha manter a sua versão ou ficar com a do outro aparelho');
        return sync.resolve(a.userId, boundWs(a), String((req.params as { id: string }).id), keep);
      });

      // renova sozinha o resumo do plano de quem está conectado (uma pessoa por vez, sem pressa); sem rede, só espera
      const timer = setInterval(() => {
        for (const r of db.all<{ user_id: string }>("SELECT user_id FROM world_links WHERE status = 'active'")) void L().renew(r.user_id).catch(() => undefined);
      }, wcfg.refreshSeconds * 1000);
      timer.unref();
      // cartões na nuvem: o estado do Job e o resultado chegam mesmo com a tela fechada (só enquanto houver algum)
      const cardsTimer = setInterval(() => {
        for (const w of cards.watched()) void cards.refresh(w.user_id, w.workspace_id).catch(() => undefined);
      }, 20_000);
      cardsTimer.unref();
      app.addHook('onClose', async () => { clearInterval(timer); clearInterval(cardsTimer); });
      // renomear o workspace ligado aqui renomeia o do World (o nome que aparece no lugar do código)
      app.addHook('onResponse', async (req, reply) => {
        if (req.method !== 'PATCH' || req.routeOptions.url !== '/api/workspaces/:id' || reply.statusCode !== 200) return;
        const ws = String((req.params as { id?: string }).id ?? '');
        const owner = db.get<{ user_id: string }>("SELECT user_id FROM world_links WHERE bound_workspace_id = ? AND status = 'active'", ws);
        const w = owner ? sync.worldId(ws) : null; const s = owner ? links?.session(owner.user_id) : null;
        const label = sync.labelOf(ws).label;
        if (w && s && label) void client.call('PUT', `/v1/sync/workspaces/${w}/label`, { label }, s).catch(() => undefined);
      });
    },
  };
}
