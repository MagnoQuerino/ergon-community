/**
 * Análise de planilha pelo Ergon (código, determinística): tipo de cada coluna, totais, mínimos, máximos, médias,
 * vazios, repetidos, valores fora da curva, totais por mês (com a variação) e por categoria. O agente comenta e
 * explica; os números vêm daqui — e a conferência da rotina confere que os números do texto estão nestes dados.
 */
import { parseDate, parseNumber, toCsv } from './csv.ts';
import type { Sheet } from './doc-text.ts';

export type ColType = 'numero' | 'data' | 'texto' | 'vazia';
export interface ColumnStat {
  name: string; type: ColType; filled: number; blanks: number;
  sum?: number; min?: number; max?: number; mean?: number; median?: number;
  first?: string; last?: string; distinct?: number; top?: Array<[string, number]>;
  /** linhas (numeração da planilha, cabeçalho = 1) com valor fora da curva */
  outliers?: Array<{ row: number; value: number }>;
}
export interface PeriodTotal { period: string; total: number; count: number }
export interface TableStats {
  name: string; rows: number; cols: number; columns: ColumnStat[]; duplicates: number[];
  byPeriod?: { dateCol: string; valueCol: string; periods: PeriodTotal[]; variation: number | null };
  byCategory?: { catCol: string; valueCol: string; groups: Array<{ name: string; total: number; count: number; share: number }> };
}

/** Número no jeito brasileiro (1.234,56), até 2 casas. */
export const fmt = (n: number, dec = 2) => n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: dec });
const pct = (n: number) => `${fmt(n, 1)}%`;
const VALUE = /valor|value|amount|montante|total|pre[cç]o|receita|despesa|custo|saldo|qtd|quantidade|faturamento|vendas/i;
const DATE = /data|date|dia|vencimento|pagamento|emiss[aã]o|compet[eê]ncia|m[eê]s|periodo|per[ií]odo/i;
const CAT = /categoria|tipo|grupo|classe|centro|setor|cliente|fornecedor|produto|respons[aá]vel|status|situa[cç][aã]o|regi[aã]o|canal|conta/i;

/** Cabeçalho: a primeira linha, se não for de números; senão "Coluna N". */
function header(rows: string[][]): { head: string[]; body: string[][]; offset: number } {
  const first = rows[0] ?? [];
  const numeric = first.filter((c) => parseNumber(c) !== null || (c && parseDate(c))).length;
  if (first.length && numeric <= first.length / 2) return { head: first.map((c, i) => c.trim() || `Coluna ${i + 1}`), body: rows.slice(1), offset: 2 };
  return { head: first.map((_, i) => `Coluna ${i + 1}`), body: rows, offset: 1 };
}

