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
import type { EspacoMotores, MotorSaude, PorqueDadosAntigos } from './motors.ts';
import { machineDefault } from './concurrency.ts';
import { BACKUPS_MANTER } from './backup.ts';
import { decimal, paraTela } from '../lib/texto-tela.ts';
import { junto, reconhecer, tx, type Codigo, type Texto, type Valor } from '../lib/textos.ts';

/** O nome do componente da IA na Saúde (o id continua "motor": é dado, não aparece). */
const EQUIPE = 'Equipe de IA';

export type Saude = 'operacional' | 'limitado' | 'atencao' | 'indisponivel';
export const SAUDE_LABEL: Record<Saude, string> = { operacional: 'Operacional', limitado: 'Operacional com limitações', atencao: 'Necessita atenção', indisponivel: 'Indisponível' };
const ORDER: Saude[] = ['operacional', 'limitado', 'atencao', 'indisponivel'];
const worst = (a: Saude, b: Saude) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** nome_t, detalhe_t: o mesmo texto com código (lib/textos.ts), para a tela traduzir; sem eles, vale o português */
export interface Componente { id: string; nome: string; estado: Saude; detalhe: string; nome_t?: Texto; detalhe_t?: Valor }
/** O aviso da cópia antiga (sem jargão): por que ela não saiu sozinha, e que quem decide é a pessoa. */
export function textoDadosAntigos(porque: PorqueDadosAntigos, mantida = false): string {
  const pq = porque === 'sem-copia' ? 'o cofre cifrado da equipe foi criado sem ela, então o que estiver nela só existe ali'
    : porque === 'sem-cofre' ? 'ela nunca foi para um cofre cifrado da equipe, então o que estiver nela só existe ali'
      : 'o cofre cifrado da equipe não confirmou que recebeu esta cópia';
  return mantida ? `guardada sem cifra neste computador, de antes do cofre; ${pq}. Você decidiu manter; dá para apagar quando quiser, sem volta`
    : `guardada sem cifra neste computador, de antes do cofre; ${pq}. Por isso ela não é apagada sozinha: você decide se mantém ou apaga`;
}

/** espaco: um motor por pessoa (gerente de motores): o que a limpeza liberou e os cofres de contas que já não existem */
export interface PainelSaude { estado: Saude; rotulo: string; resumo: string; componentes: Componente[]; geradoEm: string; espaco?: EspacoMotores | null; rotulo_t?: Texto; resumo_t?: Valor }

