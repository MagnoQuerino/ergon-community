/**
 * Mensagem de áudio (rc.33): o áudio que a pessoa grava (ou anexa) na conversa é transcrito pelo motor em segundo plano,
 * a transcrição fica gravada ligada ao arquivo e vai ao agente junto do pedido ("Áudio da pessoa (transcrição): …"). O
 * pedido espera a transcrição; se ela falha, o agente fica sabendo que há um áudio que o sistema não transcreveu e a tela
 * mostra "tentar de novo". O teto de 10 minutos vale também no servidor (pela duração lida do arquivo, e pelo tamanho).
 * A ponte do motor é simulada com as respostas que o plugin dá (hermes/tests/test_ergon_bridge_voz.py confere o plugin).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { duracaoDoAudio } from '../src/lib/duracao-audio.ts';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { Recursos } from '../src/services/recursos.ts';
import { TRANSCREVENDO_AUDIO } from '../src/services/runs.ts';
import { AUDIO_MAX_BYTES, foraDoTeto } from '../src/services/transcricoes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'audio');
const ler = (n: string) => fs.readFileSync(path.join(FIX, n));

/** Um WebM como o MediaRecorder grava (segmento e cluster de tamanho desconhecido, sem duração no cabeçalho). */
function webmGravado(segundos: number): Buffer {
  const tam8 = (n: number) => { const b = Buffer.alloc(8); b[0] = 0x01; b.writeUIntBE(n, 2, 6); return b; };
  const el = (id: number[], dados: Buffer) => Buffer.concat([Buffer.from(id), tam8(dados.length), dados]);
  const desconhecido = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const ms = Math.round(segundos * 1000);
  const tempo = Buffer.alloc(4); tempo.writeUInt32BE(ms - 20);
  const bloco = Buffer.concat([Buffer.from([0x81]), Buffer.from([0x00, 0x14]), Buffer.from([0x80]), Buffer.alloc(16, 1)]); // trilha 1, +20 ms
  return Buffer.concat([
    el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm'))),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), desconhecido,
    el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))),
    Buffer.from([0x1f, 0x43, 0xb6, 0x75]), desconhecido,
    el([0xe7], tempo), el([0xa3], bloco),
  ]);
}

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  pedidos: StartRun[] = [];
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    this.pedidos.push(p);
    const runId = `run_audio0000${String(this.pedidos.length).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return ['ergon_conexoes', 'todo', 'web'].map((name) => ({ name, label: name, enabled: true, configured: true, tools: [] })); }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** A ponte da voz: a transcrição responde quando o teste solta (ou na hora). */
function ponteDaVoz() {
  const chamadas: Array<{ method: string; sub: string; body?: any; query?: any }> = [];
  const st = {
    resposta: { ok: true, texto: 'reunião às três com a Ana' } as Record<string, unknown>,
    segurar: false, soltar: null as null | (() => void), preparar: false,
    falar: { ok: true, audio: Buffer.from('ID3-falso').toString('base64'), tipo: 'audio/mpeg', reserva: false } as Record<string, unknown>,
  };
  const recursos = async (method: string, sub: string, body?: any, query?: any): Promise<{ status: number; json: any }> => {
    chamadas.push({ method, sub, body, query });
    if (sub === 'recursos' && method === 'GET') {
      return { status: 200, json: { checkpoints: false, conectores: [], voz: { transcrever: 'local', falar: 'piper', preparar: { transcrever: st.preparar, falar: false }, modelo: 'base' }, navegador: { chromium: false, pronto: false } } };
    }
    if (sub === 'voz/transcrever') {
      if (st.segurar) await new Promise<void>((ok) => { st.soltar = ok; });
      return { status: 200, json: st.resposta };
    }
    if (sub === 'voz/falar') return { status: 200, json: st.falar };
    return { status: 404, json: { error: 'rota não liberada pela ponte do Ergon' } };
  };
  const control = { health: async () => true, recursos, apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e } as unknown as HermesControlClient;
  return { control, chamadas, st };
}

let h: Harness; let s: Session; let motor: Motor; let ponte: ReturnType<typeof ponteDaVoz>;
beforeEach(async () => {
  motor = new Motor();
  ponte = ponteDaVoz();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: 'token-da-ponte-de-teste-voz-0123456789ab', maxUploadBytes: 40 * 1024 * 1024 }, { hermes: motor, control: ponte.control });
  s = await setupOwner(h);
});
afterEach(() => h.close());

const agente = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
async function conversa(): Promise<string> { return (await req(h, 'POST', '/api/conversations', s, { agentId: agente('aspasia') })).json.id; }
const subir = (conv: string, data: Buffer, nome = 'audio-2026-11-17-1432.webm', tipo = 'audio/webm') =>
  req(h, 'POST', '/api/artifacts', s, data, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(nome), 'x-file-type': tipo, 'x-conversation-id': conv });
const enviar = (conv: string, art: string, text = '') => req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text, clientRequestId: `m-${crypto.randomUUID()}`, attachments: [art] });
/** espera a transcrição em segundo plano terminar (a ponte simulada responde no mesmo ciclo) */
async function assentar(art: string) {
  for (let i = 0; i < 50; i++) {
    const e = h.db.get<{ estado: string }>('SELECT estado FROM audio_transcricoes WHERE artifact_id = ?', art)?.estado;
    if (e === 'pronta' || e === 'falhou') return e;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  return 'andando';
}
const mensagens = async (conv: string) => (await req(h, 'GET', `/api/conversations/${conv}/messages`, s)).json as Array<{ role: string; attachments?: Array<{ id: string; transcricao?: { estado: string; texto: string | null; motivo: string | null; duracao: number | null } }> }>;

describe('duração do áudio lida dos bytes', () => {
  test('WebM (também como o gravador grava), Ogg/Opus, WAV, MP3 e M4A', () => {
    const perto = (v: number | null, alvo: number) => v !== null && Math.abs(v - alvo) < 0.1;
    assert.ok(perto(duracaoDoAudio(ler('nota-3s.webm')), 3), 'webm com duração no cabeçalho');
    assert.ok(perto(duracaoDoAudio(ler('nota-3s-ao-vivo.webm')), 3), 'webm ao vivo (sem duração no cabeçalho)');
    assert.ok(perto(duracaoDoAudio(ler('nota-3s.ogg')), 3));
    assert.ok(perto(duracaoDoAudio(ler('nota-2s.wav')), 2));
    assert.ok(perto(duracaoDoAudio(ler('nota-4s.mp3')), 4.07));
    assert.ok(perto(duracaoDoAudio(ler('nota-3s.m4a')), 3));
    assert.ok(perto(duracaoDoAudio(webmGravado(661)), 661), 'cluster de tamanho desconhecido: vale o último bloco');
    assert.equal(duracaoDoAudio(Buffer.from('não é áudio nenhum')), null);
  });
  test('teto: 10 minutos (com o respiro do último quadro) e 25 MB', () => {
    assert.equal(foraDoTeto(webmGravado(600)), null, '10:00 exatos passam');
    assert.deepEqual(foraDoTeto(webmGravado(661))?.motivo, 'longo');
    assert.deepEqual(foraDoTeto(Buffer.alloc(AUDIO_MAX_BYTES + 1))?.motivo, 'grande');
    assert.equal(foraDoTeto(ler('nota-3s.ogg')), null);
  });
});

describe('mensagem de áudio', () => {
  test('o áudio vira transcrição gravada e o texto vai ao agente junto do pedido', async () => {
    const conv = await conversa();
    const up = await subir(conv, ler('nota-3s-ao-vivo.webm'));
    assert.equal(up.status, 201, JSON.stringify(up.json));
    assert.equal(up.json.mime, 'audio/webm');
    assert.equal(await assentar(up.json.id), 'pronta', 'a transcrição começa ao subir, sem esperar a mensagem');
    const linha = h.db.get<{ texto: string; duracao_s: number }>('SELECT texto, duracao_s FROM audio_transcricoes WHERE artifact_id = ?', up.json.id)!;
    assert.equal(linha.texto, 'reunião às três com a Ana');
    assert.ok(Math.abs(linha.duracao_s - 3) < 0.1);
    assert.equal(ponte.chamadas.filter((c) => c.sub === 'voz/transcrever').length, 1);
    assert.equal(ponte.chamadas.find((c) => c.sub === 'voz/transcrever')!.body.segundo_plano, true, 'em segundo plano na ponte');
    assert.equal((await enviar(conv, up.json.id)).status, 201);
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.equal(motor.pedidos.length, 1);
    assert.match(motor.pedidos[0].input, /Áudio da pessoa \(transcrição\): reunião às três com a Ana/);
    assert.doesNotMatch(motor.pedidos[0].input, /não abre esse tipo/, 'o áudio não é mais "tipo que o sistema não abre"');
    const m = (await mensagens(conv)).find((x) => x.role === 'user')!;
    const tr = m.attachments![0].transcricao!;
    assert.deepEqual([tr.estado, tr.texto, tr.motivo], ['pronta', 'reunião às três com a Ana', null]);
    assert.ok(Math.abs(Number(tr.duracao) - 3) < 0.1, 'a duração vai junto');
    // o player toca o arquivo pela rota de sempre, como áudio, com pedaços (pular no tempo)
    const inteiro = await req(h, 'GET', `/api/artifacts/${up.json.id}/download?inline=1`, s);
    assert.equal(inteiro.status, 200);
    assert.equal(inteiro.res.headers['content-type'], 'audio/webm');
    assert.match(String(inteiro.res.headers['content-security-policy']), /media-src 'self'/);
    const pedaco = await req(h, 'GET', `/api/artifacts/${up.json.id}/download?inline=1`, s, undefined, { range: 'bytes=0-99' });
    assert.equal(pedaco.status, 206);
    assert.equal(pedaco.res.headers['content-range'], `bytes 0-99/${ler('nota-3s-ao-vivo.webm').length}`);
    assert.equal(pedaco.res.rawPayload.length, 100);
  });

  test('o pedido espera a transcrição ("transcrevendo…" e "preparando… primeira vez") e segue quando ela termina', async () => {
    ponte.st.segurar = true; ponte.st.preparar = true;
    const conv = await conversa();
    const up = await subir(conv, ler('nota-3s.ogg'), 'nota.ogg', 'audio/ogg');
    assert.equal((await enviar(conv, up.json.id, 'resume pra mim')).status, 201);
    for (let i = 0; i < 20 && !ponte.st.soltar; i++) await new Promise((ok) => setTimeout(ok, 10));
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.equal(motor.pedidos.length, 0, 'não vai ao motor sem a transcrição');
    assert.equal(h.db.get<{ error: string }>('SELECT error FROM runs WHERE conversation_id = ?', conv)!.error, TRANSCREVENDO_AUDIO);
    assert.equal((await mensagens(conv)).find((x) => x.role === 'user')!.attachments![0].transcricao!.estado, 'preparando', '1º uso: o modelo de fala está sendo baixado');
    ponte.st.soltar!();
    assert.equal(await assentar(up.json.id), 'pronta');
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.equal(motor.pedidos.length, 1);
    assert.match(motor.pedidos[0].input, /resume pra mim[\s\S]*Áudio da pessoa \(transcrição\): reunião às três/);
  });

  test('falha: o agente sabe que há um áudio não transcrito; "tentar de novo" refaz e grava', async () => {
    ponte.st.resposta = { ok: false, motivo: 'falhou', detalhe: 'RuntimeError' };
    const conv = await conversa();
    const up = await subir(conv, ler('nota-3s.webm'));
    assert.equal(await assentar(up.json.id), 'falhou');
    await enviar(conv, up.json.id);
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.equal(motor.pedidos.length, 1, 'a falha não segura o pedido');
    assert.match(motor.pedidos[0].input, /Há um áudio da pessoa que o sistema não conseguiu transcrever/);
    assert.match(motor.pedidos[0].input, /sem inventar o conteúdo/);
    const t = (await mensagens(conv)).find((x) => x.role === 'user')!.attachments![0].transcricao!;
    assert.deepEqual([t.estado, t.motivo], ['falhou', 'falhou']);
    // tentar de novo (o botão embaixo do áudio)
    ponte.st.resposta = { ok: true, texto: 'agora foi' };
    const r = await req(h, 'POST', '/api/recursos/voz/transcrever', s, { arquivo: up.json.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.texto, 'agora foi');
    assert.equal((await mensagens(conv)).find((x) => x.role === 'user')!.attachments![0].transcricao!.estado, 'pronta');
    assert.equal(h.db.get<{ n: number }>('SELECT tentativas AS n FROM audio_transcricoes WHERE artifact_id = ?', up.json.id)!.n, 2);
    // sem o transcritor no motor, a tela diz o que falta
    ponte.st.resposta = { ok: false, motivo: 'componente' };
    assert.equal((await req(h, 'POST', '/api/recursos/voz/transcrever', s, { arquivo: up.json.id })).status, 409);
  });

  test('silêncio: a transcrição vazia não vira conteúdo inventado', async () => {
    ponte.st.resposta = { ok: true, texto: '' };
    const conv = await conversa();
    const up = await subir(conv, ler('nota-3s.webm'));
    assert.equal(await assentar(up.json.id), 'pronta');
    await enviar(conv, up.json.id);
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.match(motor.pedidos[0].input, /não achou fala/);
  });

  test('teto de 10 minutos também no servidor (duração e tamanho); fora da conversa, o arquivo só fica guardado', async () => {
    const conv = await conversa();
    const longo = await subir(conv, webmGravado(661));
    assert.equal(longo.status, 400);
    assert.equal(longo.json.error, 'audio_longo');
    assert.equal((await subir(conv, webmGravado(598))).status, 201, 'abaixo de 10 minutos passa');
    const grande = await subir(conv, Buffer.alloc(AUDIO_MAX_BYTES + 10, 1), 'grande.mp3', 'audio/mpeg');
    assert.equal(grande.status, 400);
    assert.equal(grande.json.error, 'audio_grande');
    const emDocumentos = await req(h, 'POST', '/api/artifacts', s, webmGravado(661), { 'content-type': 'application/octet-stream', 'x-filename': 'palestra.webm', 'x-file-type': 'audio/webm' });
    assert.equal(emDocumentos.status, 201, 'em Documentos, um áudio longo fica guardado');
    // anexado depois a uma mensagem: a transcrição recusa pelo teto e o agente sabe por quê
    await enviar(conv, emDocumentos.json.id);
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.equal(await assentar(emDocumentos.json.id), 'falhou');
    for (let i = 0; i < 3; i++) await h.executor.tick();
    assert.match(motor.pedidos.at(-1)!.input, /não conseguiu transcrever \(passa de 10 minutos\)/);
  });

  test('Ouvir: a resposta da voz online por reserva (o Piper falhou) vem marcada', async () => {
    const conv = await conversa();
    const msg = 'msg_' + crypto.randomBytes(16).toString('hex');
    h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, created_at) VALUES (?, ?, ?, 'agent', ?, 'real', ?)", msg, s.workspaceId, conv, 'Bom dia', new Date().toISOString());
    let r = await req(h, 'POST', '/api/recursos/voz/falar', s, { mensagem: msg });
    assert.equal(r.status, 200);
    assert.equal(r.res.headers['x-ergon-voz'], undefined);
    ponte.st.falar = { ...ponte.st.falar, reserva: true, provedor: 'edge' };
    r = await req(h, 'POST', '/api/recursos/voz/falar', s, { mensagem: msg });
    assert.equal(r.res.headers['x-ergon-voz'], 'reserva');
    const e = await req(h, 'GET', '/api/recursos', s);
    assert.deepEqual(e.json.voz, { transcrever: 'local', falar: 'piper', preparar: { transcrever: false, falar: false }, modelo: 'base' });
  });
});

describe('a ponte em segundo plano', () => {
  test('a transcrição longa sai pela consulta da tarefa; a ponte de antes responde direto', async () => {
    const chamadas: string[] = [];
    let voltas = 0;
    const control = { recursos: async (method: string, sub: string) => {
      chamadas.push(`${method} ${sub}`);
      if (method === 'POST') return { status: 200, json: { ok: true, tarefa: 'ab'.repeat(16) } };
      return { status: 200, json: ++voltas < 3 ? { andando: true } : { ok: true, texto: 'pronto' } };
    } } as unknown as HermesControlClient;
    const r = new Recursos({ db: h.db, bus: h.bus, control: () => control, scope: () => '_' });
    assert.deepEqual(await r.transcrever(s.workspaceId, Buffer.from('x'), 'a.webm', { intervaloMs: 1 }), { ok: true, texto: 'pronto' });
    assert.deepEqual(chamadas, ['POST voz/transcrever', 'GET voz/transcrever', 'GET voz/transcrever', 'GET voz/transcrever']);
    const antiga = { recursos: async () => ({ status: 200, json: { ok: true, texto: 'direto' } }) } as unknown as HermesControlClient;
    assert.deepEqual(await new Recursos({ db: h.db, bus: h.bus, control: () => antiga, scope: () => '_' }).transcrever(s.workspaceId, Buffer.from('x'), 'a.webm'), { ok: true, texto: 'direto' });
  });
});
