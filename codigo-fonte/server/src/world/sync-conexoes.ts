/**
 * As CONEXÕES do computador na nuvem do Ergon World ("Subir o WS para o World"): com o computador desligado, a equipe na
 * nuvem continua lendo o e-mail, a agenda, os arquivos e os aplicativos (Google, Microsoft, Slack, Notion, Asana…), com
 * as mesmas ferramentas e as mesmas permissões que tem no computador.
 *
 * Por onde vão: SÓ pela sincronia cifrada ponta a ponta (sync-local.ts), num tipo de mudança próprio ('conexoes'), e com
 * duas camadas: a chave do workspace (que o World nunca vê) e, dentro, um envelope para UM aparelho (sync-crypto.ts,
 * sealForDevice): o aparelho-nuvem deste workspace, cuja chave pública X25519 o World entrega só ao dono (GET /v1/cloud,
 * cloudDevice). Por que as duas: a chave do workspace vai para todo aparelho de todo membro (colaboradores incluídos, e
 * outros computadores da pessoa); as credenciais são da pessoa dona e só a nuvem precisa delas. O World, por sua vez,
 * só aceita esse tipo vindo da conta dona (um computador dela ou o aparelho-nuvem deste workspace) e não o entrega a mais
 * ninguém (world/src/sync.ts), e cada lado confere quem mandou: a nuvem só aplica o que veio de um aparelho da conta
 * dona (o World garante) para ela; o computador só aceita a devolução do aparelho-nuvem do workspace.
 *
 * O que vai: um retrato das contas que a pessoa deixou ir (o interruptor "usar também na nuvem", depois de um aceite
 * explícito por workspace), com a credencial, o nome, se está ligada e os ajustes (o que os agentes podem fazer nela). O
 * retrato é inteiro: o que sumiu dele (desconectou, desligou o interruptor ou o aceite) sai da nuvem, com a credencial.
 * Fica de fora, com o motivo na tela: o WhatsApp (o pareamento é deste computador; uma segunda sessão do mesmo número
 * derruba a primeira), conexão com endereço da rede local (a nuvem não alcança) e login com o app próprio do Google ou da
 * Microsoft desta instalação (o acesso só se renova com o mesmo app, e a nuvem usa o do Ergon).
 * As regras de autonomia (conexoes/regras.ts) NÃO vão: na nuvem, o que elas liberavam volta a pedir aprovação.
 *
 * A renovação do acesso (Google, Microsoft): quem está com o workspace renova. Computador aberto (o World diz pcOpen),
 * a nuvem não renova a conta que veio dele (duas renovações do mesmo refresh token, uma derruba a outra onde ele gira);
 * fechado, a nuvem renova e o acesso novo volta ao computador pelo mesmo canal, cifrado para a chave pública dele. Em
 * cada lado vale a renovação mais recente (o acesso que vence depois), e só o acesso muda por esse caminho: a nuvem não
 * troca a conta, o nome nem as permissões do computador.
 *
 * Nada disto vai a log: o registro conta só quantas, quando e o código do erro.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ERGON_GOOGLE_APP, ERGON_MS_APP, type Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, now } from '../lib/util.ts';
import { audit, type Bus } from '../services/bus.ts';
import { CONTA_RE, INTEGRATIONS, contasDe, integrationDef, nomeDaConta, setIntegration, settingsOf, type IntegrationKind, type IntegrationRow, type Integrations } from '../services/integrations.ts';
import { isSso } from '../services/sso.ts';
import type { AuthContext } from '../services/auth.ts';
import type { WorldClient, WorldLinks } from './link.ts';
import type { LocalSync } from './sync-local.ts';
import { sealForDevice } from './sync-crypto.ts';

/** Por que uma conta não vai para a nuvem (a tela diz com as palavras dela). */
export type MotivoFora = 'whatsapp' | 'endereco_local' | 'app_proprio' | 'sem_credencial' | 'nao_conectada';
/** Uma conta no retrato que vai à nuvem. `clientId`: o app do Google ou da Microsoft com que ela entrou. */
interface Item { kind: string; conta: string; account: string | null; apelido: string | null; ativa: boolean; settings: Record<string, unknown>; cred: Record<string, unknown>; clientId?: string | null }
interface Pacote { type: 'conexoes.pacote'; v: 1; em: string; itens: Item[] }
/** Da nuvem ao computador: só o acesso renovado de cada conta Google ou Microsoft. */
interface ItemAcesso { kind: 'google' | 'microsoft'; conta: string; account: string; cred: { access_token: string; refresh_token: string; expires_at: number; granted?: string } }
interface Devolucao { type: 'conexoes.acessos'; v: 1; em: string; itens: ItemAcesso[] }
/** O corpo da mudança (aberto com a chave do workspace): o envelope de dentro só o aparelho `para` abre. */
interface Corpo { type: 'conexoes'; v: 1; para: string; dePub: string; envelope: string }

