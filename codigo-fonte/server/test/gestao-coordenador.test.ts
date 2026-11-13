/**
 * Gestão pelo coordenador (rc.29, services/gestao.ts): o coordenador gerencia e configura o Ergon pelas ferramentas de
 * gestão do complemento do motor, pela ponte interna /internal/bridge/v1/gestao. Cada ação roda a MESMA rota da tela,
 * com a sessão da pessoa da conversa; o que muda configuração abre um cartão antes; o bilhete interno não vale de fora;
 * outra pessoa não vê nem decide o cartão; só o coordenador tem as ferramentas; segredo nunca passa.
 * O motor é falso e fica "rodando" para a ponte reconhecer a sessão (como em conexoes-cartao.test.ts).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { ACOES, Gestao } from '../src/services/gestao.ts';
import { pedidoDoPerfil } from '../src/services/perfis.ts';
import type { RunRow } from '../src/services/runs.ts';
import { resumirEsquema } from '../src/services/gestao-esquema.ts';
import { cardLeu, marcarRun } from '../src/services/conexoes/marca.ts';
import { emPt, TEXTOS, type Texto } from '../src/lib/textos.ts';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_teste${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

let h: Harness; let s: Session; let motor: Motor; let coord: string; let colega: string;
const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/gestao', null, corpo, { 'x-ergon-bridge-token': TOKEN })).json;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
async function conversar(agente: string, texto = 'oi'): Promise<{ sessao: string; conv: string; run: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!;
  return { sessao: r.hermes_session_id, conv: conv.id, run: r.id };
}
const executar = (sessao: string, acao: string, parametros: Record<string, unknown> = {}) => ponte({ op: 'executar', session_id: sessao, acao, parametros });
const cartoes = () => h.db.all<{ id: string; summary: string; status: string; result: string | null; conversation_id: string | null }>("SELECT id, summary, status, result, conversation_id FROM agent_proposals WHERE kind = 'gestao' ORDER BY created_at, rowid");

describe('gestão pelo coordenador', () => {
  beforeEach(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
    s = await setupOwner(h);
    coord = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 1", s.workspaceId)!.id;
    colega = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0 ORDER BY created_at LIMIT 1", s.workspaceId)!.id;
  });
  afterEach(() => h.close());

  test('listar: as áreas e, por área, as ações com os campos da própria rota e se pedem aprovação', async () => {
    const { sessao } = await conversar(coord);
    const areas = await ponte({ op: 'listar', session_id: sessao });
    assert.equal(areas.ok, true);
    for (const a of ['tarefas', 'equipe', 'competencias', 'conexoes', 'rotinas', 'ajustes', 'modelos', 'canais']) assert.match(areas.texto, new RegExp(`- ${a}:`));
    const equipe = (await ponte({ op: 'listar', session_id: sessao, area: 'equipe' })).texto as string;
    assert.match(equipe, /agente\.criar — Criar um agente \(pede aprovação\)/);
    assert.match(equipe, /name\*: texto \(até 40\)/, 'o esquema da rota da tela, com o obrigatório');
    assert.match(equipe, /equipe\.ver — Ver a equipe \(direto\)/);
    // toda ação do catálogo existe nesta instalação (a rota da tela está registrada)
    const todas = ((await ponte({ op: 'listar', session_id: sessao })).texto as string);
    for (const a of ACOES) assert.ok(todas.includes(a.id), `a ação ${a.id} aparece (rota ${a.metodo} ${a.rota})`);
  });

  test('só o coordenador gerencia; o colega recebe a recusa e a política não dá o conjunto a ele', async () => {
    const c = await conversar(colega);
    const r = await executar(c.sessao, 'equipe.ver');
    assert.equal(r.ok, false); assert.match(r.texto, /é da coordenação/);
    const polColega = (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: c.sessao }, { 'x-ergon-bridge-token': TOKEN })).json;
    assert.ok(!polColega.toolsets.includes('ergon_gestao'));
    const k = await conversar(coord);
    const polCoord = (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: k.sessao }, { 'x-ergon-bridge-token': TOKEN })).json;
    assert.ok(polCoord.toolsets.includes('ergon_gestao'), 'o coordenador tem as ferramentas de gestão');
    // o perfil do coordenador no motor leva a gestão; o dos colegas, não
    assert.equal(pedidoDoPerfil(h.db, s.workspaceId, coord)?.gestao, true);
    assert.equal(pedidoDoPerfil(h.db, s.workspaceId, colega)?.gestao, undefined);
    // sem a ponte (token errado), nada
    const sem = await req(h, 'POST', '/internal/bridge/v1/gestao', null, { op: 'listar', session_id: k.sessao }, { 'x-ergon-bridge-token': 'outro-token-qualquer-000000000' });
    assert.equal(sem.status, 401);
  });

  test('ver e criar card vão direto, pela rota da tela, com a sessão da pessoa e as mesmas validações', async () => {
    const { sessao } = await conversar(coord);
    const ver = await executar(sessao, 'equipe.ver');
    assert.equal(ver.status, 'feita');
    assert.ok(ver.texto.includes(coord), 'a lista da equipe, como a tela recebe');
    const criado = await executar(sessao, 'tarefa.criar', { title: 'Organizar o arquivo de contratos', agentId: colega });
    assert.equal(criado.status, 'feita', criado.texto);
    const novo = JSON.parse(criado.texto) as { id: string; title: string };
    assert.equal(novo.title, 'Organizar o arquivo de contratos');
    assert.ok(h.db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND workspace_id = ?', novo.id, s.workspaceId), 'o card existe'); assert.equal(cartoes().length, 0, 'criar card não pede cartão');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'gestao.direta' AND target_id = 'tarefa.criar'"), 'fica registrado');
    // a validação da rota vale: sem título, a tela recusa e o coordenador ouve o motivo
    const ruim = await executar(sessao, 'tarefa.criar', { description: 'sem título' });
    assert.equal(ruim.status, 'falhou'); assert.match(ruim.texto, /Não deu/);
    // identificador do caminho é conferido antes
    const semId = await executar(sessao, 'agente.ver', {});
    assert.equal(semId.status, 'falhou'); assert.match(semId.texto, /Falta o identificador "id"/);
    const outra = await executar(sessao, 'nao.existe');
    assert.match(outra.texto, /Não há a ação/);
  });

  test('mudar configuração abre o cartão antes; aplicar roda a rota com a sessão de quem clicou; o coordenador recebe o resultado', async () => {
    const { sessao, conv, run } = await conversar(coord, 'crie um agente de vendas');
    const antes = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId)!.n;
    const r = await executar(sessao, 'agente.criar', { name: 'Temístocles', role: 'Vendas e propostas comerciais', sectorKey: 'auto' });
    assert.equal(r.status, 'aguardando_confirmacao', r.texto);
    assert.match(r.cartao, /^apr_[0-9a-f]{32}$/); assert.match(r.texto, /nada muda|não repita/i);
    const [c] = cartoes();
    assert.equal(c.status, 'proposed'); assert.equal(c.conversation_id, conv);
    assert.match(c.summary, /quer: Criar um agente\./); assert.match(c.summary, /name: Temístocles/); assert.match(c.summary, /Nada muda até você aplicar/);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId)!.n, antes, 'nada mudou antes do clique');
    // o mesmo pedido de novo não abre outro cartão
    const de_novo = await executar(sessao, 'agente.criar', { name: 'Temístocles', role: 'Vendas e propostas comerciais', sectorKey: 'auto' });
    assert.equal(de_novo.cartao, c.id); assert.equal(cartoes().length, 1);
    // aparece em "Com você" com quem pediu
    const dec = (await req(h, 'GET', '/api/decisions', s)).json;
    assert.ok(dec.proposals.some((p: { id: string; kind: string }) => p.id === c.id && p.kind === 'gestao'));
    // o resumo vai também em código (a tela em inglês monta o cartão no idioma dela), e o português sai dele; o pedido não vai
    const naTela = dec.proposals.find((p: { id: string }) => p.id === c.id) as { summary: string; summary_t?: Texto; gestao_payload?: unknown; payload?: unknown };
    assert.ok(naTela.summary_t, 'summary_t'); assert.equal(emPt(naTela.summary_t), naTela.summary);
    assert.match(JSON.stringify(naTela.summary_t), /proposta\.gestao\.acao\.agente\.criar/);
    assert.equal(naTela.gestao_payload, undefined); assert.equal(naTela.payload, null);
    const naConversa = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json.find((p: { id: string }) => p.id === c.id);
    assert.equal(emPt(naConversa.summary_t), c.summary); assert.equal(naConversa.gestao_payload, undefined);
    // o resultado pela ponte, antes da decisão
    assert.equal((await ponte({ op: 'cartao', session_id: sessao, cartao: c.id })).status, 'aguardando_confirmacao');
    const ok = (await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'apply' })).json;
    assert.equal(ok.status, 'applied', JSON.stringify(ok));
    assert.ok(JSON.stringify((await req(h, 'GET', '/api/agents', s)).json).includes('Temístocles'), 'o agente foi criado pela rota da tela');
    assert.equal((await ponte({ op: 'cartao', session_id: sessao, cartao: c.id })).status, 'feita');
    // decidido sem o turno esperando no portão do motor: o coordenador recebe o resultado na mesma conversa
    const cont = h.db.get<{ input: string; idempotency_key: string }>("SELECT input, idempotency_key FROM runs WHERE conversation_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1", conv, run);
    assert.ok(cont, 'a continuação'); assert.match(cont!.input, /A pessoa aplicou/); assert.equal(cont!.idempotency_key, `gestao-${c.id}`);
    // não decide duas vezes
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'apply' })).status, 409);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'gestao.applied' AND target_id = ?", c.id));
  });

  test('recusar não muda nada e o coordenador fica sabendo; falha da rota fica no cartão como falhou', async () => {
    const { sessao } = await conversar(coord);
    const r = await executar(sessao, 'setor.criar', { name: 'Jurídico' });
    assert.equal(r.status, 'aguardando_confirmacao');
    const [c] = cartoes();
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    assert.ok(!JSON.stringify((await req(h, 'GET', '/api/sectors', s)).json).includes('Jurídico'), 'nenhum setor novo');
    assert.equal((await ponte({ op: 'cartao', session_id: sessao, cartao: c.id })).status, 'falhou');
    // a validação da rota vale também no clique (campo que a tela não aceita): falhou, com o motivo
    await executar(sessao, 'setor.criar', { name: 'Fiscal', cor: 'azul' });
    const ruim = cartoes().at(-1)!;
    const out = (await req(h, 'POST', `/api/proposals/${ruim.id}`, s, { decision: 'apply' })).json;
    assert.equal(out.status, 'failed');
    assert.ok(!JSON.stringify((await req(h, 'GET', '/api/sectors', s)).json).includes('Fiscal'));
  });

  test('isolamento: outra pessoa não decide o cartão; o bilhete interno não vale de fora; segredo nunca passa', async () => {
    const { sessao } = await conversar(coord);
    await executar(sessao, 'setor.criar', { name: 'Compras' });
    const [c] = cartoes();
    const outra = await addPerson(h, 'beatriz', 'senha-da-bia-123', 'Bia');
    const dela = await req(h, 'POST', `/api/proposals/${c.id}`, outra, { decision: 'apply' });
    assert.equal(dela.status, 404, 'o cartão de outra pessoa não existe para ela');
    assert.equal(cartoes()[0].status, 'proposed');
    // o bilhete só existe durante a chamada interna: de fora, qualquer valor é recusado (mesmo com uma sessão válida)
    const falso = crypto.randomBytes(32).toString('hex');
    assert.equal((await req(h, 'GET', '/api/agents', null, undefined, { 'x-ergon-gestao': falso })).status, 401);
    assert.equal((await req(h, 'GET', '/api/agents', s, undefined, { 'x-ergon-gestao': falso })).status, 401);
    assert.equal((await req(h, 'GET', '/api/agents', s, undefined, { 'x-ergon-gestao': 'curto' })).status, 401);
    // segredo nunca passa pela gestão, nem dentro dos campos de um conector
    const seg = await executar(sessao, 'conector.instalar', { nome: 'notion', campos: { NOTION_API_KEY: 'sk-123' } });
    assert.equal(seg.status, 'falhou'); assert.match(seg.texto, /segredo/);
    assert.equal(cartoes().length, 1, 'nenhum cartão com segredo');
  });

  test('travas: dar o Terminal pela gestão para no pedido de identidade da tela, mesmo depois do clique', async () => {
    const { sessao } = await conversar(coord);
    const r = await executar(sessao, 'agente.editar', { id: colega, tools: ['terminal'] });
    assert.equal(r.status, 'aguardando_confirmacao');
    const c = cartoes().at(-1)!;
    assert.match(c.summary, /tools: terminal/);
    const out = (await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'apply' })).json;
    assert.equal(out.status, 'failed');
    assert.match(out.result, /confirme a sua identidade: faça na própria tela/);
    const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', colega)!.tools) as string[];
    assert.ok(!tools.includes('terminal'), 'o Terminal continua só pelo cartão com a senha');
  });

  test('num card, a ação roda como quem pediu o card (membro), nunca como o dono do workspace', async () => {
    const membro = await addPerson(h, 'carla', 'senha-da-carla-123', 'Carla');
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, membro.userId, new Date().toISOString());
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord })).json as { id: string };
    h.db.run('UPDATE conversations SET owner_user_id = ? WHERE id = ?', membro.userId, conv.id);
    const card = (await req(h, 'POST', '/api/tasks', s, { title: 'Pedido da Carla' })).json as { id: string };
    h.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', conv.id, card.id);
    const g = new Gestao({ db: h.db, bus: { publish() {} } as never, rodar: async () => ({ status: 200, json: null }), temRota: () => true, extras: () => [], esquema: () => '' });
    const ctx = g.pessoa({ workspace_id: s.workspaceId, conversation_id: null, task_id: card.id });
    assert.equal(ctx?.userId, membro.userId, 'quem pediu o card');
    assert.equal(ctx?.role, 'member');
    // card sem conversa de origem, criado pelo membro no quadro: o membro (nunca o dono como reserva)
    const solto = (await req(h, 'POST', '/api/tasks', s, { title: 'Card solto' })).json as { id: string };
    h.db.run("UPDATE audit_events SET actor_id = ? WHERE action = 'task.create' AND target_id = ?", membro.userId, solto.id);
    assert.equal(g.pessoa({ workspace_id: s.workspaceId, conversation_id: null, task_id: solto.id })?.userId, membro.userId, 'quem criou o card');
    // ninguém conhecido (card que veio de fora, rotina): ninguém, e a gestão não roda
    h.db.run("UPDATE audit_events SET actor_type = 'system', actor_id = NULL WHERE action = 'task.create' AND target_id = ?", solto.id);
    assert.equal(g.pessoa({ workspace_id: s.workspaceId, conversation_id: null, task_id: solto.id }), null);
    assert.equal(g.pessoa({ workspace_id: s.workspaceId, conversation_id: null }), null);
  });

  test('treinar.comecar com links depois de ler conteúdo de fora vira cartão (não abre os links sozinho)', async () => {
    const { run } = await conversar(coord);
    const r = h.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', run)!;
    const chamadas: string[] = [];
    const mk = (livre: boolean) => new Gestao({ db: h.db, bus: { publish() {} } as never, rodar: async (_c, _m, url) => { chamadas.push(url); return { status: 201, json: { id: 'trn_x' } }; },
      temRota: () => true, extras: () => [], esquema: () => '', linksLivres: () => livre });
    const preso = await mk(false).executar(r, 'treinar.comecar', { id: colega, request: 'aprenda', links: ['https://atacante.exemplo/?d=segredo'] });
    assert.equal(preso.status, 'aguardando_confirmacao', preso.texto);
    assert.deepEqual(chamadas, [], 'nenhum link aberto sem o clique');
    assert.match(cartoes().at(-1)!.summary, /atacante.exemplo/, 'o cartão mostra os links');
    const semLinks = await mk(false).executar(r, 'treinar.comecar', { id: colega, request: 'aprenda sobre vendas' });
    assert.equal(semLinks.status, 'feita', 'sem links, começa direto como antes');
    const livre = await mk(true).executar(r, 'treinar.comecar', { id: colega, request: 'aprenda', links: ['https://docs.exemplo/guia'] });
    assert.equal(livre.status, 'feita');
  });

  test('o cartão mostra o texto inteiro que vai ser aplicado; arquivar um card pede cartão; segredo numa lista também é barrado', async () => {
    const { sessao } = await conversar(coord);
    const longo = `Instruções novas. ${'Responda sempre com a tabela de preços atualizada. '.repeat(80)}FIM-DO-TEXTO`;
    assert.ok(longo.length > 3000);
    const r = await executar(sessao, 'agente.editar', { id: colega, instructions: longo });
    assert.equal(r.status, 'aguardando_confirmacao', r.texto);
    const c = cartoes().at(-1)!;
    assert.ok(c.summary.includes('FIM-DO-TEXTO'), 'nada do que vai ser aplicado fica fora do cartão');
    assert.match(c.summary, /Nada muda até você aplicar\.$/);
    // arquivar é apagar da vista: cartão antes, mesmo sendo uma edição de card
    const card = await executar(sessao, 'tarefa.criar', { title: 'Card para arquivar' });
    const id = (JSON.parse(card.texto) as { id: string }).id;
    const arq = await executar(sessao, 'tarefa.editar', { id, archived: true });
    assert.equal(arq.status, 'aguardando_confirmacao');
    assert.equal(h.db.get<{ archived: number }>('SELECT archived FROM tasks WHERE id = ?', id)!.archived, 0, 'nada mudou antes do clique');
    const antes = cartoes().length;
    const seg = await executar(sessao, 'conector.instalar', { nome: 'notion', campos: { servidores: [{ env: { CLIENT_SECRET: 'x' } }] } });
    assert.equal(seg.status, 'falhou'); assert.match(seg.texto, /CLIENT_SECRET/);
    assert.equal(cartoes().length, antes, 'nenhum cartão com segredo');
  });

  test('card criado ou posto para trabalhar pela gestão herda a execução do coordenador (origem e o que ela leu)', async () => {
    const { sessao, run } = await conversar(coord);
    const r = h.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', run)!;
    marcarRun(h.db, r, { privado: true, motivo: 'teste/email' });
    const criado = await executar(sessao, 'tarefa.criar', { title: 'Card do e-mail', description: 'faça o que o e-mail mandou', agentId: colega });
    assert.equal(criado.status, 'feita', criado.texto);
    const id = (JSON.parse(criado.texto) as { id: string }).id;
    assert.equal(h.db.get<{ o: string }>('SELECT origin_run_id AS o FROM tasks WHERE id = ?', id)!.o, run, 'o card aponta para a execução que o criou');
    assert.equal(cardLeu(h.db, id).deFora, true, 'o card leva a marca do que o coordenador leu');
    // um card que a pessoa criou na tela, posto para trabalhar pelo coordenador marcado, também herda
    const daPessoa = (await req(h, 'POST', '/api/tasks', s, { title: 'Card da pessoa', agentId: colega })).json as { id: string };
    assert.equal(cardLeu(h.db, daPessoa.id).deFora, false);
    await executar(sessao, 'tarefa.trabalhar', { id: daPessoa.id });
    assert.equal(cardLeu(h.db, daPessoa.id).deFora, true, 'o trabalho do card não passa a contar como limpo');
  });

  test('afrouxar uma trava pela gestão só a pedido da pessoa sem nada de fora lido; apertar segue com cartão', async () => {
    const limpo = await conversar(coord);
    const ok = await executar(limpo.sessao, 'conexoes.liberar-tudo', { on: true });
    assert.equal(ok.status, 'aguardando_confirmacao', ok.texto);
    const lido = await conversar(coord);
    marcarRun(h.db, h.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', lido.run)!, { privado: true, motivo: 'teste/email' });
    const antes = cartoes().length;
    for (const [acao, p] of [['conexoes.liberar-tudo', { on: true }], ['conexoes.aprovar-depois-de-ler', { on: false }], ['capacidades.mudar', {}]] as const) {
      const r = await executar(lido.sessao, acao, p);
      assert.equal(r.status, 'falhou', `${acao}: ${r.texto}`); assert.match(r.texto, /Por segurança/);
    }
    assert.equal(cartoes().length, antes, 'nenhum cartão para afrouxar depois de ler conteúdo de fora');
    const aperta = await executar(lido.sessao, 'conexoes.aprovar-depois-de-ler', { on: true });
    assert.equal(aperta.status, 'aguardando_confirmacao', 'apertar a trava continua pelo cartão');
  });

  test('cada ação tem o rótulo no catálogo de textos, igual ao de ACOES (o cartão sai no idioma da tela)', () => {
    const faltam = ACOES.filter((a) => TEXTOS[`proposta.gestao.acao.${a.id}`] !== a.rotulo).map((a) => a.id);
    assert.deepEqual(faltam, []);
  });

  test('o resumo do esquema mostra opções, listas e o obrigatório', () => {
    const r = resumirEsquema({ body: { type: 'object', required: ['decision'], properties: { decision: { enum: ['apply', 'reject'] }, ids: { type: 'array', items: { type: 'string', pattern: '^agt_[0-9a-f]{32}$' } }, n: { type: 'integer', minimum: 1, maximum: 9 } } } }, 'POST');
    assert.match(r, /decision\*: "apply" \| "reject"/); assert.match(r, /ids: lista de id agt_…/); assert.match(r, /n: inteiro 1–9/);
    assert.equal(resumirEsquema(undefined, 'GET'), '');
  });
});
