import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { passes, textOf } from '../src/services/whatsapp.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Baileys falso: o mesmo formato de eventos do real, sem rede. */
function fakeBaileys() {
  const bus = new EventEmitter();
  const sock = {
    ev: { on: (n: string, f: (...a: unknown[]) => void) => bus.on(n, f), removeAllListeners: () => bus.removeAllListeners() },
    user: { id: '5511999990000:3@s.whatsapp.net', name: 'Meu WhatsApp' },
    end() {}, ws: { close() {} }, async logout() {}, async groupMetadata() { return { subject: 'Grupo do Projeto' }; },
  };
  const mod = {
    makeWASocket: () => sock, DisconnectReason: { loggedOut: 401 },
    // o Ergon grava a sessão cifrada com estas três peças do Baileys (mesmo formato do armazenamento padrão)
    BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v }, initAuthCreds: () => ({ me: null }), proto: { Message: { AppStateSyncKeyData: { fromObject: (x: unknown) => x } } },
  };
  return { bus, mod };
}
const msg = (chat: string, text: string, id: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'notify', messages: [{ key: { remoteJid: chat, id, fromMe: false, ...extra }, pushName: 'Cliente A', message: { conversation: text }, messageTimestamp: 1761300000 }] });

describe('WhatsApp por QR: somente leitura, com filtros', () => {
  let h: Harness; let s: Session; let fake: ReturnType<typeof fakeBaileys>;
  before(async () => {
    h = await harness();
    s = await setupOwner(h);
    fake = fakeBaileys();
    h.whatsapp.loader = async () => fake.mod;
    h.whatsapp.qrLoader = async () => ({ toDataURL: async () => 'data:image/png;base64,QR' });
  });
  after(async () => { await h.close(); });

  test('filtros e leitura de texto (funções puras)', () => {
    const f = { direct: true, groups: false, labels: [], exceptions: ['Banco'], cards: true };
    assert.equal(passes(f, { chatId: '55@s.whatsapp.net', isGroup: false, chatName: 'Cliente', labels: [] }), true);
    assert.equal(passes(f, { chatId: '1@g.us', isGroup: true, chatName: 'Grupo', labels: [] }), false, 'grupos desligados');
    assert.equal(passes(f, { chatId: '56@s.whatsapp.net', isGroup: false, chatName: 'Banco XP', labels: [] }), false, 'exceção pelo nome');
    assert.equal(passes({ ...f, labels: ['Clientes'] }, { chatId: '57@s.whatsapp.net', isGroup: false, chatName: 'X', labels: ['clientes'] }), true, 'etiqueta (Business)');
    assert.equal(passes({ ...f, labels: ['Clientes'] }, { chatId: '58@s.whatsapp.net', isGroup: false, chatName: 'Y', labels: [] }), false);
    assert.equal(textOf({ message: { extendedTextMessage: { text: 'oi' } } }), 'oi');
    assert.equal(textOf({ message: { audioMessage: {} } }), null);
  });

  test('QR → conectado; mensagens filtradas entram pelo caminho dos canais; nada é enviado', async () => {
    // experimental: sem o aceite das informações e dos riscos, não conecta
    const semAceite = await req(h, 'POST', '/api/integrations/whatsapp/start', s);
    assert.equal(semAceite.status, 409); assert.equal(semAceite.json.error, 'risks_not_accepted');
    const antes = (await req(h, 'GET', '/api/integrations/whatsapp', s)).json;
    assert.equal(antes.experimental, true); assert.equal(antes.riscosAceitos, false); assert.equal(antes.status, 'off', 'nada foi ligado sem o aceite');
    const st = await req(h, 'POST', '/api/integrations/whatsapp/start', s, { aceitoRiscos: true });
    assert.equal(st.status, 200);
    assert.equal((await req(h, 'GET', '/api/integrations/whatsapp', s)).json.riscosAceitos, true);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'integration.whatsapp.risks_accepted'"), 'aceite na auditoria');
    fake.bus.emit('connection.update', { qr: 'codigo-qr' }); await wait();
    const q = (await req(h, 'GET', '/api/integrations/whatsapp', s)).json;
    assert.equal(q.status, 'qr'); assert.match(q.qr, /^data:image\/png/);
    fake.bus.emit('connection.update', { connection: 'open' }); await wait();
    const list = (await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string; account: string; live: { status: string } }>;
    const wa = list.find((i) => i.kind === 'whatsapp')!;
    assert.equal(wa.state, 'connected'); assert.equal(wa.account, 'Meu WhatsApp'); assert.equal(wa.live.status, 'connected');

    fake.bus.emit('messages.upsert', msg('5511888880000@s.whatsapp.net', 'Preciso que alguém revise o contrato até sexta', 'WA1')); await wait();
    fake.bus.emit('messages.upsert', msg('120363000@g.us', 'Pessoal, precisamos revisar o cronograma', 'WA2', { participant: '5511777@s.whatsapp.net' })); await wait();
    fake.bus.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '5511888880000@s.whatsapp.net', id: 'WA3', fromMe: true }, message: { conversation: 'minha resposta' } }] }); await wait();
    const evs = (await req(h, 'GET', '/api/source-events', s)).json as Array<{ external_id: string; status: string; task_id: string | null }>;
    assert.deepEqual(evs.map((e) => e.external_id), ['WA1'], 'grupo (desligado) e mensagens minhas não entram');
    assert.ok(evs[0].task_id, 'pedido identificado vira card para a triagem da equipe');
    const out = (await req(h, 'GET', '/api/outbox', s)).json as unknown[];
    assert.equal(out.length, 0, 'nada vai para a saída');

    // filtros: ler grupos, mas com exceção
    await req(h, 'PUT', '/api/integrations/whatsapp/filters', s, { groups: true, exceptions: ['Grupo do Projeto'] });
    fake.bus.emit('messages.upsert', msg('120363000@g.us', 'Precisamos revisar o cronograma', 'WA4', { participant: '5511777@s.whatsapp.net' })); await wait();
    await req(h, 'PUT', '/api/integrations/whatsapp/filters', s, { exceptions: [] });
    fake.bus.emit('messages.upsert', msg('120363000@g.us', 'Precisamos revisar o cronograma', 'WA5', { participant: '5511777@s.whatsapp.net' })); await wait();
    const ids = ((await req(h, 'GET', '/api/source-events', s)).json as Array<{ external_id: string }>).map((e) => e.external_id);
    assert.ok(!ids.includes('WA4') && ids.includes('WA5'), 'exceção respeitada; sem exceção, grupo lido');
    assert.equal((await req(h, 'GET', '/api/integrations/whatsapp', s)).json.riscosAceitos, true, 'mudar os filtros não apaga o aceite');

    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/services/whatsapp.ts'), 'utf8');
    assert.ok(!/\.sendMessage\(|readMessages\(|sendPresenceUpdate\(/.test(src), 'o leitor não tem caminho de envio');
    assert.equal((await req(h, 'DELETE', '/api/integrations/whatsapp', s)).status, 200);
    assert.equal(((await req(h, 'GET', '/api/integrations', s)).json as Array<{ kind: string; state: string }>).find((i) => i.kind === 'whatsapp')!.state, 'off');
  });
});

