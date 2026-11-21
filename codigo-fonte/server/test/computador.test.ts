/**
 * Controle do computador (rc.42): a política (pura), o formato do que chega ao aparelho, e as rotas com um Ergon Desktop
 * falso (o mesmo protocolo do aplicativo: desktop/src-tauri/src/computador). O controle real do mouse e do teclado é
 * testado no aplicativo (cargo test e o teste sob Xvfb).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { MSG, classificar, decidir, pareceCartao, pareceSenha, pedidoParaOAparelho, respostaDoAparelho, resumoParaRegistro } from '../src/services/computador.ts';
import { ORIGIN, addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

process.env.ERGON_COMPUTADOR_ESPERA_MS ??= '1500';
const TOKEN = 'token-da-ponte-de-teste-computador-0123456789';

describe('computador: política', () => {
  const base = { bloqueado: false, modo: 'total' as const, naoPerguntar: false, liberarTudo: false, leitura: false, protegida: false, umaVez: false };
  test('desligado pergunta "Ativar acesso total?" (ou recusa calado com "não perguntar"); bloqueio de quem administra vale acima de tudo', () => {
    assert.equal(decidir({ ...base, modo: 'desligado' }), 'ativar');
    assert.equal(decidir({ ...base, modo: 'desligado', leitura: true }), 'ativar', 'nem olhar a tela sem a pessoa ligar');
    assert.equal(decidir({ ...base, modo: 'desligado', naoPerguntar: true }), 'recusar');
    assert.equal(decidir({ ...base, modo: 'desligado', umaVez: true }), 'direto');
    for (const modo of ['desligado', 'cada_acao', 'total'] as const) assert.equal(decidir({ ...base, modo, bloqueado: true, umaVez: true, liberarTudo: true }), 'recusar');
  });
  test('acesso total segue direto; confirmar cada ação pergunta o que mexe (menos com "Liberar tudo"); as protegidas sempre perguntam', () => {
    assert.equal(decidir(base), 'direto');
    assert.equal(decidir({ ...base, modo: 'cada_acao' }), 'confirmar');
    assert.equal(decidir({ ...base, modo: 'cada_acao', leitura: true }), 'direto');
    assert.equal(decidir({ ...base, modo: 'cada_acao', liberarTudo: true }), 'direto');
    for (const x of [{ modo: 'total' as const }, { modo: 'cada_acao' as const, liberarTudo: true }, { modo: 'total' as const, umaVez: true }]) assert.equal(decidir({ ...base, ...x, protegida: true }), 'confirmar');
  });
  test('protegidas: senha, chave, cartão, apagar de vez, cofre de senhas', () => {
    assert.equal(classificar('capture', {}).leitura, true);
    assert.equal(classificar('type', { text: 'Olá, tudo bem?' }).protegida, null);
    assert.equal(classificar('type', { text: 'relatorio-final.docx' }).protegida, null);
    assert.equal(classificar('type', { text: 'ana@empresa.com.br' }).protegida, null);
    assert.equal(classificar('type', { text: 'Tr0ub4dor&3xyz' }).protegida, 'segredo');
    assert.equal(classificar('type', { text: 'senha: abc' }).protegida, 'segredo');
    assert.equal(classificar('type', { text: `ghp_${'a'.repeat(36)}` }).protegida, 'segredo');
    assert.equal(classificar('type', { text: '4111 1111 1111 1111' }).protegida, 'pagamento');
    assert.equal(classificar('type', { text: '4111 1111 1111 1112' }).protegida, null, 'não passa no dígito verificador');
    assert.equal(classificar('type', { text: 'rm -rf ~/projetos\n' }).protegida, 'apagar');
    assert.equal(classificar('type', { text: 'DROP TABLE clientes;' }).protegida, 'apagar');
    assert.equal(classificar('key', { keys: 'shift+delete' }).protegida, 'apagar');
    assert.equal(classificar('key', { keys: 'ctrl+s' }).protegida, null);
    assert.equal(classificar('focus_app', { app: 'Bitwarden' }).protegida, 'segredo');
    assert.equal(classificar('focus_app', { app: 'xterm' }).protegida, null);
    assert.ok(pareceCartao('5500-0000-0000-0004') && !pareceCartao('12345'));
    assert.ok(pareceSenha('S3nh@Forte!') && !pareceSenha('https://example.com/A1b2c3d4') && !pareceSenha('palavra'));
  });
  test('o registro diz o que foi feito, nunca o que foi digitado', () => {
    assert.equal(resumoParaRegistro('type', { text: 'segredo-que-não-vai-ao-registro' }), 'digitou 31 caracteres');
    assert.equal(resumoParaRegistro('click', { coordinate: [10, 20] }), 'clicou em 10, 20');
    assert.equal(resumoParaRegistro('focus_app', { app: 'Calculadora\u0007' }), 'abriu Calculadora');
    assert.equal(resumoParaRegistro('key', { keys: 'ctrl+alt+t' }), 'apertou ctrl+alt+t');
  });
  test('o que chega ao aparelho: só ações conhecidas, campos conferidos', () => {
    assert.deepEqual(pedidoParaOAparelho('CLICK', { coordinate: [5, 6], button: 'right', extra: 'x' }), { acao: 'click', args: { coordinate: [5, 6], button: 'right' } });
    for (const [a, x] of [['explodir', {}], ['click', {}], ['click', { coordinate: [-1, 2] }], ['click', { coordinate: [1.5, 2] }], ['click', { element: 3 }], ['type', { text: '' }], ['type', { text: 'x'.repeat(4001) }],
      ['key', { keys: 'ctrl+s; rm' }], ['focus_app', { app: 'calc; rm -rf /' }], ['focus_app', { app: '$(id)' }], ['capture', { mode: 'ax' }], ['click', { coordinate: [1, 1], modifiers: ['hyper'] }]] as const) {
      assert.ok('erro' in pedidoParaOAparelho(a, x as Record<string, unknown>), `${a} ${JSON.stringify(x)}`);
    }
    assert.deepEqual(pedidoParaOAparelho('scroll', { direction: 'lado', amount: 999 }), { acao: 'scroll', args: { direction: 'down', amount: 3 } });
    assert.deepEqual(pedidoParaOAparelho('wait', { seconds: 99 }), { acao: 'wait', args: { seconds: 10 } });
  });
  test('do aparelho para o motor passa só o formato da ferramenta', () => {
    assert.deepEqual(respostaDoAparelho({ ok: true, message: 'clicou', segredo: 'x', code: 'BAD CODE' }), { ok: true, message: 'clicou' });
    assert.deepEqual(respostaDoAparelho({ ok: true, png_b64: 'iVBORw0KGgo=', mime: 'image/png', width: 1280, height: 800 }), { ok: true, png_b64: 'iVBORw0KGgo=', mime: 'image/png', width: 1280, height: 800 });
    assert.equal(respostaDoAparelho({ ok: true, png_b64: '<svg onload=x>' }).png_b64, undefined);
    assert.deepEqual(respostaDoAparelho({ ok: true, apps: [{ name: 'xterm', pid: 42, outro: 1 }, 'lixo'] }).apps, [{ name: 'xterm', pid: 42 }]);
    assert.equal(respostaDoAparelho(null).ok, false);
  });
});

// ---------------------------------------------------------------------------------------------- rotas
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_pc${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** O Ergon Desktop falso: abre a ligação como o aplicativo e responde cada ação como o driver nativo. */
interface Desk { ws: WebSocket; msgs: any[]; acoes: any[]; fechou: number | null; responder: boolean }
function ligarDesk(porta: number, opts: { cookie?: string | null; origin?: string | null; site?: string; permissoes?: Record<string, unknown> } = {}): Promise<Desk | number> {
  return new Promise((ok) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.site) headers['sec-fetch-site'] = opts.site;
    const ws = new WebSocket(`ws://127.0.0.1:${porta}/api/computador/aparelho`, { headers });
    const d: Desk = { ws, msgs: [], acoes: [], fechou: null, responder: true };
    desks.push(d);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      d.msgs.push(m);
      if (m.t === 'acao') {
        d.acoes.push(m);
        if (!d.responder) return;
        const r = m.acao === 'capture' ? { ok: true, png_b64: 'iVBORw0KGgo=', mime: 'image/png', width: 1280, height: 800 } : { ok: true, message: `feito: ${m.acao}` };
        ws.send(JSON.stringify({ t: 'resposta', id: m.id, r }));
      }
    });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'ola', so: 'linux', versao: 'teste', permissoes: opts.permissoes ?? { entrada: true, tela: true }, tela: { largura: 1280, altura: 800 } })); ok(d); });
    ws.on('close', (c) => { d.fechou = c; });
    ws.on('unexpected-response', (_q, r) => { r.resume(); ok(r.statusCode ?? 0); });
    ws.on('error', () => undefined);
  });
}

