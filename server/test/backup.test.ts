/**
 * Backup completo e restauração: o backup leva banco, keyring, arquivos e conexões; a
 * restauração confere tudo antes, guarda o que estava no lugar e dá para desfazer; o resultado abre e funciona.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { Vault } from '../src/security/keys.ts';
import { applyRestore, moveVaultAside, moveVaultBack, undoRestore, unfinishedRestore, verifyBackup, type DataPaths } from '../src/services/backup.ts';
import { SecretStore } from '../src/services/integrations.ts';
import { harness, loginAs, req, setupOwner, testConfig, tmpDir, type Harness, type Session } from './helpers.ts';

const PASSWORD = 'senha-local-123';
const pathsOf = (dir: string): DataPaths => testConfig(dir);
const titlesOf = (h: Harness) => h.db.all<{ title: string }>('SELECT title FROM tasks').map((t) => t.title);

/** Instalação com um pouco de tudo: tarefa, anexo, credencial de conexão e sessão do WhatsApp. */
async function populated(): Promise<{ h: Harness; s: Session; art: { id: string }; bytes: Buffer }> {
  const h = await harness();
  const s = await setupOwner(h);
  await req(h, 'POST', '/api/tasks', s, { title: 'Tarefa antes do backup' });
  const bytes = Buffer.from('mes;valor\njan;1500\nfev;1700\n', 'utf8');
  const art = (await req(h, 'POST', '/api/artifacts', s, bytes, { 'content-type': 'application/octet-stream', 'x-filename': 'vendas.csv', 'x-file-type': 'text/csv' })).json;
  const store = new SecretStore(h.cfg.dataDir, () => h.db.fieldCipher);
  store.write(s.workspaceId, 'todoist', { token: 'credencial-de-teste-0001' });
  const wa = store.dirFor(s.workspaceId, 'whatsapp');
  fs.writeFileSync(path.join(wa, 'creds.json'), h.db.fieldCipher!.sealBytes(s.workspaceId, Buffer.from('{"sessao":"teste"}'), 'whatsapp/creds.json'), { mode: 0o600 });
  return { h, s, art, bytes };
}

async function backup(h: Harness, s: Session): Promise<string> {
  const r = await req(h, 'POST', '/api/admin/backup', s);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return path.join(h.cfg.backupsDir, r.json.file);
}

/** Abre uma pasta restaurada como o servidor faria depois de digitar a senha daquele momento. */
async function openRestored(dir: string): Promise<{ h: Harness; s: Session }> {
  const v = new Vault(dir, KDF_TEST);
  assert.equal(v.state(), 'sealed');
  assert.ok(await v.unsealPassword('alexandre', PASSWORD), 'abre com a senha do backup');
  const h = await harness({}, { dir, vault: v });
  return { h, s: await loginAs(h, 'alexandre', PASSWORD) };
}

describe('backup completo', () => {
  test('leva banco, keyring, arquivos e conexões; não leva a chave do acesso sem trancamento; confere o que gravou', async () => {
    const { h, s } = await populated();
    const r = await req(h, 'POST', '/api/admin/backup', s);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.encrypted, true);
    assert.equal(r.json.missing, 0);
    assert.deepEqual([r.json.counts.artifacts, r.json.counts.files, r.json.counts.secrets], [1, 1, 2]);
    const dir = path.join(h.cfg.backupsDir, r.json.file);
    const v = verifyBackup(dir);
    assert.ok(v.ok, v.problems.join('; '));
    const paths = v.manifest!.entries.map((e) => e.path);
    assert.ok(paths.includes('db.sqlite') && paths.includes('keyring.json'));
    assert.ok(paths.some((p) => p.startsWith(`files/${s.workspaceId}/art_`)));
    assert.ok(paths.includes(`secrets/${s.workspaceId}-todoist.json`));
    assert.ok(paths.includes(`secrets/${s.workspaceId}-whatsapp/creds.json`));
    assert.ok(!paths.some((p) => p.includes('unlock')), 'a chave do sem trancamento é só desta máquina');
    assert.ok(fs.existsSync(path.join(h.dir, 'unlock.key')));
    // nada legível sem a senha: banco cifrado, credencial e anexo cifrados
    assert.ok(Db.isEncryptedFile(path.join(dir, 'db.sqlite')));
    for (const e of v.manifest!.entries) {
      const raw = fs.readFileSync(path.join(dir, ...e.path.split('/')));
      for (const plain of ['credencial-de-teste-0001', 'jan;1500', 'Tarefa antes do backup', '"sessao"']) assert.ok(!raw.includes(Buffer.from(plain)), `${e.path} sem "${plain}" em claro`);
    }
    // a auditoria registra o backup com as contagens, sem conteúdo
    const ev = h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'admin.backup' ORDER BY created_at DESC LIMIT 1");
    assert.match(String(ev?.evidence), /"files":1/);
    await h.close();
  });

  test('anexo que já faltava no disco é dito no backup, não escondido', async () => {
    const { h, s } = await populated();
    const k = h.db.get<{ storage_key: string }>('SELECT storage_key FROM artifacts LIMIT 1')!.storage_key;
    fs.rmSync(path.join(h.cfg.filesDir, s.workspaceId, k));
    const r = await req(h, 'POST', '/api/admin/backup', s);
    assert.equal(r.json.missing, 1);
    assert.deepEqual(verifyBackup(path.join(h.cfg.backupsDir, r.json.file)).manifest!.missing, [`${s.workspaceId}/${k}`]);
    await h.close();
  });
});

