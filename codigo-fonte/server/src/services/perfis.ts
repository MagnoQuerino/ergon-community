/**
 * A equipe nativa (rc.27): cada agente do Ergon é um PERFIL do motor, um por workspace — identidade (SOUL), memória longa,
 * competências, conversas e configuração próprios. Provado no motor de verdade: o gateway atende
 * o perfil novo em /p/<perfil>/v1/runs sem reiniciar (gateway.multiplex_profiles, migração 4 do cofre) e o plugin do
 * Ergon vai junto (a trava de ferramentas vale ali). Prova: hermes/tests/test_ergon_bridge_perfis.py.
 *
 * O servidor decide o que o perfil tem (pedidoDoPerfil) e o plugin grava (ponte de controle, PUT /ergon/v1/perfis/<nome>,
 * idempotente). Esta classe guarda, por agente, o que foi mandado (agent_profiles: a marca do pedido e o resumo do SOUL)
 * e mantém os perfis em dia: na criação ou mudança do agente (evento agents.changed) e numa volta periódica, que também
 * faz a MIGRAÇÃO de quem vem da rc.26 (cada agente existente ganha o perfil, com as competências já treinadas). A volta
 * é idempotente e retomável: o que falhou fica pendente e tenta de novo depois; o que está em dia não é mandado de novo.
 *
 * Enquanto o perfil não está pronto (motor antigo, desligado, falhou), o agente trabalha no perfil padrão, como antes,
 * com as instruções inteiras. O Kanban do Hermes NÃO é o motor do quadro (a prova mostrou o trabalhador como processo de
 * linha de comando, fora de /v1/runs): o quadro do Ergon continua o motor e cada card roda no perfil do agente.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { log, scrub } from '../lib/log.ts';
import { clip, now } from '../lib/util.ts';
import type { Bus } from './bus.ts';
import { HermesError, PERFIL_NOME, type HermesControlClient, type PedidoDePerfil } from './hermes.ts';
import { TOOLS } from './characters.ts';
import { getSetting, setSetting } from './sectors.ts';
import { almaDoAgente } from './runs.ts';

/** O nome estável do perfil de um agente: derivado do workspace e do agente (nunca do nome do personagem, que muda). */
export function nomeDoPerfil(workspaceId: string, agentId: string): string {
  return `erg-${crypto.createHash('sha256').update(`ergon/perfil/${workspaceId}/${agentId}`).digest('hex').slice(0, 20)}`;
}
export const resumo = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Ajudantes temporários (subagentes do motor): ligados por padrão e com o máximo do próprio motor ao mesmo tempo (regra do
 * dono, 12/11: a experiência máxima de cara; cada ajudante é uma conversa a mais com a IA, e a pessoa reduz ou desliga em
 * Configurações para economizar). Ausente = ligado: só o desligado gravado pela pessoa desliga.
 */
export const AJUDANTES_SETTING = 'ajudantes.v1';
/** o teto e o padrão são os do motor (delegation.max_concurrent_children: 10; AJUDANTES_MAX no plugin, um teste confere) */
export const AJUDANTES_MAX = 10;
export const AJUDANTES_PADRAO = { ligado: true, max: AJUDANTES_MAX };
export const AJUDANTES_MIN = 1;
export interface Ajudantes { ligado: boolean; max: number }
export function ajudantesDo(db: Db, workspaceId: string): Ajudantes {
  try {
    const v = JSON.parse(getSetting(db, workspaceId, AJUDANTES_SETTING) ?? '{}') as Partial<Ajudantes>;
    const max = Number.isInteger(v.max) && v.max! >= AJUDANTES_MIN && v.max! <= AJUDANTES_MAX ? v.max! : AJUDANTES_PADRAO.max;
    return { ligado: v.ligado !== false, max };
  } catch { return { ...AJUDANTES_PADRAO }; }
}
export function gravarAjudantes(db: Db, workspaceId: string, a: Ajudantes): Ajudantes {
  const v = { ligado: a.ligado !== false, max: Math.min(AJUDANTES_MAX, Math.max(AJUDANTES_MIN, Math.round(a.max))) };
  setSetting(db, workspaceId, AJUDANTES_SETTING, JSON.stringify(v));
  return v;
}

/** Os conjuntos do motor que o perfil acrescenta aos do agente (o pre_tool_call os libera só nas execuções do perfil). */
export function extrasDoPerfil(db: Db, workspaceId: string): string[] {
  return ['memory', 'session_search', ...(ajudantesDo(db, workspaceId).ligado ? ['delegation'] : [])];
}

const parseList = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