let h: Harness; let s: Session; let agente: string; let porta: number;
const desks: Desk[] = [];
const dorme = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const ate = async (cond: () => boolean, ms = 3000) => { const fim = Date.now() + ms; while (!cond() && Date.now() < fim) await dorme(15); assert.ok(cond(), 'a condição não chegou a tempo'); };
const doMotor = (corpo: Record<string, unknown>, token = TOKEN) => req(h, 'POST', '/internal/bridge/v1/computador', null, corpo, { 'x-ergon-bridge-token': token });
const estado = async (quem: Session = s) => (await req(h, 'GET', '/api/computador', quem)).json;

async function conversa(quem: Session = s): Promise<{ run: string; sessao: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', quem, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, quem, { text: 'abra a calculadora e some 2 + 2', clientRequestId: `m-${crypto.randomUUID()}` });
  for (let i = 0; i < 3; i++) await h.executor.tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!;
  return { run: r.id, sessao: r.hermes_session_id };
}

describe('computador: rotas', () => {
  beforeEach(async () => {
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, 'aspasia')!.id;
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    porta = (h.app.server.address() as { port: number }).port;
  });
  afterEach(async () => { for (const d of desks.splice(0)) d.ws.terminate(); await h.close(); });

  test('a ligação do aparelho: origem do Ergon, sessão válida, nada de outro site', async () => {
    assert.equal(await ligarDesk(porta, { cookie: s.cookie, origin: null }), 403);
    assert.equal(await ligarDesk(porta, { cookie: s.cookie, origin: 'https://outra.example' }), 403);
    assert.equal(await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN, site: 'cross-site' }), 403);
    assert.equal(await ligarDesk(porta, { cookie: null, origin: ORIGIN }), 401);
    assert.equal(await ligarDesk(porta, { cookie: 'ergon_session=inventado', origin: ORIGIN }), 401);
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    assert.deepEqual(d.msgs[0], { t: 'ola', emUso: false, agente: null, controle: 'agente' });
    await dorme(50);
    const e = await estado();
    assert.deepEqual(e.aparelho, { conectado: true, so: 'linux', permissoes: { entrada: true, tela: true, passo: null } });
    assert.equal(e.modo, 'desligado');
    // uma ligação por pessoa: a nova fecha a velha
    const d2 = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.fechou === 4000);
    d2.ws.close();
    await ate(() => d2.fechou !== null);
    await dorme(50);
    assert.equal((await estado()).aparelho.conectado, false);
  });

  test('sem token, sem trabalho, sem aparelho: o agente recebe uma frase clara e nada chega ao computador', async () => {
    const { sessao } = await conversa();
    assert.equal((await doMotor({ acao: 'capture', session_id: sessao }, 'token-errado-token-errado-token-errado')).status, 401);
    assert.equal((await doMotor({ acao: 'capture', session_id: 'sessao-desconhecida' })).json.code, 'sem_trabalho');
    const r = (await doMotor({ acao: 'capture', session_id: sessao })).json;
    assert.deepEqual(r, { ok: false, code: 'sem_aparelho', error: MSG.semAparelho });
    assert.equal((await doMotor({ acao: 'explodir', session_id: sessao })).json.code, 'invalid');
  });

  test('primeira vez: o cartão "Ativar acesso total?"; Ativar libera e a ação chega ao aparelho, com registro sem o texto', async () => {
    const { run, sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    const pedido = doMotor({ acao: 'click', args: { coordinate: [100, 200] }, session_id: sessao });
    let e: any; for (let i = 0; i < 100 && !(e = await estado()).pedidos.length; i++) await dorme(10);
    assert.equal(e.pedidos.length, 1);
    assert.equal(e.pedidos[0].tipo, 'ativar');
    assert.equal(d.acoes.length, 0, 'nada chega ao computador antes da pessoa decidir');
    assert.equal((await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'permitir' })).status, 400);
    assert.equal((await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'ativar' })).status, 200);
    const r = (await pedido).json;
    assert.deepEqual(r, { ok: true, message: 'feito: click' });
    assert.deepEqual(d.acoes[0].args, { coordinate: [100, 200] });
    assert.equal((await estado()).modo, 'total');
    assert.ok(d.msgs.some((m) => m.t === 'estado' && m.emUso === true && m.agente), 'a borda e o selo acendem no aparelho');
    // digitar: segue direto, e o registro não guarda o texto
    assert.deepEqual((await doMotor({ acao: 'type', args: { text: 'bom dia equipe' }, session_id: sessao })).json, { ok: true, message: 'feito: type' });
    const reg = h.db.all<{ action: string; evidence: string; result: string }>("SELECT action, evidence, result FROM audit_events WHERE action LIKE 'computador.%' ORDER BY created_at");
    assert.ok(reg.some((x) => x.action === 'computador.click' && /clicou em 100, 200/.test(String(x.result))));
    assert.ok(reg.some((x) => x.action === 'computador.type' && /digitou 14 caracteres/.test(String(x.result))));
    assert.ok(!JSON.stringify(reg).includes('bom dia'), 'o texto digitado não vai ao registro');
    // a captura volta inteira ao agente e não é registrada
    const cap = (await doMotor({ acao: 'capture', args: { mode: 'vision' }, session_id: sessao })).json;
    assert.equal(cap.png_b64, 'iVBORw0KGgo=');
    assert.ok(!h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'computador.capture'"));
    const est = await estado();
    assert.equal(est.emUso.agente.length > 0, true);
    assert.equal(h.db.get<{ id: string }>('SELECT id FROM runs WHERE id = ?', run)!.id, run);
    d.ws.close();
  });

  test('"Só desta vez" vale só para o trabalho; "Agora não" com "Não perguntar novamente" desliga calado', async () => {
    const um = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    const p1 = doMotor({ acao: 'key', args: { keys: 'ctrl+alt+t' }, session_id: um.sessao });
    let e: any; for (let i = 0; i < 100 && !(e = await estado()).pedidos.length; i++) await dorme(10);
    await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'uma_vez' });
    assert.equal((await p1).json.ok, true);
    assert.equal((await estado()).modo, 'desligado', 'só desta vez não liga o recurso');
    const dois = await conversa();
    const p2 = doMotor({ acao: 'capture', session_id: dois.sessao });
    for (let i = 0; i < 100 && !(e = await estado()).pedidos.length; i++) await dorme(10);
    await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'agora_nao', naoPerguntar: true });
    assert.deepEqual((await p2).json, { ok: false, code: 'recusou', error: MSG.recusou });
    assert.deepEqual((await doMotor({ acao: 'capture', session_id: dois.sessao })).json, { ok: false, code: 'desligado', error: MSG.desligado });
    assert.equal((await estado()).pedidos.length, 0, 'nenhum cartão novo');
    d.ws.close();
  });

  test('sem resposta: o agente é orientado a chamar de novo, e o mesmo cartão continua (sem repetir)', async () => {
    const { sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    const r = (await doMotor({ acao: 'capture', session_id: sessao })).json;
    assert.deepEqual(r, { ok: false, code: 'sem_resposta', error: MSG.semResposta });
    const p = doMotor({ acao: 'capture', session_id: sessao });
    await dorme(100);
    assert.equal((await estado()).pedidos.length, 1);
    const id = (await estado()).pedidos[0].id;
    await req(h, 'POST', `/api/computador/pedidos/${id}`, s, { escolha: 'ativar' });
    assert.equal((await p).json.ok, true);
    d.ws.close();
  });

  test('protegidas pedem o clique mesmo com acesso total e "Liberar tudo"; confirmar cada ação pergunta o que mexe', async () => {
    const { sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    await req(h, 'PUT', '/api/computador/modo', s, { modo: 'total' });
    await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: true });
    const p = doMotor({ acao: 'type', args: { text: 'S3nh@Forte!2026' }, session_id: sessao });
    let e: any; for (let i = 0; i < 100 && !(e = await estado()).pedidos.length; i++) await dorme(10);
    assert.deepEqual(e.pedidos[0], { id: e.pedidos[0].id, tipo: 'confirmar', recurso: 'computador', agente: e.pedidos[0].agente, resumo: 'digitar uma senha ou chave', protegida: 'segredo' });
    assert.ok(!JSON.stringify(e).includes('S3nh@'), 'a tela não mostra a senha');
    await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'recusar' });
    assert.equal((await p).json.code, 'recusou_acao');
    assert.equal(d.acoes.length, 0);
    // confirmar cada ação (sem "Liberar tudo"): olhar segue direto, clicar pergunta
    await req(h, 'PUT', '/api/conexoes/liberar-tudo', s, { on: false });
    await req(h, 'PUT', '/api/computador/modo', s, { modo: 'cada_acao' });
    assert.equal((await doMotor({ acao: 'capture', session_id: sessao })).json.ok, true);
    const c = doMotor({ acao: 'click', args: { coordinate: [1, 1] }, session_id: sessao });
    for (let i = 0; i < 100 && !(e = await estado()).pedidos.length; i++) await dorme(10);
    assert.equal(e.pedidos[0].resumo, 'clicou em 1, 1');
    await req(h, 'POST', `/api/computador/pedidos/${e.pedidos[0].id}`, s, { escolha: 'permitir' });
    assert.equal((await c).json.ok, true);
    d.ws.close();
  });

  test('Assumir o controle (tela, selo ou mouse de verdade) para o agente na hora; Conceder devolve', async () => {
    const { sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    await req(h, 'PUT', '/api/computador/modo', s, { modo: 'total' });
    assert.equal((await doMotor({ acao: 'click', args: { coordinate: [3, 4] }, session_id: sessao })).json.ok, true);
    // a pessoa mexeu o mouse (o aparelho avisa)
    d.ws.send(JSON.stringify({ t: 'assumir', motivo: 'mouse' }));
    await ate(() => d.msgs.some((m) => m.t === 'parar'));
    assert.equal((await estado()).controle, 'pessoa');
    assert.deepEqual((await doMotor({ acao: 'click', args: { coordinate: [3, 4] }, session_id: sessao })).json, { ok: false, code: 'human_has_control', error: MSG.pessoa });
    assert.equal(d.acoes.length, 1);
    // conceder pela tela do Ergon
    assert.equal((await req(h, 'POST', '/api/computador/controle', s, { pessoa: false })).json.controle, 'agente');
    assert.equal((await doMotor({ acao: 'click', args: { coordinate: [3, 4] }, session_id: sessao })).json.ok, true);
    // assumir no meio de uma ação: o resultado é descartado
    d.responder = false;
    const p = doMotor({ acao: 'capture', session_id: sessao });
    await ate(() => d.acoes.length === 3);
    await req(h, 'POST', '/api/computador/controle', s, { pessoa: true });
    const ultima = d.acoes[2];
    d.ws.send(JSON.stringify({ t: 'resposta', id: ultima.id, r: { ok: true, png_b64: 'iVBORw0KGgo=' } }));
    assert.equal((await p).json.code, 'human_has_control');
    // a tecla de pânico também
    d.ws.send(JSON.stringify({ t: 'conceder' }));
    await ate(() => d.msgs.filter((m) => m.t === 'estado' && m.controle === 'agente').length >= 2);
    d.ws.send(JSON.stringify({ t: 'assumir', motivo: 'panico' }));
    await dorme(50);
    assert.equal((await estado()).motivo, 'panico');
    const reg = h.db.all<{ action: string }>("SELECT action FROM audit_events WHERE action IN ('computador.assumiu', 'computador.concedeu')").map((x) => x.action);
    assert.ok(reg.includes('computador.assumiu') && reg.includes('computador.concedeu'));
    d.ws.close();
  });

  test('quem administra bloqueia para o workspace; quem não administra não bloqueia', async () => {
    const { sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    await req(h, 'PUT', '/api/computador/modo', s, { modo: 'total' });
    // quem é do workspace sem administrar não bloqueia
    const bia = { ...(await addPerson(h, 'bia', 'senha-da-bia-123')), workspaceId: s.workspaceId, role: 'member' };
    assert.throws(() => h.computador.definirBloqueio(bia as never, true), /Só quem administra/);
    assert.equal((await req(h, 'PUT', '/api/computador/bloqueio', s, { bloqueado: true })).json.bloqueado, true);
    assert.deepEqual((await doMotor({ acao: 'capture', session_id: sessao })).json, { ok: false, code: 'bloqueado', error: MSG.bloqueado });
    assert.equal((await req(h, 'PUT', '/api/computador/modo', s, { modo: 'total' })).status, 409);
    assert.equal(d.acoes.length, 0);
    d.ws.close();
  });

  test('sem a permissão do sistema (macOS: Acessibilidade e Gravação de tela): o agente espera, a tela mostra o passo', async () => {
    const { sessao } = await conversa();
    const d = await ligarDesk(porta, { cookie: s.cookie, origin: ORIGIN, permissoes: { entrada: false, tela: true, passo: 'macos_acessibilidade' } }) as Desk;
    await ate(() => d.msgs.some((m) => m.t === 'ola'));
    await dorme(30);
    await req(h, 'PUT', '/api/computador/modo', s, { modo: 'total' });
    assert.deepEqual((await estado()).aparelho.permissoes, { entrada: false, tela: true, passo: 'macos_acessibilidade' });
    assert.equal((await doMotor({ acao: 'click', args: { coordinate: [1, 1] }, session_id: sessao })).json.code, 'permissao');
    d.ws.send(JSON.stringify({ t: 'permissoes', permissoes: { entrada: true, tela: true } }));
    await dorme(30);
    assert.equal((await doMotor({ acao: 'click', args: { coordinate: [1, 1] }, session_id: sessao })).json.ok, true);
    d.ws.close();
  });
});

