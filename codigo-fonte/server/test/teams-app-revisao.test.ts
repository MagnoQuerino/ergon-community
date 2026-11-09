/**
 * Conversar pelo Teams: os achados da revisão da rc.26, do lado do Ergon, contra o serviço do Teams falso em processo.
 * A prévia da ligação confere de quem é a conta do Teams (contrato 12.1); uma pessoa não tranca a ligação das outras;
 * quem fala no Teams vai à frente e os links ficam por extenso; o relógio fora da hora não impede ligar nem conectar
 * (12.8); a espera por uma resposta da pessoa avisa no Teams e para o "digitando"; o clique tem ack na hora e decide fora
 * da fila (12.6); a saída não perde a ordem; o pedido atrasado avisa o agente; no_agent/not_ready/claimId (12.2, 12.7,
 * 12.10); pedidos da tela com prazo; avisos e cartões que sobrevivem a reinício; a continuação depois de autorizar.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { setLog } from '../src/lib/log.ts';
import { throttle } from '../src/security/factors.ts';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { recordProposals } from '../src/services/proposals.ts';
import { NOTA_TEAMS } from '../src/services/teams-app/index.ts';
import { linksPorExtenso, textoParaTeams } from '../src/services/teams-app/cartoes.ts';
import { hashDaConta } from '../src/services/teams-app/protocolo.ts';
import { addPerson, harness, loginAs, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { ReleFalso, hashComoRele } from './rele-falso.ts';

const SENHA = 'senha-local-123';
// identificadores de teste (formato GUID do Entra), montados por partes
const guid = (n: string) => [n.repeat(8), n.repeat(4), n.repeat(4), n.repeat(4), n.repeat(12)].join('-');
const TENANT = guid('a'); const OUTRO_TENANT = guid('b'); const OID = guid('c'); const OUTRO_OID = guid('d');

let rele: ReleFalso; let h: Harness; let s: Session;

function rapido(x: Harness, extra: Partial<Harness['teamsApp']['ajustes']> = {}) {
  x.teamsApp.ajustes = { avisosMs: 120, saidaMs: 40, digitandoMs: 5000, atrasoMs: 10, pedidoMs: 15_000, registroMs: 100, cliente: { baseMs: 20, tetoMs: 150, reenvioMs: 400, semPingMs: 60_000 }, ...extra };
}
/** Espera sem rodar a fila do executor (para a execução ficar no estado em que o teste a pôs). */
async function espera(pred: () => boolean, msg = 'não aconteceu a tempo', ms = 15_000, tick = false): Promise<void> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (pred()) return;
    if (tick) await h.executor.tick().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(msg);
}
const ate = (pred: () => boolean, msg?: string, ms?: number) => espera(pred, msg, ms, true);
async function abrir(over: Record<string, unknown> = {}, opts: Parameters<typeof harness>[1] = {}, extra: Partial<Harness['teamsApp']['ajustes']> = {}): Promise<Harness> {
  const x = await harness({ teamsRelayUrl: rele.base, ...over }, opts);
  rapido(x, extra);
  return x;
}
/** A conta Microsoft 365 ligada ao workspace (o que o login guarda: locatário e conta do id_token). */
function ligarMicrosoft(conta: { tid?: string; oid?: string; account?: string } = { tid: TENANT, oid: OID, account: 'maria@empresa.com.br' }) {
  h.integrations.secrets.write(s.workspaceId, 'microsoft', { access_token: ['acesso', 'de', 'teste'].join('-'), refresh_token: ['renova', 'teste'].join('-'), expires_at: Date.now() + 3600_000, ...conta });
}
async function ligar(nome = 'Maria Souza', sessao = s): Promise<string> {
  const c = await req(h, 'POST', '/api/teams-app/claim', sessao, { code: rele.codigoPara(nome) });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const ok = await req(h, 'POST', '/api/teams-app/confirm', sessao, { claimId: c.json.claimId, ciente: true, password: SENHA });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return ok.json.binding.id as string;
}
const conversaTeams = () => h.db.get<{ id: string }>('SELECT c.id FROM conversations c JOIN teams_people p ON p.conversation_id = c.id WHERE p.user_id = ?', s.userId)?.id ?? null;
const respostas = () => rele.enviados.filter((e) => e.purpose === 'reply');
const textoDo = (card: any) => card.body.filter((b: any) => b.type === 'TextBlock').map((b: any) => b.text).join('\n');
const botoes = (card: any) => card.body.filter((b: any) => b.type === 'ActionSet').flatMap((b: any) => b.actions);
const coordenador = () => h.db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", s.workspaceId)!;

