/**
 * Rotinas no agendador do motor (rc.27). Cada rotina do Ergon com horário (as 24 da biblioteca e as criadas pela pessoa)
 * vira um job do agendador do Hermes no PERFIL do agente que a executa (ponte de controle, PUT /ergon/v1/rotinas/<id>,
 * idempotente): o agendador do motor é o relógio — o horário no fuso da pessoa, a recuperação do horário perdido, o pausar
 * e o rodar agora são dele. O job não chama modelo: o script dele só avisa o Ergon (POST /internal/bridge/v1/rotina/disparo,
 * pelo plugin), e o Ergon faz o resto como sempre (coleta, condição, trabalho do agente em /p/<perfil>/v1/runs, conferência
 * de evidência, "Com você"). Prova no motor de verdade: hermes/tests/test_ergon_bridge_rotinas.py.
 *
 * Por que não um job com agente (decisão 2: o caminho do motor até onde ele serve): num job com agente o Hermes nega toda
 * aprovação (não há ninguém para responder), não há acompanhamento ao vivo nem parar, a sessão não é a da conversa da
 * rotina, e a coleta das contas conectadas (cujas credenciais nunca saem do Ergon) teria de ir num script sem acesso a elas.
 *
 * O agendador do Ergon continua de reserva: rotina sem perfil pronto, motor sem a capacidade ou sem conta de IA, roda pelo
 * Ergon como antes. Com o job pronto, o Ergon NÃO dispara no horário; só se o aviso do motor não chegar em
 * ESPERA_DO_MOTOR_MS (o motor de uma pessoa é desligado depois de um tempo sem uso, e um motor desligado não dispara nada).
 * O mesmo horário tem a mesma chave de execução (schedule:<rotina>:<horário>) dos dois lados: nunca roda em dobro.
 *
 * Esta classe guarda, por rotina, o que foi mandado (routine_jobs) e mantém os jobs em dia: na mudança da rotina ou do
 * agente e numa volta periódica — que também faz a MIGRAÇÃO de quem vem da rc.26 (cada rotina ativa ganha o job). A volta
 * é idempotente e retomável: o que falhou fica pendente e tenta de novo; o que está em dia não é mandado de novo.
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { clip, now } from '../lib/util.ts';
import { log } from '../lib/log.ts';
import type { Bus } from './bus.ts';
import { CAPACIDADE_ROTINAS, HermesError, PERFIL_NOME, type HermesControlClient, type JobDaRotina, type PedidoDeRotina } from './hermes.ts';
import type { Trigger } from './routine-catalog.ts';

/** Depois do horário, quanto o Ergon espera o aviso do agendador do motor antes de rodar a rotina ele mesmo. */
export const ESPERA_DO_MOTOR_MS = 5 * 60_000;
/** Um job em dia é mandado de novo depois disto (a próxima execução volta atualizada; o horário de verão refaz a conta). */
const REVISAR_MS = 30 * 60_000;
/** quantas rotinas por motor a volta periódica manda de cada vez */
const POR_VOLTA = 20;
/** motor sem a capacidade (plugin de antes): não pergunta de novo antes disto */
const SEM_SUPORTE_MS = 10 * 60_000;

export type EstadoDoJob = 'pendente' | 'pronto' | 'falhou' | 'fora';
interface Linha {
  routine_id: string; workspace_id: string; profile: string | null; job_id: string | null; state: EstadoDoJob; fingerprint: string | null;
  next_run_at: string | null; last_fire_at: string | null; synced_at: string | null; tries: number; error: string | null; updated_at: string;
}
interface Rotina { id: string; workspace_id: string; name: string; status: string; trigger: string; config: string; template_key: string | null }
/** O que a rotina pede ao agendador: nada (sem horário, em preparo, arquivada) ou o job neste perfil. */
type Desejo = { job: false } | { job: true; perfil: string | null; pedido: Omit<PedidoDeRotina, 'perfil' | 'antes'> };

const resumo = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const parseJson = <T>(s: string | null, f: T): T => { try { return s ? JSON.parse(s) as T : f; } catch { return f; } };

export class RotinasNoMotor {
  private readonly db: Db; private readonly bus: Bus;
  /** a ponte de controle do motor do workspace (null = sem motor real) */
  control: (workspaceId: string) => HermesControlClient | null = () => null;
  /** de qual motor é o workspace (um por pessoa; '_' = um só): os envios a um motor vão em fila */
  scope: (workspaceId: string) => string = () => '_';
  /** o motor do workspace está ligado e recebendo? (sem isso, a volta não tenta) */
  pronto: (workspaceId: string) => boolean = () => true;
  /** o perfil pronto do agente no motor (perfis.ts), ou null */
  perfilDe: (workspaceId: string, agentId: string) => string | null = () => null;
  /** quem executa a rotina hoje (routines.ts, resolveAgent) */
  agenteDe: (r: Rotina) => { id: string } | null = () => null;
  private filas = new Map<string, Promise<unknown>>();
  private caps = new Map<string, { at: number; ok: boolean }>();
  private agendados = new Set<string>();

