/**
 * Integrações da conta do usuário: Microsoft 365 e Google (login com a conta — SSO parametrizado em sso.ts:
 * Planner, To Do, Teams; Google Tasks), WhatsApp (QR, só leitura) e os aplicativos de tarefas e quadros por
 * token pessoal (Asana, Todoist e os de task-providers.ts). "Conectado" só depois de uma chamada real aceita pelo
 * serviço. Os que ainda dependem de registrar o app do Ergon no fornecedor aparecem como "em breve", sem fingir.
 * Tokens nunca vão para o banco, o navegador ou o log: ficam em /data/secrets (volume de dados, 0600).
 * O espelho de tarefas lê só título, descrição, situação (concluída ou não) e responsável.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { ProviderError, type BoardSnapshot, type ExternalBoard, type TaskProvider } from './mirror.ts';
import { SSO, SsoAuth, isSso, type SsoKind } from './sso.ts';
import { FieldCipher } from '../security/fields.ts';
import { dueAt, dueOf } from './due.ts';
import { workspaceTz } from './routine-proposals.ts';
import {
  AirtableProvider, ClickUpProvider, GitHubProjectsProvider, JiraProvider, LinearProvider, MondayProvider, NotionProvider, PipefyProvider,
  SmartsheetProvider, TrelloProvider, jiraHost, request, type AccountProvider,
} from './task-providers.ts';

export type IntegrationKind =
  | 'microsoft' | 'google' | 'whatsapp' | 'asana' | 'todoist' | 'trello' | 'jira' | 'clickup' | 'monday' | 'notion' | 'linear'
  | 'airtable' | 'smartsheet' | 'pipefy' | 'github' | 'bitrix';
/** Campo de credencial pedido na tela (o valor nunca volta ao navegador). */
export interface CredentialField { name: string; label: string; secret?: boolean; placeholder?: string; pattern?: RegExp; patternHelp?: string }
export interface IntegrationDef {
  kind: IntegrationKind; name: string;
  /** oauth: login com a conta · qr: WhatsApp · token: credencial colada · soon: ainda não (motivo em "soon") */
  auth: 'oauth' | 'qr' | 'token' | 'soon';
  group: 'contas' | 'tarefas' | 'conversas'; about: string; tasks: boolean; site: string;
  fields?: CredentialField[]; help?: { url: string; steps: string }; soon?: string;
}

