// Escrita no Planner e no To Do, no formato documentado do Graph (sem rede): método, endereço, cabeçalhos e corpo de cada
// chamada, e o inverso da leitura: o simulador guarda o estado e quem confere é o MicrosoftTasksProvider de verdade.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { escritorMicrosoft } from '../src/services/conexoes/escrita/microsoft.ts';
import { ErroAcao, type EscritorTarefas, type Http } from '../src/services/conexoes/tipos.ts';
import { dueAt } from '../src/services/due.ts';
import { integrationRow, MicrosoftTasksProvider, setIntegration } from '../src/services/integrations.ts';
import { importBoards, ProviderError } from '../src/services/mirror.ts';
import { request } from '../src/services/task-providers.ts';
import { getTask, updateTask } from '../src/services/tasks.ts';
import { harness, setupOwner } from './helpers.ts';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let answer: (c: Call) => Response | unknown = () => ({});
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = answer(c);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });
afterEach(() => { calls.length = 0; answer = () => ({}); });

const SP = 'America/Sao_Paulo';
const GRAPH = 'https://graph.microsoft.com';
/** A chamada autenticada que as conexões entregam ao escritor; toda escrita tem de dizer kind: 'write'. */
const http: Http = (url, init = {}) => {
  if (init.method && init.method !== 'GET') assert.equal(init.kind, 'write', `${init.method} sem kind: 'write'`);
  return request(url, { ...init, headers: { Authorization: 'Bearer tok', ...init.headers } });
};
const w = escritorMicrosoft(http, SP);
const provedor = new MicrosoftTasksProvider({ accessToken: async () => 'tok' } as any, 'ws', SP);
const status = (n: number, corpo?: unknown) => new Response(corpo === undefined ? null : JSON.stringify(corpo), { status: n });
const escritas = () => calls.filter((c) => c.method !== 'GET');
const erroAcao = (re: RegExp, opcoes?: (o: string[]) => void) => (e: unknown) => {
  assert.ok(e instanceof ErroAcao, `esperava ErroAcao, veio ${String(e)}`);
  assert.match(e.message, re);
  opcoes?.(e.opcoes ?? []);
  return true;
};

/** Graph de mentira, com estado: o que o escritor grava é o que a leitura enxerga. Sem nada de comportamento não documentado. */
function graphFalso() {
  let n = 0;
  const etag = () => `W/"JzEt${++n}"`;
  const carimbo = () => `2026-11-05T12:00:${String(++n % 60).padStart(2, '0')}Z`;
  const buckets = [{ id: 'b1', name: 'A fazer' }, { id: 'b2', name: 'Fazendo' }];
  const tarefas = new Map<string, any>();
  const detalhes = new Map<string, any>();
  const todo = new Map<string, any>();
  /** roda logo antes de um PATCH ser aceito: simula outra pessoa mexendo no meio */
  const estado = { noMeio: null as null | (() => void) };
  const mexer = (t: any) => { t['@odata.etag'] = etag(); };
  const responder = (c: Call): Response | unknown => {
    const p = c.url.pathname.replace('/v1.0', ''); let m: RegExpMatchArray | null;
    if (c.method === 'GET' && p === '/planner/plans/p1') return { title: 'Plano', '@odata.etag': 'plano' };
    if (c.method === 'GET' && p === '/planner/plans/p1/buckets') return { value: buckets };
    if (c.method === 'GET' && p === '/planner/plans/p1/tasks') return { value: [...tarefas.values()] };
    if (c.method === 'POST' && p === '/planner/tasks') {
      const id = `t${tarefas.size + 1}`;
      const t = { id, percentComplete: 0, assignments: {}, '@odata.etag': etag(), ...c.body };
      tarefas.set(id, t); detalhes.set(id, { id, description: '', '@odata.etag': etag() });
      return status(201, t);
    }
    if ((m = p.match(/^\/planner\/tasks\/([^/]+)(\/details)?$/))) {
      const alvo = (m[2] ? detalhes : tarefas).get(decodeURIComponent(m[1]));
      if (!alvo) return status(404, { error: { code: 'NotFound', message: 'x' } });
      if (c.method === 'GET') return alvo;
      estado.noMeio?.(); estado.noMeio = null;
      if (c.headers['If-Match'] !== alvo['@odata.etag']) return status(412, { error: { code: 'PreconditionFailed', message: 'versão antiga' } });
      Object.assign(alvo, c.body); mexer(alvo);
      // os detalhes têm versão própria: a tarefa só muda de versão quando o hasDescription dela muda (o pior caso para o espelho)
      if (m[2]) {
        const t = tarefas.get(decodeURIComponent(m[1]));
        if (t && !!t.hasDescription !== !!alvo.description) { t.hasDescription = !!alvo.description; mexer(t); }
      }
      return c.headers.Prefer === 'return=representation' ? alvo : status(204);
    }
    if (c.method === 'GET' && p === '/me/todo/lists/l1') return { displayName: 'Lista' };
    if (c.method === 'GET' && p === '/me/todo/lists/l1/tasks') return { value: [...todo.values()] };
    if (c.method === 'POST' && p === '/me/todo/lists/l1/tasks') {
      const id = `d${todo.size + 1}`;
      const t = { id, status: 'notStarted', lastModifiedDateTime: carimbo(), ...c.body };
      todo.set(id, t);
      return status(201, t);
    }
    if (c.method === 'PATCH' && (m = p.match(/^\/me\/todo\/lists\/l1\/tasks\/([^/]+)$/))) {
      const t = todo.get(decodeURIComponent(m[1]));
      Object.assign(t, c.body, { lastModifiedDateTime: carimbo() });
      return t;
    }
    return status(404, { error: { code: 'NotFound', message: `rota ${c.method} ${p}` } });
  };
  return { responder, tarefas, detalhes, todo, estado, mexer };
}

