/**
 * Custo das chamadas (docs/CUSTO_DAS_CHAMADAS.md): do que é feita cada chamada ao modelo, por agente, e o máximo de passos
 * por pedido que a pessoa escolhe.
 *
 * Medição: o plugin do motor mede, em cada chamada, o tamanho de cada parte do pedido que foi de verdade ao provedor (o
 * prompt de sistema inteiro — e, dentro dele, a memória e a lista de competências —, as definições das ferramentas e a
 * conversa) e guarda o total que o provedor informou. Quando a execução termina, o Ergon lê essas chamadas pela ponte de
 * controle e grava a soma (run_composicao). As instruções que o próprio Ergon mandou ao agente vão no fim do prompt de
 * sistema: o tamanho delas o Ergon sabe (é o texto que ele mandou), e o resto do prompt de sistema é a base da equipe. O
 * que o sistema junta à mensagem do pedido (anexos, documentos citados, dados das contas) vai na conversa: o tamanho dele
 * fica na execução (runs.context_chars) e sai da conversa, como "anexos". As chamadas de cada execução são separadas pela
 * marca do pedido (o turno do motor), com o relógio do motor compensado.
 * Em tokens: o total é o informado pelo provedor; a divisão entre as partes segue o tamanho de cada uma (o provedor só
 * informa o total). Sem o total informado, ele é estimado pelo tamanho (4 caracteres por token) e a tela diz isso.
 */
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';
import type { ChamadaMedida, HermesControlClient, MedicaoSessao } from './hermes.ts';
import { getSetting, setSetting } from './sectors.ts';

// ---------------------------------------------------------------- passos por pedido (agent.max_turns no motor)
/** o padrão (a migração 1 do cofre grava 20) e o intervalo que a ponte do motor aceita (PASSOS_MIN/PASSOS_MAX no plugin) */
export const PASSOS_PADRAO = 20;
export const PASSOS_MIN = 5;
export const PASSOS_MAX = 60;
export const PASSOS_OPCOES = [5, 10, 15, 20, 30, 40, 60] as const;
export const PASSOS_SETTING = 'team.max_turns';

/** o valor que o motor confirmou por último (gravado em cada workspace do motor): a tela diz se a escolha já vale */
export const PASSOS_MOTOR = 'team.max_turns.motor';

const passoValido = (n: number) => Number.isInteger(n) && n >= PASSOS_MIN && n <= PASSOS_MAX;

/**
 * O motor é um só para os workspaces de quem é dono (um motor por pessoa) ou para a instalação (um motor só): vale a escolha
 * gravada mais recente entre eles. null = ninguém escolheu (o motor fica com o que tem: 20, da migração do cofre).
 */
export function passosEscolhidos(db: Db, workspaceIds: string[] | null): number | null {
  const ids = workspaceIds ?? db.all<{ id: string }>('SELECT id FROM workspaces').map((w) => w.id);
  if (!ids.length) return null;
  const row = db.get<{ value: string }>(
    `SELECT value FROM workspace_settings WHERE key = ? AND workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`,
    PASSOS_SETTING, ...ids);
  const n = Number(row?.value);
  return row && passoValido(n) ? n : null;
}

/**
 * Deixa o motor com o que vale: a escolha mais recente entre os workspaces dele; sem escolha, o que ele tem — a menos que
 * esteja fora de 5 a 60 ou não seja um número (um script, um agente com Terminal ou uma edição à mão gravou 500 ou
 * "unlimited"): aí volta ao padrão, 20, para sempre haver um teto que a pessoa não escolheu desfazer. Grava, em cada
 * workspace do motor, o valor que ele confirmou (a tela diz se a escolha já vale). Devolve esse valor; null = motor sem a
 * ponte dos passos (versão anterior). Erro de rede sobe (quem chama tenta de novo depois).
 */
export async function sincronizarPassos(db: Db, control: HermesControlClient | null, ids: string[]): Promise<number | null> {
  if (!control?.setPassos || !control.passos) return null;
  const escolha = passosEscolhidos(db, ids);
  let atual = await control.passos();
  const alvo = escolha ?? (atual !== null && passoValido(atual) ? null : PASSOS_PADRAO);
  if (alvo !== null && atual !== alvo) atual = await control.setPassos(alvo);
  if (atual !== null) for (const ws of ids) if (getSetting(db, ws, PASSOS_MOTOR) !== String(atual)) setSetting(db, ws, PASSOS_MOTOR, String(atual));
  return atual;
}