  constructor(db: Db, bus: Bus) { this.db = db; this.bus = bus; }

  private linha(routineId: string): Linha | undefined { return this.db.get<Linha>('SELECT * FROM routine_jobs WHERE routine_id = ?', routineId); }

  /** O horário desta rotina está com o agendador do motor (o Ergon só dispara se o aviso não chegar). */
  noMotor(routineId: string): boolean {
    const l = this.linha(routineId);
    return !!l && l.state === 'pronto' && !!l.job_id;
  }

  /** A próxima execução que o agendador do motor informou (null = o Ergon decide, como antes). */
  proxima(routineId: string): string | null {
    const l = this.linha(routineId);
    return l && l.state === 'pronto' && l.job_id ? l.next_run_at : null;
  }

  /** O aviso do horário chegou: anota e pede uma conferência logo (a próxima execução volta do motor). */
  disparou(routineId: string): void {
    this.db.run('UPDATE routine_jobs SET last_fire_at = ?, synced_at = NULL, updated_at = ? WHERE routine_id = ?', now(), now(), routineId);
    const l = this.linha(routineId);
    if (l) this.agendar(l.workspace_id);
  }

  /** O motor deste workspace tem o agendador das rotinas pelo plugin? (cache curto; motor de antes = não) */
  private async suporta(workspaceId: string, control: HermesControlClient): Promise<boolean> {
    if (!control.rotina || !control.removerRotina) return false;
    const sc = this.scope(workspaceId);
    const c = this.caps.get(sc);
    if (c && Date.now() - c.at < (c.ok ? 60_000 : SEM_SUPORTE_MS)) return c.ok;
    let ok = false;
    try { const info = await control.info?.(); ok = !!info?.ok && !!info.capacidades?.includes(CAPACIDADE_ROTINAS); } catch { ok = false; }
    this.caps.set(sc, { at: Date.now(), ok });
    return ok;
  }

  /** A rotina mudou (criada, editada, pausada, o agente mudou): manda logo, sem esperar a volta. */
  agendar(workspaceId: string): void {
    if (this.agendados.has(workspaceId)) return;
    this.agendados.add(workspaceId);
    const t = setTimeout(() => { this.agendados.delete(workspaceId); void this.emDia(workspaceId).catch(() => undefined); }, 500);
    t.unref?.();
  }

  private desejo(r: Rotina): Desejo {
    const t = parseJson<Trigger>(r.trigger, { kind: 'manual' });
    if (t.kind !== 'schedule' || !t.days.length || (r.status !== 'active' && r.status !== 'paused')) return { job: false };
    const ag = this.agenteDe(r);
    const perfil = ag ? this.perfilDe(r.workspace_id, ag.id) : null;
    return { job: true, perfil: perfil && PERFIL_NOME.test(perfil) ? perfil : null,
      pedido: { nome: clip(r.name, 80), dias: [...t.days].sort(), hora: t.time, fuso: t.tz, ligada: r.status === 'active' } };
  }

  /** As rotinas do workspace cujo job não está em dia. */
  atrasadas(workspaceId: string): Array<{ r: Rotina; d: Desejo; marca: string }> {
    const out: Array<{ r: Rotina; d: Desejo; marca: string }> = [];
    const agora = Date.now();
    const rotinas = this.db.all<Rotina>(`SELECT r.id, r.workspace_id, r.name, r.status, r.trigger, r.config, r.template_key FROM routines r
       WHERE r.workspace_id = ? AND (r.status != 'archived' OR EXISTS (SELECT 1 FROM routine_jobs j WHERE j.routine_id = r.id AND j.job_id IS NOT NULL))
       ORDER BY r.created_at, r.rowid`, workspaceId);
    for (const r of rotinas) {
      const d = this.desejo(r);
      const l = this.linha(r.id);
      const marca = resumo(JSON.stringify(d));
      if (!d.job || !d.perfil) {
        // nada no motor (ou ainda sem perfil): só há o que fazer se um job ficou para trás
        if (l?.job_id || (l && l.fingerprint !== marca)) out.push({ r, d, marca });
        else if (!l && d.job) out.push({ r, d, marca });
        continue;
      }
      const vencido = !l?.synced_at || agora - Date.parse(l.synced_at) > REVISAR_MS;
      if (l && l.state === 'pronto' && l.fingerprint === marca && !vencido) continue;
      out.push({ r, d, marca });
    }
    return out;
  }

