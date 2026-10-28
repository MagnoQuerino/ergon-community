import fs from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import { runGate } from './gate.ts';
import { Vault } from './security/keys.ts';
import { unfinishedRestore } from './services/backup.ts';

const cfg = loadConfig();
const halfway = unfinishedRestore(cfg.backupsDir);
if (halfway) {
  // sem o banco no lugar, subir criaria uma instalação vazia por cima dos dados guardados
  console.error(`Restauração interrompida no meio da troca (${halfway}). Nada foi apagado: rode "ergon desfazer-restauracao ${halfway}" (volta ao que era, juntando o que ficou pela metade); depois, se quiser, restaure de novo.`);
  process.exit(1);
}
const vault = new Vault(cfg.dataDir, cfg.kdf);

/** Abre o banco com a chave certa para o estado do cofre (e cifra no lugar um backup antigo restaurado em claro). */
function openDb(): Db {
  const exists = fs.existsSync(cfg.dbPath);
  if (vault.state() === 'open') {
    if (!exists || Db.isEncryptedFile(cfg.dbPath)) return new Db(cfg.dbPath, { key: vault.dbKey() });
    const plain = new Db(cfg.dbPath);
    plain.encryptInPlace(vault.dbKey());
    return plain;
  }
  if (exists && Db.isEncryptedFile(cfg.dbPath)) {
    throw new Error('Banco cifrado sem o keyring (keyring.json) no volume de dados: restaure o keyring do backup junto com o banco.');
  }
  return new Db(cfg.dbPath);
}

// Protegido e recém-iniciado: só a tela de destrancar até a senha (ou a frase, ou o cofre do sistema) chegar —
// a menos que o trancamento esteja desligado (chave ao lado dos dados): aí abre sozinho.
if (vault.state() === 'sealed' && cfg.mode === 'local') vault.unsealOpenAccess();
const db = vault.state() === 'sealed' ? await runGate(cfg, vault, openDb) : openDb();
const applied = db.migrate();
const { app, executor, startBackground, stopBackground } = await buildApp({ cfg, db, vault });

if (applied.length) app.log.info({ applied }, 'migrations aplicadas');
app.log.info({
  mode: cfg.mode, vault: vault.state(), executor: cfg.executor, maxConcurrentRuns: cfg.maxConcurrentRuns, teams: cfg.teams.enabled, whatsapp: cfg.whatsapp.enabled,
  control: cfg.hermesControlUrl ? 'definida' : 'ausente', motorVault: cfg.hermesVaultUrl ? 'definido' : 'ausente',
  microsoft: cfg.msClientId ? 'app registrado' : 'sem app', google: cfg.googleClientId && cfg.googleClientSecret ? 'app registrado' : 'sem app',
  whatsappSend: cfg.whatsapp.sendEnabled, fixtures: cfg.fixturesEnabled, hermesKey: cfg.hermesApiKey ? 'definida' : 'ausente',
  bridgeToken: cfg.bridgeToken ? 'definido' : 'ausente',
  agentToken: cfg.agentToken ? 'definido' : 'ausente',
}, 'configuração (sem segredos)');

executor.start();
await app.listen({ host: cfg.host, port: cfg.port });
startBackground(); // ferramentas da IA, espelhos de tarefas, fila da equipe, cofre do motor e sessões de WhatsApp já pareadas

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'encerrando');
  executor.stop();
  await stopBackground();
  // leases de execuções em andamento expiram e são retomados no próximo início
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
