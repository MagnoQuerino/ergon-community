// Conectores de apps de tarefas por token: cada um com respostas no formato documentado da API do fornecedor
// (sem rede). Conferem: credencial certa no cabeçalho, conta, quadros, colunas, situação e responsável.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AirtableProvider, ClickUpProvider, GitHubProjectsProvider, JiraProvider, LinearProvider, MondayProvider, NotionProvider, PipefyProvider,
  SmartsheetProvider, TrelloProvider, jiraHost,
} from '../src/services/task-providers.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

type Handler = (url: URL, init: RequestInit, body: any) => unknown;
const routes = new Map<string, Handler>();
const seen: Array<{ url: string; auth: string }> = [];
const realFetch = globalThis.fetch;
function install() {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const h = routes.get(url.host);
    if (!h) return realFetch(input, init);
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? '';
    seen.push({ url: url.toString(), auth });
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const out = h(url, init, body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const status = (n: number) => new Response('{}', { status: n });

before(install);
after(() => { globalThis.fetch = realFetch; });

describe('Trello', () => {
  const KEY = 'a'.repeat(32); const TOK = 'ATTA' + 'b'.repeat(60);
  before(() => routes.set('api.trello.com', (u, i) => {
    const a = (i.headers as Record<string, string>).Authorization;
    if (a !== `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOK}"`) return status(401);
    if (u.pathname === '/1/members/me') return { fullName: 'Ana Lima', username: 'alima' };
    if (u.pathname === '/1/members/me/boards') return [{ id: 'b0000001', name: 'Produto', dateLastActivity: '2026-10-20' }];
    if (u.pathname === '/1/boards/b0000001') return { name: 'Produto', dateLastActivity: '2026-10-20' };
    if (u.pathname === '/1/boards/b0000001/lists') return [{ id: 'l2', name: 'Feito', pos: 2 }, { id: 'l1', name: 'A fazer', pos: 1 }];
    if (u.pathname === '/1/boards/b0000001/cards') return [
      { id: 'c1', name: 'Revisar contrato', desc: 'cláusula 4', idList: 'l1', dueComplete: false, dateLastActivity: 'v1', members: [{ fullName: 'Maria' }] },
      { id: 'c2', name: 'Enviar proposta', desc: '', idList: 'l2', dueComplete: false, dateLastActivity: 'v1', members: [] },
    ];
    return status(404);
  }));
  test('chave e token no cabeçalho (nunca na URL); listas em ordem; lista "Feito" conta como concluída', async () => {
    const p = new TrelloProvider(KEY, TOK);
    assert.equal(await p.whoami(), 'Ana Lima');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Produto']);
    const s = await p.getBoard('b0000001');
    assert.deepEqual(s.columns.map((c) => c.name), ['A fazer', 'Feito']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee]), [['Revisar contrato', false, 'Maria'], ['Enviar proposta', true, null]]);
    assert.ok(seen.filter((x) => x.url.includes('trello')).every((x) => !x.url.includes(TOK)), 'token fora da URL');
    await assert.rejects(new TrelloProvider(KEY, 'errado'.repeat(5)).whoami(), /recusado/);
  });
});