export interface HealthDeps {
  db: Db; cfg: Config; vault: Vault; hermes: HermesClient | null;
  executorMode: () => 'real' | 'simulated';
  motorVault: () => { state: string; lastError: string | null };
  /** um motor por pessoa: o motor de quem olha (renovando, sem as Conexões, renovação que voltou atrás) */
  motor?: () => MotorSaude | null;
  /** o motor foi lido e não tem as Conexões (do cache das ferramentas; vale também com um motor só) */
  semConexoes?: () => boolean;
  /** espaço: só do cache (a tela nunca espera o gerente) */
  espaco?: () => EspacoMotores | null;
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
    c.push({ id: 'banco', nome: 'Banco de dados', estado: q === 'ok' ? 'operacional' : 'indisponivel', detalhe: q === 'ok' ? `íntegro · ${decimal(size / 1024 / 1024)} MB` : `a conferência acusou: ${scrub(q, 120)}` });
  } catch (e) { c.push({ id: 'banco', nome: 'Banco de dados', estado: 'indisponivel', detalhe: scrub((e as Error).message) }); }

  // cofre: protegido e aberto
  const vs = vault.state();
  c.push({ id: 'cofre', nome: 'Proteção dos dados', estado: vs === 'open' ? 'operacional' : vs === 'unprotected' ? 'atencao' : 'indisponivel',
    detalhe: vs === 'open' ? (vault.openAccess() ? 'cifrado · abre sozinho ao reiniciar (sem trancamento)' : 'cifrado · pede a senha ao reiniciar') : vs === 'unprotected' ? 'ainda sem proteção: proteja em Configurações › Segurança' : 'trancado' });

  // motor de IA (na tela, "Equipe de IA": o id fica "motor", é dado)
  if (d.executorMode() === 'simulated' || !d.hermes) {
    c.push({ id: 'motor', nome: EQUIPE, estado: 'limitado', detalhe: 'esta instalação está configurada para não usar contas de IA: os agentes não trabalham nos pedidos (as conferências e rotinas sem IA funcionam)' });
  } else {
    const ms = d.motor?.() ?? null;
    if (ms?.estado === 'renovando') {
      // versão nova do motor a caminho: o que já estava no motor termina, os pedidos novos esperam (sem contar o tempo
      // do pedido, mas com o prazo da troca: passou dele, o pedido desiste, ou a troca fica para depois)
      c.push({ id: 'motor', nome: EQUIPE, estado: 'limitado', detalhe: `Atualizando a equipe para a versão ${ms.versao}: os pedidos novos esperam (até ${cfg.motorWaitMinutes} minutos) e seguem sozinhos quando terminar` });
    } else {
      const h = await d.hermes.health().catch((e: Error) => ({ ok: false, detail: e.message }));
      const mv = d.motorVault();
      // com o cofre do motor, o motor só sobe depois de o cofre abrir: se ele responde, o cofre está aberto. O estado do
      // guardião do cofre só explica o motor fora do ar (depois de reiniciar só o Ergon, o receptor do cofre já não
      // responde e o guardião fica em "desligado" — não é defeito)
      // o erro técnico (rede, gerente, cofre) fica no registro: na tela, só o que já é para a pessoa
      const erroCofre = paraTela(scrub(mv.lastError, 100));
      const why = !cfg.hermesVaultUrl ? '' : mv.state === 'aguardando' ? 'abrindo o cofre da equipe (a primeira vez pode levar minutos)' : mv.state === 'erro' ? `o cofre da equipe não abriu${erroCofre ? `: ${erroCofre}` : ''}` : '';
      const semResposta = paraTela(scrub(h.detail, 100));
      let estado: Saude = h.ok ? 'operacional' : 'indisponivel';
      let detalhe = h.ok ? (cfg.hermesVaultUrl ? 'no ar · cofre aberto' : 'no ar') : why || `fora do ar agora${semResposta ? ` (${semResposta})` : ''}`;
      // a tela nunca diz "operacional" quando a equipe não consegue usar as contas conectadas
      if (h.ok && (ms?.semConexoes || d.semConexoes?.())) { estado = 'limitado'; detalhe += ' · as Conexões não estão nesta versão da equipe: os agentes ainda não conseguem usar as contas conectadas'; }
      // depois de voltar atrás, nada tenta de novo nesta versão (o gerente trava a versão recusada): "até a próxima versão"
      if (ms?.falha) { estado = worst(estado, 'atencao'); detalhe += ` · a atualização da equipe para a versão ${ms.versao} não deu certo (${paraTela(scrub(ms.falha, 120), 'a versão nova não passou na conferência')}); a equipe segue na versão anterior até a próxima versão do Ergon`; }
      // a versão nova ainda não chegou (ou o motor não parou): o de antes funciona, e o sistema tenta de novo sozinho na
      // próxima vez que o Ergon for aberto (com ele sempre aberto, uma vez por dia)
      else if (ms?.adiada) { estado = worst(estado, 'limitado'); detalhe += ` · atualização da equipe para a versão ${ms.versao} pendente: ${paraTela(scrub(ms.adiada, 160), 'a versão nova ainda não pôde entrar')}; a equipe segue na versão anterior, e o sistema tenta de novo sozinho quando o Ergon for aberto (ou uma vez por dia, se ele ficar sempre aberto)`; }
      c.push({ id: 'motor', nome: EQUIPE, estado, detalhe });
    }
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

  // listas ligadas a aplicativos de tarefas (nos dois sentidos)
  const mirrors = db.all<{ e: string | null }>("SELECT last_error AS e FROM boards WHERE origin = 'mirror'");
  const mErr = mirrors.filter((m) => m.e).length;
  if (mirrors.length) c.push({ id: 'espelhos', nome: 'Listas ligadas a aplicativos', estado: mErr ? 'limitado' : 'operacional', detalhe: `${mirrors.length} lista(s)${mErr ? ` · ${mErr} com erro na última leitura` : ''}` });

  // backup
  const b = lastBackup(cfg);
  const age = b ? Date.now() - b.at : Infinity;
  c.push({ id: 'backup', nome: 'Backup', estado: !b ? 'atencao' : age > 7 * DAY ? 'limitado' : 'operacional',
    detalhe: !b ? 'nenhum backup ainda' : `último ${age < 3_600_000 ? 'há menos de 1 h' : age < DAY ? `há ${Math.round(age / 3_600_000)} h` : `há ${Math.round(age / DAY)} dia(s)`}${/\.sqlite$/.test(b.name) ? ' (formato antigo: só o banco)' : ''}; ficam os ${BACKUPS_MANTER} mais recentes e os mais antigos são apagados sozinhos` });

  // disco. Dentro do Docker a medida é a do disco virtual do Docker, que cresce sobre o disco do computador e pode
  // dizer muito mais do que ele tem livre (achado na instalação real: 933 GB "livres" com 23 GB no C:) — dito no texto
  try {
    const st = fs.statfsSync(cfg.dataDir);
    const free = Number(st.bavail) * Number(st.bsize);
    const gb = `${decimal(free / 1024 ** 3)} GB livres`;
    c.push({ id: 'disco', nome: 'Espaço em disco', estado: free < 1024 ** 3 ? 'atencao' : free < 5 * 1024 ** 3 ? 'limitado' : 'operacional',
      detalhe: (d.inContainer ?? inDocker)() ? `${gb} no ambiente do Ergon; o disco do computador pode ter menos (confira no Windows)` : gb });
  } catch { /* sem como medir aqui */ }

  // cofres de contas que já não existem neste computador (o gerente viu sem dono): aviso, e a tela oferece apagar
  const espaco = d.espaco?.() ?? null;
  if (espaco?.volumes.length) {
    const quem = [...new Set(espaco.volumes.map((v) => v.conta))].slice(0, 3).join('; ');
    c.push({ id: 'cofres', nome: 'Cofres de contas removidas', estado: 'limitado',
      detalhe: `${plural(espaco.volumes.length, 'cofre guardado', 'cofres guardados')} (${quem}): ocupam espaço neste computador; dá para apagar, sem volta` });
  }

  // a cópia antiga dos dados da equipe (sem cifra, de antes do cofre) que o cofre não confirmou ter recebido: nunca sai
  // sozinha; a tela oferece manter ou apagar (com a confirmação de que não tem volta). Mantida, fica como informação
  if (espaco?.dadosAntigos) {
    const mantida = espaco.dadosAntigos.mantida === true;
    c.push({ id: 'dados-antigos', nome: 'Cópia antiga dos dados da equipe', estado: mantida ? 'operacional' : 'limitado', detalhe: textoDadosAntigos(espaco.dadosAntigos.porque, mantida) });
  }

  let estado: Saude = 'operacional';
  for (const x of c) estado = worst(estado, x.id === 'motor' && x.estado === 'indisponivel' ? 'atencao' : x.estado);
  const problemas = c.filter((x) => x.estado !== 'operacional');
  const comT = c.map(comTextos);
  const problemasT = comT.filter((x) => x.estado !== 'operacional');
  // o resumo com código só quando cada pedaço é conhecido (senão, a tela mostra o português inteiro)
  const resumoT = problemasT.every((x) => x.nome_t && x.detalhe_t) ? (problemasT.length ? junto(problemasT.map((x) => tx('saude.problema', { nome: x.nome_t!, detalhe: x.detalhe_t! })), ' · ') : tx('saude.tudoFuncionando')) : undefined;
  return { estado, rotulo: SAUDE_LABEL[estado], rotulo_t: tx(`saude.estado.${estado}`), resumo: problemas.length ? problemas.map((x) => `${x.nome}: ${x.detalhe}`).join(' · ') : 'tudo funcionando', ...(resumoT ? { resumo_t: resumoT } : {}), componentes: comT, geradoEm: new Date().toISOString(), espaco };
}

