/**
 * Equipe nativa (rc.27): cada agente é um perfil do motor por workspace (services/perfis.ts). Com um motor falso que segue
 * o contrato provado no Hermes de verdade (hermes/tests/test_ergon_bridge_perfis.py):
 * - o nome do perfil é estável e sai do workspace + agente;
 * - o perfil é criado na criação do agente e, para quem vem da rc.26, pela volta (migração idempotente e retomável, a partir
 *   de um banco no formato da rc.26, com as competências já treinadas indo junto);
 * - as execuções do agente vão para /p/<perfil>/ sem a identidade dele de novo nas instruções; o que é do momento continua;
 * - a conversa (ou o card) que já começou num perfil continua nele; a conversa antiga muda depois de parada, com as
 *   últimas mensagens;
 * - perfil que sumiu no motor volta a pendente e o pedido segue no padrão;
 * - os ajudantes temporários: a execução espera e continua com o resultado;
 * - a política de ferramentas libera memória, busca e ajudantes só nas execuções do perfil.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HermesError, type HermesClient, type HermesControlClient, type PedidoDePerfil, type RemoteRun, type StartRun } from '../src/services/hermes.ts';
import { ajudantesDo, extrasDoPerfil, nomeDoPerfil, pedidoDoPerfil } from '../src/services/perfis.ts';
import { almaDoAgente, CONVERSA_MUDA_MS } from '../src/services/runs.ts';
import { allAgents, harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

class Motor implements HermesClient {
  started: Array<StartRun & { runId: string }> = [];
  runs = new Map<string, RemoteRun>();
  perfis = new Map<string, PedidoDePerfil>();
  pedidosDePerfil: string[] = [];
  semPerfis = false;
  falharPerfil = 0;
  async health() { return { ok: true, detail: 'falso' }; }
  async startRun(p: StartRun) {
    if (p.profile && !this.perfis.has(p.profile)) throw new HermesError(404, 'Unknown or unconfigured profile');
    const runId = `run_${String(this.started.length + 1).padStart(6, '0')}`;
    this.started.push({ ...p, runId });
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sess_${runId}`, usage: null });
    return { runId, replayed: false };
  }
  async getRun(id: string): Promise<RemoteRun> { const r = this.runs.get(id); if (!r) throw new HermesError(404, 'x'); return r; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  terminar(runId: string, output: string) { this.runs.set(runId, { status: 'completed', output, error: null, sessionId: `sess_${runId}`, usage: null }); }
  control(): HermesControlClient {
    const self = this;
    return {
      async health() { return true; },
      async info() { return { ok: true, pluginVersion: '0.5.0', vaultConfig: 4, capacidades: ['conexoes', 'perfis', 'memoria', 'ajudantes'] }; },
      async accounts() { return []; }, async startLogin() { throw new Error('x'); }, async pollLogin() { throw new Error('x'); },
      async cancelLogin() {}, async disconnect() {}, async modelInfo() { return { model: null, provider: null }; },
      async setDefaultModel() { return { ok: true, confirmMessage: null }; }, async skills() { return []; },
      async apiToolsets() { return { enabled: ['todo', 'web', 'skills', 'ergon_conexoes'], safe: [] }; }, async setApiToolsets(e: string[]) { return e; },
      async perfil(nome: string, pedido: PedidoDePerfil) {
        if (self.semPerfis) throw new HermesError(404, 'rota não liberada pela ponte do Ergon');
        if (self.falharPerfil > 0) { self.falharPerfil--; throw new HermesError(503, 'a equipe de IA não respondeu agora'); }
        self.pedidosDePerfil.push(nome);
        const criado = !self.perfis.has(nome);
        self.perfis.set(nome, pedido);
        return { criado, mudou: criado ? ['criado'] : ['alma'] };
      },
    };
  }
}

async function montar(motor = new Motor()): Promise<{ h: Harness; s: Session; motor: Motor }> {
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: PONTE }, { hermes: motor, control: motor.control() });
  const s = await setupOwner(h);
  return { h, s, motor };
}
const PONTE = 'token-da-ponte-de-teste-' + '0123456789';
const ticks = async (h: Harness, n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };

describe('equipe nativa: um perfil do motor por agente e por workspace', () => {
  test('nome do perfil: estável, no formato do plugin, diferente por workspace e por agente', () => {
    const a = nomeDoPerfil('ws_1', 'agt_1');
    assert.match(a, /^erg-[0-9a-f]{20}$/);
    assert.equal(a, nomeDoPerfil('ws_1', 'agt_1'));
    assert.notEqual(a, nomeDoPerfil('ws_2', 'agt_1'), 'o mesmo agente em outro workspace: outra memória');
    assert.notEqual(a, nomeDoPerfil('ws_1', 'agt_2'));
  });

  test('a volta cria o perfil de cada agente; a segunda volta não manda nada; mudou o agente, manda só ele', async () => {
    const { h, s, motor } = await montar();
    const agentes = await allAgents(h, s);
    const n = await h.perfis.emDia(s.workspaceId, 100);
    assert.equal(n, agentes.length);
    assert.equal(motor.perfis.size, agentes.length);
    for (const a of agentes) assert.ok(h.perfis.perfilPronto(s.workspaceId, a.id), a.name);
    const p = motor.perfis.get(nomeDoPerfil(s.workspaceId, agentes[0].id))!;
    assert.equal(p.alma, almaDoAgente(h.db, s.workspaceId, agentes[0].id), 'o SOUL é a identidade do agente');
    assert.match(p.alma, new RegExp(`^Você é ${agentes[0].name}`));
    assert.deepEqual([p.memoria, p.busca, p.ajudantes], [true, true, { ligado: true, max: 10 }], 'memória, busca e ajudantes ligados (com aprovação; ajudantes com o máximo do motor)');
    motor.pedidosDePerfil.length = 0;
    assert.equal(await h.perfis.emDia(s.workspaceId, 100), 0, 'em dia: nada a mandar');
    assert.deepEqual(motor.pedidosDePerfil, []);
    // a pessoa mudou as instruções de um agente: só ele vai de novo
    h.db.run('UPDATE agents SET charter = ? WHERE id = ?', 'Você agora cuida só de contratos.', agentes[1].id);
    await h.perfis.emDia(s.workspaceId, 100);
    assert.deepEqual(motor.pedidosDePerfil, [nomeDoPerfil(s.workspaceId, agentes[1].id)]);
    assert.match(motor.perfis.get(nomeDoPerfil(s.workspaceId, agentes[1].id))!.alma, /cuida só de contratos/);
    await h.close();
  });

  test('agente novo: o perfil é criado logo, sem esperar a volta', async () => {
    const { h, s, motor } = await montar();
    await h.perfis.emDia(s.workspaceId, 100);
    const antes = motor.perfis.size;
    const r = await req(h, 'POST', '/api/agents', s, { name: 'Teano', role: 'Revisora de textos', sectorKey: 'auto' });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    const novo = r.json.id ?? r.json.agent?.id;
    for (let i = 0; i < 40 && !h.perfis.perfilPronto(s.workspaceId, novo); i++) await new Promise((x) => setTimeout(x, 50));
    assert.ok(h.perfis.perfilPronto(s.workspaceId, novo), 'criado na criação do agente');
    assert.equal(motor.perfis.size, antes + 1);
    await h.close();
  });

  test('execução no perfil: sem a identidade de novo nas instruções; o do momento continua; a conversa fica no perfil', async () => {
    const { h, s, motor } = await montar();
    const agentes = await allAgents(h, s);
    const ag = agentes.find((a) => !a.coordinator) ?? agentes[1];
    await h.perfis.emDia(s.workspaceId, 100);
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    const m = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Olá', clientRequestId: 'req-perfil-0001' })).json;
    await ticks(h);
    const st = motor.started.at(-1)!;
    assert.equal(st.profile, nomeDoPerfil(s.workspaceId, ag.id));
    const alma = almaDoAgente(h.db, s.workspaceId, ag.id);
    const inteiras = h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE id = ?', m.runId)!.instructions;
    assert.ok(inteiras.startsWith(alma), 'o Ergon guarda as instruções inteiras');
    assert.ok(!st.instructions.includes(alma) && st.instructions.length < inteiras.length, 'a identidade já está no perfil: não vai de novo');
    assert.ok(st.instructions.includes('Para o usuário, você é um agente do Ergon'), 'as regras do pedido continuam');
    assert.equal(h.db.get<{ p: string }>('SELECT hermes_profile AS p FROM runs WHERE id = ?', m.runId)!.p, st.profile);
    motor.terminar(st.runId, 'Oi!');
    await ticks(h, 1);
    // a política de ferramentas: no perfil, memória, busca e ajudantes
    const pol = await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: `sess_${st.runId}`, task_id: '' }, { 'x-ergon-bridge-token': PONTE });
    assert.equal(pol.status, 200, JSON.stringify(pol.json));
    assert.equal(pol.json.known, true);
    assert.ok(['memory', 'session_search', 'delegation'].every((t) => pol.json.toolsets.includes(t)), JSON.stringify(pol.json.toolsets));
    // a mesma conversa continua no perfil
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'E agora?', clientRequestId: 'req-perfil-0002' });
    await ticks(h);
    assert.equal(motor.started.at(-1)!.profile, st.profile);
    await h.close();
  });

  test('conversa de antes (perfil padrão): continua lá; parada há dias, passa ao perfil com as últimas mensagens', async () => {
    const { h, s, motor } = await montar();
    const agentes = await allAgents(h, s);
    const ag = agentes.find((a) => !a.coordinator) ?? agentes[1];
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    // a primeira mensagem antes do perfil existir (rc.26: tudo no padrão)
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Meu cliente se chama PALAVRA-RARA-ZEBRA', clientRequestId: 'req-antiga-0001' });
    await ticks(h);
    assert.equal(motor.started.at(-1)!.profile ?? null, null);
    motor.terminar(motor.started.at(-1)!.runId, 'Anotado.');
    await ticks(h, 1);
    await h.perfis.emDia(s.workspaceId, 100);
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'E então?', clientRequestId: 'req-antiga-0002' });
    await ticks(h);
    const segunda = motor.started.at(-1)!;
    assert.equal(segunda.profile ?? null, null, 'conversa em andamento: continua onde começou (o motor guarda o fio por sessão)');
    motor.terminar(segunda.runId, 'Certo.');
    await ticks(h, 1);
    // parada há mais de CONVERSA_MUDA_MS: muda para o perfil, levando as últimas mensagens
    const velho = new Date(Date.now() - CONVERSA_MUDA_MS - 60_000).toISOString();
    h.db.run('UPDATE runs SET created_at = ?, started_at = ?, finished_at = ? WHERE conversation_id = ?', velho, velho, velho, c);
    await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Voltei', clientRequestId: 'req-antiga-0003' });
    await ticks(h);
    const terceira = motor.started.at(-1)!;
    assert.equal(terceira.profile, nomeDoPerfil(s.workspaceId, ag.id));
    assert.match(terceira.instructions, /PALAVRA-RARA-ZEBRA/, 'as últimas mensagens vão junto');
    assert.doesNotMatch(terceira.instructions.split('últimas mensagens dela')[1] ?? '', /Pessoa: Voltei/, 'o pedido de agora não se repete no resumo');
    await h.close();
  });

  test('perfil que sumiu no motor: volta a pendente, o pedido segue no padrão e a volta recria', async () => {
    const { h, s, motor } = await montar();
    const ag = (await allAgents(h, s))[1];
    await h.perfis.emDia(s.workspaceId, 100);
    motor.perfis.delete(nomeDoPerfil(s.workspaceId, ag.id)); // o cofre foi recriado, por exemplo
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    const m = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Oi', clientRequestId: 'req-sumiu-0001' })).json;
    await ticks(h, 4);
    assert.equal(h.perfis.perfilPronto(s.workspaceId, ag.id), null);
    const st = motor.started.at(-1)!;
    assert.equal(st.profile ?? null, null, 'foi no padrão, com as instruções inteiras');
    assert.ok(st.instructions.startsWith(almaDoAgente(h.db, s.workspaceId, ag.id)));
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', m.runId)!.status, 'running');
    await h.perfis.emDia(s.workspaceId, 100);
    assert.ok(motor.perfis.has(nomeDoPerfil(s.workspaceId, ag.id)), 'recriado');
    await h.close();
  });

  test('motor sem perfis (plugin de antes) e falha no meio: tudo no padrão; depois, retoma de onde parou', async () => {
    const motor = new Motor();
    motor.semPerfis = true;
    const { h, s } = await montar(motor);
    assert.equal(await h.perfis.emDia(s.workspaceId, 100), 0);
    const ag = (await allAgents(h, s))[0];
    assert.equal(h.perfis.perfilPronto(s.workspaceId, ag.id), null);
    motor.semPerfis = false;
    // o aviso "sem suporte" segura as tentativas um tempo; passado, retoma
    (h.perfis as unknown as { semSuporte: Map<string, number> }).semSuporte.clear();
    motor.falharPerfil = 1;
    const n1 = await h.perfis.emDia(s.workspaceId, 3);
    assert.equal(n1, 2, 'o primeiro falhou, os outros dois foram');
    const total = (await allAgents(h, s)).length;
    let n = n1;
    for (let i = 0; i < 10 && n < total; i++) n += await h.perfis.emDia(s.workspaceId, 3);
    assert.equal(n, total, 'retomável: termina, inclusive o que falhou');
    assert.equal(motor.perfis.size, total);
    await h.close();
  });

  test('ajudantes temporários: a execução espera o ajudante e continua na mesma sessão com o resultado dele', async () => {
    const { h, s, motor } = await montar();
    const ag = (await allAgents(h, s))[1];
    await h.perfis.emDia(s.workspaceId, 100);
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: ag.id })).json.id;
    const m = (await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'Leia as cinco fontes', clientRequestId: 'req-ajud-0001' })).json;
    await ticks(h);
    const pai = motor.started.at(-1)!;
    h.executor.ajudanteComecou(m.runId, 'filho-1');
    motor.terminar(pai.runId, 'Chamei um ajudante; aguardando.');
    await ticks(h, 2);
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', m.runId)!.status, 'running', 'não entrega o "aguardando"');
    assert.equal(motor.started.length, 1);
    h.executor.ajudanteTerminou(m.runId, 'filho-1', 'completed', 'Resumo das fontes: MARCA-AJUDANTE');
    await ticks(h, 1);
    const cont = motor.started.at(-1)!;
    assert.equal(motor.started.length, 2, 'continua');
    assert.equal(cont.sessionKey, pai.sessionKey, 'na mesma conversa do motor');
    assert.equal(cont.profile, pai.profile);
    assert.match(cont.input, /MARCA-AJUDANTE/);
    motor.terminar(cont.runId, 'Entrega final.');
    await ticks(h, 2);
    const fim = h.db.get<{ status: string; output: string }>('SELECT status, output FROM runs WHERE id = ?', m.runId)!;
    assert.deepEqual([fim.status, fim.output], ['succeeded', 'Entrega final.'], 'a conversa recebe só a entrega final');
    await h.close();
  });

  test('ajudantes: ligados por padrão com o máximo do motor; a escolha da pessoa (desligar, quantos ao mesmo tempo) vale para o perfil', async () => {
    const { h, s, motor } = await montar();
    assert.deepEqual(ajudantesDo(h.db, s.workspaceId), { ligado: true, max: 10 }, 'ausente = ligado, com o máximo');
    h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'ajudantes.v1', ?, ?)", s.workspaceId, JSON.stringify({ max: 4 }), new Date().toISOString());
    assert.deepEqual(ajudantesDo(h.db, s.workspaceId), { ligado: true, max: 4 }, 'sem o "ligado" gravado: ligado');
    assert.equal((await req(h, 'PUT', '/api/team/ajudantes', s, { ligado: true, max: 99 })).status, 400, 'teto');
    assert.equal((await req(h, 'PUT', '/api/team/ajudantes', s, { ligado: true, max: 11 })).status, 400, 'acima do máximo do motor');
    const r = await req(h, 'PUT', '/api/team/ajudantes', s, { ligado: false, max: 3 });
    assert.deepEqual(r.json, { ligado: false, max: 3 });
    assert.deepEqual((await req(h, 'GET', '/api/state', s)).json.teamAjudantes, { ligado: false, max: 3 });
    await h.perfis.emDia(s.workspaceId, 100);
    const ag = (await allAgents(h, s))[0];
    assert.deepEqual(motor.perfis.get(nomeDoPerfil(s.workspaceId, ag.id))!.ajudantes, { ligado: false, max: 3 });
    assert.ok(!extrasDoPerfil(h.db, s.workspaceId).includes('delegation'), 'a pessoa desligou: fica desligado');
    await h.close();
  });
});

describe('migração de quem vem da rc.26', () => {
  test('banco no formato da rc.26: migra, os agentes ganham perfis com as competências treinadas, cards e conversas ficam', async () => {
    const dir = tmpDir();
    let cartas = 0; let conversas = 0;
    // um banco parado na última migração da rc.26, com um workspace de verdade criado pela versão atual e depois "voltado"
    {
      const motor = new Motor();
      motor.semPerfis = true; // como uma instalação da rc.26: nenhum perfil
      const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { dir, hermes: motor, control: motor.control() });
      const s = await setupOwner(h);
      const ag = (await allAgents(h, s))[1];
      h.db.run(`INSERT INTO agent_skills (id, workspace_id, agent_id, name, title, description, status, version, uses, created_at, updated_at)
        VALUES ('skl_teste000000000001', ?, ?, 'ergon-relatorio-mensal', 'Relatório mensal', 'Como fazer', 'ativa', 1, 0, ?, ?)`, s.workspaceId, ag.id, new Date().toISOString(), new Date().toISOString());
      // o que a rc.26 não tinha: sai (a migração 0041 roda de novo na abertura)
      h.db.run('DROP TABLE agent_profiles');
      h.db.run('ALTER TABLE runs DROP COLUMN hermes_profile');
      h.db.run("DELETE FROM schema_migrations WHERE name = '0041_equipe_nativa.sql'");
      cartas = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n;
      conversas = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n;
      await h.close();
    }
    const motor = new Motor();
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { dir, hermes: motor, control: motor.control() });
    assert.ok(h.db.get("SELECT 1 AS x FROM schema_migrations WHERE name = '0041_equipe_nativa.sql'"), 'migração aplicada');
    const ws = h.db.get<{ id: string }>('SELECT id FROM workspaces LIMIT 1')!.id;
    const agentes = h.db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active'", ws);
    let n = 0;
    for (let i = 0; i < 20 && n < agentes.length; i++) n += await h.perfis.emDia(ws, 5);
    assert.equal(n, agentes.length, 'todos os agentes de antes ganharam o perfil');
    const comCompetencia = [...motor.perfis.values()].filter((p) => p.competencias.includes('ergon-relatorio-mensal'));
    assert.equal(comCompetencia.length, 1, 'a competência treinada vai para o perfil do agente dela, e só dele');
    assert.equal(await h.perfis.emDia(ws, 100), 0, 'idempotente: de novo, nada');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks')!.n, cartas, 'cards ficam');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, conversas, 'conversas ficam');
    const pedido = pedidoDoPerfil(h.db, ws, agentes[0].id)!;
    assert.ok(pedido.alma.length > 20);
    await h.close();
  });
});
