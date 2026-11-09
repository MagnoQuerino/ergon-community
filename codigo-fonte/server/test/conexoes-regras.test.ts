/**
 * Regras aprovadas pela pessoa (rc.26): "podem mandar os e-mails sem me pedir aprovação" vira um cartão com o alcance (só
 * neste pedido, por 24 h, sempre); um clique aplica, e a regra vale de verdade na decisão das conexões — inclusive em cards
 * da equipe e depois de ler conteúdo de fora. Apagar continua pedindo, a menos que a regra fale em apagar. "Por 24 h" expira
 * sozinha; "Desfazer" em Conexões › Regras volta a pedir. O que já esperava confirmação e a regra cobre sai no clique.
 * A conta de teste é a Microsoft (o envio de e-mail simulado); o motor é falso e fica "rodando" para a ponte reconhecer a sessão.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { ESCOPOS_MICROSOFT } from '../src/services/conexoes/acoes/microsoft.ts';
import { decidir } from '../src/services/conexoes/regra.ts';
import { cadeiaDoPedido, descreverRegra, parseRegras, PEDIDO_SEGUE_MS, regraDaFrase, resumoDaProposta, soLiberacao, sugestaoDoAgente } from '../src/services/conexoes/regras.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { parseProposals, recordProposals } from '../src/services/proposals.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-regras-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_regras${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

// ------------------------------------------------------------------------------------- Microsoft simulada
let enviados: string[] = [];
let apagados: string[] = [];
const realFetch = globalThis.fetch;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function falso(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.host !== 'graph.microsoft.com') return realFetch(input, init);
  const method = init.method ?? 'GET';
  if (url.pathname === '/v1.0/me/sendMail' && method === 'POST') {
    enviados.push((JSON.parse(String(init.body)) as { message: { toRecipients: Array<{ emailAddress: { address: string } }> } }).message.toRecipients.map((r) => r.emailAddress.address).join(','));
    return Promise.resolve(new Response(null, { status: 202 }));
  }
  const move = /^\/v1\.0\/me\/messages\/([^/]+)\/move$/.exec(url.pathname);
  if (move && method === 'POST') { apagados.push(move[1]); return Promise.resolve(json({ id: `${move[1]}-lixeira` })); }
  const msg = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(url.pathname);
  if (msg) return Promise.resolve(json({ id: msg[1], subject: 'Promoção', from: { emailAddress: { name: 'Loja', address: 'loja@exemplo.test' } }, receivedDateTime: '2026-11-08T10:00:00Z' }));
  return Promise.resolve(json({ value: [] }));
}
before(() => { globalThis.fetch = falso as typeof fetch; setHttpClock({ sleep: async () => undefined, jitter: () => 0 }); });
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session; let motor: Motor; let coord: string; let colega: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
beforeEach(async () => {
  enviados = []; apagados = [];
  motor = new Motor();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
  s = await setupOwner(h);
  coord = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", s.workspaceId)!.id;
  colega = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 0 AND status = 'active' ORDER BY created_at LIMIT 1", s.workspaceId)!.id;
  for (const a of [coord, colega]) {
    const tools = JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', a)!.tools ?? '[]') as string[];
    if (!tools.includes('contas')) h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...tools, 'contas']), a);
  }
  h.integrations.secrets.writeOwn(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3_600_000,
    account: 'ana@empresa.test', tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pessoal: false, granted: Object.values(ESCOPOS_MICROSOFT).flat().join(' ') });
  setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'ana@empresa.test', connected_at: new Date().toISOString() });
});
afterEach(() => h.close());

const ponte = (corpo: Record<string, unknown>) => req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': TOKEN });
type Run = { id: string; workspace_id: string; agent_id: string; conversation_id: string | null; task_id: string | null; idempotency_key: string; hermes_session_id: string };
const runDe = (id: string) => h.db.get<Run>('SELECT id, workspace_id, agent_id, conversation_id, task_id, idempotency_key, hermes_session_id FROM runs WHERE id = ?', id)!;
/** Uma mensagem da pessoa numa conversa (nova, ou a mesma): a execução fica rodando no motor. */
async function conversar(texto: string, agentId = coord, conv?: string): Promise<{ conv: string; run: Run }> {
  const c = conv ?? (await req(h, 'POST', '/api/conversations', s, { agentId })).json.id as string;
  await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string }>('SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', c)!;
  return { conv: c, run: runDe(r.id) };
}
const enviar = async (r: Run, para: string) => (await ponte({ op: 'executar', session_id: r.hermes_session_id, conexao: 'microsoft', acao: 'email.enviar', parametros: { para: [para], assunto: 'Convite', texto: `Olá, ${para}` } })).json as { status: string; texto: string };
const apagar = async (r: Run, id: string) => (await ponte({ op: 'executar', session_id: r.hermes_session_id, conexao: 'microsoft', acao: 'email.apagar', parametros: { id } })).json as { status: string; texto: string };
const cartoesRegra = () => h.db.all<{ id: string; status: string; summary: string; payload: string; result: string | null; run_id: string | null; conversation_id: string | null }>("SELECT id, status, summary, payload, result, run_id, conversation_id FROM agent_proposals WHERE kind = 'regra' ORDER BY created_at, rowid");
const confirmacoes = () => h.db.all<{ id: string; status: string }>("SELECT id, status FROM agent_proposals WHERE kind = 'conexao' ORDER BY created_at, rowid");
const aplicar = (id: string, alcance?: string) => req(h, 'POST', `/api/proposals/${id}`, s, { decision: 'apply', ...(alcance ? { alcance } : {}) });
/** Execução que não partiu da pessoa (uma rotina) e que leu conteúdo de fora: sem regra, todo envio pede confirmação. */
async function deFora(texto = 'rotina'): Promise<Run> {
  const { run } = await conversar(texto, colega);
  h.db.run('UPDATE runs SET idempotency_key = ? WHERE id = ?', `routine-${crypto.randomUUID()}`, run.id);
  h.conexoes.marcar(run, { privado: true, motivo: 'teste' });
  return runDe(run.id);
}