interface Estado {
  workspace_id: string; aceite_em: string | null; aceite_por: string | null; sal: string;
  enviado_estrutura: string | null; enviado_acessos: string | null; enviado_em: string | null; enviado_para: string | null; enviado_itens: number | null;
  nuvem_aparelho: string | null; devolvido_versao: number;
  origem_aparelho: string | null; origem_chave: string | null; recebido_em: string | null; recebido_versao: number; devolver: number;
  erro: string | null; erro_em: string | null;
}
type Log = (o: Record<string, unknown>, msg: string) => void;
type EstadoNuvemWorld = { active?: boolean; owner?: boolean; cloudDevice?: { deviceId: string; syncPublicKey: string } | null; pcOpen?: boolean };

/** Os acessos de uma conta (o que muda a cada renovação): fora do resumo da "estrutura" do que vai. */
const ACESSO = new Set(['access_token', 'expires_at', 'refresh_token', 'granted']);
/** No computador, o acesso girado (a Microsoft troca o refresh token a cada renovação) vai no máximo a cada 6 h, e ao fechar. */
const ACESSOS_A_CADA_MS = 6 * 3_600_000;
const SETTINGS_FORA = ['pendenteDesde', 'antesDeConectar'];
const MAX_ITENS = 200; const MAX_ITEM = 64_000;

/** O app oficial do Ergon no Google e na Microsoft: o único com que a nuvem renova o acesso. */
const APP_OFICIAL: Record<'google' | 'microsoft', string> = { google: ERGON_GOOGLE_APP, microsoft: ERGON_MS_APP };
const appDaInstalacao = (cfg: Config, kind: 'google' | 'microsoft') => (kind === 'google' ? cfg.googleClientId : cfg.msClientId);

/**
 * O endereço é da rede local (a nuvem não alcança): localhost, nome sem domínio, .local/.lan/.internal/.home, IPv4 das
 * faixas privadas, de loopback e de enlace, IPv6 de loopback, local e de enlace.
 */