describe('Conversar pelo Teams (revisão): partes puras', () => {
  test('o hash da conta é o mesmo do relé (maiúsculas não importam)', () => {
    assert.equal(hashDaConta(TENANT.toUpperCase(), OID), hashComoRele({ tenantId: TENANT, aadObjectId: OID.toUpperCase() }));
    assert.notEqual(hashDaConta(TENANT, OID), hashDaConta(TENANT, OUTRO_OID));
    assert.match(hashDaConta(TENANT, OID), /^[A-Za-z0-9_-]{43}$/);
  });
  test('links por extenso: a frase do sistema não esconde outro endereço', () => {
    assert.equal(linksPorExtenso('[Abra o Ergon para autorizar](https://site-falso.example/x)'), 'Abra o Ergon para autorizar (https://site-falso.example/x)');
    assert.equal(linksPorExtenso('veja <https://exemplo.com.br/a>'), 'veja https://exemplo.com.br/a');
    assert.equal(linksPorExtenso('[https://a.example](https://a.example)'), 'https://a.example');
    assert.equal(linksPorExtenso('![logo](https://img.example/l.png "t")'), 'logo (https://img.example/l.png)');
    assert.equal(textoParaTeams('Pronto. [Clique aqui](https://x.example) e <b>já</b>.'), 'Pronto. Clique aqui (https://x.example) e já.');
  });
});