describe('a frase da pessoa vira a proposta, com o alcance certo', () => {
  test('por regras: e-mail, outra conta, apagar, alcance e o que não é pedido', () => {
    assert.deepEqual(regraDaFrase('Podem mandar os e-mails sem me pedir aprovação', ['microsoft', 'asana']), { kind: 'regra', riscos: ['enviar'], conexoes: ['microsoft'], so: 'email', alcance: 'pedido' });
    assert.equal(regraDaFrase('A partir de agora, podem enviar os emails sem a minha confirmação', ['microsoft'])?.alcance, 'sempre');
    assert.equal(regraDaFrase('pode mandar as mensagens sem me perguntar, sempre', ['google'])?.alcance, 'sempre');
    assert.equal(regraDaFrase('Hoje vocês podem responder no Slack sem esperar a minha aprovação', ['slack', 'microsoft'])?.alcance, '24h');
    assert.deepEqual(regraDaFrase('Hoje vocês podem responder no Slack sem esperar a minha aprovação', ['slack'])?.conexoes, ['slack']);
    assert.deepEqual(regraDaFrase('podem mandar os e-mails sem precisar da minha aprovação', ['microsoft', 'google'])?.conexoes, ['microsoft', 'google'], 'e-mail sem dizer qual conta: as duas de e-mail');
    assert.deepEqual(regraDaFrase('enviem as mensagens sem pedir confirmação', [])?.conexoes, ['*'], 'mensagens sem dizer onde: todas');
    assert.equal(regraDaFrase('enviem as mensagens sem pedir confirmação', [])?.so, null);
    assert.deepEqual(regraDaFrase('podem mandar e apagar os e-mails sem me perguntar', ['microsoft'])?.riscos, ['enviar', 'apagar'], 'apagar só quando ela fala');
    assert.deepEqual(regraDaFrase('não precisa me pedir aprovação para enviar o e-mail', ['microsoft'])?.riscos, ['enviar']);
    assert.equal(regraDaFrase('não mandem nada sem a minha aprovação', ['microsoft']), null, 'o contrário');
    assert.equal(regraDaFrase('por que vocês mandaram sem aprovação?', ['microsoft']), null, 'pergunta sobre o que passou');
    assert.equal(regraDaFrase('mande o e-mail para a Ana', ['microsoft']), null, 'pedido comum');
    assert.equal(regraDaFrase('mande o relatório sem erros', ['microsoft']), null);
    // a negação vale só para o verbo dela: a ressalva não derruba a liberação, e o verbo negado sai da lista
    const soEmail = { kind: 'regra', riscos: ['enviar'], conexoes: ['microsoft'], so: 'email', alcance: 'pedido' };
    assert.deepEqual(regraDaFrase('Podem mandar os e-mails sem me pedir aprovação, mas não apaguem nada', ['microsoft']), soEmail);
    assert.deepEqual(regraDaFrase('podem mandar os e-mails sem me pedir aprovação, mas nunca apaguem nada', ['microsoft']), soEmail);
    assert.deepEqual(regraDaFrase('Pode enviar os e-mails sem me pedir aprovação. Não precisa criar card.', ['microsoft']), soEmail);
    assert.deepEqual(regraDaFrase('Não esperem, podem enviar os e-mails sem me pedir aprovação', ['microsoft']), soEmail, 'a negação não passa da vírgula');
    assert.deepEqual(regraDaFrase('podem mandar e apagar os e-mails sem me perguntar, mas não apaguem os do banco', ['microsoft'])?.riscos, ['enviar'], 'o verbo negado sai');
    // pergunta ou reclamação sobre o que já passou não libera nada
    assert.equal(regraDaFrase('quem mandou enviar sem a minha aprovação?', ['microsoft']), null);
    assert.equal(regraDaFrase('Por que enviaram os e-mails sem me perguntar', ['microsoft']), null);
    assert.equal(regraDaFrase('podem mandar os e-mails sem me pedir aprovação?', ['microsoft']), null, 'pergunta');
    // sem canal nenhum (nem e-mail, nem mensagem, nem conta), "todas as conexões" seria um chute; o verbo é o da expressão
    assert.equal(regraDaFrase('pode criar os cards sem me perguntar', ['microsoft']), null);
    assert.equal(regraDaFrase('decida o horário sem me consultar e mande o convite', ['microsoft']), null);
    assert.equal(regraDaFrase('decida o horário sem me consultar e mande o e-mail', ['microsoft']), null, 'o envio não está ligado à expressão');
    assert.deepEqual(regraDaFrase('vocês estão liberados a mandar os e-mails', ['microsoft'])?.riscos, ['enviar']);
  });

  test('a mensagem só libera, ou diz mais alguma coisa (a regra de texto fica junto)', () => {
    assert.equal(soLiberacao('A partir de agora, podem enviar os e-mails sem a minha confirmação'), true);
    assert.equal(soLiberacao('a partir de agora podem mandar e apagar os e-mails sem me perguntar, por favor'), true);
    assert.equal(soLiberacao('A partir de agora, respondam sempre em inglês e podem mandar os e-mails sem me pedir aprovação'), false);
    assert.equal(soLiberacao('Sempre que chegar pedido de cliente, podem responder os e-mails sem me perguntar'), false);
  });

  test('o marcador da coordenação e o texto do cartão', () => {
    assert.deepEqual(parseRegras('Combinado. [[regra acao="enviar" conexao="microsoft" alcance="24h" so="email"]]'), [{ kind: 'regra', riscos: ['enviar'], conexoes: ['microsoft'], so: 'email', alcance: '24h' }]);
    assert.deepEqual(parseRegras('[[regra acao="tudo" conexao="todas"]]')[0].riscos, ['organizar', 'enviar'], '"tudo" não inclui apagar');
    assert.deepEqual(parseRegras('[[regra acao="enviar,apagar" conexao="Microsoft 365|gmail" alcance="sempre"]]')[0], { kind: 'regra', riscos: ['enviar', 'apagar'], conexoes: ['microsoft', 'google'], so: null, alcance: 'sempre' });
    assert.deepEqual(parseRegras('[[regra acao="enviar" conexao="inventada"]]'), [], 'conexão desconhecida: nada');
    assert.equal(parseProposals('[[regra acao="enviar" conexao="microsoft"]]').filter((p) => p.kind === 'regra').length, 1, 'entra nas propostas da coordenação');
    const r = regraDaFrase('podem mandar os e-mails sem me pedir aprovação', ['microsoft'])!;
    assert.equal(descreverRegra(r), 'enviar e-mails pela conta Microsoft 365');
    assert.equal(descreverRegra({ riscos: ['enviar'], conexoes: ['slack'], so: null }), 'enviar mensagens pela conta Slack', 'sem e-mail onde não há e-mail');
    assert.equal(descreverRegra({ riscos: ['enviar', 'apagar'], conexoes: ['*'], so: null }), 'enviar mensagens e e-mails e apagar em todas as conexões');
    const txt = resumoDaProposta(r);
    assert.match(txt, /^Liberar sem pedir a sua confirmação: enviar e-mails pela conta Microsoft 365\./);
    assert.match(txt, /Apagar continua pedindo confirmação/);
    assert.match(txt, /Conexões › Regras/);
    assert.doesNotMatch(txt, /motor|token|API|Hermes/);
    assert.match(txt, /Só neste pedido" vale para o que este pedido já pôs em andamento e para o que você pedir nesta conversa nas próximas 6 horas/);
    assert.match(txt, /os cartões de outros pedidos continuam esperando você/, 'avisa o que sai no clique');
    // sugerida pela coordenação: o cartão diz, e "sempre" não fica em destaque
    const sug = sugestaoDoAgente(parseRegras('[[regra acao="enviar,apagar" conexao="todas" alcance="sempre"]]')[0]);
    assert.equal(sug.alcance, 'pedido');
    assert.match(sug.resumo, /Quem sugeriu foi a coordenação, não você/);
    assert.equal(sugestaoDoAgente(parseRegras('[[regra acao="enviar" conexao="microsoft" alcance="24h"]]')[0]).alcance, '24h');
  });

  test('a regra no decidir: direto mesmo de fora e depois de ler; o ajuste da conexão e "confirmar antes de organizar" continuam acima', () => {
    const base = { origem: 'fora' as const, leuDeFora: true, liberarTudo: false, regra: true };
    assert.equal(decidir({ ...base, risco: 'enviar' }), 'direto');
    assert.equal(decidir({ ...base, risco: 'enviar', codigoLigado: true }), 'direto', 'quem decide se a regra vale com código ligado é o serviço');
    assert.equal(decidir({ ...base, risco: 'enviar', ajuste: 'confirmar' }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'organizar', confirmarOrganizar: true }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'enviar', regra: false }), 'confirmar', 'sem a regra, como antes');
  });

  test('na conversa: a frase vira o cartão (só neste pedido por padrão) e o agente sabe; "a partir de agora" não vira também regra de texto', async () => {
    const { conv, run } = await conversar('Escreva o convite para os 10 clientes e podem mandar os e-mails sem me pedir aprovação');
    const [c] = cartoesRegra();
    assert.ok(c, 'o cartão');
    assert.equal(c.status, 'proposed'); assert.equal(c.conversation_id, conv); assert.equal(c.run_id, run.id);
    assert.equal(JSON.parse(c.payload).alcance, 'pedido');
    assert.match(c.summary, /Liberar sem pedir a sua confirmação: enviar e-mails pela conta Microsoft 365/);
    assert.match(String(h.db.get<{ instructions: string }>('SELECT instructions FROM runs WHERE id = ?', run.id)!.instructions), /O sistema já mostrou à pessoa, nesta conversa, um cartão para liberar sem confirmação/);
    const lista = (await req(h, 'GET', `/api/proposals?conversationId=${conv}`, s)).json as Array<{ id: string; kind: string; payload: string | null }>;
    assert.equal(JSON.parse(lista.find((p) => p.id === c.id)!.payload!).alcance, 'pedido', 'a tela recebe o alcance sugerido');
    assert.ok((await req(h, 'GET', '/api/decisions', s)).json.proposals.some((p: { id: string }) => p.id === c.id), 'aparece em "Aguardando você"');
    // a coordenação escreve o marcador para a mesma mensagem: não abre outro cartão igual
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: run.id }, parseProposals('[[regra acao="enviar" conexao="microsoft" alcance="pedido" so="email"]]'));
    assert.equal(cartoesRegra().length, 1, 'um cartão só');

    await conversar('A partir de agora, podem enviar os e-mails sem a minha confirmação', coord, conv);
    assert.equal(JSON.parse(cartoesRegra()[0].payload).alcance, 'pedido');
    assert.equal(cartoesRegra().length, 1, 'a mesma regra já espera: não duplica');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules WHERE workspace_id = ?", s.workspaceId)!.n, 0, 'nenhuma regra de texto');
    const outra = await conversar('A partir de agora, podem apagar os e-mails de propaganda sem me perguntar');
    assert.equal(JSON.parse(cartoesRegra().find((x) => x.conversation_id === outra.conv)!.payload).alcance, 'sempre');
  });
});

