import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { id, now } from '../src/lib/util.ts';
import { CHARACTERS, TOOLS, routeDemand, upgradeDemoTeam } from '../src/services/characters.ts';
import { parseVerdict } from '../src/services/review.ts';
import { instructionsFor } from '../src/services/runs.ts';
import { createWorkspace } from '../src/services/seed.ts';
import { drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('equipe de personagens', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('a equipe nova tem 12 personagens, 6 por andar, cada um com bio, instruções, métodos e ferramentas', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    assert.equal(st.agents.length, 12);
    const byLevel = [0, 1].map((l) => st.agents.filter((a: { floor_level: number }) => a.floor_level === l).length);
    assert.deepEqual(byLevel, [6, 6]);
    for (const a of st.agents) {
      assert.ok(a.char_key && a.bio && a.bio.length < 260, `${a.name}: bio curta`);
      assert.ok(a.skills.length >= 3, `${a.name}: métodos`);
      assert.ok(a.tools.length >= 2 && a.tools.every((t: { status: string }) => Object.values(TOOLS).some((x) => x.status === t.status)), `${a.name}: ferramentas com status`);
    }
    const platao = st.agents.find((a: { char_key: string }) => a.char_key === 'platao');
    assert.equal(platao.model_hint, 'ponta');
    const names = st.agents.map((a: { name: string }) => a.name);
    for (const n of ['Aristóteles', 'Sócrates', 'Platão', 'Arquimedes']) assert.ok(names.includes(n), n);
    // a equipe cobre as funções pedidas
    const roles = CHARACTERS.map((c) => c.role.toLowerCase()).join(' | ');
    for (const f of ['coordenação', 'texto', 'pesquisa', 'conceitos', 'revisão', 'design', 'tarefas', 'acompanhamento', 'comunicações', 'projetos', 'dados']) assert.ok(roles.includes(f), f);
  });

  test('instruções do modelo trazem a função e dizem o que ainda não existe (sem prometer ferramenta planejada)', () => {
    const arq = h.db.get<{ id: string }>("SELECT id FROM agents WHERE char_key = 'arquimedes'")!;
    const ins = instructionsFor(h.db, s.workspaceId, arq.id, '');
    assert.match(ins, /Você é Arquimedes, Números, planilhas e dados/);
    assert.match(ins, /unidade, período, moeda e fonte/);
    assert.doesNotMatch(ins, /Ferramentas que você tem:[^\n]*Executar código/, 'executar código só com autorização');
    assert.match(ins, /pedir-permissao ferramenta="calculo"/, 'sabe pedir permissão para executar código');
    assert.match(ins, /setor Análise e qualidade/);
    assert.doesNotMatch(ins, /Hermes/, 'o nome do motor não aparece para o modelo nem para o usuário');
    const ari = h.db.get<{ id: string }>("SELECT id FROM agents WHERE char_key = 'aristoteles'")!;
    const coord = instructionsFor(h.db, s.workspaceId, ari.id, '');
    assert.match(coord, /Análise e qualidade: .*Sócrates \(Revisão crítica/, 'quem coordena conhece a equipe por setor');
    assert.match(coord, /Travas de ferramentas/, 'e controla as travas de ferramentas');
    assert.match(coord, /\[\[ferramenta agente=/);
  });

  test('Aristóteles encaminha demandas por regras; quem recebe o pedido fica com ele', async () => {
    assert.equal(routeDemand('Montar a planilha de custos do trimestre')?.key, 'arquimedes');
    assert.equal(routeDemand('Escrever a proposta comercial para o cliente')?.key, 'herodoto');
    assert.equal(routeDemand('Organizar a pauta da reunião de sexta')?.key, 'hesiodo');
    assert.equal(routeDemand('Preparar os slides da apresentação')?.key, 'fidias');
    assert.equal(routeDemand('olá, tudo bem?'), null);
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const agent = (k: string) => st.agents.find((a: { char_key: string }) => a.char_key === k);
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agent('aristoteles').id })).json.id;
    const r = await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Preciso que alguém monte a planilha de custos do trimestre', clientRequestId: 'req-route-0001' });
    assert.equal(r.status, 201);
    // a coordenação planeja (sem modelo, o plano sai das mesmas regras de encaminhamento): o card nasce da resposta
    await drain(h, 3);
    // títulos são cifrados por campo: a busca é feita depois de ler (o banco não vê o texto)
    const t = h.db.all<{ agent_id: string; id: string; title: string }>('SELECT id, agent_id, title FROM tasks').find((x) => x.title.includes('planilha de custos'))!;
    assert.equal(t.agent_id, agent('arquimedes').id, 'a primeira etapa é de quem as palavras apontam');
    const log = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.log as Array<{ action: string; result: string }>;
    assert.match(log.find((e) => e.action === 'task.plan')!.result, /Aristóteles planejou 2 etapa\(s\): Arquimedes → Sócrates → entrega na conversa/);
    await drain(h, 3);
    // quem recebe o pedido fica com ele: resolve na conversa (sem card); pedindo o card, o card é dele
    const conv2 = (await req(h, 'POST', '/api/conversations', s, { agentId: agent('diogenes').id })).json.id;
    await req(h, 'POST', `/api/conversations/${conv2}/messages`, s, { text: 'Preciso que alguém escreva o relatório de visitas', clientRequestId: 'req-route-0002' });
    await drain(h, 3);
    assert.ok(!h.db.all<{ title: string }>('SELECT title FROM tasks').some((x) => x.title.includes('relatório de visitas')), 'sem card por regras');
    await req(h, 'POST', `/api/conversations/${conv2}/messages`, s, { text: '/tarefa escrever o relatório de visitas', clientRequestId: 'req-route-0003' });
    const t2 = h.db.all<{ agent_id: string; title: string }>('SELECT agent_id, title FROM tasks').find((x) => x.title.includes('relatório de visitas'))!;
    assert.equal(t2.agent_id, agent('diogenes').id, 'recebeu, ficou com ele');
    await drain(h, 3);
  });

  test('revisão socrática: Sócrates pergunta ao autor, o autor responde, Sócrates dá o veredito (limitado)', async () => {
    const st = (await req(h, 'GET', '/api/state', s)).json;
    const her = st.agents.find((a: { char_key: string }) => a.char_key === 'herodoto');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Relatório anual', description: 'Rascunho do relatório anual: receita cresceu bastante.', agentId: her.id })).json;
    const r = await req(h, 'POST', `/api/tasks/${t.id}/review`, s, {});
    assert.equal(r.status, 202);
    assert.equal((await req(h, 'POST', `/api/tasks/${t.id}/review`, s, {})).status, 409, 'uma revisão por vez');
    await drain(h, 12);
    const d = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    assert.equal(d.review.status, 'approved');
    assert.equal(d.review.reviewer_name, 'Sócrates');
    assert.equal(d.review.producer_name, 'Heródoto');
    const steps = h.db.all<{ review_step: string; agent_id: string }>('SELECT review_step, agent_id FROM runs WHERE review_id = ? ORDER BY created_at', d.review.id);
    assert.deepEqual(steps.map((x) => x.review_step), ['questions', 'answers', 'questions'], 'perguntas → respostas → veredito');
    assert.equal(steps[1].agent_id, her.id, 'quem responde é o autor');
    const answers = h.db.get<{ input: string }>("SELECT input FROM runs WHERE review_id = ? AND review_step = 'answers'", d.review.id)!;
    assert.match(answers.input, /Sócrates revisou o seu material/);
    assert.ok(d.log.some((e: { action: string }) => e.action === 'review.approved'));
  });

  test('revisão com limite de 1 rodada termina em "limite" sem nova execução; sem responsável é recusada', async () => {
    const h1 = await harness({ reviewMaxRounds: 1 });
    const s1 = await setupOwner(h1);
    const st = (await req(h1, 'GET', '/api/state', s1)).json;
    const fid = st.agents.find((a: { char_key: string }) => a.char_key === 'fidias');
    const t = (await req(h1, 'POST', '/api/tasks', s1, { title: 'Slides do lançamento', description: 'Roteiro de 8 slides.', agentId: fid.id })).json;
    assert.equal((await req(h1, 'POST', `/api/tasks/${t.id}/review`, s1, {})).status, 202);
    await drain(h1, 12);
    const d = (await req(h1, 'GET', `/api/tasks/${t.id}`, s1)).json;
    assert.equal(d.review.status, 'limit');
    assert.equal(Number(h1.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE review_id = ?', d.review.id)!.n), 1);
    const orphan = (await req(h1, 'POST', '/api/tasks', s1, { title: 'Sem dono' })).json;
    const r = await req(h1, 'POST', `/api/tasks/${orphan.id}/review`, s1, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'no_producer');
    await h1.close();
    assert.equal(parseVerdict('blá\nVEREDITO: ajustar\n...\nVEREDITO: Pronto'), 'pronto');
    assert.equal(parseVerdict('sem veredito'), null);
  });
});

describe('equipe de demonstração antiga vira a equipe de personagens', () => {
  let h: Harness;
  before(async () => { h = await harness(); });
  after(async () => { await h.close(); });

  test('renomeia preservando conversas, muda de andar com vaga, completa a equipe e registra no log (uma vez)', () => {
    // workspace como a versão anterior criava: 2 andares × 5 vagas e 10 agentes de demonstração
    const ws = createWorkspace(h.db, 'Antigo', { demo: false, slotsPerFloor: 5 });
    h.db.run('UPDATE workspaces SET demo_data = 1 WHERE id = ?', ws.workspaceId);
    const floors = h.db.all<{ id: string }>('SELECT id FROM floors WHERE workspace_id = ? ORDER BY level', ws.workspaceId);
    const prof = h.db.get<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = ? LIMIT 1', ws.workspaceId)!;
    const user = h.db.get<{ id: string }>('SELECT id FROM users LIMIT 1');
    const old = [['Helena', 0], ['Dario', 0], ['Lia', 0], ['Caio', 0], ['Nikos', 0], ['Sofia', 1], ['Teo', 1], ['Íris', 1], ['Milo', 1], ['Zoe', 1]] as const;
    const ids: Record<string, string> = {};
    for (const [name, level] of old) {
      ids[name] = id('agt');
      h.db.run(`INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, demo, created_at) VALUES (?, ?, ?, ?, ?, 'x', '#123456', 'active', 1, ?)`,
        ids[name], ws.workspaceId, floors[level].id, prof.id, name, now());
    }
    let convId: string | null = null;
    if (user) {
      convId = id('cnv');
      h.db.run('INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        convId, ws.workspaceId, ids.Helena, user.id, 'Conversa com Helena', `k-${convId}`, now());
    }
    const r = upgradeDemoTeam(h.db, null, ws.workspaceId, 6);
    assert.equal(r.renamed.length, 10);
    assert.deepEqual(r.added.sort(), ['Euclides', 'Sócrates']);
    const after1 = h.db.all<{ id: string; name: string; char_key: string; floor_id: string }>('SELECT id, name, char_key, floor_id FROM agents WHERE workspace_id = ?', ws.workspaceId);
    assert.equal(after1.length, 12);
    assert.equal(after1.find((a) => a.id === ids.Helena)!.name, 'Aristóteles', 'mesmo id: conversas e tarefas seguem');
    if (convId) assert.equal(h.db.get<{ title: string }>('SELECT title FROM conversations WHERE id = ?', convId)!.title, 'Conversa com Aristóteles');
    for (const c of CHARACTERS) assert.equal(after1.find((a) => a.char_key === c.key)!.floor_id, floors[c.level].id, `${c.name} no andar certo`);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND action = 'team.upgrade'", ws.workspaceId));
    const r2 = upgradeDemoTeam(h.db, null, ws.workspaceId, 6);
    assert.equal(r2.renamed.length + r2.added.length + r2.moved.length, 0, 'idempotente');
  });
});
