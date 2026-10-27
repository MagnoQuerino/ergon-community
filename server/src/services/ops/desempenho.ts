/**
 * Operação "analise-desempenho": desempenho de entregas por responsável a partir de uma planilha de tarefas (CSV).
 * Determinística — todos os números são contados pelo Ergon a partir do arquivo; nenhum é estimado por IA. Genérica:
 * serve a qualquer equipe que tenha uma lista de tarefas com responsável, prazos e situação.
 *
 * Esquema (cabeçalhos aceitos sem acento e sem diferença de maiúsculas; ver ALIASES):
 *   id · titulo (opcional) · responsavel · prazo_original · prazo_vigente (vazio = original) · data_conclusao · situacao
 *
 * Regras (data de referência explícita, AAAA-MM-DD; datas sem hora):
 *   concluída        situação de conclusão (concluída, feito, done, entregue…)
 *   aberta           qualquer outra situação reconhecida (em andamento, pendente, a fazer, bloqueada…)
 *   aberta em atraso aberta com prazo vigente ANTES da data de referência (vencer no próprio dia não é atraso)
 *   alteração        prazo vigente diferente do prazo original
 *   no prazo X       concluída com data de conclusão ≤ prazo X; denominador = concluídas COM data de conclusão
 * Inconsistências (listadas no relatório): linha sem id, responsável ou prazo original válido, situação desconhecida
 * ou data inválida → linha fora da análise; id repetido → só a primeira conta; concluída sem data → conta como
 * concluída, fora do cumprimento de prazo; aberta com data de conclusão → vale a situação (aberta).
 */
import { parseDate, toCsv, type CsvTable } from '../csv.ts';

export const OP_VERSION = 'analise-desempenho v1';

type Field = 'id' | 'titulo' | 'responsavel' | 'prazo_original' | 'prazo_vigente' | 'data_conclusao' | 'situacao';
const ALIASES: Record<Field, string[]> = {
  id: ['id', 'id_tarefa', 'tarefa_id', 'codigo', 'cod', 'n', 'numero', 'num', 'chave', 'key'],
  titulo: ['titulo', 'tarefa', 'title', 'nome', 'descricao', 'assunto', 'atividade'],
  responsavel: ['responsavel', 'dono', 'owner', 'assignee', 'atribuido_a', 'atribuida_a', 'executor', 'pessoa'],
  prazo_original: ['prazo_original', 'prazo_inicial', 'data_limite_original', 'prazo_previsto', 'due_original', 'original_due_date', 'baseline'],
  prazo_vigente: ['prazo_vigente', 'prazo_atual', 'prazo', 'novo_prazo', 'data_limite', 'due', 'due_date', 'prazo_revisado'],
  data_conclusao: ['data_conclusao', 'conclusao', 'concluida_em', 'concluido_em', 'data_de_conclusao', 'data_entrega', 'entregue_em', 'completed', 'completed_at', 'done_at'],
  situacao: ['situacao', 'status', 'estado', 'fase'],
};
const REQUIRED: Field[] = ['id', 'responsavel', 'prazo_original', 'situacao'];
const DONE = ['concluida', 'concluido', 'feito', 'feita', 'done', 'fechada', 'fechado', 'finalizada', 'finalizado', 'entregue', 'completed', 'complete', 'closed', 'resolvida', 'resolvido', 'encerrada', 'encerrado'];
const OPEN = ['aberta', 'aberto', 'em_andamento', 'andamento', 'pendente', 'a_fazer', 'fazer', 'todo', 'to_do', 'open', 'in_progress', 'doing', 'atrasada', 'atrasado', 'bloqueada', 'bloqueado', 'em_revisao', 'revisao', 'nao_iniciada', 'nao_iniciado', 'backlog', 'aguardando', 'pausada', 'fazendo'];

const key = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface Indicators {
  total: number; concluidas: number; abertas: number; abertasEmAtraso: number; alteracoesDePrazo: number;
  concluidasComData: number; noPrazoOriginal: number; noPrazoVigente: number;
  /** percentuais sobre as concluídas com data (null = sem denominador) */
  pctPrazoOriginal: number | null; pctPrazoVigente: number | null;
}
export interface Row { linha: number; id: string; titulo: string; responsavel: string; prazoOriginal: string; prazoVigente: string; conclusao: string | null; concluida: boolean }
export interface Issue { linha: number; id: string | null; motivo: string; excluida: boolean }
export interface Performance {
  referencia: string; colunas: Record<Field, string | null>; lidas: number; validas: number;
  geral: Indicators; porResponsavel: Array<{ responsavel: string } & Indicators>;
  abertasEmAtraso: Row[]; alteracoes: Row[]; problemas: Issue[];
}