/** O que vale para a equipe destes workspaces (os do mesmo motor) e se o motor ainda não confirmou a escolha. */
export function passosDaEquipe(db: Db, ids: string[]): { valor: number; pendente: boolean } {
  const escolha = passosEscolhidos(db, ids);
  if (escolha === null) return { valor: PASSOS_PADRAO, pendente: false };
  const motor = ids.length ? db.get<{ value: string }>(
    `SELECT value FROM workspace_settings WHERE key = ? AND workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`,
    PASSOS_MOTOR, ...ids)?.value : undefined;
  return { valor: escolha, pendente: motor !== String(escolha) };
}

// ---------------------------------------------------------------- resumir as conversas longas mais cedo (rc.26)
/**
 * A compactação da conversa no motor (compression.threshold_tokens): ligada, a parte antiga da conversa de um agente vira
 * um resumo quando a chamada passa de ~150 mil (ou da fração do Hermes, em janelas menores) (a migração 3 do cofre liga por padrão; o número está explicado lá);
 * desligada, o motor só resume perto do limite do modelo. Ausente = ligado (só o desligado gravado pela pessoa vale).
 * O motor é um só para os workspaces de quem é dono (ou para a instalação): vale a escolha gravada mais recente entre eles.
 */
export const COMPACTAR_SETTING = 'team.compactacao';
/** o que o motor confirmou por último ('1' ligada, '0' desligada), gravado em cada workspace do motor */
export const COMPACTAR_MOTOR = 'team.compactacao.motor';

function ultimaEntre(db: Db, key: string, ids: string[]): string | undefined {
  if (!ids.length) return undefined;
  return db.get<{ value: string }>(
    `SELECT value FROM workspace_settings WHERE key = ? AND workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`,
    key, ...ids)?.value;
}

/** A escolha mais recente entre os workspaces do motor; null = ninguém escolheu (o motor fica com o que tem). */
export function compactacaoEscolhida(db: Db, workspaceIds: string[] | null): boolean | null {
  const ids = workspaceIds ?? db.all<{ id: string }>('SELECT id FROM workspaces').map((w) => w.id);
  const v = ultimaEntre(db, COMPACTAR_SETTING, ids);
  return v === 'ligado' ? true : v === 'desligado' ? false : null;
}

/** a capacidade do plugin que traz a ponte da compactação (rc.26); sem ela, o motor é de antes e só a atualização traz */
export const CAPACIDADE_COMPACTACAO = 'compactacao';
/** COMPACTAR_MOTOR = SEM_COMPACTACAO: o motor é de antes da compactação mais cedo (chega com a próxima atualização da equipe) */
export const SEM_COMPACTACAO = 'sem';
/** motor de antes: de quanto em quanto tempo o passo de fundo confere de novo (pela saúde) se ele já foi atualizado */
export const COMPACTACAO_RECONFERE_MS = 10 * 60_000;

function gravarMotor(db: Db, ids: string[], v: string): void {
  for (const ws of ids) if (getSetting(db, ws, COMPACTAR_MOTOR) !== v) setSetting(db, ws, COMPACTAR_MOTOR, v);
}

/**
 * Deixa o motor com a escolha (se houver) e grava, em cada workspace do motor, o que ele confirmou. Sem escolha, nada é
 * gravado no motor: ele fica com o que tem (ligado pela migração do cofre). Devolve o que o motor ficou; null = motor sem a
 * ponte da compactação (versão anterior: as capacidades da saúde não trazem "compactacao", ou a rota responde 404) — fica
 * gravado SEM_COMPACTACAO e a tela diz que a opção chega com a próxima atualização da equipe; a rota que não existe não é
 * chamada. Erro de rede sobe (quem chama tenta de novo depois).
 */
export async function sincronizarCompactacao(db: Db, control: HermesControlClient | null, ids: string[]): Promise<boolean | null> {
  if (!control?.compactacao || !control.setCompactacao) return null;
  // as capacidades que o plugin diz na saúde: motor que respondeu e não tem a compactação é de antes (não insiste na rota)
  const info = control.info ? await control.info().catch(() => null) : null;
  if (info?.ok && !(info.capacidades ?? []).includes(CAPACIDADE_COMPACTACAO)) { gravarMotor(db, ids, SEM_COMPACTACAO); return null; }
  const escolha = compactacaoEscolhida(db, ids);
  let atual = await control.compactacao();
  if (atual !== null && escolha !== null && atual !== escolha) atual = await control.setCompactacao(escolha);
  // null: a rota não existe (plugin anterior, 404) — nada a gravar nele
  gravarMotor(db, ids, atual === null ? SEM_COMPACTACAO : atual ? '1' : '0');
  return atual;
}