/** Tudo o que é do agente e não do pedido: o SOUL, as ferramentas, a memória, a busca, os ajudantes, o modelo e as competências. */
export function pedidoDoPerfil(db: Db, workspaceId: string, agentId: string): PedidoDePerfil | null {
  const a = db.get<{ tools: string | null; hermes_skills: string | null; model: string | null; provider: string | null; status: string }>(
    'SELECT tools, hermes_skills, model, provider, status FROM agents WHERE id = ? AND workspace_id = ?', agentId, workspaceId);
  if (!a || a.status !== 'active') return null;
  const tools = parseList(a.tools);
  // as do Treinar (ativas e desativadas: o perfil guarda; quem barra o uso é a trava do Ergon) e as da biblioteca atribuídas
  const aprendidas = db.all<{ name: string }>("SELECT name FROM agent_skills WHERE agent_id = ? AND workspace_id = ? AND status <> 'removida'", agentId, workspaceId).map((s) => s.name);
  const biblioteca = tools.includes('habilidades') ? parseList(a.hermes_skills) : [];
  const aj = ajudantesDo(db, workspaceId);
  return {
    alma: almaDoAgente(db, workspaceId, agentId),
    // todos os conjuntos que o agente pode chegar a usar (Terminal e Executar código entram no perfil só quando a pessoa
    // liga para a equipe: o plugin cruza com o que está ligado no motor)
    ferramentas: [...new Set(tools.map((t) => TOOLS[t]).filter((t) => t && t.kind === 'ia' && t.toolset).map((t) => t!.toolset!))].sort(),
    memoria: true, busca: true,
    ajudantes: { ligado: aj.ligado, max: aj.max },
    modelo: a.model ? { provider: a.provider ?? '', model: a.model } : null,
    competencias: [...new Set([...aprendidas, ...biblioteca])].sort(),
  };
}

export type EstadoDoPerfil = 'pendente' | 'pronto' | 'falhou' | 'sem-suporte';
interface Linha { agent_id: string; workspace_id: string; profile: string; state: EstadoDoPerfil; fingerprint: string | null; alma_hash: string | null; synced_at: string | null; tries: number }

/** Depois de quanto tempo um perfil em dia é mandado de novo mesmo sem mudança (a configuração da equipe no motor muda). */
const REVISAR_MS = 6 * 3600_000;
/** quantos perfis por motor a volta periódica manda de cada vez */
const POR_VOLTA = 10;
/** motor sem os perfis (plugin de antes da rc.27): não pergunta de novo antes disto */
const SEM_SUPORTE_MS = 10 * 60_000;
/** o envio logo depois da mudança falhou: tenta de novo depois disto (e então fica para a volta de 60 s) */
const ESPERAS_RAPIDAS = [2_000, 5_000, 15_000];
/** quanto o pedido de um agente espera a última mudança dele chegar ao perfil antes de seguir (ver runs.ts, ondeComecar) */
export const PERFIL_ESPERA_MS = 20_000;

export class Perfis {
  private readonly db: Db; private readonly bus: Bus;
  /** a ponte de controle do motor do workspace (null = sem motor real) */
  control: (workspaceId: string) => HermesControlClient | null = () => null;
  /** de qual motor é o workspace (um por pessoa; '_' = um só): os envios a um motor vão em fila */
  scope: (workspaceId: string) => string = () => '_';
  /** o motor do workspace está ligado e recebendo? (sem isso, a volta não tenta) */
  pronto: (workspaceId: string) => boolean = () => true;
  private filas = new Map<string, Promise<unknown>>();
  private semSuporte = new Map<string, number>();
  private agendados = new Set<string>();
  /** workspace → quantas vezes seguidas o envio logo depois da mudança não deixou tudo em dia (para esperar mais um pouco) */
  private tentativas = new Map<string, number>();
  private apressados = new Set<string>();

  constructor(db: Db, bus: Bus) { this.db = db; this.bus = bus; }

  private linha(agentId: string): Linha | undefined {
    return this.db.get<Linha>('SELECT * FROM agent_profiles WHERE agent_id = ?', agentId);
  }

  /** O perfil do agente, se está pronto no motor: o nome e o SOUL que ele tem (para a execução não mandar de novo). */
  perfilPronto(workspaceId: string, agentId: string): { nome: string; almaHash: string } | null {
    const l = this.linha(agentId);
    if (!l || l.workspace_id !== workspaceId || l.state !== 'pronto' || !PERFIL_NOME.test(l.profile)) return null;
    return { nome: l.profile, almaHash: l.alma_hash ?? '' };
  }

  /** O motor não achou o perfil (o cofre foi recriado, por exemplo): volta a pendente e a próxima volta cria de novo. */
  sumiu(agentId: string): void {
    this.db.run("UPDATE agent_profiles SET state = 'pendente', fingerprint = NULL, updated_at = ? WHERE agent_id = ?", now(), agentId);
  }