describe('Jira Cloud', () => {
  before(() => routes.set('empresa.atlassian.net', (u, i, body) => {
    if ((i.headers as Record<string, string>).Authorization !== `Basic ${Buffer.from('eu@empresa.com:tok-jira-0123456789').toString('base64')}`) return status(401);
    if (u.pathname === '/rest/api/3/myself') return { displayName: 'Alexandre' };
    if (u.pathname === '/rest/api/3/project/search') return { values: [{ id: '1', key: 'OPS', name: 'Operações' }], isLast: true };
    if (u.pathname === '/rest/api/3/project/OPS') return { name: 'Operações' };
    if (u.pathname === '/rest/api/3/project/OPS/statuses') return [{ statuses: [
      { id: '3', name: 'Concluído', statusCategory: { key: 'done' } }, { id: '1', name: 'A fazer', statusCategory: { key: 'new' } }, { id: '2', name: 'Em andamento', statusCategory: { key: 'indeterminate' } }] }];
    if (u.pathname === '/rest/api/3/search/jql') {
      assert.equal(body.jql, 'project = "OPS" ORDER BY updated DESC');
      return { issues: [
        { key: 'OPS-1', fields: { summary: 'Trocar servidor', status: { id: '2', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Paulo' }, updated: 'v', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'antes de sexta' }] }] } } },
        { key: 'OPS-2', fields: { summary: 'Backup', status: { id: '3', statusCategory: { key: 'done' } }, assignee: null, updated: 'v', description: null } },
      ], isLast: true };
    }
    return status(404);
  }));
  test('site aceito só no Jira Cloud; situações em ordem de categoria; descrição ADF vira texto', async () => {
    assert.equal(jiraHost('empresa'), 'empresa.atlassian.net');
    assert.equal(jiraHost('https://empresa.atlassian.net/jira/'), 'empresa.atlassian.net');
    assert.equal(jiraHost('intranet.local'), null, 'nenhum outro endereço (o servidor não chama qualquer host)');
    const p = new JiraProvider('empresa.atlassian.net', 'eu@empresa.com', 'tok-jira-0123456789');
    assert.equal(await p.whoami(), 'Alexandre');
    assert.deepEqual((await p.listBoards()).map((b) => [b.externalId, b.name]), [['OPS', 'Operações (OPS)']]);
    const s = await p.getBoard('OPS');
    assert.deepEqual(s.columns.map((c) => c.name), ['A fazer', 'Em andamento', 'Concluído']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee, t.description]), [['OPS-1 · Trocar servidor', false, 'Paulo', 'antes de sexta'], ['OPS-2 · Backup', true, null, '']]);
    await assert.rejects(p.getBoard('OPS" OR project != "X'), /inválido/, 'nada de JQL injetado');
  });
});

describe('ClickUp', () => {
  before(() => routes.set('api.clickup.com', (u, i) => {
    if ((i.headers as Record<string, string>).Authorization !== 'pk_123_ABCDEFGHIJKLMNOP') return status(401);
    const p = u.pathname.replace('/api/v2', '');
    if (p === '/user') return { user: { username: 'alima' } };
    if (p === '/team') return { teams: [{ id: 't1' }] };
    if (p === '/team/t1/space') return { spaces: [{ id: 's1', name: 'Empresa' }] };
    if (p === '/space/s1/folder') return { folders: [{ name: 'Clientes', lists: [{ id: 'L1', name: 'Pedidos' }] }] };
    if (p === '/space/s1/list') return { lists: [] };
    if (p === '/list/L1') return { name: 'Pedidos', statuses: [{ status: 'complete', type: 'closed', orderindex: 2 }, { status: 'to do', type: 'open', orderindex: 0 }] };
    if (p === '/list/L1/task') return { tasks: [{ id: 'x1', name: 'Orçamento', text_content: 'ver frete', status: { status: 'complete', type: 'closed' }, assignees: [{ username: 'ana' }], date_updated: '1' }], last_page: true };
    return status(404);
  }));
  test('caminho espaço › pasta › lista; situação "closed" = concluída', async () => {
    const p = new ClickUpProvider('pk_123_ABCDEFGHIJKLMNOP');
    assert.equal(await p.whoami(), 'alima');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Empresa › Clientes › Pedidos']);
    const s = await p.getBoard('L1');
    assert.deepEqual(s.columns.map((c) => c.name), ['to do', 'complete']);
    assert.deepEqual(s.tasks.map((t) => [t.columnExternalId, t.completed, t.assignee]), [['complete', true, 'ana']]);
    assert.equal(s.complete, true);
  });
});

describe('monday.com', () => {
  before(() => routes.set('api.monday.com', (_u, i, body) => {
    if ((i.headers as Record<string, string>).Authorization !== 'eyJmonday-token-123456') return { errors: [{ message: 'Not Authenticated' }] };
    const q = String(body.query);
    if (q.includes('me {')) return { data: { me: { name: 'Alexandre' } } };
    if (q.includes('boards(limit')) return { data: { boards: [{ id: '42', name: 'Comercial', type: 'board' }, { id: '43', name: 'Subitens', type: 'sub_items_board' }] } };
    if (q.includes('items_page') && !q.includes('next_items_page')) return { data: { boards: [{ id: '42', name: 'Comercial', groups: [{ id: 'g2', title: 'Fechado', position: '2' }, { id: 'g1', title: 'Em negociação', position: '1' }],
      items_page: { cursor: 'c1', items: [{ id: '1', name: 'Cliente A', updated_at: 'v', group: { id: 'g1' }, column_values: [{ id: 's', type: 'status', text: 'Working on it' }, { id: 'p', type: 'people', text: 'Bia, Caio' }] }] } }] } };
    if (q.includes('next_items_page')) return { data: { next_items_page: { cursor: null, items: [{ id: '2', name: 'Cliente B', updated_at: 'v', group: { id: 'g2' }, column_values: [{ id: 's', type: 'status', text: 'Done' }] }] } } };
    return { errors: [{ message: 'consulta desconhecida' }] };
  }));
  test('token sem "Bearer"; grupos em ordem; páginas seguintes; status "Done" = concluída', async () => {
    const p = new MondayProvider('eyJmonday-token-123456');
    assert.equal(await p.whoami(), 'Alexandre');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Comercial'], 'quadro de subitens fica de fora');
    const s = await p.getBoard('42');
    assert.deepEqual(s.columns.map((c) => c.name), ['Em negociação', 'Fechado']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee]), [['Cliente A', false, 'Bia'], ['Cliente B', true, null]]);
    await assert.rejects(new MondayProvider('outro-token-0123456789').whoami(), (e: Error & { kind?: string }) => e.kind === 'forbidden');
  });
});