describe('computador: nuvem', () => {
  test('na nuvem não há área de trabalho: a ferramenta diz isso e nenhum aparelho liga', async () => {
    const nuvem = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: new Motor() });
    try {
      // o serviço com nuvem=true (o mesmo do modo cloud): o motor recebe a frase da nuvem
      const { Computador } = await import('../src/services/computador.ts');
      const c = new Computador({ db: nuvem.db, bus: nuvem.bus, origens: [ORIGIN], sessao: () => null, nuvem: true, liberarTudo: () => false, donoDe: () => null, membro: () => true, nomeDoAgente: () => 'Aspásia' });
      assert.deepEqual(await c.doMotor({ id: 'run_x', workspace_id: 'wsp_x', agent_id: 'agt_x', conversation_id: null, task_id: null }, 'capture', {}), { ok: false, code: 'sem_area_de_trabalho', error: MSG.nuvem });
      c.fechar();
    } finally { await nuvem.close(); }
  });
});

describe('ligações da rc.42 com o resto do Ergon', () => {
  test('"Ativar acesso total?" de Mãos na massa põe o computador em "total" (menos bloqueado ou na nuvem), sem derrubar a ativação', async () => {
    const { Computador } = await import('../src/services/computador.ts');
    const h = await harness();
    const s = await setupOwner(h);
    const a = { workspaceId: s.workspaceId, userId: h.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id, role: 'owner' } as any;
    const deps = { db: h.db, bus: h.bus, origens: [], sessao: () => null, liberarTudo: () => false, donoDe: () => null, membro: () => true, nomeDoAgente: () => 'X' } as any;
    const pc = new Computador({ ...deps, nuvem: false });
    assert.equal(pc.modo(a.workspaceId, a.userId), 'desligado');
    pc.aoAtivarAcessoTotal(a);
    assert.equal(pc.modo(a.workspaceId, a.userId), 'total');
    pc.definirModo(a, 'cada_acao'); pc.definirBloqueio(a, true);
    assert.doesNotThrow(() => pc.aoAtivarAcessoTotal(a));
    assert.equal(pc.modo(a.workspaceId, a.userId), 'cada_acao', 'bloqueado: fica como está');
    pc.definirBloqueio(a, false);
    new Computador({ ...deps, nuvem: true }).aoAtivarAcessoTotal(a);
    assert.equal(pc.modo(a.workspaceId, a.userId), 'cada_acao', 'na nuvem: nada muda');
    pc.fechar(); await h.close();
  });

  test('catálogo: Administrar o Discord e Diagnóstico opcionais, desligados; Diagnóstico com a trava do Terminal', async () => {
    const { TOOLS, GUARDED_TOOLSETS, PESADAS_FORA_DO_COORDENADOR } = await import('../src/services/characters.ts');
    assert.equal(TOOLS.discord.toolset, 'discord_admin');
    assert.equal(TOOLS.discord.safe, true); assert.equal(TOOLS.discord.status, 'desligada');
    assert.equal(TOOLS.diagnostico.toolset, 'debugging');
    // mesmo portão do Terminal: protegida (senha), bloqueada por padrão, fora das que a pessoa liga livre
    for (const k of ['guarded', 'safe', 'status', 'kind'] as const) assert.equal(TOOLS.diagnostico[k], TOOLS.terminal[k], k);
    assert.equal(GUARDED_TOOLSETS.debugging, 'diagnostico');
    assert.equal(GUARDED_TOOLSETS.terminal, 'terminal');
    for (const id of ['discord', 'diagnostico', 'computador']) assert.ok(PESADAS_FORA_DO_COORDENADOR.includes(id), id);
    // sem pedir, ninguém tem: o agente novo não recebe nenhuma das duas
    const h = await harness(); const s = await setupOwner(h);
    const tools = h.db.all<{ tools: string | null }>('SELECT tools FROM agents WHERE workspace_id = ?', s.workspaceId).flatMap((x) => JSON.parse(x.tools ?? '[]') as string[]);
    assert.ok(!tools.includes('discord') && !tools.includes('diagnostico'));
    await h.close();
  });
});