/**
 * O que vale para a equipe destes workspaces e se o motor ainda não confirmou a escolha. Sem escolha: o que o motor
 * confirmou (ligada, se ele ainda não disse nada). `atualizacao`: o motor é de antes da compactação mais cedo — a tela
 * mostra a escolha da pessoa (ligada por padrão) e diz que ela chega com a próxima atualização da equipe, em vez de dizer
 * que já vale ou que "ainda não recebeu" (ela só recebe com a atualização).
 */
export function compactacaoDaEquipe(db: Db, ids: string[]): { ligada: boolean; pendente: boolean; atualizacao: boolean } {
  const escolha = compactacaoEscolhida(db, ids);
  const motor = ultimaEntre(db, COMPACTAR_MOTOR, ids);
  if (motor === SEM_COMPACTACAO) return { ligada: escolha ?? true, pendente: false, atualizacao: true };
  if (escolha === null) return { ligada: motor !== '0', pendente: false, atualizacao: false };
  return { ligada: escolha, pendente: motor !== (escolha ? '1' : '0'), atualizacao: false };
}


// ---------------------------------------------------------------- composição das chamadas
export interface PartesTokens { base: number; ergon: number; competencias: number; ferramentas: number; memoria: number; anexos: number; conversa: number }
export interface ComposicaoExecucao extends PartesTokens {
  chamadas: number;
  /** total de entrada das chamadas (informado pelo provedor; nas que ele não informou, estimado pelo tamanho) */
  entrada: number;
  cacheLido: number;
  /** a medição está completa: o provedor informou o total de todas as chamadas, nenhuma chamada do pedido ficou sem
   *  registro e a soma bate com o total que o motor informou para a execução */
  informado: boolean;
  /** as definições das ferramentas bateram com as que foram ao modelo em todas as chamadas */
  ferramentasExato: boolean;
  /** quantas vezes o motor resumiu a parte antiga da conversa durante a execução (rc.26; 0 = não resumiu ou não informa) */
  compactacoes: number;
}
const CHARS_POR_TOKEN = 4;
const PARTES = ['base', 'ergon', 'competencias', 'ferramentas', 'memoria', 'anexos', 'conversa'] as const;

/**
 * Soma as chamadas de uma execução, em tokens por parte. `ergonChars`: o tamanho das instruções que o Ergon mandou (ficam
 * no fim do prompt de sistema; nunca mais que o que sobra dele depois da memória e das competências). `anexoChars`: o
 * tamanho, na mensagem do pedido, do que o sistema juntou a ele (anexos, documentos citados, dados das contas); vai em
 * toda chamada da execução e sai da conversa. `anexoAntesChars`: o que ele juntou aos pedidos anteriores da mesma conversa
 * (continuam no histórico até o motor resumir a conversa: na chamada que leva o resumo, eles já não contam, e o deste
 * pedido não passa do trecho fora do resumo). As duas juntas nunca passam do tamanho da conversa da chamada.
 */
