/**
 * Navegador ao vivo com "Assumir o controle" (rc.41): o protocolo, a máquina de estados e as rotas, com um motor falso
 * fiel à transmissão do agent-browser (os mesmos formatos de mensagem, medidos na imagem do motor) atrás de uma ponte que
 * confere o token. O teste com o motor de verdade fica em hermes/tests/test_ergon_bridge_navegador.py.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { Balde, OCIOSO_MS, Posse, QUEDA_MS, TETO_MS, enderecoParaTela, entradaDaPessoa, lerDoMotor, tamanhoDoJpeg } from '../src/services/navegador.ts';
import { ORIGIN, addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-navegador-0123456789';
const SENHA = ['s3nh', '@-', 'Secreta', '-91'].join('');
/** um JPEG mínimo com o cabeçalho de tamanho (SOF0): o bastante para o servidor ler largura e altura */
const jpegDe = (largura: number, altura: number, resto = 200) => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, altura >> 8, altura & 255, largura >> 8, largura & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), sof, Buffer.alloc(resto, 7)]);
};
// como na imagem do motor: a transmissão diz 1280×720 (a janela), o quadro é a área da página (1280×577)
const JPEG = jpegDe(1280, 577);
const quadro = (jpeg: Buffer = JPEG) => JSON.stringify({ type: 'frame', data: jpeg.toString('base64'), metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 } });

