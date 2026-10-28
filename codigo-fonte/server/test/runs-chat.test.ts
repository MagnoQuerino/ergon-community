import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { Bus } from '../src/services/bus.ts';
import { HermesError, type HermesClient, type RemoteRun } from '../src/services/hermes.ts';
import { RunExecutor } from '../src/services/runs.ts';
import { drain, harness, req, setupOwner, testConfig, type Harness, type Session } from './helpers.ts';

async function newConv(h: Harness, s: Session, agentIndex = 0): Promise<string> {
  const st = (await req(h, 'GET', '/api/state', s)).json;
  return (await req(h, 'POST', '/api/conversations', s, { agentId: st.agents[agentIndex].id })).json.id;
}

describe('fila de execuções com concorrência limitada', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness({ maxConcurrentRuns: 2, simulatedDelayMs: 30 }); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('6 conversas em paralelo: conversa não entra no limite de processos (teto 2), todas andam juntas e terminam', async () => {
    const convs = [];
    for (let i = 0; i < 6; i++) convs.push(await newConv(h, s, i));
    await Promise.all(convs.map((c, i) => req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: `pedido ${i}`, clientRequestId: `req-conc-000${i}` })));
    await h.executor.tick();
    const active = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'waiting_user')")!;
    assert.equal(Number(active.n), 6, 'nenhuma conversa espera outra (antes: no máximo 2, e a terceira esperava)');
    for (let i = 0; i < 40; i++) {
      await h.executor.tick();
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(h.executor.maxObservedProcesses, 0, 'conversa não é processo');
    const left = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('succeeded')")!;
    assert.equal(Number(left.n), 0);
  });

  test('cancelar execução enfileirada', async () => {
    const c = await newConv(h, s, 7);
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'algo', clientRequestId: 'req-cancel-0001' })).json;
    const r = (await req(h, 'POST', `/api/runs/${sent.runId}/cancel`, s)).json;
    assert.equal(r.status, 'cancelled');
  });

  test('estado traz o último desfecho de cada agente (usado nas reações da cena)', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const byIndex = (i: number) => st.agents.find((a: { id: string }) => a.id === st.agents[i].id);
    assert.match(String(byIndex(0).last_outcome), /^succeeded\|\d{4}-/, 'concluída com sucesso, com horário');
    assert.match(String(byIndex(7).last_outcome), /^cancelled\|/, 'a cancelada aparece como cancelada');
    assert.equal(byIndex(8).last_outcome, null, 'sem execução encerrada = null');
  });

  test('limite diário de execuções', async () => {
    const h2 = await harness({ dailyRunLimit: 1 });
    const s2 = await setupOwner(h2);
    const c = await newConv(h2, s2);
    assert.equal((await req(h2, 'POST', `/api/conversations/${c}/messages`, s2, { text: 'um', clientRequestId: 'req-limit-0001' })).status, 201);
    await drain(h2);
    const r = await req(h2, 'POST', `/api/conversations/${c}/messages`, s2, { text: 'dois', clientRequestId: 'req-limit-0002' });
    assert.equal(r.status, 429);
    await h2.close();
  });
});

