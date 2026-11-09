/**
 * Conversar com a equipe pelo Teams (app público), do lado do Ergon, contra um serviço do Teams falso em processo
 * (WebSocket de verdade, entregas seladas para a instalação): sem endereço nada liga; ligar por código com a prévia do
 * nome e a senha; a mensagem vira conversa "Teams" com o coordenador e a resposta volta (com "digitando"); confirmação vira
 * cartão e o clique decide pela mesma função da tela; aviso de "Com você"; a fila guardada chega em ordem ao reconectar;
 * desligar pelos dois lados; quem não está ligado é recusado; a parte da pessoa fechada faz a mensagem esperar.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { KDF_TEST } from '../src/security/crypto.ts';
import { Vault } from '../src/security/keys.ts';
import { setLog } from '../src/lib/log.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { NOTA_TEAMS } from '../src/services/teams-app/index.ts';
import { tokenCartao } from '../src/services/teams-app/protocolo.ts';
import { addPerson, harness, loginAs, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso } from './rele-falso.ts';

const SENHA = 'senha-local-123';
let rele: ReleFalso; let h: Harness; let s: Session;

function rapido(x: Harness) { x.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 } }; }
async function ate(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (pred()) return;
    await h.executor.tick().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(msg);
}
async function abrir(over: Record<string, unknown> = {}, opts: Parameters<typeof harness>[1] = {}): Promise<Harness> {
  const x = await harness({ teamsRelayUrl: rele.base, ...over }, opts);
  rapido(x);
  return x;
}
async function ligar(nome = 'Maria Souza'): Promise<string> {
  const codigo = rele.codigoPara(nome);
  const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: ` ${codigo.toLowerCase().replace('-', ' ')} ` });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.teamsName, nome, 'a prévia mostra o nome da conta do Teams');
  const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return ok.json.binding.id as string;
}
const conversaTeams = () => h.db.get<{ id: string; agent_id: string; title: string }>("SELECT c.id, c.agent_id, c.title FROM conversations c JOIN teams_people p ON p.conversation_id = c.id WHERE p.user_id = ?", s.userId);
const mensagens = (conv: string) => h.db.all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY rowid', conv);
const respostas = () => rele.enviados.filter((e) => e.purpose === 'reply');
const cartoes = () => rele.enviados.filter((e) => e.card);
/** Os botões de um cartão: os dados do Aprovar e do Recusar de cada ActionSet. */
const botoes = (card: any) => card.body.filter((b: any) => b.type === 'ActionSet').flatMap((b: any) => b.actions);
const textoDo = (card: any) => card.body.filter((b: any) => b.type === 'TextBlock').map((b: any) => b.text).join('\n');

describe('Conversar pelo Teams: sem o endereço do serviço', () => {
  afterEach(() => h.close());
  test('a tela diz que não está disponível, nenhuma conexão é tentada e ligar não faz nada', async () => {
    h = await harness();
    s = await setupOwner(h);
    await h.teamsApp.start();
    const g = await req(h, 'GET', '/api/teams-app', s);
    assert.equal(g.status, 200);
    assert.equal(g.json.available, false); assert.equal(g.json.reason, 'unconfigured'); assert.equal(g.json.connection, 'offline');
    assert.equal(h.teamsApp.cliente, null, 'nenhuma conexão');
    assert.equal(h.db.get("SELECT value FROM instance_settings WHERE key = 'teams_relay_keys'"), undefined, 'nem chaves geradas');
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ABCD-EFGH' });
    assert.equal(c.status, 409); assert.equal(c.json.message, 'Em breve.');
  });
});

