/**
 * World Sync cifrado no aparelho: as primitivas (envelopes por aparelho e de recuperação, mudanças cifradas e
 * assinadas) e dois computadores da mesma pessoa contra o World de mentira (fake-world.ts), que só guarda o que
 * recebe: esqueleto da equipe, tarefas, conversas e mensagens vão e voltam; a mesma tarefa mudada nos dois vira
 * conflito para a pessoa decidir; envio com versão velha não sobrescreve; conteúdo fora do formato é recusado.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ContentSync, parseContent } from '../src/world/sync-content.ts';
import { SyncAtividade } from '../src/world/sync-atividade.ts';
import { newWorkspaceKey, openChange, sealChange, unwrapForDevice, unwrapForRecovery, wrapForDevice, wrapForRecovery } from '../src/world/sync-crypto.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const der = (k: crypto.KeyObject, pub: boolean) => k.export({ format: 'der', type: pub ? 'spki' : 'pkcs8' }).toString('base64');
const WS = `sws_${'a'.repeat(32)}`;

describe('criptografia do Sync (no aparelho)', () => {
  test('envelope por aparelho: só a chave X25519 daquele aparelho abre, e só para aquele workspace e versão', () => {
    const dek = newWorkspaceKey();
    const dev = crypto.generateKeyPairSync('x25519'); const outro = crypto.generateKeyPairSync('x25519');
    const w = wrapForDevice(dek, der(dev.publicKey, true), WS, 1);
    assert.ok(!w.includes(dek.toString('base64')));
    assert.deepEqual(unwrapForDevice(w, der(dev.privateKey, false), WS, 1), dek);
    assert.throws(() => unwrapForDevice(w, der(outro.privateKey, false), WS, 1), 'outro aparelho');
    assert.throws(() => unwrapForDevice(w, der(dev.privateKey, false), `sws_${'b'.repeat(32)}`, 1), 'outro workspace');
    assert.throws(() => unwrapForDevice(w, der(dev.privateKey, false), WS, 2), 'outra versão da chave');
    assert.notEqual(wrapForDevice(dek, der(dev.publicKey, true), WS, 1), w, 'chave efêmera nova a cada envelope');
  });

  test('envelope de recuperação: a frase certa abre; a errada, não', () => {
    const dek = newWorkspaceKey();
    const w = wrapForRecovery(dek, 'uma frase de recuperação comprida', WS, 1);
    assert.deepEqual(unwrapForRecovery(w, 'uma frase de recuperação comprida', WS, 1), dek);
    assert.throws(() => unwrapForRecovery(w, 'outra frase de recuperação comprida', WS, 1));
  });

  test('mudança: cifrada (o World não lê), assinada pelo aparelho e amarrada à operação', () => {
    const dek = newWorkspaceKey(); const ed = crypto.generateKeyPairSync('ed25519');
    const body = { type: 'content', tasks: [{ title: 'Levar o anel a Mordor' }] };
    const c = sealChange(dek, WS, body, { operationId: 'ct_1', expectedVersion: 3, schemaVersion: 1, keyVersion: 1 }, der(ed.privateKey, false));
    assert.ok(!JSON.stringify(c).includes('Mordor'));
    assert.deepEqual(openChange(dek, WS, c), body);
    const canon = `ergon-sync-v1|${WS}|3|ct_1|1|1|change|${c.sha256}`;
    assert.ok(crypto.verify(null, Buffer.from(canon), ed.publicKey, Buffer.from(c.signature, 'base64')), 'o servidor confere quem mandou');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(c.ciphertext, 'base64')).digest('hex'), c.sha256);
    assert.throws(() => openChange(newWorkspaceKey(), WS, c), 'outra chave');
    assert.throws(() => openChange(dek, WS, { ...c, operationId: 'ct_2' }), 'outra operação');
    const raw = Buffer.from(c.ciphertext, 'base64'); raw[0] ^= 1;
    assert.throws(() => openChange(dek, WS, { ...c, ciphertext: raw.toString('base64') }), 'mexido no caminho');
  });
});

describe('World Sync entre dois computadores da mesma pessoa', () => {
  let world: FakeWorld; let pc1: Harness; let a1: Session; let pc2: Harness; let a2: Session;
  const FRASE = 'frase de recuperação do sync da ana para o teste';
  before(async () => { world = await new FakeWorld().start(); process.env.ERGON_WORLD_URL = world.url; });
  after(async () => { process.env.ERGON_WORLD_URL = ''; await pc1?.close(); await pc2?.close(); await world.stop(); });

  const agenteId = (h: Harness, ws: string, nome: string) => h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = ? AND status = 'active'", ws, nome)!.id;
  const agentes = (h: Harness, ws: string) => h.db.all<{ name: string }>("SELECT name FROM agents WHERE workspace_id = ? AND status = 'active'", ws).map((a) => a.name);
  const tarefa = (h: Harness, id: string) => h.db.get<{ title: string; due_on: string | null; sync_origin: string | null; agent_id: string | null }>('SELECT title, due_on, sync_origin, agent_id FROM tasks WHERE id = ?', id);
  const mensagens = async (h: Harness, s: Session, conv: string) => ((await req(h, 'GET', `/api/conversations/${conv}/messages`, s)).json as Array<{ content: string }>).map((m) => m.content);
  const escrever = (h: Harness, s: Session, conv: string, idMsg: string, texto: string) =>
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'local', ?)",
      idMsg, s.workspaceId, conv, s.userId, h.db.seal(s.workspaceId, texto), new Date().toISOString());
  const cifrado = () => JSON.stringify([...world.workspaces.values()].map((w) => w.changes));

  test('PC 1 liga o workspace e o Sync; PC 2 entra pela frase de recuperação e recebe a equipe', async () => {
    pc1 = await harness(); a1 = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
    assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    const sws = (await req(pc1, 'POST', '/api/world/bind', a1, {})).json.syncWorkspaceId as string;
    assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', a1, { recoveryPhrase: FRASE })).status, 200);
    world.activate(sws);
    assert.equal((await req(pc1, 'POST', '/api/agents', a1, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).status, 200);
    assert.ok(!cifrado().includes('Frodo'), 'o World guarda sem ler');

    pc2 = await harness(); a2 = await setupOwner(pc2, 'ana-notebook', 'senha-do-notebook-123');
    assert.equal((await req(pc2, 'POST', '/api/world/connect', a2, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
    assert.equal((await req(pc2, 'POST', '/api/world/bind', a2, { syncWorkspaceId: sws })).status, 200);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/join', a2, { recoveryPhrase: FRASE })).status, 200);
    const prev = await req(pc2, 'POST', '/api/world/sync/pull', a2, {});
    assert.ok(prev.json.preview.agents.some((x: { name: string }) => x.name === 'Frodo'));
    assert.ok(!agentes(pc2, a2.workspaceId).includes('Frodo'), 'prévia não muda nada');
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json.applied, true);
    assert.ok(agentes(pc2, a2.workspaceId).includes('Frodo'));
  });

  let tarefaId = ''; let conversaId = '';
  test('conteúdo: tarefa, conversa e mensagem vão cifradas; o PC 2 acompanha sem trabalhar na tarefa', async () => {
    const frodo1 = agenteId(pc1, a1.workspaceId, 'Frodo');
    const t = await req(pc1, 'POST', '/api/tasks', a1, { title: 'Levar o anel a Mordor', description: 'Passando por Moria', agentId: frodo1, dueOn: '2026-11-30' });
    assert.equal(t.status, 201); tarefaId = t.json.id;
    const cv = await req(pc1, 'POST', '/api/conversations', a1, { agentId: frodo1, title: 'Plano da viagem' });
    assert.equal(cv.status, 201); conversaId = cv.json.id;
    escrever(pc1, a1, conversaId, 'msg_pc1aaaaaaaaaaaaaa', 'Qual o caminho mais seguro?');
    const p = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.equal(p.status, 200); assert.deepEqual([p.json.sent.tasks >= 1, p.json.sent.conversations, p.json.sent.messages], [true, 1, 1]);
    for (const x of ['Mordor', 'caminho mais seguro', 'Plano da viagem']) assert.ok(!cifrado().includes(x), `o World guarda sem ler: ${x}`);
    const ap = await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true });
    assert.deepEqual([ap.json.applied, ap.json.conflicts], [true, 0]);
    const t2 = tarefa(pc2, tarefaId)!;
    assert.deepEqual([t2.title, t2.due_on, t2.agent_id], ['Levar o anel a Mordor', '2026-11-30', agenteId(pc2, a2.workspaceId, 'Frodo')]);
    assert.ok(t2.sync_origin, 'guarda o aparelho de origem');
    assert.deepEqual(await mensagens(pc2, a2, conversaId), ['Qual o caminho mais seguro?']);
    pc2.db.run('UPDATE tasks SET archived = 1 WHERE workspace_id = ? AND sync_origin IS NULL', a2.workspaceId);
    assert.equal(pc2.teamwork.next(a2.workspaceId), null, 'tarefa recebida não roda sozinha no PC 2');
    assert.equal((await req(pc2, 'POST', '/api/world/sync/push', a2, {})).json.sent.tasks, 0, 'o que chegou não volta');
  });

  test('conflito: os dois mudam a mesma tarefa; versão velha não sobrescreve; manter a minha e ficar com a do outro', async () => {
    const t = await req(pc1, 'POST', '/api/tasks', a1, { title: 'Comprar lembas' }); const tid = t.json.id as string;
    await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true });
    assert.equal(tarefa(pc2, tid)!.title, 'Comprar lembas');
    assert.equal((await req(pc2, 'PATCH', `/api/tasks/${tid}`, a2, { title: 'Comprar lembas (ideia do notebook)' })).status, 200);
    escrever(pc2, a2, conversaId, 'msg_pc2bbbbbbbbbbbbbb', 'Pelas montanhas, então.');
    await req(pc2, 'POST', '/api/world/sync/push', a2, {});
    await req(pc1, 'PATCH', `/api/tasks/${tid}`, a1, { title: 'Comprar lembas (ideia do PC)' });
    const velha = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
    assert.deepEqual([velha.status, velha.json.error], [409, 'version_conflict']);
    const p = await req(pc1, 'POST', '/api/world/sync/pull', a1, { apply: true });
    assert.equal(p.json.conflicts, 1);
    assert.equal(tarefa(pc1, tid)!.title, 'Comprar lembas (ideia do PC)', 'nada sobrescrito');
    assert.deepEqual(await mensagens(pc1, a1, conversaId), ['Qual o caminho mais seguro?', 'Pelas montanhas, então.'], 'mensagens se unem');
    const cs = (await req(pc1, 'GET', '/api/world/sync/conflicts', a1)).json;
    assert.deepEqual([cs.length, cs[0].mine.title, cs[0].theirs.title], [1, 'Comprar lembas (ideia do PC)', 'Comprar lembas (ideia do notebook)']);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.sent.tasks, 0, 'em conflito: não vai até a pessoa decidir');
    assert.equal((await req(pc1, 'POST', `/api/world/sync/conflicts/${cs[0].id}`, a1, { keep: 'mine' })).status, 200);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.sent.tasks, 1);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json.conflicts, 0);
    assert.equal(tarefa(pc2, tid)!.title, 'Comprar lembas (ideia do PC)');
    await req(pc2, 'PATCH', `/api/tasks/${tid}`, a2, { title: 'Comprar lembas e cordas' }); await req(pc2, 'POST', '/api/world/sync/push', a2, {});
    await req(pc1, 'PATCH', `/api/tasks/${tid}`, a1, { completed: true });
    await req(pc1, 'POST', '/api/world/sync/pull', a1, { apply: true });
    const c2 = (await req(pc1, 'GET', '/api/world/sync/conflicts', a1)).json[0];
    assert.equal((await req(pc1, 'POST', `/api/world/sync/conflicts/${c2.id}`, a1, { keep: 'theirs' })).status, 200);
    assert.equal(tarefa(pc1, tid)!.title, 'Comprar lembas e cordas');
    assert.equal((await req(pc1, 'POST', `/api/world/sync/conflicts/${c2.id}`, a1, { keep: 'mine' })).status, 404, 'já resolvido');
  });

  test('corte no meio de receber (aplicativo morto à força): retoma da mudança seguinte, sem repetir nada', async () => {
    const versao = () => pc2.db.get<{ v: number }>('SELECT last_version AS v FROM world_sync WHERE workspace_id = ?', a2.workspaceId)!.v;
    const ids: string[] = [];
    for (const titulo of ['Afiar a Ferroada', 'Remendar a capa élfica']) {
      ids.push((await req(pc1, 'POST', '/api/tasks', a1, { title: titulo })).json.id);
      escrever(pc1, a1, conversaId, `msg_corte${ids.length}aaaaaaaaaaa`, `${titulo}: feito?`);
      assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).status, 200); // uma mudança por envio
    }
    const antes = versao();
    // a barra de cima: o sinal acende enquanto aplica e apaga no fim (dê no que der)
    const sinais: boolean[] = [];
    const sai = pc2.bus.subscribe(a2.workspaceId, (e) => { if (e.type === 'sync.changed') sinais.push(e.data.ativo === true); });
    const aplicar = ContentSync.prototype.apply; let n = 0;
    ContentSync.prototype.apply = function (this: ContentSync, ...a: Parameters<ContentSync['apply']>) { if (++n === 2) throw new Error('energia caiu'); return aplicar.apply(this, a); };
    try { assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).status, 500); }
    finally { ContentSync.prototype.apply = aplicar; }
    assert.ok(versao() > antes, 'a primeira mudança ficou gravada como ponto seguro');
    assert.equal(tarefa(pc2, ids[0])!.title, 'Afiar a Ferroada');
    assert.equal(tarefa(pc2, ids[1]), undefined, 'a segunda não ficou pela metade');
    assert.deepEqual(sinais, [true, false]);
    assert.equal((await req(pc2, 'GET', '/api/world/sync/atividade', a2)).json.ativo, false);
    const de = (await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json;
    assert.deepEqual([de.applied, de.result.added], [true, 2], 'só a segunda mudança (tarefa + mensagem): a primeira não vem de novo');
    assert.equal(tarefa(pc2, ids[1])!.title, 'Remendar a capa élfica');
    assert.deepEqual((await mensagens(pc2, a2, conversaId)).filter((m) => m.endsWith('feito?')), ['Afiar a Ferroada: feito?', 'Remendar a capa élfica: feito?']);
    // sem nada novo: a conferência não acende o sinal
    sinais.length = 0;
    await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true }); await req(pc2, 'POST', '/api/world/sync/push', a2, {});
    sai();
    assert.deepEqual(sinais, []);
  });

  test('pausa ao fechar: espera o passo em andamento e não começa outro até retomar', async () => {
    let t = 0; const at = new SyncAtividade(null, () => t);
    assert.deepEqual(await at.pausar(50), { concluida: true }, 'nada em andamento: pausa na hora');
    assert.equal(at.pausada(), true);
    t = 2 * 60_000 + 1; assert.equal(at.pausada(), false, 'a pausa do fechamento dura 2 min');
    await at.pausar(50, 24 * 3600_000); t += 31 * 60_000; assert.equal(at.pausada(), false, 'e nunca passa de 30 min');
    let soltar = () => {};
    const passo = at.envolver('ws1', 'enviando', () => new Promise<void>((r) => { soltar = r; }));
    assert.deepEqual([at.estado('ws1').ativo, at.estado('ws1').fase, at.algumAtivo()], [true, 'enviando', true]);
    const p = at.pausar(5_000);
    setTimeout(() => soltar(), 20);
    assert.deepEqual(await p, { concluida: true }, 'esperou o passo terminar');
    await passo;
    assert.deepEqual([at.estado('ws1').ativo, at.pausada()], [false, true]);
    at.retomar(); assert.equal(at.pausada(), false);
    // passo que não termina a tempo: a pausa responde mesmo assim (o resto retoma do ponto seguro)
    const preso = at.envolver('ws1', 'recebendo', () => new Promise<void>(() => {}));
    assert.deepEqual(await at.pausar(30), { concluida: false });
    void preso;
    // pela tela: pausar e retomar
    assert.equal((await req(pc1, 'POST', '/api/world/sync/pausar', a1, {})).json.concluida, true);
    assert.equal((await req(pc1, 'GET', '/api/world/sync/atividade', a1)).json.pausada, true);
    assert.equal((await req(pc1, 'POST', '/api/world/sync/retomar', a1, {})).status, 200);
    assert.equal((await req(pc1, 'GET', '/api/world/sync/atividade', a1)).json.pausada, false);
  });

  // ---------------------------------------------------------------- quadros da pessoa e o que vai dentro do cartão (rc.41)
  const levar = async (de: [Harness, Session], para: [Harness, Session]) => {
    const p = await req(de[0], 'POST', '/api/world/sync/push', de[1], {}); assert.equal(p.status, 200, JSON.stringify(p.json));
    const r = await req(para[0], 'POST', '/api/world/sync/pull', para[1], { apply: true }); assert.equal(r.status, 200, JSON.stringify(r.json));
    return { enviado: p.json, recebido: r.json };
  };
  const quadro = async (h: Harness, s: Session, id: string) => (await req(h, 'GET', `/api/boards/${id}`, s)).json as { board: { name: string }; columns: Array<{ id: string; name: string }>; fields: Array<{ id: string; name: string; type: string }>; tasks: Array<{ id: string; column_id: string; title: string }> };
  const cartao = async (h: Harness, s: Session, id: string) => (await req(h, 'GET', `/api/tasks/${id}/card`, s)).json as {
    subtasks: Array<{ id: string; title: string; done: boolean }>; comments: Array<{ id: string; body: string; authorName: string; mine: boolean }>; links: Array<{ url: string }>;
    people: Array<{ id: string }>; attachments: Array<{ filename: string; available: boolean }>; values: Record<string, unknown> };
  const onde = (h: Harness, id: string) => h.db.get<{ board_id: string; column_id: string }>('SELECT board_id, column_id FROM tasks WHERE id = ?', id)!;
  const nadaPendente = (h: Harness, s: Session) => new ContentSync(h.db).pending(s.workspaceId, s.userId).filter((x) => x.kind === 'board' || x.kind === 'card').length;

  let obra = ''; let colsObra: Array<{ id: string; name: string }> = []; let tijolo = ''; let campoFase = ''; let opcoes: Array<{ id: string; name: string }> = [];
  test('quadro novo com colunas próprias chega igual, com o mesmo id; a tarefa fica no quadro e na coluna certos; nada volta', async () => {
    await levar([pc2, a2], [pc1, a1]); // os dois em dia antes de começar
    obra = (await req(pc1, 'POST', '/api/boards', a1, { name: 'Obra da casa', columns: ['Orçar', 'Comprar', 'Instalar', 'Pronto'] })).json.id;
    colsObra = (await quadro(pc1, a1, obra)).columns;
    const f = await req(pc1, 'POST', `/api/boards/${obra}/fields`, a1, { name: 'Fase', type: 'labels', options: [{ name: 'Elétrica', color: 'atencao' }, { name: 'Hidráulica', color: 'info' }] });
    assert.equal(f.status, 201, JSON.stringify(f.json)); campoFase = f.json.id; opcoes = f.json.options;
    tijolo = (await req(pc1, 'POST', '/api/tasks', a1, { title: 'Comprar tijolo', boardId: obra, columnId: colsObra[1].id })).json.id;
    assert.equal((await req(pc1, 'PUT', `/api/tasks/${tijolo}/fields/${campoFase}`, a1, { value: [opcoes[1].id] })).status, 200);
    const antigo = (await req(pc1, 'POST', '/api/tasks', a1, { title: 'Ligar para o pedreiro' })).json.id as string; // no quadro de entrada
    const { enviado } = await levar([pc1, a1], [pc2, a2]);
    assert.ok(enviado.sent.tasks >= 2);
    for (const x of ['Obra da casa', 'Orçar', 'Hidráulica', 'Fase']) assert.ok(!cifrado().includes(x), `o World guarda sem ler: ${x}`);
    const q2 = await quadro(pc2, a2, obra);
    assert.equal(q2.board.name, 'Obra da casa');
    assert.deepEqual(q2.columns.map((c) => [c.id, c.name]), colsObra.map((c) => [c.id, c.name]), 'as mesmas colunas, na mesma ordem, com os mesmos ids');
    assert.deepEqual(q2.fields.map((x) => [x.id, x.name, x.type]), [[campoFase, 'Fase', 'labels']]);
    assert.deepEqual(onde(pc2, tijolo), { board_id: obra, column_id: colsObra[1].id }, 'no quadro e na coluna certos (não no primeiro quadro)');
    assert.deepEqual((await cartao(pc2, a2, tijolo)).values[campoFase], [opcoes[1].id]);
    // a tarefa do quadro de entrada cai no de entrada daqui (outro id), na coluna de fábrica correspondente
    const entrada2 = pc2.db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user' ORDER BY created_at LIMIT 1", a2.workspaceId)!.id;
    assert.equal(onde(pc2, antigo).board_id, entrada2);
    assert.equal(pc2.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ? AND audience = 'user' AND origin = 'native'", a2.workspaceId)!.n, 2, 'o quadro de entrada não foi duplicado');
    assert.equal(nadaPendente(pc2, a2), 0, 'o que chegou não volta');
    const eco = await req(pc2, 'POST', '/api/world/sync/push', a2, {});
    assert.deepEqual([eco.status, eco.json.sent.tasks], [200, 0]);
  });

  test('os dois lados mexem no mesmo quadro: colunas e campos se unem, renomear e reordenar valem do último, sem duplicar', async () => {
    // PC 2 renomeia e reordena; PC 1, sem ter recebido, cria uma coluna e um campo
    await req(pc2, 'PATCH', `/api/columns/${colsObra[0].id}`, a2, { name: 'Orçamento' });
    await req(pc2, 'PATCH', `/api/columns/${colsObra[3].id}`, a2, { position: 0 });
    await levar([pc2, a2], [pc1, a1]);
    assert.deepEqual((await quadro(pc1, a1, obra)).columns.map((c) => c.name), ['Pronto', 'Orçamento', 'Comprar', 'Instalar']);
    const nova1 = (await req(pc1, 'POST', `/api/boards/${obra}/columns`, a1, { name: 'Esperando entrega' })).json.id as string;
    const nova2 = (await req(pc2, 'POST', `/api/boards/${obra}/columns`, a2, { name: 'Devolver' })).json.id as string;
    const custo = (await req(pc2, 'POST', `/api/boards/${obra}/fields`, a2, { name: 'Custo', type: 'number', showOnCard: true })).json.id as string;
    await levar([pc2, a2], [pc1, a1]); await levar([pc1, a1], [pc2, a2]);
    const [q1, q2] = [await quadro(pc1, a1, obra), await quadro(pc2, a2, obra)];
    assert.deepEqual(q1.columns.map((c) => c.id), q2.columns.map((c) => c.id), 'a mesma ordem nos dois');
    assert.deepEqual([...q1.columns.map((c) => c.id)].sort(), [...colsObra.map((c) => c.id), nova1, nova2].sort(), 'a união, sem coluna repetida');
    assert.deepEqual(q1.fields.map((f) => f.id).sort(), [campoFase, custo].sort());
    assert.deepEqual(q1.fields.map((f) => f.id), q2.fields.map((f) => f.id));
    await levar([pc2, a2], [pc1, a1]);
    assert.deepEqual([nadaPendente(pc1, a1), nadaPendente(pc2, a2)], [0, 0], 'assentou: nenhum dos dois tem mais o que mandar');
  });

  test('chegando só quadro ou só item de cartão (sem tarefa), a tela de Tarefas é avisada (tasks.changed)', async () => {
    const avisos: string[] = [];
    const sai = pc1.bus.subscribe(a1.workspaceId, (e) => { if (e.type === 'tasks.changed') avisos.push(e.type); });
    try {
      // só o quadro: uma coluna nova
      await req(pc2, 'POST', `/api/boards/${obra}/columns`, a2, { name: 'Conferir' });
      let { recebido } = await levar([pc2, a2], [pc1, a1]);
      assert.equal(recebido.incoming.tasks, 0, 'nenhuma tarefa veio: só o quadro');
      assert.equal(avisos.length, 1, 'a tela soube da coluna nova');
      // só um item de cartão: um comentário no cartão
      assert.equal((await req(pc2, 'POST', `/api/tasks/${tijolo}/comments`, a2, { body: 'Chegou o orçamento' })).status, 201);
      ({ recebido } = await levar([pc2, a2], [pc1, a1]));
      assert.equal(recebido.incoming.tasks, 0, 'nenhuma tarefa veio: só o item do cartão');
      assert.equal(avisos.length, 2, 'a tela soube do comentário');
    } finally { sai(); }
  });

  test('apagar coluna e quadro num lado reflete no outro sem perder cards (nem o card que só existia lá)', async () => {
    const comprar = colsObra[1].id; const instalar = colsObra[2].id;
    // um card que só o PC 2 tem, na coluna que o PC 1 vai apagar
    const soNoPc2 = (await req(pc2, 'POST', '/api/tasks', a2, { title: 'Comprar cimento', boardId: obra, columnId: comprar })).json.id as string;
    const apagou = await req(pc1, 'DELETE', `/api/columns/${comprar}`, a1, { destino: instalar });
    assert.deepEqual([apagou.status, apagou.json.movidos], [200, 1]);
    const r = await levar([pc1, a1], [pc2, a2]);
    assert.equal(r.recebido.conflicts, 0, 'mover por causa da coluna apagada não vira conflito');
    assert.ok(!(await quadro(pc2, a2, obra)).columns.some((c) => c.id === comprar), 'a coluna sumiu no outro');
    assert.equal(onde(pc2, tijolo).column_id, instalar, 'o card foi para o mesmo destino');
    assert.equal(onde(pc2, soNoPc2).column_id, instalar, 'o card que só existia aqui também, sem se perder');
    await levar([pc2, a2], [pc1, a1]);
    assert.deepEqual(onde(pc1, soNoPc2), { board_id: obra, column_id: instalar });
    assert.ok(!(await quadro(pc1, a1, obra)).columns.some((c) => c.id === comprar), 'a coluna apagada não volta');
    // agora o quadro inteiro, apagado no PC 2: os cards vão para o quadro de entrada de cada aparelho
    const outro = (await req(pc2, 'POST', '/api/tasks', a2, { title: 'Chamar o eletricista', boardId: obra })).json.id as string;
    assert.equal((await req(pc2, 'DELETE', `/api/boards/${obra}`, a2, {})).json.movidos, 3);
    const r2 = await levar([pc2, a2], [pc1, a1]);
    assert.equal(r2.recebido.conflicts, 0);
    const entrada1 = pc1.db.get<{ id: string }>("SELECT id FROM boards WHERE workspace_id = ? AND origin = 'native' AND audience = 'user' ORDER BY created_at LIMIT 1", a1.workspaceId)!.id;
    assert.equal(pc1.db.get('SELECT 1 AS x FROM boards WHERE id = ?', obra), undefined, 'o quadro sumiu no outro');
    for (const t of [tijolo, soNoPc2, outro]) assert.equal(onde(pc1, t).board_id, entrada1, 'nenhum card se perdeu');
    assert.equal(pc1.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM board_fields WHERE board_id = ?', obra)!.n, 0);
    await levar([pc1, a1], [pc2, a2]);
    assert.equal(pc2.db.get('SELECT 1 AS x FROM boards WHERE id = ?', obra), undefined, 'o quadro apagado não volta');
    assert.deepEqual([nadaPendente(pc1, a1), nadaPendente(pc2, a2)], [0, 0]);
  });

  test('cartão: comentário e subtarefa chegam uma vez só; os dois lados se unem; o apagado não volta; link, pessoa e anexo viajam', async () => {
    const t = (await req(pc1, 'POST', '/api/tasks', a1, { title: 'Organizar a mudança' })).json.id as string;
    const sub = (await req(pc1, 'POST', `/api/tasks/${t}/subtasks`, a1, { title: 'Encaixotar os livros' })).json.id as string;
    const cm = (await req(pc1, 'POST', `/api/tasks/${t}/comments`, a1, { body: 'O caminhão vem sábado cedo.' })).json.id as string;
    assert.equal((await req(pc1, 'POST', `/api/tasks/${t}/links`, a1, { url: 'https://exemplo.test/caminhao', title: 'Orçamento' })).status, 201);
    assert.equal((await req(pc1, 'PUT', `/api/tasks/${t}/people`, a1, { userIds: [a1.userId] })).status, 200);
    const doc = (await req(pc1, 'POST', '/api/artifacts', a1, Buffer.from('lista de caixas'), { 'content-type': 'application/octet-stream', 'x-filename': 'caixas.txt', 'x-file-type': 'text/plain' })).json.id as string;
    assert.equal((await req(pc1, 'POST', `/api/tasks/${t}/attachments`, a1, { artifactId: doc })).status, 201);
    await levar([pc1, a1], [pc2, a2]);
    for (const x of ['Encaixotar', 'caminhão vem', 'exemplo.test', 'caixas.txt']) assert.ok(!cifrado().includes(x), `o World guarda sem ler: ${x}`);
    let c2 = await cartao(pc2, a2, t);
    assert.deepEqual(c2.subtasks.map((s) => [s.id, s.title, s.done]), [[sub, 'Encaixotar os livros', false]]);
    assert.deepEqual(c2.comments.map((c) => [c.id, c.body, c.authorName, c.mine]), [[cm, 'O caminhão vem sábado cedo.', pc1.db.get<{ n: string }>('SELECT display_name AS n FROM users WHERE id = ?', a1.userId)!.n, true]], 'o comentário é da mesma pessoa, que pode apagar aqui também');
    assert.deepEqual(c2.links.map((l) => l.url), ['https://exemplo.test/caminhao']);
    assert.deepEqual(c2.people.map((p) => p.id), [a2.userId], '"eu" é a conta deste aparelho');
    assert.deepEqual(c2.attachments.map((x) => [x.filename, x.available]), [['caixas.txt', false]], 'a referência chega; o arquivo não está neste aparelho');
    // receber de novo a mesma mudança (o World entrega outra vez): nada duplica
    pc2.db.run('UPDATE world_sync SET last_version = last_version - 1 WHERE workspace_id = ?', a2.workspaceId);
    assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).status, 200);
    c2 = await cartao(pc2, a2, t);
    assert.deepEqual([c2.subtasks.length, c2.comments.length, c2.links.length, c2.attachments.length], [1, 1, 1, 1], 'uma vez só');
    assert.equal(nadaPendente(pc2, a2), 0, 'e não volta para o PC 1');
    // os dois lados acrescentam sem ter recebido o do outro: une, sem conflito para decidir
    const cm2 = (await req(pc2, 'POST', `/api/tasks/${t}/comments`, a2, { body: 'Eu levo as plantas no carro.' })).json.id as string;
    await req(pc2, 'PATCH', `/api/subtasks/${sub}`, a2, { done: true });
    const sub1 = (await req(pc1, 'POST', `/api/tasks/${t}/subtasks`, a1, { title: 'Desmontar a cama' })).json.id as string;
    const r = await levar([pc2, a2], [pc1, a1]);
    assert.equal(r.recebido.conflicts, 0);
    await levar([pc1, a1], [pc2, a2]);
    for (const [h, s] of [[pc1, a1], [pc2, a2]] as Array<[Harness, Session]>) {
      const c = await cartao(h, s, t);
      assert.deepEqual(c.comments.map((x) => x.id), [cm, cm2], 'os dois comentários, uma vez cada');
      assert.deepEqual(c.subtasks.map((x) => [x.id, x.done]), [[sub, true], [sub1, false]], 'a subtarefa marcada lá e a criada aqui');
    }
    // apagar num lado some no outro e não volta
    assert.equal((await req(pc1, 'DELETE', `/api/tasks/${t}/comments/${cm}`, a1)).status, 200);
    assert.equal((await req(pc1, 'DELETE', `/api/subtasks/${sub1}`, a1)).status, 200);
    await levar([pc1, a1], [pc2, a2]);
    c2 = await cartao(pc2, a2, t);
    assert.deepEqual([c2.comments.map((x) => x.id), c2.subtasks.map((x) => x.id)], [[cm2], [sub]]);
    await levar([pc2, a2], [pc1, a1]);
    assert.deepEqual((await cartao(pc1, a1, t)).comments.map((x) => x.id), [cm2], 'o apagado não volta');
    assert.deepEqual([nadaPendente(pc1, a1), nadaPendente(pc2, a2)], [0, 0], 'assentou');
  });

  test('aparelho na versão anterior: o formato antigo continua aceito e o novo só acrescenta (nada do que o antigo confere mudou)', async () => {
    const b = (await req(pc1, 'POST', '/api/boards', a1, { name: 'Leituras', columns: ['Fila', 'Lendo'] })).json;
    const t = (await req(pc1, 'POST', '/api/tasks', a1, { title: 'Ler O Silmarillion', boardId: b.id, columnId: b.columns[1].id })).json.id as string;
    await req(pc1, 'POST', `/api/tasks/${t}/subtasks`, a1, { title: 'Ainulindalë' });
    const cs = new ContentSync(pc1.db);
    const partes = cs.chunks(cs.pending(a1.workspaceId, a1.userId));
    const corpo = partes[0].body;
    assert.ok(corpo.boards?.some((x) => x.id === b.id) && corpo.cards?.some((x) => x.id === t), 'quadro e cartão vão em campos novos do corpo');
    // o que a versão anterior confere (parseContent de antes): type, as três listas e, em cada tarefa, os campos de sempre
    assert.deepEqual([corpo.type, Array.isArray(corpo.tasks), Array.isArray(corpo.conversations), Array.isArray(corpo.messages)], ['content', true, true, true]);
    const nova = corpo.tasks.find((x) => x.id === t)!;
    assert.deepEqual([nova.audience, nova.column, nova.boardId, nova.columnId], ['user', 'Lendo', b.id, b.columns[1].id], 'audience e o nome da coluna continuam indo');
    const { boardId: _b, columnId: _c, ...antiga } = nova; // a mesma tarefa como um aparelho antigo a manda de volta, com o título mudado
    const semNovos = parseContent({ type: 'content', tasks: [{ ...antiga, title: 'Ler O Silmarillion (2ª vez)', updatedAt: new Date(Date.now() + 1000).toISOString() }], conversations: [], messages: [] });
    assert.ok(semNovos, 'formato antigo aceito');
    await levar([pc1, a1], [pc2, a2]);
    assert.deepEqual(onde(pc2, t), { board_id: b.id, column_id: b.columns[1].id });
    // a tarefa antiga chega ao PC 2 (que já a tem no quadro certo): muda o título e ela NÃO sai do quadro nem da coluna
    const n = new ContentSync(pc2.db).apply(a2.workspaceId, a2.userId, semNovos!, 'dev_antigo');
    assert.deepEqual([n.updated, n.conflicts], [1, 0]);
    assert.equal(tarefa(pc2, t)!.title, 'Ler O Silmarillion (2ª vez)');
    assert.deepEqual(onde(pc2, t), { board_id: b.id, column_id: b.columns[1].id }, 'continua no quadro e na coluna onde estava');
    assert.equal((await cartao(pc2, a2, t)).subtasks.length, 1, 'e o que vai dentro do cartão fica');
    // tarefa nova de um aparelho antigo: quadro de entrada, coluna pelo nome (como antes)
    const deFora = { ...antiga, id: `tsk_${'c'.repeat(32)}`, number: 9999, column: 'Fazendo', title: 'Veio do aparelho antigo' };
    assert.equal(new ContentSync(pc2.db).apply(a2.workspaceId, a2.userId, parseContent({ type: 'content', tasks: [deFora], conversations: [], messages: [] })!, 'dev_antigo').added, 1);
    const lugar = pc2.db.get<{ col: string; ent: number }>(`SELECT c.name AS col, t.board_id = (SELECT id FROM boards WHERE workspace_id = t.workspace_id AND origin = 'native' AND audience = 'user' ORDER BY created_at LIMIT 1) AS ent
      FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?`, deFora.id)!;
    assert.deepEqual([lugar.col, lugar.ent], ['Fazendo', 1]);
    // quadro ou cartão fora do formato recusa a mudança inteira
    const bom = corpo.boards!.find((x) => x.id === b.id)!; const cartaoBom = corpo.cards!.find((x) => x.id === t)!;
    assert.ok(parseContent({ type: 'content', tasks: [], conversations: [], messages: [], boards: [bom], cards: [cartaoBom] }));
    for (const ruim of [{ ...bom, id: '../x' }, { ...bom, columns: [{ id: 'col_x', name: 'a', key: null }] }, { ...bom, fields: [{ id: `cmp_${'a'.repeat(32)}`, name: 'x', type: 'script', options: [], show: false, at: bom.updatedAt }] }])
      assert.equal(parseContent({ type: 'content', tasks: [], conversations: [], messages: [], boards: [ruim] }), null, JSON.stringify(ruim).slice(0, 80));
    const at = new Date().toISOString(); const hex = 'd'.repeat(32);
    for (const ruim of [
      { ...cartaoBom, links: [{ id: `url_${hex}`, url: 'javascript:alert(1)', title: '', at }] },
      { ...cartaoBom, comments: [{ id: `cmt_${hex}`, by: 'user', name: 'x', me: false, body: 'y'.repeat(241), at }] },
      { ...cartaoBom, subtasks: [{ id: 'sub_curto', title: 'x', done: false, pos: 0, at }] },
    ]) assert.equal(parseContent({ type: 'content', tasks: [], conversations: [], messages: [], cards: [ruim] }), null, JSON.stringify(ruim).slice(-90));
  });

  test('conteúdo fora do formato é recusado inteiro; a tarefa sem origem remota é a que roda', () => {
    const ok = { id: 'tsk_0123456789abcdef', number: 1, audience: 'team', column: 'A fazer', agent: null, title: 'x', description: '', purpose: null, origin: 'manual',
      completed: false, completedAt: null, completedBy: null, archived: false, dueOn: null, priority: 0, workState: null, conversationId: null, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' };
    assert.ok(parseContent({ type: 'content', tasks: [ok], conversations: [], messages: [] }));
    for (const ruim of [{ ...ok, workState: 'hackear' }, { ...ok, origin: 'mirror' }, { ...ok, id: '../x' }, { ...ok, title: 'y'.repeat(600) }, { ...ok, completed: 'sim' }])
      assert.equal(parseContent({ type: 'content', tasks: [ok, ruim], conversations: [], messages: [] }), null, JSON.stringify(ruim).slice(0, 60));
    assert.equal(parseContent({ type: 'content', tasks: [], conversations: [], messages: [{ id: 'msg_0123456789abcdef', conversationId: 'cnv_0123456789abcdef', role: 'admin', content: 'x', mode: 'local', createdAt: '2026-10-27' }] }), null);
    pc2.db.run('UPDATE tasks SET sync_origin = NULL WHERE id = ?', tarefaId);
    assert.notEqual(pc2.teamwork.next(a2.workspaceId), null);
  });
});
