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
 *   7. Ergon AI como modelo da equipe (o uso segue em Dracmas). Decisão de produto desta versão: a chave própria de IA da
 *      pessoa não sai do computador; na nuvem a equipe usa o Ergon AI (o agente com outro modelo usa o padrão lá).
 *
 * Rotinas: a equipe chega com as rotinas no estado do computador (ativas = ativas, services/blueprint.ts) e cada horário
 * é de quem está com o workspace (a posse): com um computador aberto, ele executa e a nuvem não; o horário que caiu antes
 * de o computador soltar a posse também foi dele (o World conta até quando: pcHeldUntil). O contêiner conta ao World o
 * próximo horário (nextWakeAt) a cada ciclo e antes de dormir; o computador conta também, inclusive ao fechar — com os
 * computadores fechados, o orquestrador acorda a nuvem no horário, ela roda uma vez e volta a dormir.
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
import { instanceSetting, setInstanceSetting } from '../services/security.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import type { LocalSync } from './sync-local.ts';
import { getSetting, setSetting } from '../services/sectors.ts';
import type { PosseHorario } from '../services/routines.ts';
import type { CanaisNuvemHost } from '../world-hook.ts';

export const USUARIO_NUVEM = 'nuvem';
const SWS = /^sws_[a-f0-9]{32}$/;
/** a senha da conta local "nuvem" e do cofre: derivada do segredo que o World guarda (ninguém a digita) */
export const senhaDoSegredo = (segredo: string) => `Nv-${segredo}`;
export const modoNuvem = (cfg: Config, env: NodeJS.ProcessEnv) => cfg.mode === 'cloud' && SWS.test(env.ERGON_WORLD_WORKSPACE ?? '');
/** O app sai com este código para o orquestrador recriá-lo com um token de partida novo (world/nuvem/orquestrador.ts). */
export const EXIT_TOKEN_NOVO = 75;
/** Sem notícia do World há mais que isto, a nuvem não sabe de quem é a posse: não executa horário (espera). */
const POSSE_VALE_MS = 150_000;
/**
 * Folga da posse: a nuvem só decide um horário com a palavra do World dada pelo menos isto DEPOIS dele (o aviso de
 * aberto de um computador que abriu no horário já chegou lá), e o horário pouco antes de um computador abrir fica com
 * ele. Na dúvida de poucos segundos, ninguém roda — nunca os dois.
 */
export const FOLGA_POSSE_MS = 5_000;

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
  /** o próximo horário de rotina do workspace (Routines.proximoHorario): o World acorda a nuvem nele */
  proximoHorario?: (workspaceId: string) => string | null;
  /** o token de partida venceu antes do registro: sair para o orquestrador recriar o contêiner com um novo */
  reiniciar?: () => void;
  ajustes?: { passoMs?: number; cicloMs?: number; canaisMs?: number };
}