  /** Manda ao motor os jobs atrasados do workspace (no máximo `limite`), um de cada vez por motor. Devolve quantos ficaram prontos. */
  async emDia(workspaceId: string, limite = POR_VOLTA): Promise<number> {
    const control = this.control(workspaceId);
    if (!control || !this.pronto(workspaceId)) return 0;
    if (!(await this.suporta(workspaceId, control))) return 0;
    const sc = this.scope(workspaceId);
    const fila = (this.filas.get(sc) ?? Promise.resolve()).then(async () => {
      let n = 0;
      for (const x of this.atrasadas(workspaceId).slice(0, limite)) {
        if (await this.mandar(x.r, x.d, x.marca, control) === 'pronto') n++;
      }
      return n;
    });
    this.filas.set(sc, fila.catch(() => undefined));
    return fila;
  }

  private gravar(r: Rotina, campos: Partial<Linha>): void {
    const l = this.linha(r.id);
    if (!l) {
      this.db.run("INSERT INTO routine_jobs (routine_id, workspace_id, state, tries, updated_at) VALUES (?, ?, 'pendente', 0, ?)", r.id, r.workspace_id, now());
    }
    const k = Object.keys(campos) as Array<keyof Linha>;
    if (!k.length) return;
    this.db.run(`UPDATE routine_jobs SET ${k.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE routine_id = ?`, ...k.map((c) => campos[c] ?? null), now(), r.id);
  }

  private async mandar(r: Rotina, d: Desejo, marca: string, control: HermesControlClient): Promise<EstadoDoJob> {
    const l = this.linha(r.id);
    try {
      if (!d.job || !d.perfil) {
        // sem horário, arquivada, em preparo, ou o agente ficou sem perfil: o job sai do motor e o Ergon volta a decidir
        if (l?.job_id && l.profile) await control.removerRotina!(r.id, l.profile);
        this.gravar(r, { state: d.job ? 'pendente' : 'fora', job_id: null, profile: null, next_run_at: null, fingerprint: marca, synced_at: now(), tries: 0, error: null });
        if (l?.job_id) this.bus.publish(r.workspace_id, 'routines.changed', { id: r.id });
        return d.job ? 'pendente' : 'fora';
      }
      const j: JobDaRotina = await control.rotina!(r.id, { ...d.pedido, perfil: d.perfil, antes: l?.profile && l.profile !== d.perfil ? l.profile : null });
      if (!j.jobId) throw new HermesError(502, 'o agendador não devolveu o job');
      const mudou = !l || l.state !== 'pronto' || l.next_run_at !== j.proxima || l.job_id !== j.jobId;
      this.gravar(r, { state: 'pronto', profile: d.perfil, job_id: j.jobId, next_run_at: d.pedido.ligada ? j.proxima : null, fingerprint: marca, synced_at: now(), tries: 0, error: null });
      if (mudou) this.bus.publish(r.workspace_id, 'routines.changed', { id: r.id });
      if (!l || l.state !== 'pronto') log.info({ routineId: r.id, perfil: d.perfil, job: j.jobId }, 'rotina: no agendador do motor');
      return 'pronto';
    } catch (err) {
      const msg = clip(err instanceof Error ? err.message : String(err), 300);
      // um job que já estava pronto continua valendo (o horário de antes) até a próxima tentativa dar certo; o que nunca
      // ficou pronto segue no agendador do Ergon
      this.db.run("INSERT OR IGNORE INTO routine_jobs (routine_id, workspace_id, state, tries, updated_at) VALUES (?, ?, 'falhou', 0, ?)", r.id, r.workspace_id, now());
      this.db.run(`UPDATE routine_jobs SET state = CASE WHEN state = 'pronto' AND job_id IS NOT NULL THEN 'pronto' ELSE 'falhou' END, fingerprint = NULL,
        tries = tries + 1, error = ?, updated_at = ? WHERE routine_id = ?`, msg, now(), r.id);
      return 'falhou';
    }
  }

  /** A volta periódica: os workspaces dados (os abertos), poucas rotinas por vez. */
  async volta(workspaceIds: string[]): Promise<number> {
    let n = 0;
    for (const ws of workspaceIds) {
      try { n += await this.emDia(ws); } catch { /* tenta de novo na próxima volta */ }
    }
    return n;
  }
}