// ---------------------------------------------------------------------------------------------- unidade
describe('navegador: protocolo', () => {
  test('do motor para a tela passa só quadro, tamanho e página; comandos e resultados do agente nunca', () => {
    const q = lerDoMotor(quadro());
    // o tamanho que vale é o do próprio quadro (a área da página), não o que a transmissão diz (o da janela)
    assert.ok(q && q.tipo === 'quadro' && q.jpeg.equals(JPEG) && q.tela.largura === 1280 && q.tela.altura === 577);
    assert.deepEqual(tamanhoDoJpeg(jpegDe(390, 844)), { largura: 390, altura: 844 });
    assert.equal(tamanhoDoJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 9, 9, 9, 9, 9, 9, 9, 9])), null);
    assert.equal(lerDoMotor(JSON.stringify({ type: 'status', connected: true, screencasting: true, viewportWidth: 1280, viewportHeight: 720, engine: 'chrome' })), null);
    assert.deepEqual(lerDoMotor(JSON.stringify({ type: 'tabs', tabs: [{ active: false, url: 'https://a.example/', title: 'A' }, { active: true, url: 'https://ana:segredo@loja.example/conta?x=1#topo', title: 'Minha\u0000conta' }] })),
      { tipo: 'pagina', url: 'https://loja.example/conta?x=1', titulo: 'Minha conta' });
    // o que o agente faz e lê também passa pela transmissão do agent-browser: não segue
    for (const m of [{ type: 'command', action: 'fill', params: { selector: '#p', value: 'x' } }, { type: 'result', action: 'evaluate', data: { result: 'texto da página' } }, { type: 'console', text: 'x' }, { type: 'error' }, 'lixo', null, 7]) {
      assert.equal(lerDoMotor(typeof m === 'string' ? m : JSON.stringify(m)), null);
    }
    // quadro que não é JPEG (ou grande demais) não segue
    assert.equal(lerDoMotor(JSON.stringify({ type: 'frame', data: Buffer.from('<svg onload=alert(1)>').toString('base64'), metadata: {} })), null);
    assert.equal(lerDoMotor(JSON.stringify({ type: 'frame', data: '', metadata: {} })), null);
    assert.equal(lerDoMotor(JSON.stringify({ type: 'frame', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString('base64'), metadata: {} })), null);
  });

  test('o endereço mostrado: sem usuário e senha, sem o trecho depois de #, só http(s)', () => {
    assert.equal(enderecoParaTela('https://u:p@banco.example:8443/a/b?c=d#e'), 'https://banco.example:8443/a/b?c=d');
    assert.equal(enderecoParaTela('about:blank'), 'about:blank');
    assert.equal(enderecoParaTela('javascript:alert(1)'), 'javascript:');
    assert.equal(enderecoParaTela('data:text/html,<script>x</script>'), 'data:');
    assert.equal(enderecoParaTela('não é endereço'), '');
    assert.equal(enderecoParaTela(undefined), '');
    assert.ok(enderecoParaTela(`https://x.example/${'a'.repeat(900)}`).length <= 300);
  });

  test('entrada da pessoa: conferida campo a campo, com as coordenadas presas ao viewport', () => {
    const tela = { largura: 1280, altura: 720 };
    assert.deepEqual(entradaDaPessoa({ t: 'm', e: 'dn', x: 100.4, y: 200.6, b: 0, c: 2, k: 8 }, tela),
      [{ type: 'input_mouse', eventType: 'mousePressed', x: 100, y: 201, button: 'left', clickCount: 2, deltaX: 0, deltaY: 0, modifiers: 8 }]);
    assert.deepEqual(entradaDaPessoa({ t: 'm', e: 'mv', x: -50, y: 99999 }, tela)![0], { type: 'input_mouse', eventType: 'mouseMoved', x: 0, y: 719, button: 'none', clickCount: 0, deltaX: 0, deltaY: 0, modifiers: 0 });
    assert.deepEqual(entradaDaPessoa({ t: 'm', e: 'wh', x: 5, y: 5, dx: 0, dy: 1e9 }, tela)![0], { type: 'input_mouse', eventType: 'mouseWheel', x: 5, y: 5, button: 'none', clickCount: 0, deltaX: 0, deltaY: 2000, modifiers: 0 });
    assert.equal(entradaDaPessoa({ t: 'm', e: 'up', x: 1, y: 1, b: 2 }, tela)![0].button, 'right');
    // tecla com nome: sem texto (rawKeyDown), com o código virtual; Enter leva o retorno; atalho (Ctrl+A) não digita "a"
    assert.deepEqual(entradaDaPessoa({ t: 'k', e: 'dn', key: 'Backspace', code: 'Backspace', vk: 8 }, tela), [{ type: 'input_keyboard', eventType: 'rawKeyDown', key: 'Backspace', code: 'Backspace', text: '', windowsVirtualKeyCode: 8, modifiers: 0 }]);
    assert.equal(entradaDaPessoa({ t: 'k', e: 'dn', key: 'Enter', code: 'Enter', vk: 13 }, tela)![0].text, '\r');
    assert.deepEqual(entradaDaPessoa({ t: 'k', e: 'dn', key: 'a', code: 'KeyA', vk: 65, k: 2 }, tela)![0], { type: 'input_keyboard', eventType: 'rawKeyDown', key: 'a', code: 'KeyA', text: '', windowsVirtualKeyCode: 65, modifiers: 2 });
    assert.equal(entradaDaPessoa({ t: 'k', e: 'up', key: 'a', code: 'KeyA', vk: 65 }, tela)![0].eventType, 'keyUp');
    // todos os campos sempre presentes (a transmissão repassa ausente como null e o Chromium recusa)
    for (const ev of entradaDaPessoa({ t: 'txt', s: 'aé@\n' }, tela)!) assert.deepEqual(Object.keys(ev).sort(), ['code', 'eventType', 'key', 'modifiers', 'text', 'type', 'windowsVirtualKeyCode']);
    const txt = entradaDaPessoa({ t: 'txt', s: 'aé\u0007\n' }, tela)!;
    assert.deepEqual(txt.map((x) => `${x.eventType}:${x.key}:${JSON.stringify(x.text)}`), ['keyDown:a:"a"', 'keyUp:a:""', 'keyDown:é:"é"', 'keyUp:é:""', 'keyDown:Enter:"\\r"', 'keyUp:Enter:""']);
    assert.deepEqual(entradaDaPessoa({ t: 'q', e: 's', p: [{ x: 2000, y: 10, id: 1 }] }, tela), [{ type: 'input_touch', eventType: 'touchStart', touchPoints: [{ x: 1279, y: 10, id: 1 }], modifiers: 0 }]);
    // recusadas: tipo desconhecido, comando do agent-browser, tecla com nome estranho, texto longo demais, sem viewport
    for (const ruim of [null, 'x', {}, { t: 'navigate', url: 'http://x' }, { type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 1 }, { t: 'm', e: 'zz', x: 1, y: 1 }, { t: 'm', e: 'dn', x: 'a', y: 1 },
      { t: 'k', e: 'dn', key: '<script>', code: '' }, { t: 'k', e: 'dn', key: 'a', code: 'Key A' }, { t: 'k', e: 'xx', key: 'a' }, { t: 'txt', s: 'x'.repeat(2001) }, { t: 'txt', s: 7 }, { t: 'q', e: 's', p: 'x' }, { t: 'q', e: 's', p: new Array(6).fill({ x: 1, y: 1 }) }]) {
      assert.equal(entradaDaPessoa(ruim, tela), null, JSON.stringify(ruim));
    }
    assert.equal(entradaDaPessoa({ t: 'm', e: 'mv', x: 1, y: 1 }, null), null);
  });

  test('balde de fichas: a rajada passa, o excesso não, e a vazão repõe', () => {
    const b = new Balde(10, 20, 0);
    let ok = 0;
    for (let i = 0; i < 50; i++) if (b.gastar(1, 0)) ok++;
    assert.equal(ok, 20);
    assert.equal(b.gastar(1, 100), true); // 100 ms = 1 ficha
    assert.equal(b.gastar(1, 100), false);
    assert.equal(b.gastar(5, 600), true);
  });
});

