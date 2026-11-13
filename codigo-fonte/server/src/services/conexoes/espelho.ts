/**
 * Correlação direta com os aplicativos de tarefas: o que a pessoa faz no Ergon num quadro espelhado (dar check, mover de
 * coluna, editar, criar) vai para o aplicativo por esta fila. A tela responde na hora; o envio segue atrás, repete se o
 * serviço estiver fora e, se falhar de vez, o card mostra o motivo. Só o que a própria pessoa fez entra aqui: o que chega
 * de fora (mensagem de canal) ou de um agente não passa por este caminho, e o agente usa as ações com a regra de confirmação.
 * O ajuste de cada ação em Conexões vale aqui também: desligar "concluir" para o check, desligar "criar" não para os outros.
 */
import type { Db } from '../../db/db.ts';
import { clip, id, now } from '../../lib/util.ts';
import { audit, type Bus } from '../bus.ts';
import type { IntegrationKind } from '../integrations.ts';
import { ProviderError } from '../mirror.ts';
import { ErroAcao, type EscritorTarefas, type MudancaTarefa, type NovaTarefa } from './tipos.ts';

// carregados na hora do envio: o catálogo e as integrações dependem deste arquivo por outros caminhos (mirror.ts), e
// importar aqui no topo fecharia o ciclo na carga
const catalogo = () => import('./catalogo.ts');
const integracoes = () => import('../integrations.ts');

export type OpEspelho =
  | { tipo: 'concluir'; feita: boolean }
  | { tipo: 'mover'; coluna: string }
  | { tipo: 'editar'; mudanca: MudancaTarefa }
  | { tipo: 'criar'; tarefa: NovaTarefa };

const MAX_TENTATIVAS = 8;
const TICK_MS = 15_000;
/** a ação de Conexões que cada operação usa (e cujo ajuste vale para ela) */
const ACAO: Record<OpEspelho['tipo'], { id: string; nome: string }> = {
  criar: { id: 'tarefa.criar', nome: 'criar tarefa' }, concluir: { id: 'tarefa.concluir', nome: 'concluir tarefa' },
  mover: { id: 'tarefa.mover', nome: 'mover tarefa' }, editar: { id: 'tarefa.editar', nome: 'editar tarefa' },
};
let acordar: (() => void) | null = null;

/** a coluna do card que cada campo de uma edição muda */
const CAMPO_LOCAL: Record<string, string> = { titulo: 'title', descricao: 'description', prazo: 'due_on' };

/** Tipo em claro: um envio que deu certo encerra os mais antigos do mesmo tipo que tinham falhado. */
const tipoDe = (op: OpEspelho): string => (op.tipo === 'editar' ? `editar:${Object.keys(op.mudanca).sort().join(',')}` : op.tipo);

/** Numa transação de quem alterou a tarefa: se o envio falhar depois, a alteração local continua e o card mostra o motivo. */
export function enfileirarEspelho(db: Db, workspaceId: string, taskId: string, op: OpEspelho): void {
  const ts = now();
  db.run("INSERT INTO mirror_outbox (id, workspace_id, task_id, op, tipo, status, next_at, created_at) VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)",
    id('mox'), workspaceId, taskId, db.seal(workspaceId, JSON.stringify(op)), tipoDe(op), ts, ts);
  if (acordar) setImmediate(acordar);
}

/**
 * Tarefa com escrita a caminho: a leitura do espelho não a toca nesta passada. `desde`: quando a leitura começou; uma
 * escrita que entrou ou terminou depois disso também conta, porque a foto do aplicativo é mais velha que ela.
 */
export function escritaPendente(db: Db, taskId: string, desde?: string): boolean {
  if (db.get("SELECT 1 AS x FROM mirror_outbox WHERE task_id = ? AND status IN ('pendente', 'enviando') LIMIT 1", taskId)) return true;
  return !!desde && !!db.get('SELECT 1 AS x FROM mirror_outbox WHERE task_id = ? AND (created_at >= ? OR done_at >= ?) LIMIT 1', taskId, desde, desde);
}