export function analyzeSheet(sheet: Sheet): TableStats {
  const { head, body, offset } = header(sheet.rows);
  const columns: ColumnStat[] = head.map((name, j) => {
    const vals = body.map((r) => (r[j] ?? '').trim());
    const filled = vals.filter(Boolean);
    const nums = filled.map((v) => parseNumber(v)); const dates = filled.map((v) => parseDate(v));
    const isNum = filled.length > 0 && nums.filter((x) => x !== null).length >= filled.length * 0.9;
    const isDate = !isNum && filled.length > 0 && dates.filter((x) => typeof x === 'string').length >= filled.length * 0.9;
    const c: ColumnStat = { name, type: !filled.length ? 'vazia' : isNum ? 'numero' : isDate ? 'data' : 'texto', filled: filled.length, blanks: vals.length - filled.length };
    if (isNum) {
      const xs = nums.filter((x): x is number => x !== null);
      const sorted = [...xs].sort((a, b) => a - b);
      c.sum = round(xs.reduce((s, x) => s + x, 0)); c.min = sorted[0]; c.max = sorted[sorted.length - 1]; c.mean = round(c.sum / xs.length);
      c.median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
      // fora da curva: além de 3 intervalos interquartis (resiste a poucos valores grandes); quase tudo igual: longe da mediana
      if (xs.length >= 8) {
        const q1 = sorted[Math.floor(sorted.length * 0.25)]; const q3 = sorted[Math.floor(sorted.length * 0.75)]; const iqr = q3 - q1;
        const far = iqr > 0 ? (x: number) => x > q3 + 3 * iqr || x < q1 - 3 * iqr : (x: number) => Math.abs(x - c.median!) > 3 * Math.max(Math.abs(c.median!), 1);
        const out = vals.map((v, i) => ({ row: i + offset, value: parseNumber(v) })).filter((x): x is { row: number; value: number } => x.value !== null && far(x.value)).slice(0, 10);
        if (out.length) c.outliers = out;
      }
    } else if (isDate) {
      const ds = dates.filter((x): x is string => typeof x === 'string').sort();
      c.first = ds[0]; c.last = ds[ds.length - 1];
    } else if (filled.length) {
      const count = new Map<string, number>(); for (const v of filled) count.set(v, (count.get(v) ?? 0) + 1);
      c.distinct = count.size; c.top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 5);
    }
    return c;
  });
  // linhas repetidas (iguais em tudo)
  const seen = new Map<string, number>(); const duplicates: number[] = [];
  body.forEach((r, i) => { const k = r.join('\u0001'); if (!r.some(Boolean)) return; if (seen.has(k)) duplicates.push(i + offset); else seen.set(k, i + offset); });
  const t: TableStats = { name: sheet.name, rows: body.length, cols: head.length, columns, duplicates: duplicates.slice(0, 20) };
  const valueCol = pick(columns, 'numero', VALUE);
  const dateCol = pick(columns, 'data', DATE);
  if (valueCol && dateCol) {
    const vi = columns.indexOf(valueCol); const di = columns.indexOf(dateCol);
    const per = new Map<string, PeriodTotal>();
    for (const r of body) {
      const d = parseDate(r[di] ?? ''); const v = parseNumber(r[vi] ?? '');
      if (typeof d !== 'string' || v === null) continue;
      const k = d.slice(0, 7); const p = per.get(k) ?? { period: k, total: 0, count: 0 };
      p.total = round(p.total + v); p.count++; per.set(k, p);
    }
    const periods = [...per.values()].sort((a, b) => a.period.localeCompare(b.period));
    const [prev, last] = periods.slice(-2);
    t.byPeriod = { dateCol: dateCol.name, valueCol: valueCol.name, periods: periods.slice(-24), variation: prev && last && prev.total ? round(((last.total - prev.total) / Math.abs(prev.total)) * 100) : null };
  }
  const catCol = columns.find((c) => c.type === 'texto' && CAT.test(c.name) && (c.distinct ?? 0) >= 2 && (c.distinct ?? 0) <= 50) ?? columns.find((c) => c.type === 'texto' && (c.distinct ?? 0) >= 2 && (c.distinct ?? 0) <= 12);
  if (valueCol && catCol) {
    const vi = columns.indexOf(valueCol); const ci = columns.indexOf(catCol);
    const g = new Map<string, { total: number; count: number }>();
    for (const r of body) { const v = parseNumber(r[vi] ?? ''); const k = (r[ci] ?? '').trim() || '(vazio)'; if (v === null) continue; const x = g.get(k) ?? { total: 0, count: 0 }; x.total = round(x.total + v); x.count++; g.set(k, x); }
    const sum = [...g.values()].reduce((s, x) => s + Math.abs(x.total), 0);
    t.byCategory = { catCol: catCol.name, valueCol: valueCol.name, groups: [...g].map(([name, x]) => ({ name, ...x, share: sum ? round((Math.abs(x.total) / sum) * 100) : 0 })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 15) };
  }
  return t;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pick = (cols: ColumnStat[], type: ColType, re: RegExp) => cols.find((c) => c.type === type && re.test(c.name)) ?? cols.find((c) => c.type === type);
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const brMonth = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;

