/**
 * Cards do quadro na nuvem (adaptador hermes_task) e o protocolo de recuperação, do lado do aplicativo, contra o World
 * de mentira (fake-world.ts): o card da equipe esperando em "A fazer" vai com o mesmo pedido que o agente receberia aqui
 * (só texto, nos limites do World), o modelo do agente e a chave própria do provedor (login por assinatura nunca vai);
 * a resposta volta ao MESMO card pelo caminho de uma execução daqui; sem a chave, o World roda no Ergon AI e o card
 * avisa; rodadas de recuperação no selo, seguindo `next`; falha final com o histórico; a política do workspace (quem
 * administra muda); o resumo "Enquanto você esteve fora"; /v1/compat decide o que aparece; 429 espera sem insistir.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveArtifact } from '../src/services/artifacts.ts';
import { saveProviderKey } from '../src/services/provider-keys.ts';
import { setSetting } from '../src/services/sectors.ts';
import { taskModel, taskPackage, TASK_LIMITS } from '../src/world/cards.ts';
import { FakeWorld } from './fake-world.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const CHAVE = 'chave-propria-de-teste';
let world: FakeWorld;
before(async () => {
  world = await new FakeWorld().start();
  process.env.ERGON_WORLD_URL = world.url;
  process.env.ERGON_WORLD_CARDS_MIN_MS = '0';
});
after(async () => { process.env.ERGON_WORLD_URL = ''; delete process.env.ERGON_WORLD_CARDS_MIN_MS; await world.stop(); });

describe('pacote do card (hermes_task)', () => {
  test('só texto, nos limites do World; o modelo do agente no formato de lá', () => {
    const p = taskPackage({ state: 'queued_local', reason: null, agentId: 'agt_x', agentName: 'A'.repeat(200), input: 'x'.repeat(30_000), soul: 's'.repeat(9_000), context: 'c'.repeat(150_000), model: { provider: 'openai', model: 'gpt-teste' } }, { provider: null, model: null });
    assert.deepEqual(Object.keys(p).sort(), ['context', 'instructions', 'model', 'profile']);
    assert.equal((p.instructions as string).length, TASK_LIMITS.instructions);
    assert.equal((p.context as string).length, TASK_LIMITS.context);
    const prof = p.profile as { name: string; systemPrompt: string };
    assert.equal(prof.name.length, 80); assert.equal(prof.systemPrompt.length, TASK_LIMITS.systemPrompt);
    assert.deepEqual(p.model, { provider: 'openai', id: 'gpt-teste' });
    // sem modelo no agente: o padrão da equipe; nada em lugar nenhum: o World escolhe (Ergon AI)
    assert.deepEqual(taskPackage({ state: 'queued_local', reason: null, input: 'oi', model: { provider: null, model: null } }, { provider: 'openrouter', model: 'anthropic/modelo-x' }).model, { provider: 'openrouter', id: 'anthropic/modelo-x' });
    assert.equal(taskPackage({ state: 'queued_local', reason: null, input: 'oi' }, { provider: null, model: null }).model, undefined);
    assert.equal(taskPackage({ state: 'queued_local', reason: null, input: 'oi', context: null }, { provider: null, model: null }).context, undefined);
    assert.deepEqual(taskModel('custom:Meu Servidor', 'modelo com espaço'), { provider: 'local', id: 'modelo-com-espa-o' });
    assert.deepEqual(taskModel('openai-codex', 'gpt-5'), { provider: 'openai-codex', id: 'gpt-5' });
  });
});

describe('Cards do quadro na nuvem', () => {
  let h: Harness; let s: Session; let sws = ''; let agente = ''; let nomeAgente = ''; let outro = '';
  const card = async (ref: string) => {
    const r = await req(h, 'GET', `/api/world/cards?ref=${encodeURIComponent(ref)}`, s);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.cards[0];
  };
  const send = (ref: string) => req(h, 'POST', '/api/world/cards/send', s, { ref });
  const novoCard = async (title: string, agentId = agente, description = 'Escreva três parágrafos sobre o tema, com fontes.') => {
    const t = await req(h, 'POST', '/api/tasks', s, { title, description, agentId });
    assert.equal(t.status, 201, JSON.stringify(t.json));
    return { id: t.json.id as string, ref: `card:${t.json.id}` };
  };
  const job = () => [...world.hjobs.values()].at(-1)!;
  const log = (path: RegExp, from = 0) => world.log.slice(from).filter((x) => path.test(x.path));
  const notas = (taskId: string, action: string) => h.db.all<{ result: string }>("SELECT result FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = ?", taskId, action).map((x) => x.result);
  const RESPOSTA = 'Entreguei os três parágrafos pedidos sobre o tema, com as fontes no fim de cada um. Primeiro parágrafo: contexto. Segundo: dados. Terceiro: conclusão.';

  before(async () => {
    h = await harness(); s = await setupOwner(h, 'bia', 'senha-local-123');
    assert.equal((await req(h, 'POST', '/api/world/connect', s, { mode: 'signup', email: 'bia@nuvem.test', password: 'senha-do-world-123', displayName: 'Bia' })).status, 200);
    sws = (await req(h, 'POST', '/api/world/bind', s, { workspaceId: s.workspaceId })).json.syncWorkspaceId;
    world.activate(sws);
    setSetting(h.db, s.workspaceId, 'team.autorun', '0'); // o card espera em "A fazer"
    const a = h.db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0 ORDER BY created_at LIMIT 1", s.workspaceId)!;
    agente = a.id; nomeAgente = a.name;
    h.db.run("UPDATE agents SET provider = 'openai', model = 'gpt-teste' WHERE id = ?", agente);
    saveProviderKey(h.integrations, s.workspaceId, 'openai', CHAVE);
  });
  after(async () => { await h.close(); });

  test('card da equipe em "A fazer": pacote certo, chave do provedor logo depois do prepare, aceite; a fila daqui pula', async () => {
    const c = await novoCard('Texto sobre cromatografia');
    saveArtifact(h.db, h.bus, h.cfg.filesDir, h.cfg.maxUploadBytes, s.workspaceId, s.userId, { filename: 'notas.md', mime: 'text/markdown', data: Buffer.from('# Notas\nUsar a coluna C18.'), taskId: c.id });
    const v = await card(c.ref);
    assert.deepEqual([v.where, v.canSend, v.reason], ['local', true, null]);
    const n0 = world.log.length;
    const r = await send(c.ref);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.where, r.json.badge], ['remote', 'na_fila']);
    const calls = log(/^\/v1\/jobs\/handoffs/, n0);
    assert.deepEqual(calls.map((x) => x.path.replace(/hof_[a-f0-9]+/, ':id')), ['/v1/jobs/handoffs/prepare', '/v1/jobs/handoffs/:id/model-grant', '/v1/jobs/handoffs/:id/stage', '/v1/jobs/handoffs/:id/commit']);
    assert.deepEqual([calls[0].body.adapter, calls[0].body.cardState], ['hermes_task', 'queued_local']);
    assert.deepEqual(calls[1].body, { provider: 'openai', model: 'gpt-teste', apiKey: CHAVE });
    const pkg = calls[2].body.package;
    assert.deepEqual(Object.keys(pkg).sort(), ['context', 'instructions', 'model', 'profile']);
    assert.match(pkg.instructions, /^Tarefa #\d+: Texto sobre cromatografia\nEscreva três parágrafos/);
    assert.match(pkg.context, /Arquivo anexado "notas\.md"[\s\S]*Usar a coluna C18\./);
    assert.deepEqual(pkg.model, { provider: 'openai', id: 'gpt-teste' });
    assert.equal(pkg.profile.name, nomeAgente);
    assert.ok(pkg.profile.systemPrompt.length > 0 && pkg.profile.systemPrompt.length <= 8000);
    const raw = JSON.stringify(pkg);
    assert.ok(!raw.includes(h.cfg.filesDir) && !raw.includes(h.cfg.dataDir) && !/art_[a-f0-9]{32}/.test(raw.replace(/\(id art_[a-f0-9]{32}/g, '')), 'nenhum caminho deste computador');
    assert.ok(!raw.includes(CHAVE), 'a chave não vai no pacote');
    assert.equal(world.grants.get(calls[1].path.match(/hof_[a-f0-9]+/)![0])!.apiKey, CHAVE);
    // nada da chave volta para a tela
    assert.ok(!JSON.stringify((await req(h, 'GET', '/api/world/cards', s)).json).includes(CHAVE));
    // a fila daqui pula o card na nuvem; pôr para trabalhar aqui é recusado
    setSetting(h.db, s.workspaceId, 'team.autorun', '1');
    for (let i = 0; i < 10 && h.teamwork.next(s.workspaceId); i++) { /* os outros cards da fila andam */ }
    assert.equal(h.db.all('SELECT 1 FROM runs WHERE task_id = ?', c.id).length, 0, 'o card na nuvem não roda aqui');
    h.db.run("UPDATE runs SET status = 'cancelled' WHERE status IN ('queued', 'running') AND task_id <> ?", c.id);
    setSetting(h.db, s.workspaceId, 'team.autorun', '0');
    assert.equal((await req(h, 'POST', `/api/tasks/${c.id}/work`, s)).json.error, 'remote');

    // o agente responde na nuvem: a resposta entra no MESMO card como a de uma execução daqui; o card volta
    const j = job();
    world.runJob(j.id, 'running');
    assert.equal((await card(c.ref)).badge, 'trabalhando');
    world.runJob(j.id, 'succeeded', RESPOSTA);
    const fim = await card(c.ref);
    assert.equal(fim.where, 'local', JSON.stringify(fim));
    assert.equal(fim.fallback, null);
    assert.equal(world.owners.get(`${sws}|${c.ref}`)!.holder, 'local', 'trazido de volta sozinho');
    const run = h.db.get<{ status: string; output: string; idempotency_key: string; agent_id: string; model: string }>('SELECT status, output, idempotency_key, agent_id, model FROM runs WHERE task_id = ? ORDER BY created_at LIMIT 1', c.id)!;
    assert.deepEqual([run.status, run.idempotency_key, run.agent_id, run.model], ['succeeded', `queue-${c.id}-nuvem-${j.id}`, agente, 'openai/gpt-teste']);
    assert.equal(run.output, RESPOSTA);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE target_id = ? AND action = 'agent.result.succeeded'", c.id), 'a entrega aparece no histórico do card');
    assert.ok(h.db.get('SELECT 1 AS x FROM task_results WHERE task_id = ?', c.id), 'a conferência do card avaliou a entrega, como aqui');
    assert.equal(world.grants.size, 0, 'a chave some no fim do Job');
    await card(c.ref);
    assert.equal(h.db.all('SELECT 1 FROM runs WHERE task_id = ? AND idempotency_key LIKE ?', c.id, `queue-${c.id}-nuvem-%`).length, 1, 'ler de novo não duplica');
  });

  test('agente com login por assinatura: nenhuma chave vai; roda no Ergon AI e o card avisa', async () => {
    outro = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND id <> ? ORDER BY created_at LIMIT 1", s.workspaceId, agente)!.id;
    h.db.run("UPDATE agents SET provider = 'openai-codex', model = 'gpt-assinatura' WHERE id = ?", outro);
    const c = await novoCard('Resumo da semana', outro);
    const n0 = world.log.length;
    assert.equal((await send(c.ref)).status, 200);
    assert.equal(log(/model-grant$/, n0).length, 0, 'login por assinatura nunca vai à nuvem');
    world.runJob(job().id, 'succeeded', RESPOSTA);
    const v = await card(c.ref);
    assert.equal(v.fallback, 'provedor não aceito na nuvem');
    assert.deepEqual(notas(c.id, 'task.cloud_fallback'), ['Rodou no Ergon AI: provedor não aceito na nuvem']);
    assert.equal(h.db.get<{ model: string }>('SELECT model FROM runs WHERE task_id = ?', c.id)!.model, 'ergon-ai/deepseek-flash');
  });

  test('provedor com chave, mas sem chave guardada: sem grant; o World troca e avisa', async () => {
    const terceiro = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND id NOT IN (?, ?) ORDER BY created_at LIMIT 1", s.workspaceId, agente, outro)!.id;
    h.db.run("UPDATE agents SET provider = 'anthropic', model = 'modelo-do-agente' WHERE id = ?", terceiro);
    const c = await novoCard('Carta para o cliente', terceiro);
    const n0 = world.log.length;
    assert.equal((await send(c.ref)).status, 200);
    assert.equal(log(/model-grant$/, n0).length, 0);
    world.runJob(job().id, 'succeeded', RESPOSTA);
    assert.equal((await card(c.ref)).fallback, 'sem chave do provedor para a nuvem');
  });

  test('o que só existe neste computador não vai: arquivo que só abre aqui, card que usa as contas, card rodando', async () => {
    const pdf = await novoCard('Revisar a proposta');
    saveArtifact(h.db, h.bus, h.cfg.filesDir, h.cfg.maxUploadBytes, s.workspaceId, s.userId, { filename: 'proposta.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 teste'), taskId: pdf.id });
    assert.deepEqual([(await card(pdf.ref)).canSend, (await card(pdf.ref)).reason], [false, 'Tem arquivo que só abre neste computador.']);
    const n0 = world.log.length;
    assert.equal((await send(pdf.ref)).json.error, 'not_portable');
    assert.equal(log(/^\/v1\/jobs\/handoffs/, n0).length, 0, 'nem chega ao World');
    const meu = (await req(h, 'POST', '/api/tasks', s, { title: 'Pagar a conta' })).json.id as string;
    assert.equal((await card(`card:${meu}`)).reason, 'Só cards do quadro da equipe vão para a nuvem.');
  });

  test('recuperação: selo "recuperando" com a rodada; segue `next`; a falha final mostra o que falhou em cada rodada', async () => {
    const c = await novoCard('Relatório de mercado');
    assert.equal((await send(c.ref)).status, 200);
    let atual = job().id;
    const motivos = ['o modelo não respondeu', 'resposta cortada', 'tempo esgotado'];
    for (let r = 1; r <= 3; r++) {
      const next = world.runJob(atual, 'failed', undefined, motivos[r - 1])!;
      assert.ok(next, `rodada ${r} criada`);
      const v = await card(c.ref);
      assert.deepEqual([v.where, v.badge, v.recovery], ['remote', 'recuperando', { round: r, of: 3 }], JSON.stringify(v));
      assert.equal(v.canClaim, false, 'rodada em andamento não é o fim');
      atual = next;
    }
    // o World pode responder pelo Job antigo (falhou, com `next`): o app segue a rodada nova
    const o = world.owners.get(`${sws}|${c.ref}`)!;
    const velho = [...world.hjobs.values()].find((x) => x.recoveredBy === atual)!;
    o.jobId = velho.id;
    h.db.run('UPDATE world_cards SET job_state = NULL WHERE card_ref = ?', c.ref);
    const seguido = await card(c.ref);
    assert.deepEqual([seguido.badge, seguido.recovery.round], ['recuperando', 3]);
    assert.equal(h.db.get<{ job_id: string }>('SELECT job_id FROM world_cards WHERE card_ref = ?', c.ref)!.job_id, atual, 'o cartão passou para a rodada nova');
    o.jobId = atual;
    assert.equal(world.runJob(atual, 'failed', undefined, 'falhou de novo'), null, 'acabaram as rodadas');
    const fim = await card(c.ref);
    assert.deepEqual([fim.where, fim.badge, fim.canClaim], ['remote', 'falhou', true]);
    assert.deepEqual(fim.history.map((x: { round: number; reason: string }) => [x.round, x.reason]), [[0, motivos[0]], [1, motivos[1]], [2, motivos[2]], [3, 'falhou de novo']]);
    assert.deepEqual(notas(c.id, 'task.cloud_failed'), ['Falhou na nuvem: falhou de novo']);
    // trazer de volta: o card volta à fila daqui
    assert.equal((await req(h, 'POST', '/api/world/cards/claim', s, { ref: c.ref })).json.where, 'local');
  });

  test('recuperou numa rodada e concluiu: entra no mesmo card e conta como recuperado', async () => {
    const c = await novoCard('Pesquisa de preços');
    assert.equal((await send(c.ref)).status, 200);
    const next = world.runJob(job().id, 'failed', undefined, 'o modelo não respondeu')!;
    assert.equal((await card(c.ref)).badge, 'recuperando');
    world.runJob(next, 'succeeded', RESPOSTA);
    assert.equal((await card(c.ref)).where, 'local');
    assert.equal(h.db.get<{ idempotency_key: string }>('SELECT idempotency_key FROM runs WHERE task_id = ?', c.id)!.idempotency_key, `queue-${c.id}-nuvem-${next}`);
  });

  test('"Enquanto você esteve fora": os números e o detalhe sob pedido; visto, zera', async () => {
    const r = (await req(h, 'GET', '/api/world/cards/summary', s)).json;
    assert.deepEqual(r.counts, { concluidos: 4, recuperados: 1, falharam: 1, ergonAi: 2 });
    assert.ok(r.items.some((x: { title: string; outcome: string; reason: string }) => x.title === 'Relatório de mercado' && x.outcome === 'falhou' && x.reason === 'falhou de novo'));
    assert.ok(r.items.some((x: { title: string; fallback: string }) => x.title === 'Resumo da semana' && x.fallback === 'provedor não aceito na nuvem'));
    assert.equal((await req(h, 'POST', '/api/world/cards/summary/seen', s, {})).status, 200);
    assert.deepEqual((await req(h, 'GET', '/api/world/cards/summary', s)).json.counts, { concluidos: 0, recuperados: 0, falharam: 0, ergonAi: 0 });
  });

  test('recuperação automática: ligada por padrão; quem administra desliga; quem é só membro vê sem mudar', async () => {
    assert.deepEqual((await req(h, 'GET', '/api/world/job-policy', s)).json, { available: true, recovery: true, rounds: 3, canEdit: true });
    const off = await req(h, 'PUT', '/api/world/job-policy', s, { recovery: false });
    assert.deepEqual([off.status, off.json], [200, { recovery: false }]);
    assert.equal(world.policies.get(sws), false);
    const c = await novoCard('Sem recuperação');
    assert.equal((await send(c.ref)).status, 200);
    assert.equal(world.runJob(job().id, 'failed', undefined, 'o modelo não respondeu'), null, 'desligada: falha direto');
    assert.equal((await card(c.ref)).badge, 'falhou');
    assert.equal((await req(h, 'PUT', '/api/world/job-policy', s, { recovery: true })).json.recovery, true);
    // membro (não administra o workspace no World): vê, não muda
    const acc = world.workspaces.get(sws)!.owner;
    world.roles.set(acc, 'member');
    await req(h, 'POST', '/api/world/refresh', s, {});
    assert.deepEqual((await req(h, 'GET', '/api/world/job-policy', s)).json, { available: true, recovery: true, rounds: 3, canEdit: false });
    const no = await req(h, 'PUT', '/api/world/job-policy', s, { recovery: false });
    assert.deepEqual([no.status, no.json.message], [403, 'Só quem administra o workspace muda isso.']);
    assert.equal(world.policies.get(sws), true);
    world.roles.delete(acc);
    await req(h, 'POST', '/api/world/refresh', s, {});
  });

  test('/v1/compat decide: World sem hermes_task não oferece os cards; sem model_grant, a chave não vai', async () => {
    const salvo = world.features;
    try {
      world.features = ['web_feed'];
      // um World novo de cada vez (a leitura do compat é guardada por instância)
      const c = await novoCard('Sem nuvem para agentes');
      const h2 = await harness({}, { dir: h.dir });
      try {
        const v = await req(h2, 'GET', `/api/world/cards?ref=${encodeURIComponent(c.ref)}`, s);
        assert.deepEqual([v.json.cards[0].canSend, v.json.cards[0].reason], [false, 'Este tipo de trabalho ainda não roda na nuvem.']);
      } finally { await h2.close(); }
    } finally { world.features = salvo; }
  });

  test('limite de pedidos (429): a leitura espera o Retry-After sem chamar de novo; nada se perde', async () => {
    const c = await novoCard('Com pausa');
    assert.equal((await send(c.ref)).status, 200);
    world.rateLimitNext = 1;
    const a = await req(h, 'GET', '/api/world/cards', s);
    assert.deepEqual([a.status, a.json.stale], [200, true]);
    const n0 = world.log.length;
    const b = await req(h, 'GET', '/api/world/cards', s);
    assert.deepEqual([b.status, b.json.stale], [200, true]);
    assert.equal(world.log.length, n0, 'durante a pausa, nenhum pedido ao World');
    const r = await send((await novoCard('Outro com pausa')).ref);
    assert.deepEqual([r.status, r.json.error], [429, 'rate_limited']);
    assert.equal((await card(c.ref)).where, 'remote', 'o card segue na nuvem');
  });
});
