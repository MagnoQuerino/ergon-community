/**
 * Um motor de IA por pessoa. Cada conta tem o próprio contêiner do motor, com cofre próprio (chave
 * derivada da chave pessoal dela) e a própria conta de IA: um agente com Terminal ou Executar código não alcança os
 * dados de outra pessoa, e o consumo de IA é de quem pediu. O gerente de motores — o único contêiner com acesso ao
 * Docker — cria, liga e desliga os contêineres; aqui o Ergon escolhe o motor de cada workspace, entrega a chave do
 * cofre quando a pessoa abre a parte dela e reconhece qual motor está chamando a ponte (um token por motor, derivado
 * do da instalação; nenhum motor tem o da instalação).
 *
 * Renovação (versão nova do motor): o gerente diz que o contêiner está desatualizado (stale). Com trabalho em andamento
 * no motor, o estado vira "renovando": os pedidos novos esperam na fila sem contar tempo (accepting) e o que já está no
 * motor termina. Livre, o gerente recria o contêiner com o MESMO cofre; o Ergon entrega a chave de novo, confere a
 * saúde e as capacidades do plugin e confirma (o gerente apaga a imagem anterior). Se o cofre, a saúde ou as
 * capacidades falharem no prazo, o gerente volta para a imagem anterior e a tela diz isso, sem laço de tentativas.
 * Parte fechada (a pessoa ainda não entrou): o contêiner é recriado sem ligar e sem chave; abre quando ela entrar.
 *
 * Sem gerente configurado (ERGON_MOTOR_MANAGER_URL vazio): um motor só para todos, como antes.
 */
import crypto from 'node:crypto';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { clip, safeEqual } from '../lib/util.ts';
import { log, scrub } from '../lib/log.ts';
import { temJargao } from '../lib/texto-tela.ts';
import type { Vault } from '../security/keys.ts';
import { VERSION } from '../version.ts';
import { AiService } from './ai.ts';
import { audit } from './bus.ts';
import { setMotorScope, setRenovacaoFalhou } from './characters.ts';
import { CAPACIDADE_CONEXOES, HttpHermesClient, HttpHermesControl, type HermesClient, type HermesControlClient, type MotorInfo } from './hermes.ts';
import { isAdmin, type WorkspaceOwners } from './people.ts';
import { instanceSetting, setInstanceSetting } from './security.ts';

/** Nome do contêiner do motor da pessoa (é também o endereço dele na rede interna). */
export const motorName = (userId: string): string => `ergon-motor-${userId.slice(4)}`;
/** Segredos de cada motor, derivados do token da instalação (o Ergon e o gerente calculam igual; o motor só tem o dele). */
export function motorSecret(master: string, purpose: 'bridge' | 'api' | 'dashboard', userId: string): string {
  return crypto.createHmac('sha256', master).update(`ergon/motor-${purpose}/${userId}`).digest('hex');
}

/** renovando: versão nova do motor a caminho; os pedidos novos esperam (sem contar tempo) até ela abrir */
export type MotorState = 'desligado' | 'ligando' | 'renovando' | 'aberto' | 'erro';
interface MotorClients { hermes: HermesClient | null; control: HermesControlClient | null }

/**
 * Resposta do gerente a POST /v1/motors/:uid/ensure. O gerente de antes só manda {ok, adopted, created, state}. motivo (só
 * com stale e sem recreated): 'ocupado' = renova quando o motor ficar livre; 'sem-imagem' ou 'nao-parou' = não vai renovar
 * agora, e o motor de antes segue ligado (o Ergon abre ele e tenta de novo mais tarde).
 */
interface EnsureResp {
  ok?: boolean; adopted?: boolean; created?: boolean; recreated?: boolean; stale?: boolean; motivo?: 'ocupado' | 'sem-imagem' | 'nao-parou' | null; image?: string | null; prevImage?: string | null;
  /** o motor está travado na versão anterior porque a configurada foi recusada numa volta atrás (o gerente de antes não manda) */
  held?: boolean;
}
/**
 * O gerente não respondeu a tempo (ex.: baixando a imagem nova, de vários GB): ele continua o trabalho, e o Ergon pergunta
 * de novo. O texto vai para a tela ("Está levando mais que o normal (…)"): sem jargão e sem parênteses.
 */
const TEMPO_DO_GERENTE = 'a versão nova da equipe ainda está chegando a este computador';
const estourou = (e: unknown) => (e as { tempo?: boolean })?.tempo === true;

/** Cofre de pessoa (o nome do volume traz o id dela). O cofre de antes (herdado) nunca entra aqui. */
const VOLUME_PESSOA = /^ergon_motor-([a-f0-9]{32})$/;
/** Cache da manutenção (instance setting): a última limpeza e os volumes que o gerente viu sem dono. */
const ESPACO = 'manutencao_espaco';
const LIMPEZA_VERSAO = 'limpeza_versao';
const REMOVIDOS = 'motores_removidos';
const confirmado = (userId: string) => `motor_confirmado:${userId}`;
/** recriado pela partida com a parte fechada (sem ligar): a primeira abertura confere e, se falhar, pode voltar */
const recriado = (userId: string) => `motor_recriado:${userId}`;
/** a renovação desta versão voltou atrás (gravada: vale também depois de reiniciar o servidor, até a versão mudar) */
const falhaKey = (userId: string) => `motor_renovacao_falhou:${userId}`;
interface FalhaRenovacao { motivo: string; vezes: number; at: number; voltou: boolean; alvo: string | null }
/** Motivo quando o gerente diz que o motor está travado na versão anterior e não há motivo gravado. */
const FALHA_SEM_MOTIVO = 'a versão nova da equipe não passou na conferência neste computador';

/**
 * O motivo técnico (do gerente, do cofre, da rede) em português para a tela: a Saúde, as Contas de IA, o pedido que espera
 * na fila e a Atividade mostram este texto. O técnico fica no registro do servidor (log). Texto já sem jargão passa como está.
 */