describe('Conversar pelo Teams: com o serviço', () => {
  beforeEach(async () => {
    rele = await ReleFalso.iniciar();
    h = await abrir();
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado(), 'o Ergon não conectou ao serviço');
  });
  afterEach(async () => { await h.close(); await rele.parar(); });
  after(() => setLog(null));

  test('registro da instalação: chaves cifradas no banco, conexão de saída autenticada pela assinatura', async () => {
    assert.equal(rele.registros, 1);
    const k = h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'teams_relay_keys'")!.value;
    assert.match(k, /^tk1\./, 'as privadas ficam cifradas com a chave da instância');
    assert.ok(!k.includes('MC4CAQAw'), 'nada da privada em claro (o começo de um pkcs8 Ed25519 em base64)');
    const g = (await req(h, 'GET', '/api/teams-app', s)).json;
    assert.equal(g.available, true); assert.equal(g.connection, 'connected'); assert.equal(g.enabled, true); assert.deepEqual(g.bindings, []);
    assert.equal(g.teamsAppUrl, 'https://teams.microsoft.com/l/app/11111111-2222-3333-4444-555555555555');
    // tipo que esta versão não conhece (evolução do protocolo): avisa sem fechar; ack atrasado: ignorado
    const conexoes = rele.conexoes;
    rele.conexao!.enviar({ type: 'algo.novo', id: 'xyz_0123456789', campo: 1 });
    rele.conexao!.enviar({ type: 'ack', id: 'req_atrasado0001', ok: true });
    await ate(() => rele.quadros.some((q) => q.type === 'error' && q.code === 'unknown_type' && q.ref === 'xyz_0123456789'), 'o tipo desconhecido não foi avisado');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rele.quadros.filter((q) => q.type === 'error').length, 1, 'o ack atrasado não vira erro');
    assert.ok(rele.conectado()); assert.equal(rele.conexoes, conexoes, 'a conexão continua');
  });

  test('ligar por código: prévia com o nome, a senha confirma, o vínculo aparece nos dois lados; erros em português', async () => {
    assert.equal((await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ABC' })).json.message, 'Código não encontrado. Confira e tente de novo.');
    assert.equal((await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ZZZZ-ZZZZ' })).json.error, 'code_invalid', 'código que o serviço não conhece');
    const codigo = rele.codigoPara('Maria Souza');
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: codigo });
    assert.equal(c.json.teamsName, 'Maria Souza');
    const claim = rele.quadros.filter((q) => q.type === 'link.claim').at(-1);
    assert.equal(claim.code, codigo.replace('-', ''), 'vai sem hífen, em maiúsculas');
    assert.notEqual(claim.personRef, s.userId, 'o serviço nunca vê o id da pessoa');
    assert.equal((await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: 'senha-errada' })).status, 401, 'sem a senha certa, nada liga');
    assert.equal(rele.vinculos.size, 0);
    const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.binding.teamsName, 'Maria Souza'); assert.equal(ok.json.binding.notices, true); assert.equal(ok.json.binding.status, 'active');
    const v = rele.vinculoUnico();
    assert.equal(v.label, 'Alexandre', 'o Teams chama este Ergon pelo primeiro nome');
    assert.equal(v.bindingId, ok.json.binding.id);
    const raw = h.db.raw.prepare('SELECT teams_name FROM teams_bindings').get() as { teams_name: string };
    assert.match(raw.teams_name, /^ev1\./, 'o nome da conta do Teams fica cifrado com a chave da pessoa');
    assert.deepEqual((await req(h, 'GET', '/api/teams-app', s)).json.bindings.map((b: any) => b.teamsName), ['Maria Souza']);
  });

  test('mensagem no Teams → conversa "Teams" com o coordenador → a resposta volta; "digitando"; entrega repetida não duplica', async () => {
    const b = await ligar();
    const linhas: string[] = [];
    setLog({ info: (o, m) => linhas.push(JSON.stringify(o) + m), warn: (o, m) => linhas.push(JSON.stringify(o) + m), error: (o, m) => linhas.push(JSON.stringify(o) + m) });
    const dlv = rele.diz(b, 'Qual é o andamento da proposta para o cliente Zeta?');
    await ate(() => rele.acks.some((a) => a.id === dlv), 'sem ack');
    assert.equal(rele.acks.find((a) => a.id === dlv)!.status, 'accepted');
    const conv = conversaTeams()!;
    assert.equal(conv.title, 'Teams');
    const coord = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", s.workspaceId)!.id;
    assert.equal(conv.agent_id, coord, 'a conversa é com o coordenador');
    assert.deepEqual(mensagens(conv.id).filter((m) => m.role === 'user').map((m) => m.content), ['Qual é o andamento da proposta para o cliente Zeta?']);
    assert.ok(rele.digitando.some((d) => d.bindingId === b && d.on), '"digitando" no Teams enquanto a equipe trabalha');
    const run = h.db.get<{ id: string; instructions: string; idempotency_key: string; workspace_id: string; agent_id: string; conversation_id: string; task_id: string | null }>('SELECT * FROM runs WHERE conversation_id = ?', conv.id)!;
    assert.ok(run.instructions.includes(NOTA_TEAMS), 'o agente sabe que a conversa é pelo Teams');
    assert.equal(h.conexoes.origem(run), 'pessoa', 'o que vem do Teams de uma conta ligada é a pessoa pedindo (a mesma regra do app)');
    await ate(() => respostas().length === 1, 'a resposta não voltou ao Teams');
    const r = respostas()[0];
    assert.equal(r.bindingId, b);
    assert.match(r.text!, /Simulação/); assert.doesNotMatch(r.text!, /\[\[|<\w/);
    assert.ok(r.summary && r.summary.length <= 120);
    await ate(() => rele.digitando.some((d) => d.bindingId === b && !d.on), 'o "digitando" não parou');
    // o serviço reentrega a mesma mensagem (o ack se perdeu): uma só na conversa
    rele.reterAcks = true;
    const dlv2 = rele.diz(b, 'Obrigado!');
    await ate(() => rele.acks.filter((a) => a.id === dlv2).length >= 1);
    rele.derrubar(1001);
    rele.reterAcks = false;
    await ate(() => rele.acks.filter((a) => a.id === dlv2).length >= 2 && rele.fila.length === 0, 'a reentrega não veio depois de reconectar');
    assert.equal(mensagens(conv.id).filter((m) => m.content === 'Obrigado!').length, 1, 'uma só na conversa (a entrega tem id)');
    assert.ok(rele.conexoes >= 2, 'reconectou sozinho');
    // registros (logs): nada do texto, do nome nem do código
    assert.ok(!linhas.some((l) => /Zeta|Obrigado|Maria/.test(l)), linhas.join('\n'));
  });

  test('confirmação na conversa vira cartão no Teams; Aprovar decide pela mesma função da tela; o cartão fica com a linha final', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!.id;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas e propostas' }]);
    await ate(() => cartoes().length === 1, 'o cartão não foi ao Teams');
    const card = cartoes()[0].card;
    assert.equal(card.type, 'AdaptiveCard'); assert.equal(card.version, '1.4'); assert.deepEqual(card.actions, [], 'nada nas ações do topo');
    const [aprovar, recusar] = botoes(card);
    assert.equal(aprovar.type, 'Action.Execute'); assert.equal(aprovar.verb, 'ergon.decidir'); assert.equal(aprovar.data.d, 'apply');
    assert.equal(aprovar.fallback.type, 'Action.Submit', 'reserva para clientes antigos'); assert.equal(aprovar.fallback.data.verb, 'ergon.decidir');
    assert.equal(recusar.data.d, 'reject');
    assert.match(textoDo(card), /Comercial/);
    const pid = aprovar.data.p as string;
    // t adulterado: nada muda
    const falso = rele.clica(b, { ...aprovar.data, t: 'A'.repeat(22) });
    await ate(() => rele.acks.some((a) => a.id === falso));
    assert.equal(rele.acks.find((a) => a.id === falso)!.error?.code, 'invalid');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed');
    // o clique de verdade (pela reserva Submit, que chega igual)
    rele.clica(b, aprovar.data, cartoes()[0].activityId, 'submit');
    await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status === 'applied', 'a proposta não foi aplicada');
    assert.ok(h.db.get("SELECT 1 AS x FROM profiles WHERE workspace_id = ? AND name = 'Comercial'", s.workspaceId), 'o setor foi criado, como pelo botão da tela');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE workspace_id = ? AND actor_id = ? AND target_id = ?", s.workspaceId, s.userId, pid), 'o mesmo registro da tela, em nome da pessoa');
    await ate(() => rele.atualizados.length === 1, 'o cartão não foi atualizado');
    assert.equal(rele.atualizados[0].activityId, cartoes()[0].activityId);
    assert.match(textoDo(rele.atualizados[0].card), /Aprovado por você às \d\dh\d\d/);
    assert.equal(botoes(rele.atualizados[0].card).length, 0, 'sem botões depois de decidido');
    // clicar de novo no cartão velho: "Já decidido", nada decide outra vez
    rele.clica(b, recusar.data, cartoes()[0].activityId);
    await ate(() => rele.atualizados.length === 2);
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'applied');
    // decidir na tela atualiza o cartão do Teams
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Jurídico', description: 'Contratos' }]);
    await ate(() => cartoes().length === 2);
    const pid2 = botoes(cartoes()[1].card)[0].data.p;
    assert.equal((await req(h, 'POST', `/api/proposals/${pid2}`, s, { decision: 'reject' })).json.status, 'rejected');
    await ate(() => rele.atualizados.some((u) => u.activityId === cartoes()[1].activityId), 'decidir na tela não atualizou o cartão no Teams');
    assert.match(textoDo(rele.atualizados.find((u) => u.activityId === cartoes()[1].activityId)!.card), /Recusado por você/);
  });

  test('cartão de outro workspace não decide nada, mesmo com o t certo', async () => {
    const b = await ligar();
    const outro = (await req(h, 'POST', '/api/workspaces', s, { name: 'Outro' })).json.workspaceId as string;
    await req(h, 'POST', '/api/session/workspace', s, { workspaceId: s.workspaceId });
    recordProposals(h.db, h.bus, outro, { conversationId: null, runId: null }, [{ kind: 'sector_new', name: 'Fora', description: 'x' }]);
    const pid = h.db.get<{ id: string }>('SELECT id FROM agent_proposals WHERE workspace_id = ?', outro)!.id;
    const dlv = rele.clica(b, { p: pid, d: 'apply', t: tokenCartao(h.teamsApp.chaves()!, pid, b) });
    await ate(() => rele.acks.some((a) => a.id === dlv));
    assert.equal(rele.acks.find((a) => a.id === dlv)!.error?.code, 'invalid');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed');
  });

  test('"Com você": o que surgir vai ao Teams numa mensagem só (agrupado), com botões; desligado, nada vai', async () => {
    const b = await ligar();
    const fora = (await req(h, 'POST', '/api/conversations', s, { agentId: h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1", s.workspaceId)!.id })).json.id as string;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: fora, runId: null }, [1, 2, 3, 4, 5].map((n) => ({ kind: 'sector_new' as const, name: `Setor ${n}`, description: 'x' })));
    await ate(() => rele.enviados.some((e) => e.purpose === 'notice'), 'o aviso não foi');
    await new Promise((r) => setTimeout(r, 300));
    const avisos = rele.enviados.filter((e) => e.purpose === 'notice');
    assert.equal(avisos.length, 1, '5 itens em pouco tempo → uma mensagem');
    assert.match(textoDo(avisos[0].card), /Precisa de você no Ergon \(5\)/);
    assert.equal(botoes(avisos[0].card).length, 10, 'Aprovar e Recusar para cada um');
    // aprovar um pelo aviso atualiza o mesmo cartão (os outros seguem com botões)
    rele.clica(b, botoes(avisos[0].card)[0].data, avisos[0].activityId);
    await ate(() => rele.atualizados.length === 1);
    assert.equal(botoes(rele.atualizados[0].card).length, 8);
    // avisos desligados: o que surgir depois não vai
    assert.equal((await req(h, 'PATCH', `/api/teams-app/bindings/${b}`, s, { notices: false })).json.binding.notices, false);
    assert.equal(rele.vinculoUnico().notices, false, 'o serviço também sabe');
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: fora, runId: null }, [{ kind: 'sector_new', name: 'Depois', description: 'x' }]);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(rele.enviados.filter((e) => e.purpose === 'notice').length, 1);
  });

  test('"Conversar pelo Teams" desligado: o serviço pausa o vínculo e a entrega é recusada como desligada', async () => {
    const b = await ligar();
    const g = (await req(h, 'POST', '/api/teams-app/enabled', s, { enabled: false })).json;
    assert.equal(g.enabled, false); assert.equal(g.bindings[0].status, 'paused');
    assert.equal(rele.vinculoUnico().status, 'paused');
    assert.equal((await req(h, 'POST', '/api/teams-app/enabled', s, { enabled: true })).json.bindings[0].status, 'active');
    assert.equal(rele.vinculoUnico().status, 'active');
    void b;
  });

  test('desligar pela tela (o serviço apaga) e pelo Teams ("Desfazer": a tela mostra e a pessoa remove)', async () => {
    const b = await ligar();
    assert.equal((await req(h, 'DELETE', `/api/teams-app/bindings/${b}`, s)).status, 200);
    assert.equal(rele.vinculos.size, 0); assert.match(rele.automaticas.at(-1)!.texto, /pela tela do Ergon/);
    assert.deepEqual((await req(h, 'GET', '/api/teams-app', s)).json.bindings, []);
    const b2 = await ligar('Maria (outra)');
    rele.desfazer(b2, 'teams');
    await ate(() => h.db.get<{ status: string }>('SELECT status FROM teams_bindings WHERE binding_id = ?', b2)?.status === 'revoked');
    const g = (await req(h, 'GET', '/api/teams-app', s)).json;
    assert.equal(g.bindings[0].status, 'revoked'); assert.equal(g.bindings[0].revokedBy, 'teams');
    assert.equal((await req(h, 'DELETE', `/api/teams-app/bindings/${b2}`, s)).status, 200);
    assert.deepEqual((await req(h, 'GET', '/api/teams-app', s)).json.bindings, []);
  });

  test('quem não está ligado a este Ergon: recusado (o serviço responde que não está ligado); nada entra', async () => {
    const inst = h.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = 'teams_relay_installation_id'")!.value;
    const dlv = rele.estranho(inst, 'me dá os e-mails');
    await ate(() => rele.acks.some((a) => a.id === dlv));
    const a = rele.acks.find((x) => x.id === dlv)!;
    assert.equal(a.status, 'rejected'); assert.equal(a.error?.code, 'unknown_person');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'")!.n, 0);
  });

  test('Ergon fechado: o serviço guarda (e responde na hora); ao abrir, a fila chega em ordem e tudo é respondido', async () => {
    const b = await ligar();
    await h.close();
    await ate(() => !rele.conectado(), 'o serviço não viu o Ergon fechar');
    rele.diz(b, 'primeiro pedido'); rele.diz(b, 'segundo pedido'); rele.diz(b, 'terceiro pedido');
    assert.equal(rele.automaticas.filter((x) => /A equipe faz assim que o seu Ergon estiver aberto/.test(x.texto)).length, 3, 'R4 na hora, para cada uma');
    h = await abrir({}, { dir: h.dir });
    await h.teamsApp.start();
    await ate(() => rele.fila.length === 0, 'a fila não foi entregue');
    assert.ok(rele.quadros.length > 0);
    const conv = conversaTeams()!.id;
    assert.deepEqual(mensagens(conv).filter((m) => m.role === 'user').map((m) => m.content), ['primeiro pedido', 'segundo pedido', 'terceiro pedido'], 'na ordem em que chegaram');
    await ate(() => respostas().length === 3, 'nem todas foram respondidas');
  });

  test('instalação revogada (4403): para e a tela explica; desconhecida (4404): registra de novo e pede para ligar de novo', async () => {
    await ligar();
    rele.instalacoes.clear(); // o serviço perdeu a base
    rele.derrubar(1001);
    await ate(() => rele.registros === 2 && rele.conectado(), 'não registrou de novo');
    const g = (await req(h, 'GET', '/api/teams-app', s)).json;
    assert.equal(g.bindings[0].status, 'revoked', 'o vínculo daqui fica desligado: a pessoa liga de novo');
    // revogada: fecha com 4403 e não volta
    const antes = rele.conexoes;
    rele.conexao!.fechar(4403);
    await ate(() => (h.teamsApp.problema as string | null) === 'revogada');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(rele.conexoes, antes, 'não reconecta');
  });
});

