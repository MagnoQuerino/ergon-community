/**
 * Robustez da sincronia com o Ergon World (rc.41): dois computadores da mesma pessoa contra o World de mentira, cada
 * volta feita pelo mesmo caminho do ciclo automático ("sincronizar agora": entrega a chave, recebe, envia). O ciclo de
 * um minuto fica desligado aqui para cada passo acontecer na hora que o teste manda.
 *  - dois aparelhos editando alternadamente por várias rodadas: convergem, sem conflito, sem eco e sem duplicar;
 *  - queda no meio do envio (a resposta do World se perde): o reenvio não duplica, nem direto nem depois de receber;
 *  - aparelho novo entra com dados grandes, em várias páginas e várias partes;
 *  - giro de chave no meio: quem tinha edições por enviar pega a chave nova e envia; o histórico de antes continua legível;
 *  - giro com a resposta perdida: a chave nova não se perde (ficaria um workspace que ninguém abre);
 *  - envio recusado porque outro aparelho mudou antes não fica se repetindo: a volta seguinte recebe e envia.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld; let pc1: Harness; let a1: Session; let pc2: Harness; let a2: Session; let pc3: Harness; let a3: Session; let sws = '';
const FRASE = 'frase de recuperação do sync da ana para a robustez';
const ENV = ['ERGON_WORLD_URL', 'ERGON_WORLD_AUTOSYNC'];
const antes = new Map(ENV.map((k) => [k, process.env[k]]));
before(async () => { world = await new FakeWorld().start(); Object.assign(process.env, { ERGON_WORLD_URL: world.url, ERGON_WORLD_AUTOSYNC: '0' }); });
after(async () => {
  await pc1?.close(); await pc2?.close(); await pc3?.close(); await world.stop();
  for (const [k, v] of antes) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const W = () => world.workspaces.get(sws)!;
const agora = async (h: Harness, s: Session) => { const r = await req(h, 'POST', '/api/world/sync/now', s, {}); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const escrever = (h: Harness, s: Session, conv: string, idMsg: string, texto: string, quando = new Date().toISOString()) =>
  h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at) VALUES (?, ?, ?, 'user', ?, ?, 'local', ?)", idMsg, s.workspaceId, conv, s.userId, h.db.seal(s.workspaceId, texto), quando);
const mensagens = (h: Harness, conv: string) => h.db.all<{ id: string; content: string }>('SELECT id, content FROM messages WHERE conversation_id = ? ORDER BY id', conv);
const titulo = (h: Harness, id: string) => h.db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', id)?.title;
const conflitos = (h: Harness, s: Session) => Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM world_sync_conflicts WHERE workspace_id = ?', s.workspaceId)!.n);
const idMsg = (p: string, n: number) => `msg_${p}${String(n).padStart(16 - p.length, '0')}`;
let tarefa = ''; let conversa = '';

test('dois computadores ligados ao mesmo workspace World', async () => {
  pc1 = await harness(); a1 = await setupOwner(pc1, 'ana', 'senha-da-ana-123');
  assert.equal((await req(pc1, 'POST', '/api/world/connect', a1, { mode: 'signup', email: 'ana@exemplo.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
  sws = (await req(pc1, 'POST', '/api/world/bind', a1, {})).json.syncWorkspaceId as string;
  assert.equal((await req(pc1, 'POST', '/api/world/sync/enable', a1, { recoveryPhrase: FRASE })).status, 200);
  world.activate(sws);
  assert.equal((await req(pc1, 'POST', '/api/agents', a1, { name: 'Frodo', role: 'Pesquisa de campo' })).status, 201);
  const frodo = pc1.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND name = 'Frodo'", a1.workspaceId)!.id;
  tarefa = (await req(pc1, 'POST', '/api/tasks', a1, { title: 'Rodada 0', description: 'Vai e volta', agentId: frodo })).json.id;
  conversa = (await req(pc1, 'POST', '/api/conversations', a1, { agentId: frodo, title: 'Diário da viagem' })).json.id;
  await agora(pc1, a1);
  pc2 = await harness(); a2 = await setupOwner(pc2, 'ana-notebook', 'senha-do-notebook-123');
  assert.equal((await req(pc2, 'POST', '/api/world/connect', a2, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
  assert.equal((await req(pc2, 'POST', '/api/world/bind', a2, { syncWorkspaceId: sws })).status, 200);
  // a volta do computador principal entrega a chave ao notebook (sem frase, sem botão)
  await agora(pc1, a1);
  assert.equal((await req(pc2, 'POST', '/api/world/sync/join', a2, {})).status, 200);
  // a equipe do outro computador fica retida para a pessoa ver; ela recebe pela tela
  const st = await agora(pc2, a2);
  assert.equal(titulo(pc2, tarefa), undefined, 'com equipe nova retida, nada entra sozinho');
  assert.equal(st.lastVersion, 0);
  assert.equal((await req(pc2, 'POST', '/api/world/sync/pull', a2, { apply: true })).json.applied, true);
  assert.equal(titulo(pc2, tarefa), 'Rodada 0');
  await agora(pc2, a2); await agora(pc1, a1);
});

test('edição alternada por várias rodadas: converge, sem conflito, sem eco, sem duplicar', async () => {
  const lados: Array<[Harness, Session, string]> = [[pc1, a1, 'pca'], [pc2, a2, 'pcb']];
  for (let rodada = 1; rodada <= 8; rodada++) {
    const [h, s, p] = lados[rodada % 2]; const [o, os] = lados[(rodada + 1) % 2];
    assert.equal((await req(h, 'PATCH', `/api/tasks/${tarefa}`, s, { title: `Rodada ${rodada}` })).status, 200);
    escrever(h, s, conversa, idMsg(p, rodada), `nota ${rodada} de ${p}`);
    // o outro lado também escreve uma mensagem na mesma rodada (mensagens só se somam)
    escrever(o, os, conversa, idMsg(p === 'pca' ? 'pcb' : 'pca', 100 + rodada), `eco ${rodada}`);
    await agora(h, s); await agora(o, os); await agora(h, s);
    assert.deepEqual([titulo(pc1, tarefa), titulo(pc2, tarefa)], [`Rodada ${rodada}`, `Rodada ${rodada}`]);
    assert.deepEqual([conflitos(pc1, a1), conflitos(pc2, a2)], [0, 0], `rodada ${rodada}`);
  }
  assert.deepEqual(mensagens(pc1, conversa), mensagens(pc2, conversa));
  assert.equal(mensagens(pc1, conversa).length, 16);
  // nada ecoa: com tudo igual dos dois lados, mais voltas não geram mudança nenhuma no World
  const head = W().head;
  for (let i = 0; i < 3; i++) { await agora(pc1, a1); await agora(pc2, a2); }
  assert.equal(W().head, head);
  // nenhuma mensagem foi enviada duas vezes ao World (cada id aparece em uma só mudança de cada aparelho)
  assert.equal(new Set(W().changes.map((c) => c.operationId)).size, W().changes.length);
});

test('os dois mudam a mesma tarefa antes de sincronizar: vira conflito para decidir, sem laço; resolvido, some dos dois lados', async () => {
  assert.equal((await req(pc1, 'PATCH', `/api/tasks/${tarefa}`, a1, { title: 'Versão do PC' })).status, 200);
  assert.equal((await req(pc2, 'PATCH', `/api/tasks/${tarefa}`, a2, { title: 'Versão do notebook' })).status, 200);
  await agora(pc1, a1); await agora(pc2, a2);
  assert.deepEqual([conflitos(pc1, a1), conflitos(pc2, a2)], [0, 1]);
  // enquanto a pessoa não decide, as voltas não ficam mandando e voltando a mesma tarefa
  const head = W().head;
  for (let i = 0; i < 3; i++) { await agora(pc1, a1); await agora(pc2, a2); }
  assert.equal(W().head, head, 'o registro em conflito espera a decisão');
  assert.deepEqual([titulo(pc1, tarefa), titulo(pc2, tarefa)], ['Versão do PC', 'Versão do notebook']);
  const c = (await req(pc2, 'GET', '/api/world/sync/conflicts', a2)).json as Array<{ id: string }>;
  assert.equal((await req(pc2, 'POST', `/api/world/sync/conflicts/${c[0].id}`, a2, { keep: 'mine' })).status, 200);
  await agora(pc2, a2); await agora(pc1, a1); await agora(pc2, a2);
  assert.deepEqual([titulo(pc1, tarefa), titulo(pc2, tarefa), conflitos(pc1, a1), conflitos(pc2, a2)], ['Versão do notebook', 'Versão do notebook', 0, 0]);
  const fim = W().head;
  await agora(pc1, a1); await agora(pc2, a2);
  assert.equal(W().head, fim);
});

test('queda no meio do envio (a resposta se perde): reenviar direto não duplica', async () => {
  escrever(pc1, a1, conversa, idMsg('qda', 1), 'enviada com a resposta perdida');
  const head = W().head;
  world.dropResponse = /^POST \/v1\/sync\/workspaces\/sws_[a-f0-9]{32}\/changes$/;
  const caiu = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
  assert.deepEqual([caiu.status, caiu.json.error], [503, 'world_offline']);
  assert.equal(W().head, head + 1, 'o World gravou; este computador não soube');
  // a pessoa (ou o encerramento) tenta de novo do mesmo ponto: o World reconhece a operação e devolve o mesmo recibo
  const de = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
  assert.deepEqual([de.status, de.json.version], [200, head + 1]);
  assert.equal(W().head, head + 1, 'nada gravado de novo');
  assert.equal((await req(pc1, 'POST', '/api/world/sync/push', a1, {})).json.sent.messages, 0);
  await agora(pc2, a2);
  assert.equal(mensagens(pc2, conversa).filter((m) => m.content === 'enviada com a resposta perdida').length, 1);
});

test('queda no meio do envio e a volta seguinte recebe antes de enviar: também não duplica', async () => {
  escrever(pc1, a1, conversa, idMsg('qdb', 1), 'perdida e achada ao receber');
  assert.equal((await req(pc1, 'PATCH', `/api/tasks/${tarefa}`, a1, { title: 'Mudou junto com a queda' })).status, 200);
  const head = W().head;
  world.dropResponse = /^POST \/v1\/sync\/workspaces\/sws_[a-f0-9]{32}\/changes$/;
  const r = await req(pc1, 'POST', '/api/world/sync/now', a1, {});
  assert.equal(r.status, 503);
  assert.equal(W().head, head + 1);
  // o notebook recebe e envia uma coisa dele no meio (a versão do World anda)
  escrever(pc2, a2, conversa, idMsg('qdc', 1), 'do notebook, no meio');
  await agora(pc2, a2);
  assert.equal(W().head, head + 2);
  // a volta seguinte do PC: recebe (vê a própria mudança lá), marca como enviada e não manda de novo
  await agora(pc1, a1);
  assert.equal(W().head, head + 2, 'a mesma parte não entrou duas vezes no histórico');
  await agora(pc2, a2); await agora(pc1, a1);
  assert.equal(W().head, head + 2);
  assert.deepEqual(mensagens(pc1, conversa), mensagens(pc2, conversa));
  assert.deepEqual([titulo(pc1, tarefa), titulo(pc2, tarefa), conflitos(pc1, a1), conflitos(pc2, a2)], ['Mudou junto com a queda', 'Mudou junto com a queda', 0, 0]);
});

test('envio recusado porque outro aparelho mudou antes: a volta seguinte recebe e envia (não repete a recusa para sempre)', async () => {
  escrever(pc2, a2, conversa, idMsg('vca', 1), 'o notebook chegou antes');
  await agora(pc2, a2);
  escrever(pc1, a1, conversa, idMsg('vcb', 1), 'o PC enviou sem receber');
  const recusa = await req(pc1, 'POST', '/api/world/sync/push', a1, {});
  assert.deepEqual([recusa.status, recusa.json.error], [409, 'version_conflict']);
  await agora(pc1, a1); await agora(pc2, a2);
  assert.deepEqual(mensagens(pc1, conversa), mensagens(pc2, conversa));
  assert.ok(mensagens(pc2, conversa).some((m) => m.content === 'o PC enviou sem receber'));
});

test('giro de chave no meio: quem tinha edições por enviar pega a chave nova, envia, e todos leem o que veio antes e depois', async () => {
  escrever(pc2, a2, conversa, idMsg('gra', 1), 'escrita antes do giro, enviada depois');
  assert.equal((await req(pc2, 'PATCH', `/api/tasks/${tarefa}`, a2, { title: 'Editada no notebook durante o giro' })).status, 200);
  escrever(pc1, a1, conversa, idMsg('grb', 1), 'do PC, com a chave velha');
  await agora(pc1, a1);
  const giro = await req(pc1, 'POST', '/api/world/sync/rotate', a1, { recoveryPhrase: FRASE });
  assert.deepEqual([giro.status, giro.json.rotated, giro.json.keyVersion], [200, true, 2]);
  escrever(pc1, a1, conversa, idMsg('grc', 1), 'do PC, com a chave nova');
  await agora(pc1, a1);
  // o notebook: a volta recebe (pega a chave nova no envelope que o PC entregou), lê o de antes e o de depois, e envia
  const st = await agora(pc2, a2);
  assert.deepEqual([st.keyVersion, st.auto], [2, null]);
  await agora(pc1, a1); await agora(pc2, a2);
  assert.deepEqual(mensagens(pc1, conversa), mensagens(pc2, conversa));
  for (const t of ['escrita antes do giro, enviada depois', 'do PC, com a chave velha', 'do PC, com a chave nova']) assert.ok(mensagens(pc1, conversa).some((m) => m.content === t) && mensagens(pc2, conversa).some((m) => m.content === t), t);
  assert.deepEqual([titulo(pc1, tarefa), titulo(pc2, tarefa), conflitos(pc1, a1), conflitos(pc2, a2)], ['Editada no notebook durante o giro', 'Editada no notebook durante o giro', 0, 0]);
});

test('giro com a resposta perdida: a chave nova não se perde (o computador a adota ao ver o próprio giro no World)', async () => {
  world.dropResponse = /^POST \/v1\/sync\/workspaces\/sws_[a-f0-9]{32}\/changes$/;
  const caiu = await req(pc1, 'POST', '/api/world/sync/rotate', a1, {});
  assert.equal(caiu.status, 503);
  assert.equal(W().keyVersion, 3, 'o World já exige a chave nova');
  assert.equal(pc1.db.get<{ v: number }>('SELECT key_version AS v FROM world_sync WHERE workspace_id = ?', a1.workspaceId)!.v, 2);
  // ninguém tem envelope da v3: sem a candidata guardada, este workspace nunca mais abriria
  escrever(pc1, a1, conversa, idMsg('grd', 1), 'depois do giro que caiu');
  const st = await agora(pc1, a1);
  assert.equal(st.keyVersion, 3);
  assert.equal(W().envelopes.get(pc1.db.get<{ d: string }>('SELECT device_id AS d FROM world_links WHERE user_id = ?', a1.userId)!.d)?.keyVersion, 3);
  await agora(pc1, a1); // entrega a chave nova ao notebook
  await agora(pc2, a2);
  assert.ok(mensagens(pc2, conversa).some((m) => m.content === 'depois do giro que caiu'));
  assert.equal(pc2.db.get<{ v: number }>('SELECT key_version AS v FROM world_sync WHERE workspace_id = ?', a2.workspaceId)!.v, 3);
  // pedir o giro de novo depois disso é um giro novo (v4), não a repetição do que caiu
  assert.equal((await req(pc1, 'POST', '/api/world/sync/rotate', a1, {})).json.keyVersion, 4);
  await agora(pc1, a1); await agora(pc2, a2);
});

test('aparelho novo entra com dados grandes: várias páginas do World e várias partes de 1 MB, tudo chega uma vez', async () => {
  // 80 voltas pequenas (o World entrega 50 mudanças por página) e uma volta com 5 MB de mensagens (várias partes)
  for (let i = 1; i <= 80; i++) { escrever(pc1, a1, conversa, idMsg('pag', i), `página ${i}`, new Date(Date.UTC(2026, 10, 21, 10, 0, i)).toISOString()); await agora(pc1, a1); }
  const grande = 'x'.repeat(90_000);
  for (let i = 1; i <= 55; i++) escrever(pc1, a1, conversa, idMsg('gde', i), `${i}:${grande}`, new Date(Date.UTC(2026, 10, 21, 11, 0, i)).toISOString());
  const head = W().head;
  await agora(pc1, a1);
  assert.ok(W().head - head >= 5, `em partes: ${W().head - head}`);
  assert.ok(W().changes.length > 100, 'mais de duas páginas');
  pc3 = await harness(); a3 = await setupOwner(pc3, 'ana-novo', 'senha-do-pc-novo-123');
  world.sessionLimit = 3;
  assert.equal((await req(pc3, 'POST', '/api/world/connect', a3, { mode: 'login', email: 'ana@exemplo.test', password: 'senha-do-world-123' })).status, 200);
  assert.equal((await req(pc3, 'POST', '/api/world/bind', a3, { syncWorkspaceId: sws })).status, 200);
  // a frase de recuperação ficou na chave de antes dos últimos giros: não abre a atual; a volta do computador principal
  // entrega a chave ao aparelho novo, que recebe o histórico inteiro (de todas as versões da chave)
  assert.equal((await req(pc3, 'POST', '/api/world/sync/join', a3, { recoveryPhrase: FRASE })).status, 404);
  await agora(pc1, a1);
  assert.equal((await req(pc3, 'POST', '/api/world/sync/join', a3, {})).status, 200);
  const r = await req(pc3, 'POST', '/api/world/sync/pull', a3, { apply: true });
  assert.deepEqual([r.status, r.json.applied, r.json.conflicts], [200, true, 0]);
  assert.equal(mensagens(pc3, conversa).length, mensagens(pc1, conversa).length);
  assert.deepEqual(mensagens(pc3, conversa).map((m) => m.id), mensagens(pc1, conversa).map((m) => m.id));
  assert.equal(mensagens(pc3, conversa).find((m) => m.id === idMsg('gde', 55))!.content.length, 90_003);
  assert.equal(titulo(pc3, tarefa), titulo(pc1, tarefa));
  // o aparelho novo não devolve o que acabou de receber
  const fim = W().head;
  await agora(pc3, a3); await agora(pc1, a1); await agora(pc2, a2); await agora(pc3, a3);
  assert.equal(W().head, fim);
  assert.equal(mensagens(pc2, conversa).length, mensagens(pc1, conversa).length);
});