  /**
   * O agente mudou (criado, editado, ferramentas, competências) ou o motor acabou de abrir: manda o perfil logo, sem esperar
   * a volta de 60 s. Antes (ensaio da rc.27), com o motor fechado, ligando ou renovando no momento da mudança, o envio
   * desistia calado e nada o repetia: o pedido seguinte (que religa o motor) rodava no perfil sem a mudança até a volta
   * pegar. Agora: motor sem receber → fica para quando ele abrir (motorAbriu); envio que falhou → tenta de novo em poucos
   * segundos (ESPERAS_RAPIDAS, depois a volta); muitos atrasados → segue de lote em lote até acabar.
   */
  agendar(workspaceId: string, ms = 500): void {
    if (this.agendados.has(workspaceId)) return;
    this.agendados.add(workspaceId);
    const t = setTimeout(() => { this.agendados.delete(workspaceId); void this.seguir(workspaceId).catch(() => undefined); }, ms);
    t.unref?.();
  }

  /** O motor do workspace abriu (ligou, renovou, voltou de um erro): o que mudou enquanto ele estava fora vai agora. */
  motorAbriu(workspaceId: string): void { this.agendar(workspaceId, 0); }

  private async seguir(workspaceId: string): Promise<void> {
    // sem motor que receba agora: motorAbriu manda quando ele abrir (e a volta, de todo jeito)
    if (!this.control(workspaceId)?.perfil || !this.pronto(workspaceId)) return;
    if ((this.semSuporte.get(this.scope(workspaceId)) ?? 0) > Date.now()) return;
    const n = await this.emDia(workspaceId);
    const faltam = this.atrasados(workspaceId).length;
    if (!faltam) { this.tentativas.delete(workspaceId); return; }
    if (n >= POR_VOLTA) { this.agendar(workspaceId, 100); return; } // lote cheio: o próximo lote em seguida
    const k = this.tentativas.get(workspaceId) ?? 0;
    if (k >= ESPERAS_RAPIDAS.length) { this.tentativas.delete(workspaceId); return; } // fica para a volta de 60 s
    this.tentativas.set(workspaceId, k + 1);
    this.agendar(workspaceId, ESPERAS_RAPIDAS[k]);
  }

  /**
   * O perfil do agente está pronto E com o que o agente é agora (a última mudança já chegou ao motor)? O executor espera
   * isto antes de começar o pedido do agente no perfil dele.
   */
  emDiaCom(workspaceId: string, agentId: string): boolean {
    const l = this.linha(agentId);
    if (!l || l.workspace_id !== workspaceId || l.state !== 'pronto') return false;
    const pedido = pedidoDoPerfil(this.db, workspaceId, agentId);
    return !!pedido && l.fingerprint === resumo(JSON.stringify(pedido));
  }

  /** Um pedido do agente espera o perfil dele: manda só este perfil agora, na fila do motor (sem esperar os outros). */
  apressar(workspaceId: string, agentId: string): void {
    if (this.apressados.has(agentId)) return;
    const control = this.control(workspaceId);
    if (!control?.perfil || !this.pronto(workspaceId) || (this.semSuporte.get(this.scope(workspaceId)) ?? 0) > Date.now()) return;
    this.apressados.add(agentId);
    void this.naFila(workspaceId, async () => {
      const pedido = pedidoDoPerfil(this.db, workspaceId, agentId);
      if (!pedido) return null;
      const marca = resumo(JSON.stringify(pedido));
      const l = this.linha(agentId);
      if (l && l.state === 'pronto' && l.fingerprint === marca) return 'pronto';
      return this.mandar(workspaceId, agentId, pedido, marca, control);
    }).catch(() => undefined).finally(() => this.apressados.delete(agentId));
  }

