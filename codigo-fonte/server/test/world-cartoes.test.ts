/**
 * "Rodar na nuvem" (RC30 / 30.5H1) do lado do aplicativo, contra o World de mentira (fake-world.ts, com as regras de
 * world/src/handoffs.ts): local primeiro (cartão que nunca foi à nuvem não fala com o World), só o workspace ligado e
 * com plano, intenção estável, checksum do JSON canônico, aceite com CAS na geração, a fila daqui pula o cartão só
 * depois do aceite, resposta perdida resolvida pela consulta, posse trocada no meio fica local, selo no cartão,
 * resultado no mesmo cartão, trazer de volta só com o Job terminado, licença de efeito para cartão registrado. E o nome
 * do workspace no World.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { badgeOf, canonicalJson, CloudCards, feedPackage, packageChecksum } from '../src/world/cards.ts';
import { loadWorldConfig } from '../src/world/config.ts';
import { WorldClient, WorldLinks } from '../src/world/link.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let world: FakeWorld;
before(async () => {
  world = await new FakeWorld().start();
  process.env.ERGON_WORLD_URL = world.url;
  process.env.ERGON_WORLD_CARDS_MIN_MS = '0';
});
after(async () => { process.env.ERGON_WORLD_URL = ''; delete process.env.ERGON_WORLD_CARDS_MIN_MS; await world.stop(); });

describe('JSON canônico e pacote (o mesmo sha256 do World)', () => {
  test('vetores fixos', () => {
    assert.equal(canonicalJson({ b: 1, a: [3, { d: null, c: 'x' }], u: undefined }), '{"a":[3,{"c":"x","d":null}],"b":1}');
    assert.equal(canonicalJson({ z: { y: { x: true } }, 'á': 'ç' }), '{"z":{"y":{"x":true}},"á":"ç"}');
    assert.equal(canonicalJson([]), '[]'); assert.equal(canonicalJson('a"b'), '"a\\"b"'); assert.equal(canonicalJson(1.5), '1.5');
    assert.equal(packageChecksum({ urls: ['https://exemplo.test/feed.xml'], keywords: ['anvisa'] }), packageChecksum({ keywords: ['anvisa'], urls: ['https://exemplo.test/feed.xml'] }), 'a ordem das chaves não conta');
    assert.equal(packageChecksum({ keywords: ['anvisa'], urls: ['https://exemplo.test/feed.xml'] }), 'sha256:60cfe2e692999471a621262cf046031e8da5ecadde07d0d1140b8afabcf13643');
    assert.equal(packageChecksum({ a: 1 }), 'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
  test('pacote do radar: as buscas e os feeds que a rotina lê aqui (até 10)', () => {
    const p = feedPackage(['web.noticias'], { termos: ['cromatografia'], feeds: ['https://blog.exemplo.com/feed', 'http://inseguro.test/rss'] })!;
    assert.equal(p.urls.length, 2);
    assert.ok(p.urls[0].startsWith('https://news.google.com/rss/search?q=cromatografia'));
    assert.equal(p.urls[1], 'https://blog.exemplo.com/feed');
    assert.equal(feedPackage(['web.noticias'], {}), null);
    assert.deepEqual(['queued', 'admitted', 'waiting_balance', 'running', 'succeeded', 'failed'].map((x) => badgeOf(x)), ['na_fila', 'na_fila', 'na_fila', 'trabalhando', 'concluido', 'falhou']);
  });
});

describe('Rodar na nuvem', () => {
  let h: Harness; let s: Session; let sws = '';
  const handoffCalls = () => world.log.filter((x) => x.path.startsWith('/v1/jobs/handoffs') || x.path.startsWith('/v1/jobs/cards') || x.path.startsWith('/v1/jobs/heartbeats')).length;
  const radar = async (termo = 'cromatografia') => {
    const r = await req(h, 'POST', '/api/routines', s, { template: 'radar-noticias', params: { termos: [termo], feeds: ['https://blog.exemplo.com/feed'] } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { id: r.json.id as string, ref: `rotina:${r.json.id}` };
  };
  const card = async (ref: string) => {
    const r = await req(h, 'GET', `/api/world/cards?ref=${encodeURIComponent(ref)}`, s);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.cards[0];
  };
  const send = (ref: string) => req(h, 'POST', '/api/world/cards/send', s, { ref });
  const runsOf = (id: string) => h.db.all<{ status: string; summary: string | null; idempotency_key: string }>('SELECT status, summary, idempotency_key FROM routine_runs WHERE routine_id = ? ORDER BY created_at', id);

  test('sem o workspace ligado ao World: nada de nuvem e nenhum pedido ao World', async () => {
    h = await harness(); s = await setupOwner(h, 'ana', 'senha-local-123');
    const n0 = world.log.length;
    assert.deepEqual((await req(h, 'GET', '/api/world/cards', s)).json, { offer: false, stale: false, cards: [] });
    assert.equal(world.log.length, n0, 'sem conta: o World nem é chamado');
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email: 'ana@nuvem.test', password: 'senha-do-world-123', displayName: 'Ana' })).status, 200);
    assert.equal((await req(h, 'GET', '/api/world/cards', s)).json.offer, false, 'conectado, mas o workspace não está ligado');
    const { ref } = await radar();
    assert.equal((await send(ref)).json.error, 'world_not_bound');
    assert.equal(handoffCalls(), 0);
  });

  test('o workspace World nasce com o nome do local; renomear aqui renomeia lá; a lista mostra o nome', async () => {
    assert.equal((await req(h, 'PATCH', `/api/workspaces/${s.workspaceId}`, s, { name: 'Laboratório' })).status, 200);
    const b = await req(h, 'POST', '/api/world/bind', s, { workspaceId: s.workspaceId });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    sws = b.json.syncWorkspaceId;
    assert.deepEqual(world.log.find((x) => x.path === '/v1/sync/workspaces')!.body, { label: 'Laboratório' });
    assert.equal(world.workspaces.get(sws)!.label, 'Laboratório');
    assert.equal((await req(h, 'PATCH', `/api/workspaces/${s.workspaceId}`, s, { name: 'Laboratório Central' })).status, 200);
    for (let i = 0; i < 50 && world.workspaces.get(sws)!.label !== 'Laboratório Central'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(world.workspaces.get(sws)!.label, 'Laboratório Central');
    await req(h, 'POST', '/api/world/refresh', s, {});
    const st = (await req(h, 'GET', '/api/world/status', s)).json;
    assert.deepEqual(st.link.workspaces.map((w: { workspaceId: string; label: string }) => [w.workspaceId, w.label]), [[sws, 'Laboratório Central']]);
  });

  test('cartão que não pode ir: o motivo aparece e o World não é chamado', async () => {
    const t = await req(h, 'POST', '/api/tasks', s, { title: 'Relatório do mês' });
    const tref = `card:${t.json.id}`;
    const n0 = handoffCalls();
    const c = await card(tref);
    assert.deepEqual([c.where, c.canSend, c.reason], ['local', false, 'Só cards do quadro da equipe vão para a nuvem.'], 'tarefa sua (não da equipe) fica aqui');
    assert.deepEqual([(await send(tref)).status, (await send(tref)).json.error], [409, 'not_portable']);
    const brief = await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario' });
    const b = await card(`rotina:${brief.json.id}`);
    assert.deepEqual([b.canSend, b.reason], [false, 'Este tipo de trabalho ainda não roda na nuvem.'], 'lê o quadro local');
    const semConfig = await req(h, 'POST', '/api/routines', s, { template: 'radar-noticias' });
    assert.equal((await card(`rotina:${semConfig.json.id}`)).reason, 'Falta configurar a rotina.');
    await req(h, 'PATCH', `/api/routines/${semConfig.json.id}`, s, { status: 'paused' });
    assert.equal((await card(`rotina:${semConfig.json.id}`)).reason, 'Rotina pausada.');
    assert.equal(handoffCalls(), n0, 'nada disso foi ao World');
  });

  test('sem plano com Jobs: 402 e o cartão segue local, pronto para tentar de novo', async () => {
    const { id, ref } = await radar('plano');
    const r = await send(ref);
    assert.deepEqual([r.status, r.json.error, r.json.message], [402, 'jobs_not_in_plan', 'O plano deste workspace não inclui Jobs na nuvem.']);
    assert.equal((await card(ref)).where, 'local');
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, false);
    assert.equal(h.db.all('SELECT 1 FROM world_cards').length, 0, 'a intenção recusada fecha');
  });

  let feito = { id: '', ref: '' };
  test('cartão elegível: prepare → stage → commit; só com o aceite a fila daqui pula; selo; resultado no mesmo cartão; trazer de volta', async () => {
    world.activate(sws);
    feito = await radar('cromatografia');
    const { id, ref } = feito;
    assert.equal((await card(ref)).canSend, true);
    const n0 = world.log.length;
    const r = await send(ref);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.where, r.json.badge], ['remote', 'na_fila']);
    const calls = world.log.slice(n0).filter((x) => x.path.startsWith('/v1/jobs/handoffs'));
    assert.deepEqual(calls.map((x) => x.path.replace(/hof_[a-f0-9]+/, ':id')), ['/v1/jobs/handoffs/prepare', '/v1/jobs/handoffs/:id/stage', '/v1/jobs/handoffs/:id/commit']);
    const prep = calls[0].body;
    assert.deepEqual([prep.workspaceId, prep.cardRef, prep.cardState, prep.adapter], [sws, ref, 'waiting_external', 'web_feed']);
    assert.match(prep.intentKey, /^[A-Za-z0-9_:.-]{8,80}$/);
    assert.equal(calls[1].body.checksum, packageChecksum(calls[1].body.package));
    assert.ok(calls[1].body.package.urls[0].startsWith('https://news.google.com/rss/search?q=cromatografia'));
    const job = [...world.hjobs.values()].at(-1)!;
    assert.equal(world.owners.get(`${sws}|${ref}`)!.holder, 'world');

    // a fila e o agendador daqui pulam o cartão
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, true);
    assert.equal((await req(h, 'POST', `/api/routines/${id}/run`, s, { clientRequestId: 'rodar-aqui-01' })).json.error, 'remote');
    h.db.run('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), id);
    await h.routines.tick();
    assert.equal(runsOf(id).length, 0, 'o horário passou sem rodar aqui');
    assert.ok(h.db.get<{ next_run_at: string }>('SELECT next_run_at FROM routines WHERE id = ?', id)!.next_run_at > new Date().toISOString(), 'e o próximo horário segue');
    assert.equal(h.routines.disparoDoMotor(s.workspaceId, id, Date.now()), 'ignorada');
    assert.equal((await send(ref)).json.error, 'already_remote');

    world.runJob(job.id, 'running');
    assert.deepEqual([(await card(ref)).badge, (await card(ref)).canClaim], ['trabalhando', false]);
    const cedo = await req(h, 'POST', '/api/world/cards/claim', s, { ref });
    assert.deepEqual([cedo.status, cedo.json.error], [409, 'remote_running'], 'rodando na nuvem: não volta no meio');
    world.runJob(job.id, 'succeeded', { items: [{ title: 'Agilent lança coluna para PFAS', link: 'https://news.exemplo.test/a1', source: 'news.google.com' }], errors: [], fetchedAt: new Date().toISOString() });
    const fim = await card(ref);
    assert.deepEqual([fim.where, fim.badge, fim.canClaim], ['remote', 'concluido', true]);
    const runs = runsOf(id);
    assert.deepEqual(runs.map((x) => [x.status, x.summary, x.idempotency_key]), [['succeeded', 'Na nuvem: 1 item', `remote:${job.id}`]], 'o resultado entrou no histórico da rotina');
    const conv = h.db.get<{ conversation_id: string }>('SELECT conversation_id FROM routines WHERE id = ?', id)!.conversation_id;
    const msgs = h.db.all<{ content: string }>('SELECT content FROM messages WHERE conversation_id = ?', conv).map((m) => m.content).join('\n');
    assert.match(msgs, /Agilent lança coluna para PFAS/, 'aberto aqui com a chave deste aparelho');
    await card(ref); assert.equal(runsOf(id).length, 1, 'ler de novo não duplica');

    // reabrir não puxa de volta: só o clique
    const back = await req(h, 'POST', '/api/world/cards/claim', s, { ref });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    assert.deepEqual([back.json.where, back.json.canSend], ['local', true]);
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, false);
    assert.equal(world.owners.get(`${sws}|${ref}`)!.holder, 'local');
  });

  test('resposta do aceite perdida: o app consulta a transferência e segue o estado dela (um Job, uma intenção)', async () => {
    const { id, ref } = await radar('perdida');
    const jobs0 = world.hjobs.size;
    world.dropResponse = /^POST \/v1\/jobs\/handoffs\/hof_[a-f0-9]+\/commit$/;
    const r = await send(ref);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.where, 'remote');
    assert.equal(world.hjobs.size, jobs0 + 1, 'um Job só');
    assert.equal(world.log.filter((x) => x.path === '/v1/jobs/handoffs/prepare' && x.body.cardRef === ref).length, 1, 'nenhuma intenção nova');
    assert.ok(world.log.some((x) => x.method === 'GET' && /^\/v1\/jobs\/handoffs\/hof_/.test(x.path)), 'consultou depois da queda');
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, true);
  });

  test('resposta perdida e World fora do ar: o cartão continua aqui; na volta, a MESMA intenção termina o envio', async () => {
    const { id, ref } = await radar('queda');
    world.dropResponse = /^POST \/v1\/jobs\/handoffs\/prepare$/;
    const r = await send(ref);
    assert.deepEqual([r.status, r.json.error], [503, 'world_offline']);
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, false, 'sem aceite, segue local');
    const intent = world.log.filter((x) => x.path === '/v1/jobs/handoffs/prepare' && x.body.cardRef === ref)[0].body.intentKey;
    const again = await send(ref);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    const preps = world.log.filter((x) => x.path === '/v1/jobs/handoffs/prepare' && x.body.cardRef === ref);
    assert.deepEqual(preps.map((x) => x.body.intentKey), [intent, intent], 'a mesma intenção depois da queda');
    assert.equal([...world.handoffs.values()].filter((x) => x.card === ref).length, 1);
  });

  test('posse trocada no meio (outro computador): o aceite é recusado e o cartão fica aqui, sem perder nada', async () => {
    const { id, ref } = await radar('cercado');
    world.onCommit = (x) => world.takeOver(x.ws, x.card);
    const r = await send(ref);
    assert.deepEqual([r.status, r.json.error, r.json.message], [409, 'fenced', 'O cartão mudou no meio do envio. Ficou neste computador.']);
    assert.equal((await card(ref)).where, 'local');
    assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, false);
    assert.equal([...world.handoffs.values()].find((x) => x.card === ref)!.status, 'rejected');
  });

  test('licença de efeito: cartão que nunca foi ao World não pede; o que voltou pede, uma vez por chave, e perde se outro assumir', async () => {
    const cfg = loadWorldConfig(process.env); const client = new WorldClient(cfg);
    const cards = new CloudCards({ db: h.db, client, links: new WorldLinks(h.db, cfg, client), routines: h.routines, bus: h.bus, worldId: () => sws, minMs: 0 });
    const nunca = await radar('nunca');
    const n0 = world.log.length;
    assert.deepEqual(await cards.effect(s.userId, s.workspaceId, nunca.ref, 'email:1'), { first: true, registered: false });
    assert.equal(world.log.length, n0, 'local primeiro: nem pergunta');
    assert.deepEqual(await cards.effect(s.userId, s.workspaceId, feito.ref, 'email:1'), { first: true, registered: true });
    assert.deepEqual(await cards.effect(s.userId, s.workspaceId, feito.ref, 'email:1'), { first: false, registered: true }, 'mesma chave: não repete');
    const o = world.owners.get(`${sws}|${feito.ref}`)!; o.leaseUntil = 0; world.takeOver(sws, feito.ref);
    await assert.rejects(cards.effect(s.userId, s.workspaceId, feito.ref, 'email:2'), (e: { code?: string }) => e.code === 'fenced');
  });

  test('World fora do ar: tudo local segue; a lista dos cartões responde sem o World', async () => {
    await world.stop();
    try {
      const { id, ref } = await radar('offline');
      const l = await req(h, 'GET', '/api/world/cards', s);
      assert.equal(l.status, 200); assert.equal(l.json.offer, true);
      assert.ok(l.json.cards.some((c: { ref: string }) => c.ref === ref));
      assert.deepEqual([(await send(ref)).status], [503]);
      assert.equal((await req(h, 'GET', `/api/routines/${id}`, s)).json.remote, false);
      assert.equal((await req(h, 'POST', '/api/tasks', s, { title: 'Sem rede' })).status, 201);
    } finally { await world.start(); }
    await h.close();
  });
});