export function enderecoLocal(v: string): boolean {
  const s = v.trim(); if (!s) return false;
  let host: string;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|lan|internal|home|intranet|corp)$/.test(host)) return true;
  const ip4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip4) {
    const [a, b] = [Number(ip4[1]), Number(ip4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  return !host.includes('.');
}

// ---------------------------------------------------------------- conferência do que chega decifrado
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const KINDS_NUVEM = new Set(INTEGRATIONS.filter((d) => (d.auth === 'token' || d.auth === 'oauth') && d.kind !== 'whatsapp').map((d) => d.kind as string));
/** Credencial: só texto, número e sim/não (nada de objeto que o SecretStore gravaria sem saber o que é). */
const credOk = (c: unknown) => obj(c) && Object.keys(c).length <= 40 && Object.entries(c).every(([k, v]) => /^[a-z_][a-z0-9_]{0,40}$/i.test(k) && (str(v, 20_000) || typeof v === 'number' || typeof v === 'boolean'));
function conferirPacote(b: unknown): Pacote | null {
  if (!obj(b) || b.type !== 'conexoes.pacote' || b.v !== 1 || !Array.isArray(b.itens) || b.itens.length > MAX_ITENS) return null;
  const vistos = new Set<string>();
  for (const x of b.itens as unknown[]) {
    if (!obj(x) || !str(x.kind, 20) || !KINDS_NUVEM.has(x.kind as string) || typeof x.conta !== 'string' || (x.conta !== '' && !CONTA_RE.test(x.conta))) return null;
    if (!(x.account === null || str(x.account, 120)) || !(x.apelido === null || str(x.apelido, 80)) || typeof x.ativa !== 'boolean' || !obj(x.settings) || !credOk(x.cred)) return null;
    if (x.clientId !== undefined && !(x.clientId === null || str(x.clientId, 120))) return null;
    if (JSON.stringify(x).length > MAX_ITEM) return null;
    const k = `${x.kind}:${x.conta}`; if (vistos.has(k)) return null; vistos.add(k);
  }
  return b as unknown as Pacote;
}
function conferirDevolucao(b: unknown): Devolucao | null {
  if (!obj(b) || b.type !== 'conexoes.acessos' || b.v !== 1 || !Array.isArray(b.itens) || b.itens.length > MAX_ITENS) return null;
  for (const x of b.itens as unknown[]) {
    if (!obj(x) || (x.kind !== 'google' && x.kind !== 'microsoft') || typeof x.conta !== 'string' || (x.conta !== '' && !CONTA_RE.test(x.conta)) || !str(x.account, 200) || !obj(x.cred)) return null;
    const c = x.cred;
    if (!str(c.access_token, 20_000) || !str(c.refresh_token, 20_000) || !c.refresh_token || typeof c.expires_at !== 'number' || !(c.granted === undefined || str(c.granted, 4000))) return null;
  }
  return b as unknown as Devolucao;
}
function conferirCorpo(b: unknown): Corpo | null {
  return obj(b) && b.type === 'conexoes' && b.v === 1 && str(b.para, 40) && str(b.dePub, 200) && str(b.envelope, 3_000_000) ? b as unknown as Corpo : null;
}

export interface ConexoesNuvemDeps { db: Db; cfg: Config; bus: Bus; client: WorldClient; links: WorldLinks; sync: LocalSync; integrations: Integrations; nuvem: boolean; log: Log;
  /** o estado da nuvem no World vale no máximo isto (os testes encurtam; padrão 60 s no computador e 30 s na nuvem) */
  ajustes?: { cacheMs?: number } }

export class ConexoesNuvem {
  private readonly d: ConexoesNuvemDeps;
  /** o estado da nuvem no World, por workspace World (vale 60 s; na nuvem, 30 s: é a posse) */
  private readonly world = new Map<string, { at: number; v: EstadoNuvemWorld }>();
  constructor(d: ConexoesNuvemDeps) {
    this.d = d;
    d.sync.aoReceberConexoes = (ws, x, corpo) => this.receber(ws, x, corpo);
    if (d.nuvem) {
      // a posse da renovação: computador aberto, a conta que veio dele não se renova aqui
      d.integrations.sso.podeRenovar = (ws, kind, conta) => (this.veioDoComputador(ws, kind, conta) && this.pcAberto(ws)
        ? 'o computador da pessoa está com o workspace aberto e renova este acesso; a nuvem usa o renovado assim que ele chegar' : null);
      d.integrations.sso.aoRenovar = (ws, kind, conta) => { if (this.veioDoComputador(ws, kind, conta)) this.marcar(ws, { devolver: 1 }); };
    }
  }

  // ---------------------------------------------------------------- estado guardado
  private estado(ws: string): Estado {
    let e = this.d.db.get<Estado>('SELECT * FROM world_conexoes_nuvem WHERE workspace_id = ?', ws);
    if (!e) {
      this.d.db.run('INSERT INTO world_conexoes_nuvem (workspace_id, sal, updated_at) VALUES (?, ?, ?)', ws, crypto.randomBytes(32).toString('base64'), now());
      e = this.d.db.get<Estado>('SELECT * FROM world_conexoes_nuvem WHERE workspace_id = ?', ws)!;
    }
    return e;
  }
  private marcar(ws: string, x: Partial<Omit<Estado, 'workspace_id' | 'sal'>>) {
    this.estado(ws);
    const ks = Object.keys(x); if (!ks.length) return;
    this.d.db.run(`UPDATE world_conexoes_nuvem SET ${ks.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE workspace_id = ?`, ...ks.map((k) => (x as Record<string, string | number | null>)[k]), now(), ws);
  }
  private erro(ws: string, codigo: string | null) { this.marcar(ws, { erro: codigo, erro_em: codigo ? now() : null }); }
  private resumo(ws: string, v: unknown): string { return crypto.createHmac('sha256', Buffer.from(this.estado(ws).sal, 'base64')).update(JSON.stringify(v)).digest('hex'); }

  private async estadoWorld(userId: string, sws: string, padraoMs: number): Promise<EstadoNuvemWorld | null> {
    const maxMs = Math.min(padraoMs, this.d.ajustes?.cacheMs ?? padraoMs);
    const c = this.world.get(sws);
    if (c && Date.now() - c.at < maxMs) return c.v;
    const s = this.d.links.session(userId); if (!s) return c?.v ?? null;
    try { const v = await this.d.client.call<EstadoNuvemWorld>('GET', `/v1/cloud?workspace=${sws}`, undefined, s); this.world.set(sws, { at: Date.now(), v }); return v; }
    catch { return c?.v ?? null; }
  }
  /** Na nuvem: um computador está com o workspace aberto (o que o World disse por último; sem resposta ainda, não). */
  private pcAberto(ws: string): boolean { const sws = this.d.sync.worldId(ws); return !!(sws && this.world.get(sws)?.v.pcOpen); }
  private veioDoComputador(ws: string, kind: string, conta: string): boolean {
    return !!this.d.db.get('SELECT 1 AS x FROM world_conexoes_recebidas WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, kind, conta);
  }

  // ---------------------------------------------------------------- no computador: o que vai
  /** Por que esta conta não vai (ou null: pode ir). */
  private motivo(ws: string, r: IntegrationRow): MotivoFora | null {
    if (r.kind === 'whatsapp') return 'whatsapp';
    if (r.state !== 'connected') return 'nao_conectada';
    const def = integrationDef(r.kind);
    if (!def || !KINDS_NUVEM.has(r.kind)) return 'nao_conectada';
    if (isSso(r.kind) && appDaInstalacao(this.d.cfg, r.kind) !== APP_OFICIAL[r.kind]) return 'app_proprio';
    let cred: Record<string, unknown> | null = null;
    try { cred = this.d.integrations.secrets.read<Record<string, unknown>>(ws, r.kind, r.conta); } catch { cred = null; }
    if (!cred) return 'sem_credencial';
    const abertos = (def.fields ?? []).filter((f) => !f.secret).map((f) => f.name);
    if (abertos.some((n) => typeof cred[n] === 'string' && enderecoLocal(cred[n] as string))) return 'endereco_local';
    return null;
  }
  private usar(ws: string, integrationId: string): boolean {
    // padrão: ligado (a confirmação explícita é o aceite, uma vez por workspace; a pessoa desliga uma por uma)
    return (this.d.db.get<{ usar: number }>('SELECT usar FROM world_conexoes_escolha WHERE workspace_id = ? AND integration_id = ?', ws, integrationId)?.usar ?? 1) === 1;
  }
  private contas(ws: string): IntegrationRow[] {
    return INTEGRATIONS.filter((d) => d.auth !== 'soon').flatMap((d) => contasDe(this.d.db, ws, d.kind)).filter((r) => r.state !== 'off');
  }
  private itens(ws: string): Item[] {
    const e = this.estado(ws); if (!e.aceite_em) return [];
    const out: Item[] = [];
    for (const r of this.contas(ws)) {
      if (this.motivo(ws, r) || !this.usar(ws, r.id)) continue;
      const cred = this.d.integrations.secrets.read<Record<string, unknown>>(ws, r.kind, r.conta);
      if (!cred) continue;
      const s = settingsOf(r); for (const k of SETTINGS_FORA) delete s[k];
      out.push({ kind: r.kind, conta: r.conta, account: r.account_label, apelido: r.apelido, ativa: r.ativa !== 0, settings: s, cred, ...(isSso(r.kind) ? { clientId: appDaInstalacao(this.d.cfg, r.kind) } : {}) });
    }
    return out;
  }

  /**
   * Um passo no computador (a sincronia automática chama depois de receber e enviar): com o aceite e a nuvem ativa, o
   * retrato vai se mudou o que vai (conta, nome, ajustes, credencial colada) ou o aparelho-nuvem; o acesso girado, a cada
   * 6 h no máximo, e sempre ao fechar (`aberto` false). Sem o aceite, mas com algo já enviado: vai o retrato vazio (a
   * nuvem apaga tudo).
   */
  async passo(userId: string, ws: string, aberto: boolean): Promise<void> {
    if (this.d.nuvem) return;
    const sws = this.d.sync.worldId(ws); if (!sws || !this.d.sync.status(ws).enabled) return;
    const e = this.estado(ws);
    if (!e.aceite_em && !e.enviado_estrutura) return;
    const w = await this.estadoWorld(userId, sws, 60_000);
    if (!w?.active || !w.owner) return;
    const destino = w.cloudDevice ?? null;
    if (!destino) { this.erro(ws, 'sem_aparelho_nuvem'); return; }
    if (e.nuvem_aparelho !== destino.deviceId) this.marcar(ws, { nuvem_aparelho: destino.deviceId });
    // uma credencial escolhida que não se lê agora (Ergon trancado, arquivo sumido): o retrato sairia menor e a nuvem
    // apagaria a conta. Espera dar para ler
    if (e.aceite_em && this.contas(ws).some((r) => this.usar(ws, r.id) && this.motivo(ws, r) === 'sem_credencial')) { this.erro(ws, 'sem_credencial'); return; }
    const itens = this.itens(ws);
    const estrutura = this.resumo(ws, itens.map((i) => ({ ...i, cred: Object.fromEntries(Object.entries(i.cred).filter(([k]) => !ACESSO.has(k))) })));
    const acessos = this.resumo(ws, itens.map((i) => (isSso(i.kind as IntegrationKind) ? [i.kind, i.conta, i.cred.refresh_token ?? null, i.cred.granted ?? null] : null)));
    const mudou = estrutura !== e.enviado_estrutura || destino.deviceId !== e.enviado_para;
    const girou = acessos !== e.enviado_acessos && (!aberto || !e.enviado_em || Date.now() - Date.parse(e.enviado_em) > ACESSOS_A_CADA_MS);
    if (!mudou && !girou) return;
    const pacote: Pacote = { type: 'conexoes.pacote', v: 1, em: now(), itens };
    try { await this.enviar(userId, ws, sws, destino, pacote); }
    catch (err) {
      const code = String((err as { code?: string }).code ?? 'falha');
      // outro aparelho mandou antes: vai no próximo ciclo, depois de receber
      if (code !== 'version_conflict') { this.erro(ws, code.slice(0, 40)); this.d.log({ ws, code }, 'conexões: o envio à nuvem falhou'); }
      return;
    }
    this.marcar(ws, { enviado_estrutura: estrutura, enviado_acessos: acessos, enviado_em: now(), enviado_para: destino.deviceId, enviado_itens: itens.length, erro: null, erro_em: null });
    this.d.log({ ws, itens: itens.length }, 'conexões: retrato enviado à nuvem');
    this.d.bus.publish(ws, 'integrations.changed', {});
  }

  private async enviar(userId: string, ws: string, sws: string, destino: { deviceId: string; syncPublicKey: string }, conteudo: Pacote | Devolucao) {
    const eu = this.d.sync.aparelho(userId);
    const envelope = sealForDevice(Buffer.from(JSON.stringify(conteudo), 'utf8'), destino.syncPublicKey, { ws: sws, from: eu.deviceId, to: destino.deviceId });
    const corpo: Corpo = { type: 'conexoes', v: 1, para: destino.deviceId, dePub: eu.x25519Public, envelope };
    return this.d.sync.enviarTipo(userId, ws, 'conexoes', corpo);
  }

  // ---------------------------------------------------------------- recebendo (os dois lados)
  /** Uma mudança 'conexoes' de outro aparelho da conta dona (sync-local.ts, receber). */
  private receber(ws: string, x: { deviceId: string; version: number }, corpoBruto: unknown): void {
    const corpo = conferirCorpo(corpoBruto);
    const userId = this.d.db.get<{ user_id: string }>('SELECT user_id FROM world_sync WHERE workspace_id = ?', ws)?.user_id;
    const sws = this.d.sync.worldId(ws);
    if (!corpo || !userId || !sws) { this.erro(ws, 'formato'); return; }
    const eu = this.d.sync.aparelho(userId);
    if (corpo.para !== eu.deviceId) return; // para outro aparelho da conta (outro computador da pessoa): não é daqui
    let aberto: unknown;
    try { aberto = JSON.parse(eu.abrir(corpo.envelope, { ws: sws, from: x.deviceId }).toString('utf8')); }
    catch { this.erro(ws, 'nao_abre'); this.d.log({ ws, versao: x.version }, 'conexões: pacote que não abre com a chave deste aparelho (recusado)'); return; }
    if (this.d.nuvem) this.aplicarPacote(ws, x, corpo, aberto);
    else this.aplicarDevolucao(ws, x, aberto);
  }

  /** Na nuvem: o retrato do computador vira as contas daqui (o que sumiu dele sai, com a credencial). */
  private aplicarPacote(ws: string, x: { deviceId: string; version: number }, corpo: Corpo, bruto: unknown) {
    const p = conferirPacote(bruto);
    if (!p) { this.erro(ws, 'formato'); this.d.log({ ws, versao: x.version }, 'conexões: retrato em formato inesperado (nada aplicado)'); return; }
    const e = this.estado(ws);
    if (x.version <= e.recebido_versao) return; // mais antigo que o já aplicado (repetido ou fora de ordem)
    const secrets = this.d.integrations.secrets;
    const antes = this.d.db.all<{ kind: string; conta: string }>('SELECT kind, conta FROM world_conexoes_recebidas WHERE workspace_id = ?', ws);
    const ficam = new Set(p.itens.map((i) => `${i.kind}:${i.conta}`));
    let aplicadas = 0; let fora = 0;
    this.d.db.tx(() => {
      for (const i of p.itens) {
        const kind = i.kind as IntegrationKind;
        const existente = this.d.db.get<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, kind, i.conta);
        // conta que nasceu aqui na nuvem (não veio do computador): não se sobrescreve
        if (existente && existente.state !== 'off' && !this.veioDoComputador(ws, kind, i.conta)) { fora++; continue; }
        if (!existente) {
          if (i.conta) this.d.db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, settings, created_at) VALUES (?, ?, ?, ?, 'off', '{}', ?)", `int_${crypto.randomBytes(12).toString('hex')}`, ws, kind, i.conta, now());
        }
        let cred = i.cred;
        if (isSso(kind)) {
          // vale a renovação mais recente: a nuvem renovou depois do que o computador mandou (mesma conta): fica o acesso daqui
          const atual = secrets.readOwn<Record<string, unknown>>(ws, kind, i.conta);
          if (atual && String(atual.account ?? '').toLowerCase() === String(cred.account ?? '').toLowerCase() && Number(atual.expires_at ?? 0) > Number(cred.expires_at ?? 0))
            cred = { ...cred, access_token: atual.access_token, refresh_token: atual.refresh_token, expires_at: atual.expires_at, ...(atual.granted !== undefined ? { granted: atual.granted } : {}) };
        }
        // o app do Google ou da Microsoft com que a conta entrou tem de ser o desta instalação: o acesso só renova com ele
        const appErrado = isSso(kind) && (i.clientId ?? null) !== appDaInstalacao(this.d.cfg, kind);
        this.d.db.run("UPDATE integrations SET origem_workspace_id = NULL, origem_conta = '' WHERE workspace_id = ? AND kind = ? AND conta = ?", ws, kind, i.conta);
        secrets.writeOwn(ws, kind, cred, i.conta);
        setIntegration(this.d.db, ws, kind, { state: appErrado ? 'error' : 'connected', account_label: i.account, apelido: i.apelido, ativa: i.ativa, settings: i.settings,
          last_error: appErrado ? 'Esta conta entrou com outro app do Google ou da Microsoft: a nuvem não renova o acesso dela.' : null, connected_at: existente?.connected_at ?? now() }, i.conta);
        this.d.db.run(`INSERT INTO world_conexoes_recebidas (workspace_id, kind, conta, origem, recebida_em) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, kind, conta) DO UPDATE SET origem = excluded.origem, recebida_em = excluded.recebida_em`, ws, kind, i.conta, x.deviceId, now());
        aplicadas++;
      }
      // o que sumiu do retrato: desconectou, desligou o interruptor ou o aceite no computador
      for (const a of antes) {
        if (ficam.has(`${a.kind}:${a.conta}`)) continue;
        this.remover(ws, a.kind as IntegrationKind, a.conta);
      }
      this.marcar(ws, { origem_aparelho: x.deviceId, origem_chave: corpo.dePub, recebido_em: now(), recebido_versao: x.version, erro: null, erro_em: null });
    });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action: 'integration.cloud_received', targetType: 'integration', targetId: 'nuvem',
      evidence: { contas: aplicadas, ...(fora ? { ficaramDeFora: fora } : {}) }, result: `conexões vindas do computador: ${aplicadas}` });
    this.d.log({ ws, contas: aplicadas, fora }, 'conexões: retrato do computador aplicado');
    this.d.bus.publish(ws, 'integrations.changed', {});
  }

  private remover(ws: string, kind: IntegrationKind, conta: string) {
    const secrets = this.d.integrations.secrets;
    secrets.remove(ws, kind, conta); secrets.removeDir(ws, kind, conta);
    if (conta) this.d.db.run('DELETE FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, kind, conta);
    else setIntegration(this.d.db, ws, kind, { state: 'off', account_label: null, apelido: null, last_error: null }, '');
    this.d.db.run('DELETE FROM world_conexoes_recebidas WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, kind, conta);
  }

  /** No computador: o acesso que a nuvem renovou. Só o acesso, só da mesma conta e só se for mais novo que o daqui. */
  private aplicarDevolucao(ws: string, x: { deviceId: string; version: number }, bruto: unknown) {
    const e = this.estado(ws);
    // só o aparelho-nuvem deste workspace devolve (outro computador da pessoa não fala pela nuvem)
    if (!e.nuvem_aparelho || x.deviceId !== e.nuvem_aparelho) { this.erro(ws, 'remetente'); this.d.log({ ws, versao: x.version }, 'conexões: devolução de quem não é a nuvem deste workspace (recusada)'); return; }
    if (x.version <= e.devolvido_versao) return;
    const dv = conferirDevolucao(bruto);
    if (!dv) { this.erro(ws, 'formato'); return; }
    const secrets = this.d.integrations.secrets; let n = 0;
    for (const i of dv.itens) {
      const r = this.d.db.get<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ? AND state = 'connected'", ws, i.kind, i.conta);
      if (!r) continue;
      const atual = secrets.read<Record<string, unknown>>(ws, i.kind, i.conta);
      if (!atual || String(atual.account ?? '').toLowerCase() !== i.account.toLowerCase()) continue; // outra conta: não mexe
      if (Number(atual.expires_at ?? 0) >= i.cred.expires_at) continue; // o daqui é o mais novo
      secrets.write(ws, i.kind, { ...atual, access_token: i.cred.access_token, refresh_token: i.cred.refresh_token, expires_at: i.cred.expires_at, ...(i.cred.granted !== undefined ? { granted: i.cred.granted } : {}) }, i.conta);
      n++;
    }
    this.marcar(ws, { devolvido_versao: x.version });
    if (n) this.d.log({ ws, contas: n }, 'conexões: acesso renovado na nuvem recebido');
  }

  /**
   * Um passo na nuvem (o ciclo da nuvem chama depois de receber e enviar, e ao dormir): lê a posse no World e, se renovou
   * algum acesso que veio do computador, devolve a ele, cifrado para a chave pública que veio no retrato.
   */
  async passoNuvem(userId: string, ws: string): Promise<void> {
    if (!this.d.nuvem) return;
    const sws = this.d.sync.worldId(ws); if (!sws) return;
    await this.estadoWorld(userId, sws, 30_000);
    const e = this.estado(ws);
    if (!e.devolver || !e.origem_aparelho || !e.origem_chave) return;
    const itens: ItemAcesso[] = [];
    for (const r of this.d.db.all<{ kind: 'google' | 'microsoft'; conta: string }>("SELECT kind, conta FROM world_conexoes_recebidas WHERE workspace_id = ? AND kind IN ('google', 'microsoft')", ws)) {
      const c = this.d.integrations.secrets.readOwn<Record<string, unknown>>(ws, r.kind, r.conta);
      if (!c || typeof c.refresh_token !== 'string' || !c.refresh_token || typeof c.access_token !== 'string' || typeof c.expires_at !== 'number') continue;
      itens.push({ kind: r.kind, conta: r.conta, account: String(c.account ?? ''), cred: { access_token: c.access_token, refresh_token: c.refresh_token, expires_at: c.expires_at, ...(typeof c.granted === 'string' ? { granted: c.granted } : {}) } });
    }
    try { await this.enviar(userId, ws, sws, { deviceId: e.origem_aparelho, syncPublicKey: e.origem_chave }, { type: 'conexoes.acessos', v: 1, em: now(), itens }); }
    catch (err) { const code = String((err as { code?: string }).code ?? 'falha'); if (code !== 'version_conflict') { this.erro(ws, code.slice(0, 40)); this.d.log({ ws, code }, 'conexões: a devolução ao computador falhou'); } return; }
    this.marcar(ws, { devolver: 0 });
    this.d.log({ ws, contas: itens.length }, 'conexões: acesso renovado devolvido ao computador');
  }

  // ---------------------------------------------------------------- a tela
  /** O que a tela mostra: no computador, cada conta e se vai; na nuvem, as que vieram do computador. */
  async tela(a: AuthContext) {
    const ws = a.workspaceId; const e = this.estado(ws);
    const sws = this.d.sync.worldId(ws);
    if (this.d.nuvem) {
      const vindas = this.d.db.all<{ kind: string; conta: string }>('SELECT kind, conta FROM world_conexoes_recebidas WHERE workspace_id = ? ORDER BY kind, conta', ws);
      return { modo: 'nuvem' as const, disponivel: true, recebidoEm: e.recebido_em, erro: e.erro,
        contas: vindas.map((v) => { const r = this.d.db.get<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, v.kind, v.conta);
          return { id: r?.id ?? '', kind: v.kind, app: integrationDef(v.kind as IntegrationKind)?.name ?? v.kind, nome: r ? nomeDaConta(r) : '', estado: r?.state === 'connected' ? 'na_nuvem' : 'erro', usar: true, motivo: null }; }) };
    }
    const w = sws && this.d.links.session(a.userId) && this.d.sync.status(ws).enabled ? await this.estadoWorld(a.userId, sws, 60_000) : null;
    const disponivel = !!w?.active && !!w.owner;
    const enviados = e.enviado_para && e.enviado_estrutura ? new Set(this.itensEnviaveis(ws)) : new Set<string>();
    const contas = this.contas(ws).map((r) => {
      const motivo = this.motivo(ws, r); const usar = this.usar(ws, r.id);
      const estado = motivo ? 'fora' : !usar ? 'desligada' : !e.aceite_em ? 'aguardando_aceite' : enviados.has(r.id) ? 'na_nuvem' : 'enviando';
      return { id: r.id, kind: r.kind, app: integrationDef(r.kind)?.name ?? r.kind, nome: nomeDaConta(r), estado, usar, motivo };
    });
    return { modo: 'computador' as const, disponivel, semAparelho: disponivel && !w?.cloudDevice, aceite: e.aceite_em ? { em: e.aceite_em } : null, enviadoEm: e.enviado_em, erro: e.erro, contas };
  }
  /** As contas que estavam no último retrato enviado (o resumo da estrutura bate com o que vai agora). */
  private itensEnviaveis(ws: string): string[] {
    const e = this.estado(ws); const itens = this.itens(ws);
    const estrutura = this.resumo(ws, itens.map((i) => ({ ...i, cred: Object.fromEntries(Object.entries(i.cred).filter(([k]) => !ACESSO.has(k))) })));
    if (estrutura !== e.enviado_estrutura) return [];
    const ids = new Map(this.contas(ws).map((r) => [`${r.kind}:${r.conta}`, r.id]));
    return itens.map((i) => ids.get(`${i.kind}:${i.conta}`) ?? '').filter(Boolean);
  }

  rotas(app: FastifyInstance, owner: (req: FastifyRequest) => AuthContext, auth: (req: FastifyRequest) => AuthContext) {
    app.get('/api/world/nuvem/conexoes', async (req) => this.tela(this.d.nuvem ? auth(req) : owner(req)));
    // o aceite (uma vez por workspace): sem ele, nenhuma credencial sai deste computador. Desligar apaga tudo da nuvem
    app.post('/api/world/nuvem/conexoes/aceite', { schema: { body: { type: 'object', additionalProperties: false, required: ['ligar'], properties: { ligar: { type: 'boolean' } } } } }, async (req) => {
      if (this.d.nuvem) throw new HttpError(409, 'nuvem', 'As conexões da nuvem vêm do computador da pessoa.');
      const a = owner(req); const { ligar } = req.body as { ligar: boolean };
      this.marcar(a.workspaceId, ligar ? { aceite_em: now(), aceite_por: a.userId } : { aceite_em: null, aceite_por: null });
      audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: ligar ? 'integration.cloud_on' : 'integration.cloud_off', targetType: 'integration', targetId: 'nuvem',
        result: ligar ? 'as conexões escolhidas passam a ir, cifradas, para a nuvem do workspace' : 'as conexões saem da nuvem do workspace' });
      this.d.bus.publish(a.workspaceId, 'integrations.changed', {});
      return this.tela(a);
    });
    app.put('/api/world/nuvem/conexoes/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^int_[A-Za-z0-9]{8,64}$' } } },
      body: { type: 'object', additionalProperties: false, required: ['usar'], properties: { usar: { type: 'boolean' } } } } }, async (req) => {
      if (this.d.nuvem) throw new HttpError(409, 'nuvem', 'As conexões da nuvem vêm do computador da pessoa.');
      const a = owner(req); const { id } = req.params as { id: string }; const { usar } = req.body as { usar: boolean };
      const r = this.d.db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', id, a.workspaceId);
      if (!r) throw new HttpError(404, 'not_found', 'conexão não encontrada neste workspace');
      this.d.db.run(`INSERT INTO world_conexoes_escolha (workspace_id, integration_id, usar, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (workspace_id, integration_id) DO UPDATE SET usar = excluded.usar, updated_at = excluded.updated_at`, a.workspaceId, id, usar ? 1 : 0, now());
      audit(this.d.db, this.d.bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: usar ? 'integration.cloud_on' : 'integration.cloud_off', targetType: 'integration', targetId: r.kind,
        evidence: r.conta ? { conta: r.conta } : {}, result: usar ? 'esta conta também vai para a nuvem' : 'esta conta sai da nuvem' });
      this.d.bus.publish(a.workspaceId, 'integrations.changed', {});
      return this.tela(a);
    });
  }
}