  /** Os envios a um mesmo motor vão um de cada vez, na ordem. */
  private naFila<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const sc = this.scope(workspaceId);
    const fila = (this.filas.get(sc) ?? Promise.resolve()).then(fn);
    this.filas.set(sc, fila.catch(() => undefined));
    return fila;
  }

  /** Os agentes do workspace cujo perfil não está em dia (sem perfil, pendente, falhou, pedido mudou ou revisão vencida). */
  atrasados(workspaceId: string): Array<{ agentId: string; pedido: PedidoDePerfil; marca: string }> {
    const out: Array<{ agentId: string; pedido: PedidoDePerfil; marca: string }> = [];
    const agora = Date.now();
    for (const a of this.db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator DESC, created_at, rowid", workspaceId)) {
      const pedido = pedidoDoPerfil(this.db, workspaceId, a.id);
      if (!pedido) continue;
      const marca = resumo(JSON.stringify(pedido));
      const l = this.linha(a.id);
      const vencido = !l?.synced_at || agora - Date.parse(l.synced_at) > REVISAR_MS;
      if (l && l.state === 'pronto' && l.fingerprint === marca && !vencido) continue;
      out.push({ agentId: a.id, pedido, marca });
    }
    return out;
  }

  /** Manda ao motor os perfis atrasados do workspace (no máximo `limite`), um de cada vez por motor. */
  async emDia(workspaceId: string, limite = POR_VOLTA): Promise<number> {
    const control = this.control(workspaceId);
    if (!control?.perfil || !this.pronto(workspaceId)) return 0;
    if ((this.semSuporte.get(this.scope(workspaceId)) ?? 0) > Date.now()) return 0;
    return this.naFila(workspaceId, async () => {
      let n = 0;
      for (const x of this.atrasados(workspaceId).slice(0, limite)) {
        const ok = await this.mandar(workspaceId, x.agentId, x.pedido, x.marca, control);
        if (ok === 'sem-suporte') break;
        if (ok === 'pronto') n++;
      }
      return n;
    });
  }

  private async mandar(workspaceId: string, agentId: string, pedido: PedidoDePerfil, marca: string, control: HermesControlClient): Promise<EstadoDoPerfil> {
    const nome = nomeDoPerfil(workspaceId, agentId);
    const l = this.linha(agentId);
    if (!l) {
      this.db.run("INSERT INTO agent_profiles (agent_id, workspace_id, profile, state, tries, updated_at) VALUES (?, ?, ?, 'pendente', 0, ?)", agentId, workspaceId, nome, now());
    }
    try {
      const r = await control.perfil!(nome, pedido);
      this.db.run("UPDATE agent_profiles SET profile = ?, state = 'pronto', fingerprint = ?, alma_hash = ?, synced_at = ?, tries = 0, error = NULL, updated_at = ? WHERE agent_id = ?",
        nome, marca, resumo(pedido.alma), now(), now(), agentId);
      if (r.criado || !l || l.state !== 'pronto') this.bus.publish(workspaceId, 'agents.changed', { id: agentId });
      return 'pronto';
    } catch (err) {
      // plugin de antes da rc.27 (a rota não existe): o motor ainda não sabe perfis; o agente segue no perfil padrão
      if (err instanceof HermesError && err.status === 404) {
        if ((this.semSuporte.get(this.scope(workspaceId)) ?? 0) <= Date.now()) log.info({ workspaceId }, 'perfil do agente: a equipe de IA ainda não sabe perfis (versão de antes); o agente segue no perfil padrão');
        this.semSuporte.set(this.scope(workspaceId), Date.now() + SEM_SUPORTE_MS);
        this.db.run("UPDATE agent_profiles SET state = 'sem-suporte', updated_at = ? WHERE agent_id = ? AND state <> 'pronto'", now(), agentId);
        return 'sem-suporte';
      }
      const msg = clip(err instanceof Error ? err.message : String(err), 300);
      // antes o erro ficava só na linha do banco: o registro mostra quando o motor não recebeu a mudança do agente
      log.warn({ workspaceId, agentId, perfil: nome, status: err instanceof HermesError ? err.status : null, erro: scrub(msg, 200), tentativas: (l?.tries ?? 0) + 1 },
        'perfil do agente: o motor não recebeu a mudança (tenta de novo)');
      // um perfil que já estava pronto continua servindo (com o SOUL de antes) até a próxima tentativa dar certo
      this.db.run(`UPDATE agent_profiles SET state = CASE WHEN state = 'pronto' AND alma_hash = ? THEN 'pronto' ELSE 'falhou' END, fingerprint = NULL, tries = tries + 1, error = ?, updated_at = ? WHERE agent_id = ?`,
        resumo(pedido.alma), msg, now(), agentId);
      return 'falhou';
    }
  }

  /** A volta periódica: os workspaces dados (os abertos), poucos perfis por vez. Devolve quantos ficaram prontos. */
  async volta(workspaceIds: string[]): Promise<number> {
    let n = 0;
    for (const ws of workspaceIds) {
      try { n += await this.emDia(ws); } catch { /* tenta de novo na próxima volta */ }
    }
    return n;
  }

  /** Quantos agentes do workspace já trabalham no próprio perfil (para a Saúde e a tela da equipe). */
  situacao(workspaceId: string): { total: number; prontos: number } {
    const total = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", workspaceId)?.n ?? 0);
    const prontos = Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_profiles p JOIN agents a ON a.id = p.agent_id
      WHERE p.workspace_id = ? AND a.status = 'active' AND p.state = 'pronto'`, workspaceId)?.n ?? 0);
    return { total, prontos };
  }
}