describe('navegador: quem está no controle', () => {
  const ana = { userId: 'usr_a', nome: 'Ana', ligacao: 'L1' };
  test('assumir, mexer, devolver; só quem assumiu, pela ligação que assumiu', () => {
    const p = new Posse();
    assert.equal(p.podeMexer('usr_a', 'L1'), false);
    assert.equal(p.assumir(ana, 1000), 'ok');
    assert.equal(p.podeMexer('usr_a', 'L1'), true);
    assert.equal(p.podeMexer('usr_a', 'L2'), false);
    assert.equal(p.podeMexer('usr_b', 'L1'), false);
    assert.equal(p.assumir({ userId: 'usr_b', nome: 'Bia', ligacao: 'L9' }, 2000), 'ocupado');
    assert.equal(p.devolver()?.userId, 'usr_a');
    assert.equal(p.devolver(), null);
    assert.equal(p.podeMexer('usr_a', 'L1'), false);
    assert.equal(p.assumir({ userId: 'usr_b', nome: 'Bia', ligacao: 'L9' }, 3000), 'ok');
  });
  test('prazos: 10 min sem mexer, 30 min no total, 20 s com a ligação caída', () => {
    const p = new Posse();
    p.assumir(ana, 0);
    assert.equal(p.vencido(OCIOSO_MS - 1), null);
    assert.equal(p.vencido(OCIOSO_MS), 'ocioso');
    p.mexeu(OCIOSO_MS - 1);
    assert.equal(p.vencido(OCIOSO_MS + 1000), null);
    assert.equal(p.ate(), 2 * OCIOSO_MS - 1);
    // mexendo sempre, o teto vale
    for (let t = 0; t < TETO_MS; t += 60_000) p.mexeu(t);
    assert.equal(p.vencido(TETO_MS - 1), null);
    assert.equal(p.vencido(TETO_MS), 'teto');
    assert.equal(p.ate(), TETO_MS);
    const q = new Posse();
    q.assumir(ana, 0);
    q.ligacaoCaiu('outra', 10);
    assert.equal(q.vencido(10 + QUEDA_MS), null);
    q.ligacaoCaiu('L1', 100);
    assert.equal(q.vencido(100 + QUEDA_MS - 1), null);
    assert.equal(q.vencido(100 + QUEDA_MS), 'queda');
    // a mesma pessoa voltou por outra ligação: o controle passa para a nova, sem zerar o começo
    assert.equal(q.assumir({ ...ana, ligacao: 'L2' }, 5000), 'ok');
    assert.equal(q.vencido(100 + QUEDA_MS), null);
    assert.equal(q.controle?.desde, 0);
    assert.equal(q.podeMexer('usr_a', 'L1'), false);
  });
});

// ---------------------------------------------------------------------------------------------- rotas
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_nav${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** A ponte de controle do motor (falsa): confere o token, guarda o que recebeu e transmite como o agent-browser. */
class Ponte {
  server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  wss = new WebSocketServer({ noServer: true });
  ligacoes: WebSocket[] = [];
  recebidas: any[] = [];
  controles: Array<{ sessao: string; pessoa: boolean; prazo_s?: number }> = [];
  abertas = 0;
  senhas = 0;
  semNavegador = false;
  porta = 0;
  constructor() {
    this.server.on('upgrade', (rq, socket, head) => {
      const u = new URL(rq.url ?? '', 'http://x');
      if (rq.headers['x-ergon-bridge-token'] !== TOKEN || u.pathname !== '/ergon/v1/navegador/fluxo' || !u.searchParams.get('sessao')) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      this.wss.handleUpgrade(rq, socket, head, (ws) => {
        this.abertas++;
        this.ligacoes.push(ws);
        ws.on('message', (d) => this.recebidas.push(JSON.parse(d.toString())));
        ws.on('close', () => { this.ligacoes = this.ligacoes.filter((x) => x !== ws); });
        ws.send(JSON.stringify({ type: 'status', connected: true, screencasting: false, viewportWidth: 1280, viewportHeight: 720, engine: 'chrome', recording: false }));
        ws.send(JSON.stringify({ type: 'tabs', tabs: [{ active: true, tabId: 't1', title: 'Entrar - Loja', type: 'page', url: 'https://loja.example/entrar' }], timestamp: 1 }));
        ws.send(quadro());
      });
    });
  }
  async abrir() { await new Promise<void>((ok) => this.server.listen(0, '127.0.0.1', ok)); this.porta = (this.server.address() as { port: number }).port; }
  async fechar() { for (const w of this.ligacoes) w.terminate(); this.wss.close(); await new Promise((ok) => this.server.close(ok)); }
  mandar(texto: string) { for (const w of this.ligacoes) w.send(texto); }
  // a parte do cliente de controle que o serviço usa
  async recursos(method: string, sub: string, body?: any) {
    if (sub !== 'navegador/controle' || method !== 'PUT') return { status: 404, json: {} };
    if (this.semNavegador) return { status: 404, json: { error: 'não há navegador' } };
    this.controles.push(body);
    return { status: 200, json: body.pessoa ? { ok: true, controle: 'pessoa', epoca: 0, ate: Date.now() / 1000 + 120 } : { ok: true, controle: 'agente', epoca: 1, senhas: this.senhas } };
  }
  fluxoNavegador(sessao: string) { return { url: `ws://127.0.0.1:${this.porta}/ergon/v1/navegador/fluxo?sessao=${encodeURIComponent(sessao)}`, headers: { 'X-Ergon-Bridge-Token': TOKEN } }; }
  async health() { return true; }
  async accounts() { return []; }
  async modelInfo() { return { model: 'nous/teste-1', provider: 'nous' }; }
  async skills() { return []; }
  async apiToolsets() { return { enabled: [], safe: [] }; }
  async setApiToolsets(e: string[]) { return e; }
}

let h: Harness; let s: Session; let agente: string; let motor: Motor; let ponteMotor: Ponte; let porta: number;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const dorme = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const ate = async (cond: () => boolean, ms = 3000) => { const fim = Date.now() + ms; while (!cond() && Date.now() < fim) await dorme(15); assert.ok(cond(), 'a condição não chegou a tempo'); };
const aviso = (corpo: Record<string, unknown>, token = TOKEN) => req(h, 'POST', '/internal/bridge/v1/navegador', null, corpo, { 'x-ergon-bridge-token': token });

async function conversaComNavegador(quem: Session = s): Promise<{ run: string; conv: string; sessao: string }> {
  const conv = (await req(h, 'POST', '/api/conversations', quem, { agentId: agente })).json;
  await req(h, 'POST', `/api/conversations/${conv.id}/messages`, quem, { text: 'veja o meu pedido na loja', clientRequestId: `m-${crypto.randomUUID()}` });
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conv.id)!;
  assert.equal((await aviso({ evento: 'ativo', session_id: r.hermes_session_id })).status, 200);
  return { run: r.id, conv: conv.id, sessao: r.hermes_session_id };
}
async function cardComNavegador(): Promise<{ run: string; task: string; sessao: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Conferir o pedido na loja', agentId: agente })).json;
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>("SELECT id, hermes_session_id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1", t.id)!;
  assert.ok(r, 'o card não começou a rodar');
  assert.equal((await aviso({ evento: 'ativo', session_id: r.hermes_session_id })).status, 200);
  return { run: r.id, task: t.id, sessao: r.hermes_session_id };
}