describe('Notion (fontes de dados, versão 2025-09-03)', () => {
  const DS = '0123456789abcdef0123456789abcdef';
  before(() => routes.set('api.notion.com', (u, i, body) => {
    const h = i.headers as Record<string, string>;
    if (h.Authorization !== 'Bearer ntn_segredo_0123456789' || h['Notion-Version'] !== '2025-09-03') return status(401);
    if (u.pathname === '/v1/users/me') return { name: 'Ergon', bot: { workspace_name: 'Casa' } };
    if (u.pathname === '/v1/search') { assert.equal(body.filter.value, 'data_source'); return { results: [{ id: DS, title: [{ plain_text: 'Tarefas' }] }], has_more: false }; }
    if (u.pathname === `/v1/data_sources/${DS}`) return { title: [{ plain_text: 'Tarefas' }], properties: {
      Nome: { type: 'title' }, Responsável: { type: 'people' },
      Status: { type: 'status', status: { options: [{ id: 'o1', name: 'Não iniciado' }, { id: 'o2', name: 'Em andamento' }, { id: 'o3', name: 'Pronto' }], groups: [{ name: 'Complete', option_ids: ['o3'] }] } } } };
    if (u.pathname === `/v1/data_sources/${DS}/query`) return { results: [
      { object: 'page', id: 'p1', last_edited_time: 'v', properties: { Nome: { title: [{ plain_text: 'Pagar luz' }] }, Status: { status: { id: 'o3', name: 'Pronto' } }, Responsável: { people: [{ name: 'Alexandre' }] } } },
      { object: 'page', id: 'p2', last_edited_time: 'v', properties: { Nome: { title: [{ plain_text: 'Marcar dentista' }] }, Status: { status: null }, Responsável: { people: [] } } },
    ], has_more: false, next_cursor: null };
    return status(404);
  }));
  test('opções do status viram colunas; grupo "Complete" marca concluída', async () => {
    const p = new NotionProvider('ntn_segredo_0123456789');
    assert.equal(await p.whoami(), 'Casa');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Tarefas']);
    const s = await p.getBoard(DS);
    assert.deepEqual(s.columns.map((c) => c.name), ['Sem status', 'Não iniciado', 'Em andamento', 'Pronto']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.columnExternalId, t.completed, t.assignee]), [['Pagar luz', 'o3', true, 'Alexandre'], ['Marcar dentista', '__sem_status__', false, null]]);
  });
});

