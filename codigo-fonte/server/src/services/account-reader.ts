/**
 * Leitura das contas conectadas para as rotinas: agenda do dia, e-mails desde a última vez e as suas tarefas com
 * prazo, da Microsoft (Graph) e do Google (Agenda, Gmail, Tasks). Só leitura e só o mínimo: horário, título, local,
 * remetente e assunto. As rotinas de comunicação que o usuário ativa leem também a prévia (o começo do texto) e, no
 * Assistente de Respostas, o texto do e-mail sem o histórico citado; as de documentos leem os arquivos escolhidos do
 * OneDrive ou do Google Drive. Anexos, nunca. Tudo o que vem de terceiros é dado, não instrução
 * (neutralizado antes de chegar ao agente). Cada leitura registra o que aconteceu (lida, não conectada, sem permissão,
 * autorização vencida, erro): o briefing diz o que não conseguiu ler em vez de fingir que leu.
 */
import type { Db } from '../db/db.ts';
import { clip } from '../lib/util.ts';
import { setIntegration } from './integrations.ts';
import { ProviderError } from './mirror.ts';
import { xmlText } from './doc-text.ts';
import { neutral } from './operations.ts';
import { localParts, zonedToUtc } from './routine-time.ts';
import type { SsoAuth, SsoKind } from './sso.ts';
import { request } from './task-providers.ts';
import { fetchWithPolicy } from '../lib/http.ts';

export type ReadKind = 'agenda' | 'email' | 'tarefas' | 'arquivos';
export type ReadStatus = 'ok' | 'nao_conectada' | 'sem_permissao' | 'expirada' | 'erro';
export interface SourceRead {
  account: SsoKind; what: ReadKind; status: ReadStatus; label: string | null; count: number; ms: number; detail?: string;
  /** a leitura parou no limite (havia mais páginas): o que veio é uma parte, e a conferência diz isso */
  truncated?: boolean;
}
export interface Item { at: string; line: string; flag: boolean }
export interface AccountFacts {
  agenda: Item[]; email: Item[]; emailImportant: number; tarefas: Item[]; tarefasAtrasadas: number;
  reads: SourceRead[]; warnings: string[];
}

const ACCOUNT_LABEL: Record<SsoKind, string> = { microsoft: 'Microsoft', google: 'Google' };
const MAX_EVENTS = 40;
/**
 * Limites de leitura (páginas). Acima deles a leitura é marcada como parcial, nunca tratada como completa:
 * agenda até 4 páginas de 50; e-mail até 200 da caixa prioritária; listas de tarefas até 50, até 10 páginas cada.
 */
const PAGE = { events: 4, mailMs: 4, mailGoogle: 2, lists: 5, tasks: 10, planner: 10, listCap: 50 };
const MAIL_META = 100; // detalhes (assunto, remetente) do Gmail: um pedido por mensagem
/** Google com o app em modo de teste: a autorização (refresh token) vale 7 dias. */
export const GOOGLE_TESTING_DAYS = 7;