interface Tela { ws: WebSocket; msgs: any[]; quadros: Buffer[]; fechou: number | null; ligacao: () => string }
/** Abre o WebSocket como o navegador da pessoa faria; devolve o status HTTP se o servidor recusar. */
function abrir(run: string, opts: { cookie?: string | null; origin?: string | null; bilhete?: string; site?: string }): Promise<Tela | number> {
  return new Promise((ok) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.site) headers['sec-fetch-site'] = opts.site;
    const ws = new WebSocket(`ws://127.0.0.1:${porta}/api/runs/${run}/navegador/fluxo?bilhete=${encodeURIComponent(opts.bilhete ?? '')}`, { headers });
    const t: Tela = { ws, msgs: [], quadros: [], fechou: null, ligacao: () => t.msgs.find((m) => m.t === 'ola')?.ligacao ?? '' };
    ws.on('message', (d, bin) => { if (bin) t.quadros.push(d); else t.msgs.push(JSON.parse(d.toString())); });
    ws.on('open', () => ok(t));
    ws.on('close', (c) => { t.fechou = c; });
    ws.on('unexpected-response', (_q, r) => { r.resume(); ok(r.statusCode ?? 0); });
    ws.on('error', () => undefined);
  });
}
const bilhete = async (run: string, quem: Session = s) => (await req(h, 'POST', `/api/runs/${run}/navegador/bilhete`, quem)).json?.bilhete as string;
async function assistir(run: string, quem: Session = s): Promise<Tela> {
  const t = await abrir(run, { cookie: quem.cookie, origin: ORIGIN, bilhete: await bilhete(run, quem) });
  assert.ok(typeof t !== 'number', `a transmissão não abriu: ${t}`);
  await ate(() => (t as Tela).msgs.some((m) => m.t === 'ola'));
  return t as Tela;
}
const controle = (run: string, corpo: Record<string, unknown>, quem: Session = s) => req(h, 'POST', `/api/runs/${run}/navegador/controle`, quem, corpo);