interface Linha { id: string; workspace_id: string; task_id: string; op: string; tipo: string; attempts: number; created_at: string; seq: number }
interface Destino { kind: string; /** qual das contas do aplicativo (a do quadro) */ conta: string; connection_id: string; quadro: string; externo: string | null; settings: string; arquivada: number }

export class EspelhoEscrita {
  private readonly db: Db; private readonly bus: Bus;
  private readonly escritor: (ws: string, kind: string, conta?: string) => EscritorTarefas | null;
  private timer: NodeJS.Timeout | null = null;
  private ocupado = false;
  private denovo = false;
  private parado = false;
  private passada: Promise<void> | null = null;
  constructor(db: Db, bus: Bus, escritor: (ws: string, kind: string, conta?: string) => EscritorTarefas | null) { this.db = db; this.bus = bus; this.escritor = escritor; }

  start(): void {
    this.parado = false;
    const vai = () => { this.tick().catch(() => undefined); }; // tick não deixa erro escapar; isto é só a última rede
    acordar = vai;
    this.timer = setInterval(vai, TICK_MS);
    this.timer.unref?.();
    vai();
  }
  /** Para a fila e espera a passada em andamento terminar (o que saiu para o aplicativo fica gravado antes de desligar). */
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; acordar = null; this.parado = true;
    return this.passada ?? Promise.resolve();
  }

  private destino(taskId: string, workspaceId: string): Destino | null {
    return this.db.get<Destino>(
      `SELECT i.kind, i.conta, b.connection_id, b.external_id AS quadro, l.external_id AS externo, i.settings, t.archived AS arquivada
         FROM tasks t JOIN boards b ON b.id = t.board_id JOIN integrations i ON i.id = b.connection_id
         LEFT JOIN task_links l ON l.task_id = t.id AND l.connection_id = b.connection_id
        WHERE t.id = ? AND t.workspace_id = ?`, taskId, workspaceId) ?? null;
  }

  /** Envia o que estiver na vez, na ordem; pode ser chamado a qualquer momento (uma passada por vez). */
  tick(): Promise<void> {
    if (this.ocupado) { this.denovo = true; return this.passada ?? Promise.resolve(); }
    this.ocupado = true;
    this.passada = this.passar().finally(() => { this.ocupado = false; this.passada = null; });
    return this.passada;
  }

  private async passar(): Promise<void> {
    let andou: boolean;
    do {
      this.denovo = false; andou = false;
      this.interrompidas();
      // de cada tarefa, só a operação mais antiga que ainda espera: a seguinte só sai depois dela, mesmo entre passadas
      const fila = this.db.all<Linha>(
        `SELECT m.id, m.workspace_id, m.task_id, m.op, m.tipo, m.attempts, m.created_at, m.rowid AS seq FROM mirror_outbox m
          WHERE m.status = 'pendente' AND m.next_at <= ? AND ws_open(m.workspace_id)
            AND NOT EXISTS (SELECT 1 FROM mirror_outbox o WHERE o.task_id = m.task_id AND o.status IN ('pendente', 'enviando')
                             AND (o.created_at < m.created_at OR (o.created_at = m.created_at AND o.rowid < m.rowid)))
          ORDER BY m.created_at, m.rowid LIMIT 50`, now());
      for (const l of fila) {
        if (this.parado) return;
        // um envio desta mesma lista pode ter mudado a linha (vincular passa as do card trazido ao card da pessoa): vai na volta seguinte
        const agora = this.db.get<{ task_id: string; status: string }>('SELECT task_id, status FROM mirror_outbox WHERE id = ?', l.id);
        if (agora?.status !== 'pendente' || agora.task_id !== l.task_id) continue;
        try { if (await this.enviar(l)) andou = true; } catch (e) {
          // erro fora do envio (banco, disco): a linha não derruba a fila nem o servidor. Criar não se repete às cegas
          const msg = e instanceof Error ? e.message : String(e);
          try { if (l.tipo === 'criar') this.falhou(l, `${msg}. Confira no aplicativo antes de criar de novo.`); else this.adiar(l, msg); } catch { /* tenta na próxima passada */ }
        }
      }
    } while ((this.denovo || andou) && !this.parado);
  }

  /** O que ficou "enviando" de um processo que parou no meio: criar pode ter nascido lá (não repete); o resto repete sem risco. */
  private interrompidas(): void {
    const ls = this.db.all<Linha>("SELECT id, workspace_id, task_id, op, tipo, attempts, created_at, rowid AS seq FROM mirror_outbox WHERE status = 'enviando' AND ws_open(workspace_id)");
    for (const l of ls) {
      if (l.tipo === 'criar') this.falhou(l, 'o envio foi interrompido no meio. Confira no aplicativo antes de criar de novo.');
      else this.db.run("UPDATE mirror_outbox SET status = 'pendente' WHERE id = ?", l.id);
    }
  }

  /** true = a linha saiu da fila (feita, falhou ou cancelada): a próxima da mesma tarefa já pode ir. */
  private async enviar(l: Linha): Promise<boolean> {
    let op: OpEspelho;
    try { op = JSON.parse(l.op) as OpEspelho; } catch { return this.falhou(l, 'esta alteração ficou ilegível e não pôde ser enviada'); }
    const d = this.destino(l.task_id, l.workspace_id);
    if (!d) return this.falhou(l, 'o quadro desta tarefa não está mais ligado a uma conexão');
    // o card foi arquivado antes de nascer no aplicativo: a pessoa desistiu dele, nada vai para lá
    if (d.arquivada && !d.externo) return this.cancelar(l, 'cancelada antes de enviar: o card foi arquivado');
    const kind = d.kind as IntegrationKind;
    const acao = ACAO[op.tipo];
    const [{ acoesDe, ajusteDe }, { integrationDef, esquecerLeitura }] = await Promise.all([catalogo(), integracoes()]);
    const a = acoesDe(kind).find((x) => x.id === acao.id)!;
    if (ajusteDe(JSON.parse(d.settings) as Record<string, unknown>, acao.id, typeof a.risco === 'function' ? a.risco({}) : a.risco) === 'desligado') {
      return this.falhou(l, `a ação "${acao.nome}" está desligada em Conexões › ${integrationDef(kind)?.name ?? kind}`);
    }
    let w: EscritorTarefas | null;
    try { w = this.escritor(l.workspace_id, d.kind, d.conta); } catch { return this.falhou(l, 'não deu para ler a credencial desta conexão: conecte de novo em Conexões'); }
    if (!w) return this.falhou(l, 'a conexão não está ligada: confira em Conexões');
    if (op.tipo !== 'criar' && !d.externo) return this.falhou(l, 'a tarefa não chegou a ser criada no aplicativo; tente de novo a criação');
    this.db.run("UPDATE mirror_outbox SET status = 'enviando' WHERE id = ?", l.id);
    try {
      // criar que já nasceu lá (falhou no meio): completa o que faltou, nunca cria uma segunda
      const ligada = op.tipo === 'criar' && d.externo ? await this.completar(w, d.quadro, d.externo, op.tarefa) : null;
      const r = ligada ?? (op.tipo === 'criar' ? await w.criar(d.quadro, op.tarefa)
        : op.tipo === 'concluir' ? await w.concluir(d.quadro, d.externo!, op.feita)
        : op.tipo === 'mover' ? await w.mover(d.quadro, d.externo!, op.coluna)
        : await w.editar(d.quadro, d.externo!, op.mudanca));
      this.db.tx(() => {
        if (op.tipo === 'criar' && !d.externo) this.vincular(l, d, r.id, r.versao ?? null);
        // a versão que o aplicativo devolve pode incluir mudanças de outra pessoa que ainda não foram lidas: sem versão, a
        // próxima leitura compara os campos e traz o que mudou
        else { this.db.run('UPDATE task_links SET external_version = NULL WHERE task_id = ? AND connection_id = ?', l.task_id, d.connection_id); esquecerLeitura(l.workspace_id, d.externo!); }
        this.db.run("UPDATE mirror_outbox SET status = 'feita', attempts = attempts + 1, last_error = NULL, done_at = ? WHERE id = ?", now(), l.id);
        // o que falhou antes, do mesmo tipo, ficou para trás: "Tentar de novo" não desfaz este envio
        this.db.run(`UPDATE mirror_outbox SET status = 'superada', done_at = COALESCE(done_at, ?) WHERE task_id = ? AND tipo = ? AND status = 'falhou'
          AND (created_at < ? OR (created_at = ? AND rowid < ?))`, now(), l.task_id, l.tipo, l.created_at, l.created_at, l.seq);
        this.estadoDoVinculo(l.task_id);
      });
      audit(this.db, this.bus, { workspaceId: l.workspace_id, actorType: 'system', actorId: 'ergon', action: 'mirror.push', targetType: 'task', targetId: l.task_id, evidence: { conexao: d.kind, op: op.tipo }, result: `enviado a ${d.kind}` });
      this.bus.publish(l.workspace_id, 'tasks.changed', { id: l.task_id });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // nasceu no aplicativo e o resto falhou: liga o card a ela, senão a próxima leitura traria um segundo card
      if (op.tipo === 'criar' && !d.externo && e instanceof ErroAcao && e.criado?.id) this.db.tx(() => this.vincular(l, d, e.criado!.id, e.criado!.versao ?? null));
      if (e instanceof ErroAcao || (e instanceof ProviderError && e.kind !== 'unavailable')) return this.falhou(l, msg);
      // resultado incerto: criar de novo poderia duplicar. Concluir, mover e editar dão no mesmo se repetidos
      if (op.tipo === 'criar' && /não confirmou|respondeu 5\d\d/.test(msg)) return this.falhou(l, `${msg}. Confira no aplicativo antes de criar de novo.`);
      if (l.attempts + 1 >= MAX_TENTATIVAS) return this.falhou(l, msg);
      return this.adiar(l, msg);
    }
  }

  /** A tarefa já existe no aplicativo: reaplica descrição, prazo e coluna (o que costuma faltar quando a criação para no meio). */
  private async completar(w: EscritorTarefas, quadro: string, externo: string, t: NovaTarefa): Promise<{ id: string; versao: null }> {
    const m: MudancaTarefa = { ...(t.descricao ? { descricao: t.descricao } : {}), ...(t.prazo ? { prazo: t.prazo } : {}) };
    if (Object.keys(m).length) await w.editar(quadro, externo, m);
    if (t.coluna) await w.mover(quadro, externo, t.coluna);
    return { id: externo, versao: null };
  }

  private vincular(l: Linha, d: Destino, externo: string, versao: string | null): void {
    const ja = this.db.get<{ id: string; task_id: string }>('SELECT id, task_id FROM task_links WHERE connection_id = ? AND external_id = ?', d.connection_id, externo);
    if (ja) {
      // a leitura do quadro achou a tarefa nova primeiro e trouxe um card a mais: o vínculo vem para o card da pessoa (com o
      // que ela fez nele e o que ainda está a caminho) e sai o card trazido pela leitura
      if (ja.task_id !== l.task_id) {
        this.db.run('UPDATE task_links SET task_id = ? WHERE id = ?', l.task_id, ja.id);
        // o que a pessoa fez no card trazido enquanto a criação voltava (check, coluna, edição) passa ao card dela, e o envio junto
        const campos = new Set<string>();
        for (const { tipo } of this.db.all<{ tipo: string }>("SELECT DISTINCT tipo FROM mirror_outbox WHERE task_id = ? AND status = 'pendente'", ja.task_id)) {
          if (tipo === 'concluir') ['completed', 'completed_at', 'completed_by', 'completed_by_user_id'].forEach((c) => campos.add(c));
          else if (tipo === 'mover') campos.add('column_id');
          else for (const k of tipo.replace(/^editar:/, '').split(',')) if (CAMPO_LOCAL[k]) campos.add(CAMPO_LOCAL[k]);
        }
        if (campos.size) {
          const cs = [...campos];
          this.db.run(`UPDATE tasks SET ${cs.map((c) => `${c} = (SELECT ${c} FROM tasks WHERE id = ?)`).join(', ')}, revision = revision + 1, updated_at = ? WHERE id = ?`,
            ...cs.map(() => ja.task_id), now(), l.task_id);
          this.db.run("UPDATE mirror_outbox SET task_id = ? WHERE task_id = ? AND status = 'pendente'", l.task_id, ja.task_id);
        }
        this.db.run('UPDATE tasks SET archived = 1, revision = revision + 1, updated_at = ? WHERE id = ?', now(), ja.task_id);
      }
      return;
    }
    this.db.run("INSERT INTO task_links (id, workspace_id, task_id, connection_id, external_id, external_version, external_extra, sync_state, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 'ok', ?)",
      id('tln'), l.workspace_id, l.task_id, d.connection_id, externo, versao, now());
  }

  /** O aviso do card segue o que ainda falhou e não foi superado; sem nada pendente de falha, o vínculo volta a ok. */
  private estadoDoVinculo(taskId: string): void {
    const resta = this.db.get<{ e: string | null }>("SELECT last_error AS e FROM mirror_outbox WHERE task_id = ? AND status = 'falhou' ORDER BY created_at DESC, rowid DESC LIMIT 1", taskId);
    if (resta) this.db.run("UPDATE task_links SET sync_state = 'escrita_falhou', conflict = ? WHERE task_id = ?", `Não foi enviado ao aplicativo: ${clip(resta.e ?? '', 260)}`, taskId);
    else this.db.run("UPDATE task_links SET sync_state = 'ok', conflict = NULL WHERE task_id = ?", taskId);
  }

  private adiar(l: Linha, motivo: string): boolean {
    const espera = Math.min(6 * 3600_000, 30_000 * 2 ** l.attempts);
    this.db.run("UPDATE mirror_outbox SET status = 'pendente', attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?", new Date(Date.now() + espera).toISOString(), clip(motivo, 300), l.id);
    return false;
  }

  private cancelar(l: Linha, motivo: string): boolean {
    this.db.run("UPDATE mirror_outbox SET status = 'cancelada', last_error = ?, done_at = ? WHERE id = ?", motivo, now(), l.id);
    return true;
  }

  private falhou(l: Linha, motivo: string): boolean {
    const texto = `Não foi enviado ao aplicativo: ${clip(motivo, 260)}`;
    this.db.tx(() => {
      this.db.run("UPDATE mirror_outbox SET status = 'falhou', attempts = attempts + 1, last_error = ?, done_at = ? WHERE id = ?", clip(motivo, 300), now(), l.id);
      this.db.run("UPDATE task_links SET sync_state = 'escrita_falhou', conflict = ? WHERE task_id = ?", texto, l.task_id);
    });
    audit(this.db, this.bus, { workspaceId: l.workspace_id, actorType: 'system', actorId: 'ergon', action: 'mirror.push.error', targetType: 'task', targetId: l.task_id, evidence: { op: l.tipo, erro: clip(motivo, 300) }, result: texto });
    this.bus.publish(l.workspace_id, 'tasks.changed', { id: l.task_id });
    return true;
  }
}
