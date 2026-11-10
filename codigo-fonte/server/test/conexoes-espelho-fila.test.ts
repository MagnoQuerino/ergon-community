/**
 * Fila de escrita do espelho (conexoes/espelho.ts) e a leitura que convive com ela (mirror.ts): a ordem de cada tarefa vale
 * entre passadas, o ajuste de cada ação vale para o quadro, criar nunca duplica (nem pela metade, nem num reinício), o card
 * da pessoa fica com o vínculo, o que um envio mais novo superou não volta, linha ilegível não derruba a fila e a leitura
 * não desfaz o que a pessoa enviou nem perde o que outra pessoa mudou lá. O aplicativo é o Asana, com a API simulada e
 * com estado (o que se escreve aparece na leitura seguinte).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { setHttpClock } from '../src/lib/http.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { EspelhoEscrita } from '../src/services/conexoes/espelho.ts';
import { ErroAcao, type EscritorTarefas } from '../src/services/conexoes/tipos.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

// ---------------------------------------------------------------- Asana simulado, com estado
type Tarefa = { gid: string; name: string; notes: string; completed: boolean; modified_at: string; section: string; due_on: string | null };
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let app = new Map<string, Tarefa>();
let versao = 1; let novas = 0;
/** status das próximas escritas (uma por chamada); vazio = dá certo */
let falhas: number[] = [];
/** a próxima criação devolve esta tarefa (que já existe lá) */
let proximaCriada: string | null = null;
/** segura a resposta da leitura das tarefas (a foto é tirada na hora do pedido) */
let segurar: { pediu: () => void; solta: Promise<void> } | null = null;
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const nova = (gid: string, x: Partial<Tarefa> = {}): Tarefa => ({ gid, name: 'Revisar contrato', notes: '', completed: false, modified_at: `v${++versao}`, section: 's1', due_on: null, ...x });
const mexer = (t: Tarefa, x: Partial<Tarefa>) => Object.assign(t, x, { modified_at: `v${++versao}` });
const deLa = (t: Tarefa) => ({ gid: t.gid, name: t.name, notes: t.notes, completed: t.completed, modified_at: t.modified_at, due_on: t.due_on, memberships: [{ project: { gid: 'p1' }, section: { gid: t.section } }] });

