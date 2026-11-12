/**
 * Rotinas no agendador do motor (rc.27, services/rotinas-motor.ts). Com um motor falso que segue o contrato provado no Hermes
 * de verdade (hermes/tests/test_ergon_bridge_rotinas.py):
 * - cada rotina com horário vira um job no perfil do agente que a executa (dias, hora e fuso da pessoa; pausada = pausada no
 *   agendador); de novo não manda nada; mudou, manda; arquivada ou sem horário, o job sai;
 * - a tela mostra a próxima execução que o agendador informou;
 * - com o job pronto, o Ergon não dispara no horário: o aviso do motor dispara (POST /internal/bridge/v1/rotina/disparo) e o
 *   mesmo horário nunca roda em dobro (aviso repetido, reserva do Ergon depois do aviso); sem o aviso em 5 min (motor
 *   desligado), o Ergon roda o horário; o aviso atrasado demais vira "perdida", como antes;
 * - motor sem a capacidade, rotina sem perfil pronto: tudo pelo Ergon, como antes;
 * - migração de quem vem da rc.26 (banco no formato dela): as rotinas ganham o job aos poucos, retomável (a que falhou tenta
 *   de novo e, enquanto isso, roda pelo Ergon), idempotente.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HermesError, type HermesClient, type HermesControlClient, type JobDaRotina, type PedidoDePerfil, type PedidoDeRotina, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { nomeDoPerfil } from '../src/services/perfis.ts';
import { ESPERA_DO_MOTOR_MS } from '../src/services/rotinas-motor.ts';
import { previousOccurrence } from '../src/services/routine-time.ts';
import { harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

const PONTE = 'token-da-ponte-de-teste-rotinas-' + '0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  perfis = new Map<string, PedidoDePerfil>();
  jobs = new Map<string, { perfil: string; pedido: PedidoDeRotina; id: string }>();
  pedidos: Array<{ id: string; pedido: PedidoDeRotina }> = [];
  removidas: Array<{ id: string; perfil: string }> = [];
  capacidades = ['conexoes', 'perfis', 'rotinas'];
  falharRotina = 0;
  n = 0;
  async health() { return { ok: true, detail: 'falso' }; }
  async startRun(_p: StartRun) {
    const runId = `run_rotina${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sess_${runId}`, usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string): Promise<RemoteRun> { const r = this.runs.get(id); if (!r) throw new HermesError(404, 'x'); return r; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  /** a próxima execução que o agendador calcularia (no teste: amanhã, na hora pedida, em UTC) */
  static proxima(p: PedidoDeRotina): string { const [hh, mm] = p.hora.split(':').map(Number); const d = new Date(Date.now() + 86_400_000); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); }
  control(): HermesControlClient {
    const self = this;
    return {
      async health() { return true; },
      async info() { return { ok: true, pluginVersion: '0.6.0', vaultConfig: 9, capacidades: self.capacidades }; },
      async accounts() { return []; }, async startLogin() { throw new Error('x'); }, async pollLogin() { throw new Error('x'); },
      async cancelLogin() {}, async disconnect() {}, async modelInfo() { return { model: null, provider: null }; },
      async setDefaultModel() { return { ok: true, confirmMessage: null }; }, async skills() { return []; },
      async apiToolsets() { return { enabled: ['todo', 'web'], safe: [] }; }, async setApiToolsets(e: string[]) { return e; },
      async perfil(nome: string, pedido: PedidoDePerfil) { const criado = !self.perfis.has(nome); self.perfis.set(nome, pedido); return { criado, mudou: criado ? ['criado'] : [] }; },
      async rotina(id: string, pedido: PedidoDeRotina): Promise<JobDaRotina> {
        if (self.falharRotina > 0) { self.falharRotina--; throw new HermesError(503, 'a equipe de IA não respondeu agora'); }
        if (!self.perfis.has(pedido.perfil)) throw new HermesError(400, 'o perfil do agente ainda não existe no motor');
        self.pedidos.push({ id, pedido });
        const j = self.jobs.get(id) ?? { perfil: pedido.perfil, pedido, id: `${(self.jobs.size + 1).toString(16).padStart(12, 'a')}`.slice(-12) };
        self.jobs.set(id, { ...j, perfil: pedido.perfil, pedido });
        return { rotina: id, jobId: j.id, proxima: pedido.ligada ? Motor.proxima(pedido) : null, ultima: null, ultimoEstado: null, pausada: !pedido.ligada, agenda: null };
      },
      async removerRotina(id: string, perfil: string) { self.removidas.push({ id, perfil }); return self.jobs.delete(id); },
    };
  }
}