export function motivoParaTela(tecnico: string | null | undefined): string {
  const t = String(tecnico ?? '').trim();
  if (!t) return 'a equipe não ligou agora';
  if (!temJargao(t)) return t;
  if (/versão anterior/i.test(t) && /não está mais|não estava/i.test(t)) return 'a versão anterior da equipe já não está neste computador';
  if (/imagem|download/i.test(t) && /não chegou|não está mais|baixar/i.test(t)) return 'a versão nova da equipe ainda não chegou a este computador';
  if (/sem as Conexões/i.test(t)) return 'a versão nova da equipe veio sem as Conexões';
  if (/não parou/i.test(t)) return 'a equipe não parou a tempo para a troca';
  if (/outra instalação/i.test(t)) return 'o que foi encontrado é de outra instalação do Ergon neste computador: nada foi mexido';
  if (/cofre/i.test(t) && /não confere|qual é o cofre/i.test(t)) return 'o cofre da equipe não confere: nada foi trocado';
  if (/cofre/i.test(t)) return /não respondeu|fetch failed|ECONN|timeout|aborted/i.test(t) ? 'o cofre da equipe não respondeu a tempo' : 'o cofre da equipe não abriu';
  if (/não respondeu|inacess|fetch failed|ECONN|ETIMEDOUT|timeout|aborted|respondeu \d{3}/i.test(t)) return 'a equipe não respondeu a tempo';
  return 'a equipe não ligou agora';
}

export interface EspacoMotores {
  /** bytes que a limpeza ainda pode liberar, quando o gerente informa (senão null) */
  liberavel: number | null;
  /** liberado: bytes de fato (null = o gerente não conseguiu medir) */
  ultima: { at: string; liberado: number | null; removidas: number } | null;
  /** cofres de contas que já não existem neste computador: só aqui a tela oferece apagar (com confirmação) */
  volumes: Array<{ nome: string; conta: string }>;
}
export interface MotorSaude {
  estado: MotorState; erro: string | null;
  /** o motor abriu, mas a versão dele não tem as Conexões */
  semConexoes: boolean;
  /** a renovação para esta versão não deu certo (o motor segue na anterior) */
  falha: string | null;
  /** a versão nova ainda não deu para pôr (o motor de antes segue aberto; o sistema tenta de novo sozinho) */
  adiada: string | null;
  versao: string;
}

/** "sha256:abc123…" ou "repo@sha256:abc…" ou "repo:tag" → um nome curto para a tela e o registro. */
export function imagemCurta(ref: string | null | undefined): string {
  if (!ref) return 'desconhecida';
  const d = /sha256:([a-f0-9]{12})/.exec(ref) ?? /^([a-f0-9]{12})[a-f0-9]{52}$/.exec(ref);
  if (d) return d[1];
  const tag = ref.slice(ref.lastIndexOf('/') + 1).split(':')[1];
  return clip(tag || ref, 40);
}

/**
 * Volumes que o gerente viu sem contêiner e que a tela pode oferecer para apagar: só cofres de pessoa (ergon_motor-<id>)
 * cujo id NÃO está na tabela de pessoas, e nunca o da pessoa que herdou o cofre de antes nem o próprio cofre de antes.
 * Cofre sem contêiner de pessoa que existe (reinstalação, motor recriado) nunca aparece: é o motor dela.
 */
export function filtrarOrfaos(db: Db, nomes: string[], semMarca: string[] = []): Array<{ nome: string; conta: string }> {
  const legacy = instanceSetting(db, 'motor_legacy_owner');
  let removidos: Record<string, string> = {};
  try { removidos = JSON.parse(instanceSetting(db, REMOVIDOS) ?? '{}') as Record<string, string>; } catch { /* registro ilegível: sem datas */ }
  const sem = new Set(semMarca);
  const out: Array<{ nome: string; conta: string }> = [];
  for (const nome of new Set(nomes)) {
    const m = VOLUME_PESSOA.exec(nome);
    if (!m) continue;
    const uid = `usr_${m[1]}`;
    if (uid === legacy || db.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) continue;
    const quando = removidos[m[1]];
    // sem a marca da instalação e sem registro de remoção aqui: não dá para dizer que foi uma conta deste Ergon
    // a tela prefixa "Cofre de": o rótulo começa em "uma conta…"
    out.push({ nome, conta: quando ? `uma conta removida em ${quando.slice(0, 10).split('-').reverse().join('/')}`
      : sem.has(nome) ? 'uma conta que não existe neste Ergon (pode ser de outra instalação, ou de antes de reinstalar)' : 'uma conta removida' });
  }
  return out;
}

