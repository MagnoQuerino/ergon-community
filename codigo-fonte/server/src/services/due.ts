/**
 * Prazo das tarefas: uma data (AAAA-MM-DD), sem hora — o mesmo que os aplicativos de tarefas mais usados guardam.
 * Vem de três lugares: você escolhe no card; um pedido diz ("até sexta", "até amanhã", "até 30/10", "prazo: dia
 * 5"); ou o aplicativo espelhado traz. Sem modelo: regras de texto, no fuso do workspace.
 */
import { localParts } from './routine-time.ts';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Data válida no calendário (rejeita 31/02, mês 13…). */
export function validDue(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2200;
}

/** Soma dias a uma data AAAA-MM-DD. */
function addDays(y: number, m: number, d: number, n: number): string {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const WEEKDAYS: Array<[RegExp, number]> = [
  [/domingo/, 0], [/segunda/, 1], [/ter[cç]a/, 2], [/quarta/, 3], [/quinta/, 4], [/sexta/, 5], [/s[aá]bado/, 6],
];
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Prazo dito no texto de um pedido, ou null. Só reconhece quando há uma palavra de prazo ("até", "prazo",
 * "para", "entregar"…) antes da data, para "reunião na sexta" não virar prazo.
 */
export function parseDue(text: string, tz: string, nowMs = Date.now()): string | null {
  const t = fold(text);
  const today = localParts(tz, nowMs);
  const lead = '(?:ate|prazo:?|para|pra|entregar|entrega|vence|vencimento|deadline)\\s+(?:o\\s+|a\\s+|a\\s+proxima\\s+|o\\s+proximo\\s+|esta\\s+|este\\s+|essa\\s+|esse\\s+)?';
  const rx = (body: string) => new RegExp(`\\b${lead}${body}`);
  if (rx('hoje\\b').test(t)) return iso(today.y, today.m, today.d);
  if (rx('depois de amanha\\b').test(t)) return addDays(today.y, today.m, today.d, 2);
  if (rx('amanha\\b').test(t)) return addDays(today.y, today.m, today.d, 1);
  // até 30/10 · até 30/10/2026 · prazo 5/11/26
  const dm = t.match(rx('(?:dia\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b'));
  if (dm) {
    const d = Number(dm[1]); const m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : today.y;
    if (!dm[3] && (m < today.m || (m === today.m && d < today.d))) y++;
    const s = iso(y, m, d);
    if (validDue(s)) return s;
  }
  // até 15 de novembro · até o dia 15 de dezembro (antes de "dia 5": senão o mês dito no pedido se perdia)
  const pm = t.match(rx(`(?:o\\s+)?(?:dia\\s+)?(\\d{1,2})\\s+de\\s+(${MESES_PT})(?:\\s+de\\s+(\\d{4}))?\\b`));
  if (pm) { const s = dataComMes(Number(pm[1]), mesDe(pm[2]), pm[3], today); if (s) return s; }
  // até dia 5 (este mês; se já passou, o mês que vem)
  const dd = t.match(rx(`(?:o\\s+)?dia\\s+(\\d{1,2})\\b(?!\\s+de\\s+(?:${MESES_PT})\\b)`));
  if (dd) {
    const s = diaDoMes(Number(dd[1]), today);
    if (s) return s;
  }
  // até sexta(-feira): a próxima (hoje, se hoje é sexta)
  const wdm = t.match(rx('(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira|\\s+feira)?\\b'));
  if (wdm) {
    const want = WEEKDAYS.find(([r]) => r.test(wdm[1]))![1];
    const ahead = (want - today.wd + 7) % 7;
    return addDays(today.y, today.m, today.d, ahead);
  }
  // até o fim da semana / do mês
  if (rx('(?:o\\s+)?fi(?:m|nal) da semana\\b').test(t)) return addDays(today.y, today.m, today.d, (5 - today.wd + 7) % 7);
  if (rx('(?:o\\s+)?fi(?:m|nal) do mes\\b').test(t)) { const last = new Date(Date.UTC(today.y, today.m, 0)).getUTCDate(); return iso(today.y, today.m, last); }
  // AAAA-MM-DD depois de uma palavra de prazo, em qualquer idioma
  const isoM = t.match(new RegExp(`\\b(?:${LEAD_PT}|${LEAD_EN})\\s+(?:o\\s+|the\\s+)?(\\d{4})-(\\d{2})-(\\d{2})\\b`));
  if (isoM && validDue(`${isoM[1]}-${isoM[2]}-${isoM[3]}`)) return `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
  return parseDueEn(t, today, tz);
}

/**
 * Fusos dos Estados Unidos (e das Filipinas), onde a data com barras é mês/dia. No resto (o Brasil, a Europa, Portugal…)
 * é dia/mês, também para quem escreve em inglês: "by 10/12" de alguém em São Paulo é 10 de dezembro.
 */
export function mesAntesDoDia(tz: string): boolean {
  return /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Yakutat|Metlakatla|Adak|Boise|Detroit|Menominee|Puerto_Rico|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+|Asia\/Manila)$/.test(tz);
}

// ------------------------------------------------------------------------------------------------ inglês
const LEAD_PT = '(?:ate|prazo:?|para|pra|entregar|entrega|vence|vencimento|deadline)';
/** "by Friday", "due tomorrow", "deadline: 10/30", "before the 5th", "no later than Nov 15" */
const LEAD_EN = "(?:by|due(?:\\s+(?:by|on|date:?))?|deadline:?|before|no\\s+later\\s+than|until|till)";
const MESES_PT = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';
const MESES_EN = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const MES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  feb: 2, apr: 4, aug: 8, sep: 9, sept: 9, oct: 10, dec: 12,
};
const mesDe = (s: string) => MES[s] ?? 0;
type Hoje = { y: number; m: number; d: number; wd: number };
/** dia e mês sem o ano: o próximo (se já passou neste ano, o do ano que vem) */
function dataComMes(d: number, m: number, ano: string | undefined, today: Hoje): string | null {
  if (!m) return null;
  let y = ano ? Number(ano.length === 2 ? `20${ano}` : ano) : today.y;
  if (!ano && (m < today.m || (m === today.m && d < today.d))) y++;
  const s = iso(y, m, d);
  return validDue(s) ? s : null;
}
/** dia do mês sem o mês: este mês; se já passou, o que vem */
function diaDoMes(d: number, today: Hoje): string | null {
  let y = today.y; let m = today.m;
  if (d < today.d) { m++; if (m > 12) { m = 1; y++; } }
  const s = iso(y, m, d);
  return validDue(s) ? s : null;
}
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * O mesmo, em inglês ("by Friday", "due tomorrow", "by 10/30", "by Nov 15", "by the 5th", "by end of week"). A data
 * com barras: com um número acima de 12, só tem uma leitura ("10/30", "30/10"); com os dois até 12 ("10/12"), vale a
 * ordem do lugar do workspace (mês/dia nos Estados Unidos, dia/mês no resto). Sem o ano e já passada, a data ambígua não
 * vira prazo (nada de mandar para o ano que vem um prazo que talvez fosse o outro dia): o agente pergunta.
 */
function parseDueEn(t: string, today: Hoje, tz: string): string | null {
  const rx = (body: string) => new RegExp(`\\b${LEAD_EN}\\s+(?:the\\s+|this\\s+|next\\s+|this\\s+coming\\s+|on\\s+)?${body}`);
  if (rx('(?:today|tonight|eod|end of (?:the )?day)\\b').test(t)) return iso(today.y, today.m, today.d);
  if (rx('(?:the\\s+)?day after tomorrow\\b').test(t)) return addDays(today.y, today.m, today.d, 2);
  if (rx('tomorrow\\b').test(t)) return addDays(today.y, today.m, today.d, 1);
  const md = t.match(rx('(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b'));
  if (md) {
    const a = Number(md[1]); const b = Number(md[2]);
    const ambigua = a <= 12 && b <= 12 && a !== b;
    const [m, d] = a > 12 ? [b, a] : b > 12 ? [a, b] : mesAntesDoDia(tz) ? [a, b] : [b, a];
    const passou = m < today.m || (m === today.m && d < today.d);
    const s = ambigua && !md[3] && passou ? null : dataComMes(d, m, md[3], today);
    if (s) return s;
    if (ambigua) return null;
  }
  // Nov 15 · November 15th · 15 Nov · 15th of November
  const mn = t.match(rx(`(${MESES_EN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`));
  if (mn) { const s = dataComMes(Number(mn[2]), mesDe(mn[1]), mn[3], today); if (s) return s; }
  const nm = t.match(rx(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MESES_EN})\\b\\.?(?:,?\\s+(\\d{4}))?`));
  if (nm) { const s = dataComMes(Number(nm[1]), mesDe(nm[2]), nm[3], today); if (s) return s; }
  // by the 5th
  const th = t.match(rx('(\\d{1,2})(?:st|nd|rd|th)\\b'));
  if (th) { const s = diaDoMes(Number(th[1]), today); if (s) return s; }
  const wd = t.match(rx(`(${WEEKDAYS_EN.join('|')})\\b`));
  if (wd) return addDays(today.y, today.m, today.d, (WEEKDAYS_EN.indexOf(wd[1]) - today.wd + 7) % 7);
  if (rx('(?:the\\s+)?(?:end of (?:the |this )?week|eow|weekend)\\b').test(t)) return addDays(today.y, today.m, today.d, (5 - today.wd + 7) % 7);
  if (rx('(?:the\\s+)?(?:end of (?:the |this )?month|eom)\\b').test(t)) { const last = new Date(Date.UTC(today.y, today.m, 0)).getUTCDate(); return iso(today.y, today.m, last); }
  return null;
}

/** Prazo vindo de um aplicativo (data, data e hora ISO ou carimbo em ms/s) → AAAA-MM-DD, ou null. */
/**
 * Prazo que o aplicativo guarda como **instante** em UTC (Planner): a data é a do fuso do workspace, a mesma que o
 * aplicativo mostra e que a leitura das contas usa. Cortar o texto em UTC desloca um dia: um prazo de 25/10 que o
 * Planner guarda como "2026-10-26T02:59:59Z" virava 26/10. Só data (sem hora):
 * vale como está. Não serve para To Do e Google Tasks, que guardam a data à meia-noite UTC (converter erraria o dia).
 */
export function dueAt(v: unknown, tz: string): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return dueOf(v);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const p = localParts(tz, ms);
  const s = iso(p.y, p.m, p.d);
  return validDue(s) ? s : null;
}

export function dueOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{10,13}$/.test(v))) {
    const n = Number(v); const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m && validDue(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