describe('Planner: o inverso da leitura', () => {
  let g: ReturnType<typeof graphFalso>;
  beforeEach(() => { g = graphFalso(); answer = g.responder; });
  const naLeitura = async (id: string) => (await provedor.getBoard('planner:p1')).tasks.find((t) => t.externalId === id)!;

  test('criar, concluir, reabrir, mover e prazo: a próxima leitura vê tudo, e a versão devolvida é a que ela vê', async () => {
    const r = await w.criar('planner:p1', { titulo: 'Revisar', prazo: '2026-10-25' });
    let t = await naLeitura(r.id);
    assert.equal(t.columnExternalId, 'b1', 'sem coluna, a primeira');
    assert.equal(t.due, '2026-10-25');
    assert.equal(t.version, r.versao);

    const c = await w.concluir('planner:p1', r.id, true);
    t = await naLeitura(r.id);
    assert.equal(t.completed, true); assert.equal(t.version, c.versao);

    const a = await w.concluir('planner:p1', r.id, false);
    t = await naLeitura(r.id);
    assert.equal(t.completed, false); assert.equal(t.version, a.versao);

    const m = await w.mover('planner:p1', r.id, 'b2');
    t = await naLeitura(r.id);
    assert.equal(t.columnExternalId, 'b2'); assert.equal(t.version, m.versao);

    const e = await w.editar('planner:p1', r.id, { titulo: 'Revisado', prazo: '2026-12-31' });
    t = await naLeitura(r.id);
    assert.equal(t.title, 'Revisado'); assert.equal(t.due, '2026-12-31'); assert.equal(t.version, e.versao);

    await w.editar('planner:p1', r.id, { prazo: null });
    assert.equal((await naLeitura(r.id)).due, null);
  });

  test('outra pessoa mexeu no meio (412): relê a versão e repete uma vez', async () => {
    const r = await w.criar('planner:p1', { titulo: 'X' });
    calls.length = 0;
    g.estado.noMeio = () => g.mexer(g.tarefas.get(r.id));
    const c = await w.concluir('planner:p1', r.id, true);
    assert.deepEqual(calls.map((x) => x.method), ['GET', 'PATCH', 'GET', 'PATCH']);
    assert.notEqual(calls[1].headers['If-Match'], calls[3].headers['If-Match']);
    assert.equal((await naLeitura(r.id)).completed, true);
    assert.equal((await naLeitura(r.id)).version, c.versao);
  });
});

