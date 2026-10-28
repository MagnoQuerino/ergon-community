// Conferência e restauração de backups (services/backup.ts). Roda num contêiner de uso único com o mesmo volume
// de dados e com o servidor do Ergon PARADO — o lançador cuida disso: .\ergon.cmd restaurar <pasta do backup>.
// Nunca apaga: o que estava no lugar vai para /data/backups/pre-restore-<data>, e "desfazer" traz de volta.
//   node server/src/restore-cli.ts preparar                         cria /data/backups (a entrada é copiada para lá)
//   node server/src/restore-cli.ts conferir  <pasta|arquivo.sqlite>
//   node server/src/restore-cli.ts restaurar <pasta|arquivo.sqlite> [carimbo]
//   node server/src/restore-cli.ts desfazer  <pasta pre-restore-…>
//   node server/src/restore-cli.ts motor     <cofre do motor> <destino>   (como root: os arquivos são do motor)
//   node server/src/restore-cli.ts motor-volta <cofre> <guardado> <guardar-o-atual-em>   (desfazer; como root)
// Saída: uma linha JSON (o lançador lê); código 1 em qualquer recusa.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { applyRestore, keyRelation, moveVaultAside, moveVaultBack, undoRestore, verifyBackup } from './services/backup.ts';

const cfg = loadConfig();
const [cmd, a, b] = process.argv.slice(2);
const out = (o: unknown) => console.log(JSON.stringify(o));
const fail = (m: string): never => { out({ ok: false, error: m }); process.exit(1); };
const source = (x: string | undefined): string => {
  if (!x) fail('falta o caminho do backup');
  const p = path.resolve(x!);
  const dir = path.basename(p) === 'manifest.json' ? path.dirname(p) : p;
  if (!fs.existsSync(dir)) fail(`não achei ${dir}`);
  return dir;
};

try {
  if (cmd === 'preparar') {
    // instalação que nunca fez backup: a pasta ainda não existe e o "docker cp" da entrada precisa dela
    fs.mkdirSync(cfg.backupsDir, { recursive: true, mode: 0o700 });
    out({ ok: true });
  } else if (cmd === 'conferir') {
    const src = source(a);
    if (fs.statSync(src).isFile()) {
      const kr = `${src}.keyring.json`;
      let check: string | null = null;
      try { check = (JSON.parse(fs.readFileSync(kr, 'utf8')) as { check?: string }).check ?? null; } catch { /* backup sem proteção */ }
      out({ ok: true, legacy: true, keyring: keyRelation(cfg, check), note: 'backup antigo: só o banco (e o keyring); arquivos e conexões atuais ficam como estão' });
    } else {
      const v = verifyBackup(src);
      const m = v.manifest;
      out({ ok: v.ok, problems: v.problems.slice(0, 20), createdAt: m?.createdAt ?? null, version: m?.version ?? null, encrypted: m?.encrypted ?? null,
        counts: m?.counts ?? null, missing: m?.missing.length ?? 0, keyring: m ? keyRelation(cfg, m.keyringCheck) : null });
      if (!v.ok) process.exit(1);
    }
  } else if (cmd === 'restaurar') {
    out({ ok: true, ...applyRestore(source(a), cfg, b && /^[\w-]{6,40}$/.test(b) ? b : undefined) });
  } else if (cmd === 'desfazer') {
    out({ ok: true, ...undoRestore(source(a), cfg) });
  } else if (cmd === 'motor') {
    if (!a || !b) fail('uso: motor <cofre> <destino>');
    out({ ok: true, moved: moveVaultAside(path.resolve(a!), path.resolve(b!)) });
  } else if (cmd === 'motor-volta') {
    const c = process.argv[5];
    if (!a || !b || !c) fail('uso: motor-volta <cofre> <guardado> <guardar-o-atual-em>');
    out({ ok: true, restored: moveVaultBack(path.resolve(b!), path.resolve(a!), path.resolve(c!)) });
  } else {
    fail('comandos: preparar, conferir, restaurar, desfazer, motor, motor-volta');
  }
} catch (e) {
  fail((e as Error).message);
}