describe('Conversar pelo Teams (revisão): com o serviço', () => {
  beforeEach(async () => {
    rele = await ReleFalso.iniciar();
    h = await abrir();
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado(), 'o Ergon não conectou ao serviço');
  });
  afterEach(async () => { await h.close(); await rele.parar(); });
  after(() => setLog(null));

  test('prévia: a conta do Teams é conferida com a conta Microsoft 365 ligada; o que não é a sua pede a escolha consciente', async () => {
    ligarMicrosoft();
    const claim = async (conta?: { tenantId: string; aadObjectId: string }) => (await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza', conta) })).json;
    // a mesma conta: liga só com a senha
    const sua = await claim({ tenantId: TENANT.toUpperCase(), aadObjectId: OID });
    assert.equal(sua.conta, 'sua'); assert.equal(sua.organizacao, 'empresa.com.br');
    assert.equal((await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: sua.claimId, password: SENHA })).status, 200);
    // outra pessoa da mesma organização com o MESMO nome: sem a escolha consciente, nada liga (nem chega a conferir a senha)
    const outra = await claim({ tenantId: TENANT, aadObjectId: OUTRO_OID });
    assert.equal(outra.conta, 'outra_pessoa'); assert.equal(outra.teamsName, 'Maria Souza');
    const sem = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: outra.claimId, password: 'senha-errada' });
    assert.equal(sem.status, 400); assert.equal(sem.json.error, 'ciente');
    assert.equal(rele.vinculos.size, 1, 'nada ligado sem a escolha');
    assert.equal((await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: outra.claimId, ciente: true, password: SENHA })).status, 200, 'com a escolha consciente, liga');
    // outra organização (o golpe: o atacante num tenant dele, com o nome da vítima)
    const fora = await claim({ tenantId: OUTRO_TENANT, aadObjectId: OID });
    assert.equal(fora.conta, 'outra_organizacao'); assert.equal(fora.organizacao, null);
    assert.equal((await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: fora.claimId, password: SENHA })).json.error, 'ciente');
    await req(h, 'POST', '/api/teams-app/cancel', s, { claimId: fora.claimId });
    // o serviço não informou a conta: não dá para conferir
    const semInfo = await claim();
    assert.equal(semInfo.conta, 'sem_conferir');
    await req(h, 'POST', '/api/teams-app/cancel', s, { claimId: semInfo.claimId });
    // conexão Microsoft de antes desta conferência (sem a conta guardada): só a organização
    ligarMicrosoft({ tid: TENANT, account: 'maria@empresa.com.br' });
    const org = await claim({ tenantId: TENANT, aadObjectId: OID });
    assert.equal(org.conta, 'organizacao'); assert.equal(org.organizacao, 'empresa.com.br');
    // sem conta Microsoft ligada
    h.integrations.secrets.remove(s.workspaceId, 'microsoft');
    assert.equal((await claim({ tenantId: TENANT, aadObjectId: OID })).conta, 'sem_conferir');
  });

  test('códigos errados: o limite é por pessoa (3 em 15 min), antes do serviço; a outra pessoa liga normalmente', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ZZZZ-ZZZZ' })).json.error, 'code_invalid');
    const n = rele.quadros.filter((q) => q.type === 'link.claim').length;
    const quarto = await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') });
    assert.equal(quarto.status, 429); assert.equal(quarto.json.message, 'Muitas tentativas. Espere 15 minutos.');
    assert.equal(rele.quadros.filter((q) => q.type === 'link.claim').length, n, 'nem foi ao serviço');
    // passados 15 minutos (relógio daqui), volta a valer
    const real = h.teamsApp.agora; h.teamsApp.agora = () => real() + 16 * 60_000;
    assert.equal((await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') })).status, 200);
    h.teamsApp.agora = real;
    // outra pessoa do mesmo Ergon não foi trancada
    for (let i = 0; i < 3; i++) await req(h, 'POST', '/api/teams-app/claim', s, { code: 'ZZZZ-ZZZZ' });
    await addPerson(h, 'bruna', 'senha-da-bruna-456', 'Bruna');
    const sb = await loginAs(h, 'bruna', 'senha-da-bruna-456');
    assert.equal((await req(h, 'POST', '/api/teams-app/claim', sb, { code: rele.codigoPara('Bruna Lima') })).status, 200);
  });

  test('not_ready (instalação recém-registrada): a tela espera sem erro e não conta como tentativa errada', async () => {
    rele.naoPronto = 4;
    for (let i = 0; i < 4; i++) {
      const r = await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') });
      assert.equal(r.status, 503); assert.equal(r.json.error, 'not_ready'); assert.equal(r.json.message, 'Preparando a conexão com o Teams…');
    }
    assert.equal((await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') })).status, 200, 'quatro esperas não trancaram a pessoa');
  });

  test('relógio deste computador 3 min adiantado: a prévia não nasce vencida e a conta liga', async () => {
    const real = Date.now; h.teamsApp.agora = () => real() + 3 * 60_000;
    await ligar();
    assert.equal(rele.vinculos.size, 1);
  });

  test('quem fala vai à frente no Teams; a primeira mensagem de cada conta fica à vista no Ergon (e não vai ao Teams)', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const nome = coordenador().name;
    assert.ok(respostas()[0].text!.startsWith(`**${nome}:** `), respostas()[0].text);
    assert.ok(respostas()[0].summary!.startsWith(`${nome}: `));
    const conv = conversaTeams()!;
    const sistema = () => h.db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND role = 'system'", conv).filter((m) => m.content.includes('primeira mensagem pela conta do Teams'));
    assert.equal(sistema().length, 1);
    assert.match(sistema()[0].content, /"Maria Souza", ligada em \d\d\/\d\d às \d\dh\d\d\. Se não foi você que ligou esta conta, desligue em Conexões › Teams\./);
    rele.diz(b, 'Obrigado');
    await ate(() => respostas().length === 2);
    assert.equal(sistema().length, 1, 'só na primeira');
    assert.ok(!rele.enviados.some((e) => /primeira mensagem/.test(e.text ?? '')), 'a nota é só do Ergon');
  });

  test('a equipe espera uma resposta da pessoa (waiting_user): aviso no Teams, uma vez, e o "digitando" para', async () => {
    const b = await ligar();
    h.db.run("UPDATE teams_bindings SET notices = 0 WHERE binding_id = ?", b); // mesmo com os avisos de "Com você" desligados
    const dlv = rele.diz(b, 'Prepare a proposta do cliente Zeta');
    await espera(() => rele.acks.some((a) => a.id === dlv));
    await espera(() => rele.digitando.some((d) => d.bindingId === b && d.on), 'sem "digitando"');
    const conv = conversaTeams()!;
    h.db.run("UPDATE runs SET status = 'waiting_user' WHERE conversation_id = ?", conv);
    h.bus.publish(s.workspaceId, 'runs.changed', {});
    await espera(() => rele.enviados.some((e) => e.card && /espera uma resposta sua/.test(textoDo(e.card))), 'o Teams não soube que a equipe espera por ela');
    const aviso = rele.enviados.find((e) => e.card && /espera uma resposta sua/.test(textoDo(e.card)))!;
    assert.match(textoDo(aviso.card), new RegExp(`${coordenador().name} espera uma resposta sua`));
    assert.match(textoDo(aviso.card), /Abra o Ergon para responder\./);
    await espera(() => rele.digitando.at(-1)?.on === false, 'o "digitando" continuou');
    h.bus.publish(s.workspaceId, 'runs.changed', {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(rele.enviados.filter((e) => e.card && /espera uma resposta sua/.test(textoDo(e.card))).length, 1, 'uma vez por execução');
  });

  test('clique: o ack sai na hora e a decisão corre fora da fila (as mensagens seguintes não esperam)', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Comercial', description: 'Vendas' }]);
    await ate(() => rele.enviados.some((e) => e.card));
    const card = rele.enviados.find((e) => e.card)!;
    const pid = botoes(card.card)[0].data.p as string;
    // a decisão demora (a API do outro app, por exemplo)
    let soltar!: () => void; const lenta = new Promise<void>((ok) => { soltar = ok; });
    const original = h.teamsApp.d.decidir;
    (h.teamsApp.d as { decidir: typeof original }).decidir = async (...a) => { await lenta; return original(...a); };
    const clique = rele.clica(b, botoes(card.card)[0].data, card.activityId);
    await espera(() => rele.acks.some((a) => a.id === clique), 'sem ack do clique');
    assert.equal(rele.acks.find((a) => a.id === clique)!.status, 'accepted');
    assert.equal(h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status, 'proposed', 'o ack veio antes da decisão');
    const msg = rele.diz(b, 'E outra coisa');
    await espera(() => rele.acks.some((a) => a.id === msg && a.status === 'accepted'), 'a mensagem seguinte ficou presa atrás do clique');
    soltar();
    await espera(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)!.status === 'applied', 'não decidiu');
    await espera(() => rele.atualizados.some((u) => u.activityId === card.activityId && /Aprovado por você/.test(textoDo(u.card))), 'o cartão não ficou com a linha final');
  });

  test('clique gravado e o Ergon reiniciando no meio: a decisão é retomada (uma vez)', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Jurídico', description: 'Contratos' }]);
    await ate(() => rele.enviados.some((e) => e.card));
    const card = rele.enviados.find((e) => e.card)!;
    const pid = botoes(card.card)[0].data.p as string;
    (h.teamsApp.d as { decidir: unknown }).decidir = () => new Promise(() => undefined); // nunca termina: o Ergon fecha antes
    const clique = rele.clica(b, botoes(card.card)[0].data, card.activityId);
    await espera(() => rele.acks.some((a) => a.id === clique));
    await h.close();
    assert.equal(rele.fila.length, 0, 'o serviço apagou: a decisão ficou gravada aqui');
    h = await abrir({}, { dir: h.dir });
    await h.teamsApp.start();
    await ate(() => h.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ?', pid)?.status === 'applied', 'a decisão gravada não foi retomada');
    await ate(() => h.db.get<{ state: string }>('SELECT state FROM teams_inbound WHERE delivery_id = ?', clique)?.state === 'feito');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM profiles WHERE workspace_id = ? AND name = 'Jurídico'", s.workspaceId)!.n, 1, 'uma vez');
  });

  test('saída em ordem: a resposta que esbarrou no limite do Teams não é ultrapassada pela seguinte', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!;
    rele.proximoErroDeEnvio = 'rate_limited';
    const agente = coordenador().id;
    for (const t of ['Resposta A', 'Resposta B']) {
      h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', ?, 'local', ?)",
        `msg_${t.slice(-1)}${'0'.repeat(20)}`, s.workspaceId, conv, h.db.seal(s.workspaceId, t), new Date().toISOString());
    }
    void agente;
    h.bus.publish(s.workspaceId, 'messages.changed', { conversationId: conv });
    await espera(() => respostas().length === 3, 'as duas não saíram');
    assert.deepEqual(respostas().slice(1).map((r) => r.text!.replace(/^\*\*[^*]+:\*\* /, '')), ['Resposta A', 'Resposta B']);
  });

  test('pedido que chegou com atraso (da fila, ou escrito há tempo): o agente fica sabendo quando foi; o de agora, não', async () => {
    const b = await ligar();
    const run = (texto: string) => h.db.all<{ instructions: string; content: string }>(
      'SELECT r.instructions, m.content FROM runs r JOIN messages m ON m.run_id = r.id ORDER BY r.created_at DESC').find((x) => x.content === texto)?.instructions ?? '';
    const agora = rele.diz(b, 'pedido de agora');
    await ate(() => rele.acks.some((a) => a.id === agora) && !!run('pedido de agora'));
    assert.ok(run('pedido de agora').includes(NOTA_TEAMS)); assert.doesNotMatch(run('pedido de agora'), /com atraso/);
    await ate(() => respostas().length === 1);
    // escrito há 3 horas (o serviço entregou ao vivo, mas é velho)
    const velho = rele.diz(b, 'manda agora o e-mail confirmando a reunião de hoje', new Date(Date.now() - 3 * 3600_000).toISOString());
    await ate(() => rele.acks.some((a) => a.id === velho) && !!run('manda agora o e-mail confirmando a reunião de hoje'));
    assert.match(run('manda agora o e-mail confirmando a reunião de hoje'), /Pedido enviado pelo Teams em \d\d\/\d\d às \d\dh\d\d, entregue agora com atraso.*confirme com a pessoa/);
    await ate(() => respostas().length === 2);
    // da fila do serviço (o Ergon estava fechado)
    await h.close();
    await espera(() => !rele.conectado());
    rele.diz(b, 'pedido da sexta');
    h = await abrir({}, { dir: h.dir });
    await h.teamsApp.start();
    await ate(() => !!run('pedido da sexta'), 'o pedido guardado não chegou');
    assert.match(run('pedido da sexta'), /entregue agora com atraso/);
  });

  test('ninguém ativo na equipe: a entrega é recusada como no_agent (o serviço avisa a pessoa no Teams)', async () => {
    const b = await ligar();
    h.db.run("UPDATE agents SET status = 'archived' WHERE workspace_id = ?", s.workspaceId);
    const dlv = rele.diz(b, 'alguém aí?');
    await ate(() => rele.acks.some((a) => a.id === dlv));
    const a = rele.acks.find((x) => x.id === dlv)!;
    assert.equal(a.status, 'rejected'); assert.equal(a.error?.code, 'no_agent');
    assert.equal(rele.fila.length, 0);
  });

  test('o ack do link.confirm se perdeu na queda: o confirm reenviado resolve; nada é desfeito', async () => {
    rele.perderAckDoConfirm = true;
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') });
    const ok = await req(h, 'POST', '/api/teams-app/confirm', s, { claimId: c.json.claimId, ciente: true, password: SENHA });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.ok(rele.conexoes >= 2, 'a conexão caiu e voltou');
    assert.equal(rele.quadros.filter((q) => q.type === 'link.revoke').length, 0, 'o vínculo novo não foi desfeito');
    assert.equal(rele.vinculos.size, 1); assert.equal(ok.json.binding.status, 'active');
    assert.ok(!rele.automaticas.some((x) => /desligada do Ergon/.test(x.texto)));
  });

  test('reconciliação: vínculo do serviço com o claimId de um link.confirm pendente daqui é adotado, não desfeito', async () => {
    const c = await req(h, 'POST', '/api/teams-app/claim', s, { code: rele.codigoPara('Maria Souza') });
    const claimId = c.json.claimId as string;
    // o serviço ligou, e este Ergon ainda espera a resposta (ou ela caiu): simula o estado sem a resposta
    rele.semResposta.add('link.confirm');
    const pendente = req(h, 'POST', '/api/teams-app/confirm', s, { claimId, ciente: true, password: SENHA });
    await espera(() => rele.quadros.some((q) => q.type === 'link.confirm'));
    const cl = rele.claims.get(claimId)!;
    const bindingId = 'bnd_adotado0000000001';
    rele.vinculos.set(bindingId, { bindingId, installationId: cl.installationId, personRef: cl.personRef, status: 'active', notices: true, teamsName: 'Maria Souza', label: 'Alexandre', linkedAt: new Date().toISOString(), claimId });
    rele.derrubar(1001);
    await ate(() => h.db.get<{ status: string }>('SELECT status FROM teams_bindings WHERE binding_id = ?', bindingId)?.status === 'active', 'não adotou o vínculo');
    assert.equal(rele.quadros.filter((q) => q.type === 'link.revoke').length, 0);
    rele.semResposta.delete('link.confirm');
    await pendente.catch(() => undefined);
  });

  test('pedidos da tela ao serviço têm prazo; a conexão que para de vez (4403) solta quem esperava', async () => {
    const b = await ligar();
    h.teamsApp.ajustes.pedidoMs = 300;
    rele.semResposta.add('link.update');
    const t0 = Date.now();
    const g = await req(h, 'POST', '/api/teams-app/enabled', s, { enabled: false });
    assert.equal(g.status, 200); assert.equal(g.json.bindings[0].status, 'paused', 'o estado daqui vale');
    assert.ok(Date.now() - t0 < 3000, 'não ficou esperando');
    h.teamsApp.ajustes.pedidoMs = 60_000;
    const pendente = req(h, 'PATCH', `/api/teams-app/bindings/${b}`, s, { notices: false });
    await espera(() => rele.quadros.filter((q) => q.type === 'link.update').length >= 2);
    const t1 = Date.now();
    rele.conexao!.fechar(4403);
    const r = await pendente;
    assert.equal(r.status, 200); assert.equal(r.json.binding.notices, false);
    assert.ok(Date.now() - t1 < 3000, 'a tela não ficou presa');
  });

  test('cartão aberto há mais de 7 dias: a origem fica (a decisão de depois ainda atualiza o cartão); o pendente velho some', async () => {
    const b = await ligar();
    rele.diz(b, 'Oi');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'sector_new', name: 'Compras', description: 'x' }]);
    await ate(() => rele.enviados.some((e) => e.card));
    const card = rele.enviados.find((e) => e.card)!;
    // a origem só é guardada depois que o serviço confirmou a entrega (status sent): sob carga, o ack chega um pouco depois
    await ate(() => h.db.get<{ status: string }>('SELECT status FROM teams_outbox WHERE id = ?', card.id)?.status === 'sent', 'a entrega do cartão não foi confirmada');
    const velho = new Date(Date.now() - 8 * 86_400_000).toISOString();
    h.db.run('UPDATE teams_outbox SET created_at = ? WHERE id = ?', velho, card.id);
    h.db.run("INSERT INTO teams_outbox (id, binding_id, workspace_id, kind, payload, purpose, attempts, next_at, status, created_at) VALUES ('out_velhopendente01', ?, ?, 'send', ?, 'reply', 0, ?, 'failed', ?)",
      b, s.workspaceId, h.db.seal(s.workspaceId, '{"text":"x"}'), velho, velho);
    (h.teamsApp as unknown as { varredura(): void }).varredura();
    assert.ok(h.db.get('SELECT 1 AS x FROM teams_outbox WHERE id = ?', card.id), 'a origem do cartão aberto ficou');
    assert.equal(h.db.get('SELECT 1 AS x FROM teams_outbox WHERE id = ?', 'out_velhopendente01'), undefined);
    const pid = botoes(card.card)[0].data.p as string;
    assert.equal((await req(h, 'POST', `/api/proposals/${pid}`, s, { decision: 'reject' })).json.status, 'rejected');
    await ate(() => rele.atualizados.some((u) => u.activityId === card.activityId && /Recusado por você/.test(textoDo(u.card))), 'o cartão não foi atualizado');
  });

});