describe('navegador: rotas', () => {
  beforeEach(async () => {
    motor = new Motor();
    ponteMotor = new Ponte();
    await ponteMotor.abrir();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: ponteMotor as unknown as HermesControlClient });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, 'aspasia')!.id;
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    porta = (h.app.server.address() as { port: number }).port;
  });
  afterEach(async () => { await h.close(); await ponteMotor.fechar(); });

  test('o aviso do motor liga a tela; sem token, ou de sessão desconhecida, nada muda', async () => {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: 'oi', clientRequestId: `m-${crypto.randomUUID()}` });
    await tick();
    const r = h.db.get<{ id: string; hermes_session_id: string }>('SELECT id, hermes_session_id FROM runs WHERE conversation_id = ?', conv.id)!;
    assert.deepEqual((await req(h, 'GET', `/api/navegador?conversa=${conv.id}`, s)).json, { runId: null, ativo: false, controle: 'agente', quem: null, ate: null, motivo: null });
    assert.equal((await req(h, 'POST', `/api/runs/${r.id}/navegador/bilhete`, s)).status, 409);
    assert.equal((await aviso({ evento: 'ativo', session_id: r.hermes_session_id }, 'token-errado-token-errado-token-errado')).status, 401);
    assert.equal((await aviso({ evento: 'ativo', session_id: 'sessao-que-nao-existe' })).status, 200);
    assert.equal((await aviso({ evento: 'explodir', session_id: r.hermes_session_id })).status, 400);
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv.id}`, s)).json.ativo, false);
    const eventos: any[] = [];
    h.bus.subscribe(s.workspaceId, (e) => eventos.push(e));
    assert.equal((await aviso({ evento: 'ativo', session_id: r.hermes_session_id })).status, 200);
    const est = (await req(h, 'GET', `/api/navegador?conversa=${conv.id}`, s)).json;
    assert.deepEqual(est, { runId: r.id, ativo: true, controle: 'agente', quem: null, ate: null, motivo: null });
    assert.ok(eventos.some((e) => e.type === 'runs.live' && e.data.id === r.id && e.data.navegador === true));
    // sem sessão, sem conversa nem card, ou com os dois: recusado
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv.id}`, null)).status, 401);
    assert.equal((await req(h, 'GET', '/api/navegador', s)).status, 400);
    // o motor avisa que fechou: a tela some
    assert.equal((await aviso({ evento: 'fim', session_id: r.hermes_session_id })).status, 200);
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv.id}`, s)).json.ativo, false);
  });

  test('abrir a transmissão: origem, sessão e bilhete de uso único; nada do motor vai para a tela', async () => {
    const { run } = await conversaComNavegador();
    // o bilhete pede sessão e CSRF
    assert.equal((await req(h, 'POST', `/api/runs/${run}/navegador/bilhete`, null)).status, 401);
    assert.equal((await req(h, 'POST', `/api/runs/${run}/navegador/bilhete`, { ...s, csrf: 'errado' })).status, 403);
    assert.equal((await h.app.inject({ method: 'POST', url: `/api/runs/${run}/navegador/bilhete`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://outra.example' }, payload: {} })).statusCode, 403);
    // sem origem, de outra origem, entre sites: recusado (é o que impede outra página de abrir o WebSocket com o cookie)
    assert.equal(await abrir(run, { cookie: s.cookie, origin: null, bilhete: await bilhete(run) }), 403);
    assert.equal(await abrir(run, { cookie: s.cookie, origin: 'https://outra.example', bilhete: await bilhete(run) }), 403);
    assert.equal(await abrir(run, { cookie: s.cookie, origin: ORIGIN, site: 'cross-site', bilhete: await bilhete(run) }), 403);
    // sem cookie, sem bilhete, bilhete inventado, bilhete de outra execução
    assert.equal(await abrir(run, { cookie: null, origin: ORIGIN, bilhete: await bilhete(run) }), 401);
    assert.equal(await abrir(run, { cookie: s.cookie, origin: ORIGIN }), 403);
    assert.equal(await abrir(run, { cookie: s.cookie, origin: ORIGIN, bilhete: crypto.randomBytes(32).toString('base64url') }), 403);
    const outra = await conversaComNavegador();
    assert.equal(await abrir(run, { cookie: s.cookie, origin: ORIGIN, bilhete: await bilhete(outra.run) }), 403);
    assert.equal(ponteMotor.abertas, 0, 'nenhuma recusa chegou a ligar no motor');
    // certo: abre uma vez; o mesmo bilhete de novo, não
    const b = await bilhete(run);
    const t = await abrir(run, { cookie: s.cookie, origin: ORIGIN, bilhete: b }) as Tela;
    assert.ok(typeof t !== 'number');
    assert.equal(await abrir(run, { cookie: s.cookie, origin: ORIGIN, bilhete: b }), 403);
    await ate(() => t.quadros.length >= 1 && t.msgs.some((m) => m.t === 'pagina'));
    assert.ok(t.quadros[0].equals(JPEG), 'o quadro chega como JPEG puro (binário)');
    assert.deepEqual(t.msgs.find((m) => m.t === 'tela'), { t: 'tela', largura: 1280, altura: 577 });
    assert.deepEqual(t.msgs.find((m) => m.t === 'pagina'), { t: 'pagina', url: 'https://loja.example/entrar', titulo: 'Entrar - Loja' });
    const ola = t.msgs.find((m) => m.t === 'ola');
    assert.ok(ola.ligacao.length >= 12 && ola.ativo === true && ola.controle === 'agente');
    // o que o agente faz e lê passa pela transmissão do agent-browser: não chega à tela
    ponteMotor.mandar(JSON.stringify({ type: 'command', action: 'fill', params: { selector: '#p', value: 'valor-que-o-agente-digitou' } }));
    ponteMotor.mandar(JSON.stringify({ type: 'result', action: 'evaluate', data: { result: 'texto-lido-da-pagina' }, success: true }));
    ponteMotor.mandar(quadro());
    await ate(() => t.quadros.length >= 2);
    const tudo = JSON.stringify(t.msgs);
    assert.ok(!tudo.includes('valor-que-o-agente') && !tudo.includes('texto-lido') && !tudo.includes(TOKEN) && !tudo.includes(String(ponteMotor.porta)) && !tudo.includes('sessao-run_'), tudo);
    assert.deepEqual([...new Set(t.msgs.map((m) => m.t))].sort(), ['ola', 'pagina', 'tela']);
    t.ws.close();
  });

  test('limite de quadros: uma rajada vira poucos quadros, e o último sempre chega', async () => {
    const { run } = await conversaComNavegador();
    const t = await assistir(run);
    await ate(() => t.quadros.length >= 1);
    const ultimo = jpegDe(1280, 577, 333);
    for (let i = 0; i < 60; i++) ponteMotor.mandar(quadro());
    ponteMotor.mandar(quadro(ultimo));
    await dorme(500);
    assert.ok(t.quadros.length <= 1 + 8, `chegaram ${t.quadros.length} quadros em meio segundo`);
    assert.ok(t.quadros.at(-1)!.equals(ultimo), 'o último quadro da rajada é o que fica na tela');
    t.ws.close();
  });

  test('assumir, mexer e devolver: só quem assumiu manda entrada; auditoria sem o que foi digitado', async () => {
    const { run, conv, sessao } = await conversaComNavegador();
    const t = await assistir(run);
    await ate(() => ponteMotor.ligacoes.length === 1 && t.msgs.some((m) => m.t === 'tela'));
    // com o agente no controle, a entrada não segue
    t.ws.send(JSON.stringify({ t: 'm', e: 'dn', x: 10, y: 10, b: 0, c: 1 }));
    t.ws.send(JSON.stringify({ t: 'txt', s: 'antes' }));
    await dorme(150);
    assert.equal(ponteMotor.recebidas.length, 0);
    // assumir pede a ligação de quem está vendo
    assert.equal((await controle(run, { pessoa: true })).status, 409);
    assert.equal((await controle(run, { pessoa: true, ligacao: 'ligacao-inventada' })).json.error, 'navegador_sem_tela');
    assert.equal((await req(h, 'POST', `/api/runs/${run}/navegador/controle`, { ...s, csrf: 'errado' }, { pessoa: true, ligacao: t.ligacao() })).status, 403);
    assert.equal(ponteMotor.controles.length, 0);
    const r = await controle(run, { pessoa: true, ligacao: t.ligacao() });
    assert.equal(r.status, 200);
    assert.equal(r.json.controle, 'voce');
    assert.ok(Date.parse(r.json.ate) > Date.now() + 9 * 60_000);
    assert.deepEqual(ponteMotor.controles, [{ sessao, pessoa: true, prazo_s: 120 }]);
    await ate(() => t.msgs.some((m) => m.t === 'estado' && m.controle === 'voce'));
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.controle, 'voce');
    // agora segue: clique fora do viewport é preso nele; a senha vai tecla a tecla
    t.ws.send(JSON.stringify({ t: 'm', e: 'dn', x: 5000, y: -3, b: 0, c: 1 }));
    t.ws.send(JSON.stringify({ t: 'txt', s: SENHA }));
    t.ws.send(JSON.stringify({ t: 'k', e: 'dn', key: 'Enter', code: 'Enter', vk: 13 }));
    t.ws.send(JSON.stringify({ type: 'command', action: 'eval', script: 'x' }));
    t.ws.send('lixo');
    t.ws.send(Buffer.from([1, 2, 3]));
    await ate(() => ponteMotor.recebidas.length === 1 + SENHA.length * 2 + 1);
    assert.deepEqual(ponteMotor.recebidas[0], { type: 'input_mouse', eventType: 'mousePressed', x: 1279, y: 0, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 });
    assert.equal(ponteMotor.recebidas.filter((m) => m.eventType === 'keyDown' && m.text.length === 1 && m.text !== '\r').map((m) => m.text).join(''), SENHA);
    assert.ok(ponteMotor.recebidas.every((m) => ['input_mouse', 'input_keyboard'].includes(m.type)));
    // outra ligação da mesma pessoa (outra aba) vê, mas não mexe
    const t2 = await assistir(run);
    await ate(() => t2.quadros.length >= 1);
    const antes = ponteMotor.recebidas.length;
    t2.ws.send(JSON.stringify({ t: 'txt', s: 'da outra aba' }));
    await dorme(150);
    assert.equal(ponteMotor.recebidas.length, antes);
    t2.ws.close();
    // devolver: o motor é avisado (ele apaga a senha que ficou digitada) e a entrada para de seguir
    ponteMotor.senhas = 1;
    const d = await controle(run, { pessoa: false });
    assert.equal(d.status, 200);
    assert.deepEqual({ controle: d.json.controle, senhas: d.json.senhas, motivo: d.json.motivo }, { controle: 'agente', senhas: 1, motivo: null });
    assert.deepEqual(ponteMotor.controles.at(-1), { sessao, pessoa: false });
    t.ws.send(JSON.stringify({ t: 'txt', s: 'depois' }));
    await dorme(150);
    assert.equal(ponteMotor.recebidas.length, antes);
    // auditoria: assumiu e devolveu, sem nada do que foi digitado; e nada disso em lugar nenhum do banco
    const aud = h.db.all<{ action: string; actor_id: string; target_id: string; evidence: string | null; result: string }>("SELECT action, actor_id, target_id, evidence, result FROM audit_events WHERE action LIKE 'navegador.%' ORDER BY created_at, rowid");
    assert.deepEqual(aud.map((a) => [a.action, a.actor_id, a.target_id]), [['navegador.assumiu', s.userId, run], ['navegador.devolveu', s.userId, run]]);
    const atividade = (await req(h, 'GET', '/api/activity', s)).json as Array<{ action: string; result: string; result_t?: { codigo: string } }>;
    assert.equal(atividade.find((a) => a.action === 'navegador.assumiu')?.result_t?.codigo, 'historico.navegador.assumiu');
    assert.equal(atividade.find((a) => a.action === 'navegador.devolveu')?.result_t?.codigo, 'historico.navegador.devolveu');
    for (const tabela of h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const linhas = JSON.stringify(h.db.all(`SELECT * FROM "${tabela.name}"`));
      assert.ok(!linhas.includes(SENHA), `a senha digitada ficou na tabela ${tabela.name}`);
    }
    t.ws.close();
  });

  test('o motor não confirma: ninguém assume; sem navegador no motor: a tela some', async () => {
    const { run, conv } = await conversaComNavegador();
    const t = await assistir(run);
    ponteMotor.semNavegador = true;
    const r = await controle(run, { pessoa: true, ligacao: t.ligacao() });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'navegador_fechado');
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.ativo, false);
    await ate(() => t.fechou !== null);
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE 'navegador.%'")!.n, 0);
  });

  test('a tomada de controle acaba sozinha: sem mexer, com a ligação caída, quando o motor avisa o prazo', async () => {
    const { run, conv, sessao } = await conversaComNavegador();
    let agora = Date.now();
    h.navegador.usarRelogio(() => agora);
    const volta = () => (h.navegador as unknown as { volta(): void }).volta();
    const motivos = () => h.db.all<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'navegador.devolveu' ORDER BY created_at, rowid").map((a) => JSON.parse(a.evidence).motivo);
    // 1. dez minutos sem mexer
    let t = await assistir(run);
    assert.equal((await controle(run, { pessoa: true, ligacao: t.ligacao() })).status, 200);
    agora += OCIOSO_MS - 5000;
    volta();
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.controle, 'voce');
    assert.ok(ponteMotor.controles.filter((c) => c.pessoa).length >= 2, 'o prazo no motor é renovado enquanto a pessoa está no controle');
    agora += 6000;
    volta();
    const est = (await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json;
    assert.deepEqual({ controle: est.controle, motivo: est.motivo }, { controle: 'agente', motivo: 'ocioso' });
    await ate(() => ponteMotor.controles.at(-1)?.pessoa === false);
    await ate(() => t.msgs.some((m) => m.t === 'estado' && m.controle === 'agente' && m.motivo === 'ocioso'));
    // 2. a ligação de quem controla caiu e não voltou em 20 s
    assert.equal((await controle(run, { pessoa: true, ligacao: t.ligacao() })).status, 200);
    t.ws.close();
    await ate(() => t.fechou !== null);
    await dorme(50);
    agora += QUEDA_MS - 1000;
    volta();
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.controle, 'voce');
    agora += 2000;
    volta();
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.motivo, 'queda');
    // 3. o motor devolveu sozinho (o prazo dele) e avisou
    t = await assistir(run);
    assert.equal((await controle(run, { pessoa: true, ligacao: t.ligacao() })).status, 200);
    const n = ponteMotor.controles.length;
    assert.equal((await aviso({ evento: 'devolvido', session_id: sessao, motivo: 'prazo' })).status, 200);
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.motivo, 'prazo');
    assert.equal(ponteMotor.controles.length, n, 'quando foi o motor que devolveu, não é avisado de volta');
    assert.deepEqual(motivos(), ['ocioso', 'queda', 'prazo']);
    // 4. a sessão da pessoa acabou: a transmissão fecha e o controle volta
    assert.equal((await controle(run, { pessoa: true, ligacao: t.ligacao() })).status, 200);
    h.db.run('DELETE FROM sessions WHERE user_id = ?', s.userId);
    volta();
    await ate(() => t.fechou === 4401);
    assert.deepEqual(motivos().at(-1), 'sessao');
  });

  test('a execução termina: a transmissão fecha, o controle volta e a tela some', async () => {
    const { run, conv } = await conversaComNavegador();
    const t = await assistir(run);
    assert.equal((await controle(run, { pessoa: true, ligacao: t.ligacao() })).status, 200);
    await ate(() => ponteMotor.ligacoes.length === 1);
    const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', run)!.hermes_run_id;
    motor.runs.set(remoto, { status: 'completed', output: 'O pedido foi entregue.', error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
    await tick();
    await ate(() => t.fechou !== null && ponteMotor.ligacoes.length === 0);
    assert.ok(t.msgs.some((m) => m.t === 'fim'));
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, s)).json.ativo, false);
    assert.equal((await req(h, 'POST', `/api/runs/${run}/navegador/bilhete`, s)).status, 409);
    assert.equal(JSON.parse(h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'navegador.devolveu'")!.evidence).motivo, 'fim');
  });

  test('outra pessoa: não vê a conversa alheia; no card do workspace vê, mas sem a tela enquanto alguém controla', async () => {
    const bia = await addPerson(h, 'beatriz', 'senha-da-bia-456', 'Beatriz');
    const { run: daConversa, conv } = await conversaComNavegador();
    // a Bia, no workspace dela: a execução nem existe
    assert.equal((await req(h, 'POST', `/api/runs/${daConversa}/navegador/bilhete`, bia)).status, 404);
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, bia)).status, 404);
    assert.equal((await controle(daConversa, { pessoa: true, ligacao: 'x'.repeat(16) }, bia)).status, 404);
    // a Bia entra no workspace do Alexandre: a conversa dele continua só dele
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", s.workspaceId, bia.userId, new Date().toISOString());
    h.db.run('UPDATE sessions SET workspace_id = ? WHERE user_id = ?', s.workspaceId, bia.userId);
    assert.equal((await req(h, 'POST', `/api/runs/${daConversa}/navegador/bilhete`, bia)).status, 404);
    assert.equal((await req(h, 'GET', `/api/navegador?conversa=${conv}`, bia)).status, 404);
    // bilhete do Alexandre com o cookie da Bia: recusado
    assert.equal(await abrir(daConversa, { cookie: bia.cookie, origin: ORIGIN, bilhete: await bilhete(daConversa) }), 403);
    // o card é do workspace: os dois veem
    const { run, task } = await cardComNavegador();
    const ta = await assistir(run);
    const tb = await assistir(run, bia);
    await ate(() => ta.quadros.length >= 1 && tb.quadros.length >= 1);
    assert.equal((await req(h, 'GET', `/api/navegador?tarefa=${task}`, bia)).json.runId, run);
    // o Alexandre assume: a Bia sabe quem está no controle, não recebe mais quadros nem o endereço, e não assume por cima
    assert.equal((await controle(run, { pessoa: true, ligacao: ta.ligacao() })).status, 200);
    await ate(() => tb.msgs.some((m) => m.t === 'estado' && m.controle === 'outra' && m.quem === 'Alexandre'));
    const [qa, qb, pb] = [ta.quadros.length, tb.quadros.length, tb.msgs.filter((m) => m.t === 'pagina').length];
    ponteMotor.mandar(JSON.stringify({ type: 'tabs', tabs: [{ active: true, url: 'https://loja.example/conta/codigo', title: 'Código de verificação' }] }));
    ponteMotor.mandar(quadro());
    await ate(() => ta.quadros.length > qa);
    await dorme(400);
    assert.equal(tb.quadros.length, qb, 'quem não está no controle não recebe a tela enquanto outra pessoa controla');
    assert.equal(tb.msgs.filter((m) => m.t === 'pagina').length, pb);
    const rb = await controle(run, { pessoa: true, ligacao: tb.ligacao() }, bia);
    assert.equal(rb.status, 409);
    assert.equal(rb.json.error, 'navegador_ocupado');
    assert.equal((await controle(run, { pessoa: false }, bia)).status, 409);
    tb.ws.send(JSON.stringify({ t: 'txt', s: 'da bia' }));
    await dorme(150);
    assert.equal(ponteMotor.recebidas.length, 0);
    assert.equal(ponteMotor.abertas, 1, 'uma ligação só com o motor por execução, por mais gente que assista');
    // devolvido: a Bia volta a ver
    assert.equal((await controle(run, { pessoa: false })).status, 200);
    ponteMotor.mandar(quadro());
    await ate(() => tb.quadros.length > qb);
    ta.ws.close(); tb.ws.close();
  });
});