async function montar(dir?: string, motor = new Motor()): Promise<{ h: Harness; s: Session; motor: Motor }> {
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: PONTE }, { dir, hermes: motor, control: motor.control() });
  const s = await setupOwner(h);
  return { h, s, motor };
}
/** um horário de hoje (UTC) a `min` minutos atrás: hora da rotina e o horário que ela acabou de ter */
const atras = (min: number) => { const d = new Date(Date.now() - min * 60_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const instalar = (h: Harness, s: Session, hora: string, key = 'briefing-diario') => h.routines.install(s.workspaceId, s.userId, key, { trigger: { kind: 'schedule', days: TODOS, time: hora, tz: 'UTC' } });
const disparo = (h: Harness, rotina: string, emMs = Date.now()) => req(h, 'POST', '/internal/bridge/v1/rotina/disparo', null, { rotina, perfil: 'erg-x', em: emMs / 1000 }, { 'x-ergon-bridge-token': PONTE });
const execucoes = (h: Harness, rotina: string) => h.db.all<{ idempotency_key: string; status: string; slot: string | null }>('SELECT idempotency_key, status, slot FROM routine_runs WHERE routine_id = ? ORDER BY created_at, rowid', rotina);
const pronto = async (h: Harness, ws: string) => { for (let i = 0; i < 5; i++) await h.perfis.emDia(ws, 100); };

describe('rotinas no agendador do motor', () => {
  test('a rotina vira um job no perfil de quem a executa; de novo não manda nada; a tela mostra a próxima do agendador', async () => {
    const { h, s, motor } = await montar();
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, '08:30');
    const quem = h.routines.agenteDe(h.db.get('SELECT * FROM routines WHERE id = ?', r.id)!)!;
    assert.equal(await h.rotinasMotor.emDia(s.workspaceId), 1);
    assert.equal(motor.pedidos.length, 1);
    const p = motor.pedidos[0].pedido;
    assert.equal(p.perfil, nomeDoPerfil(s.workspaceId, quem.id), 'o job fica no perfil do agente que executa (nunca no padrão)');
    assert.deepEqual([p.dias, p.hora, p.fuso, p.ligada], [TODOS, '08:30', 'UTC', true], 'os dias, a hora e o fuso da pessoa');
    assert.ok(h.rotinasMotor.noMotor(r.id));
    const tela = (await req(h, 'GET', `/api/routines/${r.id}`, s)).json;
    assert.equal(tela.nextRunAt, Motor.proxima(p), 'a próxima execução vem do agendador');
    assert.equal(await h.rotinasMotor.emDia(s.workspaceId), 0, 'idempotente: nada mudou, nada vai');
    assert.equal(motor.pedidos.length, 1);
    await h.close();
  });

  test('pausar pausa no agendador; mudar o horário manda de novo; arquivar tira o job', async () => {
    const { h, s, motor } = await montar();
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, '08:30');
    await h.rotinasMotor.emDia(s.workspaceId);
    await req(h, 'PATCH', `/api/routines/${r.id}`, s, { status: 'paused' });
    await h.rotinasMotor.emDia(s.workspaceId);
    assert.equal(motor.pedidos.at(-1)!.pedido.ligada, false, 'pausada no Ergon = pausada no agendador');
    await req(h, 'PATCH', `/api/routines/${r.id}`, s, { status: 'active', trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '07:15', tz: 'UTC' } });
    await h.rotinasMotor.emDia(s.workspaceId);
    const p = motor.pedidos.at(-1)!.pedido;
    assert.deepEqual([p.ligada, p.dias, p.hora], [true, [1, 2, 3, 4, 5], '07:15']);
    await req(h, 'DELETE', `/api/routines/${r.id}`, s);
    await h.rotinasMotor.emDia(s.workspaceId);
    assert.deepEqual(motor.removidas.map((x) => x.id), [r.id], 'arquivada: o job sai do motor');
    assert.equal(h.rotinasMotor.noMotor(r.id), false);
    assert.equal(await h.rotinasMotor.emDia(s.workspaceId), 0);
    assert.equal(motor.removidas.length, 1, 'e não tenta tirar de novo');
    await h.close();
  });

  test('com o job pronto, o aviso do motor dispara; o mesmo horário nunca roda em dobro', async () => {
    const { h, s } = await montar();
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, atras(1));
    await h.rotinasMotor.emDia(s.workspaceId);
    const row = h.db.get<{ trigger: string }>('SELECT trigger FROM routines WHERE id = ?', r.id)!;
    const slot = previousOccurrence(JSON.parse(row.trigger), new Date())!;
    // o horário passou há 1 min e o aviso ainda não chegou: o Ergon NÃO dispara (o agendador do motor dispara)
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await h.routines.tick();
    assert.equal(execucoes(h, r.id).length, 0, 'o Ergon espera o aviso do motor');
    const a = await disparo(h, r.id);
    assert.equal(a.json.resultado, 'rodou');
    assert.deepEqual(execucoes(h, r.id).map((x) => [x.idempotency_key, x.slot]), [[`schedule:${r.id}:${slot}`, slot]], 'a mesma chave do agendador do Ergon');
    assert.equal((await disparo(h, r.id)).json.resultado, 'ja', 'aviso repetido: nada novo');
    assert.ok(h.db.get<{ next_run_at: string }>('SELECT next_run_at FROM routines WHERE id = ?', r.id)!.next_run_at > slot, 'o Ergon passa para o próximo horário');
    await h.routines.tick();
    assert.equal(execucoes(h, r.id).length, 1, 'a reserva do Ergon não roda o mesmo horário de novo');
    // o mesmo horário avisado e já rodado pela reserva: também não repete
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await h.routines.tick();
    assert.equal(execucoes(h, r.id).length, 1);
    await h.close();
  });

  test('sem o aviso do motor em 5 min (motor desligado), o Ergon roda o horário; o aviso que chega depois não repete', async () => {
    const { h, s } = await montar();
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, atras(Math.ceil(ESPERA_DO_MOTOR_MS / 60_000) + 2));
    await h.rotinasMotor.emDia(s.workspaceId);
    const slot = previousOccurrence(JSON.parse(h.db.get<{ trigger: string }>('SELECT trigger FROM routines WHERE id = ?', r.id)!.trigger), new Date())!;
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await h.routines.tick();
    assert.deepEqual(execucoes(h, r.id).map((x) => x.idempotency_key), [`schedule:${r.id}:${slot}`], 'a reserva do Ergon rodou');
    assert.equal((await disparo(h, r.id)).json.resultado, 'ja', 'o aviso atrasado do motor não roda de novo');
    await h.close();
  });

  test('o motor recuperou um horário de muito tempo atrás: fica registrado como perdido, como antes', async () => {
    const { h, s } = await montar();
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, atras(7 * 60));
    await h.rotinasMotor.emDia(s.workspaceId);
    assert.equal((await disparo(h, r.id)).json.resultado, 'perdida');
    assert.equal(execucoes(h, r.id)[0].status, 'missed');
    await h.close();
  });

  test('aviso de outra pessoa (outro motor) ou de rotina sem horário: ignorado', async () => {
    const { h, s } = await montar();
    const r = h.routines.install(s.workspaceId, s.userId, 'briefing-diario', { trigger: { kind: 'manual' } });
    assert.equal((await disparo(h, r.id)).json.resultado, 'ignorada');
    assert.equal((await req(h, 'POST', '/internal/bridge/v1/rotina/disparo', null, { rotina: r.id }, { 'x-ergon-bridge-token': 'outro-token-de-teste-0123456789' })).status, 401);
    await h.close();
  });

  test('motor sem a capacidade, ou agente sem perfil pronto: tudo pelo agendador do Ergon, como antes', async () => {
    const motor = new Motor();
    motor.capacidades = ['conexoes', 'perfis'];
    const { h, s } = await montar(undefined, motor);
    await pronto(h, s.workspaceId);
    const r = instalar(h, s, atras(1));
    assert.equal(await h.rotinasMotor.emDia(s.workspaceId), 0);
    assert.equal(motor.pedidos.length, 0, 'nada vai a um motor que não sabe');
    const slot = previousOccurrence(JSON.parse(h.db.get<{ trigger: string }>('SELECT trigger FROM routines WHERE id = ?', r.id)!.trigger), new Date())!;
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r.id);
    await h.routines.tick();
    assert.equal(execucoes(h, r.id).length, 1, 'o Ergon dispara no horário');
    await h.close();
    // com a capacidade, mas o agente ainda sem perfil: fica pendente e o Ergon dispara
    const m2 = new Motor();
    const b = await montar(undefined, m2);
    const r2 = instalar(b.h, b.s, '09:00');
    assert.equal(await b.h.rotinasMotor.emDia(b.s.workspaceId), 0);
    assert.equal(m2.pedidos.length, 0);
    assert.equal(b.h.rotinasMotor.noMotor(r2.id), false);
    await pronto(b.h, b.s.workspaceId);
    assert.equal(await b.h.rotinasMotor.emDia(b.s.workspaceId), 1, 'o perfil ficou pronto: a rotina passa ao agendador do motor');
    await b.h.close();
  });
});