/**
 * A parte da Saúde com o código do nome e do detalhe: o detalhe é feito de pedaços (" · "), e só ganha código quando
 * todos são frases conhecidas (lib/textos.ts, prefixo saude.); um pedaço com o erro ou um nome de fora deixa o português.
 */
function comTextos(x: Componente): Componente {
  // o nome pelo id da parte, e só quando é o nome fixo de sempre (o da Equipe de IA, por exemplo)
  const nome = reconhecer(x.nome, 'saude.nome.');
  const nomeT = nome && nome.codigo === `saude.nome.${x.id}` ? tx(nome.codigo as Codigo) : undefined;
  const partes = x.detalhe.split(' · ').map((p) => reconhecer(p, 'saude.'));
  const detalheT = partes.every((p): p is Texto => !!p) ? (partes.length === 1 ? partes[0] : junto(partes, ' · ')) : undefined;
  return { ...x, ...(nomeT ? { nome_t: nomeT } : {}), ...(detalheT ? { detalhe_t: detalheT } : {}) };
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
  // o nome de cada cofre traz o identificador da conta: no pacote vai só a contagem
  const { espaco, ...saude } = await healthPanel(d);
  return {
    formato: 1, geradoEm: new Date().toISOString(),
    aviso: 'Pacote de diagnóstico do Ergon: versões, contagens, tempos, estados e erros limpos. Sem títulos, mensagens, nomes, arquivos, contas nem segredos.',
    versao: { ergon: VERSION, build: BUILD, node: process.version, plataforma: `${process.platform}/${process.arch}`, modo: cfg.mode, executor: cfg.executor, ligadoHa: Math.round(process.uptime()) },
    configuracao: {
      motor: cfg.hermesApiKey ? 'definido' : 'ausente', cofreDoMotor: cfg.hermesVaultUrl ? 'definido' : 'ausente', ponte: cfg.bridgeToken ? 'definida' : 'ausente',
      microsoft: cfg.msClientId ? 'app registrado' : 'sem app', google: cfg.googleClientId && cfg.googleClientSecret ? 'app registrado' : 'sem app', googleEmTeste: cfg.googleTesting,
      tetoDeProcessos: cfg.maxConcurrentRuns || 'sem teto', processosPadraoDaMaquina: machineDefault(), limiteDiario: cfg.dailyRunLimit, tempoLimiteS: cfg.runTimeoutSeconds,
    },
    memoria: { rssMB: Math.round(mem.rss / 1024 / 1024), heapMB: Math.round(mem.heapUsed / 1024 / 1024) },
    banco: { migracoes: db.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name').map((r) => r.name), cifrado: Db.isEncryptedFile(cfg.dbPath) },
    saude, espaco: espaco ? { cofresSemDono: espaco.volumes.length, ultimaLimpeza: espaco.ultima } : null,
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
