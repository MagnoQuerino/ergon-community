/**
 * Saúde do Ergon e pacote de diagnóstico. Tudo local: nada sai do computador.
 *
 * Quatro estados, do melhor para o pior: operacional · com limitações (funciona, com algo a dizer) · necessita
 * atenção (algo pede ação do usuário) · indisponível (não funciona). O estado geral é o pior dos componentes — mas o
 * motor de IA fora do ar deixa o Ergon "necessita atenção", não "indisponível": tarefas, arquivos e conferências
 * seguem funcionando.
 *
 * O diagnóstico é para mandar a quem ajuda a investigar: versões, contagens, tempos, estados e erros **limpos**
 * (e-mails, endereços, tokens e números longos tirados). Nunca leva títulos, mensagens, nomes, arquivos ou contas.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { Db } from '../db/db.ts';
import type { Vault } from '../security/keys.ts';
import { scrub } from '../lib/log.ts';
import { BUILD, VERSION } from '../version.ts';
import type { HermesClient } from './hermes.ts';
import { machineDefault } from './concurrency.ts';

export type Saude = 'operacional' | 'limitado' | 'atencao' | 'indisponivel';
export const SAUDE_LABEL: Record<Saude, string> = { operacional: 'Operacional', limitado: 'Operacional com limitações', atencao: 'Necessita atenção', indisponivel: 'Indisponível' };
const ORDER: Saude[] = ['operacional', 'limitado', 'atencao', 'indisponivel'];
const worst = (a: Saude, b: Saude) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

export interface Componente { id: string; nome: string; estado: Saude; detalhe: string }
export interface PainelSaude { estado: Saude; rotulo: string; resumo: string; componentes: Componente[]; geradoEm: string }

export interface HealthDeps {
  db: Db; cfg: Config; vault: Vault; hermes: HermesClient | null;
  executorMode: () => 'real' | 'simulated';
  motorVault: () => { state: string; lastError: string | null };
  /** roda dentro de um contêiner? (padrão: procura /.dockerenv; os testes trocam) */
  inContainer?: () => boolean;
}

const inDocker = () => fs.existsSync('/.dockerenv');

const DAY = 86_400_000;
const since = (ms: number) => new Date(Date.now() - ms).toISOString();
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;


function lastBackup(cfg: Config): { name: string; at: number } | null {
  try {
    const all = fs.readdirSync(cfg.backupsDir).filter((n) => /^ergon-\d{4}-\d{2}-\d{2}T[\d-]+Z(\.sqlite)?$/.test(n));
    const items = all.map((n) => ({ name: n, at: fs.statSync(path.join(cfg.backupsDir, n)).mtimeMs })).sort((a, b) => b.at - a.at);
    return items[0] ?? null;
  } catch { return null; }
}