export class SchemaError extends Error {
  readonly missing: string[];
  constructor(missing: string[], found: string[]) {
    super(`Faltam colunas obrigatórias: ${missing.join(', ')}. Colunas encontradas: ${found.join(', ') || '(nenhuma)'}.`);
    this.missing = missing;
  }
}

/** Qual coluna do arquivo é cada campo do esquema. */
export function mapColumns(headers: string[]): Record<Field, number | null> {
  const keys = headers.map(key);
  const out = {} as Record<Field, number | null>;
  for (const f of Object.keys(ALIASES) as Field[]) {
    const idx = keys.findIndex((k, i) => ALIASES[f].includes(k) && !Object.values(out).includes(i));
    out[f] = idx >= 0 ? idx : null;
  }
  return out;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

function indicators(rows: Row[], ref: string): Indicators {
  const done = rows.filter((r) => r.concluida);
  const dated = done.filter((r) => r.conclusao);
  const noOrig = dated.filter((r) => r.conclusao! <= r.prazoOriginal).length;
  const noVig = dated.filter((r) => r.conclusao! <= r.prazoVigente).length;
  return {
    total: rows.length, concluidas: done.length, abertas: rows.length - done.length,
    abertasEmAtraso: rows.filter((r) => !r.concluida && r.prazoVigente < ref).length,
    alteracoesDePrazo: rows.filter((r) => r.prazoVigente !== r.prazoOriginal).length,
    concluidasComData: dated.length, noPrazoOriginal: noOrig, noPrazoVigente: noVig,
    pctPrazoOriginal: pct(noOrig, dated.length), pctPrazoVigente: pct(noVig, dated.length),
  };
}

/** Calcula os indicadores. `referencia` (AAAA-MM-DD) é obrigatória e explícita: nenhum "hoje" escondido. */
export function analyzePerformance(t: CsvTable, referencia: string): Performance {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referencia)) throw new Error('data de referência inválida (AAAA-MM-DD)');
  const col = mapColumns(t.headers);
  const missing = REQUIRED.filter((f) => col[f] === null);
  if (missing.length) throw new SchemaError(missing, t.headers);
  const get = (r: string[], f: Field) => (col[f] === null ? '' : (r[col[f]!] ?? '').trim());
  const rows: Row[] = []; const problemas: Issue[] = []; const seen = new Set<string>();
  t.rows.forEach((r, i) => {
    const linha = t.lines[i] ?? i + 2;
    const id = get(r, 'id');
    const bad = (motivo: string) => problemas.push({ linha, id: id || null, motivo, excluida: true });
    if (r.every((c) => !c.trim())) return;
    if (!id) return bad('sem id');
    if (seen.has(id)) return bad(`id ${id} repetido (só a primeira linha conta)`);
    const resp = get(r, 'responsavel').replace(/\s+/g, ' ');
    if (!resp) return bad('sem responsável');
    const po = parseDate(get(r, 'prazo_original'));
    if (!po) return bad(po === null ? 'sem prazo original' : `prazo original inválido ("${get(r, 'prazo_original')}")`);
    const pvRaw = get(r, 'prazo_vigente'); const pv = pvRaw ? parseDate(pvRaw) : po;
    if (!pv) return bad(`prazo vigente inválido ("${pvRaw}")`);
    const st = key(get(r, 'situacao'));
    const concluida = DONE.includes(st) ? true : OPEN.includes(st) ? false : null;
    if (concluida === null) return bad(`situação desconhecida ("${get(r, 'situacao') || 'vazia'}")`);
    const dcRaw = get(r, 'data_conclusao'); const dc = dcRaw ? parseDate(dcRaw) : null;
    if (dc === undefined) return bad(`data de conclusão inválida ("${dcRaw}")`);
    seen.add(id);
    if (concluida && !dc) problemas.push({ linha, id, motivo: 'concluída sem data de conclusão: conta como concluída, fora do cumprimento de prazo', excluida: false });
    if (!concluida && dc) problemas.push({ linha, id, motivo: 'aberta com data de conclusão: vale a situação (aberta)', excluida: false });
    if (concluida && dc && dc > referencia) problemas.push({ linha, id, motivo: `concluída depois da data de referência (${dc})`, excluida: false });
    rows.push({ linha, id, titulo: get(r, 'titulo'), responsavel: resp, prazoOriginal: po, prazoVigente: pv, conclusao: concluida ? dc : null, concluida });
  });
  const groups = new Map<string, { nome: string; rows: Row[] }>();
  for (const r of rows) {
    const k = key(r.responsavel);
    const g = groups.get(k) ?? { nome: r.responsavel, rows: [] };
    g.rows.push(r); groups.set(k, g);
  }
  return {
    referencia, lidas: t.rows.length, validas: rows.length,
    colunas: Object.fromEntries((Object.keys(ALIASES) as Field[]).map((f) => [f, col[f] === null ? null : t.headers[col[f]!]])) as Record<Field, string | null>,
    geral: indicators(rows, referencia),
    porResponsavel: [...groups.values()].map((g) => ({ responsavel: g.nome, ...indicators(g.rows, referencia) }))
      .sort((a, b) => a.responsavel.localeCompare(b.responsavel, 'pt-BR')),
    abertasEmAtraso: rows.filter((r) => !r.concluida && r.prazoVigente < referencia).sort((a, b) => a.prazoVigente.localeCompare(b.prazoVigente)),
    alteracoes: rows.filter((r) => r.prazoVigente !== r.prazoOriginal),
    problemas,
  };
}

