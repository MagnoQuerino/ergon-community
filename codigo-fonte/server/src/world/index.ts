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
import { checkCredentials, defaultWorkspace, needsSetup } from '../services/auth.ts';
import type { WorldHost, WorldModule, WorldStatus } from '../world-hook.ts';
import { precisaReconectarErgonAi, registrarModelosErgonAi } from '../services/ai.ts';
import { loadWorldConfig, type WorldConfig } from './config.ts';
import { checkAccountInput, EMAIL_UNVERIFIED, forgetWorkspace, migrateWorldLocal, WorldClient, WorldLinks, worldLocale, type AccountInput, type DeviceChoice } from './link.ts';
import { type AutoSync, iniciarAutoSync, iniciarNuvem, modoNuvem, prepararCofre } from './nuvem.ts';
import { LocalSync } from './sync-local.ts';
import { normalizeJobs, type RemoteJobsRaw, type RemotePool, type RemoteUnavailable } from './jobs-view.ts';
import { CARD_REF, CloudCards } from './cards.ts';
import { registerLoja } from './loja.ts';
import { registerEstado } from './estado.ts';

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
  email_unverified: [403, EMAIL_UNVERIFIED],
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
    /** nuvem do Ergon World: abre o cofre do contêiner com a chave que o World guarda, antes do banco (world/nuvem.ts) */
    async prepare(vault) { if (wcfg.url) await prepararCofre(cfg, vault, env, client); },
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
      /**
       * Workspace local apagado (ou ligação a um que não existe mais): sai das ligações deste computador e o World o
       * desativa (libera o link do plano, some das listas). Sem rede, fica para a próxima vez que a tela abrir.
       */
      const desativarNoWorld = async (userId: string, ws: string, conhecido?: string | null): Promise<void> => {
        const w = conhecido ?? sync.worldId(ws);
        const s = links?.session(userId) ?? null;
        if (w && s) {
          try { await client.call('POST', `/v1/sync/workspaces/${w}/deactivate`, {}, s); }
          catch (e) { if ((e as { code?: string }).code === 'world_offline') return; }
        } else if (w && !s) return;
        forgetWorkspace(db, ws); links?.setBound(userId, ws, false);
        // a lista dos workspaces do World (guardada no vínculo) é lida de novo: o apagado some de "baixar" na hora
        await links?.renew(userId).catch(() => null);
      };
      /**
       * Conectar ao World já liga a sincronia (é o mínimo de estar conectado): sem frase, em silêncio. Se este workspace
       * já sincroniza em outro computador e este ainda não recebeu a chave, fica para autorizar por lá (a tela explica).
       */
      const sincronizarAoConectar = async (userId: string, ws: string): Promise<boolean> => {
        if (sync.status(ws).enabled) return true;
        try { await sync.enable(userId, ws); return true; } catch { return false; }
      };

      const ownWorkspaces = (userId: string) => db.all<{ id: string; name: string }>(
        "SELECT w.id, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner' ORDER BY w.created_at", userId);

      app.get('/api/world/status', async (req) => {
        const a = h.auth(req);
        const l = links?.get(a.userId) ?? null;
        // o app é a fonte da verdade: ligação a um workspace que não existe mais aqui some (e o World o desativa)
        if (l && links) for (const ws of links.boundList(a.userId)) if (!db.get('SELECT 1 FROM workspaces WHERE id = ?', ws)) await desativarNoWorld(a.userId, ws);
        const lista = links?.boundList(a.userId) ?? [];
        const bound = lista.includes(a.workspaceId) ? a.workspaceId : lista[0] ?? null;
        return {
          available: true, configured: !!wcfg.url, service: wcfg.url ? new URL(wcfg.url).origin : null,
          me: { displayName: a.displayName },
          link: l ? {
            accountEmail: l.account_email, emailVerified: !!l.email_verified, deviceId: l.device_id, refreshedAt: l.authorized_until,
            workspaces: l.entitlement ? JSON.parse(l.entitlement) : [],
            boundWorkspaceId: bound, boundWorkspaceName: bound ? db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', bound)?.name ?? null : null,
            currentIsBound: lista.includes(a.workspaceId),
            boundWorkspaceIds: lista,
            // os workspaces do World que já estão neste computador (os outros podem ser baixados)
            localSyncWorkspaceIds: db.all<{ s: string }>('SELECT i.sync_workspace_id AS s FROM world_workspace_ids i JOIN workspaces w ON w.id = i.workspace_id').map((r) => r.s),
          } : null,
          localWorkspaces: ownWorkspaces(a.userId).map((w) => ({ ...w, current: w.id === a.workspaceId })),
          // login recusado pelo limite de aparelhos: quais estão conectados (para escolher qual encerrar)
          deviceLimit: links?.limit(a.userId) ?? null,
        };
      });
      if (!wcfg.url) return; // sem World: nada além do estado

      // ---------------------------------------------------------------- primeiro acesso com a conta do Ergon World
      /**
       * "Já tenho conta Ergon World", antes de existir qualquer conta neste computador: confere o e-mail e a senha no
       * World ANTES de criar a conta local (senha errada não deixa uma conta local pela metade). Só vale com o
       * aplicativo ainda vazio; o vínculo do aparelho vem depois, já com a sessão local (/api/world/connect).
       */
      h.publicRoutes.add('/api/world/setup/check');
      app.post('/api/world/setup/check', async (req) => {
        if (!needsSetup(db)) throw new HttpError(409, 'already_setup', 'Este computador já tem uma conta.');
        const b = (req.body ?? {}) as Record<string, unknown>;
        const email = str(b.email, 254)?.trim().toLowerCase() ?? ''; const password = str(b.password, 200) ?? '';
        checkAccountInput({ kind: 'login', email, password });
        throttle.check(`world-setup:${req.ip}`);
        try { const r = await client.call<{ emailVerified?: boolean }>('POST', '/v1/accounts/login', { email, password }); throttle.ok(`world-setup:${req.ip}`); return { ok: true, emailVerified: !!r.emailVerified }; }
        catch (e) { if ((e as HttpError).code === 'invalid_credentials') throttle.fail(`world-setup:${req.ip}`); return accountError(e); }
      });

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
        // os e-mails da conta saem no idioma da tela (ou no do navegador)
        const locale = worldLocale(str(b.locale, 35), str(req.headers['accept-language'], 200));
        if (mode === 'local') {
          const pw = str(b.localPassword, 1024) ?? '';
          throttle.check(`world-local:${a.userId}`);
          try { await checkCredentials(db, a.username, pw, cfg.kdf); }
          catch { throttle.fail(`world-local:${a.userId}`); throw new HttpError(400, 'invalid_local_password', 'Senha do Ergon incorreta.'); }
          throttle.ok(`world-local:${a.userId}`);
          if (pw.length < 10) throw new HttpError(400, 'password_short', 'A senha do Ergon tem menos de 10 caracteres. Crie uma conta com outra senha.');
          account = { kind: 'signup', email, password: pw, displayName: a.displayName, locale };
        } else if (mode === 'signup') account = { kind: 'signup', email, password: str(b.password, 1024) ?? '', displayName: str(b.displayName, 80) ?? '', locale };
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
      app.post('/api/world/refresh', async (req) => ({ refreshedAt: await renovar(h.auth(req).userId) }));

      // ---------------------------------------------------------------- qual workspace local é o do World
      // na nuvem do Ergon World a equipe é a do computador da pessoa: cresce o que precisar para recebê-la inteira
      const sync = new LocalSync({ db, links: L(), client, routines: h.routines, bus: h.bus, limits: modoNuvem(cfg, env) ? { ...h.limits, autoGrow: true } : h.limits,
        log: (o, msg) => app.log.info(o, msg) });
      /** a sincronia automática deste computador (world/nuvem.ts); nula no contêiner da nuvem e com ERGON_WORLD_AUTOSYNC=0 */
      let auto: AutoSync | null = null;
      /**
       * Liga UM workspace local (de que a pessoa é dona) ao World: a um workspace World novo ou a um que já existe na
       * conta (criado em outro computador; a sincronização dele entra depois, com a chave).
       */
      app.post('/api/world/bind', async (req) => {
        const a = h.auth(req); const b = (req.body ?? {}) as Record<string, unknown>;
        const ws = str(b.workspaceId, 64) ?? a.workspaceId; const sws = b.syncWorkspaceId;
        if (!ownWorkspaces(a.userId).some((w) => w.id === ws)) throw new HttpError(403, 'not_owner', 'Só um workspace seu pode ser conectado ao Ergon World.');
        if (sws !== undefined && sws !== null && (typeof sws !== 'string' || !SWS.test(sws))) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        sessionOf(a.userId);
        const known = sync.worldId(ws);
        if (typeof sws === 'string' && sws !== known) { forgetWorkspace(db, ws); sync.adopt(ws, sws); }
        else if (!known) await sync.ensureWorld(a.userId, ws);
        L().setBound(a.userId, ws);
        const plano = await ligarAoPlano(a.userId, ws).catch(() => null);
        const syncEnabled = await sincronizarAoConectar(a.userId, ws);
        return { boundWorkspaceId: ws, syncWorkspaceId: sync.worldId(ws), planHolder: plano, syncEnabled };
      });
      /**
       * Links por conta: o workspace recém-ligado entra no primeiro plano da conta com link livre (sem Stripe). Já tem
       * plano próprio ou está num plano: nada a fazer. Sem link livre: fica ligado, sem plano, até liberar um.
       */
      const ligarAoPlano = async (userId: string, ws: string): Promise<string | null> => {
        const w = sync.worldId(ws); const s = links?.session(userId);
        if (!w || !s) return null;
        const { plans } = await client.call<{ plans: Array<{ holderWorkspaceId: string; links: number; used: number; workspaces: Array<{ workspaceId: string }> }> }>('GET', '/v1/plans', undefined, s);
        const ja = plans.find((p) => p.workspaces.some((x) => x.workspaceId === w));
        if (ja) return ja.holderWorkspaceId;
        for (const p of plans) {
          if (p.used >= p.links) continue;
          try { await client.call('POST', `/v1/plans/${p.holderWorkspaceId}/links`, { workspaceId: w }, s); return p.holderWorkspaceId; }
          catch (e) { if (['own_plan', 'is_holder'].includes(String((e as { code?: string }).code))) return null; }
        }
        return null;
      };
      /** Baixa para este computador um workspace que está no World (notebook novo): cria o local e liga a ele. */
      app.post('/api/world/download', async (req) => {
        const a = h.auth(req); const sws = (req.body as { syncWorkspaceId?: unknown } | undefined)?.syncWorkspaceId;
        if (typeof sws !== 'string' || !SWS.test(sws)) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        if (!h.createWorkspace) throw new HttpError(503, 'unavailable', 'Indisponível nesta versão.');
        sessionOf(a.userId);
        const ja = db.get<{ workspace_id: string }>('SELECT workspace_id FROM world_workspace_ids WHERE sync_workspace_id = ?', sws);
        if (ja && db.get('SELECT 1 FROM workspaces WHERE id = ?', ja.workspace_id)) throw new HttpError(409, 'already_here', 'Este workspace já está neste computador.');
        const ref = (JSON.parse(L().get(a.userId)?.entitlement ?? '[]') as Array<{ workspaceId: string; label?: string | null }>).find((x) => x.workspaceId === sws);
        const ws = h.createWorkspace(a.userId, (ref?.label ?? '').trim().slice(0, 60) || 'Workspace do World');
        sync.adopt(ws, sws);
        L().setBound(a.userId, ws);
        await ligarAoPlano(a.userId, ws).catch(() => null);
        const syncEnabled = await sincronizarAoConectar(a.userId, ws);
        return { workspaceId: ws, syncWorkspaceId: sws, syncEnabled };
      });
      /**
       * Apagar do Ergon World um workspace que está lá e não neste computador (por exemplo, apagado num computador
       * antigo antes de o World saber): o World o desativa (some das listas, libera o link; o cifrado fica 30 dias).
       */
      app.post('/api/world/remote/remove', async (req) => {
        const a = h.auth(req); const sws = (req.body as { syncWorkspaceId?: unknown } | undefined)?.syncWorkspaceId;
        if (typeof sws !== 'string' || !SWS.test(sws)) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        const ja = db.get<{ workspace_id: string }>('SELECT workspace_id FROM world_workspace_ids WHERE sync_workspace_id = ?', sws);
        if (ja && db.get('SELECT 1 FROM workspaces WHERE id = ?', ja.workspace_id)) throw new HttpError(409, 'already_here', 'Este workspace está neste computador: apague-o aqui, em Workspaces.');
        await client.call('POST', `/v1/sync/workspaces/${sws}/deactivate`, {}, sessionOf(a.userId));
        await L().renew(a.userId).catch(() => null);
        return { ok: true };
      });
      /** Os planos da conta com os links usados (para a tela "Links do Ergon World: 2 de 3"). */
      app.get('/api/world/plans', async (req) => client.call('GET', '/v1/plans', undefined, sessionOf(h.auth(req).userId)));
      /** Desliga o workspace do World neste computador: ele volta a ser só local (os dados ficam; o World guarda o dele). */
      app.delete('/api/world/bind', async (req) => {
        const a = h.auth(req); const lista = L().boundList(a.userId);
        const pedido = str((req.query as { workspaceId?: unknown }).workspaceId, 64);
        const ws = pedido ?? (lista.includes(a.workspaceId) ? a.workspaceId : lista.length === 1 ? lista[0] : null);
        if (!ws || !lista.includes(ws)) return { ok: true };
        // o link do plano fica livre para outro workspace (nada muda na assinatura)
        const w = sync.worldId(ws); const s = links?.session(a.userId);
        if (w && s) {
          const { plans } = await client.call<{ plans: Array<{ holderWorkspaceId: string; workspaces: Array<{ workspaceId: string }> }> }>('GET', '/v1/plans', undefined, s).catch(() => ({ plans: [] }));
          const p = plans.find((x) => x.workspaces.some((y) => y.workspaceId === w));
          if (p) await client.call('DELETE', `/v1/plans/${p.holderWorkspaceId}/links/${w}`, undefined, s).catch(() => undefined);
        }
        forgetWorkspace(db, ws); L().setBound(a.userId, ws, false);
        return { ok: true };
      });
      // workspace apagado no app: o World o desativa (o id do World é lido antes de o workspace sumir)
      app.addHook('preHandler', async (req) => {
        if (req.method !== 'DELETE' || req.routeOptions.url !== '/api/workspaces/:id') return;
        const ws = String((req.params as { id?: string }).id ?? '');
        const dono = links?.ownerOfBound(ws);
        if (dono) (req as { apagando?: unknown }).apagando = { ws, dono, w: sync.worldId(ws) };
      });
      app.addHook('onResponse', async (req, reply) => {
        const x = (req as { apagando?: { ws: string; dono: string; w: string | null } }).apagando;
        if (x && reply.statusCode === 200) void desativarNoWorld(x.dono, x.ws, x.w).catch(() => undefined);
      });
      /** O workspace World do workspace atual, só se ele for o ligado ao World pela pessoa (os outros ficam locais). */
      const worldWs = (a: { userId: string; workspaceId: string }): string | null => (links?.isBound(a.userId, a.workspaceId) ? sync.worldId(a.workspaceId) : null);
      const boundWs = (a: { userId: string; workspaceId: string }): string => {
        if (!links?.isBound(a.userId, a.workspaceId)) throw new HttpError(409, 'world_not_bound', 'Este workspace não está conectado ao Ergon World.');
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
      // "Subir o WS para o World": o workspace RODA na nuvem com os PCs desligados (não é a sincronia nem a colaboração).
      // World sem a rota (versão antiga) ou sem workspace ligado: nada oferecido, e a tela some.
      const SEM_NUVEM = { offered: false, active: false };
      app.get('/api/world/cloud', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        if (!w) return SEM_NUVEM;
        const r = await client.call('GET', `/v1/cloud?workspace=${w}`, undefined, sessionOf(a.userId)).catch(() => null);
        // a nuvem esperando a chave da sincronia: este computador entrega já (não espera o ciclo de um minuto)
        if (r) auto?.observar(w, r);
        return r ?? SEM_NUVEM;
      });
      app.post('/api/world/cloud/trial', async (req) => {
        const a = h.owner(req); const w = needWorld(a);
        return client.call('POST', '/v1/cloud/trial', { workspaceId: w }, sessionOf(a.userId));
      });
      // Central de Trabalho, ala "Na nuvem": os Jobs do workspace no World, lidos aqui (a sessão não vai à tela), com
      // frescor próprio e no máximo uma leitura a cada 20 s por pessoa e workspace; falha não vira zero
      const jobsCache = new Map<string, { at: number; pool: RemotePool }>();
      app.get('/api/world/jobs', async (req): Promise<RemotePool | RemoteUnavailable> => {
        const a = h.auth(req); const key = `${a.userId}|${a.workspaceId}`; const hit = jobsCache.get(key);
        if (hit && Date.now() - hit.at < 20_000) return hit.pool;
        const last = hit ? { ...hit.pool, stale: true } : null;
        const w = worldWs(a);
        if (!w) return { available: false, reason: 'sem_workspace', message: 'Este workspace não está conectado ao Ergon World.', last: null };
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
      // o Estado do Ergon, a etiqueta da barra e a Governança: consumo do mês, últimos resultados e registro (estado.ts)
      registerEstado({ app, db, client, auth: (r) => h.auth(r), worldWs, session: (userId) => links?.session(userId) ?? null });
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
        if (!w) throw new HttpError(409, 'world_not_bound', 'Este workspace não está conectado ao Ergon World.');
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
        const b = (req.body ?? {}) as { sku?: unknown; seats?: unknown; jobPacks?: unknown; cloud?: unknown; idempotencyKey?: unknown };
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
        const body = { sku: b.sku, ...(seats ? { seats } : {}), ...(jobPacks ? { jobPacks } : {}), ...(b.cloud === 1 ? { cloud: 1 } : {}), idempotencyKey: b.idempotencyKey, successUrl: `${back}pago`, cancelUrl: `${back}cancelado`, workspaceId: needWorld(a) };
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
        const r = await client.call<{ myRole: string; members: Array<{ accountId: string; role: string }> }>('GET', `/v1/sync/workspaces/${w}/members`, undefined, s);
        h.canais?.membros(a.workspaceId, r.members); // o papel de quem fala pelos canais externos
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
        h.canais?.saiu(a.workspaceId, ACC((req.params as { account: string }).account)); // os canais externos dele caem agora
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
      /**
       * Plano cortesia (entitlement.source = 'cortesia'): ativo, sem assinatura paga. Gerenciar a assinatura, o portal de
       * pagamento, cancelar e trocar o período (mensal/anual) não se aplicam; subir de plano pelo carrinho continua.
       */
      const fonteDoPlano = async (userId: string, w: string): Promise<{ source: string | null; plan: string | null }> => {
        const st = await client.call<{ entitlement?: { source?: string | null; plan_sku?: string | null } }>('GET', `/v1/billing/state?workspace=${w}`, undefined, sessionOf(userId));
        return { source: st.entitlement?.source ?? null, plan: st.entitlement?.plan_sku ?? null };
      };
      const CORTESIA = 'Plano cortesia: não há assinatura paga para gerenciar.';
      app.post('/api/world/billing/portal', async (req) => {
        const a = h.auth(req); const w = worldWs(a);
        if (w && (await fonteDoPlano(a.userId, w)).source === 'cortesia') throw new HttpError(409, 'cortesia', CORTESIA);
        return client.call('POST', '/v1/billing/portal', { returnUrl: `${cfg.publicUrl}/?world=portal` }, sessionOf(a.userId));
      });
      const anual = (sku: unknown) => typeof sku === 'string' && sku.endsWith('_annual');
      const change = (path: string) => async (req: FastifyRequest) => {
        const a = h.owner(req); const w = needWorld(a);
        const b = (req.body ?? {}) as Record<string, unknown>;
        const f = await fonteDoPlano(a.userId, w);
        if (f.source === 'cortesia' && (path.endsWith('/cancel') || (b.plan !== undefined && anual(b.plan) !== anual(f.plan)))) throw new HttpError(409, 'cortesia', CORTESIA);
        const pick = Object.fromEntries(['plan', 'seats', 'jobPacks', 'cloud', 'prorationDate', 'idempotencyKey'].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
        return client.call('POST', path, { ...pick, workspaceId: w }, sessionOf(a.userId));
      };
      app.post('/api/world/billing/change/preview', change('/v1/billing/change/preview'));
      app.post('/api/world/billing/change/confirm', change('/v1/billing/change/confirm'));
      app.post('/api/world/billing/cancel', change('/v1/billing/cancel'));

      // ---------------------------------------------------------------- Ergon AI em um clique
      // credencial do World (por aparelho+pessoa) → endpoint próprio "ergon-ai" na equipe de IA DA PRÓPRIA PESSOA; a
      // conta de IA que ela já tenha continua lá (o Ergon AI entra ao lado; "como padrão" só se ela escolher)
      const aiBase = (env.ERGON_WORLD_AI_URL || `${wcfg.url}/v1/ai`).replace(/\/+$/, '');
      // o World publica só modelos com a marca Ergon (id, nome e descrição): o nome e a descrição ficam para a tela
      const conectarErgonAi = async (a: { userId: string; workspaceId: string }, makeDefault: boolean) => {
        const w = needWorld(a);
        const control = h.controlFor(a.workspaceId);
        if (!control?.ergonAi) throw new HttpError(503, 'motor_unavailable', 'A sua equipe de IA não está ligada agora; tente de novo em instantes.');
        const cred = await client.call<{ token: string; expiresAt: string }>('POST', '/v1/ai/credentials', { localPersonId: a.userId, workspaceId: w }, sessionOf(a.userId));
        const list = await client.call<{ data: Array<{ id: string; name?: string; description?: string }> }>('GET', '/v1/ai/models', undefined, cred.token);
        const models = list.data.map((m) => m.id);
        if (!models.length) throw new HttpError(503, 'ergon_ai_unavailable', 'Nenhum modelo do Ergon AI disponível agora.');
        registrarModelosErgonAi(list.data);
        await control.ergonAi({ baseUrl: aiBase, apiKey: cred.token, models, makeDefault });
        return { ok: true, models, default: makeDefault, expiresAt: cred.expiresAt };
      };
      app.post('/api/world/ai/connect', async (req) => conectarErgonAi(h.auth(req), (req.body as { makeDefault?: unknown } | undefined)?.makeDefault === true));
      /**
       * Instalações de antes nunca conectam de novo: o endpoint guardado ainda lista os ids antigos (deepseek-*). Ao abrir o
       * aplicativo e ao renovar com o World, conecta de novo em silêncio (com o mesmo "como padrão") e passa as escolhas
       * gravadas para os apelidos da marca. `migrar`: migra mesmo sem precisar conectar (ao abrir).
       */
      const atualizarErgonAi = async (userId: string, migrar = false): Promise<void> => {
        const ws = links?.bound(userId);
        if (!ws || !h.ergonAi || !h.controlFor(ws)?.ergonAi) return;
        const modelos = await h.ergonAi.modelos(ws).catch(() => null);
        if (!modelos?.length) return; // o Ergon AI não está ligado aqui
        if (precisaReconectarErgonAi(modelos)) {
          await conectarErgonAi({ userId, workspaceId: ws }, await h.ergonAi.ehPadrao(ws));
          migrar = true;
        }
        if (migrar) await h.ergonAi.migrar(ws);
      };
      const renovar = async (userId: string): Promise<string | null> => {
        const r = await L().renew(userId);
        void atualizarErgonAi(userId).catch(() => undefined);
        for (const ligado of links?.boundList(userId) ?? []) h.canais?.atualizar(ligado); // os papéis dos membros, para os canais externos
        return r;
      };
      // ao abrir o aplicativo (sem pressa: o motor pode estar acordando)
      const aoAbrir = setTimeout(() => {
        for (const r of db.all<{ user_id: string }>("SELECT user_id FROM world_links WHERE status = 'active'")) void atualizarErgonAi(r.user_id, true).catch(() => undefined);
      }, 15_000);
      aoAbrir.unref();
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
        if (!links?.isBound(a.userId, a.workspaceId)) return { bound: false, enabled: false };
        const st = sync.status(a.workspaceId);
        // workspace adotado ainda sem sincronia: a tela precisa saber se a chave nasce aqui (workspace criado no servidor,
        // pessoa dona ou admin), se espera quem administra ou se espera a entrega por outro computador
        if (!st.enabled && st.origin === 'joined' && st.syncWorkspaceId) {
          const keyState = await sync.keyState(a.userId, st.syncWorkspaceId).catch(() => null);
          return { bound: true, ...st, keyState };
        }
        // o estado de verdade da sincronia automática (o que a tela e o selo do cartão mostram) e se há dados indo ou vindo
        return { bound: true, ...st, auto: auto?.estado(a.workspaceId) ?? null, atividade: sync.atividade.estado(a.workspaceId) };
      });
      /**
       * "Sincronizar agora": a saída de emergência da tela. Faz já o ciclo deste workspace (entrega a chave a quem falta,
       * recebe e envia), mesmo com a pausa pedida ao fechar. Equipe nova de outro computador continua retida para a
       * pessoa ver. Devolve o estado depois da tentativa (o que ficou pendente e por quê).
       */
      app.post('/api/world/sync/now', async (req) => {
        const a = h.owner(req); const ws = boundWs(a);
        if (!sync.status(ws).enabled) throw new HttpError(409, 'sync_off', 'World Sync desligado neste workspace');
        if (auto) return { ...sync.status(ws), auto: await auto.sincronizar(a.userId, ws), atividade: sync.atividade.estado(ws) };
        // sem a sincronia automática neste processo: os mesmos passos, na mesma ordem
        await sync.share(a.userId, ws, { motivo: 'agora' }).catch(() => undefined);
        const p = await sync.pull(a.userId, ws, true, { holdOnBlueprint: true }) as { held?: boolean };
        if (!p.held) await sync.push(a.userId, ws);
        return { ...sync.status(ws), auto: null, atividade: sync.atividade.estado(ws) };
      });
      app.post('/api/world/sync/enable', async (req) => { const a = h.owner(req); return sync.enable(a.userId, boundWs(a), phrase(req)); });
      app.post('/api/world/sync/join', async (req) => {
        const a = h.owner(req); const ws = boundWs(a);
        const id = String((req.body as { syncWorkspaceId?: string })?.syncWorkspaceId ?? sync.worldId(ws) ?? '');
        if (!SWS.test(id)) throw new HttpError(400, 'invalid', 'workspace do World inválido');
        // já sincroniza (conectar liga sozinho): o botão antigo só guarda a frase de recuperação, se veio
        if (sync.status(ws).enabled && sync.worldId(ws) === id) return sync.enable(a.userId, ws, phrase(req));
        return sync.join(a.userId, ws, id, phrase(req));
      });
      app.post('/api/world/sync/share', async (req) => { const a = h.owner(req); const r = await sync.share(a.userId, boundWs(a), { motivo: 'pedido da pessoa' }); return { shared: r.shared, failed: r.failed, cloud: r.cloud }; });
      app.post('/api/world/sync/push', async (req) => { const a = h.owner(req); return sync.push(a.userId, boundWs(a)); });
      app.post('/api/world/sync/rotate', async (req) => { const a = h.owner(req); return sync.rotate(a.userId, boundWs(a), phrase(req)); });
      app.post('/api/world/sync/recovery', async (req) => {
        const a = h.owner(req); const p = phrase(req);
        if (!p) throw new HttpError(400, 'invalid', 'Digite a frase de recuperação.');
        return sync.setRecovery(a.userId, boundWs(a), p);
      });
      app.post('/api/world/sync/pull', async (req) => { const a = h.owner(req); return sync.pull(a.userId, boundWs(a), (req.body as { apply?: unknown } | undefined)?.apply === true); });
      // a sincronia mexendo em dados agora (o sinal da barra de cima e o aviso ao fechar) e a pausa pedida ao fechar
      app.get('/api/world/sync/atividade', async (req) => { const a = h.auth(req); return { ...sync.atividade.estado(a.workspaceId), algum: sync.atividade.algumAtivo() }; });
      app.post('/api/world/sync/pausar', async (req) => { h.auth(req); return sync.atividade.pausar(); });
      app.post('/api/world/sync/retomar', async (req) => { h.auth(req); sync.atividade.retomar(); return { ok: true }; });
      app.get('/api/world/sync/conflicts', async (req) => { const a = h.owner(req); return links?.isBound(a.userId, a.workspaceId) ? sync.conflicts(a.userId, a.workspaceId) : []; });
      app.post('/api/world/sync/conflicts/:id', async (req) => {
        const a = h.owner(req); const keep = (req.body as { keep?: unknown } | undefined)?.keep;
        if (keep !== 'mine' && keep !== 'theirs') throw new HttpError(400, 'invalid', 'escolha manter a sua versão ou ficar com a do outro aparelho');
        return sync.resolve(a.userId, boundWs(a), String((req.params as { id: string }).id), keep);
      });

      // renova sozinha o resumo do plano de quem está conectado (uma pessoa por vez, sem pressa); sem rede, só espera
      const timer = setInterval(() => {
        for (const r of db.all<{ user_id: string }>("SELECT user_id FROM world_links WHERE status = 'active'")) void renovar(r.user_id).catch(() => undefined);
      }, wcfg.refreshSeconds * 1000);
      timer.unref();
      // cartões na nuvem: o estado do Job e o resultado chegam mesmo com a tela fechada (só enquanto houver algum)
      const cardsTimer = setInterval(() => {
        for (const w of cards.watched()) void cards.refresh(w.user_id, w.workspace_id).catch(() => undefined);
      }, 20_000);
      cardsTimer.unref();
      // nuvem do Ergon World: neste contêiner, a partida sem ninguém (world/nuvem.ts); no computador, a sincronia automática
      // e a posse do workspace que tem a nuvem ativa
      const log = (o: Record<string, unknown>, msg: string) => app.log.info(o, msg);
      let nuvem: { parar: () => Promise<void> } | null = null;
      // os tempos do ciclo (os testes encurtam)
      const ms = (k: string) => { const n = Number.parseInt(env[k] ?? '', 10); return Number.isFinite(n) && n >= 20 ? n : undefined; };
      if (h.canaisNuvem) sync.aoReceberMensagens = (w, ids) => h.canaisNuvem!.sincronizadas(w, ids);
      if (wcfg.url) {
        if (modoNuvem(cfg, env)) {
          app.addHook('onReady', async () => {
            nuvem = iniciarNuvem({ app, db, cfg, env, client, links: L(), sync, createWorkspace: (u, n) => { if (!h.createWorkspace) throw new HttpError(503, 'unavailable', 'Indisponível nesta versão.'); return h.createWorkspace(u, n); },
              conectarErgonAi, aoPronto: h.nuvemPronta, canais: h.canaisNuvem, log, ajustes: { passoMs: ms('ERGON_NUVEM_PASSO_MS'), cicloMs: ms('ERGON_NUVEM_CICLO_MS'), canaisMs: ms('ERGON_NUVEM_CANAIS_MS') },
              motorPronto: async (w) => { const c = h.controlFor(w); if (!c?.ergonAi || !c.byok) return false; await c.byok(); return true; } });
          });
        } else if (cfg.mode === 'local' && env.ERGON_WORLD_AUTOSYNC !== '0') {
          app.addHook('onReady', async () => { nuvem = auto = iniciarAutoSync({ db, client, links: L(), sync, canais: h.canaisNuvem, log, ajustes: { cicloMs: ms('ERGON_WORLD_AUTOSYNC_MS'), entregaMs: ms('ERGON_WORLD_ENTREGA_MS') } }); });
        }
      }
      app.addHook('onClose', async () => { clearInterval(timer); clearInterval(cardsTimer); clearTimeout(aoAbrir); await nuvem?.parar(); });
      // o World disse que o e-mail não está confirmado: o aviso com o código volta a aparecer (mesmo se aqui achávamos que sim)
      app.addHook('onError', async (req, _reply, err) => {
        if ((err as HttpError).code !== 'email_unverified') return;
        try { L().setEmailVerified(h.auth(req).userId, false); } catch { /* sem sessão local: nada a marcar */ }
      });
      // os canais externos (services/canais/externo.ts): a lista de membros do workspace ligado, pela sessão de quem o ligou
      h.canais?.ligar(async (ws) => {
        const dono = links?.ownerOfBound(ws) ?? null;
        const w = dono ? sync.worldId(ws) : null; const s = dono ? links?.session(dono) : null;
        if (!w || !s) return null;
        return (await client.call<{ members: Array<{ accountId: string; role: string }> }>('GET', `/v1/sync/workspaces/${w}/members`, undefined, s)).members;
      });
      // renomear o workspace ligado aqui renomeia o do World (o nome que aparece no lugar do código)
      app.addHook('onResponse', async (req, reply) => {
        if (req.method !== 'PATCH' || req.routeOptions.url !== '/api/workspaces/:id' || reply.statusCode !== 200) return;
        const ws = String((req.params as { id?: string }).id ?? '');
        const owner = links?.ownerOfBound(ws) ?? null;
        const w = owner ? sync.worldId(ws) : null; const s = owner ? links?.session(owner) : null;
        const label = sync.labelOf(ws).label;
        if (w && s && label) void client.call('PUT', `/v1/sync/workspaces/${w}/label`, { label }, s).catch(() => undefined);
      });
    },
  };
}