describe('chat: interpretação e política por perfil', () => {
  let h: Harness;
  let s: Session;
  let central: string;
  let brainstorm: string;
  before(async () => {
    h = await harness();
    s = await setupOwner(h);
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const helena = st.agents.find((a: { name: string }) => a.name === 'Aristóteles');
    const nikos = st.agents.find((a: { name: string }) => a.name === 'Hipátia');
    central = (await req(h, 'POST', '/api/conversations', s, { agentId: helena.id })).json.id;
    brainstorm = (await req(h, 'POST', '/api/conversations', s, { agentId: nikos.id })).json.id;
  });
  after(async () => { await h.close(); });

  const say = async (conv: string, text: string, rid: string) => {
    const r = await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text, clientRequestId: rid });
    await drain(h, 3);
    return r;
  };
  const taskCount = () => Number(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n);

  test('central: demanda clara vira o plano da coordenação (um card); agradecimento não', async () => {
    // o pedido não vira card por regras: a coordenação planeja (sem modelo, o plano sai das regras de encaminhamento)
    const before = taskCount();
    await say(central, 'Preciso que alguém prepare o relatório trimestral de despesas', 'req-chat-0001');
    assert.equal(taskCount(), before + 1);
    assert.ok(h.db.get('SELECT 1 AS x FROM task_steps LIMIT 1'), 'o card nasce com as etapas');
    await say(central, 'obrigado', 'req-chat-0002');
    assert.equal(taskCount(), before + 1);
  });

  test('a execução do agente recebe o que o sistema já aplicou (não repropõe card criado)', async () => {
    const r = await req(h, 'POST', `/api/conversations/${central}/messages`, s, { text: '/tarefa organizar a pauta da reunião de diretoria', clientRequestId: 'req-chat-ctx1' });
    const run = h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE id = ?', r.json.runId)!;
    assert.match(run.instructions, /Ação já aplicada pelo sistema para esta mensagem .*Tarefa #\d+ criada: organizar a pauta/);
    await drain(h, 3);
  });

  test('brainstorm: ideia e demanda implícita não criam tarefa; pedido explícito cria', async () => {
    const before = taskCount();
    await say(brainstorm, 'E se fizermos um evento aberto em março?', 'req-chat-0003');
    await say(brainstorm, 'Precisamos pensar em nomes para o produto novo', 'req-chat-0004');
    assert.equal(taskCount(), before);
    await say(brainstorm, 'Crie uma tarefa: pesquisar locais para o evento', 'req-chat-0005');
    assert.equal(taskCount(), before + 1);
  });

  test('correção altera o card; "a partir de agora" só PROPÕE regra', async () => {
    const t = h.db.all<{ number: number; id: string; title: string }>('SELECT number, id, title FROM tasks').find((x) => x.title.includes('relatório trimestral'))!;
    await say(central, `Corrija a tarefa #${t.number} para "Relatório trimestral de despesas (Q3)"`, 'req-chat-0006');
    const after1 = h.db.get<{ title: string; revision: number }>('SELECT title, revision FROM tasks WHERE id = ?', t.id)!;
    assert.equal(after1.title, 'Relatório trimestral de despesas (Q3)');
    await say(central, 'A partir de agora, todo relatório deve ter um resumo executivo', 'req-chat-0007');
    const rules = (await req(h, 'GET', '/api/rules', s)).json;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].status, 'proposed');
    assert.equal(h.db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', t.id)!.title, after1.title);
  });

  test('reenvio com o mesmo clientRequestId não duplica mensagem nem execução', async () => {
    const r1 = await req(h, 'POST', `/api/conversations/${central}/messages`, s, { text: 'teste idempotente', clientRequestId: 'req-chat-dup1' });
    const r2 = await req(h, 'POST', `/api/conversations/${central}/messages`, s, { text: 'teste idempotente', clientRequestId: 'req-chat-dup1' });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.replayed, true);
    assert.equal(r2.json.runId, r1.json.runId);
  });

  test('conversa ocupada recusa nova mensagem até terminar', async () => {
    const r = await req(h, 'POST', `/api/conversations/${central}/messages`, s, { text: 'outra', clientRequestId: 'req-chat-busy' });
    assert.equal(r.status, 409);
    await drain(h, 3);
    const ok = await req(h, 'POST', `/api/conversations/${central}/messages`, s, { text: 'outra', clientRequestId: 'req-chat-busy2' });
    assert.equal(ok.status, 201);
  });

  test('delegar tarefa a agente usa a mesma fila e registra resultado no log da tarefa', async () => {
    await drain(h, 3);
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const t = h.db.get<{ id: string }>('SELECT id FROM tasks ORDER BY number LIMIT 1')!;
    const r = await req(h, 'POST', `/api/tasks/${t.id}/delegate`, s, { agentId: st.agents[2].id, instruction: 'sugira próximo passo', requestId: 'req-deleg-0001' });
    assert.equal(r.status, 202);
    await drain(h, 3);
    const log = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.log as Array<{ action: string; evidence: string }>;
    const res = log.find((e) => e.action === 'agent.result.succeeded');
    assert.ok(res);
    assert.match(res!.evidence, /simulated/);
    // subtarefa não cria habitante
    assert.equal((await req(h, 'GET', '/api/capacity', s)).json.active, 12);
  });
});