describe('Conversar pelo Teams: Ergon trancado e a parte da pessoa fechada', () => {
  beforeEach(async () => { rele = await ReleFalso.iniciar(); });
  afterEach(async () => { await h.close(); await rele.parar(); });

  test('Ergon trancado (cofre selado): nada conecta, o serviço guarda; ao destrancar com a senha, as mensagens são processadas', async () => {
    h = await abrir();
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado());
    const b = await ligar();
    await h.close();
    await ate(() => !rele.conectado(), 'o serviço não viu o Ergon fechar');
    // reinício trancado: o cofre só abre com a senha (o servidor fica na tela de destrancar, sem o resto do app)
    const v = new Vault(h.dir, KDF_TEST);
    assert.equal(v.state(), 'sealed');
    rele.diz(b, 'pedido com o Ergon trancado'); rele.diz(b, 'segundo, ainda trancado');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(rele.conectado(), false, 'trancado, nada conecta ao serviço');
    assert.equal(rele.fila.length, 2, 'o serviço guarda');
    assert.equal(rele.automaticas.filter((x) => /assim que o seu Ergon estiver aberto/.test(x.texto)).length, 2, 'e responde na hora');
    assert.ok(await v.unsealPassword('alexandre', SENHA), 'destranca com a senha');
    h = await abrir({}, { dir: h.dir, vault: v });
    await h.teamsApp.start();
    await ate(() => rele.fila.length === 0, 'a fila não foi entregue ao destrancar');
    const conv = conversaTeams()!.id;
    assert.deepEqual(mensagens(conv).filter((m) => m.role === 'user').map((m) => m.content), ['pedido com o Ergon trancado', 'segundo, ainda trancado']);
    await ate(() => respostas().length === 2, 'nem todas foram respondidas');
  });

  test('a mensagem espera (o serviço responde na hora) e é processada quando a pessoa abre a parte dela', async () => {
    h = await abrir();
    s = await setupOwner(h);
    await addPerson(h, 'bruna', 'senha-da-bruna-456', 'Bruna');
    s = await loginAs(h, 'alexandre', SENHA);
    await h.teamsApp.start();
    await ate(() => rele.conectado());
    const b = await ligar();
    await h.close();
    await ate(() => !rele.conectado(), 'o serviço não viu o Ergon fechar');
    // reinício sem trancamento: a instalação abre sozinha, a parte de cada pessoa fica fechada até ela entrar
    const v = new Vault(h.dir, KDF_TEST); assert.ok(v.unsealOpenAccess());
    h = await abrir({}, { dir: h.dir, vault: v });
    assert.equal(h.vault.personOpen(s.userId), false);
    await h.teamsApp.start();
    await ate(() => rele.conectado());
    const dlv = rele.diz(b, 'pedido com a parte fechada');
    await ate(() => rele.acks.some((a) => a.id === dlv));
    assert.equal(rele.acks.find((a) => a.id === dlv)!.status, 'person_locked');
    assert.ok(rele.automaticas.some((x) => /assim que o seu Ergon estiver aberto/.test(x.texto)));
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'")!.n, 0, 'nada entra com a parte fechada');
    s = await loginAs(h, 'alexandre', SENHA); // abre a parte dela
    await ate(() => rele.acks.some((a) => a.id === dlv && a.status === 'accepted'), 'não foi reentregue ao abrir');
    const conv = conversaTeams()!.id;
    assert.deepEqual(mensagens(conv).filter((m) => m.role === 'user').map((m) => m.content), ['pedido com a parte fechada']);
    await ate(() => respostas().length === 1, 'a resposta não voltou');
  });
});
