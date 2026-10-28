#!/usr/bin/env node
// Gera segredos locais FORA do OneDrive e do Git (padrão: ~/.ergon/secrets) e grava em .env
// apenas o caminho (ERGON_SECRETS_DIR). Nunca imprime valores. Não sobrescreve arquivos existentes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer].filter(Boolean).map((p) => path.resolve(p).toLowerCase());
const inOneDrive = (p) => oneDriveRoots.some((r) => path.resolve(p).toLowerCase().startsWith(r + path.sep)) || /[\\/]onedrive( - [^\\/]+)?[\\/]/i.test(path.resolve(p));
const dir = path.resolve(process.env.ERGON_SECRETS_DIR || path.join(os.homedir(), '.ergon', 'secrets'));
if (inOneDrive(dir)) {
  console.error(`Recusado: ${dir} parece estar no OneDrive. Defina ERGON_SECRETS_DIR fora de pastas sincronizadas.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const tok = (n = 32) => crypto.randomBytes(n).toString('base64url');

const ergonFile = path.join(dir, 'ergon.env');
const hermesFile = path.join(dir, 'hermes.env');
if (fs.existsSync(ergonFile) || fs.existsSync(hermesFile)) {
  console.log(`Segredos já existem em ${dir} (não alterados).`);
} else {
  const apiKey = tok();
  const bridge = tok();
  fs.writeFileSync(ergonFile, [
    '# Ergon — segredos locais (não versionar, não sincronizar)',
    `ERGON_HERMES_API_KEY=${apiKey}`,
    `ERGON_BRIDGE_TOKEN=${bridge}`,
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(hermesFile, [
    '# Hermes (contêiner do Ergon) — segredos locais (não versionar, não sincronizar)',
    `API_SERVER_KEY=${apiKey}`,
    `ERGON_BRIDGE_TOKEN=${bridge}`,
    `HERMES_DASHBOARD_SESSION_TOKEN=${tok()}`,
    '# Provedor de modelo: preencha SOMENTE com chave própria deste ambiente. Ex.:',
    '# OPENROUTER_API_KEY=',
    '# ANTHROPIC_API_KEY=',
    '# Teams (bot) — veja connectors/teams/CHECKLIST.md',
    '# TEAMS_CLIENT_ID=',
    '# TEAMS_CLIENT_SECRET=',
    '# TEAMS_TENANT_ID=',
    '# TEAMS_ALLOWED_USERS=',
    '# WhatsApp (Baileys, experimental) — veja connectors/whatsapp/CHECKLIST.md',
    '# WHATSAPP_ENABLED=false',
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`Segredos gerados em ${dir} (ergon.env, hermes.env).`);
}

// Instalações anteriores: acrescenta só o que faltar (sem mexer no resto, sem exibir valores).
// Token do painel interno do Hermes (127.0.0.1 no contêiner; o Ergon chega a ele pela ponte de controle).
if (fs.existsSync(hermesFile) && !/^HERMES_DASHBOARD_SESSION_TOKEN=/m.test(fs.readFileSync(hermesFile, 'utf8'))) {
  const cur = fs.readFileSync(hermesFile, 'utf8');
  fs.writeFileSync(hermesFile, `${cur}${cur.endsWith('\n') ? '' : '\n'}HERMES_DASHBOARD_SESSION_TOKEN=${tok()}\n`, { mode: 0o600 });
  console.log('hermes.env: token do painel interno acrescentado (valor não exibido).');
}

const envFile = path.join(root, '.env');
const line = `ERGON_SECRETS_DIR=${dir.split(path.sep).join('/')}`;
const cur = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
if (!/^ERGON_SECRETS_DIR=/m.test(cur)) {
  fs.writeFileSync(envFile, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n');
  console.log(`.env atualizado com ERGON_SECRETS_DIR (apenas o caminho).`);
}
