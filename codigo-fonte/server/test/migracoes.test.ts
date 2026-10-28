/**
 * Migração a partir de bancos de versões antigas: o banco é criado parado numa
 * migração antiga, recebe os dados que existiam naquela época, e o Ergon atual o abre — aplica o resto, mantém os
 * dados, o banco fica íntegro e o usuário antigo entra e vê a tarefa.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Db } from '../src/db/db.ts';
import { KDF_TEST } from '../src/security/crypto.ts';
import { hashPassword } from '../src/security/password.ts';
import { harness, loginAs, req, tmpDir } from './helpers.ts';

const MIGRATIONS = fs.readdirSync(path.join(import.meta.dirname, '..', 'src', 'db', 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const PASSWORD = 'senha-de-uma-versao-antiga';
const hex = () => crypto.randomBytes(16).toString('hex');
// pontos de parada: a primeira, algumas do meio e a penúltima
const STOPS = [...new Set([0, 4, 9, 13, MIGRATIONS.length - 2].map((i) => MIGRATIONS[Math.max(0, Math.min(i, MIGRATIONS.length - 1))]))];

describe('migração a partir de bancos antigos', () => {
  for (const until of STOPS) {
    test(`banco parado em ${until}: o Ergon atual abre, migra o resto e os dados ficam`, async () => {
      const dir = tmpDir();
      const old = new Db(path.join(dir, 'db', 'ergon.sqlite'));
      old.migrate({ until });
      assert.equal(old.all('SELECT name FROM schema_migrations').length, MIGRATIONS.indexOf(until) + 1);
      // dados que existem desde a primeira versão (as colunas daquela época)
      const now = new Date().toISOString();
      const ws = `ws_${hex()}`; const user = `usr_${hex()}`; const board = `brd_${hex()}`; const col = `col_${hex()}`; const task = `tsk_${hex()}`;
      old.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws, 'Empresa antiga', now);
      old.run('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', user, 'antigo', 'Usuário Antigo', await hashPassword(PASSWORD, KDF_TEST), now);
      old.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", ws, user, now);
      // banco que já tem quem administra (0022): a primeira conta administra, como a migração e o cadastro fazem
      if (old.all<{ name: string }>('PRAGMA table_info(users)').some((c) => c.name === 'is_admin')) old.run('UPDATE users SET is_admin = 1 WHERE id = ?', user);
      old.run("INSERT INTO boards (id, workspace_id, name, origin, created_at) VALUES (?, ?, 'Quadro antigo', 'native', ?)", board, ws, now);
      old.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, 0)', col, ws, board, 'A fazer');
      old.run("INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, origin, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 'Tarefa de uma versão antiga', 'manual', ?, ?)", task, ws, board, col, now, now);
      old.close();

      const h = await harness({}, { dir }); // abre como o servidor: aplica as migrações que faltam
      assert.equal(h.db.all('SELECT name FROM schema_migrations').length, MIGRATIONS.length, 'todas aplicadas');
      assert.equal(h.db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check, 'ok');
      assert.deepEqual(h.db.all('PRAGMA foreign_key_check'), [], 'nenhuma referência quebrada');
      const s = await loginAs(h, 'antigo', PASSWORD);
      // instalação de antes da proteção: o caminho real pede proteger primeiro (senha + frase); aí cifra no lugar
      assert.equal((await req(h, 'GET', `/api/tasks/${task}`, s)).status, 428);
      const p = await req(h, 'POST', '/api/security/protect', s, { password: PASSWORD });
      assert.equal(p.status, 200, JSON.stringify(p.json));
      assert.ok(Db.isEncryptedFile(h.cfg.dbPath), 'o banco antigo foi cifrado no lugar');
      const t = await req(h, 'GET', `/api/tasks/${task}`, s);
      assert.equal(t.status, 200, JSON.stringify(t.json));
      assert.equal(t.json.title ?? t.json.task?.title, 'Tarefa de uma versão antiga');
      await h.close();
    });
  }

  test('quadro da equipe de cinco colunas vira três; os cards mudam de coluna e o quadro do usuário fica igual', () => {
    const dir = tmpDir();
    const db = new Db(path.join(dir, 'db', 'ergon.sqlite'));
    db.migrate({ until: '0018_routine_proposals.sql' });
    const now = new Date().toISOString();
    const ws = `ws_${hex()}`;
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ws, 'Empresa', now);
    const board = (audience: string, names: string[]) => {
      const b = `brd_${hex()}`;
      db.run("INSERT INTO boards (id, workspace_id, name, origin, audience, created_at) VALUES (?, ?, 'Quadro', 'native', ?, ?)", b, ws, audience, now);
      const cols = Object.fromEntries(names.map((n, i) => {
        const c = `col_${hex()}`;
        db.run('INSERT INTO columns (id, workspace_id, board_id, name, position) VALUES (?, ?, ?, ?, ?)', c, ws, b, n, i);
        return [n, c];
      }));
      return { b, cols };
    };
    const team = board('team', ['Entrada', 'A fazer', 'Em andamento', 'Revisão', 'Feito']);
    const mine = board('user', ['A fazer', 'Fazendo', 'Feito']);
    let n = 0;
    const task = (where: { b: string; cols: Record<string, string> }, col: string) => {
      const t = `tsk_${hex()}`;
      db.run("INSERT INTO tasks (id, number, workspace_id, board_id, column_id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
        t, ++n, ws, where.b, where.cols[col], `em ${col}`, now, now);
      return t;
    };
    const moved = { Entrada: task(team, 'Entrada'), Revisão: task(team, 'Revisão'), Feito: task(team, 'Feito'), Andamento: task(team, 'Em andamento') };
    const own = task(mine, 'Feito');
    db.migrate();
    const colOf = (t: string) => db.get<{ name: string }>('SELECT c.name FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.id = ?', t)!.name;
    assert.deepEqual(db.all<{ name: string }>('SELECT name FROM columns WHERE board_id = ? ORDER BY position', team.b).map((c) => c.name), ['A fazer', 'Em andamento', 'Concluído']);
    assert.equal(colOf(moved.Entrada), 'A fazer');
    assert.equal(colOf(moved.Revisão), 'Em andamento');
    assert.equal(colOf(moved.Feito), 'Concluído');
    assert.equal(colOf(moved.Andamento), 'Em andamento');
    assert.deepEqual(db.all<{ name: string }>('SELECT name FROM columns WHERE board_id = ? ORDER BY position', mine.b).map((c) => c.name), ['A fazer', 'Fazendo', 'Feito']);
    assert.equal(colOf(own), 'Feito');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    db.close();
  });

  test('aplicar de novo não muda nada (cada migração roda uma vez só)', async () => {
    const dir = tmpDir();
    const db = new Db(path.join(dir, 'db', 'ergon.sqlite'));
    assert.equal(db.migrate().length, MIGRATIONS.length);
    assert.deepEqual(db.migrate(), []);
    db.close();
  });
});