describe('migração de quem vem da rc.26: as rotinas passam ao agendador do motor', () => {
  test('banco no formato da rc.26: idempotente e retomável, sem rodar em dobro', async () => {
    const dir = tmpDir();
    let rotinas: string[] = [];
    {
      const motor = new Motor();
      motor.capacidades = ['conexoes'];
      const { h, s } = await montar(dir, motor);
      rotinas = [instalar(h, s, '08:00').id, instalar(h, s, '18:00', 'guardiao-prazos').id];
      // o que a rc.26 não tinha: sai (a migração 0044 roda de novo na abertura, com as rotinas e as propostas que existem)
      h.db.run('DROP TABLE routine_jobs');
      h.db.run('DROP TABLE aprovacoes_motor');
      h.db.run('DROP TABLE aprovacoes_previas');
      h.db.run("DELETE FROM schema_migrations WHERE name = '0044_rotinas_e_aprovacoes_no_motor.sql'");
      await h.close();
    }
    const motor = new Motor();
    motor.falharRotina = 1; // a primeira tentativa falha: fica pendente e tenta de novo
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: PONTE }, { dir, hermes: motor, control: motor.control() });
    assert.ok(h.db.get("SELECT 1 AS x FROM schema_migrations WHERE name = '0044_rotinas_e_aprovacoes_no_motor.sql'"), 'migração aplicada');
    const ws = h.db.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1')!.id;
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routines WHERE status = 'active'")!.n, 2, 'as rotinas de antes ficam');
    await pronto(h, ws);
    let n = await h.rotinasMotor.emDia(ws);
    assert.equal(n, 1, 'uma passou; a que falhou fica pendente');
    const falhou = rotinas.find((id) => !h.rotinasMotor.noMotor(id))!;
    assert.ok(falhou, 'a que falhou continua no agendador do Ergon (não fica sem horário)');
    n += await h.rotinasMotor.emDia(ws);
    assert.equal(n, 2, 'retomável: a pendente passa na volta seguinte');
    assert.ok(rotinas.every((id) => h.rotinasMotor.noMotor(id)));
    assert.equal(await h.rotinasMotor.emDia(ws), 0, 'idempotente: de novo, nada');
    assert.equal(motor.jobs.size, 2, 'um job por rotina, sem duplicata');
    // a partir daqui, o horário é do motor: o aviso dele e a reserva do Ergon não rodam em dobro
    const r0 = rotinas[0];
    h.db.run("UPDATE routines SET trigger = ? WHERE id = ?", JSON.stringify({ kind: 'schedule', days: TODOS, time: atras(1), tz: 'UTC' }), r0);
    const slot = previousOccurrence(JSON.parse(h.db.get<{ trigger: string }>('SELECT trigger FROM routines WHERE id = ?', r0)!.trigger), new Date())!;
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', slot, r0);
    await h.routines.tick();
    assert.equal(execucoes(h, r0).length, 0, 'o agendador antigo do Ergon deixa de disparar o que passou ao motor');
    assert.equal((await disparo(h, r0)).json.resultado, 'rodou');
    assert.equal((await disparo(h, r0)).json.resultado, 'ja');
    assert.equal(execucoes(h, r0).length, 1);
    // propostas de antes continuam (a tabela foi refeita com o tipo novo)
    assert.ok(h.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'agent_proposals'"));
    await h.close();
  });
});