describe('restauração', () => {
  test('numa instalação nova: abre com a senha daquele momento, com tarefas, anexos e conexões', async () => {
    const { h, s, art, bytes } = await populated();
    const dir = await backup(h, s);
    await req(h, 'POST', '/api/tasks', s, { title: 'Tarefa depois do backup' });
    const target = tmpDir();
    const res = applyRestore(dir, pathsOf(target));
    assert.equal(res.keyring, 'nova');
    assert.deepEqual(res.items, ['db', 'files', 'secrets', 'keyring.json']);
    const r = await openRestored(target);
    const titles = titlesOf(r.h);
    assert.ok(titles.includes('Tarefa antes do backup'));
    assert.ok(!titles.includes('Tarefa depois do backup'));
    const dl = await req(r.h, 'GET', `/api/artifacts/${art.id}/download`, r.s);
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.res.rawPayload, bytes);
    const store = new SecretStore(r.h.cfg.dataDir, () => r.h.db.fieldCipher);
    assert.deepEqual(store.read(s.workspaceId, 'todoist'), { token: 'credencial-de-teste-0001' });
    const wa = fs.readFileSync(path.join(store.dirFor(s.workspaceId, 'whatsapp'), 'creds.json'));
    assert.equal(r.h.db.fieldCipher!.openBytes(wa, 'whatsapp/creds.json').toString(), '{"sessao":"teste"}');
    // e continua funcionando: grava, lê e faz o próprio backup
    assert.equal((await req(r.h, 'POST', '/api/tasks', r.s, { title: 'Depois de restaurar' })).status, 201);
    assert.equal((await req(r.h, 'POST', '/api/admin/backup', r.s)).json.verified, true);
    await r.h.close(); await h.close();
  });

  test('backup adulterado ou com caminho para fora é recusado antes de tocar em qualquer dado', async () => {
    const { h, s } = await populated();
    const dir = await backup(h, s);
    const target = tmpDir();
    fs.mkdirSync(path.join(target, 'db'), { recursive: true });
    fs.writeFileSync(path.join(target, 'db', 'ergon.sqlite'), 'dados atuais');
    const sec = fs.readdirSync(path.join(dir, 'secrets')).find((f) => f.endsWith('-todoist.json'))!;
    const f = path.join(dir, 'secrets', sec);
    const b = fs.readFileSync(f); b[b.length - 1] ^= 1; fs.writeFileSync(f, b);
    assert.match(verifyBackup(dir).problems.join(';'), /conteúdo diferente: secrets\//);
    assert.throws(() => applyRestore(dir, pathsOf(target)), /não confere \(nada foi alterado\)/);
    assert.equal(fs.readFileSync(path.join(target, 'db', 'ergon.sqlite'), 'utf8'), 'dados atuais');
    assert.deepEqual(fs.readdirSync(target).sort(), ['db']);
    // manifesto que aponta para fora da pasta de dados
    b[b.length - 1] ^= 1; fs.writeFileSync(f, b);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    m.entries.push({ path: 'files/../../fora.txt', bytes: 1, sha256: 'x' });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    assert.match(verifyBackup(dir).problems.join(';'), /caminho não permitido/);
    await h.close();
  });

  test('guarda o que estava no lugar e dá para desfazer', async () => {
    const a = await populated();
    const dir = await backup(a.h, a.s);
    // outra instalação, com dados próprios, recebe o backup
    const b = await harness(); const sb = await setupOwner(b);
    await req(b, 'POST', '/api/tasks', sb, { title: 'Tarefa da outra instalação' });
    await b.close();
    const res = applyRestore(dir, pathsOf(b.dir));
    assert.equal(res.keyring, 'outra', 'backup de outra instalação: o cofre do motor daqui é de outra chave');
    assert.ok(fs.existsSync(path.join(res.pre, 'db', 'ergon.sqlite')), 'o banco anterior fica guardado');
    assert.ok(fs.existsSync(path.join(res.pre, 'keyring.json')));
    assert.ok(fs.existsSync(path.join(res.pre, 'unlock.key')), 'cópia da chave do sem trancamento');
    assert.ok(fs.existsSync(path.join(b.dir, 'unlock.key')), 'a chave desta máquina fica onde está');
    // a chave desta máquina não abre o backup de outra: pede a senha daquele momento (e não quebra)
    assert.equal(new Vault(b.dir, KDF_TEST).unsealOpenAccess(), false);
    const r = await openRestored(b.dir);
    assert.ok(titlesOf(r.h).includes('Tarefa antes do backup'));
    await r.h.close();
    // desfazer: volta a instalação de antes
    const u = undoRestore(res.pre, pathsOf(b.dir));
    assert.deepEqual(u.items, ['db', 'keyring.json'], 'a outra instalação não tinha anexos nem conexões');
    for (const it of ['db', 'files', 'secrets', 'keyring.json']) assert.ok(fs.existsSync(path.join(u.aside, it)), `o restaurado fica guardado também (${it})`);
    assert.ok(!fs.existsSync(path.join(b.dir, 'files')) && !fs.existsSync(path.join(b.dir, 'secrets')));
    const v = new Vault(b.dir, KDF_TEST);
    assert.ok(v.unsealOpenAccess(), 'a chave desta máquina volta a abrir a instalação dela');
    const back = await harness({}, { dir: b.dir, vault: v });
    await loginAs(back, 'alexandre', PASSWORD);
    const titles = titlesOf(back);
    assert.ok(titles.includes('Tarefa da outra instalação') && !titles.includes('Tarefa antes do backup'));
    await back.close(); await a.h.close();
  });

  test('backup antigo (só o banco e o keyring) restaura sem mexer nos arquivos e conexões atuais', async () => {
    const { h, s } = await populated();
    const dir = await backup(h, s);
    const legacyDir = tmpDir();
    const legacy = path.join(legacyDir, 'ergon-2026-01-01T00-00-00-000Z.sqlite');
    fs.copyFileSync(path.join(dir, 'db.sqlite'), legacy);
    fs.copyFileSync(path.join(dir, 'keyring.json'), `${legacy}.keyring.json`);
    await h.close(); // restaurar é com o servidor parado (no Windows, nem dá para mover o banco aberto)
    const res = applyRestore(legacy, pathsOf(h.dir));
    assert.deepEqual(res.items, ['db', 'keyring.json']);
    assert.equal(res.keyring, 'mesma');
    assert.ok(fs.readdirSync(path.join(h.cfg.filesDir, s.workspaceId)).length === 1, 'anexos atuais intactos');
    assert.ok(fs.existsSync(path.join(h.dir, 'secrets', `${s.workspaceId}-todoist.json`)));
  });

  test('cofre do motor de outra chave: tudo é copiado e conferido antes de esvaziar', () => {
    const vault = tmpDir(); const dest = path.join(tmpDir(), 'motor');
    fs.writeFileSync(path.join(vault, 'gocryptfs.conf'), 'conf');
    fs.mkdirSync(path.join(vault, 'AbC'));
    fs.writeFileSync(path.join(vault, 'AbC', 'gocryptfs.diriv'), Buffer.alloc(16, 7));
    fs.writeFileSync(path.join(vault, 'AbC', 'XyZ'), Buffer.alloc(5000, 1));
    assert.equal(moveVaultAside(vault, dest), 3);
    assert.deepEqual(fs.readdirSync(vault), []);
    assert.equal(fs.readFileSync(path.join(dest, 'AbC', 'XyZ')).length, 5000);
    assert.throws(() => moveVaultAside(vault, dest), /já existe/);
    // desfazer: o cofre novo (do motor depois da restauração) vai para o lado e o antigo volta igual
    fs.writeFileSync(path.join(vault, 'gocryptfs.conf'), 'conf nova');
    const novo = path.join(tmpDir(), 'motor-novo');
    assert.equal(moveVaultBack(dest, vault, novo), 3);
    assert.equal(fs.readFileSync(path.join(vault, 'gocryptfs.conf'), 'utf8'), 'conf');
    assert.equal(fs.readFileSync(path.join(vault, 'AbC', 'XyZ')).length, 5000);
    assert.equal(fs.readFileSync(path.join(novo, 'gocryptfs.conf'), 'utf8'), 'conf nova');
  });
});