describe('Todoist e Microsoft: conectado só depois de conferir; espelho só de leitura', () => {
  let h: Harness; let s: Session;
  const realFetch = globalThis.fetch;
  const TOKEN = 'tok_0123456789abcdefTODOIST';
  before(async () => {
    h = await harness({ msClientId: null });
    s = await setupOwner(h);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
      if (!url.startsWith('https://api.todoist.com/')) return realFetch(input, init);
      if (auth !== `Bearer ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
      if (url.endsWith('/user')) return json({ full_name: 'Alexandre' });
      if (url.includes('/projects/p1/collaborators')) return json({ results: [{ id: 'u1', name: 'Maria' }], next_cursor: null });
      if (url.endsWith('/projects')) return json({ results: [{ id: 'p1', name: 'Pessoal', updated_at: '2026-10-01' }], next_cursor: null });
      if (url.includes('/sections?project_id=p1')) return json({ results: [{ id: 's1', name: 'Hoje', section_order: 1 }], next_cursor: null });
      if (url.includes('/tasks?project_id=p1')) return json({ results: [
        { id: 't1', content: 'Comprar material', description: 'papel A4', checked: false, section_id: 's1', responsible_uid: 'u1', updated_at: 'v1' },
        { id: 't2', content: 'Ligar para o banco', description: '', checked: false, section_id: null, updated_at: 'v1' },
      ], next_cursor: null });
      return json({}, 404);
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = realFetch; await h.close(); });

  test('token recusado não conecta; token aceito conecta e não aparece em lugar nenhum', async () => {
    assert.equal((await req(h, 'POST', '/api/integrations/todoist/token', s, { token: 'tok_errado_0123456789' })).status, 400);
    const ok = await req(h, 'POST', '/api/integrations/todoist/token', s, { token: TOKEN });
    assert.equal(ok.status, 200); assert.equal(ok.json.account, 'Alexandre');
    const list = (await req(h, 'GET', '/api/integrations', s));
    assert.ok(!list.res.body.includes(TOKEN), 'o token não volta para o navegador');
    const dump = h.db.all('SELECT * FROM integrations').map((r) => JSON.stringify(r)).join('') + h.db.all('SELECT * FROM audit_events').map((r) => JSON.stringify(r)).join('');
    assert.ok(!dump.includes(TOKEN), 'nem para o banco ou o log');
  });

  test('escolher a lista espelha título, descrição, situação e responsável no SEU quadro', async () => {
    const lists = (await req(h, 'GET', '/api/integrations/todoist/lists', s)).json.lists;
    assert.deepEqual(lists.map((l: { externalId: string; name: string }) => [l.externalId, l.name]), [['p1', 'Pessoal']]);
    const m = await req(h, 'POST', '/api/boards/mirror', s, { kind: 'todoist', listId: 'p1' });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    const board = ((await req(h, 'GET', '/api/boards', s)).json as Array<{ id: string; audience: string; source: string }>).find((b) => b.id === m.json.boardId)!;
    assert.equal(board.audience, 'user'); assert.equal(board.source, 'todoist');
    const view = (await req(h, 'GET', `/api/boards/${board.id}`, s)).json;
    assert.deepEqual(view.columns.map((c: { name: string }) => c.name), ['Sem seção', 'Hoje']);
    const t1 = view.tasks.find((t: { title: string }) => t.title === 'Comprar material');
    assert.equal(t1.external_assignee, 'Maria'); assert.equal(t1.description, 'papel A4');
    assert.equal((await req(h, 'PATCH', `/api/tasks/${t1.id}`, s, { title: 'Outro' })).status, 409, 'título vem do aplicativo de origem');
    const again = await req(h, 'POST', `/api/boards/${board.id}/sync`, s);
    assert.equal(again.json.created, 0, 'sincronizar de novo não duplica');
  });

  test('Microsoft sem o app registrado: diz o que falta, sem fingir conexão', async () => {
    const r = await req(h, 'POST', '/api/integrations/microsoft/start', s);
    assert.equal(r.status, 409); assert.match(r.json.message, /ERGON_MS_CLIENT_ID/);
    const cb = await h.app.inject({ method: 'GET', url: '/api/integrations/microsoft/callback?state=falso&code=x' });
    assert.equal(cb.statusCode, 302); assert.match(String(cb.headers.location), /microsoft=erro/);
  });
});

describe('Microsoft com o app registrado: login PKCE', () => {
  test('o endereço de login leva o desafio PKCE e o retorno exige o state', async () => {
    const h = await harness({ msClientId: '11111111-2222-3333-4444-555555555555' });
    const s = await setupOwner(h);
    const r = await req(h, 'POST', '/api/integrations/microsoft/start', s);
    assert.equal(r.status, 200);
    const u = new URL(r.json.url);
    assert.equal(u.host, 'login.microsoftonline.com');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope') ?? '', /Tasks\.Read/);
    assert.match(u.searchParams.get('redirect_uri') ?? '', /\/api\/integrations\/microsoft\/callback$/);
    await h.close();
  });
});