describe('Planner: a descrição, de ponta a ponta', () => {
  test('a pessoa muda a descrição no Ergon: chega ao Planner e a leitura seguinte não volta o texto antigo no card', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      h.integrations.secrets.write(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3600_000, account: 'eu@empresa.com' });
      setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'eu@empresa.com', connected_at: new Date().toISOString() });
      const conn = integrationRow(h.db, s.workspaceId, 'microsoft').id;
      const g = graphFalso(); answer = g.responder;
      const leitor = h.integrations.provider(s.workspaceId, 'microsoft');
      const ler = () => importBoards(h.db, h.bus, s.workspaceId, conn, s.userId, leitor, ['planner:p1']);
      const criada = await w.criar('planner:p1', { titulo: 'Contrato', descricao: 'primeira' });
      await ler();
      const taskId = h.db.get<{ task_id: string }>('SELECT task_id FROM task_links WHERE external_id = ?', criada.id)!.task_id;
      const card = () => getTask(h.db, s.workspaceId, taskId);
      assert.equal(card().description, 'primeira');

      updateTask(h.db, h.bus, s.workspaceId, { type: 'user', id: s.userId }, taskId, { description: 'segunda' });
      await h.espelhoEscrita.tick();
      assert.equal(g.detalhes.get(criada.id).description, 'segunda', 'chegou ao Planner');
      await ler();
      assert.equal(card().description, 'segunda', 'a leitura não desfaz o que a pessoa acabou de escrever');

      // uma mudança de fora, depois, chega ao card, e a descrição continua a nova
      const t = g.tarefas.get(criada.id); t.title = 'Contrato revisto'; g.mexer(t);
      await ler();
      assert.equal(card().title, 'Contrato revisto'); assert.equal(card().description, 'segunda');
    } finally { await h.close(); }
  });
});