export function compor(chamadas: ChamadaMedida[], ergonChars: number, anexoChars = 0, anexoAntesChars = 0, resumoAntes = 0): ComposicaoExecucao {
  const out: ComposicaoExecucao = { chamadas: 0, base: 0, ergon: 0, competencias: 0, ferramentas: 0, memoria: 0, anexos: 0, conversa: 0, entrada: 0, cacheLido: 0, informado: true, ferramentasExato: true,
    compactacoes: contarCompactacoes(chamadas, resumoAntes) };
  const soma: PartesTokens = { base: 0, ergon: 0, competencias: 0, ferramentas: 0, memoria: 0, anexos: 0, conversa: 0 };
  const juntado = Math.max(0, anexoChars) + Math.max(0, anexoAntesChars);
  for (const c of chamadas) {
    const memoria = Math.min(c.memoria, c.sistema);
    const competencias = Math.min(c.competencias, c.sistema - memoria);
    const resto = Math.max(0, c.sistema - memoria - competencias);
    const ergon = Math.min(Math.max(0, ergonChars), resto);
    // conversa resumida nesta chamada (rc.26): os anexos dos pedidos anteriores viraram parte do resumo e já não vão ao
    // modelo; o deste pedido fica no trecho recente, fora do resumo (o motor guarda o fim da conversa inteiro) — nunca
    // maior que esse trecho. Estimativa, como o resto da parte dos anexos
    const anexos = c.resumo !== undefined && c.resumo > 0
      ? Math.min(Math.max(0, anexoChars), Math.max(0, c.conversa - c.resumo))
      : Math.min(juntado, c.conversa);
    const chars: PartesTokens = { base: resto - ergon, ergon, competencias, ferramentas: c.ferramentas, memoria, anexos, conversa: c.conversa - anexos };
    const totalChars = PARTES.reduce((s, k) => s + chars[k], 0);
    if (!totalChars) continue;
    const total = c.uso?.entrada ?? Math.ceil(totalChars / CHARS_POR_TOKEN);
    for (const k of PARTES) soma[k] += (total * chars[k]) / totalChars;
    out.chamadas++;
    out.entrada += total;
    out.cacheLido += Math.min(c.uso?.cacheLido ?? 0, total);
    if (!c.uso) out.informado = false;
    if (!c.ferramentasExato) out.ferramentasExato = false;
  }
  for (const k of PARTES) out[k] = Math.round(soma[k]);
  if (!out.chamadas) { out.informado = false; out.ferramentasExato = false; }
  return out;
}

/**
 * Quantas vezes a conversa foi resumida nestas chamadas (em ordem): o motor troca a parte antiga da conversa por um resumo,
 * e o plugin mede o tamanho dele em cada chamada. Resumo que aparece, ou que muda de tamanho de uma chamada para a
 * seguinte, é um resumo novo (o Hermes refaz o resumo inteiro a cada compactação). `resumoAntes`: o tamanho do resumo na
 * chamada anterior a estas na mesma sessão (a última do pedido anterior; 0 = sem resumo ou sem registro): a conversa que já
 * vinha resumida de outro pedido não conta de novo. Chamada de motor que não informa o resumo: não conta e não muda nada.
 */
export function contarCompactacoes(chamadas: ChamadaMedida[], resumoAntes = 0): number {
  let antes = Math.max(0, resumoAntes);
  let n = 0;
  for (const c of chamadas) {
    if (c.resumo === undefined) continue;
    if (c.resumo > 0 && c.resumo !== antes) n++;
    antes = c.resumo;
  }
  return n;
}

/** folga em volta da execução, depois de compensado o desvio entre o relógio do motor e o do servidor */
const FOLGA_MS = 2000;

/**
 * As chamadas desta execução entre as da sessão. Cada pedido do motor tem a sua marca (turno, igual em todas as chamadas
 * dele, inclusive depois de o motor resumir a conversa e trocar de sessão): fica o pedido que começou dentro da janela da
 * execução (o de mais chamadas nela, se houver mais de um), com todas as chamadas dele; a janela só escolhe qual. Assim,
 * a última chamada do pedido anterior, que terminou um instante antes (mensagem posta na fila), não entra, e uma chamada
 * que caiu fora da janela por diferença de relógio não sai. Sem marca (motor que não a informa), vale a janela.
 * `completa`: as chamadas vão de 1 a N sem falta (o número recomeça a cada pedido).
 */
export function chamadasDaExecucao(todas: ChamadaMedida[], desdeMs: number, ateMs: number): { chamadas: ChamadaMedida[]; completa: boolean } {
  const naJanela = (c: ChamadaMedida) => c.t * 1000 >= desdeMs && c.t * 1000 <= ateMs;
  const dentro = todas.filter(naJanela);
  const seq = (cs: ChamadaMedida[]) => { const ns = cs.map((c) => c.n).sort((a, b) => a - b); return ns.length > 0 && ns.every((n, i) => n === i + 1); };
  const turnos = [...new Set(dentro.map((c) => c.turno).filter(Boolean))];
  if (!turnos.length) return { chamadas: dentro, completa: seq(dentro) };
  let melhor: { cs: ChamadaMedida[]; comeca: boolean; nela: number; primeiro: number } | null = null;
  for (const turno of turnos) {
    const cs = todas.filter((c) => c.turno === turno).sort((a, b) => a.t - b.t);
    const cand = { cs, comeca: cs[0].t * 1000 >= desdeMs, nela: cs.filter(naJanela).length, primeiro: cs[0].t };
    const melhorQue = !melhor || (cand.comeca !== melhor.comeca ? cand.comeca
      : cand.nela !== melhor.nela ? cand.nela > melhor.nela : cand.primeiro > melhor.primeiro);
    if (melhorQue) melhor = cand;
  }
  return { chamadas: melhor!.cs, completa: seq(melhor!.cs) };
}

