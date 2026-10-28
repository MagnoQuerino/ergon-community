/**
 * Aplicativos de tarefas e quadros por token pessoal (somente leitura), no mesmo contrato do espelho
 * (mirror.ts): quadros → colunas → tarefas com título, descrição, situação e responsável.
 * Trello, Jira, ClickUp, monday.com, Notion, Linear, Airtable, Smartsheet, Pipefy e GitHub Projects.
 * Cada um confere a credencial com uma chamada real (whoami) antes de o Ergon dizer "conectado".
 * Formatos conferidos nas documentações oficiais (out/2026); limite de 500 tarefas por quadro.
 */
import crypto from 'node:crypto';
import { ProviderError, type BoardSnapshot, type ExternalBoard, type ExternalTask, type TaskProvider } from './mirror.ts';
import { dueOf } from './due.ts';
import { NetworkFailure, fetchWithPolicy, retryHint, type HttpKind } from '../lib/http.ts';

export const MAX_TASKS = 500;
type Json = any; // respostas externas: lidas campo a campo, com String()/Number() na saída

/**
 * Chamada HTTP com a credencial do usuário; erros viram ProviderError (sem nunca repetir a credencial). Falhas
 * passageiras (sem resposta, 429, 5xx) têm nova tentativa pela política de lib/http.ts. `kind`: toda chamada de
 * hoje é leitura (inclusive as consultas por POST); uma escrita precisa dizer `'write'` (não repete às cegas).
 */