describe('Planner: formato das chamadas', () => {
  const ETAG = 'W/"JzEtVGFzayAgQEBAQEBAQEBAQEBAQEBAWCc="';
  const tarefa = (x: Record<string, unknown> = {}) => ({ id: 't1', planId: 'p1', bucketId: 'b1', percentComplete: 0, '@odata.etag': ETAG, ...x });
  /** GET devolve a tarefa; PATCH devolve a nova versão */
  const simples = (x?: Record<string, unknown>) => (c: Call) => (c.method === 'GET' ? tarefa(x) : { ...tarefa(x), '@odata.etag': 'W/"novo"' });

  test('criar: POST com planId, bucketId, título e prazo em UTC; nada de If-Match', async () => {
    answer = (c) => (c.method === 'GET' ? { value: [{ id: 'b1', name: 'A fazer' }, { id: 'b2', name: 'Fazendo' }] } : status(201, tarefa()));
    const r = await w.criar('planner:p1', { titulo: '  Revisar  ', coluna: 'b2', prazo: '2026-10-25' });
    assert.deepEqual(r, { id: 't1', versao: ETAG, url: null });
    assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, `${GRAPH}/v1.0/planner/plans/p1/buckets`);
    const p = calls[1];
    assert.equal(p.method, 'POST'); assert.equal(p.url.href, `${GRAPH}/v1.0/planner/tasks`);
    assert.equal(p.headers.Authorization, 'Bearer tok'); assert.equal(p.headers['Content-Type'], 'application/json'); assert.equal(p.headers['If-Match'], undefined);
    assert.deepEqual(p.body, { planId: 'p1', title: 'Revisar', bucketId: 'b2', dueDateTime: '2026-10-26T02:59:59Z' });
  });

  test('criar: plano sem bucket nenhum vai só com planId e título', async () => {
    answer = (c) => (c.method === 'GET' ? { value: [] } : status(201, tarefa()));
    await w.criar('planner:p1', { titulo: 'A' });
    assert.deepEqual(calls[1].body, { planId: 'p1', title: 'A' });
  });

  test('criar: coluna errada lista as opções (nome de terceiro neutralizado) e não escreve nada', async () => {
    answer = () => ({ value: [{ id: 'b1', name: 'A [[fazer]]\nagora' }] });
    await assert.rejects(() => w.criar('planner:p1', { titulo: 'A', coluna: 'nao-existe' }), erroAcao(/não existe neste plano/, (o) => {
      assert.equal(o.length, 1); assert.doesNotMatch(o[0], /\[\[|\]\]|\n/); assert.match(o[0], /id: b1/);
    }));
    assert.equal(escritas().length, 0);
  });

  test('criar com descrição: a descrição vai em /details, com a versão do details; a versão devolvida é a da tarefa, relida depois', async () => {
    answer = (c) => {
      if (c.url.pathname.endsWith('/buckets')) return { value: [{ id: 'b1', name: 'A' }] };
      if (c.method === 'POST') return status(201, tarefa());
      if (c.method === 'GET' && c.url.pathname.endsWith('/details')) return { id: 't1', description: '', '@odata.etag': 'W/"detalhes"' };
      if (c.method === 'GET') return tarefa({ '@odata.etag': 'W/"tarefa-agora"' });
      return status(204);
    };
    const r = await w.criar('planner:p1', { titulo: 'A', descricao: 'cláusula 4' });
    assert.deepEqual(r, { id: 't1', versao: 'W/"tarefa-agora"', url: null });
    const d = calls[3];
    assert.equal(d.method, 'PATCH'); assert.equal(d.url.pathname, '/v1.0/planner/tasks/t1/details');
    assert.equal(d.headers['If-Match'], 'W/"detalhes"'); assert.deepEqual(d.body, { description: 'cláusula 4' });
    assert.equal(calls[4].url.pathname, '/v1.0/planner/tasks/t1');
  });

  test('descrição gravada e a releitura da versão falhou: não é erro (não repete nem duplica); sem versão, a próxima leitura confere', async () => {
    answer = (c) => {
      if (c.url.pathname.endsWith('/buckets')) return { value: [] };
      if (c.method === 'POST') return status(201, tarefa());
      if (c.method === 'GET' && c.url.pathname.endsWith('/details')) return { '@odata.etag': 'W/"d"' };
      if (c.method === 'GET') return status(403, { error: { code: 'Forbidden', message: 'x' } });
      return status(204);
    };
    assert.deepEqual(await w.criar('planner:p1', { titulo: 'A', descricao: 'x' }), { id: 't1', versao: null, url: null });
    assert.deepEqual(await w.editar('planner:p1', 't1', { descricao: 'y' }), { id: 't1', versao: null, url: null });
  });

  test('criar: a descrição falhou depois de a tarefa existir: erro avisa e diz o id, sem criar outra', async () => {
    answer = (c) => {
      if (c.url.pathname.endsWith('/buckets')) return { value: [] };
      if (c.method === 'POST') return status(201, tarefa());
      return status(503, { error: { code: 'x', message: 'fora' } });
    };
    await assert.rejects(() => w.criar('planner:p1', { titulo: 'A', descricao: 'x' }), (e: unknown) => {
      erroAcao(/criada no Planner \(id: t1\).*Não crie de novo/)(e);
      assert.deepEqual((e as ErroAcao).criado, { id: 't1', versao: ETAG, url: null }, 'o espelho liga o card a ela, sem duplicar');
      return true;
    });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });

  test('concluir e reabrir: lê a versão, PATCH com If-Match e Prefer, devolve a versão nova', async () => {
    answer = simples();
    const r = await w.concluir('planner:p1', 't1', true);
    assert.deepEqual(r, { id: 't1', versao: 'W/"novo"', url: null });
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH']);
    const p = calls[1];
    assert.equal(p.url.href, `${GRAPH}/v1.0/planner/tasks/t1`);
    assert.equal(p.headers['If-Match'], ETAG, 'a versão vai como veio, com W/ e aspas');
    assert.equal(p.headers.Prefer, 'return=representation');
    assert.deepEqual(p.body, { percentComplete: 100 });
    calls.length = 0;
    answer = simples({ percentComplete: 100 });
    await w.concluir('planner:p1', 't1', false);
    assert.deepEqual(calls[1].body, { percentComplete: 0 });
  });

  test('concluir: já está assim, não escreve; reabrir uma tarefa em andamento não apaga o andamento', async () => {
    answer = simples({ percentComplete: 100 });
    assert.equal((await w.concluir('planner:p1', 't1', true)).versao, ETAG);
    answer = simples({ percentComplete: 50 });
    assert.equal((await w.concluir('planner:p1', 't1', false)).versao, ETAG);
    assert.equal(escritas().length, 0);
    await w.concluir('planner:p1', 't1', true);
    assert.deepEqual(escritas()[0].body, { percentComplete: 100 }, '50% concluída vira 100');
  });

  test('o serviço ignorou o Prefer (204 sem corpo): sem versão, a próxima leitura confere', async () => {
    answer = (c) => (c.method === 'GET' ? tarefa() : status(204));
    assert.deepEqual(await w.concluir('planner:p1', 't1', true), { id: 't1', versao: null, url: null });
  });

  test('412 ou 409 duas vezes: para na segunda e avisa; a falha é passageira, nada de ErroAcao', async () => {
    for (const codigo of [412, 409]) {
      calls.length = 0;
      answer = (c) => (c.method === 'GET' ? tarefa() : status(codigo, { error: { code: 'x', message: 'y' } }));
      await assert.rejects(() => w.concluir('planner:p1', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable' && e.status === codigo && /duas vezes/.test(e.message));
      assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH', 'GET', 'PATCH']);
    }
  });

  test('mover: PATCH do bucketId; mesmo bucket não escreve; bucket de fora lista as opções', async () => {
    answer = (c) => (c.url.pathname.endsWith('/buckets') ? { value: [{ id: 'b1', name: 'A' }, { id: 'b2', name: 'B' }] } : simples()(c));
    await w.mover('planner:p1', 't1', 'b2');
    assert.deepEqual(escritas()[0].body, { bucketId: 'b2' }); assert.equal(escritas()[0].headers['If-Match'], ETAG);
    calls.length = 0;
    await w.mover('planner:p1', 't1', 'b1');
    assert.equal(escritas().length, 0);
    await assert.rejects(() => w.mover('planner:p1', 't1', 'done'), erroAcao(/não existe neste plano/, (o) => assert.equal(o.length, 2)));
    assert.equal(escritas().length, 0);
  });

  test('editar: título e prazo na tarefa, descrição no details; prazo null tira; nada para mudar não chama nada', async () => {
    answer = simples();
    const r = await w.editar('planner:p1', 't1', { titulo: 'Novo', prazo: null });
    assert.equal(r.versao, 'W/"novo"');
    assert.deepEqual(escritas()[0].body, { title: 'Novo', dueDateTime: null });
    calls.length = 0;
    answer = (c) => (c.method === 'GET' ? { '@odata.etag': c.url.pathname.endsWith('/details') ? 'W/"d"' : 'W/"t"' } : status(204));
    assert.deepEqual(await w.editar('planner:p1', 't1', { descricao: '' }), { id: 't1', versao: 'W/"t"', url: null });
    assert.deepEqual(calls.map((c) => [c.method, c.url.pathname]), [['GET', '/v1.0/planner/tasks/t1/details'], ['PATCH', '/v1.0/planner/tasks/t1/details'], ['GET', '/v1.0/planner/tasks/t1']]);
    assert.equal(calls[1].headers['If-Match'], 'W/"d"');
    assert.deepEqual(calls[1].body, { description: '' }, 'descrição vazia limpa');
    calls.length = 0;
    assert.deepEqual(await w.editar('planner:p1', 't1', {}), { id: 't1' });
    assert.equal(calls.length, 0);
  });

  test('parâmetro errado não chega ao serviço', async () => {
    await assert.rejects(() => w.criar('planner:p1', { titulo: '   ' }), erroAcao(/título/));
    await assert.rejects(() => w.criar('planner:p1', { titulo: 'A', prazo: '31/12/2026' }), erroAcao(/AAAA-MM-DD/));
    await assert.rejects(() => w.editar('planner:p1', 't1', { prazo: '2026-02-31' }), erroAcao(/prazo inválido/));
    await assert.rejects(() => w.editar('planner:p1', 't1', { titulo: '' }), erroAcao(/título/));
    assert.equal(calls.length, 0);
  });

  test('tarefa de outro plano é recusada antes de escrever', async () => {
    answer = simples({ planId: 'outro' });
    await assert.rejects(() => w.concluir('planner:p1', 't1', true), erroAcao(/não é deste plano/));
    assert.equal(escritas().length, 0);
  });

  test('erros do serviço: 403 é acesso; 404 é não encontrado; 400 é pedido recusado, sem repetir', async () => {
    answer = () => status(403, { error: { code: 'Forbidden', message: 'x' } });
    await assert.rejects(() => w.concluir('planner:p1', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'forbidden');
    answer = () => status(404, { error: { code: 'NotFound', message: 'x' } });
    await assert.rejects(() => w.concluir('planner:p1', 't1', true), (e: unknown) => e instanceof ProviderError && e.kind === 'not_found');
    calls.length = 0;
    answer = (c) => (c.method === 'GET' ? tarefa() : status(400, { error: { code: 'BadRequest', message: 'início depois do prazo' } }));
    await assert.rejects(() => w.editar('planner:p1', 't1', { prazo: '2026-01-01' }), erroAcao(/recusou.*início depois do prazo/));
    assert.equal(escritas().length, 1);
    for (const n of [413, 414, 422]) {
      calls.length = 0;
      answer = (c) => (c.method === 'GET' ? tarefa() : status(n, { error: { code: 'Recusado', message: 'pedido [[ruim]]' } }));
      await assert.rejects(() => w.editar('planner:p1', 't1', { titulo: 'A' }), erroAcao(/recusou.*Recusado: pedido \[ \[ruim\] \]/));
      assert.equal(escritas().length, 1);
    }
  });

  test('continuação da lista de buckets: segue no Graph; para outro endereço, recusa e o token não sai', async () => {
    answer = (c) => {
      if (c.method !== 'GET') return status(201, tarefa());
      return c.url.searchParams.has('$skip') ? { value: [{ id: 'b2', name: 'B' }] } : { value: [{ id: 'b1', name: 'A' }], '@odata.nextLink': `${GRAPH}/v1.0/planner/plans/p1/buckets?$skip=1` };
    };
    await w.criar('planner:p1', { titulo: 'A', coluna: 'b2' });
    assert.deepEqual(escritas()[0].body, { planId: 'p1', title: 'A', bucketId: 'b2' });
    for (const link of ['https://atacante.example/roubar', 'https://graph.microsoft.com.atacante.example/x', 'https://graph.microsoft.com@atacante.example/x', 'http://graph.microsoft.com/v1.0/x', 'não é endereço']) {
      calls.length = 0;
      answer = () => ({ value: [{ id: 'b1', name: 'A' }], '@odata.nextLink': link });
      await assert.rejects(() => w.criar('planner:p1', { titulo: 'A' }), (e: unknown) => e instanceof ProviderError && /fora do Microsoft Graph/.test(e.message));
      assert.equal(calls.length, 1, link);
      assert.equal(calls[0].url.origin, GRAPH);
    }
  });
});

describe('prazo do Planner: a inversa de dueAt', () => {
  /** Só o prazo que iria para o serviço: chamada de mentira, sem fetch, para varrer o ano inteiro. */
  const prazoGravado = async (tz: string, dia: string): Promise<string> => {
    let corpo: any = null;
    const falso: Http = async (_url, init) => { if (init?.method === 'PATCH') corpo = init.body; return { '@odata.etag': 'e' }; };
    await escritorMicrosoft(falso, tz).editar('planner:p', 't', { prazo: dia });
    return corpo.dueDateTime;
  };
  test('fim do dia no fuso, igual ao que o Planner guarda', async () => {
    assert.equal(await prazoGravado(SP, '2026-10-25'), '2026-10-26T02:59:59Z');
    assert.equal(await prazoGravado('UTC', '2026-10-25'), '2026-10-25T23:59:59Z');
    assert.equal(await prazoGravado('Asia/Tokyo', '2026-10-25'), '2026-10-25T14:59:59Z');
  });
  test('todo dia do ano, em fusos com e sem horário de verão: a leitura vê a mesma data', async () => {
    for (const tz of [SP, 'UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Honolulu', 'America/Havana']) {
      for (let i = 0; i < 366; i++) {
        const dia = new Date(Date.UTC(2028, 0, 1 + i)).toISOString().slice(0, 10);
        assert.equal(dueAt(await prazoGravado(tz, dia), tz), dia, `${tz} ${dia}`);
      }
    }
  });
  test('sem fuso, ou fuso inválido, usa o padrão do Ergon', async () => {
    let corpo: any = null;
    const falso: Http = async (_url, init) => { if (init?.method === 'PATCH') corpo = init.body; return { '@odata.etag': 'e' }; };
    await escritorMicrosoft(falso).editar('planner:p', 't', { prazo: '2026-10-25' });
    assert.equal(corpo.dueDateTime, '2026-10-26T02:59:59Z');
    await escritorMicrosoft(falso, 'Lua/Crescente').editar('planner:p', 't', { prazo: '2026-10-25' });
    assert.equal(corpo.dueDateTime, '2026-10-26T02:59:59Z');
  });
});

describe('To Do: o inverso da leitura', () => {
  let g: ReturnType<typeof graphFalso>;
  beforeEach(() => { g = graphFalso(); answer = g.responder; });
  const naLeitura = async (id: string) => (await provedor.getBoard('todo:l1')).tasks.find((t) => t.externalId === id)!;

  test('criar, concluir, mover entre open e done, prazo: a próxima leitura vê tudo, e a versão devolvida é a que ela vê', async () => {
    const r = await w.criar('todo:l1', { titulo: 'Pagar', prazo: '2026-06-29' });
    let t = await naLeitura(r.id);
    assert.equal(t.columnExternalId, 'open'); assert.equal(t.completed, false); assert.equal(t.due, '2026-06-29'); assert.equal(t.version, r.versao);

    const c = await w.concluir('todo:l1', r.id, true);
    t = await naLeitura(r.id);
    assert.equal(t.completed, true); assert.equal(t.columnExternalId, 'done'); assert.equal(t.version, c.versao);

    const a = await w.mover('todo:l1', r.id, 'open');
    t = await naLeitura(r.id);
    assert.equal(t.completed, false); assert.equal(t.columnExternalId, 'open'); assert.equal(t.version, a.versao);

    const f = await w.mover('todo:l1', r.id, 'done');
    t = await naLeitura(r.id);
    assert.equal(t.completed, true); assert.equal(t.version, f.versao);

    const e = await w.editar('todo:l1', r.id, { titulo: 'Pago', prazo: '2026-07-01' });
    t = await naLeitura(r.id);
    assert.equal(t.title, 'Pago'); assert.equal(t.due, '2026-07-01'); assert.equal(t.version, e.versao);

    await w.editar('todo:l1', r.id, { prazo: null });
    assert.equal((await naLeitura(r.id)).due, null);
  });

  test('criar direto em "done" nasce concluída', async () => {
    const r = await w.criar('todo:l1', { titulo: 'Já feita', coluna: 'done' });
    assert.equal((await naLeitura(r.id)).completed, true);
  });
});

describe('To Do: formato das chamadas', () => {
  const T = { id: 'd1', status: 'notStarted', lastModifiedDateTime: '2026-11-05T12:00:00Z' };

  test('criar: POST na lista, com prazo em UTC e o corpo em HTML escapado', async () => {
    answer = () => status(201, T);
    const r = await w.criar('todo:l1=', { titulo: 'Pagar', descricao: 'a<b & c>d\r\nlinha 2', prazo: '2026-06-29' });
    assert.deepEqual(r, { id: 'd1', versao: T.lastModifiedDateTime, url: null });
    const c = calls[0];
    assert.equal(c.method, 'POST'); assert.equal(c.url.href, `${GRAPH}/v1.0/me/todo/lists/l1%3D/tasks`); assert.equal(c.headers.Authorization, 'Bearer tok');
    assert.deepEqual(c.body, {
      title: 'Pagar',
      body: { contentType: 'html', content: 'a&lt;b &amp; c&gt;d<br>linha 2' },
      dueDateTime: { dateTime: '2026-06-29T00:00:00.0000000', timeZone: 'UTC' },
    });
  });

  test('concluir e reabrir: PATCH do status, sem If-Match', async () => {
    answer = () => T;
    await w.concluir('todo:l1', 'd1', true); await w.concluir('todo:l1', 'd1', false);
    assert.equal(calls[0].method, 'PATCH'); assert.equal(calls[0].url.href, `${GRAPH}/v1.0/me/todo/lists/l1/tasks/d1`); assert.equal(calls[0].headers['If-Match'], undefined);
    assert.deepEqual(calls.map((c) => c.body), [{ status: 'completed' }, { status: 'notStarted' }]);
  });

  test('mover: open e done equivalem a concluir; outra coluna lista as duas e não escreve', async () => {
    answer = () => T;
    await w.mover('todo:l1', 'd1', 'done'); await w.mover('todo:l1', 'd1', 'open');
    assert.deepEqual(calls.map((c) => c.body), [{ status: 'completed' }, { status: 'notStarted' }]);
    calls.length = 0;
    await assert.rejects(() => w.mover('todo:l1', 'd1', '__tarefas__'), erroAcao(/não existe numa lista/, (o) => assert.deepEqual(o, ['open', 'done'])));
    await assert.rejects(() => w.criar('todo:l1', { titulo: 'A', coluna: 'b1' }), erroAcao(/não existe numa lista/));
    assert.equal(calls.length, 0);
  });

  test('editar manda só o que mudou; descrição vazia limpa; prazo null tira; nada para mudar não chama nada', async () => {
    answer = () => T;
    await w.editar('todo:l1', 'd1', { titulo: 'Novo' });
    assert.deepEqual(calls[0].body, { title: 'Novo' });
    await w.editar('todo:l1', 'd1', { descricao: '', prazo: null });
    assert.deepEqual(calls[1].body, { body: { contentType: 'html', content: '' }, dueDateTime: null });
    calls.length = 0;
    assert.deepEqual(await w.editar('todo:l1', 'd1', {}), { id: 'd1' });
    assert.equal(calls.length, 0);
  });

  test('prazo não muda com o fuso do workspace: a leitura corta a data do texto, e converter erraria o dia', async () => {
    answer = () => T;
    await escritorMicrosoft(http, 'Asia/Tokyo').editar('todo:l1', 'd1', { prazo: '2026-06-29' });
    assert.deepEqual(calls[0].body.dueDateTime, { dateTime: '2026-06-29T00:00:00.0000000', timeZone: 'UTC' });
  });

  test('POST sem id na resposta não finge que criou', async () => {
    answer = () => status(201, {});
    await assert.rejects(() => w.criar('todo:l1', { titulo: 'A' }), erroAcao(/não devolveu o id/));
  });
});

describe('quadros, ids e contrato', () => {
  test('quadro sem prefixo conhecido é erro claro', async () => {
    for (const q of ['p1', 'trello:p1', 'planner:', 'todo:', ':x', '']) {
      await assert.rejects(() => w.concluir(q, 't1', true), erroAcao(/quadro inválido.*planner:.*todo:/), q);
    }
    assert.equal(calls.length, 0);
  });
  test('ids estranhos não mudam o endereço', async () => {
    answer = () => ({ id: 'x', planId: '../../users/me', '@odata.etag': 'e', percentComplete: 0, lastModifiedDateTime: 'v' });
    await w.editar('planner:../../users/me', '../users/me', { titulo: 'A' });
    assert.equal(calls[0].url.pathname, '/v1.0/planner/tasks/..%2Fusers%2Fme');
    calls.length = 0;
    await w.concluir('todo:../x?y#z', 'a/b', true);
    assert.equal(calls[0].url.pathname, '/v1.0/me/todo/lists/..%2Fx%3Fy%23z/tasks/a%2Fb');
    assert.equal(calls[0].url.search, ''); assert.equal(calls[0].url.origin, GRAPH);
  });
  test('"." e ".." somem na normalização da URL: são recusados antes de sair', async () => {
    for (const ruim of ['.', '..', '']) {
      await assert.rejects(() => w.concluir('planner:p1', ruim, true), erroAcao(/id inválido/));
      await assert.rejects(() => w.concluir('todo:l1', ruim, true), erroAcao(/id inválido/));
    }
    await assert.rejects(() => w.concluir('todo:..', 't1', true), erroAcao(/id inválido/));
    await assert.rejects(() => w.mover('planner:..', 't1', 'b1'), erroAcao(/id inválido/));
    assert.equal(calls.length, 0);
  });
  test('permissão pedida e nada de comentar (o Planner e o To Do não têm comentário pela API)', () => {
    const e: EscritorTarefas = escritorMicrosoft(http);
    assert.deepEqual(e.escopos, ['Tasks.ReadWrite']);
    assert.equal(e.comentar, undefined);
  });
});