/** A partida do contêiner e o ciclo de sincronia dele. `parar()` envia o que falta (SIGTERM do orquestrador = dormir). */
export function iniciarNuvem(d: NuvemDeps): { parar: () => Promise<void>; estado: () => { estado: EstadoNuvem; detalhe: string | null }; posse: (workspaceId: string, slot: string) => PosseHorario } {
  const sws = d.env.ERGON_WORLD_WORKSPACE!; const bootToken = d.env.ERGON_CLOUD_BOOT_TOKEN ?? '';
  let estado: EstadoNuvem = 'preparando'; let detalhe: string | null = null; let parado = false; let timer: NodeJS.Timeout | null = null;
  /** a posse como o World a contou na última resposta (POST /v1/cloud/app-state) */
  let posse: { em: number; pcAberto: boolean; pcAte: number | null; pcDesde: number | null; pcSaiu: number | null } | null = null; let posseVista = 0;
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
    // o próximo horário de rotina (o World acorda a nuvem nele; uma rodada em andamento conta como "agora")
    let proxima: { nextWakeAt?: string | null } = {};
    try { if (ws && d.proximoHorario) proxima = { nextWakeAt: d.proximoHorario(ws) }; } catch { /* sem o horário: o World fica com o último */ }
    try {
      if (s) {
        const pedida = Date.now();
        const r = await d.client.call<{ pcOpen?: unknown; pcHeldUntil?: unknown; pcSince?: unknown; pcLeftAt?: unknown } | undefined>('POST', '/v1/cloud/app-state', { state: e, detail: det, ...canais, ...proxima }, s);
        const t = (v: unknown) => { const x = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(x) ? x : null; };
        // "em": quando o pedido saiu (a palavra do World é de depois disso)
        if (typeof r?.pcOpen === 'boolean') posse = { em: pedida, pcAberto: r.pcOpen, pcAte: t(r.pcHeldUntil), pcDesde: t(r.pcSince), pcSaiu: t(r.pcLeftAt) };
      }
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
      catch (e) {
        if ((e as { code?: string }).code !== 'key_exists') throw e;
        try { await d.client.call('POST', '/v1/cloud/boot/key', { bootToken, key: segredo, replace: true }); }
        catch (e2) {
          // já preparado com outro disco: o World não troca a chave do cofre sozinho (um disco vazio aparecendo não apaga
          // o de verdade). Nada é criado aqui; o motivo fica visível e a nova tentativa espera (a equipe do World confere)
          if ((e2 as { code?: string }).code === 'key_locked') throw Object.assign(new Error('este workspace já foi preparado na nuvem com outro disco, que não está aqui: a equipe do Ergon World confere antes de trocar a chave do cofre (nada foi apagado)'), { esperaMs: 5 * 60_000 });
          throw e2;
        }
      }
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
    }
    // 6. dados: recebe (equipe e conteúdo) e envia o conteúdo daqui
    const recebido = await d.sync.pull(userId, ws, true) as { preview?: { skipped?: string[] } | null };
    if (recebido.preview?.skipped?.length) d.log({ ficouDeFora: recebido.preview.skipped.slice(0, 10) }, 'nuvem: parte da equipe não coube aqui');
    await d.sync.push(userId, ws, { contentOnly: true }).catch((e) => { if (!['version_conflict', 'key_version'].includes(String((e as { code?: string }).code))) throw e; });
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
    // Só na primeira partida: nas seguintes (o serviço já respondeu uma vez, ou a espera já foi feita), segue pronto e os
    // canais ligam quando o serviço responder (atender acima tenta a cada ciclo)
    if (d.canais?.instalacao()) setInstanceSetting(d.db, 'nuvem_canais_esperou', '1');
    if (d.canais?.ligavel() && !d.canais.instalacao() && instanceSetting(d.db, 'nuvem_canais_esperou') !== '1') {
      canaisDesde ??= Date.now();
      if (Date.now() - canaisDesde < (d.ajustes?.canaisMs ?? 90_000)) { await contar('preparando', 'ligando os canais (Telegram, Discord, Teams)'); return false; }
      setInstanceSetting(d.db, 'nuvem_canais_esperou', '1');
    }
    await contar('pronto');
    return true;
  }

  const ciclo = async () => {
    if (parado) return;
    let ok = false; let espera: number | undefined;
    try { ok = await passo(); }
    catch (e) {
      // o token de partida (20 min) venceu antes de o aparelho-nuvem se registrar (o World estava fora na primeira
      // partida): sem sessão, nada mais o aceita. Sai para o orquestrador recriar o contêiner com um token novo
      if ((e as { code?: string }).code === 'boot_token' && !sessao() && d.reiniciar) {
        d.log({}, 'nuvem: o token de partida venceu antes do registro; saindo para receber um novo');
        parado = true; d.reiniciar(); return;
      }
      const m = String((e as Error).message ?? e).slice(0, 240);
      espera = (e as { esperaMs?: number }).esperaMs;
      d.log({ err: m }, 'nuvem: passo falhou');
      await contar('erro', m);
    }
    if (!parado) { timer = setTimeout(() => { rodando = ciclo(); }, ok ? d.ajustes?.cicloMs ?? 30_000 : espera ?? d.ajustes?.passoMs ?? 5_000); timer.unref(); }
  };
  rodando = ciclo();

  /** o workspace daqui ligado ao do World (antes de o passo o achar, pelo banco) */
  const wsDaqui = () => ws ?? d.db.get<{ workspace_id: string }>('SELECT workspace_id FROM world_workspace_ids WHERE sync_workspace_id = ?', sws)?.workspace_id ?? null;
  return {
    estado: () => ({ estado, detalhe }),
    // de quem é o horário: a nuvem só roda pronta, com a posse contada pelo World há pouco, sem computador aberto, e
    // o horário que caiu antes de o computador soltar a posse foi dele
    posse(workspaceId, slot) {
      if (workspaceId !== wsDaqui()) return 'aqui';
      const h = Date.parse(slot);
      if (estado !== 'pronto' || !posse || Date.now() - posse.em > POSSE_VALE_MS || posse.em < h + FOLGA_POSSE_MS) {
        // a palavra do World é de antes do horário: pede de novo (no máximo a cada 3 s) e decide no próximo tique
        if (estado === 'pronto' && Date.now() - posseVista > 3_000) { posseVista = Date.now(); contado = ''; void contar('pronto'); }
        return 'esperar';
      }
      if (posse.pcAberto) {
        // aberto agora, mas só desde depois do horário (com folga) e depois que a posse anterior acabou: o horário caiu
        // com os computadores fechados
        if (posse.pcDesde !== null && h < posse.pcDesde - FOLGA_POSSE_MS && (posse.pcSaiu === null || h > posse.pcSaiu)) return 'aqui';
        return { outro: 'Um computador da equipe estava com o workspace aberto: este horário foi dele.' };
      }
      if (posse.pcAte !== null && h <= posse.pcAte) return { outro: 'Um computador da equipe estava com o workspace aberto neste horário: ele rodou por lá.' };
      return 'aqui';
    },
    async parar() {
      parado = true; if (timer) clearTimeout(timer);
      await rodando?.catch(() => undefined);
      // dormir: o que foi feito aqui vai para o World antes de sair (o computador recebe ao abrir), e o próximo horário
      // de rotina (o orquestrador acorda a nuvem nele)
      if (userId && ws && d.sync.status(ws).enabled) await d.sync.push(userId, ws, { contentOnly: true }).catch(() => undefined);
      if (estado === 'pronto') { contado = ''; await contar('pronto'); }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// No computador: sincronia automática e posse, só para o workspace com a nuvem ativa

export interface AutoSyncDeps {
  db: Db; client: WorldClient; links: WorldLinks; sync: LocalSync; canais?: CanaisNuvemHost; log: Log;
  /** o próximo horário de rotina do workspace (contado ao World a cada aviso de aberto e ao fechar) */
  proximoHorario?: (workspaceId: string) => string | null;
  ajustes?: { cicloMs?: number; estadoMs?: number };
}

/**
 * A cada minuto, para cada workspace ligado ao World com a nuvem ATIVA: avisa que este computador está com ele aberto
 * (a nuvem para de executar), entrega a chave da sincronia a quem ainda não tem (o aparelho-nuvem), recebe e envia.
 * Esqueleto novo vindo de outro computador não é aplicado sozinho (fica para a pessoa ver, como sempre).
 */
export function iniciarAutoSync(d: AutoSyncDeps): { agora: () => Promise<void>; parar: () => Promise<void>; posse: (workspaceId: string, slot: string) => PosseHorario } {
  const ativa = new Map<string, { at: number; on: boolean; rele: string | null; ticket: { exp: number; mac: string } | null }>();
  /**
   * A posse deste computador por workspace com a nuvem: desde quando ele está avisando sem parar que está aberto. Um
   * intervalo maior que `quebra` entre dois avisos (o computador dormiu, ficou sem sessão) recomeça a conta: o horário que
   * caiu nesse intervalo foi da nuvem.
   */
  const segurando = new Map<string, { desde: number; ultimo: number }>();
  // abaixo dos 2 min do World (PC_HOLD_SECONDS): quando o World já dá a posse à nuvem, este computador já não a tem
  const quebra = Math.min(115_000, Math.max(5_000, 2.5 * (d.ajustes?.cicloMs ?? 60_000)));
  const proxima = (ws: string): { nextWakeAt?: string | null } => { try { return d.proximoHorario ? { nextWakeAt: d.proximoHorario(ws) } : {}; } catch { return {}; } };
  let parado = false; let rodando: Promise<void> | null = null;
  const alvos = () => d.db.all<{ user_id: string; workspace_id: string; sws: string }>(`SELECT b.user_id, b.workspace_id, i.sync_workspace_id AS sws FROM world_bound b
    JOIN world_links l ON l.user_id = b.user_id AND l.status = 'active' JOIN world_workspace_ids i ON i.workspace_id = b.workspace_id`);
  const temNuvem = async (sws: string, s: string, ws: string): Promise<boolean> => {
    const c = ativa.get(sws);
    // "tem" vale por 5 min; "não tem" só por 1 (quem acabou de contratar não espera). O comprovante da reserva vale 15
    if (c && Date.now() - c.at < (c.on && c.rele ? d.ajustes?.estadoMs ?? 5 * 60_000 : Math.min(60_000, d.ajustes?.cicloMs ?? 60_000))) return c.on;
    try {
      const r = await d.client.call<{ active?: boolean; relayStandby?: string | null; relayTicket?: { exp: number; mac: string } | null }>('GET', `/v1/cloud?workspace=${sws}`, undefined, s);
      const on = r.active === true;
      ativa.set(sws, { at: Date.now(), on, rele: on && typeof r.relayStandby === 'string' ? r.relayStandby : null, ticket: on && r.relayTicket && typeof r.relayTicket.mac === 'string' ? r.relayTicket : null });
      // guardado: com o World fora do ar ao abrir, este computador continua sabendo que o workspace tem a nuvem (a posse)
      if ((getSetting(d.db, ws, 'nuvem.ativa') === '1') !== on) setSetting(d.db, ws, 'nuvem.ativa', on ? '1' : '0');
      return on;
    }
    catch { return c?.on ?? getSetting(d.db, ws, 'nuvem.ativa') === '1'; }
  };
  const uma = async (open: boolean) => {
    // o aplicativo pediu a pausa ao fechar (sync-atividade.ts): nenhum envio ou recebimento novo até a página abrir de
    // novo (ou a pausa vencer). O sinal de "computador aberto" segue: o servidor continua ligado e atende os canais
    const pausada = () => open && d.sync.atividade.pausada();
    for (const a of alvos()) {
      const s = d.links.session(a.user_id);
      if (!s) continue;
      if (!(await temNuvem(a.sws, s, a.workspace_id))) {
        // a nuvem acabou (ou nunca houve): se era ela a reserva dos canais deste workspace, deixa de ser
        if (ativa.has(a.sws)) try { d.canais?.reserva(a.workspace_id, null); } catch { /* segue */ }
        continue;
      }
      // os canais: com este computador fechado, a nuvem responde pelas contas ligadas (declarado ao serviço dos canais)
      const at = ativa.get(a.sws);
      if (at?.rele) try { d.canais?.reserva(a.workspace_id, { installationId: at.rele, syncWorkspaceId: a.sws, ticket: at.ticket }); } catch { /* segue */ }
      if (open) {
        const h = segurando.get(a.workspace_id); const t = Date.now();
        if (!h || t - h.ultimo > quebra) segurando.set(a.workspace_id, { desde: t, ultimo: t }); else h.ultimo = t;
      } else segurando.delete(a.workspace_id);
      try {
        await d.client.call('POST', '/v1/cloud/presence', { workspaceId: a.sws, open, ...proxima(a.workspace_id) }, s);
        // conferida antes de cada passo: a pausa pedida no meio do ciclo vale já para o passo seguinte
        if (pausada() || !d.sync.status(a.workspace_id).enabled) continue;
        if (open) {
          await d.sync.share(a.user_id, a.workspace_id);
          if (pausada()) continue;
          const p = await d.sync.pull(a.user_id, a.workspace_id, true, { holdOnBlueprint: true }) as { held?: boolean };
          if (p.held) continue; // equipe nova de outro computador: a pessoa recebe pela tela antes de enviar
          if (pausada()) continue;
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
  const primeiro = setTimeout(() => { if (!parado) void agora(); }, Math.min(5_000, d.ajustes?.cicloMs ?? 5_000)); primeiro.unref();
  return {
    agora,
    // de quem é o horário: deste computador se ele já estava avisando que está aberto quando o horário caiu; o que caiu
    // antes (fechado, dormindo, sem sessão) foi da nuvem. Sem nuvem no workspace, tudo aqui
    posse(workspaceId, slot) {
      if (getSetting(d.db, workspaceId, 'nuvem.ativa') !== '1') return 'aqui';
      const h = segurando.get(workspaceId);
      if (!h || Date.now() - h.ultimo > quebra) return 'esperar';
      return Date.parse(slot) >= h.desde ? 'aqui' : { outro: 'O computador estava fechado neste horário: a nuvem do Ergon World rodou por ele.' };
    },
    async parar() { parado = true; clearInterval(timer); clearTimeout(primeiro); await rodando?.catch(() => undefined); await uma(false).catch(() => undefined); },
  };
}
