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
 * No COMPUTADOR (ERGON_MODE=local) a sincronia é automática em todo workspace ligado ao World com ela ligada: a cada
 * minuto entrega a chave a quem ainda não tem, recebe e envia. Com a nuvem ativa no workspace, o Ergon também avisa o
 * World que está aberto (posse: com um computador aberto, a nuvem não executa) e entrega a chave ao aparelho-nuvem em
 * segundos quando ele está esperando (o World diz: keyWanted); ao fechar, envia o que falta e avisa que saiu.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { Vault } from '../security/keys.ts';
import { needsSetup } from '../services/auth.ts';
import { instanceSetting, setInstanceSetting } from '../services/security.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import type { LocalSync } from './sync-local.ts';
import type { CanaisNuvemHost } from '../world-hook.ts';

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
  /** o motor de IA do workspace já responde (antes disso não se pede credencial ao World: cada pedido cria uma) */
  motorPronto: (workspaceId: string) => Promise<boolean>;
  /** os canais: liga a ponte desta instalação com o relé (passo seguinte da partida), se houver */
  aoPronto?: (x: { userId: string; workspaceId: string; syncWorkspaceId: string }) => Promise<void> | void;
  /** os canais (Discord, Telegram, Teams): com o workspace pronto, este contêiner atende as contas ligadas no computador */
  canais?: CanaisNuvemHost;
  log: Log;
  ajustes?: { passoMs?: number; cicloMs?: number; canaisMs?: number };
}

