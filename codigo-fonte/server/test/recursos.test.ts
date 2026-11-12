/**
 * Capacidades da equipe (rc.27): o Ergon fala com a ponte das capacidades do motor (simulada aqui com as respostas que
 * o plugin dá; o plugin de verdade é conferido em hermes/tests/test_ergon_bridge_recursos.py, dentro da imagem).
 * Confere as ferramentas novas (desligadas, com aviso), a trava dos conectores na política de cada sessão, a Revisão em
 * conselho indo ao conselho de modelos, a loja (só instala depois de ver a varredura), a voz e o motor de antes.
 */
import assert from 'node:assert/strict';
import { conselhoAutomaticoDe } from '../src/services/recursos.ts';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { saveArtifact } from '../src/services/artifacts.ts';
import { TOOLS, toolsetsFor } from '../src/services/characters.ts';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-recursos-0123456789';

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  pedidos: StartRun[] = [];
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    this.pedidos.push(p);
    const runId = `run_recursos${String(this.pedidos.length).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return ['ergon_conexoes', 'todo', 'web'].map((name) => ({ name, label: name, enabled: true, configured: true, tools: [] })); }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** A ponte das capacidades do plugin, com o que ele responde (e o que recebeu). */
function ponteFalsa(antiga = false) {
  const chamadas: Array<{ method: string; sub: string; body?: any; query?: any }> = [];
  const estado = { checkpoints: true, codigo_inseguro: true, limpeza: false, busca_ferramentas: false, conectores: [] as string[],
    voz: { transcrever: null as string | null, falar: 'edge' }, navegador: { chromium: true, pronto: true } };
  const recursos = async (method: string, sub: string, body?: any, query?: any): Promise<{ status: number; json: any }> => {
    chamadas.push({ method, sub, body, query });
    if (antiga) return { status: 404, json: { error: 'rota não liberada pela ponte do Ergon' } };
    if (sub === 'recursos' && method === 'GET') return { status: 200, json: estado };
    if (sub === 'recursos' && method === 'PUT') { Object.assign(estado, body); return { status: 200, json: { ok: true, reiniciar: false, ...estado } }; }
    if (sub === 'conselho') return { status: 200, json: { preset: 'default', ligado: true, opinam: body?.opinam ?? [], agrega: body?.agrega ?? { provider: '', model: '' } } };
    if (sub === 'loja/instalar') return body.id === 'comunidade/perigosa'
      ? { status: 409, json: { error: 'a varredura de segurança barrou esta competência', varredura: { veredito: 'dangerous' } } }
      : { status: 200, json: { ok: true, varredura: { veredito: 'safe' } } };
    if (sub === 'conectores' && method === 'GET') return { status: 200, json: { catalogo: [], servidores: estado.conectores.map((nome) => ({ nome, ligado: true })), busca_ferramentas: !!estado.conectores.length } };
    if (sub === 'conectores/instalar') { estado.conectores.push(body.nome); return { status: 200, json: { ok: true, segundo_plano: false, busca_ferramentas: true } }; }
    if (sub === 'voz/falar') return { status: 200, json: { ok: true, audio: Buffer.from('ID3-audio-falso').toString('base64'), tipo: 'audio/mpeg' } };
    if (sub === 'voz/transcrever') return { status: 200, json: estado.voz.transcrever ? { ok: true, texto: 'reunião às três' } : { ok: false, motivo: 'componente' } };
    return { status: 404, json: { error: 'rota não liberada pela ponte do Ergon' } };
  };
  const control = { health: async () => true, recursos, apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e } as unknown as HermesControlClient;
  return { control, chamadas, estado };
}

let h: Harness; let s: Session; let motor: Motor; let ponte: ReturnType<typeof ponteFalsa>;
async function subir(antiga = false) {
  motor = new Motor();
  ponte = ponteFalsa(antiga);
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: ponte.control });
  s = await setupOwner(h);
}
beforeEach(async () => { await subir(); });
afterEach(() => h.close());

const agente = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
async function conversa(agentId: string): Promise<string> { return (await req(h, 'POST', '/api/conversations', s, { agentId })).json.id; }

describe('capacidades da equipe', () => {
  test('ferramentas novas: tudo o que a equipe sabe aparece, desligado e com aviso de custo ou risco', async () => {
    for (const id of ['leitura', 'navegador', 'video', 'videogen', 'xbusca', 'voz', 'conectores']) {
      assert.ok(TOOLS[id], id);
      assert.equal(TOOLS[id].status, 'desligada', id);
      assert.ok(TOOLS[id].aviso === 'custo' || TOOLS[id].aviso === 'risco', id);
    }
    assert.match(TOOLS.navegador.note, /manipular o agente/);
    // a proteção depois de ler as contas é opcional e vem desligada (decisão de 08/11): o texto não promete uma trava que não
    // está ligada, e diz onde ligar
    assert.doesNotMatch(TOOLS.navegador.note, /Depois de ler as contas da pessoa, abrir sites pede/);
    assert.match(TOOLS.navegador.note, /ligue a proteção em Conexões/);
    assert.deepEqual(toolsetsFor(['leitura', 'navegador', 'video', 'videogen', 'xbusca', 'voz']).sort(), ['browser', 'file', 'tts', 'video', 'video_gen', 'x_search']);
    assert.deepEqual(toolsetsFor(['conectores']), [], 'os conectores não são um conjunto fixo: o plugin confere pelo prefixo');
    const tools = (await req(h, 'GET', '/api/ai/tools', s)).json as Array<{ id: string; status: string; platform: boolean }>;
    const nav = tools.find((t) => t.id === 'navegador')!;
    assert.equal(nav.platform, false, 'o navegador não liga sozinho');
  });

  test('o estado vem do motor; com um conector ligado, a ferramenta Conectores prontos fica disponível', async () => {
    let tools = (await req(h, 'GET', '/api/ai/tools', s)).json as Array<{ id: string; status: string }>;
    assert.equal(tools.find((t) => t.id === 'conectores')!.status, 'desligada');
    const r = await req(h, 'POST', '/api/recursos/conectores/instalar', s, { nome: 'context7' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const inst = ponte.chamadas.find((c) => c.sub === 'conectores/instalar')!;
    assert.match(inst.body.retorno, /\/api\/recursos\/conectores\/context7\/retorno$/, 'a volta da entrada passa pelo Ergon');
    const e = (await req(h, 'GET', '/api/recursos', s)).json;
    assert.deepEqual(e.conectores, ['context7']);
    assert.equal(e.navegador.chromium, true);
    tools = (await req(h, 'GET', '/api/ai/tools', s)).json;
    assert.equal(tools.find((t) => t.id === 'conectores')!.status, 'disponível');
  });

  test('proteções do Terminal: o dono liga e desliga; fica registrado', async () => {
    const r = await req(h, 'PUT', '/api/recursos', s, { limpeza: true, codigoInseguro: false });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ponte.chamadas.find((c) => c.method === 'PUT')!.body, { codigo_inseguro: false, limpeza: true });
    assert.equal(r.json.limpeza, true);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'recursos.protecoes'"));
    assert.equal((await req(h, 'PUT', '/api/recursos', s, { terminal: true })).status, 400);
  });

  test('conectores: a escrita é liberada por conector e vai na política de cada sessão', async () => {
    const id = agente('hipatia');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'conectores']), id);
    const conv = await conversa(id);
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'procure no Notion', clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const sessao = h.db.get<{ s: string }>('SELECT hermes_session_id AS s FROM runs WHERE conversation_id = ?', conv)!.s;
    const pol = async () => (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: sessao }, { 'x-ergon-bridge-token': TOKEN })).json;
    assert.deepEqual((await pol()).conectores, { ligado: true, escrita: [] }, 'só consulta até a pessoa liberar');
    assert.equal((await req(h, 'PUT', '/api/recursos/conectores/notion/escrita', s, { liberada: true })).status, 200);
    assert.deepEqual((await pol()).conectores, { ligado: true, escrita: ['notion'] });
    assert.equal((await req(h, 'PUT', '/api/recursos/conectores/Notion%20X/escrita', s, { liberada: true })).status, 400, 'nome fora do padrão');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro']), id);
    assert.equal((await pol()).conectores.ligado, false, 'sem a ferramenta, o agente não usa conector nenhum');
  });

  test('Revisão em conselho: a mensagem vai ao conselho de modelos, não ao modelo do agente', async () => {
    const conv = await conversa(agente('herodoto'));
    assert.equal((await req(h, 'PUT', '/api/recursos/conselho', s, { opinam: [{ provider: 'nous', model: 'a/um' }], agrega: { provider: 'nous', model: 'a/dois' } })).status, 400, 'um modelo só não é conselho');
    const c = await req(h, 'PUT', '/api/recursos/conselho', s, { opinam: [{ provider: 'nous', model: 'a/um' }, { provider: 'nous', model: 'b/dois' }], agrega: { provider: 'nous', model: 'c/tres' } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const r = await req(h, 'POST', `/api/conversations/${conv}/conselho`, s, { clientRequestId: `c-${crypto.randomUUID()}` });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const run = h.db.get<{ via: string }>('SELECT via FROM runs WHERE conversation_id = ?', conv)!;
    assert.equal(run.via, 'conselho');
    const p = motor.pedidos.at(-1)!;
    assert.equal(p.provider, 'moa');
    assert.equal(p.model, 'default');
    assert.match(p.input, /Revisão em conselho/);
    // uma mensagem comum continua no modelo do agente
    await h.db.run("UPDATE runs SET status = 'succeeded' WHERE conversation_id = ?", conv);
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'obrigado', clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.notEqual(motor.pedidos.at(-1)!.provider, 'moa');
  });

  test('conselho montado sozinho (regra do dono): com 2 ou mais modelos nas contas, o principal e um de cada outra conta, até 3; o principal junta', () => {
    const contas = [{ id: 'nous', models: [{ id: 'a/principal' }, { id: 'a/outro' }] }, { id: 'openrouter', models: [{ id: 'b/um' }, { id: 'a/principal' }] }, { id: 'codex', models: [{ id: 'c/um' }] }, { id: 'xai', models: [{ id: 'd/um' }] }];
    const o = { principal: { provider: 'nous', model: 'a/principal' }, contas };
    assert.deepEqual(conselhoAutomaticoDe(null, o), { opinam: [{ provider: 'nous', model: 'a/principal' }, { provider: 'openrouter', model: 'a/principal' }, { provider: 'codex', model: 'c/um' }], agrega: { provider: 'nous', model: 'a/principal' } });
    assert.deepEqual(conselhoAutomaticoDe(null, { principal: o.principal, contas: [contas[0]] })?.opinam, [{ provider: 'nous', model: 'a/principal' }, { provider: 'nous', model: 'a/outro' }], 'uma conta com dois modelos também dá');
    assert.equal(conselhoAutomaticoDe(null, { principal: o.principal, contas: [{ id: 'nous', models: [{ id: 'a/principal' }] }] }), null, 'um modelo só não é conselho');
    const montado = { opinam: [{ provider: 'openrouter', model: 'b/um' }, { provider: 'codex', model: 'c/um' }], agrega: { provider: 'xai', model: 'd/um' } };
    assert.equal(conselhoAutomaticoDe(montado, o), null, 'o conselho que a pessoa montou fica');
    assert.ok(conselhoAutomaticoDe({ ...montado, opinam: [{ provider: 'anthropic', model: 'fabrica/x' }, montado.opinam[0]] }, o), 'conselho de fábrica com conta que a pessoa não tem: monta outro');
  });

  test('loja: instala só depois de a pessoa ver a varredura; o que a varredura barra não instala', async () => {
    assert.equal((await req(h, 'POST', '/api/recursos/loja/instalar', s, { id: 'official/finance/excel-author' })).status, 400, 'sem ter visto a varredura');
    const ok = await req(h, 'POST', '/api/recursos/loja/instalar', s, { id: 'official/finance/excel-author', vi: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const barrada = await req(h, 'POST', '/api/recursos/loja/instalar', s, { id: 'comunidade/perigosa', vi: true });
    assert.equal(barrada.status, 409);
    assert.match(JSON.stringify(barrada.json), /varredura/);
    assert.equal((await req(h, 'GET', '/api/recursos/loja/varredura?id=..%2F..%2Fetc', s)).status, 400);
  });

  test('voz: ouvir a resposta e transcrever um áudio (sem o transcritor, a tela diz o que falta)', async () => {
    const conv = await conversa(agente('aspasia'));
    const msg = 'msg_' + crypto.randomBytes(16).toString('hex');
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', ?, 'real', ?)", msg, s.workspaceId, conv, 'Bom dia [[nota x]]', new Date().toISOString());
    const r = await req(h, 'POST', '/api/recursos/voz/falar', s, { mensagem: msg });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(String(r.res.headers['content-type']), /audio\/mpeg/);
    assert.equal(ponte.chamadas.find((c) => c.sub === 'voz/falar')!.body.texto, 'Bom dia', 'sem as marcações da equipe');
    const audio = saveArtifact(h.db, h.bus, h.cfg.filesDir, 10_000_000, s.workspaceId, s.userId, { filename: 'nota.ogg', mime: 'audio/ogg', data: Buffer.from('OggS-falso') });
    const t1 = await req(h, 'POST', '/api/recursos/voz/transcrever', s, { arquivo: audio.id });
    assert.equal(t1.status, 409);
    assert.match(JSON.stringify(t1.json), /componente adicional/);
    ponte.estado.voz.transcrever = 'local';
    const t2 = await req(h, 'POST', '/api/recursos/voz/transcrever', s, { arquivo: audio.id });
    assert.equal(t2.status, 200, JSON.stringify(t2.json));
    assert.equal(t2.json.texto, 'reunião às três');
    const txt = saveArtifact(h.db, h.bus, h.cfg.filesDir, 10_000_000, s.workspaceId, s.userId, { filename: 'a.txt', mime: 'text/plain', data: Buffer.from('oi') });
    assert.equal((await req(h, 'POST', '/api/recursos/voz/transcrever', s, { arquivo: txt.id })).status, 400);
  });
});

describe('motor de antes (sem a capacidade das capacidades)', () => {
  test('a tela diz que chega com a próxima atualização, sem erro de servidor', async () => {
    await h.close();
    await subir(true);
    const r = await req(h, 'GET', '/api/recursos', s);
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.json), /próxima atualização/);
  });
});
