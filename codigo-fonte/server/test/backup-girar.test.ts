import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUPS_MANTER, girarBackups } from '../src/services/backup.ts';

test('backups: ficam os 7 mais recentes, o recém-feito sempre, e o resto da pasta não é tocado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergon-girar-'));
  try {
    assert.equal(BACKUPS_MANTER, 7);
    for (let d = 1; d <= 9; d++) fs.mkdirSync(path.join(dir, `ergon-2026-11-0${d}T10-00-00-000Z`));
    fs.writeFileSync(path.join(dir, 'ergon-2026-10-01T10-00-00-000Z.sqlite'), '');
    fs.writeFileSync(path.join(dir, 'ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json'), '');
    fs.mkdirSync(path.join(dir, 'pre-restore-2026-01-01T00-00-00-000Z'));
    fs.mkdirSync(path.join(dir, 'ergon-2026-11-05T10-00-00-000Z.parcial'));
    fs.writeFileSync(path.join(dir, 'minhas-notas.txt'), '');
    const feito = 'ergon-2026-01-01T00-00-00-000Z'; // relógio atrasado
    fs.mkdirSync(path.join(dir, feito));
    const sairam = girarBackups(dir, feito, 7);
    const ficou = fs.readdirSync(dir).sort();
    assert.ok(ficou.includes(feito), 'o recém-feito fica');
    assert.deepEqual(ficou.filter((n) => /^ergon-2026-11-0\dT[\d-]+Z$/.test(n)), ['04', '05', '06', '07', '08', '09'].map((d) => `ergon-2026-11-${d}T10-00-00-000Z`));
    assert.ok(!ficou.includes('ergon-2026-10-01T10-00-00-000Z.sqlite') && !ficou.includes('ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json'), 'o antigo sai com o keyring');
    for (const n of ['pre-restore-2026-01-01T00-00-00-000Z', 'ergon-2026-11-05T10-00-00-000Z.parcial', 'minhas-notas.txt']) assert.ok(ficou.includes(n), `fica: ${n}`);
    assert.equal(sairam.length, 4);
    assert.deepEqual(girarBackups(dir, undefined, 0), [], 'zero = não gira');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