export interface MotorDeps {
  cfg: Config; db: Db; vault: Vault; owners: WorkspaceOwners;
  /** o motor de antes (um motor só): usado quando não há gerente */
  legacy: MotorClients;
  /** testes: clientes por pessoa (sem rede) */
  clients?: (userId: string) => MotorClients;
  /** testes: no lugar do fetch (gerente e receptor do cofre) */
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Motors {
  readonly perPerson: boolean;
  private readonly d: MotorDeps;
  private readonly master: string;
  private readonly people = new Map<string, MotorClients & { ai: AiService }>();
  private readonly legacyAi: AiService;
  private readonly states = new Map<string, { state: MotorState; error: string | null; at: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly lastUse = new Map<string, number>();
  /** quando o motor abriu e se a chave foi entregue agora (fresh: processos de antes não existem) */
  private readonly abertura = new Map<string, { at: number; fresh: boolean }>();
  /** renovação a caminho: a imagem nova (id do gerente), desde quando */
  private readonly renovacao = new Map<string, { alvo: string | null; desde: number }>();
  /**
   * Renovação que voltou atrás nesta versão: não tenta de novo com o motor ligado, e nada promete que as Conexões
   * "voltam sozinhas". Gravada por pessoa e por versão (instance setting), para valer também depois de reiniciar o
   * servidor; lida na primeira consulta de cada pessoa.
   */
  private readonly falhas = new Map<string, FalhaRenovacao>();
  private readonly falhasLidas = new Set<string>();
  /** versão nova que ainda não deu para pôr (a imagem não chegou, ou o motor não parou): o de antes segue aberto, e o tick tenta de novo */
  private readonly adiadas = new Map<string, { motivo: 'sem-imagem' | 'nao-parou'; at: number; vezes: number }>();
  private readonly semConexoes = new Set<string>();
  private readonly lastProbe = new Map<string, number>();
  private readonly lastRenew = new Map<string, number>();
  private ticking = false;
  private limpando = false;
  /** o gerente não tem a limpeza (versão de antes): não pergunta de novo até reiniciar */
  private semLimpeza = false;
  /** a última estimativa do espaço que a limpeza liberaria (a cada 6 h, e logo depois de uma limpeza) */
  private ultimaEstimativa = 0;
  private semEstimativa = false;
  /** mudou o estado de um motor (a tela recarrega; app.ts publica o evento e tenta a limpeza) */
  onChange: ((userId: string, state: MotorState) => void) | null = null;

  constructor(d: MotorDeps) {
    this.d = d;
    this.master = d.cfg.bridgeToken ?? '';
    this.perPerson = !!d.cfg.motorManagerUrl && !!d.cfg.bridgeToken && d.cfg.mode === 'local';
    this.legacyAi = new AiService(d.cfg, d.legacy.hermes, d.legacy.control);
    setMotorScope((ws) => this.scope(ws));
    // depois de uma renovação que voltou atrás, as Conexões que faltam no motor só voltam com a próxima versão (characters.ts)
    setRenovacaoFalhou((scope) => this.perPerson && scope !== '_' && !!this.falha(scope));
  }

  /** De qual motor é o workspace: a pessoa dona dele (um motor por pessoa) ou "_" (um motor só). */
  scope(workspaceId: string | null | undefined): string {
    if (!this.perPerson || !workspaceId) return '_';
    return this.d.owners.of(workspaceId) ?? '_';
  }
  private forUser(userId: string): MotorClients & { ai: AiService } {
    let m = this.people.get(userId);
    if (!m) {
      const name = motorName(userId);
      const c = this.d.clients?.(userId) ?? {
        hermes: new HttpHermesClient(`http://${name}:8642`, motorSecret(this.master, 'api', userId)),
        control: new HttpHermesControl(`http://${name}:8643`, motorSecret(this.master, 'bridge', userId)),
      };
      m = { ...c, ai: new AiService(this.d.cfg, c.hermes, c.control, userId) };
      this.people.set(userId, m);
    }
    return m;
  }
  private of(workspaceId: string): (MotorClients & { ai: AiService }) | null {
    const s = this.scope(workspaceId);
    return s === '_' ? (this.perPerson ? null : { ...this.d.legacy, ai: this.legacyAi }) : this.forUser(s);
  }
  hermes(workspaceId: string): HermesClient | null { return this.of(workspaceId)?.hermes ?? null; }
  control(workspaceId: string): HermesControlClient | null { return this.of(workspaceId)?.control ?? null; }
  /** Configuração de IA (contas, modelo padrão, ferramentas) do motor do workspace. */
  ai(workspaceId: string): AiService { return this.of(workspaceId)?.ai ?? this.legacyAi; }
  /** Os motores que estão abertos agora (para atualizar ferramentas e modelo em segundo plano). */
  openAis(): AiService[] {
    if (!this.perPerson) return [this.legacyAi];
    return [...this.states].filter(([, s]) => s.state === 'aberto').map(([u]) => this.forUser(u).ai);
  }

  /** Quem está chamando a ponte: a pessoa dona do motor, "_" (um motor só, token da instalação) ou null. */
  identify(token: unknown): string | null {
    if (typeof token !== 'string' || !this.master) return null;
    if (!this.perPerson) return safeEqual(token, this.master) ? '_' : null;
    for (const { id } of this.d.db.all<{ id: string }>('SELECT id FROM users')) if (safeEqual(token, motorSecret(this.master, 'bridge', id))) return id;
    return null;
  }
  /** O motor pode agir sobre este workspace? (o da própria pessoa; com um motor só, qualquer um) */
  allows(motor: string, workspaceId: string): boolean {
    return motor === '_' ? !this.perPerson : this.d.owners.of(workspaceId) === motor;
  }

  state(userId: string): { state: MotorState; error: string | null } {
    if (!this.perPerson) return { state: 'aberto', error: null };
    const s = this.states.get(userId);
    return { state: s?.state ?? 'desligado', error: s?.error ?? null };
  }
  states_(): Array<{ userId: string; state: MotorState; error: string | null }> {
    return [...this.states].map(([userId, s]) => ({ userId, state: s.state, error: s.error }));
  }
  /** Para a Saúde: o estado do motor da pessoa, a renovação e o que falta nele. */
  saude(userId: string): MotorSaude {
    const st = this.state(userId);
    const a = this.adiadas.get(userId);
    return {
      estado: st.state, erro: st.error, semConexoes: this.semConexoes.has(this.perPerson ? userId : '_'), falha: this.perPerson && this.falha(userId) ? motivoParaTela(this.falha(userId)!.motivo) : null, versao: VERSION,
      adiada: a ? (a.motivo === 'sem-imagem' ? 'a versão nova da equipe ainda não chegou a este computador (sem internet, ou o download não terminou)' : 'a equipe não parou a tempo para a troca') : null,
    };
  }
  /** A renovação desta versão voltou atrás para a pessoa? (a gravada de outra versão não vale e sai do banco) */
  private falha(userId: string): FalhaRenovacao | undefined {
    if (!this.falhasLidas.has(userId)) {
      let raw: string | null;
      try { raw = instanceSetting(this.d.db, falhaKey(userId)); } catch { return this.falhas.get(userId); } // banco fechado: lê depois
      this.falhasLidas.add(userId);
      if (raw) {
        let j: Record<string, unknown> | null = null;
        try { j = JSON.parse(raw) as Record<string, unknown>; } catch { /* registro ilegível: sai */ }
        if (j && j.versao === VERSION && typeof j.motivo === 'string') {
          this.falhas.set(userId, { motivo: j.motivo, vezes: Math.max(1, Number(j.vezes) || 1), at: Date.parse(String(j.at)) || Date.now(), voltou: j.voltou !== false, alvo: typeof j.alvo === 'string' ? j.alvo : null });
        } else this.apagarFalhaGravada(userId);
      }
    }
    return this.falhas.get(userId);
  }
  private registrarFalha(userId: string, f: FalhaRenovacao): void {
    this.falhas.set(userId, f); this.falhasLidas.add(userId);
    try { setInstanceSetting(this.d.db, falhaKey(userId), JSON.stringify({ versao: VERSION, motivo: f.motivo, vezes: f.vezes, at: new Date(f.at).toISOString(), voltou: f.voltou, alvo: f.alvo })); } catch { /* fica na memória */ }
  }
  private esquecerFalha(userId: string): void {
    this.falhas.delete(userId); this.falhasLidas.add(userId);
    this.apagarFalhaGravada(userId);
  }
  private apagarFalhaGravada(userId: string): void {
    try { this.d.db.run('DELETE FROM instance_settings WHERE key = ?', falhaKey(userId)); } catch { /* sai na próxima */ }
  }
  /** Depois de quanto tempo tentar de novo a atualização adiada: 2, 4, 8… minutos, até 1 hora. */
  private static esperaAdiada(vezes: number): number { return Math.min(60, 2 ** Math.max(1, vezes)) * 60_000; }
  private set(userId: string, state: MotorState, tecnico: string | null = null): void {
    const prev = this.states.get(userId)?.state;
    // o erro vai para a tela (Saúde, Contas de IA, o pedido na fila): em português; o técnico fica no registro
    const error = tecnico === null ? null : motivoParaTela(tecnico);
    if (tecnico !== null && error !== tecnico) log.warn({ motor: motorName(userId), estado: state, erro: scrub(tecnico, 300) }, 'motor: erro técnico');
    this.states.set(userId, { state, error, at: Date.now() });
    if (prev !== state) { try { this.onChange?.(userId, state); } catch { /* aviso de apoio */ } }
  }
  touch(workspaceId: string): void { const s = this.scope(workspaceId); if (s !== '_') this.lastUse.set(s, Date.now()); }

  /** O motor do workspace recebe trabalho novo agora? Sem efeito colateral (falso ligando, renovando, com erro ou desligado). */
  accepting(workspaceId: string): boolean {
    if (!this.perPerson) return true;
    const u = this.scope(workspaceId);
    return u !== '_' && this.state(u).state === 'aberto';
  }
  /** Por que o pedido espera (fica no pedido enquanto ele está na fila). */
  waitText(workspaceId: string): string {
    const st = this.state(this.scope(workspaceId));
    if (st.state === 'renovando') return 'aguardando a equipe (atualizando para a versão nova; o pedido segue sozinho quando terminar)';
    if (st.state === 'erro') return clip(`aguardando a equipe (não ligou: ${scrub(motivoParaTela(st.error), 160)}; o sistema tenta de novo sozinho)`, 300);
    return 'aguardando a equipe (ligando)';
  }

  /** Pronto para trabalhar? Se não, já manda ligar (sem esperar). Usado pela fila, a cada passo. */
  ready(workspaceId: string): boolean {
    if (!this.perPerson) return true;
    const u = this.scope(workspaceId);
    if (u === '_') return false;
    this.touch(workspaceId);
    const s = this.states.get(u);
    if (s?.state === 'aberto') return true;
    // renovando: quem decide a hora é o fim do trabalho no motor (confere a cada 15 s, e o relógio de 60 s do app)
    if (s?.state === 'renovando') { this.renovarSeLivre(u); return false; }
    // depois de um erro (ex.: a primeira criação passou do tempo), tenta de novo a cada 15 s, não a cada consulta
    if (s?.state === 'erro' && Date.now() - s.at < 15_000) return false;
    void this.ensure(u).catch(() => undefined);
    return false;
  }

  /** A API do motor falhou (ex.: 503 ao começar um pedido): confere se ele reiniciou com o cofre fechado. */
  trouble(workspaceId: string): void {
    const u = this.scope(workspaceId);
    if (this.perPerson && u !== '_' && this.state(u).state === 'aberto') void this.conferirSelado(u).catch(() => undefined);
  }

  /**
   * Passo de 60 s (app.ts): renova quem está "renovando" e ficou livre; e um motor "aberto" cuja API não responde e
   * cujo cofre diz "fechado" (o contêiner foi recriado ou reiniciado por fora) volta a "ligando" e recebe a chave de
   * novo, sem reiniciar o servidor.
   */
  async tick(): Promise<void> {
    if (!this.perPerson || this.ticking) return;
    this.ticking = true;
    try {
      // quanto a limpeza liberaria agora (o botão "Liberar espaço (X GB)" mostra o número do cache, sem esperar)
      if (Date.now() - this.ultimaEstimativa >= 6 * 3_600_000) await this.estimarEspaco().catch(() => undefined);
      for (const [userId, s] of [...this.states]) {
        if (s.state === 'renovando') this.renovarSeLivre(userId, true);
        else if (s.state === 'aberto') {
          await this.conferirSelado(userId, true).catch(() => undefined);
          // a versão nova não deu para pôr antes: tenta de novo, com intervalo crescente, quando o motor estiver livre
          const a = this.adiadas.get(userId);
          if (a && this.state(userId).state === 'aberto' && Date.now() - a.at >= Motors.esperaAdiada(a.vezes) && !this.pending.has(userId) && this.idle(userId)) {
            void this.ensure(userId).catch(() => undefined);
          }
        }
      }
    } finally { this.ticking = false; }
  }

  /** Nenhuma execução da pessoa está no motor agora (running/waiting_user já enviadas): dá para recriar o contêiner. */
  idle(userId: string): boolean {
    return !this.d.db.get(`SELECT 1 AS x FROM runs r JOIN memberships m ON m.workspace_id = r.workspace_id AND m.role = 'owner'
      WHERE m.user_id = ? AND r.status IN ('running', 'waiting_user') AND r.hermes_run_id IS NOT NULL LIMIT 1`, userId);
  }
  private renovarSeLivre(userId: string, now = false): void {
    if (this.pending.has(userId) || !this.d.vault.personOpen(userId)) return;
    if (!now && Date.now() - (this.lastRenew.get(userId) ?? 0) < 15_000) return;
    this.lastRenew.set(userId, Date.now());
    if (this.idle(userId)) void this.ensure(userId).catch(() => undefined);
  }
  private async conferirSelado(userId: string, now = false): Promise<void> {
    if (this.pending.has(userId)) return;
    if (!now && Date.now() - (this.lastProbe.get(userId) ?? 0) < 15_000) return;
    this.lastProbe.set(userId, Date.now());
    const ok = await this.forUser(userId).hermes?.health().then((x) => x.ok).catch(() => false);
    if (ok) return;
    const st = await this.call(`http://${motorName(userId)}:8644/status`, { headers: this.vaultHeaders(userId), timeoutMs: 3000 })
      .then((r) => r.json() as Promise<{ sealed?: boolean }>).catch(() => null);
    if (st?.sealed !== true || this.state(userId).state !== 'aberto') return;
    this.set(userId, 'ligando', 'a equipe reiniciou: abrindo o cofre de novo');
    void this.ensure(userId).catch(() => undefined);
  }

  private call(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const f = this.d.fetch ?? fetch;
    return f(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  }
  private async manager(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await this.call(`${this.d.cfg.motorManagerUrl}${path}`, {
      method, headers: { 'X-Ergon-Manager-Token': this.master, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 120_000,
    }).catch((e: unknown) => {
      // a resposta não veio a tempo, mas o gerente segue o trabalho (a troca do motor pode ter acontecido): dito em português
      if ((e as { name?: string })?.name === 'TimeoutError' || /aborted due to timeout/i.test(String((e as Error)?.message ?? ''))) throw Object.assign(new Error(TEMPO_DO_GERENTE), { tempo: true });
      throw e;
    });
    const j = await r.json().catch(() => ({})) as Record<string, unknown>;
    // o motivo do gerente é técnico: set() e motivoParaTela() traduzem antes da tela; o código fica no registro
    if (!r.ok) {
      if (j.error === undefined) log.warn({ caminho: path.split('/').slice(0, 3).join('/'), status: r.status }, 'gerente de motores: resposta sem motivo');
      throw Object.assign(new Error(String(j.error ?? 'a equipe não respondeu como esperado')), { status: r.status });
    }
    return j;
  }
  private vaultHeaders(userId: string): Record<string, string> {
    return { 'X-Ergon-Bridge-Token': motorSecret(this.master, 'bridge', userId), 'Content-Type': 'application/json' };
  }

  /**
   * Liga o motor da pessoa (cria na primeira vez) e abre o cofre dele com a chave derivada da chave pessoal. A pessoa
   * precisa estar com a parte aberta. A primeira conta herda o motor de antes (o mesmo cofre): a senha do cofre troca
   * da chave da instalação para a dela, uma vez. Versão nova do motor: renova (ver o comentário do arquivo).
   */
  ensure(userId: string): Promise<void> {
    if (!this.perPerson) return Promise.resolve();
    const running = this.pending.get(userId);
    if (running) return running;
    const p = this.doEnsure(userId).finally(() => this.pending.delete(userId));
    this.pending.set(userId, p);
    return p;
  }
  private adoptLegacy(userId: string): boolean {
    const legacyOwner = instanceSetting(this.d.db, 'motor_legacy_owner');
    return isAdmin(this.d.db, userId) && (!legacyOwner || legacyOwner === userId);
  }
  private async doEnsure(userId: string): Promise<void> {
    const { db, vault } = this.d;
    if (!vault.personOpen(userId)) { this.set(userId, 'desligado', 'a parte da pessoa está fechada'); return; }
    if (this.state(userId).state !== 'renovando') this.set(userId, 'ligando');
    try {
      const legacyOwner = instanceSetting(db, 'motor_legacy_owner');
      let falhou = this.falha(userId);
      // depois de uma renovação que voltou atrás, o motor ligado fica como está (nada de recriar de novo em seguida)
      const idle = !falhou && this.idle(userId);
      const r = await this.manager('POST', `/v1/motors/${userId}/ensure`, { adoptLegacy: this.adoptLegacy(userId), idle, start: true }) as EnsureResp;
      if (r.adopted && legacyOwner !== userId) setInstanceSetting(db, 'motor_legacy_owner', userId);
      // a trava do gerente (rótulo no contêiner) e a falha gravada aqui contam a mesma história: travado na versão anterior
      // sem a falha gravada (banco de antes desta marca) é falha; a trava que saiu (a imagem configurada mudou) apaga a falha
      if (r.held === true && !falhou) { falhou = { motivo: FALHA_SEM_MOTIVO, vezes: 1, at: Date.now(), voltou: true, alvo: null }; this.registrarFalha(userId, falhou); }
      else if (r.held === false && falhou?.voltou) { this.esquecerFalha(userId); falhou = undefined; }
      // gerente de antes, sem o motivo: com o motor livre, "não renovou" é que não deu agora (não que está ocupado)
      const ocupado = r.motivo ? r.motivo === 'ocupado' : !idle;
      if (r.stale === true && r.recreated !== true && !falhou && ocupado) {
        // versão nova, motor trabalhando: os pedidos novos esperam; quando o trabalho dele terminar, renova (tick/ready)
        this.renovacao.set(userId, { alvo: r.image ?? null, desde: this.renovacao.get(userId)?.desde ?? Date.now() });
        this.set(userId, 'renovando');
        return;
      }
      if (r.stale === true && r.recreated !== true && !falhou) {
        // não renovou agora e não renova sozinho já (a imagem nova não chegou a este computador, ou o motor não parou): o
        // motor de antes segue ligado — abre ele, a Saúde diz que a atualização está pendente, e o tick tenta de novo depois
        const antes = this.adiadas.get(userId);
        this.adiadas.set(userId, { motivo: r.motivo === 'sem-imagem' ? 'sem-imagem' : 'nao-parou', at: Date.now(), vezes: (antes?.vezes ?? 0) + 1 });
        this.renovacao.delete(userId);
        const fresh = await this.openVault(userId);
        await this.aberto(userId, fresh, await this.info(userId));
        return;
      }
      if (r.stale !== true) this.adiadas.delete(userId);
      // a primeira vez que um contêiner recriado liga (agora, recriado antes com a parte fechada, ou numa resposta que se
      // perdeu no caminho) é conferida, e pode voltar atrás. Sem laço: o gerente tira a marca da imagem anterior ao voltar
      // e trava a versão recusada (hold)
      const naoConferido = !!r.prevImage && instanceSetting(db, confirmado(userId)) !== String(r.image ?? '');
      const recriadoFechado = !!r.image && instanceSetting(db, recriado(userId)) === String(r.image);
      if ((r.recreated === true && (falhou?.vezes ?? 0) < 2) || (r.recreated !== true && !falhou && (naoConferido || recriadoFechado))) {
        await this.renovado(userId, r, true);
        return;
      }
      const fresh = await this.openVault(userId);
      await this.aberto(userId, fresh, await this.info(userId));
    } catch (e) {
      if (estourou(e)) {
        // a resposta do gerente não veio a tempo, mas ele segue o trabalho (a troca pode ter acontecido): fica "renovando",
        // e o próximo pedido recebe o resultado (o gerente faz uma operação por pessoa de cada vez)
        this.renovacao.set(userId, { alvo: null, desde: this.renovacao.get(userId)?.desde ?? Date.now() });
        this.set(userId, 'renovando', TEMPO_DO_GERENTE);
        return;
      }
      this.set(userId, 'erro', (e as Error).message.slice(0, 300));
      throw e;
    }
  }

  /** Contêiner recriado na versão nova: chave de novo, saúde, capacidades, confirmação. No prazo, ou volta atrás. */
  private async renovado(userId: string, r: EnsureResp, podeVoltar: boolean): Promise<void> {
    const deadline = Date.now() + this.d.cfg.motorRenewMinutes * 60_000;
    // só a especificação mudou (mesma imagem; ex.: desenvolvimento): falta das Conexões é aviso, não motivo para voltar
    const mesma = !!r.image && r.image === r.prevImage;
    this.renovacao.set(userId, { alvo: r.image ?? null, desde: this.renovacao.get(userId)?.desde ?? Date.now() });
    this.set(userId, 'renovando');
    try {
      const fresh = await this.openVault(userId, deadline);
      const info = await this.esperarSaude(userId, deadline);
      if (podeVoltar && info?.capacidades && !info.capacidades.includes(CAPACIDADE_CONEXOES) && !mesma) throw new Error('a versão nova da equipe veio sem as Conexões');
      // confirmar: o gerente apaga a imagem anterior (a que está em uso fica); sem resposta, ela só ocupa espaço
      await this.manager('POST', `/v1/motors/${userId}/confirm`, { pendentes: this.pendentes().filter((u) => u !== userId) }).catch(() => undefined);
      setInstanceSetting(this.d.db, confirmado(userId), String(r.image ?? ''));
      this.d.db.run('DELETE FROM instance_settings WHERE key = ?', recriado(userId));
      this.renovacao.delete(userId); this.esquecerFalha(userId);
      await this.aberto(userId, fresh, info);
      // a Atividade mostra a ação, o resultado e a evidência como estão: sem as peças por dentro (o identificador curto do
      // pacote da versão fica, para quem investiga)
      this.auditar(userId, 'equipe.atualizada', `equipe atualizada para a versão ${VERSION}`,
        { versao: VERSION, pacote: imagemCurta(r.image), pacoteAnterior: imagemCurta(r.prevImage), conexoes: info?.pluginVersion ?? null, cofre: info?.vaultConfig ?? null });
    } catch (e) {
      const tecnico = scrub((e as Error).message, 160);
      const motivo = motivoParaTela(tecnico);
      if (motivo !== tecnico) log.warn({ motor: motorName(userId), erro: tecnico }, 'motor: a renovação não deu certo');
      const vezes = (this.falha(userId)?.vezes ?? 0) + 1;
      this.renovacao.delete(userId);
      this.d.db.run('DELETE FROM instance_settings WHERE key = ?', recriado(userId));
      let voltou = false;
      if (podeVoltar && r.prevImage && !mesma) { try { await this.manager('POST', `/v1/motors/${userId}/rollback`, { start: true }); voltou = true; } catch { /* a imagem anterior já não existe */ } }
      this.registrarFalha(userId, { motivo, vezes, at: Date.now(), voltou, alvo: r.image ?? null });
      this.auditar(userId, 'equipe.atualizacao_falhou', `a atualização da equipe para a versão ${VERSION} não deu certo (${motivo}); ${voltou ? 'a equipe voltou para a versão anterior' : 'a versão anterior não estava disponível'}`,
        { versao: VERSION, pacote: imagemCurta(r.image), pacoteAnterior: imagemCurta(r.prevImage), voltou, vezes });
      const texto = `A atualização da equipe para a versão ${VERSION} não deu certo (${motivo}).`;
      if (!voltou) { this.set(userId, 'erro', `${texto} O sistema tenta de novo daqui a pouco.`); return; }
      // o motor de antes, com o mesmo cofre: abre agora (sem pedir ao gerente de novo, para não recriar em laço)
      try {
        const fresh = await this.openVault(userId, Date.now() + this.d.cfg.motorRenewMinutes * 60_000);
        await this.aberto(userId, fresh, await this.info(userId));
      } catch (e2) {
        this.set(userId, 'erro', `${texto} A versão anterior também não abriu: ${motivoParaTela(scrub((e2 as Error).message, 120))}`);
      }
    }
  }

  /** O motor abriu: estado, ferramentas, Conexões ligadas por padrão, modelo. */
  private async aberto(userId: string, fresh: boolean, info: MotorInfo | null): Promise<void> {
    if (info?.capacidades && !info.capacidades.includes(CAPACIDADE_CONEXOES)) this.semConexoes.add(userId);
    else if (info?.capacidades) this.semConexoes.delete(userId);
    this.abertura.set(userId, { at: Date.now(), fresh });
    this.lastUse.set(userId, Date.now());
    this.set(userId, 'aberto');
    const ai = this.forUser(userId).ai;
    void ai.defaultModel().catch(() => null);
    await ai.refreshToolsets();
    // ausente = ligado: as Conexões ligam sozinhas, a menos que a pessoa as tenha desligado
    try {
      const mudou = await ai.ensureConexoes(this.conexoesDesligadas(userId));
      if (mudou === 'ligou') this.auditar(userId, 'ai.tools', 'Conexões ligadas para a equipe (padrão: ligadas, a menos que você desligue)', { add: 'ergon_conexoes' });
      if (mudou === 'desligou') this.auditar(userId, 'ai.tools', 'Conexões desligadas para a equipe, como você escolheu em Configurações › Ferramentas', { remove: 'ergon_conexoes' });
      if (mudou) await ai.refreshToolsets();
    } catch { /* fica para a próxima abertura */ }
  }
  /** A pessoa desligou as Conexões da equipe (Configurações › Ferramentas): gravado por workspace dela. */
  private conexoesDesligadas(userId: string): boolean {
    return this.d.owners.owned(userId).some((ws) => this.d.db.get<{ value: string }>("SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = 'ferramentas.contas'", ws)?.value === 'desligado');
  }
  private async info(userId: string): Promise<MotorInfo | null> {
    const c = this.forUser(userId).control;
    if (!c?.info) return null;
    try { const i = await c.info(); return i.ok ? i : null; } catch { return null; }
  }
  /** Depois de recriar: a API e a ponte de controle respondem? (até o prazo) */
  private async esperarSaude(userId: string, deadline: number): Promise<MotorInfo | null> {
    const m = this.forUser(userId);
    for (;;) {
      const api = (await m.hermes?.health().then((x) => x.ok).catch(() => false)) ?? true;
      let info: MotorInfo | null = null; let ctl = !m.control;
      if (m.control?.info) { info = await m.control.info().catch(() => null); ctl = !!info?.ok; }
      else if (m.control) ctl = await m.control.health().catch(() => false);
      if (api && ctl) return info;
      // o motivo vai para a Saúde e a Atividade (o técnico, para o registro)
      if (Date.now() >= deadline) {
        log.warn({ motor: motorName(userId), api, controle: ctl }, 'motor: sem resposta depois de recriar');
        throw new Error(api ? 'a versão nova da equipe não respondeu por inteiro a tempo' : 'a versão nova da equipe não respondeu depois de abrir o cofre');
      }
      await sleep(2000);
    }
  }
  private auditar(userId: string, action: string, result: string, evidence: Record<string, unknown>): void {
    const ws = this.d.owners.owned(userId)[0];
    if (!ws) return;
    try { audit(this.d.db, null, { workspaceId: ws, actorType: 'system', actorId: 'ergon', action, targetType: 'equipe', targetId: userId, evidence, result }); } catch { /* parte fechada: sem registro */ }
  }

  /** Entrega a chave (e troca a senha do cofre herdado, uma vez). Devolve se a chave foi entregue agora (motor recém-ligado). */
  private async openVault(userId: string, deadline?: number): Promise<boolean> {
    const db = this.d.db;
    const rekey = instanceSetting(db, 'motor_legacy_owner') === userId && !instanceSetting(db, 'motor_legacy_rekeyed');
    const fresh = await this.unlockVault(userId, rekey ? this.d.vault.hermesKey() : undefined, deadline);
    if (rekey) setInstanceSetting(db, 'motor_legacy_rekeyed', new Date().toISOString());
    return fresh;
  }
  /** O receptor do cofre sobe junto com o contêiner: espera ele responder (até ~4 min: na primeira vez o cofre é criado) e entrega a chave. */
  private async unlockVault(userId: string, previous?: string, deadline?: number): Promise<boolean> {
    const base = `http://${motorName(userId)}:8644`;
    const h = this.vaultHeaders(userId);
    let last = 'o cofre da equipe não respondeu';
    for (let i = 0; i < 120 && (i === 0 || !deadline || Date.now() < deadline); i++) {
      try {
        const st = await this.call(`${base}/status`, { headers: h, timeoutMs: 3000 }).then((r) => r.json() as Promise<{ sealed?: boolean }>);
        if (!st.sealed) return false;
        const r = await this.call(`${base}/unlock`, { method: 'POST', headers: h, body: JSON.stringify({ key: this.d.vault.motorKey(userId), ...(previous ? { previous } : {}) }), timeoutMs: 30 * 60_000 });
        const j = await r.json().catch(() => ({})) as { error?: string };
        if (r.ok) return true;
        if (j.error === undefined) log.warn({ motor: motorName(userId), status: r.status }, 'cofre do motor: resposta sem motivo');
        throw new Error(j.error ?? 'o cofre da equipe não abriu');
      } catch (e) {
        // receptor ainda subindo (sem resposta) ou o motor já em execução (o receptor fecha depois de abrir)
        last = (e as Error).message;
        if (/não confere|inválid|falha ao montar|não consegui/.test(last)) throw e;
        if (i > 3 && /fetch failed|ECONNREFUSED|timeout|aborted/i.test(last)) {
          // depois de aberto o receptor some: confere se o motor já responde pela API
          const ok = await this.forUser(userId).hermes?.health().then((x) => x.ok).catch(() => false);
          if (ok) return false;
        }
      }
      await sleep(2000);
    }
    throw new Error(last);
  }

  /**
   * Na partida: quem está com a parte fechada e sem trabalho no motor tem o contêiner desatualizado recriado sem ligar
   * e sem chave (o gerente guarda o mesmo cofre). Quando a pessoa entrar, o motor já liga na versão nova.
   */
  async renewClosed(): Promise<number> {
    if (!this.perPerson) return 0;
    const list = await this.manager('GET', '/v1/motors') as { motors?: Array<{ uid?: unknown; stale?: unknown }> };
    let n = 0;
    for (const m of Array.isArray(list.motors) ? list.motors : []) {
      const uid = typeof m.uid === 'string' ? m.uid : '';
      if (m.stale !== true || !uid || this.pending.has(uid) || this.d.vault.personOpen(uid)) continue;
      if (!this.d.db.get('SELECT 1 AS x FROM users WHERE id = ?', uid) || !this.idle(uid)) continue;
      try {
        const r = await this.manager('POST', `/v1/motors/${uid}/ensure`, { adoptLegacy: this.adoptLegacy(uid), idle: true, start: false }) as EnsureResp;
        if (r.recreated === true) setInstanceSetting(this.d.db, recriado(uid), String(r.image ?? ''));
        n++;
      } catch { /* tenta quando a pessoa entrar */ }
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------------- espaço em disco
  private espacoCache(): { at?: string; liberado?: number | null; removidas?: number; avisos?: string[]; semMarca?: string[]; liberavel?: number | null } {
    try { return JSON.parse(instanceSetting(this.d.db, ESPACO) ?? '{}'); } catch { return {}; }
  }
  /** O que a Saúde mostra do espaço (só do cache: a tela nunca espera o gerente). */
  espaco(): EspacoMotores | null {
    if (!this.perPerson) return null;
    const c = this.espacoCache();
    return {
      liberavel: typeof c.liberavel === 'number' ? c.liberavel : null,
      ultima: c.at ? { at: c.at, liberado: typeof c.liberado === 'number' ? c.liberado : null, removidas: Number(c.removidas ?? 0) } : null,
      volumes: filtrarOrfaos(this.d.db, c.avisos ?? [], c.semMarca ?? []),
    };
  }
  /**
   * Limpeza pelo gerente: imagens antigas do Ergon que nenhum contêiner usa (nunca a atual nem a anterior de quem ainda
   * não confirmou). Volumes nunca saem por aqui: os que o gerente viu sem dono ficam guardados para a tela avisar.
   */
  async limpar(): Promise<{ liberado: number | null; removidas: number; volumes: Array<{ nome: string; conta: string }> }> {
    if (!this.perPerson) throw Object.assign(new Error('nesta instalação não há versões antigas da equipe para liberar'), { status: 404 });
    const users = this.d.db.all<{ id: string }>('SELECT id FROM users ORDER BY id').map((u) => u.id);
    const antes = this.espacoCache();
    // os cofres sem motor que o gerente vê; quem decide se são de conta que não existe mais é o Ergon (o banco)
    let vistos = antes.avisos ?? [];
    // sem a marca desta instalação (ou um gerente de antes, que não diz): a tela não afirma que foi uma conta deste Ergon
    let semMarca = antes.semMarca ?? [];
    try {
      const v = await this.manager('GET', '/v1/volumes') as { volumes?: Array<{ nome?: unknown; emUso?: unknown; herdado?: unknown; instalacao?: unknown }> };
      if (Array.isArray(v.volumes)) {
        // Docker compartilhado: o cofre com a marca de outra instalação nunca entra (o gerente novo nem lista)
        const livres = v.volumes.filter((x) => x.emUso !== true && x.herdado !== true && x.instalacao !== 'outra');
        vistos = livres.map((x) => String(x.nome ?? ''));
        semMarca = livres.filter((x) => x.instalacao !== 'nossa').map((x) => String(x.nome ?? ''));
      }
    } catch { /* gerente de antes, sem a lista: fica o que a última limpeza viu */ }
    const r = await this.manager('POST', '/v1/maintenance/clean', { users, pendentes: this.pendentes(users), volumesOrfaos: filtrarOrfaos(this.d.db, vistos).map((v) => v.nome) });
    const removidas = Array.isArray(r.removidas) ? r.removidas.length : 0;
    // null: o gerente não conseguiu medir (sem a conta do disco) — a tela não inventa um número
    const liberado = typeof r.liberado === 'number' && r.liberado >= 0 ? r.liberado : null;
    const avisos = (Array.isArray(r.avisos) ? r.avisos : []).map((a) => String((a as { volume?: unknown })?.volume ?? '')).filter((v) => /^[\w.-]{1,128}$/.test(v));
    // depois de limpar, o que ainda dá para liberar é outra conta: a próxima volta do relógio (tick) estima de novo
    setInstanceSetting(this.d.db, ESPACO, JSON.stringify({ at: new Date().toISOString(), liberado, removidas, avisos, semMarca: semMarca.filter((x) => avisos.includes(x)), liberavel: null }));
    this.ultimaEstimativa = 0;
    return { liberado, removidas, volumes: filtrarOrfaos(this.d.db, avisos, semMarca) };
  }
  /**
   * A conta da limpeza, sem apagar nada (rota própria do gerente: o de antes responde 404 e nada muda). O número vai para
   * o cache que a Saúde mostra no botão; sem medida (null), o botão aparece sem número.
   */
  async estimarEspaco(): Promise<number | null> {
    if (!this.perPerson || this.semEstimativa) return null;
    this.ultimaEstimativa = Date.now();
    const users = this.d.db.all<{ id: string }>('SELECT id FROM users ORDER BY id').map((u) => u.id);
    let r: Record<string, unknown>;
    try { r = await this.manager('POST', '/v1/maintenance/estimate', { users, pendentes: this.pendentes(users) }); } catch (e) {
      if ([404, 405].includes(Number((e as { status?: number }).status))) this.semEstimativa = true;
      throw e;
    }
    const liberavel = typeof r.liberavel === 'number' && r.liberavel >= 0 ? r.liberavel : null;
    setInstanceSetting(this.d.db, ESPACO, JSON.stringify({ ...this.espacoCache(), liberavel }));
    return liberavel;
  }
  /** Quem ainda não confirmou a versão do motor nesta execução: a imagem anterior dela fica (para poder voltar). */
  private pendentes(users = this.d.db.all<{ id: string }>('SELECT id FROM users ORDER BY id').map((u) => u.id)): string[] {
    return users.filter((u) => this.state(u).state !== 'aberto' || this.renovacao.has(u));
  }
  /** Uma vez por versão, quando todos os motores abertos já estão na versão confirmada. */
  async limparSePronto(): Promise<boolean> {
    if (!this.perPerson || this.limpando || this.semLimpeza || instanceSetting(this.d.db, LIMPEZA_VERSAO) === VERSION) return false;
    const abertos = this.d.vault.peopleInfo().filter((p) => p.open).map((p) => p.userId);
    if (!abertos.length || abertos.some((u) => this.state(u).state !== 'aberto' || this.renovacao.has(u))) return false;
    this.limpando = true;
    try {
      await this.limpar();
      setInstanceSetting(this.d.db, LIMPEZA_VERSAO, VERSION);
      return true;
    } catch (e) {
      if ([404, 405].includes(Number((e as { status?: number }).status))) this.semLimpeza = true;
      return false;
    } finally { this.limpando = false; }
  }
  /** Apaga o cofre de uma conta que já não existe (a tela pede confirmação; o servidor confere de novo aqui). */
  async apagarVolume(nome: string): Promise<{ conta: string }> {
    const c = this.espacoCache();
    const v = filtrarOrfaos(this.d.db, c.avisos ?? [], c.semMarca ?? []).find((x) => x.nome === nome);
    if (!v) throw Object.assign(new Error('este cofre não está na lista dos que podem ser apagados'), { status: 409 });
    try { await this.manager('DELETE', `/v1/volumes/${encodeURIComponent(nome)}`); } catch (e) {
      if (Number((e as { status?: number }).status) !== 404) throw e; // já não existia: sai da lista
    }
    setInstanceSetting(this.d.db, ESPACO, JSON.stringify({ ...c, avisos: (c.avisos ?? []).filter((x) => x !== nome) }));
    return { conta: v.conta };
  }

  /**
   * Desde quando pode haver programa rodando neste motor (Terminal e Executar código deixam processos em segundo plano):
   * desde que ele abriu com a chave entregue agora; sem saber (motor já estava aberto, ou um motor só), os últimos 7 dias.
   */
  codigoDesde(workspaceId: string): number {
    const a = this.perPerson ? this.abertura.get(this.scope(workspaceId)) : undefined;
    return a?.fresh ? a.at : Date.now() - 7 * 86_400_000;
  }

  async stop(userId: string): Promise<void> {
    if (!this.perPerson) return;
    await this.manager('POST', `/v1/motors/${userId}/stop`);
    this.abertura.delete(userId);
    this.set(userId, 'desligado');
  }
  /** Conta removida: o contêiner e o cofre dela saem (o cofre de antes, herdado, também). */
  async remove(userId: string): Promise<void> {
    if (!this.perPerson) return;
    // a data fica registrada: se o gerente não apagar o cofre agora, a Saúde mostra "conta removida em …"
    try {
      const r = JSON.parse(instanceSetting(this.d.db, REMOVIDOS) ?? '{}') as Record<string, string>;
      r[userId.slice(4)] = new Date().toISOString();
      setInstanceSetting(this.d.db, REMOVIDOS, JSON.stringify(Object.fromEntries(Object.entries(r).slice(-200))));
    } catch { /* registro de apoio */ }
    await this.manager('DELETE', `/v1/motors/${userId}`);
    this.states.delete(userId); this.people.delete(userId); this.lastUse.delete(userId); this.abertura.delete(userId);
    this.esquecerFalha(userId); this.adiadas.delete(userId); this.renovacao.delete(userId);
  }
  /** Desliga o motor de quem não usa há algum tempo (sem trabalho na fila); volta quando a pessoa precisar. */
  async stopIdle(now = Date.now()): Promise<string[]> {
    if (!this.perPerson) return [];
    const stopped: string[] = [];
    for (const [userId, s] of this.states) {
      if (s.state !== 'aberto') continue;
      if (now - (this.lastUse.get(userId) ?? s.at) < this.d.cfg.motorIdleMinutes * 60_000) continue;
      const busy = this.d.db.get(`SELECT 1 AS x FROM runs r JOIN memberships m ON m.workspace_id = r.workspace_id AND m.role = 'owner'
        WHERE m.user_id = ? AND r.status IN ('queued', 'running', 'waiting_user') LIMIT 1`, userId);
      if (busy) continue;
      try { await this.stop(userId); stopped.push(userId); } catch { /* tenta de novo na próxima volta */ }
    }
    return stopped;
  }
}