describe('interrupções no meio (processo morto, disco que some)', () => {
  test('backup interrompido deixa uma cópia ".parcial": o próximo backup a tira e sai inteiro', async () => {
    const { h, s } = await populated();
    const stale = path.join(h.cfg.backupsDir, 'ergon-2026-01-01T00-00-00-000Z.parcial');
    fs.mkdirSync(path.join(stale, 'files'), { recursive: true }); fs.writeFileSync(path.join(stale, 'db.sqlite'), 'meio banco');
    assert.equal(verifyBackup(stale).ok, false, 'uma cópia pela metade nunca passa na conferência');
    const dir = await backup(h, s);
    assert.ok(!fs.existsSync(stale));
    assert.ok(verifyBackup(dir).ok);
    await h.close();
  });

  test('restauração interrompida na cópia: os dados nem foram tocados e a próxima restauração limpa a sobra', async () => {
    const { h, s } = await populated();
    const dir = await backup(h, s);
    const target = tmpDir();
    const stale = path.join(target, '.restaurando-2026-01-01T00-00-00-000Z');
    fs.mkdirSync(path.join(stale, 'db'), { recursive: true }); fs.writeFileSync(path.join(stale, 'db', 'ergon.sqlite'), 'meia cópia');
    applyRestore(dir, pathsOf(target));
    assert.ok(!fs.existsSync(stale));
    assert.equal(unfinishedRestore(pathsOf(target).backupsDir), null);
    const r = await openRestored(target);
    assert.ok(titlesOf(r.h).includes('Tarefa antes do backup'));
    await r.h.close(); await h.close();
  });

  test('a troca para no meio em CADA ponto possível: o servidor não sobe e "desfazer" volta à instalação de antes', async () => {
    const a = await populated();
    const dir = await backup(a.h, a.s);
    await a.h.close();
    // instalação de destino, com dados e chave próprios
    const b = await harness(); const sb = await setupOwner(b);
    await req(b, 'POST', '/api/tasks', sb, { title: 'Tarefa da instalação de destino' });
    assert.equal((await req(b, 'POST', '/api/artifacts', sb, Buffer.from('anexo do destino'), { 'content-type': 'application/octet-stream', 'x-filename': 'd.txt', 'x-file-type': 'text/plain' })).status, 201);
    await b.close();
    const original = tmpDir(); fs.cpSync(b.dir, original, { recursive: true });
    let points = 0;
    for (let k = 1; k <= 12; k++) {
      const target = tmpDir(); fs.rmSync(target, { recursive: true }); fs.cpSync(original, target, { recursive: true });
      // a partir da k-ésima renomeação o disco "some": nada mais se move (nem a volta automática)
      let n = 0; const real = fs.renameSync;
      const m = mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => { if (++n >= k) throw Object.assign(new Error('disco indisponível'), { code: 'EIO' }); return real(from, to); });
      let threw: Error | null = null;
      try { applyRestore(dir, pathsOf(target), `2026-01-01T00-00-00-${String(k).padStart(3, '0')}Z`); } catch (e) { threw = e as Error; } finally { m.mock.restore(); }
      if (!threw) break; // passou de todas as renomeações: a troca completa já é coberta acima
      points++;
      const pre = unfinishedRestore(pathsOf(target).backupsDir);
      if (pre) {
        assert.match(threw.message, /não deu para voltar tudo.*desfazer-restauracao/);
        undoRestore(path.join(pathsOf(target).backupsDir, pre), pathsOf(target));
        assert.equal(unfinishedRestore(pathsOf(target).backupsDir), null, 'desfeita, o servidor pode subir');
      } else {
        assert.match(threw.message, /voltaram ao lugar|não confere/);
      }
      // de um jeito ou de outro: a instalação de destino está inteira e abre com a chave dela
      const v = new Vault(target, KDF_TEST);
      assert.ok(v.unsealOpenAccess(), `k=${k}: abre com a chave desta instalação`);
      const db = new Db(path.join(target, 'db', 'ergon.sqlite'), { key: v.dbKey() }); db.setCipher(v.personKeySource(() => null));
      const titles = db.all<{ title: string }>('SELECT title FROM tasks').map((t) => t.title);
      db.close();
      assert.ok(titles.includes('Tarefa da instalação de destino') && !titles.includes('Tarefa antes do backup'), `k=${k}: dados do destino`);
    }
    assert.ok(points >= 7, `pontos de parada testados: ${points}`); // 4 itens saem, 4 entram: 8 renomeações
  });
});