describe('Linear', () => {
  const TEAM = '11111111-2222-3333-4444-555555555555';
  before(() => routes.set('api.linear.app', (_u, i, body) => {
    if ((i.headers as Record<string, string>).Authorization !== 'lin_api_0123456789abcdef') return status(401);
    const q = String(body.query);
    if (q.includes('viewer')) return { data: { viewer: { name: 'Alexandre' } } };
    if (q.includes('teams(')) return { data: { teams: { nodes: [{ id: TEAM, name: 'Produto', key: 'PRD' }] } } };
    return { data: { team: { name: 'Produto', states: { nodes: [{ id: 's2', name: 'Done', type: 'completed', position: 3 }, { id: 's1', name: 'Todo', type: 'unstarted', position: 1 }] },
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'i1', identifier: 'PRD-7', title: 'Login', description: 'passkeys', updatedAt: 'v', state: { id: 's2', type: 'completed' }, assignee: { name: 'Leo' } }] } } } };
  }));
  test('chave sem "Bearer"; estados em ordem; "completed" = concluída', async () => {
    const p = new LinearProvider('lin_api_0123456789abcdef');
    assert.equal(await p.whoami(), 'Alexandre');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Produto (PRD)']);
    const s = await p.getBoard(TEAM);
    assert.deepEqual(s.columns.map((c) => c.name), ['Todo', 'Done']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee]), [['PRD-7 · Login', true, 'Leo']]);
  });
});

