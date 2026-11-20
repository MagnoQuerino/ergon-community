/**
 * Nuvem do Ergon World ("Subir o WS para o World"): este servidor rodando SOZINHO num contêiner do World, um por
 * workspace (ERGON_MODE=cloud + ERGON_WORLD_WORKSPACE), para a equipe seguir trabalhando com os computadores fechados.
 * Ninguém digita senha aqui: o que identifica o contêiner é o token de partida que o World entrega ao orquestrador a
 * cada vez que ele acorda (ERGON_CLOUD_BOOT_TOKEN).
 *
 * Partida (cada passo é retomável; o que falta fica visível no World e no app da pessoa):
 *   1. cofre: na primeira vez nasce aqui, com um segredo que o World guarda cifrado; nas seguintes, o World o devolve
 *      e o cofre abre antes do banco (prepararCofre).
 *   2. conta local "nuvem" (dona do contêiner; sem login de ninguém).
 *   3. aparelho: entra na conta do dono do workspace como o aparelho "nuvem" (links.connectCloud).
 *   4. workspace: cria o local e o liga ao workspace do World.
 *   5. chave da sincronia: um computador da pessoa a embrulha para este aparelho (acontece sozinho com o Ergon aberto
 *      lá: AutoSync.share); até lá, "aguardando a chave".
 *   6. dados: recebe a equipe e o conteúdo; daí em diante recebe e envia sozinho (só o conteúdo: quem define a equipe é
 *      o computador).
 *   7. Ergon AI como modelo da equipe (o uso segue em Dracmas).
 *
 * No COMPUTADOR (ERGON_MODE=local), com a nuvem ativa no workspace: a sincronia vira automática (entrega a chave ao
 * aparelho-nuvem, recebe e envia a cada minuto) e o Ergon avisa o World que está aberto (posse: com um computador
 * aberto, a nuvem não executa); ao fechar, envia o que falta e avisa que saiu.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { Vault } from '../security/keys.ts';
import { needsSetup } from '../services/auth.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import type { LocalSync } from './sync-local.ts';

export const USUARIO_NUVEM = 'nuvem';
const SWS = /^sws_[a-f0-9]{32}$/;
/** a senha da conta local "nuvem" e do cofre: derivada do segredo que o World guarda (ninguém a digita) */
export const senhaDoSegredo = (segredo: string) => `Nv-${segredo}`;
export const modoNuvem = (cfg: Config, env: NodeJS.ProcessEnv) => cfg.mode === 'cloud' && SWS.test(env.ERGON_WORLD_WORKSPACE ?? '');

export type EstadoNuvem = 'preparando' | 'aguardando_chave' | 'pronto' | 'erro';
type Log = (o: Record<string, unknown>, msg: string) => void;

/** Antes de abrir o banco: com o cofre já criado e trancado, o World devolve o segredo e ele abre. */
export async function prepararCofre(cfg: Config, vault: Vault, env: NodeJS.ProcessEnv, client: WorldClient): Promise<'aberto' | 'primeira_vez' | 'nao_e_nuvem'> {
  if (!modoNuvem(cfg, env)) return 'nao_e_nuvem';
  if (vault.state() !== 'sealed') return 'primeira_vez';
  const bootToken = env.ERGON_CLOUD_BOOT_TOKEN ?? '';
  let ultimo: unknown = null;
  for (let i = 0; i < 6; i++) { // o World pode estar reiniciando (deploy): algumas tentativas antes de desistir
    try {
      const r = await client.call<{ vaultKey: string | null }>('POST', '/v1/cloud/boot/vault', { bootToken });
      if (!r.vaultKey) throw new Error('o World não tem a chave deste cofre (disco de outro workspace?)');
      if (!(await vault.unsealPassword(USUARIO_NUVEM, senhaDoSegredo(r.vaultKey)))) throw new Error('a chave guardada no World não abre este cofre');
      return 'aberto';
    } catch (e) { ultimo = e; if ((e as { status?: number }).status && (e as { status?: number }).status !== 503) break; await new Promise((r) => setTimeout(r, 5000)); }
  }
  throw new Error(`nuvem: não consegui abrir o cofre: ${(ultimo as Error)?.message ?? ultimo}`);
}

export interface NuvemDeps {
  app: FastifyInstance; db: Db; cfg: Config; env: NodeJS.ProcessEnv; client: WorldClient; links: WorldLinks; sync: LocalSync;
  createWorkspace: (userId: string, name: string) => string;
  conectarErgonAi: (a: { userId: string; workspaceId: string }, makeDefault: boolean) => Promise<unknown>;
  /** os canais: liga a ponte desta instalação com o relé (passo seguinte da partida), se houver */
  aoPronto?: (x: { userId: string; workspaceId: string; syncWorkspaceId: string }) => Promise<void> | void;
  log: Log;
  ajustes?: { passoMs?: number; cicloMs?: number };
}