export async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; kind?: HttpKind } = {}): Promise<Json> {
  let res: Response;
  try {
    res = await fetchWithPolicy(() => fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(20000),
    }), { kind: init.kind ?? 'read' });
  } catch (e) {
    throw new ProviderError('unavailable', e instanceof NetworkFailure && e.unknownOutcome ? 'o serviço não confirmou (pode ter feito ou não): confira lá antes de repetir' : 'o serviço não respondeu');
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('forbidden', 'acesso recusado pelo serviço (credencial inválida, expirada ou sem permissão)', { status: res.status });
  if (res.status === 404) throw new ProviderError('not_found', 'não encontrado (ou sem acesso)', { status: 404 });
  if (res.status === 429) throw new ProviderError('unavailable', `limite de uso do serviço atingido; ${retryHint(res)}`);
  if (!res.ok) {
    let why = '';
    try { const e = JSON.parse(await res.text()); const x = e?.error ?? e; why = [x?.code ?? x?.status, x?.message].filter((v) => typeof v === 'string' || typeof v === 'number').join(': '); } catch { /* sem detalhe */ }
    throw new ProviderError('unavailable', `o serviço respondeu ${res.status}${why ? ` (${String(why).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`);
  }
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { throw new ProviderError('unavailable', 'resposta inesperada do serviço'); }
}

/** GraphQL: erro com dados parciais segue com os dados; sem dados, o erro sobe (credencial → "forbidden"). */
async function graphql(url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown> = {}): Promise<Json> {
  const j = await request(url, { headers, body: { query, variables } });
  if (j.errors?.length && !j.data) {
    const msg = String(j.errors[0]?.message ?? 'erro na consulta').slice(0, 200);
    throw new ProviderError(/auth|token|unauthori|forbidden|permission|not authenticated|credential/i.test(msg) ? 'forbidden' : 'unavailable', msg);
  }
  return j.data ?? {};
}

const str = (v: unknown, max = 200) => String(v ?? '').slice(0, max);
const desc = (v: unknown) => String(v ?? '').slice(0, 4000);
/** nomes de coluna/situação que significam "feito" (pt e en) */
export const DONE = /^(done|feito|feita|conclu[ií]d[oa]s?|completed?|closed|fechad[oa]|finalizad[oa]|entregue|resolved|resolvid[oa])$/i;
const hash = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const SUPPORTS = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
type Boards = Array<ExternalBoard & { taskCount: number }>;
const board = (externalId: string, name: string, version = ''): ExternalBoard & { taskCount: number } => ({ externalId, name: str(name), version: str(version, 80), taskCount: -1 });
const ONE_COLUMN = [{ externalId: '__tarefas__', name: 'Tarefas', order: 0 }];

export interface AccountProvider extends TaskProvider { whoami(): Promise<string> }

// ---------------------------------------------------------------- Trello (chave da API + token do usuário)
export class TrelloProvider implements AccountProvider {
  readonly name = 'trello'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(key: string, token: string) { this.h = { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` }; }
  private g(p: string) { return request(`https://api.trello.com/1${p}`, { headers: this.h }); }
  async whoami() { const j = await this.g('/members/me?fields=fullName,username'); return str(j.fullName || j.username || 'conta Trello', 120); }
  async listBoards(): Promise<Boards> {
    return ((await this.g('/members/me/boards?filter=open&fields=name,dateLastActivity')) as Json[]).map((b) => board(String(b.id), b.name, b.dateLastActivity));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^[a-zA-Z0-9]{8,32}$/.test(externalId)) throw new ProviderError('not_found', 'quadro inválido');
    const b = await this.g(`/boards/${externalId}?fields=name,dateLastActivity`);
    const lists = ((await this.g(`/boards/${externalId}/lists?filter=open&fields=name,pos`)) as Json[]).sort((a, c) => Number(a.pos) - Number(c.pos));
    const cards = (await this.g(`/boards/${externalId}/cards?filter=open&fields=name,desc,idList,dueComplete,dateLastActivity&members=true&member_fields=fullName,username`)) as Json[];
    const listName = new Map(lists.map((l) => [String(l.id), String(l.name)]));
    return {
      board: { externalId, name: str(b.name), version: str(b.dateLastActivity, 80) },
      columns: lists.map((l, i) => ({ externalId: String(l.id), name: str(l.name), order: i })),
      tasks: cards.slice(0, MAX_TASKS).map((c): ExternalTask => ({
        externalId: String(c.id), columnExternalId: String(c.idList), title: str(c.name), description: desc(c.desc),
        completed: c.dueComplete === true || DONE.test(listName.get(String(c.idList)) ?? ''), version: str(c.dateLastActivity, 80),
        assignee: c.members?.[0] ? str(c.members[0].fullName || c.members[0].username, 120) : null, due: dueOf(c.due), extra: {},
      })),
      complete: cards.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- Jira Cloud (site + e-mail + token de API)
/** Aceita "empresa", "empresa.atlassian.net" ou o endereço completo; só Jira Cloud (*.atlassian.net). */
export function jiraHost(site: string): string | null {
  const s = site.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const host = /\./.test(s) ? s : `${s}.atlassian.net`;
  return /^[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/.test(host) ? host : null;
}
/** Texto simples de um documento ADF (descrição do Jira). */
function adfText(node: Json): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.text ?? '');
  const inner = (node.content ?? []).map(adfText).join(node.type === 'doc' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}
export class JiraProvider implements AccountProvider {
  readonly name = 'jira'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly base: string; private readonly h: Record<string, string>;
  constructor(site: string, email: string, token: string) {
    const host = jiraHost(site);
    if (!host) throw new ProviderError('not_found', 'endereço do Jira inválido (use sua-empresa.atlassian.net)');
    this.base = `https://${host}/rest/api/3`;
    this.h = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  }
  private g(p: string, body?: unknown) { return request(`${this.base}${p}`, { headers: this.h, body }); }
  async whoami() { const j = await this.g('/myself'); return str(j.displayName || j.emailAddress || 'conta Jira', 120); }
  async listBoards(): Promise<Boards> {
    const out: Boards = []; let start = 0;
    for (let i = 0; i < 5; i++) {
      const j = await this.g(`/project/search?maxResults=100&startAt=${start}&orderBy=name`);
      for (const p of j.values ?? []) out.push(board(String(p.key), `${p.name} (${p.key})`));
      if (j.isLast !== false || !(j.values ?? []).length) break;
      start += (j.values ?? []).length;
    }
    return out;
  }
  async getBoard(key: string): Promise<BoardSnapshot> {
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(key)) throw new ProviderError('not_found', 'projeto inválido');
    const p = await this.g(`/project/${key}`);
    // as situações do projeto, na ordem das categorias (a fazer → em andamento → feito)
    const cat: Record<string, number> = { new: 0, indeterminate: 1, done: 2 };
    const seen = new Map<string, { name: string; cat: number }>();
    for (const it of (await this.g(`/project/${key}/statuses`)) as Json[]) for (const s of it.statuses ?? []) {
      if (!seen.has(String(s.id))) seen.set(String(s.id), { name: String(s.name), cat: cat[s.statusCategory?.key] ?? 1 });
    }
    const columns = [...seen.entries()].sort((a, b) => a[1].cat - b[1].cat).map(([id, s], i) => ({ externalId: id, name: str(s.name), order: i }));
    const issues: Json[] = []; let next: string | null = null; let last = false;
    for (let i = 0; i < 6 && !last; i++) {
      const j = await this.g('/search/jql', { jql: `project = "${key}" ORDER BY updated DESC`, fields: ['summary', 'status', 'assignee', 'description', 'updated', 'duedate'], maxResults: 100, ...(next ? { nextPageToken: next } : {}) });
      issues.push(...(j.issues ?? []));
      next = j.nextPageToken ?? null; last = j.isLast === true || !next;
      if (issues.length >= MAX_TASKS) break;
    }
    return {
      board: { externalId: key, name: str(p.name), version: '' },
      columns: columns.length ? columns : ONE_COLUMN,
      tasks: issues.slice(0, MAX_TASKS).map((t): ExternalTask => ({
        externalId: String(t.key ?? t.id), columnExternalId: t.fields?.status?.id ? String(t.fields.status.id) : (columns[0]?.externalId ?? '__tarefas__'),
        title: str(`${t.key} · ${t.fields?.summary ?? ''}`), description: desc(adfText(t.fields?.description).trim()),
        completed: t.fields?.status?.statusCategory?.key === 'done', version: str(t.fields?.updated, 80),
        assignee: t.fields?.assignee?.displayName ? str(t.fields.assignee.displayName, 120) : null, due: dueOf(t.fields?.duedate), extra: {},
      })),
      complete: last && issues.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- ClickUp (token pessoal pk_…)
export class ClickUpProvider implements AccountProvider {
  readonly name = 'clickup'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: token }; }
  private g(p: string) { return request(`https://api.clickup.com/api/v2${p}`, { headers: this.h }); }
  async whoami() { const j = await this.g('/user'); return str(j.user?.username || j.user?.email || 'conta ClickUp', 120); }
  async listBoards(): Promise<Boards> {
    const out: Boards = [];
    for (const team of ((await this.g('/team')).teams ?? []).slice(0, 3)) {
      for (const sp of ((await this.g(`/team/${team.id}/space?archived=false`)).spaces ?? []).slice(0, 15)) {
        for (const f of (await this.g(`/space/${sp.id}/folder?archived=false`)).folders ?? []) {
          for (const l of f.lists ?? []) out.push(board(String(l.id), `${sp.name} › ${f.name} › ${l.name}`));
        }
        for (const l of (await this.g(`/space/${sp.id}/list?archived=false`)).lists ?? []) out.push(board(String(l.id), `${sp.name} › ${l.name}`));
        if (out.length >= 300) return out;
      }
    }
    return out;
  }
  async getBoard(listId: string): Promise<BoardSnapshot> {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(listId)) throw new ProviderError('not_found', 'lista inválida');
    const l = await this.g(`/list/${listId}`);
    const statuses = ((l.statuses ?? []) as Json[]).sort((a, b) => Number(a.orderindex) - Number(b.orderindex));
    const tasks: Json[] = []; let lastPage = false;
    for (let page = 0; page < 6 && !lastPage; page++) {
      const j = await this.g(`/list/${listId}/task?include_closed=true&subtasks=true&page=${page}`);
      tasks.push(...(j.tasks ?? []));
      lastPage = j.last_page !== false || !(j.tasks ?? []).length;
      if (tasks.length >= MAX_TASKS) break;
    }
    const colOf = (s: string) => s.toLowerCase();
    return {
      board: { externalId: listId, name: str(l.name), version: '' },
      columns: statuses.length ? statuses.map((s, i) => ({ externalId: colOf(String(s.status)), name: str(s.status), order: i })) : ONE_COLUMN,
      tasks: tasks.slice(0, MAX_TASKS).map((t): ExternalTask => ({
        externalId: String(t.id), columnExternalId: statuses.length ? colOf(String(t.status?.status ?? '')) : '__tarefas__', title: str(t.name),
        description: desc(t.text_content ?? t.description), completed: t.status?.type === 'closed' || t.status?.type === 'done',
        version: str(t.date_updated, 80), assignee: t.assignees?.[0] ? str(t.assignees[0].username || t.assignees[0].email, 120) : null, due: dueOf(t.due_date), extra: {},
      })),
      complete: lastPage && tasks.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- monday.com (token pessoal, GraphQL)
const MONDAY_ITEMS = 'cursor items { id name updated_at group { id } column_values { id type text } }';
export class MondayProvider implements AccountProvider {
  readonly name = 'monday'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: token }; }
  private q(query: string, v: Record<string, unknown> = {}) { return graphql('https://api.monday.com/v2', this.h, query, v); }
  async whoami() { const d = await this.q('{ me { name email } }'); return str(d.me?.name || d.me?.email || 'conta monday.com', 120); }
  async listBoards(): Promise<Boards> {
    const d = await this.q('{ boards(limit: 200, state: active, order_by: used_at) { id name updated_at type } }');
    return ((d.boards ?? []) as Json[]).filter((b) => !b.type || b.type === 'board').map((b) => board(String(b.id), b.name, b.updated_at));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^\d{1,20}$/.test(externalId)) throw new ProviderError('not_found', 'quadro inválido');
    const d = await this.q(`query ($ids: [ID!]) { boards(ids: $ids) { id name updated_at groups { id title position } items_page(limit: 100) { ${MONDAY_ITEMS} } } }`, { ids: [externalId] });
    const b = d.boards?.[0];
    if (!b) throw new ProviderError('not_found', 'quadro não encontrado (ou sem acesso)');
    const items: Json[] = [...(b.items_page?.items ?? [])]; let cursor: string | null = b.items_page?.cursor ?? null;
    for (let i = 0; i < 5 && cursor && items.length < MAX_TASKS; i++) {
      const n = (await this.q(`query ($c: String!) { next_items_page(limit: 100, cursor: $c) { ${MONDAY_ITEMS} } }`, { c: cursor })).next_items_page;
      items.push(...(n?.items ?? [])); cursor = n?.cursor ?? null;
    }
    const groups = ((b.groups ?? []) as Json[]).sort((a, c) => Number(a.position) - Number(c.position));
    const col = (it: Json, type: string) => ((it.column_values ?? []) as Json[]).find((c) => c.type === type && c.text)?.text as string | undefined;
    return {
      board: { externalId, name: str(b.name), version: str(b.updated_at, 80) },
      columns: groups.length ? groups.map((g, i) => ({ externalId: String(g.id), name: str(g.title), order: i })) : ONE_COLUMN,
      tasks: items.slice(0, MAX_TASKS).map((it): ExternalTask => {
        const status = col(it, 'status') ?? '';
        const people = col(it, 'people');
        return {
          externalId: String(it.id), columnExternalId: it.group?.id ? String(it.group.id) : (groups[0] ? String(groups[0].id) : '__tarefas__'),
          title: str(it.name), description: desc(col(it, 'long_text') ?? ''), completed: DONE.test(status.trim()), version: str(it.updated_at, 80),
          assignee: people ? str(people.split(',')[0].trim(), 120) : null, extra: {},
        };
      }),
      complete: !cursor,
    };
  }
}

// ---------------------------------------------------------------- Notion (integração interna, fontes de dados)
const NOTION_VERSION = '2025-09-03';
const plain = (rich: Json) => ((rich ?? []) as Json[]).map((r) => String(r.plain_text ?? '')).join('');
export class NotionProvider implements AccountProvider {
  readonly name = 'notion'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }; }
  private g(p: string, body?: unknown) { return request(`https://api.notion.com/v1${p}`, { headers: this.h, body }); }
  async whoami() { const j = await this.g('/users/me'); return str(j.bot?.workspace_name || j.name || 'Notion', 120); }
  async listBoards(): Promise<Boards> {
    const out: Boards = []; let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const j = await this.g('/search', { filter: { property: 'object', value: 'data_source' }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const ds of j.results ?? []) out.push(board(String(ds.id), plain(ds.title) || 'Sem título', ds.last_edited_time));
      cursor = j.has_more ? j.next_cursor : null;
      if (!cursor) break;
    }
    return out;
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^[a-f0-9-]{32,36}$/i.test(externalId)) throw new ProviderError('not_found', 'base inválida');
    const ds = await this.g(`/data_sources/${externalId}`);
    const props = Object.entries((ds.properties ?? {}) as Record<string, Json>);
    const titleKey = props.find(([, p]) => p.type === 'title')?.[0];
    const named = (types: string[], re: RegExp) => props.find(([n, p]) => types.includes(p.type) && re.test(n)) ?? props.find(([, p]) => types.includes(p.type) && p.type === 'status');
    const statusEntry = named(['status', 'select'], /status|situa|etapa|fase|estado/i);
    const checkKey = props.find(([n, p]) => p.type === 'checkbox' && /done|feit|conclu|complet/i.test(n))?.[0];
    const peopleKey = props.find(([, p]) => p.type === 'people')?.[0];
    const descKey = props.find(([n, p]) => p.type === 'rich_text' && /descri|nota|notes|detalhe/i.test(n))?.[0];
    const sp = statusEntry?.[1];
    const options: Json[] = sp ? (sp[sp.type]?.options ?? []) : [];
    // grupos do Notion: "Complete"/"Concluído" marcam as opções que significam feito
    const doneIds = new Set<string>(((sp?.status?.groups ?? []) as Json[]).filter((g) => /complete|conclu/i.test(String(g.name))).flatMap((g) => g.option_ids ?? []));
    const pages: Json[] = []; let cursor: string | null = null; let more = true;
    for (let i = 0; i < 6 && more; i++) {
      const j = await this.g(`/data_sources/${externalId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      pages.push(...(j.results ?? []).filter((r: Json) => r.object === 'page'));
      cursor = j.next_cursor ?? null; more = j.has_more === true && !!cursor;
      if (pages.length >= MAX_TASKS) break;
    }
    const NONE = '__sem_status__';
    return {
      board: { externalId, name: plain(ds.title) || 'Sem título', version: str(ds.last_edited_time, 80) },
      columns: options.length ? [{ externalId: NONE, name: 'Sem status', order: -1 }, ...options.map((o, i) => ({ externalId: String(o.id), name: str(o.name), order: i }))] : ONE_COLUMN,
      tasks: pages.slice(0, MAX_TASKS).map((pg): ExternalTask => {
        const pr = pg.properties ?? {};
        const st = statusEntry ? pr[statusEntry[0]]?.[sp.type] : null;
        return {
          externalId: String(pg.id), columnExternalId: options.length ? (st?.id ? String(st.id) : NONE) : '__tarefas__',
          title: str(titleKey ? plain(pr[titleKey]?.title) : '') || 'Sem título', description: desc(descKey ? plain(pr[descKey]?.rich_text) : ''),
          completed: (checkKey ? pr[checkKey]?.checkbox === true : false) || (st?.id ? doneIds.has(String(st.id)) : false) || DONE.test(String(st?.name ?? '')),
          version: str(pg.last_edited_time, 80), assignee: peopleKey && pr[peopleKey]?.people?.[0]?.name ? str(pr[peopleKey].people[0].name, 120) : null, extra: {},
        };
      }),
      complete: !more && pages.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- Linear (chave de API pessoal, GraphQL)
export class LinearProvider implements AccountProvider {
  readonly name = 'linear'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(key: string) { this.h = { Authorization: key }; }
  private q(query: string, v: Record<string, unknown> = {}) { return graphql('https://api.linear.app/graphql', this.h, query, v); }
  async whoami() { const d = await this.q('{ viewer { name email } }'); return str(d.viewer?.name || d.viewer?.email || 'conta Linear', 120); }
  async listBoards(): Promise<Boards> {
    const d = await this.q('{ teams(first: 100) { nodes { id name key updatedAt } } }');
    return ((d.teams?.nodes ?? []) as Json[]).map((t) => board(String(t.id), `${t.name} (${t.key})`, t.updatedAt));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^[a-f0-9-]{36}$/i.test(externalId)) throw new ProviderError('not_found', 'time inválido');
    const Q = `query ($id: String!, $after: String) { team(id: $id) { name updatedAt states { nodes { id name type position } }
      issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id identifier title description updatedAt dueDate state { id type } assignee { name } } } } }`;
    let team: Json = null; const issues: Json[] = []; let after: string | null = null; let more = true;
    for (let i = 0; i < 5 && more; i++) {
      team = (await this.q(Q, { id: externalId, after })).team;
      if (!team) throw new ProviderError('not_found', 'time não encontrado (ou sem acesso)');
      issues.push(...(team.issues?.nodes ?? []));
      more = team.issues?.pageInfo?.hasNextPage === true; after = team.issues?.pageInfo?.endCursor ?? null;
      if (issues.length >= MAX_TASKS) break;
    }
    const states = ((team.states?.nodes ?? []) as Json[]).sort((a, b) => Number(a.position) - Number(b.position));
    return {
      board: { externalId, name: str(team.name), version: str(team.updatedAt, 80) },
      columns: states.length ? states.map((s, i) => ({ externalId: String(s.id), name: str(s.name), order: i })) : ONE_COLUMN,
      tasks: issues.slice(0, MAX_TASKS).map((t): ExternalTask => ({
        externalId: String(t.id), columnExternalId: t.state?.id ? String(t.state.id) : (states[0] ? String(states[0].id) : '__tarefas__'),
        title: str(`${t.identifier} · ${t.title}`), description: desc(t.description), completed: t.state?.type === 'completed' || t.state?.type === 'canceled',
        version: str(t.updatedAt, 80), assignee: t.assignee?.name ? str(t.assignee.name, 120) : null, due: dueOf(t.dueDate), extra: {},
      })),
      complete: !more && issues.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- Airtable (token pessoal; cada tabela é um quadro)
export class AirtableProvider implements AccountProvider {
  readonly name = 'airtable'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: `Bearer ${token}` }; }
  private g(p: string) { return request(`https://api.airtable.com/v0${p}`, { headers: this.h }); }
  async whoami() { const j = await this.g('/meta/whoami'); return str(j.email || 'conta Airtable', 120); }
  private async tables(baseId: string): Promise<Json[]> { return (await this.g(`/meta/bases/${baseId}/tables`)).tables ?? []; }
  async listBoards(): Promise<Boards> {
    const out: Boards = [];
    for (const b of ((await this.g('/meta/bases')).bases ?? []).slice(0, 20)) {
      for (const t of await this.tables(String(b.id))) out.push(board(`${b.id}/${t.id}`, `${b.name} › ${t.name}`));
    }
    return out;
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const [baseId, tableId] = externalId.split('/');
    if (!/^app[a-zA-Z0-9]{8,20}$/.test(baseId ?? '') || !/^tbl[a-zA-Z0-9]{8,20}$/.test(tableId ?? '')) throw new ProviderError('not_found', 'tabela inválida');
    const t = (await this.tables(baseId)).find((x) => String(x.id) === tableId);
    if (!t) throw new ProviderError('not_found', 'tabela não encontrada (ou sem acesso)');
    const fields = (t.fields ?? []) as Json[];
    const status = fields.find((f) => f.type === 'singleSelect' && /status|situa|etapa|fase|estado/i.test(f.name)) ?? fields.find((f) => f.type === 'singleSelect');
    const check = fields.find((f) => f.type === 'checkbox' && /done|feit|conclu|complet/i.test(f.name));
    const who = fields.find((f) => f.type === 'singleCollaborator' || f.type === 'multipleCollaborators');
    const notes = fields.find((f) => (f.type === 'multilineText' || f.type === 'richText') && /descri|nota|notes|detalhe/i.test(f.name));
    const choices = (status?.options?.choices ?? []) as Json[];
    const records: Json[] = []; let offset: string | null = null; let more = true;
    for (let i = 0; i < 6 && more; i++) {
      const j = await this.g(`/${baseId}/${tableId}?pageSize=100&returnFieldsByFieldId=true${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`);
      records.push(...(j.records ?? []));
      offset = j.offset ?? null; more = !!offset;
      if (records.length >= MAX_TASKS) break;
    }
    const NONE = '__sem_status__';
    return {
      board: { externalId, name: str(t.name), version: '' },
      columns: choices.length ? [{ externalId: NONE, name: 'Sem status', order: -1 }, ...choices.map((c, i) => ({ externalId: String(c.name), name: str(c.name), order: i }))] : ONE_COLUMN,
      tasks: records.slice(0, MAX_TASKS).map((r): ExternalTask => {
        const f = r.fields ?? {};
        const st = status ? f[status.id] : undefined;
        const person = who ? (Array.isArray(f[who.id]) ? f[who.id][0] : f[who.id]) : null;
        return {
          externalId: String(r.id), columnExternalId: choices.length ? (st ? String(st) : NONE) : '__tarefas__',
          title: str(f[t.primaryFieldId] ?? '') || 'Sem título', description: desc(notes ? f[notes.id] : ''),
          completed: (check ? f[check.id] === true : false) || DONE.test(String(st ?? '')), version: hash(f),
          assignee: person ? str(person.name || person.email, 120) : null, extra: {},
        };
      }),
      complete: !more && records.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- Smartsheet (token de API; cada planilha é um quadro)
export class SmartsheetProvider implements AccountProvider {
  readonly name = 'smartsheet'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: `Bearer ${token}` }; }
  private g(p: string) { return request(`https://api.smartsheet.com/2.0${p}`, { headers: this.h }); }
  async whoami() { const j = await this.g('/users/me'); return str(`${j.firstName ?? ''} ${j.lastName ?? ''}`.trim() || j.email || 'conta Smartsheet', 120); }
  async listBoards(): Promise<Boards> {
    return ((await this.g('/sheets?includeAll=true')).data ?? []).map((s: Json) => board(String(s.id), s.name, s.modifiedAt));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^\d{1,20}$/.test(externalId)) throw new ProviderError('not_found', 'planilha inválida');
    const s = await this.g(`/sheets/${externalId}`);
    const cols = (s.columns ?? []) as Json[];
    const primary = cols.find((c) => c.primary) ?? cols[0];
    const status = cols.find((c) => c.type === 'PICKLIST' && /status|situa|etapa|fase|estado/i.test(c.title));
    const check = cols.find((c) => c.type === 'CHECKBOX' && /done|feit|conclu|complet/i.test(c.title));
    const who = cols.find((c) => c.type === 'CONTACT_LIST' || c.type === 'MULTI_CONTACT_LIST');
    const notes = cols.find((c) => c.type === 'TEXT_NUMBER' && /descri|nota|notes|detalhe/i.test(c.title));
    const options = (status?.options ?? []) as string[];
    const rows = (s.rows ?? []) as Json[];
    const cell = (r: Json, c: Json | undefined) => (c ? ((r.cells ?? []) as Json[]).find((x) => String(x.columnId) === String(c.id)) : undefined);
    const NONE = '__sem_status__';
    return {
      board: { externalId, name: str(s.name), version: str(s.modifiedAt, 80) },
      columns: options.length ? [{ externalId: NONE, name: 'Sem status', order: -1 }, ...options.map((o, i) => ({ externalId: String(o), name: str(o), order: i }))] : ONE_COLUMN,
      tasks: rows.filter((r) => cell(r, primary)?.value != null).slice(0, MAX_TASKS).map((r): ExternalTask => {
        const st = cell(r, status)?.value;
        return {
          externalId: String(r.id), columnExternalId: options.length ? (st ? String(st) : NONE) : '__tarefas__',
          title: str(cell(r, primary)?.displayValue ?? cell(r, primary)?.value), description: desc(cell(r, notes)?.value ?? ''),
          completed: cell(r, check)?.value === true || DONE.test(String(st ?? '')), version: str(r.modifiedAt, 80),
          assignee: cell(r, who)?.displayValue ? str(String(cell(r, who)!.displayValue).split(',')[0].trim(), 120) : null, extra: {},
        };
      }),
      complete: rows.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- Pipefy (token pessoal, GraphQL; cada pipe é um quadro)
export class PipefyProvider implements AccountProvider {
  readonly name = 'pipefy'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: `Bearer ${token}` }; }
  private q(query: string, v: Record<string, unknown> = {}) { return graphql('https://api.pipefy.com/graphql', this.h, query, v); }
  async whoami() { const d = await this.q('{ me { name email } }'); return str(d.me?.name || d.me?.email || 'conta Pipefy', 120); }
  async listBoards(): Promise<Boards> {
    const orgs = ((await this.q('{ organizations { id name pipes { id name } } }')).organizations ?? []) as Json[];
    return orgs.flatMap((o) => ((o.pipes ?? []) as Json[]).map((p) => board(String(p.id), orgs.length > 1 ? `${o.name} › ${p.name}` : String(p.name))));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^\d{1,20}$/.test(externalId)) throw new ProviderError('not_found', 'pipe inválido');
    const pipe = (await this.q('query ($id: ID!) { pipe(id: $id) { name phases { id name done } } }', { id: externalId })).pipe;
    if (!pipe) throw new ProviderError('not_found', 'pipe não encontrado (ou sem acesso)');
    const phases = (pipe.phases ?? []) as Json[];
    const donePhase = new Set(phases.filter((p) => p.done === true).map((p) => String(p.id)));
    const cards: Json[] = []; let after: string | null = null; let more = true;
    for (let i = 0; i < 10 && more; i++) {
      const c: Json = (await this.q(`query ($id: ID!, $after: String) { cards(pipe_id: $id, first: 50, after: $after) {
        pageInfo { hasNextPage endCursor } edges { node { id title done updated_at current_phase { id } assignees { name } } } } }`, { id: externalId, after })).cards;
      cards.push(...((c?.edges ?? []) as Json[]).map((e) => e.node));
      more = c?.pageInfo?.hasNextPage === true; after = c?.pageInfo?.endCursor ?? null;
      if (cards.length >= MAX_TASKS) break;
    }
    return {
      board: { externalId, name: str(pipe.name), version: '' },
      columns: phases.length ? phases.map((p, i) => ({ externalId: String(p.id), name: str(p.name), order: i })) : ONE_COLUMN,
      tasks: cards.slice(0, MAX_TASKS).map((c): ExternalTask => ({
        externalId: String(c.id), columnExternalId: c.current_phase?.id ? String(c.current_phase.id) : (phases[0] ? String(phases[0].id) : '__tarefas__'),
        title: str(c.title), description: '', completed: c.done === true || donePhase.has(String(c.current_phase?.id ?? '')),
        version: str(c.updated_at, 80), assignee: c.assignees?.[0]?.name ? str(c.assignees[0].name, 120) : null, extra: {},
      })),
      complete: !more && cards.length <= MAX_TASKS,
    };
  }
}

// ---------------------------------------------------------------- GitHub Projects (token pessoal; projetos v2)
const GH_PROJECT = 'nodes { id title updatedAt closed }';
export class GitHubProjectsProvider implements AccountProvider {
  readonly name = 'github'; readonly isFixture = false; readonly supports = SUPPORTS;
  private readonly h: Record<string, string>;
  constructor(token: string) { this.h = { Authorization: `Bearer ${token}`, 'User-Agent': 'Ergon' }; }
  private q(query: string, v: Record<string, unknown> = {}) { return graphql('https://api.github.com/graphql', this.h, query, v); }
  async whoami() { const d = await this.q('{ viewer { login name } }'); return str(d.viewer?.name || d.viewer?.login || 'conta GitHub', 120); }
  async listBoards(): Promise<Boards> {
    const d = await this.q(`{ viewer { login projectsV2(first: 50) { ${GH_PROJECT} } organizations(first: 20) { nodes { login projectsV2(first: 50) { ${GH_PROJECT} } } } } }`);
    const out: Boards = [];
    const add = (owner: string, nodes: Json[]) => { for (const p of nodes ?? []) if (p && !p.closed) out.push(board(String(p.id), `${owner} › ${p.title}`, p.updatedAt)); };
    add(String(d.viewer?.login ?? 'eu'), d.viewer?.projectsV2?.nodes);
    for (const o of d.viewer?.organizations?.nodes ?? []) if (o) add(String(o.login), o.projectsV2?.nodes);
    return out;
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    if (!/^PVT_[A-Za-z0-9_-]{4,60}$/.test(externalId)) throw new ProviderError('not_found', 'projeto inválido');
    const Q = `query ($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { title updatedAt
      field(name: "Status") { ... on ProjectV2SingleSelectField { options { id name } } }
      items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id updatedAt isArchived
        fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
        content { __typename ... on Issue { title body state assignees(first: 1) { nodes { login name } } }
          ... on PullRequest { title body state assignees(first: 1) { nodes { login name } } }
          ... on DraftIssue { title body assignees(first: 1) { nodes { login name } } } } } } } } }`;
    let p: Json = null; const items: Json[] = []; let after: string | null = null; let more = true;
    for (let i = 0; i < 5 && more; i++) {
      p = (await this.q(Q, { id: externalId, after })).node;
      if (!p) throw new ProviderError('not_found', 'projeto não encontrado (ou sem acesso)');
      items.push(...((p.items?.nodes ?? []) as Json[]).filter((n) => n && !n.isArchived && n.content));
      more = p.items?.pageInfo?.hasNextPage === true; after = p.items?.pageInfo?.endCursor ?? null;
      if (items.length >= MAX_TASKS) break;
    }
    const options = (p.field?.options ?? []) as Json[];
    const NONE = '__sem_status__';
    return {
      board: { externalId, name: str(p.title), version: str(p.updatedAt, 80) },
      columns: [{ externalId: NONE, name: 'Sem status', order: -1 }, ...options.map((o, i) => ({ externalId: String(o.id), name: str(o.name), order: i }))],
      tasks: items.slice(0, MAX_TASKS).map((n): ExternalTask => {
        const who = n.content.assignees?.nodes?.[0];
        return {
          externalId: String(n.id), columnExternalId: n.fieldValueByName?.optionId ? String(n.fieldValueByName.optionId) : NONE,
          title: str(n.content.title), description: desc(n.content.body),
          completed: n.content.state === 'CLOSED' || n.content.state === 'MERGED' || DONE.test(String(n.fieldValueByName?.name ?? '')),
          version: str(n.updatedAt, 80), assignee: who ? str(who.name || who.login, 120) : null, extra: {},
        };
      }),
      complete: !more && items.length <= MAX_TASKS,
    };
  }
}