async function asana(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'app.asana.com') return realFetch(input, init);
  const path = url.pathname.replace('/api/1.0', '');
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) : null;
  if (method !== 'GET') {
    calls.push({ method, path, body });
    const f = falhas.shift();
    if (f) return json({ errors: [{ message: `recusado ${f}` }] }, f);
  }
  if (path === '/users/me') return json({ data: { name: 'Ana', workspaces: [{ gid: 'w1', name: 'Acme' }] } });
  if (path === '/projects/p1') return json({ data: { name: 'Vendas', modified_at: 'p1' } });
  if (path === '/projects/p1/sections') return json({ data: [{ gid: 's1', name: 'A fazer' }, { gid: 's2', name: 'Fazendo' }, { gid: 's3', name: 'Revisão' }] });
  if (path === '/tasks' && method === 'GET') {
    const foto = [...app.values()].map(deLa);
    if (segurar) { const sg = segurar; segurar = null; sg.pediu(); await sg.solta; }
    return json({ data: foto });
  }
  const put = path.match(/^\/tasks\/([^/]+)$/);
  if (put && method === 'PUT') {
    const t = app.get(put[1])!; const d = body.data;
    mexer(t, { ...(d.completed !== undefined ? { completed: d.completed } : {}), ...(d.name !== undefined ? { name: d.name } : {}), ...(d.notes !== undefined ? { notes: d.notes } : {}), ...(d.due_on !== undefined ? { due_on: d.due_on } : {}) });
    return json({ data: { gid: t.gid, modified_at: t.modified_at } });
  }
  const sec = path.match(/^\/sections\/([^/]+)\/addTask$/);
  if (sec) { mexer(app.get(body.data.task)!, { section: sec[1] }); return json({ data: {} }); }
  if (path === '/tasks' && method === 'POST') {
    const gid = proximaCriada ?? `n${++novas}`; proximaCriada = null;
    if (!app.has(gid)) app.set(gid, nova(gid, { name: body.data.name, section: body.data.memberships?.[0]?.section ?? 's1' }));
    return json({ data: { gid, modified_at: app.get(gid)!.modified_at, permalink_url: `https://app.asana.com/0/p1/${gid}` } });
  }
  return json({ errors: [{ message: `rota simulada ausente: ${method} ${path}` }] }, 404);
}
before(() => { globalThis.fetch = asana as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let quadro: string;
beforeEach(async () => {
  calls.length = 0; falhas = []; proximaCriada = null; segurar = null; versao = 1; novas = 0;
  app = new Map([['t1', nova('t1')]]);
  h = await harness();
  s = await setupOwner(h);
  h.integrations.secrets.write(s.workspaceId, 'asana', { token: 'tok-asana-de-teste-123456' });
  setIntegration(h.db, s.workspaceId, 'asana', { state: 'connected', account_label: 'Ana', connected_at: new Date().toISOString() });
  quadro = (await req(h, 'POST', '/api/boards/mirror', s, { kind: 'asana', listId: 'p1' })).json.boardId;
});
afterEach(() => h.close());

const cardDe = (externo: string) => h.db.get<{ id: string }>('SELECT task_id AS id FROM task_links WHERE external_id = ?', externo)!.id;
const coluna = (ext: string) => h.db.get<{ id: string }>('SELECT id FROM columns WHERE board_id = ? AND external_id = ?', quadro, ext)!.id;
const patch = (id: string, body: Record<string, unknown>) => req(h, 'PATCH', `/api/tasks/${id}`, s, body);
const sync = () => req(h, 'POST', `/api/boards/${quadro}/sync`, s);
const fila = () => h.db.all<{ status: string; last_error: string | null }>('SELECT status, last_error FROM mirror_outbox ORDER BY created_at, rowid');
const vencer = () => h.db.run("UPDATE mirror_outbox SET next_at = ? WHERE status = 'pendente'", new Date(0).toISOString());
const movidas = () => calls.filter((c) => c.path.endsWith('/addTask')).map((c) => c.path.split('/')[2]);
const tick = () => h.espelhoEscrita.tick();
const pausa = () => new Promise((r) => setTimeout(r, 5));

describe('a ordem de cada tarefa', () => {
  test('a mudança seguinte espera a anterior, mesmo quando ela ficou para depois', async () => {
    const t = cardDe('t1');
    falhas = [503];
    await patch(t, { columnId: coluna('s2') });
    await tick();
    assert.equal(fila()[0].status, 'pendente', 'serviço fora: espera');
    await patch(t, { columnId: coluna('s3') });
    await tick();
    assert.deepEqual(movidas(), ['s2'], 'a de s3 não passa na frente');
    vencer();
    await tick();
    assert.deepEqual(movidas(), ['s2', 's2', 's3']);
    assert.equal(app.get('t1')!.section, 's3', 'lá fica a última decisão');
  });
});

describe('o ajuste de cada ação vale para o quadro', () => {
  test('desligar criar não para o check; desligar concluir para', async () => {
    const t = cardDe('t1');
    h.conexoes.setPermissoes(s.workspaceId, s.userId, 'asana', { tipos: {}, acoes: { 'tarefa.criar': 'desligado' } });
    await patch(t, { completed: true });
    await tick();
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /tasks/t1'], 'o check vai');
    const nova = (await req(h, 'POST', '/api/tasks', s, { title: 'Não vai', boardId: quadro })).json;
    await tick();
    assert.equal(calls.length, 1, 'criar não vai');
    assert.match(h.db.get<{ e: string }>('SELECT last_error AS e FROM mirror_outbox WHERE task_id = ?', nova.id)!.e, /"criar tarefa" está desligada em Conexões › Asana/);

    h.conexoes.setPermissoes(s.workspaceId, s.userId, 'asana', { tipos: {}, acoes: { 'tarefa.concluir': 'desligado' } });
    await patch(t, { completed: false });
    await tick();
    assert.equal(calls.length, 1, 'reabrir não vai');
    const d = (await req(h, 'GET', `/api/tasks/${t}`, s)).json;
    assert.equal(d.link.sync_state, 'escrita_falhou'); assert.match(d.link.conflict, /"concluir tarefa" está desligada/);
  });

  test('o tipo de ação desligado também vale (organizar)', async () => {
    h.conexoes.setPermissoes(s.workspaceId, s.userId, 'asana', { tipos: { organizar: 'desligado' }, acoes: {} });
    await patch(cardDe('t1'), { completed: true });
    await tick();
    assert.equal(calls.length, 0);
    assert.equal(fila()[0].status, 'falhou');
  });
});

describe('criar nunca duplica', () => {
  test('tentar de novo depois de uma criação pela metade completa a mesma tarefa', async () => {
    const feitos: string[] = []; let criar = 0;
    const meio: EscritorTarefas = {
      async criar() { criar++; throw new ErroAcao('a coluna não foi gravada. Não crie de novo', undefined, { id: `meio${criar}` }); },
      async concluir(_q, t, f) { feitos.push(`concluir ${t} ${f}`); return { id: t }; },
      async mover(_q, t, c) { feitos.push(`mover ${t} ${c}`); return { id: t }; },
      async editar(_q, t, m) { feitos.push(`editar ${t} ${JSON.stringify(m)}`); return { id: t }; },
    };
    const e = new EspelhoEscrita(h.db, h.bus, () => meio);
    const nova = (await req(h, 'POST', '/api/tasks', s, { title: 'Pela metade', boardId: quadro, columnId: coluna('s2'), dueOn: '2026-12-20' })).json;
    await e.tick();
    assert.equal(fila()[0].status, 'falhou');
    h.db.run("UPDATE mirror_outbox SET status = 'pendente', next_at = ? WHERE status = 'falhou'", new Date(0).toISOString()); // "Tentar de novo"
    await e.tick();
    assert.equal(criar, 1, 'não cria de novo');
    assert.deepEqual(feitos, ['editar meio1 {"prazo":"2026-12-20"}', 'mover meio1 s2'], 'reaplica o que faltou');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM task_links WHERE task_id = ?', nova.id)!.n, 1, 'um vínculo só');
    assert.equal(fila()[0].status, 'feita');
  });

  test('reinício no meio do envio: criar não se repete sozinho, e desligar espera a passada', async () => {
    let solta!: () => void; const espera = new Promise<void>((r) => { solta = r; });
    let criar = 0;
    const base = { concluir: async () => ({ id: 'x' }), mover: async () => ({ id: 'x' }), editar: async () => ({ id: 'x' }) };
    const lento: EscritorTarefas = { ...base, async criar() { criar++; await espera; return { id: 'lento1', versao: 'v1' }; } };
    const e1 = new EspelhoEscrita(h.db, h.bus, () => lento);
    await req(h, 'POST', '/api/tasks', s, { title: 'Lenta', boardId: quadro });
    const passada = e1.tick();
    for (let i = 0; i < 20 && fila()[0].status !== 'enviando'; i++) await new Promise((r) => setImmediate(r));
    assert.equal(fila()[0].status, 'enviando', 'a chamada saiu e a resposta ainda não chegou');
    let parou = false;
    const parando = e1.stop().then(() => { parou = true; });
    await pausa();
    assert.equal(parou, false, 'desligar espera o envio em andamento');
    solta(); await parando; await passada;
    assert.equal(fila()[0].status, 'feita', 'o que voltou ficou gravado antes de desligar');

    // agora o processo morre no meio: a linha fica "enviando" e quem sobe depois não cria de novo
    const travado: EscritorTarefas = { ...base, async criar() { criar++; return new Promise<never>(() => undefined); } };
    await req(h, 'POST', '/api/tasks', s, { title: 'Interrompida', boardId: quadro });
    const e2 = new EspelhoEscrita(h.db, h.bus, () => travado);
    void e2.tick();
    for (let i = 0; i < 20 && fila()[1].status !== 'enviando'; i++) await new Promise((r) => setImmediate(r));
    const antes = criar;
    await new EspelhoEscrita(h.db, h.bus, () => travado).tick(); // o processo novo
    assert.equal(criar, antes, 'não chamou o aplicativo de novo');
    assert.equal(fila()[1].status, 'falhou'); assert.match(fila()[1].last_error!, /Confira no aplicativo antes de criar de novo/);
  });

  test('a leitura achou a tarefa nova primeiro: o card da pessoa fica com o vínculo, e o check dela vai', async () => {
    app.set('n1', nova('n1', { name: 'Nova' }));
    proximaCriada = 'n1';
    const meu = (await req(h, 'POST', '/api/tasks', s, { title: 'Nova', boardId: quadro })).json;
    await sync(); // a leitura traz n1 como outro card antes de a criação voltar
    const trazido = cardDe('n1');
    assert.notEqual(trazido, meu.id);
    await patch(meu.id, { completed: true });
    await tick();
    assert.equal(cardDe('n1'), meu.id, 'o vínculo é do card da pessoa');
    const arq = (id: string) => h.db.get<{ a: number }>('SELECT archived AS a FROM tasks WHERE id = ?', id)!.a;
    assert.equal(arq(meu.id), 0); assert.equal(arq(trazido), 1, 'sai o card trazido pela leitura');
    assert.equal(app.get('n1')!.completed, true, 'o check chegou lá');
    assert.deepEqual(fila().map((x) => x.status), ['feita', 'feita']);
  });

  test('a pessoa deu check no card trazido pela leitura enquanto a criação voltava: o check vai, e o card dela fica concluído', async () => {
    app.set('n1', nova('n1', { name: 'Nova' }));
    proximaCriada = 'n1';
    const meu = (await req(h, 'POST', '/api/tasks', s, { title: 'Nova', boardId: quadro })).json;
    await sync();
    const trazido = cardDe('n1');
    assert.notEqual(trazido, meu.id);
    await patch(trazido, { completed: true }); // é o card que aparece no quadro
    await patch(trazido, { columnId: coluna('s2') });
    await tick();
    assert.equal(cardDe('n1'), meu.id);
    assert.equal(app.get('n1')!.completed, true, 'o check chegou lá');
    assert.equal(app.get('n1')!.section, 's2', 'a coluna também');
    const card = h.db.get<{ completed: number; by: string; col: string }>('SELECT completed, completed_by AS by, column_id AS col FROM tasks WHERE id = ?', meu.id)!;
    assert.deepEqual({ ...card }, { completed: 1, by: 'human', col: coluna('s2') }, 'o card da pessoa mostra o que ela fez');
    assert.deepEqual(fila().map((x) => x.status), ['feita', 'feita', 'feita'], 'nada cancelado em silêncio');
  });

  test('card arquivado antes de nascer lá: a criação em espera é cancelada', async () => {
    falhas = [429, 429, 429];
    const card = (await req(h, 'POST', '/api/tasks', s, { title: 'Desisti desta', boardId: quadro })).json;
    await tick();
    assert.equal(fila()[0].status, 'pendente', 'limite de uso: espera');
    await patch(card.id, { archived: true });
    calls.length = 0; vencer();
    await tick();
    assert.equal(calls.length, 0, 'nada foi criado lá');
    assert.equal(fila()[0].status, 'cancelada');
  });
});

describe('o que falhou', () => {
  test('a criação falhou de vez: o check seguinte falha com o motivo, e "Tentar de novo" leva os dois', async () => {
    falhas = [400];
    const card = (await req(h, 'POST', '/api/tasks', s, { title: 'Recusada', boardId: quadro })).json;
    await tick();
    await patch(card.id, { completed: true });
    await tick();
    assert.deepEqual(fila().map((x) => x.status), ['falhou', 'falhou'], 'nada fica esperando para sempre');
    assert.match(fila()[1].last_error!, /não chegou a ser criada no aplicativo/);
    await req(h, 'POST', `/api/tasks/${card.id}/reenviar`, s);
    await tick();
    assert.deepEqual(fila().map((x) => x.status), ['feita', 'feita']);
    assert.equal(app.get(h.db.get<{ e: string }>('SELECT external_id AS e FROM task_links WHERE task_id = ?', card.id)!.e)!.completed, true);
  });

  test('o quadro mostra o selo do envio que falhou, também no card novo', async () => {
    falhas = [400, 400];
    await patch(cardDe('t1'), { completed: true });
    const card = (await req(h, 'POST', '/api/tasks', s, { title: 'Nova recusada', boardId: quadro })).json;
    await tick();
    const v = (await req(h, 'GET', `/api/boards/${quadro}`, s)).json;
    const de = (id: string) => v.tasks.find((x: { id: string }) => x.id === id);
    assert.equal(de(cardDe('t1')).link_state, 'escrita_falhou');
    assert.equal(de(card.id).link_state, 'escrita_falhou', 'card sem vínculo também');
    assert.match(de(card.id).link_conflict, /^Não foi enviado ao aplicativo: .*recusado 400/);
  });

  test('o que um envio mais novo superou não volta pelo "Tentar de novo"', async () => {
    const t = cardDe('t1');
    falhas = [400];
    await patch(t, { columnId: coluna('s2') });
    await tick();
    await patch(t, { columnId: coluna('s3') });
    await tick();
    const d = (await req(h, 'GET', `/api/tasks/${t}`, s)).json;
    assert.equal(d.link.sync_state, 'ok'); assert.equal(d.envio, null, 'sem aviso: o último envio foi');
    calls.length = 0;
    await req(h, 'POST', `/api/tasks/${t}/reenviar`, s);
    await tick();
    assert.deepEqual(movidas(), [], 'a ida para s2 não volta');
    assert.equal(app.get('t1')!.section, 's3');
  });

  test('linha ou credencial ilegível não derruba a fila', async () => {
    app.set('t2', nova('t2', { name: 'Outra' }));
    await sync();
    const ts = new Date().toISOString();
    h.db.run("INSERT INTO mirror_outbox (id, workspace_id, task_id, op, tipo, status, next_at, created_at) VALUES ('mox_lixo', ?, ?, 'lixo{', 'concluir', 'pendente', ?, ?)", s.workspaceId, cardDe('t1'), ts, ts);
    await patch(cardDe('t2'), { completed: true });
    await tick(); // não rejeita
    assert.equal(h.db.get<{ s: string }>("SELECT status AS s FROM mirror_outbox WHERE id = 'mox_lixo'")!.s, 'falhou');
    assert.equal(app.get('t2')!.completed, true, 'as outras seguem');
    await patch(cardDe('t2'), { completed: false });
    await new EspelhoEscrita(h.db, h.bus, () => { throw new SyntaxError('Unexpected token l in JSON'); }).tick();
    assert.match(fila().at(-1)!.last_error!, /credencial/);
  });
});

describe('a leitura e a escrita juntas', () => {
  test('depois de um envio, a leitura traz o que outra pessoa mudou lá', async () => {
    mexer(app.get('t1')!, { name: 'Título mudado no Asana' }); // ninguém leu ainda
    await patch(cardDe('t1'), { completed: true });
    await tick();
    await pausa(); await sync();
    assert.equal(h.db.get<{ t: string }>('SELECT title AS t FROM tasks WHERE id = ?', cardDe('t1'))!.t, 'Título mudado no Asana');
  });

  test('a foto tirada antes de um envio não desfaz o envio', async () => {
    const t = cardDe('t1');
    let pediu!: () => void; const chegou = new Promise<void>((r) => { pediu = r; });
    let solta!: () => void; segurar = { pediu, solta: new Promise<void>((r) => { solta = r; }) };
    const lendo = sync();
    await chegou; // a foto é de antes
    await patch(t, { title: 'Revisar contrato novo' });
    await tick();
    assert.equal(app.get('t1')!.name, 'Revisar contrato novo');
    solta(); await lendo;
    assert.equal(h.db.get<{ t: string }>('SELECT title AS t FROM tasks WHERE id = ?', t)!.t, 'Revisar contrato novo');
  });

  test('conflito resolvido some; envio que falhou continua com o aviso', async () => {
    const t = cardDe('t1');
    await patch(t, { completed: true });
    await tick();
    mexer(app.get('t1')!, { completed: false });
    await pausa(); await sync();
    const link = () => h.db.get<{ st: string; c: string | null }>('SELECT sync_state AS st, conflict AS c FROM task_links WHERE task_id = ?', t)!;
    assert.match(link().c!, /conclusão humana preservada/);
    mexer(app.get('t1')!, { completed: true });
    await sync();
    assert.equal(link().c, null, 'os dois concluídos: sem conflito');

    falhas = [400];
    await patch(t, { title: 'Recusado aqui' });
    await tick();
    mexer(app.get('t1')!, { name: 'Recusado aqui' }); // alguém fez o mesmo lá
    await pausa(); await sync();
    assert.equal(link().st, 'escrita_falhou', 'o aviso e o "Tentar de novo" ficam');
    assert.match(link().c!, /Não foi enviado ao aplicativo/);
  });

  test('descrição maior do que o card guarda: editar aqui é recusado, para não apagar o resto lá', async () => {
    mexer(app.get('t1')!, { notes: 'A'.repeat(9000) });
    await sync();
    const t = cardDe('t1');
    const r = await patch(t, { description: 'curta' });
    assert.equal(r.status, 409); assert.match(r.json.message, /edite a descrição lá/);
    assert.equal(fila().length, 0, 'nada foi para a fila');
    assert.equal((await patch(t, { title: 'Título pode' })).status, 200);
  });

  const marca = (t: string) => JSON.parse(h.db.get<{ x: string }>('SELECT external_extra AS x FROM task_links WHERE task_id = ?', t)!.x).descricao_cortada === true;
  test('vínculo de antes da marca do corte: a leitura seguinte marca, e editar aqui é recusado', async () => {
    mexer(app.get('t1')!, { notes: 'A'.repeat(7000) + 'B'.repeat(3000) });
    await sync();
    const t = cardDe('t1');
    h.db.run("UPDATE task_links SET external_extra = '{}' WHERE task_id = ?", t); // como a leitura de antes gravava
    assert.equal((await patch(t, { description: 'A'.repeat(7990) + ' editado' })).status, 409, 'o card guarda 8.000: lá pode haver mais');
    mexer(app.get('t1')!, {}); // lá, só a versão andou
    await sync();
    assert.ok(marca(t), 'a leitura sem mudança de campo grava a marca');
    h.db.run("UPDATE task_links SET external_extra = '{}' WHERE task_id = ?", t);
    await sync(); // a mesma versão
    assert.ok(marca(t), 'a leitura de versão igual também');
    assert.equal((await patch(t, { description: 'curta' })).status, 409);
    await tick();
    assert.equal((app.get('t1')!.notes.match(/B/g) ?? []).length, 3000, 'nada se perdeu lá');
  });

  test('descrição de 8.000 que cresce lá: a marca nasce mesmo sem mudar o que o card guarda', async () => {
    mexer(app.get('t1')!, { notes: 'A'.repeat(8000) });
    await sync();
    const t = cardDe('t1');
    mexer(app.get('t1')!, { notes: 'A'.repeat(8000) + 'B'.repeat(1000) });
    await sync();
    assert.ok(marca(t));
    assert.equal((await patch(t, { description: 'A'.repeat(7990) + ' editado' })).status, 409);
    await tick();
    assert.equal((app.get('t1')!.notes.match(/B/g) ?? []).length, 1000, 'nada se perdeu lá');
  });

  test('na tela, a descrição cortada fica só para ler, e o título grava sem ela', () => {
    const tela = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'components', 'TaskDetail.tsx'), 'utf8');
    assert.match(tela, /descricao_cortada/, 'lê a marca do vínculo');
    assert.match(tela, /description\.length >= 8000/, 'e o tamanho, para o vínculo de antes da marca');
    // o aviso vem do dicionário da tela (web/src/i18n/pt/tarefa.ts)
    assert.match(tela, /t\('tarefa\.editavel\.descricaoCortada'\)/);
    const dicionario = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'i18n', 'pt', 'tarefa.ts'), 'utf8');
    assert.match(dicionario, /'editavel\.descricaoCortada': 'Esta descrição é maior do que cabe aqui: edite no aplicativo\.'/);
    assert.match(tela, /cortada \? \(/, 'sem campo de edição quando cortada');
    assert.match(tela, /&& !cortada\) body\.description/, 'a descrição cortada não vai no envio');
    assert.match(tela, /e\.code === 'descricao_longa'[\s\S]{0,200}setDesc\(saved\.current\.desc\)[\s\S]{0,80}await run\(\)/, 'no 409, volta a de antes e grava o título sozinho');
  });

  test('card criado enquanto a foto era tirada: não fica "ausente"', async () => {
    let pediu!: () => void; const chegou = new Promise<void>((r) => { pediu = r; });
    let solta!: () => void; segurar = { pediu, solta: new Promise<void>((r) => { solta = r; }) };
    const lendo = sync();
    await chegou;
    const card = (await req(h, 'POST', '/api/tasks', s, { title: 'Nova durante a leitura', boardId: quadro })).json;
    await tick();
    assert.ok(h.db.get('SELECT 1 AS x FROM task_links WHERE task_id = ?', card.id), 'vinculou');
    solta(); await lendo;
    assert.equal(h.db.get<{ st: string }>('SELECT sync_state AS st FROM task_links WHERE task_id = ?', card.id)!.st, 'ok');
    assert.equal(h.db.get('SELECT 1 AS x FROM audit_events WHERE action = ? AND target_id = ?', 'mirror.task.missing', card.id), undefined, 'nem o histórico diz que sumiu');
  });
});