describe('aplicar: a regra vale de verdade', () => {
  test('"Só neste pedido": o que esperava sai no clique, 10 envios vão direto, apagar ainda pede, e outro pedido continua pedindo', async () => {
    const { conv, run } = await conversar('Mande o convite aos 10 clientes da planilha e podem mandar os e-mails sem me pedir aprovação');
    h.conexoes.marcar(run, { privado: true, motivo: 'teste' }); // leu a planilha e e-mails: sem a regra, o envio pede confirmação
    assert.equal((await enviar(run, 'c0@cliente.test')).status, 'aguardando_confirmacao', 'antes do clique, pede');
    assert.equal(enviados.length, 0);
    const [c] = cartoesRegra();
    const r = await aplicar(c.id); // sem escolher: o sugerido (só neste pedido)
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, 'applied');
    assert.match(r.json.result, /aplicada: enviar e-mails pela conta Microsoft 365, só no pedido em que foi aprovada; 1 ação que esperava foi feita/);
    assert.deepEqual(enviados, ['c0@cliente.test'], 'o cartão que esperava saiu');
    assert.equal(confirmacoes()[0].status, 'applied');
    assert.match(String(h.db.get<{ result: string }>('SELECT result FROM agent_proposals WHERE id = ?', confirmacoes()[0].id)!.result), /^Liberado pela sua regra/);
    // o agente recebe tudo numa continuação só, nesta conversa, com a origem do pedido dela
    const cont = h.db.get<Run & { input: string }>("SELECT * FROM runs WHERE idempotency_key LIKE ?", `regra-${c.id}-%`)!;
    assert.ok(cont, 'uma continuação');
    assert.equal(cont.conversation_id, conv);
    assert.match(cont.input, /A pessoa aprovou a regra de enviar e-mails pela conta Microsoft 365/);
    assert.equal(h.conexoes.origem(cont), 'pessoa');

    for (let i = 1; i <= 10; i++) {
      const x = await enviar(run, `c${i}@cliente.test`);
      assert.equal(x.status, 'feita', JSON.stringify(x));
      if (i === 1) assert.match(x.texto, /Foi direto, sem cartão: a pessoa aprovou a regra/);
    }
    assert.equal(enviados.length, 11, '10 envios sem cartão');
    assert.equal(confirmacoes().length, 1, 'nenhum cartão novo');
    const regraId = h.db.get<{ id: string }>('SELECT id FROM regras_conexoes')!.id;
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conexao_acoes WHERE regra_id = ? AND status = 'feita'", regraId)!.n, 11, 'cada envio diz que foi pela regra');
    // a continuação também é do pedido (ela espera a vez na conversa: confere pela regra)
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe(cont.id)], 'microsoft', 'email.enviar', 'enviar', false)?.id, regraId);
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe(cont.id)], 'microsoft', 'email.enviar', 'enviar', true), null, 'com execução de código ligada, só neste pedido não vale');
    // um card que nasce deste pedido (a coordenação abriu) também é do pedido; um card de outro lugar, não
    const agora = new Date().toISOString();
    const board = h.db.get<{ id: string; col: string }>("SELECT b.id, c.id AS col FROM boards b JOIN columns c ON c.board_id = b.id WHERE b.workspace_id = ? AND b.audience = 'team' LIMIT 1", s.workspaceId)!;
    for (const [tid, n, origem] of [['tsk_dopedido1', 9101, `${run.id}:g1`], ['tsk_deoutro01', 9102, null]] as const) {
      h.db.run(`INSERT INTO tasks (id, workspace_id, board_id, column_id, number, title, origin, origin_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', 'chat', ?, ?, ?)`, tid, s.workspaceId, board.id, board.col, n, origem, agora, agora);
      h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, conversation_id, task_id, kind, status, mode, input, idempotency_key, created_at) VALUES (?, ?, ?, NULL, ?, 'chat', 'succeeded', 'simulated', 'x', ?, ?)`,
        `run_${tid}`, s.workspaceId, colega, tid, `queue-${tid}-1`, agora);
    }
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe('run_tsk_dopedido1')], 'microsoft', 'email.enviar', 'enviar', false)?.id, regraId, 'o card do pedido');
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe('run_tsk_deoutro01')], 'microsoft', 'email.enviar', 'enviar', false), null, 'outro card');
    // apagar não estava na regra
    assert.equal((await apagar(run, 'msg-promo-1')).status, 'aguardando_confirmacao', 'apagar continua pedindo');
    assert.equal(apagados.length, 0);
    // outro pedido (uma rotina que leu conteúdo de fora): a regra não vale lá
    const fora = await deFora();
    assert.equal((await enviar(fora, 'outro@cliente.test')).status, 'aguardando_confirmacao');
    // auditoria: quem aprovou e o que liberou
    const a = h.db.get<{ actor_id: string; result: string; evidence: string }>("SELECT actor_id, result, evidence FROM audit_events WHERE action = 'conexoes.regra.aprovada'")!;
    assert.equal(a.actor_id, s.userId);
    assert.match(a.result, /você liberou sem confirmação: enviar e-mails pela conta Microsoft 365/);
    assert.equal(JSON.parse(a.evidence).alcance, 'pedido');
    // Conexões › Regras mostra a regra, com os usos
    const tela = (await req(h, 'GET', '/api/conexoes/regras', s)).json;
    assert.equal(tela.regras.length, 1);
    assert.equal(tela.regras[0].usos, 11);
    assert.equal(tela.regras[0].alcance, 'pedido');
  });

  test('"Sempre": vale para os cards da equipe e para o que não partiu da pessoa; o histórico do card diz "liberado pela sua regra"', async () => {
    await conversar('podem mandar os e-mails sem me pedir aprovação');
    assert.equal((await aplicar(cartoesRegra()[0].id, 'sempre')).json.status, 'applied');
    const fora = await deFora();
    assert.equal((await enviar(fora, 'a@cliente.test')).status, 'feita', 'de fora e depois de ler: direto');
    // Teams não é e-mail: a regra "só e-mails" não cobre
    assert.notEqual((await ponte({ op: 'executar', session_id: fora.hermes_session_id, conexao: 'microsoft', acao: 'teams.enviar', parametros: { chat: '19:abc@thread.v2', texto: 'oi' } })).json.status, 'feita');
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [fora], 'microsoft', 'teams.enviar', 'enviar', false), null);
    // as conversas terminam; um card da equipe que veio de uma mensagem recebida entra na fila
    for (const [remoto, r] of motor.runs) if (r.status === 'running') motor.runs.set(remoto, { ...r, status: 'completed', output: 'Feito.', model: 'nous/teste-1' });
    await tick();
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Responder o fornecedor', agentId: colega })).json;
    h.db.run("UPDATE tasks SET origin = 'whatsapp' WHERE id = ?", t.id);
    await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
    await tick();
    const rc = runDe(h.db.get<{ id: string }>("SELECT id FROM runs WHERE task_id = ? AND idempotency_key LIKE 'queue-%'", t.id)!.id);
    assert.ok(rc.hermes_session_id, 'o card está trabalhando');
    assert.equal(h.conexoes.origem(rc), 'fora');
    h.conexoes.marcar(rc, { privado: true, motivo: 'teste' });
    assert.equal((await enviar(rc, 'fornecedor@exemplo.test')).status, 'feita');
    const hist = h.db.all<{ result: string }>("SELECT result FROM audit_events WHERE target_type = 'task' AND target_id = ? AND action = 'task.regra'", t.id);
    assert.equal(hist.length, 1);
    assert.match(hist[0].result, /^Liberado pela sua regra — Microsoft 365: Enviar e-mail para fornecedor@exemplo\.test/);
    assert.ok((await req(h, 'GET', `/api/tasks/${t.id}`, s)).json.log.some((e: { action: string }) => e.action === 'task.regra'), 'aparece no histórico do card');
  });

  test('a regra que fala em apagar deixa apagar; "Por 24 h" expira sozinha; "Desfazer" volta a pedir', async () => {
    await conversar('podem mandar e apagar os e-mails sem me perguntar');
    const [c] = cartoesRegra();
    assert.deepEqual(JSON.parse(c.payload).riscos, ['enviar', 'apagar']);
    assert.equal((await aplicar(c.id, '24h')).json.status, 'applied');
    const fora = await deFora();
    assert.equal((await apagar(fora, 'msg-promo-2')).status, 'feita', 'apagar pela regra que fala em apagar');
    assert.deepEqual(apagados, ['msg-promo-2']);
    assert.equal((await enviar(fora, 'b@cliente.test')).status, 'feita');
    const regra = h.db.get<{ id: string; expira_em: string }>('SELECT id, expira_em FROM regras_conexoes')!;
    const em = Date.parse(regra.expira_em) - Date.now();
    assert.ok(em > 23.9 * 3600_000 && em <= 24 * 3600_000, `expira em 24 h (${em})`);
    // passadas as 24 h
    h.db.run('UPDATE regras_conexoes SET expira_em = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), regra.id);
    assert.equal((await enviar(fora, 'c@cliente.test')).status, 'aguardando_confirmacao', 'expirou: volta a pedir');
    assert.equal((await req(h, 'GET', '/api/conexoes/regras', s)).json.regras.length, 0, 'e some da lista');

    // "Sempre", e depois "Desfazer"
    await conversar('a partir de agora podem enviar os e-mails sem pedir confirmação');
    const s2 = cartoesRegra().find((x) => x.status === 'proposed')!;
    assert.equal(JSON.parse(s2.payload).alcance, 'sempre');
    const ap = await aplicar(s2.id);
    // o c@ esperava num outro pedido (a rotina): não sai no clique de "Sempre" dado noutra conversa
    assert.doesNotMatch(ap.json.result, /esperava/, 'o que esperava noutro pedido não sai');
    assert.ok(!enviados.includes('c@cliente.test'));
    assert.equal(confirmacoes().at(-1)!.status, 'proposed', 'o cartão do c@ continua esperando o clique');
    assert.equal((await enviar(fora, 'd@cliente.test')).status, 'feita');
    const id = (await req(h, 'GET', '/api/conexoes/regras', s)).json.regras[0].id;
    assert.equal((await req(h, 'POST', `/api/conexoes/regras/${id}/desfazer`, s)).status, 200);
    assert.equal((await enviar(fora, 'e@cliente.test')).status, 'aguardando_confirmacao', 'desfeita: volta a pedir');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'conexoes.regra.desfeita' AND actor_id = ?", s.userId));
  });

  test('o que a regra não resolve continua esperando: o ajuste da conexão, e recusar não libera nada', async () => {
    const row = h.db.get<{ settings: string }>("SELECT settings FROM integrations WHERE workspace_id = ? AND kind = 'microsoft'", s.workspaceId)!;
    setIntegration(h.db, s.workspaceId, 'microsoft', { settings: { ...JSON.parse(row.settings || '{}'), permissoes: { tipos: { enviar: 'confirmar' }, acoes: {} } } });
    const fora = await deFora();
    assert.equal((await enviar(fora, 'a@cliente.test')).status, 'aguardando_confirmacao');
    await conversar('podem mandar os e-mails sem me pedir aprovação');
    const [c] = cartoesRegra();
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'reject' })).json.status, 'rejected');
    assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM regras_conexoes')!.n, 0, 'recusada: nenhuma regra');
    await conversar('a partir de agora podem enviar os e-mails sem pedir confirmação');
    const r = await aplicar(cartoesRegra().find((x) => x.status === 'proposed')!.id);
    assert.doesNotMatch(r.json.result, /esperava/, 'o cartão pelo ajuste dela continua esperando');
    assert.equal(enviados.length, 0);
    assert.equal((await enviar(fora, 'b@cliente.test')).status, 'aguardando_confirmacao', '"sempre pedir confirmação" na conexão vale acima da regra');
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'apply' })).status, 409, 'decidido uma vez só');
    assert.equal((await req(h, 'POST', `/api/proposals/${c.id}`, s, { decision: 'apply', alcance: 'para sempre' })).status, 400, 'só os alcances da tela');
  });

  test('a mesma regra aprovada de novo (por 24 h ou sempre) substitui a de antes: a lista não duplica', () => {
    const proposta = { kind: 'regra' as const, riscos: ['enviar' as const], conexoes: ['microsoft'], so: 'email' as const, alcance: '24h' as const };
    const a = h.conexoes.regras.aplicar(s.workspaceId, s.userId, { id: 'apr_x1', conversationId: null, runId: null, proposta }, '24h');
    const b = h.conexoes.regras.aplicar(s.workspaceId, s.userId, { id: 'apr_x2', conversationId: null, runId: null, proposta }, 'sempre');
    assert.deepEqual(h.conexoes.regras.ativas(s.workspaceId).map((x) => x.id), [b.id]);
    assert.equal(h.conexoes.regras.get(s.workspaceId, a.id)!.status, 'desfeita');
    // outra regra (outra conta) não é substituída
    h.conexoes.regras.aplicar(s.workspaceId, s.userId, { id: 'apr_x3', conversationId: null, runId: null, proposta: { ...proposta, conexoes: ['google'] } }, 'sempre');
    assert.equal(h.conexoes.regras.ativas(s.workspaceId).length, 2);
  });

  test('o pedido de uma execução: o card, o card pai, a execução que abriu o card e as continuações', () => {
    const agora = new Date().toISOString();
    const ins = (id: string, task: string | null, k: string) => h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, conversation_id, task_id, kind, status, mode, input, idempotency_key, created_at)
      VALUES (?, ?, ?, NULL, ?, 'chat', 'succeeded', 'simulated', 'x', ?, ?)`, id, s.workspaceId, coord, task, k, agora);
    const board = h.db.get<{ id: string; col: string }>("SELECT b.id, c.id AS col FROM boards b JOIN columns c ON c.board_id = b.id WHERE b.workspace_id = ? AND b.audience = 'team' LIMIT 1", s.workspaceId)!;
    const t = (id: string, n: number, pai: string | null, origem: string | null) => h.db.run(`INSERT INTO tasks (id, workspace_id, board_id, column_id, number, title, origin, parent_task_id, origin_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'x', 'chat', ?, ?, ?, ?)`, id, s.workspaceId, board.id, board.col, n, pai, origem, agora, agora);
    ins('run_pedido0', null, 'chat-x');
    t('tsk_pai0', 9001, null, 'run_pedido0:g1');
    t('tsk_filho0', 9002, 'tsk_pai0', null);
    ins('run_filho0', 'tsk_filho0', 'queue-tsk_filho0-1');
    const c = cadeiaDoPedido(h.db, runDe('run_filho0'));
    assert.ok(c.runs.includes('run_pedido0') && c.tasks.includes('tsk_pai0') && c.tasks.includes('tsk_filho0'), JSON.stringify(c));
  });
});

