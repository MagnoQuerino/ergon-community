/**
 * Horários das rotinas no fuso do usuário ("seg a sex às 08:00" em America/Sao_Paulo), sem biblioteca: o Intl do
 * Node diz o deslocamento de cada fuso em cada instante (horário de verão incluído).
 */
import { fold } from '../lib/util.ts';
import type { Trigger } from './routine-catalog.ts';

export const DEFAULT_TZ = 'America/Sao_Paulo';
const DAY = 86_400_000;

export function validTz(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Deslocamento do fuso em minutos naquele instante (São Paulo = -180). */
export function offsetMinutes(tz: string, ts: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(ts).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** um formatador por fuso: criar um a cada data custa mais que formatar (o relatório formata milhares) */
const partsFmt = new Map<string, Intl.DateTimeFormat>();

/** Data local (ano, mês, dia, dia da semana 0 = domingo) de um instante, no fuso. */
export function localParts(tz: string, ts: number): { y: number; m: number; d: number; wd: number; hh: number; mm: number } {
  let f = partsFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }); partsFmt.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(ts).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd, hh: Number(p.hour), mm: Number(p.minute) };
}

/** Instante (ms) de uma hora local no fuso. */
export function zonedToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const at = guess - offsetMinutes(tz, guess) * 60_000;
  const fix = offsetMinutes(tz, at); // perto da troca de horário, o deslocamento certo é o do próprio instante
  return guess - fix * 60_000;
}

/**
 * Primeiro instante (ms) do dia local no fuso. Onde o horário muda à meia-noite, ela pode não existir (o dia começa à
 * 01:00) ou se repetir (vale a primeira): procura o primeiro instante cuja data local é o dia pedido.
 */
export function inicioDoDia(tz: string, y: number, m: number, d: number): number {
  const alvo = y * 10_000 + m * 100 + d;
  const dia = (ts: number) => { const p = localParts(tz, ts); return p.y * 10_000 + p.m * 100 + p.d; };
  // os fusos vão de -12 h a +14 h: 15 h antes da meia-noite UTC ainda é o dia anterior em todos; 15 h depois, já é o dia
  let antes = Date.UTC(y, m - 1, d) - 15 * 3_600_000; let ja = Date.UTC(y, m - 1, d) + 15 * 3_600_000;
  while (ja - antes > 1) { const meio = Math.floor((antes + ja) / 2); if (dia(meio) >= alvo) ja = meio; else antes = meio; }
  return ja;
}

/** Próximo horário depois de `from` (ISO), ou null se a rotina é só manual. */
export function nextOccurrence(t: Trigger, from: Date): string | null {
  if (t.kind !== 'schedule' || !t.days.length) return null;
  const [hh, mm] = t.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const p = localParts(t.tz, from.getTime() + i * DAY);
    if (!t.days.includes(p.wd)) continue;
    const at = zonedToUtc(t.tz, p.y, p.m, p.d, hh, mm);
    if (at > from.getTime()) return new Date(at).toISOString();
  }
  return null;
}

/**
 * Último horário até `until` (inclusive), ou null se a rotina é só manual: o horário que um aviso do agendador do motor
 * está disparando (rotinas-motor.ts). Mesmo formato de nextOccurrence (a chave da execução é a mesma dos dois lados).
 */
export function previousOccurrence(t: Trigger, until: Date): string | null {
  if (t.kind !== 'schedule' || !t.days.length) return null;
  const [hh, mm] = t.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const p = localParts(t.tz, until.getTime() - i * DAY);
    if (!t.days.includes(p.wd)) continue;
    const at = zonedToUtc(t.tz, p.y, p.m, p.d, hh, mm);
    if (at <= until.getTime()) return new Date(at).toISOString();
  }
  return null;
}

const NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const FULL = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "Seg a sex às 08:00", "Toda segunda às 09:30", "Manual". */
export function scheduleText(t: Trigger): string {
  if (t.kind !== 'schedule' || !t.days.length) return 'Quando você pedir';
  const d = [...new Set(t.days)].sort((a, b) => a - b);
  const key = d.join(',');
  const days = key === '0,1,2,3,4,5,6' ? 'Todos os dias'
    : key === '1,2,3,4,5' ? 'Seg a sex'
      : d.length === 1 ? `${d[0] === 0 || d[0] === 6 ? 'Todo' : 'Toda'} ${FULL[d[0]]}`
        : d.map((x) => NAMES[x]).join(', ').replace(/, ([^,]+)$/, ' e $1').replace(/^./, (c) => c.toUpperCase());
  return `${days} às ${t.time}`;
}

