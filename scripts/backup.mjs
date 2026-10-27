#!/usr/bin/env node
// Backup completo do Ergon (banco, keyring, arquivos e conexões, conferido por SHA-256): gera a pasta dentro do
// volume e copia para fora do OneDrive. Com o Ergon protegido, tudo sai cifrado; restaurar pede a senha ou a frase
// de então (node scripts/restore.mjs <pasta>, ou o lançador: restaurar <pasta>).
//   node scripts/backup.mjs [--container <nome>] [--dest <pasta>]
// Padrões: serviço "ergon" do Compose e ~/.ergon/backups.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const cwd = path.resolve(import.meta.dirname, '..');
const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(Boolean).map((p) => path.resolve(p).toLowerCase());
const inOneDrive = (p) => oneDriveRoots.some((r) => path.resolve(p).toLowerCase().startsWith(r + path.sep)) || /[\\/]onedrive( - [^\\/]+)?[\\/]/i.test(path.resolve(p));
const container = arg('--container', null);
const dest = path.resolve(arg('--dest', path.join(os.homedir(), '.ergon', 'backups')));
if (inOneDrive(dest)) { console.error('Destino dentro do OneDrive recusado: banco não deve ser sincronizado.'); process.exit(1); }
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const run = (cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env }).trim();

const name = container
  ? run('docker', ['exec', container, 'node', 'server/src/backup-cli.ts'])
  : run('docker', ['compose', 'exec', '-T', 'ergon', 'node', 'server/src/backup-cli.ts']);
fs.mkdirSync(dest, { recursive: true });
const target = container ?? run('docker', ['compose', 'ps', '-q', 'ergon']);
run('docker', ['cp', `${target}:/data/backups/${name}`, path.join(dest, name)]);
if (!fs.existsSync(path.join(dest, name, 'manifest.json'))) { console.error(`A cópia para ${dest} falhou (o backup ficou em /data/backups/${name} no volume).`); process.exit(1); }
console.log(`Backup completo: ${path.join(dest, name)} (cópia também em /data/backups no volume)`);
