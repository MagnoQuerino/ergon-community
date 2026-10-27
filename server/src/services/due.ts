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
    return validDue(s) ? s : null;
  }
  // até dia 5 (este mês; se já passou, o mês que vem)
  const dd = t.match(rx('(?:o\\s+)?dia\\s+(\\d{1,2})\\b'));
  if (dd) {
    const d = Number(dd[1]);
    let y = today.y; let m = today.m;
    if (d < today.d) { m++; if (m > 12) { m = 1; y++; } }
    const s = iso(y, m, d);
    return validDue(s) ? s : null;
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