describe('Airtable, Smartsheet, Pipefy e GitHub Projects', () => {
  before(() => {
    routes.set('api.airtable.com', (u, i) => {
      if ((i.headers as Record<string, string>).Authorization !== 'Bearer patAIRTABLE0123456789') return status(401);
      if (u.pathname === '/v0/meta/whoami') return { id: 'usr1', email: 'eu@casa.com' };
      if (u.pathname === '/v0/meta/bases') return { bases: [{ id: 'appBASE00000001', name: 'Casa' }] };
      if (u.pathname === '/v0/meta/bases/appBASE00000001/tables') return { tables: [{ id: 'tblTAREFAS000001', name: 'Tarefas', primaryFieldId: 'fldNome',
        fields: [{ id: 'fldNome', name: 'Nome', type: 'singleLineText' }, { id: 'fldSt', name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'A fazer' }, { name: 'Feito' }] } }, { id: 'fldW', name: 'Responsável', type: 'singleCollaborator' }] }] };
      if (u.pathname === '/v0/appBASE00000001/tblTAREFAS000001') return { records: [{ id: 'rec1', fields: { fldNome: 'Comprar pão', fldSt: 'Feito', fldW: { name: 'Rita' } } }] };
      return status(404);
    });
    routes.set('api.smartsheet.com', (u, i) => {
      if ((i.headers as Record<string, string>).Authorization !== 'Bearer smartsheet-0123456789') return status(401);
      if (u.pathname === '/2.0/users/me') return { firstName: 'Ana', lastName: 'Lima' };
      if (u.pathname === '/2.0/sheets') return { data: [{ id: 77, name: 'Obras' }] };
      if (u.pathname === '/2.0/sheets/77') return { name: 'Obras', columns: [{ id: 1, title: 'Tarefa', primary: true, type: 'TEXT_NUMBER' }, { id: 2, title: 'Status', type: 'PICKLIST', options: ['Aberto', 'Concluído'] }, { id: 3, title: 'Atribuído a', type: 'CONTACT_LIST' }],
        rows: [{ id: 9, modifiedAt: 'v', cells: [{ columnId: 1, value: 'Pintura', displayValue: 'Pintura' }, { columnId: 2, value: 'Concluído' }, { columnId: 3, value: 'x@y', displayValue: 'Jorge' }] }, { id: 10, cells: [{ columnId: 1 }] }] };
      return status(404);
    });
    routes.set('api.pipefy.com', (_u, i, body) => {
      if ((i.headers as Record<string, string>).Authorization !== 'Bearer pipefy-jwt-0123456789') return status(401);
      const q = String(body.query);
      if (q.includes('me {')) return { data: { me: { name: 'Alexandre' } } };
      if (q.includes('organizations')) return { data: { organizations: [{ id: '1', name: 'Vértice', pipes: [{ id: '300', name: 'Compras' }] }] } };
      if (q.includes('phases')) return { data: { pipe: { name: 'Compras', phases: [{ id: 'f1', name: 'Caixa de entrada', done: false }, { id: 'f9', name: 'Concluído', done: true }] } } };
      return { data: { cards: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { id: 'k1', title: 'Notebook', done: false, updated_at: 'v', current_phase: { id: 'f9' }, assignees: [{ name: 'Lia' }] } }] } } };
    });
    routes.set('api.github.com', (_u, i, body) => {
      const h = i.headers as Record<string, string>;
      if (h.Authorization !== 'Bearer ghp_0123456789abcdef' || !h['User-Agent']) return status(401);
      const q = String(body.query);
      if (q.includes('viewer { login name }')) return { data: { viewer: { login: 'alima', name: null } } };
      if (q.includes('organizations')) return { data: { viewer: { login: 'alima', projectsV2: { nodes: [{ id: 'PVT_aaaa1', title: 'Roadmap', closed: false }, { id: 'PVT_old01', title: 'Antigo', closed: true }] }, organizations: { nodes: [] } } } };
      return { data: { node: { title: 'Roadmap', field: { options: [{ id: 'op1', name: 'Todo' }, { id: 'op2', name: 'Done' }] },
        items: { pageInfo: { hasNextPage: false }, nodes: [
          { id: 'it1', isArchived: false, fieldValueByName: { optionId: 'op1', name: 'Todo' }, content: { __typename: 'Issue', title: 'Bug no login', body: 'x', state: 'CLOSED', assignees: { nodes: [{ login: 'leo' }] } } },
          { id: 'it2', isArchived: false, fieldValueByName: null, content: { __typename: 'DraftIssue', title: 'Ideia', body: '', assignees: { nodes: [] } } },
          { id: 'it3', isArchived: true, content: { title: 'arquivado' } }] } } } };
    });
  });
  test('Airtable: tabela com status de seleção; coluna principal é o título', async () => {
    const p = new AirtableProvider('patAIRTABLE0123456789');
    assert.equal(await p.whoami(), 'eu@casa.com');
    assert.deepEqual((await p.listBoards()).map((b) => [b.externalId, b.name]), [['appBASE00000001/tblTAREFAS000001', 'Casa › Tarefas']]);
    const s = await p.getBoard('appBASE00000001/tblTAREFAS000001');
    assert.deepEqual(s.columns.map((c) => c.name), ['Sem status', 'A fazer', 'Feito']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee]), [['Comprar pão', true, 'Rita']]);
  });
  test('Smartsheet: linhas vazias ficam de fora; lista "Status" vira colunas', async () => {
    const p = new SmartsheetProvider('smartsheet-0123456789');
    assert.equal(await p.whoami(), 'Ana Lima');
    const s = await p.getBoard('77');
    assert.deepEqual(s.columns.map((c) => c.name), ['Sem status', 'Aberto', 'Concluído']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.completed, t.assignee]), [['Pintura', true, 'Jorge']]);
  });
  test('Pipefy: fase "done" marca o card como concluído', async () => {
    const p = new PipefyProvider('pipefy-jwt-0123456789');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['Compras']);
    const s = await p.getBoard('300');
    assert.deepEqual(s.tasks.map((t) => [t.title, t.columnExternalId, t.completed, t.assignee]), [['Notebook', 'f9', true, 'Lia']]);
  });
  test('GitHub Projects: projetos fechados e itens arquivados ficam de fora; issue fechada = concluída', async () => {
    const p = new GitHubProjectsProvider('ghp_0123456789abcdef');
    assert.equal(await p.whoami(), 'alima');
    assert.deepEqual((await p.listBoards()).map((b) => b.name), ['alima › Roadmap']);
    const s = await p.getBoard('PVT_aaaa1');
    assert.deepEqual(s.columns.map((c) => c.name), ['Sem status', 'Todo', 'Done']);
    assert.deepEqual(s.tasks.map((t) => [t.title, t.columnExternalId, t.completed, t.assignee]), [['Bug no login', 'op1', true, 'leo'], ['Ideia', '__sem_status__', false, null]]);
  });
});