/**
 * Depois de uma execução real: lê no motor as chamadas da sessão dela e grava a soma das que são desta execução. Sem a
 * medição no motor (versão anterior), sem sessão ou sem chamadas: nada é gravado (a tela mostra só o que foi medido).
 */
export async function medirExecucao(db: Db, control: HermesControlClient | null, runId: string): Promise<ComposicaoExecucao | null> {
  if (!control?.medicao) return null;
  const r = db.get<{ workspace_id: string; agent_id: string; mode: string; hermes_session_id: string | null; instructions: string | null; started_at: string | null; created_at: string;
    finished_at: string | null; context_chars: number | null; tokens_in: number | null }>(
    'SELECT workspace_id, agent_id, mode, hermes_session_id, instructions, started_at, created_at, finished_at, context_chars, tokens_in FROM runs WHERE id = ?', runId);
  if (!r || r.mode !== 'real' || !r.hermes_session_id) return null;
  const inicio = Date.parse(r.started_at ?? r.created_at);
  const fim = r.finished_at ? Date.parse(r.finished_at) : Date.now();
  const pedido = Date.now();
  let m: MedicaoSessao;
  try { m = await control.medicao(r.hermes_session_id, 0); } catch { return null; }
  // o relógio do motor (a máquina do Podman, no WSL2) costuma se desviar do relógio do Windows, sobretudo depois de o
  // computador dormir: compensa pelo relógio que o motor informou na resposta (meio do caminho entre pedir e receber)
  const desvio = m.agoraMs !== null ? m.agoraMs - (pedido + Date.now()) / 2 : 0;
  const sel = chamadasDaExecucao(m.chamadas, inicio - FOLGA_MS + desvio, fim + FOLGA_MS + desvio);
  if (!sel.chamadas.length) return null;
  // o que o sistema juntou aos pedidos anteriores desta conversa no motor (continua no histórico dela)
  const antes = Number(db.get<{ n: number }>(
    'SELECT COALESCE(SUM(context_chars), 0) AS n FROM runs WHERE hermes_session_id = ? AND id != ? AND created_at < ?', r.hermes_session_id, runId, r.created_at)?.n ?? 0);
  // a conversa resumida: em ordem, e o resumo da chamada de antes delas na sessão (o pedido anterior), para a conversa que
  // já vinha resumida não contar de novo
  const desta = [...sel.chamadas].sort((a, b) => a.t - b.t || a.n - b.n);
  const anterior = m.chamadas.filter((c) => c.t < desta[0].t && !sel.chamadas.includes(c)).sort((a, b) => a.t - b.t).at(-1);
  const comp = compor(desta, (r.instructions ?? '').length, r.context_chars ?? 0, antes, anterior?.resumo ?? 0);
  if (!comp.chamadas) return null;
  // medição que não fecha: chamada do pedido sem registro, ou a soma longe do total que o motor informou para a execução
  if (!sel.completa) comp.informado = false;
  if (comp.informado && r.tokens_in && Math.abs(comp.entrada - r.tokens_in) > Math.max(50, r.tokens_in * 0.05)) comp.informado = false;
  db.run(`INSERT INTO run_composicao (run_id, workspace_id, agent_id, chamadas, base, ergon, competencias, ferramentas, memoria, anexos, conversa, entrada, cache_lido, informado, ferramentas_exato, compactacoes, medido_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (run_id) DO UPDATE SET chamadas = excluded.chamadas, base = excluded.base, ergon = excluded.ergon, competencias = excluded.competencias,
            ferramentas = excluded.ferramentas, memoria = excluded.memoria, anexos = excluded.anexos, conversa = excluded.conversa, entrada = excluded.entrada,
            cache_lido = excluded.cache_lido, informado = excluded.informado, ferramentas_exato = excluded.ferramentas_exato, compactacoes = excluded.compactacoes,
            medido_em = excluded.medido_em`,
  runId, r.workspace_id, r.agent_id, comp.chamadas, comp.base, comp.ergon, comp.competencias, comp.ferramentas, comp.memoria, comp.anexos, comp.conversa,
  comp.entrada, comp.cacheLido, comp.informado ? 1 : 0, comp.ferramentasExato ? 1 : 0, comp.compactacoes, now());
  return comp;
}

