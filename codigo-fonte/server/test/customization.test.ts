import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseChatCommand, parseProposals } from '../src/services/proposals.ts';
import { stripControl } from '../src/services/teamwork.ts';
import { ensureSectors } from '../src/services/sectors.ts';
import { COORDINATION_PROTOCOL, COORDINATOR_ROLE, COORDINATOR_TOOLS, activeTeam, coordinatorOf, reviewerOf, routeTo } from '../src/services/team.ts';
import { createAgent, ensureCoordinator } from '../src/services/capacity.ts';
import { instructionsFor } from '../src/services/runs.ts';
import { CHARACTERS } from '../src/services/characters.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { allAgents, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

/** Motor falso: devolve o que o teste mandar. */
class FakeMotor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  reply: (p: StartRun) => string = () => 'ok';
  async health() { return { ok: true, detail: 'fake' }; }
  async startRun(p: StartRun) {
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}`;
    this.runs.set(runId, { status: 'completed', output: this.reply(p), error: null, sessionId: `sess-${p.sessionKey.slice(-12)}`, usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'fake' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: ['todo_list'] }]; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'fake', provider: 'nous', providers: [] }; }
}

const byChar = (h: Harness, ws: string, key: string) => h.db.get<{ id: string; name: string; role: string; status: string; tools: string }>('SELECT id, name, role, status, tools FROM agents WHERE workspace_id = ? AND char_key = ?', ws, key)!;
const proposalsOf = async (h: Harness, s: Session, conv: string) => (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ id: string; kind: string; status: string; summary: string }>;
const applyAll = async (h: Harness, s: Session, conv: string) => {
  for (const p of (await proposalsOf(h, s, conv)).filter((x) => x.status === 'proposed')) {
    const r = await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' });
    assert.equal(r.json.status, 'applied', `${p.summary}: ${JSON.stringify(r.json)}`);
  }
};

describe('personalização completa: o sistema segue a função, não o nome', () => {
  let h: Harness; let s: Session; let motor: FakeMotor; let conv: string; let quiet: string;
  before(async () => {
    motor = new FakeMotor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { hermes: motor });
    s = await setupOwner(h);
    await h.ai.refreshToolsets();
    conv = (await req(h, 'POST', '/api/conversations', s, { agentId: byChar(h, s.workspaceId, 'aristoteles').id })).json.id;
    // conversa ainda sem mensagem: fica com o título padrão, que acompanha o nome do agente
    quiet = (await req(h, 'POST', '/api/conversations', s, { agentId: byChar(h, s.workspaceId, 'aristoteles').id })).json.id;
  });
  const titleOf = (id: string) => h.db.get<{ title: string }>('SELECT title FROM conversations WHERE id = ?', id)!.title;
  after(async () => { await h.close(); });

  test('leitura das linhas de personalização', () => {
    const p = parseProposals('Proposta do tema:\n[[editar-agente agente="Aristóteles" nome="Gandalf" papel="Coordenação da Sociedade" metodos="Conselho; Paciência" bio="Um mago chega na hora certa."]]\n'
      + '[[editar-setor setor="Coordenação e projetos" nome="Conselho de Valfenda"]]\n[[novo-setor nome="Taverna do Pônei" descricao="Conversas e boatos"]]\n[[desativar-agente agente="Euclides" motivo="fora do tema"]]\n[[reativar-agente agente="Euclides"]]');
    assert.deepEqual(p.map((x) => x.kind), ['edit_agent', 'sector_edit', 'sector_new', 'deactivate_agent', 'reactivate_agent']);
    assert.deepEqual((p[0] as { changes: { skills: string[] } }).changes.skills, ['Conselho', 'Paciência']);
    assert.deepEqual(parseChatCommand('Renomeie o Sócrates para Elrond'), { kind: 'edit_agent', agent: 'Sócrates', changes: { name: 'Elrond' } });
    assert.equal(stripControl('Pronto.\n[[editar-agente agente="A" nome="B"]]\n[[novo-setor nome="C"]]\n[[desativar-agente agente="D"]]'), 'Pronto.', 'a conversa não mostra as linhas de controle');
  });

  test('um tema inteiro pela conversa: Gandalf coordena e nada quebra', async () => {
    motor.reply = () => 'Montei o tema da Terra-média. Aplique o que quiser.\n'
      + '[[editar-agente agente="Aristóteles" nome="Gandalf" papel="Coordenação da Sociedade" bio="Um mago nunca se atrasa."]]\n'
      + '[[editar-agente agente="Fídias" nome="Legolas" papel="Roteirista de vídeos" metodos="Roteiro em cenas; Ganchos nos primeiros segundos"]]\n'
      + '[[editar-setor setor="Coordenação e projetos" nome="Conselho de Valfenda" descricao="Decide o rumo da Sociedade."]]\n'
      + '[[novo-setor nome="Taverna do Pônei" descricao="Conversas e boatos"]]\n'
      + '[[desativar-agente agente="Euclides" motivo="fora do tema"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Transforme a equipe num tema do Senhor dos Anéis', clientRequestId: 'tema-00001' });
    await drain(h, 4);
    const props = await proposalsOf(h, s, conv);
    assert.equal(props.filter((p) => p.status === 'proposed').length, 5);
    assert.equal(byChar(h, s.workspaceId, 'aristoteles').name, 'Aristóteles', 'nada muda antes de aplicar');
    await applyAll(h, s, conv);
    const gandalf = byChar(h, s.workspaceId, 'aristoteles');
    assert.equal(gandalf.name, 'Gandalf');
    assert.equal(coordinatorOf(activeTeam(h.db, s.workspaceId))?.name, 'Gandalf', 'quem coordena continua coordenando com outro nome');
    assert.equal(titleOf(quiet), 'Conversa com Gandalf');
    assert.equal(titleOf(conv), 'Transforme a equipe num tema do Senhor dos Anéis', 'a conversa com mensagem tem o nome da 1ª mensagem');
    assert.equal(byChar(h, s.workspaceId, 'euclides').status, 'archived');
    const st = (await req(h, 'GET', '/api/state', s)).json;
    assert.ok(st.sectors.some((x: { name: string }) => x.name === 'Conselho de Valfenda'));
    assert.ok(st.sectors.some((x: { name: string }) => x.name === 'Taverna do Pônei'));
    // o boot não desfaz o que o usuário mudou
    ensureSectors(h.db, null, s.workspaceId);
    assert.ok((await req(h, 'GET', '/api/state', s)).json.sectors.some((x: { name: string }) => x.name === 'Conselho de Valfenda'));
    // encaminhamento pela função de hoje: Legolas roteiriza; "slide" já não é com ele
    const team = activeTeam(h.db, s.workspaceId);
    assert.equal(routeTo(team, 'Preciso de um roteiro de vídeo para o lançamento')?.member.name, 'Legolas');
    assert.notEqual(routeTo(team, 'Monte os slides da apresentação')?.member.name, 'Legolas');
    // reativar pela conversa
    motor.reply = () => 'Euclides volta. [[reativar-agente agente="Euclides"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Traga o Euclides de volta', clientRequestId: 'tema-00002' });
    await drain(h, 4);
    await applyAll(h, s, conv);
    assert.equal(byChar(h, s.workspaceId, 'euclides').status, 'active');
  });

  test('revisão crítica é de quem tem a ferramenta, com qualquer nome', async () => {
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Renomeie o Sócrates para Elrond', clientRequestId: 'tema-00003' });
    await applyAll(h, s, conv);
    assert.equal(reviewerOf(activeTeam(h.db, s.workspaceId))?.name, 'Elrond');
    const her = byChar(h, s.workspaceId, 'herodoto');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Carta à Sociedade', description: 'Rascunho da carta convocando a Sociedade para o conselho.', agentId: her.id })).json;
    const r = await req(h, 'POST', `/api/tasks/${t.id}/review`, s);
    assert.equal(r.status, 202);
    assert.equal(h.db.get<{ name: string }>('SELECT a.name FROM reviews v JOIN agents a ON a.id = v.reviewer_id WHERE v.id = ?', r.json.reviewId)!.name, 'Elrond');
    // tirando a ferramenta de todos, a mensagem explica o que fazer (sem citar personagem)
    h.db.run("UPDATE reviews SET status = 'stopped' WHERE workspace_id = ?", s.workspaceId);
    for (const a of activeTeam(h.db, s.workspaceId)) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(a.tools.filter((x) => x !== 'revisao')), a.id);
    const none = await req(h, 'POST', `/api/tasks/${t.id}/review`, s);
    assert.equal(none.status, 409);
    assert.match(none.json.message ?? none.json.error ?? JSON.stringify(none.json), /Ninguém da equipe faz revisão crítica/);
    assert.ok(!/Sócrates/.test(JSON.stringify(none.json)));
  });

  test('o Coordenador é o único cargo fixo: o nome muda, a função não', async () => {
    const coord = byChar(h, s.workspaceId, 'aristoteles');
    assert.equal(coord.name, 'Gandalf', 'o tema trocou o nome');
    assert.equal(coord.role, COORDINATOR_ROLE, 'o tema não trocou a função (a proposta aplicou só o permitido)');
    const themed = (await proposalsOf(h, s, conv)).find((p) => p.summary.includes('Gandalf') && p.kind === 'edit_agent')!;
    assert.match(h.db.get<{ result: string }>('SELECT result FROM agent_proposals WHERE id = ?', themed.id)!.result, /função e setor são fixos/);
    // pela conversa: passar o encaminhamento, desativar ou mudar a função do Coordenador falha com o motivo
    motor.reply = () => 'Vou tentar. [[ferramenta agente="Hipódamo" ferramenta="encaminhar" acao="dar"]]\n[[ferramenta agente="Gandalf" ferramenta="encaminhar" acao="tirar"]]\n'
      + '[[desativar-agente agente="Gandalf" motivo="teste"]]\n[[mover agente="Gandalf" setor="Taverna do Pônei"]]';
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'Quero que o Hipódamo coordene a partir de hoje', clientRequestId: 'tema-00004' });
    await drain(h, 4);
    for (const p of (await proposalsOf(h, s, conv)).filter((x) => x.status === 'proposed')) {
      const r = await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' });
      assert.equal(r.json.status, 'failed', p.summary);
      assert.match(r.json.result, /único cargo fixo|só do Coordenador|Coordenador \(o único cargo fixo\)/, p.summary);
    }
    assert.equal(coordinatorOf(activeTeam(h.db, s.workspaceId))?.name, 'Gandalf');
    assert.ok(!byChar(h, s.workspaceId, 'hipodamo').tools.includes('encaminhar'));
    // pelo perfil (API): a função e o setor recusam; nome, história e foco passam
    assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { role: 'Roteirista' })).json.error, 'fixed_role');
    assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { sectorKey: 'central' })).json.error, 'fixed_sector');
    assert.equal((await req(h, 'POST', `/api/agents/${coord.id}/archive`, s)).json.error, 'fixed_coordinator');
    assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { name: 'Mithrandir', bio: 'O Cinzento.', charter: 'Paciência com os hobbits; prazos primeiro.' })).status, 200);
    // o protocolo do cargo vai sempre nas instruções, com o foco do usuário depois
    const ins = instructionsFor(h.db, s.workspaceId, coord.id, '');
    assert.ok(ins.includes(COORDINATION_PROTOCOL));
    assert.match(ins, /Foco desta coordenação, definido pelo usuário: Paciência com os hobbits/);
    assert.ok(!instructionsFor(h.db, s.workspaceId, byChar(h, s.workspaceId, 'hipodamo').id, '').includes('[[editar-agente'), 'só o Coordenador propõe mudanças na equipe');
  });

  test('o início do Ergon garante o cargo: reativa, devolve função, setor e ferramentas, limpa instruções antigas', () => {
    const coord = byChar(h, s.workspaceId, 'aristoteles');
    const old = 'Você coordena a equipe do Ergon. Para cada pedido: (1) classifique tudo; (5) acompanhe. Não faça o trabalho dos especialistas: organize, encaminhe e confira o andamento. Fale como mago.';
    h.db.run("UPDATE agents SET status = 'archived', role = 'Outra coisa', tools = '[\"quadro\"]', charter = ? WHERE id = ?", h.db.seal(s.workspaceId, old), coord.id);
    const hip = byChar(h, s.workspaceId, 'hipodamo');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...JSON.parse(hip.tools), 'encaminhar']), hip.id);
    ensureCoordinator(h.db, null, s.workspaceId, { autoGrow: true, maxFloors: 12, maxActive: 0 });
    const c2 = h.db.get<{ status: string; role: string; tools: string; charter: string }>('SELECT status, role, tools, charter FROM agents WHERE id = ?', coord.id)!;
    assert.equal(c2.status, 'active');
    assert.equal(c2.role, COORDINATOR_ROLE);
    for (const t of COORDINATOR_TOOLS) assert.ok(JSON.parse(c2.tools).includes(t), t);
    assert.equal(c2.charter, 'Fale como mago.', 'fica só o foco; o protocolo vai sempre pelas instruções');
    assert.ok(!byChar(h, s.workspaceId, 'hipodamo').tools.includes('encaminhar'), 'só o Coordenador encaminha');
    // sem ninguém marcado, marca quem coordena (nunca fica sem)
    h.db.run('UPDATE agents SET coordinator = 0 WHERE workspace_id = ?', s.workspaceId);
    ensureCoordinator(h.db, null, s.workspaceId, { autoGrow: true, maxFloors: 12, maxActive: 0 });
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND coordinator = 1', s.workspaceId)!.n, 1);
    assert.equal(coordinatorOf(activeTeam(h.db, s.workspaceId))?.id, coord.id);
  });

  test('voltar ao tema padrão: nomes e histórias gregos; funções ficam', async () => {
    assert.ok((await req(h, 'GET', '/api/state', s)).json.themed > 0, 'o tema da Terra-média está aplicado');
    const r = (await req(h, 'POST', '/api/team/restore-theme', s)).json;
    assert.ok(r.restored.some((x: string) => x.endsWith('→ Aristóteles')), JSON.stringify(r));
    assert.equal(byChar(h, s.workspaceId, 'aristoteles').name, 'Aristóteles');
    assert.equal(byChar(h, s.workspaceId, 'socrates').name, 'Sócrates');
    assert.equal(byChar(h, s.workspaceId, 'fidias').name, 'Fídias');
    assert.equal(byChar(h, s.workspaceId, 'fidias').role, 'Roteirista de vídeos', 'a função é trabalho, não tema');
    assert.equal(h.db.get<{ bio: string }>("SELECT bio FROM agents WHERE workspace_id = ? AND char_key = 'aristoteles'", s.workspaceId)!.bio, CHARACTERS.find((c) => c.key === 'aristoteles')!.bio);
    assert.equal((await req(h, 'GET', '/api/state', s)).json.themed, 0);
    assert.equal(titleOf(quiet), 'Conversa com Aristóteles');
    assert.equal(titleOf(conv), 'Transforme a equipe num tema do Senhor dos Anéis');
  });

  test('limite de agentes por plano (nuvem): o Coordenador conta, mas nunca sai', () => {
    const active = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId)!.n;
    assert.throws(() => createAgent(h.db, h.bus, s.workspaceId, s.userId, { name: 'Além do plano', role: 'Teste', sectorKey: 'central' }, { autoGrow: false, maxFloors: 12, maxActive: active }), /plano comporta/);
  });
});

describe('boas-vindas: a escolha define a equipe de partida', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('conta nova começa com as perguntas; workspace antigo não', async () => {
    const me = (await req(h, 'GET', '/api/me', s)).json;
    assert.equal(me.onboarding, 'pending');
    assert.deepEqual(me.prefs, { tips: true, dismissed: [], tourDone: false });
    const o = (await req(h, 'GET', '/api/onboarding', s)).json;
    assert.ok(o.uses.some((u: { key: string }) => u.key === 'empresario'));
    assert.ok(o.niches.some((n: { key: string }) => n.key === 'programacao'));
    assert.ok(o.presets.length >= 12);
  });

  test('publicitário em marketing: setores, funções e primeiros passos da agência', async () => {
    const r = await req(h, 'POST', '/api/onboarding', s, { use: 'publicitario', niche: 'marketing', company: 'Agência Lume', goal: 'Lançar a campanha de verão' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.preset.key, 'marketing');
    assert.equal(r.json.coordinator, 'Aristóteles');
    const st = (await req(h, 'GET', '/api/state', s)).json;
    assert.equal(st.workspace.name, 'Agência Lume');
    assert.ok(st.sectors.some((x: { name: string }) => x.name === 'Criação'));
    assert.equal(byChar(h, s.workspaceId, 'fidias').role, 'Direção de arte e peças');
    const coord = (await allAgents(h, s)).find((a: { char_key: string }) => a.char_key === 'aristoteles');
    assert.match(coord.charter, /campanhas e clientes/);
    assert.equal(st.team.coordinator.id, coord.id, 'o /api/state diz quem coordena');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND origin = 'demo' AND archived = 0", s.workspaceId)!.n, 0, 'demonstração arquivada');
    const steps = h.db.all<{ title: string }>("SELECT t.title FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.workspace_id = ? AND b.audience = 'user' AND t.origin = 'manual' AND t.archived = 0", s.workspaceId);
    assert.equal(steps.length, 4);
    assert.ok(steps.some((x) => x.title.includes('Lançar a campanha de verão')));
    assert.equal((await req(h, 'GET', '/api/me', s)).json.onboarding, 'done');
    // reiniciar o servidor não desfaz o perfil
    ensureSectors(h.db, null, s.workspaceId);
    assert.ok((await req(h, 'GET', '/api/state', s)).json.sectors.some((x: { name: string }) => x.name === 'Criação'));
    // encaminhamento pelas funções novas
    assert.equal(routeTo(activeTeam(h.db, s.workspaceId), 'Preciso de um texto para o anúncio')?.member.char_key, 'herodoto');
  });

  test('refazer como uso pessoal: equipe menor, sem duplicar os primeiros passos', async () => {
    const r = await req(h, 'POST', '/api/onboarding', s, { use: 'pessoal', niche: 'outro' });
    assert.equal(r.json.preset.key, 'pessoal');
    assert.equal(r.json.team.length, 8);
    assert.equal(byChar(h, s.workspaceId, 'socrates').status, 'archived', 'fora do perfil, dá para reativar');
    assert.equal(reviewerOf(activeTeam(h.db, s.workspaceId))?.char_key, 'platao', 'alguém continua podendo revisar');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.workspace_id = ? AND b.audience = 'user' AND t.origin = 'manual' AND t.archived = 0", s.workspaceId)!.n, 4);
  });

  test('preferências: dicas dispensadas, desligar e trazer de volta; pular as perguntas', async () => {
    assert.deepEqual((await req(h, 'PUT', '/api/me/prefs', s, { dismiss: ['agentes.intro'] })).json.dismissed, ['agentes.intro']);
    const p = (await req(h, 'PUT', '/api/me/prefs', s, { tips: false, tourDone: true })).json;
    assert.deepEqual(p, { tips: false, dismissed: ['agentes.intro'], tourDone: true });
    assert.deepEqual((await req(h, 'PUT', '/api/me/prefs', s, { resetTips: true, tips: true })).json.dismissed, []);
    h.db.run("UPDATE workspace_settings SET value = 'pending' WHERE workspace_id = ? AND key = 'onboarding'", s.workspaceId);
    assert.equal((await req(h, 'POST', '/api/onboarding/skip', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.onboarding, 'done');
    h.db.run("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = 'onboarding'", s.workspaceId);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.onboarding, 'done', 'workspaces de antes do onboarding não são interrompidos');
  });
});

describe('boas-vindas com a conta de IA já conectada', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('sem o passo de conectar a conta nas primeiras tarefas', async () => {
    const r = await req(h, 'POST', '/api/onboarding', s, { use: 'dev', niche: 'programacao', aiConnected: true });
    assert.equal(r.json.preset.key, 'programacao');
    const titles = h.db.all<{ title: string }>("SELECT t.title FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.workspace_id = ? AND b.audience = 'user' AND t.origin = 'manual' AND t.archived = 0", s.workspaceId).map((x) => x.title);
    assert.equal(titles.length, 3);
    assert.ok(!titles.some((t) => t.includes('Conectar uma conta de IA')));
  });
});