describe('Conexões: catálogo, credenciais com vários campos e "em breve" honesto', () => {
  let h: Harness; let s: Session;
  const KEY = 'a'.repeat(32); const TOK = 'ATTA' + 'b'.repeat(60);
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('catálogo lista os apps com grupo e campos; "em breve" não conecta', async () => {
    const list = (await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; auth: string; group: string; fields: Array<{ name: string }> }>;
    const kinds = list.map((i) => i.kind);
    for (const k of ['trello', 'jira', 'asana', 'monday', 'clickup', 'notion', 'todoist', 'airtable', 'smartsheet', 'linear', 'github', 'pipefy']) assert.ok(kinds.includes(k), k);
    assert.deepEqual(list.find((i) => i.kind === 'jira')!.fields.map((f) => f.name), ['site', 'email', 'token']);
    assert.equal(list.find((i) => i.kind === 'bitrix')!.auth, 'soon');
    for (const gone of ['ticktick', 'wrike', 'basecamp', 'zoho', 'runrunit']) assert.ok(!kinds.includes(gone), gone);
    assert.equal((await req(h, 'POST', '/api/integrations/bitrix/token', s, { token: 'x'.repeat(20) })).status, 400);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM integrations WHERE kind = 'bitrix'")!.n, 0, '"em breve" não vai para o banco');
  });

  test('Trello: campo com formato errado é recusado antes de chamar; certo conecta e espelha; credencial fica fora do banco', async () => {
    const bad = await req(h, 'POST', '/api/integrations/trello/token', s, { credentials: { key: 'curta', token: TOK } });
    assert.equal(bad.status, 400); assert.match(bad.json.message, /32/);
    const ok = await req(h, 'POST', '/api/integrations/trello/token', s, { credentials: { key: KEY, token: TOK } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.account, 'Ana Lima');
    const dump = h.db.all('SELECT * FROM integrations').map((r) => JSON.stringify(r)).join('') + h.db.all('SELECT * FROM audit_events').map((r) => JSON.stringify(r)).join('');
    assert.ok(!dump.includes(TOK) && !dump.includes(KEY), 'nem no banco nem no log');
    const m = await req(h, 'POST', '/api/boards/mirror', s, { kind: 'trello', listId: 'b0000001' });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const view = (await req(h, 'GET', `/api/boards/${m.json.boardId}`, s)).json;
    assert.deepEqual(view.columns.map((c: { name: string }) => c.name), ['A fazer', 'Feito']);
  });

  test('Jira: endereço fora do Jira Cloud é recusado sem chamar ninguém', async () => {
    const before = seen.length;
    const r = await req(h, 'POST', '/api/integrations/jira/token', s, { credentials: { site: 'http://192.168.0.10', email: 'eu@empresa.com', token: 'tok-jira-0123456789' } });
    assert.equal(r.status, 400); assert.match(r.json.message, /atlassian\.net/);
    assert.equal(seen.length, before);
  });
});