/** A partida do contêiner e o ciclo de sincronia dele. `parar()` envia o que falta (SIGTERM do orquestrador = dormir). */
export function iniciarNuvem(d: NuvemDeps): { parar: () => Promise<void>; estado: () => { estado: EstadoNuvem; detalhe: string | null } } {
  const sws = d.env.ERGON_WORLD_WORKSPACE!; const bootToken = d.env.ERGON_CLOUD_BOOT_TOKEN ?? '';
  let estado: EstadoNuvem = 'preparando'; let detalhe: string | null = null; let parado = false; let timer: NodeJS.Timeout | null = null;
  let userId: string | null = null; let ws: string | null = null; let ia = false; let iaFalhas = 0; let iaProxima = 0; let canaisDesde: number | null = null; let contado = ''; let rodando: Promise<void> | null = null;

  const sessao = () => (userId ? d.links.session(userId) : null);
  const contar = async (e: EstadoNuvem, det: string | null = null) => {
    estado = e; detalhe = det;
    const chave = `${e}|${det ?? ''}`;
    if (chave === contado && e !== 'pronto') return;
    contado = chave;
    const s = sessao();
    // pronto: a cada ciclo conta também a instalação daqui no serviço dos canais (o computador a declara como reserva
    // dele) e se a equipe está atendendo alguém agora (o World não põe para dormir no meio de uma conversa)
    const canais = e === 'pronto' && d.canais ? { ...(d.canais.instalacao() ? { relayInstallationId: d.canais.instalacao() } : {}), active: d.canais.ocupado() } : {};
    try {
      if (s) await d.client.call('POST', '/v1/cloud/app-state', { state: e, detail: det, ...canais }, s);
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
      const r = await d.links.connectCloud(userId, base, bootToken, sws);
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
      // a chave chegou: o estado deixa de dizer "aguardando a chave" antes de receber os dados (a primeira vez demora)
      await contar('preparando', 'recebendo a equipe e as conversas do computador');
    }
    // 6. dados: recebe (equipe e conteúdo) e envia o conteúdo daqui
    let recebido: { preview?: { skipped?: string[] } | null };
    try { recebido = await d.sync.pull(userId, ws, true) as { preview?: { skipped?: string[] } | null }; }
    catch (e) {
      // a chave girou (alguém saiu do workspace): a nova chega do mesmo jeito que a primeira, por um computador da pessoa
      if ((e as { code?: string }).code === 'key_pending') { await contar('aguardando_chave', 'A chave da sincronia foi trocada: abra o Ergon no seu computador uma vez para ele entregar a nova à nuvem.'); return false; }
      throw e;
    }
    if (recebido.preview?.skipped?.length) d.log({ ficouDeFora: recebido.preview.skipped.slice(0, 10) }, 'nuvem: parte da equipe não coube aqui');
    // quem troca a chave é um computador de quem administra: até lá a nuvem segue atendendo (o que fez aqui vai depois)
    await d.sync.push(userId, ws, { contentOnly: true }).catch((e) => { if (!['version_conflict', 'key_version', 'rotation_required'].includes(String((e as { code?: string }).code))) throw e; });
    // 7. o Ergon AI como modelo da equipe (o motor pode estar acordando: tenta de novo no próximo passo)
    // Ligado numa partida anterior e com a credencial longe de vencer (ela fica no disco do motor): nada a refazer ao
    // acordar, e os canais atendem já (o pedido espera o motor terminar de subir). Perto de vencer: liga de novo.
    const iaAte = Date.parse(instanceSetting(d.db, 'nuvem_ergon_ai_ate') ?? '');
    if (!ia && Number.isFinite(iaAte) && iaAte - Date.now() > 5 * 86_400_000) ia = true;
    if (!ia) {
      if (!(await d.motorPronto(ws).catch(() => false))) { await contar('preparando', 'ligando a equipe de IA (a primeira vez leva alguns minutos)'); return false; }
      // cada tentativa cria uma credencial no World: depois de uma falha, espera (30 s, 1 min, 2 min… até 15 min)
      if (Date.now() < iaProxima) { await contar('preparando', 'ligando o modelo da equipe (nova tentativa em instantes)'); return false; }
      try {
        const r = await d.conectarErgonAi({ userId, workspaceId: ws }, true) as { expiresAt?: string } | undefined;
        iaFalhas = 0;
        ia = true; d.log({}, 'nuvem: Ergon AI ligado como modelo da equipe');
        if (r?.expiresAt && Number.isFinite(Date.parse(r.expiresAt))) setInstanceSetting(d.db, 'nuvem_ergon_ai_ate', r.expiresAt);
      }
      catch (e) {
        iaProxima = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(iaFalhas++, 5));
        await contar('preparando', `ligando o modelo da equipe: ${String((e as Error).message).slice(0, 160)}`); return false;
      }
      await d.aoPronto?.({ userId, workspaceId: ws, syncWorkspaceId: sws });
    }
    d.canais?.atender({ userId, workspaceId: ws, syncWorkspaceId: sws });
    // os canais: "pronto" só depois de esta instalação existir no serviço dos canais (o World a entrega ao computador,
    // que a declara como reserva). Serviço desligado ou fora do ar: segue sem ele depois de 90 s
    if (d.canais?.ligavel() && !d.canais.instalacao()) {
      canaisDesde ??= Date.now();
      if (Date.now() - canaisDesde < (d.ajustes?.canaisMs ?? 90_000)) { await contar('preparando', 'ligando os canais (Telegram, Discord, Teams)'); return false; }
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
    if (!parado) { timer = setTimeout(() => { rodando = ciclo(); }, ok ? d.ajustes?.cicloMs ?? 30_000 : d.ajustes?.passoMs ?? 5_000); timer.unref(); }
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
// No computador: sincronia automática de todo workspace ligado ao World; posse e entrega da chave onde há a nuvem

export interface AutoSyncDeps { db: Db; client: WorldClient; links: WorldLinks; sync: LocalSync; canais?: CanaisNuvemHost; log: Log;
  ajustes?: { cicloMs?: number; estadoMs?: number; /** de quanto em quanto tempo confere a nuvem que está em preparo ou esperando a chave */ entregaMs?: number; /** por quanto tempo seguido confere nesse ritmo */ entregaMaxMs?: number } }

/** O que a tela mostra da sincronia automática de um workspace (nada daqui é segredo). */
export interface EstadoAuto {
  /** a sincronia automática cuida deste workspace neste computador */
  auto: boolean;
  /** o último ciclo que terminou sem nada pendente, e a última tentativa */
  ultimaOk: string | null; ultimaTentativa: string | null;
  /** por que o último ciclo não terminou (código do erro), desde quando e quantas vezes seguidas */
  pendencia: { codigo: string; passo: Passo; desde: string; vezes: number } | null;
  /** equipe nova enviada por outro computador, esperando a pessoa ver (enquanto isso nada vem nem vai) */
  equipeRetida: boolean;
  /** a nuvem deste workspace: ativa, e se está parada esperando a chave que este computador entrega */
  nuvem: { ativa: boolean; esperandoChave: boolean; appState: string | null } | null;
}
type Passo = 'presenca' | 'chave' | 'giro' | 'receber' | 'enviar';
interface Alvo { user_id: string; workspace_id: string; sws: string }
interface Nuvem { at: number; on: boolean; rele: string | null; ticket: { exp: number; mac: string } | null; appState: string | null; runtime: string | null; keyWanted: boolean | null }
interface Marca { ultimaOk: number | null; ultimaTentativa: number | null; pendencia: { codigo: string; passo: Passo; desde: number; vezes: number; logAt: number } | null; equipeRetida: boolean; giroAt: number; semSyncAt: number }
export interface AutoSync { agora: () => Promise<void>; parar: () => Promise<void>; estado: (ws: string) => EstadoAuto; sincronizar: (userId: string, ws: string) => Promise<EstadoAuto>; observar: (sws: string, estado: unknown) => void }

const codigo = (e: unknown): string => String((e as { code?: unknown }).code ?? ((e as { status?: unknown }).status ? `http_${(e as { status?: unknown }).status}` : 'erro'));
/** passageiros: resolvem sozinhos no ciclo seguinte (não viram aviso na tela antes de se repetirem) */
export const PASSAGEIROS = ['version_conflict', 'world_offline', 'rate_limited', 'key_version'];
/** o World não atende agora (sem rede, ou pediu uma pausa): não adianta tentar os passos seguintes desta volta */
const SEM_WORLD = ['world_offline', 'rate_limited'];
/** a nuvem está de pé sem a chave? (World novo diz com todas as letras; no antigo, pelo estado que o contêiner conta) */
const querChave = (n: Pick<Nuvem, 'on' | 'keyWanted' | 'appState'>): boolean => n.on && (n.keyWanted ?? (n.appState ?? '').startsWith('aguardando_chave'));
/** em preparo: vale conferir de perto (segundos) até ficar pronta, parar ou dar erro */
const emPreparo = (n: Nuvem): boolean => n.on && (querChave(n) || (n.runtime === 'rodando' && !/^(pronto|erro)/.test(n.appState ?? '')));

/**
 * A cada minuto, para cada workspace ligado ao World: com a nuvem ATIVA, avisa que este computador está com ele aberto
 * (a nuvem para de executar) e a declara reserva dos canais; com a sincronia ligada, entrega a chave a quem ainda não
 * tem (a nuvem primeiro), recebe e envia. Cada passo é independente: a falha de um não tira a vez do seguinte, e todo
 * erro fica no registro do servidor (uma vez, e de novo a cada 10 min enquanto durar) e no estado que a tela mostra.
 * Esqueleto novo vindo de outro computador não é aplicado sozinho (fica para a pessoa ver, como sempre).
 * Entre um ciclo e outro, a nuvem em preparo é conferida de perto: esperando a chave, recebe em segundos.
 */
export function iniciarAutoSync(d: AutoSyncDeps): AutoSync {
  const ativa = new Map<string, Nuvem>();
  const marcas = new Map<string, Marca>();
  /** workspaces World com a nuvem em preparo (desde quando são conferidos de perto) */
  const preparo = new Map<string, number>();
  /** conferida de perto por tempo demais sem sair do lugar: até quando fica só no ritmo do ciclo */
  const folga = new Map<string, number>();
  const filas = new Map<string, Promise<unknown>>();
  let parado = false; let rodando: Promise<void> | null = null; let perto: Promise<void> | null = null;
  const cicloMs = d.ajustes?.cicloMs ?? 60_000;
  const entregaMs = d.ajustes?.entregaMs ?? Math.min(5_000, Math.max(20, Math.floor(cicloMs / 4)));
  const entregaMaxMs = d.ajustes?.entregaMaxMs ?? 15 * 60_000;
  // o id do workspace World vem da sincronia (world_sync) ou, sem ela, da ligação (world_workspace_ids): instalações
  // antigas ligaram a sincronia antes de a segunda tabela existir e só têm a primeira
  const alvos = () => d.db.all<Alvo>(`SELECT b.user_id, b.workspace_id, COALESCE(s.sync_workspace_id, i.sync_workspace_id) AS sws FROM world_bound b
    JOIN world_links l ON l.user_id = b.user_id AND l.status = 'active' JOIN workspaces w ON w.id = b.workspace_id
    LEFT JOIN world_sync s ON s.workspace_id = b.workspace_id LEFT JOIN world_workspace_ids i ON i.workspace_id = b.workspace_id
    WHERE COALESCE(s.sync_workspace_id, i.sync_workspace_id) IS NOT NULL ORDER BY b.created_at, b.workspace_id`);
  const marca = (ws: string): Marca => { let m = marcas.get(ws); if (!m) { m = { ultimaOk: null, ultimaTentativa: null, pendencia: null, equipeRetida: false, giroAt: 0, semSyncAt: 0 }; marcas.set(ws, m); } return m; };
  /** um de cada vez por workspace (o ciclo, a entrega rápida e o "sincronizar agora" não se atropelam) */
  const naVez = <T>(ws: string, fn: () => Promise<T>): Promise<T> => {
    const p = (filas.get(ws) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const fim = p.catch(() => undefined).finally(() => { if (filas.get(ws) === fim) filas.delete(ws); });
    filas.set(ws, fim);
    return p;
  };
  const falhou = (a: Alvo, passo: Passo, e: unknown): string => {
    const c = codigo(e); const m = marca(a.workspace_id); const t = Date.now();
    const igual = m.pendencia?.codigo === c && m.pendencia.passo === passo;
    const p = igual ? m.pendencia! : { codigo: c, passo, desde: t, vezes: 0, logAt: 0 };
    p.vezes++;
    // no registro: na primeira vez e de novo a cada 10 min enquanto durar (com quantas vezes já foi)
    if (t - p.logAt >= 10 * 60_000) { p.logAt = t; d.log({ ws: a.workspace_id, passo, erro: c, vezes: p.vezes, detalhe: String((e as Error)?.message ?? e).slice(0, 200) }, 'sincronia automática: um passo falhou (tenta de novo no próximo ciclo)'); }
    m.pendencia = p;
    return c;
  };
  const guardar = (sws: string, r: Record<string, unknown>, antes?: Nuvem): Nuvem => {
    const on = r.active === true;
    const n: Nuvem = { at: Date.now(), on, rele: on && typeof r.relayStandby === 'string' ? r.relayStandby : null,
      ticket: on && r.relayTicket && typeof (r.relayTicket as { mac?: unknown }).mac === 'string' ? r.relayTicket as Nuvem['ticket'] : null,
      appState: on && typeof r.appState === 'string' ? r.appState : null, runtime: on && typeof r.runtime === 'string' ? r.runtime : null,
      keyWanted: on && typeof r.keyWanted === 'boolean' ? r.keyWanted : null };
    ativa.set(sws, n);
    const pediuAgora = querChave(n) && !(antes && querChave(antes));
    if (pediuAgora) { folga.delete(sws); d.log({ sws, estado: (n.appState ?? '').slice(0, 80) }, 'nuvem: está esperando a chave da sincronia; este computador entrega agora'); }
    if (emPreparo(n)) { if (!preparo.has(sws) && (folga.get(sws) ?? 0) < Date.now()) preparo.set(sws, Date.now()); }
    else preparo.delete(sws);
    return n;
  };
  const lerNuvem = async (sws: string, s: string, fresco = false): Promise<Nuvem | null> => {
    const c = ativa.get(sws);
    // "tem" vale por 5 min; "não tem" só por 1 (quem acabou de contratar não espera). O comprovante da reserva vale 15
    if (!fresco && c && Date.now() - c.at < (c.on && c.rele ? d.ajustes?.estadoMs ?? 5 * 60_000 : Math.min(60_000, cicloMs))) return c;
    try { return guardar(sws, await d.client.call<Record<string, unknown>>('GET', `/v1/cloud?workspace=${sws}`, undefined, s), c); }
    catch { return c ?? null; }
  };
  /** Entrega a chave (a nuvem primeiro). Não depende da pausa: não mexe nos dados do workspace. */
  const entregar = async (a: Alvo, motivo: string): Promise<true | string> => {
    try {
      const r = await d.sync.share(a.user_id, a.workspace_id, { motivo });
      const n = ativa.get(a.sws);
      if (r.cloud === 'entregue' && n) { n.keyWanted = false; if ((n.appState ?? '').startsWith('aguardando_chave')) n.appState = 'preparando'; }
      if (r.failed) return falhou(a, 'chave', Object.assign(new Error(`${r.failed} de ${r.needed} aparelhos sem a chave`), { code: r.falhas[0]?.code ?? 'erro' }));
      return true;
    } catch (e) { return falhou(a, 'chave', e); }
  };
  const um = async (a: Alvo, open: boolean, opts: { forcar?: boolean } = {}): Promise<void> => {
    const s = d.links.session(a.user_id);
    if (!s) return; // a parte da pessoa está fechada (ela ainda não entrou desde que o Ergon abriu): nada a fazer sem a sessão
    const m = marca(a.workspace_id); m.ultimaTentativa = Date.now();
    let limpo = true;
    // o aplicativo pediu a pausa ao fechar (sync-atividade.ts): nenhum envio ou recebimento novo até a página abrir de
    // novo (ou a pausa vencer). O sinal de "computador aberto" e a entrega da chave seguem: o servidor continua ligado
    const pausada = () => open && !opts.forcar && d.sync.atividade.pausada();
    // 1. a nuvem: posse (este computador está aberto) e a reserva dos canais
    const n = await lerNuvem(a.sws, s);
    if (n?.on) {
      // os canais: com este computador fechado, a nuvem responde pelas contas ligadas (declarado ao serviço dos canais)
      if (n.rele) try { d.canais?.reserva(a.workspace_id, { installationId: n.rele, syncWorkspaceId: a.sws, ticket: n.ticket }); } catch { /* segue */ }
      try {
        const r = await d.client.call<{ keyWanted?: unknown }>('POST', '/v1/cloud/presence', { workspaceId: a.sws, open }, s);
        // o World diz na resposta se a nuvem está esperando a chave (aditivo); World antigo: lê o estado dela a cada ciclo
        if (typeof r.keyWanted === 'boolean') { if (r.keyWanted !== n.keyWanted) guardar(a.sws, { active: true, relayStandby: n.rele, relayTicket: n.ticket, appState: n.appState, runtime: n.runtime, keyWanted: r.keyWanted }, n); }
        else if (open) await lerNuvem(a.sws, s, true);
      } catch (e) { limpo = false; if (SEM_WORLD.includes(falhou(a, 'presenca', e))) return; }
    } else if (n && ativa.has(a.sws)) {
      // a nuvem acabou (ou nunca houve): se era ela a reserva dos canais deste workspace, deixa de ser
      try { d.canais?.reserva(a.workspace_id, null); } catch { /* segue */ }
    }
    if (!d.sync.status(a.workspace_id).enabled) {
      // sem a sincronia ligada aqui, este computador não tem a chave para entregar: dito no registro (uma vez por hora)
      const agora = ativa.get(a.sws);
      if (agora && querChave(agora) && Date.now() - m.semSyncAt > 3_600_000) { m.semSyncAt = Date.now(); d.log({ ws: a.workspace_id }, 'nuvem: espera a chave, mas a sincronia está desligada neste workspace aqui (ligue em Configurações › Ergon World)'); }
      return;
    }
    if (open) {
      // 2. a chave para quem ainda não tem (a nuvem primeiro)
      const chave = await entregar(a, 'ciclo');
      if (chave !== true) { limpo = false; if (SEM_WORLD.includes(chave)) return; } // sem o World agora: os passos seguintes falhariam igual
      if (pausada()) return;
      // 3. alguém saiu do workspace e a chave ainda não foi trocada: quem administra troca daqui, sem ninguém clicar
      if (d.sync.status(a.workspace_id).rotationPending && Date.now() - m.giroAt > 10 * 60_000) {
        m.giroAt = Date.now();
        try { const g = await d.sync.rotate(a.user_id, a.workspace_id); d.log({ ws: a.workspace_id, versao: g.keyVersion, entregues: g.shared }, 'sincronia: chave do workspace trocada (alguém tinha saído)'); }
        catch (e) { limpo = false; falhou(a, 'giro', e); }
      }
      // 4. recebe
      try {
        const p = await d.sync.pull(a.user_id, a.workspace_id, true, { holdOnBlueprint: true }) as { held?: boolean };
        m.equipeRetida = !!p.held;
        if (p.held) return; // equipe nova de outro computador: a pessoa recebe pela tela antes de enviar
      } catch (e) { falhou(a, 'receber', e); return; } // sem receber não envia (o World recusaria: outro aparelho mudou antes)
      if (pausada()) return;
    }
    // 5. envia
    try { await d.sync.push(a.user_id, a.workspace_id); }
    catch (e) {
      const c = falhou(a, 'enviar', e);
      // a chave girou agora (o World pediu o giro neste envio): troca já, sem esperar o próximo ciclo
      if (open && c === 'rotation_required') m.giroAt = 0;
      return;
    }
    if (limpo) { m.ultimaOk = Date.now(); m.pendencia = null; }
  };
  const uma = async (open: boolean) => {
    for (const a of alvos()) {
      if (parado && open) return;
      await naVez(a.workspace_id, () => um(a, open)).catch((e) => { d.log({ ws: a.workspace_id, erro: codigo(e), detalhe: String((e as Error)?.message ?? e).slice(0, 200) }, 'sincronia automática: o ciclo falhou'); });
    }
  };
  /** Entre os ciclos: a nuvem em preparo é lida de novo e, se espera a chave, recebe já. */
  const dePerto = async () => {
    if (!preparo.size) return;
    for (const a of alvos()) {
      const desde = preparo.get(a.sws);
      if (desde === undefined || parado) continue;
      if (Date.now() - desde > entregaMaxMs) { preparo.delete(a.sws); folga.set(a.sws, Date.now() + entregaMaxMs); continue; } // presa há muito tempo: volta ao ritmo do ciclo
      const s = d.links.session(a.user_id);
      if (!s) continue;
      const n = await lerNuvem(a.sws, s, true);
      if (n && querChave(n) && d.sync.status(a.workspace_id).enabled) await naVez(a.workspace_id, () => entregar(a, 'nuvem esperando a chave')).catch(() => undefined);
    }
  };
  const agora = () => (rodando ??= uma(true).finally(() => { rodando = null; }));
  const timer = setInterval(() => { if (!parado) void agora(); }, cicloMs);
  timer.unref();
  const rapido = setInterval(() => { if (!parado && preparo.size) perto ??= dePerto().catch(() => undefined).finally(() => { perto = null; }); }, entregaMs);
  rapido.unref();
  const primeiro = setTimeout(() => { if (!parado) void agora(); }, Math.min(5_000, d.ajustes?.cicloMs ?? 5_000)); primeiro.unref();
  const estado = (ws: string): EstadoAuto => {
    const m = marcas.get(ws); const sws = d.sync.worldId(ws); const n = sws ? ativa.get(sws) : undefined;
    const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
    return { auto: !parado, ultimaOk: iso(m?.ultimaOk), ultimaTentativa: iso(m?.ultimaTentativa),
      pendencia: m?.pendencia ? { codigo: m.pendencia.codigo, passo: m.pendencia.passo, desde: iso(m.pendencia.desde)!, vezes: m.pendencia.vezes } : null,
      equipeRetida: !!m?.equipeRetida, nuvem: n ? { ativa: n.on, esperandoChave: querChave(n), appState: n.appState } : null };
  };
  return {
    agora, estado,
    /** "Sincronizar agora" (a saída de emergência da tela): o ciclo deste workspace, já, mesmo com a pausa pedida. */
    async sincronizar(userId: string, ws: string) {
      const a = alvos().find((x) => x.workspace_id === ws && x.user_id === userId);
      if (a) await naVez(ws, () => um(a, true, { forcar: true }));
      return estado(ws);
    },
    /** A tela leu o estado da nuvem (GET /v1/cloud): se ela espera a chave, a entrega começa já, sem esperar o ciclo. */
    observar(sws: string, r: unknown) {
      if (parado || !r || typeof r !== 'object') return;
      const antes = ativa.get(sws); const n = guardar(sws, r as Record<string, unknown>, antes);
      if (!querChave(n)) return;
      const a = alvos().find((x) => x.sws === sws && d.sync.status(x.workspace_id).enabled && d.links.session(x.user_id));
      if (a) void naVez(a.workspace_id, () => entregar(a, 'nuvem esperando a chave')).catch(() => undefined);
    },
    async parar() { parado = true; clearInterval(timer); clearInterval(rapido); clearTimeout(primeiro); await rodando?.catch(() => undefined); await perto?.catch(() => undefined); await uma(false).catch(() => undefined); },
  };
}
