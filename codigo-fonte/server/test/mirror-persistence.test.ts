import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { drain, harness, loginAs, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

describe('espelho de quadro (fixture em formato inspirado no Planner)', () => {
  let h: Harness;
  let s: Session;
  const imp = (variant: string) => req(h, 'POST', '/api/mirror/import', s, { variant, boards: ['plan-fixture-1'] });
  const mirrored = () => h.db.all<{ id: string; title: string; completed: number; completed_by: string | null; column: string; ext: string; sync_state: string; conflict: string | null; extra: string }>(
    `SELECT t.id, t.title, t.completed, t.completed_by, c.name AS column, l.external_id AS ext, l.sync_state, l.conflict, l.external_extra AS extra
       FROM tasks t JOIN task_links l ON l.task_id = t.id JOIN columns c ON c.id = t.column_id ORDER BY l.external_id`);
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('prévia mostra alcance antes de importar', async () => {
    const p = (await req(h, 'GET', '/api/mirror/preview?variant=planner-like-v1', s)).json;
    assert.equal(p.fixture, true);
    assert.equal(p.boards.length, 2);
    assert.equal(p.supports.writeBack, false);
  });

  test('importar duas vezes não duplica', async () => {
    const r1 = (await imp('planner-like-v1')).json;
    assert.equal(r1.boards[0].created, 4);
    const r2 = (await imp('planner-like-v1')).json;
    assert.equal(r2.boards[0].created, 0);
    assert.equal(r2.boards[0].unchanged, 4);
    assert.equal(mirrored().length, 4);
    assert.equal(h.db.all("SELECT id FROM boards WHERE origin = 'mirror'").length, 1);
  });

  test('quadro espelhado é somente leitura para título/coluna nesta etapa', async () => {
    const t = mirrored()[0];
    assert.equal((await req(h, 'PATCH', `/api/tasks/${t.id}`, s, { title: 'editado localmente' })).status, 409);
  });

  test('mudanças externas: renomear, mover, concluir, ausente, novo; conclusão humana e campos extras preservados', async () => {
    const t1 = mirrored().find((t) => t.ext === 'ptask-1')!;
    await req(h, 'PATCH', `/api/tasks/${t1.id}`, s, { completed: true }); // pessoa conclui no Ergon
    const r = (await imp('planner-like-v2')).json.boards[0];
    assert.equal(r.created, 1);
    assert.equal(r.missing, 1);
    assert.equal(r.conflicts, 1);
    const m = Object.fromEntries(mirrored().map((t) => [t.ext, t]));
    assert.equal(m['ptask-1'].title, 'Definir escopo e prazos');
    assert.equal(m['ptask-1'].completed, 1, 'conclusão humana não revertida');
    assert.equal(m['ptask-1'].completed_by, 'human');
    assert.match(m['ptask-1'].conflict!, /conclusão humana preservada/);
    assert.equal(JSON.parse(m['ptask-1'].extra).priority, 1, 'campos não suportados preservados');
    assert.equal(m['ptask-2'].completed, 1);
    assert.equal(m['ptask-2'].completed_by, 'external');
    assert.equal(m['ptask-2'].column, 'Concluído');
    assert.equal(m['ptask-3'].sync_state, 'missing', 'ausência não é exclusão');
    assert.ok(m['ptask-5']);
    const cols = h.db.all<{ name: string }>("SELECT c.name FROM columns c JOIN boards b ON b.id = c.board_id WHERE b.origin = 'mirror' ORDER BY position");
    assert.deepEqual(cols.map((c) => c.name), ['A fazer', 'Em andamento', 'Concluído']);
    // reimportar v2: idempotente
    const again = (await imp('planner-like-v2')).json.boards[0];
    assert.equal(again.created + again.updated, 0);
  });

  test('perda de permissão marca erro e não esvazia nem exclui', async () => {
    const before = mirrored().length;
    const r = (await imp('planner-like-erro')).json.boards[0];
    assert.equal(r.state, 'error');
    assert.equal(mirrored().length, before);
    const b = h.db.get<{ sync_state: string; last_error: string }>("SELECT sync_state, last_error FROM boards WHERE origin = 'mirror'")!;
    assert.equal(b.sync_state, 'error');
    assert.match(b.last_error, /forbidden/);
  });

  test('log interno do espelho registra ações e não é exportado', async () => {
    const t1 = mirrored().find((t) => t.ext === 'ptask-1')!;
    const log = (await req(h, 'GET', `/api/tasks/${t1.id}`, s)).json.log as Array<{ action: string }>;
    assert.ok(log.some((e) => e.action === 'mirror.task.import'));
    assert.ok(log.some((e) => e.action === 'mirror.task.update'));
  });
});

describe('persistência após reinício e backup', () => {
  test('reinício conserva chat, cards, andares e log', async () => {
    const dir = tmpDir();
    const h1 = await harness({}, { dir });
    const s1 = await setupOwner(h1);
    await req(h1, 'POST', '/api/floors', s1);
    const task = (await req(h1, 'POST', '/api/tasks', s1, { title: 'Sobrevive ao reinício' })).json;
    await req(h1, 'PATCH', `/api/tasks/${task.id}`, s1, { completed: true });
    const st = (await req(h1, 'GET', '/api/state', s1)).json;
    const conv = (await req(h1, 'POST', '/api/conversations', s1, { agentId: st.agents[0].id })).json;
    await req(h1, 'POST', `/api/conversations/${conv.id}/messages`, s1, { text: 'mensagem persistente', clientRequestId: 'req-persist-01' });
    await drain(h1, 3);
    await h1.close();

    const h2 = await harness({}, { dir });
    // sessão também persiste (cookie continua válido)
    const me = await req(h2, 'GET', '/api/me', s1);
    assert.equal(me.status, 200);
    const s2 = await loginAs(h2, 'alexandre', 'senha-local-123');
    const t = (await req(h2, 'GET', `/api/tasks/${task.id}`, s2)).json;
    assert.equal(t.task.title, 'Sobrevive ao reinício');
    assert.equal(t.task.completed, 1);
    assert.ok(t.log.length >= 2);
    assert.equal((await req(h2, 'GET', '/api/capacity', s2)).json.slots, 18);
    const msgs = (await req(h2, 'GET', `/api/conversations/${conv.id}/messages`, s2)).json as Array<{ content: string; role: string }>;
    assert.ok(msgs.some((m) => m.content === 'mensagem persistente'));
    assert.ok(msgs.some((m) => m.role === 'agent'));
    await h2.close();
  });

  test('backup consistente (VACUUM INTO) restaura em banco novo', async () => {
    const h = await harness();
    const s = await setupOwner(h);
    await req(h, 'POST', '/api/tasks', s, { title: 'Antes do backup' });
    const b = (await req(h, 'POST', '/api/admin/backup', s)).json;
    assert.equal(b.ok, true);
    const file = path.join(h.cfg.backupsDir, b.file, 'db.sqlite');
    assert.ok(fs.existsSync(file));
    // o keyring daquele momento vai junto (sem ele o backup cifrado não restaura)
    assert.equal(b.keyring, 'keyring.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.cfg.backupsDir, b.file, b.keyring), 'utf8')), JSON.parse(fs.readFileSync(path.join(h.cfg.dataDir, 'keyring.json'), 'utf8')));
    await req(h, 'POST', '/api/tasks', s, { title: 'Depois do backup' });
    // o backup sai cifrado: sem a chave não abre; com a chave (e as chaves de workspace) volta tudo
    assert.throws(() => new Db(file), /not a database/);
    assert.ok(!fs.readFileSync(file).includes(Buffer.from('Antes do backup')), 'nenhum texto em claro no arquivo');
    const restored = new Db(file, { key: h.vault.dbKey() });
    restored.setCipher(h.vault.personKeySource(() => null));
    const titles = restored.all<{ title: string }>('SELECT title FROM tasks').map((r) => r.title);
    assert.ok(titles.includes('Antes do backup'));
    assert.ok(!titles.includes('Depois do backup'));
    assert.equal(restored.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
    restored.close();
    await h.close();
  });
});

describe('arquivos', () => {
  let h: Harness;
  let s: Session;
  before(async () => { h = await harness({ maxUploadBytes: 2048 }); s = await setupOwner(h); });
  after(async () => { await h.close(); });
  const up = (data: Buffer, name: string, type: string) => req(h, 'POST', '/api/artifacts', s, data, {
    'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-file-type': type });

  test('envio e download com nome saneado e como anexo', async () => {
    const r = await up(Buffer.from('linha 1\nlinha 2'), '../../etc/passwd.txt', 'text/plain');
    assert.equal(r.status, 201);
    assert.ok(!r.json.filename.includes('/'));
    const d = await req(h, 'GET', `/api/artifacts/${r.json.id}/download`, s);
    assert.equal(d.status, 200);
    assert.equal(d.res.body, 'linha 1\nlinha 2');
    assert.match(String(d.res.headers['content-disposition']), /^attachment/);
    assert.equal(d.res.headers['content-type'], 'application/octet-stream');
  });

  test('qualquer tipo fica guardado, mas o que não é imagem comum ou PDF nunca abre na tela; acima do limite, recusado', async () => {
    // decisão (30/10): o que a pessoa joga fica guardado; o perigo está em abrir, não em guardar
    const r = await up(Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html');
    assert.equal(r.status, 201);
    for (const q of ['', '?inline=1']) {
      const d = await req(h, 'GET', `/api/artifacts/${r.json.id}/download${q}`, s);
      assert.equal(d.res.headers['content-type'], 'application/octet-stream', 'HTML nunca vai com o tipo dele');
      assert.match(String(d.res.headers['content-disposition']), /^attachment/, 'nem com prévia pedida');
    }
    assert.equal((await up(Buffer.alloc(4096, 1), 'grande.txt', 'text/plain')).status, 413);
  });

  test('ID inexistente ou malformado não vaza caminho', async () => {
    assert.equal((await req(h, 'GET', '/api/artifacts/art_00000000000000000000000000000000/download', s)).status, 404);
    assert.equal((await req(h, 'GET', '/api/artifacts/..%2F..%2Fdb/download', s)).status, 400);
  });
});