describe('"Só neste pedido" é o pedido, e o clique só solta o que é dele', () => {
  /** As conversas que estão rodando no motor terminam (com a resposta dada), e a fila anda. */
  async function terminar(output = 'Feito.') {
    for (const [remoto, r] of motor.runs) if (r.status === 'running') motor.runs.set(remoto, { ...r, status: 'completed', output, model: 'nous/teste-1' });
    await tick();
  }
  const board = () => h.db.get<{ id: string; col: string }>("SELECT b.id, c.id AS col FROM boards b JOIN columns c ON c.board_id = b.id WHERE b.workspace_id = ? AND b.audience = 'team' LIMIT 1", s.workspaceId)!;

  test('um pedido antigo da mesma conversa (cartão esperando, card aberto de dias atrás) não entra', async () => {
    const antigo = await conversar('Leia os e-mails de ontem e responda ao fornecedor');
    h.conexoes.marcar(antigo.run, { privado: true, motivo: 'teste' });
    assert.equal((await enviar(antigo.run, 'antigo@x.test')).status, 'aguardando_confirmacao');
    await terminar();
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM runs WHERE id = ?', antigo.run.id)!.status, 'succeeded');
    // um card aberto de 5 dias atrás, que saiu desta conversa
    const velho = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();
    const b = board();
    h.db.run(`INSERT INTO tasks (id, workspace_id, board_id, column_id, number, title, origin, conversation_id, created_at, updated_at) VALUES ('tsk_velho001', ?, ?, ?, 9301, 'cobrar fornecedores', 'whatsapp', ?, ?, ?)`, s.workspaceId, b.id, b.col, antigo.conv, velho, velho);
    h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, conversation_id, task_id, kind, status, mode, input, idempotency_key, created_at) VALUES ('run_velho001', ?, ?, NULL, 'tsk_velho001', 'chat', 'succeeded', 'simulated', 'x', 'queue-tsk_velho001-1', ?)`, s.workspaceId, colega, velho);

    const novo = await conversar('Novo pedido: mande o convite da festa; podem mandar os e-mails sem me pedir aprovação', coord, antigo.conv);
    const r = await aplicar(cartoesRegra()[0].id, 'pedido');
    assert.equal(r.json.status, 'applied', JSON.stringify(r.json));
    assert.doesNotMatch(r.json.result, /esperava/, 'o cartão antigo não sai no clique');
    assert.deepEqual(enviados, []);
    assert.equal(confirmacoes()[0].status, 'proposed', 'continua esperando o clique dela');
    const regraId = h.db.get<{ id: string }>('SELECT id FROM regras_conexoes')!.id;
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe('run_velho001')], 'microsoft', 'email.enviar', 'enviar', false), null, 'o card aberto de outro pedido');
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [runDe(antigo.run.id)], 'microsoft', 'email.enviar', 'enviar', false), null, 'a execução antiga da conversa');
    assert.equal(h.conexoes.regras.cobre(s.workspaceId, [novo.run], 'microsoft', 'email.enviar', 'enviar', false)?.id, regraId, 'o pedido de agora');
    h.conexoes.marcar(novo.run, { privado: true, motivo: 'teste' });
    assert.equal((await enviar(novo.run, 'festa@x.test')).status, 'feita');
  });

  test('a mensagem seguinte dela na mesma conversa continua o pedido (até 6 h depois de aprovar)', async () => {
    const { conv, run } = await conversar('Escreva os convites aos 10 clientes; podem mandar os e-mails sem me pedir aprovação');
    h.conexoes.marcar(run, { privado: true, motivo: 'teste' }); // leu a planilha
    await terminar('Rascunhos prontos. Envio?');
    assert.equal((await aplicar(cartoesRegra()[0].id)).json.status, 'applied');
    const segue = await conversar('ok, pode enviar agora', coord, conv);
    assert.equal(cartoesRegra().length, 1, 'a mensagem seguinte não abre outro cartão');
    for (let i = 1; i <= 10; i++) assert.equal((await enviar(segue.run, `c${i}@cliente.test`)).status, 'feita', `envio ${i}`);
    assert.equal(enviados.length, 10);
    assert.equal(confirmacoes().length, 0, 'nenhum cartão');
    // passadas as 6 h: uma mensagem nova na conversa já é outro pedido
    await terminar();
    h.db.run('UPDATE regras_conexoes SET created_at = ?', new Date(Date.now() - PEDIDO_SEGUE_MS - 60_000).toISOString());
    const depois = await conversar('mande também para o d@cliente.test', coord, conv);
    assert.equal((await enviar(depois.run, 'd@cliente.test')).status, 'aguardando_confirmacao');
    // outra conversa, mesmo dentro das 6 h
    await terminar();
    h.db.run('UPDATE regras_conexoes SET created_at = ?', new Date().toISOString());
    const outra = await conversar('mande para o e@cliente.test');
    h.conexoes.marcar(outra.run, { privado: true, motivo: 'teste' });
    assert.equal((await enviar(outra.run, 'e@cliente.test')).status, 'aguardando_confirmacao', 'outra conversa não é o pedido');
  });

  test('"Sempre" dado numa conversa não solta os cartões de outros pedidos; o do pedido dela sai', async () => {
    const rotina = await deFora();
    assert.equal((await enviar(rotina, 'x@atacante.test')).status, 'aguardando_confirmacao');
    const { run } = await conversar('Mande a proposta aos clientes; a partir de agora podem mandar os e-mails sem me pedir aprovação');
    h.conexoes.marcar(run, { privado: true, motivo: 'teste' });
    assert.equal((await enviar(run, 'cliente@x.test')).status, 'aguardando_confirmacao');
    const r = await aplicar(cartoesRegra()[0].id, 'sempre');
    assert.match(r.json.result, /1 ação que esperava foi feita/);
    assert.deepEqual(enviados, ['cliente@x.test'], 'só o do pedido dela');
    assert.equal(confirmacoes()[0].status, 'proposed', 'o da rotina continua esperando');
    // daqui para frente, a regra vale em qualquer lugar (as ações novas)
    assert.equal((await enviar(rotina, 'y@cliente.test')).status, 'feita');
  });

  test('com execução de código ligada, "Só neste pedido" não é aceito (aviso leigo) e o cartão continua esperando outra escolha', async () => {
    const deps = (h.conexoes as unknown as { d: { codigoLigado: (ws: string, run?: unknown) => boolean } }).d;
    const antes = deps.codigoLigado;
    deps.codigoLigado = () => true;
    try {
      const { run } = await conversar('Mande os convites; podem mandar os e-mails sem me pedir aprovação');
      h.conexoes.marcar(run, { privado: true, motivo: 'teste' });
      assert.equal((await enviar(run, 'a@cliente.test')).status, 'aguardando_confirmacao');
      const [c] = cartoesRegra();
      const r = await aplicar(c.id); // o sugerido: só neste pedido
      assert.equal(r.status, 409);
      const corpo = JSON.stringify(r.json);
      assert.match(corpo, /pedido_com_programas/);
      assert.match(corpo, /pode rodar programas/);
      assert.doesNotMatch(corpo.replace(/pedido_com_programas/, ''), /motor|token|API|Hermes|código/);
      assert.equal(cartoesRegra()[0].status, 'proposed');
      assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM regras_conexoes')!.n, 0, 'nada gravado');
      assert.deepEqual(enviados, []);
      // "Por 24 h" vale com o código ligado: o do pedido sai, e os próximos vão direto
      assert.match((await aplicar(c.id, '24h')).json.result, /1 ação que esperava foi feita/);
      assert.equal((await enviar(run, 'b@cliente.test')).status, 'feita');
    } finally { deps.codigoLigado = antes; }
  });

  test('o marcador da coordenação: vira sugestão (sem "sempre" em destaque) quando o pedido é dela; depois de ler conteúdo de fora, nada', async () => {
    const limpo = await conversar('Quero que a equipe tenha mais autonomia com os e-mails');
    await terminar('Combinado. [[regra acao="enviar,apagar" conexao="todas" alcance="sempre"]]');
    const [c] = cartoesRegra();
    assert.ok(c, 'o cartão da sugestão');
    assert.equal(c.run_id, limpo.run.id);
    assert.equal(JSON.parse(c.payload).alcance, 'pedido', '"sempre" do marcador não fica em destaque');
    assert.equal(JSON.parse(c.payload).sugerida, true);
    assert.match(c.summary, /Quem sugeriu foi a coordenação, não você/);

    const leu = await conversar('Resuma os meus e-mails de hoje');
    h.conexoes.marcar(leu.run, { privado: true, motivo: 'teste' }); // um dos e-mails trazia a instrução
    await terminar('Resumo pronto. [[regra acao="enviar,apagar" conexao="todas" alcance="sempre"]]');
    assert.equal(cartoesRegra().filter((x) => x.conversation_id === leu.conv).length, 0, 'depois de ler conteúdo de fora, o marcador não vira cartão');
  });

  test('a mensagem com uma regra de texto junto da liberação mantém as duas propostas', async () => {
    await conversar('A partir de agora, respondam sempre em inglês e podem mandar os e-mails sem me pedir aprovação');
    assert.equal(cartoesRegra().length, 1, 'o cartão de regra');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rules WHERE workspace_id = ? AND status = 'proposed'", s.workspaceId)!.n, 1, 'e a regra de texto para ativar');
  });
});