/** A partida do contêiner e o ciclo de sincronia dele. `parar()` envia o que falta (SIGTERM do orquestrador = dormir). */
export function iniciarNuvem(d: NuvemDeps): { parar: () => Promise<void>; estado: () => { estado: EstadoNuvem; detalhe: string | null } } {
  const sws = d.env.ERGON_WORLD_WORKSPACE!; const bootToken = d.env.ERGON_CLOUD_BOOT_TOKEN ?? '';
  let estado: EstadoNuvem = 'preparando'; let detalhe: string | null = null; let parado = false; let timer: NodeJS.Timeout | null = null;
  let userId: string | null = null; let ws: string | null = null; let ia = false; let contado = ''; let rodando: Promise<void> | null = null;

  const sessao = () => (userId ? d.links.session(userId) : null);
  const contar = async (e: EstadoNuvem, det: string | null = null) => {
    estado = e; detalhe = det;
    const chave = `${e}|${det ?? ''}`;
    if (chave === contado && e !== 'pronto') return;
    contado = chave;
    const s = sessao();
    try {
      if (s) await d.client.call('POST', '/v1/cloud/app-state', { state: e, detail: det }, s);
      else await d.client.call('POST', '/v1/cloud/boot/state', { bootToken, state: e, detail: det });
    } catch { contado = ''; /* o World fora do ar ou o token de partida vencido: conta de novo no próximo passo */ }
  };

  async function passo(): Promise<boolean> {
    // 2. a conta local (e o cofre, na primeira vez)
    if (needsSetup(d.db)) {
      const segredo = crypto.randomBytes(32).toString('hex');
      // o World guarda primeiro: nunca existe um cofre cuja chave o World não tem. Disco novo com chave antiga lá: troca
      // (o banco daqui está vazio; a chave antiga não abre mais nada)
      try { await d.client.call('POST', '/v1/cloud/boot/key', { bootToken, key: segredo }); }
      catch (e) { if ((e as { code?: string }).code !== 'key_exists') throw e; await d.client.call('POST', '/v1/cloud/boot/key', { bootToken, key: segredo, replace: true }); }
      const r = await d.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: USUARIO_NUVEM, password: senhaDoSegredo(segredo), displayName: 'Ergon World', ...(d.cfg.setupToken ? { setupToken: d.cfg.setupToken } : {}) } });
      if (r.statusCode !== 200) throw new Error(`conta local: ${r.statusCode} ${r.body.slice(0, 200)}`);
      d.log({}, 'nuvem: conta local e cofre criados');
    }
    userId ??= d.db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', USUARIO_NUVEM)?.id ?? null;
    if (!userId) throw new Error('este disco tem um Ergon que não é da nuvem (sem a conta "nuvem")');
    // 3. o aparelho-nuvem na conta do dono
    if (!d.links.get(userId) || !d.links.session(userId)) {
      const base = d.db.get<{ workspace_id: string }>("SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", userId)?.workspace_id;
      if (!base) throw new Error('conta local sem workspace');
      const r = await d.links.connectCloud(userId, base, bootToken);
      if (r.syncWorkspaceId !== sws) throw new Error('o token de partida é de outro workspace');
      d.log({ device: r.link.device_id }, 'nuvem: aparelho registrado na conta do dono');
    }
    // 4. o workspace local, ligado ao do World
    ws ??= d.db.get<{ workspace_id: string }>('SELECT i.workspace_id FROM world_workspace_ids i JOIN workspaces w ON w.id = i.workspace_id WHERE i.sync_workspace_id = ?', sws)?.workspace_id ?? null;
    if (!ws) {
      const rotulo = (JSON.parse(d.links.get(userId)?.entitlement ?? '[]') as Array<{ workspaceId: string; label?: string | null }>).find((x) => x.workspaceId === sws)?.label;
      ws = d.createWorkspace(userId, (rotulo ?? '').trim().slice(0, 60) || 'Workspace do World');
      d.sync.adopt(ws, sws);
    }
    if (!d.links.isBound(userId, ws)) d.links.setBound(userId, ws);
    // 5. a chave da sincronia (embrulhada por um computador da pessoa)
    if (!d.sync.status(ws).enabled) {
      try { await d.sync.join(userId, ws, sws); }
      catch (e) {
        if ((e as { status?: number }).status === 404) { await contar('aguardando_chave', 'Abra o Ergon no seu computador uma vez: ele entrega a chave da sincronia à nuvem.'); return false; }
        throw e;
      }
      d.log({}, 'nuvem: chave da sincronia recebida');
    }
    // 6. dados: recebe (equipe e conteúdo) e envia o conteúdo daqui
    await d.sync.pull(userId, ws, true);
    await d.sync.push(userId, ws, { contentOnly: true }).catch((e) => { if (!['version_conflict', 'key_version'].includes(String((e as { code?: string }).code))) throw e; });
    // 7. o Ergon AI como modelo da equipe (o motor pode estar acordando: tenta de novo no próximo passo)
    if (!ia) {
      try { await d.conectarErgonAi({ userId, workspaceId: ws }, true); ia = true; d.log({}, 'nuvem: Ergon AI ligado como modelo da equipe'); }
      catch (e) { await contar('preparando', `ligando o modelo da equipe: ${String((e as Error).message).slice(0, 160)}`); return false; }
      await d.aoPronto?.({ userId, workspaceId: ws, syncWorkspaceId: sws });
    }
    await contar('pronto');
    return true;
  }

  const ciclo = async () => {
    if (parado) return;
    let ok = false;
    try { ok = await passo(); }
    catch (e) {
      const m = String((e as Error).message ?? e).slice(0, 240);
      d.log({ err: m }, 'nuvem: passo falhou');
      await contar('erro', m);
    }
    if (!parado) { timer = setTimeout(() => { rodando = ciclo(); }, ok ? d.ajustes?.cicloMs ?? 30_000 : d.ajustes?.passoMs ?? 15_000); timer.unref(); }
  };
  rodando = ciclo();

  return {
    estado: () => ({ estado, detalhe }),
    async parar() {
      parado = true; if (timer) clearTimeout(timer);
      await rodando?.catch(() => undefined);
      // dormir: o que foi feito aqui vai para o World antes de sair (o computador recebe ao abrir)
      if (userId && ws && d.sync.status(ws).enabled) await d.sync.push(userId, ws, { contentOnly: true }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// No computador: sincronia automática e posse, só para o workspace com a nuvem ativa

export interface AutoSyncDeps { db: Db; client: WorldClient; links: WorldLinks; sync: LocalSync; log: Log; ajustes?: { cicloMs?: number; estadoMs?: number } }

/**
 * A cada minuto, para cada workspace ligado ao World com a nuvem ATIVA: avisa que este computador está com ele aberto
 * (a nuvem para de executar), entrega a chave da sincronia a quem ainda não tem (o aparelho-nuvem), recebe e envia.
 * Esqueleto novo vindo de outro computador não é aplicado sozinho (fica para a pessoa ver, como sempre).
 */
export function iniciarAutoSync(d: AutoSyncDeps): { agora: () => Promise<void>; parar: () => Promise<void> } {
  const ativa = new Map<string, { at: number; on: boolean }>();
  let parado = false; let rodando: Promise<void> | null = null;
  const alvos = () => d.db.all<{ user_id: string; workspace_id: string; sws: string }>(`SELECT b.user_id, b.workspace_id, i.sync_workspace_id AS sws FROM world_bound b
    JOIN world_links l ON l.user_id = b.user_id AND l.status = 'active' JOIN world_workspace_ids i ON i.workspace_id = b.workspace_id`);
  const temNuvem = async (sws: string, s: string): Promise<boolean> => {
    const c = ativa.get(sws);
    // "tem" vale por 5 min; "não tem" só por 1 (quem acabou de contratar não espera)
    if (c && Date.now() - c.at < (c.on ? d.ajustes?.estadoMs ?? 5 * 60_000 : 60_000)) return c.on;
    try { const r = await d.client.call<{ active?: boolean }>('GET', `/v1/cloud?workspace=${sws}`, undefined, s); ativa.set(sws, { at: Date.now(), on: r.active === true }); return r.active === true; }
    catch { return c?.on ?? false; }
  };
  const uma = async (open: boolean) => {
    for (const a of alvos()) {
      const s = d.links.session(a.user_id);
      if (!s || !(await temNuvem(a.sws, s))) continue;
      try {
        await d.client.call('POST', '/v1/cloud/presence', { workspaceId: a.sws, open }, s);
        if (!d.sync.status(a.workspace_id).enabled) continue;
        if (open) {
          await d.sync.share(a.user_id, a.workspace_id);
          const p = await d.sync.pull(a.user_id, a.workspace_id, true, { holdOnBlueprint: true }) as { held?: boolean };
          if (p.held) continue; // equipe nova de outro computador: a pessoa recebe pela tela antes de enviar
        }
        await d.sync.push(a.user_id, a.workspace_id);
      } catch (e) {
        const code = String((e as { code?: string }).code ?? '');
        if (!['version_conflict', 'world_offline', 'rate_limited', 'key_version', 'rotation_required', 'key_pending'].includes(code)) d.log({ err: String((e as Error).message).slice(0, 200), ws: a.workspace_id }, 'sincronia automática falhou');
      }
    }
  };
  const agora = () => (rodando ??= uma(true).finally(() => { rodando = null; }));
  const timer = setInterval(() => { if (!parado) void agora(); }, d.ajustes?.cicloMs ?? 60_000);
  timer.unref();
  const primeiro = setTimeout(() => { if (!parado) void agora(); }, 5_000); primeiro.unref();
  return {
    agora,
    async parar() { parado = true; clearInterval(timer); clearTimeout(primeiro); await rodando?.catch(() => undefined); await uma(false).catch(() => undefined); },
  };
}