class FakeHermes implements HermesClient {
  started: Array<{ idempotencyKey: string; sessionKey: string }> = [];
  runs = new Map<string, RemoteRun>();
  stops: string[] = [];
  lose = false;
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: { input: string; instructions: string; sessionKey: string; idempotencyKey: string }) {
    const prev = this.started.find((x) => x.idempotencyKey === p.idempotencyKey);
    this.started.push({ idempotencyKey: p.idempotencyKey, sessionKey: p.sessionKey });
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 24)}`;
    if (!prev) this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: 'sess', usage: null });
    return { runId, replayed: !!prev };
  }
  async getRun(id: string): Promise<RemoteRun> {
    if (this.lose) throw new HermesError(404, 'not found');
    const r = this.runs.get(id);
    if (!r) throw new HermesError(404, 'not found');
    return r;
  }
  async stop(id: string) { this.stops.push(id); const r = this.runs.get(id); if (r) r.status = 'cancelled'; return { accepted: true, detail: 'stopping' }; }
}

describe('executor Hermes (cliente falso que segue o contrato documentado)', () => {
  test('sessão isolada, idempotência, uso real/ausente, parada e perda após reinício', async () => {
    const fake = new FakeHermes();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: fake });
    const s = await setupOwner(h);
    const c = await newConv(h, s);
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-herm-0001' })).json;
    await h.executor.tick(); // admite
    await h.executor.tick(); // inicia no Hermes
    assert.equal(fake.started.length, 1);
    assert.match(fake.started[0].sessionKey, new RegExp(`^ergon:${s.workspaceId}:conv:${c}:agent:`));
    const run = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', sent.runId)!;
    fake.runs.set(run.hermes_run_id, { status: 'completed', output: 'Resposta real do modelo', error: null, sessionId: 'sess', usage: { inputTokens: 12, outputTokens: 7, costUsd: null } });
    await h.executor.tick();
    const done = h.db.get<{ status: string; tokens_in: number; cost_usd: number | null; mode: string }>('SELECT status, tokens_in, cost_usd, mode FROM runs WHERE id = ?', sent.runId)!;
    assert.equal(done.status, 'succeeded');
    assert.equal(done.mode, 'real');
    assert.equal(done.tokens_in, 12);
    assert.equal(done.cost_usd, null, 'custo ausente não vira zero');
    const msgs = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json as Array<{ role: string; mode: string; content: string }>;
    assert.ok(msgs.some((m) => m.role === 'agent' && m.mode === 'real' && m.content === 'Resposta real do modelo'));

    // cancelamento envia stop e registra estado verdadeiro
    const sent2 = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Outra', clientRequestId: 'req-herm-0002' })).json;
    await h.executor.tick(); await h.executor.tick();
    await req(h, 'POST', `/api/runs/${sent2.runId}/cancel`, s);
    await h.executor.tick(); await h.executor.tick();
    const r2 = h.db.get<{ status: string; error: string }>('SELECT status, error FROM runs WHERE id = ?', sent2.runId)!;
    assert.equal(r2.status, 'cancelled');
    assert.match(r2.error, /efeitos já realizados permanecem/);
    assert.equal(fake.stops.length, 1);

    // reinício: novo executor sobre o mesmo banco retoma lease expirado; Hermes perdeu a execução → falha honesta, sem repetir
    const sent3 = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Terceira', clientRequestId: 'req-herm-0003' })).json;
    await h.executor.tick(); await h.executor.tick();
    const startsBefore = fake.started.length;
    h.db.run("UPDATE runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", sent3.runId);
    fake.lose = true;
    const ex2 = new RunExecutor(h.db, new Bus(), h.cfg, fake);
    await ex2.tick();
    const r3 = h.db.get<{ status: string; error: string }>('SELECT status, error FROM runs WHERE id = ?', sent3.runId)!;
    assert.equal(r3.status, 'failed');
    assert.match(r3.error, /Resultado desconhecido/);
    assert.equal(fake.started.length, startsBefore, 'nenhuma nova execução remota criada');
    await h.close();
  });

  test('reinício antes de o Hermes confirmar: reenvio usa a MESMA chave idempotente', async () => {
    const fake = new FakeHermes();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: fake });
    const s = await setupOwner(h);
    const c = await newConv(h, s);
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-herm-0010' })).json;
    await h.executor.tick(); await h.executor.tick();
    // simula queda depois do POST remoto e antes de gravar o run_id
    h.db.run("UPDATE runs SET hermes_run_id = NULL, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", sent.runId);
    const ex2 = new RunExecutor(h.db, new Bus(), h.cfg, fake);
    await ex2.tick();
    assert.equal(fake.started.length, 2);
    assert.equal(fake.started[0].idempotencyKey, fake.started[1].idempotencyKey);
    assert.equal(fake.runs.size, 1, 'uma única execução remota');
    await h.close();
  });

  test('tempo limite marca falha e solicita parada', async () => {
    const fake = new FakeHermes();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', runTimeoutSeconds: 5 }, { hermes: fake });
    const s = await setupOwner(h);
    const c = await newConv(h, s);
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-herm-0020' })).json;
    await h.executor.tick(); await h.executor.tick();
    h.db.run("UPDATE runs SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", sent.runId);
    await h.executor.tick();
    const r = h.db.get<{ status: string; error: string }>('SELECT status, error FROM runs WHERE id = ?', sent.runId)!;
    assert.equal(r.status, 'failed');
    assert.match(r.error, /tempo limite/);
    assert.equal(fake.stops.length, 1);
    await h.close();
  });

  test('imagem gerada pelo agente chega ao Ergon: guardada em Arquivos e mostrada na conversa (antes, só o caminho dentro do motor)', async () => {
    const fake = new FakeHermes();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: fake });
    const s = await setupOwner(h);
    const fid = h.db.get<{ id: string }>("SELECT id FROM agents WHERE char_key = 'fidias'")!.id;
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: fid })).json.id as string;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 1)]);
    const asked: string[] = [];
    h.executor.media = async (p) => { asked.push(p); if (p.includes('quebrada')) throw new Error('não achou'); return { data: png, mime: 'image/png' }; };
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Crie a imagem do logo', clientRequestId: 'req-img-0001' })).json;
    await h.executor.tick(); await h.executor.tick();
    const remote = [...fake.runs.values()][0];
    remote.status = 'completed';
    remote.output = 'Pronto, uma imagem.\n\nMEDIA:/opt/data/cache/generated/images/krea_logo.png\n\nOutra: MEDIA:/opt/data/cache/generated/images/quebrada.png\nE fora da pasta: MEDIA:/opt/data/auth.json';
    await h.executor.tick();
    assert.deepEqual(asked, ['/opt/data/cache/generated/images/krea_logo.png', '/opt/data/cache/generated/images/quebrada.png'], 'só imagens da pasta das geradas');
    const msg = (await req(h, 'GET', `/api/conversations/${c}/messages`, s)).json.find((m: { role: string }) => m.role === 'agent').content as string;
    const id = msg.match(/\[imagem: (art_[a-f0-9]{32})\]/)?.[1];
    assert.ok(id, msg);
    assert.match(msg, /imagem gerada pelo motor de IA, mas o Ergon não conseguiu trazê-la/, 'a que falhou é dita, não some');
    assert.match(msg, /MEDIA:\/opt\/data\/auth\.json/, 'o que não é imagem gerada não é buscado');
    const art = h.db.get<{ filename: string; mime: string }>('SELECT filename, mime FROM artifacts WHERE id = ?', id)!;
    assert.match(art.filename, /^imagem-fidias-\d{4}-\d{2}-\d{2}-1\.png$/); assert.equal(art.mime, 'image/png');
    const dl = await req(h, 'GET', `/api/artifacts/${id}/download`, s);
    assert.equal(dl.status, 200); assert.equal(dl.res.headers['content-type'], 'image/png');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', sent.runId)!.status, 'succeeded');
    await h.close();
  });

  test('quem pesquisa na web ganha o tempo limite longo (a pesquisa de um site passa dos 180 s)', async () => {
    const fake = new FakeHermes();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', runTimeoutSeconds: 5, longRunTimeoutSeconds: 600, maxConcurrentRuns: 2 }, { hermes: fake });
    const s = await setupOwner(h);
    const hip = h.db.get<{ id: string }>("SELECT id FROM agents WHERE char_key = 'hipatia'")!.id;
    const dio = h.db.get<{ id: string }>("SELECT id FROM agents WHERE char_key = 'diogenes'")!.id;
    const conv = async (agentId: string) => (await req(h, 'POST', '/api/conversations', s, { agentId })).json.id as string;
    const send = async (c: string, key: string) => (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Sobre o que é a empresa do site exemplo.com?', clientRequestId: key })).json.runId as string;
    const pesquisa = await send(await conv(hip), 'req-herm-long-1');
    const pratica = await send(await conv(dio), 'req-herm-long-2');
    await h.executor.tick(); await h.executor.tick();
    // os dois começaram há 1 minuto: passou dos 5 s normais, longe dos 600 s de quem pesquisa
    h.db.run('UPDATE runs SET started_at = ? WHERE id IN (?, ?)', new Date(Date.now() - 60_000).toISOString(), pesquisa, pratica);
    await h.executor.tick();
    const st = (id: string) => h.db.get<{ status: string; error: string | null }>('SELECT status, error FROM runs WHERE id = ?', id)!;
    assert.equal(st(pratica).status, 'failed'); assert.match(st(pratica).error ?? '', /tempo limite de 5s/);
    assert.equal(st(pesquisa).status, 'running', 'a pesquisa segue: o limite dela é o longo');
    h.db.run("UPDATE runs SET started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", pesquisa);
    await h.executor.tick();
    assert.equal(st(pesquisa).status, 'failed'); assert.match(st(pesquisa).error ?? '', /tempo limite de 600s/);
    await h.close();
  });

  test('sem Hermes configurado em modo hermes: falha verdadeira, não simulação silenciosa', async () => {
    const h = await harness({ executor: 'hermes' }, { hermes: null });
    const s = await setupOwner(h);
    const c = await newConv(h, s);
    const sent = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-herm-0030' })).json;
    await drain(h, 3);
    const r = h.db.get<{ status: string; error: string; mode: string }>('SELECT status, error, mode FROM runs WHERE id = ?', sent.runId)!;
    assert.equal(r.mode, 'real');
    assert.equal(r.status, 'failed');
    await h.close();
  });
});

describe('Db', () => {
  test('migrations são idempotentes', () => {
    const cfg = testConfig(':memory:');
    const db = new Db(':memory:');
    assert.ok(db.migrate().length >= 1);
    assert.equal(db.migrate().length, 0);
    db.close();
    assert.ok(cfg);
  });
});