class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  async health() { return { ok: true, detail: 'falso' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${this.started.length}`;
    this.runs.set(runId, { status: 'completed', output: 'Feito.', error: null, sessionId: 'sess-1', usage: { inputTokens: 10, outputTokens: 5, costUsd: null }, model: 'x/y' });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: ['todo'] }]; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'x/y', provider: 'nous', providers: [] }; }
}
class Control implements HermesControlClient {
  async health() { return true; }
  async accounts() { return []; }
  async startLogin() { return { sessionId: 's', userCode: null, verificationUrl: null, expiresAt: null, pollSeconds: 5 }; }
  async pollLogin() { return { status: 'pending', error: null, email: null, model: null }; }
  async cancelLogin() {}
  async disconnect() {}
  async modelInfo() { return { model: 'x/y', provider: 'nous' }; }
  async setDefaultModel() { return { ok: true, confirmMessage: null }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: ['todo'], safe: ['todo', 'web'] }; }
  async setApiToolsets(e: string[]) { return ['todo', ...e.filter((x) => x !== 'todo')]; }
}

describe('Conversar pelo Teams (revisão): autorizar na conversa "Teams"', () => {
  beforeEach(async () => {
    throttle.reset();
    rele = await ReleFalso.iniciar();
    h = await abrir({ executor: 'hermes', hermesApiKey: ['chave', 'de', 'teste', '123'].join('-'), bridgeToken: ['token', 'da', 'ponte', 'de', 'teste', '0123456789'].join('-') }, { hermes: new Motor(), control: new Control() });
    s = await setupOwner(h);
    await h.ai.refreshToolsets();
    await h.teamsApp.start();
    await ate(() => rele.conectado());
  });
  afterEach(async () => { await h.close(); await rele.parar(); });

  test('a continuação depois de autorizar na conversa "Teams" usa a nota do Teams', async () => {
    const b = await ligar();
    rele.diz(b, 'Some a planilha');
    await ate(() => respostas().length === 1);
    const conv = conversaTeams()!;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: conv, runId: null }, [{ kind: 'permission', agent: coordenador().name, tool: 'calculo', reason: 'somar a coluna' }]);
    const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'permission' AND workspace_id = ?", s.workspaceId)!.id;
    const r = await req(h, 'POST', `/api/proposals/${pid}/authorize`, s, { password: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const cont = h.db.get<{ instructions: string }>("SELECT instructions FROM runs WHERE conversation_id = ? AND idempotency_key = ?", conv, `perm-${pid}`);
    assert.ok(cont, 'o agente continuou');
    assert.ok(cont!.instructions.includes(NOTA_TEAMS), 'com a nota do Teams');
    assert.doesNotMatch(cont!.instructions, /Canal: conversa no Ergon\./);
  });
});

describe('Conversar pelo Teams (revisão): relógio e registro', () => {
  beforeEach(async () => { rele = await ReleFalso.iniciar(); });
  afterEach(async () => { await h.close(); await rele.parar(); });

  test('relógio 6 min adiantado: o registro é refeito uma vez com a hora do serviço e a conexão usa a hora dele', async () => {
    h = await abrir();
    s = await setupOwner(h);
    const real = Date.now; h.teamsApp.agora = () => real() + 6 * 60_000;
    await h.teamsApp.start();
    await ate(() => rele.conectado(), 'não conectou com o relógio fora da hora');
    assert.equal(rele.tentativasDeRegistro, 2, 'recusado uma vez, refeito uma vez');
    assert.equal(rele.registros, 1);
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.problem, undefined);
  });

  test('registro recusado de verdade: uma correção só por tentativa, espera que dobra, e a tela explica', async () => {
    rele.recusarRegistro = true;
    h = await abrir();
    s = await setupOwner(h);
    await h.teamsApp.start();
    assert.equal(rele.tentativasDeRegistro, 2);
    assert.equal(h.teamsApp.esperaDoRegistro, 100);
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.problem, 'registro');
    await espera(() => rele.tentativasDeRegistro >= 4, 'não tentou de novo');
    await espera(() => h.teamsApp.esperaDoRegistro === 200, 'a espera não dobrou');
    rele.recusarRegistro = false;
    await espera(() => rele.conectado(), 'não registrou quando o serviço voltou a aceitar', 3000);
    assert.equal((await req(h, 'GET', '/api/teams-app', s)).json.problem, undefined);
  });

  test('avisos de "Com você" agrupados que não saíram antes de reiniciar saem depois', async () => {
    h = await abrir({}, {}, { avisosMs: 60_000 });
    s = await setupOwner(h);
    await h.teamsApp.start();
    await ate(() => rele.conectado());
    await ligar();
    const fora = (await req(h, 'POST', '/api/conversations', s, { agentId: coordenador().id })).json.id as string;
    recordProposals(h.db, h.bus, s.workspaceId, { conversationId: fora, runId: null }, [{ kind: 'sector_new', name: 'Setor X', description: 'x' }]);
    await espera(() => !!h.db.get('SELECT 1 AS x FROM teams_noticed WHERE user_id = ? AND sent = 0', s.userId), 'o aviso não ficou agrupado');
    await h.close();
    await espera(() => !rele.conectado());
    h = await abrir({}, { dir: h.dir });
    await h.teamsApp.start();
    await ate(() => rele.enviados.some((e) => e.purpose === 'notice'), 'o aviso pendente não saiu depois de reiniciar');
    assert.match(textoDo(rele.enviados.find((e) => e.purpose === 'notice')!.card), /Setor X/);
  });
});
