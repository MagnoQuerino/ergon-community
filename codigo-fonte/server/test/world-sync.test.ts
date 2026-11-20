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