const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const pctTxt = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** CSV de indicadores (reproduzível: as mesmas contas do relatório, uma linha por escopo). */
export function indicatorsCsv(p: Performance): string {
  const head = ['escopo', 'responsavel', 'total', 'concluidas', 'abertas', 'abertas_em_atraso', 'alteracoes_de_prazo', 'concluidas_com_data',
    'no_prazo_original', 'pct_prazo_original', 'no_prazo_vigente', 'pct_prazo_vigente', 'data_referencia'];
  const n = (v: number | null) => (v === null ? '' : v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const line = (escopo: string, resp: string, i: Indicators) => [escopo, resp, i.total, i.concluidas, i.abertas, i.abertasEmAtraso, i.alteracoesDePrazo,
    i.concluidasComData, i.noPrazoOriginal, n(i.pctPrazoOriginal), i.noPrazoVigente, n(i.pctPrazoVigente), p.referencia];
  return toCsv([head, line('geral', '', p.geral), ...p.porResponsavel.map((r) => line('responsavel', r.responsavel, r))]);
}

/** Relatório em Markdown: indicadores, tabelas, destaques calculados, metodologia, qualidade dos dados e limitações. */
export function performanceReport(p: Performance, meta: { pedido: string; tarefa: number; arquivo: string; sha256: string; agente: string; indicadoresArquivo: string }): string {
  const g = p.geral;
  const L: string[] = [];
  L.push(`# Relatório de desempenho por responsável`, '');
  L.push(`- **Pedido:** ${md(meta.pedido)} (tarefa #${meta.tarefa})`);
  L.push(`- **Arquivo analisado:** ${md(meta.arquivo)} (SHA-256 ${meta.sha256.slice(0, 12)}…)`);
  L.push(`- **Data de referência:** ${br(p.referencia)}`);
  L.push(`- **Linhas:** ${p.lidas} lidas · ${p.validas} na análise · ${p.problemas.filter((x) => x.excluida).length} fora (ver Qualidade dos dados)`, '');
  L.push('## Resumo', '', '| Indicador | Valor |', '|---|---:|');
  L.push(`| Total de tarefas | ${g.total} |`, `| Concluídas | ${g.concluidas} |`, `| Abertas | ${g.abertas} |`, `| Abertas em atraso | ${g.abertasEmAtraso} |`);
  L.push(`| Alterações de prazo | ${g.alteracoesDePrazo} |`);
  L.push(`| Concluídas no prazo original | ${g.noPrazoOriginal} de ${g.concluidasComData} (${pctTxt(g.pctPrazoOriginal)}) |`);
  L.push(`| Concluídas no prazo vigente | ${g.noPrazoVigente} de ${g.concluidasComData} (${pctTxt(g.pctPrazoVigente)}) |`, '');
  L.push('## Por responsável', '', '| Responsável | Total | Concluídas | Abertas | Em atraso | Alterações de prazo | No prazo original | No prazo vigente |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of p.porResponsavel) {
    L.push(`| ${md(r.responsavel)} | ${r.total} | ${r.concluidas} | ${r.abertas} | ${r.abertasEmAtraso} | ${r.alteracoesDePrazo} | ${r.noPrazoOriginal}/${r.concluidasComData} (${pctTxt(r.pctPrazoOriginal)}) | ${r.noPrazoVigente}/${r.concluidasComData} (${pctTxt(r.pctPrazoVigente)}) |`);
  }
  L.push('', '## Destaques', '');
  const withDone = p.porResponsavel.filter((r) => r.concluidasComData > 0);
  const hl: string[] = [];
  if (g.abertasEmAtraso) {
    const worst = [...p.porResponsavel].sort((a, b) => b.abertasEmAtraso - a.abertasEmAtraso)[0];
    hl.push(`${g.abertasEmAtraso} tarefa(s) aberta(s) em atraso; a maior parte com ${md(worst.responsavel)} (${worst.abertasEmAtraso}).`);
  } else hl.push('Nenhuma tarefa aberta está em atraso na data de referência.');
  if (withDone.length > 1) {
    const best = [...withDone].sort((a, b) => (b.pctPrazoVigente ?? 0) - (a.pctPrazoVigente ?? 0))[0];
    const worst = [...withDone].sort((a, b) => (a.pctPrazoVigente ?? 0) - (b.pctPrazoVigente ?? 0))[0];
    if (best.responsavel !== worst.responsavel) hl.push(`Maior cumprimento do prazo vigente: ${md(best.responsavel)} (${pctTxt(best.pctPrazoVigente)}); menor: ${md(worst.responsavel)} (${pctTxt(worst.pctPrazoVigente)}).`);
  }
  if (g.concluidasComData && g.noPrazoVigente > g.noPrazoOriginal) hl.push(`Alterações de prazo explicam ${g.noPrazoVigente - g.noPrazoOriginal} entrega(s) que só cumprem o prazo vigente (não o original).`);
  if (g.alteracoesDePrazo) hl.push(`${g.alteracoesDePrazo} de ${g.total} tarefas (${pctTxt(pct(g.alteracoesDePrazo, g.total))}) tiveram o prazo alterado.`);
  L.push(...hl.map((h) => `- ${h}`), '');
  L.push('## Abertas em atraso', '');
  if (p.abertasEmAtraso.length) {
    L.push('| ID | Tarefa | Responsável | Prazo vigente | Dias de atraso |', '|---|---|---|---|---:|');
    for (const r of p.abertasEmAtraso) L.push(`| ${md(r.id)} | ${md(r.titulo || '—')} | ${md(r.responsavel)} | ${br(r.prazoVigente)} | ${daysBetween(r.prazoVigente, p.referencia)} |`);
  } else L.push('Nenhuma.');
  L.push('', '## Alterações de prazo', '');
  if (p.alteracoes.length) {
    L.push('| ID | Tarefa | Responsável | Prazo original | Prazo vigente | Diferença (dias) |', '|---|---|---|---|---|---:|');
    for (const r of p.alteracoes) L.push(`| ${md(r.id)} | ${md(r.titulo || '—')} | ${md(r.responsavel)} | ${br(r.prazoOriginal)} | ${br(r.prazoVigente)} | ${daysBetween(r.prazoOriginal, r.prazoVigente)} |`);
  } else L.push('Nenhuma.');
  L.push('', '## Metodologia', '');
  L.push(`- **Colunas usadas:** ${Object.entries(p.colunas).map(([f, c]) => `${f} = ${c ? `"${md(c)}"` : '(ausente)'}`).join('; ')}.`);
  L.push('- **Concluída:** situação de conclusão (concluída, feito, entregue, done…). **Aberta:** qualquer outra situação reconhecida.');
  L.push(`- **Aberta em atraso:** aberta com prazo vigente anterior à data de referência (${br(p.referencia)}); vencer no próprio dia não é atraso.`);
  L.push('- **Alteração de prazo:** prazo vigente diferente do original (prazo vigente vazio = original).');
  L.push('- **Cumprimento do prazo (original e vigente):** concluídas com data de conclusão até o prazo, inclusive. Denominador: concluídas **com** data de conclusão.');
  L.push('- Datas sem hora, como estão no arquivo (AAAA-MM-DD ou DD/MM/AAAA; formato mês/dia não é adivinhado). Responsáveis agrupados sem diferença de maiúsculas e acentos.');
  L.push(`- Todos os números foram contados pelo Ergon a partir do arquivo (operação ${OP_VERSION}); nenhum foi estimado por IA. Os mesmos valores estão em ${md(meta.indicadoresArquivo)}.`, '');
  L.push('## Qualidade dos dados', '');
  if (p.problemas.length) {
    L.push('| Linha | ID | Situação | Efeito |', '|---:|---|---|---|');
    for (const x of p.problemas) L.push(`| ${x.linha} | ${md(x.id ?? '—')} | ${md(x.motivo)} | ${x.excluida ? 'fora da análise' : 'mantida (ver regra)'} |`);
  } else L.push('Nenhum problema encontrado: todas as linhas entraram na análise.');
  L.push('', '## Limitações', '');
  L.push('- O resultado vale para o que está no arquivo: tarefas fora dele, mudanças de responsável e o motivo de cada alteração de prazo não aparecem.');
  L.push('- Cumprimento de prazo é binário (no prazo ou não); a quantidade de dias de atraso das concluídas não entra nos percentuais.');
  if (g.concluidasComData < g.concluidas) L.push(`- ${g.concluidas - g.concluidasComData} concluída(s) sem data de conclusão ficaram fora do cumprimento de prazo.`);
  if (p.porResponsavel.some((r) => r.total < 3)) L.push('- Responsáveis com poucas tarefas (menos de 3) têm percentuais sensíveis a uma única entrega.');
  L.push('', '---', `Gerado pelo Ergon (${OP_VERSION}) para a tarefa #${meta.tarefa}, a pedido de ${md(meta.agente)}. Nenhum número estimado por IA.`, '');
  return L.join('\n');
}