// ---------------------------------------------------------------- o resumo para a tela
/** frações (0 a 1) do que entra em cada chamada; anexos = o que o sistema juntou aos pedidos (anexos, documentos, contas) */
export interface Fatias { instrucoes: number; ferramentas: number; memoria: number; anexos: number; conversa: number }
export interface ComposicaoAgente {
  agentId: string; nome: string; execucoes: number; chamadas: number;
  /** tamanho médio de cada chamada (tokens de entrada) */
  mediaPorChamada: number;
  partes: Fatias;
  /** de que são feitas as instruções, em frações do total: as do Ergon para o agente, a base da equipe e a lista de competências */
  instrucoes: { agente: number; base: number; competencias: number };
  /** fração da entrada que o provedor reaproveitou do cache (null = não informou nada) */
  cache: number | null;
  /** alguma execução teve medição incompleta (total estimado pelo tamanho, chamada sem registro ou soma que não fecha) */
  estimado: boolean;
  /** em quantas execuções (pedidos) a conversa foi resumida pelo caminho (rc.26): a parte antiga virou um resumo */
  resumidas: number;
}
export interface ComposicaoResumo { dias: number; agentes: ComposicaoAgente[]; geral: ComposicaoAgente | null }

type Soma = { execucoes: number; chamadas: number; base: number; ergon: number; competencias: number; ferramentas: number;
  memoria: number; anexos: number; conversa: number; entrada: number; cache_lido: number; informado: number; resumidas: number };
const SOMAS = `COUNT(*) AS execucoes, SUM(c.chamadas) AS chamadas, SUM(c.base) AS base, SUM(c.ergon) AS ergon, SUM(c.competencias) AS competencias,
  SUM(c.ferramentas) AS ferramentas, SUM(c.memoria) AS memoria, SUM(c.anexos) AS anexos, SUM(c.conversa) AS conversa, SUM(c.entrada) AS entrada,
  SUM(c.cache_lido) AS cache_lido, SUM(c.informado) AS informado, SUM(CASE WHEN c.compactacoes > 0 THEN 1 ELSE 0 END) AS resumidas`;

function fatiar(l: Soma, agentId: string, nome: string): ComposicaoAgente {
  const n = (k: keyof Soma) => Number(l[k] ?? 0);
  const instr = n('base') + n('ergon') + n('competencias');
  const tot = instr + n('ferramentas') + n('memoria') + n('anexos') + n('conversa') || 1;
  const f = (x: number) => Math.round((x / tot) * 1000) / 1000;
  return {
    agentId, nome, execucoes: n('execucoes'), chamadas: n('chamadas'), mediaPorChamada: n('chamadas') ? Math.round(n('entrada') / n('chamadas')) : 0,
    partes: { instrucoes: f(instr), ferramentas: f(n('ferramentas')), memoria: f(n('memoria')), anexos: f(n('anexos')), conversa: f(n('conversa')) },
    instrucoes: { agente: f(n('ergon')), base: f(n('base')), competencias: f(n('competencias')) },
    cache: n('informado') > 0 && n('entrada') ? Math.round((n('cache_lido') / n('entrada')) * 1000) / 1000 : null,
    estimado: n('informado') < n('execucoes'),
    resumidas: n('resumidas'),
  };
}

/** Por agente (os 50 que mais gastam), nos últimos `dias`; "Equipe toda" soma todos, não só esses 50. */
export function resumoComposicao(db: Db, workspaceId: string, dias = 30, nowMs = Date.now()): ComposicaoResumo {
  const desde = new Date(nowMs - dias * 86400_000).toISOString();
  const rows = db.all<Soma & { agent_id: string; nome: string | null }>(
    `SELECT c.agent_id, a.name AS nome, ${SOMAS}
       FROM run_composicao c LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.workspace_id = ? AND c.medido_em >= ? GROUP BY c.agent_id ORDER BY SUM(c.entrada) DESC LIMIT 50`, workspaceId, desde);
  const agentes = rows.map((l) => fatiar(l, l.agent_id, l.nome ?? 'agente removido'));
  if (!rows.length) return { dias, agentes, geral: null };
  const tudo = db.get<Soma>(`SELECT ${SOMAS} FROM run_composicao c WHERE c.workspace_id = ? AND c.medido_em >= ?`, workspaceId, desde)!;
  return { dias, agentes, geral: fatiar(tudo, '', 'Equipe toda') };
}