const two = (n: number) => String(n).padStart(2, '0');
const hm = (tz: string, ms: number) => { const p = localParts(tz, ms); return `${two(p.hh)}:${two(p.mm)}`; };
const dayOf = (tz: string, ms: number) => { const p = localParts(tz, ms); return `${p.y}-${two(p.m)}-${two(p.d)}`; };
/** dd/mm no ano corrente; dd/mm/aaaa nos outros (uma tarefa de 2024 não parece desta semana) */
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}${iso.slice(0, 4) === String(new Date().getFullYear()) ? '' : `/${iso.slice(0, 4)}`}`;
/** Texto de terceiros: sem linhas de controle, sem quebras, curto e entre aspas. */
const t3 = (s: unknown, max = 90) => `"${neutral(clip(String(s ?? '').replace(/\s+/g, ' ').trim() || '(sem título)', max), max + 2)}"`;
const who = (name: unknown, addr: unknown) => neutral(clip(String(name || addr || 'remetente desconhecido').replace(/\s+/g, ' '), 60), 62);

/** Hoje no fuso: início e fim (UTC) e a data local. */
function today(tz: string): { start: number; end: number; date: string } {
  const p = localParts(tz, Date.now());
  const start = zonedToUtc(tz, p.y, p.m, p.d, 0, 0);
  const n = localParts(tz, start + 36 * 3600_000); // amanhã (passa de horário de verão sem erro)
  return { start, end: zonedToUtc(tz, n.y, n.m, n.d, 0, 0), date: `${p.y}-${two(p.m)}-${two(p.d)}` };
}

export interface MailItem {
  account: SsoKind; id: string; thread: string; at: number; from: string; fromAddr: string; to: string[];
  subject: string; preview: string; important: boolean; unread: boolean; folder: 'inbox' | 'sent';
}
export interface EventItem { account: SsoKind; start: number; end: number; allDay: boolean; title: string; where: string; attendees: string[]; organizer: string; description: string }
export interface CloudFile { provider: SsoKind; id: string; name: string; size: number; modified: string | null; mime: string; folder: string }
/** caixa: prioritários desde a última vez; pendencias: 14 dias de entrada e de saída; relacionados: busca por termos (30 dias) */
export type MailMode = 'caixa' | 'pendencias' | 'relacionados';
type Get = (url: string, headers?: Record<string, string>) => Promise<any>;

const MAX_FILE = 15 * 1024 * 1024;
/** documentos do Google viram os formatos do Office (o Ergon lê esses) */
const GOOGLE_EXPORT: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
};
const addr = (v: unknown) => String(v ?? '').match(/<([^>]+)>/)?.[1] ?? String(v ?? '').trim();
const plainName = (v: unknown) => String(v ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();

/** Tira o histórico citado (as respostas anteriores) do texto de um e-mail. */
export function withoutQuoted(text: string): string {
  const out: string[] = [];
  for (const l of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(l)) continue;
    if (/^(Em .{4,160} escreveu:|On .{4,160} wrote:|-{2,}\s*(Mensagem original|Original Message)\s*-{2,}|De:\s.+|From:\s.+)$/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class AccountReader {
  private readonly db: Db; private readonly sso: SsoAuth; private readonly googleTesting: boolean;
  constructor(db: Db, sso: SsoAuth, opts: { googleTesting: boolean }) { this.db = db; this.sso = sso; this.googleTesting = opts.googleTesting; }

  /** "última leitura" de Conexões e do diagnóstico: antes, só a importação manual de uma lista a atualizava */
  private readOk(ws: string, k: SsoKind): void { setIntegration(this.db, ws, k, { last_sync_at: new Date().toISOString() }); }

  private connected(ws: string): Array<{ kind: SsoKind; label: string | null; connectedAt: string | null }> {
    return this.db.all<{ kind: SsoKind; account_label: string | null; connected_at: string | null }>(
      "SELECT kind, account_label, connected_at FROM integrations WHERE workspace_id = ? AND kind IN ('microsoft', 'google') AND state = 'connected'", ws)
      .map((r) => ({ kind: r.kind, label: r.account_label, connectedAt: r.connected_at }));
  }

  /** Lê o que foi pedido em todas as contas conectadas. Uma conta com problema não impede as outras. */
  async read(ws: string, what: ReadKind[], since: string, tz: string, opts: { horizonDays?: number } = {}): Promise<AccountFacts> {
    const out: AccountFacts = { agenda: [], email: [], emailImportant: 0, tarefas: [], tarefasAtrasadas: 0, reads: [], warnings: [] };
    const accounts = this.connected(ws);
    for (const w of what) {
      for (const k of ['microsoft', 'google'] as SsoKind[]) {
        const acc = accounts.find((a) => a.kind === k);
        if (!acc) { out.reads.push({ account: k, what: w, status: 'nao_conectada', label: null, count: 0, ms: 0 }); continue; }
        const t0 = Date.now();
        try {
          const token = await this.sso.accessToken(ws, k);
          const cut = { truncated: false };
          const n = await this.one(k, w, this.authed(ws, k, token), since, tz, out, opts.horizonDays ?? 0, cut);
          out.reads.push({ account: k, what: w, status: 'ok', label: acc.label, count: n, ms: Date.now() - t0, ...(cut.truncated ? { truncated: true, detail: 'parou no limite de leitura: pode haver mais' } : {}) });
          this.readOk(ws, k);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // renovação recusada pelo provedor = autorização vencida (Google em teste: a cada 7 dias); some da tela como erro
          const expired = err instanceof ProviderError && err.kind === 'forbidden' && (err.reauth || /recusou o acesso|venceu|não há renovação/.test(msg));
          const status: ReadStatus = expired ? 'expirada' : err instanceof ProviderError && err.kind === 'forbidden' ? 'sem_permissao' : 'erro';
          if (expired) setIntegration(this.db, ws, k, { state: 'error', last_error: `A autorização ${k === 'google' ? 'do Google' : 'da Microsoft'} venceu: entre de novo em Conexões.` });
          out.reads.push({ account: k, what: w, status, label: acc.label, count: 0, ms: Date.now() - t0, detail: clip(msg, 160) });
        }
      }
    }
    // avisos que o usuário precisa ver (e o briefing repassa)
    for (const r of out.reads) {
      if (r.status === 'expirada') out.warnings.push(`${ACCOUNT_LABEL[r.account]}: a autorização venceu — entre de novo em Conexões › ${ACCOUNT_LABEL[r.account]}.`);
      else if (r.status === 'sem_permissao') out.warnings.push(`${ACCOUNT_LABEL[r.account]}: sem permissão para ler ${r.what === 'email' ? 'e-mail' : r.what} (autorize em Conexões).`);
      else if (r.status === 'erro') out.warnings.push(`${ACCOUNT_LABEL[r.account]}: não consegui ler ${r.what === 'email' ? 'o e-mail' : r.what === 'agenda' ? 'a agenda' : 'as tarefas'} agora (${clip(r.detail ?? 'erro', 80)}).`);
      else if (r.truncated) out.warnings.push(`${ACCOUNT_LABEL[r.account]}: ${r.what === 'email' ? 'e-mails' : r.what === 'agenda' ? 'agenda' : 'tarefas'} lidos em parte — havia mais do que o limite de leitura (${r.count} considerados).`);
    }
    out.warnings = [...new Set(out.warnings)];
    const g = accounts.find((a) => a.kind === 'google');
    if (g && this.googleTesting && g.connectedAt) {
      const left = Math.ceil((Date.parse(g.connectedAt) + GOOGLE_TESTING_DAYS * 86_400_000 - Date.now()) / 86_400_000);
      if (left <= 2 && !out.reads.some((r) => r.account === 'google' && r.status === 'expirada')) {
        out.warnings.push(left <= 0 ? 'Google: a autorização vence hoje — entre de novo em Conexões › Google.' : `Google: a autorização vence em ${left} dia(s) — renove em Conexões › Google.`);
      }
    }
    out.agenda.sort((a, b) => a.at.localeCompare(b.at));
    out.email.sort((a, b) => Number(b.flag) - Number(a.flag) || b.at.localeCompare(a.at));
    out.tarefas.sort((a, b) => Number(b.flag) - Number(a.flag) || a.at.localeCompare(b.at));
    return out;
  }

  /**
   * Leitura autenticada. 401 com um acesso que ainda não venceu (senha trocada, sessão revogada): renova uma vez e
   * repete só aquela requisição — é leitura, repetir não duplica nada (repetir a leitura inteira duplicaria o que já
   * tinha sido lido nas páginas anteriores). `onRenew`: quem usa o acesso fora daqui recebe o novo.
   */
  private authed(ws: string, k: SsoKind, token: string, onRenew?: (t: string) => void): Get {
    let current = token; let renewed = false;
    const call = (url: string, headers: Record<string, string>) => request(url, { headers: { Authorization: `Bearer ${current}`, ...headers } });
    return async (url, headers = {}) => {
      try { return await call(url, headers); } catch (e) {
        if (renewed || !(e instanceof ProviderError && e.status === 401)) throw e;
        renewed = true;
        current = await this.sso.accessToken(ws, k, { force: true });
        onRenew?.(current);
        return call(url, headers);
      }
    };
  }

  private async one(k: SsoKind, w: ReadKind, get: Get, since: string, tz: string, out: AccountFacts, horizon: number, cut: { truncated: boolean }): Promise<number> {
    // páginas do Graph (@odata.nextLink) e do Google (nextPageToken); sobrou página no limite = leitura parcial
    const graphPages = async (url: string, max: number, headers: Record<string, string> = {}) => {
      const all: any[] = []; let next: string | null = url;
      for (let i = 0; next && i < max; i++) {
        const j = await get(next, headers); all.push(...((j.value ?? []) as any[]));
        next = typeof j['@odata.nextLink'] === 'string' && j['@odata.nextLink'].startsWith('https://graph.microsoft.com/') ? j['@odata.nextLink'] : null;
      }
      if (next) cut.truncated = true;
      return all;
    };
    const googlePages = async (url: string, key: string, max: number) => {
      const all: any[] = []; let token: string | null = null;
      for (let i = 0; i < max; i++) {
        const j = await get(token ? `${url}${url.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(token)}` : url);
        all.push(...((j[key] ?? []) as any[]));
        token = typeof j.nextPageToken === 'string' && j.nextPageToken ? j.nextPageToken : null;
        if (!token) break;
      }
      if (token) cut.truncated = true;
      return all;
    };
    const day = today(tz);
    if (w === 'agenda') {
      const evs: Array<{ start: number; end: number; allDay: boolean; title: unknown; where: string }> = [];
      if (k === 'microsoft') {
        const q = new URLSearchParams({ startDateTime: new Date(day.start).toISOString(), endDateTime: new Date(day.end).toISOString(), $select: 'subject,start,end,isAllDay,isCancelled,location,onlineMeeting', $orderby: 'start/dateTime', $top: '50' });
        for (const e of await graphPages(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, PAGE.events, { Prefer: 'outlook.timezone="UTC"' })) {
          if (e.isCancelled) continue;
          const z = (s: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
          evs.push({ start: z(e.start?.dateTime), end: z(e.end?.dateTime), allDay: !!e.isAllDay, title: e.subject, where: e.onlineMeeting ? 'online' : String(e.location?.displayName ?? '') });
        }
      } else {
        const q = new URLSearchParams({ timeMin: new Date(day.start).toISOString(), timeMax: new Date(day.end).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
        for (const e of await googlePages(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, 'items', PAGE.events)) {
          if (e.status === 'cancelled') continue;
          const allDay = !e.start?.dateTime;
          evs.push({ start: allDay ? day.start : Date.parse(e.start.dateTime), end: allDay ? day.end : Date.parse(e.end?.dateTime ?? e.start.dateTime), allDay, title: e.summary, where: e.hangoutLink ? 'online' : String(e.location ?? '') });
        }
      }
      for (const e of evs) {
        if (!Number.isFinite(e.start)) continue;
        const when = e.allDay ? 'dia todo' : `${hm(tz, e.start)}–${hm(tz, e.end)}`;
        const where = e.where && e.where !== 'undefined' ? ` · ${neutral(clip(e.where.replace(/\s+/g, ' '), 50), 52)}` : '';
        out.agenda.push({ at: e.allDay ? '00:00' : hm(tz, e.start), line: `${when} ${t3(e.title)}${where} · ${ACCOUNT_LABEL[k]}`, flag: false });
      }
      return evs.length;
    }
    if (w === 'email') {
      const mails: Array<{ at: number; from: string; subject: unknown; important: boolean; unread: boolean }> = [];
      if (k === 'microsoft') {
        const q = new URLSearchParams({ $filter: `receivedDateTime ge ${new Date(since).toISOString()}`, $select: 'subject,from,receivedDateTime,importance,isRead,flag,inferenceClassification', $orderby: 'receivedDateTime desc', $top: '50' });
        for (const m of await graphPages(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${q}`, PAGE.mailMs)) {
          if (m.inferenceClassification === 'other') continue; // só a caixa "Prioritário": o resto é ruído para o briefing
          mails.push({ at: Date.parse(m.receivedDateTime), from: who(m.from?.emailAddress?.name, m.from?.emailAddress?.address), subject: m.subject,
            important: m.importance === 'high' || m.flag?.flagStatus === 'flagged', unread: m.isRead === false });
        }
      } else {
        const q = new URLSearchParams({ q: `in:inbox category:primary after:${Math.floor(Date.parse(since) / 1000)}`, maxResults: '100' });
        const all = (await googlePages(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, 'messages', PAGE.mailGoogle)).map((m) => String(m.id));
        if (all.length > MAIL_META) cut.truncated = true;
        const ids = all.slice(0, MAIL_META);
        for (let i = 0; i < ids.length; i += 5) { // poucas por vez: respeita o limite do Gmail
          const batch = await Promise.all(ids.slice(i, i + 5).map((id) =>
            get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&fields=labelIds,internalDate,payload/headers`)));
          for (const m of batch) {
            const h = (n: string) => ((m.payload?.headers ?? []) as any[]).find((x) => String(x.name).toLowerCase() === n)?.value;
            const from = String(h('from') ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
            const labels = (m.labelIds ?? []) as string[];
            mails.push({ at: Number(m.internalDate), from: who(from, h('from')), subject: h('subject'), important: labels.includes('IMPORTANT') || labels.includes('STARRED'), unread: labels.includes('UNREAD') });
          }
        }
      }
      for (const m of mails) {
        const d = dayOf(tz, m.at);
        out.email.push({ at: new Date(m.at).toISOString(), flag: m.important,
          line: `${d === day.date ? '' : `${br(d)} `}${hm(tz, m.at)} de ${m.from}: ${t3(m.subject)}${m.important ? ' · importante' : ''}${m.unread ? ' · não lido' : ''} · ${ACCOUNT_LABEL[k]}` });
      }
      out.emailImportant += mails.filter((m) => m.important).length;
      return mails.length;
    }
    // tarefas com prazo até hoje (atrasadas primeiro), das listas da conta
    const items: Array<{ title: unknown; due: string; where: string }> = [];
    if (k === 'microsoft') {
      // a API do To Do recusa $select/$filter (400): lê as páginas inteiras e filtra aqui
      const lists = await graphPages('https://graph.microsoft.com/v1.0/me/todo/lists', PAGE.lists);
      if (lists.length > PAGE.listCap) cut.truncated = true;
      for (const l of lists.slice(0, PAGE.listCap)) {
        for (const t of await graphPages(`https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(l.id)}/tasks`, PAGE.tasks)) {
          if (t.status === 'completed') continue;
          const due = String(t.dueDateTime?.dateTime ?? '').slice(0, 10);
          if (due) items.push({ title: t.title, due, where: `To Do › ${neutral(clip(String(l.displayName ?? ''), 40), 42)}` });
        }
      }
      try { // conta pessoal não tem Planner
        for (const t of await graphPages('https://graph.microsoft.com/v1.0/me/planner/tasks', PAGE.planner)) {
          if (Number(t.percentComplete) < 100 && t.dueDateTime) items.push({ title: t.title, due: dayOf(tz, Date.parse(t.dueDateTime)), where: 'Planner' });
        }
      } catch (err) { if (!(err instanceof ProviderError) || err.kind === 'unavailable') throw err; }
    } else {
      const lists = await googlePages('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', 'items', PAGE.lists);
      if (lists.length > PAGE.listCap) cut.truncated = true;
      for (const l of lists.slice(0, PAGE.listCap)) {
        for (const t of await googlePages(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?showCompleted=false&maxResults=100`, 'items', PAGE.tasks)) {
          if (t.due && String(t.title ?? '').trim()) items.push({ title: t.title, due: String(t.due).slice(0, 10), where: `Google Tasks › ${neutral(clip(String(l.title ?? ''), 40), 42)}` });
        }
      }
    }
    // até hoje (Briefing) ou com antecedência (Guardião dos Prazos)
    const limit = dayOf(tz, Date.now() + horizon * 86_400_000);
    const due = items.filter((t) => t.due <= limit);
    for (const t of due) {
      const late = t.due < day.date;
      const days = Math.round((Date.parse(`${t.due}T12:00:00Z`) - Date.parse(`${day.date}T12:00:00Z`)) / 86_400_000);
      const when = late ? `ATRASADA há ${-days} dia(s) (prazo ${br(t.due)})` : days === 0 ? 'prazo HOJE' : `vence em ${days} dia(s) (${br(t.due)})`;
      out.tarefas.push({ at: t.due, flag: late, line: `${t3(t.title)} · ${when} · ${t.where}` });
    }
    out.tarefasAtrasadas += due.filter((t) => t.due < day.date).length;
    return due.length;
  }

  // --- comunicação, reuniões e arquivos (rotinas das fases 2, 3 e 5) -------------------------------------------------

  /** Uma leitura numa conta, com o resultado registrado (lida, não conectada, sem permissão, vencida, erro). */
  private async withAccount<T>(ws: string, k: SsoKind, what: ReadKind, reads: SourceRead[], fn: (get: Get) => Promise<{ value: T; count: number; truncated?: boolean }>): Promise<T | null> {
    const acc = this.connected(ws).find((a) => a.kind === k);
    if (!acc) { reads.push({ account: k, what, status: 'nao_conectada', label: null, count: 0, ms: 0 }); return null; }
    const t0 = Date.now();
    try {
      const r = await fn(this.authed(ws, k, await this.sso.accessToken(ws, k)));
      reads.push({ account: k, what, status: 'ok', label: acc.label, count: r.count, ms: Date.now() - t0, ...(r.truncated ? { truncated: true, detail: 'parou no limite de leitura: pode haver mais' } : {}) });
      this.readOk(ws, k);
      return r.value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const expired = err instanceof ProviderError && err.kind === 'forbidden' && (err.reauth || /recusou o acesso|venceu|não há renovação/.test(msg));
      if (expired) setIntegration(this.db, ws, k, { state: 'error', last_error: `A autorização ${k === 'google' ? 'do Google' : 'da Microsoft'} venceu: entre de novo em Conexões.` });
      reads.push({ account: k, what, status: expired ? 'expirada' : err instanceof ProviderError && err.kind === 'forbidden' ? 'sem_permissao' : 'erro', label: acc.label, count: 0, ms: Date.now() - t0, detail: clip(msg, 160) });
      return null;
    }
  }

  /** E-mails com a prévia (o começo do texto), de entrada e, nas pendências, os que você enviou. */
  async mail(ws: string, mode: MailMode, since: string, opts: { terms?: string[]; max?: number } = {}): Promise<{ items: MailItem[]; reads: SourceRead[] }> {
    const reads: SourceRead[] = []; const items: MailItem[] = [];
    const max = Math.min(opts.max ?? 40, 80);
    const from = mode === 'pendencias' ? new Date(Date.now() - 14 * 86_400_000).toISOString() : mode === 'relacionados' ? new Date(Date.now() - 30 * 86_400_000).toISOString() : since;
    const terms = (opts.terms ?? []).map((t) => t.replace(/["'\\()]/g, ' ').trim()).filter((t) => t.length >= 3).slice(0, 4);
    if (mode === 'relacionados' && !terms.length) return { items, reads };
    for (const k of ['microsoft', 'google'] as SsoKind[]) {
      await this.withAccount<void>(ws, k, 'email', reads, async (get) => {
        const before = items.length;
        const full = k === 'microsoft' ? await this.graphMail(get, mode, from, terms, max, items) : await this.gmail(get, mode, from, terms, max, items);
        return { value: undefined, count: items.length - before, truncated: full };
      });
    }
    items.sort((a, b) => b.at - a.at);
    return { items, reads };
  }

  /** Devolve true quando parou no limite (havia mais mensagens do que as lidas). */
  private async graphMail(get: Get, mode: MailMode, from: string, terms: string[], max: number, items: MailItem[]): Promise<boolean> {
    const sel = 'subject,from,toRecipients,receivedDateTime,sentDateTime,importance,isRead,flag,inferenceClassification,bodyPreview,conversationId';
    const push = (m: any, folder: 'inbox' | 'sent') => items.push({
      account: 'microsoft', id: String(m.id), thread: String(m.conversationId ?? m.id), at: Date.parse(folder === 'sent' ? m.sentDateTime : m.receivedDateTime),
      from: who(m.from?.emailAddress?.name, m.from?.emailAddress?.address), fromAddr: String(m.from?.emailAddress?.address ?? '').toLowerCase(),
      to: ((m.toRecipients ?? []) as any[]).slice(0, 6).map((r) => who(r.emailAddress?.name, r.emailAddress?.address)), subject: String(m.subject ?? ''), preview: String(m.bodyPreview ?? ''),
      important: m.importance === 'high' || m.flag?.flagStatus === 'flagged', unread: m.isRead === false, folder });
    if (mode === 'relacionados') {
      for (const t of terms) {
        const j = await get(`https://graph.microsoft.com/v1.0/me/messages?${new URLSearchParams({ $search: `"${t}"`, $select: sel, $top: '15' })}`);
        for (const m of (j.value ?? []) as any[]) {
          const at = Date.parse(m.receivedDateTime ?? m.sentDateTime);
          if (at >= Date.parse(from) && !items.some((x) => x.id === String(m.id))) push(m, 'inbox');
        }
      }
      return false; // busca por assunto: amostra por definição (as 15 mais relevantes por termo)
    }
    const inbox = await get(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${new URLSearchParams({ $filter: `receivedDateTime ge ${new Date(from).toISOString()}`, $select: sel, $orderby: 'receivedDateTime desc', $top: String(max) })}`);
    for (const m of (inbox.value ?? []) as any[]) if (m.inferenceClassification !== 'other') push(m, 'inbox'); // só a caixa "Prioritário"
    let more = typeof inbox['@odata.nextLink'] === 'string';
    if (mode !== 'pendencias') return more;
    const sent = await get(`https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${new URLSearchParams({ $filter: `sentDateTime ge ${new Date(from).toISOString()}`, $select: sel, $orderby: 'sentDateTime desc', $top: String(max) })}`);
    for (const m of (sent.value ?? []) as any[]) push(m, 'sent');
    more ||= typeof sent['@odata.nextLink'] === 'string';
    return more;
  }

  private async gmail(get: Get, mode: MailMode, from: string, terms: string[], max: number, items: MailItem[]): Promise<boolean> {
    let more = false;
    const after = Math.floor(Date.parse(from) / 1000);
    const queries = mode === 'relacionados' ? terms.map((t) => `"${t}" after:${after}`) : [`in:inbox category:primary after:${after}`, ...(mode === 'pendencias' ? [`in:sent after:${after}`] : [])];
    for (const q of queries) {
      const list = await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(Math.min(max, 40)) })}`);
      if (mode !== 'relacionados' && list.nextPageToken) more = true;
      const ids = ((list.messages ?? []) as any[]).map((m) => String(m.id)).filter((id) => !items.some((x) => x.id === id));
      for (let i = 0; i < ids.length; i += 5) { // poucas por vez: respeita o limite do Gmail
        const batch = await Promise.all(ids.slice(i, i + 5).map((id) =>
          get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&fields=id,threadId,labelIds,internalDate,snippet,payload/headers`)));
        for (const m of batch) {
          const h = (n: string) => ((m.payload?.headers ?? []) as any[]).find((x) => String(x.name).toLowerCase() === n)?.value;
          const labels = (m.labelIds ?? []) as string[];
          items.push({ account: 'google', id: String(m.id), thread: String(m.threadId ?? m.id), at: Number(m.internalDate), from: who(plainName(h('from')), h('from')), fromAddr: addr(h('from')).toLowerCase(),
            to: String(h('to') ?? '').split(',').filter(Boolean).slice(0, 6).map((x) => who(plainName(x), x)), subject: String(h('subject') ?? ''), preview: xmlText(String(m.snippet ?? '')),
            important: labels.includes('IMPORTANT') || labels.includes('STARRED'), unread: labels.includes('UNREAD'), folder: labels.includes('SENT') ? 'sent' : 'inbox' });
        }
      }
    }
    return more;
  }

  /** Texto de um e-mail, sem o histórico citado (Assistente de Respostas). */
  async mailBody(ws: string, k: SsoKind, mid: string): Promise<string> {
    const text = await this.withAccount<string>(ws, k, 'email', [], async (get) => {
      if (k === 'microsoft') {
        const m = await get(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(mid)}?$select=body,uniqueBody`, { Prefer: 'outlook.body-content-type="text"' });
        return { value: String(m.uniqueBody?.content ?? m.body?.content ?? ''), count: 1 };
      }
      const m = await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(mid)}?format=full`);
      const parts: any[] = [];
      const walk = (p: any) => { if (!p) return; if (p.mimeType === 'text/plain' && p.body?.data) parts.push(p); for (const x of p.parts ?? []) walk(x); };
      walk(m.payload);
      return { value: parts.map((p) => Buffer.from(String(p.body.data), 'base64url').toString('utf8')).join('\n') || String(m.snippet ?? ''), count: 1 };
    });
    return text === null ? '' : withoutQuoted(text);
  }

  /** Compromissos de agora até `days` dias, com participantes e a descrição curta. */
  async events(ws: string, days: number): Promise<{ items: EventItem[]; reads: SourceRead[] }> {
    const reads: SourceRead[] = []; const items: EventItem[] = [];
    const start = Date.now(); const end = start + Math.max(1, Math.min(days, 14)) * 86_400_000;
    for (const k of ['microsoft', 'google'] as SsoKind[]) {
      await this.withAccount<void>(ws, k, 'agenda', reads, async (get) => {
        const before = items.length;
        let more = false;
        if (k === 'microsoft') {
          const q = new URLSearchParams({ startDateTime: new Date(start).toISOString(), endDateTime: new Date(end).toISOString(), $select: 'subject,start,end,isAllDay,isCancelled,location,onlineMeeting,attendees,organizer,bodyPreview', $orderby: 'start/dateTime', $top: String(MAX_EVENTS) });
          const j = await get(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, { Prefer: 'outlook.timezone="UTC"' });
          more = typeof j['@odata.nextLink'] === 'string';
          const z = (v: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`);
          for (const e of (j.value ?? []) as any[]) {
            if (e.isCancelled) continue;
            items.push({ account: k, start: z(e.start?.dateTime), end: z(e.end?.dateTime), allDay: !!e.isAllDay, title: String(e.subject ?? ''), where: e.onlineMeeting ? 'online' : String(e.location?.displayName ?? ''),
              attendees: ((e.attendees ?? []) as any[]).slice(0, 12).map((a) => who(a.emailAddress?.name, a.emailAddress?.address)), organizer: who(e.organizer?.emailAddress?.name, e.organizer?.emailAddress?.address), description: String(e.bodyPreview ?? '') });
          }
        } else {
          const q = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(MAX_EVENTS) });
          const j = await get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
          more = !!j.nextPageToken;
          for (const e of (j.items ?? []) as any[]) {
            if (e.status === 'cancelled') continue;
            const allDay = !e.start?.dateTime;
            items.push({ account: k, start: allDay ? Date.parse(`${e.start?.date}T12:00:00Z`) : Date.parse(e.start.dateTime), end: allDay ? Date.parse(`${e.end?.date ?? e.start?.date}T12:00:00Z`) : Date.parse(e.end?.dateTime ?? e.start.dateTime), allDay,
              title: String(e.summary ?? ''), where: e.hangoutLink ? 'online' : String(e.location ?? ''), attendees: ((e.attendees ?? []) as any[]).slice(0, 12).map((a) => who(a.displayName, a.email)),
              organizer: who(e.organizer?.displayName, e.organizer?.email), description: String(e.description ?? '').replace(/<[^>]+>/g, ' ') });
          }
        }
        return { value: undefined, count: items.length - before, truncated: more };
      });
    }
    items.sort((a, b) => a.start - b.start);
    return { items: items.filter((e) => Number.isFinite(e.start)), reads };
  }

  /** Procura arquivos pelo nome no OneDrive/SharePoint e no Google Drive. */
  async searchFiles(ws: string, q: string): Promise<{ items: CloudFile[]; reads: SourceRead[] }> {
    const reads: SourceRead[] = []; const items: CloudFile[] = [];
    const term = q.replace(/['"\\]/g, ' ').trim().slice(0, 80);
    if (term.length < 2) return { items, reads };
    for (const k of ['microsoft', 'google'] as SsoKind[]) {
      await this.withAccount<void>(ws, k, 'arquivos', reads, async (get) => {
        const before = items.length;
        if (k === 'microsoft') {
          const j = await get(`https://graph.microsoft.com/v1.0/me/drive/root/search(q='${encodeURIComponent(term)}')?$select=id,name,size,file,lastModifiedDateTime,parentReference&$top=25`);
          for (const x of (j.value ?? []) as any[]) if (x.file) items.push({ provider: k, id: String(x.id), name: String(x.name ?? ''), size: Number(x.size ?? 0), modified: x.lastModifiedDateTime ?? null, mime: String(x.file?.mimeType ?? ''), folder: String(x.parentReference?.path ?? '').replace(/^\/drive\/root:?/, '') || 'OneDrive' });
        } else {
          const query = `name contains '${term}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
          const j = await get(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: query, fields: 'files(id,name,mimeType,size,modifiedTime)', pageSize: '25', orderBy: 'modifiedTime desc' })}`);
          for (const x of (j.files ?? []) as any[]) items.push({ provider: k, id: String(x.id), name: String(x.name ?? ''), size: Number(x.size ?? 0), modified: x.modifiedTime ?? null, mime: String(x.mimeType ?? ''), folder: 'Google Drive' });
        }
        return { value: undefined, count: items.length - before };
      });
    }
    return { items, reads };
  }

  /** O conteúdo atual de um arquivo escolhido (rotinas agendadas veem a versão mais nova a cada execução). */
  async fetchFile(ws: string, ref: { provider: SsoKind; id: string }): Promise<{ name: string; mime: string; data: Buffer }> {
    const k = ref.provider;
    let token = await this.sso.accessToken(ws, k);
    const get = this.authed(ws, k, token, (t) => { token = t; });
    const raw = async (url: string): Promise<Buffer> => {
      let res: Response;
      try { res = await fetchWithPolicy(() => fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }), { budgetMs: 60_000 }); } catch { throw new ProviderError('unavailable', 'o serviço não respondeu'); }
      if (res.status === 401 || res.status === 403) throw new ProviderError('forbidden', 'acesso recusado pelo serviço (sem permissão para o arquivo)');
      if (res.status === 404) throw new ProviderError('not_found', 'arquivo não encontrado (apagado ou sem acesso)');
      if (!res.ok) throw new ProviderError('unavailable', `o serviço respondeu ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length > MAX_FILE) throw new ProviderError('unavailable', 'arquivo grande demais (mais de 15 MB)');
      return b;
    };
    const id = encodeURIComponent(ref.id);
    if (k === 'microsoft') {
      const meta = await get(`https://graph.microsoft.com/v1.0/me/drive/items/${id}?$select=name,file,size`);
      if (Number(meta.size ?? 0) > MAX_FILE) throw new ProviderError('unavailable', 'arquivo grande demais (mais de 15 MB)');
      return { name: String(meta.name ?? 'arquivo'), mime: String(meta.file?.mimeType ?? ''), data: await raw(`https://graph.microsoft.com/v1.0/me/drive/items/${id}/content`) };
    }
    const meta = await get(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size`);
    const exp = GOOGLE_EXPORT[String(meta.mimeType)];
    if (exp) return { name: `${String(meta.name ?? 'arquivo')}.${exp.ext}`, mime: exp.mime, data: await raw(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}`) };
    if (String(meta.mimeType).startsWith('application/vnd.google-apps.')) throw new ProviderError('unavailable', 'tipo de arquivo do Google que o sistema não lê');
    if (Number(meta.size ?? 0) > MAX_FILE) throw new ProviderError('unavailable', 'arquivo grande demais (mais de 15 MB)');
    return { name: String(meta.name ?? 'arquivo'), mime: String(meta.mimeType ?? ''), data: await raw(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`) };
  }
}