const TOKEN: CredentialField[] = [{ name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui' }];

/**
 * Catálogo de conexões. Escolha dos aplicativos de tarefas (pesquisa de out/2026): os líderes de mercado com API
 * própria e os mais conhecidos no Brasil. A ordem da lista é a de fama no Brasil (estimativa, sem dado auditado):
 * Trello, Notion, Asana, monday.com, ClickUp, Jira, Pipefy, Todoist, Bitrix24, Airtable, GitHub Projects,
 * Smartsheet, Linear. Fora: os pouco conhecidos aqui (TickTick, Wrike, Basecamp, Zoho, Runrun.it) e os sem API
 * pública (Things, Any.do).
 */
export const INTEGRATIONS: IntegrationDef[] = [
  { kind: 'microsoft', name: 'Microsoft 365', auth: 'oauth', group: 'contas', tasks: true, site: 'microsoft.com',
    about: 'Entre com a sua conta Microsoft (trabalho ou pessoal). Tarefas: Planner e To Do. E-mail, agenda e arquivos: só leitura, para as rotinas. Teams: as conversas chegam quando o app do Ergon estiver instalado no seu Teams.' },
  { kind: 'google', name: 'Google', auth: 'oauth', group: 'contas', tasks: true, site: 'google.com',
    about: 'Entre com a sua conta Google (Gmail ou Workspace). Tarefas: listas do Google Tasks. Agenda, Gmail e Drive: só leitura, para as rotinas. Nada é enviado em seu nome.' },
  { kind: 'whatsapp', name: 'WhatsApp', auth: 'qr', group: 'conversas', tasks: false, site: 'whatsapp.com',
    about: 'Leia o QR code com o WhatsApp do celular (Aparelhos conectados). Somente leitura: o Ergon lê as conversas que você permitir e nunca envia mensagens.' },
  { kind: 'trello', name: 'Trello', auth: 'token', group: 'tarefas', tasks: true, site: 'trello.com',
    about: 'Quadros do Trello: listas viram colunas; cartões, tarefas.',
    fields: [
      { name: 'key', label: 'Chave da API', placeholder: '32 caracteres', pattern: /^[a-f0-9]{32}$/i, patternHelp: 'a chave tem 32 letras e números' },
      { name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui' },
    ],
    help: { url: 'https://trello.com/power-ups/admin', steps: 'No Trello: Power-Ups e integrações › Admin › "Novo" (qualquer nome) › "Gerar uma nova chave de API". Na mesma página, clique em "Token" ao lado da chave, autorize só leitura e copie o token.' } },
  { kind: 'notion', name: 'Notion', auth: 'token', group: 'tarefas', tasks: true, site: 'notion.so', fields: TOKEN,
    about: 'Bancos de dados do Notion: a propriedade de status vira colunas. O Notion só mostra ao Ergon as páginas que você compartilhar com a integração.',
    help: { url: 'https://www.notion.so/profile/integrations', steps: 'No Notion: Integrações › "Nova integração" (interna, só leitura) › copie o "Segredo interno". Depois, em cada banco de tarefas: ••• › Conexões › adicione a integração.' } },
  { kind: 'asana', name: 'Asana', auth: 'token', group: 'tarefas', tasks: true, site: 'asana.com', fields: TOKEN,
    about: 'Projetos do Asana: seções viram colunas.',
    help: { url: 'https://app.asana.com/0/my-apps', steps: 'No Asana: Meu perfil › Apps › Console do desenvolvedor › "Criar token de acesso pessoal". Copie e cole aqui.' } },
  { kind: 'monday', name: 'monday.com', auth: 'token', group: 'tarefas', tasks: true, site: 'monday.com', fields: TOKEN,
    about: 'Quadros do monday.com: grupos viram colunas; a coluna de status diz o que está feito.',
    help: { url: 'https://auth.monday.com/users/sign_in', steps: 'No monday.com: sua foto › Developers › "Meus tokens de acesso" › "Mostrar" e copiar. Cole aqui.' } },
  { kind: 'clickup', name: 'ClickUp', auth: 'token', group: 'tarefas', tasks: true, site: 'clickup.com', fields: TOKEN,
    about: 'Listas do ClickUp: as situações da lista viram colunas.',
    help: { url: 'https://app.clickup.com/settings/apps', steps: 'No ClickUp: Configurações › Apps › "Gerar" o token de API pessoal (começa com pk_). Copie e cole aqui.' } },
  { kind: 'jira', name: 'Jira', auth: 'token', group: 'tarefas', tasks: true, site: 'atlassian.com',
    about: 'Projetos do Jira Cloud: situações viram colunas; issues, tarefas.',
    fields: [
      { name: 'site', label: 'Endereço do Jira', placeholder: 'sua-empresa.atlassian.net' },
      { name: 'email', label: 'E-mail da sua conta Atlassian', placeholder: 'voce@empresa.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHelp: 'e-mail inválido' },
      { name: 'token', label: 'Token de API', secret: true, placeholder: 'Cole o token aqui' },
    ],
    help: { url: 'https://id.atlassian.com/manage-profile/security/api-tokens', steps: 'Na sua conta Atlassian: Segurança › "Criar token de API". Copie e cole aqui, com o endereço do seu Jira e o e-mail da conta.' } },
  { kind: 'pipefy', name: 'Pipefy', auth: 'token', group: 'tarefas', tasks: true, site: 'pipefy.com', fields: TOKEN,
    about: 'Pipes do Pipefy: fases viram colunas; cards, tarefas.',
    help: { url: 'https://app.pipefy.com/tokens', steps: 'No Pipefy: Conta › Tokens de acesso pessoal › "Gerar novo token". Copie e cole aqui.' } },
  { kind: 'todoist', name: 'Todoist', auth: 'token', group: 'tarefas', tasks: true, site: 'todoist.com', fields: TOKEN,
    about: 'Projetos do Todoist: seções viram colunas.',
    help: { url: 'https://app.todoist.com/app/settings/integrations/developer', steps: 'No Todoist: Configurações › Integrações › Desenvolvedor › "Token da API". Copie e cole aqui.' } },
  { kind: 'bitrix', name: 'Bitrix24', auth: 'soon', group: 'tarefas', tasks: true, site: 'bitrix24.com.br', about: 'Tarefas e projetos do Bitrix24.', soon: 'Em preparo.' },
  { kind: 'airtable', name: 'Airtable', auth: 'token', group: 'tarefas', tasks: true, site: 'airtable.com', fields: TOKEN,
    about: 'Tabelas do Airtable: um campo de seleção de status vira colunas.',
    help: { url: 'https://airtable.com/create/tokens', steps: 'No Airtable: Developer hub › "Criar token" com os escopos data.records:read e schema.bases:read e acesso às bases de tarefas. Copie e cole aqui.' } },
  { kind: 'github', name: 'GitHub Projects', auth: 'token', group: 'tarefas', tasks: true, site: 'github.com', fields: TOKEN,
    about: 'Projetos do GitHub (Projects): o campo Status vira colunas; issues, pull requests e rascunhos viram tarefas.',
    help: { url: 'https://github.com/settings/tokens', steps: 'No GitHub: Settings › Developer settings › Personal access tokens › token clássico com os escopos read:project e read:org. Copie e cole aqui.' } },
  { kind: 'smartsheet', name: 'Smartsheet', auth: 'token', group: 'tarefas', tasks: true, site: 'smartsheet.com', fields: TOKEN,
    about: 'Planilhas do Smartsheet: uma coluna de lista "Status" vira colunas; a coluna principal é o título.',
    help: { url: 'https://app.smartsheet.com/b/home', steps: 'No Smartsheet: Conta › Apps e integrações › Acesso à API › "Gerar novo token de acesso". Copie e cole aqui.' } },
  { kind: 'linear', name: 'Linear', auth: 'token', group: 'tarefas', tasks: true, site: 'linear.app', fields: TOKEN,
    about: 'Times do Linear: os estados do fluxo viram colunas; issues, tarefas.',
    help: { url: 'https://linear.app/settings/account/security', steps: 'No Linear: Configurações › Segurança e acesso › "Nova chave de API" (só leitura). Copie e cole aqui.' } },
];
export const integrationDef = (k: string) => INTEGRATIONS.find((i) => i.kind === k);
/** tipos que conectam por credencial colada e leem tarefas */
export const TOKEN_KINDS = INTEGRATIONS.filter((d) => d.auth === 'token').map((d) => d.kind);
export const TASK_KINDS = INTEGRATIONS.filter((d) => d.tasks && d.auth !== 'soon').map((d) => d.kind);

// ---------------------------------------------------------------- segredos (arquivo por workspace/integração)
/** Credenciais em disco, cifradas com a chave do workspace quando o Ergon está protegido. */
export class SecretStore {
  private readonly dir: string;
  readonly cipher: () => FieldCipher | null;
  constructor(dataDir: string, cipher: () => FieldCipher | null = () => null) { this.dir = path.join(dataDir, 'secrets'); this.cipher = cipher; }
  private file(workspaceId: string, kind: string) {
    if (!/^ws_[a-f0-9]{32}$/.test(workspaceId) || !/^[a-z]{3,20}$/.test(kind)) throw new Error('chave de segredo inválida');
    return path.join(this.dir, `${workspaceId}-${kind}.json`);
  }
  read<T = Record<string, unknown>>(workspaceId: string, kind: string): T | null {
    let raw: Buffer;
    try { raw = fs.readFileSync(this.file(workspaceId, kind)); } catch { return null; }
    const c = this.cipher();
    if (FieldCipher.isSealedBytes(raw) && !c) return null; // cifrado e o Ergon trancado: não lê
    return JSON.parse((c ? c.openBytes(raw, `${kind}.json`) : raw).toString('utf8')) as T;
  }
  write(workspaceId: string, kind: string, data: unknown): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(workspaceId, kind);
    const plain = Buffer.from(JSON.stringify(data), 'utf8');
    const c = this.cipher();
    fs.writeFileSync(`${f}.tmp`, c ? c.sealBytes(workspaceId, plain, `${kind}.json`) : plain, { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }
  remove(workspaceId: string, kind: string): void { try { fs.rmSync(this.file(workspaceId, kind), { force: true }); } catch { /* já removido */ } }
  /** pasta própria (sessão do WhatsApp, vários arquivos) */
  dirFor(workspaceId: string, kind: string): string {
    const d = this.file(workspaceId, kind).replace(/\.json$/, '');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  removeDir(workspaceId: string, kind: string): void { try { fs.rmSync(this.file(workspaceId, kind).replace(/\.json$/, ''), { recursive: true, force: true }); } catch { /* já removida */ } }
}

// ---------------------------------------------------------------- estado no banco
export interface IntegrationRow { id: string; workspace_id: string; kind: IntegrationKind; state: 'off' | 'pending' | 'connected' | 'error'; account_label: string | null; settings: string; connected_at: string | null; last_sync_at: string | null; last_error: string | null }

export function integrationRow(db: Db, workspaceId: string, kind: IntegrationKind): IntegrationRow {
  let r = db.get<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ?', workspaceId, kind);
  if (!r) {
    db.run("INSERT INTO integrations (id, workspace_id, kind, state, settings, created_at) VALUES (?, ?, ?, 'off', '{}', ?)", id('int'), workspaceId, kind, now());
    r = db.get<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ?', workspaceId, kind)!;
  }
  return r;
}

export function setIntegration(db: Db, workspaceId: string, kind: IntegrationKind, patch: Partial<Pick<IntegrationRow, 'state' | 'account_label' | 'last_error' | 'last_sync_at' | 'connected_at'>> & { settings?: Record<string, unknown> }): void {
  integrationRow(db, workspaceId, kind);
  const sets: string[] = []; const vals: Array<string | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`); vals.push(k === 'settings' ? JSON.stringify(v) : k === 'account_label' ? db.seal(workspaceId, v as string | null) : (v as string | null));
  }
  if (sets.length) db.run(`UPDATE integrations SET ${sets.join(', ')} WHERE workspace_id = ? AND kind = ?`, ...vals, workspaceId, kind);
}

export const settingsOf = (r: IntegrationRow): Record<string, unknown> => { try { return JSON.parse(r.settings) as Record<string, unknown>; } catch { return {}; } };

// ---------------------------------------------------------------- HTTP com token do usuário
const call = (url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> =>
  request(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

const MAX_TASKS = 500;

/** 401 com o acesso ainda válido (sessão revogada, senha trocada): renova uma vez e repete aquela leitura. */
async function renewOn401<T>(token: (force: boolean) => Promise<string>, fn: (t: string) => Promise<T>): Promise<T> {
  try { return await fn(await token(false)); } catch (e) {
    if (!(e instanceof ProviderError && e.status === 401)) throw e;
    return fn(await token(true));
  }
}

// ---------------------------------------------------------------- Todoist (API v1)
export class TodoistProvider implements TaskProvider {
  readonly name = 'todoist'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  private base = 'https://api.todoist.com/api/v1';
  private async all(pathq: string): Promise<any[]> {
    const out: any[] = []; let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const sep = pathq.includes('?') ? '&' : '?';
      const j = await call(`${this.base}${pathq}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`, this.token);
      const items = Array.isArray(j) ? j : (j.results ?? []);
      out.push(...items);
      cursor = Array.isArray(j) ? null : j.next_cursor ?? null;
      if (!cursor || out.length >= MAX_TASKS) break;
    }
    return out;
  }
  async whoami(): Promise<string> {
    try { const j = await call(`${this.base}/user`, this.token); return String(j.full_name ?? j.email ?? 'conta Todoist'); } catch (err) {
      if (err instanceof ProviderError && err.kind === 'forbidden') throw err;
      await this.all('/projects'); // a conta responde: o token vale, só não há perfil nesta rota
      return 'conta Todoist';
    }
  }
  async listBoards() {
    return (await this.all('/projects')).map((p) => ({ externalId: String(p.id), name: String(p.name), version: String(p.updated_at ?? ''), taskCount: -1 }));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const projects = await this.all('/projects');
    const p = projects.find((x) => String(x.id) === externalId);
    if (!p) throw new ProviderError('not_found', 'projeto não encontrado (ou sem acesso)');
    const sections = await this.all(`/sections?project_id=${encodeURIComponent(externalId)}`);
    const tasks = await this.all(`/tasks?project_id=${encodeURIComponent(externalId)}`);
    let people = new Map<string, string>();
    try { people = new Map((await this.all(`/projects/${encodeURIComponent(externalId)}/collaborators`)).map((c) => [String(c.id), String(c.name ?? c.email)])); } catch { /* projeto pessoal */ }
    const NONE = '__sem_secao__';
    const columns = [{ externalId: NONE, name: 'Sem seção', order: -1 }, ...sections.map((s, i) => ({ externalId: String(s.id), name: String(s.name), order: Number(s.section_order ?? i) }))];
    return {
      board: { externalId, name: String(p.name), version: String(p.updated_at ?? '') },
      columns,
      tasks: tasks.slice(0, MAX_TASKS).map((t) => ({
        externalId: String(t.id), columnExternalId: t.section_id ? String(t.section_id) : NONE, title: String(t.content ?? '').slice(0, 200),
        description: String(t.description ?? ''), completed: t.checked === true, version: String(t.updated_at ?? t.added_at ?? ''),
        assignee: t.responsible_uid ? people.get(String(t.responsible_uid)) ?? null : null, due: dueOf(t.due?.date), extra: {},
      })),
      // a lista traz só as tarefas abertas: a ausência de uma tarefa não prova nada (pode ter sido concluída)
      complete: false,
    };
  }
}

// ---------------------------------------------------------------- Asana
export class AsanaProvider implements TaskProvider {
  readonly name = 'asana'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  private base = 'https://app.asana.com/api/1.0';
  async whoami(): Promise<string> { const j = await call(`${this.base}/users/me?opt_fields=name,email`, this.token); return String(j.data?.name ?? j.data?.email ?? 'conta Asana'); }
  async listBoards() {
    const me = await call(`${this.base}/users/me?opt_fields=workspaces.name`, this.token);
    const out: Array<ExternalBoard & { taskCount: number }> = [];
    for (const w of (me.data?.workspaces ?? []).slice(0, 5)) {
      const j = await call(`${this.base}/projects?workspace=${encodeURIComponent(w.gid)}&archived=false&limit=100&opt_fields=name,modified_at`, this.token);
      for (const p of j.data ?? []) out.push({ externalId: String(p.gid), name: (me.data.workspaces.length > 1 ? `${w.name} › ` : '') + String(p.name), version: String(p.modified_at ?? ''), taskCount: -1 });
    }
    return out;
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const p = await call(`${this.base}/projects/${encodeURIComponent(externalId)}?opt_fields=name,modified_at`, this.token);
    const sections = await call(`${this.base}/projects/${encodeURIComponent(externalId)}/sections?opt_fields=name`, this.token);
    const tasks: any[] = []; let offset: string | null = null;
    for (let i = 0; i < 6; i++) {
      const j = await call(`${this.base}/tasks?project=${encodeURIComponent(externalId)}&limit=100&opt_fields=name,notes,completed,due_on,assignee.name,memberships.section.gid,memberships.project.gid,modified_at${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`, this.token);
      tasks.push(...(j.data ?? []));
      offset = j.next_page?.offset ?? null;
      if (!offset || tasks.length >= MAX_TASKS) break;
    }
    const cols = (sections.data ?? []).map((s: any, i: number) => ({ externalId: String(s.gid), name: String(s.name), order: i }));
    return {
      board: { externalId, name: String(p.data?.name ?? 'Projeto'), version: String(p.data?.modified_at ?? '') },
      columns: cols.length ? cols : [{ externalId: '__geral__', name: 'Tarefas', order: 0 }],
      tasks: tasks.slice(0, MAX_TASKS).map((t) => {
        const sec = (t.memberships ?? []).find((m: any) => String(m.project?.gid) === externalId)?.section?.gid;
        return {
          externalId: String(t.gid), columnExternalId: sec ? String(sec) : (cols[0]?.externalId ?? '__geral__'), title: String(t.name ?? '').slice(0, 200),
          description: String(t.notes ?? ''), completed: t.completed === true, version: String(t.modified_at ?? ''),
          assignee: t.assignee?.name ? String(t.assignee.name) : null, due: dueOf(t.due_on), extra: {},
        };
      }),
      complete: !offset,
    };
  }
}

// ---------------------------------------------------------------- Microsoft (Graph) e Google (Tasks), pelo SSO
/** Planner (planos e buckets) e To Do (listas) da conta Microsoft. IDs: "planner:<id>" ou "todo:<id>". */
export class MicrosoftTasksProvider implements TaskProvider {
  readonly name = 'microsoft'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly auth: SsoAuth; private readonly workspaceId: string;
  /** fuso do workspace: o Planner guarda o prazo como instante em UTC (ver dueAt) */
  private readonly tz: string;
  private names = new Map<string, string>();
  constructor(auth: SsoAuth, workspaceId: string, tz: string) { this.auth = auth; this.workspaceId = workspaceId; this.tz = tz; }
  private async g(p: string) { return renewOn401((force) => this.auth.accessToken(this.workspaceId, 'microsoft', { force }), (t) => call(`https://graph.microsoft.com/v1.0${p}`, t)); }
  async listBoards() {
    const out: Array<ExternalBoard & { taskCount: number }> = [];
    try { for (const p of (await this.g('/me/planner/plans')).value ?? []) out.push({ externalId: `planner:${p.id}`, name: `Planner › ${p.title}`, version: String(p['@odata.etag'] ?? ''), taskCount: -1 }); } catch { /* conta pessoal: sem Planner */ }
    for (const l of (await this.g('/me/todo/lists')).value ?? []) out.push({ externalId: `todo:${l.id}`, name: `To Do › ${l.displayName}`, version: '', taskCount: -1 });
    return out;
  }
  private async person(userId: string): Promise<string | null> {
    if (this.names.has(userId)) return this.names.get(userId)!;
    try { const u = await this.g(`/users/${encodeURIComponent(userId)}?$select=displayName`); this.names.set(userId, String(u.displayName)); return String(u.displayName); } catch { return null; }
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const [kind, rawId] = externalId.split(':');
    const xid = encodeURIComponent(rawId ?? '');
    if (kind === 'todo') {
      const list = await this.g(`/me/todo/lists/${xid}`);
      const tasks = ((await this.g(`/me/todo/lists/${xid}/tasks?$top=200`)).value ?? []) as any[];
      return {
        board: { externalId, name: `To Do › ${list.displayName}`, version: '' },
        columns: [{ externalId: 'open', name: 'A fazer', order: 0 }, { externalId: 'done', name: 'Concluídas', order: 1 }],
        tasks: tasks.slice(0, MAX_TASKS).map((t) => ({ externalId: String(t.id), columnExternalId: t.status === 'completed' ? 'done' : 'open', title: String(t.title ?? '').slice(0, 200),
          description: t.body?.contentType === 'text' ? String(t.body.content ?? '') : '', completed: t.status === 'completed', version: String(t.lastModifiedDateTime ?? ''), assignee: null, due: dueOf(t.dueDateTime?.dateTime), extra: {} })),
        complete: tasks.length < 200,
      };
    }
    const plan = await this.g(`/planner/plans/${xid}`);
    const buckets = ((await this.g(`/planner/plans/${xid}/buckets`)).value ?? []) as any[];
    const tasks = ((await this.g(`/planner/plans/${xid}/tasks`)).value ?? []) as any[];
    const out = [];
    for (const t of tasks.slice(0, MAX_TASKS)) {
      const who = Object.keys(t.assignments ?? {})[0];
      out.push({ externalId: String(t.id), columnExternalId: String(t.bucketId ?? buckets[0]?.id ?? ''), title: String(t.title ?? '').slice(0, 200),
        description: '', completed: Number(t.percentComplete) === 100, version: String(t['@odata.etag'] ?? ''), assignee: who ? await this.person(who) : null, due: dueAt(t.dueDateTime, this.tz), extra: {} });
    }
    return {
      board: { externalId, name: `Planner › ${plan.title}`, version: String(plan['@odata.etag'] ?? '') },
      columns: buckets.map((b, i) => ({ externalId: String(b.id), name: String(b.name), order: i })), tasks: out, complete: true,
    };
  }
}

/**
 * Google Tasks: cada lista vira um quadro com duas colunas (A fazer, Concluídas). O Google Tasks não tem
 * responsável (tarefas são pessoais), então "atribuída a" fica vazio. Concluídas também vêm (showCompleted).
 */
export class GoogleTasksProvider implements TaskProvider {
  readonly name = 'google'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: false, writeBack: false } as const;
  private readonly auth: SsoAuth; private readonly workspaceId: string;
  constructor(auth: SsoAuth, workspaceId: string) { this.auth = auth; this.workspaceId = workspaceId; }
  private base = 'https://tasks.googleapis.com/tasks/v1';
  private async g(p: string) { return renewOn401((force) => this.auth.accessToken(this.workspaceId, 'google', { force }), (t) => call(`${this.base}${p}`, t)); }
  async listBoards() {
    const j = await this.g('/users/@me/lists?maxResults=100');
    return ((j.items ?? []) as any[]).map((l) => ({ externalId: String(l.id), name: String(l.title ?? 'Lista'), version: String(l.updated ?? ''), taskCount: -1 }));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const id = encodeURIComponent(externalId);
    const list = await this.g(`/users/@me/lists/${id}`);
    const tasks: any[] = []; let page: string | null = null;
    for (let i = 0; i < 5; i++) {
      const j = await this.g(`/lists/${id}/tasks?maxResults=100&showCompleted=true&showHidden=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      tasks.push(...(j.items ?? []));
      page = j.nextPageToken ?? null;
      if (!page || tasks.length >= MAX_TASKS) break;
    }
    return {
      board: { externalId, name: String(list.title ?? 'Lista'), version: String(list.updated ?? '') },
      columns: [{ externalId: 'open', name: 'A fazer', order: 0 }, { externalId: 'done', name: 'Concluídas', order: 1 }],
      tasks: tasks.filter((t) => !t.deleted && String(t.title ?? '').trim()).slice(0, MAX_TASKS).map((t) => ({
        externalId: String(t.id), columnExternalId: t.status === 'completed' ? 'done' : 'open', title: String(t.title).slice(0, 200),
        description: String(t.notes ?? ''), completed: t.status === 'completed', version: String(t.etag ?? t.updated ?? ''), assignee: null, due: dueOf(t.due), extra: {},
      })),
      complete: !page,
    };
  }
}

/** Provedor de um app conectado por credencial colada. */
export function tokenProvider(kind: IntegrationKind, c: Record<string, string>): AccountProvider {
  switch (kind) {
    case 'todoist': return new TodoistProvider(c.token);
    case 'asana': return new AsanaProvider(c.token);
    case 'trello': return new TrelloProvider(c.key, c.token);
    case 'jira': return new JiraProvider(c.site, c.email, c.token);
    case 'clickup': return new ClickUpProvider(c.token);
    case 'monday': return new MondayProvider(c.token);
    case 'notion': return new NotionProvider(c.token);
    case 'linear': return new LinearProvider(c.token);
    case 'airtable': return new AirtableProvider(c.token);
    case 'smartsheet': return new SmartsheetProvider(c.token);
    case 'pipefy': return new PipefyProvider(c.token);
    case 'github': return new GitHubProjectsProvider(c.token);
    default: throw new HttpError(400, 'no_tasks', 'esta integração não tem tarefas');
  }
}

// ---------------------------------------------------------------- serviço
export class Integrations {
  readonly secrets: SecretStore;
  /** login com a conta (Microsoft, Google), parametrizado */
  readonly sso: SsoAuth;
  private readonly db: Db; private readonly bus: Bus;
  /** estado ao vivo de canais com processo próprio (WhatsApp) */
  liveState: (workspaceId: string, kind: IntegrationKind) => Record<string, unknown> | null = () => null;
  private readonly googleTesting: boolean;
  constructor(db: Db, bus: Bus, cfg: Config) { this.db = db; this.bus = bus; this.secrets = new SecretStore(cfg.dataDir, () => db.fieldCipher); this.sso = new SsoAuth(cfg, this.secrets); this.googleTesting = cfg.googleTesting; }

  list(workspaceId: string) {
    return INTEGRATIONS.map((d) => {
      // "em breve": nada no banco, só o cartão honesto
      const r = d.auth === 'soon' ? null : integrationRow(this.db, workspaceId, d.kind);
      const s = r ? settingsOf(r) : {};
      return {
        kind: d.kind, name: d.name, auth: d.auth, group: d.group, about: d.about, tasks: d.tasks, site: d.site, soon: d.soon ?? null, help: d.help ?? null,
        fields: (d.fields ?? []).map((f) => ({ name: f.name, label: f.label, secret: !!f.secret, placeholder: f.placeholder ?? '' })),
        state: r?.state ?? 'off', account: r?.account_label ?? null, connectedAt: r?.connected_at ?? null, lastSyncAt: r?.last_sync_at ?? null, error: r?.last_error ?? null,
        settings: d.kind === 'whatsapp' ? s : {}, ready: !isSso(d.kind) || this.sso.configured(d.kind),
        setup: isSso(d.kind) ? { needs: SSO[d.kind].needs, doc: SSO[d.kind].doc, place: SSO[d.kind].place } : null,
        live: this.liveState(workspaceId, d.kind),
        // Google com o app em teste: a autorização vale 7 dias (depois, entrar de novo); a tela avisa antes
        renewBy: d.kind === 'google' && this.googleTesting && r?.state === 'connected' && r.connected_at
          ? new Date(Date.parse(r.connected_at) + 7 * 86_400_000).toISOString() : null,
      };
    });
  }

  provider(workspaceId: string, kind: IntegrationKind): TaskProvider {
    const r = integrationRow(this.db, workspaceId, kind);
    if (r.state !== 'connected') throw new HttpError(409, 'not_connected', 'integração não conectada');
    if (kind === 'microsoft') return new MicrosoftTasksProvider(this.sso, workspaceId, workspaceTz(this.db, workspaceId));
    if (kind === 'google') return new GoogleTasksProvider(this.sso, workspaceId);
    const creds = this.secrets.read<Record<string, string>>(workspaceId, kind);
    if (!creds?.token) throw new HttpError(409, 'not_connected', 'credencial ausente: conecte de novo');
    return tokenProvider(kind, creds);
  }

  /** Credencial colada (token e, conforme o app, chave, endereço ou e-mail): confere com uma chamada real antes de chamar de "conectado". */
  async connectToken(workspaceId: string, userId: string, kind: IntegrationKind, input: Record<string, string>): Promise<string> {
    const d = integrationDef(kind);
    if (!d || d.auth !== 'token') throw new HttpError(400, 'kind', 'esta conexão não usa token');
    const creds: Record<string, string> = {};
    for (const f of d.fields ?? TOKEN) {
      const v = String(input[f.name] ?? '').trim();
      if (!v) throw new HttpError(400, 'field', `preencha: ${f.label}`);
      if (v.length > 2000 || (f.secret && (v.length < 16 || /\s/.test(v)))) throw new HttpError(400, 'token', `${f.label}: formato inválido`);
      if (f.pattern && !f.pattern.test(v)) throw new HttpError(400, 'field', `${f.label}: ${f.patternHelp ?? 'formato inválido'}`);
      creds[f.name] = v;
    }
    if (kind === 'jira' && !jiraHost(creds.site)) throw new HttpError(400, 'field', 'Endereço do Jira: use sua-empresa.atlassian.net (só Jira Cloud)');
    const p = tokenProvider(kind, creds);
    let account: string;
    try { account = await p.whoami(); } catch (err) {
      throw new HttpError(400, 'token_rejected', err instanceof ProviderError ? `O ${d.name} recusou: ${err.message}` : 'não consegui conferir a credencial');
    }
    this.secrets.write(workspaceId, kind, creds);
    setIntegration(this.db, workspaceId, kind, { state: 'connected', account_label: account.slice(0, 120), connected_at: now(), last_error: null });
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: kind, evidence: { account }, result: 'conectado (conferido no serviço)' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
    return account;
  }

  disconnect(workspaceId: string, userId: string, kind: IntegrationKind): void {
    this.secrets.remove(workspaceId, kind);
    if (kind === 'whatsapp') this.secrets.removeDir(workspaceId, kind);
    setIntegration(this.db, workspaceId, kind, { state: 'off', account_label: null, last_error: null });
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.disconnect', targetType: 'integration', targetId: kind, result: 'desconectado (credenciais locais apagadas)' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /** Volta do login com a conta: só aqui a integração vira "conectada" (o provedor já entregou o acesso). */
  markSso(kind: SsoKind, workspaceId: string, userId: string, account: string): void {
    setIntegration(this.db, workspaceId, kind, { state: 'connected', account_label: account.slice(0, 120), connected_at: now(), last_error: null });
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: kind, evidence: { account }, result: `conectado (login com a conta)` });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  connectedChannels(workspaceId: string): boolean {
    return !!this.db.get("SELECT 1 AS x FROM integrations WHERE workspace_id = ? AND kind IN ('whatsapp', 'microsoft', 'google') AND state = 'connected'", workspaceId);
  }
}
