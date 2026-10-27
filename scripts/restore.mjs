#!/usr/bin/env node
// Restauração do Ergon: o caminho certo é o lançador (confere o backup inteiro antes, guarda o que estava no lugar
// em /data/backups/pre-restore-<data> e sobe de novo; dá para desfazer). Este script só chama o lançador.
//   node scripts/restore.mjs <pasta do backup | backup antigo .sqlite>
//   node scripts/restore.mjs --desfazer pre-restore-<data>
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (!args.length) { console.error('Uso: node scripts/restore.mjs <pasta do backup>  |  --desfazer pre-restore-<data>'); process.exit(2); }
const cmd = args[0] === '--desfazer' ? ['desfazer-restauracao', args[1] ?? ''] : ['restaurar', path.resolve(args[0])];
const r = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'ergon.ps1'), ...cmd], { stdio: 'inherit' })
  : spawnSync('bash', [path.join(root, 'ergon.sh'), ...cmd], { stdio: 'inherit' });
process.exit(r.status ?? 1);