/**
 * Lê "quando" em português (o que a coordenação escreve numa proposta): "dias úteis 8h", "toda sexta às 17:00",
 * "seg e qui 10h", "todo dia 7:30", "manual". Sem dia reconhecível = manual. Também em inglês (a coordenação escreve no
 * idioma da conversa): "weekdays 8am", "every Friday at 5 pm", "Mon and Thu 10:00", "daily 7:30", "on demand".
 */
export function parseWhen(text: string, tz: string): Trigger {
  const s = fold(text).replace(/-feira/g, '');
  if (!s.trim() || /manual|sob demanda|quando (eu )?pedir|on demand|when i ask|on request/.test(s)) return { kind: 'manual' };
  let days: number[] = [];
  if (/dias? ute(is|l)|seg\w* a sex|segunda a sexta|de segunda a sexta|weekdays?|business days?|work ?days?|mon\w* (to|-|through|thru) fri/.test(s)) days = [1, 2, 3, 4, 5];
  else if (/todo(s)? (o )?dia|diari|cada dia|every ?day|daily/.test(s)) days = [0, 1, 2, 3, 4, 5, 6];
  else {
    const map: Array<[RegExp, number]> = [[/\bdom(ingo)?\b/, 0], [/\bseg(unda)?\b/, 1], [/\bter(ca)?\b/, 2], [/\bqua(rta)?\b/, 3], [/\bqui(nta)?\b/, 4], [/\bsex(ta)?\b/, 5], [/\bsab(ado)?\b/, 6],
      [/\bsun(day)?s?\b/, 0], [/\bmon(day)?s?\b/, 1], [/\btue(s|sday)?s?\b/, 2], [/\bwed(nesday)?s?\b/, 3], [/\bthu(rs?|rsday)?s?\b/, 4], [/\bfri(day)?s?\b/, 5], [/\bsat(urday)?s?\b/, 6]];
    days = [...new Set(map.filter(([re]) => re.test(s)).map(([, d]) => d))].sort((a, b) => a - b);
    if (!days.length && /seman|week/.test(s)) days = [1];
  }
  if (!days.length) return { kind: 'manual' };
  // 8am, 5 pm, 5:30pm (inglês); 8h, 17:00, às 9 (português). O "7h" do português vem primeiro, e o am/pm só com o fim
  // da palavra: "às 7h, 2 amostras" é às 07:00, não às 2 da manhã
  const ap = /\b\d{1,2}\s*h(\d{2})?\b/.test(s) ? null : s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/);
  if (ap) {
    let h = Number(ap[1]) % 12; if (/^p/.test(ap[3])) h += 12;
    const m = ap[2] ? Math.min(59, Number(ap[2])) : 0;
    return { kind: 'schedule', days, time: `${String(Math.min(23, h)).padStart(2, '0')}:${String(m).padStart(2, '0')}`, tz };
  }
  const tm = s.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/) ?? s.match(/\b(?:as|at) (\d{1,2})\b/);
  const hh = tm ? Math.min(23, Number(tm[1])) : 8;
  const mm = tm && tm[2] ? Math.min(59, Number(tm[2])) : 0;
  return { kind: 'schedule', days, time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz };
}

/** Normaliza um gatilho vindo da interface (dias 0–6 únicos, hora HH:MM, fuso válido). */
export function cleanTrigger(t: unknown, tz: string): Trigger {
  const o = (t ?? {}) as { kind?: string; days?: unknown; time?: unknown; tz?: unknown };
  if (o.kind !== 'schedule') return { kind: 'manual' };
  const days = Array.isArray(o.days) ? [...new Set(o.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  const time = typeof o.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time) ? o.time : '08:00';
  if (!days.length) return { kind: 'manual' };
  return { kind: 'schedule', days, time, tz: validTz(o.tz as string) ? (o.tz as string) : tz };
}

/** "terça, 25/10 às 08:00" no fuso. */
export function fmtLocal(iso: string | number, tz: string): string {
  const ts = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(ts).replace('-feira', '').replace(/,? (\d{2}:\d{2})$/, ' às $1');
}