/** Linhas de fatos (o que o agente recebe e o que a conferência usa). */
export function statsLines(t: TableStats, label = t.name): string[] {
  const out = [`Planilha ${label}: ${t.rows} linha(s) de dados, ${t.cols} coluna(s)${t.duplicates.length ? `; ${t.duplicates.length} linha(s) repetida(s) (linhas ${t.duplicates.slice(0, 8).join(', ')})` : ''}`];
  for (const c of t.columns) {
    const blanks = c.blanks ? ` · ${c.blanks} vazio(s)` : '';
    if (c.type === 'numero') out.push(`Coluna "${c.name}" (números, ${c.filled}): total ${fmt(c.sum!)} · média ${fmt(c.mean!)} · mediana ${fmt(c.median!)} · mínimo ${fmt(c.min!)} · máximo ${fmt(c.max!)}${blanks}${c.outliers?.length ? ` · fora da curva: ${c.outliers.map((o) => `linha ${o.row} (${fmt(o.value)})`).join(', ')}` : ''}`);
    else if (c.type === 'data') out.push(`Coluna "${c.name}" (datas, ${c.filled}): de ${brDate(c.first!)} a ${brDate(c.last!)}${blanks}`);
    else if (c.type === 'texto') out.push(`Coluna "${c.name}" (texto, ${c.filled}; ${c.distinct} valor(es) diferente(s)): mais comuns ${c.top!.map(([v, n]) => `"${v.slice(0, 40)}" (${n})`).join(', ')}${blanks}`);
    else out.push(`Coluna "${c.name}": vazia`);
    if (out.length > 40) break;
  }
  if (t.byPeriod?.periods.length) {
    const b = t.byPeriod;
    out.push(`Total de "${b.valueCol}" por mês (pela coluna "${b.dateCol}"): ${b.periods.map((p) => `${brMonth(p.period)} ${fmt(p.total)} (${p.count})`).join(' · ')}`);
    if (b.variation !== null) { const [a, z] = b.periods.slice(-2); out.push(`Variação do último mês: ${brMonth(z.period)} contra ${brMonth(a.period)} = ${b.variation > 0 ? '+' : ''}${pct(b.variation)} (de ${fmt(a.total)} para ${fmt(z.total)})`); }
  }
  if (t.byCategory?.groups.length) {
    const b = t.byCategory;
    out.push(`Total de "${b.valueCol}" por "${b.catCol}": ${b.groups.map((g) => `${g.name.slice(0, 40)} ${fmt(g.total)} (${pct(g.share)}, ${g.count})`).join(' · ')}`);
  }
  return out;
}

/** Os indicadores como CSV (o arquivo que acompanha a análise). */
export function statsCsv(list: TableStats[]): string {
  const rows: Array<Array<string | number | null>> = [['Planilha', 'Indicador', 'Coluna', 'Valor']];
  for (const t of list) {
    rows.push([t.name, 'linhas de dados', '', t.rows], [t.name, 'linhas repetidas', '', t.duplicates.length]);
    for (const c of t.columns) {
      if (c.type === 'numero') for (const [k, v] of [['total', c.sum], ['média', c.mean], ['mediana', c.median], ['mínimo', c.min], ['máximo', c.max], ['vazios', c.blanks]] as const) rows.push([t.name, k, c.name, v ?? null]);
      if (c.type === 'data') rows.push([t.name, 'primeira data', c.name, c.first ?? null], [t.name, 'última data', c.name, c.last ?? null]);
    }
    for (const p of t.byPeriod?.periods ?? []) rows.push([t.name, `total em ${brMonth(p.period)}`, t.byPeriod!.valueCol, p.total]);
    if (t.byPeriod?.variation !== null && t.byPeriod?.variation !== undefined) rows.push([t.name, 'variação do último mês (%)', t.byPeriod.valueCol, t.byPeriod.variation]);
    for (const g of t.byCategory?.groups ?? []) rows.push([t.name, `total de ${g.name}`, t.byCategory!.valueCol, g.total]);
  }
  return toCsv(rows.map((r) => r.map(csvNum)));
}

/** Número com vírgula decimal e sem milhar (o Excel em português lê certo). */
export const csvNum = (v: string | number | null) => (typeof v === 'number' ? String(v).replace('.', ',') : v);