export async function healthPanel(d: HealthDeps): Promise<PainelSaude> {
  const { db, cfg, vault } = d;
  const c: Componente[] = [];

  // banco: abre, lê e passa na conferência rápida
  try {
    const q = String(db.raw.pragma('quick_check', { simple: true }));
    const size = fs.existsSync(cfg.dbPath) ? fs.statSync(cfg.dbPath).size : 0;
    c.push({ id: 'banco', nome: 'Banco de dados', estado: q === 'ok' ? 'operacional' : 'indisponivel', detalhe: q === 'ok' ? `íntegro · ${(size / 1024 / 1024).toFixed(1)} MB` : `a conferência acusou: ${scrub(q, 120)}` });
  } catch (e) { c.push({ id: 'banco', nome: 'Banco de dados', estado: 'indisponivel', detalhe: scrub((e as Error).message) }); }

  // cofre: protegido e aberto
  const vs = vault.state();
  c.push({ id: 'cofre', nome: 'Proteção dos dados', estado: vs === 'open' ? 'operacional' : vs === 'unprotected' ? 'atencao' : 'indisponivel',
    detalhe: vs === 'open' ? (vault.openAccess() ? 'cifrado · abre sozinho ao reiniciar (sem trancamento)' : 'cifrado · pede a senha ao reiniciar') : vs === 'unprotected' ? 'ainda sem proteção: proteja em Configurações › Segurança' : 'trancado' });

  // motor de IA
  if (d.executorMode() === 'simulated' || !d.hermes) {
    c.push({ id: 'motor', nome: 'Motor de IA', estado: 'limitado', detalhe: 'modo de simulação: os agentes não usam IA (as conferências e rotinas sem IA funcionam)' });
  } else {
    const h = await d.hermes.health().catch((e: Error) => ({ ok: false, detail: e.message }));
    const mv = d.motorVault();
    // com o cofre do motor, o motor só sobe depois de o cofre abrir: se ele responde, o cofre está aberto. O estado do
    // guardião do cofre só explica o motor fora do ar (depois de reiniciar só o Ergon, o receptor do cofre já não
    // responde e o guardião fica em "desligado" — não é defeito)
    const why = !cfg.hermesVaultUrl ? '' : mv.state === 'aguardando' ? 'abrindo o cofre dele (a primeira vez pode levar minutos)' : mv.state === 'erro' ? `o cofre dele não abriu${mv.lastError ? `: ${scrub(mv.lastError, 100)}` : ''}` : '';
    c.push({ id: 'motor', nome: 'Motor de IA', estado: h.ok ? 'operacional' : 'indisponivel',
      detalhe: h.ok ? (cfg.hermesVaultUrl ? 'no ar · cofre dele aberto' : 'no ar') : why || `não responde (${scrub(h.detail, 100)})` });
  }

  // execuções: presas e falhas do último dia
  const stuck = Number(db.get<{ n: number }>("SELECT count(*) AS n FROM runs WHERE status IN ('running', 'waiting_user') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?", since(10 * 60_000))?.n ?? 0);
  const runs = db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM runs WHERE created_at >= ? GROUP BY status', since(DAY));
  const count = (rows: Array<{ status: string; n: number }>, st: string) => Number(rows.find((r) => r.status === st)?.n ?? 0);
  const total = runs.reduce((s, r) => s + Number(r.n), 0); const failed = count(runs, 'failed');
  c.push({ id: 'execucoes', nome: 'Execuções dos agentes', estado: stuck ? 'atencao' : total >= 3 && failed / total > 0.5 ? 'atencao' : failed ? 'limitado' : 'operacional',
    detalhe: [`${total} nas últimas 24 h`, failed ? `${failed} falharam` : '', stuck ? `${plural(stuck, 'parada', 'paradas')} há mais de 10 min` : ''].filter(Boolean).join(' · ') });

  // rotinas: falhas, perdidas e conferências reprovadas do último dia
  const rr = db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM routine_runs WHERE created_at >= ? GROUP BY status', since(DAY));
  const verd = db.all<{ v: string; n: number }>("SELECT verdict AS v, count(*) AS n FROM routine_runs WHERE created_at >= ? AND verdict IS NOT NULL GROUP BY verdict", since(DAY));
  const rFailed = count(rr, 'failed'); const rMissed = count(rr, 'missed'); const reprov = Number(verd.find((x) => x.v === 'reprovado')?.n ?? 0); const parcial = Number(verd.find((x) => x.v === 'parcial')?.n ?? 0);
  const active = Number(db.get<{ n: number }>("SELECT count(*) AS n FROM routines WHERE status = 'active'")?.n ?? 0);
  c.push({ id: 'rotinas', nome: 'Rotinas', estado: rFailed || rMissed || reprov ? 'atencao' : parcial ? 'limitado' : 'operacional',
    detalhe: [plural(active, 'ativa', 'ativas'), rFailed ? `${rFailed} falharam (24 h)` : '', rMissed ? `${rMissed} perdidas` : '', reprov ? `${reprov} com a conferência reprovada` : '', parcial ? `${parcial} conferidas em parte` : ''].filter(Boolean).join(' · ') });

  // contas conectadas
  const ints = db.all<{ kind: string; state: string; connected_at: string | null }>("SELECT kind, state, connected_at FROM integrations WHERE state IN ('connected', 'error')");
  const bad = ints.filter((i) => i.state === 'error').map((i) => i.kind);
  const soon = cfg.googleTesting ? ints.filter((i) => i.kind === 'google' && i.state === 'connected' && i.connected_at && Date.parse(i.connected_at) + 7 * DAY - Date.now() < 2 * DAY) : [];
  c.push({ id: 'contas', nome: 'Contas e apps conectados', estado: bad.length ? 'atencao' : soon.length ? 'limitado' : 'operacional',
    detalhe: !ints.length ? 'nenhuma conectada' : [plural(ints.length - bad.length, 'conectada', 'conectadas'), bad.length ? `com erro: ${bad.join(', ')} (entre de novo em Conexões)` : '', soon.length ? 'Google vence em menos de 2 dias (modo de teste)' : ''].filter(Boolean).join(' · ') });

  // espelhos de tarefas
  const mirrors = db.all<{ e: string | null }>("SELECT last_error AS e FROM boards WHERE origin = 'mirror'");
  const mErr = mirrors.filter((m) => m.e).length;
  if (mirrors.length) c.push({ id: 'espelhos', nome: 'Listas espelhadas', estado: mErr ? 'limitado' : 'operacional', detalhe: `${mirrors.length} lista(s)${mErr ? ` · ${mErr} com erro na última leitura` : ''}` });

  // backup
  const b = lastBackup(cfg);
  const age = b ? Date.now() - b.at : Infinity;
  c.push({ id: 'backup', nome: 'Backup', estado: !b ? 'atencao' : age > 7 * DAY ? 'limitado' : 'operacional',
    detalhe: !b ? 'nenhum backup ainda' : `último ${age < 3_600_000 ? 'há menos de 1 h' : age < DAY ? `há ${Math.round(age / 3_600_000)} h` : `há ${Math.round(age / DAY)} dia(s)`}${/\.sqlite$/.test(b.name) ? ' (formato antigo: só o banco)' : ''}` });

  // disco. Dentro do Docker a medida é a do disco virtual do Docker, que cresce sobre o disco do computador e pode
  // dizer muito mais do que ele tem livre (achado na instalação real: 933 GB "livres" com 23 GB no C:) — dito no texto
  try {
    const st = fs.statfsSync(cfg.dataDir);
    const free = Number(st.bavail) * Number(st.bsize);
    const gb = `${(free / 1024 ** 3).toFixed(1)} GB livres`;
    c.push({ id: 'disco', nome: 'Espaço em disco', estado: free < 1024 ** 3 ? 'atencao' : free < 5 * 1024 ** 3 ? 'limitado' : 'operacional',
      detalhe: (d.inContainer ?? inDocker)() ? `${gb} no disco virtual do Docker; o disco do computador pode ter menos (confira no Windows)` : gb });
  } catch { /* sem como medir aqui */ }

  let estado: Saude = 'operacional';
  for (const x of c) estado = worst(estado, x.id === 'motor' && x.estado === 'indisponivel' ? 'atencao' : x.estado);
  const problemas = c.filter((x) => x.estado !== 'operacional');
  return { estado, rotulo: SAUDE_LABEL[estado], resumo: problemas.length ? problemas.map((x) => `${x.nome}: ${x.detalhe}`).join(' · ') : 'tudo funcionando', componentes: c, geradoEm: new Date().toISOString() };
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };

/** Pacote de diagnóstico (JSON), sem conteúdo do usuário. */
export async function diagnostics(d: HealthDeps): Promise<Record<string, unknown>> {
  const { db, cfg } = d;
  const n = (sql: string, ...a: unknown[]) => Number(db.get<{ n: number }>(sql, ...(a as never[]))?.n ?? 0);
  const week = since(7 * DAY);
  const durations = (table: string) => db.all<{ s: string; f: string }>(`SELECT started_at AS s, finished_at AS f FROM ${table} WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND created_at >= ?`, week)
    .map((r) => Date.parse(r.f) - Date.parse(r.s)).filter((x) => Number.isFinite(x) && x >= 0);
  const runD = durations('runs'); const rrD = durations('routine_runs');
  // leituras das contas: só estado e tempo (o resto do registro de conferência fica de fora)
  const reads: Record<string, number> = {}; const readMs: number[] = [];
  for (const r of db.all<{ checks: string | null }>('SELECT checks FROM routine_runs WHERE created_at >= ? AND checks IS NOT NULL LIMIT 500', week)) {
    try {
      const j = JSON.parse(String(r.checks)) as { reads?: Array<{ account?: string; what?: string; status?: string; ms?: number }> };
      for (const x of j.reads ?? []) { const k = `${x.account ?? '?'}/${x.what ?? '?'}/${x.status ?? '?'}`; reads[k] = (reads[k] ?? 0) + 1; if (typeof x.ms === 'number') readMs.push(x.ms); }
    } catch { /* conferência antiga ou ilegível: fica de fora */ }
  }
  const mem = process.memoryUsage();
  return {
    formato: 1, geradoEm: new Date().toISOString(),
    aviso: 'Pacote de diagnóstico do Ergon: versões, contagens, tempos, estados e erros limpos. Sem títulos, mensagens, nomes, arquivos, contas nem segredos.',
    versao: { ergon: VERSION, build: BUILD, node: process.version, plataforma: `${process.platform}/${process.arch}`, modo: cfg.mode, executor: cfg.executor, ligadoHa: Math.round(process.uptime()) },
    configuracao: {
      motor: cfg.hermesApiKey ? 'definido' : 'ausente', cofreDoMotor: cfg.hermesVaultUrl ? 'definido' : 'ausente', ponte: cfg.bridgeToken ? 'definida' : 'ausente',
      microsoft: cfg.msClientId ? 'app registrado' : 'sem app', google: cfg.googleClientId && cfg.googleClientSecret ? 'app registrado' : 'sem app', googleEmTeste: cfg.googleTesting,
      teams: cfg.teams.enabled, whatsapp: cfg.whatsapp.enabled, tetoDeProcessos: cfg.maxConcurrentRuns || 'sem teto', processosPadraoDaMaquina: machineDefault(), limiteDiario: cfg.dailyRunLimit, tempoLimiteS: cfg.runTimeoutSeconds,
    },
    memoria: { rssMB: Math.round(mem.rss / 1024 / 1024), heapMB: Math.round(mem.heapUsed / 1024 / 1024) },
    banco: { migracoes: db.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').map((r) => r.name), cifrado: Db.isEncryptedFile(cfg.dbPath) },
    saude: await healthPanel(d),
    contagens: {
      usuarios: n('SELECT count(*) AS n FROM users'), agentes: n('SELECT count(*) AS n FROM agents'),
      tarefasAbertas: n('SELECT count(*) AS n FROM tasks WHERE completed = 0 AND archived = 0'), tarefasConcluidas: n('SELECT count(*) AS n FROM tasks WHERE completed = 1'),
      quadros: n("SELECT count(*) AS n FROM boards WHERE origin = 'native'"), listasEspelhadas: n("SELECT count(*) AS n FROM boards WHERE origin = 'mirror'"),
      rotinasAtivas: n("SELECT count(*) AS n FROM routines WHERE status = 'active'"), arquivos: n('SELECT count(*) AS n FROM artifacts'),
      arquivosMB: Math.round(n('SELECT COALESCE(SUM(size), 0) AS n FROM artifacts') / 1024 / 1024),
    },
    semana: {
      execucoes: Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM runs WHERE created_at >= ? GROUP BY status', week).map((r) => [r.status, Number(r.n)])),
      execucoesMs: { p50: pct(runD, 0.5), p95: pct(runD, 0.95) },
      rotinas: Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM routine_runs WHERE created_at >= ? GROUP BY status', week).map((r) => [r.status, Number(r.n)])),
      rotinasPorModelo: Object.fromEntries(db.all<{ k: string | null; n: number }>('SELECT r.template_key AS k, count(*) AS n FROM routine_runs x JOIN routines r ON r.id = x.routine_id WHERE x.created_at >= ? GROUP BY r.template_key', week).map((r) => [r.k ?? 'conversada', Number(r.n)])),
      rotinasMs: { p50: pct(rrD, 0.5), p95: pct(rrD, 0.95) },
      conferencias: Object.fromEntries(db.all<{ v: string; n: number }>('SELECT verdict AS v, count(*) AS n FROM routine_runs WHERE created_at >= ? AND verdict IS NOT NULL GROUP BY verdict', week).map((r) => [r.v, Number(r.n)])),
      leiturasDasContas: reads, leiturasMs: { p50: pct(readMs, 0.5), p95: pct(readMs, 0.95) },
    },
    errosRecentes: [
      ...db.all<{ at: string; e: string }>("SELECT finished_at AS at, error AS e FROM runs WHERE status = 'failed' AND error IS NOT NULL ORDER BY finished_at DESC LIMIT 10").map((r) => ({ onde: 'execução', quando: r.at, erro: scrub(r.e) })),
      ...db.all<{ at: string; e: string }>("SELECT finished_at AS at, error AS e FROM routine_runs WHERE status = 'failed' AND error IS NOT NULL ORDER BY finished_at DESC LIMIT 10").map((r) => ({ onde: 'rotina', quando: r.at, erro: scrub(r.e) })),
    ],
    integracoes: db.all<{ kind: string; state: string; connected_at: string | null; last_sync_at: string | null; last_error: string | null }>('SELECT kind, state, connected_at, last_sync_at, last_error FROM integrations')
      .map((i) => ({ tipo: i.kind, estado: i.state, conectadaEm: i.connected_at, ultimaLeitura: i.last_sync_at, ultimoErro: i.last_error ? scrub(i.last_error) : null })),
    auditoria: db.all<{ action: string; created_at: string }>('SELECT action, created_at FROM audit_events ORDER BY created_at DESC LIMIT 50').map((a) => ({ acao: a.action, quando: a.created_at })),
    backups: (() => { try { return fs.readdirSync(cfg.backupsDir).filter((x) => /^(ergon-|pre-restore-|desfeito-)/.test(x) && !x.endsWith('.keyring.json')).sort().slice(-20); } catch { return []; } })(),
  };
}
